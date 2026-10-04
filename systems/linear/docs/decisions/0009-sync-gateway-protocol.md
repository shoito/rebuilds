---
status: accepted
date: 2026-09-28
---

# ADR-0009: Sync Gateway のプロトコルは WebSocket の上の JSON のテキストフレーム。認証は最初のメッセージのチケット、握手の決定表で続き・取り戻し・やり直しを決め、取り戻しは Sync API の HTTP で行う

## Context

Sync Gateway は、クライアントの WebSocket を終端し、トランザクションを Writer へ渡し、差分を同期グループで絞って送る（[architecture/README.md](../architecture/README.md) の 1.2 節）。決めることは次のとおり。

- フレームの符号化（JSON か二値か）と圧縮。
- 認証の渡し方。
- 再接続のときに、手元の `last_sync_id` から、続けるか、取り戻すか、やり直すかを決める規則。
- 取り戻しの差分を、WebSocket で流すか、HTTP で取るか。
- 心拍、背圧、切断のコード。

本家の WebSocket のメッセージは、2022 年の観察で `{"cmd": "sync", "sync": [...], "lastSyncId": n}` の形とされる（[Reverse engineering Linear's sync magic](https://marknotfound.com/posts/reverse-engineering-linears-sync-magic/)、2026-09-28 に確認。第三者の解析。今の形は**未検証**）。Slack の題材は、Gateway の接続の寿命・心拍・再接続の殺到への備えを決めている（Slack の [realtime.md](../../../slack/docs/architecture/realtime.md)）。Figma の題材は、二値のフレームと、最初のメッセージでの能力のチケットを選んだ（Figma の ADR-0009）。

## Options

符号化：

1. **JSON のテキストフレーム（1 フレーム 1 メッセージ、`t` で種類）**
2. 二値（MessagePack など）

取り戻し：

- a. **Sync API の HTTP（NDJSON、圧縮）。Gateway は `live_from` からの生の差分だけを流す**
- b. Gateway が DB から読んで WebSocket で流す

## Decision

1 と a を採用する。詳細は [sync-engine.md](../architecture/sync-engine.md) の 9 節。

- メッセージはクライアントから `hello`・`submit`・`ping`、サーバーから `welcome`・`deltas`・`ack`・`retry`・`kick`・`pong`。1 フレームは 1 MiB まで。permessage-deflate は S1 では使わない。
  > 2026-09-28 の注記：当初は「permessage-deflate は S1 では使わない」としていた。差分の送信のデータ転送が月に約 230 TB と見積もられ、費用の最大の不確かさになった（[infrastructure.md](../architecture/infrastructure.md) の 11 節）。そこで、差分の流れ（サーバー → クライアント）に permessage-deflate を使うことにした。圧縮の文脈の持ち越し（context takeover）は使うが、窓を `server_max_window_bits=12`（4 KiB）に限り、圧縮のメモリーを 1 接続 約 16 KiB に抑える。クライアント → サーバーは `client_no_context_takeover`。1 KiB 未満のフレームは圧縮しない。Ops のフラグ `ops.ws_deflate` で、新しい接続の交渉を止められる。E12 の負荷試験で、圧縮の率、Gateway の CPU とメモリー、同じ `groups` の接続の間の直列化の使い回しの効き目を、`server_no_context_takeover`（圧縮した 1 つのフレームを使い回せる）と比べて測り、どちらにするかを確定する（[sync-engine.md](../architecture/sync-engine.md) の 9.1 節、[capacity.md](../architecture/capacity.md) の 3.2 節）。
- 認証は、Sync API が発行する 60 秒・1 回限りのチケット（Valkey には SHA-256 だけ）を `hello` に入れる。URL に入れない。`Origin` を確かめる。
- `hello` は `last_sync_id`・`sync_epoch`・`groups_hash`・`schema_hash`・`fv`・`build` を持つ。Gateway は次の順で決める：バージョンが互換の外なら `kick: upgrade_required`、`sync_epoch` が違えば `reset`、`last_sync_id > head` なら `reset`、`last_sync_id < floor` なら `reset`、`head − last_sync_id > 50,000` なら `reset`、`last_sync_id < head` なら `catch_up`、それ以外は `resume`。
- `welcome.live_from` 以後の差分は Gateway が流す。`catch_up` のクライアントは、`(L, live_from]` を Sync API の `GET /sync/deltas` で取り、その間の `deltas` は持っておく。
- トランザクションの形のバージョンが受け付けの外なら、`welcome.send = upgrade_required` にし、差分は流すが送信は受けない（[ADR-0005](0005-client-persistence-and-offline.md)）。
- 心拍はサーバーの WebSocket の ping フレーム（20 秒）で行う。クライアントの `ping` は画面が見えている間 30 秒ごと。送信の待ちが 4 MiB か 10 秒を超えたら `kick: resync_required`。再接続は、予期しない切断の後に 0〜5 秒の乱数、以後は full jitter の指数（上限 30 秒）。
- 2 を採らない理由：差分の中身はモデルの行（JSON の値）で、二値にしても大きさの差が小さい。開発者のツールで読めること、Sync API の NDJSON と同じ形を使えることを優先する。Figma は 1 秒に数十回の小さな変更を送るので二値を選んだが、課題管理の変更は少ない。
- b を採らない理由：長いオフラインの後の大きな取り戻しを、WebSocket の送信の待ちと背圧の上限に載せることになる。HTTP なら圧縮・ページング・再試行が単純で、Gateway のメモリーを使わない。

## Consequences

- 良くなること：
  - 再接続の判断が 1 つの決定表になり、表駆動テストで全行を確かめられる。
  - Gateway は生の差分と送信だけを持ち、重い取り戻しを Sync API に逃がせる。
  - DR の後の番号の食い違い（`sync_epoch`、`ahead`）を、握手で確実にやり直しへ回せる。
- 引き受けるコスト：
  - JSON の分、送信の量と解析の CPU が二値より多い。圧縮（上の注記）で送信の量を抑え、E12 の負荷試験で見直す。
  - 取り戻しと生の差分の 2 つの経路を、クライアントが突き合わせる必要がある（範囲の規則で揃える）。

## Confirmation

- 表駆動テスト：握手の決定表（sync-engine.md の 9.4 節）の全行。
- 性質ベーステスト（[ADR-0010](0010-deterministic-sync-simulator.md)）：取り戻しの途中で生の差分が届く、取り戻しの途中で切れる、`sync_epoch` が変わる、の列で PROP-SYNC-001・003 が成り立つ。
- 結合テスト：チケットの使い回し、期限切れ、他のワークスペースのチケットが拒否される。
- 負荷試験（E12）：再接続の殺到（1 タスクの喪失で 1 万接続）で、乱数の待ちが受け付けの上限に収まる。

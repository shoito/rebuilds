---
status: accepted
date: 2026-09-28
---

# ADR-0007: `sync_id` は変更ごとに振って欠けなく続け、差分は範囲の証明つきのパケットで送る。Gateway は絞る前の列の連続を確かめてから範囲を名乗り、`update` は変更後の行の全体を運ぶ

## Context

[ADR-0002](0002-sync-model.md) で、`sync_actions` の行の形と、「絞った後の差分は `sync_id` が飛び飛びになるので、各パケットに `(from, to]` の範囲を付ける」ことを決めた。残る問いは次のとおり。

- `sync_id` を変更ごとに振るか、トランザクションごとに振るか。
- Gateway が範囲を名乗ってよい条件。Valkey の pub/sub はベストエフォートで、メッセージが落ちうる。
- `update` の差分に、変わったフィールドだけを載せるか、行の全体を載せるか。[ADR-0003](0003-bootstrap-and-partial-sync.md) は、遅延のモデルの差分も IndexedDB に書くと決めている。
- 同期グループの参加・脱退・移動を、差分の中でどう表すか。

第三者の解析によれば、本家の sync action は `id`・`modelName`・`modelId`・`action`・`data` を持ち、`action` は I・U・A・D・V と、C（部分の索引の印）、G・S（同期グループの変化）である。手元の `lastSyncId` とサーバーの値を比べ、違えば履歴の API で取り戻す（[reverse-linear-sync-engine](https://github.com/wzhudev/reverse-linear-sync-engine)、[Reverse engineering Linear's sync magic](https://marknotfound.com/posts/reverse-engineering-linears-sync-magic/)、いずれも 2026-09-28 に確認。本家の保証ではない）。本家の差分の `data` が行の全体か一部かは**未検証**。

## Options

番号：

1. **変更ごとに 1 つ。ワークスペースの中で欠けなく続く**
2. トランザクションごとに 1 つ

範囲の証明：

- a. **Gateway が、絞る前の列が `(from, to]` で欠けなく並んだときだけ範囲を名乗る。欠けは Gateway が DB から埋める**
- b. Gateway は届いたものをそのまま範囲にし、欠けの判定はクライアントに任せる
- c. 範囲を付けず、クライアントが定期的に `head` を問い合わせる

`update` の中身：

- x. **変更後の行の全体と、変わったフィールドの名前**
- y. 変わったフィールドの値だけ

## Decision

1・a・x を採用する。詳細は [sync-engine.md](../architecture/sync-engine.md) の 7 節。

- `sync_id` は変更ごとに振る。拒否したトランザクションは番号を使わないので、ワークスペースの列は欠けなく続く。トランザクションの確定の番号は最後の変更の番号で、各変更に `tx_end` を付ける。
- `action` は `insert`・`update`・`append`（本文の CRDT）・`archive`・`unarchive`・`delete`。同期グループへの参加・脱退は、`SyncSubscription` モデルの `insert`・`delete` で表し、専用の種類を足さない。グループの移動は、変更の行に `groups_before` を付ける。Gateway は、前のグループだけを購読する接続に `evict` を作って送る（`evict` はログに書かない）。
- Relay は `sync_outbox` の範囲ごとに、絞る前の変更の列を Valkey のワークスペースのチャンネルへ出す。
- Gateway はワークスペースごとに `head` を持ち、届いた範囲が `head` に続かなければ、Aurora の reader（遅れていれば writer）から埋める。欠けなく並んだ範囲だけを、接続の同期グループで絞って `deltas {from, to, actions}` として送る。範囲の終わりはトランザクションの境にする。変更が 0 件の範囲も、1 秒に 1 回まで空のパケットで知らせる。
- 接続の購読の変化は、`SyncSubscription` の変更の `sync_id` の直後から効かせる。絞る前の列を順に処理するので、参加・脱退の位置が番号で決まる。
- クライアントは `from == L` なら当て、`from > L` なら Sync API で `(L, from]` を取り戻す。
- `update` は変更後の行の全体と `changed` を運ぶ。
- 2 を採らない理由：1 つのトランザクションの変更の数だけ、パケットの中の位置を別に表す必要がある。変更ごとの番号なら、行ごとの `updated_sync_id` と、遅延の読み込みとの突き合わせ（ADR-0003）がそのまま使える。
- b を採らない理由：Valkey のメッセージが落ちたとき、同じ Gateway の数千の接続が、同じ範囲を一斉に Sync API へ取りに来る。欠けを Gateway で 1 回埋めれば済む。
- c を採らない理由：絞った後の列は飛び飛びなので、`head` だけでは見てよい変更の欠けを判定できない。
- y を採らない理由：手元にない遅延のモデルの行を、差分だけで作れない。ADR-0003 の「遅延のモデルの差分も書く」が成り立たない。

## Consequences

- 良くなること：
  - 欠けの検出が「範囲がつながっているか」の 1 つの規則になり、性質ベーステストで完全さを示せる。
  - Valkey の喪失は Gateway で吸収され、クライアントの取り戻しが集中しない。
  - グループの参加・脱退の位置が番号で決まり、どの経路でも同じ結果になる。
- 引き受けるコスト：
  - `sync_actions` が行の全体を持つので大きくなる。E2 で行の大きさを測り、想定を超えれば、遅延のモデルだけ全体にする ADR を書く。
  - Gateway が、ワークスペースごとの `head` と埋めの処理を持つ。

## Confirmation

- 性質ベーステスト（[ADR-0010](0010-deterministic-sync-simulator.md)）：PROP-SYNC-003（欠けの検出の完全さ）、PROP-SYNC-004（範囲の証明の正しさ）。Valkey のメッセージの喪失・重複・遅延を注入する。
- 結合テスト：Relay を止めて再開しても、Gateway の各接続の範囲が連続する。
- 本番：Gateway の欠けの埋めの回数と、クライアントの取り戻しの回数を監視する。配信の監査（送った変更の `groups` と接続の `groups` の抜き取りの突き合わせ）で不一致 0 件（NFR-008）。

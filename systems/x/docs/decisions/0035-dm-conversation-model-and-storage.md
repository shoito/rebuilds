---
status: accepted
date: 2026-10-04
---

# ADR-0035: DM は会話ごとの連番で並べ、参加者の FORCE RLS と会話ごとの鍵の列の暗号化で守る。配信は ID だけを流して受け手の権限で読み直す

詳細は [direct-messages.md](../architecture/direct-messages.md) の 4・6 節。

## Context

- DM のメッセージの ID は `tid` だが、`tid` は生成器の間でおおむねの順で、確定の順と一致しない。会話の中の厳密な順は、その処理の中の順序で決める（[ADR-0002](0002-post-ids-and-ordering.md)）。既読の位置と、全参加者が同じ順で見ることに、厳密な順が要る。
- DM は本人（参加者）だけが読む。参加者の表を通した FORCE RLS で守る（[ADR-0004](0004-single-tenant-and-visibility.md)）。運用のロールには RLS が効かない。DM は通信の秘密に当たりうる（L3）。
- オンラインの相手へ p95 1 秒で届ける（NFR-008）。配信の道が RLS を迂回すると、他人の DM が届きうる（NFR-009）。
- 確定した変更は outbox から出来事のログへ流し、データレイクへ写す（[ADR-0005](0005-event-log-and-outbox.md)）。DM の出来事をそのまま写すと、通信の相手と時刻がデータレイクに残る。

## Options

順：

1. **会話ごとの連番 `seq`（会話の行の鍵で一列にする）。主キー `(conversation_id, seq)`**
2. `tid` の順
3. 確定の時刻の順

保存：

- a. **参加者の FORCE RLS と、会話ごとのデータの鍵（KMS で包む）での本文の列の暗号化**
- b. 参加者の FORCE RLS と、Aurora の保存の暗号化だけ

配信：

- x. **Valkey の pub/sub で ID だけを流し、Gateway が受け手の権限で読み直して送る**
- y. pub/sub に本文を載せて送る

## Decision

1、a、x を採用する。

- 送信は 1 つのトランザクションで、会話の `last_seq` を上げ、メッセージの行、参加者の `updated_at`、outbox を書く。`(conversation_id, sender_id, client_msg_id)` の一意の制約で再送の重複を落とす。
- RLS：`active` の参加者が `seq >= joined_seq` のメッセージを読める。申請を受けた人は申請の会話を読める。`ts_reader` にも本文の列の権限を与えない。
- 本文は会話ごとの DEK（AES-256-GCM）で暗号化し、DEK は KMS の `dm-content` で包む。`Decrypt` は DM のサービスのロールにだけ許す。会話を消すときは DEK を消す。
- 配信は `dm:{user_id}` へ `{conversation_id, seq}` だけ。Gateway は受け手の `app.actor_id` で読み直す。取りこぼしはクライアントの同期で埋める。
- 出来事は `dm` の流れ（Kinesis Data Streams）に ID だけを入れ、Firehose でデータレイクへ写さない。消費者は Notification と T&S の数え上げだけ。[ADR-0005](0005-event-log-and-outbox.md) の流れの表に `dm` を足す。
- プッシュに本文を載せない。
- 2 を採らない理由：参加者ごとに見る順が変わりうる。既読の位置が定まらない。
- 3 を採らない理由：時計のずれで同じ問題が起きる。
- b を採らない理由：DB を読める人（運用者、誤った権限）が本文を読める。読み出しの記録が DB の監査に頼る。バックアップに残った本文を消せない。
- y を採らない理由：本文が RLS の外の道を通り、Gateway の誤り（接続と利用者の取り違え）で他人に届きうる。

## Consequences

- 良くなること：
  - 全参加者が同じ順で見る。再送で重複しない。
  - 本文は DB の権限だけでは読めず、復号は KMS の記録に残る。消した会話は読めなくなる。
  - 配信の道も RLS を通る。
  - 通信の相手の組がデータレイクに残らない。
- 引き受けるコスト：
  - 同じ会話の送信が会話の行の鍵で一列になる（1 会話 1 秒 10 件の上限で抑える）。
  - Gateway の配信に読み直しの往復（数 ms〜十数 ms）が乗る。
  - KMS の障害で DM が止まる（DEK のメモリーの写しの 5 分の間を除く）。
  - DM の利用の分析（何人が DM を使ったか）は、`dm` の流れの数え上げを別に集計する形でしかできない。

## Confirmation

- 性質ベーステスト：PROP-DM-001（RLS）、PROP-DM-002（`seq` の欠けと重複なし）、PROP-DM-003（全参加者の列の一致）、PROP-DM-006（本文と相手の組が出力に出ない）。
- CI：`dm_*` の表の FORCE RLS の検査。`ts_reader` に `body_ct` の権限がないことの検査。Firehose の設定に `dm` の流れがないことの検査。
- 本番：KMS の `Decrypt` の呼び出し元の監査（DM のサービスのロール以外は 0）。

# Data model: DB の外のストアとペイロード

[data-model.md](../data-model.md) の一部。Valkey のキー、S3 のキー、イベント・ジョブのペイロード、検索のインデックス、クライアントの IndexedDB の形をまとめる。どれも正本ではない（ADR-0002）。失っても DB から作り直せる（I-24）。例外は S3 のファイルの本体と、監査ログのアーカイブ。

## 1. 共通の規則

- **テナントの外に出る名前には、必ず `workspace_id` を含める**（ADR-0009、I-22）。含めないのは、ワークスペースが決まる前に引くもの（チケット、`acct:`、`response_url`）と、ワークスペースに属さない計数（`rl:{global}`）だけ。その場合も、値の中に `workspace_id` を持たせ、使う側で照合する。
- この文書では、名前の中の可変の部分を `<w>`（`workspace_id`）、`<c>`（`channel_id`）、`<m>`（`member_id`）のように書く。実際の名前に `<>` は入らない。
- Valkey の名前に波かっこ `{}` を使うのは、レート制限のキーのハッシュタグ（`rl:{<w>}:...`）だけ。Pub/Sub のチャンネル名には使わない（[realtime.md](../realtime.md) の 1 節）。

## 2. Valkey

### 2.1 Pub/Sub のチャンネル

| 名前 | 流すもの | 出す側 | 購読する側 | 定めた場所 |
| --- | --- | --- | --- | --- |
| `ws:<w>:ch:<c>` | チャンネルのストリーム（`seq` のイベント、`typing`、大規模チャンネルの `channel.head`・`reaction.summary`） | Relay、Gateway（`typing`） | Gateway（ノードごとに 1 回） | [realtime.md](../realtime.md) の 5 節、ADR-0013 |
| `ws:<w>:m:<m>` | メンバーのストリーム（4.3 節） | Relay | Gateway | 同上 |
| `ws:<w>:pr` | 在席の差分（1 秒ごと） | Gateway | Gateway | [realtime.md](../realtime.md) の 9 節 |
| `acct:<account_id>` | `session.revoked` | api | Gateway（その接続のアカウント） | [identity-and-access.md](../identity-and-access.md) の 3.3 節 |

- S1 は `PUBLISH` / `SUBSCRIBE`、S2 はクラスタで `SPUBLISH` / `SSUBSCRIBE`。名前は変えない。

### 2.2 キー

| キー | 型 | TTL | 中身 | 書く / 読む | 定めた場所 |
| --- | --- | --- | --- | --- | --- |
| `ticket:<sha256(ticket)>` | string（JSON） | 30 秒 | `{account_id, session_id, workspace_id, member_id, issued_at}`。`GETDEL` で 1 回だけ | api / Gateway | [identity-and-access.md](../identity-and-access.md) の 7 節 |
| `ws:<w>:pr:<m>` | sorted set | 90 秒（30 秒ごとに延長） | 要素は接続 ID、スコアは失効時刻 | Gateway / Gateway | [realtime.md](../realtime.md) の 9 節 |
| `ws:<w>:act:<m>` | hash | 90 秒 | 接続 ID → `{state, focused_channel_id, at}` | Gateway / 通知の planner | 同上、[read-state-and-notifications.md](../read-state-and-notifications.md) の 6.2 節 |
| `rl:{<w>}:<limit>:<subject>` | string | 制限の期間＋バースト | GCRA の `TAT` | ミドルウェア・Worker | [rate-limiting.md](../rate-limiting.md) の 3.1 節 |
| `rl:{global}:<limit>:<subject>` | string | 同上 | IP・アカウントの制限 | 同上 | 同上 |
| `rl:{<w>}:conc:<name>` | sorted set | 要素ごとの期限 | 実行中の要求（スコアは期限） | ドメイン層 | 同上（L5） |
| `ws:<w>:trigger:<sha256(trigger_id)>` | string（JSON） | 10 秒 | `{installation_id, member_id, connection_id}`。`GETDEL` で 1 回だけ | api / public-api | [apps.md](../apps.md) の 9.1 節 |
| `hooks:resp:<sha256(token)>` | hash | 30 分 | `{workspace_id, installation_id, member_id, channel_id, uses_left}`（5 回まで） | api / public-api（`hooks.<domain>`） | [apps.md](../apps.md) の 9.1 節（2026-09-28 に置き場所を決定） |
| `app:<app_id>:inflight` | sorted set | 要素ごとの期限 | アプリごとの同時に送る数（上限 50） | app-delivery Worker | [apps.md](../apps.md) の 13 節 |
| `ws:<w>:ch:<c>:has_bot` | string | 60 秒 | ボットが参加しているか（`0` / `1`） | app-event-router | [apps.md](../apps.md) の 18.1 節 |
| `ws:<w>:ch:<c>:recent` | sorted set | 1 時間 | 直近 1,000 件のイベント（スコアは `seq`）。S2 の大規模チャンネルだけ | Relay / api（差分取得） | [realtime.md](../realtime.md) の 5.3 節 |

- Better Auth は Valkey を使わない（`secondaryStorage` を使わない決定。[identity-and-access.md](../identity-and-access.md) の 3.2 節）。
- entitlement（60 秒）、メンバーの解決（60 秒）、トークンの検査（30 秒）、キーワードの照合器は、各タスクのメモリにキャッシュする。Valkey には置かない。
- Valkey を失ったとき：チケット・`trigger_id`・`response_url` が無効になり、取り直し・やり直しになる。在席は一時的に全員 `offline`。レート制限は [rate-limiting.md](../rate-limiting.md) の 3.4 節のとおり。

## 3. S3

バケットの名前は論理名。実際の名前は IaC で環境ごとに付ける（[infrastructure.md](../infrastructure.md)）。暗号化の鍵は ADR-0017。

| バケット | キー | 中身 | 鍵 | 保持 | 定めた場所 |
| --- | --- | --- | --- | --- | --- |
| `uploads` | `ws/<w>/files/<file_id>` | ファイルの原本。GuardDuty のタグ `GuardDutyMalwareScanStatus` が付く | `files` | ファイルの削除で消す。`THREATS_FOUND` は 30 日。古いバージョンは 30 日 | [files.md](../files.md)、ADR-0015 |
| `derived` | `ws/<w>/files/<file_id>/thumb_<width>.webp` | サムネイル（幅 360・720・1440） | `files` | 原本と同時に消す | [files.md](../files.md) の 5.3 節 |
| `derived` | `ws/<w>/unfurls/<url_hash>.webp` | リンクのプレビューの画像。`url_hash` は 16 進 | `files` | `link_previews` の行と同時に消す | [messaging.md](../messaging.md) の「リンクのプレビュー」 |
| `exports` | `ws/<w>/exports/<export_id>/manifest.json`、`.../channels/<channel_id>.jsonl`、`.../files/<file_id>` | エクスポートの成果物。本文は AST のまま | `exports` | 7 日（ライフサイクル） | ADR-0019 |
| `audit-archive`（log-archive アカウント） | `audit/ws/<w>/<yyyy>/<mm>/<dd>/<batch_id>.jsonl.gz` | 監査ログのバッチ。前のバッチのハッシュを含む | `audit` | Object Lock（コンプライアンスモード）で 2 年 | ADR-0018、ADR-0033 |
| `audit-archive` | `audit/platform/<yyyy>/<mm>/<dd>/<batch_id>.jsonl.gz` | `platform_audit_events` のバッチ | `audit` | 同上 | 同上 |
| `audit-archive` | `digests/<yyyy>/<mm>/<dd>/<hh>.json`、同じ名前の `.sig` | 1 時間ごとのダイジェストと KMS の署名 | `audit` | 同上 | ADR-0018 |
| `deletion-ledger` | `<yyyy>/<mm>/<dd>/<w>/<run_id>.jsonl` | 物理削除した ID の一覧（ワークスペース、メッセージ、ファイル） | `backup` | 45 日（バックアップの 35 日より長く） | ADR-0019（2026-09-28 に置き場所を決定） |

- **ワークスペースの消去**は、`uploads`・`derived`・`exports` の `ws/<w>/` を一括で消す（ADR-0019）。監査ログのアーカイブは期限まで残る。
- **削除の台帳**（`deletion-ledger`）は、バックアップから復元したときに削除を再適用するためのもの（ADR-0019 の「削除の最終的な期限」）。DB に置くと復元で一緒に巻き戻るので、S3 の別のバケットに置く。大阪へ複製する。
- `uploads` と `derived` は東京 → 大阪へ複製する（[infrastructure.md](../infrastructure.md)）。

## 4. イベントのペイロード

### 4.1 outbox の行と封筒

outbox の 1 行が、Valkey に流す封筒（[realtime.md](../realtime.md) の 4 節）1 つになる。

| 封筒の項目 | outbox の列 |
| --- | --- |
| `v` | 固定（今は 1） |
| `type` | `event_type` |
| `event_id` | `event_id` |
| `workspace_id` | `workspace_id` |
| `channel_id`、`seq` | `channel_id`、`seq`（チャンネルのストリームだけ） |
| `occurred_at` | `created_at` |
| `payload_v`、`payload` | `payload_v`、`payload` |
| `trace_context` | `trace_context`（[observability.md](../observability.md) の 2.1 節） |

- `seq` を消費するイベントは、同じ `event_id`・`seq`・`payload` で `channel_events` にも書く。
- 型は `packages/contract` の Zod（`type` による判別共用体）で持つ（ADR-0008）。1 イベント 16 KB まで。

### 4.2 チャンネルのストリーム（`seq` を消費する）

`payload` の主な項目。一覧と宛先（リアルタイム・検索・通知など）は [messaging.md](../messaging.md) の「イベント」を正とする。

| `type` | `payload` |
| --- | --- |
| `message.created` | `message`（`id`、`member_id`、`body`、`body_format`、`ui_blocks`、`thread_root_id`、`also_send_to_channel`、`broadcast_mention`、`mentions`（`member_id` の配列）、`files`、`created_at`、`content_seq`）。返信なら `thread`（`root_id`、`reply_count`、`reply_member_ids`、`last_reply_at`、`last_reply_seq`）。16 KB を超えたら `truncated: true` で本文を省く |
| `message.edited` | `message_id`、`body`、`edited_at`、`content_seq`、`mentions` |
| `message.deleted` | `message_id`、`thread_root_id`、`thread`（親の新しい値）、`content_seq` |
| `message.unfurls_updated` | `message_id`、`unfurls`（`url`、`title`、`description`、`site_name`、画像の有無、`hidden`） |
| `reaction.added` / `reaction.removed` | `message_id`、`emoji`、`member_id` |
| `pin.added` / `pin.removed` | `message_id`、`member_id` |
| `file.updated` | `file_id`、`message_id`、`status`、`has_thumbnails` |
| `channel.created` | `channel_id`、`name`、`kind`、`is_private`、`created_by_member_id` |
| `channel.renamed` | `channel_id`、`name` |
| `channel.archived` | `channel_id`、`archived_by_member_id` |
| `channel.updated` | `channel_id`、変わった属性（`topic`、`description`、ブックマーク） |
| `channel.member_joined` / `channel.member_left` | `channel_id`、`member_id` |

### 4.3 メンバーのストリーム（`seq` を消費しない）

`ws:<w>:m:<m>` に流す。状態の正本は各テーブル。取りこぼしたら API で取り直す。

| `type` | `payload` | 元の表 |
| --- | --- | --- |
| `read.updated` | `channel_id`、`last_read_seq` | `channel_members` |
| `thread_subscription.updated` | `root_message_id`、`subscribed`、`last_read_seq` | `thread_subscriptions` |
| `channel.joined` / `channel.left` | `channel_id` | `channel_members` |
| `prefs.updated` | 変わった設定の名前 | `member_notification_prefs` |
| `member.access_changed` | `reason`（`deactivated` / `role_changed`） | `members` |
| `entitlements.updated` | 変わった名前 | `workspace_entitlements`（ADR-0032） |
| `view.opened` / `view.updated` | `view_id`、`kind`、`ui_blocks`、宛先の `connection_id` | `app_views` |
| `ephemeral.message` | `channel_id`、`body`、`ui_blocks`、`installation_id` | 保存しない |

`session.revoked`（`session_id`）は `acct:<account_id>` に流す（2.1 節）。

### 4.4 一時的なイベント（DB を通らない）

| `type` | `payload` | 経路 |
| --- | --- | --- |
| `typing` | `channel_id`、`thread_root_id`、`member_id` | Gateway → `ws:<w>:ch:<c>` |
| `presence.changed` | `[{member_id, state}]` | Gateway → `ws:<w>:pr` |
| `channel.head` | `channel_id`、`seq`、`has_mention_for_you` | 大規模チャンネル（S2） |
| `reaction.summary` | `message_id`、絵文字ごとの件数 | 大規模チャンネル（S2） |

### 4.5 アプリへのイベント

アプリへ送る封筒（`event_callback`）とペイロードは公開の契約で、内部のイベントと形を分ける（[apps.md](../apps.md) の 7.2 節、[public-api.md](../public-api.md) の 5.4 節）。中身は送る時点の DB から作る。

## 5. SQS のジョブ

Relay から Worker へのメッセージは「きっかけ」で、Worker は中身を DB から読み直す（ADR-0014）。共通の形：

```json
{
  "v": 1,
  "event_id": "0192f7c4-...",
  "event_type": "message.created",
  "workspace_id": "0192...",
  "channel_id": "0193...",
  "seq": 1234,
  "target_id": "0194...",
  "occurred_at": "2026-09-26T09:00:00.000Z"
}
```

- メッセージ属性 `traceparent` を付ける（[observability.md](../observability.md) の 2.1 節）。
- Worker は `workspace_id` でテナントのコンテキストを設定してから処理する（[data-model.md](../data-model.md) の 6 節）。冪等キーは `(workspace_id, channel_id, seq)`、`seq` のないイベントは `event_id`。

| キュー | 流すもの | 形の違い | 定めた場所 |
| --- | --- | --- | --- |
| `search-index` | `message.created` / `edited` / `deleted` | 共通の形 | [search.md](../search.md) の 2.3 節 |
| `notify-events` | `message.created`、`message.deleted`、`channel.member_left` | 共通の形 | [read-state-and-notifications.md](../read-state-and-notifications.md) の 4 節 |
| `notify-fanout` | 大人数の受け手の続き | `{v, workspace_id, message_id, reason, member_ids}`（500 人まで） | 同上 |
| `notify-push` | 1 受け手の push | `{v, workspace_id, member_id, message_id, reason}` | 同上 |
| `unfurl` | `message.created` / `edited` | 共通の形 | [messaging.md](../messaging.md) の「リンクのプレビュー」 |
| `file-events` | スキャン結果（EventBridge）とサムネイルのジョブ | GuardDuty のイベントの形のまま。S3 のキーから `workspace_id` と `file_id` を取り出す | [files.md](../files.md) の 5.2 節 |
| `app-events` | アプリの対象になるイベント | 共通の形 | [apps.md](../apps.md) の 7.3 節 |
| `app-delivery` | 1 件の配送 | `{v, workspace_id, installation_id, event_id}` | 同上 |

- 各キューにデッドレターキューを付ける（`maxReceiveCount` = 5、最大 14 日）。
- アカウントの削除のジョブ（ワークスペースごとのメンバーの匿名化。[identity-and-access.md](../identity-and-access.md) の 12 節）と、保持・消去・エクスポートのジョブ（ADR-0019）のキューの名前は、E2・E8 の各変更で決める。形は共通の形に `job_type` を足したものにする。

## 6. 検索のインデックス

### 6.1 S1：PostgreSQL

`search.message_docs`（[files-and-search.md](files-and-search.md)）。

### 6.2 S2：OpenSearch

- 別名 `messages` の裏に、版付きのインデックス（`messages-v1` など）を置く。ルーティングは `workspace_id`。
- マッピング（[search.md](../search.md) の 5.2 節。`is_private` は 5.3 節の権限の条件に使う）：

```json
{
  "workspace_id": "keyword", "message_id": "keyword", "channel_id": "keyword",
  "member_id": "keyword", "thread_root_id": "keyword",
  "is_private": "boolean",
  "created_at": "date", "content_seq": "long", "deleted": "boolean",
  "has_file": "boolean", "has_link": "boolean",
  "text": { "type": "text", "analyzer": "ja_sudachi",
            "fields": { "gram": { "type": "text", "analyzer": "ja_1_2gram" } } }
}
```

- 文書の ID は `message_id`。版は `content_seq` の外部バージョン（`version_type: external`）。
- チャンネルの公開・非公開を切り替えたら、そのチャンネルの文書を再インデックスする。
- S3 のセル構成では、セルごとにドメインを持つ。

## 7. クライアントの IndexedDB

形は [client.md](../client.md) の 3.7 節を正とする。要点だけを書く。

| ストア | キー | 中身 | 追い出し |
| --- | --- | --- | --- |
| `messages` | `[workspace_id, channel_id, seq]` | 最近開いたチャンネルの最新側のメッセージ | LRU（全体 50 MB） |
| `channel_state` | `[workspace_id, channel_id]` | `applied_seq`、窓の範囲、最後に開いた時刻 | LRU |
| `outbox` | `client_msg_id` | 未送信のメッセージ | しない |
| `drafts` | `[workspace_id, channel_id, thread_root_id]` | 下書き | しない |
| `meta` | 固定 | スキーマの版、キャッシュの総量 | — |

- データベースはアカウントごとに分ける（`slack:<account_id>`）。ログアウトで消す。ワークスペースから外されたら、そのワークスペースの行を消す。

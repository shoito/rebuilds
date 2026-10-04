---
status: accepted
date: 2026-10-04
---

# ADR-0046: 正しさと遅れの SLI は、トレースの抜き取りではなく、業務の記録（リマインダーの送信の記録、配送の記録、iMIP の送信の記録、トークンの使用の記録）から全件で数える。リマインダーの遅れは「回の通知の時刻」から「送信の開始」までにし、送らなかったものと遅れすぎたものを悪いイベントに数える。招待は `msg_id` を主催者のコミットから参加者の写し・iMIP・SES の事象まで運んで結ぶ

## Context

[runbooks/README.md](../runbooks/README.md) の 1 節は、SLO の値と、良いイベントを数える場所を決めた。observability の領域は、その計測を決める。

この題材の SLI には、要求と応答の組で数えられないものが多い。

- **リマインダー**（NFR-003）：要求がない。「送るべきだった」の集合は、展開の索引の回とリマインダーの設定から決まる。送らなかったものは、どのログにも現れない。
- **招待の伝播**（NFR-002）：主催者の書き込みのトランザクションから、別のテナントの参加者の写しのコミットまで、outbox・SQS・`itip-delivery` を通る。200 人の招待は 200 本の枝になる。外部の参加者は SES に渡し、その先の配達の事象（Delivery・Bounce）は非同期に返る。
- **差分の同期の健全さ**（NFR-010）：410 の多さ、トークンの古さ、取り直しの量は、クライアントの種類（Web・API・CalDAV のクライアントの種類）ごとに見ないと、原因がわからない。

トレース（X-Ray）は抜き取り（1% と、エラー・遅いもの）で、全件の割合を出せない。

## Options

1. **SLI を業務の記録から全件で数える。トレースは原因の調査に使う**
2. SLI をトレースから数える（抜き取りを 100% にする）
3. SLI をログの集計（CloudWatch Logs Insights）で数える

## Decision

1 を採用する。

### 記録と SLI

| SLI | 記録（書く場所） | 良いイベント | 悪いイベント |
| --- | --- | --- | --- |
| リマインダーの時刻どおりの送信（NFR-003・006） | `reminder_deliveries`（`reminder-delivery-ledger`。鍵は [ADR-0030](0030-reminder-planning-horizon-and-replan.md) の（利用者, 予定オブジェクト, `recurrence_id`, 方法, 分, 回の開始）、`due_at`、`started_at`、`handed_off_at`、`outcome`） | 画面・Web Push：`started_at − due_at ≤ 30 秒`。メール：`handed_off_at − due_at ≤ 2 分` | 超えたもの、計画の行の `skipped_late`（15 分を超えて送らなかったもの）、照合で見つかった送り漏れ（`missing`） |
| リマインダーの送り漏れ（K6） | 照合のジョブ（毎時）が、1 時間前から 15 分前までの `due_at` の回を、展開の索引とリマインダーの設定から作り、`reminder_deliveries` と比べる | — | 記録のない回・方法（`missing`）。付け替えで消えた古い時刻の計画は除く |
| 伝播（主催者 → 参加者の写し）（NFR-002） | `itip_deliveries`（`msg_id`、受け手、`organizer_committed_at`、`applied_at`、`outcome`、受け手の数の帯 `≤200`・`>200`） | `applied_at − organizer_committed_at` が 5 秒以内（200 人まで）、60 秒以内（超える分） | 超えたもの、`outcome = failed` |
| iMIP の送信（NFR-011） | `imip_outbound_log`（`msg_id`、`ses_message_id`、`queued_at`、`handed_off_at`）と、SES の構成セットの事象（Send・Delivery・Bounce・Complaint） | `handed_off_at − queued_at ≤ 60 秒` | 超えたもの、送信の失敗。Bounce・Complaint は別の指標 |
| iMIP の受信（NFR-011） | `imip_inbound_log`（S3 の保存の時刻、当てた時刻） | 2 分以内に判定（通る・未確認・捨てた）まで進んだ | 超えたもの |
| 差分の同期の健全さ（NFR-010） | `sync_token_uses`（抜き取りではなく、カレンダー × クライアントの種類 × 日の集計の表。トークンの年齢、410 の理由、差分の件数、応答の時間） | 変更 1,000 件以下の差分の応答が 1 秒以内 | 超えたもの。410 は理由ごとに別の指標 |

- 記録は、業務の処理と同じトランザクションか、同じ処理の中で書く（リマインダーの送信の記録は、送る前に書く鍵そのもの）。計測のためだけの書き込みを足さない。
- SLI の値は、`slo-aggregator`（Worker）が 1 分ごとに記録を集め、AMP のメトリクス（`sli_good_total`・`sli_total`、ラベルは SLI の名前と帯）に出す。バーンレートのアラートは AMP の上で計算する。
- 社内の監視用のテナントの記録は、SLI から除き、別のラベルで出す。

### 招待の追跡

- `packages/writer` が、主催者の書き込みのトランザクションで outbox に書く iTIP のメッセージに、`msg_id`（UUIDv7）と、その時点の `traceparent` を入れる。
- `msg_id` は、SQS のメッセージの属性、`itip_deliveries` の行、受け手の写しの `calendar_changes` の行（`origin_msg_id`）、`imip_outbound_log`、SES のメッセージのタグ（`msg_id`）に運ぶ。SES の事象は構成セット → SNS → SQS → `imip-events` で受け、タグで `imip_outbound_log` に結ぶ。
- 調べるときは、`msg_id` 1 つで、主催者のコミット → 受け手ごとの当て → 外部への引き渡し → 配達・Bounce を並べられる（運用の画面。予定の中身は出さない）。
- 大きな招待（200 人を超える）は、`msg_id` ごとに受け手の数・済みの数・最も遅い受け手の遅れを `itip_fanout_progress` に持つ。

### 差分の同期の健全さ

- 410 を理由で分ける：`floor_seq`（保持の外）、`view_hash`（見え方の変更）、`epoch`（DR・復元）、`token_invalid`（署名の誤り）。`filter_hash` の違いは 400 で別に数える。
- クライアントの種類：`web`、`api:<client_id の帯>`、`caldav:<家族>`（User-Agent を `ios`・`macos`・`thunderbird`・`davx5`・`other` に寄せる。版は主の版だけ）。
- 取り直しの量（全件の範囲の問い合わせ、CalDAV の `sync-token` なしの `sync-collection`）を、クライアントの種類ごとに数え、平常の 3 倍で見る。

### 他の案を選ばなかった理由

- **2（トレースで全件）**：X-Ray とストレージの費用が要求の数に比例して大きい。リマインダーの送り漏れのような、起きなかったことは数えられない。
- **3（ログの集計）**：ログの欠けと遅れがそのまま SLI の誤りになる。ログに中身を書かない規則（[observability.md](../architecture/observability.md) の 2 節）の下で、結びつける鍵が足りない。

> 2026-10-04 の注記：起票の時は、送信の記録の鍵を最初の設計の `(reminder_id, occurrence_start, method, version)` で書いていた。統合の工程で [ADR-0030](0030-reminder-planning-horizon-and-replan.md) の鍵（版を入れない）に揃え、遅れすぎの名前を計画の行の状態 `skipped_late` に揃えた。

## Consequences

- 良くなること：
  - SLI が全件で数えられ、送り漏れのような「起きなかったこと」も悪いイベントになる。
  - 1 つの `msg_id` で、招待の配送を端から端まで追える。
  - 410 の急増の原因（保持、ACL、DR、クライアントの不具合）を区別できる。
- 引き受けるコスト：
  - 記録の表（`itip_deliveries`、`imip_outbound_log`、`sync_token_uses`）の書き込みが増える。分割と保持（[ADR-0042](0042-audit-log-and-data-lifecycle.md)）で抑える。
  - `slo-aggregator` が止まると SLI が欠ける。欠けを「データなし」のアラートにする。

## Confirmation

- 結合テスト：リマインダーの時計の試験（[quality.md](../quality.md) の 2.2.1 節 F）で、送らなかった回が照合で `missing` になり、SLI の悪いイベントに数えられる。
- 結合テスト：200 人の招待で、`msg_id` から全受け手の `itip_deliveries` と、外部の参加者の `imip_outbound_log` が引ける。
- 本番：合成監視の伝播と、記録からの SLI の p99 の差が、10% を超えたらチケット（計測の誤りの兆候）。

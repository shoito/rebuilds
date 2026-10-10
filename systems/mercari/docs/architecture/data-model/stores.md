# Data model: Aurora の外（Valkey・S3・SNS と SQS・プッシュ・OpenSearch・逆索引・外部の形式・AppConfig）

[data-model.md](../data-model.md) の一部。Aurora の表の外に置くデータと、外とやり取りする形をまとめる。

- **正本は Aurora か S3 だけ。** Valkey と OpenSearch は失ってよい。Aurora から作り直せる（[ADR-0002](../../decisions/0002-transaction-state-machine-and-single-purchase.md)、[ADR-0008](../../decisions/0008-search-engine-and-index.md)、[ADR-0022](../../decisions/0022-saved-search-match-keys-and-inverted-index.md)）。
- 鍵・キー・メッセージには、ID・ハッシュ・状態・数・理由のコード・金額だけを入れる。住所、氏名、電話番号、メールアドレス、メッセージとコメントの本文、検索の語の平文、口座の番号を入れない（例外：検索の索引の題名・説明・ブランドは公開の欄）。
- 名前のうち領域の文書で決めていなかったものは、この文書で決めた（[data-model.md](../data-model.md) の 7 節 D-29）。ER 図は持たない（表でないため）。

## 1. Valkey

ElastiCache（Valkey）のクラスタモード。S1 は 2 シャード（[infrastructure.md](../infrastructure.md) の 4.2 節）。複数の鍵の操作をしないので、ハッシュタグは使わない。

| 鍵 | 種類 | 期限 | 中身 | 書く・読む | 決めた場所 |
| --- | --- | --- | --- | --- | --- |
| `listing:{listing_id}:snap` | HASH（`status`、`version`、`price`） | 1 日（事象で上書き） | 出品の写し（購入の前の確かめ） | outbox の消費者・購入のコミットの後に `transactions` が書く。`transactions` が読む | [ADR-0026](../../decisions/0026-hot-listing-purchase-admission.md) |
| `purchase:{listing_id}` | 文字列（勝った購入の試行の ID） | 15 秒 | 先着の印。`SET NX PX 15000`。取り消しのコミットの後に、値が自分の ID のときだけ消す（Lua） | `transactions` | [ADR-0002](../../decisions/0002-transaction-state-machine-and-single-purchase.md)、ADR-0026 |
| `vis:{listing_id}` | HASH（`status`、`mod`、`seller_state`、`version`、`sentinel`） | 7 日（事象で上書き） | `listingVisible()` の写し | `search-indexer`（優先）が書く。`search-api`・`notifier-decide`・`alert-digester`・`transactions` が読む | [ADR-0007](../../decisions/0007-single-tenant-and-party-visibility.md) |
| `sess:{token_hash}` | HASH（`user_id`、`device_id`、`strength`、`signed_in_at`、`session_id`） | 15 分 | `sessions` の写し | `identity` が書いて消す。`app-api` が読む | [ADR-0066](../../decisions/0066-sign-in-sessions-and-devices.md) |
| `sms:rl:phone:{phone_hmac}:{yyyymmdd}`・`sms:rl:ip:{ip_hmac}:{yyyymmddhh}`・`sms:rl:dev:{device_id}:{yyyymmdd}` | 数 | 窓の終わり ＋ 1 時間 | SMS の上限（1 番号 1 日 5、1 IP 1 時間 10、1 端末 1 日 10） | `identity` | この文書 |
| `rl:{action}:{subject_hash}:{window}` | 数 | 窓 ＋ 1 分 | 速さの上限（検索 1 人 1 分 120、写真 1 人 1 時間 300、通報 1 人 1 日 50、保存した検索の変更 1 人 1 分 10 など） | `app-api` | この文書 |
| `price:current` | 文字列（`{stats_version}:{date}`） | なし | 今の価格の提案の名前空間 | `ml-inference` が付け替える | [ADR-0016](../../decisions/0016-price-suggestion-from-sold-percentiles.md) |
| `price:{stats_version}:{date}:{level}:{category_id}:{brand_id}:{condition}` | HASH（`p25`、`p50`、`p75`、`n`、`computed_at`） | 3 日 | 段（1〜4）ごとの四分位。無い軸は `_` | `ml-inference` だけが書ける（ACL）。`listings`・`trust-safety` が読む | ADR-0016 |
| `rec:{user_id}` | 文字列（出品の ID の並び） | 10 分 | おすすめのキャッシュ | `search-api` | [ADR-0020](../../decisions/0020-likes-history-and-rule-recommendations.md) |
| `sq:{query_hash}` | 文字列（結果の ID の並び） | 10 秒 | 匿名の同じ問い合わせのキャッシュ | `search-api` | [search-and-discovery.md](../search-and-discovery.md) の 8 節 |
| `ss:k:{match_key}:{shard}` | HASH（`ss_id` → `packed`） | なし | 逆索引の写し（7 節） | `ss-index-writer` が書く。`saved-search-matcher` が読む | [ADR-0022](../../decisions/0022-saved-search-match-keys-and-inverted-index.md) |
| `ss:ks:{match_key}` | 文字列（分ける数 1〜64） | なし | 鍵の分け方 | 同上 | ADR-0022 |
| `ss:kv:{match_key}` | 数 | なし | 鍵のバージョン（Worker の LRU の確かめ） | 同上 | ADR-0022 |
| `ss:ready:{keys_version}` | 文字列 | なし | 作り直しの終わりの印 | 同上 | ADR-0022 |
| `ntf:devices:{user_id}` | 文字列（端末とトークンの JSON） | 24 時間 | `devices` の写し | `identity` の事象で `notifier` が直す | [ADR-0065](../../decisions/0065-notification-preferences-tokens-and-email.md) |
| `ntf:cap:{user_id}:{yyyymmdd}` | HASH（`engagement`、`saved_search`） | 48 時間 | 1 日の上限の数え（30 通・20 通） | `notifier-decide`・`alert-digester` | [ADR-0064](../../decisions/0064-fanout-batching-quiet-hours-and-caps.md) |
| `ntf:digest:{user_id}` | LIST（通知の ID） | 24 時間 | 静かな時間・窓で止めた通知 | `notifier-decide` | ADR-0064 |
| `ntf:win:{user_id}:{collapse_hmac6}` | 文字列 | 窓の長さ（1 分・5 分・1 時間） | 同じまとめの鍵の窓の印 | `notifier-decide` | この文書 |
| `ntf:dev:{device_id}:{yyyymmddhhmm}` | 数 | 2 分 | 1 端末 1 分 20 通 | `notifier-send` | この文書 |
| `psp:cb:{provider}:{method}` | HASH（窓の失敗の数、全体の数、状態、開いた時刻） | 10 分 | 決済の遮断器（1 分で 20% 超、30 秒止める） | `payments` | この文書（[payments-and-escrow.md](../payments-and-escrow.md) の 6.2 節） |

- Valkey が使えないとき：購入はタスクの中のセマフォ（4）と `lock_timeout` 200ms、セッションは core の読み出しの写し、`vis` は索引の `vis` と core、保存した検索は照合を止めて SQS に溜める、通知の `engagement` は後で再試行（[infrastructure.md](../infrastructure.md) の 7.4 節）。
- 大阪：平常は空。切り替えで core から作り直す（`sess`、`vis`、`listing:*:snap`、`ss:*`）。

## 2. 写真の配信の URL

- `https://static.<brand>.<domain>/p/{object_id}/{variant}.{webp|jpg}?v={photo_version}`。`variant` は `thumb`（240）・`medium`（640）・`large`（1,280）。
- 新しい写真の `object_id` は `photo_id` と同じ。再出品の写真は元の `object_id`（D-5）。出品の ID を URL に入れない。

## 3. S3

| バケット | キー | 中身 | 暗号化 | 保持 | 大阪 |
| --- | --- | --- | --- | --- | --- |
| `photos-incoming` | `{listing_id}/{photo_id}` | 元の写真（位置情報を含みうる） | SSE-KMS `kms-core` | 24 時間（ライフサイクル） | 写さない |
| `photos` | `{object_id}/{variant}.{ext}`、`quarantine/{object_id}/{variant}.{ext}`、`avatars/{photo_object_id}/{variant}.{ext}` | 変換の後の写真（メタデータなし） | SSE-S3 | 参照の数 0 で消す。`quarantine/` は措置から 1 年 | CRR |
| `records`（D-25） | `payments/inbox/<provider>/<yyyy>/<mm>/<dd>/<event_id>.json` | 署名を確かめた決済の Webhook の本文（カード番号を含まない形） | SSE-KMS `kms-core` | 13 か月 | CRR |
| 同 | `shipping/inbox/<carrier>/<yyyy>/<mm>/<dd>/<inbox_id>.json` | 住所の欄を落とした運送会社の本文 | `kms-core` | 13 か月 | CRR |
| 同 | `ledger/statements/<source>/<yyyy>/<mm>/<dd>/<file>` | 精算・銀行の明細・運送会社の請求の元のファイル（ハッシュは `external_statement_files`） | `kms-ledger` | 10 年（Object Lock のガバナンスのモード） | CRR |
| 同 | `payouts/zengin/<yyyy>/<mm>/<dd>/<batch_id>.txt` | 全銀の形式の総合振込のファイル（8.2 節） | `kms-ledger` | 10 年（同） | CRR |
| 同 | `archive/<cluster>/<table>/<yyyy-mm>/part-<n>.parquet` | 分割の表の古い区切りの写し（`journal_lines`、`transaction_events`、`listing_events`、`shipment_events`） | クラスタの鍵 | 表の保持（10 年） | CRR |
| `config` | `catalog/{catalog_version}.json`、`price-stats/{date}/{stats_version}.parquet`、`ts-rules/{rules_version}.json` | 設定の写しと価格の統計 | SSE-S3 | カタログ・規則は残す、価格の統計は 1 年 | CRR |
| `cases` | `{case_id}/{attachment_id}` | 紛争・問い合わせの写真と書類（メタデータを消した） | SSE-KMS `kms-content` | 案件の保持（3 年・10 年） | CRR |
| `ts-docs` | `{rights_holder_id}/{doc_id}` | 権利者の見分けの資料 | `kms-content` | 契約の終わりから 7 年 | CRR |
| `exports` | `{request_id}/…` | 法令の照会への回答などの書き出し | `kms-ops-exports` | 90 日 | 写さない |
| `opensearch-snapshots` | ドメインのスナップショット | 索引の写し | SSE-KMS | 14 日 | CRR |
| `ml-models` | `{model}/{version}/…` | 署名つきのモデル | SSE-KMS | 残す | CRR |
| log-archive の `audit` | `audit/<cluster>/<stream>/<yyyy>/<mm>/<dd>/<batch>.jsonl.gz` | 監査の事象の鎖つきの束（各行に `prev_hash`） | `kms-audit` | 7 年（Object Lock のコンプライアンスのモード） | CRR |

- `records` は、領域の文書の `payments/inbox/`・`shipping/inbox/`・`ledger/statements/`・`payouts/zengin/` の置き場所を 1 つのバケットにまとめたもの（D-25）。接頭辞ごとに KMS の鍵と書ける役割を分ける（バケットの政策）。
- `photos-incoming` の元の写真は、変換の後 24 時間で消す。審査で元が要るときは `large` を使う（[ADR-0012](../../decisions/0012-photo-pipeline-and-perceptual-hashes.md)）。

## 4. SNS・SQS と事象

### 4.1 事象の封筒

outbox の行（[ops.md](ops.md) の 2.1 節）を `relay` が次の JSON にして SNS に出す。

```json
{
  "id": "0192a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b",
  "topic": "transaction.completed",
  "schema_version": 1,
  "cluster": "core",
  "aggregate": { "type": "transaction", "id": "0192…", "version": 7 },
  "occurred_at": "2026-10-24T08:00:00.123Z",
  "trace_parent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  "payload": { "listing_id": "0192…", "seller_id": "0192…", "buyer_id": "0192…", "price": 3000, "fee_table_version": 7, "shipping_rate_table_version": 3 }
}
```

- SNS の話題はクラスタごとに 1 つ（`core-events`・`ledger-events`・`content-events`）。メッセージの属性 `topic` で、消費者のキューの購読が絞る（フィルターの政策）。
- 標準の SNS・SQS（少なくとも 1 回、順序の保証なし）。消費者は `id` で冪等にし、`aggregate.version` で古い事象を捨てる。
- 互換：欄を足すのは互換。欄の削除・意味の変更は新しい `schema_version` を両方出す（[delivery.md](../delivery.md) の 5.3 節）。

### 4.2 話題

| クラスタ | 話題 |
| --- | --- |
| core | `account.*`、`device.registered`・`device.revoked`・`device.push_token_changed`、`session.revoked`、`account.hold_started`、`kyc.level_changed`・`kyc.gates_changed`・`kyc.on_hold`、`listing.published`・`listing.updated`・`listing.price_changed`・`listing.price_dropped`・`listing.status_changed`・`listing.seller_tier_changed`、`photo.ready`、`catalog.published`、`transaction.created`・`paid`・`shipped`・`delivered`・`received`・`completed`・`cancelled`・`payment_expired`・`disputed`・`dispute_resolved`・`cancel_requested`、`payment.succeeded`・`payment.failed`・`payment.orphan_received`、`refund.completed`・`refund.failed`、`chargeback.opened`・`chargeback.closed`、`shipment.label_issued`・`accepted`・`delivered`・`exception`、`rating.published`・`rating.excluded`・`reputation.tier_changed`、`legal_hold.placed`・`released` |
| ledger | `ledger.proceeds_available`・`refund_due`・`payout_due`・`proceeds_expiring`・`recon_break`、`proceeds_hold.applied`・`released`、`payout.requested`・`settled`・`failed`・`returned`、`points.granted`・`expiring`、`legal_hold.placed`・`released` |
| content | `like.added`・`like.removed`、`listing.viewed`、`saved_search.changed`、`alert.digest_requested`、`comment.created`・`comment.deleted`、`transaction_message.created`、`abuse_filter.signal`、`moderation.action_applied`・`moderation.action_reversed`、`ts.case_opened`・`ts.photo_blocklist_changed`・`ts.rules_changed`、`case.opened`・`resolved`・`closed`、`legal_hold.placed`・`released` |

- `fraud_signals`（端末・ログインの兆し）は core の `account.*` の事象の一部として出す（[accounts-and-devices.md](../accounts-and-devices.md) の 7.4 節）。

### 4.3 キュー

| キュー | 購読（話題） | 消費者 | 備考 |
| --- | --- | --- | --- |
| `media-process` | S3 の `photos-incoming` の作成の通知 | `media-processor` | — |
| `search-index` | `listing.*`（下を除く）、`reputation.tier_changed`、`catalog.published` | `search-indexer` | 最古の年齢 5 秒で警告 |
| `search-index-priority` | `listing.status_changed`（措置・売り切れ・停止・削除・取引中）、`moderation.action_applied` | `search-indexer`（優先のタスク） | `vis:*` を先に書く |
| `saved-search-match` | `listing.published`、`listing.price_dropped` | `saved-search-matcher` | — |
| `ts-screen` | `listing.published`・`listing.updated`、`photo.ready`、`comment.created`、`rating.published`、`abuse_filter.signal`、`chargeback.opened` | `trust-safety`（非同期の段） | — |
| `ts-actions` | `moderation.action_applied`・`reversed` | `listings`・`identity`・`messaging`・`ratings`・`ledger`（保留の依頼）・`transactions`（取り消しの依頼）の適用の消費者 | 消費者ごとに別のキュー（`ts-actions-<service>`） |
| `ledger-in` | `transaction.created`・`paid`・`completed`・`cancelled`・`dispute_resolved`、`chargeback.*`、`payment.orphan_received` | `ledger` | 仕訳の冪等キーで 1 回 |
| `payments-in` | `ledger.refund_due` | `payments` | — |
| `shipping-in` | `transaction.created`・`cancelled`・`dispute_resolved`、`legal_hold.*` | `shipping` | 住所の写し、受け付けの取り消し |
| `ntf-security`・`ntf-transactional`・`ntf-engagement`・`ntf-announcement` | 通知の種類の一覧（[notifications.md](../notifications.md) の 4.2 節） | `notifier-decide` | 級ごとに消費者のプールを分ける |
| `kyc-inbox` | eKYC の Webhook の受け口 | `identity` | 9 節 |
| `payment-inbox`・`carrier-inbox` | 各受け口 | `payments`・`shipping` | inbox の表の行の ID だけを運ぶ |
| 各 `*-dlq` | — | 運用 | 4 日（SQS の保持の最大は 14 日。DLQ は 14 日） |

- メッセージの保持は 4 日（OpenSearch の停止の後に流し直せる長さ。[search-and-discovery.md](../search-and-discovery.md) の 8 節）。

### 4.4 データレイクへの写し

- outbox の事象を data のアカウントへ写す。写す前に、V の欄と P の本文の欄（型で印を付けた欄）を落とし、利用者の ID をレイクの鍵（`kms-lake` で包む、年ごとに替える）の HMAC に置き換える（[ADR-0071](../../decisions/0071-data-classes-and-lifecycle.md)）。元の ID へ戻す表は持たない。保持は 2 年。

## 5. プッシュとメールの中身

### 5.1 APNs

```json
{
  "aps": {
    "alert": { "title-loc-key": "TXN_PURCHASED_TITLE", "loc-key": "TXN_PURCHASED_BODY", "loc-args": ["ニットのカーディガン"] },
    "thread-id": "t:3f9a1c",
    "sound": "default",
    "mutable-content": 1
  },
  "k": "txn.purchased",
  "r": "0191f6c0-7b2e-7c11-9a0e-2c4d5e6f7a8b",
  "n": "0191f6c1-02aa-7d3e-8b1f-9c0d1e2f3a4b"
}
```

### 5.2 FCM（HTTP v1 の `message`）

```json
{
  "token": "<device push token>",
  "android": { "collapse_key": "t:3f9a1c", "priority": "high" },
  "data": {
    "k": "txn.purchased",
    "r": "0191f6c0-7b2e-7c11-9a0e-2c4d5e6f7a8b",
    "n": "0191f6c1-02aa-7d3e-8b1f-9c0d1e2f3a4b",
    "loc_key": "TXN_PURCHASED_BODY",
    "loc_args": "[\"ニットのカーディガン\"]"
  }
}
```

### 5.3 許可の一覧（[ADR-0063](../../decisions/0063-notification-kinds-lanes-and-payload.md)）

| 欄 | 中身 | 上限 |
| --- | --- | --- |
| `k` | 種類のコード | — |
| `r` | 対象の ID（取引・出品・保存した検索・措置・振込） | UUID |
| `n` | 通知の ID | UUID |
| `thread-id`・`collapse_key` | まとめの鍵の HMAC（利用者ごとの鍵）の先頭 6 文字。取引の ID をそのまま入れない | 8 文字 |
| `loc-args` の要素 | 出品の題名、価格（前と後）、相手のニックネーム、件数、期限の日時 | 題名は 40 文字で切る |

- 入れない：メッセージ・コメントの本文、住所、本名、電話番号、メールアドレス、売上金・残高・ポイントの残高、振込の額、口座、本人確認の状態、措置の詳しい理由。
- 大きさ 2 KB 以下。`notifier-send` が Zod の型で検査し、知らない欄があれば送らない（PROP-NTF-002）。
- メール：宛先は確認済みのアドレスだけ。本文はプッシュの許可の一覧に加えて、本人の取引の金額（代金、手数料、送料、売上金の増分）と本人の振込の額。残高そのもの、住所、本名、電話番号、口座の番号、本人確認の情報、ログインの鍵を含むリンクは入れない。差出人は取引と安全が `mail.<brand>.<domain>`、案内が `news.<brand>.<domain>`。

## 6. OpenSearch

### 6.1 `listings_v<n>`（別名 `listings`）

[ADR-0018](../../decisions/0018-search-index-layout-and-japanese-analysis.md)。文書は出品ごとに 1 つ、`_id` は `listing_id`、`version_type = external_gte` で `listings.version` を外部のバージョンにする。

```json
{
  "settings": {
    "number_of_shards": 8, "number_of_replicas": 1, "refresh_interval": "1s",
    "analysis": {
      "char_filter": {
        "long_vowel_map": { "type": "mapping", "mappings": ["〜=>ー", "～=>ー", "－=>ー"] },
        "zero_width_strip": { "type": "pattern_replace", "pattern": "[\\u200B-\\u200D\\uFEFF]", "replacement": "" }
      },
      "tokenizer": {
        "sudachi_c": { "type": "sudachi_tokenizer", "split_mode": "C", "settings_path": "sudachi.json" },
        "sudachi_b": { "type": "sudachi_tokenizer", "split_mode": "B", "settings_path": "sudachi.json" },
        "bigram": { "type": "ngram", "min_gram": 2, "max_gram": 2, "token_chars": ["letter", "digit"] }
      },
      "filter": { "hira_kata": { "type": "icu_transform", "id": "Hiragana-Katakana" } },
      "analyzer": {
        "ja_c": { "char_filter": ["icu_normalizer", "long_vowel_map", "zero_width_strip"], "tokenizer": "sudachi_c",
                  "filter": ["sudachi_normalizedform", "sudachi_part_of_speech", "sudachi_ja_stop", "lowercase"] },
        "ja_b": { "char_filter": ["icu_normalizer", "long_vowel_map", "zero_width_strip"], "tokenizer": "sudachi_b",
                  "filter": ["sudachi_normalizedform", "sudachi_part_of_speech", "sudachi_ja_stop", "lowercase"] },
        "ja_bigram": { "char_filter": ["icu_normalizer"], "tokenizer": "bigram", "filter": ["hira_kata", "lowercase"] }
      },
      "normalizer": { "brand_norm": { "type": "custom", "char_filter": ["icu_normalizer"], "filter": ["lowercase", "hira_kata"] } }
    }
  },
  "mappings": {
    "dynamic": "strict",
    "_source": { "excludes": ["description"] },
    "properties": {
      "listing_id":     { "type": "keyword" },
      "seller_id":      { "type": "keyword" },
      "status":         { "type": "keyword" },
      "vis":            { "type": "keyword" },
      "sentinel":       { "type": "boolean" },
      "mod_flags":      { "type": "keyword" },
      "title":          { "type": "text", "analyzer": "ja_c",
                          "fields": { "b": { "type": "text", "analyzer": "ja_b" }, "bigram": { "type": "text", "analyzer": "ja_bigram" } } },
      "description":    { "type": "text", "analyzer": "ja_c" },
      "brand_id":       { "type": "keyword" },
      "brand_text":     { "type": "keyword", "normalizer": "brand_norm",
                          "fields": { "ja": { "type": "text", "analyzer": "ja_c" } } },
      "category_id":    { "type": "keyword" },
      "category_path":  { "type": "keyword" },
      "category_names": { "type": "text", "analyzer": "ja_c" },
      "price":          { "type": "integer" },
      "condition":      { "type": "keyword" },
      "shipping_payer": { "type": "keyword" },
      "shipping_method":{ "type": "keyword" },
      "ship_days":      { "type": "keyword" },
      "published_at":   { "type": "date" },
      "sold_at":        { "type": "date" },
      "like_count":     { "type": "integer" },
      "seller_tier":    { "type": "keyword" },
      "photo_quality":  { "type": "half_float" },
      "thumb":          { "type": "keyword", "index": false },
      "version":        { "type": "long" }
    }
  }
}
```

- 欄 `shipping_method`・`ship_days` は、`listings.shipping_method_code`・`ship_days_code` の値を入れる（索引の欄の名前は [search-and-discovery.md](../search-and-discovery.md) の 4.2 節のまま）。`thumb` は表紙の写真の `object_id`。
- `brand_norm` は `normalizeBrandText` と同じ規則を ICU と自前の対応表で組む（ここの normalizer は骨組み。規則の全部は `search-index-poc` で組んで確かめる）。`sentinel` は見張りの出品を検索の段で外すための欄（[search-and-discovery.md](../search-and-discovery.md) の 5.4 節）。
- 保存したスクリプト `ranking_v1`（Painless）：`rescore` の `script_score` で `fresh × pop × seller × photo` を掛ける（[ADR-0019](../../decisions/0019-ranking-formula-v1.md)）。式を変えるときは `ranking_v2` を足す。
- S2 は `listings_active`・`listings_sold` に分ける。形は同じ。

### 6.2 `photo_hashes`

[ADR-0013](../../decisions/0013-photo-reuse-index.md)。文書は写真ごと（`_id` は `photo_id`）。範囲は `on_sale`・`trading`・売れてから 90 日の `sold`。

```json
{
  "settings": { "number_of_shards": 4, "number_of_replicas": 1 },
  "mappings": {
    "dynamic": "strict",
    "properties": {
      "photo_id":       { "type": "keyword" },
      "listing_id":     { "type": "keyword" },
      "seller_id":      { "type": "keyword" },
      "phash":          { "type": "long" },
      "dhash":          { "type": "long" },
      "b0":             { "type": "keyword" },
      "b1":             { "type": "keyword" },
      "b2":             { "type": "keyword" },
      "b3":             { "type": "keyword" },
      "listing_status": { "type": "keyword" },
      "created_at":     { "type": "date" }
    }
  }
}
```

- `b0`〜`b3` は pHash の 16 ビットずつの帯（16 進 4 文字）。引き方は 4 つの `term` の `should` と、`script` の絞り込み `Long.bitCount(phash ^ q) <= 6`。
- 禁止の写真のハッシュの一覧（`ts_photo_blocklist`）は OpenSearch に入れず、`trust-safety` のタスクのメモリーに 8 つの 8 ビットの帯の索引を持つ（[ADR-0054](../../decisions/0054-photo-hash-block-list.md)）。

## 7. 保存した検索の逆索引の形

[ADR-0022](../../decisions/0022-saved-search-match-keys-and-inverted-index.md)。正本は content の `saved_search_keys`（[search-and-saved-searches.md](search-and-saved-searches.md) の 2.6 節）、写しは Valkey の `ss:k:{match_key}:{shard}`。

| 鍵 | 形 | 例 |
| --- | --- | --- |
| カテゴリ × ブランド | `cb:{category_id}:{brand_id}` | `cb:1203:88` |
| ブランド | `b:{brand_id}` | `b:88` |
| カテゴリ | `c:{category_id}` | `c:1203` |
| 語 | `t:{語}`（`ja_b` の正規化した形） | `t:未開封` |

**`packed`（MessagePack の配列、平均 100 バイト）**

| 位置 | 欄 | 型 | 意味 |
| --- | --- | --- | --- |
| 0 | `v` | int | 形のバージョン（1） |
| 1 | `user` | bin(16) | `user_id` |
| 2 | `cat` | int か nil | カテゴリ（どの階層でも） |
| 3 | `brands` | int の配列 | ブランド（0〜5） |
| 4 | `pmin` | int か nil | 価格の下限 |
| 5 | `pmax` | int か nil | 価格の上限 |
| 6 | `cond` | int（ビットの集合） | 状態の 6 段 |
| 7 | `payer` | int | 0 指定なし、1 売り手、2 買い手 |
| 8 | `methods` | int の配列 | 配送の方法のコードの番号 |
| 9 | `terms` | 配列の配列 | 語ごとに `[h(C の語), [h(B の語)…]]`。`h` は語の 64 ビットのハッシュ（xxHash64） |
| 10 | `active_from` | int | 有効になった時刻（エポックのミリ秒） |
| 11 | `push` | bool | プッシュの有効（期限の切れたものは偽） |

- 出品の側の語も同じハッシュにして集合にし、5.1 節の一致の定義を数の比べで当てる。ハッシュの衝突（2⁻⁶⁴ 程度）は夜間の比べ（`saved-search-ref`、語の文字で判定）で見つける。
- 1 つの鍵の件数が 2,000 を超えたら `ss:ks` を倍にし、`ss_id` のハッシュで振り直す。変更のたびに `ss:kv` を 1 上げる。

## 8. 運送会社と銀行の形式

### 8.1 運送会社の正規の事象

`parseWebhook` と `getTracking` は、運送会社の形を次の正規の事象に写す（[ADR-0042](../../decisions/0042-carrier-event-ranking-and-implied-acceptance.md)）。住所の欄は写さない。生の本文は住所の欄を落としてから `records` に置く。

```json
{
  "carrier": "ymt",
  "carrier_event_id": "E-20261013-000123",
  "reception_no": "R1234567890",
  "tracking_no": "4912-3456-7890",
  "event": "in_transit",
  "occurred_at": "2026-10-13T08:00:00+09:00",
  "detail_code": "carrier specific code"
}
```

- `event` は `label_created`・`accepted`・`in_transit`・`out_for_delivery`・`delivered`（順位 0〜4）と、例外の `held_at_office`・`returned_to_sender`・`lost`・`damaged`・`refused`。写せない状態は inbox に入れず、率でアラートを出す。
- 重複の鍵：`carrier_event_id` があればそれ、なければ `sha256(tracking_no | event | occurred_at)`。
- 運送会社の API の形（署名、事象の ID の有無）は契約の前で**未検証**（E11 の `carrier-selection`）。

### 8.2 全銀の形式の総合振込のファイル

提携銀行の API が使えないときの予備（[ADR-0038](../../decisions/0038-payout-batching-execution-and-failure-handling.md)）。120 バイトの固定長、ヘッダー・データ・トレーラ・エンドの 4 種類のレコード、全銀の使用文字（半角カナ・英数・一部の記号）。全体の形は Stripe の題材の [payouts-and-reconciliation.md](../../../../stripe/docs/architecture/payouts-and-reconciliation.md) の 4.1 節で確かめた範囲。**下の項目の位置と桁は一般的な総合振込の形で書いたもので、提携銀行の仕様書で確かめる（未検証）**。

**ヘッダー（データ区分 1）**

| 項目 | 桁 | 値 |
| --- | --- | --- |
| データ区分 | 1 | `1` |
| 種別コード | 2 | `21`（総合振込） |
| コード区分 | 1 | `0`（JIS） |
| 振込依頼人コード | 10 | 銀行が付ける番号 |
| 振込依頼人名 | 40 | `<Brand>`（全銀の使用文字） |
| 取組日 | 4 | `MMDD` |
| 仕向金融機関番号・名 | 4・15 | 払出口座の銀行 |
| 仕向支店番号・名 | 3・15 | |
| 預金種目（依頼人） | 1 | |
| 口座番号（依頼人） | 7 | |
| ダミー | 17 | 空白 |

**データ（データ区分 2。振込 1 件に 1 行）**

| 項目 | 桁 | 値（元の列） |
| --- | --- | --- |
| データ区分 | 1 | `2` |
| 被仕向金融機関番号・名 | 4・15 | `bank_accounts.bank_code`、`bank_master.bank_name_kana` |
| 被仕向支店番号・名 | 3・15 | `branch_code`、`branch_name_kana` |
| 手形交換所番号 | 4 | 空白 |
| 預金種目 | 1 | `account_type`（1 普通、2 当座、4 貯蓄） |
| 口座番号 | 7 | 復号した口座番号（`payouts` の役割のメモリーの中だけ） |
| 受取人名 | 30 | 復号した名義（カナ） |
| 振込金額 | 10 | `payouts.transfer_amount` |
| 新規コード | 1 | `0` |
| EDI 情報 | 20 | `payouts.payout_ref` |
| 振込指定区分 | 1 | `7`（電信） |
| 識別表示 | 1 | `Y`（EDI 情報を使う） |
| ダミー | 7 | 空白 |

**トレーラ（データ区分 8）**：合計件数 6 桁（`payout_batches.item_count`）、合計金額 12 桁（`total_amount`）、ダミー 101。**エンド（データ区分 9）**：ダミー 119。

- ファイルは `records` の `payouts/zengin/…` に置き、SHA-256 を `payout_batches.file_sha256` に持つ。ログに口座番号と名義を出さない。
- 銀行の明細（入出金取引明細）は API か全銀協規定形式（200 バイト）で取り込み、`external_statement_lines` に写す。EDI 情報の `payout_ref` で出金と組戻しを突き合わせる（照合 E3）。どの項目を各行が埋めるかは**未検証**。

## 9. 提供者のコールバック

どの提供者の Webhook も、署名と時刻（5 分の内）を確かめ、inbox の表に一意の鍵で 1 回だけ入れ、中身を信じずに照会の結果で状態を進める（[ADR-0005](../../decisions/0005-payments-via-providers-and-capture-at-purchase.md)、[ADR-0056](../../decisions/0056-ekyc-provider-and-verification-levels.md)）。

| 提供者 | 受け口 | inbox の表と一意の鍵 | 取り出す欄 | 照会 | 本文の保存 |
| --- | --- | --- | --- | --- | --- |
| 決済 | `POST /hooks/payments/{provider}` | `payment_inbox (provider, provider_event_id)` | 事象の種類、参照の番号（試行の ID） | `getPayment`・`getRefund` | `records` の `payments/inbox/…`（カード番号を含まない形だけ） |
| 運送会社 | `POST /hooks/carriers/{carrier}` | `carrier_inbox (carrier, dedup_key)` | 8.1 節の正規の事象 | `getTracking` | 住所の欄を落として `records` の `shipping/inbox/…` |
| eKYC | `POST /hooks/kyc/{provider}` | `kyc_inbox (provider, event_id)` | `provider_session_ref`、事象の種類だけ | `getResult(provider_session_ref)` | 保存しない（属性と画像の参照を含みうるため） |

**eKYC の正規の結果（`getResult` の後、`applyKycResult` の入力）**

```json
{
  "provider_session_ref": "ps_7f3a…",
  "result": "approved",
  "method": "ic_chip",
  "reason_code": null,
  "attributes": { "name": "…", "name_kana": "…", "birth_date": "…", "address": "…", "document_type": "…" }
}
```

- `result` は `approved`・`rejected`・`needs_review`・`pending`。`attributes` はメモリーの中で `kyc_records.attributes_ct` に暗号化し、指紋（`kyc_fingerprints`）を作ったら捨てる。ログに出さない（PROP-KYC-003）。

## 10. AppConfig

| 構成 | 値 | 持ち主 | 備考 |
| --- | --- | --- | --- |
| `release` | `release.price-suggestion-display`、`release.business-seller-flag`、`release.offers`（MVP の後） | 各領域 | kebab-case。100% の後 30 日で消す |
| `ops` | `ops.purchase_enabled`（全体・カテゴリ・出品）、`ops.payouts_enabled`、`ops.carrier_enabled.<carrier>`、`ops.payment_method_enabled.<method>`、`ops.fanout_enabled`、`ops.saved_search_digest_minutes`（3）、`ops.sms_provider`、`ops.search_degraded_mode`、`ops.app_min_version_ios`・`_android`、`ops.app_force_version_ios`・`_android` | Ops | [runbooks/README.md](../../runbooks/README.md) の 2 節 |
| `config` | `fees.table`（新しい取引に使う `fee_tables.version`）、`shipping.rate_table`（同 `shipping_rate_tables.version`）、`search.sold_retention_days`（365）、`alerts.max_push_per_day`（20）、`kyc.provider.{method}`（開く機能の表の正本は `kyc_gates`） | 各領域 | 表の正本は Aurora。AppConfig は今のバージョンの番号だけ（D-26） |
| `models`・`rules` | `models.<name>.active_version`・`rollout_percent`、`rules.<set>.active_version` | data・T&S | [delivery.md](../delivery.md) の 7 節 |
| `legal`（別のアプリケーション） | 10.1 節 | 法務・財務（CODEOWNERS） | 値は `config/legal/<env>.json`（`value`・`effective_from`・`approval_ref`）。変更は `legal_config_changes` に記録（[ADR-0078](../../decisions/0078-pipeline-schema-ordering-ledger-migrations-and-flag-governance.md)） |

### 10.1 `legal.*` の値

どれも法務の確認待ちで、本番の既定は無効・未設定（[ADR-0004](../../decisions/0004-proceeds-model-under-payment-services-act.md)、ADR-0078）。本番の既定から変える PR は、`approval_ref` が法務と財務の 2 人の承認の記録（L の番号つき）を指していなければ CI が失敗にする。

| 値 | 型 | 開発・検証 | 本番の既定 | L | 使う所 |
| --- | --- | --- | --- | --- | --- |
| `legal.proceeds_expiry_enabled` | bool | true | **false** | L1 | `proceeds_lots.expires_at` |
| `legal.proceeds_expiry_days` | int | 180 | 未設定 | L1 | 同上 |
| `legal.proceeds_expiry_actions` | 配列 | `[auto_payout, auto_payout, forfeit]` | 未設定 | L1 | `proceeds_expiry_state` |
| `legal.proceeds_forfeit_enabled` | bool | true | **false** | L1 | 型 20 |
| `legal.proceeds_spendable` | bool | true | **false** | L1 | `reserve` |
| `legal.proceeds_expiry_notice_days` | 配列 | `[30, 7, 1]` | 未設定 | L1 | 通知 |
| `legal.proceeds_to_points_enabled` | bool | false | **false** | L1 | 型を足すまで作らない |
| `legal.balance_enabled` | bool | true | **false** | L1 | 型 19、`user_balance` |
| `legal.balance_requires_kyc_level` | text | `verified_document` | 未設定 | L1・L2 | 型 19 |
| `legal.balance_max_yen` | int | 1,000,000 | 未設定 | L1 | `user_balance` の上限 |
| `legal.balance_spend_limit_yen.{level}` | int | 仮の値 | 未設定 | L1・L2 | `reserve` |
| `legal.points_expiry_enabled` | bool | true | **false** | L1・L4 | 型 18 |
| `legal.payout_limit_yen.{level}` | int | `unverified` 100,000、`verified_*` 1,000,000 | 未設定 | L2 | `payouts` |
| `legal.payout_monthly_limit_yen.{level}` | int | 仮の値 | 未設定 | L2 | `payouts` |
| `legal.kyc_provider_retention_days` | int | 仮の値 | 未設定 | L2・L5 | 提供者の設定 |
| `legal.kyc_reverify_days` | int | 未設定 | 未設定 | L2 | 再確認 |
| `legal.business_seller_*` | 閾値 | 30 日 50 件・365 日 100 万円 | 無効 | L3 | `seller_business_signals` |
| `legal.stolen_goods_*` | 期間 | 仮の値 | 未設定 | L6 | `legal_cases` |
| `legal.platform_request_*` | 期限 | 仮の値 | 未設定 | L7 | `legal_cases` |
| `legal.takedown_*` | 期限・通知 | 仮の値 | 未設定 | L9 | `legal_cases` |
| `legal.message_scan_mode` | text | `send_time_pattern_and_classifier` | `send_time_pattern` を用意（有効は L11 の後） | L11 | 絞り込み |
| `legal.minor_purchase_limit_yen`・`legal.minor_payout_limit_yen` | int | 未設定 | 未設定（制限なし） | L12 | `purchaseListing`・`payouts` |

- 仕訳は、期限・移し替え・失効・期限の後の自動の振込に、そのとき使った `legal` の構成のバージョン（`journals.legal_config_version`）を記録する。値を戻しても過去の仕訳は書き換えない。

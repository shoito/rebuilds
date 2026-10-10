# Data model: Aurora の外の置き場所

Valkey の鍵、空室の写しと料金の写しの二進の形、S3 のバケットとキー、OpenSearch の対応表、SNS・SQS と事象の封筒、iCal の形、通知の中身、Webhook の本文、AppConfig の値（`legal.*` の全部）、データレイク。どれも正本ではない（正本は Aurora の表）。失ってよいものと、失えないもの（S3 の `registry`・`records`、log-archive の監査）を分けて書く。規約は [data-model.md](../data-model.md) の 3 節。

## 1. Valkey の鍵

クラスタモード。S1 は 2 シャード × 主 1・写し 1。鍵のハッシュの札 `{…}` でシャードを決める。どの鍵も失ってよい（正本にしない）。名前の正本はこの表（[README.md](../README.md) の 6 節の「名前の揃え」）。

| 鍵 | 中身 | 期限 | 書き手 | 失ったとき |
| --- | --- | --- | --- | --- |
| `avail:{listing_id}` | 空室の写し（2 節の二進の形。平均 250 バイト） | なし（毎日 0 時の後に作り直す） | `availability-cache-writer`（Lua で `calendar_version` が大きいときだけ） | ステージ 2 を core の読み出しの写しへ迂回 |
| `prc:{listing_id}` | 料金の写し（2.3 節。約 3.1 KB） | なし | 同上（`pricing_version` で比べる） | 同上 |
| `qs:{listing_id}:{ci}:{co}:{guests}:{pricing_version}` | 料金の要約（総額、リスティングの通貨） | 10 分 | `search-api` | 計算し直す |
| `ss:{search_id}` | 検索の結果の列（ID と選んだ日程） | 10 分 | `search-api` | 検索し直す |
| `quote:{quote_id}` | 見積もりの写し（正本は `quotes`） | 15 分 | `pricing` | core から読む |
| `claim:{listing_id}:{check_in}` | 熱い日付の先着の印（値は試みの ID） | 15 秒（`SET NX PX 15000`） | `booking` | リスティングごとの同時実行の上限 4 で DB へ |
| `idem:{guest_id}:{key}` | 同じ冪等キーの合流 | 60 秒 | `booking` | DB の一意で 1 回に収まる |
| `sess:{token_hash}` | セッションの写し（利用者、端末、強さ、ログインの時刻、ホストのアカウントの成員の一覧） | 15 分 | `identity` | core の読み出しの写し |
| `pmstok:{hash}` | PMS のトークンの写し（同意、範囲、リスティングの集合） | 60 秒 | `partner-api` | core の読み出しの写し |
| `vel:{kind}:{key}` | T&S の速さの数（端末、支払いの手段、IP の帯ごとの仮押さえ・見積もり・失敗） | 窓の長さ | `trust-safety`、`booking` | 数え直す（信号が一時に弱まる） |
| `rl:api:{actor}`、`rl:pms:{app_id}:{host_account_id}`、`rl:pms:{app_id}`、`rl:otp:{target_hmac}`、`rl:otp_ip:{ip_prefix}` | 速さの上限のトークンバケット | 窓の長さ | 各入口 | タスクごとの上限で絞る（緩めない） |
| `thread:{thread_id}`（pub/sub） | メッセージの更新の合図 | — | `messaging` | 端末が引き直す |
| `sms:{user_id}:{day}` | SMS の 1 人 1 日 10 通の数え | 1 日 | `notifier` | 数え直す |

- 値に個人のデータ（住所、連絡先、氏名）を入れない。`sess:` の成員の一覧は ID だけ。

## 2. 空室の写しと料金の写しの形

[ADR-0025](../../decisions/0025-availability-snapshot-layout.md) の形を、バイトの位置で決める。数は小さい端（little endian）。

### 2.1 `avail:{listing_id}` の見出し（32 バイト）

| 位置 | 大きさ | 中身 |
| --- | --- | --- |
| 0 | 1 | 形式の番号（`1`） |
| 1 | 1 | 予約（0） |
| 2 | 8 | `calendar_version`（u64） |
| 10 | 2 | 基準の日（物件の現地の今日の月の初め。1970-01-01 からの日数、u16） |
| 12 | 2 | タイムゾーンの番号（`packages/stay-time` の表の索引、u16） |
| 14 | 1 | 予約できる期間（月） |
| 15 | 1 | 準備の日（0〜2） |
| 16 | 1 | 最短の泊数の既定 |
| 17 | 1 | 最長の泊数の既定 |
| 18 | 1 | チェックインの曜日の印（ビット 0 = 月 … ビット 6 = 日） |
| 19 | 1 | チェックアウトの曜日の印 |
| 20 | 1 | 締め切りの種類（0 = 当日の時刻、1 = N 日前の時刻） |
| 21 | 1 | 締め切りの日数（0〜7） |
| 22 | 2 | 締め切りの現地の時刻（0 時からの分、u16） |
| 24 | 2 | チェックインの開始の現地の時刻（分、u16） |
| 26 | 1 | 定員 |
| 27 | 1 | 予約（0） |
| 28 | 4 | 見出しの後の本体の CRC32 |

### 2.2 `avail:` の本体

| 部分 | 大きさ | 中身 |
| --- | --- | --- |
| 泊のビット列 | 96 バイト | 768 ビット。ビット `i`（バイト `i >> 3` の、下の桁から `i & 7` 番目）は基準の日 + `i` の夜が有効な `block_span` で埋まっているか（1 が埋まり）。準備の日を含む |
| 上書きの数 | 2 バイト | u16（256 まで） |
| 上書き | 6 バイト × 数 | 基準の日からの日数（u16）、最短の泊数（u8、0 は上書きなし）、最長の泊数（u8、0 は上書きなし）、予約（2） |

- 滞在 `[ci, ci + n)` は、ビット `ci − base` から `ci − base + n + p − 1`（`p` は準備の日）がすべて 0 なら空いている。窓の終わりを越えるビットは 0 と見る（[search-and-ranking.md](../search-and-ranking.md) の 5.3 節）。
- 例：基準の日 2026-12-01、準備の日 1、12-30 から 3 泊。ビット 29・30・31・32 がすべて 0 なら候補。予約の `hold [12-30, 01-02)` が入ると、写しの書き直しでビット 29〜32 が 1 になる（`block_span [12-30, 01-03)`）。
- 平均 32 + 96 + 2 + 上書き 20 × 6 = 250 バイト。S1 の 10 万件で 25 MB。

### 2.3 `prc:{listing_id}`

| 部分 | 大きさ | 中身 |
| --- | --- | --- |
| 見出し | 32 バイト | 形式の番号、`pricing_version`（u64）、基準の日（u16）、通貨（3 バイトの ASCII）、清掃料（u32）、追加のゲストの料金（u32）、含む人数（u8）、ペットの料金（u32）、週・月の割引（u8 × 2） |
| 泊の料金 | 4 バイト × 761 | 基準の日からの夜ごとの解決した 1 泊の料金（u32。優先の順を当てた後） |
| 税の区域 | 2 バイト ＋ 16 バイト × 数 | `tax_zone_ids` |

- 検索の目安だけに使う。見積もり（`quoteStay`）は core から読む（[pricing-and-fees.md](../pricing-and-fees.md) の 5 節）。

## 3. S3

| バケット | キー | 暗号化 | 保持・写し | 中身 |
| --- | --- | --- | --- | --- |
| `photos-incoming` | `<photo_id>` | SSE-KMS（`kms-core`） | 1 日（ライフサイクル）。大阪に写さない | 受け付けた元の写真（位置情報を消す前） |
| `photos` | `p/<photo_id>/<width>.<ext>`、`u/<object_id>/<width>.<ext>`（プロフィールの写真） | SSE-S3 | リスティングの削除から 90 日。大阪へ写す（CRR） | 変換した写真（`img.<brand>.<domain>` の元） |
| `message-attachments` | `a/<attachment_id>/<width>.<ext>` | SSE-KMS（`kms-content`） | スレッドの `retain_until` まで | メッセージの画像（メタデータを消した後） |
| `ical-exports` | `<listing_id>/<calendar_version>.ics` | SSE-KMS（`kms-core`） | 7 日。大阪へ写す | 書き出しの写し（6.2 節） |
| `registry` | `<property_id>/<fiscal_year>/<entry_id>/<n>` | 主体の鍵の封筒の暗号化 ＋ SSE-KMS（`kms-vault-storage`）。Object Lock なし | 年度の鍵の破棄で読めなくなる。大阪へ写す | 旅券の画像。署名つきの URL を出さない |
| `regulatory-docs` | `<property_id>/<document_id>` | SSE-KMS（`kms-core`） | 届出住宅と同じ | 届出の受理の通知、許可書 |
| `reports` | `minpaku/<property_id>/<period>.csv`、`statements/<host_account_id>/<YYYY-MM>.{pdf,csv}` | SSE-KMS（`kms-core`・`kms-ledger`） | 定期報告 5 年、明細 10 年 | 定期報告の補助の書き出し、ホストの明細 |
| `claims` | `<claim_id>/<evidence_id>` | SSE-KMS（`kms-core`） | `legal.claim_evidence_retention_days` | 損害の請求の証拠 |
| `bulk` | `<host_account_id>/<job_id>.jsonl`、`<host_account_id>/<job_id>.result.jsonl` | SSE-KMS（`kms-core`） | 7 日 | 一括のジョブの入力と結果 |
| `exports` | `<request_id>/<export_id>`、`incoming/<request_id>/…` | SSE-KMS（`kms-ops-exports`） | 7 日（照会の書類は 10 年） | 照会への回答の書き出し |
| `records` | `payments/inbox/<provider>/<yyyy>/<mm>/<dd>/<event_id>.json`、`statements/<source>/<statement_date>/<file_id>`、`bank/zengin/<business_day>/<batch_id>.txt`、`partitions/<cluster>/<table>/<yyyy-mm>.parquet` | 接頭辞ごとの SSE-KMS（`kms-core`・`kms-ledger`） | 10 年 | inbox の本文、外部の明細、全銀の形式のファイル、古い区切りの写し |
| `opensearch-snapshots` | OpenSearch の形 | SSE-KMS | 1 時間ごと、14 日。大阪へ写す | 索引のスナップショット |
| `ml-models` | `<model>/<version>/…` | SSE-KMS | モデルの登録簿の規則 | 推論のモデル |
| log-archive の `audit` | `audit/<stream>/<yyyy>/<mm>/<dd>/<batch>.jsonl.gz` | SSE-KMS（`kms-audit`）、Object Lock（コンプライアンスのモード） | 7 年 | 鎖つきの監査の束 |

- バケットの名前は D-10 で揃えた（領域の文書の `listing-uploads`・`listing-photos`・`ical-export` を直した）。
- 個人のデータを含むバケット（`message-attachments`・`registry`・`claims`・`exports`・`records`）は、バケットの政策で持ち主のサービスの役割だけに読み書きを許す。

## 4. OpenSearch

### 4.1 `listings_v<n>`（別名 `listings`）

文書はリスティングごとに 1 つ、ID は `listing_id`。`version_type=external_gte`、`version=search_version` で書く。`listingVisible()` の行 3〜9 で `hidden` の件は入れない。正確な位置を入れない。

```json
{
  "mappings": {
    "dynamic": "strict",
    "properties": {
      "search_version":   { "type": "long" },
      "calendar_version": { "type": "long" },
      "approx_point":     { "type": "geo_point" },
      "municipality_code":{ "type": "keyword" },
      "stay_ranges":      { "type": "date_range", "format": "yyyy-MM-dd" },
      "month_runs":       { "type": "nested", "properties": {
                              "month":   { "type": "integer" },
                              "max_run": { "type": "short" } } },
      "price_bands":      { "type": "nested", "properties": {
                              "month":       { "type": "integer" },
                              "nightly_min": { "type": "integer" },
                              "nightly_max": { "type": "integer" } } },
      "max_guests":       { "type": "short" },
      "bedrooms":         { "type": "short" },
      "beds":             { "type": "short" },
      "bathrooms":        { "type": "half_float" },
      "property_type":    { "type": "keyword" },
      "room_type":        { "type": "keyword" },
      "amenities":        { "type": "keyword" },
      "instant_book":     { "type": "boolean" },
      "min_nights_floor": { "type": "short" },
      "rank_static":      { "type": "float" },
      "rank_q":           { "type": "float" },
      "rank_c":           { "type": "float" },
      "rank_h":           { "type": "float" },
      "rank_d":           { "type": "float" },
      "rank_m":           { "type": "float" },
      "original_langs":   { "type": "keyword" },
      "title_ja":         { "type": "text", "analyzer": "ja_sudachi" },
      "title_ja_mt":      { "type": "text", "analyzer": "ja_sudachi" },
      "title_en":         { "type": "text", "analyzer": "standard" },
      "title_en_mt":      { "type": "text", "analyzer": "standard" },
      "description_ja":   { "type": "text", "analyzer": "ja_sudachi" },
      "host_account_id":  { "type": "keyword" },
      "sentinel":         { "type": "boolean" },
      "review_count":     { "type": "integer" },
      "review_avg":       { "type": "half_float" },
      "cover_photo_id":   { "type": "keyword" },
      "currency":         { "type": "keyword" }
    }
  }
}
```

- 言語ごとの欄は `title_{lang}`・`description_{lang}` と機械翻訳の `_mt`（`zh-Hans`・`zh-Hant`・`ko` は ICU）。上の例は代表だけ。
- `stay_ranges` は空きの区間の閉じた範囲 `{gte: a, lte: e}`（チェックアウトの日を含む）。最大 200 区間。作り方は [search-and-ranking.md](../search-and-ranking.md) の 4.3 節。問い合わせは `{"range": {"stay_ranges": {"gte": ci, "lte": co, "relation": "contains"}}}`。
- **例**：準備の日 1、今日 2026-12-01、予約 A の `block_span [12-05, 12-09)`、予約 B の `[12-24, 12-28)`、ブロック `[2027-01-10, 2027-01-15)`。文書の `stay_ranges` は `[{"gte":"2026-12-01","lte":"2026-12-04"}, {"gte":"2026-12-09","lte":"2026-12-23"}, {"gte":"2026-12-28","lte":"2027-01-09"}, {"gte":"2027-01-15","lte":"2027-12-01"}]`。12-30〜01-02 の検索は 3 つ目の区間に含まれる。
- 大きさ：文書 12 KB、S1 で 1.2 GB。主シャード 2、写し 2。

### 4.2 `places_v<n>`（別名 `places`）

| 欄 | 型 | 中身 |
| --- | --- | --- |
| `place_id`・`kind`・`parent_id`・`municipality_code` | keyword | |
| `names` | nested `{lang, name, reading}` | 表示 |
| `norm_keys` | text（`edge_ngram` 1〜20） | 正規の鍵の前方一致 |
| `name_ja` | text（ICU の正規化、`edge_ngram`） | 日本語の前方一致 |
| `geom` | `geo_shape` | 50 m で単純化し 100 m 広げた多角形か点 |
| `radius_m` | integer | 点の地名 |
| `listing_count` | integer | 点の計算 |

### 4.3 `photo_hashes`

| 欄 | 型 | 中身 |
| --- | --- | --- |
| `photo_id`・`listing_id`・`host_account_id` | keyword | |
| `phash`・`dhash` | long | 64 ビット |
| `band_0`〜`band_3` | keyword | pHash を 16 ビットずつに分けた帯（距離 6 以下の候補の引き） |
| `hash_degenerate` | boolean | |

## 5. SNS・SQS と事象の封筒

### 5.1 封筒

各クラスタの `outbox` の行（[ops.md](ops.md) の 3.1 節）を、`relay` がクラスタごとの SNS の話題（`core-events`・`ledger-events`・`content-events`・`vault-events`）へ、属性 `event_type` 付きで流す。消費者のキューは属性で絞る。

```json
{
  "id": "0193a7c2-6f1e-7c3a-9b1d-2a4e5f6a7b8c",
  "type": "reservation.confirmed",
  "schema_version": 1,
  "occurred_at": "2026-10-10T11:04:30.120Z",
  "aggregate": { "type": "reservation", "id": "0193a7c2-…", "version": 3 },
  "group_key": "0193a7c2-…",
  "sentinel": false,
  "trace_parent": "00-…-…-01",
  "data": {
    "reservation_id": "0193a7c2-…",
    "listing_id": "0192f3a4-…",
    "host_account_id": "0192e1b0-…",
    "settlement_seq": 0,
    "charge_currency": "USD",
    "charge_total": 47291,
    "listing_currency": "JPY",
    "listing_total": 69200,
    "quote_id": "0193a7c1-…",
    "payout_release_at": "2026-12-31T06:00:00Z"
  }
}
```

- `data` は ID・状態・数・金額・時刻だけ。住所・連絡先・氏名・本文・名簿の項目・口座の番号を持たない（JSON Schema の許可の一覧で検査）。
- `id` は消費者の冪等キー。重複の配信と順序の入れ替えは、消費者が `aggregate.version` と冪等キーで吸収する。

### 5.2 キュー

| キュー | 種類 | 作る側（話題 × 種類） | 消費者 | 備考 |
| --- | --- | --- | --- | --- |
| `ledger-events.fifo` | FIFO（グループ = 予約の ID か送金・請求の ID） | `reservation.confirmed`・`cancelled`・`altered`・`payout_release_due`、`payment.succeeded`・`refund.succeeded`、`chargeback.*`、`claim.*` | `ledger` | 予約ごとの順序。遅れた 2 つ目の決着は主キーで拒む |
| `search-index` | 標準 | `listing.*`、`listing.calendar_changed`、料金、順位の材料 | `search-indexer` | 500ms まとめて書く |
| `search-index-priority` | 標準 | `listing.state_changed`、措置、届出の失効 | `search-indexer` | `hidden` を p99 60 秒で消す |
| `availability-cache` | 標準 | `listing.calendar_changed`、料金 | `availability-cache-writer` | |
| `ical-fetch` | 標準 | `ical-scheduler` | `ical-fetcher`（`untrusted-egress`） | 本文にアドレスの暗号文（D-30） |
| `ical-apply.fifo` | FIFO（グループ = `listing_id`） | `ical-fetcher` | `ical-sync` | 泊の区間と予定の鍵のハッシュ |
| `media-processing` | 標準 | S3 の `photos-incoming` の作成の事象 | `media-processor` | |
| `translation` | 標準 | `listing.revision_published` | `translation-worker` | |
| `notify-critical`・`notify-transactional`・`notify-engagement` | 標準 | `notifier-decide` | `notifier-send` | レーンごとに分ける |
| `webhook-fanout` | 標準 | Webhook の対象の事象 | `webhook-fanout` | |
| `webhook-send` | 標準 | `webhook-fanout` | `webhook-sender`（`untrusted-egress`） | |
| `reviews-events`・`ts-events`・`compliance-events` | 標準 | 予約・メッセージ・レビュー・決済の事象 | `reviews`・`trust-safety`・`compliance-jp` | |
| `lake-ingest` | 標準 | 全部の話題 | `data-lake-baseline` | V・C の欄と P の本文を落とし、ID を HMAC に |

- 各キューに DLQ（14 日）。DLQ の年齢をアラートにする（[runbooks/](../../runbooks/README.md)）。

## 6. iCal

### 6.1 取り込み

- 取り込むのは VEVENT の泊の範囲だけ。`SUMMARY`・`DESCRIPTION` を保存しない（氏名・電話番号を含みうる）。読み方の表は [calendar-sync.md](../calendar-sync.md) の 5.4 節。
- `ical-apply` のメッセージ：`{feed_id, listing_id, fetched_at, content_hash, intervals: [{nights: "[2026-12-30,2027-01-02)", event_key_hashes: ["…"]}], counters: {malformed_range, short_timed_event, rrule_truncated, duplicate_uid, echo_uid, unknown_tzid}}`。
- 上限：応答 2 MiB、VEVENT 5,000、1 予定の繰り返し 500、区間 500、範囲 `[昨日, 今日 + 730 日)`。

### 6.2 書き出し

```
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//<Brand>//Calendar//EN
CALSCALE:GREGORIAN
METHOD:PUBLISH
BEGIN:VEVENT
UID:<claim_group>@<brand>.<domain>
DTSTAMP:20261010T083000Z
DTSTART;VALUE=DATE:20261231
DTEND;VALUE=DATE:20270104
SUMMARY:Reserved
END:VEVENT
END:VCALENDAR
```

- 有効な `stay_claims` の全種類を、`DTSTART = lower(block_span)`、`DTEND = upper(block_span)`（準備の日を含む）で出す。`SUMMARY` は `Reserved`（予約・仮押さえ・リクエスト）か `Not available`。氏名・連絡先・人数・金額・予約のコード・住所を出さない（[ADR-0023](../../decisions/0023-ical-export-secret-url-and-contents.md)）。
- `ETag` は `calendar_version`。S3 の `ical-exports/<listing_id>/<calendar_version>.ics` の写しを返し、古ければその場で作る。

## 7. 通知の中身

| 経路 | 中身 | 持たないもの |
| --- | --- | --- |
| プッシュ | 種類の題、`args` の許可の欄（リスティングの題名、日付、人数、ホストの表示の名）、アプリの中の場所 | 正確な住所、建物名、部屋番号、鍵の番号、旅券の番号、カードの番号の一部、口座の番号 |
| メール | 言語ごとの雛形（バージョンつき）、同じ許可の欄、本システムのドメインのリンク | 同上。外部の画像の読み込みの印（開封の追跡） |
| SMS | 種類と次の操作だけ（70・160 文字）、本システムのドメインの短い URL | 同上と本文のプレビュー |
| アプリの中のお知らせ | `notifications` の行 | 同上 |

- メッセージの通知のプレビューは、絞り込みの後の文の先頭 100 文字（本人が止められる）。
- 雛形の変数の一覧に、住所・鍵の番号などの変数を持たない（型で禁じる）。`args` の形は種類ごとの Zod の許可の一覧で、知らない欄は送らない。

## 8. Webhook の本文

```
POST <subscription url>
Content-Type: application/json
<Brand>-Signature: t=1791619200,v1=5f2b…e9
X-<Brand>-Event-Id: evt_0193a7c2-…
X-<Brand>-Event-Type: reservation.confirmed
X-<Brand>-Listing-Seq: 4812
X-<Brand>-Api-Version: 2026-10

{
  "id": "evt_0193a7c2-…",
  "type": "reservation.confirmed",
  "created_at": "2026-10-10T11:04:31Z",
  "listing_id": "0192f3a4-…",
  "listing_seq": 4812,
  "data": {
    "reservation_id": "0193a7c2-…",
    "reservation_version": 3,
    "check_in": "2026-12-30",
    "check_out": "2027-01-02",
    "guests": { "adults": 2, "children": 0, "infants": 0, "pets": 0 },
    "state": "confirmed"
  }
}
```

| 事象 | `data` の欄 |
| --- | --- |
| `reservation.requested`・`.confirmed`・`.altered`・`.cancelled`・`.expired`・`.declined` | `reservation_id`、`reservation_version`、日付、人数、状態 |
| `availability.changed` | 変わった範囲、`calendar_version`（そのアプリ自身の書き込みの変化は送らない） |
| `calendar.conflict_detected` | 範囲、相手の種類 |
| `message.created` | `thread_id`、`message_seq`（本文は API で取る） |
| `listing.updated`・`listing.status_changed` | `listing_version`、状態 |
| `bulk_job.completed` | `job_id`、成功と失敗の数 |
| `grant.revoked` | `grant_id` |

- `v1` = HMAC-SHA256（購読の秘密、`t` + `.` + 本文のバイト列）の 16 進。入れ替えの間は 2 つの `v1` を並べる。
- 本文にゲストの名前、連絡先、メッセージの本文、住所を載せない（[ADR-0070](../../decisions/0070-webhooks-signing-delivery-and-ordering.md)）。

## 9. AppConfig

### 9.1 `release.*`・`ops.*`・設定

| 種類 | 値 |
| --- | --- |
| `release.*` | 未完成の振る舞いの出し入れ（kebab-case。100% の後 30 日で消す）。例 `release.flexible-dates` |
| `ops.*` | `ops.booking_enabled`、`ops.payments_enabled`、`ops.payouts_enabled`、`ops.ical_import_enabled`、`ops.ical_poll_minutes`、`ops.partner_api_enabled.<app>`、`ops.search_stage1_limit`、`ops.search_degraded_mode`、`ops.sms_provider`、`ops.sms_allowed_countries`、`ops.sms_country_hourly_cap`、`ops.app_min_version_<platform>`、`ops.app_force_version_<platform>`、`ops.hold_limits`（[ADR-0036](../../decisions/0036-hot-date-admission-and-hold-limits.md) の上限） |
| T&S と ML | `ts.event_windows`、`ts.party_features_v1`、`ts.thresholds`、`models.<name>.active_version`、`rules.<name>.active_version` |
| 絞り込み | `filter.dictionaries.<lang>`（禁止の語・差別の語。バージョンつき） |
| 提供者 | `payments.provider_capabilities.<provider>`（`charge_currencies`、`authorization_validity`、`wallets`、`merchant_initiated`、`settlement_currency`、`partial_refund`・`multiple_refunds`、`fx_rates`。選定の後に値を入れる。D-26） |

- 設定の表（料金の手数料・ポリシー・税・自治体の規則・為替の上乗せ・確認を求める表）の正本は Aurora の表（`config_versions`）。AppConfig に持たない。

### 9.2 `legal.*`（全部）

AppConfig の別のアプリケーション `legal` に置く。本番の値は法務の結論の後（[delivery.md](../delivery.md) の 3.3 節）。予約・見積もり・仕訳・`regulated_nights` は使った構成のバージョン（`legal_config_version`）を記録する。

| 値 | 開発・検証の既定（— は本番と同じ） | 本番の既定 | L | 使う所 |
| --- | --- | --- | --- | --- |
| `legal.minpaku_count_external_nights` | `none` | `none` | L1 | `regulated_external_nights` を数えに入れるか |
| `legal.minpaku_day_boundary_rule` | `one_per_night` | `one_per_night` | L1 | 泊の日の数え方 |
| `legal.guest_registry_fields` | 観光庁の資料の項目 | L3 の後 | L3 | 名簿の項目 |
| `legal.guest_registry_retention_days` | 1,095 | 1,095 | L3・L8 | 名簿の保持 |
| `legal.registry_auto_delete_enabled` | `false` | `false` | L3 | 年度の鍵の自動の破棄 |
| `legal.registry_gate_arrival_info` | `true` | L3 の後 | L3 | 名簿の完了まで入り方を出さない |
| `legal.registry_identity_method` | `mrz_nfc` | L3 の後 | L3 | 旅券の読み取りの方式 |
| `legal.request_decline_mode_ryokan` | `unrestricted` | `unrestricted`（無効の印） | L2・L11 | 旅館業の施設のリクエストの断り |
| `legal.lodging_tax_collector`・`legal.lodging_tax_collector.<jurisdiction>` | `host` | `host` | L4 | 税の預かりの型 |
| `legal.funds_holding_model` | `collection_agent` | `collection_agent` | L5 | 預かりの法的な型 |
| `legal.max_holding_days` | なし | なし | L5 | 保留の上限 |
| `legal.sanctions_screening_owner` | `provider` | `provider` | L6 | 制裁の確かめ |
| `legal.message_scan_mode` | `send_time_pattern` | `send_time_pattern` | L9 | メッセージの検査の範囲 |
| `legal.message_translation_enabled` | — | `false`（無効） | L9 | メッセージの翻訳 |
| `legal.prebooking_guest_identity_display` | `none` | `none` | L11 | 予約の前のホストへのゲストの名前と写真 |
| `legal.pms_registry_scope_enabled` | `false` | `false` | L3・L8 | PMS の `guest_registry:read` |
| `legal.pms_cross_border_guest_data` | `deny` | `deny` | L8 | 日本の外の PMS へのゲストの個人のデータ |
| `legal.kyc_result_retention_days` | 2,555 | 消さない | L3・L8 | 本人確認の結果の保持 |
| `legal.person_key_enabled` | `true` | `false` | L8 | 同じ人の鍵 |
| `legal.claim_merchant_initiated_enabled` | `false` | `false` | L12 | 損害の請求の加盟店からの請求 |
| `legal.claim_evidence_retention_days` | 1,095 | 1,095 | L8・L12 | 証拠の保持 |

- `legal.kyc_*` は `legal.kyc_result_retention_days` などの本人確認の値の総称。`legal.respond` は運用者の権限の名前で、AppConfig の値ではない。

## 10. データレイク

data のアカウントの S3、Glue のカタログ、Athena。outbox の事象の写しを `data-lake-baseline` が入れる（V・C の欄と P の本文を落とし、利用者・ホストの ID をレイクの鍵の HMAC に、位置を市区町村に丸める）。元の ID へ戻す表は持たない。

| データ | 欄 | 分割 | 保持 |
| --- | --- | --- | --- |
| `events` | 封筒の欄（ID は HMAC）、`data` の許可の欄 | `dt`、`type` | 2 年 |
| `search_samples` | `search_id`、`listing_id`、`check_in`、`check_out`、`calendar_version`、`sampled_at`（検索の語・閲覧者の ID なし） | `dt` | 30 日（再判定の結果は core の `search_sample_checks`） |
| `search_queries` | 利用者の HMAC、検索の語、地図の範囲 | `dt` | 1 年（検索の改善と需要の集計だけ） |
| `rank_logs` | `search_id`、`rank_version`、上位 18 件の ID と点 | `dt` | 2 年 |
| `ts_eval_sets` | `evalset_version`、確かめた例（仮名） | `evalset_version` | バージョンごとに T&S の責任者が決める |
| モデルの登録簿 | モデル、バージョン、重みの場所、署名、評価と影の評価の結果、状態 | — | 消さない |

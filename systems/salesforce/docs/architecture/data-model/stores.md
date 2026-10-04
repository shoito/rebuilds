# Data model: DB 以外の置き場所と本文の形

Valkey のキー、S3 の配置、OpenSearch の索引、outbox・イベント・Webhook・SQS の本文、一括のファイル、メタデータのパッケージの形式。規約は [data-model.md](../data-model.md) の 3 節。

## 1. Valkey

**正本を置かない。** 失っても動く：メタデータの部品は Aurora から作り直し、割り当ては fail open で後から DB の 1 分の集計で数える（[ADR-0001](../../decisions/0001-platform-and-stack.md)、[ADR-0042](../../decisions/0042-org-allocations-fair-queuing-and-limit-info.md)）。**組織のデータのキーは必ず `{o:<org_id>}` のハッシュタグを含める**（クラスタモードで組織を 1 つのシャードに集め、キーの誤りで他の組織を読まない）。値に個人データを置かない（レポートの結果のキャッシュを除く。下の表）。

| キー | 型 | TTL | 中身 | 書く・読む |
| --- | --- | --- | --- | --- |
| `md:{o:<org_id>}:cur` | string | なし（バージョンの変更で上書き） | 今のメタデータのバージョン | Relay（確定の後）→ Runtime（5 秒ごとにも読み直す） |
| `md:{o:<org_id>}:man:<version>` | string（MessagePack＋zstd） | 7 日（使われなければ） | manifest（部品の鍵の一覧）。不変 | Runtime・Worker |
| `md:{o:<org_id>}:seg:<hash>` | string（MessagePack＋zstd） | 7 日 | コンパイル済みの部品（`object:<object_id>`・`picklists`・`sharing`・`permsets`・`layouts:<object_id>`・`report_types`）。鍵は内容と形のバージョンのハッシュ | 同上 |
| `md:{o:<org_id>}:perm:<version>:<perm_shape>` | string | 7 日 | 権限の形ごとのオブジェクト × 権限、項目 × 権限の表 | Runtime |
| `md:{o:<org_id>}:build:<hash>` | string（`SET NX`） | 10 秒 | 部品を作る人の印（同時に 1 つだけが作る） | Runtime・Worker |
| チャンネル `md:version` | pub/sub | — | `{ "org_id", "version" }` | Relay → Runtime |
| `host:<my_domain>` | string | 5 分 | ホスト名 → `org_id` | 入口（組織の解決） |
| `org:{o:<org_id>}:cfg` | hash | 60 秒＋変更で消す | `shard_no`、置き場所、`status`、`migrating`、機能の組、割り当ての値 | 入口、Runtime |
| `usr:{o:<org_id>}:<user_id>` | hash | 5 分＋変更で消す | `perm_shape`、プロファイル、ロール、ロケール | Runtime |
| `st:{o:<org_id>}:<object_id>` | string | 1 時間 | 問い合わせの統計（`stats_*` の写し） | Runtime |
| `alloc:{o:<org_id>}:<alloc_id>:<minute>` | integer | 25 時間 | 割り当ての 1 分の桶（1,440 個の合計で 24 時間の窓） | Runtime・Worker（`INCRBY`）。1 分ごとに `org_usage_minutes` へ写す |
| `conc:{o:<org_id>}:long` | sorted set（要求 ID → 開始のミリ秒） | 要素は 2 分 30 秒で消す | 長い要求の同時実行（`conc.long_running`） | Runtime |
| `conc:{o:<org_id>}:<conc_id>[:<user_id>]` | sorted set | 同上 | 他の同時の数（`conc.event_streams`・`conc.search`・`conc.report_sync`） | Runtime |
| `dbt:{o:<org_id>}:<cluster_id>:<minute>` | hash（`path` → ミリ秒） | 2 時間 | 組織の DB の時間 | 計測器。1 分ごとに `org_db_time_minutes` へ写す |
| `rpt:{o:<org_id>}:<key_hash>` | string（暗号化） | 5 分 | レポートの同期の結果。鍵は（定義のハッシュ、`user_id`、権限の形、バージョン、`as_of` の 60 秒の区切り）のハッシュ。**利用者をまたいで共有しない**。組織の `files` の DEK で暗号化 | Runtime |
| `dsh:{o:<org_id>}:<dashboard_id>:<viewer_id>:<as_user_id>` | string（暗号化） | 10 分 | ダッシュボードの部品の結果 | Runtime |
| `evt:{o:<org_id>}` | pub/sub | — | `{ "max_replay_id" }`。購読者（SSE・Webhook の送り手）への知らせ | Relay → Runtime・Worker |
| `evtperm:{o:<org_id>}:<subscriber>` | string | 60 秒 | 購読者の権限の形 | Runtime |
| `auth:fail:<username_hash>` | integer | 30 分 | ログインの失敗の数（10 回で止める） | 認証のサービス |

- 組織の移動の切り替えの後は、先のセルの Valkey の組織のキーを作り直す（割り当ては `org_usage_minutes` から）。組織の消去では `{o:<org_id>}` のキーを全て消す。

## 2. S3

### 2.1 バケット

バケットの名前は開発リポジトリで決める。下は役割（[infrastructure.md](../infrastructure.md) の 4.6 節）。

| バケット | アカウント | 中身 | 暗号 | 保持 |
| --- | --- | --- | --- | --- |
| `org-files` | prod | 2.2 節 | 組織の `files` の DEK ＋ SSE-KMS | 種類ごと（2.2 節）。大阪へ複製 |
| `packages` | prod | `metadata/<org_id>/...`（書き出し・デプロイ・送ったパッケージ）、`registry/<namespace>/<version>/package.zip`・`signature`（E14） | SSE-KMS（組織のものは組織の `files` の DEK も） | 書き出し 7 日、計画 30 日、送ったもの 30 日、配布のバージョンは無期限 |
| `static` | prod | SPA の資産 | SSE-S3 | バージョンごと |
| `audit-archive` | log-archive | `audit/<org_id>/<yyyy>/<mm>/<dd>.jsonl.gz`（組織ごとの日ごとの JSON Lines）、`anchors/<yyyy-mm-dd>.json`（全ての組織の鎖の先頭） | 組織の `audit` の DEK ＋ SSE-KMS。Object Lock（コンプライアンス） | 1 年 |

### 2.2 `org-files` の配置

鍵の先頭は `<org_id>/`。組織の消去は接頭辞ごとに消す（バージョンを含む）。

| 鍵 | 中身 | 保持 |
| --- | --- | --- |
| `<org_id>/bulk/<job_id>/source/<n>.csv` | 上げた元の CSV（分けて上げた順） | 処理の後 24 時間 |
| `<org_id>/bulk/<job_id>/parts/<part_no>.csv` | 1 万行の部分 | 7 日 |
| `<org_id>/bulk/<job_id>/results/<part_no>.success.csv`・`.failed.csv`・`.unprocessed.csv` | 行ごとの結果（5 節） | 7 日 |
| `<org_id>/bulk-query/<job_id>/<n>.csv` | 一括の問い合わせの結果（1 ファイル 1GB まで） | 7 日 |
| `<org_id>/reports/<run_id>.json` | レポートの非同期の結果 | 24 時間 |
| `<org_id>/exports/<export_id>.csv` | エクスポート | 24 時間 |
| `<org_id>/audit-exports/<id>.jsonl.gz` | 監査の書き出し | 24 時間 |
| `<org_id>/email/<email_message_id>/raw.eml` | 記録したメールの原本 | メールのレコードに従う |
| `<org_id>/email/<email_message_id>/att/<attachment_no>` | 添付（`email_attachments`） | 同上 |
| `mail-intake/<yyyy-mm-dd>/<ses_message_id>` | SES の受信の直後（組織を決める前）。SSE-KMS だけ | 処理の後に消す（最大 24 時間） |

- 署名した URL を渡さない。取り出しは API を通す（本人の確かめの後にストリームで返す）。

## 3. OpenSearch

共有の索引 `rec-v{n}-{00..15}`。`shard_no % 16` で索引を決め、索引の中は `org_id` を routing にする。別名（alias）で指し、マッピングの変更は新しいバージョンを作り直して別名を切り替える（[search.md](../search.md) の 4 節、[ADR-0031](../../decisions/0031-search-index-and-japanese-analysis.md)）。

| 項目 | 型・解析 | 説明 |
| --- | --- | --- |
| `_id` | — | `{org_id}:{record_id}` |
| `_routing` | — | `org_id` |
| `_version`（`version_type=external`） | — | `row_version`。古い書き込みを 409 で捨てる |
| `org_id`・`object_id`・`record_id`・`owner_id` | `keyword` | 全ての問い合わせに `org_id` と `object_id` の絞りを付ける |
| `row_version`・`metadata_version` | `long` | |
| `name` | `text`（`icu_normalizer` → `kuromoji_tokenizer` → 品詞の除去 → カタカナ → 長音）。部分の項目 `name.ngram`（`cjk_bigram`）、`name.prefix`（`edge_ngram` 1〜20） | |
| `name_kana` | `text`（カナの正規化） | |
| `texts` | `nested`：`f`（`short`、`field_no`）、`v`（`text`＋`v.ngram`） | FLS で読めない項目で一致させないため項目ごと。長いテキストは最初の 32KB |
| `phones`・`emails` | `keyword` | 数字だけ・小文字 |
| `updated_at` | `date` | |
| `_source` | `includes: [org_id, object_id, record_id, row_version, metadata_version]` | **値を置かない**。表示の値は DB から読む |

- 解析器は E5 の着手前の PoC で決める（既定は kuromoji＋2-gram）。索引の主シャードは索引ごとに 2、複製 1。

## 4. 本文の形

### 4.1 `outbox.payload`

種類ごとの Zod のスキーマ（開発リポジトリの `packages/contract`）で検証してから書く。

| `kind` | 本文 |
| --- | --- |
| `change_event` | `{ object_id, record_ids[], op, row_version, changed_field_nos[], values: { "<field_no>": 値 }, commit_ts, origin }`。`values` は変わった項目の新しい値（`long_text` は 32KB まで） |
| `org_event` | `{ type_id, values: { "<field_id>": 値 }, published_by }` |
| `field_history` | `{ changed_at, rows: [ { object_id, record_id, seq, field_no, event, old_value, new_value, changed_by, via } ] }` |
| `search_index` | `{ object_id, record_id, row_version, changed_field_nos[] }` |
| `delivery` | `{ endpoint_id, path, body, idempotency: "<Brand>-Delivery-Id" }` |
| `email` | `{ template, to_user_ids[] or to_record_ids[], subject, body_ref }`（本文は `record_long_texts` か定型の文面の ID） |
| `async` | `{ kind: "flow_async" \| "trigger_after_commit" \| "metadata.version_changed" \| "post_job", ... }` |
| `login_event` | `login_events` の行の形（`id` を除く） |

### 4.2 変更のイベント（API・SSE・Webhook の `events[]`）

[events-and-integrations.md](../events-and-integrations.md) の 3.1 節の形。`change_events.body` は同じ見出しと、`field_no` をキーにした値を持ち、配信の時のバージョンで API の名前に直し、購読者（Webhook は `run_as_user_id`）の FLS で落とす。

```json
{
  "replay_id": "000000000001a2b3",
  "event_id": "0192f0c1-…",
  "schema": "change.v1",
  "header": {
    "object": "opportunity", "record_ids": ["0192…"], "change_type": "UPDATE",
    "changed_fields": ["stage", "amount"], "tx_key": "0192…", "tx_seq": 3,
    "commit_ts": "2026-09-28T01:02:03.456Z", "commit_user": "0192…",
    "origin": { "kind": "api", "client_id": "<brand>_app_…" },
    "record_version": 8, "metadata_version": 1043, "truncated_fields": []
  },
  "fields": { "stage": "negotiation", "amount": "1200000" }
}
```

- 組織が定義するイベントは `schema: "event.v1"`、見出しに `type`・`publish_behavior`・`published_by`、`fields` にイベントの項目。

### 4.3 Webhook

```
POST <url>
Content-Type: application/json
<Brand>-Signature: t=<unix 秒>,v1=<hex(HMAC-SHA256(秘密, "{t}.{本文}"))>
<Brand>-Delivery-Id: <delivery_id>
<Brand>-Webhook-Id: <endpoint_id>

{ "delivery_id": "…", "events": [ 4.2 節の形, … ] }   // 100 件・1MB まで
```

- 秘密の入れ替えの間（24 時間）は `v1=` を 2 つ並べる。再試行のたびに `t` と署名を作り直す。

### 4.4 SQS の本文

| キュー | 本文 | 送る・受ける |
| --- | --- | --- |
| `search-index`（標準、一括の分は低い優先の別のキュー） | `{ org_id, shard_no, object_id, record_id, row_version, changed_field_nos[] }` | Relay → indexer |
| `jobs-notify-<class>` | `{ class }`（仕事が来た知らせだけ。順番は `jobs`） | 仕事を入れた処理 → Worker |
| `egress-requests`（prod-egress のアカウント） | `{ delivery_id, org_id, url, method, headers（署名済み）, body, timeout_ms }`。秘密を含めない | 本番の Worker（`SendMessage` だけ）→ `sender` |
| `egress-results`（本番のアカウント） | `{ delivery_id, org_id, status, http_status, duration_ms, blocked_reason }` | `sender` → 本番の Worker |
| `access-oracle-samples` | `{ org_id, user_id, record_id, decided, metadata_version, closure_generation }` | Runtime → Worker（標本の照合） |
| `mail-intake` | `{ s3_key, recipient }` | SES → Worker |

## 5. 一括のファイル

| ファイル | 列 |
| --- | --- |
| 取り込みの CSV | 1 行目は API の名前。参照は親の ID か `<参照の項目>.<親の外部 ID の項目>`。空の欄は「変えない」、空にするのは `#N/A`。文字コードは `encoding`（既定 UTF-8。ウィザードは CP932 も判定） |
| 成功の結果 | `id`、`created`（作成か）、元の列 |
| 失敗の結果 | `error_code`、`error_message`（項目の名前だけ。値を入れない）、元の列 |
| 処理しなかった行 | 元の列 |
| 問い合わせの結果 | 1 行目は API の名前。次の locator は応答の見出しで返す |

## 6. メタデータのパッケージの形式

[sandboxes-and-deploy.md](../sandboxes-and-deploy.md) の 5 節（[ADR-0039](../../decisions/0039-metadata-package-format.md)）の要約。本家の XML の形式は受け付けない。

| 部分 | 中身 |
| --- | --- |
| `package.yaml` | `format: <brand>-md`、`format_version`、`source`（組織の種類、系統のハッシュ、バージョン）、`components[]`（種類・名前・内容のハッシュ）。E14 は `namespace`・`version`・`min_platform_version`・`requires`・`locked`・`signature` を足す |
| `objects/<api_name>/object.yaml`、`fields/`、`record_types/`、`validation_rules/`、`layouts/`、`list_views/` | オブジェクトごとの定義 |
| `standard_objects/<api_name>/...` | 標準オブジェクトへの追加（書いたものだけを足す・変える） |
| `flows/`、`approval_processes/`、`permission_sets/`、`profiles/`、`roles/`、`groups/`、`sharing/`、`duplicate_rules/`、`matching_rules/`、`report_types/`、`reports/`、`dashboards/`、`event_types/`、`channels/`、`webhooks/`・`outbound_endpoints/`（秘密なし） | 部品の種類ごと |
| `destructive.yaml` | 消す部品と時期（`pre`・`post`） |

- 参照は全て API の名前で書き、ID を持たない。デプロイの時に相手の組織の ID に解決する（`field_id` は組織の系統の外では使わない）。
- YAML 1.2 の部分集合（アンカー・エイリアス・タグ・複数の文書なし）。部品の種類ごとの JSON Schema を `format_version` ごとに公開する。書き出しは正規化した形で、書き出したものを同じ組織にデプロイすると差分 0。
- 名前の変更は `rename_from`。1 つの部品のデプロイは全体の置き換え（標準オブジェクトを除く）。データ（レコード）は含めない。
- 大きさ：zip 50MB、展開して 600MB、部品 10,000。

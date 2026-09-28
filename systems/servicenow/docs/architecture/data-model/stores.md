# Data model: DB 以外の置き場所と本文の形

[data-model.md](../data-model.md) の一部。Valkey のキー、S3 の配置、OpenSearch の索引の形、outbox の topic と SQS のメッセージ、Webhook の本文、取り込み・エクスポート・設定のパッケージ・CMDB の取り込み・祝日の CSV のファイルの形を定義する。

- **DB だけが正本である。** Valkey・OpenSearch・SQS は失っても DB から作り直せる（[architecture/README.md](../README.md) の 1.2 節、[security.md](../security.md) の SEC-092）。
- **テナントの分離**：Valkey のキーは `{t:<tenant_id>}` のハッシュタグで始め、S3 はテナントの接頭辞 `t/<tenant_id>/` の下に置き、OpenSearch の文書は `tenant_id` を持ち `_routing = tenant_id` にする。問い合わせの `tenant_id` の絞り込みは必須（[ADR-0002](../../decisions/0002-tenancy-and-isolation.md)、[ADR-0043](../../decisions/0043-japanese-analyzer-and-index-layout.md)）。
- 値・本文・キーに秘密（パスワード、トークン、DEK の平文）を置かない。メールアドレスは `sha256` にしてからキーにする。

## 1. Valkey（セルごと）

クラスタモード。`{...}` はハッシュタグで、同じテナントのキーを同じスロットに置く（テナントの削除で接頭辞ごと消すため）。

| キー | 型 | TTL | 中身 | 書く・読む | 定義元 |
| --- | --- | --- | --- | --- | --- |
| `dict:{t:<tenant>}:<meta_version>` | string（圧縮した JSON） | 24 時間 | コンパイル済みの実効の辞書（Zod のスキーマの元） | App・Engine | [data-dictionary-and-tables.md](../data-dictionary-and-tables.md) の 9.2 節 |
| `acl:{t:<tenant>}:<meta_version>:<table_id>:<op>` | string | 24 時間 | コンパイル済みの規則の集合と述語の雛形 | App・Engine | [access-control.md](../access-control.md) の 7 節 |
| `principal:{t:<tenant>}:<user_id>:<acl_version>` | string | 1 時間 | 主体（ロールの閉包、グループ、属性） | App・Engine | 同上 |
| `ui:{t:<tenant>}:<meta_version>:<table_id>:<view>` | string | 24 時間 | 画面のモデル（配置と画面の規則のコンパイル済みの形） | App | [portal-and-ui.md](../portal-and-ui.md) の 4.1 節 |
| `items:{t:<tenant>}:<user_id>:<acl_version>:<meta_version>` | set | 1 時間 | 見える品目とカテゴリの ID | App | [service-catalog-and-requests.md](../service-catalog-and-requests.md) の 6.1 節 |
| `aud:{t:<tenant>}:<user_id>:<acl_version>:<meta_version>` | set | 1 時間 | 合う `audience_id`（ナレッジの検索の `terms`） | App | [search.md](../search.md) の 6.5 節 |
| `rpt:{t:<tenant>}:<sha256(当てはめた SQL と引数)>:<meta_version>:<5 分の枠>` | string | 10 分 | レポートの結果（1 件 1 MB、テナント 200 MB まで） | App・Notifier | [reports.md](../reports.md) の 7.3 節 |
| `sess:{t:<tenant>}:<token_hash>` | hash | 無操作の期限 | `user_session` の写し（正本は DB） | App | [identity-and-access.md](identity-and-access.md) の 6.7 節 |
| `saml:{t:<tenant>}:<idp_id>:<assertion_id>` | string | `NotOnOrAfter` ＋ 3 分 | アサーションの再利用の検出（DB と二重） | App | [access-control.md](../access-control.md) の 9.1 節 |
| `rl:{t:<tenant>}:tenant`・`rl:{t:<tenant>}:client:<client_id>`・`rl:{t:<tenant>}:user:<user_id>` | hash（トークンバケット） | 満ちるまで | API のレート制限（Lua で 1 回の往復） | App | [api-and-integrations.md](../api-and-integrations.md) の 7.2 節 |
| `conc:{t:<tenant>}:<export\|import\|capped_count>` | sorted set（要求 ID → 期限） | 要素ごと | 重い要求の同時の実行 | App・Engine | 同上の 7.1 節 |
| `mail:{t:<tenant>}:new:<sha256(from)>:<10 分の枠>` | integer | 20 分 | 同じ差出人の新しいレコードの作成の数（10 分に 20） | Ingest | [notifications-and-email-ingest.md](../notifications-and-email-ingest.md) の 6.2 節 |
| `mail:{t:<tenant>}:append:<record_id>:<時の枠>` | integer | 2 時間 | 同じレコードへの追記（1 時間に 30） | Ingest | 同上 |
| `mail:{t:<tenant>}:notify:<user_id>:<record_id>:<10 分の枠>` | integer | 20 分 | 同じ受け手・レコードの通知のメール（10 分に 5。超えたら要約） | Notifier | 同上 |
| `mail:{t:<tenant>}:in:<分の枠>` | integer | 2 分 | テナントの受信の全体（1 分に 1,000） | Ingest | 同上 |
| `ses:{t:<tenant>}` | hash（トークンバケット） | 1 日 | テナントの送信の流量（毎秒 10、毎日 5 万） | Notifier | 同上の 3.3 節 |
| `kbview:{t:<tenant>}:<article_id>:<user_id>:<時の枠>` | string（`SET NX`） | 1 時間 | 閲覧の数の重複の抑え（1 利用者・1 記事で 1 時間に 1 回） | App | [knowledge.md](../knowledge.md) の 7.2 節 |
| `once:{t:<tenant>}:<種類>:<キー>:<窓>` | string（`SET NX`） | 窓 | 知らせの重複の抑え（割り当てられる人がいない：グループごと 1 時間） | Engine | [assignment-and-on-call.md](../assignment-and-on-call.md) の 4.2 節 |
| `engine:shard:<0..63>` | string（リースの持ち主） | 30 秒（更新） | タイマーのワーカーの担当の shard（重なっても `SKIP LOCKED` で二重にならない） | Engine | [workflow-engine.md](../workflow-engine.md) の 8.3 節 |
| チャンネル `meta.changed` | pub/sub | — | `{tenant_id, meta_version, acl_version}`。キャッシュの入れ替えを先に知らせる（落としても要求の始めの読み取りで追いつく） | Record Service → App・Engine | [data-dictionary-and-tables.md](../data-dictionary-and-tables.md) の 9.2 節 |

- Valkey が落ちたときの振る舞い：キャッシュは DB から作り直す。レート制限は App のメモリーの近似のバケット。メールの流量は `inbound_email` の件数で数える。セッションは DB を読む。
- テナントの削除では `{t:<tenant>}` のキーを `SCAN` で消す（[security.md](../security.md) の 9.1 節）。

## 2. S3

バケットの名前は開発リポジトリで決める。下は役割とキーの形。暗号化の鍵は [security.md](../security.md) の 5.2 節。

| バケット（役割） | アカウント | キーの形 | 保持 | 定義元 |
| --- | --- | --- | --- | --- |
| セルのデータ | セル | `t/<tenant_id>/att/<attachment_id>`（添付）、`t/<tenant_id>/quarantine/<attachment_id>`（マルウェアの隔離） | 親のレコードに従う | [security.md](../security.md) の 5.3 節 |
| 同上 | セル | `t/<tenant_id>/mail/<yyyy>/<mm>/<inbound_email_id>.eml` | 1 年 | [notifications-and-email-ingest.md](../notifications-and-email-ingest.md) の 5.8 節 |
| 同上 | セル | `t/<tenant_id>/export/<export_job_id>.csv` | 24 時間 | [reports.md](../reports.md) の 11 節 |
| 同上 | セル | `t/<tenant_id>/import/<import_run_id>/source.<csv\|jsonl>` | 30 日 | [api-and-integrations.md](../api-and-integrations.md) の 5.1 節 |
| 同上 | セル | `t/<tenant_id>/cmdb/<yyyy-mm-dd>/<ingest_batch_id>.json` | 30 日 | [cmdb-and-reconciliation.md](../cmdb-and-reconciliation.md) の 5.2 節 |
| 同上 | セル | `t/<tenant_id>/package/<config_package_id>.json`（ダウンロード用、署名付き） | 7 日 | [data-dictionary-and-tables.md](../data-dictionary-and-tables.md) の 10.3 節 |
| 同上 | セル | `t/<tenant_id>/audit-export/<run_id>/...`（テナントの削除の前の監査の履歴のエクスポート） | 30 日 | [security.md](../security.md) の 9.1 節 |
| セルの共通 | セル | `platform/holidays/jp_cabinet_office/<sha256>.csv`（内閣府の CSV の原本）、`platform/search/sudachi/<pkg_version>.zip`、`platform/search/eval/<version>/`（架空の評価のデータ） | 消さない | [sla-and-calendars.md](../sla-and-calendars.md) の 5 節、[search.md](../search.md) の 4 節 |
| mail-ingress の一時 | mail-ingress | `<ses_message_id>`（SES が書く） | 1 日（ライフサイクル）。読めるのは `mail-router` だけ | [infrastructure.md](../infrastructure.md) の 2.3 節 |
| log-archive（Object Lock、compliance） | log-archive | `audit-digest/<cell>/<tenant_id>/<yyyy>/<mm>/<dd>/<partition>.json`（`audit_digest` の写し） | 7 年（延長 10 年） | [data-dictionary-and-tables.md](../data-dictionary-and-tables.md) の 7.2 節 |
| 同上 | log-archive | `tenant-audit/<cell>/<tenant_id>/<yyyy>/<mm>/<dd>.jsonl.gz`（`tenant_audit_event` の日次の写し） | 7 年 | [security.md](../security.md) の 6 節 |
| 同上 | log-archive | `platform-audit/<yyyy>/<mm>/<dd>/<hh>/<chunk>.jsonl.gz`（プラットフォームの監査） | 7 年 | 同上 |
| 同上 | log-archive | CloudTrail の既定の形、`app-logs/<cell>/<service>/<yyyy>/<mm>/<dd>/` | 7 年・13 か月 | 同上 |

- セルのデータのバケットは大阪へレプリケーションする（DR）。log-archive は本番のアカウントの主体が消せない・読めない。
- 署名付き URL は判定の後にだけ出し、有効 5 分。添付はマルウェアの検査の結果が `NO_THREATS_FOUND` のものだけ。

プラットフォームの監査の 1 行（JSON Lines）：

```json
{"id":"0192...","at":"2026-09-28T01:02:03.456Z","cell":"cell-s01","tenant_id":"0191...|null",
 "actor":{"kind":"operator|job","ref":"ops-123"},"action":"support_access.read|tenant.suspended|holiday_version.published|partition.dropped|legal_hold.placed",
 "target":{"table":"task","ids":["0192..."]},"ticket_ref":"SUP-1234","reason":"...","prev_hash":"base64","hash":"base64"}
```

## 3. OpenSearch（セルごとの 1 つのドメイン）

索引は `task_v{n}`・`ci_v{n}`・`kb_v{n}`・`catalog_v{n}`・`record_v{n}`（別名 `task` など）。すべての文書で `_routing = tenant_id`、外部の版（`version_type = external`）は行の `version`（ナレッジは版の `version_no` ではなく記事の `version`）。定義元：[search.md](../search.md) の 3・4・5・7 節。

### 3.1 解析器（全索引で共通の設定）

```json
{
  "analysis": {
    "char_filter": { "icu_nfkc_cf": { "type": "icu_normalizer", "name": "nfkc_cf" } },
    "analyzer": {
      "ja":     { "char_filter": ["icu_nfkc_cf"], "tokenizer": "sudachi_c",
                  "filter": ["sudachi_normalizedform", "sudachi_part_of_speech", "ja_stop_builtin"] },
      "ja_a":   { "char_filter": ["icu_nfkc_cf"], "tokenizer": "sudachi_a",
                  "filter": ["sudachi_normalizedform", "sudachi_part_of_speech", "ja_stop_builtin"] },
      "bigram": { "char_filter": ["icu_nfkc_cf"], "tokenizer": "cjk_bigram_tokenizer" },
      "en":     { "type": "english" }
    },
    "normalizer": { "kw_lower": { "type": "custom", "filter": ["lowercase", "icu_folding"] } }
  }
}
```

- 同義語は索引の解析器に入れない（テナントごと）。問い合わせの時に `search_synonym` から展開する。
- Sudachi の辞書の更新は、新しい索引への入れ直しと別名の切り替えで行う（[search.md](../search.md) の 4.3 節）。

### 3.2 文書の形

共通の本文の枠（テナントのフィールド・組み込みの本文・作業メモ・コメント）：

```json
"fields": { "type": "nested", "properties": {
  "fid":  { "type": "keyword" },
  "kind": { "type": "keyword" },
  "text": { "type": "text", "analyzer": "ja",
            "fields": { "a": { "type": "text", "analyzer": "ja_a" },
                        "bg": { "type": "text", "analyzer": "bigram" },
                        "en": { "type": "text", "analyzer": "en" } } },
  "kw":   { "type": "keyword", "normalizer": "kw_lower" }
} }
```

| 索引 | 文書の ID | 主なフィールド（`keyword` は完全一致、`date`・`boolean` は絞り込み） | 入れない |
| --- | --- | --- | --- |
| `task` | `task.id` | `tenant_id`、`class_id`、`number`（`kw_lower`）、`state`、`active`、`priority`、`assignment_group_id`、`assigned_to_id`、`requester_id`、`requested_for_id`、`opened_by_id`、`watchers`、`ci_id`、`opened_at`、`updated_at`、`fields`（`title`・`description`、`searchable` のテナントのフィールド、`kind = journal_work_note`・`journal_comment` の最新 50 件・32 KB まで） | 監査の履歴、添付の本文、完了から 2 年を過ぎた行 |
| `record` | `custom_record.id` | `tenant_id`、`table_id`、`number`、`updated_at`、`fields` | `searchable` でないテーブル |
| `ci` | `ci.id` | `tenant_id`、`class_id`、`name`（`text` と `kw`）、`operational_status`、`location_id`、`owner_group_id`、`support_group_id`、`identifiers`（`keyword` の配列：シリアル番号・ホスト名・IP の表示してよいもの） | 識別の値のハッシュ |
| `kb` | `kb_article.id`（公開中の版だけ） | `tenant_id`、`number`、`kb_base_id`、`category_id`、`audience_id`、`version_id`、`language`、`rating_avg`、`fields`（題名・本文・キーワード） | `draft`・`review`・`retired` の版 |
| `catalog` | `catalog_item.id`（公開中の版） | `tenant_id`、`item_version_id`、`category_ids`、`audience_id`、`fields`（名前・説明・キーワード） | 変数の定義 |

- 結果の総数（`hits.total`）を画面にも API にも出さない。集計（ファセット）に OpenSearch の集計を使わない（[ADR-0044](../../decisions/0044-acl-aware-search-and-index-freshness.md)）。
- 大きさ（S1、1 セル）：`task` 約 110 GB（主）・6 シャード、`ci` 約 25 GB・2 シャード、`kb`・`catalog`・`record` は 1 シャード（[search.md](../search.md) の 5.3 節）。

## 4. outbox と SQS

### 4.1 outbox の topic

`outbox.payload` は topic ごとの Zod スキーマ（開発リポジトリの `packages/contract`）。**値を入れず、ID と版だけを入れる**（受け手は DB の今の行、または事象の時点の版を `record_change` から組み立てて読む）。共通の形：

```json
{ "topic": "record.changed", "event_id": "0192...", "tenant_id": "0191...", "cell": "cell-s01",
  "occurred_at": "2026-09-28T01:02:03.456Z", "data": { } }
```

| topic | `data` | 行き先の SQS | 受け手 |
| --- | --- | --- | --- |
| `record.changed` | `{table_id, class_id, record_id, record_version, op, changed_field_ids, actor_kind, actor_id, channel, cause_id, cause_depth, cause_chain}` | `indexer`、`notifier`、`engine-async`、`webhook` | Indexer、Notifier（通知の規則）、Engine（`async` のルール、衝突の非同期の計算し直し）、Notifier（Webhook） |
| `meta.changed` | `{meta_version, acl_version, kinds: ["dict","acl","flow",...]}` | `engine-async` | 索引を写すジョブ・再コンパイル（プロセスへの先の知らせは Valkey の pub/sub） |
| `sla.warning`・`sla.breached` | `{clock_id, task_id, clock_version, pct?, breached_at?}` | `notifier`、`webhook` | 通知、フローのトリガー |
| `approval.requested`・`approval.decided` | `{set_id, target_table_id, target_record_id, approval_ids?, state?}` | `notifier`、`webhook` | 通知（承認の依頼のメールはログインを求めるリンクだけ） |
| `flow.notify` | `{run_id, node_id, iteration, rule_key, recipients}` | `notifier` | フローの `notify` のノード |
| `page.notify` | `{page_id, attempt_ids}` | `notifier` | 当番の呼び出し（冪等のキーは `page_attempt.id`） |
| `webhook.request` | `{run_id, node_id, iteration, idempotency_key, secret_name?, url, method, body_ref}` | `notifier-egress` | フローの `call_webhook`（本文は `flow_step.outputs` から読む） |
| `ci.held` | `{hold_id, reason, candidate_ci_ids}` | `webhook` | Webhook |
| `import.completed` | `{import_run_id, state, counts}` | `webhook` | Webhook |
| `kb.published`・`kb.retired` | `{article_id, version_id}` | `indexer` | ナレッジの索引 |
| `kb.feedback` | `{article_id, version_id, reason}` | `notifier` | 持ち主のグループへの知らせ |

- SQS は事象の種類ごとの標準のキュー ＋ DLQ（[infrastructure.md](../infrastructure.md) の 3.2 節）。**順序は約束しない。** 受け手は版（`record_version`、外部の版）と一意の制約（`notification_message`、`webhook_delivery`）で重複・逆転に備える。
- メッセージの属性に `tenant_id` と `traceparent` を入れる。受け手は処理の始めに `SET LOCAL app.tenant_id` をし、読んだ行の `tenant_id` と違えば止めて SEV2（[security.md](../security.md) の 10.1 節）。
- テナントの公平のため、`tenant_id` を SQS のメッセージのグループの鍵にしない（[search.md](../search.md) の 7.1 節）。

### 4.2 outbox を経ないメッセージ

| キュー | 本文 | 送り手 → 受け手 |
| --- | --- | --- |
| `mail-ingress`（mail-ingress のアカウント） | SES の S3 の動作の通知（SNS 経由） | SES → `mail-router` |
| `mail-inbound`（セル） | `{tenant_id, ses_message_id, received_at, envelope_to, s3_key, spam_verdict, virus_verdict, dkim, spf, dmarc}` | `mail-router` → Ingest |
| `ses-events`（セル） | SES の配信の事象（バウンス・苦情・配信） | SES の構成のセット → Notifier（`email_suppression`・`page_attempt.delivery_status`） |
| `cmdb-ingest`（セル） | `{tenant_id, ingest_batch_id, received_at}` | App（受け付け）→ Ingest |
| `webhook-retry`（セル） | `{tenant_id, delivery_id, event_at}`（遅延は 15 分まで。長い間隔は重ねて待つ） | Notifier → Notifier |

## 5. Webhook の本文

薄い事象（値を入れない）。署名は Standard Webhooks の形で、ヘッダーは `<Brand>-Webhook-Id`・`<Brand>-Webhook-Timestamp`・`<Brand>-Webhook-Signature`（`v1,<base64>`、秘密が 2 つなら空白で区切って 2 つ）。定義元：[api-and-integrations.md](../api-and-integrations.md) の 6.2・6.3 節。

```json
{
  "id": "whd_...",
  "type": "record.updated",
  "occurred_at": "2026-09-28T00:00:00Z",
  "subscription_id": "0192...",
  "table": "incident",
  "record": { "id": "0192...", "number": "INC0001234", "version": 8 },
  "changed_fields": ["state", "assigned_to"]
}
```

- `changed_fields` は購読の主体が読めるフィールドの辞書の名前だけ。`sla.*`・`approval.*` は `record` に対象のタスクを、`data` に `{clock_id}`・`{set_id, state}` を入れる。`ci.held` は `{hold_id, reason}`、`import.completed` は `{import_run_id, state, counts}`。
- 署名の対象は `id + "." + timestamp + "." + 本文のバイト列`、HMAC-SHA256。フローの `call_webhook` も同じ送信の部品と冪等のキーのヘッダー `<Brand>-Idempotency-Key` を使う。

## 6. ファイルの形

### 6.1 設定のパッケージ（JSON、署名付き）

```json
{
  "format": "<brand>.config-package/1",
  "id": "0192...", "source_tenant_id": "0191...", "created_at": "...", "created_by": "0190...",
  "items": [
    { "stable_key": "field:incident.c_building", "id": "0192...", "kind": "dict_field",
      "op": "upsert", "base_hash": "base64|null", "content": { }, "content_hash": "base64",
      "depends_on": ["table:incident"] }
  ],
  "signature": { "alg": "KMS-ECDSA-P256-SHA256|HMAC-SHA256", "key_id": "...", "value": "base64" }
}
```

- 5,000 項目まで。秘密の値（Webhook・フローの資格情報）と、レコード・利用者・グループの所属・番号の数を入れない。参照は `stable_key` で持ち、移送先で解決する（[data-dictionary-and-tables.md](../data-dictionary-and-tables.md) の 10 節）。
- `kind` は、辞書（`dict_table`・`dict_field`・`dict_override`・`dict_choice_set`・`dict_choice`）、`acl_rule`、`record_rule`、`flow_def`（版の文書を含む）、`sla_def`、`calendar`、`form_layout`・`list_layout`・`view_rule`・`ui_rule`、`translation`、`notification_template`、`catalog_item`、`assignment_rule`、`change_approval_policy_rule`、`report_def`・`dashboard`（`packaged` だけ）。

### 6.2 取り込みの CSV・JSON

- CSV：見出しの行 ＋ データの行。文字コードは `auto`（BOM の UTF-8 → 厳格な UTF-8 → Shift_JIS）、`utf-8`、`shift_jis`。1 ファイル 100 MB、50 万行、1 行 64 KB まで。原本の列の名前は見出しのまま `import_row.raw` のキーになる（NFC）。
- JSON：`POST /api/v1/imports/{run_id}/rows` に `{ "rows": [ { "<列の名前>": "<値>" } ] }`（1 回 1,000 行）。
- 変換の結果は `import_row` の行ごとの状態で返す（`GET /api/v1/imports/{run_id}/rows?state=error`）。

### 6.3 CMDB の取り込みのペイロード

正本は [cmdb-and-reconciliation.md](../cmdb-and-reconciliation.md) の 5.2 節（`source`、`batch_key`、`items[]`（`ref`・`class`・`native_key`・`observed_at`・`attributes`・`present_attributes`）、`relations[]`、`relation_snapshot[]`）。項目 1,000、関係 5,000 まで。原本は S3 の `t/<tenant_id>/cmdb/...` に 30 日置く。

### 6.4 エクスポートの CSV

- UTF-8（BOM 付き）、改行は CRLF、RFC 4180 の引用。見出しは見る人の言語のフィールドのラベル（2 行目に辞書の名前を入れない）。
- 値が `=`・`+`・`-`・`@` で始まるセルは先頭に `'` を付ける（式の注入の対策）。参照は表示の値（読めなければ空）。日時は見る人のタイムゾーンの ISO 8601。
- 10 万行まで。読めないフィールドの列は出さない（[access-control.md](../access-control.md) の 6.2 節の 10 行）。

### 6.5 祝日の CSV（内閣府）

- Shift_JIS、見出し「国民の祝日・休日月日,国民の祝日・休日名称」、行は `YYYY/M/D,名称`。取り込みの元の URL は設定に持つ（コードに埋めない）。原本は `platform/holidays/jp_cabinet_office/<sha256>.csv` に置き、`holiday_set_version.source_sha256` と対応させる。テストは固定の版の原本のファイルを読む（[ADR-0020](../../decisions/0020-japanese-holiday-data.md)）。

# Data Model: Cloudflare Workers

全ての領域のテーブルと保存の索引。どこに何があるか、誰が持ち主か、テナントの分離（`account_id` と RLS）、保持、複製を一覧にする。**各テーブル・器の列の詳細の正本は、各行の「定義」の文書**にある。この文書は一覧と横断の規則と、複数の領域が列を足す表の統合した定義（3.2 節の `script_versions`、8 節の器）を持つ。列の型・索引・制約は、各変更の `spec.md` で決める。ADR は持たない。

前提の決定：制御プレーンの正本は Aurora、ノードは設定の写し（LMDB）だけで要求を処理する（[ADR-0004](../decisions/0004-config-and-code-distribution.md)、[ADR-0022](../decisions/0022-sequenced-change-log-relays-and-lmdb.md)）。ストレージの一貫性は製品ごとに違う（[ADR-0005](../decisions/0005-storage-consistency.md)）。利用者のデータ（関数のコード、シークレット、KV の値、オブジェクト、DO の SQLite、キューのメッセージ、ログの中身）は、その製品の保存の外（運用のメトリクス、基盤のログ、監査の `changes`）に置かない（[AGENTS.md](../../AGENTS.md)）。

## 1. 置き場所

| 保存 | アカウント・場所 | 中身 | 正本か | 定義 |
| --- | --- | --- | --- | --- |
| Aurora PostgreSQL 18 | `cp-prod`、東京（大阪に Global Database の副） | 制御プレーンの正本：アカウント、関数・版・デプロイ、ルート・ドメイン・証明書、ストレージの**定義**（KV の名前空間、バケットの設定、DO の名前空間、キュー）、制限・使用量・請求、監査、変更のログ、運用の記録、不正な利用の事件 | 正本 | 3 節 |
| ClickHouse | `cp-prod`、東京（3 AZ） | 利用者のログ（`tenant_logs`）、関数ごとの 1 分の集計（`invocation_rollup_1m`） | 利用者のログの正本（大阪へ戻せない） | 4 節 |
| DynamoDB | `storage-<r>`。東京の中央と各リージョン | KV の正本（`kv_entries`）、DO の名前の台帳・リース・割り当て・アラームの索引、キュー・cron のリース、cron の起動の記録 | KV・台帳・`cron_fires` は正本。リース・索引は作り直せる | 5 節 |
| S3 | `edge-<r>`・`storage-<r>`・`cp-prod`・`log-archive`・`quarantine`・`shared` | バンドル、LMDB のスナップショット、KV の大きな値、**オブジェクトの本体とメタデータ**、DO の WAL とスナップショット、ログ・使用量の生の記録、監査の WORM、証拠 | オブジェクト・KV の大きな値・DO の WAL は正本（DO は複製と組で） | 6 節 |
| ElastiCache for Valkey | `storage-<r>`（各リージョン）、`cp-prod`（東京） | KV の L2、管理 API のレート制限と失効の印 | キャッシュ（正本でない） | 7 節 |
| ノードの LMDB | 各エッジのノード・DO のホスト | 設定の写し（器） | 写し（正本は Aurora） | 8 節 |
| DO の SQLite と WAL | DO のホストの gp3（手元の SQLite）、ログのノードの i4i の NVMe（WAL の複製）、S3（WAL とスナップショット） | 実体ごとの SQLite（利用者のデータ）、アラームの時刻 | 正本は「確定した WAL（2 つの AZ の 2 台）＋ S3」。手元の SQLite はキャッシュ | 9.2 節 |
| ノードの手元 | 各ノードの gp3・メモリ | コードのキャッシュ、V8 のコードのキャッシュ、KV の L1、証明書の LRU、使用量の spool | キャッシュ・送りの途中 | 9.1 節 |
| SQS・Kinesis | 東京・各リージョン | キューのメッセージ（SQS）、使用量・利用者のログの流れ（Kinesis） | キューは正本（東京だけ）。Kinesis は送りの途中 | 10 節 |
| AMP・X-Ray・S3・CloudWatch Logs | `cp-prod`・各リージョン | 運用のメトリクス・トレース・基盤のログ（利用者のデータを含まない） | 運用の正本 | 11 節 |
| `security` のアカウント | — | セキュリティの事象（`quarantine_events`、`sandbox_violations`） | 正本 | 11 節 |
| 開発リポジトリのファイル | Git | パッチの一覧、WPT の期待、`egress_policy` の正本、設定ファイルのスキーマ、台数の計画 | spec・設定の正本（DB ではない） | 12 節 |

- **オブジェクトのメタデータは S3 にある。** Aurora にはバケットの設定（`object_buckets` など）だけを置き、オブジェクトの一覧・メタデータ・ETag は S3 に任せる（[ADR-0026](../decisions/0026-object-storage-s3-gateway-with-scoped-prefixes.md)）。

## 2. 横断の規則

- **テナントの表は `account_id` と RLS を持つ**（[AGENTS.md](../../AGENTS.md)、ADR-0001）。CI で全てのテナントの表に RLS があることを検査する（[ADR-0042](../decisions/0042-api-tokens-roles-and-audit-log.md)）。下の表の「分離」の列：`RLS`＝RLS あり、`基盤`＝テナントの表ではない（運用の役割だけ）、`本人`＝利用者本人だけ、`役割`＝特定の役割（Trust & Safety、法務、セキュリティ）だけ。
- **DynamoDB・S3・ClickHouse・Valkey には RLS がない。** キーの先頭に `namespace_id`・`bucket_id`・`account_id` を置き、ゲートウェイ・問い合わせのサービスが条件を必ず付け、応答の `account_id` を二重に確かめる（kv-store の 9 節、object-storage の 6 節、developer-tooling の 8.2 節）。オブジェクトは、さらに bucket_id の接頭辞に絞った STS のセッションで守る（ADR-0026）。
- **シークレット・トークン・鍵の平文を保存しない。** 暗号文（ADK・KMS で包んだもの）か、SHA-256 だけ（[security.md](security.md) の 4 節）。
- **変更は同じトランザクションで正本・`config_outbox`・`audit_events` に書く**（[ADR-0022](../decisions/0022-sequenced-change-log-relays-and-lmdb.md)、[ADR-0042](../decisions/0042-api-tokens-roles-and-audit-log.md)）。
- **ID**：版・監査・呼び出しは UUIDv7 か ULID。DO の ID は 32 バイト（[ADR-0029](../decisions/0029-do-placement-and-directory.md)）。API トークンは `<brand>_(ut|at|oa|or)_`＋40 文字＋CRC32 の 6 文字で、SHA-256 だけを持つ（ADR-0042、[リポジトリ共通の ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。
- **時刻**：UTC で持つ。請求の時間・日・月と、無料の日ごとの枠だけ JST（[ADR-0038](../decisions/0038-plan-limits-and-edge-enforcement.md)、[ADR-0040](../decisions/0040-jpy-pricing-invoices-and-spend-controls.md)）。
- **リージョン**：S1 は東京（`apne1`）・大阪（`apne3`）・海外 3。記号 `<r>` はリージョンの短い名前（[infrastructure.md](infrastructure.md) の 2 節）。
- **削除**：アカウントの削除は 30 日の猶予の後に正本から消し、写しは保持の期間で消える。削除の予約から 65 日以内に写しを含めて消える（[ADR-0048](../decisions/0048-audit-log-integrity-and-data-lifecycle.md)）。ADK を捨てて、写しに残るシークレットの暗号文を開けなくする。法的な保全（`legal_holds`）のあるアカウントは消さない。
- **災害復旧**：大阪へ写るものと、その RPO は [ADR-0051](../decisions/0051-disaster-recovery-and-honest-rpo.md) の表。下の表の「複製」の列。

## 3. 制御プレーンの表（Aurora）

### 3.1 アカウント・利用者・認証

| 表 | 分離 | 保持 | 定義 |
| --- | --- | --- | --- |
| `accounts` | RLS | 削除の後 30 日 | [dashboard-and-api.md](dashboard-and-api.md) の 15 節 |
| `users` | 本人 | | 同上 |
| `account_members` | RLS | | 同上 |
| `invitations` | RLS | | 同上 |
| `api_tokens` | RLS（アカウント）・本人（利用者） | 失効の後も監査のため行を残す | 同上の 6.3 節 |
| `oauth_refresh_families` | 本人 | | 同上の 15 節 |
| `idempotency_keys` | RLS | 24 時間 | 同上 |
| `secret_scanning_reports` | 基盤 | | 同上 |
| `account_subdomains` | RLS | 解放から 90 日は再利用しない | [edge-network-and-routing.md](edge-network-and-routing.md) の 18 節 |
| `account_deletions` | RLS | | [security.md](security.md) の 14 節 |
| `research_accounts` | 基盤 | | 同上 |

### 3.2 関数・版・デプロイ・配信

| 表 | 分離 | 保持 | 定義 |
| --- | --- | --- | --- |
| `scripts` | RLS | | [deployment-and-config-distribution.md](deployment-and-config-distribution.md) の 4.1 節 |
| `script_versions` | RLS | 直近 100＋いまの版（古いものは `purged` で行を残す） | 下の統合した定義 |
| `deployments` | RLS | | 同上の 4.1 節 |
| `secret_values` | RLS | 利用者が消すまで | 同上の 16 節 |
| `account_data_keys` | RLS | 版を持つ | 同上、[security.md](security.md) の 4 節 |
| `region_keys` | 基盤 | 前の版を 2 か月 | 同上 |
| `config_outbox` | 基盤 | 採番まで | 同上の 5.1 節 |
| `config_log` | 基盤 | 7 日（古いものは S3 へ） | 同上 |
| `config_epochs` | 基盤 | | 同上の 16 節 |
| `propagation_events` | 基盤 | 90 日（SLI の元） | 同上 |
| `cron_triggers` | RLS | | [queues-and-cron.md](queues-and-cron.md) の 14 節 |
| `tail_sessions` | RLS | | [developer-tooling.md](developer-tooling.md) の 16 節 |
| `support_log_grants` | RLS | 監査ログに写す | 同上 |

**`script_versions` の統合した定義**（3 つの領域が列を足している。表の持ち主は deployment-and-config-distribution）：

| 列 | 足した領域 | 意味 |
| --- | --- | --- |
| `account_id`、`script_id`、`id`、`number`、`status`（`validating`・`distributing`・`ready`・`failed`・`purged`）、`bindings`、`secret_refs`、`limits`、`message`、`tag`、`source`（`cli`・`api`・`dashboard`・`secret_change`・`rollback`）、`created_by`、`created_at` | deployment-and-config-distribution（4.1 節） | 版の本体。作った後に変えない（[ADR-0021](../decisions/0021-versions-deployments-and-gradual-rollout.md)） |
| `pending_regions` | deployment-and-config-distribution（16 節） | 同期の PUT が 30 秒で終わらなかったリージョン（[ADR-0023](../decisions/0023-code-and-secret-distribution.md)） |
| `bundle_sha256`、`bundle_size_compressed`、`bundle_size_uncompressed`、`compatibility_date`、`compatibility_flags`、`startup_time_ms` | runtime-and-isolates（15 節） | バンドルと互換の日付（[ADR-0008](../decisions/0008-bundle-format-and-compatibility-dates.md)） |
| `config_sha256`、`source_map_keys` | developer-tooling（16 節） | 設定ファイルのハッシュ、ソースマップの置き場所 |

### 3.3 ルート・ドメイン・証明書

| 表 | 分離 | 定義 |
| --- | --- | --- |
| `domains` | RLS | [edge-network-and-routing.md](edge-network-and-routing.md) の 18 節 |
| `hostnames` | RLS | 同上 |
| `routes` | RLS | 同上 |
| `certificates` | RLS | 同上 |
| `acme_orders` | 基盤 | 同上 |

### 3.4 ストレージの定義

中身（値、オブジェクト、SQLite、メッセージ）は Aurora に置かない。置き場所は 5・6・9・10 節。

| 表 | 分離 | 定義 |
| --- | --- | --- |
| `kv_namespaces` | RLS | [kv-store.md](kv-store.md) の 14 節 |
| `object_buckets` | RLS | [object-storage.md](object-storage.md) の 15 節 |
| `object_bucket_lifecycle_rules` | RLS | 同上 |
| `object_custom_domains` | RLS | 同上 |
| `object_access_keys` | RLS | 同上 |
| `do_namespaces` | RLS | [durable-objects.md](durable-objects.md) の 17 節 |
| `queues` | RLS | [queues-and-cron.md](queues-and-cron.md) の 14 節 |
| `queue_consumers` | RLS | 同上 |

### 3.5 制限・使用量・請求

| 表 | 分離 | 保持 | 定義 |
| --- | --- | --- | --- |
| `plans`・`plan_limits` | 基盤 | | [limits-and-billing.md](limits-and-billing.md) の 16 節 |
| `account_limits` | RLS | | 同上 |
| `account_billing` | RLS | | 同上 |
| `usage_batches` | 基盤 | 90 日 | 同上 |
| `usage_hourly` | RLS | 法令の保存の期間（法務・経理の確認待ち） | 同上 |
| `usage_daily_counters` | RLS | | 同上 |
| `price_books` | 基盤 | | 同上 |
| `invoices`・`invoice_lines` | RLS | 7 年（既定案。経理の確認待ち） | 同上の 7.2 節 |
| `budget_alerts` | RLS | | 同上 |
| `credit_grants`・`credit_ledger` | RLS | | 同上 |

### 3.6 監査・セキュリティ

| 表 | 分離 | 保持 | 定義 |
| --- | --- | --- | --- |
| `audit_events` | RLS | 18 か月（月の区画）。`prev_hash`・`row_hash` を持つ | 持ち主は [dashboard-and-api.md](dashboard-and-api.md) の 7.2 節。改ざんの検知と WORM は [security.md](security.md) の 6 節 |
| `access_grants` | 基盤 | | [security.md](security.md) の 14 節 |
| `vulnerability_reports` | 役割（セキュリティ） | | 同上 |
| `v8_security_patches` | 基盤 | | [sandbox-and-security.md](sandbox-and-security.md) の 15 節 |
| `cordon_assignments`（派生。正本はアカウントの状態で、cordon の入力は `account_state` の器で配る） | 基盤 | | 同上 |

### 3.7 運用・リリース・基盤

| 表 | 分離 | 定義 |
| --- | --- | --- |
| `runtime_releases` | 基盤 | [runtime-and-isolates.md](runtime-and-isolates.md) の 15 節、[delivery.md](delivery.md) の 15 節 |
| `runtime_patches` | 基盤 | [runtime-and-isolates.md](runtime-and-isolates.md) の 15 節 |
| `runtime_rollouts` | 基盤 | [delivery.md](delivery.md) の 15 節 |
| `ami_releases`・`ami_rollouts` | 基盤 | 同上 |
| `platform_config_changes` | 基盤 | 同上 |
| `feature_flags` | 基盤 | 同上 |
| `nodes` | 基盤 | [infrastructure.md](infrastructure.md) の 16 節 |
| `node_public_ips` | 基盤（13 か月） | 同上 |
| `dr_drills` | 基盤 | 同上 |
| `capacity_measurements` | 基盤 | [capacity.md](capacity.md) の 12 節 |
| `slo_reports` | 基盤 | [observability.md](observability.md) の 13 節 |
| `wpt_runs` | 基盤（CI の記録） | [web-apis-and-compat.md](web-apis-and-compat.md) の 14 節 |
| `geo_tables` | 基盤 | 同上 |

### 3.8 不正な利用（Trust & Safety）

| 表 | 分離 | 保持 | 定義 |
| --- | --- | --- | --- |
| `abuse_reports` | 役割（Trust & Safety。通報者の個人の情報を含む） | 法務と決める | [abuse-and-trust-safety.md](abuse-and-trust-safety.md) の 18 節 |
| `abuse_cases`・`abuse_actions` | 役割（Trust & Safety）。`abuse_actions` は監査ログに写す | | 同上 |
| `abuse_appeals` | RLS（利用者は自分の異議だけ） | | 同上 |
| `crawl_results` | 基盤 | | 同上 |
| `account_risk` | 役割（Trust & Safety） | 印は 1 年 | 同上 |
| `protected_names` | 基盤（非公開） | | 同上 |
| `legal_requests`・`legal_holds` | 役割（法務） | | 同上 |

## 4. ClickHouse

**利用者のログの保存**で、基盤の運用の観測（11 節）と分ける（[observability.md](observability.md) の 3 節）。

| 表 | 分離 | 保持 | 複製 | 定義 |
| --- | --- | --- | --- | --- |
| `tenant_logs` | `account_id` の行の方針 | 有料 7 日・無料 3 日 | なし（再送用の S3 を大阪へ CRR） | [developer-tooling.md](developer-tooling.md) の 8.1 節 |
| `invocation_rollup_1m` | 同上 | 90 日（仮） | なし | [observability.md](observability.md) の 2.3 節 |

- `usage_hourly`（Aurora）と `invocation_rollup_1m` は同じ呼び出しの記録から来る二重の集計。S1 は両方を持ち、1 時間ごとの突き合わせ（差 0.5% 以内）で数の食い違いを見つける。S2 で `usage_hourly` を ClickHouse へ移すかは、Aurora の加算が詰まったときに別の ADR で決める（[ADR-0039](../decisions/0039-usage-metering-pipeline.md)）。

## 5. DynamoDB

| 表 | 場所 | 複製 | 分離 | 定義 |
| --- | --- | --- | --- | --- |
| `kv_entries` | 東京 | MREC で大阪 | `pk` の先頭が名前空間の ID、`account_id` の二重の検査 | [kv-store.md](kv-store.md) の 5.2 節 |
| `do_directory` | 東京 | MREC で全 5 リージョン（読み込み用） | ID のタグ、`account_id` を持つ | [durable-objects.md](durable-objects.md) の 4.2 節 |
| `do_host_leases` | 各リージョン | なし | 基盤 | 同上の 5.1 節 |
| `do_assignments` | 各リージョン | なし | `object_id` から名前空間とアカウントを引ける | 同上 |
| `do_alarms` | 各リージョン | なし | `namespace_id`・`account_id` を持つ。索引で、正本は SQLite | 同上の 8.1 節 |
| `queue_dispatch_leases` | 東京 | なし | 基盤 | [queues-and-cron.md](queues-and-cron.md) の 14 節 |
| `cron_scheduler_leases` | 東京 | なし | 基盤 | 同上 |
| `cron_fires` | 東京 | MREC で大阪 | `account_id` を持つ。TTL 30 日 | 同上 |

- 全ての表で PITR（35 日）を有効にする。MRSC は TTL を持てないので `kv_entries`・`cron_fires` に使えない（[ADR-0051](../decisions/0051-disaster-recovery-and-honest-rpo.md)）。
- リースの表の障害で、そのリージョンの DO のホストは 7 秒で自ら止まる（既知の制約。[ADR-0030](../decisions/0030-do-leases-and-fencing.md)、[quality.md](../quality.md) の 1 節）。

## 6. S3

| バケット・接頭辞 | 場所 | 複製 | 保持 | 定義 |
| --- | --- | --- | --- | --- |
| `<brand>-code-<r>`：`bundles/sha256/<hex>` | 5 リージョン | 同期の PUT（5 リージョンへ） | 参照されなくなって 30 日 | [deployment-and-config-distribution.md](deployment-and-config-distribution.md) の 7 節 |
| スナップショット：`snapshots/<db_id>/<applied_seq>.lmdb.zst` | 5 リージョン | なし（作り直せる） | 直近 48 | 同上の 16 節 |
| `config_log` の書き出し | 東京 | 大阪へ CRR | 90 日（既定案。エポックの補正と調べに使う） | 同上 |
| `<brand>-kv-values-apne1`：`{namespace_id}/{key_hash}/{version}` | 東京 | 大阪へ CRR（RTC） | 旧い版 7 日 | [kv-store.md](kv-store.md) の 14 節 |
| `<brand>-obj-apne1-{00..15}`：`<bucket_id>/<key>`（本体と S3 のオブジェクトのメタデータ） | 東京 | 大阪へ CRR（RTC。バージョニングと削除の印の複製） | 利用者の規則。旧い版 7 日 | [object-storage.md](object-storage.md) の 15 節 |
| `<brand>-do-<r>`：`{jurisdiction}/{namespace_id}/{object_id}/wal/…`・`snap/…` | 5 リージョン | 東京 ↔ 大阪、海外 → 東京（`jp` は日本の中だけ） | 30 日 | [durable-objects.md](durable-objects.md) の 17 節 |
| テナントのログの再送用：`tenant-logs/<region>/<date>/<hour>/*.parquet` | 東京 | 大阪へ CRR | 7 日 | [developer-tooling.md](developer-tooling.md) の 16 節 |
| 使用量の生の束：`usage-raw/<region>/<yyyy>/<mm>/<dd>/*.json.zst` | 東京 | 大阪へ CRR | 13 か月 | [limits-and-billing.md](limits-and-billing.md) の 16 節 |
| 請求書の PDF・JSON | 東京 | 大阪へ CRR | 7 年（既定案。経理の確認待ち） | 同上の 7.2 節 |
| 入口のアクセスのログ `access-logs/<region>/<date>/<hour>/*.parquet`、基盤のログ | 各リージョン | なし | 30 日（L2 の確認待ち） | [observability.md](observability.md) の 13 節 |
| 監査の WORM（`audit_events` の写し、`audit_digests`、`platform_audit_events`）、CloudTrail | `log-archive` | 大阪へ CRR | 18 か月・3 年（仮）。Object Lock のコンプライアンスのモード | [security.md](security.md) の 14 節 |
| 法的な保全の書き出し（保全の対象の期間のログ） | `log-archive` | 大阪へ CRR | 保全が解けるまで。Object Lock | [abuse-and-trust-safety.md](abuse-and-trust-safety.md) の 10 節 |
| `abuse_evidence`：`evidence/<case_id>/<crawl_id>/…` | 東京（`cp-prod`） | なし | 180 日（保全があれば延ばす） | 同上の 18 節 |
| `quarantine` の証拠（EBS のスナップショット、メモリの写し） | `quarantine` | なし | 調べが終わるまで（法務の判断） | [security.md](security.md) の 5 節 |
| Terraform の状態 | `shared` | 大阪へ CRR | | [infrastructure.md](infrastructure.md) の 9 節 |

## 7. Valkey

| キー | 場所 | 用途 | 定義 |
| --- | --- | --- | --- |
| `kv:{namespace_id}:{key}` → `{version, fetched_at_ms, expires_at, metadata, value｜absent}` | 各リージョンの `storage-<r>` | KV の L2（キャッシュ） | [kv-store.md](kv-store.md) の 6.1 節 |
| `rl:{token_or_user}:{bucket}`、`rl:acct:{account_id}:{bucket}` | 東京の `cp-prod` | 管理 API のレート制限（1 分の桶 × 5） | [dashboard-and-api.md](dashboard-and-api.md) の 15 節 |
| `revoked:{token_id}` | 同上 | トークンの失効の印（有効期限まで） | 同上 |

- Valkey が止まっても正しさは崩れない（KV は L1 と正本で返す。レート制限は制限なしで運転し、失効は Aurora を見る。`rate-limit-store-down`）。

## 8. ノードの LMDB の器

形は [deployment-and-config-distribution.md](deployment-and-config-distribution.md) の 6.3 節。**書くのはノードの受け手だけ。ランタイムは開かない**（[ADR-0022](../decisions/0022-sequenced-change-log-relays-and-lmdb.md)）。種類は [ADR-0056](../decisions/0056-platform-config-staging-and-flags.md) の分け方。

| 種類 | 配り方 |
| --- | --- |
| 利用者 | 速い経路（設定 p99 10 秒、デプロイ p99 30 秒）。1 つの変更の影響はその利用者に閉じる。1 万項目を超える変更は保留にして承認を求める |
| 基盤 | 項目に `scope`（リージョン・cordon・ノードの割合）を持たせ、ステージング → 海外の 1 リージョンの `ci-internal` → そのリージョンの全 cordon → 大阪 → 全リージョンの段で広げる（各 30 分、2 人の承認）。セキュリティの修正（制限を厳しくする変更、漏洩の疑いの鍵の入れ替え）は段の待ちを 5 分に縮められる。ノードは型とスキーマで検証し、通らなければ前の値を使う |
| 障害 | 障害の対応の速い経路（`drain`）。同時に 2 リージョンまで |

| 器 | 種類 | 中身 | 定義した領域 |
| --- | --- | --- | --- |
| `account_state` | 利用者 | 状態、プラン、cordon の入力（作成日、確認、専用の契約）、`quota_block`（種類と `until`）・`spend_capped`・`payment_failed`、`abuse_hold`・`risk_level`・`suspended` | deployment-and-config-distribution、limits-and-billing、abuse-and-trust-safety |
| `script_state` | 利用者 | 関数の措置（`interstitial`・`blocked`） | abuse-and-trust-safety |
| `host`・`routes`・`routes_wild` | 利用者 | ホスト名とルート | edge-network-and-routing |
| `deploy`・`version` | 利用者 | デプロイと版 | deployment-and-config-distribution |
| `secret`・`account_key` | 利用者 | 包んだ値、RSK で包んだ ADK | 同上 |
| `certs_by_host`・`acme` | 利用者 | 証明書と包んだ鍵、ACME のトークン | edge-network-and-routing |
| `tail` | 利用者 | tail のセッションの印 | developer-tooling |
| `account_egress` | **基盤**（キーはアカウントごと） | cordon の外向きの方針の上書き | abuse-and-trust-safety |
| `region_key` | **基盤** | KMS で包んだ RSK・RDK | deployment-and-config-distribution、security |
| `region_flags` | 障害 | `drain` | edge-network-and-routing |
| `egress_policy` | 基盤 | 拒否の範囲、自分たちの IP、ポート | edge-network-and-routing |
| `geo` | 基盤 | 位置・AS の表の場所とハッシュ | web-apis-and-compat |
| `runtime_release`・`runtime_rollout`・`platform_flags`・`cordon_policy`・`pmu_thresholds` | 基盤 | ランタイムの版と波、フラグ、cordon と検知の閾値 | delivery |
| `region_members` | —（リージョンの中だけ。変更のログに入れない） | ホームのノードの一覧 | edge-network-and-routing |
| `meta` | — | `applied_seq`、`epoch`、`db_id`、`snapshot_id` | deployment-and-config-distribution |

**統合の工程で決めた種類**（2026-09-27）：

- **`region_key` は基盤の器にする。** 毎月の RSK・RDK の入れ替えは、全ノードのシークレットと TLS に一度に効く。誤った鍵を速い経路で全体に配ると、全ノードの冷たい起動と新しい TLS の握手が失敗しうる。段階的に配り、前の版を 2 か月残すので、戻しは前の版を使い続けるだけで済む。漏洩の疑いの入れ替えは、セキュリティの修正として段の待ちを 5 分に縮める（`kms-key-compromise`）。
- **`account_egress` は、キーはアカウントごとだが、基盤の器と同じ段階で配る。** 中身は利用者の変更ではなく、運用者が基盤の外向きの方針（不変条件）を上書きするもので、緩める誤りは外への悪用に直結する。作成は 2 人の承認。事件の対応で制限を**厳しくする**上書きは、セキュリティの修正として段の待ちを 5 分に縮める。緩める上書きは通常の段を踏む（[ADR-0044](../decisions/0044-egress-abuse-controls.md) の注記）。
- `account_state` の `abuse_hold`・`risk_level`・`payment_failed` は、信頼を下げる変更として優先の印で届いた時点で反映する（[ADR-0011](../decisions/0011-cordon-tiers-and-placement.md)）。

## 9. ノードと DO のホストの手元の保存

### 9.1 エッジのノード

| 保存 | 場所 | 共有 | 定義 |
| --- | --- | --- | --- |
| コードのキャッシュ `/var/lib/<brand>/code/<sha256>` | ノードの gp3（ノードはローカルの NVMe を持たない。[ADR-0050](../decisions/0050-runtime-fleet-instance-types.md)）とページキャッシュ | ノードの中だけ | [runtime-and-isolates.md](runtime-and-isolates.md) の 15 節 |
| V8 のコードのキャッシュ `(bundle_sha256, v8_version, v8_flags_hash)` | 同上 | ノードの中だけ（ノードの間で共有しない） | 同上 |
| KV の L1 | 外向きのプロキシのメモリ（1 GiB） | ノードの中だけ | [kv-store.md](kv-store.md) の 6.1 節 |
| 証明書の LRU（平文の鍵） | 入口のプロキシのメモリ（`mlock`） | 同上 | [edge-network-and-routing.md](edge-network-and-routing.md) の 7.5 節 |
| 使用量の spool | ノードのディスク | ノードの中だけ | [limits-and-billing.md](limits-and-billing.md) の 5.2 節 |
| 中継の 7 日のログ、バンドルのキャッシュ | 中継の gp3 | リージョンの中 | [deployment-and-config-distribution.md](deployment-and-config-distribution.md) の 16 節 |

### 9.2 Durable Objects の SQLite

| 保存 | 場所 | 役割 | 定義 |
| --- | --- | --- | --- |
| 手元の SQLite（実体ごとのファイル） | DO のホスト（m7i.12xlarge）の gp3。ランタイムには VFS を通してだけ見せる | キャッシュ。読み込みは手元から同期で返す | [durable-objects.md](durable-objects.md) の 7・17 節 |
| WAL の記録 `{object_id, epoch, lsn, commit_time_ms, frames, checksum}` | ログのノード（i4i.2xlarge の NVMe）。持ち主と別の 2 つの AZ | 3 台のうち 2 台（2 つの AZ）で確定（[ADR-0031](../decisions/0031-do-sqlite-replication-and-pitr.md)）。`promised_epoch`・`archived_lsn` を持つ | 同上 |
| WAL とスナップショット | `<brand>-do-<r>`（6 節） | 10 秒か 16 MiB ごと。30 日の PITR | 同上 |
| アラームの時刻 | SQLite の中（正本）＋ `do_alarms`（索引） | | 同上の 8.1 節 |

- 暗号化は S1 で SSE-S3 とホストのディスクの暗号化。アカウントごとの鍵は S2 で検討する（[ADR-0047](../decisions/0047-kms-key-hierarchy.md)）。

## 10. SQS・Kinesis

| 保存 | 場所 | 定義 |
| --- | --- | --- |
| SQS `<brand>-q-{queue_id}`（利用者のキューごと。本文と属性 `msg_id`・`content_type`・`enqueued_at`・`account_id`・`queue_id`） | 東京（複製なし。東京の回復まで待つ） | [queues-and-cron.md](queues-and-cron.md) の 14 節 |
| Kinesis `usage-<r>` | 各リージョン | [limits-and-billing.md](limits-and-billing.md) の 5.2 節 |
| Kinesis `logs-<r>`（利用者のログ） | 各リージョン | [developer-tooling.md](developer-tooling.md) の 8.1 節 |
| Kinesis Data Firehose（監査の WORM への写し） | 東京 | [security.md](security.md) の 6 節 |

## 11. 運用のメトリクスとログ（基盤の観測）

利用者のデータを含まない。利用者のログ（4 節）と置き場所・見る人を分ける（[observability.md](observability.md) の 3 節）。

| 保存 | 定義 |
| --- | --- |
| AMP（運用のワークスペース）：ラベルは `region`・`az`・`node_id`・`cordon`・`component`・`runtime_version`・`ami_version` まで。テナントのラベルなし | [observability.md](observability.md) の 2 節、[ADR-0052](../decisions/0052-platform-telemetry-and-cardinality.md) |
| X-Ray（トレース 1% ＋ 5xx・遅い要求） | 同上の 1 節 |
| 基盤のログ（S3 の Parquet 30 日、CloudWatch Logs 7 日） | 同上の 3 節 |
| 合成監視の結果（AMP） | 同上の 5 節 |
| セキュリティの事象（`security` のアカウント）：`quarantine_events`・`sandbox_violations` | [sandbox-and-security.md](sandbox-and-security.md) の 15 節 |
| 送信元の記録（`egress_ip`、`node_id`、時刻、ポート、`<Brand>-Ray`、関数、宛先）。90 日（L2 の確認待ち） | [abuse-and-trust-safety.md](abuse-and-trust-safety.md) の 11・18 節 |

## 12. 開発リポジトリのファイル（DB ではない）

| ファイル | 中身 | 定義 |
| --- | --- | --- |
| `patches/PATCHES.md`、`patches/workerd/`、`patches/v8/` | パッチの列（正本。`runtime_patches` は写し） | [runtime-and-isolates.md](runtime-and-isolates.md) の 4.1 節 |
| WPT の期待の一覧（`wpt_expectations`） | 試験ごとの期待と理由 | [web-apis-and-compat.md](web-apis-and-compat.md) の 14 節 |
| `egress_policy` の正本 | 拒否の範囲 | [edge-network-and-routing.md](edge-network-and-routing.md) の 18 節 |
| 設定ファイルの JSON Schema | `<brand>.jsonc` | [developer-tooling.md](developer-tooling.md) の 5 節 |
| Terraform の変数（台数の計画） | `region_capacity_plans` | [capacity.md](capacity.md) の 12 節 |
| プラットフォームが原因の失敗の分類の表 | `outcome` と部品の失敗 → SLI に数えるか | [observability.md](observability.md) の 6.1 節（QA が承認） |

## 13. 保持の一覧（法務・経理の確認待ちを含む）

保持の値は設定で変えられる形にする（[security.md](security.md) の 8.1 節、S-L4）。

| 対象 | 既定 | 確認待ち |
| --- | --- | --- |
| 利用者の監査ログ | 18 か月 | L7 |
| 基盤の監査・CloudTrail | 3 年（仮） | L7 |
| 請求書・使用量 | 7 年（既定案） | 経理、L5 |
| 使用量の生の束 | 13 か月 | — |
| 利用者のログ | 有料 7 日・無料 3 日 | L2・L7 |
| 入口のアクセスのログ | 30 日 | L2 |
| 送信元の記録 | 90 日 | L2 |
| 通報・証拠 | 180 日（保全で延ばす） | L1・L4 |
| リスクの印 | 1 年 | L7（個人の情報） |
| アカウントの削除 | 予約から 30 日で正本、65 日以内に写しまで | L7 |

## 14. 統合で決めたこと（2026-09-27）

- **`script_versions` の列**：表の持ち主は deployment-and-config-distribution にし、3 つの領域の列を 3.2 節の 1 つの定義にまとめた。
- **`region_key`**：基盤の器（8 節）。
- **`account_egress`**：キーはアカウントごとだが、基盤の器と同じ段階と承認で配る（8 節）。
- **`usage_hourly` と `invocation_rollup_1m` の二重の集計**：S1 は両方を持ち、突き合わせに使う（4 節）。1 つにするのは S2 で、Aurora の加算が詰まったときに ADR を起こす。
- **送信元の記録**：`nat_ip` を `egress_ip`（ノードの公開の IPv4）に改め、`node_public_ips` と結び付けた（[ADR-0049](../decisions/0049-aws-accounts-and-network.md)、ADR-0044 の注記）。
- **器の表**：deployment-and-config-distribution の 6.3 節の器の表に、ADR-0056 の種類の列と、各領域が足した器（`script_state`・`tail`・`account_egress`・基盤の器）を加えた。
- **オブジェクトのメタデータ**：S3 にある。Aurora はバケットの設定だけ（1 節）。
- **保持の期間**のうち、法務・経理の確認待ちのもの（13 節）は、値を仮のまま設定で変えられる形にした。

# Data model: Datadog（索引）

データの置き場所の索引。表・トピック・S3 のキー・キャッシュの鍵を、領域ごとに 1 か所で引けるようにする。列・主キー・索引の正本は、各行の「領域」の文書の「data-model への項目」の節にある。**完全版（ER 図、列の型、索引、分割）は後の工程で作る。**

前提：

- 管理の DB は Aurora PostgreSQL 18。組織の表は `tenant_id` を主キーの先頭に持ち、`FORCE ROW LEVEL SECURITY` と `SET LOCAL app.tenant_id` で絞る（[ADR-0003](../decisions/0003-tenancy-cells-and-isolation.md)）。
- RLS の外の表は ADR-0003 の一覧だけ。組織を持たない運用の表は保守のスキーマ `maint` に置く（ADR-0003 の 2026-10-09 の注記）。
- S3 のキーは `<cell>/<tenant_id>/<signal>/<class>/<yyyy>/<mm>/<dd>/<hh>/<file>`。規則はオブジェクトのタグ `class`・`tier`（`l0`・`l1`）で絞る（[ADR-0009](../decisions/0009-retention-tiers-on-s3.md)、[ADR-0061](../decisions/0061-dr-stage-up-and-cell-expansion.md)）。
- MSK のメッセージは先頭に `tenant_id`・形式のバージョン・取り込みの時刻を持つ（[ADR-0002](../decisions/0002-intake-log-on-msk.md)）。MSK に書く消費者の出力は出どころ（`src_partition`、`src_offset`）を持つ（ADR-0002 の注記）。

## 1. RLS の外の表

| 表 | 中身 | 領域 |
| --- | --- | --- |
| `tenant_cells` | 組織 → セル、移し替えの区切り `from_ts`・`move_state` | [infrastructure.md](infrastructure.md)、[tenancy-and-rbac.md](tenancy-and-rbac.md) |
| `intake_keys_index` | キーのハッシュ → 組織（X1） | [otlp-and-api-keys.md](otlp-and-api-keys.md) |
| `users`、`sessions` | 利用者（組織をまたぐ）、セッション | [tenancy-and-rbac.md](tenancy-and-rbac.md) |
| `maint.ingest_checkpoints`、`maint.ingest_shard_leases`、`maint.metric_block_verifications` | パーティションの確定の位置、貸し出し、写しの比べ | [tsdb-storage-engine.md](tsdb-storage-engine.md) |
| `maint.eval_shard_leases` | 評価のシャードの貸し出し | [monitors-and-alerting.md](monitors-and-alerting.md) |
| `maint.indexer_offsets` | ログのインデクサー・アーカイブの書き手の確定の位置 | [log-storage-and-search.md](log-storage-and-search.md) |
| `maint.assembler_offsets` | 組み立ての確定の位置 | [traces-and-sampling.md](traces-and-sampling.md) |
| `maint.usage_offsets` | 利用量の集計の確定の位置と出どころの位置 | [usage-and-billing.md](usage-and-billing.md) |
| `maint.cells`、`maint.dr_events` | セル、DR の切り替えと失った範囲 | [infrastructure.md](infrastructure.md) |
| `maint.rollouts`、`maint.format_versions` | 入れ替えの記録、形式の書く側の番号 | [delivery.md](delivery.md) |
| `maint.capacity_reviews` | 月次のキャパシティのレビュー | [capacity.md](capacity.md) |
| `maint.retention_policies` | データの種類ごとの保持の既定と法務の確認の状態 | [security.md](security.md) |
| `maint.operator_access_log` | 運用者のアクセス | [security.md](security.md) |
| outbox の読み出しの位置、SLI の集計 | relay、SLI | [ADR-0003](../decisions/0003-tenancy-cells-and-isolation.md) |

## 2. 組織の表（領域ごと）

| 領域 | 表 |
| --- | --- |
| 組織と権限（[tenancy-and-rbac.md](tenancy-and-rbac.md) の 15 節） | `tenants`（`authz_version`、`query_cache_generation`、`lifecycle_state`、`legal_hold` などの列）、`memberships`、`teams`・`team_members`、`roles`・`role_permissions`・`role_assignments`、`data_access_datasets`、`dataset_grants`、`data_access_outside_policy`、`service_accounts`、`sso_configs`・`sso_group_mappings`・`scim_tokens`、`cell_moves` |
| キー（[otlp-and-api-keys.md](otlp-and-api-keys.md) の 12 節） | `intake_keys`、`application_keys`、`otlp_resource_attribute_rules` |
| 取り込み（[intake-and-agent.md](intake-and-agent.md) の 9 節） | `tenant_quotas` |
| メトリクスのモデル（[metrics-model-and-cardinality.md](metrics-model-and-cardinality.md) の 11 節） | `metric_metadata`、`cardinality_limits`、`cardinality_overflow_events`、`metric_tag_selections` |
| TSDB（[tsdb-storage-engine.md](tsdb-storage-engine.md) の 13 節） | `metric_blocks`（月ごと）、`partition_set_changes` |
| クエリ（[metrics-query-engine.md](metrics-query-engine.md) の 10 節） | `query_tenant_limits`、`metric_block_stats` |
| ログのパイプライン（[logs-pipeline.md](logs-pipeline.md) の 14 節） | `pipeline_config_versions`、`log_pipelines`・`log_processors`、`scrub_rules`、`log_indexes`、`log_exclusion_filters`、`log_metrics`、`tenant_settings`（`scrub_default_profile`、`scrub_hmac_key_id` などの列） |
| ログの保存と検索（[log-storage-and-search.md](log-storage-and-search.md) の 13 節） | `log_segments`（月ごと）、`log_archive_files`、`log_facets`、`log_id_attributes`、`rehydration_jobs`、`deletion_requests`、`deletion_request_segments` |
| トレース（[traces-and-sampling.md](traces-and-sampling.md) の 14 節） | `trace_segments`（月ごと）、`trace_hours`、`trace_retention_rules` |
| モニター（[monitors-and-alerting.md](monitors-and-alerting.md) の 15 節） | `monitors`、`monitor_versions`、`monitor_transitions`（月ごと）、`downtimes`、`downtime_set_versions`、`composite_children` |
| 通知（[notifications-and-integrations.md](notifications-and-integrations.md) の 10 節） | `notification_requests`（outbox）、`notification_deliveries`・`notification_attempts`（月ごと）、`notification_targets`、`email_suppressions` |
| ダッシュボード（[dashboards.md](dashboards.md) の 11 節） | `dashboards`、`dashboard_versions`、`saved_views`、`dashboard_share_links` |
| SLO とインシデント（[slos-and-incidents.md](slos-and-incidents.md) の 10 節） | `slos`、`slo_corrections`、`slo_hourly`（月ごと）、`slo_daily`（年ごと）、`incidents`、`incident_counters`、`incident_events`（月ごと）、`incident_postmortems` |
| 利用量（[usage-and-billing.md](usage-and-billing.md) の 14 節） | `usage_hourly`、`usage_hosts_hourly`、`usage_ingested_objects`、`usage_adjustments`、`usage_monthly`、`usage_contracts`・`spend_caps` |
| セキュリティ（[security.md](security.md) の 14 節） | `tenant_purge_runs`、`support_access_grants`、`integration_secrets` |

## 3. MSK のトピック

| トピック | 中身 | パーティションの鍵 | 書き手 → 読み手 |
| --- | --- | --- | --- |
| `metrics` | 点のレコード、`Tick`、制御のレコード（`LimitUpdate`、`TagSelectionUpdate`） | 組織の組の中で系列の鍵 | `intake-gateway`、`derived-metrics-aggregator`、`limits-coordinator` → `metrics-ingester`、`usage-aggregator` |
| `logs-raw` | 受け取ったままのログ（マスクの前。保持 24 時間） | 組織の組の中でばらす | `intake-gateway` → `log-processor`、`usage-aggregator` |
| `logs` | 処理の後のログと振り分けの結果、出どころの位置 | 組織の組の中でばらす | `log-processor`（トランザクション）→ `log-indexer`、アーカイブの書き手、`live-tail`、`usage-aggregator` |
| `spans` | スパン | 組織の組の中で `trace_id` | `intake-gateway` → `trace-assembler`、`usage-aggregator` |
| `derived-partials` | ログ・スパンから作る指標の部分の値、出どころの鍵 | 系列の鍵 | `log-processor`、`trace-assembler` → `derived-metrics-aggregator` |
| `usage` | ホストの報告、拒否・429 の数 | 組織 | `intake-gateway` → `usage-aggregator` |
| `audit` | 監査の事象（変更と読み出し） | 組織 | `relay`、`query-frontend` → `log-indexer`（索引 `audit`） |

パーティションの数（S1 の仮の値）は [infrastructure.md](infrastructure.md) の 4.1 節。

## 4. S3

| 置き場所 | `class`（区分） | `tier` | 領域 |
| --- | --- | --- | --- |
| `<cell>/<tenant_id>/metrics/...` の時間のブロック | `h-3d` | `l0` | [tsdb-storage-engine.md](tsdb-storage-engine.md) の 7.2 節 |
| 同 日・月のファイル | `raw-15d`、`r1m-63d`、`r1h-15mo` | `l1` | 同上 |
| `<cell>/<tenant_id>/checkpoints/...` | `ckpt-24h` | — | 同上 |
| `<cell>/<tenant_id>/logs/...` の索引のセグメント、墓標 `.tomb-<gen>` | `idx-<N>d` | 合わせの前 `l0`、後 `l1` | [log-storage-and-search.md](log-storage-and-search.md) の 5.4 節 |
| 同 再水和 | `rehyd-<N>d` | `l1` | 同 8.2 節 |
| 同 監査の索引 | `audit-<N>d` | `l0`・`l1` | [tenancy-and-rbac.md](tenancy-and-rbac.md) の 8.2 節 |
| `<cell>/<tenant_id>/logs/archive-1y/...`（`<brand>-archive-apne1`） | `archive-1y` | — | 同 8.1 節 |
| `<cell>/<tenant_id>/traces/...`、`tidx`、時のブルームフィルター | `raw-15d` | `l0`・`l1` | [traces-and-sampling.md](traces-and-sampling.md) の 9 節 |
| `<cell>/<tenant_id>/evals/...` | `eval-30d` | `l1` | [monitors-and-alerting.md](monitors-and-alerting.md) の 11 節 |
| `<cell>/evals/snapshots/<shard>/...`、`<cell>/derived-metrics/checkpoints/...` | 運用 | — | 同上、[logs-pipeline.md](logs-pipeline.md) の 14 節 |
| `<cell>/<tenant_id>/config/pipelines/v<N>.bin` | 設定 | — | [logs-pipeline.md](logs-pipeline.md) の 7.4 節 |
| `quarantine/` | 写しの食い違いの調べ | — | [tsdb-storage-engine.md](tsdb-storage-engine.md) の 6.5 節 |

大阪の写し：`l0` は Standard に 2 日、チェックポイントは Standard に 24 時間、`l1` とアーカイブは Glacier Instant Retrieval（[infrastructure.md](infrastructure.md) の 6.2 節）。

## 5. キャッシュとフラグ

| 置き場所 | 鍵 | 領域 |
| --- | --- | --- |
| Valkey | `qc:{tenant_id}:{restriction_hash}:...`（クエリの結果）、`qgen:{tenant_id}` | [metrics-query-engine.md](metrics-query-engine.md) の 6 節 |
| Valkey | `dash:...`、`open:...`（ダッシュボード） | [dashboards.md](dashboards.md) の 11 節 |
| Valkey | `ik:{hash}`、チャネル `ik-revoked`（キー） | [otlp-and-api-keys.md](otlp-and-api-keys.md) の 12 節 |
| Valkey | `quota:{cell}:{tenant}:{window}`、`gw:{cell}:{gateway_id}`（取り込みの割り当て）、`quota:{tenant}:{index}:{day}`（索引の 1 日の上限） | [intake-and-agent.md](intake-and-agent.md)、[logs-pipeline.md](logs-pipeline.md) |
| Valkey | `card:{cell}:{tenant}:{partition}`、`wm:{tenant}:{signal}`、`evaluated_through:{tenant}:{monitor}`、`authz:{tenant_id}:{principal}` | [metrics-model-and-cardinality.md](metrics-model-and-cardinality.md)、[monitors-and-alerting.md](monitors-and-alerting.md)、[tenancy-and-rbac.md](tenancy-and-rbac.md) |
| AppConfig | `release.*`、`ops.intake_enabled`、`ops.compaction_enabled`、`ops.retention_delete_enabled`、`ops.notifications_enabled`、`ops.query_concurrency_per_tenant`、`ops.rollout_paused`、`ops.oversubscription_ratio`、`ops.agent_min_version`、`pii_defaults` | [runbooks/](../runbooks/README.md) の 2 節 |
| SNS・SQS | `notify`、`notify-email`、`notify-chat`、`notify-webhook`、`notify-oncall` | [notifications-and-integrations.md](notifications-and-integrations.md) の 4 節 |

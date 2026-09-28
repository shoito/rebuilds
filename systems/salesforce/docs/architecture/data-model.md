# Data model: Salesforce

全ての領域の表の索引。組織の分け方は [ADR-0005](../decisions/0005-tenancy-and-governor-limits.md)、保存の形は [ADR-0002](../decisions/0002-custom-object-storage.md) と [ADR-0010](../decisions/0010-record-tables-partitioning-and-pivots.md)、写しの扱いは [ADR-0012](../decisions/0012-derived-copies-consistency-and-projections.md) に従う。**各表の列の型と索引の全ての正本は、2 節の見出しに書いた領域の文書**で、この文書は置き場所・横断の規則・RLS の外の表・索引・他の領域から足した列を 1 か所で見るためのものである。ADR は持たない（各領域の ADR を参照する）。

実装の変更（`changes/`）でマイグレーションを書くときは、この文書と持ち主の領域の文書を合わせて更新する。この文書は 2026-09-28 の統合の工程で完成させた（8 節）。

## 1. 共通の規則

| 規則 | 中身 | 出典 |
| --- | --- | --- |
| 組織の列 | 組織のデータの表は全て `org_id` を持ち、主キーと索引の先頭に置く | [ADR-0005](../decisions/0005-tenancy-and-governor-limits.md) |
| RLS | `FORCE ROW LEVEL SECURITY`。トランザクションごとに `SET LOCAL app.org_id`（分割の表は `app.shard_no` も） | ADR-0005、[ADR-0010](../decisions/0010-record-tables-partitioning-and-pivots.md) |
| RLS の外 | 組織の解決・運用の表だけ（4 節の一覧）。書けるのは管理のサービスか運用のロールだけ | ADR-0005 |
| ID | UUIDv7。**一意の範囲は組織の系統（本番の組織と、その Sandbox）の中**。Sandbox は元の組織の ID をそのまま使う。全ての主キーの先頭が `org_id` なので衝突しない（`field_id` も同じ。ADR-0006 の 2026-09-28 の注記） | ADR-0005、[ADR-0038](../decisions/0038-sandbox-types-and-masked-copy.md)、[ADR-0006](../decisions/0006-data-dictionary-and-field-lifecycle.md) |
| 分割 | 大きな表（13）は `shard_no` の LIST（256）。主キーの末尾に `shard_no`。SQL は `shard_no` の定数を必ず含める。履歴・監査・イベントは時間の範囲の分割 | ADR-0010、[ADR-0047](../decisions/0047-field-history-tracking-and-retention.md)、[ADR-0033](../decisions/0033-change-event-log-and-replay.md) |
| 直接の SQL | `records` とピボットへの SQL は、コンパイラのパッケージの外で書かない | [ADR-0003](../decisions/0003-metadata-driven-runtime.md) |
| メタデータ | メタデータの表の変更は、組織の `metadata_version` を 1 つ上げる 1 つのトランザクションで行う | ADR-0003 |
| 写し | ピボット・照合の鍵・射影・積み上げ集計・共有の行（ルール・暗黙の親）・閉包・検索の索引は正本の写しで、純粋な関数で作り、整合の検査で差を 0 に保つ | ADR-0012 |
| 別のクラスタへの書き込み | `events`・`history` のクラスタへは、同じトランザクションの outbox に書き、Relay（論理シャードごとの唯一の書き手）が写す。outbox の行の ID から作る一意の鍵で二重を捨てる | ADR-0033、ADR-0047 の注記 |
| 保持 | 期限の正本は [security.md](security.md) の 7 節 | [ADR-0053](../decisions/0053-operator-access-and-data-lifecycle.md) |
| 暗号 | 秘密の列と S3 の組織のファイルは、組織の DEK で暗号化 | [ADR-0052](../decisions/0052-key-hierarchy-and-per-org-data-keys.md) |

「種類」の列：`meta`＝メタデータ（版を上げる）、`data`＝データ、`copy`＝正本の写し、`ops`＝運用・RLS の外、`log`＝追記だけ・期限で消す。「置き場所」：`main`＝主の Aurora、`events`＝`events` のクラスタ、`history`＝`history` のクラスタ（項目の変更の履歴。2026-09-28）、`control`＝組織の解決の表（S1・S2 は主のクラスタの別のスキーマ `control`。7 節）、`s3`、`os`＝OpenSearch。

## 2. 表の一覧

### 2.1 組織・利用者・認証（[orgs-users-and-auth.md](orgs-users-and-auth.md)）

| 表 | 主な列 | 種類 | 置き場所 | 分割・保持 |
| --- | --- | --- | --- | --- |
| `orgs` | 3.1 節（`migrating`、Sandbox の列を含む） | ops | control | — |
| `org_features` | `org_id`、`feature`、`enabled` | data | main | — |
| `org_licenses` | `org_id`、`license`、`purchased`、`used` | data | main | — |
| `users` | 5.2 節 | data | main | — |
| `identity.auth_users`・`auth_accounts`・`auth_sessions`・`passkeys`・`two_factors`・`sso_providers` | Better Auth の表＋`org_id` | ops | main（`identity` のスキーマ） | 認証のサービスのロールだけ |
| `oauth_clients` | `org_id`、`client_id`、`secret_hash`、`redirect_uris`、`scopes`、`run_as_user_id`、`created_by` | data | main | — |
| `oauth_tokens` | `org_id`、`token_hash`、`kind`、`client_id`、`user_id`、`scopes`、`expires_at`、`revoked_at` | data | main | — |
| `token_routes` | `token_hash_prefix`、`org_id` | ops | control | — |
| `org_auth_settings` | `org_id`、`sso_required`、`session_idle_minutes`、`password_min_length`、`jit_enabled`、`jit_defaults` | data | main | — |
| `org_purge_log` | `org_hash`、`requested_at`、`purged_at` | ops | control | — |

### 2.2 メタデータと実行基盤（[metadata-and-runtime.md](metadata-and-runtime.md)）

| 表 | 主な列 | 種類 | 置き場所 | 分割・保持 |
| --- | --- | --- | --- | --- |
| `md_objects` | `org_id`、`object_id`、`api_name`、`kind`、`owd`、`grant_via_hierarchy`、`next_field_no`、`field_history_enabled`、`allow_activities`、`deleted_at` | meta | main | — |
| `md_fields` | `org_id`、`field_id`、`object_id`、`field_no`、`api_name`、`type`、`type_params`、`required`、`unique`、`external_id`、`indexed`、`data_class`、`searchable`、`track_history`、`state`、`deleted_at` | meta | main | `(org_id, object_id, field_no)` は一意 |
| `md_relationships` | `org_id`、`field_id`、`child_object_id`、`parent_object_id`、`kind`、`master_order`、`on_parent_delete` | meta | main | — |
| `md_picklists`、`md_picklist_values` | `org_id`、`picklist_id`、`value_id`、`api_value`、`label`、`active`、`attrs` | meta | main | — |
| `md_record_types`、`md_record_type_values` | `org_id`、`record_type_id`、`object_id`、`api_name`、`active` | meta | main | — |
| `md_dependencies` | `org_id`、`from_kind`、`from_id`、`to_field_id` | meta（コンパイルで作る） | main | — |
| `md_versions`、`md_changes` | `org_id`、`version`、`actor_id`、`source`、`entity_kind`、`entity_id`、`op`、`before`、`after` | meta | main | — |
| `md_translations` | `org_id`、`entity_kind`、`entity_id`、`locale`、`text` | meta | main | — |
| `field_conversions` | `org_id`、`field_id`、`from_field_no`、`to_field_no`、`state`、`policy`、`progress` | data | main | — |
| `purge_jobs` | `org_id`、`kind`、`target_id`、`confirmed_at`、`progress`、`finished_at` | data | main | — |

### 2.3 レコードと写し（[data-storage.md](data-storage.md)）

| 表 | 主な列 | 種類 | 置き場所 | 分割・保持 |
| --- | --- | --- | --- | --- |
| `records` | 3.1 節 | data | main | `shard_no` |
| `record_index_values` | `org_id`、`object_id`、`field_no`、`record_id`、`ord`、`v_text`、`v_num`、`v_ts`、`v_bool`、`is_null` | copy | main | `shard_no` |
| `record_unique_values` | `org_id`、`object_id`、`field_no`、`v_norm`、`record_id` | copy | main | `shard_no` |
| `record_relationships` | `org_id`、`child_id`、`field_no`、`child_object_id`、`parent_id`、`parent_object_id` | copy | main | `shard_no` |
| `record_long_texts` | `org_id`、`record_id`、`field_no`、`value` | data | main | `shard_no` |
| `recycle_bin_batches` | `org_id`、`batch_id`、`root_object_id`、`root_record_id`、`deleted_by`、`deleted_at`、`record_count`、`purge_after` | data | main | 15 日＋24 時間 |
| `recycle_bin_links` | `org_id`、`batch_id`、`child_id`、`field_no`、`parent_id` | data | main | 同 |
| `shard_map` | `shard_no`、`cluster_id`、`state` | ops | control | — |
| `projections` | `org_id`、`object_id`、`projection_id`、`field_nos`、`state`、`built_version` | ops | main | S2 |
| `proj_*` | 射影の実テーブル | copy | main | S2。許可リストの DDL |
| `consistency_check_progress` | `org_id`、`object_id`、`check_kind`、`last_id`、`cycle_started_at` | data | main | — |
| `outbox` | `org_id`、`shard_no`、`id`、`kind`（data-storage の 3.5 節の一覧）、`payload`、`relayed_at` | data | main | `shard_no`。送った後に消す |

### 2.4 権限と共有（[sharing-and-record-access.md](sharing-and-record-access.md)）

| 表 | 主な列 | 種類 | 置き場所 | 分割・保持 |
| --- | --- | --- | --- | --- |
| `permission_sets` | `org_id`、`id`、`api_name`、`is_profile_base`、`license` | meta | main | — |
| `permission_set_object_perms` | `org_id`、`ps_id`、`object_id`、`read`、`create`、`edit`、`delete`、`view_all`、`modify_all` | meta | main | — |
| `permission_set_field_perms` | `org_id`、`ps_id`、`field_id`、`read`、`edit` | meta | main | — |
| `permission_set_system_perms` | `org_id`、`ps_id`、`perm` | meta | main | — |
| `permission_set_groups`、`permission_set_group_members` | `org_id`、`psg_id`、`ps_id` | meta | main | — |
| `profiles` | `org_id`、`id`、`base_ps_id`、既定のレイアウト・レコードタイプ、ログインの制限 | meta | main | — |
| `user_perm_assignments` | `org_id`、`user_id`、`ps_id`・`psg_id`、`expires_at` | data | main | — |
| `roles` | `org_id`、`role_id`、`parent_role_id`、`child_access` | meta | main | — |
| `groups`、`group_direct_members` | `org_id`、`group_id`、`kind`、`grant_via_hierarchy`、`member_kind`、`member_id` | data | main | — |
| `group_members_closure` | 4.4 節 | copy | main | `shard_no`、世代 |
| `owner_rule_grants` | `org_id`、`object_id`、`rule_id`、`source_group_id`、`grantee_group_id`、`access_level` | meta | main | — |
| `criteria_rules` | `org_id`、`rule_id`、`rule_key`、`object_id`、`condition`、`grantee_group_id`、`access_level`、`state` | meta | main | — |
| `record_shares` | `org_id`、`object_id`、`record_id`、`grantee_group_id`、`access_level`、`row_cause`、`rule_id` | data（rule は copy） | main | `shard_no` |
| `implicit_parent_grants` | `org_id`、`parent_object_id`、`parent_id`、`child_id`、`grantee_group_id`、`source_rule_id` | copy | main | `shard_no` |
| `record_team_members` | `org_id`、`record_id`、`user_id`、`team_role`、`access_level` | data | main | — |
| `sharing_jobs` | `org_id`、`kind`、`target`、`state`、`progress`、`deferred` | data | main | — |
| `access_oracle_samples` | `org_id`、`user_id`、`record_id`、`decided`、`oracle`、`direction`、`checked_at` | log | main | 食い違いだけ |

### 2.5 問い合わせと API（[query-language-and-api.md](query-language-and-api.md)）

| 表 | 主な列 | 種類 | 置き場所 | 分割・保持 |
| --- | --- | --- | --- | --- |
| `stats_objects` | `org_id`、`object_id`、`live_rows`、`deleted_rows`、`updated_at` | data | main | — |
| `stats_fields` | `org_id`、`object_id`、`field_no`、`ndv`、`null_frac`、`mcv`、`histogram`、`sample_rows`、`computed_at` | data | main | — |
| `stats_owner_counts` | `org_id`、`object_id`、`owner_id`、`rows` | data | main | — |
| `stats_share_counts` | `org_id`、`object_id`、`grantee_group_id`、`rows` | data | main | — |
| `api_versions` | `version`、`released_at`、`deprecated_at`、`sunset_at` | ops | control | — |

### 2.6 営業のオブジェクト（[sales-objects.md](sales-objects.md)）

| 表 | 主な列 | 種類 | 置き場所 | 分割・保持 |
| --- | --- | --- | --- | --- |
| `records`（標準オブジェクト） | 取引先・取引先責任者・リード・商談・活動・メール | data | main | 2.3 節 |
| `opportunity_history` | `org_id`、`opportunity_id`、`changed_at`、`stage`、`amount`、`probability`、`close_date`、`forecast_category`、`changed_by` | log | main | 18 か月（既定案） |
| `activity_relations` | `org_id`、`activity_id`、`related_object_id`、`related_id`、`kind`、`response` | data | main | `shard_no` |
| `lead_convert_mappings`、`lead_convert_settings` | `org_id`、`lead_field_id`、`target_object`、`target_field_id`、`opportunity_creation` | meta | main | — |
| `lead_conversions` | `org_id`、`lead_id`、`account_id`、`contact_id`、`opportunity_id`、`converted_by`、`converted_at`、`skipped_fields` | data | main | — |
| `matching_rules`、`matching_rule_items` | `org_id`、`rule_id`、`object_id`、`logic`、`state`、`item_no`、`field_id`、`method`、`blank`、`threshold` | meta | main | — |
| `duplicate_rules`、`duplicate_rule_matchers` | `org_id`、`id`、`object_id`、`sort_order`、`on_create`、`on_update`、`sharing`、`condition`、`matching_rule_id` | meta | main | — |
| `record_match_keys` | 6.3 節 | copy | main | `shard_no` |
| `duplicate_record_sets`、`duplicate_record_items` | `org_id`、`set_id`、`rule_id`、`record_id`、`detected_at` | data | main | — |
| `name_variant_chars` | `org_id`（システムの行は空）、`from_char`、`to_char` | meta | main | — |
| `email_log_addresses` | `org_id`、`user_id`、`token_hash`、`created_at`、`expires_at` | data | main | — |
| `email_attachments` | `org_id`、`email_message_id`、`s3_key`、`size`、`content_type` | data | main・s3 | — |

### 2.7 画面（[ui-layouts-and-list-views.md](ui-layouts-and-list-views.md)）

| 表 | 主な列 | 種類 | 置き場所 |
| --- | --- | --- | --- |
| `md_layouts` | `org_id`、`layout_id`、`object_id`、`api_name`、`definition` | meta | main |
| `layout_assignments` | `org_id`、`profile_id`、`record_type_id`、`layout_id` | meta | main |
| `md_list_views` | `org_id`、`list_view_id`、`object_id`、`api_name`、`definition`、`visibility` | meta | main |
| `user_list_views` | `org_id`、`user_id`、`list_view_id`、`object_id`、`definition` | data | main |
| `recent_items` | `org_id`、`user_id`、`object_id`、`record_id`、`viewed_at` | data | main |

### 2.8 自動化（[automation-flows.md](automation-flows.md)）

| 表 | 主な列 | 種類 | 置き場所 | 分割・保持 |
| --- | --- | --- | --- | --- |
| `md_flows`、`md_flow_versions` | `org_id`、`flow_id`、`api_name`、`type`、`object_id`、`trigger_order`、`active_version_id`、`version_id`、`definition`、`status`、`run_as` | meta | main | — |
| `flow_interviews` | `org_id`、`interview_id`、`user_id`、`version_id`、`state`（組織の DEK で暗号化）、`current_element`、`expires_at` | data | main | 7 日 |
| `flow_scheduled_actions` | `org_id`、`id`、`version_id`、`path`、`record_id`、`due_at`、`state` | data | main | `shard_no` |
| `flow_async_runs` | `org_id`、`version_id`、`record_id`、`origin_tx_id`、`ran_at` | log | main | 7 日 |
| `flow_schedule_runs` | `org_id`、`flow_id`、`started_at`、`last_record_id`、`count`、`state` | data | main | — |
| `md_validation_rules` | `org_id`、`rule_id`、`object_id`、`condition`、`message`、`error_field_id`、`active` | meta | main | — |
| `md_rollups` | `org_id`、`field_id`、`child_relationship_field_id`、`aggregate`、`child_field_id`、`filter`、`state` | meta | main | — |
| `rollup_stale` | `org_id`、`field_id`、`parent_id`、`since` | data | main | — |
| `md_approval_processes`、`md_approval_steps` | `org_id`、`process_id`、`version`、`object_id`、`order`、`entry_condition`、`record_editability`、`step_no`、`condition`、`approvers`、`when_multiple`、`reject_behavior` | meta | main | — |
| `approval_instances` | `org_id`、`instance_id`、`process_version`、`record_id`、`state`、`current_step`、`submitted_by`、`submitted_at` | data | main | — |
| `approval_work_items` | `org_id`、`work_item_id`、`instance_id`、`step_no`、`approver_group_id`、`state`、`acted_by`、`acted_at`、`comment`、`row_version` | data | main | — |
| `approval_locks` | `org_id`、`record_id`、`instance_id`、`editability` | data | main | `shard_no` |

### 2.9 レポートとダッシュボード（[reports-and-dashboards.md](reports-and-dashboards.md)）

| 表 | 主な列 | 種類 | 置き場所 | 保持 |
| --- | --- | --- | --- | --- |
| `md_report_types` | `org_id`、`report_type_id`、`api_name`、`base_object_id`、`joins`、`sections`、`is_standard`、`deployed` | meta | main | — |
| `report_folders`、`report_folder_shares` | `org_id`、`folder_id`、`kind`、`owner_id`、`grantee_group_id`、`access` | data | main | — |
| `reports` | `org_id`、`report_id`、`folder_id`、`report_type_id`、`definition`、`version`、`owner_id` | data | main | — |
| `report_runs` | `org_id`、`run_id`、`report_id`、`user_id`、`view_as_user_id`、`mode`、`state`、`as_of`、`s3_key`、`rows`、`db_ms`、`expires_at` | data | main・s3 | 24 時間 |
| `dashboards`、`dashboard_components` | `org_id`、`dashboard_id`、`folder_id`、`view_mode`、`filters`、`component_id`、`source_report_id`、`kind`、`settings` | data | main | — |
| `report_subscriptions`、`report_subscription_recipients` | `org_id`、`subscription_id`、`target_kind`、`target_id`、`owner_id`、`schedule`、`condition`、`recipient_kind`、`recipient_id` | data | main | — |
| `report_exports` | `org_id`、`export_id`、`report_id`、`user_id`、`rows`、`s3_key`、`created_at`、`expires_at` | data | main・s3 | 24 時間 |

### 2.10 検索（[search.md](search.md)）

| 表・索引 | 主な列 | 種類 | 置き場所 |
| --- | --- | --- | --- |
| `search_index_state` | `org_id`、`object_id`、`state`、`index_version`、`last_full_build_at` | data | main |
| `search_reindex_jobs` | `org_id`、`object_id`、`reason`、`last_id`、`state`、`started_at` | data | main |
| `search_consistency_progress` | `org_id`、`object_id`、`last_id`、`cycle_started_at`、`repaired` | data | main |
| `rec-v{n}-{00..15}` | 4.2 節の文書 | copy | os |

### 2.11 イベントと連携（[events-and-integrations.md](events-and-integrations.md)）

| 表 | 主な列 | 種類 | 置き場所 | 分割・保持 |
| --- | --- | --- | --- | --- |
| `change_events`・`org_events` | `org_id`、`replay_id`、`event_id`、`object_id`・`type_id`、`record_id`、`change_type`、`tx_key`、`tx_seq`、`body` | log | events | 日ごと、3 日 |
| `event_heads` | `org_id`、`max_replay_id` | data | events | — |
| `cdc_enabled_objects` | `org_id`、`object_id` | meta | main | — |
| `event_channels` | `org_id`、`name`、`objects`、`filter` | meta | main | — |
| `md_event_types`、`md_event_fields` | `org_id`、`type_id`、`api_name`、`publish_behavior`、`field_id`、`type` | meta | main | — |
| `event_subscriber_cursors` | `org_id`、`subscriber_kind`、`subscriber_id`、`source`、`replay_id` | data | main | — |
| `webhook_endpoints` | 5.1 節（秘密は組織の DEK） | data | main | — |
| `webhook_deliveries` | `org_id`、`endpoint_id`、`delivery_id`、`first_replay_id`、`last_replay_id`、`status`、`http_status`、`duration_ms`、`attempt`、`at` | log | main | 7 日 |
| `outbound_endpoints`、`outbound_call_log` | 6.1 節（秘密は組織の DEK） | data・log | main | ログ 7 日 |
| `email_sender_domains`、`email_suppressions` | `org_id`、`domain`、`dkim_state`、`address_hash`、`reason` | data | main | — |

### 2.12 一括とインポート（[bulk-and-import.md](bulk-and-import.md)）

| 表 | 主な列 | 種類 | 置き場所 | 保持 |
| --- | --- | --- | --- | --- |
| `bulk_jobs` | `org_id`、`id`、`kind`、`object_id`、`operation`、`external_id_field_id`、`state`、`source`、`created_by`、`rows_processed`、`rows_failed`、`metadata_version`、`created_at`、`completed_at`、`expires_at` | data | main | 7 日 |
| `bulk_parts` | `org_id`、`job_id`、`part_no`、`s3_key`、`rows`、`state`、`last_chunk`、`attempts` | data | main | 7 日 |
| `bulk_job_columns` | `org_id`、`job_id`、`col_no`、`header`、`field_id`、`parent_external_field_id` | data | main | 7 日 |
| `import_mappings` | `org_id`、`id`、`object_id`、`name`、`columns`、`owner_id` | data | main | — |
| S3 `bulk/<org>/<job>/...` | 元の CSV、部分、結果 | data | s3 | 24 時間・7 日 |

### 2.13 Sandbox とデプロイ（[sandboxes-and-deploy.md](sandboxes-and-deploy.md)）

| 表 | 主な列 | 種類 | 置き場所 |
| --- | --- | --- | --- |
| `sandbox_requests` | `org_id`（本番）、`id`、`name`、`kind`、`template_id`、`masking_profile_id`、`target_org_id`、`state`、`progress`、`requested_by` | data | main |
| `sandbox_templates` | `org_id`、`id`、`include_objects`、`exclude_objects`、`copy_files` | data | main |
| `masking_profiles` | `org_id`、`id`、`rules` | data | main |
| `metadata_retrieves` | `org_id`、`id`、`components`、`state`、`s3_key`、`expires_at` | data | main・s3 |
| `metadata_deploys` | `org_id`、`id`、`mode`、`state`、`base_version`、`result_version`、`plan_hash`、`plan_s3_key`、`validated_at`、`quick_until`、`rollback_of`、`requested_by`、`errors`、`warnings`、`post_jobs` | data | main・s3 |
| `inbound_packages` | `org_id`、`id`、`from_org_id`、`s3_key`、`sent_by`、`expires_at` | data | main・s3 |

### 2.14 上限と割り当て（[governor-limits.md](governor-limits.md)）

| 表 | 主な列 | 種類 | 置き場所 | 保持 |
| --- | --- | --- | --- | --- |
| `org_usage_minutes` | `org_id`、`alloc_id`、`minute`、`count` | data | main | 25 時間 |
| `org_allocations` | `org_id`、`alloc_id`、`max`、`overage_pct`、`source` | data | main | — |
| `org_db_time_minutes` | `org_id`、`cluster_id`、`minute`、`db_ms`、`path` | data | main | 7 日 |
| `jobs` | `org_id`、`class`、`id`、`state`、`available_at`、`cost_hint`、`attempts`、`payload_ref` | data | main | 7 日 |
| `org_vtime` | `class`、`org_id`、`vtime`、`weight`、`running` | ops | main | — |
| `tx_limit_peaks` | `org_id`、`day`、`limit_id`、`where_kind`、`where_ref`、`max_ratio`、`count` | data | main | 7 日 |

### 2.15 監査と履歴（[audit-and-field-history.md](audit-and-field-history.md)）

| 表 | 主な列 | 種類 | 置き場所 | 分割・保持 |
| --- | --- | --- | --- | --- |
| `audit_events` | 3.2 節 | log | main | 月ごと、180 日 |
| `audit_heads` | `org_id`、`last_seq`、`last_hash` | data | main | — |
| `audit_pending` | `org_id`、`id`、`payload`、`created_at` | data | main | 1 秒ごとに移す |
| `audit_anchors` | 日付、`org_id`、`seq`、`hash` | log | s3（log-archive、Object Lock） | 1 年 |
| 監査の外部の保管 | 組織ごとの日ごとの JSON Lines | log | s3（log-archive、Object Lock、組織の `audit` の DEK） | 1 年 |
| `audit_exports` | `org_id`、`id`、`from`、`to`、`state`、`requested_by` | data | main | — |
| `login_events` | 4 節 | log | main | 月ごと、180 日 |
| `field_history` | 5.2 節 | log | history | 月ごと、18 か月。outbox から Relay が写す |

### 2.16 利用者のコードとパッケージ（E13。[extensibility.md](extensibility.md)）

| 表 | 主な列 | 種類 | 置き場所 |
| --- | --- | --- | --- |
| `md_code_units` | `org_id`、`code_id`、`api_name`、`namespace`、`kind`、`object_id`、`events`、`order`、`run_as`、`active_version_id` | meta | main |
| `md_code_versions` | `org_id`、`version_id`、`code_id`、`source`、`bytecode`、`bytecode_hash`、`engine_version`、`built_at` | meta | main |
| `code_async_runs` | `org_id`、`version_id`、`record_id`、`origin_tx_id`、`attempts`、`state`、`ran_at` | log | main（7 日） |
| `code_debug_logs` | `org_id`、`id`、`code_id`、`tx_id`、`user_id`、`lines`、`created_at` | log | main（7 日） |
| `namespaces` | `namespace`、`owner_org_id`、`registered_at` | ops | control |
| `package_publisher_keys` | `owner_org_id`、`key_id`、`public_key`、`state`、`revoked_at` | ops | control |
| `package_versions` | `namespace`、`version`、`manifest_hash`、`signature`、`key_id`、`s3_key`、`published_at` | ops | control・s3 |
| `package_installs` | `org_id`、`namespace`、`version`、`installed_by`、`installed_at`、`approved_run_as` | data | main |

### 2.17 セキュリティ・基盤・可観測性・リリース

| 表 | 主な列 | 種類 | 置き場所 | 出典 |
| --- | --- | --- | --- | --- |
| `org_keys` | `org_id`、`purpose`、`key_version`、`wrapped_dek`、`kms_key_arn`、`state`、`created_at`、`destroyed_at` | ops | control | [security.md](security.md) |
| `support_access_grants` | `org_id`、`grant_id`、`granted_by`、`scope`、`expires_at`、`revoked_at` | data | main | security |
| `support_sessions` | `org_id`、`session_id`、`operator_id`、`role`、`approved_by`、`reason`、`started_at`、`ended_at` | log | main | security |
| `org_placements` | `org_id`、`cell_id`、`cluster_id`、`moved_at`、`reason` | ops | control | [infrastructure.md](infrastructure.md) |
| `clusters` | `cluster_id`、`cell_id`、`kind`、`writer_endpoint`、`reader_endpoint`、`purpose` | ops | control | infrastructure |
| `org_migrations` | `migration_id`、`org_id`、`from_cluster_id`、`to_cluster_id`、`state`、`fence_started_at`、`fence_ms`、`verify_result`、`requested_by` | ops | control | infrastructure |
| `org_request_minutes` | `org_id`、`minute`、`requests`、`errors_5xx`、`throttled_429`、`latency_buckets` | data | main | [observability.md](observability.md) |
| `org_aas_minutes` | `org_id`、`cluster_id`、`minute`、`aas`、`path` | data | main | observability |
| `org_worker_minutes` | `org_id`、`class`、`minute`、`busy_ms` | data | main | observability |
| `shadow_eval_results` | `id`、`org_id`、`flag`、`route`、`old_hash`、`new_hash`、`oracle_verdict`、`at` | ops | main | [delivery.md](delivery.md) |

## 3. 他の領域から依頼された列の追加

既存の表に、別の領域が列・値を足すよう依頼したもの。2026-09-28 の統合の工程で、全て持ち主の領域の文書に反映した。

| 表・列 | 追加 | 依頼した領域 | 反映した場所 |
| --- | --- | --- | --- |
| `records.parent_id` | 1 本目の主従の親、または活動の主の親（`what` があれば `what`、なければ `who`） | sales-objects（ADR-0021） | [data-storage.md](data-storage.md) の 3.1 節、ADR-0002 の注記 |
| `md_fields.data_class` | `none`・`personal`・`sensitive` | sandboxes-and-deploy（ADR-0038） | [metadata-and-runtime.md](metadata-and-runtime.md) の 3.1 節 |
| `md_fields.searchable` | 真偽（1 オブジェクト 20 まで） | search（ADR-0031） | metadata-and-runtime の 3.1 節 |
| `md_fields.track_history` | 真偽（1 オブジェクト 20 まで） | audit-and-field-history（ADR-0047） | metadata-and-runtime の 3.1 節 |
| `md_fields.state` の値 | `building`（積み上げ集計の作成・変更の間） | automation-flows（ADR-0027） | metadata-and-runtime の 3.1 節 |
| `md_fields.type` の値 | `polymorphic_lookup`（活動の `who`・`what`） | sales-objects（ADR-0021） | metadata-and-runtime の 3.3 節 |
| `md_objects.allow_activities` | 真偽（活動の `what` になれるか） | sales-objects | metadata-and-runtime の 3.1 節 |
| `md_objects.field_history_enabled` | 真偽（既存） | audit-and-field-history | metadata-and-runtime の 3.1 節 |
| `md_picklist_values.attrs` | フェーズ・リードの状態・ToDo の状態の属性 | sales-objects | metadata-and-runtime の 3.1 節 |
| `md_fields.field_id` の一意の範囲 | 「組織の系統（本番とその Sandbox）の中で一意」 | sandboxes-and-deploy（ADR-0038） | metadata-and-runtime の 3.2 節、ADR-0006 の注記 |
| 型の変換の古い `field_no` | 切り替えの後も 15 日残す（デプロイの戻しのため） | sandboxes-and-deploy（ADR-0040） | metadata-and-runtime の 5.2 節、ADR-0006 の注記 |
| `permission_sets.license` | 割り当てられるライセンス | orgs-users-and-auth（ADR-0043） | [sharing-and-record-access.md](sharing-and-record-access.md) の 3.2・16 節 |
| `permission_set_system_perms.perm` の値 | 25 のシステムの権限と依存 | orgs-users-and-auth（ADR-0045） | sharing-and-record-access の 3.2 節 |
| `orgs` の Sandbox の列 | `parent_org_id`、`sandbox_name`、`sandbox_kind`、`copied_at`、`refresh_available_at` | sandboxes-and-deploy | [orgs-users-and-auth.md](orgs-users-and-auth.md) の 3.1 節 |
| `orgs.migrating` | 補助の状態（503 `ORG_MIGRATING`） | infrastructure（ADR-0056） | orgs-users-and-auth の 3.1 節 |
| `outbox.kind` | `change_event`・`org_event`・`field_history`・`search_index`・`delivery`・`email`・`async`・`login_event` | events-and-integrations、audit-and-field-history | [data-storage.md](data-storage.md) の 3.5 節 |
| `object:<object_id>` の部品 | 有効なトリガーの表（E13）、検索の項目の一覧 | extensibility（ADR-0049）、search | metadata-and-runtime の 4.2 節、ADR-0007 の注記 |
| 部品の鍵 | 形の版を含める | delivery（ADR-0063） | metadata-and-runtime の 4.2 節、ADR-0007 の注記 |
| `report_types` の部品 | ADR-0007 の部品の一覧に足す | reports-and-dashboards | metadata-and-runtime の 4.2 節、ADR-0007 の注記 |
| `package.yaml` の項目 | `namespace`・`version`・`min_platform_version`・`requires`・`locked`・`signature` | extensibility（ADR-0050） | [sandboxes-and-deploy.md](sandboxes-and-deploy.md) の 5.1 節の形に足す（[extensibility.md](extensibility.md) の 8.2 節。JSON Schema は E13 で公開する） |
| `field_history` の置き場所 | 主のクラスタから `history` のクラスタへ（S1 から） | capacity（ADR-0060） | [audit-and-field-history.md](audit-and-field-history.md) の 5.2 節、ADR-0047・ADR-0060 の注記 |

## 4. RLS の外の表

組織の解決と運用のために、RLS をかけない表（20）。書けるのは管理のサービス、`cross-org-worker`、運用のロールだけ。CI のマイグレーションの検査の例外の許可リストと一致させる（[delivery.md](delivery.md) の 2.1 節）。

| 表 | 理由 | 書くもの |
| --- | --- | --- |
| `orgs`、`token_routes` | DB を読む前の組織の解決（ホスト名・トークン → `org_id`） | 管理のサービス、認証のサービス |
| `identity.auth_users`・`auth_accounts`・`auth_sessions`・`passkeys`・`two_factors`・`sso_providers` | 組織の解決の前のログイン。各行は `org_id` を持つ | 認証のサービスのロールだけ |
| `org_purge_log` | 消した組織の記録（組織の ID のハッシュだけ） | `cross-org-worker` |
| `shard_map`、`org_placements`、`clusters`、`org_migrations` | 組織の置き場所と移動 | 管理のサービス、`cross-org-worker` |
| `org_keys` | 組織の DEK。組織の消去の最後に消す | 管理のサービス、Worker |
| `org_vtime` | Worker の公平な順番（組織をまたいで最小を選ぶ） | Worker |
| `api_versions` | 本システムの API の版 | デプロイ |
| `namespaces`、`package_publisher_keys`、`package_versions` | 全ての組織で一意の名前空間と配布（E13） | 管理のサービス |
| `shadow_eval_results` | 影の実行の結果（値を持たない。30 日） | Runtime（影の実行） |

- RLS を外せる DB のロールは `admin_cross_org`（`cross-org-worker` だけ）と `maint`（分割の `DROP`、射影の DDL）に限る（[ADR-0054](../decisions/0054-accounts-network-and-service-separation.md)、[data-storage.md](data-storage.md) の 10 節）。

## 5. 置き場所ごとの数と、組織の移動

| 置き場所 | 表の数（2026-09-28） | 中身 |
| --- | --- | --- |
| `main`（RLS） | 約 140（E13 の 5 を含む） | メタデータ、レコードと写し、共有、自動化、レポート、一括、Sandbox とデプロイ、監査、上限と使用量 |
| `events`（RLS） | 3 | `change_events`、`org_events`、`event_heads` |
| `history`（RLS） | 1 | `field_history` |
| `control`・`identity`（RLS の外） | 20 | 4 節 |
| `s3`、`os` | — | 組織のファイル、監査の保管と錨、OpenSearch の索引 |

- 数は 2 節の表の数え方（1 行に 2 つの表を書いたものは 2 と数える）。表を足したら数え直す。
- **組織の移動の公開に入れる表は、機械的に作る**（[ADR-0056](../decisions/0056-org-migration-by-row-filtered-logical-replication.md)）：マイグレーションの定義から、`main`・`events`・`history` の表のうち `org_id` の列と RLS の方針を持つものを集め、手で書かない。CI で、この一覧と 2 節の表の置き場所が一致することを確かめる。RLS の外の表のうち `org_id` を持つもの（`identity.*`、`org_keys`、`org_vtime`、`org_placements`、`org_migrations`）は公開に入れず、移動の道具が個別に扱う。
- 組織の移動では、`events` の 3 日分と `history` の 18 か月分も、同じ方法で写す（[infrastructure.md](infrastructure.md) の 6.1 節）。

## 6. 保持

保持と消去の期限の正本は [security.md](security.md) の 7 節（[ADR-0053](../decisions/0053-operator-access-and-data-lifecycle.md)）。2 節の「分割・保持」の列はその写しで、食い違ったら security.md を正とする。期限の値は設定にし、法務の L5・L7 の結論で変えうる。

## 7. 段階ごとの変化

| 段階 | 変化 |
| --- | --- |
| S1 | 1 つのセル。主のクラスタ 1、`events` 1、`history` 1。`control` は主のクラスタの別のスキーマ |
| S2 | 主のクラスタを論理シャードの単位で複数に分け、Sandbox と試用を別のクラスタへ。大口の組織の射影の表（`proj_*`）と専用の検索の索引。`history` を論理シャードで分ける |
| S3 | セルを増やし、`control` を東京の小さな Aurora に分けて Global Database で大阪へ写す（[infrastructure.md](infrastructure.md) の 13 節の決定）。大口の組織の専用のセル |

## 8. 統合で決めたこと（2026-09-28）

- **索引だけに保つ。** 列の型と索引の全ては各領域の文書を正とし、この文書は写さない。二重に持つと食い違うため。複数の領域が列を足す表は、3 節に足した列と反映した場所を持つ。
- **`control` の置き場所**：S1・S2 は主のクラスタの別のスキーマ `control`（RLS の外の表）と `identity`（Better Auth の表）に置き、S3 で別の Aurora に移す。4 節の全ての表で確かめた（`namespaces` などの E13 の表も `control`）。
- **項目の変更の履歴は `history` のクラスタ**（ADR-0047・ADR-0060 の注記）。`opportunity_history` は、レポートで商談と結ぶので主のクラスタに残す。
- **`shard_no` で分割する表は 13**（data-storage.md の 4 節）：`records`、ピボットの 4 つ、`record_shares`、`implicit_parent_grants`、`group_members_closure`、`outbox`、`record_match_keys`、`activity_relations`、`flow_scheduled_actions`、`approval_locks`。S1 で約 3,300 の分割になる。
- **組織の移動の表の一覧は機械的に作る**（5 節）。起票の時の「`org_id` を持つ表は約 110」は、数え直して約 145（`main` 約 140、`events` 3、`history` 1）にした（[infrastructure.md](infrastructure.md) の 6.1 節を直した）。

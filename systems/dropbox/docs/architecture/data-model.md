# Data model: Dropbox（索引）

表と置き場所の索引。どの表・キー・待ち行列を、どの領域の文書が決めたかを引くためのもの。列・鍵・索引の詳しい形は、各行の「正本」の節にある。完全版（ER、全部の列、分割、保持）は、後の工程で `data-model/` に作る。

- テナントと名前空間の分け方、RLS の外の表とテナントをまたぐ経路（X1〜X5）は [ADR-0004](../decisions/0004-tenancy-namespaces-and-rls.md)。
- 名前空間の表は `tenant_id`・`ns_id` を持ち、RLS は `ns_id = ANY(app.ns_ids)`。テナントの表は `tenant_id` を持ち、RLS は `tenant_id = app.tenant_id`。ID は UUIDv7（`upload_id` だけは 128 ビットの乱数）。
- どの表にも、ファイルの名前・パス・中身を、決めた列（`nodes.name`、`node_versions.name`、検索の索引、`exports` の目録）の外に持たせない。

## 1. Aurora：名前空間の表（RLS は `ns_id`）

| 表 | 中身 | 正本 |
| --- | --- | --- |
| `namespaces` | 種類、根のノード、`ns_seq`、`floor_seq`、`logical_bytes`、`share_state`、継承の親、方針、`app_folder` | [metadata-and-journal.md](metadata-and-journal.md) の 13 節、[namespaces-and-sharing.md](namespaces-and-sharing.md) の 13 節、[api-and-webhooks.md](api-and-webhooks.md) の 11 節 |
| `nodes` | ノード（`kind` は `file`・`folder`・`mount`、`mount_ns_id`）、`name`・`name_key`、`rev_id`、`node_ver`、削除、`hidden_batch_id`、`exec_bit` | [ADR-0008](../decisions/0008-node-identity-and-names.md)、[metadata-and-journal.md](metadata-and-journal.md) の 13 節、[ADR-0024](../decisions/0024-shared-folder-mounts-and-grants.md) |
| `revisions` | 中身のリビジョン、`content_sha256`（申告）、`blocklist_hash`、ブロックの一覧か S3 の番地、`superseded_at`、`content_state`、`scan_state`・`verified_sha256`、`mime_hint` | [metadata-and-journal.md](metadata-and-journal.md)、[versions-and-recovery.md](versions-and-recovery.md)、[infrastructure.md](infrastructure.md) の 13 節、[security.md](security.md) の 16 節、[previews-and-thumbnails.md](previews-and-thumbnails.md) の 12 節 |
| `node_versions` | 置き場所のバージョンの履歴（時点の木） | [versions-and-recovery.md](versions-and-recovery.md) の 13 節 |
| `ns_journal` | ジャーナル（日の分割、92 日）。`op` は `upsert`・`delete`・`mount`・`unmount`・`purge` | [ADR-0005](../decisions/0005-namespace-journal-and-cursors.md)、[metadata-and-journal.md](metadata-and-journal.md) の 5 節 |
| `ns_batches`・`locked_subtrees` | 名前空間をまたぐ移動とコピー | [metadata-and-journal.md](metadata-and-journal.md) の 6 節 |
| `ns_block_refs` | 名前空間ごとのブロックの参照 | [ADR-0003](../decisions/0003-dedupe-scope-and-privacy.md)、[block-storage.md](block-storage.md) の 11 節 |
| `ns_mounts` | マウントのノードの写し | [ADR-0004](../decisions/0004-tenancy-namespaces-and-rls.md)、[ADR-0024](../decisions/0024-shared-folder-mounts-and-grants.md) |
| `ns_grants`・`ns_invites` | 権限の付与、共有の招待 | [namespaces-and-sharing.md](namespaces-and-sharing.md) の 13 節 |
| `shared_links`・`link_access_events` | 共有リンク、アクセスの記録（日の分割、90 日） | [shared-links.md](shared-links.md) の 13 節 |
| `preview_entries`・`extracted_texts` | プレビューのキャッシュの行、抽出したテキスト | [previews-and-thumbnails.md](previews-and-thumbnails.md) の 12 節 |
| `index_checkpoints` | 検索の索引の追いつき | [search.md](search.md) の 10 節 |
| `camera_upload_index` | カメラのアップロードの重複の防止（1 年） | [mobile-and-camera-upload.md](mobile-and-camera-upload.md) の 14 節 |
| `pending_purges` | 完全な削除の予約（24 時間） | [security.md](security.md) の 16 節 |

## 2. Aurora：テナントの表（RLS は `tenant_id`）

| 表 | 中身 | 正本 |
| --- | --- | --- |
| `blocks` | ブロックの索引（`block_id`、`state`、`ns_ref_count`、`pin_until`、S2 で `pack_id`） | [block-storage.md](block-storage.md) の 11 節 |
| `uploads`・`upload_blocks`・`upload_session_entries`・`block_grants` | アップロードと許可（`priority` を含む） | [block-storage.md](block-storage.md) の 11 節、[capacity.md](capacity.md) の 11 節 |
| `block_gc_log` | GC の記録（37 日） | [block-storage.md](block-storage.md) の 11 節 |
| `content_pending_blocks` | DR の後の中身の待ち | [infrastructure.md](infrastructure.md) の 13 節 |
| `members`・`groups`・`group_members` | メンバーとグループ | [accounts-and-teams.md](accounts-and-teams.md) の 18 節 |
| `team_domains`・`team_sso_configs`・`scim_tokens`・`team_invitations` | ドメイン、SSO、SCIM、チームの招待 | 同上 |
| `admin_role_assignments`・`admin_member_access_grants` | 管理の役割、管理者のアクセスの許可（法務の L7） | 同上 |
| `tenant_plans`・`tenant_usage` | プランと容量 | [accounts-and-teams.md](accounts-and-teams.md)、[namespaces-and-sharing.md](namespaces-and-sharing.md) の 13 節 |
| `team_policies` | チームの外への共有、リンク、カメラのアップロードなどの方針 | [namespaces-and-sharing.md](namespaces-and-sharing.md)、[shared-links.md](shared-links.md)、[mobile-and-camera-upload.md](mobile-and-camera-upload.md) |
| `team_app_policies` | アプリの許す・止める | [api-and-webhooks.md](api-and-webhooks.md) の 11 節 |
| `membership_copy_jobs` | 外したときの写しの作業 | [namespaces-and-sharing.md](namespaces-and-sharing.md) の 13 節 |
| `rewind_jobs`・`rewind_skips`・`mass_change_events`・`tenant_retention_settings` | 巻き戻し、一斉の変更の検知、プランの保持の期間 | [versions-and-recovery.md](versions-and-recovery.md) の 13 節 |
| `camera_upload_settings`・`notification_events` | カメラのアップロードの設定、通知（90 日） | [mobile-and-camera-upload.md](mobile-and-camera-upload.md) の 14 節 |
| `tenant_audit_events` | 管理と安全の事象（月の分割） | [security.md](security.md) の 16 節、[ADR-0045](../decisions/0045-audit-log-and-data-lifecycle.md) |
| `legal_holds`・`tenant_purge_jobs` | 法的な保全（法務の L6）、解約の後の消去 | [security.md](security.md) の 16 節 |

## 3. Aurora：RLS の外の表（専用の DB のロールだけ）

| 表 | 中身 | 正本 |
| --- | --- | --- |
| `auth` スキーマ：`accounts`（`access_version`・`auth_epoch`）、`account_emails`、Better Auth の表、`web_sessions` | アカウントとログイン | [accounts-and-teams.md](accounts-and-teams.md) の 18 節 |
| `tenants` | テナントの種類・プラン・状態・地域 | 同上 |
| `devices`・`device_credentials`・`device_wipe_reports`・`push_tokens` | 端末と資格、消去の報告、通知のトークン | 同上、[desktop-client.md](desktop-client.md) の 15 節、[mobile-and-camera-upload.md](mobile-and-camera-upload.md) の 14 節 |
| `ns_access`・`ns_directory` | 主体 → 名前空間、名前空間 → テナント（S2 でクラスタ・`search_cohort`） | [ADR-0004](../decisions/0004-tenancy-namespaces-and-rls.md)、[namespaces-and-sharing.md](namespaces-and-sharing.md) の 13 節 |
| `link_tokens` | 共有リンクのトークンのハッシュ → リンク | [shared-links.md](shared-links.md) の 13 節 |
| `oauth_apps`・`oauth_grants`・`oauth_tokens`・`oauth_codes`・`webhook_deliveries` | OAuth のアプリと Webhook | [api-and-webhooks.md](api-and-webhooks.md) の 11 節 |
| `abuse_reports` | 共有リンクの通報（運用のロールだけ） | [shared-links.md](shared-links.md) の 13 節 |
| `plan_features`・`retention_policies` | プランの機能と上限、データの種類ごとの保持の期間 | [accounts-and-teams.md](accounts-and-teams.md) の 7.1 節、[security.md](security.md) の 8.1 節 |

## 4. Aurora：保守用のスキーマ

| 表 | 中身 | 正本 |
| --- | --- | --- |
| `platform_state` | 全体の `epoch`、`dr_failover_at` | [infrastructure.md](infrastructure.md) の 13 節 |
| `platform_audit_events`・`audit_chain_heads` | プラットフォームの事象、監査の連鎖 | [security.md](security.md) の 16 節 |
| `delivery_samples`・`integrity_audit_runs`・`slo_minutely` | SLI の業務の記録 | [observability.md](observability.md) の 13 節 |
| `tenant_directory`（S2 からディレクトリのクラスタ） | テナント → クラスタ・セル・リージョン | [infrastructure.md](infrastructure.md) の 13 節 |

## 5. Aurora の外の置き場所

| 置き場所 | 中身 | 正本 |
| --- | --- | --- |
| S3 `incoming`・`blocks`・`blocklists` | ブロック（`u/<upload_id>/<n>`、`b/<sc>/<h4>/<tenant_id>/<hash>`）、大きな一覧、S2 でパック（`pk/`） | [ADR-0007](../decisions/0007-block-storage-layout-on-s3.md)、[ADR-0020](../decisions/0020-small-block-packing-for-s2.md) |
| S3 `previews` | プレビューのキャッシュ、抽出したテキスト（90 日） | [previews-and-thumbnails.md](previews-and-thumbnails.md) の 12 節 |
| S3 `exports` | 組み立てたダウンロードと目録（1 日） | [ADR-0054](../decisions/0054-server-assembled-downloads.md) |
| S3 `audit` | 監査の写し、活動の事象（`activity/`、Parquet、Athena） | [security.md](security.md) の 7 節 |
| S3（`release` のアカウント） | 更新の目録と成果物 | [delivery.md](delivery.md) の 12 節 |
| SQS | `block-verify`、`preview-jobs-interactive`、`preview-jobs`、`text-extract-jobs`、`scan-jobs`、`sandbox-results`、`index-names`（FIFO）、`export-jobs`、`export-results` | 各領域 |
| OpenSearch | `names-v<N>`、`content-v<N>` | [search.md](search.md) の 10 節 |
| Valkey | `path:`、`acc:`、`dlurl:`、`ns_head:`、`ns_tail:`、`upload_bucket:`、`wh:pending:`、レート制限、取り消しの一覧（30 日） | [metadata-and-journal.md](metadata-and-journal.md)、[namespaces-and-sharing.md](namespaces-and-sharing.md)、[block-storage.md](block-storage.md)、[capacity.md](capacity.md)、[api-and-webhooks.md](api-and-webhooks.md)、[accounts-and-teams.md](accounts-and-teams.md) |
| AppConfig | `release.*`、`ops.*`、`content_scan_policy`、`client.*` | [delivery.md](delivery.md) の 3 節 |
| Firehose・CloudWatch Logs・AMP | 活動の事象、端末の計測の生の記録（90 日）と集計 | [security.md](security.md) の 7 節、[observability.md](observability.md) の 13 節 |

## 6. 端末の上（SQLite と OS の鍵の保管庫）

| 表・保管 | 中身 | 正本 |
| --- | --- | --- |
| `remote_nodes`・`local_nodes`・`synced_nodes` | 3 つの木（`local_name`、`file_id`、`hydration`、`scan_gen` を含む） | [sync-engine.md](sync-engine.md) の 18 節、[file-system-integration.md](file-system-integration.md) の 14 節 |
| `intents`・`pending_commits`・`held_deletes`・`cursors`・`sync_meta` | 意図の記録、送った commit、止めた削除、カーソル、端末の設定 | [ADR-0010](../decisions/0010-local-state-db-and-intent-log.md)、[desktop-client.md](desktop-client.md) の 15 節 |
| `local_blocks`、アップロードの再開の行 | 手元のブロックの索引 | [block-storage.md](block-storage.md) の 11 節 |
| `camera_assets`・`offline_pins` | モバイルのカメラのアップロードとオフラインの保存 | [mobile-and-camera-upload.md](mobile-and-camera-upload.md) の 14 節 |
| OS の鍵の保管庫 | 端末の秘密鍵、更新トークン、プロキシの資格、モバイルのオフラインのファイルの鍵 | [ADR-0041](../decisions/0041-accounts-auth-and-device-credentials.md)、[ADR-0044](../decisions/0044-encryption-keys-and-secrets.md) |

## 7. 統合の工程で揃えた名前

- `epoch` は `namespaces` の列にせず、`platform_state` の全体の 1 つの値にした。
- 照合の結果は `integrity_audit_runs`（block-storage の `blocks_audit_runs` を直した）。ブロックは `block_id` で指す。
- プランのバージョンの保持の期間は `tenant_retention_settings`、データの種類ごとの保持は `retention_policies`。
- `nodes.kind` に `mount` を足し、`mount_ns_id` を持つ（`ns_mounts` は写し）。
- 共有リンクのトークンの接頭辞は `<brand>_sl_`。

## 8. 完全版で決めること

| 項目 | 持ち主 |
| --- | --- |
| `node_versions` の行の数と分割（S1 で数十億行） | Dev（E8 の前に合成で測る） |
| `ns_journal` の保持（92 日か、法務の L6 の結果）と容量（[capacity.md](capacity.md) の 5.1 節） | Dev、法務の L6 |
| `ns_mounts` をビューにするか表のまま写すか | Dev |
| `nodes.is_folder` を `kind` に置き換えるか、両方を持つか | Dev（E3 の `nodes-and-revisions`） |
| `names_version` の影の列（`name_key_next`）をジャーナルに載せるか | Dev（[delivery.md](delivery.md) の 6.3 節） |

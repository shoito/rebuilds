# Data model: Google Calendar

データモデルの索引。表と置き場所を、持ち主の領域ごとに並べる。列・キー・索引の詳細は、各領域の文書の「data-model への項目」の節が正本である。ER 図、列の型の正本、横断の不変条件をまとめた完全版は、後の工程で作る（[README.md](README.md) の 6 節の持ち越し）。

## 1. 規約

| 項目 | 規約 | 根拠 |
| --- | --- | --- |
| テナント | 組織を 1 つ、個人のアカウントを 1 人 1 つのテナントにする。テナントの表は `tenant_id` を主キーと索引の先頭に置き、FORCE RLS と `SET LOCAL app.tenant_id` で分ける | [ADR-0004](../decisions/0004-tenancy-and-rls.md) |
| テナントの外 | RLS の外の表は、`auth` スキーマと保守用のスキーマ（`ops`）の、ADR-0004 の一覧の表だけ。予定の中身の列を持たない（3 節） | ADR-0004 |
| ID | UUIDv7。予定オブジェクトは UID（iCalendar）も持つ。回は `(event_object_id, recurrence_id)` で、`recurrence_id` は回の元の開始の壁時計の時刻＋TZID（終日は日付） | [ADR-0003](../decisions/0003-recurrence-storage-and-expansion.md) |
| 時刻 | 正本は壁時計の時刻＋TZID（`zoned`）、`utc`、`floating`、`date`。UTC の瞬間は派生の値で、`tzdata_version` と一緒に持つ | [ADR-0002](../decisions/0002-time-representation.md) |
| 版 | 予定オブジェクトの `version`（どの項目でも上がる。ETag・`object_version` の元）、`sequence`（iTIP。意味のある変更だけ）、主催者の版（`organizer_version`）、カレンダーの `change_seq`、会議室の `booking_seq`。展開の索引の行の `object_version` は、その行が最後に変わった版 | [ADR-0003](../decisions/0003-recurrence-storage-and-expansion.md)、[ADR-0005](../decisions/0005-change-log-and-sync-tokens.md)、[ADR-0010](../decisions/0010-occurrence-index-maintenance.md)、[ADR-0014](../decisions/0014-itip-state-transfer-and-sequence.md) |
| 書き込み | 予定・カレンダー・ACL を変える書き込みは `packages/writer` だけで、`change_seq`・`calendar_changes`・outbox を同じトランザクションで書く。DB のロールで直接の `UPDATE` を拒む | [ADR-0005](../decisions/0005-change-log-and-sync-tokens.md) |
| 写し | 展開の索引、検索の表、空き時間のキャッシュ、Web の手元の DB は、正本から作り直せる写し | [ADR-0003](../decisions/0003-recurrence-storage-and-expansion.md)、[ADR-0034](../decisions/0034-search-pg-bigm-acl-aware.md)、[ADR-0017](../decisions/0017-freebusy-source-and-cache.md)、[ADR-0039](../decisions/0039-offline-read-cache-and-local-data.md) |
| 排他の制約 | 会議室の予約の行（`accepted` どうし）と、予約ページの予約の区間（`held`・`confirmed` どうし）に `btree_gist` の排他の制約 | [ADR-0019](../decisions/0019-room-booking-rows-and-recurring-acceptance.md)、[ADR-0033](../decisions/0033-booking-creation-and-exclusion.md) |
| 秘密 | 照らすだけの秘密は `*_hash`（SHA-256）、平文が要る秘密は `*_ciphertext`（封筒の暗号化）。他の名前で秘密を持たない | [ADR-0041](../decisions/0041-encryption-keys-and-secret-storage.md) |
| 保持 | 期間の正本は `retention_policies` と [ADR-0042](../decisions/0042-audit-log-and-data-lifecycle.md) の表。時間で消えるものは分割を落とす（法務の L5 の後に確定） | ADR-0042 |

## 2. 表の索引（Aurora）

| 領域（持ち主） | 表 | 種類 | 詳細 |
| --- | --- | --- | --- |
| 予定と繰り返し | `event_objects`（UID、マスター、規則、時刻の種類、派生の値、`version`・`sequence`、`series_end_utc`・`indexed_through`、`recurrence_flags`、`split_from`、`x_props`、`visibility`、写しの列） | テナント | [events-and-recurrence.md](events-and-recurrence.md) の 15 節、[invitations-and-itip.md](invitations-and-itip.md) の 17 節 |
| 予定と繰り返し | `event_overrides`（`recurrence_id` ごとの VEVENT の全体、`detached_fields`、`orphan`） | テナント | 同上 |
| 予定と繰り返し | `occurrences`（展開の索引。月の分割。影の表 `occurrences_v<N>` は形の変更の間だけ） | テナント（写し） | 同上、[delivery.md](delivery.md) の 13 節 |
| タイムゾーン | `calendars.timezone`（列） | テナント | [time-zones-and-holidays.md](time-zones-and-holidays.md) の 16 節 |
| 招待 | `event_attendees`、`pending_invitations`、`itip_dedupe`、`group_membership_changes`、`imip_addresses`、`imip_send_quota`（上書き）、`imip_suppression`、`unverified_replies`、`invite_intake_settings`、`invite_known_senders` | テナント | [invitations-and-itip.md](invitations-and-itip.md) の 17 節 |
| 空き時間 | `working_hours`、関数 `freebusy_for` | テナント | [free-busy-and-scheduling.md](free-busy-and-scheduling.md) の 12 節 |
| 会議室 | `buildings`、`resources`（`booking_seq`、`address_token`）、`resource_features`、`resource_feature_instances`、`resource_policies`、`resource_bookings`（排他の制約） | テナント（組織だけ） | [rooms-and-resources.md](rooms-and-resources.md) の 15 節 |
| 共有と権限 | `calendars`（`kind`・`owner_principal`・`default_visibility`・`floor_seq`・`change_seq`）、`calendar_acl`、`org_sharing_policies` | テナント | [sharing-and-acl.md](sharing-and-acl.md) の 16 節、[sync-and-caldav.md](sync-and-caldav.md) の 15 節 |
| 同期と CalDAV | `calendar_changes`（日の分割、`origin_msg_id`）、`deleted_event_objects`、`caldav_hrefs`、`ics_subscriptions`、`ics_publish_tokens`、`ics_export_jobs` | テナント | [sync-and-caldav.md](sync-and-caldav.md) の 15 節 |
| 公開 API | `api_idempotency`、`oauth_apps`、`oauth_grants`、`oauth_tokens`、`push_channels`、`push_deliveries`（7 日） | テナント | [api-and-push.md](api-and-push.md) の 13 節 |
| 通知 | `notifications`、`push_subscriptions`、`notification_settings`、`email_suppressions`、`calendar_list_entries`（`default_reminders`）、`calendar_list_reminder_subscribers` | テナント | [reminders-and-notifications.md](reminders-and-notifications.md) の 17 節 |
| 予約ページ | `booking_pages`、`booking_availability`、`booking_date_overrides`、`booking_questions`、`bookings`、`booking_reservations`（排他の制約）、`booking_idempotency` | テナント | [booking-pages.md](booking-pages.md) の 16 節 |
| 検索 | `event_search_docs`（テナントのハッシュで 16 の分割、`gin_bigm_ops`） | テナント（写し） | [search.md](search.md) の 14 節 |
| アカウントと組織 | `users`、`groups`、`group_members`、`org_domains`、`sso_connections`、`scim_tokens`、`org_settings`（認証・OAuth のアプリ・予約ページの方針）、`admin_role_assignments`、`admin_access_grants`、`tenant_moves` | テナント | [accounts-and-orgs.md](accounts-and-orgs.md) の 21 節 |
| Web の画面 | `user_preferences` | テナント | [clients.md](clients.md) の 18 節 |
| セキュリティ | `tenant_audit_events`（月の分割、`actor_id`・`on_behalf_of`）、`sender_reputation` | テナント | [security.md](security.md) の 16 節、[ADR-0042](../decisions/0042-audit-log-and-data-lifecycle.md) |
| 基盤 | `outbox` | テナント | [ADR-0005](../decisions/0005-change-log-and-sync-tokens.md) |

## 3. テナントの外の表

[ADR-0004](../decisions/0004-tenancy-and-rls.md) の「RLS の外の表の許可リスト」の正本はその ADR にあり、ここは置き場所の索引である。マイグレーションの検査は、`tenant_id` と FORCE RLS のない表を、この一覧の表だけに許す。

| スキーマ | 表 | 読み書きするロール（ADR-0004 の経路） | 詳細 |
| --- | --- | --- | --- |
| `auth` | Better Auth の表（アカウント、セッション、パスキー、外部のアカウント、検証の値）、`app_passwords` | `auth` | [accounts-and-orgs.md](accounts-and-orgs.md) の 21 節 |
| `ops` | `tenants`（`kind`、`status` に `suspended`・`purging`・`moving`） | 全サービス（読み）、管理と削除のジョブ | 同上、[security.md](security.md) の 16 節 |
| `ops` | `principal_directory`（正規化したメールアドレス → テナントと主体） | `resolver`（X6）、`itip_delivery`、`freebusy` | [accounts-and-orgs.md](accounts-and-orgs.md) の 4 節 |
| `ops` | 解決の表：`booking_slug_directory`、`ics_publish_token_directory`、`imip_address_directory`、`oauth_client_directory`、`moved_event_objects`（90 日） | `resolver`（X6）、`itip_delivery`（X1） | [booking-pages.md](booking-pages.md)、[sync-and-caldav.md](sync-and-caldav.md)、[invitations-and-itip.md](invitations-and-itip.md)、[api-and-push.md](api-and-push.md)、[accounts-and-orgs.md](accounts-and-orgs.md) |
| `ops` | `reminder_plans`（`fire_day` の分割）、`reminder_plan_heads`、`reminder_deliveries`（35 日、`dr_window`）、`reminder_shard_leases` | `reminder_clock`（X5） | [reminders-and-notifications.md](reminders-and-notifications.md) の 17 節 |
| `ops` | `tenant_tz_usage`、`tz_recompute_runs` | `tz_maintenance`（X7） | [time-zones-and-holidays.md](time-zones-and-holidays.md) の 16 節 |
| `ops` | SLI の記録：`itip_deliveries`（14 日）、`itip_fanout_progress`、`imip_outbound_log`（90 日）、`imip_inbound_log`、`sync_token_uses`（90 日）、`reconciliation_findings` | 書くのは各 Worker、読むのは `slo_aggregator`（X9） | [observability.md](observability.md) の 12 節 |
| `ops` | `platform_state`（`dr_epoch_started_at`、全体の `sync_epoch`）、`platform_audit_events`、`retention_policies`、`legal_holds` | DR のワークフロー、セキュリティの担当 | [infrastructure.md](infrastructure.md) の 15 節、[security.md](security.md) の 16 節 |

## 4. Aurora の外の置き場所

| 置き場所 | 中身 | 詳細 |
| --- | --- | --- |
| Valkey | 合図の pub/sub、空き時間のキャッシュ（`fb:*`・`fbr:*`）、レート制限（`rl:*`）、書き込みの枠（`cw:*`・`cwlat:*`）、Webhook の待ち（`push:*`）、取り消しの一覧、照合の結果の写し（60 秒）、CalDAV の認証の失敗の数、送信の上限の数。失ってよい | [free-busy-and-scheduling.md](free-busy-and-scheduling.md)、[capacity.md](capacity.md)、[api-and-push.md](api-and-push.md)、[sync-and-caldav.md](sync-and-caldav.md) |
| S3 | iMIP の受信の生のメール（30 日）、ICS の取り込み・書き出し（7 日）、ICS の購読の本文（6 時間）と UID のハッシュ、Web の資産（版ごと 30 日）、`/tzdata/<version>/<zone>.bin`、監査ログの写し（log-archive、Object Lock） | [infrastructure.md](infrastructure.md) の 4 節、[ADR-0042](../decisions/0042-audit-log-and-data-lifecycle.md) |
| AppConfig | `release.*`（kebab-case）、`ops.*`（snake_case）、`tzdata.active_version` | [delivery.md](delivery.md) の 3 節 |
| CloudFront KeyValueStore | Web の版ごとの割合 | [delivery.md](delivery.md) の 5 節 |
| Web の手元（IndexedDB `cal-<account_id>`） | `calendars`、`objects`、`tokens`、`tzdata`、`prefs`、`_meta` | [ADR-0039](../decisions/0039-offline-read-cache-and-local-data.md) |
| データのパッケージ | `packages/tzdata`（版、遷移、別名、`windowsZones`、遷移の指紋）、`packages/holidays-jp`（祝日の規則、春分・秋分、例外、元号） | [time-zones-and-holidays.md](time-zones-and-holidays.md) の 16 節 |
| S2 のディレクトリのクラスタ | `tenant_directory`、`account_directory`、`imip_address_directory` | [ADR-0045](../decisions/0045-stage-up-criteria-tenant-sharding-and-cells.md) |

## 5. 名前の揃え

統合の工程（2026-10-04）で、次の名前を揃えた。

| 揃えた名前 | 前の書き方 | 文書 |
| --- | --- | --- |
| `resources.booking_seq` | `rooms` の行・`rooms` に足す列 | rooms-and-resources、free-busy-and-scheduling |
| `tenant_audit_events`・`platform_audit_events` | `audit_log` | sharing-and-acl |
| `admin_access_grants` | `org_admin_audit`（`redact()` の主体） | sharing-and-acl |
| `calendars.kind`：`primary`・`secondary`・`shared`・`resource`・`subscription`・`system` | `standard`・`subscription`・`system`（sync-and-caldav）、主・追加・共有・会議室・システム（sharing-and-acl） | sync-and-caldav、sharing-and-acl |
| `reminder_deliveries` の鍵：（利用者, 予定オブジェクト, `recurrence_id`, 方法, 分, 回の開始） | `(reminder_id, occurrence_start, method, version)` | README、AGENTS.md、ADR-0046 |
| 遅れすぎ：計画の行の `skipped_late` | `outcome = too_late` | ADR-0046、observability |

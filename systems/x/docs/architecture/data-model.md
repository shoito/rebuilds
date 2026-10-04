# Data model: X

データモデルの索引。表と置き場所を、持ち主の領域ごとに並べる。列・キー・索引の詳細は、各領域の文書の「data-model への項目」の節が正本である。ER 図、列の型の正本、横断の不変条件をまとめた完全版は、後の工程で作る（[README.md](README.md) の 6 節の持ち越し）。

## 1. 規約

| 項目 | 規約 | 根拠 |
| --- | --- | --- |
| テナント | なし。テナントの列と RLS を置かない | [ADR-0004](../decisions/0004-single-tenant-and-visibility.md) |
| 表の種類 | 公開の表（見える範囲は `visible()`）、本人だけの表（`owner_id` と FORCE RLS）、参加者の表（DM）、運用の表（決まったロールだけ）、`auth` スキーマ（Better Auth） | ADR-0004、[ADR-0043](../decisions/0043-auth-methods-and-sessions.md) |
| ID | 投稿・利用者・DM のメッセージ・メディア・短縮 URL は 64 ビットの `tid`（`bigint`、API では 10 進の文字列）。その他は UUIDv7 | [ADR-0002](../decisions/0002-post-ids-and-ordering.md) |
| 状態の版 | 投稿・メディアは `state_version`、関係は `users.graph_version` を上げ、写しは版の新しいものだけを書く | [ADR-0009](../decisions/0009-post-state-tombstones-and-state-cache.md)、[ADR-0012](../decisions/0012-viewer-sets-cache.md) |
| 写し | Valkey・OpenSearch・数の表（`post_counters`・`user_counters`）は写しで、正本から作り直せる | [ADR-0003](../decisions/0003-timeline-fanout-hybrid.md)、[ADR-0005](../decisions/0005-event-log-and-outbox.md) |
| 削除 | 行を消さずに墓石にし、物理の削除は保持の期間の後のジョブだけ。`legal_holds` で止まる | [ADR-0053](../decisions/0053-data-lifecycle-and-retention.md) |
| 暗号化 | 電話・メール・生年月日・IP は `*_ct` の列に封筒の暗号化、検索は `*_hmac` の列。DM の本文は会話ごとの鍵 | [ADR-0051](../decisions/0051-encryption-and-key-layout.md)、[ADR-0035](../decisions/0035-dm-conversation-model-and-storage.md) |

## 2. 表の索引（Aurora）

| 領域（持ち主） | 表 | 種類 | 詳細 |
| --- | --- | --- | --- |
| 投稿 | `posts`、`post_requests`、`post_mentions`、`post_hashtags`、`post_urls`、`short_links`、`post_media`、`tid_generator_leases`、`post_origin_logs`、`author_posts`・`conversation_posts`（S2） | 公開・運用 | [posts-and-ids.md](posts-and-ids.md) の 12 節 |
| 投稿 | `drafts` | 本人だけ | 同上 |
| 関係 | `following`、`followers`、`blocks`、`blocked_by`、`graph_shard_map`（S2） | 公開 | [follow-graph.md](follow-graph.md) の 11 節 |
| 関係 | `mutes`、`muted_words` | 本人だけ | 同上 |
| タイムライン | `fanout_mode_log` | 運用 | [timeline-fanout.md](timeline-fanout.md) の 13 節 |
| エンゲージメント | `likes`、`user_likes`、`reposts`、`post_counters`、`user_counters`、`counter_reconcile_log`、`view_daily_corrections` | 公開・写し・運用 | [engagement-and-counters.md](engagement-and-counters.md) の 9 節 |
| エンゲージメント | `bookmarks` | 本人だけ | 同上 |
| ランキング | `ranking_models`、`ranking_experiments` | 運用 | [ranking-and-recommendation.md](ranking-and-recommendation.md) の 16 節 |
| ランキング | `ranking_feedback` | 本人だけ | 同上 |
| 検索とトレンド | `search_reindex_jobs`、`trend_snapshots`、`trend_baselines`、`trend_overrides` | 運用 | [search-and-trends.md](search-and-trends.md) の 11 節 |
| 通知 | `notifications`、`notification_actors`、`notification_cursors`、`notification_settings`、`push_devices`、`push_deliveries` | 本人だけ | [notifications.md](notifications.md) の 11 節 |
| メディア | `media`、`media_upload_sessions`、`media_variants`、`media_hash_blocklist`、`media_match_results`、`media_takedowns` | 公開・運用（照合の結果は T&S だけ） | [media.md](media.md) の 13 節 |
| DM | `dm_conversations`、`dm_participants`、`dm_messages`、`dm_requests` | 参加者（`dm_requests` は送り手と受け手） | [direct-messages.md](direct-messages.md) の 14 節 |
| DM | `dm_message_hidden`、`dm_settings` | 本人だけ | 同上 |
| T&S | `moderation_actions`、`moderation_action_events`、`reports`、`report_evidence`、`moderation_cases`、`appeals`、`account_risk`、`rate_multipliers`、`ts_rules`、`legal_cases`、`legal_holds`、`disclosure_exports` | 運用（T&S と法務のロール） | [trust-and-safety.md](trust-and-safety.md) の 14 節 |
| アカウント | `users`（`account_mod`・`graph_version`・`fanout_mode`・`pinned_post_id`・`flags` を含む）、`profiles`、`handle_holds`、`account_state_history` | 公開・運用 | [accounts-and-auth.md](accounts-and-auth.md) の 12 節 |
| アカウント | `user_settings`、`user_contacts`、`user_birthdates`、`login_events`、`data_export_requests` | 本人だけ | 同上 |
| アカウント | `auth.user`・`auth.session`・`auth.account`・`auth.verification`・`auth.passkey` | `auth` スキーマ | 同上 |
| 公開 API | `developer_accounts`、`apps`、`app_credentials`、`oauth_tokens`、`api_usage_daily` | 運用 | [api-and-rate-limits.md](api-and-rate-limits.md) の 10 節 |
| 公開 API | `oauth_grants` | 本人だけ | 同上 |
| セキュリティ | `audit_events`、`retention_policies` | 運用（追記だけ・決まったロール） | [security.md](security.md) の 13 節 |
| 基盤 | `outbox`（`sent_at`、1 時間ごとの区画）、`stream_leases`、`stream_checkpoints`、`relay_partitions` | 運用 | [infrastructure.md](infrastructure.md) の 14 節 |
| 可観測性 | `visibility_audit_findings` | 運用 | [observability.md](observability.md) の 11 節 |

## 3. 本人だけの表（FORCE RLS）

[ADR-0004](../decisions/0004-single-tenant-and-visibility.md) の一覧の正本。マイグレーションの検査（[ADR-0061](../decisions/0061-ci-gates.md)）は、この一覧の表に `owner_id` と FORCE RLS があることを確かめる。

| ポリシー | 表 |
| --- | --- |
| 本人（`owner_id = app.actor_id`） | `drafts`、`mutes`、`muted_words`、`bookmarks`、`ranking_feedback`、`notifications`、`notification_actors`、`notification_cursors`、`notification_settings`、`push_devices`、`push_deliveries`、`user_settings`、`user_contacts`、`user_birthdates`、`login_events`、`data_export_requests`、`oauth_grants`、`dm_message_hidden`、`dm_settings` |
| 参加者（`dm_participants` を `EXISTS` で引く） | `dm_conversations`、`dm_participants`、`dm_messages` |
| 送り手と受け手 | `dm_requests` |

- 本人だけの表を読む運用の処理は、決まったロール（`ts_reader`、`counter_reconciler` など）で理由を記録して読む（ADR-0004、[ADR-0052](../decisions/0052-audit-and-operator-access.md)）。
- 通知の Worker は受け手ごとに `SET LOCAL app.actor_id` して書く（[notifications.md](notifications.md) の 5.1 節）。

## 4. DB の外の置き場所

| 置き場所 | 中身 | 詳細 |
| --- | --- | --- |
| Valkey `vk-timeline` | `tl:`、`ar:`、`pl:`、`tlb:`、`fanout:pull_any`、`cv:` | [timeline-fanout.md](timeline-fanout.md) の 4 節、[infrastructure.md](infrastructure.md) の 5 節 |
| Valkey `vk-cache` | `ps:`・`as:`・`pb:`（投稿と作者の状態）、`vb:`・`vm:`・`vp:`・`vw:`・`vv:`・`vl:`（閲覧者の集合）、`pf:`・`af:`・`va:`・`vf:`・`ae:`・`th:`・`tp:`・`pop:jp`・`seen:`・`rk:`・`rr:`（ランキング）、`gs:`（関係の信号）、`ts:rl:`（T&S の規則）、`tc:`・`td:`・`tb:`・`trends:`（トレンド） | 各領域の文書 |
| Valkey `vk-counters` | `pc:`・`uc:`（数と部分ごとの最後の連番）、`pcd:` | [engagement-and-counters.md](engagement-and-counters.md) の 9 節 |
| Valkey `vk-edge` | `sess:`・`tok:`（セッションとトークン）、`rl:`（レート制限）、`usage:`（計量）、`vbatch:`、`nu:`・`nh:`・`nha:`・`nhr:`（通知）、`dmrq:`、pub/sub `dm:{user_id}`・`sess:revoked` | [accounts-and-auth.md](accounts-and-auth.md)、[api-and-rate-limits.md](api-and-rate-limits.md)、[notifications.md](notifications.md)、[direct-messages.md](direct-messages.md) |
| Kinesis Data Streams | `posts`、`graph`、`engagement`、`moderation`、`accounts`、`views`、`dm`、`audit` | [ADR-0005](../decisions/0005-event-log-and-outbox.md)、[infrastructure.md](infrastructure.md) の 6 節 |
| Firehose（直接） | `ranking-served`、`api-usage`、`visibility-audit`、`rum` | ADR-0005 |
| SQS | `fanout-small`・`fanout-large`、`push-send`、`email-digest`、`media-jobs`、`graph-cache-repair` と各 DLQ | 各領域の文書 |
| OpenSearch | `posts-YYYYMM`（別名 `posts-read`）、`users-v1`、`hashtags-v1` | [search-and-trends.md](search-and-trends.md) の 11 節 |
| S3 | メディア（`uploads`・`public`・`private`・`quarantine`）、データレイク（Iceberg：`ranking_served`、`ranking_training_sets`、`ranking_eval_reports`、`ts_*_daily` ほか）、log-archive（`audit/`、`edge-logs/`）、OTA の束 | [media.md](media.md)、[security.md](security.md)、[infrastructure.md](infrastructure.md) |
| CloudFront KeyValueStore | `media-deny` | [media.md](media.md) の 8.4 節 |
| AppConfig | `release.*`・`ops.*`・`experiment.*`、`policy.*`・`retention.*`・`legal.*`・`ts.*` | [delivery.md](delivery.md) の 3 節 |

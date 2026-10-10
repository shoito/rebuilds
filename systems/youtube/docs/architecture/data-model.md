# Data model: YouTube

表と置き場所の索引。どの領域が、どの置き場に、何を持つかを一覧にする。列・主キー・索引の細部は、各領域の文書の「data-model への項目」の節が正本である。全部の ER（表の間の関係の図）は、開発リポジトリで最初の spec を承認する前に作る。

## 1. 置き場の規則

| 置き場 | 持つもの | 規則 |
| --- | --- | --- |
| Aurora PostgreSQL（東京、大阪へ Global Database） | 管理の正本、パイプラインの状態、照合の方針と申し立て、台帳、outbox | ID は UUIDv7。本人だけの表は `owner_id` と FORCE RLS（`SET LOCAL app.actor_id`）、チャンネルの表は `channel_id`（`app.channel_ids`）、権利者の表は `rights_owner_id`（`app.rights_owner_ids`）。RLS の外の表は許可リストにし CI で検査する（[ADR-0009](../decisions/0009-single-tenant-and-playable.md)） |
| S3 `<media-bucket>` | `orig/`（元のファイル）、`p/`（レンディション・索引・字幕・縮小の画像・チャットのリプレイ）、`r/`（段の中間の出力、7 日）、`l/`（DVR）、`live-src/`（ライブの元の流れ） | 層の移しは [infrastructure.md](infrastructure.md) の 6.2 節。`orig/` の消去は `original-deleter` だけ（[ADR-0013](../decisions/0013-original-retention-and-deletion-paths.md)） |
| S3 `<fp-bucket>` | 指紋（アップロード・参照）、参照の索引の世代 | [ADR-0044](../decisions/0044-reference-index-shards-and-generations.md) |
| S3 `<events-bucket>`（Iceberg） | 視聴の出来事、セッション、QoE の桶、チャットの記録 | 保持は `retention_policies`（法務の確認待ち：L5・L10） |
| S3 `<quarantine-bucket>`（別のアカウント） | 既知の違法なメディアに一致した元のファイル | `safety-review` だけ（[ADR-0063](../decisions/0063-operator-access-audit-retention-and-legal-hold.md)） |
| MSK | `watch-events`、`watch-events-rejected`、`chat-in`、`chat-log`、`rec-events`、`search-events` | 量の多い流れ。正本は S3 の Parquet（[ADR-0001](../decisions/0001-platform-and-stack.md)） |
| Kinesis | `cdn-rt-vod`・`cdn-rt-live` | CloudFront のリアルタイムのログだけ。保持 24 時間（[ADR-0067](../decisions/0067-sli-sources-and-computation.md)） |
| Valkey | `playable()` の写し、仮の数、チャット、おすすめの写し、速さの上限 | 失ってよい。正本から作り直せる |
| OpenSearch | `videos-v{n}`、`captions-v{n}`、`channels-v{n}`、`suggest-v{n}` | 正本ではない。Aurora と S3 から作り直せる |
| CloudFront KeyValueStore `edge-kv` | `k:{kid}`（HMAC の鍵）、`b:{video_id}`（措置の拒否）、`t:{sig16}`（悪用のトークン） | 5 MB。拒否の鍵は 7 日（[ADR-0027](../decisions/0027-takedown-deny-list-within-60s.md)） |
| AppConfig | `release.*`（kebab-case）、`ops.*`（snake_case）、`experiment.*`、`legal.copyright.*` | 形式・ラダー・規則はフラグにしない（[AGENTS.md](../../AGENTS.md)） |

## 2. 領域ごとの表と置き場

| 領域 | Aurora の表 | その他の置き場 |
| --- | --- | --- |
| [upload-and-ingest.md](upload-and-ingest.md) の 10 節 | `upload_sessions`（チャンネルの表）、`upload_parts`、`videos`（`state`・`visibility`・`publish_at` ほか）、`probe_results`、`original_deletions` | S3 `orig/{video_id}/`、隔離のバケット、outbox `video_upload_completed`・`video_state_changed` |
| [transcoding-pipeline.md](transcoding-pipeline.md) の 15 節 | `pipeline_runs`、`pipeline_tasks`、`ladders`、`renditions`、`av1_promotions`、`audio_loudness`、`captions`、`thumbnails`、`chapters` | SQS `pipe-urgent`・`pipe-normal`・`pipe-back`、S3 `r/`・`ladder/` |
| [packaging-and-drm.md](packaging-and-drm.md) の 11 節 | `renditions`（`gen`・`name`・`encrypted` ほか）、`videos`（`active_gen`・`drm_required`）、`drm_keys`、`drm_license_log` | S3 `p/{video_id}/{gen}/`、Valkey `rend:` |
| [playback-and-abr.md](playback-and-abr.md) の 11 節 | `device_overrides`（運用の表） | MSK `watch-events` の型、署名の鍵、端末のローカルの推定 |
| [cdn-and-delivery.md](cdn-and-delivery.md) の 16 節 | `delivery_blocks`、`cdn_weights`（S2） | KeyValueStore `edge-kv`、Valkey `blocked:`、SNS `origin-deny` |
| [live-streaming.md](live-streaming.md) の 12 節 | `live_streams`（チャンネルの表）、`stream_keys`、`live_assignments`、`live_match_windows` | S3 `l/`・`live-src/`、outbox `live_state_changed` |
| [live-chat.md](live-chat.md) の 11 節 | `chat_settings`、`chat_moderators`、`chat_bans`、`chat_blocked_terms`（チャンネルの表） | MSK `chat-in`・`chat-log`、Valkey `chat:`・`rl:`・`slow:`・`dup:`、S3 `p/{video_id}/chat/` |
| [view-counting-and-analytics.md](view-counting-and-analytics.md) の 11 節 | `view_counts_hourly`・`view_counts_daily`、`view_adjustments`、`video_stats_daily`、`video_stats_hourly`、`channel_stats_daily_dim`（チャンネルの表） | MSK `watch-events`・`watch-events-rejected`、Iceberg `watch_events`・`watch_sessions`、Valkey `vc:`・`vd:`・`vh:` |
| [recommendations.md](recommendations.md) の 15 節 | `watch_history`・`history_settings`・`rec_feedback`（本人の表） | Valkey `uh:`・`ua:`・`cv:`・`vf:`・`chf:`・`pop:`・`sq:`、MSK `rec-events`、S3 `recs/` |
| [search.md](search.md) の 12 節 | `videos`（`search_version`）、`search_history`（本人の表）、`suggest_blocklist`（運用の表） | OpenSearch、MSK `search-events` |
| [copyright-matching.md](copyright-matching.md) の 14 節 | `references`・`reference_exclusions`・`ownership_conflicts`・`matches`（権利者の表）、`fingerprints`、`match_runs` | S3 `fp/`・`index/v1/` |
| [copyright-claims-and-disputes.md](copyright-claims-and-disputes.md) の 12 節 | `assets`・`claim_policies`・`owner_allowlists`・`claims`（権利者の表）、`claim_effects`、`claim_transitions`、`claim_disputes`、`claim_notices`（チャンネルの表）、`revenue_split_daily`、`copyright_cases` | AppConfig `legal.copyright.*` |
| [comments-and-moderation.md](comments-and-moderation.md) の 11 節 | `comments`（`video_id` のハッシュで 16 に分ける）、`comment_likes`、`comment_reviews`・`channel_comment_settings`・`channel_user_lists`（チャンネルの表）、`video_comment_settings`、`comment_moderation_log`、`reports`・`report_cases`、`moderation_actions`（追記だけ）、`moderation_appeals` | Valkey `ct:` ほか |
| [channels-subscriptions-and-notifications.md](channels-subscriptions-and-notifications.md) の 10 節 | `handle_history`、`subscriptions`（本人の表）、`channel_subscribers`（専用の役割だけ）、`notify_jobs`、`notifications`・`push_devices`・`notification_settings`（本人の表）、`playlists`・`playlist_items` | Valkey `ch_last:`・`ch_recent:`・`naff:`・`ch_notif:`、SQS `notify-small`・`notify-large` |
| [monetization-and-payouts.md](monetization-and-payouts.md) の 12 節 | `monetization_status`・`membership_tiers`（チャンネルの表）、`eligibility_daily`、`ad_impressions`、`ad_server_reports`、`memberships`、`provider_events`、`ledger_entries`・`ledger_lines`（追記だけ）、`closed_months`、`payout_accounts`、`payouts`、`statements`、`tax_profiles`、`withholding_rules` | Valkey `mem:` |
| [accounts-and-safety.md](accounts-and-safety.md) の 13 節 | `accounts`・`security_events`（本人だけの表）、`passkeys`、`totp_secrets`、`sessions`、`refresh_tokens`、`channels`、`channel_members`・`creator_tiers`・`strikes`・`account_standing`（チャンネルの表）、`phone_verifications`、`id_verifications`、`supervision_links`、`standing_appeals`、`rights_owner_applications`、`safety_holds` | Valkey（セッション） |
| [security.md](security.md) の 14 節 | `audit_events`、`retention_policies`、`legal_holds`、`login_records`・`post_records`（`legal-response` だけ）、`legal_requests`、`operator_access_grants` | S3 の監査の記録（Object Lock）、KeyValueStore `t:` |
| [infrastructure.md](infrastructure.md) の 14 節 | `dr_events`、`dr_hot_set`、`cdn_quota_log`（運用の表） | S3 のタグ `published_at`・`dr=hot`、AppConfig `ops.upload_enabled`・`ops.live_ingest_enabled` |
| [observability.md](observability.md) の 11 節 | `canary_results`・`sli_monthly`（運用の表） | Iceberg `qoe_minute`・`cdn_rt_sample`、Kinesis `cdn-rt-vod`・`cdn-rt-live`、心拍の `lat_ms` |
| [capacity.md](capacity.md) の 12 節 | `cost_daily`・`capacity_reviews`（運用の表） | — |
| [delivery.md](delivery.md) の 14 節 | `enc_builds`、`renditions`（`enc_build`）、`reencode_campaigns`、`reencode_targets`、`client_versions`（運用の表） | AppConfig `player_cfg` |

## 3. 複数の領域が触る表

| 表 | 持ち主（書く領域） | 読む・列を足す領域 |
| --- | --- | --- |
| `videos` | upload-and-ingest | transcoding-pipeline、packaging-and-drm（`active_gen`・`drm_required`）、search（`search_version`）、comments-and-moderation（措置の要約）、`playable()` |
| `renditions` | transcoding-pipeline | packaging-and-drm（世代と名前）、delivery（`enc_build`） |
| `channels` | accounts-and-safety | channels-subscriptions-and-notifications（ハンドル）、monetization-and-payouts |
| `moderation_actions` | comments-and-moderation | cdn-and-delivery（`delivery_blocks`）、accounts-and-safety（警告と strike）、copyright-claims-and-disputes（削除） |
| `strikes`・`account_standing` | accounts-and-safety | copyright-claims-and-disputes（`copyright_strike_requested`）、comments-and-moderation（`guideline_violation`） |

- 本人の表の書き出しと消去（履歴の消去を含む）は outbox の出来事で各写しに配る。保全（`legal_holds`）は全部の消去の経路より先に効く（[ADR-0063](../decisions/0063-operator-access-audit-retention-and-legal-hold.md)）。

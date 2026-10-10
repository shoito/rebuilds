# Data model: Airbnb

データモデルの索引。表と置き場所を、Aurora のクラスタごと・領域ごとに並べる。列・キー・索引の中身は、各領域の文書の「data-model への項目」の節と ADR にある。列・制約・ER 図を持つ正本は、データモデルの工程で書く（[README.md](README.md) の 6 節の「残る未解決事項」）。

- 2026-10-10 の統合の工程で作った。名前は統合で揃えた名前を使う（[README.md](README.md) の 6 節の「決定（2026-10-10、統合）」の「名前の揃え」）。
- 見える範囲の方針は [ADR-0007](../decisions/0007-tenancy-host-accounts-and-rls.md)（本人・ホストのアカウント・予約の 2 者の FORCE RLS）、鍵は [ADR-0073](../decisions/0073-key-layout-and-vault-envelope-encryption.md)、データの区分と保持は [ADR-0075](../decisions/0075-data-classes-and-retention.md)、4 つのクラスタは [ADR-0001](../decisions/0001-platform-and-stack.md) と [ADR-0077](../decisions/0077-data-stores-layout-and-osaka-dr.md)。
- 守る物（排他の制約、CHECK、一意、台帳のトリガー、RLS）は [delivery.md](delivery.md) の 5.2 節。

## 1. 置き場所

| 置き場所 | 中身 | 書くサービス |
| --- | --- | --- |
| Aurora core | アカウント、ホストのアカウント、リスティングと内容、位置から求めた値、地名、空室とカレンダー、料金と税の表、見積もり、予約、キャンセルと変更、決済の試行、損害の請求、届出住宅と 180 日、PMS、運用と設定 | `identity`、`listings`、`availability`、`pricing`、`booking`、`payments`、`compliance-jp`、`partner-api`、`ops-api` |
| Aurora ledger | 口座、仕訳、決着、為替の持ち高、送金、送金の保留と待ち、照合 | `ledger`、`payouts` |
| Aurora content | メッセージ、通知、レビュー、T&S の規則・案件・措置、安全の事故、本人確認のセッション、Webhook | `messaging`、`notifier`、`reviews`、`trust-safety`、`identity`、`webhook-fanout` |
| Aurora vault | 正確な住所と位置、宿泊者名簿、旅券の読み取りの結果、送金の口座、本人確認の結果、入り方、主体の鍵 | `listings`、`compliance-jp`、`identity`、`payouts` だけ |
| Valkey・OpenSearch・S3・SQS・AppConfig・データレイク | 5・6 節 | 各サービス |

## 2. Aurora core

| 領域 | 表 |
| --- | --- |
| アカウント（[accounts.md](accounts.md)） | `users`、`guest_profiles`、`host_profiles`、`passkeys`、`federated_identities`、`sessions`、`refresh_tokens`、`devices`、`verifications`、`step_ups`、`payout_waits`、`account_erasure_jobs`、`subject_keys`（`purpose = contact`） |
| ホストのアカウントと共同ホスト（[ADR-0007](../decisions/0007-tenancy-host-accounts-and-rls.md)、[host-tools-and-api.md](host-tools-and-api.md)） | `host_accounts`（`kind`、`business_verified_at`）、`host_members`（`role`：`owner`・`full`・`calendar_and_reservations`・`messages_only`、`registry_access`）、`host_member_listings`、`host_invitations` |
| リスティングと内容（[listings-and-content.md](listings-and-content.md)） | `listings`（`listing_version`・`calendar_version`・`search_version`、`approx_point` ほか位置から求めた値、`sentinel`、`rank_*`）、`listing_revisions`、`listing_events`、`listing_texts`、`listing_translations`、`listing_photos` |
| 位置と地名（[location-and-geo.md](location-and-geo.md)） | `admin_areas`、`tax_zones`、`places`、`place_names` |
| 空室とカレンダー（[availability-and-calendars.md](availability-and-calendars.md)） | `stay_claims`（排他の制約 `stay_claims_no_overlap`）、`stay_claims_archive`、`listing_rules`、`calendar_days`（`nightly_price_override`、`min_nights`・`max_nights`、`set_by_type`）、`listing_units`（S2）、`tzdata_releases` |
| カレンダーの同期（[calendar-sync.md](calendar-sync.md)） | `ical_feeds`、`ical_intervals`、`calendar_conflicts`、`ical_exports`、`external_stay_declarations` |
| 検索（[search-and-ranking.md](search-and-ranking.md)） | `listing_daily_stats`、`area_stats`、`search_samples`（[observability.md](observability.md)） |
| 料金と税（[pricing-and-fees.md](pricing-and-fees.md)、[taxes.md](taxes.md)） | `pricing_rules`（`pricing_version`）、`seasonal_rules`、`service_fee_schedules`、`jp_holidays`、`quotes`、`tax_table_versions`、`tax_rules`、`reservation_tax_nights` |
| 予約（[booking-and-holds.md](booking-and-holds.md)） | `reservations`（期限の 8 列、`route`、`ts_decision_id`、`settlement_seq`、`registry_status`、`claim_window_ends_at`）、`reservation_events`、`request_declines` |
| キャンセルと変更（[cancellations-and-changes.md](cancellations-and-changes.md)） | `cancellation_policies`、`host_cancellation_fee_tables`、`reservation_settlements`、`reservation_alterations`、`extenuating_events` |
| 決済と為替（[payments-and-fx.md](payments-and-fx.md)） | `payment_attempts`、`payment_methods`、`payment_inbox`、`refunds`、`chargebacks`、`payment_anomalies`、`fx_rate_snapshots`、`fx_markup_versions` |
| 損害の請求（[deposits-and-claims.md](deposits-and-claims.md)） | `damage_claims`、`damage_claim_events`、`damage_claim_evidence` |
| 本人確認（[identity-verification.md](identity-verification.md)） | `users.kyc_level`、`kyc_gate_versions`、`kyc_gates` |
| 日本の法令（[regulatory-compliance-japan.md](regulatory-compliance-japan.md)） | `regulated_properties`、`regulatory_documents`、`regulated_years`（CHECK `nights_used + external_used <= cap`）、`regulated_nights`、`regulated_external_nights`、`regulatory_exceptions`、`municipal_rule_sets` |
| レビューの集計（[reviews.md](reviews.md)） | `listing_review_stats`、`host_review_stats`、`review_stat_applications` |
| PMS（[host-tools-and-api.md](host-tools-and-api.md)） | `partner_developers`、`pms_apps`、`pms_grants`、`pms_grant_listings`、`pms_tokens`、`pms_write_sequences`、`pms_idempotency_keys`、`bulk_jobs`、`partner_api_versions` |
| 運用と設定（[security.md](security.md)、[delivery.md](delivery.md)、[infrastructure.md](infrastructure.md)、[capacity.md](capacity.md)、[observability.md](observability.md)） | `ops_grants`、`ops_reveals`、`legal_requests`、`legal_exports`、`deployments`、`app_versions`、`legal_config_changes`、`config_versions`、`dr_events`、`capacity_reviews`、`peak_season_plans`、`hot_date_events`、`egress_denials`、`recon_runs`、`reconciliation_findings`（`stay_claims`・180 日・予約）、`sentinel_accounts` |
| 各クラスタに置く共通の表 | `outbox`、`schema_migrations`、`audit_events`、`audit_chain_heads`、`legal_holds` |

## 3. Aurora ledger

| 領域 | 表 |
| --- | --- |
| 台帳（[ledger-and-payouts.md](ledger-and-payouts.md)） | `accounts`（22 の口座の種類）、`journals`・`journal_lines`（31 の仕訳の型。追記だけ、月の分割）、`account_balances`、`escrow_settlements`（主キー `(reservation_id, settlement_seq)`）、`fx_positions` |
| 送金 | `payouts`、`payout_batches`、`payout_holds`（`kind`：`wait`（`payout_account_changed`・`new_host_first_stays`）・`hold`（`fraud_suspected`・`kyc_incomplete`・`kyc_mismatch`・`bank_returned`・`ops_case`））、`bank_calendar`、`host_statements` |
| 照合 | `reconciliation_findings`（R1〜R11） |

## 4. Aurora content と vault

| クラスタ | 領域 | 表 |
| --- | --- | --- |
| content | メッセージと通知（[messaging.md](messaging.md)） | `message_threads`、`thread_participants`、`messages`、`message_filter_events`、`message_translations`、`message_templates`、`scheduled_messages`、`scheduled_message_runs`、`report_evidence`、`notifications`、`notification_deliveries`、`notification_preferences` |
| content | レビュー（[reviews.md](reviews.md)） | `review_pairs`、`reviews`、ビュー `reviews_public`、`review_responses` |
| content | T&S と安全（[trust-and-safety.md](trust-and-safety.md)） | `ts_rules`、`ts_rule_bundles`、`ts_rule_approvals`、`rule_evaluations`、`ts_cases`、`moderation_actions`、`appeals`、`safety_incidents`、`rebooking_records`、`policy_acknowledgements` |
| content | 本人確認のセッション（[identity-verification.md](identity-verification.md)） | `kyc_sessions`、`kyc_inbox` |
| content | Webhook（[host-tools-and-api.md](host-tools-and-api.md)） | `webhook_subscriptions`、`webhook_events`、`webhook_deliveries` |
| vault | 位置（[location-and-geo.md](location-and-geo.md)） | `exact_locations`、`location_groups` |
| vault | 名簿（[regulatory-compliance-japan.md](regulatory-compliance-japan.md)） | `guest_registry_entries` |
| vault | 本人確認（[identity-verification.md](identity-verification.md)） | `identity_verifications`、`person_keys`、`passport_capture_results` |
| vault | 送金の口座（[ledger-and-payouts.md](ledger-and-payouts.md)） | `payout_accounts` |
| vault | 入り方（[booking-and-holds.md](booking-and-holds.md)） | `arrival_instructions` |
| vault | 鍵と監査（[security.md](security.md)） | `subject_keys`、`vault_access_log` |

## 5. Aurora の外

| 置き場所 | 中身 |
| --- | --- |
| Valkey（失ってよい） | `avail:{listing_id}`（空室の写し、平均 250 バイト）、`prc:{listing_id}`（料金の写し）、`qs:{listing_id}:{ci}:{co}:{guests}:{pricing_version}`（10 分）、`ss:{search_id}`（10 分）、`quote:{quote_id}`（15 分）、`claim:{listing_id}:{check_in}`（15 秒）、`idem:{guest_id}:{key}`（60 秒）、`sess:{token_hash}`（15 分）、`pmstok:{hash}`（60 秒）、`vel:{kind}:{key}`、`rl:*`（`rl:pms:{app_id}:{host_account_id}` ほか） |
| OpenSearch | `listings_v<n>`（別名 `listings`。`approx_point`、`stay_ranges`、`month_runs`、`price_bands`、`rank_static`）、`places_v<n>`（別名 `places`）、`photo_hashes` |
| S3 | `listing-uploads`・`photos-incoming`（1 日）、`listing-photos`・`photos`（`p/<photo_id>/<width>.<ext>`）、`message-attachments`、`ical-exports`（`<listing_id>/<calendar_version>.ics`）、`registry`（旅券の画像。vault の鍵）、`regulatory-docs`、`reports`、`claims`、`bulk`（7 日）、`exports`（`kms-ops-exports`）、`opensearch-snapshots`、`ml-models`、`records`（inbox の本文、銀行の明細、全銀の形式のファイル）、log-archive の `audit/` |
| SQS・SNS | outbox の話題（クラスタごと）、`search-index`、`search-index-priority`、`availability-cache`、`ical-fetch`、`ical-apply`（FIFO、グループ `listing_id`）、`media-processing`、`translation`、`notify-critical`・`notify-transactional`・`notify-engagement`、`webhook-send`、`ledger` 向けの FIFO（グループは予約の ID） |
| データレイク（data のアカウント） | 仮名の事象、`search_samples`、`rank_logs`、`ts_eval_sets`、モデルの登録簿 |

## 6. AppConfig の値

| 種類 | 値 |
| --- | --- |
| `release.*` | 未完成の振る舞いの出し入れ（kebab-case。100% の後 30 日で消す） |
| `ops.*` | `ops.booking_enabled`、`ops.payments_enabled`、`ops.payouts_enabled`、`ops.ical_import_enabled`、`ops.ical_poll_minutes`、`ops.partner_api_enabled.<app>`、`ops.search_stage1_limit`、`ops.search_degraded_mode`、`ops.sms_provider`、`ops.sms_allowed_countries`、`ops.sms_country_hourly_cap`、`ops.app_min_version_<platform>`、`ops.app_force_version_<platform>` |
| `legal.*`（本番の値は法務の結論の後。既定と L の番号は [delivery.md](delivery.md) の 3.3 節） | `legal.minpaku_count_external_nights`、`legal.minpaku_day_boundary_rule`、`legal.guest_registry_fields`、`legal.guest_registry_retention_days`、`legal.registry_auto_delete_enabled`、`legal.registry_gate_arrival_info`、`legal.registry_identity_method`、`legal.request_decline_mode_ryokan`、`legal.lodging_tax_collector`、`legal.lodging_tax_collector.<jurisdiction>`、`legal.funds_holding_model`、`legal.max_holding_days`、`legal.sanctions_screening_owner`、`legal.message_scan_mode`、`legal.message_translation_enabled`、`legal.prebooking_guest_identity_display`、`legal.pms_registry_scope_enabled`、`legal.pms_cross_border_guest_data`、`legal.kyc_result_retention_days`、`legal.person_key_enabled`、`legal.claim_merchant_initiated_enabled`、`legal.claim_evidence_retention_days` |
| T&S と ML | `ts.event_windows`、`ts.party_features_v1`、`ts.thresholds`、`models.<name>.active_version`、`rules.<name>.active_version` |

- `legal.respond` は運用者の権限の名前で、AppConfig の値ではない（[security.md](security.md) の 6.1 節）。

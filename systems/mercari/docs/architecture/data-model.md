# Data model: Mercari

表と置き場所の索引。列・主キー・索引の要点は、各領域の文書の「data-model への項目」の節が持つ。この文書は、どの表がどのクラスタにあり、どの領域が持ち（書き）、どの見える範囲の種類とデータの区分に当たるかを 1 か所で引けるようにする。ER 図、列の型、不変条件を含む正本は、後のデータモデルの工程で書く（[README.md](README.md) の 6 節の「残る未解決事項」）。

- クラスタは core・ledger・content の 3 つ（[ADR-0001](../decisions/0001-platform-and-stack.md)）。表は持ち主のパッケージだけが書く（lint で検査する）。
- 見える範囲の種類：**本人**（FORCE RLS と `SET LOCAL app.actor_id`）、**2 者**（`buyer_id`・`seller_id` の RLS）、**公開**（RLS なし、`listingVisible()` で絞る）、**サービス**（サービスの役割の許可リストだけが読む）（[ADR-0007](../decisions/0007-single-tenant-and-party-visibility.md)）。
- データの区分は S 秘密・V 金庫・P 2 者・O 本人・U 公開・F お金・A 監査・M 運用・L 分析（[ADR-0071](../decisions/0071-data-classes-and-lifecycle.md)）。CI で、区分のない表を拒む。
- ID は UUIDv7（カテゴリ・ブランドは整数）。金額は整数の円。
- どのクラスタにも `outbox`（`trace_parent` の列つき）、`audit_events`、`legal_holds`、`schema_migrations` を置く（[security.md](security.md) の 6.4・7.2 節、[delivery.md](delivery.md) の 10 節、[observability.md](observability.md) の 12 節）。

## 1. core

| 領域 | 表 | 見える範囲 | 区分 | 詳細 |
| --- | --- | --- | --- | --- |
| アカウントと端末 | `accounts`、`passkeys`、`sessions`、`devices`、`phone_verifications`、`account_holds`、`step_ups`、`blocks`、`account_erasure_jobs` | 本人（`blocks` も本人） | V（`*_enc`）・O | [accounts-and-devices.md](accounts-and-devices.md) の 14 節 |
| 同上 | `profiles` | 公開 | U | 同上 |
| 出品と写真 | `listings`、`listing_events`、`listing_photos`、`seller_business_signals` | 公開（出品は `listingVisible()`） | U | [listings-and-photos.md](listings-and-photos.md) の 10 節 |
| 同上 | `listing_drafts` | 本人 | O | 同上 |
| カテゴリ・ブランド | `catalog_versions`、`categories`、`brands`、`brand_aliases`、`category_term_stats` | 公開（設定） | U | [categories-brands-and-pricing-suggestions.md](categories-brands-and-pricing-suggestions.md) の 9 節 |
| 検索 | `reindex_jobs` | サービス | M | [search-and-discovery.md](search-and-discovery.md) の 10 節 |
| 取引 | `transactions`、`transaction_events`、`cancel_requests` | 2 者 | P | [transactions-and-state-machine.md](transactions-and-state-machine.md) の 14 節 |
| 取引と照合 | `reconciliation_runs`、`reconciliation_findings` | サービス | M | 同上の 10 節、[observability.md](observability.md) の 12 節 |
| 評価 | `ratings`（`sealed` は書いた本人だけ）、`reputation`（数の列は公開） | 2 者・公開 | P・U | [ratings-and-reputation.md](ratings-and-reputation.md) の 9 節 |
| 決済 | `payment_attempts`（買い手）、`payment_inbox`、`refund_attempts`、`chargebacks` | 2 者・サービス | P・F | [payments-and-escrow.md](payments-and-escrow.md) の 15 節 |
| 同上 | `payment_methods` | 本人 | O | 同上 |
| 手数料の設定 | `fee_tables`、`fee_table_rows` | 公開（設定） | F | [ledger-and-proceeds.md](ledger-and-proceeds.md) の 13 節 |
| 配送 | `shipping_rate_tables`、`shipping_rates` | 公開（設定） | U | [shipping-integrations.md](shipping-integrations.md) の 13 節 |
| 同上 | `shipments`（QR は売り手の側の列）、`shipment_events`、`shipping_claims` | 2 者・サービス | P | 同上 |
| 同上 | `carrier_inbox` | サービス | P | 同上 |
| 住所の金庫 | `address_vault` | 本人 | V | 同上の 7 節、[security.md](security.md) の 5.3 節 |
| 同上 | `shipment_addresses` | サービス（`shipping` の役割だけ） | V | 同上、[ADR-0044](../decisions/0044-address-vault-snapshots-and-access.md) |
| 鍵 | `vault_keys`（`address`・`identity_pii`） | サービス（`shipping`・`identity`） | S | [security.md](security.md) の 11 節 |
| 本人確認 | `kyc_sessions`、`kyc_records` | 本人（運用者は `kyc.view`） | V | [identity-verification.md](identity-verification.md) の 12 節 |
| 同上 | `kyc_fingerprints`、`kyc_inbox` | サービス | V | 同上 |
| 運用者 | `ops_grants`、`ops_reveals` | サービス（`ops-api`） | A | [security.md](security.md) の 11 節 |
| 基盤と運用 | `dr_events`、`capacity_reviews`、`campaign_scaling_plans`、`deployments`、`app_versions`、`legal_config_changes`、`hot_listing_slots` | サービス | M | [infrastructure.md](infrastructure.md) の 12 節、[capacity.md](capacity.md) の 9 節、[delivery.md](delivery.md) の 10 節、[observability.md](observability.md) の 12 節 |

- `accounts`・`listings` に見張りの印 `sentinel` を持つ（[observability.md](observability.md) の 4 節、[ADR-0007](../decisions/0007-single-tenant-and-party-visibility.md) の注記）。
- S3 で core を `core-accounts`（アカウント、端末、セッション、住所の金庫）と `core-market`（出品、取引、取引の事象、配送。`listing_id` のハッシュで 16）に分ける（[ADR-0074](../decisions/0074-stage-up-criteria-and-split-plan.md)）。

## 2. ledger

| 領域 | 表 | 見える範囲 | 区分 | 詳細 |
| --- | --- | --- | --- | --- |
| 台帳 | `accounts`（口座）、`account_balances`、`journals`、`journal_lines`（月ごとに分割、追記だけ）、`escrow_settlements` | 口座の持ち主（利用者の口座は本人） | F | [ledger-and-proceeds.md](ledger-and-proceeds.md) の 13 節 |
| 売上金 | `proceeds_lots`、`proceeds_expiry_state` | 本人 | F | 同上 |
| 同上 | `proceeds_lot_consumptions`、`customer_funds_daily` | サービス | F | 同上 |
| 照合 | `external_statement_lines`、`recon_breaks`、`recon_runs` | サービス（財務） | F | 同上の 9 節 |
| 振込 | `bank_accounts`（口座の番号は封筒の暗号化）、`payouts`、`points_lots` | 本人 | V・F | [payouts-and-points.md](payouts-and-points.md) の 13 節 |
| 同上 | `bank_master`、`bank_calendar`、`payout_batches`、`payout_blocks`、`point_campaigns`、`balance_reservations` | サービス | F | 同上 |
| 運用の介入 | `proceeds_holds`（本人は読みだけ） | 本人・サービス | F | [disputes-and-customer-support.md](disputes-and-customer-support.md) の 14 節 |
| 鍵 | `vault_keys`（`bank`） | サービス（`payouts`） | S | [security.md](security.md) の 11 節 |

- 口座の種類は 22、仕訳の型は 30（[ADR-0034](../decisions/0034-chart-of-accounts-journal-types-and-fee-rounding.md)）。仕訳の表は `ledger_owner` が持ち、`UPDATE`・`DELETE` を権限とトリガーで拒む（[ADR-0078](../decisions/0078-pipeline-schema-ordering-ledger-migrations-and-flag-governance.md)）。
- S2 で熱い口座（`psp_receivable`、`fee_revenue:*`、`shipping_payable`）を 16 のスロットに分け、S3 で口座の持ち主のハッシュで分ける（[ADR-0074](../decisions/0074-stage-up-criteria-and-split-plan.md)）。

## 3. content

| 領域 | 表 | 見える範囲 | 区分 | 詳細 |
| --- | --- | --- | --- | --- |
| いいねと履歴 | `likes`、`view_history`、`user_discovery_settings` | 本人 | O | [search-and-discovery.md](search-and-discovery.md) の 10 節 |
| 保存した検索 | `saved_searches`、`alert_matches`（本人とサービス）、`alert_windows` | 本人 | O | [saved-searches-and-alerts.md](saved-searches-and-alerts.md) の 10 節 |
| 同上 | `saved_search_keys`、`ss_key_rates` | サービス | O | 同上 |
| コメントとメッセージ | `listing_comments` | 公開 | U | [messaging-and-comments.md](messaging-and-comments.md) の 9 節 |
| 同上 | `transaction_messages`、`message_read_state` | 2 者 | P | 同上 |
| 同上 | `retained_bodies`（T&S の鍵）、`abuse_filter_events`、`abuse_dictionaries` | サービス | P・M | 同上 |
| 通知 | `notifications`、`notification_prefs` | 本人 | O | [notifications.md](notifications.md) の 10 節 |
| 同上 | `notification_sends`、`fanout_jobs`、`email_suppressions` | サービス | O | 同上 |
| T&S | `moderation_actions`、`moderation_action_events`、`rule_evaluations`、`ts_signals`、`ts_rule_bundles`、`ts_rule_approvals`、`ts_terms`、`ts_photo_blocklist`、`ts_prohibited_classes`、`brand_risk_profiles`、`moderation_cases`、`appeals` | サービス（T&S） | A・U | [trust-and-safety.md](trust-and-safety.md) の 17 節 |
| 同上 | `reports`、`report_evidence`、`rights_holders`、`rights_holder_documents`、`legal_cases` | サービス（T&S と法務。読み出しは監査） | P・V | 同上 |
| 紛争と CS | `cases`（紛争・問い合わせ・受取評価の後・法令の照会）、`case_events`、`case_attachments`、`case_approvals` | 2 者（紛争の報告）・サービス | P | [disputes-and-customer-support.md](disputes-and-customer-support.md) の 14 節 |

- 案件の表は 3 つある：紛争と CS の `cases`、T&S の審査の `moderation_cases`、T&S の法令の案件（削除の申し出、利用の停止等の要請、盗品の通知）の `legal_cases`。開示の請求と捜査機関の照会は `cases` の種類 `legal_request` で受ける。
- S2 で `content-social`（いいね、コメント、閲覧の履歴）、`content-notify`（通知、保存した検索）、`content-ts`（T&S の案件と措置）に分ける（[ADR-0074](../decisions/0074-stage-up-criteria-and-split-plan.md)）。

## 4. 他の置き場所

| 置き場所 | 中身 | 詳細 |
| --- | --- | --- |
| Valkey | `listing:{id}:snap`、`purchase:{listing_id}`（先着の印）、`vis:{listing_id}`、`sess:{token_hash}`、`ss:k:*`・`ss:ks:*`・`ss:kv:*`・`ss:ready:*`、`price:*`、`ntf:devices:*`・`ntf:cap:*`・`ntf:digest:*`、`rec:{user_id}`、`sq:{hash}`、SMS の上限の数え。どれも失ってよい | [transactions-and-state-machine.md](transactions-and-state-machine.md) の 14 節、[search-and-discovery.md](search-and-discovery.md) の 10 節、[saved-searches-and-alerts.md](saved-searches-and-alerts.md) の 10 節、[categories-brands-and-pricing-suggestions.md](categories-brands-and-pricing-suggestions.md) の 9 節、[notifications.md](notifications.md) の 10 節、[accounts-and-devices.md](accounts-and-devices.md) の 14 節 |
| OpenSearch | `listings_v<n>`（別名 `listings`。S2 で `listings_active`・`listings_sold`）、`photo_hashes`、保存したスクリプト `ranking_v1` | [search-and-discovery.md](search-and-discovery.md) の 4 節、[listings-and-photos.md](listings-and-photos.md) の 5.4 節 |
| S3 | `photos-incoming`（24 時間）、`photos`（`quarantine/` を含む）、`catalog/`、`price-stats/`、`payments/inbox/`、`shipping/inbox/`（住所の欄を落とす）、`ledger/statements/`、`payouts/zengin/`、`cases/`、`exports`、`opensearch-snapshots`、`ml-models`、log-archive の `audit/`（Object Lock） | 各領域の文書、[infrastructure.md](infrastructure.md) の 4.2 節 |
| SQS・SNS | outbox の話題（クラスタごと）、`media-process`、`search-index`・`search-index-priority`、`saved-search-match`、`ts-screen`・`ts-actions`、`ntf-security`・`ntf-transactional`・`ntf-engagement`・`ntf-announcement`、`kyc-inbox`、各 DLQ | 各領域の文書 |
| AppConfig | `release.*`、`ops.*`（`ops.purchase_enabled`、`ops.payouts_enabled`、`ops.carrier_enabled.<carrier>`、`ops.fanout_enabled`、`ops.saved_search_digest_minutes`、`ops.sms_provider`、`ops.search_degraded_mode`、`ops.app_min_version_*`・`ops.app_force_version_*`）、`legal.*`（別のアプリケーション）、`fees.table`、`shipping.rate_table`、`models.*`、`rules.*`、`search.sold_retention_days`、`alerts.max_push_per_day`、`kyc.*` | [delivery.md](delivery.md) の 3 節、[runbooks/README.md](../runbooks/README.md) の 2 節 |
| データレイク（data のアカウント） | outbox の事象の写し（V の欄と P の本文を落とし、利用者の ID をレイクの鍵の HMAC に）、学習のデータ、日次の集計、モデルの登録簿 | [security.md](security.md) の 7.3 節、[ADR-0071](../decisions/0071-data-classes-and-lifecycle.md) |

## 5. `legal.*` の値の一覧

どれも法務の確認待ちで、本番の既定は無効・未設定（[ADR-0004](../decisions/0004-proceeds-model-under-payment-services-act.md)、[ADR-0078](../decisions/0078-pipeline-schema-ordering-ledger-migrations-and-flag-governance.md)）。

| 値 | L | 詳細 |
| --- | --- | --- |
| `legal.proceeds_expiry_enabled`、`legal.proceeds_expiry_days`、`legal.proceeds_expiry_actions`、`legal.proceeds_forfeit_enabled`、`legal.proceeds_spendable`、`legal.proceeds_expiry_notice_days`、`legal.proceeds_to_points_enabled` | L1 | [ledger-and-proceeds.md](ledger-and-proceeds.md) の 6.2 節、[payouts-and-points.md](payouts-and-points.md) の 8 節 |
| `legal.balance_enabled`、`legal.balance_requires_kyc_level`、`legal.balance_max_yen`、`legal.balance_spend_limit_yen.{level}` | L1・L2 | 同上、[identity-verification.md](identity-verification.md) の 5 節 |
| `legal.points_expiry_enabled` | L1・L4 | [payouts-and-points.md](payouts-and-points.md) の 8.3 節 |
| `legal.payout_limit_yen.{level}`、`legal.payout_monthly_limit_yen.{level}` | L2 | [identity-verification.md](identity-verification.md) の 5 節、[payouts-and-points.md](payouts-and-points.md) の 5.1 節 |
| `legal.kyc_*`（`legal.kyc_provider_retention_days`、`legal.kyc_reverify_days` など） | L2・L5 | [identity-verification.md](identity-verification.md) の 7・9 節 |
| `legal.business_seller_*` | L3 | [listings-and-photos.md](listings-and-photos.md) の 7 節 |
| `legal.stolen_goods_*` | L6 | [trust-and-safety.md](trust-and-safety.md) の 11.3 節 |
| `legal.platform_request_*` | L7 | [trust-and-safety.md](trust-and-safety.md) の 14 節 |
| `legal.takedown_*` | L9 | 同上 |
| `legal.message_scan_mode` | L11 | [messaging-and-comments.md](messaging-and-comments.md) の 5.5 節 |
| `legal.minor_purchase_limit_yen`、`legal.minor_payout_limit_yen` | L12 | [accounts-and-devices.md](accounts-and-devices.md) の 10 節 |

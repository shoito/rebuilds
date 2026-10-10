# Data Model: Shopify

表と置き場所の索引。各表の列・主キー・索引の細部は、各領域の文書の「data-model への項目」の節が正本で、この文書はその一覧と、横断の規約を持つ。列・制約・量まで書いた ER 図の全体は、開発リポジトリを作るときに後で足す（持ち主は Dev、レビューは QA）。

2026-10-10 の統合の工程で、領域の文書の項目から作った。

## 1. 規約

| 対象 | 規約 | 根拠 |
| --- | --- | --- |
| ポッドの DB の表 | `shop_id`（UUIDv7）を主キーと索引の先頭に置き、`FORCE ROW LEVEL SECURITY` とポリシー `shop_id = current_setting('app.shop_id')::uuid` を持つ。移し替えの対象・削除の対象・保持の区分の一覧に載せる（CI の表の目録の検査） | [ADR-0003](../decisions/0003-tenancy-and-rls.md)、[ADR-0012](../decisions/0012-shop-mover-logical-decoding-and-cutover.md)、[ADR-0013](../decisions/0013-shop-lifecycle-and-data-deletion.md) |
| RLS の外の表（ポッド） | `shop_freeze`、`shop_relocations`、`shop_move_progress`、outbox の読み出しの位置、`schema_migrations`、全体の写し（`*_replica`）と全体の参照のデータの写し（`tax_rates`、`postal_codes`、`carrier_profiles`、`product_categories`）、`data_keys`。ショップのデータの列を持たない | ADR-0003 の 2026-10-10 の注記 |
| 全体の Aurora | ショップのデータ（商品・注文・買い手の値）を持たない。ショップの ID・ハンドル・額・数だけ | [ADR-0002](../decisions/0002-pods-and-shop-placement.md) |
| ID | UUIDv7。外に出すときはグローバル ID（`gid://<brand>/<Type>/<uuid>`） | [ADR-0009](../decisions/0009-admin-api-graphql-and-cost-limits.md) |
| 金額 | 整数の最小単位（`bigint`）と通貨。浮動小数点を使わない | [AGENTS.md](../../AGENTS.md) |
| 買い手の個人のデータの列 | 封筒の暗号の `v1\|<key_id>\|<nonce>\|<ciphertext>`。完全一致の検索は HMAC の索引の列（`email_hmac` など） | [ADR-0066](../decisions/0066-encryption-and-key-layout.md) |
| 追記だけの表 | `inventory_movements`、`audit_events`、`tax_documents`、`checkout_events`、`order_events` などの事象の表は更新しない | 各 ADR |
| Valkey の鍵 | ショップのデータの鍵は `{<shop_id>}:<種類>:…`（ハッシュタグで同じスロット）。ポッドの運用の鍵は `sys:…`、全体の待合室の鍵は `wr:{<sale_id>}:…`。どれも失ってよい（正本にしない） | AGENTS.md、[README.md](README.md) の 6 節の「決定（2026-10-10、統合）」 |
| S3 のキー | ショップのデータは `shops/<shop_id>/…`（ポッドに依らない。移し替えで動かさない）。監査ログの写しは log-archive の `audit/shops/<shop_id>/…`。関数の機械語は `functions/<app>/<function>/<version>/<wasmtime>.cwasm` | 同上 |
| KeyValueStore | 鍵はホスト（小文字）か `sys:` の鍵。値は `v1\|<shop_short>\|<pod>\|<state>\|<gen>[\|<pgen>\|<fine_bucket_gens>]`（1 KB まで）。全体で 4 MB まで | [ADR-0010](../decisions/0010-shop-routing-hot-set-and-custom-domains.md)、[ADR-0050](../decisions/0050-edge-cache-keys-and-generations.md) |
| フラグ | `release.*` は kebab-case、`ops.*` は snake_case（AppConfig） | AGENTS.md |

## 2. ポッドの DB（Aurora PostgreSQL、ショップのデータ）

| 領域 | 表 | 正本の節 |
| --- | --- | --- |
| ショップとポッド | `domains`、`shop_row_counts`、`shop_freeze`・`shop_relocations`・`shop_move_progress`（RLS の外）、`*_replica`（RLS の外） | [shops-and-pods.md](shops-and-pods.md) の 14 節 |
| カタログと価格 | `products`、`product_options`、`product_option_values`、`product_variants`、`variant_price_history`、`product_media`、`collections`、`collection_products`、`product_sales_30d`、`metafield_definitions`、`metafields`、`product_publications`、`markets`、`market_regions`、`market_prices`、`product_categories`（写し） | [catalog-and-pricing.md](catalog-and-pricing.md) の 15 節 |
| 税とインボイス | `shop_tax_settings`、`order_tax_lines`、`refund_tax_lines`、`tax_documents`、`tax_document_sequences`、`invoice_registrations`、`tax_rates`（写し） | [taxes-and-invoices.md](taxes-and-invoices.md) の 10 節 |
| 在庫と引き当て | `locations`、`location_priority`、`location_region_rules`、`inventory_items`、`inventory_levels`、`inventory_slots`、`reservations`、`inventory_movements`（月の分割）、`inventory_daily_snapshots`、`inventory_reconciliation_runs` | [inventory-and-reservations.md](inventory-and-reservations.md) の 14 節 |
| フラッシュセール | `flash_sales`、`flash_sale_items`、`flash_sale_steps`、`queue_pass_redemptions`、`purchase_limit_counters`、`purchase_limit_reservations` | [flash-sales-and-queueing.md](flash-sales-and-queueing.md) の 13 節 |
| カートとチェックアウト | `checkouts`、`checkout_lines`、`checkout_events`、`checkout_price_snapshots`、`checkout_submissions`、`final_confirmation_fields`、`saved_carts`、`postal_codes`（写し） | [cart-and-checkout.md](cart-and-checkout.md) の 13 節 |
| 割引 | `discounts`、`discount_versions`、`discount_codes`、`discount_targets`、`discount_usage_slots`、`discount_customer_usage`、`checkout_discount_reservations`、`discount_usage_totals` | [discounts-engine.md](discounts-engine.md) の 14 節 |
| 決済 | `payment_attempts`、`payment_attempt_events`、`payment_webhook_inbox`、`payment_inquiries`、`shop_payment_providers`、`payment_reconciliation_runs` | [payments-integration.md](payments-integration.md) の 14 節 |
| 注文と配送 | `orders`（`checkout_id` 一意）、`order_lines`、`order_events`、`order_number_counters`、`fulfillment_orders`、`fulfillment_order_lines`、`shipments`、`shipment_lines`、`shipping_profiles`、`shipping_zones`、`shipping_rates`、`shipping_surcharges`、`delivery_settings`、`carrier_exports`、`carrier_imports`、`shop_carrier_accounts`、`carrier_profiles`（写し） | [orders-and-fulfillment.md](orders-and-fulfillment.md) の 11 節 |
| 返品と返金 | `returns`、`return_lines`、`return_policies`、`refunds`、`refund_lines`、`refund_events`（`refund_tax_lines` は税） | [returns-and-refunds.md](returns-and-refunds.md) の 10 節 |
| テーマ | `themes`、`theme_versions`、`shop_legal_settings`、`shop_script_allowlist`、ショップの設定の `published_theme_version_id` | [storefront-themes.md](storefront-themes.md) の 12 節 |
| Storefront API とキャッシュ | `storefront_tokens`、`persisted_queries`、`url_redirects` | [storefront-api-and-caching.md](storefront-api-and-caching.md) の 12 節 |
| 検索 | `search_synonyms`、`search_query_stats`、`search_suggestions`、`product_recommendations` | [search-and-recommendations.md](search-and-recommendations.md) の 10 節 |
| アプリ | `app_definitions_replica`（写し）、`app_installations`、`app_tokens`、`oauth_codes`、`api_idempotency`、`bulk_operations`、`app_subscriptions`、`app_usage_records`、`app_one_time_purchases` | [app-platform-and-apis.md](app-platform-and-apis.md) の 12 節 |
| 関数 | `function_configurations`、`function_runs`（日の分割、7 日） | [functions-sandbox.md](functions-sandbox.md) の 12 節 |
| Webhook | `webhook_subscriptions`、`webhook_deliveries`（日の分割、7 日）、`webhook_events_index` | [webhooks.md](webhooks.md) の 10 節 |
| スタッフと監査 | `staff_members`、`roles`、`staff_member_roles`、`collaborator_requests`、`audit_events`（月の区分）、`customer_sessions`、`customer_data_requests`、`plan_limits_replica`（写し） | [merchant-admin-and-staff.md](merchant-admin-and-staff.md) の 13 節 |
| セキュリティ | `data_keys`（RLS の外）、暗号化した列、`support_access_grants` | [security.md](security.md) の 14 節 |
| 運用 | `reconcile_findings`、`schema_migrations`（RLS の外）、outbox | [observability.md](observability.md) の 12 節、[delivery.md](delivery.md) の 12 節 |

## 3. 全体の DB（Aurora PostgreSQL、ショップのデータなし）

| 領域 | 表 | 正本の節 |
| --- | --- | --- |
| ショップとポッド | `shops`、`shop_hosts`（世代の列 `cache_gen`・`cache_mode`・`product_page_gen`・`bucket_gens` を含む）、`pods`（`size_tier`・`account_id`・`group_id`・`origin_ids` を含む）、`pod_groups`、`shop_load`、`hotset_stats`、`shop_moves`、`shop_lifecycle_events`、`shop_deletion_jobs` | [shops-and-pods.md](shops-and-pods.md)、[infrastructure.md](infrastructure.md)、[capacity.md](capacity.md) |
| カタログ・税・配送の参照のデータ | `fx_rates`、`product_categories`、`tax_rates`、`postal_codes`、`carrier_profiles`（ポッドへ写す） | 各領域 |
| フラッシュセール | `flash_sale_audit`、`watched_shops` | [flash-sales-and-queueing.md](flash-sales-and-queueing.md)、[observability.md](observability.md) |
| アプリ | `developer_orgs`、`apps`（`webhook_secret_ciphertext[2]`）、`app_versions`、`app_functions`、`function_artifacts`、`app_embeds`、`app_earnings` | [app-platform-and-apis.md](app-platform-and-apis.md)、[functions-sandbox.md](functions-sandbox.md)、[webhooks.md](webhooks.md) |
| スタッフと請求 | `accounts`、`account_credentials`、`admin_sessions`、`account_shops`（P4 の写し）、`organizations`、`organization_domains`、`sso_connections`、`partner_orgs`、`partner_members`、`identity_audit_events`、`operator_audit_events`、`plan_limits`、`merchant_subscriptions`、`billing_usage`、`merchant_invoices`、`merchant_invoice_lines`、`redaction_policies` | [merchant-admin-and-staff.md](merchant-admin-and-staff.md) |
| セキュリティ | `data_keys`、`retention_policies`、`legal_holds` | [security.md](security.md) |
| 運用 | `pod_scaling_plans`、`capacity_reviews`、`dr_events`、`schema_migrations`、`pod_schema_versions`、`deployments`、`api_versions`、`reindex_jobs` | [capacity.md](capacity.md)、[infrastructure.md](infrastructure.md)、[delivery.md](delivery.md)、[search-and-recommendations.md](search-and-recommendations.md) |

## 4. DB の外の置き場所

| 置き場所 | 中身 | 正本の節 |
| --- | --- | --- |
| Valkey（ポッド） | `{<shop_id>}:cart:<token>`、`{<shop_id>}:co:sem`・`co:bucket`、`{<shop_id>}:inv:avail:<item>`、`{<shop_id>}:tok:<hash>`、`{<shop_id>}:cost:<app_id>`、`{<shop_id>}:sec:…`、`{<shop_id>}:ci:window`、`{<shop_id>}:sfrl:<ip_hash>`、`{<shop_id>}:redirects`、`{<shop_id>}:pcb:<provider>:<method>`、支払いの試みの失敗の数・保護のデータの読み出しの数、`sys:inv:rebalance:<pod>` | 各領域の data-model の節 |
| Valkey（全体） | 待合室の `wr:{<sale_id>}:…`（券、`seq`、`pre`、`admitted`、`used`）、`identity` のセッション | [flash-sales-and-queueing.md](flash-sales-and-queueing.md) の 13 節 |
| KeyValueStore | ホスト → 振り分けの値（熱い集まり）、`sys:origins`、`sys:region`、許可証の鍵（`kid`）、セールの有効の印 | [shops-and-pods.md](shops-and-pods.md) の 5.2 節、[infrastructure.md](infrastructure.md) の 12 節 |
| OpenSearch（ポッド） | 索引 `products_v<n>`、別名 `products`、文書 ID `<shop_id>:<product_id>`、主のシャード 3 | [search-and-recommendations.md](search-and-recommendations.md) の 4 節 |
| S3 | `shops/<shop_id>/<media・exports・imports・themes・bulk・sitemaps・carrier-exports・labels>/…`、`functions/…`、`checkout_script_manifest`、log-archive の `audit/shops/<shop_id>/…`、保持のバケット（Object Lock） | 各領域 |
| SQS・SNS（ポッド） | outbox の話題、`search-index`、`webhook-fanout`、Webhook の結果の返り、ジョブ（ショップのメッセージ グループ） | [webhooks.md](webhooks.md) の 10 節、[search-and-recommendations.md](search-and-recommendations.md) の 10 節 |
| SQS（全体） | `webhook-send-00`〜`15`（SSE-KMS、本文は保存しない） | [ADR-0062](../decisions/0062-webhook-egress-and-payload-custody.md) |
| AppConfig | `ops.*`・`release.*`（一覧は [runbooks/README.md](../runbooks/README.md) の 2 節）、`watched_shops` | [delivery.md](delivery.md) の 3.2 節 |
| 観測 | CloudWatch Logs の欄、AMP の記録の規則、`canary_runs`（canary のアカウント） | [observability.md](observability.md) の 12 節 |

## 5. 後で決めること

- 顧客（`customers`）とメモ・タグの表の列は、E6 の `customer-accounts` と E17 の `customer-data-requests` で決める。
- ポッドの側のショップの設定の表の名前（`published_theme_version_id`、税・配送の設定の置き場所をまとめるか）は、E2 の `shop-signup-and-plans` で決める。
- 列・制約・分割・保持・量まで書いた ER 図の全体（`data-model/` に領域ごとのファイル）は、開発リポジトリの作成のときに足す。

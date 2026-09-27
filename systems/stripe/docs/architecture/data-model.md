# Data model: Stripe

データモデルの索引。テナントの分け方は [ADR-0002](../decisions/0002-account-tenancy.md)、お金の正本は [ADR-0003](../decisions/0003-double-entry-ledger.md)、冪等は [ADR-0004](../decisions/0004-idempotency.md)、カード番号の置き場所は [ADR-0005](../decisions/0005-pci-scope-segmentation.md) に従う。**各テーブルの定義の正本は、下の索引の「定義の場所」にある文書** で、ここは中核の形と横断の規則だけを書く。実装の変更（`changes/`）でマイグレーションを書くときに、ここと各文書を合わせて更新する。

## 1. 置き場所

| 置き場所 | 中身 |
| --- | --- |
| 本体の live のクラスタ（Aurora、prod） | 本番のテナントのデータ。`auth` スキーマ（利用者とセッション。RLS の外）もここだけに置く |
| 本体の test のクラスタ（Aurora、prod） | サンドボックス（テスト環境）のテナントのデータ。サンドボックスは独立した `acct_`（`parent_account_id` で本番のアカウントを指す。[api.md](api.md) の 11 節） |
| Vault DB（cde-live・cde-test の Aurora） | 暗号化したカード番号と、`pm_` との対応（[card-vault.md](card-vault.md) の 4 節）。本体のロールは接続できない |
| S3（本体・log-archive） | 監査のアーカイブ、精算ファイル・銀行の明細の原本、台帳の古いパーティション（Parquet）、本人確認の書類、Dispute の証拠のファイル、レポート |

- テストと本番はクラスタで分かれるので、テナントテーブルに `livemode` の列を持たない（API の応答では付ける）。例外は、両方の環境の行が同じ表に入るもの（Vault DB の `vault_cards` の `livemode` は、cde-live・cde-test で別のクラスタなので実際には定数）。

## 2. 中核のテーブル

```sql
-- テナント（live・test の各クラスタ）
accounts            (id,                        -- acct_
                     parent_account_id NULL,    -- サンドボックスなら本番のアカウント
                     business_type, country, default_currency,
                     default_api_version,       -- 最初の API 要求で固定（ADR-0007）
                     charges_enabled, payouts_enabled, disabled_reason,
                     requirements JSONB, current_deadline,
                     created_at)

-- テナントの中（すべて account_id を持ち、FORCE ROW LEVEL SECURITY）
customers           (account_id, id, email, name, phone, address, metadata, deleted_at, created_at,
                     PRIMARY KEY (account_id, id))
payment_methods     (account_id, id, type, customer_id NULL, billing_details,
                     card_display,              -- brand, bin6, last4, exp, funding, country
                     fingerprint,               -- 加盟店ごとの値（card-vault.md の 4 節）
                     detached_at, created_at,
                     PRIMARY KEY (account_id, id))
payment_intents     (account_id, id, amount, currency, status, capture_method,
                     customer_id NULL, payment_method_id NULL, latest_charge_id NULL,
                     amount_capturable, amount_received, client_secret_hash,
                     cancellation_reason, last_payment_error, metadata, created_at,
                     PRIMARY KEY (account_id, id))
charges             (account_id, id, payment_intent_id, internal_status,  -- pending_send / sent / unknown / authorized / ...
                     connector, connector_reference, acquirer_txn_id,
                     amount_captured, capture_before, three_d_secure, outcome, created_at,
                     PRIMARY KEY (account_id, id))
refunds             (account_id, id, charge_id, amount, status, reason,
                     failure_reason, failure_balance_transaction_id, created_at,
                     PRIMARY KEY (account_id, id))

-- 台帳（ADR-0003・0015・0016）
journal_entries     (id, account_id, entry_type, source_type, source_id,
                     idempotency_key, effective_at, reverses_entry_id, created_at)   -- 月ごとのパーティション
ledger_postings     (id, entry_id, account_id, ledger_account_id, currency, amount,
                     balance_transaction_id, created_at)                             -- 同上。amount は借方が正
balance_transactions(account_id, id, type, reporting_category, amount, fee, net,
                     available_on, status, source_type, source_id, entry_id,
                     payout_id, created_at)

-- 非同期の連携
outbox              (id BIGSERIAL, account_id, event_type, payload JSONB, trace_context, created_at)
events              (account_id, id, type, api_version, data, previous_attributes,
                     request_id, idempotency_source, created_at)                     -- 日ごとのパーティション、31 日
idempotency_keys    (account_id, key, created_at, request_hash, state, locked_until,
                     response_status, response_body, resource_id)                    -- 日ごとのパーティション、48 時間
```

### 2.1 横断の規則

- **外部キーは `account_id` を含む複合キーにする。** 別の加盟店の行を参照するデータは DB が拒否する（Slack の data-model.md と同じ）。
- **インデックスは `account_id` を先頭に置く。** ID は UUIDv7 なので、`(account_id, id)` がそのまま作成の順と一覧のカーソルになる（[api.md](api.md) の 3.3・5.1 節）。
- **お金を動かす処理は、状態のテーブル・仕訳・BalanceTransaction・`events`・`outbox` を 1 つのトランザクションで書く**（ADR-0003、[ADR-0010](../decisions/0010-payment-intent-state-machine.md)）。
- **台帳のテーブルに `UPDATE`・`DELETE` をしない。** アプリのロールから権限を外し、トリガーでも拒否し、マイグレーションの CI でも拒否する（[ADR-0032](../decisions/0032-release-safety-for-money-moving-code.md)）。
- **二重オーソリを DB で止める。** `charges` に部分一意インデックスを 2 つ張る：同じ PaymentIntent で `authorized`・`captured` は高々 1 行、`pending_send`・`sent`・`unknown` は高々 1 行（ADR-0010）。
- **カード番号・CVC の列を本体に作らない。** 本体に置くのは `pm_`、BIN、下 4 桁、有効期限、指紋だけ（ADR-0005）。
- **個人情報の列には、分類と保持の区分の注記を付ける**（マイグレーションの lint。[ADR-0024](../decisions/0024-data-retention-and-deletion.md)）。
- DB ロールは Slack と同じく `migrator`（所有者）、`app`（RLS の対象。`BYPASSRLS` なし）、`relay`（`outbox` だけ）に分け、照合・会計の `recon`（RLS を迂回できる専用のロール。操作は監査ログへ）を足す。

### 2.2 RLS の例外

RLS を掛けない（テナントの外の）テーブルは次だけ。追加するときは [security.md](security.md) の一覧と合わせて ADR か本書の更新で決める。

| テーブル | 理由 | 読める主体 |
| --- | --- | --- |
| `auth.*`（`users`、`auth_identities`、`sessions`、`passkeys`、`two_factors`、`verifications`） | 認証はテナントの外（[auth-and-keys.md](auth-and-keys.md) の 1 節） | 認証のミドルウェア |
| `connector_inbox` | 受けた時点では加盟店が分からない（[ADR-0014](../decisions/0014-connector-inbox.md)） | 反映のワーカーだけ |
| `platform_fraud_rules`、`platform_audit_events` | プラットフォームの判断 | 社内の管理画面と、評価・監査のロール |
| `business_calendars`、`fee_schedules` の既定の行、`ledger_accounts` のプラットフォームの口座 | 全加盟店に共通のマスタ | 読み取りだけ |
| `settlement_*`、`bank_statement*`、`recon_*`、`gl_exports`、`payout_batches` | 複数の加盟店にまたがる照合 | `recon` のロール |

API キーの行の検索は RLS の前に要るので、`SECURITY DEFINER` の関数 `auth_resolve_api_key(key_id)` だけで行う（[auth-and-keys.md](auth-and-keys.md) の 8 節）。

## 3. 領域ごとの索引

| 領域 | テーブル | 定義の場所 |
| --- | --- | --- |
| アカウントと認証 | `accounts`、`account_members`、`account_owners`、`invitations`、`sandbox_access`、Better Auth の `auth.*` | [auth-and-keys.md](auth-and-keys.md) の 2 節 |
| API キーと監査 | `api_keys`、`access_policies`、`security_events`、`api_request_logs` | [auth-and-keys.md](auth-and-keys.md) の 5・7・9 節 |
| 公開 API | `idempotency_keys`、`rate_limit_overrides` | [api.md](api.md) の 7.2 節、[rate-limiting.md](rate-limiting.md) の 6 節 |
| 決済 | `payment_intents`、`charges`、`refunds`、`setup_intents`、`setup_attempts`、`connector_requests` | [payments.md](payments.md) の 2 節 |
| 決済手段 | `customers`、`payment_methods`、`virtual_bank_accounts`、`cash_balance_transactions` | [payment-methods.md](payment-methods.md) の 2・6 節 |
| コネクタの通知 | `connector_inbox` | [ADR-0014](../decisions/0014-connector-inbox.md) |
| Dispute | `disputes`、`dispute_files`、`early_fraud_warnings`、`files` | [disputes.md](disputes.md) の 2 節 |
| 台帳 | `ledger_accounts`、`journal_entries`、`ledger_postings`、`ledger_entry_keys`、`ledger_balance_slots`、`ledger_balance_snapshots`、`balance_transactions`、`balance_source_type_slots`、`balance_daily_summaries`、`reserve_holds`、`fee_schedules`、`fx_quotes`（S2）、`business_calendars` | [ledger.md](ledger.md) の 3〜7・10 節 |
| 入金と照合 | `payout_settings`、`bank_accounts`、`payouts`、`payout_batches`、`settlement_files`、`settlement_lines`、`bank_statements`、`bank_statement_lines`、`recon_matches`、`recon_breaks`、`gl_exports` | [payouts-and-reconciliation.md](payouts-and-reconciliation.md) の 2・8 節 |
| Event と Webhook | `outbox`、`events`、`event_summaries`、`webhook_endpoints`、`webhook_endpoint_secrets`、`webhook_deliveries`、`webhook_delivery_attempts` | [events-and-webhooks.md](events-and-webhooks.md) の 13 節 |
| Checkout | `checkout_sessions`、`checkout_branding`、`konbini_vouchers` | [checkout.md](checkout.md) の 15 節 |
| 不正検知 | `fraud_rules`、`platform_fraud_rules`、`fraud_lists`、`fraud_list_items`、`fraud_evaluations`、`reviews` | [fraud.md](fraud.md) の 4.3 節 |
| 加盟店の審査 | `account_capabilities`、`account_persons`、`verification_checks`、`verification_documents`、`risk_reviews`、`account_reserves` | [merchant-onboarding.md](merchant-onboarding.md) の 5 節 |
| 監査 | `audit_events`、`platform_audit_events` | [ADR-0023](../decisions/0023-audit-log.md)、[security.md](security.md) の 6 節 |
| ダッシュボード | `report_runs`、`dashboard_preferences` | [dashboard.md](dashboard.md) の 13 節 |
| リリース | `shadow_results`（影の実行の比較） | [delivery.md](delivery.md) の 5.2 節 |
| Vault（CDE） | `vault_cards`、`vault_deks` | [card-vault.md](card-vault.md) の 4 節 |

## 4. 保持

テーブルごとの保持期間の正本は [security.md](security.md) の 13 節（[ADR-0024](../decisions/0024-data-retention-and-deletion.md)）。パーティションで消すもの（`idempotency_keys` 48 時間、`events` 31 日、`webhook_delivery_attempts` 15 日、`api_request_logs` 30 日）は、`DROP` の周期を各文書に書いている。法定の保存期間は法務の確認待ち（[intent.md](../intent.md)）。

## 5. 段階ごとの変化

| 段階 | 変化 |
| --- | --- |
| S2 | 台帳と、同じトランザクションで書く状態のテーブル（決済・返金・入金）を `account_id` のハッシュで同じシャードに置く（仮想のシャード 1,024 → 物理のクラスタ。[ADR-0016](../decisions/0016-hot-accounts-and-ledger-sharding.md)）。Webhook の配信の表を配信専用のクラスタへ移す（[events-and-webhooks.md](events-and-webhooks.md) の 11 節） |
| S3 | 加盟店をセルに固定し、テナントのデータはセルの中に閉じる。キー → アカウント → セルの対応表をセルの外（Global）に置く（[ADR-0031](../decisions/0031-active-active-cells.md)） |

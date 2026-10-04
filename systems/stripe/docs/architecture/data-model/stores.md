# Data model: DB 以外の置き場所と本文の形

Valkey のキー、S3 の配置、outbox の topic と SQS のメッセージ、Event と Webhook の本文、仕訳の種類と冪等キー。規約は [data-model.md](../data-model.md) の 3 節。

## 1. Valkey・ElastiCache

### 1.1 本体の Valkey

**正本を置かない。** 失っても決済は続く（fail-open。[rate-limiting.md](../rate-limiting.md) の 3.5 節、[fraud.md](../fraud.md) の 4.4 節）。`{...}` はクラスタのハッシュタグ（S2 でアカウント × 環境を同じシャードに置く）。`env` は `live` / `test`。

| キー | 型 | TTL | 中身 | 書く・読む |
| --- | --- | --- | --- | --- |
| `rl:{acct_<id>:<env>}:<limit>:<subject>` | string（GCRA の TAT） | 制限の窓 | レート制限 L3・L4（[rate-limiting.md](../rate-limiting.md) の 3.2 節） | api の Lua スクリプト |
| `rl:{acct_<id>:<env>}:conc:<scope>` | sorted set（要求 ID → 期限） | 45 秒の要素 | 同時実行 L5 | api |
| `rl:{acct_<id>:<env>}:pi_update:<pi_id>` | string（GCRA） | 1 時間 | PaymentIntent の更新の回数 L6 | api |
| `rl:auth:ip:<ip>`・`rl:auth:email:<sha256(email)>` | string（GCRA） | 窓 | キーの検証の失敗、ログイン・OTP の総当たり L2 | api、dashboard |
| `fv:{acct_<id>}:<dim>:<hmac(value)>:<outcome>:<gran>:<bucket>` | integer | 窓 ＋ 1 バケット | 速度の集計。`dim` は `fp`・`email`・`ip`、`outcome` は `authorized`・`declined`・`blocked`、`gran` は `m`（1 分 × 60）・`h`（1 時間 × 24）・`d`（1 日 × 7） | 速度の Worker（書く）、Payments（`MGET`） |
| `fv:{platform}:<dim>:<hmac(value)>:...` | integer | 同上 | 加盟店をまたぐ集計（内部向けの指紋） | 同上。プラットフォームのルールだけが読む |
| `fv:seen:<evt_id>` | string | 7 日 | 速度の集計の二重の計上の防止 | 速度の Worker |
| `wh:conc:<we_id>` | sorted set | 送信のタイムアウト ＋ 余裕 | エンドポイントごとの同時送信（上限 10） | webhook-sender |
| `wh:rate:{acct_<id>:<env>}` | string（GCRA） | 1 秒 | アカウントごとの送信の速さ（100 件/秒） | webhook-sender |
| チャンネル `apikey:invalidate` | pub/sub | — | `{ "key_id": "rak_...", "env": "live" }`。キーの検証のキャッシュ（30 秒）を消す | 期限切れ・ローテーション・ポリシーの変更 → api |
| チャンネル `fraud:ruleset:invalidate` | pub/sub | — | `{ "account_id", "version" }`。ルールとリストのキャッシュを消す（届かなくても 10 秒で反映） | ルールの保存 → Payments |

- 値に PII を置かない。メール・IP は `HMAC(速度用の鍵, 値)` にしてからキーにする。
- セッションは Aurora に置く（`auth.sessions`）。Valkey に置かない。

### 1.2 CDE の ElastiCache

| キー | 型 | TTL | 中身 |
| --- | --- | --- | --- |
| `cvc:<card_ref>` | string | 30 分 | `cde-sad` で暗号化した CVC。最初のオーソリで `GETDEL` |

- 永続化（スナップショット・AOF）を無効にする。本体から接続できない（[card-vault.md](../card-vault.md) の 3.3 節）。

## 2. S3

バケットの名前は開発リポジトリで決める。下は役割とキーの形。`env` は `live` / `test`。

| バケット（役割） | アカウント | キーの形 | 暗号化 | 保持 |
| --- | --- | --- | --- | --- |
| files | prod | `<env>/<account_id>/<file_id>` | `files` | Dispute の証拠は 7 年、ロゴは外して 30 日 |
| kyc | prod | `<account_id>/<person_id or company>/<document_id>` | `kyc` | 取引の終了から 7 年（法務の確認待ち） |
| settlement-raw | prod | `<connector>/<yyyy>/<mm>/<dd>/<settlement_file_id>` | `files` | 10 年、Object Lock（コンプライアンス）。大阪へ複製 |
| bank-statements-raw | prod | `<bank>/<bank_account_ref>/<yyyy-mm-dd>/<statement_id>` | `files` | 10 年、Object Lock |
| connector-inbox-files | prod | `<connector>/<yyyy>/<mm>/<dd>/<received_id>` | `files` | 13 か月（[ADR-0014](../../decisions/0014-connector-inbox.md)） |
| payout-files | prod | `<bank>/<yyyy-mm-dd>/<payout_batch_id>.txt`（全銀の予備） | `files` | 10 年 |
| ledger-archive | prod | Iceberg の表 `journal_entries`・`ledger_postings`・`connector_requests`（月のパーティション） | `backup` | 10 年、Object Lock |
| reports | prod | `<env>/<account_id>/<report_run_id>.csv` | `files` | `expires_at` まで |
| gl-exports | prod | `<yyyy>/<mm>/gl-<yyyy-mm-dd>.csv` | `files` | 10 年 |
| audit-archive | log-archive | `audit/<env>/<account_id>/<yyyy>/<mm>/<dd>/<hh>/<chunk>.jsonl.gz` と `digests/<yyyy>/<mm>/<dd>/<hh>.sig` | `audit` | 7 年、Object Lock |
| cde-audit | log-archive | Firehose の既定の日付の区切り | CDE の鍵 | 13 か月、Object Lock。本体は読めない |

- カード番号を S3 に置かない。本体のバケットは Macie で PAN の形を走査する。

## 3. outbox と SQS

### 3.1 outbox の topic

`outbox.payload` は topic ごとの Zod スキーマ（`packages/contract`）。共通の形：

```json
{ "topic": "event.created", "account_id": "uuid", "env": "live", "occurred_at": "2026-09-28T01:02:03.456Z", "data": { } }
```

| topic | `data` | 行き先の SQS | 受け手 |
| --- | --- | --- | --- |
| `event.created` | `{ event_id, type, created_on }` | `webhook-fanout`、`fraud-velocity` | webhook-router、速度の Worker |
| `capture.requested` | `{ charge_id }` | `captures` | `automatic_async` のキャプチャ（冪等キー `capture:{charge_id}`） |
| `refund.send` | `{ refund_id }` | `refunds` | 返金の送信 |
| `unknown_outcome.inquire` | `{ charge_id, attempt }` | `recovery`（遅延つき） | 回復のジョブ |
| `vault.card_attached` | `{ payment_method_id, attached }` | `vault-sync` | vault-core への同期 |
| `vault.publishable_key_synced` | `{ api_key_id, status, expires_at }` | `vault-sync` | 同上 |
| `search.index` | `{ object_type, object_id }` | `search-index`（E11） | 索引の更新 |
| `shadow.compare` | `{ flag_name, subject_type, subject_id }` | `shadow` | 影の実行 |
| `email.send` | `{ template, to_user_ids, params }` | `emails` | 通知のメール（宛先は ID で渡す） |

### 3.2 CDE → 本体の `connector-results`

唯一の CDE → 本体の経路（[ADR-0029](../../decisions/0029-multi-account-and-cde-layout.md)）。**PAN・CVC・`card_ref` を含めない**（受け手でスキーマの許可リストで検査し、PAN の形を見つけたら捨ててアラート）。

```json
{
  "message_id": "uuid",
  "env": "live",
  "kind": "authorization_result | three_ds_result | notification",
  "connector": "acq_x",
  "connector_reference": "ch_...由来の参照番号",
  "account_id": "uuid",
  "payment_method_id": "uuid",
  "result": { "outcome": "approved", "acquirer_txn_id": "...", "raw_code": "00", "normalized_code": null },
  "notification": { "notification_id": "...", "type": "dispute", "payload": { } },
  "occurred_at": "2026-09-28T01:02:03Z"
}
```

- 受け手は `connector_inbox` に `received_via = 'sqs'` で記録してから反映する。

### 3.3 本体 → CDE（PrivateLink）の要求

| API | 本体が渡すもの | 本体が受け取るもの |
| --- | --- | --- |
| `bind_card_input` | `card_input`、`account_id`、`pm_`、公開可能キーの ID | `brand`・`bin6`・`last4`・`exp_*`・`funding`・`country`、`fingerprint`（加盟店向け）、`fingerprint_internal` |
| `get_card` | `pm_`、`account_id` | 表示用の情報 |
| `set_card_attached` | `pm_`、`account_id`、`attached` | なし |
| `delete_card` | `pm_`、`account_id` | なし |
| `sync_publishable_key` | 公開可能キーの ID、`account_id`、状態、期限 | なし |
| connector-gateway の `authorize`・`capture`・`void`・`refund`・`inquire`・`verify`・`authenticate_*` | `pm_`、`account_id`、金額、通貨、参照番号、3DS の結果 | 結果（カード番号を含まない） |

## 4. Event と Webhook の本文

### 4.1 Event（API と Webhook の本文）

`events.data` の正規形を、エンドポイント（なければ Event）のバージョンで描画する（[ADR-0026](../../decisions/0026-snapshot-event-model.md)）。

```json
{
  "id": "evt_...",
  "object": "event",
  "api_version": "2026-09-26.<名前>",
  "created": 1790400000,
  "data": { "object": { "id": "pi_...", "object": "payment_intent", "...": "..." }, "previous_attributes": { } },
  "livemode": true,
  "pending_webhooks": 1,
  "request": { "id": "req_... | null", "idempotency_key": "... | null" },
  "type": "payment_intent.succeeded"
}
```

- `livemode` はクラスタから、`pending_webhooks` は `webhook_deliveries` から求める。`account`・`context` は出さない。

### 4.2 Webhook の HTTP

```
POST <endpoint url>
Content-Type: application/json; charset=utf-8
User-Agent: <Brand>/1.0 (+https://<domain>/docs/webhooks)
<Brand>-Signature: t=<UNIX 秒>,v1=<hex(HMAC-SHA256(秘密, "{t}.{本文}"))>[,v1=<旧い秘密の署名>]

<4.1 節の JSON>
```

- 再試行ごとに `t` と署名を作り直す（[ADR-0025](../../decisions/0025-webhook-signing-and-isolated-delivery.md)）。本文は描画の結果で、同じバージョンなら同じ本文になる。

## 5. 仕訳の種類と冪等キー

仕訳は `ledger_post` だけで書く（[ledger.md](ledger.md) の 2 節）。明細の形（借方を正）と BT は [ledger.md](../ledger.md) の 2.3 節、[payments.md](../payments.md) の 9 節、[disputes.md](../disputes.md) の 5.2 節と同じ。

### 5.1 仕訳の入力の形

```json
{
  "account_id": "uuid",
  "entry_type": "capture",
  "source_type": "charge",
  "source_id": "uuid",
  "idempotency_key": "capture:<charge_id>",
  "effective_at": "2026-09-28T01:02:03Z",
  "metadata": { "fee_schedule_id": "uuid" },
  "postings": [
    { "ledger_account": { "owner": "merchant", "kind": "merchant_pending", "sub_key": "", "currency": "jpy" }, "amount": -9640, "balance_transaction": "bt-1" },
    { "ledger_account": { "owner": "platform", "kind": "connector_receivable", "sub_key": "acq_x", "currency": "jpy" }, "amount": 10000 },
    { "ledger_account": { "owner": "platform", "kind": "fee_revenue", "sub_key": "", "currency": "jpy" }, "amount": -360 }
  ],
  "balance_transactions": [
    { "ref": "bt-1", "type": "charge", "reporting_category": "charge", "amount": 10000, "fee": 360, "fee_details": [{ "type": "<brand>_fee", "amount": 360, "currency": "jpy" }], "available_on": "2026-10-02", "source_group": "card" }
  ]
}
```

### 5.2 種類の一覧

| `entry_type` | 明細（借方 + / 貸方 −） | BT の `type` | 冪等キー |
| --- | --- | --- | --- |
| `capture` | `connector_receivable` + / `merchant_pending` − / `fee_revenue` − | `charge` | `capture:{charge_id}` |
| `async_payment` | 同上（コンビニの入金の速報） | `payment` | `async_payment:{charge_id}` |
| `cash_balance_funding` | `bank_cash` + / `customer_cash_balance` − | なし（`cash_balance_transactions`） | `cash_funding:{bank_statement_line_id}` |
| `cash_balance_applied` | `customer_cash_balance` + / `merchant_pending` − / `fee_revenue` − | `payment` | `cash_applied:{payment_intent_id}:{seq}` |
| `availability` | `merchant_pending` + / `merchant_available` −（ローリングのリザーブは `merchant_available` + / `merchant_reserved` − も） | なし（BT の `status` を更新） | `availability:{account_id}:{currency}:{date}` |
| `refund` | `merchant_available` + / `connector_receivable` −（口座への振込は `refunds_payable` −、現金残高へは `customer_cash_balance` −） | `refund`・`payment_refund` | `refund:{refund_id}:create` |
| `refund_transfer_complete` | `refunds_payable` + / `bank_cash:refund` − | なし | `refund:{refund_id}:transfer` |
| `refund_reversal` | 作成の逆 | `refund_failure` | `refund:{refund_id}:reverse` |
| `dispute_withdrawal` | `merchant_available` +（額＋手数料） / `connector_receivable` − / `fee_revenue` − | `adjustment`（`dispute`） | `dispute:{dispute_id}:withdraw` |
| `dispute_reinstatement` | `connector_receivable` + / `merchant_available` − | `adjustment`（`dispute_reversal`） | `dispute:{dispute_id}:reinstate` |
| `reserve_hold` | `merchant_available` + / `merchant_reserved` − | `reserve_hold` | `reserve_hold:{reserve_id}:{date}` |
| `reserve_release` | `merchant_reserved` + / `merchant_available` − | `reserve_release` | `reserve_release:{reserve_hold_id}` |
| `payout_create` | `merchant_available` + / `payouts_in_transit` − | `payout` | `payout:{payout_id}:create`（自動入金の作成は `payout:auto:{account_id}:{currency}:{date}` で入金の行を 1 回に限る） |
| `payout_debit_confirmed` | `payouts_in_transit` + / `bank_cash:payout` − | なし | `payout:{payout_id}:debit` |
| `payout_failure` | `payouts_in_transit` +（返却なら `bank_cash:payout` +） / `merchant_available` − | `payout_failure` | `payout:{payout_id}:fail` |
| `payout_cancel` | `payouts_in_transit` + / `merchant_available` − | `payout_cancel` | `payout:{payout_id}:cancel` |
| `settlement_receipt` | `bank_cash:settlement` + / `processing_cost` + / `connector_receivable` − | なし | `recon:settlement_line:{id}`（シャードごとに分けた単位） |
| `recon_tolerance` | `processing_cost` ± / `connector_receivable` ∓ | なし | `recon:{source}:{external_id}` |
| `suspense_in` | `bank_cash` + / `suspense:{source}` − | なし | `suspense:{recon_break_id}:in` |
| `suspense_resolve` | `suspense:{source}` + / 正しい口座 − | 加盟店の残高を動かすなら `adjustment` | `suspense:{recon_break_id}:resolve` |
| `write_off` | `loss_write_off` + / 対象の口座 − | 加盟店の残高を動かすなら `adjustment` | `write_off:{recon_break_id}` |
| `fee` | `merchant_available` + / `fee_revenue` − | `<brand>_fee` | `fee:{account_id}:{fee_kind}:{period}` |
| `correction` | 逆の仕訳 ＋ 正しい仕訳（`reverses_entry_id`） | 必要に応じて `adjustment` | `correction:{correction_id}:{n}` |

- 仕訳の種類から BT の `reporting_category` への対応表は `packages/ledger` に置き、表駆動テストで固定する（[ADR-0015](../../decisions/0015-chart-of-accounts-and-balance-transactions.md)）。
- プラットフォームの口座（`connector_receivable` など）の明細も、仕訳の `account_id` を持つ。精算の着金のような加盟店をまたぐ入金は、加盟店（シャード）ごとの仕訳に分ける。

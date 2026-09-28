# Ledger: Stripe

複式簿記の台帳、勘定体系、残高（保留中・利用可能）、手数料、通貨の換算、加盟店に見せる BalanceTransaction。台帳は [ADR-0003](../decisions/0003-double-entry-ledger.md)、冪等は [ADR-0004](../decisions/0004-idempotency.md)、金額の型は [ADR-0001](../decisions/0001-platform-and-stack.md)、勘定体系は [ADR-0015](../decisions/0015-chart-of-accounts-and-balance-transactions.md)、大口の加盟店の書き込みの集中は [ADR-0016](../decisions/0016-hot-accounts-and-ledger-sharding.md) に従う。入金（Payout）と照合は [payouts-and-reconciliation.md](payouts-and-reconciliation.md) にある。

## 1. 本家 Stripe の見え方

加盟店から見たお金の見え方は、本家に揃える。台帳の内部は加盟店に見せない。

| 本家の概念 | 内容 | このシステムでの持ち方 |
| --- | --- | --- |
| Balance | 通貨ごとの `available`（入金・返金に使える）と `pending`（まだ使えない）。`source_types` でカードなどの内訳を持つ（[Balance object](https://docs.stripe.com/api/balance/balance_object)） | 加盟店ごと・通貨ごとの台帳の口座（保留中・利用可能・リザーブ）の残高 |
| BalanceTransaction | 残高を動かす 1 件ごとの記録。`amount`（総額）、`fee`、`fee_details`、`net = amount - fee`、`available_on`、`status`（`pending` / `available`）、`type`、`reporting_category`、`source`、`exchange_rate`（[BalanceTransaction object](https://docs.stripe.com/api/balance_transactions/object)） | 仕訳から作る、加盟店向けの射影（6 節） |
| `available_on` | 純額が利用可能になる日。入金のスケジュールは「いつ送るか」だけを決め、`available_on` は変えない（[Payouts](https://docs.stripe.com/payouts)） | 決済の確定時に、売上処理のタイミングから求めて固定する（5 節） |
| 売上処理のタイミング | 日本は初回 7 暦日、既定 4 営業日（[Payouts](https://docs.stripe.com/payouts)） | 加盟店ごとの設定。既定値は本家に揃える |
| リザーブ | 固定（指定日に解放）とローリング（決済から N 日後に解放）。返金・Dispute が起きたら、対応するリザーブを解放して充てる（[Reserves FAQ](https://support.stripe.com/questions/reserves-frequently-asked-questions)） | 加盟店のリザーブの口座（4.4 節） |
| マイナス残高 | 以後の売上で相殺し、足りなければ加盟店の銀行口座から引き落とす（[Payouts](https://docs.stripe.com/payouts)）。返金は利用可能な残高から引き、足りなければカードは保留・他は失敗にする（[支払いの返金とキャンセル](https://docs.stripe.com/refunds)） | 利用可能の口座はマイナスを許す（Dispute で起こりうる。4.5 節）。返金は残高を確かめる（[payments.md](payments.md) の 10.2 節） |
| `reporting_category` | 会計向けの分類。`charge` / `payment` → `charge`、`refund` / `payment_refund` → `refund`、`payout_cancel` / `payout_failure` → `payout_reversal`、`stripe_fee` → `fee`（本システムでは `<brand>_fee`）、`reserved_funds` → `risk_reserved_funds` など（[Reporting categories](https://docs.stripe.com/reports/reporting-categories)） | 仕訳の種類から決まる対応表（6 節） |

## 2. 勘定体系

口座（ledger account）は「持ち主 × 種類 × 通貨」で 1 つに決まる。持ち主は加盟店（`account_id`）か、プラットフォーム（自社）。テストと本番は DB のクラスタが別なので、口座にも環境の列は要らない（[ADR-0002](../decisions/0002-account-tenancy.md)）。

符号は、**借方を正、貸方を負** とする。資産・費用の口座は正の残高、負債・収益の口座は負の残高が普通の状態である。加盟店に見せる残高は、負債の口座の残高の符号を反転したものになる。

### 2.1 加盟店の口座（自社から見た負債）

| 種類 | 意味 | Balance での見え方 |
| --- | --- | --- |
| `merchant_pending` | まだ使えない売上 | `pending` |
| `merchant_available` | 入金・返金に使える売上。マイナスを許す（Dispute の引き落としのとき） | `available` |
| `merchant_reserved` | リスクによる保留（リザーブ） | 本家の `risk_reserved` の残高種別に当たる。MVP ではダッシュボードにだけ出す |

### 2.2 プラットフォームの口座

| 種類 | 区分 | 意味 |
| --- | --- | --- |
| `connector_receivable:{connector}` | 資産 | 決済代行・アクワイアラ・コンビニ収納の事業者からの未収金。決済の確定で増え、精算で減る |
| `bank_cash:{bank_account}` | 資産 | 自社の銀行口座の預金。用途ごと（精算の受け取り、入金の払い出し、振込専用口座）に分ける |
| `payouts_in_transit` | 資産 | 加盟店への入金のうち、銀行に依頼して出金を確認するまでのもの |
| `refunds_payable` | 負債 | コンビニ払い・銀行振込の返金のうち、顧客の口座への振込を終えていないもの（[payments.md](payments.md) の 9 節） |
| `customer_cash_balance` | 負債 | 銀行振込で顧客から受け取り、まだ決済に充てていないお金（本家の Customer の cash balance に当たる。[payment-methods.md](payment-methods.md)） |
| `fee_revenue` | 収益 | 決済手数料、Dispute の手数料 |
| `fx_revenue` | 収益 | 通貨の換算の手数料 |
| `processing_cost:{connector}` | 費用 | 決済代行に払う手数料（精算で確定する） |
| `fx_position:{currency}` | 資産または負債 | 通貨の換算の建玉。通貨をまたぐ仕訳を、通貨ごとに釣り合わせるための口座（7 節） |
| `fx_gain_loss` | 損益 | 換算のレートと、実際の精算のレートの差 |
| `loss_write_off` | 費用 | 回収できなかったマイナス残高、承認済みの照合の差の償却 |
| `suspense:{source}` | 仮勘定 | 照合で説明のつかないお金を一時的に置く（[payouts-and-reconciliation.md](payouts-and-reconciliation.md)） |

- 勘定の種類は、コードの列挙型と DB のマスタで管理する。新しい種類は ADR か、この文書の更新で足す。
- 社内の会計の勘定科目（売掛金、預り金、売上高など）との対応は、総勘定元帳への出力で行う（[payouts-and-reconciliation.md](payouts-and-reconciliation.md)）。台帳の種類を会計の科目に合わせて細かくしない。
- 決済手数料にかかる消費税の扱い（`fee_details` の `tax`）は、法務・税理士の確認待ち（[intent.md](../intent.md) の「法務の確認待ち」）。結論に応じて `tax_payable` の口座を足す。

### 2.3 主な仕訳

JPY、手数料 3.6% の例（本家の日本の料金は国内カード 3.6%、[Stripe 料金](https://stripe.com/jp/pricing)）。借方を正、貸方を負で書く。

| 事象 | 仕訳 | BalanceTransaction |
| --- | --- | --- |
| カードの決済の確定（10,000 円） | `connector_receivable` +10,000 / `merchant_pending` −9,640 / `fee_revenue` −360 | `charge`、amount 10,000、fee 360、net 9,640 |
| 利用可能への移動（日次の一括） | `merchant_pending` +Σnet / `merchant_available` −Σnet | 作らない。対象の BT の `status` を `available` にする（5 節） |
| 全額の返金（カード） | `merchant_available` +10,000 / `connector_receivable` −10,000 | `refund`、amount −10,000、fee 0 |
| 返金（コンビニ・銀行振込の口座への振込） | 作成：`merchant_available` +X / `refunds_payable` −X。振込の完了：`refunds_payable` +X / `bank_cash:refund` −X | `payment_refund`（作成の時点で 1 件） |
| 返金の失敗（仕訳の後） | 作成の仕訳の逆 | `refund_failure`（Refund の `failure_balance_transaction`） |
| Dispute の発生（手数料 1,500 円。[Stripe 料金](https://stripe.com/jp/pricing)） | `merchant_available` +11,500 / `connector_receivable` −10,000 / `fee_revenue` −1,500 | `adjustment`（`reporting_category` は `dispute`） |
| Dispute の勝訴 | `connector_receivable` +10,000 / `merchant_available` −10,000 | `adjustment`（`dispute_reversal`） |
| リザーブの保留 | `merchant_available` +X / `merchant_reserved` −X | `reserve_hold` |
| リザーブの解放 | `merchant_reserved` +X / `merchant_available` −X | `reserve_release` |
| 入金の作成 | `merchant_available` +P / `payouts_in_transit` −P | `payout`、amount −P |
| 入金の出金の確認 | `payouts_in_transit` +P / `bank_cash:payout` −P | 作らない（内部の振替） |
| 入金の失敗 | `payouts_in_transit` +P（出金後の返却なら `bank_cash:payout` +P）/ `merchant_available` −P | `payout_failure`、amount +P |
| 決済代行からの精算の着金 | `bank_cash:settlement` +N / `processing_cost` +C / `connector_receivable` −(N+C) | 作らない |

- 返金で決済手数料を返さない（fee 0）のは、本家に揃えたもの（[支払いの返金とキャンセル](https://docs.stripe.com/refunds)、[payments.md](payments.md)）。
- 返金は `merchant_available` から引く（本家も利用可能な残高を使い、保留中の金額は使わない。[支払いの返金とキャンセル](https://docs.stripe.com/refunds)）。足りないときの扱いは [payments.md](payments.md) の 10.2 節。Dispute も `merchant_available` から引き、マイナスを許す（4.5 節）。
- Dispute の金額・手数料の詳細は [disputes.md](disputes.md)、決済の状態遷移は [payments.md](payments.md) にある。

## 3. 仕訳のスキーマと制約

列・制約・索引の正本は [data-model/ledger.md](data-model/ledger.md)。仕訳の種類と冪等キーの一覧は [data-model/stores.md](data-model/stores.md) の 5 節。

```sql
ledger_accounts (id, account_id,           -- 持ち主。プラットフォームは NULL
                 kind, sub_key,             -- 例：kind = connector_receivable, sub_key = 'acq_x'
                 currency,                  -- ISO 4217（小文字）
                 aggregate_mode,            -- 'slotted' | 'snapshot_only'（ADR-0016）
                 slot_count,                -- 集計の分割数。既定 1
                 created_at,
                 UNIQUE (account_id, kind, sub_key, currency))

journal_entries (id, account_id,           -- 業務上の持ち主の加盟店（RLS の対象）
                 entry_type,                -- capture, refund, dispute, availability, payout, ...
                 source_type, source_id,    -- 例：payment_intent / pi_xxx
                 idempotency_key,           -- 内部の冪等キー（ADR-0004）
                 effective_at,              -- 会計上の日時。created_at より前にしない
                 reverses_entry_id,         -- 取り消しの仕訳なら元の仕訳
                 fx_quote_id,               -- 換算があれば（10 節）
                 metadata,                  -- 適用した料金表の版など（7.1 節）
                 created_at,
                 PRIMARY KEY (created_at, id)) PARTITION BY RANGE (created_at)

ledger_postings (id, entry_id, account_id, ledger_account_id,
                 currency, amount,          -- bigint。借方が正、貸方が負。0 は禁止
                 balance_transaction_id,    -- 加盟店の口座の行だけ
                 created_at,
                 PRIMARY KEY (created_at, id)) PARTITION BY RANGE (created_at)

ledger_entry_keys (account_id, idempotency_key, entry_id, created_at,
                   PRIMARY KEY (account_id, idempotency_key))
```

- **1 つの仕訳は 1 つの加盟店に属する。** プラットフォームの口座への行も、その仕訳の `account_id` を持つ。RLS（[ADR-0002](../decisions/0002-account-tenancy.md)）がそのまま効き、S2 のシャードでも 1 つの仕訳が 1 つのシャードに収まる（9 節）。
- **通貨ごとに釣り合う。** コミット時に動く遅延制約のトリガーで、仕訳ごと・通貨ごとに `SUM(amount) = 0`、行が 2 つ以上、行の通貨と口座の通貨が一致することを確かめる。満たさなければコミットが失敗する。
- **追記のみ。** アプリのロールから `UPDATE` / `DELETE` の権限を外し、さらにトリガーで拒否する。誤りは `reverses_entry_id` を持つ逆の仕訳で直す。
- **仕訳ごとに冪等キー。** パーティションをまたぐ一意制約は PostgreSQL で張れないため、`ledger_entry_keys`（パーティションなし）で一意にする。キーは操作から決まる値（例：`capture:{payment_intent_id}:{attempt}`、`availability:{account_id}:{currency}:{date}`、`payout:{payout_id}:create`）。同じキーで 2 回目の書き込みが来たら、既存の仕訳を返す。
- **状態の遷移と同じトランザクション。** 決済のキャプチャ、返金、入金の作成は、状態のテーブルの更新、仕訳、BalanceTransaction、outbox（Event）を 1 つのトランザクションで書く。
- 金額の計算は `packages/money` だけで行い、`number` を使わない（[ADR-0001](../decisions/0001-platform-and-stack.md)）。

### パーティション

- `journal_entries` と `ledger_postings` は、`created_at` の月ごとのパーティションにする（[ADR-0003](../decisions/0003-double-entry-ledger.md)）。S1 で 1 日数百万行。
- 古いパーティションも消さない。お金の記録の保存期間は、会計・法令の要件に合わせる（10 年を想定。帳簿等の保存期間は法務の確認待ち。[intent.md](../intent.md)）。13 か月より古いパーティションは、読み取り専用のテーブル空間か S3 の Parquet（Iceberg）に移し、照合と監査の問い合わせはそちらから引く。
- 残高の計算は、パーティションを全部読まずに済むよう、日次のスナップショット（4.2 節）から始める。

## 4. 残高

### 4.1 残高の集計

残高は仕訳の合計が正本である。API の応答と入金の判定のために、集計も持つ。持ち方は口座の `aggregate_mode` で分ける（[ADR-0016](../decisions/0016-hot-accounts-and-ledger-sharding.md)）。

| モード | 対象 | 更新 | 読み方 |
| --- | --- | --- | --- |
| `slotted` | 加盟店の口座 | 仕訳と同じトランザクションで、`ledger_balance_slots` の 1 行を加算する。どのスロットかは仕訳の ID のハッシュで決める | 全スロットの合計 |
| `snapshot_only` | プラットフォームの口座 | 仕訳のときには更新しない | 日次のスナップショット＋その後の行の合計（照合と会計でだけ読む） |

```sql
ledger_balance_slots (ledger_account_id, slot, account_id,
                      balance,               -- bigint
                      last_posting_at,
                      PRIMARY KEY (ledger_account_id, slot))
```

- 普通の加盟店は `slot_count = 1`。書き込みが集中する口座は、運用でスロットを増やす（8 節）。
- プラットフォームの口座（`fee_revenue`、`connector_receivable` など）は、全加盟店の決済が書き込む最も熱い口座である。即時の残高を要する処理がないので、集計を持たない。

### 4.2 日次のスナップショットと検証

毎日 JST 0:00 を締めとして、次のジョブを reader で動かす（[ADR-0003](../decisions/0003-double-entry-ledger.md) の Confirmation）。

1. `ledger_balance_snapshots (ledger_account_id, as_of_date, balance)` を、前日のスナップショット＋その日の行の合計で作る。
2. 加盟店・通貨・日ごとの集計 `balance_daily_summaries`（BalanceTransaction の `reporting_category` ごとの件数・総額・手数料・純額）を作る。ダッシュボードのホームとレポートが読む（[dashboard.md](dashboard.md) の 14 節）。
3. 次の不変条件を確かめる。1 つでも破れたら SEV2 とする（runbook の `balance-drift.md`）。

| 検査 | 内容 |
| --- | --- |
| 仕訳の釣り合い | その日のすべての仕訳で、通貨ごとの合計が 0 |
| 全体の釣り合い | 通貨ごとに、全口座のスナップショットの合計が 0 |
| 集計の一致 | `slotted` の口座で、スロットの合計 = スナップショット＋締め以降の行の合計 |
| 射影の一致 | 加盟店・通貨ごとに、BalanceTransaction の `net` の合計 = `merchant_*` の口座の残高（符号反転） |
| 保留中の期限 | `available_on` を 1 営業日以上過ぎた `pending` の BT が 0 件 |
| 再計算 | 週次で、ランダムに選んだ加盟店の残高を、スナップショットを使わずに仕訳の全件から計算し直して一致を見る |

- 集計がずれていたら、スナップショットと行から正しい値を計算し、スロットを直す。直すのは集計だけで、仕訳は変えない。原因を調べるまで、その加盟店の自動入金を止める。

### 4.3 Balance API

`GET /v1/balance` は本家と同じ形で返す。

- `available`・`pending` は、加盟店の `merchant_available`・`merchant_pending` のスロットの合計（符号反転）を通貨ごとに返す。
- `source_types`（`card`、`bank_account` など）は、BalanceTransaction を決済手段の種類で集計したものを、別の小さな集計（`balance_source_type_slots`）に持つ。MVP は `card` とそれ以外（`bank_account`）の 2 つに分ける（決定）。本家の細かい分類は E4 の `balance-api` の Story で本家のサンドボックスを見て揃える。
- `instant_available`、`connect_reserved`、`issuing`、`refund_and_dispute_prefunding` は返さない（即時入金、Connect、Issuing は範囲外。[intent.md](../intent.md)）。

### 4.4 リザーブ

- リスクの担当者が、社内の画面から加盟店にリザーブの計画を設定する。加盟店向けの API は持たない。
- **固定**：金額と解放日を決めて `merchant_available` から `merchant_reserved` に移す。解放日に戻す。
- **ローリング**：決済の純額の N% を、利用可能になる時点で保留し、決済から M 日後に解放する。利用可能への一括の仕訳（5 節）の中で、保留の行も同時に作る。
- 返金・Dispute が起きた決済にリザーブが残っていれば、それを先に解放して充てる（本家に寄せる）。
- リザーブの解放の予定は `reserve_holds (account_id, reserve_id, currency, amount, release_on, source_entry_id, released_entry_id)`（`reserve_id` は [merchant-onboarding.md](merchant-onboarding.md) の `account_reserves`） に持ち、日次のジョブで解放の仕訳を作る。

### 4.5 マイナス残高

- `merchant_available` はマイナスを許す。Dispute の引き落としは、残高が足りなくても実行する（本家と同じ）。返金は残高を確かめ、足りなければカードは保留・他は失敗にする（[payments.md](payments.md) の 10.2 節）。
- マイナスの間は、自動入金を作らない。以後に利用可能になった売上で自然に相殺される。
- 一定の期間（既定 14 日、設定値）を過ぎてもマイナスなら、回収に回す。本家は加盟店の銀行口座から引き落とすが（[Payouts](https://docs.stripe.com/payouts)）、日本で加盟店の口座から引き落とすには口座振替の契約が要る。口座振替の手段と契約は、E4 の提携銀行の選定と合わせて決める（持ち越し）。MVP は、加盟店ごとの振込専用口座への振込を依頼し、入金を照合して `merchant_available` に計上する。回収できなければ承認を経て `loss_write_off` に償却する。

## 5. 保留中から利用可能へ

### 5.1 `available_on` の決め方

- 決済の確定の仕訳を書くときに、BalanceTransaction の `available_on` を決めて固定する。
  - `available_on` = 確定した日（JST）＋加盟店の売上処理のタイミング。既定は本家の日本に揃え、初回の入金までは 7 暦日、以後は 4 営業日（[Payouts](https://docs.stripe.com/payouts)）。
  - 営業日は、日本の銀行の休業日（土日、祝日、12/31〜1/3）を除いた日。休業日の表は `business_calendars (country, date, is_business_day)` に持ち、年に 1 回 Ops が更新する。
  - 時刻は JST 0:00 に揃え、API では Unix 時刻で返す。
- 返金、Dispute、入金、入金の失敗などの引き落とし・戻しは、作成の時点で利用可能（`available_on` = 作成時刻）。
- 決済代行の精算のサイクルが `available_on` より遅い場合（例：月末締め翌月末払いの決済代行）、自社が立て替えることになる。立て替えの上限と、決済代行ごとの既定のタイミングは、コネクタごとの設定にする（[payment-methods.md](payment-methods.md)）。最初に接続する決済代行の精算のサイクルは、接続先の選定（E3）で確かめる（持ち越し）。
- コンビニ払い・銀行振込は、顧客の支払いを確定した日から数える。

### 5.2 一括の移動

- 利用可能への移動は、BalanceTransaction 1 件ごとには仕訳を作らない。**加盟店 × 通貨 × `available_on` の日ごとに 1 つの仕訳** にまとめる（冪等キー `availability:{account_id}:{currency}:{date}`）。
- ジョブは JST 0:00 の直後に動き、その日が `available_on` の BT を加盟店ごとに集めて、次を 1 つのトランザクションで行う。
  1. `merchant_pending` から `merchant_available` への仕訳（ローリングのリザーブがあれば保留の行も）
  2. 対象の BT の `status` を `available` にし、`availability_entry_id` を付ける
  3. `balance.available` の Event を outbox に積む（本家の Event 名に揃える。[events-and-webhooks.md](events-and-webhooks.md)）
- ジョブが遅れても、`available_on` を過ぎた BT は次の実行で拾う。4.2 節の「保留中の期限」の検査で、遅れを検知する。

## 6. BalanceTransaction

BalanceTransaction は、加盟店に見せるための **仕訳の射影** である。正本は仕訳で、BT はそこから作る。

```sql
balance_transactions (id,                    -- txn_...
                      account_id, currency,
                      type,                  -- charge, payment, refund, payment_refund, refund_failure, adjustment, payout, payout_failure, payout_cancel, reserve_hold, reserve_release, <brand>_fee, <brand>_fx_fee
                      reporting_category,
                      amount, fee, net,      -- net = amount - fee
                      fee_details,           -- jsonb：[{type: <brand>_fee, amount, currency, description}]
                      exchange_rate,         -- numeric。換算がなければ NULL
                      source_type, source_id,
                      entry_id,              -- 元の仕訳
                      available_on, status,  -- pending | available
                      availability_entry_id,
                      payout_id,             -- 自動入金に含まれたら設定（payouts-and-reconciliation.md）
                      created_at,
                      PRIMARY KEY (account_id, id))
```

- 仕訳と同じトランザクションで作る。`status`・`availability_entry_id`・`payout_id` 以外の列は変えない。
- `type` は本家の列挙のうち、MVP の機能に当たるものだけを使う（[BalanceTransaction object](https://docs.stripe.com/api/balance_transactions/object)）。カードは `charge`・`refund`、コンビニ払い・銀行振込は `payment`・`payment_refund` に分ける（本家と同じ）。Dispute は `adjustment` にし、`reporting_category` で `dispute` / `dispute_reversal` を区別する。
- `reporting_category` は、仕訳の種類からの固定の対応表で決める（[Reporting categories](https://docs.stripe.com/reports/reporting-categories)）。表は `packages/ledger` に置き、表駆動テストで確かめる。
- `fee_details[].type` は本家の `stripe_fee`・`tax` などに当たる値を使う。本家の名前を含む値は `<brand>_fee`・`<brand>_fx_fee` にする（リポジトリ共通の [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。
- API：`GET /v1/balance_transactions`（`payout`、`type`、`source`、`created`、`currency` で絞り込み）と `GET /v1/balance_transactions/{id}`。`payout` での絞り込みは自動入金だけに効く（本家と同じ。[Payout reconciliation](https://docs.stripe.com/payouts/reconciliation)）。

## 7. 手数料

### 7.1 計算

- 手数料は **料率（basis point）＋固定額**、必要なら最低額を持つ。例：国内カード 3.6%、コンビニ払い 3.6%（最低 120 円）、銀行振込 1.5%、Dispute 1 件 1,500 円、通貨の換算 +2%（[Stripe 料金](https://stripe.com/jp/pricing)）。
- 料金表は `fee_schedules (id, account_id NULL, payment_method_type, card_region, rate_bps, fixed_amount, min_amount, currency, effective_from)` に版として持つ。加盟店ごとの個別の料金は `account_id` を持つ行で上書きする。
- 計算は `packages/money` の関数 `computeFee(amount, schedule)` だけで行う。
  - `rate_part = amount × rate_bps / 10000` を有理数で計算し、通貨の最小単位に **四捨五入（half-up）** で丸める。JPY は円単位、USD はセント単位。
  - `fee = max(rate_part + fixed_amount, min_amount)`。手数料が金額を超えるときは金額で頭打ちにする。
  - 本家の丸めの規則は未確認。E4 の `fee-schedules` の Story で、本家のテスト環境で端数の出る金額を決済し、BT の `fee` を比べて揃える（持ち越し）。
- 適用した料金表の版を仕訳の `metadata` に残す。料金表を変えても、過去の手数料は変わらない。
- 手数料は、決済の確定の仕訳の中で `merchant_pending` から差し引く（2.3 節）。別の BT（`<brand>_fee`）にはしない。月額の料金など、決済に結び付かない手数料だけを `<brand>_fee` の BT にする。

### 7.2 性質

- 任意の金額と料金表で、`fee + net = amount`、`0 ≤ fee ≤ amount`。
- 任意の金額の分割（部分キャプチャ・部分返金）で、按分の合計が元の金額に一致する（[ADR-0001](../decisions/0001-platform-and-stack.md)）。

## 8. 書き込みの集中（ホットな口座）

大口の加盟店は、1 つの `merchant_pending` に毎秒数百件の決済が書き込む。1 行の集計を更新すると、行ロックで直列になる。

| 手段 | 内容 |
| --- | --- |
| スロットで分ける | `slot_count` を 16〜64 に増やし、仕訳の ID のハッシュでスロットを選ぶ。ロックの競合がスロットの数で割られる |
| 移動を一括にする | 利用可能への移動は日に 1 回・1 仕訳（5.2 節）。`merchant_available` への書き込みは決済の件数に比例しない |
| プラットフォームの口座は集計しない | `snapshot_only`（4.1 節） |
| 残高の確認を要する処理を減らす | 残高を確かめるのは入金の作成と返金の作成だけで、そのときだけ全スロットを `FOR UPDATE` で読む（返金は決済の約 5%）。Dispute は確かめない（マイナスを許す） |

- スロットを増やす判断は、口座ごとの「集計の行ロックの待ち時間」のメトリクスで行う。p99 が 20ms を超えた口座を、Ops が増やす（[capacity.md](capacity.md)、[observability.md](observability.md)）。スロットを増やすのは、新しいスロットの行を 0 で足すだけで、止めずにできる。減らすことはしない。
- 選ばなかった手段（非同期の集計、加盟店の口座自体の分割など）は [ADR-0016](../decisions/0016-hot-accounts-and-ledger-sharding.md) にある。

## 9. S2 の分割（シャード）

- 台帳（`journal_entries`、`ledger_postings`、`ledger_balance_slots`、`balance_transactions`）と、それを同じトランザクションで書く状態のテーブル（決済、返金、入金）は、**`account_id` のハッシュで同じシャードに置く**（[architecture/README.md](README.md) の「規模の段階」）。
- 1 つの仕訳は 1 つの加盟店に属するので（3 節）、仕訳は必ず 1 つのシャードで閉じる。分散トランザクションは要らない。
- プラットフォームの口座は **シャードごとに持つ**（例：シャード 3 の `fee_revenue`）。全体の残高は、日次のスナップショットをシャードをまたいで足して求める。全体の釣り合いの検査（4.2 節）も、シャードごとに行ってから合計する。
- 決済代行の精算や銀行の明細は、複数の加盟店（複数のシャード）にまたがる。照合のサービスが行をシャードごとに分け、シャードごとの仕訳にする（[payouts-and-reconciliation.md](payouts-and-reconciliation.md)）。
- シャードの対応表は、仮想のシャード（例：1,024）→ 物理のクラスタの 2 段にし、加盟店の移動は仮想のシャード単位で行う。移動の手順は [infrastructure.md](infrastructure.md) で扱う。
- Connect のように複数の加盟店の間でお金を動かす機能は、仕訳が 2 つのシャードにまたがる。範囲外なので、入れるときに別の ADR で扱う。

## 10. 通貨と換算

- 日本の加盟店の売上処理・入金の通貨は JPY だけにする。本家も日本では JPY の入金だけを受け付ける（[Payouts](https://docs.stripe.com/payouts)）。
- **MVP で受け付ける取引の通貨は JPY だけ**（[payments.md](payments.md)）。両替は起きず、`fx_*` の口座は使わない。以下は S2 で JPY 以外の取引の通貨を足すときの設計である。以下の **未検証** の項目は、E11 の `multi-currency` の Story で確かめる。
- JPY 以外（USD など）の決済は、確定の時点で、JPY に換算して加盟店の残高に計上する。BT の `amount` は換算後の JPY、`exchange_rate` に使ったレートを入れる（本家と同じ。[BalanceTransaction object](https://docs.stripe.com/api/balance_transactions/object)）。
- レートは外部のレートの提供元から取り、`fx_quotes (id, from_currency, to_currency, mid_rate, applied_rate, source, fetched_at)` に保存する。換算の手数料（2%、[Stripe 料金](https://stripe.com/jp/pricing)）はレートに上乗せせず、BT の `fee` に含める（下記）。仕訳は `fx_quote_id` を持つ。
- 通貨をまたぐ仕訳は、`fx_position` で通貨ごとに釣り合わせる。100 USD、レート 150、手数料 3.6% の例：

| 通貨 | 口座 | 金額 |
| --- | --- | --- |
| USD | `connector_receivable` | +10,000（セント） |
| USD | `fx_position:usd` | −10,000 |
| JPY | `fx_position:jpy` | +15,000 |
| JPY | `fx_revenue` | −300（2%） |
| JPY | `fee_revenue` | −540（15,000 × 3.6%） |
| JPY | `merchant_pending` | −14,160 |

- この例の BT は、`amount` 15,000（レート 150 で換算）、`exchange_rate` 150、`fee` 840（処理の手数料 540 と換算の手数料 300）、`net` 14,160 とする。`fee_details` には 2 つを別の行で出す。
  - 2026-09-27 の訂正：以前は換算の手数料をレートに含める想定だった。本家は、決済の換算の手数料を既定で処理の手数料（BT の `fee`）にまとめ、設定で `fee_details` の別の行に分けられる。レートに含めるのは、残高の換算と Adaptive Pricing の場合である（[通貨の換算](https://support.stripe.com/questions/currency-conversion)、[NetSuite の複数通貨](https://docs.stripe.com/use-stripe-apps/netsuite/multiple-currencies)、2026-09-27 に確認）。根拠が連携の文書で間接的なので、E11 の `multi-currency` で本家のテスト環境の BT を見て確かめる。
- 決済代行が JPY で精算すれば、その時点の USD の未収金と JPY の着金の差は `fx_gain_loss` に計上する。USD のまま精算されるなら、自社の両替の時点で同じく計上する。**未検証**：最初の決済代行の精算の通貨。
- 返金の換算は、返金の時点のレートを使う（本家と同じ。返金の換算に換算の手数料はかからず、元の決済の換算の手数料は返らない。Adaptive Pricing は元のレート。[価格の現地通貨化](https://docs.stripe.com/payments/currencies/localize-prices)、2026-09-27 に確認）。
- 手数料の計算の基準（換算前の外貨か、換算後の JPY か）も **未検証**。上の例は換算後の JPY を基準にした。

## 11. 関連

- データモデルの索引：[data-model.md](data-model.md)
- 入金と照合：[payouts-and-reconciliation.md](payouts-and-reconciliation.md)
- 決済・返金の状態遷移：[payments.md](payments.md)、Dispute：[disputes.md](disputes.md)

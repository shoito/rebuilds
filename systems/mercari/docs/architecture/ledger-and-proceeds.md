# Ledger and Proceeds: Mercari

お金の正本を決める。勘定科目と口座、仕訳の型の一覧、手数料と送料の計算と端数、預かり・release・refund・settle、売上金のロットと期限（法務の確認待ち L1）、本人確認で期限のない残高への移し替え、明細、手数料の請求書（法務の確認待ち L8）、3 段の照合と仮勘定、熱い口座を扱う。

前提となる決定は次のとおり。

- お金の正本は、取引ごとの預かりの口座を持つ追記だけの複式簿記の台帳。release と refund は `(source_type, source_id, event)` の冪等キーと `escrow_settlements` の一意の制約で 1 回に限る（[ADR-0003](../decisions/0003-escrow-and-double-entry-ledger.md)）
- 売上金・残高・ポイントは別の口座の種類で、期限・使い道・本人確認の要否・保全は `legal.*` の値。法務の L1 の結論まで本番の値を有効にしない（[ADR-0004](../decisions/0004-proceeds-model-under-payment-services-act.md)）
- ledger は core と別の Aurora クラスタで、`ledger` のサービスだけが書く（[ADR-0001](../decisions/0001-platform-and-stack.md)）
- 支払い・返金・チャージバックの流れは [payments-and-escrow.md](payments-and-escrow.md)、振込とポイントは [payouts-and-points.md](payouts-and-points.md)、運用の介入と保留は [disputes-and-customer-support.md](disputes-and-customer-support.md)
- Stripe の題材の台帳（[ledger.md](../../../stripe/docs/architecture/ledger.md)、[payouts-and-reconciliation.md](../../../stripe/docs/architecture/payouts-and-reconciliation.md)）の考え方を参照し、C2C の預かりと売上金に合わせて自前で書く。Stripe の題材のコードは使わない

この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0034](../decisions/0034-chart-of-accounts-journal-types-and-fee-rounding.md) | 勘定科目を 22 の口座の種類に確定し、仕訳の型を 30（表の 28 行）に固定する。手数料は `floor(価格 × 率の基点 / 10,000)`、率と送料はバージョンの付いた表で取引の作成の時に固定する。売上金が負になる送料の組み合わせは出品と発送の時に止める |
| [0035](../decisions/0035-proceeds-lots-expiry-and-kyc-conversion.md) | 売上金を入った単位のロットで持ち、使うときは期限の近い順に消す。期限・期限の後の扱い・本人確認での残高への移し替えは `legal.*` の値で動かし、有効にした日より前に遡って期限を付けない。本番の既定はすべて無効 |
| [0036](../decisions/0036-three-tier-reconciliation-and-suspense.md) | 照合を 3 段にする。取引と台帳（5 分ごと）、台帳の内部（仕訳ごとと夜間）、台帳と提供者・銀行・運送会社（日次）。相手のわかるお金は既知の口座に、わからないお金はすぐ仮勘定に置き、3 営業日で人が決める。解消の仕訳は 2 人の承認 |

## 1. 範囲

- 扱う：
  - 口座の種類と持ち主、正常な側、残高の制約
  - 仕訳の形、冪等キー、釣り合いの制約、追記だけの規則
  - 仕訳の型の一覧と、取引・支払い・振込・ポイント・運用の事象との対応
  - 手数料（販売、支払い、振込）と送料の表、端数
  - 売上金のロット、期限、期限の後の扱い、残高への移し替え（法務の確認待ち L1）
  - 売上金の残高と明細の API
  - 手数料の請求書の枠（法務の確認待ち L8）
  - 3 段の照合、仮勘定、解消の手順
  - 熱い口座、S2・S3 の分け方
  - 利用者の資金の日次の集計（保全の枠。法務の確認待ち L1）
- 扱わない：
  - 提供者の結果の確かめ（[payments-and-escrow.md](payments-and-escrow.md)）
  - 振込の実行と銀行（[payouts-and-points.md](payouts-and-points.md)）
  - 会計の仕組み（総勘定元帳への出力の形）は財務と決める。この文書は口座の種類と仕訳の型までを決める

## 2. 要件

| 要件 | 目標 | NFR |
| --- | --- | --- |
| 釣り合い | 釣り合わない仕訳 0。全口座の残高の和 0 | NFR-004、K2 |
| 一回性 | 1 取引で release・refund・settle は合わせて 1 回。重複 0、両方 0。完了・取り消しから 15 分を超えた欠け 0 | NFR-005、K3 |
| 売上金の速さ | 取引の完了から売上金の残高に出るまで p99 1 分。残高と明細の API 月間 99.95% | NFR-006 |
| 外部との一致 | 台帳と提供者・銀行・運送会社の説明のつかない差を 3 営業日で 0 円 | NFR-004 |
| 金額 | 整数の円。手数料の計算は 1 か所。手数料と送料は取引の作成の時の表のバージョン | AGENTS.md |
| 法的な値 | 無効の `legal.*` の仕訳の型を一度も書かない | ADR-0004 |
| 耐久性 | 確認の画面を出した仕訳の消失 0 | NFR-011 |

## 3. 本家の形（確かめたこと）

- 売上金には 180 日の振込の申請の期限がある。「アプリでかんたん本人確認」を済ませると「残高」の表記になり、期限がなくなる。振込の申請の手数料は 200 円。期限を過ぎると登録した口座へ自動で振り込む（1 回 200 円、2 回まで）。口座がないか 200 円以下なら失効する（[ヘルプの記事 96](https://help.jp.mercari.com/guide/articles/96/)、2026-10-10 に確認）。
- 販売の手数料（10%）、手数料の端数、売上金の管理の主体と法的な整理は、公式の資料で確かめられなかった（**未検証**）。

## 4. 勘定科目（[ADR-0034](../decisions/0034-chart-of-accounts-journal-types-and-fee-rounding.md)）

### 4.1 口座の種類

金額は整数の円。仕訳の行は借方を正、貸方を負で持つ。残高の行（`account_balances`）は「正常な側」の向きで正の数に直して持つ（借方が正常な口座は Σ、貸方が正常な口座は −Σ）。

| 口座の種類 | 持ち主 | 正常な側 | 残高の制約 | 意味 | 出典 |
| --- | --- | --- | --- | --- | --- |
| `psp_receivable` | 提供者（S2 からスロット） | 借方 | — | 提供者から入る予定のお金 | ADR-0003 |
| `psp_clearing` | 提供者 | 借方 | — | 精算の入金と銀行の明細の突き合わせ | ADR-0003 |
| `psp_chargeback_held` | 提供者 | 借方 | ≥ 0 | チャージバックで提供者が引き落とした額 | ADR-0032 |
| `escrow` | 取引 | 貸方 | ≥ 0、決着で 0 | 取引の預かり（買い手が払った額） | ADR-0003 |
| `seller_proceeds` | 利用者 | 貸方 | ≥ 0 | 売上金（`proceeds` の種類。ロットで持つ） | ADR-0003、ADR-0004 |
| `seller_proceeds_held` | 利用者 | 貸方 | ≥ 0 | 運用・チャージバックで保留した売上金 | ADR-0060 |
| `user_balance` | 利用者 | 貸方 | ≥ 0、≤ `legal.balance_max_yen` | 期限のない残高（`balance` の種類） | ADR-0004 |
| `balance_reserved` | 利用者 | 貸方 | ≥ 0 | 購入のために引き当てた売上金・残高・ポイント | ADR-0003 |
| `points` | 利用者 × ロット | 貸方 | ≥ 0 | ポイント | ADR-0003、ADR-0039 |
| `fee_revenue` | 本システム × 手数料の種類（`sales`・`payment`・`payout`）（S2 からスロット） | 貸方 | — | 手数料の収益 | ADR-0003 |
| `shipping_payable` | 運送会社 | 貸方 | — | 運送会社に払う送料 | ADR-0003 |
| `payout_in_transit` | 利用者 | 貸方 | ≥ 0 | 振込の依頼の後、銀行の確かめの前 | ADR-0003 |
| `bank_operating` | 本システムの銀行口座 | 借方 | — | 銀行の明細と突き合わせる | ADR-0003 |
| `unapplied_payments` | 提供者 | 貸方 | ≥ 0 | 相手のわかる、取引に当てられない入金（期限の後の入金） | 新規 |
| `chargeback_receivable` | 利用者 | 借方 | ≥ 0 | チャージバックで売り手から回収する額 | ADR-0003 |
| `promotion_expense` | 本システム | 借方 | — | ポイントの付与（キャンペーン） | ADR-0003 |
| `compensation_expense` | 本システム | 借方 | — | 補償 | ADR-0003 |
| `chargeback_loss_expense` | 本システム | 借方 | — | 本システムが負担したチャージバック | 新規 |
| `psp_fee_expense` | 本システム | 借方 | — | 提供者の手数料 | 新規 |
| `points_breakage` | 本システム | 貸方 | — | 期限で失効したポイント（`legal.points_expiry_enabled` の後だけ） | 新規 |
| `proceeds_forfeiture` | 本システム | 貸方 | — | 期限で失効した売上金（`legal.proceeds_forfeit_enabled` の後だけ） | 新規 |
| `suspense` | 本システム × 理由 | どちらも | — | 説明のつかない差 | ADR-0003 |

- 「新規」の口座は、ADR-0003 の表にない口座の種類で、この領域の ADR で足した。ADR-0003 の口座の意味は変えていない。
- 口座は `(kind, owner_type, owner_id, sub_key)` で一意。`escrow` は取引の作成でなく、最初の hold の仕訳で作る。決着した `escrow` は夜間に閉じた印を付け、残高の行を消す（仕訳は残す）。

### 4.2 仕訳の形

```sql
CREATE TABLE journals (
  id uuid PRIMARY KEY,                 -- UUIDv7
  type text NOT NULL,                  -- 4.3
  source_type text NOT NULL, source_id uuid NOT NULL, event text NOT NULL,
  effective_at timestamptz NOT NULL,
  fee_table_version int, shipping_rate_table_version int, legal_config_version int,
  approved_by uuid[],                  -- manual / ops journals only
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_type, source_id, event)
);
CREATE TABLE journal_lines (
  journal_id uuid NOT NULL REFERENCES journals, line_no smallint NOT NULL,
  account_id bigint NOT NULL, amount bigint NOT NULL CHECK (amount <> 0),
  PRIMARY KEY (journal_id, line_no)
) PARTITION BY RANGE (journal_id);     -- monthly by UUIDv7 time
-- deferred constraint trigger: SUM(amount) per journal_id = 0 at commit
-- REVOKE UPDATE, DELETE ON journals, journal_lines FROM ledger_app;
```

- 1 つの仕訳は 1 つの ledger のトランザクションで、`journals`・`journal_lines`・`account_balances`（`UPDATE ... SET balance = balance + $d WHERE ... AND balance + $d >= 0` のような制約つき）・必要なら `escrow_settlements`・ロットの消費・outbox を書く。
- 冪等キーの違反は「すでに書いた」として、前の仕訳を返す（成功）。

### 4.3 仕訳の型

| # | 型 | 冪等キー `(source_type, source_id, event)` | 借方 | 貸方 | 使う所 |
| --- | --- | --- | --- | --- | --- |
| 1 | `hold_psp` | `(transaction, id, hold)` | `psp_receivable` 支払った額 | `escrow` 同額 | カード・コンビニ払いの確定 |
| 2 | `hold_balance` | `(transaction, id, hold_balance)` | `balance_reserved` 引き当て額 | `escrow` 同額 | 売上金・ポイントでの購入 |
| 3 | `release` | `(transaction, id, release)` | `escrow` 全額 | `seller_proceeds` 純額、`fee_revenue:sales` 販売の手数料、`fee_revenue:payment` 支払いの手数料、`shipping_payable` 送料 | 完了 |
| 4 | `refund` | `(transaction, id, refund)` | `escrow` 全額 | 払った手段へ（`psp_receivable`、`balance_reserved` の元の口座、チャージバックなら `psp_chargeback_held`） | 支払いの後の取り消し |
| 5 | `settle` | `(transaction, id, settle)` | `escrow` 全額 | 買い手へ `refund_amount`、残りの代金（価格 − 返金の額）に 5.1 節の式を当てて売り手・手数料・送料へ | 一部の返金の完了 |
| 6 | `reserve` | `(purchase_attempt, id, reserve)` | 元の口座（`points` のロット、`seller_proceeds`、`user_balance`） | `balance_reserved` | 購入の前の引き当て |
| 7 | `reserve_release` | `(purchase_attempt, id, reserve_release)` | `balance_reserved` | 元の口座 | 購入の失敗、15 分の孤立 |
| 8 | `chargeback_open` | `(chargeback, id, open)` | `psp_chargeback_held` | `psp_receivable` | チャージバック |
| 9 | `chargeback_won` | `(chargeback, id, won)` | `psp_receivable` | `psp_chargeback_held` | 同 |
| 10 | `chargeback_lost_seller` | `(chargeback, id, lost)` | `chargeback_receivable:<seller>` | `psp_chargeback_held` | 同（完了の後） |
| 11 | `chargeback_lost_platform` | `(chargeback, id, lost)` | `chargeback_loss_expense` | `psp_chargeback_held` | 同 |
| 12 | `receivable_offset` | `(journal, <release_id>, offset)` | `seller_proceeds` | `chargeback_receivable` | release の直後の回収 |
| 13 | `proceeds_hold` | `(hold, id, apply)` | `seller_proceeds` | `seller_proceeds_held` | 運用・チャージバックの保留 |
| 14 | `proceeds_unhold` | `(hold, id, release)` | `seller_proceeds_held` | `seller_proceeds` | 保留の解除 |
| 15 | `held_recovery` | `(chargeback, id, recover)` | `seller_proceeds_held` | `chargeback_receivable` | 保留からの回収 |
| 16 | `compensation` | `(compensation, case_id, grant)` | `compensation_expense` | `points:<lot>` か `seller_proceeds` | 運用の補償 |
| 17 | `points_grant` | `(campaign_grant, id, grant)` | `promotion_expense` | `points:<lot>` | キャンペーン |
| 18 | `points_expire` | `(points_lot, id, expire)` | `points:<lot>` | `points_breakage` | 期限（`legal.points_expiry_enabled`） |
| 19 | `proceeds_to_balance` | `(proceeds_lot, id, to_balance)` | `seller_proceeds` | `user_balance` | 本人確認（`legal.balance_enabled`） |
| 20 | `proceeds_forfeit` | `(proceeds_lot, id, forfeit)` | `seller_proceeds` | `proceeds_forfeiture` | 期限（`legal.proceeds_forfeit_enabled`） |
| 21 | `payout_request` | `(payout, id, request)` | `seller_proceeds` か `user_balance` 申請の額 | `payout_in_transit` 振り込む額、`fee_revenue:payout` 振込の手数料 | 振込の申請・期限の後の自動の振込 |
| 22 | `payout_settled` | `(payout, id, settled)` | `payout_in_transit` | `bank_operating` | 銀行の確かめ |
| 23 | `payout_failed` | `(payout, id, failed)` | `payout_in_transit`、`fee_revenue:payout` | 元の口座（申請の額） | 依頼の時点の不能（手数料も戻す） |
| 24 | `payout_returned` | `(payout, id, returned)` | `bank_operating` | 元の口座（振り込んだ額） | 完了の後の組戻し・資金返却 |
| 25 | `psp_settlement` | `(psp_settlement, batch_id, line_no)` | `bank_operating` 純額、`psp_fee_expense` 手数料 | `psp_receivable` 総額 | 提供者の精算 |
| 26 | `carrier_payment` | `(carrier_invoice, id, pay)` | `shipping_payable` | `bank_operating` | 運送会社への支払い |
| 27 | `unapplied_receipt`・`unapplied_refund` | `(payment_attempt, id, unapplied)`・`(…, orphan_refund)` | `psp_receivable`・`unapplied_payments` | `unapplied_payments`・`psp_receivable` | 期限の後の入金と返金 |
| 28 | `suspense_open`・`suspense_resolve` | `(recon_break, id, open)`・`(…, resolve)` | 相手の口座・`suspense` | `suspense`・正しい口座 | 3 者の照合 |

- 組み合わせの支払い（ポイント・売上金 ＋ カード）では、1 つの取引に hold が 2 つ書かれる。[ADR-0003](../decisions/0003-escrow-and-double-entry-ledger.md) の表は両方の冪等キーを `(transaction, <id>, hold)` としたが、同じキーでは 2 つ目が書けないので、残高の分を `hold_balance` に分けた（[ADR-0040](../decisions/0040-balance-spend-order-and-reservation.md)）。
- refund の残高の分は `balance_reserved` に戻し、同じ ledger のトランザクションで `reserve_release`（型 7）を書いて、引き当ての記録の通りに元の口座（ポイントのロット、売上金のロット）へ戻す。
- 仕訳の型は固定のコード（`packages/ledger`）で、`release.*` のフラグで切り替えない。`legal.*` で無効の型（18・19・20、期限の後の 21）は、書く関数の入口で `legal.*` の値を確かめ、無効なら書かない（ADR-0004）。
- 30 の型（表の 28 行。27・28 は各 2 つ）と行の向きは、`ledger-core` の spec の正本にする。型を足すには、この表と ADR の更新が要る（[roadmap.md](../roadmap.md) の「エージェントに任せないこと」）。

## 5. 取引のお金

### 5.1 手数料と送料（`packages/fees`）

```
sales_fee     = floor(price × sales_fee_bp / 10,000)          -- bp from fee table version, per category
payment_fee   = fee_table.payment_fee_yen[payment_method]      -- konbini 100, others 0
shipping_fee  = shipping_rate_table[method_code].price_yen     -- 0 if buyer pays carrier directly
seller_net    = price − sales_fee − shipping_fee               -- must be >= 0
escrow_amount = price + payment_fee
```

- 率は基点（1 bp = 0.01%）の整数。既定 1,000 bp（10%。本家の値は**未検証**）。表はカテゴリごとの行を持ち、バージョン（`fee_table_version`）で固定する。取引の作成の時のバージョンを取引の行に記録し、完了の時もそれを使う。
- 端数は 1 円未満の切り捨て（売り手に有利）。例：価格 333 円 → 33.3 → 33 円。価格 9,999,999 円 → 999,999 円。
- 売上金が負になる組み合わせは作らない。出品の時に `price − sales_fee − shipping_fee ≥ 0` を確かめる（例：価格 300 円で宅急便の 160 サイズ相当の送料は選べない）。発送の時のサイズの変更でも同じく確かめ、負になる変更は止める（[shipping-integrations.md](shipping-integrations.md) の 5.3 節）。
- 着払い（匿名でない配送で、買い手が運送会社に直接払う）は送料 0 で、台帳に載らない。
- 消費税の扱い（手数料の内税か外税か、税率、端数、適格請求書の記載）は **法務の確認待ち（L8）**。表は税率の列を持ち、値は確認の後に入れる。

### 5.2 例：3,000 円の売買（販売の手数料 10%、送料を差し引く）

前提：価格 3,000 円、カード、売り手の負担の `<Brand>便`（運送会社 A の小さいサイズ、送料 210 円。料金は [shipping-integrations.md](shipping-integrations.md) の 5.1 節の表）。提供者の手数料は例として 3.6%（本システムの仮の値。選定で決まる）。売り手は売上金の全額を振り込む。

| # | 事象 | 仕訳の型 | 借方 | 貸方 |
| --- | --- | --- | --- | --- |
| 1 | カードの確定（`transaction.paid`） | `hold_psp` | `psp_receivable` 3,000 | `escrow:T1` 3,000 |
| 2 | 完了（`transaction.completed`） | `release` | `escrow:T1` 3,000 | `seller_proceeds:S` 2,490、`fee_revenue:sales` 300、`shipping_payable:A` 210 |
| 3 | 提供者の精算 | `psp_settlement` | `bank_operating` 2,892、`psp_fee_expense` 108 | `psp_receivable` 3,000 |
| 4 | 運送会社 A への月の支払い（の 1 行分） | `carrier_payment` | `shipping_payable:A` 210 | `bank_operating` 210 |
| 5 | 振込の申請 2,490 円 | `payout_request` | `seller_proceeds:S` 2,490 | `payout_in_transit:S` 2,290、`fee_revenue:payout` 200 |
| 6 | 銀行の完了の確かめ | `payout_settled` | `payout_in_transit:S` 2,290 | `bank_operating` 2,290 |

符号つきの和（借方 +、貸方 −）で、最後の残高を確かめる。

| 口座 | 1 | 2 | 3 | 4 | 5 | 6 | 最後 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `psp_receivable` | +3,000 | | −3,000 | | | | 0 |
| `escrow:T1` | −3,000 | +3,000 | | | | | 0（決着） |
| `seller_proceeds:S` | | −2,490 | | | +2,490 | | 0 |
| `fee_revenue:sales` | | −300 | | | | | −300 |
| `fee_revenue:payout` | | | | | −200 | | −200 |
| `shipping_payable:A` | | −210 | | +210 | | | 0 |
| `bank_operating` | | | +2,892 | −210 | | −2,290 | +392 |
| `psp_fee_expense` | | | +108 | | | | +108 |
| `payout_in_transit:S` | | | | | −2,290 | +2,290 | 0 |
| 和 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

- 本システムの手元に残るのは 392 円（手数料 500 円 − 提供者の手数料 108 円）。全口座の和は 0。
- 行 2 で売上金は 2,490 円になり、売り手の残高と明細に出る（NFR-006）。

### 5.3 release の直後の回収

- 売り手に `chargeback_receivable` の残りがあれば、release と同じ ledger のトランザクションで `receivable_offset`（型 12）を書き、売上金から先に回収する。release の仕訳そのものは変えない（型を固定するため）。

### 5.4 決着の排他

- release（3）・refund（4）・settle（5）は、`escrow_settlements (transaction_id PRIMARY KEY, kind, journal_id)` に 1 行を同じトランザクションで挿入する。2 つ目は一意の違反になり、種類が同じなら成功、違うなら page（[ADR-0003](../decisions/0003-escrow-and-double-entry-ledger.md)）。
- 決着の後に `escrow` の残高が 0 でなければ、トランザクションの終わりの検査で失敗させる。
- 期限の後の入金（型 27）は取引の預かりに入れない。`unapplied_payments` に置き、返金で消す。取引の決着とは別の冪等キーである。

## 6. 売上金のロットと期限（[ADR-0035](../decisions/0035-proceeds-lots-expiry-and-kyc-conversion.md)）

### 6.1 ロット

- `seller_proceeds` への入り（release、補償、振込の失敗の戻し、保留の解除）は、ロット（`proceeds_lots`：額、残り、入った時刻、期限）を作るか、元のロットへ戻す。
- 出（購入の引き当て、振込の申請、保留、移し替え、失効）は、ロットを「期限の近い順（期限なしは最後）→ 入った順」で消す。消した記録を `proceeds_lot_consumptions (journal_id, lot_id, amount)` に持つ。
- 出を戻す仕訳（`reserve_release`、`payout_failed`、`proceeds_unhold`）は、消した記録の通りに元のロットへ戻す。戻したロットの期限は変えない。
- 不変条件：利用者ごとに `Σ lot.remaining = seller_proceeds` の残高（照合の第 2 段）。

### 6.2 `legal.*` の値

| 値 | 意味 | 開発・検証 | 本番の既定 |
| --- | --- | --- | --- |
| `legal.proceeds_expiry_enabled` | ロットに期限を付ける | true | **false** |
| `legal.proceeds_expiry_days` | 期限の日数 | 180（本家に寄せる） | —（無効） |
| `legal.proceeds_expiry_actions` | 期限の後の扱いの順 | `[auto_payout, auto_payout, forfeit]` | — |
| `legal.proceeds_forfeit_enabled` | 失効の仕訳を書く | true | **false** |
| `legal.proceeds_spendable` | 売上金で購入できる | true | **false**（L1 の後） |
| `legal.balance_enabled` | 残高（`user_balance`）を使う | true | **false** |
| `legal.balance_requires_kyc_level` | 残高に移す本人確認の水準 | `ekyc_verified` | — |
| `legal.balance_max_yen` | 残高の上限 | 1,000,000（仮） | — |
| `legal.proceeds_expiry_notice_days` | 期限の前の通知 | `[30, 7, 1]` | —（文言は L1 の後） |

- 本番の値の変更は、法務と財務の承認の記録を付けて Ops が平日の昼に適用する（[runbooks/](../runbooks/README.md) の 3 節）。値のバージョン（`legal_config_version`）を、期限・移し替え・失効の仕訳に記録する。
- 期限を有効にした日より前に入ったロットにも期限を付けるときは、期限を「入った日 ＋ 日数」でなく「有効にした日 ＋ 日数」から数える（遡らない）。遡ってよいかは **法務の確認待ち（L1）** で、本システムの既定は遡らない。

### 6.3 期限の処理

`proceeds-expiry-runner`（毎日 00:10 日本時間、`legal.proceeds_expiry_enabled` のときだけ）：

1. `expires_at < now()` かつ `remaining > 0` のロットを利用者ごとにまとめる。
2. 利用者の「期限の後の扱いの回数」（`expiry_action_count`）で、`legal.proceeds_expiry_actions` の次の扱いを選ぶ。
3. `auto_payout`：登録した口座があり、額が振込の手数料（200 円）を超えるなら、振込の申請（型 21、理由 `expiry_auto_payout`）を作る。口座がない・額が 200 円以下なら、次の扱いへ進む。
4. `forfeit`：`legal.proceeds_forfeit_enabled` なら型 20 で失効させる。無効なら、ロットを `expiry_exhausted` にし、CS の待ち行列へ出す（何もしない）。
5. 期限の 30・7・1 日前に通知する（通知の文言と時刻は法務の確認待ち L1。[quality.md](../quality.md) の 2.2.1 節 J）。

### 6.4 例：180 日の期限と本人確認（開発・検証の値）

| 日付 | 事象 | ロット A | ロット B | 売上金 |
| --- | --- | --- | --- | --- |
| 2026-04-01 | 完了（release 2,490 円） | 2,490（期限 09-28 23:59:59） | — | 2,490 |
| 2026-05-10 | 売上金で 1,200 円の購入 | 1,290 | — | 1,290 |
| 2026-06-15 | 完了（release 1,000 円） | 1,290 | 1,000（期限 12-12） | 2,290 |
| 08-29・09-21・09-27 | ロット A の期限の 30・7・1 日前の通知 | | | |
| 2026-09-29 00:10 | 期限の処理：扱い 1 = `auto_payout`。1,290 円 − 200 円 = 1,090 円を振り込む | 0 | 1,000 | 1,000 |
| 2026-09-30 | 銀行が不能（口座の解約）→ `payout_failed`。ロット A に 1,290 円が戻る（期限は 09-28 のまま） | 1,290 | 1,000 | 2,290 |
| 2026-10-01 00:10 | 扱い 2 = `auto_payout`。口座が使えない状態なので、次の扱いへ | | | |
| 同 | 扱い 3 = `forfeit`。`legal.proceeds_forfeit_enabled = true` なら型 20 で 1,290 円を失効 | 0 | 1,000 | 1,000 |

- 180 日の数え方：2026-04-01 ＋ 180 日 = 2026-09-28。期限の時刻はその日の 23:59:59（日本時間）。
- **本人確認の場合**：利用者が 2026-07-01 に `ekyc_verified` になり、`legal.balance_enabled = true` なら、その時にロット A（1,290）と B（1,000）を型 19 で `user_balance` 2,290 円に移す。以後の release も、release の直後に同じ型で移す。`user_balance` にロットと期限はない。`legal.balance_max_yen` を超える分は、ロットのまま（期限つき）残す。
- **本番の既定**：期限・失効・移し替えはすべて無効。ロットは `expires_at = NULL` で作られ、期限の処理は動かない（ADR-0004）。

## 7. 残高と明細

- API：`GET /me/proceeds`（売上金、保留中、残高、ポイント、反映中の取引の数）、`GET /me/proceeds/statement?cursor=`（仕訳の行を本人の口座で絞り、型・取引・額・時刻を返す）。`ledger` の API が `actor_id` と口座の持ち主を照らし、ledger の DB にも口座の持ち主の RLS を置く（[ADR-0007](../decisions/0007-single-tenant-and-party-visibility.md)）。
- 取引の完了から release までの間（数秒〜1 分）は「反映中」と出す。core の `completed` と ledger の release の有無で決める。
- 明細の行には、出品の題名の写し（取引の作成の時）と取引の ID を出す。相手の名前・住所は出さない。
- 読み出しの速さ：残高は `account_balances` の 1 行（スロットに分けた口座は持ち主が本システムなので、利用者の API には出ない）。p99 50ms。

## 8. 手数料の請求書と、利用者の資金の集計

- **請求書（法務の確認待ち L8）**：月ごとに売り手ごとの手数料（販売、振込）の明細を作る。適格請求書（または適格簡易請求書）に当たる形、記載の事項、税率と端数は確認の後に決める。データは `fee_revenue` の仕訳の行と、手数料の表のバージョンの税率の列から作れる形にしておく。E9 の `fee-invoices` の spec は確認まで承認しない。
- **利用者の資金の日次の集計**：毎日 00:30 に、口座の種類ごと（`seller_proceeds`、`seller_proceeds_held`、`user_balance`、`balance_reserved`、`points`、`escrow`、`payout_in_transit`）の合計を `customer_funds_daily` に書く。保全の方法（供託、保証、信託）と基準日は **法務の確認待ち（L1）**（ADR-0004）。

## 9. 3 段の照合（[ADR-0036](../decisions/0036-three-tier-reconciliation-and-suspense.md)）

### 9.1 段

| 段 | 頻度 | 比べるもの | 外れたとき |
| --- | --- | --- | --- |
| 第 1 段：取引と台帳 | 5 分ごと（大型の企画の日は 1 分） | 下の T1〜T5 | 欠けは事象を出し直す。重複・両方は page |
| 第 2 段：台帳の内部 | 仕訳ごと（制約）と夜間 | 下の I1〜I6 | page（SEV1 の候補）。振込と売上金での購入を止める |
| 第 3 段：台帳と外部 | 日次（取り込みの後） | 下の E1〜E4 | 相手のわかる差は既知の口座、わからない差は `suspense`。3 営業日で人が決める |

**第 1 段（取引と台帳）**

| # | 規則 |
| --- | --- |
| T1 | `paid` 以降の取引（支払いの手段が提供者か残高）に hold がある |
| T2 | `completed` の取引に release か settle が 1 つある |
| T3 | 支払いの後の `cancelled` の取引に refund が 1 つある |
| T4 | release の額の内訳 = 取引の価格・手数料・送料（取引の行の表のバージョンで計算し直す） |
| T5 | 取引に結び付かない `reserve` が 15 分を超えて残っていない（あれば `reserve_release`） |

**第 2 段（台帳の内部）**

| # | 規則 |
| --- | --- |
| I1 | 仕訳ごとの行の和 0（トリガー）。全口座の和 0（夜間） |
| I2 | 残高の行 = 仕訳の行の和 |
| I3 | 決着した `escrow` の残高 0。決着していない `escrow` の取引は core で終わっていない |
| I4 | 利用者ごとに `Σ proceeds_lots.remaining = seller_proceeds` |
| I5 | 開いているチャージバックの額の和 = `psp_chargeback_held` |
| I6 | 無効の `legal.*` の型の仕訳が、その値が無効の間に書かれていない |

**第 3 段（台帳と外部）**

| # | 内部 | 外部 | 突き合わせの鍵 |
| --- | --- | --- | --- |
| E1 | `psp_receivable` の動き（hold・refund・チャージバック） | 提供者の精算の行 | 試行の ID（参照の番号）、返金の ID、チャージバックの ID |
| E2 | `psp_settlement` の純額 | 銀行の入出金明細の入金 | 額、日付、振込の依頼人名（提供者ごとの規則） |
| E3 | `payout_request`・`payout_settled`・`payout_failed`・`payout_returned` | 銀行の結果の照会と明細の出金・入金 | `bank_request_ref`（EDI 情報） |
| E4 | `shipping_payable` の動き | 運送会社の請求の明細 | 配送の受け付けの番号 |

- 取り込み：精算のファイル・銀行の明細・運送会社の請求は、S3 に元を保存し（ハッシュを持ち、同じものの 2 回目は無視）、共通の形の行（`external_statement_lines`）に変える。
- 照合は読み出しの写しで、再実行しても結果が同じになるように作る。

### 9.2 外れの扱い

- 外れは `recon_breaks`（種類、段、規則、相手の参照、額、検知の時刻、営業日の年齢、状態 `open`・`investigating`・`resolved`・`written_off`、担当、解消の仕訳）に記録する。
- お金が実際に動いていて、相手（どの取引・試行か）がわかるときは、その口座へ書く（例：期限の後の入金は `unapplied_payments`）。相手がわからないときは、その時点で `suspense` に置き、`bank_operating`・`psp_receivable` を外部の残高と一致させる。
- 解消の仕訳（`suspense_resolve`）と、利用者の口座を動かす直しは、担当と承認者の 2 人の承認（`journals.approved_by`）を要する（[runbooks/](../runbooks/README.md) の 4 節）。手で仕訳を書くのは、この型と打ち消しの仕訳だけ。
- 3 営業日を超えた外れ、`suspense` の残高が 0 でない状態が 5 営業日続くことをチケットにする（`three-way-reconciliation.md`）。

### 9.3 例：提供者の精算に台帳にない確定がある

| 段 | 起きること |
| --- | --- |
| 10/14 12:00 | カードの購入の試行 Y。提供者が時間切れを返し、照会は 10 分を超えても「見つからない」→ DT-PAY-001 の行 10 で `failed`。取引は `cancelled`、出品は販売中に戻り、別の買い手が買った |
| 10/15 06:00 | 提供者の 10/14 の精算のファイルに、試行 Y の確定 3,000 円の行がある（提供者の側で遅れて確定していた） |
| 10/15 06:10 | 第 3 段の E1 が外れを見つける。参照の番号が試行 Y と一致し、相手がわかる。`unapplied_receipt`：`psp_receivable` 3,000 / `unapplied_payments` 3,000。外れの種類 `late_capture` |
| 10/15 06:11 | `payments` が全額の返金を依頼（冪等キー `<attempt_Y>:orphan_refund`）。返金の確定で `unapplied_refund`：`unapplied_payments` 3,000 / `psp_receivable` 3,000 |
| 10/16 06:10 | 提供者の精算に返金の行 −3,000 円。E1 が一致を確かめ、外れを `resolved` にする |

- 参照の番号が本システムのどの試行にも当たらなければ、`suspense:psp_unidentified` に置き、財務と提供者に確かめる。
- この場面の頻度は、DT-PAY-001 の行 10 の 10 分を見直す材料にする（E8 の `psp-sim` と提供者の契約の試験）。

## 10. 熱い口座と分け方

- S1：すべての口座が 1 行。大型の企画の日の 50 件/秒の購入で、`psp_receivable` と `fee_revenue:sales` の残高の行に毎秒 50〜100 回の更新が集まる。1 回の行のロックを 2ms とすると使用の割合は 20% で足りる（本システムの見込み。`ledger-core` の負荷試験で測る）。
- S2（300 件/秒）：本システムが持ち主の熱い口座（`psp_receivable`、`fee_revenue:*`、`shipping_payable`）を 16 のスロットに分ける。スロットは `hash(journal_id) mod 16`。スロットの口座には残高の行を持たず、残高は仕訳の行の和を 1 分ごとに集計する（Stripe の題材の [ADR-0016](../../../stripe/docs/decisions/0016-hot-accounts-and-ledger-sharding.md) の考え方）。
- S3：ledger を口座の持ち主のハッシュで分ける。1 つの仕訳が持ち主の違う口座（売り手の売上金と、取引の預かり）にまたがるので、預かりの口座の持ち主を売り手にし、release を同じ分け先に置く。分け方は infrastructure の領域で ADR にする。

## 11. 障害のときの振る舞い

| 障害 | 影響 | 振る舞い |
| --- | --- | --- |
| ledger の消費者の停止 | hold・release・refund が遅れる | core の outbox に溜まる。再開で冪等に書く。第 1 段が 15 分で欠けを見つけて事象を出し直す。画面は「反映中」 |
| ledger の Aurora の交代 | 書き込みが戻る | 冪等キーで再試行 |
| 残高の制約の違反（売上金が負になる出） | 仕訳が書けない | 呼び出しに 402・409 を返す。照合の I2 で残高の行のずれを確かめる |
| 釣り合いの違反 | 仕訳が書けない | 実装の誤り。page（`ledger-invariant-breach.md`） |
| 提供者の精算のファイルが来ない | 第 3 段が遅れる | 提供者ごとの猶予（既定 2 営業日）を過ぎたらチケット |
| `legal.*` の値の誤り | 無効のはずの型が書かれうる | 書く関数の入口の検査と、I6。CI の設定の検査（ADR-0004） |

## 12. 上限

| 対象 | 値 |
| --- | --- |
| 1 つの仕訳の行 | 20 |
| 金額 | 1 円 〜 99,999,999 円（1 行） |
| 引き当ての孤立の戻し | 15 分 |
| 第 1 段の頻度 | 5 分ごと（大型の企画の日 1 分） |
| 外れの解消 | 3 営業日 |
| 仕訳の保持 | 10 年（会計の保存の期間。法務・財務の確認待ち） |
| 明細の API の 1 回 | 100 行 |
| 熱い口座のスロット（S2） | 16 |

## 13. data-model への項目

| 表・置き場 | 中身 | 主キー・索引 | 節 |
| --- | --- | --- | --- |
| `accounts`（ledger、持ち主の RLS） | 種類、持ち主の種類と ID、副の鍵、閉じた印 | `id`、一意 `(kind, owner_type, owner_id, sub_key)` | 4.1 |
| `account_balances`（ledger） | 正常な側の残高、更新の時刻、CHECK（種類ごとの制約） | `account_id` | 4.1 |
| `journals`（ledger、追記だけ） | 型、冪等キー、表のバージョン、`legal_config_version`、承認者 | `id`、一意 `(source_type, source_id, event)` | 4.2 |
| `journal_lines`（ledger、追記だけ、月ごとに分割） | 口座、額 | `(journal_id, line_no)`、`(account_id, journal_id)` | 4.2 |
| `escrow_settlements`（ledger） | 決着の種類、仕訳 | `transaction_id` | 5.4 |
| `proceeds_lots`（ledger、本人の RLS） | 利用者、額、残り、入った時刻、期限、元の仕訳、状態（`active`・`expiry_exhausted`） | `id`、`(owner_id, expires_at NULLS LAST, created_at)`、部分索引 `(expires_at) WHERE remaining > 0` | 6.1 |
| `proceeds_lot_consumptions`（ledger） | 仕訳、ロット、額 | `(journal_id, lot_id)` | 6.1 |
| `proceeds_expiry_state`（ledger、本人の RLS） | 期限の後の扱いの回数、最後の扱い、通知の済んだ日 | `owner_id` | 6.3 |
| `fee_tables`・`fee_table_rows`（core、設定） | バージョン、カテゴリ、率の基点、支払いの手数料、振込の手数料、税率（L8 の後） | `(version, category_id)` | 5.1 |
| `customer_funds_daily`（ledger） | 日付、口座の種類、合計 | `(date, kind)` | 8 |
| `external_statement_lines`（ledger） | 出所（提供者・銀行・運送会社）、元のファイルの参照、相手の参照、額、日付 | `(source, file_id, line_no)`、`(source, external_ref)` | 9.1 |
| `recon_breaks`（ledger） | 9.2 節の列 | `id`、`(status, detected_at)` | 9.2 |
| `recon_runs`（ledger） | 段、規則、時刻、件数 | `(tier, rule, run_at)` | 9.1 |
| S3 | `ledger/statements/<source>/<yyyy>/<mm>/<dd>/<file>`（元のファイル、ハッシュ） | — | 9.1 |
| outbox の事象 | `ledger.proceeds_available`、`ledger.refund_due`、`ledger.payout_due`、`ledger.proceeds_expiring`、`ledger.recon_break` | — | 5、6、9 |

## 14. テスト

- **PROP-LED-001（釣り合い）**：任意の事象の列（支払い、完了、取り消し、一部の返金、チャージバック、補償、振込、ポイント、期限）を重複（0〜5 回）・遅れ・順序の入れ替えで流し、各仕訳の和 0、全口座の和 0（[quality.md](../quality.md) の 2.2.1 節 B）。
- **PROP-LED-002（一回性）**：1 取引で release・refund・settle は合わせて 1 回。決着した `escrow` は 0。
- **PROP-LED-003（売上金の額）**：`completed` の取引の売上金の増分 = 価格 − 手数料 − 送料（表のバージョン）と 1 円も違わない。
- **PROP-LED-004（負の残高なし）**：4.1 節の制約の口座は負にならない。
- **PROP-LED-005（ロット）**：任意の入と出の列で I4（ロットの和 = 売上金）。出の戻しはロットの期限を変えない。
- **PROP-LED-006（`legal.*`）**：`legal.*` の全組み合わせで PROP-LED-001〜005 が成り立ち、無効の型が書かれない（I6）。
- **PROP-LED-007（参照との一致）**：`ledger-ref`（素直な足し引き）の残高と一致する。
- **表駆動**：4.3 節の仕訳の型の全行（借方・貸方の口座と額）、5.1 節の手数料の表と端数の試験のベクトル、6.3 節の期限の後の扱い。
- **仮想の時計**：6.4 節の例（180 日の数え方、通知の日、振込の失敗の後の再試行、失効）。
- **照合**：9.3 節の場面を `psp-sim` で起こし、第 3 段が `late_capture` を見つけ、返金で解消する。

## 15. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E9 | `ledger-core` | 4 節（ADR-0034。PROP-LED-001・004） |
| E9 | `escrow-hold-release-refund` | 5 節（PROP-LED-002・003） |
| E9 | `fee-and-shipping-tables` | 5.1 節（端数の試験のベクトル） |
| E9 | `proceeds-balance-and-statements` | 7 節 |
| E9 | `proceeds-account-kinds` | 6 節（ADR-0035。PROP-LED-005・006）。期限と失効は法務：L1 |
| E9 | `txn-ledger-reconciler` | 9 節の第 1 段 |
| E9 | `three-way-reconciliation` | 9 節の第 2・3 段（ADR-0036） |
| E9 | `ledger-reference-and-props` | 14 節（`ledger-ref`） |
| E9 | `fee-invoices` | 8 節。法務：L8 |
| E9 | `customer-funds-daily`（新しい Story の提案） | 8 節の集計。保全は法務：L1 |

## 16. 未解決の問い

### 決定

2026-10-10 の既定案。

- **勘定科目と型**：22 の口座の種類、30 の型（ADR-0034）。
- **手数料**：基点の整数、切り捨て、取引の作成の時のバージョン。売上金が負になる送料を止める（ADR-0034）。
- **預かりの額**：買い手が払った額（代金 ＋ 支払いの手数料）（[ADR-0031](../decisions/0031-konbini-pending-payments-and-late-payments.md)）。
- **売上金のロット**：期限の近い順に消す。戻しは元のロットへ（ADR-0035）。
- **期限を有効にした日**：遡らない（法務の確認待ち L1 で覆りうる）（ADR-0035）。
- **照合**：3 段、相手のわかる差は既知の口座、わからない差は仮勘定、3 営業日、2 人の承認（ADR-0036）。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| 売上金の期限・失効・残高・保全の値と、遡りの可否 | 法務の確認待ち（L1） |
| 手数料の消費税と請求書の形、送料の取引の整理 | 法務の確認待ち（L8） |
| 販売の手数料の率（10%）とカテゴリごとの差 | PM・財務。本家の値は**未検証** |
| 提供者の手数料と精算のサイクル | E8 の `payment-provider-selection` |
| 熱い口座の S1 の見込み（行のロック 2ms） | `ledger-core` の負荷試験 |
| ledger の分け方（S3） | infrastructure の領域 |
| 仕訳の保持の期間 | 法務・財務 |

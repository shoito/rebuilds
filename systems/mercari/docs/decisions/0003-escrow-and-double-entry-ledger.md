---
status: accepted
date: 2026-10-10
---

# ADR-0003: お金の正本を、取引ごとの預かりの口座を持つ追記だけの複式簿記の台帳にする。release と refund を冪等キーと一意の制約で 1 回に限り、取引と台帳を 5 分ごと、台帳と提供者・銀行を日次で照合する

## Context

本システムは、買い手の代金を受取評価まで預かり、取引の完了で手数料と送料を引いて売り手の売上金にする。売上金は、次の購入・ポイント・口座への振込に使われる。次を守る（NFR-004、NFR-005、NFR-006）。

- 仕訳は常に釣り合い、全口座の残高の和は 0。
- 1 つの取引の預かりは、売り手への振り替え（release）か買い手への返金（refund）の、どちらか一方に 1 回だけ動く。
- 売上金は完了から 1 分以内に残高に出る。
- 台帳と、決済の提供者の精算・銀行の明細の差を、説明できる。

難しさは次のとおり。

- 取引の状態（core）とお金（ledger）は別の DB にある（[ADR-0001](0001-platform-and-stack.md)）。間は非同期でつながる。
- 1 つの取引に、支払い・返金・チャージバック・運用の補償・送料の差し引きが重なる。
- 売上金・残高・ポイントの法的な扱いは未決である（[ADR-0004](0004-proceeds-model-under-payment-services-act.md)）。
- 大型の企画の日に、手数料の収益の口座と提供者への未収の口座に書き込みが集まる（熱い口座）。

Stripe の題材は、加盟店の台帳を追記だけの複式簿記にし（[Stripe の ADR-0003](../../../stripe/docs/decisions/0003-double-entry-ledger.md)）、保留中と利用可能の口座を分け（[Stripe の ADR-0015](../../../stripe/docs/decisions/0015-chart-of-accounts-and-balance-transactions.md)）、熱い口座を分け（[Stripe の ADR-0016](../../../stripe/docs/decisions/0016-hot-accounts-and-ledger-sharding.md)）、3 者で照合する（[Stripe の ADR-0017](../../../stripe/docs/decisions/0017-three-way-reconciliation-with-suspense.md)）。この題材は考え方を参照し、C2C の預かりに合わせて自前で書く。Stripe の題材のコードは使わない（台帳は題材の核）。

## Options

1. **追記だけの複式簿記。取引ごとの預かりの口座。状態の遷移の outbox から冪等に記帳する**
2. 残高の列を持つ表（売り手の残高を足し引きする）と、明細の表
3. 決済の提供者のマーケットプレイスの機能（分割の支払い、売り手の口座）に預かりと残高を任せる

## Decision

1 を採用する。

### 勘定科目（MVP）

| 口座の種類 | 持ち主 | 意味 |
| --- | --- | --- |
| `psp_receivable` | 提供者ごと | 提供者から入る予定のお金（売上の確定の後、精算の前） |
| `psp_clearing` | 提供者ごと | 精算で銀行に入ったお金との突き合わせ |
| `escrow` | 取引ごと | 取引の預かり。完了で 0 になる |
| `seller_proceeds` | 利用者ごと | 売上金（種類と期限は [ADR-0004](0004-proceeds-model-under-payment-services-act.md)） |
| `balance_reserved` | 利用者ごと | 購入のために引き当てた売上金・残高・ポイント |
| `points` | 利用者ごと・発行のロットごと | 本システムが付けたポイント |
| `fee_revenue` | 本システム（スロットに分ける） | 販売の手数料・振込の手数料の収益 |
| `shipping_payable` | 運送会社ごと | 運送会社に払う送料 |
| `payout_in_transit` | 利用者ごと | 振込の依頼の後、着金の確かめの前 |
| `bank_operating` | 本システムの銀行口座ごと | 銀行の明細と突き合わせる口座 |
| `promotion_expense`、`compensation_expense` | 本システム | ポイントの付与、補償 |
| `suspense` | 本システム | 説明のつかない差。期限で人が確かめる |
| `chargeback_receivable` | 利用者ごと | チャージバックで売り手から回収する額 |

- 金額は整数の円。仕訳の行は `(journal_id, account_id, amount)` で、借方を正、貸方を負で持つ。1 つの仕訳の行の和は 0（DB の遅延の制約のトリガーと、コードの両方で検査する）。
- 仕訳は追記だけ。誤りは打ち消しの仕訳で直す。`UPDATE`・`DELETE` は DB の権限で禁止する。
- 残高は仕訳の行の和。読み出しの速さのために、口座ごとの残高の行（`account_balances`）を、仕訳と同じトランザクションで更新する。残高の行は仕訳の和と夜間に照らす。
- `seller_proceeds` と `balance_reserved` の残高は負にならない（CHECK）。

### 取引の仕訳

| 事象（冪等キー） | 借方 | 貸方 |
| --- | --- | --- |
| カードの確定 `(transaction, <id>, hold)` | `psp_receivable` 代金 | `escrow:<id>` 代金 |
| 残高での購入 `(transaction, <id>, hold)` | `balance_reserved:<buyer>` 代金 | `escrow:<id>` 代金 |

> 2026-10-10 の注記：組み合わせの支払い（ポイント・売上金 ＋ カード）では 1 つの取引に hold が 2 つ要り、同じ冪等キーでは 2 つ目が書けない。残高の行の冪等キーを `(transaction, <id>, hold_balance)`（型 `hold_balance`）に分けた。カードの行は `(transaction, <id>, hold)`（型 `hold_psp`）のまま。冪等キーで 1 回に限る決定の意味は変えていない（[ADR-0040](0040-balance-spend-order-and-reservation.md)、[ADR-0034](0034-chart-of-accounts-journal-types-and-fee-rounding.md)）。

| 完了 `(transaction, <id>, release)` | `escrow:<id>` 代金 | `seller_proceeds:<seller>` 代金 − 手数料 − 送料、`fee_revenue` 手数料、`shipping_payable:<carrier>` 送料 |
| 取り消し `(transaction, <id>, refund)` | `escrow:<id>` 代金 | `psp_receivable` か `balance_reserved:<buyer>`（払った手段へ戻す） |
| 運用の補償 `(compensation, <case_id>, grant)` | `compensation_expense` | `points:<user>` か `seller_proceeds:<user>` |

- **冪等キー**：`journals` に `(source_type, source_id, event)` の一意の制約を置く。同じ事象を何度受けても仕訳は 1 つ。
- **release と refund の排他**：`escrow_settlements` の表に `transaction_id` の一意の制約を置き、release か refund の仕訳と同じトランザクションで 1 行を挿入する。2 つ目は一意の違反で書けない。違反は「すでに決着した」として、決着の種類が同じなら成功、違うなら呼び出しのアラートにする。
- **預かりの 0**：release・refund の後、`escrow:<id>` の残高は 0（CHECK はトランザクションの終わりで検査）。部分の返金（運用の判断）は、refund の額と release の額の和が代金になる 1 つの仕訳（`settle` の型）で書き、排他の行も 1 つ。
- 手数料と送料の計算は `packages/fees` の 1 つの関数で、取引の作成の時の手数料の表のバージョンと送料の表のバージョンを使う（取引の行に記録する）。

### 取引と台帳のつなぎ方

- 取引の遷移は、core の outbox に `transaction.paid`・`transaction.completed`・`transaction.cancelled` を書く。`ledger` の消費者がそれを受け、上の仕訳を冪等に書く。
- 残高での購入の引き当ては、購入の前に `ledger` を同期で呼ぶ（[ADR-0002](0002-transaction-state-machine-and-single-purchase.md)）。購入が失敗したら引き当てを戻す。取引に結び付かない引き当ては、15 分で照合の処理が戻す。
- 売上金は、release の仕訳の確定で残高に出る。完了の事象から仕訳まで p99 1 分（NFR-006）。

### 照合

| 照合 | 頻度 | 見るもの | 外れたとき |
| --- | --- | --- | --- |
| 取引と台帳 | 5 分ごと | `paid` 以降の取引に hold があるか。`completed` に release、`cancelled`（支払いの後）に refund があるか。15 分を超えた欠け | 欠けは事象を出し直す。重複・両方は呼び出し（NFR-005） |
| 台帳の内部 | 夜間 | 全口座の和 0、残高の行と仕訳の和、`escrow` の決着した口座の 0 | 呼び出し |
| 台帳と提供者 | 日次 | 提供者の精算のファイル・API の取引ごとの額と、`psp_receivable` の動き | 説明のつかない差は `suspense` へ。3 営業日で人が確かめる（NFR-004） |
| 台帳と銀行 | 日次 | 銀行の明細（入金、振込）と `bank_operating`・`payout_in_transit` | 同上 |

### 他の案を選ばなかった理由

- **2（残高の列）**：残高の足し引きの誤りと二重の適用を、後から説明できない。監査に仕訳の形が要る。
- **3（提供者のマーケットプレイスの機能）**：預かりの期間（数週間）、売上金での購入、ポイント、本システムの手数料の表を、提供者の機能の形に合わせることになる。売上金の法的な整理（[ADR-0004](0004-proceeds-model-under-payment-services-act.md)）を提供者の形に縛られる。台帳は題材の核なので自前にする。

## Consequences

- 良くなること：
  - お金の動きをすべて仕訳で説明でき、照合と監査ができる。
  - release と refund の排他を、DB の一意の制約で守れる。経路と再試行の数に依らない。
  - 売上金・残高・ポイントの種類を口座で分け、法的な整理が変わっても仕訳の型を足すだけで済む。
- 引き受けるコスト：
  - 取引ごとに `escrow` の口座ができ、口座の数が取引の数に比例する。決着した口座は夜間に閉じた印を付け、残高の行を消してよい（仕訳は残す）。
  - `fee_revenue` と `psp_receivable` は熱い口座になる。S2 から、口座をスロットに分け、残高の行を持たない形にする（Stripe の題材の [ADR-0016](../../../stripe/docs/decisions/0016-hot-accounts-and-ledger-sharding.md) の考え方）。
  - core と ledger の間の遅れ（数秒）の間、取引は完了なのに売上金が出ていない時がある。画面は「反映中」を出す。

## Confirmation

- 性質ベーステスト：任意の事象の列（支払い、完了、取り消し、部分の返金、補償、事象の重複・遅れ・順序の入れ替え）で、仕訳は常に釣り合い、全口座の和は 0、`escrow` は決着で 0、release と refund は取引ごとに合わせて 1 回（[quality.md](../quality.md) の 2.2.1 節 B）。
- 参照の実装（`ledger-ref`）：同じ事象の列を素直に足し引きした残高と、台帳の残高が一致する。
- DB の権限の検査：ledger の仕訳の表に `UPDATE`・`DELETE` の権限がないこと。
- 本番：照合の結果を SLI にし、重複・欠け 0 を目標にする（[runbooks/](../runbooks/README.md)）。

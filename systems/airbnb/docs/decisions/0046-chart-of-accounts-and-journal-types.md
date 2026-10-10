---
status: accepted
date: 2026-10-10
---

# ADR-0046: 勘定科目を 22 の口座の種類、仕訳の型を 31 で確定する。ADR-0005 の表に、`payout_in_transit`、`host_receivable`、`unapplied_payments`、`psp_chargeback_held`、`psp_fee_expense`、`fx_gain_loss`、`compensation_expense`、`chargeback_loss_expense`、`cancellation_fee_revenue`、`claim_funds_held` を足す。仕訳の型はコードのバージョンで、フラグで切り替えない

## Context

- [ADR-0005](0005-payments-hold-capture-and-ledger.md) は勘定科目と 7 つの仕訳の草案を置き、確定は ledger-and-payouts の領域の spec に書くとした。
- 草案にない動きがある：送金の依頼と銀行の確かめの間、ホストからの未収（罰、チャージバック、release の後の返金の不足）、取り消しの後の成功、チャージバック、提供者の手数料、為替の損益、補償、ホストのキャンセルの罰、損害の請求。
- 仕訳は 1 つの通貨に閉じる（[ADR-0008](0008-multi-currency-and-fx.md)）。

## Options

1. **草案の口座の意味を変えずに口座と型を足し、全部を 1 つの表で固定する**
2. 足りない動きを `suspense` と手の仕訳で扱う
3. 予約ごと・ホストごとに口座の種類を細かく分ける（明細の項目ごとの口座）

## Decision

1 を採用する。表は [ledger-and-payouts.md](../architecture/ledger-and-payouts.md) の 4 節。

- 口座の種類 22。足したのは `psp_chargeback_held`、`unapplied_payments`、`host_receivable`、`payout_in_transit`、`claim_funds_held`、`cancellation_fee_revenue`、`fx_gain_loss`、`psp_fee_expense`、`bank_fee_expense`、`compensation_expense`、`chargeback_loss_expense`、`ops_adjustment`。
- 仕訳の型 31。冪等キーは `(source_type, source_id, seq, event)` と通貨。ADR-0005 の 7 つの型は、型 1・2・3・4・5・6・9・11・12 に当たり、意味を変えていない。送金は `payout_in_transit` を挟んだ。
- 1 つの仕訳は 1 つの通貨（`journals.currency` と全部の行の口座の通貨が一致することをトリガーで守る）。通貨の違う決着は、同じトランザクションの 2 つの仕訳（型 7）。
- `UPDATE`・`DELETE` の権限を持たない。直しは型 31 と承認つきの `ops_adjustment` だけ。
- 型の追加はこの表と ADR の更新で行う。`legal.*` で無効の型（型 30）は書く関数の入口で拒む。

### 他の案を選ばなかった理由

- **2**：日常の動きが `suspense` に入ると、照合の外れと区別できない。
- **3**：口座の数が増え、残高の行と照合が重くなる。明細は仕訳の行の型で作れる。

## Consequences

- 良くなること：
  - すべての動きが決まった型で書かれ、照合の対象になる。
- 引き受けるコスト：
  - 型が 31 あり、表駆動テストと参照の実装の保守が増える。

## Confirmation

- 性質ベーステスト PROP-LED-001（釣り合い）、PROP-LED-004（`ledger-ref` との一致）。
- 表駆動テスト：型ごとの借方・貸方・通貨。

---
status: accepted
date: 2026-10-10
---

# ADR-0044: 返金は元の支払いの方法と請求の通貨に、台帳の `guest_refund_payable` の額で依頼する。冪等キーは `<reservation_id>:refund:<seq>`。提供者が返せない（カードの失効など）返金は 30 日の再試行の後に運用の手続きへ回す。予約の取り消しの後に成功した支払いは、自動で全額を返す

## Context

- 返金はゲストが払った通貨と額をもとに計算する（[ADR-0008](0008-multi-currency-and-fx.md)）。額は `packages/cancellation` が決め、台帳が `guest_refund_payable` に入れる（[ADR-0039](0039-cancellation-policy-table-and-refund-decision-table.md)、[ADR-0046](0046-chart-of-accounts-and-journal-types.md)）。
- 返金の依頼は失敗しうる（カードの失効、口座の閉鎖）。
- 仮押さえの期限の後に提供者の成功が分かることがある（[ADR-0035](0035-booking-decision-table-and-deadlines.md) の照会の不明）。

## Options

1. **元の方法と通貨に、台帳の額で。30 日の再試行の後は運用。取り消しの後の成功は自動で全額を返す**
2. 返金の額を `payments` で計算する
3. 返せない返金を本システムの残高（クーポン）にする

## Decision

1 を採用する。詳細は [payments-and-fx.md](../architecture/payments-and-fx.md) の 6 節。

- `ledger.refund_due` を受けて、`refund(capture_ref, amount, currency)` を `<reservation_id>:refund:<settlement_seq>` で依頼する。成功で型 8（`guest_refund_payable` → `psp_receivable`）。
- 複数の確定のある予約は、新しい確定から順に割り振る。
- 一時の失敗は 15 分・1 時間・4 時間・24 時間と 30 日まで再試行。恒久の失敗は運用の待ち行列で、銀行での返金（型 27）。
- 取り消しの後の成功は、型 13 で `unapplied_payments` に受け、`<reservation_id>:refund:orphan` で全額を返し、型 14 で戻す。

### 他の案を選ばなかった理由

- **2**：返金の額の計算が 2 か所になり、台帳と食い違う。
- **3**：ゲストの残高は前払式支払手段の論点（法務の L5）で、MVP の後。

## Consequences

- 良くなること：
  - 返金の額は 1 か所で決まり、同じ番号の返金は 1 回。
- 引き受けるコスト：
  - 銀行での返金は運用の手作業で、法的な整理（L5）を待つ。

## Confirmation

- 性質ベーステスト PROP-PAY-003（取り消しの後の成功は全額が返り、`unapplied_payments` は 0 に戻る）。
- 照合 P2・P3。

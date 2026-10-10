---
status: accepted
date: 2026-10-10
---

# ADR-0044: 返品は、受け付け → 承認 → 到着 → 検品 → 返金 の状態の機械で持つ。在庫への戻しは検品で行ごとに「戻す」「破損」「戻さない」を選び、戻すなら `on_hand` と `available` を、破損なら `on_hand` と `unavailable` を増やす。返金は返品と別の行（`refunds`）にし、冪等キー `<refund_id>:refund` で提供者に依頼する。`refund_required` のチェックアウトの返金も同じ行と処理を使う

## Context

- 返品の受け付けから返金までに、物の到着と検品が入る。事業者によっては到着の前に返金する。
- 返金は、返品だけでなく、注文の行の取り消し（[ADR-0039](0039-order-status-axes-and-edits.md)）、注文のないチェックアウトの返金（[ADR-0029](0029-checkout-completion-decision-table.md) の `refund_required`）、支払い待ちの取り消しの後の入金（[ADR-0037](0037-async-payments-pending-orders.md)）でも起きる。
- 返金の結果不明は、別の参照の番号で送り直すと二重の返金になる（[Stripe の payments.md](../../../stripe/docs/architecture/payments.md) の 7.5 節）。

## Options

1. **返品と返金を別の行にする。返金は 1 つの処理で、冪等キーと照会で確定する**
2. 返品の行の中に返金の状態を持つ
3. 返金を事業者の提供者の管理画面に任せる

## Decision

1 を採用する。詳細は [returns-and-refunds.md](../architecture/returns-and-refunds.md) の 3・4・7 節。

- 返品の状態：`requested` → `approved` / `declined`、`approved` → `in_transit`（返送の追跡の番号）→ `received` → `inspected` → `closed`。`approved` から `closed`（物を戻さない返金）も許す。
- 検品で行ごとに戻し方を決め、在庫の移動の行（理由 `return_restock`・`return_damaged`）を書く（[ADR-0023](0023-inventory-movements-ledger-and-reconciliation.md)）。戻し先の拠点は、事業者が選ぶ（既定は元の配送の拠点）。
- 返金（`refunds`）：`requested` → `sent` → `succeeded` / `failed`、`sent` → `unknown` → 照会で `succeeded` / `failed`。冪等キー `<refund_id>:refund`。`unknown` の間は別のキーで送り直さない。照会の予定は [ADR-0036](0036-payment-webhook-inbox-and-inquiry-schedule.md) と同じ。
- 返金の作成のトランザクションで、返金の額の上限を確かめ（[ADR-0043](0043-refund-calculation-from-unit-allocations.md)）、outbox に `refund.requested` を書く。提供者への依頼は `refund-worker` が行う。
- 確定の前の注文の返金は、取り消し（`void`。全額）か、確定の額を減らす（[ADR-0038](0038-capture-timing-and-authorization-expiry.md)）。確定の後は返金。

### 他の案を選ばなかった理由

- **2**：返品のない返金（取り消し、`refund_required`）を表せない。
- **3**：注文の返金の記録と、返還インボイスの元がなくなる。

## Consequences

- 良くなること：どこから起きた返金も 1 つの処理と照合に乗る。
- 引き受けるコスト：返品の状態と返金の状態の 2 つを画面で合わせて見せる。

## Confirmation

- 性質ベーステスト：PROP-RET-004（返金の依頼の重複・結果不明で、提供者の返金は 1 回）、PROP-RET-005（返品の戻しの後の在庫の不変条件）。
- 表駆動テスト：DT-RET-001（返金の起点 × 確定の前後 × 手段）。

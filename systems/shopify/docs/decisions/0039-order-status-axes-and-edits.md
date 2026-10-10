---
status: accepted
date: 2026-10-10
---

# ADR-0039: 注文の状態を、注文（`open`・`closed`・`cancelled`）、支払い（`financial_status`）、配送（`fulfillment_status`）の 3 つの軸に分け、それぞれ 1 つの遷移の関数で書く。MVP の注文の編集は、未配送の行の数を減らす・取り消す、配送先を変える、の 3 つだけにし、行の追加と価格の変更は持たない。注文の番号はショップごとの数え上げから、セールの間は 20 ずつの塊で取り、欠番を許す

## Context

- 注文は、支払い（支払い待ち・オーソリ・確定・返金）、配送（一部・全部）、返品が別々の速さで進む。1 つの状態の列にすると、組み合わせの数だけ状態が増える。
- 本家の注文も、支払いの状態と配送の状態を別に持つ（[Payment authorization and capture](https://help.shopify.com/en/manual/payments/payment-authorization)、2026-10-10 に確認。状態の一覧の全体は**未検証**）。
- 行を足す・価格を変える編集は、追加の決済（差額の請求）と、在庫の引き当て・税の再計算が要る。

## Options

1. **3 つの軸。編集は減らす方向と配送先だけ**
2. 1 つの状態の列
3. 本家のように行の追加と差額の請求まで持つ

## Decision

1 を採用する。詳細は [orders-and-fulfillment.md](../architecture/orders-and-fulfillment.md) の 3・4 節。

- `status`：`open` → `closed`（全行が配送済みか取り消し済みで、未処理の返品がない。30 日後に自動）、`open` → `cancelled`（未配送の全行の取り消し）。
- `financial_status`：`pending`（支払い待ち）、`authorized`、`paid`、`partially_refunded`、`refunded`、`voided`、`expired`、`capture_failed`。
- `fulfillment_status`：`unfulfilled`、`partially_fulfilled`、`fulfilled`。行ごとの `fulfilled_qty`・`cancelled_qty`・`returned_qty` から求める。
- 軸ごとに `packages/orders` の遷移の関数だけが書き、遷移ごとに `order_events` に行を足す。
- 編集：
  - 行の数を減らす・取り消す（未配送の分だけ）：在庫の `committed` を戻し、返金か取り消しの額を [ADR-0043](0043-refund-calculation-from-unit-allocations.md) の単位の額で計算する。
  - 配送先の変更（最初の配送の前だけ）：送料と税の区分は変えない（送料の差は事業者の判断で返金）。
- 編集のバージョン（`order_version`）を持ち、Admin API の更新はバージョンの比べで行う。
- 注文の番号（`#1001` の形の表示の番号）：ショップごとの `order_number_counters` の行から取る。通常は 1 つずつ、`completeCheckout` のトランザクションの中で取る。フラッシュセールの `open` の間は、`checkout` のタスクが 20 ずつの塊を別のトランザクションで取り、タスクの中で配る。番号は時刻の順にならないことがあり、欠番（タスクの終了で使わなかった番号）を許す。注文の識別は `order_id`（UUIDv7）で、表示の番号に一意の制約を置く。

### 他の案を選ばなかった理由

- **2**：状態の数が掛け算で増え、決定表が読めなくなる。
- 注文の番号を 1 つの行で毎回取る形は、1 ショップ 100 件/秒で熱い行になるので、セールの間だけ塊にした。
- **3**：追加の決済の流れ（新しい決済のセッション、差額の請求のメール）は、MVP の範囲を超える。MVP の後の Epic で扱う。

## Consequences

- 良くなること：軸ごとの遷移が小さく、検査しやすい。
- 引き受けるコスト：注文の番号に欠番と、時刻の順の入れ替わりが出る（セールの間）。事業者は、行の追加の代わりに新しい注文を作る（管理画面の下書きの注文は MVP の後）。

## Confirmation

- 表駆動テスト：DT-ORD-001（キャンセルと編集）、各軸の遷移の表。
- 性質ベーステスト：任意の配送・取り消し・返品の列で、行の `fulfilled_qty + cancelled_qty ≤ quantity`、`returned_qty ≤ fulfilled_qty`（PROP-ORD-001）。

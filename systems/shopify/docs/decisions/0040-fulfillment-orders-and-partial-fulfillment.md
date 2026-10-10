---
status: accepted
date: 2026-10-10
---

# ADR-0040: 注文の作成と同じトランザクションで、引き当てた拠点ごとに 1 つの配送の指示（fulfillment order）を作る。配送（shipment）は配送の指示の行の数の一部を持ち、作成で `committed` と `on_hand` を減らす。配送の指示の拠点の変更は、未着手の行の分だけ、新しい拠点で引き当て直して行う

## Context

- [ADR-0022](0022-location-selection-and-lock-order.md) は、行ごとに拠点を決める。1 つの注文が複数の拠点から出ることがある。
- 本家は、注文の振り分けの後、拠点ごとに 1 つ以上の配送の指示を作る。配送の指示は、保留・予定・進行中・閉じたなどの状態を持ち、一部の行だけを別の拠点へ移すと分かれる（[FulfillmentOrderStatus](https://shopify.dev/docs/api/admin-graphql/latest/enums/FulfillmentOrderStatus)、[FulfillmentOrderAssignedLocation](https://shopify.dev/docs/api/admin-graphql/latest/objects/fulfillmentorderassignedlocation)、2026-10-10 に確認）。
- 一部の配送（数の一部、行の一部）は日常に起きる（欠品、破損、別送）。

## Options

1. **拠点ごとの配送の指示。配送は指示の行の数の一部。拠点の変更は引き当て直し**
2. 注文の全体を 1 つの配送の単位にする
3. 配送の指示を作らず、配送を注文の行に直接ぶら下げる

## Decision

1 を採用する。詳細は [orders-and-fulfillment.md](../architecture/orders-and-fulfillment.md) の 5 節。

- 配送の指示の状態：`open` → `in_progress`（最初の配送か、送り状の書き出し）→ `closed`（全数の配送か取り消し）。`on_hold`（事業者の保留、支払い待ちの注文の既定）、`cancelled`。
- 支払い待ち（`financial_status = pending`）の注文の配送の指示は `on_hold` で作り、支払いの確認で `open` にする。
- 配送：配送の指示の行と数、運送会社、追跡の番号を持つ。作成のトランザクションで、行の `fulfilled_qty` を増やし、在庫の `committed` と `on_hand` を減らし（[ADR-0020](0020-inventory-slot-counters-and-reservation-sweep.md)。`committed` を持つ枠を枠の番号の順に減らす）、移動の行を書く（[ADR-0023](0023-inventory-movements-ledger-and-reconciliation.md)）。
- ピッキングで見つかった破損：`committed` を減らし `unavailable` を増やす調整（理由 `damaged_at_pick`）と、行の取り消し（[ADR-0039](0039-order-status-axes-and-edits.md)）か、別の拠点への移しを、事業者が選ぶ。
- 拠点の移し：未着手の行の数だけ、新しい拠点で引き当てて確定し（同じトランザクションで元の拠点の `committed` を `available` へ戻す）、新しい配送の指示を作る。

### 他の案を選ばなかった理由

- **2**：分割の配送と欠品を表せない。
- **3**：拠点ごとの作業の単位（倉庫への依頼、送り状）がなくなる。

## Consequences

- 良くなること：拠点・運送会社の連携が配送の指示の単位で閉じる。
- 引き受けるコスト：配送の指示の行の数と注文の行の数の整合を、遷移の関数で守る。

## Confirmation

- 性質ベーステスト：PROP-ORD-001、PROP-ORD-002（配送で減らした `committed` の合計が、配送の数の合計と一致し、在庫の不変条件が保たれる）。

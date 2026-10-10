---
status: accepted
date: 2026-10-10
---

# ADR-0034: 割引の使用の回数（全体と買い手ごと）は、在庫と同じ形の数え上げの行（枠つき）で、送信で引き当て、`completeCheckout` で確定し、期限切れで戻す。全体の上限のある割引は、セールのときに枠を 16 に分ける

## Context

- 割引のコードの使用の回数の上限（全体、買い手ごと）を守る。
- [ADR-0005](0005-checkout-state-machine-and-exactly-once-orders.md) は、全体の上限つきのコードがフラッシュセールで熱い行になりうるので、在庫と同じ枠の方式を使うと決めた。
- 決済が済んだ後に回数を取り直せなくても注文を作る（[ADR-0029](0029-checkout-completion-decision-table.md)）。

## Options

1. **数え上げの行に引き当て・確定・戻しを持ち、熱いときは枠に分ける**
2. 注文の作成の時点だけで数える
3. Valkey で数える

## Decision

1 を採用する。詳細は [discounts-engine.md](../architecture/discounts-engine.md) の 9 節。

- `discount_usage_slots`（`discount_id`, `slot_no`）に `remaining`・`reserved`・`used` を持ち、`CHECK (remaining >= 0)`。上限なしの割引は行を持たず、`used` だけを `discount_usage_totals` に非同期で数える。
- 買い手ごとの上限は `discount_customer_usage`（`discount_id`、買い手の鍵のハッシュ）に `reserved`・`used` を持つ。買い手の鍵は、ログインした買い手の ID、なければメールアドレスの正規化のハッシュ（[ADR-0026](0026-bot-defense-and-purchase-limits.md) の規則）。
- 送信で、写しに入った割引ごとに引き当て（`checkout_discount_reservations`）を書く。期限はチェックアウトの在庫の引き当てと同じ。戻しは在庫の掃除の処理が同じトランザクションで行う。
- 枠の数：既定 1。セールの `prepared` の段で、セールのショップの全体の上限つきの自動の割引とコードを 16 に分ける（[ADR-0027](0027-flash-sale-preparation-and-surge-auto-queue.md)）。
- 取り直せないとき（決済済み）は `used` を増やし、`remaining` を 0 のまま超過の数（`overage`）を足す。

### 他の案を選ばなかった理由

- **2**：送信から完了までの間に上限を超えて受け付け、決済の後に多数の超過が出る。
- **3**：Valkey の障害で数を失い、上限を守れない。

## Consequences

- 良くなること：使用の回数の上限が、在庫と同じ正しさの仕組みに乗る。
- 引き受けるコスト：送信のトランザクションに数え上げの行の更新が増える。

## Confirmation

- 性質ベーステスト：任意の並行の送信・完了・期限切れで、`used − overage` が上限を超えない。`overage > 0` は、引き当てを戻した後に決済が済んだ場合だけ（PROP-DSC-006）。

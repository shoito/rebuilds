---
status: accepted
date: 2026-10-10
---

# ADR-0049: 照合は予約と台帳（5 分ごと）、台帳の内部（5 分ごと）、台帳・提供者・銀行の 3 者（日次）の 3 段。説明のつかない差は `suspense` に置き 3 営業日で人が確かめる。税の預かり（`tax_payable`）と納付の仕訳は `legal.lodging_tax_collector` が `platform` の管轄だけで使い、既定の `host` ではホストへの支払いに含めて明細に分けて書く

## Context

- 予約と台帳、台帳の内部、3 者の照合を持ち、説明のつかない差は `suspense` に置いて 3 営業日で人が確かめる（[ADR-0005](0005-payments-hold-capture-and-ledger.md)、NFR-007）。照合の項目は決まっていない。
- 本システムが税を預かり納めるかは法務の L4。taxes の領域は `legal.lodging_tax_collector`（`host`・`platform`。管轄ごと）を決めた（[ADR-0034](0034-tax-collection-model.md)）。
- Stripe の題材の 3 者の照合（[ADR-0017](../../../stripe/docs/decisions/0017-three-way-reconciliation-with-suspense.md)）の形を参照する。

## Options

1. **3 段、11 の照合の項目。税の口座は `platform` の管轄だけ**
2. 日次の 3 者の照合だけ
3. 税の口座を常に使い、`host` のときはすぐホストへ振り替える

## Decision

1 を採用する。詳細は [ledger-and-payouts.md](../architecture/ledger-and-payouts.md) の 8・9 節。

- 予約と台帳（R1〜R5）：確定に hold、release の後に決着、決着した預かりが 0、キャンセルに決着、チェックインの前の release なし。
- 台帳の内部（R6〜R8）：仕訳と全口座の和、残高の行、`fx_clearing` と `fx_positions`。
- 3 者（R9〜R11）：提供者の精算、銀行の明細、`payout_in_transit` の残り。外れは型 31 で `suspense` に置く。
- R5・R6 の外れは送金を止める（`ops.payouts_enabled = false`）。
- 税：`host` は `host_payable` に含め、明細に管轄・税の種類・額を分ける。`platform` は `tax_payable:<管轄>:<税>` と型 30。切り替えは施行の日以後に確定した予約から。

### 他の案を選ばなかった理由

- **2**：決着の欠け・早い release を 1 日見逃す。
- **3**：税を預かる義務のないうちに、預かりの口座の残高が生まれる（ADR-0034 の理由）。

## Consequences

- 良くなること：
  - 欠けと重なりを 15 分で見つけ、早い release を 5 分で止める。
- 引き受けるコスト：
  - 5 分ごとの照合の読み出しの負荷（ledger の読み出しの写しで受ける）。

## Confirmation

- 障害の注入：ledger の消費者の 10 分の停止、事象の重複、組戻しで、照合が外れを見つけ、再開の後に 0 に戻る。
- 本番：3 営業日の後の説明のつかない差 0 円（[quality.md](../quality.md) の 4.1 節）。

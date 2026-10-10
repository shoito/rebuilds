---
status: accepted
date: 2026-10-10
---

# ADR-0030: `quoteStay` は、泊の料金の解決 → 長期の割引 → 追加のゲスト → 清掃料・ペット → 宿泊の対価の小計 → 税（`packages/tax`）→ 総額 → 換算の順の 1 つの純粋な関数で、割合の計算は有理数で持って行ごとに 1 回だけ四捨五入する。見積もりの写しは各行の額と全部の表の ID とバージョンを持つ。検索の `quoteSummary` は同じ関数を換算の固定なしで呼ぶ

詳細は [pricing-and-fees.md](../architecture/pricing-and-fees.md) の 6 節。

## Context

- 見積もりの総額と請求の額の違いは 0（NFR-015）。見積もりは料金の規則・税の表・為替の相場の ID とバージョンを固定する（[ADR-0004](0004-booking-state-machine-and-holds.md)、[ADR-0008](0008-multi-currency-and-fx.md)）。
- 検索のステージ 2 は 300 件の料金の要約で価格を絞る（[ADR-0003](0003-search-for-date-range-availability.md)）。見積もりと別の計算にすると、検索で見た額と確認の画面の額がずれる。
- 割合の計算の順と端数で、1 円の違いが出る。キャンセルの返金は見積もりの各行から計算する（cancellations-and-changes の領域）。

## Options

1. **1 つの純粋な関数（固定の段の順、行ごとに 1 回の四捨五入）と、書き込みの 1 か所**
2. 見積もりと検索の要約を別の関数にし、検索は概算にする
3. 浮動小数点で計算し、最後に丸める

## Decision

1 を採用する。

- `priceStay(rules, stay, guests, tax_tables, fee_schedule, fx_snapshot)` が段 1〜9（泊、割引、追加のゲスト、清掃料・ペット、小計、税、総額、サービス料、換算）を行う。`quoteStay` はこれを呼んで `quotes` に写しを書く。`quoteSummary` は料金の写しと最新の相場で呼び、書かない。
- 割合（割引、サービス料、定率の税）は分子と分母の整数で持ち、行ごとに 1 回だけ `round_half_up`。浮動小数点を使わない。換算は合計だけを 1 回、行は大きい行から 1 単位ずつ按分（[ADR-0008](0008-multi-currency-and-fx.md)）。
- 写しは `listing_version`・`revision_id`・`pricing_version`・`cancellation_policy_version`・税の表のバージョン・サービス料の表のバージョン・`fx_snapshot_id` と各行の額を持つ。15 分、1 回だけ使える。同じ条件の 15 分の中の再度の要求には同じ写しを返す。

### 他の案を選ばなかった理由

- **2**：検索の額と確認の画面の額の違いが、関数の違いで生まれる。違いの原因を写しの遅れだけに絞りたい。
- **3**：浮動小数点の誤差で、同じ入力で 1 円違う結果がありうる。参照の実装との比べで偽の失敗が出る。

## Consequences

- 良くなること：
  - 見積もり・検索・参照の実装が同じ段の順で、違いを性質で確かめられる。
- 引き受けるコスト：
  - 検索の目安には料金の写しの遅れの分の違いが残る。違いの率を見張る。

## Confirmation

- PROP-PRC-001、PROP-PRC-002、PROP-PRC-003、PROP-PRC-007。
- 試験のベクトル：[pricing-and-fees.md](../architecture/pricing-and-fees.md) の 8.2 節の例。

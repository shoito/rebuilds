# Runbook: 販売所の提示の停止

- Owner: Ops（当番）、財務
- 対応するアラート: 販売所の提示の停止が続く（理由のコードごと。10 分でチケット）、在庫の評価の損失が 24 時間で 3,000 万円を超えた（page。財務と Ops）、`price_moved` の率の急な上がり
- 最終確認日: 2026-11-15

前提の設計は [brokerage-quotes.md](../architecture/brokerage-quotes.md)（4.2 節の止める条件 DT-BRK-1、4.5 節の在庫、5 節の障害の表）、[ADR-0010](../decisions/0010-brokerage-quotes-and-inventory.md)、[ADR-0024](../decisions/0024-brokerage-mid-price-and-spread.md)、[ADR-0025](../decisions/0025-brokerage-inventory-target-and-replenishment.md)。**止める条件を緩めて再開しない。** 運用で変えてよいのは、基本の幅を広げることだけ（[README.md](README.md) の 2 節）。

## 症状

- 資産の買い・売りのどちらか、または両方の提示が出ない。理由のコードは次のどれか。
  - 中の価格を作れない：`mid_ex` と `mid_ref` が 2% 以上離れた、参照の価格の提供者が 2 つとも古い（10 秒）、2 つの提供者が 1% 以上離れた、板の写しが 10 秒更新されない、板が `trading` でない、板の最良の気配の幅が中値の 2% を超える。
  - スプレッドがその向きで 500 bp を超えた。
  - 在庫：`d` が ＋1（利用者の売りを止める）か −1（利用者の買いを止める）、日本円の在庫が 1,000 万円を下回った（利用者の売りを止める）。
  - 在庫の評価の損失の上限（両方の資産を止める）。
  - `ops.brokerage_enabled.<asset>` が切れている。

## 影響

- 利用者は販売所で売り買いできない。拒んだ受け入れには新しい提示を返さない（止めている間）。
- 販売所の可用性の SLO（99.95%）は、参照の価格の不一致で止めた時間を別に数える（[README.md](README.md) の 1 節）。

## 確認

1. 止めた資産と向き、理由のコード、止めた時刻。
2. 参照の価格の提供者の状態（[provider-outage.md](provider-outage.md)）。
3. 板の状態（[market-halt.md](market-halt.md)）と、Valkey の板の写しの更新（[market-data-degraded.md](market-data-degraded.md)）。
4. 在庫の `d` の推移、日本円の在庫、24 時間の評価の損失。本システムの持ち分の精算の待ち（[house-settlement-stuck.md](house-settlement-stuck.md)）。
5. `σ10` の値（相場の急変でスプレッドの上限に当たっていないか）。

## 対処

1. **中の価格の理由**：原因の側（提供者、板、配信）の手順に従う。原因が直れば、提示は自動で再開する。手で `mid` を入れない。
2. **相場の急変でスプレッドの上限**：急変が落ち着くのを待つ。早く再開したいときは、基本の幅を広げる（Ops。広げるだけ。変更を記録する）。上限の 500 bp は変えない。
3. **在庫の上限・下限**：財務が補充か処分を判断する（[brokerage-inventory-replenish.md](brokerage-inventory-replenish.md)）。在庫の目標と上限の値は、財務と PM の承認の設定の変更で、運用で変えない。
4. **評価の損失の上限**：両方の資産の提示を止めたままにする。財務と PM が再開を判断する（ADR-0025）。広げた基本の幅で再開するかもこの判断に含める。
5. **再開**：`ops.brokerage_enabled.<asset>` を切っていたら、2 人の承認で開ける。再開の後 30 分、提示の価格と取引所の最良の気配の差、`price_moved` の率を見る。

## エスカレーション

- 評価の損失の上限：財務の責任者、PM。
- 参照の価格の不一致が 30 分を超える：コンプライアンス（相場の操作の疑いを [market-surveillance.md](../architecture/market-surveillance.md) で見る）。
- 広げた基本の幅を 1 営業日を超えて続ける：財務、PM、コンプライアンス（価格の示し方は法務の L8）。

## 事後

- 止めた時間を理由のコードごとに記録し、DT-BRK-1 の場面（[quality.md](../quality.md) の 2.2.1 節 K）に足す。広げた基本の幅を元に戻した記録を残す。

---
status: accepted
date: 2026-10-10
---

# ADR-0079: SLI は runbooks の定義ごとに 1 つの指標と数える場所を持ち、速さと鮮度は全件の時刻の差で測る。検索の混入は 0.1% の抜き取りの DB での再判定で測る。正しさの SLI は照合の不一致の数と最後の成功からの時間の両方で見て、止まった照合の 0 を良いとしない。見張りは SLO から除く

## Context

- runbooks の SLI（[runbooks/](../runbooks/README.md) の 1 節）には、速さ（検索、予約）、鮮度（空室、外部の食い違い）、正しさ（二重の予約、180 日、決着、台帳、レビューの公開、見える範囲）、時期（送金）がある。どれも品質の判定に使う（[quality.md](../quality.md) の 4.1 節）。
- 正しさの多くは、DB の制約で 0 のはずのものを照合で確かめる。照合のジョブが止まると、不一致の数は 0 のまま見えて、二重の予約や上限の超過を見逃す。
- 検索の索引と写しは遅れうる（[ADR-0003](0003-search-for-date-range-availability.md)）。混入の率（泊まれないのに出た割合 0.5% 未満、NFR-002）は、検索の結果そのものを確かめないと測れない。
- 見張りの予約（`canary`）は本番の量に比べて少なく、速さの分布を代表しない。
- Mercari の題材は、全件の時刻の差と照合の最後の成功からの時間を決めた（[Mercari の ADR-0075](../../../mercari/docs/decisions/0075-sli-measurement-and-correctness-monitors.md)）。

## Options

1. **SLI ごとに 1 つの指標、全件の時刻の差、抜き取りの再判定、照合の最後の成功からの時間、見張りを除く**
2. 見張りの合成の要求で SLI を測る
3. 照合の不一致の数だけを見る

## Decision

1 を採用する。詳細は [observability.md](../architecture/observability.md) の 3・4 節。

- **指標の対応**：runbooks の SLI ごとに、指標の名前・数える場所・良いイベントの定義を 1 つの表で持つ。分母から除く結果（`dates_unavailable`、`quote_expired`、`regulatory_*`、カードの拒否、ボット、429）を指標の `outcome` で分ける。
- **空室の鮮度**：変化ごとに、`stay_claims` の commit（outbox の行の時刻）から、OpenSearch の bulk の受け付け＋再読み込みの間隔、Valkey の書き込みの応答までを、`source`（予約、ホスト、iCal、PMS、運用）ごとのヒストグラムで測る。古いバージョンで捨てた書き込みは数えない。
- **検索の混入**：`search-sampler` が検索の結果の 0.1% のリスティングを非同期に、応答の時刻の状態（`stay_claims` の作成・解除の時刻で再現）に `checkStayRules` を当て直して再判定し（[search-and-ranking.md](../architecture/search-and-ranking.md) の 8 節）、`ok`・`unbookable`・`price_out_of_range` を数える。取りこぼしは日次の全件の比べで出す。値は ID と理由のコードだけ記録する。
- **送金の時期**：release の commit − `payout_release_at` を全件（保留を除く）で測り、`payout_release_at` を過ぎて release のない予約の数を 1 分ごとに数える。
- **正しさの SLI**：`stay_claims`、180 日、予約と台帳、台帳の不変条件、レビューの公開、見える範囲の照合は、不一致の数と `..._last_success_timestamp_seconds` の両方を出す。間隔の 2 倍を過ぎたら、不一致と同じ重さで呼び出す。
- **見張り**：見張りの利用者とリスティングは `sentinel` の印で SLI から除き、`canary_*` の指標で可用性と端から端の確かめに使う。見張りのリスティングは届出住宅に結ばず、見張りの仕訳は 3 者の照合と収益の集計から外す。

### 他の案を選ばなかった理由

- **2（見張りで測る）**：熱い日付や繁忙期の分布を代表しない。見張りの経路だけが速い・遅いことを見誤る。
- **3（不一致の数だけ）**：照合が止まると 0 に見え、最も危ない時に安心させる。

## Consequences

- 良くなること：
  - SLI と品質の判定基準が、同じ指標から出る。
  - 照合の停止を、正しさの事故と同じ重さで見つけられる。
  - 混入の率を直接測れる。
- 引き受けるコスト：
  - 全件のヒストグラムと抜き取りの再判定の計算と保存の費用。
  - 照合のジョブを多く持つ（5 分ごと、日次、1 時間ごと）。

## Confirmation

- 仮想の時計の結合：照合のジョブを止めると、最後の成功からの時間のアラートが鳴る（PROP-OBS-002）。
- 結合：わざと古くした写しで混入の抜き取りが `unbookable` を数える。鮮度の指標が commit から受け付けまでを正しく記録する。
- E20 の `slo-dashboards-alerts` で、runbooks の全 SLI に指標とアラートがあることを確かめる。

---
status: accepted
date: 2026-09-27
---

# ADR-0016: Valhalla は taxi の costing と週 1 回の検査つきのタイルで動かし、自前の走行から速度の表を作る。ETA は経路の時間に偏りの補正を足し、受諾の時点の表示と実際の到着の差で精度を計る

## Context

[ADR-0005](0005-maps-and-routing.md) は、配車の ETA の行列、乗客に見せる ETA、軌跡の当てはめを自前の Valhalla で求め、交通は自前の走行の実績から作ると決めた。細部はこの領域に残した。

- 迎車の ETA の精度は、受諾の時点で表示した値と実際の到着の差の絶対値で、中央値 60 秒以内・p90 180 秒以内（NFR-003）。計測の定義はまだない。
- 本家は、経路のエンジンの ETA に、実績との差を学習したモデル（DeepETA）で補正をかける（[DeepETA](https://www.uber.com/us/en/blog/deepeta-how-uber-predicts-arrival-times/)、2022-02-10、2026-09-27 に確認）。
- Valhalla の事実（2026-09-27 に確認）：
  - 行列（`sources_to_targets`）の上限の既定は `auto` で 2,500 組。時刻に依る行列は、既定の設定（`max_timedep_distance_matrix` 0）では使えない（[Matrix API](https://github.com/valhalla/valhalla/blob/master/docs/docs/api/matrix.md)、[valhalla_build_config](https://github.com/valhalla/valhalla/blob/master/scripts/valhalla_build_config)）。
  - 予測の交通は、辺ごとに 1 週を 5 分ごとに区切った 2,016 の速度を DCT で圧縮してタイルに入れる。`valhalla_ways_to_edges` で OSM の way と辺を対応させ、`valhalla_add_predicted_traffic` で入れる（[Historical traffic](https://github.com/valhalla/valhalla/blob/master/docs/docs/concepts/historical-traffic.md)）。
  - `taxi` の costing は `auto` を受け継ぎ、タクシーの通れる車線を優先する（[Route API](https://github.com/valhalla/valhalla/blob/master/docs/docs/api/route/api-reference.md)）。

## Options

補正：

1. **S1 は偏りの表（解像度 7 × 1 週の 1 時間ごとの残差の中央値）。機械学習は S2 以降**
2. **S1 から機械学習の残差のモデル**
3. **補正なし**

行列の形：

- a. **依頼ごとの many-to-one**
- b. **バッチ全体の many-to-many**

タイルの更新：

- i. **週 1 回、検査つき、青緑の切り替え**
- ii. **毎日**
- iii. **OSM の差分を常に当て続ける**

## Decision

1、a、i を採用する。詳細は [eta-and-routing.md](../architecture/eta-and-routing.md) の 4〜6・8 節。

- `costing=taxi`。`use_tolls` 0.5、`use_highways` 0.5、`top_speed` 120。行列の距離の上限は 100 km。
- 配車の行列は依頼ごとの many-to-one、期限 400 ms。間に合わない組は `直線の距離 × 1.4 ÷ 時速 18 km ＋ 60 秒` の概算にし、印を付ける（係数は **未検証**の仮の値。E4 の `eta-bias-correction` で見直す）。
- `ETA = 経路の時間 ＋ 乗車地の種類ごとの固定の時間（30・60 秒）＋ 偏りの補正`。補正は直近 28 日の残差の中央値、30 件未満の区切りは親のセル、±120 秒。毎日作り直し、版を付ける。
- 時刻に依る行列は、E4 の PoC で精度と p99 を比べるまで使わない（`max_timedep_distance_matrix` を 30 km にして試す）。
- タイルは週 1 回、OSM・速度の表・上書きから作り、`tile_version` を付ける。黄金の経路の集合（2,000 組）の差、到達の可否、直近 7 日の ETA の誤差の再計算で検査し、青緑で切り替え、古い組を 24 時間残す。
- 速度の表は、当てはめた走行の直近 8 週から、way × 向き × 5 分 × 1 週の中央値で作る。5 件未満か異なるドライバーが 3 人未満の区切りは使わない。
- **精度の計測**：予測は受諾の時点に表示した値（保存する）、実際は `arrived` − `accepted`。到着の操作の位置が乗車地から 100 m より遠ければ、軌跡で 50 m 以内・時速 5 km 未満になった最初の時刻を使う。`|e|` の中央値・p90 と、`e` の中央値（偏り）を毎日出す。
- 2 を採らない理由：学習と配信の基盤（ml-platform）が S1 にない。偏りの表で NFR-003 に届くかを先に計る。
- 3 を採らない理由：日本の都市の信号・右折の待ち・乗車地の車寄せの時間を、経路のエンジンだけでは表しにくい（**未検証**。E4 の `eta-accuracy-metrics` で計る）。
- b を採らない理由：組の数が 36,000 になり上限を超え、使わない組を計算する。
- ii を採らない理由：検査と切り替えの手間に対し、日本の OSM の変化は 1 日では小さい。緊急の直しは臨時の作成で扱う。
- iii を採らない理由：版が定まらず、ETA の再生と比べができない。

## Consequences

- 良くなること：
  - ETA の各項が分かれ、どれが誤差を生んでいるかを計れる。
  - タイルと補正の版が応答と配車の記録に残り、再生で同じ値を再現できる。
  - 速度の表から、1 人のドライバーの走行が読み取れない。
- 引き受けるコスト：
  - タイルの作成・検査・切り替えの仕組みを自前で持つ。
  - 黄金の経路の集合を育て続ける（地図の誤りを直した場所を足す）。
  - 偏りの表は、交通の急な変化（事故、行事）に追いつかない。

## Confirmation

- E4 の PoC：Valhalla（時刻に依る・依らない）と商用の提供者の ETA を、東京の合成・匿名化した乗降の組で比べ、NFR-003 に届くかを記録する。
- 性質ベーステスト：PROP-ETA-001（概算の単調性）、PROP-ETA-002（補正の範囲）、PROP-ETA-005（精度の定義）。
- CI：小さな地域の抽出でタイルの作成と検査を毎回流す。
- 本番の計測：ETA の誤差の指標を毎日出し、2 日続けて NFR-003 を外れたら警告する。

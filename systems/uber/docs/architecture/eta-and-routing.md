# ETA and routing: Uber

到着時間（ETA）と経路。配車のための ETA の行列、乗客に見せる迎車と乗車の ETA、自前の Valhalla（OSM）の運用とタイルの作成、自前の走行の実績からの速度の表、ETA の精度の計り方（中央値の誤差 60 秒以内）、事前確定運賃のための推計走行距離を決める。

前提となる決定は、経路と ETA は OSM の上の Valhalla を自前で動かし、住所の検索と事前確定運賃の距離は商用の提供者を使う（[ADR-0005](../decisions/0005-maps-and-routing.md)）、NFR-003（迎車の ETA の精度：中央値 60 秒以内、p90 180 秒以内）。地図のデータの取り込みは [maps-and-geodata.md](maps-and-geodata.md)、速度の標本の元は [location-ingestion.md](location-ingestion.md)。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0016](../decisions/0016-valhalla-serving-traffic-and-eta-accuracy.md) | Valhalla は `taxi` の costing で動かし、配車の行列は依頼ごとの many-to-one にする。タイルは週 1 回、OSM と自前の速度の表（5 分 × 1 週の 2,016 の区切り）から作り、黄金の経路の集合で検査してから青緑で切り替える。ETA ＝ 経路の時間 ＋ 乗車地の固定の時間 ＋ 偏りの補正（`district` × 曜日時間帯の中央値、±120 秒）。精度は受諾の時点の表示と到着の差で毎日計る |
| [0017](../decisions/0017-fare-distance-for-pre-fixed-fares.md) | 事前確定運賃の推計走行距離は、法務の確認（L3）が済んだ地図の提供者だけで求める。確認までは商用の提供者を使い、Valhalla の距離で代えない。最短距離と最短時間の 2 つ以上のルート、有料道路の選択、乗客とドライバーに同じルートを示すことを API で守る。見積もりはバージョンと提供者つきで保存し、形状は提供者の条件の期間だけ持つ |

## 1. 目的と範囲

- 扱う：ETA の種類と求め方、Valhalla の costing と上限、タイルの作成とバージョンと切り替え、速度の表、ETA の補正、精度の計測、推計走行距離の API と保存、障害のときの代わり。
- 扱わない：OSM の取り込みと地図の誤りの直し方、住所の検索、営業区域の多角形（[maps-and-geodata.md](maps-and-geodata.md)）、運賃の計算（`pricing-and-fares.md`）、ETA の補正の機械学習のモデル（`ml-platform.md`。S2 以降）、ドライバーのナビ（外部のナビに引き継ぐ。`rider-and-driver-apps.md`）。

## 2. 本家の形と事実（確かめたこと）

| 項目 | 本家・公開の事実 | この設計 |
| --- | --- | --- |
| ETA の作り方 | 道路を重みつきの辺の小さな区間に分けたグラフで経路のエンジンが ETA を求め、実績との差（残差）を機械学習（DeepETA）で予測して足す。数ミリ秒で返す、本家で最も QPS の高いモデル。評価は平均絶対誤差（MAE）で、損失は遅れと早すぎを非対称に扱える Huber 損失（[DeepETA](https://www.uber.com/us/en/blog/deepeta-how-uber-predicts-arrival-times/)、2022-02-10） | 経路のエンジン（Valhalla）＋補正。S1 の補正は偏りの表（4.5 節）で、機械学習は S2 以降 |
| 規模 | 本家の経路のエンジンは、毎秒数十万件の ETA の要求を 1 桁ミリ秒で返す（[ETA Phone Home: How Uber Engineers an Efficient Route](https://www.uber.com/us/en/blog/engineering-routing-engine/)、2026-09-27 に確認）。「毎秒 50 万件」は二次の解説の数で、本家の資料にはない | S1 は数百件/秒 |
| 候補と ETA | 地理の索引の候補を、経路・ETA のサービスに送り、道路の上の近さを求める（[How Uber Scales Their Real-time Market Platform](http://highscalability.com/blog/2015/9/14/how-uber-scales-their-real-time-market-platform.html)） | 同じ（4.1 節） |
| Valhalla の行列 | `sources_to_targets`。`auto`・`taxi` などの costing を使える。行列の上限の既定は `auto` で 2,500 組、距離 400 km。時刻に依る行列は、既定の設定（`max_timedep_distance_matrix` 0）では使えない（[Matrix API](https://github.com/valhalla/valhalla/blob/master/docs/docs/api/matrix.md)、[valhalla_build_config](https://github.com/valhalla/valhalla/blob/master/scripts/valhalla_build_config)） | 5.4 節で設定を変える |
| Valhalla の速度 | 経路の速度は、現在の交通 → 予測（過去）の交通（1 週を 5 分ごとの 2,016 の値、DCT で圧縮してタイルに入れる）→ 昼の平均 → 夜の平均 → 基本の速度、の順に使う。予測の交通は `valhalla_add_predicted_traffic` で CSV から入れる（[Speeds](https://github.com/valhalla/valhalla/blob/master/docs/docs/concepts/speeds.md)、[Historical traffic](https://github.com/valhalla/valhalla/blob/master/docs/docs/concepts/historical-traffic.md)） | 自前の走行の実績から予測の交通を作る（8 節） |
| Valhalla の taxi | `taxi` の costing は `auto` を受け継ぎ、タクシーの通れる車線を確かめて優先する。`use_tolls`・`use_highways`（0〜1）、`shortest`（距離だけのコスト）がある（[Route API](https://github.com/valhalla/valhalla/blob/master/docs/docs/api/route/api-reference.md)） | 5.1 節 |
| 事前確定運賃 | 配車アプリ等に搭載された電子地図（一般的に流通し、地図情報が定期的に更新される仕組みを持つものに限る）で、乗客が入れた乗車地点と降車地点の間の推計走行距離を基に算定した距離制運賃に、地方運輸局長等が定めた係数を掛け、1 円単位を四捨五入する。乗客が最短距離・最短時間など 2 以上のルートから 1 つを選べること、有料道路の利用の有無を選べること、乗客と運転者に同じルート（または主要経由地点）を示せることを、アプリに求める（[国土交通省 自動車局長 通達「一般乗用旅客自動車運送事業の事前確定運賃に関する認可申請の取扱いについて」](https://www.mlit.go.jp/jidosha/content/001617012.pdf)、平成 31 年 4 月 26 日、令和 5 年 6 月 27 日一部改正） | 7 節 |

いずれも 2026-09-27 に確認。

## 3. 構成

```
dispatch ─┐                          ┌─ Valhalla（ETA 用、taxi、タイルのバージョン N）× 複数タスク
乗客の API ┼─▶ eta-service（Go）──────┤
Trips ────┘   補正の表・代わりの概算   └─ Valhalla（当てはめ用。location-ingestion の 8 節）

Pricing ──▶ fare-distance（TypeScript）──▶ 商用の地図の提供者（法務の確認が済んだもの）
```

- `eta-service` は、Valhalla の前に立つ薄い層である。要求の形をそろえ、補正を足し、タイルのバージョンと ETA の出どころを応答に付ける。Valhalla の障害のときは概算を返す。
- 推計走行距離（`fare-distance`）は、ETA と別の経路にする。2 つの経路のエンジンの距離を混ぜない（ADR-0005）。

## 4. ETA の種類と求め方

| 種類 | 使う人 | 求め方 | 量（S1 のピーク） |
| --- | --- | --- | --- |
| 配車の行列 | dispatch | 4.1 節 | 受け付けた依頼 30 回/秒（1 回 10 組。未割り当ての依頼はバッチごとに計算し直す） |
| 受諾の時点の迎車の ETA | 乗客に表示、精度の計測 | 4.2 節 | 受諾の数（成立 約 3〜6 回/秒。[capacity.md](capacity.md) の 1.1 節） |
| 迎車中・乗車中の更新 | 乗客・ドライバーに表示 | 4.3 節 | 数百回/秒 |
| 依頼の前の目安 | 乗客（依頼の画面） | 4.4 節 | 数百回/秒 |

### 4.1 配車の行列

- 依頼ごとに、候補（最大 10 人）から乗車地への **many-to-one** の `sources_to_targets` を 1 回呼ぶ。同じバッチの依頼は並列に呼ぶ。
- 多対多（候補の和集合 × バッチの全依頼）にまとめない。組の数が 60 × 600 ＝ 36,000 になり、上限（既定 2,500）を超え、使わない組を計算する。
- `date_time` は出発の時刻（`type=1`、今の時刻）にし、予測の交通を使う（5.4 節）。
- 期限は 400 ms。間に合わない組は、**直線の距離からの概算**にする：`eta = 直線の距離 × 1.4 ÷ 時速 18 km ＋ 60 秒`（係数は東京の実績で E4 の `eta-bias-correction` に見直す。**未検証**の仮の値）。概算の組は `eta_source=fallback` を付ける。
- 補正（4.5 節）は、配車の行列にも同じように足す。配車が比べるのは、同じ補正を足した値どうしである。

### 4.2 受諾の時点の迎車の ETA

- 受諾のときに、ドライバーの位置から乗車地への `route`（1 対 1）を求め直し、補正を足した値を、乗客に表示する迎車の ETA とする。
- この値を `trip_eta_snapshots` に `kind=pickup_at_accept` で保存する。NFR-003 の計測の「予測」はこの値である（6 節）。
- 配車の行列の値ではなく求め直すのは、バッチから受諾までの間（最大 16.5 秒）にドライバーが動くため。

### 4.3 迎車中・乗車中の更新

- 迎車中は 15 秒ごと、乗車中は 60 秒ごとに、最新の位置（索引の `GetDriverLocation`。[geospatial-index.md](geospatial-index.md) の 6.5 節）から求め直す。大きく変わった（±60 秒以上）ときだけ、乗客のアプリに送る（配信は `notifications-and-realtime-push.md`）。
- 乗車中の ETA は、降車地がある依頼だけ。NFR の対象ではないが、誤差を 6 節と同じ方法で記録する。

### 4.4 依頼の前の目安

- 乗車地の近くの空車を `FindNearby`（[geospatial-index.md](geospatial-index.md) の 6.1 節、`limit` 3）で取り、many-to-one の行列で求めた最小の値に補正を足し、1 分単位に丸めて「約 N 分」と出す。
- 同じ `street` のセル・同じ商品の結果を 15 秒キャッシュする。
- 目安は約束ではない。受諾の時点の値（4.2 節）とは別のものとして、画面の文言を分ける（`rider-and-driver-apps.md`）。

### 4.5 補正（S1）

```
eta = route_time + pickup_overhead(point_type) + bias(district_cell(pickup), hour_of_week)
```

| 項 | 中身 |
| --- | --- |
| `route_time` | Valhalla の経路の時間（予測の交通つき） |
| `pickup_overhead` | 乗車地の種類ごとの固定の時間。道路の脇 30 秒、乗降の地点（ホテルの車寄せ、駅の配車の乗り場）60 秒。値は乗降の地点のデータ（[maps-and-geodata.md](maps-and-geodata.md) の 8 節）に持つ |
| `bias` | `district` のセル × 1 週の 1 時間ごと（168）の、直近 28 日の残差（実際 − 予測）の中央値。1 つの区切りに 30 件未満なら、`metro` の親のセル、次に都市全体の値を使う。±120 秒に丸める。毎日作り直す |

- 補正の表はバージョンつきで、`eta-service` はバージョンを応答に付ける。
- 本家と同じ機械学習の補正（残差の予測）は、S1 の計測で NFR-003 に届かなければ前倒しする（`ml-platform.md`）。

## 5. Valhalla の運用

### 5.1 costing

- `costing=taxi`（タクシーの通れる車線を優先する）。ただし、OSM の日本のデータでは、`taxi` のタグを持つ way は 897、`taxi:lanes` は 7 しかない（[taginfo の日本](https://taginfo.geofabrik.de/asia:japan/)、2026-09-26 のデータ、2026-09-27 に確認）。実際は `auto` とほぼ同じ経路になると見込み、差は E4 の黄金の経路の検査で見る。
- 既定の `costing_options.taxi`：`use_tolls` 0.5（配車・ETA は有料道路の有無を決めない）、`use_highways` 0.5、`top_speed` 120。
- 事前確定運賃の距離には Valhalla を使わない（7 節）。

### 5.2 タイルの作成

```
週 1 回（月曜 03:00 JST）、または地図の緊急の直しのとき
  1. Geofabrik の日本の抽出（japan-latest.osm.pbf）を S3 の osm/japan/<date>/ から取る（maps-and-geodata の 4 節）
  2. valhalla_build_admins、valhalla_build_timezones（左側通行・国の規則のため）
  3. valhalla_build_tiles
  4. valhalla_ways_to_edges で OSM の way と Valhalla の辺の対応を作る
  5. 速度の表（8 節）を辺に対応させた CSV にし、valhalla_add_predicted_traffic で入れる
  6. 閉鎖などの上書き（maps-and-geodata の 6 節）を適用する
  7. valhalla_build_extract で 1 つの tar にし、S3 の valhalla/tiles/<tile_version>/ に置く
  8. 検査（下）
```

- 手順は Valhalla の Building の文書の手順（[building.md](https://github.com/valhalla/valhalla/blob/master/docs/docs/start/building.md)、2026-09-27 に確認）に、速度の表と上書きを足したもの。
- `tile_version` は `<osm_date>-<speed_table_version>-<overrides_version>` にする。ETA・距離の応答と、配車の判断の記録に残す。
- **検査**（すべて通ったら切り替えてよい）：
  1. 黄金の経路の集合（東京の 2,000 組。合成の乗降の組と、地図の誤りを直した場所）の距離と時間を、前のバージョンと比べる。距離が 20% 以上変わった組が 1% を超えたら止める。
  2. 到達できない組が前のバージョンより増えていない。
  3. 主要な駅・空港の乗車地から、半径 5 km の 100 点へ経路がある。
  4. 直近 7 日の受諾の後の迎車（`spot` に丸めた記録）で、新しいバージョンの ETA の誤差の中央値が前のバージョンより 5 秒以上悪くない（6 節の再計算）。

### 5.3 配置と切り替え

- ETA 用の Valhalla は ECS Fargate のタスクで動かす。起動のときに S3 から tar をタスクの一時の記憶域に取り、読み込む。日本全体のタイルの大きさと、必要なメモリ・起動の時間は **未検証**（E4 の `valhalla-pool-fargate` で計る。日本の OSM の抽出は約 2.5 GB（[Geofabrik](https://download.geofabrik.de/asia/japan.html)、2026-09-27 のバージョンで 2,537,341,328 バイト））。
- **青緑の切り替え**：新しいバージョンのタスクの組を立ち上げ、本番の要求の写しを 1 時間流して応答の時間と差を比べ、`eta-service` の宛先を切り替える。古い組は 24 時間残し、戻せるようにする。
- 当てはめ用の組は別に置き、同じバージョンを少し遅れて使う。

### 5.4 上限と時刻に依る行列

| 設定 | 値 | 理由 |
| --- | --- | --- |
| `service_limits.taxi.max_matrix_location_pairs` | 2,500（既定） | many-to-one の 10 組には十分 |
| `service_limits.taxi.max_matrix_distance` | 100 km | 迎車・乗車の距離に合わせて既定（400 km）より狭める |
| `max_timedep_distance_matrix` | 30 km（既定 0 から変える） | 予測の交通を行列でも使うため |

- 時刻に依る行列は、出発の時刻を sources に付けると、正確だが遅い `timedistancematrix` が既定になる。`prioritize_bidirectional: true` で速い `costmatrix` を選べる（[Matrix API](https://github.com/valhalla/valhalla/blob/master/docs/docs/api/matrix.md)）。ただし、sources が targets より多い要求では、sources に時刻を付けられない。付けられるのは、targets が sources より少ないときの targets の到着の時刻（`date_time.type = 2`）だけである（同じ文書の Time-dependent matrices、2026-09-27 に確認）。配車の行列は many-to-one（ドライバーが sources、乗車地が target）なので、(a) は「乗車地への到着の時刻＝今 ＋ 迎車の ETA の見込み」を target に付ける形になる。E4 の `timedep-matrix-poc` で、(a) この形の時刻に依る行列、(b) 時刻に依らない行列 ＋ 補正の表、の精度と p99 を比べて決める（**未検証**）。決まるまでの既定は (b)。
- ETA の要求の期限は、Valhalla の中の処理に対して 300 ms（配車の 400 ms の中）。

## 6. ETA の精度の計測（NFR-003）

| 項目 | 定義 |
| --- | --- |
| 対象 | `accepted` から `arrived` に進んだ乗車。受諾の後の取り消し、到着の判定ができない乗車は除き、件数を別に数える |
| 予測 `P` | 受諾の時点に乗客に表示した迎車の ETA（4.2 節の `pickup_at_accept`） |
| 実際 `A` | `arrived` の時刻 − `accepted` の時刻 |
| 到着の時刻 | ドライバーの「到着」の操作の時刻。ただし、そのときの位置が乗車地から 100 m より遠ければ、軌跡（[location-ingestion.md](location-ingestion.md) の 7 節の乗車の軌跡）で乗車地から 50 m 以内に入り、時速 5 km 未満になった最初の時刻を使う。どちらも得られなければ「判定できない」 |
| 誤差 | `e = A − P`（正は遅れ） |
| 指標 | `|e|` の中央値（目標 60 秒以内）と p90（180 秒以内）。`e` の中央値（偏り）。都市・時間帯・迎車の距離の帯（0〜1 km、1〜3 km、3 km〜）・タイルのバージョンごと |

- 毎日の集計の仕事で計り、quality.md の指標にする。時間帯ごとの偏りは、補正の表（4.5 節）の作り直しに使う。
- 早すぎる到着（`e` が負）と遅れは、利用者への影響が違う。本家は非対称の損失を使う（DeepETA）。S1 の目標は絶対値で置くが、偏りの符号も必ず出す。
- ドライバーごとに `e` の系統的な正の偏り（遅れ）が続くときは、位置の偽装や、流しの押し忘れの兆しとして集計する（[location-ingestion.md](location-ingestion.md) の 13 節）。
- **オフラインの評価**：タイルのバージョン・補正の表を変える前に、直近 7 日の対象の乗車で、新しい ETA を求め直して同じ指標を出す（5.2 節の検査の 4）。

## 7. 推計走行距離（事前確定運賃）

### 7.1 制度の要件と API

2 節の通達の要件を、API の形で守る。

```proto
service FareDistance {
  rpc Estimate(FareDistanceRequest) returns (FareDistanceResponse);
}

message FareDistanceRequest {
  LatLng pickup = 1;          // 乗客が入れた乗車地点（ピンか住所の検索の結果）
  LatLng dropoff = 2;
  TollPreference toll = 3;    // USE_TOLLS / AVOID_TOLLS（乗客が選ぶ。要件 ④）
  int64 departure_time_ms = 4;
  string idempotency_key = 5;
}

message FareDistanceResponse {
  string quote_id = 1;
  repeated RouteOption options = 2;  // 最短距離と最短時間の 2 つ以上（要件 ②）
  string provider = 3;               // 法務の確認が済んだ提供者の ID
  string provider_map_version = 4;
  int64 computed_at_ms = 5;
  int64 expires_at_ms = 6;           // 見積もりの有効の期限（既定 10 分）
}

message RouteOption {
  string option_id = 1;
  RouteKind kind = 2;                // SHORTEST_DISTANCE / FASTEST
  uint32 distance_m = 3;             // 推計走行距離（整数、m）
  uint32 duration_s = 4;
  bool uses_tolls = 5;
  repeated Waypoint major_waypoints = 6;  // 主要経由地点（幹線道路、交差点、有料道路の出入口）
  bytes display_polyline = 7;        // 表示用。保存は 7.3 節の条件で
}
```

| 通達の要件 | この設計 |
| --- | --- |
| 一般的に流通し、定期的に更新される電子地図 | 法務の確認（L3）が済んだ提供者だけを `provider` に登録する。OSM（Valhalla）は、確認が済むまで登録しない |
| 推計走行距離を基に算定、係数、1 円単位の四捨五入 | 距離を m の整数で返す。運賃の計算は Pricing（`pricing-and-fares.md`） |
| 2 以上のルートから 1 つを選べる | `options` に最短距離と最短時間を必ず含める。1 つしか得られなければ、事前確定運賃を出さない |
| 有料道路の利用の有無を選べる | `toll` を必須にする |
| 乗客と運転者に同じルートか主要経由地点を示す | 乗客が選んだ `option_id` を乗車に保存し、ドライバーのアプリに同じ `major_waypoints` と表示用の線を渡す |
| 運転者は原則ルートを逸脱しない | 乗車の軌跡の当てはめ（[location-ingestion.md](location-ingestion.md) の 8 節）で、選んだルートからの逸脱の距離を記録する。大きな逸脱は運用の指標にする |

- ドライバーのナビは外部のアプリに引き継ぐ（ADR-0005）。行き先だけを渡すと、外部のナビが別のルートを選び、要件の「示したルートを逸脱しない」と合わなくなる。外部のナビに主要経由地点を経由地として渡す（`rider-and-driver-apps.md` への申し送り）。

### 7.2 提供者と障害

- 提供者は、住所の検索と同じ PoC（[maps-and-geodata.md](maps-and-geodata.md) の 7 節）で選ぶ。経路の API の条件（2 つ以上のルート、有料道路の回避、主要経由地点の取り出し）も PoC の基準に入れる。
- 提供者が答えない・遅い（期限 1.5 秒）ときは、**事前確定運賃を出さない**。メーターの運賃の依頼だけを受ける。日本版ライドシェアは事前確定運賃が要る（[dispatch-and-matching.md](dispatch-and-matching.md) の 5 節の E1）ので、その間は日本版ライドシェアの車を配車しない。Valhalla の距離で代えない。

### 7.3 保存

| 保存するもの | 期間 | 理由 |
| --- | --- | --- |
| `quote_id`、選んだ `option_id`、`distance_m`、`duration_s`、`uses_tolls`、`provider`、`provider_map_version`、`computed_at` | 乗車の記録と同じ（運賃の記録の保存の期間。`pricing-and-fares.md`） | 運賃の根拠。問い合わせと運輸局への説明 |
| `major_waypoints` の名前（道路の名前、交差点の名前） | 同上 | 乗客とドライバーに示したルートの記録 |
| 表示用の線（緯度経度の列） | 提供者の条件の期間（例：Google の Directions API の緯度経度は 30 日まで） | 提供者の条件に従う |

- Google Maps Platform の条件では、Directions API・Distance Matrix API の内容を Google 以外の地図と一緒に使ってはならず、Directions API の緯度経度のキャッシュは 30 日まで（[Google Maps Platform Service Specific Terms](https://cloud.google.com/maps-platform/terms/maps-service-terms) の 4.2・4.3・5.2、2026-09-27 に確認）。乗客のアプリの地図が Google 以外なら、Google の経路の線を重ねて見せられない。
- 距離と経由地点の名前を運賃の根拠として長く保存してよいか、提供者ごとの条件で認められるかは、法務の確認待ち（L3）。

## 8. 速度の表（交通の反映）

- **元**：`speed-samples`（[location-ingestion.md](location-ingestion.md) の 7・8 節）。当てはめた走行の、道路の区間（OSM の way と向き）ごとの通過の速度。乗降の停車（乗車地・降車地の 50 m 以内）と、休憩中の走行は除く。
- **集計**：直近 8 週の標本を、way × 向き × 1 週の 5 分ごと（2,016 の区切り）に集め、中央値を取る。
  - 1 つの区切りに 5 件未満、または異なるドライバーが 3 人未満なら、その区切りの値を使わない。1 時間ごと → 平日・休日の昼・夜 → OSM の既定の速度の順に埋める。
  - 夜（0〜5 時）の中央値を `freeflow_speed`、昼（7〜19 時）の中央値を `constrained_speed` にする。
- **形式**：Valhalla の予測の交通の CSV（`edge_id,freeflow_speed,constrained_speed,historical_speeds`。`historical_speeds` は 2,016 の値を DCT-II で圧縮して符号化したもの）。タイルの作成の 4・5（5.2 節）で入れる。
- **プライバシー**：速度の表は、ドライバーの ID を持たない。上の「異なるドライバーが 3 人未満の区切りは使わない」で、1 人の走行が表から読み取れないようにする。
- **現在の交通**：S1 では入れない。Valhalla は現在の交通の上書き（タイルと同じ階層の別のファイル）を読める（[Speeds](https://github.com/valhalla/valhalla/blob/master/docs/docs/concepts/speeds.md)）。自前の直近 10 分の走行から作るか、商用の交通の情報を入れるかは、S1 の計測の後に決める（ADR-0005 の PoC）。
- OSM に自前の速度を足したデータベースを外に出すと、ODbL の派生データベースの扱いが問題になりうる（[maps-and-geodata.md](maps-and-geodata.md) の 5 節）。

## 9. 障害のときの振る舞い

| 障害 | 起きること | 回復・影響の抑え方 |
| --- | --- | --- |
| Valhalla の一部のタスクが落ちた | 一部の要求が失敗 | `eta-service` が別のタスクに送り直す（1 回） |
| Valhalla の全体が遅い・落ちた | 行列が揃わない | 直線の距離の概算（4.1 節）。乗客の表示は「約」を付けた幅で出す。概算の率を警告にする |
| 新しいタイルのバージョンの不具合（道路の欠け） | 到達できない組、ETA の急な悪化 | 5.2 節の検査で止める。すり抜けたら古い組へ戻す（24 時間残す） |
| 補正の表が作れない（集計の仕事の失敗） | 補正が古い | 前のバージョンを使い続ける。3 日古くなったら警告 |
| 推計走行距離の提供者の障害 | 事前確定運賃を出せない | 7.2 節。メーターの運賃だけ受け、日本版ライドシェアの配車を止める |
| 提供者の料金の上限・割り当ての超過 | 同上 | 利用の量を 1 日ごとに計り、80% で警告 |

## 10. セキュリティと位置のプライバシー

- `eta-service` と `fare-distance` は内部の API だけ。乗客のアプリからの要求は、乗客の API を通し、乗客の依頼に関わる地点（自分の乗車地・降車地）だけを受ける。
- ETA の要求の緯度経度をログに書かない（`block` のセルまで）。Valhalla のアクセスログは切り、エラーのログから座標を除く設定にする（Valhalla のログに座標が出るかは **未検証**。E4 の `valhalla-serving` と E3 の `location-log-lint` で確かめる）。
- 商用の提供者に送るのは、乗車地・降車地の座標と時刻だけ。乗客の ID・電話番号を送らない。外国の提供者に位置を送ることの扱いは、法務の確認待ち（L4）。
- 速度の表と補正の表は、ドライバーの ID を持たない集計だけ。

## 11. テスト

### 11.1 性質ベーステスト

- **PROP-ETA-001（概算の単調性）**：直線の距離の概算は、距離に対して単調に増える。どの組でも 0 以上。
- **PROP-ETA-002（補正の範囲）**：任意の残差の分布で、補正の値は ±120 秒の中にあり、30 件未満の区切りは親の値を使う。
- **PROP-ETA-003（推計走行距離の要件）**：任意の応答で、`options` に `SHORTEST_DISTANCE` と `FASTEST` が含まれ、`distance_m` は正の整数、`provider` は登録済みの提供者である。条件を満たさない応答から、事前確定運賃の見積もりが作られない。
- **PROP-ETA-004（距離を混ぜない）**：事前確定運賃の見積もりの `distance_m` は、`fare-distance` の応答からだけ来る（型を分け、Valhalla の距離の型から変換できないようにする）。
- **PROP-ETA-005（精度の定義）**：任意の乗車の事象の列で、6 節の集計の対象・除外・到着の時刻の選び方が定義のとおりになる（到着の操作の位置が 100 m より遠いときに軌跡の時刻を使う、など）。

### 11.2 結合・負荷

- E4 の PoC：東京の乗降の組（合成または匿名化して丸めたもの）で、Valhalla（時刻に依る行列と依らない行列）と商用の提供者の ETA・距離を比べ、NFR-003 に届くかを記録する（ADR-0005 の Confirmation）。
- 負荷：S1 のピークの 2 倍（行列 60 回/秒、表示の更新 1,000 回/秒）で、Valhalla の p99 と必要なタスクの数を計る。
- タイルの作成の手順を CI で小さな地域（東京の一部の抽出）について毎回流し、5.2 節の検査が動くことを確かめる。

## 12. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E4 | `valhalla-tile-pipeline` | 5.2 節のタイルの作成と検査、`tile_version` |
| E4 | `valhalla-serving` | 5.3 節の配置、青緑の切り替え、5.4 節の設定 |
| E4 | `eta-service` | 4.1〜4.4 節、概算、キャッシュ、バージョンの付与 |
| E4 | `eta-bias-correction` | 4.5 節の補正の表と毎日の作り直し（PROP-ETA-002） |
| E4 | `eta-accuracy-metrics` | 6 節の計測の仕事と指標（PROP-ETA-005） |
| E4 | `speed-profile-builder` | 8 節の速度の表と CSV |
| E4 | `timedep-matrix-poc` | 5.4 節の (a)・(b) の比べ |
| E4 | `fare-distance-api` | 7.1 節の API と要件（PROP-ETA-003・004） |
| E4 | `fare-distance-provider-adapter` | 7.2 節の提供者の接続と障害のときの扱い |
| E7 | `pre-fixed-fare-route-record` | 7.3 節の保存（pricing の領域と一緒に） |
| E9 | `nav-handoff-waypoints` | 主要経由地点を外部のナビに渡す（apps の領域と一緒に） |
| E6 | `trip-route-deviation` | 選んだルートからの逸脱の記録 |

## 13. 未解決の問い

### 決定（2026-09-27、既定案）

- **costing**：`taxi`。
- **配車の行列**：依頼ごとの many-to-one、期限 400 ms、概算は `直線 × 1.4 ÷ 18 km/h ＋ 60 秒`。
- **補正**：`district` × 1 時間の 168 区切りの中央値の残差、±120 秒、毎日。
- **タイル**：週 1 回、黄金の経路の集合の検査、青緑、古い組を 24 時間残す。
- **時刻に依る行列**：E4 の PoC までは使わない（時刻に依らない行列 ＋ 補正の表）。
- **速度の表**：直近 8 週、5 分 × 1 週、5 件以上かつ異なるドライバー 3 人以上。
- **精度の計測**：6 節の定義。
- **推計走行距離**：商用の提供者だけ、障害のときは事前確定運賃を出さない、表示用の線は提供者の条件の期間だけ。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| OSM（Valhalla）が事前確定運賃の電子地図の要件を満たすか | 法務と運輸局の確認待ち（L3） |
| 推計走行距離と経由地点の名前を、運賃の根拠として長く保存してよいか（提供者の条件） | 法務の確認待ち（L3）と、提供者の契約 |
| 時刻に依る行列を使うか | E4 の PoC |
| 現在の交通を入れるか（自前の直近の走行か、商用か） | S1 の精度の計測の後 |
| 機械学習の補正を前倒しするか | S1 で NFR-003 に届くか |
| Valhalla の日本全体のタイルの大きさ・メモリ・起動の時間 | E4 で計る |

## 14. quality.md・runbooks・data-model への項目

### quality.md

- NFR-003：迎車の ETA の誤差の中央値・p90・偏り（6 節の定義）。都市・時間帯・距離の帯・タイルのバージョンごと。判定できない乗車の率。
- 乗車中の ETA の誤差（NFR の対象外。記録だけ）。
- 概算（fallback）の率、Valhalla の p99、タイルのバージョンの切り替えの前後の差。
- 推計走行距離の提供者の失敗の率、事前確定運賃を出せなかった時間。
- 選んだルートからの逸脱の距離の分布。
- PROP-ETA-001〜005 の実行の数と種。

### runbooks

- `valhalla-tile-rollout.md`：タイルのバージョンの作成・検査・青緑の切り替え・戻し方。検査で止まったときの確かめ方。
- `eta-accuracy-regression.md`：ETA の誤差が悪化したときの確かめ方（タイルのバージョン、補正の表、地図の誤り、交通の変化、特定の地域）と戻し方。
- `fare-distance-provider-outage.md`：推計走行距離の提供者の障害で事前確定運賃を止めるときの手順と、日本版ライドシェアの配車を止める連絡。
- `valhalla-capacity.md`：Valhalla の遅れのときのタスクの追加と、行列の期限の調整。

### data-model（索引への追加の提案）

| 置き場所 | 中身 |
| --- | --- |
| Aurora（Trips）`trip_eta_snapshots`（`trip_id`、`kind`（pickup_at_accept・pickup_update・dropoff）、`eta_s`、`eta_source`、`tile_version`、`correction_version`、`computed_at`） | 4.2・4.3・6 節 |
| Aurora（Pricing）`fare_distance_quotes`（`quote_id` PK、`options`（JSON：distance_m・duration_s・uses_tolls・major_waypoints の名前）、`provider`、`provider_map_version`、`computed_at`、`expires_at`、`chosen_option_id`、`polyline_expires_at`） | 7.3 節（表の持ち主は `pricing-and-fares.md` と調整） |
| S3 `valhalla/tiles/<tile_version>/` | 5.2 節 |
| S3 `eta/bias-tables/<version>.parquet`（`district_cell`、`hour_of_week`、`bias_s`、`n`） | 4.5 節 |
| S3 `eta/speed-profiles/<version>/`（Valhalla の CSV） | 8 節 |
| S3 `eta/golden-routes/<version>.parquet` | 5.2 節の検査の組 |
| S3 `eta/accuracy/dt=/`（乗車ごとの `P`・`A`・`e`、ID は乗車の ID だけ） | 6 節 |

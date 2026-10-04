---
status: accepted
date: 2026-09-27
---

# ADR-0005: 経路と ETA は OSM の上の Valhalla を自前で動かし、住所の検索と事前確定運賃の距離は商用の提供者を使う

## Context

地図と経路は、次の用途で使う。量と条件がそれぞれ違う。

| 用途 | 量（S1 のピーク） | 条件 |
| --- | --- | --- |
| 配車のバッチの ETA の行列（候補 × 依頼） | 受け付けた依頼 30 件/秒 × 候補 10 人 ＝ 300 組/秒 | 速さ（1 回のバッチで数十 ms）。料金が量に比例すると高い |
| 乗客に見せる迎車・乗車の ETA、車の到着の更新 | 数百件/秒 | 精度（NFR-003） |
| 位置の軌跡の道路への当てはめ | 2,500 件/秒の位置 | 量が多い。遅れてよい |
| 住所・施設・建物の名前の検索（乗車地・降車地の入力） | 数十件/秒 | 日本の住所と建物の名前の網羅 |
| 事前確定運賃の推計走行距離 | 依頼の数 | 制度の条件に合う地図であること |
| ドライバーのナビ | — | 外部のナビのアプリに引き継ぐ |

事実（2026-09-27 に確認）：

- **事前確定運賃**は、配車アプリで入れた乗車地と降車地の間の推計走行距離をもとにした運賃に、地方運輸局の係数を掛ける（[国土交通省の報道発表](https://www.mlit.go.jp/report/press/jidosha03_hh_000302.html)）。使う電子地図は、一般的に流通し、地図情報が定期的に更新される仕組みを持つものに限られる。アプリは、2 つ以上のルートから乗客が 1 つを選べること、有料道路の利用の有無を選べること、乗客と運転者に同じルート（または主要経由地点）を示せることを求められる（[国土交通省 自動車局長 通達「一般乗用旅客自動車運送事業の事前確定運賃に関する認可申請の取扱いについて」](https://www.mlit.go.jp/jidosha/content/001617012.pdf)、令和 5 年 6 月 27 日一部改正。2026-09-27 に本文を確認。[eta-and-routing.md](../architecture/eta-and-routing.md) の 2 節）。
- **本家の ETA**は、道路を重みつきの辺の小さな区間に分けたグラフで経路のエンジンが求めた ETA に、実績との差を学習したモデル（DeepETA）で補正をかける。本家で最も QPS の高いモデルで、数ミリ秒で返す必要がある（[DeepETA](https://www.uber.com/us/en/blog/deepeta-how-uber-predicts-arrival-times/)、2022-02-10）。
- **Valhalla**：MIT ライセンス、C++。要求ごとに辺と頂点のコストを変えられる（dynamic costing）。タイルの階層のデータ、時間と距離の行列、到達圏、軌跡の道路への当てはめ、過去の交通と現在の交通の事象の取り込みを持つ（[Valhalla](https://valhalla.github.io/valhalla/)）。時刻に依る行列は、既定の設定（`max_timedep_distance_matrix` 0）では使えず、設定の変更が要る（[Matrix API](https://github.com/valhalla/valhalla/blob/master/docs/docs/api/matrix.md)、2026-09-27 に確認）。
- **OSRM**：BSD-2-Clause、C++。Contraction Hierarchies と Multi-Level Dijkstra。route・table（行列）・match（当てはめ）・trip などを持つ（[osrm-backend](https://github.com/Project-OSRM/osrm-backend)）。交通の速度の反映は、CH では再計算が重く、MLD の customize のほうが速い（[OSRM の Traffic の wiki](https://github.com/Project-OSRM/osrm-backend/wiki/Traffic)）。
- **GraphHopper**：Java。オープンソースに経路・当てはめ・到達圏があるが、行列の API は商用の側にある（[GraphHopper Open Source](https://www.graphhopper.com/open-source/)）。
- **Google Maps Platform**：Directions・Distance Matrix・Geocoding の内容を Google 以外の地図と一緒に使うことを禁じ、Directions の緯度経度のキャッシュは 30 日まで、Geocoding の緯度経度は 30 日までの一時のキャッシュか、利用者ごとに分けた保存に限る（[Google Maps Platform Service Specific Terms](https://cloud.google.com/maps-platform/terms/maps-service-terms)。2026-09-27 に本文を確認。[eta-and-routing.md](../architecture/eta-and-routing.md) の 7.3 節、[maps-and-geodata.md](../architecture/maps-and-geodata.md) の 2 節）。
- **Amazon Location Service**：データの提供者に Esri と HERE がある。以前のバージョンの API では、HERE を選ぶと、日本の場所の結果を保存（`IntendedUse` を `Storage`）できない（[DataSourceConfiguration（previous）](https://docs.aws.amazon.com/location/previous/APIReference/API_DataSourceConfiguration.html)）。現行のバージョン（Places V2）の文書は、日本の住所・施設の網羅を Comprehensive とし（[Data quality and coverage](https://docs.aws.amazon.com/location/latest/developerguide/data-quality.html)）、日本の結果の保存の制限を書いていない（[IntendedUse](https://docs.aws.amazon.com/location/latest/developerguide/places-intended-use.html)、どちらも 2026-09-27 に確認）。契約の上で日本の結果を保存してよいかは **未検証**（E4 の `geocoding-provider-poc` で提供者の条件として確かめる）。
- **ゼンリン**：ZENRIN Maps API で、住所・建物・施設の検索、経路の探索、渋滞・規制の情報を提供している（[ZENRIN Maps API](https://www.zenrin-datacom.net/solution/zenrin-maps-api)）。料金と、結果の保存・他の地図との併用の条件は公開の文書になく **未検証**（E4 の `geocoding-provider-poc`）。
- **Mapbox**：経路・行列・住所の検索の API を持つ。日本の住所の網羅と条件は **未検証**（E4 の `geocoding-provider-poc`）。

## Options

1. **すべて管理された API**（Google Maps Platform、Amazon Location Service、Mapbox、ゼンリンのどれか）
2. **経路・ETA・当てはめは自前（OSM の上のエンジン）。住所の検索と、制度の条件が要る距離は商用の提供者**
3. **すべて自前**（OSM の上のエンジンと、OSM の住所のデータ）

自前のエンジンの候補：Valhalla、OSRM、GraphHopper。

## Decision

2 を採用し、自前のエンジンは Valhalla にする。

- **配車の ETA の行列、乗客に見せる ETA、軌跡の当てはめは、自前の Valhalla で求める。**
  - 行列の量は、依頼 × 候補の数に比例し、S3 で数千組/秒になる。量に比例する料金の API では、費用が見通せない。
  - 要求ごとのコストの変更（車両の種類、右折の罰則、時間帯の速度）を、配車の側から試せる。
  - 行列と当てはめと交通の取り込みを、1 つのエンジンでまかなえる。
  - OSRM は行列の速さで勝る。ただし、コストの変更にデータの前処理のやり直しが要る。行列の速さが足りなければ、行列だけを OSRM（MLD）に替える選択を残す。
  - GraphHopper は、オープンソースの側に行列がない。
- **住所・施設・建物の名前の検索は、商用の提供者を使う。** 日本の住所（番地、建物の名前、施設）の網羅は、OSM では足りないと見込む（**未検証**。E4 の `geocoding-provider-poc` で乗降の地点の検索の成功率を比べる）。候補はゼンリン、Google、Amazon Location Service。PoC で、網羅、料金、結果の保存の条件、Valhalla の地図と併用してよいかを比べて決める。
  - Google を選ぶ場合、Google の内容を Google 以外の地図に重ねて見せることが条件に反しうる。乗客のアプリの地図の表示の提供者と合わせて決める。
- **事前確定運賃の推計走行距離は、制度の条件（一般に流通し、定期的に更新される電子地図）を満たすことが確かめられた地図で求める。** OSM がこれに当たるかは、法務と運輸局の確認待ち（[intent.md](../intent.md) の L3）。確認が済むまでは、商用の提供者の経路の距離を使う。
- **交通の反映**：S1 は、Valhalla の過去の速度のデータを、自前の走行の実績（当てはめた軌跡の区間ごとの速度）から作る。配車の行列で予測の交通を使うには、時刻に依る行列を有効にする Valhalla の設定の変更（`max_timedep_distance_matrix` を 0 から上げる）と、精度と p99 の PoC が要る。PoC（E4 の `timedep-matrix-poc`）までは、時刻に依らない行列に偏りの補正の表を足して使う（[ADR-0016](0016-valhalla-serving-traffic-and-eta-accuracy.md)、[eta-and-routing.md](../architecture/eta-and-routing.md) の 5.4 節）。現在の渋滞は、商用の提供者の交通の情報を取り込めるかを PoC で確かめる。精度は NFR-003 で測り、足りなければ本家の DeepETA と同じく、経路の ETA を実績で補正するモデルを ml-platform で作る。
- **ナビ**：ドライバーのアプリは、Google マップ・Apple のマップなどの外部のナビに引き継ぐ。事前確定運賃の乗車では、行き先に加えて、乗客が選んだルートの主要経由地点を経由地として渡し、経由地を守ると確かめた引き継ぎ先だけを使う（[ADR-0008](0008-navigation-handoff-with-waypoints.md)）。アプリ内のターンバイターンのナビは作らない（[intent.md](../intent.md) の Non-goals）。
- 1 は、立ち上げは速いが、行列の量に比例する費用と、結果の保存・併用の制限が、配車と再生の記録に合わない。
- 3 は、日本の住所の検索の品質と、事前確定運賃の地図の条件で、リスクが大きい。

## Consequences

- 良くなること：
  - 配車の熱い経路の ETA が、外部の API の遅れ・障害・料金に左右されない。
  - 再生のために ETA の入力と結果を記録しても、提供者の保存の制限にかからない。
- 引き受けるコスト：
  - OSM のデータの取り込み、タイルの作成、Valhalla の運用を自前で持つ（maps-and-geodata、infrastructure で扱う）。OSM は ODbL なので、帰属の表示と、派生のデータベースの扱いを確かめる。
  - 経路のエンジンが 2 つ（自前と商用）になり、同じ 2 点の距離が食い違いうる。乗客に見せる事前確定運賃の距離と、配車の ETA の距離は、別のものとして扱い、混ぜない。

## Confirmation

- E4 の PoC：東京の実際の乗降の組（合成または匿名化したもの）で、Valhalla の ETA・距離と商用の提供者の ETA・距離を比べ、NFR-003 に届くかを記録する。
- レビュー：事前確定運賃の計算が、法務の確認が済んだ地図の提供者以外の距離を使っていたら差し戻す。
- 商用の提供者の利用条件（保存、併用、帰属）を、選定の ADR に写し、条件に反する保存のコードをレビューで差し戻す。

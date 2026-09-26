# Decisions: Uber

Uber の再構築に関する決定。リポジトリ共通の決定は [docs/decisions/](../../../../docs/decisions/README.md) にある（本家の名前・接頭辞を使わない規則は、その ADR-0006）。領域ごとの設計と、各 ADR の位置づけは [architecture/](../architecture/README.md) を見る。

<!-- adr-index:start -->
| ADR | 決定 | 状態 |
| --- | --- | --- |
| [0001](0001-platform-and-stack.md) | 基盤は他の題材の決定を引き継ぎ、配車の熱い経路は Go で、モバイルはネイティブで書く | proposed |
| [0002](0002-h3-geospatial-model.md) | 地理の単位は H3 にし、ドライバーの索引はメモリの上で都市と H3 のセルで分ける | proposed |
| [0003](0003-trip-state-and-single-assignment.md) | 乗車の状態は Aurora の状態機械を正本にし、割り当ては fencing token つきのトランザクションで 1 つに限る | proposed |
| [0004](0004-batched-dispatch-and-offers.md) | 配車は区域ごとの短いバッチで最適化し、オファーは 1 人ずつ時間切れつきで送る | proposed |
| [0005](0005-maps-and-routing.md) | 経路と ETA は OSM の上の Valhalla を自前で動かし、住所の検索と事前確定運賃の距離は商用の提供者を使う | proposed |
<!-- adr-index:end -->

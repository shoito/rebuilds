# Architecture: Uber

全体像と横断的な方針。領域ごとの設計は、同じディレクトリに領域ごとのファイルとして置く。ファイルの一覧と ADR の番号の範囲は 8 節にある。品質は [quality.md](../quality.md)、Epic と Story は [roadmap.md](../roadmap.md)、SLO と運用は [runbooks/](../runbooks/README.md)、データの置き場所の索引は [data-model.md](data-model.md) にある。

## 1. 全体構成

```
乗客のアプリ ─┐                                     ┌─ ドライバーのアプリ
              │ HTTPS（API）・gRPC（常時の接続）      │ 位置（約 4 秒ごと、HTTPS）・gRPC（常時の接続）
              ▼                                     ▼
         API（api.<domain>）              位置の取り込み（Go、loc.<domain>）
              │                                     │ Kinesis loc-<city>
              │                                     ▼
              │                           地理空間の索引（Go、メモリ、都市×H3 で分割）
              │                                     ▲
              ▼                                     │ 候補の検索
     Trips（状態機械・割り当ての確定）◀── 割り当ての提案 ── 配車（Go、バッチのマッチング）
         │   │    │                                 │
         │   │    └──▶ Pricing（運賃の規則）          └──▶ ETA・経路（Valhalla ＋ 商用の地図）
         │   └──▶ Payments（外部の PSP）──▶ 事業者への精算
         └──▶ outbox ──▶ SNS・SQS ──▶ リアルタイムの配信（rt-router・rt-gateway（Go））──▶ 両方のアプリ
                                      車の位置（trip-location-fanout（Go））・プッシュ通知・SMS
事業者の管理画面（operator.<domain>）・サポートのツール（ops.<domain>）──▶ API
```

| コンポーネント | 責務 |
| --- | --- |
| API | 認証、入力の検証、レート制限、受け入れの上限。乗客・ドライバー・事業者・運用の窓口 |
| 位置の取り込み | ドライバーの位置を受け取り、検証し、索引と軌跡のストアへ流す |
| 地理空間の索引 | オンラインのドライバーの最新の位置と状態を、H3 のセルでメモリに持つ。正本ではない |
| 配車 | 区域ごとに 2 秒のバッチで、依頼とドライバーの組を最適化し、割り当てを Trips に提案する |
| ETA・経路 | 迎車と乗車の ETA、多対一の ETA の行列、推計走行距離 |
| Trips | 乗車の状態機械の正本。割り当ての確定、オファーの時間切れ、取り消し、提案の時の条件の確かめ直し |
| Pricing | 地域と事業者の運賃の規則で、運賃の目安、事前確定運賃、変動運賃を計算する |
| Payments | 外部の PSP での与信と売上の確定、返金。事業者への精算と照合 |
| リアルタイムの配信 | gRPC の双方向ストリームで状態の変化とオファーと車の位置を届ける。届かないときはプッシュ通知 |
| 安全 | 緊急の入口（端末だけで動く）、運用への知らせ、乗車の共有、番号を隠した通話、評価 |

原則は 5 つ。

- **割り当ての正本は Trips の DB。** 配車と索引はメモリの上で速く考えるが、割り当ては Trips が fencing token（`(region_gen, assignment_epoch)`）つきのトランザクションで確定する（[ADR-0003](../decisions/0003-trip-state-and-single-assignment.md)、[ADR-0021](../decisions/0021-trip-transition-function-and-assignment-fencing.md)、[ADR-0039](../decisions/0039-city-cells-and-osaka-warm-standby.md)）。
- **位置は流れ、状態は残す。** 位置は失ってよい流れ（次の 4 秒で上書きされる）として扱い、乗車の状態は失わない正本として扱う（[ADR-0002](../decisions/0002-h3-geospatial-model.md)、[ADR-0003](../decisions/0003-trip-state-and-single-assignment.md)）。
- **運賃の規則はデータ。** 地域・事業者・有効期間つきの規則を版で持ち、計算はその版を引数に取る純粋な関数にする（[ADR-0018](../decisions/0018-versioned-fare-rules-and-integer-yen.md)）。
- **配車は再生できる。** 配車の入力（依頼、位置、ETA、乱数の種）を記録し、同じ入力から同じ判断を再現できるようにする（[ADR-0004](../decisions/0004-batched-dispatch-and-offers.md)、[ADR-0015](../decisions/0015-offer-protocol-decision-log-and-replay.md)）。
- **法務の確認待ちは仕組みで止める。** 法務の確認待ちの経路は legal のフラグの裏に置き、法務の結論の記録がないと本番で有効にできない。緊急の入口はどのフラグでも止まらない（[ADR-0043](../decisions/0043-flag-taxonomy-legal-gates-and-safety-defaults.md)）。

本家の構成との対応（出典の確認は 2026-09-27）：本家は 2014 年の構成で、配車を供給・需要・DISCO（配車の最適化）・地理の索引に分け、Ringpop（一貫ハッシュとゴシップ）でアプリケーションの層を分割していた（[How Uber Scales Their Real-time Market Platform](http://highscalability.com/blog/2015/9/14/how-uber-scales-their-real-time-market-platform.html)、2015）。その後、乗車などの状態を持つ Fulfillment の基盤を、可用性を優先した構成（last-write-wins）から、Spanner の強い一貫性のトランザクションと階層的な状態機械（statechart）へ作り直した（[Uber's Fulfillment Platform: Ground-up Re-architecture](https://www.uber.com/us/en/blog/fulfillment-platform-rearchitecture/)、2021-07）。この設計は、後者の教訓（状態は強い一貫性で、1 つの遷移の仕組みで持つ）を S1 から採る。

## 2. 規模の段階

規模の数値は設計の仮定で、提携先の車両の数から見直す（[intent.md](../intent.md) の Open questions）。

| 段階 | 地域 | オンラインの車両（ピーク） | 位置の受信（ピーク） | 配車の依頼の受け付け（ピーク） | 構成 |
| --- | --- | --- | --- | --- | --- |
| S1（MVP） | 東京（特別区・武三交通圏） | 1 万台 | 2,500 件/秒 | 30 件/秒（成立は約 3〜6 件/秒） | 東京リージョン・3 AZ。索引と配車は都市ごとに 1 組（主と待機）。Aurora の writer 1 台＋reader |
| S2 | 日本版ライドシェアの大都市部の 12 地域（東京、横浜、名古屋、京都、札幌、仙台、さいたま、千葉、大阪、神戸、広島、福岡） | 5 万台 | 12,500 件/秒 | 150 件/秒 | 都市ごとに索引と配車の組を分ける。東京は H3 の親のセルでさらに分ける |
| S3 | 全国 | 20 万台 | 50,000 件/秒 | 600 件/秒 | 都市のまとまりごとのセル構成。大阪でも受ける active-active を検討する |

- 位置の受信は、オンラインの車両 × 4 秒に 1 回で見積もる。本家もドライバーが 4 秒ごとに位置を送ると説明している（上の High Scalability の記事）。
- **「配車の依頼の受け付け」は、ピークに受け付ける依頼の数で、成立しない依頼（取り消し、`no_driver_found`、選び直し）を含む。** 1 万台で 1 乗車（迎車 7 分＋乗車 20 分）に約 27 分かかるので、成立する乗車は約 3〜6 件/秒である。容量・Trips・PSP の見積もりは、量ごとにどちらを使うかを分けている（[capacity.md](capacity.md) の 1.1 節）。この定義は PM の確認事項（7 節）。
- S2 の 12 地域は、日本版ライドシェアで国土交通省がアプリのデータから不足の車両数を出した大都市部の地域に合わせた（[関東運輸局の資料](https://wwwtb.mlit.go.jp/kanto/content/000334295.pdf)、2026-09-27 に確認）。

## 3. 非機能要件

| ID | 項目 | S1 の目標 | 備考 |
| --- | --- | --- | --- |
| NFR-001 | 配車の判断の速さ | 依頼の受付から最初のオファーの送信まで p95 3 秒以内、p99 5 秒以内 | バッチの待ち（既定 2 秒）を含む（[ADR-0004](../decisions/0004-batched-dispatch-and-offers.md)） |
| NFR-002 | 位置の鮮度 | オンラインのドライバーは 4 秒ごとに送る。受信から索引への反映 p99 1 秒以内。最新の位置が 15 秒より古いドライバーは、配車の候補から外す | 通信が切れたドライバーへのオファーを避ける |
| NFR-003 | 迎車の ETA の精度 | 受諾の時点で表示した迎車の ETA と実際の到着の差の絶対値：中央値 60 秒以内、p90 180 秒以内 | 計測の定義は [eta-and-routing.md](eta-and-routing.md) の 6 節と [quality.md](../quality.md) |
| NFR-004 | 配車の可用性（都市ごと） | 月間 99.99%（依頼の受付と配車の判断が、5xx とタイムアウトなく行われた割合） | 都市ごとに測る。1 都市の障害を他の都市に広げない。SLI は `dispatch_intake`（99.99%）と `dispatch_decision`（99.9%） |
| NFR-005 | 割り当ての一意性 | 1 人のドライバーが同時に 2 つの有効な乗車に割り当てられる事象、1 つの乗車に 2 人が割り当てられる事象は 0 件 | [ADR-0003](../decisions/0003-trip-state-and-single-assignment.md)。リージョンの切り替えの後も含む |
| NFR-006 | 支払いの正しさ | 二重の請求 0 件。請求した額は確定した運賃と一致する。事業者への精算と PSP の入金の不一致は T+2 営業日までに 0 件 | Stripe の題材の考え方を引き継ぐ |
| NFR-007 | 乗車の耐久性と復旧 | 受け付けた依頼と始まった乗車の記録を失わない。AZ の障害は RPO 0・RTO 5 分以内。リージョンの障害は RPO 1 分以内・RTO 30 分以内 | 進行中の乗車は、ドライバーのアプリの要約と journal で戻す（[ADR-0022](../decisions/0022-trip-outbox-and-offline-continuation.md)、[ADR-0039](../decisions/0039-city-cells-and-osaka-warm-standby.md)） |
| NFR-008 | 状態の配信 | 乗車の状態の変化が相手のアプリに届くまで p95 2 秒以内。車の位置の表示の遅れ p95 6 秒以内 | 常時の接続が切れているときはプッシュ通知 |
| NFR-009 | 位置のプライバシー | 乗車の相手でない人に正確な位置が見える事象 0 件（**例外は下の 2 つだけ**）。生の軌跡の保持は法務の結論の期間まで（L4）。人が軌跡を見る操作は 100% 監査ログに残す | 例外 1：**乗車の共有**（乗客が自分で始め、乗車の終わりで止まる。`legal.l4.share_trip`）。例外 2：**事業者の稼働の地図**（運送の主体の事業者の運行管理に限り、見るたびに監査。`legal.l4.operator_fleet_map`）。どちらも L4 の結論が `legal_gate_records` にある範囲でだけ有効（[ADR-0043](../decisions/0043-flag-taxonomy-legal-gates-and-safety-defaults.md)） |
| NFR-010 | 安全の機能 | 緊急の入口の可用性 99.99%。通報から運用の担当が受けるまで p95 30 秒以内 | 110・119 への発信の案内は、端末の側だけで出す |

## 4. 技術スタック

| 層 | 選定 | 理由 |
| --- | --- | --- |
| 言語（一般） | TypeScript（API、Trips、Pricing、Payments、供給、管理画面、配信の振り分け） | 他の題材と同じ（[ADR-0001](../decisions/0001-platform-and-stack.md)） |
| 言語（熱い経路） | Go の 5 つのサービス：`loc-ingest`、`geo-index`、`dispatch`、`rt-gateway`、`trip-location-fanout`（付随の役：`trail-builder`、`dispatch-shadow`、`eta-service`） | メモリ上の状態と高い並行度を、単純な書き方で扱える（[ADR-0001](../decisions/0001-platform-and-stack.md)、[ADR-0030](../decisions/0030-realtime-grpc-bidirectional-stream-gateway.md)、[ADR-0038](../decisions/0038-compute-on-fargate-and-data-stores.md)） |
| サービス間の契約 | Protocol Buffers と gRPC（Go と TypeScript の間、アプリとの常時の接続） | 型を 1 か所から生成する |
| API | Hono＋Zod | 他の題材と同じ |
| モバイル | ネイティブ（Swift・Kotlin）。モデルとプロトコルは Protocol Buffers から生成し、状態機械はテストのベクターで揃える | 背景での位置の送信と電池の管理が要る（[ADR-0001](../decisions/0001-platform-and-stack.md)、[ADR-0006](../decisions/0006-native-apps-contracts-vectors-and-release-train.md)） |
| 地理 | H3（解像度 7・8・9。判断の記録は 10） | [ADR-0002](../decisions/0002-h3-geospatial-model.md) |
| DB | Aurora PostgreSQL 18 の `core`（乗車・供給・運賃・地図（PostGIS）・安全）と `money`（支払い・台帳） | [ADR-0038](../decisions/0038-compute-on-fargate-and-data-stores.md) |
| キャッシュ・一時の状態 | Valkey（ElastiCache）`rt` と `cache`。正本は置かない | ADR-0038 |
| 非同期 | transactional outbox → SNS → SQS。位置の流れは Kinesis Data Streams | [ADR-0022](../decisions/0022-trip-outbox-and-offline-continuation.md)、[ADR-0009](../decisions/0009-location-upload-and-validation.md) |
| 経路 | 自前で動かす Valhalla（OpenStreetMap）＋商用の地図・住所の提供者 | [ADR-0005](../decisions/0005-maps-and-routing.md) |
| 実行基盤 | AWS 東京（ECS Fargate の ARM64）、災害復旧は大阪のウォームスタンバイ | [ADR-0038](../decisions/0038-compute-on-fargate-and-data-stores.md)、[ADR-0039](../decisions/0039-city-cells-and-osaka-warm-standby.md) |
| 鍵 | KMS の 6 種類（`location`・`pii`・`biometric`・`money`・`audit`・`app`） | [ADR-0036](../decisions/0036-location-privacy-keys-retention-and-audited-access.md) |
| IaC | Terraform | 他の題材と同じ |
| 可観測性 | OpenTelemetry（ADOT）→ AMP、X-Ray、CloudWatch Logs | 他の題材と同じ（[ADR-0040](../decisions/0040-per-city-slis-and-slos.md)） |
| フラグ | AWS AppConfig。release・ops・legal の 3 種類。割り当ての単位は都市・事業者・交通圏・利用者 | [ADR-0043](../decisions/0043-flag-taxonomy-legal-gates-and-safety-defaults.md) |

## 5. 主な決定

どれも `accepted`（0001〜0005 と intent.md は、統合の工程の修正を当ててから 2026-09-27 に `proposed`・`draft` から改めた）。状態の一覧は [decisions/README.md](../decisions/README.md)。

| ADR | 決定 |
| --- | --- |
| [0001](../decisions/0001-platform-and-stack.md) | 基盤は他の題材の決定を引き継ぎ、熱い経路の 5 つのサービスは Go で、モバイルはネイティブで書く |
| [0002](../decisions/0002-h3-geospatial-model.md) | 地理の単位は H3 にし、ドライバーの索引はメモリの上で都市と H3 のセルで分ける |
| [0003](../decisions/0003-trip-state-and-single-assignment.md) | 乗車の状態は Aurora の状態機械を正本にし、割り当ては `(region_gen, assignment_epoch)` の fencing token つきのトランザクションで 1 つに限る |
| [0004](../decisions/0004-batched-dispatch-and-offers.md) | 配車は区域ごとの短いバッチで最適化し、オファーは 1 人ずつ、表示 15 秒・サーバーの期限 16.5 秒で送る |
| [0005](../decisions/0005-maps-and-routing.md) | 経路と ETA は OSM の上の Valhalla を自前で動かし、住所の検索と事前確定運賃の距離は商用の提供者を使う |
| [0006](../decisions/0006-native-apps-contracts-vectors-and-release-train.md) | アプリは Swift と Kotlin で書き、共有は生成した型と状態機械のテストのベクターに限る。週 1 回の列車、強制の更新は乗車の最中と緊急の入口を塞がない |
| [0007](../decisions/0007-driver-background-location-and-battery.md) | ドライバーのアプリは「使用中のみ」の許可で、出庫の間だけ背景で位置を取る。止まったら 60 秒で知らせる |
| [0008](../decisions/0008-navigation-handoff-with-waypoints.md) | 外部のナビには主要経由地点を経由地として渡し、守ると確かめた引き継ぎ先だけを事前確定運賃で使う |
| [0009](../decisions/0009-location-upload-and-validation.md) | 位置は HTTP/2 の POST で 4 秒ごとにまとめて送り、無状態の取り込みで検証して Kinesis に流す |
| [0010](../decisions/0010-location-trails-map-matching-and-retention.md) | 軌跡は保持の期間を持つストアに分け、当てはめは Valhalla で遅れて行う。ログは H3 に丸め、人が見る操作は監査する |
| [0011](../decisions/0011-geo-index-sharding-lease-and-rebuild.md) | 索引は都市と H3 の解像度 6 の集まりで分け、持ち主は DynamoDB のリースで決め、直近 35 秒から作り直す |
| [0012](../decisions/0012-geo-index-nearby-query-api.md) | 近くの空車の検索は輪を広げて外周までの距離で打ち切る。依頼の前の地図の車は丸めて返す |
| [0013](../decisions/0013-batch-assignment-solver.md) | バッチの割り当ては迎車の ETA を主にしたコストで最短増加路法で解き、300 ms を超えたら貪欲法 |
| [0014](../decisions/0014-dispatch-eligibility-and-street-hails.md) | 候補の条件は版つきのデータの純粋な関数で判定し、流しの実車（タクシーだけ）は索引から外す。日本版ライドシェアは承諾・事前確定運賃・運行枠の中だけ |
| [0015](../decisions/0015-offer-protocol-decision-log-and-replay.md) | オファーは表示 15 秒・サーバーの期限 16.5 秒、届かなければ 5 秒で取り下げ。判断は丸めた入力ごと記録し、再生・シミュレーション・影の実行で比べる |
| [0016](../decisions/0016-valhalla-serving-traffic-and-eta-accuracy.md) | Valhalla は taxi の costing と週 1 回の検査つきのタイル。ETA は経路の時間に偏りの補正を足し、受諾の時点の表示と実際の差で計る |
| [0017](../decisions/0017-fare-distance-for-pre-fixed-fares.md) | 事前確定運賃の推計走行距離は確認の済んだ商用の地図だけで求め、通達の要件を API で守る |
| [0018](../decisions/0018-versioned-fare-rules-and-integer-yen.md) | 運賃の規則は版つきのデータにし、円の整数と決めた段の丸めだけで計算する |
| [0019](../decisions/0019-meter-fare-sources.md) | メーターの運賃は車載のメーターか認定ソフトメーターから受け取り、連携がなければ入力を影の計算と照合する |
| [0020](../decisions/0020-dynamic-fares-within-authorized-bands.md) | 変動運賃と変動迎車料金は、事業者ごとの認可の幅の中で、事業者の時間帯の表で変える |
| [0021](../decisions/0021-trip-transition-function-and-assignment-fencing.md) | 遷移は 1 つの関数で行い、epoch を作成と解放で増やし、部分一意索引で有効な割り当てを 1 つに限る |
| [0022](../decisions/0022-trip-outbox-and-offline-continuation.md) | 乗車の事象は outbox から少なくとも 1 回配り、ドライバーのアプリは journal と署名つきの要約で通信が切れても乗車を続ける |
| [0023](../decisions/0023-psp-authorize-at-request-capture-at-end.md) | 依頼のときに与信し、乗車の終わりに売上を確定する。不足は追加の請求、結果不明のうちは次を送らない |
| [0024](../decisions/0024-fare-collection-model.md) | 運賃の受け取りは収納代行を既定、事業者を加盟店にする形を代わりに持ち、L6 まで本番で有効にしない |
| [0025](../decisions/0025-ledger-settlement-and-reconciliation.md) | 複式簿記の台帳で事業者の預り金を持ち、月 2 回の締めで精算し、3 者で照合する |
| [0026](../decisions/0026-supply-registry-and-document-verification.md) | 供給は事業者が登録し、この基盤が書類を確かめ、配車に出てよいかを出庫と提案の両方で確かめる |
| [0027](../decisions/0027-rideshare-operating-windows.md) | 日本版ライドシェアの運行枠は承認済みのデータにし、台数を出庫のトランザクションで守る |
| [0028](../decisions/0028-emergency-share-trip-and-incident-flow.md) | 緊急の入口は端末だけで 110・119 の画面を開き、運用へ知らせる。共有は乗車の終わりで止まるリンク。事故の報告は事業者を手伝う |
| [0029](../decisions/0029-masked-communications-identity-and-ratings.md) | 通話は自前の中継と 050 の番号で番号を隠す。顔の照合（1 日の最初の出庫と抜き打ち）と PIN、評価の低い組は二度と配車しない |
| [0030](../decisions/0030-realtime-grpc-bidirectional-stream-gateway.md) | アプリとの常時の接続は gRPC の双方向ストリーム 1 本にし、Go の rt-gateway で受ける |
| [0031](../decisions/0031-per-stream-sequence-redelivery-push-and-sms.md) | 配信は受け手ごとの seq と TTL で順序と送り直しを持ち、正しさは API の読み直し。届かなければプッシュ、SMS は限る |
| [0032](../decisions/0032-ops-console-roles-limits-change-requests-and-audit.md) | 運用のツールはロールと上限、理由つきの一時の権限、書き手と承認者を分ける変更の要求。閲覧と監査を毎日照合する |
| [0033](../decisions/0033-osm-import-and-service-area-polygons.md) | OSM は週 1 回の検査つきで取り込む。営業区域・交通圏は版つきの多角形にし、H3 の写しと多角形で判定する |
| [0034](../decisions/0034-geocoding-provider-and-pickup-points.md) | 住所の検索は自前の API の後ろに 1 社の提供者。乗降は乗客が確かめたピンだけを保存し、乗降の地点は運用が確かめたデータ |
| [0035](../decisions/0035-ml-feature-store-and-shadow-rollout.md) | 最初のモデルは勾配ブースティングで ETA を補正し、特徴量は 1 つのパイプラインで両方に書き、影の実行を経て展開する（S2） |
| [0036](../decisions/0036-location-privacy-keys-retention-and-audited-access.md) | 位置と個人の情報は 6 種類の KMS の鍵と保持の期間で分け、人が見る操作は理由・範囲・期限つきの許可と改ざんできない監査ログ |
| [0037](../decisions/0037-authentication-device-integrity-and-fraud-response.md) | 利用者の種類ごとに認証を分け、ドライバーは出庫のたびに端末の完全性を確かめる。不正の自動の処置は配車・特典から外すまで |
| [0038](../decisions/0038-compute-on-fargate-and-data-stores.md) | Go の熱い経路と Valhalla は Fargate（ARM64）。Aurora は `core` と `money`、リースの表はリージョンごと |
| [0039](../decisions/0039-city-cells-and-osaka-warm-standby.md) | 位置・索引・配車は都市ごとのセル。大阪は縮小したウォームスタンバイ。切り替えでは `region_gen` を上げ、進行中の乗車は端末から戻す |
| [0040](../decisions/0040-per-city-slis-and-slos.md) | SLO は都市ごとに事象で数える。不変条件は SLO にせず 1 件で呼び出す |
| [0041](../decisions/0041-load-model-admission-control-and-prescaling.md) | 負荷は平常のピーク × 場面の倍率。熱い経路は 2 倍を常に持ち、依頼は受け入れの上限で絞り、予定で前もって広げる |
| [0042](../decisions/0042-replay-and-shadow-gates-for-dispatch-and-pricing.md) | 配車と運賃の変更は、再生・シミュレーション・影の実行・`fare-replay` の関門を通し、都市の波で出す |
| [0043](../decisions/0043-flag-taxonomy-legal-gates-and-safety-defaults.md) | フラグは release・ops・legal。legal は `legal_gate_records` がないと本番で有効にできない。緊急の入口はフラグで止めない |

領域ごとの ADR は、8 節の番号の範囲で起票する。範囲を使い切ったら 0044 以降から振る。リポジトリ共通の決定（本家の名前・接頭辞・ドメインを使わない [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md) など）は、ルートの [docs/decisions/](../../../../docs/decisions/README.md) にある。

## 6. 主要フロー

### 6.1 配車の依頼から受諾まで

1. 乗客のアプリが、乗車地・降車地（乗客が確かめたピン）を送る。Pricing が運賃の目安（事前確定運賃なら確定の額）を返し、乗客が確かめて依頼する。
2. API が都市の受け入れの上限を確かめる（[ADR-0041](../decisions/0041-load-model-admission-control-and-prescaling.md)）。Trips が乗車を作る。アプリの決済なら `payment_pending` で与信を待ち、通れば `requested` にして配車のキューに入れる。
3. 配車が、区域の 2 秒のバッチの締めで、索引から候補を取り、ETA の行列を求め、候補の条件（E1〜E9）を当て、組を最適化する。
4. 配車が、組ごとに Trips へ割り当てを提案する。Trips は、ドライバーの `(region_gen, assignment_epoch)` と供給・営業区域・運行枠を確かめ直し、1 つのトランザクションでオファーを作る（`offered`。落ちたら `NOT_ELIGIBLE` などで返す）。
5. ドライバーのアプリにオファーが届き、表示の後に `OfferDelivered` を返す（5 秒で届かなければ取り下げ）。受諾は offer ID と epoch つきで送られ、Trips が確定する（`accepted`。サーバーの期限は 16.5 秒）。時間切れと辞退は、そのドライバーを除いて次のバッチに戻す。3 分か 10 回で `no_driver_found`。

### 6.2 乗車から精算まで

1. `accepted` → `arriving` → `arrived` → `on_trip` →（`awaiting_fare` →）`completed`。各遷移は Trips の遷移関数だけが行い、outbox から両方のアプリへ配る。通信が切れても、ドライバーのアプリは到着・乗車の開始・降車を journal で進める。
2. 運賃は、事前確定運賃なら依頼の時点の額、メーターの運賃なら降車の時点のメーターの額で確定する。額が未定のときは `awaiting_fare` でドライバーを解放する。
3. Payments が PSP で売上を確定する。事業者への精算は、月 2 回の締めでまとめる。

## 7. リスクと未解決事項

品質の面のリスクの順位と対策は [quality.md](../quality.md) の 1 節にある。ここは設計の面のリスクを書く。

- **法令と認可**：運賃の規則、日本版ライドシェアの条件、位置情報の扱い、ドライバーの労働の位置づけ、代金の受け取りの形は、法務の確認待ち（[intent.md](../intent.md) の L1〜L9）。規則はデータで持ち、該当の経路は legal のフラグの裏に置き、`legal_gate_records` の記録の後に有効にする（[ADR-0043](../decisions/0043-flag-taxonomy-legal-gates-and-safety-defaults.md)）。
- **二重の割り当て**：配車のタスクの二重、索引の遅れ、リージョンの切り替えでの epoch の増分の損失。遷移関数・`(region_gen, assignment_epoch)`・部分一意索引の 3 段と、1 分ごとの検査で守る（[ADR-0021](../decisions/0021-trip-transition-function-and-assignment-fencing.md)、[ADR-0039](../decisions/0039-city-cells-and-osaka-warm-standby.md)）。
- **タクシーメーターとの連携**：メーターの運賃を、車載の機器から自動で受け取れるか、ドライバーの入力に頼るかで、運賃の正しさの保証が変わる。メーターの製造者との連携は未確定。入力は影の計算と照合する（[ADR-0019](../decisions/0019-meter-fare-sources.md)）。
- **流しとの両立**：タクシーは、アプリの配車の合間に流しで客を乗せる。空車・実車の状態がずれると、実車の車にオファーが届く。メーターの状態を取れない場合は、ドライバーの操作と時間切れ 2 回の自動の休憩に頼る（[ADR-0014](../decisions/0014-dispatch-eligibility-and-street-hails.md)）。
- **2 つの実装の条件の食い違い**：候補の条件を配車（Go）と Trips（TypeScript）の両方で判定する。共通の決定表のベクター（DT-DISP-001）で食い違いを CI で止め、本番は `NOT_ELIGIBLE` の件数で見る。
- **索引の分割の境界**：都市や分割の境界の近くの依頼は、隣の分割の候補を取りこぼしうる。S1 は都市ごとに 1 組で避け、S2 は halo で扱う（[geospatial-index.md](geospatial-index.md)）。
- **ETA の精度**：OSM の上の経路は、日本の細い道や右折の制限で誤差が出うる。本家は、経路のエンジンの ETA に、実績との差を学習したモデルで補正をかけている（[DeepETA](https://www.uber.com/us/en/blog/deepeta-how-uber-predicts-arrival-times/)、2022-02、2026-09-27 に確認）。S1 は偏りの補正の表で NFR-003 を満たせるかを計測し、足りなければ E13 の ETA の補正を前倒しする。時刻に依る行列は Valhalla の設定の変更と PoC が要る。
- **地図の提供者の利用条件**：商用の地図の利用条件が、結果の保存や他の地図との併用を制限する（Google は併用の禁止と緯度経度のキャッシュの期限。[ADR-0005](../decisions/0005-maps-and-routing.md)）。乗車の行には乗客のピンだけを置き、提供者の内容は期限つきの表に分ける（[ADR-0034](../decisions/0034-geocoding-provider-and-pickup-points.md)）。
- **大阪への切り替え**：Aurora の計画外の切り替えは直近の書き込みを失い、古い主の書き込みの止め方はベストエフォート。端末の要約と journal での復元、`region_gen`、人の判断の切り替えで抑える。RTO の内訳と大阪の Fargate の容量は **未検証**（E12 の DR の訓練）。
- **緊急の通報**：運用の担当の人手が足りなければ、NFR-010 の 30 秒を守れない。安全の担当の人数と夜間の体制は Ops が S1 の前に決める。

### 決定（2026-09-27、既定案）

PM の方針（既定案で進める）により、統合の工程で次のとおり決めた。法務の判断が要るものは決めず、[intent.md](../intent.md) の「法務の確認待ち」（L1〜L9）に残した。

- **ADR と intent の状態**：基盤の ADR（0001〜0005）と intent.md を、他の題材と同じく `accepted` にした。先に次を直した。
  - ADR-0001：Go のサービスを 3 つから 5 つにした（`rt-gateway` と `trip-location-fanout` を足した。ADR-0030・0038）。`trail-builder`・`dispatch-shadow`・`eta-service` は、それぞれの ADR で認めた付随の役として数えない。
  - ADR-0003：状態に `payment_pending`・`awaiting_fare`・`cancelled_by_system`・`payment_failed` を足した。`assignment_epoch` は割り当ての作成と解放で増やす（ADR-0021）。比較は DR に備えて `(region_gen, assignment_epoch)` にした（ADR-0039）。trips-lifecycle の 4.2・8 節と geospatial-index の 4.2・6.1 節にも入れた。
  - ADR-0004：サーバーの期限 16.5 秒、表示 15 秒、受信の確認 5 秒の取り下げ（ADR-0015）に揃えた。
  - ADR-0005：本家の Matching のページ（ADR-0004）と Google の利用条件を本文で確かめ、出典を直した。時刻に依る行列は Valhalla の設定の変更と PoC が要ることを書いた。ナビの引き継ぎは主要経由地点を渡す（ADR-0008）。
  - intent.md：日本版ライドシェアのドライバーは第一種か第二種の免許。変動運賃の上下 5 割・10 円単位は公示の本文で確かめた（モニタリングの後の現行の運用は **未検証**）。流しの実車の切り替えはタクシーだけ。法務の問いに、オファーの降車地と運送引受義務（L1）、派生タイルの ODbL（L3）、収納代行の割賦販売法の加盟店の義務（L6）を足した。
- **NFR-009 の例外**：乗車の共有と事業者の稼働の地図の 2 つだけ。どちらも `legal.l4.*` の裏（L4 の記録がある範囲でだけ有効。ADR-0043）。
- **顔の照合**：`legal.l4.driver_face_check` の裏。頻度は、その日の最初の出庫と 1 日 1 回の抜き打ち（ADR-0029・0037）。顔の画像は専用の `biometric` の鍵（ADR-0036、security.md の 6.2 節）。
- **提案の時の確かめ直し**：Trips は提案の時に供給・営業区域・運行枠を確かめ直し、配車と共通の決定表のベクター（DT-DISP-001）を使う。拒否の列挙に `NOT_ELIGIBLE` を足した（dispatch の 6.4 節、trips の 4.3 節）。
- **流しの客のための取り消し**：乗車は再配車に戻り、終端にならない。終端の `cancelled_by_driver` は安全・迷惑行為の理由だけ（dispatch の 7 節を直した）。
- **到着の判定**：索引の `GetDriverLocation` で行う。位置の Valkey の写しは持たない（trips の 3.3 節）。`GetDriverLocation` を呼べるのは Trips・ETA・share-service・safety-monitor（geospatial-index の 9 節）。
- **乗降の保存**：乗車の行には乗客が確かめたピンだけ。提供者の内容は `trip_place_refs` に提供者ごとの期限で置く（ADR-0034。trips の 14 節、maps の 7.3 節）。
- **データモデル**：`trip_offers` は `driver_assignments` に統合し、オファーの配信の列を足した。`fare_distance_quotes` の持ち主は Pricing。区域は `service_areas` だけが持ち、区域を指す列は `*area_id`（`fare_region_id` → `fare_area_id`）。位置の置き場所の一覧を [data-model.md](data-model.md) の 9 節に作った。
- **S1 の「依頼 30 件/秒」**：ピークの受け付けの量（成立しない依頼を含む）と定義し、成立は約 3〜6 件/秒とした。容量・Trips・PSP・ETA の見積もりで使い分けた（capacity の 1.1・5 節、ADR-0003）。**PM の確認事項**。
- **AGENTS.md**：ADR-0043 の強い規則を 2 つ足した（legal のフラグには `legal_gate_records` が要る、緊急の入口に release フラグを置かない）。法務の確認待ちの規則は release ではなく legal のフラグの裏（ADR-0014・0018・0020・0024・0042 と pricing・payments・dispatch を揃えた）。
- **呼び名と数値**：事業者の管理画面のドメインは `operator.<domain>`（support の `partners.<domain>` を直した）。`ops.region.writable` に揃えた。常時の接続は gRPC の双方向ストリーム（location-ingestion の WebSocket の記述を直した）。オファーの TTL をサーバーの期限 16.5 秒に揃えた（notifications の 4.3 節）。runbook `driver-safety-suspension.md` を `driver-safety-hold.md` に 1 つにした。
- **Epic**：E1〜E12 が MVP（S1）、E13 機械学習・E14 複数の都市への展開・E15 配車と安全の S2 の改善が S2。それ以外は [roadmap.md](../roadmap.md) の延期の一覧。E12 は「日本版ライドシェアと GA の準備」の 2 つの流れを持つ。
- **数値の正本**：SLO とアラートは [runbooks/README.md](../runbooks/README.md) の 1・4 節。容量のパラメーターは [capacity.md](capacity.md) の 8 節、保持の期間は [security.md](security.md) の 7.2 節、オファーの時間は [ADR-0015](../decisions/0015-offer-protocol-decision-log-and-replay.md)。
- 領域ごとの決定は、各文書の「決定（2026-09-27、既定案）」の節にある。

持ち越し（確認・計測・PoC で決めるもの）：

| 項目 | いつ・どう決めるか |
| --- | --- |
| S1 の「依頼 30 件/秒」の定義（受け付けの量）と、提携先の車両の数 | PM が E1 の前に確かめる |
| 法務の L1〜L9 | 法務。結論まで該当の Story の spec を承認しない |
| 時刻に依る行列の精度と p99、日本全体の Valhalla のタイルの大きさと起動の時間 | E4 の `timedep-matrix-poc`・`valhalla-pool-fargate` |
| 住所の検索・推計走行距離の提供者、番号の中継・顔の照合・SMS・PSP の提供者 | E4・E10・E1・E8 の PoC と選定 |
| 最適化の計算の時間（n = 500） | E5 の `solver-benchmark-500` |
| SNS・SQS の区間の遅れ（オファーの配信の予算） | E6 の計測 |
| Go の GC の停止を含む p99 | E3 の負荷試験 |
| RTO の内訳、大阪の Fargate の容量、東京の書き込みの止め方 | E12 の DR の訓練 |
| 費用の単価（大阪、ALB、可観測性） | E12 の `cost-dashboard` |
| `eta-service` を Go のサービスの数に含めるか（ADR-0001 の Confirmation） | Dev のテックリードが E4 の前に確かめる |

## 8. 領域の文書

持ち主は、どれも Dev が書き、「レビュー」の列のロールが確認する。ADR は下の範囲の中で採番する。

| ファイル | 範囲 | ADR | レビュー | 関わる Epic |
| --- | --- | --- | --- | --- |
| [rider-and-driver-apps.md](rider-and-driver-apps.md) | 画面の流れ、背景での位置の送信、電池、外部のナビへの引き継ぎ、通信が切れたときの乗車の継続、列車と強制の更新 | 0006〜0008 | QA | E1、E9 |
| [location-ingestion.md](location-ingestion.md) | 約 4 秒ごとの送信、検証、重複と順序、道路への当てはめ、軌跡の保存と保持 | 0009〜0010 | QA、セキュリティ | E3 |
| [geospatial-index.md](geospatial-index.md) | H3 のセルの索引、分割、リース、再構築、検索の API | 0011〜0012 | QA | E3、E14 |
| [dispatch-and-matching.md](dispatch-and-matching.md) | バッチのマッチング、候補の条件、オファーと時間切れ、流しとの両立、判断の記録と再生 | 0013〜0015 | QA | E5、E6 |
| [eta-and-routing.md](eta-and-routing.md) | ETA の種類、Valhalla の運用、速度の表、精度の計測、推計走行距離 | 0016〜0017 | QA | E4 |
| [pricing-and-fares.md](pricing-and-fares.md) | メーターの運賃、事前確定運賃、迎車料金、変動運賃、版つきの規則、端数 | 0018〜0020 | QA、法務の窓口 | E7 |
| [trips-lifecycle.md](trips-lifecycle.md) | 状態機械、割り当ての確定、取り消し、タイマー、outbox、通信が切れたときの継続と復元 | 0021〜0022 | QA | E6 |
| [payments-and-payouts.md](payments-and-payouts.md) | PSP、与信と確定、返金、代金の受け取りの形、台帳、精算、照合 | 0023〜0025 | QA、お金の持ち主 | E8 |
| [supply-and-operators.md](supply-and-operators.md) | 事業者・営業所・車両・ドライバー、書類、出庫の判定、管理画面、日本版ライドシェアの運行枠 | 0026〜0027 | QA | E2、E12 |
| [safety-and-trust.md](safety-and-trust.md) | 乗車の共有、緊急の通報、本人の確認、評価、番号を隠した通話、事故の報告 | 0028〜0029 | QA、安全の持ち主 | E10 |
| [notifications-and-realtime-push.md](notifications-and-realtime-push.md) | 常時の接続、順序と再送、オファーの配信、車の位置、プッシュ通知、SMS | 0030〜0031 | QA | E6、E9 |
| [support-and-operations-tools.md](support-and-operations-tools.md) | 乗車の調べ、訂正と返金、軌跡の監査つきの閲覧、変更の要求、問い合わせ | 0032 | QA、セキュリティ | E11 |
| [maps-and-geodata.md](maps-and-geodata.md) | OSM の取り込み、ODbL、住所の検索、乗降の地点、区域の多角形 | 0033〜0034 | QA | E4 |
| [ml-platform.md](ml-platform.md) | ETA の補正のモデル、需要の予測、特徴量、影の実行（S2） | 0035 | QA | E13 |
| [security.md](security.md) | 脅威モデル、認証、位置のプライバシー、鍵、監査ログ、データのライフサイクル、不正 | 0036〜0037 | セキュリティ | E1、E3、E10、E12 |
| [infrastructure.md](infrastructure.md) | AWS の構成、実行基盤、都市のセル、大阪への災害復旧、費用 | 0038〜0039 | Ops | E1、E12 |
| [observability.md](observability.md) | ログ、メトリクス、トレース、SLI、アラート、合成の監視 | 0040 | Ops | E1 |
| [capacity.md](capacity.md) | 負荷のモデル、部品ごとの必要量、受け入れの上限、負荷試験 L1〜L11 | 0041 | Ops | E5、E12 |
| [delivery.md](delivery.md) | CI/CD、関門（再生・影・`fare-replay`）、都市の波、フラグ、アプリの列車 | 0042〜0043 | QA、Ops | E1 |
| [data-model.md](data-model.md) | データの置き場所の索引と統合した定義 | なし（各領域の ADR を参照する） | QA | 全 Epic |

## 9. Epic

Epic と Story の計画は [roadmap.md](../roadmap.md) にある（PM が持つ）。領域の文書の Story の候補は、この番号で書く。

| Epic | 中身 |
| --- | --- |
| E1 基盤とビルド | AWS・Terraform・CI（Go・TypeScript・契約・状態機械のベクター）、Aurora `core`・`money`、KMS の 6 種類の鍵、認証の骨格、監査ログ、可観測性、フラグ（release・ops・legal）と `legal_gate_records`、アプリの列車と版の方針、SMS のワンタイムコード |
| E2 事業者と供給 | 事業者・営業所・車両・ドライバーの登録、書類の確認、出庫の判定とセッション、点呼、事業者の管理画面、振込先 |
| E3 位置と索引 | 位置の取り込みと検証、Kinesis、軌跡と当てはめ、索引とリースと再構築、検索、需給の集計、位置の閲覧の許可、端末の完全性 |
| E4 地図と ETA | Valhalla のタイルと配信、ETA と補正と精度、推計走行距離、OSM と ODbL、住所の検索と乗降の地点、区域の多角形 |
| E5 配車 | バッチの周期とリース、候補の条件、最適化、提案、判断の記録、再生・市場のシミュレーション・影の実行、受け入れの上限 |
| E6 乗車とリアルタイム | 状態機械、割り当ての確定、タイマー、outbox、取り消し、journal と復元、オファーの手順、常時の接続、車の位置、プッシュ通知、不変条件の検査 |
| E7 運賃 | 版つきの運賃の規則、金額の型、距離制と影の計算、事前確定運賃、価格の群、迎車料金、メーターの連携、変動運賃（legal のフラグ）、水準の報告、`fare-replay` |
| E8 決済と精算 | PSP の包み、与信と確定、追加の請求、キャンセル料、台帳、締めと振込、照合、代金の受け取りの形（legal のフラグ） |
| E9 アプリ | 乗客とドライバーの画面、背景の位置と電池、オファーの画面、ナビの引き継ぎ、journal、状態機械のベクター、流しの実車（タクシーだけ） |
| E10 安全と信頼 | 緊急の入口と受け付け、乗車の共有（`legal.l4.share_trip`）、PIN、番号を隠した通話、メッセージ、評価、顔の照合（`legal.l4.driver_face_check`）、報告と事故、異常の検知、不正の点数 |
| E11 サポートと運用のツール | 運用の画面、ロールと上限、一時の権限、乗車の調べ、軌跡の監査つきの閲覧、変更の要求、訂正と返金、問い合わせ、監査の照合 |
| E12 日本版ライドシェアと GA の準備 | 日本版ライドシェア（要件、運行枠、台数、拡大、運賃、配車の条件。legal のフラグ）と、GA の準備（負荷試験 L1〜L11、大阪と DR の訓練、予定の拡大、侵入試験、両リージョンの削除、費用） |
| E13 機械学習（S2） | 特徴量のストア、ETA の残差の補正のモデルと影の展開、需要の予測と表示 |
| E14 複数の都市への展開（S2） | 都市のセルを 12 地域へ、分割の表と halo、都市の波の配備、都市ごとの区域と運賃のデータ |
| E15 配車と安全の S2 の改善 | 降車の近い実車の候補、予報の自動の取り込み、事故の疑いの検知、VoIP の通話、公平さの項、QUIC |

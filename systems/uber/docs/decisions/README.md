# Decisions: Uber

Uber の再構築に関する決定。リポジトリ共通の決定は [docs/decisions/](../../../../docs/decisions/README.md) にある（本家の名前・接頭辞を使わない規則は、その ADR-0006）。領域ごとの設計と、各 ADR の位置づけは [architecture/](../architecture/README.md) を見る。

<!-- adr-index:start -->
| ADR | 決定 | 状態 |
| --- | --- | --- |
| [0001](0001-platform-and-stack.md) | 基盤は他の題材の決定を引き継ぎ、配車の熱い経路は Go で、モバイルはネイティブで書く | accepted |
| [0002](0002-hex-grid-geospatial-model.md) | 地理の単位は自前の六角形の階層の格子（geogrid）にし、ドライバーの索引はメモリの上で都市とセルで分ける | accepted |
| [0003](0003-trip-state-and-single-assignment.md) | 乗車の状態は Aurora のステートマシンを正本にし、割り当ては fencing token つきのトランザクションで 1 つに限る | accepted |
| [0004](0004-batched-dispatch-and-offers.md) | 配車は区域ごとの短いバッチで最適化し、オファーは 1 人ずつ時間切れつきで送る | accepted |
| [0005](0005-maps-and-routing.md) | 経路と ETA は OSM の上の Valhalla を自前で動かし、住所の検索と事前確定運賃の距離は商用の提供者を使う | accepted |
| [0006](0006-native-apps-contracts-vectors-and-release-train.md) | アプリは Swift と Kotlin で書き、共有は生成した型とステートマシンのテストのベクターに限る。リリースは週 1 回の列車で、強制の更新は乗車の最中と緊急の入口を塞がない | accepted |
| [0007](0007-driver-background-location-and-battery.md) | ドライバーのアプリは「使用中のみ」の許可で、出庫の間だけ背景で位置を取る。止まったらサーバーが 60 秒で知らせる | accepted |
| [0008](0008-navigation-handoff-with-waypoints.md) | 外部のナビには選んだルートの主要経由地点を経由地として渡し、経由地を守ると確かめた引き継ぎ先だけを事前確定運賃で使う | accepted |
| [0009](0009-location-upload-and-validation.md) | 位置は HTTP/2 の POST で 4 秒ごとにまとめて送り、無状態の取り込みで検証して Kinesis Data Streams に流す | accepted |
| [0010](0010-location-trails-map-matching-and-retention.md) | 軌跡は保持の期間を持つストアに分けて置き、道路への当てはめは Valhalla で遅れて行う。ログは格子のセルに丸め、人が見る操作は監査する | accepted |
| [0011](0011-geo-index-sharding-lease-and-rebuild.md) | 索引は都市と `metro` の集まりで分け、持ち主は DynamoDB のリースで決め、直近 35 秒の位置の流れから作り直す | accepted |
| [0012](0012-geo-index-nearby-query-api.md) | 近くの空車の検索は、`street` の輪を広げ、外周までの距離で打ち切る gRPC の API にする。依頼の前の地図の車は丸めて返す | accepted |
| [0013](0013-batch-assignment-solver.md) | バッチの割り当ては、迎車の ETA を主にしたコストで、長方形の最短増加路法で解き、300 ms を超えたら貪欲法に切り替える | accepted |
| [0014](0014-dispatch-eligibility-and-street-hails.md) | 候補の条件はバージョンつきのデータを引数に取る純粋な関数で判定し、流しの実車は索引から外す。日本版ライドシェアは承諾・事前確定運賃・運行枠の中だけで候補にする | accepted |
| [0015](0015-offer-protocol-decision-log-and-replay.md) | オファーは表示 15 秒・サーバーの期限 16.5 秒で、届かなければ 5 秒で取り下げる。配車の判断は丸めた入力ごと記録し、再生・シミュレーション・影の実行で比べる | accepted |
| [0016](0016-valhalla-serving-traffic-and-eta-accuracy.md) | Valhalla は taxi の costing と週 1 回の検査つきのタイルで動かし、自前の走行から速度の表を作る。ETA は経路の時間に偏りの補正を足し、受諾の時点の表示と実際の到着の差で精度を計る | accepted |
| [0017](0017-fare-distance-for-pre-fixed-fares.md) | 事前確定運賃の推計走行距離は、確認の済んだ商用の地図の提供者だけで求め、2 つ以上のルート・有料道路の選択・同じルートの提示を API で守る | accepted |
| [0018](0018-versioned-fare-rules-and-integer-yen.md) | 運賃の規則はバージョンつきのデータにし、計算は円の整数と決めた段の丸めだけで行う | accepted |
| [0019](0019-meter-fare-sources.md) | メーターの運賃は車載のメーターか認定ソフトメーターとの連携で受け取り、連携できない車はドライバーの入力を影の計算と照合する | accepted |
| [0020](0020-dynamic-fares-within-authorized-bands.md) | 変動運賃と変動迎車料金は、事業者ごとの認可の幅の中で、事業者が決めた時間帯の表で変える | accepted |
| [0021](0021-trip-transition-function-and-assignment-fencing.md) | 乗車の遷移は 1 つの関数で行い、`assignment_epoch` を割り当ての作成と解放で増やし、部分一意索引で有効な割り当てを 1 つに限る | accepted |
| [0022](0022-trip-outbox-and-offline-continuation.md) | 乗車の事象は outbox から少なくとも 1 回配り、ドライバーのアプリは journal と署名つきの要約で通信が切れても乗車を続ける | accepted |
| [0023](0023-psp-authorize-at-request-capture-at-end.md) | 外部の PSP で依頼のときに与信し、乗車の終わりに売上を確定する。不足は追加の請求で受け、結果不明のうちは次を送らない | accepted |
| [0024](0024-fare-collection-model.md) | 運賃の受け取りは収納代行の形を既定にし、事業者を加盟店にする形を代わりに持ち、法務の結論まで本番で有効にしない | accepted |
| [0025](0025-ledger-settlement-and-reconciliation.md) | 複式簿記の台帳で事業者ごとの預り金を持ち、月 2 回の締めで精算し、台帳・PSP の精算・銀行の明細を 3 者で照合する | accepted |
| [0026](0026-supply-registry-and-document-verification.md) | 供給は事業者が登録し、この基盤が書類を確かめ、配車に出てよいかをバージョンつきの判定として出庫と提案の両方で確かめる | accepted |
| [0027](0027-rideshare-operating-windows.md) | 日本版ライドシェアの運行枠は承認済みのデータにし、同時に稼働する台数を出庫のトランザクションで事業者 × 営業区域ごとに数えて守る | accepted |
| [0028](0028-emergency-share-trip-and-incident-flow.md) | 緊急の入口は端末だけで 110・119 の発信の画面を開き、同時に運用へ知らせる。共有は乗車の終わりで止まるリンクにし、事故の報告は事業者が行う形で手伝う | accepted |
| [0029](0029-masked-communications-identity-and-ratings.md) | 通話は自前の中継の論理と 050 の番号で相手の番号を隠し、本人と車は顔の照合と PIN で確かめ、評価の低い組は二度と配車しない。録音・録画は法務の確認まで作らない | accepted |
| [0030](0030-realtime-grpc-bidirectional-stream-gateway.md) | アプリとの常時の接続は gRPC の双方向ストリーム 1 本にし、Go の rt-gateway で受ける | accepted |
| [0031](0031-per-stream-sequence-redelivery-push-and-sms.md) | 配信は受け手ごとの seq と TTL で順序と送り直しを持ち、正しさは API の読み直しが持つ。届かないときは利用者に見えるプッシュ、SMS はワンタイムコードと到着の代わりの知らせだけ | accepted |
| [0032](0032-ops-console-roles-limits-change-requests-and-audit.md) | 運用のツールはロールと金額の上限、理由つきの一時の権限、書き手と承認者を分ける変更の要求で作り、閲覧と監査ログを毎日照合する | accepted |
| [0033](0033-osm-import-and-service-area-polygons.md) | OSM は週 1 回の検査つきで取り込み、誤りは OSM の本体で直す。営業区域・交通圏は国土数値情報と公示からバージョンつきの多角形にし、格子のセルの写しと多角形で判定する | accepted |
| [0034](0034-geocoding-provider-and-pickup-points.md) | 住所の検索は自前の API の後ろに 1 社の提供者を置き、PoC の基準で選ぶ。乗降の座標は乗客が確かめたピンとして保存し、乗降の地点は運用が確かめたデータで出す | accepted |
| [0035](0035-ml-feature-store-and-shadow-rollout.md) | 最初のモデルは勾配ブースティングで ETA の補正を eta-service の中で動かし、特徴量は 1 つのパイプラインで両方のストアに書き、影の実行を経て区域ごとに展開する | accepted |
| [0036](0036-location-privacy-keys-retention-and-audited-access.md) | 位置と個人の情報は種類ごとの KMS の鍵と保持の期間で分け、人が見る操作は理由・範囲・期限つきの許可と改ざんできない監査ログで行う | accepted |
| [0037](0037-authentication-device-integrity-and-fraud-response.md) | 利用者の種類ごとに認証を分け、ドライバーは出庫のときに端末の完全性を確かめる。不正は兆しの点数と人の確認で扱い、自動の処置は配車・特典から外すまでにする | accepted |
| [0038](0038-compute-on-fargate-and-data-stores.md) | Go の熱い経路と Valhalla は ECS Fargate（ARM64）で動かし、Aurora は乗車の群れとお金の群れの 2 つのクラスタに分け、リースの表はリージョンごとに持つ | accepted |
| [0039](0039-city-cells-and-osaka-warm-standby.md) | 位置・索引・配車は都市ごとのセルに分け、大阪は縮小したウォームスタンバイにする。切り替えでは位置を新しく受け直し、進行中の乗車は端末の要約と journal で戻す | accepted |
| [0040](0040-per-city-slis-and-slos.md) | SLO は都市ごとに、依頼・位置・遷移・支払い・緊急の通報の事象で数える。不変条件（二重の割り当て・二重の請求）は SLO にせず、1 件で呼び出す | accepted |
| [0041](0041-load-model-admission-control-and-prescaling.md) | 負荷は平常のピークに雨・大晦日・大雪の倍率を掛けて見積もる。熱い経路は平常のピークの 2 倍を常に持ち、依頼は都市ごとの受け入れの上限で絞り、予定の催しと雨の予報で前もって広げる | accepted |
| [0042](0042-replay-and-shadow-gates-for-dispatch-and-pricing.md) | 配車と運賃の変更は、再生・シミュレーション・影の実行の関門を通し、都市とセルの単位の波で出す | accepted |
| [0043](0043-flag-taxonomy-legal-gates-and-safety-defaults.md) | フラグは release・ops・legal の 3 つに分け、法務の確認待ちの経路は法務の記録がないと本番で有効にできない。安全の機能はフラグで「出さない」に倒せない | accepted |
<!-- adr-index:end -->

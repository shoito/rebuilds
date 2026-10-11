# Design log: Uber

設計の工程ごとに決めたことの記録。今の結論は [README.md](README.md) と各領域の文書と ADR にあり、ここはその経緯を残す。新しい記録は末尾に足す。

記録は README.md から本文のまま移したもので、本文の中の「1.4 節」「6 節」などの節の番号は、[README.md](README.md) の節を指す。

## 2026-09-27：既定案

PM の方針（既定案で進める）により、統合の工程で次のとおり決めた。法務の判断が要るものは決めず、[intent.md](../intent.md) の「法務の確認待ち」（L1〜L9）に残した。

- **ADR と intent の状態**：基盤の ADR（0001〜0005）と intent.md を、他の題材と同じく `accepted` にした。先に次を直した。
  - ADR-0001：Go のサービスを 3 つから 6 つにした（`rt-gateway` と `trip-location-fanout` を足した。ADR-0030・0038。別に配備する `eta-service` も数える）。`trail-builder`・`dispatch-shadow` は、それぞれの ADR で認めた付随の役として数えない。
  - ADR-0003：状態に `payment_pending`・`awaiting_fare`・`cancelled_by_system`・`payment_failed` を足した。`assignment_epoch` は割り当ての作成と解放で増やす（ADR-0021）。比較は DR に備えて `(region_gen, assignment_epoch)` にした（ADR-0039）。trips-lifecycle の 4.2・8 節と geospatial-index の 4.2・6.1 節にも入れた。
  - ADR-0004：サーバーの期限 16.5 秒、表示 15 秒、受信の確認 5 秒の取り下げ（ADR-0015）に揃えた。
  - ADR-0005：本家の Matching のページ（ADR-0004）と Google の利用条件を本文で確かめ、出典を直した。時刻に依る行列は Valhalla の設定の変更と PoC が要ることを書いた。ナビの引き継ぎは主要経由地点を渡す（ADR-0008）。
  - intent.md：日本版ライドシェアのドライバーは第一種か第二種の免許。変動運賃の上下 5 割・10 円単位は公示の本文で確かめた（関東の現行の公示でも同じ。公示の外の運用の指示の有無は L2）。流しの実車の切り替えはタクシーだけ。法務の問いに、オファーの降車地と運送引受義務（L1）、派生タイルの ODbL（L3）、収納代行の割賦販売法の加盟店の義務（L6）を足した。
- **NFR-009 の例外**：乗車の共有と事業者の稼働の地図の 2 つだけ。どちらも `legal.l4.*` の裏（L4 の記録がある範囲でだけ有効。ADR-0043）。
- **顔の照合**：`legal.l4.driver_face_check` の裏。頻度は、その日の最初の出庫と 1 日 1 回の抜き打ち（ADR-0029・0037）。顔の画像は専用の `biometric` の鍵（ADR-0036、security.md の 6.2 節）。
- **提案の時の確かめ直し**：Trips は提案の時に供給・営業区域・運行枠を確かめ直し、配車と共通の決定表のベクター（DT-DISP-001）を使う。拒否の列挙に `NOT_ELIGIBLE` を足した（dispatch の 6.4 節、trips の 4.3 節）。
- **流しの客のための取り消し**：乗車は再配車に戻り、終端にならない。終端の `cancelled_by_driver` は安全・迷惑行為の理由だけ（dispatch の 7 節を直した）。
- **到着の判定**：索引の `GetDriverLocation` で行う。位置の Valkey の写しは持たない（trips の 3.3 節）。`GetDriverLocation` を呼べるのは Trips・ETA・share-service・safety-monitor（geospatial-index の 9 節）。
- **乗降の保存**：乗車の行には乗客が確かめたピンだけ。提供者の内容は `trip_place_refs` に提供者ごとの期限で置く（ADR-0034。trips の 14 節、maps の 7.3 節）。
- **データモデル**：`trip_offers` は `driver_assignments` に統合し、オファーの配信の列を足した。`fare_distance_quotes` の持ち主は Pricing。区域は `service_areas` だけが持ち、区域を指す列は `*area_id`（`fare_region_id` → `fare_area_id`）。位置の置き場所の一覧を [data-model.md](data-model.md) の 6 節に作った。
- **S1 の「依頼 30 件/秒」**：ピークの受け付けの量（成立しない依頼を含む）と定義し、成立は約 3〜6 件/秒とした。容量・Trips・PSP・ETA の見積もりで使い分けた（capacity の 1.1・5 節、ADR-0003）。2026-09-28 に確定（下の「決定（2026-09-28、推奨案で確定）」）。
- **AGENTS.md**：ADR-0043 の強い規則を 2 つ足した（legal のフラグには `legal_gate_records` が要る、緊急の入口に release フラグを置かない）。法務の確認待ちの規則は release ではなく legal のフラグの裏（ADR-0014・0018・0020・0024・0042 と pricing・payments・dispatch を揃えた）。
- **呼び名と数値**：事業者の管理画面のドメインは `operator.<domain>`（support の `partners.<domain>` を直した）。`ops.region.writable` に揃えた。常時の接続は gRPC の双方向ストリーム（location-ingestion の WebSocket の記述を直した）。オファーの TTL をサーバーの期限 16.5 秒に揃えた（notifications の 4.3 節）。runbook `driver-safety-suspension.md` を `driver-safety-hold.md` に 1 つにした。
- **Epic**：E1〜E12 が MVP（S1）、E13 機械学習・E14 複数の都市への展開・E15 配車と安全の S2 の改善が S2。それ以外は [roadmap.md](../roadmap.md) の延期の一覧。E12 は「日本版ライドシェアと GA の準備」の 2 つの流れを持つ。1 つの Epic にしたのは、どちらも S1 の本番の開始の前に終える条件だからで、流れを分けたのは、日本版ライドシェアが法務（L2・L5）の結論を待つ間も、GA の準備を止めずに進めるため（2026-09-28 に確定）。
- **数値の正本**：SLO とアラートは [runbooks/README.md](../runbooks/README.md) の 1・4 節。容量のパラメーターは [capacity.md](capacity.md) の 8 節、保持の期間は [security.md](security.md) の 7.2 節、オファーの時間は [ADR-0015](../decisions/0015-offer-protocol-decision-log-and-replay.md)。
- 領域ごとの決定は、各文書の「決定（2026-09-27、既定案）」の節にある。

持ち越し（確認・計測・PoC で決めるもの）：

| 項目 | いつ・どう決めるか |
| --- | --- |
| 提携先の車両の数（S1 の規模の見直し） | 最初の提携先との契約の後に、[README.md](README.md) の 2 節の表を見直す |
| 法務の L1〜L9 | 法務。結論まで該当の Story の spec を承認しない |
| 時刻に依る行列の精度と p99、日本全体の Valhalla のタイルの大きさと起動の時間 | E4 の `timedep-matrix-poc`・`valhalla-pool-fargate` |
| 住所の検索・推計走行距離の提供者、番号の中継・顔の照合・SMS・PSP の提供者 | E4・E10・E1・E8 の PoC と選定 |
| 最適化の計算の時間（n = 500） | E5 の `solver-benchmark-500` |
| SNS・SQS の区間の遅れ（オファーの配信の予算） | E6 の計測 |
| Go の GC の停止を含む p99 | E3 の負荷試験 |
| RTO の内訳、大阪の Fargate の容量、東京の書き込みの止め方 | E12 の DR の訓練 |
| 費用の量（転送、LCU、ログ）と可観測性・セキュリティのサービスの額（単価は 2026-09-27 に Price List API で確認済み） | E12 の `cost-dashboard` |

## 2026-09-28：推奨案で確定

PM の方針（判断が要るところは推奨案でよい）により、次のとおり決めた。法務の判断が要るもの（L1〜L9、税理士の確認）と、それに依るものは決めずに残した。PoC と計測で決めるものは、上の持ち越しの表に残した。

**リポジトリ共通の ADR-0007 の適用（題材の核に本家の実装を使わない）**

- **地理の格子を H3 から自前の `geogrid` に替えた。** H3（h3-go）は本家が作った実装で、地理空間の索引はこの題材の核だから。六角形の階層、7 分の 1 ずつの面積、索引の持ち方は変えない。日本を 1 つの正積の平面に写し、正六角形を並べる。レベルは `metro`・`district`・`block`・`street`・`spot`（H3 の解像度 6〜10 と同じ大きさ）。cgo の懸念も消えた（[ADR-0002](../decisions/0002-hex-grid-geospatial-model.md)、[geospatial-index.md](geospatial-index.md) の 2.1 節、[ADR-0001](../decisions/0001-platform-and-stack.md)、[ADR-0011](../decisions/0011-geo-index-sharding-lease-and-rebuild.md)、[ADR-0012](../decisions/0012-geo-index-nearby-query-api.md)、[ADR-0033](../decisions/0033-osm-import-and-service-area-polygons.md)、[maps-and-geodata.md](maps-and-geodata.md) の 9.3 節）。
- **他の本家の実装も確かめた。** Ringpop は使わない（リースで持ち主を決める。ADR-0011）。Cadence は長い流れの選択肢から外した（[ADR-0003](../decisions/0003-trip-state-and-single-assignment.md)）。Michelangelo・DeepETA・RAMEN は出典としてだけ挙げ、使わない（[ml-platform.md](ml-platform.md)、[notifications-and-realtime-push.md](notifications-and-realtime-push.md)）。Peloton などほかの本家の部品は使っていない。
- 格子の正しさは、性質ベーステスト PROP-GEO-007 と、PROJ・PostGIS との突き合わせで守る（[quality.md](../quality.md)、[roadmap.md](../roadmap.md) の E3 の `geogrid-core`）。

**確認・判断の待ちだったもの**

| 項目 | 決定 | 理由 | 文書 |
| --- | --- | --- | --- |
| S1 の「依頼 30 件/秒」 | ピークに受け付ける依頼の数（成立しない依頼を含む）。成立は約 3〜6 件/秒 | 容量は受け付けの量で、PSP と乗車の量は成立の量で見積もるのが正しいため | [capacity.md](capacity.md) の 1.1 節、[intent.md](../intent.md) |
| E12 の 2 つの流れ | 日本版ライドシェアと GA の準備に分けたまま | 法務（L2・L5）を待つ間も GA の準備を止めないため | [roadmap.md](../roadmap.md) の E12 |
| 乗車の共有 | L4 の結論まで `legal.l4.share_trip` の裏。S1 の開始に共有がないことを PM が受け入れた | 法務の結論の前に位置を第三者に見せないため | [safety-and-trust.md](safety-and-trust.md) の 15 節 |
| Android のオファーの通知 | 優先度の高い heads-up の通知。全画面は許可のあるときだけ。QA が E9 で表示 15 秒・確認 5 秒を確かめる | Android 14 で全画面の通知の既定の許可が取り消されるため | [notifications-and-realtime-push.md](notifications-and-realtime-push.md) の 5.2・14 節、[quality.md](../quality.md) の E9 |
| Play Integrity の 1 日の上限 | Ops が E3 の `driver-session-integrity` の前に引き上げを申請する | 既定の 1 万回は S1 の出庫の回数に近いため | [ADR-0037](../decisions/0037-authentication-device-integrity-and-fraud-response.md)、[security.md](security.md) の 13 節 |
| `region_gen` を上げたときの epoch | 0 に戻さない | 正しさは同じで、世代をまたいで値が重ならず読み違えにくいため | [trips-lifecycle.md](trips-lifecycle.md) の 4.2 節 |
| 抜き打ちの顔の照合の間のオファー | 5 分止める | 自撮りの最中のオファーの時間切れを、自動の休憩に数えないため | [safety-and-trust.md](safety-and-trust.md) の 7.2 節 |
| `eta-service` | Go のサービスに数え、6 つにする | 独自の API を持ち、別に配備するため | [ADR-0001](../decisions/0001-platform-and-stack.md) の注記 |
| 運賃のテストの固定の値 | 2026-04-20 の改定の後の値（初乗 1.0 km、加算 232 m） | 現行の認可の値で確かめるため。改定の前の値はバージョンの切り替えの試験だけ | [pricing-and-fares.md](pricing-and-fares.md) の 11.3 節 |
| 事前確定運賃と影の計算の差の閾値 | 週の比の中央値が平準化係数から ±10% を外れたら知らせる | 係数は実績と推計の比なので、比のずれで乖離を測れるため | [quality.md](../quality.md) の 4 節、[pricing-and-fares.md](pricing-and-fares.md) の 13 節 |
| 評価の閾値 | 2 以下で組を拒否、乗客の注意は 3.5 | S1 の初めの値。分布を見て見直す | [safety-and-trust.md](safety-and-trust.md) の 7.1 節、[ADR-0029](../decisions/0029-masked-communications-identity-and-ratings.md) |
| 運用のロールの上限の値 | 設計の値を S1 の初めの値にする | S1 の問い合わせの分布を見て見直す | [support-and-operations-tools.md](support-and-operations-tools.md) の 2.1 節、[ADR-0032](../decisions/0032-ops-console-roles-limits-change-requests-and-audit.md) |
| 問い合わせの最初の返答の目標 | 普通 24 時間、運賃・キャンセル料 12 時間 | お金の問い合わせを先に返すため | [support-and-operations-tools.md](support-and-operations-tools.md) の 13 節 |
| 運用を外部に委ねるか | S1 は委ねない | 委託先のロールと監査が要らず、個人の情報を外に出さないため | 同上 |
| 安全の担当の体制 | 24 時間の当番、夜間も 2 人以上。30 秒を守れるかは S1 の前の訓練で計る | 1 人が受けている間に次の通報を受けるため | [safety-and-trust.md](safety-and-trust.md) の 15 節 |
| 事業者の管理画面の即時の更新 | `rt-gateway` と分けた SSE | アプリとの常時の接続の部品を小さく保つため | [support-and-operations-tools.md](support-and-operations-tools.md) の 13 節、[notifications-and-realtime-push.md](notifications-and-realtime-push.md) の 14 節 |
| 影の実行の長さ | S1 は小さな変更でも 1 週間を短くしない | 曜日の違いを必ず 1 巡させるため | [delivery.md](delivery.md) の 10 節 |
| CI が本番の記録を読む形 | prod の中の専用の役割で再生し、差の集計だけを返す | 位置を含む記録を本番の外に出さないため | 同上 |
| 成立率 | SLO にせず、品質の指標のまま | 供給の不足を含み、システムの信頼性だけを表さないため | [observability.md](observability.md) の 11 節 |
| 認証の部品 | Better Auth を土台にし、電話番号のワンタイムコードと出庫のセッションを自前で足す | 作り込みを減らし、Slack の題材の知見を使うため | [security.md](security.md) の 4・13 節 |
| 無事故・無免停の証明 | 1 年ごとの更新と、事業者が知った時点の取り消し | 許可基準が頻度を定めないため、年 1 回を下限にした。運転記録の証明を必須にするかは運輸局に確かめる | [supply-and-operators.md](supply-and-operators.md) の 3.3 節 |
| データモデルの正本 | 列・制約・索引・保持の正本を [data-model.md](data-model.md) と [data-model/](data-model/)（9 ファイル、105 テーブル、ER 図 11）にした。領域の文書の表は要点と提案 | 領域の文書の間で名前と列が食い違っていたため（Stripe・Slack の題材と同じ形） | [data-model.md](data-model.md) の 1・8 節 |
| データモデルで足した最小の表 | `pricing_groups`、`operator_bank_accounts`、`recon_lines`、`product_vehicle_map`、`money` の `outbox_events` | 参照先のない ID と、突き合わせの単位がなかったため | [data-model.md](data-model.md) の 10.2 節 |
| 名前の揃え | 運賃の車種の区分は `fare_vehicle_class`（配車の `vehicle_class` と別）、自動の休憩の列は `paused_by_system_at`、精算の明細は `statement_s3_key`、法務の担当のロール `legal_counsel` | 同じ名前で別の意味、クラスタをまたぐ参照、ロールの欠けを直すため | [data-model.md](data-model.md) の 8 節 |
| オファーの乗車地の配信 | 正確な乗車地は `offer.created` の事象だけが運び、SNS の購読のフィルターで `rt-fanout` だけに流す。`driver.assignment_changed` は位置を持たない | 分析などのキューに正確な位置を流さないため（NFR-009） | [data-model/stores.md](data-model/stores.md) の 5・7 節 |
| 保持の既定の追加 | 端末の完全性・顔の照合の結果・不正の点数 1 年、Webhook 13 か月、安全の報告 3 年、問い合わせ 3 年、変更の要求 7 年など（法務の確認待ちの印つき） | 表ごとの保持を欠かさないため | [security.md](security.md) の 7.2 節 |

**決めずに残したもの**：法務の L1〜L9 と、それに依る項目（キャンセル料の名目、共有・顔の照合・稼働の地図の有効化、保持の期間、日本版ライドシェアの枠の判定など）、税理士の確認（手数料の消費税の端数、適格請求書）。運輸局・提携先に確かめる事実（無事故・無免停の確かめ方、雨天・酷暑の読み方、車載のナビだけの事業者、端末の貸与）も、外の相手の答えが要るので残した。

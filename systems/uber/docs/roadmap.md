# Roadmap: Uber

## 進め方の原則

- **最初に walking skeleton を通す。** E1〜E6 で、位置の送信 → 索引 → 配車のバッチ → Trips の提案と確定 → オファーの配信 → 受諾 → 降車までを、合成のドライバーと乗客で端から端まで貫いてから、機能を広げる。遷移関数と `(region_gen, assignment_epoch)` の fencing、部分一意索引、ステートマシンのベクター、判断の記録、位置のログの lint、legal のフラグの検証は、E1〜E6 から本物の形で作る。後から足すと直せないため。
- **PoC を先に済ませる。** 次の PoC は、それぞれの Epic の Story の spec を承認する前に結果を記録する：Valhalla と商用の提供者の ETA・距離の比べ、時刻に依る行列（E4 の前。[ADR-0005](decisions/0005-maps-and-routing.md)）、住所の検索の提供者（E4 の前。[ADR-0034](decisions/0034-geocoding-provider-and-pickup-points.md)）、最適化の計算の時間（E5 の前）、PSP の選定（E8 の前）、番号の中継と顔の照合の提供者（E10 の前）、SMS の提供者（E1）。
- **割り当ての書き込みは 1 つの関数に。** 乗車の状態と割り当てを変えるのは Trips の遷移関数だけ。配車・索引・アプリ・運用のツールは提案か読み取りだけにする（[ADR-0021](decisions/0021-trip-transition-function-and-assignment-fencing.md)）。
- **契約を先に固定する。** Protocol Buffers（位置、提案、オファー、乗車の要約、常時の接続）、遷移の表（DT-TRIP-001）、候補の条件の表（DT-DISP-001）、運賃の規則の型は、人間がレビューして確定する。エージェントは勝手に変えない。互換を壊す変更は `contract-breaking` と Dev のテックリードの承認を要する（[delivery.md](architecture/delivery.md) の 2.1 節）。
- **配車と運賃は同じ入力で比べてから出す。** 配車の計算は再生・シミュレーション・影の実行、運賃のコードは `fare-replay` と影の計算を経る（[ADR-0042](decisions/0042-replay-and-shadow-gates-for-dispatch-and-pricing.md)）。
- **法務の確認待ちの Story は、spec を承認しない。** 設計と、法務に依らない Story は進めてよい（[intent.md](intent.md) の「法務の確認待ち」L1〜L9）。下の表で「法務：L*」と書いた Story が当たる。当たる経路は `legal.<L番号>.*` のフラグの裏に置き、`legal_gate_records` の記録のある範囲でだけ本番で有効にする（[ADR-0043](decisions/0043-flag-taxonomy-legal-gates-and-safety-defaults.md)）。
- **1 変更 1 PR を目安に、差分を小さくする。** geo-index・dispatch は待機を先に入れ替え、S2 からは都市の波で出す（[delivery.md](architecture/delivery.md) の 4 節）。

## Epic

PM が持つ。変更の一覧はここに書かず、各変更の `spec.md` の frontmatter（`epic`）から集計する（[process.md](../../../docs/process.md) の「粒度」）。各 Epic の品質の重点と合否基準は [quality.md](quality.md) の 5 節にある。

| Epic | 目的 | 状態 |
| --- | --- | --- |
| E1 基盤とビルド | AWS・Terraform・CI（Go・TypeScript・契約・ステートマシンのベクター）、Aurora `core`・`money`、KMS の 6 種類の鍵、認証の骨格とワンタイムコード、監査ログ、保持の表の生成、可観測性、フラグ（release・ops・legal）と `legal_gate_records`、アプリの列車とバージョンの方針 | 設計中 |
| E2 事業者と供給 | 事業者・営業所・車両・ドライバーの登録、書類の確認、招待、出庫の判定とセッション、点呼、事業者の管理画面、振込先 | 未着手（乗車の履歴と稼働の地図は法務：L4。ドライバーの登録は L5） |
| E3 位置と索引 | 位置の取り込みと検証、Kinesis と都市のセル、軌跡と当てはめ、索引とリースと再構築、検索、需給の集計、端末の完全性、位置の閲覧の許可 | 未着手（位置の保存の期間は法務：L4） |
| E4 地図と ETA | Valhalla のタイルと配信、ETA と補正と精度、推計走行距離、OSM と ODbL、住所の検索と乗降の地点、区域の多角形 | 未着手（前に ETA・距離・時刻に依る行列の PoC と住所の検索の PoC。推計走行距離は法務：L3） |
| E5 配車 | 提案の契約、バッチとリース、候補の条件、最適化、受け入れの上限、判断の記録、再生・市場のシミュレーション・影の実行 | 未着手（前に最適化の計算の時間の計測） |
| E6 乗車とリアルタイム | ステートマシン、割り当ての確定と世代、提案の時の確かめ直し、タイマー、outbox、オファーの手順、取り消し、journal と復元、不変条件の検査、常時の接続、車の位置、プッシュ通知 | 未着手（キャンセル料の名目は法務：L2・L8。オファーの降車地は L1） |
| E7 運賃 | 金額の型、バージョンつきの運賃の規則、距離制と影の計算、事前確定運賃、価格の群、迎車料金、キャンセル料、メーターの連携、変動運賃、水準の報告、`fare-replay` | 未着手（すべての Story が法務：L2。手数料は L1、表示は L8、変動は L9） |
| E8 決済と精算 | PSP の選定と包み、与信と確定、追加の請求、キャンセル料の請求、台帳、締めと振込、照合、代金の受け取りの形 | 未着手（前に PSP の選定。精算は法務：L6。請求は L1） |
| E9 アプリ | 乗客とドライバーの画面、背景の位置と電池、常時の接続、オファーの画面、ナビの引き継ぎ、journal、ステートマシンのベクター、流しの実車（タクシーだけ） | 未着手（見積もりの文言は法務：L8） |
| E10 安全と信頼 | 緊急の入口と受け付け、乗車の共有、PIN、番号を隠した通話、メッセージ、評価、顔の照合、報告と事故、異常の検知、不正 | 未着手（共有・顔の照合は法務：L4。事故の記録は L7） |
| E11 サポートと運用のツール | 運用の画面、ロールと上限、一時の権限と break-glass、乗車の調べ、軌跡の閲覧、変更の要求、訂正と返金、問い合わせ、監査の照合 | 未着手 |
| E12 日本版ライドシェアと GA の準備 | 日本版ライドシェア（要件、運行枠、台数、拡大、運賃、配車の条件、安全）と、GA の準備（負荷試験 L1〜L11、大阪と DR の訓練、予定の拡大、両リージョンの削除、侵入試験、費用、runbooks） | 未着手（日本版ライドシェアは法務：L2・L5。GA の判定は法務の該当の結論） |
| E13 機械学習（S2） | 特徴量のストア、ETA の残差の補正と影の展開、需要の予測と表示 | 未着手（S2。S1 で NFR-003 に届かなければ ETA の補正だけ前倒し） |
| E14 複数の都市への展開（S2） | 都市のセルを 12 地域へ、分割の表と halo、都市の波の配備、都市ごとの区域・運賃・運行枠のデータ | 未着手（S2） |
| E15 配車と安全の S2 の改善 | 降車の近い実車の候補、予報の自動の取り込み、事故の疑いの検知、VoIP の通話、空車の時間の公平さ、QUIC | 未着手（S2） |

E1〜E12 が MVP（S1）。E13〜E15 は S2 の Epic。領域の文書の「Story の候補」は、この番号で書く。

## Story

各 Story は、着手するときに `changes/YYMMDD-<slug>/` として起票する。ここは計画で、進み具合は各変更の `spec.md` の frontmatter で見る。順序は Epic の中での目安で、依存があるものを先に置いた。各領域の文書の「Story の候補」から集めた。同じ中身の Story が 2 つの文書にあるものは 1 つにした（例：`loc-loadgen` と `loc-load-test`、`spoof-signal-scoring` と `fraud-signal-scoring`、`state-machine-test-vectors` と `trip-app-test-vectors`）。

### E1 基盤とビルド

設計：[infrastructure.md](architecture/infrastructure.md)、[delivery.md](architecture/delivery.md)、[observability.md](architecture/observability.md)、[security.md](architecture/security.md)、[rider-and-driver-apps.md](architecture/rider-and-driver-apps.md) の 5・10 節、[data-model.md](architecture/data-model.md)

| Story | 内容 |
| --- | --- |
| `dev-repo-bootstrap` | Uber の再構築の開発リポジトリ（モノレポ）を作り、`changes/`・`specs/`・開発向けの `AGENTS.md`、CODEOWNERS（`proto/`・`services/trips`・`vectors/` はテックリード、`go/dispatch/solver`・`services/pricing`・`apps/*/safety` は QA の承認も必須）を置く（リポジトリ共通の ADR-0005、delivery の 1.1 節） |
| `aws-accounts-and-network` | アカウント（analytics を含む）、SCP、VPC、エンドポイント、NAT（Slack・Stripe・Figma の Terraform のモジュールを流用。infrastructure の 1・2 節） |
| `terraform-layout` | ルートモジュールの分け方、`cells/<city>`、東京と大阪の状態ファイル、`prevent_destroy`（infrastructure の 10 節） |
| `kms-keys-and-policies` | 6 種類の鍵（`location`・`pii`・`biometric`・`money`・`audit`・`app`）、鍵のポリシー、大阪のレプリカ（security の 6.2 節、[ADR-0036](decisions/0036-location-privacy-keys-retention-and-audited-access.md)） |
| `aurora-core-and-money` | 2 つのクラスタ、Global Database、DB のロールの分離（`trips.state` を更新できるのは Trips だけ。[ADR-0038](decisions/0038-compute-on-fargate-and-data-stores.md)） |
| `ecs-go-services-baseline` | Go のサービスの ECS のテンプレート（ARM64、`GOMEMLIMIT`、OTel、ヘルスチェック、Service Connect） |
| `egress-gateway` | 外部の提供者への送信の集約、宛先の許可の一覧、送る項目の検査 |
| `ci-go-and-contracts` | Go の検査、`buf lint`・`buf breaking`、ステートマシンのベクターと決定表の枠、要件の追跡（delivery の 2.1 節） |
| `mobile-proto-codegen` | buf での Swift・Kotlin の生成とパッケージの配布（apps の 5.3 節） |
| `deploy-pipelines` | 方式ごとのパイプライン（blue/green、ローリング、待機を先にした入れ替え）、時間帯と凍結の検査（delivery の 4 節） |
| `appconfig-flag-taxonomy` | release・ops・legal の 3 種類、AppConfig の検証の関数（緊急の入口を消す構成を拒む）、アプリのフラグの取得の失敗で安全の機能を出す側に倒す |
| `legal-gate-records` | `legal_gate_records` と法務の担当の画面、記録の範囲の外の legal のフラグを拒む検証、月次の突き合わせ（ADR-0043） |
| `auth-token-issuers` | 利用者の種類ごとの発行者と鍵、`kid` の入れ替え（[ADR-0037](decisions/0037-authentication-device-integrity-and-fraud-response.md)） |
| `auth-rider-otp` | 乗客のワンタイムコード、トークン、更新の入れ替え |
| `sms-otp` | ワンタイムコードの SMS、流量の制限、提供者の切り替え（notifications の 8 節。提供者の選定を含む） |
| `service-identity-tokens` | Service Connect の TLS、サービスのトークン、RPC ごとの許可の一覧 |
| `audit-events-core` | `audit_events`、同じトランザクションの書き込み、outbox、log-archive（Object Lock） |
| `retention-table-codegen` | security の 7.2 節の保持の表から、Terraform のライフサイクル・削除のジョブの値を生成し、一致をテストする（PROP-LOC-005） |
| `telemetry-go-and-ts` | 計装の共通の部品、属性の定数、位置の型のログへの受け渡しの lint |
| `slo-dashboards-per-city` | 都市ごとの SLI とダッシュボード、バーンレートの警告（[runbooks/README.md](runbooks/README.md) の 1 節） |
| `alert-routing` | アラートと呼び出しの経路、runbook の URL の注釈の CI の検査 |
| `mobile-release-train` | 週 1 回の列車の自動化（切る、配る、審査、段階の公開の監視と停止）（apps の 10.1 節、delivery の 5 節） |
| `client-version-policy` | `<Brand>-Client` のヘッダー、`client-config`、`recommended_min`・`required_min`、426 の拒否（apps の 10.2・10.3 節） |

### E2 事業者と供給

設計：[supply-and-operators.md](architecture/supply-and-operators.md)、[security.md](architecture/security.md) の 3.6・4 節、[payments-and-payouts.md](architecture/payments-and-payouts.md) の 14 節

| Story | 内容 |
| --- | --- |
| `offices-vehicles-drivers` | 事業者・営業所・車両・ドライバーの表、RLS、ドライバーの状態（supply の 3 節） |
| `operator-onboarding` | 許可・認可の登録と 2 人の承認、期限の通知（supply の 3.1 節） |
| `no-independent-driver-path` | PROP-SUP-005。ドライバーのアプリのトークンで登録の API を呼べないこと（白タクの経路を作らない） |
| `document-review` | 書類の提出・確認・差し戻し・期限（DT-SUP-001、PROP-SUP-002） |
| `driver-invitation-activation` | 招待のコードとドライバーのアプリの有効化（法務：L5） |
| `driver-sessions-and-eligibility` | 出庫の可否（DT-SUP-002）、セッション、`supply.session_changed` の配信（PROP-SUP-004）。E3 の索引と一緒に |
| `roll-call-records` | 点呼の記録の入力と API |
| `operator-console-core` | 事業者の管理画面の役割、登録の画面、監査ログ |
| `operator-console-mfa-sso` | 多要素の認証と大手の SAML |
| `operator-console-trips-and-map` | 乗車の履歴と稼働の地図（`legal.l4.operator_fleet_map`。記録の前は台数と `district` の集計だけ）（法務：L4） |
| `operator-bank-accounts` | 振込先の登録・変更・2 人の承認と通知 |
| `operator-correction-requests` | 事業者からの訂正の申請と増額の確認（support と一緒に） |

### E3 位置と索引

設計：[location-ingestion.md](architecture/location-ingestion.md)、[geospatial-index.md](architecture/geospatial-index.md)、[security.md](architecture/security.md) の 5 節

| Story | 内容 |
| --- | --- |
| `loc-proto-contract` | `LocationBatch`・`LocationSample`・`LocationAck`・`LocationEvent` の定義と生成 |
| `loc-kinesis-stream` | `loc-<city>` のストリーム、シャード、拡張ファンアウトの読み手、KMS |
| `city-cell-module` | 都市のセルの Terraform（`loc-<city>`、geo-index・dispatch の主と待機、大阪の空のストリーム） |
| `loc-ingest-service` | 認証、流量の制限、時刻の補正、Kinesis への書き込み、`backlog` の別の制限 |
| `loc-validation-rules` | V1〜V8 と決定表、PROP-LOC-002〜004 |
| `loc-dedupe-ordering` | 読み手の側の重複の除去と順序（PROP-LOC-001） |
| `geogrid-core` | 自前の六角形の格子 `geogrid`（投影、レベル、ID、`Disk`・`Ring`・`Cover`）と PROJ との突き合わせ（PROP-GEO-007。ADR-0002） |
| `geo-index-core` | 索引の項目、`(region_gen, assignment_epoch, trip_version)` による状態の合わせ方、古い項目、写しの公開（PROP-GEO-002・003） |
| `geo-find-nearby` | 輪を広げる検索と打ち切り（PROP-GEO-001）、`GetDriverLocation` と呼び手の許可の一覧 |
| `geo-shard-lease` | DynamoDB のリース、主と待機、配車の側の切り替え（PROP-GEO-005） |
| `geo-index-rebuild` | Kinesis の直近 35 秒からの再構築、`READY` の判定（PROP-GEO-004） |
| `geo-reconcile-snapshots` | Trips と供給の写しとの定期の照合 |
| `geo-supply-aggregates` | `district` の需給の集計（運用の画面が読む。変動運賃には使わない）と `supply-heat` |
| `lease-aware-deploy` | geo-index・dispatch の待機を先にした入れ替え、Fargate の退役への対応 |
| `driver-session-integrity` | 出庫のときの App Attest・Play Integrity の判定と、セッションのトークン（アプリの `device-integrity-at-session` と 1 つ） |
| `loc-raw-firehose` | Firehose から S3 への Parquet、詰め直し、ライフサイクル（法務：L4 の期間で置き換える） |
| `trip-trail-builder` | 乗車ごとの軌跡、当てはめ、`trip_trails` |
| `speed-sample-extractor` | 1 分の窓の当てはめと `speed-samples` |
| `location-access-grants` | 位置の閲覧の許可、`trail-viewer`、毎日の照合（ADR-0036） |
| `analytics-hmac-copy` | 分析のアカウントへの HMAC の写し |
| `location-log-lint` | 緯度経度をログに書かない lint と、試験・本番のログの検査 |
| `location-lag-metrics` | 位置の区間ごとの遅れの計測 |
| `loc-load-test` | 合成のドライバー（`loc-loadgen`）と負荷試験（5,000 件/秒、GC の停止を含む p99） |
| `geo-index-fault-injection` | 主・主と待機の停止、DynamoDB の失敗、Trips の事象の欠落の注入 |

### E4 地図と ETA

設計：[eta-and-routing.md](architecture/eta-and-routing.md)、[maps-and-geodata.md](architecture/maps-and-geodata.md)

| Story | 内容 |
| --- | --- |
| `osm-import-weekly` | OSM の週 1 回の取り込みと量の検査（PROP-MAP-005） |
| `valhalla-tile-pipeline` | タイルの作成と検査（黄金の経路）、`tile_version` |
| `valhalla-pool-fargate` | Valhalla のタスク、タイルの取得、起動の時間とメモリの計測 |
| `valhalla-serving` | 青緑の切り替え、上限の設定、当てはめ用の組 |
| `timedep-matrix-poc` | 時刻に依る行列（Valhalla の設定の変更）と、時刻に依らない行列 ＋ 補正の表の精度と p99 の比べ |
| `eta-service` | 配車の行列（many-to-one）、受諾の時点の ETA、更新、依頼の前の目安、概算、バージョンの付与 |
| `eta-bias-correction` | 補正の表と毎日の作り直し（PROP-ETA-002） |
| `speed-profile-builder` | 自前の走行からの速度の表と CSV |
| `eta-accuracy-metrics` | 精度の計測の仕事と指標（PROP-ETA-005） |
| `geocoding-provider-poc` | 住所の検索の提供者の PoC（2,000 件の正解。P1〜P10） |
| `places-service-api` | 住所の検索の窓口、提供者の抽象、流量の制限 |
| `place-storage-policy` | 乗客のピンだけを乗車に保存し、提供者の内容を `trip_place_refs` に期限つきで置く（PROP-MAP-004）（法務：L3） |
| `pickup-points-model` | 乗降の地点と提案（PROP-MAP-003） |
| `pickup-points-learned` | 実績から作る候補と運用の確認 |
| `service-area-polygons` | `service_areas`・`service_area_cells`、N03 からの作成、`Contains`（PROP-MAP-001・002） |
| `geodata-change-approval` | 区域と乗降の地点の 2 人の確認の管理画面と変更の要求（support と一緒に） |
| `map-error-candidates` | 地図の誤りの候補の集計と運用の待ち行列 |
| `tile-closure-overrides` | 期間つきの閉鎖の上書きと一覧の出力 |
| `osm-attribution` | ODbL の帰属の表示（apps と一緒に）（派生タイルの扱いは法務：L3） |
| `fare-distance-api` | 推計走行距離の API と通達の要件（PROP-ETA-003・004） |
| `fare-distance-provider-adapter` | 提供者の接続と障害のときに事前確定運賃を出さない扱い（法務：L3） |

### E5 配車

設計：[dispatch-and-matching.md](architecture/dispatch-and-matching.md)、[capacity.md](architecture/capacity.md) の 4 節、[delivery.md](architecture/delivery.md) の 3 節

| Story | 内容 |
| --- | --- |
| `dispatch-propose-contract` | `ProposeOffer` の形と拒否の理由（`NOT_ELIGIBLE` を含む）、`region_gen` |
| `dispatch-batch-loop` | バッチの流れ、区域の周期、1 件のときの即時の解き方 |
| `dispatch-zone-lease` | 配車のリース、待機、Trips からの読み直し |
| `dispatch-eligibility` | E1〜E9 の純粋な関数、DT-DISP-001 と `vectors/eligibility/`（PROP-DISP-002）。Trips の `propose-eligibility-recheck` と一緒に |
| `solver-benchmark-500` | n = 500 での最適化の計算の時間 |
| `dispatch-solver` | コストと最短増加路法（PROP-DISP-001・003・004） |
| `dispatch-greedy-fallback` | 300 ms での貪欲法への切り替え |
| `dispatch-propose-offers` | 提案と拒否の扱い |
| `intake-admission-control` | 受け入れの上限と、断った依頼の需要の記録 |
| `batch-size-cap` | バッチの依頼の上限と待ちの長い順 |
| `dispatch-decision-log` | `DispatchBatchRecord` と Firehose（`spot`） |
| `dispatch-replay-cli` | 再生と結果の出力 |
| `dispatch-replay-ci` | 再生と縮小のシミュレーションを配車の PR で回す CI |
| `market-simulator` | 市場のシミュレーション（PROP-DISP-005・006） |
| `dispatch-shadow-runner` | 影の実行のタスクと 1 週間の基準の集計 |
| `dispatch-decision-lookup` | 判断の記録の引き方と、サポートのツールの画面（support と一緒に） |
| `synthetic-dispatch-probe` | 配車の合成の依頼（合成の区域） |

### E6 乗車とリアルタイム

設計：[trips-lifecycle.md](architecture/trips-lifecycle.md)、[notifications-and-realtime-push.md](architecture/notifications-and-realtime-push.md)、[dispatch-and-matching.md](architecture/dispatch-and-matching.md) の 8 節

| Story | 内容 |
| --- | --- |
| `trip-state-machine-core` | 状態と遷移の表、`decide` と `apply`、`trip_events`、冪等（DT-TRIP-001、PROP-TRIP-003・004） |
| `assignment-fencing` | 割り当ての表と部分一意索引、epoch、提案の検査、ロックの順序（PROP-TRIP-001・002） |
| `region-gen-assignment-compare` | `(region_gen, assignment_epoch)` の比較（Trips・索引・アプリのベクター。PROP-INFRA-001） |
| `propose-eligibility-recheck` | 提案の時の供給・営業区域・運行枠の確かめ直しと `NOT_ELIGIBLE`（DT-DISP-001 の共通のベクター） |
| `trip-timers` | タイマーの表と処理、遅れの監視 |
| `trip-outbox-relay` | outbox、SNS・SQS、バージョンによる捨て方（PROP-TRIP-005） |
| `offer-lifecycle` | オファーの事象（表示 15 秒、期限 16.5 秒、5 秒の取り下げ）（オファーの降車地の表示は法務：L1） |
| `offer-auto-pause` | 時間切れ 2 回の自動の休憩 |
| `rider-cancellation-and-no-show` | 取り消しと無断キャンセル（DT-TRIP-002・003）。料金の請求は E8（法務：L2・L8） |
| `driver-journal-and-replay` | journal の受け取りと遅れた操作（DT-TRIP-004、PROP-TRIP-006）。E9 と一緒に |
| `trip-snapshot-and-restore` | 要約の署名と復元、世代での結び直し。E12 の DR の訓練で確かめる |
| `single-assignment-monitor` | 1 分ごとの一意性の検査と SEV1 |
| `invariant-checkers` | 二重の請求・台数の超過・ログの緯度経度の検査（observability） |
| `trip-route-deviation` | 選んだルートからの逸脱の記録 |
| `rt-proto-contract` | 常時の接続のメッセージの定義と生成 |
| `rt-gateway` | 接続・認証・心拍・未確認の窓・`Goaway`（Go） |
| `rt-router-and-streams` | 事象の規則、Valkey の Stream と `seq`、登録表、ノード宛ての PUBLISH |
| `offer-delivery-path` | `OfferDelivered` の経路と Trips への記録（`delivery_channel`・`shown_elapsed_ms`）、区間ごとの計測 |
| `trip-location-fanout` | 乗客への車の位置の配信（PROP-RT-003） |
| `push-sender` | APNs・FCM、トークンの管理、重複の抑制 |
| `realtime-load-test` | 3 万接続の負荷と携帯の網の模擬 |

### E7 運賃

設計：[pricing-and-fares.md](architecture/pricing-and-fares.md)、[eta-and-routing.md](architecture/eta-and-routing.md) の 7 節、[delivery.md](architecture/delivery.md) の 3 節

| Story | 内容 |
| --- | --- |
| `money-and-rounding` | `packages/money` の `Yen` と有理数、4 つの丸めの関数、lint（PROP-FARE-001・005） |
| `fare-rule-sets` | 運賃の規則の表、Zod の型、2 人の承認、バージョンの不変、有効期間の排他（法務：L2） |
| `fare-rule-change-approval` | 運賃の規則の変更の要求（support と一緒に） |
| `distance-fare-and-shadow-meter` | 距離制の関数、時間距離併用、深夜、影の計算（法務：L2） |
| `upfront-fare-quotes` | 事前確定運賃の見積もり、経路と有料道路の選択、注意事項の同意、停止の区域（DT-FARE-001）（法務：L2・L3・L8） |
| `pre-fixed-fare-route-record` | 推計走行距離と経由地点の保存（`fare_distance_quotes`、持ち主は Pricing）（法務：L3） |
| `pricing-groups` | 価格の群と、配車の候補の条件への受け渡し（E5 と一緒に） |
| `pickup-fees` | 迎車料金（DT-FARE-003）と変動迎車料金の表の試算（法務：L2） |
| `cancellation-fee-rules` | キャンセル料の規則（判定は E6）（法務：L2・L8） |
| `platform-fees` | 事業者の手数料と乗客の手配料（既定 0 円）（法務：L1） |
| `meter-integration-adapter` | メーターの連携の口と 1 社目の製造者（連携の方式が決まってから） |
| `meter-hired-signal` | メーターの実車・空車の信号の取り込み |
| `driver-input-fare-review` | 入力の照合（DT-FARE-004）、写真の提出、運用の確認の画面 |
| `quote-cache-and-limits` | 見積もりのキャッシュ、乗客ごとの上限、推計走行距離の呼び出しの上限 |
| `fare-replay-ci` | `fare-replay`（直近 30 日、差 0）の CI と夜間（90 日） |
| `pricing-shadow-diff` | 影の計算と `fare_shadow_diffs` |
| `dynamic-upfront-fares` | 事前確定型変動運賃の時間帯の表（DT-FARE-005、PROP-FARE-003）。`legal.l2.dynamic_fare`・`legal.l9.dynamic_fare` の裏（法務：L2・L9） |
| `fare-level-reporting` | A〜D の記録、週次の集計、3 か月の報告、守り（PROP-FARE-007）（法務：L2） |

### E8 決済と精算

設計：[payments-and-payouts.md](architecture/payments-and-payouts.md)

| Story | 内容 |
| --- | --- |
| `psp-selection-poc` | PSP の選定（JPY の与信の期間、JCB、手動の確定、MIT、精算のファイル、収納代行の形）と、選定の ADR（法務：L6 の割賦販売法の加盟店の義務） |
| `psp-adapter` | PSP の包み、`psp_operations`、結果不明の照会、Webhook の inbox（PROP-PAY-006） |
| `authorize-at-request` | 与信の額（DT-PAY-001）と `payment_pending` との結合（E6 と一緒に）（法務：L1） |
| `capture-at-trip-end` | 売上の確定（DT-PAY-002）、部分一意索引（PROP-PAY-001・002） |
| `additional-charges-and-receivables` | 追加の請求、未払い、次の依頼の前の支払い（法務：L8 の表示） |
| `cancellation-fee-charging` | キャンセル料の請求（法務：L2・L8） |
| `ledger-core` | 口座と仕訳、釣り合いのトリガー（PROP-PAY-003） |
| `operator-settlement-and-statements` | 締め、明細、手数料の請求書（PROP-PAY-004）（法務：L6） |
| `operator-payouts` | 振込の作成・出金の確認・組戻し |
| `three-way-reconciliation` | 精算・着金・振込の照合（PROP-PAY-005） |
| `collection-model-switch` | 代金の受け取りの形 A・B の切り替えと `legal.l6.*` のフラグ（法務：L6） |

### E9 アプリ

設計：[rider-and-driver-apps.md](architecture/rider-and-driver-apps.md)、[notifications-and-realtime-push.md](architecture/notifications-and-realtime-push.md) の 5 節

| Story | 内容 |
| --- | --- |
| `trip-app-test-vectors` | 遷移の表から作るベクターの生成と、両方のアプリの reducer の CI（trips の `state-machine-test-vectors` と 1 つ） |
| `app-realtime-client` | 両方のアプリの接続・再接続・`seq` の扱い・取り直し |
| `rider-request-flow` | 依頼までの画面（検索、ピン、見積もり、同意、依頼） |
| `quote-and-consent-ui` | 経路の選択、注意事項、内訳、群の選択肢の画面（法務：L8） |
| `rider-supply-preview` | 依頼の前の地図の丸めた車と、乗客の API のキャッシュ（PROP-GEO-006） |
| `rider-trip-tracking` | 迎車中・乗車中の画面、車の位置、バージョンによる表示 |
| `rider-offline-mode` | 乗客のアプリの通信が切れたとき |
| `driver-session-and-onboarding` | 出庫の前の確認と出庫・入庫 |
| `driver-background-location` | 許可、状態ごとの取り方、熱と電池、溜めと送り直し（location の `driver-location-uploader` と 1 つ） |
| `driver-location-recovery` | 止まったときの検知と回復のプッシュ |
| `driver-offer-screen` | オファーの画面、残り時間、受信の確認 |
| `offer-full-screen-notification` | 優先度の高い通知（全画面は許可のあるときだけ）と表示の後の `OfferDelivered` |
| `driver-street-hail-toggle` | 流しの実車の操作（タクシーのドライバーだけ）とオファーの自動の辞退 |
| `nav-handoff-waypoints` | 主要経由地点の URL、間引き、`nav_handoff_targets`、20 のルートの順守の試験 |
| `route-deviation-alert` | 端末での逸脱の知らせ |
| `driver-trip-journal` | journal と送り直し（trips の `driver-journal-and-replay` と一緒に） |
| `driving-mode-ui` | 走行中の操作の制限 |

### E10 安全と信頼

設計：[safety-and-trust.md](architecture/safety-and-trust.md)、[security.md](architecture/security.md) の 9 節

| Story | 内容 |
| --- | --- |
| `emergency-dial-on-device` | 端末だけで動く 110・119 の案内と住所の表示、どの画面にも緊急の入口（apps の `emergency-entry-everywhere` と 1 つ。PROP-SAFE-001） |
| `safety-incident-intake` | `SafetyIncident` の受信、送り直し、当番の呼び出しの直接の経路 |
| `synthetic-safety-probe` | 緊急の通報の合成の監視 |
| `safety-agent-console` | 安全の担当の一覧、受ける・閉じる、監査つきの位置の閲覧（support と一緒に） |
| `share-trip-link` | 乗車の共有のトークン、ページ、期限（PROP-SAFE-002）。`legal.l4.share_trip` の裏（法務：L4） |
| `trip-pin-verification` | PIN（日本版ライドシェアは必須） |
| `masked-calling-poc` | 番号の中継の提供者の PoC と選定の ADR |
| `masked-calling` | `call-proxy`、セッション、案内、運用の回線（PROP-SAFE-003） |
| `in-trip-messaging` | 定型文と伏せ字（保持は法務：L4・L7） |
| `ratings-and-pair-blocks` | 評価と `safety_pair_blocks`（PROP-SAFE-004。配車の E7 の除外と一緒に） |
| `driver-face-check` | 顔の照合（その日の最初の出庫と 1 日 1 回の抜き打ち）、`biometric` の鍵。`legal.l4.driver_face_check` の裏（法務：L4） |
| `incident-reporting` | 報告の受け付けと振り分け |
| `incident-packet-export` | 事業者への書き出し、警察の照会の手順（法務：L7） |
| `trip-anomaly-monitor` | 乗車中の異常の規則と確かめの通知 |
| `arrival-sms-fallback` | 到着の代わりの SMS（1 乗車 1 回） |
| `fraud-signal-scoring` | 偽装と不正の兆しと点数、運用の画面（location の `spoof-signal-scoring` と 1 つ） |
| `promo-abuse-guards` | 端末・カードの指紋ごとの特典の上限 |

### E11 サポートと運用のツール

設計：[support-and-operations-tools.md](architecture/support-and-operations-tools.md)、[security.md](architecture/security.md) の 3.7・5.2 節

| Story | 内容 |
| --- | --- |
| `ops-console-shell` | `ops.<domain>` の画面の基盤、SSO と多要素の認証、ロール |
| `ops-policy-engine` | 方針のデータと判定（DT-OPS-001） |
| `jit-access-grants` | 一時の権限（PROP-OPS-004） |
| `break-glass-and-jit-roles` | 期限つきの役割と break-glass |
| `trip-lookup` | 乗車の探し方と詳細の画面 |
| `trail-viewer-audited` | 理由と監査ログつきの軌跡の閲覧（PROP-OPS-002。location の Story と 1 つ） |
| `trip-conflict-review` | `trip_conflicts` と復元した乗車の確認の画面 |
| `change-requests` | 変更の要求の仕組みと各領域の適用の API（PROP-OPS-001） |
| `fare-adjustment-ui` | 訂正と返金の画面、承認と上限（PROP-OPS-003。payments の `fare-adjustments-and-refunds` と 1 つ） |
| `bulk-refund-dry-run` | 障害のときのまとめての返金 |
| `support-tickets` | 問い合わせ、振り分け、エージェントの下書き |
| `audit-coverage-and-reconciliation` | 書く対象の網羅と毎日の照合 |
| `ops-sse-events` | 社内と事業者の画面の即時の更新 |
| `driver-suspension-by-safety` | 安全の担当による停止と、事業者が解除できないこと |

### E12 日本版ライドシェアと GA の準備

設計：[supply-and-operators.md](architecture/supply-and-operators.md) の 6 節、[pricing-and-fares.md](architecture/pricing-and-fares.md) の 2.5 節、[dispatch-and-matching.md](architecture/dispatch-and-matching.md) の 5 節、[infrastructure.md](architecture/infrastructure.md) の 7 節、[capacity.md](architecture/capacity.md) の 7 節、[security.md](architecture/security.md) の 7・11 節

2 つの流れに分ける。どちらも S1 の本番の開始の前に終える条件だが、日本版ライドシェアは法務（L2・L5）の結論を待つので、GA の準備を止めずに並行して進める（[architecture/README.md](architecture/README.md) の 7 節。2026-09-28 に確定）。

**日本版ライドシェア**（すべて `release.rideshare.*` と legal のフラグの裏）

| Story | 内容 |
| --- | --- |
| `rideshare-requirements` | 書類の rideshare の列、保険の下限、定員、運転者証明（法務：L5） |
| `rideshare-zone-polygons` | 日本版ライドシェアの区域の多角形 |
| `rideshare-allotments` | 運行枠の登録と承認 |
| `rideshare-capacity-enforcement` | 出庫の台数の上限、枠の終わり（PROP-SUP-001） |
| `rideshare-weather-and-event-extensions` | 雨天・酷暑・催しの拡大（DT-SUP-003）（「最大のもの」の読み方は法務：L2） |
| `rideshare-fares` | 係数、事前確定の必須、キャッシュレスの必須（時間制・協議運賃は S2）（法務：L2） |
| `rideshare-cashless-only` | 日本版ライドシェアで `in_vehicle` を拒否する |
| `rideshare-dispatch-rules` | 候補の条件 E1・E5 と PROP-DISP-007。`legal.l2.rideshare_dispatch`・`legal.l5.rideshare_drivers`（法務：L2・L5） |
| `rideshare-safety-requirements` | PIN の必須（ドライブレコーダーは運行管理の通達で必須でない。[safety-and-trust.md](architecture/safety-and-trust.md) の 9 節） |
| `rideshare-activity-reports` | 稼働の記録と報告の取り出し |

**GA の準備**

| Story | 内容 |
| --- | --- |
| `load-test-suite` | 負荷試験 L1〜L11 と見積もりの置き換え |
| `osaka-warm-standby` | 大阪の縮小したウォームスタンバイ |
| `dr-drill` | DR の訓練（staging で四半期ごと。quality の 2.4 節の基準） |
| `prescale-schedules` | 大晦日・催し・雨の予報の予定の拡大 |
| `data-deletion-both-regions` | アカウントの削除と、東京・大阪の両方の削除のジョブ（法務：L4） |
| `pentest-and-fixes` | 外部の侵入試験と修正 |
| `cost-dashboard` | タグごとの費用の可視化、量（転送・LCU・ログ）と可観測性・セキュリティのサービスの額の実測への置き換え |
| `runbooks-e12` | [runbooks/README.md](runbooks/README.md) の 4 節の手順がそろっているかの確かめと、足りない手順の作成 |

### E13 機械学習（S2）

設計：[ml-platform.md](architecture/ml-platform.md)。S1 の計測で NFR-003 に届かなければ、`ml-platform-foundation` の最小の部分と ETA の補正の 3 つの Story を E4 の後に前倒しする。

| Story | 内容 |
| --- | --- |
| `ml-platform-foundation` | S3 の Iceberg、SageMaker の学習と登録、Step Functions、権限 |
| `feature-registry` | `features/` のリポジトリと定義の検査 |
| `feature-pipelines` | バッチと Flink のパイプライン、両方への書き込み（PROP-ML-001） |
| `feature-logging-and-skew` | 配信の記録と PSI の監視 |
| `eta-residual-model` | ETA の残差のモデル、評価、Go の評価器（PROP-ML-004） |
| `eta-model-serving` | `eta-service` への組み込み、代わりの経路、バージョンの記録（PROP-ML-002） |
| `eta-model-shadow-rollout` | 影の実行・配車の再生とシミュレーション・区域の段階・自動の戻し |
| `demand-forecast-block` | 需要の予測のモデルとバッチ |
| `operator-demand-map` | 事業者の管理画面の需要の地図（5 未満のまとめ） |
| `driver-demand-hints` | ドライバーのアプリの「依頼の多い場所」（`district`） |

### E14 複数の都市への展開（S2）

設計：[geospatial-index.md](architecture/geospatial-index.md) の 5.1 節、[infrastructure.md](architecture/infrastructure.md) の 5・9 節、[delivery.md](architecture/delivery.md) の 4.3 節

| Story | 内容 |
| --- | --- |
| `geo-shard-map-halo` | 分割の表と halo、隣の分割への問い合わせ（置き場所の決定を含む） |
| `city-wave-rollout` | 都市の波の配備と設定の変更、波ごとの確認 |
| `city-cells-s2` | 12 地域の都市のセル（`loc-<city>`、geo-index、dispatch）と東京の `metro` の分割 |
| `city-data-onboarding` | 都市ごとの区域の多角形、運賃の規則、運行枠、乗降の地点の登録の手順 |
| `osaka-secondary-sizing` | 大阪の二次を writer と同じ大きさにする |

### E15 配車と安全の S2 の改善（S2）

| Story | 内容 |
| --- | --- |
| `near-dropoff-candidates` | 降車の近い実車のドライバーを候補に入れる（ADR-0004 の S2 の検討。再生・影の実行の関門） |
| `weather-forecast-ingest` | 予報の自動の取り込み（雨天・酷暑の拡大、予定の拡大。提供の条件を確かめてから） |
| `idle-fairness-term` | 空車の時間の公平さの項（再生とシミュレーションの結果で） |
| `crash-detection` | 事故の疑い（端末の加速度）の検知 |
| `voip-calling` | 電話の代わりの VoIP の通話 |
| `realtime-quic` | 常時の接続の QUIC（HTTP/3） |

## エージェントに任せないこと

- **契約（Protocol Buffers、遷移の表、候補の条件の表、運賃の規則の型）の確定**：アプリのバージョンと本番の記録に残った後に変えるコストが最も高い。
- **法務の判断と `legal_gate_records` の作成、legal のフラグの本番の値の変更**（L1〜L9。ADR-0043）。
- **配車の計算の展開の判断**：再生・シミュレーション・影の実行の結果は出せるが、区域のフラグを広げる判断は PM、基準の変更は QA。
- **`fare-replay` で許す差の承認と、運賃の規則の承認（2 人）**。
- **大阪への切り替えの判断、戻した乗車と食い違いの扱い、利用者への告知**：Ops の責任者と PM（[runbooks/disaster-recovery.md](runbooks/disaster-recovery.md)）。
- **ドライバー・乗客の利用の停止**：事業者と運用の人が決める（自動の処置は候補・特典から外すまで）。
- **`required_min` の引き上げ**：Dev と Ops の 2 人の承認。
- **負荷試験・PoC の結果の解釈**：数字は出せるが、上限・予算・退路（Rust の索引、ECS on EC2、ML の前倒し）の採否は Dev と PM の判断。

## 延期の一覧

MVP の後に検討する。E13〜E15 に入れなかったもの。着手するときに `intent.md` から起票する（[intent.md](intent.md) の Non-goals と、各領域の文書の持ち越し）。

- **予約の配車**（`scheduled` の状態と長い流れ。Temporal を検討する。[ADR-0003](decisions/0003-trip-state-and-single-assignment.md)）。
- **相乗り（Pool）**、**フードや荷物の配送**、**複数の国・通貨**、**ドライバーへのインセンティブ**（L5 が先）、**公共ライドシェアの配車**、**自動運転の車両**。
- **アプリ内のターンバイターンのナビ**（外部のナビに引き継ぐ。経由地を守る引き継ぎ先がなければ別の ADR で見直す。[ADR-0008](decisions/0008-navigation-handoff-with-waypoints.md)）。
- **需要に応じた即時の変動運賃**（`method = realtime`。L9 の結論の後に ADR。[ADR-0020](decisions/0020-dynamic-fares-within-authorized-bands.md)）と、需要の予測を運賃・配車のコストに使うこと。
- **車内の録音・録画**（L7 の結論の後に ADR。[safety-and-trust.md](architecture/safety-and-trust.md) の 9 節）。
- **運転免許証の IC の読み取り**（E10 の PoC で決める）。
- **自前のソフトメーター**（[ADR-0019](decisions/0019-meter-fare-sources.md)）、**車載の決済の端末との結合**、**チャージバックの証拠の出し方**。
- **資金移動業の登録（受け取りの形 C）**（L6 の結論で要るときだけ。[ADR-0024](decisions/0024-fare-collection-model.md)）。
- **アプリの共有のコア（Kotlin Multiplatform など）**（2 つのアプリの食い違いの不具合が多ければ。[ADR-0001](decisions/0001-platform-and-stack.md)）、**Live Activities・Android の進行中の通知**。
- **外部のヘルプデスクの SaaS**（量と L4 を見て）、**社内の運用の外部への委託**。
- **索引だけを Rust に替えること**（E3 の負荷試験で GC の停止が p99 を崩したら ADR）、**ETA の深層学習（DeepETA の形）**。
- **S3 の構成**（都市のまとまりのセルに Aurora `core` のシャード、関西の active-active。[ADR-0039](decisions/0039-city-cells-and-osaka-warm-standby.md)）と、ECS on EC2 の再評価（[ADR-0038](decisions/0038-compute-on-fargate-and-data-stores.md) の条件）。
- **日本版ライドシェアの時間制・協議運賃**、**位置の上りを常時の接続にまとめること**（[ADR-0009](decisions/0009-location-upload-and-validation.md) の置き換え）。

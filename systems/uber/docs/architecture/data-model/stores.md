# Data model: DB 以外の置き場所と本文の形

Kinesis の位置の流れ、S3 の配置、DynamoDB のリース、Valkey のキー、SNS・SQS、常時の接続の封筒、outbox の事象の本文、AppConfig のキー、端末の保存、機械学習の置き場所。規約は [data-model.md](../data-model.md) の 3 節。**ここに書く置き場所は、どれも正本ではない**（例外は S3 の軌跡・書類・明細・監査の写しと、AppConfig の設定。どれも保持の期間を持つ）。

## 1. Kinesis Data Streams `loc-<city>`

検証の済んだ位置の流れ。定義元：[location-ingestion.md](../location-ingestion.md) の 6 節、[ADR-0009](../../decisions/0009-location-upload-and-validation.md)。

| 項目 | 値 |
| --- | --- |
| ストリーム | S1 は `loc-tokyo` の 1 本。S2 から都市ごと。大阪にも同じシャード数の空のストリーム（複製しない） |
| 分割キー | `driver_id` |
| 容量 | S1 は 8 シャード（プロビジョンド）。1 記録 約 300 バイト |
| 保持 | 24 時間（最小） |
| 暗号化 | SSE-KMS（`location`） |
| 読み手 | 拡張ファンアウト：geo-index の主・待機、trail-builder、trip-location-fanout。共有：Firehose（→ `loc-raw/`） |

1 記録は 1 バッチ（`LocationEvent`、Protocol Buffers）。

| フィールド | 型 | 説明 |
| --- | --- | --- |
| `driver_id` | string（UUID） | |
| `driver_session_id` | string（UUID） | |
| `city_id` | string | S1 は `tokyo`。S2 は点の `metro` のセルから決める |
| `operator_id` | string（UUID） | |
| `received_at_ms` | int64 | 取り込みの受信の時刻 |
| `batch_seq` | uint64 | セッションの中で単調に増える |
| `samples` | repeated `ValidatedSample` | 下 |
| `state` | `DriverReportedState` | `VACANT`・`HIRED_STREET`・`BREAK` |
| `state_seq` | uint64 | |
| `backlog` | bool | 通信の切断の間に溜めた分 |

`ValidatedSample` ＝ `LocationSample`（`sample_seq`・`elapsed_ms`・`device_time_ms`・`lat_e7`・`lng_e7`・`h_accuracy_dm`・`speed_cms`・`has_speed`・`heading_cdeg`・`has_heading`・`source`・`integrity`）＋ `t_ms`（基準点から求めた時刻）＋ `street_cell`（uint64）＋ `verdict`（`USE_FOR_INDEX`・`TRAIL_ONLY`・`DROP` と理由のコード）。

- 重複の鍵は `(driver_session_id, sample_seq)`。読み手が `sample_seq` と `t_ms` で順序を決める。
- **位置の正確な値を持つ。** 読める役割は `location` の鍵を使えるパイプラインの役割だけ（[security.md](../security.md) の 5.3 節）。

## 2. S3

バケットの名前は開発リポジトリで決める（`<brand>` を含めない）。下は役割とキーの形。保持の正本は [security.md](../security.md) の 7.2 節で、ライフサイクルはそこから生成する。**削除は東京と大阪の両方で行う。**

| 接頭辞 | キーの形 | 形式・中身 | 鍵 | 保持 | 大阪へ複製 | 書く・読む |
| --- | --- | --- | --- | --- | --- | --- |
| `loc-raw/` | `dt=<YYYY-MM-DD>/hour=<HH>/city=<city>/part-<n>.parquet` | 列：`driver_id`・`driver_session_id`・`sample_seq`・`t`・`lat_e7`・`lng_e7`・`h_accuracy_dm`・`speed_cms`・`heading_cdeg`・`source`・`verdict`・`street_cell`・`received_at`。1 時間ごとに詰め直して重複を除く | `location` | 30 日 | しない | Firehose・詰め直し／パイプラインだけ（分析は HMAC の写し） |
| `trip-trails/` | `<yyyymm>/<trip_id>.pb` | `TripTrail`：`trip_id`・`driver_id`・区間ごとの点の列（迎車の開始から降車まで）・当てはめた辺の列・`matched_distance_m`・逸脱の最大 | `location` | 1 年 | する | trail-builder／`trail-viewer` の窓口だけ |
| `speed-samples/` | `dt=<YYYY-MM-DD>/part-<n>.parquet` | 列：`way_id`・`direction`・`edge_id`・`week_bucket_5min`・`speed_kph`・`tile_version`。ID なし | `app` | 2 年 | しない | trail-builder／ETA の速度の表 |
| `supply-heat/` | `dt=<YYYY-MM-DD>/part-<n>.parquet` | 列：`block_cell`・`bucket_5min`・`status`・`count`。ID なし | `app` | 2 年 | しない | geo-index の主／運用・分析・シミュレーション |
| `dispatch-decisions/` | `zone=<zone>/dt=<YYYY-MM-DD>/hour=<HH>/<batch_id>.pb` | `DispatchBatchRecord`（[dispatch-and-matching.md](../dispatch-and-matching.md) の 9.1 節）。位置は `spot` のセル、乗客の個人の情報なし。Athena のテーブル | `location` | 180 日 | しない | Firehose／配車の担当・再生の仕組み |
| `valhalla/tiles/` | `<tile_version>/tiles.tar` | Valhalla のタイル | `app` | 前のバージョンを 24 時間 | する | タイルの作成／Valhalla |
| `eta/bias-tables/` | `<version>.parquet` | 列：`district_cell`・`hour_of_week`・`bias_s`・`n` | `app` | バージョンごと 90 日（L4） | しない | ETA |
| `eta/speed-profiles/` | `<version>/*.csv` | Valhalla の速度の表 | `app` | バージョンごと 90 日（L4） | しない | タイルの作成 |
| `eta/golden-routes/` | `<version>.parquet` | 検査の経路の組 | `app` | バージョンごと 90 日（L4） | しない | タイルの検査 |
| `eta/accuracy/` | `dt=<YYYY-MM-DD>/part-<n>.parquet` | 乗車ごとの予測 `P`・実際 `A`・誤差 `e`。ID は乗車の ID だけ | `app` | 2 年（L4） | しない | ETA／品質 |
| `osm/japan/` | `<date>/japan-latest.osm.pbf`・`.md5`・`checks.json` | OSM の抽出と量の検査の結果 | `app` | 90 日 | する | osm-import |
| `places/poc/` | `ground-truth.parquet` | 住所の検索の PoC の正解（公開の場所だけ） | `app` | 選定の後 1 年 | しない | E4 の PoC |
| `supply-documents/` | `<operator_id or platform>/<document_id>` | 書類の画像（`documents` の目録） | `pii` | 登録の解除から 3 年（L4） | する | 事業者の管理画面／審査の担当 |
| `face-checks/` | `<driver_id>/<check_id>.jpg` | 顔の照合の自撮り | `biometric` | 30 日 | しない | 照合のサービス／安全の担当の監査つきの確認 |
| `incident-packets/` | `<operator_id>/<incident_id>/<packet_id>.zip` | 事業者へのインシデントの書き出し（軌跡を含む） | `location` | インシデントと同じ（L7） | する | 安全の担当 |
| `settlement-statements/` | `<operator_id>/<period_start>/statement.{csv,pdf}`・`fee-invoice.pdf` | 精算の明細と手数料の適格請求書 | `money` | 10 年（想定） | する | Payments／事業者の管理画面 |
| `recon-raw/` | `<source>/<yyyy>/<mm>/<dd>/<external_file_id>` | PSP の精算のファイル・銀行の明細の原本（Object Lock） | `money` | 10 年 | する | 照合 |
| `ledger-archive/` | Iceberg の表 `journal_entries`・`ledger_postings`（月のパーティション） | 13 か月より古い台帳（Object Lock） | `money` | 10 年 | する | 照合・会計 |
| `ci/replay-results/` | `<pr>/summary.json` | 再生の結果（差の集計だけ、`spot`） | `app` | 1 年（L4） | しない | CI（prod の中の専用の役割）|
| `features/`（S2） | Iceberg の表 `<group>`（`entity_key`・`event_time`・`computed_at`・値） | オフラインの特徴量。鍵はセル・時刻・HMAC の ID だけ | `app` | 元のデータの保持を超えない | しない | 学習 |
| `feature-logs/`（S2） | `dt=<YYYY-MM-DD>/part-<n>.parquet` | 列：`request_id`・`model_version`・特徴量・予測・`eta_source` | `app` | 90 日（L4） | しない | ETA のサービス／学習 |
| `demand-forecasts/`（S2） | `city=<city>/dt=<YYYY-MM-DD>/<run>.parquet` | `block` × 15 分 × 60 分先の予測（5 未満のセルは出さない） | `app` | 2 年 | しない | 表示と案内 |
| log-archive `audit/` | `<yyyy>/<mm>/<dd>/<hh>/<chunk>.jsonl.gz`・`digests/<yyyy>/<mm>/<dd>/<hh>.sig` | `audit_events` の写し（Object Lock のコンプライアンスモード） | `audit` | 7 年（既定） | する | 監査の担当 |
| log-archive アプリのログ | Firehose の日付の区切り | 緯度経度・電話番号・名前を含めない | `audit` | 1 年 | しない | 可観測性 |

- `face-checks/` と `incident-packets/` の接頭辞の名前は、この統合で決めた（safety の 12 節は「S3 の顔の画像」とだけ書いていた）。
- 分析のアカウントには、`driver_id`・`rider_id` を 90 日ごとに替わる鍵の HMAC に置き換えた写しだけを置く（B9。[security.md](../security.md) の 2 節）。

## 3. DynamoDB

### 3.1 `geo_shard_leases`

索引の分割と配車の区域のリース。**リージョンごと**（グローバルテーブルにしない）。リースは正しさの前提ではない（正しさは Trips の fencing と一意の索引）。定義元：[geospatial-index.md](../geospatial-index.md) の 5.2 節、[dispatch-and-matching.md](../dispatch-and-matching.md) の 4 節、[ADR-0011](../../decisions/0011-geo-index-sharding-lease-and-rebuild.md)。

| 属性 | 型 | 説明 |
| --- | --- | --- |
| `shard_id`（PK） | S | `geo/<city>/<shard>`・`dispatch/<zone>` |
| `owner_task` | S | ECS のタスクの ID |
| `lease_epoch` | N | 取るたびに 1 増える |
| `expires_at_ms` | N | 持ち主の壁時計での期限（今 ＋ 5,000） |
| `updated_at_ms` | N | |

- 取る：`attribute_not_exists(shard_id) OR expires_at_ms < :now_minus_1000` を条件に、`lease_epoch + 1` と自分を書く。
- 更新：1 秒ごとに `owner_task = :me AND lease_epoch = :held` を条件に期限を延ばす。4 秒更新できなければ自分から降りる。
- オンデマンド、PITR、`app` の鍵。S1 の量：数件。

### 3.2 `geo_shard_map`（S2 から）

分割の表（バージョンつき）。**置き場所（DynamoDB か Aurora）は E14 の前に決める**（持ち越し。[data-model.md](../data-model.md) の 9 節）。どちらでも次の形にする。

| 属性・列 | 説明 |
| --- | --- |
| `version`（PK の一部） | 分割の表のバージョン |
| `shard_id`（PK の一部） | `geo/<city>/<shard>` |
| `metro_cells` | 属する `metro` のセルの一覧 |
| `halo_metro_cells` | 周りの 1 輪の `metro` のセル |
| `active_from` | 切り替えの時刻（両方の索引が温まってから） |

## 4. Valkey

2 つのクラスタ（[ADR-0038](../../decisions/0038-compute-on-fargate-and-data-stores.md)）。**どちらも正本ではない。** 失っても API の読み直しと再計算で戻る。値に緯度経度・電話番号・名前を置かない（例外：`rs:{recipient}` の中のオファーの乗車地。TTL はオファーの期限まで）。

### 4.1 `rt`（常時の接続。クラスタモードを使わない）

定義元：[notifications-and-realtime-push.md](../notifications-and-realtime-push.md) の 3.4・4.1 節、[ADR-0031](../../decisions/0031-per-stream-sequence-redelivery-push-and-sms.md)。

| キー | 型 | TTL・長さ | 中身 | 書く・読む |
| --- | --- | --- | --- | --- |
| `rs:{recipient}` | Stream | 500 件、最古 30 分 | `Envelope`（`seq` を項目に入れる） | rt-router が `XADD`、rt-gateway が再接続で読む |
| `seq:{recipient}` | string（整数） | なし（`stream_epoch` とともに作り直す） | 受け手ごとの `seq` | rt-router が `INCR` |
| `epoch:{recipient}` | string | なし | `stream_epoch`（鍵を作るたびの乱数） | rt-router |
| `conn:{recipient}` | hash | 90 秒（心拍で延ばす） | `node_id`・`connection_id`・`stream_epoch`・`connected_at` | rt-gateway／rt-router |
| `gw:{node}` | Pub/Sub のチャンネル | — | ノード宛ての `Envelope` と `Ephemeral(DriverLocation)` | rt-router・trip-location-fanout → rt-gateway |
| `push:dedupe:{recipient}:{dedupe_key}` | string | 10 秒 | プッシュの重複の抑制（`SET NX`） | push-sender |

- `{recipient}` は `rider:<id>`・`driver:<id>`。

### 4.2 `cache`

| キー | 型 | TTL | 中身 | 書く・読む | 定義元 |
| --- | --- | --- | --- | --- | --- |
| `supply:<city>:<district_cell>` | hash（`state:vehicle_class:service_kind` → 台数） | 10 秒 | 需給の集計。S1 は運用の画面だけが読む（変動運賃に使わない） | geo-index の主 | geospatial-index の 6.4 節 |
| `intake:<city>` | string（整数） | なし（1 分ごとに Trips の `requested` の数と照合） | 未割り当ての依頼の数 | API | capacity の 4 節 |
| `quote:<rider>:<hash>` | string（見積もりの ID の一覧） | 60 秒 | 同じ乗客・同じ乗降（`spot`）の見積もりのキャッシュ | Pricing | capacity の 4 節 |
| `preview:<block_cell>` | string | 10 秒 | 依頼の前の地図の車（`street` の中心、ID なし） | 乗客の API | geospatial-index の 6.3 節 |
| `rl:<scope>:<subject>` | string（GCRA） | 窓 | レート制限（見積もり 1 分 10 回、住所の検索 1 秒 5 回・1 日 500 回、OTP の IP ごとの上限、`Hello` の受け付け） | API・rt-gateway | security、maps の 7.1 節、notifications の 8.1 節 |
| `jti:<issuer>:<jti>` | string | トークンの期限 | 使い捨てのトークンの再利用の検知 | 認証 | security の 4 節 |
| `feat:{group}:{key}`（S2） | hash | 特徴量ごと | オンラインの特徴量。置くクラスタ（`cache` か専用か）は E13 の前に決める | 特徴量の書き手／eta-service | ml-platform の 13 節 |
| `demand:{city}:{block_cell}`（S2） | hash | 15 分 | 需要の予測 | 予測のバッチ／乗客・ドライバーの API | ml-platform の 4.2 節 |

## 5. SNS・SQS

| 名前 | 種類 | 中身 | 購読する側 |
| --- | --- | --- | --- |
| `trips-events` | SNS 標準 | `core` の outbox の事象（7 節） | 下の SQS。事象の種類ごとの購読のフィルター（`event_type` の属性） |
| `payments-events` | SNS 標準 | `money` の outbox の事象（7 節）。名前はこの統合で決めた | `trips-payments`、`fare-levels`、`ops-sse` |
| `geo-index-<city>` | SQS | `driver.assignment_changed`・`supply.session_changed` | geo-index（主・待機はそれぞれ別のキュー） |
| `dispatch` | SQS | `trip.state_changed`（`requested`・取り消し） | dispatch |
| `payments` | SQS | `payment.authorize_requested`・`trip.state_changed`（終わり）・`trip.fare_finalized` | Payments |
| `trips-payments` | SQS | `payment.authorization_succeeded`・`payment.authorization_failed` | Trips（`command_id` ＝ `event_id`） |
| `rt-fanout` | SQS | `trip.state_changed`・`offer.created`・`offer.revoked`・`driver.assignment_changed` | rt-router、trip-location-fanout（割り当ての表） |
| `supply` | SQS | `driver.pause_requested` | supply |
| `trail-builder` | SQS | `trip.state_changed` | trail-builder |
| `safety-monitor` | SQS | `trip.state_changed` | safety-monitor |
| `fare-levels` | SQS | `trip.fare_finalized`・`payment.refunded` | 運賃の水準の集計 |
| `audit-shipper` | SQS | `audit.recorded` | log-archive への書き出し |
| `analytics` | SQS | `trip.state_changed`・`trip.fare_finalized`（位置は `street` まで） | 分析の写し（HMAC） |
| `push-requests` | SQS | プッシュの送信の要求 | push-sender |
| `safety-incidents` | SQS | `SafetyIncident`（API が直接書く。outbox を経ない） | safety の受信、当番の呼び出しの直接の経路 |

- どのキューも DLQ を持つ。届け方は少なくとも 1 回で、順序は保証しない。購読する側は 7 節のバージョンで古い事象を捨てる。
- **`offer.created` は `rt-fanout` だけが購読する**（乗車地の正確な値を含むため。フィルターで他のキューに流さない）。

## 6. 常時の接続の封筒（要約）

正本は [notifications-and-realtime-push.md](../notifications-and-realtime-push.md) の 3.3・4 節（`service Realtime { rpc Connect(stream ClientFrame) returns (stream ServerFrame); }`）。

| メッセージ | 向き | 主なフィールド |
| --- | --- | --- |
| `Hello` | 端末 → | `protocol`（`<brand>.realtime.v1`）、`device_id`、`resume_after_seq`、`stream_epoch`、`client` |
| `Ack` | 端末 → | 受け取った `seq`（累積） |
| `OfferDelivered` | 端末 → | `offer_id`、`shown_elapsed_ms` |
| `AppState` | 端末 → | `foreground`・`background` |
| `Ready` | → 端末 | `stream_epoch`、`head_seq`、`resync_required` |
| `Envelope` | → 端末 | `seq`、`stream_epoch`、`priority`（`HIGH`・`NORMAL`・`LOW`）、`expires_at_ms`、`dedupe_key`、本体（`OfferCreated`・`OfferRevoked`・`TripStateChanged`・`TripEtaUpdated`・`DriverSystemNotice`・`SafetyNotice`・`ChatMessage`） |
| `Ephemeral` | → 端末 | `DriverLocation`（`trip_id`、`lat_e7`・`lng_e7`、`heading_cdeg`、`sample_t`）。`seq` を持たず、送り直さない。有効な割り当ての乗客の接続だけ |
| `Heartbeat` | 両方 | 20 秒ごと。40 秒で切る |
| `Goaway` | → 端末 | 理由（`replaced`・`deploy`）と再接続の待ち |

- `TripStateChanged` の `TripSnapshot` の乗降は `street` に丸めた値。`OfferCreated` の乗車地だけが正確で、TTL はオファーの期限（作成 ＋ 16.5 秒）。

## 7. outbox の事象と本文

`outbox_events`（[trips.md](trips.md) の 3.8 節）の `event_type` と、`payload` の Protocol Buffers。すべての本文は `event_id` と `occurred_at` を持つ。**本文に名前・電話番号を入れない。位置は `offer.created` の乗車地だけが正確で、他は `street` まで。**

### 7.1 `core` → SNS `trips-events`

| `event_type` | 本文 | バージョン（古い事象を捨てる鍵） | 出す時 |
| --- | --- | --- | --- |
| `trip.state_changed` | `TripStateChanged`：`trip_id`、`trip_version`、`region_gen`、`state`、`prev_state`、`TripSnapshot`（署名つき）、`operator_id`、`terminal_reason`、`cancellation_fee_yen` | `(trip_id, trip_version)` | すべての遷移 |
| `driver.assignment_changed` | `DriverAssignmentChanged`：`driver_id`、`assignment_id`、`trip_id`、`rider_id`、`operator_id`、`region_gen`、`assignment_epoch`、`trip_version`、`TripAssignState`（`NONE`〜`ON_TRIP`） | `(driver_id, region_gen, assignment_epoch, trip_version)` の辞書順 | 割り当ての作成・進み・解放 |
| `offer.created` | `OfferCreated`：`offer_id`、`trip_id`、`driver_id`、`region_gen`、`assignment_epoch`、乗車地の `lat_e7`・`lng_e7`（正確）、`pickup_eta_s`、`fare_type`、乗客の評価の要約、`offer_expires_at` | `offer_id` | 割り当ての作成 |
| `offer.revoked` | `OfferRevoked`：`offer_id`、`driver_id`、理由 | `offer_id` | オファー中の取り消し |
| `trip.fare_finalized` | `TripFareFinalized`：`trip_id`、`trip_version`、`operator_id`、`rider_id`、`payment_id`、`fare_type`、内訳の行（整数の円）、`total_yen`、`meter_reading_id`、区間の数 | `trip_id`（1 回だけ出す） | 行 16・18 の確定 |
| `payment.authorize_requested` | `AuthorizeRequested`：`trip_id`、`rider_id`、`rider_payment_method_id`、`amount_yen`（DT-PAY-001）、`fare_quote_id` | `trip_id` | 作成（`payment_pending`） |
| `driver.pause_requested` | `DriverPauseRequested`：`driver_id`、`driver_session_id`、理由（`offer_timeouts`） | `(driver_session_id, 事象の時刻)` | 時間切れの 2 回目 |
| `supply.session_changed` | `SupplySessionChanged`：`driver_id`、`session_id`、`eligibility_ver`、`online`、`service_kind`、`vehicle_class`、`seats`、`operator_id`、`office_id`、`location_untrusted`、`eligible` | `(driver_id, eligibility_ver)` | 出庫・入庫・判定の変化 |
| `pricing.rules_changed` | `FareRulesChanged`：表の名前、`id`、`version`、`status` | `(id, version)` | 規則の承認・有効化 |
| `audit.recorded` | `AuditRecorded`：`audit_events` の行 | `id` | 監査ログの行ごと |

### 7.2 `money` → SNS `payments-events`

| `event_type` | 本文 | バージョン | 出す時 |
| --- | --- | --- | --- |
| `payment.authorization_succeeded` | `trip_id`、`trip_payment_id`、`authorized_yen`、`auth_expires_at` | `trip_payment_id` | 与信の成功 |
| `payment.authorization_failed` | `trip_id`、`trip_payment_id`、`error_code` | `trip_payment_id` | 与信の失敗・時間切れ |
| `payment.captured` | `trip_id`、`captured_yen`、`additional_charge_yen` | `trip_payment_id` | 売上の確定 |
| `payment.refunded` | `trip_id`、`fare_adjustment_id`、`amount_yen`、`funded_by` | `fare_adjustment_id` | 返金の成功（運賃の水準の作り直し） |
| `settlement.closed` | `operator_id`、`settlement_period_id`、`net_yen` | `settlement_period_id` | 締めの確定（事業者の画面の SSE） |

- `audit.recorded` は `money` の監査の行も同じ形で `money` の outbox から出す。

## 8. AppConfig

| キー | 中身 | 変える人 | 定義元 |
| --- | --- | --- | --- |
| `release.*`・`ops.*`・`legal.*` | フラグ。legal は事業者 × 交通圏。本番の true は `legal_gate_records` の範囲だけ（検証の関数） | release：PM が判断し Ops／ops：オンコール／legal：PM と Ops（記録の範囲の中） | [delivery.md](../delivery.md) の 6 節、[ADR-0043](../../decisions/0043-flag-taxonomy-legal-gates-and-safety-defaults.md) |
| `dispatch/<zone>`・`dispatch/synthetic` | 配車の周期・重み・上限・待機場の除外、合成の区域 | 変更の記録と再生の結果つき | dispatch の 15 節、observability の 12 節 |
| `client_policy` | アプリ × OS の `recommended_min`・`required_min` | `release_manager`（変更の要求） | rider-and-driver-apps の 10.3 節 |
| `nav_handoff_targets` | 引き継ぎ先、OS、最低のバージョン、`upfront_allowed` | 同上 | rider-and-driver-apps の 6.2 節 |
| `ops.region.writable`・`region_gen` | 書き込みを受けるリージョンと割り当ての世代 | DR の手順（人の判断） | infrastructure の 14 節、[ADR-0039](../../decisions/0039-city-cells-and-osaka-warm-standby.md) |
| `capacity/<city>`・`prescale_events` | 受け入れの上限の係数、バッチの上限、予定の拡大 | Ops | capacity の 11 節 |
| `ops_policies` | ロール × 操作 × 金額の上限 | 変更の要求（`ops_policy`） | support の 2.1 節 |
| `eta_model`（S2） | 区域ごとのモデルのバージョンと割合 | ML の展開 | ml-platform の 13 節 |

## 9. 端末とリポジトリ

| 置き場所 | 中身 | 保持 |
| --- | --- | --- |
| 端末の SQLite `trip_journal` | `TripCommand` の列（暗号化） | 確定まで |
| 端末の SQLite `location_backlog` | 送り直しの位置（暗号化、900 点まで） | 24 時間 |
| 端末の SQLite `trip_snapshot` | 最新の `TripSnapshot` 1 件（`street` に丸めた位置） | 次の乗車まで |
| 端末の Keychain・Keystore | トークン、端末の識別子 | ログアウトまで |
| 端末の設定 | 最後に得た住所（緊急の画面用）、信頼できる連絡先（サーバーに送らない） | 端末の中だけ |
| 開発リポジトリ `proto/` | 契約（Protocol Buffers） | — |
| 開発リポジトリ `vectors/trip-app/`・`vectors/eligibility/` | ステートマシンと候補の条件の共通のテストのベクター | — |
| 開発リポジトリ `features/`（S2） | 特徴量の定義（YAML ＋ SQL） | — |
| SageMaker Model Registry（S2） | モデルのバージョン、データのバージョン、評価、承認者 | — |

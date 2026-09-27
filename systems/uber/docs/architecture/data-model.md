# Data model: Uber

データモデルの索引。すべての置き場所（Aurora・Kinesis・DynamoDB・S3・Valkey・SNS/SQS・AppConfig・メモリ・端末・開発リポジトリ）と、横断の規則、複数の領域が列を足す表の統合した定義を書く。**各表・各キーの定義の正本は、索引の「定義の場所」にある文書** で、ここには置き場所と、どの Aurora のクラスタに置くか、統合した定義（11 節）だけを書く。実装の変更（`changes/`）でマイグレーションを書くときに、ここと各文書を合わせて更新する。

前提となる決定は、乗車の状態と割り当ての正本は Aurora（[ADR-0003](../decisions/0003-trip-state-and-single-assignment.md)・[ADR-0021](../decisions/0021-trip-transition-function-and-assignment-fencing.md)）、Aurora は `core` と `money` の 2 つのクラスタ（[ADR-0038](../decisions/0038-compute-on-fargate-and-data-stores.md)）、位置は流れとして持ち索引は正本にしない（[ADR-0002](../decisions/0002-h3-geospatial-model.md)）、位置と個人の情報は種類ごとの鍵と保持の期間で分ける（[ADR-0036](../decisions/0036-location-privacy-keys-retention-and-audited-access.md)）、区域は `service_areas` の多角形を正本にする（[ADR-0033](../decisions/0033-osm-import-and-service-area-polygons.md)）。

2026-09-27 の統合の工程で、全領域の文書の「data-model への項目」（location-ingestion、geospatial-index、dispatch-and-matching、eta-and-routing、maps-and-geodata、pricing-and-fares、trips-lifecycle、payments-and-payouts、supply-and-operators、rider-and-driver-apps、notifications-and-realtime-push、safety-and-trust、support-and-operations-tools、ml-platform、security、infrastructure、observability、capacity、delivery）と照合した。統合で決めたこと（重なりの解消、名前の規則）は 10 節にまとめた。

## 1. 置き場所

| 置き場所 | 中身 | 正本か |
| --- | --- | --- |
| Aurora PostgreSQL 18 `core` | 乗車、割り当て（オファーを兼ねる）、タイマー、outbox、供給（事業者・ドライバー・車両・セッション）、運賃の規則と見積もり、区域の多角形と乗降の地点（PostGIS）、安全、評価、認証、通知の端末、監査ログ、法務の記録、社内の運用 | 正本 |
| Aurora PostgreSQL 18 `money` | 支払い、PSP の操作、訂正と返金、台帳、精算、照合 | 正本 |
| Kinesis Data Streams `loc-<city>` | 検証済みの位置の流れ（24 時間） | 正本ではない（失ってよい流れ） |
| DynamoDB `geo_shard_leases` | 索引の分割と配車の区域のリース（リージョンごと） | リースの正本（正しさの前提ではない） |
| S3 | 位置の生の点・乗車の軌跡・集計、配車の判断の記録、Valhalla のタイル、OSM、ETA の表、書類と顔の画像、精算の明細、監査のアーカイブ、特徴量（S2） | 種類ごと（5 節） |
| geo-index のメモリ | オンラインのドライバーの最新の位置と状態 | 正本ではない（35 秒で作り直す） |
| Valkey `rt` | 常時の接続の Stream・`seq`・登録表・Pub/Sub | 正本ではない（API の読み直しが正本） |
| Valkey `cache` | レート制限、需給の集計、見積もりのキャッシュ、受け入れの上限の数 | 正本ではない |
| SNS・SQS | 乗車の事象の配信、配信の振り分け、プッシュの要求、安全の通報の受信 | 正本ではない（outbox から作り直せる） |
| AppConfig | フラグ（release・ops・legal）、配車の設定、`client_policy`、`nav_handoff_targets`、`region_gen`、`ops.region.writable`、容量のパラメーター | 設定の正本 |
| 開発リポジトリ | `proto/`（契約）、`vectors/trip-app/`（状態機械のテストのベクター）、`vectors/eligibility/`（候補の条件の共通のベクター）、`features/`（S2） | 定義の正本 |
| 端末（SQLite、Keychain・Keystore） | journal、送り直しの位置、最新の乗車の要約、トークン、最後に得た住所 | 正本ではない（復元の材料） |

## 2. 横断の規則

- **ID**：内部の ID は UUIDv7（`trips.id` など）。外に出す ID（見積もり、共有のリンク、招待のコード）は推測できない値にする。
- **金額**は円の整数（`bigint`、列の名前は `_yen`）。係数・率は整数の分子と分母（[ADR-0018](../decisions/0018-versioned-fare-rules-and-integer-yen.md)）。
- **時刻**は UTC で保存し、運賃の時間帯の規則と運行枠だけ地域の時刻（Asia/Tokyo）で評価する（[ADR-0001](../decisions/0001-platform-and-stack.md)）。
- **区域は `service_areas` だけが持つ。** 営業区域・交通圏・日本版ライドシェアの区域・運賃の区域・待機場・空港の多角形は、[maps-and-geodata.md](maps-and-geodata.md) の 9 節の `service_areas`（PostGIS）が唯一の正本である。区域を指す列は、どの領域でも `service_areas.area_id`（text）を持ち、列の名前は `*area_id` で終える（`service_area_id`、`fare_area_id`、`pickup_area_ids` など）。他の領域は多角形の写しを表に持たない。判定は同じ節の `Contains`（H3 の写しで絞り、境目は多角形で確かめる。[ADR-0002](../decisions/0002-h3-geospatial-model.md)）だけで行う。
- **位置**は `lat_e7`・`lng_e7`（`int`）。正確な位置を持つ表・キーは、下の表の「位置」の列に印を付け、保持の期間と鍵を [security.md](security.md) の 5.3・7.2 節に従わせる。すべての位置の置き場所は 9 節の一覧に載せる。ログ・メトリクスには H3 の解像度 8 まで。
- **乗降の座標**：乗車の行に書ける座標は、乗客が確かめたピン（`rider_confirmed_pin`）だけ。住所の検索の提供者の内容（表示の名前、提供者の ID、提供者の座標）は、提供者ごとの保存の期限を持つ `trip_place_refs` にだけ置く（[ADR-0034](../decisions/0034-geocoding-provider-and-pickup-points.md)、PROP-MAP-004）。
- **事業者の表**は `operator_id` を持ち、RLS で事業者ごとに分ける（[supply-and-operators.md](supply-and-operators.md) の 3 節）。
- **`core` と `money` をまたぐトランザクションを書かない。** つなぐのは outbox の事象だけ（[ADR-0038](../decisions/0038-compute-on-fargate-and-data-stores.md)）。
- **版**：乗車は `trip_version`。ドライバーの割り当ては `(region_gen, assignment_epoch, trip_version)` の辞書順（[ADR-0039](../decisions/0039-city-cells-and-osaka-warm-standby.md)、[trips-lifecycle.md](trips-lifecycle.md) の 4.2 節）。供給は `eligibility_ver`。購読する側は版で古い事象を捨てる。
- **削除は東京と大阪の両方で**（[ADR-0036](../decisions/0036-location-privacy-keys-retention-and-audited-access.md)）。保持の期間の正本は [security.md](security.md) の 7.2 節の表で、Terraform のライフサイクル・削除のジョブの値はそこから生成する。
- **鍵**：`location`・`pii`・`biometric`・`money`・`audit`・`app` の 6 種類（[security.md](security.md) の 6.2 節）。
- 本家の名前を、表・キー・バケット・ドメインの名前に使わない。`<brand>` で書く（リポジトリ共通の [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。

## 3. Aurora `core` の表

位置の列：◎＝正確な位置を持つ、○＝丸めた位置だけ、—＝位置なし。

### 3.1 乗車と割り当て

| 表 | 中身 | 位置 | 定義の場所 |
| --- | --- | --- | --- |
| `trips` | 乗車の状態機械の正本、乗客が確かめたピン、区域の `area_id`、見積もり、支払いの方法。11.2 節 | ◎ | [trips-lifecycle.md](trips-lifecycle.md) の 14 節 |
| `driver_dispatch_state` | ドライバーごとの `region_gen`・`assignment_epoch`・有効な割り当て | — | trips-lifecycle の 4.1 節 |
| `driver_assignments` | 割り当てとオファーの記録（`offer_id` ＝ `id`）、`decision_id`、配信の列、部分一意索引。11.1 節 | — | trips-lifecycle の 4.1 節 |
| `trip_segments` | 区間の分割（開始・終了の位置） | ◎ | trips-lifecycle の 14 節 |
| `trip_events` | 遷移の記録（追記のみ、月のパーティション、`restored`） | — | 同上 |
| `trip_commands` | 冪等の記録（30 日） | — | trips-lifecycle の 5.2 節 |
| `trip_timers` | 時間で動く事象（`authorization`・`dispatch_deadline`・`offer_delivery`・`offer_expiry`・`no_show_eligible`・`fare_escalation`） | — | trips-lifecycle の 6 節 |
| `outbox_events` | 事象の outbox（配信の後 3 日） | — | trips-lifecycle の 8.1 節 |
| `trip_conflicts` | 遅れて届いた操作・復元の食い違い | — | trips-lifecycle の 8.4 節 |
| `trip_place_refs` | 乗降の提供者の内容（`place_ref`、表示の名前）。提供者ごとの `expires_at` で消す | — | [maps-and-geodata.md](maps-and-geodata.md) の 7.3 節 |
| `trip_eta_snapshots` | 受諾の時点などの ETA と `tile_version`・`correction_version` | — | [eta-and-routing.md](eta-and-routing.md) の 14 節 |
| `trip_trails` | 乗車の軌跡の索引（本体は S3） | — | [location-ingestion.md](location-ingestion.md) の 17 節 |
| `trip_nav_events` | ナビの引き継ぎと逸脱 | — | [rider-and-driver-apps.md](rider-and-driver-apps.md) の 14 節 |
| `trip_messages` | 乗車の中のメッセージ（乗車の終わりから 30 日、L4・L7 で置き換える） | — | [notifications-and-realtime-push.md](notifications-and-realtime-push.md) の 15 節 |
| `demand_rejections` | 受け入れの上限で断った需要（乗客の ID なし） | ○（解像度 8） | [capacity.md](capacity.md) の 11 節 |

### 3.2 供給と事業者

| 表 | 中身 | 位置 | 定義の場所 |
| --- | --- | --- | --- |
| `operators`、`operator_service_areas`、`operator_authorizations`、`offices`、`vehicles`、`drivers`、`driver_licenses`、`driver_attestations`、`documents`、`insurance_policies`、`operator_users` | 事業者・営業所・車両・ドライバー・書類（RLS）。区域は `service_area_id`（＝ `service_areas.area_id`） | — | [supply-and-operators.md](supply-and-operators.md) の 3 節 |
| `driver_sessions` | 出庫のセッション、時刻の基準点（`anchor_server_time`・`anchor_elapsed_ms`）、`location_untrusted`、`paused_by_system_at`、`eligibility_ver` | — | supply の 4.2 節（location-ingestion・dispatch の提案を取り込み済み） |
| `roll_call_records` | 点呼の記録 | — | supply の 4.2 節 |
| `rideshare_allotments`、`rideshare_extensions`、`rideshare_capacity`、`supply_timers` | 日本版ライドシェアの運行枠、雨天・酷暑・催しの拡大、台数の行ロック、枠の境のタイマー | — | supply の 6 節（[ADR-0027](../decisions/0027-rideshare-operating-windows.md)） |
| `driver_identity_checks` | 顔の照合の結果（画像は S3 に 30 日、`biometric` の鍵。`legal.l4.driver_face_check` の裏） | — | [safety-and-trust.md](safety-and-trust.md) の 16 節 |
| `device_integrity_checks` | 出庫の端末の完全性の判定 | — | [security.md](security.md) の 14 節 |

### 3.3 運賃

| 表 | 中身 | 定義の場所 |
| --- | --- | --- |
| `fare_blocks`、`fare_block_members` | 運賃ブロックと交通圏（`area_id`） | [pricing-and-fares.md](pricing-and-fares.md) の 4.1 節 |
| `fare_rule_sets`、`operator_fare_assignments` | 版つきの運賃の規則（`fare_area_id`）と事業者の割り当て | 同上 |
| `pickup_fee_rules`、`dynamic_fare_policies`、`cancellation_fee_rules`、`platform_fee_rules` | 料金の規則 | pricing の 4.3 節 |
| `upfront_suspensions` | 事前確定運賃の停止（`fare_area_id`、期間、理由） | pricing の 5.2 節 |
| `fare_quotes` | 見積もり（位置は入力のハッシュと丸めた値） | pricing の 5.6 節 |
| `fare_distance_quotes` | 推計走行距離の応答（**持ち主は Pricing**。`fare_quotes.distance_quote_id` から指す。表示用の線は提供者の条件の期間） | pricing の 14 節、[eta-and-routing.md](eta-and-routing.md) の 7.3 節 |
| `fare_level_records` | 変動運賃の水準の記録（A〜D） | pricing の 6.3 節 |
| `meter_readings` | メーターの額と受け取り方 | pricing の 5.4 節 |
| `fare_shadow_diffs` | 影の計算の差（30 日） | [delivery.md](delivery.md) の 3.2 節 |

### 3.4 地図と区域

| 表 | 中身 | 位置 | 定義の場所 |
| --- | --- | --- | --- |
| `service_areas`、`service_area_cells` | 区域の多角形（`area_id`・`version`・`kind`）と解像度 9 の写し。**区域の唯一の正本**（2 節） | — | [maps-and-geodata.md](maps-and-geodata.md) の 9.2 節 |
| `pickup_points` | 乗降の地点（施設の地点。個人の位置ではない） | — | maps の 8.1 節 |
| `map_overrides`、`map_error_candidates` | 閉鎖の上書き、地図の誤りの候補 | ○（解像度 9） | maps の 6 節 |
| `rider_saved_places` | 乗客が保存した場所（乗客が確かめたピンと名前だけ） | ◎ | rider-and-driver-apps の 14 節 |

### 3.5 安全

| 表 | 中身 | 位置 | 定義の場所 |
| --- | --- | --- | --- |
| `share_links` | 乗車の共有のリンク（トークンのハッシュ。`legal.l4.share_trip` の裏） | — | [safety-and-trust.md](safety-and-trust.md) の 16 節 |
| `safety_incidents`、`safety_reports`、`incident_packets` | 緊急の通報、報告、事業者への引き渡し | — | 同上 |
| `safety_incident_locations` | 押した後の位置（列の暗号化、`location` の鍵） | ◎ | 同上 |
| `safety_pair_blocks`、`ratings`、`rating_aggregates` | 拒否の組、評価 | — | 同上 |
| `trip_pins` | 乗る車の確認の PIN | — | 同上 |
| `call_sessions`、`call_logs` | 番号の中継（記録 90 日） | — | 同上 |

### 3.6 利用者・通知・認証

| 表 | 中身 | 定義の場所 |
| --- | --- | --- |
| `rider_accounts`、`rider_sessions`、`driver_app_sessions`、`operator_user_sessions`、`passkeys`、`driver_invitations` | 認証 | [security.md](security.md) の 4・14 節 |
| `device_push_tokens` | プッシュの端末のトークン | notifications の 15 節 |
| `otp_challenges`（24 時間）、`sms_messages`（本文なし、90 日） | ワンタイムコードと SMS | 同上 |

### 3.7 監査・法務・不正

| 表 | 中身 | 定義の場所 |
| --- | --- | --- |
| `audit_events` | 監査ログ（月のパーティション、Aurora に 1 年） | [security.md](security.md) の 7.1 節 |
| `location_access_grants` | 位置の閲覧の許可（理由・1 乗車か 1 インシデント・30 分） | security の 5.2 節 |
| `legal_holds` | リーガルホールド | security の 7.2 節 |
| `legal_gate_records` | 法務の結論の記録（legal のフラグの根拠。L 番号、`operator_id`、`fare_area_id`、機能、期間） | [delivery.md](delivery.md) の 6.2 節、[ADR-0043](../decisions/0043-flag-taxonomy-legal-gates-and-safety-defaults.md) |
| `fraud_scores`、`fraud_actions` | 不正の点数と処置 | security の 9 節 |

### 3.8 社内の運用のツール

| 表 | 中身 | 定義の場所 |
| --- | --- | --- |
| `staff_users`、`staff_role_grants` | 社内の担当とロール | [support-and-operations-tools.md](support-and-operations-tools.md) の 14 節 |
| `jit_grants` | 位置以外（個人の情報・通話の記録・メッセージ・報告・書類）の一時の権限。位置は `location_access_grants` | 同上 |
| `change_requests` | お金・規則・データの変更の要求（書き手と承認者を分ける） | 同上 |
| `support_tickets`、`support_ticket_messages` | 問い合わせ | 同上 |
| `auto_refund_rules` | 自動の返金の規則（版つき） | 同上 |

## 4. Aurora `money` の表

| 表 | 中身 | 定義の場所 |
| --- | --- | --- |
| `rider_payment_methods` | PSP のトークンと表示用の情報 | [payments-and-payouts.md](payments-and-payouts.md) の 18 節 |
| `trip_payments`、`psp_operations` | 支払いと PSP の操作（冪等キー、部分一意索引） | payments の 5.1 節 |
| `psp_webhook_inbox` | Webhook の inbox | payments の 7 節 |
| `fare_adjustments` | 運賃の訂正と返金 | payments の 6 節 |
| `rider_receivables` | 追加の請求の未払い | payments の 5.3 節 |
| `ledger_accounts`、`journal_entries`、`ledger_postings`、`ledger_entry_keys` | 複式簿記の台帳（月のパーティション） | payments の 8 節 |
| `settlement_periods`、`operator_payouts` | 締めと振込 | payments の 11 節 |
| `recon_imports`、`recon_breaks` | 照合 | payments の 12 節 |

- `money` の表は `trip_id`・`operator_id` を持つが、`core` の表を外部キーで参照しない（クラスタが別）。整合は outbox の事象と日次の照合で守る。

## 5. Kinesis・DynamoDB・S3

| 置き場所 | 中身 | 保持 | 位置 | 鍵 | 定義の場所 |
| --- | --- | --- | --- | --- | --- |
| Kinesis `loc-<city>` | `LocationEvent`（分割キー `driver_id`） | 24 時間 | ◎ | `location` | [location-ingestion.md](location-ingestion.md) の 6 節 |
| DynamoDB `geo_shard_leases` | `geo/<city>/<shard>`、`dispatch/<zone>` のリース | — | — | `app` | [geospatial-index.md](geospatial-index.md) の 5.2 節、dispatch の 4 節 |
| DynamoDB か Aurora `geo_shard_map` | 分割の表（S2 から） | — | — | — | geospatial-index の 5.1 節（置き場所は E14 の前に決める） |
| S3 `loc-raw/dt=/hour=/city=/` | 生の点（Parquet） | 30 日 | ◎ | `location` | location-ingestion の 7 節 |
| S3 `trip-trails/<yyyymm>/<trip_id>.pb` | 乗車の軌跡 | 1 年 | ◎ | `location` | 同上 |
| S3 `speed-samples/` | 速度の標本（ID なし） | 2 年 | ○ | `app` | 同上 |
| S3 `supply-heat/` | 台数の集計（ID なし、解像度 8） | 2 年 | ○ | `app` | 同上 |
| S3 `dispatch-decisions/zone=/dt=/hour=/` | `DispatchBatchRecord`（解像度 10） | 180 日 | ○ | `location` | dispatch の 9.1 節 |
| S3 `valhalla/tiles/<tile_version>/` | Valhalla のタイル | 前の版を 24 時間 | — | `app` | [eta-and-routing.md](eta-and-routing.md) の 5.2 節 |
| S3 `eta/bias-tables/`、`eta/speed-profiles/`、`eta/golden-routes/` | ETA の補正・速度・検査の組 | 版ごと 90 日（**未検証**の既定） | ○ | `app` | eta-and-routing の 14 節 |
| S3 `eta/accuracy/dt=/` | 乗車ごとの予測と実際（乗車の ID だけ） | 2 年（**未検証**の既定） | — | `app` | 同上 |
| S3 `osm/japan/<date>/` | OSM の抽出 | 90 日 | — | `app` | [maps-and-geodata.md](maps-and-geodata.md) の 4 節 |
| S3 `places/poc/` | 住所の検索の PoC の正解（公開の場所だけ） | — | — | `app` | maps の 15 節 |
| S3 `supply-documents/` | 免許証・車検証・保険の画像 | 登録の解除から 3 年（既定、**未検証**） | — | `pii` | supply の 3 節 |
| S3 顔の画像 | 照合の画像 | 30 日 | — | `biometric` | safety の 12 節 |
| S3 `settlement-statements/` | 精算の明細 | 帳簿と同じ（10 年を想定） | — | `money` | payments の 11.2 節 |
| S3（log-archive）`audit/` | 監査のアーカイブ（Object Lock） | 7 年（既定） | — | `audit` | security の 7.1 節 |
| S3（log-archive）アプリのログ | Firehose 経由 | 1 年 | — | `audit` | [observability.md](observability.md) の 4.2 節 |
| S3 `ci/replay-results/<pr>/` | 再生の結果 | 1 年（**未検証**の既定） | ○ | `app` | delivery の 11 節 |

- S3 の大阪への複製の有無は [infrastructure.md](infrastructure.md) の 6 節の表（`loc-raw/` と `dispatch-decisions/` は複製しない）。

## 6. Valkey・SNS/SQS・AppConfig

| 置き場所 | キー・名前 | 中身 | 定義の場所 |
| --- | --- | --- | --- |
| Valkey `rt` | `rs:{recipient}`、`seq:{recipient}`、`conn:{recipient}`、`gw:{node}` | Stream（500 件・30 分）、登録表、Pub/Sub | [notifications-and-realtime-push.md](notifications-and-realtime-push.md) の 15 節 |
| Valkey `cache` | `supply:<city>:<cell7>` | 需給の集計（10 秒）。S1 は運用の画面だけが読む（変動運賃には使わない） | geospatial-index の 6.4 節、pricing の 14 節 |
| Valkey `cache` | `intake:<city>`、`quote:<rider>:<hash>` | 受け入れの上限の数、見積もりのキャッシュ（60 秒） | [capacity.md](capacity.md) の 4 節 |
| Valkey `cache` | レート制限のキー、`jti` などの一時の値 | — | security |
| SNS | `trips-events` | 乗車の事象 | trips-lifecycle の 8.1 節 |
| SQS | 購読する側ごと（索引、配車、Payments、`rt-fanout`、水準の集計、分析）、`push-requests`、`safety-incidents` | — | trips、notifications、safety |
| AppConfig | `dispatch/<zone>`、`dispatch/synthetic` | 配車の設定、合成の区域 | dispatch の 15 節、[observability.md](observability.md) の 12 節 |
| AppConfig | `client_policy`、`nav_handoff_targets` | アプリの最低の版、ナビの引き継ぎ先 | rider-and-driver-apps の 14 節 |
| AppConfig | `release.*`、`ops.*`、`legal.*` | フラグ | [delivery.md](delivery.md) の 6 節 |
| AppConfig | `ops.region.writable`、`region_gen` | 書き込みを受けるリージョンと割り当ての世代（DR） | [infrastructure.md](infrastructure.md) の 14 節 |
| AppConfig | `capacity/<city>`、`prescale_events` | 受け入れの上限、予定の拡大 | capacity の 11 節 |
| AppConfig | `ops_policies`、`eta_model`（S2） | 運用のロール × 操作 × 上限、ETA のモデルの版 | support の 14 節、ml-platform の 13 節 |

## 7. 契約（Protocol Buffers）

| メッセージ・サービス | 定義の場所 |
| --- | --- |
| `LocationBatch`、`LocationSample`、`LocationAck`、`LocationEvent` | location-ingestion の 4・6 節 |
| `GeoIndex`（`FindNearby`、`SupplyPreview`、`SupplyByCell`、`GetDriverLocation`） | geospatial-index の 6 節 |
| `DispatchBatchRecord`、`ProposeOffer`（`RejectReason` に `NOT_ELIGIBLE`）、`OfferCreated`、`OfferDelivered`、`AcceptOffer`、`DeclineOffer`、`OfferRevoked` | dispatch の 6.4・8・9 節 |
| `TripCommand`、`TripSnapshot`、`TripStateChanged`、`DriverAssignmentChanged`（いずれも `region_gen` を持つ） | trips-lifecycle の 8 節 |
| `ClientFrame`、`ServerFrame`、`Hello`、`Ready`、`Envelope`、`Ephemeral`、`DriverLocation` | notifications の 15 節 |
| `NavigationHandedOff`、`RouteDeviationObserved` | rider-and-driver-apps の 14 節 |
| `SafetyIncident` | safety-and-trust の 4 節 |
| `FareDistance`（`Estimate`） | eta-and-routing の 7.1 節 |

## 8. 機械学習（S2 以降、E13）

| 置き場所 | 中身 | 定義の場所 |
| --- | --- | --- |
| リポジトリ `features/` | 特徴量の定義 | [ml-platform.md](ml-platform.md) の 13 節 |
| S3 Iceberg `features/<group>/` | オフラインの特徴量（元のデータの保持を超えない） | 同上 |
| Valkey `feat:{group}:{key}` | オンラインの特徴量（正本ではない）。どの Valkey のクラスタに置くか（`cache` か専用か）は E13 の前に決める | 同上 |
| S3 `feature-logs/` | 配信の時の特徴量と予測（90 日、**未検証**の設計の値） | 同上 |
| Valkey `demand:{city}:{cell8}`、S3 `demand-forecasts/` | 需要の予測 | 同上 |
| SageMaker Model Registry | モデルの版と評価 | 同上 |

## 9. 位置を持つ置き場所の一覧

NFR-009 と [security.md](security.md) の 5・7 節の守りを、置き場所ごとに引けるようにした一覧。**正確な位置を持つ新しい置き場所を足すときは、この表に行を足し、[quality.md](../quality.md) の位置の漏洩の経路の表にも行を足す。**

| 置き場所 | 粒度 | 誰の位置 | 保持 | 読める人・経路 |
| --- | --- | --- | --- | --- |
| Kinesis `loc-<city>` | 正確 | ドライバー | 24 時間 | 索引、trail-builder、trip-location-fanout、Firehose（`location` の鍵の役割） |
| geo-index のメモリ | 正確 | ドライバー | 最長 10 分（正本ではない） | `FindNearby`（dispatch・ETA）、`GetDriverLocation`（Trips・ETA・share-service・safety-monitor）、`SupplyPreview` は解像度 9 の中心だけ |
| S3 `loc-raw/` | 正確 | ドライバー | 30 日 | パイプラインの役割だけ。分析は HMAC の写し |
| S3 `trip-trails/`、`trip_trails` | 正確 | ドライバー（乗車の区間） | 1 年 | `trail-viewer` の窓口（`location_access_grants`、監査 100%） |
| `trips`・`trip_segments` の乗降のピン | 正確 | 乗客が確かめた地点 | 乗車の記録の期間（法務の結論待ち） | 乗車の相手（乗車の間）、事業者（乗車の間。乗車の後は解像度 9）、運用（解像度 9。正確な値は一時の権限） |
| `rider_saved_places` | 正確 | 乗客が保存した地点 | アカウントの削除まで | 本人だけ |
| `safety_incident_locations` | 正確 | 緊急の入口を押した人 | L7 の結論まで（既定 3 年、**未検証**） | 安全の担当（インシデントの ID の許可、監査） |
| Valkey `rt` の Stream | オファーの乗車地は正確、`TripSnapshot` は解像度 9 | 乗客の乗車地 | オファーの期限・30 分 | 割り当てのドライバーの接続だけ |
| `DriverLocation`（一時のメッセージ） | 正確 | ドライバー | 保存しない | 有効な割り当ての乗客の接続だけ（PROP-RT-003） |
| 乗車の共有のページ | 正確（車の位置） | ドライバー | 保存しない（乗車の終わりで止める） | 共有のトークンを持つ人。**NFR-009 の例外 1**、`legal.l4.share_trip` の裏 |
| 事業者の稼働の地図 | 正確（自社の車） | ドライバー | 保存しない | 事業者の運行管理の役割（監査）。**NFR-009 の例外 2**、`legal.l4.operator_fleet_map` の裏 |
| S3 `dispatch-decisions/` | 解像度 10 | 乗客の乗降・ドライバー | 180 日 | 配車の担当、再生の仕組み |
| S3 `speed-samples/`・`supply-heat/`、Valkey `supply:*`、`demand_rejections`、`map_error_candidates`、特徴量 | 解像度 7〜10、ID なし（特徴量は HMAC の ID） | 集計 | 2 年まで（特徴量は元のデータの保持まで） | 運用・分析・ETA |
| 端末の `trip_journal`・`location_backlog` | 正確 | 本人（ドライバー） | 確定まで・24 時間 | 端末だけ（暗号化） |
| ログ・メトリクス・トレース | 解像度 8 まで | — | 30 日・1 年 | 緯度経度は 0 件（検査で 1 件で呼び出し） |

## 10. 統合で決めたこと（2026-09-27）

| # | 論点 | 決定 |
| --- | --- | --- |
| 1 | `trip_offers` の列を dispatch と trips の両方が提案していた | **`trip_offers` の表は作らない。** オファーは `driver_assignments` の行（`offer_id` ＝ `id`）で、dispatch の提案の列（`decision_id`、`pickup_eta_s`、`eta_source`、`decline_reason`）と、オファーの配信の列（`offer_expires_at`、`delivered_at`、`delivery_channel`、`shown_elapsed_ms`）をこの表に足した。結果は `status`（`accepted`・`declined`・`expired`・`undelivered`・`revoked` など）で表す。observability・ADR-0040 の `trip_offers.decision_id` を `driver_assignments.decision_id` に直した |
| 2 | `driver_sessions` の列を location・dispatch・supply が足している | supply の 4.2 節の定義に取り込み済み（`anchor_*`、`location_untrusted`、`paused_by_system_at`）を確かめた |
| 3 | `fare_distance_quotes` の持ち主（eta か pricing か） | **持ち主は Pricing。** `fare-distance`（TypeScript）が書き、`fare_quotes.distance_quote_id` から指す。eta-and-routing の 14 節は提案として残す。保持は運賃の記録と同じで、表示用の線（`polyline_expires_at`）だけ提供者の条件の期間で消す |
| 4 | 区域の多角形と区域の ID の持ち方が領域ごとに違った（`fare_region_id`、`service_area_id`、「営業区域と交通圏の `area_id`」） | **`service_areas` を唯一の正本にし、区域を指す列はすべて `service_areas.area_id` を持ち、名前を `*area_id` で終える**（2 節）。`fare_region_id` を `fare_area_id` に改めた（pricing・delivery）。`trips` は `pickup_area_ids`・`dropoff_area_ids`（区域の版つき）を持つ |
| 5 | 乗降の提供者の内容が `trips` に入っていた（`place_ref`） | `trips` には乗客が確かめたピンだけを置き、提供者の内容は `trip_place_refs` に分けて提供者ごとの期限で消す（ADR-0034、PROP-MAP-004） |
| 6 | 位置の置き場所が領域ごとに散っていた | 9 節の一覧にまとめた。Valkey に最新の位置の写しを置く案は採らない（到着の判定も `GetDriverLocation`。ADR-0011） |
| 7 | 顔の画像の鍵（safety は専用、security は `pii`） | **専用の `biometric` の鍵**（6 種類目）。security.md の 6.2 節と ADR-0036 を直した |
| 8 | `assignment_epoch` の比較に `region_gen` を入れる（ADR-0039） | `driver_dispatch_state`・`driver_assignments` に `region_gen` を持ち、比較は `(region_gen, assignment_epoch)`。trips-lifecycle の 4.2 節、geospatial-index の 4.2 節、`TripCommand`・`TripSnapshot` に反映した |
| 9 | `region.writable` と `ops.region.writable` の 2 つの名前 | `ops.region.writable`（ops のフラグ）に揃えた |
| 10 | 乗車の記録（`trips`・運賃）の保持の期間 | 法務の結論まで未定（[security.md](security.md) の 7.2 節）。持ち越し |
| 11 | ml-platform の `feature-logs/` と特徴量の保持の期間（元の位置の保持を超えない規則） | security.md の 7.2 節の表に E13 の前に足す。持ち越し |

残り（マイグレーションを書く Story で確かめる）：

- すべての事業者の表に RLS があり、例外（この基盤の運用の横断の読み取り）が理由と監査つきに限られることを、マイグレーションの CI の許可リストと照合する（E1・E2）。
- `geo_shard_map` の置き場所（DynamoDB か Aurora）は E14 の前に決める。
- `eta/`・`ci/replay-results/` の保持の既定（**未検証**）を security.md の 7.2 節の表に足す（E4・E5）。

## 11. 統合した定義

### 11.1 `driver_assignments`（割り当てとオファー）

列の持ち主：◇ Trips（遷移関数）、△ 配車の提案が渡す値、▽ オファーの配信（notifications の経路で Trips が記録）。表は Trips だけが書く（[ADR-0021](../decisions/0021-trip-transition-function-and-assignment-fencing.md)）。

| 列 | 持ち主 | 中身 |
| --- | --- | --- |
| `id` | ◇ | UUIDv7。`offer_id` として外に出す |
| `trip_id`、`driver_id`、`vehicle_id`、`operator_id`、`driver_session_id`、`service_kind` | ◇ | 提案の検査で確かめた値 |
| `region_gen`、`assignment_epoch` | ◇ | 作成の時の世代と epoch（作成で増やした後の値） |
| `status` | ◇ | `offered`・`accepted`・`arriving`・`arrived`・`on_trip`・`declined`・`expired`・`undelivered`・`revoked`・`released`・`driver_cancelled`・`completed`・`no_show` |
| `decision_id` | △ | `<zone>/<batch_id>`。`DispatchBatchRecord` を引く鍵 |
| `pickup_eta_s`、`eta_source` | △ | 提案の時の迎車の ETA と出どころ（`valhalla:<tile_version>`・`fallback`） |
| `offer_expires_at` | ◇ | 作成 ＋ 16.5 秒（ADR-0015） |
| `delivered_at`、`delivery_channel`、`shown_elapsed_ms` | ▽ | `OfferDelivered` を記録した時刻、経路（`stream`・`push`・`api`）、端末での受信から表示までの時間 |
| `decline_reason` | ◇ | `driver`・`street_hail` など |
| `pickup_eta_s_at_accept`、`promised_arrival_at` | ◇ | 受諾の時点の ETA（`trip_eta_snapshots` と同じ値）と約束の到着 |
| `created_at`、`accepted_at`、`ended_at`、`end_reason` | ◇ | — |

索引：`one_active_assignment_per_driver`・`one_active_assignment_per_trip`（部分一意、NFR-005）、`(trip_id, created_at)`（試したドライバーの一覧）、`(decision_id)`。

### 11.2 `trips`（乗降の列）

| 列 | 中身 |
| --- | --- |
| `pickup_pin`・`dropoff_pin` | 乗客が確かめたピン（`lat_e7`・`lng_e7`、`origin=rider_confirmed_pin`）。降車地のない依頼は `dropoff_pin` が NULL |
| `pickup_point_id` | 乗降の地点を選んだとき（`pickup_points`） |
| `pickup_area_ids`・`dropoff_area_ids` | 乗車の作成の時に `Contains` で求めた区域（`service_areas.area_id` と版の組の配列）。営業区域の判定（配車の E4 の条件）と運賃の区域に使う |
| `city_id` | 乗車地の H3 の解像度 6 の親から決めた都市（ADR-0039）。乗車の間は変えない |

提供者の内容は `trip_place_refs` に置く（10 節の 5）。

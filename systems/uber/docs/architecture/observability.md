# Observability: Uber

ログ、メトリクス、トレース、アプリの計測、都市ごとの SLI と SLO、配車の判断の記録の引き方、アラートと runbook の対応、合成の監視。道具は Slack の [ADR-0021](../../../slack/docs/decisions/0021-observability-stack.md) を引き継ぐ（OpenTelemetry → AMP・X-Ray・CloudWatch Logs、Grafana で横断）。SLO の値とアラートの一覧の正本は、Ops の [runbooks/README.md](../runbooks/README.md) に置く。ここには、それを計る仕組みを書く。

| ADR | 決定 |
| --- | --- |
| [0040](../decisions/0040-per-city-slis-and-slos.md) | SLO は都市ごとに、依頼・位置・遷移・支払い・緊急の通報の事象で数える。「候補なし」の判断は良い事象にする。不変条件（二重の割り当て・二重の請求・台帳の釣り合い・台数の超過・緯度経度のログ）は SLO にせず、1 件で呼び出す |

## 1. 全体の流れ

```
Go のサービス（loc-ingest・geo-index・dispatch・eta・rt-gateway など）
TypeScript のサービス（api・trips・pricing・payments・supply など）
   │ OTLP（各タスクの ADOT Collector のサイドカー）
   ├─ metrics ─▶ AMP
   ├─ traces  ─▶ X-Ray（標本化。依頼・遷移・支払いは 100%、位置は 0.1%）
   └─ logs    ─▶ CloudWatch Logs ─▶ Firehose ─▶ log-archive の S3（1 年）

配車の判断の記録 DispatchBatchRecord ─▶ Firehose ─▶ S3 dispatch-decisions/（location の鍵、180 日）─▶ Athena
アプリ（乗客・ドライバー）── 集計した計測・受信の確認 ──▶ api ─▶ AMP
AWS のリソース（Kinesis・Aurora・Valkey・ALB・DynamoDB）─▶ CloudWatch のメトリクス
合成の監視（東京の 3 AZ、大阪）─▶ AMP

Grafana（shared）：都市ごとのダッシュボード
アラート：AMP のルール → Alertmanager → SNS → 呼び出しの道具。AWS のリソースは CloudWatch アラーム → SNS
```

## 2. 計装の規則

- 計装は、Go は `internal/telemetry`、TypeScript は `packages/telemetry` に集め、属性名・メトリクスの名前・SLI の名前を定数で持つ（ADR-0040 の Confirmation）。
- 共通の属性：`service.name`、`service.version`、`deployment.environment`、`cloud.region`、`cloud.availability_zone`、`city`、`zone`（配車の区域）、`region_gen`。
- **書いてよいもの**：`trip_id`、`offer_id`、`decision_id`（バッチの ID）、`driver_session_id`、`assignment_epoch`、`trip_version`、H3 の解像度 8 までのセル、件数、時間、理由のコード。
- **書かないもの**：緯度経度、住所・検索の入力、電話番号、名前、メッセージの本文、カードの情報（[security.md](security.md) の 1 節）。Go の位置の型は `String()` を持たず、TypeScript は位置の型をログの引数に渡すことを lint で禁じる。
- `trip_id`・`driver_id` はログとトレースの属性に書くが、**メトリクスのラベルには入れない**。メトリクスのラベルは `city`・`zone`・`service`・`version`・理由のコードまで。
- トレースの伝播：アプリの要求 → api → trips → dispatch の提案まで、1 つの依頼を W3C の traceparent でつなぐ。配車のバッチは多数の依頼を扱うので、バッチのスパンから各依頼のトレースへリンク（span link）を張る。

## 3. 主なメトリクス

| 領域 | メトリクス | 使い道 |
| --- | --- | --- |
| 位置 | `loc_samples_total{verdict}`、`loc_ingest_seconds`、`loc_kinesis_put_seconds`、`geo_apply_lag_seconds`（受信から索引への適用）、`geo_stale_drivers_ratio` | NFR-002、V1〜V8 の率 |
| 索引 | `geo_find_nearby_seconds`、`geo_standby_fallback_total`、`geo_lease_epoch`、`geo_rebuild_seconds`、`geo_reconcile_diff_total` | [geospatial-index.md](geospatial-index.md) の 13 節 |
| 配車 | `disp_request_to_decision_seconds`、`disp_batch_stage_seconds{stage}`、`disp_greedy_fallback_total`、`disp_eta_fallback_ratio`、`disp_pending_requests`、`disp_proposal_rejected_total{reason}`、`disp_intake_rejected_total`（受け入れの上限） | NFR-001、[dispatch-and-matching.md](dispatch-and-matching.md) の 15 節 |
| ETA | `eta_request_seconds`、`valhalla_up`、`eta_error_seconds`（日次の集計）、`eta_tile_version` | NFR-003 |
| 乗車 | `trip_transition_total{result}`、`trip_timer_lag_seconds`、`trip_outbox_oldest_seconds`、`trip_double_assignment_found`、`trip_conflicts_total`、`trip_restored_total` | NFR-005・NFR-007 |
| 配信 | `rt_connections`、`rt_offer_delivered_seconds`、`rt_state_delivery_seconds`、`rt_resync_total`、`push_send_total{result}` | NFR-008 |
| 支払い | `pay_auth_total{result}`、`pay_capture_lag_seconds`、`pay_unknown_outcomes`、`pay_double_capture_found`、`recon_breaks_overdue` | NFR-006 |
| 安全 | `safety_incident_ack_seconds`、`safety_incident_unacked`、`safety_intake_queue_oldest_seconds` | NFR-010 |
| 供給 | `supply_online_sessions{service_kind}`、`rideshare_capacity_exceeded`、`supply_checkin_rejected_total{reason}` | [supply-and-operators.md](supply-and-operators.md) の 14 節 |

## 4. ログ

### 4.1 規則

- 構造化したログ（JSON）。要求・遷移・バッチ・ジョブに `request_id`・`trip_id`・`decision_id`・`job_id` を付ける。
- 位置の点ごとのログは書かない（S1 で 2,500 件/秒）。検証の結果は `loc_samples_total{verdict}` で数え、ログには 1 分ごとの集計だけを書く。
- レベル：`error` は Ops が見るべきもの、`warn` は自動で回復したもの、`info` は状態の変化（リースの取得、区域の切り替え、タイルの版の切り替え）。
- 試験のログの検査：結合試験のログ・トレースの全体に、緯度経度の形の値が 0 件（[location-ingestion.md](location-ingestion.md) の 14.3 節）。本番でも、log-archive に毎日同じ検査を流し、見つかれば 1 件で呼び出す。

### 4.2 保持

| ログ | 保持 |
| --- | --- |
| アプリのログ（CloudWatch Logs） | 30 日 |
| log-archive の S3（Firehose 経由） | 1 年 |
| 配車の判断の記録 | 180 日（[ADR-0015](../decisions/0015-offer-protocol-decision-log-and-replay.md)） |
| 監査ログ | [security.md](security.md) の 7 節 |

## 5. 配車の判断の記録の引き方

- 正本は `DispatchBatchRecord`（[dispatch-and-matching.md](dispatch-and-matching.md) の 9.1 節）。可観測性の側では中身を写さない。
- 引き方：乗車の ID → `driver_assignments.decision_id`（オファーを出したバッチ。オファーの記録は `driver_assignments` が兼ねる）→ S3 の `dispatch-decisions/zone=/dt=/hour=/` を Athena で引く。オファーのない依頼（候補なし）は、依頼のスパンの属性 `decision_id` から引く。
- 「なぜこのドライバーか」「なぜ誰も来ないか」の問い合わせは、サポートのツールの「配車の判断」の画面で、1 つの依頼に関わる行（候補、条件の判定の理由のコード、ETA、コスト、結果）だけを出す。位置は解像度 10 のセルで、地図に点を出さない。閲覧は監査ログに残す。
- Grafana の「配車の区域」のダッシュボード：バッチの段ごとの時間、未割り当ての依頼の数、受け入れの上限で断った数、候補の数の分布、貪欲法の率、ETA の概算の率、提案の拒否の理由。

## 6. SLI と SLO

[ADR-0040](../decisions/0040-per-city-slis-and-slos.md) による。都市ごと（S1 は `tokyo`）に計る。

| SLI | 計り方 | SLO（月間、都市ごと） | NFR |
| --- | --- | --- | --- |
| `dispatch_decision` | trips の `requested` の時刻から、dispatch が最初の判断（提案か「候補なし」の記録）をした時刻まで 5 秒以内。受け入れの上限で断った依頼は分母に入れない | 99.9% | NFR-001、NFR-004 |
| `dispatch_intake` | 依頼・見積もりの API の 5xx・タイムアウトでない応答（混雑の 429 は除く） | 99.99% | NFR-004 |
| `location_freshness` | `USE_FOR_INDEX` の点が、受信から 1 秒以内に索引に適用された割合 | 99% | NFR-002 |
| `trip_transition` | アプリの遷移の操作の、5xx・タイムアウトでないコミット（409 の状態の不一致は良い） | 99.95% | NFR-007 |
| `state_delivery` | 状態の変化の、outbox の作成から相手のアプリの受信の確認まで 2 秒以内 | 95% | NFR-008 |
| `offer_delivery` | オファーの作成から `OfferDelivered` まで 1.5 秒以内 | 95% | ADR-0015 |
| `payment_auth` | 与信が結果を得た（カードの拒否は良い。PSP の 5xx・時間切れ・この基盤の誤りは悪い） | 99.9% | NFR-006 |
| `payment_capture` | `completed` から 1 時間以内に売上の確定が成功 | 99.9% | NFR-006 |
| `emergency_ack` | `SafetyIncident` の受信から担当が受けるまで 30 秒以内 | 95% | NFR-010 |
| `eta_accuracy` | 1 日の迎車の ETA の誤差の中央値 60 秒・p90 180 秒以内（[ADR-0016](../decisions/0016-valhalla-serving-traffic-and-eta-accuracy.md) の定義） | 30 日のうち 27 日 | NFR-003 |

- `dispatch_decision` の 5 秒は、NFR-001 の p99 に合わせた。NFR-001 の p95 3 秒は、`disp_request_to_decision_seconds` の p95 として別に見る（quality.md）。
- NFR-004 の 99.99% は、`dispatch_intake` と `dispatch_decision` の両方で見る。`dispatch_decision` は判断の遅れを数えるので、配車のタスクの引き継ぎ（最大約 6.5 秒）で悪い事象が出る。月に 99.9% までを許す。
- 不変条件（1 件で呼び出し）：二重の割り当て（1 分ごとの検査）、二重の売上の確定（日次）、台帳の釣り合いの失敗、rideshare の台数の超過（1 分ごと）、ログの緯度経度（日次）、位置の閲覧と監査ログの件数の差（日次）。
- エラーバジェットの方針は Slack と同じ。バジェットを使い切った都市では、その都市の配車・運賃・Trips の変更を止める（修正だけ）。

## 7. アプリの計測

- アプリは、オファーの受信・表示・受諾の送信の時刻（端末の経過の時計）、状態の変化の受信、位置の送信の間隔、電池、クラッシュを、集計してから送る（[rider-and-driver-apps.md](rider-and-driver-apps.md) の 14 節）。緯度経度と画面の文字は送らない。
- `state_delivery` と `offer_delivery` は、アプリの受信の確認（`Ack`・`OfferDelivered`）をサーバーで計る。アプリの時計は使わない。
- 版ごとの比較（クラッシュ、ANR、受信の確認までの時間）は、段階的な公開の判断に使う（[delivery.md](delivery.md) の 7 節）。

## 8. アラートと runbook

呼び出し（page）は、利用者に影響が出ているか、放っておくとお金・乗車・安全を損なうものだけにする。名前だけを書いた runbook は、各領域が提案したもの。

| アラート | 条件 | 重さ | runbook |
| --- | --- | --- | --- |
| 配車の SLO の速いバーンレート | `dispatch_decision` か `dispatch_intake` の 1 時間のバーンレートが 14.4 倍（都市ごと） | page | [incident-response.md](../runbooks/incident-response.md) の「都市の配車の停止」 |
| 配車の SLO の遅いバーンレート | 6 時間で 6 倍 | ticket | 同上 |
| 配車の成立率の低下 | 成立率が同じ曜日・時間帯の 4 週の中央値より 15 ポイント低い状態が 15 分 | ticket | `dispatch-match-rate-drop.md` |
| 未割り当ての依頼の急増 | `disp_pending_requests` が受け入れの上限の 80% | ticket | `dispatch-match-rate-drop.md`、[capacity.md](capacity.md) の 10 節 |
| 索引の遅れ | `geo_apply_lag_seconds` の p99 が 3 秒（警告）、10 秒（page） | page | [incident-response.md](../runbooks/incident-response.md) の「位置の取り込みの遅れ」、`geo-index-lag.md` |
| 位置の取り込みの失敗 | loc-ingest の 5xx が 1% を 5 分、Kinesis の `WriteProvisionedThroughputExceeded` が続く | page | 同上、`location-ingest-lag.md` |
| 索引の再構築が長い | 主と待機がともに `READY` でない状態が 60 秒 | page | `geo-index-rebuild.md` |
| 配車のタスクの引き継ぎが長い | 区域のリースの持ち主がいない状態が 15 秒 | page | `dispatch-zone-failover.md` |
| 二重の割り当て | 検査で 1 件 | page（SEV1） | `double-assignment.md` |
| タイマーの遅れ | `trip_timer_lag_seconds` が 5 秒 | page | `trip-timer-lag.md` |
| outbox の滞留 | `trip_outbox_oldest_seconds` が 2 秒（警告）、30 秒（page） | page | `outbox-backlog.md` |
| オファーの配信の劣化 | `offer_delivery` の 1 時間のバーンレートが 14.4 倍、`undelivered` の率が 10% | page | `offer-delivery-degraded.md` |
| PSP の障害 | `payment_auth` の 5 分の悪い事象が 5%、または PSP の 5xx・時間切れが続く | page | [incident-response.md](../runbooks/incident-response.md) の「PSP の障害」、`psp-outage.md` |
| 結果不明の滞留 | `pay_unknown_outcomes` が 15 分で減らない | ticket | `psp-unknown-outcomes.md` |
| 与信の期限が近い | 未確定の支払いが与信の期限の 24 時間前 | page | `capture-before-auth-expiry.md` |
| 二重の請求 | 検査で 1 件 | page（SEV1） | [incident-response.md](../runbooks/incident-response.md)、`psp-unknown-outcomes.md` |
| 照合のブレイク | T+2 営業日を過ぎたブレイクが 1 件 | ticket | `reconciliation-breaks.md` |
| 緊急の通報を受けていない | `safety_incident_unacked` が 30 秒で 1 件（当番の呼び出しは safety-intake が直接行う。これはその監視） | page | [incident-response.md](../runbooks/incident-response.md) の「緊急の通報の受け付けの失敗」、`safety-queue-backlog.md` |
| 緊急の通報の受信の経路の停止 | `safety_intake_queue_oldest_seconds` が 10 秒、または合成の通報が 2 回続けて届かない | page | 同上、`safety-intake-outage.md` |
| ETA の精度の悪化 | `eta_accuracy` が 2 日続けて外れる | ticket | `eta-accuracy-regression.md` |
| Valhalla の劣化 | `disp_eta_fallback_ratio` が 10% を 10 分 | page | `valhalla-capacity.md` |
| 推計走行距離の提供者の障害 | 失敗の率 20% を 5 分 | page | `fare-distance-provider-outage.md` |
| rideshare の台数の超過 | 検査で 1 件 | page（SEV2） | `rideshare-capacity-anomaly.md` |
| 位置の閲覧と監査ログの差 | 日次の照合で 1 件 | page（SEV2） | `location-access-anomaly.md`（[security.md](security.md) の 14 節） |
| ログの緯度経度 | 日次の検査で 1 件 | ticket（SEV3） | [incident-response.md](../runbooks/incident-response.md) |
| Aurora の大阪への複製の遅れ | `AuroraGlobalDBRPOLag` が 30 秒（警告）、60 秒（page） | page | [disaster-recovery.md](../runbooks/disaster-recovery.md) の C |
| 大阪からの合成の監視の連続の失敗 | 東京の入口への合成の監視が 3 回続けて失敗 | page | [disaster-recovery.md](../runbooks/disaster-recovery.md) の B |
| デプロイの後の悪化 | 配備の後 30 分の SLO の悪化、新しいアプリの版のクラッシュ | page | [deploy-and-rollback.md](../runbooks/deploy-and-rollback.md) |

- デプロイの直後 30 分の悪化は、[deploy-and-rollback.md](../runbooks/deploy-and-rollback.md) の「悪化したとき」を先に見る。

## 9. 合成の監視

| 監視 | 中身 | 場所と頻度 |
| --- | --- | --- |
| 配車の合成の依頼 | 合成の都市の区域（本番の区域と別の `zone=synthetic`）で、合成のドライバー（位置を送る）と合成の乗客が、見積もり → 依頼 → オファー → 受諾 → 取り消しを通す。与信は PSP のテストの鍵 | 東京の 3 AZ から 1 分ごと |
| 位置の往復 | 合成のドライバーの位置が、索引の `FindNearby` に 1 秒以内に現れる | 1 分ごと |
| 緊急の通報 | 合成の `SafetyIncident`（`kind=synthetic`）が、safety-intake → 担当の画面の待ちの列に 10 秒以内に届く。当番を呼び出さない印を付ける | 5 分ごと |
| 推計走行距離 | 固定の 2 点の事前確定運賃の見積もり | 5 分ごと |
| 大阪からの外形の監視 | 東京の入口（`api`・`loc`・`rt`）への到達 | 大阪から 1 分ごと |

- 合成の区域・ドライバー・乗客は、本番の SLO と成立率の計算から除く（`zone=synthetic` のラベル）。本番の配車の候補に出さない。
- 合成の軌跡は Valhalla の経路から作る（実在の人の軌跡を使わない）。

## 10. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E1 | `telemetry-go-and-ts` | 計装の共通の部品、属性の定数、位置の型の lint |
| E1 | `slo-dashboards-per-city` | 6 節の SLI、都市ごとのダッシュボード、バーンレートの警告 |
| E1 | `alert-routing` | 8 節のアラートと呼び出しの経路 |
| E3 | `location-lag-metrics` | 位置の区間ごとの遅れ（[location-ingestion.md](location-ingestion.md) の 12 節） |
| E5 | `dispatch-decision-lookup` | 5 節の判断の記録の引き方と、サポートのツールの画面（support と一緒に） |
| E5 | `synthetic-dispatch-probe` | 9 節の配車の合成の依頼 |
| E6 | `invariant-checkers` | 二重の割り当て・二重の請求・台数の超過・ログの緯度経度の検査 |
| E10 | `synthetic-safety-probe` | 緊急の通報の合成の監視 |

## 11. 未解決の問い

### 決定（2026-09-27、既定案）

- SLO は都市ごと。`dispatch_decision` は 5 秒・99.9%、「候補なし」は良い事象。
- 不変条件は SLO にせず 1 件で呼び出す。
- 位置の点ごとのログは書かない。トレースの位置の標本化は 0.1%。
- 合成の監視は、本番の中の合成の区域で行う。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| 成立率を SLO にするか（供給の不足を含むので、今は品質の指標） | S1 の運用の後、PM と QA |
| 合成の区域を本番の中に置くことが、配車の設定の誤りで本番の区域に漏れないか | E5。区域の設定の検証の関数で `synthetic` のドライバーを本番の区域に出さない |
| `state_delivery` と `offer_delivery` をアプリの版の不具合から切り分ける方法 | E6・E9 |
| 可観測性の費用（位置の件数に比例するメトリクスの基数） | E3 の負荷試験で計る |

## 12. quality.md・runbooks・data-model への項目

### quality.md

- SLO の値と、6 節で SLO にしなかった品質の指標（NFR-001 の p95、成立率、迎車の時間）を、QA の判定の基準に使う。
- 合成の監視の成功の率。

### runbooks

- runbooks の README に、6 節の SLO と 8 節のアラートの一覧を写す（Ops）。
- [incident-response.md](../runbooks/incident-response.md) の都市の配車の停止・位置の取り込みの遅れ・PSP の障害・緊急の通報の受け付けの失敗（この領域で作った）。

### data-model

| 置き場所 | 中身 |
| --- | --- |
| S3 `dispatch-decisions/zone=/dt=/hour=/`（Athena のテーブル） | 5 節 |
| AMP のメトリクスの名前 | 3 節（`packages/telemetry` の定数が正本） |
| AppConfig `dispatch/synthetic` | 9 節の合成の区域 |

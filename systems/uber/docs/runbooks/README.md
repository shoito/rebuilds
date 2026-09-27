# Runbooks: Uber

Ops が持つ運用の文書。品質の判定基準は [quality.md](../quality.md) の 4 節、SLI の計測の仕組みとアラートの条件の実装は [observability.md](../architecture/observability.md) の 3・6・8 節にある。**SLO の値とアラートの一覧の正本はこの文書** で、observability.md と [ADR-0040](../decisions/0040-per-city-slis-and-slos.md) は、これを計測・実装する側の記述である。値を変えるときは、この文書を先に変え、observability.md を合わせる。SLO の元になる非機能要件は [architecture/README.md](../architecture/README.md) の 3 節にある。

作成済みの手順：

| 手順 | 中身 |
| --- | --- |
| [incident-response.md](incident-response.md) | インシデント対応の共通の進め方と、都市の配車の停止・位置の取り込みの遅れ・PSP の障害・緊急の通報の受け付けの失敗・二重の割り当て・位置の漏洩 |
| [deploy-and-rollback.md](deploy-and-rollback.md) | デプロイの前後の確認、サーバーのデプロイ、配車の計算と設定の展開、運賃の規則と legal のフラグの有効化、アプリの段階の公開、戻し方、リースの引き継ぎ |
| [disaster-recovery.md](disaster-recovery.md) | AZ の障害、リージョンの障害（東京 → 大阪）、複製の遅れ、戻し、訓練 |

## 1. SLI と SLO

都市ごと（S1 は `tokyo`）に計る。30 日の移動の窓（報告は暦の月）。

| SLI | 良いイベント（数える場所） | SLO（月間、都市ごと） | NFR | 許容範囲を外れたときの扱い | 品質の判定に使う |
| --- | --- | --- | --- | --- | --- |
| `dispatch_decision` | `requested` の時刻から、dispatch が最初の判断（提案か「候補なし」の記録）をした時刻まで 5 秒以内（dispatch の判断の記録）。受け入れの上限で断った依頼は分母に入れない | **99.9%** | NFR-001、NFR-004 | 1 時間のバーンレート 14.4 倍で呼び出し、6 時間で 6 倍でチケット。バジェットを使い切った都市は、配車・運賃・Trips の変更を止める（修正だけ） | ○ |
| `dispatch_intake` | 依頼・見積もりの API の 5xx・タイムアウトでない応答（混雑の 429 は除く。api） | **99.99%** | NFR-004 | 同上 | |
| `location_freshness` | `USE_FOR_INDEX` の点が、受信から 1 秒以内に索引に適用された（geo-index） | **99%** | NFR-002 | p99 が 1 秒を 15 分超えたら呼び出し（`geo_apply_lag_seconds` の p99 が 3 秒で警告、10 秒で呼び出し） | ○ |
| `trip_transition` | アプリの遷移の操作の、5xx・タイムアウトでないコミット（状態の不一致の 409 は良い。trips） | **99.95%** | NFR-007 | バーンレートで呼び出し | |
| `state_delivery` | 状態の変化の、outbox の作成から相手のアプリの受信の確認まで 2 秒以内（rt-gateway） | **95%** | NFR-008 | p95 が 2 秒を 15 分超えたらチケット | ○ |
| `offer_delivery` | オファーの作成から `OfferDelivered` まで 1.5 秒以内（trips） | **95%** | ADR-0015 | 1 時間のバーンレート 14.4 倍、または `undelivered` の率 10% で呼び出し | ○ |
| `payment_auth` | 与信が結果を得た（カードの拒否は良い。PSP の 5xx・時間切れ・この基盤の誤りは悪い。payments） | **99.9%** | NFR-006 | 5 分の悪い事象が 5% で呼び出し | |
| `payment_capture` | `completed` から 1 時間以内に売上の確定が成功（payments） | **99.9%** | NFR-006 | バーンレートでチケット。与信の期限の 24 時間前は呼び出し | |
| `emergency_ack` | `SafetyIncident` の受信から担当が受けるまで 30 秒以内（safety-intake） | **95%** | NFR-010 | 受けていない通報が 30 秒で 1 件あれば呼び出し | ○ |
| `eta_accuracy` | 1 日の迎車の ETA の誤差の中央値 60 秒・p90 180 秒以内（[ADR-0016](../decisions/0016-valhalla-serving-traffic-and-eta-accuracy.md) の定義） | **30 日のうち 27 日** | NFR-003 | 2 日続けて外れたらチケット | ○ |

- **不変条件は SLO にしない。1 件で呼び出す**：二重の割り当て（1 分ごとの検査。SEV1）、二重の売上の確定（日次。SEV1）、台帳の釣り合いの失敗（SEV1）、rideshare の台数の超過（1 分ごと。SEV2）、位置の閲覧と監査ログの件数の差（日次。SEV2）、ログの緯度経度（日次。SEV3）、`legal_gate_records` の範囲の外で真の legal のフラグ（月次の点検と配備の検証。SEV2）。
- **数えないもの**：合成の区域（`zone=synthetic`）・合成のドライバーと乗客、受け入れの上限の 429、状態の不一致の 409、カードの拒否。
- NFR-001 の p95 3 秒は `disp_request_to_decision_seconds` の p95 として別に見る（QA の判定。[quality.md](../quality.md) の 4.1 節）。`dispatch_decision` の 5 秒は NFR-001 の p99 に合わせた。配車のタスクの引き継ぎ（最大約 6.5 秒）で悪い事象が出るので、`dispatch_decision` は 99.9% までを許し、NFR-004 の 99.99% は `dispatch_intake` で見る。
- 配車の成立率（3 分以内の受諾）、迎車の時間、辞退・時間切れの率は、供給の不足を含むので SLO にしない。QA が品質の判定に使う（quality.md の 4.1 節）。
- 「品質の判定に使う」に○がある指標は、QA が品質の判定基準に使う。定義を変えるときは QA と合意する。
- エラーバジェットの方針は Slack と同じ（使い切ったら信頼性の作業を機能より先にする。デプロイの前に残りを確かめる）。
- 復旧の目標（NFR-007）：AZ の障害は RPO 0・RTO 5 分。リージョンの障害は RPO 1 分・RTO 30 分。

## 2. 上限と容量のパラメーター

値の正本は各文書にある。Ops が運用で変えてよいのは、下の「運用で変えるもの」だけで、変えたら記録を残す。

| 対象 | 値 | 正本 | 運用で変えるもの |
| --- | --- | --- | --- |
| 常に持つ量 | 平常のピークの 2 倍（位置 5,000 件/秒、依頼の受け付け 60 件/秒、接続 6 万）を 1 AZ を失っても | [capacity.md](../architecture/capacity.md) の 8 節（ADR-0041） | 最小のタスク数 |
| 都市の未割り当ての依頼の上限 | オンラインの空車 × 0.5（最低 200、最大 5,000） | capacity の 4 節 | 係数の一時の変更（`intake-admission-tuning.md`） |
| バッチの依頼の上限 | `min(未割り当て, 空車 × 2, 500)` | capacity の 4 節 | — |
| 見積もり | 同じ乗客・同じ乗降で 60 秒のキャッシュ、1 分 10 回 | capacity の 4 節 | — |
| 推計走行距離の呼び出し | 都市ごと毎秒 100 | capacity の 4 節 | 契約の上限に合わせた引き上げ |
| バッチの周期 | 2 秒（1〜5 秒）。1 件だけなら 500 ms で即時 | [dispatch-and-matching.md](../architecture/dispatch-and-matching.md) の 14 節（ADR-0004・0013） | AppConfig `dispatch/<zone>`（変更の要求と再生の結果を添える） |
| 最適化の上限 | 300 ms で貪欲法 | ADR-0013 | — |
| オファー | 表示 15 秒、サーバーの期限 16.5 秒、受信の確認 5 秒、時間切れ 2 回で自動の休憩、3 分か 10 回で `no_driver_found` | [ADR-0015](../decisions/0015-offer-protocol-decision-log-and-replay.md) | — |
| 候補の鮮度 | 位置 15 秒以内 | NFR-002 | — |
| 索引のリース | 期限 5 秒、1 秒ごとの更新、4 秒で降りる、引き継ぎ 約 6.5 秒、再構築 15 秒（目標） | [ADR-0011](../decisions/0011-geo-index-sharding-lease-and-rebuild.md) | — |
| 位置の送信の間隔 | 4 秒（2〜10 秒） | [ADR-0009](../decisions/0009-location-upload-and-validation.md) | `ops.loc.interval_ms`（`location-ingest-lag.md`） |
| `backlog` の全体の上限 | 5,000 件/秒 | [location-ingestion.md](../architecture/location-ingestion.md) の 10 節 | 引き下げ（`location-reconnect-storm.md`） |
| loc-ingest の 1 タスク、rt-gateway の 1 タスク | 2,000 件/秒、2 万接続（**未検証**。E3 の `loc-load-test`、E6 の `realtime-load-test`） | capacity の 8 節 | タスクの数 |
| Kinesis `loc-tokyo` | 8 シャード | capacity の 2 節 | シャードの追加 |
| タイマーの遅れ | 期限から遷移のコミットまで p99 1 秒。5 秒で呼び出し | [trips-lifecycle.md](../architecture/trips-lifecycle.md) の 6 節 | 処理のタスクの数 |
| 前もって広げる倍率 | 2〜3 倍（大晦日 3 倍） | capacity の 6 節 | 催しの登録（`prescale_events`） |

## 3. リリースとロールバック

流れの正本は [delivery.md](../architecture/delivery.md)、手順は [deploy-and-rollback.md](deploy-and-rollback.md)。

- **デプロイとリリースを分ける。** デプロイは Ops が承認し、リリース（フラグを広げる）は PM が判断する。すべての新しい振る舞いは release フラグの裏に置く。
- **フラグは 3 種類**（[ADR-0043](../decisions/0043-flag-taxonomy-legal-gates-and-safety-defaults.md)）：release（`release.<area>.<feature>`）、ops（`ops.<area>.<action>`。runbook から使う）、legal（`legal.<L番号>.<feature>`）。**legal のフラグは、`legal_gate_records` に法務の結論の記録がある範囲でだけ本番で有効にできる**（AppConfig の検証の関数が拒む。手順は `legal-gate-enable.md` と deploy-and-rollback の「legal のフラグを有効にする」）。**緊急の入口と 110・119 の案内にはフラグを置かない。**
- **配車と運賃の関門**（[ADR-0042](../decisions/0042-replay-and-shadow-gates-for-dispatch-and-pricing.md)）：配車の計算は直近 7 日の再生・縮小のシミュレーション・影の実行 1 週間を経て、区域の release フラグで 1 区域の 10% のバッチ → 100% → 他の区域。運賃のコードは `fare-replay`（直近 30 日の差 0）と影の計算 3 日を経て、Pricing のカナリア。
- **デプロイの順**：マイグレーション（expand）→ 購読する側 → trips・pricing・supply → Go の熱い経路（loc-ingest → geo-index → dispatch → eta）→ rt-gateway → api → アプリ（列車）→ release フラグ。geo-index・dispatch は待機を先に入れ替え、リースを 1 回だけ渡す。
- **都市の波（S2 から）**：配備と設定の変更は、都市のセルの単位で、小さな都市 → 中の都市 → 東京の順に出す。各波の後 30 分、その都市の `dispatch_decision`・`offer_delivery`・成立率を見る（delivery の 4.3 節）。
- **アプリの列車**（[ADR-0006](../decisions/0006-native-apps-contracts-vectors-and-release-train.md)）：月曜 11 時に切り、月〜水に社内の配布と回帰、木曜に審査、金曜から段階的に公開する（iOS は 7 日の段階、Android は 1% → 5% → 20% → 50% → 100%、各 1 日以上）。段を進める基準：クラッシュのない利用者 99.8% 以上、ANR の率・オファーの受信の確認までの時間の p95・出庫の失敗の率が前の版より悪くない。ドライバーのアプリは金・土の 18 時〜翌 6 時に段を進めない。`required_min` を上げるのは Dev と Ops の 2 人の承認で、乗車の最中と緊急の入口は塞がない。
- **ロールバック**：まずフラグで戻す（配車は `ops.dispatch.algo_pin.<zone>`、設定は AppConfig の前の版）。次に 1 つ前のイメージ。アプリは段階の公開を止め、必要なら `required_min` を上げる。マイグレーションは戻さない。確定した見積もりの額は変えない。
- 本番へのデプロイは Ops が承認する（作成者と別の人）。

### 3.1 デプロイの時間帯と凍結

| 対象 | 時間帯 | 凍結（修正だけ） |
| --- | --- | --- |
| サーバー（api、trips、pricing、payments、supply、workers、Go の熱い経路、Valhalla） | 平日 10〜17 時 | 金・土の 17 時〜翌 6 時、日本の祝日の前日の夜、**12/28〜1/3**、予定の大きな催しと雨の予報で前もって広げた時間帯（配車・運賃・Trips の変更を出さない）、エラーバジェットを使い切った都市（その都市の配車・運賃・Trips） |
| 配車の計算・設定の展開（区域のフラグ、AppConfig） | 平日 10〜16 時（展開の後 30 分を平日の昼に見る） | 同上 |
| 運賃の規則の有効化 | 有効の日の 0 時に切り替わる。承認は平日 | 12/28〜1/3 の新しい規則の有効化は避ける（公示の改定の日を除く） |
| legal のフラグの有効化 | 平日 10〜16 時。PM と Ops（法務の記録を確かめてから） | 同上 |
| アプリの段階を進める | 平日 10〜15 時。ドライバーのアプリは金・土の 18 時〜翌 6 時に進めない | 12/28〜1/3 は段を進めない（重大な修正を除く） |
| Terraform（`network`・`data`） | 平日 10〜16 時。Ops の承認 | 同上 |
| DR の戻し（大阪 → 東京） | 計画作業として平日の夜 | 大きな催しの日を避ける |

- 脆弱性の修正（重大）と、二重の割り当て・二重の請求・位置の漏洩の修正は時間帯の制限を受けない。レビューと必須の CI（状態機械のベクター、決定表、性質ベーステスト）は省かない。
- 12/28〜1/3 の凍結は、大晦日の前もっての拡大（12/31 20:00〜1/1 04:00、平常のピークの 3 倍）と重なる。拡大はこの凍結の前に予定として入れる（`prescale-for-events.md`）。
- 凍結の予定は、Ops が四半期ごとにこの表の下に書き足し、PM と合意する。

## 4. アラートと手順

「作成済み」以外の手順は、各 Epic の実装に合わせて [templates/runbook.md](../../../../docs/templates/runbook.md) から作る。「作る Story」の列は、そのアラートの計測と手順を作る [roadmap.md](../roadmap.md) の Story である。手順の文書は、その Story の完了の条件に含める（E12 の分は `runbooks-e12` でもまとめて確かめる）。作るまでは [incident-response.md](incident-response.md) の該当の節で対応する。アラートの条件の実装は [observability.md](../architecture/observability.md) の 8 節。すべてのアラートは、対応する runbook の URL を注釈に持つ（CI で検査する）。呼び出し（page）は、利用者に影響が出ているか、放っておくとお金・乗車・安全を損なうものだけにする。

### 4.1 アラートと対応する手順

| アラート（重さ） | 手順 | 状態 | 作る Story |
| --- | --- | --- | --- |
| 配車の SLO の速いバーンレート（page）・遅いバーンレート（ticket） | [incident-response.md](incident-response.md) の「都市の配車の停止」 | 作成済み | `slo-dashboards-per-city`（E1） |
| 配車の成立率の低下（同じ曜日・時間帯の 4 週の中央値より 15 ポイント低い状態が 15 分。ticket）、未割り当ての依頼の急増（受け入れの上限の 80%。ticket） | `dispatch-match-rate-drop.md`（dispatch の 15 節） | E5 で作成 | `dispatch-batch-loop`、`synthetic-dispatch-probe` |
| 受け入れの上限が働き続ける（ticket） | `intake-admission-tuning.md`（capacity の 11 節） | E5 で作成 | `intake-admission-control` |
| 配車のタスクの引き継ぎが長い（区域のリースの持ち主がいない状態が 15 秒。page）、`EPOCH_MISMATCH` の急増 | `dispatch-zone-failover.md`（dispatch の 15 節） | E5 で作成 | `dispatch-zone-lease` |
| 配車の計算の展開と戻し（計画作業） | `dispatch-algorithm-rollout.md`（dispatch・delivery） | E5 で作成 | `dispatch-shadow-runner` |
| 索引の遅れ（`geo_apply_lag_seconds` の p99 が 3 秒で警告、10 秒で page） | [incident-response.md](incident-response.md) の「位置の取り込みの遅れ」、`geo-index-lag.md`（geospatial-index の 13 節） | 作成済み（個別は E3 で作成） | `geo-index-core`、`location-lag-metrics` |
| 位置の取り込みの失敗（loc-ingest の 5xx が 1% を 5 分、Kinesis の書き込みの超過が続く。page） | 同上、`location-ingest-lag.md`（location-ingestion の 17 節） | 作成済み（個別は E3 で作成） | `loc-ingest-service` |
| 再接続の殺到での `backlog` の集中（ticket） | `location-reconnect-storm.md`（location-ingestion の 17 節） | E3 で作成 | `loc-ingest-service` |
| 索引の再構築が長い（主と待機がともに `READY` でない状態が 60 秒。page） | `geo-index-rebuild.md`（geospatial-index の 13 節） | E3 で作成 | `geo-index-rebuild` |
| 主が 2 つ（`lease_epoch` の食い違い。ticket） | `geo-lease-anomaly.md`（geospatial-index の 13 節） | E3 で作成 | `geo-shard-lease` |
| trail-builder が 24 時間を超えて止まった（ticket） | `trail-builder-backfill.md`（location-ingestion の 17 節） | E3 で作成 | `trip-trail-builder` |
| 二重の割り当て（検査で 1 件。page・SEV1） | [incident-response.md](incident-response.md) の「二重の割り当て」、`double-assignment.md`（trips の 14 節） | 作成済み（個別は E6 で作成） | `single-assignment-monitor`、`invariant-checkers` |
| タイマーの遅れ（`trip_timer_lag_seconds` が 5 秒。page） | `trip-timer-lag.md`（trips の 14 節） | E6 で作成 | `trip-timers` |
| outbox の滞留（`trip_outbox_oldest_seconds` が 2 秒で警告、30 秒で page） | `outbox-backlog.md`（trips の 14 節） | E6 で作成 | `trip-outbox-relay` |
| 長く残る乗車（`awaiting_fare`・迎車のまま。ticket） | `stuck-trips.md`（trips の 14 節） | E6 で作成 | `trip-timers` |
| 大阪への切り替えの後の復元と食い違いの確認（計画外の作業） | [disaster-recovery.md](disaster-recovery.md) の B の 9、`trip-restore-after-failover.md`（trips の 14 節） | 作成済み（個別は E6 で作成） | `trip-snapshot-and-restore` |
| オファーの配信の劣化（`offer_delivery` のバーンレート 14.4 倍、`undelivered` の率 10%。page） | `offer-delivery-degraded.md`（dispatch・notifications の 15 節） | E6 で作成 | `offer-delivery-path` |
| 再接続の殺到（rt-gateway の `Hello` の急増。ticket） | `realtime-reconnect-storm.md`（notifications の 15 節） | E6 で作成 | `rt-gateway` |
| Valkey `rt` のフェイルオーバー（`resync_required` の急増。ticket） | `valkey-realtime-failover.md`（notifications の 15 節） | E6 で作成 | `rt-router-and-streams` |
| APNs・FCM の障害（送信の失敗の率。ticket） | `push-provider-outage.md`（notifications の 15 節） | E6 で作成 | `push-sender` |
| SMS の提供者の障害（30 秒で受け付けない、5 分の失敗の率 20%。page） | `sms-provider-failover.md`（notifications の 15 節） | E1 で作成 | `sms-otp` |
| ワンタイムコードの送信の急増（ticket） | `sms-pumping.md`（notifications の 15 節） | E1 で作成 | `sms-otp` |
| PSP の障害（`payment_auth` の 5 分の悪い事象が 5%。page） | [incident-response.md](incident-response.md) の「PSP の障害」、`psp-outage.md`（payments の 18 節） | 作成済み（個別は E8 で作成） | `psp-adapter` |
| 結果不明の滞留（`pay_unknown_outcomes` が 15 分で減らない。ticket） | `psp-unknown-outcomes.md`（payments の 18 節） | E8 で作成 | `psp-adapter` |
| 与信の期限が近い（未確定の支払いが期限の 24 時間前。page） | `capture-before-auth-expiry.md`（payments の 18 節） | E8 で作成 | `capture-at-trip-end` |
| 二重の請求（検査で 1 件。page・SEV1）、台帳の釣り合いの失敗（page・SEV1） | [incident-response.md](incident-response.md)、`psp-unknown-outcomes.md` | 作成済み（個別は E8 で作成） | `capture-at-trip-end`、`ledger-core`、`invariant-checkers` |
| 照合のブレイク（T+2 営業日を過ぎたものが 1 件。ticket） | `reconciliation-breaks.md`（payments の 18 節） | E8 で作成 | `three-way-reconciliation` |
| 締めと振込、組戻し（定期の作業） | `settlement-close.md`（payments の 18 節） | E8 で作成 | `operator-settlement-and-statements` |
| 振込先の変更（申請のたび） | `payout-account-change-review.md`（payments の 18 節） | E2 で作成 | `operator-bank-accounts` |
| 緊急の通報を受けていない（`safety_incident_unacked` が 30 秒で 1 件。page） | [incident-response.md](incident-response.md) の「緊急の通報の受け付けの失敗」、`safety-queue-backlog.md`（safety の 16 節） | 作成済み（個別は E10 で作成） | `safety-incident-intake` |
| 緊急の通報の受信の経路の停止（`safety_intake_queue_oldest_seconds` が 10 秒、合成の通報が 2 回続けて届かない。page） | 同上、`safety-intake-outage.md`（safety の 16 節） | 作成済み（個別は E10 で作成） | `safety-incident-intake`、`synthetic-safety-probe` |
| 緊急の通報の対応（受けてから閉じるまで） | `emergency-incident-response.md`（safety の 16 節） | E10 で作成 | `safety-agent-console` |
| 事故と S1 の報告の事業者への引き渡し | `incident-packet-to-operator.md`（safety の 16 節） | E10 で作成 | `incident-packet-export` |
| 警察からの照会（受け付けのたび。L7 の結論で書き直す） | `law-enforcement-request.md`（safety の 16 節） | E10 で作成 | `incident-packet-export` |
| 番号の中継の障害（ticket） | `masked-calling-outage.md`（safety の 16 節） | E10 で作成 | `masked-calling` |
| ドライバーの安全の停止と解除 | `driver-safety-hold.md`（safety の 16 節、supply の 14 節） | E11 で作成 | `driver-suspension-by-safety` |
| 偽装・不正の候補の確認（日次） | `location-spoof-review.md`（location-ingestion の 17 節）、`fraud-review.md`（security の 14 節） | E10 で作成 | `fraud-signal-scoring` |
| ETA の精度の悪化（`eta_accuracy` が 2 日続けて外れる。ticket） | `eta-accuracy-regression.md`（eta の 14 節） | E4 で作成 | `eta-accuracy-metrics` |
| Valhalla の劣化（`disp_eta_fallback_ratio` が 10% を 10 分。page） | `valhalla-capacity.md`（eta の 14 節、infrastructure の 14 節） | E4 で作成 | `valhalla-serving` |
| タイルの版の切り替えと戻し（週次） | `valhalla-tile-rollout.md`（eta の 14 節） | E4 で作成 | `valhalla-tile-pipeline` |
| 推計走行距離の提供者の障害（失敗の率 20% を 5 分。page） | `fare-distance-provider-outage.md`（eta の 14 節） | E4 で作成 | `fare-distance-provider-adapter` |
| 住所の検索の提供者の障害（ticket） | `geocoding-provider-outage.md`（maps の 15 節） | E4 で作成 | `places-service-api` |
| OSM の取り込みの検査の失敗（2 週続いたら ticket） | `osm-import-failed.md`（maps の 15 節） | E4 で作成 | `osm-import-weekly` |
| 閉鎖の上書き（工事・災害・行事のたび） | `map-closure-override.md`（maps の 15 節） | E4 で作成 | `tile-closure-overrides` |
| 区域の多角形の更新（公示の変更、月 1 回の確かめ） | `service-area-update.md`（maps の 15 節） | E4 で作成 | `service-area-polygons` |
| 運賃の規則の登録・有効化（改定のたび） | `fare-rule-release.md`（pricing の 14 節） | E7 で作成 | `fare-rule-sets` |
| 事前確定運賃の停止（荒天・催し） | `upfront-suspension.md`（pricing の 14 節） | E7 で作成 | `upfront-fare-quotes` |
| 運賃の水準の守りが働いた（ticket） | `fare-level-breach.md`（pricing の 14 節） | E7 で作成 | `fare-level-reporting` |
| メーターの連携の停止（ticket） | `meter-integration-outage.md`（pricing の 14 節） | E7 で作成 | `meter-integration-adapter` |
| 書類の確認の待ちの滞留（ticket） | `document-review-backlog.md`（supply の 14 節） | E2 で作成 | `document-review` |
| 事業者の許可の取り消し・停止の知らせ | `operator-suspension.md`（supply の 14 節） | E2 で作成 | `operator-onboarding` |
| rideshare の台数の超過（検査で 1 件。page・SEV2）、出庫の拒否の急増 | `rideshare-capacity-anomaly.md`（supply の 14 節） | E12 で作成 | `rideshare-capacity-enforcement` |
| 運行枠の通知の登録と切り替え | `rideshare-window-change.md`（supply の 14 節） | E12 で作成 | `rideshare-allotments` |
| 位置の閲覧と監査ログの差（日次の照合で 1 件。page・SEV2） | `location-access-anomaly.md`（security の 14 節） | E3 で作成 | `location-access-grants` |
| 監査ログと閲覧の API の照合の不一致（日次で 1 件。SEV2） | `audit-reconciliation-mismatch.md`（support の 14 節） | E11 で作成 | `audit-coverage-and-reconciliation` |
| 担当の閲覧の急増（1 人 1 日の軌跡の閲覧 20 件超。ticket） | `suspicious-ops-access.md`（support の 14 節） | E11 で作成 | `jit-access-grants` |
| 承認の後に適用されない変更の要求（24 時間。ticket） | `change-request-stuck.md`（support の 14 節） | E11 で作成 | `change-requests` |
| 障害のときのまとめての返金 | `bulk-refund.md`（support の 14 節） | E11 で作成 | `bulk-refund-dry-run` |
| ロールの棚卸し（月次） | `ops-access-review.md`（support の 14 節） | E11 で作成 | `ops-policy-engine` |
| アカウントの乗っ取りの疑い | `account-takeover.md`（security の 14 節） | E1 で作成 | `auth-token-issuers` |
| トークン・`TripSnapshot` の署名の鍵の入れ替え（定期と漏洩のとき） | `token-signing-key-rotation.md`（security の 14 節） | E1 で作成 | `auth-token-issuers` |
| 位置の漏洩・個人情報の漏洩の疑い（SEV1） | [incident-response.md](incident-response.md) の「位置の漏洩」、`personal-data-breach.md`（security の 14 節） | 作成済み（個別は E1 で作成） | `audit-events-core` |
| ログの緯度経度（日次の検査で 1 件。ticket・SEV3） | [incident-response.md](incident-response.md) | 作成済み | `location-log-lint` |
| legal のフラグの有効化、月次の点検の食い違い | `legal-gate-enable.md`（delivery の 11 節） | E1 で作成 | `legal-gate-records` |
| デプロイの後の悪化（配備の後 30 分の SLO の悪化、新しいアプリの版のクラッシュ。page） | [deploy-and-rollback.md](deploy-and-rollback.md) | 作成済み | `deploy-pipelines` |
| アプリの段階的な公開を止める | `mobile-release-halt.md`（apps・delivery） | E1 で作成 | `mobile-release-train` |
| `required_min` を上げる | `client-min-version-bump.md`（apps の 14 節） | E1 で作成 | `client-version-policy` |
| 位置の送信が止まるドライバーの急増（ticket） | `driver-location-stalls.md`（apps の 14 節） | E9 で作成 | `driver-location-recovery` |
| ナビの引き継ぎ先の後退（逸脱の知らせの急増。ticket） | `nav-handoff-regression.md`（apps の 14 節） | E9 で作成 | `nav-handoff-waypoints` |
| Aurora の大阪への複製の遅れ（`AuroraGlobalDBRPOLag` が 30 秒で警告、60 秒で page） | [disaster-recovery.md](disaster-recovery.md) の C | 作成済み | `osaka-warm-standby`（E12） |
| 大阪からの合成の監視の連続の失敗（3 回。page）、AZ の障害 | [disaster-recovery.md](disaster-recovery.md) の A・B | 作成済み | `osaka-warm-standby`、`dr-drill`（E12） |
| 大晦日・催し・雨の予報の前の拡大 | `prescale-for-events.md`（capacity・infrastructure） | E12 で作成 | `prescale-schedules` |
| Fargate の退役の通知（定期の作業） | `fargate-retirement.md`（infrastructure の 14 節） | E3 で作成 | `lease-aware-deploy` |
| 分割の表の変更（S2） | `geo-shard-map-change.md`（geospatial-index の 13 節） | E14 で作成 | `geo-shard-map-halo` |
| ETA のモデルの戻し（S2） | `eta-model-rollback.md`（ml-platform の 13 節） | E13 で作成 | `eta-model-shadow-rollout` |
| 特徴量が古い（S2） | `feature-pipeline-stale.md`（ml-platform の 13 節） | E13 で作成 | `feature-pipelines` |
| 特徴量の食い違い（PSI が 0.2 超。S2） | `feature-skew-alert.md`（ml-platform の 13 節） | E13 で作成 | `feature-logging-and-skew` |
| 学習の失敗（S2） | `ml-training-failure.md`（ml-platform の 13 節） | E13 で作成 | `ml-platform-foundation` |

### 4.2 領域との対応

| 領域 | アラート・手順 |
| --- | --- |
| [rider-and-driver-apps.md](../architecture/rider-and-driver-apps.md) | `mobile-release-halt.md`、`driver-location-stalls.md`、`nav-handoff-regression.md`、`client-min-version-bump.md` |
| [location-ingestion.md](../architecture/location-ingestion.md) | [incident-response.md](incident-response.md) の「位置の取り込みの遅れ」、`location-ingest-lag.md`、`location-reconnect-storm.md`、`trail-builder-backfill.md`、`location-spoof-review.md` |
| [geospatial-index.md](../architecture/geospatial-index.md) | `geo-index-lag.md`、`geo-index-rebuild.md`、`geo-shard-map-change.md`、`geo-lease-anomaly.md` |
| [dispatch-and-matching.md](../architecture/dispatch-and-matching.md) | [incident-response.md](incident-response.md) の「都市の配車の停止」、`dispatch-match-rate-drop.md`、`dispatch-zone-failover.md`、`offer-delivery-degraded.md`、`dispatch-algorithm-rollout.md` |
| [eta-and-routing.md](../architecture/eta-and-routing.md) | `valhalla-tile-rollout.md`、`eta-accuracy-regression.md`、`fare-distance-provider-outage.md`、`valhalla-capacity.md` |
| [pricing-and-fares.md](../architecture/pricing-and-fares.md) | `fare-rule-release.md`、`upfront-suspension.md`、`fare-level-breach.md`、`meter-integration-outage.md` |
| [trips-lifecycle.md](../architecture/trips-lifecycle.md) | [incident-response.md](incident-response.md) の「二重の割り当て」、`double-assignment.md`、`trip-timer-lag.md`、`outbox-backlog.md`、`trip-restore-after-failover.md`、`stuck-trips.md` |
| [payments-and-payouts.md](../architecture/payments-and-payouts.md) | [incident-response.md](incident-response.md) の「PSP の障害」、`psp-outage.md`、`psp-unknown-outcomes.md`、`capture-before-auth-expiry.md`、`settlement-close.md`、`reconciliation-breaks.md`、`payout-account-change-review.md` |
| [supply-and-operators.md](../architecture/supply-and-operators.md) | `document-review-backlog.md`、`rideshare-window-change.md`、`rideshare-capacity-anomaly.md`、`operator-suspension.md`、`driver-safety-hold.md` |
| [safety-and-trust.md](../architecture/safety-and-trust.md) | [incident-response.md](incident-response.md) の「緊急の通報の受け付けの失敗」、`emergency-incident-response.md`、`safety-queue-backlog.md`、`safety-intake-outage.md`、`masked-calling-outage.md`、`incident-packet-to-operator.md`、`law-enforcement-request.md`、`driver-safety-hold.md` |
| [notifications-and-realtime-push.md](../architecture/notifications-and-realtime-push.md) | `offer-delivery-degraded.md`、`realtime-reconnect-storm.md`、`valkey-realtime-failover.md`、`push-provider-outage.md`、`sms-provider-failover.md`、`sms-pumping.md` |
| [support-and-operations-tools.md](../architecture/support-and-operations-tools.md) | `audit-reconciliation-mismatch.md`、`bulk-refund.md`、`ops-access-review.md`、`suspicious-ops-access.md`、`change-request-stuck.md` |
| [maps-and-geodata.md](../architecture/maps-and-geodata.md) | `osm-import-failed.md`、`map-closure-override.md`、`geocoding-provider-outage.md`、`service-area-update.md` |
| [ml-platform.md](../architecture/ml-platform.md) | `eta-model-rollback.md`、`feature-pipeline-stale.md`、`feature-skew-alert.md`、`ml-training-failure.md` |
| [security.md](../architecture/security.md) | [incident-response.md](incident-response.md) の「位置の漏洩」、`location-access-anomaly.md`、`account-takeover.md`、`token-signing-key-rotation.md`、`fraud-review.md`、`personal-data-breach.md` |
| [infrastructure.md](../architecture/infrastructure.md)、[capacity.md](../architecture/capacity.md) | [disaster-recovery.md](disaster-recovery.md)、`valhalla-capacity.md`、`prescale-for-events.md`、`fargate-retirement.md`、`intake-admission-tuning.md` |
| [delivery.md](../architecture/delivery.md) | [deploy-and-rollback.md](deploy-and-rollback.md)、`dispatch-algorithm-rollout.md`、`legal-gate-enable.md`、`mobile-release-halt.md` |
| [observability.md](../architecture/observability.md) | アラートの条件の実装側（8 節） |
| [data-model.md](../architecture/data-model.md) | 索引のみ。運用の対象は各領域の文書で扱う |

## 5. 定期作業と訓練

| 作業 | 頻度 | 手順 |
| --- | --- | --- |
| 計画外の切り替えの訓練（staging。`loc-loadgen`・`rider-loadgen`・`driver-bot` で L1 の半分の負荷、Aurora の複製を止めて 30 秒後に切り替え、復元、戻し） | 四半期 | [disaster-recovery.md](disaster-recovery.md) の B・D・E（合格基準は [quality.md](../quality.md) の 2.4 節：RPO 1 分、RTO 30 分、戻した乗車の数の整合、二重の割り当て 0、二重の請求 0） |
| 計画した切り替え（本番。利用の少ない時間帯に大阪へ移し、数時間運用して戻す） | 年 1 回 | [disaster-recovery.md](disaster-recovery.md) の E |
| AZ の障害の訓練（staging。FIS で 1 AZ を切り離す） | 半年 | [disaster-recovery.md](disaster-recovery.md) の E |
| 索引の主と待機の同時停止の訓練（staging。`READY` まで 15 秒） | 四半期 | `geo-index-rebuild.md`（E3） |
| 緊急の通報の経路の訓練（試験の環境で押した `SafetyIncident` が当番の呼び出しまで届く） | 月次 | [safety-and-trust.md](../architecture/safety-and-trust.md) の 13 節、`safety-intake-outage.md`（E10） |
| 合成の監視の結果の確認（配車・位置の往復・緊急の通報・推計走行距離・大阪からの外形） | 日次（自動） | [observability.md](../architecture/observability.md) の 9 節 |
| 負荷試験（L1〜L11。大晦日の前は L3 と L1 の 2 倍を 1 時間） | 半年ごと、リリース前、大きな変更の後 | [capacity.md](../architecture/capacity.md) の 7 節 |
| キャパシティの見直し（位置、接続、Aurora の writer の CPU、Valhalla のタスク、段階の移行の目安） | 月次（予測は四半期） | [capacity.md](../architecture/capacity.md)、[infrastructure.md](../architecture/infrastructure.md) の 9 節 |
| 予定の拡大の登録（大晦日、催し、雨・台風・大雪の予報） | 予定のたび。大晦日は 12 月の第 2 週まで | `prescale-for-events.md`（E12） |
| 費用の見直し（タグごと） | 月次 | [infrastructure.md](../architecture/infrastructure.md) の 11 節 |
| legal のフラグと `legal_gate_records` の範囲の突き合わせ | 月次 | `legal-gate-enable.md`（E1）、[ADR-0043](../decisions/0043-flag-taxonomy-legal-gates-and-safety-defaults.md) |
| 位置の閲覧と監査ログの件数の照合、運用の閲覧の API と監査ログの照合 | 日次（自動） | `location-access-anomaly.md`、`audit-reconciliation-mismatch.md` |
| 二重の割り当ての検査 / 二重の請求・台帳の釣り合いの検査 / rideshare の台数の検査 / ログの緯度経度の検査 | 1 分ごと / 日次 / 1 分ごと / 日次（自動） | [observability.md](../architecture/observability.md) の 6 節 |
| 照合（精算・着金・振込） | 日次（T+2 営業日） | `reconciliation-breaks.md`（E8） |
| 締めと振込 | 月 2 回（16 日と翌月 1 日に締め、5 営業日目に振込） | `settlement-close.md`（E8） |
| 変動運賃の水準の集計と 3 か月の報告の取り出し（提出は事業者） | 週次・四半期 | `fare-level-breach.md`（E7） |
| 区域の公示の変更の確かめ | 月次 | `service-area-update.md`（E4） |
| OSM の取り込みとタイルの作成（検査と青緑の切り替え） | 週次（日曜 22:00 取り込み、月曜 03:00 作成） | `osm-import-failed.md`、`valhalla-tile-rollout.md`（E4） |
| ETA の精度と補正の表の作り直し | 日次（自動） | `eta-accuracy-regression.md`（E4） |
| 運用のロールの棚卸し、退職・異動の剥奪 | 月次 | `ops-access-review.md`（E11） |
| トークンの署名の鍵の入れ替え / `TripSnapshot` の署名の鍵 / KMS の鍵 | 90 日 / 年 1 回（古い公開鍵を 90 日残す）/ 年 1 回（自動） | `token-signing-key-rotation.md`（E1）、[security.md](../architecture/security.md) の 4・6 節 |
| 書類・許可の期限の通知の確認 | 日次（自動） | [supply-and-operators.md](../architecture/supply-and-operators.md) の 3 節 |
| Fargate の退役の通知への対応（待機から入れ替え） | 通知のたび | `fargate-retirement.md`（E3） |
| アプリの段階の判定 | 段ごと（24 時間以上） | [deploy-and-rollback.md](deploy-and-rollback.md) |
| 外部の侵入試験 | GA の前（E12）、以後年 1 回 | [security.md](../architecture/security.md) の 11 節 |
| DAST（staging） | 週次 | 同上 |
| インシデント対応の机上訓練（二重の割り当て、位置の漏洩、緊急の通報の受け付けの失敗を想定） | 年 1 回 | [incident-response.md](incident-response.md) |
| 訓練の記録の見直し（目標の未達を Intent へ。RTO の内訳を infrastructure.md に反映する提案） | 四半期 | 各 runbook の「事後」 |

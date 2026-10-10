# Observability: Airbnb

ログ・メトリクス・トレースの計装の規則、[runbooks/](../runbooks/README.md) の SLI の計測（検索の速さ、空室の鮮度と検索の混入、予約の成功、二重の予約と 180 日の上限の照合、送金の時期、レビューの公開の正しさなど）、正しさの見張り、外からの見張り（`canary`）、繁忙期と熱い日付のダッシュボード、不正・お金・PMS のダッシュボード、アプリの計測と外部送信規律（法務の L9）、ログの保持を決める。

SLO の値とアラートの一覧の正本は [runbooks/](../runbooks/README.md) で、この文書はその計り方を書く。品質の判定基準は [quality.md](../quality.md) の 4 節にある。

前提となる決定は次のとおり。

- 利用者のデータをログに出さない。ID と数と理由のコードだけ（[AGENTS.md](../../AGENTS.md)、[ADR-0075](../decisions/0075-data-classes-and-retention.md)）
- 照合（`stay_claims` 5 分ごと、180 日 日次、予約と台帳 5 分ごと、3 者 日次）と検索の混入の抜き取り（[ADR-0002](../decisions/0002-availability-representation-and-double-booking.md)、[ADR-0003](../decisions/0003-search-for-date-range-availability.md)、[ADR-0005](../decisions/0005-payments-hold-capture-and-ledger.md)、[ADR-0006](../decisions/0006-regulatory-night-cap-enforcement.md)、[quality.md](../quality.md) の 4.2 節）
- 計測の基盤は OpenTelemetry（ADOT）→ CloudWatch・AMP・Managed Grafana（[architecture/README.md](README.md) の 4 節）

この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0079](../decisions/0079-sli-measurement-and-correctness-monitors.md) | SLI は runbooks の定義ごとに 1 つの指標の名前と数える場所を持つ。速さと鮮度の SLI は見張りでなく全件の時刻の差（ヒストグラム）で測る。空室の鮮度は `stay_claims` の commit から索引の受け付けと写しの書き込みまでを変化ごとに測る。検索の混入は検索の結果の 0.1% を DB で再判定する抜き取りで測る。正しさの SLI（二重の予約、180 日、決着、台帳、レビューの公開、見える範囲）は、照合の不一致の数と、照合の最後の成功からの時間の両方で見て、照合が止まった間の 0 を良いとしない。送金の時期は `payout_release_at` から release の commit までを全件で測り、保留を除き、期限を過ぎて release のない予約の数も見る。見張りの利用者とリスティングは SLO の計算から除く |
| [0080](../decisions/0080-telemetry-privacy-dashboards-and-app-telemetry.md) | 計装は属性の許可の一覧で、利用者・リスティング・予約の ID をメトリクスのラベルにしない。金庫と連絡先と 2 者の値の型はロガーに渡せない。検索の語と地図の範囲はログとトレースに出さない。熱いリスティングは枠の番号で見る。PMS のアプリは審査を通したアプリの ID をラベルにしてよい（数が限られる）。不正・お金・PMS のダッシュボードは低い基数の集計と日次の集計だけで、個別の調べは案件の画面（JIT）で行う。アプリの計測は本システムの受け口にだけ送り、第三者の計測の部品を既定で入れない（外部送信規律は法務の確認待ち：L9） |

## 1. 範囲

| 含む | 含まない（置き場所） |
| --- | --- |
| 計装の規則、指標の名前、トレース、ログ | SLO の値、アラートの条件、手順（[runbooks/](../runbooks/README.md)） |
| SLI の計測と、正しさの見張りの指標 | 照合の処理そのもの（[availability-and-calendars.md](availability-and-calendars.md)、[regulatory-compliance-japan.md](regulatory-compliance-japan.md)、[ledger-and-payouts.md](ledger-and-payouts.md)、[reviews.md](reviews.md)） |
| 検索の混入の抜き取りの計り方 | 混入の抜き取りの再判定の関数（[search-and-ranking.md](search-and-ranking.md)） |
| 外からの見張り（`canary`） | 見張りの場面の合否の基準（[quality.md](../quality.md) の 4.2 節） |
| ダッシュボード（予約、繁忙期、お金、不正、PMS、SSRF） | 不正の規則と審査（[trust-and-safety.md](trust-and-safety.md)） |
| アプリの計測の送り先 | 外部送信規律の公表の文（法務の L9） |

## 2. 計装の規則（ADR-0080）

### 2.1 個人のデータを出さない

- ログ・トレースの属性は、型の許可の一覧（`packages/telemetry/attributes.ts`）だけ。許可の一覧の外の属性は、ロガーとトレーサーが落とし、`telemetry_dropped_attributes_total` を数える。
- 金庫（V）・連絡先（C）・2 者（P）の値の型（`ExactAddress`、`ExactGeoPoint`、`PersonName`、`PhoneNumber`、`EmailAddress`、`PassportNumber`、`BankAccountNumber`、`MessageBody`、`RegistryEntry`）は、ロガーの引数の型に渡せない（型の検査で禁止）。
- 検索の語、地名の入力、地図の範囲（緯度経度）は、ログにもトレースにも出さない。地名の辞書で解決した場所の ID（市区町村、駅）だけを出してよい。検索の質の分析はデータレイクの仮名の事象で行う（[security.md](security.md) の 7.3 節）。
- iCal の URL と PMS の Webhook の受け口の URL は出さない（秘密のトークンを含みうる）。取り込みのアドレスの ID と購読の ID だけを出す。
- エラーの報告は、文の中の値を落とした形（文の型と位置）で送る。SQL の値、HTTP の本文を送らない。
- 夜間に、合成の利用者で全経路を流し、ログ・トレースを走査する（住所、正確な位置の桁の多い緯度経度、氏名、電話番号、メールアドレス、旅券の番号、口座の番号、カード番号の形）。検出は 0（[quality.md](../quality.md) の 2.2.1 節 H）。本番のログも毎日、同じ形の走査を抜き取りで回す。

### 2.2 指標の名前とラベル

- 名前は `<領域>_<対象>_<単位>`（`reserve_stay_duration_seconds`、`recon_stay_claims_mismatches`）。
- ラベルに使ってよいもの：サービス、経路、結果のコード、理由のコード、検索の種類（`dated`・`flexible`・`autocomplete`）、支払いの方法、通知の種類と経路、AZ、都道府県（47）、PMS のアプリ（`approved` のアプリの ID。数百まで）、iCal の相手のドメインの上位 20（他は `other`）。
- ラベルに使わないもの：利用者・ホストのアカウント・リスティング・予約・届出住宅の ID、IP、端末の ID、検索の語。熱いリスティングは「熱いリスティングの枠」（同時に 20 まで、`slot=0..19`）で見て、枠とリスティングの対応は運用の画面だけに出す。

### 2.3 トレース

- W3C の Trace Context を、アプリ → `app-api`・`partner-api` → ドメインのサービス → outbox の事象（`trace_parent` の列）→ 消費者まで渡す。outbox を越えるところはリンクにする。
- 抜き取りは、既定 1%、エラーと遅い要求（p99 を超えたもの）は 100%（尾の抜き取り）。`reserveStay` の経路は 10%。
- 決済の提供者の呼び出しは外のスパンにし、予約の速さの SLI から提供者の時間を引けるようにする（NFR-004）。

### 2.4 ログの欄

`ts`、`level`、`service`、`trace_id`、`span_id`、`actor_kind`（`user`・`host_member`・`pms_app`・`operator`・`service`）、`actor_id`（UUID）、`target_type`、`target_id`、`action`、`outcome`、`reason_code`、`duration_ms`。本文の自由な文の欄は持たない。

## 3. SLI の計測（ADR-0079）

runbooks の 1 節の SLI ごとの、指標と数える場所。

| SLI（runbooks） | 指標 | 数える場所と方法 |
| --- | --- | --- |
| 予約と決済の可用性 | `booking_requests_total{op,outcome}` | `booking`・`pricing`・`payments` の入口。`op` は `quote`・`reserve`・`cancel`・`alter`・`accept`。`outcome` は `ok`・`dates_unavailable`・`quote_expired`・`regulatory_cap_reached`・`regulatory_day_blocked`・`card_declined`・`rejected_bot`・`rate_limited`・`error`・`timeout`。良い＝`error`・`timeout` 以外。`dates_unavailable`〜`rate_limited` は分母から除く（runbooks の「数えないもの」）。見張りの利用者を除く |
| 予約の速さ | `reserve_stay_duration_seconds{kind=instant\|request}` | `reserveStay` の始まりから応答まで。提供者のスパンの時間を引く |
| 負けの応答の速さ | `reserve_stay_duration_seconds{outcome=dates_unavailable\|in_progress}` | 同上。熱い日付の枠のものは `hot=true` |
| 検索の可用性と速さ | `search_requests_total{kind,outcome}`、`search_duration_seconds{kind}` | `search-api` の入口。`kind` は `dated`・`flexible`・`autocomplete`。NFR-001 の p95・p99 を種類ごとに |
| 空室の鮮度 | `availability_freshness_seconds{target=index\|cache,source}` | 全件：`search-indexer` は OpenSearch の bulk の受け付けの時刻＋索引の再読み込みの間隔（1 秒）− `stay_claims` の commit の時刻（outbox の行の時刻）。`availability-cache-writer` は Valkey の書き込みの応答の時刻 − 同。`source` は `booking`・`host`・`ical`・`pms`・`ops`。古いバージョンで捨てた書き込みは数えない |
| 検索の混入 | `search_sample_checks_total{result=ok\|unbookable\|price_out_of_range}`、`search_missed_listings_ratio` | 抜き取り：検索の結果の 0.1% のリスティング（ID、日付、`calendar_version` だけを記録）を、`search-sampler` が非同期に、応答の時刻の状態（`stay_claims` の作成・解除の時刻で再現）に `checkStayRules` を当て直して再判定する（判定の方法の正本は [search-and-ranking.md](search-and-ranking.md) の 8 節）。混入の率 ＝ `unbookable` ÷ 全部。取りこぼしの率は日次に全リスティングの `stay_ranges` と写しを DB と比べて出す |
| 予約での断りの率 | `booking_requests_total{op=reserve,outcome=dates_unavailable,from=search}` | 検索から来た予約の `dates_unavailable` の率（[quality.md](../quality.md) の 4.1 節） |
| 二重の予約 | `recon_stay_claims_mismatches{kind=overlap\|missing_reservation_claim\|expired_active\|group_dual}`、`recon_stay_claims_last_success_timestamp_seconds` | `stay_claims` の照合のジョブ（5 分ごと、繁忙期と熱い日付は 1 分ごと）。`group_dual` は応答の期限を過ぎて同じ組の有効な行が 2 つ |
| 外部の食い違いの知らせ | `calendar_conflict_notify_seconds` | `calendar_conflicts` の行の作成から、通知の提供者の受け付けまで（[calendar-sync.md](calendar-sync.md)） |
| iCal の取り込み | `ical_fetch_total{outcome,domain}`、`ical_fetch_on_schedule_ratio` | `ical-fetcher` と `ical-sync`。予定どおり＝前回から 15 分＋1 分以内に取れた。相手の 4xx・5xx は分母から除く |
| 法令の上限 | `recon_regulated_nights_mismatches{kind=missing\|extra\|over_cap\|blocked_day}`、`recon_regulated_nights_last_success_timestamp_seconds`、`regulated_cap_check_violations_total` | 180 日の照合のジョブ（日次、繁忙期は 1 時間ごと）。CHECK 制約に当たった数は正常（409）なので別の指標 `regulatory_cap_rejections_total` |
| 決着の一回性 | `recon_booking_ledger_mismatches{kind=duplicate\|early_release\|missing_15m}`、`..._last_success_timestamp_seconds` | 予約と台帳の照合のジョブ（5 分ごと） |
| 台帳の不変条件 | `ledger_invariant_violations{check=balance\|sum_zero\|held_settled_zero\|balance_row}`、`..._last_success_timestamp_seconds` | 台帳の検査（5 分ごと）と、仕訳の書き込みの時の検査の失敗 |
| 3 者の照合 | `ledger_suspense_minor_units{ccy,age=lt_3bd\|ge_3bd}`、`three_way_last_success_timestamp_seconds` | 日次の 3 者の照合のジョブ |
| 送金の時期 | `payout_release_lag_seconds`、`payout_release_overdue{age=gt_5m\|gt_1h}` | 全件：`ledger` が release の仕訳の commit の時刻 − `payout_release_at`（保留・運用の保留の予約を除く）。`deadline-runner` が 1 分ごとに、`payout_release_at` を過ぎて release のない予約（保留を除く）を数える。チェックインの前の release は `recon_booking_ledger_mismatches{kind=early_release}` |
| 見積もりと請求 | `quote_charge_mismatches_total` | `payments` が売上の確定の結果の額・通貨と見積もりの写しを比べる。全件 |
| レビューの公開 | `recon_review_reveal_mismatches{kind=one_sided\|early\|late_1m}`、`review_reveal_lag_seconds`、`..._last_success_timestamp_seconds` | レビューの公開の照合のジョブ（1 時間ごと）と、期限の公開の遅れ（`revealed_at` − 期限の時刻）の全件のヒストグラム（[reviews.md](reviews.md)） |
| メッセージの配信 | `message_delivery_seconds{channel}` | `notifier` が送信の commit から提供者の受け付けまで |
| 見える範囲 | `visibility_audit_mismatches{surface}`、`..._last_success_timestamp_seconds` | 見える範囲の監査のジョブ：検索の結果・リスティングの画面・通知・PMS の応答の 0.1% を抜き取り、`listingVisible()`・`exactLocationVisible()` と同意の範囲で確かめる。値は記録しない |
| 安全の窓口 | `safety_first_response_seconds{channel}` | `trust-safety` が `safety_incidents` の作成から人の最初の応答まで（[trust-and-safety.md](trust-and-safety.md)） |
| PMS の API | `partner_api_requests_total{app,route,outcome}`、`partner_api_duration_seconds`、`webhook_delivery_seconds`、`webhook_deliveries_total{outcome}` | `partner-api`、`webhook-sender`。Webhook の遅れは元の事象の commit から 2xx まで（NFR-003 の p95 10 秒） |
| 期限の遅れ | `deadline_lag_seconds{kind}` | `deadline-runner` が遷移の commit の時刻 − 期限の時刻。全件 |

- **照合が止まった 0 を良いとしない**：正しさの SLI は、不一致の数に加えて、最後の成功からの時間を見る。間隔の 2 倍（5 分ごとは 10 分、1 分ごとは 3 分、日次は 26 時間）を過ぎたら、不一致と同じ重さで呼び出す。
- **全件で測る**：速さと鮮度の SLI は全件の時刻の差で測る。見張りは、全件の計測そのものが止まったときに気づくために使う。
- **見張りの除き方**：見張りの利用者とリスティングは `sentinel` の印を持ち、SLI の指標を出すときに除く。見張りの結果は `canary_*` の指標にする。

## 4. 外からの見張り（`canary`）

canary のアカウント（本番と別の資格情報）から、見張りのホストとゲストが、15 分ごとに次を確かめる（[quality.md](../quality.md) の 4.2 節）。

| 段 | 確かめること | 指標 |
| --- | --- | --- |
| 公開 | 見張りのリスティングの料金を変え、60 秒で詳細の画面に出る | `canary_step_seconds{step=listing_update}` |
| 検索 | 見張りのホストのブロックを外して 60 秒以内に、決めた範囲と日付の検索で引ける | `canary_step_seconds{step=searchable}` |
| 見積もりと予約 | 即時予約（提供者の試験の環境のカード） | `canary_step_seconds{step=reserve}` |
| 案内 | 確定の後、チェックインの案内に住所が出る（見張りの架空の住所） | `canary_step_seconds{step=checkin_info}` |
| キャンセルと返金 | 柔軟のポリシーで全額の返金 | `canary_step_seconds{step=cancel_refund}` |
| iCal の書き出し | 予約から 1 分以内に書き出しに出る | `canary_step_seconds{step=ical_export}` |
| PMS | 見張りの PMS のアプリが空室を書き、Webhook が 10 秒以内に見張りの受け口に届く | `canary_step_seconds{step=pms_roundtrip}` |
| 通知 | 予約の通知が見張りの端末の受け手（APNs・FCM の試験の受け手）に届く | `canary_step_seconds{step=notify}` |

- 見張りのリスティングは `listingVisible()` で見張りの利用者だけに見える（一般の検索の結果に出さない。[quality.md](../quality.md) の 4.2 節）。判定は DT-LST-VIS-001 の行 3a（[listings-and-content.md](listings-and-content.md) の 8 節。2026-10-10 の統合で足した）。
- 見張りのリスティングは届出住宅に結ばない（180 日の数えに入れない）。見張りの予約は台帳の仕訳を書くが、`sentinel` の印で 3 者の照合と収益の集計から外す。
- 2 回続けて失敗した段は呼び出し。提供者の試験の環境が落ちているときは `canary_dependency_up{dep}` で本番の障害と分ける。

## 5. 繁忙期と熱い日付のダッシュボード

| パネル | 指標 |
| --- | --- |
| 予約の流れ | `booking_requests_total` の結果ごとの率、`reserve_stay_duration_seconds` の p50・p99、負けの応答の p99、`regulatory_cap_rejections_total` |
| 熱い日付 | 熱いリスティングの枠ごと：先着の印の取り合いの数、同時実行の上限の待ち、決済の失敗の後の仮押さえの戻しの数（[runbooks/](../runbooks/README.md) の 5.1 節）。都市（都道府県）ごとの見積もりの数 |
| DB | core の書き込みの CPU、接続の使用率（70% の線）、行のロックの待ち（リスティング、届出住宅）、ledger の commit の待ち（`rds.global_db_rpo` によるもの） |
| 正しさ | `stay_claims`・180 日・予約と台帳の照合の不一致と最後の成功からの時間（繁忙期は 1 分ごと） |
| 検索 | `search_duration_seconds` の種類ごと、検索の混入の率、空室の鮮度の p95・p99、OpenSearch の CPU とキューの拒否、Valkey の迂回の率、`ops.search_stage1_limit` の今の値 |
| 外部のカレンダー | iCal の予定どおりの率、PMS の書き込みの率とアプリごとの 429、外部の食い違いの数 |
| 送金の山 | release の数と遅れ、送金の束の作成の時刻、保留の数 |
| エッジ | WAF の拒否とボットのラベル、CloudFront の 5xx |

- 繁忙期は、このダッシュボードを夕方の山の 1 時間前から当番が見る（[runbooks/](../runbooks/README.md) の 5.2 節）。

## 6. 不正・お金・PMS・SSRF のダッシュボード（ADR-0080）

| 面 | パネル | 元 |
| --- | --- | --- |
| 乗っ取り | 新しい端末の `otp` のログイン、強い確認の始まりと失敗、`payout_waits` と `payout_holds` の始まり（理由ごと）、「これは私ではない」、`locked` の数、待っている送金の数と額 | AMP（`identity`、`payouts`） |
| 送金 | 送金の束・実行・失敗、新しい口座の数、同じ口座の HMAC が 2 つ以上のホストのアカウントにある数 | AMP、日次の Athena |
| 予約の不正 | 支払いの方法ごと・アカウントの年齢の帯ごとの、1,000 予約あたりのチャージバックの率、`step_up`・`hold` の率 | 日次の Athena、AMP（`trust-safety`） |
| 偽のリスティング・パーティー | 理由のコードごとの `hold`・`block`、審査の待ち行列の年齢、措置の取り消しの率、公平さの段の率（[quality.md](../quality.md) の 2.2.1 節 I） | AMP（`trust-safety`）、日次 |
| 位置のスクレイピング | 検索の経路ごとの速さの上限の拒否、データセンターの IP の率、細かい範囲の検索の繰り返しの数 | WAF のログ、AMP |
| 名簿 | ホストのアカウントの名簿の表示の数の分布（普段の 5 倍を超えたホストのアカウントの数。[security.md](security.md) の 3.5 節）、運用者の見せた数 | AMP（`compliance-jp`、`ops-api`） |
| お金 | 仮勘定の残り、`fx_clearing` の残高、release の遅れ | AMP（`ledger`）、日次 |
| PMS | アプリごとの要求の数・429・`stale_sequence`・`conflict`・大きな解放の数、予約の読み出しの数 ÷ 同意の数、同意の増え方、Webhook の再送の率と `disabled` の購読 | AMP（`partner-api`、`webhook-sender`） |
| SSRF | 信用しない宛先の Network Firewall の拒否の数、アプリの検査の拒否の理由ごとの数（私的なアドレス、転送、ポート） | Network Firewall のログ、AMP（`ical-fetcher`、`webhook-sender`） |

- ラベルは低い基数だけ（2.2 節）。利用者・予約・口座を指す値をダッシュボードに出さない。個別の調べは T&S・CS の案件の画面（`ops-api` の JIT。[security.md](security.md) の 6 節）で行う。
- Grafana のフォルダー「不正」「お金」「PMS」は、Identity Center の T&S・セキュリティ・財務・Ops の組にだけ見せる。
- 日次の集計は data のアカウントの Athena で作り、集計の結果（数と額だけ）を Grafana に出す。

## 7. アラート

- アラートの条件と重さは [runbooks/](../runbooks/README.md) の 1・4 節が正本。この文書の指標で AMP のアラートの規則として実装する。
- すべてのアラートは注釈に手順の URL を持つ（CI で検査する）。
- バーンレートの窓（1 時間 14.4 倍・6 時間 6 倍・3 日 1 倍）は、30 日の移動の窓の SLO から計算する規則を SLI ごとに生成する（手で書かない）。
- 正しさの SLI の「最後の成功からの時間」のアラートを、不一致のアラートと対で作る（3 節）。
- runbooks にない次の兆しは、チケットの重さで足す（runbooks を先に直してから）：信用しない宛先の拒否の急増（普段の 10 倍）、PMS のアプリの読み出しの比の急増（普段の 5 倍）、名簿の表示の急増、`telemetry_dropped_attributes_total` の急増。

## 8. アプリの計測と外部送信規律（ADR-0080）

- アプリ（iOS・Android・Web）の計測（画面の表示の時間、クラッシュ、API の誤り）は、本システムの受け口（`api.<brand>.<domain>/telemetry`）にだけ送る。第三者の計測・広告の部品を既定で入れない。
- クラッシュの報告は、スタックの記号と端末の種類だけで、画面の中身・入力の値を含めない。
- 送る項目の一覧（外部送信規律の公表の材料）を `telemetry_disclosure` の文書として持つ。第三者の部品を足すとき、公表の文と同意の扱いは**法務の確認待ち：L9**。

## 9. ログの保持とアクセス

| 種類 | 保持 | 見られる人 |
| --- | --- | --- |
| アプリのログ | CloudWatch 30 日、S3 1 年 | Ops、Dev（読み出しの役割） |
| トレース | 30 日 | Ops、Dev |
| メトリクス | AMP 150 日（既定） | 全員（ダッシュボードのフォルダーの権限による） |
| Network Firewall のログ、VPC フローログ | log-archive 1 年 | セキュリティ、Ops |
| WAF のログ | 90 日 | セキュリティ、Ops |
| 監査の事象 | 7 年（[security.md](security.md) の 6.4 節） | セキュリティ、法務 |

- AMP の保持の既定（150 日）は**未検証**。E1 の `observability-baseline` で確かめる。

## 10. 費用（初期見積もり）

- S1 で月 4,000 USD（[capacity.md](capacity.md) の 6 節。**未検証**）。大きいのは CloudWatch Logs の取り込み。ログの量を、要求ごと 1 行（成功の要求は抜き取り 10%、誤りは全件）に抑える。

## 11. 観測の部品の障害

| 障害 | 影響 | 扱い |
| --- | --- | --- |
| AMP・Grafana | ダッシュボードとアラートが止まる | CloudWatch のアラームを最小の組（予約の 5xx、照合の不一致、照合の最後の成功）で重ねて持つ |
| 照合のジョブの停止 | 正しさが見えない | 最後の成功からの時間で呼び出し（3 節） |
| ADOT の収集器 | トレースが落ちる | サービスは止めない。メトリクスは直接 AMP へ |
| canary のアカウント | 見張りが止まる | `canary_last_run_timestamp_seconds` を本番の側で見る |

## 12. data-model への項目

| 表・置き場所 | 中身 | 節 |
| --- | --- | --- |
| core：`search_samples` | 検索の混入の抜き取りの結果（リスティングの ID、検索の日付と人数、結果、理由のコード、時刻）。30 日 | 3 |
| core：`recon_runs` | 照合のジョブの実行（種類、始まり、終わり、不一致の数、結果）。最後の成功の元 | 3 |
| core：`sentinel_accounts`、`listings.sentinel` の印 | 見張りの利用者とリスティング | 4 |
| AMP | 3 節の指標 | 3 |
| 開発リポジトリ：`packages/telemetry/attributes.ts`、`telemetry_disclosure` | 属性の許可の一覧、送る項目の一覧 | 2.1、8 |

## 13. テストと性質

| ID（草案） | 内容 | テスト |
| --- | --- | --- |
| PROP-OBS-001 | 任意のログの呼び出しの列で、金庫・連絡先・2 者の型の値が出力に現れない（型の検査と、実行の時の落としの両方） | 性質ベース、型の検査 |
| PROP-OBS-002 | 照合のジョブが止まった状態で、正しさの SLI が「良い」と出ない（最後の成功からの時間のアラートが鳴る） | 仮想の時計の結合 |
| — | 空室の鮮度の指標：仮想の時計で、commit から索引の受け付けまでの時刻の差が正しく記録される。古いバージョンで捨てた書き込みを数えない | 結合 |
| — | 検索の混入の抜き取り：わざと古くした写しで、`unbookable` が数えられる | 結合 |
| — | 夜間のログの走査（2.1 節） | 夜間 |
| — | アラートの注釈に手順の URL がある | CI |

## 14. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E1 | `observability-baseline` | 2 節（ADR-0080）、属性の許可の一覧、ログの走査 |
| E5 | `stay-claims-and-exclusion`（[availability-and-calendars.md](availability-and-calendars.md) と共同） | `stay_claims` の照合の指標 |
| E7 | `search-index-and-indexer`・`availability-cache`（[search-and-ranking.md](search-and-ranking.md) と共同） | 空室の鮮度と混入の抜き取りの指標 |
| E12 | `reconciliation`（[ledger-and-payouts.md](ledger-and-payouts.md) と共同） | 決着・台帳・送金の時期の指標 |
| E15 | レビューの公開の照合（[reviews.md](reviews.md) と共同） | レビューの公開の指標 |
| E19 | `webhooks`（[host-tools-and-api.md](host-tools-and-api.md) と共同） | PMS のダッシュボード |
| E20 | `slo-dashboards-alerts` | 3・5・6・7 節（ADR-0079） |
| E20 | `canary-flows` | 4 節 |

## 15. 未解決の問い

### 決定（2026-10-10、既定案）

- **SLI**：全件の時刻の差、照合の最後の成功からの時間、見張りを除く（ADR-0079）。
- **空室の鮮度**：変化ごとに commit から索引の受け付けと写しの書き込みまで（ADR-0079）。
- **検索の混入**：0.1% の抜き取りを応答の時刻の状態で DB で再判定（ADR-0079）。
- **送金の時期**：全件の遅れと、期限を過ぎて release のない数（ADR-0079）。
- **計装**：属性の許可の一覧、型での禁止、検索の語と地図の範囲を出さない（ADR-0080）。
- **アプリの計測**：本システムの受け口だけ（ADR-0080）。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| メッセージの機械の検査の指標に出してよい範囲、外部送信規律の公表 | **法務の確認待ち：L9** |
| AMP の保持の既定と費用 | E1 の `observability-baseline`（**未検証**） |
| 抜き取りの 0.1% で、混入の率 0.5% を十分な精度で見られるか | E7 の後の計測（S1 の夕方の山で 1 時間に約 1 万件のリスティングの抜き取り） |

## 出典

いずれも 2026-10-10 に確認。

- W3C, [Trace Context](https://www.w3.org/TR/trace-context/)
- OpenTelemetry, [Specification](https://opentelemetry.io/docs/specs/otel/)

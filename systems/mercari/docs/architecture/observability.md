# Observability: Mercari

ログ・メトリクス・トレースの計装の規則、[runbooks/](../runbooks/README.md) の SLI の計測（購入の成功、二重の販売の監査、台帳の照合の状態、出品から検索まで、通知の遅れなど）、正しさの見張り、外からの見張り（`canary`）、人気の出品と大型の企画の日のダッシュボード、不正のダッシュボード、アプリの計測と外部送信規律（法務の L11）、ログの保持を決める。

SLO の値とアラートの一覧の正本は [runbooks/](../runbooks/README.md) で、この文書はその計り方を書く。品質の判定基準は [quality.md](../quality.md) の 4 節にある。

前提となる決定は次のとおり。

- 利用者のデータをログに出さない。ID と数と理由のコードだけ（[AGENTS.md](../../AGENTS.md)、[ADR-0071](../decisions/0071-data-classes-and-lifecycle.md)）
- 照合（出品と取引 5 分ごと、取引と台帳 5 分ごと、3 者の照合 日次）（[ADR-0002](../decisions/0002-transaction-state-machine-and-single-purchase.md)、[ADR-0003](../decisions/0003-escrow-and-double-entry-ledger.md)）
- 通知のレーンと遅れの予算（[ADR-0063](../decisions/0063-notification-kinds-lanes-and-payload.md)）
- 計測の基盤は OpenTelemetry（ADOT）→ CloudWatch・AMP・Managed Grafana（[architecture/README.md](README.md) の 4 節）

この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0075](../decisions/0075-sli-measurement-and-correctness-monitors.md) | SLI は runbooks の定義ごとに 1 つの指標の名前と数える場所を持つ。速さの SLI は見張りでなく全件の時刻の差（ヒストグラム）で測り、見張りの出品と見張りの利用者は可用性と端から端の確かめに使い、SLO の計算から除く。正しさの SLI（二重の販売、振り替え、台帳、見える範囲）は、照合の不一致の数と、照合の最後の成功からの時間の両方で見て、照合が止まった間の 0 を良いとしない。計装は属性の許可の一覧で、利用者の ID・出品の ID をメトリクスのラベルにしない |
| [0076](../decisions/0076-fraud-and-money-dashboards.md) | 不正・T&S・お金のダッシュボードは、低い基数のラベル（理由のコード、支払いの方法、運送会社、アカウントの年齢の帯）の集計を AMP に、日次の集計をデータレイク（Athena）から出す。個別の利用者・取引の調べは、T&S と CS の案件の画面（JIT）でだけ行う。ダッシュボードのフォルダーは T&S・セキュリティ・財務の役に絞る。アプリの計測は本システムの受け口にだけ送り、第三者の計測の部品を既定で入れない（外部送信規律は法務の確認待ち：L11） |

## 1. 範囲

| 含む | 含まない（置き場所） |
| --- | --- |
| 計装の規則、指標の名前、トレース、ログ | SLO の値、アラートの条件、手順（[runbooks/](../runbooks/README.md)） |
| SLI の計測と、正しさの見張りの指標 | 照合の処理そのもの（[transactions-and-state-machine.md](transactions-and-state-machine.md)、[ledger-and-proceeds.md](ledger-and-proceeds.md)） |
| 外からの見張り（`canary`） | 見張りの場面の合否の基準（[quality.md](../quality.md) の 4.2 節） |
| ダッシュボード（購入、お金、企画の日、不正） | 不正の規則と審査（[trust-and-safety.md](trust-and-safety.md)） |
| アプリの計測の送り先 | 外部送信規律の公表の文（法務の L11） |

## 2. 計装の規則（ADR-0075）

### 2.1 個人のデータを出さない

- ログ・トレースの属性は、型の許可の一覧（`packages/telemetry/attributes.ts`）だけ。許可の一覧の外の属性は、ロガーとトレーサーが落とし、`telemetry_dropped_attributes_total` を数える。
- 金庫（V）と 2 者（P）の値の型（`Address`、`PersonName`、`PhoneNumber`、`EmailAddress`、`BankAccountNumber`、`MessageBody`）は、ロガーの引数の型に渡せない（型の検査で禁止）。
- 検索の語は、ログにもトレースにも出さない。検索の質の分析は、データレイクの仮名の事象（[security.md](security.md) の 7.3 節）で行う。
- エラーの報告（例外の文）は、文の中の値を落とした形（文の型と位置）で送る。SQL の値、HTTP の本文を送らない。
- 夜間に、合成の利用者で全経路を流し、ログ・トレースを走査する（住所、氏名、電話番号、メールアドレス、口座の番号、カード番号の形）。検出は 0 であること（[quality.md](../quality.md) の 2.2.1 節 G）。本番のログも毎日、同じ形の走査を抜き取りで回す。

### 2.2 指標の名前とラベル

- 名前は `<領域>_<対象>_<単位>`（`purchase_duration_seconds`、`recon_txn_ledger_mismatches`）。
- ラベルに使ってよいもの：サービス、経路、結果のコード、理由のコード、支払いの方法、運送会社、通知の級と経路、AZ、カテゴリの最上位（20 前後）。
- ラベルに使わないもの：利用者の ID、出品の ID、取引の ID、IP、端末の ID、検索の語、ブランドの ID（基数が大きい）。熱い出品の見張り（5 節）は、出品の ID の代わりに「熱い出品の枠」（同時に 20 まで、`slot=0..19`）を使い、枠と出品の対応は運用の画面だけに出す。

### 2.3 トレース

- W3C の Trace Context を、アプリ → `app-api` → ドメインのサービス → outbox の事象（`trace_parent` の列）→ 消費者まで渡す。outbox を越えるところはリンク（親子でない）にする。
- 抜き取りは、既定 1%、エラーと遅い要求（p99 を超えたもの）は 100%（尾の抜き取り。ADOT の収集器）。購入の経路は 10%。
- 決済の提供者・運送会社の呼び出しは、外のスパンとして時間を分け、購入の速さの SLI から提供者の時間を引けるようにする（NFR-002）。

### 2.4 ログの欄

`ts`、`level`、`service`、`trace_id`、`span_id`、`actor_kind`（`user`・`operator`・`service`）、`actor_id`（UUID）、`target_type`、`target_id`、`action`、`outcome`、`reason_code`、`duration_ms`。本文の自由な文の欄は持たない。

## 3. SLI の計測（ADR-0075）

runbooks の 1 節の SLI ごとの、指標と数える場所。

| SLI（runbooks） | 指標 | 数える場所と方法 |
| --- | --- | --- |
| 購入と取引の可用性 | `purchase_requests_total{outcome}`、`txn_ops_requests_total{op,outcome}` | `transactions` の入口。`outcome` は `created`・`sold_out`・`in_progress`・`price_changed`・`insufficient_balance`・`rejected_bot`・`error`・`timeout`。良い＝`error`・`timeout` 以外。`sold_out`〜`rejected_bot` は分母から除く（runbooks の「数えないもの」）。見張りの利用者を除く |
| 購入の速さ | `purchase_duration_seconds`（提供者の時間を除く） | `purchaseListing` の始まりから応答まで。提供者のスパンの時間を引く |
| 負けの応答の速さ | `purchase_duration_seconds{outcome=sold_out\|in_progress}` | 同上 |
| 検索と出品の可用性、検索の速さ | `search_requests_total{outcome}`、`search_duration_seconds`、`listing_write_requests_total{outcome}` | `search-api`、`listings` の入口 |
| 出品から検索まで | `listing_searchable_seconds{kind}` | 全件：`search-indexer` が、出品の事象の commit の時刻から、OpenSearch の bulk の受け付けの時刻＋索引の再読み込みの間隔（1 秒）までを記録する。`kind` は `publish`・`edit`・`hide`（措置・売り切れ・停止） |
| 二重の販売 | `recon_listing_txn_mismatches`、`recon_listing_txn_last_success_timestamp_seconds` | 出品と取引の照合のジョブ（5 分ごと、熱い出品と企画の日は 1 分ごと） |
| 振り替えの一回性 | `recon_txn_ledger_mismatches{kind=duplicate\|both\|missing_15m}`、`recon_txn_ledger_last_success_timestamp_seconds` | 取引と台帳の照合のジョブ（5 分ごと） |
| 台帳の不変条件 | `ledger_invariant_violations{check=balance\|sum_zero\|escrow_settled_zero\|balance_row}`、`..._last_success_timestamp_seconds` | 台帳の夜間の検査と、仕訳の書き込みの時の検査の失敗の数 |
| 3 者の照合 | `ledger_suspense_yen{age=lt_3bd\|ge_3bd}`、`three_way_last_success_timestamp_seconds` | 日次の 3 者の照合のジョブ。3 営業日を過ぎた説明のつかない差の円 |
| 売上金の反映 | `proceeds_reflect_seconds` | `ledger` が release の仕訳の commit の時刻 − 取引の `completed` の事象の時刻 |
| 期限の遅れ | `deadline_lag_seconds{kind}` | `deadline-runner` が、遷移の commit の時刻 − 期限の時刻。全件。止めていた期限（紛争、保留）は止めた時間を引いた期限で数える |
| 配送の状態の反映 | `carrier_event_to_state_seconds{carrier}` | `shipping` が、Webhook の受け付け（照会なら照会の応答）から取引の遷移の commit まで |
| 取引の通知 | `notification_delay_seconds{class=transactional,channel}` | `notifier-send` が、元の事象の commit の時刻から、提供者（APNs・FCM・SES）の受け付けの応答まで（[notifications.md](notifications.md) の 4.3 節） |
| 値下げ・新着の通知 | `notification_delay_seconds{class=engagement,channel}` | 同上。保存した検索は出品の公開・値下げの commit から（3 分のまとめの窓を含む。[ADR-0023](../decisions/0023-saved-search-alert-windows-and-caps.md)）。静かな時間で止めたものは止めた時間を除く |
| 措置の反映 | `moderation_propagation_seconds{surface=search\|notify\|purchase}` | 措置の commit から、各面が反映した時刻（`search-indexer` の受け付け、`listingVisible()` の写しの更新、core の出品の状態） |
| 見える範囲 | `visibility_audit_mismatches{surface}`、`..._last_success_timestamp_seconds` | 見える範囲の監査のジョブ：検索の結果・通知の対象の 0.1% を抜き取り、core の状態と `listingVisible()` で確かめる。値は記録しない |
| 審査の待ち時間 | `review_queue_age_seconds{queue}` | 待ち行列の最古の項目の年齢と、判定までの時間のヒストグラム |

- **照合が止まった 0 を良いとしない**：正しさの SLI は、不一致の数に加えて、最後の成功からの時間を見る。間隔の 2 倍（5 分ごとの照合は 10 分、企画の日の 1 分ごとは 3 分）を過ぎたら、不一致と同じ重さで呼び出す（照合のジョブの停止は、二重の販売を見逃すことと同じ）。
- **全件で測る**：速さの SLI は見張りの出品ではなく全件の時刻の差で測る。見張りは、全件の計測が止まった（索引の処理そのものが止まった）ときに気づくための、可用性の確かめに使う。
- **見張りの除き方**：見張りの利用者・出品は `sentinel` の印を持ち、SLI の指標を出すときに除く。見張りの結果は別の指標（`canary_*`）にする。

## 4. 外からの見張り（`canary`）

canary のアカウント（本番と別の資格情報）から、見張りの売り手と買い手が、15 分ごとに次を確かめる（[quality.md](../quality.md) の 4.2 節）。

| 段 | 確かめること | 指標 |
| --- | --- | --- |
| 出品 | 写真 1 枚の出品が 60 秒で公開 | `canary_step_seconds{step=publish}` |
| 検索 | 公開から 60 秒以内に、見張りの売り手の決めた語で引ける | `canary_step_seconds{step=searchable}` |
| 購入 | 提供者の試験の環境のカードで購入 | `canary_step_seconds{step=purchase}` |
| 発送 | 運送会社の試験の環境の匿名の配送の受け付けと、引き受けの模した事象 | `canary_step_seconds{step=ship}` |
| 受取評価と評価 | 完了まで | `canary_step_seconds{step=complete}` |
| 売上金 | 完了から 1 分で残高に出る | `canary_step_seconds{step=proceeds}` |
| 通知 | 購入の通知が見張りの端末（ファームの実機ではなく、APNs・FCM の試験の受け手）に届く | `canary_step_seconds{step=notify}` |

- 見張りの出品は `listingVisible()` で、見張りの利用者だけに見える（他の利用者の検索に出さない）。この判定の行は [search-and-discovery.md](search-and-discovery.md) と `listingVisible()` の決定表に足す提案にする。
- 2 回続けて失敗した段は呼び出し。各段の失敗は段の名前で手順へつなぐ。
- 提供者・運送会社の試験の環境が落ちているときは、見張りの失敗を本番の障害と分ける（`canary_dependency_up{dep}`）。

## 5. 人気の出品と大型の企画の日のダッシュボード

| パネル | 指標 |
| --- | --- |
| 購入の流れ | `purchase_requests_total` の結果ごとの率、`purchase_duration_seconds` の p50・p99、負けの応答の p99 |
| 熱い出品 | 熱い出品の枠ごと：先着の印の取り合いの数、詳細の閲覧の数、同時実行の上限の待ち、決済の失敗の後の戻しの数（[runbooks/](../runbooks/README.md) の 5.1 節） |
| DB | core の書き込みの CPU、接続の使用率（70% の線）、行のロックの待ち、ledger の commit の待ち（`rds.global_db_rpo` によるもの。[infrastructure.md](infrastructure.md) の 7.2 節） |
| 正しさ | 出品と取引、取引と台帳の照合の不一致と最後の成功からの時間（企画の日は 1 分ごと） |
| 検索 | `search_duration_seconds`、OpenSearch の CPU とキューの拒否 |
| 通知 | 級ごとの `notification_delay_seconds`、レーンの溜まり、静かな時間の後の散らしの山 |
| エッジ | WAF の拒否とボットのラベル、CloudFront の 5xx |

- 企画の日は、このダッシュボードを開始の 1 時間前から当番が見る（[runbooks/](../runbooks/README.md) の 5.2 節）。

## 6. 不正のダッシュボード（ADR-0076）

| 面 | パネル | 元 |
| --- | --- | --- |
| 乗っ取り | 新しい端末の SMS のログイン、強い確認の始まりと失敗、`account_holds` の始まり（理由ごと）、「これは私ではない」、`locked` の数、待っている振込の数と額 | AMP（`identity`、`payouts`） |
| 振込 | 振込の申請・実行・失敗、新しい口座の数、同じ口座の HMAC が 2 つ以上のアカウントにある数、振込の額の帯ごとの数 | AMP、日次の Athena |
| チャージバック | 支払いの方法ごと・アカウントの年齢の帯ごとの、1,000 取引あたりの率 | 日次の Athena |
| 偽の発送 | 匿名でない配送で運送会社の確かめのない `shipped`、確かめのないまま自動の完了に近づく取引、「届かない」の問題の報告 | AMP（`shipping`、`transactions`）、日次 |
| ボットの購入 | 購入の経路の WAF のボットのラベル、同じ端末の帯からの購入の試み | WAF のログ、AMP |
| 偽ブランド・禁止の品 | 理由のコードごとの `hold`・`block`、審査の待ち行列の年齢、措置の取り消しの率 | AMP（`trust-safety`） |
| お金 | 仮勘定の残り、売上金の反映の遅れ、企画のポイントの付与の数と額 | AMP（`ledger`）、日次 |
| スクレイピング | 経路ごとの速さの上限の拒否、データセンターの IP の率、正しい利用者の誤ったブロックの率（チャレンジの通過の率で推す） | WAF のログ |

- ラベルは低い基数だけ（2.2 節）。利用者・取引・口座を指す値をダッシュボードに出さない。数の急な変化から調べるときは、T&S・CS の案件の画面（`ops-api` の JIT。[security.md](security.md) の 6 節）で個別を見る。
- Grafana のフォルダー「不正」と「お金」は、Identity Center の T&S・セキュリティ・財務の組にだけ見せる。
- 日次の集計は data のアカウントの Athena で作り、集計の結果（数と額だけ）を Grafana に出す。

## 7. アラート

- アラートの条件と重さは [runbooks/](../runbooks/README.md) の 1・4 節が正本。この文書の指標で、AMP のアラートの規則として実装する。
- すべてのアラートは、注釈に手順の URL を持つ（CI で検査する）。
- バーンレートの窓（1 時間 14.4 倍・6 時間 6 倍・3 日 1 倍）は、30 日の移動の窓の SLO から計算する規則を、SLI ごとに生成する（手で書かない）。
- 正しさの SLI の「最後の成功からの時間」のアラートを、不一致のアラートと対で作る（3 節）。

## 8. アプリの計測と外部送信規律（ADR-0076）

- アプリ（iOS・Android・Web）は、性能（画面の表示の時間、API の時間）、クラッシュの要約、操作の数を、本システムの受け口（`api.<brand>.<domain>/telemetry`）にだけ送る。OpenTelemetry の形で、利用者の ID は送らず、端末の ID の日ごとの HMAC だけを付ける。
- 第三者の計測・広告の部品は、既定で入れない。入れる場合は、送る先と中身と目的を公表する必要があり、その要否と公表の形は法務の確認待ち（L11）。入れる前に PM と法務の確認を経る。
- クラッシュの要約は、スタックの位置と OS・アプリのバージョンだけで、画面の文と入力の値を含めない。

## 9. ログの保持とアクセス

| 種類 | 置き場所 | 保持 | 見られる人 |
| --- | --- | --- | --- |
| アプリのログ | CloudWatch Logs → S3 | 30 日 → 1 年（[security.md](security.md) の 7.1 節。法務の確認待ち：L5） | Dev・Ops（本番の読みの役） |
| トレース | X-Ray（ADOT） | 30 日 | Dev・Ops |
| メトリクス | AMP | 150 日（AMP の既定。**未検証**）、月次の集計を S3 に 2 年 | 全員（不正・お金は 6 節の組だけ） |
| WAF のログ | S3（log-archive） | 1 年 | セキュリティ、Ops |
| 監査の事象 | log-archive の Object Lock | 7 年（[security.md](security.md) の 6.4 節） | セキュリティ、監査 |

## 10. 費用（初期見積もり）

- S1 で月 約 6,000 USD（CloudWatch Logs の取り込み、AMP の取り込みと保存、X-Ray、Grafana の利用者）。取り込みの量の見積もりと単価は**未検証**で、E1 の後の実績で置き換える（[capacity.md](capacity.md) の 6 節）。
- 最も効く手段は、ログを構造化して 1 要求 1 行にし、INFO のログを経路ごとに抜き取ること、トレースの尾の抜き取り。

## 11. 観測の部品の障害

| 事象 | 影響 | 扱い |
| --- | --- | --- |
| ADOT の収集器の停止 | 指標とトレースの欠け | 収集器はサービスの隣（サイドカー）。欠けは `up` の指標で見つける。SLI は欠けの間を「不明」にし、良いと数えない |
| AMP の障害 | アラートが鳴らない | CloudWatch のメトリクスの最低限のアラーム（ALB の 5xx、SQS の最古の年齢、Aurora の CPU）を別の経路で持つ |
| 照合のジョブの停止 | 正しさの SLI が見えない | 最後の成功からの時間のアラート（3 節） |
| ログの走査の検出 | 個人のデータがログに出た | `privacy-leak-response.md`。出した経路を直し、該当のログを消す（保持の期間の前でも） |

## 12. data-model への項目

| 置き場所 | 中身 | 節 |
| --- | --- | --- |
| 各クラスタ：`outbox` に足す列 | `trace_parent` | 2.3 |
| core：`reconciliation_runs` | 照合の種類、始まり、終わり、見た件数、不一致の件数、結果（不一致の対象の ID は別の表へ） | 3 |
| core・ledger：`reconciliation_findings` | 不一致の対象（出品、取引、仕訳）、種類、見つけた時刻、解決の時刻と主体 | 3 |
| core：`hot_listing_slots` | 熱い出品の枠と出品の対応（運用の画面だけ） | 2.2、5 |
| core：`accounts`・`listings` に足す列 | `sentinel`（見張り） | 3、4 |
| S3（data のアカウント） | 不正のダッシュボードの日次の集計 | 6 |

## 13. テストと性質

| ID（草案） | 内容 | テスト |
| --- | --- | --- |
| PROP-OBS-001 | どのログの行・スパンの属性も、許可の一覧の欄だけを持ち、金庫と 2 者の型の値が現れない | 性質ベース（合成の利用者で全経路）、夜間の走査 |
| — | SLI の規則の生成：runbooks の表から生成したアラートの規則が、全 SLI にバーンレートと「最後の成功」の対を持つ | CI |
| — | 照合のジョブを止めた場面で、`..._last_success` のアラートが間隔の 2 倍で鳴る | 結合（staging） |
| — | `canary` の全段が 15 分で回り、試験の環境の停止を本番の障害と分ける | staging |
| — | アラートの注釈に手順の URL がある | CI |

## 14. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E1 | `observability-baseline` | 2 節（ADR-0075）。属性の許可の一覧、ログの走査、ADOT |
| E1 | `canary-baseline` | 4 節の骨格 |
| E7・E9 | `listing-transaction-reconciler`、`txn-ledger-reconciler` | 3 節の指標と「最後の成功」 |
| E17 | `notification-delay-sli` | 3 節の通知の遅れ |
| E14 | `fraud-dashboards` | 6 節（ADR-0076） |
| E18 | `slo-dashboards-alerts` | 3・5・7 節 |
| E1 | `app-telemetry` | 8 節。公表は法務：L11 |

## 15. 未解決の問い

### 決定（2026-10-10、既定案）

- **SLI**：全件の時刻の差で測り、見張りは可用性と端から端だけ（ADR-0075）。
- **正しさの SLI**：不一致と最後の成功からの時間の対（ADR-0075）。
- **ラベル**：利用者・出品・取引の ID を使わない。熱い出品は枠（ADR-0075）。
- **不正のダッシュボード**：低い基数の集計と日次の集計、個別は案件の画面、組で絞る（ADR-0076）。
- **アプリの計測**：本システムの受け口だけ、第三者の部品を既定で入れない（ADR-0076）。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| アプリの計測の公表の要否と形 | **法務の確認待ち：L11** |
| ログの保持の期間 | **法務の確認待ち：L5** |
| 観測の費用、AMP の保持の既定 | E1 の後の実績（**未検証**） |
| 見張りの出品を `listingVisible()` で見張りだけに見せる行 | [search-and-discovery.md](search-and-discovery.md) と `listing-visible-snapshot` の Story で合意する |

## 出典

- W3C, [Trace Context](https://www.w3.org/TR/trace-context/)（2026-10-10 に確認）
- 単価と費用は [capacity.md](capacity.md) の出典

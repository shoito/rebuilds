# Observability: ServiceNow

ログ・メトリクス・トレース、SLI の計測（可用性、フォームとリストの速さ、保存の速さ、タイマーの遅れ、SLA の違反の発火の遅れ、索引・メール・通知の遅れ）、正しさの監視（本番の突き合わせのジョブ）、テナントとセルのラベル、アラートと runbook の対応、合成監視を決める。道具は他の題材を引き継ぐ：OpenTelemetry（ADOT）→ AMP・X-Ray・CloudWatch Logs、Grafana で横断（[ADR-0001](../decisions/0001-platform-and-stack.md)）。SLO の値とアラートの一覧の正本は Ops の [runbooks/README.md](../runbooks/README.md) に置き、ここにはそれを計測する仕組みを書く。

前提の決定は、NFR-001〜010 と K1〜K6（[intent.md](../intent.md)）、タイマーの遅れの p99 60 秒で SEV2・止まった実行の回収で SEV3（[ADR-0015](../decisions/0015-flow-execution-and-timers.md)）、違反の発火の遅れの計測（[ADR-0021](../decisions/0021-sla-definitions-and-timers.md)）、承認なしの実施の日次の突き合わせ（[ADR-0024](../decisions/0024-change-models-risk-and-cab.md)）、重複の CI の日次の検出（[ADR-0005](../decisions/0005-cmdb-identification-and-reconciliation.md)）、監査のハッシュの鎖の検証（[ADR-0009](../decisions/0009-record-audit-history-and-journal.md)）である。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0059](../decisions/0059-slis-timer-lag-and-correctness-monitors.md) | 可用性の正本はエッジ（CloudFront のリアルタイムのログ）で数え、画面の速さはサーバーの計測と自前の RUM の送信で数える。タイマーの遅れと SLA の違反の発火の遅れは、発火のトランザクションのコミットの時刻と期限の時刻の差で数え、「期限を 60 秒過ぎても発火していない行の数」を別に数える。正しさの監視（突き合わせのジョブと本番の漏れの合成監視）を SLI と同じ扱いにする |
| [0060](../decisions/0060-alerts-and-runbook-mapping.md) | 呼び出しのアラートは、SLO のバーンレート、正しさの監視の 1 件の違反、セキュリティの症状に限る。すべてのアラートは runbook を注釈に持ち、CI で確かめる。個別の runbook ができるまでは incident-response の場面を指す |

## 1. 全体の流れ

```
 セル：app / engine / ingest / notifier / notifier-egress / indexer / relay
        │ OTLP（各タスクの ADOT Collector のサイドカー。属性の許可の一覧で落とす）
        ├─ traces  ─▶ X-Ray
        ├─ metrics ─▶ AMP（セルごとのワークスペース。Grafana で横断）
        └─ logs    ─▶ CloudWatch Logs ─▶ 走査の Lambda（秘密と個人データの形）
                                       └▶ Firehose ─▶ log-archive の S3
 edge：CloudFront のリアルタイムのログ ─▶ Kinesis Data Streams ─▶ 集計 ─▶ AMP（可用性の正本）
 画面：RUM のビーコン（/ui/v1/rum、自前）─▶ app ─▶ AMP（ヒストグラムだけ。個人を結ばない）
 DB の突き合わせのジョブ（engine の日次・毎分）─▶ AMP（正しさの監視の値）
 アラート：AMP のルール → Alertmanager → SNS → オンコール。AWS のリソースは CloudWatch アラーム
```

## 2. 計装

- 計装は開発リポジトリの `packages/telemetry` に集め、ログのイベントの型と、スパンの属性の名前を定数で定義する（他の題材と同じ）。
- 共通の属性：`service.name`、`service.version`、`deployment.environment`、`cloud.region`、`cloud.availability_zone`、`cell.id`、`tenant.id`（4 節の規則）、`tenant.environment`（`production` / `sub_production`）。
- ドメインのスパンを手で足す：テナントの解決、主体の解決と ACL の判定（キャッシュの当たり外れ）、述語のコンパイル、保存の流れの各段（検証、ルール、書き込み、SLA、トリガー）、タイマーの取得と 1 件の処理、承認のまとまりの評価、識別と調整、メールの復号と紐付け、Notifier の受け手ごとの本文、検索の問い合わせと DB での確かめ直し、レポートの問い合わせ。
- **レコードの値・本文・メールの本文・検索の語を、ログ・スパン・メトリクスに入れない。** 出してよい識別子は `tenant_id`、`user_id`、レコードの ID と番号、テーブルの ID、フローの ID、規則の ID、要求の ID。メールアドレス・氏名・IP の全体は出さない（IP は /24）。
- 出さないもの（秘密）：トークン、クライアントシークレット、Webhook の署名の秘密、パスワード、セッションの ID、参照の印の値（推測できない値として扱う）。秘密は `Secret<T>` の型にする（Auth0 の observability.md の 2.1 節と同じ仕組み）。

### 2.1 トレースの伝播

| 境界 | 運び方 |
| --- | --- |
| 利用者 → CloudFront → App | 外部の `traceparent` を受け付けない。サーバーが始め、要求の ID と結び付ける |
| App → outbox → Relay → SQS → Engine・Notifier・Indexer | outbox の行の `trace_context` 列、SQS のメッセージの属性 |
| 保存 → タイマー → Engine | `timer` の行に作ったときの `trace_id` を持ち、発火のスパンをリンクで結ぶ（親子にしない。数日後の発火が同じトレースを長くしないため） |
| mail-ingress → mail-router → セルの Ingest | SQS のメッセージの属性 |

### 2.2 サンプリング

- 先頭でのサンプリング。既定は 5%。エラーと、1 秒を超えた要求・保存、タイマーの処理で 1 秒を超えたものは、末尾のサンプリングで残す。
- 合成監視のテナントと、Ops が一時的に指定したテナントは 100%。

## 3. SLI（[ADR-0059](../decisions/0059-slis-timer-lag-and-correctness-monitors.md)）

### 3.1 一覧

| SLI | 定義 | 計測の場所 | 目標（正本は runbooks） | NFR・K |
| --- | --- | --- | --- | --- |
| 可用性 | 本番のテナントの要求（画面・API・ポータル）のうち、失敗でないものの割合。分類は 3.2 節 | エッジ（CloudFront のリアルタイムのログ） | 99.95%（30 日、セルごと） | NFR-006、K5 |
| フォームのサーバーの時間 | `/ui/v1/form` の処理（レコード＋関連リストの最初の 1 ページ、ACL を含む） | app のヒストグラム | p99 300ms | NFR-001、K1 |
| フォームを開くまで（RUM） | 画面の遷移の開始から、フォームの描画の完了の印まで | RUM | p95 1 秒 | NFR-001、K1 |
| リストの 1 ページ | リストの出口の処理（索引のある条件、50 行まで） | app | p99 500ms | NFR-001、K1 |
| 保存 | Record Service の `save` の処理 | app・engine | p99 700ms | NFR-002 |
| タイマーの遅れ | 発火のトランザクションのコミットの時刻 − `due_at`（優先度・種類別） | engine | 優先度 0・1：p99 60 秒。優先度 2・3：p99 5 分（案。9 時の山の間。[capacity.md](capacity.md) の 3 節） | NFR-003、NFR-004 |
| SLA の違反の発火の遅れ | `sla.breached` を書いたコミットの時刻 − `planned_end` | engine | p99 60 秒 | NFR-003、K2 |
| 期限を過ぎた未発火の違反 | `stage = in_progress` かつ `breached = false` かつ `planned_end < now() − 60 秒` の計時の行の数 | 毎分の突き合わせ（reader） | 0（9 時の山でも） | NFR-003 |
| 止まった実行 | INV-FLOW-001 に反する実行の数（回収した数） | 毎分の検査 | 0 | NFR-004、K3 |
| 索引の遅れ | コミットから検索できるまで | indexer | p95 5 秒、p99 30 秒 | [search.md](search.md) の 7.2 節 |
| メールの取り込みの遅れ | SES の受信の時刻から `inbound_email.status = processed` まで | ingest | p99 2 分（案） | K7 |
| 通知の送信の遅れ | 事象のコミットから SES の受け付けまで | notifier | p99 2 分（案） | — |
| Webhook の配達の遅れ | 事象のコミットから 2xx まで（受け手の失敗を除く） | notifier-egress | p99 1 分（案） | — |
| CMDB の取り込みの速さ | 1 セルの CI/秒 | ingest | 1,000 CI/秒を保てる | NFR-005 |
| DR の複製の遅れ | `AuroraGlobalDBRPOLag` | CloudWatch | 10 秒以内 | NFR-008 |

- 目標の値の案は、NFR と各領域の文書から写した。「案」と書いたものは、NFR に値がなく、この文書で置いた値である。統合で [runbooks/README.md](../runbooks/README.md) の 1 節に SLO として確定した（値は E12 と運用の最初の 3 か月で見直す）。
- 本番のテナント（`tenant.environment = production`）だけを対象にする。サブプロダクションのテナントは別に見る（SLO にしない。[ADR-0002](../decisions/0002-tenancy-and-isolation.md)）。

### 3.2 可用性の数え方

| 応答 | 数え方 |
| --- | --- |
| 2xx、3xx | 成功 |
| 400・401・403・404・409・412・422（利用者の誤り、ACL の拒否、版の衝突、遷移の拒否） | 成功 |
| 429（テナント・クライアント・利用者の使いすぎ） | 成功 |
| 421（テナントの移動の間の古いセル） | 成功（送り直しで届く。件数は別に見る） |
| 503（容量、writer のフェイルオーバー、Valkey・`acl_version` の読み取りの失敗） | 失敗 |
| 5xx、オリジンのタイムアウト、CloudFront の 502・504 | 失敗 |
| 上限を超えた応答時間（画面のモデル 5 秒、API の書き込み 10 秒） | 失敗 |

- エッジのログでは状態コードだけで分ける（応答のヘッダーは記録できない。Auth0 の observability.md の 3.2 節と同じ事情）。応答時間の上限の超過は、サーバーのヒストグラムと合わせて数える。
- 可用性には、メールの受信も含める（NFR-006）。メールの受信の可用性は「SES の受信の後、Ingest が 10 分以内に `processed` か業務の理由の保留（`quarantine`）にした割合」で数える（案）。

### 3.3 タイマーと SLA の遅れの計測

- 遅れは、発火の**コミットの時刻**（DB の `now()` を、同じトランザクションで記録）と `due_at` の差で数える。ワーカーが取った時刻ではない。取った後にトランザクションが失敗・再試行した分も遅れに含めるためである。
- ヒストグラムは優先度（0〜3）と種類（`sla_breach`、`sla_warning`、`approval_due`、`run_step`、`wait_timeout`、`schedule_trigger`、`page_escalation`、`bulk_step`）で分け、テナントのラベルは付けない（4 節）。テナント別の遅れは、毎分の突き合わせで「期限を過ぎた未発火」をテナント別に数える。
- **遅れのヒストグラムだけでは足りない。** 発火しないタイマー（取得の抜け、ワーカーの停止）は、ヒストグラムに現れない。そこで、毎分の突き合わせで「期限を 60 秒過ぎても残っているタイマーの数」（優先度別）と、「期限を過ぎた未発火の違反」（3.1 節）を数える。どちらも 0 が正常である。
- 9 時の山：平日 8:55〜9:15 の遅れの p99 を別の系列にし、日ごとに記録する（[capacity.md](capacity.md) の 3 節の見直しの材料）。

### 3.4 RUM

- 画面は、ページの表示とフォームを開く時間（遷移の開始から、フォームの描画の完了の印まで）と、Web Vitals（LCP・INP）を、`/ui/v1/rum` に一括で送る（最大 20 件・10 秒ごと）。
- 送るのは、画面の種類（フォーム・リスト・ポータルのホーム）、テーブルの ID、時間、端末の種類（デスクトップ・モバイル）、セルとテナントの ID だけ。利用者の ID・URL の全体・レコードの ID は送らない。
- 外部の RUM の事業者を使わない（個人の情報と所在の論点を増やさない。L1・L3）。

## 4. テナントとセルのラベル

- `cell.id` は、すべてのメトリクスのラベルにする。
- `tenant.id` は、上位 N 件（初期値 200。S1 は全テナントが入る）＋「その他」。付けるのは、要求数、エラー数、429 の件数、保存の件数、メールの受信の件数、CMDB の取り込みの件数、フローの作成の件数、抑えたトリガーの件数だけ。ヒストグラム（時間）には付けない（系列の数を抑えるため）。
- `user_id`・レコードの ID はラベルにしない（ログとトレースで引く）。
- テナント別の遅れ・失敗は、DB の突き合わせのジョブ（テナント別に数える）と、ログの集計（CloudWatch Logs Insights）で見る。

## 5. 正しさの監視（[ADR-0059](../decisions/0059-slis-timer-lag-and-correctness-monitors.md)）

設計の「0 件」の約束を、本番で数える。どれも reader で、テナントのコンテキストを設定して行う（テナントをまたぐロールは識別子だけ。[ADR-0054](../decisions/0054-shared-reference-rows-and-cross-tenant-roles.md)）。

| 監視 | 頻度 | 正常 | 異常のとき | 決めた領域 |
| --- | --- | --- | --- | --- |
| 期限を過ぎた未発火の違反・タイマー | 毎分 | 0 | 呼び出し | 3.3 節 |
| 止まった実行（INV-FLOW-001） | 毎分 | 0 | 1 件で SEV3（チケット）、10 件で呼び出し | [workflow-engine.md](workflow-engine.md) の 5.6 節 |
| 承認の決着のない `implement` への遷移 | 日次 | 0 | SEV2 で呼び出し | [itsm-processes.md](itsm-processes.md) |
| 監査のハッシュの鎖の検証 | 日次 | 食い違い 0 | SEV2 で呼び出し | [data-dictionary-and-tables.md](data-dictionary-and-tables.md) の 7.2 節 |
| 重複の CI（正規化の後の同じ識別の値） | 日次 | 0 | チケット | [cmdb-and-reconciliation.md](cmdb-and-reconciliation.md) |
| 存在しない参照、`ext_index` と `ext` の食い違い | 日次 | 0 | チケット | [data-dictionary-and-tables.md](data-dictionary-and-tables.md) |
| 索引と DB の突き合わせの違い | 日次 | 0.1% 未満 | チケット（超えたら SEV3） | [search.md](search.md) の 7.3 節 |
| SLA の期限の抜き取りの計算し直し（参照の実装との比較） | 日次（1 万行の抜き取り） | 不一致 0 | 呼び出し（K2 の約束が破れた） | [sla-and-calendars.md](sla-and-calendars.md) の 14 節 |
| 本番の漏れの合成監視（下の注） | 5 分 | 印の検出 0 | SEV1 で呼び出し | [access-control.md](access-control.md) の 12.3 節 |

- **本番の漏れの合成監視**：各セルの監視用のテナントに、読めないフィールドに「漏れの印」を入れたレコードと、そのフィールドを読めない監視用の利用者を置く。5 分ごとに、その利用者でフォーム・リスト（並べ替え・絞り込み）・件数・検索・レポート・API・エクスポートを呼び、応答に印が出ないことを確かめる。印が出たら、その出口の最近のデプロイを疑う（[runbooks/incident-response.md](../runbooks/incident-response.md) の「ACL の漏れの疑い」）。監視用の利用者と資格情報は Secrets Manager に置き、本物の人の資格情報を使わない。

## 6. 合成監視

CloudWatch Synthetics のカナリアを、大阪から東京の各セルへ実行する（大阪へ切り替えた後は、東京から大阪へ）。各セルの監視用のテナント（`environment = production`）を使う。

| シナリオ | 頻度 |
| --- | --- |
| ログイン → インシデントのフォームを開く → 作業メモを足して保存 | 1 分 |
| リスト（索引のある条件）→ 次のページ | 1 分 |
| ポータル：ホーム → カタログの品目 → 申請（監視用の品目。実行のフローは即時に完了） | 5 分 |
| API：クライアントクレデンシャル → 一覧 → 作成（冪等のキー）→ 取得 | 1 分 |
| メール：監視用の送り手から受信のアドレスへ送り、インシデントの作成と受け付けの通知の受信を確かめる | 5 分 |
| SLA：短い SLA（業務時間 2 分、24 時間 365 日のカレンダー）を持つ監視用のインシデントを作り、違反の発火の遅れを測る | 5 分 |
| 検索：監視用の記事を題名で検索 | 5 分 |
| 漏れの合成監視（5 節） | 5 分 |
| 大阪の ALB へ直接（待機の構成の健全性） | 1 分 |

- 監視用のテナントは、レート制限・ACL の対象から外さない。監視の送信元の IP を WAF の許可の一覧に入れる。

## 7. SLO とアラート（[ADR-0060](../decisions/0060-alerts-and-runbook-mapping.md)）

### 7.1 バーンレート

他の題材と同じマルチウィンドウのバーンレートを使う。99.95% の 30 日のエラーバジェットは約 21.6 分。

| 重さ | 長い窓 | 短い窓 | バーンレート |
| --- | --- | --- | --- |
| 呼び出し | 1 時間 | 5 分 | 14.4 |
| 呼び出し | 6 時間 | 30 分 | 6 |
| チケット | 3 日 | 6 時間 | 1 |

- 可用性はセルごとに数え、セルごとにアラートを出す（1 つのセルの障害を、全体の平均で薄めない）。

### 7.2 アラートと runbook の対応

**すべてのアラートは、runbook の URL を注釈に持つ**（CI で確かめる）。手順の列は、今ある runbook と、各 Epic で作る runbook（`名前.md` の形で書いたもの）を指す。個別の runbook ができるまでは、[incident-response.md](../runbooks/incident-response.md) の該当の場面で対応する。

| アラート | 条件 | 重さ | 手順 |
| --- | --- | --- | --- |
| 可用性の SLO の速いバーンレート（セル別） | 7.1 節 | 呼び出し | `availability-burn.md`（E1）。それまでは [incident-response.md](../runbooks/incident-response.md) |
| 合成監視の連続失敗 | 2 回続けて失敗 | 呼び出し | `availability-burn.md`（E1）。それまでは [incident-response.md](../runbooks/incident-response.md) |
| フォーム・リストの遅れ | フォームのサーバーの p99 が 300ms を 15 分超える、またはリストの p99 が 500ms を 15 分超える | チケット（1 時間で呼び出し） | `form-list-latency.md`（E2）。それまでは [incident-response.md](../runbooks/incident-response.md) |
| **タイマーの遅れ** | 優先度 0 の p99 が 60 秒を 5 分超える、または期限を 60 秒過ぎた優先度 0 のタイマーが 100 件を超える | 呼び出し（SEV2） | [incident-response.md](../runbooks/incident-response.md) の「タイマーの遅れ」（個別：`timer-lag.md`、`sla-breach-lag.md`） |
| **期限を過ぎた未発火の違反** | 1 件以上が 5 分続く | 呼び出し（SEV2） | 同上 |
| 止まった実行の回収 | 1 件（チケット）、10 件/時（呼び出し） | SEV3・SEV2 | `stuck-flow-runs.md`（E4） |
| **承認なしの実施の検出** | 1 件 | 呼び出し（SEV2） | `change-without-approval-detected.md`（E7） |
| **監査のハッシュの鎖の食い違い** | 1 件 | 呼び出し（SEV2） | `audit-chain-mismatch.md`（E2）。[incident-response.md](../runbooks/incident-response.md) の「ACL の漏れの疑い」の証拠の保全を併せて |
| **本番の漏れの合成監視の検出** | 1 件 | 呼び出し（SEV1） | [incident-response.md](../runbooks/incident-response.md) の「ACL の漏れの疑い」 |
| ACL の条件の評価の失敗の急増 | テナントで 1 分に 100 件 | チケット（SEV3） | `acl-compile-failure.md`（E3） |
| ACL の規則のコンパイルの失敗 | 1 件（テーブルが拒否になる） | 呼び出し（SEV2） | `acl-compile-failure.md`（E3） |
| **メールのループの疑い** | 流量の上限に当たった件数が、1 テナントで 10 分に 20 件を超える、または同じ差出人の保留が 1 時間に 50 件 | チケット（全体で 10 倍なら呼び出し） | [incident-response.md](../runbooks/incident-response.md) の「メールのループ」（個別：`mail-loop-detected.md`） |
| メールの取り込みの遅れ・DLQ | 取り込みの遅れの p99 が 10 分、または DLQ が 1 件以上 | 呼び出し | `inbound-email-backlog.md`（E6） |
| 送信の評判（バウンス・苦情の率） | SES のアカウントのバウンスの率 2%、苦情の率 0.05%（案。SES はバウンス 5%・苦情 0.1% で審査、10%・0.5% で送信の停止がありうるとする（[Amazon SES Sending review process FAQs](https://docs.aws.amazon.com/ses/latest/dg/faqs-enforcement.html)、2026-09-28 に確認）ので、その半分の値で呼ぶ） | 呼び出し | `sending-reputation.md`（E6） |
| **CMDB の統合の後の保留の急増** | 統合の後 24 時間に、統合の先の CI を候補に含む保留が 5 件 | チケット | [incident-response.md](../runbooks/incident-response.md) の「CMDB の誤った統合」（個別：`cmdb-wrong-merge.md`） |
| 重複の CI の検出 | 1 件 | チケット | `cmdb-duplicate-detected.md`（E10） |
| CI の保留の急増 | 平常の 5 倍 | チケット | `cmdb-hold-surge.md`（E10） |
| 索引の遅れ | p99 30 秒を 15 分超える、または 5 分を超える | チケット（5 分超は呼び出し） | `search-index-lag.md`（E9） |
| 検索のドメインの赤の状態 | クラスタの状態が赤 | 呼び出し | `opensearch-domain-degraded.md`（E9） |
| Webhook の配達の滞留 | 最古の配達が 30 分を超える（受け手の失敗を除く） | チケット | `webhook-delivery-backlog.md`（E11） |
| outbox の遅れ | 最古の行が 30 秒を超える | 呼び出し | `outbox-lag.md`（E1）。それまでは [incident-response.md](../runbooks/incident-response.md) |
| レポートの reader の飽和 | reader B の CPU 90% が 15 分 | チケット | `report-reader-saturation.md`（E11） |
| 当番の呼び出しの未達 | `page_attempt` の失敗が経路で 10% | 呼び出し | `paging-not-delivered.md`（E5） |
| 祝日の取り込みの失敗、収録の残り 10 か月 | ジョブの失敗・残りの月数 | チケット | `holiday-import.md`（E5） |
| DR の複製の遅れ | `AuroraGlobalDBRPOLag` が 10 秒を 5 分超える | 呼び出し | [disaster-recovery.md](../runbooks/disaster-recovery.md) |
| 大阪の待機の構成の異常 | 大阪の合成監視の失敗、plan の差分 | チケット（30 分で呼び出し） | [disaster-recovery.md](../runbooks/disaster-recovery.md) |
| デプロイ中の自動のロールバック、フラグのガード | [delivery.md](delivery.md) の 5・6 節 | 呼び出し | [deploy-and-rollback.md](../runbooks/deploy-and-rollback.md) |
| ルーターの 421 の急増 | テナントの移動の外で 1 分に 10 件 | 呼び出し | `router-mapping-mismatch.md`（E1）。それまでは [incident-response.md](../runbooks/incident-response.md) |
| 秘密・個人データの形のログの検出 | 走査で 1 件 | 呼び出し（SEV2） | `sensitive-data-in-logs.md`（E1）。それまでは [incident-response.md](../runbooks/incident-response.md) |
| 重要なセキュリティの仕組みの失敗 | GuardDuty・CloudTrail・走査の Lambda・マルウェアの検査の停止 | 呼び出し | `security-control-disabled.md`（E1）。それまでは [incident-response.md](../runbooks/incident-response.md) |

- 呼び出しのアラートは、SLO、正しさの約束（0 件の監視）、セキュリティの症状に限る。原因の側の指標（CPU、接続数）はチケットとダッシュボードにとどめる。
- アラートの条件の値は案で、E12 の負荷試験と運用の最初の 3 か月で調整する。

## 8. ログ

| 項目 | 内容 |
| --- | --- |
| `ts`、`level`、`event`、`service`、`version`、`env`、`region`、`az`、`cell` | どこで、いつ、何の事象か |
| `trace_id`、`span_id`、`request_id` | 追跡 |
| `tenant_id`、`tenant_env` | テナント |
| `user_id`、`client_id`、`table_id`、`record_id`、`number`、`flow_id`、`run_id`、`rule_id` | 識別子だけ |
| `route`、`status`、`duration_ms`、`error_code` | HTTP（`route` はルートの型） |

| データ | すぐに使える場所 | 保管 |
| --- | --- | --- |
| アプリのログ | CloudWatch Logs 30 日 | log-archive 13 か月 |
| CloudFront・WAF のログ | S3＋Athena 30 日 | log-archive 13 か月 |
| メトリクス | AMP 150 日 | 保管しない |
| トレース | X-Ray 30 日 | 保管しない |

- ログの走査：秘密の形（本システムの接頭辞 `<brand>_at_`・`<brand>_cs_`・`<brand>_whsec_`、JWT、PEM）と、個人データの形（メールアドレス）を探す。見つけたら呼び出す。1 日 1 回、合成の値を書いて走査が止まっていないことを確かめる（Auth0 の observability.md の 4.3 節と同じ仕組み）。
- アプリのログとメトリクスは、Ops と許可した Dev の常設の読み取り。AI エージェントは本番のテレメトリーへの経路を持たない（[security.md](security.md) の 8 節）。

## 9. ダッシュボード

| ダッシュボード | 主な中身 | 見る人 |
| --- | --- | --- |
| SLO | 3.1 節の SLI（セル別）、バジェットの残り、バーンレート | 全員 |
| タイマー | 遅れのヒストグラム（優先度・種類別）、9 時の山、期限を過ぎた未発火、取得の件数と取り分、engine の台数 | Ops、Dev |
| 正しさ | 5 節の監視の値の推移 | Ops、QA |
| 画面 | フォーム・リスト・保存の時間、RUM、409 の件数 | Ops、Dev |
| メールと通知 | 受信の分類、保留、ループの兆し、送信の遅れ、バウンス・苦情 | Ops |
| CMDB | 取り込みの速さ、結果の内訳、保留、統合 | Ops |
| 検索とレポート | 索引の遅れ、確かめ直しで落ちた割合、reader B | Ops |
| テナント | テナント別の要求・429・保存・受信（上位 200） | Ops、PM |
| DR | 複製の遅れ、大阪の健全性 | Ops |

## 10. Epic との対応

| Epic | Story の候補 |
| --- | --- |
| E1 | `packages/telemetry`、Collector の許可の一覧、ログの走査、エッジの SLI の集計、アラートの runbook の注釈の CI |
| E2 | 保存の流れのスパンとヒストグラム、`ext_index` の突き合わせ |
| E3 | 本番の漏れの合成監視（監視用のテナント・利用者・印） |
| E4 | タイマーの遅れ（コミットの時刻）、期限を過ぎたタイマーの毎分の数え、止まった実行 |
| E5 | 期限を過ぎた未発火の違反、SLA の抜き取りの計算し直し、SLA の合成監視 |
| E6 | メールの取り込みの SLI、メールの合成監視、ループの兆し |
| E8 | RUM の送信（ポータル） |
| E9・E10・E11 | 索引・CMDB・レポート・Webhook の SLI |
| E12 | SLO の確定、アラートの値の調整、9 時の山の系列 |

## 11. quality.md・runbooks・data-model への項目

### quality.md

- 5 節の正しさの監視の値（すべて 0 が目標）を、QA の本番での品質検証（シフトライト）の指標にする。
- 9 時の山のタイマーの遅れの p99 の日ごとの推移。
- RUM のフォームを開く p95（K1）。

### runbooks

- [incident-response.md](../runbooks/incident-response.md)：タイマーの遅れ、ACL の漏れの疑い、メールのループ、CMDB の誤った統合の場面を持つ。
- [runbooks/README.md](../runbooks/README.md)：3.1 節の SLO と 7.2 節のアラートの一覧を正本として持つ（統合で作った）。
- `availability-burn.md`・`outbox-lag.md`・`sensitive-data-in-logs.md`・`security-control-disabled.md`（E1）、`form-list-latency.md`（E2）：共通の進め方だけで受けていたアラートの専用の手順（2026-09-28 の見直しで計画に入れた）。

### data-model（索引への追加の提案）

| 置き場所 | 中身 |
| --- | --- |
| AMP（セルごと） | 3・5 節のメトリクス |
| Aurora `correctness_check_run`（監視の結果、90 日） | 5 節。突き合わせのジョブの結果と件数 |
| 監視用のテナント（各セル） | 5・6 節。`environment = production`、本物の人の情報を持たない |

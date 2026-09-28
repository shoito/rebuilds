# Observability: Workday

ログ・メトリクス・トレース、SLI の計測、給与の実行の監視、個人情報を出さない計装、アラートと runbook の対応、合成監視を扱う。道具は他の題材を引き継ぐ：OpenTelemetry（ADOT）→ AMP・X-Ray・CloudWatch Logs、Grafana で横断（[ADR-0001](../decisions/0001-platform-and-stack.md)）。SLO の値とアラートの一覧の正本は Ops の [runbooks/README.md](../runbooks/README.md) に置き、ここにはそれを計測する仕組みを書く。監査の記録（誰が何を見たか）は [audit-and-retention.md](audit-and-retention.md) の領域で、ここは本システムの運用のためのテレメトリーである。

| ADR | 決定 |
| --- | --- |
| [0058](../decisions/0058-pii-free-telemetry.md) | 個人情報を出さない計装を 4 層で守る：型（`Pii<T>`、型付きのイベント）、Collector の属性の許可リスト、URL に個人情報を入れない API の規則、ログの走査（個人番号の形と既知の鍵の名前）。走査が動いていることを、印つきの合成の番号で毎日確かめる。保管庫のテレメトリーは保管庫のアカウントに閉じ、外にはメトリクスだけを出す |
| [0059](../decisions/0059-payroll-run-slo-and-synthetic-run.md) | 給与の実行は、支給日から逆算した里程標（入力の固定、計算の完了、確定、振込ファイルの承認）に対する遅れで監視し、本システムの原因の遅れを SLI にする。本番の監視用のテナントで、合成の従業員の給与を毎日計算し（確定しない）、ゴールデンデータの期待値と比べる |

## 1. 全体の流れ

```
 prod：api / bp-worker / worker / relay / loader / payroll-compute / egress-worker / audit-archiver
        │ OTLP（各タスクの ADOT Collector のサイドカー。属性の許可リストで落とす）
        ├─ traces  ─▶ X-Ray
        ├─ metrics ─▶ AMP
        └─ logs    ─▶ CloudWatch Logs ─▶ 走査の Lambda（4.3 節）
                                       └▶ Firehose ─▶ log-archive の S3

 edge：CloudFront のリアルタイムのログ ─▶ Kinesis ─▶ 集計の Lambda ─▶ AMP（可用性の SLI の正本）
 vault-prod：同じ形の流れを保管庫のアカウントの中に持つ。外（shared の Grafana）へはメトリクスだけ（クロスアカウントの読み取り）
 AWS：CloudTrail・Config ─▶ log-archive。KMS の操作のアラート

 Grafana（shared）：AMP・CloudWatch・X-Ray を読む
 アラート：AMP のルール → Alertmanager → SNS → オンコール。AWS のリソースは CloudWatch アラーム → SNS
```

## 2. 計装

- 計装は開発リポジトリの `packages/telemetry` に集め、ログのイベントの型と、スパンの属性の名前を定数で定義する（他の題材と同じ）。
- 共通の属性：`service.name`、`service.version`、`deployment.environment`、`cloud.region`、`cloud.availability_zone`、`tenant.id`（3.4 節の規則）、`tenant.environment`（`production`・`sandbox`・`internal`）。
- 領域の属性（値は ID とコードだけ）：`bp.process_type`、`bp.case_id`、`payroll.run_id`、`payroll.run_type`、`payroll.chunk_id`、`payroll.engine_digest`、`rule_table.version_id`、`report.definition_id`、`import.batch_id`、`time.terminal_id`。
- ドメインのスパンを手で足す：権限の判定（`can`・`scopeFilter`）、有効日付の畳み込み、業務プロセスの状態の遷移、入力の固定（従業員の束ごと）、束の計算、取り込み、PDF の生成、振込ファイルの生成、保管庫の呼び出し。
- Payroll Compute の計算の関数そのものには計装を入れない（純粋な関数を保つ。[ADR-0004](../decisions/0004-payroll-engine.md)）。束の単位のスパンと件数のメトリクスを、呼び出す側で出す。

### 2.1 個人情報を出さない（[ADR-0058](../decisions/0058-pii-free-telemetry.md)）

| 層 | 仕組み |
| --- | --- |
| (1) アプリ | P2 以上の値は `Pii<T>` の型（`toString`・`toJSON` は `[REDACTED]`）。ロガーは型付きのイベントだけを受け、イベントの項目は P0・P1 の ID とコードだけ（[security.md](security.md) の 4 節）。HTTP の自動計装は `url.full`・`url.query`・見出しを付けず、`url.path` をルートの型にする。エラーの本文は定型の文とコードだけ |
| (2) Collector | 許可リストにない属性のキーを削除する |
| (3) API の規則 | URL（パスとクエリ）に個人情報を入れない。検索の条件は `POST` の本文で送る。パスの引数は ID だけ（lint で確かめる）。ALB・CloudFront のログにクエリが残っても個人情報がない |
| (4) 走査 | 全ロググループを購読のフィルターで走査し、個人情報の形を見つけたら呼び出す（4.3 節） |

出してよいものと、出さないもの：

| 出してよい | 出さない |
| --- | --- |
| `tenant_id`、`worker_id`、`employment_id`、`case_id`、`run_id`、`chunk_id`、`mn_ref`、要求の ID、エラーのコード、件数、時間、IP の /24 | 氏名、社員番号、住所、生年月日、連絡先、給与・控除の額（個人のものも合計も）、口座番号、扶養の内容、休職の種類、打刻の時刻、個人番号とその一部、入力の文書の中身 |

- 給与の額は、テナントの合計でもメトリクスにしない（少人数のテナント・グループで個人の額になる）。件数と時間だけにする。
- 社員番号は人が読める識別子で、テナントの中では個人を特定しやすい。`worker_id` を使う。

### 2.2 トレースの伝播

| 境界 | 運び方 |
| --- | --- |
| 利用者 → API | 外部の `traceparent` を受け付けない。サーバーが始める |
| API → outbox → Relay → SQS → Worker・BP Worker | outbox の行の `trace_context`、SQS のメッセージの属性 |
| 入力の固定 → 束 → Payroll Compute → Loader | 束のメッセージに `trace_context`。実行の全体を 1 つのトレースの親に結ぶ |
| 人事の側 → 保管庫 | `traceparent`（相互 TLS の中）。保管庫の側のトレースは保管庫のアカウントの X-Ray に置き、ID だけで結ぶ |

### 2.3 サンプリング

- 先頭で 5%。エラーと 1 秒を超えた要求は、末尾のサンプリングで残す。
- 給与の実行のトレース（束の単位）は 100%（件数が少ない）。
- 監視用のテナントは 100%。

## 3. メトリクスと SLI

### 3.1 種類

| 種類 | 対象 | 主な指標 |
| --- | --- | --- |
| RED | 全サービス | 要求数、エラー数、処理時間のヒストグラム（ルートの型ごと） |
| USE | Aurora、Valkey、ECS、SQS、ALB、NAT、KMS | 使用率、飽和（接続、ロック待ち、複製の遅延、キュー）、エラー、スロットリング |
| 有効日付と業務プロセス | api、bp-worker | 畳み込みの時間、`SAME_DAY_CONFLICT` の件数、発効の予定の遅れ、タイマーの遅れ、`stuck` の件数、受信箱の読み取りの時間 |
| 勤怠 | api、worker | 打刻の受付の時間、端末から遅れて届いた打刻、再計算の遅れ、36 協定の日次の判定の遅れ |
| 給与 | 3.3 節 | 実行の段の遅れ、束の時間、`error` の人数、再現の抜き取りの不一致 |
| 権限と監査 | api、audit-archiver | 判定の p99、拒否の件数、監査の書き出しの遅れ、連鎖の検証の結果 |
| 保管庫 | vault | 呼び出しの数と結果、記録の突き合わせの欠け、削除の候補の経過日数 |

### 3.2 利用者の経路の SLI

**可用性の正本は CloudFront のリアルタイムのログから数えたもの。** サーバーの計測は原因を分けるために使う。

| SLI | 定義 | 計測 | 目標（正本は [runbooks/README.md](../runbooks/README.md) の 1 節） |
| --- | --- | --- | --- |
| 画面・API の可用性（NFR-004） | 本番のテナントの要求のうち、失敗でないものの割合 | エッジ | 99.9%（30 日） |
| 給与の経路の可用性（NFR-004） | 支給日の前の 5 営業日の、給与の担当の画面・API（`/api/*/payroll*`）と振込ファイルの生成・取り出しの成功の割合 | エッジと worker | 99.95%（その期間） |
| 画面の操作の処理時間（NFR-005） | 一覧・レポートの出力を除く API | api | p95 500ms、p99 1.5 秒 |
| 打刻（NFR-005） | 打刻の受付の API | api | p99 300ms |
| 時点の問い合わせ（NFR-005） | `effective_on`・`known_at` つきの 1 人の問い合わせ | api | p99 300ms |
| 発効の遅れ | 発効の予定の `fire_at` から実行まで | bp-worker | p99 5 分（[ADR-0008](../decisions/0008-point-in-time-queries-and-activation-timers.md)） |
| 36 協定の警告（K5） | 退勤の打刻から判定まで、日次の判定の完了 | worker | 退勤ごとは p95 5 分、日次は毎日 2 時までに完了 |

応答の分類：2xx・3xx は成功。400・401・403・404・409（業務の規則の拒否：`SAME_DAY_CONFLICT` など）・429（テナントのレート制限）は成功。503、5xx、オリジンのタイムアウト、上限を超えた応答の時間（同期の API 10 秒）は失敗。

### 3.3 給与の実行の SLI（[ADR-0059](../decisions/0059-payroll-run-slo-and-synthetic-run.md)）

- 各実行は、支給日から逆算した里程標を持つ（[payroll-engine.md](payroll-engine.md) の 4.2 節）：勤怠の締め、入力の固定、計算の完了、確定、振込ファイルの承認（`lead_business_days` 前）。
- 里程標ごとに「予定の時刻」と「実際の時刻」を記録し、遅れの原因を `system`（本システムの処理の遅れ・失敗）と `tenant`（担当の操作の待ち）に分ける。原因は、段の状態と、段の中の待ち（人の操作を待っていた時間）から求める。

| SLI | 定義 | 目標（正本は runbooks の 1 節） |
| --- | --- | --- |
| 給与の実行の時間の遵守 | 本番の実行のうち、`system` の原因で里程標に遅れなかった実行の割合 | 99.9%（月） |
| 計算の時間（NFR-003） | 計算の段の開始から `computed` まで。人数で正規化（1 万人あたり） | 1 万人 15 分以内。3 万人 45 分以内 |
| 1 人の再計算（NFR-003） | 確認の段の 1 人の計算し直し | p99 5 秒 |
| 振込ファイルの生成 | 承認の依頼の時点でファイルが作れている割合 | 100% |
| 再現の抜き取り | 夜間の抜き取りの不一致 | 0 件（1 件で SEV1） |
| 合成の給与の実行 | 3.5 節の毎日の結果の一致 | 100% |

### 3.4 テナントのラベル

- `tenant_id` は、上位 N 件（初期値 100）＋「その他」。付けるのは、要求数、エラー数、給与の実行の段の遅れ、束の時間だけ。
- 給与の実行は数が少ないので、`payroll.run_id` はメトリクスのラベルにせず、ログとトレースで引く。

### 3.5 合成の給与の実行（[ADR-0059](../decisions/0059-payroll-run-slo-and-synthetic-run.md)）

- 本番に社内の監視用のテナント（`environment = internal`）を置き、ゴールデンデータセットの代表の合成の従業員（100 人ほど：甲欄・乙欄、介護の有無、60 時間超の残業、日割り、遡及）を持つ。
- 毎日 6 時に、`run_type = parallel`（確定しない）の実行を作り、本番のエンジン・本番の規則表で計算し、ゴールデンデータの期待値と比べる。
- 規則表の公開・エンジンのデプロイの直後にも、同じ実行を走らせる（[delivery.md](delivery.md) の 5・6 節）。
- 不一致は SEV2（本番のテナントの確定を止めるかを IC が判断する）。期待値は、その日の支払日に当たる規則表の版の期待値を使う（規則表の改正の前後で期待値が変わる）。

## 4. ログ

### 4.1 共通の形

1 行 1 JSON の構造化ログ。項目は許可リスト方式。

| 項目 | 内容 |
| --- | --- |
| `ts`、`level`、`event`、`service`、`version`、`env`、`region`、`az` | どこで、いつ、何の事象か |
| `trace_id`、`span_id`、`request_id` | 追跡 |
| `tenant_id`、`tenant_env` | テナント |
| `worker_id`、`employment_id`、`case_id`、`run_id`、`chunk_id`、`batch_id` | 領域の ID |
| `route`、`status`、`duration_ms`、`error_code`、`reason` | HTTP（`route` はルートの型） |
| `ip_prefix`、`ua_family` | 端末 |

### 4.2 保持

| データ | すぐに使える場所 | 保管 |
| --- | --- | --- |
| アプリのログ | CloudWatch Logs 30 日 | log-archive 13 か月 |
| CloudFront・WAF のログ | S3＋Athena 30 日 | log-archive 13 か月 |
| CloudTrail、Config、VPC フローログ | S3＋Athena 90 日 | log-archive 13 か月 |
| メトリクス | AMP 150 日 | 保管しない |
| トレース | X-Ray 30 日 | 保管しない |
| 監査ログ | [audit-and-retention.md](audit-and-retention.md) | 同左 |

### 4.3 個人情報の形の走査（[ADR-0058](../decisions/0058-pii-free-telemetry.md)）

- 全ロググループ（保管庫のアカウントを含む。保管庫の走査は保管庫のアカウントの中で行う）に購読のフィルターで走査の Lambda をつなぐ。探す形：
  - 個人番号の形：数字 12 桁（区切りの空白・ハイフンを許す）で、チェックデジットが合うもの。前後の文脈（鍵の名前 `my_number`・`kojin_bango`・`mn` や、`個人番号`）があれば確度を上げる。
  - 既知の鍵の名前に値が付いたもの：`account_number`、`birth_date`、`address`、`full_name`、`salary`、`amount`、`dependents`、`bank`。
  - 本システムのトークンの接頭辞（`<brand>_at_`、`<brand>_tk_`）、PEM の秘密鍵。
- 見つけたら呼び出す（個人番号の形は SEV2、その他は SEV3 から。通知には場所と件数だけを書き、値を書かない）。
- **走査が止まっていないことを確かめる。** 1 日 1 回、合成の生成器（印つき）の番号を専用のロググループに書き、検出されることを確かめる。検出されなければ呼び出す。
- CloudWatch Logs のデータ保護の方針を補助として使う（日本の個人番号の管理された識別子があるかは未検証）。
- 検出の後は [runbooks/incident-response.md](../runbooks/incident-response.md) の「個人情報の出力」と「マイナンバーの漏えいの疑い」。
- 四半期ごとに、S3（入力の文書、レポートの出力、取り込みのファイル、分析用の基盤）の抜き取りの走査も行う。

### 4.4 アクセス

- アプリのログ（個人情報を含まない）とメトリクスは、Ops と許可した Dev の常設の読み取り（[ADR-0053](../decisions/0053-operator-access-and-vault-break-glass.md)）。
- CloudFront・WAF のログ（IP の全体を含む）は期限つきの権限で読む。
- 保管庫のログは保管庫のアカウントの中だけで、期限つきの権限（セキュリティの担当の承認）で読む。
- AI エージェントは本番のテレメトリーへの経路を持たない。

## 5. SLO とアラート

### 5.1 バーンレート

他の題材と同じマルチウィンドウのバーンレートを使う（呼び出し：1 時間・5 分で 14.4、6 時間・30 分で 6。チケット：3 日・6 時間で 1）。支給日の前の 5 営業日の給与の経路（99.95%）は、その期間だけの SLO として別に数える。

- すべてのアラートは、対応する runbook の URL を注釈に持つ（CI で検査する）。

### 5.2 アラートの一覧と runbook

**アラートの一覧の正本は [runbooks/README.md](../runbooks/README.md) の 4 節**（統合の工程で、各領域の文書の「runbooks」の項目と、作る Epic・Story を集めた）。下は計測の側から見た主なアラートで、値を変えるときは runbooks を先に変える。個別の runbook ができるまでは [incident-response.md](../runbooks/incident-response.md) の該当の節で対応する。

| アラート | 条件 | 重さ | 手順 |
| --- | --- | --- | --- |
| 画面・API の SLO の速いバーンレート | 5.1 節 | 呼び出し | [incident-response.md](../runbooks/incident-response.md) |
| 給与の経路の SLO（支給日の前） | 5 分間の失敗の率 0.5% 超 | 呼び出し | [incident-response.md](../runbooks/incident-response.md) |
| 合成監視の連続失敗 | 2 回続けて失敗（6 節） | 呼び出し | [incident-response.md](../runbooks/incident-response.md) |
| 給与の実行の里程標の遅れ（`system`） | 予定の時刻を 30 分過ぎても段が進まない | 呼び出し（支給日の 3 営業日前以降）、チケット（それより前） | `payroll-run-stuck.md`（[payroll-engine.md](payroll-engine.md)） |
| 振込ファイルの承認の締め切りの接近 | 締め切りの 4 時間前に `released` でない本番の実行 | チケット（テナントへの連絡を支援が行う） | `bank-file-release.md`（[payments-and-accounting.md](payments-and-accounting.md)） |
| 再現の抜き取りの不一致、`ENGINE_DRIFT` | 1 件 | 呼び出し（SEV1） | `payroll-reproducibility-mismatch.md`（[payroll-engine.md](payroll-engine.md)） |
| 合成の給与の実行の不一致 | 1 件 | 呼び出し（SEV2） | [incident-response.md](../runbooks/incident-response.md) の「給与の計算の誤り」 |
| 束の失敗の率 | 実行の中で 1% 超の束が 3 回の再試行で失敗 | 呼び出し | `payroll-run-stuck.md` |
| 大阪での振込ファイルの作り直しのハッシュの不一致 | 1 件 | 呼び出し（SEV2） | [disaster-recovery.md](../runbooks/disaster-recovery.md) |
| DR の複製の遅延 | `AuroraGlobalDBRPOLag` が 60 秒を 5 分超える | 呼び出し | [disaster-recovery.md](../runbooks/disaster-recovery.md) |
| 個人番号の形の検出 | 4.3 節 | 呼び出し（SEV2） | [incident-response.md](../runbooks/incident-response.md) の「マイナンバーの漏えいの疑い」 |
| 個人情報の形の検出 | 4.3 節 | 呼び出し（SEV3 から） | [incident-response.md](../runbooks/incident-response.md) の「個人情報の出力」 |
| 走査の停止 | 合成の番号が検出されない | 呼び出し | [incident-response.md](../runbooks/incident-response.md) |
| 保管庫の記録の欠け・連鎖の検証の失敗 | 日次の突き合わせ・検証 | 呼び出し（SEV2） | `vault-access-log-gap.md`（[my-number-vault.md](my-number-vault.md)） |
| 保管庫の鍵・主張の署名の鍵の想定外の使用 | CloudTrail | 呼び出し（SEV2 から） | [incident-response.md](../runbooks/incident-response.md) の「マイナンバーの漏えいの疑い」 |
| 監査の連鎖の検証の失敗 | 日次 | 呼び出し（SEV2） | `audit-chain-verification-failure.md`（[audit-and-retention.md](audit-and-retention.md)） |
| 監査の書き出しの遅れ | 最古の未書き出しの行が 1 時間 | 呼び出し | `audit-archiver-lag.md` |
| 有効日付の夜間の検査の食い違い | 1 件 | チケット（SEV2） | `temporal-consistency-mismatch.md`（[object-model-and-effective-dating.md](object-model-and-effective-dating.md)） |
| 発効の予定の遅れ | p99 が 5 分を超える | 呼び出し（4 月 1 日の前後）、チケット | `activation-backlog.md` |
| 業務プロセスの `stuck` | 24 時間 | チケット（SEV3） | `bp-stuck-steps.md`（[business-process-engine.md](business-process-engine.md)） |
| 打刻の受付の遅れ・端末からの集中 | 打刻の p99 が 300ms を 10 分超える | 呼び出し（始業の時間帯） | `clock-ingest-backlog.md`（[time-and-attendance.md](time-and-attendance.md)） |
| 36 協定の日次の判定の遅れ | 2 時までに終わらない | チケット（1 時間で呼び出し） | `overtime-alert-job-delay.md` |
| 閉包と辺の食い違い | 1 件 | チケット（SEV2） | `org-closure-rebuild.md`（[core-hr.md](core-hr.md)） |
| outbox の遅れ | 最古の行が 60 秒を超える | 呼び出し | [incident-response.md](../runbooks/incident-response.md) |
| マイナンバーの削除の遅れ | 候補から 30 日を超える | チケット | `mn-deletion-overdue.md` |
| デプロイ中の自動ロールバック、フラグのガード | [delivery.md](delivery.md) の 5・6 節 | 呼び出し | [deploy-and-rollback.md](../runbooks/deploy-and-rollback.md) |
| 規則表の公開の遅れ | 改正の暦の適用の 5 営業日前に `published` でない | チケット（2 営業日前で呼び出し） | `statutory-rate-calendar.md`（[payroll-jp-rules.md](payroll-jp-rules.md)） |
| 期限を過ぎた運用者の権限 | 割り当てが残る | 呼び出し | `operator-access-review.md` |

呼び出しのアラートは、SLO、支払の締め切り、個人情報・マイナンバー、給与の正しさの症状に限る。原因の側の指標（CPU など）はチケットとダッシュボードにとどめる。

## 6. 合成監視

CloudWatch Synthetics のカナリアを、大阪から東京へ実行する（切り替えの後は逆）。本番の監視用のテナント（`environment = internal`）を使う。

| シナリオ | 頻度 |
| --- | --- |
| ログイン（パスキーの仮想の認証器）→ ホーム → 自分の情報（`asOf` を 2 つ） | 1 分 |
| 打刻（監視用の雇用）と、その打刻の読み取り | 1 分 |
| 受信箱の読み取り、監視用の案件の起票と承認（2 つの監視用の利用者） | 5 分 |
| 公開の API（クライアントクレデンシャル → 一覧） | 1 分 |
| レポートの同期の実行（監視用の定義） | 5 分 |
| 合成の給与の実行（3.5 節） | 毎日 6 時と、デプロイ・規則表の公開の直後 |
| 大阪の ALB へ直接（待機の構成の健全性） | 1 分 |
| 大阪での振込ファイルの作り直し（[infrastructure.md](infrastructure.md) の 6.4 節） | 支給日の前の 5 営業日は毎日 |
| 保管庫の `status` の呼び出し（監視用の `mn_ref`） | 5 分 |

- 監視用のテナントのデータは合成だけ。監視用の利用者の資格情報は Secrets Manager に置く。

## 7. ダッシュボード

| ダッシュボード | 主な中身 | 見る人 |
| --- | --- | --- |
| SLO | 3.2・3.3 節の SLI、バジェットの残り | 全員 |
| 給与の実行 | 今後 5 営業日の実行の予定（テナント × 支給日のヒートマップ）、実行ごとの段と里程標の遅れ、束の進み、`error` の人数、Payroll Compute のタスク数と同時の上限、Loader の遅れ | Ops、給与の支援 |
| 支給日の DR | 複製の遅延、大阪での作り直しの結果、大阪の台数 | Ops |
| 業務プロセスと有効日付 | タイマーと発効の遅れ、`stuck`、畳み込みの時間 | Ops、Dev |
| 勤怠 | 打刻の受付、始業の時間帯の負荷、再計算の遅れ、36 協定の判定 | Ops |
| セキュリティ | 走査の結果、KMS の操作、保管庫の記録の突き合わせ、監査の連鎖、運用者の権限 | Ops、セキュリティの担当 |

## 8. Epic との対応

| Epic | Story の候補 |
| --- | --- |
| E1 | `packages/telemetry`（型付きのイベント、`Pii<T>`）、Collector の許可リスト、走査の Lambda と合成の番号、アラートと runbook の注釈の CI、エッジの SLI の集計 |
| E6 | 打刻の SLI、36 協定の判定の遅れ |
| E8 | 給与の実行の里程標の記録と SLI、合成の給与の実行、給与の実行のダッシュボード |
| E10 | 振込ファイルの生成の SLI、大阪での作り直しの確認 |
| E11 | 保管庫のアカウントのテレメトリー、記録の突き合わせのアラート |
| E12 | SLO の確定、アラートの調整、DR のダッシュボード |

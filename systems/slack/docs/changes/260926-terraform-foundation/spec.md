---
capability: infrastructure
change: 260926-terraform-foundation
issue:
epic: E1
status: draft
---

# Spec: Terraform の基盤（アカウント、状態、ネットワーク、CI の認証）

## 概要

AWS の上にアプリを載せる前の土台を作る。対象は次の 6 つ。

1. AWS Organizations と 7 つのアカウント、SCP、組織の CloudTrail
2. IAM Identity Center による人のアクセスの基本形（IAM ユーザーを作らない、break-glass の通知）
3. Terraform の状態のバケット（アカウント・リージョンごと、バージョニング、KMS、S3 のネイティブのロック）。災害復旧で apply するルートモジュール用の大阪のバケット
4. 環境ごとの VPC（3 AZ、public / private / isolated のサブネット、VPC エンドポイント、フローログ）
5. GitHub Actions の OIDC と、plan 用・apply 用のロール。prod の apply は `main` の `prod` 環境からだけ
6. インフラの CI：静的検査（fmt、validate、tflint、Checkov）、plan、plan に対するポリシー検査（状態を持つリソースの削除・置き換えを止める）、マージ後の apply、毎日のドリフトの検知

**含めないもの**（後の Story）：ECS・ALB・Aurora・Valkey・SQS などのワークロード（`post-and-list-messages` 以降と E7）、GuardDuty・Security Hub・AWS Config の有効化と委任（E7 のセキュリティの基盤）、AWS Network Firewall と Route 53 Resolver DNS Firewall（E7 `waf-baseline` の前後で起票）、CloudFront と `global/edge`（最初に Web を公開する Story）、Aurora Global Database と大阪の DR 資源（E7 `dr-pilot-light-osaka`）、アプリの build-once とデプロイ（E7 `blue-green-deploy-pipeline`）。ただし、それらが後から入る場所（ルートモジュールの配置、状態の置き場所、ロールの信頼条件）は、この変更で決める。

関係する決定：[ADR-0011](../../decisions/0011-aws-container-platform.md)、[ADR-0017](../../decisions/0017-encryption-and-key-management.md)、[ADR-0020](../../decisions/0020-infrastructure-as-code-with-terraform.md)、[ADR-0021](../../decisions/0021-observability-stack.md)、[infrastructure.md](../../architecture/infrastructure.md) の 1・2・5・6 節、[security.md](../../architecture/security.md) の 7.3・8・10 節。

非機能要件への影響：NFR-007（3 AZ にまたがるサブネットを用意する）、NFR-008（大阪側の状態と VPC を、東京に依存せずに操作できるようにする）。NFR-001〜006・009 には直接の影響はない。

## ADDED Requirements

### REQ-INFRA-001: 組織とアカウントの構成

システムは、AWS Organizations の下に、[infrastructure.md](../../architecture/infrastructure.md) の 1 節の 7 つのアカウント（management、security、log-archive、shared、dev、staging、prod）を、定められた OU に置かなければならない。management のアカウントには、ワークロード（VPC、ECS、DB、アプリのバケット）を置いてはならない。

#### Scenario: アカウントと OU の対応

- Given `live/global/organization` を apply した組織
- When 組織のアカウントと親 OU を一覧する
- Then 次の対応とちょうど一致する：security・log-archive → Security、shared → Infrastructure、dev・staging → Workloads/NonProd、prod → Workloads/Prod、management → Root。これ以外のアカウントはない

#### Scenario: management にワークロードを置こうとする

- Given management のアカウントを対象にしたルートモジュール
- When `aws_vpc` を含む plan を作る
- Then ポリシー検査が失敗し、「management にワークロードを置かない」旨のメッセージを出す

### REQ-INFRA-002: SCP によるガードレール

メンバーのアカウントで、DT-INFRA-001 で「拒否」になる操作が要求された場合、システムは IAM の許可にかかわらず、その操作を拒否しなければならない。

#### Scenario: 許可されていないリージョン

- Given dev のアカウントで、AdministratorAccess 相当の権限を持つロール
- When `us-west-2` に S3 バケットを作る
- Then `AccessDenied`（SCP による明示的な拒否）が返る

#### Scenario: 大阪は使える

- Given 同じロール
- When `ap-northeast-3` で `ec2:DescribeVpcs` を呼ぶ
- Then 成功する

#### Scenario: CloudTrail の停止

- Given prod のアカウントで、AdministratorAccess 相当の権限を持つロール
- When 組織の証跡に対して `cloudtrail:StopLogging` を呼ぶ
- Then `AccessDenied` が返り、証跡は記録を続ける

### REQ-INFRA-003: 人のアクセスは IAM Identity Center だけ

システムは、人のアクセスを IAM Identity Center の許可セットだけで与え、どのアカウントにも IAM ユーザーを置いてはならない。グループとアカウントの組み合わせごとの許可セットは DT-INFRA-002 に従わなければならない。

#### Scenario: IAM ユーザーがない

- Given この変更を apply した 7 つのアカウント
- When 各アカウントで `iam:ListUsers` を呼ぶ
- Then どのアカウントでも 0 件である

#### Scenario: Dev は prod に入れない

- Given Dev グループだけに属する利用者
- When AWS のアクセスポータルを開く
- Then prod のアカウントは一覧に出ず、prod の許可セットでのサインインもできない

#### Scenario: Ops の日常のアクセスは prod で読み取りのみ

- Given Ops グループの利用者が、prod に `ViewOnly` でサインインしている
- When セキュリティグループのルールを追加する
- Then `AccessDenied` が返る

### REQ-INFRA-004: break-glass の利用の通知

`BreakGlass` の許可セットでいずれかのアカウントにサインインしたとき、システムは 5 分以内に、利用者・アカウント・時刻を Ops の通知先へ送らなければならない。

#### Scenario: prod での break-glass

- Given Ops グループの利用者
- When prod のアカウントに `BreakGlass` でサインインする
- Then 5 分以内に、security のアカウントの SNS トピックへ、利用者名・アカウント ID・時刻を含む通知が届く

#### Scenario: 日常の許可セットでは通知しない

- Given Ops グループの利用者
- When prod のアカウントに `ViewOnly` でサインインする
- Then break-glass の通知は送られない

### REQ-INFRA-005: 組織の CloudTrail

システムは、全アカウント・全リージョンの管理イベントを、組織の CloudTrail で log-archive のアカウントの S3 バケットへ記録しなければならない。バケットは S3 Object Lock（コンプライアンスモード、1 年）とバージョニングを持ち、KMS のカスタマー管理キーで暗号化しなければならない。

#### Scenario: 別のアカウントの操作が記録される

- Given dev のアカウントで `ec2:CreateTags` を実行した
- When 15 分後に log-archive のバケットを検索する
- Then その操作のイベントが見つかる

#### Scenario: 記録の削除

- Given log-archive のバケットにある証跡のオブジェクト
- When log-archive の管理者権限で、そのオブジェクトのバージョンを削除する
- Then Object Lock により拒否される

### REQ-INFRA-006: 状態のバケット

システムは、Terraform のルートモジュールを持つアカウント・リージョンの組ごとに、状態ファイル専用の S3 バケットを 1 つ持たなければならない。各バケットは、バージョニング、状態専用の KMS カスタマー管理キーによる SSE-KMS、パブリックアクセスのブロック、`aws:SecureTransport` が false の要求の拒否を持たなければならない。

#### Scenario: 設定の確認

- Given prod の東京の状態のバケット
- When バケットの設定を読む
- Then バージョニングが有効、既定の暗号化が状態専用のキーによる `aws:kms`、パブリックアクセスのブロックの 4 項目がすべて true、バケットポリシーに `aws:SecureTransport` = false を拒否する文がある

#### Scenario: 壊れた状態から戻す

- Given apply の途中の失敗で、状態ファイルの最新のバージョンが壊れている
- When 1 つ前のバージョンを最新として復元する
- Then `terraform plan` が復元した状態をもとに実行できる

#### Scenario: TLS なしの要求

- When `http://` のエンドポイントで状態ファイルを取得する
- Then 拒否される

### REQ-INFRA-007: 状態の置き場所

システムは、各ルートモジュールの状態を、DT-INFRA-003 が定めるアカウント・リージョンのバケットに置かなければならない。backend の設定が DT-INFRA-003 と一致しない場合、CI は失敗しなければならない。

#### Scenario: 大阪のルートモジュール

- Given `infra/live/prod/ap-northeast-3/network`
- When backend の設定を読む
- Then バケットは prod の大阪の状態のバケット、`region` は `ap-northeast-3` である

#### Scenario: 置き場所の誤り

- Given `infra/live/prod/ap-northeast-3/network` の backend が、東京のバケットを指す PR
- When PR の CI が走る
- Then 状態の置き場所の検査が失敗し、正しいバケット名を示す

### REQ-INFRA-008: 状態のロック

同じルートモジュールに対して、ロックを取った操作が進行している間、システムは別の操作のロックの取得を失敗させ、状態を書き換えさせてはならない。ロックは S3 のネイティブのロック（`use_lockfile = true`）で行い、DynamoDB を使ってはならない。

#### Scenario: 同時の apply

- Given dev の `network` で apply が進行中
- When 別のジョブが同じルートモジュールで apply を始める
- Then 後のジョブはロックの取得に失敗して終了し（待ち時間の上限を過ぎた場合）、状態は先のジョブの結果だけを反映する

#### Scenario: DynamoDB を指定した backend

- Given backend に `dynamodb_table` を書いた PR
- When PR の CI が走る
- Then 静的検査が失敗する

### REQ-INFRA-009: 災害復旧のルートモジュールは東京に依存しない

東京リージョンが使えない間も、システムは `prod/ap-northeast-3/*` と `global/edge` のルートモジュールについて、`init`・`plan`・`apply` ができなければならない。

#### Scenario: 東京を遮断しての plan

- Given 東京リージョンのエンドポイント（`*.ap-northeast-1.amazonaws.com`）への通信を遮断した CI のジョブ
- When `infra/live/prod/ap-northeast-3/network` で `init` と `plan` を実行する
- Then どちらも成功する

#### Scenario: 東京の値の参照を持ち込む

- Given `prod/ap-northeast-3/network` から、東京の SSM Parameter Store の値を読む `data` を足す PR
- When PR の CI が走る
- Then 東京への依存の検査が失敗する

### REQ-INFRA-010: 環境ごとの VPC

システムは、dev・staging・prod（東京）と prod（大阪）に VPC を 1 つずつ持ち、各 VPC に 3 つの AZ にまたがる public・private・isolated のサブネットを持たなければならない。各サブネットの経路は DT-INFRA-004 に従わなければならない。VPC の CIDR は互いに重なってはならない。

#### Scenario: サブネットの数と AZ

- Given staging の VPC
- When サブネットを一覧する
- Then 9 つあり、public・private・isolated が、`ap-northeast-1a`・`1c`・`1d` に 1 つずつある

#### Scenario: isolated からは外に出られない

- Given prod（東京）の isolated のサブネット
- When その経路表を読む
- Then `0.0.0.0/0` と `::/0` への経路がなく、VPC の中と S3 のゲートウェイ型エンドポイントへの経路だけがある

#### Scenario: private の NAT は同じ AZ

- Given prod（東京）の `1c` の private のサブネット
- When その経路表を読む
- Then `0.0.0.0/0` の行き先は、`1c` の public のサブネットにある NAT ゲートウェイである

### REQ-INFRA-011: VPC エンドポイント

稼働中の VPC（dev・staging・prod の東京）では、システムは次の VPC エンドポイントを持ち、AWS のサービスへの通信を NAT に出してはならない：S3（ゲートウェイ型）、ECR（`api`・`dkr`）、SQS、Secrets Manager、KMS、CloudWatch Logs、STS、X-Ray、AppConfig（`appconfig`・`appconfigdata`）。インターフェイス型はプライベート DNS を有効にし、セキュリティグループで VPC の CIDR からの 443 だけを許可しなければならない。

#### Scenario: プライベート DNS

- Given dev の private のサブネットで動くテスト用のタスク
- When `sqs.ap-northeast-1.amazonaws.com` を名前解決する
- Then VPC の CIDR の中のアドレスが返る

#### Scenario: VPC の外からの接続

- Given VPC の CIDR の外のアドレス
- When インターフェイス型エンドポイントの 443 に接続する
- Then セキュリティグループで拒否される

### REQ-INFRA-012: VPC のフローログ

システムは、すべての VPC のフローログ（許可と拒否の両方）を、log-archive のアカウントの S3 バケットへ送らなければならない。

#### Scenario: 拒否された通信の記録

- Given staging の isolated のサブネットのネットワークインターフェイス
- When 外部のアドレスへの接続が拒否される
- Then 15 分以内に、log-archive のバケットに `REJECT` のレコードが届く

### REQ-INFRA-013: GitHub Actions の OIDC とロール

システムは、Terraform のルートモジュールを持つ各アカウントに、GitHub Actions の OIDC で引き受ける `tf-plan` と `tf-apply` の 2 つのロールを持たなければならない。どの OIDC トークンがどのロールを引き受けられるかは、DT-INFRA-005 に従わなければならない。長期のアクセスキーを使ってはならない。

#### Scenario: PR からの plan

- Given `shoito/rebuilds` の PR のワークフロー（環境の指定なし）
- When prod の `tf-plan` を引き受ける
- Then 成功する

#### Scenario: PR から apply のロール

- Given 同じ PR のワークフロー
- When dev の `tf-apply` を引き受ける
- Then `AccessDenied` が返る

#### Scenario: prod の apply は main の prod 環境だけ

- Given `main` 以外のブランチで、環境 `prod` を指定したジョブ
- When prod の `tf-apply` を引き受ける
- Then `AccessDenied` が返る（加えて、GitHub の環境のブランチの制限で、ジョブ自体が始まらない）

#### Scenario: 別のリポジトリ

- Given 別のリポジトリのワークフロー
- When どのアカウントのどのロールを引き受けても
- Then `AccessDenied` が返る

### REQ-INFRA-014: 変更のあるルートモジュールだけを plan する

`infra/` を変える PR が作られた・更新されたとき、システムは DT-INFRA-006 が定める、影響を受けるルートモジュールだけで `plan` を実行し、ルートモジュールごとの plan の要約（作成・変更・削除・置き換えの件数と、削除・置き換えの対象）を PR にコメントしなければならない。

#### Scenario: 1 つのルートモジュールの変更

- Given `infra/live/dev/ap-northeast-1/network/main.tf` だけを変える PR
- When PR の CI が走る
- Then dev の `network` だけが plan され、その要約が PR のコメントに 1 件ある

#### Scenario: モジュールの変更

- Given `infra/modules/vpc/` を変える PR。`vpc` を使うルートモジュールは dev・staging・prod 東京・prod 大阪の `network`
- When PR の CI が走る
- Then その 4 つのルートモジュールが plan される

### REQ-INFRA-015: apply はマージ後の CI だけ

`main` にマージされたとき、システムは PR と同じ手順で作り直した plan ファイルを、DT-INFRA-005 の apply のロールで apply しなければならない。staging・prod・基盤のアカウント（management、security、log-archive、shared）への apply は、GitHub の環境で Ops の承認を得てから行わなければならない。apply までの間に状態が変わっていた場合、システムは apply を失敗させなければならない。

#### Scenario: dev は自動、prod は承認待ち

- Given dev と prod の `network` を変える PR がマージされた
- When マージ後のワークフローが走る
- Then dev は承認なしに apply され、prod は Ops の承認を待つ

#### Scenario: 古い plan

- Given prod の plan を作った後、承認を待つ間に、別のマージで同じルートモジュールの状態が更新された
- When Ops が承認し、最初の plan ファイルを apply する
- Then Terraform が「plan が古い」として失敗し、何も変更しない。ワークフローは plan を作り直して、もう一度承認を求める

### REQ-INFRA-016: 静的検査

`infra/` を変える PR で、システムは `terraform fmt -check`、`terraform validate`、tflint（AWS のルール）、Checkov を実行し、次のどれかに当たれば失敗しなければならない。

- fmt・validate のエラー、tflint のエラー
- Checkov の High 以上の検出（抑止の注記に、理由と承認者がないもの）
- 状態を持つ型（Design の「状態を持つリソースの型」）のリソースに `lifecycle { prevent_destroy = true }` がない
- ストレージ（S3、CloudWatch Logs、KMS を使える資源）が、カスタマー管理キー以外で暗号化されている（ADR-0017 の Confirmation）

#### Scenario: prevent_destroy の付け忘れ

- Given `aws_s3_bucket` を `prevent_destroy` なしで追加する PR
- When PR の CI が走る
- Then 静的検査が失敗し、リソースのアドレスを示す

#### Scenario: 理由のない抑止

- Given `#checkov:skip=CKV_AWS_144` だけを書いた（理由がない）PR
- When PR の CI が走る
- Then 静的検査が失敗する

### REQ-INFRA-017: 状態を持つリソースの削除・置き換えを止める

plan に、状態を持つ型のリソースの削除または置き換えが含まれる場合、システムは DT-INFRA-007 に従って CI を失敗させなければならない。

#### Scenario: バケットの置き換え

- Given 状態のバケットの名前を変え、plan で置き換え（delete → create）になる PR
- When plan のポリシー検査が走る
- Then 失敗し、アドレスと動作（replace）を示す

#### Scenario: moved での名前の変更

- Given 同じバケットのアドレスだけを `moved` ブロックで変える PR
- When plan のポリシー検査が走る
- Then plan に削除・作成がなく、成功する

#### Scenario: 承認された例外

- Given `infra/policy/exceptions/` に、対象のアドレス・動作・ルートモジュール・承認者（Ops と Dev のテックリード）・期限（未来の日付）を書いた例外がある
- When そのアドレスの削除を含む plan を検査する
- Then 成功し、例外を使ったことを PR のコメントに書く

### REQ-INFRA-018: モジュールのテスト

`infra/modules/` の各モジュールは `terraform test` のテストを持ち、システムはそのモジュールを変える PR で、そのテストを実行しなければならない。テストのないモジュールがある場合、CI は失敗しなければならない。

#### Scenario: テストのないモジュール

- Given `tests/` を持たない `infra/modules/foo/` を足す PR
- When PR の CI が走る
- Then 失敗する

### REQ-INFRA-019: 毎日のドリフトの検知

システムは、毎日 1 回、すべてのルートモジュールで `terraform plan -detailed-exitcode` を実行し、結果に応じて DT-INFRA-008 の処理をしなければならない。

#### Scenario: コンソールでの変更

- Given dev のセキュリティグループに、コンソールから手でルールを 1 つ足した
- When 翌日のドリフトの検知が走る
- Then dev の `network` について、ドリフトの Issue（Design のラベル）が 1 件作られ、差分の要約を含む

#### Scenario: 解消

- Given dev の `network` に、開いたドリフトの Issue がある
- When 手の変更を元に戻し、次のドリフトの検知で差分がなくなる
- Then その Issue に解消のコメントが付き、閉じられる

## Decision Tables

### DT-INFRA-001: SCP による拒否

メンバーのアカウントでの API の要求に対する SCP の判定。上から順に評価し、最初に一致した行を採用する。「SCP では許可」は、IAM のポリシーで許可されていれば実行できることを表す。management のアカウントには SCP が効かないため、この表の対象外である。

| # | 操作 | 主体 | リージョン | → 判定 |
| --- | --- | --- | --- | --- |
| 1 | CloudTrail・GuardDuty・AWS Config の停止・削除（`cloudtrail:StopLogging`、`cloudtrail:DeleteTrail`、`cloudtrail:UpdateTrail`、`guardduty:DeleteDetector`、`guardduty:DisassociateFromAdministratorAccount`、`config:StopConfigurationRecorder`、`config:DeleteConfigurationRecorder`、`config:DeleteDeliveryChannel`） | - | - | 拒否 |
| 2 | `organizations:LeaveOrganization` | - | - | 拒否 |
| 3 | - | アカウントの root ユーザー | - | 拒否 |
| 4 | - | - | `ap-northeast-1` または `ap-northeast-3` | SCP では許可 |
| 5 | グローバルなサービスの操作（IAM、Organizations、STS、CloudFront、WAF（CloudFront のスコープ）、ACM、Route 53、IAM Identity Center、Support、Budgets、Cost Explorer） | - | `us-east-1` | SCP では許可 |
| 6 | - | - | 上記以外 | 拒否 |

### DT-INFRA-002: 人のアクセス（グループ × アカウント）

上から順に評価し、最初に一致した行を採用する。`ViewOnly` はリソースの設定の閲覧だけを許し、データ（S3 のオブジェクト、秘密情報の値、ログの中身、DB の中身）は読めない。`BreakGlass` は管理者権限で、セッションは 1 時間。使うと REQ-INFRA-004 の通知が出る。

| # | グループ | アカウント | → 許可セット |
| --- | --- | --- | --- |
| 1 | Ops | すべて | `ViewOnly`、`BreakGlass` |
| 2 | Dev | dev | `ViewOnly`、`DevPowerUser`（IAM・Organizations・アカウントの設定を除く） |
| 3 | Dev | staging、shared | `ViewOnly` |
| 4 | Dev | management、security、log-archive、prod | なし |
| 5 | その他 | - | なし |

### DT-INFRA-003: 状態の置き場所

ルートモジュールのパス（`infra/live/` からの相対）から、状態のバケットを決める。上から順に評価し、最初に一致した行を採用する。

| # | パス | → アカウント | → リージョン |
| --- | --- | --- | --- |
| 1 | `prod/ap-northeast-3/*` | prod | 大阪 |
| 2 | `global/edge` | prod | 大阪 |
| 3 | `global/*` | management | 東京 |
| 4 | `<account>/ap-northeast-1/*`（`<account>` は 7 つのアカウントのどれか） | `<account>` | 東京 |
| 5 | それ以外 | CI を失敗させる（未知のルートモジュール） | — |

### DT-INFRA-004: サブネットの経路

| # | サブネット | 稼働中か（大阪は待機） | → `0.0.0.0/0` の行き先 | → S3 のゲートウェイ型エンドポイント |
| --- | --- | --- | --- | --- |
| 1 | public | - | Internet Gateway | あり |
| 2 | private | 稼働中 | 同じ AZ の NAT ゲートウェイ | あり |
| 3 | private | 待機 | なし | あり |
| 4 | isolated | - | なし | あり |

### DT-INFRA-005: OIDC のトークンとロールの引き受け

GitHub の OIDC トークンの属性（リポジトリ、コンテキスト、ref、環境）で判定する。上から順に評価し、最初に一致した行を採用する。「基盤のアカウント」は management・security・log-archive・shared を指す。

| # | リポジトリ | コンテキスト | ref | 環境 | ロール | → 判定 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `shoito/rebuilds` 以外 | - | - | - | - | 拒否 |
| 2 | - | `pull_request`（同じリポジトリのブランチからの PR） | - | なし | `tf-plan`（全アカウント） | 許可 |
| 3 | - | ブランチ、または環境 | `refs/heads/main` | - | `tf-plan`（全アカウント） | 許可 |
| 4 | - | - | - | - | `tf-plan` | 拒否 |
| 5 | - | - | `refs/heads/main` 以外 | - | `tf-apply` | 拒否 |
| 6 | - | 環境 | `refs/heads/main` | `dev` | dev の `tf-apply` | 許可 |
| 7 | - | 環境 | `refs/heads/main` | `staging` | staging の `tf-apply` | 許可 |
| 8 | - | 環境 | `refs/heads/main` | `prod` | prod の `tf-apply` | 許可 |
| 9 | - | 環境 | `refs/heads/main` | `platform` | 基盤のアカウントの `tf-apply` | 許可 |
| 10 | - | - | - | - | `tf-apply` | 拒否 |

- 9 行目の `platform` 環境は、management・security・log-archive・shared の apply に使う。環境とアカウントが食い違う組（例：環境 `dev` で prod の `tf-apply`）は 10 行目で拒否される。
- フォークからの PR には OIDC のトークンを発行しない（GitHub の既定）。したがって 2 行目には当たらない。

### DT-INFRA-006: plan するルートモジュール

変更されたファイルごとに、上から順に評価し、最初に一致した行を採用する。PR 全体で plan するルートモジュールは、ファイルごとの結果の和集合とする。

| # | 変更されたパス | → plan するルートモジュール | → そのほかの検査 |
| --- | --- | --- | --- |
| 1 | `infra/live/<root>/**`（`.terraform.lock.hcl` を含む） | `<root>` | 静的検査 |
| 2 | `infra/modules/<m>/**` | `<m>` を直接・間接に使う全ルートモジュール | `<m>` の `terraform test`、静的検査 |
| 3 | `infra/policy/**` | なし | ポリシーのテスト（Proof の PROP-INFRA-003） |
| 4 | `infra/.terraform-version`、`infra/.tflint.hcl`、`infra/.checkov.yaml` | 全ルートモジュール | 静的検査 |
| 5 | `.github/workflows/infra-*.yml` | 全ルートモジュール | — |
| 6 | それ以外 | なし | なし |

### DT-INFRA-007: plan のポリシー検査

plan の JSON（`terraform show -json`）の `resource_changes` の 1 件ごとに評価する。上から順に評価し、最初に一致した行を採用する。1 件でも「失敗」があれば検査は失敗する。

| # | リソースの型 | 動作（`change.actions`） | 有効な例外（アドレス・動作・ルートモジュールが一致し、期限内で、承認者が 2 ロールそろう） | → 結果 |
| --- | --- | --- | --- | --- |
| 1 | 状態を持つ型 | `delete` を含む（`["delete"]`、`["delete","create"]`、`["create","delete"]`） | あり | 成功（例外の利用を報告する） |
| 2 | 状態を持つ型 | `delete` を含む | なし | 失敗 |
| 3 | 状態を持つ型 | `forget`（`removed` ブロックで状態から外す） | - | 警告（PR にコメントする） |
| 4 | - | 対象のアカウントが management で、型が VPC・ECS・RDS・S3（状態のバケット・証跡のバケットを除く） | - | 失敗 |
| 5 | - | - | - | 成功 |

### DT-INFRA-008: ドリフトの検知の結果の扱い

ルートモジュールごとに評価する。上から順に評価し、最初に一致した行を採用する。

| # | `plan -detailed-exitcode` の終了コード | そのルートモジュールの開いたドリフトの Issue | → 処理 |
| --- | --- | --- | --- |
| 1 | 2（差分あり） | なし | Issue を作る（差分の要約を含む） |
| 2 | 2 | あり | その Issue に、今日の差分の要約をコメントする |
| 3 | 1（エラー） | - | エラーの Issue を作るか、既存のエラーの Issue にコメントする |
| 4 | 0（差分なし） | あり | 解消のコメントを付けて閉じる |
| 5 | 0 | なし | 何もしない |

## Correctness Properties

### PROP-INFRA-001: 状態の更新は直列になる

同じルートモジュールに対する、任意の数の並行した `plan`・`apply`（ロックを取るもの）の列に対して、状態ファイルの各バージョンの `serial` は狭義単調増加し、各 apply は、自分が読んだ状態の直後のバージョンとしてだけ書き込む（ある apply が、別の apply の書いた結果を読まずに上書きすることはない）。

### PROP-INFRA-002: 災害復旧のルートモジュールの依存は東京を含まない

DT-INFRA-003 の 1・2 行に当たる任意のルートモジュールについて、backend・provider・`data` の参照・参照するモジュール・`terraform_remote_state`・SSM Parameter Store の読み取りが指すリージョンの集合に、`ap-northeast-1` は含まれない。

### PROP-INFRA-003: ポリシー検査は、保護すべき変更をすべて止める

任意の plan の JSON（リソースの型、動作、アドレス、例外の組み合わせを任意に含む）に対して、ポリシー検査が成功することと、「状態を持つ型で `delete` を含む `resource_change` が、すべて有効な例外で覆われている、かつ DT-INFRA-007 の 4 行に当たるものがない」ことは同値である。

### PROP-INFRA-004: plan のロールは、データを読めず、状態のロック以外を書けない

任意のアカウントの `tf-plan` について、IAM のポリシーの評価（IAM Policy Simulator）で、データの読み取りの操作（`s3:GetObject`（状態のバケット以外）、`secretsmanager:GetSecretValue`、`kms:Decrypt`（状態のキー以外）、`logs:GetLogEvents`、`logs:StartQuery`、`rds-data:*`、`dynamodb:GetItem`・`Scan`・`Query`、`sqs:ReceiveMessage`）と、書き込みの操作（`Create*`・`Put*`・`Update*`・`Delete*`・`Attach*`・`Modify*` の全操作。ただし状態のバケットの `*.tflock` のキーへの `s3:PutObject`・`s3:DeleteObject` を除く）は、すべて拒否と評価される。

## Design

### ディレクトリと状態

[ADR-0020](../../decisions/0020-infrastructure-as-code-with-terraform.md) の構成に従う。`infra/` は `systems/slack/infra/` に置く。ADR-0020 の図にない基盤のアカウントは、`live/<account>/<region>/` として同じ形で並べる。

```
systems/slack/infra/
├── .terraform-version          # Terraform のバージョンを固定する（1.11 以上。use_lockfile の GA の版は 未検証）
├── .tflint.hcl  .checkov.yaml
├── modules/
│   ├── state-bucket/           # バケット、KMS キー、ポリシー
│   ├── vpc/                    # サブネット、経路、NAT、エンドポイント、フローログ
│   ├── github-oidc-roles/      # OIDC プロバイダ、tf-plan・tf-apply
│   └── breakglass-notify/      # EventBridge → SNS
├── live/
│   ├── global/
│   │   ├── organization/       # Organizations、OU、アカウント、SCP、組織の CloudTrail
│   │   └── identity-center/    # グループ、許可セット、割り当て
│   ├── <account>/ap-northeast-1/
│   │   ├── bootstrap/          # 状態のバケット（最初だけローカルの状態から移す）
│   │   ├── ci-access/          # OIDC とロール、break-glass の通知
│   │   └── network/            # dev・staging・prod のみ
│   ├── log-archive/ap-northeast-1/logging/   # 証跡・フローログのバケット
│   └── prod/ap-northeast-3/{bootstrap,network}/
└── policy/
    ├── plan/                   # DT-INFRA-007（Rego）
    ├── static/                 # prevent_destroy、DT-INFRA-003、東京への依存（Rego、HCL を入力）
    ├── data/stateful_types.json
    └── exceptions/             # 例外（1 件 1 ファイル）
```

- 状態のバケットの名前は `slack-tfstate-<account_id>-<region>`。キーは `<infra/live からのパス>/terraform.tfstate`。
- 状態のキーは、ADR-0017 の表にない新しい用途なので、`tfstate` の CMK をバケットごとに作る。大阪のバケットのキーは、大阪の単一リージョンのキーにする（東京が使えなくても復号できればよく、マルチリージョンにする必要がない）。
- `bootstrap` のルートモジュールは、自分の状態を置くバケットを作る。初回だけローカルの状態で apply し、`terraform init -migrate-state` でそのバケットへ移す。
- モジュール間の値の受け渡しは SSM Parameter Store にする（ADR-0020）。大阪のルートモジュールは、大阪の Parameter Store だけを読む（PROP-INFRA-002）。

### 状態を持つリソースの型

`policy/data/stateful_types.json` で管理する。追加・削除は Ops と Dev のテックリードの承認を要する（`CODEOWNERS`）。この変更の時点の一覧：

`aws_s3_bucket`、`aws_kms_key`、`aws_kms_replica_key`、`aws_organizations_account`、`aws_organizations_organization`、`aws_cloudtrail`、`aws_rds_cluster`、`aws_rds_global_cluster`、`aws_db_instance`、`aws_backup_vault`、`aws_secretsmanager_secret`、`aws_cloudwatch_log_group`、`aws_ecr_repository`、`aws_elasticache_replication_group`

- Valkey（`aws_elasticache_replication_group`）は、中身を失ってよい（ADR-0002）が、置き換えで全接続の `resync` が起きるため、同じ扱いにする。
- `forget` の動作が plan の JSON にどう現れるかは **未検証**。確かめられなければ、DT-INFRA-007 の 3 行はテストから外し、Open questions に残す。

### 例外

`policy/exceptions/<YYMMDD>-<slug>.json` に、`root`、`address`、`actions`、`reason`、`approved_by`（Ops と Dev のテックリードの GitHub のハンドル）、`expires`（最長 14 日）、`pr` を書く。ファイルの承認は `CODEOWNERS` で Ops と Dev のテックリードに限る。期限を過ぎた例外は、ポリシー検査で無効として扱い、ファイルが残っていれば警告する。

### ネットワーク

| 環境 | CIDR（案） | NAT ゲートウェイ | インターフェイス型エンドポイント |
| --- | --- | --- | --- |
| dev | `10.10.0.0/16` | 1 つ（コストのため。AZ の障害の試験は staging で行う） | あり |
| staging | `10.20.0.0/16` | AZ ごと | あり |
| prod（東京） | `10.30.0.0/16` | AZ ごと | あり |
| prod（大阪、待機） | `10.31.0.0/16` | なし（切り替え時に作る） | なし（切り替え時に作る） |

- サブネットは各 `/20`。AZ は東京が `1a`・`1c`・`1d`、大阪が `3a`・`3b`・`3c`。
- dev の NAT を 1 つにすると、DT-INFRA-004 の 2 行の「同じ AZ の NAT」は dev では成り立たない。dev は変数 `nat_per_az = false` で、全 private サブネットが 1 つの NAT を使う。表の 2 行は `nat_per_az = true` の環境に適用する。
- 大阪の VPC は `standby = true` の変数で、NAT とインターフェイス型エンドポイントを作らない。切り替え時は、`network` を `standby = false` で apply してから `compute` を apply する。
- Network Firewall を後から入れるときは、public と private の間にファイアウォール用のサブネットを足し、private の経路を書き換える。経路は状態を持つリソースではないため、この変更の構成のまま足せる。

### OIDC

- OIDC プロバイダ（`token.actions.githubusercontent.com`、`aud` は `sts.amazonaws.com`）を、各アカウントに作る。
- 環境を指定したジョブでは、既定の `sub` が `repo:<owner>/<repo>:environment:<name>` になり、ref を含まない。そこで、リポジトリの OIDC の `sub` のテンプレートを `include_claim_keys = ["repo", "context", "ref"]` に変え、信頼ポリシーで ref も照合する。変えた後の `sub` の正確な文字列の形は **未検証**（着手時に、実際のトークンをデコードして確かめ、信頼ポリシーのテストに写す）。
- 多層で守る：信頼ポリシー（DT-INFRA-005）に加えて、GitHub の環境 `staging`・`prod`・`platform` に「デプロイできるブランチは `main` だけ」と「Ops の承認必須」を設定する。`dev` は `main` だけで承認なし。
- ワークフローは `pull_request` を使い、`pull_request_target` を使わない（[security.md](../../architecture/security.md) の 8 節）。`permissions` は既定で `contents: read`、OIDC を使うジョブだけ `id-token: write`。
- `tf-plan` は、AWS の `ViewOnlyAccess` をもとに、Terraform の refresh に要る `Describe*`・`Get*`（設定の読み取り）を足し、PROP-INFRA-004 のデータの読み取りを明示的に拒否する。状態のバケットの読み取りと、状態のキーでの復号、`*.tflock` の書き込み・削除を許す。
- `tf-apply` は、アカウントごとに必要な権限を持つ。`iam:*` は、`tf-*` と `AWSReservedSSO_*` のロールを変えられないように、権限の境界（permissions boundary）で制限する。

### CI のワークフロー

- `.github/workflows/infra-pr.yml`（`pull_request`・`merge_group`）：DT-INFRA-006 で対象を決め、静的検査 → `plan` → ポリシー検査 → PR にコメント。
- `.github/workflows/infra-apply.yml`（`push` to `main`）：ルートモジュールごとのジョブで、環境（DT-INFRA-005）を指定して plan → 承認 → 同じジョブの plan ファイルを apply。PR の plan ファイルは使わない（PR の後に `main` が進むため）。承認を待つ間に状態が変われば REQ-INFRA-015 のとおり失敗させる。
- `.github/workflows/infra-drift.yml`（`schedule`、毎日 06:00 JST）：全ルートモジュールの `plan -detailed-exitcode`（`tf-plan` を使う）。DT-INFRA-008 を実行する。
- ドリフトの Issue のラベルは、[project-management.md](../../../../../docs/project-management.md) の 3・5 節に合わせて、Issue type は Task、ラベルは `system:slack`・`area:infra`・`source:alert`・`needs:ops` とする。ルートモジュールは Issue のタイトル（`drift: <root>`、エラーは `drift-error: <root>`）で見分ける。
- 必須のチェックへの組み込みは [260926-ci-pipeline](../260926-ci-pipeline/spec.md) の `ci-gate` が行う。そのため `infra-pr.yml` は `workflow_call` でも呼べる再利用可能なワークフローにし、ci-pipeline の `ci.yml` から、DT-DLV-001 で `infra/` の変更があるときに呼ばれる。ci-pipeline より先にマージされる間は、`infra-pr.yml` を `pull_request` でも単独で動かす。

### 最初の apply（ブートストラップ）

OIDC のロールと状態のバケットができるまでは、CI から apply できない。次のものに限り、人が一度だけ apply する。

1. management のアカウントで、Organizations と IAM Identity Center を有効にする（コンソールでしかできない操作を含む）。
2. `global/organization`、`global/identity-center`、各アカウントの `bootstrap` と `ci-access` を、Identity Center の管理者のセッションから apply する。
3. 実行した人・時刻・コミットを、この変更の PR に記録する。以後は CI だけが apply する（REQ-INFRA-015）。management の root ユーザーは MFA を付けて封印する。

## Open questions

- **ルートモジュールを持つアカウントの範囲**：状態のバケットを、東京は 7 つのアカウントすべて、大阪は prod だけに置く案にした。staging にも大阪のバケットを置き、DR の手順を staging で練習するか（Ops）。
- **大阪の待機時の NAT とエンドポイント**：作らない案にした（コストを抑える）。切り替えの RTO（4 時間）に、`network` の apply（NAT の作成に数分）を足しても収まるかと、runbook の手順の追加（Ops）。
- **dev の NAT を 1 つにする**ことを認めるか（Ops、Dev）。
- **ドリフトの通知先**：「Ops のキュー」を GitHub の Issue とした。オンコールの道具（ADR-0021 で未決定）が決まったら移すか（Ops）。
- **IAM の制御プレーンは us-east-1 にある。** 東京の障害は IAM の変更に影響しないが、us-east-1 の障害の間は、ロールの信頼ポリシーを変えられない。災害復旧の手順は、既存のロールの引き受け（STS は大阪のリージョンのエンドポイントを使う）だけで完結させる。これで足りるか（Ops）。
- **Identity Center の ID ソース**：当面は Identity Center のディレクトリ。外部の IdP に移すか（Ops）。
- **Dev の prod への読み取り**：DT-INFRA-002 では Dev に prod の許可を与えていない。障害の調査で Dev に `ViewOnly` を与えるか（Ops、Dev）。

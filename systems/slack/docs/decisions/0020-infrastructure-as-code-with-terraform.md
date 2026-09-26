---
status: accepted
date: 2026-09-26
---

# ADR-0020: インフラを Terraform で定義する

## Context

[ADR-0011](0011-aws-container-platform.md) で AWS 上に構築すると決め、「全リソースを IaC で定義し、コンソールからの手作業での変更を禁止する」とした。この ADR では、IaC の道具を決める。

条件は次のとおり。

- 7 つのアカウント（[infrastructure.md](../architecture/infrastructure.md) の 1 節）と、東京・大阪の 2 リージョンを扱う。S3 の段階では、セルごとに同じ構成を複製する。
- 実装の大部分を AI エージェントが書く。人間がインフラの変更を、実行する前に読んで承認できる必要がある。
- 東京リージョンが使えない状態でも、大阪側を構築・変更できる必要がある（災害復旧）。
- 手作業の変更（ドリフト）を検知できる必要がある。

## Options

1. **Terraform**：HCL で書き、状態ファイルを S3 に持つ
2. **OpenTofu**：Terraform から分岐した OSS 版
3. **AWS CDK（TypeScript）**：CloudFormation に合成してデプロイする

## Decision

1 を採用する。

- **変更を、実行する前に差分で読める。** `terraform plan` の出力は、何が作られ、変わり、消えるかをリソース単位で示す。エージェントが書いたインフラの変更を、人間が plan で承認する運用に合う。
- **宣言的で、書き方の自由度が低い。** 同じことを書く方法が少なく、エージェントの出力がぶれにくい。学習データも多い。
- **CloudFormation の制約を受けない。** スタックのリソース数の上限や、更新が止まったときの復旧（`UPDATE_ROLLBACK_FAILED`）がない。
- 2 は、ライセンス（Terraform は BSL 1.1）を気にしなくてよい点で勝る。ただし、社内でインフラの定義に使う限り、BSL の制限には当たらない。エコシステムと情報量で Terraform をとる。将来の移行は、状態ファイルの互換性があるうちは容易である。
- 3 は、アプリと同じ TypeScript で書け、状態ファイルの運用がない。ただし、合成の結果（CloudFormation）を読まないと実際の変更がわからない。抽象化が深くなるほど、レビューが難しくなる。

### 構成

```
infra/
├── modules/                  # 再利用する部品
│   ├── ecs-service/          #   各モジュールは terraform test のテストを持つ
│   ├── aurora-cluster/
│   ├── valkey-cluster/
│   ├── egress-vpc/
│   └── ...
├── live/                     # ルートモジュール（1 つが 1 つの状態ファイル）
│   ├── global/               #   IAM Identity Center、Organizations、CloudFront など
│   ├── prod/
│   │   ├── ap-northeast-1/
│   │   │   ├── network/
│   │   │   ├── data/         #   Aurora、S3、KMS など状態を持つもの
│   │   │   ├── compute/      #   ECS、ALB、Valkey、SQS
│   │   │   └── observability/
│   │   └── ap-northeast-3/   #   災害復旧用
│   ├── staging/
│   └── dev/
└── policy/                   # plan に対するポリシー（OPA / conftest）
```

- **状態ファイルを、環境・リージョン・部品ごとに分ける。** 1 回の apply で壊れうる範囲を小さくし、`data` のように状態を持つ部品を、頻繁に変わる `compute` から切り離す。
- **状態ファイルは S3 に置く。** 状態ファイル専用のバケットを、アカウント・リージョンごとに作る。バケットにはバージョニングと KMS 暗号化を設定し、ロックには S3 のネイティブのロック（`use_lockfile`）を使う。DynamoDB によるロックは使わない。
- **災害復旧で apply するルートモジュールの状態ファイルは、大阪のバケットに置く。** 対象は `prod/ap-northeast-3/*` と、CloudFront のオリジンを切り替える `global/edge` である。東京リージョンが使えなくても、大阪側を操作できるようにする。
- **環境の違いは、変数で表す。** 変数には型と `validation` を付ける。コードの中で環境名による分岐はしない。
- **セル（S3）は、同じモジュールを、セルの設定の一覧から `for_each` で並べる。** セルの一覧は、ワークスペースとセルの対応表（[ADR-0023](0023-cell-based-architecture.md)）と同じ場所で管理する。

### 状態を持つリソースの保護

- Aurora、S3、KMS などには、`lifecycle { prevent_destroy = true }` と、各サービスの削除保護の両方を付ける。
- CI で、`terraform show -json` の plan を `policy/` のルールで検査する。状態を持つリソースの削除（delete）または置き換え（replace）が含まれていたら、失敗させる。止めるべきでない変更のときは、例外の承認（Ops と Dev のテックリード）を経て、ルールで個別に許可する。
- リソースの名前や構造を変えるリファクタリングは、`moved` ブロックで行い、plan に削除と作成が出ないことを確かめる。

### アプリのリリースとの分担

- Terraform は、ECS のサービス、最初のタスク定義、デプロイの設定（blue/green、ローリング）までを作る。
- **アプリのリリースは CI が行う。** 新しいイメージのタスク定義を登録し、サービスを更新する（[ADR-0022](0022-zero-downtime-deploy-and-migrations.md)）。
- そのため、Terraform の ECS サービスには `lifecycle { ignore_changes = [task_definition] }` を付ける。こうすると、インフラの変更とリリースが互いの結果を上書きしない。

### 変更の流れ

1. PR で、変更のあるルートモジュールだけ `fmt`、`validate`、`tflint`（AWS のルール）、Checkov、`plan` を実行し、plan の結果を PR にコメントする。
2. IAM・セキュリティグループ・KMS・`data` の変更は、Ops のレビューを必須にする（`CODEOWNERS`）。
3. マージ後、CI が同じコミットの plan ファイルを apply する。人間の端末からは apply しない。
4. prod の apply は、GitHub の Environments で Ops の承認を必須にする。AWS への認証は OIDC で行う。

### ドリフトの検知

- 毎日、全ルートモジュールで `terraform plan -detailed-exitcode` を実行する。差分があれば、Ops のキューにチケットを作る。
- AWS Config のルールでも、設定の逸脱を検知する。
- 本番のアカウントでは、コンソールからの変更を IAM で原則禁止する（読み取りだけ）。緊急時に手で変えたら、24 時間以内にコードへ反映するか、元に戻す。

## Consequences

- 良くなること：
  - インフラの変更を plan で読んでから承認できる。エージェントが書いた変更の検証がしやすい。
  - 災害復旧のときも、大阪側だけで apply できる。
- 引き受けるコスト：
  - 状態ファイルの運用が加わる。対象は、バケットの管理、ロック、状態の分割の設計、壊れたときの復旧（バージョニングから戻す）。
  - アプリ（TypeScript）とインフラ（HCL）で言語が分かれる。
  - AWS の新機能に、`hashicorp/aws` プロバイダが対応するまで時間がかかることがある。その間は `awscc` プロバイダで補う。
  - ルートモジュールを細かく分けると、モジュール間の値の受け渡し（`terraform_remote_state` や SSM Parameter Store）が増える。受け渡しは SSM Parameter Store に統一する。

## Confirmation

- CI で、`fmt`・`validate`・`tflint`・Checkov・`plan` を実行する。モジュールは `terraform test` で検査する。
- CI で、plan に状態を持つリソースの削除・置き換えがないことを、ポリシーで検査する。
- 毎日のドリフト検知の結果を週次で確認し、0 件を保つ。
- 年 1 回の災害復旧の訓練で、東京の状態ファイルを使わずに、大阪側の apply ができることを確かめる。

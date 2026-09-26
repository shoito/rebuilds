# Plan: Terraform の基盤（アカウント、状態、ネットワーク、CI の認証）

- Change: 260926-terraform-foundation
- Spec: [spec.md](spec.md)
- Quality: [quality.md](quality.md)
- Status: draft

## 依存

| 相手 | 関係 |
| --- | --- |
| [260926-ci-pipeline](../260926-ci-pipeline/plan.md) | 並行して進められる。この変更のワークフローを必須のチェックにするのは ci-pipeline の `ci-gate`（REQ-DLV-004）。ci-pipeline の前にこの変更のワークフローがマージされても動くが、`ci-gate` ができるまでは必須にならない。要件 ID の追跡の検査（REQ-DLV-006）ができたら、この変更の ID もその対象になる |
| [260926-post-and-list-messages](../260926-post-and-list-messages/plan.md) | 依存しない（その変更はローカルと CI の Testcontainers で完結する）。その後のワークロードの Story（ECS、Aurora）は、この変更の VPC・状態・ロールを前提にする |
| E7 の `dr-pilot-light-osaka` | 大阪の状態のバケットと待機の VPC を、この変更で先に用意する |

## Files that change

パスは `systems/slack/` からの相対パス。`.github/` だけはリポジトリのルートからの相対パス。すべて新規。

- `infra/.terraform-version`、`infra/.tflint.hcl`、`infra/.checkov.yaml`
- `infra/modules/state-bucket/`（`main.tf`、`variables.tf`、`outputs.tf`、`tests/*.tftest.hcl`）
- `infra/modules/vpc/`（同上）
- `infra/modules/github-oidc-roles/`（同上）
- `infra/modules/breakglass-notify/`（同上）
- `infra/live/global/organization/`：Organizations、OU、アカウント、SCP（DT-INFRA-001）、組織の CloudTrail
- `infra/live/global/identity-center/`：グループ、許可セット、割り当て（DT-INFRA-002）
- `infra/live/<account>/ap-northeast-1/bootstrap/`（7 アカウント）、`infra/live/prod/ap-northeast-3/bootstrap/`
- `infra/live/<account>/ap-northeast-1/ci-access/`（7 アカウント）：OIDC、`tf-plan`、`tf-apply`、break-glass の通知
- `infra/live/log-archive/ap-northeast-1/logging/`：証跡とフローログのバケット（Object Lock）
- `infra/live/{dev,staging,prod}/ap-northeast-1/network/`、`infra/live/prod/ap-northeast-3/network/`
- `infra/policy/plan/*.rego`、`infra/policy/static/*.rego`、`infra/policy/data/stateful_types.json`、`infra/policy/exceptions/.gitkeep`
- `infra/policy/test/`：Rego の単体テスト（`opa test`）、DT-INFRA-007 の表駆動テスト、PROP-INFRA-003 の性質ベーステスト（下記）
- `infra/tools/`（TypeScript、Vitest。`packages/` の外に置き、Turborepo の対象にしない）
  - `affected-roots.ts`：DT-INFRA-006。モジュールの依存は `terraform-config-inspect` の出力から作る
  - `check-state-location.ts`：DT-INFRA-003
  - `check-dr-independence.ts`：PROP-INFRA-002
  - `drift-report.ts`：DT-INFRA-008（GitHub の Issue の作成・更新・クローズ）
  - `plan-summary.ts`：PR のコメント
  - `test/`：各ツールのテスト、`plan-json.arbitrary.ts`（plan の JSON のジェネレーター）
- `infra/test/`：apply 後の検証（dev・staging に対して、AWS SDK で実際の設定を読む。Vitest）
- `infra/README.md`：ブートストラップの手順、例外の書き方、ローカルでの `plan` のしかた
- `.github/workflows/infra-pr.yml`、`.github/workflows/infra-apply.yml`、`.github/workflows/infra-drift.yml`
- `.github/CODEOWNERS`：`/systems/*/infra/`、`/systems/*/infra/policy/` を Ops と Dev のテックリードに（[security.md](../../architecture/security.md) の 7.3 節）。ci-pipeline も同じファイルを変えるので、先にマージした側に合わせる
- GitHub の設定（コードではない。手順を `infra/README.md` に書く）：環境 `dev`・`staging`・`prod`・`platform`、OIDC の `sub` のテンプレート

## Order of work

各 PR は単独で `main` を壊さない。1〜3 は人の手でのブートストラップを含むので、Ops が立ち会う。

- [ ] 1. `infra/` の骨格、`.terraform-version`、tflint・Checkov の設定。`state-bucket` モジュールと `terraform test`（REQ-INFRA-006, 018）
- [ ] 2. ポリシー：`stateful_types.json`、`policy/plan`（DT-INFRA-007）、`policy/static`（prevent_destroy、DT-INFRA-003、東京への依存）と、そのテスト。**実際のインフラより先に入れる**（REQ-INFRA-007, 009, 016, 017、PROP-INFRA-002, 003）
- [ ] 3. ブートストラップ（人が 1 回だけ apply。spec の Design「最初の apply」）：Organizations と Identity Center の有効化 → `global/organization`（REQ-INFRA-001, 002, 005）→ `log-archive/.../logging` → 各アカウントの `bootstrap`（REQ-INFRA-006, 008）→ `ci-access`（REQ-INFRA-013、PROP-INFRA-004）。実行の記録を PR に残す
- [ ] 4. `global/identity-center` と break-glass の通知（REQ-INFRA-003, 004）。IAM ユーザーが 0 件であることを確かめる
- [ ] 5. OIDC の `sub` のテンプレートの変更と、実際のトークンでの形の確認。信頼ポリシーのテストに写す（DT-INFRA-005）
- [ ] 6. `infra-pr.yml`：対象の決定、静的検査、plan、ポリシー検査、PR へのコメント（REQ-INFRA-014, 016, 017、DT-INFRA-006）
- [ ] 7. `infra-apply.yml` と GitHub の環境（REQ-INFRA-015）。この PR 以降、人の端末からは apply しない
- [ ] 8. `vpc` モジュールとテスト → dev の `network` → staging → prod（東京）→ prod（大阪、`standby = true`）（REQ-INFRA-010, 011, 012、DT-INFRA-004）
- [ ] 9. `infra-drift.yml`（REQ-INFRA-019、DT-INFRA-008）
- [ ] 10. apply 後の検証のテスト（`infra/test/`）を dev・staging に対して流す。prod は読み取りのロールで同じ検査を流す
- [ ] 11. 東京を遮断した plan のジョブ（REQ-INFRA-009）。prod の大阪で実行する
- [ ] 12. `infra/README.md`。`systems/slack/AGENTS.md` の Commands に、インフラの検査のコマンドを足す（Commands の表の変更は ci-pipeline と調整する）

## Risks

- **ブートストラップの間は、CI の外で apply する。** 誤った SCP で全アカウントから締め出される可能性がある。SCP はまず dev だけの OU に付けて確かめ、ほかの OU へ広げる。management には SCP が効かないので、management の管理者のセッションが最後の逃げ道になる。
- **SCP のリージョンの制限で、グローバルなサービスが壊れる。** `us-east-1` の許可リストの漏れ（例：IAM Identity Center、Support の API）は、実際の操作で初めて見つかる。dev で 1 週間運用してから prod に付ける。
- **OIDC の `sub` のテンプレートを変えると、既存のワークフローの `sub` が変わる。** 変更前の形で書いた信頼ポリシーがあれば、全部失敗する。テンプレートの変更は、ロールを作る前（4 と 5 の順）に行う。形は **未検証** なので、実際のトークンを見てから信頼ポリシーを書く。
- **`tf-plan` がデータを読めない前提は、Terraform の refresh の要求と衝突しうる。** 例えば `aws_secretsmanager_secret_version` を管理すると、plan で値を読む必要がある。秘密情報の値は Terraform で管理しない（値の投入は運用の手順）ことを、この変更の時点で決めておく。
- **plan の状態のロックと、ドリフトの検知が同時に走る。** ドリフトの検知が apply と重なると、ロックの待ちで失敗する（DT-INFRA-008 の 3 行）。ロックの待ち時間（`-lock-timeout=5m`）を付け、それでも失敗したら翌日に回す。
- **prod の plan を PR から実行できる。** PR のワークフローは PR のブランチの内容で動くので、悪意のある PR は `tf-plan` の権限で prod の設定を読める。データは読めない（PROP-INFRA-004）が、設定（セキュリティグループ、ロール）は読める。リポジトリへの書き込みを持つ人に限られることを前提にする。フォークからは OIDC のトークンが出ない。
- **状態ファイルには秘密情報が入りうる。** 状態の読み取りを `tf-plan` に許しているので、上と同じ前提になる。秘密情報を Terraform の属性に持たないことで緩和する。
- **直さないこと**：既存の `docs/` と ADR は変えない。ADR-0017 のキーの表への `tfstate` の追加、ADR-0020 の図への基盤のアカウントの追加は、別途 Dev が判断する（spec の Design に書いた）。

## Proof

| 証明すること | 要件 / 性質 | 方法 |
| --- | --- | --- |
| アカウントと OU が表のとおり | REQ-INFRA-001 | apply 後の検証（`organizations:ListAccountsForParent` を比べる）。management へのワークロードは DT-INFRA-007 #4 の表駆動テスト |
| SCP が拒否・許可する | REQ-INFRA-002 | dev での実際の API 呼び出し（許可されないリージョン、大阪、`StopLogging`）の結合テスト。DT-INFRA-001 は、SCP の JSON を IAM Policy Simulator（`SimulateCustomPolicy`）で評価する表駆動テスト（各行 1 ケース） |
| SCP の判定の表 | DT-INFRA-001 | 同上 |
| IAM ユーザーが 0 件、許可セットの割り当て | REQ-INFRA-003 | apply 後の検証（全アカウントの `ListUsers`、Identity Center の割り当ての一覧） |
| グループとアカウントの組み合わせ | DT-INFRA-002 | Identity Center の割り当ての一覧を `spec.md` の表と比べる表駆動テスト |
| break-glass の通知 | REQ-INFRA-004 | staging で `BreakGlass` にサインインし、5 分以内に SNS の通知（テスト用の SQS の購読）が届く手動の受け入れ試験を 1 回。EventBridge のルールのパターンは単体テスト |
| 証跡が記録され、消せない | REQ-INFRA-005 | apply 後の検証（Object Lock の設定）。dev の操作が log-archive に届く結合テスト |
| 状態のバケットの設定 | REQ-INFRA-006 | `state-bucket` の `terraform test`。apply 後の検証（全バケット）。前のバージョンからの復元は dev で 1 回試す |
| 状態の置き場所 | REQ-INFRA-007、DT-INFRA-003 | `check-state-location.ts` の表駆動テスト（`spec.md` の表を読み込む）と、実際の `infra/live/` 全体への実行が CI で通る |
| ロック | REQ-INFRA-008 | dev の使い捨てのルートモジュールで、2 つの apply を同時に始める結合テスト。`dynamodb_table` を静的検査が拒否する単体テスト |
| 状態の直列性 | PROP-INFRA-001 | 性質ベーステスト（quality.md の 2 節。dev で、並行度 2〜5 の plan・apply の列をランダムに生成し、状態のバージョンの `serial` を検査する） |
| 東京に依存しない | REQ-INFRA-009 | 東京のエンドポイントを遮断したジョブでの `init`・`plan`（prod の大阪） |
| DR のルートモジュールの依存 | PROP-INFRA-002 | `check-dr-independence.ts` の性質ベーステスト（任意の HCL の参照の組み合わせを生成）と、実際の `infra/live/` への実行 |
| サブネットと経路 | REQ-INFRA-010、DT-INFRA-004 | `vpc` の `terraform test`（`command = plan` で、表の各行を 1 ケースにする表駆動テスト）。apply 後の検証（経路表、AZ、CIDR の重なり） |
| エンドポイント | REQ-INFRA-011 | `vpc` の `terraform test`。dev で、private のサブネットの一時的なタスクから名前解決する結合テスト |
| フローログ | REQ-INFRA-012 | apply 後の検証。staging で拒否の通信を起こし、log-archive に届く結合テスト |
| OIDC のロールの引き受け | REQ-INFRA-013、DT-INFRA-005 | 信頼ポリシーを IAM Policy Simulator で評価する表駆動テスト（各行に、`sub`・`aud` の値を与える）。加えて、実際のワークフローで、PR からの apply のロールの拒否と、`main` 以外のブランチの `prod` 環境の拒否を 1 回ずつ確かめる |
| plan のロールの権限 | PROP-INFRA-004 | 性質ベーステスト（データの読み取り・書き込みの操作と、リソースの ARN の組み合わせを生成し、`SimulatePrincipalPolicy` で全件拒否を確かめる） |
| 対象のルートモジュールの決定 | REQ-INFRA-014、DT-INFRA-006 | `affected-roots.ts` の表駆動テスト。モジュールの間接の利用を含むケースを足す |
| apply の流れと古い plan | REQ-INFRA-015 | dev と staging で、承認の待ちの間に別の apply を挟む受け入れ試験を 1 回 |
| 静的検査 | REQ-INFRA-016 | 違反を含むフィクスチャ（`infra/policy/test/fixtures/`）で、各規則が失敗することの単体テスト |
| 削除・置き換えの阻止 | REQ-INFRA-017、DT-INFRA-007 | Rego の表駆動テスト（`spec.md` の表を読み込み、各行 1 ケース）。実際の `moved` と置き換えの plan の JSON をフィクスチャにする |
| ポリシーの完全性 | PROP-INFRA-003 | 性質ベーステスト（quality.md の 2 節のジェネレーター、1,000 回）。参照の実装（TypeScript で書いた DT-INFRA-007）と `opa eval` の結果が一致する |
| モジュールのテストの有無 | REQ-INFRA-018 | テストのないモジュールのフィクスチャで CI が失敗する単体テスト |
| ドリフトの検知 | REQ-INFRA-019、DT-INFRA-008 | `drift-report.ts` の表駆動テスト（GitHub の API はモック）。dev で手の変更を入れ、翌日の Issue の作成と、戻した後のクローズを確かめる受け入れ試験を 1 回 |
| すべての ID がテストから参照されている | — | ci-pipeline の追跡の検査（REQ-DLV-006）が通る。それまでは、テスト名に ID を含めることをレビューで確かめる |

# spec-checks

PR の CI と merge queue で動かす検査の道具。仕様は [260926-ci-pipeline の spec.md](../../systems/slack/docs/changes/260926-ci-pipeline/spec.md)（capability `delivery`）にある。検査の対象がリポジトリ全体（`docs/decisions/` と全題材）なので、題材の外に置く。

Node.js 24 の型の除去で TypeScript をそのまま動かす（ビルドしない）。npm の依存を使うのは `workflow-lint`（`yaml`）とテストだけ。

## コマンド

リポジトリのルートで実行する。

| 目的 | コマンド |
| --- | --- |
| 依存の導入 | `pnpm --dir tools/spec-checks install` |
| 仕様の検査（全部） | `pnpm --dir tools/spec-checks check`（比較の起点は既定で `main`。`--base <ref>` で変える） |
| ADR の一覧の生成 | `pnpm --dir tools/spec-checks gen:adr-index` |
| ADR の一覧の検査 | `pnpm --dir tools/spec-checks gen:adr-index --check` |
| ワークフローの検査 | `node tools/spec-checks/src/cli.ts workflow-lint`（`actionlint` が PATH に要る） |
| この道具のテスト | `pnpm --dir tools/spec-checks typecheck && pnpm --dir tools/spec-checks test` |

`check` が行うもの：

| 検査 | 要件 | モジュール |
| --- | --- | --- |
| ID の追跡（テストからの参照） | REQ-DLV-006、DT-DLV-003 | `src/trace.ts` |
| 定義のない ID・形式の誤り・削除済みの ID への参照 | REQ-DLV-007 | `src/trace.ts` |
| ID の衝突、接頭辞、ADR の番号 | REQ-DLV-008、DT-DLV-004 | `src/duplicates.ts` |
| アーカイブの楽観ロック | REQ-DLV-009、DT-DLV-005 | `src/archive.ts` |
| ADR の一覧 | REQ-DLV-010 | `src/adr-index.ts` |

テストのファイルの範囲（「参照」を探す glob）は [config.json](config.json) にある。

### テストを書くときの注意

`*.test.ts` に書いた ID は、追跡の検査で「参照」として数える。この道具のテストの中で、架空の ID（`REQ-MSG-001` など）を文字どおりに書くと、本物の要件がテスト済みに見えたり、定義のない ID への参照として失敗したりする。架空の ID は `REQ~MSG~001` と書き、`test/support.ts` の `ids()` で変換する。

## CI のワークフロー

| ファイル | きっかけ | 内容 |
| --- | --- | --- |
| `.github/workflows/ci.yml` | `pull_request`、`merge_group` | `changes`（DT-DLV-001）→ 各検査 → `ci-gate`（DT-DLV-002）。必須のチェックは `ci-gate` だけ |
| `.github/workflows/title.yml` | PR の作成・タイトルの編集 | PR のタイトル（REQ-DLV-002）。必須にしない（`ci.yml` の `spec-checks` が同じ検査をする） |
| `.github/workflows/ruleset-drift.yml` | 毎日 | ruleset のドリフト（REQ-DLV-014） |
| `.github/workflows/ci-duration.yml` | 週次 | `ci-gate` までの所要時間の p90（REQ-DLV-012） |
| `.github/workflows/post-merge-review.yml` | PR のマージ | 承認なしのマージに `review:post-merge` を付ける（REQ-DLV-015） |

- `infra` ジョブは、`260926-terraform-foundation` が `infra-pr.yml` と一緒に `ci.yml` へ足す。存在しない再利用ワークフローを `uses:` に書くと `ci.yml` 全体が無効になるため。それまで `changes` は `infra` を対象にしない。
- 検査を足すときは、ジョブを足し、`src/changes.ts` で対象にし、`ci-gate` の `needs` に加える（`test/gate.test.ts` が `needs` の漏れを検出する）。

## GitHub の設定（手で行う）

コードではない設定。plan.md の 10（1 週間の試運転）の後、11 で行う。**適用すると、承認なしではマージできなくなる**（[ADR-0004](../../docs/decisions/0004-agent-prs-via-github-app.md)）。

1. リポジトリの設定で、マージの方法を squash だけにし、squash のコミットメッセージの既定を「PR のタイトル」（Pull request title）にする。
2. ruleset を作る：`gh api -X POST repos/<owner>/<repo>/rulesets --input .github/rulesets/main.json`。
   - merge queue の規則の項目の名前と値の範囲は **未検証**。検証用のリポジトリで先に試す（plan.md の Risks）。
   - 必須のチェック `ci-gate` の `integration_id`（15368、GitHub Actions）は、実際のチェックの実行から確かめる。
3. 受け入れ試験を 1 回ずつ行い、結果を PR に記録する：`main` への直接の push が拒否される、承認なしで merge queue に入れられない、同じ ID を足す 2 つの PR の後のほうがキューから外される（REQ-DLV-001、005）、管理者のバイパスでマージした PR に `review:post-merge` が付く（REQ-DLV-015）。
4. `ruleset-drift.yml` がバイパスの主体まで比べられるよう、Administration の読み取り権限を持つトークン（GitHub App のもの）を secret `RULESET_READ_TOKEN` に置く。置かない間は、ドリフトの Issue に「bypass_actors が API から返らない」と出る。

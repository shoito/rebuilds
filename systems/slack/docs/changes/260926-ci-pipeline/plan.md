# Plan: PR の CI、merge queue、仕様の追跡と衝突の検査

- Change: 260926-ci-pipeline
- Spec: [spec.md](spec.md)
- Quality: [quality.md](quality.md)
- Status: draft

## 依存

| 相手 | 関係 |
| --- | --- |
| [260926-post-and-list-messages](../260926-post-and-list-messages/plan.md) | **この変更が先。** その plan の 1（CI）と 9（ID の追跡の CI への組み込み）、`scripts/check-req-ids.ts` は、この変更の `ci.yml` と `tools/spec-checks/` に置き換わる。その変更は、`lint:migrations`・`check:contract` のタスクを各パッケージに定義するだけでよい（REQ-DLV-011）。`scripts/lib/decision-table.ts`（決定表の読み込み）はその変更に残す |
| [260926-terraform-foundation](../260926-terraform-foundation/plan.md) | 並行して進められる。AWS に依存しない。`infra-pr.yml` を `workflow_call` で呼べるようにしてもらい、`ci.yml` の `infra` ジョブから呼ぶ。どちらが先にマージされても動くよう、`infra` ジョブは `infra-pr.yml` がなければ対象外として扱う |
| `feature-flags-appconfig` | `test:flags` のフックの中身と、両方の状態のテストが必須になる条件（DT-DLV-001 の MODIFIED）はそちらで入れる |
| E7 の `blue-green-deploy-pipeline`、`supply-chain-ci`、`security-scanning`、`client-perf-budget-ci` | `ci-gate` の `needs` にジョブを足す形で加わる |

## Files that change

パスはリポジトリのルートからの相対パス。

- `.github/workflows/ci.yml`（新規）：`changes`、Slack の各ジョブ、`infra`、`workflow-lint`、`tools-test`、`spec-checks`、`ci-gate`
- `.github/workflows/title.yml`（新規）：REQ-DLV-002
- `.github/workflows/ruleset-drift.yml`（新規、毎日）：REQ-DLV-014
- `.github/workflows/ci-duration.yml`（新規、週次）：REQ-DLV-012
- `.github/rulesets/main.json`（新規）
- `.github/CODEOWNERS`：`/.github/`、`/tools/` を Dev（テックリード）と Ops に（[security.md](../../architecture/security.md) の 7.3 節）。terraform-foundation も同じファイルを変えるので、後からマージする側が合わせる
- `.github/pull_request_template.md`：PR のタイトルの形式の説明を 1 行足す
- `tools/spec-checks/`（新規）
  - `package.json`、`tsconfig.json`、`vitest.config.ts`、`config.json`（テストのファイルの glob、接頭辞の表の場所）
  - `src/parse-spec.ts`：frontmatter、見出し、ADDED・MODIFIED・REMOVED、Before・After、ブロックの切り出し、決定表
  - `src/changes.ts`：DT-DLV-001
  - `src/gate.ts`：DT-DLV-002
  - `src/trace.ts`：REQ-DLV-006, 007、DT-DLV-003
  - `src/duplicates.ts`：REQ-DLV-008、DT-DLV-004
  - `src/archive.ts`：REQ-DLV-009、DT-DLV-005
  - `src/adr-index.ts`：REQ-DLV-010
  - `src/commit-title.ts`：REQ-DLV-002
  - `src/workflow-lint.ts`：REQ-DLV-013（actionlint の結果と、SHA の固定・権限・`pull_request_target` の独自の検査）
  - `src/ruleset-diff.ts`：REQ-DLV-014
  - `src/ci-duration.ts`：REQ-DLV-012
  - `src/cli.ts`：`check`（全部）、`gen:adr-index`
  - `test/`：各モジュールのテスト、`test/fixtures/`、`test/arbitraries/`（quality.md の 2 節）
- `systems/slack/package.json`、`systems/slack/pnpm-workspace.yaml`、`systems/slack/turbo.json`（新規）：ワークスペースとタスク（`typecheck`、`lint`、`format:check`、`test`、`test:integration`、`test:flags`、`lint:migrations`、`check:contract`）の定義だけ。パッケージは作らない
- `systems/slack/docs/decisions/README.md`、`docs/decisions/README.md`：一覧の表を `adr-index` の印で囲み、生成し直す
- `systems/slack/AGENTS.md`：Commands の「要件 ID の追跡検査」「型検査・lint」の行を埋める
- GitHub の設定（コードではない。`tools/spec-checks/README.md` に手順）：ruleset の適用、merge queue の有効化、リポジトリの「squash のコミットメッセージの既定を PR のタイトルにする」

## Order of work

- [ ] 1. `tools/spec-checks` の骨格と `parse-spec.ts`。既存の `260926-post-and-list-messages/spec.md` と、この 2 つの変更の `spec.md` を読めることを確かめる
- [ ] 2. 重複の検査（REQ-DLV-008、DT-DLV-004、PROP-DLV-003）
- [ ] 3. 追跡の検査と、定義のない ID への参照（REQ-DLV-006, 007、DT-DLV-003、PROP-DLV-002）
- [ ] 4. アーカイブの検査（REQ-DLV-009、DT-DLV-005、PROP-DLV-004）
- [ ] 5. ADR の一覧の生成と検査。2 つの `decisions/README.md` に印を入れて生成し直す（REQ-DLV-010）
- [ ] 6. PR のタイトルの検査と `title.yml`（REQ-DLV-002）
- [ ] 7. `systems/slack` のワークスペースの設定（`package.json`、`pnpm-workspace.yaml`、`turbo.json`）
- [ ] 8. `changes.ts` と `gate.ts`、`ci.yml`（REQ-DLV-003, 004, 011、DT-DLV-001, 002、PROP-DLV-001）。この時点では ruleset を有効にしない
- [ ] 9. ワークフローの安全性の検査（REQ-DLV-013）。この変更のワークフロー自身が通ること
- [ ] 10. `ci.yml` を 1 週間、必須にせずに動かし、所要時間と誤検知を見る
- [ ] 11. ruleset（`main.json`）の適用と merge queue の有効化（REQ-DLV-001, 005）。**Open questions の承認の問題を先に解決する**（解決前に適用すると、誰もマージできなくなる）
- [ ] 12. `ruleset-drift.yml`（REQ-DLV-014）、`ci-duration.yml`（REQ-DLV-012）
- [ ] 13. `systems/slack/AGENTS.md` の Commands と、`tools/spec-checks/README.md`

## Risks

- **ruleset を有効にした瞬間に、誰もマージできなくなりうる。** 1 人のリポジトリでは、作成者が承認できない（spec の Open questions）。11 の前に、ボットの PR の作成か、承認の方針を決める。ruleset の JSON は、適用前に `gh api` のドライランの代わりに、別の検証用のリポジトリで試す。
- **必須のチェックが報告されないと、merge queue が止まる。** `merge_group` のトリガーを付け忘れたジョブや、パスのフィルタで起動しなかったワークフローは、チェックを報告しない。必須のチェックを `ci-gate` の 1 つにし、`ci-gate` を `if: always()` で必ず走らせることで避ける。`title.yml` は必須にしない（`spec-checks` の中で同じ検査をするため）。
- **影響の範囲の取りこぼし。** Turborepo の `--affected` が、`turbo.json` の `globalDependencies` に書いていないルートのファイル（例：`.npmrc`）の変更を見落とす。DT-DLV-001 の 3 行にルートのファイルを明示し、PROP-DLV-001 で検査する。
- **`spec.md` の書式のゆれで、検査が誤検知する。** 見出しの深さ、全角の記号、表の書き方が変更ごとに違う。1 で既存の 3 つの `spec.md` を読めることを確かめ、読めない書式は検査のエラーとして「どこが読めないか」を示す（黙って無視しない）。
- **追跡の検査を厳しくしすぎると、spec だけの PR が通らない。** `draft`・`approved` は対象外にした（DT-DLV-003 #4）。
- **15 分を超える。** 結合テストの Testcontainers の起動が支配的になる見込み。パッケージごとにジョブを分けず、1 つのジョブの中で Turborepo に並列で走らせる。超えたら、`ci-slow` の Issue をもとに、ジョブの分割か、より大きなランナーを検討する。
- **直さないこと**：`docs/process.md` と ADR の本文は変えない。process.md の「CI で検査する」の記述を、この変更の検査の名前に合わせる修正は、別途 Dev が判断する。

## Proof

| 証明すること | 要件 / 性質 | 方法 |
| --- | --- | --- |
| main の保護 | REQ-DLV-001 | `main.json` の内容の単体テスト（各規則の値）。適用後に、直接の push と承認なしのマージが拒否されることを 1 回ずつ確かめる受け入れ試験 |
| PR のタイトル | REQ-DLV-002 | `commit-title.ts` の単体テスト（正しい形、scope なし、存在しない scope、日本語、`!`、`revert`） |
| 影響の範囲 | REQ-DLV-003 | フィクスチャのモノレポ（quality.md の 3 節）で、spec の 4 つのシナリオの結合テスト |
| 影響の範囲を取りこぼさない | PROP-DLV-001 | 性質ベーステスト（任意の依存グラフと変更の集合を生成し、Turborepo の `--dry=json` の結果が参照の実装の集合を含む。quality.md の 2.1 節） |
| 変更されたパスと検査 | DT-DLV-001 | `changes.ts` の表駆動テスト（`spec.md` から表を読み込み、各行 1 ケース。行の境界のパスを足す） |
| ci-gate | REQ-DLV-004、DT-DLV-002 | `gate.ts` の表駆動テスト。`ci.yml` の `needs` に全ジョブがあることの単体テスト（ワークフローの YAML を読む） |
| merge queue での再検査 | REQ-DLV-005 | 受け入れ試験：同じ ID を足す 2 つの PR をキューに入れ、後の PR が外されることを 1 回確かめる |
| 追跡 | REQ-DLV-006、DT-DLV-003 | `trace.ts` の表駆動テストと、フィクスチャでの結合テスト |
| 追跡の過不足 | PROP-DLV-002 | 性質ベーステスト（任意の `spec.md` とテストのファイルの集合を生成） |
| 定義のない ID | REQ-DLV-007 | 単体テスト（打ち間違い、plan.md、削除済みの ID） |
| 重複と ADR の番号 | REQ-DLV-008、DT-DLV-004 | `duplicates.ts` の表駆動テスト、接頭辞と ADR の番号の単体テスト |
| 重複の検査の正しさと順序の独立 | PROP-DLV-003 | 性質ベーステスト（ファイルの読み込み順を並べ替えても結果が同じ） |
| アーカイブ | REQ-DLV-009、DT-DLV-005 | `archive.ts` の表駆動テスト。フィクスチャの git リポジトリで、起点と PR の後の 2 つのコミットを作る結合テスト |
| 楽観ロック | PROP-DLV-004 | 性質ベーステスト（任意の正本と 2 つの MODIFIED を生成し、X を反映した後の Y の検査が失敗する） |
| ADR の一覧 | REQ-DLV-010 | 単体テスト。実際の 2 つの `decisions/` で `--check` が通る |
| フック | REQ-DLV-011 | フィクスチャのモノレポで、タスクの定義なし・あり・必須のパスの変更の 3 ケースの結合テスト |
| 15 分の目標 | REQ-DLV-012 | `ci-duration.ts` の単体テスト（p90 の計算、取り消された実行の除外、Issue の作成・コメント）。10 の 1 週間の実測値を PR に貼る |
| ワークフローの安全性 | REQ-DLV-013 | 違反を含むワークフローのフィクスチャで各規則が失敗する単体テスト。この変更のワークフロー全体で検査が通る |
| ruleset のドリフト | REQ-DLV-014 | `ruleset-diff.ts` の単体テスト（GitHub の API の応答をフィクスチャにする） |
| すべての ID がテストから参照されている | — | この変更の追跡の検査が、この変更自身の ID について通る（`status: done` にする PR で DT-DLV-003 #7） |

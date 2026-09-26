# Plan: エージェントの Skills と Subagent の土台

- Change: 260926-agent-skills-foundation
- Spec: [spec.md](spec.md)
- Status: draft

## 依存

| 変更 | 関係 |
| --- | --- |
| [ci-pipeline](../260926-ci-pipeline/plan.md) | 先に必要。`tools/spec-checks/` と、CI の呼び出し口 |
| [github-project-setup](../260926-github-project-setup/plan.md) | 先に必要。GitHub App、ラベル、Projects、同期のワークフロー（ADR-0003、0004） |

## Files that change

パスはリポジトリのルートからの相対パス。

- `.claude/skills/spec-authoring/SKILL.md`（新規）
- `.claude/skills/pmo-triage/SKILL.md`（新規）、`.claude/skills/pmo-triage/scripts/`（Projects の更新の許可リストを持つスクリプト）
- `.claude/agents/spec-review.md`（新規）
- `evals/skills/{spec-authoring,spec-review,pmo-triage}/`（新規）：各 20 件のタスクと受け入れ基準
- `.github/workflows/agent-evals.yml`（新規）
- `.github/workflows/pmo-weekly.yml`（新規）：週次で `pmo-triage` を GitHub App として実行する
- `tools/spec-checks/`：作成者が App の PR で `status` の変更を拒む検査を足す（REQ-AGT-002）
- `AGENTS.md`：Skills と Subagent の一覧と、使う場面を追記する

## Order of work

- [ ] 1. `tools/spec-checks/` に、App の PR での `status` の変更の拒否を足す（REQ-AGT-002、DT-AGT-001 の 2）
- [ ] 2. `spec-authoring` の Skill と eval（REQ-AGT-001）
- [ ] 3. `spec-review` の Subagent と eval（REQ-AGT-003）
- [ ] 4. `pmo-triage` の Skill、更新の許可リストを持つスクリプト、eval（REQ-AGT-004, 005、DT-AGT-001 の 3・6）
- [ ] 5. `agent-evals.yml` と基準値の記録（REQ-AGT-006）
- [ ] 6. `pmo-weekly.yml`
- [ ] 7. 関門を越えないことの性質ベーステスト（PROP-AGT-001）
- [ ] 8. `AGENTS.md` の更新

## Risks

- **Skill の文章が長すぎて守られない。** 手順を短く保ち、決定的な処理はスクリプトに寄せる。eval で守られているかを測る。
- **eval の判定が揺れる。** 受け入れ基準は、できるだけコマンドの成否で判定する。QA 役の判定を使う観点は、件数を絞る。
- **App の権限の設定の誤り。** DT-AGT-001 の 1 を、テスト用のリポジトリで実際に試して確かめる。

## Proof

| 証明すること | 要件 / 性質 | 方法 |
| --- | --- | --- |
| 草案が検査に通る | REQ-AGT-001 | eval（20 件）。ci-pipeline の検査の成否で判定 |
| App の PR で `status` を変えると CI が失敗する | REQ-AGT-002、DT-AGT-001 #2 | 結合テスト（テスト用のリポジトリ） |
| QA 役のレビューがチェックリストどおりに指摘する | REQ-AGT-003 | eval（欠けのある草案 20 件で、検出率を測る） |
| Inbox の仕分けが正しく、Priority を変えない | REQ-AGT-004、DT-AGT-001 #3・#6 | eval と、許可リストのスクリプトの単体テスト |
| 週次のまとめが集計値だけを使う | REQ-AGT-005 | eval（まとめの数値と、集計の出力を突き合わせる） |
| eval の成功率の低下で CI が失敗する | REQ-AGT-006 | ワークフローの結合テスト |
| App の権限で承認・マージ・ruleset の変更ができない | DT-AGT-001 #1、#4 | テスト用のリポジトリで実際に試す |
| エージェントは関門を越えない | PROP-AGT-001 | 性質ベーステスト（App の操作の列を生成し、テスト用のリポジトリの状態を検査する） |

フラグ：使わない（開発の道具で、本番の振る舞いを変えないため）。

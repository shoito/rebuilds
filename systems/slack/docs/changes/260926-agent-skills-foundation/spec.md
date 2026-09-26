---
capability: agent-tooling
change: 260926-agent-skills-foundation
issue:
epic: E1
status: approved
---

# Spec: エージェントの Skills と Subagent の土台

## 概要

このリポジトリのプロセス（[process.md](../../../../../docs/process.md)、[project-management.md](../../../../../docs/project-management.md)）に合わせた Agent Skills と Subagent を、最初の 3 つだけ整える。

| 名前 | 形 | 段 | 役割 |
| --- | --- | --- | --- |
| `spec-authoring` | Skill | Design | 変更の `spec.md`・`plan.md` の草案を、テンプレートと書き方の規則どおりに書く |
| `spec-review` | Subagent（QA 役） | Design の関門 | quality.md の 2.1 節のチェックリストで草案をレビューし、指摘と `needs:*` を返す |
| `pmo-triage` | Skill | 全体 | Projects の Inbox の仕分け、欠けた項目の補完の依頼、滞留・期限切れのフラグ・事後の確認待ちの検出、週次のまとめの文章 |

Skills と Subagent はリポジトリ共通のものとして、ルートの `.claude/` に置く（題材によらない）。この変更は、最初の題材である Slack の E1 で起票する。

## ADDED Requirements

### REQ-AGT-001: spec の草案の形

`spec-authoring` で変更の草案を作ったとき、システムは、ci-pipeline の検査（テンプレートの frontmatter、ID の形式と重複、Proof の網羅）に通る `spec.md` と `plan.md` を出力しなければならない。

#### Scenario: 標準の Story の草案

- Given Issue type が Story の Issue と、Size が「標準」
- When エージェントが `spec-authoring` で草案を作る
- Then frontmatter に `capability`・`change`・`issue`・`epic`・`status: draft` があり、すべての要件にシナリオが 1 つ以上ある。spec のすべての ID が plan の Proof に載っており、ci-pipeline の検査が通る

#### Scenario: 既存の ID との衝突

- Given 進行中の変更が REQ-MSG-015 までを使っている
- When 同じ capability の草案を作る
- Then 新しい要件は REQ-MSG-016 以降になり、重複の検査が通る

### REQ-AGT-002: 草案の状態を変えない

エージェント（Skill・Subagent・GitHub App のいずれでも）は、`spec.md` の `status` を `draft` 以外にしてはならない。

#### Scenario: 承認済みにしようとした

- Given エージェントが作った PR の差分に、`status: draft` から `status: approved` への変更がある
- When CI が走る
- Then CI が失敗する（作成者が GitHub App の PR では、`status` を `draft` 以外にする変更を許さない）

### REQ-AGT-003: QA 役のレビュー

`spec-review` に草案のレビューを依頼したとき、システムは、quality.md の 2.1 節のチェックリストの各項目について「満たす / 満たさない / 該当しない」と根拠を返し、満たさない項目があれば、PR に指摘のコメントと `needs:qa` を付けなければならない。承認の操作はしてはならない。

#### Scenario: 権限のシナリオが欠けている

- Given 権限に関わる要件に、「別のワークスペースの場合」のシナリオがない草案
- When `spec-review` がレビューする
- Then 該当の項目が「満たさない」になり、要件の ID を示した指摘が PR に付き、`needs:qa` が付く

### REQ-AGT-004: Inbox の仕分け

`pmo-triage` を実行したとき、システムは Projects の Status が `Inbox` の各項目について、次を行わなければならない。

- Issue type がなければ設定し、`system:*` のラベルがなければ付ける
- Story で Size が空なら `needs:pm` を付け、理由をコメントする
- 重複の疑いがある Issue を示す
- Status を `Backlog` にする

Priority・Iteration・Target date は変えてはならない。

#### Scenario: Size のない Story

- Given Issue type が Story で Size が空の Inbox の項目
- When `pmo-triage` を実行する
- Then `needs:pm` とコメントが付き、Status が `Backlog` になり、Priority は変わらない

### REQ-AGT-005: 週次のまとめ

`pmo-triage` を週次で実行したとき、システムは次の一覧と、要点の文章を Issue に投稿しなければならない。

- Stage ごとの滞留
- 7 日を超えたブランチ
- 期限切れのフラグ
- `needs:*` の一覧
- `review:post-merge` の一覧（リポジトリ共通の [ADR-0004](../../../../../docs/decisions/0004-agent-prs-via-github-app.md)）
- DORA の 4 指標

数値は Actions が集計したものだけを使い、エージェントが推測した数値を載せてはならない。

#### Scenario: 事後の確認待ちがある

- Given `review:post-merge` の PR が 2 件ある
- When 週次のまとめを作る
- Then 2 件が一覧に載り、要点の文章で触れられる

### REQ-AGT-006: Skill の eval

Skill・Subagent・`AGENTS.md`・Hooks を変える PR に対して、システムは、各 Skill の eval（実際のタスクと受け入れ基準の組）を実行し、成功率が直近の基準値から 10 ポイント以上下がったら、CI を失敗させなければならない（quality.md の 3 節）。

#### Scenario: `spec-authoring` の手順を変えた

- Given `spec-authoring` の eval が 20 件あり、基準値が 85%
- When `SKILL.md` を変えた PR で、成功率が 70% になった
- Then CI が失敗し、落ちたタスクの一覧が PR に出る

## Decision Tables

### DT-AGT-001: エージェントに許す操作

上から順に評価し、最初に一致した行を採用する。

| # | 操作 | 主体 | → 結果 |
| --- | --- | --- | --- |
| 1 | PR のレビューの承認、マージ、ruleset・`CODEOWNERS` の変更 | GitHub App（エージェント） | 拒否（App の権限にない） |
| 2 | `spec.md` の `status` を `draft` 以外にする | GitHub App | 拒否（CI で失敗。REQ-AGT-002） |
| 3 | Projects の Priority・Iteration・Target date の変更 | GitHub App | 拒否（Skill の規則と、更新できる項目の許可リスト） |
| 4 | `agent:ready` のラベルを付ける | GitHub App | 拒否（PM・Dev だけ） |
| 5 | ブランチへの push、PR の作成、Issue・PR へのコメント、`needs:*`・`agent:*` のラベル | GitHub App | 許可 |
| 6 | Projects の Status（`Inbox` → `Backlog`）、System、種類の項目 | GitHub App | 許可 |

## Correctness Properties

### PROP-AGT-001: エージェントは関門を越えない

GitHub App による任意の操作の列について、次のどれも起きない。

- `main` へのマージ
- レビューの承認
- `spec.md` の `status` が `draft` 以外になる
- Projects の Priority の変化

## Design

- **置き場所**
  - `.claude/skills/spec-authoring/SKILL.md`
  - `.claude/skills/pmo-triage/SKILL.md`
  - `.claude/agents/spec-review.md`
- **決定的な処理は Skill に書かない。** ID の採番・重複の確認・Proof の網羅の確認は、ci-pipeline の `tools/spec-checks/` を Skill から呼ぶ。Skill には、判断の手順（EARS の書き方、決定表と性質を使う基準、規模の判断）だけを書く。
- **権限の強制は、Skill の文章に頼らない。** DT-AGT-001 の 1・4 は GitHub App の権限で、2 は CI で、3・6 は Projects を更新するスクリプトの許可リストで強制する。Skill には、同じ規則を「理由つきで」書き、エージェントが無駄な試みをしないようにする。
- **eval**：`evals/skills/<name>/` に、タスク（入力の Issue や草案）と受け入れ基準（検査のコマンドと、QA 役の判定の観点）を置く。最初は各 Skill 20 件。`.github/workflows/agent-evals.yml` で、Skill などの変更時と週次に実行する。
- **Maintain 段の Skill**（`incident-to-intent`、`release-rollout`、`archive-change`、`adr-authoring`、`intent-capture`、`plan-authoring`）は、この 3 つの運用で問題がないことを確かめてから、別の変更で足す。

## Open questions

- Skill を Claude Code 以外のエージェント（Codex など）でも使えるようにするか。`AGENTS.md` から Skill を参照する形にすれば、共有できる見込み（未検証）。
- eval の実行費用の上限（週次の実行の件数）。

## 決定（2026-09-26、PM・QA、既定案）

上の Open questions は、次のとおり決めた。

- Skill は `.claude/skills/` に置き、`AGENTS.md` から一覧と使う場面を参照する。Claude Code 以外のエージェントは `AGENTS.md` を通して手順を読む（共有の可否は実装時に確かめる）。
- eval は、PR では変更のあった Skill の分だけ、週次では全件（3 つ × 20 件 = 60 件）を上限に実行する。

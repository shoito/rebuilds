---
status: accepted
date: 2026-09-26
---

# ADR-0005: rebuilds を設計の記録に限定し、実装は題材ごとの開発リポジトリで行う

## Context

rebuilds は当初、「どう設計し、どう作るかを記録し、実際に作るリポジトリ」として、題材ごとに設計ドキュメントと実装コードを同じ場所に置く前提だった。

実装に着手して、次のことが分かった。

- CI・ブランチの保護・Projects・デプロイの権限は、リポジトリ単位で設定する。複数の題材のコードが 1 つのリポジトリにあると、題材ごとに異なる設定（AWS のアカウント、ruleset、CODEOWNERS、必須のチェック）が衝突する。
- 要件とテストの追跡（process.md の「追跡」）、正本と差分の照合（「衝突の防止」）は、`specs/`・`changes/` がコードと同じリポジトリにないと働かない。
- 設計の記録は、題材を横断して読み比べられることに価値がある。

## Options

1. **rebuilds は設計の記録だけ。** 実装、`specs/`・`changes/`、CI は題材ごとの開発リポジトリに置く
2. **`specs/`・`changes/` まで rebuilds に置き、開発リポジトリはコードとテストだけ**
3. **今のまま、1 つのリポジトリで設計と実装を持つ**

## Decision

1 を採用する。

| 置き場所 | 置くもの |
| --- | --- |
| rebuilds | 方法論（`docs/process.md`、テンプレート、リポジトリ共通の ADR）と、題材ごとの設計（`intent.md`、`architecture/`、`decisions/`、`quality.md`、`runbooks/`、`roadmap.md`） |
| 題材ごとの開発リポジトリ | 実装のコード、`specs/`（正本）、`changes/`（変更ごとの spec・plan）、CI、IaC、題材の `AGENTS.md` の実装向けの規則 |

- 2 は、要件とテストの追跡がリポジトリをまたぎ、CI での検査が難しくなる。
- 3 は、Context に書いた設定の衝突を避けられない。
- 開発リポジトリは、Organization の下に題材ごとに作る（[ADR-0003](0003-github-projects-for-planning.md)）。開発リポジトリの `README.md` から、rebuilds の設計の文書へリンクする。
- [ADR-0002](0002-trunk-based-development.md)（ブランチモデル）、[ADR-0003](0003-github-projects-for-planning.md)（Projects）、[ADR-0004](0004-agent-prs-via-github-app.md)（エージェントの PR）は、主に開発リポジトリに適用する。rebuilds 自体も、文書の変更は PR で行う。

### 開発リポジトリを作るまでの扱い

- Slack の E1 の変更フォルダ（`systems/slack/docs/changes/`）と `specs/` は、開発リポジトリを作るときに、初期のバックログとして移す。それまでは rebuilds に置き、「移す予定のもの」と明記する。
- 実装に着手していた PR（`ci-pipeline`、`terraform-foundation`）はクローズし、ブランチを残して、開発リポジトリへ移植する。

## Consequences

- 良くなること：
  - 題材ごとに、CI・権限・デプロイを独立して設定できる。
  - rebuilds は、題材を横断して読める設計の記録になる。
- 引き受けるコスト：
  - 設計（rebuilds）と実装（開発リポジトリ）が別のリポジトリになり、設計の変更と実装の変更を同時にレビューできない。設計に影響する実装の変更では、開発リポジトリの PR から rebuilds の PR を参照する。
  - `changes/` の Design の節から `architecture/` や ADR へのリンクが、リポジトリをまたぐ絶対 URL になる。

## Confirmation

- rebuilds に実装のコードを置く PR が出たら、レビューで差し戻す。
- 開発リポジトリを作るときに、`changes/` と `specs/` を移し、rebuilds から削除したうえで、移した先へのリンクを残す。

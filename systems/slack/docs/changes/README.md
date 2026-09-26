# Changes: Slack

> **開発リポジトリへ移す予定。** リポジトリ共通の [ADR-0005](../../../../docs/decisions/0005-design-record-repository.md) により、`specs/` と `changes/` は Slack の開発リポジトリに置く。開発リポジトリを作るまで、初期のバックログとしてここに置いている。
>
> - 変更フォルダの中のパス `systems/slack/...` は、開発リポジトリのルートからのパスと読み替える。
> - [terraform-foundation](260926-terraform-foundation/spec.md) の OIDC の信頼の条件にある `shoito/rebuilds` は、Slack の開発リポジトリ（`<org>/slack`）と読み替える。`dev-repo-bootstrap`（[roadmap.md](../roadmap.md) の E1）で書き直す。

進行中の変更（Story 単位）。1 つの変更が 1 つのフォルダ `YYMMDD-<slug>/` を持つ。成果物と規模ごとの要否は [process.md](../../../../docs/process.md) の「規模に応じた経路」にある。

| ファイル | 内容 | 要否 |
| --- | --- | --- |
| `spec.md` | 正本への差分（ADDED / MODIFIED / REMOVED）、決定表、正しさの性質、Design | 標準・大 |
| `plan.md` | Files that change、Order of work、Risks、Proof | 小・標準・大 |
| `intent.md` | 変更の動機 | 大、または動機が roadmap だけで伝わらないとき |
| `quality.md` | リスクの高い変更のテスト設計 | 条件に当たるとき |

- 変更の一覧と状態は、ここに手で書かない。各 `spec.md` の frontmatter（`epic`・`status`）から集計する。例：`grep -l "^epic: E1" */spec.md`
- 計画中の Story は [roadmap.md](../roadmap.md) にある。着手するときに、ここにフォルダを作る。
- 完了した変更は、差分を [specs/](../specs/README.md) の正本へ反映してから、[archive/](archive/README.md) に移す。

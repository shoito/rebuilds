# AGENTS.md

既存のソフトウェア・SaaS を AI エージェント主体で再構築するなら、どう設計し、どう作るかを記録するリポジトリ。題材ごとに `systems/<name>/` を持ち、設計の文書だけを置く。実装のコード、`specs/`、`changes/`、CI は、題材ごとの開発リポジトリに置く（[ADR-0005](docs/decisions/0005-design-record-repository.md)）。

- このリポジトリに実装のコードを置かない。
- 題材の核（主な論点を担う部分）に、本家の実装を使わない（[ADR-0007](docs/decisions/0007-no-reuse-of-original-implementation.md)）。
- 下の「守ること」のうち、`specs/`・`changes/`・テスト・ブランチに関する規則は、開発リポジトリで適用する。

## 最初に読むもの

1. [docs/process.md](docs/process.md) — 開発プロセスと成果物の定義
2. 作業する題材の `systems/<name>/AGENTS.md`
3. その題材の `docs/intent.md`、`docs/architecture/README.md`、`docs/decisions/`

## 守ること

- 変更は `docs/process.md` の「規模に応じた経路」に従い、必要な成果物を先に書いてから実装する。
- `specs/` の正本は直接編集しない。変更は `changes/YYMMDD-<slug>/spec.md` に差分として書き、アーカイブ時に反映する。
- 承認済みの `spec.md` の要件・シナリオ・決定表・性質を、実装の都合で書き換えない。合わないときは作業を止め、次の相手に確認する（[process.md](docs/process.md) の「判断に迷ったときの確認先」）。
  - 要件の食い違い → PM
  - 設計・ADR との食い違い → Dev（テックリード）
  - テストとして書けない・判定できない → QA
  - 本番の制約との食い違い → Ops
- エージェントは草案を作り、実装するが、承認はしない。承認はロールの持ち主（人間）が行う。
- ブランチは `<system>/<YYMMDD-slug>` で切り、変更ごとに worktree を分ける。`main` へ直接 push しない。コミットは Conventional Commits の形で英語で書く（[ADR-0002](docs/decisions/0002-trunk-based-development.md)）。
- 未完成の振る舞いは、release フラグの裏に置いてからマージする。
- 要件 ID・ADR 番号を採番したら、既存の `specs/`・`changes/`・`decisions/` と重複していないか確かめる。
- テストの削除・skip・期待値の緩和で、テストを通したことにしない。
- テスト名には、対応する要件 ID（`REQ-...` / `PROP-...`）を含める。
- アーキテクチャに影響する選択をしたら ADR を起票する。既存の ADR に反する実装はしない。
- 同じ間違いを 2 回したら、該当する `AGENTS.md` に規則として追記する。
- 公開する HTML（`index.html`、`docs/primer/`、`systems/*/docs/primer/`）を新しく作ったら、既存の HTML と同じ Google アナリティクスのタグ（`G-LRH3HT8NDH`）を `<head>` の直後に入れる。

## 言語

- ドキュメントは日本語で書く。
- コード、コードコメント、コミットメッセージは英語で書く。
- version は「版」ではなく「バージョン」と書く。固有の名前（日本版ライドシェア、Winter '27 版、令和 7 年版の白書など）と、種類を表す語（TypeScript 版、縮小版、完全版など）は「版」のままにする。

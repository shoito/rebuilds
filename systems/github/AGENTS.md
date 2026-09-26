# AGENTS.md — GitHub

GitHub の再構築の設計。リポジトリ共通のルールはルートの [AGENTS.md](../../AGENTS.md) にある。このリポジトリには設計だけを置き、実装は GitHub の開発リポジトリで行う（[リポジトリ共通の ADR-0005](../../docs/decisions/0005-design-record-repository.md)）。

## 最初に読むもの

- [docs/intent.md](docs/intent.md) — 何を、なぜ作るか
- [docs/architecture/](docs/architecture/README.md) — 全体像、規模の段階、非機能要件、領域ごとの設計
- [docs/decisions/](docs/decisions/README.md) — ADR。特に 0002（権限の判定）、0003（複製）、0005（正本）

## この題材に固有の規則（開発リポジトリで守る）

- リポジトリのデータを返す経路は、必ず権限の判定関数を通す。一覧・検索は、判定の結果で前段から絞る（ADR-0002）。
- push の成功は、複製の合意の後にだけ返す（ADR-0003）。
- ref やコミットの DB の写しを、正本として扱わない（ADR-0005）。
- 信頼できない内容（Markdown、SVG、ノートブック、CI のジョブ）は、決められた隔離の環境でだけ描画・実行する。

## このリポジトリでの規則

- ADR を追加・更新したら、`docs/decisions/README.md` の一覧を生成し直す。

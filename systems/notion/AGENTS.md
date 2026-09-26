# AGENTS.md — Notion

Notion の再構築の設計。リポジトリ共通のルールはルートの [AGENTS.md](../../AGENTS.md) にある。このリポジトリには設計だけを置き、実装は Notion の開発リポジトリで行う（[リポジトリ共通の ADR-0005](../../docs/decisions/0005-design-record-repository.md)）。

## 最初に読むもの

- [docs/intent.md](docs/intent.md) — 何を、なぜ作るか
- [docs/architecture/](docs/architecture/README.md) — 全体像、規模の段階、非機能要件、領域ごとの設計
- [docs/decisions/](docs/decisions/README.md) — ADR。特に 0002（ブロック）、0003（シャード）、0004（権限）、0005（トランザクション）

## この題材に固有の規則（開発リポジトリで守る）

- ブロックの中身を返す経路は、必ず権限の判定関数を通す（ADR-0004）。
- 1 つのトランザクションを、複数のワークスペースにまたがらせない（ADR-0003）。
- ブロックの木の不変条件（循環がない、親は 1 つ）を壊す操作を、サーバーで拒否する（ADR-0002）。

## このリポジトリでの規則

- ADR を追加・更新したら、`docs/decisions/README.md` の一覧を生成し直す。

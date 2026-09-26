# AGENTS.md — Chrome

Chrome の再構築の設計。リポジトリ共通のルールはルートの [AGENTS.md](../../AGENTS.md) にある。このリポジトリには設計だけを置き、実装は Chrome の開発リポジトリで行う（[リポジトリ共通の ADR-0005](../../docs/decisions/0005-design-record-repository.md)）。

## 最初に読むもの

- [docs/intent.md](docs/intent.md) — 何を、なぜ作るか
- [docs/architecture/](docs/architecture/README.md) — 全体像、規模の段階、非機能要件、領域ごとの設計
- [docs/decisions/](docs/decisions/README.md) — ADR。特に 0002（自作と部品）、0003（隔離）

## この題材に固有の規則（開発リポジトリで守る）

- Renderer からの要求を信用しない。Browser 側で、そのプロセスに割り当てたサイトで検査する（ADR-0003）。
- `unsafe` を足すときは、理由をコメントに書き、セキュリティのレビューを受ける（ADR-0001）。
- 解析器・FFI の境界を変えたら、ファズの対象に含まれていることを確かめる。
- 利用者のデータを、同意なくサービスへ送らない（ADR-0005）。

## このリポジトリでの規則

- ADR を追加・更新したら、`docs/decisions/README.md` の一覧を生成し直す。

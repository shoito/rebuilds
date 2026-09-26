# AGENTS.md — Stripe

Stripe の再構築の設計。リポジトリ共通のルールはルートの [AGENTS.md](../../AGENTS.md) にある。このリポジトリには設計だけを置き、実装は Stripe の開発リポジトリで行う（[リポジトリ共通の ADR-0005](../../docs/decisions/0005-design-record-repository.md)）。

## 最初に読むもの

- [docs/intent.md](docs/intent.md) — 何を、なぜ作るか
- [docs/architecture/](docs/architecture/README.md) — 全体像、規模の段階、非機能要件、領域ごとの設計
- [docs/decisions/](docs/decisions/README.md) — ADR。特に 0003（台帳）、0004（冪等）、0005（CDE）

## この題材に固有の規則（開発リポジトリで守る）

- 金額は `packages/money` の型だけで扱う。`number` や浮動小数点で金額を計算しない（ADR-0001）。
- お金を動かす処理は、必ず台帳の仕訳と同じトランザクションで状態を変える。残高の列を直接更新しない（ADR-0003）。
- 書き込みの処理は、API・内部・コネクタのすべての層で冪等にする（ADR-0004）。
- カード番号を、CDE の外のコード・ログ・テスト用のデータに書かない。テストでは、ブランドのテスト用のカード番号だけを使う（ADR-0005）。
- テナントテーブルには `account_id` と RLS を付ける（ADR-0002）。

## このリポジトリでの規則

- ADR を追加・更新したら、`docs/decisions/README.md` の一覧を生成し直す。

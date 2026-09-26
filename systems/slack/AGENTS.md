# AGENTS.md — Slack

Slack の再構築。リポジトリ共通のルールはルートの [AGENTS.md](../../AGENTS.md) にある。

## 最初に読むもの

- [docs/intent.md](docs/intent.md) — 何を、なぜ作るか
- [docs/architecture/](docs/architecture/README.md) — 全体像、規模の段階、非機能要件。領域ごとの設計は同じディレクトリの各ファイル
- [docs/decisions/](docs/decisions/) — ADR。特に 0001（`seq`）、0002（DB が正本）、0005（権限判定の集約）
- [docs/quality.md](docs/quality.md) — 品質戦略と、PR 前に回す確認ループ
- [docs/runbooks/](docs/runbooks/README.md) — SLO、リリースとロールバック
- 作業中の変更の `docs/changes/YYMMDD-<slug>/{spec,plan}.md`

## Commands

まだ実装がない。[260926-post-and-list-messages](docs/changes/260926-post-and-list-messages/plan.md) の完了時に、次を埋める。

| 目的 | コマンド | 正常な出力 |
| --- | --- | --- |
| 環境の起動 | | |
| 型検査・lint | | |
| テスト | | |
| 要件 ID の追跡検査 | | |

## この題材に固有の規則

- メッセージの順序・位置は必ず `seq` で扱う。`created_at` や ID で並べ替えない（ADR-0001）。
- リアルタイム配信の信頼性を上げるために、配信経路へ状態を持たせない。欠損はクライアントの差分取得で回復させる（ADR-0002）。
- チャンネルの内容を返す経路では、必ず `domain/authorization.ts` の判定関数を通す。独自に `channel_members` を参照しない（ADR-0005）。
- 本文を HTML として保存・結合しない（ADR-0006）。
- テナントテーブルを追加するときは、`workspace_id`・複合キー・`FORCE ROW LEVEL SECURITY`・ポリシーを必ず付ける。DB へのアクセスは、テナントのコンテキストを設定したトランザクションの中で行う。`BYPASSRLS` を持つロールや所有者ロールをアプリから使わない（ADR-0009）。
- テナントの中のデータからは `member_id` を参照する。`account_id` を参照しない（ADR-0010）。
- API のルートはメソッドチェーンで定義し、`c.json()` には必ずステータスコードを明示する。Web からは `packages/api-client` だけを使い、`fetch` を直接書かない（ADR-0008）。
- API の表面のスナップショット（`packages/api-client` の `.d.ts`）を、契約の変更の承認なしに更新しない（ADR-0008）。
- 内部 API・公開 API・MCP は、どれも `packages/domain` のサービス関数を呼ぶ。互いを HTTP で呼び合わない。受け取ったトークンを他のサービスへ渡さない（ADR-0028、0030）。
- レート制限は、共通の制限の仕組み（ADR-0029）を通す。上限の値をコードに直接書かず、entitlement（ADR-0032）から読む。
- ADR を追加・更新したら、`docs/decisions/README.md` の一覧を生成し直す。

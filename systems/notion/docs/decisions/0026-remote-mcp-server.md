---
status: accepted
date: 2026-09-26
---

# ADR-0026: AI エージェント向けに、利用者の委任で動くリモートの MCP サーバーを提供する

## Context

利用者は、自分の AI エージェント（MCP クライアント）から、自分が読めるページを検索・取得し、ページを作りたい。

本家は、リモートの MCP サーバー（`https://mcp.notion.com/mcp`、Streamable HTTP）を OAuth だけで提供し、利用者が読めるものを読み書きする。ツールは検索・取得・ページとデータベースの作成と更新・コメント・利用者などで、全文検索は 1 分 30 回に制限している（[Get started with Notion MCP](https://developers.notion.com/docs/get-started-with-mcp)、[Supported tools](https://developers.notion.com/docs/mcp-supported-tools)、2026-09-26 に確認）。

公開 API の連携は、明示的に共有されたページだけを読む（[ADR-0024](0024-integration-access-model.md)）。利用者の権限の委任は、別の経路が要る。

Slack は、同じ目的のリモートの MCP サーバーを決めている（Slack の ADR-0028）。

## Options

1. **Slack の ADR-0028 と同じ形の、リモートの MCP サーバーを提供する**（利用者の委任、OAuth 2.1、ステートレス）
2. **公開 API だけを提供し、MCP サーバーは第三者に任せる**
3. **提供しない**

## Decision

1 を採用する。詳細は [api-and-integrations.md](../architecture/api-and-integrations.md) の 8 節にある。

- **Slack の ADR-0028 をそのまま使う**：MCP の 2026-07-28 版（セッションなし）、`mcp.<domain>` の独立したサービス、OAuth 2.1・PKCE・RFC 9728・CIMD（DCR なし）、同意を（アカウント、クライアント、ワークスペース）で記録、トークンの横流しの禁止、ドメイン層と判定関数を直接通る。
- **権限の上限は利用者と同じ。** 公開 API の連携（共有されたページだけ）とは違い、利用者が読めるページすべてが対象になる（本家と同じ）。そのため、ワークスペースの管理者が、MCP の利用、許可するクライアント、書き込みの可否を統制する。書き込みのスコープは既定で無効。
- **ツールは本家の MCP に寄せる**：`search`（全文）、`fetch`（Markdown）、`query_data_source`、`get_comments`、`get_users`、`get_teams`、`create_pages`、`update_page`、`move_pages`、`duplicate_page`、`create_database`、`update_data_source`、`create_comment`。本家の AI 検索・スキル・カスタムエージェントのツールは持たない（intent.md の対象外）。
- 2 は、第三者のサーバーが利用者のトークンを預かり、統制と監査が効かない。3 は、非公式の持ち出しを促す。

## Consequences

- 良くなること：
  - 利用者が、公式で監査できる経路で、AI エージェントからページを使える。
  - Slack と同じ部品（認可サーバーの設定、適合の検査、監査）を使い回せる。
- 引き受けるコスト：
  - ツールの入出力が外部との契約になる。壊す変更は新しいツール名で出す。
  - ページの本文によるプロンプトインジェクションで、エージェントが意図しない書き込みをしうる。書き込みの既定を無効にし、レート制限と監査で抑える。
  - 利用者の読めるものすべてに届くため、トークンの漏洩の影響が連携より大きい。アクセストークンを 1 時間にし、リフレッシュトークンを使うたびに入れ替える。

## Confirmation

- 性質ベーステスト：任意の利用者とツールの呼び出しで、MCP が返すデータは、同じ利用者が画面で読めるデータの部分集合である。
- 結合テスト：`aud` が mcp でないトークン、別のワークスペースのトークン、取り消し済みのトークン、スコープにないツールを拒否する。
- CI で MCP の仕様の適合を検査する（Protected Resource Metadata、401 の応答、古いバージョンへの 405）。
- ツールの説明文と入出力のスキーマのスナップショットで、差分を検知する。

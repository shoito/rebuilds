# Plan: 開発用のサインインと、自分のワークスペースの一覧

- Change: 260926-dev-session-and-workspaces
- Spec: [spec.md](spec.md)
- Status: draft

## 依存

| 変更 | 関係 |
| --- | --- |
| [post-and-list-messages](../260926-post-and-list-messages/plan.md) | 先に必要。DB スキーマ（`accounts`・`members`）と認証ミドルウェアの上に作る |
| [ci-pipeline](../260926-ci-pipeline/plan.md) | 先に必要 |
| [web-app-shell-routing](../260926-web-app-shell-routing/plan.md) | この変更の API を使う |

## Files that change

パスは `systems/slack/` からの相対パス。

- `packages/contract/src/me.ts`、`packages/contract/src/dev.ts`（新規）
- `packages/db/migrations/0002_sessions_and_me.sql`（新規）：`sessions`、`me_list_workspaces()`
- `apps/api/src/routes/dev.ts`（新規）：DT-WS-001 に従って登録する
- `apps/api/src/routes/me.ts`（新規）
- `apps/api/src/middleware/session.ts`（新規）：Cookie から `account_id` を得る。E2 で差し替える
- `packages/db/seed.ts`：アカウント・ワークスペース・`#general` を足す
- `apps/api/test/me.test.ts`、`apps/api/test/me.property.test.ts`、`apps/api/test/dev-sign-in.decision-table.test.ts`（新規）

## Order of work

- [ ] 1. 契約：`POST /api/dev/sign-in`、`GET /api/me/workspaces`（REQ-WS-001, 003）
- [ ] 2. `sessions` とセッションのミドルウェア（REQ-WS-001, 004）
- [ ] 3. 開発用のサインインのルートと、環境による登録の切り替え（REQ-WS-002、DT-WS-001）
- [ ] 4. `me_list_workspaces()` と一覧の API（REQ-WS-003）
- [ ] 5. 性質ベーステスト（PROP-WS-002）
- [ ] 6. seed の更新

## Risks

- **開発用のサインインが本番に残る。** ルートの登録を環境で分けるだけでなく、prod のデプロイ後のスモークテストで 404 を確かめる。
- **`SECURITY DEFINER` の関数の誤り。** 関数はアカウントの ID だけを引数に取り、返す列を固定する。

## Proof

| 証明すること | 要件 / 性質 | 方法 |
| --- | --- | --- |
| サインインで Cookie が発行される | REQ-WS-001 | 結合テスト |
| prod では無効 | REQ-WS-002、DT-WS-001 | 表駆動テスト（3 行）、prod のスモークテスト |
| 一覧が正しい | REQ-WS-003 | 結合テスト |
| 未サインインは 401 | REQ-WS-004 | 結合テスト |
| 一覧はメンバーシップの部分集合と等しい | PROP-WS-002 | 性質ベーステスト |

フラグ：使わない（開発用の機能で、prod では無効のため）。

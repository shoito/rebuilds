# Plan: メッセージの投稿と履歴取得

- Change: 260926-post-and-list-messages
- Spec: [spec.md](spec.md)
- Status: draft

## 依存

| 変更 | 関係 |
| --- | --- |
| [ci-pipeline](../260926-ci-pipeline/plan.md) | **先に必要。** CI、ID の追跡の検査、マイグレーションの lint・契約のスナップショットの呼び出し口はそちらで作る。この変更は `lint:migrations`・`check:contract` のタスクを定義するだけ |
| [message-body-ast-v1](../260926-message-body-ast-v1/plan.md) | **先に必要。** `validateBody` と AST のスキーマ |
| [telemetry-package](../260926-telemetry-package/plan.md) | 先にあれば使う。認証ミドルウェアから `runWithTenant()` を呼ぶ |
| [dev-session-and-workspaces](../260926-dev-session-and-workspaces/plan.md)、[channel-list](../260926-channel-list/plan.md) | この変更の DB スキーマと認証ミドルウェアの上に作る |

## Files that change

最初の変更なので、モノレポの骨格も作る。パスは `systems/slack/` からの相対パス。

- `package.json`、`pnpm-workspace.yaml`、`tsconfig.base.json`、`compose.yaml`（新規）
- `packages/contract/src/messages.ts`（新規）：投稿・履歴取得の入出力の Zod スキーマ
- `packages/api-client/src/index.ts`（新規）：`hcWithType`。コンパイル結果の `.d.ts` を API の表面のスナップショットとしてコミットする（ADR-0008）
- `packages/db/src/schema.ts`、`packages/db/migrations/0001_init.sql`（新規）
- `packages/db/seed.ts`（新規）
- `apps/api/src/middleware/tenant.ts`（新規）：メンバーの解決と、テナントのコンテキストの設定
- `apps/api/src/domain/authorization.ts`（新規）：`canReadChannel` / `canPostToChannel`
- `scripts/lint-migrations.ts`（新規）：テナントテーブルの `workspace_id`・RLS の検査
- `apps/api/src/domain/post-message.ts`、`apps/api/src/domain/list-messages.ts`（新規）
- `apps/api/src/app.ts`（新規）：ルートをまとめ、`AppType` を export する
- `apps/api/src/routes/messages.ts`（新規）：メソッドチェーンで定義し、`c.json()` にステータスコードを明示する
- `apps/api/test/messages.test.ts`（新規）：シナリオの結合テスト
- `apps/api/test/messages.property.test.ts`（新規）：PROP-MSG-001, 002
- `apps/api/test/messages.decision-table.test.ts`（新規）：DT-MSG-001
- `scripts/lib/decision-table.ts`（新規）：`spec.md` から決定表を読み込む
- `AGENTS.md`：Commands を追記

## Order of work

- [ ] 1. モノレポの骨格、`compose.yaml`（Postgres）。CI は ci-pipeline のものを使う
- [ ] 2. 契約：投稿・履歴取得のスキーマと、空のハンドラーを持つルート、`packages/api-client` とそのスナップショット（REQ-MSG-001, 004, 006）→ **人間がレビューして確定**
- [ ] 3. DB スキーマとマイグレーション：`accounts`、`workspaces`、`members`、`channels`、`channel_members`、`messages`。`workspace_id`・複合キー・UUIDv7・RLS・DB ロール（`migrator` / `app`）を含む（ADR-0009, 0010）
- [ ] 3a. 認証ミドルウェア：`account_id` とパスの `workspace_id` からメンバーを解決し、`SET LOCAL` でテナントのコンテキストを設定する。`runWithTenant()`（telemetry-package）を呼び、ログとトレースに反映する
- [ ] 3b. マイグレーションの lint：テナントテーブルに `workspace_id` と RLS があることを検査する
- [ ] 4. 権限判定関数（REQ-MSG-003, 005）
- [ ] 5. 投稿：採番、冪等性、`validateBody` による本文の検証と `reason`（REQ-MSG-001, 002, 003, 006）
- [ ] 6. 履歴取得：ページング（REQ-MSG-004, 005）
- [ ] 7. 性質ベーステスト（PROP-MSG-001, 002）
- [ ] 8. 決定表の読み込みと表駆動テスト（DT-MSG-001）
- [ ] 9. `AGENTS.md` の Commands を更新する

## Risks

- **並行投稿時の採番**：`UPDATE ... RETURNING` とメッセージの INSERT が同じトランザクションにないと、欠番や重複が起きる。PROP-MSG-001 で検出する。
- **冪等性と一意制約の競合**：同じ `client_msg_id` の同時リクエストで一意制約違反が起き、500 になりうる。違反を捕まえて既存行を返す必要がある。このとき、採番したトランザクションは必ずロールバックする（`seq` を消費しない）。
- **RLS とコネクションプール**：`SET LOCAL` をトランザクションの外で実行すると効かない。全クエリがミドルウェアの開始したトランザクションの中で走ることを、結合テストで確かめる。
- **最初の変更で骨格まで作るため、差分が大きくなる。** 1 と 2 は別 PR に分けてよい。

## Proof

| 証明すること | 要件 / 性質 | 方法 |
| --- | --- | --- |
| 投稿で `seq` が 1 ずつ増える | REQ-MSG-001 | 結合テスト（Testcontainers） |
| 再送で重複しない | REQ-MSG-002 | 結合テスト。同時再送のケースを含む |
| 非メンバー・別ワークスペースからは投稿・取得できず、`seq` も消費されない | REQ-MSG-003, 005 | 結合テスト |
| RLS がテナントを分離する | ADR-0009 | `app` ロールで、コンテキストなし・別テナントのコンテキストでは行が読めず書けないことの結合テスト。マイグレーションの lint が CI で通る |
| ページングが正しい | REQ-MSG-004 | 結合テスト（境界：0 件、ちょうど `limit` 件、`limit` + 1 件） |
| 本文の検証 | REQ-MSG-006 | 単体テスト、結合テスト |
| 並行投稿でも `seq` が欠番・重複しない | PROP-MSG-001 | 性質ベーステスト（fast-check、並行度 1〜50） |
| 再送を任意に含んでも冪等 | PROP-MSG-002 | 性質ベーステスト |
| 権限・本文・再送の組み合わせと優先順位 | DT-MSG-001 | 表駆動テスト（`spec.md` から読み込み、4 行 = 4 ケース） |
| すべての ID（REQ・PROP・DT）がテストから参照されている | — | ci-pipeline の追跡の検査が CI で通る |
| 契約が確定したものから変わっていない | ADR-0008 | クライアント型のスナップショットの差分検査が CI で通る |

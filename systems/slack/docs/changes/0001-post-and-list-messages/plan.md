# Plan: メッセージの投稿と履歴取得

- Change: 0001-post-and-list-messages
- Spec: [spec.md](spec.md)
- Status: draft

## Files that change

最初の変更なので、モノレポの骨格も作る。パスは `systems/slack/` からの相対パス。

- `package.json`、`pnpm-workspace.yaml`、`tsconfig.base.json`、`compose.yaml`（新規）
- `packages/contract/src/messages.ts`（新規）：Zod スキーマ、OpenAPI 生成
- `packages/db/src/schema.ts`、`packages/db/migrations/0001_init.sql`（新規）
- `packages/db/seed.ts`（新規）
- `apps/api/src/domain/authorization.ts`（新規）：`canReadChannel` / `canPostToChannel`
- `apps/api/src/domain/post-message.ts`、`apps/api/src/domain/list-messages.ts`（新規）
- `apps/api/src/routes/messages.ts`（新規）
- `apps/api/test/messages.test.ts`（新規）：シナリオの結合テスト
- `apps/api/test/messages.property.test.ts`（新規）：PROP-MSG-001, 002
- `apps/api/test/messages.decision-table.test.ts`（新規）：DT-MSG-001
- `scripts/lib/decision-table.ts`（新規）：`spec.md` から決定表を読み込む
- `scripts/check-req-ids.ts`（新規）：要件 ID の追跡検査
- `AGENTS.md`：Commands を追記

## Order of work

- [ ] 1. モノレポの骨格、`compose.yaml`（Postgres）、CI（型検査・lint・テスト）
- [ ] 2. 契約：投稿・履歴取得のスキーマ（REQ-MSG-001, 004, 006）→ **人間がレビューして確定**
- [ ] 3. DB スキーマとマイグレーション：`workspaces`、`users`、`channels`、`channel_members`、`messages`
- [ ] 4. 権限判定関数（REQ-MSG-003, 005）
- [ ] 5. 投稿：採番、冪等性、本文検証（REQ-MSG-001, 002, 003, 006）
- [ ] 6. 履歴取得：ページング（REQ-MSG-004, 005）
- [ ] 7. 性質ベーステスト（PROP-MSG-001, 002）
- [ ] 8. 決定表の読み込みと表駆動テスト（DT-MSG-001）
- [ ] 9. ID の追跡検査を CI に組み込む
- [ ] 10. `AGENTS.md` の Commands を更新する

## Risks

- **並行投稿時の採番**：`UPDATE ... RETURNING` とメッセージの INSERT が同じトランザクションにないと、欠番や重複が起きる。PROP-MSG-001 で検出する。
- **冪等性と一意制約の競合**：同じ `client_msg_id` の同時リクエストで一意制約違反が起き、500 になりうる。違反を捕まえて既存行を返す必要がある。このとき、採番したトランザクションは必ずロールバックする（`seq` を消費しない）。
- **最初の変更で骨格まで作るため、差分が大きくなる。** 1 と 2 は別 PR に分けてよい。

## Proof

| 証明すること | 要件 / 性質 | 方法 |
| --- | --- | --- |
| 投稿で `seq` が 1 ずつ増える | REQ-MSG-001 | 結合テスト（Testcontainers） |
| 再送で重複しない | REQ-MSG-002 | 結合テスト。同時再送のケースを含む |
| 非メンバーは投稿・取得できず、`seq` も消費されない | REQ-MSG-003, 005 | 結合テスト |
| ページングが正しい | REQ-MSG-004 | 結合テスト（境界：0 件、ちょうど `limit` 件、`limit` + 1 件） |
| 本文の検証 | REQ-MSG-006 | 単体テスト、結合テスト |
| 並行投稿でも `seq` が欠番・重複しない | PROP-MSG-001 | 性質ベーステスト（fast-check、並行度 1〜50） |
| 再送を任意に含んでも冪等 | PROP-MSG-002 | 性質ベーステスト |
| 権限・本文・再送の組み合わせと優先順位 | DT-MSG-001 | 表駆動テスト（`spec.md` から読み込み、4 行 = 4 ケース） |
| すべての ID（REQ・PROP・DT）がテストから参照されている | — | `scripts/check-req-ids.ts` が CI で通る |

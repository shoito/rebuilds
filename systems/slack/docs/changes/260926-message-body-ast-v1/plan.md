# Plan: 本文の AST v1

- Change: 260926-message-body-ast-v1
- Spec: [spec.md](spec.md)
- Quality: [quality.md](quality.md)
- Status: approved

## 前提と依存

- **依存する変更**：`ci-pipeline`（PR の CI、ID の追跡の検査 `tools/spec-checks`、ワークスペースの設定、`check:contract` のフック）。決定表の読み込み（`scripts/lib/decision-table.ts`）は `post-and-list-messages` の plan にあるが、この変更が先に着手するなら、同じパスにこの変更で作る。
- **`check:contract` のフック**：`ci-pipeline` の DT-DLV-001 の 5 行目により、`packages/contract` の変更では `check:contract` のタスクが必須になる。この変更で `packages/contract` を初めて作る場合は、`check:contract` に本文のスキーマのスナップショットの検査（`BodySchema` から出した JSON Schema の差分）を定義する。
- **この変更に依存する変更**：
  - [260926-post-and-list-messages](../260926-post-and-list-messages/plan.md)：投稿の本文の検証（REQ-MSG-006 の数え方と DT-MSG-001 の「本文が有効」）に `validateBody` を使う。**その plan の変更が要る。** 手順 2（契約）で `BodySchema` を import し、手順 5（投稿）の本文の検証を `validateBody` に置き換える。spec の Design の「この変更ではテキストノードだけを扱う」は、v1 のすべてのノードを受け付ける形に変わる（メンションの相手の確認は E3 のまま）。400 の応答の `reason` をどちらの変更の契約に入れるかは、spec の Open questions。
  - `web-channel-view`（`MessageBody` を使う）、E3 の `composer-prosemirror-ast`・`mentions-and-broadcast`、E6 の `search-pg-bigm`（`toPlainText` の表示のモード）、E9 の `mcp-read-tools`・`mcp-write-tools`（トークンのモードと `parsePlainText`）、E12 の `public-api-foundation`。
- **順序**：`post-and-list-messages` の手順 2 より先に、この変更の手順 1〜3（スキーマの確定）を終える。
- **release フラグ**：使わない。契約と純関数と描画の部品だけで、どの経路からもまだ呼ばれないため。

## Files that change

パスは `systems/slack/` からの相対パス。

- `packages/contract/src/body/schema.ts`（新規）：Zod のスキーマと `BODY_LIMITS`（REQ-MSG-007, 008, 009）
- `packages/contract/src/body/url.ts`（新規）：`isSafeUrl`（REQ-MSG-008）
- `packages/contract/src/body/validate.ts`（新規）：`validateBody`、DT-MSG-002（REQ-MSG-010）
- `packages/contract/src/body/plain-text.ts`（新規）：`toPlainText`、`countBodyChars`、`isBlankBody`（REQ-MSG-012、DT-MSG-003）、`parsePlainText`（REQ-MSG-013、DT-MSG-004）
- `packages/contract/src/body/version.ts`（新規）：`LATEST_BODY_VERSION`、`upgradeBody`（REQ-MSG-011）
- `packages/contract/src/body/index.ts`（新規）
- `packages/contract/package.json`（新規、まだなければ）：`check:contract` のタスク
- `packages/contract/snapshots/body-v1.schema.json`（新規）：本文のスキーマのスナップショット
- `scripts/lib/decision-table.ts`（新規、まだなければ）
- `packages/contract/src/body/testing/arbitraries.ts`（新規）：性質ベーステストのジェネレーター（[quality.md](quality.md) の 2 節）。`packages/contract/body/testing` として export する（本番のコードからは import しない）
- `packages/contract/src/body/testing/corpus/*.txt`（新規）：攻撃のコーパス（quality.md の 2.2 節）
- `packages/ui/test/support/html-safety.ts`（新規）：描画の安全の判定器（quality.md の 2.3 節）
- `packages/contract/test/body/*.test.ts`、`*.property.test.ts`、`*.decision-table.test.ts`（新規）
- `packages/ui/package.json`、`tsconfig.json`（新規。まだなければ）
- `packages/ui/src/message-body/MessageBody.tsx`、`MessageBody.module.css`（新規）：REQ-MSG-014, 015
- `packages/ui/test/message-body/*.test.tsx`、`*.property.test.tsx`（新規）：`react-dom/server` で描画し、HTML のパーサー（parse5）で調べる
- lint の設定（`ci-pipeline` が作るファイル）：`packages/ui` と `apps/web` で `react/no-danger` を有効にする

## Order of work

- [ ] 1. スキーマと上限の定数（REQ-MSG-007, 008, 009）
- [ ] 2. 検証の順序と `reason`（REQ-MSG-010、DT-MSG-002）
- [ ] 3. 版（REQ-MSG-011）→ **1〜3 のスキーマと `reason` を人間（Dev）がレビューして確定する**（契約。roadmap の「契約を先に固定する」）
- [ ] 4. ジェネレーター（quality.md の 2 節）
- [ ] 5. `toPlainText`・文字数・空の判定（REQ-MSG-012、DT-MSG-003）
- [ ] 6. `parsePlainText`（REQ-MSG-013、DT-MSG-004）と往復の性質（PROP-MSG-003, 004）
- [ ] 7. 保存と検証の性質（PROP-MSG-006, 007）
- [ ] 8. `MessageBody` と lint の規則（REQ-MSG-014, 015）、描画の性質（PROP-MSG-005）
- [ ] 9. 表駆動テスト（DT-MSG-002〜004）と ID の追跡の検査を通す
- [ ] 10. `post-and-list-messages` の plan の更新を、その持ち主（Dev）に依頼する

## Risks

- **深い入力でのスタックの溢れ**：Zod の再帰のスキーマに深い入力を渡すと、スタックが溢れうる。DT-MSG-002 でサイズと JSON の入れ子を先に、再帰を使わずに調べる。API の側では、`JSON.parse` の前に本文のバイト数を制限する必要がある（`post-and-list-messages` の API のリクエストの上限）。V8 の `JSON.parse` が深い入れ子で例外を投げないかは **未検証**。PROP-MSG-007 は `JSON.parse` の後の値を対象にする。
- **テキスト化の変更は、保存済みのデータの意味を変える**：`toPlainText` の出力を後から変えると、文字数の上限の判定（REQ-MSG-006）と検索のインデックスがずれる。変えるときは spec の MODIFIED として扱い、検索のインデックスの作り直しを計画する。
- **表示のモードでの漏れ**：表示のモードで、読めないチャンネルの名前を引く関数が名前を返すと、通知や検索でチャンネル名が漏れる。名前を引く関数は、呼び出し側で ADR-0005 の判定を通したものに限る。この変更の範囲では、名前が引けないときに ID のトークンを出すこと（DT-MSG-003 の 10・12 行）だけを保証する。
- **`packages/ui` の骨格の衝突**：`web-app-shell-routing` も `packages/ui` を作りうる。先に着手した側が作り、もう一方は plan を合わせる。
- **直さないこと**：API のルート、メンションの相手の確認、入力欄の変換、公開 API の形は、この変更で作らない。

## Proof

| 証明すること | 要件 / 性質 | 方法 |
| --- | --- | --- |
| スキーマが v1 の形だけを受け付ける | REQ-MSG-007 | 単体テスト（シナリオ 3 件と、ノードの種類ごとの正例・負例） |
| URL のスキームの制限 | REQ-MSG-008 | 単体テスト（シナリオ 6 件と、[quality.md](quality.md) の 2.2 節の URL のコーパス） |
| NUL とサロゲートを拒否する | REQ-MSG-009 | 単体テスト |
| 上限と検証の順序 | REQ-MSG-010 | 単体テスト（境界：深さ 6・7、メンション 50・51、サイズ 131,072・131,073 バイト） |
| 条件の組み合わせと `reason` の優先順位 | DT-MSG-002 | 表駆動テスト（`spec.md` から読み込み、8 行 = 8 ケース。各行に、その行だけが当たる入力を用意する） |
| 版の書き込みと読み出し | REQ-MSG-011 | 単体テスト |
| テキスト化・文字数・空の判定 | REQ-MSG-012 | 単体テスト（シナリオ 4 件と、文字数 40,000・40,001 の境界） |
| ノードごとの書き出し | DT-MSG-003 | 表駆動テスト（14 行） |
| プレーンテキストの変換 | REQ-MSG-013 | 単体テスト |
| 解釈の規則 | DT-MSG-004 | 表駆動テスト（5 行と、大文字の UUID・不完全なトークン・URL の末尾の句読点・安全でない URL） |
| プレーンテキスト → AST → プレーンテキスト | PROP-MSG-003 | 性質ベーステスト（quality.md の 2.1 節の文字列のジェネレーター。10,000 回） |
| AST → プレーンテキスト → AST | PROP-MSG-004 | 性質ベーステスト（プレーンの部分集合のジェネレーター。10,000 回） |
| 安全な描画 | REQ-MSG-014 | 単体テスト（シナリオ 4 件、`react-dom/server`） |
| 描画できない本文 | REQ-MSG-015 | 単体テスト |
| 任意の入力で実行可能な HTML にならない | PROP-MSG-005 | 性質ベーステスト（任意の JSON と、正しい本文に攻撃の文字列を埋めたもの。PR で 10,000 回、夜間で 200,000 回。判定は quality.md の 2.3 節） |
| 保存しても変わらない | PROP-MSG-006 | 性質ベーステスト。加えて、生成した本文 1,000 件を Testcontainers の PostgreSQL の `jsonb` に保存し、読み戻して比べる結合テスト |
| 検証が例外を投げず、通れば上限を満たす | PROP-MSG-007 | 性質ベーステスト（任意の JSON の値と、上限の前後の本文。10,000 回） |
| `dangerouslySetInnerHTML` を使っていない | ADR-0006 | lint（`react/no-danger`）が CI で通る |
| 契約の確定 | ADR-0008 | 手順 3 のレビューの記録（PR の承認）。`check:contract` が本文のスキーマのスナップショットの差分を検出する |
| すべての ID がテストから参照されている | — | `ci-pipeline` の ID の追跡の検査が CI で通る |

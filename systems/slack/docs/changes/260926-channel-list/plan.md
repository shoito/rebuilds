# Plan: 参加しているチャンネルの一覧

- Change: 260926-channel-list
- Spec: [spec.md](spec.md)
- Status: draft

## 依存

| 変更 | 関係 |
| --- | --- |
| [post-and-list-messages](../260926-post-and-list-messages/plan.md) | 先に必要。`channels`・`channel_members` と判定関数 |
| [dev-session-and-workspaces](../260926-dev-session-and-workspaces/plan.md) | 先に必要。セッションと seed |
| [web-app-shell-routing](../260926-web-app-shell-routing/plan.md) | この API をサイドバーで使う |

## Files that change

パスは `systems/slack/` からの相対パス。

- `packages/contract/src/channels.ts`（新規）
- `apps/api/src/domain/list-channels.ts`（新規）
- `apps/api/src/domain/authorization.ts`：`listReadableChannels` を足す
- `apps/api/src/routes/channels.ts`（新規）
- `apps/api/test/channels.test.ts`、`apps/api/test/channels.property.test.ts`（新規）

## Order of work

- [ ] 1. 契約（REQ-CHN-001, 002）
- [ ] 2. 判定関数の `listReadableChannels`（REQ-CHN-001）
- [ ] 3. 一覧の API（REQ-CHN-001, 002）
- [ ] 4. 性質ベーステスト（PROP-CHN-001）

## Risks

- **プライベートチャンネルの存在の漏洩。** 件数や名前を応答に含めない。E2 でパブリックチャンネルの一覧を足すときに、同じ関数を使い回して漏れを作らない。

## Proof

| 証明すること | 要件 / 性質 | 方法 |
| --- | --- | --- |
| 参加しているチャンネルだけが返り、別ワークスペースは 404 | REQ-CHN-001 | 結合テスト |
| `last_seq` と `last_read_seq` が正しい | REQ-CHN-002 | 結合テスト |
| 一覧は参加しているチャンネルの集合と等しい | PROP-CHN-001 | 性質ベーステスト |

フラグ：使わない（読み取りだけで、画面の側のフラグ `release.web_channel_view` で隠れるため）。

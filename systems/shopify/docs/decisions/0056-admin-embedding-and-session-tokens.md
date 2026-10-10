---
status: accepted
date: 2026-10-10
---

# ADR-0056: 管理画面への埋め込みは iframe で行い、親（管理画面）と子（アプリ）の間は本システムの定めた `postMessage` の約束（`<brand>-bridge` v1）だけでつなぐ。子は親からセッションのトークンを受け、自分のサーバーへ渡す。Cookie に頼らない。アプリは `frame-ancestors` を管理画面のドメインに絞ることを審査で確かめる

## Context

- 事業者は、アプリの画面を管理画面の中で使いたい（[intent.md](../intent.md) の「管理画面への埋め込み」）。
- 他人の作った画面を管理画面に入れると、管理画面の画面を奪われる（クリックジャッキング、親の画面の遷移）危険がある。
- サードパーティの Cookie の制限で、iframe の中のアプリは自分の Cookie のセッションに頼れない。
- 本家のブリッジの形は確かめていない（未検証）。本家の SDK は使わない（[ADR-0001](0001-platform-and-stack.md)）。

## Options

1. **iframe と自前の `postMessage` の約束、セッションのトークン（JWT）**
2. アプリの画面を本システムの部品の宣言（JSON）で描く（iframe なし）
3. 新しい窓で開く（埋め込まない）

## Decision

1 を採用する。詳細は [app-platform-and-apis.md](../architecture/app-platform-and-apis.md) の 7 節。

- 操作：`session_token.request`、`navigate`、`toast`、`modal.open`・`modal.close`、`resource_picker.open`（結果は ID だけ）、`title_bar.set`、`loading`。
- 親は `event.origin` を登録の起点と比べ、子への返事は登録の起点だけを `targetOrigin` にする。
- iframe の `sandbox` に `allow-top-navigation` を与えない。管理画面の `frame-src` は導入したアプリの起点の一覧。
- セッションのトークンは ES256・60 秒（[ADR-0054](0054-oauth-install-and-expiring-tokens.md)）。
- 審査で、アプリの `frame-ancestors` が管理画面のドメインに絞られていることを確かめる。

### 他の案を選ばなかった理由

- **2（宣言の部品）**：アプリの表現に足りず、部品の一覧を本システムが作り続けることになる。MVP の後に、決まった場所（商品の画面の一部など）の拡張として検討する。
- **3（新しい窓）**：事業者の体験が分かれ、セッションの受け渡しが要る。

## Consequences

- 良くなること：アプリの画面と管理画面の間の経路が決めた操作だけになる。Cookie に頼らない。
- 引き受けるコスト：ブリッジの約束にバージョンを付けて保守する。

## Confirmation

- 結合テスト：登録の外の `origin` からの `postMessage` が無視される。`allow-top-navigation` なしで親の遷移が止まる。
- E2E：埋め込みのアプリの見本で、セッションのトークンの交換から Admin API の呼び出しまで。

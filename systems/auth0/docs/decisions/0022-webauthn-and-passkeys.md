---
status: accepted
date: 2026-09-27
---

# ADR-0022: WebAuthn は保守されたライブラリで検証し、RP ID をテナントで固定する。UV 付きのパスキーは単独で MFA を満たす

## Context

本システムはパスキーを第一のログインの手段にする（[intent.md](../intent.md)、K8）。WebAuthn の検証（CBOR・COSE の解析、署名、フラグ）は誤りやすい。

- WebAuthn Level 3 は 2026-08-25 に W3C Recommendation になった。`hints`、`getClientCapabilities`、Signal API、関連する origin（Related Origin Requests）を含む。user handle は 64 バイト以下で、個人を特定する情報を含めない。credential ID は 1023 バイト以下（[Web Authentication Level 3](https://www.w3.org/TR/webauthn-3/)、2026-09-27 に確認）。
- パスキーは RP ID に結び付く。テナントがカスタムドメインを後から足すと、RP ID が合わなくなる。
- 本家 Auth0 のパスキーは、データベース接続で、識別子を先に入れる形。条件付きの UI に出る。1 ユーザー 20 個まで。既定ではパスキーの後も MFA を求め、Actions で省ける（[Passkeys](https://auth0.com/docs/authenticate/database-connections/passkeys)、2026-09-27 に確認）。
- NIST SP 800-63B-4 では、同期できる認証器は AAL2 まで使える（AAL3 は不可）。

## Options

検証：

1. **保守されたサーバーのライブラリ（候補 `@simplewebauthn/server`）で検証し、フラグ・署名の回数・origin の方針は自分で持つ**
2. WebAuthn の検証を自前で実装する

RP ID：

- a. **最初にパスキーを有効にした時点のホスト名に固定し、後の変更は Related Origin Requests で補う**
- b. 常にテナントの標準のホスト名（`<tenant>.jp.<brand>.<domain>`）
- c. 常に現在のカスタムドメイン（変えたら再登録）

MFA との関係：

- x. **UV 付きのパスキーでのログインは、単独で MFA を満たす（テナントで外せる）**
- y. 本家と同じく、既定で追加の MFA を求める

## Decision

1、a、x を採用する。

- パスキーは `residentKey: required`、`userVerification: required`。セキュリティキー（2 つ目の要素）は `discouraged`。アテステーションは `none`。
- user handle は `users.webauthn_user_handle`（64 バイトの乱数）。`user_id` を使わない。
- 許す origin は、テナントの標準のホスト名とカスタムドメインの `https://` だけ。
- BE・BS を記録する。BE の変化は拒否する。署名の回数の後退はログに残し、既定では拒否しない。
- 1 ユーザーの WebAuthn の資格情報は 20 個まで（本家と同じ）。
- パスキーでのログインは、データベース接続の ID を持つユーザーに限る（本家と同じ）。
- ライブラリは E7 の着手時に、保守の状況、Level 3 の項目の対応、依存の数で確かめて確定する。
- 2 は、暗号を自前で実装しない規則（[AGENTS.md](../../AGENTS.md)）に反する。
- b は、カスタムドメインで運用するテナントのパスキーが、ユーザーに見えるドメインと違う RP ID になる。
- c は、ドメインの変更で全ユーザーのパスキーが使えなくなる。
- y は、パスキーが所持と UV の 2 要素を 1 回で確かめることを活かさず、利用者に余計な手順を課す。

## Consequences

- 良くなること：
  - パスキーだけで、フィッシングに強い AAL2 のログインが 1 回の操作で済む。
  - カスタムドメインの後付けでも、パスキーを捨てずに済む（対応するブラウザで）。
- 引き受けるコスト：
  - RP ID を後から変えられない。ダッシュボードで事前に示す必要がある。
  - Related Origin Requests に対応しないブラウザでは、ドメインの変更の後にパスキーの再登録が要る。
  - 本家と MFA の既定が違う。移行するテナントには設定で合わせられることを示す。
  - 外部のライブラリの脆弱性に依存する。依存の更新を追う。

## Confirmation

- 否定側のテスト：書き換えた `origin`・`rpIdHash`・チャレンジ・UV のないパスキーの応答・BE の変化を拒否する。
- E2E：Playwright の仮想の認証器で登録と条件付きの UI のログイン。K8 の実機の確認。
- 結合テスト：カスタムドメインを後から足したテナントで、`/.well-known/webauthn` が許す origin を返す。

## References

- 設計の詳細：[mfa-and-passkeys.md](../architecture/mfa-and-passkeys.md) の 5.2 節
- FIDO Alliance: [Passkeys](https://fidoalliance.org/passkeys/)

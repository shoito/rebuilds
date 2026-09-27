---
status: accepted
date: 2026-09-27
---

# ADR-0043: 認証とセッションは Slack の ADR-0012 を引き継ぎ、組織の SAML SSO はメンバーにだけかける。長く続く接続は、セッションの取り消しでも切る

## Context

利用者は、ブラウザでログインし、API（Cookie のセッション）と、マルチプレイヤーの WebSocket（能力のチケット。[ADR-0030](0030-single-policy-engine-and-signed-capabilities.md)）の 2 つの経路で読み書きする。満たすべきことは次のとおり。

- パスワードを持たないログイン（メールの確認コード、Google、Microsoft、パスキー）と、2 段階の認証。
- 組織（会社）が、自分の IdP（Okta、Microsoft Entra ID、Google Workspace など）でメンバーのログインを強制できる。これは MVP の後（E12）に作るが、テーブルとセッションの形は S1 から合わせる。
- 外部の人（ゲスト、リンクを知っている人）とも共有できる。IdP を持たない人も入れる。
- セッションを取り消したら、開いている WebSocket も止まる。能力のチケットは 60 秒で切れるが、接続は何時間も続く。

本家は、SAML SSO を Organization と Enterprise のプランで提供し、組織の管理者だけが設定できる。SAML SSO は組織のメンバーにだけかかり、ゲストは SAML の設定にかかわらず Google SSO かメールとパスワードでログインできる。確認済みのドメインを持つ。SCIM でメンバーを事前に作れる（[Guide to SAML SSO](https://help.figma.com/hc/en-us/articles/360040532333-Guide-to-SAML-SSO)、[Set login and authentication method](https://help.figma.com/hc/en-us/articles/360052497994-Set-login-and-authentication-method)、いずれも 2026-09-27 に確認）。本家は、21 日使われないと自動でログアウトさせ、Enterprise の組織の管理者はメンバーのアイドルの期限を 12 時間〜14 日にできる（ゲストにはかからない）（[Set an idle session timeout](https://help.figma.com/hc/en-us/articles/14376092335127-Set-an-idle-session-timeout)、2026-09-27 に確認）。

rebuilds の Slack は、認証を Better Auth で自前でホストし、ワークスペースごとの SSO（OIDC と SAML）を持つと決めた（[Slack の ADR-0012](../../../slack/docs/decisions/0012-self-hosted-auth-with-better-auth.md)）。Notion もそれを先例にした。

## Options

1. **Slack の ADR-0012 を引き継ぐ（Better Auth を自前でホスト）。組織の SSO はメンバーにだけかける**
2. **マネージドの IdP（Cognito、Auth0 など）に任せる**
3. **組織の SSO を、ゲストを含む全員にかける**

## Decision

1 を採用する。詳細は [security.md](../architecture/security.md) の 4 節。

- **アカウントはグローバル**（`global.accounts`。組織の外）。組織の中ではメンバー（`org_members`）として振る舞う。Slack の ADR-0010・0012 と同じ形にする。
- **ログインの手段**：メールの確認コード、Google、Microsoft、パスキー。パスワードは持たない。2 段階の認証は TOTP とパスキー。
- **セッション**：DB（`global.sessions`）に置き、Cookie は `__Host-` 接頭辞・`Secure`・`HttpOnly`・`SameSite=Lax`。アイドル 14 日、最長 30 日。組織は、メンバーのセッションの最長を短くできる（MVP の後）。
- **組織の SSO（E12）**：SAML 2.0 と OIDC。確認済みのドメインのメールを持つメンバーにだけかける。ゲストは対象の外（本家と同じ）。「どの方法でもよい」「SSO だけ」を選べる。SSO のセッションは、IdP の応答の `SessionNotOnOrAfter`（あれば）と組織の設定の短い方で切る。SCIM は S2 の前に別の Story で作る。
- **WebSocket**：接続時は能力のチケット（60 秒・1 回だけ）で入る。チケットの `session_id` を Gateway が接続に覚える。セッションを取り消したら、`session.revoked { account_id, session_id }` を outbox で Gateway と Realtime に配り、そのセッションの接続を `Kick(forbidden)` で切る。取りこぼしは、5 分ごとの再検証（[ADR-0031](0031-org-acl-version-and-connection-revalidation.md)）で、セッションの有効性も一緒に確かめて拾う。
- **Document Server もチケットの署名を確かめる。** Gateway は `jti` の使い回しを確かめ、Document Server は署名と期限と `file_id` と `level` を確かめる。Gateway が乗っ取られても、チケットのない水準で書けない（[security.md](../architecture/security.md) の 3.3 節）。Gateway の再開のトークンでの再接続は、同じ `epoch` の持ち主が、そのセッションをチケットで開いたときに確かめた水準を上限にして受ける（[permissions-and-sharing.md](../architecture/permissions-and-sharing.md) の 5.5 節）。再開のトークンは、取り消したログインのセッションでは使えない。
- 2 を採らない理由：Slack の ADR-0012 と同じ（アカウントのデータを自分の DB に置く、S3 のセルでもグローバルに保つ、費用が利用者の数に比例する）。
- 3 を採らない理由：ゲストとの共有（intent の MVP）ができなくなる。本家とも違う。

## Consequences

- 良くなること：
  - 他の題材と同じ部品で、認証を作れる。
  - セッションの取り消しが、開いている編集の接続にも効く。
  - Gateway の欠陥だけでは、権限を越えて書けない。
- 引き受けるコスト：
  - Document Server に、チケットの公開鍵の配布と入れ替え（`kid`）が要る。
  - `session.revoked` の配送の経路を、`acl.changed` と同じく持つ。
  - 組織の SSO の強制は、ゲストには効かない。組織は、ゲストを招けないようにする方針（MVP の後）で補う。

## Confirmation

- 結合テスト：セッションを取り消してから 10 秒以内に、そのセッションの WebSocket が切れ、Realtime の購読が閉じる。
- 結合テスト：Gateway を通さずに（または署名の壊れたチケットで）Document Server に `open_session` を送ると、拒否される。
- 結合テスト（E12）：SSO だけの組織で、確認済みのドメインのメンバーは IdP を通らずにログインできない。ゲストはログインできる。

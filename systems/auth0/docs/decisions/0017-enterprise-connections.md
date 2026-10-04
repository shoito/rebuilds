---
status: accepted
date: 2026-09-27
---

# ADR-0017: エンタープライズ接続（MVP の後）は、SAML の SP を保守されたライブラリで作り、LDAP は外向きにだけつなぐコネクタで受ける

## Context

エンタープライズ接続は、MVP の後の Epic（Organizations と合わせて E14 の想定）で扱う（[intent.md](../intent.md)）。対象は SAML 2.0、OIDC、Microsoft Entra ID、オンプレミスの Active Directory・LDAP である。ここでは、MVP の接続の抽象（[ADR-0014](0014-connection-abstraction.md)）の上に、後から入れられる形であることを先に決める。

本家 Auth0 の振る舞い（2026-09-27 に確認）：

- エンタープライズ接続には、SAML、OIDC、Microsoft Entra ID（Azure AD）、ADFS、Google Workspace、PingFederate、AD/LDAP などがある（[Enterprise Identity Providers](https://auth0.com/docs/authenticate/identity-providers/enterprise-identity-providers)）。
- AD/LDAP は、テナントのネットワークに入れる AD/LDAP Connector を経由する。接続はすべてコネクタから Auth0 への外向きなので、ファイアウォールの変更はふつう要らない。複数を入れて冗長にできる。LDAP、Kerberos、クライアント証明書に対応する。**テナントの顧客のサーバーに入れることは支援しない**（[AD/LDAP Connector](https://auth0.com/docs/authenticate/identity-providers/enterprise-identity-providers/active-directory-ldap/ad-ldap-connector)）。
- Identifier First で、メールアドレスのドメインからエンタープライズ接続へ振り分ける（Home Realm Discovery）（[Identifier First](https://auth0.com/docs/authenticate/login/auth0-universal-login/identifier-first)）。

OWASP は、SAML の応答について、スキーマの検証（手元の信頼できるスキーマで）、署名の包み替え（XSW）の防止、絶対の XPath での要素の選択、`InResponseTo` の照合、有効期間と再利用の防止を求める（[SAML Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/SAML_Security_Cheat_Sheet.html)、2026-09-27 に確認）。

## Options

SAML：

1. **保守されている SAML のライブラリを選び、その上に検証の規則を本システムで足す**
2. XML 署名と SAML を自前で実装する

LDAP：

- a. **テナントのネットワークに置くコネクタが、本システムへ外向きに常時接続し、本システムからの照合の要求を受ける**
- b. 本システムからテナントの LDAP へ、VPN や公開の LDAPS でつなぐ

## Decision

1 と a を採用する。

### SAML（本システムが SP）

- ライブラリは E14 の着手前に選ぶ（[ADR-0001](0001-platform-and-stack.md) の「XML 署名を自前で書かない」）。選ぶ条件：XSW の既知の攻撃の試験を持つ、署名した要素だけを取り出す API がある、外部の実体（XXE）を読まない、保守が続いている。
- 検証の規則（ライブラリの上で本システムが必ず行う）：
  - **アサーションの署名を必須にする**（テナントの設定で、応答の署名も必須にできる）。署名の鍵は、登録した IdP の証明書だけ。応答の中の `KeyInfo` の鍵は信じない。
  - 署名の検証の後、署名された要素からだけ値を読む（XSW の対策）。
  - `InResponseTo` を、トランザクションの AuthnRequest の ID と照合する（SP-Initiated）。`Audience` は接続の Entity ID、`Recipient`・`Destination` はコールバックの URL と一致すること。`NotBefore`・`NotOnOrAfter` を、許容のずれ 60 秒で確かめる。アサーションの ID を有効期間の間だけ記録して、再利用を拒否する。
  - スキーマの検証は、手元のスキーマで行い、DTD と外部の実体を無効にする。
- IdP-Initiated のログインは、既定で無効にする。有効にするテナントには、リプレイと CSRF の危険を示し、送り先のアプリを 1 つに固定させる。
- AuthnRequest には署名を付ける（SP の署名鍵は接続ごとの `external_idp_keys`。Signer の `saml_authn_request` で署名する。[ADR-0047](0047-signer-api-and-jwks-publishing.md)）。

### OIDC と Microsoft Entra ID

- 汎用の OIDC 接続は、ソーシャル接続の共通のクライアント（[ADR-0016](0016-social-connections-and-idp-tokens.md)）を使う。クライアントの認証は `private_key_jwt`（Signer で署名）と `client_secret_post` を選べる。
- Entra ID は OIDC 接続の差分として作る。マルチテナントの Entra のアプリでは、ID トークンの `tid` を、接続に登録した Entra のテナントの ID の許可リストと照合する（`iss` の中の `{tenantid}` を確かめる）。
- Google Workspace は、Google のソーシャル接続に `hd` の照合を足した差分として作る。

### LDAP（コネクタ）

- コネクタは、本システムが配る小さなプログラム（コンテナとインストーラー）。テナントのネットワークに入れ、本システムの `connector.jp.<brand>.<domain>` へ外向きに WebSocket（TLS 1.2 以上）でつなぐ。受け口は開けない。
- コネクタの認証：登録のときに 1 回だけ表示するトークンで鍵の対を登録し、以降は相互 TLS のクライアント証明書でつなぐ。証明書は 90 日で自動更新する。
- 照合の流れ：Auth がパスワードを受け取り、接続の公開鍵ではなく、**コネクタとの TLS の中で**照合の要求を送る。コネクタは LDAP の bind で確かめ、結果とプロフィールの属性を返す。本システムはパスワードを保存しない。
- 待ち時間：照合の応答を最大 10 秒待つ。すべてのコネクタに届かないときは、その接続だけを失敗させ、画面で案内する（[ADR-0005](0005-authentication-path-availability.md) の「ソーシャル IdP」と同じ扱い）。コネクタは複数を入れて冗長にできる。
- 本家と同じく、テナントが自分で管理するディレクトリに入れる前提にする。テナントの顧客のディレクトリにつなぐ用途には、SAML か OIDC を勧める。
- 本家のコネクタは、プロフィールと資格情報（パスワードのハッシュ）をキャッシュし、コネクタに届かないときだけ使う。接続ごとに無効にできる（[AD/LDAP Connector](https://auth0.com/docs/authenticate/identity-providers/enterprise-identity-providers/active-directory-ldap/ad-ldap-connector)、[Disable AD/LDAP Connection Credential Caching](https://auth0.com/docs/authenticate/identity-providers/enterprise-identity-providers/active-directory-ldap/ad-ldap-connector/disable-credential-caching)、2026-09-27 に確認）。本システムは作らない（パスワードに由来する値を本システムに残さない）。本家でキャッシュを使っていたテナントは、移行でコネクタの停止中にログインできなくなる。

### 振り分け

- 接続にドメインの一覧を持たせ、Identifier First の識別子の画面で、メールアドレスのドメインが一致したらその接続へ進める。ドメインは、DNS の TXT で所有を確かめたものだけを登録できる（他のテナントのドメインを横取りしない）。

## Consequences

- 良くなること：
  - MVP の接続の抽象と、Universal Login のトランザクションを変えずに入れられる。
  - LDAP のために、テナントのネットワークへの受け口や VPN を求めない。
- 引き受けるコスト：
  - コネクタというソフトウェアの配布と更新を持つ（署名したビルド、自動更新、古いバージョンの拒否）。
  - SAML のライブラリの脆弱性に追従する必要がある。
  - コネクタとの常時接続のために、WebSocket を受けるサービスを認証の経路に足す。E14 の前に ADR-0005 の縮退の表を更新する（2026-09-27 に「LDAP のコネクタ」の行を足した。E14 の着手時にレビューを受ける）。

## Confirmation

- 否定側のテスト（SAML）：XSW の既知の型（署名した要素の複製と移動）、署名のないアサーション、別の IdP の証明書での署名、`InResponseTo` の不一致、期限切れ、同じアサーションの再送、`Audience` の違い、DTD と外部の実体を含む文書を、どれも拒否する。
- 結合テスト（LDAP）：コネクタを止めると、その接続のログインだけが 10 秒以内に失敗し、他の接続のログインは続く。
- 結合テスト：所有を確かめていないドメインを、振り分けのドメインとして登録できない。

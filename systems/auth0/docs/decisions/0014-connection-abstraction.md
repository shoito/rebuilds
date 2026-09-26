---
status: accepted
date: 2026-09-27
---

# ADR-0014: 接続を「資格情報を確かめて外部の ID を返す部品」として抽象化し、ユーザーとは ID で結ぶ

## Context

本家 Auth0 では、ユーザーがどこで資格情報を確かめたかを「接続（connection）」で表す。データベース接続、ソーシャル接続、エンタープライズ接続、パスワードなしの接続があり、接続ごとに `strategy`（`auth0`、`google-oauth2`、`apple`、`samlp`、`ad` など）を持つ。接続はアプリケーションごとに有効・無効を選べる。1 人のユーザーは、接続ごとの ID（`identities`）を複数持ちうる（[Connections](https://auth0.com/docs/authenticate/identity-providers)、[User Profile Structure](https://auth0.com/docs/manage-users/user-accounts/user-profiles/user-profile-structure)、2026-09-27 に確認）。

本システムは、MVP でデータベース接続とソーシャル接続（Google、Apple、LINE、GitHub）を作り、MVP の後にエンタープライズ接続（SAML、OIDC、Microsoft Entra ID、LDAP）を足す（[intent.md](../intent.md)）。後から足す接続の種類が、認可のフロー（`/authorize`、トークン）や Universal Login の遷移を書き換えずに入る形が要る。

## Options

1. **接続を共通の型で表し、種類ごとの処理は `strategy` ごとの部品（adapter）に閉じる。** 部品は「確かめた外部の ID と属性」を返すだけで、ユーザーの作成とリンク、セッション、トークンは共通の処理が行う
2. 接続の種類ごとに、ログインのフローを別に実装する
3. ソーシャル・エンタープライズを外部の仲介（ブローカー）のサービスに任せる

## Decision

1 を採用する。

- **接続の型**：`connections` に `strategy`（`database`・`google`・`apple`・`line`・`github`、後に `saml`・`oidc`・`entra`・`ldap`）、`name`（テナントの中で一意、英数字とハイフン、1〜128 文字）、`options`（種類ごとの設定。Zod の型を `strategy` ごとに持つ）、秘密（ADR-0004 のエンベロープ暗号化）を持つ。`strategy` の名前は本家に寄せず、本システムの名前にする（リポジトリ共通の ADR-0006）。
- **アプリごとの有効化**：`connection_clients`（接続 × アプリ）で持つ。有効でない接続は、そのアプリの `/authorize` からは選べない。`connection` のパラメーターで直接指定されても拒否する。
- **部品の契約**：各 strategy の部品は、次の 2 つの形のどちらかを実装する。
  - 対話で資格情報を受ける形（データベース、後の LDAP）：`verify(credentials) → VerifiedIdentity | Failure`
  - 外部へリダイレクトする形（ソーシャル、SAML、OIDC）：`begin(tx) → Redirect`、`complete(tx, callback) → VerifiedIdentity | Failure`
  - `VerifiedIdentity` は `{ connection_id, provider_user_id, email?, email_verified?, profile, idp_tokens? }`。部品はユーザーの表を書かない。
- **外部の ID はユーザーと別の表**：`user_identities` に `(tenant_id, connection_id, provider_user_id)` の一意の制約を置く。ユーザーの特定は、この組でだけ行う。メールアドレスでユーザーを特定しない（ソーシャルのメールは変わりうる。Google は `sub` を識別子にし、メールを識別子にしないよう求めている）。
- **リンク**：同じ人の複数の ID をリンクする判断（自動・手動）は users-and-profiles の領域が持つ。接続の側は、部品の返す `email_verified` を正しく伝えることだけに責任を持つ。
- **遷移の共通化**：Universal Login のトランザクション（[ADR-0011](0011-universal-login-rendering-and-transaction.md)）が、接続の選択、部品の呼び出し、MFA、同意、トークンの発行への引き渡しを行う。接続の部品は画面を描かない（SAML の POST のフォームなど、プロトコルが決める自動送信のページを除く）。
- 2 は、MFA・攻撃の防御・ログの処理が接続の種類ごとに重複し、漏れがそのまま脆弱性になる。
- 3 は、認証の経路に同期の依存が増え（[ADR-0005](0005-authentication-path-availability.md)）、テナントの分離と秘密の保存を外に出すことになる。

## Consequences

- 良くなること：
  - 新しい接続の種類を、部品と設定の型の追加で入れられる。認可のフローとトークンは変えない。
  - 攻撃の防御、MFA、ログ、同意を、すべての接続で同じ場所で通せる。
- 引き受けるコスト：
  - 部品の契約に合わない接続（LDAP のコネクタのように、応答が別のネットワークから来るもの）には、非同期の待ちを契約に足す必要がある（[ADR-0017](0017-enterprise-connections.md)）。
  - `strategy` ごとの設定の型を、Management API の OpenAPI と揃えて保守する。

## Confirmation

- 性質ベーステスト：任意の接続・アプリの組で、`connection_clients` にない組の `/authorize?connection=` は、画面にも外部にも進まずに拒否される。
- 性質ベーステスト：任意の 2 つの `VerifiedIdentity` で、`(connection_id, provider_user_id)` が同じなら同じユーザー、違えばメールアドレスが同じでも自動では同じユーザーにならない（リンクの規則を通らない限り）。
- 結合テスト：部品が DB のユーザーの表に書き込む経路がないことを、依存の検査（lint のルール）で確かめる。

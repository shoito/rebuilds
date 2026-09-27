---
status: accepted
date: 2026-09-27
---

# ADR-0016: ソーシャル接続は共通の OAuth・OIDC のクライアントと IdP ごとの差分で作り、IdP のトークンは既定で保存しない

## Context

MVP のソーシャル接続は、Google、Apple、LINE、GitHub である（[intent.md](../intent.md)）。IdP ごとに、プロトコルと癖が違う（2026-09-27 に確認）。

| IdP | プロトコル | 本システムに関わる癖 | 出典 |
| --- | --- | --- | --- |
| Google | OIDC | ユーザーの識別子は `sub`。メールアドレスを識別子に使わない。`email_verified` を返す。Workspace の組織は `hd` のクレームで確かめる（要求の `hd` は UI の最適化にすぎない） | [OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect) |
| Apple | OIDC に近い | クライアントシークレットは、開発者の秘密鍵で署名した JWT。有効期限は最大 15,777,000 秒（6 か月）。名前などは最初の認可の応答でだけ返る。非公開のメールの中継（Hide My Email）へ送るには、送信のドメインを Apple に登録し、SPF か DKIM で認証する。同意の取り消し・アカウントの削除・転送の停止をサーバー間の通知（JWS）で知らせる | [Creating a client secret](https://developer.apple.com/documentation/accountorganizationaldatasharing/creating-a-client-secret)、[Configuring your environment](https://developer.apple.com/documentation/signinwithapple/configuring-your-environment-for-sign-in-with-apple)、[Processing changes](https://developer.apple.com/documentation/signinwithapple/processing-changes-for-sign-in-with-apple-accounts)、本家の [Apple 接続](https://auth0.com/docs/authenticate/identity-providers/social-identity-providers/apple-native) |
| LINE | OIDC（LINE ログイン v2.1） | Web のログインの ID トークンは HS256（チャネルシークレットで検証）、ネイティブアプリ・LIFF は ES256。PKCE に対応する。メールアドレスを得るには、LINE Developers で申請し、取得の目的を説明する画面のスクリーンショットを出す必要がある。利用者は一部の権限を与えずに進めうる | [Integrating LINE Login](https://developers.line.biz/en/docs/line-login/integrate-line-login/)、[Verify ID token](https://developers.line.biz/en/docs/line-login/verify-id-token/) |
| GitHub | OAuth 2.0（OIDC ではない） | ID トークンがない。`user:email` のスコープで `GET /user/emails` を呼び、primary かつ verified のアドレスを選ぶ | [REST API: emails](https://docs.github.com/en/rest/users/emails) |

本家 Auth0 は、IdP のアクセストークン（とリフレッシュトークン）をユーザーの `identities` に保存し、Management API の `read:user_idp_tokens` のスコープで取り出せる（[Identity Provider Access Tokens](https://auth0.com/docs/secure/tokens/access-tokens/identity-provider-access-tokens)）。テスト用に、本家の共有の「開発者キー」があるが、カスタムドメイン・SSO・MFA などで制約があり、本番に使わないよう求めている（[Developer Keys](https://auth0.com/docs/authenticate/identity-providers/social-identity-providers/devkeys)）。

## Options

作り方：

1. **共通の OAuth 2.0・OIDC のクライアント（PKCE、`state`、`nonce`、ID トークンの検証）と、IdP ごとの差分（プロフィールの取り出し、メールの確認の扱い、シークレットの作り方）に分ける**
2. IdP ごとに SDK を使う

IdP のトークン：

- a. **既定で保存しない。テナントが接続ごとに有効にしたときだけ、エンベロープ暗号化で保存する**
- b. 本家と同じく、常に保存する

## Decision

1 と a を採用する。

### 共通のクライアント

- 認可コード＋PKCE（S256）で IdP へリダイレクトする。PKCE に対応しない IdP（GitHub の OAuth App など）は、PKCE なしでもクライアントシークレットで守る。
- IdP へ送る `state` は、本システムが作る 256 ビットの乱数で、トランザクション（[ADR-0011](0011-universal-login-rendering-and-transaction.md)）に SHA-256 の値を保存し、1 回限りにする。OIDC の IdP には `nonce` も送り、ID トークンの `nonce` と照合する。
- **コールバック**：`https://<ホスト名>/login/callback`（接続を問わず 1 つ）。トランザクションを始めたホスト名で受ける。
  - Apple は `response_mode=form_post` でクロスサイトの POST を返すので、`SameSite=Lax` のトランザクションの Cookie が届かない。コールバックでは、IdP へ送った `state` でトランザクションを特定し、`SameSite=None` の補助の Cookie（`__Host-<brand>_idp`、`Secure`・`HttpOnly`、IdP への往復の間だけ）で同じブラウザであることを確かめる。
- ID トークンの検証：`iss`、`aud`、`exp`、`iat`、`nonce`、署名（IdP の JWKS。LINE の Web のログインだけはチャネルシークレットの HS256）を `jose` で確かめる。`alg` は IdP ごとの許可リストに限る。
- IdP の応答は、[ADR-0014](0014-connection-abstraction.md) の `VerifiedIdentity` にして返す。`provider_user_id` は Google・Apple・LINE は `sub`、GitHub は数値の `id`。

### IdP ごとの差分

- **メールアドレスの確認の扱い**（ID のリンクの判断に使う。リンクの規則は users-and-profiles の領域）：
  - Google：`email_verified` をそのまま使う。
  - Apple：`email_verified` を使う。`is_private_email` のときは中継のアドレスであることを記録する。
  - LINE：ID トークンの項目は `email` だけで、確認済みを示すクレーム（`email_verified`）はない（[Verify ID token](https://developers.line.biz/en/docs/line-login/verify-id-token/)、2026-09-27 に確認）。未確認として扱う。メールアドレスを得るには、LINE Developers Console で申請し、取得の目的を説明する画面のスクリーンショットを出す（[Integrating LINE Login with your web app](https://developers.line.biz/en/docs/line-login/integrate-line-login/)、2026-09-27 に確認）。
  - GitHub：`/user/emails` の `verified` が真のものだけを使う。
- **Apple のクライアントシークレット**：テナントが Apple の秘密鍵（`.p8`）を登録する。この鍵での JWT の署名は、テナントの署名鍵と同じく Signer の中で行う（[ADR-0003](0003-token-formats-and-signing-keys.md) と AGENTS.md の「署名の秘密鍵は Signer の外で扱わない」）。有効期間 1 時間の JWT を作り、Auth のプロセスでキャッシュする。Signer に用途（外部の IdP へのクライアントの認証）を足すことは、keys-and-secrets の領域に依頼する（2026-09-27 に [ADR-0047](0047-signer-api-and-jwks-publishing.md) の外部 IdP のアサーション `apple_client_secret` として足した）。
- **Apple のサーバー間の通知**：`/login/callback/apple/notifications` で受け、Apple の JWKS で署名を確かめる。
  - `consent-revoked`・`account-deleted`：その ID のセッションとリフレッシュトークンを失効させ、`user_identities` に取り消しの印を付ける。ユーザーは消さない（他の ID がありうる）。
  - `email-disabled`：メールの送信を止める印を付ける（[email-delivery.md](../architecture/email-delivery.md)）。
- **Apple の名前**：最初の応答の `user` のパラメーターの名前を、その時に保存する。後から取り直せない。
- **LINE のメールアドレス**：テナントが LINE の申請を済ませ、`email` のスコープを有効にしたときだけ求める。利用者が与えなかったら、メールアドレスなしでログインを続ける。テナントが「メールアドレスを必須」にしているときは、ログインの後にメールアドレスの入力と確認の画面を出す。
- **LINE の `bot_prompt`**：接続の設定で `normal`・`aggressive` を選べる。

### IdP のトークン

- 既定では、IdP のアクセストークン・リフレッシュトークンを保存しない。ログインの完了の後、メモリーから捨てる。
- テナントが接続ごとに `store_idp_tokens` を有効にしたときは、`user_identities` の横の `idp_tokens` に、エンベロープ暗号化（AAD に `tenant_id`・`identity_id`・用途）で保存する（[ADR-0004](0004-credential-storage.md)）。ログインのたびに上書きする。
- 取り出しは、Management API の `read:user_idp_tokens` のスコープだけで許す。ID トークン・userinfo・ログには入れない。取り出しを監査ログに残す。
- ID のリンクの解除、ユーザーの削除、Apple の `consent-revoked` で、保存したトークンを消す。
- b は、使わないテナントのぶんまで、他社の API を呼べる秘密を持つことになり、漏えいの被害を広げる。

### 開発者キー

- 本システムの共有の開発者キー（本システムの名義の Google・GitHub のアプリ）は、MVP では提供しない。テナントの外の共通のホスト名でコールバックを受けることになり、ホスト名からテナントを決める仕組み（[ADR-0002](0002-tenancy-and-isolation.md)）と SSO が崩れるため。代わりに、各 IdP でのアプリの登録の手順をダッシュボードで案内する（K3 への影響は connections の領域の未解決の問い）。

## Consequences

- 良くなること：
  - IdP を足すときの作業が、差分（プロフィールとメールの扱い）に限られる。
  - IdP のトークンの漏えいの範囲が、使うテナントに限られる。
- 引き受けるコスト：
  - Apple のシークレットのために、Signer に外部 IdP 向けの署名の用途が増える。
  - LINE のメールアドレスは確認済みと言えないので、ID のリンクに使えない。
  - 開発者キーがないので、試すだけのテナントも IdP にアプリを登録する手間がある。

## Confirmation

- 否定側のテスト：`state` の不一致・再利用、`nonce` の不一致、`aud` の違う ID トークン、`alg: none`、許可リストにない `alg`、期限切れの ID トークンを、IdP ごとに拒否する。
- 結合テスト（IdP の模擬のサーバー）：Apple の `form_post` のコールバックで、補助の Cookie がないと拒否される。
- 結合テスト：`store_idp_tokens` が無効の接続では、ログインの後に DB のどこにも IdP のトークンが残らない（DB の走査）。
- 結合テスト：Apple の `consent-revoked` の通知で、その ID から出したリフレッシュトークンが失効する。

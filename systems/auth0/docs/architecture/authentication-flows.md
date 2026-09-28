# Authentication flows: Auth0

OIDC・OAuth のエンドポイント、グラント、クライアントの認証、`redirect_uri` の検証、トークンのクレームと有効期間、エラー、適合試験の対象の設計。MVP の後の PAR・DPoP・トークン交換の入れ方も扱う。トークンの形式と署名鍵は [ADR-0003](../decisions/0003-token-formats-and-signing-keys.md)、資格情報の保存は [ADR-0004](../decisions/0004-credential-storage.md)、縮退は [ADR-0005](../decisions/0005-authentication-path-availability.md) にある。セッションとログアウトは [sessions-and-sso.md](sessions-and-sso.md)、署名と JWKS の書き出しは [keys-and-secrets.md](keys-and-secrets.md) にある。

本家 Auth0 の振る舞いは、2026-09-27 に auth0.com/docs と、本家の公開のテナント（`samples.auth0.com`）の discovery で確かめた。標準の記述は、各仕様の本文による。確かめられなかったものは「未検証」と書く。この文書の決定表は設計の草案で、要件 ID は E3・E5 の各変更の `spec.md` に移すときに振る。

## 1. 目的と範囲

- テナントのアプリが、どの言語の標準的な OIDC・OAuth のライブラリからでも使える認可サーバーを作る。
- RFC 9700（OAuth 2.0 のセキュリティの BCP）と OAuth 2.1 の草案の方針を、既定の振る舞いにする。危ない選択肢は、そもそも出さない。
- OpenID Certification の OP のプロファイルに合格する（[intent.md](../intent.md) の K2）。

範囲に入れないもの：

| もの | 扱う場所 |
| --- | --- |
| ログインの画面、画面の遷移 | universal-login.md |
| 接続（データベース、ソーシャル）での資格情報の確認 | connections.md、[ADR-0014](../decisions/0014-connection-abstraction.md) |
| MFA、`amr`・`acr` の値の決め方 | mfa-and-passkeys.md |
| アプリケーション・API・M2M の許可の登録と、設定のキャッシュ | tenants-and-applications.md |
| セッション、SSO、ログアウト | [sessions-and-sso.md](sessions-and-sso.md) |
| 署名、鍵、JWKS の書き出し | [keys-and-secrets.md](keys-and-secrets.md) |
| レート制限の値 | management-api-and-rate-limiting.md |

## 2. 本家の形（確かめたこと）

`samples.auth0.com` の discovery（2026-09-27 に取得）と、本家の文書による。

| 項目 | 本家 |
| --- | --- |
| エンドポイント | `/authorize`、`/oauth/token`、`/userinfo`、`/oauth/revoke`、`/oauth/device/code`、`/.well-known/jwks.json`、`/oidc/register`、`/mfa/challenge`、`/bc-authorize`（CIBA） |
| `response_types_supported` | `code`、`token`、`id_token` と、その組み合わせ（暗黙フローとハイブリッドを含む） |
| `response_modes_supported` | `query`、`fragment`、`form_post` |
| `code_challenge_methods_supported` | `S256`、`plain` |
| `grant_types_supported` | `authorization_code`、`client_credentials`、`refresh_token`、`password`、`implicit`、デバイス、トークン交換、JWT bearer と、本家に固有のもの（パスワードの realm、MFA の OTP など） |
| `token_endpoint_auth_methods_supported` | `client_secret_basic`、`client_secret_post`、`private_key_jwt`、`none` |
| クライアントのアサーションの署名 | `RS256`、`RS384`、`PS256` |
| ID トークンの署名 | `HS256`、`RS256`、`PS256` |
| `request_parameter_supported`・`request_uri_parameter_supported` | どちらも `false` |
| Back-Channel Logout | `backchannel_logout_supported`・`backchannel_logout_session_supported` が `true` |
| DPoP | `dpop_signing_alg_values_supported` は `ES256` |
| イントロスペクション（RFC 7662） | discovery に載っていない |

- ID トークンの有効期間の既定は 36,000 秒（10 時間）（[Update ID Token Lifetime](https://auth0.com/docs/secure/tokens/id-tokens/update-id-token-lifetime)、2026-09-27 に確認）。最大は、資料にも Management API の OpenAPI（`ClientJwtConfiguration.lifetime_in_seconds`）にも記載がない（同日に確認）。
- アクセストークンの有効期間は既定 86,400 秒、最大 2,592,000 秒（[Update Access Token Lifetime](https://auth0.com/docs/secure/tokens/access-tokens/update-access-token-lifetime)、2026-09-27 に確認）。暗黙・ハイブリッドのフロー向けの別の値がある。ブラウザの PKCE のフローは一般の値を使う。ブラウザ向けの値（`token_lifetime_for_web`）は `token_lifetime` を超えられない（Management API の OpenAPI、同日に確認）。既定（7,200 秒と見られる）は、資料にも OpenAPI にもなかった（未検証）。
- デバイスのフロー：`expires_in` 900 秒、`interval` 5 秒。ユーザーコードは BASE20 の文字で 8 文字以上、数字で 9 文字以上、区切りを含めて 20 文字以下。アプリの種類は Native で、トークンのエンドポイントの認証は `none` に限る（[Call Your API Using the Device Authorization Flow](https://auth0.com/docs/get-started/authentication-and-authorization-flow/device-authorization-flow/call-your-api-using-the-device-authorization-flow)、2026-09-27 に確認）。
- リフレッシュトークンは、`offline_access` のスコープで求める。1 ユーザー × 1 アプリで有効なものは 200 個までで、超えると最も古いものを失効させる（[Refresh Tokens](https://auth0.com/docs/secure/tokens/refresh-tokens)、2026-09-27 に確認）。
- PAR は Enterprise のプランの追加の契約（Highly Regulated Identity）で使える。アプリごとに PAR を必須にできる（`require_pushed_authorization_requests`）（[Configure PAR](https://auth0.com/docs/get-started/applications/configure-par)、2026-09-27 に確認）。
- DPoP は ES256 の鍵で使う。公開のクライアントは DPoP の証明に `nonce` を入れる必要があり、ないと `use_dpop_nonce` のエラーと新しい nonce を返す（[Demonstrating Proof-of-Possession](https://auth0.com/docs/secure/sender-constraining/demonstrating-proof-of-possession-dpop)、2026-09-27 に確認）。
- 認可コードの有効期間は、資料で確かめられなかった（未検証。auth0.com/docs の全文に数値の記述がない。E3 で試用のテナントで確かめる）。

## 3. 方針

- **出すフローを絞る。** `response_type=code` だけを受ける。暗黙フロー、ハイブリッド、パスワードのグラントは出さない（[intent.md](../intent.md)、RFC 9700 の 2.1.2 節・2.4 節）。
- **PKCE は `S256` だけ。** 公開のクライアントは必須。機密のクライアントも既定で必須にする（[ADR-0006](../decisions/0006-authorization-code-pkce-and-exact-redirect.md)）。
- **`redirect_uri` は完全一致。** ワイルドカードを許さない。例外は、ネイティブアプリのループバックの IP のポートだけ（RFC 8252 の 7.3 節）。
- **認可の応答に `iss` を付ける**（RFC 9207）。mix-up 攻撃への備え。
- **秘密で署名する方式は持たない。** `client_secret_jwt` と HS256 を出さない（[ADR-0004](../decisions/0004-credential-storage.md)、[ADR-0007](../decisions/0007-client-authentication-methods.md)）。
- **トークンは短く、宛先を限る。** アクセストークンの `aud` は必ず 1 つの API（と userinfo）に限る（[ADR-0008](../decisions/0008-token-lifetimes-and-claims.md)）。
- **後の拡張は、同じ認可コードの経路の上に足す。** PAR・DPoP・トークン交換は、フラグの裏で足し、既存のクライアントの振る舞いを変えない（[ADR-0010](../decisions/0010-staged-protocol-extensions.md)）。

## 4. エンドポイント

ホスト名は `<tenant>.jp.<brand>.<domain>` か、テナントのカスタムドメイン。ホスト名からテナントを決めてから DB を読む（[ADR-0002](../decisions/0002-tenancy-and-isolation.md)）。

| エンドポイント | メソッド | 役割 | 配り方 | 段階 |
| --- | --- | --- | --- | --- |
| `/.well-known/openid-configuration` | GET | OIDC Discovery | S3＋CloudFront（[ADR-0005](../decisions/0005-authentication-path-availability.md)） | S1 |
| `/.well-known/oauth-authorization-server` | GET | RFC 8414 のメタデータ。中身は上と同じ | 同上 | S1 |
| `/.well-known/jwks.json` | GET | JWKS | 同上（[keys-and-secrets.md](keys-and-secrets.md)） | S1 |
| `/authorize` | GET、POST | 認可の要求 | Auth | S1 |
| `/oauth/token` | POST | トークンの発行 | Auth | S1 |
| `/userinfo` | GET、POST | UserInfo | Auth | S1 |
| `/oauth/revoke` | POST | トークンの失効（RFC 7009） | Auth | S1 |
| `/oauth/device/code` | POST | デバイスの認可の要求（RFC 8628） | Auth | S1 |
| `/activate` | GET、POST | デバイスのユーザーコードの入力の画面 | Auth（Universal Login） | S1 |
| `/oidc/logout` | GET、POST | RP-Initiated Logout | Auth（[sessions-and-sso.md](sessions-and-sso.md)） | S1 |
| `/oauth/par` | POST | PAR（RFC 9126） | Auth | MVP の後 |
| `/oauth/introspect` | POST | イントロスペクション（RFC 7662） | — | 持たない（14 節） |

- 動的なクライアントの登録（`/oidc/register`）は持たない。アプリは Management API とダッシュボードで登録する。
- `issuer` は `https://<host>/`（末尾のスラッシュ付き。本家と同じ形）。カスタムドメインで受けた要求には、カスタムドメインの `issuer` を使う。同じテナントに `issuer` が 2 つあることになる。discovery もホスト名ごとに書き出す。
- `iss` の値は、トークンを発行した要求のホスト名で決まる。`/oauth/token` を認可の要求と別のホスト名で呼ぶと、`invalid_grant` にする（ホスト名の取り違えを早く見つけるため）。

### 4.1 discovery の中身

```json
{
  "issuer": "https://<host>/",
  "authorization_endpoint": "https://<host>/authorize",
  "token_endpoint": "https://<host>/oauth/token",
  "userinfo_endpoint": "https://<host>/userinfo",
  "jwks_uri": "https://<host>/.well-known/jwks.json",
  "revocation_endpoint": "https://<host>/oauth/revoke",
  "device_authorization_endpoint": "https://<host>/oauth/device/code",
  "end_session_endpoint": "https://<host>/oidc/logout",
  "response_types_supported": ["code"],
  "response_modes_supported": ["query", "form_post"],
  "grant_types_supported": ["authorization_code", "refresh_token", "client_credentials",
                            "urn:ietf:params:oauth:grant-type:device_code"],
  "code_challenge_methods_supported": ["S256"],
  "token_endpoint_auth_methods_supported": ["client_secret_basic", "client_secret_post",
                                            "private_key_jwt", "none"],
  "token_endpoint_auth_signing_alg_values_supported": ["RS256", "PS256", "ES256"],
  "revocation_endpoint_auth_methods_supported": ["client_secret_basic", "client_secret_post",
                                                 "private_key_jwt", "none"],
  "id_token_signing_alg_values_supported": ["RS256", "PS256", "ES256"],
  "subject_types_supported": ["public"],
  "scopes_supported": ["openid", "profile", "email", "offline_access"],
  "claims_supported": ["sub", "iss", "aud", "exp", "iat", "auth_time", "nonce", "acr", "amr",
                       "sid", "name", "given_name", "family_name", "nickname", "picture",
                       "locale", "updated_at", "email", "email_verified"],
  "prompt_values_supported": ["none", "login", "consent"],
  "authorization_response_iss_parameter_supported": true,
  "request_parameter_supported": false,
  "request_uri_parameter_supported": false,
  "claims_parameter_supported": false,
  "backchannel_logout_supported": true,
  "backchannel_logout_session_supported": true,
  "ui_locales_supported": ["ja", "en"]
}
```

- `id_token_signing_alg_values_supported` には、テナントが選べるアルゴリズムを並べる。実際に使うのは、テナントの `current` の鍵のアルゴリズム 1 つ（[ADR-0003](../decisions/0003-token-formats-and-signing-keys.md)）。
- `frontchannel_logout_supported` と `check_session_iframe` は載せない（[sessions-and-sso.md](sessions-and-sso.md) の 6.4 節）。
- discovery はテナントの設定から作る。変わるのは、カスタムドメインの追加・削除と、テナントのアルゴリズムの変更のときだけ。Worker が S3 へ書き出す。

## 5. 認可コードのフロー

### 5.1 `/authorize` のパラメーター

| パラメーター | 扱い |
| --- | --- |
| `response_type` | `code` だけ。他は `unsupported_response_type` |
| `client_id` | 必須。テナントの中のアプリ |
| `redirect_uri` | 必須（OIDC Core の 3.1.2.1 節で REQUIRED）。5.2 節で照合 |
| `scope` | `openid` があれば OIDC の要求。なければ OAuth の要求（ID トークンを出さない） |
| `state` | 任意。受けたら応答にそのまま返す。PKCE を使わないクライアント（5.3 節）では必須 |
| `nonce` | 任意。受けたら ID トークンに入れる。PKCE を使わないクライアントの OIDC の要求では必須 |
| `code_challenge`・`code_challenge_method` | 5.3 節。`method` は `S256` だけ。`plain` は `invalid_request` |
| `response_mode` | `query`（既定）か `form_post`。`fragment` は `invalid_request` |
| `prompt` | `none`、`login`、`consent`。空白で区切って複数。`none` と他の値の組み合わせは `invalid_request`（OIDC Core の 3.1.2.1 節） |
| `max_age` | 秒。セッションの `auth_time` からの経過が超えたら、ログインをやり直す。ID トークンに `auth_time` を必ず入れる |
| `ui_locales` | `ja`・`en` から選ぶ。どちらでもなければテナントの既定 |
| `login_hint` | ログインの画面の識別子の欄に入れる。信用しない（画面の初期値だけ） |
| `id_token_hint` | `prompt=none` のとき、セッションの利用者と一致を確かめる。期限切れの ID トークンも受ける。署名は自分のテナントの鍵（`previous` を含む）で確かめる |
| `acr_values` | mfa-and-passkeys.md の値。満たせないとき、`prompt=none` なら `interaction_required` |
| `audience` | アクセストークンの宛先の API の識別子（本家に固有のパラメーター。本家の SDK の使い方に合わせて受ける）。未登録の値は `invalid_request`。省略すると、アプリの既定の API か、なければ userinfo だけを宛先にする |
| `connection` | 使う接続を直接指定する（本家に固有）。アプリで有効でない接続は `invalid_request`（[ADR-0014](../decisions/0014-connection-abstraction.md)） |
| `screen_hint` | `signup` でサインアップの画面から始める（本家に固有） |
| `request`・`request_uri` | 受けない。`request_not_supported`・`request_uri_not_supported`。`request_uri` は PAR を入れた後に、PAR の値だけを受ける |
| `claims` | 受けない（`claims_parameter_supported: false`）。値は無視する |
| `resource`（RFC 8707） | MVP では受けない。値があれば `invalid_target`。トークン交換の Epic で受けるときは `audience` と同じ意味に扱い、両方を送った要求は値が同じときだけ通す（14 節） |

- 同じパラメーターを 2 回付けた要求は `invalid_request`（RFC 6749 の 3.1 節）。
- パラメーターの長さの上限：`state`・`nonce` は 2,048 バイト、`login_hint` は 320 バイト、URL 全体は 8,192 バイト（本システムの決定）。
- POST の `/authorize` は `application/x-www-form-urlencoded` だけを受ける（OIDC Core の 3.1.2.1 節）。

### 5.2 `redirect_uri` の照合

[ADR-0006](../decisions/0006-authorization-code-pkce-and-exact-redirect.md)。

| # | 要求の `redirect_uri` | 登録 | 結果 |
| --- | --- | --- | --- |
| 1 | 登録の 1 つと、文字列として完全に一致 | 任意 | 通す |
| 2 | 大文字・小文字、末尾のスラッシュ、クエリの順、パーセントエンコードの違いだけ | 同上 | 拒否（正規化しない） |
| 3 | `http://127.0.0.1:{任意のポート}/path` か `http://[::1]:{任意のポート}/path` | 同じスキーム・ホスト・パスのループバックを登録済み。アプリの種類が Native | 通す（RFC 8252 の 7.3 節。ポートだけを比べない） |
| 4 | `http://localhost:{port}/...` | 同じ文字列を登録済み | 1 と同じ。ポートの違いは許さない（RFC 8252 の 8.3 節は `localhost` を勧めない） |
| 5 | 登録のない値、パラメーターがない | 任意 | 拒否 |
| 6 | `client_id` が不明 | — | 拒否 |

- 拒否したとき（2・5・6）、`redirect_uri` へは何も送らない。エラーの画面を本システムのホストで出す（[intent.md](../intent.md) の守るべき振る舞い、RFC 6749 の 4.1.2.1 節）。
- 登録のときの規則（tenants-and-applications.md で検査する）：
  - 絶対 URI。フラグメントを持たない。ユーザー情報（`user:pass@`）を持たない。
  - `https` か、ネイティブアプリのプライベートなスキーム（`com.example.app:/callback` の形。逆ドメインの名前に限る）か、ループバック。
  - `http` は、開発のテナント（`environment=development`）の `localhost` とループバックだけ。
  - ワイルドカード（`*`）を持たない。本家は `https://*.example.com` を許すが、本システムは許さない（RFC 9700 の 4.1.3 節）。
  - 1 つのアプリに 100 件まで。1 件 2,048 バイトまで（本システムの決定）。

### 5.3 PKCE

| # | アプリ | `code_challenge` | `require_pkce` | 結果 |
| --- | --- | --- | --- | --- |
| 1 | 公開（SPA、Native） | あり（S256） | 常に真 | 通す |
| 2 | 公開 | なし | 常に真 | `invalid_request`（`code_challenge` が必要） |
| 3 | 機密（Web） | あり | 任意 | 通す。トークンの要求で検証する |
| 4 | 機密 | なし | 真（既定） | `invalid_request` |
| 5 | 機密 | なし | 偽 | 通す。OIDC の要求は `nonce` 必須。`state` 必須 |
| 6 | 任意 | `method=plain` か `method` なし | 任意 | `invalid_request` |

- `code_verifier` は 43〜128 文字の unreserved 文字（RFC 7636 の 4.1 節）。`code_challenge` は 43 文字の base64url（S256 の SHA-256）。形の違う値は `invalid_request`。
- `require_pkce` を偽にできるのは、機密のアプリだけ。偽にすると、ダッシュボードに警告を出し、監査ログに残す。既存の本家のアプリの移行と、PKCE を使わない適合試験のクライアントのための逃げ道（13 節）。
- 認可の要求で `code_challenge` を受けたら、トークンの要求で `code_verifier` が必ず要る。逆に、`code_challenge` なしのコードに `code_verifier` が来たら `invalid_grant`（PKCE のダウングレードの防御。RFC 9700 の 4.8.2 節）。

### 5.4 シーケンス

```
RP(ブラウザ)          Auth（/authorize）             Universal Login        Signer   Aurora
   │ GET /authorize ──▶│ 1. ホスト→tenant、client を設定のキャッシュから
   │                   │ 2. redirect_uri を照合（失敗→エラーの画面）
   │                   │ 3. パラメーターを検証（失敗→redirect_uri へ error＋state＋iss）
   │                   │ 4. login_transactions に保存 ─────────────────────────────▶│
   │                   │ 5. セッションを確かめる（sessions-and-sso.md）
   │                   │    ├ 有効・prompt なし・max_age 内・acr を満たす → 8 へ
   │                   │    ├ prompt=none で満たさない → error=login_required など
   │◀── 302 /u/login?state=<tx> ───── 6. ログインの画面へ
   │ ...ログイン・MFA・同意...        ──▶│ 7. セッションを作る・更新する
   │                   │ 8. 認可コードを作り、ハッシュを保存 ─────────────────────▶│
   │◀── 302 redirect_uri?code=..&state=..&iss=..（form_post なら自動送信の HTML）
   │
RP(サーバー)
   │ POST /oauth/token（code, code_verifier, redirect_uri, クライアントの認証）
   │                   │ 9. クライアントの認証（6 節）
   │                   │10. コードを消費（UPDATE ... WHERE consumed_at IS NULL）──▶│
   │                   │11. PKCE・redirect_uri・client_id を照合
   │                   │12. クレームを組み立てる（8 節）
   │                   │13. 署名を依頼 ─────────────────────────▶│
   │                   │14. リフレッシュトークンの系列を作る（offline_access のとき）─▶│
   │◀── 200 { access_token, id_token, refresh_token?, token_type, expires_in, scope }
```

- 4 の `login_transactions` は、検証を通った認可の要求と、ログインの画面の遷移の間の状態を持つ。表と `__Host-<brand>_tx` の Cookie による結び付け、有効 60 分は universal-login の領域の [ADR-0011](../decisions/0011-universal-login-rendering-and-transaction.md) が決める。この領域は、表に入れる認可の要求の欄（17 節）と、検証を決める。
- **用語**（[universal-login.md](universal-login.md) の 4 節と同じ）：「ログインのトランザクション」は `login_transactions` の 1 行。その参照の値（256 ビットの乱数。DB には `handle_hash` だけ）を「トランザクションの handle」と呼び、図では `<tx>` と書く。handle は画面の URL の `state` のパラメーター（`/u/login?state=<tx>`。本家の形）で運ぶ。**アプリが `/authorize` に送った OAuth の `state` とは別物**で、アプリの `state` は `authz_request.state` に保存し、最後に `redirect_uri` へそのまま返す。
- トランザクションの期限切れ・使用済みでアプリへ戻すときのエラーは、`error=invalid_request`、`error_description=login transaction expired`（本システムの決定。`access_denied` は利用者の拒否と区別できなくなるので使わない）。
- 10 の消費は 1 つの行の条件付きの更新で行い、2 回目の使用を必ず検知する。2 回目なら、そのコードから出したリフレッシュトークンの系列を失効させ（RFC 6749 の 4.1.2 節）、ログに `feacft`（`details.reason` は `code_reuse`。種類のコードは [logs-and-streams.md](logs-and-streams.md) の 3.2 節）を残して `invalid_grant` を返す。発行済みのアクセストークン（JWT）は期限まで止められない（[ADR-0003](../decisions/0003-token-formats-and-signing-keys.md)）。
- 認可コードは 256 ビットの乱数で、`<brand>_ac_` の接頭辞を付けない（URL に出るので短くし、シークレットスキャンの対象にしない。有効 60 秒なので漏れても害が短い）。保存は SHA-256 だけ（[ADR-0004](../decisions/0004-credential-storage.md)）。
- `form_post` の応答の HTML は、`Content-Security-Policy` で本システムのスクリプトだけを許し、`Cache-Control: no-store` を付ける。

### 5.5 `prompt=none` と SSO

- `prompt=none` のとき、画面を出さずに結果を返す。セッションがない → `login_required`。同意がない → `consent_required`。MFA や `acr` を満たさない → `interaction_required`（OIDC Core の 3.1.2.6 節）。
- 別サイトの iframe の中の `prompt=none`（いわゆるサイレント認証）は、ブラウザのサードパーティの Cookie の制限で失敗しうる。SPA には、リフレッシュトークンのローテーションを勧める（[sessions-and-sso.md](sessions-and-sso.md) の 4.3 節）。

### 5.6 同意（OAuth の grant）

- 同意の記録は `grants`（ユーザー × アプリ × 宛先の API → 許したスコープ）に持つ。規約への同意（[ADR-0013](../decisions/0013-consent-records.md)）とは別のもの。
- アプリに「第一者（first-party）」の印があれば、同意の画面を出さない（本家の「ユーザーの同意を飛ばす」設定に相当）。第三者のアプリは、未許可のスコープがあるときに同意の画面を出す。
- `prompt=consent` は、第一者のアプリでも同意の画面を出す。
- 同意の取り消しは Management API で行い、そのユーザー × アプリのリフレッシュトークンの系列をすべて失効させる。

## 6. クライアントの認証

[ADR-0007](../decisions/0007-client-authentication-methods.md)。

| 方式 | 対象 | 検証 |
| --- | --- | --- |
| `client_secret_basic` | 機密 | `Authorization: Basic`。`client_id` と秘密は、RFC 6749 の 2.3.1 節どおり URL エンコードしてから Base64 にしたものとして読む。秘密の SHA-256 を定数時間で比べる |
| `client_secret_post` | 機密 | 本文の `client_id`・`client_secret`。検証は同じ |
| `private_key_jwt` | 機密 | 6.1 節 |
| `none` | 公開（SPA、Native） | `client_id` だけ。PKCE が必須 |
| `tls_client_auth`・`self_signed_tls_client_auth`（RFC 8705） | 機密 | MVP の後（[ADR-0010](../decisions/0010-staged-protocol-extensions.md)） |
| `client_secret_jwt` | — | 持たない（秘密をハッシュでしか持たないため） |

- アプリは方式を 1 つだけ登録する（`token_endpoint_auth_method`）。登録と違う方式で来たら `invalid_client`。2 つの方式を同時に使った要求も `invalid_client`（RFC 6749 の 2.3 節）。
- クライアントの秘密は 2 つまで同時に有効にできる（ローテーションの猶予）。古い秘密に期限を付ける。
- `invalid_client` は、`Authorization` ヘッダーを使った要求には 401 と `WWW-Authenticate: Basic`、それ以外は 400 で返す（RFC 6749 の 5.2 節）。
- 認証の失敗は、クライアントごとと IP ごとに数え、攻撃の防御とレート制限に渡す（attack-protection.md、management-api-and-rate-limiting.md）。

### 6.1 `private_key_jwt`

- アプリに公開鍵を 2 つまで登録する（JWK。RSA 2048 ビット以上か P-256）。`kid` で選ぶ。保存は `client_credentials`（`kind=public_key`。[tenants-and-applications.md](tenants-and-applications.md) の 14 節）。
- アサーションの検証：
  - `alg` は `RS256`・`PS256`・`ES256`。`none` と `HS*` は拒否する。
  - `iss` と `sub` が `client_id`。
  - `aud` は `issuer` の文字列だけを受ける（配列は受けない）。トークンのエンドポイントの URL などほかの値は `invalid_client`（`draft-ietf-oauth-rfc7523bis` の 4 節。14 節の決定）。
  - 互換のフラグ `legacy_token_endpoint_aud`（アプリごと、既定は無効）：有効なアプリだけ、従来の形（トークンのエンドポイントの URL か `issuer` を含む `aud`）も受ける。本家などから移るクライアントのためのもので、GA から 12 か月で廃止し、その後はすべてのアプリで `issuer` だけにする。従来の形で通った件数をアプリごとに数え、ダッシュボードで示す。
  - `exp` は必須で、`exp − iat` が 300 秒以下。時計のずれは 30 秒まで許す。
  - `jti` は必須。`(tenant_id, client_id, jti)` を `exp` まで覚え、2 回目を拒否する。置き場所は Valkey（`SET NX`、期限付き）。Valkey が使えないときは Aurora の `client_assertion_jtis` に挿入する。両方が使えないときは 503。
- 本家の対応アルゴリズムは `RS256`・`RS384`・`PS256`（discovery）。本システムは `RS384` を持たず、`ES256` を足す（本システムの決定）。

## 7. グラント

### 7.1 認可コード（`authorization_code`）

5 節。トークンの要求の `redirect_uri` は、認可の要求と同じ文字列でなければ `invalid_grant`。コードを発行したアプリと違うアプリの認証なら `invalid_grant`。

### 7.2 リフレッシュ（`refresh_token`）

[ADR-0003](../decisions/0003-token-formats-and-signing-keys.md) のローテーションと再利用の検知に従う。セッションとの結び付きは [ADR-0029](../decisions/0029-refresh-token-session-binding.md)。

| # | 状況 | 結果 |
| --- | --- | --- |
| 1 | 有効なトークン。系列が有効 | 新しいトークンを出し、今のトークンを使用済みにする。アクセストークン・ID トークンを出し直す |
| 2 | 使用済みのトークン。使用から猶予（既定 0 秒）の内。系列の最新の 1 つ前 | 1 と同じ扱いで、新しいトークンを出す（本家と同じく、直前の 1 つだけを猶予の対象にする） |
| 3 | 使用済みのトークン。猶予の外か、最新の 2 つ以上前 | 系列のすべてを失効させ、`invalid_grant`。ログに `ferrt`（`details.reason` は `refresh_token_reuse`） |
| 4 | 系列の最終の期限か、使われない期間の期限を過ぎた | `invalid_grant` |
| 5 | 結び付いたセッションが終わった（[ADR-0029](../decisions/0029-refresh-token-session-binding.md)） | `invalid_grant` |
| 6 | 別のアプリの認証 | `invalid_grant`。系列は失効させない（盗用の検知は 3 で行う） |
| 7 | `scope` が元の許可の部分集合 | 通す。新しいアクセストークンのスコープを狭める。系列の許可は変えない |
| 8 | `scope` が元の許可を超える | `invalid_scope` |
| 9 | ユーザーがブロック・削除された | `invalid_grant`。系列を失効させる |

- 公開のクライアントは、ローテーションを必須にする（RFC 9700 の 4.14.2 節）。機密のクライアントは、ローテーションなしも選べる（本家と同じく、アプリの設定）。
- 1 ユーザー × 1 アプリの有効な系列は 200 個まで（本家と同じ）。超えたら最も古い系列を失効させる。
- 系列の数え方と、2 の猶予の上限（0〜60 秒）は [ADR-0003](../decisions/0003-token-formats-and-signing-keys.md) にある。
- 並行の要求（同じトークンを 2 つのタブが同時に送る）は、行のロック（`SELECT ... FOR UPDATE`）で順に処理する。猶予が 0 のとき、遅れた方は 3 になる。SPA の SDK には、トークンの更新を 1 つのタブに寄せるよう文書で勧める。

### 7.3 クライアントクレデンシャル（`client_credentials`）

- 機密のアプリだけ。アプリ × API の許可（`client_grants`。tenants-and-applications.md）にあるスコープだけを出す。`scope` の省略は、許可のすべて。
- `audience` は必須（M2M の許可は API ごとにあるため。本家と同じ）。
- ID トークンとリフレッシュトークンを出さない。
- トークンの発行のために DB に書かない。設定のキャッシュと Signer だけで出す（[ADR-0005](../decisions/0005-authentication-path-availability.md) の Aurora の writer の障害の行）。発行のログは、[logs-and-streams.md](logs-and-streams.md) の 3.3 節の形（outbox に入れられないときはタスクのメモリーから SQS へ直接送る）で残す（14 節）。
- `sub` は `<client_id>@clients`（本家と同じ形）。

### 7.4 デバイス（`urn:ietf:params:oauth:grant-type:device_code`）

[ADR-0009](../decisions/0009-device-authorization-grant.md)。

```
端末（TV など）             Auth                         利用者のスマートフォン
  │ POST /oauth/device/code（client_id, scope, audience）
  │◀─ { device_code, user_code: "BDFK-LMNP", verification_uri: https://<host>/activate,
  │     verification_uri_complete: ...?user_code=BDFK-LMNP, expires_in: 900, interval: 5 }
  │ 画面にコードと QR を出す                      ── /activate を開く、コードを入れる
  │                                               ── ログイン（Universal Login）、確認の画面で「許可」
  │ POST /oauth/token（grant_type=device_code, device_code, client_id）を interval ごとに
  │◀─ 400 authorization_pending（まだ）／ slow_down（速すぎ）／ access_denied ／ expired_token
  │◀─ 200 { access_token, id_token, refresh_token? }（1 回だけ）
```

| 項目 | 値 |
| --- | --- |
| `device_code` | 256 ビットの乱数。保存は SHA-256 だけ |
| `user_code` | BASE20（`BCDFGHJKLMNPQRSTVWXZ`）の 8 文字。表示は `XXXX-XXXX`。入力は大文字・小文字と区切りを無視する。保存は SHA-256。エントロピーは約 34.5 ビット（RFC 8628 の 6.1 節の例と同じ） |
| 有効期間 | 900 秒（本家と同じ） |
| `interval` | 5 秒。前回の問い合わせから `interval` 未満で来たら `slow_down` を返し、以後の `interval` を 5 秒延ばす（RFC 8628 の 3.5 節） |
| 確認の画面 | 端末のアプリ名、要求したスコープ、`user_code` を出し、利用者が「許可」を押して初めて承認する（`verification_uri_complete` から来ても、押すまで承認しない。RFC 8628 の 5.4 節の遠隔のフィッシングへの備え） |
| `/activate` の試行 | 誤ったコードの入力を、IP ごと・セッションごとに数えて止める（値は attack-protection.md） |
| 対象のアプリ | Native の種類で、`token_endpoint_auth_method=none`（本家と同じ）。機密のアプリは MVP では受けない |

- 承認の後、`device_code` のトークンの要求は 1 回だけ成功する。2 回目は `invalid_grant`。
- 端末に出すリフレッシュトークンは、利用者のスマートフォンのセッションに結び付けない（[ADR-0029](../decisions/0029-refresh-token-session-binding.md)）。

### 7.5 持たないグラント

- `password`（ROPG）、`implicit`、本家に固有のグラント（パスワードの realm、パスワードなしの OTP、MFA の OTP・OOB・リカバリーコード）、JWT bearer（RFC 7523 のグラント）、CIBA。
- 本家の MFA のグラントは、ROPG の上で MFA を行うためのもので、ROPG を持たない本システムでは要らない。
- 本家の MFA の API（2 節の表の `/mfa/challenge` と、`/mfa/associate`・`/mfa/authenticators`）も MVP では持たない。埋め込み型・ネイティブのアプリが画面を自分で持って MFA を行うための API で、MVP の Universal Login だけの方針（intent の Non-goals）と合わない。MVP の後に扱うときの形は [mfa-and-passkeys.md](mfa-and-passkeys.md) の 8.1 節に置いた。

## 8. トークン

[ADR-0008](../decisions/0008-token-lifetimes-and-claims.md)。形式と署名は [ADR-0003](../decisions/0003-token-formats-and-signing-keys.md)。

### 8.1 有効期間

| トークン | 既定 | 範囲 | 設定の単位 | 本家 |
| --- | --- | --- | --- | --- |
| 認可コード | 60 秒 | 固定 | — | 未検証 |
| アクセストークン（機密のアプリ・M2M） | 86,400 秒 | 60〜2,592,000 秒 | API | 既定 86,400、最大 2,592,000 |
| アクセストークン（公開のアプリ：SPA・Native・デバイス） | 3,600 秒 | 60〜86,400 秒 | API | ブラウザ向けの値あり（値は未検証） |
| ID トークン | 36,000 秒 | 60〜86,400 秒 | アプリ | 既定 36,000（最大は資料・OpenAPI に記載なし） |
| リフレッシュトークン（最終の期限） | 30 日 | 1 日〜1 年 | アプリ | 既定 30 日、最大 1 年 |
| リフレッシュトークン（使われない期間） | 15 日 | 1 時間〜最終の期限 | アプリ | 既定 30 日（[Configure Refresh Token Expiration](https://auth0.com/docs/secure/tokens/refresh-tokens/configure-refresh-token-expiration)、2026-09-27 に確認） |
| デバイスコード | 900 秒 | 固定 | — | 900 |
| PAR の `request_uri` | 60 秒 | 固定 | — | 未検証 |

- 公開のアプリのアクセストークンを短くするのは、ブラウザやモバイルでの漏えいの害を減らすため。本家より短い（本家のブラウザ向けの既定は未検証）。
- 使われない期間の既定を本家（30 日）より短い 15 日にするのは、放置されたリフレッシュトークンを早く無効にするため。テナントは 30 日にも変えられる。

### 8.2 ID トークン

| クレーム | 値 |
| --- | --- |
| `iss` | 要求のホストの `issuer` |
| `sub` | ユーザーの ID（形は users-and-profiles.md。テナントの中で一意で不変） |
| `aud` | `client_id` だけ（配列にしない） |
| `exp`・`iat` | 8.1 節 |
| `auth_time` | セッションで最後に対話の認証をした時刻。常に入れる |
| `nonce` | 認可の要求の値（あれば） |
| `amr`・`acr` | mfa-and-passkeys.md の値 |
| `sid` | セッションの公開の値（Cookie の秘密とは別の乱数。[sessions-and-sso.md](sessions-and-sso.md) の 3.1 節）。Back-Channel Logout の照合に使う |
| `at_hash` | 入れない（コードのフローでは任意。OIDC Core の 3.1.3.6 節） |
| プロフィール | `profile`・`email` のスコープに応じて、4.1 節の `claims_supported` のうち値のあるものを入れる（本家と同じく ID トークンにも入れる） |

### 8.3 アクセストークン（RFC 9068）

| クレーム | 値 |
| --- | --- |
| ヘッダーの `typ` | `at+jwt` |
| `iss`・`sub`・`iat`・`exp`・`jti` | RFC 9068 の 2.2 節。M2M の `sub` は `<client_id>@clients` |
| `gty` | M2M のトークンだけ `client-credentials`（本家と同じ名前と値）。ユーザーのトークンと区別する（[security.md](security.md) の SEC-018） |
| `aud` | 宛先の API の識別子。`openid` を含む要求では、userinfo の URL を加えた配列 |
| `client_id` | アプリ |
| `scope` | 空白区切り |
| `auth_time`・`acr`・`amr` | ユーザーの要求のときだけ |
| `sid` | 入れない（アクセストークンでセッションを追わせない） |
| 独自のクレーム | テナントが決める URL か `https://<brand>.<domain>/` の名前空間（[ADR-0003](../decisions/0003-token-formats-and-signing-keys.md)） |

- 1 つのトークンの宛先の API は 1 つ。2 つの API を呼ぶアプリは、トークンを 2 つ得る（リフレッシュトークンで `audience` を変えることは MVP では許さない）。
- トークンの大きさ：JWT 全体で 8 KiB を超えるなら発行を拒否し、500 ではなく `server_error` を返してログに残す（独自のクレームの入れ過ぎ）。

### 8.4 userinfo

- アクセストークンは `Authorization: Bearer` ヘッダーか、POST の本文（`access_token`）で受ける。クエリでは受けない（RFC 6750 の 2.3 節は勧めない。OAuth 2.1 の草案は禁じる）。
- トークンの `aud` に userinfo の URL があり、`scope` に `openid` があること。署名・`iss`・`exp` を確かめる。
- ユーザーを DB の reader から読み、スコープに応じたクレームを返す。削除・ブロックされたユーザーは 401 `invalid_token`。
- エラーは `WWW-Authenticate: Bearer error="invalid_token"` の形（RFC 6750 の 3 節）。

### 8.5 失効（`/oauth/revoke`、RFC 7009）

| # | 渡されたトークン | 結果 |
| --- | --- | --- |
| 1 | 自分のアプリのリフレッシュトークン | 系列のすべてを失効させる。200 |
| 2 | 他のアプリのリフレッシュトークン | 何もしない。200（存在を知らせない） |
| 3 | 不明・期限切れの値 | 200（RFC 7009 の 2.2 節） |
| 4 | アクセストークン（JWT） | 400 `unsupported_token_type`。JWT は止められないことを明示する |
| 5 | クライアントの認証の失敗 | 401 `invalid_client` |

- 2 は、RFC 7009 の 2.1 節（発行先のアプリでなければ要求を拒む）と違う。存在の漏えいを避けるため 200 にする。差分テストで node-oidc-provider と比べて決め直す（13 節）。

## 9. エラー

- トークンのエンドポイントのエラーは RFC 6749 の 5.2 節の形（`error`、`error_description`）。`error_description` に秘密・トークン・利用者の識別子を入れない。
- 応答には `Cache-Control: no-store` を付ける（トークンを含む応答すべて）。
- 認可のエンドポイントのエラーは、`redirect_uri` を信頼できたときだけ、`error`・`error_description`・`state`・`iss` を付けて返す。
- 本システムの障害（Signer に届かない、DB の writer のフェイルオーバー）は、トークンのエンドポイントでは 503 と `Retry-After`、認可のエンドポイントでは本システムのエラーの画面にする（`temporarily_unavailable` をリダイレクトで返すのは、`redirect_uri` を照合できた後だけ）。

## 10. 後の拡張（MVP の後）

[ADR-0010](../decisions/0010-staged-protocol-extensions.md)。どれもアプリ・API ごとのフラグで有効にし、既定は無効。

| 拡張 | 形 | 前提 |
| --- | --- | --- |
| PAR（RFC 9126） | `POST /oauth/par` がクライアントを認証し、`/authorize` と同じ検証をしてから `request_uri`（`urn:ietf:params:oauth:request_uri:<乱数>`、有効 60 秒、1 回限り）を返す。アプリごとに `require_pushed_authorization_requests` | 検証の部品を `/authorize` と共有する。保存は `pushed_authorization_requests` |
| DPoP（RFC 9449） | `DPoP` ヘッダーの証明（`typ: dpop+jwt`、`jti`・`htm`・`htu`・`iat`、ES256 と PS256）を検証し、アクセストークンに `cnf.jkt` を入れ、`token_type` を `DPoP` にする。公開のクライアントのリフレッシュトークンも鍵に結ぶ。`DPoP-Nonce` を出す。API ごとに必須にできる | `jti` の再利用の検知は 6.1 節と同じ置き場所 |
| トークン交換（RFC 8693） | `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`。MVP の後に、テナントが許した組（受け取るトークンの種類 × 出す API）だけを通す。委任は `act` クレームで表す | 利用の形（AI エージェントの委任など）を、需要を見て決める |
| mTLS（RFC 8705） | クライアントの認証と、トークンの結び付け | カスタムドメインの TLS の終端の場所（custom-domains.md） |
| イントロスペクション（RFC 7662） | 持たない（14 節の決定） | — |

- FAPI 2.0 の Security Profile の適合は、PAR と DPoP（か mTLS）を入れた後の目標にする。

## 11. 障害のときの振る舞い

[ADR-0005](../decisions/0005-authentication-path-availability.md) の表を、この領域のエンドポイントに当てたもの。

| 障害 | discovery・JWKS | `/authorize`・ログイン | 認可コードの交換 | リフレッシュ | M2M | userinfo |
| --- | --- | --- | --- | --- | --- | --- |
| Aurora の writer のフェイルオーバー | 続く（エッジ） | 503 の画面、再試行を促す | 503＋`Retry-After` | 503 | 続く | 続く（reader） |
| Aurora の reader | 続く | writer から読む | 同左 | 同左 | 続く | writer から読む |
| Valkey | 続く | 続く（セッションは DB から） | 続く | 続く | 続く | 続く |
| Signer に届かない | 続く | ログインの画面までは続く。コードの発行は続く | 503 | 503 | 503 | 続く |
| KMS | 続く | 続く | 続く（Signer はメモリーの鍵） | 続く | 続く | 続く |
| 設定の DB が読めない | 続く | 最後の版のキャッシュで続く | 同左 | 同左 | 同左 | 同左 |

- Signer の障害で、認可コードの発行は続くが交換で 503 になる。コードの有効期間（60 秒）を過ぎたら、RP はログインからやり直す。Signer の回復が 60 秒を超えるなら、コードの有効期間を延ばさずにやり直させる（決定：延ばさない）。
- 失敗の形の一覧：
  - 設定の反映の遅れで、登録を消した `redirect_uri`、失効させたクライアントの秘密が、最大 15 秒通る（[ADR-0032](../decisions/0032-tenant-config-cache.md)）。受け入れると決めた（[tenants-and-applications.md](tenants-and-applications.md) の 13 節の決定）。
  - リフレッシュの並行の要求で、猶予 0 のとき正当な利用者の系列が失効する（7.2 節）。発生の数を `refresh_token_reuse` のうち「同じ IP・1 秒以内」として数え、多いテナントには猶予の設定を勧める。
  - 時計のずれで、`private_key_jwt` の `iat`・`exp` の検証が落ちる。30 秒の許容と、タスクの時刻の監視で抑える。

## 12. セキュリティ

RFC 9700 の要求と、この文書での対応。security.md のチェックリスト（[ADR-0053](../decisions/0053-rfc9700-checklist-and-negative-tests.md)）に写す。

| 脅威（RFC 9700 の節） | 対応 |
| --- | --- |
| `redirect_uri` の不正な照合（4.1） | 完全一致（5.2 節）。登録にワイルドカードを許さない |
| 認可コードの漏えい・注入（4.2、4.3、4.5） | PKCE の S256 を既定で必須、コードは 60 秒・1 回・ハッシュで保存、再利用で系列を失効 |
| PKCE のダウングレード（4.8.2） | `code_challenge` のないコードへの `code_verifier` を拒否（5.3 節） |
| mix-up（4.4） | 認可の応答に `iss`（RFC 9207）。テナントごとに `issuer` が違う |
| オープンリダイレクト（4.11） | エラーを未照合の `redirect_uri` へ送らない。`/oidc/logout` も登録の URL だけ |
| CSRF（4.7） | PKCE か `state` を必須。ログインの画面は `tx` を Cookie と結ぶ |
| リフレッシュトークンの盗用（4.14） | 公開のクライアントはローテーションと再利用の検知。MVP の後に DPoP で結ぶ |
| アクセストークンの宛先の制限（2.3、4.10.2） | `aud` を 1 つの API に限る |
| 307 のリダイレクト（4.12） | 資格情報を POST で受けた後の遷移は 303 にし、307 を使わない（universal-login.md と揃える） |
| クリックジャッキング（4.16） | Universal Login と `/activate` に `frame-ancestors 'none'`（universal-login.md） |
| 暗黙フロー・ROPG（2.1.2、2.4） | 出さない |
| クライアントによる利用者のなりすまし（4.15） | 第三者のアプリは同意の画面を必ず出す。第一者の印の付与は管理者の操作で、監査ログに残す |
| アルゴリズムの取り違え | `alg` を許可リストで検証。`none`・`HS*` を拒否。受け取る JWT は `jose` の `jwtVerify` に `algorithms` を必ず渡す |

- 秘密（コード、`code_verifier`、トークン、クライアントの秘密、`device_code`、`user_code`）を、ログ・トレース・メトリクスのラベルに出さない（[AGENTS.md](../../AGENTS.md)）。`login_transactions` の認可の要求の欄をログに出すときは、許可リストの欄だけにする。
- この領域の変更は `security:sensitive` のラベルを付ける。

## 13. テスト

### 13.1 決定表

- 5.2 節（`redirect_uri`）、5.3 節（PKCE）、7.2 節（リフレッシュ）、8.5 節（失効）の各行を表駆動テストにする。
- `/authorize` のパラメーターの否定の表：`response_type=token`、`code_challenge_method=plain`、`prompt=none login`、同じパラメーターの 2 回、`request` あり、`response_mode=fragment`、未登録の `audience`、アプリで無効な `connection`。

### 13.2 性質ベーステスト（fast-check）

- 任意の文字列の `redirect_uri` で、登録の集合との文字列の完全一致（とループバックの規則）のときだけ通る。正規化で一致する別の文字列は通らない。
- 任意の認可コードの交換の列で、1 つのコードからトークンが出るのは高々 1 回。2 回目の後、そのコードの系列のリフレッシュはすべて失敗する。
- 任意のリフレッシュの列（並行を含む）で、再利用を検知した後は系列のどのトークンも交換できない（[ADR-0003](../decisions/0003-token-formats-and-signing-keys.md) の Confirmation）。
- 任意の 2 テナントで、テナント A のホストで得たコード・トークンは、テナント B のホストで使えない。
- 任意の `scope` の要求で、出したアクセストークンのスコープは、許可の部分集合。
- 任意のデバイスの要求で、`interval` より速い問い合わせは `slow_down` を受け、`interval` が単調に増える。

### 13.3 適合試験（OpenID Foundation conformance suite）

CI での回し方（版の固定、PR と夜間の分け方、`WARNING` の扱い）は delivery の領域の [ADR-0064](../decisions/0064-conformance-suite-in-ci.md) にある。ここでは対象を決める。

| テストプラン | 対象 | 段階 |
| --- | --- | --- |
| OIDC Basic OP（`oidcc-basic-certification-test-plan`） | 必須 | E3 から CI |
| OIDC Config OP（`oidcc-config-certification-test-plan`） | 必須 | E3 から CI |
| Form Post OP（`oidcc-formpost-basic-certification-test-plan`） | 対象にする（14 節の決定） | E3 から CI |
| RP-Initiated Logout OP（`oidcc-rp-initiated-logout-certification-test-plan`） | 必須 | E5 から CI |
| Back-Channel Logout OP（`oidcc-backchannel-rp-initiated-logout-certification-test-plan`） | 必須 | E5 から CI |
| Dynamic OP、Implicit・Hybrid OP、Front-Channel Logout、Session Management | 対象外（動的な登録と、暗黙・ハイブリッド・iframe の仕組みを持たない） | — |
| FAPI 2.0 Security Profile | MVP の後 | PAR・DPoP の後 |

- テストプランの名前は、適合試験のリポジトリの CI の設定（`.gitlab-ci/run-tests.sh`）で確かめた（2026-09-27 に master で確認）。E3 の着手時に、使う版の suite で改めて確かめる。
- 適合試験の実行には、PKCE を使わない機密のクライアント（`require_pkce=false`）を登録したテナントを使う。OIDC の OP の試験は PKCE を送らない（suite の `AbstractOIDCCServerTest` に PKCE の処理がない。2026-09-27 に master で確認）。
- 差分テスト：同じ要求を node-oidc-provider に送り、状態コード・`error`・クレームの違いを一覧にする。違いは、この文書の決定に基づくものだけであることを CI で確かめる（[ADR-0001](../decisions/0001-platform-and-stack.md)）。

### 13.4 結合・E2E

- 主要な OSS のクライアントのライブラリ（`openid-client`、Spring Security、AppAuth の iOS・Android、本システムの SPA の SDK）でのログイン・リフレッシュ・ログアウトを E2E で回す（K3 のため）。
- 障害の注入（11 節の表）：Signer の停止、Aurora の writer のフェイルオーバーの間の各エンドポイントの応答。

## 14. 未解決の問い

### 決定（2026-09-27、既定案）

- **Form Post のプロファイル**：適合試験の対象にする。`form_post` は SPA 以外の Web のアプリで広く使われ、実装も小さい。[intent.md](../intent.md) の K2 に反映した（2026-09-27）。
- **`plain` の PKCE**：出さない。本家は出しているので、移行の文書に書く。
- **ワイルドカードの `redirect_uri`**：出さない。本家から移るテナントには、プレビュー環境などの URL を 1 つずつ登録してもらう（100 件まで）。
- **失効のエンドポイントで他のアプリのトークン**：200（8.5 節）。差分テストの結果で変えてよい。
- **公開のアプリのアクセストークンの既定**：3,600 秒。
- **Signer の障害中の認可コードの有効期間**：延ばさない。

### 決定（2026-09-27、推奨案で確定）

- **`private_key_jwt` の `aud`**：`draft-ietf-oauth-rfc7523bis-11` に従い、`issuer` だけを受ける。この草案は、クライアントの認証の `aud` を `issuer` だけにし、トークンのエンドポイントの URL を使わないこと（MUST NOT）と、それ以外の JWT を認可サーバーが拒否すること（MUST）を求める（[draft-ietf-oauth-rfc7523bis-11](https://datatracker.ietf.org/doc/draft-ietf-oauth-rfc7523bis/) の 4 節、2026-09-27 に確認）。移るクライアントのために、アプリごとの互換のフラグ `legacy_token_endpoint_aud`（既定は無効、GA から 12 か月で廃止）を置く（6.1 節、[ADR-0007](../decisions/0007-client-authentication-methods.md)）。外向きの `oidc_client_assertion` も同じ規則で、IdP の `issuer` を `aud` にする（[keys-and-secrets.md](keys-and-secrets.md) の 6.3 節）。
- **イントロスペクション（RFC 7662）**：持たない。アクセストークンは JWT で、テナントの API が JWKS で確かめる（[ADR-0003](../decisions/0003-token-formats-and-signing-keys.md)）。需要が出たら、新しい ADR で足す。
- **`resource`（RFC 8707）と `audience`**：MVP では `resource` を受けない（`invalid_target`）。トークン交換の Epic で受けるときは、`audience` と同じ意味に扱い、両方を送った要求は値が同じときだけ通す。
- **同意（`grants`）の画面でのスコープごとの一部の許可**：持たない。求められたスコープをまとめて許すか断るかにする。画面と `grants` の形が単純になる。
- **M2M のトークンの発行のログ（Aurora の writer の障害中）**：[logs-and-streams.md](logs-and-streams.md) の 3.3 節の形で残す。失う件数を E3 で計り、許容を確かめる（計測）。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| 本家のブラウザ向けのアクセストークンの既定、認可コードの有効期間 | 本家の試用のテナントで確かめる（E3）。ID トークンの最大は、本家の資料・OpenAPI に記載がないので、本システムの 86,400 秒のままにする |
| M2M のトークンの発行のログを失う件数の許容 | E3 の計測 |

## 15. ADR

| ADR | 決定 |
| --- | --- |
| [0006](../decisions/0006-authorization-code-pkce-and-exact-redirect.md) | 認可の要求は認可コード＋PKCE（S256）だけにし、`redirect_uri` は完全一致で照合する。応答に `iss` を付ける |
| [0007](../decisions/0007-client-authentication-methods.md) | クライアントの認証は `client_secret_basic`・`client_secret_post`・`private_key_jwt`・`none`。秘密で署名する方式は持たない |
| [0008](../decisions/0008-token-lifetimes-and-claims.md) | トークンの有効期間の既定と上限、クレームの規則。公開のアプリのアクセストークンを短くし、宛先を 1 つの API に限る |
| [0009](../decisions/0009-device-authorization-grant.md) | デバイスの認可は RFC 8628 に従い、BASE20 の 8 文字のユーザーコードと、明示の確認の画面で行う |
| [0010](../decisions/0010-staged-protocol-extensions.md) | PAR・DPoP・トークン交換・mTLS は、MVP の後に、認可コードの経路の上にフラグで足す |

## 16. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E1 | `conformance-plans-for-auth-flows` | [ADR-0064](../decisions/0064-conformance-suite-in-ci.md) の枠に、13.3 節のテストプランと試験用のクライアントの設定を載せる |
| E3 | `discovery-and-metadata` | discovery と RFC 8414 のメタデータの生成と S3 への書き出し |
| E3 | `authorize-endpoint` | `/authorize` のパラメーターの検証、`redirect_uri` の照合、`login_transactions` への認可の要求の保存、エラーの画面 |
| E3 | `authorization-code-grant` | コードの発行・消費・再利用の検知、PKCE、`iss` の応答 |
| E3 | `client-authentication` | 4 つの方式、秘密の 2 つまでの並行、`private_key_jwt` の `jti` と `aud`（`issuer` だけ。互換のフラグ `legacy_token_endpoint_aud`） |
| E3 | `token-claims-and-lifetimes` | ID トークン・アクセストークンのクレーム、8.1 節の値、大きさの上限 |
| E3 | `client-credentials-grant` | M2M、DB に書かない経路 |
| E3 | `userinfo-endpoint` | userinfo と Bearer のエラー |
| E3 | `form-post-response-mode` | `form_post` の HTML と CSP |
| E3 | `consent-grants` | `grants`、第一者の印、`prompt=consent`、取り消し |
| E3 | `negative-tests-rfc9700` | 12 節の表の否定のテスト一式 |
| E3 | `differential-tests-node-oidc-provider` | 差分テストの枠と、違いの一覧 |
| E5 | `refresh-token-grant` | ローテーション、猶予、再利用の検知、200 個の上限、スコープの縮小 |
| E5 | `revocation-endpoint` | RFC 7009 |
| E5 | `device-authorization-grant` | `/oauth/device/code`、`/activate`、ポーリング、`slow_down` |
| E12 | `openid-certification` | 認証の申請、結果の公開 |
| MVP の後（[roadmap.md](../roadmap.md) の後回し） | `par`、`dpop`、`token-exchange`、`mtls-client-auth` | 10 節 |

## 17. quality.md・runbooks・data-model への項目

### quality.md

- 認可コードの交換の成功率と、`invalid_grant` の内訳（再利用、期限切れ、PKCE の不一致）。
- `/oauth/token` の p99（NFR-003）を、グラントごとに分けて測る。Signer の往復の時間を別に出す。
- `/authorize` から画面の表示までの p99（NFR-002）。
- `refresh_token_reuse` の件数と、そのうち「同じ IP・1 秒以内」（並行による誤検知の見込み）の割合。
- 適合試験の結果（対象のプロファイルが `main` で常に通ること。NFR-009）。
- デバイスのフローの `slow_down` の割合と、`/activate` の誤入力の率。

### runbooks

- `code-reuse-spike.md`：認可コードの再利用の急増（コードの漏えい・攻撃の疑い）の調べ方。テナントへの連絡。
- `refresh-reuse-spike.md`：リフレッシュトークンの再利用の急増。誤検知（SDK の並行）と盗用の見分け方。
- `conformance-regression.md`：`main` で適合試験が落ちたときの切り分けと、戻し方。

### data-model（索引への追加の提案）

| テーブル | 中身 |
| --- | --- |
| `login_transactions`（表は [ADR-0011](../decisions/0011-universal-login-rendering-and-transaction.md) が持つ） | この領域が `authz_request`（jsonb）に入れる欄：`client_id`、`redirect_uri`、`scope`、`audience`、`state`（アプリの値）、`nonce`、`code_challenge`、`response_mode`、`prompt`、`max_age`、`acr_values`、`ui_locales`、`login_hint`、`connection`、`screen_hint` |
| `pushed_authorization_requests`（MVP の後） | `tenant_id`、`request_uri_hash`、`client_id`、検証済みの認可の要求の欄、`expires_at`（60 秒）、`consumed_at` |
| `authorization_codes` | `tenant_id`、`code_hash`、`login_transaction_id`、`user_pk`、`session_id`、`client_id`、`redirect_uri`、`scope`、`audience`、`code_challenge`、`nonce`、`auth_time`、`amr`、`acr`、`organization_id`（E14）、`expires_at`（60 秒）、`consumed_at`、`refresh_family_id`。列の正本は [data-model/login-and-sessions.md](data-model/login-and-sessions.md) |
| `refresh_token_families` | 列の定義は [data-model/login-and-sessions.md](data-model/login-and-sessions.md) の 2 節にまとめた（この領域、sessions-and-sso、organizations、ADR-0010 の列を合わせたもの） |
| `refresh_tokens` | `tenant_id`、`family_id`、`token_hash`、`seq`、`issued_at`、`used_at` |
| `grants` | `tenant_id`、`user_pk`、`client_id`、`audience`、`scopes`、`created_at`、`updated_at` |
| `device_authorizations` | `tenant_id`、`id`、`device_code_hash`（SHA-256）、`user_code_hash`（短いので pepper の HMAC）、`client_id`、`scope`、`audience`、`status`（`pending`・`approved`・`denied`・`consumed`・`expired`）、`user_pk`、`interval_seconds`、`last_polled_at`、`expires_at` |
| `client_assertion_jtis` | `tenant_id`、`client_id`、`jti`、`expires_at`（Valkey が使えないときの置き場所） |
| クライアントの秘密と公開鍵 | 別の表を持たない。tenants-and-applications の `client_credentials`（`kind` が `secret`・`public_key`）に一本化した（[data-model/tenancy-and-applications.md](data-model/tenancy-and-applications.md) の 3 節） |

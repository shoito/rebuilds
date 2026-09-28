# Connections: Auth0

接続の抽象、データベース接続（サインアップ、ログイン、パスワードの再設定、メールアドレスの確認、パスワードのポリシー）、ソーシャル接続（Google、Apple、LINE、GitHub）と IdP のトークンの保存。MVP の後のエンタープライズ接続（SAML、OIDC、Microsoft Entra ID、コネクタ経由の LDAP）。

| 関連 | 決定 |
| --- | --- |
| [ADR-0014](../decisions/0014-connection-abstraction.md) | 接続は「資格情報を確かめて `VerifiedIdentity` を返す部品」。ユーザーの表は書かない。外部の ID は `(tenant_id, connection_id, provider_user_id)` で特定する |
| [ADR-0015](../decisions/0015-database-connection-password-and-enumeration.md) | パスワードは NIST SP 800-63B-4 に従う（既定の最小 15 文字、組み合わせの規則なし、NFC）。サインアップは verify-first で、アカウントの有無を明かさない |
| [ADR-0016](../decisions/0016-social-connections-and-idp-tokens.md) | ソーシャルは共通の OAuth・OIDC のクライアントと IdP ごとの差分。IdP のトークンは既定で保存しない |
| [ADR-0017](../decisions/0017-enterprise-connections.md) | エンタープライズ（MVP の後）は、保守された SAML のライブラリの上に検証の規則を足し、LDAP は外向きのコネクタで受ける |
| [ADR-0004](../decisions/0004-credential-storage.md)、[ADR-0025](../decisions/0025-breached-password-detection.md) | Argon2id＋pepper、bcrypt の取り込み、漏えいしたパスワードの k-匿名性の照合（法務の確認までは公式の range API）、戻す必要のある秘密のエンベロープ暗号化 |
| [ADR-0005](../decisions/0005-authentication-path-availability.md) | 外部の IdP が落ちても、その接続だけが失敗する |

ログインの画面とトランザクションは [universal-login.md](universal-login.md)、ユーザーと ID のリンクは [users-and-profiles.md](users-and-profiles.md)、MFA とパスキーは [mfa-and-passkeys.md](mfa-and-passkeys.md)、メールの送信は [email-delivery.md](email-delivery.md)、ブルートフォースと漏えいしたパスワードの判定は attack-protection の領域にある。

## 1. 目的と範囲

- 目的：資格情報の確かめ方（パスワード、各社の IdP、後の企業の IdP）を、認可のフローから切り離し、同じ防御・MFA・ログを通す。
- 範囲：接続の型と設定、アプリごとの有効化、データベース接続の資格情報とポリシーとトークン（確認・再設定）、ソーシャル接続の OAuth・OIDC のクライアント、IdP のトークン、Apple のサーバー間の通知、エンタープライズ接続の形（MVP の後）。
- 範囲の外：ユーザーの作成とリンクの判断（users-and-profiles）、ログインの失敗の数とブロック（attack-protection）、パスワードなしのメールのリンク・コードの接続（MVP の後。[intent.md](../intent.md)）、カスタムデータベース（テナントのコードでの照合。Actions に相当する仕組みの後）。

## 2. 本家の振る舞い（2026-09-27 に確認）

| 項目 | 本家 | 本システム |
| --- | --- | --- |
| 接続の種類 | データベース、ソーシャル、エンタープライズ、パスワードなし。`strategy` で区別し、アプリごとに有効にする（[Identity Providers](https://auth0.com/docs/authenticate/identity-providers)） | 同じ形。`strategy` の名前は本システムのもの |
| パスワードのポリシー | 5 段階の強さ、履歴（最大 24）、辞書（1 万件）、個人の情報の禁止（[Password Options](https://auth0.com/docs/authenticate/database-connections/password-options)） | NIST の規則（4.2 節）。組み合わせの規則は作らない |
| ユーザー名 | 既定 1〜15 文字、最大 128。メールアドレスの形は不可（[Require Username](https://auth0.com/docs/authenticate/database-connections/require-username)） | 同じ（4.1 節） |
| 識別子 | メールアドレス、ユーザー名、電話番号の組み合わせ（Flexible Identifiers。Universal Login だけ）（[Flexible Identifiers](https://auth0.com/docs/authenticate/database-connections/flexible-identifiers-and-attributes)） | MVP はメールアドレスとユーザー名。電話番号は SMS の後 |
| 再設定・確認のリンク | 既定 432,000 秒（5 日）。再設定でセッションが失効する（[Customize Email Templates](https://auth0.com/docs/customize/email/email-templates/customize-email-templates)、[Change Users' Passwords](https://auth0.com/docs/authenticate/database-connections/password-change)） | 確認は同じ既定、再設定は 60 分（上限 24 時間）。リフレッシュトークンも失効させる |
| サインアップの列挙 | 既存のメールアドレスで `email-in-use` を返す | verify-first で明かさない（テナントが切り替え可） |
| IdP のトークン | `identities` に保存し、`read:user_idp_tokens` で取り出す（[Identity Provider Access Tokens](https://auth0.com/docs/secure/tokens/access-tokens/identity-provider-access-tokens)） | 既定で保存しない。有効にした接続だけ暗号化して保存 |
| 開発者キー | 試験用の共有のキー。カスタムドメイン、SSO、MFA などが正しく動かない（[Developer Keys](https://auth0.com/docs/authenticate/identity-providers/social-identity-providers/devkeys)） | 提供しない |
| AD/LDAP | テナントのネットワークのコネクタから外向きに接続（[AD/LDAP Connector](https://auth0.com/docs/authenticate/identity-providers/enterprise-identity-providers/active-directory-ldap/ad-ldap-connector)） | 同じ形（MVP の後） |

## 3. 接続の抽象

### 3.1 表

```sql
CREATE TABLE connections (
  tenant_id       uuid        NOT NULL,
  id              uuid        NOT NULL,
  name            text        NOT NULL,          -- [a-z0-9-]{1,128}, unique in tenant
  strategy        text        NOT NULL,          -- database | google | apple | line | github | (later) saml | oidc | entra | ldap
  display_name    text,
  options         jsonb       NOT NULL,          -- validated by a Zod schema per strategy
  secrets_ct      bytea,                         -- envelope-encrypted (ADR-0004): IdP client secret etc. Private keys for IdPs (Apple .p8, OIDC/SAML SP keys) live in external_idp_keys (Signer only, ADR-0047)
  secrets_key_ver integer,
  is_domain_connection boolean NOT NULL DEFAULT false, -- enterprise routing (later)
  version         integer     NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, name)
);

CREATE TABLE connection_clients (          -- which applications may use which connection
  tenant_id     uuid NOT NULL,
  connection_id uuid NOT NULL,
  client_id     text NOT NULL,
  PRIMARY KEY (tenant_id, connection_id, client_id)
);

CREATE TABLE password_credentials (        -- database connection only
  tenant_id       uuid        NOT NULL,
  identity_id     uuid        NOT NULL,      -- user_identities.id
  password_hash   text        NOT NULL,      -- PHC string (argon2id or imported bcrypt) + pepper version
  pepper_version  integer     NOT NULL,
  changed_at      timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, identity_id)
);

CREATE TABLE password_history (
  tenant_id     uuid        NOT NULL,
  identity_id   uuid        NOT NULL,
  password_hash text        NOT NULL,
  created_at    timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, identity_id, created_at)
);

CREATE TABLE database_identifiers (       -- uniqueness per database connection
  tenant_id     uuid NOT NULL,
  connection_id uuid NOT NULL,
  kind          text NOT NULL,              -- email | username
  value_norm    text NOT NULL,              -- lower-cased, NFC; email local part kept as-is except case
  identity_id   uuid NOT NULL,
  PRIMARY KEY (tenant_id, connection_id, kind, value_norm)
);

CREATE TABLE credential_tickets (         -- email verification links, reset links, signup codes
  tenant_id     uuid        NOT NULL,
  id            uuid        NOT NULL,
  purpose       text        NOT NULL,       -- signup_code | verify_email | reset_password
  connection_id uuid        NOT NULL,
  identity_id   uuid,                        -- null for signup_code (user not created yet)
  email_norm    text,
  secret_hash   bytea,                       -- links: SHA-256 (ADR-0004)
  code_hash     text,                        -- 6-digit codes: Argon2id PHC string
  attempts      smallint    NOT NULL DEFAULT 0,
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz,
  transaction_id uuid,                       -- login_transactions.id when started from Universal Login
  created_at    timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE idp_tokens (                  -- only when options.store_idp_tokens = true (ADR-0016)
  tenant_id     uuid        NOT NULL,
  identity_id   uuid        NOT NULL,
  ciphertext    bytea       NOT NULL,       -- access/refresh token JSON, AAD = tenant_id|identity_id|'idp_tokens'
  key_version   integer     NOT NULL,
  expires_at    timestamptz,
  updated_at    timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, identity_id)
);
```

- `user_identities` は users-and-profiles の領域と共有する（[users-and-profiles.md](users-and-profiles.md) の 3.2 節）。データベース接続の `provider_user_id` は、本システムが作る不透明な値（メールアドレスを変えても変わらない）。
- すべての表に RLS を付ける（[ADR-0002](../decisions/0002-tenancy-and-isolation.md)）。
- 1 テナントの接続の数の上限：S1 は 50（データベース 10、ソーシャルは種類ごとに 1 つ）。

### 3.2 部品の契約

[ADR-0014](../decisions/0014-connection-abstraction.md) のとおり。型の要点：

```ts
type VerifiedIdentity = {
  connectionId: string;
  providerUserId: string;          // sub, numeric id, or generated id for database
  email?: string;
  emailVerified: boolean;          // true only when the provider asserts it (see 5.3)
  profile: Record<string, unknown>; // <= 16 KiB, stored in user_identities.profile_data
  idpTokens?: IdpTokens;           // discarded unless store_idp_tokens
};

interface InteractiveStrategy { verify(tx: Tx, input: CredentialInput): Promise<Result<VerifiedIdentity, Failure>> }
interface RedirectStrategy {
  begin(tx: Tx): Promise<Redirect>;
  complete(tx: Tx, callback: CallbackRequest): Promise<Result<VerifiedIdentity, Failure>>;
}
```

- `Failure` は種類（`invalid_credentials`、`idp_error`、`idp_unavailable`、`user_cancelled`、`email_required`）だけを持ち、画面の文言は Universal Login が決める。`invalid_credentials` の詳細（ユーザーがいない・パスワードが違う）は、部品の外に出さない。
- 部品の呼び出しの前に、攻撃の防御の判定（attack-protection）を行う。部品の後に、ユーザーの作成・リンク（users-and-profiles）、MFA、同意、セッションへ進む。

## 4. データベース接続

### 4.1 識別子

- `options.identifiers`：`["email"]`（既定）、`["email","username"]`、`["username"]`。
- メールアドレス：RFC 5321 の形の簡易の検証。ドメインの部分は小文字にし、IDN は Punycode にする。ローカル部は大文字と小文字を区別しないで一意にする（`value_norm` は全体を小文字）。Gmail のドットの無視などの事業者ごとの正規化はしない。
- ユーザー名：既定 1〜15 文字、テナントが最大 128 まで。英数字（小文字にする）と `_ . - + ~ '`。メールアドレスの形は不可（本家と同じ）。

### 4.1.1 認証の方法（`options.authentication_methods`）

```json
{
  "password": { "enabled": true },   // default true
  "passkey":  { "enabled": false }   // default false
}
```

- データベース接続で、どの方法でのログインとサインアップを受けるかを決める。本家にも同じ名前の設定があり、`password`・`passkey` をそれぞれのオブジェクトで持つ（ほかに早期アクセスの `email_otp`・`phone_otp`。Management API の OpenAPI の `ConnectionAuthenticationMethods`、2026-09-27 に確認）。
- 少なくとも 1 つを有効にする。両方を無効にする保存は 400。
- `passkey` を有効にすると、パスキーでのログイン（条件付きの UI とボタン）と、パスキーだけのサインアップ（パスワードを作らない）を受ける。パスキーの設計は [mfa-and-passkeys.md](mfa-and-passkeys.md) の 5.2.2 節。パスキーの有効化は、テナントの RP ID の固定（同じく 5.2.1 節）の後にだけできる。
- `password` を無効にすると、パスワードのログイン・サインアップ・再設定の画面を出さない。既存のユーザーのパスワードの資格情報は消さない（有効に戻せば使える）。パスワードを持たないユーザーの回復は、リカバリーコードかテナントの窓口（mfa-and-passkeys.md の 8 節）。
- 識別子の画面の応答は、方法の組み合わせで変えるが、アカウントの有無では変えない（[ADR-0015](../decisions/0015-database-connection-password-and-enumeration.md)）。

### 4.2 パスワードのポリシー

[ADR-0015](../decisions/0015-database-connection-password-and-enumeration.md) のとおり。`options.password_policy` の形：

```json
{
  "min_length": 15,           // 8..64, default 15
  "max_length": 128,          // fixed
  "history_size": 0,          // 0..24
  "block_breached": true,     // fixed true for signup/change/reset (ADR-0025)
  "block_common": true,       // fixed
  "block_personal_info": true,
  "extra_blocked_words": [],  // <= 200 entries
  "require_mfa_below_15": false
}
```

判定の順（どれも NFC に正規化した値で）：

1. 長さ（コードポイント）が `min_length` 以上、128 以下
2. テナントの禁止の語、ユーザーの識別子（大文字小文字を区別しない、部分一致）
3. よく使われるパスワード（本システムが持つ一覧。完全一致、大文字小文字を区別しない）
4. 漏えいしたパスワード（k-匿名性の range API。SHA-1 の先頭 5 文字で問い合わせ。法務の確認までは公式の API。[ADR-0025](../decisions/0025-breached-password-detection.md)）
5. 履歴（`history_size` > 0 のとき、Argon2id で照合。最大 24 回の計算になるので、同時実行の上限の枠を使う）

- 漏えいの照合が使えないときは、サインアップ・変更・再設定を 503 にする（照合を飛ばさない。[ADR-0005](../decisions/0005-authentication-path-availability.md)）。

### 4.3 サインアップ（verify-first、既定）

```
ブラウザ               Auth（/u/signup）                         DB                     Worker → メール
 │ POST 識別子・同意    │ 攻撃の防御・レート制限                     │                        │
 │─────────────────────▶│ 既存か？                                   │                        │
 │                      │  ├ ない：credential_tickets(signup_code) ─▶│ outbox(verify code) ─▶ │ コードのメール
 │                      │  └ ある：outbox(already registered) ─────▶│                        │ 「登録済みです」
 │◀─ 303 /u/signup/verify（どちらも同じ画面）                        │                        │
 │ POST コード          │ 照合（5 回まで、15 分）                    │                        │
 │◀─ 303 /u/signup/password                                          │                        │
 │ POST パスワード      │ ポリシー（4.2）→ Argon2id                  │                        │
 │                      │ 1 トランザクション：user、identity、        │                        │
 │                      │ password_credentials、consent_records ───▶│                        │
 │◀─ 303 次の段（MFA の登録か、完了）                                │                        │
```

- 「登録済みです」のメールには、ログインと再設定への導線だけを入れる。
- 同じメールアドレスへのサインアップの要求は、15 分に 3 回まで（それ以上は同じ画面を出して送らない）。
- 即時のサインアップ（テナントが選んだ場合）：識別子とパスワードを 1 回で受け、ユーザーを `email_verified=false` で作り、確認のリンクを送る。既存のアドレスは本家と同じく「すでに登録があります」を出す（列挙を受け入れる設定であることをダッシュボードで示す）。
- `options.disable_signup`：画面からのサインアップを止める。Management API での作成は続く。止めても、サインアップの画面は出さないだけで、識別子の画面の応答は変えない。

### 4.4 ログイン

- 識別子の画面の後、アカウントの有無によらずパスワードの画面へ進む（Identifier First）。
- パスワードの照合：攻撃の防御の判定 → `database_identifiers` で引く → ある：Argon2id（＋pepper）で照合／ない：ダミーのハッシュで同じ計算 → 結果。
- 照合に成功したら：古いパラメーター・bcrypt・古い pepper の版なら作り直す（[ADR-0004](../decisions/0004-credential-storage.md)）。漏えいの照合をログインの後に行い、該当ならテナントの設定（再設定を求める・通知する）に従う。
- `email_verified=false` のユーザーのログインを許すかは、テナントの設定（既定は許す。アプリはトークンの `email_verified` で判断する。本家と同じ）。

### 4.5 パスワードの再設定

```
POST /u/reset-password/request（識別子）
  → 同じ画面「登録があれば送りました」（ある：credential_tickets(reset_password) と outbox）
メールのリンク https://<登録したホスト名>/u/reset-password/change?ticket=<256bit>
  → GET：ticket を確かめ、トランザクションに移し、303 で ticket のない URL へ
  → POST 新しいパスワード：ポリシー（4.2）→ Argon2id → 1 トランザクションで
      password_credentials を更新、ticket を消費、他の未使用の ticket を無効化、
      email_verified=true、outbox（パスワードが変わりました、セッションの失効の要求）
  → sessions-and-sso の失効の操作（すべてのセッションとリフレッシュトークンの系列。`end_reason=password_changed`）
```

- リンクの有効期間は既定 60 分（テナントが 10 分〜24 時間）。NIST の「メールで送る回復のコードは 24 時間以内」に合わせる。
- ログインの途中（トランザクションあり）で要求したときは、再設定の後に同じトランザクションへ戻る（別の端末でリンクを開いたときは、ログインの開始の URL へ）。
- 管理者が Management API で作る再設定のチケット（本家の password-change ticket に相当）も、同じ `credential_tickets` を使い、上限 24 時間にする（本家の既定 5 日との違い）。

### 4.6 メールアドレスの確認

- 即時のサインアップ、Management API での作成（`verify_email: true`）、メールアドレスの変更で、確認のリンクを送る。既定 5 日（テナントが 1 時間〜7 日）。
- リンクの `GET` は、確認の画面（「確認する」のボタン）を出し、`POST` で確定する。メールのセキュリティの製品のリンクの事前の取得で、意図せず確認が済むことを避ける。

### 4.7 パスワードの変更（ログイン中）

- 今のパスワード（か、直近 5 分以内の再認証）を求める。変更の後の他のセッションの扱いは、再設定と同じく既定で失効させる（今のセッションは残す）。

## 5. ソーシャル接続

### 5.1 共通の流れ

```
/u/login の「Google で続ける」
  → Auth：idp_state（256bit）と nonce を作り、ハッシュをトランザクションへ。PKCE の verifier も
  → 302 IdP の認可のエンドポイント（redirect_uri = https://<ホスト名>/login/callback）
IdP → GET または POST /login/callback?code=&state=
  → idp_state でトランザクションを特定、Cookie（SameSite の種類に応じて）で同じブラウザを確認
  → トークンのエンドポイントでコードを交換（タイムアウト 5 秒、再試行 1 回）
  → ID トークンの検証（iss, aud, exp, iat, nonce, 署名, alg の許可リスト）、プロフィールの取得
  → VerifiedIdentity → users-and-profiles（作成・リンクの提案）→ MFA → 同意 → 完了
```

### 5.2 IdP ごとの設定と差分

| IdP | 必須の設定 | スコープの既定 | `provider_user_id` | 独自の処理 |
| --- | --- | --- | --- | --- |
| Google | Client ID、シークレット | `openid email profile` | `sub` | `hd` の許可リスト（任意）。要求の `hd` は UI の最適化だけで、ID トークンの `hd` を照合する |
| Apple | Services ID、Team ID、Key ID、`.p8` | `name email`、`response_mode=form_post` | `sub` | クライアントシークレットの JWT を Signer の外部 IdP のアサーション（`apple_client_secret`。[keys-and-secrets.md](keys-and-secrets.md) の 6.3 節）で作り、Auth が 1 時間キャッシュする。`.p8` は登録の時に Signer へ渡し、`external_idp_keys` に暗号文で置く（Auth・Management API は平文を持たない）。最初の応答の `user` の名前を保存。サーバー間の通知（5.4） |
| LINE | チャネル ID、チャネルシークレット | `openid profile`（テナントが申請を済ませたら `email`） | `sub` | Web のログインの ID トークンは HS256（チャネルシークレット）。`bot_prompt` の設定。メールを与えない利用者への対応（5.3） |
| GitHub | Client ID、シークレット | `read:user user:email` | 数値の `id` | ID トークンがない。`GET /user` と `GET /user/emails` を呼ぶ |

- 各 IdP のトークンのエンドポイント・JWKS の URL は、本システムのコードに固定で持つ（テナントが変えられない）。JWKS はプロセスの中に 1 時間キャッシュし、未知の `kid` のときだけ取り直す（1 分に 1 回まで）。

### 5.3 メールアドレスの確認の扱い

| IdP | `emailVerified` を真にする条件 |
| --- | --- |
| Google | ID トークンの `email_verified` が真 |
| Apple | ID トークンの `email_verified` が真（中継のアドレスでも真になりうる。`is_private_email` を `profile` に残す） |
| LINE | 真にしない（ID トークンに確認済みを示すクレームがない。[Verify ID token](https://developers.line.biz/en/docs/line-login/verify-id-token/)、2026-09-27 に確認） |
| GitHub | `/user/emails` で `primary` かつ `verified` のアドレスを選んだとき |

- テナントが「メールアドレスを必須」にしていて、IdP がメールを返さないか未確認のときは、ログインの後にメールアドレスの入力と、確認のコード（4.3 と同じ）の画面を出す。確認したアドレスは、その ID の `email`・`email_verified` に入れる。
- ID のリンクの判断は、この値に依存する（[users-and-profiles.md](users-and-profiles.md) の 5 節）。部品が根拠なく真を返さないことを、13.1 の決定表で確かめる。

### 5.4 Apple のサーバー間の通知

- 受け口：`POST https://<標準のホスト名>/login/callback/apple/notifications`。Apple の登録は Services ID ごとに 1 つの URL なので、テナントの標準のホスト名を使う。
- 本文の JWS を Apple の JWKS で確かめ、`aud`（テナントの Services ID）と `iat` を確かめる。
- 処理は outbox を経て Worker で行う：`consent-revoked`・`account-deleted` はその ID のセッションとリフレッシュトークンを失効させ、`idp_tokens` を消す。`email-disabled`・`email-enabled` は送信の停止の印（[email-delivery.md](email-delivery.md)）。

### 5.5 IdP のトークン

[ADR-0016](../decisions/0016-social-connections-and-idp-tokens.md) のとおり。既定で保存しない。`options.store_idp_tokens=true` の接続だけ、`idp_tokens` に暗号化して保存し、Management API の `read:user_idp_tokens` で取り出す。取り出しは監査ログに残る（[security.md](security.md) の監査の表）。IdP のリフレッシュトークンを使ったアクセストークンの更新は、本システムは行わない（本家も標準の方法を持たない）。

## 6. エンタープライズ接続（MVP の後）

[ADR-0017](../decisions/0017-enterprise-connections.md) のとおり。要点：

| 種類 | 形 | 主な検証 |
| --- | --- | --- |
| SAML 2.0（SP） | 保守された SAML のライブラリ＋本システムの規則。AuthnRequest の署名は Signer の `saml_authn_request` | アサーションの署名の必須、登録した証明書だけ、署名した要素だけを読む（XSW）、`InResponseTo`・`Audience`・`Recipient`・有効期間・再利用、DTD と外部の実体の無効化 |
| OIDC | ソーシャルの共通のクライアント | `private_key_jwt`（Signer の `oidc_client_assertion`）か `client_secret_post` |
| Microsoft Entra ID | OIDC の差分 | `tid` の許可リスト |
| Google Workspace | Google の差分 | `hd` の照合 |
| LDAP | コネクタが外向きに WebSocket で接続。相互 TLS | 照合は 10 秒で打ち切り。本システムはパスワードを保存しない |

- 振り分け：接続に、DNS の TXT で所有を確かめたドメインを登録し、識別子の画面でメールアドレスのドメインが一致したら、その接続へ進める。
- LDAP のコネクタの受け口（`connector.jp.<brand>.<domain>`）は認証の経路の同期の依存になる。[ADR-0005](../decisions/0005-authentication-path-availability.md) の縮退の表に行を足した（2026-09-27。すべてのコネクタに届かないか 10 秒を超えたら、その接続だけが失敗する）。E14 の着手時に、コネクタの設計とあわせてレビューを受ける。

## 7. 障害時の振る舞い

| 障害 | 振る舞い |
| --- | --- |
| IdP の認可・トークンのエンドポイントの障害 | その接続だけ失敗（`idp_unavailable`）。画面で他の方法を案内する。5 分間で失敗の率が 50% を超えたら、接続のボタンに「障害中」を出す（自動、5 分ごとに再評価） |
| IdP の JWKS に届かない | キャッシュの鍵で検証を続ける。未知の `kid` なら失敗 |
| 漏えいしたパスワードの range API の停止 | サインアップ・変更・再設定を 503。ログインは続け、後で照合 |
| Argon2id の同時実行の上限 | 待たずに 503（[ADR-0004](../decisions/0004-credential-storage.md)） |
| メールの送信の遅れ | 確認・再設定のメールが遅れる。画面に再送（60 秒後、3 回まで） |
| Signer の停止 | Apple のクライアントシークレットはキャッシュ（1 時間）の間は続く。切れたら Apple の接続だけ失敗 |
| Aurora の writer のフェイルオーバー | サインアップ・再設定・ログインは短い再試行の後に 503 |

## 8. セキュリティ

| 脅威 | 対策 |
| --- | --- |
| アカウントの列挙 | [ADR-0015](../decisions/0015-database-connection-password-and-enumeration.md) の表（同じ画面・状態コード・時間。メールの送信は非同期） |
| クレデンシャルスタッフィング、ブルートフォース | 部品の前の攻撃の防御の判定（attack-protection）。再設定の攻撃でアカウントをロックしない |
| 事前のアカウントの作成による乗っ取り（pre-account takeover） | verify-first。未確認のメールアドレスでのリンクをしない（[users-and-profiles.md](users-and-profiles.md)） |
| 再設定のトークンの漏れ | 256 ビット、SHA-256 で保存、1 回限り、60 分、URL からすぐ消す、`Referrer-Policy: no-referrer` |
| ホストのヘッダーの注入 | リンクは登録したホスト名から作る（[ADR-0039](../decisions/0039-hostname-resolution-and-issuer.md)） |
| ソーシャルのログインの CSRF・コードの注入 | IdP への `state`（1 回限り）、`nonce`、PKCE、Cookie の結び付け |
| IdP の取り違え（mix-up） | コールバックは `idp_state` から接続を決める。応答の `iss`（返す IdP は）を接続の値と照合する |
| ID トークンの偽造 | IdP ごとの `alg` の許可リスト、`alg: none` の拒否、`aud` の照合 |
| 他のテナントの IdP の設定の悪用 | コールバックのホスト名でテナントを決め、トランザクションのテナントと一致させる |
| IdP のトークンの漏えい | 既定で保存しない。保存するときは暗号化と監査 |
| SAML の署名の包み替え | ADR-0017 の規則と、XSW の既知の型の否定側のテスト |

## 9. テスト

### 9.1 決定表：パスワードのポリシー

| # | パスワード（NFC の後） | `min_length` | 識別子 | 漏えい | 履歴 | 期待 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 15 コードポイント、一覧にない | 15 | 含まない | なし | — | 受け付け |
| 2 | 14 コードポイント | 15 | — | — | — | `too_short` |
| 3 | 絵文字を含む 15 コードポイント（UTF-16 で 16 単位以上） | 15 | — | なし | — | 受け付け（コードポイントで数える） |
| 4 | 129 コードポイント | 15 | — | — | — | `too_long` |
| 5 | メールアドレスの `@` の前を含む | 8 | 含む | — | — | `contains_user_info` |
| 6 | 漏えいの一覧にある | 8 | — | あり | — | `breached` |
| 7 | 直前のパスワードと同じ | 8 | — | なし | 3 | `reused` |
| 8 | 合成済みの `é`（U+00E9）と分解の `é`（U+0065 U+0301） | 8 | — | — | — | 同じパスワードとして照合される |
| 9 | 先頭と末尾が空白 | 8 | — | なし | — | 受け付け。空白は削らない |

### 9.2 決定表：ソーシャルのメールの確認

| # | IdP | 応答 | `emailVerified` |
| --- | --- | --- | --- |
| 1 | Google | `email_verified: true` | 真 |
| 2 | Google | `email_verified: false` | 偽 |
| 3 | Apple | `email_verified: true`、`is_private_email: true` | 真（中継の印を残す） |
| 4 | LINE | `email` あり | 偽 |
| 5 | GitHub | primary が未確認、別の確認済みあり | primary を使わず、確認済みのものがあれば真とそのアドレス。なければ偽 |
| 6 | 任意 | メールなし | 偽、`email` なし |

### 9.3 性質ベーステスト（fast-check）

テスト名には要件 ID を含める（開発リポジトリで採番する）。

- 任意のサインアップ・ログイン・再設定の要求の列で、アカウントのある・ないの対の応答（本文、状態コード、ヘッダー、Cookie の名前）が同じ。
- 任意の再設定・確認のチケットは、使用・期限・再設定の完了のどれかの後に、必ず無効。
- 任意の再設定の完了の後、そのユーザーのリフレッシュトークンの系列はすべて失効している。
- 任意の IdP の応答（`state`・`nonce`・`aud`・`alg`・`exp` を任意に変えたもの）で、1 つでも不正なら `VerifiedIdentity` にならない。
- 任意の接続・アプリの組で、`connection_clients` にない組は使えない（[ADR-0014](../decisions/0014-connection-abstraction.md)）。
- 任意の NFC で等しい 2 つの文字列は、同じパスワードとして照合され、長さの判定も同じ。

### 9.4 その他

- IdP の模擬のサーバー（Google・Apple・LINE・GitHub の形）を Testcontainers で動かし、正常と否定側（誤った署名、古い鍵、遅延、5xx）を通す。
- 実際の IdP との E2E は、ステージングで、本システムのテスト用のアカウント（実在の人のものでない）で日次に回す（AGENTS.md の「テストに本物の資格情報を使わない」）。
- 列挙の時間の差の測定（[ADR-0015](../decisions/0015-database-connection-password-and-enumeration.md) の Confirmation）。
- 負荷試験（E12）：履歴 24 件のテナントのパスワードの変更の CPU の費用。

## 10. ADR

| ADR | 決定 | 状態 |
| --- | --- | --- |
| [0014](../decisions/0014-connection-abstraction.md) | 接続を「資格情報を確かめて外部の ID を返す部品」として抽象化し、ユーザーとは ID で結ぶ | accepted |
| [0015](../decisions/0015-database-connection-password-and-enumeration.md) | データベース接続は NIST SP 800-63B-4 のパスワードの規則に従い、サインアップ・ログイン・再設定でアカウントの有無を明かさない | accepted |
| [0016](../decisions/0016-social-connections-and-idp-tokens.md) | ソーシャル接続は共通の OAuth・OIDC のクライアントと IdP ごとの差分で作り、IdP のトークンは既定で保存しない | accepted |
| [0017](../decisions/0017-enterprise-connections.md) | エンタープライズ接続（MVP の後）は、SAML の SP を保守されたライブラリで作り、LDAP は外向きにだけつなぐコネクタで受ける | accepted |

## 11. Story の候補

| Epic | Story の候補 |
| --- | --- |
| E2 | `connections`・`connection_clients` の表と RLS、Management API の接続の CRUD（`strategy` ごとの Zod の型、秘密の暗号化、秘密を応答に含めない） |
| E4 | `password_credentials`・`database_identifiers` と、パスワードのログイン（ダミーのハッシュ、作り直し） |
| E4 | パスワードのポリシー（4.2 の判定の順、NFC、9.1 の決定表） |
| E4 | verify-first のサインアップ（`credential_tickets` の `signup_code`、「登録済み」のメール）と即時のサインアップの切り替え |
| E4 | パスワードの再設定（チケット、URL からの除去、セッションとリフレッシュトークンの失効） |
| E4 | メールアドレスの確認のリンク（`GET` の確認の画面と `POST` の確定） |
| E4 | ログイン中のパスワードの変更 |
| E6 | ソーシャルの共通のクライアント（PKCE、`state`、`nonce`、JWKS のキャッシュ、コールバック、`form_post` の補助の Cookie） |
| E6 | Google の接続（`hd` の許可リストを含む） |
| E6 | Apple の接続（Signer でのクライアントシークレット、名前の保存、サーバー間の通知） |
| E6 | LINE の接続（HS256 の検証、メールの申請の有無、`bot_prompt`、メールの入力と確認の画面） |
| E6 | GitHub の接続（`/user/emails`） |
| E6 | IdP のトークンの保存（`store_idp_tokens`）と `read:user_idp_tokens` |
| E8 | 部品の前の攻撃の防御の判定の差し込み、再設定・サインアップの速度の上限 |
| E9 | ダッシュボードの接続の設定の画面（IdP ごとの登録の手順の案内を含む） |
| E11 | 確認・再設定のリンクのカスタムドメイン化（[ADR-0039](../decisions/0039-hostname-resolution-and-issuer.md)） |
| E12 | 列挙の時間の差の測定、Argon2id と履歴の照合の負荷試験 |
| MVP の後（移行。[roadmap.md](../roadmap.md) の後回し） | 他の IdP のハッシュの取り込み（PBKDF2 など。users-and-profiles のインポートと一緒に） |
| E14 | エンタープライズ接続：SAML の SP、OIDC、Entra ID、Google Workspace、ドメインの振り分け、LDAP のコネクタ |

E1・E3・E5・E7・E10・E13 には、この領域の Story はない（E5 のセッションの失効の操作は sessions-and-sso、E7 のパスキーでのログインは mfa-and-passkeys が持つ）。

## 12. 品質・運用・データへの引き継ぎ

- [quality.md](../quality.md) に入れる候補：
  - リスク：アカウントの列挙と、再設定のトークンの誤り（上位のリスク）。9.3 の性質ベーステストと、列挙の時間の差の測定を E4 のリリースの基準にする。
  - ソーシャルの否定側のテスト（誤った `state`・`nonce`・`aud`・`alg`）を、IdP ごとに E6 の必須のテストにする。
  - IdP の模擬のサーバーと、ステージングでの実際の IdP との日次の E2E。
  - 本番での検証：接続ごとのログインの成功の率、`idp_unavailable` の率、サインアップのコードの入力の完了の率、再設定の完了の率を日次で見る。
- [runbooks/](../runbooks/README.md) に入れる候補：
  - ソーシャル IdP の障害（特定の IdP の失敗の急増）：IdP の状態の確認、画面の「障害中」の表示、テナントへの告知。
  - IdP の仕様の変更（JWKS の `alg` の変更、エンドポイントの廃止）への緊急の対応。
  - テナントの Apple の `.p8` の失効・漏えい：新しい鍵の登録と、クライアントシークレットのキャッシュの破棄。
  - pepper の鍵のローテーション（keys-and-secrets と一緒に）と、作り直しの進みの確認。
  - 漏えいしたパスワードのデータセットの更新の失敗（サインアップの 503 を避けるための、前の版での継続）。
- [data-model.md](data-model.md) の索引に入れる候補：`connections`、`connection_clients`、`password_credentials`、`password_history`、`database_identifiers`、`credential_tickets`、`idp_tokens`（この領域が持つ）。`user_identities` は users-and-profiles と共有。MVP の後：`saml_assertion_replay`、`ldap_connectors`、`connection_domains`。IdP 向けの秘密鍵は `external_idp_keys`（keys-and-secrets の領域が持つ）。

## 13. 未解決の問い

- LINE ログインのメールアドレスの取得は、LINE Developers Console での申請（規約への同意と、取得の目的を説明する画面のスクリーンショット）が要る（[Integrating LINE Login with your web app](https://developers.line.biz/en/docs/line-login/integrate-line-login/)、2026-09-27 に確認）。ID トークンに確認済みを示すクレームはない（[Verify ID token](https://developers.line.biz/en/docs/line-login/verify-id-token/)、同日に確認）ので、確認済みとして扱わない。申請の審査の期間は未検証で、E6 の着手前に申請して確かめる。
- 海外のソーシャル IdP との間のデータの移転の扱い（L1）。E6 のソーシャル接続の Story は L1 の結論まで承認しない。
- 開発者キーを提供しないことで、K3（最初のログインまで中央値 15 分）が満たせるか。データベース接続だけで K3 を測るかを PM と決める。
- `email_verified=false` のユーザーのログインを、既定で許すか止めるか。

### 決定（2026-09-27、既定案）

- **最小の長さの既定**：15 文字（NIST の単独の要素）。テナントは 8 文字まで下げられ、ダッシュボードで警告する。
- **組み合わせの規則**：提供しない（本家との違い）。
- **サインアップの既定**：verify-first。即時のサインアップは接続ごとに選べる。
- **再設定のリンク**：既定 60 分、上限 24 時間（本家の既定 5 日より短い）。完了でセッションとリフレッシュトークンの系列をすべて失効させる（sessions-and-sso の提案と同じ）。
- **確認のリンク**：既定 5 日（本家と同じ）。`GET` で確定しない。
- **IdP のトークン**：既定で保存しない。
- **開発者キー**：提供しない。
- **LINE の `email_verified`**：確かめられるまで偽として扱う。
- **`email_verified=false` のログイン**：既定で許す（本家と同じ）。テナントが止められる。

### 決定（2026-09-27、推奨案で確定）

- **K3 の測り方**：データベース接続だけで測る。開発者キーを提供しないので、ソーシャル接続は K3 の対象にしない。
- **よく使われるパスワードの一覧**：本家と同じく SecLists の 1 万件を使う（[Password Options](https://auth0.com/docs/authenticate/database-connections/password-options)）。使う版を E4 の着手時に固定し、ライセンスの表記を確かめて、リポジトリに置く。
- **SAML のライブラリ**：第一候補を `@node-saml/node-saml` にする。E14 の着手前に [ADR-0017](../decisions/0017-enterprise-connections.md) の条件（XSW の試験、署名した要素だけを取り出す API、XXE を読まない、保守）で確かめる。
- **列挙の時間の差の合格の基準**：中央値の差 5% 以内、かつ p90 の差 10% 以内（[quality.md](../quality.md) の 2.2.1 節）。統合で足した p90 の条件を受け入れた。
- **パスワードの変更（4.7 節）**：再設定と同じく、他のセッションとリフレッシュトークンの系列を既定で失効させる。今のセッションは残す（[sessions-and-sso.md](sessions-and-sso.md) の 13 節）。

持ち越し：

| 項目 | いつ・どう決めるか |
| --- | --- |
| Pwned Passwords のデータセットの保存と商用の利用の条件 | 法務の確認（[ADR-0025](../decisions/0025-breached-password-detection.md)）。確認までは公式の range API を使う |
| SAML のライブラリの評価 | E14 の着手前に、第一候補の `@node-saml/node-saml` を [ADR-0017](../decisions/0017-enterprise-connections.md) の条件で確かめる。満たさなければ他を評価する |
| 列挙の時間の差の許容（中央値 5%・p90 10%）の妥当性 | E12 の計測 |

## References

- Auth0 Docs: [Password Options](https://auth0.com/docs/authenticate/database-connections/password-options)、[Require Username](https://auth0.com/docs/authenticate/database-connections/require-username)、[Flexible Identifiers](https://auth0.com/docs/authenticate/database-connections/flexible-identifiers-and-attributes)、[Change Users' Passwords](https://auth0.com/docs/authenticate/database-connections/password-change)（2026-09-27 に確認）
- Auth0 Docs: [Identity Provider Access Tokens](https://auth0.com/docs/secure/tokens/access-tokens/identity-provider-access-tokens)、[Developer Keys](https://auth0.com/docs/authenticate/identity-providers/social-identity-providers/devkeys)、[Apple 接続](https://auth0.com/docs/authenticate/identity-providers/social-identity-providers/apple-native)（2026-09-27 に確認）
- Auth0 Docs: [Enterprise Identity Providers](https://auth0.com/docs/authenticate/identity-providers/enterprise-identity-providers)、[AD/LDAP Connector](https://auth0.com/docs/authenticate/identity-providers/enterprise-identity-providers/active-directory-ldap/ad-ldap-connector)（2026-09-27 に確認）
- NIST: [SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b.html)（パスワードの規則、メールの回復のコードの 24 時間。2026-09-27 に確認）
- OWASP: [Forgot Password Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html)、[SAML Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/SAML_Security_Cheat_Sheet.html)（2026-09-27 に確認）
- Google: [OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect)（2026-09-27 に確認）
- Apple: [Creating a client secret](https://developer.apple.com/documentation/accountorganizationaldatasharing/creating-a-client-secret)、[Configuring your environment for Sign in with Apple](https://developer.apple.com/documentation/signinwithapple/configuring-your-environment-for-sign-in-with-apple)、[Processing changes for Sign in with Apple accounts](https://developer.apple.com/documentation/signinwithapple/processing-changes-for-sign-in-with-apple-accounts)（2026-09-27 に確認）
- LINE: [Integrating LINE Login with your web app](https://developers.line.biz/en/docs/line-login/integrate-line-login/)、[Verify ID token](https://developers.line.biz/en/docs/line-login/verify-id-token/)（2026-09-27 に確認）
- GitHub: [REST API endpoints for emails](https://docs.github.com/en/rest/users/emails)（2026-09-27 に確認）
- OASIS: [SAML 2.0 Core](https://docs.oasis-open.org/security/saml/v2.0/saml-core-2.0-os.pdf)

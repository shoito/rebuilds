# MFA and passkeys: Auth0

MFA の要素（TOTP、WebAuthn・パスキー、メールの OTP、リカバリーコード。後の SMS）、登録と step-up、パスワードなしのパスキーのログイン、`amr`・`acr`、NIST SP 800-63B-4 の AAL との対応。

| 関連 | 決定 |
| --- | --- |
| [ADR-0021](../decisions/0021-authenticator-model-and-assurance-levels.md) | 要素を「認証器（authenticator）」の共通の型で持つ。セッションに達成した AAL を記録し、`acr` で返す。メールの OTP は独立した要素に数えない |
| [ADR-0022](../decisions/0022-webauthn-and-passkeys.md) | WebAuthn は保守されたライブラリで検証する。RP ID はテナントのドメインに固定し、パスキーは発見可能な資格情報・UV 必須で、単独で MFA を満たす |
| [ADR-0023](../decisions/0023-otp-and-recovery-codes.md) | TOTP は RFC 6238 の既定（SHA-1・6 桁・30 秒）で再利用を拒む。リカバリーコードは Argon2id、メールの OTP は鍵付きハッシュで保存し、どちらも試行の上限で守る |
| [ADR-0004](../decisions/0004-credential-storage.md) | TOTP の種はエンベロープ暗号化。リカバリーコードとメールの OTP は低エントロピーの秘密として守る |
| [ADR-0003](../decisions/0003-token-formats-and-signing-keys.md) | ID トークンの `amr`・`acr`・`auth_time` |
| [ADR-0005](../decisions/0005-authentication-path-availability.md) | メールの送信事業者が落ちると、メールの OTP だけのユーザーの MFA は失敗する |

Universal Login のトランザクションは [universal-login.md](universal-login.md)、セッションの有効期間と再認証は [sessions-and-sso.md](sessions-and-sso.md)、MFA の失敗の数とブロックは [attack-protection.md](attack-protection.md)、パスワードは [connections.md](connections.md) にある。

## 1. 目的と範囲

- パスワードだけに頼らないログインを、テナントが設定だけで使えるようにする。
- **パスキーを第一の手段にする**（[intent.md](../intent.md)）。パスワードなしのログインと、2 つ目の要素の両方で使う。
- 達成した保証の水準を、NIST SP 800-63B-4 の AAL で説明でき、ID トークンの `acr` でアプリに伝える。
- アプリが、重要な操作の前に強い認証を求められる（step-up）。
- 範囲の外：プッシュ通知の認証アプリ（Guardian に相当。Non-goals）、リスクに応じた MFA（S2 以降）、SMS・音声（MVP の後。法務の L4）。

## 2. 本家の振る舞い（2026-09-27 に確認）

| 項目 | 本家の振る舞い | 出典 |
| --- | --- | --- |
| 要素 | プッシュ（Guardian）、SMS、音声、OTP（認証アプリ）、WebAuthn のセキュリティキー、WebAuthn のデバイスの生体認証、メール、Cisco Duo、リカバリーコード | [MFA Factors](https://auth0.com/docs/secure/multi-factor-authentication/multi-factor-authentication-factors) |
| メール | 他の独立した要素を登録したユーザーだけが、メールの OTP を使える | 同上 |
| パスキー | データベース接続で使える。ユニバーサルログインで、識別子を先に入れる形。ユーザー名の欄の自動入力の候補（条件付きの UI）に出る。パスワードと並べられる。1 ユーザー 20 個まで。既定では、パスキーでのログインの後も MFA を求め、Actions で省ける | [Passkeys](https://auth0.com/docs/authenticate/database-connections/passkeys) |
| step-up | `acr_values` に `http://schemas.openid.net/pape/policies/2007/06/multi-factor` を渡す。MFA を行うと ID トークンの `amr` に `mfa` が入る | [Configure Step-up Authentication for Web Apps](https://auth0.com/docs/secure/multi-factor-authentication/step-up-authentication/configure-step-up-authentication-for-web-apps) |

2026-09-27 に確かめたこと：本家の OTP は 6 桁の数字で、OTP の失敗とリカバリーコードの失敗はユーザーごとに 1 時間 10 回、WebAuthn のチャレンジの失敗はユーザーごとに 1 分 15 回まで（[Enterprise の Rate Limit Configurations](https://auth0.com/docs/troubleshoot/customer-support/operational-policies/rate-limit-policy/rate-limit-configurations/enterprise-public) の追加の MFA の制限）。リカバリーコードは 1 つで、使うと新しいコードを出す（[Reset User Multi-Factor Authentication and Recovery Codes](https://auth0.com/docs/secure/multi-factor-authentication/reset-user-mfa)、[Challenge with Recovery Codes](https://auth0.com/docs/secure/multi-factor-authentication/authenticate-using-ropg-flow-with-mfa/challenge-with-recovery-codes)）。

未検証：本家の TOTP の時間の幅・許す時計のずれ、「このブラウザを覚える」の期間、1 ユーザーの要素の数の上限（資料に記述がない）。E7 の着手前に試用のテナントで確かめる。

NIST SP 800-63B-4 の要点（[SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b.html)、2026-09-27 に確認）：

- AAL2 は 2 つの異なる要素を求める。AAL2 のアプリは、フィッシングに強い認証の選択肢を提供しなければならない。
- AAL3 は公開鍵暗号の鍵の所持の証明と、フィッシングに強い認証器を求める。同期できる認証器（synced passkey）は AAL1・AAL2 まで。AAL3 には使えない。
- 再認証：AAL2 は全体で 24 時間、無操作で 1 時間（推奨）。AAL3 は 12 時間と 15 分。
- メールを out-of-band の認証に使ってはならない（SHALL NOT）。電話網（SMS）は制限付き（restricted）の認証器。
- 連続の失敗は、認証器ごとに 100 回以下に制限する（SHALL。3.2.2 節）。締め出しを減らす手段として、ボットの検知のチャレンジ、失敗ごとに延びる待ち、IP・位置などのリスクに応じた判断を挙げている。
- OTP の秘密の鍵は 112 ビット以上の強さ（3.1.4.1 節）。OTP は有効な間に 1 回だけ受け付ける（SHALL。3.1.4.2 節）。6 桁まで切り詰めてよい。
- ルックアップの秘密（リカバリーコード）は承認された乱数生成器で作り、6 桁以上（3.1.2.1 節）。112 ビット未満の秘密は、32 ビット以上のソルトを付け、パスワードのハッシュの方式で保存する（SHALL。3.1.2.2 節）。
- 節の番号：AAL2 は 2.2 節、再認証は 2.2.3・2.3.3 節、同期できる認証器は 3.1.7.3 節と 2.3.2 節。

## 3. 認証器のモデル

### 3.1 種類

| `type` | 中身 | 要素の分類（NIST） | MVP |
| --- | --- | --- | --- |
| `webauthn` | WebAuthn の資格情報。パスキー（発見可能・UV あり）とセキュリティキー（2 つ目の要素） | 多要素の暗号の認証器（UV あり）、単一要素の暗号の認証器（UV なし） | あり |
| `totp` | RFC 6238 の TOTP の種 | 単一要素の OTP の認証器 | あり |
| `email` | 確認済みのメールアドレスへの 6 桁の OTP | NIST では認証器に数えない（2 節） | あり（補助だけ） |
| `recovery_code` | 1 回限りのコードの組 | ルックアップの秘密 | あり |
| `sms` | 電話番号への OTP | 制限付きの out-of-band | MVP の後（L4） |

### 3.2 スキーマ

```sql
CREATE TABLE authenticators (
  tenant_id      uuid NOT NULL,
  id             uuid NOT NULL,             -- UUIDv7
  user_pk        uuid NOT NULL,             -- users.id
  type           text NOT NULL,             -- webauthn | totp | email | recovery_code | sms
  status         text NOT NULL,             -- pending | active | locked | disabled
  name           text,                      -- user-visible label, <= 64 chars
  failure_count  int  NOT NULL DEFAULT 0,   -- consecutive failures (section 7)
  locked_until   timestamptz,
  created_at     timestamptz NOT NULL,
  confirmed_at   timestamptz,
  last_used_at   timestamptz,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE totp_secrets (
  tenant_id       uuid NOT NULL,
  authenticator_id uuid NOT NULL,
  secret_ciphertext bytea NOT NULL,         -- AES-256-GCM, AAD = tenant_id|authenticator_id|"totp" (ADR-0004)
  data_key_version  int  NOT NULL,
  algorithm       text NOT NULL DEFAULT 'SHA1',
  digits          int  NOT NULL DEFAULT 6,
  period_seconds  int  NOT NULL DEFAULT 30,
  last_used_step  bigint,                   -- replay protection
  PRIMARY KEY (tenant_id, authenticator_id)
);

CREATE TABLE webauthn_credentials (
  tenant_id       uuid NOT NULL,
  authenticator_id uuid NOT NULL,
  rp_id           text NOT NULL,
  credential_id   bytea NOT NULL,           -- <= 1023 bytes
  public_key_cose bytea NOT NULL,
  sign_count      bigint NOT NULL DEFAULT 0,
  aaguid          uuid,
  transports      text[],
  discoverable    boolean NOT NULL,         -- resident key
  uv_capable      boolean NOT NULL,         -- UV was performed at registration
  backup_eligible boolean NOT NULL,         -- BE flag (fixed at registration)
  backup_state    boolean NOT NULL,         -- BS flag (latest)
  attestation_fmt text NOT NULL,            -- 'none' by default
  usage           text NOT NULL,            -- passkey | second_factor
  PRIMARY KEY (tenant_id, authenticator_id),
  UNIQUE (tenant_id, rp_id, credential_id)
);

CREATE TABLE recovery_codes (
  tenant_id       uuid NOT NULL,
  authenticator_id uuid NOT NULL,
  slot            smallint NOT NULL,        -- 1..10, printed as NN- prefix (not secret)
  code_hash       text  NOT NULL,           -- Argon2id PHC string + pepper version (ADR-0004)
  used_at         timestamptz,
  PRIMARY KEY (tenant_id, authenticator_id, slot)
);

CREATE TABLE otp_challenges (               -- email (and later sms) codes
  tenant_id       uuid NOT NULL,
  id              uuid NOT NULL,
  transaction_id  uuid NOT NULL,            -- Universal Login transaction (ADR-0011)
  authenticator_id uuid NOT NULL,
  code_hmac       bytea NOT NULL,
  expires_at      timestamptz NOT NULL,
  attempts        int NOT NULL DEFAULT 0,
  consumed_at     timestamptz,
  PRIMARY KEY (tenant_id, id)
);
```

- `users.webauthn_user_handle`（64 バイトの乱数）は [users-and-profiles.md](users-and-profiles.md) の `users` にある。WebAuthn の user handle は、個人を特定する情報を含めてはならない（WebAuthn Level 3）ので、`user_id` を使わない。
- 1 ユーザーの上限：パスキーと WebAuthn の資格情報を合わせて 20 個（本家のパスキーの上限と同じ）、TOTP 5 個、メール 1 個（ユーザーの確認済みのメールアドレス）、リカバリーコードの組 1 つ。
- `email` の認証器は、ユーザーの `email` が確認済みのときだけ作れる。メールアドレスを変えると、`email` の認証器を作り直す（古いアドレスへは送らない）。
- `otp_challenges` は DB（writer）に置く。Valkey は失われうるので、1 回限りの保証を持たせない（[ADR-0005](../decisions/0005-authentication-path-availability.md)）。期限切れの行は Worker が 1 時間ごとに消す。

### 3.3 テナントの方針

```ts
type MfaPolicy = {
  mode: "never" | "always";                     // "adaptive" is S2+
  factors: {                                    // enabled factors
    webauthn_roaming: boolean;                  // security keys as second factor
    webauthn_platform: boolean;                 // platform authenticators as second factor
    totp: boolean;
    email: boolean;                             // only as fallback (section 5.3)
    recovery_code: boolean;                     // forced true when any factor is enabled
  };
  passkey_satisfies_mfa: boolean;               // default true (ADR-0022)
  remember_device_days: 0 | 1 | 7 | 30;         // default 0 (off)
  require_phishing_resistant: boolean;          // default false; only WebAuthn counts
};
```

- 方針はテナント全体に 1 つ。アプリごとの上書きは、アプリの `acr_values` の要求（6 節）で行う。
- `remember_device_days` は、MFA を済ませたブラウザに署名付きの Cookie（`__Host-<brand>_mfa_rd`。`Secure`・`HttpOnly`・`SameSite=Lax`・`Path=/`。ユーザー・端末・期限を含む。Cookie の一覧は [sessions-and-sso.md](sessions-and-sso.md) の 3.1 節）を置き、期間中はそのブラウザで MFA を省く。既定は無効。`acr` に AAL2 を求める要求では、この省略を使わない（AAL2 の再認証の上限と合わないため）。

## 4. 登録

### 4.1 いつ登録するか

| 場面 | 流れ |
| --- | --- |
| ログインの途中で、方針が MFA を求め、ユーザーに有効な要素がない | 登録の画面へ。最初の要素は `webauthn`・`totp` のどれか（有効なもの）。`email` だけでは登録を済ませたことにしない |
| 最初の要素を登録した直後 | リカバリーコードを表示し、控えたことの確認を求める |
| パスワードでログインした後（パスキーの促し） | テナントの設定 `passkey_enrollment_prompt`（既定は有効）。パスキーの作成を 1 画面で促し、断れる。断ったら 30 日は促さない |
| アプリからの登録の要求 | `/authorize` に MFA の登録のための独自のパラメーターは作らない。アプリは、`acr_values` で AAL2 を求めるか、Management API の登録のチケット（4.3）を使う |
| 管理者の登録のチケット | Management API で 1 回限りの URL を作り、ユーザーに送る（4.3） |

- **新しい要素の登録には、直近の認証を求める。** セッションの `auth_time` から 5 分を超えていたら、今ある要素で再び認証させる（要素がないときは、第 1 の要素だけ）。セッションを盗んだ攻撃者が、自分の要素を足して居座ることを防ぐ。
- 要素を足したら、ユーザーに通知のメールを送る（テナントの設定。既定は有効）。

### 4.2 状態機械（認証器）

```
  create ──▶ pending ──(確認のコード・署名が通る)──▶ active
               │ 10 分                               │   ▲
               ▼                                     │   │ 期限が過ぎる／管理者が解除
            （消す）                        連続の失敗 ▼   │
                                                  locked ──┘
                                                     │ 失敗が 100 回（通算の連続）
                                                     ▼
                              active ──(本人・管理者が外す)──▶ （消す）
                                                  disabled ──（管理者の再設定まで使えない）
```

- `pending` の認証器は、10 分以内に確かめないと消す。TOTP は最初のコードの照合、WebAuthn は登録の応答の検証で `active` にする。
- `locked`・`disabled` は 7 節。

### 4.3 登録のチケット

- Management API の `POST /users/{id}/authenticator-enrollment-tickets`。有効 24 時間（テナントで 5 分〜7 日）、1 回限り、SHA-256 で保存（[ADR-0004](../decisions/0004-credential-storage.md)）。
- チケットの URL を開いたユーザーには、まず第 1 の要素（パスワードかパスキー）で認証させる。チケットだけで登録を済ませない（URL が漏れたときの乗っ取りを防ぐ）。

## 5. 要素ごとの設計

### 5.1 TOTP（[ADR-0023](../decisions/0023-otp-and-recovery-codes.md)）

- RFC 6238 の既定に従う：HMAC-SHA-1、6 桁、30 秒、T0 = 0。種は 160 ビット（RFC 4226 の推奨）の乱数。
- 表示：`otpauth://totp/<issuer>:<account>?secret=<base32>&issuer=<issuer>&algorithm=SHA1&digits=6&period=30` の QR と、手入力の文字列。`issuer` はテナントの表示名。`account` はメールアドレスかユーザー名（テナントで選ぶ）。
- 照合：現在の時刻の区間と、前後 1 区間（±30 秒）を許す。一致した区間の番号が `last_used_step` 以下なら拒否する（同じコードの再利用の拒否。RFC 6238 の 5.2 節）。照合は定数時間の比較。
- 種は登録の画面で 1 回だけ見せる。後から見せない。

### 5.2 WebAuthn・パスキー（[ADR-0022](../decisions/0022-webauthn-and-passkeys.md)）

登録のオプション：

| 項目 | パスキー | セキュリティキー（2 つ目の要素） |
| --- | --- | --- |
| `rp.id` | テナントの RP ID（5.2.1） | 同じ |
| `user.id` | `webauthn_user_handle` | 同じ |
| `authenticatorSelection.residentKey` | `required` | `discouraged` |
| `authenticatorSelection.userVerification` | `required` | `discouraged` |
| `attestation` | `none` | `none`（テナントが `direct` を選べるのは S2 以降。AAL3 の検討と一緒に） |
| `pubKeyCredParams` | ES256（-7）、EdDSA（-8）、RS256（-257） | 同じ |
| `excludeCredentials` | ユーザーの既存の資格情報 | 同じ |
| `hints`（Level 3） | `client-device`、`hybrid` | `security-key` |
| `timeout` | 300,000 ms | 同じ |
| チャレンジ | 32 バイトの乱数。トランザクションに保存し、1 回限り、5 分 | 同じ |

検証（ライブラリに任せるものと、自分で確かめるもの）：

- `clientDataJSON.type`、`challenge`、`origin` の一致。許す `origin` は、テナントの標準のホスト名とカスタムドメインの `https://` だけ。
- `rpIdHash` が RP ID の SHA-256 と一致。UP フラグが立つ。パスキーでは UV フラグが立つ。
- BE（backup eligible）と BS（backup state）のフラグを記録する。BE は登録の後に変わらないはずで、変わったら拒否する。
- 署名の回数：保存した値と受け取った値がともに 0 でなく、受け取った値が保存した値以下なら、複製の疑いとして `webauthn.sign_count_regression` をログに残す。ログインは既定で拒否しない（同期するパスキーは 0 を返すことが多いため）。テナントの設定で拒否にできる。
- `credential_id` は `(tenant_id, rp_id)` の中で一意。他のユーザーの資格情報と重なったら登録を拒否する。

#### 5.2.1 RP ID とカスタムドメイン

- パスキーは RP ID に結び付く。RP ID を変えると、登録済みのパスキーは使えない。
- **RP ID は、テナントで最初にパスキーを有効にした時点のホスト名に固定する。** カスタムドメインがあればカスタムドメイン、なければ `<tenant>.jp.<brand>.<domain>`。`tenants.webauthn_rp_id` に保存する。
- その後にカスタムドメインを足した・替えたテナントには、WebAuthn Level 3 の Related Origin Requests（RP ID のホストの `/.well-known/webauthn` に、許す origin の一覧を置く）で、新しいドメインからも古い RP ID のパスキーを使えるようにする。ブラウザの対応は、Chrome・Edge 128 以上、Safari（iOS 18・macOS 15 以上）、Firefox 152 以上（[passkeys.dev の Device Support](https://passkeys.dev/device-support/)、2026-09-27 に確認）。対応は `PublicKeyCredential.getClientCapabilities()` の `relatedOrigins` で調べる（[Related Origin Requests](https://passkeys.dev/docs/advanced/related-origins/)）。対応しないブラウザでは、パスワードかパスキーの再登録に回す。
- ダッシュボードで、RP ID を固定することと、後から変えられないことを、パスキーを有効にする前に示す。

#### 5.2.2 パスキーでのログイン（パスキー優先）

```
ブラウザ                           Universal Login（Auth）
  │ /authorize                        │
  │──────────────────────────────────▶│ トランザクションを作る。チャレンジ C を作る
  │◀── 識別子の画面                    │  （<input autocomplete="username webauthn">、
  │    ＋ navigator.credentials.get({ │   mediation: "conditional"、allowCredentials: []）
  │       mediation:"conditional" })  │
  │ 利用者が候補からパスキーを選ぶ     │
  │ （端末で UV）                      │
  │── assertion（credential_id, userHandle, 署名） ─▶│
  │                                   │ (tenant, rp_id, credential_id) で資格情報を引く
  │                                   │ userHandle が users.webauthn_user_handle と一致
  │                                   │ 署名・フラグ・チャレンジを検証、C を使用済みに
  │                                   │ 攻撃の防御の判定（attack-protection.md）
  │                                   │ ブロック中のユーザーなら拒否
  │                                   │ セッションに amr=["hwk"|"swk","user"]、AAL2 を記録
  │◀── 同意・トークンの発行へ          │
```

- 条件付きの UI に対応しないブラウザでは、「パスキーでログイン」のボタン（モーダルの `get`）を出す。識別子を入れた後にも、そのユーザーのパスキーがあればパスキーを先に勧める。ただし、ユーザーの有無とパスキーの有無で画面の文言を変えない（列挙を防ぐ）。識別子を入れた後は、パスキーとパスワードの両方の選択肢を常に出す。
- パスキーでのログインを使えるのは、データベース接続の ID を持つユーザー（本家と同じ）。パスワードなしのユーザー（パスキーだけでサインアップ）も作れる。データベース接続の設定 `authentication_methods`（`password`・`passkey`）で選ぶ（[connections.md](connections.md) の 4.1.1 節）。
- **UV 付きのパスキーでのログインは、単独で MFA を満たす**（`passkey_satisfies_mfa`、既定は真）。パスキーは所持（秘密鍵）と、端末の生体認証か PIN の 2 つの要素を 1 回で確かめる。本家は既定で追加の MFA を求める。本システムは NIST SP 800-63B-4 の多要素の暗号の認証器の扱いに合わせる。偽にしたテナントでは、パスキーの後に別の要素を求める。
- パスキーを登録した後、Level 3 の Signal API（`signalUnknownCredential`、`signalAllAcceptedCredentials`、`signalCurrentUserDetails`）で、消したパスキーと名前の変更を資格情報の管理者に知らせる。対応は Chrome・Edge 132 以上と Safari 26 以上で、Firefox は未対応（MDN の browser-compat-data 8.1.3、2026-09-27 に確認）。対応しないブラウザでは何もしない。

#### 5.2.3 ライブラリ

- `@simplewebauthn/server` を使う（2026-09-27 に推奨案で確定。[architecture/README.md](README.md) の 4 節）。E7 の着手の時点で、保守の状況、Level 3 の項目（`hints`、BE・BS、Related Origin Requests）の対応、依存の数を確かめ、満たさないときだけ見直す（ADR-0022 の Confirmation）。
- CBOR・COSE の解析と署名の検証を自前で書かない（[AGENTS.md](../../AGENTS.md)）。

### 5.3 メールの OTP

- **補助の要素に限る。** `webauthn` か `totp` を 1 つ以上登録したユーザーだけが使える（本家と同じ）。それらを使えないときの予備。
- **メールの OTP で済ませた MFA は、AAL2 に数えない。** NIST SP 800-63B-4 は、メールを out-of-band の認証に使うことを禁じている。`acr` は AAL1 のまま。`amr` には `mfa` を入れる（本家との互換。6.1 節の表）。アプリが `acr_values` で AAL2 を求めたら、メールの OTP を選択肢に出さない。
- コード：6 桁の数字、有効 5 分、1 つのチャレンジで試行 5 回まで。再送は 30 秒の間隔を置き、1 時間に 5 回まで。新しいコードを送ると、前のコードは使えなくする。
- 保存：`HMAC-SHA-256(pepper, tenant_id | challenge_id | code)`。6 桁は総当たりに弱いので、試行の上限と短い期限で守る（[ADR-0004](../decisions/0004-credential-storage.md)）。
- 送信は outbox から Worker が行う（[email-delivery.md](email-delivery.md)）。送信事業者が落ちたら、他の要素を案内する（[ADR-0005](../decisions/0005-authentication-path-availability.md)）。

### 5.4 リカバリーコード（[ADR-0023](../decisions/0023-otp-and-recovery-codes.md)）

- 最初の要素を登録したときに、10 個のコードを 1 組で作る。1 つは 10 文字の base32（Crockford。紛らわしい文字を除く）、約 50 ビット。
- 表示は `NN-XXXXX-XXXXX`。`NN` は組の中の番号（01〜10）で秘密ではない。照合する行を 1 つに決めるために使い、Argon2id の計算を 1 回で済ませる。
- **保存は Argon2id（コードごとのソルト、[ADR-0004](../decisions/0004-credential-storage.md) のパスワードと同じパラメーターと pepper）。** NIST SP 800-63B-4 は、112 ビット未満のルックアップの秘密を、ソルト付きのパスワードのハッシュの方式で保存するよう求めている（3.1.2.2 節）。50 ビットのコードは、これに当たる。
- 照合は、パスワードと同じハッシュの同時実行の上限の中で行う（ADR-0004）。
- 各コードは 1 回だけ使える。使ったら `used_at` を記録する。残りが 3 個以下になったら、ログインの後に作り直しを促す。
- 作り直すと、古い組はすべて使えなくする。作り直しには直近の認証（5 分）を求める。
- リカバリーコードでログインしたら、ユーザーに通知のメールを送る。
- 本家は 1 つのコードを使うと新しいコードを出す形（[Reset User Multi-Factor Authentication and Recovery Codes](https://auth0.com/docs/secure/multi-factor-authentication/reset-user-mfa)、2026-09-27 に確認）。本システムは 10 個の組にする（控えを 1 回で済ませ、使うたびに新しいコードを控える手間をなくす）。

### 5.5 SMS（MVP の後）

- 法務の L4 の後。NIST の制限付きの認証器として扱う：登録の時に危険を示し、SIM の入れ替え・番号の移転の兆候（送信事業者が出すなら）で使わない。`acr` は AAL2 に数えるが、`require_phishing_resistant` のテナントでは使えない。
- 送信の費用の悪用（SMS pumping）への備えを、攻撃の防御と一緒に設計する。

## 6. `amr`・`acr` と step-up

### 6.1 `amr` と AAL の対応

`amr` の値は RFC 8176 の登録の値を使う。

| 使った手段 | `amr` | 達成した AAL（`acr`） | フィッシングに強い |
| --- | --- | --- | --- |
| パスワードだけ | `["pwd"]` | AAL1 | いいえ |
| ソーシャル接続だけ | `["fed"]`（独自。RFC 8176 にない） | AAL1（IdP の主張は信用しない） | — |
| パスキー（UV、同期する、BE=1） | `["swk","user"]`＋MFA を満たすとき `"mfa"` | AAL2 | はい |
| パスキー（UV、端末に固定、BE=0） | `["hwk","user","mfa"]` | AAL2（AAL3 は主張しない） | はい |
| パスワード＋TOTP | `["pwd","otp","mfa"]` | AAL2 | いいえ |
| パスワード＋セキュリティキー（UV なし） | `["pwd","hwk","mfa"]` | AAL2 | はい |
| パスワード＋リカバリーコード | `["pwd","rc","mfa"]`（`rc` は独自。ルックアップの秘密） | AAL2 | いいえ |
| パスワード＋メールの OTP | `["pwd","email","mfa"]`（`email` は独自） | AAL1 | いいえ |
| ソーシャル＋TOTP など | `["fed","otp","mfa"]` | AAL2 | 2 つ目の要素に依る |

- RFC 8176 の `hwk` は端末に固定された鍵、`swk` はソフトウェアの鍵、`user` は利用者の確認（UV）、`otp` は OTP、`pwd` はパスワード、`mfa` は多要素。`fed`・`email`・`rc` は本システムの独自の値で、discovery の文書に説明を載せる。
- `mfa` の意味は「2 つ目の要素を確かめた」で、本家と互換にする。保証の水準は `acr` で判断するよう、文書で示す。
- 同期するパスキーでの `swk`・`hwk` の使い分けは、BE フラグで決める。BE=1 の資格情報は複製されうるので `hwk` を名乗らない。

### 6.2 `acr` の値

| 値 | 意味 |
| --- | --- |
| `https://<brand>.<domain>/acr/aal1` | AAL1 |
| `https://<brand>.<domain>/acr/aal2` | AAL2 |
| `https://<brand>.<domain>/acr/aal2-pr` | AAL2 かつフィッシングに強い認証器（WebAuthn）を使った |
| `http://schemas.openid.net/pape/policies/2007/06/multi-factor` | 要求の値としてだけ受ける。`aal2` と同じに扱う（本家からの移行の互換）。ID トークンの `acr` には、達成した本システムの値を返す |

- 値の名前空間は `<brand>`（リポジトリ共通の ADR-0006）。discovery の `acr_values_supported` に載せる。
- AAL3 は MVP で主張しない。AAL3 には、同期しない認証器であることの証明（アテステーションの検証）と、再認証の間隔（12 時間・15 分）が要る。S2 以降に、`attestation: direct` と AAGUID の許可リストとあわせて検討する。

### 6.3 セッションに記録するもの

- セッション（[sessions-and-sso.md](sessions-and-sso.md)）に、`auth_time`、要素ごとの最後の認証の時刻、達成した `acr`、`amr` を持つ。
- SSO で別のアプリに入るとき、要求の `acr_values` と `max_age` を、セッションの記録と比べる。満たさなければ、足りない要素だけを求める（パスワードを入れ直させない）。

### 6.4 step-up の判定

| # | 要求の `acr_values`（`claims` の essential を含む） | 要求の `max_age` | セッションの `acr` | 最後の MFA からの時間 | ユーザーの要素 | 結果 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | なし | なし | 何でも | — | — | 方針（`mode`）どおり |
| 2 | `aal2` | なし | `aal2` | 24 時間以内 | — | そのまま発行 |
| 3 | `aal2` | なし | `aal2` | 24 時間超 | あり | 2 つ目の要素を求める |
| 4 | `aal2` | なし | `aal1` | — | あり | 2 つ目の要素を求める（メールの OTP は出さない） |
| 5 | `aal2` | なし | `aal1` | — | なし | 登録へ（方針で登録を許すとき）。許さないなら、essential なら `unmet_authentication_requirements`、そうでなければ `acr=aal1` で発行 |
| 6 | `aal2-pr` | なし | `aal2` | — | WebAuthn あり | WebAuthn を求める |
| 7 | `aal2-pr` | なし | `aal2` | — | WebAuthn なし | 6 の登録か、5 と同じエラー |
| 8 | 何でも | 300 | 何でも | — | — | `auth_time` から 300 秒を超えていたら、第 1 の要素から再認証 |
| 9 | PAPE の multi-factor | なし | `aal1` | — | あり | 4 と同じ |

- エラーの `unmet_authentication_requirements` は、OpenID Connect Core Error Code unmet_authentication_requirements 1.0（Final）で定義されている。`acr` を essential の請求で求められ、満たせないときに使う（SHALL）（[仕様](https://openid.net/specs/openid-connect-unmet-authentication-requirements-1_0.html)、2026-09-27 に確認）。
- API の step-up：アクセストークンに `acr` と `auth_time` を載せる（RFC 9470 が勧める）。テナントの API は、足りなければ `WWW-Authenticate: Bearer error="insufficient_user_authentication", acr_values="…", max_age=…` を返す。アプリはその値で `/authorize` をやり直す。本システムは、この流れをサンプルと文書で示す。
- API ごとに「このスコープには AAL2 が要る」を設定で持つ（`resource_servers.scope_acr`）。要求のスコープにその設定があれば、表の行 4 と同じに扱う。本家は Actions で行う。本システムは MVP で拡張がないので、設定で持つ。

## 7. 試行の上限とロック

| 対象 | 数え方 | 上限 | 超えたとき |
| --- | --- | --- | --- |
| TOTP・リカバリーコード・WebAuthn（2 つ目の要素） | 認証器ごとの連続の失敗 | 10 回 | 認証器を `locked` にし、15 分後に自動で戻す。戻すたびに次の期間を倍にする（最大 24 時間） |
| 同じ認証器の通算の連続の失敗 | 成功で 0 に戻る | 100 回 | `disabled`。管理者の再設定まで使えない（NIST SP 800-63B-4 の 100 回以下） |
| メールの OTP | チャレンジごと | 5 回 | そのチャレンジを使えなくする。再送の上限は 5.3 |
| MFA の画面全体 | ユーザー × IP | ブルートフォースの防御の値（[attack-protection.md](attack-protection.md)） | ユーザー × IP のブロック |

- 失敗の数は `authenticators.failure_count` に書く（writer）。Valkey の数だけに頼らない。ロックは安全に関わるので、Valkey を失っても続く必要がある。
- ロックやブロックが起きたら、ユーザーに通知のメールを送る。ロックの有無は、第 1 の要素を通った後にだけ画面に出す。

## 8. 管理と回復

- 管理者（Management API）：ユーザーの認証器の一覧（種類・名前・登録日・最終使用日。秘密は出さない）、1 つの削除、全部の削除（MFA の再設定）、`disabled` の解除、登録のチケットの発行。
- **MFA の再設定はアカウントの乗っ取りの典型の入り口である。** ダッシュボードでは、再設定の前に理由の入力を求め、監査ログに残し、ユーザーにメールで通知する。本人確認の手順は、テナントの責任として runbook の雛形を示す。
- 本人の回復：リカバリーコード → 他の登録済みの要素 → テナントの窓口。パスワードの再設定のメールだけで MFA を外せるようにはしない（メールの受信箱を取られた攻撃者に MFA を外させない）。
- ユーザーが要素をすべて失い、テナントの方針が `always` なら、次のログインで登録からやり直す。この状態は管理者の再設定でだけ起こる。

### 8.1 MFA の API（埋め込み・ネイティブ向け。MVP の後）

本家は、アプリが画面を自分で持って MFA を行うための API（`/mfa/challenge`、`/mfa/associate`、`/mfa/authenticators`）と、MFA のグラント（`mfa-otp`・`mfa-oob`・`mfa-recovery-code`）を持つ（[authentication-flows.md](authentication-flows.md) の 2 節の discovery の表）。多くは ROPG の上で使われる。

- **MVP では持たない。** MVP の MFA は Universal Login の画面（`/u/mfa/*`）だけで行う。ROPG を持たず（intent の Non-goals）、埋め込み型のログインも提供しないため、アプリが MFA のコードを直接受け渡す経路が要らない。discovery と `grant_types_supported` にも載せない。
- **MVP の後に扱うときの形**（需要が出たら、別の ADR で決める）：
  - 対象は、ネイティブのアプリが既に Universal Login でログインしたユーザーの step-up や、要素の管理（アカウントの画面の API）に限る。ROPG の上の MFA は作らない。
  - `mfa_token` は Universal Login のトランザクション（[ADR-0011](../decisions/0011-universal-login-rendering-and-transaction.md)）に結び付けた 1 回限りの値（有効 5 分、SHA-256 で保存）にし、7 節の試行の上限と、[attack-protection.md](attack-protection.md) の段 3 の数を画面と同じに通す。
  - エンドポイントは `/mfa/challenge` などの一般の名前をそのまま使う（本家の名前を含まない）。
  - メールの OTP の補助の制約（5.3 節）と、`acr` の規則（6 節）を画面と同じにする。
- 置き場所：[roadmap.md](../roadmap.md) の「後回し」に置いた。

## 9. 障害時の振る舞い

| 事象 | 振る舞い |
| --- | --- |
| メールの送信事業者の障害 | メールの OTP を選んだユーザーには他の要素を案内する。メールの OTP しか使えないユーザーはいない（5.3 の制約）。ただし、要素を失ったユーザーの回復が遅れる |
| Aurora の writer のフェイルオーバー | TOTP の `last_used_step`、リカバリーコードの `used_at`、チャレンジの消費が書けないので、MFA は 503 にする（1 回限りを保証できないまま通さない） |
| KMS の障害 | TOTP の種の復号は、データキーのキャッシュがあれば続く。キャッシュがなければ TOTP は 503、WebAuthn は続く（公開鍵は暗号化しない） |
| 時計のずれ（サーバー） | Fargate のタスクの時刻は Amazon Time Sync に頼る。±30 秒の窓を超えるずれは起きない前提で、時刻のずれの指標を監視する |
| 時計のずれ（利用者の端末） | ±30 秒を超えると TOTP が通らない。画面で端末の時刻の確認を案内する。窓は広げない |
| WebAuthn のブラウザの非対応 | パスワードと TOTP に回す。条件付きの UI の非対応はボタンに回す |
| RP ID の不一致（カスタムドメインの変更） | 5.2.1 の Related Origin Requests。非対応ならパスワード＋再登録 |
| 同じ TOTP のコードの並行の 2 要求 | `last_used_step` の条件付きの更新（`WHERE last_used_step < $step`）で 1 つだけ通す |

## 10. セキュリティとプライバシー

- TOTP の種、メールの OTP、リカバリーコードは、ログ・トレース・エラーの本文に出さない（[AGENTS.md](../../AGENTS.md)）。
- WebAuthn の公開鍵は秘密でないが、`credential_id` と AAGUID は端末の追跡に使いうる。ログには `authenticator_id` だけを出す。
- アテステーションは既定で `none`。端末の型番を集めない。
- MFA の画面は、ユーザーの登録済みの要素の種類を、第 1 の要素を通った後にだけ見せる。
- step-up の `acr` の判断は、ID トークンを受け取るアプリに委ねる。本システムは要求された `acr_values` を満たさない場合に、満たしたと偽らない（達成した値を返す）。
- `remember_device_days` の Cookie は、ユーザー・端末の乱数の ID・期限を含み、テナントの鍵で MAC を付ける。セッションを失効させても、この Cookie は残る。パスワードの変更と MFA の再設定で無効にする（世代の番号を持つ）。

## 11. テスト

### 11.1 決定表

- 6.1 の `amr`・AAL の表と、6.4 の step-up の表の各行を、Universal Login の結合テストにする。
- 下の登録の表を結合テストにする。

| # | 方針 `mode` | 有効な要素 | ユーザーの要素 | 期待 |
| --- | --- | --- | --- | --- |
| 1 | `never` | 何でも | なし | MFA なしで発行。`acr=aal1` |
| 2 | `always` | TOTP、メール | なし | 登録へ。選択肢は TOTP だけ（メールは出さない） |
| 3 | `always` | TOTP、メール | TOTP | TOTP を求める。「別の方法」でメールを出す |
| 4 | `always` | メールだけ | なし | テナントの設定の保存の時点で拒否される（メールだけの方針は作れない） |
| 5 | `always` | WebAuthn | パスキーでログイン、`passkey_satisfies_mfa=true` | 追加の MFA なし。`acr=aal2-pr` |
| 6 | `always` | WebAuthn、TOTP | パスキーでログイン、`passkey_satisfies_mfa=false` | パスキー以外の要素を求める |
| 7 | `always` | TOTP | TOTP（`locked`） | ロックの画面。リカバリーコードを案内 |

### 11.2 性質ベーステスト（fast-check）

- 任意の時刻の列と TOTP のコードの列で、同じ区間のコードは 2 回通らない。±1 区間の外のコードは通らない。
- 任意のリカバリーコードの使用の列で、各コードは高々 1 回通る。作り直しの後、古いコードはどれも通らない。
- 任意のログインの手段の列で、`acr` が `aal2` 以上のとき、`amr` はメールの OTP だけによる 2 つ目の要素を含まない（メールは AAL2 に寄与しない）。
- 任意の要素の組で、ユーザーが `email` の認証器だけを `active` に持つ状態に、どの操作の列でもならない（要素の削除で最後の独立した要素を外すと、`email` も外れる）。
- 任意の失敗の列で、1 つの認証器の連続の失敗が 100 回に達したら、以後は成功しない（`disabled`）。
- WebAuthn：任意に書き換えた `origin`・`rpIdHash`・チャレンジ・フラグで、検証が失敗する（否定側のテスト）。

### 11.3 E2E

- Playwright の仮想の認証器（CDP の WebAuthn のドメイン）で、パスキーの登録、条件付きの UI でのログイン、セキュリティキーの 2 つ目の要素、UV なしの拒否を確かめる。
- K8（[intent.md](../intent.md)）：Chrome・Safari・Edge・Firefox の最新 2 版と、iOS・Android の実機で、登録とログインを確かめる。実機は E7 の最後と、各ブラウザの大きな版の出荷の後に行う。

## 12. ADR

| ADR | 決定 | 状態 |
| --- | --- | --- |
| [0021](../decisions/0021-authenticator-model-and-assurance-levels.md) | 要素を認証器の共通の型で持ち、達成した AAL を `acr` で返す。メールの OTP は AAL2 に数えない | accepted |
| [0022](../decisions/0022-webauthn-and-passkeys.md) | WebAuthn は保守されたライブラリで検証し、RP ID をテナントで固定する。UV 付きのパスキーは単独で MFA を満たす | accepted |
| [0023](../decisions/0023-otp-and-recovery-codes.md) | TOTP は RFC 6238 の既定で再利用を拒む。リカバリーコードは Argon2id、メールの OTP は鍵付きハッシュで保存し、どちらも試行の上限で守る | accepted |

## 13. Story の候補

| Epic | Story の候補 |
| --- | --- |
| E1 | pepper の鍵で HMAC を計算する共通の部品（メールの OTP 用）と、ログの許可リストへの追加 |
| E3 | ID トークンとアクセストークンへの `amr`・`acr`・`auth_time`、discovery の `acr_values_supported` |
| E4 | パスワードの後のパスキーの促し（4.1） |
| E5 | セッションへの `acr`・要素ごとの認証の時刻の記録、SSO での `acr_values`・`max_age` の比較（6.3） |
| E7 | 認証器の表と状態機械、テナントの MFA の方針 |
| E7 | TOTP の登録と照合（再利用の拒否、±1 区間） |
| E7 | WebAuthn の 2 つ目の要素（セキュリティキー、プラットフォーム） |
| E7 | パスキーの登録とパスキー優先のログイン（条件付きの UI、ボタン、パスワードなしのサインアップ） |
| E7 | RP ID の固定と Related Origin Requests、Signal API |
| E7 | メールの OTP（補助の制約、再送の制限） |
| E7 | リカバリーコード（10 個の組、作り直し、通知） |
| E7 | step-up（6.4 の決定表、`resource_servers.scope_acr`、RFC 9470 のサンプル） |
| E7 | 試行の上限とロック（7 節） |
| E7 | 仮想の認証器の E2E と、実機の確認（K8） |
| E8 | MFA の画面をブルートフォースの防御の対象に含める |
| E9 | ダッシュボードの MFA の方針の画面、ユーザーの認証器の一覧・削除・再設定、登録のチケット |
| E10 | MFA のイベント（登録、削除、成功、失敗、ロック、再設定、sign_count の後退）のログ |
| MVP の後 | SMS（L4 の後）、AAL3（アテステーションと AAGUID の許可リスト）、リスクに応じた MFA（S2） |

## 14. 品質・運用・データへの引き継ぎ

- [quality.md](../quality.md) に入れる候補：
  - リスク：MFA の回避（MFA の画面を飛ばしてトークンが出る遷移、登録の直後の未確認の状態での発行）。Universal Login の遷移の全経路で「方針が MFA を求めるなら、MFA を済ませずに発行しない」を性質ベーステストにする。
  - WebAuthn の否定側のテスト一式（origin、RP ID、チャレンジの再利用、UV の欠落、BE の変化）。
  - K8 のブラウザ・OS の組み合わせの表と、実機の確認の頻度。
  - 本番での検証：MFA の成功率、要素ごとの失敗率、パスキーの登録率とパスキーでのログインの割合、ロックの件数。
- [runbooks/](../runbooks/README.md) に入れる候補：
  - エンドユーザーが要素をすべて失ったときの、テナントの管理者向けの再設定の手順と本人確認の雛形。
  - MFA の失敗率の急増（時計のずれ、ブラウザの更新による WebAuthn の不具合、メールの遅延）の切り分け。
  - `webauthn.sign_count_regression` の急増（複製の疑い。特定の AAGUID に偏るか）。
  - カスタムドメインの変更でパスキーが使えなくなったテナントへの対応（Related Origin Requests の設定の確認）。
- [data-model.md](data-model.md) の索引に入れる候補：`authenticators`、`totp_secrets`、`webauthn_credentials`、`recovery_codes`、`otp_challenges`、`authenticator_enrollment_tickets`、テナントの `mfa_policy` と `webauthn_rp_id`、`resource_servers.scope_acr`、`users.webauthn_user_handle`。

## 15. 未解決の問い

- AAL3 をいつ提供するか。アテステーションの検証（FIDO MDS の取り込み）の運用が要る。
- 同期するパスキーを受け入れない設定（BE=1 を拒否）を、テナントに提供するか。
- アカウントの画面（本人が要素を管理する画面）を、ホスト型でいつ提供するか。MVP は、登録はログインの途中と登録のチケット、削除は管理者だけ。
- `fed` の `amr` で、IdP が返した `amr`・`acr` を引き継ぐか（エンタープライズ接続で要る）。

### 決定（2026-09-27、既定案）

- **パスキーは単独で MFA を満たす**（`passkey_satisfies_mfa` の既定は真）。本家（既定で追加の MFA）と違う。NIST SP 800-63B-4 の扱いに合わせる。テナントは偽にできる。
- **メールの OTP は補助だけ、AAL1 のまま**。`amr` には `mfa` を入れる（本家と互換）。
- **リカバリーコードは 10 個の組、Argon2id で保存**。本家の 1 個の形（5.4 節。2026-09-27 に確認）とは違う。保存は NIST SP 800-63B-4 の 3.1.2.2 節に合わせる。
- **RP ID は最初にパスキーを有効にした時点のホスト名に固定**。変更は Related Origin Requests で補う。
- **`remember_device_days` の既定は無効**。AAL2 の要求では使わない。
- **API ごとの `acr` の要求は設定で持つ**（`resource_servers.scope_acr`）。拡張（E13）を待たない。
- **AAL3 は MVP で主張しない**。

### 決定（2026-09-27、推奨案で確定）

- **WebAuthn のサーバーのライブラリ**：`@simplewebauthn/server`。E7 の着手時に 5.2.3 節の基準で確かめ、満たさないときだけ見直す。
- **同期するパスキーを拒む設定（BE=1 の拒否）**：MVP では持たない。AAL3（S2 以降、アテステーションの検証と一緒）で扱う。
- **アカウントの画面（本人が要素を管理する画面）**：MVP の後（[roadmap.md](../roadmap.md) の「後回し」）。MVP は、登録はログインの途中と登録のチケット、削除は管理者だけ。
- **`fed` の `amr` で IdP の `amr`・`acr` を引き継ぐか**：既定で引き継がない。`amr` は `fed` だけにする。E14 で、接続ごとに IdP の値を信じる設定（既定は無効）を足す。

持ち越し：

| 項目 | いつ・どう決めるか |
| --- | --- |
| Related Origin Requests・Signal API・条件付きの作成のブラウザの対応 | E7 で、K8 の組み合わせで確かめる |
| 本家の TOTP・リカバリーコード・試行の上限の既定値 | E7 の着手前に試用のテナントで確かめる |
| SMS の送信事業者と SMS pumping の対策 | MVP の後の SMS の Epic（L4 の後） |

## References

- Auth0 Docs: [Multi-Factor Authentication Factors](https://auth0.com/docs/secure/multi-factor-authentication/multi-factor-authentication-factors)（2026-09-27 に確認）
- Auth0 Docs: [Passkeys](https://auth0.com/docs/authenticate/database-connections/passkeys)（2026-09-27 に確認）
- Auth0 Docs: [Step-up Authentication](https://auth0.com/docs/secure/multi-factor-authentication/step-up-authentication)、[Configure Step-up Authentication for Web Apps](https://auth0.com/docs/secure/multi-factor-authentication/step-up-authentication/configure-step-up-authentication-for-web-apps)（2026-09-27 に確認）
- NIST: [SP 800-63B-4 Authentication and Authenticator Management](https://pages.nist.gov/800-63-4/sp800-63b.html)（2026-09-27 に確認）
- W3C: [Web Authentication Level 3](https://www.w3.org/TR/webauthn-3/)（2026-08-25 の W3C Recommendation。Signal API は 5.1.10 節、`getClientCapabilities` は 5.1.7 節、関連する origin は 5.11 節、`hints` は 5.8.8 節。2026-09-27 に確認）
- OpenID Foundation: [OpenID Connect Core Error Code unmet_authentication_requirements 1.0](https://openid.net/specs/openid-connect-unmet-authentication-requirements-1_0.html)
- FIDO Alliance: [Passkeys](https://fidoalliance.org/passkeys/)
- IETF: [RFC 6238 TOTP](https://www.rfc-editor.org/rfc/rfc6238)、[RFC 4226 HOTP](https://www.rfc-editor.org/rfc/rfc4226)、[RFC 8176 Authentication Method Reference Values](https://www.rfc-editor.org/rfc/rfc8176)、[RFC 9470 OAuth 2.0 Step Up Authentication Challenge Protocol](https://www.rfc-editor.org/rfc/rfc9470)

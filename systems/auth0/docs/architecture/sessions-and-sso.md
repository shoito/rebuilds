# Sessions and SSO: Auth0

エンドユーザーのセッション（Cookie、有効期間、端末）、テナントの中の SSO、ログアウト（RP-Initiated Logout、Back-Channel Logout）、セッションとリフレッシュトークンの系列の関係の設計。トークンは [authentication-flows.md](authentication-flows.md)、署名は [keys-and-secrets.md](keys-and-secrets.md)、ログインの画面とトランザクションは universal-login の領域の [ADR-0011](../decisions/0011-universal-login-rendering-and-transaction.md) にある。

本家 Auth0 の振る舞いは、2026-09-27 に auth0.com/docs で確かめた。標準の記述は、各仕様の本文による。確かめられなかったものは「未検証」と書く。この文書の決定表は設計の草案で、要件 ID は E5 の各変更の `spec.md` に移すときに振る。

## 1. 目的と範囲

- 利用者が 1 回ログインすれば、同じテナントの他のアプリにもログインの画面なしで入れる（SSO）。
- ログアウトしたセッションでは、SSO でログインできない。Back-Channel Logout を登録したアプリには、ログアウトを知らせる（[intent.md](../intent.md) の守るべき振る舞い）。
- セッションとリフレッシュトークンのどちらが、どちらを止めるかを決める。

範囲に入れないもの：ダッシュボードの管理者のセッション（dashboard.md）、MFA の要素と `amr`・`acr` の値（mfa-and-passkeys.md）、ログインの画面（universal-login.md）、攻撃の防御の端末の識別の Cookie（attack-protection.md）。

## 2. 本家の形（確かめたこと）

| 項目 | 本家 | 出典（2026-09-27 に確認） |
| --- | --- | --- |
| セッションの有効期間 | 「使われない期間（Inactivity timeout）」と「最終の期限（Require log in after）」の 2 つ。上限は、Enterprise 以外で 3 日・30 日、Enterprise で 100 日・365 日 | [Session Lifetime Limits](https://auth0.com/docs/manage-users/sessions/session-lifetime-limits)、[Tenant Settings](https://auth0.com/docs/get-started/tenant-settings) |
| 既定の値 | 使われない期間 72 時間（3 日）、最終の期限 168 時間（7 日）。非永続のセッションは 72 時間 | Management API の OpenAPI の `idle_session_lifetime`・`session_lifetime`・`ephemeral_session_lifetime` の `default` |
| 永続と非永続 | 永続のセッションは期限付きの Cookie、非永続は `Expires=0` の Cookie（ブラウザを閉じると消える。ブラウザの実装に依る） | [Session Lifetime Limits](https://auth0.com/docs/manage-users/sessions/session-lifetime-limits) |
| 設定の単位 | テナント。ログインごとに Actions で変えられる。Management API の単位は時間 | [Configure Session Lifetime Settings](https://auth0.com/docs/manage-users/sessions/configure-session-lifetime-settings) |
| Cookie の名前 | セッションは `auth0` と、`SameSite=None` に対応しないブラウザ向けの `auth0_compat`。MFA の端末の信頼は `auth0-mf`、攻撃の防御の端末の識別は `did`（それぞれ `_compat` の予備あり） | [Authentication API Cookies](https://auth0.com/docs/manage-users/cookies/authentication-api-cookies) |
| RP-Initiated Logout | `/oidc/logout`。`id_token_hint`（推奨）、`logout_hint`（`sid`）、`post_logout_redirect_uri`、`client_id`、`state`、`ui_locales`、`federated` | [Log Users Out of Auth0](https://auth0.com/docs/authenticate/login/logout/log-users-out-of-auth0) |
| ログアウトの確認 | `id_token_hint`・`logout_hint` がないか、ブラウザのセッションと合わないとき、確認の画面を出す。テナントの設定で止められる | 同上 |
| ログアウト後の URL | 登録と完全に一致（クエリを含む）。サブドメインのワイルドカードを許す（本番では勧めない） | 同上 |
| Back-Channel Logout | Enterprise のプラン。ログアウトとセッションの取り消しで、非同期の待ち行列から送る。ログアウトトークンは `iss`・`aud`・`iat`・`exp`・`jti`・`sub`・`sid`・`events`。受け手は 200 を返す。再試行の回数は資料にない | [OIDC Back-Channel Logout](https://auth0.com/docs/authenticate/login/logout/back-channel-logout) |
| 受け手の検証の例 | 本家の例は、ログアウトトークンの古さの上限を 2 分にしている | 同上 |
| discovery | `backchannel_logout_supported`・`backchannel_logout_session_supported` が `true`。`end_session_endpoint` を載せるかはテナントの設定（`oidc_logout.rp_logout_end_session_endpoint_discovery`）。公開のテナント `samples.auth0.com` の discovery には載っていない | [Tenant Settings](https://auth0.com/docs/get-started/tenant-settings)、[Log Users Out of Auth0](https://auth0.com/docs/authenticate/login/logout/log-users-out-of-auth0)、`https://samples.auth0.com/.well-known/openid-configuration` |

標準（各仕様の本文による。2026-09-27 に [Back-Channel Logout 1.0](https://openid.net/specs/openid-connect-backchannel-1_0.html) と [RP-Initiated Logout 1.0](https://openid.net/specs/openid-connect-rpinitiated-1_0.html) で確認）：

- OIDC Back-Channel Logout 1.0：ログアウトトークンは `iss`・`aud`・`iat`・`exp`・`jti`・`events` を持ち、`sub` と `sid` の少なくとも一方を持つ。`nonce` を持ってはならない。ヘッダーの `typ` は `logout+jwt` を勧める。`exp` は短く、なるべく 2 分以内を勧める。受け手は成功で 200（204 も可）、失敗で 400 を返す。RP の登録の属性は `backchannel_logout_uri`・`backchannel_logout_session_required`。`offline_access` なしで出したリフレッシュトークンは、ログアウトで失効させるべき（SHOULD）で、`offline_access` 付きのものは通常は失効させない。
- OIDC RP-Initiated Logout 1.0：`end_session_endpoint` は GET と POST を受ける。`post_logout_redirect_uri` は事前に登録した値でなければならない。`post_logout_redirect_uri` が登録と完全に一致しなければリダイレクトしてはならない。`id_token_hint` は期限切れでも受けるべき。`id_token_hint` がないか不正なとき、OP は利用者にログアウトの意思を確かめなければならない（MUST）。`client_id` と `id_token_hint` の両方があれば、一致を確かめなければならない。
- OIDC Front-Channel Logout と Session Management（`check_session_iframe`）は、サードパーティの Cookie に頼る。主要なブラウザがサードパーティの Cookie を制限しているため、動かない場合が多い。

## 3. セッションのモデル

[ADR-0027](../decisions/0027-server-side-sessions.md)。

### 3.1 正本と Cookie

- **セッションはサーバーの側に持つ。** 正本は Aurora の `sessions`。Valkey は読み取りのキャッシュ（[ADR-0005](../decisions/0005-authentication-path-availability.md)）。
- **Cookie には不透明な値だけを入れる。** 256 ビットの乱数を base64url にしたもの。DB には SHA-256 だけを持つ（[ADR-0004](../decisions/0004-credential-storage.md)）。
- **`sid` と Cookie の値は別。** `sid` は ID トークン・ログアウトトークンに載る公開の値（128 ビットの乱数）。`sid` が漏れても、セッションは乗っ取れない。

| Cookie | 値 | 属性 |
| --- | --- | --- |
| `__Host-<brand>_session` | セッションの秘密 | `Secure`、`HttpOnly`、`SameSite=Lax`、`Path=/`、`Domain` なし。永続なら `Max-Age` = 最終の期限までの秒、非永続なら `Max-Age` なし |
| `__Host-<brand>_tx` | ログインのトランザクション | [ADR-0011](../decisions/0011-universal-login-rendering-and-transaction.md) |
| `__Host-<brand>_idp` | ソーシャル IdP への往復の間の `state` の HMAC | [universal-login.md](universal-login.md) の 4.1 節 |
| `__Host-<brand>_did` | 既知の端末（攻撃の防御） | [attack-protection.md](attack-protection.md) の 4.1 節 |
| `__Host-<brand>_mfa_rd` | MFA を省く端末（`remember_device_days`） | [mfa-and-passkeys.md](mfa-and-passkeys.md) の 3.3 節 |

- **本システムの Cookie は、すべて `__Host-` の接頭辞を付ける**（上の表がすべて）。`__Host-` の Cookie は `Secure`・`Path=/` が必須で、`Domain` を持てない（[MDN: Cookie prefixes](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie#cookie_prefixes)、2026-09-27 に確認）。ログイン・MFA・攻撃の防御の画面は、どれもテナントの 1 つのホスト名（標準のホスト名かカスタムドメイン）で動くので、ホストをまたぐ Cookie は要らない。標準のホスト名とカスタムドメインの間では、既知の端末・MFA の省略も別になる（受け入れる）。
- `__Host-` の接頭辞で、ホスト名に閉じた Cookie にする。テナントのホスト（`<tenant>.jp.<brand>.<domain>`）とカスタムドメインでは、別のセッションになる。SSO は、同じホスト名を使うアプリの間で効く（4 節）。
- `SameSite=Lax` にする。`/authorize` と `/oidc/logout` は、トップレベルの GET の遷移で来るので Cookie が送られる。本家は `SameSite=None` の Cookie を使う（`_compat` の Cookie は `SameSite=None` に対応しないブラウザ向けの予備。2 節）。`None` にしないのは、別サイトからの POST に Cookie を送らせないため。
- `SameSite=None` を要するのは、別サイトの iframe での `prompt=none` だけ。これはブラウザのサードパーティの Cookie の制限でどのみち動かない場合が多いので、あきらめる（4.3 節）。

### 3.2 `sessions` の中身

| 欄 | 中身 |
| --- | --- |
| `tenant_id`、`id` | UUIDv7 |
| `secret_hash` | Cookie の値の SHA-256。`(tenant_id, secret_hash)` で一意 |
| `sid` | 公開の値 |
| `host` | 作ったときのホスト名（テナントのホストかカスタムドメイン） |
| `user_pk` | ユーザー（`users.id`。外に出す `user_id` ではない。[data-model.md](data-model.md) の 2 節） |
| `connection_id` | ログインに使った接続 |
| `authenticated_at` | 最後に対話の認証をした時刻（ID トークンの `auth_time`） |
| `amr`、`acr`、`factor_auth_times` | 満たした要素、達成した `acr`、要素ごとの最後の認証の時刻（形は mfa-and-passkeys.md の求めに合わせる） |
| `persistent` | 永続か |
| `last_active_at` | 最後に使われた時刻（3.4 節） |
| `idle_expires_at`、`absolute_expires_at` | 期限 |
| `ip`、`user_agent`、`country` | 作ったときの値。一覧の表示と監査のため |
| `ended_at`、`end_reason` | 終わった時刻と理由（`logout`・`revoked`・`user_blocked`・`user_deleted`・`superseded`・`refresh_reuse`・`password_changed`） |

`session_clients`（セッション × アプリ）に、そのセッションでトークンを出したアプリを持つ。Back-Channel Logout の送り先を決めるため。

### 3.3 状態

```
            ログイン成功
   (なし) ─────────────▶ active ──┬─ 使われない期間を過ぎた ─▶ expired
                          │  ▲    └─ 最終の期限を過ぎた ────▶ expired
      MFA・再認証の成功    │  │
      （秘密を作り直す）───┘  │
                          │
                          └─ ログアウト・取り消し・ユーザーのブロック／削除・
                             別の利用者でのログイン・再利用の検知 ─▶ ended
```

- `expired` と `ended` は終わりの状態で、`active` に戻らない。
- `expired` は、読んだときに期限と比べて判定する（行を書き換える処理を待たない）。日次のジョブで行を消す（保持は 5 節）。
- **認証の段階が変わるたびに、Cookie の秘密を作り直す。** ログインの成功、MFA の成功、`max_age`・`prompt=login` による再認証の成功で、新しい秘密を出し、古い秘密のハッシュを消す（セッションの固定の防御）。`sid` は同じ利用者の間は変えない（アプリの側の照合を保つ）。
- **1 つのブラウザ × 1 つのホストに、セッションは 1 つ。** 別の利用者でログインしたら、前のセッションを `superseded` で終える（Back-Channel Logout を送る）。

### 3.4 有効期間

| 項目 | 既定 | 範囲 | 本家 |
| --- | --- | --- | --- |
| 使われない期間 | 3 日（4,320 分） | 5 分〜100 日 | 上限 3 日（Enterprise 以外）・100 日（Enterprise）。既定 3 日（2 節） |
| 最終の期限 | 7 日（10,080 分） | 使われない期間〜365 日 | 上限 30 日・365 日。既定 7 日（2 節） |
| 永続 | 永続 | 永続・非永続 | 両方ある |

- 設定の単位はテナント。アプリごとの上書きは MVP では持たない（本家は Actions で行う。extensibility.md の後）。
- 範囲の上限は、本家の Enterprise の値に合わせる。プランによる差は、この領域では作らない（料金の設計で決める）。
- **「使われた」とは、`/authorize` で SSO に使われたこと、または結び付いたリフレッシュトークンの系列が使われたこと（[ADR-0029](../decisions/0029-refresh-token-session-binding.md)）。** 最終の期限は延びない。
- `last_active_at` の書き込みは、前回から「5 分」と「使われない期間の 10 分の 1」の短い方が過ぎたときだけ行う。書き込みの数を抑える。そのぶん、使われない期間の判定は最大 5 分早く切れうる。

### 3.5 置き場所と読み方

- 読み：Valkey の `sess:{tenant_id}:{secret_hash}`（TTL 60 秒）→ なければ Aurora の reader → なければ writer。
- 終わらせる操作：Aurora の writer で `ended_at` を書き、同じトランザクションで outbox に `session.ended` を入れる。その後、Valkey のキーを消す。
- Valkey のキーを消せなかったとき（Valkey の障害の途中）、他のタスクがキャッシュを最大 60 秒読みうる。**終わったセッションで SSO が通る時間の上限は 60 秒。** Valkey が使えないタスクは DB を読むので、この窓はキャッシュが残ったまま Valkey に届くタスクだけに生じる。
- 1 ユーザーの `active` なセッションは 100 個まで。超えたら最も古いものを `superseded` で終える（本システムの決定。本家の上限は未検証）。

## 4. SSO

### 4.1 `/authorize` での判定

[authentication-flows.md](authentication-flows.md) の 5.4 節の 5 の中身。上から順に見る。

| # | 条件 | 結果 |
| --- | --- | --- |
| 1 | Cookie がない、セッションが見つからない、`expired`・`ended` | ログインの画面（`prompt=none` なら `login_required`） |
| 2 | セッションの `host` が要求のホストと違う | 1 と同じ（起こらないはずの状態。ログに残す） |
| 3 | ユーザーがブロック・削除されている | セッションを終え（`user_blocked`・`user_deleted`）、1 と同じ |
| 4 | `prompt=login` | 再認証（ログインの画面。識別子を入れた状態） |
| 5 | `max_age` があり、`now − authenticated_at > max_age` | 4 と同じ（`prompt=none` なら `login_required`） |
| 6 | `connection` の指定がセッションの接続と違う | 4 と同じ |
| 7 | そのアプリで、セッションの接続が有効でない | 4 と同じ |
| 8 | `acr_values` かアプリの MFA の方針を、セッションの `amr`・`acr` が満たさない | step-up（MFA の画面。`prompt=none` なら `interaction_required`） |
| 9 | 同意がない（第三者のアプリ） | 同意の画面（`prompt=none` なら `consent_required`） |
| 10 | それ以外 | 画面を出さずにコードを出す。`last_active_at` を更新（3.4 節）。`session_clients` に加える |

- `id_token_hint` があり、その `sub` がセッションの利用者と違うとき：`prompt=none` なら `login_required`。そうでなければ、ログインの画面（別の利用者に切り替える）。

### 4.2 ホストと SSO

- SSO は、同じホスト名で `/authorize` を呼ぶアプリの間でだけ効く。テナントのホストとカスタムドメインを混ぜると、利用者は 2 回ログインする。ダッシュボードで、カスタムドメインを持つテナントに「すべてのアプリでカスタムドメインを使う」ことを勧める。
- テナントをまたぐ SSO はない（[ADR-0002](../decisions/0002-tenancy-and-isolation.md)）。

### 4.3 サイレント認証とサードパーティの Cookie

- SPA が隠れた iframe で `prompt=none` を呼ぶ方式は、アプリと本システムのホストが別のサイト（登録可能なドメインが違う）なら、ブラウザの制限で Cookie が送られない。
- 同じサイト（アプリが `app.example.com`、カスタムドメインが `login.example.com`）なら、`SameSite=Lax` の Cookie も iframe に送られ、動く。
- SPA の SDK の既定は、リフレッシュトークンのローテーション（[authentication-flows.md](authentication-flows.md) の 7.2 節）にする。

## 5. セッションの一覧と取り消し

- Management API：ユーザーのセッションの一覧、1 つのセッションの取り消し、ユーザーのすべてのセッションの取り消し（「すべての端末からログアウト」）。形は management-api-and-rate-limiting.md。
- ユーザーのすべてのセッションの取り消しは、同じ操作で、そのユーザーのリフレッシュトークンの系列もすべて失効させるかを選べる（既定は失効させる）。
- 取り消しは Back-Channel Logout を送る（6.3 節）。
- 終わったセッションの行は、`ended_at`・期限から 30 日で消す（調査のため。保持の全体は security.md の [ADR-0055](../decisions/0055-data-retention-and-deletion.md) に合わせる）。

## 6. ログアウト

[ADR-0028](../decisions/0028-logout-rp-initiated-and-back-channel.md)。

### 6.1 RP-Initiated Logout（`/oidc/logout`）

| パラメーター | 扱い |
| --- | --- |
| `id_token_hint` | 推奨。自分のテナントの鍵（`previous` を含む）で署名を確かめる。期限切れでも受ける。`iss` がこのホスト。`aud` からアプリを決める |
| `logout_hint` | `sid` として扱う |
| `client_id` | `id_token_hint` の `aud` と違えば `invalid_request` |
| `post_logout_redirect_uri` | アプリの `allowed_logout_urls`（仕様の `post_logout_redirect_uris` に当たる。tenants-and-applications.md の 4.2 節）と完全に一致すること。アプリを決められないときは使わない |
| `state` | リダイレクトにそのまま付ける |
| `ui_locales` | 画面の言語 |
| `federated` | MVP では受けて無視する（ソーシャル IdP からのログアウトはしない）。ログに残す |

判定（上から順に）：

| # | 状況 | 結果 |
| --- | --- | --- |
| 1 | `id_token_hint` の署名・`iss` が不正 | エラーの画面。リダイレクトしない |
| 2 | `post_logout_redirect_uri` があるが、アプリを決められない（`id_token_hint`・`client_id` がない） | エラーの画面 |
| 3 | `post_logout_redirect_uri` が登録と一致しない | エラーの画面 |
| 4 | `id_token_hint`・`logout_hint` がない、またはブラウザのセッションの `sid`・`sub` と合わない | 確認の画面（`/u/logout`）。「ログアウトする」を押したらブラウザのセッションを終える |
| 5 | ブラウザのセッションがあり、ヒントと合う | 確認なしで終える |
| 6 | ブラウザのセッションがない | 何も終えない。7 へ |
| 7 | 終えた後（または 6） | `post_logout_redirect_uri` があれば `state` を付けてリダイレクト。なければ本システムの「ログアウトしました」の画面 |

- 確認の画面を止める設定は持たない。本家は止められる。RP-Initiated Logout 1.0 は、`id_token_hint` がないか不正なときの確認を MUST にしている。ログアウトの CSRF（他人のページから利用者を強制的にログアウトさせる）も既定で防げる。
- ヒントの `sid` のセッションが別のブラウザにあっても、終えない。終えるのは、要求を送ったブラウザのセッションだけ（`id_token_hint` を持つ人が他のブラウザのセッションを終えられないようにする）。アプリの側から特定のセッションを終えたいときは、Management API のセッションの取り消しを使う。
- `allowed_logout_urls` の登録の規則は、`redirect_uri` と同じ（ワイルドカードなし。[ADR-0006](../decisions/0006-authorization-code-pkce-and-exact-redirect.md)）。本家はワイルドカードを許す。
- GET と POST（`application/x-www-form-urlencoded`）の両方を受ける。
- 終える処理：`sessions.ended_at` を書き、結び付いたリフレッシュトークンの系列を失効させ（7 節）、outbox に `session.ended` を入れる。1 つのトランザクションで行う。その後に Cookie を消す（`Max-Age=0`）。
- Aurora の writer に書けないとき：Cookie を消さずに、再試行を促すエラーの画面を出す。Cookie だけを消すと、サーバーのセッションと Back-Channel Logout が残ったままになるため。

### 6.2 Back-Channel Logout

```
Auth（ログアウト）          outbox → Relay → SQS          Worker                    Auth（内部 API）  Signer    RP
  │ sessions.ended_at、session.ended ─▶│
  │                                      │──────────────▶│ session_clients から、
  │                                      │               │ backchannel_logout_uri のあるアプリを選ぶ
  │                                      │               │ アプリごとに 1 つの配送の行を作る
  │                                      │               │──── ログアウトトークンを求める ─▶│──署名─▶│
  │                                      │               │◀─────────────── logout+jwt ──────│◀──────│
  │                                      │               │── POST logout_token=... ─────────────────────────▶│
  │                                      │               │◀───────────────────────────────── 200 / 400 / 5xx ─│
```

ログアウトトークン：

```json
// header
{ "alg": "RS256", "kid": "<tenant の current>", "typ": "logout+jwt" }
// payload
{
  "iss": "https://<session の host>/",
  "aud": "<client_id>",
  "iat": 1790000000,
  "exp": 1790000120,
  "jti": "<128 ビットの乱数>",
  "sub": "<user_id>",
  "sid": "<sid>",
  "events": { "http://schemas.openid.net/event/backchannel-logout": {} }
}
```

- `sub` と `sid` を常に両方入れる（アプリの `backchannel_logout_session_required` によらない）。`nonce` を入れない。
- `exp` は `iat` の 120 秒後。本家の例（受け手の古さの上限 2 分）に合わせる。
- **再試行のたびに、新しいトークン（新しい `jti`・`iat`）を作る。** 古いトークンを送り直すと、受け手の古さの検査で落ちる。
- **Worker は Signer を直接呼ばない。** Signer は Auth のタスクからの要求だけを受ける（[ADR-0059](../decisions/0059-signer-isolation.md)）。Worker は、Auth の内部の API（相互 TLS）にログアウトトークンを求める。内部の API は、セッションが本当に `ended` で、そのアプリが `session_clients` にあるときだけトークンを作る。Worker が乗っ取られても、生きたセッションのログアウトトークンは作れない。

送り方：

| 項目 | 値 |
| --- | --- |
| 形 | `POST`、`Content-Type: application/x-www-form-urlencoded`、本文 `logout_token=<JWT>` |
| タイムアウト | 接続 2 秒、全体 5 秒 |
| 成功 | 200 と 204（仕様どおり）。他の 2xx も成功として扱う |
| 再試行しない | 400（受け手がトークンを拒否した）、その他の 4xx |
| 再試行する | 接続の失敗、タイムアウト、429、5xx |
| 再試行の間隔 | 10 秒、60 秒、5 分、30 分（4 回。最初から約 36 分で諦める） |
| リダイレクト | 追わない（3xx は失敗として再試行しない） |
| 諦めたとき | ログに `oidc_backchannel_logout_failed`（種類のコードは [logs-and-streams.md](logs-and-streams.md) の 3.2 節）。テナントのダッシュボードに、アプリごとの失敗の数を出す |
| 並行の上限 | テナントごとに同時 50 件（大量の取り消しで RP を溢れさせない。値は E5 で見直す） |

- 本家の再試行の回数と間隔は、資料になかった（未検証）。
- 順序は保証しない。同じセッション × アプリに 2 回届くことがある（少なくとも 1 回）。受け手は `jti` か `sid` で重複を除く。

`backchannel_logout_uri` の登録の規則（tenants-and-applications.md で検査する）：

- `https` だけ。IP アドレスのリテラル、`localhost`、フラグメントを許さない。
- 送るときに名前を解決し、私的なアドレス（RFC 1918、ループバック、リンクローカル、ULA、AWS のメタデータのアドレス）なら送らない（SSRF の防御）。解決と接続を同じアドレスで行う（DNS の再バインドの防御）。
- Worker から外への送信は、専用の出口を通す。出口は egress のサブネットの `worker-egress` と専用の NAT（[infrastructure.md](infrastructure.md) の 2.3 節）。

### 6.3 Back-Channel Logout を送るとき

| 事象 | 送る | 備考 |
| --- | --- | --- |
| RP-Initiated Logout | 送る | ログアウトを始めたアプリにも送る |
| `/u/logout` の確認でのログアウト | 送る | |
| Management API のセッションの取り消し | 送る | 本家と同じ |
| ユーザーのブロック・削除 | 送る | |
| 別の利用者でのログイン（`superseded`） | 送る | |
| パスワードの変更・再設定で他のセッションを終える | 送る | 既定で終える（[connections.md](connections.md) の 4.7 節と 13 節） |
| 結び付いた系列のリフレッシュトークンの再利用の検知 | 送る | [ADR-0029](../decisions/0029-refresh-token-session-binding.md) |
| 使われない期間・最終の期限の経過 | 送らない | 本家も、ログアウトと取り消しのときに送るとしている。期限の経過は、アプリの側のセッションの期限で扱う |
| 上限（100 個）を超えて古いセッションを終えた | 送る | |

### 6.4 持たないもの

- Front-Channel Logout と Session Management（`check_session_iframe`）。サードパーティの Cookie に頼り、主要なブラウザで動かない場合が多い。discovery に載せず、適合試験の対象にしない。
- 本家の旧来のログアウトのエンドポイント（`/v2/logout` に相当）。

## 7. セッションとリフレッシュトークンの系列

[ADR-0029](../decisions/0029-refresh-token-session-binding.md)。

- リフレッシュトークンの系列に、出したときのセッション（`session_id`）と、結び付きの種類（`binding`）を持たせる。

| `binding` | 意味 | 既定のアプリ |
| --- | --- | --- |
| `session` | セッションが終わる（ログアウト、取り消し、期限）と、系列も使えなくなる。系列の利用はセッションの「使われた」に数える（3.4 節） | SPA、機密の Web アプリ |
| `independent` | セッションが終わっても、系列は使える。止まるのは、失効・再利用の検知・系列の期限・ユーザーのブロック／削除・「すべての端末からログアウト」のとき | Native、デバイスのフロー |

- アプリの設定で、既定を変えられる。
- `session` の系列の最終の期限は、セッションの最終の期限を超えない（系列を作るときに短い方にする）。
- `session` の系列のリフレッシュの要求では、セッションが `active` かを確かめる（Valkey のキャッシュか DB）。ログアウトの操作では、同じトランザクションで系列に `revoked_at` を書くので、キャッシュの窓（60 秒）の間も系列は止まる。
- `session` の系列で再利用を検知したら、系列の失効に加えて、セッションも `refresh_reuse` で終える。盗用なら、同じブラウザのセッションも疑わしいため。
- `independent` の系列には、Back-Channel Logout を送らない（そのアプリはオフラインのアクセスを続ける）。
- デバイスのフローの系列は、利用者のスマートフォンのセッションに結び付けない（[authentication-flows.md](authentication-flows.md) の 7.4 節）。
- OIDC Back-Channel Logout 1.0 の考え方（`offline_access` のない系列はログアウトで失効させる）に合わせるなら、`offline_access` の有無で分けることになる。本家も本システムも、リフレッシュトークンを出す条件に `offline_access` を求めるので、代わりにアプリの `binding` で分ける。

## 8. 障害のときの振る舞い

| 障害 | SSO | 新しいログイン | ログアウト | Back-Channel Logout |
| --- | --- | --- | --- | --- |
| Valkey | DB から読んで続く | 続く | 続く。キャッシュを消せないタスクがあれば、最大 60 秒の窓（3.5 節） | 続く |
| Aurora の reader | writer から読む | 続く | 続く | 続く |
| Aurora の writer のフェイルオーバー | コードの発行に書き込みが要るので 503 | 503 | 再試行を促す画面。Cookie を消さない | outbox に入る前なら、ログアウトそのものが未完了（利用者が再試行） |
| SQS・Worker | 続く | 続く | 続く | 遅れる。outbox から回復後に送る |
| Signer | コードの発行は続く（署名は交換の時） | 同左 | 続く | ログアウトトークンを作れず、再試行の間隔で待つ |
| RP のエンドポイント | — | — | — | 再試行し、36 分で諦める |

失敗の形：

- **RP がログアウトを受け取れない**：36 分で諦める。利用者は、そのアプリにログインしたままになる。テナントのダッシュボードに失敗の数を出し、RP の側でセッションの期限を短くするよう勧める。
- **使われない期間の判定の早まり**：`last_active_at` の書き込みの間引きで、最大 5 分早く切れる（3.4 節）。
- **大量の取り消し**（多数のユーザーの削除、テナントの全セッションの取り消し）：Back-Channel Logout がテナントの並行の上限で詰まり、遅れる。Worker の待ち行列の深さを監視する。

## 9. セキュリティ

| 脅威 | 対応 |
| --- | --- |
| セッションの固定 | 認証の段階が変わるたびに秘密を作り直す（3.3 節）。`__Host-<brand>_tx` の結び付け（[ADR-0011](../decisions/0011-universal-login-rendering-and-transaction.md)） |
| Cookie の盗用 | `HttpOnly`・`Secure`・`__Host-`。DB にはハッシュだけ。セッションの一覧に IP・端末を出し、利用者と管理者が取り消せる |
| `sid` の漏えい | `sid` は Cookie の秘密と別。`sid` だけではセッションを使えない |
| ログアウトの CSRF | ヒントがない・合わないときは確認の画面。確認を止める設定を持たない |
| オープンリダイレクト | `post_logout_redirect_uri` は、アプリを決められたときの登録の値だけ |
| ログアウトトークンの偽造・流用 | テナントの鍵で署名、`typ: logout+jwt`、`aud` はアプリ、`exp` は 120 秒、`jti` は毎回新しい |
| SSRF | `backchannel_logout_uri` の登録と送信の時の検査、専用の出口 |
| Worker の乗っ取り | Worker は Signer を呼べない。内部の API は `ended` のセッションのトークンだけを作る |
| セッションの秘密の漏えい | ログ・トレースに Cookie の値・`secret_hash` を出さない（[AGENTS.md](../../AGENTS.md)）。ログに出すのは `sid` とセッションの `id` だけ |
| 個人データ | セッションの IP・端末は個人データ。保持は 5 節と [ADR-0055](../decisions/0055-data-retention-and-deletion.md) |

この領域の変更は `security:sensitive` のラベルを付ける。

## 10. テスト

### 10.1 決定表

- 4.1 節（SSO の判定）の各行を、`prompt` × `max_age` × `acr_values` × `connection` × セッションの状態の組で表駆動テストにする。
- 6.1 節（RP-Initiated Logout）の各行。
- 6.2 節の送り方の表（状態コード・タイムアウトごとの再試行の有無）。
- 6.3 節（送る事象）と 7 節（`binding` ごとの系列の扱い）。

### 10.2 性質ベーステスト

- 任意の操作の列（ログイン、SSO、MFA、ログアウト、取り消し、時間の経過）で、`ended`・`expired` のセッションが `active` に戻らない。
- 任意の操作の列で、`ended` のセッションの Cookie による `/authorize` は、キャッシュの窓（60 秒）の後はコードを出さない。
- 任意の操作の列で、`session` の系列は、結び付いたセッションが `active` でない間、リフレッシュに成功しない。
- 任意のログアウトで、`backchannel_logout_uri` を持ち `session_clients` にあるアプリには、少なくとも 1 回の送信の試行がある。
- 任意のログアウトトークンは、`nonce` を持たず、`sub` と `sid` を持ち、`events` に Back-Channel Logout の事象を持ち、`exp − iat = 120`。
- 認証の段階が変わった後、前の Cookie の秘密ではセッションを読めない。

### 10.3 適合試験

- OIDC RP-Initiated Logout OP と Back-Channel Logout OP のプロファイル（[authentication-flows.md](authentication-flows.md) の 13.3 節）。セッション・ログアウトを変える PR で回す（[ADR-0064](../decisions/0064-conformance-suite-in-ci.md)）。

### 10.4 結合・E2E

- Playwright：2 つのアプリで SSO が効き、1 つでログアウトすると、もう 1 つの Back-Channel Logout の受け手に届き、両方で SSO が効かなくなる。
- 障害の注入：Valkey の停止中のログアウトと SSO、Aurora の writer のフェイルオーバー中のログアウトの画面、RP が 500 を返すときの再試行の間隔。
- SSRF：私的なアドレスに解決される `backchannel_logout_uri` に送らない。

## 11. ADR

| ADR | 決定 |
| --- | --- |
| [0027](../decisions/0027-server-side-sessions.md) | セッションはサーバーの側に持ち、`__Host-` の Cookie には不透明な秘密だけを入れる。認証の段階が変わるたびに秘密を作り直す。既定は使われない期間 3 日・最終の期限 7 日 |
| [0028](../decisions/0028-logout-rp-initiated-and-back-channel.md) | ログアウトは RP-Initiated と Back-Channel を出し、Front-Channel と Session Management は出さない。Back-Channel は outbox から Worker が送り、再試行ごとにトークンを作り直す |
| [0029](../decisions/0029-refresh-token-session-binding.md) | リフレッシュトークンの系列は、アプリの設定でセッションに結び付けるか独立にするかを決める。既定はブラウザのアプリで結び付け、ネイティブとデバイスで独立 |

## 12. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E5 | `session-store-and-cookie` | `sessions`、`__Host-<brand>_session`、Valkey のキャッシュ、秘密の作り直し |
| E5 | `session-lifetimes` | 使われない期間・最終の期限・永続の設定と、`last_active_at` の間引き |
| E5 | `sso-decision` | 4.1 節の判定と `session_clients` |
| E5 | `rp-initiated-logout` | `/oidc/logout`、`/u/logout` の確認の画面、`allowed_logout_urls` の照合 |
| E5 | `backchannel-logout-delivery` | outbox、Worker、内部の API、再試行、SSRF の検査 |
| E5 | `refresh-session-binding` | 系列の `binding`、ログアウトでの失効、再利用の検知でのセッションの終了 |
| E5 | `session-management-api` | セッションの一覧・取り消し・すべての端末からのログアウト |
| E9 | `dashboard-user-sessions` | ユーザーの詳細の画面のセッションの一覧と取り消し、Back-Channel Logout の失敗の数 |
| E10 | `session-log-events` | `slo`・`flo`、`oidc_backchannel_logout_succeeded`・`oidc_backchannel_logout_failed` などのログのイベント（outbox の事象 `session.ended` から作る） |

## 13. 未解決の問い

### 決定（2026-09-27、既定案）

- **セッションの既定の有効期間**：使われない期間 3 日、最終の期限 7 日。本家の既定と同じ（Management API の OpenAPI の `default`。2 節）。
- **ログアウトの確認の画面を止める設定**：持たない（6.1 節）。
- **ヒントの `sid` の別のブラウザのセッション**：終えない（6.1 節）。
- **期限の経過での Back-Channel Logout**：送らない（6.3 節）。
- **Back-Channel Logout の再試行**：4 回、約 36 分（6.2 節）。
- **1 ユーザーの `active` なセッションの上限**：100 個。

### 決定（2026-09-27、推奨案で確定）

- **アプリごとのセッションの有効期間の上書き**：持たない。セッションはテナントに 1 つで、有効期間もテナントの設定だけにする。アプリごとに短くしたいときは、アプリの側のセッションと `max_age` で扱う。
- **`federated` のログアウト**：MVP では受けて無視する（6.1 節の表）。エンタープライズ接続の Epic（E14）で、SAML の SLO と合わせて扱う。ソーシャル IdP からのログアウトはしない。
- **パスワードの変更・再設定**：既定で、他のセッションとリフレッシュトークンの系列を終える。今のセッションは残す（[connections.md](connections.md) の 4.7 節）。
- **端末の記憶**：セッションと別の Cookie `__Host-<brand>_mfa_rd` で持つ（[mfa-and-passkeys.md](mfa-and-passkeys.md) の 3.3 節）。
- **Back-Channel Logout の出口**：egress のサブネットの `worker-egress` と専用の NAT（[infrastructure.md](infrastructure.md) の 2.3 節）。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| 本家の既定の有効期間、Cookie の名前と `SameSite`、Back-Channel Logout の再試行 | 本家の試用のテナントで確かめる（E5） |

## 14. quality.md・runbooks・data-model への項目

### quality.md

- SSO の成功率（`/authorize` のうち画面を出さずにコードを出した割合）と、`login_required` の内訳。
- ログアウトの完了の p99 と、writer の障害による未完了の数。
- Back-Channel Logout：最初の送信までの p95（目標 60 秒以内。NFR-010 に揃える）、成功率、諦めた数（テナント別）、待ち行列の深さ。
- 終わったセッションで SSO が通った件数（キャッシュの窓の実測。目標 0、上限 60 秒）。
- `refresh_reuse` でセッションを終えた数。

### runbooks

- `backchannel-logout-backlog.md`：Back-Channel Logout の待ち行列が詰まったときの確かめ方（RP の障害か、Worker か、Signer か）と、テナントへの連絡。
- `mass-session-revocation.md`：テナントかユーザーの全セッションを緊急に取り消す手順（アカウントの乗っ取りの疑い、テナントの依頼）。Back-Channel Logout の量の見積もり。
- `session-cache-inconsistency.md`：Valkey の障害の後に、終わったセッションのキャッシュが残っていないかを確かめる手順。

### data-model（索引への追加の提案）

| テーブル | 中身 |
| --- | --- |
| `sessions` | 3.2 節 |
| `session_clients` | `tenant_id`、`session_id`、`client_id`、`first_issued_at`、`last_issued_at` |
| `backchannel_logout_deliveries` | `tenant_id`、`id`、`session_id`、`client_id`、`attempts`、`next_attempt_at`、`last_status`、`last_error`（秘密を含めない）、`state`（`pending`・`delivered`・`failed`）、`created_at` |
| `refresh_token_families` の追加の欄 | `session_id`、`binding`。列の定義は [data-model.md](data-model.md) の 5.1 節にまとめた |
| `clients` の追加の欄 | `oidc_backchannel_logout`（`backchannel_logout_uri` を持つ）、`refresh_token` の中の `binding`（tenants-and-applications.md の `clients` の表に足す。`allowed_logout_urls` は同じ表にある） |
| `tenants` の追加の欄 | `session_idle_minutes`、`session_absolute_minutes`、`session_persistent` |

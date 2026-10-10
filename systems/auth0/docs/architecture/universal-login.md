# Universal Login: Auth0

ホスト型のログインの画面と画面の遷移、ログインのトランザクション、ブランディングと文言、日本語と英語、ブラウザでの防御（CSP、クリックジャッキング、CSRF）、規約への同意の記録、エラーの画面。

| 関連 | 決定 |
| --- | --- |
| [ADR-0011](../decisions/0011-universal-login-rendering-and-transaction.md) | 画面はサーバーで描く HTML。ログインの途中の状態は DB のトランザクションに持ち、URL の `state` と `__Host-<brand>_tx` の Cookie の両方で参照する。strict CSP と `frame-ancestors 'none'` |
| [ADR-0012](../decisions/0012-branding-and-templates.md) | ブランディングはテーマの変数と文言の上書きに限る。テナントの任意の HTML・JavaScript は入れない |
| [ADR-0013](../decisions/0013-consent-records.md) | 規約への同意は、文書のバージョンごとに追記だけの表に記録し、記録の成功をサインアップの完了の条件にする |
| [ADR-0005](../decisions/0005-authentication-path-availability.md) | 画面は認証の経路。静的な資産は CloudFront から配る |
| [ADR-0015](../decisions/0015-database-connection-password-and-enumeration.md) | 画面の文言と応答で、アカウントの有無を明かさない |

認可の要求の検証とトークンは [authentication-flows.md](authentication-flows.md)、接続（パスワード、ソーシャル）は [connections.md](connections.md)、MFA とパスキーの画面の中身は [mfa-and-passkeys.md](mfa-and-passkeys.md)、セッションの Cookie は [sessions-and-sso.md](sessions-and-sso.md)、ID のリンクの画面は [users-and-profiles.md](users-and-profiles.md) にある。

## 1. 目的と範囲

- 目的：アプリの開発者が、画面を作らずに、安全なログイン・サインアップ・再設定を使えるようにする。エンドユーザーには、日本語で、速く、どのブラウザでも同じに動く画面を出す。
- 範囲：`/u/*` の画面、ログインのトランザクション、画面の遷移、テーマと文言、言語の選び方、画面のセキュリティのヘッダーと CSRF の防御、規約への同意の記録、OAuth の同意の画面（記録の `grants` は authentication-flows の領域）、エラーの画面、アクセシビリティ。
- 範囲の外：埋め込み型のログインの部品、テナントが自分でホストする画面（[intent.md](../intent.md) の Non-goals）、ボットの検知の部品の選定（attack-protection の領域。この領域は差し込む場所だけを用意する）。

## 2. 本家の振る舞い（2026-09-27 に確認）

| 項目 | 本家 | 本システム |
| --- | --- | --- |
| 方式 | 新しい Universal Login（JavaScript を必須にしない）と Classic（更新されない）（[Universal Login vs. Classic Login](https://auth0.com/docs/authenticate/login/auth0-universal-login/universal-login-vs-classic-login)） | 新しい方式だけ。サーバーで描く |
| 画面のパス | `/u/login`、`/u/login/password`、`/u/signup`、`/u/reset-password/request`、`/u/consent`、`/u/mfa-*` など（[Cloudflare をリバースプロキシにする設定](https://auth0.com/docs/customize/custom-domains/self-managed-certificates/configure-cloudflare-for-use-as-reverse-proxy)） | 同じ形（3.1 節） |
| Identifier First | 選べる。メールアドレスのドメインでエンタープライズ接続へ振り分ける（[Identifier First](https://auth0.com/docs/authenticate/login/auth0-universal-login/identifier-first)） | 既定にする |
| クリックジャッキング | 新しい方式は常に `X-Frame-Options: deny` と `frame-ancestors 'none'`（[Clickjacking Protection](https://auth0.com/docs/troubleshoot/product-lifecycle/past-migrations/clickjacking-protection-for-universal-login)） | 同じ。例外なし |
| 見た目 | テーマ、文言の上書き、Liquid のページのテンプレート（カスタムドメインが必須）、partials（HTML・CSS・JavaScript）（[Page Templates](https://auth0.com/docs/customize/login-pages/universal-login/customize-templates)、[Customize Signup and Login Prompts](https://auth0.com/docs/customize/login-pages/universal-login/customize-signup-and-login-prompts)） | テーマと文言だけ（[ADR-0012](../decisions/0012-branding-and-templates.md)） |
| 言語 | 日本語を含む多数。テナントで有効にした言語の中から、`ui_locales`、`Accept-Language`、既定の言語の順に選ぶ（[Universal Login Internationalization](https://auth0.com/docs/customize/internationalization-and-localization/universal-login-internationalization)） | `ja`・`en` の 2 つで、同じ順序 |
| 規約への同意 | partials の入力欄（`ulp-` の接頭辞）で集め、メタデータに書く。専用の記録はない | 専用の記録（[ADR-0013](../decisions/0013-consent-records.md)） |
| サインアップの列挙 | 既存のメールアドレスで `email-in-use` を返す | 既定で明かさない（[ADR-0015](../decisions/0015-database-connection-password-and-enumeration.md)） |
| アクセシビリティ | WCAG 2.2 AA と EN 301 549 を掲げる（[Auth0 Universal Login](https://auth0.com/docs/authenticate/login/auth0-universal-login)） | WCAG 2.2 AA |
| エラーの画面 | 既定の画面か、テナントの URL・HTML に替えられる（[Custom Error Pages](https://auth0.com/docs/customize/login-pages/custom-error-pages)） | 既定の画面と、テナントの URL への転送（8 節） |
| トランザクションの有効期間 | 資料に記述なし（未検証） | 60 分 |

## 3. 画面と遷移

### 3.1 画面の一覧

| パス | 画面 | JavaScript |
| --- | --- | --- |
| `GET /u/login` | 識別子（メールアドレスかユーザー名）、ソーシャルのボタン、パスキーのボタン、サインアップ・再設定への導線 | パスキーのボタンだけ |
| `GET/POST /u/login/password` | パスワード | 不要 |
| `GET/POST /u/signup` | サインアップの識別子と、同意の欄（[ADR-0013](../decisions/0013-consent-records.md)） | 不要 |
| `GET/POST /u/signup/verify` | 確認のコード（verify-first。[ADR-0015](../decisions/0015-database-connection-password-and-enumeration.md)） | 不要 |
| `GET/POST /u/signup/password` | パスワードを決める | 不要（強さの表示だけ JavaScript で補う） |
| `GET/POST /u/reset-password/request` | 再設定の要求 | 不要 |
| `GET /u/reset-password/change?ticket=` → `/u/reset-password/change` | 新しいパスワード（トークンを URL から消した後の画面） | 不要 |
| `GET /u/email-verification?ticket=` | メールアドレスの確認のリンクの着地 | 不要 |
| `GET/POST /u/consent` | OAuth の同意（第三者のアプリ）と、規約の再同意 | 不要 |
| `/u/mfa/*` | MFA（[mfa-and-passkeys.md](mfa-and-passkeys.md)） | WebAuthn だけ |
| `GET/POST /u/link` | ID のリンクの提案（[users-and-profiles.md](users-and-profiles.md) の 5.2 節） | 不要 |
| `GET /u/error` | エラー（8 節） | 不要 |
| `GET /login/callback`・`POST /login/callback` | ソーシャル・エンタープライズの IdP からの戻り（[connections.md](connections.md)） | — |

- どの画面も、トランザクションの `state` がないか無効なら `/u/error`（`invalid_transaction`）へ送る。
- 資格情報を含む `POST` の後のリダイレクトは 303 にする（[security.md](security.md) の SEC-015）。

### 3.2 トランザクションのステートマシン

```
             /authorize の検証が通る
                    │
                    ▼
             ┌─────────────┐   識別子    ┌──────────────┐
             │ identifier  │────────────▶│ password     │─┐
             └─────┬───────┘             └──────────────┘ │ 照合の成功
       ソーシャル・ │  サインアップ                        │
       パスキー     ▼                                      ▼
             ┌─────────────┐  コード   ┌──────────────┐   ┌──────────────────┐
             │ signup      │──────────▶│ signup_verify│──▶│ first_factor_done │
             └─────────────┘           └──────────────┘   └────────┬─────────┘
                                                                     │
               ┌─────────────────────┬───────────────────────┬──────┴───────────┐
               ▼                     ▼                       ▼                  ▼
       ┌──────────────┐     ┌────────────────┐      ┌──────────────┐    （どれも不要）
       │ mfa_required │────▶│ link_proposed  │─────▶│ consent_req. │──────┐
       └──────────────┘     └────────────────┘      └──────────────┘      │
                                                                           ▼
                                                                  ┌────────────────┐
                                                                  │ completed      │ コードを発行して
                                                                  └────────────────┘ redirect_uri へ
  どの状態からも：60 分の経過 → expired、利用者の取り消し → aborted（access_denied で戻す）
```

| 遷移 | 条件 | 記録 |
| --- | --- | --- |
| → `first_factor_done` | パスワードの照合、ソーシャルの `VerifiedIdentity`、パスキーの検証のどれか | `amr` の候補、接続、`user_id` |
| → `mfa_required` | テナント・アプリの MFA の方針、`acr_values`、step-up（[mfa-and-passkeys.md](mfa-and-passkeys.md)） | — |
| → `link_proposed` | リンクの提案の表（[users-and-profiles.md](users-and-profiles.md) の 5.3 節） | — |
| → `consent_required` | 第三者のアプリで `grants` にないスコープ、`prompt=consent`、規約の新しいバージョンの再同意 | — |
| → `completed` | すべて済んだ | セッションを作る（[sessions-and-sso.md](sessions-and-sso.md)）。トランザクションを使用済みにする |

- 状態は `login_transactions.step` に持ち、画面の `POST` は、その状態で許された操作だけを受ける。許されない操作（例：`password` の状態で `mfa` の送信）は 409 にして、今の状態の画面へ送る。
- 同じトランザクションの `POST` は、行のバージョン（楽観ロック）で直列にする。2 つのタブからの同時の送信で、状態が飛ばない。

### 3.3 全体の流れ（パスワード、MFA なし）

```
ブラウザ                     Auth（/u/*）                          DB（writer）        Signer
  │ GET /authorize?...          │                                      │
  │────────────────────────────▶│ 検証（authentication-flows）          │
  │                             │ INSERT login_transactions ─────────▶│
  │◀─ 302 /u/login?state=<tx> ──│ Set-Cookie: __Host-<brand>_tx         │
  │ GET /u/login?state=<tx>     │ state と Cookie の照合                │
  │◀─ 200 識別子の画面（CSRF のトークン入り）                           │
  │ POST /u/login（識別子）      │ CSRF・Origin の検査                   │
  │◀─ 303 /u/login/password     │                                      │
  │ POST /u/login/password      │ 攻撃の防御の判定 → Argon2id           │
  │                             │ UPDATE step, INSERT session ───────▶│
  │                             │ コードの発行 ────────────────────────▶│
  │◀─ 303 redirect_uri?code=&state=&iss=（form_post なら自動送信の HTML）│
```

## 4. トランザクションの表

```sql
CREATE TABLE login_transactions (
  tenant_id        uuid        NOT NULL,
  id               uuid        NOT NULL,             -- UUIDv7, internal
  handle_hash      bytea       NOT NULL,             -- SHA-256 of the 256-bit value in ?state=
  hostname         text        NOT NULL,             -- resolved host (ADR-0039); links and issuer use it
  step             text        NOT NULL,             -- identifier | password | signup | ... | completed | expired | aborted
  version          integer     NOT NULL DEFAULT 0,   -- optimistic lock
  csrf_secret      bytea       NOT NULL,             -- per-transaction synchronizer token seed
  authz_request    jsonb       NOT NULL,             -- fields owned by authentication-flows (client_id, redirect_uri, ...)
  locale           text        NOT NULL,             -- 'ja' | 'en'
  connection_id    uuid,
  user_pk          uuid,
  amr              text[]      NOT NULL DEFAULT '{}',
  idp_state_hash   bytea,                            -- state sent to a social IdP (ADR-0016)
  idp_nonce_hash   bytea,
  webauthn_challenge bytea,                          -- 32 random bytes; cleared after verification
  failed_attempts  smallint    NOT NULL DEFAULT 0,   -- UI hint only; lockout counters live in attack-protection
  created_at       timestamptz NOT NULL,
  expires_at       timestamptz NOT NULL,             -- created_at + 60 min
  completed_at     timestamptz,
  PRIMARY KEY (tenant_id, id)
) PARTITION BY RANGE (id);                           -- daily UUIDv7 ranges (data-model.md 2.8)
CREATE INDEX ON login_transactions (tenant_id, handle_hash);  -- not UNIQUE: partitioned; 256-bit random
```

- **用語**（[authentication-flows.md](authentication-flows.md) の 5.4 節と同じ）：「ログインのトランザクション」はこの表の 1 行。「トランザクションの handle」は、その行を引く 256 ビットの乱数で、DB には `handle_hash` だけを持つ。handle は画面の URL の `state` のパラメーターで運び、文書の図では `<tx>` と書く（`/u/login?state=<tx>`）。アプリが `/authorize` に送った OAuth の `state` は別物で、`authz_request.state` に保存して最後に返す。この文書で「URL の `state`」と書くときは handle を指す。
- RLS を付ける。ただし `handle_hash` での引き当ては、ホスト名からテナントを決めた後に、そのテナントのコンテキストで行う。
- 失効した行（`expires_at` から 24 時間後）は、日ごとのパーティションの `DROP` で消す（2 日より古いもの。[data-model.md](data-model.md) の 2.8 節）。行は個人データ（`user_pk`、IP はここに持たない）を含むので、長く残さない。
- `authz_request` の欄と検証は authentication-flows の領域が持つ（[authentication-flows.md](authentication-flows.md) の 17 節）。

### 4.1 Cookie

| 名前 | 中身 | 属性 | 有効 |
| --- | --- | --- | --- |
| `__Host-<brand>_tx` | 最近のトランザクションの `handle` の集合（最大 5 件）を HMAC で署名したもの | `Secure`・`HttpOnly`・`SameSite=Lax`・`Path=/` | セッションの Cookie（ブラウザを閉じるまで） |
| `__Host-<brand>_idp` | IdP への往復の間だけ、IdP へ送った `state` の HMAC | `Secure`・`HttpOnly`・`SameSite=None`・`Path=/`（`__Host-` の接頭辞は `Path=/` を要する） | 10 分 |

- セッションの Cookie は [sessions-and-sso.md](sessions-and-sso.md) が持つ。

## 5. 画面の防御

### 5.1 ヘッダー

[ADR-0011](../decisions/0011-universal-login-rendering-and-transaction.md) のとおり。要点：

| ヘッダー | 値 | 根拠 |
| --- | --- | --- |
| `Content-Security-Policy` | nonce と `'strict-dynamic'` の `script-src`、`frame-ancestors 'none'`、`form-action` はトランザクションごとの許可、`base-uri 'none'`、`object-src 'none'` | [OWASP CSP Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Content_Security_Policy_Cheat_Sheet.html) |
| `X-Frame-Options` | `DENY` | 古いブラウザ向け（[OWASP Clickjacking Defense](https://cheatsheetseries.owasp.org/cheatsheets/Clickjacking_Defense_Cheat_Sheet.html)） |
| `Referrer-Policy` | `no-referrer` | URL の `state` とチケットの漏れ（[security.md](security.md) の SEC-021） |
| `Cache-Control` | `no-store` | 共有の端末での戻る操作 |
| `Cross-Origin-Opener-Policy` | `same-origin` | 別のウィンドウからの参照 |
| `Strict-Transport-Security` | エッジで付ける（[security.md](security.md) の SEC-024） | — |

- `report-to` で CSP の違反の報告を受け、テナントごとの件数をメトリクスにする（報告の本文は保存しない。URL にチケットが含まれうるため、パスだけを残す）。

### 5.2 CSRF

- 画面のフォームの `POST` は、同期トークン（`csrf_secret` から HMAC で作り、フォームごとに違う値）、`Origin` の一致、`Sec-Fetch-Site` が `same-origin` か `none` であることの 3 つを確かめる。
- SameSite の Cookie だけに頼らない。標準のホスト名 `<tenant>.jp.<brand>.<domain>` は、他のテナントと登録可能なドメインを共有するので same-site になる（[OWASP CSRF Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)）。Public Suffix List への登録は 17 節の決定（`jp.<brand>.<domain>` を登録する）。登録が反映されるまでの間も、下の防御だけで足りる形にする。
- ログイン CSRF（攻撃者のアカウントで被害者をログインさせる）：URL の `state` と Cookie の結び付けで防ぐ。

### 5.3 オープンリダイレクト

- 画面から外へ出る先は、次の 4 つだけ。どれも本システムが登録済みの値から作る。クエリの URL をそのまま使う経路はない（[OWASP Unvalidated Redirects](https://cheatsheetseries.owasp.org/cheatsheets/Unvalidated_Redirects_and_Forwards_Cheat_Sheet.html)）。
  1. アプリの `redirect_uri`（完全一致で検証済み。[ADR-0006](../decisions/0006-authorization-code-pkce-and-exact-redirect.md)）
  2. IdP の認可のエンドポイント（接続の設定）
  3. アプリの「ログインの開始の URL」（登録済み。再設定・確認の完了の後の戻り）
  4. テナントのエラーの画面の URL（登録済み。8 節）
- `returnTo` などの任意の URL のパラメーターは受け付けない。ログアウトの戻り先は sessions-and-sso の領域の規則（登録済みの URL）に従う。

### 5.4 その他

- 画面の値は、JSX の既定のエスケープで出す。`dangerouslySetInnerHTML` に相当するものを lint で禁止する。
- パスワードの欄は `autocomplete` を正しく付け、貼り付けを妨げない（[ADR-0015](../decisions/0015-database-connection-password-and-enumeration.md)）。
- ボットの検知の部品は、自前の PoW（[ADR-0026](../decisions/0026-bot-detection-and-challenge.md)）を決まった位置に差し込む。第三者のスクリプトを入れる場合は、CSP の許可、外部送信の公表（L2）、この表の更新を伴う。

## 6. ブランディングと文言

- テーマ：[ADR-0012](../decisions/0012-branding-and-templates.md)。`branding_themes`（テナントに 1 つ、アプリごとの上書き）。
- 文言：画面 × キー × 言語の既定の文言を、本システムのリポジトリに持つ（`ja`・`en`）。テナントの上書きは `branding_texts` に持つ。
  - 上書きの値は 1 つ 500 文字まで。平文として出す。変数は画面ごとの許可リストだけを展開する。
- 反映：テナントの設定のキャッシュ（[ADR-0005](../decisions/0005-authentication-path-availability.md)）に載せ、変更は最大 60 秒で反映する（許す古さは tenants-and-applications の領域の値に従う）。
- プレビュー：ダッシュボードから、保存前のテーマと文言で画面を描く `POST /api/v2/branding/preview`（管理の経路で描き、認証の経路を通さない）。

## 7. 言語

- 対応は `ja`・`en`。テナントは有効にする言語と既定の言語を選ぶ（既定は `ja`）。
- 選び方（本家と同じ順）：`ui_locales` の先頭から、有効な言語で最初に一致したもの → `Accept-Language` の q 値の順で有効な言語 → テナントの既定の言語。選んだ言語はトランザクションに保存し、途中で変えない（画面の言語の切り替えのリンクで明示的に変えたときを除く）。
- メールの言語は、トランザクションの言語か、ユーザーの `locale`（[email-delivery.md](email-delivery.md)）。
- 日本語の組版：書体は本システムが配る Noto Sans JP の部分集合（`font-display: swap`）。エラーの文言は、何が起きて、どうすればよいかの 2 文で書く。

## 8. エラーの画面

| 状況 | 画面 | アプリへ戻すか |
| --- | --- | --- |
| `redirect_uri` を信頼できない（未登録、`client_id` が不明） | `/u/error`（本システムの画面か、テナントのエラーの URL へ `error` と `tracking_id` だけを付けて 302） | 戻さない（[intent.md](../intent.md) の守るべき振る舞い） |
| トランザクションがない・期限切れ・使用済み | 「最初からやり直してください」とアプリへの導線（ログインの開始の URL） | ログインの開始の URL があればそこへ |
| 利用者の取り消し（同意の拒否など） | — | `error=access_denied` で `redirect_uri` へ |
| 内部の障害（DB の writer のフェイルオーバーなど） | 503 の画面、「数十秒後に再試行」、自動の再試行のボタン | 戻さない |

- エラーの画面に出す識別子は `tracking_id`（ログの検索に使う）だけ。内部のエラーの本文、スタックトレース、トランザクションの ID は出さない。

## 9. アクセシビリティ

- WCAG 2.2 AA を満たす。検査は、画面ごとの axe の自動検査（CI）と、スクリーンリーダー（VoiceOver、NVDA）での手動の確認（E4 の完了の条件）。
- 入力の誤りは、欄の近くに文字で出し、`aria-describedby` で結ぶ。ページのタイトルは画面ごとに違う文言にする。
- 2.5.8（ターゲットの大きさ）、3.3.8（認証のアクセシビリティ：パスワードの貼り付けと自動入力を妨げない、認知の試験を課さない）を満たす。ボットの検知の部品を入れるときも、3.3.8 を満たすものに限る。

## 10. 性能と可用性

| 項目 | 目標 |
| --- | --- |
| `/authorize` からログインの画面の表示 | p99 300ms 以内（NFR-002） |
| パスワードの送信から応答 | p99 500ms 以内（NFR-002。Argon2id を含む） |
| 画面の HTML の大きさ | 30 KB 以内（gzip） |
| 画面の JavaScript（パスキーの画面） | 20 KB 以内（gzip） |
| LCP（中位の Android、4G 相当） | p75 1.5 秒以内 |

- CSS・書体・ロゴは CloudFront から、バージョン付きの URL で配る。オリジンが落ちても配れる。
- DB の writer が使えない間（フェイルオーバー）は、トランザクションを作れないので、`/authorize` は 503 と `Retry-After` を返す（[ADR-0005](../decisions/0005-authentication-path-availability.md)）。

## 11. 障害時の振る舞い

| 障害 | 振る舞い |
| --- | --- |
| Aurora の writer のフェイルオーバー | 新しいログインは 503 の画面と再試行。途中のトランザクションは DB にあるので、回復後に続けられる |
| Valkey の停止 | 画面は影響なし（トランザクションを Valkey に置かない）。攻撃の防御の数はタスクの近似になる |
| テナントの設定を読めない | 最後のバージョンのテーマ・文言で描く |
| 資産の配信（CloudFront）の障害 | HTML に最小のインラインの CSS（nonce 付き）を持ち、ロゴなしでも操作できる |
| メールの送信の遅れ | サインアップの確認のコードの画面に「届かないときは再送」を 60 秒後に出す。再送の上限は 3 回 |
| ソーシャル IdP の障害 | その接続のボタンのエラーだけを出し、他の方法を案内する |

## 12. セキュリティのまとめ

| 脅威 | 対策 |
| --- | --- |
| フィッシング（偽のログインの画面） | カスタムドメイン、パスキー（オリジンに結び付く）。埋め込みを許さない |
| クリックジャッキング | `frame-ancestors 'none'`、`X-Frame-Options: DENY` |
| XSS | サーバーの描画とエスケープ、strict CSP、テナントの任意のコードを入れない |
| CSRF、ログイン CSRF | 同期トークン、`Origin`・`Sec-Fetch-Site`、`state` と Cookie の結び付け |
| セッションの固定 | トランザクションの完了でセッションの ID を作り直す（sessions-and-sso の領域） |
| アカウントの列挙 | 画面の文言・状態コード・時間をそろえる（[ADR-0015](../decisions/0015-database-connection-password-and-enumeration.md)） |
| オープンリダイレクト | 5.3 節の 4 つの行き先だけ |
| URL の `state`・チケットの漏れ | `Referrer-Policy: no-referrer`、チケットを URL から消すリダイレクト、Cookie との結び付け |
| 同意の偽装 | チェックボックスの検証をサーバーで行い、記録を追記だけにする（[ADR-0013](../decisions/0013-consent-records.md)） |

## 13. テスト

### 13.1 決定表：画面の `POST` の受け付け

| # | `state` | Cookie | CSRF のトークン | `Origin` | `Sec-Fetch-Site` | 状態で許された操作 | 期待 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 有効 | 一致 | 正 | 自分 | `same-origin` | はい | 処理する |
| 2 | 有効 | なし | 正 | 自分 | `same-origin` | はい | やり直しの画面（`invalid_transaction`） |
| 3 | 有効 | 別のトランザクション | 正 | 自分 | `same-origin` | はい | やり直しの画面 |
| 4 | 有効 | 一致 | なし・誤り | 自分 | `same-origin` | はい | 403 |
| 5 | 有効 | 一致 | 正 | 他 | `cross-site` | はい | 403 |
| 6 | 有効 | 一致 | 正 | 自分 | `same-origin` | いいえ | 409 と今の状態の画面 |
| 7 | 期限切れ | 一致 | 正 | 自分 | `same-origin` | — | やり直しの画面 |
| 8 | 使用済み | 一致 | 正 | 自分 | `same-origin` | — | やり直しの画面。コードは出ない |

### 13.2 決定表：言語

| # | `ui_locales` | `Accept-Language` | 有効な言語 | 既定 | 結果 |
| --- | --- | --- | --- | --- | --- |
| 1 | `en` | `ja` | `ja`,`en` | `ja` | `en` |
| 2 | `fr en` | `ja` | `ja`,`en` | `ja` | `en` |
| 3 | `fr` | `en;q=0.8, ja;q=0.9` | `ja`,`en` | `en` | `ja` |
| 4 | なし | `fr` | `ja`,`en` | `ja` | `ja` |
| 5 | `en` | `en` | `ja` | `ja` | `ja` |

### 13.3 性質ベーステスト（fast-check）

テスト名には要件 ID を含める（開発リポジトリで採番する）。

- 任意の画面の操作の列（戻る、2 つのタブ、同時の送信、期限の経過を含む）で：
  - 認可コードは、ステートマシンで `completed` に着いたトランザクションからだけ、1 回だけ出る。
  - `mfa_required` を通るべきトランザクションが、MFA を経ずに `completed` にならない。
- 任意のテーマ・文言の値（任意の Unicode、HTML、スクリプトの断片）で、描いた HTML を解析すると、本システムの nonce の付いた `<script>` 以外にスクリプトが実行されうる要素・属性がない。
- 任意の `ui_locales` と `Accept-Language` で、13.2 の参照の実装と結果が一致する。
- 任意の 2 テナントで、一方のホスト名で作った `state` を他方のホスト名で使っても進めない。

### 13.4 その他

- ルートの一覧から、すべての `/u/*` にヘッダー（5.1 節）が付くことを確かめるテストを自動で作る。
- E2E（Playwright）：Chrome・Safari（WebKit）・Firefox・Edge で、ログイン・サインアップ・再設定・ソーシャル（模擬の IdP）・`form_post` の戻りを通す。JavaScript を無効にした実行も持つ（パスキー以外）。
- `form-action` と POST の後のリダイレクトの、ブラウザごとの振る舞い（未検証）を E2E で確かめる。
- 列挙の時間の差の測定（[ADR-0015](../decisions/0015-database-connection-password-and-enumeration.md) の Confirmation）。

## 14. ADR

| ADR | 決定 | 状態 |
| --- | --- | --- |
| [0011](../decisions/0011-universal-login-rendering-and-transaction.md) | Universal Login はサーバーで描く HTML にし、ログインの途中の状態はサーバーのトランザクションに持って、ブラウザの Cookie に結び付ける | accepted |
| [0012](../decisions/0012-branding-and-templates.md) | ブランディングはテーマの変数と文言の上書きに限り、テナントの任意の HTML・JavaScript は画面に入れない | accepted |
| [0013](../decisions/0013-consent-records.md) | 規約への同意は、文書のバージョンごとに追記だけの表に記録し、記録の成功をサインアップの完了の条件にする | accepted |

## 15. Story の候補

| Epic | Story の候補 |
| --- | --- |
| E1 | 画面の骨格：Hono の JSX、nonce の CSP のミドルウェア、ヘッダーの一式、ルートの一覧からのヘッダーのテスト |
| E3 | `login_transactions` の表と、`/authorize` からの作成、`state` と Cookie の結び付け、ステートマシンの骨格（authentication-flows と一緒に） |
| E4 | 識別子・パスワードの画面（Identifier First）、CSRF の 3 つの検査、13.1 の決定表 |
| E4 | サインアップ（verify-first）・再設定・メールアドレスの確認の画面（connections と一緒に） |
| E4 | テーマと文言の上書き、`ja`・`en` の文言、言語の選び方（13.2） |
| E4 | 規約の文書の登録と同意の記録（[ADR-0013](../decisions/0013-consent-records.md)）。L8 の確認の後に承認 |
| E4 | エラーの画面、テナントのエラーの URL への転送 |
| E4 | アクセシビリティの自動検査と手動の確認 |
| E3 | OAuth の同意の画面（`grants` の記録は authentication-flows） |
| E6 | ソーシャルのボタンと `/login/callback`、`form_post` の補助の Cookie |
| E6 | ID のリンクの提案の画面（users-and-profiles と一緒に） |
| E7 | MFA・パスキーの画面の差し込み（mfa-and-passkeys と一緒に） |
| E8 | ボットの検知の部品の差し込み（方式が決まった後） |
| E9 | ダッシュボードのテーマ・文言の編集とプレビュー |
| E11 | カスタムドメインでの画面の表示（ホスト名ごとのトランザクションと Cookie） |
| E12 | 画面の性能の計測（LCP、HTML の大きさ）、CSP の違反の監視 |
| E14 | 組織ごとのブランドの上書き、組織の選択の画面 |

E2・E5・E10・E13 には、この領域の Story はない（E5 のログアウトの画面は sessions-and-sso、E10 のログは logs-and-streams が持つ）。

## 16. 品質・運用・データへの引き継ぎ

- [quality.md](../quality.md) に入れる候補：
  - リスク：画面の XSS とクリックジャッキング（上位のリスク）。13.3 の描画の性質ベーステストと、ヘッダーの自動テストを E4 のリリースの基準にする。
  - 13.1 の決定表を E4 の必須のテストにする。
  - E2E のブラウザの組み合わせ（Chrome、Safari、Firefox、Edge の最新 2 バージョン、iOS・Android）と、JavaScript を無効にした実行。
  - WCAG 2.2 AA の検査（自動と手動）を GA の基準にする。
  - 本番での検証：画面ごとの離脱の率、CSP の違反の件数、`invalid_transaction` の件数（急増はトランザクションの不具合か攻撃）を日次で見る。
- [runbooks/](../runbooks/README.md) に入れる候補：
  - CSP の違反の急増（リリースの誤りか攻撃か）の切り分けと、リリースの戻し。
  - `invalid_transaction` の急増（Cookie の属性の誤り、ブラウザの変更、エッジのキャッシュの誤り）の切り分け。
  - テナントのテーマ・文言の誤った変更で画面が使えないとの問い合わせ：テナントの設定のバージョンを戻す手順（監査ログから）。
  - 規約の新しいバージョンの発効で、再同意の画面が大量に出たときの案内。
- [data-model.md](data-model.md) の索引に入れる候補：`login_transactions`（この領域が持つ。欄の一部は authentication-flows）、`branding_themes`、`branding_texts`、`legal_documents`、`consent_records`。

## 17. 未解決の問い

- 規約への同意を誰の責任で、何を、どれだけの期間記録するか（[intent.md](../intent.md) の L8）。ユーザーの削除のときの同意の記録の扱い（L7）。
- 画面が外部に端末の情報を送る場合（ボットの検知）の公表の義務（L2）。
- `<brand>.<domain>` を Public Suffix List に登録して、テナントのホスト名を別の site にするか。Cookie と CSRF の境界は強くなるが、登録と反映に時間がかかり、取り消しも難しい。
- テナントの任意の HTML（[ADR-0012](../decisions/0012-branding-and-templates.md) の 2）をいつ入れるか。
- サインアップの追加の項目（氏名、電話番号など）の型と保存先（`user_metadata` か専用の欄か）。

### 決定（2026-09-27、既定案）

- **トランザクションの有効期間**：60 分。本家の値は未検証で、試用のテナントで確かめて近づける。
- **Identifier First**：既定で有効。識別子とパスワードを 1 画面で聞く形も選べる。
- **言語**：MVP は `ja`・`en`。テナントの既定は `ja`。
- **テンプレート**：テナントの任意の HTML・CSS・JavaScript は MVP で入れない（本家との違い）。
- **同意の方式の既定**：`checkbox`。`ip`・`user_agent` は記録する（L8 で変えうる）。
- **エラーの画面**：テナントのエラーの URL への転送は、`error` と `tracking_id` だけを付ける。本家は `client_id`・`connection`・`lang`・`error_description`・`tracking` を付ける（[Customize Error Pages](https://auth0.com/docs/customize/login-pages/custom-error-pages)、2026-09-27 に確認）が、本システムは `client_id` などを付けない（本家との違い。移行のテナントのエラーの画面が `client_id` を使っていれば直す必要がある）。
- **iframe**：どの設定でも許さない。

### 決定（2026-09-27、推奨案で確定）

- **Public Suffix List**：`jp.<brand>.<domain>` を登録し、テナントの標準のホスト名を互いに別の site にする。E11 で申請し、リージョンを足すときは同じ形で足す。CSRF と Cookie の防御は、登録に頼らない今の形（5.2 節、`__Host-` の Cookie）のまま保つ。
- **テナントの任意の HTML**：MVP では入れない。[ADR-0012](../decisions/0012-branding-and-templates.md) の 2（許可したタグだけのヘッダー・フッター）は、[roadmap.md](../roadmap.md) の「後回し」に置く。入れるときは別の ADR で決める。3（テンプレートと JavaScript）は採らない。
- **サインアップの追加の項目**：MVP の後に、型をテキスト・選択・チェックボックスの 3 つに限って足す。値は `user_metadata` に保存する（専用の欄を作らない）。
- **ボットの検知の部品**：自前の PoW（[ADR-0026](../decisions/0026-bot-detection-and-challenge.md)、[attack-protection.md](attack-protection.md) の 17 節）。第三者の CAPTCHA は法務の L2 の後。

持ち越し：

| 項目 | いつ・どう決めるか |
| --- | --- |
| `form-action` の POST の後のリダイレクトでの、ブラウザごとの実装 | E4 の E2E で確かめ、足りなければ `form-action` の値を広げる ADR の改訂を起票する |
| 画面の LCP の目標の妥当性 | E12 の計測 |

## References

- Auth0 Docs: [Universal Login vs. Classic Login](https://auth0.com/docs/authenticate/login/auth0-universal-login/universal-login-vs-classic-login)（2026-09-27 に確認）
- Auth0 Docs: [Auth0 Universal Login](https://auth0.com/docs/authenticate/login/auth0-universal-login)（アクセシビリティ。2026-09-27 に確認）
- Auth0 Docs: [Identifier First](https://auth0.com/docs/authenticate/login/auth0-universal-login/identifier-first)（2026-09-27 に確認）
- Auth0 Docs: [Clickjacking Protection for Universal Login](https://auth0.com/docs/troubleshoot/product-lifecycle/past-migrations/clickjacking-protection-for-universal-login)（2026-09-27 に確認）
- Auth0 Docs: [Customize Universal Login Page Templates](https://auth0.com/docs/customize/login-pages/universal-login/customize-templates)、[Customize Signup and Login Prompts](https://auth0.com/docs/customize/login-pages/universal-login/customize-signup-and-login-prompts)（2026-09-27 に確認）
- Auth0 Docs: [Universal Login Internationalization](https://auth0.com/docs/customize/internationalization-and-localization/universal-login-internationalization)（2026-09-27 に確認）
- Auth0 Docs: [Custom Error Pages](https://auth0.com/docs/customize/login-pages/custom-error-pages)（2026-09-27 に確認）
- OWASP: [Content Security Policy Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Content_Security_Policy_Cheat_Sheet.html)、[Clickjacking Defense Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Clickjacking_Defense_Cheat_Sheet.html)、[CSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)、[Unvalidated Redirects and Forwards Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Unvalidated_Redirects_and_Forwards_Cheat_Sheet.html)（2026-09-27 に確認）
- OWASP: [ASVS 5.0.0](https://github.com/OWASP/ASVS/releases)（2025-05-30 公開。V3 Web Frontend Security、V6 Authentication、V7 Session Management、V10 OAuth and OIDC を画面の検証の対照に使う。2026-09-27 に確認）
- W3C: [WCAG 2.2](https://www.w3.org/TR/WCAG22/)

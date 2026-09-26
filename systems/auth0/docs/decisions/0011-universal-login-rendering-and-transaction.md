---
status: accepted
date: 2026-09-27
---

# ADR-0011: Universal Login はサーバーで描く HTML にし、ログインの途中の状態はサーバーのトランザクションに持って、ブラウザの Cookie に結び付ける

## Context

Universal Login は、`/authorize` から始まるログインの画面の一式（識別子、パスワード、サインアップ、再設定、MFA、同意、エラー）である。ログイン・サインアップ・再設定の画面は、パスワードとセッションを扱うので、フィッシング・クリックジャッキング・CSRF・XSS・オープンリダイレクトの標的になる。

本家 Auth0 の振る舞い（2026-09-27 に確認）：

- 新しい Universal Login は、画面の表示に JavaScript を必須にしない。Classic Login は更新されていない（[Universal Login vs. Classic Login](https://auth0.com/docs/authenticate/login/auth0-universal-login/universal-login-vs-classic-login)）。
- 画面のパスは `/u/login`、`/u/login/password`、`/u/signup`、`/u/signup/password`、`/u/reset-password/request`、`/u/reset-password/change`、`/u/consent`、`/u/mfa-*` などである（[Configure Cloudflare for use as reverse proxy](https://auth0.com/docs/customize/custom-domains/self-managed-certificates/configure-cloudflare-for-use-as-reverse-proxy)）。ログインの途中の状態は、URL の `state` のパラメーターで参照される。
- 識別子を先に聞き、次に認証の方法を聞く Identifier First を選べる。メールアドレスのドメインでエンタープライズ接続へ振り分ける（Home Realm Discovery）（[Identifier First](https://auth0.com/docs/authenticate/login/auth0-universal-login/identifier-first)）。
- 新しい Universal Login は、常に `X-Frame-Options: deny` と `Content-Security-Policy: frame-ancestors 'none'` を返す。iframe での表示を許す設定は Classic にしかない（[Clickjacking Protection for Universal Login](https://auth0.com/docs/troubleshoot/product-lifecycle/past-migrations/clickjacking-protection-for-universal-login)）。
- ログインの途中の状態（トランザクション）の有効期間は、資料に記述がない（未検証）。

指針（2026-09-27 に確認）：

- OWASP は、nonce か hash による strict CSP を勧める（[Content Security Policy Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Content_Security_Policy_Cheat_Sheet.html)）。
- OWASP は、状態を持つアプリには同期トークン（synchronizer token）を勧め、SameSite の Cookie は多層の防御の 1 つにとどめるとする。SameSite は登録可能なドメインの単位なので、同じ親ドメインを共有するマルチテナントの SaaS では他のテナントが same-site になる（[CSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)）。

## Options

描き方：

1. **サーバーで HTML を組み立て（Hono の JSX）、フォームの POST で進める。JavaScript は WebAuthn と入力の補助だけ**
2. SPA（React など）を配り、JSON の API で進める
3. テナントが自分でホストする画面（埋め込みのログイン）を許す

ログインの途中の状態：

- a. **サーバーの DB にトランザクションとして持ち、URL の不透明な ID と、ブラウザの Cookie の両方で参照する**
- b. 暗号化した Cookie だけに持つ（サーバーに状態を持たない）
- c. Valkey だけに持つ

## Decision

1 と a を採用する。

### 描き方

- 画面はサーバーで描く。JavaScript がなくても、パスワードのログイン、サインアップ、再設定、TOTP が完了できる。パスキー（WebAuthn）は JavaScript を要する。
- 画面のパスは本家に寄せ、`/u/` の下に置く（`/u/login`、`/u/login/password`、`/u/signup`、`/u/reset-password/request`、`/u/reset-password/change`、`/u/email-verification`、`/u/consent`、`/u/mfa/*`、`/u/logout`、`/u/error`）。
- **Identifier First を既定にする。** 最初の画面は識別子（メールアドレスかユーザー名）と、有効なソーシャル接続・パスキーのボタンを出す。識別子の後に、パスワードの画面か、エンタープライズ接続（MVP の後）へ進む。パスワードと識別子を 1 画面で聞く形も、テナントが選べる。
- 3（埋め込み）は提供しない（[intent.md](../intent.md) の Non-goals）。

### トランザクション

- `/authorize` の検証（authentication-flows の領域）を通った要求ごとに、`login_transactions` の行を作る。ID は 256 ビットの乱数で、保存するのは SHA-256 の値だけ（[ADR-0004](0004-credential-storage.md)）。
- URL には `?state=<ID>` を載せる（本家の形に寄せる）。OAuth の `state`（アプリが送る値）とは別物で、アプリの `state` はトランザクションの中に保存して、最後に返す。
- 同時に、トランザクションの ID を束ねた `__Host-<brand>_tx` の Cookie（`Secure`・`HttpOnly`・`SameSite=Lax`・`Path=/`）を出す。**URL の `state` と Cookie の両方が合わないと、画面を進めない。** URL だけを他人に渡しても（ログイン CSRF、セッションの固定）続きを乗っ取れない。
- 画面の各フォームには、トランザクションに結び付けた同期トークン（CSRF のトークン）を hidden で入れ、POST のたびに定数時間で照合する。加えて `Origin` の検査（自分のホスト名と一致）と、`Sec-Fetch-Site` が `cross-site` の POST の拒否を行う。
- 有効期間：作成から 60 分で失効する（本家の値は未検証。本システムの決定）。完了（コードの発行）で使用済みにし、同じ ID では進めない。期限切れ・使用済みのトランザクションには、「最初からやり直す」画面を出し、アプリの `redirect_uri` が分かるときはエラー（`access_denied` ではなく、authentication-flows の領域で決めたコード）で戻す。
- トランザクションは DB（Aurora の writer）に書く。Valkey には置かない。Valkey が失われても、途中のログインは続く（[ADR-0005](0005-authentication-path-availability.md)）。
- b は、Cookie の大きさの制約（PKCE・`claims`・`ui_locales` などで膨らむ）と、使用済みにできない（リプレイ）問題がある。c は、Valkey の障害で全員のログインが途中で切れる。

### ヘッダー

- すべての `/u/*` の応答に、次を付ける。
  - `Content-Security-Policy`：`default-src 'none'; script-src 'nonce-<毎回>' 'strict-dynamic'; style-src 'self' 'nonce-<毎回>'; img-src 'self' <資産の配信のオリジン> data:; font-src <資産の配信のオリジン>; connect-src 'self'; form-action 'self' <このトランザクションで許す遷移先>; frame-ancestors 'none'; base-uri 'none'; object-src 'none'`
  - `X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`、`Cache-Control: no-store`、`Cross-Origin-Opener-Policy: same-origin`、`X-Content-Type-Options: nosniff`、`Permissions-Policy`（使わない機能を止める。`publickey-credentials-get`・`publickey-credentials-create` は `self`）
- `form-action` には、POST の後のリダイレクトの行き先（アプリの `redirect_uri` のオリジン、`response_mode=form_post` の送信先、選んだソーシャル IdP の認可のエンドポイントのオリジン）を、トランザクションごとに足す。CSP Level 3 は、フォームの送信の後のリダイレクトにも `form-action` を当てる。ブラウザごとの実装の差は未検証で、E4 の E2E で主要なブラウザを確かめる。
- iframe での表示は、どの設定でも許さない（本家の新しい Universal Login と同じ）。

## Consequences

- 良くなること：
  - 画面の表示が速く（NFR-002 の `/authorize` から表示まで p99 300ms）、strict CSP を保てる。
  - URL の `state` の漏れ（ブラウザの履歴、共有）だけでは、ログインを乗っ取れない。
  - Valkey の障害で、途中のログインが切れない。
- 引き受けるコスト：
  - `/authorize` のたびに writer に 1 行を書く（S1 のピークで 500 件/秒程度。完了と失効の更新を含めて 1,500 件/秒程度）。失効した行はジョブで消す。
  - 同じブラウザで 2 つのタブから別々のログインを始めると、Cookie は ID ごとに区別する必要がある。Cookie の値は「最近のトランザクションの ID の集合（最大 5 件）」にし、署名して改ざんを防ぐ。
  - JavaScript を最小にするので、画面の見た目の自由度は SPA より狭い（[ADR-0012](0012-branding-and-templates.md)）。

## Confirmation

- 結合テスト：URL の `state` だけを別のブラウザ（Cookie なし）で開くと、進めずにやり直しの画面になる。
- 結合テスト：CSRF のトークンのない POST、`Origin` の違う POST、`Sec-Fetch-Site: cross-site` の POST が 403 になる。
- 結合テスト：すべての `/u/*` の応答に、上のヘッダーが付く（ルートの一覧から自動で生成したテスト）。
- 性質ベーステスト：任意の手順の列で、使用済み・期限切れのトランザクションから認可コードが出ない。
- E2E：JavaScript を無効にしたブラウザで、パスワードのログイン・サインアップ・再設定が完了する。

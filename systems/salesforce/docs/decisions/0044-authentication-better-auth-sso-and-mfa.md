---
status: accepted
date: 2026-09-28
---

# ADR-0044: ログインは自前でホストする Better Auth にし、組織ごとの SAML・OIDC の SSO を持ち、Auth0 の題材を IdP にしない。SSO を含む全てのログインで MFA を確かめ、特権を持つ利用者はパスキーだけにし、画面の API はセッションの Cookie だけで通す

詳細は [orgs-users-and-auth.md](../architecture/orgs-users-and-auth.md) の 6 節。

## Context

intent は、利用者のログインを「自前の認証（他の題材の Better Auth）か、rebuilds の Auth0 の題材を IdP として使うか」を E2 の着手前にこの領域で決めるとした。営業の組織の多くは、自社の IdP（Entra ID、Google Workspace、Okta など）での SSO を求める。

rebuilds では、Slack・GitHub・Notion の再構築が、Better Auth を自前でホストし、「だれか」だけを任せる使い方の規則を決めた（[slack の ADR-0012](../../../slack/docs/decisions/0012-self-hosted-auth-with-better-auth.md)、[github の ADR-0019](../../../github/docs/decisions/0019-authentication-and-token-model.md)）。Auth0 の再構築は、設計の記録だけで、動く製品はまだない。

[ADR-0005](0005-tenancy-and-governor-limits.md) は、ホスト名かトークンから DB を読む前に組織を決めるとした。[governor-limits.md](../architecture/governor-limits.md) は、画面の要求を API の割り当てに数えない代わりに、連携がそれを使えないことを求める。

本家は、本番と Sandbox の全ての社内の利用者に MFA を求める。パスキー、自社の認証アプリ、TOTP のアプリを選べ、SMS は社外の利用者だけに許す。特権を持つ利用者には、フィッシングに強い方式（パスキー）だけを認める（[MFA for Direct Salesforce Logins](https://help.salesforce.com/s/articleView?id=xcloud.mfa_direct_logins_overview.htm&type=5)、2026-09-28 に確認）。さらに 2026 年から、SSO を含む全ての社内の利用者のログインに MFA を強制する（Sandbox は 2026-07-10 から。[Prepare for MFA Enforcement for All Employee Users](https://help.salesforce.com/s/articleView?id=005321561&type=1)、2026-09-28 に確認）。

> 2026-09-28 の注記：本家が SSO のログインにも MFA を強制し、特権を持つ利用者にパスキーを求めることを確かめた。この ADR の「SSO の MFA は IdP に任せる」と「管理者にも TOTP を許す」は本家より弱い。この時点では決定を変えず、SSO で IdP の MFA の主張（SAML の `AuthnContextClassRef`、OIDC の `amr`）を確かめるか、管理者にパスキーを必須にするかを、問いとして残した（[orgs-users-and-auth.md](../architecture/orgs-users-and-auth.md) の 14 節）。

> 2026-09-28 の注記（2 つ目）：上の問いを、利用者の指示（推奨の既定案で進める）により決めた。起票の時の「SSO の MFA は IdP に任せる」「SSO 以外は MFA を必須」「管理者も TOTP を使える」を改め、SSO でも IdP の MFA の主張を確かめ（既定で有効、無効は理由の記録と監査つき、主張がなければ本システムの 2 つ目の要素）、特権を持つ利用者と非常用の管理者はパスキーだけ（非常用はハードウェアのキー 2 つ）にした。本家の 2026 年の方針に揃える。題名も直した。

## Options

1. **Better Auth を自前でホストし、組織ごとの SAML・OIDC の SSO を `@better-auth/sso` で持つ**
2. rebuilds の Auth0 の題材を本システムの IdP にする
3. マネージドの IdP（Cognito など）

## Decision

1 を採用する。

- 使い方の規則は slack の ADR-0012 と同じ：Better Auth は認証の手段・セッション・パスキー・MFA・SSO の接続だけを持つ。組織・利用者・権限は自前の表。`organization` プラグインを使わない。公開するエンドポイントは許可したものだけ。SSO の接続の登録は本システムの管理の API で `manage_auth_settings` を確かめてから呼ぶ。バージョンを固定する。
- Better Auth の表は、組織の解決の前に使うので RLS の外の `identity` のスキーマに置き、各行に `org_id` を持たせ、組織の利用者と 1 対 1 に結ぶ。
- SSO 以外の画面のログインは MFA（TOTP、パスキー、回復の番号）を必須にし、外せない。SMS は持たない。
- **SSO のログインでも MFA を確かめる。** IdP の主張（OIDC の `amr`、SAML の `AuthnContextClassRef`）を、SSO の接続ごとの受け入れの一覧（MFA とみなす値、フィッシングに強いとみなす値の 2 つ）と比べる。確かめは既定で有効。組織の管理者（`manage_auth_settings`）は理由を書いた時だけ無効にでき、無効にした操作と理由は監査に残り、組織の管理者全員に知らせる。主張がない・一覧にない時は、SSO の後に本システムの 2 つ目の要素を求める（未登録なら登録させる）。
- **特権を持つ利用者（`modify_all_data`・`manage_users`・`customize_application` のどれかを持つ利用者。管理者はこれに当たる）はパスキーだけを使う。** TOTP と回復の番号は受け付けない。SSO でも、主張がフィッシングに強い側の一覧になければ、SSO の後にパスキーを求める。SSO の確かめを無効にした組織でも、特権を持つ利用者には効かない。特権を持つ権限を得た利用者は、既存のセッションを切り、次のログインでパスキーの登録を求める。
- **非常用の管理者（`sso_bypass`、組織に 2 人まで）もパスキーだけにし、1 人あたりハードウェアのセキュリティキー（持ち運ぶ認証器）を 2 つ登録させる。** 2 つ目がないと `sso_bypass` を与えられない。
- SSO は組織ごとに 5 つまで。`federation_id` で利用者を合わせ、JIT は設定で有効にできる。SAML は IdP 起点を断る。SSO を必須にした組織でも `sso_bypass` の管理者 2 人まではパスワード＋パスキー（ハードウェアのセキュリティキー）で入れる。
- セッションは DB に置き、無操作の期限（既定 2 時間）と絶対の期限（24 時間。自前で検査）を持つ。
- API は OAuth 2.0（認可コード＋PKCE、クライアントクレデンシャル）。トークンは `<brand>_at_`・`<brand>_rt_` の不透明な文字列で、ハッシュだけを持ち、トークンの表から組織を決める。**画面の API はセッションの Cookie だけで通し、OAuth のトークンでは通さない。**
- 2 は、動く製品のない題材に本システムの認証を頼ることになり、片方の遅れと障害がもう片方を止める。組織の IdP としてなら、普通の OIDC でつなげる。
- 3 は、Slack の ADR-0012 と同じ理由（組織のモデルとの二重の管理、利用者の数に比例する費用、画面の自由度）で採らない。

## Consequences

- 良くなること：
  - 他の題材と同じ部品と運用の知見を使える。
  - 組織ごとの SSO・MFA の方針を、本システムの組織のモデルに合わせて持てる。
  - 画面の API を連携に流用できず、API の割り当ての抜け道にならない。
- 引き受けるコスト：
  - Better Auth の脆弱性の対応とバージョンの上げを、自分たちで運用する。
  - 認証の表が RLS の外にあるので、認証のサービスのロールの権限を狭く保つ。
  - MFA を外せないことで、小さな組織の導入の手間が増える。パスキーで下げる。
  - 管理者はパスキーを持たないと管理の操作ができない。非常用の管理者は、ハードウェアのセキュリティキーを 2 つ用意する必要がある。
  - IdP が `amr`・`AuthnContextClassRef` を正しく返さない組織では、SSO の後に本システムの 2 つ目の要素が要り、利用者の手間が増える。受け入れの一覧の調整か、理由を記録した無効化で扱う。

## Confirmation

- 決定表：`DT-AUTH-001`（ログインの手段と MFA。SSO の主張の確かめと、特権を持つ利用者のパスキーの行を含む）を表駆動テストにする。
- 結合テスト：`amr`・`AuthnContextClassRef` がない・一覧にない SSO で 2 つ目の要素を求める。特権を持つ利用者の TOTP・回復の番号を断る。確かめを理由なしに無効にできない。`sso_bypass` はハードウェアのキー 2 つがないと与えられない。
- 結合テスト：SAML の IdP 起点を断る。`InResponseTo` の検査。画面の API が OAuth のトークンで 401。無効化でセッションとトークンが即時に失効する。
- 結合テスト：Better Auth のバージョンを上げる PR で、全ての認証の経路を通す。
- 外部のペンテスト（E12）：認証、SSO、トークン。

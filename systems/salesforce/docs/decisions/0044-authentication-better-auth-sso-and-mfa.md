---
status: accepted
date: 2026-09-28
---

# ADR-0044: ログインは自前でホストする Better Auth にし、組織ごとの SAML・OIDC の SSO を持ち、Auth0 の題材を IdP にしない。SSO 以外は MFA を必須にし、画面の API はセッションの Cookie だけで通す

詳細は [orgs-users-and-auth.md](../architecture/orgs-users-and-auth.md) の 6 節。

## Context

intent は、利用者のログインを「自前の認証（他の題材の Better Auth）か、rebuilds の Auth0 の題材を IdP として使うか」を E2 の着手前にこの領域で決めるとした。営業の組織の多くは、自社の IdP（Entra ID、Google Workspace、Okta など）での SSO を求める。

rebuilds では、Slack・GitHub・Notion の再構築が、Better Auth を自前でホストし、「だれか」だけを任せる使い方の規則を決めた（[slack の ADR-0012](../../../slack/docs/decisions/0012-self-hosted-auth-with-better-auth.md)、[github の ADR-0019](../../../github/docs/decisions/0019-authentication-and-token-model.md)）。Auth0 の再構築は、設計の記録だけで、動く製品はまだない。

[ADR-0005](0005-tenancy-and-governor-limits.md) は、ホスト名かトークンから DB を読む前に組織を決めるとした。[governor-limits.md](../architecture/governor-limits.md) は、画面の要求を API の割り当てに数えない代わりに、連携がそれを使えないことを求める。

本家は直接のログインに MFA を求めると読めるが、公開の開発者の資料では確かめられなかった（未検証）。

## Options

1. **Better Auth を自前でホストし、組織ごとの SAML・OIDC の SSO を `@better-auth/sso` で持つ**
2. rebuilds の Auth0 の題材を本システムの IdP にする
3. マネージドの IdP（Cognito など）

## Decision

1 を採用する。

- 使い方の規則は slack の ADR-0012 と同じ：Better Auth は認証の手段・セッション・パスキー・MFA・SSO の接続だけを持つ。組織・利用者・権限は自前の表。`organization` プラグインを使わない。公開するエンドポイントは許可したものだけ。SSO の接続の登録は本システムの管理の API で `manage_auth_settings` を確かめてから呼ぶ。版を固定する。
- Better Auth の表は、組織の解決の前に使うので RLS の外の `identity` のスキーマに置き、各行に `org_id` を持たせ、組織の利用者と 1 対 1 に結ぶ。
- SSO 以外の画面のログインは MFA（TOTP、パスキー、回復の番号）を必須にし、外せない。SMS は持たない。SSO の MFA は IdP に任せる。
- SSO は組織ごとに 5 つまで。`federation_id` で利用者を合わせ、JIT は設定で有効にできる。SAML は IdP 起点を断る。SSO を必須にした組織でも `sso_bypass` の管理者 2 人まではパスワード＋MFA で入れる。
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
  - Better Auth の脆弱性の対応と版の上げを、自分たちで運用する。
  - 認証の表が RLS の外にあるので、認証のサービスのロールの権限を狭く保つ。
  - MFA を外せないことで、小さな組織の導入の手間が増える。パスキーで下げる。

## Confirmation

- 決定表：`DT-AUTH-001`（ログインの手段と MFA）を表駆動テストにする。
- 結合テスト：SAML の IdP 起点を断る。`InResponseTo` の検査。画面の API が OAuth のトークンで 401。無効化でセッションとトークンが即時に失効する。
- 結合テスト：Better Auth の版を上げる PR で、全ての認証の経路を通す。
- 外部のペンテスト（E12）：認証、SSO、トークン。

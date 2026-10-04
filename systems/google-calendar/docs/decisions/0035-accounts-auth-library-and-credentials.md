---
status: accepted
date: 2026-10-04
---

# ADR-0035: 認証の部品に Better Auth を使い `packages/auth` で包む。アカウントは RLS の外に置き、1 つのアカウントを 1 つのテナントの利用者に結ぶ。ログインはメールのコードとリンク・パスキー・Google・組織の SSO で、パスワードを持たない。CalDAV は `<brand>_ap_` のアプリ用のパスワードで、CalDAV だけの範囲・最長 1 年

## Context

[ADR-0004](0004-tenancy-and-rls.md) は、組織を 1 つのテナント、個人のアカウントを 1 人 1 つのテナントにし、アカウントとメールアドレスの解決をテナントの外に置くと決めた。[ADR-0001](0001-platform-and-stack.md) は、認証のライブラリを汎用の部品としてこの領域で選ぶとした。[architecture/README.md](../architecture/README.md) の 6 節は、CalDAV の認証を OAuth 2.0 の Bearer と、CalDAV 専用のアプリ用のパスワード（利用者が作り、範囲と期限を持ち、組織の管理者が禁止できる）の Basic 認証にし、ログインのパスワードを CalDAV に使わないと決めた。OS の標準のカレンダーが、OAuth 2.0 の任意のサーバーに対応しないためである。

他の題材は、Better Auth を `packages/auth` で包んで使う（Linear の ADR-0034、Slack の identity-and-access.md）。部品の告知が多いので、使う部品だけを依存に入れるとした（Linear の accounts-and-auth.md の 2.2 節、2026-09-28 に確認）。

本家の CalDAV は OAuth 2.0 だけで認証し、Basic 認証を受けない（[CalDAV API developer's guide](https://developers.google.com/workspace/calendar/caldav/v2/guide)、2026-10-04 に確認）。

## Options

部品：

1. **Better Auth（他の題材と同じ）を `packages/auth` で包む**
2. 自前で作る
3. 外部の IDaaS（Cognito など）

アカウントとテナント：

- a. **1 つのアカウントを 1 つのテナントの利用者に結ぶ**
- b. 1 つのアカウントが複数のテナントの利用者になれる（Linear・Slack の形）

## Decision

1 と a を採用する。詳細は [accounts-and-orgs.md](../architecture/accounts-and-orgs.md) の 4・5・9 節。

- Better Auth を `packages/auth` で包み、Auth のサービスで動かす。使う部品は、Email OTP・Magic link・パスキー・Google（OIDC）・セッション・SSO（[ADR-0036](0036-org-domains-sso-and-scim.md)）・SCIM（同）。組織の部品と OAuth の提供者の部品は使わない（組織は自前のモデル、OAuth の認可サーバーは [ADR-0027](0027-oauth-apps-scopes-and-rate-limits.md) で自前）。バージョンと告知は E4 の着手で確かめ直す。
- アカウントは `auth` スキーマ（RLS の外）に置き、テナントの `users` の行に `account_id`（一意）で結ぶ。個人のテナント・利用者・主のカレンダーは、アカウントの作成と同じトランザクションで作る。
- ログインの手段：メールのコード（6 桁・10 分）とリンク（10 分・1 回）、パスキー、Google（`email_verified` が真）、組織の SSO。パスワードは持たない。
- セッション：HttpOnly・`Secure`・`SameSite=Lax` のクッキー。使わないまま 30 日で切れ、組織が 1〜30 日に絞れる。取り消しと停止は Valkey の取り消しの一覧で、API・CalDAV・Realtime が要求ごとに確かめる。停止から全部の資格の失効まで 60 秒以内。
- アプリ用のパスワード：`<brand>_ap_` ＋ base32 の 24 文字 ＋ チェックサム 4 文字。CalDAV だけの範囲、期限は既定・最長 1 年、1 利用者 20 まで。作った時に 1 回だけ示し、SHA-256 と末尾 4 文字だけを保存する。組織の `app_passwords_allowed` で禁止できる。
- トークンの形は、接頭辞とチェックサムでシークレットスキャンに載せる（[リポジトリ共通の ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。

### 他の案を選ばなかった理由

- **2（自前）**：WebAuthn・SAML・OIDC の検証を自前で書くのは誤りの余地が大きく、題材の核でもない（[リポジトリ共通の ADR-0007](../../../../docs/decisions/0007-no-reuse-of-original-implementation.md) は汎用の部品を許す）。
- **3（外部の IDaaS）**：アカウントの表を本システムの DB の外に置くことになり、`principal_directory` と招待の配送の解決が外部に依存する。他の題材と道具が揃わない。
- **b（複数のテナント）**：カレンダーは 1 人の主のカレンダーを中心にし、組織の外の人とは共有と招待でつながる。1 人が複数の組織の利用者になると、どの主のカレンダーに招待の写しを作るかが決まらない。

## Consequences

- 良くなること：
  - 他の題材と同じ部品と包み方で、検証の道具と知見を共有できる。
  - アカウントとテナントの関係が単純で、招待の宛先が 1 つに決まる。
  - OS の標準のカレンダーが、ログインのパスワードなしで使える。
- 引き受けるコスト：
  - Better Auth の告知を追い続ける運用が要る。
  - 複数の組織に属する人は、組織ごとに別のアカウント（別のメールアドレス）を持つ。
  - アプリ用のパスワードは Basic 認証で毎回送られる。漏れたら CalDAV の読み書きができる（範囲と期限と取り消しで抑える）。
  - **本家との意図した違い**：本家の CalDAV は OAuth 2.0 だけで認証し、Basic 認証は 401 になる（[CalDAV API developer's guide](https://developers.google.com/workspace/calendar/caldav/v2/guide)、2026-10-04 に確認）。本システムは OS の標準のカレンダーのために、CalDAV だけのアプリ用のパスワードの Basic 認証を受ける（[architecture/README.md](../architecture/README.md) の 1.4 節の「本家との意図した違い」）。
  - 認証の失敗の上限は、アカウントの全体で止めない（他人が締め出しに使えるため。[sync-and-caldav.md](../architecture/sync-and-caldav.md) の 6.7 節）。

## Confirmation

- 依存の検査（CI）：`better-auth` の組織の部品と OAuth の提供者の部品を本番の依存で禁止する。
- 性質ベーステスト：PROP-ACCT-001（停止から 60 秒の後の全部の要求の拒否）。
- 結合テスト：アプリ用のパスワードの Basic 認証（期限、取り消し、組織の禁止）、CalDAV の認証の失敗の上限（他人の失敗で正しいパスワードの端末が止まらないこと）、セッションの取り消しで Realtime が切れる。
- シークレットスキャン：`<brand>_ap_` の形を登録し、試験の値で検出されることを確かめる。

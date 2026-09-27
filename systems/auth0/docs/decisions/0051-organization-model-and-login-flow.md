---
status: accepted
date: 2026-09-27
---

# ADR-0051: 組織はテナントの中のメンバーシップの単位にし、ログインの流れは本家の設定を決定表で持つ

詳細は [organizations.md](../architecture/organizations.md) の 3・4・7 節。MVP の後（E14）。

## Context

B2B のテナント（SaaS の事業者）は、自分の顧客の会社ごとに、ログインの方法（その会社の IdP）、ブランド、ロールを分けたい。本家は Organizations で、テナントの中に組織を置き、アプリの `organization_usage`（`deny`・`allow`・`require`）と `organization_require_behavior`（`pre_login_prompt`・`post_login_prompt`・`no_prompt`）でログインの流れを決める。組織ごとのカスタムドメインは持たない（[Organizations Overview](https://auth0.com/docs/manage-users/organizations/organizations-overview)、[Define Organization Behavior](https://auth0.com/docs/manage-users/organizations/configure-organizations/define-organization-behavior)、2026-09-27 に確認）。

組織のモデルは、テナントの分離（[ADR-0002](0002-tenancy-and-isolation.md)）の中に、もう 1 段の境界を作る。この境界が破れると、ある顧客の会社の利用者が、別の会社のデータに入れる。

## Options

1. **組織はテナントの中の、テナントのユーザーとのメンバーシップの単位。本家の設定と流れを持ち、決定表で定める**
2. 顧客の会社ごとに別のテナントを作らせる（組織を持たない）
3. 組織が利用者を持つ（利用者は 1 つの組織にだけ属する）

## Decision

1 を採用する。

- 組織のメンバーはテナントのユーザー。1 人が複数の組織に属しうる。組織のロールは、組織の文脈でだけ効く。
- ログインの流れは、`organization_usage` × 要求の `organization` × `organization_require_behavior` の決定表（organizations.md の 4 節）で定める。
- 組織の文脈のログインでは、組織で有効な接続だけを使える。メンバーシップは、既存のメンバー・自動の付与・招待（メールアドレスの一致）のどれかで得る。それ以外は拒否する。
- 組織の名前と存在を、エラーの文面で漏らさない。
- **組織の名前は変えない。** 表示名だけを変えられる。`org_name` で API を分ける利用者の事故を防ぐ。
- **組織ごとのカスタムドメインは持たない**（本家と同じ）。複数のカスタムドメイン（S2 以降）の後に、需要を見て決め直す。
- コールバックの `{organization_name}` は、置き換えの後の URL と完全一致で照合する（[ADR-0006](0006-authorization-code-pkce-and-exact-redirect.md)）。
- 件数の上限は本家に合わせる（組織 10 万、メンバー 10 万、組織の接続 10）。
- 2 は、顧客の会社が数千あると、テナント・鍵・設定が数千に増え、アプリの登録も会社ごとに要る。本家から移る B2B のテナントの形とも合わない。
- 3 は、フリーランスのように複数の会社で働く利用者を表せない。本家の想定（1 人が複数の組織）とも合わない。

## Consequences

- 良くなること：
  - 本家の B2B の利用者の設計（組織の選択、招待、組織ごとの接続）がそのまま移せる。
  - 組織の境界の規則が決定表になり、表駆動テストで全行を押さえられる。
- 引き受けるコスト：
  - 認証の経路に、メンバーシップの読み込み（DB）が増える。組織の定義は組織ごとの小さなキャッシュに持つが、メンバーシップはキャッシュしない。
  - 本家は組織の名前を変えられる（`PATCH /api/v2/organizations/{id}` の `name`。Management API の OpenAPI の `UpdateOrganizationRequestContent`、2026-09-27 に確認）。本システムは変えないので、移行で差になる。

## Confirmation

- 決定表のテスト：`DT-ORG-001` の全行。
- 性質ベーステスト：任意の組み合わせで、発行したトークンの `org_id` の組織に、利用者がメンバーである。
- 結合テスト：組織で無効な接続の指定、存在しない組織、メンバーでない利用者が拒否され、文面で組織の存在が分からない。
- 結合テスト：組織の名前の変更の要求が 400、表示名の変更は通る。

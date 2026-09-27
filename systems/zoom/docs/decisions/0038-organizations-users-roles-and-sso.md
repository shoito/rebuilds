---
status: accepted
date: 2026-09-27
---

# ADR-0038: ユーザーは 1 つの組織に属し、ロールは 3 つに固定する。ログインと SSO は Better Auth を自前でホストし、ID の基盤を替えられる境界を保つ

## Context

intent.md の MVP は「組織のアカウント、ユーザーとロール」を求め、外部のシステムに「ID の連携（SAML・OIDC の IdP）」を挙げる。日本の企業の多くは、Entra ID・Okta などの IdP で SSO を求める。

rebuilds の他の題材の決定：

- Slack の題材は、認証を Better Auth で自前でホストし、ワークスペースとメンバーは自前のモデルで持つ（Slack の [ADR-0012](../../../slack/docs/decisions/0012-self-hosted-auth-with-better-auth.md)）。Better Auth の SSO のプラグインは OIDC と SAML 2.0 に対応し、`InResponseTo` の検査を持つ。一方、SSO のプラグインの権限の判定に脆弱性の前例がある（同 ADR に記録）。
- Auth0 の題材は、ID の基盤そのもの（認可サーバー、Universal Login、組織の SSO）を設計している（[Auth0 の architecture](../../../auth0/docs/architecture/README.md)）。まだ実装はない。
- 制御の側の技術は TypeScript・Hono・Aurora（[ADR-0001](0001-platform-and-stack.md)）。

会議の設定・録画・SSO は、組織の単位で決まる。1 人が複数の組織に属すると、どの組織の設定と SSO で会議を作るかの判定が、すべての操作に入る。

## Options

ユーザーと組織：

1. **ユーザーは 1 つの組織だけに属する（メールアドレスごとに 1 人）**
2. **グローバルなアカウントと、組織ごとのメンバー（Slack の題材と同じ形）**

認証：

3. **Better Auth を自前でホストする（Slack の題材と同じ）**
4. **マネージドの IdP（Cognito、商用の IdP）に任せる**
5. **Auth0 の題材の成果物を IdP として使う**

## Decision

1 と 3 を採用する。詳細は [accounts-and-admin.md](../architecture/accounts-and-admin.md) の 3〜4 節。

- ユーザーは 1 つの組織だけに属する。個人で登録した人にも 1 人の組織を作る。別の組織の人を招待したら、本人の承諾で移す。
- ロールは `owner`（1 人）・`admin`・`member` に固定する。判定は `authorize` の 1 つの関数に集める。
- 認証は Better Auth（メールの OTP、Google、Microsoft、パスキー、`@better-auth/sso` の OIDC と SAML）。パスワードは持たない。Slack の題材の使い方の規則（管理系の操作はサーバーの側で権限を確かめてから呼ぶ、版の固定、`organization` のプラグインを使わない）を引き継ぐ。
- 組織の SSO は `off`・`optional`・`required`。`required` でも、`owner` と指名した 2 人までの `admin` は例外として別の手段で入れる。既存のユーザーを SSO の身元に結び付けるのは、組織がそのドメインを確かめている場合だけ。
- `identity` のモジュールの外には `user_id`・`org_id`・`auth_context` だけを出し、Better Auth の型とテーブルを外から参照しない。外部の IdP に替えるときは、本システムを OIDC の RP にし、このモジュールの中だけを差し替える。
- 2 を採らない理由：会議の作成・録画・設定・SSO のすべてで「今どの組織として操作しているか」を持つ必要があり、ビデオ会議の使い方に対して重い。他の組織の会議には、ゲストか招待で入れる。
- 4 を採らない理由：Slack の題材の ADR-0012 と同じ（組織ごとの SSO の強制を本システムのテナントのモデルに合わせる必要、利用者の数に比例する料金、ログインの画面の自由度）。
- 5 を採らない理由：まだ実装がない。境界を保って、実装されたときに検討する。

## Consequences

- 良くなること：
  - すべての操作の組織が、ユーザーから 1 つに決まる。
  - Slack の題材と同じ認証の実装と試験を使える。
  - ID の基盤を後で替えても、会議・録画・設定のコードは変わらない。
- 引き受けるコスト：
  - グループ会社や代理店のように、1 人が複数の組織で会議を主催したい要求に応えられない（持ち越し）。
  - SAML の相互運用の不具合（IdP ごとの方言、証明書の更新）を自分たちで扱う。
  - Better Auth の脆弱性への追従が要る。

## Confirmation

- lint：`identity` のモジュールの外から、Better Auth のパッケージと認証のテーブルを import していない。
- 決定表の試験：ロールと操作の表（`DT-ADM-*`）、SSO の結び付けの規則。
- 結合試験：Entra ID と Okta の試験のテナントで、SAML と OIDC のログイン、JIT、`required` の強制と例外。
- 試験：IdP 起点の SAML の応答を拒否する。

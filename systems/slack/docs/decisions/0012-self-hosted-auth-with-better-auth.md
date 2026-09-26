---
status: accepted
date: 2026-09-26
---

# ADR-0012: 認証は Better Auth で自前でホストし、ワークスペースとメンバーは自前のモデルで持つ

## Context

[ADR-0010](0010-accounts-and-workspace-members.md) で、認証はグローバルな `accounts` で 1 回だけ行い、ワークスペースの中ではメンバーとして振る舞うと決めた。認証の中身（ログインの手段、セッション、MFA、ワークスペースごとの SSO）をどう実装するかを決める。

求めることは次のとおり（詳細は [identity-and-access.md](../architecture/identity-and-access.md)）。

- パスワードを持たないログイン（メールの OTP、Google、Microsoft、パスキー）と、TOTP による MFA
- DB に置き、即時に取り消せるセッション。端末の一覧
- ワークスペースごとの SSO（OIDC と SAML）と、S2 での SCIM
- TypeScript・Hono・Drizzle・Aurora PostgreSQL の上で動くこと（[ADR-0007](0007-typescript-stack.md)、[ADR-0008](0008-hono-rpc-for-api-contract.md)、[ADR-0011](0011-aws-container-platform.md)）
- アカウントのデータを自分たちの DB に置くこと。S3 でセルに分けても、アカウントをグローバルに保てること
- 実装の大部分を AI エージェントが書く。暗号や認証のプロトコルを、エージェントに一から書かせない

## Options

1. **Better Auth**：TypeScript のライブラリ。自分たちの DB に置き、自分たちのプロセスで動かす
2. **自前で実装する（Lucia 流）**：セッションは自分で書き、OAuth は Arctic、WebAuthn は SimpleWebAuthn、SAML は samlify などの部品を組み合わせる
3. **Auth.js**
4. **マネージドの IdP**：Amazon Cognito、Auth0、Clerk など。認証をまるごと外部に任せる
5. **1 に、企業向けの SSO・SCIM だけを WorkOS などの外部サービスで補う**

## Decision

1 を採用する。SAML・SCIM が足りなくなったら 5 へ広げる余地を残す。

### 確かめたこと（2026-09-26、Better Auth v1.6.23 の文書とソース）

| 必要なもの | Better Auth | 確認の結果 |
| --- | --- | --- |
| Hono との統合 | `auth.handler(c.req.raw)` を Hono のルートに載せる | 対応 |
| Drizzle・PostgreSQL | Drizzle のアダプター。モデル名とテーブル名を変えられる。ID の生成関数を渡せる | 対応 |
| メールの OTP | `emailOTP` プラグイン（サインイン、メール確認） | 対応 |
| マジックリンク | `magicLink` プラグイン | 対応（本システムでは使わない） |
| Google・Microsoft | 標準のソーシャルプロバイダー。Microsoft は `tenantId` を指定できる | 対応 |
| パスキー | `@better-auth/passkey`（1.4 で別パッケージに分離）。パスキーだけでのサインアップもできる | 対応 |
| MFA | `twoFactor` プラグイン：TOTP、メール等の OTP、バックアップコード（既定で暗号化して保存）。パスワードなしのアカウントは `allowPasswordless` で登録できる | 対応 |
| セッション | DB に保存。`expiresIn`・`updateAge` によるアイドルタイムアウト、`freshAge`、`listSessions`・`revokeSession`・`revokeOtherSessions`、短命の Cookie キャッシュ | 対応。**絶対タイムアウトはない**ので自前で検査する |
| CSRF | `Origin` の検査と `trustedOrigins`、Cookie の属性の設定 | 対応 |
| レート制限 | パスごとの規則。保存先に secondary storage（Valkey）を使える | 対応 |
| SSO | `@better-auth/sso`：OIDC と SAML 2.0、メールのドメインによる IdP の選択、ドメインの確認、`provisionUser` フック、SAML の `InResponseTo` 検査と IdP 起点の拒否、SAML の Single Logout（1.5） | 対応。複数タスクの間での `InResponseTo` の記録の共有は 未検証 |
| SCIM | `@better-auth/scim`：Users の作成・更新・削除、プロバイダーと組織に紐付いたトークン | 対応。ただし組織に紐付かないトークンの `DELETE` はグローバルなユーザーを削除しうる |
| 組織 | `organization` プラグイン | 対応（本システムでは使わない） |
| アカウントの削除 | `deleteUser`（確認メール、`beforeDelete`） | 対応（ユーザーの行を消すため、本システムでは使わない） |

### 使い方の規則

- **Better Auth が持つのは「だれか」だけにする。** アカウント、認証手段、セッション、パスキー、MFA、SSO の接続を Better Auth に任せる。ワークスペース、メンバー、ロール、招待、権限は、RLS の下にある自前のテーブルと `authorization.ts` で持つ（[ADR-0005](0005-single-authorization-check.md)、[ADR-0009](0009-pooled-tenancy-with-rls.md)）。
- **`organization` プラグインは使わない。** 組織とメンバーシップをテナントの外に二重に持つと、正本がずれる。これに伴い、SSO の接続は組織に紐付けずに登録し、ワークスペースとの対応は自前のテーブルで持つ。SCIM は S2 で自前で実装する（組織なしの SCIM プラグインは、無効化ではなくユーザーの削除になりうるため）。
- **Better Auth のエンドポイントは許可したものだけを公開する。** `/api/auth/*` のうち、ログイン・ログアウト・セッション・MFA・パスキーの経路だけを Hono から Better Auth に渡す。SSO の接続の登録など管理系の操作は、本システムの管理 API で権限を確かめてから、サーバー側で `auth.api.*` を呼ぶ。
  - SSO プラグインには、組織の一般メンバーが SSO の接続を登録できる脆弱性（CVE-2026-53515、1.2.10〜1.6.10、1.6.11 で修正）があった。ライブラリの権限判定に頼らない方式にする。
- **API トークン（ボット・エージェント）は自前で実装する。** Better Auth の API キーのプラグインはキーをユーザーに結び付けるが、ボットはアカウントを持たないメンバーである（ADR-0010）。
- **セッションの正本は Aurora に置く。** Valkey には Cookie キャッシュとレート制限だけを置く（Valkey は失われてもよい。[ADR-0003](0003-redis-pubsub-for-fanout.md)）。
- **ADR-0008 の例外**：Better Auth の経路は Hono RPC の `AppType` に含まれない。Web は Better Auth のクライアント（`createAuthClient`）を使うが、直接ではなく `packages/api-client` の中に包んで公開し、「Web は `packages/api-client` だけを使う」規則を保つ。
- **バージョンを固定する。** `better-auth` と `@better-auth/*` を完全なバージョンで固定し、更新は PR で行う。更新のたびに、認証の結合テストと 6 節の決定表のテストを通す。セキュリティ勧告を監視する（Dependabot と GitHub Advisory）。

### 他の選択肢を採らない理由

- **2（自前）**：部品は揃っているが、セッション・OAuth・WebAuthn・TOTP・SAML の結合部分（状態の保存、アカウントの紐付け、失効）を自分たちで書き、保守することになる。エージェントに書かせると、テストで気づきにくい誤り（`state` の検査漏れ、署名の検証漏れ）を生みやすい。Lucia 自体も、2025 年にライブラリとしての提供をやめ、実装の手引きになった。
- **3（Auth.js）**：2025 年 9 月から Better Auth のチームが保守しており、新しいプロジェクトには Better Auth が勧められている。SAML・MFA・端末ごとのセッションの管理を標準で持たない。
- **4（マネージドの IdP）**：プロトコルの実装と脆弱性対応を任せられる点は大きい。一方で次を理由に採らない。
  - ワークスペースごとの SSO・SSO の強制・ワークスペースごとのセッションの方針を、本システムのテナントモデルに合わせて作り込む必要があり、IdP の組織モデルとの二重管理になる。
  - アカウント数に比例する料金になる（Cognito も月間アクティブユーザー単位）。無料・小規模のワークスペースが大半の SaaS では、規模とともに重くなる。
  - ログイン画面とメールの体験の自由度が下がる。
  - Cognito は AWS 上で完結する利点があるが、ユーザープールのリージョン間の移設とセル構成（S3）の設計が読みにくい。
- **5（外部サービスで補う）**：今は採らない。次のどれかが起きたら、SAML と SCIM だけを WorkOS などに移すことを、新しい ADR で検討する。
  - 顧客の IdP との相互運用の不具合（SAML の方言、証明書の更新）が、E7 以降に四半期で 3 件を超える
  - SAML・SCIM の脆弱性への対応が、リリースを止める頻度で起きる
  - SCIM の Groups や、IdP ごとの検定（Okta Integration Network など）が必要になる

## Consequences

- 良くなること：
  - アカウントとセッションが自分たちの Aurora にあり、RLS の外のグローバルなデータとして扱える。S3 では、この部分をセルの外の「アイデンティティ面」に切り出せる。
  - 認証のプロトコルの実装をライブラリに任せ、エージェントが書くのはワークスペースとの結び付け（メンバーの解決、ポリシーの検査）に絞れる。
  - アカウント数に比例する外部の費用がない。
- 引き受けるコスト：
  - 認証の脆弱性への対応（ライブラリの更新、勧告の監視）を自分たちで持つ。SAML は特に攻撃面が大きく、E2 の完了前に外部のペネトレーションテストを受ける。
  - Better Auth のスキーマと設定の変更に、ライブラリの更新のたびに追従する必要がある。モデル名を変えているため（`user` → `accounts`、`account` → `auth_identities`）、マイグレーションの生成結果をレビューする。
  - organization・SCIM・API キー・`deleteUser` のプラグインを使わないぶん、同等の機能を自前で書く。
  - 絶対タイムアウト、ワークスペースごとのセッションの方針、MFA 完了時のセッションの作り直し（未検証）は、Better Auth の外で補う。

## Confirmation

- 結合テスト（Testcontainers）で、各ログインの手段、MFA、セッションの取り消し、SSO（OIDC はテスト用の IdP、SAML はテスト用の IdP のコンテナ）を実際に通す。
- `/api/auth/*` のうち Better Auth に渡すパスの許可リストを、テストで固定する。許可リストにないパス（例：`/api/auth/sso/register`）が 404 になることを確かめる。
- lint：`apps/api/src/auth/` の外から、Better Auth の `auth.api` と認証のテーブルを import しない。Web から `better-auth/client` を直接 import しない。
- `package.json` で `better-auth` と `@better-auth/*` のバージョンが完全に固定されていることを CI で検査する。
- E2 の着手時に、次の 未検証 の項目を確かめ、この ADR の後継か identity-and-access.md に結果を書く。
  - `secondaryStorage` を設定したときに、セッションを DB に置いたままにできるか
  - Cookie の名前に `__Host-` の接頭辞を使えるか
  - MFA の完了時にセッションが作り直されるか
  - 複数の ECS タスクの間で、SAML の `InResponseTo` の記録を共有できるか

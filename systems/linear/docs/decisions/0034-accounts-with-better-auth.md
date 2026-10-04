---
status: accepted
date: 2026-09-28
---

# ADR-0034: 認証は Better Auth を `packages/auth` で包んで使う。メールの OTP・Google・パスキー・セッション・複数のセッションの部品を使い、組織の部品は使わない。アカウントは RLS の外の `auth` スキーマ、ワークスペースの中の人は同期するモデルにし、`account_id` で結ぶ

## Context

1 人のアカウントが複数のワークスペースに属する（[ADR-0004](0004-tenancy-and-permissions.md)）。本家のログインの手段は、Google、メール（リンクかコード）、パスキー、Enterprise の SAML で、パスワードはない（[Login methods](https://linear.app/docs/login-methods)、2026-09-28 に確認）。

ワークスペースのメンバーシップ・ロール・チームは、同期するモデルで、変えるたびに Writer が購読（`SyncSubscription`）を計算し直す（[ADR-0013](0013-sync-group-changes-retention-and-reset.md)、[ADR-0032](0032-single-policy-module-and-group-mapping.md)）。

認証の部品の候補として、Better Auth を評価した（いずれも 2026-09-28 に確認）。

- `better-auth` 1.7.6、MIT。`@better-auth/passkey`（SimpleWebAuthn）・`@better-auth/sso`（OIDC・SAML、samlify）・`@better-auth/scim`（SCIM 2.0）も同じバージョン（npm のレジストリ）。
- Hono に Web 標準の API でそのまま載る（[Hono integration](https://www.better-auth.com/docs/integrations/hono)）。
- PostgreSQL（Kysely）で、`database.schemaName` で別のスキーマに置ける（[PostgreSQL](https://www.better-auth.com/docs/adapters/postgresql)）。
- メールの OTP は 6 桁・既定 5 分・3 回、保存をハッシュにできる（[Email OTP](https://www.better-auth.com/docs/plugins/email-otp)）。
- 組織の部品は、組織・メンバー・ロール・招待・チームを持つ（[Organization](https://www.better-auth.com/docs/plugins/organization)）。

## Options

1. **Better Auth を包んで使う。組織の部品は使わず、ワークスペースは自前のモデル**
2. Better Auth の組織の部品で、ワークスペース・メンバー・招待も持つ
3. 自前で組む（SimpleWebAuthn、OIDC のクライアントなどの部品から）
4. 管理された IdP（Amazon Cognito など）

## Decision

1 を採用する。詳細は [accounts-and-auth.md](../architecture/accounts-and-auth.md) の 3〜5・7 節。

- 認証のサービスは Hono の上の Better Auth で、`/api/auth/*` を受ける。表は Aurora の `auth` スキーマ（RLS の外。認証のサービスのロールだけ）。
- 使う部品：核（アカウント、セッション）、`email-otp`（1 通のメールにコードとリンク。リンクの中身は URL のフラグメント）、Google、`@better-auth/passkey`、`multi-session`。`magic-link` とパスワードは使わない。
- 組織の部品は使わない。ワークスペース・`User`・`TeamMembership`・`Invitation` は同期するモデルで、参加は認証のサービスが Writer にシステムのトランザクションを送って書く。
- アカウントとワークスペースの中の人（`User`）は `account_id` で結ぶ。入り口の一覧（`auth.workspace_directory`）は写しで、権限の判定には使わない。
- 他のパッケージから Better Auth を直接使うことを lint で禁止し、`packages/auth` の API だけを使う。バージョンは固定し、minor 以上の上げはログインの E2E を通してから。
- SAML・SCIM は、MVP の後に同じライブラリの部品で足す（別の ADR）。
- Better Auth は本家と無関係の第三者の汎用の部品で、[リポジトリ共通の ADR-0007](../../../../docs/decisions/0007-no-reuse-of-original-implementation.md) に反しない。
- 2 を採らない理由：メンバーシップの正本が Better Auth の表と同期するモデルの 2 つになり、購読の計算（Writer のトランザクション）の外でメンバーシップが変わりうる。
- 3 を採らない理由：OTP・OIDC・WebAuthn・セッションの管理・後の SAML を全部書くことになり、誤りの危うさが大きい。
- 4 を採らない理由：ワークスペースごとのログインの制限、1 通のメールのコードとリンク、Electron の交換の形などを作り込む余地が小さく、移行が難しい。アカウントの表が外にあり、同期するモデルとの結び付けが遠くなる。

## Consequences

- 良くなること：
  - 必要なログインの手段と、後の SAML・SCIM の部品がそろう。
  - アカウントが自分の Aurora（東京）に残る（法務の L4）。
  - メンバーシップの正本が 1 つで、購読の計算と一致する。
- 引き受けるコスト：
  - 認証の核を若い第三者のライブラリに頼る。バージョンの固定、告知の監視、包みと結合テストで抑える。
  - Better Auth の言葉（`user`・`account`）と、この題材の言葉（アカウント・ログインの手段）がずれる。表の名前は `modelName` で変えられるが、コードの型は元の名前のままなので、既定の名前を使う（[Database](https://www.better-auth.com/docs/concepts/database)、2026-09-28 に確認）。
  - 参加の書き込みが、認証のサービスから Writer への呼び出しになる。

## Confirmation

- 表駆動テスト：DT-AUTH-001（結び付け）、DT-AUTH-003（参加の経路）。
- 結合テスト：OTP、Google の模擬、パスキー（仮想の認証器）、参加の二重押し。
- lint：`better-auth` の import を `packages/auth` の外で禁止する。
- E4 の着手の前に、Better Auth の脆弱性の履歴をセキュリティのレビューで調べる。

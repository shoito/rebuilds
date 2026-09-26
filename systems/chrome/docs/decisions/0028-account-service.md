---
status: accepted
date: 2026-09-26
---

# ADR-0028: アカウントは Better Auth で自前でホストし、パスキーを主な手段とし、ブラウザは OAuth 2.1 の公開クライアントにする

## Context

同期と拡張機能のストアのために、自前のアカウントが要る（Google アカウントとの統合は Non-goals。[intent.md](../intent.md)）。ログインの手段、アカウントのデータの置き場所、ブラウザ（端末のアプリ）がどうトークンを得るかを決める。

確かめたこと（2026-09-26）：

- Slack の設計は、Better Auth を自前でホストし、パスワードを持たず、メールの OTP・パスキー・TOTP を使うと決めた（Slack の [ADR-0012](../../../slack/docs/decisions/0012-self-hosted-auth-with-better-auth.md)。Better Auth v1.6.23 の文書とソースで確認済み）。
- Better Auth の `@better-auth/oauth-provider` は、OAuth 2.1 の認可サーバーになり、公開クライアントに PKCE を求め、リダイレクト URI を完全一致で検査する。端末の認可（RFC 8628）のプラグインもある（[OAuth 2.1 Provider](https://better-auth.com/docs/plugins/oauth-provider)、[Device Authorization](https://better-auth.com/docs/plugins/device-authorization)）。

## Options

1. **Better Auth で自前でホストする。パスキーとメールの OTP。ブラウザは OAuth 2.1（認可コード＋PKCE）の公開クライアント**
2. **マネージドの IdP（Amazon Cognito など）**
3. **1 と同じ認証で、ブラウザには Better Auth のセッションの Cookie をそのまま使わせる**

## Decision

1 を採用する。詳細は [sync-and-accounts.md](../architecture/sync-and-accounts.md) の 2 節。

- 手段：パスキー（主）、メールの OTP、任意の TOTP。パスワードとソーシャルログインは持たない。拡張機能の開発者は、パスキーか TOTP を必須にする。
- ブラウザは、専用のタブで認可のページを開き、予約したリダイレクト URI（`<brand>://oauth-callback`）への遷移を Browser プロセスが横取りして、コードを交換する。アクセストークンは 10 分・メモリだけ、リフレッシュトークンは回転し、OS の鍵の保管庫に置き、端末の登録に結びつける。
- Slack の ADR-0012 の使い方の規則（Better Auth は「だれか」だけを持つ、公開するエンドポイントを許可リストにする、版を完全に固定する）を引き継ぐ。
- アカウントのサービスは、同期の鍵に触れない。アカウントの回復（メールの OTP でのログイン）は、同期のデータの回復を意味しない（鍵は端末・回復用のコードで得る。ADR-0027）。
- 2 を採らない理由：利用者の数に比例する費用になり、ブラウザの第一者のクライアント・端末の登録・パスキーの体験を IdP の模型に合わせることになる。他の題材と道具を共有できない。
- 3 を採らない理由：Cookie は Web のページのためのもので、ブラウザ自身の通信に使うと、Web のコンテンツとの境界（どの Cookie の保存領域に置くか、シークレットモードとの関係）が曖昧になる。端末ごとの失効と、同期の API の対象（audience）を分けたトークンも作りにくい。

## Consequences

- 良くなること：
  - アカウントのデータと認証の方式を自分たちで持ち、他の題材の知見と道具を使える。
  - パスキーを主にすることで、フィッシングに強い。パスワードの漏洩の攻撃面がない。
  - ブラウザの通信は、短命のアクセストークンと端末に結びつくリフレッシュトークンで、端末ごとに止められる。
- 悪くなること、引き受けるコスト：
  - 認証のライブラリの脆弱性への追従を自分たちで持つ。
  - ブラウザ自身に WebAuthn の実装（OS の認証器との連携）が要る。Linux のパスキーの体験（hybrid）は **未検証**。
  - OAuth 2.1 Provider プラグインを、第一者の公開クライアント・独自スキームのリダイレクト URI で使えるかは **未検証**。E8 の初めに試作で確かめ、合わなければ同じ流れを自前で書く（Better Auth のセッションから、自前のトークンの発行の経路を作る）。

## Confirmation

> 2026-09-27 の注記：Better Auth の「OAuth 2.1 Provider」のプラグイン（`@better-auth/oauth-provider`）は、公開クライアント（`token_endpoint_auth_method: "none"`）、既定で必須の PKCE、RFC 8252 の形の独自のスキームのリダイレクト URI を受け付ける（[OAuth 2.1 Provider](https://www.better-auth.com/docs/plugins/oauth-provider)、2026-09-27 に確認）。文書の上では条件を満たす。E8 の初めの試作は、動作の確認として残す。Linux の Chrome は、スマートフォンでの認証（hybrid）に対応している。BLE は BlueZ を使う（[Passkeys の対応環境](https://developers.google.com/identity/passkeys/supported-environments)、2026-09-27 に確認）。BlueZ に起因する不安定さの報告があるので、Linux の hybrid の品質は E8 で実機で確かめる。

- 結合テストで、パスキー・メールの OTP・TOTP・ブラウザのサインイン（PKCE を含む）・リフレッシュトークンの回転と失効・端末の削除を通す。
- リフレッシュトークンの再利用（回転前のトークンの使用）で、その端末のトークンがすべて失効することをテストで確かめる。
- リダイレクト URI への遷移が Renderer に渡らないことを、侵害された Renderer を模したテストで確かめる。
- `better-auth` と `@better-auth/*` の版が完全に固定されていることを CI で検査する。

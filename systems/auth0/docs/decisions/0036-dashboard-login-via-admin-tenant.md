---
status: accepted
date: 2026-09-27
---

# ADR-0036: ダッシュボードは静的な SPA にし、管理者は本システムの管理用のテナントでログインする

詳細は [dashboard.md](../architecture/dashboard.md) の 3・4 節。

## Context

ダッシュボードの管理者は、テナントのすべての設定と利用者を変えられる。管理者のログインは、テナントのエンドユーザーのログインと同じかそれ以上に守る必要がある。

[ADR-0001](0001-platform-and-stack.md) で、管理者のログインにこのシステム自身の管理用のテナントを使い、非常用の経路が要ることを記した。[ADR-0057](0057-accounts-network-and-path-separation.md) は、ダッシュボードを `manage.<brand>.<domain>` の静的な配信とし、ECS のサービスを持たないとした。

他の題材の管理画面は、同じオリジンの API と HttpOnly の Cookie のセッションで作った（Stripe の dashboard.md の 9.2 節）。本システムでは、管理者の認証そのものが本システムの OIDC である。

本家のダッシュボードは、ユーザー名・パスワードとソーシャルでログインし、MFA は任意である（[Manage Dashboard Access](https://auth0.com/docs/get-started/manage-dashboard-access)、2026-09-27 に確認）。本家のダッシュボードの内部の認証の基盤は公開されていない（未検証）。

## Options

1. **管理者は管理用のテナント `admin` のユーザー。SPA は OIDC の公開のクライアント（認可コード＋PKCE）で、トークンはメモリーだけ。API は同じオリジンの `/api/*`**
2. ダッシュボード専用の認証（本システムの OIDC を使わない、別の仕組み。Better Auth など）
3. 1 と同じ管理用のテナントだが、BFF（サーバーでトークンを持ち、Cookie のセッションで SPA を守る）を置く

## Decision

1 を採用する。

- 管理用のテナントは予約の名前 `admin`、`production`。設定は IaC で持ち、2 人のレビューを要する。Actions を使わない。
- MFA を必須にする（パスキー・TOTP）。メールの OTP は使えない。
- アクセストークン 10 分、リフレッシュトークンはローテーションと再利用の検知、絶対 12 時間・アイドル 30 分。トークンは SPA のメモリーだけに置く。再読み込みは `prompt=none` の上位のリダイレクトで取り直す。
- 秘密・鍵・権限に触れる操作は、直近 5 分以内の MFA（`auth_time`・`amr`）を Management API で確かめる（step-up）。
- API は `manage.<brand>.<domain>/api/*`（mgmt のサービス）。テナントの操作は `/api/tenants/{tenant}/v2/*` として、Management API と同じハンドラーに渡す。
- 2 は、管理者のログインだけ本システムの品質の保証（適合試験、攻撃の防御、パスキー）の外に出る。自分で自分を使う利点（テナントより先に不具合に気づく）も失う。
- 3 は、BFF のサーバーが要り、ADR-0057 の静的な配信の前提を変える。トークンをメモリーだけに置き、厳しい CSP と Trusted Types で XSS を抑えれば、BFF の利点（トークンをブラウザに置かない）の多くを得られると判断した。S2 で、管理者の数と脅威の見直しで再評価する。

## Consequences

- 良くなること：
  - 管理者のログインが、テナントと同じ仕組み（パスキー、攻撃の防御、ログ）で守られる。本システムの SPA の SDK の最初の利用者になる。
  - ダッシュボードのサーバーを持たず、配信が単純になる。
- 引き受けるコスト：
  - 本システムの認証の経路が止まると、管理者のログインも止まる。非常用の経路（[ADR-0037](0037-break-glass-and-admin-roles.md)）が要る。
  - トークンがブラウザのメモリーにある。XSS の防御（CSP、Trusted Types、lint）が破られると、10 分のトークンが盗まれうる。
  - 認証の経路の変更は管理用のテナントに最初に届く（ADR-0066）。管理者が不具合に最初に当たる。

## Confirmation

- E2E：管理用のテナントでのログイン（仮想の WebAuthn の認証器）、step-up、再読み込みの後の再取得。
- 結合テスト：`auth_time` が古いトークンで step-up の操作が 403 `step_up_required`。
- lint：SPA のコードで `localStorage`・`sessionStorage` にトークンを書く呼び出しを禁止する。`dangerouslySetInnerHTML` を禁止する。
- レビュー：管理用のテナントの設定の変更が IaC の PR で、2 人の承認を得ている。

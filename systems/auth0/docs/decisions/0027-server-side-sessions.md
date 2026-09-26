---
status: accepted
date: 2026-09-27
---

# ADR-0027: セッションはサーバーの側に持ち、`__Host-` の Cookie には不透明な秘密だけを入れる

詳細は [sessions-and-sso.md](../architecture/sessions-and-sso.md) の 3 節。

## Context

SSO とログアウトは、エンドユーザーのセッションの上に成り立つ。セッションの形は、ログアウトの確かさ（終えたセッションで二度と SSO させない）、Back-Channel Logout、リフレッシュトークンとの関係（[ADR-0029](0029-refresh-token-session-binding.md)）を決める。

本家 Auth0（2026-09-27 に確認）：

- セッションに「使われない期間」と「最終の期限」があり、上限は Enterprise 以外で 3 日・30 日、Enterprise で 100 日・365 日。永続と非永続（`Expires=0`）を選べる（[Session Lifetime Limits](https://auth0.com/docs/manage-users/sessions/session-lifetime-limits)、[Tenant Settings](https://auth0.com/docs/get-started/tenant-settings)）。既定の値は資料になかった（未検証）。
- Management API でセッションを取り消せ、取り消しで Back-Channel Logout が送られる（[OIDC Back-Channel Logout](https://auth0.com/docs/authenticate/login/logout/back-channel-logout)）。

[ADR-0005](0005-authentication-path-availability.md) は、セッションの正本を DB に置き、Valkey をキャッシュにすると決めている。

## Options

1. **サーバーの側のセッション（Aurora が正本、Valkey がキャッシュ）。Cookie は不透明な 256 ビットの秘密で、DB にはハッシュだけ。`sid` は別の公開の値**
2. 署名・暗号化した Cookie に状態を入れる（ステートレス）
3. Valkey だけに持つ

## Decision

1 を採用する。

- Cookie は `__Host-<brand>_session`（`Secure`・`HttpOnly`・`SameSite=Lax`・`Path=/`、`Domain` なし）。ホスト名ごとに別のセッションになる。
- DB には秘密の SHA-256 だけを持つ。`sid`（ID トークン・ログアウトトークンに載る値）は別の乱数にする。
- ログインの成功、MFA の成功、再認証の成功のたびに、秘密を作り直す。
- 1 つのブラウザ × 1 つのホストにセッションは 1 つ。別の利用者でログインしたら前のセッションを終える。
- 既定は、使われない期間 3 日・最終の期限 7 日・永続。範囲の上限は 100 日・365 日（本家の Enterprise と同じ）。設定の単位はテナント。
- 「使われた」は、`/authorize` での SSO と、結び付いたリフレッシュトークンの系列の利用。`last_active_at` の書き込みは、5 分か使われない期間の 10 分の 1 の短い方ごとに間引く。
- キャッシュ（Valkey）の TTL は 60 秒。終えたセッションで SSO が通る窓の上限を 60 秒とする。
- 1 ユーザーの `active` なセッションは 100 個まで。
- 2 は、サーバーの側で終えられない（ログアウトの後も Cookie が有効のまま）。失効の一覧を持つなら、結局サーバーの状態が要る。
- 3 は、Valkey の障害で全員のセッションが消え、[ADR-0005](0005-authentication-path-availability.md) の縮退に反する。

## Consequences

- 良くなること：
  - ログアウトと取り消しが、サーバーの側で確実に効く。
  - DB が漏れても、セッションを乗っ取れない。
- 引き受けるコスト：
  - SSO の判定ごとに、キャッシュか DB の読み込みが要る。
  - テナントのホストとカスタムドメインの間で SSO が効かない。すべてのアプリで同じホストを使うよう勧める。
  - 別サイトの iframe でのサイレント認証は動かない。SPA にはリフレッシュトークンのローテーションを勧める。

## Confirmation

- 性質ベーステスト：任意の操作の列で、`ended`・`expired` のセッションが `active` に戻らない。認証の段階が変わった後、前の秘密でセッションを読めない。
- 結合テスト：Valkey の停止中も SSO が DB から続く。
- ログの走査：Cookie の値と `secret_hash` がログ・トレースに出ない。

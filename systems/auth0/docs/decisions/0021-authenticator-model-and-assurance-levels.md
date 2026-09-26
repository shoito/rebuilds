---
status: accepted
date: 2026-09-27
---

# ADR-0021: MFA の要素を認証器の共通の型で持ち、達成した AAL を `acr` で返す。メールの OTP は AAL2 に数えない

## Context

MVP の MFA の要素は、TOTP、WebAuthn・パスキー、メールの OTP、リカバリーコード。後に SMS を足す（[intent.md](../intent.md)）。アプリは、ユーザーがどれだけ強く認証されたかを知り、重要な操作の前に強い認証を求めたい（step-up）。

本家 Auth0 は、MFA を行うと ID トークンの `amr` に `mfa` を入れる。step-up の要求には `acr_values` に `http://schemas.openid.net/pape/policies/2007/06/multi-factor` を使う。メールの OTP は、他の独立した要素を登録したユーザーだけが使える（[Configure Step-up Authentication for Web Apps](https://auth0.com/docs/secure/multi-factor-authentication/step-up-authentication/configure-step-up-authentication-for-web-apps)、[MFA Factors](https://auth0.com/docs/secure/multi-factor-authentication/multi-factor-authentication-factors)、2026-09-27 に確認）。

NIST SP 800-63B-4（2026-09-27 に確認）：

- AAL2 は 2 つの異なる要素。AAL2 のアプリはフィッシングに強い選択肢を提供しなければならない。
- 同期できる認証器は AAL3 に使えない（2.3.2 節）。
- メールを out-of-band の認証に使ってはならない。
- 連続の失敗は認証器ごとに 100 回以下（3.2.2 節）。

`amr` の値は RFC 8176 に登録がある。`mfa` だけでは、どの要素か、どれだけ強いかが分からない。

## Options

1. **要素を `authenticators` の共通の型（種類ごとの子の表）で持つ。セッションに要素ごとの認証の時刻と達成した AAL を記録し、`acr` に本システムの AAL の値を返す。`amr` は RFC 8176 の値と `mfa` を返す。メールの OTP は AAL2 に数えない**
2. 本家と同じく `amr: ["mfa"]` だけを返し、`acr` は要求の値をそのまま返す
3. 要素の種類ごとに別の表と別の流れを持つ

## Decision

1 を採用する。

- `acr` の値は `https://<brand>.<domain>/acr/aal1`・`aal2`・`aal2-pr`（フィッシングに強い認証器を使った AAL2）。PAPE の multi-factor の値は要求でだけ受け、`aal2` として扱う。
- AAL3 は MVP で主張しない。
- メールの OTP で済ませた MFA は `acr` を AAL1 のままにする。`amr` には互換のため `mfa` を入れる。AAL2 の要求ではメールの OTP を選択肢に出さない。
- メールの OTP だけを持つユーザーの状態を作らない。テナントの方針でメールだけを有効にすることもできない。
- 新しい要素の登録には、直近 5 分以内の認証を求める。
- API のスコープごとに要る `acr` を設定で持つ（`resource_servers.scope_acr`）。
- 失敗の数は認証器ごとに DB に持ち、10 回で一時のロック、通算の連続 100 回で無効にする。
- 2 は、メールの OTP とパスキーを区別できず、アプリが保証の水準を判断できない。
- 3 は、ロック・通知・監査の処理が要素ごとに重複する。

## Consequences

- 良くなること：
  - アプリが `acr` で保証の水準を判断でき、NIST の AAL で説明できる。
  - メールの受信箱を取られた攻撃者が、MFA を満たしたことにならない（AAL2 の要求で）。
- 引き受けるコスト：
  - 本家の `amr` だけを見るアプリは、メールの OTP でも `mfa` を見る（互換のため）。文書で `acr` を使うよう示す。
  - `acr` の独自の値を、discovery と文書で説明する必要がある。

## Confirmation

- 決定表のテスト：[mfa-and-passkeys.md](../architecture/mfa-and-passkeys.md) の 6.1・6.4・11.1 の各行。
- 性質ベーステスト：任意のログインの手段の列で、`acr` が AAL2 以上なら、2 つ目の要素がメールの OTP だけではない。
- 性質ベーステスト：方針が MFA を求めるとき、Universal Login のどの遷移の列でも、MFA を済ませずにトークンが発行されない。

## References

- 設計の詳細：[mfa-and-passkeys.md](../architecture/mfa-and-passkeys.md) の 3・6・7 節
- NIST: [SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b.html)
- IETF: [RFC 8176](https://www.rfc-editor.org/rfc/rfc8176)、[RFC 9470](https://www.rfc-editor.org/rfc/rfc9470)

---
status: accepted
date: 2026-10-04
---

# ADR-0043: 認証は Better Auth を包んで使い、パスワードを持たない。登録には電話かメールの確認を必須にし、セッションの写しを Valkey に置いて取り消しを 5 秒で効かせる

## Context

本システムは公開の SNS で、誰でも登録できる。登録と公開 API は、スパムとボットの入口になる（[architecture/README.md](../architecture/README.md) の 6 節）。日本の利用者の大半はスマートフォンで使い、毎回のログインを嫌う。報道機関・自治体の公式のアカウントが乗っ取られると、偽の情報が数百万人に届く。

- 本家は、電話番号かメールで登録し、パスワード・Google・Apple・パスキーでログインするとされる（help.x.com は 403 で**未検証**）。
- Better Auth（MIT）は、電話番号の OTP（6 桁、既定 300 秒、試行 3 回）、メールの OTP、パスキー、Google・Apple、複数のセッションの部品を持つ（[Phone Number](https://www.better-auth.com/docs/plugins/phone-number)、[Apple](https://www.better-auth.com/docs/authentication/apple)、2026-10-04 に確認）。Linear の題材が評価して採用した（Linear の ADR-0034）。
- App Store の 4.8 は、第三者のログインで主のアカウントを作るアプリに、同等の別のログインの手段を求める（[App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)、2026-10-04 に確認）。

## Options

認証の部品：

1. **Better Auth を `packages/auth` で包む**
2. 自前で組む（SimpleWebAuthn、OIDC のクライアント）
3. 管理された IdP（Cognito など）

パスワード：

- a. **持たない**（パスキー、OTP、Google・Apple）
- b. 持つ（本家と同じ）

セッション：

- x. **Web はクッキー、アプリは不透明なトークン。写しを Valkey に置く**
- y. 署名付きの JWT（状態を持たない）

## Decision

1、a、x を採用する。詳細は [accounts-and-auth.md](../architecture/accounts-and-auth.md) の 3〜6 節。

- 使う部品：核、`phone-number`、`email-otp`、`@better-auth/passkey`、Google・Apple、`multi-session`。パスワードと組織と OAuth の提供者の部品は使わない。
- 登録には、電話番号（MVP は日本の番号だけ）かメールアドレスの確認を必須にする。電話の確認がないアカウントは、利用者の行動の上限を下げる（[api-and-rate-limits.md](../architecture/api-and-rate-limits.md) の 5.3 節）。
- 利用者の ID は `tid`（[ADR-0002](0002-post-ids-and-ordering.md)）で、Better Auth の `user.id` に渡す。
- 強いログインの設定（パスキーだけ）を置き、大きなアカウントに勧める。
- 連絡先の変更は 48 時間の保留に入れ、古い連絡先から取り消せる。
- セッションは Web 30 日・アプリ 90 日（使わないまま）。写しを `vk-edge` に 10 分の TTL で置き、取り消しは写しの削除と pub/sub で 5 秒以内に全入口へ効かせる。
- 2 を採らない理由：パスキー・OTP・Apple の各部品を自前で書くと、認証の誤りの面が広がる。
- 3 を採らない理由：利用者の表が外に出て、`tid` の利用者の ID と、Aurora の中の状態（凍結、年齢の区分）との結び付けが二重になる。
- b を採らない理由：使い回しのパスワードの乗っ取り（クレデンシャルスタッフィング）の入口になる。パスキーと OTP で足りる。
- y を採らない理由：取り消し（乗っ取り、凍結）を 5 秒で効かせるには、結局、取り消しの一覧を引く必要がある。

## Consequences

- 良くなること：
  - パスワードの漏えいと使い回しの乗っ取りがない。
  - 取り消しが速い。凍結・乗っ取りの対応が全入口に効く。
- 引き受けるコスト：
  - SMS の送信料と、その詐取への備え（上限、Valkey が落ちたら止める）。
  - OTP だけのアカウントは、電話番号の乗っ取り（SIM の差し替え）に弱い。パスキーを勧め、強いログインを用意する。
  - Better Auth のバージョンの追従（脆弱性の告知が多い）。
  - Valkey の写しを失うと、セッションの確かめが `auth` に集中する（[capacity.md](../architecture/capacity.md) の 4 節）。

## Confirmation

- 表駆動テスト：DT-AUTH-001（結び付け）。
- 性質ベーステスト：PROP-AUTH-001（取り消したセッションは 10 分を超えて使えない）、PROP-AUTH-002（保留の間の取り消しが勝つ）。
- lint：Better Auth の型と関数を `packages/auth` の外から使わない。
- E2E：電話・メール・パスキー・Apple の登録とログイン。

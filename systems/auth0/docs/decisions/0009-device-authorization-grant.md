---
status: accepted
date: 2026-09-27
---

# ADR-0009: デバイスの認可は RFC 8628 に従い、BASE20 の 8 文字のユーザーコードと、明示の確認の画面で行う

詳細は [authentication-flows.md](../architecture/authentication-flows.md) の 7.4 節。

## Context

テレビや CLI など、ブラウザや入力の限られた端末のログインに、デバイス認可グラント（RFC 8628）を使う（[intent.md](../intent.md) の MVP）。

- 本家 Auth0 は、`expires_in` 900 秒、`interval` 5 秒。ユーザーコードの文字の種類と長さ（マスク）をテナントが決められ、BASE20 なら 8 文字以上。アプリは Native で、トークンのエンドポイントの認証は `none` に限る（[Call Your API Using the Device Authorization Flow](https://auth0.com/docs/get-started/authentication-and-authorization-flow/device-authorization-flow/call-your-api-using-the-device-authorization-flow)、[Tenant Settings](https://auth0.com/docs/get-started/tenant-settings)、2026-09-27 に確認）。
- RFC 8628 の 6.1 節は、BASE20 の 8 文字（約 34.5 ビット）を例に、ユーザーコードの総当たりにはレート制限が要るとする。5.4 節は、攻撃者が自分の端末のコードを被害者に入れさせる遠隔のフィッシングを挙げ、確認の画面で端末を示すよう勧める。

## Options

1. **ユーザーコードは BASE20 の 8 文字で固定。確認の画面で「許可」を押させる。有効 900 秒、`interval` 5 秒**
2. 本家と同じく、文字の種類と長さをテナントが決める
3. `verification_uri_complete` から来たら確認なしで承認する

## Decision

1 を採用する。

- `user_code` は BASE20（`BCDFGHJKLMNPQRSTVWXZ`）の 8 文字、表示は `XXXX-XXXX`。入力は大文字・小文字と区切りを無視する。
- `device_code` は 256 ビットの乱数。両方ともハッシュだけを保存する。
- 有効 900 秒、`interval` 5 秒。速すぎる問い合わせには `slow_down` を返し、`interval` を 5 秒延ばす。
- `/activate` で、ログインの後に確認の画面（アプリ名、スコープ、コード）を必ず出す。
- `/activate` の誤入力は、IP ごと・セッションごとに数えて止める（値は attack-protection.md）。
- 対象は Native で `none` のアプリ（本家と同じ）。
- 2 は、短いコード（数字 6 桁など）を許すと総当たりの余地が増える。文字の種類の変更は、需要が出たら長さの下限を保って足す。
- 3 は、遠隔のフィッシングを通しやすい。

## Consequences

- 良くなること：
  - コードの推測と遠隔のフィッシングへの備えが、既定で入る。
- 引き受けるコスト：
  - 数字だけのコード（テレビのリモコンで打ちやすい）を求めるテナントに応えられない。
  - QR から来ても 1 回の操作が増える。

## Confirmation

- 性質ベーステスト：任意のポーリングの列で、`interval` より速い問い合わせは `slow_down` を受け、`interval` は減らない。承認の後、トークンが出るのは 1 回だけ。
- 結合テスト：期限切れの後は `expired_token`、拒否の後は `access_denied`。
- E2E：`verification_uri_complete` から来ても、「許可」を押すまでトークンが出ない。

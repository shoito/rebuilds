---
status: accepted
date: 2026-09-27
---

# ADR-0035: レート制限は本家の単位と Enterprise の値に寄せ、環境で変えてプランで変えず、Valkey の GCRA で数え、リフレッシュを優先する

詳細は [management-api-and-rate-limiting.md](../architecture/management-api-and-rate-limiting.md) の 5〜8 節。

## Context

共有の認証の経路と DB（[ADR-0002](0002-tenancy-and-isolation.md)）で、1 つのテナントの急増や不具合が、他のテナントのログインを遅らせてはならない。一方で、ログインとトークンの更新を 429 で断ると、テナントのアプリが止まる。

本家の振る舞い（2026-09-27 に確認。[Rate Limit Policy](https://auth0.com/docs/troubleshoot/customer-support/operational-policies/rate-limit-policy)、[Enterprise](https://auth0.com/docs/troubleshoot/customer-support/operational-policies/rate-limit-policy/rate-limit-configurations/enterprise-public)、[Rate Limit Use Cases](https://auth0.com/docs/troubleshoot/customer-support/operational-policies/rate-limit-policy/rate-limit-use-cases)）：

- トークンバケット。単位は API とエンドポイント、テナントの種類（本番・本番以外）、場合により IP・ユーザー。
- Enterprise：認証 API はテナントで 1 秒 100。Management API は本番でバースト 50・1 秒 16、本番以外でバースト 10・1 秒 2。
- 値はプランで変わる。
- `x-ratelimit-limit`・`x-ratelimit-remaining`・`x-ratelimit-reset` の見出しと 429。超えると `api_limit` のログ。

Slack（ADR-0029・0033）と Stripe（ADR-0009）の再構築では、層、Valkey の GCRA、障害時の振る舞いを決め、プランで値を変えないとした。

## Options

1. **本家の単位と Enterprise の値を初期値にし、Slack・Stripe の仕組みで実装する。値は環境（本番・本番以外）で変え、プランでは変えない**
2. 本家と同じく、プランで値を変える
3. API Gateway・WAF だけで制限する

## Decision

1 を採用する。

- 層：エッジ（WAF）→ 認証のエンドポイント（IP、ユーザー、IP × メール、`state`）→ 認証のテナント → 管理のテナント → 管理のエンドポイント → 同時実行。
- 値：認証 API のテナントの枠は本番 1 秒 100、本番以外 1 秒 25。Management API は本番でバースト 50・1 秒 16、本番以外でバースト 10・1 秒 2。エンドポイントごとの値は本家の公開値（Enterprise、なければ Essentials・Professional）を初期値にする。一覧は設計の文書の 6 節。
- **本番以外の認証 API は、本家（1 秒 100）より低い 1 秒 25 にする。** 本番以外は SLO の対象外で、共有の資源を占有させないため。
- **リフレッシュトークンの交換は、テナントの枠を超えても 120% まで通す。** ADR-0005 の優先の順（更新が最優先）に合わせる。
- 計数は Valkey の GCRA（Lua、1 往復）。キーはテナントのハッシュタグ。IP とメールは日ごとの鍵の HMAC でキーにする。
- 見出しは本家と同じ名前で全応答に付け、429 に `Retry-After` を足す。`api_limit` のログはテナント × 制限ごとに 1 分 1 件に間引く。
- Valkey の障害時は、タスクの中の近似の制限で続ける（全部を通さない。ADR-0005）。
- 緩和はテナントごとの期限つきの上書きだけで、Ops が承認し、プラットフォームの監査に残す。
- 2 は、プランの設計がまだなく、値の表がプランの数だけ増える。Slack・Stripe と同じく、プランで変えない。
- 3 は、テナント・ユーザー・`state` の単位と、Valkey の障害時の近似を表せない。

## Consequences

- 良くなること：
  - 本家から移る利用者が、上限の値と見出しをそのまま理解できる。
  - Slack・Stripe の実装と運用を使い回せる。
- 引き受けるコスト：
  - 本家の安いプランの利用者より、本システムの本番の枠は大きい（全テナントに Enterprise の値）。容量（capacity の領域）はこれを前提にする。
  - 本番以外の枠は本家の Enterprise より小さい。本家で本番以外に負荷をかけていた利用者は、移行で 429 に当たりうる。文書に書く。
  - 判定のたびに Valkey に 1 往復する。NFR-002・NFR-003 の遅延の予算に含める。

## Confirmation

- 性質ベーステスト：許した件数が、持続の速さ × 時間 ＋ バーストを超えない。同時実行の数が上限を超えない。
- 表駆動テスト：応答の表（状態、本文、見出し、`Retry-After`）。
- 結合テスト：Valkey の停止中、認証 API は通り、タスクの中の近似が働く。
- 結合テスト：テナントの枠を超えた状態で、`refresh_token` の交換が 120% まで通り、ログインは 429 になる。
- レビュー：各領域の文書の上限の値が、management-api-and-rate-limiting.md の 6 節と一致する。

---
status: accepted
date: 2026-09-27
---

# ADR-0041: 管理 API は `/v1` のパスの版で足す変更だけを入れ、冪等キー・不透明なカーソル・RFC 9457 のエラーを使う

詳細は [dashboard-and-api.md](../architecture/dashboard-and-api.md) の 4 節。

## Context

intent の MVP は、アカウント、関数、ルート、ドメイン、ストレージ、ログ、使用量の画面と API を含む。CLI・ダッシュボード・利用者の自動化（CI）が同じ API を使う。CLI の `deploy` は、網の切断での再送で版を 2 つ作ってはならない（[developer-tooling.md](../architecture/developer-tooling.md) の 4.4 節）。

本家（2026-09-27 に確認）：API は `/client/v4/` の 1 つの版で、応答は `success`・`result`・`result_info` の包み、一覧は `page`・`per_page`（[Make API calls](https://developers.cloudflare.com/fundamentals/api/how-to/make-api-calls/)）。レート制限は利用者ごとに 5 分に 1,200 で、超えると次の 5 分は全て 429（[Rate limits](https://developers.cloudflare.com/fundamentals/api/reference/limits/)）。

rebuilds の他の題材は、Stripe の題材で日付の版を、Kafka の題材でパスの版（`/v1`）を選んだ。

## Options

1. **`/v1` のパスの版で足す変更だけ。POST の冪等キー、不透明なカーソル、`If-Match`、RFC 9457、滑る窓のレート制限**
2. 日付の版（`<Brand>-Version: 2026-09-27`）と、版ごとの変換の層
3. 本家と同じ形（包み、`page`・`per_page`、固定の 5 分の窓）

## Decision

1 を採用する。

- 入口は `https://api.<console-domain>/v1`。`/v1` の中では足す変更だけ。壊す変更は `/v2` にし、`/v1` を 12 か月以上動かす。`Deprecation`・`Sunset` のヘッダーで知らせる。
- すべての POST が `Idempotency-Key` を受ける。範囲はアカウント×キー、24 時間、同じ要求には同じ応答。版の作成の再送は同じ版を返す。
- 一覧は `limit` と暗号化した不透明な `cursor`（条件のハッシュを含み、24 時間）。総件数は返さない。
- 変えられる資源は `etag` と `If-Match`。デプロイの作成は、いまのデプロイの ID の `If-Match` を受ける。
- エラーは `application/problem+json`（RFC 9457）に `code` と `request_id`。他のアカウントの資源は 404。
- レート制限は、トークン・利用者ごとに 5 分 1,200（本家と同じ値）、アカウントごとに 5 分 6,000。1 分の桶 5 つの滑る窓。`RateLimit-Policy`・`RateLimit`・`Retry-After`。
- 長い操作（版の作成、ドメインの確認）は 202 と資源の `status` で追う。
- API は `@hono/zod-openapi` で書き、OpenAPI 3.1 を公開する。CLI とダッシュボードは、そこから生成した `@<brand>/api` を使い、同じハンドラーを通る。
- 2 を採らない理由：資源が少なく、主な利用者は版を固定した CLI。日付の版の変換の層を保つ手間に見合わない。
- 3 を採らない理由：頁の番号は書き込みの多い一覧（版、監査ログ）でずれる。包みは HTTP の状態コードと重なる。固定の窓は、窓の終わりまで全てを止め、CI の再試行を長く止める。

## Consequences

- 良くなること：
  - 再送で重複の資源ができない。
  - 一覧が並行の書き込みでずれない。
  - CLI・ダッシュボード・利用者の自動化で、検証・権限・監査が 1 か所にある。
- 引き受けるコスト：
  - 本家の SDK やツールはそのまま使えない（リポジトリ共通の ADR-0006 の引き受けたコストと同じ）。
  - 冪等キーの応答を 24 時間保存する表を持つ。
  - 頁の番号で飛ぶ操作（最後の頁へ）はできない。

## Confirmation

- 表駆動テスト：冪等（同じキー同じ本文、違う本文、処理中、保存しない状態コード）、カーソル（条件の変更、期限切れ、他のアカウント）、`If-Match` の不一致。
- 契約テスト：OpenAPI から生成したクライアントと実装の応答の形が合う。
- CI の検査：`/v1` の OpenAPI の差分に、欄の削除・型の変更・必須の追加がない。

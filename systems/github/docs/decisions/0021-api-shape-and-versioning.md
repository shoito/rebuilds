---
status: accepted
date: 2026-09-26
---

# ADR-0021: 公開 API は本家の形に寄せ、REST は日付の版をヘッダーで選び、GraphQL は版を持たずに育てる

> 識別子（ヘッダー・接頭辞・ドメイン・環境変数・パスの名前）は、リポジトリ共通の [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md) に合わせて `<Brand>`・`<brand>`・`<BRAND>` の置き換え用の名前にした（2026-09-26）。本家の名前は、出典の説明としてだけ書く。

## Context

intent.md は、REST と GraphQL の API を MVP に含め、AI エージェントが使いやすいことを論点にしている。本家の API は、`gh`、Octokit、多数の CI の道具が使い、AI エージェントも学習している。

Slack の公開 API（Slack の [ADR-0030](../../../slack/docs/decisions/0030-versioned-public-api.md)）は、本家の SDK との互換を目的にせず、`/v1` の URL の版にした。GitHub では、本家の形に寄せることの価値が大きい。

本家の REST は、`X-GitHub-Api-Version: YYYY-MM-DD` のヘッダーで版を選び、ヘッダーがなければ最初の版を使い、新しい版を出したら前の版を少なくとも 24 か月動かす（[API versions](https://docs.github.com/en/rest/about-the-rest-api/api-versions)、2026-09-26 に確認）。GraphQL は版を持たず、点数で費用を数える（[GraphQL rate limits](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api)、2026-09-26 に確認）。

## Options

1. **本家の形（パス、項目、ヘッダー、エラー、ページング）に寄せ、REST は日付のヘッダーの版、GraphQL は版なし**
2. 独自の形で、URL の大きな版（Slack と同じ）
3. GraphQL だけを出す

## Decision

1 を採用する。詳細は [api-and-webhooks.md](../architecture/api-and-webhooks.md) の 1〜5 節にある。

- **形を本家に寄せるが、完全な互換は約束しない。** 実装した操作の一覧を公開し、未実装の本家の操作には `501` と文書の URL を返す。
- **REST の版は、本家と同じ形の日付のヘッダー（`X-<Brand>-Api-Version`。本家の `X-GitHub-Api-Version` に相当）。** ヘッダーがなければ最初の版。前の版を 24 か月以上動かす。互換を壊す変更の分類も本家に合わせる。追加はすべての版に同時に入れる。
- **版の実装は、内部の形を最新に保ち、版ごとの差分を「変換のモジュール」として新しい順にかける**（Stripe の日付の版と同じ）。
- **GraphQL は版を持たない。** `@deprecated` で予告し、3 か月以上たってから、決まった日にまとめて削除する。費用は実行の前に静的に計算する（本家と同じ式と上限）。
- REST と GraphQL は、同じサービス関数と `can()` を通る。内部の API（Hono RPC）とは別の面にし、互換を約束するのは公開の面だけにする。
- 本家にない追加は、互換を壊さない追加の項目としてだけ入れる：`Idempotency-Key`、エラーの `errors[].code` の `missing_permission`。
- 2 は、既存の道具とエージェントの知識を捨てることになる。GitHub の利用者は本家の API を前提に自動化を書いている。
- 3 は、本家の利用者の多くが REST を使っており、Webhook のペイロードも REST の形である。

## Consequences

- 良くなること：
  - 本家の API を知る利用者と AI エージェントが、少ない手直しで使える。本家の SDK（Octokit）や `gh` をそのまま使えることは目標にしない（ADR-0006）。公式の SDK と CLI を用意する。
  - 日付の版で、互換を壊す変更を利用者のペースで取り込める。
- 引き受けるコスト：
  - 本家の形に合わせるため、自分たちで形を選ぶ自由が減る。本家の形の不整合もそのまま引き継ぐ。
  - 版の変換のモジュールを、24 か月以上、版ごとに保つ。
  - 部分的な互換は、利用者に「どこまで使えるか」を誤解させうる。実装した操作の一覧と `501` で明示する。
  - ヘッダーの名前・接頭辞は本家と違うので、本家の道具を向けるには置き換えが要る（ADR-0006）。

## Confirmation

- CI：OpenAPI を生成して差分を検査し、同じ版の中で互換を壊す変更を失敗させる。版の変換のモジュールを、版ごとの応答のスナップショットで検査する。
- CI：本家の公開の OpenAPI 記述と、実装した操作の形（パス、必須の項目、型）を比べ、食い違いを一覧にする（許可した差分以外は失敗）。
- 結合テスト：公式の SDK と CLI で、代表の操作を通す。GraphQL の費用の計算が、実行前の値 ≥ 実際の値になる。

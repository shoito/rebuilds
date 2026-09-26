---
status: accepted
date: 2026-09-26
---

# ADR-0030: 版を持つ公開 API を、内部の API と別の面として提供する

## Context

intent.md は、汎用の公開 API を「外部公開 API の互換性を維持する負担が大きい」として MVP の対象外にしていた。一方で、アプリの基盤（[ADR-0031](0031-app-platform.md)）を MVP の後の E12 で出すことが決まり、アプリが呼ぶ API が要る。

今ある API は次の 2 つで、どちらもそのままは公開 API にできない。

- 内部の API（Hono RPC。[ADR-0008](0008-hono-rpc-for-api-contract.md)）：Web クライアントと同時にデプロイする前提で、外部への互換性を約束しない。Cookie のセッションで動く。
- MCP（[ADR-0028](0028-remote-mcp-server.md)）：AI エージェント向けに絞った面で、ツールの数が少ない。

公開は MVP の後だが、URL・認証・エラー・版の形は、後から変えるコストが高い。内部の設計（サービス関数の分け方、本文の形）が公開の妨げにならないよう、今決める。

## Options

### 面の分け方

1. 内部の API をそのまま公開し、互換性を約束する
2. 公開 API を別の面（別のサービス、別の契約）として持ち、同じドメイン層を呼ぶ
3. 公開 API を持たず、MCP を広げて代わりにする

### URL の形

A. リソース指向（REST）：`/v1/workspaces/{ws}/channels/{id}/messages`
B. メソッド名の RPC（本家の `chat.postMessage` 型）

### 版

a. URL の大きな版（`/v1`）
b. 日付の版をヘッダーで選ぶ（Stripe 型）

## Decision

2・A・a を採用する。設計の詳細は [public-api.md](../architecture/public-api.md) にある。

- **別の面にする（2）。** 1 は、Web のための変更のたびに外部の互換性を考えることになり、内部の開発を遅くする。3 は、MCP の「小さな面」の方針（ADR-0028）を崩す。2 なら、内部の API は ADR-0008 のまま自由に変えられ、公開 API だけが互換性を約束する。
  - `api.<domain>` の独立した ECS サービス（`apps/public-api`）にし、Bearer トークンだけを受け付ける。外部の急増が Web の投稿の遅延に響かず、障害時に単独で止められる。
  - 内部の API、公開 API、MCP の 3 つの面は、同じサービス関数（`packages/domain`）を呼ぶ。権限の判定（ADR-0005）、テナントのコンテキスト（ADR-0009）、冪等性はサービス関数の側に置き、面どうしは HTTP で呼び合わない。
- **リソース指向（A）。** 内部の API と同じ形で、サービス関数との対応をそのまま使える。`PUT`・`DELETE` の冪等性とステータスコードを、汎用の道具が解釈できる。パスの `workspace_id` で、S3 のセルへ振り分けられる。本家の SDK との互換は目的にしない。
- **URL の大きな版（a）。** `/v1` の中では追加だけを行い、互換性を壊す変更は `/v2` として出す。古い版は最低 12 か月動かす。b は多くの版を 1 つのコードで保つ変換の層が要り、今の規模に合わない。
- **契約は `@hono/zod-openapi` で OpenAPI 3.1 を出す。** ADR-0008 が「外部公開 API が必要になったときに移る」とした形である。公開用の Zod スキーマは `packages/contract/public/v1` に分け、内部のスキーマを import しない。
- **本文は「公開のリッチテキスト v1」** とし、形は本文の AST（[ADR-0006](0006-message-body-ast.md)）の v1 から始めるが、変換関数で内部の AST と切り離す。書き込みでは、メンションの記法だけを持つプレーンテキストも受け付ける。Markdown は解釈しない。
- **エラーは RFC 9457、ページングは不透明なカーソル、書き込みの冪等性は `Idempotency-Key`**（投稿では `client_msg_id` に変換する）。
- **廃止は `Deprecation`（RFC 9745）・`Sunset`（RFC 8594）のヘッダーと、呼び出しの残るアプリへの個別の連絡で告知する。** 個別の廃止の告知は最低 6 か月前。
- **レート制限は [rate-limiting.md](../architecture/rate-limiting.md) の tier を各操作に割り当てる。** 429 には `Retry-After` と `RateLimit-Policy`・`RateLimit`（IETF の draft-11。RFC ではない）を付ける。
- **公式の SDK は TypeScript の 1 つだけ。** 他の言語は OpenAPI からの生成に任せる。
- **トークンは、ボットのトークン（本システムが発行）と、ユーザーのトークン（Better Auth の oauth-provider が発行する OAuth 2.1 のトークン）の 2 種類。** アプリ単位のトークンと個人のアクセストークンは持たない。

## Consequences

- 良くなること：
  - 内部の API は、外部の互換性に縛られずに変えられる。
  - アプリ・MCP・Web のどこから呼んでも、同じ権限の判定と冪等性が効く。
  - OpenAPI から、文書・SDK・互換性の検査を作れる。
- 悪くなること、引き受けるコスト：
  - `/v1` の形を長く保つ責任を負う。公開用のスキーマと変換関数を、内部とは別に保守する。
  - サービスが 1 つ増える（デプロイ、監視、容量の対象）。
  - 本家の SDK やサンプルを流用できず、開発者は新しい API を学ぶ必要がある。
  - `RateLimit` のヘッダーと `Idempotency-Key` は IETF の草案で、書式が変わりうる。変わったら、公開 API の変更として告知する。
  - Better Auth の oauth-provider での、ワークスペースへの結び付け（`consentReferenceId`）とアクセストークンの項目の加え方は未検証で、合わなければ自前の実装を足す。

## Confirmation

- CI：`packages/contract/public/v1/openapi.json` を再生成して差分を検査し、契約の変更の承認がなければ失敗させる。OpenAPI の差分の検査の道具で、`/v1` の中での互換性を壊す変更（削除、型の変更、必須化、列挙値の削除）を失敗させる。
- lint：`packages/contract/public` から内部のスキーマへの import を禁止する。`apps/public-api` から `apps/api` のルートへの import と、面どうしの HTTP の呼び出しを禁止する。
- 性質ベーステスト：公開 API が返すデータは、同じメンバーが内部の API で読めるデータの部分集合で、スコープの範囲に収まる。
- 結合テスト：別のワークスペースのトークン、`aud` が MCP のトークン、取り消し済みのトークンを拒否する。`Idempotency-Key` の決定表（[public-api.md](../architecture/public-api.md) の 5.3 節）。
- 廃止の運用：廃止予定の操作の呼び出し数をアプリごとに数え、止める前に 0 か、個別の連絡が済んでいることを確かめる。

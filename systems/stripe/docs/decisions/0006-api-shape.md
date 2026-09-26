---
status: accepted
date: 2026-09-26
---

# ADR-0006: 公開 API は本家 v1 のリソースの形に寄せ、本文は JSON にする

## Context

公開 API は、この題材の製品そのものである。URL、本文の形式、ID、ページング、エラーの形は、公開した後に変えるコストが最も高い。intent.md は「一貫した API」を価値の 1 つ目に置いている。

本家 Stripe は次の形を持つ（2026-09-26 に確かめた）。

- v1：リソース指向の `/v1/...`、要求は `application/x-www-form-urlencoded`、応答は JSON。`starting_after` / `ending_before` のカーソル、`expand`、`metadata`、`type`・`code`・`decline_code` を持つエラー（[API reference](https://docs.stripe.com/api)）
- v2：要求も応答も JSON、ページングは `next_page_url`、`expand` はなく `include`、`metadata` の削除は `null`（[API v2 overview](https://docs.stripe.com/api-v2-overview)）

Slack の再構築では、公開 API を RFC 9457 のエラーと不透明なカーソルで設計した（Slack の ADR-0030）。

## Options

### 本文の形式

1. 本家 v1 と同じ form-encoded
2. JSON（本家 v2 と同じ）
3. 両方を受ける

### 全体の形

A. 本家 v1 の形（リソース、`POST` での更新、ID のカーソル、`expand`、本家のエラーの形）
B. Slack の公開 API の形（RFC 9457、不透明なカーソル、`PATCH`）

## Decision

2 と A を採用する。詳細は [api.md](../architecture/api.md) にある。

- **形は本家 v1 に寄せる（A）。** リソースと URL、更新の `POST`、`id`・`object`・`livemode`・`created` の共通の項目、金額の整数、Unix 秒の時刻、`starting_after` / `ending_before` / `has_more` のページング、`expand`（最大 4 段）、`metadata`（50 キー、40 文字、500 文字）、エラーの `type`・`code`・`decline_code`・`param`。開発者が本家の文書と知識をそのまま使える。B は汎用の標準に近いが、決済の開発者が慣れた形から外れ、`decline_code` のような決済に固有の項目を持つ場所がない。
- **本文は JSON にする（2）。** 型（整数・真偽値・`null`・入れ子）をそのまま表せ、Zod と OpenAPI のスキーマがそのまま効く。form-encoded の独自の角括弧の記法を自前で解釈し、金額を文字列から読み直す層が要らない。本家自身も v2 で JSON に移っている。3 は検証の面を 2 倍にする。
  - `metadata` のキーの削除は、JSON に合わせて `null` にする（本家 v2 と同じ）。
  - クエリの配列は本家と同じ角括弧の記法（`expand[]=`）にする。
- **ID は `<接頭辞>_<UUIDv7 の base62>`。** 接頭辞は本家に合わせ、DB には `uuid` で持つ。ID の順が作成の順なので、ID をそのままカーソルにできる。
- **見出しの意味と値は本家に合わせ、`Stripe-` の接頭辞だけを製品名にする**（`<Brand>-Version`、`<Brand>-Should-Retry`、`<Brand>-Rate-Limited-Reason`）。本家の名前を名乗らないため。製品名を含まない `Request-Id`、`Idempotency-Key`、`Idempotent-Replayed` は本家と同じ名前にする。キーの接頭辞も同じ考え方で `<brand>_{pk|sk|rk}_{live|test}_` にする（リポジトリ共通の [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)、[ADR-0008](0008-api-keys-and-dashboard-access.md)）。
- **本家の SDK との互換は約束しない。** 本文が JSON なので、本家の SDK の接続先を変えただけでは動かない。公式の SDK は TypeScript の 1 つを OpenAPI から生成する。

## Consequences

- 良くなること：
  - 本家の文書・記事・知識が、ほぼそのまま通じる。
  - 契約（Zod・OpenAPI）と実装の間に、form の変換の層がない。
- 悪くなること、引き受けるコスト：
  - `curl -d a=b` の手軽さと、本家の SDK の流用を失う。
  - 本家 v1 と JSON の組み合わせは本家にない形で、本家の文書と細部（`metadata` の消し方、本文の例）がずれる。文書で違いを明示する。
  - ID から作成の時刻が分かる（`created` を公開しているので、新たに漏れる情報はない）。

## Confirmation

- CI：OpenAPI を再生成し、全エンドポイントが共通の項目（`id`・`object`・`livemode`・`created`）と、`x-permission`・`x-rate-limit` を持つことを検査する。
- lint：`packages/contract/public` の外で、公開のエラーの `code` の文字列を直に書かない（列挙を使う）。
- 表駆動テスト：`metadata` の上限と更新の意味、`expand` の深さ、ページングのパラメーターの組。

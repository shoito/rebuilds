---
status: accepted
date: 2026-09-28
---

# ADR-0050: Webhook は値を入れない薄い事象を、Standard Webhooks に寄せた HMAC-SHA256 の署名で少なくとも 1 回送り、送る時点で購読の主体の ACL で確かめる。レート制限はテナントとクライアントのトークンバケットで、使いすぎは 429、容量の都合は 503 にする

詳細は [api-and-integrations.md](../architecture/api-and-integrations.md) の 6・7 節。

## Context

[access-control.md](../architecture/access-control.md) の 6.2 節の 12 行は、Webhook の本文に ID と変わったフィールドの ID だけを入れ、値は受け手が API で取ると決めた。フローの外への呼び出しは outbox から少なくとも 1 回で送り、冪等のキーを付ける（[ADR-0004](0004-workflow-and-sla-engine.md)、[workflow-engine.md](../architecture/workflow-engine.md) の 5.5 節）。共有のセルでは、1 つのテナントの使いすぎが他のテナントを遅らせる（[ADR-0002](0002-tenancy-and-isolation.md)）。

事実（2026-09-28 に確認）：

- Standard Webhooks は、`webhook-id`・`webhook-timestamp`・`webhook-signature` のヘッダーと、`id.timestamp.本文` の HMAC-SHA256 を定める（[仕様](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md)）。
- 本家のレート制限は、利用者・ロール・全員ごとの 1 時間あたりの数で、ノードごとに数えて 30 秒ごとに DB に書く。超えたら 429 と `Retry-After`（[Inbound REST API rate limiting](https://www.servicenow.com/docs/bundle/zurich-api-reference/page/integrate/inbound-rest/concept/inbound-REST-API-rate-limiting.html)）。

## Options

### Webhook の本文

1. **薄い事象（ID、番号、バージョン、変わったフィールドの名前）**
2. レコードの値を入れる（購読の主体で読める値だけ）

### 署名

- a. **Standard Webhooks の形（名前は `<Brand>-`）**
- b. 独自の形
- c. 署名なし（受け手の許可の一覧の IP だけ）

### レート制限

- x. **テナント・クライアント・利用者のトークンバケット（秒の単位）＋重い要求の同時の実行の上限**
- y. 本家に近い 1 時間の窓の数

## Decision

1、a、x を採用する。

- 本文：配達の ID、種類、時刻、テーブル、レコードの ID・番号・バージョン、購読の主体が読める変わったフィールドの名前。読めるフィールドが変わっていなければ送らない。
- 配達：事象ごとに購読を選び、送る時点で購読の主体の `read` と `condition`（`visible(f)`）を確かめ、`(event, subscription)` の一意の配達の行を作って送る。順序は約束せず、受け手はバージョンで古い事象を捨てる。再試行は 24 時間、失敗が 72 時間続いたら購読を無効にする。1 購読 5・1 テナント 50 の同時の送信。
- 署名：`<Brand>-Webhook-Id`・`-Timestamp`・`-Signature: v1,<base64>`。秘密は `<brand>_whsec_`、入れ替えの間は 2 つの署名。フローの `call_webhook` も同じ部品で署名する。
- 送信の先：`https:` と許可の一覧のホストだけ。名前解決の後の IP を検査し、リダイレクトを追わず、egress の固定の IP から送る。
- レート制限：テナント（本番 1 秒 100 の重み・上限 1,000）、クライアント（50・500）、画面の利用者（20・100）、重い要求の同時の実行。Valkey のトークンバケットで、Valkey が落ちたらタスクのメモリーの近似。`<Brand>-RateLimit-*` と `Retry-After`。容量の都合は 503。

2 を採らない理由：送る時点で読める値でも、受け手のシステムの中で、購読の主体より広い人に見られうる。値を API で取らせれば、受け手の側の主体で毎回判定される。事象の時点と送る時点の権限の食い違いも生まない。

b を採らない理由：受け手の検証の道具を 1 から用意することになる。公開の仕様に寄せれば、既存の検証の実装を参考にできる（名前は変える。[リポジトリ共通の ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。

c を採らない理由：IP の許可の一覧は、送り手のなりすまし（同じクラウドの IP）と本文の改ざんを防げない。

y を採らない理由：1 時間の窓では、連携の一斉の再試行の山を秒の単位で抑えられない。

## Consequences

- 良くなること：
  - Webhook からの値の漏れの経路がない。
  - 1 つのテナント・クライアントの使いすぎが、他を待たせにくい。
- 引き受けるコスト：
  - 受け手は、事象ごとに API を呼ぶ。API の読み取りが増える（レート制限の重みの設計に入れる）。
  - 順序を約束しないので、受け手はバージョンで見分ける実装が要る。検証の見本を公開する。

## Confirmation

- 決定表 DT-WH-001（配達の判定）。
- 性質ベーステスト PROP-WH-001（署名の往復）、PROP-WH-002（配達は漏らさない）。
- SSRF の試験（プライベートの IP、メタデータのアドレス、リダイレクト）。
- 結合テスト：Valkey を止めたときの近似のバケットで、上限を外さない。

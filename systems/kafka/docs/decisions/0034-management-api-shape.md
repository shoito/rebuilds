---
status: accepted
date: 2026-09-27
---

# ADR-0034: 管理 API は `/v1` の主版で足す変更だけを入れ、POST に冪等キー、一覧に不透明なトークン、長い操作に 202 を使う

## Context

管理 API（`api.<brand>.<domain>`）は、コンソール・CLI・Terraform のプロバイダー・利用者のスクリプトが使う。決めることは、版、冪等、ページング、同時の更新、長い操作、契約の持ち方である。

事実（いずれも 2026-09-27 に確認）：

- Confluent Cloud の API は、グループごとの URL の版（`/iam/v2/` など）、`page_size` と不透明な `page_token`、429 と `X-RateLimit-*`・`Retry-After`、GA の壊す変更の 180 日前の告知を持つ。冪等キーの仕組みは文書にない（[Confluent Cloud APIs](https://docs.confluent.io/cloud/current/api.html)）。
- rebuilds の Stripe は、日付の版（Stripe の [ADR-0007](../../../stripe/docs/decisions/0007-date-based-api-versions.md)）と `Idempotency-Key`（Stripe の [ADR-0004](../../../stripe/docs/decisions/0004-idempotency.md)）を採った。
- 論理クラスタの作成と、KRaft が正本の資源の命令は、非同期に終わる（[ADR-0031](0031-control-plane-reconciliation-and-agent.md)）。

## Options

版：

1. **パスの主版（`/v1`）。中は足す変更だけ。壊す変更は `/v2` で、180 日以上並べる**
2. 日付の版（Stripe の方式）
3. Confluent と同じく、API のグループごとの版

冪等：

- A. **すべての POST で `Idempotency-Key` を受け、24 時間以上、最初の応答を保存する**
- B. 冪等キーを持たない（資源の名前の一意で代える）

## Decision

1 と A を採用する。詳細は [console-and-api.md](../architecture/console-and-api.md) の 3 節にある。

- **版**：`/v1`。列挙の値の追加は、クライアントが知らない値を `UNKNOWN` として扱う決まりで、足す変更とみなす。壊す変更の告知は、`Deprecation`・`Sunset` の見出し、メール、変更の記録で、180 日以上前に行う。
- **冪等**：範囲は組織 × キー。意味は rebuilds の Stripe の設計に合わせる（同じ要求に同じ応答、中身が違えば 400、実行中なら 409、検証の失敗・401・429 は保存しない）。命令の行にもキーを持たせ、202 の応答も保存する。CLI と Terraform のプロバイダーは常に付ける。
- **ページング**：`page_size`（既定 50、最大 200）と、並びの鍵と条件のハッシュを暗号化した不透明な `page_token`（24 時間）。総件数は返さない。
- **同時の更新**：`resource_version` と `If-Match`、合わなければ 412。
- **長い操作**：5 秒で終わらなければ 202 と `/v1/operations/{id}`。
- **エラー**：`error.code`（小文字のスネークケース）、`message`、`details`（命令の失敗では Kafka のエラーコード）、`doc_url`、`request_id`。すべての応答に `X-<Brand>-Request-Id`。
- **レート制限**：組織ごとのトークンバケット。429 と `X-RateLimit-*`・`Retry-After`。
- **契約**：Hono と Zod の定義から OpenAPI 3.1 を出し、CI で壊す変更を止める。Go と TypeScript の SDK を生成する。

2 を選ばない理由：日付の版は、多くの変更を、古い版の利用者に見えないよう変換する仕組み（変更モジュール）を要する。本システムの資源は少なく、主な利用者の Terraform のプロバイダーは、プロバイダーの版で API の使い方を固定できる。変換の仕組みの費用に見合わない。

3 を選ばない理由：グループごとに版が違うと、CLI とプロバイダーの中で、版の組み合わせの管理が要る。資源が少ないので、1 つの版で足りる。

B を選ばない理由：論理クラスタ・API キー・サービスアカウントの作成は、名前が一意とは限らず、再送で 2 つ作られうる。API キーの秘密を 2 回出すことにもなる。

## Consequences

- 良くなること：
  - CLI・Terraform・スクリプトの再送が安全になる。
  - 壊す変更を CI で止められ、`/v1` の利用者を守れる。
- 引き受けるコスト：
  - 冪等の保存（48 時間で消す日ごとのパーティション）を持つ。
  - `/v2` を出すときは、2 つの版を 180 日以上並べて保つ。
  - Confluent の API とは形が似ているが、互換ではない（ADR-0006 のとおり、本家の道具との互換は目標にしない）。

## Confirmation

- CI：OpenAPI の前の版との差で、`/v1` の壊す変更（項目の削除、型の変更、必須の追加）がない。
- 表駆動テスト：冪等の決定表。
- 性質ベーステスト：ページングの全件の連結がページングなしと同じ。同じ冪等キーの並行の要求で、資源が 1 つだけできる。

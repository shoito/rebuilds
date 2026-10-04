---
status: accepted
date: 2026-09-28
---

# ADR-0048: REST のテーブルの API は実効の辞書から型を作る 1 組のエンドポイントにし、リストと同じ式の言語、キーセットのページ送り、`If-Match`、`Idempotency-Key` を持つ。連携のクライアントは OAuth 2.0 のクライアントクレデンシャルで、主体は `integration` の利用者にする

詳細は [api-and-integrations.md](../architecture/api-and-integrations.md) の 3・4 節。

## Context

[intent.md](../intent.md) は、レコードの CRUD、取り込みの API、Webhook を MVP に含める。テナントはフィールドとテーブルを足す（[ADR-0003](0003-table-hierarchy-and-extensible-schema.md)）。REST API は ACL の出口の 1 つで、API のクライアントの主体で判定する（[access-control.md](../architecture/access-control.md) の 6.2 節の 12 行）。本家の API と互換にしない（[ADR-0001](0001-platform-and-stack.md)）。

本家のテーブルの API は、符号化した問い合わせの文字列、件数の上限と開始の位置でのページ送り、表示の値の選択を持つ（件数の上限の既定は 10,000、開始の位置の既定は 0。表示の値は `true`・`false`（既定）・`all`。[Table API](https://www.servicenow.com/docs/r/api-reference/rest-apis/c_TableAPI.html)、2026-09-28 に確認）。

## Options

### API の形

1. **辞書から作る汎用のテーブルの API（1 組のエンドポイント）**
2. テーブルごとに手で書いた API（インシデントの API、変更の API）
3. GraphQL

### ページ送り

- a. **キーセット（署名付きの `cursor`）だけ**
- b. `offset` と `limit`

### 連携のクライアントの認証

- x. **OAuth 2.0 のクライアントクレデンシャル（`client_secret_basic`・`private_key_jwt`）**
- y. 長く有効な API キー
- z. 利用者のパスワードの Basic 認証

## Decision

1、a、x を採用する。

- `/api/v1/tables/{table}` と `/{id}`、`/by-number/{number}`、`/journal`、`/history`。型と検証は `(tenant_id, meta_version)` の実効の辞書から Zod で作る。
- 絞り込みの `q` はリストのフィルターと同じ式の言語・同じコンパイラ。読めないフィールドはキーごと返さず、絞り込み・並べ替えは NULL の意味。
- `limit` 既定 100・最大 1,000、`cursor` は署名付き、`count=capped` は 10,001 で打ち切る。
- `ETag` = 行のバージョン、`If-Match` は任意（違えば 412）。作成の `Idempotency-Key` を `(tenant, client, key)` で 24 時間、作成と同じトランザクションで持つ。
- エラーは RFC 9457。パスのバージョンは大きな変更だけ、振る舞いは `<Brand>-Api-Version` の日付のバージョン。テナントの辞書の変更は API のバージョンにしない。OpenAPI は主体の読めるテーブル・フィールドだけで作る。
- トークンは不透明な `<brand>_at_`（1 時間、ハッシュで保存）、シークレットは `<brand>_cs_`。スコープは主体の ACL を広げない。

2 を採らない理由：テナントのテーブルとフィールドの API を出せない。組み込みのテーブルごとの API を、辞書の変更のたびに保守することになる。

3 を採らない理由：任意の入れ子の問い合わせで、参照のたどり・件数の費用と ACL の出口の数が増える。1 段の参照のたどりの制限（[ADR-0012](0012-acl-enforcement-at-every-exit.md)）と合わない。

b を採らない理由：深い `offset` は大きなテナントで遅い。更新の多い表で、ページの間に行が抜けたり重なったりする。

y を採らない理由：失効と期限の管理を顧客に任せることになり、漏えいしたキーが長く使える。まずクライアントクレデンシャルで足りるかを確かめる。

z を採らない理由：SSO の利用者はパスワードを持たない。人の資格情報を連携に使わせない。

## Consequences

- 良くなること：
  - テナントのテーブルも組み込みのテーブルも、同じ API・同じ ACL で扱える。
  - 画面と API の出口が同じ判定になる。
- 引き受けるコスト：
  - 業務の操作（承認の回答、状態の遷移）も汎用の `PATCH` で行う。使いにくければ専用の操作を後で足す。
  - `offset` がないので、「n ページ目へ飛ぶ」連携は作れない。
  - 本家の API に慣れた連携は、書き直しが要る。

## Confirmation

- 決定表 DT-API-001（冪等のキー）。
- 性質ベーステスト PROP-API-001（冪等）、PROP-API-002（API は画面より広くない）。
- 漏れの試験の REST API の出口。
- lint：API のハンドラーが Record Service の外で DB を読まないこと（[ADR-0001](0001-platform-and-stack.md) の lint と同じ）。

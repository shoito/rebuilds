---
status: accepted
date: 2026-09-28
---

# ADR-0020: REST API は /api/v1 の下で足す変更だけをし、レコードの JSON はシステムの値と fields を分けて数を文字列で返す。カーソルは暗号化したキーセットにする

詳細は [query-language-and-api.md](../architecture/query-language-and-api.md) の 5 節と 6 節。

## Context

REST API は、画面（SPA）と連携の開発者の両方が使う（architecture の 1 節）。組織ごとにオブジェクトと項目が違い、項目は管理者がいつでも足し、消す。本家の API との互換は目標にしない（intent の Non-goals、[リポジトリ共通の ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。

本家（[REST API Developer Guide](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/api_rest.pdf)、Winter '27 版、2026-09-28 に確認）：

- `/services/data/vXX.X/` の版を年に 3 回出し、各版を最低 3 年保つ。廃止した版には 410。
- エラーの本文は `[{fields, message, errorCode}]` の配列。24 時間の割り当ての超過は 403 `REQUEST_LIMIT_EXCEEDED`。
- 全ての応答に `Sforce-Limit-Info: api-usage=10018/100000`。
- 問い合わせの続きは `nextRecordsUrl`。1 回の結果は既定・最大 2,000 件。
- `ETag` と `If-Match`（412）、`If-None-Match`（304）。
- 複合の要求は 25 の副要求まで。sObject Collections は 200 件まで。外部 ID が複数に当たると 300。

## Options

版：

1. **URL の大きな番号（`/api/v1`）だけにし、その中では足す変更だけをする。壊す変更は次の番号で行い、前の番号を 3 年保つ**
2. 本家と同じく、年に数回の細かな版を URL に持つ
3. 日付の版を見出しで選ぶ

レコードの形：

- a. **システムの値（`id`、`object`、`row_version`）と利用者の項目（`fields`）を分け、数を文字列で返す**
- b. 項目を平らに並べ、数を JSON の数で返す（本家に近い）

カーソル：

- x. **暗号化したキーセット（サーバーに状態を持たない）**
- y. サーバーに結果の集合を保存する

## Decision

1、a、x を採用する。

- 基底は `https://<org>.my.<brand>.<domain>/api/v1`。リソースは、記述、レコードの CRUD、外部 ID の upsert、戻す、手動の共有、問い合わせ（`GET` と、バインド変数を渡せる `POST`）、カーソル、ごみ箱を含む問い合わせ、計画の説明、複合（25）、collections（200）、`limits`、利用者ごとの OpenAPI。
- エラーは `{"errors": [{code, message, fields, index}], "request_id"}`。読めないレコードは 404、読めるが操作できないものは 403。割り当ての超過は 429 と `Retry-After`。トランザクションの上限の超過は 400 `LIMIT_EXCEEDED`（上限の名前・使った量・上限）。
- 全ての応答（版の一覧を除く）に `<Brand>-Limit-Info: api-usage=…/…; long-running=…/…` を付ける。トランザクションの上限の使用量の見出しは governor-limits の領域で決める。
- レコードの `ETag` は `row_version`。記述の `ETag` は部品の鍵と権限の形のハッシュ。
- カーソルは、組織・利用者・問い合わせのハッシュ・版・最後の並びの値を AES-256-GCM で暗号化したもので、24 時間有効。スナップショットではない。
- 外部 ID は必ず一意にし、300 は返さない。
- 2 は、組織のメタデータが常に変わるこのシステムでは、API の版が組織の項目の形を固定できず、版を細かく刻む利点が小さい。3 は、Stripe の再構築で採った形だが、利用者の項目の形が組織ごとに違うので、日付の版で振る舞いを固定する範囲が狭い。
- b は、カスタムの項目の名前がシステムの値とぶつかりうる。大きな金額や小数が JS の倍精度で丸まる。
- y は、S3 の規模で保存の量と期限の管理が重い。

## Consequences

- 良くなること：
  - 版の運用が単純で、壊す変更を CI の OpenAPI の比較で止められる。
  - 金額が丸まらない。項目の名前がシステムの値とぶつからない。
  - カーソルに状態がなく、どのタスクでも続きを読める。
- 引き受けるコスト：
  - 本家の API の形に慣れた開発者は、JSON の形と数の文字列に合わせる必要がある。公式の SDK で 10 進の型に直す。
  - カーソルはスナップショットではないので、読んでいる間の変更で行が出たり出なかったりする。文書に書く。
  - 本家と違い、割り当ての超過を 429 で返す。

## Confirmation

- 契約テスト：OpenAPI の前の版と比べて壊す変更がない。エラーの本文の形。
- 性質ベーステスト：静的なデータでカーソルを最後まで読むと、各行をちょうど 1 回返す。
- 結合テスト：他の組織・他の利用者のカーソルが 400、期限切れが 410。`If-Match` の不一致が 412。
- 表駆動テスト：状態と `code` の表。

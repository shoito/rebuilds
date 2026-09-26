---
status: accepted
date: 2026-09-27
---

# ADR-0033: Management API は本家に寄せた `/api/v2` のリソースにし、2 種のページングを持ち、v2 の中では足す変更だけをする

詳細は [management-api-and-rate-limiting.md](../architecture/management-api-and-rate-limiting.md) の 3 節。

## Context

Management API は、ダッシュボード・CLI・Terraform・テナントのバックエンドが使う、設定と利用者の管理の API である。本家から移る利用者は、本家の API の形（リソースの名前、`page`・`per_page`、`from`・`take`）に慣れている。一方で、本家の SDK との完全な互換は目標にしない（intent の Non-goals）。

本家の振る舞い（2026-09-27 に確認。[Management API](https://auth0.com/docs/api/management/v2)、[Retrieve Logs](https://auth0.com/docs/deploy-monitor/logs/retrieve-log-events-using-mgmt-api)、OpenAPI）：

- URL は `/api/v2/`。本文は JSON、最大 1 MB。
- オフセット（`page`・`per_page`・`include_totals`、約 1,000 件まで）と、チェックポイント（`from`・`take`、不透明な `next`、24 時間有効、前へだけ）の 2 つのページング。
- 1 ページの上限は、概要の頁が「公開クラウドで 50」、OpenAPI とログの頁が「100」で、資料の間で食い違う。
- 廃止の予定の使い方を、テナントのログの `depnote` で知らせる。

## Options

1. **本家に寄せたリソースと 2 種のページング。版は URL の `/api/v2` だけにし、v2 の中では足す変更だけ**
2. Stripe の再構築（ADR-0006・0007）と同じ形（`/v1`、日付の版、`starting_after`）
3. GraphQL

## Decision

1 を採用する。

- リソースの名前と形は本家に寄せる。本家の名前を含む識別子は `<Brand>` にする（リポジトリ共通の ADR-0006）。
- 1 ページの上限は 100、既定 50。オフセットは 1,000 件まで。
- チェックポイントの `next` は、`{tenant_id, resource, sort_key, filter_hash, issued_at}` を Management API の専用の鍵で AES-256-GCM で暗号化した不透明な文字列。24 時間有効。テナント・リソース・フィルターの流用を拒否する。並びは単調な鍵（`log_id`、UUIDv7 の `id`）。
- エラーは `{statusCode, error, message, errorCode, request_id}`。他テナントの ID は 404。
- 版は `/api/v2` だけ。v2 の中では足す変更だけをする。壊す変更は `/api/v3` で行い、v2 を最低 12 か月保つ。廃止の予定は `depnote` のログと、`Deprecation`・`Sunset` の見出しで知らせる。
- 冪等キーは持たない（本家も持たない）。重複の作成は一意の制約で 409。
- 2 は、本家から移る利用者の慣れと合わない。認証基盤の設定の API は、決済の API ほど頻繁に形を変えないので、日付の版の仕組みの費用に見合わない。
- 3 は、レート制限の単位（エンドポイントごと）とスコープの判定が複雑になり、本家とも離れる。

## Consequences

- 良くなること：
  - 本家の文書・CLI・Terraform の知識の多くが通じる。
  - チェックポイントを DB に保存しないので、状態を持たない。
- 引き受けるコスト：
  - 壊す変更をしにくい。フィールドの意味を変えたいときは、新しいフィールドを足して古いものを廃止の予定にする。
  - エラーの本文の形は、本家の資料で確かめられなかった（未検証）。観察されている形に寄せた。

## Confirmation

- 契約テスト：OpenAPI を前の版と比べ、壊す変更（必須の追加、型の変更、削除）がないことを CI で確かめる。
- 性質ベーステスト：任意の追加・削除の列で、チェックポイントの読み出しが重複せず、開始時からあって消えなかった項目をすべて返す。
- 結合テスト：改ざん・他テナント・別のフィルター・25 時間前のチェックポイントが 400 になる。
- 結合テスト：`per_page=101`、`page × per_page` が 1,000 を超える要求が 400 になる。

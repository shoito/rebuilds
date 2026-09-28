---
status: accepted
date: 2026-09-28
---

# ADR-0041: 公開の GraphQL は型を生成し、入口と mutation を手で書く。読み出しは同期グループの重なりで SQL で絞り、mutation は 1 つずつ Writer のトランザクションにする。複雑さは実行の前に数え、主体ごとの 1 時間の枠を超えたら 429 を返す

## Context

intent は、GraphQL の公開 API（API キーと OAuth 2.0）を MVP に含める。本家は GraphQL で、複雑さ（属性 0.1 点、オブジェクト 1 点、接続は `first` 倍）と、主体ごとの 1 時間の要求の数・点の枠を持ち、超えると 400 と `RATELIMITED` を返す（[Rate limiting](https://linear.app/developers/rate-limiting)、2026-09-28 に確認）。

本システムの制約：

- モデルの定義から GraphQL の型を生成する（[ADR-0019](0019-schema-definition-and-codegen.md)）。
- 読む権限は、行の同期グループと主体の購読の重なりと同じ意味（[ADR-0032](0032-single-policy-module-and-group-mapping.md)）。公開 API も NFR-008 の経路の 1 つ。
- すべての書き込みは Writer を通る（[ADR-0006](0006-transactions-writer-and-idempotency.md)）。1 ワークスペースの書き込みは 1 秒 300 変更ほどが上限（[ADR-0054](0054-per-workspace-write-admission.md)）。

## Options

スキーマ：

1. **型は生成、入口と mutation は手で書く**
2. 全部を生成（モデルごとに CRUD の mutation）
3. 全部を手で書く

読み出しの権限：

- a. **SQL で `sync_groups && 主体の groups` を付ける（共有の `packages/query`）**
- b. リゾルバーで行ごとに `can()` を呼ぶ

流量の超過：

- x. **429 と `Retry-After`、`extensions.code = RATELIMITED`**
- y. 本家と同じ 400

## Decision

1・a・x を採用する。詳細は [api-and-webhooks.md](../architecture/api-and-webhooks.md) の 3・4 節。

- 実行は `graphql-js` を Hono の上で使い、GraphQL のサーバーの枠組みは使わない。
- ページングは Relay の接続（既定 50、最大 250）。cursor は主体とフィルターに結ぶ。`includeArchived` は既定で偽。フィルターは `packages/filter` の木を入力の型に写し、サーバーの問い合わせと同じ SQL の生成を使う。
- 読み出しは reader で RLS と同期グループの重なりで絞る。見てよくない行は `null`。応答の `extensions.lastSyncId` に読んだ版を入れる。
- mutation は 1 つずつ Writer のトランザクション（`origin = api`）。`Idempotency-Key` を `client_tx_id` にする。本文は Markdown を受け、今の状態との差を CRDT の `append` にする。並べ替えは `beforeId`・`afterId`。結果は writer から読んで返す。
- 複雑さは本家と同じ数え方で、1 回 10,000 点、深さ 12、別名 50 まで。枠は API キー（持ち主の利用者ごと）2,500 要求・300 万点、OAuth（アプリ×利用者）5,000 要求・200 万点、ワークスペースの合計 5 万要求・3,000 万点（1 時間）。書き込みは Writer の `api` の枠も受ける。
- 版を持たず、足すだけにし、壊す変更は `@deprecated` と利用の数えと 6 か月の告知で行う。
- 2 を採らない理由：モデルの内部のフィールド（並びの鍵、同期の列）や、操作の意図（並べ替え、Triage の受け入れ）が API に漏れ、公開の形がモデルの変更に縛られる。
- 3 を採らない理由：モデルとフィールドの数（約 50 のモデル）だけ型を手で保つと、定義とのずれが起きる。
- b を採らない理由：接続のページングと件数が権限の後の数と合わなくなり、読んでから捨てる行が多い。同期と違う実装になり、NFR-008 の試験が 2 つに分かれる。
- y を採らない理由：HTTP の意味（RFC 6585）と合わず、汎用の再試行の部品が効かない。

## Consequences

- 良くなること：
  - 同期・ビュー・公開 API が同じ読み出しの関数と権限の定義を使う。
  - 公開 API の書き込みも、`sync_actions`・差分・Webhook・履歴に同じ形で載る。
  - `Idempotency-Key` で、利用者が安全に再送できる。
- 引き受けるコスト：
  - 本家と応答の番号（429 と 400）が違う。本家の SDK との互換は目標にしない（intent の Non-goals）。
  - 本文の Markdown と CRDT の変換のコード（`packages/doc`）が API の経路に入る。
  - mutation の応答のために writer を読む。

## Confirmation

- 性質ベーステスト：PROP-API-001（同期と同じ読み）、PROP-API-002（mutation の冪等）、PROP-API-003（複雑さの上界）。
- lint：リゾルバーから SQL を直接書かない。`packages/policy` の外に権限の条件を書かない。
- CI：SDL の差分で、壊す変更を失敗させる。

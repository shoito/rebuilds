---
status: accepted
date: 2026-10-09
---

# ADR-0038: 公開 API は `api.<brand>.<domain>/v1/` の、JSON の本文を持つ `POST` の呼び出しの形にする。ノードはパス・`id:`・`ns:` で指し、書き込みは `add`・`update`・`overwrite` の 3 つの方式を、すべて条件つきの commit に直す。変更は `list_folder`・`continue`・`get_latest_cursor` と、`notify.<brand>.<domain>` の long-poll で取る。WebSocket の合図は自社のクライアントだけ。中身の送受信はブロックの URL の計画で行い、API は中身を通さない。互換の `content_hash` は出さない

## Context

公開の API と自社のクライアントの API は同じものにする（[architecture/README.md](../architecture/README.md) の 1.2 節）。本家の API は、`list_folder` でカーソルを返し、`continue` で続きを取り、`longpoll` で変化を待つ（[ADR-0005](0005-namespace-journal-and-cursors.md) の Context）。パスは大文字小文字を区別しない（[HTTP API documentation](https://www.dropbox.com/developers/documentation/http/documentation)、2026-10-09 に確認）。

決めることは次である。

- 呼び出しの形（資源ごとの REST か、呼び出しの形か）。
- 「上書き」の指定の意味。[ADR-0006](0006-sync-conflict-model.md) は条件なしの上書きの API を禁じ、公開 API の上書きを、サーバーが今の `rev` を条件にする形に直すとした。
- 合図の経路。[architecture/README.md](../architecture/README.md) の 6 節は、端末へは WebSocket、使えなければ 60 秒の確かめと long-poll とした。
- 中身の送受信。[ADR-0001](0001-platform-and-stack.md) は、ブロックの中身をサーバーの ECS に通さないとした。
- 本家の `content_hash` と互換の値を出すか（[ADR-0002](0002-chunking-and-block-addressing.md) がこの領域に預けた）。

## Options

形：

1. **`POST` と JSON の呼び出しの形（本家の振る舞いに寄せる）**
2. 資源ごとの REST（`GET /files/{id}` など）
3. GraphQL

合図：

- a. **公開は long-poll と Webhook、WebSocket は自社のクライアントだけ**
- b. 公開にも WebSocket を出す

互換の値：

- x. **出さない**
- y. 4 MiB の固定のブロックの値を別に計算して出す

## Decision

1、a、x を採用する。詳細は [api-and-webhooks.md](../architecture/api-and-webhooks.md) の 4〜6 節。

- 呼び出しは `api.<brand>.<domain>/v1/<group>/<name>` への `POST`、本文は JSON。名前・パス・カーソルを URL に入れない。
- 指し方は `path`（`name_key` で引く）、`id:<node_id>`、`ns:<ns_id>/<path>`、`rev:<rev_id>`。読めないものとないものは同じ 404。
- 書き込みの方式：`add`（その名前がまだない）、`update`（`base_rev`・`base_node_ver`）、`overwrite`（サーバーが同じトランザクションで今の `rev` を条件にする。前の中身はバージョン履歴に残る）。どれも `files/commit` の条件つきの操作に直す。SDK の既定は `add`。
- 変更：`files/list_folder`（2,000 件まで）、`continue`（取り直しは 409 `reset`）、`get_latest_cursor`、`notify` の `longpoll`（30〜480 秒、`backoff`）。
- WebSocket（`notify.<brand>.<domain>/v1/stream`）は自社のクライアントだけ。トークンは最初のメッセージで、カーソルから名前空間を購読し、`{ns_id, seq}` だけを送る。
- アップロードは commit の `need_blocks` とアップロードのセッション（[ADR-0018](0018-upload-sessions-and-block-grants.md)）。ダウンロードは `download_plan` のブロックの URL。API は中身を通さない。

> 2026-10-09 の注記：「1 つの URL で大きなファイルを取る」呼び出しは持たないとしていたが、統合の工程で `files/export`（Worker が S3 の中で組み立て、署名つき URL で返す。10,000 ファイル・20 GiB まで）を [ADR-0054](0054-server-assembled-downloads.md) で足した。API が中身を通さないことは変えない。
- ファイルの同一性は `content_sha256` を返す。本家の `content_hash` と互換の値は出さない。
- 互換を壊す変更は `/v2/` にし、`/v1/` を 12 か月以上残す。

### 他の案を選ばなかった理由

- **2（資源ごとの REST）**：パスを URL に入れることになり、名前がアクセスのログに残る。本家の利用者が移るときの写し替えの手間も増える。
- **3（GraphQL）**：差分の取得とアップロードの往復の形に合わず、レート制限の数え方も複雑になる。
- **b（公開に WebSocket）**：形を固定すると、合図の経路（Notify と Valkey）の作りを変えにくい。long-poll で NFR-002 の伝播は満たせる。
- **y（互換の値）**：互換は目標にしない（[intent.md](../intent.md) の Non-goals）。値を出すには、サーバーかクライアントが 4 MiB の固定の区切りでもう一度ハッシュを計算する必要がある。

## Consequences

- 良くなること：
  - 本家の API の利用者が、振る舞いの近い形で移れる。
  - 書き込みの経路が 1 つ（条件つきの commit）にまとまる。
  - 中身がサーバーを通らない。
- 引き受けるコスト：
  - 20 GiB を超えるファイルは 1 つの URL で取れない。利用者は SDK か自分で組み立てる（20 GiB までは ADR-0054 の `files/export`）。
  - `overwrite` を選んだ利用者の同時の編集は、片方が古いリビジョンになる（中身は履歴に残る）。

## Confirmation

- 決定表：DT-API-001（書き込みの方式）。
- 性質ベーステスト：PROP-API-001（条件のない書き込みがない）、PROP-API-002（カーソル）。
- API の定義の検査（CI）：URL の問い合わせの文字列に `path`・`cursor` を持つ呼び出しがない。

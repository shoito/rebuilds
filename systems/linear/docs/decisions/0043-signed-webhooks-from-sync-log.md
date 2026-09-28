---
status: accepted
date: 2026-09-28
---

# ADR-0043: Webhook は `sync_actions` から作り、作った管理者の権限で送る時にも絞る。署名は時刻を含む `<Brand>-Signature`、5 秒で時間切れ、1 分・1 時間・6 時間で再試行し、24 時間失敗し続けたら止める。送信は egress の経路から

## Context

intent は、署名付きで再試行つきの Webhook を MVP に含める。NFR-009 は、最初の送信 p95 30 秒以内、少なくとも 1 回届けることを求める。本家は、対象の型ごとに `action`・`data`・`updatedFrom` などを送り、生の本文の HMAC-SHA256 をヘッダーに付け、5 秒で時間切れ、1 分・1 時間・6 時間で再試行する。対象は全部の公開のチームか 1 つのチームで、作れるのは管理者だけ（[Webhooks](https://linear.app/developers/webhooks)、2026-09-28 に確認）。

[ADR-0004](0004-tenancy-and-permissions.md) は、Webhook の読み出しも同期グループの判定を通ること、非公開のチームを対象にできるのはそのチームのメンバーの管理者だけであることを求める。Webhook の宛先は顧客が決める任意の URL で、SSRF の踏み台になりうる。

## Options

変更の源：

1. **`sync_actions` の範囲を Relay から受け、振り分けの Worker が当てはめる**
2. Writer が Webhook の予定を同じ DB のトランザクションで書く

権限：

- a. **作った管理者の今の主体で、振り分けの時と送る直前に `can()` を確かめる**
- b. 作った時の設定（チーム）だけで絞る

署名：

- x. **`<Brand>-Signature: t=<ミリ秒>,v1=<HMAC-SHA256(秘密, t.本文)>`**
- y. 本家と同じく本文だけの HMAC

## Decision

1・a・x を採用する。詳細は [api-and-webhooks.md](../architecture/api-and-webhooks.md) の 5 節。

- Relay は、有効な Webhook のあるワークスペースの範囲だけを `webhook-fanout` に流す。振り分けの Worker は `sync_actions` を読み、型・チーム・`can(creator, "read", row)` で当てはめ、`webhook_deliveries` に予定を書く。
- `data` は変更の後の行を公開 API の型の形にしたもの。`updatedFrom` は同じ行の 1 つ前の `sync_actions` から作る（保持の外なら省く）。`syncId` を入れる。本文の CRDT の更新はまとめの後に 1 回の `update` として送る。`origin = import` は既定で送らない。
- `creator` が権限を失ったら、その Webhook を止めて他の管理者に知らせる。
- 署名に送る時刻を含め、受け手は 5 分以内かを確かめる。秘密の入れ替えの 24 時間は 2 つの `v1` を付ける。`<Brand>-Delivery`（再試行で同じ）で重複を見分けられる。
- 送信は egress のサブネットから。`https` だけ、名前解決の後の IP の検査、リダイレクトを追わない。接続 2 秒・全体 5 秒、2XX で成功。再試行は 1 分・1 時間・6 時間。24 時間全部失敗したら止めて管理者に知らせる。
- 送りの記録は 14 日、本文の暗号文は 72 時間（手の再送のため）。
- 2 を採らない理由：Writer のロックの中の仕事が増え、1 ワークスペースの書き込みの上限（ADR-0054）を削る。Webhook の設定の読み出しが Writer の経路に入る。
- b を採らない理由：作った管理者が非公開のチームを抜けた後も、そのチームの変更が外へ出続ける。
- y を採らない理由：本文を読んで解析しないと古い要求を見分けられず、時刻の確かめを受け手が省きやすい。

## Consequences

- 良くなること：
  - Webhook が同期と同じ権限の定義で絞られる（NFR-008）。
  - Writer の経路が重くならない。
  - 宛先の SSRF が egress の経路に閉じる。
- 引き受けるコスト：
  - 本家と署名の形が違う（本家との互換は目標にしない）。
  - `updatedFrom` のために `sync_actions` に `(workspace_id, model, model_id, sync_id)` の索引が要る。
  - 送りの順序を保証しない。受け手は `syncId` で並べる。

## Confirmation

- 表駆動テスト：DT-HOOK-001（作成の規則）。
- 性質ベーステスト：PROP-HOOK-001（見てよい行だけ）、PROP-HOOK-002（署名）。
- 結合テスト：SSRF の宛先、再試行の時刻、停止と戻し。
- 本番：確定から最初の送信の p95（NFR-009）、権限で落とした数。

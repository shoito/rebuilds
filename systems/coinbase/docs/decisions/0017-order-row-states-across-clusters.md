---
status: proposed
date: 2026-11-15
---

# ADR-0017: 注文の行を core に先に書き、拘束は ledger に冪等キーで書く

## Context

[ADR-0004](0004-order-entry-holds-and-idempotency.md) は、`(account_id, client_order_id)` の一意の制約を core の注文の表に置き、拘束は ledger の残高の行の条件つきの更新で書くと決めた。core と ledger は別の Aurora のクラスタである（[ADR-0001](0001-platform-and-stack.md)）。

- 2 つのクラスタを 1 つのトランザクションで書けない。どちらを先に書き、途中で止まったときにどう始末するかが決まっていない。
- [architecture/README.md](../architecture/README.md) の 1.3 節 A の 2 は「拘束は ledger の 1 つのトランザクションで、仕訳と注文の行を書く」と書き、注文の行の置き場所が ADR-0004 と読み違えうる。
- 受け付けの遅れは p99 20ms（NFR-001）で、commit を 2 回より増やせない。

## Options

1. **core に `pending_submit` の行を先に書き、次に ledger に拘束を冪等キー `order:<order_id>:hold` で書く。途中で止まった行は、冪等キーで ledger を引いて始末する**
2. 注文の行（一意の制約を含む）を ledger のクラスタに置き、拘束と同じトランザクションで書く
3. 先に ledger に拘束を書き、次に core に行を書く

## Decision

1 を採用する。

- `order-gateway` は core に `orders` の行（`status = pending_submit`、`order_id` は UUIDv7）を書く。同じトランザクションで、口座の取引の制限の行を読む（[ADR-0019](0019-account-trading-restrictions.md)）。一意の制約に当たったら、最初の行の結果を返す。
- 次に ledger の拘束の API を、冪等キー `order:<order_id>:hold` で呼ぶ。不足なら core の行を `rejected(insufficient_funds)` にする。
- sequencer の受け付けの後、応答を返してから `accepted` と `seq` を書く。この更新は遅れの予算に入れない。失敗しても、出力の記録を読む更新の部品が追いつく。
- `reconcilers` は 5 秒ごとに、10 秒を超えた `pending_submit` の行について、ledger の冪等キーで拘束を引く。拘束があれば同じ `order_id` で送り直し（ADR-0004）、なければ `rejected(internal)` にする。拘束を後から書く経路は作らない（利用者が結果を受け取っていないため、再送は利用者に任せる）。
- 注文の行の正本は core である。README の 1.3 節 A の 2 の「注文の行」は、ledger の拘束の行（`holds`）と読む。

### 他の案を選ばなかった理由

- **2**：注文の照会、約定の一覧、運用の画面が ledger のクラスタを読むことになり、ledger に書くのは `ledger` のサービスだけという分け方（[ADR-0005](0005-ledger-balances-and-trade-settlement.md)）が崩れる。
- **3**：拘束だけがあって注文の行がない状態ができる。利用者の再送の冪等（`client_order_id`）を、行の書かれる前に判定できない。

## Consequences

- 良くなること：
  - 一意の制約で、再送を拘束の前に止められる。
  - どこで止まっても、行と拘束の組は「両方ある」か「行だけ（`rejected` にする）」になり、「拘束だけ」はできない。
- 引き受けるコスト：
  - 受け付けに 2 回の commit が入る（core 3ms、ledger 5ms の予算）。
  - `rejected(internal)` の注文は、利用者が再送する必要がある。

## Confirmation

- 性質（PROP-ORD-3）：任意の点で core・ledger・sequencer の書き込みを止めても、拘束だけの注文 0、拘束のない `accepted` の注文 0。
- 照合：5 分ごとの拘束と注文の照合（NFR-004）に、`pending_submit` の行と拘束の組を含める。

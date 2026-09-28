---
status: accepted
date: 2026-09-28
---

# ADR-0054: 1 ワークスペースの書き込みを `origin` ごとの枠で割り当てる。`client` を最優先にして数えず、`api`・`worker`・`notifier`・`import` を Writer がロックの前に数え、ロックの待ちが伸びたら `client` 以外を半分にする

## Context

1 ワークスペースの書き込みは `workspace_sync` の行のロックで直列になり、上限は 1 秒 300 変更ほどと見込む（[ADR-0002](0002-sync-model.md)、[ADR-0006](0006-transactions-writer-and-idempotency.md)、[architecture/README.md](../architecture/README.md) の 2 節）。この行を、利用者の操作（`client`）、公開 API（`api`）、Worker の定期処理と連携（`worker`）、通知係（`notifier`）、インポート（`import`）が取り合う。

利用者の操作は手元で先に進む（ADR-0002）ので、確定が少し遅れても画面は止まらない。ただし NFR-002 は送信から ack の p99 300ms を求める。インポートや API の一括の書き込みが行を占めると、利用者の ack が遅れ、上書きの窓が広がる。

[ADR-0023](0023-workflow-states-and-lifecycle-automation.md) の自動の処理は「500 件ずつ、1 ワークスペースに 100ms に 1 回まで」で、最大 1 秒 5,000 変更になり、上の上限を超える。

## Options

1. **`origin` ごとの枠（トークンバケット）を Writer がロックの前に数え、`client` を数えず優先する。ロックの待ちで `client` 以外を絞る**
2. 全体の 1 つの枠（先着順）
3. 優先度つきの待ち行列（Writer の中で `origin` ごとの列を持ち、ワークスペースごとに順に取り出す）

## Decision

1 を採用する。詳細は [capacity.md](../architecture/capacity.md) の 2 節。

- 枠（1 ワークスペース）：`api` 1 秒 60 変更（瞬間 300）、`notifier` 50（瞬間 500）、`worker` 50（瞬間 500）、`import` 100（[ADR-0044](0044-import-pipeline-staging-and-throttled-writer-commits.md) の自動の調整）。`client` は数えず、1 接続の送信の上限（[sync-engine.md](../architecture/sync-engine.md) の 4.3 節）だけを受ける。
- Writer はロックを取る前に Valkey のトークンバケットで数え、超えたら `retry`（`after_ms`）を返す。公開 API は 429 に写す。Valkey が落ちたら、タスクのメモリーの近似の数で続ける。
- Writer はワークスペースごとに直近 10 秒のロックの待ちの p99 を持ち、50ms を超えたら `client` 以外の枠を半分にする。落ち着いたら 1 割ずつ戻す。
- Ops のフラグで、ワークスペースごと・`origin` ごとに枠を手で下げられる。
- ADR-0023 の自動の処理は、この枠に従う（遅くなる）。
- 通知係（[ADR-0036](0036-notifications-derived-by-notifier.md)）は `origin = notifier` で書き、受け手ごとに 5 秒に 1 回のトランザクションにまとめる（[notifications-and-inbox.md](../architecture/notifications-and-inbox.md) の 5.5 節）。

> 2026-09-28 の注記：統合の工程の持ち越しを既定案で決めた。通知係の書き込みは当初 `origin = worker` で、自動の処理（自動で閉じる・アーカイブ・繰り越し）と `worker` の枠（1 秒 50 変更）を取り合い、大きなワークスペースで通知が遅れることがあった。`notifier` の枠（1 秒 50 変更、瞬間 500）を `worker` と別に置いた。インボックスの行は安く、受け手のグループだけに届くので、受け手ごとに 5 秒でまとめてロックの回数を減らす。
- 2 を採らない理由：インポートや API の一括が先に着けば、利用者の操作が待たされる。
- 3 を採らない理由：Writer はステートレスで、ワークスペースの割り当てを持たない（ADR-0006）。Writer の中に列を持つと、ワークスペースをタスクに割り当てる仕組みが要る。

## Consequences

- 良くなること：
  - 利用者の操作の ack の遅れを、他の経路の量から切り離せる。
  - Writer をステートレスのまま保てる。
- 引き受けるコスト：
  - `worker`・`import` の処理が遅くなる。大きなワークスペースの自動の処理は日をまたぎうる。
  - Valkey に 1 書き込みあたり 1 回の往復が増える（`client` は数えないので対象外）。
  - ADR-0023 の数値と食い違う。issues-and-workflow の持ち主に見直しを依頼する。

## Confirmation

- 負荷試験（E12 の L3）：最大のワークスペースに 400 変更/秒を流し、`client` の送信から ack の p99 が 300ms 以内で、`client` 以外が絞られる。
- 負荷試験（E12 の L6）：インポートと利用の同居。
- 本番：枠で `retry` にした数（`origin` ごと）、混雑の制御が効いた回数、ワークスペースごとのロックの待ちの p99。

---
status: accepted
date: 2026-09-27
---

# ADR-0033: キューの S1 の保存は SQS の標準のキューにし、配送は自前のディスパッチャーで行う

詳細は [queues-and-cron.md](../architecture/queues-and-cron.md) の 4〜6 節。

## Context

ADR-0005 は、キューを少なくとも 1 回の配信にし、確定したメッセージを失わず、再試行の上限を超えたらデッドレターのキューへ移すと決めた。保存の方式は queues-and-cron の領域で決める。

本家（2026-09-27 に確認）：

- Durable Objects の上に作る。保存のシャードを全リージョンの生産者の近くに置き、消費者のシャードと調整役を持つ。1 キュー 5,000 件/秒、並行 250（[How we built Cloudflare Queues](https://blog.cloudflare.com/how-we-built-cloudflare-queues/)）。
- バッチ 100 件・60 秒まで、再試行 既定 3・最大 100、遅延 24 時間まで、DLQ は任意（[Batching and retries](https://developers.cloudflare.com/queues/configuration/batching-retries/)、[Limits](https://developers.cloudflare.com/queues/platform/limits/)）。

SQS の標準のキュー（2026-09-27 に確認）：

- 少なくとも 1 回、メッセージ 1 MiB、保持 14 日まで、可視性のタイムアウト 12 時間まで、遅延 15 分まで、1 要求 10 件、処理中のメッセージ約 12 万件、バックログ無制限（[message quotas](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/quotas-messages.html)、[queue quotas](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/quotas-queues.html)）。
- 東京で標準の要求 100 万あたり 0.40 ドル。64 KB ごとに 1 要求（AWS の価格表の API）。

この題材の Durable Objects（E9）は、自前の複製とリースを持ち、試験で正しさを固めるまで時間がかかる。

## Options

1. **利用者のキュー 1 つを東京の SQS の標準のキュー 1 つに対応させ、バッチ・並行・再試行・DLQ は自前のディスパッチャーで行う**
2. **本家と同じく Durable Objects の上に作る**
3. **Kafka（MSK）などのログの保存の上に作る**

## Decision

S1 は 1 を採用する。S2 の前に、生産者の近くの保存の要望と E9 の成熟を見て、2 を見直す。

- SQS のキューは `<brand>-q-{queue_id}`。本文は base64、属性に `msg_id`（再配信でも変わらない）・`content_type`・`enqueued_at`・`account_id`・`queue_id`。
- 送信は、各リージョンのゲートウェイから東京の SQS へ送り、SQS の確定で成功を返す。毎秒 5,000 件の上限は、東京の速さの制限の表で数える。
- ディスパッチャー（東京、3 AZ）は、キューを 256 のシャードに分け、シャードごとのリースで分担する。受信を `max_batch_size`・`max_batch_timeout` まで貯め、消費者の関数を東京で起動し、確認は削除、再試行は可視性の変更、上限を超えたら DLQ へ送ってから削除する。
- 並行の数は、バックログと失敗で自動に増減する（最大 250）。`retry()` は失敗に数えない。
- 遅延は、送信 15 分（SQS の遅延の上限）、再試行 12 時間（可視性の上限）まで。本家（24 時間）との差として示す。
- 2 を採らない理由（S1）：キューの耐久性が、E9 の複製・リース・PITR の正しさにそのまま依る。E10 が E9 の完成を待つ。
- 3 を採らない理由：テナントごとに多数（数万）の小さなキューを持つ用途に、パーティションとコンシューマーグループの単位が合わない。メッセージごとの確認と再試行・遅延を自前で作る量が大きい。

## Consequences

- 良くなること：
  - 耐久性と規模を SQS に任せ、E9 と並行に進められる。
  - 原価が小さい（10 件ずつまとめて約 0.12 ドル/100 万メッセージ。本家の料金は 1 メッセージ 3 操作で 1.20 ドル/100 万）。
- 引き受けるコスト：
  - S1 では、海外の生産者の送信が東京への往復になる（100〜250ms。未検証）。本家は生産者の近くに置く。
  - 遅延の上限が本家より短い。
  - 基盤の障害（ディスパッチャーの停止）で、SQS の受信の回数が増え、利用者の再試行の回数を使いうる。
  - 東京の全体の障害で、キューは止まる（メッセージは SQS に残る）。
  - SQS のキューの数の上限の実際の値は未検証。E10 の負荷試験で、S1 の規模（数万のキュー）を作れることを確かめる。

## Confirmation

- 耐久性の試験：送った `msg_id` のすべてが、ディスパッチャーの停止・分断・SQS の遅延・消費者の例外の注入の後に、確認・DLQ・上限での削除（記録あり）のどれかに 1 回以上進む。失われた `msg_id` が 0 件。
- 負荷試験：1 キュー 5,000 件/秒で送信と配送が続く。数万のキューの作成と、空のキューのポーリングの費用が見積もりの中に収まる。

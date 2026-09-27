---
status: accepted
date: 2026-09-27
---

# ADR-0034: cron はシャードごとのリースを持つ東京のスケジューラーで起動し、予定の時刻ごとの記録で 2 重の起動を防ぐ

詳細は [queues-and-cron.md](../architecture/queues-and-cron.md) の 7 節。

## Context

intent は、cron の式による定期の起動を MVP に含める。

本家（2026-09-27 に確認）：

- 5 つの欄と Quartz の拡張（`L`・`W`・`#`）、UTC。`controller.scheduledTime` で予定の時刻を渡す。変更の反映に最大 15 分。余っている拠点で動かす（[Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)）。
- アカウントあたり無料 5・有料 250。CPU 時間は間隔 1 時間未満で 30 秒、1 時間以上で 15 分（有料）（[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)）。
- 失敗の再試行と、取りこぼしの扱いは文書に書かれていない（2026-09-27 に確認）。上流の workerd は `controller.noRetry()` を持ち、cron の結果に `retry` の印を返すので、本家の本番は失敗を再試行しうる（未検証。[queues-and-cron.md](../architecture/queues-and-cron.md) の 7.3 節）。

S1 のトリガーは最大で数十万（1 万アカウント × 最大 250。実際はずっと少ない見込み）。スケジューラーの台の障害と網の分断の中で、同じ予定の時刻を 2 回起動しないこと（利用者の多くは冪等でない定期の処理を書く）と、止まっていた間の予定をどう扱うかを決める必要がある。

## Options

1. **東京のスケジューラーの群が、トリガーを 64 のシャードに分けてシャードごとのリースで持ち、予定の時刻ごとに `cron_fires` を条件付きで作ってから起動する**
2. **Amazon EventBridge Scheduler に、トリガーごとのスケジュールを作る**
3. **Durable Objects のアラームで、トリガーごとに 1 つの実体を持つ**

## Decision

1 を採用する。

- シャードのリースは、DynamoDB の条件付きの更新（2 秒ごとに更新、7 秒で自ら止まる、10 秒で引き継ぐ。durable-objects のホストのリースと同じ形）。
- 予定の時刻 `t` の起動の前に、`cron_fires(trigger_id, t)` を `attribute_not_exists` で作る。作れなければ起動しない。リースが一時的に 2 台に重なっても、起動は 1 回になる。
- 基盤の失敗（利用者のコードの前の失敗）は、同じ `t` で 10 秒あけて最大 3 回試す。利用者のコードの例外・時間切れは再試行しない。
- 止まっていた間の予定の時刻は、15 分以内なら 1 回だけ起動し、それより古いものは `missed` として記録する。
- 起動のリージョンは S1 で東京に固定する。変更の反映は p99 60 秒。
- 東京の全体の障害では、大阪の待機へ手動で切り替える（`cron_fires` は大阪へ複製）。
- 2 を採らない理由：数と式は足りる（東京の既定でスケジュール 1,000 万、作成 1 秒 5,000、`L`・`W`・`#` に対応。起動の上限は既定で 1 秒 1,000 で、毎時 0 分に集まる起動を均す必要がある。[EventBridge Scheduler quotas](https://docs.aws.amazon.com/scheduler/latest/UserGuide/scheduler-quotas.html)、[Schedule types](https://docs.aws.amazon.com/scheduler/latest/UserGuide/schedule-types.html)、2026-09-27 に確認）。しかし配送は「少なくとも 1 回」で（[Retry policy](https://docs.aws.amazon.com/scheduler/latest/UserGuide/managing-schedule-retry-policy.html)）、起動の先が自前のランタイムなので、2 重の起動を防ぐ記録（`cron_fires`）は結局自前で要る。式の形（6 つの欄、`?` の要否）も本家の 5 つの欄と違い、変換が要る。
- 3 を採らない理由：cron が E9 に依る。トリガーの数だけ実体が常に要る。

## Consequences

- 良くなること：
  - 同じ予定の時刻を 2 回起動しない（東京の手動の切り替えの時を除く）。
  - 止まっていた間の扱いが明示される。
- 引き受けるコスト：
  - スケジューラーという自前の部品と、シャードのリースの運用。
  - 起動ごとに DynamoDB の条件付きの書き込みが 1 回要る。
  - 利用者のコードの例外は再試行しないので、利用者が必要なら自分でキューなどに逃がす。
  - 東京の障害の間は cron が止まる。

## Confirmation

- 結合テスト：2 台のスケジューラーに同じシャードのリースを持たせた（分断の模擬）状態で、同じ予定の時刻の起動が 1 回。
- 結合テスト：スケジューラーを 5 分止めると、その間の予定が 1 回ずつ起動する。20 分止めると、15 分より古いものは `missed`。
- 本番での検証：1 分ごとの合成の cron の起動の遅れ（p99 5 秒）と抜け。

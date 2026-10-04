---
status: accepted
date: 2026-10-04
---

# ADR-0029: リマインダーの時計は、Aurora の分の桶の表（256 のシャード）と、シャードを借りたタスクのメモリーのタイマーホイールの組み合わせにする。発火は計画の行の claim と送信の記録への一意の鍵の挿入で行い、挿入できたものだけを送る。15 分を超えて遅れたものは送らずに数える

## Context

NFR-003 は、通知の時刻から送信の開始まで p99 30 秒、重複 0.01% 未満、送り漏れ 0 件を求める。S1 のピークは毎時 0 分・30 分の直前の 3,000 件/秒（[architecture/README.md](../architecture/README.md) の 2 節）。[architecture/README.md](../architecture/README.md) の 6 節は、Aurora の分の桶の表とシャードごとのメモリーのタイマーホイールの組み合わせを既定案にし、EventBridge Scheduler の 1 回ごとのスケジュールを、予定の変更のたびに作り直す量が多いので第一の候補にしないと決めた。[quality.md](../quality.md) の 2.2.1 節 F は、遅れすぎたもの（既定 15 分）を送らずに数えると決めた。

決めることは次である。

- 時計の行をどこに持ち、だれが読むか（全部のテナントの行）。
- 複数のタスクで、同じ行を 2 回送らない方法と、タスクが止まったときの取り戻し。
- 重複の除去の鍵。
- 集中の受け方。

本家のリマインダーの仕組みは公開の資料にない（未検証）。

## Options

1. **Aurora の計画の表（送る時刻の索引、利用者のハッシュで 256 のシャード）と、シャードを借りたタスクのメモリーのタイマーホイール（1 秒の刻み、5 分先まで）**
2. EventBridge Scheduler の 1 回ごとのスケジュール
3. Valkey のソート済み集合（送る時刻を得点に）
4. SQS の遅延のメッセージ（最大 15 分）を連ねる

## Decision

1 を採用する。詳細は [reminders-and-notifications.md](../architecture/reminders-and-notifications.md) の 5・6 節。

- 計画の表 `reminder_plans` は保守用のスキーマ（RLS の外）に置き、ID と時刻だけを持つ。中身は notifier がテナントのコンテキストで読む。[ADR-0004](0004-tenancy-and-rls.md) のテナントをまたぐ経路の許可リストの X5 にした（2026-10-04、統合の工程）。
- 送る時刻の日で分割し、`(shard, fire_at) WHERE status = 'pending'` の索引を持つ。「分の桶」は、同じ分の行を索引の隣り合いとしてまとめて読むことを指す。
- `reminder-scheduler` のタスクは、シャードを 30 秒の期限で借り（10 秒ごとに延ばす）、10 秒ごとに 5 分先までの行を読み、1 秒の刻み × 300 の枠のタイマーホイールに載せる。
- 発火：1 秒分の行を `UPDATE … SET status = 'claimed' WHERE id = ANY(…) AND status = 'pending' RETURNING` で取り、送信の記録 `reminder_deliveries` に一意の鍵で `INSERT … ON CONFLICT DO NOTHING RETURNING` し、返った記録だけを SQS の `notify` に入れ、行を `done` にする。
- 取り戻し：借りの期限が切れたシャードを他のタスクが取り、`pending` の行（15 分前まで）と、60 秒を過ぎて記録のない `claimed` の行を読む。記録の後に SQS に入らなかったものは、毎分のジョブが入れ直す。notifier は記録の状態を `queued` → `sending` に条件つきで変えてから送る。
- 借りを得た時に 15 分を超えて遅れていた行は `skipped_late` にして送らない。
- 集中：claim と記録の挿入は 1 秒分を 1 回ずつの SQL（5,000 行まで）。SQS は 10 件ずつ並行に。毎時 55 分・25 分に scheduler と notifier を時刻で増やす。
- 時計はタスクの時計（NTP で同期）を使う。

### 他の案を選ばなかった理由

- **2（EventBridge Scheduler）**：予定の移動・取り消し・出欠の変更・tzdb の再計算のたびに、スケジュールの作り直しと消し込みが要る。S1 で数千万のスケジュールを持ち、作り直しの API の上限と費用を受ける。消し損ねたスケジュールが古い時刻で発火する。
- **3（Valkey）**：Valkey は失われてもよい部品と決めた（[architecture/README.md](../architecture/README.md) の 1.2 節）。失うとリマインダーが消える。DB と Valkey の 2 つに正本を持つことになる。
- **4（SQS の遅延）**：15 分を超える先は連ねる必要があり、予定の変更で古いメッセージを消せない（送る時に捨てるだけになり、量が増える）。

## Consequences

- 良くなること：
  - 正本は Aurora の 1 つで、付け替えは行の削除と挿入の 1 つのトランザクションで済む。
  - 送信の記録の一意の鍵で、タスクの交代・SQS の重複・再送があっても 1 回にできる。
  - シャードの数でタスクを増やせる。
- 引き受けるコスト：
  - 借りと取り戻しの仕組みを自前で持つ。障害の注入の試験が要る（[quality.md](../quality.md) の 2.2.1 節 F）。
  - Aurora の writer に、毎秒の claim と記録の書き込みが乗る（ピークで数千行/秒）。
  - 時計の表が RLS の外にある。中身を持たないことを、表の定義の検査で守る。
  - notifier の「送った後・`sent` の書き込みの前」の停止は、2 重の送りになりうる。数を測る。

## Confirmation

- 性質ベーステスト（時計を差し替えられる枠）：PROP-REM-001（高々 1 回）、PROP-REM-003（漏れなし）。障害の注入：claim の後・記録の後・SQS の後・送りの途中の停止、借りの交代、SQS の重複。
- PoC：E9 の前の `reminder-burst-poc` で、毎時 0 分の集中の p99。
- CI：`reminder_plans`・`reminder_deliveries` に中身の列（タイトル、場所、メールアドレス）を足すマイグレーションを失敗させる。
- 本番：時刻どおりの送信の割合、`missed`・`skipped_late`・重複の数。

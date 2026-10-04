---
status: accepted
date: 2026-10-04
---

# ADR-0030: リマインダーは 7 日先までの回だけを計画し、毎時に端を進める。予定・出欠・設定・タイムゾーン・tzdb の変更は `reminder.replan` で（利用者, 予定オブジェクト）の待ちの行を作り直す。終日と浮動の予定は壁時計で分を引く。送信の記録の鍵は（利用者, 予定オブジェクト, `recurrence_id`, 方法, 分, 回の開始）で、版は鍵に入れない

## Context

[ADR-0029](0029-reminder-clock-buckets-and-timer-wheel.md) は時計の仕組みを決めた。時計が読む計画の行を、いつ・どこまで作り、予定の変更でどう作り直すかが残る。

- 予定の回は無限にありうる。リマインダーは最大 40,320 分（28 日）前（[Events resource](https://developers.google.com/workspace/calendar/api/v3/reference/events)、2026-10-04 に確認）。
- 予定の移動・取り消し、出欠の辞退、リマインダーの変更、カレンダーのタイムゾーンの変更、tzdb の再計算（[ADR-0012](0012-tzdb-update-recompute-and-propagation.md)）は、送る時刻を変える。題材の `AGENTS.md` は「予定が動いたら版を上げ、古い版の時刻の送信を捨てる」と決めた。
- 終日の予定の「前々日の 09:00」のような分は、夏時間の切り替えをまたぐと、UTC で分を引いたときに壁時計の時刻がずれる。
- 最初の設計の [architecture/README.md](../architecture/README.md) の 1.3 節は、送信の記録の鍵を `(reminder_id, occurrence_start, method, version)` と書いた。版がタイトルだけの変更でも上がる（[ADR-0003](0003-recurrence-storage-and-expansion.md)）と、遅れて作り直した行が同じ回をもう一度送りうる。

## Options

計画の範囲：

1. **7 日先まで。毎時に端を進める**
2. 展開の索引の範囲（548 日先）の全部
3. 次の 1 回だけ（送ったら次を作る）

送信の記録の鍵：

- a. **（利用者, 予定オブジェクト, `recurrence_id`, 方法, 分, 回の開始）。版は列に持ち、鍵に入れない**
- b. （`reminder_id`, 回の開始, 方法, 版）を文字どおりに使う

## Decision

1 と a を採用する。詳細は [reminders-and-notifications.md](../architecture/reminders-and-notifications.md) の 5 節と 6.3 節。

- 計画の行は `[now − 15 分, now + 7 日]` に送る時刻があるものだけ。`reminder-planner.advance` が毎時、新しく入る 1 時間分を、展開の索引の `[now + 7 日, now + 35 日 + 1 時間)` から足す。
- 付け替え：`packages/writer`・`itip-delivery`・`expander` が、DT-REM-002 の事象で outbox に `reminder.replan { tenant_id, user_id?, calendar_id, event_object_id, version }` を書く。`reminder-planner` は、頭の版（`reminder_plan_heads`）より古い依頼を捨て、その（利用者, 予定オブジェクト）の `pending` の行を消して作り直す。`claimed`・`done` は消さない。`now − 15 分` より前の行は作らない。
- 送る時刻：`zoned`・`utc` は `start_utc − 分`。`floating`・`date` は壁時計の開始（終日は 00:00）から分を引いた壁時計の時刻を、持ち主のカレンダーのタイムゾーンで `resolve`（[ADR-0002](0002-time-representation.md)）。
- 送信の記録の一意の鍵は a。`reminder_id` を（利用者, 予定オブジェクト, `recurrence_id`, 分）と読み、版を鍵から外す。古い版の時刻で送らない役目は、付け替えでの行の削除と、notifier の送る時の確かめ（回の開始が今と同じか）が持つ。
- だれに送るかは DT-REM-001（辞退、`hidden`・`cancelled`、保留の招待、区間だけの見え方には送らない）。

### 他の案を選ばなかった理由

- **2（548 日の全部）**：S1 で数億行になり、繰り返しの系列の 1 回の変更で数百行の付け替えになる。ほとんどは送る前に変わる。
- **3（次の 1 回だけ）**：送った後に次を作る処理が、時計の送りの経路に入る。止まったときに次の回が作られない。
- **b（版を鍵に入れる）**：送った直後にタイトルだけが変わり、遅れて届いた付け替えが `now − 15 分` の内の行を作り直すと、新しい版の鍵で 2 回目が送られる。重複 0.01% 未満（NFR-003）を守りにくい。

## Consequences

- 良くなること：
  - 計画の行の数が 7 日分で済む（S1 で約 2,100 万行）。
  - 付け替えが（利用者, 予定オブジェクト）の単位の 1 トランザクションで、順序の入れ替わりと重複に強い。
  - 終日の予定の分が、夏時間の切り替えをまたいでもずれない。
  - タイトルだけの変更で重複しない。
- 引き受けるコスト：
  - 最初の設計の鍵の書き方と違う。統合の工程で、[architecture/README.md](../architecture/README.md) の 1.3 節、題材の `AGENTS.md`、[ADR-0046](0046-sli-from-ledgers-and-delivery-tracing.md) をこの ADR の鍵に直した（2026-10-04）。
  - 毎時の端の進めが止まると、7 日先の端の回が計画されない。止まった時間を監視する。
  - 付け替えの遅れ（p99 10 秒）より近い先のリマインダーは、古い行のまま発火しうる。notifier の確かめで捨てるが、新しい時刻の行が遅れて作られるまでの間は送られない。

## Confirmation

- 表駆動テスト：DT-REM-001（だれに送るか）、DT-REM-002（付け替えの事象）。
- 性質ベーステスト：PROP-REM-001（高々 1 回。タイトルだけの変更と遅れた付け替えを含む）、PROP-REM-002（古い時刻を送らない）、PROP-REM-004（送る時刻の計算。夏時間の日の終日の予定を含む）。
- 本番：付け替えの遅れの p99、`reminder.replan` の列の深さ、端の進めのジョブの最後の成功の時刻。

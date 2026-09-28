---
status: accepted
date: 2026-09-28
---

# ADR-0047: SLA の達成率は期間の中に停止した計時の行を母数にし、`breach_disputed` の行は厳格と調整の 2 つの値と件数で出す。既定の表示は厳格にする

詳細は [reports.md](../architecture/reports.md) の 8 節。

## Context

[intent.md](../intent.md) の K2 と MVP の範囲は、SLA の達成率のレポートを求める。[ADR-0021](0021-sla-definitions-and-timers.md) は、カレンダー・祝日の計算し直しで期限が後ろに動いても違反の事実を取り消さず、`sla_clock_event` に `breach_disputed` を残し、その扱いをレポートで決めるとした。[sla-and-calendars.md](../architecture/sla-and-calendars.md) の 13 節は、契約の報告での扱いを E11 で PM が決めると持ち越した。

計時の行は、`stage`（`in_progress`・`paused`・`completed`・`cancelled`）、`breached`、`stop_at`、`planned_end` を持つ（同じ文書の 6.2 節）。本家の達成率の数え方は、公開の資料で確かめられなかった（未検証。本家の振る舞いで、この決定の前提ではない）。

## Options

### 母数

1. **期間の中に停止した（`completed`）行**
2. 期間の中に開始した行
3. 期間の中に違反したか停止した行

### `breach_disputed`

- a. **厳格（違反に数える）と調整（新しい期限で判定する）の両方を出し、既定は厳格**
- b. 常に違反に数える
- c. 常に新しい期限で判定する

## Decision

1 と a を採用する。

- 期間はテナントのタイムゾーンの暦の半開区間。定義は `stable_key` で数え、版ごとの内訳を出す。
- 母数は `completed` かつ `stop_at ∈ P` の行。達成率 = 達成 ÷（達成＋違反）。取り消しと進行中は母数に入れず、件数を別に出す。
- 停止した行を DT-RPT-002 で分類する：`breached = false` は達成、`breach_disputed` がなく `breached` なら違反、`breach_disputed` があり `stop_at ≤ 今の planned_end` なら争いのある違反、そうでなければ違反。
- 厳格の達成率は争いのある違反を違反に、調整の達成率は達成に数える。既定の表示は厳格で、調整と争いのある件数を並べる。テナントは既定の表示を選べ、選んだことを監査に残す。
- ACL は見る人が読めるタスクの計時の行だけ（[ADR-0046](0046-acl-aware-aggregation-and-per-recipient-delivery.md)）。

2 を採らない理由：長い SLA（数週間の解決）の達成率が、期間の後まで確定しない。月次の報告が、後から変わる。

3 を採らない理由：違反した後に次の期間で停止した行が、2 つの期間に数えられうる。

b を採らない理由：法の改正で祝日が足されたとき、顧客は契約の上で期限の延長を認めたいことがある。その値を出せない。

c を採らない理由：違反の通知・エスカレーション・フローは違反の時点で動いている。達成と数えると、動いた処理の記録と食い違う（ADR-0021 の y を採らなかった理由と同じ）。

## Consequences

- 良くなること：
  - 月次の達成率が、期間の後に変わらない（計算し直しで `stop_at` と `breached` は変わらないため。調整の値だけが `planned_end` の変化で変わりうる）。
  - `breach_disputed` の扱いを、事実を消さずに顧客の契約に合わせられる。
- 引き受けるコスト：
  - 2 つの達成率を出すので、画面と説明が増える。
  - `breach_disputed` は事象の表にしかない。`sla_clock.breach_disputed_at` の列を足す提案を sla-and-calendars の領域に出す（統合で決める）。2026-09-28 の注記：統合で足すと決めた。計算し直しのジョブが `breach_disputed` の事象を書くのと同じトランザクションで `sla_clock.breach_disputed_at` を入れる（[sla-and-calendars.md](../architecture/sla-and-calendars.md) の 6.2・8 節）。DT-RPT-002 の「`breach_disputed` の事象がある」は、この列が空でないことで判定する。
  - 調整の達成率は、進行中の行の計算し直しで後から変わりうる（停止の後は変わらない）。

## Confirmation

- 決定表 DT-RPT-002。
- 性質ベーステスト PROP-RPT-004（分け方と大小）、PROP-RPT-005（期間の加法）。
- quality の SLA の達成率の指標（[sla-and-calendars.md](../architecture/sla-and-calendars.md) の 14 節）を、このレポートと同じ数え方で出すこと。

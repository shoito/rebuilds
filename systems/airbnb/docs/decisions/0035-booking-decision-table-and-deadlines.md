---
status: accepted
date: 2026-10-10
---

# ADR-0035: DT-BKG-001 を 35 行で確定する。リクエストの承認は `accepted_at` を書いて売上の確定を待つ段を持ち、確定の結果で `confirmed` か `cancelled` にする。期限は 8 つの列と `next_deadline_at` で持ち、照会の結果が不明なら 2 分ずつ 3 回まで延ばす。運用の保留は送金の振り替えだけを止める

> 2026-10-10 の注記：統合の工程で、T&S の `hold`（[ADR-0057](0057-ts-decision-points-and-outcomes.md)）のための行 13a（T&S の判定の前のホストの承認を 409 にする）・21a（`ts_decline`）・21b（`ts_clear`）・21c（判定の期限を過ぎたらホストに任せる）と、期限の列 `ts_review_due_at` を足した。31 行は 35 行、期限の列は 8 つになった。既存の行の意味は変えていない。

## Context

- [ADR-0004](0004-booking-state-machine-and-holds.md) は予約の状態の機械と DT-BKG-001 の 16 行の草案を置き、確定は booking-and-holds の領域の spec に書くとした。
- 草案は、承認と売上の確定を 1 つの事象として書いた（行 7・8）。実際は承認の後に提供者を呼び、結果は非同期で来る。
- 仮押さえの期限で提供者の結果が不明なとき、すぐ取り消すと後で成功が分かり、日付を失った予約の返金が増える。いつまでも待つと日付を塞ぎ続ける。
- 送金の振り替え（`payout_release_at`）、日程の変更、チャージバック、運用の保留の行が草案にない。

## Options

1. **状態を増やさず、`requested` のまま `accepted_at` と 10 分の確定の期限で待つ。照会の不明は 2 分 × 3 回延ばす。31 行（統合の工程で 35 行）**
2. `accepted`（承認の後、確定の前）の状態を足す
3. 照会の不明は期限で必ず取り消す

## Decision

1 を採用する。表は [booking-and-holds.md](../architecture/booking-and-holds.md) の 7.2 節。

- 足した行：保留と解除（3・4）、古い起動（5）、3-D セキュア（7）、仮押さえが外れた後の成功（9・10）、照会の不明（12・13）、承認と確定の待ち（14〜19）、オーソリの無効（15）、送金の振り替え（28）、日程の変更（29）、チャージバック（30）。
- 期限の列：`hold_expires_at`、`request_expires_at`、`check_in_at`、`check_out_at`、`payout_release_at`、`alteration_expires_at`、`arrival_info_at`（知らせだけ）、`ts_review_due_at`（T&S の `hold` の判定の期限。統合の工程で足した）。`next_deadline_at` は生きている列の最小。
- 照会の不明：`hold_expires_at` と `stay_claims.hold_expires_at` を 2 分延ばし、3 回で `cancelled`（`payment_unresolved`）。後で成功すれば全額を返す。
- 運用の保留（`on_hold`）は `payout_release_at` だけを `next_deadline_at` から外す。
- 草案の行の意味は変えない。

### 他の案を選ばなかった理由

- **2**：状態が 1 つ増え、照合・RLS・画面・PMS の API の全部に状態が増える。`accepted_at` の列で同じことが表せる。
- **3**：提供者の遅れ（数分）で、払ったゲストの予約を取り消し、返金と再予約を強いる。

## Consequences

- 良くなること：
  - 承認・確定・期限の競合が表の行で決まる。
  - 提供者の遅れで日付を失う予約が減る。
- 引き受けるコスト：
  - 照会の不明の間、日付を最大 16 分塞ぐ。
  - 表が 35 行になり、表駆動テストが増える。

## Confirmation

- 表駆動テスト：DT-BKG-001 の全 35 行に到達する。
- 性質ベーステスト PROP-BKG-004（期限は前に働かない）、PROP-BKG-006（チェックインの前の release なし）。
- 仮想の時計：[booking-and-holds.md](../architecture/booking-and-holds.md) の 7.5 節の例、照会の延長、`deadline-runner` の 2 時間の停止。

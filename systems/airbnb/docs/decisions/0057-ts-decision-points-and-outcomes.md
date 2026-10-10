---
status: accepted
date: 2026-10-10
---

# ADR-0057: 規則のエンジンは判定の点ごとに結果の意味を決める。予約（`booking.create`）の `hold` は、即時予約をリクエストに回して T&S の案件を開き、審査の判定を 4 時間以内に出す（断りは予約の事象 `ts_decline`）。`block` は決定的な一致の規則だけ。措置は `moderation_actions` に根拠を書いてから、状態を変える関数を呼ぶ。異議は別の審査員が 72 時間以内に判定する

> 2026-10-10 の注記：統合の工程で、予約の時の判定が 150ms で返らないときの扱いを「決定的な一致だけで判定し、後から評価して `allow` でなければ `review`」に揃えた（booking-and-holds の領域は「`allow` で進めて事後の審査」、trust-and-safety の領域は「決定的な一致を確かめてから `review`」と書いていた）。DT-BKG-001 に `hold` の 4 行を足した。

詳細は [trust-and-safety.md](../architecture/trust-and-safety.md) の 5 節。

## Context

- [ADR-0009](0009-trust-and-safety-and-ml-boundary.md) は、規則のエンジンの結果を `allow`・`step_up`・`review`・`hold`（予約の確定を止めて審査）・`block` とし、自動の措置を `step_up` と `hold` までとした。
- 即時予約の仮押さえは 10 分（[ADR-0004](0004-booking-state-machine-and-holds.md)）。10 分の中で人が審査することはできない。「確定を止めて審査」を、今のステートマシンのどこに置くかが決まっていない。
- 予約のリクエストは 24 時間で、ホストの判断を待つ状態 `requested` を持つ（[ADR-0004](0004-booking-state-machine-and-holds.md)）。
- Mercari の題材は、規則の言語、`block` を完全な一致に限る束の検査、影の評価と承認を決めた（[ADR-0051](../../../mercari/docs/decisions/0051-rules-engine-declarative-tables.md)）。

## Options

1. **判定の点ごとに結果の意味を決める。予約の `hold` は、リクエストに回して T&S の審査を足す**
2. 予約の `hold` を、確定の後の送金の保留と審査だけにする（予約はそのまま確定）
3. 予約のステートマシンに、T&S の審査の待ちの新しい状態を足す

## Decision

1 を採用する。

- 判定の点は `booking.create`・`listing.publish`・`listing.material_edit`・`payout_account.change`・`login`・`account.change`・`report`・`message.signal`・`review.signal`。
- 予約の `hold`：予約を `route = 'request_by_ts'` で作り、即時予約のリスティングでもリクエストとして作る。T&S の案件（`booking_hold`）を開き、4 時間以内（`request_expires_at` を超えない）に判定する。判定の前はホストの承認を受けない。断るときは措置を書いた後に予約の事象 `ts_decline`（`requested → declined`）を送る。認めるなら `ts_clear` を送り、ホストの判定を待つ。判定が期限に間に合わなければ、ホストの判定に任せる。DT-BKG-001 の行 13a・21a・21b・21c（[ADR-0035](0035-booking-decision-table-and-deadlines.md)）。
- 予約の時の判定が 150ms で返らないとき（`trust-safety` の遅れ・停止）：`booking` のプロセスの中の写しで決定的な一致（`block` の規則）だけを確かめ、当たれば `block`、当たらなければ進める。後から全部の規則で評価し、`allow` でなければ `review` と同じ扱いにする。
- 予約の `review`：予約を進め、確定の後に審査し、予約の事象 `ops_hold`（主体 T&S）でホストへの支払いの release を判定まで止める。
- `block` の規則は完全な一致の事実だけでできていなければ束を作れない。
- 措置は `applyModerationAction()` だけが書き、持ち主のサービスの関数を outbox で呼ぶ。
- 異議は元の判定と別の審査員が 72 時間以内に判定する。
- 規則の変更は PR、表駆動テスト、7 日の影の評価、T&S の責任者の承認で出す。

### 他の案を選ばなかった理由

- **2**：パーティーの危険が高い予約が確定し、日付が埋まる。審査で断るには運用のキャンセルが要り、ゲストの返金とホストの売る機会の損失が大きい。
- **3**：予約のステートマシンと決定表（DT-BKG-001）の全部の遷移と期限を増やす。今のリクエストの状態で足りる。

## Consequences

- 良くなること：
  - 予約のステートマシンを増やさずに、確定の前の人の審査を入れられる。
  - 自動の結果は、日付の塞ぎ（リクエストの 24 時間）と同じ形で、ゲストへの説明が一貫する。
- 引き受けるコスト：
  - booking-and-holds の領域の決定表に、事象 `ts_clear`・`ts_decline` と `route = 'request_by_ts'` の行を足す（統合の工程で足した）。
  - `hold` の予約は、ホストの承認と T&S の判定の 2 つを待つ。

## Confirmation

- PROP-TS-001（`block` の規則の形）、PROP-TS-002（措置の先の記録）、PROP-TS-003（再現）、PROP-TS-006（`hold` は確定しない）。
- 表駆動テスト：[trust-and-safety.md](../architecture/trust-and-safety.md) の 5.2・5.3 節。

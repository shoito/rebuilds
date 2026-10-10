# Runbook: 送金の遅れと失敗、銀行の障害

- Owner: Ops（当番）、財務
- 対応するアラート: 送金の時期（`payout_release_at` から release まで p99 30 分超。page）、`payout_release_overdue{age=gt_1h}`、送金の失敗の急増、提携銀行の API の 5xx・時間切れ、`payout_in_transit` の 3 営業日を超えた残り（R11）、組戻し
- 最終確認日: 2026-10-10

流れは [ledger-and-payouts.md](../architecture/ledger-and-payouts.md) の 6・7 節（[ADR-0048](../decisions/0048-release-payout-batching-and-holds.md)）。送金の待ちと保留は同じ文書の 7.3 節。

## 症状

- チェックインの予定の時刻 + 24 時間を過ぎても release がない予約がある（保留・待ちを除く）。
- 銀行の営業日の 09:30 の送金の依頼が失敗する、結果が不明のまま残る。
- 組戻し・資金返却が銀行の明細に来た。

## 影響

- ホストへの支払いが遅れる（NFR-008）。予約とゲストには影響しない。
- 二重の送金は、送金の ID の冪等キーと照会で防ぐ。結果が不明のときに再依頼すると二重になりうる。

## 確認

1. release の遅れ：`deadline-runner` の遅れ（`deadline_lag_seconds`）、`ledger` の消費者の遅れ、予約と台帳の照合（R2・R5）。チェックインの前の release（R5）が 1 件でもあれば SEV1。
2. 送金の状態ごとの数（`pending`・`submitted`・`paid`・`failed`・`returned`）と、失敗の理由のコードの分布。
3. 提携銀行の API の応答と、銀行の障害の知らせ。`bank_calendar` の営業日の値。
4. 待ち・保留の数（`payout_holds` の `wait`・`hold`、core の `payout_waits`）。新しいホストの最初の 3 件の待ち（`new_host_first_stays`）や口座の変更の 72 時間の待ちは正常の遅れである。
5. 失敗が特定の口座・ホストに集まっていないか（乗っ取りの兆し。口座の HMAC で数える）。

## 対処

1. **release の遅れ**：`deadline-runner`・`ledger` の消費者を再開する。溜まった `payout_release_due` は冪等キーで 1 回だけ書かれる。期限を過ぎた分はすぐ拾われる（DT-BKG-001 の行 28）。
2. **結果が不明の送金**：再依頼しない。送金の ID で照会する。分からなければその束を止め、銀行に問い合わせる。
3. **API が 30 分続けて使えない**：Ops の承認で、全銀の形式のファイルに切り替える。API で依頼した可能性のある送金は、照会で確かめてからファイルに入れる。渡した記録を `payout_batches` に残す。
4. **依頼の時点の不能**：型 15（`payout_failed`）で `host_payable` に戻し、ホストに口座の確かめを求める（自動）。
5. **組戻し**：型 16（`payout_returned`）で `host_payable_hold` に置き、保留 `bank_returned` をかける。ホストが口座を直したら解く。
6. **全体を止める**：台帳の不変条件の違反、チェックインの前の release、決着の重複、銀行の長い障害のときは `ops.payouts_enabled` を止める。release は続く（`host_payable` に溜まる）。
7. **特定のホストに失敗が集まる**：T&S の `account_takeover` の待ち行列に回し、必要なら措置の保留をかける（人の判定）。

## エスカレーション

- チェックインの前の release、決着の重複、二重の送金の疑い：SEV1。財務の責任者、テックリード、銀行の窓口。
- 銀行の障害が営業日をまたぐ：SEV2。PM にホストへの知らせを依頼する。

## 事後

- release の遅れと、ファイルへの切り替えの時間を記録する。
- 3 者の照合（R9〜R11）で、送金の仕訳と銀行の明細が 1 対 1 で合うことを確かめる。
- 失敗の理由の分布を、口座の名義の照合の改善の材料にする。

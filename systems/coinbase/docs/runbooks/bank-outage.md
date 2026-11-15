# Runbook: 銀行の障害と出金の結果の不明

- Owner: Ops（当番）、財務
- 対応するアラート: 銀行の API の時間切れ・誤りの率の上がり（page）、出金の結果の不明（`unknown`）の急増（page）、着金の通知と明細の照会の差、信託銀行の接続の時間切れ（チケット、財務）、出金の口座の残高の不足（チケット、財務）
- 最終確認日: 2026-11-15

前提の設計は [fiat-and-banking.md](../architecture/fiat-and-banking.md)（6 節の出金の状態、7 節の信託、10 節の障害の表）、[ADR-0050](../decisions/0050-fiat-withdrawals-idempotency-and-inquiry.md)、[ADR-0011](../decisions/0011-external-providers-boundary.md)。銀行の出口は [infrastructure.md](../architecture/infrastructure.md) の 4.2 節。**結果の分からない出金を依頼し直さない。** 二重の振込を防ぐことを、早く払うことより先にする。

## 症状

- 提携銀行の API が時間切れ・誤りを返す。着金の通知が届かない。
- 日本円の出金が `submitted` のまま `unknown` に進む件数が急に増えた。
- 信託銀行への依頼（`top_up`・`withdraw`）が時間切れになる。

## 影響

- 日本円の入金の記帳と出金の依頼が待つ。依頼の受け付けは続け、`held` で待つ（利用者から見て出金が遅れる）。
- 入出金の受け付けの可用性の SLO（99.9%）は、受け付けを続ける限り消費しない。遅れはお知らせで知らせる。
- 信託の依頼が遅れると、信託の不足（[ledger-reconciliation-mismatch.md](ledger-reconciliation-mismatch.md) の R5）が当日に解けないことがある。

## 確認

1. 銀行のアダプターの `outcome` の内訳（時間切れ、拒否、誤り）、始まりの時刻。銀行の障害の知らせ。
2. 銀行の出口（固定の IP、専用線と VPN）の状態。自分の側の出口の障害か（[infrastructure.md](../architecture/infrastructure.md) の 5 節）。
3. `unknown` の件数と額、束（`fiat_payout_batches`）の依頼の番号。
4. 明細の照会で拾えていない着金の有無。
5. 銀行の営業日と、他行あての振込の時間帯（`business_calendars`）。休業日の処理の遅れを障害と取り違えない。

## 対処

1. **新しい出金の依頼を止める**：`unknown` が急増したら `ops.fiat_withdrawals_enabled` を切る（`submitted` の前の出金を止める。受け付けは `held` で待つ）。
2. **`unknown` を照会で決める**：依頼の番号で結果を照会し、`accepted`・`failed` に進める。照会しても分からないものは Ops の確認に回し、銀行に問い合わせる。依頼し直さない。
3. **出口の障害**：予備の経路（専用線と VPN）へ切り替える。
4. **着金**：回復の後に明細の照会（1 時間ごと、毎営業日の朝）で拾い、銀行の取引の番号で 1 回だけ記帳する。手で着金を記帳しない。
5. **API が 1 営業日を超えて使えない**：全銀の形式のファイルを予備の手段にする（財務と Ops の 2 人の承認）。ファイルに入れる出金は `held` のものだけで、`unknown` のものを入れない。
6. **信託銀行**：依頼を照会で確かめる。依頼し直さない。不足がその営業日に解けなければ R5 の扱い。
7. **出金の口座の残高の不足**：束を送らずに、財務が入金の口座から補充する（`internal_transfer`、2 人の承認）。
8. 回復の後、`unknown` が 0 になり、照合（REC-BANK）が緑になってから、`ops.fiat_withdrawals_enabled` を 2 人の承認で開ける。

## エスカレーション

- 二重の振込の疑い（同じ出金に 2 つの振込）：SEV1。IC、財務の責任者。銀行に組戻しを依頼する。
- 信託の不足が当日に解けない：財務の責任者、コンプライアンス、法務（L3）。
- 障害が 4 時間を超える：PM（利用者への知らせ）。

## 事後

- `unknown` の件数、照会で決まった時間、予備の手段の使用の有無を記録する。銀行の 1 回の依頼の件数の上限と照会の API の振る舞い（**未検証**）を確かめた結果を、[fiat-and-banking.md](../architecture/fiat-and-banking.md) に反映する。

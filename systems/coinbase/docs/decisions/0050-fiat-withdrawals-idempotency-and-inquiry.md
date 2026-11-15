---
status: proposed
date: 2026-11-15
---

# ADR-0050: 日本円の出金は依頼の番号で冪等にし、結果の不明は照会で決める

## Context

日本円の出金は、本人の名義の口座にだけ送る（[architecture/README.md](../architecture/README.md) の 1.3 節 E）。

- 提携銀行での振込の実行（銀行の API を主、全銀の形式のファイルを予備、依頼の番号、結果の照会）は Stripe の [ADR-0018](../../../stripe/docs/decisions/0018-payout-execution-via-banking-partner.md) で決めた形がある。この題材は、利用者の拘束、手数料、出金の制限の差分を決める。
- 依頼の応答が時間切れになると、銀行が受け付けたか分からない。依頼し直すと二重に振り込む。
- BTC は 3 承認で記帳し、6 承認までは出金に使えない（[ADR-0009](0009-deposits-confirmations-and-own-nodes.md)）。[ADR-0029](0029-hold-kinds-and-withdrawal-restrictions.md) の制限は暗号資産の出金だけを止めるので、その BTC を売った日本円の出金で持ち出せる。
- 出金の宛先の誤りの責任と説明は、法務の L12 の確認待ちである。

## Options

1. **Stripe の ADR-0018 の形を引き継ぎ、出金をステートマシンにし、依頼の番号を採番してから送る。結果が分からなければ照会で決める。日本円の出金に使える額から、口座の解けていない出金の制限の円換算を引く**
2. 時間切れのときは同じ内容で依頼し直す（銀行の重複の検査に頼る）
3. 出金の制限は暗号資産だけにし、日本円の出金は制限しない

## Decision

1 を採用する。

- 状態は `requested` → `held` → `submitted` → `accepted` → `completed`、分かれは `unknown`、`failed`、`returned`、`rejected`（[fiat-and-banking.md](../architecture/fiat-and-banking.md) の 6.2 節の表）。`submitted` 以降は `rejected` に進めない。
- `held` で額と出金の手数料を拘束する（`fiat_withdrawal`）。`submitted` で拘束から `fiat_in_transit` と手数料の収益へ移す。`completed` で `fiat_in_transit` から出金の口座へ、銀行の振込の手数料を `bank_fee_expense:JPY` へ書く。`failed` では手数料も返す。
- 束の依頼の番号（`bank_request_ref`）を採番して保存してから送る。`unknown` では依頼し直さず、照会で状態を確かめる。照会しても分からなければ Ops の確認に回し、二重の振込を防ぐことを優先する。
- 出金に使える日本円 ＝ `available:JPY` − 同じ口座の解けていない出金の制限の円換算の額（0 未満なら 0）。円換算の価格は、その時点の参照の価格（[ADR-0006](0006-wallet-tiers-and-cold-ratio.md)）。

> 2026-11-15 の注記（統合）：円換算を引く式をやめ、[ADR-0039](0039-deposit-state-machine-and-withdrawal-lock.md) に合わせる。`withdrawal_restrictions` に `scope = account`・理由 `deposit_maturity` の解けていない行がある口座は、日本円の出金も `held` の前で待つ（[ADR-0029](0029-hold-kinds-and-withdrawal-restrictions.md) の注記）。参照の価格への依存（「引き受けるコスト」の 2 つ目）と、暗号資産の出金に資産をまたいだ式を入れるかの問い（3 つ目）はなくなる。PROP-FIAT-003 は「止めのある口座の日本円の出金の `held` 0」と読む。
- 出金の口座は本人の名義の 1 つだけ。登録と変更は、パスキーの確認と知らせを要し、変更の後 72 時間は出金を受けない（[ADR-0008](0008-withdrawal-pipeline-and-approvals.md) と同じ値）。
- 銀行の API が 1 営業日を超えて使えなければ、全銀の形式のファイルを予備の手段にする（財務と Ops の 2 人の承認）。

### 他の案を選ばなかった理由

- **2**：銀行の重複の検査の能力は**未検証**である。二重の振込は取り戻すのに組戻しの手続きが要る。
- **3**：6 承認の前の BTC を売った日本円で、巻き戻りの前に資産を持ち出せる。

## Consequences

- 良くなること：
  - 1 つの依頼から完了する振込は 0 か 1 になる。
  - 6 承認の前の入金を、日本円の出金でも持ち出せない。
- 引き受けるコスト：
  - 結果の不明の間、利用者の出金が遅れる。
  - 制限の円換算で、参照の価格に依る（参照の価格の障害の間は、制限のある口座の日本円の出金を止める）。
  - 暗号資産の出金にも、資産をまたいだ同じ式を入れるかは withdrawals の領域で決める。

## Confirmation

- 性質（PROP-FIAT-002）：`bank-sim` の任意の時間切れ・誤り・照会の列で、1 つの依頼の番号から完了する振込は 0 か 1。`unknown` からの依頼のし直し 0。
- 性質（PROP-FIAT-003）：6 承認の前の BTC の入金がある口座で、その円換算を超える日本円の出金の拘束 0。
- 表駆動のテスト（DT-FIAT-002）：出金の遷移の決定表の全行。

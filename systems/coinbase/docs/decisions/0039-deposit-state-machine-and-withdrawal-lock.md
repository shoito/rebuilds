---
status: proposed
date: 2026-11-15
---

# ADR-0039: 入金をステートマシンにし、出金に使える閾値まで口座の出金を止める

## Context

[ADR-0009](0009-deposits-confirmations-and-own-nodes.md) は、入金の状態を `detected`・`confirming`・`credited`・`reorged`・`reversed_suspense` とし、BTC は 3 承認で記帳し、6 承認まで「その額を出金に使えない」とした。領域の設計で、次のことが決まっていない。

- スクリーニングで止めた入金（法務の L6）、トラベルルールの情報の欠けた入金（法務の L5）、最小の額に満たない入金を、どの状態で持ち、記帳するか。
- 3 承認で記帳した BTC を取引所で売って日本円にすれば、日本円の出金で外へ持ち出せる。BTC の出金だけを止めても、二重の使用の攻撃の損失を防げない。
- 遷移を誰が書くか。複数の Worker が状態を書くと、巻き戻りと記帳が競う。

## Options

1. **状態に `review_hold`・`frozen`・`below_minimum`・`withdrawable` を足し、`transitionDeposit()` だけが遷移を書く。止めた入金は記帳しない。記帳の後、出金に使える閾値までは、口座の全部の出金を止める**
2. 止めた入金も `user_hold` に記帳し、拘束で使わせない。出金の止めは BTC の額だけにする
3. 1 と同じ状態にし、出金の止めは「入金した額の円換算」までの出金の額の上限にする

## Decision

1 を採用する。詳細は [deposits.md](../architecture/deposits.md) の 5 節。

- 状態と遷移の決定表（DT-DEP）は deposits.md の 5 節の表を正とする。遷移は `packages/deposits` の `transitionDeposit()` だけが、条件つきの更新で書き、`deposit_events` に行を足す。
- `review_hold`（スクリーニング・トラベルルールの保留）、`frozen`（凍結）、`below_minimum`（最小の額に満たない）の入金は、台帳に記帳しない。チェーンの上の資産との差は、照合で「記帳していない既知の入金」として説明する。
- `credited` で `withdrawable` でない入金がある口座は、暗号資産と日本円のどちらの出金も `held` の前で待たせる。止めは [ADR-0029](0029-hold-kinds-and-withdrawal-restrictions.md) の出金の制限の行（`withdrawal_restrictions`、理由 `deposit_maturity`）で持ち、範囲を口座の全部の出金にする（ADR-0029 の額の制限に範囲の印を足す）。注文と販売所には使える。BTC は 6 承認、ETH は記帳と同時に `withdrawable` にする。
- 最小の入金額は BTC 0.0001 BTC、ETH 0.001 ETH（本システムの値、資産の設定でバージョンつき）。満たない入金の扱いの変更は PM の判断待ち。
- `frozen` の後の扱い（保管、返却）は法務の確認待ち（L6）。返却は、本システムが作る出金として [ADR-0008](0008-withdrawal-pipeline-and-approvals.md) の流れを通す。

### 他の案を選ばなかった理由

- **2**：拘束の和が、未約定の注文・手続き中の出金・受け入れた提示の和と一致する不変条件（NFR-004）に、別の種類の拘束が混ざる。凍結の資産を利用者の残高として見せることにもなる。BTC だけの止めは、売って日本円で出す経路を残す。
- **3**：円換算の価格が動くと上限が変わり、境目の判定が価格の時点に依存する。止めの時間は通常 30 分ほどで、口座の全部を止めても利用者の不便は小さい。

## Consequences

- 良くなること：
  - 入金の状態と待ちの理由が 1 つの表で決まり、利用者と運用に見える。
  - 3 承認で記帳した入金を、どの資産に替えても、6 承認までは外へ持ち出せない。
- 引き受けるコスト：
  - BTC を入金した利用者は、約 30 分、日本円も出金できない。
  - 照合の等式に「記帳していない既知の入金」の項が要る（segregation-and-reconciliation の領域）。
  - 日本円の出金（fiat-and-banking の領域）と暗号資産の出金（withdrawals の領域）が、範囲が口座の制限の行を読む。

## Confirmation

- 表駆動のテスト：DT-DEP の全行。
- 性質ベーステスト（`chain-sim`）：PROP-DEP-001（閾値の前の記帳 0）、PROP-DEP-002（記帳は 0 か 1）、PROP-DEP-004（止めのある口座の出金の `held` 0）、PROP-DEP-005（判定が「通す」でない入金の記帳 0）。
- 照合：`review_hold`・`frozen`・`below_minimum` の額と、チェーンの上の入金のアドレスの残高の差を日次で照らす。

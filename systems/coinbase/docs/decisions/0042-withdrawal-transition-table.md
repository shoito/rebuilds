---
status: proposed
date: 2026-11-15
---

# ADR-0042: 出金の遷移の決定表を確定し、取り消しと期限を足す

## Context

[ADR-0008](0008-withdrawal-pipeline-and-approvals.md) は、出金を 13 の状態のステートマシンにし、遷移を `transitionWithdrawal()` の 1 つの関数だけが書くと決め、遷移の決定表（DT-WD）を withdrawals の領域で確定するとした。ADR-0008 の状態の表には、次の遷移がない。

- 方針が拒む出金（`policy` → `rejected`）。
- 承認を集めた後に段の残高が足りない出金（`approving` → `waiting_funds`）。補充を待つ間に承認の期限（30 分。[ADR-0036](0036-approver-keys-and-approval-payload.md)）が切れる。
- 利用者の取り消し、承認が来ないままの期限。
- 確認中の取引が巻き戻りでブロックから外れる場合（`confirming` → `broadcast`）。
- 前の取引が確定しえないと確かめた後の作り直し（ADR-0008 の「別の入力・別の nonce の取引を作ってよい」場合）の行き先。
- `completed` にする閾値。

## Options

1. **ADR-0008 の 13 の状態を変えずに、上の遷移を足す。取り消しは `rejected` の理由のコード（`user_cancelled`、`approval_expired` など）で表す**
2. 新しい状態（`cancelled`、`frozen`、`recreating`）を足す
3. 状態は ADR-0008 のままにし、上の場面は運用の手の操作で扱う

## Decision

1 を採用する。

| 新しい遷移・規則 | 内容 |
| --- | --- |
| `requested` → `rejected` | 拘束を書けなかった（`insufficient_funds`） |
| `policy` → `rejected` | 方針の最初に当たる行が `deny`（`policy_denied`。宛先が許可の一覧にない、待ち時間の中など） |
| `approving` → `waiting_funds` | 承認が揃ったが、段の残高が足りない |
| `waiting_funds` → `policy` | 段の残高が戻った。方針を判定し直す（累計と価格が変わっているため）。承認が要る行なら `approving` へ進み、承認を集め直す |
| `approving` → `rejected` | 承認者が拒んだ（`approver_rejected`）、または承認を求めてから 3 営業日の間に揃わない（`approval_expired`） |
| `signing` の前の状態 → `rejected` | 利用者が取り消した（`user_cancelled`）。`compliance_review` の間は利用者が取り消せない（法務の L6 の結論まで） |
| `broadcast` → `signing` | 前の取引が確定しえないとチェーンで確かめた（[ADR-0044](0044-stuck-transaction-replacement.md)）。新しい取引を作る |
| `confirming` → `broadcast` | 取引のブロックが巻き戻りで外れた。同じ署名済みの取引を流し直す |
| `completed` の閾値 | BTC は 6 承認、ETH は確定（finalized）。入金の記帳の閾値（[ADR-0009](0009-deposits-confirmations-and-own-nodes.md)）より深くし、`completed` の後の巻き戻りを稀にする |

- `compliance_review` で止める資産の扱い（拘束を戻して拒むか、凍結して留めるか）は法務の L6 の結論で決める。結論までは、拒む判断は `rejected`（拘束を戻す）、凍結の判断は `compliance_review` に留め、拘束を残す（ADR-0008 の「止めた間も拘束は戻さない」）。
- `signing` 以降は `rejected` に進めない（ADR-0008）。`ops.withdrawals_enabled.<asset>` を切ると、`signing` に入る遷移だけを止め、状態は変えない。
- 遷移ごとに `withdrawal_events` に行を足し、理由のコードを残す。利用者の画面には状態と待ちの理由のコードだけを出す。

### 他の案を選ばなかった理由

- **2**：状態が増えるほど、どの状態から先が取り消せないかの判定が散る。終わりの状態は「送らなかった（`rejected`）」と「送った（`completed`）」の 2 つに保つ。
- **3**：手の操作で状態を書くと、送った可能性のある出金を送らなかったことにする誤りが入る。

## Consequences

- 良くなること：
  - すべての遷移が決定表の行になり、表駆動のテストで全行を確かめられる。
  - 補充を待った出金が、古い承認や古い累計で署名されない。
- 引き受けるコスト：
  - 補充を待った大きな出金は、承認を 2 度集めることがある。
  - `completed` まで BTC で約 1 時間、ETH で十数分（**未検証**）、拘束が残る。利用者の画面には放送の後に「送金済み、確認中」と出す。

## Confirmation

- 遷移の決定表（DT-WD）の全行を表駆動のテストで確かめる。表にない遷移を `transitionWithdrawal()` が拒む。
- 性質（[quality.md](../quality.md) の 2.2.1 節 E）：任意の操作と放送の結果の列で、`signing` の後の `rejected` 0。`rejected` と `completed` の出金の拘束の残り 0。期限の切れた承認での署名 0。

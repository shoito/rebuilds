---
status: accepted
date: 2026-10-10
---

# ADR-0030: 支払いの試行を 8 つの状態で持ち、提供者の結果を 6 つの正規の結果に写す（DT-PAY-001）。取引の遷移は照会で確かめた結果からだけ起こす。応答・Webhook・照会のどれから来ても同じ関数を通す

## Context

- [ADR-0005](0005-payments-via-providers-and-capture-at-purchase.md) は、試行の行を先に書くこと、冪等キー、Webhook の inbox、照会の予定を決めた。試行の状態と、提供者ごとに違う結果の写し方は決めていない。
- 提供者の結果は、応答・Webhook・照会のどれから来るかわからず、重なり、遅れる。取引の遷移（`paid`・`cancelled`）が二度起きると、台帳の hold・refund の事象が重なる（冪等キーで仕訳は 1 つでも、取引の状態が誤る）。
- 確定の額が依頼の額と違う、見つからない、未知の状態、といった例外を、提供者ごとの分岐で扱うと、取引の側に提供者の差が漏れる。
- Shopify の題材は、試行の状態と正規の結果を決めた（[Shopify の ADR-0035](../../../shopify/docs/decisions/0035-payment-attempt-states-and-result-normalization.md)）。この題材は考え方を参照し、コンビニ払いと C2C の取引の遷移に合わせて自前で書く。

## Options

1. **試行の状態の機械と正規の結果を本システムで持ち、提供者ごとの写しの表で写す。取引の事象は試行が終わった状態に着いた時に 1 回だけ出す**
2. 提供者の状態をそのまま取引に渡す
3. Webhook だけを信じ、照会は障害の時だけ使う

## Decision

1 を採用する。詳細は [payments-and-escrow.md](../architecture/payments-and-escrow.md) の 5・6 節。

- 試行の状態：`created`、`submitted`、`requires_action`、`awaiting_payment`、`unknown`、`succeeded`、`failed`、`voided`、`expired`（終わった状態は後の 4 つ）。状態は条件つきの更新（`WHERE state = $from`）で進め、終わった状態から動かさない。
- 正規の結果：`succeeded`、`failed`、`requires_action`、`pending`、`awaiting_payment`、`expired`。加えて、例外の `mismatch`（確定の額の違い）と `unknown`。
- 写しの表 DT-PAY-001 を提供者ごとに持つ。見つからない試行は、依頼から 10 分までは `pending`、超えたら `failed`（依頼が届かなかった）。
- 取引への `payment_succeeded`・`payment_failed` は、試行が `succeeded`・`failed` に着いた時に 1 回だけ出す（試行の行に出した時刻を記録）。
- Webhook の中身は信じず、必ず照会の結果で試行を進める。応答・Webhook の処理・照会の予定は、同じ関数 `applyOutcome(attempt_id, outcome)` を呼ぶ。
- 拒否の理由は本システムの理由のコードに写し、買い手には文言だけを出す。

### 他の案を選ばなかった理由

- **2**：取引の決定表に提供者の状態の分岐が入り、提供者を替えるたびに決定表を変える。
- **3**：Webhook の欠け・遅れで取引が止まる。Webhook の偽装に弱い。

## Consequences

- 良くなること：
  - 提供者の差が写しの表に閉じる。取引の決定表は正規の結果だけを見る。
  - 重なった結果でも、取引の事象は 1 回。
- 引き受けるコスト：
  - Webhook ごとに照会を 1 回呼ぶ。提供者の照会の上限と費用を capacity の領域で見積もる。
  - 写しの表を提供者ごとに保守し、契約の試験で確かめ続ける。

## Confirmation

- 表駆動テスト：DT-PAY-001 の全行（提供者ごと）。
- 性質ベーステスト：PROP-PAY-001（結果の一回性）、PROP-PAY-003（不明で進めない）を `psp-sim` で。
- 本番：`unknown` が 24 時間を超えた試行 0 件。

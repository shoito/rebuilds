---
status: accepted
date: 2026-10-10
---

# ADR-0040: 購入での使用の順は、ポイント（期限の近い順）→ 売上金（ロットの期限の近い順）・残高 → カード・コンビニ払いに固定する。引き当ては購入の先着の印を取った試行だけが、取引の作成の前に行う。残高の hold は `(transaction, id, hold_balance)` で、カードの hold と分ける

## Context

- [ADR-0002](0002-transaction-state-machine-and-single-purchase.md) は、売上金・ポイントで払うときは購入の前に `ledger` に引き当てを依頼すると決めた。[ADR-0005](0005-payments-via-providers-and-capture-at-purchase.md) は、組み合わせ（ポイント＋カード）ではポイントを先に引き当て、残りをカードにすると決めた。
- 利用者がポイント・売上金・残高を同時に持つとき、どれから使うかで、期限の近いお金が失効する額が変わる。
- [ADR-0003](0003-escrow-and-double-entry-ledger.md) の表は、カードの確定と残高での購入の hold の冪等キーをどちらも `(transaction, <id>, hold)` とした。組み合わせの支払いでは 1 つの取引に hold が 2 つ要り、同じキーでは 2 つ目が書けない。
- 人気の出品で負ける数千の試行が引き当てると、ledger が無駄に叩かれる。

## Options

1. **順を固定する（ポイント → 売上金・残高 → 外部）。印を取った試行だけが引き当てる。残高の hold のキーを分ける**
2. 利用者が順を選ぶ
3. 引き当てを取引の作成の後に行う

## Decision

1 を採用する。詳細と例は [payouts-and-points.md](../architecture/payouts-and-points.md) の 7 節。

- 使用の順：ポイント（ロットの期限の近い順、期限なしは最後）→ 売上金（ロットの期限の近い順）→ `user_balance` → カードかコンビニ払い。利用者は「ポイントを使う」「売上金を使う」を外せるが、順は変えられない。売上金・残高は `legal.proceeds_spendable`・`legal.balance_enabled` のときだけ使う。
- 引き当て（`reserve`、冪等キー `(purchase_attempt, <id>, reserve)`）は、先着の印を取った試行だけが、DB の条件つきの更新の前に同期で行う。購入が失敗したら `reserve_release` で戻す。結び付かない引き当ては照合が 15 分で戻す。
- 取引の作成の後、`hold_balance`（`balance_reserved` → `escrow`）を冪等キー `(transaction, <id>, hold_balance)` で書く。カードの hold（`hold_psp`）は `(transaction, <id>, hold)` のまま。ADR-0003 の残高の行のキーだけを変えた。
- 全額が残高で賄えるとき、`purchaseListing` は同じトランザクションで取引を `paid` にする（手段 `balance` の `payment_succeeded`）。
- refund の残高の分は `balance_reserved` に戻し、同じ ledger のトランザクションの `reserve_release` で、引き当ての記録の通りに元の口座へ戻す。

### 他の案を選ばなかった理由

- **2**：画面と試験の組み合わせが増え、期限の近いお金を失う選び方を許す。
- **3**：取引を作った後に残高が足りないとわかると、取引を取り消して出品を戻すことになり、人気の出品で取り合いが繰り返される。

## Consequences

- 良くなること：
  - 期限の近いお金から使うので、失効が少ない。
  - 組み合わせの支払いの hold が 2 つの冪等キーで書ける。
- 引き受けるコスト：
  - 購入の経路に ledger への同期の呼び出しが 1 回入る（残高を使う購入だけ）。ledger が使えないときは、残高を使う購入を 503 にし、カードだけの購入は進める。
  - ADR-0003 の表の残高の行の冪等キーと違う。ADR-0003 の決定（冪等キーで 1 回）の意味は変えていない。

## Confirmation

- 性質ベーステスト：PROP-PAYOUT-004（使用の順）、PROP-LED-001・002（組み合わせの支払いと取り消しで釣り合い、決着が 1 回）。
- 負荷試験：人気の出品の 5,000 件/秒で、ledger への引き当ての呼び出しが 1 件（Valkey あり）。

---
status: proposed
date: 2026-11-15
---

# ADR-0019: 口座の取引の制限を理由ごとの行で持ち、板の入力で止めを閉じる

## Context

口座の取引を止める理由はいくつもある。本人確認の前、不公正取引の調べ（法務の L7）、乗っ取りの疑い、制裁の一致と差押え（法務の L6・L14）、退会の手続き。

- 理由ごとに、止めるもの（新しい注文、取り消し、板にある注文、販売所、出金）と、解除の承認が違う。
- 理由を 1 つの「口座の状態」の列で持つと、2 つの理由が重なったときに片方の解除でもう片方も解けてしまう。
- `order-gateway` が制限を確かめてから注文が sequencer に届くまでの間に制限が付くと、止めたはずの口座の注文が板に入る。

## Options

1. **制限を理由ごとの行（`account_restrictions`）で持ち、解けていない行が 1 つでもあれば止める。制限を付けたら板ごとに `AccountBlock` を sequencer に送り、エンジンでも止める**
2. 口座の状態の 1 つの列（`active`・`suspended`・`frozen`）で持ち、`order-gateway` だけで止める
3. 制限を付けたら、`order-gateway` で止め、板にある注文は `CancelAll` で取り消す（エンジンでは止めない）

## Decision

1 を採用する。

- 行は `account_id`、`kind`、`reason_code`、付けた者、時刻、解除の者と時刻、承認の ID を持つ。種類と扱いは [order-entry-and-risk.md](../architecture/order-entry-and-risk.md) の 4.7 節の表を正とする（MVP は `kyc_incomplete`・`trading_suspended`・`takeover_suspected`・`frozen`・`closing`）。
- `order-gateway` は注文の行を書くトランザクションで、解けていない行を読む（[ADR-0017](0017-order-row-states-across-clusters.md)）。新しい注文を止める行があれば `account_restricted` で拒む。取り消しはどの制限でも通す。
- 制限を付けた部品は outbox で事象を出し、`order-gateway` は板ごとに `AccountBlock`（その口座の板の注文の全部の取り消しを含む）を送る。エンジンは `AccountUnblock` まで、その口座の `NewOrder` を `account_blocked` で拒む（[matching-engine.md](../architecture/matching-engine.md) の 4.4 節）。
- 解除は、付けた者の側の手順で承認する（`frozen` と `trading_suspended` は作成者と別の人の承認）。全部の行が解けたら `AccountUnblock` を送る。
- 制限の種類と理由は、法令の結論で増える（法務の L6・L7・L14）。種類の追加は表への行の追加にし、コードの分岐を増やさない。

> 2026-11-15 の注記（統合）：`account_restrictions` は kyc-and-accounts の領域が持つ 1 つの表にする（[ADR-0052](0052-account-lifecycle-levels-and-restrictions.md)）。列は ADR-0052 の形（`kind` は `restricted`・`frozen`、理由は `reason_code`）で、この ADR の制限の名前（`kyc_incomplete`・`trading_suspended`・`takeover_suspected`・`closing`）は `reason_code` の値として同じ表に足す（`frozen` は `kind = frozen` の行）。理由のコードごとに、新しい注文・取り消し・板の注文・出金・販売所をどう扱うかは、理由の表（`restriction_reasons`）の行で持ち、各領域が自分の理由の行を足す。`order-gateway` は理由の表で「新しい注文を止めるか」を引く。

### 他の案を選ばなかった理由

- **2**：理由が重なると片方の解除で両方が解ける。`order-gateway` の確かめと sequencer の間の競りを閉じられない。
- **3**：`CancelAll` の後に、確かめを通った注文の入力が届くと板に残る。

## Consequences

- 良くなること：
  - 制限を付けた入力の `seq` の後に、その口座の新しい注文が板に入らない。
  - 理由ごとに付け外しができ、監査で誰がなぜ止めたかを追える。
- 引き受けるコスト：
  - エンジンが止めた口座の一覧を持つ（スナップショットに入る）。
  - 制限の事象から `AccountBlock` までの遅れの間、`order-gateway` の確かめだけで止める。

## Confirmation

- 性質（PROP-ORD-5）：制限を付けた後に `seq` の付いた新しい注文の約定 0。2 つの制限の片方を解いても止めが続く。
- 決定表（DT-ORD-4）：制限の種類ごとの、新しい注文・取り消し・板の注文の扱い。
- 監査：制限の付け外しの全件が承認の記録を持つ。

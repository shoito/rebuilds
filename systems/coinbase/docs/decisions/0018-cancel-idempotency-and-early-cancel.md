---
status: proposed
date: 2026-11-15
---

# ADR-0018: 取り消しを冪等にし、注文より先に届いた取り消しを板で覚える

## Context

取り消しは、相場の急変で利用者が最も急ぐ操作である。誤ると、取り消したはずの注文が約定し、拘束が戻らない（intent の Problem）。

- 取り消しは注文と同じく sequencer を通る（[ADR-0002](0002-sequencer-and-event-journal.md)）。注文の入力と取り消しの入力は、別の送りで sequencer に届く。`pending_submit` の注文（[ADR-0004](0004-order-entry-holds-and-idempotency.md)）の取り消しが、注文より先に記録に書かれることがある。
- ADR-0004 は、60 秒を超えて受け付けられない注文に「取り消しの入力を送り、拘束を戻す」とした。拘束を戻した後に、遅れて届いた注文の入力が約定すると、拘束のない約定になる。
- 利用者と API は取り消しを何度も送る。

## Options

1. **エンジンが、板にない `order_id` の取り消しに印を付け（60 秒）、後から届いた同じ注文を約定させずに `done` にする。印を付けたら `CancelRecorded` を出し、拘束はその合図か `OrderDone` の後に戻す。sequencer は送りの期限を過ぎた `NewOrder` を書かない**
2. 板にない注文の取り消しは拒み、`order-gateway` が注文の受け付けを待ってから取り消しを送る
3. 取り消しを sequencer の外で `order-gateway` が持ち、注文を送る前に止める

## Decision

1 を採用する。

- 取り消しは `order_id` か `client_order_id` で指す。`order-gateway` は core の行の `cancel_requested_at` を書き（2 度目は変えない）、`Cancel` を送って `seq` を返す。拘束には触れない。
- エンジンは `Cancel` を次のように扱う（[matching-engine.md](../architecture/matching-engine.md) の 4.2・4.3 節）。
  - 板にある注文：`OrderDone(canceled)`。
  - `done` の注文：`CancelRejected(already_done)`（利用者には成功と同じく「終わっている」と返す）。
  - 板になく、直近 60 秒に見ていない `order_id`：印（`order_id`、`ts` ＋ 60 秒）を付け、`CancelRecorded` を出す。
  - 口座の違う注文：`CancelRejected(not_owner)`。
- 印のある `order_id` の `NewOrder` は、検査より先に `OrderDone(canceled)` にする。印は `Tick` で期限を過ぎたら消す。
- `NewOrder` は送りの期限（`order-gateway` が送った時刻 ＋ 10 秒）を持ち、sequencer は自分の時計で期限を過ぎた `NewOrder` を書かずに拒む。期限（10 秒）は印の寿命（60 秒）より短いので、印が消えた後に古い送りが届くことはない。時計は Amazon Time Sync で揃える。
- 60 秒の送り直しの終わり（ADR-0004）では、`Cancel` を送り、`ledger-poster` は `CancelRecorded` か `OrderDone` を見てから拘束を戻す。
- 口座の全部の取り消しは板ごとの `CancelAll` にする。API の切断の時の自動の取り消しは、PM の判断の後に足す（[order-entry-and-risk.md](../architecture/order-entry-and-risk.md) の 10 節）。

### 他の案を選ばなかった理由

- **2**：受け付けの往復を待つ間に注文が約定しうる。急変の時に取り消しが遅れる。
- **3**：板の状態を変える判断が sequencer の外にでき、注文の入力がすでに記録にあるときに止められない。

## Consequences

- 良くなること：
  - 取り消しと注文がどの順で届いても、取り消しの後の約定が起きない。
  - 拘束を戻す時点が、エンジンの出力という 1 つの合図で決まる。
  - 取り消しの再送は何度でも同じ結果になる。
- 引き受けるコスト：
  - エンジンが印を 60 秒持つ（取り消しの山で増えるが、件数の上限を板の注文の上限と同じにする）。
  - `NewOrder` の送りの期限を過ぎた注文は、利用者に `rejected` として返り、再送が要る。

## Confirmation

- 性質（PROP-ME-9、PROP-ORD-4）：取り消しを注文の前・後・同時に送る任意の列で、取り消しの後の約定 0、拘束を戻した後の約定 0。
- 障害の注入：`order-gateway` から sequencer への送りを 0〜15 秒遅らせ、期限を過ぎた `NewOrder` が記録に書かれないこと。

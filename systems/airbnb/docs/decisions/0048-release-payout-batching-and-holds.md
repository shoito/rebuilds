---
status: accepted
date: 2026-10-10
---

# ADR-0048: release は措置の保留がなければ `host_payable`、あれば `host_payable_hold` に振り替える。決まった待ち（口座の変更の後 72 時間は ledger の `payout_holds` の `wait`、連絡先の変更などは core の `payout_waits`）は仕訳を動かさず、送金の束から外すだけ。送金は銀行の営業日の 09:30（日本時間）に、それまでの `host_payable` を束にして提携銀行の API で依頼し、使えなければ全銀の形式のファイルにする。最低の額はない。`host_receivable` は release の時に先に相殺する

## Context

- `payout_release_at` = `check_in_at` + 24 時間に release し、次の銀行の締めで送る。保留のホストは `host_payable_hold`（[ADR-0005](0005-payments-hold-capture-and-ledger.md)）。release から提携銀行への依頼まで、次の銀行の締め（営業日）以内（NFR-008）。
- accounts の領域は、口座・連絡先の変更、回復、最後のパスキーの削除の後 72 時間は送金の実行を待たせ、仕訳を動かさないと決めた。口座の変更は ledger の `payout_holds`、他は core の `payout_waits` に持つ（[ADR-0072](0072-sensitive-operations-payout-holds-and-account-deletion.md)）。
- ホストからの未収（罰、チャージバック、release の後の返金の不足）がある。
- Stripe の題材の提携銀行での送金（[ADR-0018](../../../stripe/docs/decisions/0018-payout-execution-via-banking-partner.md)）、Mercari の題材の全銀の形式のファイルへの切り替えを参照する。

## Options

1. **措置の保留は口座で、本人の操作の待ちは束から外すだけ。営業日 1 回の束。相殺は release の時**
2. どの保留も口座で表す
3. release ごとにすぐ送る（束にしない）

## Decision

1 を採用する。詳細は [ledger-and-payouts.md](../architecture/ledger-and-payouts.md) の 6・7 節。

- release：措置の保留（`payout_holds.kind = 'hold'`：`fraud_suspected`・`kyc_incomplete`・`kyc_mismatch`・`bank_returned`・`ops_case`）があれば `host_payable_hold`。なければ `host_payable` に入れ、`host_receivable` を型 23 で相殺する。
- 決まった待ち（ledger の `payout_holds.kind = 'wait'`：`payout_account_changed`・`new_host_first_payout` の 72 時間。core の `payout_waits`：ADR-0072 の他の理由）は仕訳を動かさない。`payout-batcher` が束の前に両方を読み、待ちのホストを外す。
- 束：銀行の営業日（`bank_calendar`）の 09:00 に作り、09:30 に提携銀行の API で依頼（冪等キー `payout_id`）。API が 30 分使えなければ全銀の形式のファイル。最低の額なし。振込の手数料は本システム（`bank_fee_expense`）。
- 送金の状態は `pending` → `submitted` → `paid`・`failed`・`returned`。組戻しは型 16 で `bank_returned` の保留。

### 他の案を選ばなかった理由

- **2**：本人の操作の待ちが措置と同じ口座に入り、72 時間ごとに往復の仕訳が増える（ADR-0072 の理由）。
- **3**：振込の件数と手数料が予約の件数だけ増え、銀行の締めの管理が難しい。

## Consequences

- 良くなること：
  - release は時刻どおりで、送金だけが待つ。NFR-008 の 2 つの段を分けて測れる。
- 引き受けるコスト：
  - 年末年始のように銀行の休業日が続くと、送金は休業の明けまで待つ。
  - 振込の手数料を本システムが負う。

## Confirmation

- 性質ベーステスト PROP-LED-003（チェックインの前の release なし）、PROP-LED-005（相殺）、PROP-PO-001（保留・待ちの間に送らない、同じ額を 2 回送らない）。
- 仮想の時計：年末のチェックインの例（[ledger-and-payouts.md](../architecture/ledger-and-payouts.md) の 6.1 節）。

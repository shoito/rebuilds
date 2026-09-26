---
status: accepted
date: 2026-09-26
---

# ADR-0015: 保留中・利用可能を別の口座にし、BalanceTransaction を仕訳の射影にする

ADR-0003（複式簿記の台帳）の勘定体系と、加盟店への見せ方を具体化する。詳細は [ledger.md](../architecture/ledger.md)。

## Context

本家 Stripe の加盟店は、残高を `pending` と `available` で見て、1 件ごとの動きを BalanceTransaction（`amount`・`fee`・`net`・`available_on`・`status`）で見る（[Balance](https://docs.stripe.com/api/balance/balance_object)、[BalanceTransaction](https://docs.stripe.com/api/balance_transactions/object)）。入金・返金に使えるのは `available` だけで、`pending` から `available` への移動は `available_on` の日に起きる。

台帳の内部で、次の 3 つを決める必要がある。

- 保留中と利用可能を、台帳でどう表すか
- 加盟店に見せる BalanceTransaction と、仕訳の関係
- 手数料を、仕訳と BT のどこに置くか

## Options

### 保留中と利用可能

1. **別の口座にする**（`merchant_pending` と `merchant_available`）。移動を仕訳にする
2. 1 つの口座にし、行の `available_on` で保留中か利用可能かを読むときに分ける

### BalanceTransaction

A. **仕訳から作る射影** にし、仕訳と同じトランザクションで書く
B. BT を正本にし、仕訳を BT から作る
C. BT を持たず、読むたびに仕訳から組み立てる

## Decision

1 と A を採用する。

- **勘定体系**：加盟店の口座（`merchant_pending`、`merchant_available`、`merchant_reserved`）と、プラットフォームの口座（`connector_receivable`、`bank_cash`、`payouts_in_transit`、`customer_cash_balance`、`fee_revenue`、`fx_revenue`、`processing_cost`、`fx_position`、`fx_gain_loss`、`loss_write_off`、`suspense`）を持つ。借方を正、貸方を負とする。
- **1 つの仕訳は 1 つの加盟店に属する。** プラットフォームの口座への行も、その加盟店の `account_id` を持つ。RLS と S2 のシャードが仕訳の単位で閉じる。
- **保留中から利用可能への移動は、加盟店 × 通貨 × 日ごとに 1 つの仕訳にまとめる。** 対象の BT の `status` を同じトランザクションで `available` にする。
- **`available_on` は決済の確定のときに決めて固定する。** 既定は本家の日本に揃え、初回 7 暦日、以後 4 営業日（[Payouts](https://docs.stripe.com/payouts)）。
- **BT は仕訳の射影。** 仕訳と同じトランザクションで作り、`status`・`availability_entry_id`・`payout_id` だけを後から変える。`type`・`reporting_category`・`fee_details` は本家の値を使う。
- **決済の手数料は、確定の仕訳の中で差し引く**（1 つの BT の `fee`）。決済に結び付かない手数料だけを `stripe_fee` の BT にする。
- 2 を採らない理由：残高の読み取りのたびに `available_on` で分ける計算が要り、集計を持つと、日付が変わるだけで集計が変わる（書き込みなしに値が動く）。入金の判定で使う `available` を、仕訳の合計として直接持てない。
- B を採らない理由：BT は本家の API の形に縛られ、プラットフォームの口座（未収金・収益）を表せない。
- C を採らない理由：一覧・絞り込み（`payout=`、`type=`）の API とレポートが、仕訳の結合で重くなる。

## Consequences

- 良くなること：
  - `available` の残高が仕訳の合計そのものになり、入金の判定と照合が単純になる。
  - 利用可能への移動が日に 1 回・1 仕訳なので、`merchant_available` への書き込みが決済の件数に比例しない。
  - 加盟店に見せる形（本家の API・レポート）と、台帳の内部を別々に変えられる。
- 引き受けるコスト：
  - 移動のジョブが遅れると、`available_on` を過ぎた BT が `pending` のまま残る。日次の検査で検知する。
  - BT と仕訳の 2 つを書くため、両者の一致を日次で検査する必要がある。
  - `reporting_category` の対応表を、本家の変更に合わせて保守する。

## Confirmation

- DB の制約：仕訳ごと・通貨ごとの合計が 0 でないコミットが失敗する（ADR-0003）。
- 性質ベーステスト：任意の決済・返金・Dispute・移動・入金の列の後で、加盟店・通貨ごとの BT の `net` の合計が、`merchant_*` の口座の残高（符号反転）と一致する。任意の金額と料金表で `fee + net = amount`、`0 ≤ fee ≤ amount`。
- 表駆動テスト：仕訳の種類 → BT の `type`・`reporting_category` の対応表。
- 日次のジョブ：`available_on` を 1 営業日以上過ぎた `pending` の BT が 0 件。

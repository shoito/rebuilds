---
status: accepted
date: 2026-09-26
---

# ADR-0010: PaymentIntent を唯一の決済オブジェクトにし、状態の遷移を 1 つの遷移関数に集める

## Context

決済は、カードの 3D セキュア、手動のキャプチャ、コンビニ・銀行振込の支払い待ち、コネクタの結果不明など、多くの途中の状態を持つ。状態の持ち方がばらばらだと、次のことが起きる。

- 同じ支払いに成功したオーソリが 2 つできる（二重請求）。
- 終わった支払いが、遅れて届いた通知で別の状態に戻る。
- 加盟店が本家の文書・SDK のまま組み込めない。

本家 Stripe は、PaymentIntent を 1 回の支払いの意図とし、7 つの状態（`requires_payment_method`、`requires_confirmation`、`requires_action`、`processing`、`requires_capture`、`succeeded`、`canceled`）で表す。確定のたびに Charge を作り、失敗したら `requires_payment_method` に戻して再試行させる（[PaymentIntent と SetupIntent の仕組み](https://docs.stripe.com/payments/paymentintents/lifecycle)、[PaymentIntent object](https://docs.stripe.com/api/payment_intents/object)。2026-09-26 に確認）。

## Options

1. **PaymentIntent を唯一の決済オブジェクトにする。** Charge は PaymentIntent の中の試行として読み取り専用で出す。状態は本家の 7 つ
2. **本家の旧来の Charges API（`POST /v1/charges`）も作る**
3. **独自の状態（オーソリ・売上・取消など、日本の決済代行の用語）で持ち、API で本家の状態に写す**

## Decision

1 を採用する。詳細は [payments.md](../architecture/payments.md) にある。

- **決済は PaymentIntent からだけ始まる。** Charge（`ch_`）は確定 1 回ごとの試行で、加盟店は作れない。Refund と Dispute は Charge に属する。
- **状態は本家の 7 つ。** 本家の文書・SDK・Webhook の処理が、そのまま使える。
- **遷移は 1 つの遷移関数に集める。** 関数は「今の状態 × きっかけ × 条件」の表（payments.md の 3.1 節）で次の状態と仕訳を決め、表にない遷移を拒否する。API・Webhook の受信・定期ジョブ・回復のジョブのすべてが、この関数を通る。
- **遷移・仕訳・Event を 1 トランザクションで書く。** PaymentIntent の行を `FOR UPDATE` で取ってから遷移する（[ADR-0003](0003-double-entry-ledger.md)、Event は outbox）。
- **DB の制約で二重オーソリを止める。** 同じ PaymentIntent で、オーソリ済み・キャプチャ済みの Charge は高々 1 つ、送信中・結果不明の Charge は高々 1 つ。どちらも部分一意インデックスで守る。
- 2 は、本家でも新規の組み込みに勧めていない経路で、状態の持ち方が 2 通りになる。作らない。
- 3 は、日本の決済代行の用語に近く実装しやすいが、加盟店向けの API で写し替えが要り、本家の文書のまま組み込めない。写し替えの誤りも起きうる。コネクタの用語はコネクタの中に閉じ込める（[ADR-0011](0011-connector-abstraction-and-unknown-outcome.md)）。

## Consequences

- 良くなること：
  - 加盟店が本家の文書・SDK で組み込める。
  - 状態の正しさを、表と性質ベーステストで確かめられる。
  - 二重オーソリを、コードの誤りがあっても DB が止める。
- 悪くなること、引き受けるコスト：
  - 1 つの PaymentIntent への操作は行ロックで直列になる。1 つの支払いに操作が集中することはまれなので、性能の問題にはならない見込み。
  - `processing` のあいだ、加盟店は confirm も cancel もできない（結果不明の回復を待つ）。加盟店向けの文書で説明する。

## Confirmation

- 表駆動テスト：遷移の表のすべての行と、表にない組み合わせ（拒否されること）。
- 性質ベーステスト：任意の操作と通知の列（重複・順序の入れ替えを含む）の後で、payments.md の 3.2 節の不変条件が成り立つ。
- DB の制約：同じ PaymentIntent に 2 つ目のオーソリ済み Charge を INSERT すると失敗する。
- lint：`payment_intents.status` を遷移関数の外で UPDATE するコードを禁止する。

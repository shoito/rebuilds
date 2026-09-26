---
status: accepted
date: 2026-09-26
---

# ADR-0013: コンビニ払いと銀行振込は PaymentIntent の `requires_action` で待ち、銀行振込は顧客の現金残高を経由する

## Context

日本向けに、コンビニ払いと銀行振込を MVP に含める（[intent.md](../intent.md)）。どちらも、顧客が確定の後に店頭や銀行で払うまで数日かかる。

- コンビニ払い：支払い番号の発行、支払い期限、店頭での支払いの通知、期限切れ。顧客の側から取り消し（Dispute）はない。
- 銀行振込：顧客が振り込む額を本システムが制御できない。多すぎる・少ない・複数の支払いをまとめて振り込む、が起きる。

本家は、コンビニ払い（`konbini`）を `requires_action`（`konbini_display_details`）で待ち、入金で `succeeded` にする。銀行振込（`customer_balance`、`jp_bank_transfer`）は、Customer ごとのバーチャル口座に振り込ませ、着金を Customer の現金残高に入れてから PaymentIntent に充てる。足りなければ一部だけ充てて `requires_action` のまま `amount_remaining` を示し、余りは現金残高に残す（[コンビニ決済](https://docs.stripe.com/payments/konbini/accept-a-payment?payment-ui=direct-api)、[銀行振込による支払い](https://docs.stripe.com/payments/bank-transfers)、[受け付け方](https://docs.stripe.com/payments/bank-transfers/accept-a-payment?payment-ui=direct-api)。2026-09-26 に確認）。

## Options

1. **本家に合わせる。** どちらも `requires_action` で待つ。銀行振込は Customer の現金残高を経由し、台帳に顧客ごとの現金残高の口座を持つ
2. **銀行振込を PaymentIntent ごとの口座（1 回限りの振込先）で受け、過不足はすべて手作業で扱う**
3. **非同期の決済手段を PaymentIntent とは別のオブジェクト（請求・入金待ち）で持つ**

## Decision

1 を採用する。詳細は [payment-methods.md](../architecture/payment-methods.md) の 5・6 節にある。

- **コンビニ払い**：confirm で収納代行に支払い番号を発行させ、`requires_action` にする。入金の速報で `succeeded`、期限（既定 3 日、1〜60 日）と猶予の後に `requires_payment_method` に戻す。返金は顧客の銀行口座への振込で、口座情報の入力を待つ `requires_action` を返金の状態に持つ。
- **銀行振込**：Customer ごとに 1 つのバーチャル口座を割り当てる。着金は Customer の現金残高（台帳の負債の口座）に入れ、自動（既定）か手動で PaymentIntent に充てる。一部の充当は `payment_intent.partially_funded` で知らせる。余りは現金残高に残す。
- **カード以外のコネクタは CDE の外（本体）に置く。** カード番号を扱わないので、PCI DSS の範囲を広げない。CDE の Connector Gateway と同じ共通の操作・能力・受信箱の規則に従う（[ADR-0011](0011-connector-abstraction-and-unknown-outcome.md)、[ADR-0014](0014-connector-inbox.md)）。
- 2 は、振込先の管理は単純だが、顧客が口座を登録して繰り返し使えず、過不足の手作業が増える。本家の組み込みとも合わない。
- 3 は、非同期の決済手段の違いを明示できるが、加盟店が決済手段ごとに別のオブジェクトを扱うことになり、Checkout・Webhook の処理が二重になる。

## Consequences

- 良くなること：
  - 加盟店は、カードと同じ PaymentIntent と Webhook（`payment_intent.succeeded` / `payment_failed`）で扱える。
  - 振込の過不足を、お金を失わずに台帳で追える。
- 悪くなること、引き受けるコスト：
  - **顧客のお金（現金残高）を本システムが預かる。** どの支払いにも充たらないお金を、いつ・どう返すか（本家は 75 日で返金を試み、90 日で加盟店の残高に移す）は、資金決済法の上の位置づけに依存する。法務の確認が済むまで、銀行振込の Epic の spec を承認しない。
  - バーチャル口座のプールと、提携する銀行の入金明細の取り込みを運用する。
  - コンビニの速報・確報のずれ、期限切れの後の入金を、照合と手作業で扱う。

## Confirmation

- 表駆動テスト：コンビニの期限（`expires_after_days`・`expires_at`・JST の 23:59:59）と、本家のテスト用のメールアドレス・確認番号による結果。
- 性質ベーステスト：任意の着金と PaymentIntent の列で、「着金の合計 ＝ PaymentIntent に充てた額の合計 ＋ 現金残高 ＋ 返金した額」が成り立つ。
- 照合のジョブ：収納代行・銀行の精算と、台帳の未収金の差が T+2 営業日までに 0（NFR-005）。

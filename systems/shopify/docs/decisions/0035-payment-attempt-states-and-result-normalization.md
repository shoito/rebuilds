---
status: accepted
date: 2026-10-10
---

# ADR-0035: 決済の試行（`payment_attempts`）の行は、提供者を呼ぶ前に書いてコミットする。試行の ID を提供者への加盟店の参照の番号にし、アダプターに「参照の番号で照会する」操作を足す。提供者の結果は 8 つの正規の結果に写し、チェックアウトと注文はこの正規の結果だけを読む

## Context

- [ADR-0006](0006-payments-via-providers.md) は、アダプターの契約（`createSession`・`getResult`・`capture`・`void`・`refund`・`verifyWebhook`）と冪等キーを決めた。`getResult` は提供者の参照の ID（`providerRef`）で照会する。
- `createSession` が時間切れになると、提供者の側にセッションができたかどうか分からず、`providerRef` も手元にない。照会できない。
- 提供者ごとに結果の名前と意味が違う（オーソリ、売上、支払い待ち、処理中）。[ADR-0005](0005-checkout-state-machine-and-exactly-once-orders.md) の決定表は、正規の結果で書く必要がある。
- Stripe の題材は、送る前に試行を記録し、結果不明を照会で確定する（[Stripe の payments.md](../../../stripe/docs/architecture/payments.md) の 7 節）。この題材は、その提供者の利用者として同じ考えを取る。

## Options

1. **送る前に試行を書く。試行の ID を参照の番号にし、参照の番号での照会をアダプターの必須の操作にする。結果を 8 つに正規化する**
2. `createSession` の応答を受けてから試行を書く
3. 提供者の結果の名前をそのまま持つ

## Decision

1 を採用する。詳細は [payments-integration.md](../architecture/payments-integration.md) の 4・5 節。

- 送信のトランザクションで `payment_attempts`（`state = 'created'`、`merchant_ref = attempt_id`、冪等キー `<checkout_id>:<attempt>:session`）を書いてコミットし、その後に `createSession` を呼ぶ。
- アダプターの契約に `findByReference(merchantRef)` を足す。提供者の照会の API が加盟店の参照の番号で引けることを、提供者の選定の必須の条件にする。
- 正規の結果（`PaymentOutcome`）：`authorized`、`captured`、`awaiting_payment`、`processing`、`failed`、`canceled`、`expired`（支払いなしでセッションの期限切れ）、`not_found`（参照の番号で見つからない）。提供者ごとの写しの表（DT-PAY-001）をアダプターに置く。
- `not_found` は、提供者の「作成したセッションが照会で見える」までの時間（能力の値 `lookup_consistency_window`、既定 5 分）の内は `processing` と同じに扱い、過ぎたら `expired` と同じに扱う。
- 試行の状態は、正規の結果から 1 つの遷移の関数で決める（[payments-integration.md](../architecture/payments-integration.md) の 5 節の表）。

### 他の案を選ばなかった理由

- **2**：時間切れのとき、提供者の側のセッションが記録のない孤児になる。
- **3**：決定表が提供者の数だけ増える。

## Consequences

- 良くなること：結果不明が、参照の番号での照会で必ず閉じる。決定表が提供者に依らない。
- 引き受けるコスト：参照の番号で照会できない提供者を選べない。ADR-0006 のアダプターの契約に操作が 1 つ増える。

## Confirmation

- 契約の試験：アダプターごとに、`createSession` の時間切れの後に `findByReference` で同じセッションを見つける。DT-PAY-001 の全行。
- 性質ベーステスト：`psp-sim` で、セッションの作成の時間切れを含む任意の場面で、試行は有限の時間で終端の状態か `awaiting_payment` に着く（PROP-PAY-001）。

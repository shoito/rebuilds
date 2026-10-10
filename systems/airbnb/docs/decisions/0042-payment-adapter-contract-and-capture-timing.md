---
status: accepted
date: 2026-10-10
---

# ADR-0042: アダプターは `authorize`・`capture`・`authorizeAndCapture`・`void`・`refund`・`inquire`・`chargeMerchantInitiated` の 7 つの操作と、Webhook の正規化だけを持つ。試行（`payment_attempts`）ごとに `<reservation_id>:<op>[:<seq>]` の冪等キーを提供者に渡す。結果は応答・Webhook・照会のどれから来ても、試行の状態を前にだけ進める 1 つの関数で決める。オーソリの期限の 24 時間前を見張る

## Context

- 決済は提供者に任せ、アダプターの契約は Shopify の題材の [ADR-0006](../../../shopify/docs/decisions/0006-payments-via-providers.md) と同じ形にする（[ADR-0005](0005-payments-hold-capture-and-ledger.md)）。
- 即時予約は確定の時に売上を確定し、リクエストはオーソリを取って承認で確定する（ADR-0005）。日程の変更の差額、損害の請求も請求が要る。
- 提供者の応答・Webhook・照会は、重なり、遅れ、順序が入れ替わる。予約の状態は前にだけ進めたい（[architecture/README.md](../architecture/README.md) の 1.2 節の原則）。
- 提供者の能力（オーソリの期間、通貨、加盟店からの請求）は選定の前（**未検証**）。

## Options

1. **7 つの操作、試行の行を先に書く、照会の結果で前に進める 1 つの関数、能力の表**
2. 提供者の SDK を各サービスから直接呼ぶ
3. Webhook の中身で状態を決める

## Decision

1 を採用する。詳細は [payments-and-fx.md](../architecture/payments-and-fx.md) の 4・5 節。

- 提供者を呼ぶ前に `payment_attempts` に `pending` の行を書いてコミットする。
- 冪等キー：`<reservation_id>:capture`・`:authorize`・`:void`・`:refund:<seq>`・`:alter:<seq>:capture`、`<claim_id>:charge`。
- `settleAttempt` だけが試行を `succeeded`・`failed` に進め、同じトランザクションで outbox に結果を書く。矛盾は照会で確かめ、`payment_anomalies` に記録する。
- Webhook は署名を確かめて inbox に入れ、照会を促す合図として扱う。
- 能力の表（`charge_currencies`、`authorization_validity`、`wallets`、`merchant_initiated`、`settlement_currency`、`partial_refund`、`fx_rates`）を選定の後に埋める。オーソリの期間が 48 時間より短い支払いの方法ではリクエストを受けない。

### 他の案を選ばなかった理由

- **2**：提供者の形が予約・台帳に漏れ、提供者の入れ替えができない。
- **3**：Webhook の順序の入れ替えで状態が戻る。

## Consequences

- 良くなること：
  - 結果の経路が 3 つあっても、状態は 1 つの関数で決まる。
  - 提供者の名前と形が `packages/payments/adapters` に閉じる。
- 引き受けるコスト：
  - 照会のジョブ（5 分ごと）の負荷。
  - 能力の表を埋めるまで、通貨とリクエストの条件が仮の値になる。

## Confirmation

- 性質ベーステスト PROP-PAY-001（前にだけ進む）、PROP-PAY-002（1 回の請求）。
- 契約の試験：アダプターごとに 7 つの操作と Webhook の正規化（`psp-sim` と提供者の試験の環境）。

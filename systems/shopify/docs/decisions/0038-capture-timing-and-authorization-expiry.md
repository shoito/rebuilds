---
status: accepted
date: 2026-10-10
---

# ADR-0038: 売上の確定は、既定で注文の作成の直後に outbox のジョブで行う。事業者は「最初の発送で確定」と「手動」を選べる。どれも確定は 1 回だけで、その時点の注文の残りの額を確定する。オーソリの期限（提供者の能力の値）の 72 時間前と 24 時間前に事業者に知らせ、24 時間前に未確定なら、既定で残りの額を自動で確定する

## Context

- [architecture/README.md](../architecture/README.md) の 6 節は、既定は注文の作成と同時の自動の確定、事業者は「発送の時に確定」を選べると決めた。
- 本家は、チェックアウトでの自動、注文の全体の配送で自動、手動の 3 つを持つ。オーソリの期限は提供者による（本家の決済で 7 日）。期限の 1 日前に知らせる設定がある（[Payment authorization and capture](https://help.shopify.com/en/manual/payments/payment-authorization)、2026-10-10 に確認）。
- Stripe の題材は、一部の確定を 1 回だけ許す（[Stripe の payments.md](../../../stripe/docs/architecture/payments.md) の 5.3 節）。他の提供者も同じ制約を持ちうる（未検証）。
- 確定を注文の作成のトランザクションの中で呼ぶと、外部の呼び出しがロックを持ったまま待つ。

## Options

1. **確定は注文の作成の後のジョブ。1 回だけ。期限の前に自動で確定する**
2. 確定を `completeCheckout` の中で同期に呼ぶ
3. 発送ごとに複数回確定する

## Decision

1 を採用する。詳細は [payments-integration.md](../architecture/payments-integration.md) の 8 節。

- `automatic`（既定）：`completeCheckout` が outbox に `payment.capture_requested` を書き、`capture-worker` が冪等キー `<checkout_id>:<attempt>:capture` で確定する。提供者が「オーソリと同時の確定」を持つなら、セッションの作成で指定し、ジョブは照会だけ行う。
- `on_first_fulfillment`：最初の配送の作成で、注文の残りの額（キャンセルした行を除いた額）を確定する。本家の「全体の配送で確定」と違い、分割の配送で期限が切れるのを避ける。
- `manual`：事業者が管理画面か Admin API で確定する。
- 確定の額は、確定の時点の注文の残りの額。確定の後のキャンセル・返品は返金にする。
- 期限：アダプターの能力の値 `authorization_ttl`（手段・カードの区分ごと）から `authorization_expires_at` を注文に持つ。72 時間前と 24 時間前に事業者に知らせる。24 時間前に未確定なら、ショップの設定 `capture_before_expiry`（既定 有効）で残りの額を確定する。無効なら、期限の後に `financial_status = expired` にし、事業者に知らせる（注文は取り消さない）。
- 確定の失敗（拒否）は、`financial_status = capture_failed` にして事業者に知らせる。自動で注文を取り消さない。

### 他の案を選ばなかった理由

- **2**：提供者の遅れが、チェックアウトの行のロックと NFR-001 の確定の p99 に乗る。
- **3**：提供者によって 2 回目の確定ができない。

## Consequences

- 良くなること：確定の失敗が注文の作成を巻き戻さない。分割の配送でも期限で売上を失わない。
- 引き受けるコスト：`automatic` でも、確定の完了は注文の作成の数秒後になる。確定の前のキャンセルは取り消し（`void`）、後は返金と分岐する。
- `on_first_fulfillment` は本家の「全体の配送で確定」と違う。

## Confirmation

- 性質ベーステスト：任意のキャンセル・配送・返品の列で、確定の額＋取り消しの額＝オーソリの額、返金の合計 ≤ 確定の額（PROP-PAY-004）。
- 表駆動テスト：確定の方式 × 事象（作成、配送、キャンセル、期限の 24 時間前）の表。

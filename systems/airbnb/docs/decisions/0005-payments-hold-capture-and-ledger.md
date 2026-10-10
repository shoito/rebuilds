---
status: accepted
date: 2026-10-10
---

# ADR-0005: 決済は提供者に任せ、即時予約は確定の時に売上を確定し、リクエストはオーソリを取って承認で確定する。お金は予約ごとの預かりの口座を持つ通貨ごとの複式簿記の台帳で持ち、チェックインの予定の時刻 + 24 時間にホストへの支払いへ振り替える。預かりの決着は冪等キーで 1 回に限る

> 2026-10-10 の注記：送金の保留の理由から「損害の請求の審査」と「新しいホストの初回」を外した。損害の請求は別のお金で、ホストの送金を止めない（[ADR-0050](0050-damage-claim-lifecycle-and-guest-charge.md)）。新しいホストは仕訳を動かさない送金の待ち（`new_host_first_stays`。[ADR-0048](0048-release-payout-batching-and-holds.md)、[ADR-0059](0059-fake-listing-signals-and-new-host-holds.md)）にした。

## Context

宿泊の予約は、支払いから滞在までが長い。数か月前の予約が普通で、1 年先もある。その間にキャンセル・日程の変更・返金が起きる。ホストは泊まりが始まってから受け取る。次を守る（NFR-007、NFR-008、NFR-015）。

- ゲストに請求する額は見積もりの額。
- ホストへの支払いはチェックインの前に動かない。チェックインの後に遅れず動く。
- 1 つの予約の預かりは、ホストへの支払い・ゲストへの返金・本システムの収益に、1 回だけ分かれる。和は預かりに一致する。
- 台帳は常に釣り合い、提供者・銀行の明細と照合できる。

本家は、送金をゲストのチェックインの約 24 時間の後に出す（[ヘルプの記事 3133](https://www.airbnb.com/help/article/3133)、2026-10-10 の統合の工程で確かめた。地域のヘルプは「チェックインの予定の時刻から 24 時間」と書く）。審査では、チェックインから最長 45 日遅れることがある（[ヘルプの記事 425](https://www.airbnb.com/help/article/425)）。

カードのオーソリの期限は、カードのブランドと提供者で違い、数日から 1 か月ほどである（提供者の能力の値。**未検証**）。予約から滞在までの長さより短いことが多い。

関係する題材：

- Shopify の題材は、売上の確定を既定で注文の作成の直後にし、オーソリの期限を見張る（[ADR-0038](../../../shopify/docs/decisions/0038-capture-timing-and-authorization-expiry.md)）。
- Mercari の題材は、購入の時に売上を確定し、預かりを自前の台帳で持つ（[ADR-0003](../../../mercari/docs/decisions/0003-escrow-and-double-entry-ledger.md)、[ADR-0005](../../../mercari/docs/decisions/0005-payments-via-providers-and-capture-at-purchase.md)）。
- Stripe の題材は、複式簿記・冪等・3 者の照合・提携銀行での送金を設計した（[ADR-0003](../../../stripe/docs/decisions/0003-double-entry-ledger.md)、[ADR-0017](../../../stripe/docs/decisions/0017-three-way-reconciliation-with-suspense.md)、[ADR-0018](../../../stripe/docs/decisions/0018-payout-execution-via-banking-partner.md)）。

## Options

売上の確定の時期：

1. **即時予約は確定の時に確定する。リクエストはオーソリを取り、ホストの承認で確定する**
2. オーソリだけを取り、チェックインの前に確定する
3. 予約の時はカードを登録するだけで、チェックインの数日前に請求する

お金の持ち方：

- a. **予約ごとの預かりの口座を持つ、通貨ごとの追記だけの複式簿記の台帳**
- b. 予約の行に金額の列（支払い済み、返金済み、送金済み）を持つ

## Decision

1 と a を採用する。

### 決済

- 決済は外部の提供者に任せ、本システムはカード番号に触れない。提供者のアダプターの契約（試行の行、冪等キー、Webhook の inbox、照会）は Shopify の題材の [ADR-0006](../../../shopify/docs/decisions/0006-payments-via-providers.md) と同じ形にする。Stripe の題材は提供者の 1 つとして使い、設計し直さない。
- **即時予約**：`reserveStay` の後、冪等キー `<reservation_id>:capture` でオーソリと売上の確定を同時に依頼する。3-D セキュアが要れば画面に戻す。結果は応答・Webhook・照会のどれから来ても、同じ関数で予約を `confirmed` か `cancelled` にする。
- **リクエスト**：冪等キー `<reservation_id>:authorize` でオーソリだけを取る。ホストの承認で `<reservation_id>:capture` の確定を依頼する。24 時間はオーソリの期限の中にある。断り・期限切れ・取り下げでオーソリを取り消す。
- **日程の変更の差額**：増える分は `<reservation_id>:alter:<seq>:capture` で追加の請求、減る分は返金。
- **支払いの通貨**：見積もりの通貨（[ADR-0008](0008-multi-currency-and-fx.md)）で請求する。

### 勘定科目（草案）

確定した表は ledger-and-payouts の領域の spec に書く。口座は通貨ごとに分かれる。

| 口座 | 種類 | 意味 |
| --- | --- | --- |
| `psp_receivable:<provider>` | 資産 | 提供者から入るお金 |
| `guest_funds_held:<reservation_id>` | 負債 | 予約ごとの預かり（ゲストから受け、まだ決着していない） |
| `host_payable:<host_account_id>` | 負債 | ホストへの支払い（送金の前） |
| `host_payable_hold:<host_account_id>` | 負債 | 保留のホストへの支払い |
| `tax_payable:<jurisdiction>:<tax>` | 負債 | 本システムが預かる税（法務の L4 の後に使う。既定はホストへの支払いに含める） |
| `guest_refund_payable` | 負債 | ゲストへの返金（提供者への依頼の前） |
| `service_fee_revenue` | 収益 | サービス料 |
| `fx_clearing:<ccy>` | 資産・負債 | 通貨の間の振り替え（[ADR-0008](0008-multi-currency-and-fx.md)） |
| `bank:<account>` | 資産 | 提携銀行の口座 |
| `suspense` | 仮 | 説明のつかないお金 |

### 仕訳と冪等キー

| 事象 | 仕訳 | 冪等キー |
| --- | --- | --- |
| 売上の確定（`reservation.confirmed`） | 借方 `psp_receivable` ／ 貸方 `guest_funds_held` | `(reservation, <id>, 0, hold)` |
| チェックインの後の振り替え | 借方 `guest_funds_held` ／ 貸方 `host_payable`（宿泊の対価 − サービス料）・`service_fee_revenue`・（税の預かりがあれば）`tax_payable` | `(reservation, <id>, <seq>, release)` |
| キャンセルの精算（チェックインの前） | 借方 `guest_funds_held` ／ 貸方 `guest_refund_payable`（返金）・`host_payable`（ホストの取り分）・`service_fee_revenue` | `(reservation, <id>, <seq>, settle)` |
| 全額の返金 | 借方 `guest_funds_held` ／ 貸方 `guest_refund_payable` | `(reservation, <id>, <seq>, refund)` |
| 日程の変更の差額 | 追加の請求は売上の確定と同じ形、減額は返金の形 | `(reservation, <id>, <seq>, alter)` |
| 滞在中・後の返金（release の後） | 借方 `host_payable`（ホストの負担）か `service_fee_revenue`（本システムの負担）／ 貸方 `guest_refund_payable` | `(reservation, <id>, <seq>, post_release_refund)` |
| 送金 | 借方 `host_payable` ／ 貸方 `bank` | `(payout, <id>, 0, execute)` |

- **1 回の決着**：`settlement_seq` が同じなら、release・settle・refund のどれか 1 つだけが書ける（台帳の一意の制約 `(reservation_id, settlement_seq)` の決着の型の行）。日程の変更は `settlement_seq` を 1 つ上げ、差分だけを書く。決着の後の `guest_funds_held:<reservation_id>` の残高は 0 でなければならない。
- 仕訳は通貨ごとに借方と貸方の和が等しくなければ書けない（DB の制約とコードの両方）。1 つの仕訳は 1 つの通貨に閉じる（[ADR-0008](0008-multi-currency-and-fx.md)）。
- 残高は仕訳の和で、残高の列を直接書き換えない。残高の行は、仕訳と同じトランザクションで更新する射影である（Stripe の題材の [ADR-0015](../../../stripe/docs/decisions/0015-chart-of-accounts-and-balance-transactions.md)）。
- 金額は通貨の最小単位の整数。

### 振り替えの時刻と送金

- `payout_release_at` = チェックインの日の物件の現地のチェックインの時刻 + 24 時間（UTC に直した瞬間。[ADR-0004](0004-booking-state-machine-and-holds.md)）。値（24 時間）は設定。本家に寄せた既定値。
- `deadline-runner` が時刻を過ぎた予約の release を依頼する。予約が `cancelled`・運用の保留なら依頼しない。
- ホストが送金の保留（不正の疑い、本人確認の未了、運用の案件）にあるときは、`host_payable` でなく `host_payable_hold` に振り替える。保留の解除で `host_payable` に移す。
- `payouts` は毎営業日、提携銀行の締めの前に、ホストごとの `host_payable` の残高を束にして送金を依頼する（Stripe の題材の [ADR-0018](../../../stripe/docs/decisions/0018-payout-execution-via-banking-partner.md) の考え方）。最低の送金の額は設定（既定なし）。失敗は戻しの仕訳と、ホストへの知らせ。
- MVP は円の国内の振込だけ。国際送金は ledger-and-payouts の領域で、法務の L6 の後に足す。

### 照合

- **予約と台帳**（5 分ごと）：`confirmed` なのに hold の仕訳がない、`payout_release_at` を過ぎたのに release がない、`cancelled` なのに settle・refund がない、決着した預かりの残高が 0 でない。
- **台帳の内部**（5 分ごと）：通貨ごとの釣り合い、全口座の和 0、残高の行と仕訳の和。
- **3 者**（日次）：台帳、提供者の精算、銀行の明細。説明のつかない差は `suspense` に置き、3 営業日で人が確かめる（Stripe の題材の [ADR-0017](../../../stripe/docs/decisions/0017-three-way-reconciliation-with-suspense.md)）。

### 法的な型

- 預かり（チェックインまで本システムが持つお金）の法的な性質は、法務の L5 の結論を待つ。既定は「ホストの代わりにゲストから受け取る収納代行」の型で、口座の種類と `legal.*` の値（保留の上限の日数、利用者の資金の保全の方法）で分けて持つ。資金移動業の型になったら、口座の種類の移し替えの仕訳と、保全の処理を足す（Mercari の題材の [ADR-0004](../../../mercari/docs/decisions/0004-proceeds-model-under-payment-services-act.md)、Uber の題材の [ADR-0024](../../../uber/docs/decisions/0024-fare-collection-model.md) と同じ形）。本番での預かりの開始は、法務の L5 の後。

### 他の案を選ばなかった理由

- **2（チェックインの前に確定）**：予約から滞在までがオーソリの期限を超えることが多く、取り直しの失敗で予約が宙に浮く。
- **3（後で請求）**：ゲストのカードの失敗が滞在の直前に分かり、ホストは日付を失う。分割払い（一部を今、残りを後で）は、残りの請求の失敗の扱いを決めてから MVP の後に足す。
- **b（予約の行の列）**：キャンセル・日程の変更・滞在中の返金・チャージバックが重なると、列の更新で和が合わなくなる。監査と照合の単位がない。

## Consequences

- 良くなること：
  - ゲストの支払いは予約の時に確定し、ホストの日付は支払いの失敗で失われない。
  - 預かりの決着が 1 回に限られ、照合で欠けと重なりを必ず見つける。
  - 法的な型が決まっても、口座の種類と設定の切り替えで済む。
- 引き受けるコスト：
  - 本システムが長い期間（最長 1 年以上）ゲストのお金を預かる。法的な整理（法務の L5）と、利用者の資金の保全が要る。
  - キャンセルの返金で提供者の手数料が戻らないことがあり、その負担の規則が要る（cancellations-and-changes の領域）。
  - 通貨ごとの口座と為替の口座で、勘定科目が増える。

## Confirmation

- 性質ベーステスト：任意の事象（確定、キャンセル、日程の変更、release、滞在中の返金、チャージバック、送金の失敗）を、重複・遅れ・順序の入れ替えで流し、通貨ごとの釣り合い、全口座の和 0、予約ごとの決着の 1 回、決着した預かりの 0、チェックインの前の release 0 を確かめる。参照の実装（`ledger-ref`）の残高と一致する（[quality.md](../quality.md) の 2.2.1 節 C）。
- 仮想の時計の試験：`payout_release_at` の計算（物件のタイムゾーン、日付の境）と、release の遅れ（同 D）。
- 本番：上の 3 つの照合と、送金の時期の SLI（[runbooks/](../runbooks/README.md)）。

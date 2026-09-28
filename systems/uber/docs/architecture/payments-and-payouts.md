# Payments and payouts: Uber

乗客からの支払いと、タクシー事業者への精算。外部の PSP（決済代行）での与信・売上の確定・追加の請求・返金、キャンセル料、代金の受け取り方（収納代行か、事業者を加盟店にするか）、複式簿記の台帳、事業者への精算と明細、照合を決める。

前提となる決定は、金額を円の整数で扱うこと（[ADR-0001](../decisions/0001-platform-and-stack.md)）、乗車の状態と与信の順序（[trips-lifecycle.md](trips-lifecycle.md)）、運賃の確定（[pricing-and-fares.md](pricing-and-fares.md)）。台帳と照合の考え方は、Stripe の題材の [ledger.md](../../../stripe/docs/architecture/ledger.md)、[payouts-and-reconciliation.md](../../../stripe/docs/architecture/payouts-and-reconciliation.md)、[payments.md](../../../stripe/docs/architecture/payments.md) を引き継ぐ。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0023](../decisions/0023-psp-authorize-at-request-capture-at-end.md) | 外部の PSP を 1 つの口で包む。依頼のときに与信し、乗車の終わりに売上を確定する。与信を超える額は追加の請求で受ける。PSP への操作は送る前に記録し、結果が分からないうちは次を送らない |
| [0024](../decisions/0024-fare-collection-model.md) | 代金の受け取りは、事業者から代理受領権を受ける収納代行の形を既定にし、事業者を加盟店にする形を代わりの道として同じ設計で持つ。どちらを使うかは法務の結論（L6）まで legal のフラグで止める |
| [0025](../decisions/0025-ledger-settlement-and-reconciliation.md) | 複式簿記の台帳で、事業者ごとの預り金を持つ。精算は月 2 回の締めで明細を作り、銀行振込で払う。台帳・PSP の精算・銀行の明細を 3 者で照合し、説明のつかないお金は仮勘定に置く |

## 1. 目的と範囲

- 扱う：決済の方法、与信の額、売上の確定、追加の請求、キャンセル料、運賃の訂正と返金、PSP の結果不明の回復、代金の受け取りの形、台帳の口座と仕訳、事業者への精算と明細、照合、未収の扱い。
- 扱わない：運賃の額の計算（[pricing-and-fares.md](pricing-and-fares.md)）、乗車の状態（[trips-lifecycle.md](trips-lifecycle.md)）、事業者の口座の登録の画面（[supply-and-operators.md](supply-and-operators.md)）、チャージバックの証拠の出し方の細部（S2）、会計の総勘定元帳への出力の細部（Stripe の題材の [payouts-and-reconciliation.md](../../../stripe/docs/architecture/payouts-and-reconciliation.md) の 7 節と同じ形にする）。
- **同じ乗車で、乗客に 2 回請求しない。事業者への精算の合計は、乗客から受け取った額と手数料の合計と一致する**（[intent.md](../intent.md) の守るべき振る舞い、NFR-006）。

## 2. 確かめたこと（2026-09-27）

### 2.1 PSP（Stripe を例に）

- 与信と売上の確定を分けられる（`capture_method = manual`）。確定の前に与信が切れると、PaymentIntent は `canceled` になる。一部だけ確定すると残りは解放される。ほとんどの決済は、与信に対して確定を 1 回だけ行える。オンラインのカードの与信の有効期間は通常 7 日。**日本のアカウントでは、Visa・Mastercard・JCB・Diners Club・Discover の JPY の取引を最長 30 日保留できる**。American Express と JPY 以外は通常の期間（[支払い方法を保留する](https://docs.stripe.com/payments/place-a-hold-on-a-payment-method)）。
- オーバーキャプチャー（与信より多く確定する）は、Visa・Mastercard・American Express・Discover のオンラインのカードに限り、Visa はタクシーとリムジンの業種で +20% まで。**JCB は対象の表にない**。IC+ の料金体系で提供される。確定の時に `request_overcapture=if_available` を付け、与信の応答の `overcapture.status` と `maximum_amount_capturable` で使えるかを知る（[オーバーキャプチャー](https://docs.stripe.com/payments/overcapture.md?platform=web&ui=elements)、2026-09-27 に確認）。
- マーケットプレイスの支払いの形は、ダイレクト支払い（連結アカウントが売り手）、デスティネーション支払い（プラットフォームが請求し連結アカウントへ送る。本家はライドシェアアプリを例にあげる）、支払いと送金別方式の 3 つ。ダイレクト支払いでは返金とチャージバックは連結アカウントの残高から、間接の支払いではプラットフォームの残高から引かれる（[Connect 導入における支払いの仕組み](https://docs.stripe.com/connect/charges)）。

### 2.2 代金の受け取り（法務の確認待ち L6）

- 2020 年の資金決済法の改正で、個人間の収納代行の一部（割り勘アプリ）が為替取引に当たると明示された。国内で完結する収納代行は、①債権者が事業者や国・地方公共団体で、②債務者が収納代行業者に払った時点で債務の弁済が終わり、二重払いの危険がないことが契約上明らかなら、為替取引の規制を適用する必要性は必ずしも高くない、という 2019 年の整理は変わらない（[金融審議会 資金決済制度等に関するワーキング・グループ報告](https://www.fsa.go.jp/singi/singi_kinyu/tosin/20250122/1.pdf)、2025-01-22）。
- 同じ報告は、クロスボーダーの収納代行の一部に資金移動業の規制を及ぼす方向を示した。この基盤は国内で完結する前提なので、直接には当たらないと見込むが、**結論は法務の確認待ち**（L6）。

### 2.3 日本版ライドシェア

- 運賃と料金の支払いは、原則キャッシュレス（[関東の運輸支局長の公示](https://wwwtb.mlit.go.jp/kanto/content/000324077.pdf)、2024-03-29）。配車アプリを使わない場合と災害の時は、現金も認められる（[事務連絡「自家用車活用事業の運用改善等について」](https://wwwtb.mlit.go.jp/kanto/content/000379002.pdf)、2026-02-26）。この基盤を通す日本版ライドシェアは、アプリの決済だけにする。

## 3. 方針

- **PSP は外部。カードの番号を持たない。** アプリは PSP の SDK でカードを登録し、この基盤は PSP のトークンと表示用の情報（ブランド、末尾 4 桁、期限）だけを持つ（[intent.md](../intent.md) の Constraints）。
- **1 つの乗車に 1 つの支払い（`trip_payments`）。** 与信の成功は高々 1 回、売上の確定の成功は高々 1 回。追加の請求は別の行で、訂正の番号ごとに高々 1 回。DB の部分一意索引で守る。
- **結果が分からないうちは、次の操作を送らない。** PSP の応答が切れたら、照会で結果を確定させてから進む（Stripe の題材の [ADR-0011](../../../stripe/docs/decisions/0011-connector-abstraction-and-unknown-outcome.md) の考え方）。
- **お金が動く操作は、台帳の仕訳と同じトランザクションで書く**（Stripe の題材の [ADR-0003](../../../stripe/docs/decisions/0003-double-entry-ledger.md)）。与信はお金を動かさないので仕訳を書かない。
- **事業者に渡すお金は、事業者のお金として分けて持つ。** 収納代行の形では、受け取った運賃は事業者への預り金で、この基盤の売上ではない。

## 4. 決済の方法と与信

### 4.1 決済の方法

| 方法 | タクシー | 日本版ライドシェア | 与信 |
| --- | --- | --- | --- |
| `app`（登録したカード、PSP の対応するウォレット） | 可 | 可（必須） | 依頼のとき |
| `in_vehicle`（車内でドライバーに払う。現金・車載の端末） | 可 | 不可 | なし |

- `in_vehicle` の依頼でも、決済の方法の登録を必須にする。キャンセル料と、事業者から受ける手数料の相殺の記録に使うため。
- 車内で払った乗車の運賃は、この基盤を通らない。手数料だけを事業者の預り金と相殺する（8.3 節）。

### 4.2 与信の額（DT-PAY-001）

| # | 運賃の種類 | 与信の額 |
| --- | --- | --- |
| 1 | `upfront`・`dynamic_upfront`、有料道路なし | 見積もりの総額 + 1,000 円 |
| 2 | 同上、有料道路あり | 見積もりの総額 + 有料道路の目安 × 1.5 + 1,000 円 |
| 3 | `meter` | 目安の上の額 × 1.3 + 迎車料金 + 手配料を、100 円単位に切り上げ |
| 4 | `in_vehicle` | 与信しない |

- 1,000 円の上乗せは、区間の分割（経路の変更の後のメーター）と待料金のため。額は運用の設定にし、追加の請求の失敗の率で見直す。
- 与信の額と上乗せの理由は、依頼の画面に示す（L8 の確認を経る）。
- 与信は `trip:{trip_id}:authorize` を PSP の冪等キーにして送る。

### 4.3 与信の有効期間

- 乗車は通常 1 時間以内に終わり、`awaiting_fare` の保留も 24 時間以内に確かめる。日本の JPY の与信（30 日）でも、American Express（7 日）でも足りる。
- 与信の期限（`auth_expires_at`）を PSP の応答から持つ。期限の 24 時間前に確定していなければ SEV2 とする。

## 5. 売上の確定と追加の請求

### 5.1 支払いの状態

```
 authorizing ─成功─▶ authorized ─確定─▶ captured ─返金（一部）─▶ partially_refunded ─全額─▶ refunded
     │                   │  └─与信の取り消し─▶ canceled
     │ 失敗              └─確定の後に不足───▶ captured（追加の請求の行が別に進む）
     ▼
   failed
```

```sql
trip_payments (id, trip_id UNIQUE, rider_id, operator_id,
               mode,                   -- 'app' | 'in_vehicle'
               collection_model,       -- 'agent_collection' | 'operator_merchant'（10 節）
               psp, psp_customer_ref, payment_method_ref,
               status,                 -- 'authorizing' | 'authorized' | 'captured' | 'partially_refunded' | 'refunded' | 'canceled' | 'failed'
               authorized_yen, captured_yen, refunded_yen, additional_charged_yen,
               overcapture_max_yen,    -- PSP が示したときだけ
               auth_expires_at, version, created_at, updated_at)

psp_operations (id, trip_payment_id,
                kind,                  -- 'authorize' | 'capture' | 'cancel' | 'refund' | 'additional_charge'
                seq,                   -- 同じ kind の中の番号（返金・追加の請求の何回目か）
                amount_yen,
                idempotency_key UNIQUE,-- 'trip:{trip_id}:{kind}:{seq}'
                psp_ref,
                status,                -- 'pending_send' | 'sent' | 'succeeded' | 'failed' | 'unknown'
                error_code, created_at, sent_at, completed_at)

CREATE UNIQUE INDEX one_inflight_op_per_payment ON psp_operations (trip_payment_id)
  WHERE status IN ('pending_send','sent','unknown');
CREATE UNIQUE INDEX one_success_per_kind_seq ON psp_operations (trip_payment_id, kind, seq)
  WHERE status = 'succeeded';
CREATE UNIQUE INDEX one_capture_per_payment ON psp_operations (trip_payment_id)
  WHERE kind = 'capture' AND status IN ('pending_send','sent','unknown','succeeded');
```

- `authorize` と `capture` は `seq = 1` だけ。`one_capture_per_payment` で、売上の確定を 2 回送ることを DB が止める。
- 1 つの支払いで、送信中か結果不明の操作は同時に 1 つだけ。

### 5.2 確定の流れ

1. Trips が `trip.fare_finalized`（確定の額、内訳）を outbox で出す（[trips-lifecycle.md](trips-lifecycle.md) の 3.3 節の行 16・18）。
2. Payments のワーカーが受け、請求の額 `F`（運賃 + 迎車料金 + 有料道路 + 待料金 + 手配料 − クーポン）を求める。
3. DT-PAY-002 で、確定の額と追加の請求の額を決める。
4. `psp_operations` に `capture` を `pending_send` で書いてコミットし、PSP へ送る。
5. 結果で状態を変え、仕訳（9 節）と outbox の事象を 1 つのトランザクションで書く。

**DT-PAY-002：売上の確定**

| # | `F` と与信の額 `A` | オーバーキャプチャー | 確定 | 追加の請求 |
| --- | --- | --- | --- | --- |
| 1 | `F` = 0（無料の取り消しなど） | - | 与信を取り消す | なし |
| 2 | `F` ≦ `A` | - | `F` を確定（残りは解放） | なし |
| 3 | `F` > `A` | 使え、`F` ≦ `overcapture_max_yen` | `F` を確定 | なし |
| 4 | `F` > `A` | それ以外 | `A` を確定 | `F − A` を追加の請求（5.3 節） |

- オーバーキャプチャーを使えるかは、与信の応答で PSP が示した値だけで決める。カードのブランドから推測しない。

### 5.3 追加の請求

- 登録済みのカードに、乗客が場にいない請求（MIT）として送る。冪等キーは `trip:{trip_id}:additional_charge:{seq}`。
- 追加の請求の前に、乗客に額と理由をアプリと通知で示す（L8 の確認を経る）。
- 失敗したら、24 時間後と 72 時間後に再び送る。3 回とも失敗したら、乗客の未払い（`rider_receivable`）として残し、次の依頼の前にカードの更新と支払いを求める。
- **事業者には、追加の請求の成否に関わらず、確定した運賃の全額を精算する**（[ADR-0025](../decisions/0025-ledger-settlement-and-reconciliation.md)）。回収できなかった分は、この基盤の損失にする。事業者との契約でこの負担を決める（持ち越し）。

### 5.4 キャンセル料

- Trips の `cancelled_by_rider` と `no_show` の事象に、DT-TRIP-002・003 の料金が載る（[trips-lifecycle.md](trips-lifecycle.md) の 7 節）。
- `app`：与信からキャンセル料だけを確定し、残りを解放する（DT-PAY-002 の行 2）。
- `in_vehicle`：登録済みのカードに MIT で請求する。
- 料金が 0 なら与信を取り消す。

## 6. 運賃の訂正と返金

```sql
fare_adjustments (id, trip_id, seq,
                  kind,            -- 'correction_down' | 'correction_up' | 'toll_add' | 'goodwill_refund' | 'cancel_fee_waive'
                  amount_yen,      -- 正の値。向きは kind で決まる
                  funded_by,       -- 'operator' | 'platform'
                  reason_code, note,
                  requested_by, approved_by, status, created_at, applied_at)
```

| 種類 | お金の向き | 承認 | 事業者の精算への影響 |
| --- | --- | --- | --- |
| `correction_down`（運賃の誤り） | 乗客へ返金 | 運用 1 人（1 万円以上は 2 人） | `funded_by = operator` なら事業者から差し引く |
| `correction_up`（入力の誤りで少なかった） | 追加の請求 | 運用 1 人と、事業者の確認 | 事業者に加える |
| `toll_add`（有料道路の実費） | 追加の請求 | ドライバーの入力と ETC の記録 | 事業者に加える |
| `goodwill_refund`（サービスの問題の補償） | 乗客へ返金 | 運用 1 人（上限は運用の設定） | 既定は `platform` の負担 |
| `cancel_fee_waive`（キャンセル料の免除） | 乗客へ返金 | 運用 1 人 | 事業者の受ける料金から差し引く |

- 返金は `refund` の操作で送る。冪等キーは `trip:{trip_id}:refund:{seq}`。返金の合計は、確定の額と追加の請求の合計を超えない（DB の検査）。
- 訂正は運賃の水準の報告（[pricing-and-fares.md](pricing-and-fares.md) の 6.3 節）にも反映する。
- 返金の後の事業者の精算の差し引きは、次の締めの明細に出す。

## 7. PSP の包み方と結果不明（[ADR-0023](../decisions/0023-psp-authorize-at-request-capture-at-end.md)）

```ts
interface PaymentProvider {
  authorize(req: { key: string; amountYen: Yen; customer: string; paymentMethod: string;
                   metadata: { tripId: string; operatorId: string } }): Promise<PspResult>;
  capture(req: { key: string; pspRef: string; amountYen: Yen }): Promise<PspResult>;
  cancel(req: { key: string; pspRef: string }): Promise<PspResult>;
  refund(req: { key: string; pspRef: string; amountYen: Yen }): Promise<PspResult>;
  chargeOffSession(req: { key: string; amountYen: Yen; customer: string; paymentMethod: string;
                          metadata: {...} }): Promise<PspResult>;
  lookup(req: { key: string } | { pspRef: string }): Promise<PspResult>;   // 結果不明の照会
}
type PspResult = { outcome: "succeeded" | "failed" | "unknown"; pspRef?: string;
                   authExpiresAt?: Instant; overcaptureMaxYen?: Yen; errorCode?: string };
```

- 送る前に `psp_operations` を `pending_send` で記録してコミットする。応答が切れたら `unknown` にし、照会のジョブが `lookup` で確定させる（10 秒後、1 分後、5 分後、以後 15 分ごと）。確定するまで、その支払いの次の操作は送らない。
- PSP からの通知（Webhook）は、受け取りの箱（inbox）に署名を確かめて保存し、`psp_ref` で操作に結び、状態を進める。Stripe の題材の [ADR-0014](../../../stripe/docs/decisions/0014-connector-inbox.md) と同じ形。
- PSP の SDK とヘッダーの名前は、この基盤の中では包みの中にだけ現れる。この基盤が外に出す識別子に、PSP やこの基盤の本家の名前を使わない（[リポジトリ共通の ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。
- PSP の選定は E8 の着手の前に行う（[intent.md](../intent.md)）。条件は、JPY の与信の期間、JCB を含む国内のカード、手動の確定と一部の確定、MIT、日本の加盟店の審査、精算のファイルの形、収納代行の形（10 節）を受けるか。

## 8. 台帳（[ADR-0025](../decisions/0025-ledger-settlement-and-reconciliation.md)）

### 8.1 口座

Stripe の題材の勘定体系（[ledger.md](../../../stripe/docs/architecture/ledger.md) の 2 節）に倣う。借方を正、貸方を負とする。

| 口座 | 区分 | 意味 |
| --- | --- | --- |
| `psp_receivable:{psp}` | 資産 | PSP からの未収金。売上の確定で増え、PSP の精算で減る |
| `bank_cash:{account}` | 資産 | 自社の銀行口座（精算の受け取り、事業者への払い出し） |
| `payouts_in_transit` | 資産 | 事業者への振込のうち、出金を確かめるまでのもの |
| `rider_receivable` | 資産 | 乗客の未払い（追加の請求の失敗） |
| `operator_payable:{operator_id}` | 負債 | 事業者への預り金。受け取った運賃で増え、手数料・返金・振込で減る。車内払いの手数料で借方に振れうる（事業者から受け取る側になる） |
| `fee_revenue` | 収益 | 事業者から受ける手数料、乗客から受ける手配料 |
| `consumption_tax_payable` | 負債 | 手数料にかかる消費税（扱いは税理士の確認待ち） |
| `promotion_expense` | 費用 | この基盤が負担するクーポン・補償 |
| `processing_cost:{psp}` | 費用 | PSP の手数料 |
| `bad_debt_expense` | 費用 | 回収できなかった乗客の未払い |
| `suspense:{source}` | 仮勘定 | 照合で説明のつかないお金 |

### 8.2 主な仕訳（収納代行の形）

運賃 3,000 円、手数料 10%（300 円、うち消費税 27 円とする例。税込 300 × 10/110 ＝ 27.27 の 1 円未満を切り捨てた。端数の処理の単位は税理士の確認事項）、クーポン 500 円（この基盤の負担）。

| 事象 | 仕訳 |
| --- | --- |
| 売上の確定（乗客は 2,500 円を払う） | `psp_receivable` +2,500 / `promotion_expense` +500 / `operator_payable` −3,000 |
| 手数料の計上（確定と同じトランザクション） | `operator_payable` +300 / `fee_revenue` −273 / `consumption_tax_payable` −27 |
| 追加の請求の失敗（不足 400 円） | 確定の仕訳で `rider_receivable` +400 を加え、`operator_payable` は全額で貸方にする |
| 未払いの回収 | `psp_receivable` +400 / `rider_receivable` −400 |
| 未払いの償却 | `bad_debt_expense` +400 / `rider_receivable` −400 |
| 返金（事業者の負担、1,000 円） | `operator_payable` +1,000 / `psp_receivable` −1,000 |
| 返金（この基盤の負担） | `promotion_expense` +X / `psp_receivable` −X |
| キャンセル料（500 円、事業者の受ける料金） | `psp_receivable` +500 / `operator_payable` −500 |
| 車内払いの乗車の手数料 | `operator_payable` +300 / `fee_revenue` −273 / `consumption_tax_payable` −27 |
| PSP の精算の着金 | `bank_cash:settlement` +N / `processing_cost` +C / `psp_receivable` −(N + C) |
| 事業者への振込の作成 | `operator_payable` +P / `payouts_in_transit` −P |
| 振込の出金の確認 | `payouts_in_transit` +P / `bank_cash:payout` −P |

- 返金は、残高が足りなくても `operator_payable` を借方に振ってよい（次の締めで相殺する）。
- 事業者を加盟店にする形（10 節の B）では、運賃は事業者の PSP の口座に入り、この基盤の台帳には手数料と、その回収だけが載る（`operator_fee_receivable:{operator_id}`）。

### 8.3 スキーマと制約

- 表の形は Stripe の題材の [ledger.md](../../../stripe/docs/architecture/ledger.md) の 3 節と同じ：`ledger_accounts`、`journal_entries`（`entry_type`、`source_type`・`source_id`、`idempotency_key`、`effective_at`、`reverses_entry_id`）、`ledger_postings`（`amount` は `bigint`、0 は禁止）、`ledger_entry_keys`（冪等）。
- 仕訳ごとに合計が 0 になることを、コミットの時の遅延制約のトリガーで確かめる。追記のみで、誤りは逆の仕訳で直す。
- 冪等キーは操作から決める（例：`capture:{trip_id}`、`fee:{trip_id}`、`refund:{trip_id}:{seq}`、`payout:{payout_id}:create`）。
- 事業者の預り金の口座は、S1 で事業者は数十社なので、書き込みの集中の分割（Stripe の題材の [ADR-0016](../../../stripe/docs/decisions/0016-hot-accounts-and-ledger-sharding.md)）は要らない。S2 で大手の事業者の口座を見て判断する。

## 9. 障害の後の支払いの結び直し

- リージョンの切り替えで `trip_payments` の行が失われたら、復元した乗車（[trips-lifecycle.md](trips-lifecycle.md) の 8.5 節）の `trip_id` で PSP に照会し、与信・確定を結び直す。PSP の操作には必ず `metadata.tripId` を付ける。
- 結び直しの後、照合（12 節）で PSP の精算と合うかを確かめる。

## 10. 代金の受け取りの形（[ADR-0024](../decisions/0024-fare-collection-model.md)）

| 形 | 中身 | 良い点 | 引き受けるもの |
| --- | --- | --- | --- |
| A：収納代行（`agent_collection`、既定） | この基盤が PSP の加盟店になり、事業者から代理受領権を受けて運賃を受け取る。乗客が払った時点で乗客の運賃の債務は消えることを、乗客の利用規約と事業者との契約に書く。預り金を締めごとに事業者へ払う | 事業者ごとに PSP の審査が要らない。乗客の明細が 1 つの名前になる | 預り金を持つ。L6 の結論によっては資金移動業の登録が要る |
| B：事業者を加盟店にする（`operator_merchant`） | 事業者が PSP の加盟店（連結アカウント）になり、この基盤は PSP のダイレクト支払いで事業者に代わって請求し、手数料を差し引く | 預り金を持たない | 事業者ごとに PSP の審査と口座の開設が要る。返金とチャージバックは事業者の残高から引かれる |
| C：資金移動業の登録 | A の流れのまま、この基盤が資金移動業者になる | 法的に明確 | 登録、履行保証金、体制の整備が重い |

- 既定は A。B は同じ設計（`collection_model` の列と、B の仕訳）で持ち、事業者ごとに選べるようにする。C は L6 の結論が「A は為替取引に当たる」で、B が事業に合わないときに検討する。
- A と B のどちらも、legal のフラグ（`legal.l6.agent_collection`・`legal.l6.operator_merchant`、事業者ごと）の裏に置き、L6 の結論が `legal_gate_records` に記録されるまで本番の決済を有効にしない（[ADR-0043](../decisions/0043-flag-taxonomy-legal-gates-and-safety-defaults.md)）。
- 乗客に渡す領収書の発行者（運送の主体は事業者）と、適格請求書の扱い（媒介者交付特例を使えるか）は、税理士と法務の確認待ち（L6 と合わせる）。

## 11. 事業者への精算

### 11.1 締めと支払い

- 既定は月 2 回：1〜15 日の分を 16 日に、16 日〜月末の分を翌月 1 日に締める。事業者との契約で週 1 回・月 1 回に変えられる。
- 締めの対象は、締めの時刻までに `effective_at` が入った仕訳。`awaiting_fare` の保留や `trip_conflicts` の確認中の乗車は、確定した締めに入る。
- 締めの翌営業日に明細を確定し、締めから 5 営業日目に振り込む。
- 振込の額 = 締めの時点の `operator_payable` の残高（貸方）。借方（事業者が払う側）なら振り込まず、次の締めに繰り越す。2 回続けて借方なら請求書を出す。
- 振込は銀行の API か全銀の形式のファイルで行い、出金の確認と組戻しの扱いは Stripe の題材の [ADR-0018](../../../stripe/docs/decisions/0018-payout-execution-via-banking-partner.md) と同じにする。

```sql
settlement_periods (id, operator_id, period_start, period_end, status,  -- 'open' | 'closed' | 'statement_final' | 'paid' | 'carried_over'
                    gross_fare_yen, fees_yen, refunds_yen, adjustments_yen, net_yen,
                    statement_s3_key, fee_invoice_s3_key, payout_id, closed_at)   -- 明細と請求書は S3（settlement-statements/）
operator_payouts (id, operator_id, settlement_period_id, amount_yen, bank_account_id,
                  status,  -- 'created' | 'submitted' | 'paid' | 'returned' | 'canceled'
                  bank_ref, idempotency_key UNIQUE, created_at, paid_at)
```

### 11.2 明細

- 事業者と営業所ごとに、乗車ごとの行：乗車の日時（発生の時刻）、営業所、車両、ドライバーの事業者の中の番号、運賃の種類、運賃、迎車料金、有料道路、キャンセル料、返金と訂正、手数料、消費税、差し引きの額。
- 事業者の日報（メーターの記録）と突き合わせられるよう、乗車の ID と、メーターの記録の番号（連携があるとき）を載せる。
- CSV と PDF を管理画面に出す（[supply-and-operators.md](supply-and-operators.md) の 7 節）。手数料の適格請求書（この基盤が売り手）も同じ締めで出す。

## 12. 照合

Stripe の題材の [ADR-0017](../../../stripe/docs/decisions/0017-three-way-reconciliation-with-suspense.md) の 3 者照合を使う。

| 照合 | 突き合わせるもの | 鍵 | 期限 |
| --- | --- | --- | --- |
| 精算の照合 | 台帳の `psp_receivable` の明細 × PSP の精算のファイル | `psp_ref` | T+2 営業日（NFR-006） |
| 着金の照合 | PSP の精算のバッチの純額 × 銀行の入金 | バッチの ID と額 | T+2 営業日 |
| 振込の照合 | `operator_payouts` × 銀行の出金と組戻し | 振込の ID | 振込の翌営業日 |
| 乗車の照合（事業者） | 精算の明細 × 事業者の日報 | 乗車の ID・メーターの記録の番号 | 事業者が明細を受けて 30 日以内に申し出る |

- お金が動いたのに相手が分からないときは、すぐに `suspense:{source}` に計上する。解消は振替の仕訳で行い、事業者の預り金を動かす解消は 2 人の承認を要する。
- 照合の仕訳は冪等（`recon:{source}:{external_id}`）。

## 13. 障害のときの振る舞い

| 障害 | 振る舞い |
| --- | --- |
| PSP が応答しない（与信） | 新しい `app` の依頼は `payment_pending` の 30 秒で失敗する。タクシーは `in_vehicle` を案内する。日本版ライドシェアは依頼を受けない |
| PSP が応答しない（確定） | 乗車は `completed` のまま。確定はキューで再試行する。与信の期限の 24 時間前に SEV2 |
| PSP の結果不明 | 7 節の照会。確定するまで次を送らない |
| Webhook が遅れる・届かない | 照会のジョブと、日次の精算の照合で見つける |
| 振込が組戻しになった | `returned` にし、事業者の口座の確認を求め、次の営業日に再び送る（口座を直した後） |
| 台帳の仕訳の検査に失敗 | トランザクション全体が失敗する。確定の結果は `psp_operations` に残り、再実行で仕訳を書く |

## 14. セキュリティ

- カードの情報は PSP の SDK だけが扱う。この基盤は PCI DSS の対象を最小にする（PSP のトークンだけを持つ）。範囲の判定は `security.md` で確かめる。
- 事業者の振込先の口座は KMS で暗号化して持つ。変更は事業者の管理者の操作と、この基盤の運用の 2 人の承認を要し、変更の後の最初の振込の前に、事業者の登録済みの連絡先へ知らせる（振込先の乗っ取りへの対策）。
- 返金・訂正・償却・仮勘定の解消は、権限・上限・承認・監査ログを必須にする（`support-and-operations-tools.md`）。
- PSP の Webhook は署名を確かめ、再送の攻撃を時刻と ID で弾く。
- 支払いのログに、カードの表示用の情報より多くを書かない。乗客の名前と正確な位置を書かない。

## 15. テスト

### 15.1 決定表

- DT-PAY-001（与信の額）、DT-PAY-002（売上の確定）、6 節の訂正の表（DT-PAY-003）を表駆動テストにする。

### 15.2 性質ベーステスト（fast-check）

- **PROP-PAY-001（二重の請求なし）**：任意の順序・重複・並行の、確定の要求・再試行・PSP のタイムアウト・Webhook の再送の列で、PSP に成功した売上の確定は乗車ごとに高々 1 回で、追加の請求は訂正の番号ごとに高々 1 回。
- **PROP-PAY-002（請求の額）**：乗客から受け取った額の合計（確定 + 追加 − 返金）は、確定した運賃と料金の合計から、クーポンと返金を引いた額に一致し、それを超えない。
- **PROP-PAY-003（台帳の釣り合い）**：任意の事象の列の後、すべての仕訳は合計 0 で、全口座の残高の合計は 0。
- **PROP-PAY-004（事業者の精算の一致）**：任意の乗車・訂正・返金・車内払いの列で、事業者ごとに「振込の合計 + 締めの後の預り金の残高」が「受け取った運賃と料金 − 手数料 − 事業者の負担の返金 − 車内払いの手数料」に一致する。
- **PROP-PAY-005（照合の冪等）**：同じ精算のファイルと明細を何度取り込んでも、照合の仕訳の数と額は 1 回目と同じ。
- **PROP-PAY-006（結果不明）**：任意の PSP の応答（成功・失敗・タイムアウト・遅れた Webhook）の列で、`unknown` の操作がある間、同じ支払いに次の操作が送られない。

### 15.3 結合・障害注入

- 模擬の PSP（成功、拒否、タイムアウトの後に成功、タイムアウトの後に失敗、オーバーキャプチャーの可否）で、DT-PAY-002 の各行を通す。
- 模擬の PSP の精算のファイルと模擬の銀行の明細で、一致・端数の差・台帳にない返金・届かない着金を照合する。
- PSP のテスト環境で、JCB の与信で `overcapture.status` が `unavailable` になり、不足が追加の請求に回ることを確かめる（文書では JCB は対象外。E8 の `psp-selection-poc` と `capture-at-trip-end`）。

## 16. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E8 | `psp-adapter` | 7 節の包み、`psp_operations`、結果不明の照会、Webhook の inbox（PROP-PAY-006） |
| E8 | `authorize-at-request` | DT-PAY-001、`payment_pending` との結合（E6 と一緒に） |
| E8 | `capture-at-trip-end` | DT-PAY-002、部分一意索引（PROP-PAY-001・002） |
| E8 | `additional-charges-and-receivables` | 5.3 節、未払いの扱い、次の依頼の前の支払い |
| E8 | `cancellation-fee-charging` | 5.4 節 |
| E8 | `ledger-core` | 8 節の口座と仕訳、釣り合いのトリガー（PROP-PAY-003） |
| E8 | `operator-settlement-and-statements` | 11 節、締め、明細、手数料の請求書（PROP-PAY-004） |
| E8 | `operator-payouts` | 振込の作成・出金の確認・組戻し |
| E8 | `three-way-reconciliation` | 12 節（PROP-PAY-005） |
| E8 | `collection-model-switch` | 10 節の A・B の切り替えと legal のフラグ（L6） |
| E11 | `fare-adjustment-ui` | 6 節の訂正と返金の画面、承認と上限（support の Story と同じ 1 つ） |
| E2 | `operator-bank-accounts` | 振込先の登録・変更・2 人の承認（14 節） |
| E12 | `rideshare-cashless-only` | 日本版ライドシェアで `in_vehicle` を拒否する |

## 17. 未解決の問い

### 決定（2026-09-27、既定案）

- **与信の時点**：依頼のとき（配車の前）。
- **与信の上乗せ**：1,000 円。メーターは目安の上の額の 1.3 倍。
- **不足の受け方**：PSP が示したときだけオーバーキャプチャー、それ以外は追加の請求。
- **回収の損失の負担**：事業者には全額を精算し、この基盤が負う（事業者との契約で確かめる）。
- **受け取りの形**：A（収納代行）を既定、B を代わりの道。L6 まで本番で有効にしない。
- **精算の周期**：月 2 回の締め、締めから 5 営業日目の振込。
- **日本版ライドシェアの決済**：アプリの決済だけ。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| 収納代行か資金移動業か（L6） | E8 の精算の Story の承認の前に法務が結論を出す |
| 乗客から手配料を受けることの法的な整理（L1） | E7・E8 の手数料の Story の前 |
| 領収書の発行者、適格請求書、手数料の消費税の計算 | 税理士と法務。E8 の明細の Story の前 |
| 回収の損失とチャージバックの負担の、事業者との契約 | 最初の提携先との契約の交渉で |
| PSP の選定（JCB の与信の期間、MIT、精算のファイル） | E8 の着手の前。候補の PSP のテスト環境で確かめる |
| 車載の決済の端末で払った乗車を、アプリの記録に結ぶか | S2。車載の端末の製造者との連携が要る |
| 帳簿の保存の期間 | 法務（Stripe の題材と同じく 10 年を想定） |

## 18. quality.md・runbooks・data-model への項目

### quality.md

- 二重の請求の件数（常に 0）。PSP の確定の成功が乗車ごとに 2 つある行を日次で探す。
- 与信の失敗の率（理由ごと）、追加の請求の率と失敗の率、未払いの残高。
- 確定の遅れ（`completed` から確定の成功まで）の p95。
- 照合のブレイクの件数と、T+2 営業日を過ぎたものの件数（NFR-006）、仮勘定の残高。
- 事業者からの明細の申し出の件数と、解決までの時間。

### runbooks

- `psp-outage.md`：PSP の障害のときの依頼の扱い（`in_vehicle` への案内、日本版ライドシェアの受付の停止）と、復旧の後の確定の再開。
- `psp-unknown-outcomes.md`：結果不明の操作が溜まったときの照会と、手での確定。
- `capture-before-auth-expiry.md`：与信の期限が近い未確定の支払いの対応。
- `settlement-close.md`：締めの手順、明細の確定、振込の送信、組戻しの対応。
- `reconciliation-breaks.md`：ブレイクと仮勘定の調べ方（Stripe の題材の手順を引き継ぐ）。
- `payout-account-change-review.md`：振込先の変更の確認の手順。

### data-model（索引への追加の提案）

| 置き場所 | 中身 |
| --- | --- |
| Aurora `rider_payment_methods`（`rider_id`、`psp`、`psp_customer_ref`、`payment_method_ref`、`brand`、`last4`、`exp_month`・`exp_year`、`is_default`、`status`） | 4 節 |
| Aurora `trip_payments`、`psp_operations` | 5.1 節 |
| Aurora `psp_webhook_inbox`（`psp`、`event_id` UNIQUE、`received_at`、`payload`、`processed_at`） | 7 節 |
| Aurora `fare_adjustments` | 6 節 |
| Aurora `rider_receivables`（`rider_id`、`trip_id`、`amount_yen`、`status`、`attempts`） | 5.3 節 |
| Aurora `ledger_accounts`、`journal_entries`、`ledger_postings`、`ledger_entry_keys` | 8 節（Stripe の題材と同じ形。月ごとのパーティション） |
| Aurora `settlement_periods`、`operator_payouts` | 11 節 |
| Aurora `recon_imports`、`recon_breaks` | 12 節（Stripe の題材と同じ形） |
| S3 `settlement-statements/`（CSV・PDF、事業者ごと） | 11.2 節 |

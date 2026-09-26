# Payments: Stripe

PaymentIntent・SetupIntent の状態遷移、確定（confirm）、3D セキュア、オーソリ・キャプチャ・取り消し、返金、コネクタの結果が分からないときの回復。決済手段とコネクタの中身は [payment-methods.md](payment-methods.md)、チャージバックは [disputes.md](disputes.md)、仕訳の口座は [ledger.md](ledger.md) にある。

決定：PaymentIntent を唯一の決済オブジェクトにする（[ADR-0010](../decisions/0010-payment-intent-state-machine.md)）。コネクタの結果不明の回復と振り分け（[ADR-0011](../decisions/0011-connector-abstraction-and-unknown-outcome.md)）。3D セキュア（[ADR-0012](../decisions/0012-3ds-via-connector.md)）。日本の非同期の決済手段（[ADR-0013](../decisions/0013-japan-async-payment-methods.md)）。コネクタからの通知の取り込み（[ADR-0014](../decisions/0014-connector-inbox.md)）。

## 1. 方針

- **本家の API の形と状態の名前をそのまま使う。** 状態は `requires_payment_method`、`requires_confirmation`、`requires_action`、`processing`、`requires_capture`、`succeeded`、`canceled` の 7 つ（[PaymentIntent object](https://docs.stripe.com/api/payment_intents/object)、[ライフサイクル](https://docs.stripe.com/payments/paymentintents/lifecycle)。2026-09-26 に確認）。加盟店が本家の SDK と文書で組み込めることを優先する。
- **1 つの PaymentIntent で、成功するオーソリは高々 1 回。** 試行（Charge）は何度でも作れるが、「送信中・結果不明・オーソリ済み」の試行は同時に 1 つまでにする。DB の部分一意制約で守る（6 節）。
- **結果が分からないうちは、次の試行をしない。** コネクタがタイムアウトしたら、照会と取り消しで結果を確定させてから、失敗として返す（7 節）。
- **お金が動く遷移は、仕訳と同じトランザクションで書く**（[ADR-0003](../decisions/0003-double-entry-ledger.md)）。オーソリはお金を動かさないので仕訳を書かない。キャプチャ・返金・Dispute で書く（9 節）。
- **状態の遷移は、下の表にあるものだけを許す。** 表にない遷移は、コードの 1 か所（遷移関数）で拒否する。

## 2. オブジェクト

| オブジェクト | ID | 役割 |
| --- | --- | --- |
| PaymentIntent | `pi_` | 1 回の支払いの意図。金額・通貨・状態・キャプチャの方式を持つ。加盟店が作り、確定し、キャプチャ・取り消しする |
| Charge | `ch_` | 確定 1 回ごとの試行。コネクタへの要求と結果、オーソリの期限、3D セキュアの結果、キャプチャ済みの額を持つ。API では読み取り専用（`latest_charge`） |
| Refund | `re_` | 返金。Charge に属する。1 つの支払いに複数作れる |
| SetupIntent | `seti_` | 課金せずに決済手段を保存する意図。3D セキュアで認証し、将来の加盟店起点の決済（MIT）に使えるようにする |
| SetupAttempt | `setatt_` | SetupIntent の確定 1 回ごとの試行 |
| PaymentMethod | `pm_` | 決済手段。カードはトークンと表示用の情報だけを持つ（[payment-methods.md](payment-methods.md)） |

- 本家の Charges API で直接課金する経路（`POST /v1/charges`）は作らない。Charge は PaymentIntent の中の試行としてだけ存在する（[ADR-0010](../decisions/0010-payment-intent-state-machine.md)）。
- テーブル：`payment_intents`、`charges`、`refunds`、`setup_intents`、`setup_attempts`、`connector_requests`（コネクタへの要求の記録。7 節）。すべて `account_id` と RLS を持つ（[ADR-0002](../decisions/0002-account-tenancy.md)）。索引は [data-model.md](data-model.md) に反映する。

## 3. PaymentIntent の状態遷移

```
                ┌──────────────── 決済手段なしで作成 ────────────────┐
                ▼                                                    │
  requires_payment_method ──PM を付ける──▶ requires_confirmation      │
         ▲   │                                   │                   │
         │   └───────────── confirm ─────────────┤                   │
         │                                       ▼                   │
         │  失敗・拒否・3DS 失敗 ◀──────── (試行を作ってコネクタへ)      │
         │  コンビニの期限切れ                    │                   │
         │                  ┌────────────┬───────┼────────────┐      │
         │                  ▼            ▼       ▼            ▼      │
         └────────── requires_action  processing  requires_capture   │
                     (3DS・支払い待ち) (結果待ち)   │ capture         │
                            │            │         ▼                 │
                            └────────────┴──▶ succeeded              │
                                                                     │
  succeeded と processing（カード）以外から ──cancel──▶ canceled ◀──────┘
```

### 3.1 遷移の表

「仕訳」の列は 9 節の仕訳の種類を指す。

| 今の状態 | きっかけ | 条件 | 次の状態 | 仕訳 |
| --- | --- | --- | --- | --- |
| （なし） | 作成 | `payment_method` なし | `requires_payment_method` | なし |
| （なし） | 作成 | `payment_method` あり、`confirm` なし | `requires_confirmation` | なし |
| （なし）・`requires_payment_method`・`requires_confirmation` | confirm | 決済手段と金額の検証に通り、不正検知が拒否しない | 試行（Charge）を作り、4 節の流れへ | なし |
| 同上 | confirm | 不正検知のルールが拒否 | `requires_payment_method`（`last_payment_error.decline_code = fraudulent` だが、顧客には `generic_decline` を見せる） | なし |
| 試行中 | 3DS が必要（チャレンジ） | カード | `requires_action`（`next_action.type = use_stripe_sdk` か `redirect_to_url`） | なし |
| 試行中 | コンビニ・銀行振込の確定 | 支払い番号・振込先の発行に成功 | `requires_action`（`konbini_display_details` / `display_bank_transfer_instructions`） | なし |
| `requires_action`（3DS） | 3DS 成功・frictionless | | オーソリへ進む（試行中） | なし |
| `requires_action`（3DS） | 3DS 失敗・放棄 | | `requires_payment_method` | なし |
| 試行中 | オーソリ承認 | `capture_method = manual` | `requires_capture` | なし |
| 試行中 | オーソリ承認 | `capture_method = automatic` | キャプチャを続けて行い `succeeded` | キャプチャ |
| 試行中 | オーソリ承認 | `capture_method = automatic_async` | `succeeded`（キャプチャは非同期。5.2 節） | キャプチャの完了時に書く |
| 試行中 | オーソリ拒否 | | `requires_payment_method`（`last_payment_error` に拒否コード） | なし |
| 試行中 | コネクタの結果不明 | タイムアウト・送信後の 5xx | `processing` | なし |
| `processing` | 照会で承認と判明 | | 承認と同じ遷移 | 同上 |
| `processing` | 照会で未処理と判明し、取り消しが確定 | | `requires_payment_method`（`processing_error`） | なし |
| `requires_action`（コンビニ） | 入金の速報 | | `succeeded` | 非同期の入金 |
| `requires_action`（コンビニ） | 期限切れ（期限＋猶予） | | `requires_payment_method` | なし |
| `requires_action`（銀行振込） | 入金を充当し、残りが 0 | | `succeeded` | 現金残高の充当 |
| `requires_action`（銀行振込） | 入金を充当し、残りが正 | | `requires_action` のまま（`amount_remaining` を減らす） | 現金残高の充当（一部） |
| `requires_capture` | capture | `amount_to_capture` ≦ `amount_capturable`、期限内 | `succeeded`（残りは解放） | キャプチャ |
| `requires_capture` | オーソリの期限切れ | `capture_before` を過ぎた | `canceled`（残りを解放） | なし |
| `requires_payment_method`・`requires_confirmation`・`requires_action`・`requires_capture` | cancel | コンビニで支払い中でない | `canceled` | なし（`requires_capture` はコネクタに取り消しを送る） |
| `succeeded`・`canceled` | 何でも | | 変わらない（終端） | — |

- `processing` のカードの PaymentIntent は取り消せない。本家も、`processing` の取り消しは一部の口座振替に限る（[Cancel a PaymentIntent](https://docs.stripe.com/api/payment_intents/cancel)）。
- 取り消しの理由は本家と同じ値を持つ。加盟店が指定できるのは `duplicate`・`fraudulent`・`requested_by_customer`・`abandoned`、システムが付けるのは `automatic`・`expired` など（[PaymentIntent object](https://docs.stripe.com/api/payment_intents/object)）。オーソリの期限切れで付く値が `automatic` であることは未検証。本家のテスト環境でオーソリを失効させて確かめる。
- `confirmation_method = manual`（`next_action` の後にサーバーで再び確定させる方式）は、S2 で足す。MVP は `automatic` だけ。

### 3.2 不変条件

`quality.md` の性質に載せる候補。

- 1 つの PaymentIntent で、`status` が `authorized`・`captured` の Charge は高々 1 つ。
- 1 つの PaymentIntent で、送信中（`pending_send`・`sent`・`unknown`）の Charge は高々 1 つ。
- `amount_received` ≦ `amount`。返金の合計 ≦ キャプチャ済みの額。
- `succeeded`・`canceled` から他の状態へ移らない。
- `succeeded` のカードの PaymentIntent には、キャプチャの仕訳がちょうど 1 つある（`automatic_async` は、キャプチャの完了後）。

### 3.3 更新できる項目

- `amount`・`currency`・`payment_method`・`capture_method` を変えられるのは、`requires_payment_method`・`requires_confirmation`・`requires_action` のときだけ。
- `requires_action` で金額や決済手段を変えると、進行中の試行（3DS・コンビニの支払い番号）を無効にし、`requires_payment_method` か `requires_confirmation` に戻す。コンビニでは、発行済みの支払い番号を取り消す（本家も更新で暗黙に取り消す。[コンビニ決済](https://docs.stripe.com/payments/konbini/accept-a-payment?payment-ui=direct-api)）。
- `metadata`・`description` はいつでも変えられる。

## 4. 確定（confirm）の流れ

`POST /v1/payment_intents/{id}/confirm`、または作成時の `confirm=true`。公開キーと `client_secret` によるブラウザーからの確定も受ける（Elements・Checkout）。

1. **冪等と排他**：`Idempotency-Key` を確かめる（[ADR-0004](../decisions/0004-idempotency.md)）。PaymentIntent の行を `SELECT ... FOR UPDATE` で取り、状態が confirm を受け付けるかを表で確かめる。受け付けなければ 400（`payment_intent_unexpected_state`）。
2. **検証**：金額と通貨（10 節）、決済手段の種類が `payment_method_types` に含まれるか、PaymentMethod が同じ加盟店・同じ Customer のものか。
3. **不正検知**：[fraud.md](fraud.md) のルールで、許可・拒否・3DS を要求のいずれかを決める。
4. **試行を作る**：Charge を `pending_send` で INSERT し、コネクタの参照番号を割り当てる。ここでコミットする（送信の前に記録を残す。7 節）。
5. **振り分け**：どのコネクタに送るかを決める（8 節）。
6. **3D セキュア**（カード）：6 節。チャレンジが要れば `requires_action` を返して終わる。認証の完了後にオーソリへ進む。
7. **オーソリ**：Connector Gateway（CDE）へ、PaymentMethod のトークンと参照番号で要求する。
8. **結果の反映**：結果に応じて 3.1 節の表で遷移し、仕訳を書き、outbox に Event を積む（[events-and-webhooks.md](events-and-webhooks.md)）。すべて 1 トランザクション。

- API の応答は、手順 8 の結果の PaymentIntent。コネクタの応答を待つ上限は `connector.authorize_timeout`（既定 20 秒。[capacity.md](capacity.md) のパラメーター）。超えたら `processing` を返し、結果は Webhook で知らせる。
- 非同期の決済手段（コンビニ・銀行振込）は、手順 6・7 の代わりに支払い番号・振込先を発行し、`requires_action` を返す（[payment-methods.md](payment-methods.md)）。

## 5. キャプチャ

### 5.1 方式

| `capture_method` | 振る舞い | 本家 |
| --- | --- | --- |
| `automatic` | オーソリの承認に続けて同じ要求の中でキャプチャし、`succeeded` を返す | [PaymentIntent object](https://docs.stripe.com/api/payment_intents/object) |
| `automatic_async` | オーソリの承認で `succeeded` を返し、キャプチャは後ろで行う。応答の時点では `balance_transaction` が `null` でよい | 最新の版の既定（[非同期キャプチャー](https://docs.stripe.com/payments/payment-intents/asynchronous-capture)） |
| `manual` | オーソリだけ行い `requires_capture` で止める。加盟店が後で capture する | [支払い方法を保留する](https://docs.stripe.com/payments/place-a-hold-on-a-payment-method) |

- 既定値は API の版で決める（[api.md](api.md)）。最初の版では、本家の最新と同じ `automatic_async` にする。
- コネクタが「オーソリとキャプチャを 1 回で行う」要求（即時売上）を持つなら、`automatic` はそれを使う。持たなければ、オーソリの直後にキャプチャを送る。どちらかはコネクタの能力で決まる（[payment-methods.md](payment-methods.md)）。
- `automatic_async` のキャプチャは、キュー（SQS）のワーカーが内部の冪等キー `capture:{charge_id}` で送る。失敗したら再試行し、オーソリの期限の 24 時間前になっても成功しなければ SEV2 とする。`succeeded` を返した後なので、失敗を加盟店に返す道がない。
- コンビニ・銀行振込は手動キャプチャに対応しない（本家と同じ）。

### 5.2 オーソリの有効期限

- Charge に `capture_before` を持つ。値は「カードブランド × 取引の種類（CIT・MIT）× 通貨」の表と、コネクタの能力の小さい方で決める。
- 表の初期値は本家に合わせる（[支払い方法を保留する](https://docs.stripe.com/payments/place-a-hold-on-a-payment-method)、2026-09-26 に確認）。

| ブランド | CIT | MIT |
| --- | --- | --- |
| Visa | 7 日 | 5 日（正確には 4 日 18 時間） |
| Mastercard・American Express・Discover | 7 日 | 7 日 |
| 日本の加盟店の JPY 取引（Visa・Mastercard・JCB・Diners Club・Discover） | 最長 30 日 | 最長 30 日 |

- 日本の 30 日は、接続するアクワイアラがそれを許すかに依存する（未検証。最初のコネクタとの契約で確かめる）。許さなければ、コネクタの能力の値を使う。
- `capture_before` を過ぎた `requires_capture` は、定期ジョブが `canceled` にし、コネクタに取り消しを送る。本家もオーソリの失効で `canceled` にする。
- 本家の `automatic_delayed`（期限前の自動キャプチャ、プレビュー）は作らない。

### 5.3 一部のキャプチャ

- `amount_to_capture` で、オーソリ額より少なくキャプチャできる。残りは解放する（コネクタに一部取り消しを送るか、キャプチャの額で自然に解放されるかは、コネクタの能力による）。
- キャプチャは 1 回だけ。一部をキャプチャした後、残りを再びキャプチャすることはできない（本家と同じ）。複数回のキャプチャ（multicapture）とオーソリ額を超えるキャプチャ（overcapture）は作らない。
- capture の要求も冪等にする。`requires_capture` 以外の PaymentIntent への capture は 400。

## 6. 3D セキュア

方式は [ADR-0012](../decisions/0012-3ds-via-connector.md)。EMV 3-D セキュア（3DS2）の 3DS Server は、コネクタ（決済代行）が提供するものを使い、自前で EMVCo の認定を取らない。

### 6.1 いつ要求するか

| 条件 | 3DS |
| --- | --- |
| 日本で発行されたカードの、顧客がその場にいる取引（CIT） | 要求する。日本のクレジットカード・セキュリティガイドラインが EC 加盟店に EMV 3-D セキュアの導入を求めているため。本家も、同ガイドラインが求める場合に自動で 3DS を起動する（[3D セキュアを使用して認証する](https://docs.stripe.com/payments/3d-secure/authentication-flow)） |
| 加盟店が `payment_method_options.card.request_three_d_secure = any / challenge` を指定 | 要求する（`challenge` はチャレンジを希望として伝える。最終的な流れはカード発行会社が決める） |
| 不正検知のルールが要求 | 要求する（[fraud.md](fraud.md)） |
| カード発行会社が再試行可能な拒否（`authentication_required`）を返した | 要求して、同じ試行の中で再びオーソリする |
| 加盟店起点の取引（MIT、`off_session = true`）で、事前に SetupIntent か `setup_future_usage` で認証済み | 要求しない。免除としてオーソリする |
| MIT で、発行会社が認証を要求した | `requires_payment_method`（`authentication_required`）で返す。加盟店は顧客を呼び戻して on-session で確定し直す |

- ガイドラインの版と、3DS を求める範囲の条文は未検証。法務の確認と合わせて、日本クレジット協会の公表資料で確かめる。
- 加盟店が API で 3DS を無効にすることはできない（本家と同じ）。

### 6.2 流れ

1. Connector Gateway が、コネクタの 3DS Server に認証の開始を要求する（カード番号を使うので CDE の中で行う）。
2. 応答が frictionless（チャレンジ不要）なら、そのままオーソリへ進む。
3. チャレンジが要るなら、`requires_action` にし、`next_action` を返す。
   - `use_stripe_sdk`：Elements・Checkout が iframe（モーダル）でチャレンジを表示する。ブラウザーの情報の収集（3DS Method）も Elements が行う。
   - `redirect_to_url`：加盟店が `return_url` を渡したとき。顧客をカード発行会社の画面へ移し、`return_url` に `payment_intent` と `payment_intent_client_secret` を付けて戻す。
4. 認証の結果は、コネクタからの通知（[ADR-0014](../decisions/0014-connector-inbox.md)）か、ブラウザーの戻りを合図にした照会で受け取る。どちらが先でも、同じ試行に 1 回だけ反映する。
5. 結果が認証成功（または `attempt_acknowledged` のように、ネットワークの規則上オーソリを続けてよい結果）ならオーソリへ進む。失敗なら `requires_payment_method` にする。
6. Charge の `payment_method_details.card.three_d_secure` に、結果・認証の流れ（frictionless / challenge）・ECI・バージョンを記録する。Dispute の証拠に自動で使う（[disputes.md](disputes.md)）。

- チャレンジの放棄：`requires_action` のまま一定時間（`three_ds.abandon_after`、既定 1 時間）たったら、試行を失敗にし `requires_payment_method` に戻す。PaymentIntent 自体は取り消さない。
- 3DS の成功はライアビリティシフトを保証しない（本家も明言している）。画面・文書で「保証」と書かない。

## 7. 結果不明（unknown outcome）の回復

最大の難所（[architecture/README.md](README.md) の 6 節）。方式は [ADR-0011](../decisions/0011-connector-abstraction-and-unknown-outcome.md)。

### 7.1 何が起きるか

オーソリの要求を送った後に、タイムアウト・接続の切断・コネクタの 5xx が起きると、アクワイアラ側でオーソリが通ったかが分からない。ここで「失敗」と返して顧客が別のカードで払い直すと、先のオーソリが実は通っていた場合に二重に請求する。「成功」と見なせば、お金を受け取っていない注文を発送させる。

### 7.2 試行（Charge）の内部状態

| 内部状態 | 意味 |
| --- | --- |
| `pending_send` | 参照番号を割り当て、DB に記録した。まだ送っていない |
| `sent` | 送信を始めた（応答待ち） |
| `authorized` / `declined` | 結果が確定した |
| `failed_before_send` | 送信していないことが確実（接続の確立前の失敗、サーキットブレーカーが開いている） |
| `unknown` | 送った可能性があり、結果が分からない |
| `reversed` | 取り消しを送り、アクワイアラが受理した |
| `captured` / `partially_refunded` / `refunded` | キャプチャ後 |

- 参照番号は Charge の ID から決まる値で、コネクタごとに一意。再送・照会・取り消しは、すべて同じ参照番号で行う（[ADR-0004](../decisions/0004-idempotency.md) のコネクタの層）。
- `connector_requests` に、要求の種類・参照番号・送信の時刻・応答（生のコードを含む）を追記する。カード番号は含めない（CDE の中で組み立て、本体には結果だけを返す）。

### 7.3 判定の規則

| 起きたこと | 判定 | 次の手 |
| --- | --- | --- |
| DNS・TCP・TLS の確立前に失敗、サーキットブレーカーが開いている | `failed_before_send` | 別のコネクタへ振り分けてよい（8 節） |
| 応答があり、承認 | `authorized` | 3.1 節の遷移 |
| 応答があり、拒否（カード発行会社・アクワイアラの明確な拒否） | `declined` | `requires_payment_method` |
| 送信後のタイムアウト、切断、5xx、応答の解釈に失敗 | `unknown` | PaymentIntent を `processing` にし、回復のジョブに渡す |

### 7.4 回復のジョブ

1. **照会**：参照番号でコネクタに取引の状態を問い合わせる。間隔は 5 秒・30 秒・2 分・10 分・1 時間（`unknown_outcome.inquiry_schedule`）。
2. **見つかった**：その結果（承認・拒否）を反映する。承認なら、`capture_method` に従って通常どおり進む。
3. **見つからない**：コネクタの「処理済みなら必ず照会で見える」時間（能力の `inquiry_consistency_window`）を過ぎてから、同じ参照番号で取り消し（リバーサル）を送る。取り消しが受理されたら `reversed` にし、PaymentIntent を `requires_payment_method`（`decline_code = processing_error`）に戻す。
4. **照会も取り消しもできない**（コネクタの障害）：`processing` のまま待つ。顧客にも加盟店にも失敗と言わない。24 時間を超えたら SEV2 とし、runbook の `unknown-outcome-backlog.md`（E3 で作る。[runbooks/README.md](../runbooks/README.md)）の手順で、コネクタの窓口に参照番号で確認する。
5. **最後の網**：コネクタの精算ファイルとの照合（[payouts-and-reconciliation.md](payouts-and-reconciliation.md)）で、こちらに成功の記録がない売上が見つかったら、自動で取り消し・返金し、SEV2 とする。

- `processing` の PaymentIntent への confirm・cancel は 400 で拒否する。加盟店は Webhook（`payment_intent.succeeded` / `payment_intent.payment_failed`）を待つ。
- ブラウザーの Checkout・Elements は、`processing` のあいだ「処理中」を表示し、ポーリングする。
- 回復のジョブは、照会の結果の反映も冪等にする（同じ結果が 2 回来ても 1 回だけ遷移する）。

### 7.5 キャプチャ・取り消し・返金の結果不明

オーソリ以外の要求も同じ規則で扱うが、お金の向きが違うので扱いを変える。

| 要求 | 結果不明のときの扱い |
| --- | --- |
| キャプチャ | 同じ参照番号で再送する（アクワイアラ側で重複を拒否させる）。照会で確定するまで仕訳を書かない。`automatic` の同期の応答では `processing` を返す |
| オーソリの取り消し | 再送してよい（取り消しは何度送っても結果が同じ） |
| 返金 | 返金は `pending` のまま照会で確定させる。二重返金を防ぐため、確定前に別の参照番号で送り直さない |

## 8. 再試行とコネクタの振り分け

### 8.1 二重オーソリを防ぐ規則

1. 1 つの PaymentIntent で、送信中・結果不明の試行があるあいだは、新しい試行を作らない（3.2 節の不変条件）。
2. 別のコネクタへ振り分けてよいのは、前の試行が `failed_before_send` のとき、または回復のジョブで `reversed` になったときだけ。
3. キャプチャ・取り消し・返金は、オーソリしたコネクタにだけ送る。そのコネクタが止まっていれば、キューに溜めて回復を待つ。
4. カード発行会社の拒否（`declined`）を、自動で別のコネクタに送り直さない。加盟店・顧客が新しく confirm する。

### 8.2 振り分け

- 加盟店ごとに、使えるコネクタの一覧と優先順を持つ（最初は 1 社。2 社目は S2 の候補）。
- カードのブランド・通貨・能力（手動キャプチャ、30 日のオーソリ）で候補を絞り、優先順の先頭に送る。
- コネクタ × 操作ごとにサーキットブレーカーを持つ。直近 1 分で、送信前の失敗と結果不明の率が閾値（`connector.breaker_error_rate`、既定 20%）を超えたら開く。開いている間の新しいオーソリは `failed_before_send` として次の候補へ送る。30 秒ごとに少量だけ通して閉じるかを試す。
- 候補がすべて使えなければ、PaymentIntent を `requires_payment_method`（`processing_error`）で返す。顧客には「時間をおいて再試行」を見せる。
- 障害時の手順は runbook の `connector-outage.md`（E3 で Ops が作る。[runbooks/README.md](../runbooks/README.md)）に書く。

## 9. 仕訳

口座の名前と構成の正本は [ledger.md](ledger.md) の 2 節（[ADR-0015](../decisions/0015-chart-of-accounts-and-balance-transactions.md)）。ここでは、どの遷移でどの向きにお金を動かすかを示す。決済の手数料は、確定の仕訳の中で差し引き、別の仕訳にしない（ADR-0015）。金額はすべて PaymentIntent の通貨で、各仕訳の借方と貸方の合計は一致する。

| 仕訳の種類 | いつ | 借方 | 貸方 |
| --- | --- | --- | --- |
| （なし） | オーソリ、3DS、取り消し、オーソリの失効 | — | — |
| キャプチャ（決済手数料を含む 1 つの仕訳） | キャプチャが確定した | コネクタへの未収金（キャプチャ額） | 加盟店の保留中の残高（純額）、手数料収益（手数料） |
| 返金の作成（カード） | 利用可能な残高を確かめ、コネクタへ送る時点（10.2 節） | 加盟店の利用可能な残高（返金額） | コネクタへの未収金（返金額） |
| 返金の作成（コンビニ・銀行振込で口座へ振り込む） | 同上 | 加盟店の利用可能な残高 | 顧客への返金の未払い（`refunds_payable`） |
| 返金の振込の完了 | 返金用の銀行が振込を完了した | `refunds_payable` | 返金用の預金（`bank_cash:refund`） |
| 返金の作成（銀行振込で現金残高へ戻す） | 同上 | 加盟店の利用可能な残高 | 顧客の現金残高（負債） |
| 返金の失敗・取り消し | 仕訳を書いた後の `failed` / `canceled` | 作成の仕訳の貸方の口座 | 加盟店の利用可能な残高（戻す） |
| 非同期の入金（手数料を含む） | コンビニの入金の速報 | 収納代行への未収金（`connector_receivable`） | 加盟店の保留中の残高（純額）、手数料収益 |
| 現金残高の受け入れ | 銀行振込の着金を明細で確かめた | 振込専用口座の預金（`bank_cash`） | 顧客の現金残高（負債） |
| 現金残高の充当（手数料を含む） | 顧客の現金残高を PaymentIntent に充てた | 顧客の現金残高 | 加盟店の保留中の残高（純額）、手数料収益 |

- 返金の成功（コネクタの受理）では仕訳を書かない。未収金は作成の時点で減らしてあり、精算ファイルとの照合で確かめる（[payouts-and-reconciliation.md](payouts-and-reconciliation.md)）。残高の不足で保留している返金（10.2 節）は、送る時点まで仕訳を書かない。
- 決済手数料は、返金しても戻さない（本家も元の取引の処理手数料を返さない。[支払いの返金とキャンセル](https://docs.stripe.com/refunds)）。手数料の料率と丸めは [ledger.md](ledger.md)。
- 保留中の残高が利用可能になる時期（入金サイクル）は [payouts-and-reconciliation.md](payouts-and-reconciliation.md)。
- Dispute の仕訳は [disputes.md](disputes.md)。

## 10. 返金

### 10.1 規則

- `POST /v1/refunds`（`payment_intent` か `charge`、省略時は全額、`amount` で一部、`reason`）。1 つの支払いに複数の返金を作れる。合計はキャプチャ済みの額を超えない（本家と同じ。[支払いの返金とキャンセル](https://docs.stripe.com/refunds)）。
- 超えるかの検査は、Charge の行を `FOR UPDATE` で取って、返金の合計（`failed`・`canceled` を除く）と比べる。並行する 2 つの返金で超えない。
- `requires_capture` の PaymentIntent は返金できない。取り消す（本家と同じ）。
- 返金先は元の決済手段だけ。
- 進行中の Dispute（`needs_response`・`under_review`）がある支払いは返金できない。照会（`warning_*`）の段階は返金できる（[disputes.md](disputes.md)）。

### 10.2 状態

本家と同じ 5 つ：`pending`、`requires_action`、`succeeded`、`failed`、`canceled`。

| 今の状態 | きっかけ | 次の状態 |
| --- | --- | --- |
| （なし） | 作成（カード） | `pending` |
| （なし） | 作成（コンビニ・銀行振込で、顧客の口座情報がない） | `requires_action`（顧客に口座情報の入力を依頼） |
| `requires_action` | 顧客が口座情報を入力 | `pending` |
| `requires_action` | 45 日たっても入力がない | `failed` |
| `requires_action` | 加盟店が取り消した | `canceled` |
| `pending` | コネクタ・銀行が受理した | `succeeded` |
| `pending` | コネクタ・銀行が拒否した | `failed`（`failure_reason`） |
| `succeeded` | 銀行から組み戻し（口座の誤りなど） | `requires_action`（口座情報を再び依頼）か `failed` |

- コンビニの返金の 45 日は本家の値（[コンビニ決済](https://docs.stripe.com/payments/konbini/accept-a-payment?payment-ui=direct-api)）。
- 失敗の理由は本家の値に寄せる：`declined`、`expired_or_canceled_card`、`insufficient_funds`、`lost_or_stolen_card`、`merchant_request`、`charge_for_pending_refund_disputed`、`unknown`。
- **残高が足りないときは本家に合わせる。** 本家は、返金を利用可能な残高（保留中を含まない）から引き、足りなければ「カードの返金は残高が足りるまで保留し、他の決済手段の返金は失敗にする」（[支払いの返金とキャンセル](https://docs.stripe.com/refunds)、2026-09-26 に確認）。
  - 作成の時点で、`merchant_available` の全スロットを `FOR UPDATE` で読んで確かめる（[ADR-0016](../decisions/0016-hot-accounts-and-ledger-sharding.md)）。足りれば、9 節の仕訳を書いてからコネクタへ送る。
  - カードで足りなければ、Refund を `pending` のまま保留する（内部の状態 `awaiting_balance`）。仕訳もコネクタへの送信もしない。利用可能への移動（[ledger.md](ledger.md) の 5.2 節）など残高が増えた後に、古い順に確かめ直す。保留が `refund.balance_hold_max`（既定 30 日。本家は日数を公開していないので本システムの値）を過ぎたら `failed`（`insufficient_funds`）にする。保留中は加盟店が取り消せる（`canceled`）。
  - コンビニ・銀行振込で足りなければ、すぐに `failed`（`insufficient_funds`）にする。
  - Dispute の引き落としは残高を確かめず、マイナスを許す（[disputes.md](disputes.md) の 5.1 節）。マイナスの回収は [ledger.md](ledger.md) の 4.5 節。

### 10.3 非同期

- 返金はコネクタへの要求をキュー（SQS）のワーカーで送る。API はすぐに `pending` の Refund を返す。
- 結果はコネクタの応答か通知（[ADR-0014](../decisions/0014-connector-inbox.md)）で確定する。Event は `refund.created`・`refund.updated`・`refund.failed`・`charge.refunded`。
- 返金の作成の直後（キャプチャ前、または同日の締め前）なら、コネクタが売上の取り消しとして処理することがある。取り消しか返金かは Charge の `destination_details` 相当に記録する。

## 11. SetupIntent

状態は PaymentIntent から `requires_capture` を除いた 6 つ（[SetupIntent object](https://docs.stripe.com/api/setup_intents/object)）。

| 今の状態 | きっかけ | 次の状態 |
| --- | --- | --- |
| （なし） | 作成 | `requires_payment_method` か `requires_confirmation` |
| `requires_payment_method`・`requires_confirmation` | confirm | カードの有効性の確認へ |
| 確認中 | 3DS のチャレンジが必要 | `requires_action` |
| 確認中・`requires_action` | 確認と 3DS に成功 | `succeeded`（PaymentMethod を Customer に付ける） |
| 確認中・`requires_action` | 失敗 | `requires_payment_method`（`last_setup_error`） |
| `succeeded` と `processing` 以外 | cancel | `canceled`（理由は `abandoned`・`requested_by_customer`・`duplicate`） |

- カードの有効性の確認は、コネクタの口座確認（0 円オーソリ、なければ少額のオーソリと即時の取り消し）で行う。どちらを使うかはコネクタの能力による。
- `usage` は `off_session`（既定）か `on_session`。`off_session` の成功時に、以後の MIT で使うネットワークの取引 ID をトークンと一緒に CDE に保存する。
- SetupIntent は仕訳を書かない（少額のオーソリは取り消すので、お金は動かない）。
- 日本の非同期の決済手段（コンビニ・銀行振込）は SetupIntent に対応しない（本家と同じ）。

## 12. 金額と通貨

- 金額は通貨ごとの最小単位の整数（[ADR-0001](../decisions/0001-platform-and-stack.md)）。JPY は小数なしの通貨で、500 円は `500`（[サポートされている通貨](https://docs.stripe.com/currencies)）。
- **MVP で受け付ける通貨は JPY だけ。** 精算も入金も JPY なので、両替が起きない。USD などの取引通貨と両替は S2 で足す（そのときに ledger.md の通貨の口座を広げる）。
- 最小額と最大額は本家に合わせる。

| 決済手段 | 最小 | 最大 |
| --- | --- | --- |
| カード（JPY） | 50 円 | 99,999,999 円（日本の JCB・Diners Club・Discover は 8 桁が上限。他ブランドもそろえる） |
| コンビニ | 120 円 | 300,000 円 |
| 銀行振込 | 50 円 | 99,999,999 円（未検証。本家の文書に銀行振込の上限の明記がない。コネクタの制限と合わせて確かめる） |

- 金額は JSON の数値で出し、`Number.MAX_SAFE_INTEGER` 以内であることを検証する（ADR-0001）。
- 手数料・一部返金・一部キャプチャの計算は `packages/money` だけで行う。

## 13. Event

状態の変化ごとに、本家と同じ名前の Event を outbox に積む（[events-and-webhooks.md](events-and-webhooks.md)）。

- PaymentIntent：`payment_intent.created`、`.requires_action`、`.processing`、`.amount_capturable_updated`、`.succeeded`、`.payment_failed`、`.canceled`、`.partially_funded`
- Charge：`charge.succeeded`、`.failed`、`.captured`、`.updated`、`.refunded`
- Refund：`refund.created`、`.updated`、`.failed`
- SetupIntent：`setup_intent.created`、`.requires_action`、`.succeeded`、`.setup_failed`、`.canceled`

## 14. S2・S3 で変わること

- S2：2 社目のカードのコネクタと、承認率・コストによる振り分け。`confirmation_method = manual`。JPY 以外の通貨と両替。ネットワークトークン（[payment-methods.md](payment-methods.md)）。
- S3：セル構成で、PaymentIntent とその Charge・Refund を同じセルに置く。結果不明の回復のジョブもセルごとに動かす。

## 15. 未検証の事項（持ち越し）

| 事項 | いつ・どう確かめるか |
| --- | --- |
| オーソリの失効で付く `cancellation_reason` の値（既定案は `automatic`） | E3 の `auth-expiry` の Story で、本家のテスト環境で `capture_before` を過ぎた PaymentIntent を観察する |
| 日本の JPY 取引で 30 日のオーソリを、接続するアクワイアラが許すか | E3 の接続先の選定（契約・仕様書） |
| 日本のクレジットカード・セキュリティガイドラインの版と、3DS を求める範囲 | 日本クレジット協会の公表資料で確かめる。法的な位置づけは [intent.md](../intent.md) の「法務の確認待ち」（割賦販売法） |
| 銀行振込の最大額（既定案は 99,999,999 円） | E8 の提携銀行の選定 |
| コネクタの照会 API の整合性の時間 | E3 の接続先の選定と、テスト環境での計測 |
| 返金の保留の期限（`refund.balance_hold_max`、既定 30 日）が本家と大きく違わないか | E3 の `refunds` の Story で、本家のテスト環境の振る舞いを観察する。違っても本システムの値を使う |

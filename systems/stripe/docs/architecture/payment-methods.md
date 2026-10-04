# Payment Methods: Stripe

決済手段（カード、コンビニ払い、銀行振込）の持ち方と、決済代行・アクワイアラへのコネクタ。PaymentIntent の状態遷移は [payments.md](payments.md)、カード番号の保管は [card-vault.md](card-vault.md) にある。

決定：コネクタの抽象と結果不明の回復（[ADR-0011](../decisions/0011-connector-abstraction-and-unknown-outcome.md)）。3D セキュア（[ADR-0012](../decisions/0012-3ds-via-connector.md)）。日本の非同期の決済手段（[ADR-0013](../decisions/0013-japan-async-payment-methods.md)）。コネクタからの通知（[ADR-0014](../decisions/0014-connector-inbox.md)）。

## 1. 方針

- **本体はカード番号を持たない。** PaymentMethod は Vault のトークンへの参照と、表示用の情報だけを持つ（[ADR-0005](../decisions/0005-pci-scope-segmentation.md)）。
- **決済代行ごとの差はコネクタに閉じ込める。** Payments はコネクタの共通の操作と、正規化した結果（本家に寄せた拒否コード）だけを見る。
- **カードのコネクタは CDE、カード以外のコネクタは本体に置く。** コンビニ払いと銀行振込はカード番号を扱わないので、CDE を広げない（[ADR-0013](../decisions/0013-japan-async-payment-methods.md)）。
- **テスト環境は模擬のアクワイアラにつなぐ。** 本家のテスト用のカード番号とメールアドレスで結果が決まる（[ADR-0002](../decisions/0002-account-tenancy.md)）。

## 2. PaymentMethod

### 2.1 型

MVP は 3 つ。本家の `type` の値をそのまま使う（[PaymentIntent object](https://docs.stripe.com/api/payment_intents/object)）。

| `type` | 中身 | 作り方 |
| --- | --- | --- |
| `card` | Vault のトークン、表示用の情報（2.2 節） | Elements・Checkout がカード番号を Vault に直接送って使い捨ての `card_input` を受け取り、公開キーで `POST /v1/payment_methods` に渡す。本体が Vault に紐づけて `pm_` を作る（[card-vault.md](card-vault.md) の 3.1 節） |
| `konbini` | `billing_details.name`・`email`（支払い番号の発行に要る） | confirm の `payment_method_data` で作る |
| `customer_balance` | なし（Customer の現金残高を使う） | confirm の `payment_method_data` で作る。Customer が必須 |

- `billing_details`（氏名、メール、電話、住所）はすべての型に持たせる。
- `pm_` の ID は本体が採番する。Vault のトークンとの対応は、Vault 側にだけ持つ（本体の DB に Vault の内部の ID を置かない）。本体から Vault への要求は `pm_` と `account_id` で行う。
- テーブル：`payment_methods`（`account_id`、`type`、`customer_id`、`billing_details`、`card_display`、`fingerprint`、`fingerprint_internal`、`created_at`、`detached_at`）。環境はクラスタで分かれるので `livemode` の列は持たない。列の正本は [data-model/payment-methods.md](data-model/payment-methods.md)。

### 2.2 カードの表示用の情報

本家の `card` の属性に寄せる。PCI DSS 上、カード番号と一緒でなければ保護の対象にならない項目だけを本体に置く。

| 項目 | 例 | 出どころ |
| --- | --- | --- |
| `brand` | `visa`、`mastercard`、`jcb`、`amex`、`diners`、`discover` | Vault が BIN から判定 |
| `last4` | `4242` | Vault |
| `exp_month`・`exp_year` | `12`・`2030` | Vault |
| `funding` | `credit`・`debit`・`prepaid`・`unknown` | BIN の表 |
| `country` | `JP` | BIN の表 |
| `fingerprint` | 同じカード番号なら同じ値 | Vault が加盟店ごとの鍵で HMAC を取る |
| `checks` | `cvc_check`・`address_postal_code_check` | 最初のオーソリの結果 |
| `three_d_secure_usage.supported` | `true` | BIN の表・3DS Server |

- `fingerprint` は加盟店ごとに別の値にする。加盟店をまたいで同じカードを突き合わせられないようにする。本家の `fingerprint` もアカウントごとに一意である（[重複したカードの検出](https://support.stripe.com/questions/how-can-i-detect-duplicate-cards-or-bank-accounts)、2026-09-27 に確認。Connect のプラットフォームが作ったものは例外で、範囲外）。
- BIN の表（ブランド・国・種別）は、コネクタかカードブランドの提供する表を CDE で定期的に取り込む。取得元は最初のコネクタとの契約で決める。
- カード番号・CVC・トラックデータは本体に一切置かない。CVC は Vault にも保存しない（オーソリの 1 回に使って捨てる）。

### 2.3 Customer との関係

- `POST /v1/payment_methods/{id}/attach` で Customer に付け、`detach` で外す。付いていない `card` の PaymentMethod は、1 回の支払いに使ったら再利用できない（本家と同じ）。
- 外した PaymentMethod は論理削除（`detached_at`）にし、Vault のトークンは保持期間の後に消す（[security.md](security.md) のデータのライフサイクル）。
- `setup_future_usage` か SetupIntent を通ったカードは、MIT に使うネットワークの取引 ID を Vault に持つ（[payments.md](payments.md) の 11 節）。

## 3. コネクタ

### 3.1 構成

```
Payments（本体）
  │ 共通の操作（カード番号を含まない）
  ├──▶ Connector Gateway（CDE）── カードの決済代行 A（最初の 1 社）
  │                                └ 模擬のアクワイアラ（テスト環境）
  └──▶ Async Connectors（本体）── コンビニ収納代行
                                   ├ 振込先口座を提供する銀行
                                   └ 模擬の収納代行・銀行（テスト環境）

コネクタ → 受信箱（connector_inbox）→ Payments・Disputes（通知の反映。ADR-0014）
```

- 本体から Connector Gateway への呼び出しは、アカウントをまたぐ決まった API（[ADR-0005](../decisions/0005-pci-scope-segmentation.md)）。要求と応答にカード番号を含めない。Gateway が Vault からカード番号を取り出し、決済代行への要求を組み立てる。
- 最初のカードの決済代行は未定（[intent.md](../intent.md) の未解決の問い）。インターフェースは 1 社目に合わせすぎないよう、2 社の仕様（日本の決済代行とグローバルのアクワイアラ）を並べて設計する。

### 3.2 共通の操作

| 操作 | 入力 | 出力 |
| --- | --- | --- |
| `authorize` | 参照番号、PaymentMethod、金額、通貨、CIT/MIT、3DS の結果、`capture` するか | 結果（承認・拒否・結果不明）、アクワイアラの取引 ID、正規化した拒否コード、`capture_before` |
| `capture` | 参照番号、取引 ID、金額 | 結果 |
| `void` | 参照番号、取引 ID、金額（一部の取り消し） | 結果 |
| `refund` | 返金の参照番号、取引 ID、金額 | 結果（受理・拒否・結果不明） |
| `inquire` | 参照番号 | 見つかった（その状態）・見つからない・照会できない |
| `verify` | 参照番号、PaymentMethod | 口座確認の結果（SetupIntent 用） |
| `authenticate_start` / `authenticate_result` | 参照番号、PaymentMethod、ブラウザーの情報 | frictionless / チャレンジの情報 / 失敗、ECI、認証の値 |
| `parse_notification` | 通知の生データ | 正規化した通知（オーソリ・返金・Dispute・入金・EFW） |
| `parse_settlement` | 精算ファイル | 明細の行（[payouts-and-reconciliation.md](payouts-and-reconciliation.md)） |

非同期の決済手段のコネクタは、代わりに次を持つ。

| 操作 | 用途 |
| --- | --- |
| `issue_voucher` / `cancel_voucher` | コンビニの支払い番号の発行と取り消し |
| `allocate_virtual_account` | 銀行振込の振込先（バーチャル口座）の割り当て |
| `payout_refund` | 顧客の銀行口座への返金の振込 |

- すべての操作は参照番号で冪等にする。同じ参照番号の 2 回目は、1 回目の結果を返すか重複として拒否されることを、コネクタごとの結合テストで確かめる。
- 操作ごとにタイムアウトを持つ（[capacity.md](capacity.md) のパラメーター）。

### 3.3 能力（capabilities）

コネクタごとに、できることを宣言する。Payments は能力を見て振る舞いを変える。

| 能力 | 例 | 使う場所 |
| --- | --- | --- |
| `auth_and_capture_in_one` | 即時売上がある | `capture_method = automatic` |
| `manual_capture`、`partial_capture`、`partial_void` | 仮売上・実売上、一部の取り消し | [payments.md](payments.md) の 5 節 |
| `max_auth_validity` | ブランド × 通貨ごとの日数 | `capture_before` |
| `multiple_partial_refunds` | 1 取引に複数の一部返金 | 返金 |
| `inquiry`、`inquiry_consistency_window` | 参照番号での照会と、その整合性の時間 | 結果不明の回復 |
| `three_ds_server` | 3DS2 の認証を提供する | [ADR-0012](../decisions/0012-3ds-via-connector.md) |
| `account_verification` | 0 円オーソリ | SetupIntent |
| `early_fraud_warnings` | TC40・SAFE 相当の通知 | [disputes.md](disputes.md) |
| `network_tokens` | ネットワークトークンでのオーソリ | 3.6 節 |
| `supported_brands`、`supported_currencies` | | 振り分け |

### 3.4 拒否コードの正規化

- コネクタの生のコード（アクワイアラ・カード発行会社の応答コード）を、本家の拒否コードに写す表を、コネクタごとに持つ。表はコードで管理し、バージョンを付ける。
- 出力は本家の形に合わせる：`code`（`card_declined`、`expired_card`、`incorrect_cvc`、`processing_error` など）、`decline_code`、生のコードは `network_decline_code` に入れる（[Stripe の支払い拒否コード](https://docs.stripe.com/declines/codes)、2026-09-26 に確認）。
- 主な写し先：

| 分類 | `decline_code` の例 | 再試行 |
| --- | --- | --- |
| 資金・限度 | `insufficient_funds`、`card_velocity_exceeded`、`withdrawal_count_limit_exceeded` | 顧客が別の手段で |
| 入力の誤り | `incorrect_number`、`incorrect_cvc`、`expired_card`、`invalid_expiry_year` | 顧客が直して再試行 |
| 認証 | `authentication_required` | 3DS を行って再試行（[payments.md](payments.md) の 6 節） |
| 一時的 | `issuer_not_available`、`processing_error`、`reenter_transaction` | 時間をおいて再試行 |
| 理由不明の拒否 | `do_not_honor`、`generic_decline`、`call_issuer` | 顧客がカード発行会社に問い合わせ |
| 不正・紛失・盗難 | `fraudulent`、`lost_card`、`stolen_card`、`merchant_blacklist`、`pickup_card` | しない |

- **顧客に見せるときは、`fraudulent`・`lost_card`・`stolen_card`・`merchant_blacklist` を `generic_decline` に置き換える**（本家の推奨どおり）。加盟店の API とダッシュボードには本当の値を出す。
- 表にない生のコードは `generic_decline` に写し、メトリクスで数えて、週次で表に足す。
- 本家の `advice_code`（再試行の助言）は S2 で足す。

### 3.5 障害と振り分け

振り分けと二重オーソリを防ぐ規則は [payments.md](payments.md) の 8 節。コネクタの側で守ることは次のとおり。

- 送信前の失敗（`failed_before_send`）と、送信後の失敗（結果不明）を、呼び出し元が区別できる形で返す。区別できない失敗は結果不明とする。
- コネクタの HTTP クライアントは、自動の再送をしない。再送するかは Payments が参照番号の規則で決める。
- 決済代行の IP 許可・mTLS・鍵の更新は [infrastructure.md](infrastructure.md) と [security.md](security.md)。

### 3.6 ネットワークトークン（任意）

- カードブランドのネットワークトークン（Visa Token Service、Mastercard MDES）は、コネクタが対応していれば S2 で使う。カードの更新（再発行）に追従でき、承認率が上がるとされる。
- 使うときも、トークンと暗号文（cryptogram）は CDE の Vault に置き、本体の PaymentMethod は変えない。
- MVP では作らない。能力の `network_tokens` だけを定義しておく。

## 4. テスト環境の模擬のアクワイアラ

テスト環境（`<brand>_sk_test_`）は、実在の決済代行に接続しない。模擬のアクワイアラが、カード番号・メールアドレス・確認番号から結果を決める。値は本家のテスト用の値に合わせ、加盟店が本家の文書のまま試せるようにする（[テスト](https://docs.stripe.com/testing)、[3D セキュア](https://docs.stripe.com/payments/3d-secure/authentication-flow)、2026-09-26 に確認）。

### 4.1 カード

| カード番号 | 結果 |
| --- | --- |
| `4242424242424242`（Visa）、`5555555555554444`（Mastercard）、`378282246310005`（Amex）、`3566002020360505`（JCB） | 承認 |
| `4000000000000002` | `card_declined` / `generic_decline` |
| `4000000000009995` | `card_declined` / `insufficient_funds` |
| `4000000000009987` | `card_declined` / `lost_card` |
| `4000000000009979` | `card_declined` / `stolen_card` |
| `4000000000000069` | `expired_card` |
| `4000000000000127` | `incorrect_cvc` |
| `4000000000000119` | `processing_error` |
| `4000000000003220` | 3DS2 のチャレンジが必須 |
| `4000002500003155` | 保存（SetupIntent）がなければ 3DS が必須。保存後の MIT は不要 |
| `4000008400001629` | 3DS の後に `card_declined` |
| `4000000000003055` | 3DS は任意（要求すればできる） |
| `4000000000000259` | 承認後に Dispute（不正利用） |
| `4000000000001976` | 承認後に照会（inquiry） |
| `4000000000005423` | 承認後に早期の不正警告（EFW）だけ |
| `4000000000007726` | 返金が `pending` から `succeeded` |
| `4000000000005126` | 返金が `succeeded` の後に `failed` |

- 本家の `pm_card_visa` などの PaymentMethod の ID も受け付ける。
- 本家のテスト用の表は上に挙げたものより多い。上の表を MVP の範囲とし、残りは本家の表から足していく。表の各値は、本家のテスト環境で同じ結果になることを契約テストで確かめる。
- 本システムに固有の値として、**結果不明を起こすカード番号**を加える（本家にはない）。オーソリがタイムアウトし、照会で「承認」・「見つからない」が返る 2 種類。加盟店が `processing` の扱いを試せるようにする。番号は、`4000000000` で始まり Luhn の検査を通る番号のうち、本家のテスト用の表にないものから 2 つ選ぶ。取り込んだ本家の表と重ならないことを CI で検査する（8 節。[card-vault.md](card-vault.md) の Luhn 検査も通す）。
- 3DS のチャレンジは、模擬の画面で「成功」「失敗」を選べる。
- テスト環境の Vault も、テスト用のカード番号以外（本物のカード番号の形をした値）を拒否する（[ADR-0005](../decisions/0005-pci-scope-segmentation.md)）。どの番号をテスト用と見なすかは表で持つ。

### 4.2 コンビニ・銀行振込

- コンビニ：本家と同じく、メールアドレスか確認番号で結果を決める（[コンビニ決済](https://docs.stripe.com/payments/konbini/accept-a-payment?payment-ui=direct-api)）。

| メールアドレス | 確認番号 | 結果 |
| --- | --- | --- |
| 任意 | `11111111110` | 3 分後に支払い完了 |
| `...succeed_immediately@...` | `22222222220` | すぐに支払い完了 |
| `...expire_immediately@...` | `33333333330` | すぐに期限切れ |
| `...expire_with_delay@...` | `44444444440` | 3 分後に期限切れ |
| `...fill_never@...` | `55555555550` | 支払われず、期限で失効 |

- 銀行振込：テスト用の API（本家の `test_helpers` の `fund_cash_balance` に相当）で、任意の Customer に任意の額の入金を起こせる。過不足の扱いを試せる。
- 返金の口座情報の入力は、本家と同じテスト用の口座（金融機関番号 `1100000`、口座 `0001234` で成功）を受け付ける。

## 5. コンビニ払い

本家の `konbini` に寄せる（[コンビニ決済](https://docs.stripe.com/payments/konbini)、[受け付け方](https://docs.stripe.com/payments/konbini/accept-a-payment?payment-ui=direct-api)、2026-09-26 に確認）。コンビニ収納代行の事業者と接続する。

### 5.1 属性

| 項目 | 値 |
| --- | --- |
| 通貨 | JPY だけ |
| 金額 | 120 円〜300,000 円 |
| 手動キャプチャ | なし |
| 返金 | 全額・一部。顧客の銀行口座への振込 |
| Dispute | なし（対面の現金払いのため） |
| 店舗 | 収納代行の事業者が対応するチェーン（本家はファミリーマート、ローソン、ミニストップ、セイコーマート） |

### 5.2 流れ

1. confirm で、`billing_details.name`（コンビニの画面では 20 文字に切り詰め、Shift_JIS にない文字を置き換える）と `email` を受け取る。
2. 支払い期限を決める。`payment_method_options.konbini.expires_after_days`（1〜60 日、既定 3 日。その日の 23:59:59 JST に失効）か `expires_at`（30 分後〜60 日以内）。両方の指定はエラー。
3. 収納代行に支払い番号の発行を要求する（`issue_voucher`）。要求には `product_description`（22 文字以内、Shift_JIS）と、`confirmation_number`（10〜11 桁、0 だけは不可。指定がなければ生成する）を付ける。
4. PaymentIntent を `requires_action` にし、`next_action.konbini_display_details` に、店舗ごとの `payment_code`・`confirmation_number`、`expires_at`、`hosted_voucher_url`（支払い方法の案内ページ）を入れる。
5. 顧客が店頭で払うと、収納代行から入金の通知（速報）が届く。受信箱（[ADR-0014](../decisions/0014-connector-inbox.md)）を経て、PaymentIntent を `succeeded` にし、非同期の入金の仕訳を書く（[payments.md](payments.md) の 9 節）。
6. 期限を過ぎても入金がなければ、猶予（`konbini.expiry_grace`、既定 1 時間）の後に `requires_payment_method` に戻し、`payment_intent.payment_failed` を出す。期限前に発行された払込票はレジで期限後も払えることがあるため、猶予を置く（本家も同じ理由で猶予を置き、失効の通知を期限の約 1 時間後に出す）。

- 速報と確報：収納代行は一般に「速報」と、後日の「確報」を送る。速報の時期は代行ごとに違い、支払いの直後とは限らない（例：入金の 90〜150 分後、または収納日の翌営業日。確報は翌営業日から 3〜10 営業日。[地銀ネットワークサービス](https://www.chigin-cns.co.jp/services/conveni_web/summary.php)、[電算システム](https://www.dsk-ec.jp/products/convenience/)、2026-09-27 に確認）。速報で `succeeded` にし、確報と精算ファイルで照合する。
- 店頭での取り消しは、確報が来ないことではなく「速報取消データ」という別のデータで届く（同上）。受け取ったら受信箱（ADR-0014）で扱い、`succeeded` の後なので自動では戻さず、照合の不一致として手作業で扱う（加盟店への通知を含む）。最初の収納代行の仕様書で、データの形と時期を確かめる。
- 取り消し：期限前の `requires_action` は取り消せる。収納代行に `cancel_voucher` を送り、受理されてから `canceled` にする。顧客が店頭で支払い中などで拒否されたら、400 を返す（本家も同じ）。
- 期限切れの後の入金（猶予も過ぎた後）：PaymentIntent は既に `requires_payment_method` なので、成功にしない。入金を「宙に浮いたお金」として受け、自動で顧客に返金する（口座情報の入力を依頼する）。SEV3 として数える。
- 支払い番号の発行が一時的に使えない（収納代行の障害）ときは、本家と同じ `payment_method_not_available` を返す。
- 案内のメールとリマインドのメールは、加盟店の設定で送る（S2）。MVP は `hosted_voucher_url` の案内ページだけ。

### 5.3 返金

- 顧客の銀行口座に振り込む。返金を作ると `requires_action` にし、PaymentMethod のメールアドレスに口座情報の入力のリンクを送る。入力されたら `pending`、振込が終われば `succeeded`、45 日たっても入力がなければ `failed`（[payments.md](payments.md) の 10.2 節）。
- 振込は、返金用の銀行（`payout_refund`）で行う。口座名義の不一致などで組み戻されたら、`requires_action` に戻して再び入力を依頼する。
- 返金の振込先の口座情報は個人情報として暗号化して `refund_bank_details` に持ち、返金の完了後に保持期間を過ぎたら消す（[security.md](security.md)、[data-model/payment-methods.md](data-model/payment-methods.md) の 2.5 節）。

## 6. 銀行振込

本家の `customer_balance` と `jp_bank_transfer` に寄せる（[銀行振込による支払い](https://docs.stripe.com/payments/bank-transfers)、[受け付け方](https://docs.stripe.com/payments/bank-transfers/accept-a-payment?payment-ui=direct-api)、2026-09-26 に確認）。振込は Customer ごとの **現金残高** に入り、そこから PaymentIntent に充てる（[ADR-0013](../decisions/0013-japan-async-payment-methods.md)）。

### 6.1 振込先（バーチャル口座）

- Customer ごとに 1 つ、振込先の口座（バーチャル口座）を割り当てる。以後、その Customer の銀行振込はすべてこの口座で受ける。振込ごとに口座を変えないので、顧客は同じ口座を登録して使える。
- 口座は、提携する銀行から番号の範囲（プール）を受け取って割り当てる。`virtual_bank_accounts`（`account_id`、`customer_id`、`bank_code`、`bank_name`、`branch_code`、`branch_name`、`account_type`、`account_number`、`account_holder_name`、`allocated_at`、`released_at`）。
- `next_action.display_bank_transfer_instructions` に、`type = jp_bank_transfer`、`amount_remaining`、`currency`、`financial_addresses[].zengin`（銀行名・支店名・口座種別・7 桁の口座番号・口座名義）、`hosted_instructions_url` を入れる。`reference` は日本では使わない（本家と同じ）。
- 口座名義は、本システムの運営会社の収納用の名義になる（本家の例は「ストライプジャパン（カ　シュウノウダイコウ」）。名義と、加盟店の代わりに代金を受け取る仕組みの法的な位置づけは、法務の確認待ち（[intent.md](../intent.md)）。
- 外した口座（Customer の削除）は、少なくとも 13 か月は他の Customer に再び割り当てない。古い口座への誤った振込を、別の Customer の入金にしないため。13 か月は仮の値（未検証。提携する銀行の運用と合わせて決める）。
- 無料で作れる口座の数に上限がある国があると本家は書いている。日本での上限と費用は提携する銀行との契約で決まる（未検証）。

### 6.2 着金と充当

1. 提携する銀行から入金の明細（API か全銀の形式のファイル）が届く。受信箱に記録する（[ADR-0014](../decisions/0014-connector-inbox.md)）。
2. 口座番号から Customer を特定し、現金残高の受け入れの仕訳を書く。`cash_balance_transactions` に `funded` を追記する（振込人の名義・銀行・支店を含む）。
3. **自動の充当**（Customer の `reconciliation_mode = automatic`、既定）：その Customer の、銀行振込で `requires_action` の PaymentIntent に現金残高を充てる。
   - 本家の JPY の規則に合わせる（[現金残高の消し込み](https://docs.stripe.com/payments/customer-balance/reconciliation)、2026-09-27 に確認）。請求書（Billing）は範囲外なので、PaymentIntent の部分だけを使う。
   - まず、金額の合計が残高にちょうど一致する 1〜5 件の PaymentIntent の組を探す。候補が複数あれば、件数の少ない組、PaymentIntent の古い組の順で選ぶ。
   - 見つからなければ、確定の古い順に充てる。1 つを満たせない額は、その PaymentIntent に一部だけ充てる。
4. 満たされた PaymentIntent は `succeeded`、一部だけのものは `requires_action` のまま `amount_remaining` を減らし、`payment_intent.partially_funded` を出す。
5. 充てても残った額は、Customer の現金残高に残る。次の PaymentIntent の confirm で自動的に使う。
6. **手動の充当**（`reconciliation_mode = manual`）：加盟店が `apply_customer_balance` で充てる。

- 口座番号が分からない、または割り当てのない口座への着金は「未照合の着金」として保留し、運用が手作業で振り分ける。
- 一部だけ充てた PaymentIntent の金額を加盟店が変えたら、充てた額を現金残高に戻し、充当をやり直す（本家と同じ）。

### 6.3 過不足と残ったお金

| 状況 | 扱い |
| --- | --- |
| 振込が足りない | PaymentIntent に一部だけ充て、`requires_action` のまま `amount_remaining` を示す |
| 振込が多い | 余りは Customer の現金残高に残る。加盟店は返金するか、次の支払いに使う |
| 振込手数料が差し引かれて足りない | 足りない場合と同じ。顧客に差額の振込を求めるかは加盟店が決める |
| どの PaymentIntent にも充たらないまま長く残る | 本家は 75 日で顧客の口座への返金を試み、90 日で口座情報が得られなければ加盟店の残高に移す。本システムの扱いは法務の確認の後に決める（顧客のお金を加盟店に移してよいかが、資金決済法上の位置づけに依存する） |

- PaymentIntent の期限：本家の文書は「着金するまで `requires_action` のまま」とし、自動で失効する記述はない（2026-09-27 に確認）。MVP では自動で失効させず、加盟店が取り消す。取り消しても、現金残高に入ったお金はそのまま残る。

### 6.4 返金

- 2 通りを本家と同じく持つ。
  - **顧客の銀行口座へ**：振込人の口座情報が明細から得られればそれを使う。なければ顧客に入力を依頼する（コンビニと同じ `requires_action` の流れ）。
  - **現金残高へ**：返金額を Customer の現金残高に戻す。次の支払いに使える。
- 現金残高そのもの（どの支払いにも充てていないお金）の返金も、加盟店が API・ダッシュボードで行える。
- 銀行振込は、顧客の側から取り消せない（本家も JPY の Dispute はない）。

## 7. S2・S3 で変わること

- S2：カードの 2 社目のコネクタ。ネットワークトークン。`advice_code`。コンビニの案内・リマインドのメール。PayPay など、日本で使われる他の決済手段（本家の `paypay`）の検討。
- S3：振込先の口座のプールをセルごとに分ける。

## 8. 決定と持ち越し（2026-09-26、既定案）

- **`fingerprint`**：加盟店ごとに別の値にする（2.2 節）で確定する。本家が加盟店をまたいで同じ値かにかかわらず、加盟店をまたいだ突き合わせを許さない方を選ぶ。
- **銀行振込の自動の充当の順序**：金額が一致するものを先に、なければ古い順（6.2 節）で確定する。
- **銀行振込の PaymentIntent の失効**：自動で失効させない（6.3 節）で確定する。加盟店が取り消す。
- **結果不明を起こすテスト用のカード番号**：`4000000000` で始まり Luhn の検査を通る番号のうち、本家のテスト用の表にないものから 2 つ選ぶ（4 節。2026-09-28 に確定）。具体の番号は、E1 の `mock-acquirer` の Story で本家の表を取り込んだ後に、重ならないものを選ぶ。

| 持ち越し | いつ・どう決めるか |
| --- | --- |
| コンビニ収納代行の速報・確報の有無と、速報の取り消しの扱い | E8 の収納代行の選定（仕様書） |
| 振込先の口座の数の上限と費用、再割り当てまでの期間（仮に 13 か月） | E8 の提携銀行の選定 |
| 本家のテスト用のカード番号の全体 | E1 の `mock-acquirer` と E3 で、本家の [テスト](https://docs.stripe.com/testing) の表を取り込み、契約テストで本家と同じ結果になるかを確かめる |

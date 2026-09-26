# Disputes: Stripe

チャージバック（Dispute）、照会（inquiry）、早期の不正警告（EFW）の受け取り、資金の引き落とし、証拠の提出、結果の反映。決済の状態遷移は [payments.md](payments.md)、不正検知のルールは [fraud.md](fraud.md) にある。

決定：コネクタからの通知を受信箱に記録してから反映する（[ADR-0014](../decisions/0014-connector-inbox.md)）。

## 1. 方針

- **本家の Dispute の形と状態をそのまま使う**（[Dispute object](https://docs.stripe.com/api/disputes/object)、[不審請求の申請の仕組み](https://docs.stripe.com/disputes/how-disputes-work)、2026-09-26 に確認）。
- **結果を決めるのはカード発行会社。** 本システムは、コネクタ（アクワイアラ）からの通知を正本として状態を進め、加盟店の証拠をアクワイアラへ届ける。自分で勝ち負けを決めない。
- **お金は通知の時点で動かす。** チャージバックを受けたら、その時点で加盟店の残高から Dispute の額と手数料を引く。勝てば額を戻す（本家と同じ）。
- **証拠の提出は 1 回だけ。** 提出したら直せない（本家と同じ）。

## 2. オブジェクト

| オブジェクト | ID | 役割 |
| --- | --- | --- |
| Dispute | `du_` | 1 件の照会またはチャージバック。Charge に属する。1 つの Charge に複数ありうる |
| Dispute の証拠 | （Dispute の中） | 本家の `evidence` の項目（`product_description`、`customer_communication`、`shipping_documentation`、`receipt`、`uncategorized_file` など）と、提出の情報（`evidence_details`） |
| File | `file_` | 証拠の添付ファイル（`purpose = dispute_evidence`）。S3 に置く |
| Early Fraud Warning | `issfr_` | カード発行会社が不正の疑いを報告した記録。Charge に属する |

- ID の接頭辞は本家の文書の例（`du_`）に合わせる。
- テーブル：`disputes`（`account_id`、`livemode`、`charge_id`、`payment_intent_id`、`amount`、`currency`、`reason`、`status`、`network_reason_code`、`evidence`（JSONB）、`evidence_due_by`、`submission_count`、`is_charge_refundable`、`connector_case_id`、`created_at`、`closed_at`）、`dispute_files`、`early_fraud_warnings`。
- 本家の `reason` の値を使う：`fraudulent`、`duplicate`、`product_not_received`、`product_unacceptable`、`subscription_canceled`、`credit_not_processed`、`unrecognized`、`general` など。カードブランドの理由コード（例：Visa 10.4）は `network_reason_code` に持ち、写し先の表はコネクタごとに持つ。

## 3. 状態

本家の 8 つ：`warning_needs_response`、`warning_under_review`、`warning_closed`、`needs_response`、`under_review`、`won`、`lost`、`prevented`。`warning_` の付くものが照会、付かないものがチャージバック。

```
照会の通知 ──▶ warning_needs_response ──証拠の提出──▶ warning_under_review
                   │                                     │
                   │ 全額返金・120 日で終了                │ 終了の通知・120 日
                   ▼                                     ▼
              warning_closed ◀───────────────────────────┘
                   │（照会がチャージバックへ）
                   ▼
チャージバックの通知 ──▶ needs_response ──証拠の提出──▶ under_review ──▶ won / lost
                         │ 受け入れ（accept）・期限切れ                 
                         └────────────────────────────────▶ lost
```

| 今の状態 | きっかけ | 次の状態 | お金 |
| --- | --- | --- | --- |
| （なし） | 照会の通知 | `warning_needs_response` | 動かさない |
| `warning_needs_response` | 証拠の提出 | `warning_under_review` | 動かさない |
| `warning_needs_response` | 加盟店が全額返金 | `warning_closed` | 返金の仕訳だけ |
| `warning_*` | アクワイアラが照会を閉じた、または 120 日たった | `warning_closed` | 動かさない |
| `warning_*` | 同じ支払いのチャージバックの通知 | 照会は `warning_closed`、新しい Dispute を `needs_response` で作る | 引き落とし |
| （なし） | チャージバックの通知 | `needs_response` | 引き落とし |
| `needs_response` | 証拠の提出 | `under_review` | 動かさない |
| `needs_response` | 加盟店が受け入れ（`POST /v1/disputes/{id}/close`） | `lost` | 動かさない（既に引き落とし済み） |
| `needs_response` | 提出の期限を過ぎた | `lost` | 動かさない |
| `under_review` | 加盟店に有利な決定 | `won` | 戻し |
| `under_review` | 顧客に有利な決定 | `lost` | 動かさない |
| `lost` | カード発行会社が後から額を戻した（late win） | `won` | 戻し |
| 照会の前の段階 | カードブランドの仕組みで正式なチャージバックに至らなかった | `prevented` | 動かさない |

- 照会を 120 日で閉じるのは本家の扱い（照会はカードブランドから明示の「勝ち」の知らせがないため）。
- `prevented` を出す仕組み（カードブランドの事前解決の仕組みとの連携）は MVP では作らない。値だけを定義しておく。
- 一度 `won`・`lost` になった Dispute は、late win を除いて変わらない。本家にも仲裁の段階はない（アクワイアラから仲裁・再審の通知が来たら、運用が手作業で扱う）。

## 4. 通知の取り込み

- コネクタは、Dispute に関わる通知を Webhook・日次のファイル・管理画面のどれかで出す。どの手段で来るかはコネクタごとに違う（最初のコネクタの仕様で決める。未検証）。
- どの手段でも、受信箱（`connector_inbox`）に生のまま記録し、`(connector, 通知の ID)` で重複を除いてから反映する（[ADR-0014](../decisions/0014-connector-inbox.md)）。
- 通知の Charge の特定は、アクワイアラの取引 ID（オーソリの応答で保存したもの）か、参照番号で行う。見つからない通知は保留にし、SEV3 として運用が確かめる。
- 同じ Dispute の通知が順序を違えて届く（決定の通知がチャージバックの通知より先など）ことがある。状態の表にない遷移は保留にし、前の通知が来てから反映する。一定時間（`dispute.out_of_order_hold`、既定 24 時間）来なければ運用に回す。
- ファイルでしか届かないコネクタでは、チャージバックの受け取りが最大 1 営業日遅れる。そのぶん、加盟店の回答の期間が短くなる（6 節）。

## 5. お金の動き

### 5.1 引き落としと手数料

- チャージバックを受けたら、Dispute の額（`amount`）と Dispute の手数料を、加盟店の残高から引く。本家も通知の時点で両方を引く。
- Dispute の額は、元の支払いの額と違うことがある（一部の Dispute、複数の支払いをまとめた Dispute など）。額は通知の値を使う。MVP は JPY だけなので、両替による差は起きない。
- 手数料の額は料金表で決める（[ledger.md](ledger.md) の 7 節）。既定は本家の日本と同じ 1 件 1,500 円（[Stripe 料金](https://stripe.com/jp/pricing)、2026-09-26 に確認）。
- 本家は、証拠の提出で「反論の手数料」を別に取るが、日本の加盟店には適用しない。本システムも取らない。
- 勝っても手数料は戻さない（本家と同じ。メキシコの加盟店だけ例外）。
- 引き落としは残高を確かめない。加盟店の残高がマイナスになってもよい（返金と違う。[payments.md](payments.md) の 10.2 節）。回収は [ledger.md](ledger.md) の 4.5 節。

### 5.2 仕訳

口座の名前は [ledger.md](ledger.md) で確定する。

| 仕訳の種類 | いつ | 借方 | 貸方 |
| --- | --- | --- | --- |
| Dispute の引き落とし | チャージバックの通知（`needs_response` の作成） | 加盟店の残高（Dispute の額） | コネクタへの未収金（アクワイアラが精算で差し引く額） |
| Dispute の手数料 | 同じトランザクション | 加盟店の残高（手数料） | 手数料収益 |
| Dispute の戻し | `won`（late win を含む） | コネクタへの未収金（戻る額） | 加盟店の残高（Dispute の額） |
| （なし） | 照会、証拠の提出、`lost` | — | — |

- アクワイアラ側の実際の差し引き（精算での相殺）は、精算ファイルとの照合で突き合わせる（[payouts-and-reconciliation.md](payouts-and-reconciliation.md)）。アクワイアラが加盟店への Dispute の手数料とは別に、本システムに手数料を課す場合、その費用は本システムの費用の口座に計上する。
- `balance_transactions`（本家の Dispute の属性）には、引き落としと戻しの 2 つまでの取引を並べる。
- Event：`charge.dispute.created`、`charge.dispute.updated`、`charge.dispute.funds_withdrawn`、`charge.dispute.funds_reinstated`、`charge.dispute.closed`。

### 5.3 返金との関係

- チャージバックの進行中（`needs_response`・`under_review`）は、その支払いを返金できない。返金すると顧客が二重に受け取るため（本家も Dispute の手続きの外での返金を認めない）。`is_charge_refundable = false` にする。
- 照会（`warning_*`）の段階は返金できる。全額返金で照会は閉じる（本家は、照会には証拠の提出か全額返金で手数料なしに解決できるとしている）。一部返金ではチャージバックに進みうる。
- 返金が `pending` のまま Dispute が来たら、その返金を `failed`（`charge_for_pending_refund_disputed`）にし、加盟店の残高に戻してから、Dispute の引き落としを書く。二重の払い戻しを防ぐ。

## 6. 証拠の提出と期限

### 6.1 期限

- アクワイアラが示す回答の期限から、アクワイアラに届けるまでの時間（`dispute.submission_buffer`、既定 2 営業日）を引いた時刻を、加盟店への期限 `evidence_details.due_by` にする。
- カードブランドの回答の期間はおおむね 7〜21 日、カード発行会社の審査は 60〜75 日かかり、全体で 2〜3 か月かかる（本家の説明）。
- 期限の 3 日前・1 日前に、ダッシュボードとメールで知らせる（[dashboard.md](dashboard.md)）。
- 期限を過ぎたら `evidence_details.past_due = true` にし、証拠の提出を受け付けない。アクワイアラに回答しないことを伝え（コネクタが「受け入れ」を要求する場合）、`lost` にする（本家も期限切れで自動的に負けとする）。

### 6.2 提出

- `POST /v1/disputes/{id}`（`evidence` と `submit`）。`submit = false` なら下書きとして保存し、`true` で提出する。提出は 1 回だけで、`submission_count` が 1 になったら以後の更新は 400。
- 添付ファイルは `POST /v1/files`（`purpose = dispute_evidence`）で上げる。PDF・JPEG・PNG。1 種類の証拠に 1 ファイル。合計 4.5 MB 以内、Mastercard は合計 19 ページ以内（本家の制限。[不審請求の申し立てへの対応](https://docs.stripe.com/disputes/responding)）。音声・動画・外部のリンクは受け付けない。
- ファイルのウイルス検査と保管は、Slack の files.md と同じ方式（GuardDuty Malware Protection for S3）にする。詳細は [security.md](security.md)。
- 提出のとき、Connector Gateway（またはアクワイアラの Dispute の API）の形式に変換して送る。変換の結果（PDF にまとめるなど）を保存し、何を送ったかを後から見せられるようにする。
- 送信が失敗・結果不明なら、同じ提出の ID で再送する（[ADR-0004](../decisions/0004-idempotency.md)）。加盟店から見た状態は、送信の成否に関わらず `under_review` にし、送れないまま期限が近づいたら SEV2 とする。

### 6.3 自動で添える証拠

- 3D セキュアの結果（認証の結果、ECI、認証の流れ）。不正利用の Dispute で、ライアビリティシフトの判断に使われる（[payments.md](payments.md) の 6 節）。ただし勝ちを保証しない。
- 支払いの情報（金額、日時、`billing_details`、配送先、AVS・CVC の検査の結果、顧客の IP）。
- Visa Compelling Evidence 3.0 の自動判定（同じカードの過去の取引による反証）は S2 で検討する。

### 6.4 受け入れ

- `POST /v1/disputes/{id}/close` で受け入れる。`needs_response` のときだけ。照会の受け入れは解決にならない（本家の説明どおり、照会には証拠か返金で応える）ので、`warning_needs_response` への `close` は 400 にする。

## 7. 早期の不正警告（EFW）

- カード発行会社が不正の疑いを報告したもの（Visa の TC40、Mastercard の SAFE など）。コネクタが能力 `early_fraud_warnings` を持てば取り込む。
- 本家の形に合わせる（[Early Fraud Warning object](https://docs.stripe.com/api/radar/early_fraud_warnings/object)）：`fraud_type`（`made_with_stolen_card` など）、`actionable`（まだ Dispute がなく、全額返金されていない）。Event は `radar.early_fraud_warning.created`。
- EFW は回答を求めない。加盟店は先に返金して Dispute を避けるか、様子を見るかを選ぶ。本家は、返金するかの目安を手数料との比較で示している。
- 加盟店の設定で「EFW を受けたら自動で全額返金する」を選べるようにする（[fraud.md](fraud.md) のルール）。既定は無効。
- お金は動かさない。

## 8. 決済手段ごとの違い

| 決済手段 | Dispute |
| --- | --- |
| カード | 本書のとおり |
| コンビニ | 本家は Dispute なし。店舗の手違いなどの申し立ては、運用が手作業で扱う |
| 銀行振込（JPY） | 取り消せない。本家も USD・CAD 以外は Dispute なし |

## 9. テスト環境

- 模擬のアクワイアラが、本家のテスト用のカード番号で Dispute・照会・EFW を起こす（[payment-methods.md](payment-methods.md) の 4 節）。
- 本家と同じく、証拠の `uncategorized_text` に `winning_evidence` を入れると `won`、`losing_evidence` で `lost`（照会ならチャージバックに進まずに閉じる）、`escalate_inquiry_evidence` で照会をチャージバックに進める（[テスト](https://docs.stripe.com/testing)、2026-09-26 に確認）。
- テスト環境では、期限や審査を数分に縮める。

## 10. S2・S3 で変わること

- S2：Visa Compelling Evidence 3.0 の自動判定、カードブランドの事前解決の仕組み（`prevented`）、2 社目のコネクタ。JPY 以外の通貨の Dispute（両替による額の差）。
- S3：変わらない（Dispute は PaymentIntent と同じセルに置く）。

## 11. 未検証の事項

| 事項 | 確かめ方 |
| --- | --- |
| 最初のコネクタが Dispute・照会・EFW をどの手段（Webhook・ファイル）で出すか、回答の期限をどう示すか | 最初のコネクタの仕様書 |
| アクワイアラへの証拠の送付にかかる時間（`submission_buffer` の妥当性） | 最初のコネクタとの試験 |

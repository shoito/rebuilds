# Checkout and Elements: Stripe

加盟店の顧客がカード情報などを入力する画面。ホスト型の決済ページ（本家の Checkout に相当）と、加盟店のページに埋め込む入力部品（本家の Elements、特に Payment Element に相当）。カード情報の流れと分離の方針は [ADR-0027](../decisions/0027-checkout-and-elements-isolation.md) にある。

本家の仕様は docs.stripe.com で 2026-09-26 に確認した。確認できなかったものは「未検証」と書き、確かめ方を 14 節に置く。

## 1. 原則

- **カード番号は、CDE の側のオリジンが配る iframe の中でだけ入力させ、そこから Vault へ直接送る。** 加盟店のページ、加盟店のサーバー、本体の API は、カード番号に一度も触れない（[ADR-0005](../decisions/0005-pci-scope-segmentation.md)）。
- **加盟店が SAQ A で済む組み込みを、既定にする。** 本家の Checkout と Elements は、カード入力をすべて Stripe のドメインの iframe に置くことで、加盟店を SAQ A の対象にしている（[PCI DSS 準拠ガイド](https://stripe.com/guides/pci-compliance)）。これに合わせる。
- **決済の画面に、第三者のスクリプトを読み込まない。** 計測・チャット・タグマネージャーは置かない。Slack の [ADR-0025](../../../slack/docs/decisions/0025-product-analytics-with-ga4.md)（GA4）の方式は、決済の画面には適用しない。
- **決済の状態の正本はサーバー。** 画面は PaymentIntent・Checkout Session の状態を表示するだけで、成否を自分で決めない。加盟店には、フルフィルメントを Webhook（`checkout.session.completed` など）で行うよう案内する（[events-and-webhooks.md](events-and-webhooks.md)）。

## 2. オリジンと配置

| オリジン | 中身 | 置き場所 | PCI の範囲 |
| --- | --- | --- | --- |
| `js.<domain>` | 読み込み用のスクリプト（本家の Stripe.js に相当。以下「loader」） | **CDE のアカウント** の S3＋CloudFront。CDE のデプロイの経路で配る | CDE |
| `elements.<domain>` | カード入力の iframe（`card-frame`）と Payment Element の iframe | CDE のアカウント（[card-vault.md](card-vault.md) の 2 節） | CDE |
| `vault.<domain>`・`vault-test.<domain>` | カード番号を受け取り、使い捨ての `card_input` を返す API（live は cde-live、テスト環境は cde-test） | CDE のアカウント（[card-vault.md](card-vault.md)） | CDE |
| `hooks.<domain>` | 3D セキュアの認証画面を入れる中継の iframe と、認証後の戻り先 | CDE のアカウント（js と同じ配信） | CDE に影響しうるシステム |
| `checkout.<domain>` | ホスト型の決済ページ（`hosted_page`）と、埋め込み型の決済ページ（`embedded_page`） | 本体のアカウントの S3＋CloudFront | CDE に影響しうるシステム（4.3 節の統制を当てる） |
| `payments.<domain>` | コンビニ払いの払込票、銀行振込の振込先の案内（ホスト型） | 本体のアカウント | 範囲外（カード情報を扱わない） |
| `api.<domain>` | 公開 API（Checkout Session、PaymentIntent の確定など） | 本体 | 範囲外 |

- **loader を CDE の側に置く理由**：loader は加盟店のページに iframe を差し込む。loader が改ざんされると、本物の iframe の代わりに偽の入力欄を加盟店のページに出し、カード番号を盗める。loader の変更は、CDE と同じ変更管理（二者のレビュー、署名付きのビルド、デプロイの承認）で守る。
- ホスト型の決済ページ（`checkout.<domain>`）は本体に置き、カード入力の部分だけを `elements.<domain>` の iframe で埋め込む。決済ページ全体を CDE に入れると、CDE の変更の頻度と範囲が大きくなるため。代わりに、決済ページを「CDE に影響しうるシステム」として扱い、スクリプトの管理と改ざんの検知（4.3 節）を当てる（ADR-0027）。

## 3. 組み込みの種類

本家の Checkout Session の `ui_mode` と、単独の Payment Element に合わせる（[Checkout Session object](https://docs.stripe.com/api/checkout/sessions/object)）。

| 種類 | 本家での名前 | MVP | 加盟店の作業 |
| --- | --- | --- | --- |
| ホスト型の決済ページ | `ui_mode: hosted_page` | 作る | サーバーで Session を作り、`url` へ顧客をリダイレクトする |
| 埋め込み型の決済ページ | `ui_mode: embedded_page` | 作る | サーバーで Session を作り、`client_secret` を loader に渡して自分のページに埋め込む |
| Payment Element（単独） | Elements ＋ PaymentIntent | 作る | サーバーで PaymentIntent を作り、`client_secret` で Payment Element を出し、確定を呼ぶ |
| Checkout の Elements・フォーム | `ui_mode: elements` / `form` | 作らない | MVP の後に検討 |
| Express Checkout Element（ウォレット）、Link、Address Element | — | 作らない | Apple Pay・Google Pay は [payment-methods.md](payment-methods.md) の範囲が決まってから |

### 3.1 Checkout Session

- `mode` は `payment` と `setup`。`subscription` は Billing が MVP の外なので作らない（[intent.md](../intent.md) の Non-goals）。
- 有効期間は既定で 24 時間。`expires_at` で作成から 30 分〜24 時間の間に設定できる。API で即座に期限切れにもできる（本家と同じ。[Checkout の仕組み](https://docs.stripe.com/payments/checkout/how-checkout-works)）。
- `status` は `open` / `complete` / `expired`、`payment_status` は `paid` / `unpaid` / `no_payment_required`（本家と同じ）。
- コンビニ払い・銀行振込は、顧客が手順を受け取った時点で `status: complete`、`payment_status: unpaid` になり、入金で `checkout.session.async_payment_succeeded`、期限切れで `checkout.session.async_payment_failed` を出す。
- Session の PaymentIntent は、加盟店が直接確定・取り消しできない。取り消すときは Session を期限切れにする（本家と同じ）。
- 決済手段は、ダッシュボードの設定で有効にしたもの（カード、コンビニ払い、銀行振込）から、通貨・金額・顧客の有無で絞って出す。銀行振込は Session に `customer` が要る（本家と同じ。[銀行振込](https://docs.stripe.com/payments/bank-transfers)）。

### 3.2 全体の流れ（ホスト型、カード）

```
加盟店のサーバー ─ POST /v1/checkout/sessions（秘密キー）─▶ api  → { url: https://checkout.<domain>/c/pay/cs_... }
顧客のブラウザ ─ リダイレクト ─▶ checkout.<domain>（本体）
  │ Session の表示用の情報を api から取る（Session の秘密の断片で認可）
  │ ┌──── iframe: elements.<domain>/card-frame（CDE）──────────┐
  │ │ カード番号・有効期限・CVC を入力                           │
  │ │ POST vault.<domain>/v1/card_inputs ──▶ vault-ingest（CDE） │→ { card_input }
  │ │ POST api.<domain>/v1/payment_methods（card_input）         │
  │ │   api が PrivateLink で vault-core に紐づけて pm_ を作る    │→ { id: "pm_..." }
  │ └──────────────────────────────────────────────────┘
  │ 支払うボタン ─▶ api：pm_ で PaymentIntent を確定
  │ next_action があれば 3D セキュア（6 節）
  ▼
success_url へ戻す ／ 加盟店のサーバーには checkout.session.completed の Webhook
```

- トークン化の詳細（`card_input` と `pm_` の紐づけ、CVC の一時保管（最初のオーソリまで、最大 30 分）、失敗時の扱い）は [card-vault.md](card-vault.md) の 3.1 節にある。
- 本体が受け取るのは、`pm_` と表示用の情報（ブランド、下 4 桁、有効期限、funding、発行国、指紋）だけ。

### 3.3 Payment Element（単独）

- 加盟店のページで `loader.elements({ clientSecret })` から Payment Element を作り、`confirmPayment({ elements, confirmParams: { return_url } })` で確定する（本家の Stripe.js の形に合わせる）。
- Payment Element は 1 つの iframe（`elements.<domain>`）で、カード・コンビニ払い・銀行振込のタブを持つ。カードの入力欄は、その iframe の中にある。
- 確定の要求（PaymentIntent の `confirm`）は、iframe の中から公開キーと `client_secret` で `api.<domain>` へ送る。加盟店のページの JavaScript には、カード番号を渡さない。加盟店が受け取るのは、確定の結果（PaymentIntent の状態とエラー）と、必要なら `pm_`（本家の `createPaymentMethod` に相当）だけ。

## 4. ブラウザでの防御

### 4.1 loader と iframe の間の通信

- loader と iframe は `postMessage` でやり取りする。最初に `MessageChannel` のポートを渡し、以降はそのポートだけを使う。
- 受け手は、送り手のオリジンを必ず検査する。iframe は、loader からの最初のメッセージのオリジンを記録し、以降それ以外を無視する。loader は `elements.<domain>` 以外からのメッセージを無視する。
- メッセージは Zod のスキーマ（`packages/contract`）で検証する。カード番号・CVC を含むメッセージの種類は、定義しない（型で作れないようにする）。
- loader が加盟店に渡すイベント（`change`、`ready`、`focus` など）は、入力の完全さ・ブランド・エラーの種類だけを含む。本家の Element の `change` イベントと同じ粒度にする。

### 4.2 CSP と埋め込みの制限

| ページ | CSP の要点 | `frame-ancestors` |
| --- | --- | --- |
| `card-frame`・Payment Element（`elements.<domain>`） | `default-src 'none'`、`script-src 'self'`、`style-src 'self'`、`connect-src https://vault.<domain> https://vault-test.<domain> https://api.<domain>`、`frame-src https://hooks.<domain>`、`require-trusted-types-for 'script'` | `*`（どの加盟店のページにも埋め込めるようにする） |
| ホスト型の決済ページ（`checkout.<domain>`） | `default-src 'none'`、`script-src 'self'`（インラインなし、SRI 付き）、`frame-src https://elements.<domain> https://hooks.<domain>`、`connect-src https://api.<domain>`、Trusted Types | `'none'` |
| 埋め込み型の決済ページ（`checkout.<domain>/embedded/...`） | 同上 | Session の `return_url` のオリジンだけ |
| 3D セキュアの中継（`hooks.<domain>`） | 下の 6 節 | `https://elements.<domain> https://checkout.<domain>` と加盟店のオリジン（`return_url` のオリジン） |

- **クリックジャッキング**：支払うボタンを持つページ（ホスト型・埋め込み型の決済ページ）は、埋め込み先を限る。埋め込み型は、加盟店が Session の作成時に渡す `return_url` のオリジンにだけ埋め込みを許す。本家が埋め込み型の Checkout の埋め込み先をどう限っているかは未検証。
- カード入力の iframe はどこにでも埋め込めるが、支払うボタンを持たない（ボタンは加盟店のページの側にある）。入力欄を隠して誤入力させる攻撃の効果は小さいので、埋め込み先を限らない（本家の Elements と同じく、どのサイトにも置ける前提）。
- すべてのページで `X-Content-Type-Options: nosniff`、`Referrer-Policy: strict-origin-when-cross-origin`、HSTS（preload）を付ける。
- 本家は、加盟店のページの CSP に `js.stripe.com`・`*.js.stripe.com`・`hooks.stripe.com`・`api.stripe.com` などを許可するよう案内している（[セキュリティガイドの CSP](https://docs.stripe.com/security/guide#content-security-policy)）。同じ形の一覧（`js.<domain>`、`elements.<domain>`、`hooks.<domain>`、`api.<domain>`、`checkout.<domain>`）を文書にする。Trusted Types を使う加盟店向けの既定のポリシーの例も載せる（本家と同じ）。

### 4.3 決済ページのスクリプトの管理（PCI DSS v4.0.1 の 6.4.3・11.6.1）

本システムはサービスプロバイダーとして、自分たちの決済ページ（`checkout.<domain>`、`js.<domain>`、`elements.<domain>`、`hooks.<domain>`）に次を当てる。

- **スクリプトの目録と承認（6.4.3）**：ページが読み込むスクリプトは、ビルドが出す目録（パスと SHA-384）だけ。目録はリリースごとにレビューで承認する。HTML の `<script>` には SRI を付ける。
- **改ざんの検知（11.6.1）**：合成監視が、1 時間ごとに本番のページを実ブラウザで開き、読み込まれたスクリプトのハッシュと、CSP などのセキュリティのヘッダーを目録と比べる。違えば SEV1 のアラートにする。PCI DSS は少なくとも週 1 回を求めるが、それより短くする。
- **CSP の違反の報告**：`report-to` で違反を集め、想定外のスクリプトの読み込みを検知する。
- 手順と監視の定義は [security.md](security.md) と [observability.md](observability.md) に置く。

## 5. 加盟店の PCI（SAQ A）

- 加盟店が次の条件を満たせば、SAQ A の対象になる設計にする。本家の Checkout と Elements も、カード入力をすべて Stripe のドメインの iframe に置くことで SAQ A の対象にしている（[PCI DSS 準拠ガイド](https://stripe.com/guides/pci-compliance)）。
  - ホスト型・埋め込み型の決済ページ、または Payment Element を使う。
  - loader を `https://js.<domain>` から直接読み込む。バンドルしたり、自分で配信したりしない（本家も同じ。[Including Stripe.js](https://docs.stripe.com/js/including)）。npm のパッケージは、`js.<domain>` から読み込むための薄い包みだけにする（本家の `@stripe/stripe-js` と同じ）。
- PCI SSC は 2025 年 1 月の SAQ A の改訂で、6.4.3・11.6.1・12.3.1 を SAQ A から外し、代わりに「加盟店のサイトが、電子商取引のシステムに影響しうるスクリプトの攻撃を受けにくいことを確認する」という適格の条件を加えた（2025-03-31 に旧バージョンが廃止。[PCI SSC のブログ](https://blog.pcisecuritystandards.org/important-updates-announced-for-merchants-validating-to-self-assessment-questionnaire-a)、2026-09-27 に確認）。埋め込み型・Payment Element を使う加盟店には、この条件を満たすための案内（自分のページの CSP、第三者のスクリプトの管理）を文書にする。ホスト型へリダイレクトする加盟店は、この点の負担が最も小さいことも示す。
- 加盟店に年次の PCI の自己評価を求める画面（ダッシュボードの「コンプライアンス」）は、[dashboard.md](dashboard.md) と [merchant-onboarding.md](merchant-onboarding.md) で扱う。本家もダッシュボードで書類の要件を示している（[セキュリティガイド](https://docs.stripe.com/security/guide)）。
- 本システム自身は、PCI DSS v4.0.1 のサービスプロバイダー レベル 1 の要件を満たす設計にする（NFR-010）。

## 6. 3D セキュア

3D セキュアの要否の判断と 3DS サーバーとの接続は [payments.md](payments.md) と [fraud.md](fraud.md) にある。ここでは画面での扱いを決める。

- PaymentIntent が `requires_action` になり `next_action` が 3D セキュアを示したら、loader（または決済ページ）がモーダルを出し、その中に `hooks.<domain>` の中継の iframe を置く。中継の iframe が、カード会社の認証画面（ACS）へ遷移する。本家も `hooks.stripe.com` を経由して認証画面を出している（[3D セキュアの認証フロー](https://docs.stripe.com/payments/3d-secure/authentication-flow)）。
- 3DS2 の端末情報の収集（3DS Method）は、見えない iframe で `hooks.<domain>` から行う。
- 認証画面の大きさは、3DS2 でカード会社が対応する 250×400、390×400、500×600、600×400、全画面のどれかにする（本家の文書の値）。スマートフォンの幅では全画面にする。
- 認証画面の iframe に `sandbox` 属性を付けない。カード会社の実装によっては失敗するため（本家の注意）。
- 認証が終わると、ACS は `hooks.<domain>/3ds/complete` に戻る。このページは親へ `postMessage` で完了を知らせる（宛先のオリジンを指定する）。loader は PaymentIntent を取り直し、状態（`succeeded` / `requires_capture` / `requires_payment_method`）で結果を出す。
- 加盟店が `redirect: 'always'` を選んだとき、またはポップアップの中の表示ができないときは、`return_url` を使ったリダイレクトの流れにする。戻り先には `payment_intent` と `payment_intent_client_secret` のクエリを付ける（本家と同じ）。
- 認証の画面の見た目は、カード会社が決めるので変えられない（本家と同じ）。モーダルの枠・閉じるボタン・「カード会社の画面です」の説明だけを、本システムが出す。
- テスト環境では、模擬の ACS の画面（「認証する」「失敗させる」）を出す。3D セキュアを必須にするテストカード（例：`4000000000003220`）は本家と同じ番号にする（[3D セキュアの認証フロー](https://docs.stripe.com/payments/3d-secure/authentication-flow) の「3DS フローをテストする」）。

## 7. 日本の決済手段の画面

決済手段そのものの設計（コネクタ、入金の照合）は [payment-methods.md](payment-methods.md) にある。画面は本家の振る舞いに合わせる。

### 7.1 コンビニ払い

本家の値（[コンビニ決済](https://docs.stripe.com/payments/konbini)、[コンビニ決済の受け付け](https://docs.stripe.com/payments/konbini/accept-a-payment?payment-ui=direct-api)）。

| 項目 | 値 |
| --- | --- |
| 通貨・金額 | JPY、120 円〜300,000 円 |
| 入力 | 氏名（店頭の表示と領収書で 20 文字に切り詰める。Shift_JIS（JIS X 0208）にない文字は削る・置き換える）、メールアドレス、確認番号（電話番号を勧める。10〜11 桁、0 だけは不可） |
| 支払期限 | 既定は確定から 3 日後の 23:59:59（日本時間）。`expires_after_days` で 1〜60 日。`expires_at` は 30 分後〜60 日以内 |
| 商品の表記 | 最大 22 文字、Shift_JIS の範囲 |
| 対象の店舗 | ファミリーマート、ローソン、ミニストップ、セイコーマート |

- 確定すると PaymentIntent は `requires_action` になり、`next_action.konbini_display_details` に、店舗ごとの支払い番号・確認番号・期限と、ホスト型の払込票の URL（`payments.<domain>/konbini/voucher/...`）が入る。
- loader・決済ページは、確定の後に払込票のモーダルを出す。中身は：金額、商品の表記、期限（日時と「あと○日」）、店舗ごとの支払い番号と確認番号（コピーのボタン付き）、店頭での手順、印刷のボタン。ホスト型の払込票のページも同じ中身にする。
- 確認番号の入力欄は、全角の数字・ハイフンを受け付けて、半角の数字に直す。
- 期限の案内：期限の前でも、店頭の端末で手続きを始めた後は、期限を少し過ぎてもレジで支払えることがある（本家の説明）。画面では期限を強調し、期限後の扱いは文書に書く。
- 手順のメールと、期限までのリマインドのメール（1 日 1 回まで）は、加盟店がダッシュボードで有効にしたときだけ送る（本家と同じ）。提供は S2（[payment-methods.md](payment-methods.md) の段階）。MVP では払込票のモーダルとホスト型のページだけで案内する。
- 払込票のページは、`hosted_voucher_url` の推測できない ID で開く。ページに顧客のメールアドレスと電話番号は出さない。

### 7.2 銀行振込

本家の値（[銀行振込](https://docs.stripe.com/payments/bank-transfers)）。

- 顧客ごとに仮想の振込先の口座を割り当て、振込を自動で消し込む。加盟店の実際の口座は顧客に見せない。
- 確定すると、振込先の案内（銀行名・支店名・口座の種類・口座番号・口座名義（カナ）・金額・期限）と、ホスト型の案内のページの URL（`payments.<domain>/bank_transfer/instructions/...`）を返す。
- 画面では、各項目にコピーのボタンを付け、口座名義は全角カナで出す。「振込手数料は顧客の負担」「金額が違うと自動で消し込めないことがある」を案内する。
- 過不足の振込は、顧客の残高（cash balance）に入れて照合する。未照合のまま 75 日を過ぎると返金を試みる、などの扱いは本家に合わせる（詳細は [payment-methods.md](payment-methods.md)）。画面は「不足」「超過」の状態を出すだけにする。

## 8. 言語（ja / en）

- 表示の言語は、Session・Element の `locale`（`auto` / `ja` / `en`）で決める。`auto` はブラウザの言語。本家の `locale` は 40 以上の言語を持つが、MVP は `ja` と `en` だけにし、それ以外は `en` にする。
- 文言は ICU MessageFormat で書き、FormatJS で表示する（Slack の [client.md](../../../slack/docs/architecture/client.md) の 9 節と同じ）。CI で ja と en のキーの一致を検査する。
- 金額は `Intl.NumberFormat` で、通貨ごとの小数の桁（JPY は 0 桁）に従う。金額は `packages/money` の型から整形し、`number` の計算をしない（[ADR-0001](../decisions/0001-platform-and-stack.md)）。
- 日時は日本時間（`Asia/Tokyo`）を既定にする。コンビニ払いの期限は常に日本時間で出す。
- カードの名義・氏名の入力は、全角・半角の揺れを受け付け、送る前に正規化する。IME の変換中の Enter で確定しない。

## 9. アクセシビリティ（WCAG 2.2 AA）

- 各入力欄に見えるラベルと `autocomplete`（`cc-number`、`cc-exp`、`cc-csc`、`cc-name`、`email`、`tel`）を付ける。ブラウザの自動入力が iframe の中でも効くようにする。
- エラーは、欄の近くの文言と `aria-describedby` で示し、`aria-live="polite"` で読み上げる。色だけで誤りを示さない。
- loader は、iframe に `title`（例：「カード番号の入力欄」）を付け、Tab キーで加盟店のページの欄から iframe の中の欄へ、自然な順で移れるようにする（iframe の境界でフォーカスを受け渡す）。
- 3D セキュアと払込票のモーダルは、開いている間フォーカスを閉じ込め、`Esc` で閉じられる（決済が進行中のときは確認を出す）。
- Session の期限が近いとき（残り 5 分）に知らせ、延ばせない理由を示す（2.2.1）。
- 押せる対象は 24×24 CSS px 以上、400% の拡大で横スクロールが出ない。
- 検査は `@axe-core/playwright` で違反 0 件、VoiceOver と NVDA で決済を最後まで通せることをリリース前に確かめる。

## 10. 見た目の変更の範囲

| 変えられるもの | 手段 | 本家 |
| --- | --- | --- |
| ロゴ・アイコン・ブランドの色・アクセントの色 | ダッシュボードのブランドの設定（決済ページ、払込票） | 同じ（[Checkout のカスタマイズ](https://docs.stripe.com/payments/checkout/customization)） |
| 角丸・余白・文字の大きさ・色 | Payment Element の `appearance`（テーマと変数） | 本家の Appearance API に相当 |
| 書体 | 用意した書体の一覧から選ぶ | 本家は加盟店の CSS の URL も受け付ける |
| 送信ボタンの文言 | `submit_type`（`auto` / `pay` / `book` / `donate`） | 同じ |

- **変えられないもの**：任意の CSS・JavaScript・HTML の差し込み、カード入力欄の並びと文言、3D セキュアの画面、テスト環境の表示。
- 書体を一覧に限る理由：加盟店が指定する任意の URL の CSS を、CDE の側の iframe に読み込ませると、`connect-src`・`font-src` を広げることになり、CDE の iframe の攻撃面が増えるため。本家との違いとして文書に書く。
- 独自ドメイン（本家のカスタムドメイン）は MVP では作らない。

## 11. テスト環境

- 公開キーが `<brand>_pk_test_` のとき、iframe と決済ページに「テスト環境」の帯を出し、消せないようにする。
- テストカードの番号（成功、拒否、3D セキュア必須など）は本家と同じ番号にする（[テスト](https://docs.stripe.com/testing)）。テスト環境の Vault は、テストカードの番号以外を拒否する。本物のカード番号をテスト環境で受け付けない（[ADR-0005](../decisions/0005-pci-scope-segmentation.md)）。
- コンビニ払いは、本家と同じく、メールアドレスと確認番号の特別な値で、3 分後の成功・即時の成功・即時の期限切れなどを再現できるようにする。

## 12. 不正と濫用

- カードの番号を大量に試す攻撃（カードテスティング）に備え、トークン化（`card_inputs`）と PaymentIntent の確定に、公開キーごと・IP ごと・Session ごとの速度の上限を置き、急増時は WAF の Challenge を掛ける（[card-vault.md](card-vault.md) の 3.1 節、[fraud.md](fraud.md)、[rate-limiting.md](rate-limiting.md)）。
- 本家の Checkout は CAPTCHA を組み込んでいる（[Checkout の仕組み](https://docs.stripe.com/payments/checkout/how-checkout-works)）。第三者の CAPTCHA のスクリプトを決済ページに入れると 1 節の原則に反するので、MVP では入れない。リスクの高い要求に対する追加の確認は [fraud.md](fraud.md) で決める（16 節の問い）。
- loader は、不正検知のための端末の信号（画面の大きさ、タイムゾーン、入力の速さ）を、[fraud.md](fraud.md) で決めた範囲だけ集める。本家は、Stripe.js をすべてのページで読み込むと不正検知に役立つとしているが、本システムは決済の画面でだけ集める。集める項目はプライバシーポリシーで公表する。

## 13. 性能と可用性

| 項目 | 目標 |
| --- | --- |
| loader の大きさ | 30 KB 以内（gzip） |
| Payment Element の iframe の初回の表示（`ready`） | p75 1.5 秒以内（中位の Android、4G 相当） |
| ホスト型の決済ページの LCP | p75 2.5 秒以内 |
| トークン化の API（vault） | p99 300 ms 以内 |
| 支払うボタンから結果の表示まで（3D セキュアなし、コネクタの待ちを除く） | p95 1 秒以内 |

- loader の URL はバージョン付き（例：`js.<domain>/v1/loader.js`）にし、同じバージョンの中は後方互換を保つ。本家も Stripe.js の URL にバージョンを持つ（[Including Stripe.js](https://docs.stripe.com/js/including)）。
- 決済ページの静的なファイルは CloudFront から配り、API が落ちているときは「いまは支払えません」を出す（支払ったかどうか不明の状態を作らない）。確定の要求は冪等キーを付けて送り、応答を受け取れなかったときは PaymentIntent を取り直してから次の手を決める（[ADR-0004](../decisions/0004-idempotency.md)）。

## 14. 未検証の事項と確かめ方

2026-09-27 に本家の文書（[セキュリティガイド](https://docs.stripe.com/security/guide)、[PCI DSS 準拠ガイド](https://stripe.com/guides/pci-compliance)）を再確認したが、次の事項は記述がなく、観察でしか確かめられない。

| 事項 | 確かめ方 |
| --- | --- |
| 本家の埋め込み型の Checkout が、埋め込み先のオリジンをどう限っているか | テスト環境で埋め込み型の Session を作り、応答の `Content-Security-Policy` の `frame-ancestors` を見る |
| 本家の Payment Element の iframe の CSP と `frame-ancestors` | `js.stripe.com` の iframe の応答ヘッダーを確かめる |
| 本家が埋め込み型・Elements の加盟店に SAQ A の新しい適格の条件をどう案内しているか | Stripe の PCI の文書とダッシュボードのコンプライアンスの画面を確かめる |

## 15. データモデル

| テーブル | 主な列 | 備考 |
| --- | --- | --- |
| `checkout_sessions` | `account_id`、`id`、`mode`、`ui_mode`、`status`、`payment_status`、`payment_intent_id`、`setup_intent_id`、`customer_id`、`line_items`、`amount_total`、`currency`、`locale`、`success_url`、`cancel_url`、`return_url`、`expires_at`、`client_secret_hash` | RLS。期限切れはジョブで `expired` にし、`checkout.session.expired` を出す |
| `checkout_branding` | `account_id`、`logo_file_id`、`icon_file_id`、`brand_color`、`accent_color`、`font`、`shape` | 環境ごと |
| `konbini_vouchers` | `account_id`、`payment_intent_id`、`voucher_token_hash`、`confirmation_number`、`store_codes`、`expires_at`、`status` | 払込票のページの ID と、店舗ごとの支払い番号（この表に置く） |

列・索引の正本は [data-model/checkout.md](data-model/checkout.md)。

## 16. 決定と持ち越し（2026-09-26、既定案）

- **カードテスティングへの追加の確認**：MVP では CAPTCHA に相当する画面の部品を作らない。`card_inputs` と確定の速度の上限、WAF の Challenge（`vault.<domain>`・`checkout.<domain>`）、急増時のプラットフォームのルール（その加盟店の on-session の全件で 3DS を要求）で守る（[fraud.md](fraud.md) の 7 節）。Challenge で足りないことが運用で分かったら、自前の確認を E9 で作る。
- **Express Checkout Element（Apple Pay・Google Pay）**：MVP の後の候補にする（[roadmap.md](../roadmap.md) の「後回しにしたもの」）。
- **`ja`・`en` 以外の言語**：MVP の後の候補にする。

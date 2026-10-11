# Design log: Stripe

設計の工程ごとに決めたことの記録。今の結論は [README.md](README.md) と各領域の文書と ADR にあり、ここはその経緯を残す。新しい記録は末尾に足す。

記録は README.md から本文のまま移したもので、本文の中の「1.4 節」「6 節」などの節の番号は、[README.md](README.md) の節を指す。

## 2026-09-26：既定案

PM の方針（本家 Stripe に寄せる、既定案）により、次のとおり決めた。法務の判断が要るものは決めず、[intent.md](../intent.md) の「法務の確認待ち」に集めた。計測・PoC・接続先の選定で決めるものは、下の「持ち越し」に置いた。

- **本家の名前・接頭辞を使わない**（リポジトリ共通の ADR-0006）。見出しは `<Brand>-Version`・`<Brand>-Should-Retry`・`<Brand>-Rate-Limited-Reason`・`<Brand>-Signature`。API キーは `<brand>_{pk|sk|rk}_{live|test}_`、Webhook の署名の秘密は `<brand>_whsec_`。ドメインは `api.<domain>`・`js.<domain>` など。オブジェクトの ID の接頭辞（`pi_`、`cus_`、`du_` など）は秘密ではないので本家に合わせる。ADR-0002・0006・0008・0025 の表記を改めた。
- **Dispute の ID は `du_`**、手数料は 1 件 1,500 円（本家の日本と同じ。[Stripe 料金](https://stripe.com/jp/pricing)）。
- **残高が足りないときの返金は本家に合わせる。** 利用可能な残高から引き、足りなければカードの返金は残高が足りるまで保留（最長 30 日、過ぎたら `insufficient_funds` で失敗）、他の決済手段の返金は失敗にする（[支払いの返金とキャンセル](https://docs.stripe.com/refunds)）。Dispute の引き落としはマイナスを許す。[payments.md](payments.md) の 10.2 節、[ledger.md](ledger.md)、ADR-0016 を揃えた。コンビニ・銀行振込の返金のために `refunds_payable` の口座を足した。
- **CDE の構成は ADR-0029 を正とする。** アカウントは cde-live・cde-test（ほかに cde-nonprod、cde-shared）。本体 → CDE は PrivateLink、CDE → 本体は SQS（`connector-results`）だけ。PaymentMethod の作成は「ブラウザ → vault-ingest（使い捨ての `card_input`）→ 本体の API → vault-core の紐づけ」の向きにし、CDE から本体を呼ばない。境界を越える識別子は `pm_` だけ（紐づけの 1 回だけ `card_input`）。[card-vault.md](card-vault.md)、[security.md](security.md)、[infrastructure.md](infrastructure.md)、[checkout.md](checkout.md)、ADR-0027 を揃えた。
- **Webhook の送信元の IP** は、専用の egress VPC の Elastic IP 付き NAT から出し、東京 3 個・大阪 3 個を最初から公開する（ADR-0025）。
- **数値の正本**：レート制限は [rate-limiting.md](rate-limiting.md) の 4 節（エッジの IP は api 5 分に 30,000、Vault・Checkout 5 分に 1,000）。Webhook の送信のタイムアウト（接続 5 秒・全体 15 秒）と送信先ごとの同時実行（10）は [events-and-webhooks.md](events-and-webhooks.md)。`lock_timeout` は 2 秒。冪等キーのパーティションは 48 時間で `DROP`。保持期間は [security.md](security.md) の 13 節。SLO は [runbooks/README.md](../runbooks/README.md) の 1 節。
- **監査の記録**：`security_events` は `audit_events` の一部として扱い、DB に 1 年、アーカイブに 7 年（ADR-0023）。
- **API のバージョン**：上げたバージョンを戻せる期間は 72 時間（本システムの決定）。`.preview` のバージョンは持たない（[api.md](api.md) の 15 節）。
- **その他の既定案**：要求のログは本文を持たずメタデータを 30 日。ダッシュボードのセッションはアイドル 12 時間・絶対 7 日。独自のロールは持たない。レビュー中の決済の入金は止めない。Checkout に CAPTCHA 相当の部品を作らず WAF の Challenge とルールで守る。`fingerprint` は加盟店ごと。銀行振込の PaymentIntent は自動で失効させない。ダッシュボードのホームは日次の集計の表から出す。`Retry-After` を 429 に付ける。
- 領域ごとの決定は、各文書の「決定と持ち越し」の節にある：[api.md](api.md)、[auth-and-keys.md](auth-and-keys.md)、[payments.md](payments.md)、[payment-methods.md](payment-methods.md)、[events-and-webhooks.md](events-and-webhooks.md)、[checkout.md](checkout.md)、[dashboard.md](dashboard.md)、[fraud.md](fraud.md)、[rate-limiting.md](rate-limiting.md)、[card-vault.md](card-vault.md)、[security.md](security.md)。

持ち越し（計測・PoC・接続先の選定で決めるもの）：

| 項目 | いつ・どう決めるか |
| --- | --- |
| 最初のカードのコネクタ（30 日のオーソリ、3DS Server と iframe、照会 API と整合性の時間、重複の扱い、TR-31 の要否、精算のサイクル、Dispute の通知の手段） | E3 の着手前に選ぶ。ADR-0011・0012・0030 の前提を確かめる |
| コンビニ収納代行（速報・確報、取り消し） | E8 の着手前に選ぶ |
| 提携銀行（振込の API の件数・締め・重複の識別子・名義照会、バーチャル口座の数と費用、口座振替での回収） | E4（入金）・E8（銀行振込）の着手前に選ぶ。法務の確認の結果にも依る |
| 外部の不正検知サービス、eKYC・反社・制裁の照合の提供者 | E9、E2 で選ぶ |
| 同時実行の上限、スロットの数、KMS の上限、コネクタの応答時間の実測 | E10 の負荷試験（k6） |
| QSA の選定、PrivateLink・指紋の扱い、附属書 A1 | E10 の QSA の事前相談 |
| JIT の仕組み（AWS TEAM など） | E10 の PoC（ADR-0020） |
| 検索 API の索引、読み取りの割当を止めるか | E11 の PoC と計測 |
| 本家の振る舞いで未確認のもの（手数料の丸め、`cancellation_reason`、アクセスポリシーの `code`、Webhook の自動の無効化の条件など） | 各文書の「持ち越し」に書いた Epic の Story で、本家のサンドボックスを観察して揃える |

## 2026-09-28：推奨案で確定

PM の方針（判断が要るところは推奨案でよい）により、法務以外の残りを次のとおり決めた。法務の確認待ち（L1〜L8）と、それに依るものは決めていない。接続先の選定、PoC、計測の項目は、上の「持ち越し」に残した。

- **3D セキュアの範囲は ADR-0012 のまま**（日本で発行されたカードの CIT では常に要求）。ガイドライン 6.1 版の都度の認証の原則に沿い、MVP はリスクの判断を持たないため。本家との違いは記録に残した（[ADR-0012](../decisions/0012-3ds-via-connector.md) の 2026-09-28 の注記、[fraud.md](fraud.md) の 5 節）。
- **決済の経路のレート制限は、全体の枠だけのまま**。正当な決済を断らないことを優先するため（[ADR-0009](../decisions/0009-rate-limiting.md)、[rate-limiting.md](rate-limiting.md) の 4.2 節）。
- **Aurora DSQL を S3 の候補から外し、ADR-0031 を accepted にした**。トリガーと RLS がなく、台帳の制約とテナントの分離が DB で守れないため（[ADR-0031](../decisions/0031-active-active-cells.md)、[infrastructure.md](infrastructure.md) の 10 節）。
- **境界を越える値の例外は `card_input` の 1 つだけとし、承認した**。カード会員データを含まず、使い捨てで 30 分で失効するため（[ADR-0029](../decisions/0029-multi-account-and-cde-layout.md) の注記、[card-vault.md](card-vault.md) の 2 節）。
- **DEK のキャッシュは AWS Encryption SDK の caching CMM で行う**。5 分のキャッシュをそのまま表せ、CDE に DynamoDB を足さずに済むため（[ADR-0019](../decisions/0019-vault-encryption-and-key-hierarchy.md) の 2026-09-28 の注記）。
- **結果不明を起こすテスト用のカード番号は、`4000000000` で始まり本家の表にない番号から選ぶ**。本家の番号との衝突を CI で防げるため（[payment-methods.md](payment-methods.md) の 4・8 節）。
- **会計への出力は、MVP では仕訳の CSV を経理が取り込む形にする**。会計システムを選ぶ前に始められるため（[payouts-and-reconciliation.md](payouts-and-reconciliation.md) の 7 節）。勘定科目の名前は法務・経理の確認待ちのまま。
- **ダッシュボードのセッションの長さは、本システムの値（アイドル 12 時間・絶対 7 日）で確定した**。本家の値が公開されていないため（[auth-and-keys.md](auth-and-keys.md) の 3.3 節）。
- **接続先の選定の条件と、比べる候補の絞り方を決めた**。コネクタ、収納代行、提携銀行、eKYC、不正検知、QSA を、各 Epic の Story で同じ物差しで選ぶため。どの会社にするかは選ばない（[intent.md](../intent.md) の「接続先の選定（法務以外）」）。QSA の最初の審査は、本番の加盟店を受け入れる前に受ける（[security.md](security.md) の 16 節）。
- **本家の実装を核に使っていないことを確かめた**（リポジトリ共通の [ADR-0007](../../../../docs/decisions/0007-no-reuse-of-original-implementation.md)）。本家の `stripe-node` は、Webhook の署名の互換を確かめるテストの道具としてだけ使い、製品のコードには入れない（[ADR-0025](../decisions/0025-webhook-signing-and-isolated-delivery.md) の 2026-09-28 の注記）。

## 2026-09-28：データモデル

データモデルを [data-model.md](data-model.md) と [data-model/](data-model/) にまとめ、列・制約・索引の正本にした（領域の文書は振る舞いの正本）。その際、文書の間の食い違いと抜けを、推奨案で次のとおり決めた。

- **パーティションをまたぐ一意**：PostgreSQL はパーティションの鍵を含まない一意を張れない。`idempotency_keys`・`connector_inbox`・`bank_statement_lines` は、`pg_advisory_xact_lock` で直列にし、直近のパーティションを確かめてから挿入する。`events` は日付の列 `created_on` をパーティションの鍵にし、同じ日の中で `(account_id, idempotency_source, created_on)` を一意にする（主な守りは遷移関数の冪等）。`webhook_deliveries` は `event_created_on` を鍵に含めて一意にする。[api.md](api.md)・[events-and-webhooks.md](events-and-webhooks.md) を揃えた。
- **`livemode` の列を持たない**（Vault DB を含む）。[payment-methods.md](payment-methods.md)・[card-vault.md](card-vault.md) を揃えた。
- **DEK の表（`vault_deks`）を持たない。** DEK は AWS Encryption SDK のメッセージに包んだ形で入る（ADR-0019 の注記）。漏洩の疑いの対象は `edk_hash`・`cmk_key_id` で探す。
- **内部向けの指紋を本体に置く。** 紐づけの応答で返し、`payment_methods.fingerprint_internal` に持つ。プラットフォームの不正検知だけが使い、加盟店に出さない（[ADR-0019](../decisions/0019-vault-encryption-and-key-hierarchy.md) の 2026-09-28 の注記）。QSA の確認の対象に含める。
- **公開可能キーの写しを CDE に置く**（`vault_publishable_keys`、本体 → CDE の `sync_publishable_key`）。vault-ingest が加盟店向けの指紋を計算するのに加盟店が要るため。あわせて、保存の状態を CDE に伝える `set_card_attached` を足した（保持の期限の計算に要る）。どちらも本体 → CDE の向きで、境界を越える識別子は変えない。[card-vault.md](card-vault.md) を揃えた。
- **`security_events` は `audit_events` の `category = 'security'` の行**（ビュー）にする。[auth-and-keys.md](auth-and-keys.md)・[dashboard.md](dashboard.md) を揃えた。
- **プラットフォームの行はテナントテーブルに入れない。** 不正検知のルール・リストは `platform_fraud_rules`・`platform_fraud_list_items`、入金・照合の加盟店をまたぐ表は RLS の例外にする。RLS の例外の一覧の正本は [data-model.md](data-model.md) の 3.3 節。[fraud.md](fraud.md)・[payouts-and-reconciliation.md](payouts-and-reconciliation.md)・[security.md](security.md) を揃えた。
- **テナントをまたぐ探索**は、`SECURITY DEFINER` の解決の関数と、読み取りだけの `sweeper` ロールで行う（[data-model.md](data-model.md) の 3.2・3.3 節）。
- **足りなかった表を最小で定義した**：`connector_routes`、`refund_bank_details`、`vault_publishable_keys`、`vault_bin_ranges`、`vault_test_cards`、`platform_fraud_list_items`。口座番号の列の暗号化に KMS の `bank-accounts` を足した（[security.md](security.md) の 5 節）。

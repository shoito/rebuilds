# Roadmap: Stripe

## 進め方の原則

- **最初に walking skeleton を通す。** E1 で、テスト環境のアカウント・API キー・PaymentIntent・模擬のアクワイアラ・台帳の仕訳・Event を端から端まで貫いてから、機能を広げる。お金の正しさ（台帳の制約と性質ベーステスト）と CDE の境界は、E1 から本物の形で作る。後から足すと直せないため。
- **契約を先に固定する。** 公開 API の形・ID・エラー・バージョン（[ADR-0006](decisions/0006-api-shape.md)、[ADR-0007](decisions/0007-date-based-api-versions.md)）と、本体と CDE の間の API（PrivateLink の呼び出しと `connector-results` のメッセージ）は、人間がレビューして確定する。エージェントは勝手に変えない。
- **お金を動かす変更は、区分 A として扱う。** `plan.md` に影の実行の計画を書き、加盟店単位のカナリアで広げる（[ADR-0032](decisions/0032-release-safety-for-money-moving-code.md)）。
- **法務の確認待ちの Epic は、spec を承認しない。** 設計と、法務に依らない Story（基盤、模擬の接続先）は進めてよい（[intent.md](intent.md) の「法務の確認待ち」）。
- **接続先を選んでから、その接続先に依る Story に着手する。** それまでは模擬のアクワイアラ・模擬の銀行で進める。
- **1 変更 1 PR を目安に、差分を小さくする。** CDE（`cde/`）の変更と本体の変更は別の PR にする（[ADR-0033](decisions/0033-cde-pipeline-and-change-control.md)）。

## Epic

PM が持つ。変更の一覧はここに書かず、各変更の `spec.md` の frontmatter（`epic`）から集計する（[process.md](../../../docs/process.md) の「粒度」）。

| Epic | 目的 | 状態 |
| --- | --- | --- |
| E1 Walking skeleton | 開発と運用の基盤、テナント分離と台帳を含む最小のデータモデル、API キー、PaymentIntent の作成・確定（模擬のアクワイアラ）、仕訳、Event | 設計中 |
| E2 アカウントと権限（審査を含む） | ダッシュボードのログインと MFA、チームとロール、API キーの全体、本番の有効化の審査（KYC・KYB） | 未着手（審査の Story は法務の確認待ち：L2・L3・L4・L7） |
| E3 決済 | 最初のカードのコネクタ、3D セキュア、キャプチャ・取り消し・返金、結果不明の回復、基本の不正のブロック | 未着手（接続先の選定が前提） |
| E4 お金 | 残高と BalanceTransaction、手数料、利用可能への移動、リザーブ、入金、3 者照合、会計への出力 | 未着手（入金は法務の確認待ち：L1。手数料の税は L8） |
| E5 Event と Webhook | Event の API、Webhook のエンドポイント、署名、配信・再試行、egress VPC | 未着手 |
| E6 Checkout と Elements | loader・iframe（CDE）、Vault の受け取り、ホスト型・埋め込み型の決済ページ、Payment Element | 未着手 |
| E7 ダッシュボード | 決済・残高・入金・顧客・開発者の画面、レポート、ルールとレビューの画面 | 未着手 |
| E8 日本の決済手段 | コンビニ払い、銀行振込（バーチャル口座と現金残高） | 未着手（銀行振込は法務の確認待ち：L1） |
| E9 不正検知と Dispute | ルールの言語の全体、速度とリスト、外部の不正検知サービス、Dispute・照会・EFW、継続的な監視 | 未着手（外部サービスの連携は L4・L5） |
| E10 本番運用（PCI・SLO・DR） | 負荷試験、SLO とアラート、大阪のウォームスタンバイと訓練、PCI DSS の統制と証跡、QSA、runbook | 未着手（監査のアーカイブは L6） |
| E11 S2 への拡張 | 台帳のシャード、Webhook の配信の分離、2 社目のコネクタ、JPY 以外の通貨、検索 API、追加のサンドボックス、SSO | 未着手（S2 の判断の基準を満たしたら。[infrastructure.md](architecture/infrastructure.md) の 8 節） |
| E12 S3 への拡張 | セル構成と東京・大阪の active-active | 未着手 |

## Story

各 Story は、着手するときに `changes/YYMMDD-<slug>/` として起票する。ここは計画で、進み具合は各変更の `spec.md` の frontmatter で見る。順序は Epic の中での目安で、依存があるものを先に置いた。各領域の文書の「Epic との対応」から集めた。

### E1 Walking skeleton

設計：[api.md](architecture/api.md)、[data-model.md](architecture/data-model.md)、[ledger.md](architecture/ledger.md)、[card-vault.md](architecture/card-vault.md)、[infrastructure.md](architecture/infrastructure.md)、[delivery.md](architecture/delivery.md)

| Story | 内容 |
| --- | --- |
| `dev-repo-bootstrap` | Stripe の開発リポジトリを作り、`changes/`・`specs/`・開発向けの `AGENTS.md`、`cde/` の区分とルールセットを置く（リポジトリ共通の ADR-0005、ADR-0033） |
| `terraform-foundation` | Organizations、本体・log-archive・CDE（cde-shared・cde-nonprod・cde-test）のアカウント、SCP、Terraform の状態、GitHub Actions の OIDC（ADR-0029） |
| `app-infra-baseline` | prod の VPC、ECS、ALB、Aurora（live・test）、SQS、CloudFront・WAF |
| `ci-pipeline` | PR の CI（金額の型の lint、台帳・冪等の性質、PAN の形の走査、ID の追跡）、merge queue（[delivery.md](architecture/delivery.md) の 2 節） |
| `cde-pipeline` | `cde-build.yml`・`cde-deploy.yml`、cde-shared の ECR、2 人の承認と変更記録（ADR-0033） |
| `telemetry-package` | `packages/telemetry`、ログの許可リスト、`Pan` 型（[observability.md](architecture/observability.md) の 2・4 節） |
| `feature-flags-appconfig` | `packages/flags`、加盟店単位の割り当て（[delivery.md](architecture/delivery.md) の 5.4 節） |
| `money-package` | `packages/money`（`bigint` と通貨、按分、丸め）と性質ベーステスト（ADR-0001） |
| `accounts-and-tenancy` | `accounts`、RLS、`SET LOCAL app.account_id`、登録とサンドボックスの自動作成（ADR-0002） |
| `api-keys-basic` | `<brand>_{pk|sk}_{live|test}_` のキー、接頭辞でのクラスタの選択、`auth_resolve_api_key`（ADR-0008） |
| `api-foundation` | `/v1`、JSON の本文、ID の形、エラーの形、`Request-Id`、OpenAPI の生成（ADR-0006） |
| `idempotency-layer` | `Idempotency-Key` の保存と決定表（[api.md](architecture/api.md) の 7 節、ADR-0004） |
| `api-versioning-core` | バージョンの決まり方、変更モジュールの仕組み、最初のバージョン（ADR-0007） |
| `ledger-core` | 仕訳・明細・冪等キー、釣り合いの遅延制約、追記のみの強制、スロットの集計（ADR-0003・0015・0016） |
| `vault-skeleton` | cde-test の vault-ingest・vault-core とテスト用の番号だけの受け取り、本体との 2 経路（PrivateLink・`connector-results`）（[card-vault.md](architecture/card-vault.md)） |
| `mock-acquirer` | 模擬のアクワイアラ（本家のテスト用のカード番号、結果不明を起こす番号、遅延と失敗の注入） |
| `payment-intent-skeleton` | PaymentIntent の作成・確定・自動キャプチャ、遷移関数、キャプチャの仕訳（ADR-0010） |
| `outbox-and-events` | outbox、Relay、`events` の生成、`GET /v1/events`（ADR-0026） |
| `charges-enabled-skeleton` | 登録直後のテスト環境の利用と、`charges_enabled` の判定の骨格（[merchant-onboarding.md](architecture/merchant-onboarding.md)） |
| `rate-limit-framework` | GCRA、L3〜L7、応答の見出し、Valkey の障害時の振る舞い（ADR-0009） |

### E2 アカウントと権限（審査を含む）

設計：[auth-and-keys.md](architecture/auth-and-keys.md)、[merchant-onboarding.md](architecture/merchant-onboarding.md)、[security.md](architecture/security.md) の 6 節

| Story | 内容 |
| --- | --- |
| `dashboard-auth-mfa` | Better Auth（OTP・Google・パスキー・TOTP）、MFA の必須、セッション（[auth-and-keys.md](architecture/auth-and-keys.md) の 3 節） |
| `team-roles` | `account_members`、本家のロール、招待、権限の決定表、`authorize()` |
| `sensitive-actions-reauth` | 重要な操作の再認証（5 分）と Owner・Administrator への通知 |
| `restricted-keys` | 制限付きキー、`x-permission`、判定の表（auth-and-keys.md の 6 節） |
| `key-rotation-and-expiry` | ローテーション（最大 7 日）、予約、期限切れ、使われないキーの制限（180 日） |
| `access-policies` | IP のアクセスポリシー、違反の通知 |
| `security-history` | `security_events` と画面（監査ログの一部） |
| `request-logs` | `api_request_logs`（メタデータ 30 日） |
| `audit-log-core` | `audit_events`・`platform_audit_events`、log-archive へのハッシュの連鎖（ADR-0023） |
| `onboarding-requirements` | `requirements`・capability のステートマシン、`evaluateAccountCapabilities`（ADR-0022。法務の確認待ち） |
| `kyc-kyb-providers` | eKYC、法人番号・登記、反社・制裁・PEP の照合、口座の名義の照合（法務の確認待ち） |
| `risk-review-console` | 社内の審査の画面、判断の記録、書類の閲覧の理由（法務の確認待ち） |
| `rejection-and-appeal` | 拒否・終了、残高の留保、異議（法務の確認待ち：L7） |
| `bank-account-change-hold` | 入金先の口座の変更の再認証・通知・3 日の入金停止 |

### E3 決済

設計：[payments.md](architecture/payments.md)、[payment-methods.md](architecture/payment-methods.md)、[fraud.md](architecture/fraud.md)

| Story | 内容 |
| --- | --- |
| `connector-selection` | 最初のカードのコネクタの選定と仕様の確認（照会、3DS、30 日のオーソリ、重複の扱い、精算） |
| `connector-gateway-authorize` | connector-gateway の `authorize` と復号、CVC の一時保管（[card-vault.md](architecture/card-vault.md) の 3.2 節） |
| `connector-abstraction` | 共通の操作・能力・拒否コードの正規化（ADR-0011） |
| `connector-inbox` | 受信箱と反映のワーカー（ADR-0014） |
| `manual-capture-and-cancel` | 手動キャプチャ、一部のキャプチャ、取り消し、`automatic_async` |
| `auth-expiry` | `capture_before` とオーソリの失効のジョブ |
| `three-ds` | 3DS の判断と `requires_action`、コネクタの 3DS Server（ADR-0012） |
| `unknown-outcome-recovery` | 結果不明の照会・取り消しのジョブ、`processing`（payments.md の 7 節） |
| `connector-routing-breaker` | 振り分けとサーキットブレーカー |
| `refunds` | Refund、並行の返金の検査、残高の確認と保留（payments.md の 10 節） |
| `setup-intents` | SetupIntent と MIT のための保存 |
| `fraud-block-basic` | 段 2 のブロック、プラットフォームのブロックリスト、`fraud_evaluations`（[fraud.md](architecture/fraud.md)） |
| `dr-idempotent-connector-refs` | 参照番号を PaymentIntent の ID と冪等キーから決める（ADR-0030） |

### E4 お金

設計：[ledger.md](architecture/ledger.md)、[payouts-and-reconciliation.md](architecture/payouts-and-reconciliation.md)

| Story | 内容 |
| --- | --- |
| `balance-api` | `GET /v1/balance`、`source_types`（[ledger.md](architecture/ledger.md) の 4.3 節） |
| `balance-transactions` | BT の射影、`reporting_category` の対応表 |
| `fee-schedules` | 料金表と `computeFee`、本家の丸めの確認（税の扱いは法務の確認待ち：L8） |
| `availability-job` | 利用可能への一括の移動、`available_on`、営業日の表 |
| `ledger-daily-checks` | 日次のスナップショット、不変条件の検査、`balance_daily_summaries` |
| `reserves` | リザーブの保留・解放（ledger.md の 4.4 節） |
| `negative-balance-collection` | マイナス残高の回収と償却 |
| `bank-partner-selection` | 提携銀行の選定と振込 API の仕様の確認 |
| `payouts` | 自動・手動の入金、取り消し、銀行アダプタ、失敗と返却（ADR-0018。法務の確認待ち：L1） |
| `settlement-reconciliation` | 精算ファイルの取り込みと照合（ADR-0017） |
| `bank-statement-reconciliation` | 銀行の明細の取り込み、着金・入金の照合、仮勘定 |
| `recon-breaks-console` | ブレイクの画面、2 人の承認の解消と償却 |
| `ledger-correction-job` | 台帳の訂正のジョブ（delivery.md の 5.3 節） |
| `shadow-run` | 影の実行の仕組みと比較のダッシュボード（ADR-0032） |
| `merchant-reports` | 残高・入金照合のレポート |
| `gl-export` | 会計への出力（勘定科目は法務・経理の確認待ち） |

### E5 Event と Webhook

設計：[events-and-webhooks.md](architecture/events-and-webhooks.md)

| Story | 内容 |
| --- | --- |
| `webhook-endpoints` | エンドポイントの API、上限、URL の検査 |
| `webhook-signing` | `<Brand>-Signature`、`<brand>_whsec_` の秘密、入れ替え（ADR-0025） |
| `webhook-egress-vpc` | 専用の egress VPC、Elastic IP 付きの NAT、webhook-egress の Lambda、IP の公開 |
| `webhook-delivery` | router・sender・scheduler、公平さと背圧 |
| `webhook-retry-and-disable` | 3 日の再試行、失敗の通知、自動の無効化、キルスイッチ |
| `event-rendering-by-version` | エンドポイントのバージョンでの描画とスナップショットテスト |
| `event-retention` | `events` 31 日、`event_summaries` 13 か月 |
| `webhook-delivery-logs-and-resend` | 配信ログと手動の再送 |

### E6 Checkout と Elements

設計：[checkout.md](architecture/checkout.md)、[card-vault.md](architecture/card-vault.md)

| Story | 内容 |
| --- | --- |
| `vault-ingest-live` | cde-live の vault-ingest、`card_input` と `pm_` の紐づけ、カードテスティングの上限 |
| `loader-and-card-frame` | `js.<domain>` の loader と `elements.<domain>` のカード入力の iframe（ADR-0027） |
| `payment-element` | Payment Element（カード、コンビニ、銀行振込のタブ） |
| `checkout-sessions-api` | Checkout Session の API と状態 |
| `checkout-hosted-page` | ホスト型の決済ページ |
| `checkout-embedded-page` | 埋め込み型の決済ページと埋め込み先の制限 |
| `three-ds-ui` | `hooks.<domain>` の中継と 3DS のモーダル |
| `payment-page-script-integrity` | スクリプトの目録と SRI、CSP、1 時間ごとの改ざんの検知（要件 6.4.3・11.6.1） |
| `checkout-i18n-a11y` | ja・en、WCAG 2.2 AA |
| `device-signals` | 不正検知のための端末の信号（法務の確認待ち：L5） |

### E7 ダッシュボード

設計：[dashboard.md](architecture/dashboard.md)

| Story | 内容 |
| --- | --- |
| `dashboard-shell` | SPA の骨格、ルート、環境の切り替え、ブートストラップ（ADR-0028） |
| `dashboard-api-routing` | `/api/accounts/{acct}/{live|test}/v1/*` を公開 API のハンドラーへ |
| `payments-screens` | 決済・返金・Dispute の一覧と詳細、返金のダイアログ |
| `balance-and-payouts-screens` | 残高、BT、入金の画面 |
| `developers-screens` | API キー、リクエストのログ、Event と Webhook、テストイベント |
| `settings-screens` | 事業者の情報、入金先、決済手段、ブランド、有効化のフォーム、要対応の表示 |
| `report-exports` | CSV の書き出しのジョブ |
| `fraud-rules-and-reviews-ui` | ルールとリストの編集、試験、レビューのキュー |
| `first-party-analytics` | 自前の計測（S3・Athena） |
| `api-usage-insights` | バージョンごと・キーごとの利用、冪等キーのない要求の割合、429 の件数 |

### E8 日本の決済手段

設計：[payment-methods.md](architecture/payment-methods.md) の 5・6 節、[checkout.md](architecture/checkout.md) の 7 節

| Story | 内容 |
| --- | --- |
| `konbini-provider-selection` | コンビニ収納代行の選定と仕様の確認 |
| `konbini-payments` | 支払い番号、期限、速報・確報、期限切れ、払込票（ADR-0013） |
| `bank-transfer-virtual-accounts` | バーチャル口座の割り当て（法務の確認待ち：L1） |
| `customer-cash-balance` | 着金、自動・手動の充当、過不足（法務の確認待ち：L1） |
| `async-refunds-to-bank` | 顧客の口座への返金（`requires_action`、45 日）、`refunds_payable` |
| `jp-payment-capabilities` | `konbini_payments`・`jp_bank_transfer_payments` の capability |

### E9 不正検知と Dispute

設計：[fraud.md](architecture/fraud.md)、[disputes.md](architecture/disputes.md)、[merchant-onboarding.md](architecture/merchant-onboarding.md) の 6・7 節

| Story | 内容 |
| --- | --- |
| `fraud-rule-language` | ルールの言語（段 1〜3）、構文解析と型検査（ADR-0021） |
| `fraud-velocity-and-lists` | Valkey の速度の集計、既定のリスト、独自のリスト |
| `fraud-rule-testing-rollout` | 過去 90 日での試験と段階的な適用 |
| `card-testing-defense` | カードテスティングの検知と防御 |
| `risk-provider-integration` | 外部の不正検知サービス（法務の確認待ち：L4・L5） |
| `disputes-core` | Dispute の状態、引き落とし・戻しの仕訳、返金との関係（[disputes.md](architecture/disputes.md)） |
| `dispute-evidence` | 証拠の下書き・提出、ファイル、期限と通知 |
| `early-fraud-warnings` | EFW と自動返金の設定 |
| `merchant-risk-monitoring` | Dispute の率などの継続的な監視とリザーブの判断 |

### E10 本番運用（PCI・SLO・DR）

設計：[capacity.md](architecture/capacity.md)、[observability.md](architecture/observability.md)、[security.md](architecture/security.md)、[infrastructure.md](architecture/infrastructure.md)、[runbooks/README.md](runbooks/README.md)

| Story | 内容 |
| --- | --- |
| `capacity-load-tests` | k6（1 倍・2 倍、AZ の喪失、コネクタの遅延、大口の集中、大阪への切り替えの直後） |
| `slo-dashboards-burn-rate` | SLO のダッシュボードとバーンレートのアラート |
| `synthetic-canaries` | test と live（社内の加盟店）の合成監視 |
| `pan-scanning` | ログ・S3（Macie）・DB の PAN の形の走査 |
| `dr-warm-standby-osaka` | 大阪のウォームスタンバイと切り替えのワークフロー（ADR-0030） |
| `dr-drills` | 四半期の計画外のフェイルオーバーと失った決済の回復の訓練、年 1 回の switchover |
| `key-rotation-automation` | 鍵のローテーションと `ReEncrypt` の手順の自動化 |
| `data-retention-jobs` | 消去のジョブと四半期の消し残しの確認（ADR-0024。期間は L6） |
| `audit-archive-verification` | 監査のアーカイブ（Object Lock）と連鎖・署名の検証（L6 の後に本番のバケットを作る） |
| `cde-jit-access` | CDE の JIT の仕組み（AWS TEAM などの PoC）と記録の突き合わせ（ADR-0020） |
| `pci-evidence-and-qsa` | QSA の選定と事前相談、ASV・ペンテスト・分割の検証の計画、証跡の収集 |
| `secret-scanning-partner` | シークレットスキャンのパートナーへの `<brand>_` のキーの形の登録 |
| `security-baseline` | GuardDuty・Security Hub・Config、egress の許可リスト、SAST・DAST |
| `runbooks-e10` | E10 で作る runbook（[runbooks/README.md](runbooks/README.md) の 4 節） |

### E11 S2 への拡張

設計：[infrastructure.md](architecture/infrastructure.md) の 8 節、[ledger.md](architecture/ledger.md) の 9・10 節、[events-and-webhooks.md](architecture/events-and-webhooks.md) の 11 節

| Story | 内容 |
| --- | --- |
| `ledger-sharding` | `account_id` のハッシュでの台帳と状態のテーブルの分割（ADR-0016） |
| `webhook-delivery-cluster` | Webhook の配信の表と処理を専用のクラスタへ |
| `second-card-connector` | 2 社目のカードのコネクタ、承認率・コストでの振り分け |
| `multi-currency` | JPY 以外の取引の通貨と換算（ledger.md の 10 節） |
| `network-tokens` | ネットワークトークンと Card Account Updater |
| `search-api` | 検索 API と索引（PoC で方式を決める） |
| `extra-sandboxes` | 追加のサンドボックス（最大 5 つ）と入れる範囲 |
| `dashboard-sso` | ダッシュボードの SAML・OIDC |
| `advanced-access-policies` | ASN・国・匿名化の手段の条件 |
| `agent-keys` | エージェント用のキーと人の承認 |
| `confirmation-method-manual` | `confirmation_method = manual`、`advice_code` |

### E12 S3 への拡張

設計：[infrastructure.md](architecture/infrastructure.md)、[ADR-0031](decisions/0031-active-active-cells.md)

| Story | 内容 |
| --- | --- |
| `cell-routing` | キー → アカウント → セルの対応表とルーター（ADR-0031） |
| `cell-per-cde` | セルごとの prod と cde-live の組 |
| `merchant-cell-migration` | 加盟店のセル間の移動と訓練 |

各 Epic の品質面の重点と合否基準は、[quality.md](quality.md) の 5 節にある。

## エージェントに任せないこと

- **契約（公開 API・バージョンの変換・本体と CDE の API）の確定**：公開した後に変えるコストが最も高い。
- **お金の区分 A の承認と、影の実行の結果の判断**：お金のオーナーと QA が行う（ADR-0032）。
- **CDE の承認と、CDE の本番への経路**：エージェントは CDE の PR を作れるが、承認と本番の権限を持たない（ADR-0020・0033）。
- **法務の判断と、接続先の選定**。
- **負荷試験・照合の結果の解釈**：数字は出せるが、どこに投資し、どの差を許容するかはプロダクトと経理の判断。

## 後回しにしたもの

MVP の後に検討する。着手するときに `intent.md` から起票する（[intent.md](intent.md) の Non-goals）。

- **Connect**（プラットフォームと連結アカウント）：資金の流れと本人確認の範囲が広がり、台帳の仕訳が 2 つのシャードにまたがる（ADR-0016）。
- **Billing**（サブスクリプション・請求書）、**Tax**。
- **Radar の機械学習**：ルールの評価の記録（`fraud_evaluations`）がたまってから。
- **Terminal、Issuing、Treasury、Capital、Identity**。
- **thin events と `/v2/core/event_destinations`、EventBridge への送信**（ADR-0026）。
- **Express Checkout Element（Apple Pay・Google Pay）、Link、`ja`・`en` 以外の言語**。
- **即時入金**（モアタイムシステム）。
- **AI 前提の機能**：自然言語から不正のルールを作る補助（人が試験してから有効にする。[security.md](architecture/security.md) の 9 節）、照合のブレイクの原因の推定。

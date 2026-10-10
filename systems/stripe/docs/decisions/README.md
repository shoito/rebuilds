# Decisions: Stripe

Stripe の再構築に関する決定。リポジトリ共通の決定は [docs/decisions/](../../../../docs/decisions/README.md) にある（本家の名前・接頭辞を使わない規則は、その ADR-0006）。領域ごとの設計と、各 ADR の位置づけは [architecture/](../architecture/README.md) を見る。

<!-- adr-index:start -->
| ADR | 決定 | 状態 |
| --- | --- | --- |
| [0001](0001-platform-and-stack.md) | 実行基盤と技術は Slack の決定を引き継ぎ、金額は最小単位の整数で扱う | accepted |
| [0002](0002-account-tenancy.md) | 加盟店のアカウントをテナントにし、共有スキーマと RLS で分ける | accepted |
| [0003](0003-double-entry-ledger.md) | お金の正本は、追記のみの複式簿記の台帳にする | accepted |
| [0004](0004-idempotency.md) | すべての書き込みを冪等にする | accepted |
| [0005](0005-pci-scope-segmentation.md) | カード情報は CDE（別の AWS アカウント）に閉じ込め、本体はトークンだけを扱う | accepted |
| [0006](0006-api-shape.md) | 公開 API は本家 v1 のリソースの形に寄せ、本文は JSON にする | accepted |
| [0007](0007-date-based-api-versions.md) | API のバージョンは日付で持ち、アカウントに固定し、変更モジュールで古いバージョンの形を保つ | accepted |
| [0008](0008-api-keys-and-dashboard-access.md) | API キーは本家と同じ 3 種類にし、ダッシュボードは Better Auth と必須の MFA で守る | accepted |
| [0009](0009-rate-limiting.md) | レート制限は本家の単位と値に寄せ、Slack の層と GCRA の仕組みで行う | accepted |
| [0010](0010-payment-intent-state-machine.md) | PaymentIntent を唯一の決済オブジェクトにし、状態の遷移を 1 つの遷移関数に集める | accepted |
| [0011](0011-connector-abstraction-and-unknown-outcome.md) | コネクタを共通の操作と能力で抽象し、結果不明の取引は照会と取り消しで確定させてから次の手を打つ | accepted |
| [0012](0012-3ds-via-connector.md) | 3D セキュアはコネクタが提供する 3DS Server を使い、日本で発行されたカードの CIT では常に要求する | accepted |
| [0013](0013-japan-async-payment-methods.md) | コンビニ払いと銀行振込は PaymentIntent の `requires_action` で待ち、銀行振込は顧客の現金残高を経由する | accepted |
| [0014](0014-connector-inbox.md) | コネクタからの通知は受信箱に記録してから、重複と順序を解決して反映する | accepted |
| [0015](0015-chart-of-accounts-and-balance-transactions.md) | 保留中・利用可能を別の口座にし、BalanceTransaction を仕訳の射影にする | accepted |
| [0016](0016-hot-accounts-and-ledger-sharding.md) | 加盟店の残高の集計をスロットに分け、プラットフォームの口座は集計しない。S2 では加盟店のハッシュで台帳を分ける | accepted |
| [0017](0017-three-way-reconciliation-with-suspense.md) | 台帳・決済代行の精算・銀行の明細を 3 者で照合し、説明のつかないお金は仮勘定に置く | accepted |
| [0018](0018-payout-execution-via-banking-partner.md) | 入金は作成の時点で残高から引き、提携銀行の API（予備に全銀フォーマットのファイル）で振り込む | accepted |
| [0019](0019-vault-encryption-and-key-hierarchy.md) | カード番号は CDE 専用の KMS の鍵でエンベロープ暗号化し、鍵の操作を役割ごとに分ける | accepted |
| [0020](0020-cde-access-model.md) | CDE へのアクセスは、人は期限つきの承認（JIT）だけとし、AI エージェントには与えない | accepted |
| [0021](0021-fraud-rules-engine.md) | 不正検知は Radar に寄せたルールの言語を決済の経路の中で同期に評価し、外部のサービスはシグナルの 1 つにする | accepted |
| [0022](0022-merchant-onboarding-and-kyc.md) | 加盟店の審査は自前のステートマシンで持ち、確認・照合は外部の提供者を使い、機能は `requirements` と capability で開け閉めする | accepted |
| [0023](0023-audit-log.md) | 監査ログは Slack の方式を引き継ぎ、CDE の記録は別の系統で log-archive へ直接送る | accepted |
| [0024](0024-data-retention-and-deletion.md) | 財務の記録は法定の期間まで残し、カード番号と個人情報は用が済んだら消す。期間は法務の確認で確定する | accepted |
| [0025](0025-webhook-signing-and-isolated-delivery.md) | Webhook は本家の署名方式で署名し、固定の IP を持つ隔離された egress VPC から送る | accepted |
| [0026](0026-snapshot-event-model.md) | Event は作成時点のスナップショットとして不変に保存し、MVP は snapshot events だけを出す | accepted |
| [0027](0027-checkout-and-elements-isolation.md) | カード入力は CDE の側のオリジンが配る iframe で受け、loader も CDE の変更管理で配る | accepted |
| [0028](0028-dashboard-architecture.md) | ダッシュボードは公開 API を呼ぶ SPA にし、第三者のスクリプトを読み込まない | accepted |
| [0029](0029-multi-account-and-cde-layout.md) | AWS のアカウントを PCI DSS の範囲で分け、CDE は live と test を別のアカウントにする | accepted |
| [0030](0030-payments-disaster-recovery.md) | S1 から大阪にウォームスタンバイを持ち、失った決済はコネクタへの照会で回復する | accepted |
| [0031](0031-active-active-cells.md) | S3 で、加盟店をセルに固定し、セルごとに主のリージョンを東京か大阪に置いて active-active にする | accepted |
| [0032](0032-release-safety-for-money-moving-code.md) | お金を動かすコードは、影の実行で比べてから、加盟店単位のカナリアで広げる | accepted |
| [0033](0033-cde-pipeline-and-change-control.md) | CDE のコードは同じリポジトリの `cde/` に置き、ビルドとデプロイの経路と承認を本体から分ける | accepted |
<!-- adr-index:end -->

この一覧は、各 ADR の frontmatter と見出しから生成したもの。ADR を追加・更新したら生成し直す。

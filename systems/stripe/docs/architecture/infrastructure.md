# Infrastructure: Stripe

AWS 上の構成、アカウント、ネットワーク、冗長化、災害復旧、CDE の境界、コスト。Slack の [infrastructure.md](../../../slack/docs/architecture/infrastructure.md) を土台にし、決済に固有の事情だけを変える（[ADR-0001](../decisions/0001-platform-and-stack.md)）。

| 対象 | 決定 |
| --- | --- |
| アカウントと CDE の配置、ネットワーク | [ADR-0029](../decisions/0029-multi-account-and-cde-layout.md) |
| 災害復旧と、結果不明の決済の回復 | [ADR-0030](../decisions/0030-payments-disaster-recovery.md) |
| S3 のセル構成と東京・大阪の active-active | [ADR-0031](../decisions/0031-active-active-cells.md) |
| お金を動かすコードのリリース | [ADR-0032](../decisions/0032-release-safety-for-money-moving-code.md) |
| CDE のデプロイの経路と変更管理 | [ADR-0033](../decisions/0033-cde-pipeline-and-change-control.md) |
| IaC、デプロイの方式、フラグ、可観測性の道具 | Slack の ADR-0020・0022・0026・0021 を引き継ぐ |

ログ・メトリクス・SLI は [observability.md](observability.md)、負荷と台数の根拠は [capacity.md](capacity.md)、CI とリリースは [delivery.md](delivery.md)、PCI DSS の統制と暗号化は [security.md](security.md)、Vault の中身は [card-vault.md](card-vault.md) にある。

数値のうち「初期見積もり」と書いたものは、負荷試験（E10）の前の仮の値である。AWS の仕様で確かめられていないものは「未検証」と書き、確かめる計画を添える。

## 1. AWS アカウントの構成

AWS Organizations で、用途と PCI DSS の範囲ごとにアカウントを分ける。**CDE（カード会員データを扱う領域）は、本体と別の OU・別のアカウントに置く**（[ADR-0005](../decisions/0005-pci-scope-segmentation.md)、[ADR-0029](../decisions/0029-multi-account-and-cde-layout.md)）。CDE の中の構成は [card-vault.md](card-vault.md) の 2 節にある。

| アカウント | OU | 中身 | PCI DSS の範囲 |
| --- | --- | --- | --- |
| management | Root | Organizations、SCP、IAM Identity Center、請求 | 接続先（CDE の権限を配る） |
| security | Security | GuardDuty・Security Hub・Inspector の委任管理者、調査用のロール | 接続先（セキュリティを担う） |
| log-archive | Security | 組織の CloudTrail、Config、VPC フローログ、監査ログ（[ADR-0023](../decisions/0023-audit-log.md)）。CDE のログは専用のバケット（Object Lock） | 接続先（CDE のログを保管する） |
| shared | Infrastructure | 本体の ECR、Route 53、Managed Grafana、本体の CI の起点 | 範囲外 |
| dev、staging | Workloads/NonProd | 本体の開発・検証環境 | 範囲外 |
| prod | Workloads/Prod | 本体の本番。live と test の DB クラスタ（[ADR-0002](../decisions/0002-account-tenancy.md)）、東京と大阪 | 範囲外（トークンだけを扱う。範囲外であることを年次で確かめる） |
| cde-shared | CDE | CDE のイメージの ECR、CDE の CI の起点、CDE の Terraform の状態 | 範囲内（CDE のデプロイの経路。[security.md](security.md) の 8 節） |
| cde-nonprod | CDE/NonProd | staging の Vault と connector-gateway。ブランドのテスト用のカード番号だけを受け付ける | 範囲内として運用する（本番の鍵・データは置かない） |
| cde-test | CDE/Prod | 本番の「テスト環境」（`<brand>_pk_test_`）の Vault と、模擬のアクワイアラにつなぐ connector-gateway | 範囲内（本物のカード番号が誤って入力されうるため） |
| cde-live | CDE/Prod | 本番の Vault（vault-ingest・vault-core・Vault DB）、connector-gateway、アクワイアラへの接続 | 範囲内（中心） |

- **test と live の CDE を分ける。** 加盟店がテスト環境に本物のカード番号を入れることがある。cde-test の Vault は、テスト用のカード番号以外を保存もログもせずに拒否するが（[card-vault.md](card-vault.md) の 3.1 節）、受け取る時点で CDE の統制が要る。live と同じアカウントに置くと、テスト環境の変更と負荷（加盟店の統合の試験、カードテスティングの攻撃）が live の CDE に及ぶ。
- **本体の prod は live と test の両方を持つ。** API とダッシュボードのコードは共通で、API キーの接頭辞で DB とコネクタを切り替える（[ADR-0002](../decisions/0002-account-tenancy.md)）。
- **CDE の OU に、専用の SCP を当てる。**
  - 東京・大阪以外のリージョンの利用を禁止する（CloudFront・WAF・ACM のための us-east-1 のグローバルなサービスを除く）。
  - CloudTrail・Config・GuardDuty の停止、VPC フローログの削除、KMS の鍵の削除の予約を、break-glass のロール以外に禁止する。
  - 本体の OU のロールからの `sts:AssumeRole` を拒否する（CDE への経路は 2.3 節の API だけ）。
- **CDE には常設の人の権限を置かない。** 期限つきの承認（最長 4 時間）で入る（[ADR-0020](../decisions/0020-cde-access-model.md)）。**AI エージェントには、CDE の経路を一切与えない。**
- S3 のセル構成では、セルごとに prod と cde-live のアカウントの組を持つ（10 節）。

## 2. ネットワーク

### 2.1 本体の VPC（prod）

Slack と同じく、3 AZ にまたがる VPC を 1 つ持つ。

| サブネット | 置くもの | インターネットへの経路 |
| --- | --- | --- |
| public | ALB、NAT ゲートウェイ | Internet Gateway |
| private | api、dashboard、checkout、relay、workers、webhook-router・webhook-sender・webhook-scheduler、connectors（カード以外） | NAT 経由、Network Firewall の許可リストだけ |
| isolated | Aurora（live・test） | なし |

- 入口は CloudFront → ALB だけ（ALB は CloudFront のマネージドプレフィックスリストだけを許可）。CloudFront に AWS WAF を付ける。
- VPC エンドポイントで、S3・ECR・SQS・Secrets Manager・KMS・CloudWatch Logs・STS・X-Ray・AppConfig・Lambda への通信を NAT に出さない。
- **Webhook の送信は、本体と別の egress VPC に隔離する**（[ADR-0025](../decisions/0025-webhook-signing-and-isolated-delivery.md)、[events-and-webhooks.md](events-and-webhooks.md)）。送信先は加盟店が決める任意の URL で、SSRF の踏み台になりうる。
  - 署名は本体の webhook-sender（ECS）が行い、送信は egress VPC の Lambda（webhook-egress）が行う。Lambda の実行ロールはログの書き込みだけで、署名の秘密を持たない。
  - egress VPC には、本体・CDE とのピアリング、Transit Gateway、VPC エンドポイントを置かない。外への経路は NAT ゲートウェイだけで、その Elastic IP を送信元の IP として公開する（本家と同じ運用）。
  - 公開する IP は、東京の 3 AZ の NAT に 1 個ずつと、大阪の待機の構成の 3 個の計 6 個を、最初から一覧に載せる（[events-and-webhooks.md](events-and-webhooks.md) の 10.3 節）。リージョンの切り替えで加盟店の許可リストの変更を待たないため。

### 2.2 CDE の VPC（cde-live・cde-test）

構成の図と部品は [card-vault.md](card-vault.md) の 2 節。ここではネットワークの規則だけを書く。

| サブネット | 置くもの | 経路 |
| --- | --- | --- |
| public | Vault 用の ALB、NAT ゲートウェイ（固定の Elastic IP） | Internet Gateway |
| private | vault-ingest、vault-core、connector-gateway、CVC の一時保管（ElastiCache） | 外向きは NAT → Network Firewall（アクワイアラ・3DS Server の宛先だけ）。専用線は 2.4 節 |
| isolated | Vault DB（Aurora） | なし |
| endpoint | PrivateLink のエンドポイントサービス（NLB）、AWS のサービスの VPC エンドポイント | なし |

- **カード番号は、顧客のブラウザから Vault へ直接届く。** 経路は `vault.<domain>`（live）・`vault-test.<domain>`（test）の CloudFront（WAF 付き）→ CDE の ALB → vault-ingest。Elements と Checkout は、公開キーの接頭辞で送り先のホスト名を選ぶ。本体の VPC と ALB を通らない。
- CDE の CloudFront・WAF・ACM の証明書は、CDE のアカウントに置く。本体の CloudFront と共有しない。
- **CDE の VPC は、本体の VPC とピアリングも Transit Gateway の接続もしない。** 経路を 2.3 節の 2 本に限る。
- セキュリティグループは、サービスごとに入る側と出る側の両方を明示する（既定の全許可を使わない）。PCI DSS の要件 1 のネットワークの統制として、ルールの一覧を半年ごとに見直す（[security.md](security.md)）。

### 2.3 本体と CDE の接続

| 向き | 方式 | 運ぶもの |
| --- | --- | --- |
| 本体 → CDE | AWS PrivateLink＋相互 TLS。CDE が NLB のエンドポイントサービスを公開し、prod の VPC エンドポイントから呼ぶ。許可するプリンシパルは prod のアカウントだけ | vault-core（Vault Core）の `bind_card_input`・`get_card`・`delete_card` と、connector-gateway の `authorize`・`capture`・`refund`・`void`・`inquire`・`authenticate_*`。渡すのは `pm_`、`account_id`、金額、参照番号。紐づけのときだけ、ブラウザが vault-ingest から受け取った使い捨ての `card_input` を渡す。応答にカード番号を含めない |
| CDE → 本体 | cde-live（テスト環境は cde-test）の VPC エンドポイント経由で、prod の SQS キュー（`connector-results`）へ送る。キューのリソースポリシーで cde-live・cde-test のロールだけを許可する（[ADR-0029](../decisions/0029-multi-account-and-cde-layout.md)） | コネクタの結果と、カード番号を除いたアクワイアラの通知（[ADR-0014](../decisions/0014-connector-inbox.md)）。カード番号は含まない |

- **境界を越える識別子は `pm_` だけ**（唯一の例外は、紐づけの 1 回だけ通る使い捨ての `card_input`。カード会員データを含まない。[card-vault.md](card-vault.md) の 2 節、ADR-0029 の注記）。Vault の内部の `card_ref` は CDE の外に出さない（[card-vault.md](card-vault.md) の 3.1 節）。
- CDE → 本体の向きに HTTP の呼び出しを作らない。CDE が本体の障害に引きずられず、本体の中に入る経路もできない。PaymentMethod の作成も、ブラウザ → 本体 → CDE の向きで行う（[card-vault.md](card-vault.md) の 3.1 節）。
- AWS PrivateLink は、AWS の PCI DSS の対象サービスの一覧に独立した項目としては名前がない。一覧には Amazon VPC が載っているが、PrivateLink が VPC の範囲に含まれると明記した公式の文書は見つからなかった（2026-09-27 に確認。[AWS Services in Scope](https://aws.amazon.com/compliance/services-in-scope/PCI/)、[Amazon VPC のコンプライアンス](https://docs.aws.amazon.com/vpc/latest/userguide/VPC-compliance.html)）。通すのはトークンだけで、カード番号は通さないので、統制の上は問題にならない見込みである。ただし境界の装置として評価される可能性がある。**未検証**：QSA の事前相談で扱いを確かめる（E10）。
- 呼び出しは、相互 TLS と、呼び出し元のサービスごとの短命な署名付きトークンで認証する。詳細は [card-vault.md](card-vault.md)。

### 2.4 アクワイアラ・決済代行・銀行への接続

最初の接続先は未決定（[intent.md](../intent.md) の Open questions）。接続先の条件で、次のどちらかを選ぶ。

| 方式 | 使うとき | 構成 |
| --- | --- | --- |
| インターネット＋相互 TLS | 接続先がインターネットの API を提供し、送信元の IP を許可リストで絞る | cde-live の NAT（東京・大阪で固定の Elastic IP）→ Network Firewall（接続先の宛先だけを許可）。TLS 1.2 以上 |
| 専用線（AWS Direct Connect） | 接続先が専用線を求める、または遅延と帯域を保証したい | 東京と大阪の 2 つ以上のロケーションで、別の装置に終端する接続を持つ（Maximum resiliency のモデル）。この構成で Direct Connect の SLA 99.99% の対象になる（[Resiliency Toolkit](https://docs.aws.amazon.com/directconnect/latest/UserGuide/resiliency_toolkit.html)）。Site-to-Site VPN を予備にする |

- **大阪の送信元 IP も、最初から接続先に登録しておく。** リージョンの切り替え（5 節）のときに、接続先の許可リストの変更を待たない。登録の確認を DR の訓練の項目にする。
- カード番号を扱わない接続（コンビニ収納の事業者、銀行振込の銀行、精算ファイルの取得）は、本体の prod の connectors サービスから行い、CDE を通さない（[payment-methods.md](payment-methods.md)）。
- アクワイアラからの通知の受け口は、カード番号を含みうるものは CDE、含まないものは本体に置く（[ADR-0014](../decisions/0014-connector-inbox.md)）。
- 精算ファイルを SFTP で受け取る接続先には、AWS Transfer Family を prod に置くか、connectors から取りに行く。どちらにするかは接続先が決まってから決める。

## 3. ECS サービスとオートスケール

すべて Fargate（ARM64）。サービスごとにタスク定義と IAM ロールを分ける。

### 3.1 本体（prod）

| サービス | 役割 | スケールの指標 | 最小タスク数 |
| --- | --- | --- | --- |
| api | 公開 API（認証、冪等、版の変換、Payments の状態遷移、Ledger への書き込み） | CPU 50%、ターゲットあたりの同時リクエスト数 | 6（AZ ごとに 2） |
| dashboard | ダッシュボードのバックエンド | CPU 50% | 3 |
| checkout | Checkout のページとバックエンド | CPU 50% | 3 |
| relay | outbox → SQS | outbox の最古の行の経過時間 | 2（アクティブ 1、待機 1） |
| workers | Event の生成、コネクタの結果・通知の反映、結果不明の照会、精算・照合、Payout のバッチ | SQS の最古のメッセージの経過時間。キューごとにサービスを分ける | キューごとに 1〜4 |
| webhook-router・webhook-sender・webhook-scheduler | Webhook の振り分け、署名、再送の予定（[events-and-webhooks.md](events-and-webhooks.md)） | SQS の最古のメッセージの経過時間、同時送信数 | 各 2〜3 |
| webhook-egress（Lambda、egress VPC） | 署名済みの要求を加盟店の URL へ送る | 予約済みの同時実行数（初期値 500） | — |
| connectors | カードを扱わないコネクタ（コンビニ、銀行振込） | CPU 50% | 2 |

- **api の中で、コネクタの応答を待つ間に DB のトランザクションを開いたままにしない。** 試行を記録してコミット → コネクタを呼ぶ → 結果を別のトランザクションで反映、の 3 段にする（[payments.md](payments.md)、[ADR-0011](../decisions/0011-connector-abstraction-and-unknown-outcome.md)）。こうしないと、コネクタの遅延がそのまま DB の接続の枯渇になる（[capacity.md](capacity.md) の 2.3 節）。
- api は Node.js の非同期 I/O でコネクタを待つ。スケールの指標に「同時リクエスト数」を使うのは、コネクタが遅くなると CPU が低いまま同時接続だけが増えるため。

### 3.2 CDE（cde-live・cde-test）

| サービス | 役割 | KMS の権限（[ADR-0019](../decisions/0019-vault-encryption-and-key-hierarchy.md)） | 最小タスク数 |
| --- | --- | --- | --- |
| vault-ingest（Vault Ingress） | ブラウザからカード番号を受け取り、暗号化して保存し、使い捨ての `card_input` を返す | 暗号化だけ（`GenerateDataKey`、指紋の `GenerateMac`、CVC の `cde-sad` の暗号化） | 3 |
| vault-core（Vault Core） | 本体からの `card_input` と `pm_` の紐づけ、表示用の情報の照会、消去 | なし | 3 |
| connector-gateway（Connector Gateway） | 復号し、アクワイアラ・3DS Server への要求を組み立てて送る。結果を `connector-results` へ送る | 復号（`Decrypt`、CVC の `cde-sad` の復号）。ここだけ | 6（[capacity.md](capacity.md) の 3.6 節） |

- 復号できるのは connector-gateway のタスクロールだけにする（[ADR-0005](../decisions/0005-pci-scope-segmentation.md)）。
- アクワイアラが決済用の HSM の鍵の交換（TR-31・TR-34 など）を求めるときは、AWS Payment Cryptography を使う。東京（ap-northeast-1）と大阪（ap-northeast-3）で提供されている（2026-09-26 に確認。[エンドポイントの一覧](https://docs.aws.amazon.com/payment-cryptography/latest/userguide/endpoints.html)）。AWS の PCI DSS の対象サービスにも含まれる（[AWS Services in Scope](https://aws.amazon.com/compliance/services-in-scope/PCI/)）。カード番号の保存の暗号化は KMS で行い、Payment Cryptography は使わない。

### 3.3 AZ の障害への備え

- 各サービスは、残る 2 AZ で最大負荷をさばける台数を常に持つ。平常時の使用率を 2/3 以下に保つ（NFR-007）。
- api の最小タスク数を 6 にするのは、1 AZ を失っても 4 タスクが残り、オートスケールが追いつくまでの数分を持たせるため。

## 4. S1 の構成と台数（初期見積もり）

S1（決済の確定 500 件/秒、加盟店 1 万）の本番。根拠は [capacity.md](capacity.md)。

| リソース | 構成 | 根拠 |
| --- | --- | --- |
| Aurora（live） | writer `db.r8g.4xlarge` × 1、reader 同型 × 1（別の AZ）。I/O-Optimized。Global Database の二次（大阪）に reader 同型 × 1 | 確定 1 件あたり約 15 行の書き込みで、全体のピーク約 1.4 万行/秒。writer の CPU 50% 以下を目標 |
| Aurora（test） | writer `db.r8g.large` × 1、reader 同型 × 1。大阪は headless | テスト環境は SLO が低い（5.3 節） |
| Aurora（Vault、cde-live） | writer `db.r8g.xlarge` × 1、reader 同型 × 1。大阪に reader 同型 × 1 | トークン化は確定と同程度の件数だが、1 件の行が少ない |
| Aurora（Vault、cde-test） | writer `db.r8g.large` × 1、reader × 1。大阪は headless | |
| ElastiCache（CVC の一時保管、cde-live・cde-test） | `cache.r7g.large`、プライマリ 1＋レプリカ 2（cde-test は小さく） | TTL 30 分。容量は小さい |
| RDS Proxy | 使わない | `SET LOCAL` によるテナントのコンテキストで接続が固定される（Slack の capacity.md の 2.2 節と同じ） |
| api | 2 vCPU / 4 GB × 12 タスク（平常）、最大 40 | [capacity.md](capacity.md) の 2.1 節 |
| dashboard、checkout | 1 vCPU / 2 GB × 各 3 | |
| relay | 0.5 vCPU / 1 GB × 2 | |
| workers | 0.5〜1 vCPU × 計 12（最大 30） | キューごとの台数は [capacity.md](capacity.md) の 2.6 節 |
| webhook-router・sender・scheduler | 1 vCPU / 2 GB × 各 2〜3（sender は最大 12） | |
| webhook-egress（Lambda） | 予約済みの同時実行数 500 | [events-and-webhooks.md](events-and-webhooks.md) |
| vault-ingest、vault-core | 1 vCPU / 2 GB × 各 3（vault-ingest は最大 12） | |
| connector-gateway | 2 vCPU / 4 GB × 6（最大 24） | 同時に待つコネクタの要求の数で決まる（[capacity.md](capacity.md) の 2.5 節） |
| SQS | 標準キュー＋DLQ。キューごとに分ける | |
| NAT ゲートウェイ | prod：× 3、Webhook の egress VPC：× 3、cde-live：× 3、cde-test：× 3 | 送信元の IP を用途ごとに固定する |
| Network Firewall | prod、cde-live、cde-test に各 3 AZ | |
| 大阪（ウォームスタンバイ） | 各サービスを最小 1〜2 タスク、Aurora の二次に reader 1 台 | 5.3 節 |

staging と cde-nonprod は、同じ構成を最小の台数で持ち、負荷試験のときだけ本番と同じ台数に広げる。dev は夜間と週末に止める。

## 5. バックアップと災害復旧

### 5.1 バックアップ

| 対象 | 方法 | 保持 |
| --- | --- | --- |
| Aurora（live・Vault） | 自動バックアップ（PITR）＋ AWS Backup の連続バックアップ | 35 日 |
| Aurora（live・Vault、長期） | AWS Backup の日次スナップショット。大阪へコピー | 13 か月（会計の照合と Dispute の期限を覆う） |
| 台帳の月次の締め | 締めた月のパーティションを Parquet で S3 に書き出す（Object Lock、コンプライアンスモード） | 10 年（会計の帳簿の保存期間。法務の確認で確定） |
| 精算ファイル・銀行の明細の原本 | S3（Object Lock）。東京 → 大阪へレプリケーション | 10 年（同上） |
| SQS | バックアップしない | outbox から再生成する |

- バックアップの保管庫は AWS Backup Vault Lock で削除を防ぐ。CDE のバックアップは、cde-live の中の保管庫に置き、本体の保管庫と混ぜない。
- 暗号化は、KMS のマルチリージョンキーで行う。CDE の鍵は CDE のアカウントで作り、大阪にレプリカを置く。
- Vault のバックアップにはカード番号の暗号文が入る。PCI DSS の保存期間の方針（要件 3.2.1）に従い、不要になったカード番号の削除がバックアップにも及ぶよう、長期のスナップショットは Vault では取らない（35 日の PITR だけ）。

### 5.2 AZ の障害（NFR-007：RPO 0、RTO 5 分）

| 部品 | 動き | 目安 |
| --- | --- | --- |
| Aurora | 別の AZ の reader へ自動でフェイルオーバーする。ストレージは 3 AZ の 6 つのノードへ同期で複製されるので、コミット済みのデータは失わない | 通常 60 秒未満、多くは 30 秒未満（[AWS のドキュメント](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Concepts.AuroraHighAvailability.html)） |
| ECS | 残る AZ でタスクを起動し直す。ALB が不健全なターゲットを外す | 数分 |
| NAT・Network Firewall | AZ ごとに持つので、残る AZ の経路を使う | 即時（経路表は AZ ごと） |
| コネクタの要求 | フェイルオーバー中に送った要求は、結果不明になりうる。5.4 節と同じ照会で片付ける | 数分 |

### 5.3 リージョンの障害（NFR-008：RPO 1 分、RTO 1 時間）

S1 から、大阪に**ウォームスタンバイ**を持つ（[ADR-0030](../decisions/0030-payments-disaster-recovery.md)）。Slack の S1 のパイロットライト（RTO 4 時間）では、NFR-008 の 1 時間に届かないため。

| 段階 | 戦略 | 大阪に常に置くもの |
| --- | --- | --- |
| S1・S2 | ウォームスタンバイ | Aurora Global Database の二次（live と Vault は reader 1 台、test は headless）、各サービスの最小のタスク、ALB、NAT と Network Firewall、VPC エンドポイント、SQS、ECR のレプリカ、Secrets Manager のレプリカ、KMS のマルチリージョンキー、アクワイアラへの接続（IP の登録、専用線） |
| S3 | セルごとの active-active（10 節） | 各セルの相手のリージョンに、同じ構成 |

- Global Database の RPO は通常秒単位で、計画外のフェイルオーバーでは、その時点の複製の遅延ぶんを失う。計画的な切り替え（switchover）は RPO 0（[AWS のドキュメント](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-global-database-disaster-recovery.html)）。
- **`rds.global_db_rpo` は S1 では設定しない。** 設定すると、大阪の複製が指定の秒数（最小 20 秒）より遅れたとき、東京の書き込みのコミットが止まる（同上）。大阪との回線の劣化だけで東京の決済が止まり、NFR-001（99.99%）を損なう。代わりに `AuroraGlobalDBRPOLag` を監視し、10 秒を超えたら呼び出す（[observability.md](observability.md)）。失った範囲は 5.4 節の照会で回復する。
- 2 つのリージョンだけの Global Database では、二次の側のパラメーターグループで `rds.global_db_rpo` を既定のままにすることを AWS が勧めている（同上）。設定しない方針と合う。
- 計画外のフェイルオーバーは、マネージドなフェイルオーバー（`failover-global-cluster --allow-data-loss`）で行う。Aurora は古い一次の書き込みを止める（write fencing）が、最善努力なので、切り替えの前にアプリの書き込みを止める。古い一次の障害時点のスナップショット（`rds:unplanned-global-failover-...`）が取れれば、失った行の回復にも使う（同上）。
- アプリは Global Database の writer エンドポイントに接続し、DNS のキャッシュを 5 秒以下にする（同上）。
- テスト環境（test）の DB は headless にし、RTO 4 時間とする。テスト環境の停止は加盟店の開発を止めるが、お金は動かない。
- 手順は [runbooks/disaster-recovery.md](../runbooks/disaster-recovery.md)。

### 5.4 リージョンの切り替えの後の「結果不明」の決済の回復

計画外のフェイルオーバーでは、東京で成功して大阪に届かなかった書き込み（最大で複製の遅延ぶん）を失う。決済では、次のことが起こりうる。

- 加盟店に `succeeded` を返し、Webhook も送った PaymentIntent が、大阪にない。
- アクワイアラでオーソリ・キャプチャが済んでいるのに、台帳に仕訳がない。
- 冪等キーの記録が消え、加盟店の再送が新しい決済として処理される。

NFR-003（成功を返した決済を失わない）を守るため、次の仕組みを組み合わせる（[ADR-0030](../decisions/0030-payments-disaster-recovery.md)）。

1. **コネクタの参照番号から、元の ID を復元できるようにする。** アクワイアラへ送る参照番号に、PaymentIntent の ID と試行の番号を入れる（[ADR-0004](../decisions/0004-idempotency.md) のコネクタの冪等キー）。ID は乱数を含む形式にし、連番にしない。回復のときに同じ ID で作り直せ、別の決済と衝突しない。
2. **加盟店の冪等キーを、コネクタの参照番号にも効かせる。** `Idempotency-Key` 付きの作成と確定では、参照番号の一部をキーから決める（アカウント × 環境 × キーのハッシュ）。大阪が冪等キーの記録を失って同じ要求を新しい決済として処理しても、アクワイアラが重複として拒否するか、元の結果を返す。重複の扱いが接続先で違うので、接続先ごとに確かめる（**未検証**。最初の接続先が決まったら、E3 で確かめる）。
3. **失った範囲を照会で埋める。** 切り替えの直後に、失った範囲（複製の遅延の記録から求め、前後に 5 分の余裕を足す）について、次の順で照会する。
   - アクワイアラの取引の照会 API（参照番号、または時間の範囲）
   - 大阪の DB に残っている試行の記録（送信の前に `pending_send` でコミットした行。[ADR-0011](../decisions/0011-connector-abstraction-and-unknown-outcome.md)。同じく欠けうる）
   - 古い一次のスナップショットが取れていれば、その行
   - 翌日の精算ファイル（最後の砦。T+1）
4. **照会の結果で、状態と仕訳を作り直す。** アクワイアラで成功していて大阪にない決済は、元の ID で PaymentIntent を作り直し、仕訳を追記し、Event を発行する（同じ ID の Event は、加盟店の側で重複として捨てられるよう、Event の ID も元の値を使う）。オーソリだけで加盟店が知らない（作成の応答が返っていない）ものは、取り消す（void）。
5. **照合が終わるまで、入金（Payout）を止める。** 失った範囲に入る加盟店の Payout の計算を保留し、照合の結果が 0 件の不一致になってから再開する（[payouts-and-reconciliation.md](payouts-and-reconciliation.md)）。
6. 大阪で処理中の、結果不明の試行は、通常の結果不明の処理（[payments.md](payments.md)）と同じ照会のキューに入れる。

S1 の NFR-008 の RPO（1 分）は、この照会で「失った範囲を回復できる」ことを含めた目標である。回復にかかる時間は RTO に含めない（切り替えの後、照会は並行して進める）が、Payout の保留は照合の完了まで続く。

### 5.5 論理的な破損

台帳は追記のみなので、誤った仕訳は逆の仕訳で直す（[ADR-0003](../decisions/0003-double-entry-ledger.md)）。PITR での復元は、状態のテーブルの破損と、台帳以外のデータの喪失に使う。Slack の手順（隔離した VPC へ復元し、失われた行だけを戻す）に倣う。台帳の行を PITR から戻すときも、`UPDATE` ではなく、欠けた仕訳の追記として戻す。

## 6. CI/CD と CDE の境界

本体の CI/CD は Slack と同じ（GitHub Actions、OIDC、1 回ビルドして同じイメージを昇格させる、prod は Ops の承認）。CDE は、経路を分ける（[ADR-0033](../decisions/0033-cde-pipeline-and-change-control.md)）。

```
本体： main へのマージ ─▶ ビルド ─▶ shared の ECR ─▶ dev ─▶ staging ─▶ prod（Ops の承認）
CDE ： main へのマージ（cde/ の変更） ─▶ CDE 用のビルド ─▶ cde-shared の ECR
        ─▶ cde-nonprod ─▶ cde-test ─▶ cde-live（CDE の変更の承認：2 人。変更記録の番号が必須）
```

| 項目 | 本体 | CDE |
| --- | --- | --- |
| イメージの置き場所 | shared の ECR | cde-shared の ECR。本体の CI のロールは push できない |
| デプロイのロール | `environment:prod` の主体だけが引き受けられる | `environment:cde-live`（cde-test は `environment:cde-test`）の主体で、ワークフローが `cde-deploy.yml` のときだけ引き受けられる（OIDC の `job_workflow_ref` で絞る） |
| 承認 | Ops 1 人（作成者と別） | Dev のテックリードと、セキュリティの担当の 2 人（どちらも作成者と別） |
| 変更の記録 | PR | PR に加えて、影響・テストの証跡・戻し方を書いた変更記録（PCI DSS 要件 6.5.1） |
| デプロイの時間帯 | 平日 10〜17 時 | 平日 10〜16 時。年末・大型セールの前後は凍結 |
| 本番のデータとログを読む人 | Ops と許可した Dev | CDE の期限つきの権限を得た Ops だけ |

- 本体の SCP で、本体の CI のロールが CDE のアカウントのロールを引き受けることを拒否する（1 節）。
- インフラ（Terraform）も分ける。CDE のルートモジュールの状態ファイルは cde-shared のバケット（東京と大阪）に置き、apply のロールも CDE 専用にする。

## 7. 環境とデータ

| 環境 | 目的 | データ | カード番号 |
| --- | --- | --- | --- |
| local | 開発、エージェントの確認ループ | seed | Vault の模擬（テスト用のカード番号だけ） |
| dev | 結合の確認 | seed | cde-nonprod を共有しない。Vault の模擬 |
| staging・cde-nonprod | リリース前の確認、負荷・障害試験、DR の訓練 | seed と生成データ（加盟店 1 万、1 日 900 万件の確定相当） | テスト用のカード番号だけ |
| prod（test）・cde-test | 加盟店のテスト環境（本番の一部） | 加盟店のテストのデータ | テスト用のカード番号だけを保存する |
| prod（live）・cde-live | 本番 | 本番 | 本物 |

- **本番のデータを本番のアカウントの外に出さない。** 匿名化したコピーも作らない（Slack と同じ）。
- **本物のカード番号は、cde-live の外に一度も出さない。** 障害の調査でも、カード番号を画面・ログ・チケットに出さない。表示が必要なときは、先頭 6 桁と下 4 桁までにする（PCI DSS 要件 3.4.1）。
- 合成監視のために、prod（live）に社内の加盟店のアカウントを置く。社内のカードで実際に少額を決済し、翌日に取り消す（[observability.md](observability.md) の 6 節）。

## 8. 段階を上げる判断の基準

次のどれかに当たり、戻らない見込みになったら、次の段階への移行を始める。移行に四半期ほどかかるので、上限の手前で始める。

| 指標 | S1 → S2 を始める目安 | S2 → S3 を始める目安 |
| --- | --- | --- |
| 決済の確定（ピーク） | 300 件/秒（S1 の 60%）を 2 週続けて超える、または大型セールで 400 件/秒の見込み | 3,000 件/秒を 2 週続けて超える |
| Aurora（live）writer の CPU（ピークの p95） | 60% を超える、または 1 段上げても 6 か月もたない | シャードを増やしても、最大のクラスで 60% を超える見込み |
| 台帳の残高の口座のロック待ち | 大口の加盟店の確定の p99 が NFR-002 を脅かす | — |
| Webhook の配信の遅れ | 最初の配信の p95 が 10 秒（NFR-006）に近づき、api と資源を取り合う | — |
| 1 加盟店の占有 | 1 つの加盟店が確定の 20% を超え続ける | 専用のセルが必要な大口の加盟店の契約見込み |
| 可用性 | — | 1 回の障害で全加盟店が止まることが、NFR-001 の S3 の目標（99.995%）と両立しない |
| リージョンの障害の影響 | — | 切り替えの 1 時間を、大口の加盟店が契約上許容しない |

S2 で行うこと：台帳の書き込みを加盟店のハッシュで分割する（[ledger.md](ledger.md)）、Webhook の配信を独立したクラスタにする、Aurora の reader を増やす、大阪の Global Database の二次を writer と同じ大きさにする。

## 9. コストの概算（S1、本番、1 か月）

**大まかな見積もりである。** 東京のオンデマンド料金をもとにした ±50% の幅の値。データ転送、ログの量、専用線の回線費（接続先と通信事業者による）、サポートプラン、税は含めない。Savings Plans とリザーブドインスタンスで 20〜30% 下げられる。

| 項目 | 月額（USD、概算） |
| --- | --- |
| Aurora（live：r8g.4xlarge × 2＋大阪 × 1、I/O-Optimized、複製） | 6,500 |
| Aurora（test、Vault の live・test）、ElastiCache（CVC） | 3,000 |
| ECS Fargate（東京 約 80 vCPU、大阪の待機 約 20 vCPU） | 4,000 |
| CloudFront、ALB、NLB、PrivateLink、データ転送 | 2,500 |
| NAT ゲートウェイ、Network Firewall（prod、Webhook の egress、cde-live、cde-test。東京と大阪） | 4,500 |
| 可観測性（ログ 1 年の保管を含む、メトリクス、トレース、Grafana） | 3,000 |
| WAF、GuardDuty、Security Hub、Inspector、Config、CloudTrail | 1,500 |
| KMS、Secrets Manager、Payment Cryptography（使う場合）、SQS | 800 |
| バックアップ、S3（Object Lock の長期保管） | 700 |
| **本番の合計** | **約 26,000** |
| staging・dev・cde-nonprod・shared・cde-shared | 約 6,000 |

- Slack の S1（約 1 万）より高いのは、大阪のウォームスタンバイ、CDE の二重の構成（live と test）、Webhook の egress VPC、Network Firewall と NAT の数、ログの 1 年保管のため。
- 費用はアカウントとタグ（`service`、`env`、`pci_scope`）ごとに毎月見る。CDE の費用を分けて見られるようにする。

## 10. S3 のセル構成と東京・大阪の active-active

S3（確定 50,000 件/秒、加盟店 100 万、NFR-001 の 99.995%）では、スタック一式をセルとして複製し、**セルごとに「主のリージョン」を東京か大阪に置く**。全体としては両方のリージョンで決済を受ける（active-active）が、1 つのセルの書き込みは常に 1 つのリージョンで行う。決定は [ADR-0031](../decisions/0031-active-active-cells.md)。

```
                    ┌─────────────────────────────────────────────┐
 加盟店のサーバー ─▶│ Edge（CloudFront、東京・大阪の両方のルーター）│
                    │  API キー → アカウント → セルの対応表を引く    │
                    └──────────────┬──────────────────────────────┘
          ┌────────────────────────┼─────────────────────────┐
          ▼                        ▼                         ▼
 cell-t01（主：東京）      cell-o01（主：大阪）       cell-big-01（大口専用）
  本体＋CDE の一式          本体＋CDE の一式            本体＋CDE の一式
  二次：大阪                二次：東京                  二次：相手のリージョン
```

- **加盟店のアカウントを、1 つのセルに固定する。** 冪等キー、台帳の口座、残高は、セルの中で閉じる。1 つの加盟店の書き込みが 2 つのリージョンに分かれないので、台帳に多重の書き込み手（マルチライター）の衝突が起きない。
- **セルの外（Global）に置くもの**：API キー → アカウント → セルの対応表、ダッシュボードのログインとセッション、加盟店の審査の状態、全体の運用。対応表は両方のリージョンで読めるようにし、変更の少ないデータとして非同期で複製する。セルは、自分が持たないアカウントの要求に 421 を返し、ルーターは対応表を取り直す。
- **CDE もセルごとに持つ。** カード番号をセルの外で共有しない。1 つの顧客のカードが複数のセルに保存されうるが、トークンはセルごとでよい（加盟店をまたいでカードを共有しない）。
- **リージョンの障害**では、止まったリージョンを主とするセルだけを、相手のリージョンへ切り替える（5.3・5.4 節の手順を、セル単位で行う）。もう一方のリージョンのセルは影響を受けない。切り替えを受けるため、各リージョンは相手のセルの負荷を引き受ける余裕（平常時の使用率 50% 以下）を持つ。
- **デプロイはセルを順に進める**（[delivery.md](delivery.md) の 5 節）。社内の加盟店のセル → 小さなセル → 残り。
- 複数リージョンに同時に書ける DB（Aurora DSQL のマルチリージョン。東京・大阪を書けるリージョン、ソウルを witness にする組を作れる。[耐障害性](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/disaster-recovery-resiliency.html)）は、1 つのセルを両方のリージョンで書けるようにする候補として比べた。DSQL はトリガー・RLS・PL/pgSQL・手動のパーティションを持たず、分離レベルは楽観的な Repeatable Read に固定である（[サポートする SQL の機能](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-postgresql-compatibility-supported-sql-features.html)、2026-09-27 に確認）。台帳の制約（ADR-0003）と RLS（ADR-0002）が成り立たないので、候補から外す。DSQL がこれらを持ったときに再評価する（ADR-0031）。
- 加盟店をセル間で移す手順は、Slack の infrastructure.md の 10.4 節（`account_id` で絞ったコピー、論理レプリケーションの行フィルタ、短い書き込みの停止、対応表の切り替え）に倣う。決済では、移動中に結果不明の試行が残っていないこと、台帳の残高が移動の前後で一致することを、切り替えの条件に加える。

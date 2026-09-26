# Infrastructure: Slack

AWS 上の構成、環境、冗長化、災害復旧、デプロイ、コスト。実行基盤の選定は [ADR-0011](../decisions/0011-aws-container-platform.md)、IaC は [ADR-0020](../decisions/0020-infrastructure-as-code-with-terraform.md)、デプロイとマイグレーションは [ADR-0022](../decisions/0022-zero-downtime-deploy-and-migrations.md)、S3 のセル構成は [ADR-0023](../decisions/0023-cell-based-architecture.md)（proposed）にある。ログ・メトリクス・トレースは [observability.md](observability.md)、脅威モデルと暗号化の方針は [security.md](security.md)。

数値のうち「初期見積もり」と書いたものは、負荷試験（E7）の前の仮の値である。負荷試験の結果で置き換える。AWS の仕様で確かめられていないものは「未検証」と書く。

## 1. AWS アカウントの構成

AWS Organizations で、用途ごとにアカウントを分ける。本番のデータと権限を、本番のアカウントの外に出さないため。

| アカウント | OU | 中身 |
| --- | --- | --- |
| management | Root | Organizations、SCP、IAM Identity Center、請求。ワークロードは置かない |
| security | Security | GuardDuty・Security Hub・IAM Access Analyzer の委任管理者。セキュリティの調査用のロール |
| log-archive | Security | 組織の CloudTrail、AWS Config の記録、VPC フローログ、監査ログのアーカイブ（[ADR-0018](../decisions/0018-audit-log.md)）。S3 Object Lock で改ざんを防ぐ |
| shared | Infrastructure | ECR（コンテナイメージ）、Route 53 のホストゾーン、Amazon Managed Grafana、CI のデプロイ用ロールの起点 |
| dev | Workloads/NonProd | 開発環境。エージェントと開発者が自由に作り直せる |
| staging | Workloads/NonProd | 本番と同じ構成を小さくしたもの。負荷試験、カオス試験、リリース前の確認 |
| prod | Workloads/Prod | 本番。東京と大阪（災害復旧）の両方をこのアカウントに置く |

- **人のアクセスは IAM Identity Center に集める。** IAM ユーザーは作らない。本番への書き込み権限は Ops のグループだけに与え、緊急時のロール（break-glass）は使うたびに通知する。
- **SCP で次を禁止する。**
  - 東京・大阪以外のリージョンの利用（CloudFront・WAF・ACM のために us-east-1 のグローバルなサービスだけは許可する）
  - CloudTrail・GuardDuty・AWS Config の停止
  - root ユーザーの利用、組織からの離脱
- S3 のセル構成では、セルごとに prod のアカウントを分ける（7 節）。

## 2. ネットワーク

環境ごとに VPC を 1 つ持つ。すべて 3 AZ にまたがる。

| サブネット | 置くもの | インターネットへの経路 |
| --- | --- | --- |
| public | ALB、NAT ゲートウェイ | Internet Gateway |
| private | ECS のタスク（api、gateway、relay、workers） | NAT ゲートウェイ経由（許可したドメインのみ） |
| isolated | Aurora、ElastiCache | なし |

- **入口は CloudFront → ALB だけ。** ALB のセキュリティグループは、CloudFront のマネージドプレフィックスリストからの接続だけを許可する。CloudFront には AWS WAF を付ける。
- **CloudFront は WebSocket を扱える**（HTTP/1.1 のみ）。オリジンリクエストポリシーで `Sec-WebSocket-*` のヘッダーを転送する。CloudFront 経由の WebSocket のアイドル切断時間は **未検証**。Gateway は 25 秒ごとに心拍を送り、アイドル切断が起きないようにする。ALB のアイドルタイムアウトは心拍より十分長くする（例：120 秒）。
- **VPC エンドポイント**を使い、AWS のサービスへの通信を NAT に出さない：S3（ゲートウェイ型）、ECR、SQS、Secrets Manager、KMS、CloudWatch Logs、STS、X-Ray、AppConfig。
- **外向きの通信を制限する。** private サブネットからの外向きの通信は、AWS Network Firewall のドメインの許可リスト（Web Push の送信先、外部の IdP など）に限る。DNS は Route 53 Resolver DNS Firewall でも絞る。
- **リンクのプレビューの取得器（unfurler）は隔離する。** 任意の URL を取りに行くため、SSRF の踏み台になりうる（ADR-0016、[messaging.md](messaging.md)、[security.md](security.md)）。
  - unfurl の Worker（DB に書く側）は private サブネットに置き、外部の URL を取りに行く取得器だけを、**VPC に接続しない Lambda** にする（ADR-0016）。VPC の中の資源、VPC エンドポイント、DB へ、そもそも経路がない。送信元 IP は AWS の共有のものになり、他のサービスと分かれる。
  - 取得器の実行ロールは、ログの出力以外の AWS の権限を持たない。取得先がプライベート IP・リンクローカル・ループバックに解決されたら、取得器の中でも拒否する。
  - アプリへのイベントの配信とインタラクティブの呼び出し（[apps.md](apps.md)）も、同じ方式の外向き送信用の Lambda で行う。署名は VPC の中の Worker で済ませてから渡す（ADR-0031）。
- Gateway の接続先として、ALB のターゲットグループは gateway 専用にし、api と分ける。

## 3. ECS サービスとオートスケール

すべて Fargate（ARM64）で動かす。サービスごとにタスク定義と IAM ロールを分け、必要な権限だけを与える。

| サービス | 役割 | スケールの指標 | 最小タスク数 |
| --- | --- | --- | --- |
| api | HTTP API | CPU 使用率（目標 50%）、ALB のターゲットあたりのリクエスト数 | 3（AZ ごとに 1） |
| gateway | WebSocket の保持とファンアウト | **タスクあたりの接続数**（カスタムメトリクス、目標は上限の 60%）。CPU とメモリは上限として併用 | 3 |
| relay | outbox → Valkey・SQS | outbox の未処理件数と最古の行の経過時間 | 2（アクティブ 1、待機 1。詳細は [realtime.md](realtime.md)） |
| workers | 検索インデックス、通知、サムネイル、unfurl（DB に書く側）、アプリのイベントの振り分けと配信 | SQS の可視メッセージ数と最古のメッセージの経過時間。キューごとにサービスを分ける | 各 1〜2 |

- **Gateway は接続数でスケールする。** WebSocket は長く続くため、CPU では負荷が遅れて見える。スケールインは緩やかにし（クールダウンを長くする）、縮める台の接続を穏やかに移す（[ADR-0022](../decisions/0022-zero-downtime-deploy-and-migrations.md)）。
- **1 つの AZ を失っても足りる台数を常に持つ。** 各サービスは、残る 2 AZ で最大負荷をさばけるよう、平常時の使用率を 2/3 以下に保つ（NFR-007）。
- Gateway のターゲットグループは、登録解除の遅延を 180 秒にし、その間に接続を少しずつ移す（[realtime.md](realtime.md) の 3.5 節）。Fargate の停止猶予（`stopTimeout`）は最大 120 秒なので、SIGTERM の後に接続の移し替えを始めるのでは間に合わない。

## 4. S1 の構成と台数（初期見積もり）

S1（同時接続 5 万、最大ワークスペース 5,000 人）の本番の見積もり。すべて初期見積もりで、E7 の負荷試験で確定する。

| リソース | 構成 | 見積もりの根拠 |
| --- | --- | --- |
| Aurora PostgreSQL | writer `db.r8g.2xlarge` × 1、reader 同型 × 1（別の AZ）。I/O-Optimized | 投稿は全体で数百件/秒のピークを想定。reader はフェイルオーバー先を兼ねる |
| RDS Proxy | 使わない（S1） | 接続数は api のプールで足りる見込み。タスクが増えて接続数が問題になったら入れる |
| ElastiCache（Valkey） | `cache.r7g.large`、1 シャード、プライマリ 1＋レプリカ 2（3 AZ）、クラスタモード無効 | Pub/Sub のメッセージ量は小さい。ネットワーク帯域で決まる |
| gateway | 2 vCPU / 4 GB × 9 タスク | 1 タスク 1 万接続を上限とみなし、目標 60% と AZ 障害時の余裕を含める |
| api | 1 vCPU / 2 GB × 6 タスク | |
| relay | 0.5 vCPU / 1 GB × 2 タスク | |
| workers | 0.5〜1 vCPU × 計 6〜8 タスク | キューごとに 1〜2 |
| SQS | 標準キュー＋デッドレターキュー。キューごとに分ける | |
| S3 | ファイル用、Web 配信用、ログ用のバケットを分ける | |
| NAT ゲートウェイ | 一般用 × 3（AZ ごと） | 外部の URL への取得・配信は、VPC に接続しない Lambda で行うので NAT を通らない |
| public-api（E12） | 1 vCPU / 2 GB × 2 タスク | MVP の後。独立した ECS サービス（[public-api.md](public-api.md)） |
| mcp（E9） | 0.5 vCPU / 1 GB × 2 タスク | [mcp.md](mcp.md) |

staging は同じ構成を最小の台数（Aurora は writer のみ、各サービス 1〜2 タスク）で持つ。負荷試験のときだけ本番と同じ台数に広げる。dev はさらに小さくし、夜間と週末は止める。

## 5. バックアップと災害復旧

### 5.1 バックアップ

| 対象 | 方法 | 保持 |
| --- | --- | --- |
| Aurora | 自動バックアップ（PITR）。AWS Backup の連続バックアップ | 35 日 |
| Aurora（大阪へのコピー） | AWS Backup のスナップショットを 1 日 1 回、大阪へコピーする | 35 日 |
| S3（ファイル） | バージョニング、東京 → 大阪のレプリケーション（Replication Time Control 付き） | 削除から 30 日で古いバージョンを消す |
| Valkey | バックアップしない | 失われてもよい（[ADR-0002](../decisions/0002-db-as-source-of-truth-with-outbox.md)） |
| SQS | バックアップしない | outbox から再生成できる。消えたジョブは再インデックスなどで補う |

- AWS Backup の連続バックアップを別のリージョンへコピーすると、PITR できないスナップショットになる。大阪へのコピーは「最後の砦」とし、リージョン障害時の RPO はこれに頼らない（5.2）。
- バックアップ用の保管庫（vault）は、AWS Backup Vault Lock で削除を防ぐ。
- 暗号化は KMS のカスタマー管理キーで行う。大阪でも復号できるよう、マルチリージョンキーを使う（[ADR-0017](../decisions/0017-encryption-and-key-management.md)）。

### 5.2 災害復旧の戦略（段階ごと）

| 段階 | 戦略 | DB | RPO / RTO の目標 |
| --- | --- | --- | --- |
| S1 | パイロットライト（大阪） | Aurora Global Database。大阪の二次クラスタはインスタンスを持たない（headless）。ストレージだけを複製する | RPO 15 分、RTO 4 時間（NFR-008） |
| S2 | パイロットライト（大阪）。二次クラスタに reader を 1 台置く | 同上 | 同上。RTO の短縮を訓練で確かめる |
| S3 | ウォームスタンバイ（大阪）。各セルの最小構成を常時動かす | Aurora Global Database。二次クラスタに reader を置く | RPO 1 分、RTO 1 時間 |

- **S1 でも Aurora Global Database を使う。** バックアップの復元だけでは、コピーの頻度（1 時間ごとが下限）のため RPO 15 分を守れない。Aurora PostgreSQL は、Global Database 以外にリージョンをまたぐリードレプリカを持てない。
- Global Database のリージョン間の複製の遅延は、通常 1 秒未満である。計画外のフェイルオーバーでは、その時点の遅延ぶんだけデータを失う。計画的な切り替え（switchover）なら RPO 0。
- headless の二次クラスタは、インスタンスの料金がかからず、ストレージの料金だけになる。作成は CLI・API から行う（コンソールでは作れない）。大阪での Global Database と headless 構成の提供状況は **未検証**。着手前に確かめる。
- 大阪に常に置くもの：Aurora の二次クラスタ、ECR のイメージ（レプリケーション）、S3 のレプリカ、Secrets Manager のレプリカ、KMS のマルチリージョンキー、VPC とサブネット（空のまま）。ECS・ALB・Valkey・SQS は、切り替え時に Terraform で作る（状態ファイルは大阪のバケットにある。ADR-0020）。
- Valkey と SQS の中身は大阪へ複製しない。切り替え後、Relay が未配信の outbox から配信を再開する。実行中だったジョブは失われうるので、検索インデックスは差分の再構築で補い、通知の一部の欠落は許容する。
- 手順は [runbooks/disaster-recovery.md](../runbooks/disaster-recovery.md)。

### 5.3 AZ の障害（NFR-007）

| 部品 | 動き | 目安 |
| --- | --- | --- |
| Aurora | 別の AZ の reader へ自動フェイルオーバー。ストレージは 3 AZ に 6 重で複製されるので、コミット済みのデータは失わない | 数十秒〜1 分程度 |
| Valkey | レプリカへ自動フェイルオーバー。切り替え中の Pub/Sub は失われうる（差分取得で回復する） | 1 分前後 |
| ECS | 残る AZ でタスクを起動し直す。ALB が不健全なターゲットを外す | 数分 |
| Gateway | 失った AZ の接続が再接続してくる。クライアントは指数バックオフとジッターで再接続する | 数分 |

## 6. CI/CD

GitHub Actions でビルドとデプロイを行う。AWS への認証は OIDC で、長期のアクセスキーを持たない。

```
PR ─▶ CI（型検査、lint、テスト、migration lint、terraform plan とポリシー検査）
main へのマージ ─▶ イメージをビルド（1 回だけ） ─▶ shared の ECR へ push（タグは不変、digest で参照）
              ─▶ dev へ自動デプロイ ─▶ staging へ自動デプロイ ─▶ E2E・スモーク
              ─▶ prod へデプロイ（Ops の承認が必要）
```

- **1 回ビルドして、同じイメージを昇格させる。** 環境ごとに再ビルドしない。デプロイはイメージの digest で指定し、環境の違いは設定（SSM Parameter Store、Secrets Manager、AppConfig）で吸収する。
- **GitHub の Environments で守る。** `prod` の Environment には、Ops のグループを必須のレビュー担当者にし、`main` からのデプロイだけを許す。OIDC の信頼ポリシーも、`environment:prod` の主体だけが prod のデプロイ用ロールを引き受けられるようにする。
- **イメージを検査する。** ECR のスキャン（Amazon Inspector）で重大な脆弱性があれば、昇格を止める。
- **インフラは Terraform で、アプリのリリースは CI が行う**（[ADR-0020](../decisions/0020-infrastructure-as-code-with-terraform.md)）。インフラの変更は PR に `terraform plan` の結果を貼り、IAM・セキュリティグループ・KMS・データ層の変更は Ops のレビューを必須にする。アプリのリリースは、新しいタスク定義を登録して ECS のサービスを更新する。
- マイグレーションは、アプリのデプロイの前に 1 回だけ実行する ECS タスク（`migrator` ロール）で行う（[ADR-0022](../decisions/0022-zero-downtime-deploy-and-migrations.md)）。
- ブランチ・CI の各段・リリース（フラグ）の流れは [delivery.md](delivery.md)。
- 手順は [runbooks/deploy-and-rollback.md](../runbooks/deploy-and-rollback.md)。

## 7. 環境とデータ

| 環境 | 目的 | データ | デプロイ |
| --- | --- | --- | --- |
| local | 開発、エージェントの確認ループ | seed で生成 | Docker Compose |
| dev | 結合の確認、実験 | seed で生成。いつ消してもよい | `main` へのマージで自動 |
| staging | リリース前の確認、負荷・カオス試験 | seed と負荷試験用の生成データ（5,000 人規模のワークスペース） | dev の後に自動 |
| prod | 本番 | 本番データ | Ops の承認後 |

- **本番のデータを本番のアカウントの外に出さない。** staging・dev・local へのコピーや、匿名化したコピーも作らない。調査で本番のデータが必要なときは、prod のアカウントの中で、記録の残るロールを使って行う。
- 復元訓練も prod のアカウントの中の隔離した VPC で行い、終わったら消す（[runbooks/disaster-recovery.md](../runbooks/disaster-recovery.md)）。
- 合成監視用のワークスペースは、prod の中に専用のものを作る（[observability.md](observability.md)）。

## 8. 段階を上げる判断の基準

次のどれかに当たり、平常の運用で戻らない見込みになったら、次の段階への移行を始める。移行には四半期ほどかかる見込みなので、上限に達する前に始める。

| 指標 | S1 → S2 を始める目安 | S2 → S3 を始める目安 |
| --- | --- | --- |
| ピーク時の同時接続 | 3 万（S1 の上限の 60%）を 2 週続けて超える | 15 万を 2 週続けて超える |
| 最大ワークスペースの人数 | 5,000 人に近い顧客の契約見込みがある | 2 万人に近い顧客の契約見込みがある |
| Aurora writer の CPU（ピーク時の p95） | 60% を超える、またはインスタンスを 1 段上げても 6 か月もたない | 最大のインスタンスクラスで 60% を超える見込み |
| Aurora reader のレプリカ遅延 | 履歴取得の SLO を脅かす | — |
| Valkey のエンジン CPU・ネットワーク | 1 シャードの上限の 60% | シャードを増やしても Pub/Sub が偏る |
| 検索の p95 | 検索の目標（[search.md](search.md)）を超える | — |
| 1 テナントの占有 | 1 つのワークスペースが DB 時間の 30% を超え続ける（[runbooks](../runbooks/README.md) の 2 節） | 大口のテナントに専用のセルが必要になる |
| 障害の影響範囲 | — | 1 回の障害で全顧客が止まることが、契約上・SLO 上許容できなくなる（NFR-004 の 99.95%） |

S2 で行うこと：Aurora の reader を増やす、Valkey をクラスタモードにし sharded pub/sub を使う、検索を OpenSearch に移す（[ADR-0004](../decisions/0004-postgres-fulltext-search-first.md)）、Gateway を EC2 の起動タイプに移すかを負荷試験で判断する（[ADR-0011](../decisions/0011-aws-container-platform.md)）。

## 9. コストの概算（S1、本番、1 か月）

**大まかな見積もりである。** 東京リージョンのオンデマンド料金をもとにした、±50% 程度の幅を持つ値。データ転送量、ログの量、サポートプラン、税は見込みで置いている。Savings Plans とリザーブドインスタンスで 20〜30% 下げられる。

| 項目 | 月額（USD、概算） |
| --- | --- |
| ECS Fargate（約 35 vCPU・70 GB） | 1,500 |
| Aurora（r8g.2xlarge × 2、ストレージ、I/O-Optimized、Global Database の複製） | 2,500 |
| ElastiCache（r7g.large × 3） | 600 |
| CloudFront、ALB、データ転送 | 1,500 |
| NAT ゲートウェイ、Network Firewall | 1,000 |
| 可観測性（ログ、メトリクス、トレース、Grafana） | 1,500 |
| WAF、GuardDuty、Security Hub、Config、CloudTrail | 600 |
| バックアップ、S3、大阪の待機リソース | 500 |
| SES、SQS、Secrets Manager、KMS ほか | 300 |
| **本番の合計** | **約 10,000** |
| staging・dev・shared | 約 3,000 |

コストは、アカウントごとと、タグ（`service`、`env`）ごとに毎月見る。テナントごとの原価は、[observability.md](observability.md) の上位テナントの指標から按分して推定する。

## 10. S3 のセル構成

S3（同時接続 100 万）では、スタック一式を「セル」として複製し、ワークスペースをセルに割り当てる。決定は [ADR-0023](../decisions/0023-cell-based-architecture.md)（proposed）。

```
                     ┌──────────────────────────────────────┐
  Browser ─ login ──▶│ Global（セルの外）                    │
     │               │  - アカウントと認証（identity）         │
     │               │  - ワークスペースの一覧、workspace→cell │
     │               │  - 課金                                │
     │               └──────────────────────────────────────┘
     │  cell のエンドポイントを受け取る
     ▼
  CloudFront ─▶ cell-01（api / gateway / relay / workers / Aurora / Valkey / 検索）
             ─▶ cell-02 ...
             ─▶ cell-big-01（大口のワークスペース専用）
```

### 10.1 ルーティング

- **Global のサービスが、workspace → cell の対応表を持つ。** ログイン後に、クライアントは自分が属するワークスペースと、それぞれのセルのエンドポイント（例：`c01.api.example.com`）を受け取る。
- API と Gateway の URL は、セルのホスト名を直接使う。パスの `workspace_id` と、セルが持つワークスペースが一致しなければ、セルは 421 を返し、クライアントは Global から対応表を取り直す（ワークスペースの移動中への備え）。
- エッジ（CloudFront Functions と KeyValueStore）で、パスの `workspace_id` からオリジンを選ぶ方式も併用できる。CloudFront Functions でオリジンを切り替えられるかは **未検証**。
- 対応表は Global の DB を正本とし、各セルにはキャッシュとして配る。Global が止まっても、ログイン済みのクライアントはセルと直接話し続けられる。

### 10.2 セルの外に置くもの

| もの | 理由 |
| --- | --- |
| アカウント、認証、セッションの発行（[identity-and-access.md](identity-and-access.md)） | 1 人が複数のセルのワークスペースに属する（[ADR-0010](../decisions/0010-accounts-and-workspace-members.md)） |
| workspace → cell の対応表、アカウント → ワークスペースの一覧 | ログイン直後に、どのセルへ行くかを決めるため |
| 課金、全体の運用ダッシュボード | テナントをまたぐため |

セルの中のサービスは、Global に毎リクエスト問い合わせない。セッションは不透明なトークンで、正本は DB にある（[identity-and-access.md](identity-and-access.md)）。S3 では正本を Global に移し、セルは検証の結果を短時間（例：60 秒）キャッシュする想定である。Global が止まったときに、キャッシュの切れたセッションをどう扱うかは、ADR-0023 で決める（未決定）。

### 10.3 セルの大きさ

- 1 セルは、S1〜S2 の構成を 1 つ持つ：同時接続 15 万以下、Aurora の writer のピーク CPU 50% 以下、ワークスペースの人数の合計に上限を置く。
- 100 万接続なら、共有のセルを 8〜10 個と、大口のワークスペース専用のセルを必要なだけ持つ。
- セルごとに prod のアカウントを分ける。AWS のクォータと、障害・権限の影響範囲を、セル単位に閉じるため。
- 新しいワークスペースは、空きのあるセルへ割り当てる。セルが目安の 70% に達したら、新規の割り当てを止め、新しいセルを作る。

### 10.4 ワークスペースをセル間で移す

すべてのテナントデータが `workspace_id` を持つので（[ADR-0009](../decisions/0009-pooled-tenancy-with-rls.md)）、ワークスペース単位で切り出せる。`seq` と ID はそのまま移すので、クライアントの状態は移動後も使える。

1. 移動先のセルに、そのワークスペースの行をまとめてコピーする（`workspace_id` で絞ったスナップショット）。
2. 変更を追いかけて反映する（PostgreSQL の論理レプリケーションの行フィルタを使う想定。方式は **未検証**）。
3. 書き込みを短時間止める（ワークスペースを読み取り専用にする。目標は 1 分以内）。outbox を移動元で出し切り、両方のセルで件数と各チャンネルの `last_seq` を突合する。
4. 対応表を切り替える。移動元の Gateway はそのワークスペースの接続を切り、クライアントは新しいセルへ再接続して差分取得で追いつく。
5. 検索インデックスは移動先で作り直す。ファイルは S3 のキーが `ws/{workspace_id}/` で始まるので、プレフィックス単位でコピーする。
6. 一定期間後に、移動元のデータを消す。

移動の手順は、S3 に入る前に runbook として用意し、staging で訓練する。

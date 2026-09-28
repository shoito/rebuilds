# Infrastructure: ServiceNow

AWS のアカウントとネットワーク、セルの構成とルーター、メールの受信の振り分け、専用のセルとテナントのセル間の移動、冗長化と災害復旧、Terraform の配置、段階を上げる基準、コストを決める。他の題材（Slack・Auth0 の infrastructure.md）を土台にし、この題材に固有の事情（セル、メタデータ駆動、タイマー、メール、検索）だけを変える（[ADR-0001](../decisions/0001-platform-and-stack.md)）。

前提の決定は、共有のセルと専用のセルを同じコード・同じ版で動かし、ルーターはテナントのデータを読まずにホスト名 → テナント → セルを解決すること（[ADR-0002](../decisions/0002-tenancy-and-isolation.md)）、S1 は東京の 1 リージョン・3 AZ で共有のセル 2 つ、セルごとに Aurora の writer 1 台＋reader 2 台、大阪にウォームスタンバイ（[architecture/README.md](README.md) の 2 節）、NFR-006〜009 である。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0055](../decisions/0055-accounts-cells-and-edge-router.md) | セルごとに AWS アカウントを分け（共有のセルも）、制御の面・エッジ・メールの受信の入口を別のアカウントに置く。ルーターは CloudFront Functions と KeyValueStore でホスト名からセルのオリジンを選び、解決できないホスト名は 404 にする。セルの App はテナントを解決し直して、そのセルのテナントでなければ 421 にする |
| [0056](../decisions/0056-dedicated-cells-and-tenant-moves.md) | 専用のセルは、1 つの顧客のための同じ形のセル（専用のアカウント・DB・キャッシュ・検索のドメイン・鍵・受信のサブドメイン）にする。テナントのセル間の移動は、テナントの行の写し → 短い書き込みの停止と差分 → ルーターの切り替え → 索引の作り直し、の手順で行い、S1 の 2 つの共有のセルの間で訓練する |
| [0057](../decisions/0057-disaster-recovery-per-cell.md) | DR はセルごとに大阪のウォームスタンバイ（Aurora Global Database、S3 のレプリケーション、最小のタスク、空の検索のドメイン）を持ち、人の判断で切り替える。切り替えの後、索引は DB から作り直し、失った範囲の受信のメールは S3 の原本から冪等に取り込み直す |
| [0058](../decisions/0058-terraform-layout-stages-and-cost.md) | Terraform はセルを 1 つのモジュールとして持ち、セルの一覧（制御の面の台帳と同じもの）から作る。段階を上げる基準と、セル・アカウント・タグでの費用の配分を決める |

数値のうち「初期見積もり」と書いたものは、E12 の負荷試験の前の仮の値である。台数の根拠は [capacity.md](capacity.md)、ログ・メトリクスは [observability.md](observability.md)、CI とリリースは [delivery.md](delivery.md)、統制と暗号化は [security.md](security.md) にある。AWS の仕様で確かめていないものは「未検証」と書く。

## 1. AWS アカウントの構成（[ADR-0055](../decisions/0055-accounts-cells-and-edge-router.md)）

| アカウント | OU | 中身 |
| --- | --- | --- |
| management | Root | Organizations、SCP、IAM Identity Center、請求 |
| security | Security | GuardDuty・Security Hub・Inspector の委任管理者、調査用のロール |
| log-archive | Security | 組織の CloudTrail、Config、VPC フローログ、監査のハッシュの鎖、プラットフォームの監査（[security.md](security.md) の 6 節）。Object Lock。東京 → 大阪へレプリケーション |
| shared | Infrastructure | ECR（東京・大阪にレプリケーション）、Route 53（`<brand>.<domain>`）、Managed Grafana、Terraform の状態のバケット |
| edge | Infrastructure | CloudFront の配信、WAF、ACM（us-east-1）、ルーターの関数と KeyValueStore、静的な資産（`cdn`） |
| control | Workloads/Prod | 制御の面：テナントの台帳（ホスト名・受信のアドレス → テナント → セル）、テナントの作成・移動・削除、フラグの配布（AppConfig）、課金の集計。小さな Aurora と ECS |
| mail-ingress | Workloads/Prod | SES の受信（東京・大阪）、受信の一時のバケット、`mail-router`（2.3 節） |
| cell-s01、cell-s02 | Workloads/Prod | 共有のセル（S1 は 2 つ） |
| cell-d{nn} | Workloads/Prod | 専用のセル（S2 から。顧客ごと） |
| dev、staging | Workloads/NonProd | 開発・検証。staging は 2 つのセルと制御の面を最小の台数で持つ |

- **セルごとにアカウントを分ける。** 共有のセルも同じ。セルの障害・誤操作・サービスのクォータの影響をセルに閉じる。専用のセル（顧客ごとのアカウント）と同じ形にすれば、共有と専用で Terraform のモジュールが 1 つで済む。
- **SCP**（Workloads の OU）：東京・大阪以外のリージョンを禁止する（CloudFront・WAF・ACM・IAM のための us-east-1 のグローバルなサービスを除く）。CloudTrail・Config・GuardDuty の停止、KMS の鍵の削除の予約・無効化を break-glass のロール以外に禁止する。データの所在の約束の範囲は法務の L3（[security.md](security.md) の 14 節）。
- セルのアカウントから他のセルのアカウントへの経路・ロールの引き受けを持たない。制御の面からセルへは、テナントの作成・移動のための限られた API（セルの `platform` の処理を呼ぶ）だけ。

## 2. ネットワーク

### 2.1 セルの VPC（東京・大阪で同じ形）

| サブネット | 置くもの | インターネットへの経路 |
| --- | --- | --- |
| public | ALB、NAT ゲートウェイ | Internet Gateway |
| private | App、Engine、Ingest、Notifier（メール・プッシュ）、Indexer、Relay | NAT 経由。Network Firewall で宛先を許可の一覧に限る（SES の API、Web Push の配信のサービス、内閣府の CSV（祝日の取り込み）） |
| egress | `notifier-egress`（Webhook とフローの呼び出し：テナントの任意の URL） | 専用の NAT（固定の Elastic IP）。DB・キャッシュへの経路を持たない |
| isolated | Aurora、ElastiCache（Valkey）、OpenSearch | なし |

- 入口は CloudFront → ALB だけ。ALB のセキュリティグループは CloudFront のマネージドプレフィックスリストだけを許し、CloudFront が付ける秘密のヘッダーを ALB のリスナーの規則で検査する（SEC-001）。
- VPC エンドポイント：S3、ECR、SQS、SNS、KMS、Secrets Manager、CloudWatch Logs、STS、X-Ray、AppConfig、SES（送信）。
- `notifier-egress` は、Webhook の宛先の名前を解決した後の IP を検査し、プライベート・リンクローカル・メタデータのアドレスへは送らない（SEC-073）。egress の NAT の固定の IP をテナントに公開する（受け手の許可の一覧のため）。

### 2.2 ホスト名

| ホスト名 | 中身 |
| --- | --- |
| `<tenant>.<brand>.<domain>` | 作業の画面、ポータル、API（ルーターでセルへ） |
| `cdn.<brand>.<domain>` | 静的な資産（テナントに依らない） |
| `in.<brand>.<domain>` | 受信のアドレスのドメイン（MX は mail-ingress の SES） |
| `notify.<brand>.<domain>` | 送信のドメイン（SES の送信。各セルのアカウント） |
| `status.<brand>.<domain>` | ステータスのページ（本システムの外の事業者。障害のときも見られるように） |

- テナントの独自のドメイン（カスタムドメイン）は MVP で持たない（持ち越し）。

### 2.3 メールの受信の振り分け

```
顧客のメールサーバー ─▶ SES（mail-ingress。東京。受信の規則：*@in.<brand>.<domain>）
   ─▶ S3（mail-ingress の一時のバケット。SSE-KMS。1 日で消える）─▶ SNS ─▶ SQS ─▶ mail-router
        mail-router：封筒の受け手 → テナント → セル（制御の面の台帳の写し）
                     セルの受信のバケットへ写し、セルの SQS へ送り、一時のオブジェクトを消す
                     解決できない受け手：捨てて記録する（送り主へのバウンスはしない。後方散乱を避ける）
   ─▶ セルの Ingest（[notifications-and-email-ingest.md] の 5 節の流れ）
```

- SES の受信の規則は、受け手のアドレス・ドメインで選ぶ。テナントの受信のアドレスは同じドメイン（`in.<brand>.<domain>`）の下にあるので、受信の規則の段でセルのバケットを選ぶには、テナントごとに規則を持つことになる（受信の規則は 1 つの規則の集合に 200 まで、1 つの規則の受け手は 500 まで、規則の集合はアカウントに 40 までで、どれも引き上げられない。[Service quotas in Amazon SES](https://docs.aws.amazon.com/ses/latest/dg/quotas.html)、2026-09-28 に確認）。S3 の 3 万テナントは規則に収まらない。そこで、共有の入口に置いてから、`mail-router` がセルへ振り分ける。
- 一時のバケットには、全テナントの原本が数秒から数分だけ置かれる。読めるのは `mail-router` のロールだけで、中身を解析しない（封筒の受け手は SES の通知から読む）。
- 専用のセルは、この共有の入口を通さず、専用の受信のサブドメインで受ける（4.1 節）。
- notifications-and-email-ingest の 5.1 節と [ADR-0034](../decisions/0034-inbound-email-threading-and-sender-trust.md) は、統合でこの節の形に合わせた。

## 3. セルとルーター（[ADR-0055](../decisions/0055-accounts-cells-and-edge-router.md)）

### 3.1 ルーター

```
利用者 ─▶ CloudFront（*.<brand>.<domain>、WAF）
            │ ビューアーの要求の CloudFront Function（JavaScript のランタイム 2.0）
            │   host = 要求のホスト名
            │   cell = KeyValueStore.get(host)          ← 制御の面が書く（テナントの作成・移動・削除）
            │   なし → 404（どのセルにも送らない）
            │   あり → cf.selectRequestOriginById(cell のオリジン)。元のホスト名をヘッダーに付ける
            ▼
         セル cell-s01 の ALB ─▶ App：元のホスト名からテナントを解決し直す（制御の面の台帳の写し）
                                     このセルのテナントでなければ 421（SEC-002）
```

- CloudFront Functions は、KeyValueStore を読み（関数のランタイム 2.0 と `cf.kvs()`）、`updateRequestOrigin()`・`selectRequestOriginById()` で要求のオリジンを変えられる（[Helper methods for origin modification](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/helper-functions-origin-modification.html)、[Amazon CloudFront KeyValueStore](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/kvs-with-functions.html)、2026-09-28 に確認）。
- **ルーターの処理の経路に、同期の依存（制御の面の API）を置かない。** 対応表はエッジの KeyValueStore にあり、制御の面が落ちてもルーターは動く（[ADR-0002](../decisions/0002-tenancy-and-isolation.md) の「ルーターは対応表のキャッシュで、制御の面が落ちても動き続ける」を、エッジのキャッシュで満たす）。
- KeyValueStore は 1 つのストアが 5 MB、キーが 512 バイト、値が 1 KB まで、1 つの関数に 1 つのストアである（[CloudFront quotas](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html)、2026-09-28 に確認）。S1 は 300 テナント（1 件 100 バイト程度）で小さい。S3 の 3 万テナントは約 3 MB で収まるが余裕が小さいので、S3 の前にセルの群ごとに配信と KeyValueStore を分ける。書き込みがエッジに届くまでの時間は公式の文書に数値がなく、未検証（E1 `edge-router-kvs` で計測し、下のテナントの移動の「数十秒」を直す）。
- 1 つの配信に置けるオリジンは 100 まで（引き上げ可。同上）で、これがセルの数の上限になる。S1・S2 は 1 つの配信、S3 はセルの群ごとに配信を分ける（[ADR-0058](../decisions/0058-terraform-layout-stages-and-cost.md) の段階の基準）。
- セルの App は、制御の面の台帳の写し（ホスト名 → テナント → セル）を、起動の時に全件読み、以後は制御の面の変更の事象（SNS）で更新する。事象を落としても、5 分ごとの全件の読み直しで追いつく。
- テナントの移動（4 節）の切り替えの間は、古いセルが 421 を返し、画面と API の SDK は 1 回だけ送り直す（エッジの対応表が新しいセルを指すまでの数十秒）。

### 3.2 セルの中身

| 部品 | 置き場所 |
| --- | --- |
| App・Engine・Ingest・Notifier・`notifier-egress`・Indexer・Relay | ECS Fargate（ARM64）。サービスごとにタスク定義と IAM ロール |
| Aurora PostgreSQL 18 | writer 1 台＋reader 2 台（reader A：画面・API・検索の確かめ直し。reader B：レポート。[reports.md](reports.md) の 4.1 節） |
| ElastiCache（Valkey） | クラスタモード。失われてもよい |
| OpenSearch Service | 3 AZ のデータのノードと専用のマスター。Sudachi のパッケージ（[search.md](search.md) の 4 節） |
| SQS | 事象の種類ごとの標準のキュー＋DLQ |
| S3 | 添付、受信のメールの原本、エクスポート、取り込みの原本。大阪へレプリケーション |
| SES（送信） | セルのアカウントで `notify.<brand>.<domain>` から送る。構成のセットでバウンス・苦情を SNS へ |
| KMS | セルの鍵（[security.md](security.md) の 5.2 節） |

### 3.3 ECS のサービス

| サービス | 役割 | スケールの指標 | 最小タスク数（S1、1 セル） |
| --- | --- | --- | --- |
| app | 画面のモデル、REST API、ポータル、検索の問い合わせ、レポートの問い合わせ | CPU 50%、ターゲットあたりの同時要求数 | 6（AZ ごとに 2） |
| engine | タイマーの取得と処理（フロー・承認・SLA・呼び出し）、`bulk_job`、日次のジョブ | タイマーの遅れの p99（優先度 0）、DB の CPU を見て上限 | 3 |
| ingest | メールの受信、CMDB の取り込み、取り込みの解析 | SQS の最古のメッセージの経過時間 | 2 |
| notifier | 通知（メール・プッシュ）、定期のレポートの配信 | SQS の最古のメッセージの経過時間 | 2 |
| notifier-egress | Webhook、フローの呼び出し | 同上、同時送信数 | 2 |
| indexer | 索引への反映 | SQS の最古のメッセージの経過時間 | 2 |
| relay | outbox → SQS | outbox の最古の行の経過時間 | 2（アクティブ 1、待機 1） |

## 4. 専用のセルとテナントの移動（[ADR-0056](../decisions/0056-dedicated-cells-and-tenant-moves.md)）

### 4.1 専用のセル

- 1 つの顧客（とその子会社のテナント群、本番とサブプロダクション）だけを置く、共有のセルと同じ形のセル。専用のアカウント・VPC・Aurora・Valkey・OpenSearch のドメイン・S3・KMS の鍵を持つ（NFR-009）。
- **同じコード・同じ版で動かす。** デプロイは共有のセルの後の段（[delivery.md](delivery.md) の 6 節）。
- 受信のメールは、専用のセルの受信のサブドメイン（`<cell>.in.<brand>.<domain>`）で、専用のセルのアカウントの SES で受ける（2.3 節の共有の入口を通さない）。
- 大きさは顧客の規模で決め、最小の構成（Aurora の writer `db.r8g.2xlarge`＋reader 1、Valkey 1 シャード、OpenSearch 3 ノード）から始める。
- 専用のセルを出す条件（社員の数、料金、契約の最低の期間）は PM が E12 の前に決める（[intent.md](../intent.md)）。

### 4.2 テナントの移動

```
1. 準備：移動の先のセルに、テナントの行を tenant_id で絞って写す（platform のロール。論理のダンプ・読み込み、表ごと）
         S3 のテナントの接頭辞を写す（S3 Batch Operations）
2. 追いつき：写しの後の変更を、監査の履歴と outbox の事象で差分として当てる（または 2 回目の写し）
3. 停止：テナントを「移動中」にし、書き込みを止める（503 と Retry-After。目標 5 分以内）
         タイマーの取得からテナントを外す。受信のメールは SQS に溜める
4. 最後の差分を当て、件数とハッシュで両方を突き合わせる
5. 切り替え：制御の面の台帳と KeyValueStore のホスト名 → 新しいセル、受信の対応表を切り替える
6. 再開：新しいセルでタイマーの取得を始める（期限の過ぎたものから）。溜めたメールを新しいセルへ流す
7. 索引：新しいセルで DB から作り直す（検索は作り直しの間、新しい行だけ）
8. 後始末：古いセルのテナントの行・S3・索引・キャッシュを、7 日の後に消す（戻すための猶予）
```

- 番号の数の行（`number_counter`）、`meta_version`・`acl_version`、タイマー、SLA の計時の行も同じ手順で写す。タイマーの `due_at` は絶対の時刻なので、そのまま写す。
- 移動の訓練を、S1 の 2 つの共有のセルの間で E12 の前に通す（[ADR-0002](../decisions/0002-tenancy-and-isolation.md) の Confirmation）。手順の詳細と自動化は E12 の Story。

## 5. S1 の構成と台数（初期見積もり）

1 つの共有のセル（S1 の負荷の半分）の本番。根拠は [capacity.md](capacity.md)。

| リソース | 構成 | 根拠 |
| --- | --- | --- |
| Aurora PostgreSQL 18 | writer `db.r8g.4xlarge` × 1、reader 同型 × 2（別の AZ）。I/O-Optimized。大阪の Global Database の二次に reader 同型 × 1 | 書き込みのピーク 約 6,000 行/秒、9 時のタイマーの山（[capacity.md](capacity.md) の 2 節） |
| RDS Proxy | 使わない | `SET LOCAL` のテナントのコンテキストで接続が固定される（Slack・Auth0 と同じ） |
| ElastiCache（Valkey） | `cache.r7g.large`、クラスタモード 2 シャード × （プライマリ 1＋レプリカ 1） | 辞書・ACL のコンパイル済みのキャッシュ、セッション、レート制限、レポートの結果 |
| OpenSearch Service | データ `r7g.xlarge.search` × 3（3 AZ）、gp3 各 300 GB。専用のマスター `m7g.large.search` × 3 | 主 約 140 GB、レプリカ 1（[search.md](search.md) の 5.3 節） |
| app | 2 vCPU / 4 GB × 12（ピーク）、最小 6、最大 40 | API のピーク 1,000 件/秒（セルあたり） |
| engine | 2 vCPU / 4 GB × 6（ピーク）、最小 3、最大 24 | 9 時のタイマーの山 |
| ingest、notifier、notifier-egress、indexer、relay | 1 vCPU / 2 GB × 計 14（ピーク）、最大 50 | |
| SQS | 標準のキュー＋DLQ。キューごと | |
| NAT ゲートウェイ | private × 3、egress × 3（東京）。大阪は各 1 | |
| 大阪（ウォームスタンバイ） | 各サービスを最小 1 タスク（engine・app は 2）、Aurora の二次に reader 1 台、Valkey は小さい別のクラスタ、OpenSearch は `r7g.large.search` × 2（空） | 6.3 節 |

制御の面（control）は、Aurora `db.r8g.large` の writer＋reader（大阪に Global Database の二次）、ECS の小さなサービス。mail-ingress は SES の受信、一時のバケット、`mail-router`（0.5 vCPU × 2）。staging は同じ構成を最小の台数で持ち、負荷試験のときだけ本番と同じ台数に広げる。dev は夜間と週末に止める。

## 6. バックアップと災害復旧（[ADR-0057](../decisions/0057-disaster-recovery-per-cell.md)）

### 6.1 バックアップ

| 対象 | 方法 | 保持 |
| --- | --- | --- |
| Aurora（セル・制御の面） | 自動バックアップ（PITR）＋ AWS Backup の連続バックアップ。Vault Lock | 35 日（[ADR-0053](../decisions/0053-data-retention-and-deletion.md)） |
| S3（添付・原本） | バージョニング＋大阪へのレプリケーション | 保持の期間（[security.md](security.md) の 9 節） |
| 監査のハッシュの鎖、プラットフォームの監査 | log-archive（Object Lock） | 7 年 |
| OpenSearch | 自動のスナップショット（サービスの既定）。復旧は DB からの作り直しを正とする | サービスの既定 |
| Valkey、SQS | バックアップしない | 失ってよい。SQS は outbox から作り直す |

### 6.2 AZ の障害（NFR-007：RPO 0、RTO 5 分）

| 部品 | 動き | 目安 |
| --- | --- | --- |
| Aurora | 別の AZ の reader（A を優先）へ自動でフェイルオーバー。コミット済みのデータは失わない | 通常 60 秒未満（Auth0 の infrastructure.md の 6.2 節で確認した AWS の文書による） |
| フェイルオーバーの間 | 保存は 503。タイマーの発火は止まり、復旧の後に期限の古い順に発火する。SLA の `breached_at` は期限の時刻なので、遅れても違反の時刻は正しい | 数十秒 |
| ECS | 残る AZ でタスクを起動し直す。平常の使用率を 2/3 以下に保つ | 数分 |
| OpenSearch | 3 AZ のレプリカで続ける | — |
| Valkey | レプリカの昇格。その間、キャッシュは DB から作る | 数十秒 |

### 6.3 リージョンの障害（NFR-008：RPO 1 分、RTO 1 時間。S2 で RTO 15 分）

- S1 から、**セルごとに**大阪にウォームスタンバイを持つ。制御の面と mail-ingress も同じ。
- **切り替えは人が判断する**（インシデントの指揮者が判断し、Ops の責任者が承認する）。手順は [runbooks/disaster-recovery.md](../runbooks/disaster-recovery.md)。

| 部品 | 大阪に常に置くもの | 切り替えの後 |
| --- | --- | --- |
| Aurora | Global Database の二次（reader 1 台） | 昇格（東京が生きていれば switchover で RPO 0、応答しなければ `--allow-data-loss` の failover）。writer の後に reader を足す |
| ECS | 各サービスの最小のタスク | 台数を東京の平常に上げる（Fargate のクォータを大阪でも東京と同じにしておく） |
| S3 | レプリケーションの先のバケット | そのまま使う |
| OpenSearch | 空の小さなドメイン | ノードを増やし、`kb`・`catalog` を先に、`task`・`ci`・`record` を後から DB で作り直す（[search.md](search.md) の 9 節） |
| Valkey | 空の小さなクラスタ | 空から使う |
| SES の受信 | mail-ingress の大阪の受信の規則とバケット | MX を大阪へ切り替える（Route 53 の重み付け。TTL 300 秒） |
| SES の送信 | 大阪のセルのアカウントの送信の設定（DKIM を含む） | 送信の設定を大阪へ |
| ルーター | エッジ（グローバル）。セルのオリジンに大阪の ALB を登録済み | KeyValueStore の値は変えず、セルのオリジンの定義を大阪に向ける（`active_region`） |
| KMS | マルチリージョンの鍵のレプリカ | そのまま使う |

- 事実：Aurora Global Database の計画外のフェイルオーバーの RPO は通常は秒の単位で、複製の遅れの分を失う。switchover は RPO 0（Auth0 の [infrastructure.md](../../../auth0/docs/architecture/infrastructure.md) の 6.3 節で 2026-09-27 に確認した AWS の文書による）。
- `AuroraGlobalDBRPOLag` が 10 秒を超えたら呼び出す（[observability.md](observability.md)）。

### 6.4 失った範囲の扱い

切り替えの後、東京で最後の数秒〜1 分にコミットした書き込みを失う。

| 失ったもの | 起きること | 回復 |
| --- | --- | --- |
| 受信のメールから作ったレコード・追記 | レコードがない | **S3 の原本から取り込み直す。** 東京の障害の時刻の前 10 分の受信の原本（大阪へ複製済みのもの）を、Ingest に流し直す。`(tenant_id, ses_message_id)` の一意で、大阪にすでにあるものは飛ばす（[ADR-0034](../decisions/0034-inbound-email-threading-and-sender-trust.md)） |
| 画面・API での作成・更新 | 失う | テナントへ告知する（時刻の範囲を示す）。API のクライアントは冪等のキーで送り直せる（キーの行も失っているので、2 回目は新規として処理される） |
| 承認の回答 | 回答の前に戻る | 承認者に「もう一度回答してください」を通知する（承認の行の版で 1 回だけ反映されるので二重にならない） |
| タイマーの発火（SLA の警告・違反、フローのステップ） | 発火の前に戻る | 大阪でもう一度発火する。違反の通知が 2 回届きうる（通知の一意の行も失っているため）。告知に含める |
| 送ったメール・Webhook | 送ったが記録がない | 同じ事象で送り直しうる（受け手の冪等に頼る。Webhook の配達の ID は同じ事象から作るので同じ） |
| 監査のハッシュの鎖 | その日の行が失われた範囲で、東京の鎖（S3 に置いた日の分）と大阪の DB が合わない | その日の鎖の検証に「DR による欠け」の注記を足す（プラットフォームの監査に範囲を残す）。改ざんと区別する |

- S3 のレプリケーションの遅れの分の原本（未複製）は、大阪で取り込み直せない。顧客のメールサーバーの再送（SMTP の一時の失敗）で届き直すものもある。S3 のレプリケーションの時間の保証（RTC）を使うかは、費用と一緒に E12 で決める（持ち越し）。

### 6.5 大阪の待機の構成の確認

| 確認 | 頻度 |
| --- | --- |
| 大阪の ALB へ直接の合成監視（監視用のテナント） | 1 分 |
| 大阪の Terraform の plan に差分がない | 日次 |
| KMS のレプリカ、ECR・Secrets Manager のレプリカの同期 | 日次 |
| Fargate・OpenSearch・SES のクォータが大阪でも東京と同じ | 月次 |
| 索引の作り直しの時間（staging の大阪で） | 四半期の訓練 |

## 7. CI/CD と Terraform（[ADR-0058](../decisions/0058-terraform-layout-stages-and-cost.md)）

### 7.1 CI/CD

他の題材と同じ（GitHub Actions、OIDC、1 回ビルドして同じイメージを昇格させる、prod は Ops の承認）。この題材に固有の点（セルごとの段階的なデプロイ、リリースの前の全テナントのメタデータのコンパイルの検査）は [delivery.md](delivery.md)。

```
main へのマージ ─▶ ビルド ─▶ shared の ECR ─▶ dev ─▶ staging（E2E・障害注入・k6）
  ─▶ prod：control ─▶ cell-s01（カナリアのセル）─▶ cell-s02 ─▶ 専用のセル（Ops の承認を各段で）
```

### 7.2 Terraform の配置

開発リポジトリの `infra/` に置く。状態ファイルは shared のバケット（東京、大阪へレプリケーション）。

| ルートモジュール | 中身 | 変更の承認 |
| --- | --- | --- |
| `org/` | Organizations、SCP、Identity Center、アカウントの作成（セルのアカウントを含む） | Ops の責任者＋セキュリティの担当 |
| `security/` | GuardDuty、Security Hub、Config、log-archive | 同上 |
| `global/edge` | CloudFront の配信、WAF、ACM、ルーターの関数、KeyValueStore（中身は制御の面が書く。Terraform は入れ物だけ）、変数 `active_region`（セルごと） | Ops（WAF とルーターの関数は `security:sensitive`） |
| `global/dns` | Route 53（`in`・`notify`・`cdn`・`status`） | Ops |
| `control/{region}` | 制御の面 | Ops |
| `mail-ingress/{region}` | SES の受信、一時のバケット、`mail-router` | Ops |
| `cell/{cell_id}/{region}` | **セルのモジュール 1 つ**（VPC、Aurora、Valkey、OpenSearch、S3、SQS、SES の送信、KMS、ECS）。変数：セルの種類（共有・専用）と大きさ | Ops。KMS・IAM は `security:sensitive`。状態を持つリソースの削除・置き換えは CI で拒否 |

- **セルの一覧は 1 か所に持つ。** `infra/cells.yaml`（セルの ID、種類、大きさ、アカウント、主のリージョン）から、`cell/*` のルートモジュールの実体を作る。制御の面の台帳のセルの一覧と、CI で突き合わせる。
- plan のポリシー検査（OPA・Checkov）：isolated のサブネットの経路表に NAT・IGW がない、`tenant-secrets` の鍵の `Decrypt` を決めたタスクのロール以外に与えない、Aurora の暗号化と削除の保護、S3 のパブリックアクセスのブロック、OpenSearch のドメインが VPC の中。

## 8. 環境とデータ

| 環境 | 目的 | データ |
| --- | --- | --- |
| local | 開発、エージェントの確認ループ | seed（本物の個人情報を使わない。[AGENTS.md](../../AGENTS.md)） |
| dev | 結合の確認 | seed |
| staging | リリースの前の確認、負荷・障害試験、DR の訓練、セルの移動の訓練 | 生成データ（テナント 300、社員 100 万相当、`task` 7,000 万行） |
| prod | 本番 | 本番。サブプロダクションのテナント（テナントの `environment`）も本番の基盤に置く（[ADR-0002](../decisions/0002-tenancy-and-isolation.md)） |

- 本番のデータを本番のアカウントの外に出さない。匿名化したコピーも作らない。
- 合成監視のために、各セルに社内の監視用のテナントを置く（[observability.md](observability.md) の 6 節）。

## 9. 段階を上げる基準（[ADR-0058](../decisions/0058-terraform-layout-stages-and-cost.md)）

次のどれかに当たり、戻らない見込みになったら、次の段階への移行を始める。

| 指標 | 新しい共有のセルを足す目安 | S1 → S2 を始める目安 |
| --- | --- | --- |
| セルの Aurora の writer の CPU（ピークの p95） | 60% を超える、または 1 段上げても 6 か月もたない | 最大のクラスでも 60% を超える見込み |
| セルのタイマーの遅れ（優先度 0 の p99） | 9 時の山で 30 秒を超える | — |
| セルのテナントの数 | 200（初期見積もり。E12 の負荷試験で決める） | — |
| 1 テナントの占有 | 1 テナントがセルの書き込みの 30% を超え続ける | 専用のセルが要る大口の契約の見込み |
| レポートの reader B | [reports.md](reports.md) の 4.3 節の基準 | 分析の専用のクラスタへ |
| `task` の表 | 1 セルで 2 億行（vacuum と索引の大きさ。[ADR-0007](../decisions/0007-physical-layout-and-extension-index.md)） | パーティションの分け方の見直し |
| リージョンの切り替え | — | RTO 1 時間を、大口のテナントが契約で許さない（S2 は 15 分） |
| KeyValueStore・配信のオリジンの数 | 上限の 70% | セルの群ごとに配信を分ける（S3 の準備） |

- セルを足すのは、Terraform の `cells.yaml` に 1 行を足し、新しいテナントの割り当ての先に加えることで行う。既存のテナントを動かすのは、偏りがあるときだけ（4.2 節の移動）。

## 10. コストの概算（S1、本番、1 か月）

**大まかな見積もりである。** ±50% の幅。データ転送、ログの量、サポートプラン、税は含めない。東京の単価は AWS の Price List API で 2026-09-28 に確認した値（オンデマンド）：Aurora PostgreSQL I/O-Optimized `db.r8g.4xlarge` 1 時間 3.464 USD、`db.r8g.2xlarge` 1.732 USD、OpenSearch `r7g.xlarge.search` 0.429 USD・`r7g.large.search` 0.214 USD・`m7g.large.search` 0.175 USD、gp3 1 GB 月 0.1464 USD、ElastiCache Valkey `cache.r7g.large` 0.2104 USD、Fargate ARM vCPU 1 時間 0.04045 USD・メモリー 1 GB 1 時間 0.00442 USD（[AWS Price List API](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonRDS/current/ap-northeast-1/index.json) ほか同じ形の AmazonES・AmazonElastiCache・AmazonECS の東京の価格表）。大阪の単価も同じ API で確かめ、東京とほぼ同じ（`db.r8g.4xlarge` 3.456 USD、`r7g.xlarge.search` 0.42894 USD、`cache.r7g.large` Valkey 0.2103 USD、gp3 0.1464 USD、Fargate ARM は同じ）なので、同じ単価と置いた。SES（東京）は送信 受け手 1 件 0.0001 USD、添付 1 GB 0.12 USD、受信 1 通 0.0001 USD ＋ 256 KB ごとに 0.00009 USD。GuardDuty の S3 のマルウェアの保護（東京）は、検査 1 GB 0.1185 USD（1 GB を超えた分）と、オブジェクト 1 件 0.000282 USD（どれも AmazonSES・AmazonGuardDuty の東京の価格表、2026-09-28 に確認）。CloudFront・WAF・NAT の単価は確かめていない（未検証。E12 `cost-baseline` で請求の実績に置き換える）。

| 項目 | 月額（USD、概算） |
| --- | --- |
| Aurora（セル 2 つ × 東京 r8g.4xlarge × 3＋大阪 × 1、I/O-Optimized、Global Database の複製とストレージ） | 23,000 |
| Aurora（制御の面：r8g.large × 2＋大阪 × 1） | 1,000 |
| OpenSearch（セル 2 つ × データ 3＋マスター 3＋gp3、大阪の小さなドメイン） | 3,500 |
| ElastiCache（セル 2 つ × 4 ノード、大阪の小さなクラスタ） | 1,500 |
| ECS Fargate（東京 平均 約 90 vCPU、大阪の待機 約 15 vCPU、制御の面・mail-router） | 3,800 |
| SES（送信 月 約 3,000 万通、受信） | 3,000 |
| CloudFront、WAF、ALB、データ転送 | 3,000 |
| NAT ゲートウェイ、Network Firewall（セル 2 つ × 東京と大阪） | 4,000 |
| S3（添付・原本の増加、レプリケーション）、バックアップ、log-archive | 1,500 |
| 可観測性（ログ、メトリクス、トレース、Grafana） | 3,000 |
| GuardDuty（S3 のマルウェアの保護を含む）、Security Hub、Inspector、Config、CloudTrail | 1,500 |
| KMS、Secrets Manager、Private CA | 800 |
| **本番の合計** | **約 50,000** |
| staging・dev・shared・edge・security | 約 8,000 |

- 最も大きいのは Aurora（約半分）。Savings Plans とリザーブドインスタンスで 20〜30% 下げられる。
- 費用は、アカウント（セル）とタグ（`cell`、`service`、`env`）ごとに毎月見る。テナントごとの費用の配分は、セルの費用をテナントの要求の重み（[api-and-integrations.md](api-and-integrations.md) の 7.1 節）とレコードの数で按分する（課金の集計。制御の面）。
- 専用のセルの最小の構成は、月 約 8,000〜10,000 USD（初期見積もり）。専用のセルの料金の下限の材料にする（PM）。

## 11. Epic との対応

| Epic | Story の候補 |
| --- | --- |
| E1 | `accounts-and-scp`、`cell-terraform-module`、`edge-router-kvs`（3.1 節）、`control-plane-ledger`、`mail-ingress-router`（2.3 節）、`osaka-warm-standby-skeleton`、`opensearch-domain-per-cell`（search と一緒に）、`ses-inbound-infrastructure`（notifications-and-email-ingest と一緒に） |
| E12 | `tenant-cell-move-drill`（4.2 節）、`dr-failover-drill`（6.3・6.4 節）、`dedicated-cell-provisioning`（4.1 節）、`quota-increases`、`cost-baseline` |

## 12. 未解決の問い

### 決定（2026-09-28、既定案）

- **セルごとにアカウントを分ける（共有のセルも）**（1 節、ADR-0055）。
- **ルーターは CloudFront Functions と KeyValueStore**（3.1 節）。
- **セルの App はテナントを解決し直し、別のセルのテナントは 421**（3.1 節）。
- **メールの受信は共有の入口と `mail-router`、専用のセルは専用の受信のサブドメイン**（2.3 節）。
- **専用のセルは同じ形のセル**（4.1 節、ADR-0056）。
- **DR はセルごとの大阪のウォームスタンバイ、索引は作り直し、失ったメールは原本から取り込み直す**（6 節、ADR-0057）。
- **Terraform はセルのモジュール 1 つと `cells.yaml`**（7.2 節、ADR-0058）。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| KeyValueStore の書き込みがエッジに届くまでの時間（上限の値は 2026-09-28 に AWS の文書で確かめた。3.1 節） | E1 `edge-router-kvs` の試験で計測する |
| SES の受信の規則の数の上限と、受け手ごとの振り分けの代わりの形 | 済み（2026-09-28。規則の集合に 200 までで引き上げられないので、2.3 節の共有の入口と `mail-router` の形にした） |
| 1 セルのテナントの数の上限 | E12 の負荷試験 |
| S3 のレプリケーションの時間の保証（RTC）を使うか | E12 の DR の訓練と費用 |
| 専用のセルの顧客の管理する鍵 | S2 の前（[security.md](security.md)） |
| カスタムドメイン | 顧客の要望を見て |
| RTO 15 分（S2）の自動の切り替え | S2 の前 |

## 13. quality.md・runbooks・data-model への項目

### quality.md

- セルごとの可用性（NFR-006）と、セルの間の差。
- ルーターの 404・421 の件数（421 はテナントの移動の間だけのはず）。
- `AuroraGlobalDBRPOLag` の p99。
- DR の訓練の結果（RTO・RPO の実測、索引の作り直しの時間）。
- セルの移動の訓練の書き込みの停止の時間。

### runbooks

- [disaster-recovery.md](../runbooks/disaster-recovery.md)：AZ・リージョンの障害、失った範囲の取り込み直し、訓練。
- [deploy-and-rollback.md](../runbooks/deploy-and-rollback.md)：セルごとのデプロイと戻し。
- `tenant-cell-move.md`：4.2 節の移動の手順（E12）。
- `router-mapping-mismatch.md`：ルーターの対応表と制御の面の台帳の食い違い（421 の急増）の確かめ方。
- `mail-ingress-backlog.md`：`mail-router` の滞留と、解決できない受け手の急増。

### data-model（索引への追加の提案）

| 置き場所 | 中身 |
| --- | --- |
| 制御の面の Aurora `tenant_registry`（テナント、ホスト名、環境、セル、状態）、`inbound_address`（受信のアドレス → テナント）、`cell`（セルの一覧） | 1・3 節。セルの DB ではなく制御の面に置く。RLS の外（テナントの台帳そのもの） |
| CloudFront KeyValueStore（ホスト名 → セル） | 3.1 節。制御の面が書く写し |
| 制御の面 `tenant_move_run` | 4.2 節 |
| mail-ingress の S3 の一時のバケット（1 日） | 2.3 節 |

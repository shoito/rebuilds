# Infrastructure: Cloudflare Workers

AWS のアカウント、リージョン、ネットワーク、テナントのコードを動かすフリート（インスタンスの型、AMI、Auto Scaling）、リージョンごとの中継・Valkey・DynamoDB・S3、制御プレーンの冗長化、災害復旧、S2・S3 の自前の IP と PoP への移行、Terraform の構成、費用の見積もりを決める。

| 対象 | 決定 |
| --- | --- |
| 入口（GA → NLB → ノード） | [ADR-0003](../decisions/0003-edge-locations.md)、[ADR-0017](../decisions/0017-global-accelerator-and-regional-nlb.md) |
| アカウントとネットワーク、外への通信 | [ADR-0049](../decisions/0049-aws-accounts-and-network.md) |
| フリートのインスタンスの型 | [ADR-0050](../decisions/0050-runtime-fleet-instance-types.md) |
| 災害復旧と RPO | [ADR-0051](../decisions/0051-disaster-recovery-and-honest-rpo.md) |
| 台数の根拠 | [ADR-0054](../decisions/0054-capacity-design-point-and-region-sizing.md)（[capacity.md](capacity.md)） |

経路と入口の設定は [edge-network-and-routing.md](edge-network-and-routing.md)、隔離の約束（x86-64、性能カウンター、IMDSv2、アカウントの分離）は [sandbox-and-security.md](sandbox-and-security.md) の 4・6・7 節、鍵は [security.md](security.md)、SLO と監視は [observability.md](observability.md)、配信は [delivery.md](delivery.md)、データの置き場所の索引は [data-model.md](data-model.md) にある。手順は [runbooks/disaster-recovery.md](../runbooks/disaster-recovery.md)。

AWS の仕様と単価は、2026-09-27 に AWS の文書と AWS の価格表の API（`aws pricing get-products`）、`describe-instance-type-offerings` で確かめた。見積もりの値のうち「初期値」は、負荷試験（E2・E4）の前の仮の値である。確かめられなかったものは「未検証」と書く。

## 1. AWS アカウント

AWS Organizations で、用途 × リージョンで分ける（[ADR-0049](../decisions/0049-aws-accounts-and-network.md)）。

| アカウント | OU | 中身 |
| --- | --- | --- |
| `management` | Root | Organizations、SCP、IAM Identity Center、請求 |
| `security` | Security | GuardDuty・Security Hub・Inspector の委任管理者。セキュリティの事象（seccomp の違反、探り、隔離）の保管 |
| `log-archive` | Security | CloudTrail の組織の証跡、Config、VPC フローログ、監査ログの WORM の写し（[ADR-0048](../decisions/0048-audit-log-integrity-and-data-lifecycle.md)） |
| `quarantine` | Security | 侵害の疑いのノードの EBS のスナップショットとメモリの写しの保管と解析。網なし。セキュリティの担当だけ |
| `shared` | Infrastructure | ECR（5 リージョンへ複製）、公開の Route 53 のゾーン（既定のドメイン、管理のドメイン）、Transit Gateway（RAM で共有）、Terraform の状態、CI の起点、内部の CA |
| `build-release` | Infrastructure | Bazel のビルド（リモートキャッシュ）、成果物の署名（[ADR-0046](../decisions/0046-control-plane-privilege-separation-and-operator-access.md)） |
| `cp-prod` | Workloads/ControlPlane | 制御プレーン（東京、大阪に DR）：ECS Fargate、Aurora PostgreSQL 18、採番器、配信の元、cert-manager、tail ハブ、ClickHouse、使用量の集計、運用の AMP |
| `edge-<r>`（`edge-apne1`・`edge-apne3`・`edge-apse1`・`edge-usw2`・`edge-euc1`） | Workloads/Edge | テナントのコードを動かすもの：エッジのノード、DO のホスト、中継、専用のリゾルバー、NLB |
| `storage-<r>`（同じく 5 つ） | Workloads/Storage | テナントのコードを動かさないストレージの部品（5 節） |
| `verify-prod` | Workloads/Verify | アップロードの検証のフリート（[runtime-and-isolates.md](runtime-and-isolates.md) の 7.3 節）。外への網なし |
| `security-lab` | Security | V8 の再現コード、Fuzzilli・libFuzzer。外への網なし |
| `research-pool` | Workloads/Edge | 報奨金の制度の研究者のアカウントを載せる専用のエッジのノード（[security.md](security.md) の 7 節）。東京だけ |
| `probe` | Workloads/Probe | 外からの合成監視（[observability.md](observability.md) の 6 節） |
| `*-staging`・`*-dev` | 各 OU | 東京・大阪の 2 リージョンの縮小の構成 |

- **SCP**：5 つのリージョンと、グローバルなサービス（Global Accelerator、Route 53、IAM、CloudFront、ACM の us-east-1）以外を禁じる。CloudTrail・Config・GuardDuty の停止、KMS の鍵の削除の予約、Object Lock の設定の変更を、break-glass の役割以外に禁じる。`edge-<r>` では、IMDSv1 のインスタンスの起動と、IMDS のホップの上限が 1 を超えるインスタンスの起動を禁じる（sandbox-and-security の 7.2 節）。
- **テナントのコードを動かすアカウント**（`edge-<r>`、`verify-prod`、`research-pool`）は、テナントのデータの正本（DynamoDB の KV、オブジェクトの共有のバケット、DO の WAL のバケット）への IAM の権限を持たない。すべてストレージのゲートウェイ（PrivateLink）を通す。

## 2. リージョン

| リージョン | 役割 | S1 | 備考 |
| --- | --- | --- | --- |
| 東京 `ap-northeast-1` | エッジ、制御プレーン、ストレージの中央（KV・オブジェクト・DO の名前の台帳・キュー・cron） | ○ | AZ ID は `apne1-az1`・`az2`・`az4` に固定する（c7i・m7i・i4i がこの 3 つで提供されている。`apne1-az3` は使わない。[kafka の infrastructure.md](../../../kafka/docs/architecture/infrastructure.md) の 2.1 節と同じ判断） |
| 大阪 `ap-northeast-3` | エッジ、制御プレーンの DR、ストレージの DR の写し | ○ | 3 つの AZ。c6id・m6id などのローカルの NVMe を持つ第 6 世代の Intel の型はない（[ADR-0050](../decisions/0050-runtime-fleet-instance-types.md)） |
| シンガポール `ap-southeast-1` | エッジ（東南アジア・南アジア） | 第一の候補 | |
| オレゴン `us-west-2` | エッジ（北米） | 第一の候補 | |
| フランクフルト `eu-central-1` | エッジ（欧州・中東・アフリカ） | 第一の候補 | |
| ソウル `ap-northeast-2` | 韓国 | 代わりの候補 | 韓国の利用者が多ければ、シンガポールより先に置く |
| バージニア北部 `us-east-1` | 北米東部 | 代わりの候補（S2） | |
| シドニー `ap-southeast-2` | オセアニア | S2 | シンガポールから往復 90〜100ms（未検証。[edge-network-and-routing.md](edge-network-and-routing.md) の 11 節） |

- 海外の 3 つは E1 の着手の前に、想定の利用者の分布で決める（intent）。この文書の見積もりは第一の候補で行う。
- すべてのリージョンで、ノードの型（c7i.24xlarge・c7i.12xlarge・m7i.12xlarge・i4i.2xlarge）が全ての AZ で提供されていることを確かめた（2026-09-27、`describe-instance-type-offerings`）。
- 管轄 `jp` のデータ（DO の実体、オブジェクトのバケット）は東京と大阪だけに置く（[durable-objects.md](durable-objects.md) の 11 節）。

## 3. ネットワーク

### 3.1 VPC とサブネット

リージョンごと・アカウントごとに 1 つの VPC。CIDR はアカウントとリージョンで重ならないように `shared` の IPAM で配る。

| アカウント | サブネット（AZ ごと） | 置くもの | 外への経路 |
| --- | --- | --- | --- |
| `edge-<r>` | public | NLB、エッジのノード、DO のホスト、専用のリゾルバー（どれも公開の IPv4 を持つ。受信はセキュリティグループで絞る） | Internet Gateway（ノードとホストは外向きのプロキシだけ、リゾルバーは DNS の再帰だけ） |
| `edge-<r>` | private | 中継 | なし（TGW とエンドポイントだけ） |
| `edge-<r>` | endpoints | PrivateLink のインターフェイスのエンドポイント（`storage-<r>` のゲートウェイ、KMS、S3 のゲートウェイ型、STS、Kinesis、CloudWatch Logs、SSM） | なし |
| `storage-<r>` | private | ゲートウェイ（ECS）、DO のルーター・配置のサービス、ログのノード、Valkey | NAT（少量） |
| `storage-<r>` | endpoints | 同上 | なし |

- **エッジのノードの外への通信**：ノードごとの公開の IPv4 を、外向きのプロキシのプロセスだけが送信元に使う（ポリシーのルーティングと cgroup の網の分類で縛る）。他のプロセス（スーパーバイザー、受け手、Vector）は VPC のエンドポイントと TGW だけに出る。NAT ゲートウェイを通さないので、処理の料金（1GB 0.062 ドル）がかからない（[ADR-0049](../decisions/0049-aws-accounts-and-network.md)）。
- **送信元の記録**：ノードの起動時に、公開の IP・ノードの ID・起動の時刻を `node_public_ips` に書く。通報の調べは、`<Brand>-Ray` の記録のノードの ID と時刻から IP を引く（[edge-network-and-routing.md](edge-network-and-routing.md) の 10.3 節の約束を、NAT の IP から、ノードの IP に置き換える）。
- **専用のリゾルバー**（Unbound）は、VPC の既定のリゾルバーを使わず、ルートのサーバーから再帰する（[ADR-0020](../decisions/0020-pingora-ingress-and-egress-proxies.md)）。

### 3.2 セキュリティグループ

| 対象 | 受ける | 送る |
| --- | --- | --- |
| エッジのノード | 80・443：NLB のセキュリティグループから。8443（ノードの間の転送）・8081（`/healthz`）：同じ VPC のノードと NLB から | 外向きのプロキシ：インターネットの 80・443・1024〜65535（25 を除く）。他：エンドポイント、中継、TGW |
| DO のホスト | RPC：同じリージョンの DO のルーター（`storage-<r>` から PrivateLink の逆向きではなく、ホストの NLB のエンドポイントサービス） | ログのノード、S3 のエンドポイント、中継 |
| 中継 | gRPC：同じ VPC のノードとホスト、他のリージョンの中継（TGW） | 配信の元（TGW）、S3 |

### 3.3 リージョンの間と、アカウントの間

| 経路 | 方式 | 運ぶもの |
| --- | --- | --- |
| `edge-<r>` → `storage-<r>`（同じリージョン） | PrivateLink（ストレージの側の NLB のエンドポイントサービス。許可の一覧でアカウントを限る） | KV の読み書き、DO の呼び出し、オブジェクトのゲートウェイ（東京） |
| リージョンの間 | `shared` の Transit Gateway を各リージョンに置き、東京をハブにしてリージョンの間のピアリング | 配信の元 → 中継、KV の書き込み（東京の書き込みサービス）、DO のルーターの間、使用量・ログの流れ（Kinesis の読み出し）、tail の中継 → ハブ |
| `cp-prod` ↔ 各リージョン | 同上 | 同上 |

- TGW は接続 1 時間 0.07 ドル、処理 1GB 0.02 ドル（東京）。リージョンの間の転送は東京から 0.09 ドル/GB（AWS の価格表の API）。
- エッジのノードから `cp-prod` への経路は、中継の購読と使用量・ログの送信だけに絞る（ノードの侵害からの横移動を限る。[security.md](security.md) の 3.3 節の C9）。

## 4. フリート

[ADR-0050](../decisions/0050-runtime-fleet-instance-types.md)。

### 4.1 インスタンスの型

| 群 | 型 | 東京の単価（オンデマンド） | 条件 |
| --- | --- | --- | --- |
| エッジのノード（東京・大阪） | c7i.24xlarge（96 vCPU、192 GiB、37.5 Gbps） | 5.3928 ドル/時 | x86-64、PKU、ソケット全体で PMU |
| エッジのノード（海外） | c7i.12xlarge（48 vCPU、96 GiB） | 2.6964 ドル/時 | 同上（Intel の一覧で PMU あり） |
| DO のホスト | m7i.12xlarge（48 vCPU、192 GiB） | 3.1248 ドル/時 | 同上 |
| DO のログのノード | i4i.2xlarge（8 vCPU、64 GiB、NVMe 1,875 GB） | 0.805 ドル/時 | テナントのコードなし |
| 中継 | m7i.xlarge ＋ gp3 300 GB | 0.2604 ドル/時 | |
| 専用のリゾルバー | c7i.large | 未検証（価格表の値を E1 で確かめる） | |
| `c3-dedicated` の専用のノード、研究者用 | c7i.metal-24xl / c7i.12xlarge | 5.3928 / 2.6964 ドル/時 | |

- PMU：Intel は「1 つか 2 つのソケットを丸ごと使う大きさだけが PMU を使える」とし、c7i.12xlarge・24xlarge・48xlarge と m7i の同じ大きさ、metal を挙げる（[Intel VTune Profiler Functionality on AWS Instances](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-vtune-amplifier-functionality-on-aws-instances.html)、2025-02-19 更新、2026-09-27 に確認）。AWS の公式の一覧は見つけられなかった（未検証）。E1 の最初に、5 つのリージョンの実機で `perf stat -e LLC-load-misses,branch-misses` を確かめる。
- ディスク：c7i・m7i はローカルの NVMe を持たない。ノードの LMDB とコードのキャッシュは gp3（200 GB、3,000 IOPS、125 MB/秒。1GB-月 0.096 ドル）。よく使うバンドルはページキャッシュに乗る前提（[capacity.md](capacity.md) の 4 節）。

### 4.2 AMI

- Amazon Linux 2023 の最小の構成に、自前の部品（入口・外向きのプロキシ、スーパーバイザー、受け手、Vector、OTel Collector）と、ランタイムの版 2 つ（いまと前）を入れる。ランタイムの版は、AMI の外からも配れる（[delivery.md](delivery.md) の 5 節）。
- カーネルの設定（`kernel.unprivileged_bpf_disabled=1`、`kernel.yama.ptrace_scope=3`、`kernel.perf_event_paranoid=3` など）は [sandbox-and-security.md](sandbox-and-security.md) の 4.3 節。利用者の名前空間は、スーパーバイザーの利用者だけに許す（`user.max_user_namespaces` を 0 にせず、スーパーバイザー以外は seccomp と `CAP` の不在で閉じる。方法の詳細は E3 で決める）。
- AMI は `build-release` で作り、署名する。ノードは起動時に、ランタイムの版の署名を確かめる。
- カーネルの重大な修正（名前空間、seccomp、cgroup、eBPF、KVM のゲストに関わるもの）は、公開から 72 時間以内に全ノードの AMI を入れ替える。

### 4.3 起動の手順と健全性

```
1. EC2 の起動（ASG。AZ ごと）
2. ノードの自己検査：IMDSv2・ホップ 1、PKU のフラグ、perf_event で LLC のミスと分岐の予測の失敗が進むこと、
   カーネルの設定、ランタイムの版の署名
     └─ 失敗 → ASG のライフサイクルのフックで異常として終了（NLB に入らない）
3. スーパーバイザーが RSK を、入口のプロキシが RDK を KMS で開く（起動時の 2 回だけ）
4. 受け手が中継の最新のスナップショット（リージョンの S3）を取り、その番号から購読
5. 中継の先頭に追いつく（目標 2 分。deployment-and-config-distribution の 6.4 節）
6. ランタイムのプロセスを cordon ごとに起動し、空の isolate の予備を作る
7. /healthz が 200 → NLB に入る。中継のノードの一覧に載る（ランデブーハッシュ）
```

- **ASG**：リージョン × AZ × 群ごと。最小の台数は [ADR-0054](../decisions/0054-capacity-design-point-and-region-sizing.md)。止めた状態のインスタンスの予備（warm pool）を AZ ごとに 1 台持ち、追加の起動を速くする（warm pool から起動する時間は未検証）。
- **ノードの退避**：[edge-network-and-routing.md](edge-network-and-routing.md) の 9.2 節の手順を、ASG のライフサイクルのフック（終了の前）から呼ぶ。

## 5. リージョンのサービス

| 部品 | アカウント | 構成（S1） | 決めた領域 |
| --- | --- | --- | --- |
| 中継 | `edge-<r>` | 3 台（AZ ごと）。7 日のログ、バンドルのキャッシュ 200 GB、1 時間ごとのスナップショット | [deployment-and-config-distribution.md](deployment-and-config-distribution.md) の 6.2 節 |
| 専用のリゾルバー | `edge-<r>` | 2 台（別の AZ） | [edge-network-and-routing.md](edge-network-and-routing.md) の 10.2 節 |
| KV のゲートウェイ | `storage-<r>` | ECS、3 AZ | [kv-store.md](kv-store.md) の 5.3 節 |
| Valkey（KV の L2） | `storage-<r>` | ElastiCache for Valkey、クラスタのモード。東京・大阪は 3 シャード × 2（cache.r7g.large、13 GiB。東京 0.2104 ドル/時）、海外は 2 シャード × 2 | [kv-store.md](kv-store.md) の 6.1 節 |
| DO のルーター・配置のサービス | `storage-<r>` | ECS、3 AZ | [durable-objects.md](durable-objects.md) の 4.4 節・5 節 |
| DO のログのノード | `storage-<r>` | i4i.2xlarge、AZ ごとに 1（S1） | 同 7.2 節 |
| テナントのログ・使用量の Kinesis | `storage-<r>` | オンデマンド | [developer-tooling.md](developer-tooling.md) の 8.1 節、[limits-and-billing.md](limits-and-billing.md) の 5.2 節 |

**DynamoDB**（すべてオンデマンド、PITR 有効）：

| 表 | 置き場所 | 複製 | 領域 |
| --- | --- | --- | --- |
| `kv_entries` | 東京 | グローバルテーブル（MREC）で大阪 | kv-store |
| `do_directory` | 東京 | グローバルテーブル（MREC）で全 5 リージョン（読み込み用） | durable-objects |
| `do_host_leases`・`do_assignments`・`do_alarms` | 各リージョン | なし | durable-objects |
| `queue_dispatch_leases`・`cron_scheduler_leases` | 東京 | なし | queues-and-cron |
| `cron_fires` | 東京 | グローバルテーブル（MREC）で大阪 | queues-and-cron |

- MREC は、ふつう 1 秒以下で非同期に複製し、RPO は複製の遅れ（ふつう数秒）。MRSC は RPO 0 だが、ちょうど 3 つのリージョン（複製 2 つと witness でもよい）が要り、TTL とトランザクションを持たない（[How global tables work](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/V2globaltables_HowItWorks.html)、2026-09-27 に確認）。`kv_entries` は TTL（期限）を使うので MRSC にできない。
- リージョンの DynamoDB の障害で、DO のリースを更新できず、そのリージョンの DO が 7 秒で止まる（[ADR-0030](../decisions/0030-do-leases-and-fencing.md) の既知の制約）。

**S3**（すべて SSE、パブリックアクセスの遮断、バージョニング）：

| バケット | 置き場所 | 複製 |
| --- | --- | --- |
| `<brand>-code-<r>` | 5 リージョン | 同期の PUT（CRR なし。[ADR-0023](../decisions/0023-code-and-secret-distribution.md)） |
| `<brand>-snapshots-<r>`（LMDB） | 5 リージョン | なし（作り直せる） |
| `<brand>-kv-values-apne1` | 東京 | 大阪へ CRR（RTC） |
| `<brand>-obj-apne1-00`〜`15` | 東京 | 大阪へ CRR（RTC） |
| `<brand>-do-<r>` | 5 リージョン | 東京 ↔ 大阪、海外 → 東京（管轄 `jp` は日本の中だけ）へ CRR（RTC） |
| テナントのログの再送用、使用量の生の束 | 東京 | 大阪へ CRR |

## 6. 制御プレーン

| 部品 | 東京 | 大阪 |
| --- | --- | --- |
| Aurora PostgreSQL 18 | 主のクラスタ（ライター＋リーダー、3 AZ） | Global Database の副（リーダー 1） |
| ECS（API、ダッシュボードの BFF、採番器、配信の元、cert-manager、tail ハブ、使用量の集計、配信の制御役） | 3 AZ | 最小の台数（タスク 0〜1）で待機。切り替えで増やす |
| ClickHouse（保存するログ、呼び出しの集計） | 3 ノード（3 AZ）。自前かマネージドかは E6 | なし（再送用の S3 を大阪へ CRR） |
| Valkey（管理 API のレート制限、トークンの失効の印） | 1 クラスタ | なし（止まったら制限なしで動く。dashboard-and-api） |
| 運用の AMP、Grafana | 東京 | なし |

- 採番器と配信の元は東京で 1 つだけ動く。大阪への切り替えのあとは新しいエポックで始める（[ADR-0022](../decisions/0022-sequenced-change-log-relays-and-lmdb.md)）。
- 制御プレーンの停止は、デプロイ済みの関数に影響しない（静的な安定）。

## 7. 災害復旧

[ADR-0051](../decisions/0051-disaster-recovery-and-honest-rpo.md)。手順は [runbooks/disaster-recovery.md](../runbooks/disaster-recovery.md)。

### 7.1 障害の範囲ごとの振る舞い

| 範囲 | 関数の実行 | 制御プレーン | ストレージ |
| --- | --- | --- | --- |
| 1 台のノード | NLB が 20 秒で外す | — | DO はリースの期限の後に引き継ぐ（10 秒＋復元） |
| 1 つの AZ | 残りの 2 AZ のノード（台数は AZ の喪失に耐える。ADR-0054） | Aurora の Multi-AZ | KV・オブジェクト・SQS は AWS の Multi-AZ。DO は 2 AZ の確定で RPO 0（[ADR-0031](../decisions/0031-do-sqlite-replication-and-pitr.md)） |
| 海外の 1 リージョン | GA が近いリージョンへ | — | そのリージョンの DO は使えない（手動の退避まで） |
| 東京の全体 | GA が大阪・他へ。大阪は国内の全量を受ける | 手動の判断で大阪へ切り替え（RTO 1 時間） | 製品ごとに手動（7.2 節） |
| GA のアクセラレーター | `edge.<brand>.<domain>` を予備へ | — | — |

### 7.2 RPO を率直に書く

元の NFR-010 は、ストレージのホームのリージョンの全体の障害で RPO 1 分を求めていたが、**S1 の構成では保証できない製品がある**。統合の工程（2026-09-27）で、NFR-010 を下の表の製品ごとの値に改めた（[README.md](README.md) の 3 節。PM・Ops の確認事項）。各ストレージの領域の報告（kv-store の 5.5 節、object-storage の 14 節、durable-objects の 16 節、queues-and-cron の 8 節）を、ここにまとめる。

| 製品 | 大阪への複製 | 通常の遅れ | 約束できる上限 | NFR-010 の RPO 1 分 |
| --- | --- | --- | --- | --- |
| 関数のコード（バンドル） | 5 リージョンへ同期で置く | 0 | 0 | 満たす |
| 設定（ノードの写し） | 全ノードが持つ | 0 | 0 | 満たす |
| 制御プレーン（Aurora） | Global Database | 秒の単位 | なし（AWS は「ふつう秒」とだけ言う） | ほぼ満たす見込み（保証なし） |
| KV（4 KiB 以下） | MREC | 1 秒以下（AWS の記述） | なし | ほぼ満たす見込み（保証なし） |
| KV（4 KiB を超える値） | S3 CRR（RTC） | 数秒 | 99.9% を 15 分 | **満たせない** |
| オブジェクトストレージ | S3 CRR（RTC） | 数秒 | 99.9% を 15 分 | **満たせない** |
| Durable Objects | WAL を 10 秒か 16 MiB ごとに S3 → CRR | 10 秒＋数秒 | 10 秒＋15 分（99.9%） | **満たせない** |
| キュー | なし（東京の SQS だけ） | — | 東京の回復を待つ | 失わないが、東京の回復まで使えない。東京の SQS の永続の喪失では失う |
| 保存するログ | 再送用の S3 だけ CRR | 取り込みの遅れ | なし | 対象外（ログは約束しない） |

- S3 RTC は、ほとんどのオブジェクトを数秒で、99.9% を 15 分以内に複製する（[S3 Replication Time Control](https://docs.aws.amazon.com/AmazonS3/latest/userguide/replication-time-control.html)、2026-09-27 に確認）。
- Aurora Global Database の RPO は「ふつう秒の単位」、管理された切り替えは複製されていない書き込みを失いうる（[Using switchover or failover](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-global-database-disaster-recovery.html)、2026-09-27 に確認）。
- **NFR-010 の改定の提案**（PM・Ops の確認待ち）：「関数と設定：RTO 5 分・データなし。ストレージのホームのリージョンの全体の障害：RTO 1 時間、RPO は製品ごとの表で公開する（KV の小さな値と制御プレーンは通常は秒、大きな値・オブジェクト・Durable Objects は 99.9% で 15 分以内）」。

## 8. 自前の IP と PoP への移行（S2・S3）

[ADR-0003](../decisions/0003-edge-locations.md) の道筋を、IP のアドレスを変えずに進める手順にする。

### 8.1 事実

- GA の BYOIP は IPv4 だけで、/24 だけを持ち込める。1 つのアカウントに 2 つまで。ARIN・RIPE・APNIC に、事業者の名義で登録した範囲で、APNIC は `ALLOCATED PORTABLE`・`ASSIGNED PORTABLE` が要る（[Requirements](https://docs.aws.amazon.com/global-accelerator/latest/dg/using-byoip.requirements.html)、2026-09-27 に確認）。
- AWS で広告する前に、他の場所からの広告を止める必要がある。複数の事業者から同時に広告すると、通信が AWS に入る保証がない（[BYOIP](https://docs.aws.amazon.com/global-accelerator/latest/dg/using-byoip.html)、2026-09-27 に確認）。
- 範囲を 2 つ持ち込むと、アクセラレーターの 2 つの IPv4 を両方とも自前の範囲にできる（同上）。

### 8.2 手順

| 段 | いつ | すること |
| --- | --- | --- |
| P0 | S1 | 既定のドメインと CNAME のカスタムドメインは `edge.<brand>.<domain>` の名前で向ける。apex の A・AAAA は `ga-primary` の IP（予備・移行に追従しない危険を画面で示す。edge-network-and-routing の 6.2 節） |
| P1 | S2 の前 | APNIC（JPNIC 経由を含む。手続きは未検証）で IPv4 の /24 を 2 つと、IPv6 の範囲と、AS 番号を得る。RPKI の ROA を作る |
| P2 | S2 | 新しいアクセラレーター `ga-byoip` を、2 つの /24 から 1 つずつの IP で作る。`edge.<brand>.<domain>` を `ga-byoip` へ移す。apex の利用者に新しい IP を知らせ、移行の期間（6 か月）を置く。旧 `ga-primary` はその間残す |
| P3 | S3 の最初 | 自前の PoP（国内の主要都市から）で、**3 つ目の /24**（新しい範囲）を BGP で広告し、合成監視と一部の利用者（選んだ CNAME の向き先）で試す |
| P4 | S3 | /24 の A を GA から外し（BYOIP の広告の停止と範囲の返却）、自前の PoP から広告する。アクセラレーターは B の IP 1 つで動き続けるので、A と B の両方を持つ利用者の DNS はそのまま届く。合成監視で確かめてから、B も同じく移す |
| P5 | S3 | IPv6 は自前の範囲を PoP から広告し、`edge` の AAAA を移す（GA の IPv6 は BYOIP の対象外なので、AAAA は変わる） |

- 広告を移す瞬間は、その /24 への通信が数分乱れうる（BGP の収束。値は未検証）。1 つずつ、深夜に行う。
- PoP の中の機械の構成（Unimog に当たる L4 の負荷分散）と、PoP と AWS のリージョンの間の経路（Direct Connect など）は、S3 の前に ADR にする。
- エッジのノードの役割（入口のプロキシ以後）は変えない。TLS をノードで終端する設計（ADR-0003）なので、PoP でも同じソフトウェアで動く。

## 9. Terraform の構成

```
infra/                                   # 開発リポジトリ
├── modules/
│   ├── account-baseline/                # SCP の外の共通の設定、CloudTrail の配送、Config の規則
│   ├── vpc-edge/                        # 3.1 節。AZ ID を入力にする
│   ├── vpc-storage/
│   ├── tgw-attachment/
│   ├── edge-fleet/                      # ASG（AZ ごと）、起動テンプレート、warm pool、ライフサイクルのフック
│   ├── do-host-fleet/
│   ├── relay/  resolver/
│   ├── nlb-endpoint/                    # GA のエンドポイントの NLB
│   ├── global-accelerator/              # us-west-2 のプロバイダーで作る
│   ├── kms-regional/  kms-control-plane/
│   ├── storage-regional/                # DynamoDB、Valkey、ゲートウェイの ECS、ログのノード、S3
│   ├── storage-central/                 # 東京：KV の正本、オブジェクトの共有のバケット、SQS、ディスパッチャー、cron
│   └── control-plane/                   # ECS、Aurora、ClickHouse、Kinesis の消費
└── live/
    ├── org/                             # アカウント、OU、SCP
    ├── shared/{global,apne1,apne3,apse1,usw2,euc1}/   # Route 53、ECR、TGW、IPAM、内部の CA
    ├── log-archive/  security/  quarantine/
    ├── build-release/apne1/
    ├── cp/{dev,staging,prod}/{apne1,apne3}/
    ├── edge/{staging,prod}/{apne1,apne3,apse1,usw2,euc1}/{network,fleet,do-hosts,relay,nlb}/
    ├── storage/{staging,prod}/{apne1,apne3,apse1,usw2,euc1}/
    ├── global-accelerator/prod/         # ga-primary、ga-standby、（S2）ga-byoip
    ├── verify/prod/apne1/  security-lab/apne1/  research-pool/apne1/
    └── probe/{apne1,apne3,apse1,usw2,euc1}/
```

- 状態は `shared` の S3 にルートモジュールごとに置き、S3 のネイティブのロックを使う。大阪へ CRR する。
- 1 回の apply の影響を 1 つのリージョンの 1 つの部品に絞る。**複数のリージョンを 1 回の apply で変えない**（CI で検査）。
- apply は CI の役割（OIDC）だけ。prod の計画は Ops が承認する。ネットワーク・GA・KMS・SCP の変更は 2 人で承認する。
- CI の検査：AZ の名前の直書きがない、IMDSv2 とホップ 1、全てのバケットの暗号化とパブリックアクセスの遮断、`edge-<r>` の役割がテナントのデータの表・バケットへの権限を持たない、エッジのノードのセキュリティグループの 80・443 が NLB からだけ。

## 10. 費用の見積もり（S1、本番、1 か月）

**大まかな見積もりである。** 東京などのオンデマンドの定価（AWS の価格表の API、2026-09-27）からの ±50% の幅の値。税、サポート、Savings Plans を含めない。台数の根拠は [capacity.md](capacity.md)。流量は S1 のピーク 5 万件/秒、平均 2 万件/秒、応答の平均 10 KB の仮定（未検証）。

### 10.1 固定の費用

| 項目 | 月額（USD、概算） |
| --- | --- |
| 東京：エッジ c7i.24xlarge × 6、DO のホスト m7i.12xlarge × 3、ログのノード i4i.2xlarge × 3、中継・リゾルバー・Valkey・ゲートウェイ・EBS・NLB・TGW | 34,900 |
| 大阪：同じ構成 | 34,900 |
| シンガポール：エッジ c7i.12xlarge × 3、DO のホスト × 3、ログのノード × 3、他 | 15,800 |
| オレゴン：同上 | 13,300 |
| フランクフルト：同上 | 15,400 |
| **リージョンの小計** | **約 114,000** |
| 制御プレーン（Aurora と大阪の副、ECS、ClickHouse 3 ノード、Kinesis、AMP・Grafana、KMS） | 約 15,000 |
| Global Accelerator 2 つ（0.025 ドル/時 × 2） | 約 36 |
| 検証のフリート、security-lab のファズ、`build-release` の Bazel、研究者用のノード | 約 15,000 |
| probe（5 リージョンと国内の外部の地点） | 約 1,500 |
| staging（東京・大阪の縮小の構成） | 約 20,000 |
| **固定の費用の合計** | **約 165,000** |

### 10.2 流量に比例する費用

| 項目 | 単価 | S1 の見込み（月） | 月額（USD、概算） |
| --- | --- | --- | --- |
| インターネットへの転送（利用者への応答） | 東京 0.114→0.084 ドル/GB の段階。シンガポール 0.12→0.08、オレゴン・フランクフルト 0.09→0.05 | 520 TB（平均 2 万件/秒 × 10 KB） | 約 46,600（平均 0.0875 ドル/GB） |
| GA の DT-Premium | アジア太平洋の edge からアジア太平洋 0.010、北米 0.012、欧州 0.043 ドル/GB など（多い方向だけ） | 520 TB | 約 5,900 |
| AZ をまたぐ転送（ホームのノードへの転送） | 0.01 ドル/GB を両方向 | 要求と応答の 2/3 が AZ をまたぐとして約 370 TB | 約 7,300 |
| リージョンの間（KV の書き込み、DO、ログ・使用量・tail、配信） | 0.09 ドル/GB ＋ TGW 0.02 ドル/GB | 約 20 TB（未検証） | 約 2,200 |
| 外への転送（サブリクエストの送信） | 同上の段階 | 約 50 TB（未検証） | 約 4,500 |
| **流量の小計** | | | **約 66,500** |

- 合計は **月に約 23 万ドル**（S1 のピークの規模を常に持つ構成）。
- GA の DT-Premium の表（[Global Accelerator pricing](https://aws.amazon.com/global-accelerator/pricing/)、2026-09-27 に確認）は、edge の場所の地域とエンドポイントのリージョンの地域の組で決まる。表の軸の読み方（行と列のどちらが edge か）は、E4 で Cost and Usage Report の使用量の種類を見て確かめる（未検証）。
- インターネットへの転送（0.0875 ドル/GB＋DT-Premium 約 0.011 ドル/GB）は、limits-and-billing の外向きの転送の単価（1GB 25 円）の原価（約 18.6 円）と合う（[limits-and-billing.md](limits-and-billing.md) の 6.3 節）。
- NAT ゲートウェイを通していたら、サブリクエストの送受の量（数百 TB）に 0.062 ドル/GB が加わり、月に数万ドル増えていた（[ADR-0049](../decisions/0049-aws-accounts-and-network.md)）。

## 11. 障害と振る舞い

| 事象 | 起きること | 検知 | 対応 |
| --- | --- | --- | --- |
| PMU を読めないノード（型の誤り、カーネル） | 起動の自己検査で失敗 | ASG のライフサイクルのフック | 本番に入れない。`pmu-unavailable-node` |
| 型の在庫の不足（ある AZ で c7i.24xlarge が起動できない） | ASG が増やせない | ASG の失敗の事象 | 同じリージョンの他の AZ で増やす。続けば c7i.12xlarge を 2 台で代える（起動テンプレートの代わりの型の一覧に入れる） |
| TGW のリージョンの間のピアリングの障害 | 配信・KV の書き込み・DO のリージョンをまたぐ呼び出しが失敗 | 中継の心拍、ゲートウェイの失敗の率 | 中継は他のリージョンの中継へ（届けば）。関数の実行は続く（静的な安定） |
| PrivateLink のエンドポイントの障害 | そのリージョンの KV・DO の呼び出しが失敗 | 外向きのプロキシのバインディングの失敗の率 | エンドポイントの AZ の別の ENI へ。続けばリージョンを `drain` するかを判断（関数ごとのエラーとして返すのが既定） |
| リージョンの KMS の障害 | 動いているノードは続く。新しいノードは健全にならない | 起動の失敗 | Auto Scaling を止め、既存のノードで持ちこたえる |
| リージョンの DynamoDB の障害 | そのリージョンの DO が 7 秒で止まる | DO のリースの更新の失敗 | 既知の制約。`do-region-evacuate` の判断 |

## 12. セキュリティ

- `edge-<r>` のノードの役割：自分のリージョンの `<brand>-code-<r>` の `bundles/` の `GetObject`、スナップショットの `GetObject`、KMS の `Decrypt`（暗号化の文脈つき 2 つだけ）、Kinesis の `PutRecords`、CloudWatch Logs の書き込み。テナントのデータの表・バケットへの権限なし。
- 公開の IPv4 を持つエッジのノードは、Config の規則で「80・443 を NLB 以外から受けるセキュリティグループ」を検知して呼び出す。
- AMI とランタイムの版は署名し、ノードは確かめる（[security.md](security.md) の 4 節）。
- ネットワーク・GA・KMS・SCP の Terraform の変更は `security:sensitive` にする。

## 13. この領域の ADR

| ADR | 決定 |
| --- | --- |
| [0049](../decisions/0049-aws-accounts-and-network.md) | アカウントを制御プレーン、リージョンごとのエッジとストレージ、検証、security-lab、quarantine、probe に分ける。リージョンの間は TGW、同じリージョンのアカウントの間は PrivateLink。エッジのノードは公開の IPv4 で外へ出て、NAT を通さない |
| [0050](../decisions/0050-runtime-fleet-instance-types.md) | テナントのコードを動かすノードは c7i.24xlarge・c7i.12xlarge・m7i.12xlarge（ソケット全体で PMU、PKU）。ディスクは gp3。自前の部品は x86-64 だけ |
| [0051](../decisions/0051-disaster-recovery-and-honest-rpo.md) | 東京の全体の障害は、関数は自動、制御プレーンは Aurora の切り替え、ストレージは製品ごとの手動。RPO は製品ごとの実際の値で示し、NFR-010 の改定を提案する |

## 14. Story の候補

| Epic | Story の候補 |
| --- | --- |
| E1 | 確認：5 つのリージョンの c7i.24xlarge・c7i.12xlarge・m7i.12xlarge で PMU（LLC のミス、分岐の予測の失敗）と PKU が使えるか（着手の最初） |
| E1 | Organizations、OU、SCP、アカウント（`edge-<r>`・`storage-<r>` を含む） |
| E1 | IPAM、VPC（エッジ・ストレージ）、TGW とリージョンの間のピアリング、PrivateLink |
| E1 | エッジのノードの AMI（Amazon Linux 2023 の最小、カーネルの設定、署名）と起動の自己検査 |
| E1 | ASG（AZ ごと）、warm pool、ライフサイクルのフックでの退避 |
| E1 | 中継・リゾルバー・DO のログのノードの群 |
| E1 | リージョンのストレージ（DynamoDB の表、Valkey、S3、Kinesis） |
| E1 | 制御プレーンの Aurora Global Database と大阪の待機 |
| E1 | Terraform の構成と CI の検査（複数のリージョンを 1 回で変えない等） |
| E1 | ノードの公開の IPv4 の記録（`node_public_ips`）と、外向きのプロキシだけが外へ出る縛り |
| E4 | GA の DT-Premium の軸と、AZ をまたぐ転送の実際の量の確認（Cost and Usage Report） |
| E12 | 東京の全体の障害の訓練（staging） |
| S2 | IP の範囲と AS 番号の取得、`ga-byoip`、apex の利用者への移行の連絡 |

## 15. 未解決の問い

- AWS の公式の資料で、c7i・m7i の PMU の条件を確かめられるか。AMD の型（c7a・c8a）は PMU と MPK を使えるか。
- warm pool から起動したノードが健全になるまでの時間（スナップショットからの追いつきを含む）。
- `apne1-az3` を使わない判断が、この題材の型でも正しいか。
- 海外の 3 リージョンの最終の選択（ソウル・バージニアとの比べ）。
- ClickHouse を自前にするか、マネージドにするか（E6）。
- 自前の PoP での、PoP と AWS の間の経路（Direct Connect など）と、PoP の中の L4 の負荷分散。
- NFR-010 の改定の提案を、PM・Ops が受け入れるか。

### 決定

2026-09-27 の既定案。

- PMU は E1 の実機の確認を必須にする。AMD は E1 で確かめ、使えて安ければ ADR-0050 を改める。
- warm pool の効果は E1 で測る。2 分に収まらなければ、ASG の最小の台数に 1 台を足す。
- AZ ID は東京で `az1`・`az2`・`az4` にする。E1 で `describe-instance-type-offerings` の結果を記録する。
- 海外は第一の候補で見積もり、E1 の前に PM が決める。
- ClickHouse は developer-tooling の決定に従う。
- PoP の経路と負荷分散は S3 の前に ADR にする。
- NFR-010 は、ADR-0051 の表を使って PM・Ops に諮る。統合の工程で architecture/README.md の NFR の表を直した（PM・Ops の確認事項のまま）。

## 16. quality.md・runbooks・data-model に載せるもの

**quality.md**

- リスク：PMU を使えない型の混入（検知の止まり）。起動の自己検査の結合テストと、ASG の型の一覧の CI の検査。
- リスク：エッジのノードの公開の IP からの露出。セキュリティグループの CI の検査と Config の規則。
- リスク：東京の全体の障害での RPO の超過。半期の DR の訓練で製品ごとの RPO を記録する。
- 本番での検証：`AuroraGlobalDBRPOLag`、DynamoDB の `ReplicationLatency`、S3 の `ReplicationLatency`、ASG の起動の失敗の数。

**runbooks/README.md**

- 手順：[disaster-recovery.md](../runbooks/disaster-recovery.md)（東京の全体の障害、Aurora の切り替え、ストレージの製品ごとの切り替え、戻し）。
- 個別の手順の候補：`pmu-unavailable-node`、`instance-capacity-shortage`、`tgw-peering-down`、`privatelink-endpoint-down`、`regional-kms-outage`、`ga-byoip-migration`（S2）。
- SLI の追加の依頼：複製の遅れ（Aurora、DynamoDB、S3、DO の WAL）、ASG の健全なノードの数と最小の台数の差。

**data-model**

| テーブル・保存 | 主な列 | 備考 |
| --- | --- | --- |
| `nodes`（制御プレーン） | `node_id`、`region`、`az_id`、`fleet`（`edge`・`do_host`・`log_node`・`relay`）、`instance_type`、`ami_version`、`runtime_versions`、`pmu_ok`、`pku_ok`、`launched_at`、`terminated_at` | テナントの表ではない |
| `node_public_ips`（制御プレーン） | `node_id`、`public_ipv4`、`attached_at`、`detached_at` | 通報の調べ。13 か月 |
| `dr_drills`（制御プレーン） | `id`、`kind`、`environment`、`started_at`、`finished_at`、`measured_rpo`（製品 → 秒）、`measured_rto`、`notes` | |
| Terraform の状態（`shared` の S3） | ルートモジュールごと | 大阪へ CRR |

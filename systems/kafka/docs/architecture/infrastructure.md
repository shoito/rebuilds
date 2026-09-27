# Infrastructure: Kafka

AWS のアカウントとネットワーク、データ面の EKS、入口（NLB と SNI のプロキシ）、PrivateLink（S2）、S3 と KMS、大阪への災害復旧、Terraform の構成、コストの設計。前提の決定は、本家のブローカーを EKS の上の Strimzi で動かすこと（[ADR-0001](../decisions/0001-upstream-brokers-and-stack.md)、[ADR-0032](../decisions/0032-strimzi-for-physical-clusters.md)）、複製は AZ ごとに 1 つ（[ADR-0012](../decisions/0012-durability-settings-and-elr.md)）、大阪への写しは論理クラスタごとの選択（[ADR-0019](../decisions/0019-tiered-storage-lifecycle-and-dr-copy.md)）。

| 対象 | 決定 |
| --- | --- |
| アカウント、VPC、EKS、ノードグループ、AZ ID の固定 | [ADR-0043](../decisions/0043-aws-accounts-network-and-eks-layout.md) |
| NLB と Envoy の経路、AZ ID を入れたホスト名、証明書 | [ADR-0044](../decisions/0044-nlb-sni-proxy-and-zonal-hostnames.md) |
| 大阪への災害復旧の範囲 | [ADR-0045](../decisions/0045-osaka-disaster-recovery-scope.md) |
| インスタンスの型と台数の根拠 | [ADR-0048](../decisions/0048-broker-design-point-and-cost-model.md)（[capacity.md](capacity.md)） |

ログ・メトリクス・SLO は [observability.md](observability.md)、負荷と費用の根拠は [capacity.md](capacity.md)、CI とリリースは [delivery.md](delivery.md)、データの置き場所の索引は [data-model.md](data-model.md) にある。手順は [runbooks/disaster-recovery.md](../runbooks/disaster-recovery.md) と [runbooks/incident-response.md](../runbooks/incident-response.md)。

AWS の仕様と単価は、2026-09-27 に AWS の文書と AWS Price List API（東京 `ap-northeast-1`）で確かめた。数値のうち「初期見積もり」は、負荷試験（E9・E12）の前の仮の値である。確かめられなかったものは「未検証」と書く。

## 1. AWS アカウント

AWS Organizations で、用途と環境ごとに分ける（[ADR-0043](../decisions/0043-aws-accounts-network-and-eks-layout.md)）。

| アカウント | OU | 中身 |
| --- | --- | --- |
| management | Root | Organizations、SCP、IAM Identity Center、請求 |
| security | Security | GuardDuty・Security Hub・Inspector の委任管理者 |
| log-archive | Security | 組織の CloudTrail・Config・VPC フローログ。監査ログの保管庫（テナントの監査ログと耐久性の監査の事象。Object Lock 1 年。[ADR-0030](../decisions/0030-encryption-and-audit-logs.md)） |
| shared | Infrastructure | ECR（大阪へ複製）、公開の Route 53 のホストゾーン（`<brand>.<domain>`）、Managed Grafana、CI の起点、Terraform の状態 |
| cp-dev・cp-staging・cp-prod | Workloads/ControlPlane | 制御面（ECS Fargate、Aurora PostgreSQL 18、SQS、ALB）、テナントのメトリクスの AMP、運用の AMP。cp-prod は東京と大阪 |
| dp-dev・dp-staging・dp-prod | Workloads/DataPlane | データ面（VPC、エッジ、EKS、EBS、階層型の保存の S3、物理クラスタの KMS のキー）。dp-prod は東京。大阪は災害のときに使う骨組み（8 節） |
| dp-verify | Workloads/Verify | Jepsen の形の試験、差分テスト、負荷試験の物理クラスタ。本番のデータを置かない |
| probe | Workloads/Probe | 外からの合成監視（[observability.md](observability.md) の 6 節）。東京と大阪 |
| dr-vault | Security | 大阪の写しの S3（階層型の保存・KRaft のスナップショット・使用量）。東京のデータ面のロールは、書けない・消せない |

- **SCP**：東京・大阪以外のリージョンの利用を禁止する（CloudFront・ACM・IAM などのグローバルなサービスを除く）。CloudTrail・Config・GuardDuty の停止、KMS のキーの削除の予約、S3 の Object Lock の解除を、break-glass のロール以外に禁止する。
- **S2 で足すもの**：データ面を物理クラスタの群ごとのアカウント（dp-prod-01 など）に分ける。Dedicated は利用者ごとのアカウント。コネクターは別のアカウント（[ADR-0042](../decisions/0042-connector-runtime-isolation.md)）。
- security-and-acls の領域が問うた「KMS の要求の上限（東京で 20,000 回/秒）でアカウントを分けるか」は、S1 では分けない。KMS を呼ぶのは S3 の SSE-KMS（Bucket Keys で最大 99% 減る）と EBS の付け替えだけで、上限から遠い（[capacity.md](capacity.md) の 6 節）。KMS の `ThrottlingException` を監視し、出たら S2 の分割を前倒しする。

## 2. ネットワーク

### 2.1 データ面の VPC（dp-prod）

1 つの VPC に、エッジと全ての EKS を置く。AZ は AZ ID で `apne1-az1`・`apne1-az2`・`apne1-az4` に固定する（[ADR-0043](../decisions/0043-aws-accounts-network-and-eks-layout.md)）。東京には AZ ID が 4 つあり（[AWS Availability Zones](https://docs.aws.amazon.com/global-infrastructure/latest/regions/aws-availability-zones.html)）、`apne1-az3` は新しい資源を作りにくい AZ だという報告がある（[Zenn の解説](https://zenn.dev/ncdc/articles/867f5d20bb61f9)）ので使わない。AWS の文書は、拡張が難しくなった AZ（constrained）では新しい資源を作れなくなることがあるとするが、どの AZ かは書いていない（同上の AWS の文書、2026-09-27 に確認）。apne1-az3 がそれに当たるかは未検証で、E1 の `dataplane-vpc` で、アカウントの `describe-availability-zones` と、r8g・m8g・c8g の `describe-instance-type-offerings --location-type availability-zone-id` で確かめる。

| サブネット（AZ ごと） | 置くもの | 外への経路 |
| --- | --- | --- |
| public | NLB（EIP）、NAT ゲートウェイ | Internet Gateway |
| edge | Envoy のノード（`dp-edge` の EKS） | NAT 経由 |
| nodes | ブローカー・コントローラー・システムのノード（`dp-standard-*`、`dp-basic-*`） | NAT 経由（ECR・OS の更新は VPC エンドポイントを優先） |
| endpoints | インターフェイス型の VPC エンドポイント、VPC Lattice | なし |

- CIDR は VPC に /16、nodes に AZ ごと /18。Pod は VPC CNI で VPC の IP を持つ（ブローカーは 1 ノード 1 Pod なので消費は小さい）。
- VPC エンドポイント：S3（ゲートウェイ型、無料）、KMS・STS・ECR（api・dkr）・SQS・Firehose・CloudWatch Logs・AMP（aps-workspaces）・EKS・EKS Auth（インターフェイス型。東京で 1 エンドポイント・1 AZ あたり $0.014/時、処理 $0.01/GB）。
- 外への通信は、NAT と Route 53 Resolver の DNS Firewall の許可リスト（AWS のサービスと本家・Strimzi の取得先だけ）に絞る。

### 2.2 ブローカーのリスナーとセキュリティグループ

| リスナー | ポート | 認証 | 届く元 |
| --- | --- | --- | --- |
| TENANT | 9092 | SASL_SSL（PLAIN、API キー） | Envoy のセキュリティグループだけ |
| REPLICATION | 9091 | mTLS（Strimzi のクラスタの CA） | 同じ物理クラスタのブローカー |
| INTERNAL | 9093 | mTLS | データ面のエージェント、クォータのコーディネーター、合成監視のカナリア（内側） |
| CONTROLLER | 9090 | mTLS | 同じ物理クラスタのブローカーとコントローラー |

- テナントの経路（Envoy）から、TENANT 以外のポートには届かない（multi-tenancy-and-quotas の 10 節の前提）。
- 物理クラスタの間は、セキュリティグループで互いに届かないようにする（別の物理クラスタのブローカーの TENANT のポートにも、Envoy 以外から届かない）。

### 2.3 制御面とデータ面の間

| 向き | 方式 | 運ぶもの |
| --- | --- | --- |
| データ面 → 制御面（internal-api） | VPC Lattice のサービス（IAM の認証。EKS Pod Identity の役割で SigV4 署名） | 望ましい状態の取得、観測の報告、命令の結果、KRaft の写し（[control-plane-and-provisioning.md](control-plane-and-provisioning.md) の 5・6 節） |
| データ面 → 制御面（SQS） | SQS のインターフェイス型のエンドポイント。キューのリソースポリシーで dp-prod のエージェントの役割だけを許す | 合図と命令の受信 |
| データ面 → 制御面（AMP） | AMP のインターフェイス型のエンドポイント。アカウントをまたぐ remote write の役割 | 運用とテナントのメトリクス |
| 制御面 → データ面 | 作らない | — |

- control-plane-and-provisioning の領域が持ち越した「エージェントから internal-api への経路」は VPC Lattice にする。PrivateLink＋自前の認証より、IAM の役割と `pc_id` の一致を 1 か所で確かめられる。VPC Lattice の東京の単価は、サービスごとに $0.0325/時、処理のバイト $0.0325/GB、要求は 1 時間に 30 万まで無料で超えた分が 1 要求 $0.00000013（AWS Price List API の `AmazonVPC`、2026-09-27 に確認）。流量は小さく、internal-api のサービス 1 つで月に約 $24 の固定費が主になる。

## 3. EKS

### 3.1 クラスタ

| EKS | 中身 | 物理クラスタ |
| --- | --- | --- |
| `dp-standard-1` | Standard の物理クラスタ（Strimzi）、エージェント、クォータのコーディネーター、OTel Collector | 5 まで |
| `dp-basic-1` | Basic の物理クラスタ | 5 まで |
| `dp-edge` | Envoy、sni-router | — |

- 1 つの EKS に物理クラスタを 5 つまで（[control-plane-and-provisioning.md](control-plane-and-provisioning.md) の 7.1 節）。6 つ目が要るときは `dp-standard-2` を作る。
- エッジを別の EKS にするのは、物理クラスタの EKS の版の更新と、入口の Envoy の更新を分けるため。
- EKS の版は、標準のサポートの中に保つ（延長のサポートは東京で $0.50/時が上乗せ。Price List API）。更新は `dp-verify` → `dp-staging` → `dp-basic-1` → `dp-standard-1` の順。ノードの入れ替えはブローカーの再起動になるので、[ADR-0050](../decisions/0050-rolling-upgrade-gates-and-upstream-tracking.md) の関門で進める。

### 3.2 ノードグループ

物理クラスタ × AZ ID × 役割ごとの、マネージドノードグループ（Auto Scaling グループが 1 つの AZ のサブネットだけを持つ）。taint とラベルで、その物理クラスタの Pod だけを載せる。Karpenter は使わない（ブローカーは台数が決まっていて、EBS の付け替えを同じ AZ で確実に行いたいため）。

| ノードグループ | 型（初期値） | 台数（S1 の初期） | 根拠 |
| --- | --- | --- | --- |
| `pc-<id>-brokers-<az-id>`（Standard） | r8g.4xlarge（16 vCPU、128 GiB、ネットワーク 7.5 Gbps、EBS 5,000 Mbps） | AZ ごとに 2（物理クラスタで 6）から、最大 10（30） | [ADR-0048](../decisions/0048-broker-design-point-and-cost-model.md)。1 台 W = 80 MB/秒 |
| `pc-<id>-brokers-<az-id>`（Basic） | m8g.4xlarge（16 vCPU、64 GiB、同じ帯域） | 同上 | 同上。Basic は遅延の目標が緩い |
| `pc-<id>-controllers-<az-id>` | m8g.xlarge（16 GiB） | AZ ごとに 1（S2 は 2・2・1） | [ADR-0015](../decisions/0015-kraft-dynamic-quorum-and-controller-sizing.md) |
| `system-<az-id>` | m8g.xlarge | EKS ごとに AZ ごと 1 | Strimzi、エージェント、コーディネーター、Collector |
| `edge-<az-id>` | c8g.xlarge（GA）→ c8g.2xlarge | AZ ごとに 2 から | [capacity.md](capacity.md) の 7 節 |

- 帯域の値は [Memory optimized](https://docs.aws.amazon.com/ec2/latest/instancetypes/mo.html) と [General purpose](https://docs.aws.amazon.com/ec2/latest/instancetypes/gp.html) の基準の値（2026-09-27 に確認）。4xlarge 以下はバーストがあるが、設計では基準の値だけを使う。
- ブローカーのボリュームは EBS CSI の gp3（物理クラスタの KMS のキー）。永続ボリュームは AZ に結び付くので、ノードが入れ替わっても同じ AZ ID のノードグループの中で付け直る。

### 3.3 AZ ID の固定

- Terraform は、サブネットとノードグループを AZ ID から作る。AZ の名前は、アカウントの中で `describe-availability-zones` で引き当てる。
- Strimzi の `rack.topologyKey` は AZ ID のラベル（`topology.k8s.aws/zone-id`）にする。このラベルは、EKS の制御面が動かす AWS のクラウドコントローラーマネージャーがノードに付ける（[cloud-provider-aws の well_known_labels.go](https://github.com/kubernetes/cloud-provider-aws/blob/master/pkg/providers/v1/well_known_labels.go)。2024-03 の [#855](https://github.com/kubernetes/cloud-provider-aws/pull/855) で追加。Karpenter も同じラベルを付ける。2026-09-27 に確認）。E1 の `eks-and-nodegroups` の `broker.rack` の起動の検査で、実際のノードに付くことを確かめる。付かなければ、ノードグループのラベルで `<brand>.io/zone-id` を付け、それを使う。control-plane-and-provisioning の 7.1 節と ADR-0032 も、統合の工程で AZ ID のラベルに改めた（[ADR-0012](../decisions/0012-durability-settings-and-elr.md)）。
- ブローカーは起動時に、`broker.rack` がノードの AZ ID と一致することを確かめ、違えば起動しない。

### 3.4 人のアクセス

- EKS の API には、IAM Identity Center の期限つきの権限（最長 4 時間）と EKS のアクセスエントリーで入る。常設の人の管理者を置かない。
- ブローカーのノードへの対話的なログインは止め、break-glass の手順（SSM Session Manager、記録つき）に限る（[broker-and-log-storage.md](broker-and-log-storage.md) の 8 節）。
- AI エージェントには、本番の EKS・AWS への経路を与えない。

## 4. 物理クラスタの AWS の資源

物理クラスタを 1 つ作るたびに、pc-provisioner が Terraform のルートモジュール `pcs/pc-<id>` を作る（[control-plane-and-provisioning.md](control-plane-and-provisioning.md) の 7.2 節の手順 2）。

| 資源 | 名前 | 中身 |
| --- | --- | --- |
| KMS のキー（CMK） | `alias/<brand>/pc-<id>` | EBS と階層型の S3 の暗号化。キーのポリシーはその物理クラスタのノードとブローカーの役割だけ（[ADR-0030](../decisions/0030-encryption-and-audit-logs.md)） |
| S3（階層型） | `<brand>-tiered-<pc-id>-apne1` | [ADR-0018](../decisions/0018-s3-remote-storage-manager.md)。バージョニング、パブリックアクセスの遮断、SSE-KMS＋Bucket Keys |
| S3（運用） | `<brand>-ops-<pc-id>-apne1` | KRaft のスナップショットの写し（1 時間ごと。[ADR-0015](../decisions/0015-kraft-dynamic-quorum-and-controller-sizing.md)）、RLMM のスナップショットは階層型のバケットの `_rlmm/` |
| IAM の役割 | `pc-<id>-broker`、`pc-<id>-agent` | EKS Pod Identity。ブローカーは自分のバケットの読み書き、エージェントは一覧・Firehose・Lattice |
| ノードグループ | 3.2 節 | — |
| CRR の規則 | 論理クラスタごと（写しを有効にしたもの）と `_rlmm/` | 大阪の dr-vault のバケットへ（[tiered-and-object-storage.md](tiered-and-object-storage.md) の 6.6 節） |

- Strimzi の Kafka・KafkaNodePool・StorageClass は GitOps（Argo CD）で適用し、Terraform では扱わない（[ADR-0032](../decisions/0032-strimzi-for-physical-clusters.md)）。

## 5. 入口：NLB と SNI のプロキシ

[ADR-0044](../decisions/0044-nlb-sni-proxy-and-zonal-hostnames.md)。

### 5.1 ホスト名と DNS

| 名前 | 形 | DNS |
| --- | --- | --- |
| ブートストラップ | `<lc-id>.<region>.<brand>.<domain>:9092`（例 `lc-7kq2vx.apne1.<brand>.<domain>`） | `*.<region>.<brand>.<domain>` → NLB（エイリアス。3 つの AZ） |
| ブローカー | `b<broker-id>-<lc-id>.<az-id>.<region>.<brand>.<domain>:9092`（例 `b12-lc-7kq2vx.apne1-az2.apne1.<brand>.<domain>`） | `*.<az-id>.<region>.<brand>.<domain>` → その AZ の NLB の EIP（A レコード） |

- DNS の記録は、リージョンと AZ の 4 つだけ。論理クラスタを作っても DNS を変えない（SC-3 の 5 分から DNS の反映を外す）。
- Route 53 のワイルドカードは一番左のラベルだけで、その下の全ての階層に答える。より具体的な `*.<az-id>.<region>…` が優先される（[DNS domain name format](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/DomainNameFormat.html)、2026-09-27 に確認）。
- ブローカーは、名前空間のパッチ P2 で、テナントの形のホスト名を広告する（[multi-tenancy-and-quotas.md](multi-tenancy-and-quotas.md) の 4.4 節）。ホスト名に `broker.rack`（AZ ID）を入れる。multi-tenancy-and-quotas の 4.4 節も、統合の工程でこの形に改めた。
- SNI の lc-id と API キーの lc-id の一致（[ADR-0025](../decisions/0025-tenant-namespace-patch.md)）は、ブートストラップとブローカーのどちらのホスト名でも、左のラベルから lc-id を取り出して行う。

### 5.2 経路

```
クライアント（AZ = apne1-az2、client.rack = apne1-az2）
  │ DNS：b12-lc-7kq2vx.apne1-az2.apne1.<brand>.<domain> → az2 の NLB の EIP
  ▼
NLB（az2 のノード。cross-zone 無効）── TCP:9092、Proxy Protocol v2 ──▶ Envoy（az2）
  │  listener filter：proxy_protocol、tls_inspector（SNI を読む。TLS は終端しない）
  │  network filter：RBAC（論理クラスタの IP の許可リスト）→ sni_cluster → tcp_proxy（on-demand CDS）
  ▼
sni-router（xDS）が SNI から上流を決める：lc-7kq2vx → pc-3x9k、b12 → Pod の IP（az2）
  ▼
ブローカー 12（az2）の TENANT リスナー：TLS を終端、SASL/PLAIN、SNI と API キーの lc-id の一致
```

- **同じ AZ の経路**：ブローカーのホスト名の AZ ID で DNS がその AZ の NLB のノードを返し、NLB は同じ AZ の Envoy にだけ送り（cross-zone 無効。[Network Load Balancers](https://docs.aws.amazon.com/elasticloadbalancing/latest/network/network-load-balancers.html)）、Envoy は同じ AZ のブローカーにだけ送る。クライアントが `client.rack` を設定すれば、読み取りは全て同じ AZ に留まる（[ADR-0013](../decisions/0013-fetch-from-follower.md)）。
- **ブートストラップ**：NLB のどの AZ にも着く。Envoy は、自分の AZ の、その物理クラスタのブローカーを選ぶ。ブートストラップは Metadata を取るだけなので、AZ をまたいでも量は小さい。
- **AZ をまたぐ場合**：古い DNS のキャッシュなどで、ある AZ の Envoy に別の AZ のブローカーの SNI が届いたら、送るが数える（`edge_cross_az_connections`）。
- **クライアントから NLB まで**：クライアントの AZ とリーダーの AZ が違う produce は、クライアントから NLB までで AZ をまたぐ。これは本家のクライアントの振る舞いで、避けられない（NFR-010 の見積もりの「プロデューサー → リーダー 2/3」）。

### 5.3 NLB

| 設定 | 値 | 理由 |
| --- | --- | --- |
| 種類 | インターネット向け、AZ ごとに EIP | IP を固定し、利用者のファイアウォールに載せられる。AZ ごとの DNS に使う |
| cross-zone | 無効（既定） | 5.2 節 |
| リスナー | TCP:9092 | TLS は Envoy も終端しない |
| ターゲット | Envoy の Pod（IP のターゲット。AWS Load Balancer Controller） | — |
| Proxy Protocol v2 | 有効 | Envoy がクライアントの IP を知るため。IP のターゲットで TCP のときは、既定でクライアントの IP を保たない（[Target group attributes](https://docs.aws.amazon.com/elasticloadbalancing/latest/network/edit-target-group-attributes.html)、2026-09-27 に確認） |
| アイドルのタイムアウト | 610 秒 | 既定は 350 秒（60〜6,000 秒で変えられる）。ブローカーの `connections.max.idle.ms`（600 秒）より短いと、NLB が先に追跡をやめ、クライアントが RST を受ける。350 秒を超えるときは、Envoy のノードの ENI の追跡のタイムアウト（`TcpEstablishedTimeout`）も同じ以上にする（[Network Load Balancers](https://docs.aws.amazon.com/elasticloadbalancing/latest/network/network-load-balancers.html)） |
| 登録の解除の遅延 | 300 秒（既定）。接続の終了を有効 | Envoy の入れ替えで、既存の接続を排出する |
| zonal shift | 有効 | 1 つの AZ の不調で、ブートストラップをその AZ から外す |

- NLB の料金：東京で $0.0243/時と、NLCU（TCP で新しい接続 800/秒、同時の接続 10 万、処理 1 GB/時のうち最大）あたり $0.006/時（[ELB pricing](https://aws.amazon.com/elasticloadbalancing/pricing/)、Price List API）。流量の多いときは処理のバイトで決まり、1 GB あたり $0.006 になる。読み取り 3 倍のトピックでは、書き込み 1 GB あたり 4 GB が通るので約 $0.024（[capacity.md](capacity.md) の 8 節）。

### 5.4 Envoy と sni-router

- Envoy は AZ ごとの Deployment（`dp-edge`、エッジのノードに 1 ノード 1 Pod）。上流のブローカーへの接続の数は、クライアントの接続と同じ（TCP をそのまま中継する）。
- **sni-router**（Go、go-control-plane。xDS のサーバー）：
  - 論理クラスタ → 物理クラスタの対応を internal-api から取り（1 分ごとと、論理クラスタの作成の合図で）、ローカルのディスクに写しを持つ。制御面が止まっても、最後の写しで動く。
  - ブローカーの Pod の IP は、各 EKS の EndpointSlice（Strimzi がブローカーごとに作る Service）を直接見る。制御面を通さない。
  - Envoy から on-demand CDS で「SNI のホスト名」の名前のクラスタを問われたら、上流（ブローカー、ブートストラップなら同じ AZ のブローカーの集合）を返す。知らない SNI には空を返し、Envoy は接続を閉じる。
- **論理クラスタの作成の流れ**（[control-plane-and-provisioning.md](control-plane-and-provisioning.md) の 9 節の手順 4）：制御面が論理クラスタを `provisioning` にした合図で、sni-router が対応を取り込む。DNS は変えない。
- **IP の許可リスト**：論理クラスタごとの CIDR を、RBAC のネットワークフィルターの DENY の規則（`requested_server_name` が論理クラスタの接頭辞で、送信元が許可リストにない）として配る（[security-and-acls.md](security-and-acls.md) の 15 節の決定）。送信元は Proxy Protocol の値。RBAC の更新が Envoy のリスナーの排出を起こさずに入るかは未検証（E12 の `edge-production`）。
- **送信元 IP ごとの制限**：security-and-acls の 3.6 節の「送信元 IP ごとの新しい接続 50 回/秒」は、Envoy の組み込みのフィルターでは送信元ごとに数えられない（`local_ratelimit` の network のフィルターは、フィルターの鎖ごとに 1 つのトークンバケットを Envoy のプロセス全体で持つ。送信元ごとには、外部のレート制限のサービスが要る。[Local rate limit](https://www.envoyproxy.io/docs/envoy/latest/configuration/listeners/network_filters/local_rate_limit_filter)、2026-09-27 に確認）。S1 は、Envoy ごとの接続の頻度の上限と、制御面が集めた認証の失敗の多い IP の拒否の一覧（RBAC）で代える。送信元ごとの制限は S2 で、外部のレート制限のサービスを入れるかを決める。
- **ブローカーは送信元 IP を知らない**：Envoy から先は Envoy の IP になる。本家のブローカーは Proxy Protocol を受けない（4.3 の Broker Configs に Proxy Protocol の設定がなく、KIP の一覧にも採択されたものがない。2026-09-27 に確認）。監査ログの IP と、認証の失敗の IP ごとの集計は、Envoy のアクセスログ（下流の送信元と、上流への接続の送信元ポート）とブローカーの接続を突き合わせて作る。security-and-acls の 3.6 節・8 節も、統合の工程でこの前提に改めた。
- Envoy の `tcp_proxy` は `on_demand.odcds_config` で、知らないクラスタへの接続を止めて on-demand CDS で問い合わせ、終わってから再開する。`sni_cluster` のフィルターは SNI をそのまま上流のクラスタの名前にする（[TcpProxy](https://www.envoyproxy.io/docs/envoy/latest/api-v3/extensions/filters/network/tcp_proxy/v3/tcp_proxy.proto)、[Upstream Cluster from SNI](https://www.envoyproxy.io/docs/envoy/latest/configuration/listeners/network_filters/sni_cluster_filter)、2026-09-27 に確認）。この 2 つを組み合わせて動くこと、1 万のクラスタでの Envoy のメモリーは未検証で、E1 の `edge-poc` で確かめる。動かなければ、論理クラスタ × ブローカーの filter chain を xDS で配る形に替える（[ADR-0044](../decisions/0044-nlb-sni-proxy-and-zonal-hostnames.md) の B）。

### 5.5 証明書

- ブローカーが示すテナント向けの証明書は、ACM の書き出せる公開の証明書にする。1 枚に `*.<region>.<brand>.<domain>` と `*.<az-id>.<region>.<brand>.<domain>`（3 つ）を載せる（ワイルドカードは 1 階層だけを守るので、AZ ごとに要る）。大阪の名前（8 節）も同じ証明書に載せる。
- ACM の公開の証明書は、2026-02-18 から最長 198 日。書き出せる証明書は、発行と更新ごとにワイルドカードの名前あたり $79（[ACM exportable certificates](https://docs.aws.amazon.com/acm/latest/userguide/acm-exportable-certificates.html)、[ACM pricing](https://aws.amazon.com/certificate-manager/pricing/)、2026-09-27 に確認）。8 つの名前で 1 回 $632、年に約 2 回。
- 配り方：ACM の更新の通知（EventBridge）で、shared のアカウントの小さな処理が書き出し、各物理クラスタの Secret（Strimzi の `brokerCertChainAndKey`）を更新する。Strimzi がブローカーをロールして読み込ませる（[ADR-0050](../decisions/0050-rolling-upgrade-gates-and-upstream-tracking.md) の関門を通す）。証明書の秘密鍵は、ブローカーの Secret と shared の書き出しの処理の外に出さない。
- 期限の 30 日前と 7 日前にアラート（[observability.md](observability.md) の 8 節）。CA/B フォーラムの決定で、2027-03 から最長 100 日、2029-03 から 47 日未満になる予定（同上の ACM の案内）。更新の自動化を前提にする。
- security-and-acls の 15 節の「物理クラスタごとに分けるか」は、S1 では分けない（リージョンで 1 枚）。

## 6. PrivateLink（S2）

- 内部向けの NLB を別に作り、VPC エンドポイントサービスにする。ターゲットは同じ Envoy。利用者は、自分の VPC にインターフェイス型のエンドポイントを作り、同じ AZ ID に置く。
- 利用者の VPC のプライベートのホストゾーンに、`*.<region>.<brand>.<domain>` → エンドポイントのリージョンの DNS 名、`*.<az-id>.<region>.<brand>.<domain>` → そのエンドポイントの AZ の DNS 名、を作ってもらう（手順と Terraform の例を配る）。
- Envoy は、Proxy Protocol v2 の TLV（`PP2_TYPE_AWS` 0xEA、サブタイプ 0x01 がエンドポイントの ID）で、接続のエンドポイントを知る（[Target group attributes](https://docs.aws.amazon.com/elasticloadbalancing/latest/network/edit-target-group-attributes.html)）。論理クラスタごとに許すエンドポイントの ID を RBAC で確かめる。PrivateLink からの接続の送信元 IP は NLB の IP になる。
- エンドポイントサービスの接続は、組織ごとに許した AWS のアカウントだけを受ける。
- 料金：エンドポイントの時間と処理のバイトは利用者の負担（[PrivateLink pricing](https://aws.amazon.com/privatelink/pricing/)。東京の単価は Price List API で 1 AZ あたり $0.014/時、$0.01/GB）。当社は内部の NLB の費用を負う。
- PrivateLink の論理クラスタでは、インターネット向けの経路を閉じる選択肢を持つ（IP の許可リストを空にする）。

## 7. S3 と KMS

| バケット | アカウント | 中身 | 保持・保護 | 大阪へ |
| --- | --- | --- | --- | --- |
| `<brand>-tiered-<pc-id>-apne1` | dp-prod | 階層型の保存のセグメント、`_rlmm/` | トピックの保持。古い版は 1 日 | 論理クラスタごとの選択と `_rlmm/`（CRR、RTC） |
| `<brand>-tiered-<pc-id>-apne3` | dr-vault | 大阪の写し | 最大の保持＋7 日。削除を写さない | — |
| `<brand>-ops-<pc-id>-apne1` | dp-prod | KRaft のスナップショット（1 時間ごと） | 30 日 | 常に（CRR） |
| `<brand>-audit-apne1` | log-archive | テナントの監査ログ、耐久性の監査の事象 | Object Lock（コンプライアンス）1 年 | 常に（CRR、大阪も Object Lock） |
| `<brand>-usage-apne1` | cp-prod | 使用量の生の記録（Parquet） | 10 年の案（経理・法務の確認待ち） | 常に（CRR） |
| `<brand>-logs-apne1` | log-archive | 運用のログの長期の保管（Firehose） | 1 年 | しない |

| KMS のキー | アカウント | 使う所 |
| --- | --- | --- |
| `pc-<id>` | dp-prod | EBS、階層型と運用の S3 |
| `dr-<pc-id>` | dr-vault（大阪） | 大阪の写し（CRR で入れ替えて暗号化） |
| `cp` | cp-prod（マルチリージョン） | Aurora、制御面の S3 |
| `audit`・`usage` | log-archive・cp-prod（マルチリージョン） | 監査ログ・使用量 |

- 同じリージョンの S3 への転送は、ゲートウェイ型のエンドポイントで無料。
- 全ての SSE-KMS のバケットで S3 Bucket Keys を有効にする（[ADR-0030](../decisions/0030-encryption-and-audit-logs.md)）。
- KMS のキーは $1/月（東京。Price List API）。物理クラスタごとのキーの費用は小さい。

## 8. 災害復旧

[ADR-0045](../decisions/0045-osaka-disaster-recovery-scope.md)。手順は [runbooks/disaster-recovery.md](../runbooks/disaster-recovery.md)。

### 8.1 AZ の障害（NFR-001・NFR-009：RPO 0、RTO 1 分）

| 部品 | 動き |
| --- | --- |
| ブローカー | ISR が 2 になり、書き込みは続く。リーダーは残る 2 つの AZ へ移る（`broker.session.timeout.ms` 9 秒）。3 つ目の複製を他の AZ に作らない（[replication-and-durability.md](replication-and-durability.md) の 3.2・4 節） |
| コントローラー | S1 は 3 台のうち 1 台を失う。過半数は残る。その間、コントローラーの変更をしない |
| NLB・Envoy | その AZ の EIP 宛ての接続が失敗する。その AZ のブローカーも止まっているので、クライアントはメタデータを取り直して他のリーダーへ移る。zonal shift でブートストラップから外す |
| 制御面 | Aurora は別の AZ へフェイルオーバー（通常 60 秒未満）。ECS は残る AZ で起動し直す |
| クライアントの `client.rack` | その AZ のコンシューマーも止まっている想定。他の AZ のコンシューマーは影響を受けない |

- 残る 2 つの AZ のブローカーの負荷は約 1.5 倍になる。設計点を基準の帯域の 60% にしているのはこのため（[ADR-0048](../decisions/0048-broker-design-point-and-cost-model.md)）。
- 手順は [runbooks/incident-response.md](../runbooks/incident-response.md) の「AZ の喪失」。

### 8.2 リージョンの障害（NFR-009）

- 制御面：大阪にウォームスタンバイ（Aurora Global Database の二次、ECS の最小のタスク、ALB、SQS、ECR の複製、Secrets Manager の複製、マルチリージョンの KMS のキー）。RPO 1 分・RTO 1 時間。
- データ面：大阪に常設するのは、VPC、エッジ（NLB と Envoy 2 台、sni-router）、ブローカーのノードのない EKS 1 つ（Strimzi とエージェントを入れたもの）、Terraform の骨組み。障害のときに、物理クラスタのノードグループを作る。
- 戻せるものと戻せないものは [ADR-0045](../decisions/0045-osaka-disaster-recovery-scope.md) の表のとおり。要点：
  - 論理クラスタ、API キー（ハッシュ）、トピック・ACL の定義は戻る。書き込みの経路は、目標 4 時間で作り直す（SLA にしない）。
  - レコードは、写しを有効にした論理クラスタの、S3 に上がった前の部分だけ。失いうる範囲は、閉じていないセグメント（最大 1 時間か 256 MiB）＋ LSO で止まった部分＋ CRR の遅れ（99.9% は 15 分以内。[S3 RTC](https://docs.aws.amazon.com/AmazonS3/latest/userguide/replication-time-control.html)）。
  - 圧縮のトピック、コンシューマーのオフセット、トランザクションの状態は戻らない。
- **ホスト名**：ブートストラップの `*.apne1.<brand>.<domain>` を大阪の NLB へ向け直す。大阪のブローカーは `…<az-id>.apne3.<brand>.<domain>` を広告する。クライアントはブートストラップを変えずにつなぎ直せる。そのため、大阪の証明書に東京と大阪の両方の名前を載せる（5.5 節）。
- 失う範囲は `segment.ms`（と上げの遅れ、CRR の遅れ）で、`local.retention.ms` は関係しない。S3 への上げはセグメントが閉じた直後に行われ、ローカルの保持を待たない（統合の工程で [tiered-and-object-storage.md](tiered-and-object-storage.md) の 6.6 節を直した）。
- 大阪の EC2 の空き：リージョンの障害では、他社も大阪へ移る。ブローカーの台数の容量の予約（On-Demand Capacity Reservations）は、S1 の費用に見合わないのでしない。代わりに（2026-09-27 に改めた。[ADR-0045](../decisions/0045-osaka-disaster-recovery-scope.md) の注記）、大阪（`ap-northeast-3`）に、1 つの物理クラスタのコントローラーの 3 台（m8g.xlarge、AZ ごとに 1 台）と Envoy の 3 台（AZ ごとに 1 台。常設の 2 台はこの予約を使う）の On-Demand Capacity Reservation を持つ。単価（Price List API、2026-09-27 に確認）は m8g.xlarge $0.23188/時、c8g.xlarge $0.20008/時で、予約の全体は月に約 $946、常設の Envoy の分を除いて増えるのは月に約 $654。ブローカーは、四半期の `osaka-capacity-check`（[disaster-recovery.md](../runbooks/disaster-recovery.md) の D-1）と年 1 回の訓練で確かめる。代わりの型（r7g、m7g）を Terraform の変数で選べるようにする。

### 8.3 論理的な破損

- 誤った操作や不具合で KRaft のメタデータを失ったときの最後の手段は、1 時間ごとの KRaft のスナップショットの写し（[ADR-0015](../decisions/0015-kraft-dynamic-quorum-and-controller-sizing.md)）と `kraft_snapshots`。本家にスナップショットからクォーラムを作り直す正式な手順はない（4.3 の [KRaft](https://kafka.apache.org/43/operations/kraft/) の運用の文書に載っていない。2026-09-27 に確認）。runbook で、検証の環境で年 2 回試す。
- 誤って消したトピックのデータは、S3 のバージョニング（古い版は 1 日）の間だけ、ログの前の部分を戻せる（Kora の 4.6.2 節と同じ範囲）。S1 では利用者への約束にしない。

## 9. Terraform の構成

```
infra/                                    # 開発リポジトリ
├── modules/
│   ├── account-baseline/                 # SCP の対象外の共通の設定、CloudTrail の配送
│   ├── vpc-dataplane/                    # 2.1 節。AZ ID を入力にする
│   ├── eks-cluster/                      # EKS、アドオン（VPC CNI、EBS CSI、Pod Identity）
│   ├── nodegroup/                        # 物理クラスタ × AZ ID × 役割
│   ├── edge/                             # NLB、EIP、ターゲットグループ、Route 53 の 4 つの記録
│   ├── physical-cluster-aws/             # 4 節（CMK、バケット、IAM、CRR の規則の土台）
│   ├── dr-vault-bucket/
│   └── control-plane/                    # ECS、Aurora、SQS、Lattice のサービス
└── live/
    ├── org/                              # アカウント、OU、SCP
    ├── shared/                           # ECR、Route 53、Grafana、状態のバケット
    ├── log-archive/
    ├── cp/{dev,staging,prod}/{apne1,apne3}/
    ├── dp/{dev,staging,verify,prod}/apne1/
    │   ├── network/
    │   ├── edge/
    │   ├── eks-standard-1/  eks-basic-1/  eks-edge/
    │   └── pcs/pc-<id>/                  # pc-provisioner が雛形から作る
    ├── dp/prod/apne3/                    # 大阪の骨組み
    ├── dr-vault/
    └── probe/{apne1,apne3}/
```

- 状態は shared のアカウントの S3 に、ルートモジュールごとに置く（S3 のネイティブのロック）。大阪へ CRR する（大阪での作り直しに要る）。
- ルートモジュールを小さく分け、1 回の apply の影響の範囲を 1 つの物理クラスタか 1 つの EKS に絞る。
- apply は CI の役割（OIDC）だけが行う。prod の apply は、計画を Ops が承認する。VPC とエッジの変更は 2 人で承認する（[ADR-0043](../decisions/0043-aws-accounts-network-and-eks-layout.md) の Consequences）。
- Kubernetes の中の資源（Strimzi の CR、Envoy、sni-router、エージェント）は Argo CD（GitOps）で扱う（[delivery.md](delivery.md)）。
- CI の検査：AZ の名前の直書きがない、全てのバケットが暗号化・パブリックアクセスの遮断・Bucket Keys を持つ、物理クラスタの CMK のキーのポリシーが他の物理クラスタの役割を含まない。

## 10. 段階を上げる判断の基準

| 指標 | S1 → S2 を始める目安 |
| --- | --- |
| 物理クラスタの数 | 1 つの EKS に 5 つに近づく、または dp-prod のアカウントの上限（vCPU、EBS）の 60% |
| 1 つの VPC の IP | nodes のサブネットの使用率 60% |
| NLB の処理のバイトの費用 | NLB の費用が、書き込み 1 GB あたり $0.02 を続けて超え、NFR-010 を圧迫する（[ADR-0044](../decisions/0044-nlb-sni-proxy-and-zonal-hostnames.md) の X の再評価） |
| PrivateLink の要望 | 本番のテナントの契約の条件に入る |
| 大阪の書き込みの経路 | 利用者が、リージョンの障害で数分の RPO を求める（クラスタの間の複製。S2） |

## 11. コストの概算（S1、本番、1 か月）

**大まかな見積もりである。** 東京のオンデマンドの単価（Price List API、2026-09-27）をもとにした ±50% の幅の値。税、サポートプラン、Savings Plans（東京の r8g.4xlarge で、1 年・前払いなしの Compute Savings Plans が約 28%、EC2 Instance Savings Plans が約 34% 下がる。[capacity.md](capacity.md) の 8 節）を含めない。根拠と式は [capacity.md](capacity.md) の 8〜10 節。

### 11.1 GA の最小の構成

Standard の物理クラスタ 2 つ（各 r8g.4xlarge × 6）、Basic の物理クラスタ 1 つ（m8g.4xlarge × 6）。流量は小さい（平均の書き込み 50 MB/秒）とする。

| 項目 | 月額（USD、概算） |
| --- | --- |
| ブローカー（r8g.4xlarge × 12、m8g.4xlarge × 6） | 14,000 |
| ブローカーの EBS（gp3 2 TiB × 18） | 3,700 |
| コントローラー（m8g.xlarge × 9） | 1,600 |
| EKS（3 クラスタ）とシステムのノード（m8g.xlarge × 9） | 1,800 |
| エッジ（NLB、Envoy c8g.xlarge × 6、EIP） | 1,200 |
| VPC エンドポイント、NAT、VPC Lattice | 800 |
| 制御面（ECS、Aurora r8g.large × 2＋大阪の二次、SQS、ALB）と大阪の待機 | 4,500 |
| 大阪の容量の予約（コントローラー m8g.xlarge × 3、Envoy c8g.xlarge × 3。常設の Envoy の分を除いて増える額。8.2 節） | 700 |
| 可観測性（運用とテナントの AMP、CloudWatch Logs、Grafana） | 2,500 |
| 合成監視（probe の東京と大阪） | 300 |
| **固定の費用の合計** | **約 31,000** |
| 流量に比例する費用（AZ をまたぐ転送、NLB の処理、S3）：書き込み 1 GB あたり約 $0.085（[capacity.md](capacity.md) の 8 節）× 月 13 万 GB | 約 11,000 |
| dev・staging・dp-verify（Jepsen、負荷試験は必要なときだけ広げる） | 約 12,000 |

### 11.2 S1 の上限（1,000 の論理クラスタ、書き込みのピーク 2 GB/秒・平均 0.8 GB/秒、パーティション 20 万）

| 項目 | 月額（USD、概算） | 備考 |
| --- | --- | --- |
| ブローカー（Standard r8g.4xlarge × 90、Basic m8g.4xlarge × 60）と EBS | 160,000 | パーティションの数で決まる（ブローカーあたり 4,000 の複製。[capacity.md](capacity.md) の 10 節） |
| コントローラー、EKS、システムのノード | 5,000 | |
| エッジ（Envoy c8g.2xlarge × 30、NLB の時間） | 9,000 | |
| NLB の処理のバイト | 50,000 | 平均 3.2 GB/秒（書き込み 0.8＋読み取り 2.4）× $0.006/GB |
| AZ をまたぐ転送 | 112,000 | 月 210 万 GB の書き込み × $0.053 |
| S3（7 日の保持の保存、要求） | 14,000 | |
| 制御面、可観測性、大阪の待機、その他 | 13,000 | |
| **合計** | **約 363,000** | 書き込み 1 GB あたり約 $0.17。パーティションだけのために持つ約 123 台の分（約 $135,000）を除くと約 $0.11 |

- 高くなる理由は 3 つ。(1) パーティションの数でブローカーの台数が決まり、スループットの 5 倍を超える台数を持つ。(2) AZ をまたぐ転送。(3) NLB の処理のバイト。統合の工程で、(1) はパーティション-時の課金で回収し（[ADR-0039](../decisions/0039-jpy-billing-and-free-tier.md)）、NFR-010 は (2)(3) を含めて設計点で $0.11 以下と改めた（[README.md](README.md) の 3 節、[capacity.md](capacity.md) の 8・10 節。PM・Dev の確認待ち）。
- 利用者がインターネットから読むときの外への転送（東京で最初の 10 TB まで $0.114/GB。AWSDataTransfer の Price List API）と、同じリージョンの別のアカウントから公開の IP で読むときのリージョン内の転送（$0.01/GB。NLB の経路に当てはまるかは未検証。E12 の `load-test-ga` の T6 で、Cost and Usage Report の使用量の種類を見て確かめる）は、この表に含めない。読み取りの GB の単価（[ADR-0039](../decisions/0039-jpy-billing-and-free-tier.md)）で利用者に渡す前提で、PM に確かめる。
- 下げる手段は [capacity.md](capacity.md) の 10 節（ブローカーの複製の上限の引き上げ、NLB を通さない経路、パーティションの価格、ローカルの保持の短縮、Savings Plans）。

## 12. 障害と振る舞い

| 事象 | 起きること | 検知 | 対応 |
| --- | --- | --- | --- |
| 1 つの AZ の喪失 | 8.1 節 | 合成監視（AZ ごと）、ISR、NLB の zonal health | [incident-response.md](../runbooks/incident-response.md) の「AZ の喪失」 |
| 1 つの AZ の Envoy の全停止 | その AZ のブローカー宛ての接続が失敗。ブローカーは動いているので、クライアントは再試行を続ける | 合成監視（AZ ごと）、NLB の健全なターゲットの数 | Envoy の復旧。直らなければ、その AZ のブローカーを降格して、リーダーを他の AZ へ移す（読み取りは AZ をまたぐ） |
| sni-router の停止 | 既存の経路は続く。新しい SNI（新しい論理クラスタ、入れ替えたブローカーの Pod）を解決できない | xDS の更新の遅れ | sni-router の復旧。Envoy は最後の設定で動く |
| NLB の不調（AWS 側） | zonal shift で AZ を外す | NLB のメトリクス、合成監視 | AWS へ連絡。1 つの AZ なら 8.1 節と同じ |
| 証明書の期限切れ | 全テナントの接続が失敗 | 30 日前・7 日前のアラート、合成監視の TLS の検証 | 手動の更新（`tls-certificate-renewal.md`、E12） |
| EBS の付け替えの失敗（KMS の拒否） | ブローカーが起動しない | Pod の状態、KMS のエラー | キーのポリシーの確認（`kms-key-access-lost.md`、E8） |
| VPC Lattice・SQS のエンドポイントの不調 | 反映と命令が止まる。データの経路は続く | `observed_generation` の遅れ | [incident-response.md](../runbooks/incident-response.md) |
| 東京のリージョンの喪失 | 8.2 節 | 大阪からの合成監視 | [disaster-recovery.md](../runbooks/disaster-recovery.md) |

## 13. セキュリティ

| 脅威 | 対応 |
| --- | --- |
| 入口の洪水（接続の嵐、TLS の握手） | NLB と Envoy は認証の前の TLS の握手を終端しないので、握手の費用はブローカーに掛かる。Envoy ごとの接続の頻度の上限と、ブローカーのテナントの接続の試みの頻度（P5）で守る。大規模な攻撃は AWS Shield Standard（NLB に既定で付く）に頼る |
| 他のテナントのブローカーへの到達 | SNI と API キーの lc-id の一致（[ADR-0025](../decisions/0025-tenant-namespace-patch.md)）。Envoy は未知の SNI を閉じる |
| 内部のリスナーへの到達 | セキュリティグループで、TENANT 以外のポートを Envoy から届かなくする（2.2 節） |
| 証明書の秘密鍵の漏洩 | 秘密鍵をブローカーの Secret と書き出しの処理の外に出さない。KMS で暗号化した Secret（EKS のエンベロープ暗号化）。198 日以内に入れ替わる |
| 制御面の乗っ取り | データ面へ入る経路を作らない（2.3 節）。sni-router が制御面から受けるのは、論理クラスタ → 物理クラスタの対応だけ |
| 人の誤操作 | 本番は期限つきの権限だけ（3.4 節）。Terraform の apply は CI の役割だけ |
| 大阪の写しの消去（ランサムウェア） | dr-vault の別のアカウント、削除を写さない、東京の役割から書けない・消せない |

## 14. ADR

| ADR | 決定 |
| --- | --- |
| [0043](../decisions/0043-aws-accounts-network-and-eks-layout.md) | データ面は環境ごとのアカウントの 1 つの VPC。EKS は層ごと＋エッジ。ノードグループは物理クラスタ × AZ ID × 役割で、AZ ID で固定する |
| [0044](../decisions/0044-nlb-sni-proxy-and-zonal-hostnames.md) | NLB（cross-zone 無効）＋ Envoy の SNI の振り分け。ブローカーのホスト名に AZ ID を入れ、同じ AZ の経路を保つ。証明書は ACM の書き出せる証明書 |
| [0045](../decisions/0045-osaka-disaster-recovery-scope.md) | 大阪は、制御面をウォームスタンバイ。データ面は書き込みの経路の作り直しと、写しを有効にした履歴の戻しに分ける |

## 15. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E1 | `org-and-accounts` | 1 節のアカウント、OU、SCP |
| E1 | `dataplane-vpc` | 2.1・2.2 節。AZ ID の固定、エンドポイント、DNS Firewall |
| E1 | `eks-and-nodegroups` | 3 節。EKS、ノードグループ、AZ ID のラベル、`broker.rack` の起動の検査 |
| E1 | `edge-poc` | NLB＋Envoy＋sni-router の on-demand CDS の PoC。同じ AZ の経路の確認 |
| E1 | `cp-dp-connectivity` | 2.3 節。VPC Lattice、SQS、AMP のアカウントをまたぐ経路 |
| E9 | `pc-aws-module` | 4 節の Terraform のモジュールと pc-provisioner の雛形 |
| E12 | `edge-production` | 5 節の本番の構成（EIP、zonal shift、アイドルのタイムアウト、Proxy Protocol、RBAC の許可リスト） |
| E12 | `tenant-certificate-rotation` | 5.5 節の書き出し、配布、ロール、期限のアラート |
| E12 | `osaka-standby` | 8.2 節の大阪の骨組み、制御面のウォームスタンバイ、ホスト名の向け直し、コントローラーとエッジの容量の予約、`osaka-capacity-check` |
| E12 | `terraform-guardrails` | 9 節の CI の検査 |
| S2 | `privatelink` | 6 節 |
| S2 | `dataplane-account-split` | 10 節の目安でアカウントを分ける |

## 16. 未解決の問い

### 決定（2026-09-27、既定案）

- **アカウント**：S1 はデータ面を環境ごとに 1 つ。KMS の上限では分けない。
- **AZ**：`apne1-az1`・`az2`・`az4`。大阪は `apne3-az1`・`az2`・`az3`。
- **ホスト名**：ブローカーに AZ ID を入れる（multi-tenancy-and-quotas の 4.4 節を改める）。
- **Envoy の振り分け**：on-demand CDS（PoC でだめなら filter chain）。
- **証明書**：リージョンで 1 枚（ACM の書き出せる証明書、8 つの名前）。
- **大阪**：制御面はウォームスタンバイ、データ面は骨組みだけ。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| `topology.k8s.aws/zone-id` のラベルが EKS のノードに付くか | E1 |
| `sni_cluster` と `tcp_proxy` の on-demand CDS の組み合わせが動くか（それぞれの機能は文書で確かめた。5 節）。クラスタが 1 万になったときの Envoy のメモリー | E1 の `edge-poc` |
| RBAC の許可リストの更新で、Envoy のリスナーが排出されないか | E12 |
| 送信元 IP ごとの接続の頻度の制限（security-and-acls の 3.6 節）を、外部のレート制限のサービスで入れるか | S2。Envoy の組み込みの `local_ratelimit` では送信元ごとに数えられないことは確かめた（5 節）。外部のレート制限のサービスの要否を決める |
| 監査ログの IP を、Envoy のアクセスログとブローカーの接続から作る方式 | E8（security-and-acls の領域と一緒に） |
| NLB を通さない経路（Envoy に EIP を直接付ける）に替えるか | 流量が増えたとき。10 節の目安 |
| 同じリージョンの別のアカウントから公開の IP で NLB につなぐときの転送料金 | AWS に確かめる（E12）。読み取りの単価に効く |
| 大阪で作り直した論理クラスタの履歴のトピックの名前 | E4（tiered-and-object-storage の領域と一緒に） |
| 大阪の EC2 の空きの確保 | コントローラーとエッジの最小は予約する（8.2 節）。ブローカーは四半期の `osaka-capacity-check` と年 1 回の訓練で確かめる（E12 の `osaka-standby`） |

## 17. quality.md・runbooks・data-model への項目

### quality.md

- Envoy の「AZ をまたいで送った接続」の割合（目標 1% 未満）と、同じ AZ の複製から読んだバイトの割合（[replication-and-durability.md](replication-and-durability.md) の 15 節と一緒に）。
- 災害復旧の訓練の結果：制御面の切り替えの時間（目標 1 時間）、書き込みの経路の作り直しの時間（目標 4 時間）、戻した履歴の中身とオフセットの一致。
- 証明書の残りの日数の最小（目標 30 日以上）。
- Terraform の CI の検査の違反の件数（目標 0）。

### runbooks/README.md

- SLO：大阪の骨組みの健全性（大阪の合成監視の成功）を、DR のダッシュボードに入れる。
- アラート → 手順：AZ の喪失 → [incident-response.md](../runbooks/incident-response.md)、リージョンの障害・Global Database の遅れ・CRR の遅れ → [disaster-recovery.md](../runbooks/disaster-recovery.md)、証明書の期限 → `tls-certificate-renewal.md`（E12）、エッジの不調 → [incident-response.md](../runbooks/incident-response.md)。
- 個別の手順の候補：`edge-az-outage.md`（1 つの AZ の Envoy の停止と降格の判断）、`sni-router-down.md`、`tls-certificate-renewal.md`、`osaka-capacity-check.md`（年次の起動の確認）。

### data-model

- `physical_clusters` に `eks_cluster`、`az_ids`、`node_instance_type` を足す提案。
- `edge_routes`（sni-router のローカルの写し。制御面のテーブルではない）：`lc_id` → `pc_id` の対応と取得の時刻。
- `dr_restores`（制御面）：災害復旧・訓練の記録（[data-model.md](data-model.md)）。

---
status: accepted
date: 2026-09-27
---

# ADR-0043: データ面は環境ごとのアカウントの 1 つの VPC に置き、EKS は層ごと、ノードグループは物理クラスタ × AZ ID ごとに固定する

詳細は [infrastructure.md](../architecture/infrastructure.md) の 1〜4 節。

## Context

- データ面は EKS の上の Strimzi で動かす（[ADR-0032](0032-strimzi-for-physical-clusters.md)）。1 つの EKS に物理クラスタを 5 つまで載せる（[control-plane-and-provisioning.md](../architecture/control-plane-and-provisioning.md) の 7.1 節）。
- 複製は AZ ごとに 1 つ、`broker.rack` は AZ ID にする（[ADR-0012](0012-durability-settings-and-elr.md)）。AZ の名前はアカウントごとに物理の AZ への対応が違いうる。2025-11 より前に作ったアカウントでは、古いリージョンで名前と AZ を独立に対応付けている（[AWS Availability Zones](https://docs.aws.amazon.com/global-infrastructure/latest/regions/aws-availability-zones.html)、2026-09-27 に確認）。
- 東京には AZ ID が 4 つある（apne1-az1〜az4）。拡張が難しくなった AZ（constrained）では、新しい資源を作れなくなることがある（同上）。apne1-az3 がそれに当たるという報告がある（[Zenn の解説](https://zenn.dev/ncdc/articles/867f5d20bb61f9)）。AWS の文書はどの AZ が constrained かを書いていない（2026-09-27 に確認）ので、未検証のまま使わない側に倒す。E1 の `dataplane-vpc` で、アカウントの `describe-instance-type-offerings` で確かめる。
- security-and-acls の領域は、KMS の要求の上限（東京で 20,000 回/秒、アカウントとリージョンで共有）を理由に、データ面のアカウントを物理クラスタの群ごとに分けるかを、この領域に任せた。
- 物理クラスタの間で、データの経路（SNI のプロキシからブローカー）を共有したい。1 つの NLB と 1 つの DNS のワイルドカードで全ての論理クラスタを受ける設計が、control-plane-and-provisioning の領域の前提になっている。

## Options

アカウントと VPC：

1. **環境ごとに 1 つのデータ面のアカウントと 1 つの VPC。エッジ（NLB と SNI のプロキシ）と全ての EKS を同じ VPC に置く**
2. 層（Basic・Standard）ごとにアカウントと VPC を分け、エッジから VPC ピアリングでつなぐ
3. 物理クラスタごとにアカウントを分ける

AZ：

- A. **AZ ID で 3 つ（apne1-az1・az2・az4）を固定し、サブネットとノードグループを AZ ID から作る**
- B. AZ の名前（`ap-northeast-1a` など）で指定する

## Decision

1 と A を採用する。

- アカウント：management、security、log-archive、shared、cp-{dev,staging,prod}、dp-{dev,staging,prod}、dp-verify（Jepsen・負荷試験）、probe（外からの合成監視）、dr-vault（大阪の写しの保管）。S2 で dp を物理クラスタの群ごとに分け、Dedicated とコネクター（[ADR-0042](0042-connector-runtime-isolation.md)）のアカウントを足す。
- VPC：dp-prod に 1 つ。サブネットは AZ ごとに public（NLB の EIP、NAT）、edge、nodes、endpoints。S3 はゲートウェイ型、KMS・STS・ECR・SQS・Firehose・CloudWatch Logs・AMP・EKS はインターフェイス型のエンドポイント。
- EKS：層ごとに 1 つ（`dp-standard-1`、`dp-basic-1`）、それとエッジ用に 1 つ（`dp-edge`）。1 つの EKS に物理クラスタは 5 つまで。
- ノードグループ：物理クラスタ × AZ ID × 役割（`brokers`・`controllers`）ごとのマネージドノードグループ。taint でその物理クラスタだけを載せる。Karpenter は使わない。
- rack：Strimzi の `rack.topologyKey` は AZ ID のラベル（`topology.k8s.aws/zone-id`。AWS のクラウドコントローラーマネージャーがノードに付ける。[well_known_labels.go](https://github.com/kubernetes/cloud-provider-aws/blob/master/pkg/providers/v1/well_known_labels.go)、2026-09-27 に確認。実際のノードに付くことは E1 の `eks-and-nodegroups` の起動の検査で確かめる）にする。付かなければ、ノードグループのラベルで AZ ID を付ける。
- 制御面との経路：エージェントから internal-api は VPC Lattice（IAM の認証）、SQS はインターフェイス型のエンドポイント。制御面からデータ面への経路は作らない。
- 2 を選ばない理由：エッジからの経路が VPC をまたぎ、AZ をまたぐピアリングは転送の料金がかかる。S1 の物理クラスタは 10 以下で、KMS の要求は S3 Bucket Keys で小さい（[capacity.md](../architecture/capacity.md) の 6 節）。S2 で分けるときも、エッジから同じ AZ の中だけで届く形を保つ。
- 3 を選ばない理由：S1 ではアカウントの数と IAM の管理が重い。Dedicated（S2）だけを別にする。
- B を選ばない理由：アカウントをまたいで AZ が食い違い、`broker.rack` と大阪の写し・PrivateLink の AZ の対応が崩れる。

## Consequences

- 良くなること：
  - エッジから全ての物理クラスタへ、同じ AZ の中の経路だけで届く。
  - AZ の不変条件（[ADR-0012](0012-durability-settings-and-elr.md)）が、アカウントやリージョンの違いで崩れない。
- 引き受けるコスト：
  - dp-prod のアカウントの上限（EC2 の vCPU、EBS の容量、EIP、NLB）を、S1 の終わりまで見越して引き上げておく。
  - 1 つの VPC の障害（設定の誤り）が全ての物理クラスタに及ぶ。VPC の変更は Terraform の計画を 2 人で確かめる。
  - apne1-az3 を使わないので、東京の 4 つ目の AZ に逃げる選択肢はない。

## Confirmation

- Terraform の検査（CI）：サブネットとノードグループを AZ ID で指定している。AZ の名前の直書きがない。
- 起動の検査：ブローカーの `broker.rack` が `apne1-az1`・`az2`・`az4` のどれかで、ノードの AZ ID と一致する。違えば起動しない。
- 監査：AUD-5（[replication-and-durability.md](../architecture/replication-and-durability.md) の 7.2 節）で、全てのパーティションの複製が 3 つの AZ ID にある。

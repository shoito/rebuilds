---
status: accepted
date: 2026-10-10
---

# ADR-0069: 本番を、全体の面のアカウントと、ポッドの組（10 ポッドまで）ごとのアカウントに分ける。ポッドの組は 1 つの VPC を持ち、ポッドごとにサブネット・セキュリティグループ・NACL を分けてポッドの間を拒む。全体とポッドの組は Transit Gateway で決めた向きだけつなぎ、ポッドのサービスはインターネットへの経路を持たず、提供者・運送会社への送信は Network Firewall の許可の一覧を通す

## Context

- ポッドは完全なセルで、障害の範囲をポッドに閉じる（[ADR-0002](0002-pods-and-shop-placement.md)）。S1 で 6、S2 で 40、S3 で 300 のポッドを見込む。
- VPC をポッドごとに作ると、インターフェースの VPC エンドポイントの時間の課金（エンドポイント × AZ）がポッドの数で掛かり、S3 で大きくなる。1 つの VPC に全ポッドを置くと、ネットワークの誤りの範囲が全ポッドになる。
- アカウントの既定の上限（Aurora のクラスタ、ENI、Fargate の vCPU、VPC origin）は、ポッドの数に応じて当たる。
- 全体の面からポッドへの同期の通信は、`edge-router` の中継（[ADR-0010](0010-shop-routing-hot-set-and-custom-domains.md)）と `shop-mover` の DB への接続（[ADR-0012](0012-shop-mover-logical-decoding-and-cutover.md)）だけ。
- 外への送信は、Webhook（[ADR-0062](0062-webhook-egress-and-payload-custody.md)）の他に、決済の提供者と運送会社の API がある。ストアフロントのレンダラーと Admin API が外へ出られると、SSRF とデータの持ち出しの経路になる（[security.md](../architecture/security.md) の 3.7 節）。
- CloudFront の VPC origin は AWS RAM で他のアカウントへ共有できる（[cross-account VPC origins](https://aws.amazon.com/blogs/networking-and-content-delivery/introducing-cross-account-support-for-amazon-cloudfront-virtual-private-cloud-vpc-origins)、2026-10-10 に確認）。

## Options

1. **ポッドの組のアカウントと VPC、ポッドごとのサブネットと NACL、Transit Gateway、Network Firewall の許可の一覧**
2. ポッドごとのアカウントと VPC
3. 1 つのアカウントと VPC に全ポッド

## Decision

1 を採用する。詳細は [infrastructure.md](../architecture/infrastructure.md) の 1・2 節。

- アカウント：management、security、log-archive、shared（ECR、Route 53、Transit Gateway）、edge（CloudFront、WAF、KeyValueStore）、observability、canary、prod-global、prod-pods-NN（10 ポッドまで）、staging、dev。SCP で東京・大阪の外を禁止する。
- ポッドの組の VPC（`/16`）に、ポッドごとの `/22` のサブネットを `lb`・`app`・`data` × 3 AZ。ポッドの間を NACL で拒み、例外は中継の窓の `app` → 他のポッドの `lb` の 443 だけ。VPC エンドポイントは組で共有する。
- Transit Gateway の経路は、`edge-router` → ポッドの `lb`、`shop-mover` → ポッドの `data`、ポッドの `app` → 他の組のポッドの `lb`（中継）だけ。
- ポッドの `lb` の内部の ALB を VPC origin にし、RAM で edge のアカウントに共有する。
- 外への送信：`checkout` と `workers` だけが、組の Network Firewall（SNI の名前の許可の一覧）→ NAT を通る。`storefront-renderer`・`storefront-api`・`admin-api`・`function-runner` は出口を持たない。Webhook と画像の URL の取り込みは全体の面の egress、IdP のメタデータは全体の面の Network Firewall。

### 他の案を選ばなかった理由

- **2（ポッドごと）**：S3 で 300 アカウントと 300 VPC。エンドポイントの費用と、アカウントの作成・運用の手間がポッドの数で増える。
- **3（1 つ）**：誤ったセキュリティグループ・経路の 1 つが全ポッドに及ぶ。アカウントの上限に早く当たる。

## Consequences

- 良くなること：
  - ネットワークの誤りの範囲が 10 ポッドに閉じ、ポッドの間は NACL でも拒まれる。
  - 外への送信の経路が部品ごとに決まり、SSRF の面が小さい。
- 引き受けるコスト：
  - Transit Gateway と Network Firewall の時間と転送の課金（**未検証**）。
  - 組をまたぐ移し替えでは、Transit Gateway を通る中継と DB の接続になる。
  - VPC origin・アカウントの上限の引き上げを、組を足すたびに申請する。

## Confirmation

- IaC の検査（OPA・Checkov）：[infrastructure.md](../architecture/infrastructure.md) の 6 節の拒否の一覧。
- 結合テスト（staging）：ポッドの `app` から他のポッドの `data` へ届かない。`storefront-renderer` のタスクからインターネットへ届かない。許可の一覧の外の名前へ `checkout` から届かない。

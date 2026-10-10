---
status: accepted
date: 2026-10-10
---

# ADR-0064: アカウントは他の題材の形に、大阪の自己監視 `selfmon` と、隔離のファイルの `media-quarantine` を足す。メディアの面のサブネットは外への経路を持たない。CloudFront は VOD・ライブ・画面と API のディストリビューションに分けて上限をそれぞれ申請し、オリジンは VPC オリジンの NLB にして `apne1-az3` を使わない

## Context

- CloudFront の既定の上限は、ディストリビューションごとに転送 150 Gbps・要求 25 万件/秒で、引き上げを申請できる（[CloudFront Quotas](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html)、2026-10-10 に確認）。
- S1 の配信のピークは 0.3 Tbps、20 万人の LL-HLS の配信は 120 万件/秒・0.6 Tbps（[live-streaming.md](../architecture/live-streaming.md) の 6.5 節）。どちらも既定を超え、性質（大きなセグメントと小さな保留の要求）が違う。
- CloudFront の VPC オリジンは ALB・NLB・EC2 を私的なサブネットのまま使えるが、TLS のリスナーの NLB は使えず、東京では `apne1-az3` に対応しない（[Restrict access with VPC origins](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-vpc-origins.html)、2026-10-10 に確認）。
- 既知の違法なメディアに一致したファイルは、本番の運用者から遠ざけて保全する（[upload-and-ingest.md](../architecture/upload-and-ingest.md) の 5.3 節）。
- 自己監視は本番に依存しない別のアカウントに置く（[runbooks/](../runbooks/README.md) の 5 節）。東京のリージョンの障害でも動く必要がある。

## Options

ディストリビューション：

1. **VOD、ライブ、画面と API を分け、上限を別々に申請する**
2. 1 つのディストリビューションにすべてを載せ、上限を大きく申請する

オリジン：

- a. **VPC オリジンの NLB（TCP）を私的なサブネットに置く**
- b. 公開の NLB に CloudFront の管理するプレフィックスの一覧で絞る

## Decision

1 と a を採用する。詳細は [infrastructure.md](../architecture/infrastructure.md) の 2・3 節。

- アカウント：management、security、log-archive、shared、edge、`selfmon`（大阪）、`media-quarantine`、dev、staging、prod。SCP で東京・大阪以外を禁じ、`orig/` のライフサイクルの規則の変更とバージョニングの停止を break-glass 以外に禁じる。
- サブネット：public（取り込みとチャットの NLB、NAT）、origin（VPC オリジンの NLB、`origin-cache`、`live-origin`、`manifest-service`）、control（ALB、管理の面）、media（外への経路なし）、egress（事業者への呼び出しだけ、許可リスト）、isolated（DB）。AZ は `apne1-az1`・`az2`・`az4`。
- ディストリビューション：`vod`（`<brand>video.<domain>`）、`live`（`live.<brand>video.<domain>`）、`app`（画面、再生の API、出来事の受け口）。パスの形は変えず、再生の API がホストを分けて返す。
- 申請：`vod` は 0.6 Tbps・50 万件/秒（E5 の前）、`live` は 1.2 Tbps・250 万件/秒（E12 の前）。足りなければ `live` をさらに分け、大きな配信を通常のモードへ切り替える手順を持つ。使用の割合が 60% でチケット、80% で呼び出し。
- チャットとライブの取り込みとアップロードの本体は CloudFront を通さない。

### 他の案を選ばなかった理由

- **2（1 つ）**：大きなライブの要求の急増が VOD の上限を食い、VOD の再生が絞られうる。キャッシュの振る舞いの数（75）も 1 つに集まる。
- **b（公開の NLB）**：オリジンを公開のアドレスに置くことになり、CloudFront の他の利用者のディストリビューションからも届きうる。VPC オリジンのセキュリティグループで自分のディストリビューションだけに絞れる。

## Consequences

- 良くなること：
  - VOD とライブの上限を独立に管理でき、片方の急増がもう片方を絞らない。
  - オリジンが公開のアドレスを持たない。
  - 自己監視が東京の障害の間も動く。
- 引き受けるコスト：
  - 申請と承認の管理（`cdn_quota_log`）。承認の量と時間は**未検証**。
  - `origin-cache` で TLS を終える（NLB の TLS のリスナーが使えないため）。
  - `apne1-az3` の在庫を使えない。

## Confirmation

- Terraform の plan の検査：`apne1-az3` のサブネットがない、private のサブネットに NAT・IGW がない、NLB のクロスゾーンが無効。
- `cdn-cost-poc` と `live-distribution-quota` で、申請の結果と、使用の割合の警報を確かめる。

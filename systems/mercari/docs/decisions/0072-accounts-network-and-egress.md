---
status: accepted
date: 2026-10-10
---

# ADR-0072: 本番の作業負荷は 1 つの本番のアカウントの 1 つの VPC（3 AZ）に置き、サブネットを `lb`・`app`・`ml`・`data`・`egress` に分ける。データレイクと学習は別の `data` のアカウントに置く。外への送信は送るサービスだけに許し、Network Firewall の宛先の名前の許可の一覧と AZ ごとの固定の IP の NAT を通す。`ml-inference` は Aurora・金庫・外への経路を持たない

## Context

- 本システムは、決済の提供者・提携銀行・運送会社・eKYC・SMS・APNs・FCM に送る。銀行と運送会社は、送り元の IP の登録や閉じた網を求めることがある（相手ごとの能力は**未検証**）。
- 住所は `shipping` だけが復号して運送会社へ渡す（[ADR-0006](0006-shipping-orchestration-via-carriers.md)）。他のサービスが外へ送れると、侵害のときの持ち出しの経路になる。
- 分類器の推論は Python の別のサービスで、汎用の部品（PyTorch など）と事前学習のモデルを読む（[ADR-0001](0001-platform-and-stack.md)）。依存の面が広い部品を、お金と住所の DB から離したい。
- 学習のデータは仮名にしたデータレイクだけで作る（[ADR-0009](0009-trust-and-safety-pipeline-boundary.md)、[ADR-0071](0071-data-classes-and-lifecycle.md)）。
- Shopify の題材はポッドの組ごとにアカウントを分けた（[Shopify の ADR-0069](../../../shopify/docs/decisions/0069-accounts-network-and-pod-groups.md)）。この題材はテナントのセルを持たない（[ADR-0007](0007-single-tenant-and-party-visibility.md)）。

## Options

アカウント：

1. **本番の作業負荷は 1 つのアカウント。データレイクと学習は別のアカウント**
2. ドメインごと（取引、お金、検索、ML）にアカウントを分ける
3. 本番と学習を同じアカウントに置く

外への送信：

- a. **送るサービスだけに経路を許し、Network Firewall の名前の許可の一覧と固定の IP の NAT を通す**
- b. 全サービスが NAT で外へ出られる
- c. 外への送信を 1 つの代理のサービスに集める

## Decision

1 と a を採用する。詳細は [infrastructure.md](../architecture/infrastructure.md) の 1・2・5 節。

- アカウント：management、security、log-archive、shared、edge、observability、canary、data、prod、staging、dev。
- prod の VPC：`/16`、3 AZ、サブネット `lb`・`app`・`ml`・`data`・`egress`。VPC エンドポイント（S3、SQS、SNS、KMS、STS、ECR、Logs、AppConfig、Secrets Manager、SES）。
- 外への送信：`payments`（提供者）、`payouts`（銀行）、`shipping`（運送会社）、`identity`（eKYC、SMS）、`notifier-send`（APNs、FCM）だけが `egress` への経路を持つ。Network Firewall で SNI の名前の許可の一覧を当て、AZ ごとの固定の IP の NAT で出る。銀行が閉じた網を求めたら shared の Site-to-Site VPN。東京と大阪の両方の固定の IP を相手に登録する。
- Webhook：`hooks.<brand>.<domain>` の別の配信、WAF（本文 256 KB、公開されていれば送り元の IP）、`hooks` の ALB。
- `ml-inference`：`ml` のサブネット。入るのは `trust-safety`・`listings`・`search-api` から。出るのは OpenSearch（読み）、Valkey（`price_stats:*` の書きだけ）、S3（写真とモデルの読み）。Aurora、金庫の KMS の鍵、外への経路を持たない。モデルは data のアカウントで学習し、署名して prod の `ml-models` に入れる。
- plan のポリシー検査で、この形を外れる変更を拒む。

### 他の案を選ばなかった理由

- **2（ドメインごとのアカウント）**：購入（core）と台帳（ledger）の間の outbox と照合が、アカウントをまたぐ経路になる。S1 の規模に対して運用が重い。
- **3（学習を同じアカウント）**：学習の道具（ノートブック、分析の人の権限）が本番の DB に近づく。
- **b（全サービスが外へ）**：侵害された 1 つのサービスから、住所や台帳のデータを外へ送れる。
- **c（1 つの代理）**：mTLS のクライアントの証明書と、提供者ごとの冪等と再試行を代理が持つことになり、代理が全外部の連携の障害点になる。

## Consequences

- 良くなること：
  - 外へ送れるサービスが 5 つに絞られ、持ち出しの経路の検査が簡単になる。
  - 依存の多い Python の推論が、お金と住所の DB から離れる。
- 引き受けるコスト：
  - Network Firewall と NAT の料金（**未検証**）。
  - 外の宛先を足すたびに、許可の一覧の変更（IaC）が要る。

## Confirmation

- plan のポリシー検査：`egress` への経路のあるセキュリティグループの一覧、`ml` から Aurora への経路がないこと。
- 結合の試験（staging）：送らないサービスから外への接続が失敗する。
- E18 の外部のペンテストで、SSRF と外への送信の経路を確かめる。

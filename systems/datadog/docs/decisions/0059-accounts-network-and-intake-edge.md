---
status: accepted
date: 2026-10-09
---

# ADR-0059: アカウントは他の題材の形に自己監視の `selfmon` とエージェントの配布の `release` を足す。取り込みは CloudFront を通さず、AZ をまたがない NLB（TLS のリスナー）からゲートウェイへ送る。データの面のサブネットはインターネットへの経路を持たず、外への送信は egress の `notifier` だけ。S2 からは `intake-router` がキーからセルを引く

## Context

- 管理の面は他の題材の基盤（Fargate、Aurora、CloudFront＋WAF）を引き継ぐ（[ADR-0001](0001-platform-and-stack.md)）。
- 取り込みは S1 で、メトリクスのピーク 1,000 万点/秒、ログのピーク 1.5 GB/秒、スパン 200 万/秒（[architecture/README.md](../architecture/README.md) の 2 節）。送り手はエージェントと OTLP（gRPC を含む）。
- 本システムの監視を本システムに頼らない（[runbooks/](../runbooks/README.md) の 5 節）。自己監視は別のアカウントに置き、本番に依存させない。
- エージェントのパッケージと更新は署名して配る（利用者のホストで動く）。
- AZ をまたぐ転送は 0.01 USD/GB を両側で課金する（AWS Price List API の `AWSDataTransfer`、ap-northeast-1、2026-10-09 に取得）。取り込みの量では無視できない。
- データの面が外へ出る必要はない。外への送信（通知）は利用者の決める宛先を含み、SSRF の守りを 1 か所にしたい（[ADR-0058](0058-untrusted-senders-egress-and-operator-access.md)）。
- S2 でセルが増えると、1 つの取り込みのホスト名から、組織のセルへ振り分ける必要がある（[ADR-0003](0003-tenancy-cells-and-isolation.md)）。

## Options

取り込みの入口：

1. **NLB（TLS のリスナー、クロスゾーンを切る）→ ゲートウェイ**
2. CloudFront＋WAF → ALB → ゲートウェイ
3. Global Accelerator → NLB

S2 の振り分け：

- a. **`intake-router` がキー → 組織 → セルを引いて送り、応答でセルのホスト名を教える**
- b. 組織ごとの取り込みのホスト名（`<org>.intake...`）を配る
- c. 全セルのゲートウェイが受け、違うセルなら転送する

## Decision

1 と a を採用する。

- アカウント：management、security、log-archive、shared、edge、release、selfmon、dev、staging、prod。selfmon は本番と別の DNS のゾーン・秘密の置き場・break-glass の利用者を持つ。
- サブネット：public（NLB・ALB・NAT）、intake（ゲートウェイ）、data（データの面。外への経路なし。S3 のゲートウェイのエンドポイントと必要なインターフェースのエンドポイントだけ）、control（管理の面。IdP の許可リストだけ）、egress（`notifier`。専用の NAT）、isolated（MSK、Aurora、Valkey）。セルごとに VPC を分け、セルの間は PrivateLink だけ。
- 取り込み：`intake`・`otlp` は NLB の TLS のリスナーで終端し、ゲートウェイまで TLS を張り直す。クロスゾーンの負荷分散を切り、DNS で AZ ごとのアドレスを返す。入口の守りはゲートウェイの上限と割り当てと Shield Standard。画面と API は CloudFront＋WAF＋ALB。
- S2：`intake-router`（Rust、Fargate、状態なし）がキーのハッシュ → `tenant_cells` を引き、セルの内部の NLB へ送る。応答の `<Brand>-Intake-Cell` で、エージェントはセルのホスト名へ直接送るようになる。移し替えでは古いセルが 421 を返し、エージェントは router に戻る。

### 他の案を選ばなかった理由

- **2（CloudFront＋WAF）**：要求とバイトの料金、WAF の検査の料金が取り込みの量に比例して大きい。gRPC の扱いも加わる。送り手の多くは日本にいて、エッジの利得が小さい。
- **3（Global Accelerator）**：送り手が日本に集まり、利得が小さい。転送の料金が足される。
- **b（組織ごとのホスト名）**：利用者のエージェントの設定を、移し替えのたびに変えさせることになる。
- **c（転送）**：S2 で 4〜8 セルなら、取り込みの大半（(n−1)/n）がセルを 2 回通り、転送の費用と遅れが増える。

## Consequences

- 良くなること：
  - 取り込みの入口の費用が小さく、AZ をまたぐ転送を避けられる。
  - 外への経路が 1 つで、データの面から外へ出られない。
  - 自己監視が本番の障害に巻き込まれない。
- 引き受けるコスト：
  - 取り込みの入口に WAF がない。ボットや乱用は、キーと割り当てとゲートウェイの上限で守る。
  - クロスゾーンを切るので、AZ ごとの送り手の偏りがそのまま NLB の後ろの偏りになる。ゲートウェイを AZ ごとに広げる。
  - S2 で `intake-router` とエージェントのセルの記憶の仕組みが要る。

## Confirmation

- Terraform の plan の方針の検査：data・isolated・intake の経路表に NAT・IGW がない。`notifier` の他に出口がない。NLB のクロスゾーンが切れている。
- E1 の `edge-and-intake-endpoints`：NLB の TLS のリスナーで gRPC（HTTP/2）が通ることを確かめる（**未検証**）。
- S2 の前：`intake-router` の試験で、移し替えの 421 から 60 秒以内にエージェントが新しいセルへ送る。

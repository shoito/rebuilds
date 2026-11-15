---
status: proposed
date: 2026-11-15
---

# ADR-0071: アカウントを用途と鍵の境界で分け、外への経路を 3 つに分ける

## Context

この題材の AWS の構成は、他の題材と同じ業務の部品に加えて、次の 3 つを持つ。

- **署名の境界**：鍵の材料と、方針・承認の確かめ直しを、本体と別の AWS アカウント（`custody`）に置くことは決めた（[ADR-0007](0007-signing-service-and-key-custody.md)）。本体のアカウントが破られても、境界の中に届かない形が要る。
- **ブロックチェーンのノード**：P2P の相手は世界の任意の IP で、宛先の許可の一覧で絞れない。ノードの RPC は本体の部品だけに開く（[ADR-0009](0009-deposits-confirmations-and-own-nodes.md)）。
- **銀行と提供者**：提携銀行・信託銀行、eKYC、チェーン分析、トラベルルール、参照の価格（[ADR-0011](0011-external-providers-boundary.md)）。銀行は送信元の IP の許可の一覧を求めることが多い。

さらに、正しさの見張りを別のアカウントに置くことを決めた（[ADR-0068](0068-correctness-monitors-and-independent-watch.md)）。外への経路を 1 つにまとめると、ノードの P2P（任意の宛先）と、銀行への経路（許可の一覧の IP）が同じ出口を共有し、ノードの部品が破られたときに銀行への経路が踏み台になる。

Stripe の題材は、CDE を別のアカウントに置き、本体との経路を PrivateLink の決めた API に限る形を決めている（[Stripe の ADR-0029](../../../stripe/docs/decisions/0029-multi-account-and-cde-layout.md)）。

## Options

1. 本番を 1 つのアカウントにし、`custody` だけを分ける。外への経路は NAT と Network Firewall を 1 組
2. **用途と鍵の境界でアカウントを分ける（`prod`、`custody-prod`、`custody-nonprod`、`watch` ほか）。外への経路を、ノードの P2P・銀行・提供者の 3 つに分け、出口の IP も分ける**
3. 2 に加えて、ノードを別のアカウント（`chain`）に置く

## Decision

2 を採用する。

### アカウント

| アカウント | OU | 中身 |
| --- | --- | --- |
| management | Root | Organizations、SCP、IAM Identity Center、請求 |
| security | Security | GuardDuty・Security Hub・Inspector の委任管理者、調べのロール |
| log-archive | Security | 組織の CloudTrail、Config、VPC フローログ、ログの保管（Object Lock） |
| shared | Infrastructure | ECR、Route 53、Managed Grafana、CI の起点、Terraform の状態 |
| dev、staging | Workloads/NonProd | 開発・検証。regtest・testnet・開発用のチェーンだけ |
| prod | Workloads/Prod | 本体の本番（東京と大阪）。サービス、マッチングの EC2、MSK、3 つの Aurora、Valkey、ノード |
| custody-nonprod | Custody | 試験の署名の境界（ソフトウェアの鍵、試験だけ） |
| custody-prod | Custody | 本番の署名の境界（`policy-verifier`、`approval-verifier`、`nonce-and-utxo-guard`、`signer`）。東京と大阪 |
| watch | Watch | 正しさの心拍の受け手、`canary`、ウォレットの残高の独立の見張り。主は大阪 |

- **`custody` の OU の SCP**：東京・大阪以外のリージョンを拒む。CloudTrail・Config・GuardDuty の停止、KMS の鍵の削除の予約、VPC フローログの削除を、break-glass のロール以外で拒む。`prod`・`shared` のロールからの `sts:AssumeRole` を拒む。
- **`custody` への経路は 1 本**：`prod` の VPC エンドポイントから、`custody-prod` の NLB のエンドポイントサービス（PrivateLink、相互 TLS）で、署名の依頼の API だけを呼ぶ。許可するプリンシパルは `prod` の `wallet-orchestrator` のロールだけ。`custody` から `prod` への HTTP の呼び出しは作らない。結果は同じ呼び出しの応答で返す。
- **`watch` は本体と鍵の境界のどちらからも変えられない**：`prod`・`custody` のロールからの変更を SCP で拒み、取り込みの口（SQS）のリソースポリシーで送り手のロールだけを許す。`watch` の主を大阪に置き、東京のリージョンの障害の間も見張る。
- 人の権限は IAM Identity Center の期限つきの割り当てだけで、常設の権限を置かない（[Auth0 の ADR-0056](../../../auth0/docs/decisions/0056-operator-access.md)）。`custody-prod` の割り当ては、セキュリティの 2 人の承認で、最長 4 時間。**AI エージェントには、`prod`・`custody-*`・`watch` の経路を与えない。**

### ネットワーク（prod）

| サブネット | 置くもの | 外への経路 |
| --- | --- | --- |
| public | NLB、ALB、NAT（用途ごと） | Internet Gateway |
| app | Fargate のサービスと Worker | 提供者の出口（下） |
| match | マッチングの EC2 | なし（MSK・Aurora・S3 のエンドポイントだけ） |
| data | Aurora、MSK、Valkey | なし |
| chain | ノード（BTC、ETH の実行と合意） | P2P の出口（下） |
| bank | 銀行のアダプターの出口のタスク | 銀行の出口（下） |
| endpoint | VPC エンドポイント（S3、ECR、SQS、SNS、KMS、Secrets Manager、AppConfig、Logs、STS）、`custody` への PrivateLink | なし |

### 外への経路

| 経路 | 宛先 | 絞り方 | 出口の IP |
| --- | --- | --- | --- |
| ノードの P2P | 任意（P2P の相手） | Network Firewall で、`chain` のサブネットから、クライアントの P2P の口（TCP・UDP の番号は `node-ops-poc` で決める）だけを許す。他の口と、`chain` から他のサブネットへの通信を拒む。既定は外向きだけで、受け付けの P2P を開けるかは `node-ops-poc` で決める | P2P の NAT（銀行に登録しない） |
| 銀行 | 提携銀行・信託銀行 | 専用線（AWS Direct Connect）か、インターネットと相互 TLS。接続先の条件で選ぶ（Stripe の [infrastructure.md](../../../stripe/docs/architecture/infrastructure.md) の 2.4 節の形） | 銀行の NAT。東京と大阪の固定の IP を、最初から銀行に登録する |
| 提供者 | eKYC、チェーン分析、トラベルルール、参照の価格、外部のノードの見張り、メール・プッシュ | Network Firewall の FQDN の許可の一覧（TLS の SNI） | 提供者の NAT |

- ノードの RPC は、`app` のサブネットの `deposit-watcher`・`wallet-orchestrator` のセキュリティグループからだけ受ける。`custody` はノードに経路を持たない（放送は `wallet-orchestrator` が行う）。
- `custody-prod` の外への経路は、MPC の提供者を選んだときのその提供者の FQDN だけ。CloudHSM を選んだときは外への経路を持たない（方式は `custody-signing-poc`）。

### 他の案を選ばなかった理由

- **1**：外への出口を 1 つにすると、P2P の任意の宛先と銀行の許可の一覧の IP が同じになり、銀行の経路への踏み台を作る。`watch` も本体と同じアカウントになり、侵害の時に一緒に破られる。
- **3**：ノードを別のアカウントにすると、RPC を PrivateLink で通す部品と運用が増える。ノードは鍵を持たない（`deposit-watcher` も xpub だけ。ADR-0009）ので、サブネットと出口を分ければ足りる。S2 で銘柄が増え、ノードの種類と台数が増えたら見直す。

## Consequences

- 良くなること：
  - 本体のアカウントが破られても、`custody` には署名の依頼の 1 つの API でしか届かず、方針と承認の確かめ直しを越えられない。
  - ノードの部品が破られても、銀行の経路と出口の IP を使えない。
  - 正しさの見張りが、本体と鍵の境界の侵害と東京の障害から独立する。
- 引き受けるコスト：
  - NAT と Network Firewall を 3 組（東京と大阪で 6 組）持つ。
  - アカウントの数が増え、Terraform のルートモジュールと CI のロールが増える（delivery の領域）。

## Confirmation

- AWS Config のルール：`chain` のサブネットの経路表が P2P の NAT だけを向く。`match`・`data` のサブネットに Internet Gateway・NAT への経路がない。
- 外部のペンテスト（E16 の `external-pentest`）：`prod` のロールから `custody-prod` の鍵の材料と方針の設定に届く経路がない。`chain` から銀行の宛先に届かない。
- IAM Access Analyzer：`custody-prod` と `watch` の資源を、決めたプリンシパルの外から使えない。
- DR の訓練の項目に、大阪の銀行の出口の IP の登録を確かめることを入れる。

---
status: accepted
date: 2026-09-27
---

# ADR-0049: AWS のアカウントは制御プレーン、リージョンごとのエッジとストレージ、検証のフリート、security-lab、quarantine に分け、リージョンの間は Transit Gateway でつなぐ。ノードの外への通信は NAT ゲートウェイを通さない

詳細は [infrastructure.md](../architecture/infrastructure.md) の 1〜3 節。

## Context

先に決めたこと：

- エッジのフリートは、制御プレーン・ストレージの中央と別のアカウントに置く。検証のフリートと security-lab はさらに別のアカウントで、外への網を持たない（[ADR-0002](0002-isolation-model.md)、[ADR-0010](0010-process-sandbox-and-egress-invariants.md)）。
- 配信の元・中継・ノードの間、ノードの間の転送、リージョンの間の DO のルーターは mTLS（[ADR-0019](0019-route-matching-and-home-node-forwarding.md)、[ADR-0022](0022-sequenced-change-log-relays-and-lmdb.md)、[ADR-0029](0029-do-placement-and-directory.md)）。
- 外への送信元の IP は一覧を公開しないが、不正な利用の通報で送信元を特定できるよう記録する（[edge-network-and-routing.md](../architecture/edge-network-and-routing.md) の 10.3 節）。

AWS の事実（東京、AWS の価格表の API、2026-09-27 に確認）：

- NAT ゲートウェイは 1 時間 0.062 ドルと、処理した量 1GB あたり 0.062 ドル。処理の量は両方向で数える。
- 公開の IPv4 は 1 つ 1 時間 0.005 ドル。
- Transit Gateway は接続 1 時間 0.07 ドルと 1GB あたり 0.02 ドル。リージョンの間の転送は東京から 0.09 ドル/GB。
- サブリクエストの応答（外から入る量）も NAT の処理の料金の対象になる。S1 の平均で、関数の応答と同じ程度のサブリクエストの量があるとすると、月に数百 TB を NAT が処理し、処理の料金だけで数万ドルになる（[capacity.md](../architecture/capacity.md) の 8 節）。

## Options

アカウント：

1. **用途 × リージョンで分ける**（制御プレーン、リージョンごとのエッジ、リージョンごとのストレージ、検証、security-lab、quarantine、probe、共通）
2. 本番を 1 つのアカウントにまとめ、VPC で分ける

外への通信：

- a. **エッジのノードに公開の IPv4 を 1 つずつ付け、外向きのプロキシだけがそれで外へ出る。受信はセキュリティグループで NLB と内部からに限る**
- b. リージョンごとの NAT ゲートウェイ（固定の IP）を通す

## Decision

1 と a を採用する。

| アカウント | 中身 |
| --- | --- |
| `management`・`security`・`log-archive`・`shared` | 組織、SCP、GuardDuty など、監査の保管庫（[ADR-0048](0048-audit-log-integrity-and-data-lifecycle.md)）、ECR・Route 53・Terraform の状態・CI の起点 |
| `build-release` | Bazel のビルド、成果物の署名（[ADR-0046](0046-control-plane-privilege-separation-and-operator-access.md)） |
| `cp-prod`（東京・大阪） | 制御プレーン（ECS、Aurora、採番器、配信の元、cert-manager、tail ハブ、ClickHouse、使用量の集計） |
| `edge-<r>`（5 リージョン） | テナントのコードを動かすもの：エッジのノード、Durable Objects のホスト。中継、専用のリゾルバー、NLB |
| `storage-<r>`（5 リージョン） | テナントのコードを動かさないストレージの部品：KV のゲートウェイ、Valkey、DO のルーター・配置のサービス・ログのノード、DynamoDB、S3。東京は KV の正本、オブジェクトの共有のバケット、DO の名前の台帳、SQS、ディスパッチャー、cron のスケジューラーも持つ |
| `verify-prod` | アップロードの検証のフリート。外への網なし |
| `security-lab` | V8 の再現コード、ファズ。外への網なし |
| `quarantine` | 侵害の疑いのノードの EBS のスナップショットとメモリの写しの保管と解析。網なし。セキュリティの担当だけ |
| `probe` | 外からの合成監視 |
| `*-staging`・`*-dev` | 東京・大阪の 2 リージョンの縮小の構成 |

- `edge-<r>` と `storage-<r>` の間は、同じリージョンの PrivateLink（ストレージの側の NLB のエンドポイントサービス）。リージョンの間（配信、KV の書き込み、DO のルーター、使用量・ログの流れ）は、`shared` が RAM で分ける Transit Gateway と、リージョンの間の TGW のピアリング。
- エッジのノードは公開のサブネットに置き、公開の IPv4 を 1 つ持つ。外向きのプロキシのプロセスだけが、その IP を送信元に使う（ポリシーのルーティングと、専用の Linux の利用者で縛る）。入口の 80・443 は NLB のセキュリティグループからだけ受ける。ノードの IP と時刻とノードの ID を `node_public_ips` に記録し、通報の調べに使う。
- NAT ゲートウェイは、`storage-<r>` と `cp-prod` の外への少量の通信（ACME、OS の更新の取得）にだけ置く。
- SCP：5 つのリージョンと、グローバルなサービス（Global Accelerator、Route 53、IAM、CloudFront）以外を禁じる。
- 2 を採らない理由：テナントのコードの侵害が、1 つのアカウントの中の IAM の誤りでストレージの中央と制御プレーンに届く。ADR-0010 の約束に反する。
- b を採らない理由：処理の料金が、関数の外への通信の量に比例して大きい。送信元の IP の固定は、一覧を公開しない S1 では要らない。

## Consequences

- 良くなること：
  - テナントのコードを動かすアカウントと、テナントのデータを持つアカウントが分かれる。
  - 外への通信の原価から NAT の処理の料金が消える。
- 引き受けるコスト：
  - 送信元の IP がノードの入れ替えで変わる。利用者のオリジンが送信元の IP で許可の一覧を作れない（S1 は一覧を公開しない方針のまま）。
  - エッジのノードが公開の IP を持つので、セキュリティグループの誤りがそのまま露出になる。CI とアカウントの Config の規則で検査する。
  - アカウントの数（本番で 20 前後）の Terraform とアクセスの管理。
  - edge-network-and-routing の 10.3 節の「NAT ゲートウェイの固定の IP」と、[ADR-0044](0044-egress-abuse-controls.md) の送信元の記録の NAT の IP を、この ADR でノードの公開の IPv4 に改める。

## Confirmation

- CI の検査：エッジのノードのセキュリティグループが、80・443 を NLB 以外から受けない。8081・8443 は同じ VPC のノードからだけ。
- 本番の探り：外向きのプロキシ以外のプロセスから外へ出られないこと（ノードの自己検査）。
- 月次：NAT の処理の量が、ストレージと制御プレーンの見込みの範囲にある。

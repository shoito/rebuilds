# Infrastructure: Zoom

AWS の上の構成。アカウントとネットワーク、メディアのリージョンと Edge、Media Node の群れ（インスタンス、AZ への配置、BYOIP、増減と drain）、TURN、制御の側（Fargate、Valkey、Aurora）、災害復旧、Terraform の配置、段階を上げる基準、費用の概算。費用の大半を占めるインターネットへの転送を、コロケーション・ベアメタルと比べる。

前提となる決定は、制御の側は他の題材の基盤を引き継ぎ、Media Node は EC2 で動かすこと（[ADR-0001](../decisions/0001-platform-and-stack.md)）、Media Node と TURN の公開の IP とセキュリティグループ（[ADR-0016](../decisions/0016-media-edge-addressing-and-security-groups.md)）、TURN の構成（[ADR-0015](../decisions/0015-turn-coturn-and-ephemeral-credentials.md)）、Media Node の中の配置（[ADR-0010](../decisions/0010-media-node-process-layout.md)）。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0048](../decisions/0048-accounts-network-and-media-regions.md) | メディアに触れる部品を `media-prod` のアカウントに置き、制御の側（`prod`）とは VPC のピアリングで必要な 3 つの通信だけをつなぐ。S1 のメディアは東京の 3 AZ。大阪は災害の備え。S2 で大阪も会議を受け、S3 で海外のリージョンか国内の Edge を足す |
| [0049](../decisions/0049-media-node-fleet.md) | Media Node は c8gn.16xlarge（予備に c7gn.16xlarge、大阪は c6gn.16xlarge）を AZ ごとの Auto Scaling グループで動かす。IPv4 は BYOIP の /24 をリージョンごとに持ち、ライフサイクルフックで EIP を付ける。縮めるのは drain の終わった台だけ |
| [0050](../decisions/0050-disaster-recovery-and-edge-migration.md) | リージョンの障害では進行中の会議を守らず、大阪で新しい会議を受ける（RTO 1 時間、RPO 1 分）。Media Node をコロケーションへ移す判断は、ピークの送出が 4 週続けて 10 Gbps を超えたら始める |
| [0045](../decisions/0045-ddos-defense-for-media-edge.md)（security） | Shield Advanced の保護の範囲 |
| [0055](../decisions/0055-media-node-rolling-replacement.md)（delivery） | Media Node の入れ替え |

負荷と台数の根拠は [capacity.md](capacity.md)、監視は [observability.md](observability.md)、CI とリリースは [delivery.md](delivery.md)、統制と鍵は [security.md](security.md) にある。

数値のうち「初期見積もり」と書いたものは、E7・E12 の負荷試験の前の仮の値である。AWS の仕様で確かめていないものは「未検証」と書き、確かめる Story を添える。

## 1. AWS アカウントの構成

[ADR-0048](../decisions/0048-accounts-network-and-media-regions.md) のとおり。

| アカウント | OU | 中身 |
| --- | --- | --- |
| management | Root | Organizations、SCP、IAM Identity Center、請求 |
| security | Security | GuardDuty・Security Hub・Inspector の委任管理者、調査用のロール |
| log-archive | Security | 組織の CloudTrail、Config、VPC フローログ、監査ログ（[ADR-0046](../decisions/0046-audit-logs-and-data-lifecycle.md)）。Object Lock。東京 → 大阪へ複製 |
| shared | Infrastructure | ECR（東京・大阪に複製）、AMI の配布（EC2 Image Builder）、Route 53（`<brand>.<domain>`）、Managed Grafana、CI の起点、Terraform の状態のバケット |
| edge | Infrastructure | CloudFront、WAF、ACM（us-east-1）、Shield Advanced の保護（[ADR-0045](../decisions/0045-ddos-defense-for-media-edge.md)） |
| dev、staging | Workloads/NonProd | 制御の側の開発・検証 |
| prod | Workloads/Prod | 制御の側（API、Signaling Gateway、Actor Host、Media Assignment Service、Worker）、Aurora、Valkey、SQS、観測のバケット |
| media-staging | Workloads/NonProd | メディアの側の検証。本番と同じ構成を最小の台数で |
| media-prod | Workloads/Media | Media Node、TURN、Recorder、Transcriber、Composer、録画のバケット（`raw/`・`final/`・`transcripts/`）、BYOIP のプール。人の常設の権限はメトリクスと内容を含まないログだけ（[ADR-0047](../decisions/0047-keys-and-operator-access-to-media.md)） |
| media-lab | Workloads/Lab | 回線の劣化の試験の基盤、負荷試験のボット（[ADR-0054](../decisions/0054-network-impairment-lab.md)、[ADR-0053](../decisions/0053-capacity-model-cost-target-and-load-bots.md)）。本番のデータを置かない |

- **SCP**（Workloads の OU）：
  - 東京・大阪以外のリージョンを禁止する（CloudFront・WAF・ACM・IAM のための us-east-1 のグローバルなサービスを除く）。S3 で海外のリージョンを足すときに見直す。データの所在は法務の L6 で確定する（[security.md](security.md) の 13 節）。
  - CloudTrail・Config・GuardDuty の停止、KMS の鍵の削除の予約を、break-glass のロール以外に禁止する。
  - `media-prod` の BYOIP のプール・IPAM の削除、EIP の解放を、Ops の期限つきのロール以外に禁止する（顧客に公開した範囲を失わないため）。
- media-lab は、prod・media-prod と経路を持たない。Media Node の AMI だけを shared から受ける。

## 2. ネットワーク

### 2.1 prod の VPC（制御の側。東京・大阪で同じ形）

| サブネット | 置くもの | インターネットへの経路 |
| --- | --- | --- |
| public | ALB（API、シグナリング）、NAT ゲートウェイ | Internet Gateway |
| private | API、Signaling Gateway、Actor Host、Media Assignment Service、Worker | NAT 経由（カレンダー、メール、外部の IdP） |
| isolated | Aurora、ElastiCache（Valkey） | なし |

- 入口は CloudFront → ALB だけ。ALB は CloudFront のマネージドプレフィックスリストだけを許す（他の題材と同じ）。
- **シグナリングの WebSocket も CloudFront を通す。** CloudFront は WebSocket を通し、HTTP/1.1 だけに対応する（[Use WebSockets with CloudFront distributions](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/distribution-working-with.websockets.html)、2026-09-27 に確認）。WAF と Shield Advanced を参加の経路の全体に掛けるため。CloudFront の文書は WebSocket の接続の長さの上限を書いていない。オリジンの応答の時間切れ（既定 30 秒）はパケットの間の待ちにも掛かり、応答の完了の時間切れは設定しなければ掛からない（[Origin settings](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/DownloadDistValuesOrigin.html)、2026-09-27 に確認）。5 秒ごとの `ping` でこの時間切れに掛からない見込みだが、長い接続の切れ方は**未検証**で、E2 の `signaling-via-cloudfront` で 8 時間の接続を試す。応答の完了の時間切れは設定しない。
- VPC エンドポイント：S3、ECR、SQS、KMS、Secrets Manager、CloudWatch Logs、STS、X-Ray、AppConfig、Private CA、Kinesis Data Firehose。

### 2.2 media-prod の VPC（東京。S2 から大阪も同じ形）

| サブネット | 置くもの | インターネットへの経路 |
| --- | --- | --- |
| media-public（AZ ごと） | Media Node、TURN | Internet Gateway（公開の IP で直接。NAT なし） |
| media-private（AZ ごと） | Recorder、Transcriber、Composer（ECS）、VPC エンドポイント | NAT なし。Transcribe・S3 は VPC エンドポイント |

- Media Node と TURN のセキュリティグループは [network-traversal.md](network-traversal.md) の 7.2 節のとおり。メディアのポートは全開で、接続の追跡を外す。
- Media Node と TURN をクラスタのプレイスメントグループに入れない（ADR-0016）。
- Recorder・Transcriber は、Media Node のプライベート IP の PlainTransport から RTP を受ける（同じ VPC の中）。

### 2.3 アカウントの間のつなぎ方

| 通信 | 経路 | 相手の限定 |
| --- | --- | --- |
| Actor Host → Node Agent（制御の API、TCP 7443、相互 TLS） | VPC のピアリング（prod ↔ media-prod） | `sg-actor-host` → `sg-media-node` |
| Node Agent → Media Assignment Service（心拍 500ms、負荷 1 秒） | 同上 | `sg-media-node` → `sg-assignment` |
| Recorder・Transcriber → Actor Host（状態、字幕の結果） | 同上 | `sg-recorder` → `sg-actor-host` |
| Node Agent・Gateway → Firehose（品質の記録） | 各 VPC の VPC エンドポイント | IAM |
| API → 録画の再生 | CloudFront の署名付き URL（`media-prod` のバケットを OAC で配る） | CloudFront の鍵の組 |

- ピアリングは同じリージョンの中だけ。S2 の東京と大阪の間は、リージョンの間のピアリングを足す（Media Node の間のカスケードは S3 から。[media-server-sfu.md](media-server-sfu.md) の 8.4 節）。

### 2.4 料金の区分（メディアの経路）

データ転送の料金のデータ（[AWSDataTransfer、東京](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSDataTransfer/current/ap-northeast-1/index.json)、2026-09-27 に確認）の読み：

| 経路 | 単価（USD/GB） |
| --- | --- |
| 東京 → インターネット | 最初の 10 TB 0.114、次の 40 TB 0.089、次の 100 TB 0.086、150 TB を超える分 0.084。全リージョンで月 100 GB まで無料 |
| インターネット → 東京 | 0 |
| 同じリージョンの中（AZ の間、または Elastic IP を使う通信） | 0.01（向きごと） |
| 東京 → 大阪 | 0.09 |

- **TURN と Media Node の間**（両方の公開の IP の間。[network-traversal.md](network-traversal.md) の 7.2 節の持ち越し）は、「Elastic IP を使う同じリージョンの中の通信」に当たり、0.01 USD/GB を向きごとに払う。料金のデータの説明は「regional data transfer - in/out/between EC2 AZs or using elastic IPs or ELB」で、インターネットへの転送の料金にはならない（[AWS Price List API](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSDataTransfer/current/ap-northeast-1/index.json) の `APN1-DataTransfer-Regional-Bytes`、2026-09-27 に確認）。
- VPC のピアリングの通信は、同じ AZ の中なら無料（アカウントをまたいでも）、AZ をまたぐと向きごとに 0.01 USD/GB（[Amazon VPC Announces Pricing Change for VPC Peering](https://aws.amazon.com/about-aws/whats-new/2021/05/amazon-vpc-announces-pricing-change-for-vpc-peering/)、[VPC の料金](https://aws.amazon.com/vpc/pricing/)、2026-09-27 に確認）。

## 3. Media Node の群れ

[ADR-0049](../decisions/0049-media-node-fleet.md) のとおり。

### 3.1 インスタンス

| リージョン | 標準 | 予備（在庫） | vCPU | 帯域 | worker | 1 時間の料金（オンデマンド） |
| --- | --- | --- | --- | --- | --- | --- |
| 東京 | c8gn.16xlarge | c7gn.16xlarge | 64 | 200 Gbps（インターネットへは 50% の 100 Gbps） | 62 | 4.775 USD（c7gn は 5.0368 USD） |
| 大阪 | c6gn.16xlarge | c6in.32xlarge、c8g.16xlarge | 64 | 100 Gbps（同 50 Gbps） | 62 | 3.495 USD |

仕様は [コンピューティング最適化のネットワークの仕様](https://docs.aws.amazon.com/ec2/latest/instancetypes/co.html)、料金は [料金のデータ（東京）](https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/ec2/USD/current/ec2-ondemand-without-sec-sel/Asia%20Pacific%20(Tokyo)/Linux/index.json)・[同（大阪）](https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/ec2/USD/current/ec2-ondemand-without-sec-sel/Asia%20Pacific%20(Osaka)/Linux/index.json)、いずれも 2026-09-27 に確認。インターネットへの上限は [EC2 のネットワークの帯域](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-instance-network-bandwidth.html)（同日に確認）。

- 大阪には c7gn・c8gn がない。大阪で提供されるのは c6gn・c6in・c8g で、東京は c6gn・c7gn・c8gn・c8g のすべてを 3 つの AZ（apne1-az1・az2・az4）で提供する（`DescribeInstanceTypeOfferings`、2026-09-27 に確認）。大阪の 1 台の上限は、東京と別に負荷試験で求める。
- **網の性能を使い切らない見込み。** [capacity.md](capacity.md) の 3 節の見積もりでは、S1 の会議の組み合わせで 1 台の送出は 3〜4 Gbps のうちに consumer と CPU が上限に来る。その場合、c8g.16xlarge（30 Gbps、インターネットへは 15 Gbps、3.2019 USD/時）で足り、約 3 割安い。E7 で両方を測って決める（ADR-0049）。

### 3.2 AMI

- EC2 Image Builder で作る。中身：Amazon Linux（arm64）、ENA のドライバ（`conntrack_allowance_available` のため 2.8.1 以上）、Node Agent（Node.js）、mediasoup の worker（本システムのフォークの版を固定）、`nftables` の規則、CloudWatch エージェント（ENA の指標）、ADOT Collector。
- worker を CPU のコアに固定する設定、カーネルの UDP の受信の緩衝の大きさ、IRQ の割り当てを AMI に入れる（値は**未検証**。E7 の `load-l0-l2` で決める）。
- Node の上に人の SSH の鍵を置かない。入るのは SSM Session Manager だけ（[security.md](security.md) の 7 節）。
- 同じ定義から、コロケーション向けのベアメタルのイメージも作れる形にしておく（[ADR-0050](../decisions/0050-disaster-recovery-and-edge-migration.md)）。

### 3.3 アドレス

| 部品 | IPv4 | IPv6 |
| --- | --- | --- |
| Media Node・TURN（東京） | BYOIP の /24（東京）のプールから EIP | VPC の Amazon の /56 のうち、media-public のサブネットの /64 |
| 同（大阪） | BYOIP の /24（大阪） | 同上（大阪の VPC） |
| 将来の Edge | BYOIP の /24（別に持つ）を自社の AS から広告 | 自社の IPv6 の範囲（S3 で決める） |

- BYOIP は、1 つの範囲を 1 度に 1 つのリージョンにしか置けない。1 リージョンに 5 つまで（[BYOIP](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-byoip.html)、2026-09-27 に確認）。1 つの ROA で大きな範囲を持ち、/24 ずつ分けて置く。
- /24 は 256 個。S1 の東京の最大（Media Node 27 台＋入れ替えの 27 台＋TURN 12 台＋ウォームプール 6 台で約 72）に足りる。
- BYOIP の範囲が E1 に間に合わないときは、AWS の連続したブロック（/28〜/30、既定で 2 つまで。[IPAM の連続した EIP](https://docs.aws.amazon.com/vpc/latest/ipam/tutorials-eip-pool.html)、2026-09-27 に確認）で始め、上限の引き上げを申請する。
- EIP の付け外しはライフサイクルフックの Lambda が行う。Node のロールには与えない（ADR-0049）。
- 公開の IPv4 は 1 つ 1 時間 0.005 USD。BYOIP で持ち込んだ IPv4 には、この料金がかからない（[VPC の料金](https://aws.amazon.com/vpc/pricing/)、2026-09-27 に確認）。BYOIP のプールから取った EIP は、EIP の数の上限（既定でリージョンに 5）に数えない（[Elastic IP addresses](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/elastic-ip-addresses-eip.html)、同日に確認）。AWS の連続したブロックには別の料金がかかる（同上の IPAM の文書）。

### 3.4 配置と増減

- AZ ごとに 1 つの Auto Scaling グループ。東京は AZ ID で apne1-az1・az2・az4 の 3 つ（apne1-az3 は新しいアカウントで使えない。AZ の名前はアカウントごとに対応が違うので、Terraform は AZ ID で指定する。`DescribeAvailabilityZones`、2026-09-27 に確認）。
- 台数は、1 つの AZ を失っても残りの 2 つでピークを受けられるように持つ（AZ ごとにピークの半分の容量）。付け替えの予備の Node は別の AZ から選ぶ（[ADR-0012](../decisions/0012-media-assignment-and-cascading.md)）。
- **増やす**：
  - 指標：Media Assignment Service が出す `fleet_headroom{az}`（点が 0.7 未満の Node の、0.7 までの空きの合計を参加者の数に直したもの）。AZ ごとの目標（ピークの 1 時間の増加の見込み、初期見積もり 1,500 人）を下回ったら 1 台ずつ足す。
  - 予測：Worker が、翌日の予定の会議の招待の数から時間ごとの見込みを作り、Auto Scaling のスケジュールのアクションで前もって台数を上げる（平日の 8 時半〜10 時の立ち上がり）。
  - ウォームプール：AZ ごとに停止した台を 2 台。起動から `active` までの時間は**未検証**（E2 の `media-fleet-asg` で測る。目標 90 秒）。
- **縮める**：インスタンスは縮める保護を付けて起動する。Assignment Service が点の低い Node に `node.drain` を送り、会議が 0 になった台だけ、保護を外して終了させる（[media-server-sfu.md](media-server-sfu.md) の 10 節）。最小は AZ ごとに 2 台。
- **drain の上限**：自然に終わるのを 4 時間まで待つ。夜間の縮める操作は、4 時間を待たず make-before-break で移してよい（利用者の少ない時間。移動の途切れは数百 ms の見込み）。

### 3.5 Media Node の状態と健全性

| 状態 | 意味 | 新しい会議 |
| --- | --- | --- |
| `booting` | EIP の確認、worker の起動、自己診断（ループバックでの転送） | 置かない |
| `active` | 健全 | 置く |
| `draining` | 計画した停止、入れ替え、攻撃を受けている | 置かない。既存の会議は続く |
| `under_attack` | 防御のモード（[ADR-0045](../decisions/0045-ddos-defense-for-media-edge.md)） | 置かない |
| `dead` | 心拍の欠落か、クライアントの途絶の報告（[ADR-0013](../decisions/0013-media-node-failover-and-reattach.md)） | 置かない。Auto Scaling のヘルスチェックを不健全にして入れ替える |

## 4. メディアのリージョンと Edge

| 段階 | メディアの場所 | 選び方 | 備考 |
| --- | --- | --- | --- |
| S1 | 東京の 3 AZ（大阪は最小の台数で待機） | 全会議を東京 | 西日本の参加者も東京へ（東京と大阪の間の RTT の分が増える。値は**未検証**で、E2 の `qos-report-pipeline` の RTT で測る） |
| S2 | 東京と大阪 | 会議のリージョンを、主催者の組織の設定か、最初の参加者の位置（西日本か）で決める。1 会議は 1 リージョン | 大阪は c6gn・c6in で始める |
| S3 | 東京、大阪、海外のリージョン（候補はシンガポールと米国の西海岸。S3 の前に参加者の分布で決める）、国内の Edge | 参加者の近くの Node へつなぎ、リージョンの間をカスケードでつなぐ（[media-server-sfu.md](media-server-sfu.md) の 8.4 節） | Edge の判断は下の閾値で S1 から始めうる |

- **Edge（コロケーション）**：[ADR-0050](../decisions/0050-disaster-recovery-and-edge-migration.md)。Media Node と TURN だけを置き、制御の側と Recorder は AWS に残す。Edge と AWS は Direct Connect でつなぐ（東京の 10G のポートは 1 時間 2.142〜2.25 USD、100G は 22.5 USD。[Direct Connect の料金のデータ（東京）](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSDirectConnect/current/ap-northeast-1/index.json)、2026-09-27 に確認）。
- Media Assignment Service は、Node の属性に `site`（`aws:apne1-az1`、`edge:tyo-1` など）と `generation` を持ち、場所ごとの重みで会議を置く。

## 5. TURN

| 項目 | S1 |
| --- | --- |
| インスタンス | 東京は c8gn.8xlarge（32 vCPU、100 Gbps、2.3875 USD/時）、大阪は c6gn.8xlarge（32 vCPU、50 Gbps、1.7475 USD/時。大阪に c8gn がないため）。32 vCPU 以上の条件は ADR-0016 |
| 台数 | 東京で AZ ごとに 2 台（計 6 台）、大阪で 2 台（初期見積もり。TURN を通る参加者の割合を E2 のベータで測って直す） |
| 待ち受け | UDP・TCP 3478、TLS 443（[ADR-0015](../decisions/0015-turn-coturn-and-ephemeral-credentials.md)） |
| 名前 | `<region>-<az>-<nn>.turn.<brand>.<domain>`（ワイルドカードの証明書 `*.turn.<brand>.<domain>` のため） |
| 増減 | Auto Scaling グループ（AZ ごと）。縮めるのは、参加の応答の一覧から外して割り当てが 0 になった台だけ |

## 6. 制御の側

| 部品 | 実行 | 初期見積もり（S1 のピーク） | 増やす基準 |
| --- | --- | --- | --- |
| API | ECS Fargate（Graviton） | 2 vCPU × 6 タスク | CPU 50% |
| Signaling Gateway | 同上 | 2 vCPU × 9 タスク（1 タスク 5,000 接続の見込み。**未検証**で、E7 の `signaling-load-test` で測る） | 接続の数、CPU |
| Actor Host | 同上 | 4 vCPU × 6 タスク（1 タスクの会議の上限 2,000。[signaling-and-meetings.md](signaling-and-meetings.md) の 5.3 節） | 会議の数、イベントループの遅れ |
| Media Assignment Service | 同上 | 1 vCPU × 3 タスク | — |
| Worker | 同上 | 1 vCPU × 6 タスク | SQS の古さ |
| Recorder・Transcriber・Composer | ECS（`media-prod`） | [recording-and-transcription.md](recording-and-transcription.md) で決める | — |
| Aurora PostgreSQL 18 | 東京：writer と reader（r8g.2xlarge）、大阪：Global Database の二次（r8g.xlarge、1 台） | 書き込みは参加・退出・監査・outbox が主（毎秒数百の見込み） | writer の CPU 60% |
| ElastiCache（Valkey） | クラスタモード、3 シャード × （主＋レプリカ）、Multi-AZ | リース、スナップショット、チャットの Stream、流量の制限 | メモリ 60%、CPU 50% |
| SQS、Kinesis Data Firehose、S3 | — | 品質の記録は 1 秒に約 3,000 件（3 万人 ÷ 10 秒） | — |

- Fargate の東京の単価（Graviton：vCPU 1 時間 0.04045 USD、メモリー 1 GB 1 時間 0.00442 USD。[AWS Price List API](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonECS/current/ap-northeast-1/index.json)、2026-09-27 に確認。Auth0 の [infrastructure.md](../../../auth0/docs/architecture/infrastructure.md) の 10 節と同じ出典）。
- Actor Host の停止の猶予（`stopTimeout`）は 120 秒（[signaling-and-meetings.md](signaling-and-meetings.md) の 10.3 節）。Gateway の入れ替えは、接続を少しずつ切る（[delivery.md](delivery.md) の 4.2 節）。
- **Valkey の切り替えは全会議の Actor を止めうる**（切り替えが 4.5 秒を超えると、全 Actor が自分で止まる。[signaling-and-meetings.md](signaling-and-meetings.md) の 12 節）。メンテナンスの時間を夜間に固定し、エンジンの更新は計画した引き渡しと組み合わせる。

## 7. S1 の構成と台数（初期見積もり）

| 部品 | 東京（ピーク） | 東京（夜間） | 大阪 |
| --- | --- | --- | --- |
| Media Node | 27 台（AZ ごとに 9） | 6 台 | 3 台（c6gn.16xlarge） |
| TURN | 6 台 | 6 台 | 2 台 |
| API・Gateway・Actor Host・Assignment・Worker | 6 節 | 最小（各 AZ に 1） | 最小（各 1 タスク） |
| Aurora | writer＋reader | 同じ | 二次 1 台 |
| Valkey | 3 シャード × 2 | 同じ | 1 シャード × 2（複製しない。失ってよい） |

- 台数の根拠は [capacity.md](capacity.md) の 5 節。

## 8. バックアップと災害復旧

方針は [ADR-0050](../decisions/0050-disaster-recovery-and-edge-migration.md)。手順は [runbooks/disaster-recovery.md](../runbooks/disaster-recovery.md)。

### 8.1 バックアップ

| 対象 | 方法 | 保持 |
| --- | --- | --- |
| Aurora | 自動バックアップ（PITR）、日次のスナップショットを大阪へコピー | 35 日 |
| Valkey | 取らない（失ってよい。会議の状態はクライアントの申告と Aurora から戻す。[ADR-0007](../decisions/0007-meeting-actor-lease-and-epoch.md)） | — |
| 録画（`final/`） | S3 の版管理。大阪への複製は S1 ではしない（[recording-and-transcription.md](recording-and-transcription.md) の 6.1 節） | 組織の保持に従う |
| log-archive | Object Lock、大阪へ複製 | 7 年 |
| Terraform の状態 | shared のバケット（版管理、大阪へ複製） | 90 日 |
| BYOIP の範囲 | 範囲そのものはバックアップできない。IPAM とプールの削除を SCP で禁止する | — |

### 8.2 AZ の障害（NFR-004）

| 部品 | 振る舞い | 目標 |
| --- | --- | --- |
| Media Node | 同じ AZ の Node の会議を、別の AZ の予備の Node へ付け替える | 音声が 5 秒以内（p95） |
| TURN | クライアントは別の AZ の TURN を候補に持つ。ICE restart | 5 秒（**未検証**。E2 の `ice-restart-flow` で測る） |
| Actor Host | リースが切れ、別の AZ の Host が取る | 制御が 10 秒以内 |
| Gateway | クライアントが別のタスクへ再接続 | 数秒 |
| Aurora | Multi-AZ のフェイルオーバー | 1〜2 分（その間、失ってはならない変更だけ失敗する） |
| Valkey | レプリカの昇格 | 切り替えが 4.5 秒を超えると全 Actor が取り直す |

- AZ を失った直後は、残りの 2 つの AZ の Media Node の点が上がる。台数は AZ ごとにピークの半分を持つので受けられる（3.4 節）。Auto Scaling が失った AZ の分を残りの AZ に足す。

### 8.3 リージョンの障害（東京）

- 目標：新しい会議の開始と参加を、切り替えの判断から 1 時間以内に大阪で受ける（RTO 1 時間）。Aurora の RPO 1 分。**既定案**（Ops・PM の承認を要する）。
- 進行中の会議は守らない。東京の Media Node が生きていればメディアは続くが、制御は戻らない。クライアントは 60 秒でシグナリングが戻らなければ、入り直しの画面を出す。
- 大阪の Media Node は平時 3 台。切り替えで最大を上げる。大阪の EC2 の在庫は保証されないので、受けられる同時の参加者の数を訓練で測り、運用の上限にする。
- 大阪で使えない・劣るもの：c7gn・c8gn（c6gn で代える）、Amazon Transcribe（大阪には batch・streaming のどちらの受け口もない。[Amazon Transcribe endpoints and quotas](https://docs.aws.amazon.com/general/latest/gr/transcribe.html)、2026-09-27 に確認。大阪で受けている間は、ライブ字幕と会議の後の文字起こしを止める。東京の外の別のリージョン（ソウルなど）へ音声を送る代わりの経路は、外国にある第三者への提供（intent.md の L6）の結論まで作らない）、進行中の録画の未合成の区切り。

### 8.4 大阪の待機の構成の確認（月次）

- Aurora の二次の遅延、大阪の ECS の最小のタスクの健全性、大阪の Media Node の自己診断と合成の会議、BYOIP の大阪の /24 の広告、KMS のレプリカの鍵での復号、大阪の EC2 の上限（vCPU、EIP）。

## 9. CI/CD と Terraform

### 9.1 CI/CD

他の題材と同じ（GitHub Actions、OIDC、1 回ビルドして同じ成果物を昇格、prod は Ops の承認）。メディアに固有の点は [delivery.md](delivery.md)。

```
制御の側：main → ビルド（コンテナ）→ dev → staging → prod（ECS の blue/green、Actor の計画した引き渡し）
Media Node：main → AMI（Image Builder）→ media-lab（回線の劣化・負荷）→ media-staging（24 時間の合成の会議）
            → media-prod（カナリア → 日ごとの波。ADR-0055）
Web クライアント：main → ビルド → staging → prod（割合で広げる。ADR-0056）
```

### 9.2 Terraform の配置

開発リポジトリの `infra/` に置く。状態ファイルは shared のバケット。ルートモジュールを、変更の頻度と影響の範囲で分ける。

| ルートモジュール | 中身 | 変更の承認 |
| --- | --- | --- |
| `org/`、`security/` | Organizations、SCP、Identity Center、GuardDuty など | Ops の責任者＋セキュリティの担当 |
| `global/edge` | CloudFront、WAF、Shield Advanced の保護、ACM、Route 53 | Ops（WAF と Shield は `security:sensitive`） |
| `regional/network` | prod の VPC、NAT、VPC エンドポイント | Ops |
| `regional/data` | Aurora、Valkey、SQS、Firehose、観測のバケット | Ops。状態を持つ資源の削除・置き換えは CI で拒否 |
| `regional/keys` | KMS の鍵、キーポリシー、Private CA | `security:sensitive` |
| `regional/control` | ECS のクラスタとサービス、ALB、オートスケール | Ops |
| `media/ip` | IPAM、BYOIP のプール、EIP の確保 | Ops の責任者（削除は SCP でも禁止） |
| `media/network` | media-prod の VPC、ピアリング、セキュリティグループ、ネットワーク ACL | `security:sensitive` |
| `media/fleet` | Image Builder のパイプライン、起動テンプレート、Auto Scaling グループ、ライフサイクルフックの Lambda、ウォームプール | Ops（AMI の切り替えは [delivery.md](delivery.md) の手順） |
| `media/turn` | TURN の Auto Scaling グループ、証明書の更新 | Ops |
| `media/recording` | Recorder・Transcriber・Composer の ECS、録画のバケット | Ops |
| `lab/` | media-lab のランナー、ボット、mac のインスタンス | Dev |

plan のポリシー検査（OPA・Checkov）で、次を拒否する。

- Media Node・TURN のセキュリティグループで、メディアのポートの入りと出のすべてが 0.0.0.0/0・::/0 でない（接続の追跡がかかる。ADR-0016）
- Media Node の前の NLB・Global Accelerator（ADR-0016）
- Media Node の Auto Scaling グループで、縮める保護がない、instance refresh が有効（[ADR-0055](../decisions/0055-media-node-rolling-replacement.md)）
- Media Node のロールに `ec2:AssociateAddress`・`ec2:DisassociateAddress`（ADR-0049）
- クラスタのプレイスメントグループに Media Node・TURN を入れる
- `<brand>-content` のキーポリシーで、`org_id` の文脈の条件のない `Decrypt`（[ADR-0047](../decisions/0047-keys-and-operator-access-to-media.md)）
- `prod` の Aurora・Valkey のセキュリティグループが `media-prod` の CIDR を許す（ADR-0048）
- Media Node のメディアのポートの範囲が 20000〜20255 を超える（ADR-0010）

## 10. 環境とデータ

| 環境 | 目的 | データ |
| --- | --- | --- |
| local | 開発、エージェントの確認ループ（Media Node は Docker の上の mediasoup） | seed。試験の音声・映像は公開のデータセットか合成だけ |
| dev・staging | 制御の側の結合と、リリース前の確認 | seed、生成データ |
| media-staging | メディアの側のリリース前の確認、24 時間の合成の会議、DR の訓練 | 合成の会議だけ |
| media-lab | 回線の劣化の試験、負荷試験 | 合成だけ |
| prod・media-prod | 本番 | 本番。本番のデータを本番のアカウントの外に出さない |

- 本番に、合成の監視の会議（社内の監視用の組織）を常に置く。各 AZ の Media Node を順に通り、`mos_est` と参加の時間を測る（[observability.md](observability.md) の 7 節）。

## 11. 段階を上げる判断の基準

次のどれかに当たり、戻らない見込みになったら、次の段階への移行を始める。移行に四半期ほどかかるので、上限の手前で始める。

| 指標 | S1 → S2 を始める目安 | S2 → S3 を始める目安 |
| --- | --- | --- |
| 同時の参加者（ピーク） | 1.8 万人（S1 の 60%）を 2 週続けて超える | 18 万人（S2 の 60%） |
| 1 会議の人数の要望 | 100 人を超える会議の契約の見込み | 300 人を超える会議の契約の見込み |
| 東京の Media Node の台数（ピーク） | 45 台を超える | — |
| 西日本の参加者 | 参加者の 25% 以上が西日本から、かつ RTT の p95 が東京の参加者より 15ms 以上大きい（閾値は既定案。E2 の `qos-report-pipeline` の RTT の実測で見直す） | — |
| 海外の参加者 | — | 参加者の 10% 以上が海外から、かつ glass-to-glass が NFR-001 を満たさない |
| Actor Host の 1 会議の負荷 | — | 1,000 人の会議の Actor の負荷試験が 1 プロセスに収まらない見込み |

**Edge（コロケーション）の判断は段階と別に置く。** ピークの送出が 4 週続けて 10 Gbps を超えたら始める（ADR-0050。S1 の途中で当たる見込み）。その手前に、Edge の運用の体制（24 時間の当番、自社の AS と BGP の運用）を持つかの判断の点を置く。ピークの送出が 2 週続けて 5 Gbps を超えたら、PM と Ops が体制（採用か委託か）を決める。持たないと決めたら、Edge の代わりに AWS との料金の合意と国内のベアメタルのクラウドを E12 の `edge-evaluation` で比べる（[architecture/README.md](README.md) の 6 節のリスク）。

## 12. 費用の概算（S1、本番、1 か月）

**大まかな見積もりである。** ±50% の幅。オンデマンド・表の料金、税を含めない。1 USD = 150 円と仮定する。

### 12.1 前提

- S1 のピーク：同時の参加者 3 万人。送出は、期待の平均（下り 1 人 1.5 Mbps）で 45 Gbps、容量の前提（2.5 Mbps）で 75 Gbps（[architecture/README.md](README.md) の 2 節。どちらも**未検証**。E2 のベータで `qos-report-pipeline` の要約から測る）。費用は両方を並べる。
- 月の平均の負荷は、ピークの 25% と仮定する（平日の日中に集中する。**未検証**。E1 の `cost-dashboard-k8` で参加者・分の実績から直す）。
- 月の参加者・分：3 万 × 0.25 × 43,800 分 ≈ **3.3 億**。
- 月のインターネットへの転送：1 参加者・分あたり 1.5 Mbps × 60 秒 ÷ 8 ≈ 11.25 MB。3.3 億 × 11.25 MB ≈ **3.7 PB**（期待の平均）。2.5 Mbps では 18.75 MB で **約 6.2 PB**（容量の前提）。
- TURN を通る参加者は 10% と仮定する（**未検証**。E2 のベータで `qos-report-pipeline` の `ice_path` から測る）。

### 12.2 AWS（S1 の設計のまま）

| 項目 | 月額（USD、期待の平均 1.5 Mbps） | 月額（USD、容量の前提 2.5 Mbps） | 根拠 |
| --- | --- | --- | --- |
| インターネットへの転送（Media Node・TURN → 利用者） | **約 311,000**（3.7 PB） | **約 521,000**（6.2 PB） | 2.4 節の段階の単価。大半が 0.084 USD/GB |
| Media Node（東京、c8gn.16xlarge、平均 12 台） | 約 42,000 | 約 42,000 | 4.775 USD/時 × 12 × 730。台数は consumer で決まり、帯域に依らない（[capacity.md](capacity.md) の 3 節） |
| Media Node（大阪、c6gn.16xlarge × 3） | 約 7,700 | 約 7,700 | 3.495 USD/時 |
| TURN（東京 6 台、大阪 2 台） | 約 13,000 | 約 13,000 | 東京は c8gn.8xlarge 2.3875 USD/時。大阪には c8gn がないので c6gn.8xlarge 1.7475 USD/時（[AWS Price List API](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/price-changes.html) の `GetProducts`、2026-09-27 に確認）。小計は丸めの範囲で変わらない |
| TURN と Media Node の間（向きごと 0.01 USD/GB） | 約 11,400（0.57 PB） | 約 16,400（0.82 PB） | 2.4 節 |
| Shield Advanced（月額と入口の転送） | 約 3,500 | 約 3,500 | [ADR-0045](../decisions/0045-ddos-defense-for-media-edge.md) |
| **メディアの配信の小計（K8 の分子）** | **約 390,000** | **約 605,000** | |
| 制御の側（Fargate、Aurora、Valkey、CloudFront・ALB・WAF、NAT、観測、セキュリティのサービス） | 約 30,000 | 約 30,000 | Fargate の単価のほかは**未検証**（E1 の `cost-dashboard-k8` で請求から直す） |
| **合計** | **約 420,000** | **約 635,000** | |

- **K8（参加者・分あたりのメディアの配信の費用）**：期待の平均で 390,000 USD ÷ 3.3 億 ≈ 0.00118 USD ≈ **0.18 円**（制御の側を含めると約 0.19 円）。容量の前提の 2.5 Mbps では 605,000 USD ÷ 3.3 億 ≈ 0.00183 USD ≈ **0.28 円**。
- 感度：
  - 平均の下りが 2.5 Mbps に近い（ギャラリーの表示でカメラをつけた人が多い会議が中心。[capacity.md](capacity.md) の 2 節）と、S1 の K8 の目標（0.20 円）に AWS の表の料金では届かない。E2 のベータの実測で決める。
  - Media Node の EIP を Shield Advanced で常に守ると、転送の料金が約 12 万 USD 増え、K8 は約 0.23 円（ADR-0045 で退けた）。
  - 月 500 TB を超える転送は、AWS に個別に相談できる（[EC2 の料金のページ](https://aws.amazon.com/ec2/pricing/on-demand/)、2026-09-27 に確認）。割引の幅は公開されていない（**未検証**。E12 の `edge-evaluation` で見積もりを取る）。
- **費用の約 8 割が、インターネットへの転送である。** インスタンスを安い種類に替えても、全体は数 % しか下がらない。

### 12.3 コロケーション・ベアメタルとの比較

Media Node と TURN だけを国内の Edge（東京と大阪のコロケーション）に移した場合。制御の側と Recorder は AWS に残す。**IP transit と Direct Connect の単価のほかは、すべて未検証の仮定である**（E12 の `edge-evaluation` で見積もりと PoC で確かめる）。

| 項目 | 月額（USD、概算） | 仮定 |
| --- | --- | --- |
| IP transit（東京：2 社 × 50 Gbps のコミット） | 約 28,000 | 東京の 100 GigE の加重中央値 0.28 USD/Mbps/月（[TeleGeography](https://resources.telegeography.com/ip-transit-pricing-trends-asia)、2026-09-27 に確認） |
| IP transit（大阪：2 社 × 10 Gbps） | 約 5,600 | 同じ単価と仮定 |
| ラックと電力（東京 4、大阪 2） | 約 24,000 | 1 ラック 4,000 USD/月 |
| サーバー（40 台、100GbE × 2） | 約 16,700 | 1 台 2 万 USD、4 年で償却 |
| ルーターとスイッチ | 約 6,300 | 30 万 USD、4 年で償却 |
| Direct Connect（東京 10G × 2。制御の API と Recorder への RTP） | 約 3,100 | 2.142 USD/時（2.4 節の料金のデータ。Equinix TY2 などの専用の 10G のポート。AWS Price List API で 2026-09-27 に確認） |
| 運用の人（網とデータセンター、24 時間の当番、自社の AS と BGP、3 人） | 約 25,000 | — 。体制を持つかは 11 節の判断の点で決める |
| **小計（AWS の 390,000 USD に当たるもの）** | **約 109,000** | |

- K8 は約 0.05 円。AWS の約 3 分の 1〜4 分の 1。
- **損益の分かれ目**：AWS のメディアの費用はピークの送出 1 Gbps あたり月約 8,600 USD で、量に比例する。Edge は、最小の構成（2 拠点、2 社の transit、当番の人）で月約 6 万 USD の固定費と、1 Gbps あたり約 1,200 USD。分かれ目は **ピークの送出で約 8〜10 Gbps**（同時の参加者で、下り 1.5 Mbps なら約 5,000〜6,500 人、2.5 Mbps なら約 3,200〜4,000 人）。S1 の目標（3 万人）は、その 3〜9 倍である。
- **正直な評価**：
  - S1 を AWS の表の料金で動かすと、ピークの規模では月約 42 万 USD（容量の前提では約 64 万 USD）になり、その約 7 割は Edge なら要らない費用である。S1 の目標の規模に届く前に、Edge を持つ方が安い。
  - 起票の時点の [ADR-0001](../decisions/0001-platform-and-stack.md) の「S1 の規模では運用の負担が費用の差に見合わない」は、運用の人の費用を含めても、S1 のピークでは成り立たなかった。成り立つのは、同時の参加者が数千人までの立ち上がりの時期である。統合の工程で ADR-0001 を「S1 は AWS で始め、閾値（ADR-0050）で Edge を始める」に改めた。
  - ただし Edge には、機器の調達と拠点の契約（数か月）、自社の AS と BGP の運用、機器の障害の対応、DDoS の対策（transit の事業者の緩和の契約）が要る。E2 のベータ〜S1 の前半は AWS で動かし、閾値で Edge を始める（ADR-0050）。
  - 中間の選択肢として、転送の単価が安いか帯域を定額で含む国内のベアメタルのクラウドがある。機器を持たずに済むが、BYOIP を持ち込めるか、国内の拠点と DDoS の緩和の条件は事業者ごとに違う（**未検証**）。E12 の `edge-evaluation` で比べる。Edge の運用の体制を持たないと決めたとき（11 節）の第一の候補にする。

### 12.4 K8 の目標

[capacity.md](capacity.md) の 6 節（[ADR-0053](../decisions/0053-capacity-model-cost-target-and-load-bots.md)）で決める。S1 で 0.20 円以下、S2 で 0.07 円以下（**既定案**。**PM と Ops の確認の項目**）。上の見積もりでは、**S1 を AWS で下り 2.5 Mbps（容量の前提）で動かすと K8 は約 0.28 円で、0.20 円に届かない。** 届くのは、下りの平均が 1.5 Mbps 前後に収まるか、Edge（ADR-0050）か AWS との料金の合意で転送の単価が下がるときだけである。つまり S1 の目標の達成は、Edge の判断（11 節の判断の点と閾値）に掛かる。S2 の目標は、Edge か AWS との料金の合意なしには届かない。

## 13. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E1 | `accounts-and-scp-media` | 1 節のアカウント、SCP |
| E1 | `media-vpc-and-peering` | 2.2・2.3 節 |
| E1 | `byoip-onboarding` | 3.3 節。範囲の入手、ROA、IPAM のプール、`ip-ranges.json` |
| E1 | `terraform-policy-checks-media` | 9.2 節の拒否の規則 |
| E1 | `cost-dashboard-k8` | 12 節の K8 を、請求と送ったバイトから毎月計算する |
| E2 | `media-node-ami-pipeline` | 3.2 節。Image Builder、arm64 の mediasoup |
| E2 | `media-fleet-asg` | 3.4・3.5 節。AZ ごとの ASG、縮める保護、ライフサイクルフックの EIP、ウォームプール |
| E2 | `turn-fleet` | 5 節、TLS の証明書の自動の更新 |
| E2 | `signaling-via-cloudfront` | 2.1 節。WebSocket を CloudFront に通し、長い接続を試す |
| E7 | `predictive-scaling` | 3.4 節の予定の会議からの予測と、スケジュールのアクション |
| E10 | `osaka-media-standby` | 8.3 節の大阪の最小の構成と、月次の確認 |
| E10 | `dr-drill-region` | 8.3 節の訓練 |
| E12 | `edge-evaluation` | 12.3 節の比較を、見積もりの取得と PoC で確かめる |

## 14. 未解決の問い

### 決定

2026-09-27 の既定案。承認は Dev（テックリード）と Ops が行う。

- **アカウント**：`media-prod` を分ける（ADR-0048）。
- **インスタンス**：c8gn.16xlarge、予備に c7gn.16xlarge、大阪は c6gn.16xlarge（ADR-0049）。
- **アドレス**：BYOIP の /24 をリージョンごと（ADR-0049）。
- **増減**：AZ ごとの ASG、縮めるのは drain の後だけ、AZ ごとにピークの半分（ADR-0049）。
- **災害復旧**：進行中の会議は守らない、RTO 1 時間、RPO 1 分（ADR-0050）。
- **Edge**：ピークの送出が 4 週続けて 10 Gbps を超えたら始める（ADR-0050）。[ADR-0001](../decisions/0001-platform-and-stack.md) を、S1 は AWS で始めてこの閾値で Edge を始める形に改めた（統合の工程）。
- **容量の前提**：参加者 1 人の下り 2.5 Mbps。1.5 Mbps は期待の平均として費用の見込みに並べる（統合の工程）。
- **確かめて決着したもの**（2026-09-27）：BYOIP の IPv4 には公開の IPv4 の料金がかからない（3.3 節）。TURN と Media Node の間は同じリージョンの中の 0.01 USD/GB、同じ AZ の中のピアリングは無料（2.4 節）。Amazon Transcribe は大阪に無く、大阪で受けている間は字幕と文字起こしを止める（8.3 節）。大阪の TURN は c6gn.8xlarge（12.2 節）。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| c8gn.16xlarge と c8g.16xlarge のどちらが参加者あたり安いか | E7 の `load-l0-l2` |
| BYOIP の範囲の入手の時間と費用 | E1 の `byoip-onboarding` の前に Ops が始める |
| 参加者 1 人の下りの平均（期待 1.5 Mbps、容量の前提 2.5 Mbps） | E2 のベータで測り、12 節の費用と [capacity.md](capacity.md) を直す |
| CloudFront の WebSocket の長い接続の切れ方 | E2 の `signaling-via-cloudfront` で 8 時間の接続を試す |
| Edge の運用の体制（24 時間の当番、自社の AS と BGP）を持つか | ピークの送出が 2 週続けて 5 Gbps を超えたら、PM と Ops（11 節） |
| 大阪の EC2 の在庫と、切り替えの時に受けられる参加者の数 | DR の訓練で測る |
| 海外のリージョンの候補 | S3 の前に、参加者の分布で決める |

## 15. quality.md・runbooks への項目

### quality.md

- DR の訓練の結果（RTO、受けられた参加者の数）。
- AZ の障害の訓練の結果（全参加者の音声が戻るまでの時間の分布）。
- Media Node の起動から `active` までの時間（ウォームプールの有無で）。
- K8 の実績（月次）と、転送の量・参加者・分の推移。

### runbooks

- [disaster-recovery.md](../runbooks/disaster-recovery.md)：AZ の障害、東京の障害、Aurora・Valkey の障害、訓練（この文書で書いた）。
- [deploy-and-rollback.md](../runbooks/deploy-and-rollback.md)：制御の側、Media Node、TURN、Web クライアント、Terraform（この文書で書いた）。
- `byoip-range-operations.md`：BYOIP の範囲の広告・撤回、ROA の更新、Edge への移動の手順。
- `ec2-capacity-shortage.md`：Media Node の起動が在庫の不足で失敗したときの、予備の種類への切り替えと、別の AZ への寄せ方。
- `eip-pool-exhausted.md`：EIP のプールが尽きたときの確かめ方（解放されていない EIP、攻撃で隔離した EIP）。

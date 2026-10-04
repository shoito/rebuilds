---
status: accepted
date: 2026-09-27
---

# ADR-0049: Media Node は c8gn.16xlarge を AZ ごとの Auto Scaling グループで動かし、BYOIP の範囲の EIP をライフサイクルフックで付ける。縮めるのは drain の後だけ

## Context

[ADR-0001](0001-platform-and-stack.md) は、Media Node を c7gn・c8gn の系列の EC2 で動かすとした。[ADR-0016](0016-media-edge-addressing-and-security-groups.md) は、公開する範囲（BYOIP か、AWS の連続したブロック）の EIP を付けるとし、どちらにするかを E1 の前に決めるとした。[ADR-0010](0010-media-node-process-layout.md) は、1 台に vCPU−2 個の worker を置くとした。

確かめたこと（いずれも 2026-09-27 に確認）：

- c7gn.16xlarge・c8gn.16xlarge はどちらも 64 vCPU・200 Gbps。c8gn.48xlarge は 192 vCPU・600 Gbps（[コンピューティング最適化のネットワークの仕様](https://docs.aws.amazon.com/ec2/latest/instancetypes/co.html)）。c7g.16xlarge・c8g.16xlarge は 64 vCPU・30 Gbps（同上）。
- 東京のオンデマンドの 1 時間の料金：c8gn.16xlarge 4.775 USD、c7gn.16xlarge 5.0368 USD、c8gn.48xlarge 14.3251 USD、c7g.16xlarge 2.9107 USD、c8g.16xlarge 3.2019 USD（[料金のデータ（東京）](https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/ec2/USD/current/ec2-ondemand-without-sec-sel/Asia%20Pacific%20(Tokyo)/Linux/index.json)）。
- インターネットゲートウェイを通る通信は、32 vCPU 以上でインスタンスの帯域の 50% まで（[EC2 のネットワークの帯域](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-instance-network-bandwidth.html)）。
- AWS の連続した公開の IPv4 のブロック（IPAM）は、1 つのブロックが /28〜/30 で、既定で 2 つまで（[IPAM の連続した EIP](https://docs.aws.amazon.com/vpc/latest/ipam/tutorials-eip-pool.html)）。
- BYOIP は、IPv4 は /24 まで細かくでき、APNIC を含む RIR に登録した範囲を持ち込める。1 つの範囲は 1 度に 1 つのリージョンにだけ置ける。1 リージョンに 5 つまで（[BYOIP](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-byoip.html)）。

S1 の Media Node の台数は、ピークで 27 台の見込み（[capacity.md](../architecture/capacity.md) の 5 節）。予備と入れ替えの分を含めると、東京だけで 60 個以上の IPv4 が要る。

## Options

インスタンス：

1. **c8gn.16xlarge（c7gn.16xlarge を在庫の予備に）**
2. c8gn.48xlarge（台数を減らす）
3. c7g・c8g の 16xlarge（網の性能を抑えて安く）

アドレス：

- a. **BYOIP の /24 をリージョンごとに持ち込む。IPv6 は VPC の Amazon の範囲**
- b. AWS の連続したブロック（/28 を複数）

縮め方：

- x. **AZ ごとの Auto Scaling グループ。インスタンスは縮める保護を付けて起動し、drain が終わった台だけを終了させる**
- y. 目標の追跡のスケーリングに任せる

## Decision

1、a、x を採用する。詳細は [infrastructure.md](../architecture/infrastructure.md) の 3 節。

- **インスタンス**：c8gn.16xlarge（Graviton4、64 vCPU、200 Gbps）を標準にする。起動の失敗（在庫）に備え、同じ Auto Scaling グループの混合インスタンスの指定に c7gn.16xlarge を 2 番目に置く。worker は 62。
  - 16xlarge にするのは、1 台の障害で付け替える参加者の数（S1 の見込みで最大約 2,500 人）を抑えるため。48xlarge なら 3 倍になり、予備の Node の容量と付け替えの集中が大きくなる。
  - **E7 の負荷試験で、c8g.16xlarge（30 Gbps、約 3 割安い）とも比べる。** 1 台の上限が CPU か consumer で決まり、送出が 1 台 10 Gbps に届かないなら、c8g.16xlarge に替える（インターネットへの上限は 15 Gbps。[capacity.md](../architecture/capacity.md) の 3 節）。
  - 大阪（ap-northeast-3）は、c7gn・c8gn がないので c6gn.16xlarge（64 vCPU、100 Gbps）を使う。
- **mediasoup の worker は arm64 で動かす。** バージョンを上げるときは、arm64 の上で回線の劣化の試験を通す。
- **アドレス**：
  - IPv4 は BYOIP にする。東京に /24 を 1 つ、大阪に /24 を 1 つ、将来の Edge のために /24 を 1 つ以上持つ。1 つの ROA で大きな範囲を持ち、/24 ずつリージョンに置く。
  - 範囲の入手（IPv4 の移転の市場での取得、JPNIC・APNIC の手続き）は、E1 の前に Ops が始める。時間と費用は**未検証**（E1 の `byoip-onboarding` の前に Ops が確かめる）。BYOIP で持ち込んだ IPv4 には公開の IPv4 の料金がかからず、そのプールから取った EIP は EIP の数の上限に数えない（[VPC の料金](https://aws.amazon.com/vpc/pricing/)、[Elastic IP addresses](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/elastic-ip-addresses-eip.html)、2026-09-27 に確認）。間に合わなければ、b（/28 を 4 つ、上限の引き上げを申請）で始め、BYOIP に移るときに顧客へ 30 日前に知らせる（[ADR-0016](0016-media-edge-addressing-and-security-groups.md)）。
  - BYOIP にする最大の理由は、将来 Media Node をコロケーションへ移すとき（[ADR-0050](0050-disaster-recovery-and-edge-migration.md)）に、同じ範囲を AWS から外して自社の AS から広告できることである。顧客のファイアウォールの規則を変えずに移れる。
  - IPv6 は、VPC に付く Amazon の /56 から、サブネットごとの /64 を使う。VPC を作り直さない限り変わらない。範囲は `ip-ranges.json` に載せる。
- **EIP の付け方**：Auto Scaling グループの起動のライフサイクルフックで、Lambda が範囲のプールから空いた EIP を選び、インスタンスに付ける。Node のインスタンスのロールには `ec2:AssociateAddress` を与えない（奪われた Node が他の Node の IP を奪えないように）。Node Agent は、メタデータの公開の IP と `announcedAddress` の一致を確かめてから `active` になる（ADR-0016）。
- **台数の増減**：
  - AZ ごとに 1 つの Auto Scaling グループ（東京で 3 つ）。インスタンスは縮める保護（scale-in protection）を付けて起動する。
  - 増やす：Media Assignment Service が出す指標（点が 0.7 未満の Node の空きの合計）が、AZ ごとの目標を下回ったら増やす。平日の朝の立ち上がりに備え、予定の会議の数からの予測で、前の日に翌朝の台数を予約する（スケジュールのアクション）。起動の時間を縮めるため、停止した状態の予備（ウォームプール）を AZ ごとに 2 台置く（起動から `active` までの時間は**未検証**。E2 の `media-fleet-asg` で測る）。
  - 縮める：Assignment Service が点の低い Node を選び、`node.drain` を送る。会議が 0 になった Node だけ、保護を外して終了させる（[media-server-sfu.md](../architecture/media-server-sfu.md) の 10 節）。夜間は、AZ ごとに最小 2 台まで縮める。
- 2 を採らない理由：上の障害の範囲の理由。
- 3 を採らない理由（今は）：1 台の上限が網で決まるか CPU で決まるかが分からない。E7 の結果で替える。
- b を採らない理由：/28 は 16 個で、S1 だけで複数のブロックが要る。顧客に示す範囲が細かく分かれる。Edge へ持っていけない。
- y を採らない理由：CPU の平均で縮めると、会議のある Node が終了され、参加者が付け替えられる。

## Consequences

- 良くなること：
  - 顧客に示す範囲が、リージョンごとに /24 の 1 つで済む。Edge へ移っても変わらない。
  - 会議のある Node を、縮める操作で止めない。
- 引き受けるコスト：
  - BYOIP の範囲の取得と手続きの手間と費用。
  - Graviton の上で mediasoup の worker（C++）と、RED の変更（[ADR-0017](0017-opus-dtx-fec-red.md)）を試験し続ける。
  - 大阪だけ別の種類（c6gn）になり、1 台の上限の値をリージョンごとに持つ。

## Confirmation

- 負荷試験（E7）：c8gn.16xlarge と c8g.16xlarge で、[capacity.md](../architecture/capacity.md) の 7 節の手順で 1 台の上限を求め、参加者・分あたりの費用を比べる。
- Terraform の検査：Media Node のインスタンスのロールに `ec2:AssociateAddress`・`ec2:DisassociateAddress` がない。Auto Scaling グループに縮める保護が設定されている。
- 結合テスト：ライフサイクルフックで付けた EIP が BYOIP のプールの中にあり、Node Agent が `active` になる。プールが空のとき、インスタンスは `InService` にならず警報が出る。

---
status: accepted
date: 2026-09-27
---

# ADR-0016: Media Node と TURN は公開する範囲の Elastic IP と IPv6 を持ち、メディアのポートだけを全開の規則にして接続の追跡を外す

## Context

[ADR-0001](0001-platform-and-stack.md) は、Media Node にパブリック IP を直接持たせ、ロードバランサーを通さず、メディアのポートを接続の追跡をしない規則にすると決めた。この領域では、アドレスの持ち方と規則の中身を決める。

確かめたこと（いずれも 2026-09-27 に確認）：

- セキュリティグループは、TCP・UDP の規則が 0.0.0.0/0 か ::/0 を許し、反対の向きにも全開の規則があるとき、そのフローを追跡しない。NLB、NAT ゲートウェイ、Global Accelerator などを通る接続は必ず追跡される。ICMP は常に追跡される。追跡の数の上限を超えるとパケットが捨てられ、`conntrack_allowance_exceeded` で分かる（[接続の追跡](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/security-group-connection-tracking.html)）。
- インターネットゲートウェイを通る通信は、32 vCPU 未満のインスタンスで 5 Gbps、それ以上でインスタンスの帯域の 50% まで。1 つのフローは、クラスタのプレイスメントグループの外で 5 Gbps まで（[EC2 のネットワークの帯域](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-instance-network-bandwidth.html)）。
- 公開の IPv4 は、2024-02-01 から 1 つ 1 時間 0.005 USD（[AWS の告知](https://aws.amazon.com/blogs/aws/new-aws-public-ipv4-address-charge-public-ip-insights/)、[VPC の料金](https://aws.amazon.com/vpc/pricing/)）。
- 本家は、会議の通信の宛先の IPv4・IPv6 の範囲を公開し、顧客にファイアウォールで許させる（[Zoom network firewall or proxy server settings](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0060548)）。

企業の顧客は、宛先の範囲とポートを決めてファイアウォールに書く。インスタンスを作るたびに AWS の広い範囲から公開の IP が変わると、範囲を示せない。

## Options

アドレス：

1. **公開する範囲（BYOIP か、AWS の連続した IPv4 のブロック）から Elastic IP を付け、IPv6 と併せて持つ**
2. **インスタンスの起動時に自動で付く公開の IPv4（範囲は AWS の全体）**
3. **Global Accelerator の固定の IP の後ろに置く**

規則：

- a. **メディアのポートだけを入りと出の両方で全開にし、追跡を外す。外への不正な通信は Node の上の `nftables` で抑える**
- b. **メディアのポートの入りだけを全開にし、出を限る（追跡される）**

## Decision

1 と a を採用する。詳細は [network-traversal.md](../architecture/network-traversal.md) の 7 節。

- Media Node と TURN は、公開する IPv4 の範囲から Elastic IP を 1 つ持ち、サブネットの IPv6 のアドレスを 1 つ持つ。範囲は BYOIP か、AWS の IPAM の連続した公開の IPv4 のブロックで用意する（どちらにするかは E1 の前に Ops が決める）。
- Media Node と TURN は 32 vCPU 以上のインスタンスにする。クラスタのプレイスメントグループには入れない。
- Media Node のセキュリティグループは、UDP・TCP 20000〜20255 を IPv4・IPv6 の全開で入り、出はすべて全開。制御の API（7443）と台の間のパイプは、相手のセキュリティグループに限る。
- TURN のセキュリティグループは、UDP・TCP 3478、TCP 443、中継の口 UDP 49152〜65535 を全開で入り、出はすべて全開。中継の相手の制限は coturn で行う（[ADR-0015](0015-turn-coturn-and-ephemeral-credentials.md)）。
- 出の全開による外への不正な通信は、インスタンスの上の `nftables` の出の規則で抑える。
- Node Agent は起動時に、メタデータの公開の IP と候補に出す IP の一致を確かめる。
- 宛先の範囲とポートを `ip-ranges.json` と顧客の手引きで公開し、変更の 30 日前に知らせる。
- 2 を採らない理由：宛先の範囲を顧客に示せない。
- 3 を採らない理由：Global Accelerator を通る接続は追跡され、1 つの会議のメディアを特定の Node に届ける仕組み（Node ごとのポートの対応付け）が別に要る。転送の料金も加わる。
- b を採らない理由：UDP のフローが追跡され、インスタンスごとの追跡の上限でパケットが捨てられる（ADR-0001）。

## Consequences

- 良くなること：
  - 顧客は、決まった範囲とポートだけを許せばよい。
  - メディアの経路が、接続の追跡の上限に当たらない。
- 引き受けるコスト：
  - 公開する範囲の用意（BYOIP の手続き、または連続したブロックの条件）に時間がかかる。BYOIP は RIR（APNIC など）の RDAP の記録と ROA の更新が要り、LIR の手作業の更新は数日かかることがある（[BYOIP](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-byoip.html)、2026-09-27 に確認）。範囲そのものの入手の時間は**未検証**（E1 の `byoip-onboarding` の前に Ops が確かめる）。
  - メディアのポートの規則を変えると、追跡されていないフローはすぐに切れる。規則の変更は、Node を drain してから行う。
  - 出の全開と `nftables` の 2 か所で、出の通信を管理する。

## Confirmation

- Terraform の検査：Media Node と TURN のセキュリティグループで、メディアのポートの入りと、出のすべてが 0.0.0.0/0 と ::/0 である。Media Node の前に NLB・Global Accelerator がない。
- 監視：Media Node と TURN の `conntrack_allowance_exceeded` が 0 のまま。増えたら警報。
- 結合テスト：Node Agent は、メタデータの公開の IP と `announcedAddress` が違うとき `active` にならない。

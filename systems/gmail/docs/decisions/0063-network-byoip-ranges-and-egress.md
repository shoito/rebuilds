---
status: accepted
date: 2026-10-10
---

# ADR-0063: BYOIP の IPv4 は /24 の単位でリージョンに 1 つずつしか持ち込めないので、東京に受信 1・送信 3（`personal`・`system` の /24、`org-a`・`org-b`・`forward` の /24、`suspect`・`warmup` の /24）、大阪に受信 1 の /24 と、各リージョンに IPv6 の /48 を置く。評判の悪い送信（`suspect`）を良いプールと同じ /24 に置かない。`mta-out` は ENI の副の IP で送り、NAT を通さない。他の外への通信は、メールの IP と別の egress の代理を通し、私的な範囲を拒む。逆引きの区域は Route 53 に置き、RIR から委任を受ける

詳細は [infrastructure.md](../architecture/infrastructure.md) の 3 節。

## Context

- 受信の MX と送信のプールの IP は、自社の範囲を BYOIP で持ち込む（[ADR-0001](0001-platform-and-stack.md)）。送信のプールは 6 つ（[ADR-0018](0018-outbound-ip-pools-and-warmup.md)）。
- BYOIP の IPv4 は /24 より細かく持ち込めず、1 つの範囲は同時に 1 つのリージョンにだけ置け、1 つのリージョンに持ち込める範囲は 5 つ（申請で増やせる）。IPv6 は公開するものは /48（[BYOIP](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-byoip.html)、2026-10-10 に確認）。
- [inbound-smtp.md](../architecture/inbound-smtp.md) の 4 節は、`mx2`（大阪）を `mx1` と同じ /24 の別の IP としていた。BYOIP の決まりでは成り立たない。
- 外部のブロックリストと受け手の事業者は、/24 の単位で評判を見ることがある（**未検証**）。
- 本システムは外の Web にも通信する（画像の代理、webhook、配信停止の POST、DNS の検査、評判の照会、APNs・FCM）。その送り元をメールの IP にすると、Web の誤用がメールの評判に響く。外への通信は SSRF の入口でもある。

## Options

1. **用途と評判で /24 を分け、メールの IP と Web の外への通信を分ける**
2. 受信と送信を 1 つの /24 にまとめ、プールは IP で分ける
3. 送信のプールごとに /24 を 1 つ（6 つ）持つ

## Decision

1 を採用する。

- 東京：`in-tyo`（受信）、`out-a`（`personal`・`system`）、`out-b`（`org-a`・`org-b`・`forward`）、`out-c`（`suspect`・`warmup`）、`v6-tyo`（/48）。大阪：`in-osa`（`mx2`）、`v6-osa`（/48）。
- IMAP・submission・Web の入口は AWS の Elastic IP と CloudFront で、BYOIP の範囲を使わない。
- `mta-out` はパブリックのサブネットで、ENI の副の IP（プールの IP）から TCP 25 だけを出す。IP は台の起動で取り、終わりで返す（`ip_assignments`）。
- 他の外への通信は egress の代理（NAT の後ろ、メールの範囲と別の Elastic IP）だけから。送るたびに名前を解決し、私的・予約・リンクローカル・本システムの範囲を拒む。
- 逆引きは `mail-network` の Route 53 の区域で持ち、RIR から委任を受ける。PTR と正引きと HELO を揃える。
- 範囲は `mail-network` の IPAM で持ち込み、Organizations の連携で `mail-prod` に共有する。
- [inbound-smtp.md](../architecture/inbound-smtp.md) の 4 節の `mx2` の IP は `in-osa` に読み替える（持ち主が直す）。

### 他の案を選ばなかった理由

- **2**：受信の IP がブロックリストに載ると（受信の照会の誤った掲載を含む）送信も止まり、その逆も起きる。`suspect` の送信が全員の評判を巻き込む。
- **3**：東京で 6 つの /24 と IPv6 で 7 つになり、範囲の数の上限（5）を S1 から超える。範囲の取得の費用も増える。

## Consequences

- 良くなること：
  - 疑いの送信と受信が、良い送信の /24 の評判に響かない。
  - Web への通信がメールの評判に響かず、SSRF の守りが 1 か所に集まる。
  - BYOIP の決まりの中で S1 が収まる。
- 引き受けるコスト：
  - 東京は範囲の数の上限を使い切る。S2 の前に引き上げを申請する。
  - 4 つの /24 の取得（APNIC・JPNIC からの割り当てか移転）の費用と時間。
  - 大阪には送信の範囲がない。DR の送信は別の小さな Elastic IP のプールで行う（[ADR-0064](0064-storage-classes-and-region-replication.md)）。

## Confirmation

- 静的な検査：セキュリティグループで `mta-out` の外への通信が TCP 25 だけ、他の部品の外への通信が egress の代理だけであること。
- 試験：egress の代理の SSRF の試験（私的な範囲、DNS の再束縛、転送の先）。
- 監視：範囲の広告の状態、各 IP の PTR と正引きの一致（毎日）、ブロックリストの掲載（[runbooks/README.md](../runbooks/README.md) の 5 節）。

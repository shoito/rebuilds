---
status: accepted
date: 2026-09-27
---

# ADR-0045: Shield Advanced は入口（CloudFront・ALB・Route 53）を常に守り、Media Node と TURN の EIP は攻撃のときだけ守る。Media Node には送信元を絞る防御のモードを持たせる

## Context

Media Node と TURN は、公開の IPv4・IPv6 を直接持ち、UDP のポートを全開にしている（[ADR-0016](0016-media-edge-addressing-and-security-groups.md)）。宛先の範囲は `ip-ranges.json` で公開する。攻撃者は範囲を知っていて、範囲の全体へ UDP を流せる。

- 1 つの worker は 1 つのポートを多数の参加者で共有する。そのポートへの洪水は、その worker の全参加者に効く（[ADR-0010](0010-media-node-process-layout.md) の Consequences）。
- EC2 はインスタンスごとに PPS と帯域の上限を持ち、超えた分はハイパーバイザーの側で待たされるか捨てられる（[ENA の性能の指標](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/monitoring-network-performance-ena.html)、2026-09-27 に確認）。上限を超える洪水は、インスタンスの中の `nftables` では止められない。

AWS Shield Advanced で確かめたこと（いずれも 2026-09-27 に確認）：

- 月額 3,000 USD、1 年の契約。守る資源の外への転送に、別の料金がかかる（[Shield の料金](https://aws.amazon.com/shield/pricing/)）。
- 東京で Elastic IP（EC2・NLB）から出る転送の料金は、最初の 100 TB が 0.050 USD/GB、次の 400 TB が 0.040 USD/GB、500 TB を超える分が 0.030 USD/GB（[料金のデータ](https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/shield/USD/current/shield.json)）。
- 守れるのは、CloudFront、Route 53 のホストゾーン、Global Accelerator、Elastic IP（それに付いた EC2）、ALB など。明示した資源だけを守る。1 アカウントで資源の種類ごとに 1,000 まで（[守れる資源](https://docs.aws.amazon.com/waf/latest/developerguide/ddos-protections-by-resource-type.html)）。
- **IPv6 に対応しない**（同上）。

S1 のインターネットへの転送は、月に約 3.7 PB の見込みである（[capacity.md](../architecture/capacity.md) の 6 節）。Media Node の EIP を常に守ると、Shield Advanced の転送の料金だけで月に約 12 万 USD になる。これはインターネットへの転送の料金（約 31 万 USD）の約 4 割に当たる。

## Options

1. **Shield Advanced を契約し、入口（CloudFront・ALB・Route 53）を常に守る。Media Node と TURN の EIP は、攻撃を受けたときだけ守りに加える。Media Node に、送信元を絞る防御のモードを持たせる**
2. Shield Advanced を契約し、Media Node と TURN の EIP も常に守る
3. Shield Advanced を契約しない（Shield Standard と自前の対策だけ）
4. Media Node の前に Global Accelerator を置き、そこで守る

## Decision

1 を採用する。

- **入口は常に守る。** CloudFront（Web、API、シグナリングの WebSocket）、その後ろの ALB、Route 53 のホストゾーンを Shield Advanced の保護に入れる。これらの外への転送は小さい。
- **Media Node と TURN の EIP は、常には守らない。** 攻撃を検知したら（ENA の `pps_allowance_exceeded`・`bw_in_allowance_exceeded` の急増、受信の急増）、攻撃を受けた範囲の EIP を保護に加える。攻撃が止んで 24 時間たったら外す。手順は [runbooks/incident-response.md](../runbooks/incident-response.md) の「メディアの IP への DDoS」。
  - 保護を加えてから効くまでの時間と、検知の基準が学習を要するかは**未検証**。E1 の検証の環境で、保護を加えた直後の洪水の扱いを AWS の資料と SRT への問い合わせで確かめる。
- **Media Node の防御のモード（`under_attack`）**：Node Agent が `nftables` の集合に、その Node で ICE を通った参加者の送信元のアドレス（IP とポート）を入れる。モードを入れると、集合にない送信元からの UDP は、STUN の Binding 要求を毎秒の上限つきで通すほかは捨てる。新しい参加は、STUN から始まるので通る。モードは Node ごとに、Media Assignment Service の指示か手動で入れる。
- **攻撃を受けた Node から会議を逃がす。** 防御のモードでも ENA の上限を超えるなら、その Node を `draining` にし、会議を別の Node へ make-before-break で移す（[ADR-0013](0013-media-node-failover-and-reattach.md)）。攻撃を受けた EIP は、会議がなくなったら Node から外し、しばらく（既定 7 日）新しい Node に付けない。
- **ENA の上限の近くで動かさない。** 平時の Node の点の上限（0.7。[ADR-0012](0012-media-assignment-and-cascading.md)）は、攻撃の分の余白も兼ねる。
- **IPv6 は Shield Advanced で守れない。** IPv6 への洪水は、防御のモードと Node の入れ替えで扱う。IPv6 の範囲への攻撃が続く場合は、その範囲の候補を出すのを止め、IPv4 だけにする（フラグ `media.ipv6_candidates`）。
  - > 2026-09-27 の注記：防御のモード（`under_attack`）の Node は、IPv6 の候補を出すのを止める。その Node で新しく作る transport と、ICE restart の候補は IPv4 だけにする。攻撃のときに加える Shield Advanced の保護が IPv6 には効かないため、守れる経路に寄せる。IPv6 だけの網の参加者は、TURN（IPv4 と IPv6 の両方の割り当て）を通る。範囲の全体への IPv6 の攻撃には、これまでどおり `media.ipv6_candidates` を切る（[network-traversal.md](../architecture/network-traversal.md) の 9 節、[security.md](../architecture/security.md) の 8.3 節）。
- 2 を採らない理由：転送の料金が約 4 割増える。守れない IPv6 が残る。
- 3 を採らない理由：入口（参加の API とシグナリング）への L7 の攻撃で、全員が参加できなくなる。SRT の支援と、攻撃による費用の増加の補償（DDoS cost protection）が得られない。
- 4 を採らない理由：[ADR-0016](0016-media-edge-addressing-and-security-groups.md) で退けた（接続の追跡、Node への対応付け、料金）。

## Consequences

- 良くなること：
  - 参加の入口は、L3〜L7 の攻撃から常に守られる。
  - メディアの転送に、Shield Advanced の料金を常にはかけない。
- 引き受けるコスト：
  - Media Node への攻撃の最初の数分は、防御のモードと Node の入れ替えだけで耐える。攻撃を受けた Node の会議の参加者は、移動のときに数百 ms の途切れを受ける。
  - 攻撃を検知して保護を加える運用を、runbook と自動化で持つ。
  - ENA の上限を超える洪水は、Shield Advanced を加えても、効くまでは Node の側で止められない。
  - 月額 3,000 USD と、1 年の契約。

## Confirmation

- 負荷試験の環境（media-lab のアカウント）：Media Node の 1 つのポートへ、参加者でない送信元から UDP を流し、防御のモードを入れたとき、既存の参加者の音声の途切れがないこと（`pps_allowance_exceeded` が増えない範囲）。
- Terraform の検査：CloudFront の配信、ALB、Route 53 のホストゾーンが Shield Advanced の保護に入っている。
- 訓練（半年に 1 回）：runbook の手順で、EIP を保護に加えて外すまでを 30 分以内に終える。

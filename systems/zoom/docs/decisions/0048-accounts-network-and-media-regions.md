---
status: accepted
date: 2026-09-27
---

# ADR-0048: メディアに触れる部品は media-prod のアカウントに置き、制御の側とは VPC のピアリングでつなぐ。S1 のメディアは東京の 3 AZ、大阪は災害の備え、海外は S3 から

## Context

[ADR-0001](0001-platform-and-stack.md) は、制御の側を他の題材と同じ AWS の基盤（東京、災害復旧は大阪）に置き、Media Node を EC2 で動かすと決めた。[ADR-0047](0047-keys-and-operator-access-to-media.md) は、平文のメディアに触れる部品を別のアカウントにまとめると決めた。

メディアの部品には、制御の側にない条件がある。

- 公開の IP を直接持ち、全開のポートを持つ（[ADR-0016](0016-media-edge-addressing-and-security-groups.md)）。
- ネットワークの性能の高いインスタンスの在庫と、アカウントの上限（vCPU、EIP、BYOIP の範囲）が要る。
- 大阪には c7gn・c8gn がない。2026-09-27 の東京と大阪のオンデマンドの料金のデータで、東京には c7gn・c8gn があり、大阪には c6gn・c6in までしかない（[料金のデータ（東京）](https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/ec2/USD/current/ec2-ondemand-without-sec-sel/Asia%20Pacific%20(Tokyo)/Linux/index.json)、[同（大阪）](https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/ec2/USD/current/ec2-ondemand-without-sec-sel/Asia%20Pacific%20(Osaka)/Linux/index.json)、2026-09-27 に確認）。
- 同じリージョンの中で、公開の IP どうしの通信は 0.01 USD/GB（「regional data transfer - in/out/between EC2 AZs or using elastic IPs」）。東京から大阪への転送は 0.09 USD/GB（[データ転送の料金のデータ（東京）](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSDataTransfer/current/ap-northeast-1/index.json)、2026-09-27 に確認）。

## Options

アカウント：

1. **`prod`（制御の側）と `media-prod`（Media Node、TURN、Recorder、Transcriber、Composer）を分け、VPC のピアリングでつなぐ**
2. 1 つの `prod` のアカウントに、VPC だけを分けて置く
3. 1 つの VPC に置く

メディアのリージョン：

- a. **S1 は東京の 3 AZ でメディアを受ける。大阪は制御の側のウォームスタンバイと、最小の Media Node。S2 で大阪もメディアを受け、S3 で海外のリージョンか国内の Edge を足す**
- b. S1 から東京と大阪の両方でメディアを受ける

## Decision

1 と a を採用する。詳細は [infrastructure.md](../architecture/infrastructure.md) の 1〜4 節。

- **アカウント**：他の題材の構成（management、security、log-archive、shared、edge、dev、staging、prod）に、`media-prod`・`media-staging`・`media-lab` を足す。
  - `media-lab` は、回線の劣化の試験と負荷試験のためのアカウント。本番のデータを置かない（[ADR-0054](0054-network-impairment-lab.md)）。
  - `media-prod` への人のアクセスは [ADR-0047](0047-keys-and-operator-access-to-media.md) に従う。
- **ネットワーク**：
  - `media-prod` の VPC は、公開のサブネット（Media Node、TURN）と、プライベートのサブネット（Recorder、Transcriber、Composer、VPC エンドポイント）を 3 AZ に持つ。Media Node と TURN は NAT を通らない（公開の IP で直接出る）。
  - `prod` の VPC と `media-prod` の VPC は、同じリージョンの中で VPC のピアリングでつなぐ。通すのは、Actor Host → Node Agent の制御の API（TCP 7443）、Node Agent → Media Assignment Service の心拍と負荷の報告、Recorder・Transcriber → Actor Host（字幕の結果）だけ。セキュリティグループの参照で相手を限る。
  - Transit Gateway は S1 では使わない。リージョンの間（S2 の東京と大阪）は、リージョンの間の VPC のピアリングを使う。
- **メディアのリージョン**：
  - S1：東京（ap-northeast-1）の 3 AZ。全会議を東京に置く。大阪（ap-northeast-3）には、制御の側のウォームスタンバイと、最小の Media Node・TURN を置く（災害の備え。[ADR-0050](0050-disaster-recovery-and-edge-migration.md)）。
  - S2：大阪でも会議を受ける。Media Assignment Service は、参加者の位置（西日本か）と、主催者の組織の設定で、会議のリージョンを決める。大阪の Media Node は c6gn・c6in で始め、c7gn・c8gn が大阪に来たら替える（在庫の状況は**未検証**）。
  - S3：海外の参加者のためのリージョン（候補はシンガポールと米国の西海岸。**未検証**）と、国内の Edge（コロケーション）を足す。リージョンの間のカスケードは [media-server-sfu.md](../architecture/media-server-sfu.md) の 8.4 節。
- 2 を採らない理由：[ADR-0047](0047-keys-and-operator-access-to-media.md) の、平文のメディアに触れる権限の境界が作れない。
- 3 を採らない理由：公開のインスタンスと、Aurora・Valkey が同じ VPC に並び、誤った規則の影響が大きい。
- b を採らない理由：S1 の大阪では c7gn・c8gn が使えず、Media Node の種類が 2 つになる。東京の 3 AZ で NFR-004 を満たせ、遅れも国内なら収まる見込み。

## Consequences

- 良くなること：
  - メディアの部品の上限（EIP、vCPU、Shield Advanced の保護の数）を、制御の側と別に管理できる。
  - 平文のメディアに触れる権限の境界が、アカウントの境界になる。
- 引き受けるコスト：
  - アカウントをまたぐ通信（ピアリング、ロール）の設定が増える。同じ AZ の中のピアリングの通信は無料、AZ をまたぐと 0.01 USD/GB（上の料金のデータの読み。**未検証**：ピアリングの課金の区分を E1 で確かめる）。
  - 西日本の参加者は、S1 では東京の Node につなぐ。東京と大阪の間の RTT の分だけ遅れる（数 ms の見込み。**未検証**）。

## Confirmation

- Terraform の検査：`media-prod` と `prod` のピアリングの経路と、セキュリティグループの規則が、上の 3 つの通信だけを許す。
- 結合テスト：`prod` の Aurora・Valkey のセキュリティグループが、`media-prod` の CIDR を許していない。

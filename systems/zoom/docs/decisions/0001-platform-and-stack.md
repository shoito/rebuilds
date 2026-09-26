---
status: proposed
date: 2026-09-27
---

# ADR-0001: 制御の側は他の題材の基盤を引き継ぎ、メディアは EC2 の上の mediasoup で中継する

## Context

rebuilds の他の題材（Slack、Stripe など）で、次の基盤を決めている。

- AWS の東京（災害復旧は大阪）、ECS Fargate、Aurora PostgreSQL 18、ElastiCache（Valkey）、SQS、S3、CloudFront
- TypeScript（Hono＋Zod）
- Terraform、OpenTelemetry、トランクベース開発

ビデオ会議には、他の題材にない条件が 3 つ加わる。

- **UDP のメディアを大量に中継する。** S1 のピークで約 45 Gbps、約 1,000 万パケット/秒を送る見込み（[architecture/](../architecture/README.md) の 2 節）。遅れの目標は p95 300ms で、処理の揺らぎも許されない。
- **メディアサーバーは、パブリックな UDP のポートを多数開ける。** ロードバランサーの後ろに置く普通の Web のサービスとは、網の作りが違う。
- **SFU は難しい部品である。** RTP・RTCP、DTLS-SRTP、ICE、simulcast と SVC の層の切り替え、帯域の推定を正しく実装する必要がある。

EC2 の網には、次の上限がある（[EC2 のネットワークの帯域](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-instance-network-bandwidth.html)、[接続の追跡](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/security-group-connection-tracking.html)、[ENA の性能の指標](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/monitoring-network-performance-ena.html)、いずれも 2026-09-27 に確認）。

- インターネットゲートウェイを通る通信は、32 vCPU 未満のインスタンスで 5 Gbps、それ以上でインスタンスの帯域の 50% まで。
- インスタンスごとに PPS と追跡できる接続の数の上限がある。超えた分は、待たされるか捨てられる。PPS の上限の値は、インスタンスの種類ごとには公表されていない。
- セキュリティグループは UDP のフローも追跡する。送信元と宛先を全開にした規則のフローは追跡されない。NLB を通る接続は必ず追跡される。
- 網に強いインスタンスの例：c7gn.16xlarge は 200 Gbps、c8gn.48xlarge は 600 Gbps（[コンピューティング最適化のネットワークの仕様](https://docs.aws.amazon.com/ec2/latest/instancetypes/co.html)、2026-09-27 に確認）。

SFU の実装の候補を比べた（いずれも 2026-09-27 に確認）。

| 候補 | 言語 | ライセンス | 特徴 |
| --- | --- | --- | --- |
| [LiveKit](https://github.com/livekit/livekit) | Go（Pion の上） | Apache 2.0 | サーバー一式（シグナリング、部屋、録画、SIP）を持つ。自前でホストする場合、1 つの部屋は 1 台に収まる必要がある（[Distributed setup](https://docs.livekit.io/home/self-hosting/distributed/)）。複数の台にまたがる部屋は、LiveKit Cloud の機能 |
| [mediasoup](https://github.com/versatica/mediasoup) v3 | C++ の worker（libuv）、制御は Node.js か Rust | ISC | シグナリングを持たないライブラリ。worker は 1 コアで動き、1 つで 500 程度の consumer を扱う。`pipeToRouter` で worker や別の台の router をつなげる（[Scalability](https://mediasoup.org/documentation/v3/scalability/)） |
| Rust で一から作る（str0m や webrtc-rs の上） | Rust | — | 自由度は最大。RTP・DTLS・ICE・帯域の推定・層の切り替えを自分で作り、試験する量が最大 |
| [Jitsi Videobridge](https://github.com/jitsi/jitsi-videobridge) | Java | Apache 2.0 | ブリッジのカスケード（Octo、relay）が成熟している。JVM の GC の揺らぎと、Jitsi の会議の仕組み（XMPP、Jicofo）との結び付きが強い |
| [Janus](https://janus.conf.meetecho.com/docs/COPYING.html) | C | GPLv3 | プラグインで何でも作れる。GPLv3 のため、改変して配るときの条件が重い |
| [Pion](https://github.com/pion/webrtc) | Go | MIT | WebRTC のライブラリ。SFU は自分で組み立てる |

## Options

1. **制御は他の題材の基盤、メディアは EC2 の上の mediasoup（制御は TypeScript）**
2. **LiveKit のサーバーを使う（必要ならフォークする）**
3. **Rust で SFU を一から作る**
4. **メディアも ECS Fargate で動かす**
5. **最初からベアメタル・コロケーションで動かす**

## Decision

1 を採用する。

- **制御の側（API、Signaling Gateway、Meeting Actor、Worker）は、他の題材と同じ基盤にする。** TypeScript、Hono＋Zod、Aurora PostgreSQL 18、Valkey、Terraform、OpenTelemetry、ECS Fargate、東京と大阪。題材をまたいで、エージェントと人が同じ道具で検証できる。
- **SFU は mediasoup v3 を使う。** 転送の中核（C++ の worker）は枯れた実装に任せ、どの映像をどの層で誰に送るかの制御は、Media Node の中の TypeScript（mediasoup の Node.js の API）で書く。シグナリングのメッセージの型を、Meeting Actor・Media Node・Web クライアントで共有できる。
  - Media Node の中では、CPU のコアごとに worker を 1 つ動かし、会議を複数の worker に `pipeToRouter` で広げる。台やリージョンをまたぐカスケードも同じ仕組みで作る（[ADR-0002](0002-media-topology.md)）。
  - mediasoup の上に、自前の抽象（Media Node の API）を 1 枚置く。転送の中核を後で入れ替える余地を残す。ただし、その抽象を実装する 2 つ目の中核は作らない。
- **Media Node は EC2 で動かす。** ネットワークの性能の高いインスタンス（c7gn・c8gn の系列を第一の候補）に、パブリック IP を直接持たせる。ロードバランサーは通さない。
  - メディアのポートは、送信元・宛先を全開にした規則にして、接続の追跡をさせない。不正なパケットは、SFU の側で ICE の認証と DTLS で捨てる。
  - `pps_allowance_exceeded`・`bw_out_allowance_exceeded`・`conntrack_allowance_exceeded` を常に集め、1 台に載せる参加者の数の上限を、負荷試験の結果で決める。
- **TURN は、自前でホストする。** 実装（coturn か、SFU に組み込む形か）は network-traversal.md で決める（ADR の範囲 0014〜0016）。
- 2 は、始めるのが最も速い。ただし、自前でホストすると 1 つの部屋が 1 台に収まる必要があり、1,000 人の会議（S3）ではカスケードを自分で足すことになる。部屋・シグナリングの仕組みも LiveKit のものになり、[ADR-0005](0005-meeting-state-and-signaling.md) の会議の状態の設計と重なる。制御の言語に Go が加わる。
- 3 は、作って試験する量が大きすぎる。帯域の推定や層の切り替えの誤りは、ネットワークの劣化の下でしか見えず、発見が遅れる。
- 4 は、Fargate のタスクに多数の UDP のポートを直接開けにくく、インスタンスの網の性能を選べない。
- 5 は、S1 の規模では運用の負担が費用の差に見合わない。転送の費用が目標を超えたら、S2 から Media Node だけをコロケーションへ移す。Media Node の構成を Terraform と AMI で閉じておき、移しやすくする。

## Consequences

- 良くなること：
  - SFU の難しい部分を、実績のある実装に任せられる。
  - 制御は TypeScript で統一され、エージェントが境界をまたいで型で整合を保てる。
  - メディアの経路が、ロードバランサーやコネクションの追跡の上限に縛られない。
- 引き受けるコスト：
  - mediasoup の C++ の worker の不具合は、自分で直すか、上流に報告して待つ。C++ を読める人が要る。
  - Media Node は EC2 のインスタンスとして、AMI、OS の更新、無停止の入れ替え（会議を抜いてから止める）を自分で運用する。
  - パブリック IP を持つインスタンスが多数になり、攻撃の面が広がる。メディアのポート以外は閉じる。
  - AWS のインターネットへの転送の料金が、費用の大半になる。

## Confirmation

- 負荷試験（E7）：Media Node 1 台で、決めた参加者の数のとき、ENA の `*_allowance_exceeded` が増えず、転送の遅れ（受信から送出まで）が p99 10ms 以内。
- Terraform の検査：Media Node のセキュリティグループのメディアのポートが、追跡されない形（全開の規則が両方向にある）になっていること。Media Node の前に NLB がないこと。
- レビュー：Media Node の制御のコードが、mediasoup の API を自前の抽象の外から直接呼んでいないこと。

---
status: accepted
date: 2026-10-10
---

# ADR-0001: 管理の面は共通の基盤を引き継ぎ、メディアの面と視聴の計測は Rust で書く。メディアの面は ECS の EC2（CPU の Spot、GPU、NVMe）で動かし、視聴の出来事は MSK に流す

## Context

rebuilds の他の題材で、次の基盤を決めている。

- AWS（東京、DR は大阪。ECS Fargate、Aurora PostgreSQL 18、ElastiCache Valkey、SQS・SNS、S3・CloudFront）
- TypeScript（Hono＋Zod）
- Terraform、OpenTelemetry、AWS AppConfig のフィーチャーフラグ、トランクベース開発
- FORCE RLS と `SET LOCAL`、UUIDv7、transactional outbox

この題材の主な論点は、アップロードと変換のパイプライン、パッケージと再生、配信、ライブ、視聴の計測、おすすめと検索、著作権の照合である（[intent.md](../intent.md)）。他の題材と違い、**計算の多くが動画と音声の符号化・復号・解析で、量が桁違いに多い**。

- S1 で 1 時間/分の動画を受け、1 時間の動画あたり H.264 の全段で約 8 vCPU 時間、AV1 で約 40 vCPU 時間を使う（[architecture/README.md](../architecture/README.md) の 2.1 節）。
- ライブは GPU で、1 配信の遅延を秒の単位に抑える（NFR-005）。
- 指紋の作成は、すべての動画と参照の音声・映像を復号して解析する。照合は、参照の索引をメモリーに持つ（NFR-007）。
- 配信のオリジンと中間のキャッシュは、セグメントの範囲の読み出しを大量に返す。ローカルの NVMe が要る。
- 視聴の出来事は S1 でピーク 5,000 件/秒、S3 で 500 万件/秒。流れの中の判定と、後からのバッチの検証が同じ出来事を読む（[ADR-0007](0007-two-phase-view-counting.md)）。
- 本家の実装を核に使わない（[リポジトリ共通の ADR-0007](../../../../docs/decisions/0007-no-reuse-of-original-implementation.md)）。

一方、動画の情報、チャンネル、登録、コメント、権利者と方針、収益の台帳のような管理の面は、他の題材と同じ形の業務のアプリケーションである。

## Options

メディアの面の言語：

1. **Rust（Tokio）。符号化そのものは FFmpeg のライブラリ・x264・SVT-AV1 を FFI で呼ぶ**
2. Go（同じく C のライブラリを cgo で呼ぶ）
3. FFmpeg のコマンドを殻のスクリプト（TypeScript・Python）から呼ぶ
4. 変換をすべて AWS Elemental MediaConvert・MediaLive に任せる

メディアの面の実行基盤：

- a. **ECS の EC2 のキャパシティープロバイダー（CPU の Spot、GPU、NVMe のプールを分ける）**
- b. ECS Fargate（他の題材と同じ）
- c. AWS Batch

視聴の出来事の流れ：

- x. **Amazon MSK（Kafka のプロトコル）**
- y. Kinesis Data Streams
- z. SQS（他の題材と同じ）

## Decision

1、a、x を採用する。

### 面の分け方

| 面 | 部品 | 言語・実行基盤 |
| --- | --- | --- |
| 管理の面 | `api`、`web-bff`、`upload-service`、`relay`、通知、収益の台帳、権利者と方針、異議 | TypeScript（Hono＋Zod）、Fargate。共通の基盤のまま |
| メディアの面（状態なし） | `pipeline-orchestrator`、`manifest-service`、`live-ingest` | Rust、Fargate（`live-ingest` は NLB の裏） |
| メディアの面（重い計算） | `encode-worker`、`fingerprinter`、`packager` | Rust、EC2 の CPU の Spot のプール（急ぎの段は On-Demand の小さなプール） |
| メディアの面（GPU） | `live-transcoder`、`asr-worker` | Rust、EC2 の GPU のプール（g6、NVIDIA L4） |
| メディアの面（状態あり） | `origin-cache`、`match-engine`（索引をメモリーに持つ） | Rust、EC2（NVMe・大きなメモリー） |
| 視聴の計測 | `event-collector`、`view-validator`、`view-verifier` | Rust。収集と判定は Fargate、検証のバッチは EC2 の Spot |
| おすすめ | `recommender` | 段の殻は TypeScript、候補の取り出しと推論は Rust と ONNX Runtime（[ADR-0010](0010-recommendation-boundary.md)） |
| クライアント | Web のプレイヤーと Studio、Android、iOS | TypeScript（React）、Kotlin、Swift |

- 管理の面とメディアの面は、SQS の作業の依頼と、Aurora の状態の行と、API の契約（JSON と Protobuf）でだけつながる。管理の面は符号化・照合・数の判定を行わない。

> 2026-10-10 の注記：視聴の出来事の流れに Kinesis を選ばない決定は変えない。ただし CloudFront のリアルタイムのログの送り先は Kinesis Data Streams だけなので、この用途に限って Kinesis を使う（[ADR-0067](0067-sli-sources-and-computation.md)）。統合の工程で、`live-origin`・`license-proxy`・`delivery-blocker`・`chat-sequencer`・`ad-decision` を [architecture/README.md](../architecture/README.md) の 1.2 節に足した。


### 自前で作るもの（核）と、使う汎用の部品

| 用途 | 自前（核） | 使う汎用の部品 |
| --- | --- | --- |
| パイプラインの指揮 | 段のステートマシン、区切りの分け方、作業の配り、やり直し（`crates/pipeline`） | SQS、Aurora |
| ラダーの決め方 | 複雑さの試し、段の選び方、`ladder_version`（`crates/ladder`） | libvmaf |
| 符号化 | 区切りの符号化の殻、継ぎ目の検査 | FFmpeg のライブラリ（LGPL の組み立て）、x264、SVT-AV1、NVENC |
| パッケージ | CMAF の書き手、セグメントの索引、マニフェストの生成（`crates/cmaf`） | なし（形式は標準） |
| ABR | Web と Android の ABR | MSE、Media3 の枠 |
| 視聴の計測 | `view-rules`、仮と確定の数 | MSK、Apache DataFusion、Parquet |
| 指紋と照合 | 指紋の作り方、索引、照合（`crates/fingerprint`、`crates/match`） | FFT のライブラリ |
| おすすめ | 段のパイプライン | ONNX Runtime、SageMaker（S2） |

- 本家のプレイヤー・SDK・内部の形式・モデル・指紋のデータを使わない。
- 汎用の動画の管理のサービス（MediaConvert、MediaLive、MediaPackage、外部の動画の配信の SaaS）を、核の段の代わりに使わない（[ADR-0003](0003-codecs-and-per-title-ladder.md)）。

### 他の案を選ばなかった理由

- **2（Go）**：成り立つ。cgo の呼び出しの費用と、大きなフレームの配列のガベージコレクションが重い。指紋の索引は系列の詰め方でメモリーの原価が決まる。
- **3（コマンドを殻から呼ぶ）**：区切りの符号化の継ぎ目、フレームの単位の解析（指紋、場面の切り替え、VMAF）を、プロセスの外から細かく制御できない。エラーの扱いが文字列の解析になる。試しの符号化の速さも落ちる。
- **4（MediaConvert・MediaLive）**：指揮とラダーの決め方という題材の核を設計しないことになる。S2 の量で分あたりの価格が CPU の Spot より重いと見込む（価格は**未検証**。transcoding-pipeline の領域で比べる）。
- **b（Fargate）**：GPU と NVMe を持たない。Spot の CPU の単価も EC2 の Spot より高い。
- **c（AWS Batch）**：成り立つが、作業の配りと優先度（急ぎの段と後ろの段）を自前の指揮で持つので、ECS の EC2 のプールで足りる。他の題材と運用の道具をそろえる。
- **y（Kinesis）**：S3 の量（500 万件/秒）でシャードの数と GB あたりの費用が重い。Datadog の題材と同じ理由（[Datadog の ADR-0002](../../../datadog/docs/decisions/0002-intake-log-on-msk.md)）。
- **z（SQS）**：順序と読み直し（バッチの検証が同じ出来事を何度も読む）を持たない。

## Consequences

- 良くなること：
  - 符号化の費用を Spot で下げ、ラダーと指揮を自前で決められる。
  - 指紋・VMAF・場面の切り替えを、1 回の復号から同じプロセスで作れる。
  - 管理の面は他の題材と同じ道具で、エージェントと人が検証できる。
- 引き受けるコスト：
  - Rust・TypeScript・Kotlin・Swift の 4 つの言語を持つ。エージェントの eval に Rust のタスクを入れる。
  - EC2 のプール（Spot の中断、GPU の確保、AMI の更新）と MSK を運用する。
  - FFmpeg・x264 のライセンス（LGPL・GPL）を守る組み立てと依存の検査が要る。

## Confirmation

- 依存の検査（CI）：本家のプレイヤー・SDK、MediaConvert・MediaLive・MediaPackage の SDK を、メディアの面の依存で禁止する。FFmpeg は LGPL の組み立てだけを許し、GPL の部品（x264）は作業者のイメージの中だけに閉じ、配布物に入れない。
- lint：管理の面（TypeScript）で、符号化の設定・ラダー・視聴の判定・照合の判定を書くコードを禁止する。
- 設計の工程の最後の検証で、依存の一覧に本家の実装が核として入っていないことを確かめる。

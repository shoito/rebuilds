---
status: accepted
date: 2026-10-09
---

# ADR-0001: 管理の面は共通の基盤（TypeScript・Hono、Aurora、Fargate）を引き継ぎ、データの面（取り込み、保存、クエリ、評価）とエージェントは Rust で書く。状態を持つデータの面は ECS の EC2（NVMe）で動かす

## Context

rebuilds の他の題材で、次の基盤を決めている。

- AWS（東京、DR は大阪。ECS Fargate、Aurora PostgreSQL 18、ElastiCache Valkey、SQS・SNS、S3・CloudFront）
- TypeScript（Hono＋Zod）
- Terraform、OpenTelemetry、AWS AppConfig のフィーチャーフラグ、トランクベース開発
- FORCE RLS と `SET LOCAL`、UUIDv7、transactional outbox

この題材の主な論点は、取り込み、時系列の保存のエンジン（TSDB）、クエリのエンジン、ログの保存と検索、トレースの組み立て、モニターの評価である（[intent.md](../intent.md)）。他の題材と違い、**データの量が桁違いに多く、核のほとんどが「データの面」にある**。

- S1 で平均 500 万点/秒（ピーク 1,000 万点/秒）、ログ 50 TB/日、スパン 200 万/秒を受ける（[architecture/README.md](../architecture/README.md) の 2 節）。
- インジェスターは、有効な系列 1 億の直近 2 時間をメモリーに持つ。系列あたりのメモリーが原価を決める。
- クエリは、S3 のブロックとセグメントを範囲で読み、展開して集計する。CPU とメモリーの帯域が速さを決める。
- 評価の遅れ（NFR-004）とクエリの p99（NFR-003）のため、止まりの少ない実行系が要る。
- 利用者のホストで動くエージェントは、CPU 2% 未満・メモリー 150 MB 以下で常駐する（NFR-013）。
- 本家の実装を核に使わない（[リポジトリ共通の ADR-0007](../../../../docs/decisions/0007-no-reuse-of-original-implementation.md)）。本家のエージェントは公開されているが、使わない。本家の時系列の保存は Rust で書かれている（[Rust timeseries engine](https://www.datadoghq.com/blog/engineering/rust-timeseries-engine/)、2026-10-09 に確認）が、公開されておらず、使わない。

一方、組織・利用者・役割・モニターやダッシュボードの定義・利用量の表示のような管理の面は、他の題材と同じ形の業務のアプリケーションで、量も小さい。

## Options

データの面の言語：

1. **Rust（Tokio、シャードごとの単一スレッド）**
2. Go
3. TypeScript（Node.js）で全部を書く
4. JVM（Java・Kotlin）

状態を持つデータの面の実行基盤：

- a. **ECS の EC2 のキャパシティープロバイダー（NVMe を持つインスタンス）**
- b. ECS Fargate（他の題材と同じ）
- c. EKS

## Decision

1 と a を採用する。

### 管理の面とデータの面の分け方

| 面 | 部品 | 言語・実行基盤 |
| --- | --- | --- |
| 管理の面 | `api`、`web-bff`、`relay`、`notifier`、`usage-aggregator`、SSO・SCIM | TypeScript（Hono＋Zod）、Fargate。共通の基盤のまま |
| データの面（状態なし） | `intake-gateway`、`log-processor`、クエリの合わせ（`query-frontend`） | Rust、Fargate |
| データの面（状態あり） | `metrics-ingester`、`log-indexer`、`trace-assembler`、クエリの読み手（`query-reader`、NVMe のキャッシュ）、`monitor-evaluator`、`compactor` | Rust、ECS の EC2（NVMe を持つインスタンス） |
| エージェント | `<brand>-agent` | Rust の 1 つのバイナリ |
| Web の画面 | React | TypeScript |

- 管理の面とデータの面は、API の契約（Protobuf と JSON）でだけつながる。管理の面は、クエリの IR を `query-frontend` に渡し、結果を受ける（[ADR-0007](0007-query-language.md)）。
- クエリの言語の構文解析とコンパイルは Rust の `query-lang` に置き、画面の補完のために WASM でも配る。同じ構文を 2 つの言語で持たない。

### 自前で作るもの（核）

| 用途 | 置き場所 | 理由 |
| --- | --- | --- |
| TSDB（ヘッド、コーデック、ブロック、系列の索引、ロールアップ） | `crates/tsdb` | 題材の核（[ADR-0004](0004-tsdb-storage-engine.md)） |
| クエリのエンジン | `crates/query-lang`、`crates/query-exec` | 題材の核（[ADR-0007](0007-query-language.md)） |
| ログ・トレースの保存と検索 | `crates/segstore` | 題材の核（[ADR-0005](0005-log-storage-columnar-with-bloom.md)） |
| トレースの組み立てとテールサンプリング | `crates/trace-assembly` | 題材の核 |
| モニターの評価 | `crates/monitor-eval` | 題材の核（[ADR-0008](0008-monitor-evaluation-model.md)） |
| 分布のスケッチ | `crates/histogram` | 題材の核（distributions-and-sketches の領域） |
| エージェント | `agent/` | 題材の核。本家のエージェントを使わない |

- 第三者の汎用の部品（Tokio、Kafka のクライアント、Protobuf・gRPC のライブラリ、zstd、xxHash、AWS の SDK、OpenTelemetry のプロトコルの定義）は使ってよい。TSDB・ログの保存・組み立て・評価の判断と形式は自前で書く。
- 汎用の時系列・ログのデータベース（Prometheus の TSDB のライブラリ、ClickHouse、OpenSearch、InfluxDB など）を、核の保存として使わない。

### 状態を持つデータの面の実行基盤

- インジェスター・インデクサー・クエリの読み手は、ローカルの NVMe（ブロックのキャッシュ、ヘッドの checkpoint の一時の置き場）と、大きなメモリーを要る。Fargate はローカルの NVMe を持たず、タスクあたりのメモリーにも上限がある。
- ECS の EC2 のキャパシティープロバイダーにし、インスタンスの種類は capacity の領域で決める。サービスの定義・デプロイ・ログの経路は Fargate と同じ ECS の道具でそろえる。
- シャードとインスタンスの対応、写しの置き方（2 つの写しを別の AZ）は infrastructure の領域で決める。

### 他の案を選ばなかった理由

- **2（Go）**：取り込みとクエリは成り立つが、インジェスターのヘッドの大きなヒープでガベージコレクションの止まりとメモリーの余裕（目安で 2 倍）が要る。系列あたりのメモリーが原価を決めるこの題材では重い。SIMD の圧縮も書きにくい。
- **3（TypeScript）**：点の展開と集計の CPU の効率、メモリーの詰め方が足りない。
- **4（JVM）**：成り立つが、ヒープの調整と止まりの問題は Go と同じ。エージェントを同じ言語で書くと常駐のメモリーが NFR-013 に収まりにくい。
- **b（Fargate）**：ローカルの NVMe がなく、キャッシュを持てない。S3 の読み出しが増え、クエリの p99 と費用が悪くなる。
- **c（EKS）**：成り立つが、他の題材と運用の道具が分かれる。ECS の EC2 で足りる。

## Consequences

- 良くなること：
  - 系列あたりのメモリーと CPU の効率で原価を下げ、p99 の止まりを避けられる。
  - データの面の核（保存、クエリ、評価、エージェント）を 1 つの言語にまとめ、形式とコーデックのコードを共有できる。
  - 管理の面は他の題材と同じ道具で、エージェントと人が検証できる。
- 引き受けるコスト：
  - Rust と TypeScript の 2 つの言語を持つ。エージェントの eval に Rust のタスクを入れる。
  - EC2 のキャパシティー（インスタンスの更新、AMI、容量の予約）を運用する。
  - データの面の形式（ブロック、セグメント、Protobuf）を、バージョンで管理する手間が増える。

## Confirmation

- 依存の検査（CI）：本家のエージェント・SDK・ライブラリ、汎用の時系列・ログのデータベースを、データの面の依存で禁止する（許す汎用の部品の一覧を持つ）。
- lint：管理の面（TypeScript）で、点の集計・クエリの評価・モニターの状態の遷移を書くコードを禁止する。`query-frontend` の API を呼ぶだけにする。
- 試験：クエリの言語の構文解析が、Rust（ネイティブ）と WASM で同じ IR を出す（試験のベクトル）。
- 設計の工程の最後の検証で、依存の一覧に本家の実装が核として入っていないことを確かめる。

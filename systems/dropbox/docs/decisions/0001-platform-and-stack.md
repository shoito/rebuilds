---
status: accepted
date: 2026-10-09
---

# ADR-0001: 共通の基盤の上に、同期エンジン・分割・ブロックの索引・ジャーナルを自前で作る。クライアントの核は Rust の `sync-core` で、デスクトップ・モバイル・Web（WASM）が共有する。UI は TypeScript（Tauri）、OS の殻は Swift・Kotlin。検索に OpenSearch を足す

## Context

rebuilds の他の題材で、次の基盤を決めている。

- AWS（東京、DR は大阪。ECS Fargate、Aurora PostgreSQL 18、ElastiCache Valkey、SQS・SNS、S3・CloudFront）
- TypeScript（Hono＋Zod）
- Terraform、OpenTelemetry、AWS AppConfig のフィーチャーフラグ、トランクベース開発
- FORCE RLS と `SET LOCAL`、UUIDv7、transactional outbox

この題材の主な論点は、デスクトップのクライアントの同期エンジン、内容の番地のブロックの保存、名前空間のメタデータとジャーナル、共有、バージョンと復元である（[intent.md](../intent.md)）。他の題材と違い、**核の大部分が利用者の端末で動く**。次の条件がある。

- クライアントは、OS のファイルシステムの API（ReadDirectoryChangesW、inode・File ID）、macOS の File Provider、Windows の Cloud Files API（Win32 の C の API）を直接呼ぶ。macOS の同期の領域の中の変化は File Provider の呼び出しで受け、FSEvents は使わない（[ADR-0015](0015-local-change-observation-and-move-detection.md)）。
- 100 万ファイルを持つ端末で、静かなときの CPU 1% 未満・メモリー 300 MB 以下（NFR-008）。常駐し、利用者の PC の資源を使い続ける。
- 同期の誤りは利用者のファイルを消す。決定的な試験（同じシードで同じ結果）が組めることが要る（[quality.md](../quality.md)）。
- 分割の規則は、デスクトップ・モバイル・Web のアップロードで同じでなければ、重複排除と差分の送信が効かない（[ADR-0002](0002-chunking-and-block-addressing.md)）。
- 本家の実装を核に使わない（[リポジトリ共通の ADR-0007](../../../../docs/decisions/0007-no-reuse-of-original-implementation.md)）。本家の同期エンジンは Rust で書かれている（[Rewriting the heart of our sync engine](https://dropbox.tech/infrastructure/rewriting-the-heart-of-our-sync-engine)、2026-10-09 に確認）が、公開されておらず、使わない。

また、名前と本文の検索は、S1 で 25 億ノードの名前と、文書の本文を対象にする。Aurora の `pg_bigm`（Google Calendar の題材の選択）では、この量の索引を同じクラスタに持つと、メタデータの書き込みと資源を取り合う。

## Options

クライアントの核：

1. **Rust の共有の核（`sync-core`）。UI は TypeScript（Tauri の WebView）、OS の殻は Swift（File Provider の拡張、iOS）と Kotlin（Android）、Windows は Rust から Cloud Files API を呼ぶ**
2. TypeScript（Electron）で核も UI も書く。OS の API は Node.js のネイティブのアドオンで呼ぶ
3. OS ごとにネイティブの言語で書く（macOS・iOS は Swift、Windows は C#、Android は Kotlin）
4. Go の共有の核

検索：

- a. **Amazon OpenSearch Service を足す**
- b. Aurora の `pg_bigm`（共通の基盤の中）
- c. 自前の索引を S3 に置く

## Decision

1 と a を採用する。

### サーバー

- 実行基盤・言語・IaC・可観測性・フラグは、他の題材と同じにする。
- API、Notify、Link、Auth、Relay、Worker（`block-verifier`・`block-gc`・`preview-renderer`・`text-extractor`・`indexer`・`restore-runner`・`mass-change-detector`・`webhook-sender` など）を別の ECS のサービスにする（[architecture/README.md](../architecture/README.md) の 1.2 節）。
- 書き込みは、サービスではなくライブラリ `packages/committer` に集める。API と Worker のどこから来た書き込みも、ここで条件の確認、ジャーナル、ブロックの参照、outbox を 1 つの DB のトランザクションで書く（[ADR-0005](0005-namespace-journal-and-cursors.md)）。
- ブロックの中身はサーバーの ECS を通さない。クライアントは署名つきの URL で S3 に直接送り、CloudFront から直接受ける（[ADR-0007](0007-block-storage-layout-on-s3.md)）。

> 2026-10-09 の注記：統合の工程で、フォルダーの ZIP と 1 つの URL のダウンロードを [ADR-0054](0054-server-assembled-downloads.md) で足した。この原則は「要求を受けるサービス（API・Link・Notify・Auth）は中身を通さない。中身を読むのは決めた Worker（`block-verifier` の写し、`export-builder`、隔離した変換）だけ」と読む。

### クライアント

| 部分 | 言語・部品 | 内容 |
| --- | --- | --- |
| `sync-core` | Rust | 監視の抽象、ローカルの状態の DB（SQLite）、3 つの木と計画（[ADR-0006](0006-sync-conflict-model.md)）、分割とハッシュ（[ADR-0002](0002-chunking-and-block-addressing.md)）、送受信、ローカルのブロックの索引。I/O・時計・乱数を差し替えられる形にし、1 つの制御のループで決定的に動かす |
| macOS の殻 | Swift | File Provider の拡張と、ホストのアプリ。`sync-core` を C の ABI で呼ぶ |
| Windows の殻 | Rust | Cloud Files API（同期のルートの登録、プレースホルダー、取り出しの要求への応答） |
| デスクトップの UI | TypeScript（React）、Tauri | 状態の表示、設定、通知、選択型の同期の選択。核の判断を持たない |
| モバイル | Swift・Kotlin の UI、UniFFI で `sync-core` | 一覧、プレビュー、オフラインの保存、カメラのアップロード。木の全体の同期はしない |
| Web | React、`sync-core` の分割の WASM | アップロードの分割を、デスクトップと同じコードにする |

- 第三者の汎用の部品（SQLite、Tauri、HTTP・TLS のライブラリ、SHA-256 の実装、UniFFI）は使ってよい。同期の判断（計画、衝突、名前の対応）と分割は自前で書く。

### 自前で作るもの（核）

| 用途 | 置き場所 | 理由 |
| --- | --- | --- |
| 同期エンジン（3 つの木、計画、衝突、意図の記録） | `sync-core` | 題材の核（[ADR-0006](0006-sync-conflict-model.md)） |
| 分割 | `sync-core` の `chunker` | 題材の核。全クライアントで同じ境界（[ADR-0002](0002-chunking-and-block-addressing.md)） |
| ブロックの索引、検証、GC | サーバーの `packages/blocks`、Worker | 題材の核（[ADR-0007](0007-block-storage-layout-on-s3.md)） |
| メタデータとジャーナル、カーソル | `packages/committer`、`packages/journal` | 題材の核（[ADR-0005](0005-namespace-journal-and-cursors.md)） |
| 名前の正規化と `name_key` | `sync-core` の `names` と、サーバーの同じ規則の実装 | 両側で同じ結果。共通の試験のベクトルで確かめる（[ADR-0008](0008-node-identity-and-names.md)） |

### 検索

- 名前と本文の索引に Amazon OpenSearch Service を足す。索引は写しで、Aurora と S3 から作り直せる。権限の判定は持たせず、結果を返す前に `can()` で確かめ直す（search の領域）。
- 日本語の解析は、名前は n-gram（部分一致を取りこぼさない）、本文は形態素と n-gram の組み合わせ。解析の部品は OpenSearch の汎用のプラグインから選ぶ（search の領域）。

### 他の案を選ばなかった理由

- **2（Electron と Node.js）**：常駐のメモリーが NFR-008 に収まりにくい。File Provider の拡張は Swift の拡張としてしか作れず、核を TypeScript に置いても殻は要る。モバイルと核を共有しにくい。
- **3（OS ごとのネイティブ）**：同期の判断と分割が 3〜4 つの実装に分かれ、境界と衝突の規則がずれる。決定的なシミュレーターを実装ごとに作ることになる。
- **4（Go）**：共有の核として成り立つが、ガベージコレクションのある実行系を iOS の File Provider の拡張（メモリーの上限が厳しい）と WASM に載せる重さがある。所有権で並行の誤りを型で防げる Rust を選ぶ。
- **b（`pg_bigm`）**：25 億行の名前の索引と本文を、メタデータの書き込みの Aurora に同居させると、書き込みの遅れと容量の見積もりが読めない。本文の量にも合わない。
- **c（自前の索引）**：題材の核ではなく、作る量に見合わない。

## Consequences

- 良くなること：
  - 同期の判断と分割が 1 つのコードで、全クライアントで同じ振る舞いになる。
  - 決定的な制御のループにしたことで、シミュレーターでシードから失敗を再現できる。
  - サーバーは他の題材と同じ道具で、エージェントと人が検証できる。
- 引き受けるコスト：
  - サーバー（TypeScript）とクライアント（Rust）で、`name_key` と分割の規則を 2 つの言語で持つ。サーバーは分割をしない（ブロックの一覧を受けるだけ）が、`name_key` は両側に要る。共通の試験のベクトル（JSON）を両方の CI で回す。
  - Rust・Swift・Kotlin・TypeScript の 4 つの言語を持つ。エージェントの eval に、各言語のタスクを入れる。
  - OpenSearch の運用（容量、バージョンの更新、索引の作り直し）が増える。

## Confirmation

- 依存の検査（CI）：本家のクライアント・SDK の内部のコード、本家のプロトコルを実装したライブラリを、クライアントとサーバーの依存で禁止する。
- lint：`sync-core` の外（UI、殻）で、計画・衝突・名前の比べを行うコードを禁止する（`names::key` と `planner` の呼び出しだけを許す）。
- 試験：`name_key` の共通の試験のベクトルが、Rust と TypeScript の両方で同じ結果になる。分割の試験のベクトルが、ネイティブと WASM で同じ境界になる。
- 設計の工程の最後の検証で、依存の一覧に本家の実装が核として入っていないことを確かめる。

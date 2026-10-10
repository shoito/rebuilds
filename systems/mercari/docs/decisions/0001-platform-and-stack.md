---
status: accepted
date: 2026-10-10
---

# ADR-0001: 共通の基盤を引き継ぎ、ドメインごとのパッケージを持つ 1 つのコードベースを入口・Worker ごとのサービスで出す。Aurora は core・ledger・content の 3 クラスタにする。ML だけ Python で書く。検索は OpenSearch を汎用の部品として使う

## Context

rebuilds の他の題材で、次の基盤を決めている。

- AWS（東京、DR は大阪。ECS Fargate、Aurora PostgreSQL 18、ElastiCache Valkey、SQS・SNS、S3・CloudFront）
- TypeScript（Hono＋Zod）
- Terraform、OpenTelemetry、AWS AppConfig のフィーチャーフラグ、トランクベース開発
- FORCE RLS と `SET LOCAL`、UUIDv7、transactional outbox

この題材の主な論点（[README.md](../../README.md)）は、一品の一回の購入、取引のステートマシンと期限、預かりと台帳、日本語の検索と保存した検索、匿名の配送、T&S のパイプラインである。性質は次のとおり。

- ほとんどは業務のアプリケーション（出品、取引、メッセージ、運用の画面）で、他の題材と同じ形である。
- お金の正本（台帳）は、出品・取引と書き込みの形が違う。追記だけで、照合と監査が要り、変更の手続きを厳しくしたい。
- コメント・メッセージ・いいね・通知・保存した検索は量が多く、取引の DB の負荷と分けたい。
- 分類器（文字・画像）と価格の提案の学習は、Python の ML の道具が最も揃っている。TypeScript で学習を書く利点は小さい。
- 日本語の検索は形態素の解析が要る。PostgreSQL の全文検索は日本語の形態素の解析を持たない。
- 本家の実装を核に使わない（[リポジトリ共通の ADR-0007](../../../../docs/decisions/0007-no-reuse-of-original-implementation.md)）。

## Options

コードの形：

1. **1 つのコードベース（ドメインごとのパッケージ）を、入口・Worker ごとの別のサービスとして出す**
2. ドメインごとのマイクロサービス（別のリポジトリと DB）
3. 1 つのサービス

DB の分け方：

- a. **core・ledger・content の 3 クラスタ**
- b. 1 つのクラスタ
- c. ドメインごとのクラスタ（10 以上）

ML：

- x. **Python（学習と推論のサービス）**
- y. TypeScript（ONNX Runtime で推論だけ）
- z. 外部の分類の API

## Decision

1、a、x を採用する。

### サービスの分け方

| サービス | 入口 | 言語・実行基盤 |
| --- | --- | --- |
| `app-api` | アプリと Web の API | TypeScript、Fargate |
| `ops-api` | 運用の画面の API | 同上 |
| `listings`、`search-api`、`transactions`、`payments`、`ledger`、`payouts`、`shipping`、`messaging`、`trust-safety`、`identity`、`notifier` | 内部の API（`app-api`・`ops-api`・Worker から） | 同上 |
| Worker（`relay`、`media-processor`、`search-indexer`、`saved-search-matcher`、`deadline-runner`、`reconcilers`） | SQS の消費者、定時の処理 | 同上 |
| `ml-inference` | 分類器と価格の統計の推論 | Python、Fargate（S2 から画像は GPU を検討） |
| 学習のジョブ | データレイクから学習・評価 | Python、SageMaker の学習のジョブか ECS のタスク（infrastructure の領域） |
| アプリ・Web | — | React Native・React（TypeScript） |

- ドメインのパッケージ（`packages/listings`、`transactions`、`payments`、`ledger`、`fees`、`payouts`、`shipping`、`messaging`、`trust-safety`、`identity`、`search`、`visibility`）は、互いに公開の関数だけを呼ぶ。DB の表は持ち主のパッケージだけが書く（lint で検査する）。

### DB の分け方

| クラスタ | 表 | 書くパッケージ |
| --- | --- | --- |
| core | アカウント、端末、出品、写真の参照、取引、取引の事象、配送、住所の金庫、評価、本人確認の状態、outbox | `identity`、`listings`、`transactions`、`shipping` |
| ledger | 口座、仕訳、仕訳の行、冪等キー、振込、口座の登録、照合の結果、outbox | `ledger`、`payouts` |
| content | コメント、取引のメッセージ、いいね、閲覧の履歴、保存した検索、通知、T&S の案件・措置・通報、outbox | `messaging`、`search`、`notifier`、`trust-safety` |

- 購入（出品の更新と取引の挿入）は core の 1 つのトランザクションに閉じる（[ADR-0002](0002-transaction-state-machine-and-single-purchase.md)）。
- お金の仕訳は ledger の 1 つのトランザクションに閉じる。core と ledger は outbox と冪等キーでつなぐ（[ADR-0003](0003-escrow-and-double-entry-ledger.md)）。
- T&S の措置の記録は content、出品の状態の変更は core に書く。措置は「content に記録 → outbox → `listings` が core を変える」の順で、記録のない措置を作らない（[ADR-0009](0009-trust-and-safety-pipeline-boundary.md)）。

### 自前で作るもの（核）

| 用途 | 置き場所 | 理由 |
| --- | --- | --- |
| 購入と取引のステートマシン、期限 | `packages/transactions` | 題材の核（[ADR-0002](0002-transaction-state-machine-and-single-purchase.md)） |
| 台帳、手数料、売上金の型 | `packages/ledger`、`packages/fees` | 題材の核（[ADR-0003](0003-escrow-and-double-entry-ledger.md)、[ADR-0004](0004-proceeds-model-under-payment-services-act.md)） |
| 検索の順位付け、保存した検索の照合 | `packages/search`、`services/saved-search-matcher` | 題材の核（[ADR-0008](0008-search-engine-and-index.md)） |
| T&S の規則のエンジン、審査の待ち行列、分類器の学習と評価 | `packages/trust-safety`、`ml/` | 題材の核（[ADR-0009](0009-trust-and-safety-pipeline-boundary.md)） |
| 配送の指揮、運送会社のアダプター、住所の金庫 | `packages/shipping` | 題材の核（[ADR-0006](0006-shipping-orchestration-via-carriers.md)） |
| 見える範囲の判定 | `packages/visibility` | 題材の核（[ADR-0007](0007-single-tenant-and-party-visibility.md)） |

- **使ってよい第三者の汎用の部品**：OpenSearch（検索のエンジン）と Sudachi（形態素の解析）、sharp（画像の変換）、PyTorch・scikit-learn などの ML の枠組みと、公開の汎用の事前学習のモデル（ライセンスを確かめたもの）、AWS の SDK、OpenTelemetry。どれも本家と関係がない。
- **外部のサービス**：決済の提供者、提携銀行、運送会社、eKYC の提供者、SMS、APNs・FCM、SES。どれもアダプターの後ろに置く。
- **使わないもの**：本家のコード・SDK・API のクライアント、本家から取り出したデータ・モデル・重み・辞書。

### 他の案を選ばなかった理由

- **2（マイクロサービス）**：購入・取引・配送が別の DB に分かれ、二重の販売の防止に分散の取引が要る。小さなチームとエージェントには重い。
- **3（1 つのサービス）**：検索の急増と購入が同じタスクの資源を取り合う。
- **b（1 つのクラスタ）**：コメント・通知の書き込みが購入の p99 を押し上げる。台帳の変更の手続きを他と分けられない。
- **c（ドメインごと）**：S1 の量に対してクラスタが多すぎ、費用と運用が重い。分けるのは S2・S3 の段で行う。
- **y（TypeScript の推論）**：学習は結局 Python になり、前処理を 2 つの言語で書く。前処理の食い違いが分類器の精度の事故になる。
- **z（外部の分類の API）**：偽ブランドの判定は題材の核で、本システムの審査のデータで学習し続けたい。汎用の API はブランドごとの特徴を持たない。

## Consequences

- 良くなること：
  - 他の題材と同じ道具で、エージェントと人が検証できる。
  - 購入は core、お金は ledger の、それぞれ 1 つのトランザクションに閉じ、正しさを DB の制約で守れる。
  - 台帳の変更を、他と分けて厳しく扱える。
- 引き受けるコスト：
  - core と ledger の間の食い違いを、照合で見つけ続ける必要がある。
  - Python の `ml-inference` と学習の流れを持ち、2 つの言語になる。エージェントの eval に Python のタスクを入れる。
  - OpenSearch の運用（索引の作り直し、容量）が増える。

## Confirmation

- 依存の検査（CI）：本家のコード・SDK を依存で禁止する。許す汎用の部品の一覧を持つ。学習のデータの出どころの一覧を持ち、本家から取り出したデータがないことを確かめる。
- lint：パッケージをまたぐ表の書き込みを禁止する。ledger の表を `ledger`・`payouts` 以外が書かないことを確かめる。
- 設計の工程の最後の検証で、依存の一覧に本家の実装が核として入っていないことを確かめる。

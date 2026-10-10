---
status: accepted
date: 2026-10-10
---

# ADR-0001: 共通の基盤（TypeScript・Hono、Aurora、Fargate、Valkey、SQS・SNS）を引き継ぎ、ドメインごとのパッケージを持つ 1 つのコードベースを入口ごとのサービスで出す。関数の砂場のホストだけ Rust で書く。検索は OpenSearch、GraphQL の構文解析は graphql-js を汎用の部品として使う

## Context

rebuilds の他の題材で、次の基盤を決めている。

- AWS（東京、DR は大阪。ECS Fargate、Aurora PostgreSQL 18、ElastiCache Valkey、SQS・SNS、S3・CloudFront）
- TypeScript（Hono＋Zod）
- Terraform、OpenTelemetry、AWS AppConfig のフィーチャーフラグ、トランクベース開発
- FORCE RLS と `SET LOCAL`、UUIDv7、transactional outbox

この題材の主な論点（[README.md](../../README.md)）は、ポッドへの分け方、在庫の引き当て、チェックアウト、テーマの言語、関数の砂場、Admin API である。性質は次のとおり。

- ほとんどは業務のアプリケーション（カタログ、注文、管理画面）で、他の題材と同じ形である。
- 速さが要るのは、ストアフロントの描画とチェックアウトだが、どちらも DB の往復とキャッシュが支配する。CPU の重い計算は少ない。
- 例外は関数の砂場である。利用者の WebAssembly を、燃料で決定的に止める実行系が要る。Node.js の V8 は WebAssembly を動かせるが、燃料の仕組みを持たない。
- 商品の検索は日本語の解析が要る。PostgreSQL の全文検索は日本語の形態素の解析を持たない。
- 本家の実装を核に使わない（[リポジトリ共通の ADR-0007](../../../../docs/decisions/0007-no-reuse-of-original-implementation.md)）。本家の Liquid（Ruby、MIT）は公開されているが、テーマの言語は核なので使わない。

## Options

コードの形：

1. **1 つのコードベース（ドメインごとのパッケージ）を、入口ごとの別のサービスとして出す**
2. ドメインごとのマイクロサービス（別のリポジトリと DB）
3. 1 つのサービス（すべての入口を 1 つの ECS のサービスで）

関数の砂場の実行系：

- a. **Rust のプロセスの Wasmtime**
- b. Node.js の中の V8 の WebAssembly
- c. 別の ECS のサービス（網を越えて呼ぶ）

検索：

- x. **Amazon OpenSearch Service（汎用の部品）**
- y. PostgreSQL の全文検索と n-gram の拡張
- z. 自前の検索のエンジン

## Decision

1、a、x を採用する。

### サービスの分け方

| サービス | 入口 | 言語・実行基盤 |
| --- | --- | --- |
| `storefront-renderer` | ストアフロントの HTML | TypeScript、Fargate（ポッドごと） |
| `storefront-api` | Storefront API（GraphQL） | 同上 |
| `checkout` | カートとチェックアウト、提供者の Webhook | 同上。隣に `function-runner` |
| `admin-api` | Admin API、管理画面の API | 同上 |
| `workers` | SQS の消費者、定時の処理（引き当ての掃除、照合） | 同上 |
| `relay` | outbox → SNS | 同上 |
| `function-runner` | 関数の実行（UNIX ドメインソケット） | Rust と Wasmtime。`checkout` のタスクの隣のコンテナ |
| 全体の面（`shop-directory`、`identity`、`app-registry`、`waiting-room`、`shop-mover`、`webhook-dispatcher`） | — | TypeScript、Fargate（ポッドの外） |
| 管理画面 | — | React（TypeScript） |

- ドメインのパッケージ（`packages/catalog`、`inventory`、`checkout`、`pricing`、`tax`、`discounts`、`payments`、`orders`、`themes`、`apps`）は、互いに公開の関数だけを呼ぶ。DB の表は持ち主のパッケージだけが書く（lint で検査する）。
- 同じポッドの DB を使うので、注文の作成と引き当ての確定と outbox を 1 つのトランザクションで書ける（[ADR-0005](0005-checkout-state-machine-and-exactly-once-orders.md)）。マイクロサービスに分けると、この 1 つのトランザクションが分散の取引になる。

### 自前で作るもの（核）

| 用途 | 置き場所 | 理由 |
| --- | --- | --- |
| 在庫の引き当て | `packages/inventory` | 題材の核（[ADR-0004](0004-inventory-reservation-model.md)） |
| チェックアウトの状態の機械と注文の作成 | `packages/checkout` | 題材の核（[ADR-0005](0005-checkout-state-machine-and-exactly-once-orders.md)） |
| 税と割引の計算 | `packages/tax`、`packages/discounts` | 題材の核 |
| テーマの言語 | `packages/loom` | 題材の核（[ADR-0007](0007-theme-language-design.md)） |
| 関数の砂場のホスト | `crates/function-runner` | 題材の核（[ADR-0008](0008-extension-sandbox-wasm.md)） |
| ポッドとショップの移し替え | `packages/pods`、`services/shop-mover` | 題材の核（[ADR-0002](0002-pods-and-shop-placement.md)） |
| 待合室 | `services/waiting-room`、エッジの関数 | 題材の核（flash-sales-and-queueing の領域） |
| Admin API の費用の計算 | `packages/graphql-cost` | 題材の核（[ADR-0009](0009-admin-api-graphql-and-cost-limits.md)） |

- **使ってよい第三者の汎用の部品**：Wasmtime（WebAssembly の実行系）、graphql-js（GraphQL の参照の実装。構文解析と検証だけ）、OpenSearch（検索のエンジン）、sharp（画像の変換）、AWS の SDK、OpenTelemetry。どれも本家と関係がない。
- **使わないもの**：本家の Liquid と、それを移植した他の言語の実装（テーマの言語は自前）、本家の CLI・テーマ・アプリのひな形・SDK、本家の API の形の SDK。

### 他の案を選ばなかった理由

- **2（マイクロサービス）**：注文の作成・在庫・outbox が別の DB に分かれ、一回性と売り越しの防止に分散の取引か Saga が要る。小さなチームとエージェントには重い。
- **3（1 つのサービス）**：ストアフロントの急増とチェックアウトが同じタスクの資源を取り合い、別々に伸び縮みできない。
- **b（V8）**：燃料の仕組みがなく、止める位置が決定的でない。止めるには時計の割り込みが要り、同じ入力で結果が揺れる。
- **c（別のサービス）**：チェックアウトの 1 段で関数を何度も呼ぶので、網の往復が p99 を押し上げる。
- **y（PostgreSQL）**：日本語の形態素の解析がなく、検索の負荷がポッドの書き込みの DB と同じ資源を取り合う。
- **z（自前）**：検索は「基本」の論点で、エンジンを自前で作る価値が小さい。順位付けとおすすめの規則は自前で持つ。

## Consequences

- 良くなること：
  - 他の題材と同じ道具で、エージェントと人が検証できる。
  - 注文・在庫・outbox を 1 つのトランザクションにでき、一回性と売り越しの防止が素直になる。
  - 関数の上限が燃料で決定的になる。
- 引き受けるコスト：
  - Rust の `function-runner` を持ち、2 つの言語になる。エージェントの eval に Rust のタスクを入れる。
  - OpenSearch の運用（索引の作り直し、容量）が増える。
  - パッケージの境界を lint で守り続ける手間が要る。

## Confirmation

- 依存の検査（CI）：本家の Liquid とその移植、本家の SDK・CLI を依存で禁止する。許す汎用の部品の一覧を持つ。
- lint：パッケージをまたぐ表の書き込みを禁止する。`eval`・`new Function`・`vm` の使用を禁止する（[ADR-0007](0007-theme-language-design.md)）。
- 設計の工程の最後の検証で、依存の一覧に本家の実装が核として入っていないことを確かめる。

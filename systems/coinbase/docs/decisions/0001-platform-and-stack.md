---
status: proposed
date: 2026-11-15
---

# ADR-0001: 共通の基盤を引き継ぎ、マッチングだけを Rust で EC2 に置く

## Context

rebuilds の他の題材で、次の基盤を決めている。

- AWS（東京、DR は大阪。ECS Fargate、Aurora PostgreSQL 18、ElastiCache Valkey、SQS・SNS、S3・CloudFront）
- TypeScript（Hono＋Zod）
- Terraform、OpenTelemetry、AWS AppConfig のフィーチャーフラグ、トランクベース開発
- FORCE RLS と `SET LOCAL`、UUIDv7、transactional outbox

この題材の主な論点（[architecture/README.md](../architecture/README.md)）は、板とマッチングエンジン、預かり資産の保管、台帳と分別管理、入出金、日本の法令である。性質は次のとおり。

- ほとんどは業務のアプリケーション（口座、入出金、販売所、運用の画面、コンプライアンスの案件）で、他の題材と同じ形である。
- マッチングエンジンは、1 つの板の入力を 1 つずつ順に処理する、小さく熱い経路である。注文の受け付け p99 20ms、エンジンの 1 入力 p99 100µs（NFR-001、NFR-002）を目標にする。遅れの裾（GC の停止、CPU の取り合い）が公正さと速さに効く。
- エンジンは決定的でなければならない（NFR-003）。同じ入力から同じ出力を出すことが、再生、写しのエンジン、監査の前提になる。
- 金額と数量は資産ごとの最小の単位の整数で、ETH の wei は 64 ビットに収まらない（ETH の総量は 10^26 wei の桁）。
- 本家の実装を核に使わない（[リポジトリ共通の ADR-0007](../../../../docs/decisions/0007-no-reuse-of-original-implementation.md)）。

## Options

マッチングの言語：

1. **TypeScript**（他のサービスと同じ）
2. **Go**（Uber の題材の熱い経路と同じ）
3. **Rust**
4. Java（JVM の上の単一スレッドのエンジン）

マッチングの実行基盤：

- a. ECS Fargate
- b. **ECS on EC2（専用のインスタンス、CPU の固定）**

DB の分け方：

- x. **core・ledger・kyc-vault の 3 クラスタ**
- y. core と ledger の 2 クラスタ（本人確認の書類を core の中の表と鍵で分ける）

## Decision

3、b、x を採用する。

### サービスの分け方

| サービス | 入口 | 言語・実行基盤 |
| --- | --- | --- |
| `app-api`、`trading-api`、`ws-gateway`、`ops-api` | アプリ・Web・API・運用の画面 | TypeScript、Fargate |
| `identity`、`order-gateway`、`ledger`、`brokerage`、`funding`、`wallet-orchestrator`、`compliance`、`surveillance` | 内部の API | 同上 |
| Worker（`ledger-poster`、`md-publisher`、`deposit-watcher`、`rebalancer`、`reconcilers`、`relay`） | MSK・SQS の消費者、定時の処理 | 同上 |
| `sequencer`、`engine-host`（`engine-core` を含む）、写しの `engine-host` | 板ごとの入力と出力 | Rust、ECS on EC2 |
| 署名の境界（`signer`） | 署名の依頼 | 言語は [ADR-0007](0007-signing-service-and-key-custody.md) の選定で決める（提供者の SDK に依る） |
| ノード | P2P と RPC | 汎用のクライアント、EC2（[ADR-0009](0009-deposits-confirmations-and-own-nodes.md)） |

- Rust のサービスは `sequencer` と `engine-host` の 2 つに限る。新しい Rust のサービスは ADR を要する。
- `engine-core` は I/O のない純粋な crate にし、`engine-host`（MSK の読み書き、スナップショット、計測）から呼ぶ。`engine-core` は `std` の時計・乱数・スレッド・`HashMap` の反復の順序を使わない（lint と依存の検査で落とす）。
- TypeScript と Rust の間の契約（入力と出力の記録の形）は、Protocol Buffers で 1 か所に書き、両方の型を生成する。金額は文字列にした整数で渡し、TypeScript は `bigint`、Rust は `i128`・`u128` で読む。
- マッチングの EC2 は、計算の最適化の型のインスタンスを板の組ごとに置き、エンジンのスレッドを CPU に固定する。S1 は 2 つの板に、本番 1 組と写し 1 組（別の AZ）。

### DB の分け方

| クラスタ | 表 | 書くパッケージ |
| --- | --- | --- |
| core | 口座、本人確認の状態、API キー、注文の記録（受け付けと状態の写し）、入金と出金の状態、宛先の許可の一覧、販売所の提示、コンプライアンスの案件、監査ログ、outbox | `identity`、`order-gateway`、`brokerage`、`funding`、`wallet-orchestrator`、`compliance`、`surveillance` |
| ledger | 口座、仕訳、仕訳の行、残高、拘束、冪等キー、照合の結果、outbox | `ledger` だけ（[ADR-0005](0005-ledger-balances-and-trade-settlement.md)） |
| kyc-vault | 氏名・住所・生年月日、本人確認の書類の参照、銀行の口座の番号 | `identity`、`funding`（読む関数は監査の行を書く） |

### 自前で作るもの（核）

| 用途 | 置き場所 | 理由 |
| --- | --- | --- |
| マッチングと sequencer | `crates/engine-core`、`crates/sequencer`、`crates/engine-host` | 題材の核（[ADR-0002](0002-sequencer-and-event-journal.md)、[ADR-0003](0003-matching-rules-and-self-trade-prevention.md)） |
| 注文の検査と拘束 | `packages/order-entry` | 題材の核（[ADR-0004](0004-order-entry-holds-and-idempotency.md)） |
| 台帳 | `packages/ledger` | 題材の核（[ADR-0005](0005-ledger-balances-and-trade-settlement.md)） |
| ウォレットの指揮、署名の方針 | `packages/wallet`、`packages/signing-policy` | 題材の核（[ADR-0006](0006-wallet-tiers-and-cold-ratio.md)、[ADR-0007](0007-signing-service-and-key-custody.md)） |
| 入出金の状態 | `packages/deposits`、`packages/withdrawals`、`packages/funding` | 題材の核（[ADR-0008](0008-withdrawal-pipeline-and-approvals.md)、[ADR-0009](0009-deposits-confirmations-and-own-nodes.md)） |
| 販売所の価格 | `packages/brokerage` | 題材の核（[ADR-0010](0010-brokerage-quotes-and-inventory.md)） |
| 監視の規則 | `packages/compliance-rules`、`packages/surveillance` | 判定は自前、点や一覧は提供者（[ADR-0011](0011-external-providers-boundary.md)） |

- **使ってよい第三者の汎用の部品**：Bitcoin Core、Ethereum の実行のクライアントと合意のクライアント、監査を受けた暗号のライブラリ（secp256k1 の署名、BIP32 の導出、Keccak）、アドレスと取引の符号化のライブラリ、Amazon MSK、Protocol Buffers、AWS の SDK、OpenTelemetry。どれも本家と関係がない。
- **外部のサービス**：HSM・MPC の提供者、提携銀行・信託銀行、eKYC、チェーン分析、トラベルルールの通知、参照の価格、メール・プッシュ。どれもアダプターの後ろに置く（[ADR-0011](0011-external-providers-boundary.md)）。
- **使わないもの**：本家のコード・SDK・API のクライアント、本家が作って公開したライブラリ・ツール（チェーンの道具、ウォレットの SDK を含む）、本家から取り出したデータ。

### 他の案を選ばなかった理由

- **1（TypeScript）**：V8 の GC と単一のイベントループで、1 入力 p99 100µs の裾を守るのが難しい。`bigint` の演算も遅い。
- **2（Go）**：コンパイルとテストが速く、エージェントの修正の往復が短い（Uber の題材が選んだ理由）。ただし GC の停止が裾に出る。決定性の面で、`map` の反復の順序が毎回変わることを、すべての書き手が避け続ける必要がある。128 ビットの整数が標準にない。S1 の規模だけなら足りるが、エンジンは小さく、言語の利点が誤りの種類を減らす側に効く。
- **4（Java）**：単一スレッドのエンジンの実績が多いが、JVM の調整（GC、JIT の温め）を持つことになり、他の題材にない運用が増える。
- **3 の代償**：コンパイルが遅く、所有権の制約で修正の往復が増える。これを、核を数千行の純粋な crate に閉じること、proptest と参照の実装（`engine-ref`）と再生の比べで誤りを機械で落とすこと、eval に Rust のタスクを入れることで引き受ける。
- **a（Fargate）**：CPU の固定ができず、隣のタスクとの取り合いで裾が伸びる。インスタンスの型を選べない。
- **y（2 クラスタ）**：本人確認の書類と口座の番号の読み出しの権限を、core を読むすべての役割から外すのが難しい。保存の期間の規則も分けにくい。

## Consequences

- 良くなること：
  - 業務のほとんどを、他の題材と同じ道具でエージェントと人が検証できる。
  - エンジンの遅れの裾を、GC と CPU の取り合いから切り離せる。
  - エンジンの決定性と整数の演算を、言語と lint で支えられる。
- 引き受けるコスト：
  - TypeScript と Rust の 2 つの言語、Fargate と EC2 の 2 つの実行基盤を持つ。
  - マッチングの EC2 のパッチと入れ替えを、板の停止の時間に合わせて行う（delivery の領域）。
  - Rust を書けるレビューの人が要る。

## Confirmation

- 依存の検査（CI）：本家のコード・SDK・公開のライブラリを依存で禁止する。許す汎用の部品の一覧を持つ。`engine-core` の依存を許可の一覧に限る。
- lint：`engine-core` で `std::time`・乱数・スレッド・`HashMap` の反復・浮動小数点の型を禁止する。パッケージをまたぐ表の書き込みを禁止する。
- Rust のサービスの数を、レビューで 2 つに保つ。

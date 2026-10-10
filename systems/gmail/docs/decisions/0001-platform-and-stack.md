---
status: accepted
date: 2026-10-10
---

# ADR-0001: 管理の面は共通の基盤（TypeScript・Hono、Aurora、Fargate）を引き継ぎ、MTA・選別・保存・検索・IMAP は Rust で書く。メールの送受信に SES を使わず、BYOIP の IP を持つ自前の MTA を EC2 で動かす。汎用の部品は一覧の範囲で使う

## Context

rebuilds の他の題材で、次の基盤を決めている。

- AWS（東京、DR は大阪。ECS Fargate、Aurora PostgreSQL 18、ElastiCache Valkey、SQS・SNS、S3・CloudFront）
- TypeScript（Hono＋Zod）
- Terraform、OpenTelemetry、AWS AppConfig のフィーチャーフラグ、トランクベース開発
- FORCE RLS と `SET LOCAL`、UUIDv7、transactional outbox

この題材の主な論点は、受信の SMTP、送信者の認証、送信の SMTP と評判、迷惑メールの選別、メールの保存、スレッド、検索、同期のプロトコルである（[intent.md](../intent.md)）。他の題材と違う点が 3 つある。

- **メールの面が量と接続の数で決まる。** S1 で受信の申し出 1.5 億通/日（ピーク 2,500 通/秒の受け付け）、IMAP の同時の接続 20 万を見込む（[architecture/README.md](../architecture/README.md) の 2 節）。MIME の解析と選別は、悪意のある入力を大量に処理する。
- **送信の IP と評判を自分で持つ必要がある。** メールの事業者は、送信の IP の評判、逆引き、フィードバックループ、ブロックリストの対応を自分で持たないと成り立たない。Google Calendar の題材は iMIP の送受信に Amazon SES を使う（[invitations-and-itip.md](../../../google-calendar/docs/architecture/invitations-and-itip.md) の 11 節）が、SES は送信の事業者であり、その IP と評判の方針の下でしか送れない。受信も、SMTP の時点での判定（[ADR-0002](0002-accept-then-filter.md)）を自分で持てない。
- **汎用の部品が多い分野である。** SMTP の構文、MIME の解析、マルウェアの署名の検出には、成熟した第三者の部品がある。核（MTA の待ち行列と配送、選別の判定、保存、スレッド、索引、同期）とその外を分ける線が要る（[リポジトリ共通の ADR-0007](../../../../docs/decisions/0007-no-reuse-of-original-implementation.md)）。

## Options

メールの面の言語：

1. **Rust（Tokio）**
2. Go
3. TypeScript（Node.js）で全部を書く

MTA の土台：

- a. **自前の MTA（SMTP の状態の機械、待ち行列、配送）を、BYOIP の IP を持つ EC2 で動かす**
- b. Amazon SES で送受信する
- c. 汎用の MTA（Postfix など）を動かし、周りに選別と保存を足す

## Decision

1 と a を採用する。

### 面の分け方

| 面 | 部品 | 言語・実行基盤 |
| --- | --- | --- |
| メールの面（固定の IP） | `mx-edge`、`mta-out` | Rust、ECS の EC2（ENI と BYOIP の Elastic IP） |
| メールの面（状態なし） | `inbound-pipeline`、`spam-scorer`、`content-scanner`、`outbound-gate`、`imap-server`、`submission` | Rust、Fargate（`content-scanner` はネットワークを持たないタスク） |
| 保存と検索 | `mailstore`、`blob-packer`、`search-indexer` | Rust、Fargate |
| 保存と検索（NVMe） | `search-node` | Rust、ECS の EC2（NVMe） |
| 管理の面 | `jmap-api`、`push-gateway`、`push-notifier`、`accounts`、`admin-api`、`relay` | TypeScript（Hono＋Zod）、Fargate。共通の基盤のまま |
| クライアント | Web、iOS、Android | React（TypeScript）、Swift、Kotlin |

- `mailstore` はメールボックスの状態の唯一の書き手で、gRPC の API を持つ。`jmap-api`（TypeScript）と `imap-server`（Rust）は、どちらも `mailstore` を呼ぶ。同じ状態の変更を 2 つの言語で書かない（[ADR-0006](0006-sync-protocol-jmap-imap-and-modseq.md)）。
- 検索の文法の構文解析と IR は Rust の `search-lang` に置き、`jmap-api` とフィルターの画面のために WASM でも配る。

### 自前で作るもの（核）

| 用途 | 置き場所 | 理由 |
| --- | --- | --- |
| SMTP の状態の機械、受信の判定、スプール、送信の待ち行列と配送、DSN | `crates/smtp-server`、`crates/mta-queue`、`crates/dsn` | 題材の核（[ADR-0002](0002-accept-then-filter.md)） |
| SPF・DKIM・DMARC・ARC の評価、DKIM の署名、ARC の封印 | `crates/mailauth` | 題材の核（sender-authentication の領域） |
| 選別の規則のエンジン、評判、特徴の作成、判定の合わせ | `crates/filter` | 題材の核（[ADR-0008](0008-spam-pipeline-boundary-and-secrecy.md)） |
| メッセージの保存（blob、パック、参照の数え）、メールボックスの状態、change log | `crates/mailstore` | 題材の核（[ADR-0003](0003-message-storage-layout-and-dedupe.md)、[ADR-0006](0006-sync-protocol-jmap-imap-and-modseq.md)） |
| スレッド化 | `crates/threading` | 題材の核（[ADR-0005](0005-threading-algorithm.md)） |
| 検索の索引と検索 | `crates/search-index`、`crates/search-lang` | 題材の核（[ADR-0009](0009-search-index-design.md)） |
| IMAP のサーバー、JMAP のメソッドの意味 | `crates/imap`、`packages/jmap` | 題材の核（[ADR-0006](0006-sync-protocol-jmap-imap-and-modseq.md)） |

### 使ってよい汎用の部品（一覧）

| 部品 | 範囲 | 条件 |
| --- | --- | --- |
| SMTP のコマンド・応答の構文のライブラリ | 行の解析と書式だけ | 状態の機械・判定・待ち行列は自前。使わずに自前で書いてもよい（小さいため） |
| MIME の解析のライブラリ | RFC 5322 のヘッダーと MIME の木の解析、文字コードの変換 | 自前の上限の層（大きさ、深さ、パートの数、時間）で包む。E4 の前の `mime-parser-poc` で選ぶ |
| 暗号（RSA、Ed25519、SHA-256）、TLS（rustls）、DNS の解決 | 署名と検証、TLS、DNS | DNSSEC の検証は Route 53 Resolver |
| マルウェアの署名の検出のエンジン（ClamAV の類）と YARA の形の規則 | 添付の既知のマルウェアの検出 | 隔離したタスクで動かす。判定の合わせは自前（attachment-and-url-scanning の領域） |
| ONNX Runtime | 分類器の推論 | モデルと特徴は自前 |
| 文字コードの変換（ICU の類）、zstd、Protobuf・gRPC、AWS の SDK、OpenTelemetry | 汎用 | — |

- **核に使わないもの**：汎用の MTA（Postfix、Exim、Haraka、Stalwart など）、汎用のメールのサーバー（Dovecot、Cyrus など）、汎用の迷惑メールの判定の製品（Rspamd、SpamAssassin など）を判定の本体に使うこと、汎用の検索のエンジン（OpenSearch など）。本家のコード、本家の IMAP の拡張の実装。
- 選別の規則のうち、公開の考え方（ヘッダーの形の異常など）を参考にするのはよい。規則の文書に出典を書く。

### MTA の実行基盤と IP

- 受信の MX と送信のプールの IP は、自社で持つ IP の範囲（IPv4 の /24 を複数、IPv6 の /48）を AWS の BYOIP で持ち込む。AWS の共有の範囲の評判に左右されないためと、事業者を移るときに評判を持ち出すためである。持ち込みの手続きの時間は `mx-throughput-poc` で確かめ、間に合わなければ、最初は AWS の Elastic IP（逆引きの設定と送信の制限の解除を申請）で始める。
- `mx-edge` は NLB（プロキシプロトコル v2 で送り手の IP を受ける）の後ろの EC2、`mta-out` は送信の IP を ENI の副の IP として持つ EC2 で動かす。Fargate はタスクに固定の送信元の IP を持たせられないため使わない。
- ポート 25 の送信の制限の解除と逆引きの設定は、AWS への申請が要る（infrastructure の領域）。

### 他の案を選ばなかった理由

- **2（Go）**：成り立つ。ただし MIME の解析と選別の CPU の効率、接続あたりのメモリー、他の題材（Datadog、Dropbox のデータの面）と同じ言語にそろえる点で Rust を選んだ。
- **3（TypeScript）**：20 万の IMAP の接続と、大量の悪意のある MIME の解析を、1 つのイベントループで安全に回すのが難しい。
- **b（SES）**：送信の IP と評判の方針、受信の SMTP の時点の判定、DSN の形を自分で持てない。メールの事業そのものを外の事業者に預けることになる。
- **c（汎用の MTA）**：題材の核（受信の判定、待ち行列、配送、評判）を設計しないことになる（リポジトリ共通の ADR-0007）。

## Consequences

- 良くなること：
  - 受信の判定、送信の評判、配送の振る舞いを、仕様と試験で自分で決められる。
  - 悪意のある入力の解析を、メモリー安全な言語で書ける。
  - 管理の面は他の題材と同じ道具で、エージェントと人が検証できる。
- 引き受けるコスト：
  - Rust と TypeScript の 2 つの言語を持つ。エージェントの eval に Rust のタスクを入れる。
  - IP の範囲の取得と BYOIP、逆引き、ブロックリストの対応、外部の事業者との関係（フィードバックループの登録）を運用する。
  - 固定の IP の要る部品の EC2 のキャパシティーを運用する。

## Confirmation

- 依存の検査（CI）：Rust と TypeScript の依存を、許す汎用の部品の一覧と照らす。汎用の MTA・メールのサーバー・迷惑メールの判定の製品・検索のエンジンを依存に入れたら失敗させる。
- lint：管理の面（TypeScript）で、メールボックスの表への直接の書き込み、`modseq` の計算、スレッド化の判定を書くコードを禁止する。`mailstore` の API を呼ぶだけにする。
- 試験：検索の文法の構文解析が、ネイティブと WASM で同じ IR を出す（試験のベクトル）。
- 設計の工程の最後の検証で、依存の一覧に本家の実装が核として入っていないことを確かめる。

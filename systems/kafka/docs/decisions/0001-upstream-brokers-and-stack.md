---
status: accepted
date: 2026-09-27
---

# ADR-0001: データ面は本家の Apache Kafka のブローカーを使い、差し込み口と最小のパッチで拡張する

## Context

この題材の価値の中心は、2 つある（[intent.md](../intent.md)）。

- 既存のクライアントがそのまま動くこと（プロトコルの互換）
- 受け付けた書き込みを失わず、トランザクションが本家と同じ意味で動くこと

ブローカーの作り方には、市場に 2 つの流れがある（いずれも 2026-09-27 に確認）。

| 流れ | 例 | 中身 |
| --- | --- | --- |
| 本家のブローカーを動かす | Confluent Cloud（Kora）、Amazon MSK、Aiven | 本家の Apache Kafka を土台に、階層型の保存・マルチテナント・運用の仕組みを足す。Kora の論文は、Kora の PKC が「普通の Kafka のクラスタのように見える」と書いている（[Kora](https://vldb.org/pvldb/vol16/p3822-povzner.pdf) の 3.1 節） |
| 互換のブローカーを自前で書く・保存層を差し替える | Redpanda（C++、Seastar、パーティションごとの Raft。[How Redpanda Works](https://docs.redpanda.com/streaming/current/get-started/architecture/)）、WarpStream（Go、状態を持たない Agent と S3。[WarpStream のブログ](https://www.warpstream.com/blog/the-art-of-being-lazy-log-lower-latency-and-higher-availability-with-delayed-sequencing)）、AutoMQ（本家の fork。保存層を S3Stream に差し替える。[AutoMQ](https://github.com/automq/automq)） | プロトコルを自前で実装するか、本家の保存層を置き換える |

自前で書く流れは、性能と費用で勝る余地がある。一方で、次の事実がある。

- 互換のブローカーでも、Jepsen の検証で安全性の問題が見つかっている。Redpanda 21.10 で 7 件の安全性の問題（[Jepsen: Redpanda 21.10.1](https://jepsen.io/analyses/redpanda-21.10.1)）、Bufstream 0.1.0 で健全なクラスタでの書き込みの喪失（[Jepsen: Bufstream 0.1.0](https://jepsen.io/analyses/bufstream-0.1.0)）。
- 本家のプロトコルは広い（数十の API と、それぞれの版）。トランザクション、2 つのグループのプロトコル（従来と KIP-848）、共有のグループ（KIP-932）と、意味の難しい機能が増え続けている。
- 本家の Apache Kafka は、4.0 で ZooKeeper を取り除き（KRaft だけ）、3.9 で階層型の保存（KIP-405）を本番向けにし、2026-03 に Diskless Topics（KIP-1150）を採択した。クラウドに向けた機能が、本家に入り始めている。

rebuilds の他の題材で、制御面の基盤（AWS の東京と大阪、TypeScript（Hono）、Aurora PostgreSQL 18、Terraform、OpenTelemetry）を決めている。

## Options

1. **本家の Apache Kafka のブローカーを動かす。** 本家の差し込み口で拡張し、差し込み口で作れないものだけを小さなパッチにする。拡張の言語は Java
2. **互換のブローカーを自前で書く（Rust）。** 保存層も最初から S3 を前提にする
3. **既存の互換の実装を土台にする**
   - 3a. AutoMQ（Apache License 2.0 の本家の fork）
   - 3b. Redpanda（ソースは公開されているが、BSL 1.1 で、第三者にトピックを作らせる商用の「Streaming or Queuing Service」への利用を除外している（[Redpanda の BSL](https://github.com/redpanda-data/redpanda/blob/dev/licenses/bsl.md)、2026-09-27 に確認）。解釈は法務の確認待ち（intent.md の L3））

## Decision

1 を採用する。

### 理由

- **正しさを本家から得る。** 複製、ISR、トランザクション、グループの意味は、本家の実装そのものが事実上の仕様である。自前で書くと、プロトコルの互換と意味の互換の両方を、小さなチームとエージェントで検証し続けることになる。この題材で最も重い要件（受け付けた書き込みを失わない）に対し、最も検証された実装を使う。
- **互換性の範囲が自明になる。** 互換の範囲は「動かしている本家の版が ApiVersions で広告するもの」から、管理の API を除いたものになる（[ADR-0005](0005-compatibility-policy.md)）。
- **クラウド向けの差分は、本家に入りつつある。** 階層型の保存は本家で使える。ディスクレスは本家で採択された。2 の最大の利点（S3 を正本にする保存）は、本家の実装を待つか、S2 で改めて判断する（[ADR-0002](0002-replicated-log-with-tiered-storage.md)）。
- 2 は、性能・費用・言語の安全性で勝る。ただし、互換の面が広く、耐久性の検証を一から積み上げる必要がある。MVP の段階では、リスクに見合わない。
- 3a は、保存層を差し替えた fork で、本家の版への追従を AutoMQ に依存する。3b は、ライセンスの制約が SaaS に合わない見込みである。

### 拡張の方針

| 必要なこと | 作り方 |
| --- | --- |
| API キーの認証 | SASL/PLAIN のサーバーのコールバック（本家の差し込み口）で、制御面が発行した API キーを確かめる |
| テナントの識別 | KafkaPrincipalBuilder で、主体（principal）に論理クラスタの ID を持たせる |
| ACL | 本家の StandardAuthorizer（KRaft）を TenantAuthorizer で包み、論理クラスタの境界を二重に確かめる（[ADR-0029](0029-tenant-scoped-acls-and-rbac.md)） |
| クォータ | ClientQuotaCallback でテナントの単位のクォータを掛ける。値は、物理クラスタごとにデータ面に置くクォータのコーディネーターが配る（[ADR-0027](0027-dynamic-quota-coordinator-and-backpressure.md)） |
| トピックの設定の制限 | CreateTopicPolicy・AlterConfigPolicy で、許可した設定と範囲だけを通す |
| 階層型の保存 | RemoteStorageManager（S3。Aiven の Apache License 2.0 の実装を土台にし、テナントの検査と計数の層で包む。[ADR-0018](0018-s3-remote-storage-manager.md)）と RemoteLogMetadataManager（本家の既定のトピックの方式） |
| テナントの名前空間 | 差し込み口では作れない。ブローカーの小さなパッチにする（[ADR-0004](0004-logical-clusters-on-shared-physical-clusters.md)、[ADR-0025](0025-tenant-namespace-patch.md)） |

- パッチは、開発リポジトリの 1 つのディレクトリに、パッチごとの理由と関連する KIP を付けて置く。本家の新しいマイナー版が出たら当て直し、互換性と耐久性のテストを通す。
- 本家の版は、最新のマイナー版から 2 つ以上遅らせない。取り込みの手順と関門は [ADR-0008](0008-client-matrix-differential-tests-and-version-tracking.md) と [ADR-0050](0050-rolling-upgrade-gates-and-upstream-tracking.md)。

### 言語と技術

| 層 | 選定 |
| --- | --- |
| ブローカーの拡張とパッチ | Java 21（本家に合わせる。Kotlin は使わない。本家へ提案しやすくし、ビルドを 1 つにする） |
| 制御面、コンソールのバックエンド | TypeScript（Hono＋Zod）。他の題材と同じ |
| データ面のエージェント、クォータのコーディネーター | Java 21 と本家の AdminClient（[ADR-0031](0031-control-plane-reconciliation-and-agent.md)） |
| CLI、Terraform のプロバイダー、sni-router | Go（Terraform Plugin Framework が Go のため） |
| SNI のプロキシ | Envoy（自前のコードを書かない） |
| 実行基盤 | AWS の東京（災害復旧は大阪）。データ面は EKS（EC2、EBS）。制御面は ECS Fargate、Aurora PostgreSQL 18、SQS |
| IaC・可観測性 | Terraform、OpenTelemetry |

- データ面のエージェントは Java 21 で書き、本家の AdminClient を使う（[ADR-0031](0031-control-plane-reconciliation-and-agent.md)）。KafkaJS は保守が止まり（最後の版は 2023-02）、confluent-kafka-javascript の管理のクライアントは ACL と設定の変更の API を持たないため（[ADR-0008](0008-client-matrix-differential-tests-and-version-tracking.md)）。望ましい状態のスキーマの正本は制御面の Zod で、CI で JSON Schema を出し、Java の型を生成する。

## Consequences

- 良くなること：
  - プロトコルと意味の互換を、本家の実装から得られる。互換性のテストは「本家と同じか」を確かめる差分テストにできる。
  - 本家の新しい機能（共有のグループ、ディスクレス）を、版の更新で取り込める。
- 引き受けるコスト：
  - 本家のブローカーの性能の特性（JVM、ページキャッシュ、パーティションあたりの資源）を引き受ける。Redpanda・WarpStream のような費用の下げ方は、S2 以降のディスクレスのトピックまで取れない。
  - テナントの名前空間のパッチを、本家の版ごとに当て直す手間がかかる。
  - 言語が 4 つになる（Java、TypeScript、Go、Envoy の設定）。エージェントの作業は、領域ごとに言語が決まるように分ける。

## Confirmation

- CI：本家のパッチを当てたブローカーと、パッチなしの本家のブローカーの両方で、互換性の行列と差分テストを回す（[ADR-0005](0005-compatibility-policy.md)）。
- CI：パッチの行数と対象のファイルを毎回出力し、増えたときはレビューで理由を確かめる。
- レビュー：本家のコードの変更を含む PR は、パッチの一覧の更新と ADR の参照がないとマージしない。

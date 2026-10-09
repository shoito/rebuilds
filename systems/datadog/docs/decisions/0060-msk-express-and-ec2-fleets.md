---
status: accepted
date: 2026-10-09
---

# ADR-0060: MSK は Express のブローカーにし、S1 は `express.m7g.8xlarge` × 12（3 AZ）で、消費者は同じ AZ の写しから読む。状態を持つ部品は、部品ごとの EC2 のキャパシティープロバイダー（`r7gd`・`i4i`・`c7gd`・`c7g`）に 1 インスタンス 1 タスクで置き、AZ ごとに予備を 1 台持つ。インジェスターの 2 つの写しは別の AZ

## Context

- MSK のブローカーの構成とパーティションの数は `msk-throughput-poc` で決める前提で、ピークの 2 倍の余裕を持つ（[ADR-0002](0002-intake-log-on-msk.md)）。S1 の書き込みのピークは圧縮の後で 約 1.1 GB/秒と見込む（[capacity.md](../architecture/capacity.md) の 2 節）。
- MSK のブローカーには Standard と Express がある。Express は、Standard の 3 倍までの書き込み（`m7g.16xlarge` で 500 MB/秒 対 153.8 MB/秒）、ストレージの管理なし、速い広げと再配置を持ち、3 AZ だけで、パーティションあたり 15 MB/秒の上限がある（[Amazon MSK Express brokers](https://docs.aws.amazon.com/msk/latest/developerguide/msk-broker-types-express.html)、[Amazon MSK quota](https://docs.aws.amazon.com/msk/latest/developerguide/limits.html)、2026-10-09 に確認）。東京の価格は `express.m7g.8xlarge` 8.432 USD/時、書き込み 0.015 USD/GB、保存 0.12 USD/GB・月（AWS Price List API の `AmazonMSK`、同日に取得）。
- ブローカーの間の複製の転送は課金されないが、クライアントの出入りは通常のデータ転送の料金（[Amazon MSK pricing](https://aws.amazon.com/msk/pricing/)、同日に確認）。AZ をまたぐ読み出しは 0.01 USD/GB を両側で課金する。
- 状態を持つ部品は EC2（NVMe）に置く（[ADR-0001](0001-platform-and-stack.md)）。インジェスターは系列あたりのメモリー（`ingester-memory-poc`）、読み手は NVMe のキャッシュ、インデクサーと合わせは CPU が効く。インジェスターは 2 つの写しを別の AZ に置く（[ADR-0004](0004-tsdb-storage-engine.md)）。
- デプロイでは、新しいタスクを先に起こしてから古いものを止める（[delivery.md](../architecture/delivery.md) の 4 節）。そのための空きが要る。

## Options

MSK：

1. **Express のブローカー**
2. Standard のブローカー（`kafka.m7g.16xlarge` と EBS）
3. MSK Serverless

EC2：

- a. **部品ごとのキャパシティープロバイダー、1 インスタンス 1 タスク、AZ ごとの予備**
- b. 1 つの大きな群れに部品を混ぜて置く（ECS の配置に任せる）

## Decision

1 と a を採用する。

- MSK：`express.m7g.8xlarge` × 12（AZ ごとに 4）。12 台で書き込み 3.0 GB/秒、AZ を失って 2.0 GB/秒。パーティションは写しを含めて 約 8,200（ブローカーあたり 約 690、勧めの値 12,000）。組織のパーティションの組の大きさ `k` は、組織の割り当て ÷ 5 MB/秒 以上にする。消費者は `client.rack` で同じ AZ の写しから読む。Kafka のトランザクションとラックを意識した読み出しが Express で動くことを `msk-throughput-poc` で確かめ、動かなければこの ADR を見直す。

> 2026-10-09 の注記：統合の工程で AWS の資料を確かめた。Express のブローカーは、トランザクションの状態のトピックの `min.insync.replicas` を 2 に固定し、`transaction.max.timeout.ms`・`transactional.id.expiration.ms` を変えられる。`replica.selector.class` に `RackAwareReplicaSelector` を設定でき、`broker.rack` は AZ の ID（[Express broker configurations](https://docs.aws.amazon.com/msk/latest/developerguide/msk-configuration-express-read-write.html)、[read-only configurations](https://docs.aws.amazon.com/msk/latest/developerguide/msk-configuration-express-read-only.html)、2026-10-09 に確認）。どちらも設定として使えるので、「動くか」は未検証から外した。PoC で確かめるのは、S1 の量での遅れと費用だけにする。トランザクションを使うのは `log-processor` だけ（[ADR-0002](0002-intake-log-on-msk.md) の注記）。

- EC2 の群れ（S1、初期見積もり）：

| 群れ | 部品 | インスタンス | 台数 |
| --- | --- | --- | --- |
| `fleet-ingest` | `metrics-ingester` | `r7gd.4xlarge` | 16 の組（各 `metrics` のパーティション 64）× 2 |
| `fleet-assemble` | `trace-assembler` | `r7gd.4xlarge` | 6 |
| `fleet-mreader` | メトリクスの `query-reader`（ダッシュボードの組・評価の組） | `r7gd.8xlarge` | 6＋3 |
| `fleet-lsearch` | ログとトレースの `log-searcher` | `i4i.8xlarge` | 12 |
| `fleet-index` | `log-indexer`、`compactor` | `c7gd.8xlarge` | 6＋4 |
| `fleet-eval` | `monitor-evaluator` | `c7g.4xlarge` | 6 |

> 2026-10-09 の注記：統合の工程で、`derived-metrics-aggregator`（[ADR-0032](0032-index-routing-and-derived-metrics.md)。系列ごとの桶を 65 分持つ状態の部品）の群れ `fleet-derive`（`r7gd.2xlarge` × 3、AZ ごとに 1）を足した。`slo-calculator` は `fleet-eval` の中で動く（[ADR-0049](0049-slo-computation-and-burn-rate.md)）。状態を持たない `live-tail`・`rehydrator`・`deletion-worker`・`limits-coordinator` は Fargate に置く（[infrastructure.md](../architecture/infrastructure.md) の 3 節、[capacity.md](../architecture/capacity.md) の 4 節）。

- どの群れも AZ ごとに予備を 1 台持つ。インジェスターの組 `g` の写し A は AZ `g mod 3`、B は `(g+1) mod 3`。組の中のパーティションごとのシャード（1 スレッド）は [tsdb-storage-engine.md](../architecture/tsdb-storage-engine.md) の 3.3 節。
- インジェスターは、系列あたり 3 KB（見込み）で 1 インスタンスあたり 625 万系列 ≈ 19 GB を持つ。`ingester-memory-poc` で系列あたりが 10 KB になっても、128 GiB の 60% に収まる大きさを選んだ。

### 他の案を選ばなかった理由

- **2（Standard）**：同じ書き込みに、ブローカーの数が 2〜3 倍要る。EBS の大きさとスループットの管理、広げたときの再配置の遅さが、障害の日の急増と S2 の拡張に合わない。保持 24 時間・複製 3 の EBS の容量の見積もりも要る。
- **3（Serverless）**：クラスタあたりの書き込み 200 MB/秒の上限が S1 に足りない（[Amazon MSK quota](https://docs.aws.amazon.com/msk/latest/developerguide/limits.html)）。
- **b（混ぜる）**：メモリーと NVMe の取り合いで、インジェスターのメモリーの見積もりが崩れる。1 つの部品のデプロイが他の部品のタスクを動かす。

## Consequences

- 良くなること：
  - MSK のストレージの管理がなく、広げるのが速い。
  - 部品ごとにインスタンスを選び、メモリー・NVMe・CPU の見積もりを部品ごとに確かめられる。
  - 予備で、デプロイとインスタンスの障害の置き換えを容量の取り合いなしに行える。
- 引き受けるコスト：
  - Express は書き込みのバイトに料金がかかる（S1 で月 約 1.9 万 USD）。
  - 予備のインスタンス（群れごとに 3 台）の費用。
  - Express の振る舞い（トランザクション、ラックを意識した読み出し）を PoC で確かめるまで、この構成は仮。

## Confirmation

- `msk-throughput-poc`：S1 のピークの 2 倍の書き込みで 202 の p99 が NFR-001 の中。AZ を 1 つ止めても書き込みが続く。トランザクションとラックを意識した読み出しが動く。
- `ingester-memory-poc`：系列あたりのメモリーを測り、1 インスタンスの系列の上限を決める。
- 月次のキャパシティのレビューで、群れごとの使用率（平常 2/3 以下）を見る。

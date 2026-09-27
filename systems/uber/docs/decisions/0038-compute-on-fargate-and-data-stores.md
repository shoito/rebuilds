---
status: accepted
date: 2026-09-27
---

# ADR-0038: Go の熱い経路と Valhalla は ECS Fargate（ARM64）で動かし、Aurora は乗車の群れとお金の群れの 2 つのクラスタに分け、リースの表はリージョンごとに持つ

詳細は [infrastructure.md](../architecture/infrastructure.md) の 3・6 節。

## Context

[ADR-0001](0001-platform-and-stack.md) は、実行基盤を ECS Fargate と決め、位置の取り込み・索引・配車を Go で書くと決めた。その後、常時の接続の受け手（`rt-gateway`、[ADR-0030](0030-realtime-grpc-bidirectional-stream-gateway.md)）も Go になった。この領域では次を決める。

- Go の熱い経路を Fargate で動かすか、ECS on EC2 にするか。
- メモリを多く使う Valhalla（日本全体のタイルを読む）をどこで動かすか。
- Aurora のクラスタをいくつにするか。
- 索引と配車のリース（[ADR-0011](0011-geo-index-sharding-lease-and-rebuild.md)）の DynamoDB の表を、大阪へ複製するか。

事実（2026-09-27 に確認）：

- Fargate の Linux のタスクは、ARM64 を使え、最大 16 vCPU・120 GB、32 vCPU では 60・120・244 GB を選べる（[Task definition differences for Fargate](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-tasks-services.html)）。
- 東京の単価（AWS の Price List API、2026-09 の公開分）：Fargate ARM64 は vCPU 時 0.04045 USD、GB 時 0.00442 USD。EC2 の `r8g.xlarge`（4 vCPU・32 GiB）は 0.284 USD、`m8g.xlarge`（4 vCPU・16 GiB）は 0.232 USD。
- Valhalla は、タイルの tar を mmap で読み、同じプロセスのスレッドで共有する。ドイツのタイルの tar は約 4.6 GB という利用者の報告がある（[Valhalla の Discussion #4816](https://github.com/valhalla/valhalla/discussions/4816)、2024-07-25）。日本のタイルの大きさは **未検証**（E4 の `valhalla-pool-fargate` で計る。日本の OSM の抽出は約 2.5 GB。[maps-and-geodata.md](../architecture/maps-and-geodata.md)）。

## Options

### 計算

1. **すべて Fargate（ARM64）**
2. **Go の熱い経路と Valhalla は ECS on EC2（メモリ最適化のインスタンス）、他は Fargate**
3. **Valhalla だけ ECS on EC2**

### Aurora

- a. **1 つのクラスタ**
- b. **乗車の群れ（`core`：Trips、供給、運賃、地図、安全、サポート）とお金の群れ（`money`：支払い、台帳、精算）の 2 つ**
- c. **領域ごとのクラスタ**

## Decision

計算は 1、Aurora は b を採用する。リースの表はリージョンごとにする。

- **Go のサービス**（[ADR-0001](0001-platform-and-stack.md) の 6 つ：loc-ingest、geo-index、dispatch、eta-service、rt-gateway、trip-location-fanout）と付随の役（trail-builder、dispatch-shadow）は Fargate の ARM64。`GOMEMLIMIT` をタスクのメモリの 80% にし、GC の停止と OOM の余裕を持たせる。
- **Valhalla** は Fargate の ARM64 の 4 vCPU・16 GB から始め、ETA 用と当てはめ用の組を分ける（[ADR-0016](0016-valhalla-serving-traffic-and-eta-accuracy.md)）。タイルの tar は起動のときに S3 から一時の記憶域（50 GiB に設定）へ取る。起動の時間は **未検証**（E4 の `valhalla-pool-fargate` で計る）。起動が遅いので、ETA 用は平常のピークの 2 倍の台数を常に持ち、催しの前に予定で広げる（[ADR-0041](0041-load-model-admission-control-and-prescaling.md)）。
- **ECS on EC2 の見直しの条件**：Valhalla のタスクが 40 を超えるか、起動の時間が 5 分を超えて予定の拡大で間に合わないとき。EC2 ならインスタンスのページキャッシュで複数のタスクがタイルを共有でき、ウォームプールで起動を早められる。見直すときは ADR を書く。
- **Aurora `core`**：Trips と供給は同じクラスタに置く。Trips の提案の検査が、供給の判定の表を同じトランザクションで読むため（[ADR-0026](0026-supply-registry-and-document-verification.md)）。
- **Aurora `money`**：支払いの状態と台帳の仕訳を同じトランザクションで書く（[ADR-0025](0025-ledger-settlement-and-reconciliation.md)）。乗車の群れとの間は outbox の事象だけでつなぎ、2 つのクラスタをまたぐトランザクションを書かない。
- どちらも PostgreSQL 18、I/O-Optimized、writer 1＋reader 1（別の AZ）、Global Database で大阪に reader 1。
- **Valkey** は 2 つのクラスタ：`rt`（常時の接続の Stream・登録表・Pub/Sub。クラスタモードを使わない）と `cache`（レート制限、需給の集計、見積もりのキャッシュ）。Figma の題材が、Pub/Sub をクラスタモードに移して障害を起こした教訓による（[Figma の infrastructure.md](../../../figma/docs/architecture/infrastructure.md) の 6 節）。
- **DynamoDB `geo_shard_leases`** はリージョンごとにし、グローバルテーブルにしない。リースはリージョンの中のタスクの事実で、大阪に複製しても使わない。大阪へ切り替えたときは、大阪の空の表から取り直す。
- 2 を採らない理由：S1 の Go のタスクは合わせて 40 vCPU 程度で、EC2 にしても費用の差が小さい。AMI の更新とインスタンスのドレインを持つ手間に見合わない。Fargate の Compute Savings Plans も使える。
- 3 を今は採らない理由：S1 の Valhalla は 10 タスク程度。上の見直しの条件で判断する。
- a を採らない理由：台帳の書き込みと、乗車の熱い書き込みが、同じ writer の資源を取り合う。お金の群れの権限と監査を分けにくい。
- c を採らない理由：Trips と供給を分けると、提案の検査が 2 つの DB をまたぐ。

## Consequences

- 良くなること：
  - ホストを持たずに、すべてのサービスを同じ仕組みで配備できる。
  - お金の群れの障害・保守が、配車の熱い経路に響きにくい。
- 引き受けるコスト：
  - Valhalla のタスクごとにタイルを読み込むので、メモリと起動の時間が台数に比例する。
  - Aurora のクラスタが 2 つになり、Global Database と切り替えの手順が 2 倍になる。
  - `core` と `money` の食い違い（乗車は完了、支払いは未確定）を、照合のジョブで見る。

## Confirmation

- E3・E4 の負荷試験：Fargate の Go のタスクで、位置 5,000 件/秒のときの索引への反映の p99 と GC の停止（ADR-0001 の Confirmation）、Valhalla のタスクの起動の時間とメモリを計り、[capacity.md](../architecture/capacity.md) の値を置き換える。
- レビュー：`core` と `money` をまたぐトランザクション、`geo_shard_leases` をグローバルテーブルにする Terraform を差し戻す。

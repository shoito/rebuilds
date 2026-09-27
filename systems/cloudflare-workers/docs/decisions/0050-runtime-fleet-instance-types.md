---
status: accepted
date: 2026-09-27
---

# ADR-0050: テナントのコードを動かすノードは、ゲストに性能カウンターを見せる Intel の c7i・m7i の大きさにし、自前の部品はすべて x86-64 で動かす

詳細は [infrastructure.md](../architecture/infrastructure.md) の 4 節と [capacity.md](../architecture/capacity.md) の 3〜5 節。

## Context

ランタイムのノードには、次の約束がある。

- x86-64 にする（MPK・PKU を使えるように。[ADR-0010](0010-process-sandbox-and-egress-invariants.md)）。
- ゲストからハードウェアの性能カウンター（LLC のミス、分岐の予測の失敗）を使える型・大きさにする。使えない型は本番に入れない（[ADR-0013](0013-spectre-mitigations-and-dynamic-isolation.md)）。

確かめたこと（2026-09-27）：

- Intel は、AWS のインスタンスで PMU の事象を使えるのは「1 つか 2 つのソケットを丸ごと使う大きさ」だけとする。一覧に c5.9xlarge 以上、c6i.16xlarge・32xlarge、c7i.12xlarge・24xlarge・48xlarge、m7i.12xlarge・24xlarge・48xlarge、各 metal などがある。m5.16xlarge は 1 つのソケットと 2 つ目の一部を使うので PMU の事象を使えない。metal は、メモリのアクセスの解析に使う uncore の事象も含めて使える（[Intel VTune Profiler Functionality on AWS Instances](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-vtune-amplifier-functionality-on-aws-instances.html)、2025-02-19 更新、2026-09-27 に確認）。AWS の公式の文書での一覧は見つけられなかった（未検証。E1 の `instance-pmu-pku-check` で実機で確かめる）。
- 大阪（ap-northeast-3）では、c6id・m6id などのローカルの NVMe を持つ第 6 世代の Intel の型が提供されていない。AMD の c7a・c8a も大阪で提供されていない（東京は 3 つの AZ で提供）。c7i.24xlarge・m7i.24xlarge・i4i は 5 つのリージョンのすべての AZ で提供されている（`describe-instance-type-offerings`、2026-09-27 に確認）。
- 東京の定価：c7i.large 0.11235 ドル/時、c7a.24xlarge 6.2016 ドル/時、c8a.24xlarge 6.51168 ドル/時、c7g.2xlarge 0.3638 ドル/時（価格表の API、2026-09-27 に確認）。
- 東京の定価（AWS の価格表の API）：c7i.24xlarge（96 vCPU、192 GiB）5.3928 ドル/時、c7i.metal-24xl も同じ、m7i.24xlarge（384 GiB）6.2496 ドル/時、c6i.16xlarge（64 vCPU）3.424 ドル/時。
- 本家の第 12 世代のサーバーは AMD EPYC 9684X（96 コア、L3 1,152MB）、384GB、NVMe 16TB で、大きな L3 が本家の作業に効くとしている（[Gen 12 servers](https://blog.cloudflare.com/gen-12-servers/)、2024-09-25）。第 13 世代は 192 コアでコアあたりの L3 を 2MB に減らし、要求の処理の層を Rust で書き直してキャッシュへの依存を減らした（[Gen 13 launch](https://blog.cloudflare.com/gen13-launch/)、2026-03-23）。どちらも 2026-09-27 に確認した。

## Options

1. **エッジのノード c7i.24xlarge（東京・大阪）と c7i.12xlarge（海外）、DO のホスト m7i.12xlarge。ディスクは gp3。テナントのコードを動かさない部品も x86-64**
2. c7i.metal-24xl（uncore の事象まで使える）
3. c6id.16xlarge（ローカルの NVMe あり）
4. AMD の型（c7a など）

## Decision

1 を採用する。

| 群 | 型 | 置く場所 | 理由 |
| --- | --- | --- | --- |
| エッジのノード（大） | c7i.24xlarge（96 vCPU、192 GiB） | 東京・大阪 | ソケット全体で PMU。国内の全量を 1 リージョンで受ける台数の単位 |
| エッジのノード（小） | c7i.12xlarge（48 vCPU、96 GiB） | 海外 3 リージョン | Intel の一覧で PMU あり。S1 の海外の量に対して、AZ ごとに 1 台以上を置ける単位 |
| DO のホスト | m7i.12xlarge（48 vCPU、192 GiB） | 5 リージョン | テナントのコードを動かすので同じ約束。実体のメモリのため m |
| DO のログのノード | i4i.2xlarge（NVMe 1,875 GB） | 5 リージョン | テナントのコードを動かさない。グループの fsync のためにローカルの NVMe |
| 中継 | m7i.xlarge ＋ gp3 300 GB | 5 リージョン × 3 | 7 日のログとバンドルのキャッシュ 200 GB |
| 専用のリゾルバー | c7i.large | 5 リージョン × 2 | |
| `c3-dedicated` の専用のノード | c7i.metal-24xl | 契約ごと | ホストを分ける契約。uncore の事象まで使える |

- ディスク：ノードの LMDB（`mapsize` 16 GiB）とコードのキャッシュは gp3（200 GB、3,000 IOPS）。よく使うバンドルはページキャッシュに乗る（192 GiB の 16 GiB をページキャッシュの予算にする。capacity.md の 4 節）。runtime-and-isolates と durable-objects の「ローカルの NVMe」は、この ADR で gp3 に改める（DO の手元の SQLite はキャッシュで、正本はログのノードと S3）。
- 起動の検査：スーパーバイザーは起動時に `perf_event_open` で LLC のミスと分岐の予測の失敗の事象を開き、値が進むことを確かめる。開けなければノードを健全にしない（[sandbox-and-security.md](../architecture/sandbox-and-security.md) の 10 節）。PKU（`pku` の CPU のフラグ）も確かめる。
- 自前の部品（Rust）とノードの AMI は x86-64 だけにする。arm64 は、マネージドのサービス（ElastiCache の r7g）にだけ使う。
- AMI：Amazon Linux 2023 の最小の構成から作る。カーネルの重大な修正（名前空間、seccomp、cgroup、KVM のゲストに関わるもの）は、公開から 72 時間以内に全ノードの AMI を入れ替える（[delivery.md](../architecture/delivery.md) の 6 節）。
- Auto Scaling グループは AZ ごと。起動を速くするため、止めた状態のインスタンスの予備（warm pool）を AZ ごとに 1 台持つ。
- 2 を採らない理由：c7i.24xlarge と同じ値段だが、metal は起動が遅い（程度は測っていない。採らない案なので測らない）。検知に要る事象はコアの事象で足りる（ADR-0013 の LLC のミスと分岐の予測の失敗。uncore は要らない）。
- 3 を採らない理由：大阪で提供されていない（上の確認）。大阪で使えないので、PMU の可否は確かめない。
- 4 を採らない理由：c7a・c8a は大阪で提供されておらず、東京の定価も c7i.24xlarge（5.3928 ドル/時）より 15〜21% 高い（上の確認）。Intel の一覧のような、AMD の型の PMU の条件の資料も見つけられなかった（未検証）。E1 の `instance-pmu-pku-check` で東京の c7a・c8a の PMU と PKU も確かめるが、大阪で提供されるまでは採らない。

## Consequences

- 良くなること：
  - 5 つのリージョンで同じ族の型を使え、PMU と PKU の約束を満たす。
  - 1 つの族なので、性能の計測と AMI を共有できる。
- 引き受けるコスト：
  - 最小の単位が大きい（48 vCPU）。海外のリージョンの台数を減らせず、S1 の利用率は低い（capacity.md の 6 節）。
  - Graviton の価格の利点を捨てる（c7g.2xlarge は 0.3638 ドル/時で、vCPU あたりで c7i.24xlarge の 0.0562 ドルより約 19% 安い。Graviton の vCPU は物理のコア（c7g.2xlarge は 8 vCPU・8 コア・コアあたり 1 スレッド。[CPU options](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/cpu-options-supported-instances-values.html)、2026-09-27 に確認）なので、実際の差はさらに大きい見込み（性能の差は測っていない））。
  - PMU の可否を Intel の資料に頼っている。E1 の最初に実機で確かめる。

## Confirmation

- E1：5 つのリージョンの c7i.24xlarge・c7i.12xlarge・m7i.12xlarge で `perf stat -e LLC-load-misses,branch-misses` が値を返し、`pku` のフラグがあることを確かめ、記録する。
- ノードの起動時の検査（PMU・PKU・IMDSv2・seccomp）が失敗したノードが NLB に入らないことの結合テスト。
- 半期ごとに、新しい世代（c8i、AMD）の PMU と費用を見直す。

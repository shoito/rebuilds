---
status: accepted
date: 2026-09-27
---

# ADR-0017: 物理クラスタのパーティションと、ブローカーの複製に上限を置き、スナップショットは本家の既定で実測して見直す

詳細は [metadata-and-control.md](../architecture/metadata-and-control.md) の 6 節。

## Context

KRaft のメタデータの量は、コントローラーの切り替えの時間、ブローカーの起動の時間、スナップショットの大きさを決める。共有の物理クラスタには多数の論理クラスタが載り（[ADR-0004](0004-logical-clusters-on-shared-physical-clusters.md)）、テナントがトピック・パーティション・ACL を作れる。S1 の全体の目標は 20 万のパーティション（複製の前）、物理クラスタは 10 以下（[architecture/README.md](../architecture/README.md) の 2 節）。

事実（2026-09-27 に確認）：

- 本家の既定：`metadata.log.max.record.bytes.between.snapshots` 20 MiB、`metadata.log.max.snapshot.interval.ms` 1 時間、`metadata.max.retention.bytes` 100 MiB、`metadata.max.retention.ms` 7 日（[Broker Configs](https://kafka.apache.org/43/configuration/broker-configs/)）。
- 4.3 で、KRaft の取得とスナップショットの取得の大きさの設定が入った（KIP-1219。[4.3.0 の発表](https://kafka.apache.org/blog/2026/05/22/apache-kafka-4.3.0-release-announcement/)）。
- 本家の文書は、5 万のパーティションで 10 万の mmap になり、既定の OS の上限でブローカーが落ちうると書く（[Hardware and OS](https://kafka.apache.org/43/operations/hardware-and-os/)）。
- 1 つのパーティションの記録の大きさは、本家のスキーマから約 150 バイトと見積もった（未検証）。

## Options

1. **上限を置かない。物理クラスタが重くなったら、新しい論理クラスタを他に置く**
2. **物理クラスタのパーティションとブローカーの複製に上限を置き、配置とポリシーで守る**

## Decision

2 を採用する。

- 物理クラスタのパーティション（複製の前）は 10 万まで、ブローカーの複製は 4,000 まで（仮）。論理クラスタの ACL は Basic 1,000・Standard 10,000 まで（[ADR-0029](0029-tenant-scoped-acls-and-rbac.md)）。パーティションの作成・削除の頻度は、テナントごとの制御の変更のクォータで抑える。
- 目標：コントローラーの切り替え 5 秒以内、ブローカーの起動のメタデータの読み込み 30 秒以内。E1 の PoC で上限の値を測って見直す。
- スナップショットと保持の設定は本家の既定のまま。KIP-1219 の設定は、スナップショットが 100 MB を超える物理クラスタで見直す。
- 1 は、1 つのテナントの大量の作成で、同じ物理クラスタの全てのテナントの切り替えと起動が遅くなる。

## Consequences

- 良くなること：
  - コントローラーの切り替えとブローカーの起動の時間に上限ができる。
  - 1 つのテナントのメタデータの膨張が、他に及ぶ前に止まる。
- 引き受けるコスト：
  - 大きな論理クラスタは、1 つの物理クラスタの上限に縛られる（ADR-0003 の A の制約と同じ）。
  - 上限に当たったテナントには、パーティションの作成の拒否として見える。エラーと文書で説明する。

## Confirmation

- PoC：上限の値で、切り替えと起動の時間、スナップショットの大きさを実測する。
- ポリシーのテスト：上限を超える CreateTopics・CreatePartitions が拒否される。
- 監視：物理クラスタごとのパーティションの数、ブローカーごとの複製の数、スナップショットの大きさ。

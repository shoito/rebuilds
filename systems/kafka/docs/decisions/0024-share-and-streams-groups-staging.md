---
status: accepted
date: 2026-09-27
---

# ADR-0024: 共有のグループと Streams のグループは機能の版で無効にしておき、条件を満たしてから有効にする

詳細は [consumer-groups.md](../architecture/consumer-groups.md) の 7 節。

## Context

- 共有のグループ（KIP-932）は 4.2 で本番向けになった。Streams のリバランスのプロトコル（KIP-1071）は 4.2 で機能を絞って GA（[4.2.0 の発表](https://kafka.apache.org/blog/2026/02/17/apache-kafka-4.2.0-release-announcement/)、2026-09-27 に確認）。4.3 では、`group.coordinator.rebalance.protocols` が非推奨になり、機能の版（`group.version`、`streams.version`、`share.version`）で切り替える（[Broker Configs](https://kafka.apache.org/43/configuration/broker-configs/)、2026-09-27 に確認）。
- 共有のグループは、ブローカー全体の資源を持つ。共有のセッションはブローカーごとに 2000（`group.share.max.share.sessions`）、レコードのロックはパーティションごとに既定 2000（同上）。共有の物理クラスタでは、1 つのテナントが使い切りうる。
- StreamsGroupHeartbeat は、Streams の内部のトピックの名前を含むトポロジーを送る。名前空間のパッチの資源の場所が、他の API より複雑になる。
- intent.md は、共有のグループを「MVP の直後に、クォータとテストを足して有効にする」とした。[ADR-0005](0005-compatibility-policy.md) と [protocol-and-compatibility.md](../architecture/protocol-and-compatibility.md) の 4 節は、これらの API を「フラグ」（無効の間は本家で無効のときと同じ応答）にした。

## Options

1. **機能の版を 0 にして無効にし、条件の一覧を満たしてから、機能ごとに有効にする**
2. 本家の既定どおり有効にし、問題が出たら止める
3. 提供しない（Non-goals にする）

## Decision

1 を採用する。

共有のグループを有効にする条件：

1. 名前空間の表に、テナント向けの共有のグループの API の資源の場所を足し、他のテナントが見えないことの性質ベーステストを通す。ブローカーの間の API はテナントに拒否のまま。
2. テナントごとの共有のセッションの数の上限（初期値は Standard でブローカーあたり 200）と、グループの設定の範囲（`share.record.lock.duration.ms` 15〜60 秒、`share.delivery.count.limit` 2〜10、`share.partition.max.record.locks` 100〜2000 など）を入れる。
3. 障害注入で、確認応答したレコードが再配送されないこと、配送の回数の上限の扱いを確かめる。
4. 遅れのメトリクスをメトリクスの API に載せる。

Streams のグループを有効にする条件：

1. トポロジーの中のトピックの名前の付け外しの性質ベーステスト。
2. exactly-once の試験（[ADR-0022](0022-exactly-once-verification.md)）を Streams のグループでも通す。
3. 本家の「機能を絞った」制限の中身を確かめ、利用者向けの文書に書けること。

- 2 を選ばない理由：名前空間の表に載っていない API は拒否される設計（[ADR-0004](0004-logical-clusters-on-shared-physical-clusters.md)）と矛盾し、テナントの間の資源の取り合いを先に抱える。
- 3 を選ばない理由：本家で本番向けになった機能で、キューの用途の需要がある（intent.md）。

## Consequences

- 良くなること：
  - 分離と資源の上限を確かめてから出せる。機能の版で、ブローカーの再起動なしに有効にできる。
- 引き受けるコスト：
  - 共有のグループ・Streams のグループを使うアプリは、有効になるまで動かない。利用者向けの文書に書く。
  - 本家の版の更新のたびに、無効の間の応答が本家と同じかを差分テストで確かめる。

## Confirmation

- 差分テスト：機能の版が 0 の間、該当する API の応答が、本家で同じ機能の版を 0 にしたブローカーと同じ。
- 有効にする PR は、上の条件の各テストの結果を PR に付け、Dev のテックリードの承認を受ける（`security:sensitive`）。

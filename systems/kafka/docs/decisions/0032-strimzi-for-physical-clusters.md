---
status: accepted
date: 2026-09-27
---

# ADR-0032: 物理クラスタは EKS の上の Strimzi で動かし、自前のオペレーターは作らない

## Context

物理クラスタ（KRaft のコントローラー 3 台と、ブローカーの集まり）を EKS の上で作り、広げ、ローリングで更新し、ブローカーを退役させる必要がある。intent.md の未解決の問いは「既存のオペレーター（Strimzi など）を使うか、自前で作るか」だった。

事実（いずれも 2026-09-27 に確認）：

- Strimzi は Apache License 2.0 の CNCF の incubating のプロジェクト（[strimzi-kafka-operator](https://github.com/strimzi/strimzi-kafka-operator)）。最新は 1.2.0（2026-08-20）。Kafka 4.3.1 に対応し、KIP-1066 の cordon を縮小のときの自動の再配置で使う（Kafka 4.3 以降）（[CHANGELOG](https://github.com/strimzi/strimzi-kafka-operator/blob/main/CHANGELOG.md)）。
- Strimzi は 0.46.0 で ZooKeeper の構成を取り除き、0.48.0 で KRaft とノードプールを既定にした。1.0.0 で `v1` の API に移った。1.1.0 で独自の Kafka の版の扱いを改善した（同上）。
- Strimzi は Cruise Control での再配置、ローリング更新、Drain Cleaner によるノードの退避を持つ（[Strimzi Overview 1.2.0](https://strimzi.io/docs/operators/latest/overview)）。
- 本家の 4.3.0（2026-05-22）から、Strimzi の対応（1.1.0、2026-06-27）まで約 5 週間。
- Kora は Kubernetes の上で、自前の仕組みで物理クラスタを動かしている（[Kora](https://vldb.org/pvldb/vol16/p3822-povzner.pdf) の 3.1 節）。

## Options

1. **Strimzi の Cluster Operator とノードプールを使う。Topic Operator と User Operator は使わない**
2. 自前のオペレーター（Java か Go）を作る
3. Kubernetes を使わず、EC2 の Auto Scaling グループと自前の工程で動かす

## Decision

1 を採用する。詳細は [control-plane-and-provisioning.md](../architecture/control-plane-and-provisioning.md) の 7・8 節にある。

- ブローカーのイメージは、本家＋差し込み口＋パッチの自前のイメージを `spec.kafka.image` で指定する。認証と認可は Strimzi の `custom` の型で、自前の SASL/PLAIN のコールバックと TenantAuthorizer を指定する。
- ノードプールは `controllers`（3 台）と、AZ ごとの `brokers-<az-id>`。rack の `topologyKey` は AZ ID のラベル（`topology.k8s.aws/zone-id`。付かなければノードグループのラベル `<brand>.io/zone-id`）にする（[ADR-0012](0012-durability-settings-and-elr.md)、[ADR-0043](0043-aws-accounts-network-and-eks-layout.md)）。
- ストレージは EBS CSI の gp3 で、StorageClass に物理クラスタの KMS のキーを指定する。
- Topic Operator と User Operator は使わない。トピックと ACL は、KRaft を正本にしてエージェントが扱う（[ADR-0031](0031-control-plane-reconciliation-and-agent.md)）。
- Strimzi のリソースは GitOps（Argo CD）で適用し、S1 は人が PR を承認する。
- Strimzi の版は固定し、本家の版の取り込みと同じ PR で上げる。Strimzi の対応を待つ時間は、[ADR-0008](0008-client-matrix-differential-tests-and-version-tracking.md) の「3 か月以内」に含める。
- パーティションの再配置の計画と実行は、metadata-and-control の領域（[ADR-0016](0016-partition-placement-reassignment-and-cordon.md)）のとおりエージェントが行う。Strimzi の `KafkaRebalance` と、縮小のときの Strimzi の自動の再配置は使わない（計画器を 2 つにしない）。Strimzi は、ノードの ID を指定した縮小（ブローカーの停止と登録の解除）だけを行う。

2 を選ばない理由：ローリング更新、ノードプール、証明書、ボリュームの付け替え、退避の扱いを一から作ることになる。S1 の物理クラスタは 10 以下で、自前で作る利点（細かい制御）より、正しさの検証の手間が大きい。

3 を選ばない理由：ボリュームの付け替え、宣言的な更新、ノードの退避を自前の工程で作り直すことになる。Kora も Kubernetes を使う。

見直しの条件：(1) Strimzi が本家の新しいマイナー版に 2 か月以上対応しない、(2) 名前空間のパッチやセル（S2）に必要な制御が Strimzi のリソースで表せない、(3) Strimzi の不具合で、ローリング更新が 2 回以上止まる。

## Consequences

- 良くなること：
  - ローリング更新、ノードプール、内部の TLS、縮小のときの cordon を、実績のある実装から得る。
  - 本家の版の新しい機能（KIP-1066 など）への対応を、Strimzi の版の更新で得られる。
- 引き受けるコスト：
  - 本家の版の取り込みが、Strimzi の対応を待つ（約 1 か月）。
  - Strimzi のリソースで表せない細かい制御（ブローカーごとのボリュームの大きさなど。未検証）は、AZ ごとのノードプールの単位になる。
  - Strimzi の調停とエージェントの操作が同じ資源に触れないよう、境界を守る（ボリュームの拡張は KafkaNodePool の `storage.size` の変更で行い、EBS を直接変えない）。

## Confirmation

- 結合テスト：開発の EKS で、合成の負荷を流したまま、ブローカーの追加・ローリング更新・退役を行い、`acks=all` の書き込みを失わない。
- CI：Strimzi の Kafka のリソースの雛形から作った YAML を、Strimzi の CRD のスキーマで検証する。Topic Operator と User Operator が無効であることを確かめる。
- 運用：Strimzi の版と、本家の最新のマイナー版への対応の遅れを記録する。

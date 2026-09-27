---
status: accepted
date: 2026-09-27
---

# ADR-0018: S3 の RemoteStorageManager は OSS の実装を土台にし、テナントの検査と計数の層で包む

詳細は [tiered-and-object-storage.md](../architecture/tiered-and-object-storage.md) の 5 節。

## Context

本家の Apache Kafka は、階層型の保存（KIP-405）の枠（RemoteLogManager、既定の RLMM）を持つが、RemoteStorageManager（RSM）の実装は持たない（[Tiered Storage](https://kafka.apache.org/43/operations/tiered-storage/)、2026-09-27 に確認）。S3 に書く RSM を用意する必要がある。

- [ADR-0002](0002-replicated-log-with-tiered-storage.md) で、既定のトピックを「ローカルの 3 つの複製＋S3 への階層型の保存」にした。README の技術スタックは「自前の S3 の RSM」としていた。
- Aiven の [tiered-storage-for-apache-kafka](https://github.com/Aiven-Open/tiered-storage-for-apache-kafka) は Apache License 2.0 の S3・GCS・Azure の RSM で、4 MiB の塊（chunk）への分割、塊の索引を持つマニフェスト、ローカルの塊のキャッシュ、封筒暗号化を持つ。最新の版は v1.1.1（2025-10-07）、リポジトリの最終の更新は 2026-08-01（2026-09-27 に確認）。
- 土台のキーは `<key.prefix><topic>-<topicId>/<partition>/<20 桁の開始オフセット>-<segmentUuid>.<log|indexes|rsm-manifest>`（同リポジトリの `ObjectKeyFactory.java`）。
- テナントの名前空間のパッチで、トピックの内部の名前は `<lc-id>_<名前>` になる（[ADR-0025](0025-tenant-namespace-patch.md)）。
- S3 は、前方一致ごとに毎秒 3,500 の PUT 系と 5,500 の GET 系を受け付ける（[Optimizing Amazon S3 performance](https://docs.aws.amazon.com/AmazonS3/latest/userguide/optimizing-performance.html)、2026-09-27 に確認）。

## Options

RSM：

1. **Aiven の実装を土台にし、自前の薄い層で包む**
2. **自前で書き起こす**（Java、AWS SDK v2）
3. **Aiven の実装を fork して直接直す**

キー：

- A. **テナントで始める（`key.prefix` は空）**
- B. **ハッシュで始める**（`<hash>/<topic>-…`。要求の速さを前方一致に散らす）

バケット：

- X. **物理クラスタごとに 1 つ**
- Y. **リージョンで 1 つ**
- Z. **論理クラスタごとに 1 つ**

## Decision

1、A、X を採用する。

- 土台の版を固定し、開発リポジトリでソースからビルドする。本家の版を上げるときに、互換性と耐久性のテストを一緒に回す。
- 包む層 `TenantAwareRemoteStorageManager`（Java）は、(1) トピックの内部の名前が `lc-<id>_` で始まることを確かめ、始まらないものを上げない、(2) テナントごとの上げた・消したバイト数とオブジェクト数を計数する、(3) S3 の失敗（503、403、KMS）を分類して数える。
- 塊は 4 MiB。土台の圧縮とクライアント側の暗号化は使わず、SSE-KMS（S3 Bucket Keys）に任せる。
- バケット `<brand>-tiered-<pc-id>-apne1`。バージョニング有効、パブリックアクセスはすべて遮断、ブローカーのロールは自分のバケットだけに書ける。
- 2 を選ばない理由：マルチパート、範囲の読み取り、塊のキャッシュ、再試行を自前で書き、耐久性を一から確かめることになる。[ADR-0001](0001-upstream-brokers-and-stack.md) の「検証された実装を使う」に反する。
- 3 は、必要になるまでしない。土台の保守が止まったとき（本家の新しい版でビルドできない、など）に fork に切り替える。
- B を選ばない理由：S1 の規模では、テナントとパーティションでキーが十分に散る。テナントの前方一致で、削除・費用の按分・大阪への写しの絞り込みができる利点が大きい。
- Y は、1 つのバケットの要求の速さと障害の範囲が全体に及ぶ。Z は、論理クラスタ 1,000（S1）でバケットの数の上限（アカウントあたりの既定、未検証）と IAM の管理が重くなる。

## Consequences

- 良くなること：
  - RSM を書かずに済み、E4 の作業を、テナントの検査・監査・大阪への写しに集中できる。
  - テナントの単位で、S3 の保存量の計測と削除が前方一致でできる。
- 引き受けるコスト：
  - 外部の OSS の保守に依存する。本家の版への追従が遅れたら、fork の手間を負う。
  - README の技術スタックの「自前の S3 の RSM」と表現が変わる（統合の工程で README を直した）。
  - 1 つのトピックへの過去の読み戻しが集中すると、前方一致の要求の速さの上限（503）に当たりうる。

## Confirmation

- 性質ベーステスト：任意のテナントとトピックの名前で、キーは `lc-<id>_` で始まり、他のテナントの前方一致と重ならない。
- 結合テスト：包む層は、接頭辞のないトピックの copy を失敗させる。
- CI：本家の版を上げる PR で、土台をその版でビルドし、階層型の保存の障害注入のテストを通す。

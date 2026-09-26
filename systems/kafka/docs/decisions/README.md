# Decisions: Kafka

Kafka（マネージドのストリーミング基盤）の再構築に関する決定。リポジトリ共通の決定は [docs/decisions/](../../../../docs/decisions/README.md) にある。

<!-- adr-index:start -->
| ADR | 決定 | 状態 |
| --- | --- | --- |
| [0001](0001-upstream-brokers-and-stack.md) | データ面は本家の Apache Kafka のブローカーを使い、差し込み口と最小のパッチで拡張する | proposed |
| [0002](0002-replicated-log-with-tiered-storage.md) | 既定のトピックは、ローカルのディスクの 3 つの複製と S3 への階層型の保存にする | proposed |
| [0003](0003-kraft-metadata-and-cluster-placement.md) | 物理クラスタのメタデータは KRaft を正本にし、制御面は望ましい状態を反映する | proposed |
| [0004](0004-logical-clusters-on-shared-physical-clusters.md) | テナントは、共有の物理クラスタの上の論理クラスタにする | proposed |
| [0005](0005-compatibility-policy.md) | 互換の範囲は、動かしている本家のブローカーの API から管理の API を除いたものにし、行列と差分テストで確かめる | proposed |
<!-- adr-index:end -->

この一覧は、各 ADR の frontmatter と見出しから生成したもの。ADR を追加・更新したら生成し直す。

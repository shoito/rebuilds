# Decisions: Kafka

Kafka（マネージドのストリーミング基盤）の再構築に関する決定。リポジトリ共通の決定は [docs/decisions/](../../../../docs/decisions/README.md) にある（本家の名前・接頭辞を使わない規則は、その ADR-0006）。領域ごとの設計と、領域ごとの ADR の番号の範囲は [architecture/](../architecture/README.md) の 7 節を見る。

<!-- adr-index:start -->
| ADR | 決定 | 状態 |
| --- | --- | --- |
| [0001](0001-upstream-brokers-and-stack.md) | データ面は本家の Apache Kafka のブローカーを使い、差し込み口と最小のパッチで拡張する | accepted |
| [0002](0002-replicated-log-with-tiered-storage.md) | 既定のトピックは、ローカルのディスクの 3 つの複製と S3 への階層型の保存にする | accepted |
| [0003](0003-kraft-metadata-and-cluster-placement.md) | 物理クラスタのメタデータは KRaft を正本にし、制御面は望ましい状態を反映する | accepted |
| [0004](0004-logical-clusters-on-shared-physical-clusters.md) | テナントは、共有の物理クラスタの上の論理クラスタにする | accepted |
| [0005](0005-compatibility-policy.md) | 互換の範囲は、動かしている本家のブローカーの API から管理の API を除いたものにし、行列と差分テストで確かめる | accepted |
| [0006](0006-api-exposure-table-and-denial.md) | API ごとの扱いを 1 つの表で持ち、拒否は Authorizer で本家と同じエラーを返す | accepted |
| [0007](0007-topic-config-allowlist.md) | トピックの設定は許可リストで絞り、耐久性の設定は同じ値の指定だけを通す | accepted |
| [0008](0008-client-matrix-differential-tests-and-version-tracking.md) | 行列は具体の版で持ち、差分テストは生の要求を正規化して比べ、本家は x.y.1 以降を取り込む | accepted |
| [0009](0009-ebs-gp3-single-log-volume.md) | ブローカーごとに EBS gp3 のログのボリュームを 1 本付け、容量はローカルの保持から出して自動で広げる | accepted |
| [0010](0010-segment-retention-and-compaction-defaults.md) | セグメントは 256 MiB・1 時間で切り替え、圧縮は資源を絞って増やし、圧縮のトピックのローカルの量に上限を掛ける | accepted |
| [0011](0011-log-recovery-and-broker-replacement.md) | 不正な停止の後は本家の回復と ELR に任せて回復の時間を 5 分に抑え、ボリュームを失ったら空で複製し直す | accepted |
| [0012](0012-durability-settings-and-elr.md) | 複製 3・AZ ID の rack・`min.insync.replicas=2`・unclean な選出の禁止・ELR を固定し、アプリの fsync はしない | accepted |
| [0013](0013-fetch-from-follower.md) | fetch-from-follower は本家の `RackAwareReplicaSelector` で有効にし、クライアントの `client.rack` に任せる | accepted |
| [0014](0014-durability-audit-and-fault-injection.md) | 本番で耐久性の監査とカナリアを持ち、Jepsen の形の障害注入を PR ごとと日次で回す | accepted |
| [0015](0015-kraft-dynamic-quorum-and-controller-sizing.md) | KRaft は作成時から動的なクォーラムにし、S1 は 3 台、S2 は 5 台の専用のコントローラーにする | accepted |
| [0016](0016-partition-placement-reassignment-and-cordon.md) | 再配置は同じ AZ の中で 1 つずつ行い、退役は cordon から始め、劣化したブローカーは降格する | accepted |
| [0017](0017-metadata-limits-and-snapshots.md) | 物理クラスタのパーティションと、ブローカーの複製に上限を置き、スナップショットは本家の既定で実測して見直す | accepted |
| [0018](0018-s3-remote-storage-manager.md) | S3 の RemoteStorageManager は OSS の実装を土台にし、テナントの検査と計数の層で包む | accepted |
| [0019](0019-tiered-storage-lifecycle-and-dr-copy.md) | 削除のポリシーのトピックはすべて階層型にし、大阪への写しは論理クラスタごとに選べる S3 の複製で行う | accepted |
| [0020](0020-diskless-topics-adoption.md) | ディスクレスのトピックは、本家が冪等とトランザクションに対応してから、別の種類のトピックとして出す | accepted |
| [0021](0021-transaction-settings-and-tenant-limits.md) | トランザクションの防御を固定で有効にし、`transactional.id` の数と InitProducerId の頻度にテナントごとの上限を掛ける | accepted |
| [0022](0022-exactly-once-verification.md) | exactly-once の正しさは、Jepsen の形の試験と Kafka Streams の長時間の試験で毎日確かめ、本家の版の更新の関門にする | accepted |
| [0023](0023-consumer-group-protocols-and-limits.md) | classic と consumer の両方のプロトコルを本家の既定で出し、グループにテナントごとの上限を掛ける | accepted |
| [0024](0024-share-and-streams-groups-staging.md) | 共有のグループと Streams のグループは機能の版で無効にしておき、条件を満たしてから有効にする | accepted |
| [0025](0025-tenant-namespace-patch.md) | 名前空間は `<lc-id>_` の接頭辞を、要求の出入口の表駆動のパッチで付け外しし、テナントは SNI と API キーの一致で決める | accepted |
| [0026](0026-tenant-quotas-and-tier-limits.md) | クォータは本家の仕組みで掛けられるものは本家で、掛けられないものは小さなパッチで、テナントの単位に掛ける | accepted |
| [0027](0027-dynamic-quota-coordinator-and-backpressure.md) | クォータのコーディネーターを物理クラスタごとにデータ面に置き、使用量に応じて配り直し、ブローカーは背圧で全体を守る | accepted |
| [0028](0028-service-accounts-api-keys-and-sasl-plain.md) | 資格情報は論理クラスタに絞った API キーにし、SASL/PLAIN を TLS の上で使い、検証用のハッシュを内部のトピックで配る | accepted |
| [0029](0029-tenant-scoped-acls-and-rbac.md) | ACL は本家の StandardAuthorizer を包んで使い、論理クラスタの境界を二重に確かめる。データの権限は ACL だけで与える | accepted |
| [0030](0030-encryption-and-audit-logs.md) | 保存時は物理クラスタごとの KMS のキーで暗号化し、BYOK は Dedicated だけにする。監査ログは CloudEvents の形で S3 と索引に置く | accepted |
| [0031](0031-control-plane-reconciliation-and-agent.md) | 制御面の状態は合図と取得による調停で反映し、KRaft が正本の資源は命令で扱う。データ面のエージェントは Java で書く | accepted |
| [0032](0032-strimzi-for-physical-clusters.md) | 物理クラスタは EKS の上の Strimzi で動かし、自前のオペレーターは作らない | accepted |
| [0033](0033-logical-cluster-placement.md) | 論理クラスタは、受け入れの条件を満たす 2 つの無作為な候補から、実際の使用に基づく得点の低い方に置く | accepted |
| [0034](0034-management-api-shape.md) | 管理 API は `/v1` の主版で足す変更だけを入れ、POST に冪等キー、一覧に不透明なトークン、長い操作に 202 を使う | accepted |
| [0035](0035-console-and-login.md) | コンソールは管理 API を呼ぶ SPA にし、ログインは Better Auth で、MFA は重要な操作の前に求める | accepted |
| [0036](0036-cli-and-terraform-provider.md) | CLI と Terraform のプロバイダーは Go で作り、OpenAPI から生成した 1 つの SDK を共有する | accepted |
| [0037](0037-capacity-unit-definition.md) | CU は層ごとの 6 つの次元の組にし、時間の CU は分ごとの CU の最大にする | accepted |
| [0038](0038-usage-metering-and-metrics-api.md) | 使用量はブローカーで分ごとに数えて S3 を正本にし、テナントのメトリクスは専用の AMP を条件付きの問い合わせで使う | accepted |
| [0039](0039-jpy-billing-and-free-tier.md) | 単価は円で定めて JST の月で締め、適格請求書を出す。Basic に小さな無料の枠を置き、費用の上限は CU の上限で表す | accepted |
| [0040](0040-own-schema-registry.md) | スキーマレジストリは、Confluent の REST API と互換の自前の実装にする | accepted |
| [0041](0041-managed-connectors-curated-plugins.md) | マネージドのコネクターは、当社が選んだ Apache 2.0 のコネクターから始め、コネクターごとに専用のワーカーで動かす | accepted |
| [0042](0042-connector-runtime-isolation.md) | コネクターは、ブローカーと別の EKS・VPC・アカウントの Fargate の Pod で動かし、外への通信を許可リストの出口に限る | accepted |
| [0043](0043-aws-accounts-network-and-eks-layout.md) | データ面は環境ごとのアカウントの 1 つの VPC に置き、EKS は層ごと、ノードグループは物理クラスタ × AZ ID ごとに固定する | accepted |
| [0044](0044-nlb-sni-proxy-and-zonal-hostnames.md) | 入口は NLB（AZ をまたがない）＋ Envoy の SNI の振り分けにし、ブローカーのホスト名に AZ ID を入れて同じ AZ の経路を保つ | accepted |
| [0045](0045-osaka-disaster-recovery-scope.md) | 大阪への災害復旧は、制御面をウォームスタンバイで持ち、データ面は「書き込みの経路の作り直し」と「写しを有効にした履歴の戻し」に分ける | accepted |
| [0046](0046-operator-telemetry-and-cardinality.md) | 運用のメトリクスはブローカーの JVM の中の OpenTelemetry の JMX で集め、ラベルに論理クラスタは上位だけ、トピックとパーティションは載せない | accepted |
| [0047](0047-slos-synthetic-probes-and-alerts.md) | 可用性と遅延の SLI は、外からブローカーごとに流す合成の produce・consume で測り、層ごとの SLO とバーンレートで呼び出す | accepted |
| [0048](0048-broker-design-point-and-cost-model.md) | ブローカーの設計点を「ネットワークと EBS の基準の帯域の 60%」で決め、Standard は r8g.4xlarge、Basic は m8g.4xlarge にし、物理クラスタの CU の容量をスループットとパーティションの小さい方で数える | accepted |
| [0049](0049-build-pipelines-artifacts-and-flags.md) | ブローカーは本家のタグにパッチの列を当てて Strimzi の基のイメージに載せ、全ての成果物に署名と SBOM を付ける。データ面のフラグは内部のトピックで配る | accepted |
| [0050](0050-rolling-upgrade-gates-and-upstream-tracking.md) | ブローカーのローリング更新は AZ の順に 1 台ずつ、パーティションの安全の関門で止め、本家の版の取り込みは差分テスト・Jepsen・Streams の長時間の試験を通してから行う | accepted |
<!-- adr-index:end -->

この一覧は、各 ADR の frontmatter と見出しから生成したもの。ADR を追加・更新したら生成し直す。

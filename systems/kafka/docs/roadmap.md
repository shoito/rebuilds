# Roadmap: Kafka

## 進め方の原則

- **最初に walking skeleton を通す。** E1 で、本家 4.3.1 ＋ パッチの列 ＋ 差し込み口のブローカーのイメージ、Strimzi の物理クラスタ、NLB と Envoy の入口、SASL/PLAIN の API キー、名前空間のパッチの最小の版、エージェントの骨組みを端から端まで貫き、1 つの論理クラスタで produce・consume・トランザクションを通してから、機能を広げる。Jepsen の形の障害注入、本家との差分テスト、パッチの行数の CI は、E1 から本物の形で作る。後から足すと、喪失と互換の破れを見逃すため。
- **PoC を先に済ませる。** 次の PoC は、それぞれの Epic の Story の spec を承認する前に結果を記録する：名前空間のパッチの行数と SNI の取り出し・代理の接続（E7 の前。多すぎれば [ADR-0004](decisions/0004-logical-clusters-on-shared-physical-clusters.md) のプロキシの案を見直す）、Envoy の on-demand CDS と同じ AZ の経路（E12 の前。[ADR-0044](decisions/0044-nlb-sni-proxy-and-zonal-hostnames.md)）、定期のフラッシュと回復の時間（E3 の前。[ADR-0011](decisions/0011-log-recovery-and-broker-replacement.md)）、設計点とパーティションの密度（T1・T2。E9 の前。[ADR-0048](decisions/0048-broker-design-point-and-cost-model.md)）、Strimzi のロールの止め方（E12 の前。[ADR-0050](decisions/0050-rolling-upgrade-gates-and-upstream-tracking.md)）、Cruise Control が 4.3 で使えるか（E9 の前。[ADR-0016](decisions/0016-partition-placement-reassignment-and-cordon.md)）。
- **耐久性と分離を先に固める。** E3（耐久性）と E7（分離）は、他の Epic の機能を本番に出す前の関門にする。`durability:sensitive`・`security:sensitive` の変更は、Dev のテックリードの承認を要する（[AGENTS.md](../AGENTS.md)）。
- **契約を先に固定する。** API の表、トピックの設定の表、名前空間の表、許された違いの表、望ましい状態のスキーマ、管理 API の OpenAPI、CU の値は、人間がレビューして確定する。エージェントは勝手に変えない。
- **法務・経理の確認待ちの Story は、spec を承認しない。** 設計と、法務・経理に依らない Story は進めてよい（[intent.md](intent.md) の「法務の確認待ち」L1〜L8）。下の表で「法務：L*」と書いた Story が当たる。
- **1 変更 1 PR を目安に、差分を小さくする。** ブローカーを再起動する変更は、関門 G1〜G7 で 1 台ずつ出す（[delivery.md](architecture/delivery.md) の 6 節）。

## Epic

PM が持つ。変更の一覧はここに書かず、各変更の `spec.md` の frontmatter（`epic`）から集計する（[process.md](../../../docs/process.md) の「粒度」）。各 Epic の品質の重点と合否基準は [quality.md](quality.md) の 5 節にある。

| Epic | 目的 | 状態 |
| --- | --- | --- |
| E1 基盤と PoC | AWS のアカウントと VPC、EKS と Strimzi、ブローカーのビルドとパッチの列、署名と SBOM、Jepsen の枠、名前空間・SNI・SASL・階層型の保存・エッジの PoC、テレメトリーの経路、設計点の負荷試験（T1・T2） | 設計中 |
| E2 プロトコルと互換性 | API の表と拒否、トピックの設定の表、差分テスト、クライアントの行列、クライアントの版の計測、本家の RC の夜間の試験 | 未着手 |
| E3 複製と耐久性 | 耐久性の設定、障害注入の行列、耐久性の監査とカナリア、fetch-from-follower、セグメントと保持、ディスクの逼迫、ボリュームの入れ替え、コントローラーの入れ替え、劣化したブローカーの降格 | 未着手（前にフラッシュと回復の PoC） |
| E4 階層型の保存 | RSM の包む層、バケットと IAM、階層型のトピックの強制、RLMM のスナップショット、階層型の監査、孤児の掃除、大阪への写しと戻し、KIP-1023 の検証 | 未着手 |
| E5 トランザクション | TV2 の固定、`transactional.id` と InitProducerId の上限、管理の API の名前空間、Streams の exactly-once の試験、ぶら下がったトランザクション、既知の制約の文書 | 未着手 |
| E6 コンシューマーグループ | 機能の版、正規表現の名前空間、グループの設定の許可リスト、グループの数と大きさの上限、遅れの計算、移行の試験 | 未着手 |
| E7 マルチテナントとクォータ | 名前空間の表の生成と全 API、トピックの ID、ACL の変換、テナントの見え方、クォータ、接続・パーティションの上限、動的なクォータと背圧、圧縮のトピックの上限、うるさい隣人の試験、隣のテナントの確認 | 未着手（前に名前空間のパッチの PoC） |
| E8 セキュリティと ACL | サービスアカウント、API キー、資格情報の配布、再認証と失効、TenantAuthorizer、ロール、認証の失敗の制限、監査ログ、シークレットスキャン、データの削除 | 未着手（削除の約束は法務：L4） |
| E9 制御面と配置 | 制御面の状態、outbox、調停、命令、KRaft の写し、論理クラスタの作成、配置、物理クラスタの作成、ブローカーの追加と退役、再配置と計画器、メタデータの上限、規模の負荷試験 | 未着手 |
| E10 コンソールと API | 管理 API（`/v1`、冪等、ページング、操作、レート制限、OpenAPI）、コンソール、最初の 5 分、ログインとステップアップ、CLI、Terraform のプロバイダー | 未着手（配る成果物の表示は法務：L2） |
| E11 メトリクスと請求 | CU、使用量の経路と照合、保持の量、メトリクスの API、価格と rating（パーティション-時を含む）、無料の枠、適格請求書、支払い、未払い、予算 | 未着手（請求書・未払い・税は法務・経理：L7・L8） |
| E12 運用と GA の準備 | ローリング更新の関門、本家の版の取り込み、運用のフラグ、エッジの本番、証明書、大阪の待機、合成監視と SLO、ダッシュボードとアラート、侵入試験、負荷試験 T6・T8・T10、GA の判定 | 未着手（GA の判定は法務：L1〜L8） |
| E13 ディスクレスのトピック（S2） | 本家の KIP-1163・1164 の取り込み、別の種類のトピック、別の遅延の目標と単価 | 未着手（本家の実装待ち） |
| E14 共有のグループと Streams のグループ | 共有のグループ（MVP の直後）、Streams のグループ（S2） | 未着手（MVP の後） |
| E15 セルと S2 の規模 | セル、コントローラー 5 台、データ面のアカウントの分割、物理クラスタの自動の作成、論理クラスタの移動 | 未着手（S2） |
| E16 スキーマレジストリ（S2） | 互換の API、互換性の判定、差分テスト、移行、コンソールと Terraform | 未着手（S2。法務：L3） |
| E17 マネージドのコネクター（S3） | 実行基盤と隔離、選んだコネクター、侵入テストの自動化、利用者のプラグイン | 未着手（S3。法務：L3） |
| E18 PrivateLink（S2） | 内部向けの NLB、エンドポイントサービス、エンドポイントの ID の検査 | 未着手（S2） |
| E19 Dedicated と BYOK（S2） | 1 テナントの物理クラスタ、利用者の KMS のキー、キーの喪失の検知 | 未着手（S2。SLA の扱いは法務：L8） |

E1〜E12 が MVP（S1）。領域の文書の「Story の候補」は、この番号で書く。

## Story

各 Story は、着手するときに `changes/YYMMDD-<slug>/` として起票する。ここは計画で、進み具合は各変更の `spec.md` の frontmatter で見る。順序は Epic の中での目安で、依存があるものを先に置いた。各領域の文書の「Story の候補」から集めた。同じ中身の Story が 2 つの文書にあるものは 1 つにした（元の名前を括弧に書く）。

### E1 基盤と PoC

設計：[infrastructure.md](architecture/infrastructure.md)、[delivery.md](architecture/delivery.md)、[control-plane-and-provisioning.md](architecture/control-plane-and-provisioning.md)、[observability.md](architecture/observability.md)、各領域の PoC

| Story | 内容 |
| --- | --- |
| `dev-repo-bootstrap` | Kafka の再構築の開発リポジトリを作り、`changes/`・`specs/`・開発向けの `AGENTS.md`、CODEOWNERS とルールセット（`broker/patches/`・`broker/plugins/` はテックリード）を置く（リポジトリ共通の ADR-0005、[delivery.md](architecture/delivery.md) の 1 節） |
| `org-and-accounts` | アカウント、OU、SCP（[infrastructure.md](architecture/infrastructure.md) の 1 節） |
| `dataplane-vpc` | AZ ID の固定、サブネット、エンドポイント、DNS Firewall（同 2.1・2.2 節） |
| `eks-and-nodegroups` | EKS、ノードグループ、AZ ID のラベル、`broker.rack` の起動の検査（同 3 節） |
| `cp-dp-connectivity` | VPC Lattice、SQS、AMP のアカウントをまたぐ経路（同 2.3 節） |
| `broker-build-pipeline` | `upstream.lock`、パッチの列、プラグインのモジュール、Strimzi の基のイメージ、参照のブローカー（[delivery.md](architecture/delivery.md) の 4.1 節。protocol の `upstream-broker-build` を含む） |
| `patch-line-count-ci` | パッチの行数と対象のファイルの出力、増えたときの理由の要求 |
| `supply-chain-signing` | cosign、SBOM、provenance、EKS の署名の検証 |
| `apiversions-parity-check` | ApiVersions の広告の集合を参照と比べる CI（[protocol-and-compatibility.md](architecture/protocol-and-compatibility.md)） |
| `strimzi-dev-cluster` | 開発の EKS に、自前のイメージで Strimzi の物理クラスタを作る（[control-plane-and-provisioning.md](architecture/control-plane-and-provisioning.md)） |
| `kraft-dynamic-quorum-bootstrap` | 3 台の動的なクォーラムの作成（[metadata-and-control.md](architecture/metadata-and-control.md)） |
| `broker-node-baseline` | XFS、`noatime`、OS の上限、JVM、ボリュームの付け替え（[broker-and-log-storage.md](architecture/broker-and-log-storage.md)） |
| `durability-config-baseline` | 耐久性の設定、ELR、AZ ID の rack（[replication-and-durability.md](architecture/replication-and-durability.md)） |
| `jepsen-harness` | jepsen.tests.kafka を SASL と名前空間の構成で動かす。本家との同じシードの比較 |
| `agent-skeleton` | エージェント（Java）の骨組み、Lease、internal-api の認証 |
| `sasl-plain-callback-poc` | SASL/PLAIN のコールバックと資格情報のキャッシュ（[security-and-acls.md](architecture/security-and-acls.md)） |
| `namespace-patch-poc` | P1・P2 の最小の版で Produce・Fetch・Metadata・グループ・トランザクションが通る。パッチの行数を測る（[multi-tenancy-and-quotas.md](architecture/multi-tenancy-and-quotas.md)） |
| `sni-tenant-resolution-poc` | KafkaPrincipalBuilder で SNI を取り出し、API キーの lc-id と照合する。代理の接続のユーザー名の検査 |
| `txn-namespace-poc` | 名前空間を通した `transactional.id`・`TxnOffsetCommit` で Streams の exactly-once の代表のトポロジーが動く（[transactions-and-idempotence.md](architecture/transactions-and-idempotence.md)） |
| `group-namespace-poc` | classic と consumer のグループが名前空間を通して動く（[consumer-groups.md](architecture/consumer-groups.md)） |
| `tiered-storage-poc` | 本家 4.3 ＋ Aiven の RSM ＋ 名前空間で、キーの形とテナントの前方一致を確かめる（[tiered-and-object-storage.md](architecture/tiered-and-object-storage.md)） |
| `edge-poc` | NLB＋Envoy＋sni-router の on-demand CDS。同じ AZ の経路の確認（[infrastructure.md](architecture/infrastructure.md) の 5 節） |
| `log-recovery-poc` | 不正な停止からの回復の時間を、定期のフラッシュの有無で測る（[ADR-0011](decisions/0011-log-recovery-and-broker-replacement.md)） |
| `metadata-scale-poc` | 上限での切り替え・起動の時間、スナップショットの大きさ（[metadata-and-control.md](architecture/metadata-and-control.md) の 6 節） |
| `strimzi-roll-control-poc` | Strimzi のロールを AZ の順に止めて進められるか（[delivery.md](architecture/delivery.md) の 6.2 節） |
| `broker-otel-jmx` | Java エージェント、自前の YAML の規則、15 秒と 60 秒の系列（[observability.md](architecture/observability.md)） |
| `telemetry-pipeline` | Collector、運用とテナントの AMP への分け方、ラベルの落とし方 |
| `load-test-t1-t2` | T1（設計点）と T2（パーティションの密度）（[capacity.md](architecture/capacity.md) の 11 節） |

### E2 プロトコルと互換性

設計：[protocol-and-compatibility.md](architecture/protocol-and-compatibility.md)、[ADR-0005](decisions/0005-compatibility-policy.md)〜[ADR-0008](decisions/0008-client-matrix-differential-tests-and-version-tracking.md)

| Story | 内容 |
| --- | --- |
| `api-exposure-table` | 4 節の表を spec にし、Authorizer の包みで「拒否」「絞る」を実装する |
| `topic-config-policy` | 5 節の表の CreateTopicPolicy・AlterConfigPolicy |
| `differential-test-harness` | 生の要求の送り手、生成器、正規化、許された違いの表 |
| `client-matrix-ci` | 6 節の行列（PR ごとと日次）。confluent-kafka-javascript を対応、KafkaJS を凍結 |
| `client-version-telemetry` | テナントごとの `client_software_name`・版、API の版の件数 |
| `denied-api-docs` | 利用者向けの、拒否する API と設定の一覧と、代わりの手段 |
| `nightly-upstream-rc` | 本家の RC と `trunk` への夜間の当たりと試験（[delivery.md](architecture/delivery.md)） |
| `unknown-api-alert` | 表にない API の `UNSUPPORTED_VERSION` とアラート、runbook |

### E3 複製と耐久性

設計：[replication-and-durability.md](architecture/replication-and-durability.md)、[broker-and-log-storage.md](architecture/broker-and-log-storage.md)、[metadata-and-control.md](architecture/metadata-and-control.md)

| Story | 内容 |
| --- | --- |
| `fault-injection-matrix` | 8.3 節の障害の一覧と、PR ごと・日次・RC ごとの実行 |
| `segment-and-retention-defaults` | セグメント・保持・圧縮のブローカーの既定 |
| `durability-audit-events` | 7.1 節の事象を出すプラグインと、`__<brand>_durability_audit` → エージェント → S3（observability の `audit-event-shipping` を含む） |
| `durability-audit-checks` | AUD-1〜6 の日次の照合とアラート、監査の自己検査 |
| `canary-producer-consumer` | AUD-7 のカナリア |
| `fetch-from-follower` | `RackAwareReplicaSelector`、AZ ID の表示、遅延の測定 |
| `retention-fault-injection` | 保持・圧縮・回復の性質と障害注入 |
| `disk-pressure-ladder` | 70〜95% の段階の対応 |
| `volume-auto-expand` | KafkaNodePool の `storage.size` の拡張と 6 時間の間隔（broker の `ebs-auto-expand`、control-plane の `volume-expansion` を 1 つにした） |
| `broker-volume-replacement` | 空のボリュームでの起動と複製し直し |
| `controller-replacement` | 入れ替えの自動化と、各段の障害注入 |
| `slow-broker-demotion` | 劣化の検出と自動の降格、戻し（metadata の `broker-demotion`、observability の `degraded-broker-detector` を 1 つにした） |
| `tiered-boundary-fault-injection` | 階層型の境界の障害注入を耐久性の枠に足す |
| `jepsen-txn-workload` | Jepsen の txn のワークロードと障害の組み合わせ |
| `az-loss-drill` | AZ の喪失の振る舞いの検証と、AZ の退避の訓練の手順 |

### E4 階層型の保存

設計：[tiered-and-object-storage.md](architecture/tiered-and-object-storage.md)、[ADR-0018](decisions/0018-s3-remote-storage-manager.md)〜[ADR-0019](decisions/0019-tiered-storage-lifecycle-and-dr-copy.md)

| Story | 内容 |
| --- | --- |
| `tiered-bucket-and-iam` | 物理クラスタごとのバケット、SSE-KMS、Pod Identity、ゲートウェイ型のエンドポイント |
| `rsm-tenant-wrapper` | 包む層：接頭辞の検査、テナントごとの計数、S3 の失敗の分類 |
| `tiered-topic-policy` | `remote.storage.enable` の強制、`local.retention.ms` の扱い |
| `rlmm-snapshot-exporter` | `_rlmm/` のスナップショットの書き出し |
| `tiered-durability-audit` | 日次の監査と、削除の停止のフラグ（`tiered.delete.pause`） |
| `orphan-sweeper` | 孤児の報告と、条件を満たすものの削除 |
| `osaka-crr-per-cluster` | 論理クラスタごとの CRR の規則、大阪のバケットのライフサイクル、別のアカウント |
| `osaka-restore-runbook` | 大阪での戻しの道具と手順、四半期の演習 |
| `follower-fetch-last-tiered-offset` | KIP-1023 の Jepsen の形と性能のテスト。通るまで既定は無効 |

### E5 トランザクション

設計：[transactions-and-idempotence.md](architecture/transactions-and-idempotence.md)、[ADR-0021](decisions/0021-transaction-settings-and-tenant-limits.md)〜[ADR-0022](decisions/0022-exactly-once-verification.md)

| Story | 内容 |
| --- | --- |
| `transaction-feature-pinning` | `transaction.version=2`、確認の有効化、ブローカーの設定の固定と検査 |
| `transactional-id-limit` | コーディネーターのパーティションごとの上限と `TRANSACTIONAL_ID_AUTHORIZATION_FAILED` |
| `init-producer-id-throttle` | InitProducerId の頻度の上限と `throttle_time_ms` |
| `txn-admin-api-namespacing` | DescribeTransactions・ListTransactions・DescribeProducers の名前空間と PID の漏れの防止 |
| `kafka-17754-regression` | 遅れて届く `EndTxn` の再現と、TV2 での締め出し |
| `streams-eos-soak` | Streams の exactly-once の 6 時間の試験 |
| `txn-anomaly-baseline` | トランザクションの異常を本家と比べ、既知の制約の一覧を作る |
| `hanging-txn-detector` | 最も古い開いたトランザクションの経過時間の収集、アラート、runbook（transactions の `hanging-txn-runbook` を含む） |
| `txn-known-limitations-doc` | 利用者向けの既知の制約の文書 |

### E6 コンシューマーグループ

設計：[consumer-groups.md](architecture/consumer-groups.md)、[ADR-0023](decisions/0023-consumer-group-protocols-and-limits.md)

| Story | 内容 |
| --- | --- |
| `group-feature-versions` | `group.version`・`share.version`・`streams.version` とグループの設定の固定と検査 |
| `consumer-regex-namespacing` | コーディネーターの正規表現の評価のパッチ（P3）と性質ベーステスト |
| `group-config-allowlist` | `GROUP` の資源の設定の許可リスト |
| `group-count-limit` | テナントのグループの数の上限 |
| `group-size-limit` | `group.max.size`・`group.consumer.max.size` |
| `consumer-lag-collector` | データ面のエージェントの遅れの計算 |
| `protocol-migration-tests` | classic → consumer の無停止の移行と、障害の下の試験 |
| `coordinator-fault-injection` | コーディネーターの停止・分断の下でコミットしたオフセットを失わない |
| `streams-group-flag` | KIP-1071 の API をフラグ（機能の版 0）の裏に置く |

### E7 マルチテナントとクォータ

設計：[multi-tenancy-and-quotas.md](architecture/multi-tenancy-and-quotas.md)、[ADR-0025](decisions/0025-tenant-namespace-patch.md)〜[ADR-0027](decisions/0027-dynamic-quota-coordinator-and-backpressure.md)

| Story | 内容 |
| --- | --- |
| `namespace-table-codegen` | 本家のメッセージの定義から名前空間の表を生成し、CI の関門にする |
| `namespace-request-rewrite` | P1 の全 API |
| `topic-id-ownership-check` | トピックの ID の持ち主の確認 |
| `acl-wildcard-translation` | ACL の `*` の置き換えと逆変換 |
| `tenant-metadata-view` | P2（クラスタの ID、AZ ID を含むホスト名、ブローカーの一覧） |
| `tenant-quota-callback` | `ClientQuotaCallback`（4 種類）とタグ `{tenant}` |
| `tenant-connection-limits` | P5（接続の数と試みの頻度） |
| `tenant-partition-limit` | P6 |
| `usage-counters-in-patch` | 名前空間のパッチの出口と資格情報のコールバックのカウンター（metrics-and-billing） |
| `quota-usage-reporter` | ブローカーから `__<brand>_quota_usage` への書き込み |
| `quota-coordinator` | 配分と `__<brand>_quota_assignments` |
| `broker-backpressure` | 背圧 |
| `compacted-size-enforcement` | 圧縮のトピックの大きさの計数と throttle（broker の `compacted-storage-quota`、tiered の `compacted-storage-cap` を 1 つにした） |
| `remote-fetch-quota` | 過去の読み戻しをテナントの読み取りのクォータに数える |
| `group-request-quota` | グループの要求を要求のクォータに数える確認と、リバランスの嵐の負荷試験 |
| `unfair-throttle-metric` | NFR-008 の指標 |
| `noisy-neighbor-suite` | N1〜N10 |
| `cross-tenant-canary` | 合成監視の 2 つの論理クラスタで、互いの資源が見えないことを 1 分ごとに確かめる |
| `tenant-limit-override` | 論理クラスタの上限の上書きの手順と監査、runbook |

### E8 セキュリティと ACL

設計：[security-and-acls.md](architecture/security-and-acls.md)、[ADR-0028](decisions/0028-service-accounts-api-keys-and-sasl-plain.md)〜[ADR-0030](decisions/0030-encryption-and-audit-logs.md)

| Story | 内容 |
| --- | --- |
| `service-accounts` | サービスアカウントの作成・一覧・削除 |
| `api-keys` | キーの形、1 回だけの表示、失効、利用者の脱退での失効（`scope` に `schema_registry` を足せる形。connectors の `schema-registry-key-scope` を含む） |
| `credential-distribution` | `__<brand>_credentials` への配布、ブローカーのキャッシュ、起動時の読み終わりの待ち |
| `reauth-and-revocation` | `connections.max.reauth.ms`、急ぎの失効の PoC |
| `tenant-authorizer` | 境界の確かめ、CLUSTER の表、ACL の変換 |
| `rbac-roles` | ロールと管理 API の `authorize()` |
| `auth-failure-throttling` | 認証の失敗の遅延と IP の停止（Envoy の RBAC） |
| `edge-access-log-correlation` | Envoy のアクセスログとブローカーの接続の突き合わせ（監査ログの IP、IP ごとの失敗の集計。observability から） |
| `audit-log-pipeline` | `__<brand>_audit` → S3、索引、`GET /v1/audit-events` |
| `secret-scanning-partner` | GitHub のシークレットスキャンへの登録と通報の受け口 |
| `data-deletion-verification` | 論理クラスタの削除と完了を確かめるジョブ（法務：L4） |
| `console-access-pages` | 利用者・サービスアカウント・ロール・API キーの画面 |

### E9 制御面と配置

設計：[control-plane-and-provisioning.md](architecture/control-plane-and-provisioning.md)、[metadata-and-control.md](architecture/metadata-and-control.md)、[capacity.md](architecture/capacity.md)

| Story | 内容 |
| --- | --- |
| `control-plane-core` | 組織、論理クラスタの状態、`generation`、outbox |
| `outbox-relay` | outbox から SQS FIFO への送り出しと未送信の監視 |
| `desired-state-schema` | Zod から JSON Schema、Java の型の生成、契約テスト |
| `desired-state-reconcile` | 調停、10 分の再同期、`observed_generation` |
| `commands` | 命令、5 秒の待ち、202 と操作 |
| `kraft-snapshot-sync` | KRaft の写し（`kraft_snapshots`） |
| `lc-create-flow` | 作成の流れと合成の produce・fetch |
| `placement` | 得点、受け入れの条件、余力の判定 |
| `pc-provisioner` | 物理クラスタの作成の手順 1〜3 と Terraform のモジュール（infrastructure の `pc-aws-module` を含む） |
| `dataplane-component-rollout` | エージェント・コーディネーター・sni-router の物理クラスタ・AZ ごとの昇格 |
| `reassignment-executor` | 1 つずつ、同じ AZ、throttle、同時数、止まったものの取り消し |
| `rebalance-planner` | 再均衡の目標。Cruise Control の PoC と、だめなら自前の計画器 |
| `broker-scale-out` | ブローカーの追加と再均衡、NFR-007 の測定、runbook |
| `broker-retire` | cordon・降格・移動・縮小（metadata の `broker-cordon-and-decommission` を含む）、runbook |
| `metadata-limits-enforcement` | パーティションの上限を配置とポリシーで守る |
| `load-test-scale` | T3・T4・T5・T7・T11 |

### E10 コンソールと API

設計：[console-and-api.md](architecture/console-and-api.md)、[ADR-0034](decisions/0034-management-api-shape.md)〜[ADR-0036](decisions/0036-cli-and-terraform-provider.md)

| Story | 内容 |
| --- | --- |
| `management-api-foundation` | Hono の `/v1`、認証（Basic、Bearer、セッション）、エラーの形、`X-<Brand>-Request-Id` |
| `idempotency` | 冪等の保存と決定表 |
| `pagination` | 不透明なトークンと `as_of` |
| `operations-resource` | 202 と操作 |
| `rate-limits` | 組織ごとのトークンバケット |
| `openapi-contract` | OpenAPI の出力、壊す変更の検査、Go と TypeScript の生成 |
| `console-shell` | SPA の骨組み、CSP、i18n |
| `console-cluster-pages` | 論理クラスタ・トピック・接続の設定 |
| `client-rack-guidance` | コンソールと文書の AZ ID と `client.rack` の案内 |
| `console-login-stepup` | ログインとステップアップ |
| `console-onboarding` | 最初の 5 分と、その計測（SC-3 の E2E） |
| `cli` | コマンド、デバイスの認可、配布 |
| `terraform-provider` | 資源、`import`、受け入れのテスト、Registry への公開 |
| `cli-provider-release` | 署名と公開、戻し方（法務：L2） |

### E11 メトリクスと請求

設計：[metrics-and-billing.md](architecture/metrics-and-billing.md)、[ADR-0037](decisions/0037-capacity-unit-definition.md)〜[ADR-0039](decisions/0039-jpy-billing-and-free-tier.md)

| Story | 内容 |
| --- | --- |
| `cu-definition` | CU の定義を spec にし、クォータの値と同じ表から作る |
| `usage-pipeline` | `__<brand>_usage`、エージェント、Firehose、S3、時間の集計 |
| `retained-bytes` | 保持の量（tiered と一緒に） |
| `tiered-usage-metering` | テナントごとの S3 の保存量と写しの転送量 |
| `usage-reconciliation` | 照合と請求の保留 |
| `tenant-metrics-pipeline` | テナントの AMP、コレクター、ラベルの上限 |
| `metrics-api` | descriptors、query、export |
| `consumer-lag-metrics-api` | 遅れのメトリクス |
| `tenant-quota-metrics-api` | クォータの値、使用率、throttle の時間 |
| `txn-metrics-api` | 進行中のトランザクション、中止の率、上限の使用率 |
| `price-books-and-rating` | 単価の版と rating。パーティション-時と含む数 |
| `free-tier` | 無料の枠と、支払いの方法がない組織の制限 |
| `invoices` | 適格請求書、PDF、消費税の端数処理（法務・経理：L7） |
| `payments` | 決済の代行の選定と、カード・銀行振込 |
| `dunning-and-suspension` | 未払いと停止（法務：L8） |
| `budgets-and-alerts` | 予算と知らせ |
| `console-billing-pages` | 請求・予算・請求書の画面 |

### E12 運用と GA の準備

設計：[delivery.md](architecture/delivery.md)、[observability.md](architecture/observability.md)、[infrastructure.md](architecture/infrastructure.md)、[runbooks/](runbooks/README.md)

| Story | 内容 |
| --- | --- |
| `rolling-update-guard` | 関門 G1〜G7、止める仕組み、`broker_rollouts` の記録 |
| `upstream-upgrade-workflow` | U1〜U7 の自動化、`metadata.version` の 7 日の待ち（protocol の `upstream-release-tracking` を含む） |
| `ops-flags-topic` | `__<brand>_ops_flags` と break-glass の CLI |
| `kms-and-encryption-baseline` | 物理クラスタごとの CMK、EBS・S3 の暗号化、Bucket Keys |
| `edge-production` | EIP、zonal shift、アイドルのタイムアウト、Proxy Protocol、RBAC の許可リスト |
| `tenant-certificate-rotation` | 証明書の書き出し、配布、ロール、期限のアラート（security の `tls-certificate-rotation` を含む） |
| `osaka-standby` | 大阪の骨組み、制御面のウォームスタンバイ、ホスト名の向け直し |
| `terraform-guardrails` | Terraform の CI の検査 |
| `metadata-snapshot-backup` | KRaft のスナップショットの写しと復旧の訓練 |
| `synthetic-probes` | 合成監視（東京と大阪）、合成監視の論理クラスタとリーダーの固定 |
| `slo-and-burn-rate` | SLI の記録の規則、バーンレートのアラート、月次の報告 |
| `alert-runbook-lint` | アラートの規則に runbook の URL があることの CI の検査 |
| `ops-dashboards` | 物理クラスタ・耐久性・テナント・エッジ・ロール・DR・原価のダッシュボード（replication の `durability-dashboards`、tiered の `tiered-storage-dashboards` を含む） |
| `kraft-observability` | KRaft の監視とアラート |
| `broker-storage-alerts` | ディスク、I/O の待ち、クリーナー、回復の時間のアラート |
| `cardinality-guard` | ブローカーあたりの系列の数の監視 |
| `load-test-ga` | T6・T8・T10 |
| `pen-test` | 外部の侵入試験（テナントの分離と認証） |
| `ga-readiness` | GA の判定（quality.md の 5 節の E12 の基準、法務：L1〜L8） |

### E13 ディスクレスのトピック（S2）

設計：[tiered-and-object-storage.md](architecture/tiered-and-object-storage.md) の 8 節、[ADR-0020](decisions/0020-diskless-topics-adoption.md)

| Story | 内容 |
| --- | --- |
| `diskless-upstream-tracking` | KIP-1163・1164 の状態を四半期ごとに確かめる |
| `diskless-topics` | ADR-0020 の条件が満たされたら、別の種類のトピックとして出す。遅延の目標と単価 |

### E14 共有のグループと Streams のグループ

設計：[consumer-groups.md](architecture/consumer-groups.md) の 7 節、[ADR-0024](decisions/0024-share-and-streams-groups-staging.md)

| Story | 内容 |
| --- | --- |
| `share-groups-enable` | 条件 1〜4（名前空間の表、テナントごとの上限、障害注入、遅れのメトリクス）。MVP の直後 |
| `streams-groups-enable` | 条件（トポロジーの名前の付け外し、exactly-once、制限の確認）。S2 |

### E15 セルと S2 の規模

設計：[multi-tenancy-and-quotas.md](architecture/multi-tenancy-and-quotas.md) の 8 節、[metadata-and-control.md](architecture/metadata-and-control.md)、[infrastructure.md](architecture/infrastructure.md) の 10 節

| Story | 内容 |
| --- | --- |
| `cells` | セルの配置、Metadata のブローカーの一覧、コーディネーターの置き方 |
| `controller-quorum-five` | コントローラー 5 台（2・2・1）への移行（[ADR-0015](decisions/0015-kraft-dynamic-quorum-and-controller-sizing.md)） |
| `dataplane-account-split` | データ面のアカウントを物理クラスタの群ごとに分ける |
| `pc-auto-provisioning` | 余力の判定からの物理クラスタの自動の作成 |
| `lc-migration` | 論理クラスタの物理クラスタの間の移動（クラスタの間の複製とブートストラップの切り替え） |

### E16 スキーマレジストリ（S2）

設計：[connectors-and-schema.md](architecture/connectors-and-schema.md) の 3 節、[ADR-0040](decisions/0040-own-schema-registry.md)

| Story | 内容 |
| --- | --- |
| `sr-core-api` | API、ID の割り当て、Aurora の保存 |
| `sr-compatibility` | 3 つの形式の互換性の判定 |
| `sr-differential-tests` | 差分テスト |
| `sr-import-mode` | 移行（`IMPORT`） |
| `sr-console-and-terraform` | コンソールの画面、Terraform の `<brand>_schema` |

### E17 マネージドのコネクター（S3）

設計：[connectors-and-schema.md](architecture/connectors-and-schema.md) の 4 節、[ADR-0041](decisions/0041-managed-connectors-curated-plugins.md)〜[ADR-0042](decisions/0042-connector-runtime-isolation.md)

| Story | 内容 |
| --- | --- |
| `connector-runtime` | 別の EKS、Fargate、出口のプロキシ |
| `curated-connectors` | Debezium（MySQL・PostgreSQL）、S3 への書き出し、JDBC |
| `connector-isolation-tests` | 侵入テストの自動化 |
| `custom-connector-upload` | 利用者のプラグインの受け付けと走査（S3 後半） |

### E18 PrivateLink（S2）

設計：[infrastructure.md](architecture/infrastructure.md) の 6 節

| Story | 内容 |
| --- | --- |
| `privatelink` | 内部向けの NLB、エンドポイントサービス、Proxy Protocol の TLV によるエンドポイントの ID の検査、DNS の手順 |

### E19 Dedicated と BYOK（S2）

設計：[security-and-acls.md](architecture/security-and-acls.md) の 6.3 節、[ADR-0030](decisions/0030-encryption-and-audit-logs.md)、[ADR-0004](decisions/0004-logical-clusters-on-shared-physical-clusters.md)

| Story | 内容 |
| --- | --- |
| `dedicated-clusters` | 論理クラスタが 1 つだけの物理クラスタ、物理クラスタの時間での課金（別の ADR） |
| `byok-dedicated` | 利用者の KMS のキーを EBS と S3 に使う。キーの取り消しの検知と表示 |

## エージェントに任せないこと

- **契約（API の表、トピックの設定の表、名前空間の表、許された違いの表、望ましい状態のスキーマ、OpenAPI、CU の値）の確定**：変えると互換と分離に直接効く。
- **耐久性の設定の変更、Jepsen の検査の変更、既知の制約の一覧への追加**：Dev のテックリードと QA が判断する。
- **本家の版の取り込みの判断、`metadata.version` の引き上げ**：Dev のテックリードと Ops（[runbooks/deploy-and-rollback.md](runbooks/deploy-and-rollback.md)）。
- **unclean な選出、大阪への切り替えの判断**：Ops の責任者と Dev のテックリード（[runbooks/incident-response.md](runbooks/incident-response.md)、[runbooks/disaster-recovery.md](runbooks/disaster-recovery.md)）。
- **価格の値（CU-時、GB、パーティション-時、無料の枠）**：PM。
- **法務・経理の判断**（L1〜L8）。
- **負荷試験・PoC の結果の解釈**：数字は出せるが、上限・設計点・台数・退路（プロキシの案、filter chain の案）の採否は Dev と PM の判断。

## 延期の一覧

MVP の後に検討する。E13〜E19 に入れなかったもの。着手するときに `intent.md` から起票する（[intent.md](intent.md) の「MVP の後」と、各領域の文書の持ち越し）。

- **クラスタの間の複製（Cluster Linking に相当）**：大阪への災害復旧を分の単位の RPO にし、論理クラスタの移動に使う（[ADR-0045](decisions/0045-osaka-disaster-recovery-scope.md)）。S2 で Epic にする。
- **ストリーム処理（Flink に相当する SQL）**、**BYOC**、**複数のリージョンでの提供**、**GCP・Azure**。
- **OAUTHBEARER（OIDC）**、**SAML・OIDC の SSO と SCIM**（[security-and-acls.md](architecture/security-and-acls.md) の 4 節、[console-and-api.md](architecture/console-and-api.md) の 13 節）。
- **組織ごとの監査ログのトピックへの配信**、**運用者のアクセスの公開**（security-and-acls の 8.3・7 節）。
- **送信元 IP ごとの接続の頻度の制限**（外部のレート制限のサービス。[infrastructure.md](architecture/infrastructure.md) の 5.4 節）。
- **NLB を通さない入口**（Envoy に EIP を直接付ける。NFR-010 の S2 の目標 $0.08 のため。[ADR-0044](decisions/0044-nlb-sni-proxy-and-zonal-hostnames.md) の X）。
- **2 相コミット（KIP-939）**（[transactions-and-idempotence.md](architecture/transactions-and-idempotence.md) の 13 節）。
- **コンソールでのレコードの閲覧**、**環境（environment）の入れ物**（[console-and-api.md](architecture/console-and-api.md) の 14 節）。
- **REST Proxy**、**ブローカー側のスキーマの検証**（[connectors-and-schema.md](architecture/connectors-and-schema.md) の 1・3.8 節）。
- **KIP-714 のクライアントのテレメトリー**（[metrics-and-billing.md](architecture/metrics-and-billing.md) の 6.1 節）。
- **1 つの AZ だけの安い層**（[ADR-0004](decisions/0004-logical-clusters-on-shared-physical-clusters.md)）。
- **共有の物理クラスタでのテナントごとの S3 のキー**（security-and-acls の 6.3 節。S3）。
- **mTLS のクライアント証明書**（Dedicated の要望があれば ADR で）。
- **KIP-966 の後半（不正な回復）**（本家の状態を確かめてから。[replication-and-durability.md](architecture/replication-and-durability.md) の 5.2 節）。
- **複数のボリューム（JBOD）**（1 本の上限に近づいたら。[ADR-0009](decisions/0009-ebs-gp3-single-log-volume.md)）。
- **本家の 5.0 の取り込み**（従来のグループの既定の変更、古い版の削除の方針。別の ADR。[protocol-and-compatibility.md](architecture/protocol-and-compatibility.md) の 8.3 節）。
- **年間の約定（前払いのクレジット）**、**ドルの請求**（[metrics-and-billing.md](architecture/metrics-and-billing.md) の 13 節）。

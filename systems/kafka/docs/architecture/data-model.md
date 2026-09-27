# Data model: Kafka

データの置き場所の索引。制御面のテーブル、データ面の内部のトピック、KRaft の記録、S3 の置き方、メトリクスの時系列、開発リポジトリの spec の表を、領域をまたいで一覧にする。**各テーブル・記録の欄の詳細の正本は、下の索引の「定義の場所」の文書**で、ここは一覧と横断の規則と、複数の領域が欄を足す表の統合した定義（3.2 節）を書く。欄の型・索引・制約は、各変更の `spec.md` で決める。

前提の決定：物理クラスタの中は KRaft を正本、制御面は Aurora を正本にする（[ADR-0003](../decisions/0003-kraft-metadata-and-cluster-placement.md)）。テナントは論理クラスタで、資源の名前に `<lc-id>_` の接頭辞を付ける（[ADR-0025](../decisions/0025-tenant-namespace-patch.md)）。利用者のデータ（レコードの中身・キー・ヘッダー）は、Kafka のログ（EBS と S3）の外に置かない（[AGENTS.md](../../AGENTS.md)）。

## 1. 置き場所

| 置き場所 | アカウント | 中身 | 正本か |
| --- | --- | --- | --- |
| Aurora PostgreSQL 18（制御面、`public` スキーマ） | cp-prod | 組織、論理クラスタ、物理クラスタ、API キーのハッシュ、上限、命令、KRaft の写し、使用量の集計、請求、運用の記録 | 制御面の資源の正本 |
| Aurora（`auth` スキーマ） | cp-prod | 利用者、セッション、パスキー（Better Auth） | 正本 |
| Aurora（スキーマレジストリ用の別のクラスタ。S2） | cp-prod | スキーマ、サブジェクト | 正本 |
| KRaft（`__cluster_metadata`） | dp-prod（物理クラスタごと） | トピック、パーティション、ISR・ELR、設定、ACL、ブローカーの登録、機能の版 | 物理クラスタの資源の正本 |
| 内部のトピック（本家） | 同上 | オフセット、トランザクション、リモートのメタデータ、共有のグループの状態 | 本家の機能の正本 |
| 内部のトピック（`__<brand>_*`） | 同上 | 制御面からの配布、クォータ、使用量、監査の事象、運用のフラグ | 配布の写しか、S3 への送り出しの途中（4 節） |
| EBS（ブローカーのログ） | 同上 | テナントのレコード（新しい部分）、圧縮のトピック | 正本（複製 3） |
| S3（階層型） | dp-prod・dr-vault | テナントのレコード（閉じたセグメント） | 正本（RLMM と組で） |
| S3（その他） | log-archive・cp-prod・dp-prod・dr-vault | 監査ログ、耐久性の監査の事象、使用量の生の記録、KRaft のスナップショットの写し、運用のログ、請求書 | 監査・使用量は正本 |
| AMP（テナント） | cp-prod | テナント向けのメトリクス | 正本（大阪へ戻せない） |
| AMP（運用） | cp-prod | 運用のメトリクス（テナントのトピックの名前を含まない） | 正本 |
| sni-router のローカルの写し | dp-prod（エッジ） | `edge_routes`：論理クラスタ → 物理クラスタの対応と取得の時刻 | 写し（正本は制御面） |
| 開発リポジトリの spec の表 | — | API の表、トピックの設定の表、名前空間の表、CU の値、`instance_profiles`、パッチの一覧 | spec の正本（DB ではない。7 節） |

## 2. 横断の規則

- **識別子**：論理クラスタ `lc-` ＋ 小文字の英数字 6 文字、物理クラスタ `pc-`、利用者 `u-`、サービスアカウント `sa-`、スキーマレジストリ `sr-`、API キー `<brand>_key_…`・秘密 `<brand>_sec_…`（[ADR-0028](../decisions/0028-service-accounts-api-keys-and-sasl-plain.md)、リポジトリ共通の [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。物理クラスタの ID はテナントに見せない。
- **ホスト名**：ブートストラップ `<lc-id>.<region>.<brand>.<domain>:9092`、ブローカー `b<broker-id>-<lc-id>.<az-id>.<region>.<brand>.<domain>:9092`（[ADR-0044](../decisions/0044-nlb-sni-proxy-and-zonal-hostnames.md)）。
- **AZ**：AZ の名前ではなく AZ ID で持つ（`apne1-az1`・`az2`・`az4`。大阪は `apne3-az1`・`az2`・`az3`。[ADR-0043](../decisions/0043-aws-accounts-network-and-eks-layout.md)）。
- **時刻**：UTC で持つ。請求の時間と月だけ JST（[ADR-0039](../decisions/0039-jpy-billing-and-free-tier.md)）。
- **世代**：制御面からデータ面へ配る記録（`__<brand>_tenants`、`__<brand>_credentials`、`__<brand>_ops_flags`）は `generation` を持ち、古い値で上書きしない（[ADR-0031](../decisions/0031-control-plane-reconciliation-and-agent.md)）。
- **利用者のデータ**：レコードの中身・キー・ヘッダーは、EBS と階層型の S3 の外（Aurora、内部のトピック、監査の事象、メトリクス、ログ）に置かない。トピックの名前はテナントのメタデータとして、制御面の写し・テナントの AMP・監査ログ・本家のブローカーのログに入る。運用の AMP と自前の部品のログには入れない（ハッシュとトピックの ID にする）。
- **削除**：論理クラスタの削除は、KRaft → S3（7 日の猶予の後、前方一致 `lc-<id>_`）→ 大阪の写し → 制御面の行（組織の解約から 30 日）の順（[security-and-acls.md](security-and-acls.md) の 9 節）。削除の約束は、論理クラスタの削除と組織の解約だけが対象。請求と監査の記録は法定の期間だけ残す（法務・経理の確認待ち、intent.md の L7）。
- **災害復旧**：大阪へ写るものと写らないものは [ADR-0045](../decisions/0045-osaka-disaster-recovery-scope.md) の表。Aurora（Global Database）と、CRR の対象のバケットだけ（5 節の「大阪へ」の列）。

## 3. 制御面のテーブル（Aurora）

### 3.1 組織・利用者・認証

| テーブル | 中身（要約） | 定義の場所 |
| --- | --- | --- |
| `organizations` | `id`、名前、層の既定、請求の状態 | [control-plane-and-provisioning.md](control-plane-and-provisioning.md) の 18 節 |
| `users`、`sessions`、`passkeys`、`two_factors`（`auth` スキーマ） | Better Auth のモデル | [console-and-api.md](console-and-api.md) の 15 節 |
| `organization_members` | 組織と利用者、参加・無効化の日時 | 同上 |
| `invitations` | メール、ロール、トークンのハッシュ、期限 7 日 | 同上 |
| `device_authorizations` | CLI のデバイスの認可 | 同上 |
| `service_accounts` | `sa-`、組織、名前、作成者 | [security-and-acls.md](security-and-acls.md) の 16 節 |
| `api_keys` | `key_id`（`<brand>_key_…`）、持ち主、`scope`（`logical_cluster:<lc-id>`・`management`・`schema_registry:<sr-id>`）、`secret_sha256`、`status`、`generation`、失効、最終の使用 | 同上 |
| `role_bindings` | 主体、ロール、範囲 | 同上 |
| `identity_providers`・`identity_pools`（S2） | OAUTHBEARER の IdP | 同上 |
| `ip_allowlists` | 論理クラスタ、CIDR（sni-router が読み、Envoy の RBAC に配る。[infrastructure.md](infrastructure.md) の 5.4 節） | 同上 |
| `audit_events` | CloudEvents の索引、90 日、月ごとのパーティション | 同上、[ADR-0030](../decisions/0030-encryption-and-audit-logs.md) |

### 3.2 論理クラスタ・物理クラスタ・反映

| テーブル | 中身（要約） | 定義の場所 |
| --- | --- | --- |
| `logical_clusters` | 下の統合した定義 | [control-plane-and-provisioning.md](control-plane-and-provisioning.md) の 18 節、[multi-tenancy-and-quotas.md](multi-tenancy-and-quotas.md) の 15 節 |
| `logical_cluster_limits` | 層と CU からの既定と、上書きの値（帯域、要求、パーティション、パーティションの作成・削除、接続、接続の試み、`transactional.id`、InitProducerId、グループ、圧縮のトピックの大きさ）、上書きの理由と主体 | [multi-tenancy-and-quotas.md](multi-tenancy-and-quotas.md) の 15 節 |
| `physical_clusters` | 下の統合した定義 | [control-plane-and-provisioning.md](control-plane-and-provisioning.md) の 18 節、[metadata-and-control.md](metadata-and-control.md) の 13 節、[infrastructure.md](infrastructure.md) の 17 節 |
| `outbox` | 物理クラスタ、`kind`（`desired`・`command`）、論理クラスタ、`generation`、`command_id` | [control-plane-and-provisioning.md](control-plane-and-provisioning.md) の 18 節 |
| `commands` | 命令、状態、結果（Kafka のエラーコード）、冪等キー、期限（10 分） | 同上 |
| `operations` | 長い操作（`/v1/operations/{id}`） | [console-and-api.md](console-and-api.md) の 15 節 |
| `idempotency_keys` | 組織 × キー、要求のハッシュ、応答。日ごとのパーティション、48 時間 | 同上 |
| `kraft_snapshots` | 論理クラスタの資源（トピック、設定、ACL、グループ）の写し、`as_of`。大阪での作り直しの元（[ADR-0045](../decisions/0045-osaka-disaster-recovery-scope.md)） | [control-plane-and-provisioning.md](control-plane-and-provisioning.md) の 6.3 節 |
| `placement_decisions` | 候補の 2 つと得点、選んだ結果 | [ADR-0033](../decisions/0033-logical-cluster-placement.md) |
| `pc_capacity_samples` | `allocated`・`expected`・`observed`・`score`、`capacity_cu`、ブローカーの送信・EBS の基準に対する使用率の p95 | [control-plane-and-provisioning.md](control-plane-and-provisioning.md) の 18 節、[capacity.md](capacity.md) の 13 節 |

**統合した定義**（統合の工程で、領域ごとに分かれていた欄を 1 つにした）：

`logical_clusters`

| 欄 | 中身 | 足した領域 |
| --- | --- | --- |
| `id` | `lc-` ＋ 6 文字。接頭辞 `resource_prefix`（`lc-<id>_`）を導く | control-plane、multi-tenancy |
| `organization_id`、`display_name`、`tier`（`basic`・`standard`。S2 で `dedicated`） | — | control-plane |
| `state`、`generation`、`observed_generation` | [control-plane-and-provisioning.md](control-plane-and-provisioning.md) の 4.1 節の状態 | control-plane |
| `physical_cluster_id`、`cell_id`（S2） | 配置 | control-plane、multi-tenancy |
| `resource_prefix` | `lc-<id>_` | control-plane |
| `max_cu` | テナントが決めた CU の上限（Standard 1〜10、Basic 1〜5）。**multi-tenancy-and-quotas の提案の `cu` はこの欄に揃えた**（実際の使用の CU は `usage_hourly.cu`） | control-plane、multi-tenancy、metrics-and-billing |
| `created_at`、`deleted_at` | — | control-plane |

`physical_clusters`

| 欄 | 中身 | 足した領域 |
| --- | --- | --- |
| `id` | `pc-` ＋ ランダム | control-plane |
| `tier`、`region`、`state`（`planned`・`provisioning`・`burn-in`・`active`・`closed`・`retiring`・`retired`） | [control-plane-and-provisioning.md](control-plane-and-provisioning.md) の 7.2 節 | control-plane |
| `eks_cluster`、`namespace` | 載っている EKS と名前空間 | control-plane、infrastructure |
| `az_ids` | 3 つの AZ ID | infrastructure |
| `broker_count`、`node_instance_type` | ブローカーの台数と型 | control-plane、infrastructure |
| `capacity_cu` | ブローカーの台数 × ブローカーあたりの CU（[ADR-0048](../decisions/0048-broker-design-point-and-cost-model.md)） | control-plane、capacity |
| `strimzi_version`、`kafka_version` | 動いている版 | control-plane |
| `kraft_version`、`metadata_version`、`controller_count`、`partition_limit` | KRaft の状態と上限（10 万） | metadata-and-control |

### 3.3 ブローカー・メタデータ・耐久性・階層型

| テーブル | 中身（要約） | 定義の場所 |
| --- | --- | --- |
| `controllers` | ノードの ID、ディレクトリの ID、AZ ID、ボリューム、`voter`・`observer` | [metadata-and-control.md](metadata-and-control.md) の 13 節 |
| `broker_states` | cordon、降格、`lifecycle`、理由と主体（望ましい状態） | 同上 |
| `reassignment_jobs` | 再配置の計画、throttle、状態 | 同上 |
| `metadata_snapshot_backups` | KRaft のスナップショットの写し（オフセット、エポック、S3 のキー） | 同上 |
| `broker_volumes`、`broker_disk_events` | EBS のボリューム、6 時間の間隔、逼迫の段階の記録 | [broker-and-log-storage.md](broker-and-log-storage.md) の 13 節 |
| `durability_audit_results` | 照合の日、不変条件（AUD-1〜7）、照合の数、不一致の数 | [replication-and-durability.md](replication-and-durability.md) の 15 節 |
| `durability_incidents` | 不一致・カナリアの抜けの調査、影響したテナント | 同上 |
| `unclean_elections` | 人の判断の unclean な選出、承認者、失った範囲、連絡の時刻 | 同上 |
| `physical_cluster_buckets` | バケット、KMS のキー、大阪のバケットとアカウント | [tiered-and-object-storage.md](tiered-and-object-storage.md) の 15 節 |
| `logical_cluster_dr_copy` | 大阪への写しの有効・無効、有効・無効にした時刻、CRR の規則 | 同上 |
| `tiered_audit_runs` | 階層型の監査の実行、重大な破れの数、孤児のバイト | 同上 |

### 3.4 使用量・請求

| テーブル | 中身（要約） | 定義の場所 |
| --- | --- | --- |
| `usage_hourly` | 論理クラスタ × 時間（JST）の `cu`、バイト、GB-時、`partitions_max`、`partition_hours`、写しのバイト、照合の状態 | [metrics-and-billing.md](metrics-and-billing.md) の 15 節 |
| `price_books`、`rated_usage`、`free_tier_usage` | 単価の版（パーティション-時を含む）、時間ごとの金額、無料の枠 | 同上 |
| `invoices`、`invoice_lines`、`payments`、`credits`、`budgets`、`billing_accounts` | 請求書（適格請求書。行の種類に `partition_hours`）、支払い、クレジット、予算、請求先 | 同上 |

### 3.5 運用・リリース

| テーブル | 中身 | 定義の場所 |
| --- | --- | --- |
| `upstream_releases` | 本家の版、RC か GA か、取り込みの状態（U1〜U7 の結果）、機能の版、物理クラスタごとの適用の時刻 | [protocol-and-compatibility.md](protocol-and-compatibility.md) の 15 節 |
| `broker_rollouts` | 物理クラスタ、種類（本家の版・パッチ・設定・AMI・証明書）、前後のイメージの digest、状態（`planned`・`rolling`・`paused`・`done`・`rolled_back`）、開始・終了、承認者 | [delivery.md](delivery.md) の 6 節、[ADR-0050](../decisions/0050-rolling-upgrade-gates-and-upstream-tracking.md) |
| `rollout_gate_results` | ロール、ブローカー（またはコントローラー）、関門（G1〜G7）、結果、測った値、時刻 | 同上 |
| `ops_flags` | 物理クラスタ、フラグの名前、対象、値、`generation`、変えた主体と理由、break-glass で書いたか | [delivery.md](delivery.md) の 9 節、[ADR-0049](../decisions/0049-build-pipelines-artifacts-and-flags.md) |
| `dr_restores` | 災害復旧・訓練の記録：種類（訓練・本番）、対象、各段の完了の時刻、失った範囲の見積もり、結果 | [infrastructure.md](infrastructure.md) の 8 節、[runbooks/disaster-recovery.md](../runbooks/disaster-recovery.md) |
| `slo_monthly_reports` | 月、層、物理クラスタ、SLI、達成の値、予算の消費 | [observability.md](observability.md) の 14 節 |

### 3.6 スキーマレジストリ・コネクター（S2・S3）

| テーブル | 中身（要約） | 定義の場所 |
| --- | --- | --- |
| `schema_registries`、`schemas`、`subject_versions`、`subject_configs` | スキーマレジストリ（S2。制御面と別の Aurora のクラスタ） | [connectors-and-schema.md](connectors-and-schema.md) の 12 節 |
| `connectors`、`connector_plugins`、`egress_allowlists` | マネージドのコネクター（S3） | 同上 |

## 4. データ面の内部のトピック

全て物理クラスタごと。テナントの名前空間の外にあり、テナントの Metadata の応答に出ない。複製 3・`min.insync.replicas` 2（[ADR-0012](../decisions/0012-durability-settings-and-elr.md)）。`__<brand>_*` は内部の主体だけが読み書きできる。

### 4.1 本家のもの

| トピック | 書く人 → 読む人 | 鍵・中身（要約） | 保持 | 定義の場所 |
| --- | --- | --- | --- | --- |
| `__cluster_metadata` | KRaft | メタデータのログ（6 節） | スナップショットと本家の既定 | [metadata-and-control.md](metadata-and-control.md) の 6 節 |
| `__consumer_offsets` | 本家（グループのコーディネーター） | 接頭辞付きのグループの ID | 圧縮（S3 に上がらない。大阪へ戻らない） | [consumer-groups.md](consumer-groups.md) の 5・15 節 |
| `__transaction_state` | 本家（トランザクションのコーディネーター） | 接頭辞付きの `transactional.id` | 圧縮（同上） | [transactions-and-idempotence.md](transactions-and-idempotence.md) の 16 節 |
| `__remote_log_metadata` | 本家の RLMM | セグメントの状態の変化 | 無期限 | [tiered-and-object-storage.md](tiered-and-object-storage.md) の 2 節 |
| `__share_group_state` | 本家（共有のグループを有効にしてから。E14） | 共有のグループの状態 | 本家 | [consumer-groups.md](consumer-groups.md) の 15 節 |

### 4.2 この題材のもの（`__<brand>_*`）

| トピック | 書く人 → 読む人 | 鍵・中身（要約） | 保持 | 定義の場所 |
| --- | --- | --- | --- | --- |
| `__<brand>_tenants` | エージェント → ブローカー、コーディネーター | 論理クラスタ、接頭辞、層、状態、クォータの上限（`logical_cluster_limits` の写し）、`generation` | 圧縮 | [control-plane-and-provisioning.md](control-plane-and-provisioning.md) の 18 節 |
| `__<brand>_credentials` | エージェント → ブローカー | `key_id`、論理クラスタ、主体、`secret_sha256`、`cluster_role`、`not_after`、`generation`。失効は墓標 | 圧縮 | [security-and-acls.md](security-and-acls.md) の 3.4 節 |
| `__<brand>_quota_usage` | ブローカー → コーディネーター | 鍵 `tenant`。ブローカー × 窓の使用量、throttle の時間、パーティション・接続の数、コーディネーターのパーティションごとの `transactional.id`・グループの数 | 短い（削除） | [multi-tenancy-and-quotas.md](multi-tenancy-and-quotas.md) の 7.2・15 節 |
| `__<brand>_quota_assignments` | コーディネーター → ブローカー | 鍵 `(broker, tenant)`。種類ごとの配分、全体の使用量、計算の時刻 | 圧縮 | 同上 |
| `__<brand>_usage` | ブローカー → エージェント | 鍵 `(logical_cluster_id, broker_id)`。分ごとの使用量、`broker_incarnation` | 3 日 | [metrics-and-billing.md](metrics-and-billing.md) の 4.1 節 |
| `__<brand>_audit` | ブローカー → エージェント | テナントの監査の事象（CloudEvents） | 3 日 | [security-and-acls.md](security-and-acls.md) の 8.3 節 |
| `__<brand>_durability_audit` | ブローカー・コントローラー・RSM の包む層 → エージェント | 耐久性の監査の事象（`log_start_offset_advanced`、`log_truncated`、`leader_elected`、`isr_elr_changed`、`broker_unclean_shutdown`、`retention_config_changed`、`remote_segment_copied`・`remote_segment_deleted`・`remote_copy_failed`。レコードの中身なし） | 3 日 | [replication-and-durability.md](replication-and-durability.md) の 7.1 節、[tiered-and-object-storage.md](tiered-and-object-storage.md) の 6.7 節、[ADR-0046](../decisions/0046-operator-telemetry-and-cardinality.md) |
| `__<brand>_ops_flags` | エージェント（制御面が止まっているときは break-glass の CLI）→ ブローカー、プラグイン | 運用のフラグ、`generation` | 圧縮 | [delivery.md](delivery.md) の 9 節、[ADR-0049](../decisions/0049-build-pipelines-artifacts-and-flags.md) |

- 運用の論理クラスタ（合成監視とカナリア）のトピック（`probe-b<broker-id>`、カナリアの連番のトピック）は、内部のトピックではなく、運用の論理クラスタの普通のトピックとして名前空間を通る（[observability.md](observability.md) の 6 節）。
- `__<brand>_durability_audit` は、統合の工程で、replication-and-durability の 7.1 節の「運用の論理クラスタの内部のトピック」から、他の `__<brand>_` のトピックと同じ置き方に揃えた。
- テナントが `__consumer_offsets` のような名前のトピックを作ると、`lc-<id>___consumer_offsets` という普通のトピックになり、内部のトピックとは衝突しない（[multi-tenancy-and-quotas.md](multi-tenancy-and-quotas.md) の 4.1 節）。

## 5. S3 の置き方

| バケット | アカウント | キーの形 | 中身 | 保持・保護 | 大阪へ | 定義の場所 |
| --- | --- | --- | --- | --- | --- | --- |
| `<brand>-tiered-<pc-id>-apne1` | dp-prod | `lc-<id>_<topic>-<topicId>/<partition>/<20 桁の開始オフセット>-<segmentUuid>.{log,indexes,rsm-manifest}` | 閉じたセグメント | トピックの保持。古い版は 1 日 | 写しを有効にした論理クラスタの前方一致だけ（CRR、RTC） | [tiered-and-object-storage.md](tiered-and-object-storage.md) の 5.2 節 |
| 同上 | 同上 | `_rlmm/<日付>/partition-<n>.jsonl.zst` | RLMM のスナップショット（1 時間ごと） | 同上 | 常に | 同 6.5 節 |
| `<brand>-tiered-<pc-id>-apne3` | dr-vault | 同上（写した前方一致だけ） | 大阪の写し | 最大の保持＋7 日。削除を写さない | — | 同 6.6 節 |
| `<brand>-ops-<pc-id>-apne1` | dp-prod | `kraft-snapshots/<日付>/<offset>-<epoch>.checkpoint`（形は E3 で決める） | KRaft のスナップショットの写し（1 時間ごと） | 30 日 | 常に | [ADR-0015](../decisions/0015-kraft-dynamic-quorum-and-controller-sizing.md)、[infrastructure.md](infrastructure.md) の 7 節 |
| `<brand>-audit-apne1` | log-archive | `tenant/<org>/<日付>/…`、`durability/<pc-id>/<日付>/…`（Parquet） | 監査ログ、耐久性の監査の事象 | Object Lock（コンプライアンス）1 年 | 常に（大阪も Object Lock） | [ADR-0030](../decisions/0030-encryption-and-audit-logs.md)、[ADR-0046](../decisions/0046-operator-telemetry-and-cardinality.md) |
| `<brand>-usage-apne1` | cp-prod | `usage/raw/dt=<日付>/pc=<pc-id>/…parquet` | 使用量の生の記録（請求の根拠） | 10 年の案（経理・法務の確認待ち、L7） | 常に | [metrics-and-billing.md](metrics-and-billing.md) の 5 節 |
| `<brand>-logs-apne1` | log-archive | Firehose の既定の日付の前方一致 | 運用のログ | 1 年 | しない | [observability.md](observability.md) の 3 節 |
| 制御面のバケット | cp-prod | `invoices/<org>/<period>.pdf`（`invoices.pdf_s3_key`） | 請求書の PDF | 法定の期間（L7） | 常に | [metrics-and-billing.md](metrics-and-billing.md) の 7.5 節 |

## 6. KRaft の記録（索引だけ）

本家の記録の形をそのまま使う。制御面は KRaft を Admin API で読むだけで、記録を直接書かない。

| 記録 | この題材での使い方 | 参照 |
| --- | --- | --- |
| `TopicRecord`、`PartitionRecord`、`PartitionChangeRecord` | 接頭辞付きのトピックの名前、複製・ISR・ELR・リーダー・エポック | [replication-and-durability.md](replication-and-durability.md) の 15 節 |
| `ConfigRecord` | トピックの設定（許可リストの範囲。`segment.bytes` などの正本）、ブローカーの動的な設定（`cordoned.log.dirs`、throttle） | [broker-and-log-storage.md](broker-and-log-storage.md) の 13 節、[protocol-and-compatibility.md](protocol-and-compatibility.md) の 5 節 |
| `AccessControlEntryRecord` | テナントの ACL（`*` は PREFIXED の `<lc-id>_`） | [ADR-0029](../decisions/0029-tenant-scoped-acls-and-rbac.md) |
| `RegisterBrokerRecord`、`BrokerRegistrationChangeRecord` | `broker.rack`（AZ ID）、cordon のディレクトリ、fenced の状態 | [metadata-and-control.md](metadata-and-control.md) の 13 節 |
| `VotersRecord` | 動的なクォーラムの投票者 | 同上 |
| `FeatureLevelRecord` | `metadata.version`、`kraft.version`、`transaction.version`（2 で固定）、`group.version`、`share.version`・`streams.version`（0 で無効）、`eligible.leader.replicas.version`（1） | [delivery.md](delivery.md) の 6.3 節 |
| `ClientQuotaRecord` | 使わない（テナントのクォータは `__<brand>_quota_assignments`。[ADR-0027](../decisions/0027-dynamic-quota-coordinator-and-backpressure.md)） | — |
| `ProducerIdsRecord` | 本家のまま | — |

## 7. メトリクスの時系列（索引）

| 置き場所 | 系列（主なもの） | ラベルの規則 | 定義の場所 |
| --- | --- | --- | --- |
| テナントの AMP | `received_bytes`、`sent_bytes`、`received_records`、`sent_records`、`request_count`、`active_connection_count`、`connection_attempt_count`、`partition_count`、`retained_bytes`、`consumer_lag_offsets`、`consumer_lag_lso_gap_offsets`、`throttle_time_ms`、`cu_usage`、`quota_limit`、`client_connections`、`txn_oldest_open_age_seconds` | `logical_cluster_id` 必須。`topic`・`group` は可、`partition` は保存しない。論理クラスタあたり 1 万の系列まで | [metrics-and-billing.md](metrics-and-billing.md) の 6.2 節、[consumer-groups.md](consumer-groups.md)、[transactions-and-idempotence.md](transactions-and-idempotence.md) |
| テナントの AMP | `client_version_usage` | 同上 | [protocol-and-compatibility.md](protocol-and-compatibility.md) の 15 節 |
| 運用の AMP | 本家の JMX（URP、min ISR、オフライン、コントローラー、要求の時間など）、JVM・ノード、Envoy（`edge_cross_az_connections` など）、合成監視、SLI の記録の規則 | `physical_cluster_id`・`broker_id`・`az_id`。`logical_cluster_id` は上位 100 と `other`。`topic`・`partition`・`group`・`principal` なし。ブローカーあたり 2,000 系列まで | [observability.md](observability.md) の 2・4 節 |

## 8. 開発リポジトリの spec の表（DB ではない）

| 表 | 中身 | 定義の場所 |
| --- | --- | --- |
| `api_exposure` | API のキー、版の範囲、扱い（通す・絞る・拒否・フラグ）、返すエラー、名前空間の資源の場所 | [protocol-and-compatibility.md](protocol-and-compatibility.md) の 4・15 節 |
| `topic_config_policy` | 設定の名前、扱い、範囲、層ごとの上限、既定 | 同 5・15 節 |
| 名前空間の表 | API のキー × 版 → 資源の名前の場所（本家のメッセージの定義から生成） | [multi-tenancy-and-quotas.md](multi-tenancy-and-quotas.md) の 4.3・15 節 |
| 許された違いの表 | 差分テストで本家と違ってよい行 | [protocol-and-compatibility.md](protocol-and-compatibility.md) の 7.3 節 |
| CU の値 | 層ごとの 6 つの次元と、請求で CU に含むパーティションの数（クォータの値と同じ正本から作る） | [ADR-0037](../decisions/0037-capacity-unit-definition.md)、[ADR-0039](../decisions/0039-jpy-billing-and-free-tier.md) |
| `instance_profiles` | 型ごとの基準の帯域、設計点の W、ブローカーあたりの CU | [capacity.md](capacity.md) の 13 節 |
| パッチの一覧 | パッチの番号（P1〜P7）、理由、KIP、ADR、行数 | [delivery.md](delivery.md) の 4.1 節、[multi-tenancy-and-quotas.md](multi-tenancy-and-quotas.md) の 4.5 節 |
| フラグの一覧 | 名前、種類（release・運用・機能の版）、既定、持ち主、消す予定 | [delivery.md](delivery.md) の 9 節 |

## 9. 統合で決めたこと（2026-09-27）

- 各領域の「data-model への項目」の提案を、この索引に全て載せた。
- `logical_clusters` の `cu`（multi-tenancy-and-quotas）と `max_cu`（control-plane-and-provisioning）を `max_cu` に揃えた。実際の使用の CU は `usage_hourly.cu` にだけ持つ。
- `physical_clusters` の欄（control-plane-and-provisioning、metadata-and-control、infrastructure、capacity の提案）を 3.2 節の 1 つの定義にまとめた。
- 耐久性の監査の事象の置き場所を、物理クラスタの内部のトピック `__<brand>_durability_audit` に揃えた（replication-and-durability の 7.1 節を直した）。
- パーティション-時の課金（[ADR-0039](../decisions/0039-jpy-billing-and-free-tier.md)）のため、`usage_hourly.partition_hours` と請求書の行の種類 `partition_hours` を足した。

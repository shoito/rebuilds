# Control plane and provisioning: Kafka

制御面の構成と状態、望ましい状態の物理クラスタへの反映（データ面のエージェント）、物理クラスタの作成と拡張（EKS と Strimzi）、ブローカーの cordon と drain の手順、論理クラスタの配置の設計。前提の決定は、KRaft を物理クラスタの正本にし、制御面は望ましい状態を反映すること（[ADR-0003](../decisions/0003-kraft-metadata-and-cluster-placement.md)）、共有の物理クラスタの上の論理クラスタ（[ADR-0004](../decisions/0004-logical-clusters-on-shared-physical-clusters.md)）。この文書で決めたことは [ADR-0031](../decisions/0031-control-plane-reconciliation-and-agent.md)（反映とエージェント）、[ADR-0032](../decisions/0032-strimzi-for-physical-clusters.md)（Strimzi）、[ADR-0033](../decisions/0033-logical-cluster-placement.md)（配置）にある。

本家と Strimzi の振る舞いは、2026-09-27 に公式の文書・リポジトリで確かめた。確かめられなかったものは「未検証」と書く。要件 ID は、E9 の各変更の `spec.md` に移すときに振る。

## 1. 目的と範囲

- 利用者の操作（管理 API・コンソール・CLI・Terraform）を、制御面の状態に記録し、物理クラスタへ確実に反映する。
- 物理クラスタを作り、広げ、ブローカーを安全に入れ替え・退役させる。
- 新しい論理クラスタを、どの物理クラスタに置くかを決める。

範囲に入れないもの：

- 管理 API の形（版、冪等、ページング）。[console-and-api.md](console-and-api.md)。
- パーティションの再配置の計画と、cordon の本家の仕組みの使い方。metadata-and-control の領域。この文書は、手順の順序と、誰が何を呼ぶかを持つ。
- AWS のアカウント、VPC、NLB、SNI のプロキシ、DNS。infrastructure の領域。
- クォータの値の計算（動的なクォータ）。multi-tenancy-and-quotas の領域。

## 2. 本家・他の実装の形（確かめたこと）

- Kora の制御面は、HTTP の API で要求を受け、物理クラスタの設定（クォータ、API キー）を Kafka のプロトコルで物理クラスタへ送り、内部のトピックに保存する（[Kora](https://vldb.org/pvldb/vol16/p3822-povzner.pdf) の 3.1 節）。
- Strimzi は Apache License 2.0 の CNCF の incubating のプロジェクト（[strimzi-kafka-operator](https://github.com/strimzi/strimzi-kafka-operator)）。最新は 1.2.0（2026-08-20）で、Kafka 4.3.1 に対応し、KIP-1066 の cordon を縮小のときの自動の再配置で使う（Kafka 4.3 以降）（[CHANGELOG](https://github.com/strimzi/strimzi-kafka-operator/blob/main/CHANGELOG.md)）。
- Strimzi は 0.46.0 で ZooKeeper の構成を取り除き、0.48.0 で KRaft とノードプール（`KafkaNodePool`）を既定にした（同上）。
- Strimzi は、Cruise Control での再配置、ローリング更新、Drain Cleaner による安全なノードの退避を持つ（[Strimzi Overview 1.2.0](https://strimzi.io/docs/operators/latest/overview)）。1.1.0 で本家の新しい版の追加と「独自の Kafka の版」の扱いを改善した（CHANGELOG）。
- 本家の 4.3 の取り込みから Strimzi の対応までの間：Kafka 4.3.0 は 2026-05-22、Strimzi 1.1.0（4.3.0 に対応）は 2026-06-27。約 5 週間（[4.3.0 の発表](https://kafka.apache.org/blog/2026/05/22/apache-kafka-4.3.0-release-announcement/)、GitHub の Releases）。
- Node.js の Kafka の管理のクライアント：KafkaJS の最後の版は v2.2.4（2023-02-27）。confluent-kafka-javascript（MIT、最新 v1.10.1、2026-09-10）の管理のクライアントは「限られた部分」だけで、ACL と設定の変更の API を移行の文書に挙げていない（[MIGRATION.md](https://github.com/confluentinc/confluent-kafka-javascript/blob/master/MIGRATION.md)）。

## 3. 構成

```
管理 API・コンソール・CLI・Terraform
        │ HTTPS
        ▼
┌──────────────── 制御面（東京。ECS Fargate）─────────────────────────┐
│ api（Hono）── Aurora PostgreSQL 18（正本）                             │
│   │  1 トランザクションで：状態の行 ＋ generation の加算 ＋ outbox     │
│ outbox-relay ──▶ SQS FIFO：pc-<id>-desired.fifo（合図）               │
│              ──▶ SQS FIFO：pc-<id>-commands.fifo（命令）              │
│ internal-api（エージェント向け。望ましい状態の取得、結果の報告）      │
│ pc-provisioner（物理クラスタの作成・拡張の工程）                       │
│ placement（配置）・usage（使用量）・billing（請求）                    │
└───────────────────────────────▲─────────────┬───────────────────────┘
                 結果・実際の状態 │             │ 合図・命令（エージェントが取りに行く）
┌────────────── 物理クラスタ（EKS の名前空間）──┴───────────────────────┐
│ データ面のエージェント（Java 21、2 つ、Lease で 1 つが主）              │
│   ├─ Kafka の AdminClient（内部のリスナー、mTLS）                     │
│   └─ 内部のトピック：__<brand>_tenants、__<brand>_credentials など     │
│ Strimzi の Cluster Operator ── Kafka・KafkaNodePool のリソース         │
│ ブローカー（本家＋差し込み口＋パッチ）、KRaft のコントローラー 3 台    │
└──────────────────────────────────────────────────────────────────┘
```

- 制御面からデータ面へは、エージェントが取りに行く（データ面から外へ出る通信だけ）。制御面は物理クラスタの Kafka のリスナーに直接つながない。制御面が乗っ取られても、物理クラスタに送れるのは、エージェントが解釈できる望ましい状態と命令だけになる（[security-and-acls.md](security-and-acls.md) の T9）。
- エージェントから internal-api への認証は、EKS Pod Identity の IAM の役割で行う。経路（VPC Lattice の IAM の認証、PrivateLink など）は infrastructure の領域で決める。

## 4. 制御面の状態

### 4.1 論理クラスタの状態

```
requested ─▶ placing ─▶ provisioning ─▶ running ─▶ deleting ─▶ deleted
                 │             │            │
                 └─▶ failed ◀──┘            └─▶ suspended（未払い。produce を止める）─▶ running
```

| 状態 | 意味 | 利用者に見える `status.phase` |
| --- | --- | --- |
| `requested` | API で受けた | `PROVISIONING` |
| `placing` | 配置（10 節）の途中 | `PROVISIONING` |
| `provisioning` | 物理クラスタへの反映の途中 | `PROVISIONING` |
| `running` | `observed_generation >= generation` で、合成の produce・fetch が通った | `RUNNING` |
| `suspended` | 未払いで停止（[metrics-and-billing.md](metrics-and-billing.md) の 7.6 節） | `SUSPENDED` |
| `deleting`・`deleted` | 削除の途中・完了 | `DELETING` |
| `failed` | 配置できない、または反映が 10 分で終わらない | `FAILED`（運用者が対応） |

### 4.2 誰が正本か

[ADR-0003](../decisions/0003-kraft-metadata-and-cluster-placement.md) の分担を、反映の方式に当てはめる。

| 資源 | 正本 | 反映の方式 | 節 |
| --- | --- | --- | --- |
| 論理クラスタの登録（ID、接頭辞、層、状態） | 制御面 | 望ましい状態（調停） | 5 |
| API キー（ハッシュ、範囲、ロール） | 制御面 | 望ましい状態 | 5 |
| クォータの上限（層と CU の上限） | 制御面 | 望ましい状態。ブローカーごとの配分はクォータのコーディネーター | 5 |
| IP の許可リスト | 制御面 | 望ましい状態（SNI のプロキシへ。infrastructure の領域） | 5 |
| ブローカーの cordon の状態 | 制御面 | 望ましい状態（エージェントが `cordoned.log.dirs` を掛ける。[metadata-and-control.md](metadata-and-control.md) の 5.1 節） | 8 |
| トピック、パーティション、トピックの設定 | KRaft | 命令（管理 API から）。クライアントからも作れる | 6 |
| ACL | KRaft | 命令 | 6 |
| コンシューマーグループ、オフセット | KRaft | 読み取りだけ（オフセットの変更は S2） | 6 |

- 命令で扱う資源を調停しない理由：テナントは Kafka のプロトコルで、同じ資源を自由に作り・消す。制御面が「望ましい一覧」を持って調停すると、テナントが作ったトピックを消してしまう。
- Terraform のように宣言で管理したい利用者は、Terraform のプロバイダーの計画（plan）で差を見る（[console-and-api.md](console-and-api.md) の 7 節）。

## 5. 望ましい状態の反映（調停）

### 5.1 流れ

```
api ── BEGIN
         UPDATE logical_clusters SET ..., generation = generation + 1
         INSERT outbox(pc_id, kind='desired', lc_id, generation)
       COMMIT
outbox-relay ── SQS FIFO pc-<id>-desired.fifo
                  MessageGroupId = lc_id、MessageDeduplicationId = lc_id:generation
エージェント ── 受信（本文は lc_id と generation だけ。合図にすぎない）
             ── GET internal-api /internal/v1/pcs/{pc}/lcs/{lc}/desired  → 望ましい状態の全体（generation 付き）
             ── AdminClient と内部のトピックで、実際の状態を読む
             ── 差を埋める（冪等な操作だけ）
             ── POST internal-api .../lcs/{lc}/observed {observed_generation, conditions}
             ── SQS のメッセージを消す
```

- **合図と状態を分ける。** SQS のメッセージは「この論理クラスタが変わった」という合図だけにし、望ましい状態の全体は毎回 internal-api から取る（レベルで動く調停）。メッセージの重複・抜け・順序の入れ替わりがあっても、最終の状態は同じになる。
- **全体の再同期。** エージェントは 10 分ごとに、その物理クラスタのすべての論理クラスタを調停する。SQS の合図が失われても、10 分で反映する。
- **古い世代を捨てる。** 内部のトピックに書く記録には `generation` を持たせ、ブローカーは小さい世代の記録で上書きしない。
- 目標：望ましい状態の変更から `observed_generation` の更新まで p99 30 秒。論理クラスタの作成から `running` まで p99 60 秒（SC-3 の 5 分の内訳）。

### 5.2 望ましい状態の文書

```json
{
  "logical_cluster_id": "lc-7k2m9q",
  "generation": 42,
  "state": "running",
  "tier": "standard",
  "resource_prefix": "lc-7k2m9q_",
  "limits": { "max_cu": 10, "partitions": 2500, "connections": 10000 },
  "credentials": [
    { "key_id": "<brand>_key_...", "principal": "User:sa-...", "secret_sha256": "...", "cluster_role": "admin" }
  ],
  "ip_allowlist": ["203.0.113.0/24"],
  "topic_policy": { "profile": "standard-v1" }
}
```

- スキーマの正本は制御面の Zod の定義にする。CI で JSON Schema を出力し、エージェント（Java）の型を生成する。契約テストで、制御面の出力をエージェントが読めることを確かめる。
- 資格情報の件数が多い論理クラスタ（Standard で最大 250 個）は、文書が大きくなる。資格情報だけは差分（`since_generation`）で取れるようにする。

### 5.3 エージェントの責務

| 責務 | 詳しい設計 |
| --- | --- |
| 論理クラスタの登録・削除（`__<brand>_tenants`） | この文書、multi-tenancy-and-quotas の領域 |
| 資格情報の配布（`__<brand>_credentials`） | [security-and-acls.md](security-and-acls.md) の 3.4 節 |
| 命令の実行（トピック、ACL、設定） | 6 節 |
| cordon・降格・再配置の実行 | [metadata-and-control.md](metadata-and-control.md) の 4.3・5 節 |
| KRaft の資源の写しの制御面への送り（表示用） | 6.3 節 |
| 使用量・テナントのメトリクスの収集 | [metrics-and-billing.md](metrics-and-billing.md) の 4・5 節 |
| 監査ログの送り出し | [security-and-acls.md](security-and-acls.md) の 8.3 節 |
| RLMM のスナップショット、論理クラスタの削除の後の S3 の掃除 | [tiered-and-object-storage.md](tiered-and-object-storage.md) の 6.3・6.5 節 |
| ディスクの自動の拡張の要求 | [broker-and-log-storage.md](broker-and-log-storage.md) の 5.3 節（7.3 節の注意） |

- エージェントは 1 つのプロセスに多くの責務を持つ。責務ごとにスレッドとメトリクスを分け、1 つの責務の失敗（例：S3 の掃除の失敗）が、資格情報の配布を止めないようにする。
- 2 つのレプリカを置き、Kubernetes の Lease で 1 つを主にする。主の交代の間（最長 15 秒）は反映が止まるが、データの経路には影響しない。

### 5.4 エージェントの言語

- Java 21 と本家の AdminClient にする（[ADR-0031](../decisions/0031-control-plane-reconciliation-and-agent.md)）。[ADR-0001](../decisions/0001-upstream-brokers-and-stack.md) は TypeScript を既定にし、Admin API のクライアントの選定をこの領域に任せた。2 節のとおり、Node.js で ACL・設定・クォータの管理の API をすべて持つ保守されたクライアントがない。
- 本家の AdminClient はブローカーと同じ版で、ACL・IncrementalAlterConfigs・CreatePartitions・ListOffsets・DescribeConsumerGroups などをすべて持つ。ブローカーの差し込み口と同じ言語なので、内部のトピックの記録の形（Java の型）も共有できる。

## 6. 命令（KRaft が正本の資源）

### 6.1 流れ

```
api ── INSERT commands(id, lc_id, kind, payload, status='pending') ＋ outbox(kind='command')
    ── LISTEN command_<id>（最長 5 秒待つ）
outbox-relay ── SQS FIFO pc-<id>-commands.fifo（MessageGroupId = lc_id）
エージェント ── GET 命令の本文 → AdminClient で実行 → POST 結果（成功・Kafka のエラーコード）
internal-api ── UPDATE commands SET status, result ＋ NOTIFY command_<id>
api ── 5 秒以内に結果が来たら 201・200・4xx を返す
    ── 来なければ 202 と Location: /v1/operations/{id}
```

- 管理 API からは、ほぼ同期に見える。Terraform のプロバイダーは 202 のとき、操作を待つ。
- 同じ論理クラスタの命令は、FIFO のグループで順に実行する（作成の後の設定の変更が、作成より先に走らない）。
- 命令は冪等にする。トピックの作成で `TOPIC_ALREADY_EXISTS` が返り、設定が命令と同じなら成功として扱う（SQS の再配信に備える）。
- 命令の有効期限は 10 分。過ぎたら `failed`（`command_expired`）にし、実行しない。

### 6.2 命令の種類

| 種類 | AdminClient の操作 | 備考 |
| --- | --- | --- |
| `create_topic` | CreateTopics | 設定は CreateTopicPolicy が絞る（[protocol-and-compatibility.md](protocol-and-compatibility.md) の 5 節） |
| `delete_topic` | DeleteTopics | |
| `create_partitions` | CreatePartitions | |
| `alter_topic_configs` | IncrementalAlterConfigs | |
| `create_acls`・`delete_acls` | CreateAcls・DeleteAcls | 5.4 節の変換は名前空間のパッチが行う。エージェントは、テナントの主体として振る舞うための内部の主体で送る（6.4 節） |
| `describe_*` | 各 Describe | 表示の更新（6.3 節）で足りないとき |

### 6.3 表示のための写し

- エージェントは、30 秒ごとと、命令の実行の直後に、論理クラスタのトピック・パーティションの数・設定・ACL・グループの一覧を読み、差分を internal-api に送る。制御面は `kraft_snapshots` に持ち、コンソールと管理 API の一覧はここから返す。
- 応答に `as_of`（写しの時刻）を付ける。クライアントが Kafka のプロトコルで作ったトピックは、最長 30 秒で一覧に出る。

### 6.4 エージェントの主体

- エージェントは内部のリスナーで、内部の主体（`User:internal-agent-<pc-id>`）として接続する。super.users に入る。
- ただし、テナントの資源への命令は、名前空間のパッチと TenantAuthorizer を通す必要がある（接頭辞の付け外しと ACL の変換）。エージェントは、内部のリスナーで、SASL/PLAIN のユーザー名を `agent-<pc-id>@<lc-id>` の形にした「代理の接続」で送る（[multi-tenancy-and-quotas.md](multi-tenancy-and-quotas.md) の 4.2 節）。本家の PLAIN の検査と衝突しないかは E1 の PoC で確かめる。
- エージェントの主体に、テナントのトピックの Read・Write を与えない（[security-and-acls.md](security-and-acls.md) の 7 節）。

## 7. 物理クラスタ（EKS と Strimzi）

### 7.1 構成

| 部品 | 形 |
| --- | --- |
| EKS のクラスタ | 層（Basic・Standard）ごとに 1 つから始め、1 つの EKS に物理クラスタを 5 つまで載せる。物理クラスタは EKS の名前空間 `pc-<id>` にする。EKS の版の更新の影響の範囲を 5 つに絞る（infrastructure の領域と合わせる） |
| ノード | 物理クラスタ・AZ ごとのマネージドノードグループ。taint で、その物理クラスタのブローカーだけを載せる。1 ノードに 1 ブローカー（[broker-and-log-storage.md](broker-and-log-storage.md) の 2.1 節） |
| Strimzi | Cluster Operator だけを使う。Topic Operator と User Operator は使わない（トピックと ACL はエージェントが扱う。二重の管理を避ける） |
| `KafkaNodePool` | `controllers`（3 台、`roles: [controller]`）と、AZ ごとの `brokers-<az-id>`（`roles: [broker]`）。AZ ごとに分け、AZ ごとに台数を変えられるようにする |
| ブローカーのイメージ | 本家＋差し込み口＋パッチの自前のイメージ（`spec.kafka.image`）。署名と SBOM は delivery の領域 |
| 認証・認可 | テナント向けのリスナーは `authentication.type: custom`（SASL/PLAIN のコールバック）、`authorization.type: custom`（TenantAuthorizer） |
| rack | `rack.topologyKey: topology.k8s.aws/zone-id`（AZ ID のラベル。EKS のノードに付かなければ、ノードグループのラベル `<brand>.io/zone-id`。[ADR-0012](../decisions/0012-durability-settings-and-elr.md)、[infrastructure.md](infrastructure.md) の 3.3 節）。AZ の名前（`topology.kubernetes.io/zone`）は使わない |
| ストレージ | `persistent-claim`、StorageClass は EBS CSI の gp3 で、`kmsKeyId` に物理クラスタの CMK を指定（[security-and-acls.md](security-and-acls.md) の 6.2 節）、`allowVolumeExpansion: true` |
| テナント向けの証明書 | `brokerCertChainAndKey` で、公開の CA の証明書の Secret を指定（証明書の発行は infrastructure の領域） |
| 内部の TLS | Strimzi のクラスタの CA で、ブローカーの間とコントローラーを mTLS（1.3.0 で設定の範囲が広がった。Early Access の機能は使わない） |
| Drain Cleaner | 入れる。Kubernetes のノードの退避で、ブローカーの Pod が一度に消されないようにする |
| Cruise Control・再配置 | 計画は [metadata-and-control.md](metadata-and-control.md) の 4.2 節（Cruise Control を候補に、使えなければエージェントの小さな計画器）。実行はエージェントが `AlterPartitionReassignments` で行う（同 4.3 節）。Strimzi の `KafkaRebalance` と、縮小のときの Strimzi の自動の再配置は使わない（計画器を 2 つにしない） |

- Strimzi の Kafka のリソース（YAML）は、pc-provisioner が雛形から作り、GitOps のリポジトリに PR を出す。Argo CD で EKS へ適用する（S1 は人が PR を承認する）。
- Strimzi の版は固定し、本家の版の取り込み（ADR-0005、[protocol-and-compatibility.md](protocol-and-compatibility.md) の 8 節）と同じ PR で上げる。Strimzi が本家の新しい版に対応するまで、本家の取り込みは待つ。2 節の例（約 5 週間）は、ADR-0008 の「x.y.0 から 3 か月以内」の中に収まる。

### 7.2 物理クラスタのライフサイクル

```
planned ─▶ provisioning ─▶ burn-in ─▶ active ─▶ closed（新しい論理クラスタを置かない）─▶ retiring ─▶ retired
                                        ▲          │
                                        └──────────┘
```

| 手順 | 中身 | 目安の時間 |
| --- | --- | --- |
| 1. 計画 | 運用者か、配置の余力の判定（10.4 節）が `planned` の行を作る | — |
| 2. AWS の資源 | Terraform：CMK、S3 のバケット（[tiered-and-object-storage.md](tiered-and-object-storage.md)）、IAM の役割、ノードグループ | 20 分 |
| 3. Strimzi | GitOps の PR（Kafka、KafkaNodePool、エージェント、StorageClass）→ 承認 → Argo CD | 15 分＋承認 |
| 4. burn-in | 合成の負荷（produce・fetch・トランザクション）を 24 時間。耐久性の監査（[replication-and-durability.md](replication-and-durability.md) の 7 節）を 1 回通す | 24 時間 |
| 5. active | 配置の候補に入る | — |

- S1 の物理クラスタは 10 以下で、作る頻度は低い。手順 1〜3 は、運用者の承認を 1 回（手順 3 の PR）挟む。自動の作成は S2。

### 7.3 拡張

| 対象 | 方法 | 引き金 |
| --- | --- | --- |
| ブローカーの追加 | `brokers-<az-id>` の `replicas` を 3 つの AZ で同じだけ増やす（PR）。新しいブローカーには、パーティションの再配置で負荷を移す（metadata-and-control の領域） | 物理クラスタの観測の使用率（10.2 節）が 24 時間 60% を超える |
| ボリュームの拡張 | KafkaNodePool の `storage.size` を増やし、Strimzi が PVC を広げる | ディスクの使用率 75%（[broker-and-log-storage.md](broker-and-log-storage.md) の 5.3 節） |
| ノードの型の変更 | 新しい型のノードプールを足し、ブローカーを移す（8.2 節の drain） | capacity の領域の見直し |

- ボリュームの拡張の注意：broker-and-log-storage の 5.3 節は、エージェントが Elastic Volumes でボリュームを広げるとした。Strimzi の管理の下で EBS を直接広げると、PVC の宣言と実際の大きさがずれ、Strimzi の調停と衝突しうる。**エージェントは EBS を直接変えず、KafkaNodePool の `storage.size` を変える（PR ではなく、エージェントの権限での直接の更新を許す）**。ただし Strimzi のノードプールは、プールの全ブローカーの大きさを一緒に変える（ブローカーごとに変えられるかは未検証）。AZ ごとのプールなので、最小の単位は 1 つの AZ のブローカー全部になる。
- 論理クラスタの上限（CU）の引き上げは、クォータの変更だけで済み、物理クラスタの拡張を要さない（NFR-007 の 1 分）。

## 8. cordon と drain

cordon の本家の仕組み（KIP-1066、4.3）と、パーティションの移動の計画は metadata-and-control の領域で決める。ここでは、作業の種類ごとの順序を決める。

### 8.1 ブローカーの再起動（ローリング更新、ノードの OS の更新）

1. Strimzi の KafkaRoller が、1 台ずつ再起動する。
2. 本家の制御された停止（`controlled.shutdown.enable=true`）で、リーダーを他へ移してから止まる（[broker-and-log-storage.md](broker-and-log-storage.md) の 6.1 節）。
3. 同じ ID・同じボリュームで起動し、ISR に戻るのを待ってから次へ進む。
4. ノードの入れ替え（AMI の更新）は、Drain Cleaner が Kubernetes の退避を止め、Strimzi のローリングに任せる。ボリュームは同じ AZ の新しいノードに付け替える。

- 進める条件：物理クラスタの「`min.insync.replicas` を下回るパーティション」が 0、URP が 0。Strimzi の KafkaRoller が、再起動でパーティションが min ISR を下回らないかを確かめるかは未検証。確かめないなら、エージェントが条件を満たすまで、Strimzi のリソースの一時停止の注釈で待たせる。
- cordon はしない（再起動では配置を変えない）。

### 8.2 ブローカーの退役（縮小、ノードの型の変更）

退役の本家の側の手順は [metadata-and-control.md](metadata-and-control.md) の 5.2 節（cordon → 降格 → 同じ AZ への複製の移動 → 確認 → 正しい停止 → 登録の解除 → ボリュームの削除）にある。ここでは、Strimzi とエージェントの分担を決める。

```
1〜4. エージェント：cordon（望ましい状態）、降格、再配置、複製が 0 の確認（metadata-and-control の 5.2 節の 1〜4）
5.    pc-provisioner：KafkaNodePool の `replicas` を減らし、外すノードの ID を注釈（`strimzi.io/remove-node-ids`）で指定する PR
6.    Strimzi：そのブローカーを止め、KRaft の登録を消し、Pod を消す（metadata-and-control の 5.2 節の 5・6）
7.    pc-provisioner：PVC と EBS を消す（Strimzi の削除の設定に従う。消さない設定なら手で消す）
```

- Strimzi は、縮小のときに複製の残るブローカーを消さない安全の確認を持つ（未検証。E1 で確かめる）。確かめない場合も、エージェントの 4 の確認が終わるまで 5 の PR を出さない。
- Strimzi の縮小のときの自動の再配置（1.2.0 で KIP-1066 の cordon を使う）は無効にする。再配置の計画と実行をエージェントに一本化するため。
- 2 の移動の量は、ローカルに残っている部分だけ（階層型の保存。[tiered-and-object-storage.md](tiered-and-object-storage.md) の 6.4 節）。
- 4 までに失敗したら、cordon を外し、降格を戻して、元に戻せる。5 の後は戻さない。
- 1 つの物理クラスタで、同時に退役するブローカーは 1 台だけ（metadata-and-control の 5.2 節と同じ）。

### 8.3 ブローカーの障害（ボリュームの喪失）

- 同じ ID で空のボリュームで起動し、本家の複製で戻す（[ADR-0011](../decisions/0011-log-recovery-and-broker-replacement.md) の A）。cordon と drain はしない。

### 8.4 ディスクの逼迫

- 90% の cordon（[broker-and-log-storage.md](broker-and-log-storage.md) の 5.3 節）は、8.2 節の 1〜4 のうち必要な分（cordon と、一部の複製の移動）を行い、5 以降は行わない。使用率が 70% を下回ったら cordon を外す。

### 8.5 物理クラスタの退役（S2）

- 載っている論理クラスタを、クラスタの間の複製で別の物理クラスタへ移し、ブートストラップを切り替える（ADR-0003 で S2 に持ち越した）。S1 では物理クラスタを退役しない。

## 9. 論理クラスタの作成の流れ

```
1. api：requested。所有者の組織、層、名前、上限の CU を検証する
2. placement：2 つの候補から 1 つを選ぶ（10 節）→ placing → provisioning。outbox
3. エージェント：__<brand>_tenants に登録（接頭辞）、クォータの上限、資格情報（まだ 0 件）
4. 制御面：SNI のプロキシの経路表に、ブートストラップのホスト名 → 物理クラスタを足す（infrastructure の領域。xDS で配る案）
5. エージェント：observed_generation を返す
6. 制御面：合成の produce・fetch（内部の主体で、その論理クラスタの内部の試験用のトピック）→ running
```

- DNS はリージョンのワイルドカード（`*.<region>.<brand>.<domain>`）と AZ ごとのワイルドカード（`*.<az-id>.<region>.<brand>.<domain>`）の 4 つだけで、論理クラスタごとの DNS の記録を作らない。DNS の伝わる時間を作成の時間から外すため（[ADR-0044](../decisions/0044-nlb-sni-proxy-and-zonal-hostnames.md)）。経路表は sni-router が xDS で配る（[infrastructure.md](infrastructure.md) の 5.4 節）。
- 6 の試験用のトピックは、テナントの一覧に出さず、パーティションの上限に数えない。

## 10. 配置

### 10.1 方針

[ADR-0003](../decisions/0003-kraft-metadata-and-cluster-placement.md) のとおり、論理クラスタは 1 つの物理クラスタに載せ、候補を 2 つ無作為に選んで空いている方に置く（2 つの選択の力。Kora の論文の 5.3 節）。この節は、「空いている」の測り方と、受け入れの条件を決める（[ADR-0033](../decisions/0033-logical-cluster-placement.md)）。

### 10.2 物理クラスタの得点

```
allocated(pc) = Σ max_cu(lc) / (capacity_cu(pc) × K)           # CU の割り当ての合計。K は過剰の割り当ての倍率（初期値 4）
expected(pc)  = Σ max(1, p95_7d_cu(lc)) / capacity_cu(pc)        # 載っている論理クラスタの実際の使用の見込み
observed(pc)  = max(ブローカーの負荷（CPU・要求の処理時間）, ネットワーク, ディスクの I/O, ディスクの容量, 複製の数) の 7 日の p95 の使用率
score(pc)     = max(allocated(pc), expected(pc), observed(pc))
```

- `capacity_cu(pc)` は、ブローカーの台数 × ブローカーあたりの CU（capacity の領域で決める）。
- `p95_7d_cu(lc)` は、論理クラスタの時間ごとの CU（[metrics-and-billing.md](metrics-and-billing.md) の 3 節）の 7 日の p95。作ったばかりの論理クラスタは 1 とする。
- `allocated` は、ADR-0003 の「CU の割り当ての合計」と、[multi-tenancy-and-quotas.md](multi-tenancy-and-quotas.md) の 8 節の「CU の割り当ての合計の使用率」に当たる。上限の CU（テナントが決めた `max_cu`）をそのまま足すと、上限まで使う論理クラスタは少ないので、物理クラスタが空いたままになる。そこで倍率 K で割り、過剰の割り当てを許す。K は、全論理クラスタが同時に上限の 1/K を超える確率が十分に小さいことを、使用量の実績で確かめて見直す。
- 上限への急な増加は、クォータの背圧（ADR-0004）と拡張（7.3 節）で受ける。
- `observed` の項目は、multi-tenancy-and-quotas の 8 節の Kora のセルの負荷の定義（平均のブローカーの負荷、複製の数の使用率、帯域の使用率）を含む。

### 10.3 受け入れの条件と選び方

| # | 条件 | 値（初期値） |
| --- | --- | --- |
| 1 | 状態が `active` で、層が同じ | — |
| 2 | 新しい論理クラスタを足した後の `score` | 0.7 未満 |
| 3 | 新しい論理クラスタの `max_cu` | `capacity_cu(pc)` の 25% 以下（1 つの論理クラスタが物理クラスタを占めない） |
| 4 | パーティションの合計（層の上限で足した後） | 物理クラスタのパーティションの上限の 80% 未満（上限は metadata-and-control の領域） |
| 5 | 組織の論理クラスタの分散 | 同じ組織の Standard の論理クラスタが 3 つ以上あるとき、同じ物理クラスタに 50% を超えて載せない |

- 条件を満たす物理クラスタから 2 つを無作為に選び、`score` の低い方に置く。1 つしかなければそれに置く。0 なら、作成を `failed`（`capacity_unavailable`）にせず、キューに入れて運用者を呼ぶ（10.4 節）。
- 5 は、物理クラスタの障害で、1 つの組織の本番がすべて止まることを減らすため。

### 10.4 余力

- 層ごとに、受け入れ可能な物理クラスタが 2 つ未満、または平均の `score` が 0.6 を超えたら、新しい物理クラスタの計画（7.2 節の 1）を作り、運用者に知らせる。
- 作成に 1 日（burn-in を含む）かかるので、余力の判定は 1 週間先の見込み（論理クラスタの作成の速さ × 平均の CU）で行う。

### 10.5 配置を変えない

- 一度置いた論理クラスタは、S1 では動かさない。物理クラスタが混んだら、ブローカーを足す（7.3 節）。
- 動かすのは S2（クラスタの間の複製と、ブートストラップの切り替え）。

## 11. 障害と振る舞い

| 事象 | 起きること | 検知 | 対応 |
| --- | --- | --- | --- |
| 制御面の停止 | 作成・変更・命令が止まる。データの経路は続く | 合成監視（管理 API） | 制御面の復旧。データ面の影響はない（ADR-0003） |
| outbox-relay の停止 | 反映が遅れる | outbox の最古の未送信の経過時間 | relay の復旧。エージェントの 10 分の再同期でも追いつく |
| SQS の遅れ・重複 | 反映が遅れる、同じ合図が 2 回 | 反映の遅れのメトリクス | 調停は冪等なので、重複は害がない |
| エージェントの停止 | 反映と命令が止まる。資格情報の新規・失効が遅れる | `observed_generation` の遅れ（5 分でアラート） | Lease で副が主になる。両方止まれば runbook |
| エージェントの不具合で誤った状態を書く | 資格情報・登録の誤り | 反映の後の合成の produce・fetch の失敗、`tenant_boundary_violation` | エージェントの版を戻す。内部のトピックを制御面の正本から全部書き直す（再同期） |
| 命令の失敗（Kafka のエラー） | 管理 API がエラーを返す | 命令の失敗の率 | 利用者のエラーなら 4xx。ブローカーのエラーなら再試行 |
| Strimzi の調停の停止・不具合 | ローリング更新・拡張が止まる。ブローカーは動き続ける | Strimzi の調停のメトリクス、Kafka のリソースの `Ready` の状態 | Strimzi の版を戻す。止めている間は拡張をしない |
| 退役の途中の失敗 | 再配置が止まる | 再配置の進み | cordon を外して戻す（8.2 節） |
| 受け入れ可能な物理クラスタがない | 論理クラスタの作成が待ちになる | 待ちの件数 > 0 | 物理クラスタを足す（runbook） |

## 12. セキュリティ

| 脅威 | 対策 |
| --- | --- |
| 制御面の乗っ取りで、全物理クラスタに任意の設定を入れる | エージェントが受けるのは、スキーマで決まった望ましい状態と命令だけ。ブローカーの設定、super.users、耐久性の設定は、望ましい状態に入れない（Strimzi のリソースの変更は GitOps の PR で、人の承認を要する） |
| エージェントの資格情報の悪用 | エージェントの主体は、テナントのトピックの Read・Write を持たない。internal-api は、エージェントに、自分の物理クラスタの論理クラスタの状態だけを返す（IAM の役割と `pc_id` の一致） |
| internal-api への偽の結果の報告 | 報告は IAM の役割で認証し、`pc_id` の一致を確かめる。`observed_generation` が `generation` を超える報告を拒否する |
| GitOps のリポジトリの改ざん | 保護されたブランチ、必須のレビュー、署名されたコミット（delivery の領域） |
| 命令の中の資源の名前によるインジェクション | 命令の本文はスキーマで検証し、トピックの名前は本家の規則（英数字、`.`、`_`、`-`、249 文字以内）で検証する |

## 13. テスト

- 性質ベーステスト（調停）：任意の望ましい状態の列を、任意の順序・重複・抜けで合図しても、再同期の後の実際の状態が、最後の望ましい状態と同じ（ADR-0003 の Confirmation を具体にした）。
- 性質ベーステスト（命令）：同じ命令を任意の回数だけ実行しても、結果が 1 回と同じ。
- 性質ベーステスト（配置）：任意の物理クラスタの状態と論理クラスタの作成の列で、受け入れの条件（10.3 節）を破る配置をしない。
- 結合テスト：制御面を止めても、既存の論理クラスタの produce・fetch が続く。エージェントの主を止めても、15 秒以内に副が主になり、反映が続く。
- 結合テスト（Strimzi）：開発の EKS で、ブローカーの追加、ローリング更新、退役（8.2 節）を、合成の負荷を流したまま行い、`acks=all` の書き込みを失わない（replication-and-durability の障害注入と一緒に）。
- 時間の測定：論理クラスタの作成から `running` までの p99（目標 60 秒）。

## 14. ADR

| ADR | 決定 |
| --- | --- |
| [0031](../decisions/0031-control-plane-reconciliation-and-agent.md) | 制御面の状態は outbox → SQS の合図 → エージェントの取得で反映する（レベルで動く調停）。KRaft が正本の資源は命令で扱う。エージェントは Java 21 と本家の AdminClient で書く |
| [0032](../decisions/0032-strimzi-for-physical-clusters.md) | 物理クラスタは EKS の上の Strimzi（Cluster Operator とノードプール）で動かす。Topic・User Operator は使わない。自前のオペレーターは作らない |
| [0033](../decisions/0033-logical-cluster-placement.md) | 配置は、受け入れの条件を満たす 2 つの無作為な候補から、実際の使用に基づく得点の低い方を選ぶ。S1 では論理クラスタを動かさない |

## 15. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E1 | `strimzi-dev-cluster` | 開発の EKS に、自前のブローカーのイメージで Strimzi の物理クラスタを作る |
| E1 | `agent-skeleton` | エージェント（Java）の骨組み、Lease、internal-api の認証 |
| E9 | `control-plane-core` | 組織、論理クラスタの状態（4.1 節）、`generation`、outbox |
| E9 | `outbox-relay` | outbox から SQS FIFO への送り出し。未送信の監視 |
| E9 | `desired-state-reconcile` | 5 節の調停、10 分の再同期、`observed_generation` |
| E9 | `desired-state-schema` | Zod から JSON Schema、Java の型の生成、契約テスト |
| E9 | `commands` | 6 節の命令、5 秒の待ち、202 と操作 |
| E9 | `kraft-snapshot-sync` | 6.3 節の写し |
| E9 | `lc-create-flow` | 9 節の作成の流れと合成の produce・fetch |
| E9 | `placement` | 10 節の得点、受け入れの条件、余力の判定 |
| E9 | `pc-provisioner` | 7.2 節の手順 1〜3（Terraform、GitOps の PR） |
| E9 | `broker-scale-out` | 7.3 節のブローカーの追加（再配置は metadata-and-control と一緒に） |
| E9 | `broker-retire` | 8.2 節の cordon・drain・縮小 |
| E9 | `volume-expansion` | 7.3 節の KafkaNodePool の `storage.size` の変更（broker-and-log-storage と一緒に） |
| E12 | `rolling-update-guard` | 8.1 節の進める条件と、Strimzi の一時停止 |

## 16. 段階ごとの変化

| 項目 | S1 | S2 | S3 |
| --- | --- | --- | --- |
| 物理クラスタの作成 | 運用者の承認つきの PR | 余力の判定からの自動（承認は事後） | 同じ |
| 配置 | 2 つの選択、動かさない | ＋セル（物理クラスタの中）、論理クラスタの移動 | ＋複数のリージョン |
| Dedicated | なし | 論理クラスタ 1 つの物理クラスタとして作る | 同じ |
| エージェント | 物理クラスタに 1 つ（2 レプリカ） | 同じ。責務が重くなれば分ける | BYOC では利用者のアカウントで動かす（別の ADR） |

## 17. 未解決の問い

- 自前のオペレーターを、どの条件で作るか。
- Cruise Control を使うか（metadata-and-control の領域と一緒に）。
- エージェントの責務が増えたとき、プロセスを分けるか。
- 1 つの EKS に載せる物理クラスタの数。
- 物理クラスタの作成を、いつ人の承認なしにするか。

### 決定（2026-09-27、既定案）

- **自前のオペレーター**：作らない。次のどれかが起きたら、ADR-0032 を見直す。(1) Strimzi が本家の新しいマイナー版に 2 か月以上対応しない、(2) 名前空間のパッチやセル（S2）に必要な制御が Strimzi のリソースで表せない、(3) Strimzi の不具合で 2 回以上、ローリング更新が止まる。
- **Cruise Control**：metadata-and-control の領域の決定に従う。この文書の手順（8.2 節）は、どちらでも同じ順序で動く。
- **エージェントの分割**：S1 は 1 つのプロセス。責務ごとのスレッドとメトリクスで分ける。使用量の収集がエージェントの CPU の 50% を超えたら、使用量を別のプロセスにする。
- **1 つの EKS の物理クラスタの数**：5 まで。
- **自動の作成**：S2 から。S1 の間に、手動の作成を 3 回以上、手順どおりに問題なく行ってから。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| Strimzi の KafkaRoller が、再起動の前に min ISR を確かめるか | E1 で Strimzi のソースと試験で確かめる |
| Strimzi のノードプールで、ブローカーごとにボリュームの大きさを変えられるか | E1 |
| ブローカーあたりの CU（`capacity_cu` の元） | 初期値は [ADR-0048](../decisions/0048-broker-design-point-and-cost-model.md)（Standard 3.2、Basic 13.3）。E1 の負荷試験（T1・T2）で確かめる |

## 18. quality.md・runbooks・data-model への項目

### quality.md

- 調停の性質ベーステストを、制御面の変更の必須のテストにする。
- 論理クラスタの作成から `running` までの p99（目標 60 秒）と、望ましい状態の反映の遅れの p99（目標 30 秒）を、本番での品質検証の指標にする。
- ローリング更新・退役の間の、`acks=all` の書き込みの喪失 0 件（障害注入と一緒に）。

### runbooks

- `runbooks/agent-down.md`：エージェントの両方のレプリカが止まったとき。反映の遅れの影響（資格情報の新規・失効）と、手動の再同期。
- `runbooks/reconcile-drift.md`：望ましい状態と実際の状態が食い違ったまま戻らないとき。内部のトピックの全部の書き直し。
- `runbooks/physical-cluster-create.md`：7.2 節の手順と burn-in の合否。
- `runbooks/broker-scale-out.md`、`runbooks/broker-retire.md`：7.3・8.2 節。途中の失敗からの戻し方。
- `runbooks/placement-capacity-exhausted.md`：受け入れ可能な物理クラスタがないとき。
- `runbooks/strimzi-upgrade.md`：Strimzi の版の更新と戻し方（本家の取り込みと一緒に）。

### data-model（索引への追加の提案）

| テーブル | 中身 |
| --- | --- |
| `organizations` | `id`、名前、層の既定、請求の状態 |
| `logical_clusters` | `id`（`lc-`）、`organization_id`、名前、層、`state`、`generation`、`observed_generation`、`physical_cluster_id`、`resource_prefix`、`max_cu`、作成・削除の時刻 |
| `physical_clusters` | `id`（`pc-`）、層、リージョン、`state`（7.2 節）、EKS のクラスタ、名前空間、ブローカーの台数、`capacity_cu`、Strimzi の版、本家の版 |
| `outbox` | `id`、`physical_cluster_id`、`kind`（`desired`・`command`）、`logical_cluster_id`、`generation`、`command_id`、作成・送信の時刻 |
| `commands` | `id`、`logical_cluster_id`、`kind`、`payload`、`status`、`result`（Kafka のエラーコード）、`requested_by`、`idempotency_key`、作成・完了・期限の時刻 |
| `kraft_snapshots` | `logical_cluster_id`、資源の種類、名前、中身（JSON）、`as_of` |
| `placement_decisions` | `logical_cluster_id`、候補の 2 つと得点、選んだ物理クラスタ、時刻（配置の検証と調査のため） |
| `pc_capacity_samples` | `physical_cluster_id`、時刻、`allocated`、`expected`、`observed`、`score` |
| `__<brand>_tenants`（データ面の内部のトピック） | `logical_cluster_id`、接頭辞、層、状態、`generation` |

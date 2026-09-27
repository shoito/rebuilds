# Architecture: Kafka

全体像と横断的な方針。領域ごとの設計は、同じディレクトリの各ファイル（7 節の表）に書く。データの置き場所の索引は [data-model.md](data-model.md)、品質は [quality.md](../quality.md)、Epic と Story は [roadmap.md](../roadmap.md)、SLO と運用は [runbooks/](../runbooks/README.md) にある。

## 1. 全体構成

形は、Confluent Cloud の Kora に倣い、中央の制御面と、独立した多数のデータ面（物理クラスタ）に分ける（[Kora の論文](https://vldb.org/pvldb/vol16/p3822-povzner.pdf) の 3 節、2026-09-27 に確認）。

```
テナントのアプリ（Kafka のクライアント）
   │ TLS（SNI = ブートストラップか、AZ ID を含むブローカーごとのホスト名）＋ SASL/PLAIN（API キー）
   ▼
NLB（AZ ごとに EIP、cross-zone 無効）──▶ Envoy（SNI の振り分け。TLS を終端しない。同じ AZ のブローカーへ）
   ▼                                        ▲ xDS：sni-router（論理クラスタ → 物理クラスタ、ブローカーの居場所）
┌──────────── データ面：物理クラスタ（東京の 3 AZ、EKS ＋ Strimzi）─────────────────────┐
│  ブローカー（本家の Apache Kafka 4.x ＋ 差し込み口の拡張 ＋ 名前空間のパッチ）            │
│    ├─ ローカルのディスク（EBS gp3）：新しいセグメント。3 つの複製（AZ ごとに 1 つ）         │
│    └─ RemoteStorageManager ──▶ S3：閉じたセグメント（階層型の保存）                       │
│  KRaft のコントローラー（3 台、AZ ごとに 1 台）：物理クラスタのメタデータの正本            │
│  クォータのコーディネーター（3 つ）：テナントのクォータをブローカーへ配り直す             │
│  データ面のエージェント（Java）：望ましい状態の反映、命令の実行、使用量・監査の送り出し   │
└──────────────────────────────────────────────────────────────────────┘
   │ エージェントが取りに行く（データ面から外へ出る通信だけ）：
   │   SQS の合図・命令を受け、internal-api から望ましい状態を取り、結果・写し・使用量を送る
   ▼
┌──────────── 制御面（東京。災害復旧は大阪のウォームスタンバイ）──────────────────────┐
│  管理 API（api.<brand>.<domain>）・コンソール・CLI・Terraform のプロバイダー           │
│  internal-api・outbox-relay（→ SQS FIFO）・配置・物理クラスタの作成と拡張              │
│  API キー・サービスアカウント・ロール・上限の望ましい状態                              │
│  メトリクスの API・使用量の集計と請求                                                  │
│  Aurora PostgreSQL 18（制御面の正本）                                                  │
└──────────────────────────────────────────────────────────────────────┘
```

| コンポーネント | 責務 |
| --- | --- |
| NLB と Envoy（SNI のプロキシ） | TLS の SNI のホスト名で、要求を同じ AZ のブローカーへ振り分ける。TLS は終端せず、Kafka のプロトコルも解釈しない。論理クラスタごとの IP の許可リストを掛け、アクセスログに送信元 IP を残す（[ADR-0044](../decisions/0044-nlb-sni-proxy-and-zonal-hostnames.md)） |
| sni-router | 論理クラスタ → 物理クラスタの対応を internal-api から取って写しを持ち、ブローカーの居場所は EKS から直接見て、Envoy に xDS で配る。制御面が止まっても最後の写しで動く |
| ブローカー | 本家の Apache Kafka。produce・fetch・グループ・トランザクションの処理。テナントの名前空間とクォータを、要求ごとに適用する（[ADR-0004](../decisions/0004-logical-clusters-on-shared-physical-clusters.md)、[ADR-0025](../decisions/0025-tenant-namespace-patch.md)） |
| KRaft のコントローラー | 物理クラスタのメタデータ（トピック、パーティションの配置、ACL、設定）の正本。作成時から動的なクォーラム（[ADR-0003](../decisions/0003-kraft-metadata-and-cluster-placement.md)、[ADR-0015](../decisions/0015-kraft-dynamic-quorum-and-controller-sizing.md)） |
| 階層型の保存 | 閉じたセグメントを S3 へ上げ、ローカルは 6 時間で消す。コンシューマーは 1 本のログとして読む（[ADR-0002](../decisions/0002-replicated-log-with-tiered-storage.md)、[ADR-0019](../decisions/0019-tiered-storage-lifecycle-and-dr-copy.md)） |
| クォータのコーディネーター | 物理クラスタごとにデータ面に置く。テナントごとのクォータを、使用量に応じてブローカーに配り直す（Kora の動的なクォータ。論文の 5.2 節）。制御面が止まっても配分は続く（[ADR-0027](../decisions/0027-dynamic-quota-coordinator-and-backpressure.md)） |
| データ面のエージェント | Java 21 と本家の AdminClient。制御面の合図を受けて望ましい状態を取り、内部のトピック（`__<brand>_tenants`・`__<brand>_credentials` など）へ反映する。トピックと ACL の命令を実行する。使用量・監査の事象を S3 へ送る（[ADR-0031](../decisions/0031-control-plane-reconciliation-and-agent.md)） |
| 制御面 | テナント・論理クラスタ・API キー・請求の正本。論理クラスタを物理クラスタに配置し、物理クラスタを作り、拡張する。データ面へ自分から接続しない |

原則は 3 つ。

- **正しさは本家に任せ、差分を小さく保つ。** 複製・トランザクション・グループの意味は、本家の Apache Kafka の実装そのものを使う。拡張は差し込み口で行い、本家のコードへのパッチは最小にする（[ADR-0001](../decisions/0001-upstream-brokers-and-stack.md)）。
- **受け付けた書き込みは、3 つの AZ のうち 2 つ以上に届いてから成功を返す。** 耐久性の既定値はテナントに変えさせない。古いデータは S3 に移して、ディスクを小さく保つ（[ADR-0002](../decisions/0002-replicated-log-with-tiered-storage.md)、[ADR-0012](../decisions/0012-durability-settings-and-elr.md)）。
- **テナントは論理クラスタ。物理クラスタは共有する。** 名前空間・クォータ・ACL で分け、分離の単位を 1 つにする。データの経路（produce・fetch・クォータの配分・認証）は制御面に依存しない（[ADR-0003](../decisions/0003-kraft-metadata-and-cluster-placement.md)、[ADR-0004](../decisions/0004-logical-clusters-on-shared-physical-clusters.md)）。

### 用語

| 用語 | 意味 |
| --- | --- |
| 論理クラスタ | テナントに見えるクラスタ（`lc-` ＋ 6 文字）。ブートストラップのホスト名、トピックの名前空間、クォータ、ACL を持つ。Kora の LKC に相当 |
| 物理クラスタ | 1 つの KRaft のクォーラムと、そのブローカーの集まり（`pc-`）。複数の論理クラスタを載せる。Kora の PKC に相当 |
| セル | 物理クラスタの中のブローカーの部分集合。1 つの論理クラスタのパーティションを 1 つのセルに閉じ込め、接続の数と障害の範囲を絞る（S2。Kora の論文の 5.3 節） |
| CU（容量の単位） | 論理クラスタの容量の単位。層ごとの 6 つの次元（書き込み、読み取り、パーティション、接続、接続の試み、要求）の組（[ADR-0037](../decisions/0037-capacity-unit-definition.md)） |

## 2. 規模の段階

| 段階 | 論理クラスタ | 書き込み（全体のピーク） | パーティション（全体、複製の前） | 構成 |
| --- | --- | --- | --- | --- |
| S1（MVP） | 1,000 | 2 GB/秒 | 20 万 | 東京の 3 AZ（AZ ID で `apne1-az1`・`az2`・`az4`）。物理クラスタは 10 以下。Basic と Standard の層。制御面は大阪にウォームスタンバイ。データ面の大阪への写しは、写しを有効にした論理クラスタの S3 のセグメントだけ |
| S2 | 1 万 | 20 GB/秒 | 200 万 | 物理クラスタを数十に。セル、コントローラー 5 台。専用の物理クラスタ（Dedicated）と BYOK、PrivateLink、ディスクレスのトピック、クラスタの間の複製（大阪への災害復旧）、スキーマレジストリ |
| S3 | 10 万 | 200 GB/秒 | 2,000 万 | 複数のリージョン（東京・大阪の両方で提供、海外は必要に応じて）。BYOC。マネージドのコネクターとストリーム処理 |

- S1 のブローカーの台数は、スループットではなくパーティションの数で決まる（約 150 台。スループットだけなら約 27 台）。原価はパーティション-時の課金で回収する（[capacity.md](capacity.md) の 10 節、[ADR-0039](../decisions/0039-jpy-billing-and-free-tier.md)）。

## 3. 非機能要件

数値は、本家と他社の公開の値を参考にした目標である。S1 の値は、E1 の PoC と負荷試験で確かめるまで「未検証」の目標として扱う。SLO として計る値の正本は [runbooks/README.md](../runbooks/README.md) の 1 節にある。

| ID | 項目 | S1 の目標 | 備考 |
| --- | --- | --- | --- |
| NFR-001 | 耐久性 | `acks=all` で成功を返した書き込みは失わない。1 つの AZ の喪失で RPO 0 | 複製 3、`min.insync.replicas=2`、AZ ごとに 1 つの複製、unclean なリーダーの選出を禁止、ELR を有効（[ADR-0002](../decisions/0002-replicated-log-with-tiered-storage.md)、[ADR-0012](../decisions/0012-durability-settings-and-elr.md)）。アプリの fsync をしないので、2 つ以上の AZ で同時にメモリーを失うと、同期していない末尾を失いうる（利用者の文書に書く）。リージョンの喪失は NFR-009 |
| NFR-002 | 可用性（produce と fetch） | Standard：月間 99.95%（S1）→ 99.99%（S2）。Basic：99.5% | 外からの合成監視の produce・consume の成否で測る（[ADR-0047](../decisions/0047-slos-synthetic-probes-and-alerts.md)）。Confluent Cloud は Standard・Enterprise で最大 99.99%（2 eCKU 以上）、Basic で 99.5%（[Cluster types](https://docs.confluent.io/cloud/current/clusters/cluster-types.html)、2026-09-27 に確認）。MSK はマルチ AZ で 99.9%（[MSK SLA](https://aws.amazon.com/msk/sla)、2026-09-27 に確認） |
| NFR-003 | produce の遅延 | Standard：`acks=all`、同じリージョンのクライアント、1 KB のレコードで p99 50ms 以内、p50 10ms 以内。Basic：p99 100ms | ブローカーで要求を受けてから応答を返すまで。クライアントの `linger.ms` を除く。SLO は合成監視の最悪のブローカーの値で測る。未検証（PoC で測る） |
| NFR-004 | 端から端までの遅延 | produce の開始から、追いついているコンシューマーが受け取るまで p99 100ms 以内（Basic は 200ms） | ディスクレスのトピック（S2）は別の目標（p99 1 秒以内）にする |
| NFR-005 | パーティションあたりのスループット | 書き込み 10 MB/秒、読み取り 30 MB/秒を保証する | 参考：MSK Express は 1 パーティションあたり最大 15 MB/秒、MSK Serverless は書き込み 5 MB/秒・読み取り 10 MB/秒（[MSK quota](https://docs.aws.amazon.com/msk/latest/developerguide/limits.html)、2026-09-27 に確認）。未検証 |
| NFR-006 | 論理クラスタあたりのスループット | Standard：書き込み 250 MB/秒、読み取り 750 MB/秒まで（10 CU）。物理クラスタ 1 つで書き込み 2 GB/秒 | Confluent Cloud の Standard と同じ上限（同上の Cluster types）。S2 の Dedicated で上限を上げる |
| NFR-007 | 容量の伸び縮み | 論理クラスタの上限の引き上げは 1 分以内（クォータの変更だけ）。物理クラスタへのブローカーの追加と再配置は 30 分以内 | 階層型の保存で、移すのはローカルの新しいセグメントだけにする。Confluent Cloud は 10 eCKU まで数秒で伸びる（同上）。未検証 |
| NFR-008 | テナントの分離 | 他のテナントの資源が見える事象 0 件。クォータの中で使うテナントが、他のテナントのせいで絞られる時間を週 5 分以内（99.95%）にし、これを満たすテナントを 99.9% 以上にする | 後半は Kora の指標に倣う。Kora は動的なクォータで、この目標を満たすテナントの割合を 99% から 99.9% 超に上げた（論文の 5.2 節）。測り方は [multi-tenancy-and-quotas.md](multi-tenancy-and-quotas.md) の 7.5 節 |
| NFR-009 | 復旧 | **AZ の障害**：RPO 0、リーダーの移動を含めて RTO 1 分以内。**リージョンの障害（制御面）**：RPO 1 分・RTO 1 時間。**リージョンの障害（データ面）**：大阪から戻せるのは、**大阪への写しを有効にした論理クラスタ**（Standard、既定は無効）の、S3 に上がったログの前の部分だけ。失いうる範囲は、閉じていないセグメント（最大 1 時間か 256 MiB）＋ LSO で止まった部分 ＋ 上げと CRR の遅れ（99.9% は 15 分以内）。**戻らないもの**：写しを無効にした論理クラスタのレコード、圧縮のトピック（Kafka Streams の changelog を含む）、コンシューマーのオフセット、トランザクションの状態、テナントのメトリクスの履歴。書き込みの経路の作り直しは目標 4 時間、履歴の戻しは目標 24 時間（どちらも SLA にしない） | 範囲の表は [ADR-0045](../decisions/0045-osaka-disaster-recovery-scope.md)。S2 のクラスタの間の複製で、RPO を分の単位にする。**PM の確認事項**：この書き方で利用者に約束するか、SLA と利用規約の文言（intent.md の L6）と合わせて確定する |
| NFR-010 | 1 GB の書き込みあたりの原価 | Standard のトピック（読み取り 3 倍、保持 7 日）、ブローカーの平均の使用率が設計点の 40% 以上のとき、**NLB の処理のバイトを含めて $0.11 以下**。パーティションで台数が決まる分の原価は、パーティション-時の課金で回収し、この目標の外に置く | 内訳は下の表と [capacity.md](capacity.md) の 8・10 節（u = 40% で $0.107、u = 60% で $0.100）。**S2 の目標**：元の $0.08（NLB を通さない経路、Savings Plans）。ディスクレスのトピックで $0.02 以下。**PM・Dev の確認事項**：統合の工程で $0.08 から改めた（6 節の決定） |

### NFR-010 の見積もり（ネットワークの部分）

AZ をまたぐ転送は、送信と受信で各 $0.01/GB（[AWS Architecture Blog](https://aws.amazon.com/blogs/architecture/exploring-data-transfer-costs-for-aws-managed-databases/)、東京の単価は AWS Price List API、2026-09-27 に確認）。複製 3 を 3 つの AZ に置くと、1 GB の書き込みごとに次が掛かる。

| 経路 | 量 | 費用 |
| --- | --- | --- |
| プロデューサー → リーダー | 平均 2/3 GB が AZ をまたぐ | 約 $0.013 |
| リーダー → 2 つのフォロワー | 2 GB が AZ をまたぐ | $0.04 |
| コンシューマー ← ブローカー | fetch-from-follower（KIP-392）で同じ AZ の複製から読めば 0。NLB と Envoy も同じ AZ に留める（[ADR-0044](../decisions/0044-nlb-sni-proxy-and-zonal-hostnames.md)） | 0 |
| NLB の処理のバイト | 書き込み 1 GB と読み取り 3 GB が通る（1 GB あたり $0.006） | 約 $0.024 |
| ブローカー → S3（階層型の保存） | 同じリージョンの S3 への転送は無料（VPC のゲートウェイ型のエンドポイント） | S3 の PUT の費用だけ |

ネットワークだけで約 $0.077/GB になる。Kora の論文も、マルチ AZ のクラスタの最大のネットワークの費用は AZ をまたぐ複製だとしている（4.2.2 節）。これが、S2 でディスクレスのトピックを足す理由である（[ADR-0002](../decisions/0002-replicated-log-with-tiered-storage.md)、[ADR-0020](../decisions/0020-diskless-topics-adoption.md)）。`client.rack` を設定しない利用者の読み取りは、AZ をまたぐ転送を足す（[capacity.md](capacity.md) の 5 節）。

## 4. 技術スタック

| 層 | 選定 | 理由 |
| --- | --- | --- |
| ブローカー・コントローラー | 本家の Apache Kafka 4.x（KRaft）。拡張とパッチは Java 21 | 正しさと互換性を本家から得る（[ADR-0001](../decisions/0001-upstream-brokers-and-stack.md)）。本家の 4.0 でブローカーは Java 17 以上が要る（[4.0.0 の発表](https://kafka.apache.org/blog/2025/03/18/apache-kafka-4.0.0-release-announcement/)、2026-09-27 に確認）。4.2 は Java 25 に対応した |
| 階層型の保存 | 本家の RemoteLogManager ＋ Aiven の OSS の S3 の RemoteStorageManager（Apache License 2.0）を土台にし、テナントの検査と計数の層（`TenantAwareRemoteStorageManager`）で包む | KIP-405 は本家の 3.9 で本番向けになった（[Tiered Storage GA Release Notes](https://cwiki.apache.org/confluence/x/9xDOEg)、2026-09-27 に確認）。RSM を自前で書き起こさない（[ADR-0018](../decisions/0018-s3-remote-storage-manager.md)） |
| 物理クラスタの運用 | EKS（EC2、EBS gp3）の上の Strimzi（Cluster Operator とノードプール） | ブローカーの入れ替えとローリング更新を宣言的に行う。自前のオペレーターを作らない（[ADR-0032](../decisions/0032-strimzi-for-physical-clusters.md)）。Kora も Kubernetes を使う（論文の 3.1 節） |
| 入口 | NLB（cross-zone 無効）＋ Envoy（TCP のプロキシ、TLS の SNI で振り分け）＋ sni-router（Go の xDS のサーバー） | Kafka のプロトコルを解釈しないので、プロキシを自前で書かない。Kora と同じ SNI の振り分け（論文の 3.1 節、[ADR-0044](../decisions/0044-nlb-sni-proxy-and-zonal-hostnames.md)） |
| データ面のエージェント、クォータのコーディネーター | Java 21 と本家の AdminClient | 管理の API をすべて本家と同じ版のクライアントで扱い、ブローカーの差し込み口と型を共有する（[ADR-0031](../decisions/0031-control-plane-reconciliation-and-agent.md)） |
| 制御面 | TypeScript（Hono＋Zod）、Aurora PostgreSQL 18、outbox → SQS FIFO | 他の題材と同じ |
| コンソール | React の SPA（他の題材と同じ構成）、Better Auth | [ADR-0035](../decisions/0035-console-and-login.md) |
| CLI・Terraform のプロバイダー | Go。OpenAPI から生成した 1 つの SDK | Terraform Plugin Framework が Go。CLI も同じ言語で、1 つのバイナリで配る（[ADR-0036](../decisions/0036-cli-and-terraform-provider.md)） |
| IaC | Terraform（AWS）、Argo CD（Strimzi の CR などの Kubernetes の資源） | 他の題材と同じ。Kubernetes の中は GitOps |
| 可観測性 | OpenTelemetry（ADOT）→ AMP（運用とテナントで分ける）、X-Ray、CloudWatch Logs。ブローカーの JMX は OpenTelemetry の Java エージェントで集める | [ADR-0046](../decisions/0046-operator-telemetry-and-cardinality.md) |
| 互換性テスト | Java のクライアント、librdkafka、franz-go、Sarama、confluent-kafka-javascript の行列（KafkaJS は凍結）。本家のブローカーとの差分テスト | [ADR-0005](../decisions/0005-compatibility-policy.md)、[ADR-0008](../decisions/0008-client-matrix-differential-tests-and-version-tracking.md) |
| 耐久性テスト | Jepsen の Kafka のワークロード（queue、txn）と障害注入。本番の耐久性の監査（AUD-1〜7） | Jepsen は Kafka のテストのライブラリを公開している（[jepsen.tests.kafka](https://jepsen-io.github.io/jepsen/jepsen.tests.kafka.html)、2026-09-27 に確認）。[ADR-0014](../decisions/0014-durability-audit-and-fault-injection.md) |

## 5. 主な決定

どれも `accepted`（0001〜0005 と intent.md は、統合の工程の修正を当ててから 2026-09-27 に `proposed`・`draft` から改めた）。状態の一覧は [decisions/README.md](../decisions/README.md)。

| ADR | 決定 |
| --- | --- |
| [0001](../decisions/0001-upstream-brokers-and-stack.md) | データ面は本家の Apache Kafka のブローカーを使い、差し込み口と最小のパッチで拡張する |
| [0002](../decisions/0002-replicated-log-with-tiered-storage.md) | 既定のトピックは、ローカルのディスクの 3 つの複製と S3 への階層型の保存にする |
| [0003](../decisions/0003-kraft-metadata-and-cluster-placement.md) | 物理クラスタのメタデータは KRaft を正本にし、制御面は望ましい状態を反映する |
| [0004](../decisions/0004-logical-clusters-on-shared-physical-clusters.md) | テナントは、共有の物理クラスタの上の論理クラスタにする |
| [0005](../decisions/0005-compatibility-policy.md) | 互換の範囲は、動かしている本家のブローカーの API から管理の API を除いたものにし、行列と差分テストで確かめる |
| [0006](../decisions/0006-api-exposure-table-and-denial.md) | API ごとの扱いを 1 つの表で持ち、拒否は Authorizer で本家と同じエラーを返す |
| [0007](../decisions/0007-topic-config-allowlist.md) | トピックの設定は許可リストで絞り、耐久性の設定は同じ値の指定だけを通す |
| [0008](../decisions/0008-client-matrix-differential-tests-and-version-tracking.md) | 行列は具体の版で持ち、差分テストは生の要求を正規化して比べ、本家は x.y.1 以降を取り込む |
| [0009](../decisions/0009-ebs-gp3-single-log-volume.md) | ブローカーごとに EBS gp3 のログのボリュームを 1 本付け、容量はローカルの保持から出して自動で広げる |
| [0010](../decisions/0010-segment-retention-and-compaction-defaults.md) | セグメントは 256 MiB・1 時間で切り替え、圧縮は資源を絞って増やし、圧縮のトピックのローカルの量に上限を掛ける |
| [0011](../decisions/0011-log-recovery-and-broker-replacement.md) | 不正な停止の後は本家の回復と ELR に任せて回復の時間を 5 分に抑え、ボリュームを失ったら空で複製し直す |
| [0012](../decisions/0012-durability-settings-and-elr.md) | 複製 3・AZ ID の rack・`min.insync.replicas=2`・unclean な選出の禁止・ELR を固定し、アプリの fsync はしない |
| [0013](../decisions/0013-fetch-from-follower.md) | fetch-from-follower は本家の `RackAwareReplicaSelector` で有効にし、クライアントの `client.rack` に任せる |
| [0014](../decisions/0014-durability-audit-and-fault-injection.md) | 本番で耐久性の監査とカナリアを持ち、Jepsen の形の障害注入を PR ごとと日次で回す |
| [0015](../decisions/0015-kraft-dynamic-quorum-and-controller-sizing.md) | KRaft は作成時から動的なクォーラムにし、S1 は 3 台、S2 は 5 台の専用のコントローラーにする |
| [0016](../decisions/0016-partition-placement-reassignment-and-cordon.md) | 再配置は同じ AZ の中で 1 つずつ行い、退役は cordon から始め、劣化したブローカーは降格する |
| [0017](../decisions/0017-metadata-limits-and-snapshots.md) | 物理クラスタのパーティションと、ブローカーの複製に上限を置き、スナップショットは本家の既定で実測して見直す |
| [0018](../decisions/0018-s3-remote-storage-manager.md) | S3 の RemoteStorageManager は OSS の実装を土台にし、テナントの検査と計数の層で包む |
| [0019](../decisions/0019-tiered-storage-lifecycle-and-dr-copy.md) | 削除のポリシーのトピックはすべて階層型にし、大阪への写しは論理クラスタごとに選べる S3 の複製で行う |
| [0020](../decisions/0020-diskless-topics-adoption.md) | ディスクレスのトピックは、本家が冪等とトランザクションに対応してから、別の種類のトピックとして出す |
| [0021](../decisions/0021-transaction-settings-and-tenant-limits.md) | トランザクションの防御を固定で有効にし、`transactional.id` の数と InitProducerId の頻度にテナントごとの上限を掛ける |
| [0022](../decisions/0022-exactly-once-verification.md) | exactly-once の正しさは、Jepsen の形の試験と Kafka Streams の長時間の試験で毎日確かめ、本家の版の更新の関門にする |
| [0023](../decisions/0023-consumer-group-protocols-and-limits.md) | classic と consumer の両方のプロトコルを本家の既定で出し、グループにテナントごとの上限を掛ける |
| [0024](../decisions/0024-share-and-streams-groups-staging.md) | 共有のグループと Streams のグループは機能の版で無効にしておき、条件を満たしてから有効にする |
| [0025](../decisions/0025-tenant-namespace-patch.md) | 名前空間は `<lc-id>_` の接頭辞を、要求の出入口の表駆動のパッチで付け外しし、テナントは SNI と API キーの一致で決める |
| [0026](../decisions/0026-tenant-quotas-and-tier-limits.md) | クォータは本家の仕組みで掛けられるものは本家で、掛けられないものは小さなパッチで、テナントの単位に掛ける |
| [0027](../decisions/0027-dynamic-quota-coordinator-and-backpressure.md) | クォータのコーディネーターを物理クラスタごとにデータ面に置き、使用量に応じて配り直し、ブローカーは背圧で全体を守る |
| [0028](../decisions/0028-service-accounts-api-keys-and-sasl-plain.md) | 資格情報は論理クラスタに絞った API キーにし、SASL/PLAIN を TLS の上で使い、検証用のハッシュを内部のトピックで配る |
| [0029](../decisions/0029-tenant-scoped-acls-and-rbac.md) | ACL は本家の StandardAuthorizer を包んで使い、論理クラスタの境界を二重に確かめる。データの権限は ACL だけで与える |
| [0030](../decisions/0030-encryption-and-audit-logs.md) | 保存時は物理クラスタごとの KMS のキーで暗号化し、BYOK は Dedicated だけにする。監査ログは CloudEvents の形で S3 と索引に置く |
| [0031](../decisions/0031-control-plane-reconciliation-and-agent.md) | 制御面の状態は合図と取得による調停で反映し、KRaft が正本の資源は命令で扱う。データ面のエージェントは Java で書く |
| [0032](../decisions/0032-strimzi-for-physical-clusters.md) | 物理クラスタは EKS の上の Strimzi で動かし、自前のオペレーターは作らない |
| [0033](../decisions/0033-logical-cluster-placement.md) | 論理クラスタは、受け入れの条件を満たす 2 つの無作為な候補から、実際の使用に基づく得点の低い方に置く |
| [0034](../decisions/0034-management-api-shape.md) | 管理 API は `/v1` の主版で足す変更だけを入れ、POST に冪等キー、一覧に不透明なトークン、長い操作に 202 を使う |
| [0035](../decisions/0035-console-and-login.md) | コンソールは管理 API を呼ぶ SPA にし、ログインは Better Auth で、MFA は重要な操作の前に求める |
| [0036](../decisions/0036-cli-and-terraform-provider.md) | CLI と Terraform のプロバイダーは Go で作り、OpenAPI から生成した 1 つの SDK を共有する |
| [0037](../decisions/0037-capacity-unit-definition.md) | CU は層ごとの 6 つの次元の組にし、時間の CU は分ごとの CU の最大にする |
| [0038](../decisions/0038-usage-metering-and-metrics-api.md) | 使用量はブローカーで分ごとに数えて S3 を正本にし、テナントのメトリクスは専用の AMP を条件付きの問い合わせで使う |
| [0039](../decisions/0039-jpy-billing-and-free-tier.md) | 単価は円で定めて JST の月で締め、適格請求書を出す。Basic に小さな無料の枠を置き、費用の上限は CU の上限で表す |
| [0040](../decisions/0040-own-schema-registry.md) | スキーマレジストリは、Confluent の REST API と互換の自前の実装にする |
| [0041](../decisions/0041-managed-connectors-curated-plugins.md) | マネージドのコネクターは、当社が選んだ Apache 2.0 のコネクターから始め、コネクターごとに専用のワーカーで動かす |
| [0042](../decisions/0042-connector-runtime-isolation.md) | コネクターは、ブローカーと別の EKS・VPC・アカウントの Fargate の Pod で動かし、外への通信を許可リストの出口に限る |
| [0043](../decisions/0043-aws-accounts-network-and-eks-layout.md) | データ面は環境ごとのアカウントの 1 つの VPC に置き、EKS は層ごと、ノードグループは物理クラスタ × AZ ID ごとに固定する |
| [0044](../decisions/0044-nlb-sni-proxy-and-zonal-hostnames.md) | 入口は NLB（AZ をまたがない）＋ Envoy の SNI の振り分けにし、ブローカーのホスト名に AZ ID を入れて同じ AZ の経路を保つ |
| [0045](../decisions/0045-osaka-disaster-recovery-scope.md) | 大阪への災害復旧は、制御面をウォームスタンバイで持ち、データ面は「書き込みの経路の作り直し」と「写しを有効にした履歴の戻し」に分ける |
| [0046](../decisions/0046-operator-telemetry-and-cardinality.md) | 運用のメトリクスはブローカーの JVM の中の OpenTelemetry の JMX で集め、ラベルに論理クラスタは上位だけ、トピックとパーティションは載せない |
| [0047](../decisions/0047-slos-synthetic-probes-and-alerts.md) | 可用性と遅延の SLI は、外からブローカーごとに流す合成の produce・consume で測り、層ごとの SLO とバーンレートで呼び出す |
| [0048](../decisions/0048-broker-design-point-and-cost-model.md) | ブローカーの設計点を「ネットワークと EBS の基準の帯域の 60%」で決め、Standard は r8g.4xlarge、Basic は m8g.4xlarge にし、物理クラスタの CU の容量をスループットとパーティションの小さい方で数える |
| [0049](../decisions/0049-build-pipelines-artifacts-and-flags.md) | ブローカーは本家のタグにパッチの列を当てて Strimzi の基のイメージに載せ、全ての成果物に署名と SBOM を付ける。データ面のフラグは内部のトピックで配る |
| [0050](../decisions/0050-rolling-upgrade-gates-and-upstream-tracking.md) | ブローカーのローリング更新は AZ の順に 1 台ずつ、パーティションの安全の関門で止め、本家の版の取り込みは差分テスト・Jepsen・Streams の長時間の試験を通してから行う |

リポジトリ共通の決定（開発プロセス、ブランチモデル、本家の名前を使わない識別子）は、ルートの [docs/decisions/](../../../../docs/decisions/README.md) にある。特に [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)：プロトコルの振る舞いは本家に合わせるが、製品の名前・ドメイン・HTTP のヘッダー・API キーの接頭辞・CLI は `<Brand>`・`<brand>` で書く（例：`<lc-id>.<region>.<brand>.<domain>:9092`、`X-<Brand>-Request-Id`、`<brand>_key_...`、`<brand> topic create`）。

## 6. リスクと未解決事項

品質の面のリスクの順位と対策は [quality.md](../quality.md) の 1 節にある。ここは設計の面のリスクを書く。

- **受け付けた書き込みの喪失**：最も重いリスク。本家の複製の設定を固定し（ADR-0012）、Jepsen の形の障害注入を PR ごと・日次・本家の RC ごとに回し、Kora に倣って本番で耐久性の監査（AUD-1〜7）とカナリアを持つ（ADR-0014）。Kora の論文は、テスト環境で、階層型の保存のメタデータの食い違いによるデータの喪失を観測したと書いている（4.6 節）。階層型の境界を監査の対象に入れる（[tiered-and-object-storage.md](tiered-and-object-storage.md) の 6.7 節）。
- **トランザクションの正しさ**：Jepsen が報告した KAFKA-17754 は、KIP-890 の第 2 段（TV2）で解決として閉じられた。修正の版の記載はなく、KAFKA-17582 は未解決（[transactions-and-idempotence.md](transactions-and-idempotence.md) の 2.1 節）。TV2 を固定で有効にし（ADR-0021）、Jepsen の txn と Kafka Streams の 6 時間の試験を毎日回して、本家の版の更新の関門にする（ADR-0022）。直っていない点は、利用者向けの文書に既知の制約として書く。
- **本家へのパッチの維持**：名前空間のパッチ P1〜P7（ADR-0025、ADR-0026）を、本家の版の更新のたびに当て直す手間。パッチの行数を CI で出し、E1 の PoC で測る。多すぎれば、プロキシの案（ADR-0004 の選択肢 2）を再評価する。本家の版を 2 つ以上遅らせない（ADR-0050）。
- **うるさい隣人**：1 つのテナントの急増が全体の遅延を上げうる。動的なクォータと背圧（ADR-0027）、接続・パーティション・`transactional.id`・グループの数の上限（ADR-0026）で抑え、N1〜N10 の試験で確かめる。
- **パーティションの数で決まる原価**：S1 の目標（20 万）では、ブローカーの台数がスループットの 5 倍を超える。パーティション-時の課金で回収する（6 節の決定）。単価と含む数は PM が決める。ブローカーあたりの複製の上限（4,000）を 8,000 に上げられるかは E1 の T2 で確かめる（ADR-0017）。
- **AZ をまたぐ転送と NLB の費用**：Standard のトピックでは、原価の大きな部分になる（3 節の見積もり）。fetch-from-follower を既定にし、ホスト名に AZ ID を入れて経路を同じ AZ に留める（ADR-0013、ADR-0044）。NLB を通さない経路とディスクレスのトピックは S2。
- **入口の未検証の点**：Envoy の `tcp_proxy` の on-demand CDS で SNI の名前のクラスタを引けるか、1 万のクラスタでのメモリー。E1 の PoC で確かめ、だめなら filter chain の形に替える（ADR-0044）。ブローカーは送信元 IP を知らないので、IP ごとの制限と監査ログの IP は Envoy のアクセスログとの突き合わせに頼る。
- **外部の OSS への依存**：Strimzi（本家の新しい版への対応に約 1 か月）、Aiven の RSM（最新の版が 2025-10）。追従が止まったら、ADR-0032 の見直しの条件と、RSM の fork（ADR-0018）で受ける。
- **ディスクレスのトピックの本家の実装**：KIP-1150 は採択されたが、実装の KIP-1163・1164 は議論中（2026-09-27）。本家が冪等とトランザクションに対応するまで出さない（ADR-0020）。四半期ごとに状態を確かめる。
- **リージョンの障害**：S1 では、データ面の大阪への複製がない。戻せるのは写しを有効にした論理クラスタの S3 に上がった部分だけ（NFR-009、ADR-0045）。大阪の EC2 の空きは予約しない。SLA と利用規約に書く（intent.md の L6）。
- **KRaft の過半数のボリュームの喪失**：本家にスナップショットからクォーラムを作り直す正式な手順がない（未検証）。1 時間ごとのスナップショットの写しと、年 2 回の訓練で備える（ADR-0015）。
- **法務・経理**：商標、パッチと配る成果物のライセンス、周辺の OSS、個人データ、電気通信事業法、SLA、適格請求書と税、利用規約は、法務・経理の確認待ち（intent.md の L1〜L8）。結論が出るまで、該当する Story の spec を承認しない。

### 決定（2026-09-27、既定案）

PM の方針（本家に寄せる、既定案で進める）により、統合の工程で次のとおり決めた。法務・経理の判断が要るものは決めず、[intent.md](../intent.md) の「法務の確認待ち」（L1〜L8）に残した。

- **ADR と intent の状態**：基盤の ADR（0001〜0005）と intent.md を、他の題材と同じく `accepted` にした。先に次を直した。
  - ADR-0001：データ面のエージェントを TypeScript から Java 21 と本家の AdminClient に改めた（ADR-0031）。KafkaJS を行列から外し、confluent-kafka-javascript に置き換えた（ADR-0008）。クォータのコーディネーターをデータ面に置き（ADR-0027）、RSM を Aiven の OSS を土台にした包む層にした（ADR-0018）。
  - ADR-0003・ADR-0004：CreateAcls などの ACL の API は、本家の CLUSTER の ALTER の代わりに、論理クラスタの管理の権限（`cluster_role=admin`）で許し、資源を自分の論理クラスタに限る（ADR-0029、[security-and-acls.md](security-and-acls.md) の 5.3 節）。反映の方式（ADR-0031）、コントローラーの台数（ADR-0015）、配置の得点（ADR-0033）、Metadata のブローカーの一覧（ADR-0025）を反映した。
  - ADR-0005：ApiVersions は本家のまま広告し、表との食い違いは CI の関門で止めるのを主な守りにし、本番では `UNSUPPORTED_VERSION` を最後の守りにする（ADR-0006）。行列の Node.js を confluent-kafka-javascript（対応）と KafkaJS（凍結）にした。
  - 本題材の AGENTS.md の行列の KafkaJS を置き換えた。
- **NFR-009**：大阪から戻せるのは、写しを有効にした論理クラスタだけとし、戻らないものを ADR-0045 の表のとおり書いた（3 節）。**PM の確認事項。**
- **NFR-010 とパーティションの価格**（**PM・Dev の確認事項**）：
  - NFR-010 を「NLB の処理のバイト（書き込み 1 GB あたり約 $0.024）を含めて、設計点で $0.11 以下」に改めた。元の $0.08 は S2 の目標として残す。
  - パーティションに値段を付ける。CU に含む数（Standard 100、Basic 20）を超えた分を、パーティション-時で課金する。本家の旧来の Basic・Standard が、クラスタに含む数を超えたパーティションに課金していた形に倣う（今の eCKU は直接は課金しない。旧来の単価は未検証）。パーティションの次元は請求の CU から外し、上限と配置にだけ使う（ADR-0037・ADR-0039 を改めた）。
  - S1 のパーティションの目標（20 万）は変えない。原価のモデルは、パーティションで決まるブローカーの台数（約 150 台）を示し、1 パーティション-時の原価の目安（Standard 約 $0.0012）を出した（[capacity.md](capacity.md) の 10 節）。
- **ブローカーのホスト名**：ADR-0044 の AZ ID を含む形 `b<broker-id>-<lc-id>.<az-id>.<region>.<brand>.<domain>` に揃えた（multi-tenancy-and-quotas の 4.4 節）。
- **rack**：AZ ID（ADR-0012）。Strimzi の `rack.topologyKey` を AZ ID のラベル（`topology.k8s.aws/zone-id`）にした（control-plane-and-provisioning の 7.1 節、ADR-0032）。
- **送信元 IP**：ブローカーは送信元 IP を知らない。IP ごとの制限と監査ログの IP は、Envoy のアクセスログとの突き合わせで作る。送信元 IP ごとの接続の頻度の制限は S2 で、外部のレート制限のサービスで入れる（security-and-acls の 3.6・8 節）。
- **大阪で失う範囲**：`segment.ms` ＋ 上げと CRR の遅れで、ローカルの保持は関係しない（tiered-and-object-storage の 6.6 節）。
- **EBS**：スループットは型の EBS の基準の帯域（r8g.4xlarge で 625 MB/秒）を上限にする。拡張は KafkaNodePool の `storage.size` で行い、EBS を直接変えない。暗号化は物理クラスタごとの CMK（broker-and-log-storage の 5・8 節、ADR-0009）。
- **耐久性の監査の事象**：内部のトピック `__<brand>_durability_audit` に書く（replication-and-durability の 7.1 節）。
- **ACL の上限**：Basic 1,000・Standard 10,000（ADR-0029。metadata-and-control の 6.2 節と ADR-0017 を合わせた）。
- **KIP-1023**：E3・E4 の検証まで無効。検証の Story は E4（roadmap）。
- **データの削除の約束**：論理クラスタの削除と組織の解約だけを対象にする。トピックの削除は対象外で、大阪の写しが保持の期間まで残りうる（security-and-acls の 9 節）。
- **テーブルの欄**：`logical_clusters` の `cu` と `max_cu` を `max_cu` に揃え、`physical_clusters` の追加の欄を 1 つの定義にまとめた（[data-model.md](data-model.md) の 3.2 節）。
- **Runbook の名前**：重なる候補をまとめた（`broker-demotion`・`degraded-broker` → `slow-broker-demotion`、`broker-decommission` → `broker-retire`、`cross-tenant-exposure` → `tenant-boundary-violation`、`capacity-add-brokers` → `broker-scale-out`、`transaction-coordinator-load` → `coordinator-load`、`upstream-upgrade` → [deploy-and-rollback.md](../runbooks/deploy-and-rollback.md) の D、`osaka-restore` → [disaster-recovery.md](../runbooks/disaster-recovery.md) の A-4）。一覧は [runbooks/README.md](../runbooks/README.md) の 5 節。
- **数値の正本**：SLO とアラートは [runbooks/README.md](../runbooks/README.md) の 1・5 節。層ごとの上限は [multi-tenancy-and-quotas.md](multi-tenancy-and-quotas.md) の 6 節、CU の値は [ADR-0037](../decisions/0037-capacity-unit-definition.md)、トピックの設定は [protocol-and-compatibility.md](protocol-and-compatibility.md) の 5 節、設計点と原価は [capacity.md](capacity.md)、保持の期間は [security-and-acls.md](security-and-acls.md) の 8.4 節。
- **Epic**：E1〜E12 が MVP（S1）。S2・S3 の Epic は E13〜E19（[roadmap.md](../roadmap.md)）。それ以外は roadmap.md の延期の一覧。
- 領域ごとの決定は、各文書の「決定（2026-09-27、既定案）」の節にある。

持ち越し（計測・PoC で決めるもの）：

| 項目 | いつ・どう決めるか |
| --- | --- |
| 名前空間のパッチの行数、KafkaPrincipalBuilder で SNI を取り出せるか、代理の接続のユーザー名 | E1 の PoC |
| 設計点（W = 80 で CPU 60% 未満）、ブローカーあたりの複製の上限（4,000 → 8,000） | E1 の T1・T2（[capacity.md](capacity.md) の 11 節） |
| Envoy の on-demand CDS、`topology.k8s.aws/zone-id` のラベル、Strimzi のロールの止め方と Java の版 | E1 の PoC |
| 定期のフラッシュの produce の遅延への影響、不正な停止からの回復の時間 | E1 の PoC（ADR-0011） |
| KIP-1023 を有効にするか | E3・E4 の Jepsen の形と性能のテスト |
| ローカルの保持を 3 時間にするか | E9 の T11 |
| パーティション-時の単価と含む数、無料の枠、CU-時・GB の単価 | PM（E11） |
| 大阪の EC2 の空きの確保 | 年 1 回の訓練 |
| 費用の単価 | E12 の前に、Price List API で置き換える |

## 7. 領域の文書と ADR の番号

領域の文書で ADR を起票するときは、この表で割り当てた範囲の中で採番する。範囲が足りなくなったら 0051 以降から振る（既存の範囲をずらさない）。持ち主は、どれも Dev が書き、「レビュー」の列のロールが確認する。

| ファイル | 範囲 | ADR | レビュー | 関わる Epic |
| --- | --- | --- | --- | --- |
| [protocol-and-compatibility.md](protocol-and-compatibility.md) | ワイヤープロトコル、ApiVersions、許可・拒否する API、トピックの設定、クライアントの行列、本家との差分テスト、本家の版の追従 | 0006–0008 | QA | E1、E2 |
| [broker-and-log-storage.md](broker-and-log-storage.md) | ブローカーのノード、ログのセグメントと索引、保持・圧縮、EBS、ディスクの容量の管理、ログの回復 | 0009–0011 | QA、Ops | E1、E3 |
| [replication-and-durability.md](replication-and-durability.md) | 複製の数と ISR・ELR、AZ の配置（rack）、リーダーの選出、fetch-from-follower、耐久性の監査、障害注入 | 0012–0014 | QA | E1、E3 |
| [metadata-and-control.md](metadata-and-control.md) | KRaft のクォーラムと入れ替え（KIP-853）、パーティションの再配置、cordon・退役・降格（KIP-1066）、メタデータの上限 | 0015–0017 | QA、Ops | E1、E3、E9 |
| [tiered-and-object-storage.md](tiered-and-object-storage.md) | RemoteStorageManager、S3 のキー、リモートのメタデータ、大阪への写し、階層型の監査、ディスクレスのトピック（S2） | 0018–0020 | QA、Ops | E4、E13 |
| [transactions-and-idempotence.md](transactions-and-idempotence.md) | 冪等なプロデューサー、トランザクション、KIP-890、`transactional.id` の上限、Kafka Streams の exactly-once | 0021–0022 | QA | E5 |
| [consumer-groups.md](consumer-groups.md) | classic と consumer（KIP-848）、オフセット、遅れ、共有のグループ・Streams のグループ（E14） | 0023–0024 | QA | E6、E14 |
| [multi-tenancy-and-quotas.md](multi-tenancy-and-quotas.md) | 名前空間のパッチ、テナントの解決、クォータ、層ごとの上限、動的なクォータと背圧、配置とセル | 0025–0027 | QA、セキュリティ | E7、E15 |
| [security-and-acls.md](security-and-acls.md) | 脅威モデル、API キーと SASL、サービスアカウント、ACL、TLS、保存時の暗号化、監査ログ、データの削除 | 0028–0030 | セキュリティ | E8、E19 |
| [control-plane-and-provisioning.md](control-plane-and-provisioning.md) | 制御面の状態、望ましい状態の反映（エージェント）、命令、物理クラスタの作成と拡張（Strimzi）、配置 | 0031–0033 | QA、Ops | E1、E9 |
| [console-and-api.md](console-and-api.md) | 管理 API の形と版、コンソール、ログイン、CLI、Terraform のプロバイダー | 0034–0036 | QA、セキュリティ | E10 |
| [metrics-and-billing.md](metrics-and-billing.md) | CU の定義、使用量の計測、テナント向けのメトリクスの API、円建ての請求、無料の枠 | 0037–0039 | QA、経理 | E11 |
| [connectors-and-schema.md](connectors-and-schema.md) | スキーマレジストリ（S2）、マネージドのコネクター（S3） | 0040–0042 | セキュリティ | E16、E17 |
| [infrastructure.md](infrastructure.md) | AWS のアカウントと VPC、EKS、NLB と Envoy、PrivateLink（S2）、S3 と KMS、災害復旧、費用 | 0043–0045 | Ops、セキュリティ | E1、E12、E18 |
| [observability.md](observability.md) | 運用のメトリクス・ログ・トレース、劣化の検出、合成監視、SLI・SLO、アラート | 0046–0047 | Ops | E1、E3、E12 |
| [capacity.md](capacity.md) | 負荷のモデル、ブローカーの設計点、EBS・S3・NLB、費用のモデル（NFR-010）、負荷試験 T1〜T11 | 0048 | Ops、PM | E1、E9、E12 |
| [delivery.md](delivery.md) | CI/CD、成果物と署名、ブローカーのローリング更新（G1〜G7）、本家の版の追従（U1〜U7）、フィーチャーフラグ | 0049–0050 | QA、Ops | E1、E12 |
| [data-model.md](data-model.md) | 制御面のテーブル、内部のトピック、KRaft の記録、S3 の置き方の索引 | なし（各領域の ADR を参照） | QA | 全 Epic |

## 8. Epic

Epic と Story の計画は [roadmap.md](../roadmap.md) にある（PM が持つ）。領域の文書の Story の候補は、この番号で書く。

| Epic | 中身 |
| --- | --- |
| E1 基盤と PoC | AWS のアカウントと VPC、EKS と Strimzi、ブローカーのビルドとパッチの列、Jepsen の枠、名前空間・SNI・SASL・階層型の保存・エッジの PoC、設計点の負荷試験 |
| E2 プロトコルと互換性 | API の表、トピックの設定の表、差分テスト、クライアントの行列、本家の RC の夜間の試験 |
| E3 複製と耐久性 | 耐久性の設定、障害注入の行列、耐久性の監査とカナリア、fetch-from-follower、ディスクの逼迫、ボリュームの入れ替え、コントローラーの入れ替え、降格 |
| E4 階層型の保存 | RSM の包む層、バケットと IAM、階層型の監査、大阪への写しと戻し、KIP-1023 の検証 |
| E5 トランザクション | TV2 の固定、`transactional.id` と InitProducerId の上限、Streams の exactly-once の試験、ぶら下がったトランザクション |
| E6 コンシューマーグループ | 2 つのプロトコル、正規表現の名前空間、グループの上限、遅れ |
| E7 マルチテナントとクォータ | 名前空間の全 API、クォータ、動的なクォータと背圧、うるさい隣人の試験、隣のテナントの確認 |
| E8 セキュリティと ACL | サービスアカウント、API キー、資格情報の配布、TenantAuthorizer、ロール、監査ログ、データの削除 |
| E9 制御面と配置 | 制御面の状態、調停、命令、論理クラスタの作成、配置、物理クラスタの作成と拡張、再配置、退役、規模の負荷試験 |
| E10 コンソールと API | 管理 API、冪等、ページング、コンソール、最初の 5 分、ログイン、CLI、Terraform のプロバイダー |
| E11 メトリクスと請求 | CU、使用量の経路と照合、メトリクスの API、価格と rating（パーティション-時を含む）、無料の枠、適格請求書、未払い |
| E12 運用と GA の準備 | ローリング更新の関門、本家の版の取り込み、エッジの本番、証明書、大阪の待機、合成監視と SLO、ダッシュボード、侵入試験、GA の判定 |
| E13〜E19（S2・S3） | ディスクレスのトピック、共有のグループと Streams のグループ、セルと S2 の規模、スキーマレジストリ、マネージドのコネクター、PrivateLink、Dedicated と BYOK |

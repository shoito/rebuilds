# Architecture: Kafka

全体像と横断的な方針。領域ごとの設計は、同じディレクトリの各ファイルに書く（まだない。7 節に予定の一覧と ADR の番号の範囲がある）。

予定の領域の文書（まだない）：

| ファイル | 領域 |
| --- | --- |
| `protocol-and-compatibility.md` | Kafka のワイヤープロトコル、API の版、許可・拒否する API、クライアントの行列、互換性テスト |
| `broker-and-log-storage.md` | ブローカー、ログのセグメント、索引、保持と圧縮、ローカルのディスク |
| `replication-and-durability.md` | 複製、ISR、リーダーの選出、AZ の配置、fetch-from-follower、耐久性の監査 |
| `metadata-and-control.md` | KRaft のコントローラー、メタデータのログ、物理クラスタの中の配置と再配置 |
| `tiered-and-object-storage.md` | 階層型の保存（KIP-405）、S3 の配置、ディスクレスのトピック（Later） |
| `transactions-and-idempotence.md` | 冪等なプロデューサー、トランザクション、exactly-once、ゾンビの防止 |
| `consumer-groups.md` | コンシューマーグループ、2 つのリバランスのプロトコル、オフセット、共有のグループ（Later） |
| `multi-tenancy-and-quotas.md` | 論理クラスタ、名前空間、クォータ、動的なクォータの配分、うるさい隣人の防止 |
| `security-and-acls.md` | 脅威モデル、API キー、SASL・TLS、ACL、暗号化、監査ログ |
| `control-plane-and-provisioning.md` | 制御面、論理クラスタの作成と配置、物理クラスタの作成と拡張、データ面への反映 |
| `console-and-api.md` | コンソール、管理 API、CLI、Terraform のプロバイダー |
| `metrics-and-billing.md` | テナント向けのメトリクスの API、使用量の計測、容量の単位（CU）、請求 |
| `connectors-and-schema.md` | スキーマレジストリ、マネージドのコネクター（Later） |
| `infrastructure.md` | AWS の構成、EKS、ネットワーク（SNI のプロキシ、PrivateLink）、冗長化、災害復旧 |
| `observability.md` | 運用のためのログ、メトリクス、トレース、外からの合成監視、SLO |
| `capacity.md` | 負荷のモデル、部品ごとの必要量、費用のモデル |
| `delivery.md` | CI/CD、ブローカーのローリング更新、本家の版の追従、フィーチャーフラグ |
| `data-model.md` | 制御面のテーブルと、データ面のメタデータの索引 |

## 1. 全体構成

形は、Confluent Cloud の Kora に倣い、中央の制御面と、独立した多数のデータ面（物理クラスタ）に分ける（[Kora の論文](https://vldb.org/pvldb/vol16/p3822-povzner.pdf) の 3 節、2026-09-27 に確認）。

```
テナントのアプリ（Kafka のクライアント）
   │ TLS（SNI = ブローカーごとのホスト名）＋ SASL/PLAIN（API キー）
   ▼
NLB ──▶ SNI のプロキシ（L4。TLS を終端しない。接続数の制限・IP の許可リスト）
   ▼
┌──────────── データ面：物理クラスタ（東京の 3 AZ、EKS）─────────────────┐
│  ブローカー（本家の Apache Kafka 4.x ＋ 差し込み口の拡張 ＋ テナントのパッチ） │
│    ├─ ローカルのディスク（EBS）：新しいセグメント。3 つの複製（AZ ごとに 1 つ） │
│    └─ RemoteStorageManager ──▶ S3：古いセグメント（階層型の保存）          │
│  KRaft のコントローラー（3 台、AZ ごとに 1 台）：クラスタのメタデータの正本    │
│  データ面のエージェント：望ましい状態の反映、使用量・メトリクスの収集        │
└──────────────────────────────────────────────────────────────────┘
   ▲ Admin API（Kafka のプロトコル）で反映        │ 使用量・メトリクス
   │                                               ▼
┌──────────── 制御面（東京。災害復旧は大阪）───────────────────────────┐
│  管理 API（api.<brand>.<domain>）・コンソール・CLI・Terraform のプロバイダー │
│  配置（論理クラスタ → 物理クラスタ）・物理クラスタの作成と拡張             │
│  API キー・サービスアカウント・ACL の望ましい状態                         │
│  クォータのコーディネーター・メトリクスの API・使用量の計測と請求           │
│  Aurora PostgreSQL（制御面の正本）                                        │
└──────────────────────────────────────────────────────────────────┘
```

| コンポーネント | 責務 |
| --- | --- |
| SNI のプロキシ | TLS の SNI のホスト名で、要求を正しいブローカーへ振り分ける。TLS は終端せず、Kafka のプロトコルも解釈しない。状態を持たず、ブローカーと別に伸び縮みする。接続数と IP の制限を、認証の前に掛ける |
| ブローカー | 本家の Apache Kafka。produce・fetch・グループ・トランザクションの処理。テナントの名前空間とクォータを、要求ごとに適用する（[ADR-0004](../decisions/0004-logical-clusters-on-shared-physical-clusters.md)） |
| KRaft のコントローラー | 物理クラスタのメタデータ（トピック、パーティションの配置、ACL、クォータ、設定）の正本。Raft で 3 台に複製する（[ADR-0003](../decisions/0003-kraft-metadata-and-cluster-placement.md)） |
| 階層型の保存 | 閉じたセグメントを S3 へ上げ、ローカルからは消す。コンシューマーは 1 本のログとして読む（[ADR-0002](../decisions/0002-replicated-log-with-tiered-storage.md)） |
| データ面のエージェント | 制御面の望ましい状態（論理クラスタ、トピック、ACL、クォータ）を、Admin API で物理クラスタへ反映する。使用量とメトリクスを集めて制御面へ送る |
| 制御面 | テナント・論理クラスタ・API キー・請求の正本。論理クラスタを物理クラスタに配置し、物理クラスタを作り、拡張する |
| クォータのコーディネーター | テナントごとのクォータを、そのテナントのパーティションを持つブローカーに、使用量に応じて配り直す（Kora の動的なクォータ。論文の 5.2 節） |

原則は 3 つ。

- **正しさは本家に任せ、差分を小さく保つ。** 複製・トランザクション・グループの意味は、本家の Apache Kafka の実装そのものを使う。拡張は差し込み口で行い、本家のコードへのパッチは最小にする（[ADR-0001](../decisions/0001-upstream-brokers-and-stack.md)）。
- **受け付けた書き込みは、3 つの AZ のうち 2 つ以上に届いてから成功を返す。** 耐久性の既定値はテナントに変えさせない。古いデータは S3 に移して、ディスクを小さく保つ（[ADR-0002](../decisions/0002-replicated-log-with-tiered-storage.md)）。
- **テナントは論理クラスタ。物理クラスタは共有する。** 名前空間・クォータ・ACL で分け、分離の単位を 1 つにする。専用の物理クラスタも、同じ論理クラスタの仕組みの上に作る（[ADR-0004](../decisions/0004-logical-clusters-on-shared-physical-clusters.md)）。

### 用語

| 用語 | 意味 |
| --- | --- |
| 論理クラスタ | テナントに見えるクラスタ。ブートストラップのホスト名、トピックの名前空間、クォータ、ACL を持つ。Kora の LKC に相当 |
| 物理クラスタ | 1 つの KRaft のクォーラムと、そのブローカーの集まり。複数の論理クラスタを載せる。Kora の PKC に相当 |
| セル | 物理クラスタの中のブローカーの部分集合。1 つの論理クラスタのパーティションを 1 つのセルに閉じ込め、接続の数と障害の範囲を絞る（S2。Kora の論文の 5.3 節） |
| CU（容量の単位） | 論理クラスタの容量の上限の単位（スループット、パーティション、接続、要求の数）。定義は metrics-and-billing の領域で決める |

## 2. 規模の段階

| 段階 | 論理クラスタ | 書き込み（全体のピーク） | パーティション（全体、複製の前） | 構成 |
| --- | --- | --- | --- | --- |
| S1（MVP） | 1,000 | 2 GB/秒 | 20 万 | 東京の 3 AZ。物理クラスタは 10 以下。Basic と Standard の層。制御面は Aurora Global Database で大阪に写す。データ面の大阪への複製はない（S3 の上のセグメントだけ、大阪へ写す） |
| S2 | 1 万 | 20 GB/秒 | 200 万 | 物理クラスタを数十に。セル。専用の物理クラスタ（Dedicated）、PrivateLink、ディスクレスのトピック、クラスタの間の複製（大阪への災害復旧）、スキーマレジストリ |
| S3 | 10 万 | 200 GB/秒 | 2,000 万 | 複数のリージョン（東京・大阪の両方で提供、海外は必要に応じて）。BYOC。マネージドのコネクターとストリーム処理 |

## 3. 非機能要件

数値は、本家と他社の公開の値を参考にした目標である。S1 の値は、E1 の PoC と負荷試験で確かめるまで「未検証」の目標として扱う。

| ID | 項目 | S1 の目標 | 備考 |
| --- | --- | --- | --- |
| NFR-001 | 耐久性 | `acks=all` で成功を返した書き込みは失わない。1 つの AZ の喪失で RPO 0 | 複製 3、`min.insync.replicas=2`、AZ ごとに 1 つの複製、unclean なリーダーの選出を禁止（[ADR-0002](../decisions/0002-replicated-log-with-tiered-storage.md)）。リージョンの喪失は NFR-009 |
| NFR-002 | 可用性（produce と fetch） | Standard：月間 99.95%（S1）→ 99.99%（S2）。Basic：99.5% | 外からの合成監視の produce・fetch の成否で測る。Confluent Cloud は Standard・Enterprise で最大 99.99%（2 eCKU 以上）、Basic で 99.5%（[Cluster types](https://docs.confluent.io/cloud/current/clusters/cluster-types.html)、2026-09-27 に確認）。MSK はマルチ AZ で 99.9%（[MSK SLA](https://aws.amazon.com/msk/sla)、2026-09-27 に確認） |
| NFR-003 | produce の遅延 | `acks=all`、同じリージョンのクライアント、1 KB のレコードで p99 50ms 以内、p50 10ms 以内 | ブローカーで要求を受けてから応答を返すまで。クライアントの `linger.ms` を除く。未検証（PoC で測る） |
| NFR-004 | 端から端までの遅延 | produce の開始から、追いついているコンシューマーが受け取るまで p99 100ms 以内 | ディスクレスのトピック（S2）は別の目標（p99 1 秒以内）にする |
| NFR-005 | パーティションあたりのスループット | 書き込み 10 MB/秒、読み取り 30 MB/秒を保証する | 参考：MSK Express は 1 パーティションあたり最大 15 MB/秒、MSK Serverless は書き込み 5 MB/秒・読み取り 10 MB/秒（[MSK quota](https://docs.aws.amazon.com/msk/latest/developerguide/limits.html)、2026-09-27 に確認）。未検証 |
| NFR-006 | 論理クラスタあたりのスループット | Standard：書き込み 250 MB/秒、読み取り 750 MB/秒まで。物理クラスタ 1 つで書き込み 2 GB/秒 | Confluent Cloud の Standard と同じ上限（同上の Cluster types）。S2 の Dedicated で上限を上げる |
| NFR-007 | 容量の伸び縮み | 論理クラスタの上限の引き上げは 1 分以内（クォータの変更だけ）。物理クラスタへのブローカーの追加と再配置は 30 分以内 | 階層型の保存で、移すのはローカルの新しいセグメントだけにする。Confluent Cloud は 10 eCKU まで数秒で伸びる（同上）。未検証 |
| NFR-008 | テナントの分離 | 他のテナントの資源が見える事象 0 件。クォータの中で使うテナントが、他のテナントのせいで絞られる時間を週 5 分以内（99.95%）にし、これを満たすテナントを 99.9% 以上にする | 後半は Kora の指標に倣う。Kora は動的なクォータで、この目標を満たすテナントの割合を 99% から 99.9% 超に上げた（論文の 5.2 節） |
| NFR-009 | 復旧 | AZ の障害：RPO 0、リーダーの移動を含めて RTO 1 分以内。リージョンの障害：制御面は RPO 1 分・RTO 1 時間。データ面は S1 では S3 に上がったセグメントだけを大阪から戻せる（ローカルだけの新しい部分は失いうる） | S2 でクラスタの間の複製により RPO を分の単位にする。S1 の制約は SLA と利用規約に書く（intent.md の L6） |
| NFR-010 | 1 GB の書き込みあたりの原価 | Standard のトピック（読み取り 3 倍、保持 7 日）で $0.08 以下 | 内訳の見積もりは下の表。ディスクレスのトピック（S2）で $0.02 以下を目標にする。未検証（capacity の領域で詰める） |

### NFR-010 の見積もり（ネットワークの部分）

AZ をまたぐ転送は、送信と受信で各 $0.01/GB（[AWS Architecture Blog](https://aws.amazon.com/blogs/architecture/exploring-data-transfer-costs-for-aws-managed-databases/)、2026-09-27 に確認。東京の単価は未検証）。複製 3 を 3 つの AZ に置くと、1 GB の書き込みごとに次が掛かる。

| 経路 | 量 | 費用 |
| --- | --- | --- |
| プロデューサー → リーダー | 平均 2/3 GB が AZ をまたぐ | 約 $0.013 |
| リーダー → 2 つのフォロワー | 2 GB が AZ をまたぐ | $0.04 |
| コンシューマー ← ブローカー | fetch-from-follower（KIP-392）で同じ AZ の複製から読めば 0 | 0 |
| ブローカー → S3（階層型の保存） | 同じリージョンの S3 への転送は無料（VPC のゲートウェイ型のエンドポイント） | S3 の PUT の費用だけ |

ネットワークだけで約 $0.053/GB になる。Kora の論文も、マルチ AZ のクラスタの最大のネットワークの費用は AZ をまたぐ複製だとしている（4.2.2 節）。これが、S2 でディスクレスのトピックを足す理由である（[ADR-0002](../decisions/0002-replicated-log-with-tiered-storage.md)）。

## 4. 技術スタック

| 層 | 選定 | 理由 |
| --- | --- | --- |
| ブローカー・コントローラー | 本家の Apache Kafka 4.x（KRaft）。拡張は Java 21 | 正しさと互換性を本家から得る（[ADR-0001](../decisions/0001-upstream-brokers-and-stack.md)）。本家の 4.0 でブローカーは Java 17 以上が要る（[4.0.0 の発表](https://kafka.apache.org/blog/2025/03/18/apache-kafka-4.0.0-release-announcement/)、2026-09-27 に確認）。4.2 は Java 25 に対応した |
| 階層型の保存 | 本家の RemoteLogManager ＋ 自前の S3 の RemoteStorageManager | KIP-405 は本家の 3.9 で本番向けになった（[Tiered Storage GA Release Notes](https://cwiki.apache.org/confluence/x/9xDOEg)、2026-09-27 に確認） |
| SNI のプロキシ | Envoy（TCP のプロキシ、TLS の SNI で振り分け） | Kafka のプロトコルを解釈しないので、自前で書かない。Kora と同じ SNI の振り分け（論文の 3.1 節） |
| データ面の実行基盤 | EKS（EC2、EBS gp3）。1 つの物理クラスタを 1 つの EKS の名前空間の集まりに | ブローカーの入れ替えとローリング更新を、宣言的に行う。Kora も Kubernetes を使う（論文の 3.1 節）。オペレーターは control-plane-and-provisioning の領域で決める |
| 制御面 | TypeScript（Hono＋Zod）、Aurora PostgreSQL 18、outbox → SQS | 他の題材と同じ |
| コンソール | React（他の題材と同じ構成） | |
| CLI・Terraform のプロバイダー | Go | Terraform のプロバイダーの SDK（Terraform Plugin Framework）が Go。CLI も同じ言語で、1 つのバイナリで配る |
| IaC | Terraform | 他の題材と同じ |
| 可観測性 | OpenTelemetry（ADOT）→ AMP、X-Ray、CloudWatch Logs。ブローカーの JMX のメトリクスは OpenTelemetry の Java エージェントで集める | 他の題材と同じ |
| 互換性テスト | Java のクライアント、librdkafka、franz-go、Sarama、KafkaJS の行列。本家のブローカーとの差分テスト | [ADR-0005](../decisions/0005-compatibility-policy.md) |
| 耐久性テスト | Jepsen の Kafka のワークロード（queue、トランザクション）と障害注入 | Jepsen は Kafka のテストのライブラリを公開している（[jepsen.tests.kafka](https://jepsen-io.github.io/jepsen/jepsen.tests.kafka.html)、2026-09-27 に確認） |

## 5. 主な決定

| ADR | 決定 |
| --- | --- |
| [0001](../decisions/0001-upstream-brokers-and-stack.md) | データ面は本家の Apache Kafka のブローカーを使い、差し込み口と最小のパッチで拡張する。制御面は他の題材の基盤を引き継ぐ |
| [0002](../decisions/0002-replicated-log-with-tiered-storage.md) | 既定のトピックは、ローカルのディスクの 3 つの複製と S3 への階層型の保存にする。ディスクレスのトピックは S2 で別の種類として足す |
| [0003](../decisions/0003-kraft-metadata-and-cluster-placement.md) | 物理クラスタのメタデータは KRaft を正本にし、制御面は望ましい状態を Admin API で反映する。論理クラスタは物理クラスタに配置する |
| [0004](../decisions/0004-logical-clusters-on-shared-physical-clusters.md) | テナントは、共有の物理クラスタの上の論理クラスタにする。名前空間はブローカーの小さなパッチで作り、クォータは動的に配る |
| [0005](../decisions/0005-compatibility-policy.md) | 互換の範囲は、動かしている本家のブローカーの API の版から、管理の API を除いたもの。行列と差分テストで確かめる |

リポジトリ共通の決定（開発プロセス、ブランチモデル、本家の名前を使わない識別子）は、ルートの [docs/decisions/](../../../../docs/decisions/README.md) にある。特に [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)：プロトコルの振る舞いは本家に合わせるが、製品の名前・ドメイン・HTTP のヘッダー・API キーの接頭辞・CLI は `<Brand>`・`<brand>` で書く（例：`<cluster-id>.<region>.<brand>.<domain>:9092`、`X-<Brand>-Request-Id`、`<brand>_key_...`、`<brand> topic create`）。

## 6. リスクと未解決事項

- **受け付けた書き込みの喪失**：最も重いリスク。本家の複製の設定を固定し（ADR-0002）、Jepsen の形の障害注入を CI で回し、Kora に倣って本番で耐久性の監査（オフセットとセグメントの不変条件を日次で照合）を行う。Kora の論文は、テスト環境で、階層型の保存のメタデータの食い違いによるデータの喪失を観測したと書いている（4.6 節）。階層型の保存の境界を、監査の対象に必ず入れる。
- **トランザクションの正しさ**：Jepsen は、Kafka のトランザクションのプロトコルに、書き込みの喪失・中止した読み取り・ちぎれたトランザクションを報告している（[Jepsen: Bufstream 0.1.0](https://jepsen.io/analyses/bufstream-0.1.0)、2026-09-27 に確認）。本家の KIP-890（4.0 でサーバー側の防御の第 2 段）で何が直ったかを、transactions-and-idempotence の領域で確かめる。直っていない点は、利用者向けの文書に書く。未検証。
- **本家へのパッチの維持**：テナントの名前空間のパッチ（ADR-0004）を、本家の版の更新のたびに当て直す手間。パッチの量を E1 で測る。本家の版を 2 つ以上遅らせない（delivery の領域）。
- **うるさい隣人**：共有の物理クラスタでは、1 つのテナントの急増が全体の遅延を上げうる。Kora の動的なクォータと、CPU の時間のクォータ（要求の処理時間）を入れる（ADR-0004）。
- **AZ をまたぐ転送の費用**：Standard のトピックでは、原価の大きな部分になる（3 節の見積もり）。fetch-from-follower を既定にし、ディスクレスのトピックを S2 で足す。
- **ディスクレスのトピックの本家の実装**：KIP-1150 は採択されたが、実装の KIP-1163・1164 は議論中（[Aiven の解説](https://aiven.io/blog/kip-1150-accepted-and-the-road-ahead)、2026-09-27 に確認）。S2 までに本家に入らないときは、ADR-0002 を見直す。
- **リージョンの障害**：S1 では、データ面の大阪への複製がない。S3 に上がったセグメントだけを戻せる（NFR-009）。SLA と利用規約に書く（intent.md の L6）。
- **商標と周辺の OSS のライセンス**：法務の確認待ち（intent.md の L1〜L3）。

## 7. 領域の文書と ADR の番号

領域の文書で ADR を起票するときは、この表で割り当てた範囲の中で採番する。範囲が足りなくなったら、表の末尾に新しい範囲を足す（既存の範囲をずらさない）。Epic は、roadmap.md（まだない）の草案の番号である。

| ファイル | 範囲 | ADR | 関連する Epic |
| --- | --- | --- | --- |
| `protocol-and-compatibility.md` | ワイヤープロトコル、ApiVersions、許可・拒否する API、エラーコードの対応、クライアントの行列、本家との差分テスト | 0006–0008 | E1、E2 |
| `broker-and-log-storage.md` | ブローカーの構成、ログのセグメントと索引、保持・圧縮、EBS の選定、ディスクの容量の管理 | 0009–0011 | E1、E3 |
| `replication-and-durability.md` | 複製の数と ISR、AZ の配置（rack）、リーダーの選出、fetch-from-follower、耐久性の監査、障害注入の方針 | 0012–0014 | E3 |
| `metadata-and-control.md` | KRaft のクォーラムの構成と入れ替え（KIP-853）、パーティションの再配置、負荷に基づく配置、ブローカーの cordon（4.3） | 0015–0017 | E3、E9 |
| `tiered-and-object-storage.md` | RemoteStorageManager、S3 のキーの設計、リモートのメタデータ、大阪への写し、ディスクレスのトピック（Later） | 0018–0020 | E4 |
| `transactions-and-idempotence.md` | 冪等なプロデューサー、トランザクションのコーディネーター、KIP-890、`transactional.id` の上限と ACL、Kafka Streams の exactly-once | 0021–0022 | E5 |
| `consumer-groups.md` | 従来のプロトコルと KIP-848、オフセットの保存と保持、遅れ（lag）、共有のグループ（KIP-932、Later） | 0023–0024 | E6 |
| `multi-tenancy-and-quotas.md` | 論理クラスタの名前空間のパッチ、要求ごとのテナントの解決、クォータの種類、動的なクォータ、配置とセル、層ごとの上限 | 0025–0027 | E7 |
| `security-and-acls.md` | 脅威モデル、API キーと SASL、サービスアカウント、ACL、TLS、保存時の暗号化、監査ログ、データの削除 | 0028–0030 | E8 |
| `control-plane-and-provisioning.md` | 制御面の API と状態、望ましい状態の反映（データ面のエージェント）、物理クラスタの作成と拡張、EKS のオペレーター | 0031–0033 | E1、E9 |
| `console-and-api.md` | コンソール、管理 API の形と版、CLI、Terraform のプロバイダー、ログイン | 0034–0036 | E10 |
| `metrics-and-billing.md` | テナント向けのメトリクスの API、使用量の計測、CU の定義、請求、費用の上限 | 0037–0039 | E11 |
| `connectors-and-schema.md` | スキーマレジストリ、マネージドのコネクター（Later） | 0040–0042 | （S2 の Epic） |
| `infrastructure.md` | AWS のアカウントと VPC、EKS、NLB と SNI のプロキシ、PrivateLink（Later）、災害復旧 | 0043–0045 | E1、E12 |
| `observability.md` | 運用のメトリクス・ログ・トレース、外からの合成監視、SLO とアラート | 0046–0047 | E12 |
| `capacity.md` | 負荷のモデル、ブローカー・ディスク・S3 の必要量、費用のモデル（NFR-010） | 0048 | E9、E12 |
| `delivery.md` | CI/CD、ブローカーのローリング更新、本家の版の追従とパッチの当て直し、フィーチャーフラグ | 0049–0050 | E1、E12 |
| `data-model.md` | 制御面のテーブル、データ面のメタデータ（KRaft の記録）の索引 | なし（各領域の ADR を参照） | — |

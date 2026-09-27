# Multi-tenancy and quotas: Kafka

論理クラスタの名前空間のパッチ、要求ごとのテナントの解決、クォータの種類と掛け方、層ごとの上限、動的なクォータの配分と背圧、配置とセル、うるさい隣人の試験の設計。大枠は [ADR-0004](../decisions/0004-logical-clusters-on-shared-physical-clusters.md)（共有の物理クラスタの上の論理クラスタ）と [ADR-0003](../decisions/0003-kraft-metadata-and-cluster-placement.md)（配置）にあり、この文書はその中身を決める。API の表は [protocol-and-compatibility.md](protocol-and-compatibility.md) の 4 節にある。

本家の振る舞いは、2026-09-27 に kafka.apache.org の 4.3 の文書（Design の Quotas、Broker Configs）と本家のソースで、Kora の振る舞いは論文（[Kora](https://vldb.org/pvldb/vol16/p3822-povzner.pdf)、VLDB 2023）で、Confluent Cloud の上限は [Cluster types](https://docs.confluent.io/cloud/current/clusters/cluster-types.html) で確かめた。確かめられなかったものは「未検証」と書く。要件 ID は、E7 の各変更の `spec.md` に移すときに振る。

## 1. 目的と範囲

- テナントには、専用のクラスタと同じに見せる。トピック・グループ・`transactional.id`・ACL の名前は、他のテナントと衝突せず、他のテナントの資源は一切見えない（intent.md の守るべき振る舞い、NFR-008）。
- 他のテナントの負荷の急増で、自分のクォータの中のスループットが削られない（NFR-008：絞られる時間が週 5 分以内のテナントを 99.9% 以上）。
- 論理クラスタの上限の引き上げを、クォータの変更だけで 1 分以内に済ませる（NFR-007）。
- 本家のコードへのパッチを、差し込み口で作れないものに限り、場所と理由を一覧にする（[ADR-0001](../decisions/0001-upstream-brokers-and-stack.md)）。

範囲に入れないもの：

| もの | 扱う場所 |
| --- | --- |
| API ごとの通す・拒否するの表、トピックの設定の表 | [protocol-and-compatibility.md](protocol-and-compatibility.md) |
| API キー、SASL、ACL の意味、暗号化 | security-and-acls.md |
| CU の定義と値段、使用量の計測 | metrics-and-billing.md |
| 物理クラスタの作成と拡張、論理クラスタの移動 | control-plane-and-provisioning.md、[metadata-and-control.md](metadata-and-control.md) |
| SNI のプロキシ、DNS、ブートストラップのホスト名 | infrastructure.md |
| `transactional.id` とグループの数の上限の中身 | [transactions-and-idempotence.md](transactions-and-idempotence.md)、[consumer-groups.md](consumer-groups.md) |

## 2. 本家・Kora・Confluent Cloud の形（確かめたこと）

### 2.1 本家のクォータ

| 項目 | 本家 | 出典 |
| --- | --- | --- |
| 種類 | 帯域（`producer_byte_rate`・`consumer_byte_rate`。KIP-13、0.9）、要求の処理時間（`request_percentage`。KIP-124、0.11。ネットワークと I/O のスレッドの時間の割合。n% は 1 スレッドの n%）、接続の作成の頻度（`connection_creation_rate`。IP 単位。KIP-612）、コントローラーの変更の頻度（`controller_mutation_rate`。トピック・パーティションの作成・削除。KIP-599） | [Design: Quotas](https://kafka.apache.org/43/design/design/)、[QuotaConfig.java](https://github.com/apache/kafka/blob/trunk/server-common/src/main/java/org/apache/kafka/server/config/QuotaConfig.java) |
| 単位 | `(user, client-id)`・`user`・`client-id` の組。最も具体的なものが当たる。値はブローカーごと | [Design: Quotas](https://kafka.apache.org/43/design/design/) |
| 超えたとき | ブローカーが必要な遅れを計算し、`throttle_time_ms` を付けた応答をすぐ返し（fetch はデータなし）、遅れの間そのクライアントの通信路を止める。クライアントも遅れの間は送らない | 同上 |
| 測り方 | 小さな窓の集まり（`quota.window.num` 11 × `quota.window.size.seconds` 1 秒） | [Broker Configs](https://kafka.apache.org/43/configuration/broker-configs/) |
| 差し込み口 | `ClientQuotaCallback`（`client.quota.callback.class`）。`quotaMetricTags(type, principal, clientId)` でクォータを共有する単位を決め、`quotaLimit(type, tags)` で値を返す。`quotaResetRequired` で値の再読み込みを促す。種類は `PRODUCE`・`FETCH`・`REQUEST`・`CONTROLLER_MUTATION` | [ClientQuotaCallback.java](https://github.com/apache/kafka/blob/trunk/clients/src/main/java/org/apache/kafka/server/quota/ClientQuotaCallback.java) |
| 接続の上限 | `max.connections`、`max.connections.per.ip`、`max.connection.creation.rate`（ブローカー全体・リスナーごと）。テナント（主体）の単位の接続の数の上限はない | [Broker Configs](https://kafka.apache.org/43/configuration/broker-configs/) |

- 接続の数とパーティションの数と InitProducerId は、`ClientQuotaCallback` の種類にない。テナントの単位で掛けるには、パッチが要る。

### 2.2 Kora

[Kora](https://vldb.org/pvldb/vol16/p3822-povzner.pdf) の 5 節による。

- **名前空間**：資源（トピック、グループ、ACL など）に論理クラスタの ID を付け、ブローカーの割り込みの処理で、認証のときに接続に結び付けた ID を要求に付ける。クライアントからは普通の名前に見える（5.1 節）。専用のクラスタは「テナントが 1 つの共有のクラスタ」。健康の確認のエージェントも別の論理クラスタで動かす。
- **クォータの種類**：書き込み・読み取りの帯域、CPU（要求と接続の処理の時計の時間で近似）、接続の数と接続の試みの頻度、メモリーを使う振る舞い、パーティションの作成・削除（コントローラーを守る）（5.2 節）。
- **背圧**：帯域・CPU・接続の頻度に、ブローカー全体の安全な上限を置く。超えたら、テナントのクォータを割り当ての比で自動で下げる。CPU は要求の待ち行列が閾値に達したら背圧を掛ける。高い負荷は再配置のきっかけになる（5.2.1 節）。
- **動的なクォータ**：静的な等分は、偏ったワークロード（熱いパーティション）で、全体では余裕があるのに一部のブローカーで絞りすぎる。ブローカーがテナントごとの使用量と throttle の情報をクォータのコーディネーターに送り、コーディネーターがブローカー×テナントの値を計算し直して配る。コーディネーターは複数で、決定的なハッシュでテナントを振り分ける。値の揺れによる細かい throttle を避けるため、テナント全体の使用量がクォータに対して閾値を超えるまで throttle を遅らせる（lazy throttling）。静的から動的に替えて、帯域の SLO（週に絞られる時間 5 分以内）を満たすテナントの割合が 99% から 99.9% 超になった（5.2.2 節）。
- **セル**：テナントを物理クラスタの中のブローカーの部分集合（セル）に閉じ込める。セルのブローカーは AZ に均等に置く。セルの大きさは 1 つの論理クラスタの最大を収められるように選ぶ。セルの負荷は「平均のブローカーの負荷、複製の数の使用率、帯域の使用率」の最大。新しいテナントは、無作為に選んだ 2 つのセルの負荷の低い方に置く。24 台・6 台のセルの試験で、クラスタの負荷が 73% から 53% に下がった（5.3 節）。

### 2.3 Confluent Cloud の上限（参考）

[Cluster types](https://docs.confluent.io/cloud/current/clusters/cluster-types.html)（2026-09-27 に確認）。eCKU あたりの値と、クラスタの最大。

| 項目 | Basic（eCKU あたり / 最大） | Standard（同） |
| --- | --- | --- |
| eCKU の最大 | 50 | 10 |
| 書き込み | 5 / 250 MB/秒 | 25 / 250 MB/秒 |
| 読み取り | 15 / 750 MB/秒 | 75 / 750 MB/秒 |
| パーティション（複製の前） | 30 / 1,500 | 250 / 2,500 |
| 接続 | 20 / 1,000 | 1,000 / 10,000 |
| 接続の試み | 5 / 250 毎秒 | 50 / 500 毎秒 |
| 要求 | 100 / 5,000 毎秒 | 1,500 / 15,000 毎秒 |
| メッセージの大きさ | 8 MB | 8 MB |
| API キー | 50 | 250 |
| ACL | 1,000 | 1,000 |

- パーティションの作成・削除は、5 分あたり Basic 250、Standard 500、Enterprise 500、Dedicated 5,000、Freight 500（[Cluster types](https://docs.confluent.io/cloud/current/clusters/cluster-types.html)、2026-09-27 に確認）。
- 負荷が高いと、新しい接続を遅らせるか、クライアントを throttle する。最大の上限は厳密には強制していない、としている。

## 3. 方針

- **分離の単位は論理クラスタだけ。** 名前空間・クォータ・ACL・メトリクスのすべてを、論理クラスタの ID で分ける（[ADR-0004](../decisions/0004-logical-clusters-on-shared-physical-clusters.md)）。
- **名前空間は、要求の出入口の 1 か所の表駆動のパッチで作り、表にないものは断る。** 例外の箇所（コーディネーターの中など）は一覧にして数を抑える（[ADR-0025](../decisions/0025-tenant-namespace-patch.md)）。
- **クォータは、本家の仕組み（`ClientQuotaCallback` と throttle）で掛けられるものは本家で掛ける。** 掛けられないもの（接続の数、パーティションの数、InitProducerId、`transactional.id`・グループの数）だけをパッチで掛ける（[ADR-0026](../decisions/0026-tenant-quotas-and-tier-limits.md)）。
- **テナントのクォータは、使用量に応じてブローカーに配り直す。** 配り直しはデータ面の中で行い、制御面が止まってもデータの経路と配り直しが続く（[ADR-0027](../decisions/0027-dynamic-quota-coordinator-and-backpressure.md)）。
- **クォータを超えたら、断らずに遅らせる。** 本家の throttle の応答を使い、クライアントの振る舞いを本家と同じにする。例外は、数の上限（パーティション、グループ、`transactional.id`）で、これは断る。

## 4. 名前空間

### 4.1 名前の形

- 論理クラスタの ID は `lc-` ＋ 小文字の英数字 6 文字（例 `lc-7kq2vx`）。[ADR-0003](../decisions/0003-kraft-metadata-and-cluster-placement.md) の `lc-<ランダムな英数字>` の長さを、ここで 6 文字に決める。
- 内部の名前は `<lc-id>_<テナントの名前>`（例 `lc-7kq2vx_orders`）。区切りは `_`。`lc-id` は `_` を含まないので、最初の `_` までが接頭辞になる。
- 対象：トピック、グループ（classic・consumer・共有・Streams）、`transactional.id`、ACL の資源の名前（TOPIC・GROUP・TRANSACTIONAL_ID）、`ConfigResource` の名前（TOPIC・GROUP）。
- トピックの名前の長さ：本家の上限 249 文字から接頭辞の 10 文字を引いた 239 文字が、テナントの上限になる。240 文字以上は、本家と同じ `INVALID_TOPIC_EXCEPTION` で断る。本家との違いとして、利用者向けの文書と差分テストの「許された違い」に載せる。
- 内部トピック（本家の `__consumer_offsets`、`__transaction_state`、`__remote_log_metadata`、`__share_group_state`、`__cluster_metadata` と、この題材の `__<brand>_*` のすべて。一覧は [data-model.md](data-model.md) の 4 節）は接頭辞を持たず、テナントには見えない。テナントが `__consumer_offsets` という名前のトピックを作ると、`lc-7kq2vx___consumer_offsets` という普通のトピックになる（本家の内部トピックとは衝突しない）。

### 4.2 テナントの解決

```
クライアント ─TLS（SNI = <lc-id>.<region>.<brand>.<domain> か、ブローカーごとのホスト名 b<broker-id>-<lc-id>.<az-id>.<region>.<brand>.<domain>）─▶ SNI のプロキシ ─▶ ブローカー
  1. TLS の握手：ブローカーが TLS を終端し、SNI からテナントの候補（lc-id）を得る
     → テナントの接続の試みの頻度を数える（パッチ。5 節）
  2. SASL/PLAIN：API キーを確かめ、サービスアカウントと論理クラスタを得る（security-and-acls）
  3. KafkaPrincipalBuilder：SNI の lc-id と API キーの lc-id が一致しなければ認証の失敗にする。
     一致すれば、主体に lc-id を持たせる（TenantPrincipal）
     → テナントの接続の数を数える（パッチ。5 節）
  4. 以後のすべての要求は、主体の lc-id で名前空間を通る
```

- KafkaPrincipalBuilder は、SASL_SSL の接続で `SSLSession` を受け取れる（本家の `SaslAuthenticationContext` が `Optional<SSLSession>` を持つ。[SaslAuthenticationContext.java](https://github.com/apache/kafka/blob/4.3/clients/src/main/java/org/apache/kafka/common/security/auth/SaslAuthenticationContext.java)、2026-09-27 に確認）。SNI を `ExtendedSSLSession` の `getRequestedServerNames()` で取り出せるかは未検証（E1 の `sni-tenant-resolution-poc` で確かめる）。
- SNI と API キーの一致を求めるのは、他のテナントのホスト名に自分の API キーで繋ぎ、そのテナントのブローカーの一覧を得るような取り違えを防ぐため。
- 認証の前に届く ApiVersions は、テナントに依らない応答を返す（本家と同じ）。
- **代理の接続**：データ面のエージェント（[ADR-0031](../decisions/0031-control-plane-reconciliation-and-agent.md)）がテナントの資源に命令する（トピックの作成、ACL の変更など）ときは、内部のリスナーで、エージェントの資格情報に「代理する論理クラスタ」を付けて認証する（SASL/PLAIN のユーザー名を `agent-<pc-id>@<lc-id>` の形にし、自社のコールバックで解く）。主体は、その論理クラスタの管理の主体として扱い、名前空間のパッチ・設定の許可リスト・パーティションの数の上限を、テナントの要求と同じく通す。代理の接続は内部のリスナーだけで受け付け、テナントのリスナーでは断る。本家の PLAIN の認可の ID（authzid）は、ユーザー名と違う値を本家が `Client requested an authorization id that is different from username` で拒否するため使わない（[PlainSaslServer.java](https://github.com/apache/kafka/blob/4.3/clients/src/main/java/org/apache/kafka/common/security/plain/internals/PlainSaslServer.java)、2026-09-27 に確認）。

### 4.3 要求と応答の書き換え

- 要求の出入口（本家の要求の振り分けの直前と、応答の送信の直前）の 1 か所に、API のキー × 版ごとの「資源の名前の場所」の表を持つ。表は [protocol-and-compatibility.md](protocol-and-compatibility.md) の 4 節の API の表と同じ行を持ち、開発リポジトリの spec の正本にする。
- 要求：表の場所の名前に接頭辞を付ける。
- 応答：接頭辞を外す。一覧の応答（Metadata、ListGroups、ListTransactions、DescribeConfigs、DescribeAcls、ListConfigResources など）は、テナントの接頭辞で始まらない要素を取り除く。
- **トピックの ID**：物理クラスタで一意の UUID で、テナントを持たない。ID で指す要求（Fetch の v13 以上、DeleteTopics、DescribeTopicPartitions、consumer の割り当てなど）は、ID から名前を引き、接頭辞がテナントのものか確かめる。違えば、存在しない ID と同じ `UNKNOWN_TOPIC_ID` を返す（他のテナントのトピックの存在を漏らさない）。
- **エラー**：他のテナントの資源に触れようとしたときは、その資源がないときと同じエラーを返す（`UNKNOWN_TOPIC_OR_PARTITION`、`GROUP_ID_NOT_FOUND` など）。権限のエラーにしない（存在を漏らさない）。
- **ACL**：資源の名前の LITERAL・PREFIXED のパターンに接頭辞を付ける。本家の LITERAL の `*`（すべての資源）は、PREFIXED の `<lc-id>_` に置き換える。応答では逆に戻す。主体（`User:sa-...`）はサービスアカウントの ID で物理クラスタで一意なので書き換えない。テナントの外の主体を指す ACL の作成は、security-and-acls の領域で断る。
- **表にない API・版**：安全な側に倒して断る（[protocol-and-compatibility.md](protocol-and-compatibility.md) の 4 節。CI で防ぎ、本番では `UNSUPPORTED_VERSION` とアラート）。

### 4.4 クラスタとブローカーの見せ方

| 応答 | 見せるもの |
| --- | --- |
| Metadata・DescribeCluster の `cluster_id` | 論理クラスタの ID |
| Metadata・DescribeCluster のブローカーの一覧 | S1：物理クラスタのすべてのブローカー。S2：セルのブローカー（8 節）。ホスト名はテナントの形で、AZ ID を含む `b<broker-id>-<lc-id>.<az-id>.<region>.<brand>.<domain>:9092`（[ADR-0044](../decisions/0044-nlb-sni-proxy-and-zonal-hostnames.md)。DNS と SNI の振り分けは [infrastructure.md](infrastructure.md) の 5 節）。ラック（AZ）は見せる（fetch-from-follower のため） |
| `controller_id` | 本家の DescribeCluster の意味に合わせ、ブローカーの 1 つを返す。本家も、ブローカーが処理したときは生きているブローカーの ID を無作為に返す（[DescribeClusterResponse.json](https://github.com/apache/kafka/blob/4.3/clients/src/main/resources/common/message/DescribeClusterResponse.json)、2026-09-27 に確認）。本システムは、そのテナントに見えるブローカーから選ぶ |
| FindCoordinator | 接頭辞付きの ID で選んだブローカーを、テナントの形のホスト名で返す |

- S1 でブローカーの一覧をすべて返すのは、グループとトランザクションのコーディネーター（`__consumer_offsets`・`__transaction_state` のリーダー）が、テナントのパーティションを持たないブローカーにもいるため。ブローカーの台数がテナントに見えるが、資源の名前やデータは見えない。

### 4.5 パッチの一覧

| # | 場所 | 中身 | 差し込み口で作れない理由 | 関連 |
| --- | --- | --- | --- | --- |
| P1 | 要求の出入口 | 4.3 節の書き換えと絞り込み。`retention.ms` が 6 時間より短いトピックの設定の要求に `local.retention.ms` を足す（[tiered-and-object-storage.md](tiered-and-object-storage.md) の 12 節。2026-09-27 に追加） | 本家に名前空間の差し込み口がない | ADR-0004、Kora の 5.1 節 |
| P2 | Metadata・DescribeCluster・FindCoordinator の応答 | 4.4 節のクラスタの ID とホスト名 | 広告するリスナーは本家ではブローカーで 1 つ | 同上 |
| P3 | グループのコーディネーターの正規表現の評価 | consumer のグループの正規表現を、テナントのトピックだけで評価 | コーディネーターの内部の処理 | KIP-848、[consumer-groups.md](consumer-groups.md) の 4.3 節 |
| P4 | コーディネーターの InitProducerId・グループの作成 | `transactional.id`・グループの数の上限 | `ClientQuotaCallback` にない種類 | KIP-936（未実装）、[transactions-and-idempotence.md](transactions-and-idempotence.md) の 6 節 |
| P5 | TLS の握手の後、認証の後 | テナントの接続の試みの頻度と接続の数 | 本家は IP の単位だけ | KIP-612 |
| P6 | CreateTopics・CreatePartitions の前 | テナントのパーティションの数の上限 | CreateTopicPolicy はテナントの現在の合計を知らない | KIP-599 |
| P7 | InitProducerId | テナントの頻度の上限（throttle） | `ClientQuotaCallback` にない種類 | KIP-936 |

- P1・P2 は 1 つのクラスにまとめる。P3〜P7 は、それぞれ本家のコードの 1 か所に呼び出しを足すだけにし、中身は別のモジュール（Java）に置く。当て直しの手間を、呼び出しの行だけにする。
- パッチの行数と対象のファイルを CI で出し、増えたらレビューで理由を確かめる（[ADR-0001](../decisions/0001-upstream-brokers-and-stack.md) の Confirmation）。

## 5. クォータの種類と掛け方

| 種類 | 掛け方 | 単位 | 超えたとき |
| --- | --- | --- | --- |
| 書き込みの帯域 | `ClientQuotaCallback`（`PRODUCE`）。タグは `{tenant: lc-id}` だけにし、テナントのすべての主体とクライアントで共有する | ブローカーごとの値（7 節の動的な配分） | throttle |
| 読み取りの帯域（S3 からの読み戻しを含む） | 同（`FETCH`）。複製の fetch は数えない | 同上 | throttle |
| 要求の処理時間 | 同（`REQUEST`、`request_percentage`） | 同上 | throttle |
| パーティションの作成・削除の頻度 | 同（`CONTROLLER_MUTATION`、`controller_mutation_rate`） | ブローカーごと（要求を受けたブローカー）。静的な値 | 本家どおり `THROTTLING_QUOTA_EXCEEDED`（KIP-599。新しいクライアントは待って再試行） |
| 接続の数 | パッチ P5（認証の後） | ブローカーごとに ceil(2 × 上限 ÷ ブローカーの数)。全体の合計が上限を超えたら、コーディネーターが上限 ÷ ブローカーの数に絞る | 新しい接続を閉じる |
| 接続の試みの頻度 | パッチ P5（TLS の握手の後、SASL の前） | ブローカーごとに上限 ÷ ブローカーの数 | 握手の後の処理を遅らせてから閉じる。本家の IP の単位の接続の頻度のクォータ（KIP-612）は、率を下回るまでか 1 秒の短い方だけ処理を遅らせ、なお超えていれば閉じる（[KIP-612](https://cwiki.apache.org/confluence/display/KAFKA/KIP-612%3A+Ability+to+Limit+Connection+Creation+Rate+on+Brokers)、2026-09-27 に確認）。P5 もこの形に合わせる |
| パーティションの数 | パッチ P6 | 論理クラスタの合計（ブローカーのメタデータの写しで数える。同時の要求で少し超えうる。制御面の調停で検知） | CreateTopics・CreatePartitions を `POLICY_VIOLATION`（文言に上限を書く） |
| InitProducerId の頻度 | パッチ P7 | ブローカーごと（静的） | throttle（[transactions-and-idempotence.md](transactions-and-idempotence.md) の 4.2 節） |
| `transactional.id` の数 | パッチ P4 | コーディネーターのパーティションごと | `TRANSACTIONAL_ID_AUTHORIZATION_FAILED`（同 6 節） |
| グループの数 | パッチ P4 | 同上 | `GROUP_AUTHORIZATION_FAILED`（[consumer-groups.md](consumer-groups.md) の 6 節） |
| 圧縮のトピックの大きさ | データ面のエージェントが 1 分ごとに数え、超えたら、そのテナントの圧縮のトピックへの書き込みの帯域のクォータを最小にする | 論理クラスタの合計（複製の前） | throttle（書き込みがほぼ止まる）。テナントには上限の超過をメトリクスと通知で知らせる |

- ブローカー全体の `max.connections`・`max.connection.creation.rate` も、テナントの上限の合計より余裕を持たせて設定する（最後の守り）。値は capacity の領域。
- AlterClientQuotas はテナントに拒否する（[protocol-and-compatibility.md](protocol-and-compatibility.md) の 4 節）。テナントはクォータの値をメトリクスの API で見る。

## 6. 層ごとの上限

S1 の初期値。CU（容量の単位）の正式な定義と値段は metrics-and-billing の領域で決める。この表は、Standard を「1 CU あたりの値 × CU（1〜10）」で表す仮の定義で、Confluent Cloud の Standard の eCKU の値に揃えた（2.3 節）。すべて未検証で、E7 の `noisy-neighbor-suite` の負荷試験で見直す。

| 項目 | Basic（固定） | Standard（1 CU あたり） | Standard の最大（10 CU） | Dedicated（S2） |
| --- | --- | --- | --- | --- |
| 書き込み | 25 MB/秒 | 25 MB/秒 | 250 MB/秒 | 物理クラスタの大きさ |
| 読み取り | 75 MB/秒 | 75 MB/秒 | 750 MB/秒 | 同上 |
| 要求の処理時間（`request_percentage` のテナントの合計） | 100% | 75%（1 スレッドの 75%。毎秒 1,500 の要求を平均 0.5ms と見た値） | 750% | 同上 |
| パーティション（複製の前） | 500 | 250 | 2,500 | 物理クラスタの大きさ |
| パーティションの作成・削除 | 毎秒 1（`controller_mutation_rate`） | 毎秒 2 | 毎秒 2 | 毎秒 20 |
| 接続 | 500 | 1,000 | 10,000 | 物理クラスタの大きさ |
| 接続の試み | 毎秒 50 | 毎秒 50 | 毎秒 500 | 同上 |
| `transactional.id` | 1,000 | 10,000（CU によらない） | 10,000 | 上書きで決める |
| InitProducerId | 毎秒 10 | 毎秒 100（CU によらない） | 毎秒 100 | 同上 |
| グループ | 1,000 | 10,000（CU によらない） | 10,000 | 同上 |
| 圧縮のトピックの大きさ（複製の前） | 50 GiB | 100 GiB | 1 TiB | 同上 |
| メッセージの大きさ（`max.message.bytes`） | 2 MiB | 8 MiB | 8 MiB | 8 MiB（[ADR-0007](../decisions/0007-topic-config-allowlist.md)） |
| ACL | 1,000 | 10,000（CU によらない） | 10,000 | 上書きで決める |
| API キー | 50 | 250（CU によらない） | 250 | 上書きで決める |
| 可用性の目標 | 99.5% | 99.95%（S1） | 同左 | 99.99% |

- Basic と Standard は、物理クラスタを分ける（[ADR-0004](../decisions/0004-logical-clusters-on-shared-physical-clusters.md)）。
- CU の変更（Standard の上限の引き上げ）は、制御面が新しいテナントのクォータをクォータのコーディネーターに渡すだけで済み、1 分以内に効く（NFR-007）。パーティションの上限の引き上げも同じ。
- 上限を緩める例外は、論理クラスタの単位の上書き（制御面の `logical_cluster_limits`）だけで行い、監査ログに残す。コードに特定のテナントを書かない。
- 圧縮のトピックの大きさの値は、[ADR-0010](../decisions/0010-segment-retention-and-compaction-defaults.md) の提案（Standard の CU あたり 100 GiB）に合わせた。
- ACL の値は [ADR-0029](../decisions/0029-tenant-scoped-acls-and-rbac.md)、API キーの値は [security-and-acls.md](security-and-acls.md) に合わせた。

## 7. 動的なクォータと背圧

### 7.1 置き場所

- クォータのコーディネーターは、**物理クラスタごとに、データ面の中で動かす**（EKS の、ブローカーと同じクラスタの別の Deployment。Java）。制御面の障害でデータの経路の配分が止まらないようにするため（[ADR-0027](../decisions/0027-dynamic-quota-coordinator-and-backpressure.md)。[ADR-0003](../decisions/0003-kraft-metadata-and-cluster-placement.md) の「データの経路は制御面に依存しない」に合わせる。README の 1 節の図もこれに合わせて直した）。
- 制御面は、テナントのクォータの総量（層と CU と上書き）を、望ましい状態としてデータ面のエージェント経由で渡す。エージェントは内部トピック `__<brand>_tenants` に論理クラスタの登録（接頭辞、層、クォータの上限）を書き（[control-plane-and-provisioning.md](control-plane-and-provisioning.md)）、コーディネーターとブローカーはこれを読む。
- コーディネーターは 3 つ動かし、Kafka のコンシューマーグループで `__<brand>_quota_usage` のパーティションを分け合う。テナントはパーティションにハッシュで決まるので、1 つのテナントの計算は 1 つのコーディネーターが行う（Kora の決定的なハッシュと同じ考え方）。1 つが落ちても、グループのリバランスで他が引き継ぐ。

### 7.2 流れ

```
ブローカー（5 秒ごと）
  └─ __<brand>_quota_usage に書く：キー (tenant)、値 {broker, 窓, produce_bytes/s, fetch_bytes/s,
       request_time%, throttled_ms, leader_partitions, replica_partitions, connections}
クォータのコーディネーター（10 秒ごと、担当のテナントごと）
  ├─ テナントの総量 Q（種類ごと）と、ブローカーごとの使用量 u_b を集める
  ├─ ブローカーごとの値 q_b を計算する（7.3 節）
  └─ __<brand>_quota_assignments に書く：キー (broker, tenant)、値 {q_b（種類ごと）, 全体の使用量 U, 計算の時刻}（圧縮のトピック）
ブローカー
  └─ 内部のコンシューマーで __<brand>_quota_assignments の自分の分を読み、ClientQuotaCallback の値を差し替える
     （quotaResetRequired = true で本家に再読み込みさせる）
```

- 2 つの内部トピックは、複製 3・`min.isr` 2、テナントには見えない。名前は、この題材の他の内部トピック（`__<brand>_tenants`、`__<brand>_credentials`）と同じく `__<brand>_` で始める（[ADR-0028](../decisions/0028-service-accounts-api-keys-and-sasl-plain.md)、[control-plane-and-provisioning.md](control-plane-and-provisioning.md)）。

### 7.3 配分の計算（帯域と要求の処理時間）

テナント t、種類 k、総量 Q、そのテナントの対象のブローカーの集合 B（書き込みはリーダーを持つブローカー、読み取りは fetch-from-follower のため複製を持つすべてのブローカー）について：

1. 需要 d_b = max(u_b × (throttled_b ? 1.5 : 1.1), Q × 0.05 ÷ |B|)。throttle されていたブローカーには多めに見積もり、使っていないブローカーにも最低の分を残す。
2. 配分 q_b = Q × d_b ÷ Σ d。合計は Q になる。
3. テナント全体の使用量 U = Σ u_b が Q の 50% 未満なら、q_b = max(q_b, Q ÷ |B|)（静的な等分より絞らない）。
4. **遅らせる throttle（lazy throttling）**：ブローカーは、最新の U が Q の 90% 未満なら、手元の上限を q_b の 2 倍まで緩める。U が 90% 以上なら q_b で絞る。全体の使用量が一時的に Q を超える幅は、配分の 1 周（最大 15 秒）の間、最大で 2Q に抑えられる。

- 値（1.1、1.5、5%、50%、90%、2 倍、周期）は初期値。E7 の負荷試験で、NFR-008 の指標（下の 7.5 節）が良くなる方へ調整する。

### 7.4 背圧

- ブローカーごとに、資源の安全な上限 L を置く：書き込みの帯域、読み取りの帯域、要求の処理時間、接続の試みの頻度。値は、インスタンスの種類ごとの負荷試験で決める（capacity の領域）。
- ブローカーのテナントの使用量の合計が 0.9 L を超えたら、そのブローカーのすべてのテナントの値を f = 0.9 L ÷ Σ q_b 倍にする（割り当ての比で一律に下げる）。`ClientQuotaCallback` の中で掛ける。
- 要求の処理時間は、要求の待ち行列（`queued.max.requests`）が 80% に達したら、同じく一律に下げる（Kora の「CPU は待ち行列の閾値で背圧」に倣う）。
- 背圧は一時の状態として扱う。1 分以上続いたら、再配置と拡張の判断に渡す（[metadata-and-control.md](metadata-and-control.md) の負荷に基づく配置）。
- 背圧で絞った時間は、テナントの「クォータの中なのに絞られた時間」として数える（7.5 節）。

### 7.5 NFR-008 の測り方

- テナントごとに、1 分ごとの「テナント全体の使用量が Q 未満なのに、どこかのブローカーで throttle された時間」を数える。週に 5 分を超えたテナントの割合を、物理クラスタごと・全体で出す。目標：週 5 分以内のテナントが 99.9% 以上。
- この指標は、動的な配分と背圧の値を調整するための主な指標にする。

### 7.6 コーディネーターが止まったとき

- ブローカーは最後の配分を使い続ける（合計は Q を超えない）。
- 配分が 5 分以上更新されないとき、または対象のブローカーの集合が変わったとき（リーダーの移動）は、静的な等分 Q ÷ |B| に戻す。
- 背圧（7.4 節）はブローカーの中で完結するので、コーディネーターがなくても効く。

## 8. 配置とセル

- **S1**：論理クラスタを物理クラスタに置く規則（得点、受け入れの条件、2 つの無作為の選択）は、[ADR-0033](../decisions/0033-logical-cluster-placement.md) と [control-plane-and-provisioning.md](control-plane-and-provisioning.md) で決めた。論理クラスタのパーティションは、物理クラスタのすべてのブローカーに、本家の rack を考えた配置で散らす（[metadata-and-control.md](metadata-and-control.md)）。
- **S2**：セルを入れる。
  - セルは、物理クラスタの中の 6 台（AZ ごとに 2 台）から始める（Kora の試験の大きさ。値は capacity と [metadata-and-control.md](metadata-and-control.md) で決める）。セルは、1 つの論理クラスタの最大（Standard の 10 CU、書き込み 250 MB/秒）を収められる大きさにする。
  - 論理クラスタのパーティションは、そのセルのブローカーだけに置く（配置の制約をパッチではなく、配置の仕組みで作る）。
  - Metadata のブローカーの一覧は、セルのブローカーに絞る。
  - セルの負荷が上限に近づいたら、テナントを負荷の低いセルへ移し、なければ物理クラスタを広げて新しいセルを作る。
  - コーディネーター（`__consumer_offsets`・`__transaction_state` のリーダー）がセルの外のブローカーにいると、クライアントはセルの外にも繋ぐ。セルの利点（接続の数）を保つ方法は未解決（12 節）。

## 9. 障害のときの振る舞い

| 障害 | 振る舞い | 利用者への影響 |
| --- | --- | --- |
| クォータのコーディネーターの停止 | 7.6 節 | 偏ったワークロードのテナントが、静的な等分で絞られうる |
| `__<brand>_quota_assignments` を読めない | 同上 | 同上 |
| 1 つのテナントの急増 | そのテナントを throttle。ブローカーの合計が L に近づけば背圧 | 急増したテナントだけが遅れる。背圧の間は、同じブローカーのテナントも比で絞られる |
| 名前空間の表にない API | 断る（`UNSUPPORTED_VERSION`）。アラート | その API を使うクライアントが失敗する |
| 名前空間のパッチの不具合 | 本家との差分テストと性質ベーステストで防ぐ。本番では、隣のテナントの確認（合成監視の 2 つの論理クラスタで、互いの資源が見えないことを 1 分ごとに確かめる） | 最も重い事故。ページングし、該当する物理クラスタへの新しい要求の種類を止める |
| 制御面の停止 | クォータの総量の変更と、新しい論理クラスタの作成が止まる。配分とデータの経路は続く | CU の変更が遅れる |
| パーティションの数の上限の同時の超過 | 少し超えうる。制御面の調停で検知し、テナントに知らせる。削除はしない | 上限を少し超えて作れる |

## 10. セキュリティ（テナントの分離）

- **二重の守り。** 名前空間のパッチに加えて、Authorizer の包み（TenantAuthorizer）が、主体の論理クラスタと資源の接頭辞の一致を確かめる（[ADR-0029](../decisions/0029-tenant-scoped-acls-and-rbac.md)）。どちらか 1 つが壊れても、他のテナントの資源に届かない。
- **すべての要求がテナントの解決を通る。** 主体に lc-id のない接続（内部のリスナーを除く）は、認証の段階で断る。内部のリスナー（複製、コントローラー、エージェント）は別のポートで、テナントの経路からは届かない（infrastructure の領域）。
- **SNI と API キーの一致**（4.2 節）。
- **存在を漏らさない。** 他のテナントの資源は「ない」と答える。トピックの ID、PID、グループの ID のどれからも、他のテナントの存在が分からない。
- **メトリクスとログ**：テナント向けのメトリクスの API は、主体の lc-id のものだけを返す。運用のメトリクスのラベルに、テナントのトピックの名前を生で入れない（上位 N 件とハッシュ。observability の領域）。
- **クォータの情報**：DescribeClientQuotas は拒否。throttle の応答の `throttle_time_ms` は、そのテナントの値だけに基づく（他のテナントの負荷は、背圧の係数を通してしか影響せず、係数の値は応答に出ない）。
- **健康の確認と合成監視**：Kora と同じく、専用の論理クラスタで動かし、同じクォータと名前空間を通す。上限に当たったら、それ自体を異常として扱う。
- パッチ（4.5 節）に触れる PR は `security:sensitive` を付け、Dev のテックリードの承認を必須にする。

## 11. テスト

### 11.1 性質ベーステスト（jqwik）

- 任意の 2 つのテナント、任意の API のキー × 版、任意の資源の名前の列で、一方の要求の応答に、他方の資源の名前・ID・データ・メトリクスが出ない（[ADR-0004](../decisions/0004-logical-clusters-on-shared-physical-clusters.md) の Confirmation）。生成器は、本家の要求のスキーマ（JSON のメッセージの定義）から作る。
- 任意の名前で、接頭辞を付けて外すと元に戻る。239 文字を超える名前は本家と同じエラーになる。
- 任意の ACL の列（LITERAL・PREFIXED・`*`）で、あるテナントの ACL が、他のテナントの資源に当たらない。
- 任意のトピックの ID で、他のテナントの ID を指す要求は、存在しない ID と同じ応答になる。
- 7.3 節の配分：任意の使用量の列で、Σ q_b = Q、q_b ≥ Q × 0.05 ÷ |B| × (配分の比)、U < 0.5Q のとき q_b ≥ Q ÷ |B|。

### 11.2 CI の関門

- 本家の ApiVersions が広告するすべての API キー × 版が、名前空間の表にあるか、明示的に拒否されている（[ADR-0004](../decisions/0004-logical-clusters-on-shared-physical-clusters.md) の Confirmation）。
- 本家との差分テスト（[protocol-and-compatibility.md](protocol-and-compatibility.md) の 7 節）：違いは、許された違いの表（接頭辞による長さ、数の上限、拒否する API）だけ。

### 11.3 うるさい隣人の試験

試験用の物理クラスタ（本番と同じインスタンスの種類、6 台）に、被害者のテナント（各 5 つ、クォータの 50% の定常の負荷）と、加害者のテナント 1 つを置く。加害者の振る舞いごとに、被害者の指標を測る。

| # | 加害者の振る舞い | 被害者の合格の条件 |
| --- | --- | --- |
| N1 | クォータの 10 倍の produce | produce の p99 が NFR-003（50ms）以内、スループットが定常の 99% 以上、クォータの中の throttle 0 |
| N2 | 7 日分を最初から読み戻す（S3） | 同上。リモートの読み取りの待ち行列の満杯が被害者の fetch に出ない |
| N3 | 毎秒 1 万の接続の試み | 被害者の新しい接続が 1 秒以内に確立する |
| N4 | 毎秒 1 万の Metadata の要求 | 被害者の produce の p99 が同上 |
| N5 | トピックの作成・削除の繰り返し | 被害者の CreateTopics が 5 秒以内に終わる。コントローラーのメタデータのログの遅れが閾値以内 |
| N6 | InitProducerId の乱発 | ブローカーのヒープの使用率が閾値以内。被害者の InitProducerId が 1 秒以内 |
| N7 | メンバー 1,000 のグループのリバランスの繰り返し | 被害者の ConsumerGroupHeartbeat の p99 が 100ms 以内 |
| N8 | 8 MiB のメッセージの大量の produce | 被害者の produce の p99 が同上 |
| N9 | 圧縮のトピックへの大量の書き込み（上限まで） | 被害者の produce の p99 が同上。クリーナーの遅れが被害者の圧縮のトピックに及ぶ時間が閾値以内 |
| N10 | 長いトランザクション（15 分）を多数開く | 被害者の LSO が止まらない。ローカルのディスクの増え方が閾値以内 |

- 頻度：PR ごとに N1・N3・N4 の小さな版（数分）、週次に全体（各 1 時間）。
- 合格の条件の数値は初期値。未検証（E7 の `noisy-neighbor-suite` で見直す）。

## 12. 未解決の問い

### 決定（2026-09-27、既定案）

- **lc-id は `lc-` ＋ 6 文字、区切りは `_`**。テナントのトピックの名前の上限は 239 文字。
- **テナントの解決は SNI と API キーの両方**で行い、一致しなければ認証の失敗。
- **他のテナントの資源は「ない」と答える**（権限のエラーにしない）。
- **ACL の `*` は PREFIXED の `<lc-id>_` に置き換える**。
- **S1 の Metadata は物理クラスタのすべてのブローカーを返す**。S2 のセルでは、セルのブローカーに絞る。
- **エージェントの代理の接続**は内部のリスナーで、テナントと同じ名前空間と上限を通す（control-plane-and-provisioning の持ち越しへの答え）。
- **クォータのコーディネーターはデータ面に置く**（README の図も直した）。
- **数の上限は断る、帯域と頻度は遅らせる**。
- **層ごとの上限は 6 節の表**（すべて初期値）。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| KafkaPrincipalBuilder で SNI を取り出せるか。取り出せなければ P5 に含める | E1 の PoC |
| 代理の接続のユーザー名の形（`agent-<pc-id>@<lc-id>`）で、本家の PLAIN の検査と衝突しないか | E1 の PoC |
| パッチ P1〜P7 の行数と、本家の版の更新での当て直しの手間 | E1 の PoC（intent.md の Open questions。多ければ ADR-0004 の選択肢 2 のプロキシを再評価） |
| 接続の試みの頻度を超えたときの振る舞い（遅らせて閉じる）が、各クライアントで再接続の嵐にならないか | E7 の互換性の行列 |
| S2 のセルで、グループ・トランザクションのコーディネーターをセルの中に置く方法（Kora の論文はこの点を書いていない。2026-09-27 に確認） | S2 の前に [metadata-and-control.md](metadata-and-control.md) と一緒に決める |
| CU の正式な定義と、6 節の表の値 | metrics-and-billing の領域と E7 の負荷試験 |
| 7.3 節の係数と周期 | E7 の負荷試験で、7.5 節の指標を見て決める |
| 要求の処理時間のクォータを「毎秒の要求の数」で説明するか（Confluent Cloud は要求の数で示す） | metrics-and-billing と console-and-api の領域 |
| Basic のテナントの圧縮のトピックの上限（50 GiB）で、Kafka Streams の開発の用途が足りるか | GA の前の利用者の声で見直す |

## 13. ADR

| ADR | 決定 |
| --- | --- |
| [0025](../decisions/0025-tenant-namespace-patch.md) | 名前空間は `<lc-id>_` の接頭辞を、要求の出入口の 1 か所の表駆動のパッチで付け外しする。テナントは SNI と API キーの一致で決め、他のテナントの資源は「ない」と答える |
| [0026](../decisions/0026-tenant-quotas-and-tier-limits.md) | 帯域・要求の処理時間・パーティションの作成と削除は `ClientQuotaCallback` で、接続・パーティションの数・InitProducerId・`transactional.id`・グループの数は小さなパッチで、テナントの単位に掛ける。層ごとの上限の初期値を決める |
| [0027](../decisions/0027-dynamic-quota-coordinator-and-backpressure.md) | クォータのコーディネーターを物理クラスタごとにデータ面に置き、使用量に応じてブローカーに配り直す。ブローカーは背圧で全体を守り、コーディネーターが止まっても最後の値と静的な等分で動く |

## 14. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E1 | `namespace-patch-poc` | P1・P2 の最小の版で、Produce・Fetch・Metadata・グループ・トランザクションが通る。パッチの行数を測る |
| E1 | `sni-tenant-resolution-poc` | KafkaPrincipalBuilder で SNI を取り出し、API キーの lc-id と照合する |
| E7 | `namespace-table-codegen` | 本家のメッセージの定義から、資源の名前の場所の表を生成し、CI の関門にする |
| E7 | `namespace-request-rewrite` | P1 の全 API（4.3 節） |
| E7 | `topic-id-ownership-check` | トピックの ID の持ち主の確認 |
| E7 | `acl-wildcard-translation` | ACL の `*` の置き換えと逆変換 |
| E7 | `tenant-metadata-view` | P2（クラスタの ID、ホスト名、ブローカーの一覧） |
| E7 | `tenant-quota-callback` | `ClientQuotaCallback`（4 種類）とタグ `{tenant}` |
| E7 | `tenant-connection-limits` | P5（接続の数と試みの頻度） |
| E7 | `tenant-partition-limit` | P6 |
| E7 | `quota-usage-reporter` | ブローカーから `__<brand>_quota_usage` への書き込み |
| E7 | `quota-coordinator` | 7.2・7.3 節の配分と `__<brand>_quota_assignments` |
| E7 | `broker-backpressure` | 7.4 節 |
| E7 | `compacted-size-enforcement` | 圧縮のトピックの大きさの計数と throttle |
| E7 | `unfair-throttle-metric` | 7.5 節の NFR-008 の指標 |
| E7 | `noisy-neighbor-suite` | 11.3 節の N1〜N10 |
| E7 | `cross-tenant-canary` | 合成監視の 2 つの論理クラスタで、互いの資源が見えないことを 1 分ごとに確かめる |
| E11 | `tenant-quota-metrics-api` | テナント向け：クォータの値、使用率、throttle の時間 |
| S2 | `cells` | 8 節のセル |

## 15. quality.md・runbooks・data-model への項目

### quality.md

- NFR-008：クォータの中なのに絞られた時間が週 5 分以内のテナントの割合（物理クラスタごと・全体）。
- 他のテナントの資源が見えた事象：0 件（合成監視の隣のテナントの確認、性質ベーステスト、差分テスト）。
- 背圧の発生の回数と時間（ブローカーごと）。
- クォータの配分の遅れ（使用量の報告から配分の反映まで）と、静的な等分に戻った回数。
- うるさい隣人の試験（N1〜N10）の合否。
- パッチ P1〜P7 の行数の推移。

### runbooks

- `noisy-neighbor.md`：背圧が続くブローカーの特定、加害のテナントの特定、上書きで一時的に厳しくする手順、再配置の依頼。
- `quota-coordinator-down.md`：コーディネーターの停止と、静的な等分への切り替わりの確認。
- `cross-tenant-exposure.md`：隣のテナントの確認が失敗したときの初動（該当する物理クラスタの新しい要求の種類の停止、影響の範囲の特定、報告）。
- `tenant-limit-override.md`：論理クラスタの上限の上書きの手順と監査。

### data-model（索引への追加の提案）

| 置き場所 | 名前 | 中身 |
| --- | --- | --- |
| 制御面（Aurora） | `logical_clusters`（表は control-plane-and-provisioning の領域が持つ） | この領域が使う欄：`id`（`lc-` ＋ 6 文字）、`tier`、`max_cu`、`physical_cluster_id`、`cell_id`（S2）。統合で `cu` を `max_cu` に揃えた（[data-model.md](data-model.md) の 3.2 節） |
| 制御面（Aurora） | `logical_cluster_limits` | `lc_id`、`ingress_bytes_per_sec`、`egress_bytes_per_sec`、`request_percentage`、`max_partitions`、`partition_mutation_rate`、`max_connections`、`connection_rate`、`max_transactional_ids`、`init_producer_id_rate`、`max_groups`、`compacted_bytes`、`override_reason`、`overridden_by`、`updated_at`。層と CU からの既定値と、上書きの値を区別する |
| データ面（内部トピック） | `__<brand>_tenants`（[control-plane-and-provisioning.md](control-plane-and-provisioning.md) が持つ） | この領域が読む欄：`logical_cluster_id`、接頭辞、層、クォータの上限（`logical_cluster_limits` の写し）、`generation` |
| データ面（内部トピック） | `__<brand>_quota_usage` | キー：`tenant`。値：`broker`、窓、種類ごとの使用量、throttle の時間、パーティションの数、接続の数、コーディネーターのパーティションごとの `transactional.id`・グループの数 |
| データ面（内部トピック） | `__<brand>_quota_assignments` | キー：`(broker, tenant)`。値：種類ごとの q_b、U、計算の時刻（圧縮） |
| データ面（パッチの設定） | 名前空間の表 | API のキー × 版 → 資源の名前の場所（開発リポジトリの spec の正本から生成） |

# Protocol and compatibility: Kafka

Kafka のワイヤープロトコル、ApiVersions による版の交渉、テナントに許す API と拒否する API、許すトピックの設定、クライアントの行列、本家のブローカーとの差分テスト、本家の版への追従の設計。前提の決定は、本家のブローカーを使うこと（[ADR-0001](../decisions/0001-upstream-brokers-and-stack.md)）、論理クラスタの名前空間（[ADR-0004](../decisions/0004-logical-clusters-on-shared-physical-clusters.md)）、互換の範囲（[ADR-0005](../decisions/0005-compatibility-policy.md)）。この文書で決めたことは [ADR-0006](../decisions/0006-api-exposure-table-and-denial.md)〜[ADR-0008](../decisions/0008-client-matrix-differential-tests-and-version-tracking.md)。

本家の振る舞いは、2026-09-27 に kafka.apache.org の 4.3 の文書と KIP で確かめた。確かめられなかったものは「未検証」と書く。この文書の表は設計の草案で、要件 ID は E2 の各変更の `spec.md` に移すときに振る。

## 1. 目的と範囲

- 既存のクライアントが、ブートストラップのサーバーと資格情報を変えるだけで動く（[intent.md](../intent.md) の SC-1）。
- テナントに許す操作と、拒否する操作の境界を、API と版の単位で 1 つの表に決める。拒否しても、クライアントが本家と同じエラーとして扱えるようにする。
- 「本家と同じか」を機械的に確かめる手段（クライアントの行列、差分テスト）を決める。
- 本家の新しい版を、どの順で、どの速さで取り込むかを決める。

範囲に入れないもの：名前空間のパッチの中身（multi-tenancy-and-quotas の領域）、SASL の機構と API キー（security-and-acls の領域）、トランザクションとグループの意味（transactions-and-idempotence・consumer-groups の領域）、ブローカーのローリング更新の手順（delivery の領域）。

## 2. 本家の形（確かめたこと）

| 項目 | 本家 | 出典（2026-09-27 に確認） |
| --- | --- | --- |
| 版の交渉 | クライアントは接続ごとに ApiVersions を送り、両者が対応する最大の版を使う | [Protocol Guide](https://kafka.apache.org/43/design/protocol/) |
| クライアントが先を行くとき | ApiVersions の版をブローカーが知らなければ（2.4.0 以降のブローカー）、v0 の応答で `UNSUPPORTED_VERSION` と、ブローカーが対応する ApiVersions の版を返す | 同上 |
| クライアントの名前と版 | ApiVersions の要求に `client_software_name`・`client_software_version` を載せる（KIP-511） | 同上。ApiVersions の v3 以上の `ClientSoftwareName`・`ClientSoftwareVersion`（[ApiVersionsRequest.json](https://github.com/apache/kafka/blob/4.3/clients/src/main/resources/common/message/ApiVersionsRequest.json)、2026-09-27 に確認） |
| 最小のクライアント | 4.0 で、2.1 より古いプロトコルの版を取り除いた（KIP-896）。5.0 からは、主版ごとに機械的に古い版を落とす方針の KIP を別に出す予定 | [KIP-896](https://cwiki.apache.org/confluence/display/KAFKA/KIP-896%3A+Remove+old+client+protocol+API+versions+in+Kafka+4.0) |
| 従来のリバランスのプロトコル | KafkaConsumer では、4.3 で新しいプロトコルを勧める記録を出し、5.0 で既定を新しいプロトコルにし、6.0 で従来の対応をクライアントから外す。ブローカーは従来のプロトコルを受け続ける | [KIP-1274](https://cwiki.apache.org/confluence/display/KAFKA/KIP-1274%3A+Deprecate+and+remove+support+for+Classic+rebalance+protocol+in+KafkaConsumer) |
| 共有のグループ・Streams のグループ | KIP-932 は 4.2 で本番向け。KIP-1071（Streams のリバランスのプロトコル）は 4.2 で機能を絞って GA | [4.2.0 の発表](https://kafka.apache.org/blog/2026/02/17/apache-kafka-4.2.0-release-announcement/) |
| 最新の版 | 4.3.0（2026-05-22）、4.3.1。4.4.0 は RC1（2026-09-22 のタグ） | [4.3.0 の発表](https://kafka.apache.org/blog/2026/05/22/apache-kafka-4.3.0-release-announcement/)、`apache/kafka` のタグ |

4.3 の文書の API キーの表にある API は、0〜3、8〜51、55、57、60、61、64〜66、68、69、71、72、74〜81、83〜92 である（[Protocol Guide](https://kafka.apache.org/43/design/protocol/)）。LeaderAndIsr などの ZooKeeper 時代のブローカー間の API は 4.0 で消えた。Vote・FetchSnapshot・BrokerHeartbeat などのコントローラーの API は、コントローラーのリスナーだけが受け、クライアント向けのリスナーの ApiVersions には出ない。

## 3. 要求の通り道

```
クライアント ─TLS─▶ NLB ─▶ SNI のプロキシ（TLS を終端しない）─▶ ブローカーのクライアント向けリスナー
                                                                 │
   1. ApiVersions（認証の前でも受ける。本家と同じ）                   │
   2. SaslHandshake / SaslAuthenticate（PLAIN、API キー）            │
   3. KafkaPrincipalBuilder：主体に論理クラスタの ID を付ける        │
   4. 名前空間のパッチ：資源の名前に内部の接頭辞を付ける（ADR-0004）  │
   5. Authorizer：API の表（ADR-0006）とテナントの ACL を判定          │
   6. CreateTopicPolicy / AlterConfigPolicy：設定の表（ADR-0007）      │
   7. 本家の処理（KafkaApis）                                         │
   8. 名前空間のパッチ：応答から接頭辞を外し、他のテナントの資源を除く │
```

- 拒否の多くは、5 の Authorizer と 6 のポリシーで行う。本家の差し込み口の中で済むので、エラーコードが本家と自然に一致する（[ADR-0006](../decisions/0006-api-exposure-table-and-denial.md)）。
- 4 と 8 は、ADR-0004 のパッチの 1 か所に集める。API ごとの資源の名前の場所の表（名前空間の表）は、下の 4 節の表と同じ行を持つ。

## 4. API の表

API ごとの扱いを、次の 4 つに分ける。表は開発リポジトリの spec の正本にする（ADR-0005）。

| 扱い | 意味 |
| --- | --- |
| 通す | 本家の処理のまま。名前空間の変換だけを掛ける |
| 絞る | 通すが、資源の種類・値をポリシーや Authorizer で絞る |
| 拒否 | ApiVersions では広告したまま、本家の定義にあるエラーを返す。接続は切らない |
| フラグ | 既定は無効。無効の間は、本家でその機能を無効にしたときと同じ応答を返す |

| API（キー） | 扱い | 中身・返すエラー |
| --- | --- | --- |
| Produce（0）、Fetch（1）、ListOffsets（2）、Metadata（3） | 通す | Metadata のブローカーの一覧の範囲は multi-tenancy-and-quotas の領域で決める |
| OffsetCommit（8）、OffsetFetch（9）、FindCoordinator（10）、JoinGroup〜ListGroups（11〜16）、DeleteGroups（42）、OffsetDelete（47） | 通す | 従来のグループのプロトコル |
| ConsumerGroupHeartbeat（68）、ConsumerGroupDescribe（69） | 通す | KIP-848 |
| SaslHandshake（17）、SaslAuthenticate（36）、ApiVersions（18） | 通す | S1 の機構は PLAIN だけ。S2 で OAUTHBEARER を足す（security-and-acls の領域） |
| CreateTopics（19）、CreatePartitions（37） | 絞る | 設定は 5 節の表。パーティションの数の上限は層と CU から（multi-tenancy-and-quotas） |
| DeleteTopics（20）、DeleteRecords（21） | 通す | テナントの ACL の範囲 |
| InitProducerId（22）、AddPartitionsToTxn（24）、AddOffsetsToTxn（25）、EndTxn（26）、TxnOffsetCommit（28） | 通す | `transactional.id` の上限は transactions-and-idempotence の領域 |
| OffsetForLeaderEpoch（23） | 通す | クライアントが切り詰めの検出に使う |
| WriteTxnMarkers（27） | 拒否 | ブローカーの間の API。本家は `CLUSTER_ACTION` の権限を求めるので、テナントには `CLUSTER_AUTHORIZATION_FAILED` になる |
| DescribeAcls（29）、CreateAcls（30）、DeleteAcls（31） | 絞る | 本家は CreateAcls・DeleteAcls に CLUSTER の ALTER を、DescribeAcls に CLUSTER の DESCRIBE を求める。Authorizer は、テナントの管理の主体に、論理クラスタの範囲の中だけでこれを与える。ACL の資源の種類は TOPIC・GROUP・TRANSACTIONAL_ID だけを通し、他の種類（CLUSTER・DELEGATION_TOKEN・USER）の要素には `CLUSTER_AUTHORIZATION_FAILED` を返す（要素ごとのエラーの形が本家と合うかは未検証。E2 の `differential-test-harness` で確かめる） |
| DescribeConfigs（32） | 絞る | TOPIC と GROUP の資源だけ。BROKER・BROKER_LOGGER の資源は `CLUSTER_AUTHORIZATION_FAILED`。固定した設定（`min.insync.replicas` など）は値を見せる |
| AlterConfigs（33）、IncrementalAlterConfigs（44） | 絞る | TOPIC は 5 節の表、GROUP は consumer-groups の領域の表。他の資源の種類は `CLUSTER_AUTHORIZATION_FAILED` |
| AlterReplicaLogDirs（34）、DescribeLogDirs（35） | 拒否 | ブローカーのディスクの情報。`CLUSTER_AUTHORIZATION_FAILED` |
| CreateDelegationToken〜DescribeDelegationToken（38〜41） | 拒否 | 委任トークンは使わない。本家で無効のときと同じ `DELEGATION_TOKEN_AUTH_DISABLED` |
| ElectLeaders（43）、AlterPartitionReassignments（45）、ListPartitionReassignments（46） | 拒否 | 配置は運用が決める（[metadata-and-control.md](metadata-and-control.md)）。`CLUSTER_AUTHORIZATION_FAILED` |
| DescribeClientQuotas（48）、AlterClientQuotas（49） | 拒否 | クォータは層と CU で決まる（ADR-0005）。値はメトリクスの API で見せる |
| DescribeUserScramCredentials（50）、AlterUserScramCredentials（51） | 拒否 | API キーは制御面で発行する |
| DescribeQuorum（55）、UpdateFeatures（57）、UnregisterBroker（64）、AddRaftVoter（80）、RemoveRaftVoter（81） | 拒否 | クラスタの構成。`CLUSTER_AUTHORIZATION_FAILED` |
| DescribeCluster（60） | 通す | `cluster_id` は論理クラスタの ID を返す（パッチ） |
| DescribeProducers（61）、DescribeTransactions（65）、ListTransactions（66） | 通す | 名前空間でテナントのものだけ |
| GetTelemetrySubscriptions（71）、PushTelemetry（72） | 通す | KIP-714。テレメトリーのプラグインを入れないので、本家でプラグインがないときと同じ応答（購読なし）になる |
| ListConfigResources（74） | 絞る | TOPIC・GROUP の資源だけを返す |
| DescribeTopicPartitions（75） | 通す | ELR も見える（[replication-and-durability.md](replication-and-durability.md)） |
| ShareGroupHeartbeat〜ShareAcknowledge（76〜79）、InitializeShareGroupState〜ReadShareGroupStateSummary（83〜87）、DescribeShareGroupOffsets〜DeleteShareGroupOffsets（90〜92） | フラグ | 共有のグループ（KIP-932）。83〜87 はブローカーの間の API で、フラグを有効にしてもテナントには拒否する |
| StreamsGroupHeartbeat（88）、StreamsGroupDescribe（89） | フラグ | KIP-1071。consumer-groups の領域の検証の後に有効にする |

- 表にない API キー・版を本家が広告したら、CI を失敗にする（ADR-0004 の Confirmation と同じ）。本家の版の更新は、表の更新と同じ PR でしか入らない。
- 本番のブローカーで表にない API が届いたときは、パッチが `UNSUPPORTED_VERSION` を返す。これは CI を抜けた場合の最後の守りで、平常は起きない。起きたらアラートにする。

## 5. トピックの設定の表

`CreateTopicPolicy`・`AlterConfigPolicy` で判定する（[ADR-0007](../decisions/0007-topic-config-allowlist.md)）。表にない設定を指定すると `POLICY_VIOLATION` を返す。既定値の欄は、テナントが指定しないときの値で、本家の既定と違うものに印（※）を付ける。本家の既定は [Topic Configs](https://kafka.apache.org/43/configuration/topic-configs/) による。

| 設定 | 扱い | 範囲 | 既定 |
| --- | --- | --- | --- |
| `cleanup.policy` | 変えられる | `delete`、`compact`、`compact,delete` | `delete` |
| `retention.ms` | 変えられる | 1 時間以上、または `-1`（無期限。階層型の保存があるとき） | 604800000（7 日） |
| `retention.bytes` | 変えられる | `-1`、または 1 GiB 以上 | `-1` |
| `max.message.bytes` | 変えられる | 1 KiB〜8 MiB（Basic は 2 MiB まで） | 1048588 |
| `compression.type` と各 `compression.*.level` | 変えられる | 本家と同じ | `producer` |
| `message.timestamp.type` | 変えられる | `CreateTime`、`LogAppendTime` | `CreateTime` |
| `message.timestamp.before.max.ms`、`message.timestamp.after.max.ms` | 変えられる | 本家と同じ | 本家と同じ（後者は 1 時間） |
| `delete.retention.ms`、`min.compaction.lag.ms`、`max.compaction.lag.ms` | 変えられる | `max.compaction.lag.ms` は 1 時間以上 | 本家と同じ |
| `segment.bytes` | 変えられる | 64 MiB〜1 GiB | ※ 268435456（256 MiB） |
| `segment.ms` | 変えられる | 10 分〜7 日 | ※ 3600000（1 時間） |
| `replication.factor`（作成時の引数） | 固定 | `-1`（既定を使う）か `3` だけ。他は `INVALID_REPLICATION_FACTOR` | 3 |
| `min.insync.replicas` | 固定 | `2` の指定だけを受け付ける（冪等な指定を通すため） | ※ 2 |
| `unclean.leader.election.enable` | 固定 | `false` の指定だけを受け付ける | `false` |
| `remote.storage.enable`、`local.retention.ms`、`local.retention.bytes`、`remote.log.copy.disable`、`remote.log.delete.on.disable` | 運用だけ | テナントの指定は `POLICY_VIOLATION`。ただし `local.retention.ms` は、`min(retention.ms, 6 時間)` と同じ値なら通す（名前空間のパッチ P1 が足す値。[tiered-and-object-storage.md](tiered-and-object-storage.md) の 12 節） | 階層型の保存の領域が決める |
| `flush.messages`、`flush.ms`、`preallocate`、`index.interval.bytes`、`segment.index.bytes`、`segment.jitter.ms`、`file.delete.delay.ms`、`min.cleanable.dirty.ratio`、`leader.replication.throttled.replicas`、`follower.replication.throttled.replicas` | 運用だけ | 同上 | 本家と同じか、[broker-and-log-storage.md](broker-and-log-storage.md) の値 |

- `segment.bytes`・`segment.ms` の既定と範囲の理由は [broker-and-log-storage.md](broker-and-log-storage.md) の 3 節。
- Kafka Streams は内部のトピックを `replication.factor=-1` で作る（3.0 以降の既定。4.3 の `StreamsConfig` の既定も -1。[StreamsConfig.java](https://github.com/apache/kafka/blob/4.3/streams/src/main/java/org/apache/kafka/streams/StreamsConfig.java)、2026-09-27 に確認）。`-1` を通すので、そのまま動く。
- `cleanup.policy=compact` のトピックは階層型の保存に載らない（本家の制約。[Tiered Storage](https://kafka.apache.org/43/operations/tiered-storage/)）。ローカルのディスクの量の上限を multi-tenancy-and-quotas の領域で掛ける（[broker-and-log-storage.md](broker-and-log-storage.md) の 4.3 節）。

## 6. クライアントの行列

[ADR-0008](../decisions/0008-client-matrix-differential-tests-and-version-tracking.md)。ADR-0005 の表を、2026-09-27 の各リポジトリの版で具体にする。

| クライアント | 行列の版（2026-09-27） | 確かめたこと |
| --- | --- | --- |
| Java のクライアントと Kafka Streams | 4.3.1、4.2 の最新、3.9 の最新、2.1.1 | 4.4.0 は RC。出たら「最新」を置き換える |
| librdkafka | v2.15.1（2026-09-09）、1 年前の版 v2.11.1（2025-08-18。2025-09 の時点の最新。次の v2.12.0 は 2025-10-08。2026-09-27 に確認） | `confluentinc/librdkafka` のリリース |
| franz-go | v1.22.0（タグ） | `twmb/franz-go` のタグ。最終のコミットは 2026-09-25 |
| Sarama | v1.61.0（2026-09-22） | `IBM/sarama` のリリース |
| Node.js | confluent-kafka-javascript v1.10.1（2026-09-10）を「対応」に、KafkaJS 2.2.4 を「凍結」に | KafkaJS の最後のリリースは 2.2.4（2023-02-27）、最後の push は 2024-08-02 |

- KafkaJS は保守が止まっている。ADR-0005 の「止まっていれば、代わりの Node.js のクライアントを選ぶ」に従い、librdkafka の上の confluent-kafka-javascript を行列の「対応」に入れる。KafkaJS は日次の行列に残し、壊れても直さない「凍結」とする。利用者の文書に書く。
- 行列の各セルで流す操作：produce（`acks=all`・`acks=1`、冪等）、fetch（`read_uncommitted`・`read_committed`）、トランザクション（コミットと中止）、グループの 2 つのプロトコル、オフセットのコミット・取得・削除・リセット、管理の操作（トピックの作成・削除・パーティションの追加・設定の参照と変更・ACL）、拒否される API のエラーの扱い、throttle の応答、リーダーの移動の間の再試行。
- 行列は、自社のブローカー（パッチあり）と、本家のブローカー（パッチなし）の両方に流す（ADR-0001 の Confirmation）。

## 7. 本家との差分テスト

[ADR-0008](../decisions/0008-client-matrix-differential-tests-and-version-tracking.md)。

### 7.1 構成

| 側 | 中身 |
| --- | --- |
| 参照 | 本家の Apache Kafka の同じ版（パッチなし、差し込み口なし）。ブローカー 3 台（rack は 3 つ）、コントローラー 3 台。耐久性の設定は本番と同じ（[replication-and-durability.md](replication-and-durability.md) の 3 節）。認証は SASL/PLAIN の固定の利用者。ACL は StandardAuthorizer で、テナントの主体に相当する主体に、テナントと同じ ACL を付ける |
| 対象 | 自社のブローカー（パッチ＋差し込み口）。同じ台数と設定。論理クラスタを 2 つ作り、一方で要求を流し、もう一方は「隣のテナント」として同じ名前の資源を持たせる |

### 7.2 要求の列

- 要求の列は、生成器で作る。API の表（4 節）の各行を、対応する全ての版で、正常と異常の値を混ぜて並べる（性質ベーステストの生成器。シードを記録し、失敗を再現できるようにする）。
- 送り手は、本家の Java の `org.apache.kafka.common.requests` の型で、版を指定して生の要求を組み立てる。クライアントのライブラリの再試行や版の選択に隠れないようにする。
- 本番の通信は記録しない。利用者のデータを含むため（[AGENTS.md](../../AGENTS.md)）。本番から集めるのは、API のキーと版と `client_software_name`・`client_software_version` の件数だけ（8.3 節）。

### 7.3 比べ方

- 両方の応答を、比べる前に正規化する。消すもの：`throttle_time_ms`、クラスタの ID、ブローカーの ID・ホスト・ポート、トピックの ID（UUID）、プロデューサーの ID とエポック、タイムスタンプ、セッションの ID。対象の側の資源の名前は、接頭辞がないことを確かめてから比べる。
- 比べるもの：エラーコード、オフセット、レコードのバッチの中身、見える資源の集合、設定の値と由来（固定した設定を除く）。
- 違いは、「許された違い」の表と照合する。表の行は、4 節の「拒否」「絞る」「フラグ」の行と、5 節の固定の設定だけ。表にない違いは、テストの失敗にする。
- 隣のテナントの資源の名前・データが、応答に 1 つも出ないことを、同じ列で確かめる（ADR-0004 の性質ベーステスト）。

### 7.4 頻度

| テスト | 頻度 |
| --- | --- |
| 差分テスト（代表の列、1 シード） | PR ごと |
| 差分テスト（全ての API と版、複数のシード） | 日次 |
| クライアントの行列（代表の操作） | PR ごと |
| クライアントの行列（全体、各クライアントの結合テストを含む） | 日次 |
| 本家の新しい版の RC に対する差分テストと行列 | RC が出るたび（取り込みの準備） |

## 8. 本家の版への追従

[ADR-0008](../decisions/0008-client-matrix-differential-tests-and-version-tracking.md)。ADR-0005 の「新しいマイナー版は 3 か月以内」を具体にする。ローリング更新の手順は delivery の領域で決める。

### 8.1 取り込む版

- 本家の x.y.0 は本番に入れない。x.y.1 以降を入れる。ただし x.y.0 から 3 か月を過ぎても x.y.1 が出なければ、x.y.0 に必要な修正を当てて入れるかを、Dev のテックリードが判断する。
  - 例：4.3.0 は 2026-05-22、4.3.1 は 2026-06-25 に出た。
- RC の段階から、差分テストと行列と Jepsen の形のテスト（[replication-and-durability.md](replication-and-durability.md) の 8 節）を回す。問題は本家に報告する。
- 本家のセキュリティの修正を含むパッチ版は、重大なもの（リモートから悪用できるもの）を 72 時間以内、他を 30 日以内に入れる。

### 8.2 順序

1. 名前空間の表と API の表を、新しい版の ApiVersions に合わせて更新する（CI の関門）。
2. パッチを当て直し、パッチの行数の差を記録する（ADR-0001）。
3. 差分テスト・行列・Jepsen の形のテストを通す。
4. 本番のバイナリを、Basic の物理クラスタから順にローリングで更新する。
5. 全ての物理クラスタでバイナリが揃ってから 7 日おき、`metadata.version` などのフィーチャーの版を上げる。本家は、間にメタデータの変更がある `metadata.version` へは戻せないとし、4.3-IV0 は変更を含む（[Upgrading](https://kafka.apache.org/43/getting-started/upgrade/)、2026-09-27 に確認）。したがって、上げた後は戻せない前提にし、上げるまでの 7 日を戻せる期間にする。

### 8.3 古い版の扱い

- 本家が古い版を取り除くときは、ADR-0005 の手順（6 か月前の告知、テナントごとの接続の数の表示）に従う。
- テナントごとの接続の数は、ApiVersions の `client_software_name`・`client_software_version` と、要求の API のキーと版で数える。本家のメトリクスにはテナントの次元がないので、名前空間のパッチの出口で数え、メトリクスの API に送る（metrics-and-billing の領域）。
- 次の予定：本家の 5.0 で、KafkaConsumer の既定が新しいグループのプロトコルに変わり（KIP-1274）、主版ごとの古い版の削除の方針の KIP が出る見込み。5.0 の取り込みは、別の ADR で扱う。

## 9. 障害と振る舞い

| 事象 | 起きること | 検知 | 対応 |
| --- | --- | --- | --- |
| 本家の版の更新で、表にない API・版が増える | CI が失敗し、更新が止まる | CI | 表を更新する。新しい API のテナントの分離の性質ベーステストを足す |
| 表にない API が本番に届く | `UNSUPPORTED_VERSION` を返す | アラート（件数 > 0） | 取り込みの手順の穴を調べる |
| クライアントが拒否の API を繰り返す（管理の道具） | 本家と同じエラーが返り続ける | API ごとの拒否の件数 | 利用者の文書に、拒否する API の一覧と代わりの手段（コンソール、CLI）を書く |
| 行列のクライアントの新しい版が壊れる | 日次の行列が失敗 | CI | クライアントの不具合か、自社の違いかを差分テストで切り分ける |
| パッチの当て直しの失敗 | 本家の版の追従が遅れる | 最新のマイナー版からの遅れ（版の数、日数） | 2 つ遅れたらアラート（ADR-0001） |
| 差分テストの揺らぎ（非決定的な違い） | 誤った失敗 | 同じシードでの再実行 | 正規化の規則を足す。規則の追加はレビューを受ける（本物の違いを隠さないため） |

## 10. セキュリティ

| 脅威 | 対応 |
| --- | --- |
| クラスタ全体の管理の API の悪用（再配置、リーダーの選出、フィーチャーの変更） | Authorizer で CLUSTER の資源の操作をテナントに与えない。拒否の件数を監査ログに出す |
| 設定による耐久性の低下（`min.insync.replicas=1` など） | 5 節の固定の設定。ポリシーのテストを PR ごとに回す |
| 他のテナントの資源の露出 | 名前空間のパッチ（ADR-0004）。差分テストの隣のテナントの確認（7.3 節） |
| 認証の前の要求による資源の消費 | 認証の前に受けるのは ApiVersions と SASL の要求だけ（本家と同じ）。接続数の制限は SNI のプロキシで掛ける |
| 巨大な要求・版の組み合わせによるブローカーの不具合 | `socket.request.max.bytes` は本家の既定（100 MiB。[Broker Configs](https://kafka.apache.org/43/configuration/broker-configs/)、2026-09-27 に確認）より下げるかを E2 で決める。差分テストの生成器に、境界の値と壊れた要求を入れる |
| 差分テストの資料への利用者のデータの混入 | 本番の通信を記録しない（7.2 節） |

プロトコルの振る舞いを変える PR は、ルートの規則どおり、行列と差分テストを通す（[AGENTS.md](../../AGENTS.md)）。

## 11. テスト

### 11.1 決定表

- 4 節の API の表の各行 × 各版 × 資源の種類で、「通す」「絞る」「拒否」「フラグ（有効・無効）」の応答を表駆動テストにする。
- 5 節のトピックの設定の表の各行 × 範囲の内・境界・外で、CreateTopics と IncrementalAlterConfigs と AlterConfigs の結果を表駆動テストにする。

### 11.2 性質ベーステスト

- 任意の API・版の要求の列で、応答の違いは「許された違い」の表の行だけ（7.3 節）。
- 任意の 2 つのテナントと任意の要求の列で、一方の応答に、他方の資源の名前・データ・メトリクスが出ない（ADR-0004）。
- 本家の ApiVersions の広告する (API, 版) の集合と、自社のブローカーの広告する集合が等しい（ADR-0005）。
- 任意の CreateTopics・AlterConfigs の列の後で、全てのトピックの `min.insync.replicas` は 2、複製の数は 3、`unclean.leader.election.enable` は `false`。

### 11.3 互換性の行列

- 6 節の表。PR ごとに代表の操作、日次に全体。

## 12. ADR

| ADR | 決定 |
| --- | --- |
| [0006](../decisions/0006-api-exposure-table-and-denial.md) | API ごとの扱いを「通す・絞る・拒否・フラグ」の表で持つ。拒否は Authorizer と本家の無効の応答で行い、本家と同じエラーを返す。表にない API は CI で止める |
| [0007](../decisions/0007-topic-config-allowlist.md) | トピックの設定は許可リストで絞る。耐久性の設定は同じ値の指定だけを通す。`segment.bytes` と `segment.ms` の既定を下げる |
| [0008](../decisions/0008-client-matrix-differential-tests-and-version-tracking.md) | クライアントの行列を具体の版で持ち、KafkaJS を凍結にする。差分テストは生の要求の列を正規化して比べる。本家は x.y.1 以降を 3 か月以内に取り込む |

## 13. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E1 | `upstream-broker-build` | 本家の 4.3.1 に差し込み口とパッチを載せたブローカーのビルドと、パッチなしの参照のビルド |
| E1 | `apiversions-parity-check` | ApiVersions の広告の集合を、参照と比べる CI |
| E2 | `api-exposure-table` | 4 節の表を spec にし、Authorizer の包みで「拒否」「絞る」を実装する |
| E2 | `topic-config-policy` | 5 節の表の CreateTopicPolicy・AlterConfigPolicy |
| E2 | `differential-test-harness` | 生の要求の送り手、生成器、正規化、許された違いの表 |
| E2 | `client-matrix-ci` | 6 節の行列（PR ごとと日次）。Kafka Streams の exactly-once の代表のトポロジー |
| E2 | `client-version-telemetry` | テナントごとの `client_software_name`・版、API の版の件数の集計 |
| E2 | `denied-api-docs` | 利用者向けの、拒否する API と設定の一覧と、代わりの手段 |
| E6 | `streams-group-flag` | KIP-1071 の API をフラグの裏に置く（consumer-groups の領域と一緒に） |
| E12 | `upstream-release-tracking` | RC の自動の検証、取り込みの手順、フィーチャーの版の更新の待ち |

## 14. 未解決の問い

### 決定（2026-09-27、既定案）

- **拒否の API の返し方**：広告したまま、Authorizer で本家と同じエラーを返す（ADR-0005 を具体にした）。
- **DescribeLogDirs**：拒否する。トピックの大きさは、メトリクスの API で見せる。
- **DescribeClientQuotas**：拒否する。
- **委任トークン**：使わない。`DELEGATION_TOKEN_AUTH_DISABLED` を返す。
- **KIP-714 のテレメトリー**：プラグインを入れない。
- **Streams のグループ（KIP-1071）**：フラグの裏。
- **Node.js のクライアント**：confluent-kafka-javascript を対応、KafkaJS を凍結。
- **本家の取り込み**：x.y.1 以降、x.y.0 から 3 か月以内。フィーチャーの版は 7 日待つ。
- **`segment.bytes` の既定**：256 MiB。**`segment.ms` の既定**：1 時間。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| Metadata の応答に、どのブローカーを載せるか（全て、テナントのパーティションを持つものだけ） | multi-tenancy-and-quotas の領域（E7） |
| CLUSTER などの資源の ACL の要求に返すエラーコードが、本家の検査の順と合うか | 差分テストで確かめる（E2） |
| `socket.request.max.bytes` を本家の既定から下げるか | E2 の負荷試験 |
| KIP-714 のテレメトリーを受けて、テナントのメトリクスに使うか | metrics-and-billing の領域（E11） |
| 5.0 の取り込み（従来のグループの既定の変更、古い版の削除の方針） | 5.0 の RC が出たとき、別の ADR |

## 15. quality.md・runbooks・data-model への項目

### quality.md

- 差分テストの「許された違い」の表の行数と、PR ごとの増減（増えたらレビュー）。
- クライアントの行列の合格率（クライアント × 版 × 操作）。日次の失敗の件数と、直すまでの日数。
- 本家の最新のマイナー版からの遅れ（版の数、日数）。
- 表にない API の本番での件数（目標 0）。

### runbooks

- `runbooks/upstream-upgrade.md`：本家の新しい版の取り込み（8.2 節の順序、フィーチャーの版の更新、戻し方）。
- `runbooks/unknown-api-alert.md`：表にない API・版が本番に届いたときの確かめ方。
- `runbooks/client-deprecation-notice.md`：古い版を使うテナントの洗い出しと告知。

### data-model（索引への追加の提案）

| テーブル・記録 | 中身 |
| --- | --- |
| `api_exposure`（開発リポジトリの spec の表。DB ではない） | API のキー、版の範囲、扱い、返すエラー、名前空間の資源の場所 |
| `topic_config_policy`（同上） | 設定の名前、扱い、範囲、層ごとの上限、既定 |
| `client_version_usage`（メトリクスの時系列） | `logical_cluster_id`、`client_software_name`、`client_software_version`、`api_key`、`api_version`、接続の数、要求の数、時刻 |
| `upstream_releases`（制御面） | 版、RC か GA か、取り込みの状態、フィーチャーの版、物理クラスタごとの適用の時刻 |

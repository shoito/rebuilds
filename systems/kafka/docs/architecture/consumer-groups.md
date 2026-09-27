# Consumer groups: Kafka

コンシューマーグループの設計。従来のリバランスのプロトコル（classic）と新しいプロトコル（KIP-848、consumer）、オフセットの保存と保持、遅れ（lag）の計算、グループの単位の設定、テナントごとの上限、共有のグループ（KIP-932）と Streams のグループ（KIP-1071）の段階的な有効化を扱う。本家の実装をそのまま使う方針は [ADR-0001](../decisions/0001-upstream-brokers-and-stack.md)、API の表は [protocol-and-compatibility.md](protocol-and-compatibility.md) の 4 節、名前空間は [multi-tenancy-and-quotas.md](multi-tenancy-and-quotas.md) にある。

本家の振る舞いは、2026-09-27 に kafka.apache.org の 4.3 の文書（Broker Configs、Group Configs、Consumer Rebalance Protocol）と、4.2・4.3 の発表で確かめた。確かめられなかったものは「未検証」と書く。要件 ID は、E6 の各変更の `spec.md` に移すときに振る。

## 1. 目的と範囲

- 既存のコンシューマーのアプリを、どちらのリバランスのプロトコルでも、変更なしで動かす。
- 新しいプロトコル（KIP-848）への移行を、本家の予定（5.0 でクライアントの既定、6.0 でクライアントは新しいものだけ）に合わせて促す。
- グループのコーディネーターは物理クラスタの全テナントで共有する。1 つのテナントのグループの使い方（巨大なグループ、リバランスの嵐、大量のグループ）が、他のテナントを遅らせないようにする。
- テナントに、グループごとの遅れを見せる（intent.md の MVP の「メトリクスの API」）。

範囲に入れないもの：

| もの | 扱う場所 |
| --- | --- |
| 名前空間のパッチの仕組み | [multi-tenancy-and-quotas.md](multi-tenancy-and-quotas.md) |
| `GROUP` の ACL | security-and-acls.md |
| 遅れのメトリクスの API の形と保存 | metrics-and-billing.md |
| トランザクションの中のオフセットのコミット（`TxnOffsetCommit`） | [transactions-and-idempotence.md](transactions-and-idempotence.md) |

## 2. 本家の形（確かめたこと）

| 項目 | 本家 | 出典 |
| --- | --- | --- |
| 2 つのプロトコル | 4.0 で KIP-848 が GA。グループは `classic` と `consumer` の 2 種類。サーバーでは 4.0 から既定で有効で、`group.version` の機能の版で有効・無効を切り替える。クライアントは `group.protocol=consumer` で使う（既定はまだ classic） | [Consumer Rebalance Protocol](https://kafka.apache.org/43/operations/consumer-rebalance-protocol/) |
| 本家の予定（KIP-1274） | 3.7 で早期提供、4.0 で GA、5.0 で KafkaConsumer の既定が consumer、6.0 で KafkaConsumer は consumer だけ（ブローカーは classic を残す） | 同上 |
| 4.3 の変化 | classic でコンシューマーを起動すると、consumer を勧める記録を出す。`group.coordinator.rebalance.protocols` は非推奨（KIP-1237。5.0 で削除）で、機能の版（`group.version`、`streams.version`、`share.version`）で切り替える。KIP-1251 で割り当てのエポックを足し、不要な締め出しを減らした | [4.3.0 の発表](https://kafka.apache.org/blog/2026/05/22/apache-kafka-4.3.0-release-announcement/)、[Broker Configs](https://kafka.apache.org/43/configuration/broker-configs/) |
| consumer の割り当て | サーバー側の割り当て器 `uniform`（既定）と `range`。クライアントは `group.remote.assignor` で選ぶ。クライアント側の割り当て器は使えない。ラックを考えた割り当ては未完成（KAFKA-19387） | [Consumer Rebalance Protocol](https://kafka.apache.org/43/operations/consumer-rebalance-protocol/) |
| consumer の正規表現 | `subscribe(SubscriptionPattern)` の正規表現（RE2J）は、サーバーで評価する | 同上 |
| 移行 | 空のグループは自動で変換。空でないグループも、classic のグループが独自のメタデータを埋め込む割り当て器を使っていなければ、1 台ずつ `group.protocol=consumer` に替えれば無停止で変換される（`group.consumer.migration.policy` 既定 `bidirectional`） | 同上、[Broker Configs](https://kafka.apache.org/43/configuration/broker-configs/) |
| 共有のグループ | KIP-932 は 4.2 で本番向け（RENEW の確認応答、遅れのメトリクスなど） | [4.2.0 の発表](https://kafka.apache.org/blog/2026/02/17/apache-kafka-4.2.0-release-announcement/) |
| Streams のグループ | KIP-1071 は 4.2 で機能を絞って GA | 同上 |

主な設定の既定（[Broker Configs](https://kafka.apache.org/43/configuration/broker-configs/)、2026-09-27 に確認）：

| 設定 | 既定 |
| --- | --- |
| `group.consumer.heartbeat.interval.ms`（最小・最大） | 5 秒（5 秒・15 秒） |
| `group.consumer.session.timeout.ms`（最小・最大） | 45 秒（45 秒・60 秒） |
| `group.consumer.assignors` | `uniform,range` |
| `group.consumer.max.size`・`group.max.size` | 2147483647（実質無制限） |
| `group.min.session.timeout.ms`・`group.max.session.timeout.ms`（classic） | 6 秒・30 分 |
| `group.initial.rebalance.delay.ms`（classic） | 3 秒 |
| `group.coordinator.threads` | 4 |
| `offsets.topic.num.partitions`・`replication.factor` | 50・3 |
| `offsets.retention.minutes` | 10080（7 日） |
| `offset.metadata.max.bytes` | 4096 |
| `offsets.commit.timeout.ms` | 5 秒 |
| `group.share.max.size` | 200 |
| `group.share.max.share.sessions`（ブローカーごと） | 2000 |
| `group.share.partition.max.record.locks`・`group.share.record.lock.duration.ms`・`group.share.delivery.count.limit` | 2000・30 秒・5 |

グループの単位の設定（KIP-848 で足された。[Group Configs](https://kafka.apache.org/43/configuration/group-configs/)）：`consumer.session.timeout.ms`、`consumer.heartbeat.interval.ms`、`share.*`（`share.auto.offset.reset`、`share.isolation.level`、`share.record.lock.duration.ms`、`share.delivery.count.limit`、`share.partition.max.record.locks` など）、`streams.*`。

## 3. 方針

- **classic と consumer の両方を、本家の既定の設定で出す。** 本家が 6.0 でもブローカーに classic を残すので、この題材も残す（[ADR-0023](../decisions/0023-consumer-group-protocols-and-limits.md)）。
- **グループの意味は本家のまま。** 名前空間のパッチで、グループの ID とトピックの名前を閉じる。consumer の正規表現は、テナントのトピックだけを相手に評価させる。
- **共有のコーディネーターを守る上限を掛ける。** グループの大きさ、テナントのグループの数、要求の頻度（要求のクォータ）。
- **遅れは、データ面のエージェントが計算してメトリクスの API に渡す。** ブローカーのパッチにしない。
- **共有のグループと Streams のグループは、フラグの裏に置き、条件を満たしてから有効にする**（[ADR-0024](../decisions/0024-share-and-streams-groups-staging.md)）。

## 4. 2 つのプロトコル

### 4.1 有効にするもの

| 機能の版・設定 | 値 | 理由 |
| --- | --- | --- |
| `group.version` | 本家の最新（consumer を有効） | KIP-848 |
| `share.version` | 0（無効） | 7 節の条件を満たすまで |
| `streams.version` | 0（無効） | 同上 |
| `group.consumer.assignors` | `uniform,range`（本家の既定） | 自前の割り当て器は持たない |
| `group.consumer.migration.policy` | `bidirectional`（本家の既定） | 無停止の移行と戻しを両方許す |
| `group.consumer.max.size`・`group.max.size` | 1,000 | 1 つのグループが、コーディネーターのスレッドとメモリーを占めないように。ブローカー全体の値で、テナントは変えられない |
| その他の `group.*`・`offsets.*` | 本家の既定 | |

- 機能の版を 0 にしたとき、共有のグループと Streams のグループの API は、本家でその機能が無効のときと同じ応答を返す（[protocol-and-compatibility.md](protocol-and-compatibility.md) の 4 節の「フラグ」）。
- 1,000 は初期値。Confluent Cloud・MSK の公開の値は見つからなかった（未検証）。大きなグループを使うテナントの需要を見て、Dedicated（S2）では上げる。

### 4.2 グループの単位の設定（テナントが変えられるもの）

IncrementalAlterConfigs の `GROUP` の資源で、次だけを通す。表にないものは `POLICY_VIOLATION`（[ADR-0007](../decisions/0007-topic-config-allowlist.md) と同じ許可リストの考え方）。

| 設定 | 範囲 | 備考 |
| --- | --- | --- |
| `consumer.session.timeout.ms` | 45 秒〜60 秒 | ブローカーの最小・最大と同じ |
| `consumer.heartbeat.interval.ms` | 5 秒〜15 秒 | 同上 |
| `share.*` | 7.1 節の表 | 共有のグループを有効にしてから |
| `streams.*` | 7.2 節 | Streams のグループを有効にしてから |

- グループの資源の設定が AlterConfigPolicy を通るかは未検証。通らなければ、名前空間のパッチの出入口で検査する（E6 の PoC で確かめる）。

### 4.3 consumer の正規表現と名前空間

- consumer のグループの正規表現は、コーディネーターがトピックの一覧に当てる。一覧は物理クラスタのすべてのトピック（接頭辞付きの内部の名前）なので、そのままでは (a) テナントの正規表現 `orders.*` が `lc-7kq2vx_orders` に当たらず、(b) `.*` が他のテナントのトピックに当たる。
- そこで、コーディネーターの「正規表現に当たるトピックを探す」処理だけをパッチで変え、候補をグループのテナントの接頭辞で始まるトピックに絞り、接頭辞を外した名前に正規表現を当てる。正規表現の文字列そのものは書き換えない（`^` などの錨を含む任意の正規表現で、本家と同じ結果にするため）。
- これは名前空間のパッチの 2 か所目になる（要求の出入口のほかに、コーディネーターの中）。[ADR-0025](../decisions/0025-tenant-namespace-patch.md) のパッチの一覧に載せる。
- classic のグループの正規表現は、クライアントが Metadata の応答に当てる。Metadata はテナントのトピックだけを返すので、変える必要はない。

## 5. オフセット

- `__consumer_offsets`（50・複製 3・`min.isr` 2）に、接頭辞付きのグループの ID をキーとして保存する。テナントには見せない（Metadata・ListTopics に出さない）。
- 保持は本家の既定（7 日）で、テナントは変えられない。空のグループのオフセットは、最後のメンバーが抜けてから 7 日で消える。利用者向けの文書に書く。
- OffsetCommit のメタデータは 4 KiB まで（本家の既定）。
- OffsetDelete・DeleteGroups は、テナントの ACL の範囲で通す。
- OffsetCommit・Heartbeat・ConsumerGroupHeartbeat の頻度は、テナントの要求のクォータ（`request_percentage`）に数える（[multi-tenancy-and-quotas.md](multi-tenancy-and-quotas.md) の 6 節）。

## 6. テナントごとの上限

| 対象 | Basic | Standard | 超えたとき |
| --- | --- | --- | --- |
| グループの数（classic・consumer の合計。空のグループを含む） | 1,000 | 10,000 | 新しいグループを作る要求（JoinGroup、エポック 0 の ConsumerGroupHeartbeat、未知のグループへの OffsetCommit）を `GROUP_AUTHORIZATION_FAILED`（文言に上限を超えたことを書く）で断る |
| 1 つのグループのメンバー | 1,000 | 1,000 | 本家どおり `GROUP_MAX_SIZE_REACHED` |
| グループの要求の頻度 | 要求のクォータ（`request_percentage`）の中 | 同左 | throttle |

- グループの数は、`transactional.id` と同じく、`__consumer_offsets` のパーティションのリーダーが手元で「そのテナントのグループの数 ≤ ceil(2 × 上限 ÷ 50)」を確かめる（[transactions-and-idempotence.md](transactions-and-idempotence.md) の 6 節と同じ形）。
- 値は初期値。未検証。

## 7. 共有のグループと Streams のグループ（Later）

[ADR-0024](../decisions/0024-share-and-streams-groups-staging.md) で、有効にする条件を決めた。

### 7.1 共有のグループ（KIP-932）

有効にする条件：

1. 名前空間の表に、ShareGroupHeartbeat・ShareGroupDescribe・ShareFetch・ShareAcknowledge・共有のグループのオフセットの API（DescribeShareGroupOffsets〜DeleteShareGroupOffsets）の資源の場所を足し、他のテナントが見えないことの性質ベーステストを通す。ブローカーの間の API（InitializeShareGroupState〜ReadShareGroupStateSummary）は、テナントには拒否のまま。
2. ブローカー全体の上限をテナントで分ける：`group.share.max.share.sessions`（ブローカーごとに 2000）を 1 つのテナントが使い切らないよう、テナントごとの共有のセッションの数に上限を掛ける（Standard でブローカーあたり 200。初期値）。レコードのロック（`share.partition.max.record.locks`）はメモリーを使うので、グループの設定の範囲を絞る。
3. 障害注入：ブローカーの停止・分断の下で、確認応答したレコードが再配送されない、配送の回数の上限を超えたレコードが捨てられる（アーカイブされる）ことを確かめる。
4. 遅れのメトリクス（4.2 で本家に入った）を、メトリクスの API に載せる。

グループの設定の範囲（テナントが変えられる値）：

| 設定 | 範囲 |
| --- | --- |
| `share.auto.offset.reset` | `earliest`、`latest`（`by_duration` は本家の値の一覧を確かめてから。未検証） |
| `share.isolation.level` | `read_uncommitted`、`read_committed` |
| `share.record.lock.duration.ms` | 15 秒〜60 秒（ブローカーの最小・最大） |
| `share.delivery.count.limit` | 2〜10（同上） |
| `share.partition.max.record.locks` | 100〜2000（ブローカーの最大 4000 より低くする） |
| `share.session.timeout.ms`、`share.heartbeat.interval.ms` | ブローカーの最小・最大の範囲 |

### 7.2 Streams のグループ（KIP-1071）

- 4.2 で機能を絞った GA。StreamsGroupHeartbeat は、トポロジー（Streams の内部のトピックの名前を含む）をブローカーに送る。名前空間のパッチは、トポロジーの中のトピックの名前にも接頭辞を付け外しする必要があり、資源の場所が他の API より複雑になる。
- 有効にする条件：(1) トポロジーの中のトピックの名前の付け外しの性質ベーステスト、(2) exactly-once の試験（[ADR-0022](../decisions/0022-exactly-once-verification.md)）を Streams のグループでも通す、(3) 本家で「機能を絞った」制限が外れていること（何が絞られているかは未検証）。
- それまで Kafka Streams は classic のプロトコル（Streams の既定）で動く。

## 8. 遅れ（lag）

- データ面のエージェントが、60 秒ごとに、テナントのグループごとに計算する。
  - コミット済みのオフセット：内部の主体で OffsetFetch（複数のグループをまとめて）。
  - パーティションの終わり：ListOffsets の最新（high watermark）。
  - 遅れ ＝ 終わり − コミット済み。コミットのないパーティションは「未コミット」として別に数える。
- `read_committed` のコンシューマーは LSO までしか読まないので、開いたトランザクションがあると、遅れが縮まらないように見える。遅れの説明に書き、LSO との差も別のメトリクスで出す。
- メトリクスの API には、グループ×トピックの合計と最大、パーティションごとの値（問い合わせのときだけ）を渡す。形と保存は metrics-and-billing の領域。
- S1 の規模（パーティション 20 万）で、1 分ごとの OffsetFetch・ListOffsets がブローカーに与える負荷を E6 で測る。重ければ、間隔を延ばすか、ブローカーのメトリクス（パーティションの終わり）から取る。
- 共有のグループの遅れは、本家のメトリクス（4.2）を使う。

## 9. 障害のときの振る舞い

| 障害 | 振る舞い | 利用者への影響 |
| --- | --- | --- |
| コーディネーターのブローカーの停止 | `__consumer_offsets` のパーティションのリーダーが移り、新しいリーダーがグループの状態を読み込む | 数秒の `NOT_COORDINATOR`・`COORDINATOR_LOAD_IN_PROGRESS`。classic はリバランスが起きうる。consumer は割り当てを保つ |
| `__consumer_offsets` の `min.isr` 割れ | OffsetCommit が `offsets.commit.timeout.ms`（5 秒）で失敗する | コミットが失敗し、再起動のときに重複して読む（at-least-once の範囲） |
| 1 つのテナントのリバランスの嵐 | 要求のクォータで throttle。コーディネーターのスレッド（4）を占めないように、グループの大きさの上限と合わせて抑える | そのテナントのリバランスが遅れる |
| エージェントの停止 | 遅れのメトリクスが止まる。データの経路には影響しない | 遅れが見えない。エージェントの死活をアラートにする |
| classic の独自のメタデータの割り当て器を使うグループの移行 | 本家どおり、無停止の変換ができない | 利用者の文書で、止めてから替える手順を示す |

## 10. セキュリティ（テナントの分離）

- グループの ID は `<lc-id>_<id>` になる。ListGroups・DescribeGroups・ConsumerGroupDescribe・OffsetFetch はテナントのものだけを返す。
- FindCoordinator は、接頭辞付きの ID でコーディネーターを選ぶ。返すブローカーのホスト名は、テナントのホスト名の形（[multi-tenancy-and-quotas.md](multi-tenancy-and-quotas.md) の 4.4 節）。
- consumer の割り当ては、トピックの ID（UUID）で返る。トピックの ID は物理クラスタで一意なので、他のテナントのトピックの ID を知っても、名前空間のパッチがトピックの持ち主を確かめる（同 4.3 節）。割り当てに他のテナントのトピックが入らないことは、4.3 節の正規表現の絞り込みと、購読するトピックの名前の接頭辞で守る。
- 正規表現は、テナントのトピックだけを相手に評価する（4.3 節）。これを性質ベーステストで確かめる。
- 遅れのメトリクスのラベルに、グループの ID とトピックの名前が入る。運用のメトリクス（社内）では上位 N 件とハッシュに丸め、テナント向けのメトリクスの API でだけ生の名前を返す。

## 11. テスト

### 11.1 性質ベーステスト（jqwik）

- 任意の 2 つのテナント、任意のトピックの名前、任意の正規表現（RE2J の文法の範囲で生成）で、consumer のグループの購読の結果は、そのテナントのトピックだけで、本家（1 テナントのクラスタ）に同じ名前のトピックを作って同じ正規表現を当てた結果と同じ。
- 任意のグループの操作の列で、ListGroups・DescribeGroups・OffsetFetch の応答に、他のテナントのグループが出ない。
- 任意のグループの作成の列で、テナントのグループの数がパーティションごとの上限を超えない。

### 11.2 障害注入

- classic と consumer のそれぞれで、コーディネーターの停止・分断の下で、コミットしたオフセットが失われない（コミットが成功を返したものは、次の OffsetFetch で見える）。
- 移行：classic のグループを 1 台ずつ consumer に替える途中で、ブローカーを停止しても、パーティションが 2 つのメンバーに同時に割り当てられない（重複の処理が、本家の保証の範囲を超えない）。

### 11.3 互換性と負荷

- クライアントの行列（[protocol-and-compatibility.md](protocol-and-compatibility.md) の 6 節）で、両方のプロトコル、正規表現の購読、移行、OffsetDelete を流す。
- 1 つのテナントがメンバー 1,000 のグループを繰り返しリバランスさせても、他のテナントの ConsumerGroupHeartbeat の p99 が 100ms 以内（初期値。未検証）。

## 12. 未解決の問い

### 決定（2026-09-27、既定案）

- **classic と consumer の両方を出す**。機能の版と設定は本家の既定（`uniform,range`、`bidirectional`）。
- **グループの大きさの上限は 1,000**（ブローカー全体）。
- **テナントのグループの数は Basic 1,000・Standard 10,000**。超えたら `GROUP_AUTHORIZATION_FAILED`。
- **グループの単位の設定は許可リスト**（`consumer.session.timeout.ms`・`consumer.heartbeat.interval.ms`）。
- **consumer の正規表現は、コーディネーターの中のパッチで、テナントのトピックだけを相手に評価する**。
- **遅れはデータ面のエージェントが 60 秒ごとに計算する**。
- **共有のグループと Streams のグループは、機能の版を 0 にして無効**。有効にする条件は [ADR-0024](../decisions/0024-share-and-streams-groups-staging.md)。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| グループの資源の設定の変更が AlterConfigPolicy を通るか | E6 の PoC。通らなければ名前空間のパッチで検査する |
| 1 分ごとの遅れの計算の負荷 | E6 の負荷試験 |
| 共有のグループを有効にする時期（intent.md は「MVP の直後」） | 7.1 節の条件が揃った時点で、PM と決める |
| 共有のグループのテナントごとのセッションの上限の値 | 有効にする前の負荷試験 |
| Streams のグループの「機能を絞った」の中身と、外れる版 | 本家の文書と KIP-1071 を E6 の後に確かめる |
| classic のテナントに consumer への移行を促す方法（4.3 の記録に加えて、コンソールでの表示など） | console-and-api の領域と一緒に決める |
| ラックを考えた割り当て（KAFKA-19387）が入ったら、consumer のグループで fetch-from-follower と組み合わせて AZ をまたぐ読み取りを減らせるか | 本家に入った時点で、[replication-and-durability.md](replication-and-durability.md) と一緒に見る |

## 13. ADR

| ADR | 決定 |
| --- | --- |
| [0023](../decisions/0023-consumer-group-protocols-and-limits.md) | classic と consumer の両方のプロトコルを本家の既定で出し、グループの大きさ・テナントのグループの数に上限を掛ける。consumer の正規表現はテナントのトピックだけで評価し、遅れはデータ面のエージェントが計算する |
| [0024](../decisions/0024-share-and-streams-groups-staging.md) | 共有のグループと Streams のグループは機能の版で無効にしておき、名前空間の表・テナントごとの上限・障害注入の条件を満たしてから有効にする |

## 14. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E1 | `group-namespace-poc` | classic と consumer のグループが、名前空間のパッチを通して動く |
| E6 | `group-feature-versions` | `group.version`・`share.version`・`streams.version` とグループの設定の固定と検査 |
| E6 | `consumer-regex-namespacing` | コーディネーターの正規表現の評価のパッチと、性質ベーステスト |
| E6 | `group-config-allowlist` | `GROUP` の資源の設定の許可リスト |
| E6 | `group-count-limit` | テナントのグループの数の上限 |
| E6 | `group-size-limit` | `group.max.size`・`group.consumer.max.size` |
| E6 | `consumer-lag-collector` | データ面のエージェントの遅れの計算 |
| E6 | `protocol-migration-tests` | classic → consumer の無停止の移行と、障害の下の試験 |
| E6 | `coordinator-fault-injection` | 11.2 節 |
| E7 | `group-request-quota` | グループの要求を要求のクォータに数える確認と、リバランスの嵐の負荷試験 |
| E11 | `consumer-lag-metrics-api` | 遅れのメトリクスの API（metrics-and-billing の領域と一緒に） |
| MVP の直後 | `share-groups-enable` | 7.1 節の条件 1〜4 |
| S2 | `streams-groups-enable` | 7.2 節の条件 |

## 15. quality.md・runbooks・data-model への項目

### quality.md

- コーディネーターの移動の後、グループが再び安定するまでの時間（classic と consumer を分けて）。
- ConsumerGroupHeartbeat・Heartbeat の p99（テナントの上位と全体）。
- classic と consumer のグループの数の比率（移行の進み具合）。
- 遅れの計算の遅延（エージェントの 1 周の時間）と失敗の件数。
- テナントのグループの数の上限の使用率と、断った件数。

### runbooks

- `rebalance-storm.md`：リバランスの嵐のテナントの特定、throttle の確認、テナントへの連絡。
- `coordinator-load.md`：`__consumer_offsets` のパーティションの読み込みが遅いときの切り分け。
- `consumer-lag-collector-down.md`：遅れのメトリクスが止まったときの確かめ方。

### data-model（索引への追加の提案）

| 置き場所 | 名前 | 中身 |
| --- | --- | --- |
| データ面（内部トピック） | `__consumer_offsets` | 本家。キーは接頭辞付きのグループの ID |
| データ面（内部トピック） | `__share_group_state` | 本家（共有のグループを有効にしてから） |
| 制御面（Aurora） | `logical_cluster_limits` | この領域の欄：`max_groups`（表は [multi-tenancy-and-quotas.md](multi-tenancy-and-quotas.md) の 15 節） |
| メトリクスの時系列 | `consumer_group_lag` | `logical_cluster_id`、`group_id`、`topic`、`partition`（問い合わせのときだけ）、`lag`、`committed_offset`、`log_end_offset`、時刻 |

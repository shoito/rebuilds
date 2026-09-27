# Transactions and idempotence: Kafka

冪等なプロデューサー、トランザクションのコーディネーター、KIP-890（トランザクションのサーバー側の防御）、テナントごとの `transactional.id` と producer ID の上限、Kafka Streams の exactly-once の確かめ方の設計。本家のブローカーの実装をそのまま使う方針は [ADR-0001](../decisions/0001-upstream-brokers-and-stack.md)、名前空間は [ADR-0004](../decisions/0004-logical-clusters-on-shared-physical-clusters.md) と [ADR-0025](../decisions/0025-tenant-namespace-patch.md)、互換と Jepsen の形のテストの枠は [ADR-0005](../decisions/0005-compatibility-policy.md) にある。

本家の振る舞いは、2026-09-27 に kafka.apache.org の 4.3 の文書、各 KIP のページ、ASF の Jira で確かめた。確かめられなかったものは「未検証」と書く。要件 ID は、E5 の各変更の `spec.md` に移すときに振る。

## 1. 目的と範囲

- 冪等なプロデューサーとトランザクションを、本家と同じ意味で動かす（intent.md の「守るべき振る舞い」）。
- 意味そのものは作らない。本家の実装をそのまま使い、この領域は、(1) 固定する設定、(2) テナントごとの上限、(3) 正しさの確かめ方、(4) 利用者に伝える既知の制約を決める。
- 共有の物理クラスタで、1 つのテナントのトランザクションの使い方（大量の `transactional.id`、producer ID の乱発、長いトランザクション）が、他のテナントとブローカーを傷めないようにする。

範囲に入れないもの：

| もの | 扱う場所 |
| --- | --- |
| 名前空間のパッチの仕組み（`transactional.id` に接頭辞を付けること自体） | [multi-tenancy-and-quotas.md](multi-tenancy-and-quotas.md) |
| API の表（InitProducerId などを通すこと） | [protocol-and-compatibility.md](protocol-and-compatibility.md) の 4 節 |
| `TRANSACTIONAL_ID` の ACL の作り方 | security-and-acls.md |
| 障害注入の枠と耐久性の監査の全体 | [replication-and-durability.md](replication-and-durability.md) |
| オフセットのコミットとグループの意味 | [consumer-groups.md](consumer-groups.md) |

## 2. 本家の形（確かめたこと）

| 項目 | 本家 | 出典 |
| --- | --- | --- |
| 冪等とトランザクションの基本 | KIP-98（0.11）。プロデューサーは producer ID（PID）とエポックを持ち、パーティションごとの連番で重複を捨てる。トランザクションはコーディネーターが `__transaction_state` に状態を書き、各パーティションにコミット・中止のマーカーを書く | [KIP-98](https://cwiki.apache.org/confluence/display/KAFKA/KIP-98+-+Exactly+Once+Delivery+and+Transactional+Messaging) |
| 冪等の既定 | Java のクライアントは 3.0 から `enable.idempotence=true`、`acks=all` が既定（KIP-679。採択、3.0） | [KIP-679](https://cwiki.apache.org/confluence/display/KAFKA/KIP-679%3A+Producer+will+enable+the+strongest+delivery+guarantee+by+default)（2026-09-27 に確認） |
| Kafka Streams の exactly-once v2 | KIP-447。スレッドごとに 1 つのプロデューサーにし、`sendOffsetsToTransaction` にグループのメタデータを渡してゾンビを締め出す（採択、2.6） | [KIP-447](https://cwiki.apache.org/confluence/display/KAFKA/KIP-447%3A+Producer+scalability+for+exactly+once+semantics)（2026-09-27 に確認） |
| KIP-890 第 1 段 | 古いクライアント向けに、ブローカーが produce を受ける前に、パーティションがトランザクションに加わっているかをコーディネーターに確かめる（`AddPartitionsToTxn` の `verifyOnly`）。確かめられなければ `INVALID_TXN_STATE`。設定 `transaction.partition.verification.enable`（既定 `true`）。遅れて届いた書き込みが次のトランザクションに混ざることは防げない | [KIP-890](https://cwiki.apache.org/confluence/display/KAFKA/KIP-890%3A+Transactions+Server-Side+Defense)、[Broker Configs](https://kafka.apache.org/43/configuration/broker-configs/)。入った版は 3.6（[3.6.0 の発表](https://kafka.apache.org/blog/2023/10/10/apache-kafka-3.6.0-release-announcement/)。KIP の一覧は 3.7.0 と書くが、発表を正とする。2026-09-27 に確認） |
| KIP-890 第 2 段（TV2） | トランザクションごとにエポックを上げる。`EndTxn` の応答（v4 以上）で新しいエポックを返す。パーティションは最初の produce で暗黙に加わり、クライアントは `AddPartitionsToTxn` を送らない。新しいエラー `TRANSACTION_ABORTABLE`。`transaction.version=2` の機能の版で有効にする。4.0 からサーバーで既定で有効。4.0 以上のクライアントが使う | [Transaction Protocol](https://kafka.apache.org/43/operations/transaction-protocol/)、[KIP-890](https://cwiki.apache.org/confluence/display/KAFKA/KIP-890%3A+Transactions+Server-Side+Defense) |
| TV2 の後の強化 | 4.2 の KIP-1228 で、`WriteTxnMarkers` に TransactionVersion を足し、TV2 のマーカーのエポックの検査を厳しくした | [4.2.0 の発表](https://kafka.apache.org/blog/2026/02/17/apache-kafka-4.2.0-release-announcement/) |
| KIP-890 の Jira | KAFKA-14402 は 4.1.0 で解決（2025-06-25） | [KAFKA-14402](https://issues.apache.org/jira/browse/KAFKA-14402) |
| 2 相コミット | KIP-939。外部のトランザクションのコーディネーターと組む。`transaction.two.phase.commit.enable`（既定 `false`） | [Broker Configs](https://kafka.apache.org/43/configuration/broker-configs/) |
| 運用の道具 | KIP-664。DescribeProducers、DescribeTransactions、ListTransactions の API と、`kafka-transactions.sh` のぶら下がったトランザクションの検出（`find-hanging`）・中止（`abort`）（採択） | [KIP-664](https://cwiki.apache.org/confluence/display/KAFKA/KIP-664%3A+Provide+tooling+to+detect+and+abort+hanging+transactions)（2026-09-27 に確認） |
| producer ID の乱発への備え | KIP-936（`producer_ids_rate` のクォータ）は議論中で、実装されていない | [KIP-936](https://cwiki.apache.org/confluence/display/KAFKA/KIP-936%3A+Throttle+number+of+active+PIDs)、[KAFKA-15063](https://issues.apache.org/jira/browse/KAFKA-15063) |

主な設定の既定（[Broker Configs](https://kafka.apache.org/43/configuration/broker-configs/)、2026-09-27 に確認）：

| 設定 | 既定 |
| --- | --- |
| `transactional.id.expiration.ms` | 604800000（7 日）。状態の更新がないまま過ぎた `transactional.id` を消す。進行中のものは消さない |
| `producer.id.expiration.ms` | 86400000（1 日）。パーティションのリーダーが PID の状態を消す。保持で最後の書き込みが消えると、それより早く消えうる |
| `transaction.max.timeout.ms` | 900000（15 分）。これを超える `transaction.timeout.ms` は InitProducerId でエラー |
| `transaction.state.log.num.partitions`・`replication.factor`・`min.isr` | 50・3・2 |
| `transaction.abort.timed.out.transaction.cleanup.interval.ms` | 10000（10 秒） |
| `transaction.remove.expired.transaction.cleanup.interval.ms` | 3600000（1 時間） |
| `add.partitions.to.txn.retry.backoff.ms`・`add.partitions.to.txn.retry.backoff.max.ms` | TV2 で、サーバー側が `CONCURRENT_TRANSACTIONS` を再試行する間隔。既定 20 ms・上限 100 ms（[Broker Configs](https://kafka.apache.org/43/configuration/broker-configs/)、2026-09-27 に確認）。本家の既定のままにする |

### 2.1 Jepsen が本家に報告した問題（2026-09-27 の状態）

[Jepsen: Bufstream 0.1.0](https://jepsen.io/analyses/bufstream-0.1.0) は、Kafka のプロトコルそのものの問題を報告した。

| 問題 | 中身 | 状態 |
| --- | --- | --- |
| [KAFKA-17754](https://issues.apache.org/jira/browse/KAFKA-17754) | 遅れて届いた `EndTxn` が、次のトランザクションをコミット・中止する。書き込みの喪失、中止した読み取り、ちぎれたトランザクション | 解決（2026-08-12）。「KIP-890 と関連の修正で解決」とのコメントで閉じられた。修正の版の記載はない |
| [KAFKA-17582](https://issues.apache.org/jira/browse/KAFKA-17582) | トランザクションの中止の後、Java のコンシューマーの位置が巻き戻らない（リバランスが起きたときだけ戻る）。文書（KIP-98）と振る舞いが食い違い、処理の抜けにつながりうる | 未解決 |
| [KAFKA-17734](https://issues.apache.org/jira/browse/KAFKA-17734) | `Consumer.close()` の時間の上限が効かない | 未解決（Jira の状態は Open） |
| エラーの紛らわしさ（[KIP-588](https://cwiki.apache.org/confluence/display/KAFKA/KIP-588%3A+Allow+producers+to+recover+gracefully+from+transaction+timeouts)） | トランザクションの時間切れでも `ProducerFencedException` になり、別のプロデューサーがいるかのような文言になる | 未解決（KIP-588 は KIP の一覧で「2.8.0 (WIP)」のまま） |

KAFKA-17754 の解決は、TV2（トランザクションごとのエポックの上げ）が効くクライアント、つまり 4.0 以上の Java のクライアントが前提になる。古いクライアントは第 1 段の確認だけを受ける。franz-go は KIP-890（第 2 段を含む）に対応し、ブローカーと交渉した `transaction.version` で第 2 段を使う（[franz-go の README](https://github.com/twmb/franz-go) の KIP の表と CHANGELOG）。librdkafka は、対応する KIP の一覧に KIP-890 を載せていない（[INTRODUCTION.md](https://github.com/confluentinc/librdkafka/blob/master/INTRODUCTION.md)）ので、第 1 段の確認だけを受ける前提にする（どちらも 2026-09-27 に確認）。

## 3. 方針

- **本家の意味をそのまま使い、耐久性の既定値と同じく、トランザクションの防御の設定をテナントに変えさせない。** `transaction.version=2`、`transaction.partition.verification.enable=true` を固定する（[ADR-0021](../decisions/0021-transaction-settings-and-tenant-limits.md)）。
- **ブローカーの資源を食う振る舞いに、テナントごとの上限を掛ける。** 生きている `transactional.id` の数、InitProducerId の頻度。Kora の「メモリーを使う振る舞いへのクォータ」に相当する（[Kora](https://vldb.org/pvldb/vol16/p3822-povzner.pdf) の 5.2 節）。
- **正しさは、Jepsen の形の障害注入と、Kafka Streams の exactly-once の長時間の試験で、毎日確かめる。** 本家の版を上げるときの関門にする（[ADR-0022](../decisions/0022-exactly-once-verification.md)）。
- **本家で直っていない問題は、隠さずに利用者に伝える。** 差分テストでは「本家と同じ」なので互換としては正しいが、既知の制約として文書に書く。

## 4. 冪等なプロデューサー

### 4.1 流れ

1. プロデューサーは InitProducerId で PID とエポックを得る。`transactional.id` がなければ、どのブローカーでも振れる。
2. 各パーティションへのバッチに、PID・エポック・連番を付ける。`max.in.flight.requests.per.connection` は 5 以下（クライアントの制約）。
3. リーダーはパーティションごとに PID の状態（最後の 5 つのバッチの連番）を持ち、重複を捨て、抜けを `OUT_OF_ORDER_SEQUENCE_NUMBER` で断る。
4. PID の状態は、スナップショット（`.snapshot`）としてセグメントと一緒に保存され、階層型の保存では `PRODUCER_SNAPSHOT` の索引として S3 にも上がる（[tiered-and-object-storage.md](tiered-and-object-storage.md) の 2 節）。

### 4.2 資源の使い方とテナントの上限

- PID の状態は、パーティションのリーダーのメモリーに、`producer.id.expiration.ms`（1 日）残る。プロデューサーを使い捨てにするアプリ（関数の呼び出しごとに作るなど）は、1 日分の PID を積み上げる。本家は KIP-936 を実装していない。
- そこで、InitProducerId の頻度に、テナントごとの上限を掛ける（6 節）。超えたら、本家のクォータと同じく、応答の `throttle_time_ms` で遅らせる（InitProducerId の応答は `throttle_time_ms` を持つ）。エラーにはしない。
- `producer.id.expiration.ms` は本家の既定（1 日）のまま、テナントに変えさせない。

## 5. トランザクション

### 5.1 流れ（TV2、4.0 以上のクライアント）

```
プロデューサー          コーディネーター（__transaction_state のリーダー）   パーティションのリーダー
   │ FindCoordinator(transactional.id) ─▶ 接頭辞付きの ID のハッシュで、50 の中の 1 つ
   │ InitProducerId ───────────▶ 前のトランザクションを中止・完了し、エポックを上げる
   │                               （ここでテナントの上限を確かめる。6 節）
   │ Produce(トランザクション) ───────────────────────────────────▶ 最初の書き込みで、
   │                               ◀── AddPartitionsToTxn（ブローカーから）── パーティションを暗黙に加える
   │ TxnOffsetCommit（Streams・consume-transform-produce）─▶ グループのコーディネーター
   │ EndTxn(commit) ───────────▶ PREPARE_COMMIT を書く → 新しいエポックを返す
   │                               WriteTxnMarkers ────────────────────▶ COMMIT のマーカー
   │                               COMPLETE_COMMIT を書く
```

- `EndTxn` の後、マーカーが書き終わる前に次のトランザクションを始めると、`CONCURRENT_TRANSACTIONS` になる。TV2 ではサーバーが再試行するので、produce の遅延に含まれて見える（[Transaction Protocol](https://kafka.apache.org/43/operations/transaction-protocol/)）。produce の遅延の目標（NFR-003）は、トランザクションの書き込みを分けて測る。
- `read_committed` のコンシューマーは LSO までしか読まない。開いたトランザクションが LSO を止める。

### 5.2 固定する設定

| 設定 | 値 | 理由 |
| --- | --- | --- |
| `transaction.version`（機能の版） | 2 | KIP-890 第 2 段。KAFKA-17754 の型を防ぐ |
| `transaction.partition.verification.enable` | `true` | 古いクライアントへの第 1 段の防御 |
| `transaction.max.timeout.ms` | 900000（15 分。本家の既定） | Kafka Streams などの既存のアプリの設定をそのまま通す。短くすると、長い処理のアプリが InitProducerId で失敗する |
| `transactional.id.expiration.ms` | 604800000（7 日。本家の既定） | ブローカー全体の設定で、テナントごとに変えられない。短くすると、止めていたアプリの再開で状態が消え、ゾンビの締め出しが効かなくなる |
| `transaction.two.phase.commit.enable` | `false` | 2 相コミット（KIP-939）は MVP の後。外部のコーディネーターが長く準備の状態を保つと、LSO と階層型の保存が止まる |
| `transaction.state.log.*` | 本家の既定（50・3・2） | 耐久性の既定値と揃える |

テナントは、これらを変えられない（ブローカーの設定で、テナントの API に出ていない）。`UpdateFeatures` はテナントに拒否する（[protocol-and-compatibility.md](protocol-and-compatibility.md) の 4 節）。

### 5.3 名前空間

- `transactional.id` は、名前空間のパッチで `<lc-id>_<id>` になる。コーディネーターの選択は接頭辞付きの ID のハッシュで行う。テナントの ID の偏りで、1 つのコーディネーターに集まることはあるが、他のテナントの ID と同じ空間を共有するので、テナントの単位で見れば散る。
- `TxnOffsetCommit` の `group_id` と、`AddPartitionsToTxn` のトピック名にも接頭辞を付ける。
- DescribeTransactions・ListTransactions・DescribeProducers の応答は、テナントのものだけを返し、接頭辞を外す。ListTransactions の `producer_id` での絞り込みで、他のテナントの PID を指定しても、何も返らない（PID は物理クラスタで共有の空間なので、他のテナントの PID の存在を漏らさない）。

## 6. テナントごとの上限

| 対象 | Basic | Standard | 超えたとき | 数える場所 |
| --- | --- | --- | --- | --- |
| 生きている `transactional.id`（期限切れでないもの） | 1,000 | 10,000 | 新しい `transactional.id` の InitProducerId を `TRANSACTIONAL_ID_AUTHORIZATION_FAILED` で断る。既存の ID は使い続けられる | コーディネーターのパーティションごと（下） |
| InitProducerId の頻度（`transactional.id` の有無を問わない） | 毎秒 10 | 毎秒 100 | `throttle_time_ms` で遅らせる | ブローカーごと。上限をブローカーの数で割った値（静的） |
| 1 つのトランザクションの時間 | 15 分 | 15 分 | 本家どおり、コーディネーターが中止する | コーディネーター |

- 値は初期値。Kafka Streams のアプリの典型（スレッド数 × インスタンス数、再起動で変わる ID の積み上げ）を E5 の `transactional-id-limit` で測って見直す。未検証。
- **生きている `transactional.id` の数え方**：`__transaction_state` のパーティションは 50 あり、テナントの ID はハッシュで散る。そこで、コーディネーターのパーティションごとに「そのテナントの ID の数 ≤ ceil(2 × 上限 ÷ 50)」を、パーティションのリーダーが手元の状態だけで確かめる。集計の往復がなく、判断が決定的になる。偏りで少し早く断られうるので、テナント全体の数も、クォータの使用量のトピックで集計して見せる（[multi-tenancy-and-quotas.md](multi-tenancy-and-quotas.md) の 7 節）。
- **エラーの選び方**：InitProducerId に本家が定義するエラーの中から、再試行しても直らないことが伝わるものとして `TRANSACTIONAL_ID_AUTHORIZATION_FAILED` を選ぶ。エラーの文言に「上限を超えた」ことを書く。本家との差分テストでは、上限を超えた場合を「許された違い」の表に載せる（[protocol-and-compatibility.md](protocol-and-compatibility.md) の 7 節）。
- この数え方と断り方は、本家の差し込み口にないので、名前空間のパッチと同じ場所（パッチの一覧）に入れる（[ADR-0021](../decisions/0021-transaction-settings-and-tenant-limits.md)）。

## 7. Kafka Streams の exactly-once

- `processing.guarantee=exactly_once_v2`（KIP-447）を、変更なしで動かすことを目標にする。
- Streams の内部のトピック（`<application.id>-...-changelog`、`-repartition`）は、普通のトピックとして名前空間を通る。`replication.factor=-1` で作るので、固定の複製 3 と矛盾しない（[protocol-and-compatibility.md](protocol-and-compatibility.md) の 5 節）。
- changelog は圧縮のトピックなので、階層型の保存に載らず、圧縮のトピックの容量の上限に数える（[tiered-and-object-storage.md](tiered-and-object-storage.md) の 7 節）。状態の大きいアプリは、上限に当たりうる。
- exactly-once v2 の `transactional.id` は、`application.id` と、Streams のプロセスの ID と、スレッドの番号から、`<application.id>-<プロセスの UUID>-<スレッドの番号>` の形で作られる（[ActiveTaskCreator.java](https://github.com/apache/kafka/blob/4.3/streams/src/main/java/org/apache/kafka/streams/processor/internals/ActiveTaskCreator.java)、2026-09-27 に確認）。プロセスの ID が状態のディレクトリに保存されない環境（使い捨てのディスクの Pod など）では、再起動のたびに新しい ID が生まれ、7 日残る。利用者の文書で、状態のディレクトリを永続のボリュームに置くことを勧め、6 節の上限の理由を説明する。
- Streams のリバランスのプロトコル（KIP-1071）は、フラグの裏に置く（[consumer-groups.md](consumer-groups.md) の 7 節）。exactly-once の試験は、従来のプロトコルで回す。

## 8. LSO、ぶら下がったトランザクション、階層型の保存

- 開いたトランザクションは、そのパーティションの LSO を止める。`read_committed` のコンシューマーはその先を読めず、階層型の保存はその先のセグメントを S3 に上げない（[tiered-and-object-storage.md](tiered-and-object-storage.md) の 6.1 節）。
- 時間切れのトランザクションは、コーディネーターが 10 秒ごとに探して中止する。最大で 15 分＋10 秒止まる。
- ぶら下がったトランザクション（コーディネーターが知らないのに、パーティションに開いたままの書き込みが残るもの）は、KIP-890 で新しくは生まれにくくなったが、古いクライアントと過去のデータでは残りうる。
- 検出：データ面のエージェントが、パーティションごとの「最も古い開いたトランザクションの経過時間」を DescribeProducers で集め、`transaction.max.timeout.ms`＋5 分を超えたものをアラートにする。
- 中止：運用が `kafka-transactions.sh`（KIP-664）で中止する。テナントには中止の API を出さない（WriteTxnMarkers は拒否。[protocol-and-compatibility.md](protocol-and-compatibility.md) の 4 節）。runbook に手順を置く。

## 9. 障害のときの振る舞い

| 障害 | 振る舞い | 利用者への影響 |
| --- | --- | --- |
| コーディネーターのブローカーの停止 | `__transaction_state` のパーティションのリーダーが移り、新しいリーダーが状態を読み込む。準備の状態のトランザクションは完了させる | 数秒の `COORDINATOR_NOT_AVAILABLE`・`NOT_COORDINATOR`。クライアントは再試行する |
| マーカーを書く先のパーティションの `min.isr` 割れ | マーカーが書けず、トランザクションが完了しない。コーディネーターは再試行し続ける | その後のトランザクションが `CONCURRENT_TRANSACTIONS` で待つ。LSO が止まる |
| 遅れて届いた `EndTxn`・produce | TV2：古いエポックとして締め出す。第 1 段だけのクライアント：確認で `INVALID_TXN_STATE` | なし（TV2）。古いクライアントでは、遅れた書き込みが次のトランザクションに混ざる危険が残る（KIP-890 の記述） |
| 1 つのテナントが InitProducerId を乱発 | 6 節の上限で遅らせる | そのテナントだけが遅れる |
| 1 つのテナントが大量の `transactional.id` を作る | 6 節の上限で断る | そのテナントの新しい ID だけが失敗する |
| `__transaction_state` の読み込みが遅い（ID が多すぎる） | コーディネーターの移動のたびに、読み込みの間、そのパーティションの全テナントが待つ | 他のテナントにも及ぶ。6 節の上限で、パーティションあたりの量を抑える |

## 10. セキュリティ（テナントの分離）

- `transactional.id` とグループの ID は、名前空間で分ける。同じ文字列を 2 つのテナントが使っても、別のトランザクションになる。他のテナントの ID を締め出す（エポックを上げる）ことはできない。
- PID とエポックは物理クラスタで共有の数の空間である。PID を推測して他のテナントのパーティションに書くことは、名前空間のパッチがトピックを接頭辞で閉じるので、できない。DescribeProducers・ListTransactions の応答は、テナントのパーティションと ID だけを返す。
- `TRANSACTIONAL_ID` の ACL は、テナントが自分の名前空間の中で付ける（security-and-acls の領域）。本家と同じく、`transactional.id` を使うには `TRANSACTIONAL_ID` の `WRITE` が要る。冪等なプロデューサーだけなら、本家の 2.8 以降と同じく、トピックの `WRITE` で足りる（`IDEMPOTENT_WRITE` は 3.0 で非推奨。[KIP-679](https://cwiki.apache.org/confluence/display/KAFKA/KIP-679%3A+Producer+will+enable+the+strongest+delivery+guarantee+by+default)、2026-09-27 に確認）。
- トランザクションの中身（レコード）をログに出さない。`transactional.id` はテナントが付けた文字列なので、運用のログではハッシュにする。

## 11. テスト

### 11.1 Jepsen の形（毎日と、該当する PR ごと）

- [jepsen.tests.kafka](https://jepsen-io.github.io/jepsen/jepsen.tests.kafka.html) の `queue` と `txn` のワークロードを、自社のブローカー（パッチ＋差し込み口）の 3 AZ の構成に対して流す。
- 障害：ブローカーの停止・一時停止、ネットワークの分断（AZ の単位を含む）、時計のずれ、ディスクの遅延、コーディネーターのリーダーの移動、クライアントの再起動（`--crash-clients`）、トランザクションの中の遅延（`--intra-txn-delay`）。
- 検出するもの：`acks=all` の書き込みの喪失、中止した書き込みの読み取り（aborted read）、ちぎれたトランザクション、重複、コンシューマーの位置の矛盾。
- クライアント：Java 4.3（TV2）、Java 3.9（第 1 段だけ）。librdkafka と franz-go は、Jepsen のクライアントに組み込めるかを E3 の `jepsen-txn-workload` で確かめる（未検証）。
- KAFKA-17754 を再現する要求の列（遅れて届く `EndTxn`）を、差分テストの生の要求の送り手で作り、TV2 で締め出されることを確かめる。

### 11.2 Kafka Streams の exactly-once（毎日、6 時間）

- 代表のトポロジー：入力を集計（キーごとの合計と件数）して出力する。出力を `read_committed` で読み、入力から計算し直した答えと一致することを確かめる（重複・欠落 0）。
- 障害：Streams のインスタンスの強制終了と再起動、ブローカーの停止、ネットワークの分断、リバランスの誘発。
- 状態のディレクトリを永続にする場合と使い捨てにする場合の両方で、`transactional.id` の数の増え方を記録する（6 節の上限の見直しのため）。

### 11.3 性質ベーステスト（jqwik）

- 任意の 2 つのテナントと任意の `transactional.id` の列で、一方の InitProducerId が、他方のトランザクションのエポックを変えない。
- 任意の InitProducerId の列で、テナントの生きている `transactional.id` の数は、パーティションごとの上限を超えない。
- 任意の要求の列で、ListTransactions・DescribeProducers の応答に、他のテナントの ID・トピックが出ない。

### 11.4 本家との差分テスト

- トランザクションの要求の列（中止、時間切れ、`CONCURRENT_TRANSACTIONS`、古いエポック）で、エラーコードとオフセットが本家と同じ。違いは 6 節の上限だけ。

## 12. 利用者に伝える既知の制約

利用者向けの文書の「トランザクション」の節に書く。

- exactly-once の防御（KIP-890 第 2 段）が完全に効くのは、4.0 以上の Java のクライアント。古いクライアントでは、遅れて届いた書き込みが次のトランザクションに混ざる危険が、本家と同じく残る。
- トランザクションを中止した後、Java のコンシューマーの位置は自動では巻き戻らない（KAFKA-17582）。consume-transform-produce のアプリは、中止の後に最後にコミットしたオフセットへ `seek` するか、コンシューマーを作り直す。
- トランザクションの時間切れでも `ProducerFencedException` が出うる。
- 6 節のテナントごとの上限。

## 13. 未解決の問い

### 決定（2026-09-27、既定案）

- **TV2 と第 1 段の確認を固定で有効**にする。テナントは変えられない。
- **`transaction.max.timeout.ms`・`transactional.id.expiration.ms`・`producer.id.expiration.ms` は本家の既定**のまま。
- **2 相コミット（KIP-939）は無効**。MVP の後に、LSO と階層型の保存への影響を見てから決める。
- **テナントの上限**：生きている `transactional.id` は Basic 1,000・Standard 10,000、InitProducerId は毎秒 10・100。上限を超えた新しい ID は `TRANSACTIONAL_ID_AUTHORIZATION_FAILED`、頻度の超過は throttle。
- **ぶら下がったトランザクションの中止は運用だけ**が行う。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| librdkafka・franz-go・Sarama の TV2 への対応の状況 | E5 の着手時に各クライアントの変更履歴で確かめ、クライアントの行列に「TV2 に対応」の列を足す |
| KAFKA-17754 の修正が入った本家の版（Jira に版の記載がない） | E5 で、4.1・4.2・4.3 に対して再現の要求の列を流して確かめる |
| 上限の値（Streams の典型で足りるか） | E5 の 11.2 節の記録で見直す |
| テナントの上限を CU に比例させるか | metrics-and-billing の領域の CU の定義と一緒に決める |
| KIP-936 が本家に入ったら、自前の InitProducerId の頻度の上限を置き換えるか | 本家に入った時点で、パッチを減らす方向で決める |
| 2 相コミットの提供 | 需要（Flink の exactly-once のシンクなど）を見て、MVP の後に決める |

## 14. ADR

| ADR | 決定 |
| --- | --- |
| [0021](../decisions/0021-transaction-settings-and-tenant-limits.md) | トランザクションの防御（TV2、第 1 段の確認）を固定で有効にし、`transactional.id` の数と InitProducerId の頻度にテナントごとの上限を掛ける。2 相コミットは無効 |
| [0022](../decisions/0022-exactly-once-verification.md) | exactly-once の正しさは、Jepsen の形の txn のワークロードと Kafka Streams の長時間の試験で毎日確かめ、本家の版の更新の関門にする。本家で直っていない問題は既知の制約として文書に書く |

## 15. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E1 | `txn-namespace-poc` | 名前空間のパッチを通した `transactional.id`・`TxnOffsetCommit` で、Streams の exactly-once の代表のトポロジーが動く |
| E3 | `jepsen-txn-workload` | 11.1 節の Jepsen の txn のワークロードと障害の組み合わせ（耐久性の枠に載せる） |
| E5 | `transaction-feature-pinning` | `transaction.version=2`、確認の有効化、ブローカーの設定の固定と検査 |
| E5 | `transactional-id-limit` | コーディネーターのパーティションごとの上限と、`TRANSACTIONAL_ID_AUTHORIZATION_FAILED` |
| E5 | `init-producer-id-throttle` | InitProducerId の頻度の上限と `throttle_time_ms` |
| E5 | `txn-admin-api-namespacing` | DescribeTransactions・ListTransactions・DescribeProducers の名前空間と、PID の絞り込みの漏れの防止 |
| E5 | `streams-eos-soak` | 11.2 節の長時間の試験 |
| E5 | `delayed-endtxn-regression` | 遅れて届く `EndTxn` の再現と、TV2 での締め出しの確認 |
| E5 | `hanging-txn-detector` | 最も古い開いたトランザクションの経過時間の収集とアラート |
| E5 | `txn-known-limitations-doc` | 12 節の利用者向けの文書 |
| E11 | `txn-metrics-api` | テナント向け：進行中のトランザクションの数、中止の率、上限の使用率 |
| E12 | `hanging-txn-runbook` | ぶら下がったトランザクションの中止の手順 |

## 16. quality.md・runbooks・data-model への項目

### quality.md

- Jepsen の txn のワークロードの結果：書き込みの喪失、中止した読み取り、ちぎれたトランザクション 0 件（SC-2）。
- Streams の exactly-once の試験の結果：重複・欠落 0 件。
- トランザクションの produce の p99 を、普通の produce と分けて測る（`CONCURRENT_TRANSACTIONS` の再試行が含まれるため）。
- 最も古い開いたトランザクションの経過時間（パーティションごとの最大）。
- テナントごとの `transactional.id` の上限の使用率と、断った件数。InitProducerId の throttle の件数。
- クライアントの版ごとの、TV2 を使っている接続の割合。

### runbooks

- `hanging-transaction.md`：検出、影響の範囲（LSO、階層型の保存の停止）、`kafka-transactions.sh` での中止、テナントへの連絡。
- `transaction-coordinator-load.md`：`__transaction_state` の読み込みが遅いときの切り分け（ID の多いテナントの特定）。
- `txn-limit-exceeded.md`：テナントが上限に当たったときの確かめ方（再起動で ID が増えていないか、状態のディレクトリ）と、上書きの手順。

### data-model（索引への追加の提案）

| 置き場所 | 名前 | 中身 |
| --- | --- | --- |
| データ面（内部トピック） | `__transaction_state` | 本家。キーは接頭辞付きの `transactional.id` |
| データ面（内部トピック） | `__<brand>_quota_usage` | この領域が足す欄：テナントごと・コーディネーターのパーティションごとの生きている `transactional.id` の数（[multi-tenancy-and-quotas.md](multi-tenancy-and-quotas.md) の 7 節） |
| 制御面（Aurora） | `logical_cluster_limits` | この領域の欄：`max_transactional_ids`、`init_producer_id_rate`（表は [multi-tenancy-and-quotas.md](multi-tenancy-and-quotas.md) の 15 節） |
| メトリクスの時系列 | `txn_oldest_open_age_seconds` | `logical_cluster_id`、トピック（ハッシュ）、パーティション |

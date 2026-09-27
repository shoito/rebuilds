# Replication and durability: Kafka

複製の数と ISR、AZ への配置（rack）、リーダーの選出、fetch-from-follower、耐久性の監査、障害注入の方針の設計。前提の決定は、本家のブローカーを使うこと（[ADR-0001](../decisions/0001-upstream-brokers-and-stack.md)）、3 つの複製と階層型の保存（[ADR-0002](../decisions/0002-replicated-log-with-tiered-storage.md)）、KRaft（[ADR-0003](../decisions/0003-kraft-metadata-and-cluster-placement.md)）。この文書で決めたことは [ADR-0012](../decisions/0012-durability-settings-and-elr.md)〜[ADR-0014](../decisions/0014-durability-audit-and-fault-injection.md)。ディスクとログの回復は [broker-and-log-storage.md](broker-and-log-storage.md)、パーティションの配置の変更は [metadata-and-control.md](metadata-and-control.md) にある。

本家の振る舞いは、2026-09-27 に kafka.apache.org の文書と KIP で確かめた。Jepsen と Kora の記述は、同じ日に各報告と論文で確かめた。確かめられなかったものは「未検証」と書く。

## 1. 目的と範囲

- `acks=all` で成功を返した書き込みを、1 つのリージョンの中のどの 1 つの AZ が落ちても失わない（NFR-001）。
- 1 つの AZ の喪失で、produce と fetch を 1 分以内に続ける（NFR-009）。
- コンシューマーの読み取りで、AZ をまたぐ転送を減らす（NFR-010）。
- 「失っていない」ことを、テストと本番の監査で示し続ける（[intent.md](../intent.md) の SC-2）。

範囲に入れないもの：トランザクションと冪等なプロデューサーの意味（transactions-and-idempotence）、S3 の上のセグメントの耐久性（tiered-and-object-storage）、リージョンの災害復旧（infrastructure）。

## 2. 本家の形と既知の問題

| 項目 | 本家 | 出典（2026-09-27 に確認） |
| --- | --- | --- |
| 既定の値 | `default.replication.factor` 1、`min.insync.replicas` 1、`unclean.leader.election.enable` false、`replica.lag.time.max.ms` 30 秒 | [Broker Configs](https://kafka.apache.org/43/configuration/broker-configs/) |
| プロデューサーの既定 | 3.0 から、Java のクライアントの既定が `acks=all`、`enable.idempotence=true` | [KIP-679](https://cwiki.apache.org/confluence/display/KAFKA/KIP-679%3A+Producer+will+enable+the+strongest+delivery+guarantee+by+default) |
| ELR | ISR の外でも高水位までのデータを持つと保証された複製（ELR）を、リーダーの候補に残す。高水位は ISR が `min.insync.replicas` 以上のときだけ進む。4.0 で試験、4.1 で新しいクラスタの既定。有効にすると `min.insync.replicas` はクラスタの単位でだけ設定でき、ブローカーの単位の値は消える | [KIP-966](https://cwiki.apache.org/confluence/display/KAFKA/KIP-966%3A+Eligible+Leader+Replicas)、[Eligible Leader Replicas](https://kafka.apache.org/41/operations/eligible-leader-replicas/) |
| 不正な停止からの回復（KIP-966 の後半） | ログを調べて決まった手順でリーダーを選ぶ（`unclean.recovery.strategy`）。本家の版に入ったかは未検証 | KIP-966 |
| fetch-from-follower | 2.4 から。ブローカーの `replica.selector.class` に `RackAwareReplicaSelector`、クライアントの `client.rack`。フォロワーは高水位までを返す。遅れたフォロワーは `OFFSET_NOT_AVAILABLE` を返し、クライアントは再試行する。高水位の伝わりの分だけ遅延が増えうる | [KIP-392](https://cwiki.apache.org/confluence/display/KAFKA/KIP-392%3A+Allow+consumers+to+fetch+from+closest+replica)、[What's New in Apache Kafka 2.4](https://blogsarchive.apache.org/kafka/entry/what-s-new-in-apache1) |
| フラッシュ | 本家は既定でアプリの fsync をせず、耐久性を複製に任せる | [Hardware and OS](https://kafka.apache.org/43/operations/hardware-and-os/) |

既知の問題：

- **Jepsen: Kafka（2013-09、0.8 の前の設計）**：ISR がリーダー 1 つに縮んだまま成功を返し、そのリーダーが落ちると、遅れた複製がリーダーになって、成功を返した書き込みを失った（1,000 件の書き込みで 987 件が成功、うち 520 件を失った）。提言は、ISR の最小の大きさを持つこと（[Call me maybe: Kafka](https://aphyr.com/posts/293-call-me-maybe-kafka)）。これが後の `min.insync.replicas` と、unclean な選出の禁止につながった。
- **Jepsen: Redpanda 21.10.1（2022-04）**：Kafka の既定は、`acks=all` でも fsync の前に成功を返すので、ノードの喪失で書き込みを失いうると指摘した（[Jepsen: Redpanda 21.10.1](https://jepsen.io/analyses/redpanda-21.10.1)）。
- **Jepsen: Bufstream 0.1.0（2024-11）**：Kafka のプロトコルのトランザクションで、書き込みの喪失・中止した読み取り・ちぎれたトランザクション（KAFKA-17754）を報告した（[Jepsen: Bufstream 0.1.0](https://jepsen.io/analyses/bufstream-0.1.0)）。トランザクションの扱いは transactions-and-idempotence の領域。
- **Kora（VLDB 2023）**：複製が正しく動いていても、リーダーのストレージの破損でログの先頭を切り詰め、フォロワーも切り詰めて失った事例、階層型の保存のメタデータの食い違いによる喪失（テスト環境）、保持の時間の誤変更、`log-start-offset` の更新の競合を報告した。これに対し、整合性に関わるメタデータの変化を記録し、日次で不変条件を照合する監査を持つ（[Kora](https://vldb.org/pvldb/vol16/p3822-povzner.pdf) の 4.6 節と表 1）。

## 3. 耐久性の設定

[ADR-0012](../decisions/0012-durability-settings-and-elr.md)。

| 設定 | 値 | 単位 | テナント |
| --- | --- | --- | --- |
| `default.replication.factor` | 3 | ブローカー | 作成時の `-1` か `3` だけ（[ADR-0007](../decisions/0007-topic-config-allowlist.md)） |
| `min.insync.replicas` | 2 | クラスタ（ELR が求める） | `2` の指定だけ |
| `unclean.leader.election.enable` | false | クラスタ | `false` の指定だけ |
| `eligible.leader.replicas.version` | 1（有効） | フィーチャー | — |
| `broker.rack` | AZ ID（例：`apne1-az1`） | ブローカー | — |
| `replica.lag.time.max.ms` | 30000（本家の既定） | ブローカー | — |
| `num.replica.fetchers` | 4（仮。PoC で決める） | ブローカー | — |
| 内部のトピック（`__consumer_offsets`、`__transaction_state`、リモートのメタデータのトピック） | 複製 3、`min.insync.replicas` 2 | — | — |

- `broker.rack` は AZ の名前（`ap-northeast-1a`）ではなく AZ ID にする。AZ の名前はアカウントごとに物理の AZ への対応が違うため（[AZ IDs](https://docs.aws.amazon.com/ram/latest/userguide/working-with-az-ids.html)）。東京では `apne1-az1`・`apne1-az2`・`apne1-az4` に固定する（[ADR-0043](../decisions/0043-aws-accounts-network-and-eks-layout.md)）。
- 階層型の保存のメタデータのトピックの `min.insync.replicas` の既定は 4.3 で直された（KIP-1235。[4.3.0 の発表](https://kafka.apache.org/blog/2026/05/22/apache-kafka-4.3.0-release-announcement/)）。値は明示して 2 にする。

### 3.1 「成功」が意味すること

- `acks=all` の成功は、そのレコードが ISR の全ての複製のメモリー（ページキャッシュ）に届いたことを意味する。ISR は 2 つ以上で、それぞれ異なる AZ にある。ディスクへの同期は待たない（本家の既定）。
- 失う条件は、ISR の 2 つ以上の複製が、ディスクに書く前に同時に中身を失うこと（2 つ以上の AZ の同時の電源の喪失など）。この残りの危険を引き受け、NFR-001 の説明と利用者の文書に書く。
- 1 つの複製の不正な停止は、ELR で守る。末尾を失った複製は ISR と ELR から外れ、リーダーにならない（[broker-and-log-storage.md](broker-and-log-storage.md) の 6.2 節）。
- `acks=1`・`acks=0` の書き込みは、NFR-001 の対象外。ブローカーは受け付ける（互換）。Java のクライアントは 3.0 から既定が `acks=all` だが、他のクライアントの既定は違いうる（librdkafka の冪等の既定は無効と見られる。未検証）。利用者の文書で `acks=all` と冪等を勧める。

### 3.2 AZ の喪失の間の振る舞い

| 状態 | ISR | `acks=all` の produce | fetch |
| --- | --- | --- | --- |
| 平常 | 3 | 成功 | 成功 |
| 1 つの AZ を失う | 2 | 成功（2 ≥ 2） | 成功 |
| さらに別の AZ の複製を 1 つ失う | 1 | `NOT_ENOUGH_REPLICAS`。成功を返さない | 高水位までは成功 |
| ISR が 0（ELR は残る） | 0 | 失敗 | ELR の複製が戻ればリーダーになる |

- ELR を有効にすると、ISR が 2 未満の間は高水位が進まない。`acks=1` の書き込みは受け付けられても、ISR が戻るまでコンシューマーに見えない（KIP-966 の「厳密な min ISR」）。利用者の文書に書く。
- これは、耐久性を可用性より優先する選択である。

## 4. AZ への配置

- 1 つの物理クラスタのブローカーは、3 つの AZ に同数ずつ置く。
- 新しいパーティションは、KRaft のコントローラーの rack を考えた配置で、3 つの複製を 3 つの AZ に置く。
- 不変条件：**全てのパーティションの 3 つの複製は、異なる 3 つの AZ にある**。再配置（[metadata-and-control.md](metadata-and-control.md) の 4 節）はこれを破る計画を実行しない。監査（7 節）で毎日確かめる。
- 優先リーダー（複製の一覧の先頭）を、AZ とブローカーに均等に散らす。`auto.leader.rebalance.enable=true`（本家の既定）で、偏りを 5 分ごと（`leader.imbalance.check.interval.seconds` の既定 300）に直す。
- AZ の喪失の後、残りの 2 つの AZ だけで 3 つ目の複製を作ることはしない。3 つの AZ の不変条件を保ち、AZ が戻るのを待つ。長く戻らないときの判断は runbook で人が行う。

## 5. リーダーの選出

### 5.1 平常

- コントローラーは、ISR の中から、優先リーダーを先に選ぶ。ブローカーが `broker.session.timeout.ms`（既定 9 秒）の間ハートビートを送らないと、締め出して、そのブローカーのリーダーを移す（[Broker Configs](https://kafka.apache.org/43/configuration/broker-configs/)）。
- 1 つの AZ の喪失から、リーダーの移動の完了までの目標は 1 分以内（NFR-009）。9 秒の締め出しと選出で、多くは 30 秒以内の見込み。未検証（E3 で測る）。

### 5.2 unclean な選出の禁止

- `unclean.leader.election.enable=false`。ISR と ELR が空のパーティションは、ISR か ELR の複製が戻るまでオフラインになる。
- KIP-966 の後半（ログを調べて選ぶ不正な回復）は、本家の版に入ったことと、Jepsen の形のテストを確かめるまで使わない。
- 最後の手段として、ISR の外の複製を人の判断でリーダーにすることは、データの喪失を伴う。Dev のテックリードの承認と、テナントへの連絡を要件にし、runbook の手順でだけ行う。行ったら監査の記録に残す。

### 5.3 リーダーを外す（demotion）

- Kora は、ネットワークやストレージの劣化を見つけたブローカーから、全てのリーダーを移す「降格」を持つ。データを動かさないので速い（[Kora](https://vldb.org/pvldb/vol16/p3822-povzner.pdf) の 4.5 節）。
- この設計でも、ブローカーの遅延（要求の処理時間、I/O の待ち時間）が他のブローカーより大きく外れたら、データ面のエージェントがそのブローカーのリーダーを外す。やり方（複製の順序の入れ替えと優先リーダーの選出）は [metadata-and-control.md](metadata-and-control.md) の 5.3 節。
- 外したブローカーは、フォロワーとして ISR に残る。遅いフォロワーは `replica.lag.time.max.ms` で ISR から外れる。

## 6. fetch-from-follower

[ADR-0013](../decisions/0013-fetch-from-follower.md)。

- ブローカーの `replica.selector.class` を、本家の `RackAwareReplicaSelector` にする。自前の選び方は作らない。
- コンシューマーが `client.rack` に自分の AZ ID を設定すると、同じ AZ の、最も追いついた複製から読む。設定しないと、リーダーから読む（本家の振る舞い）。
- コンソールと文書で、各論理クラスタの AZ ID の一覧と、クライアントごとの設定の例を示す。主なクライアントの対応：Java（2.4 から）、librdkafka・franz-go・Sarama（設定の名前は各クライアントで違う。未検証）。
- フォロワーは高水位までしか返さない。高水位がフォロワーに伝わるまでの分、端から端の遅延が増える。NFR-004（p99 100ms）を、fetch-from-follower の有無で測って確かめる（未検証）。
- AZ をまたぐ転送が本当に減るかは、クライアントからブローカーまでの経路に依る。ブローカーのホスト名に AZ ID を入れ、NLB（cross-zone 無効）と Envoy が同じ AZ のブローカーにだけ送る形にした（[ADR-0044](../decisions/0044-nlb-sni-proxy-and-zonal-hostnames.md)、[infrastructure.md](infrastructure.md) の 5.2 節）。

## 7. 耐久性の監査

[ADR-0014](../decisions/0014-durability-audit-and-fault-injection.md)。Kora の監査（論文の 4.6.3 節）に倣う。考え方は、複雑で変わり続けるブローカーを、単純で変わりにくい規則で照合することである。

### 7.1 監査の事象

ブローカーとコントローラーは、整合性に関わるメタデータの変化を、監査の事象として出す。レコードの中身は含めない。

| 事象 | 中身 |
| --- | --- |
| `log_start_offset_advanced` | パーティション、前と後のオフセット、理由（保持の時間・大きさ、DeleteRecords、ローカルの保持）、そのときの保持の設定 |
| `log_truncated` | パーティション、複製、切り詰めた範囲、理由（リーダーのエポック、回復の切り詰め）、そのときの高水位 |
| `leader_elected` | パーティション、新旧のリーダー、エポック、選出の種類（ISR、ELR、優先、unclean） |
| `isr_elr_changed` | パーティション、前と後の ISR と ELR |
| `broker_unclean_shutdown` | ブローカー、エポック |
| `retention_config_changed` | トピック、設定の前後、変えた主体 |
| `remote_segment_copied`・`remote_segment_deleted` | パーティション、オフセットの範囲、セグメントの ID（tiered-and-object-storage の領域と一緒に定義） |

- 事象は、ブローカーのプラグインの中から、物理クラスタの内部のトピック `__<brand>_durability_audit`（テナントの名前空間の外。保持 3 日）に書き、データ面のエージェントが Firehose で log-archive の S3（Object Lock 1 年）へ送る。照合は S3 の上で行う（[ADR-0046](../decisions/0046-operator-telemetry-and-cardinality.md)、[observability.md](observability.md) の 1 節）。

### 7.2 不変条件

| ID | 不変条件 | 頻度 |
| --- | --- | --- |
| AUD-1 | `log-start-offset` の前進は、保持の設定（時間・大きさ）か DeleteRecords で説明できる。説明できない前進は 0 件 | 日次 |
| AUD-2 | どの複製も、それまでに観測した高水位以下のオフセットを切り詰めない | 日次 |
| AUD-3 | 閉じたセグメントの同じオフセットのバッチの CRC が、3 つの複製で一致する（抜き取りの照合） | 週次（全セグメントの 5% を無作為に。値は仮） |
| AUD-4 | 階層型の保存：`log-start-offset` からローカルの始まりまでの全てのオフセットが、リモートのメタデータにちょうど 1 回あり、S3 のオブジェクトがあり、大きさが一致する | 日次 |
| AUD-5 | 全てのパーティションの複製は 3 つで、異なる 3 つの AZ にある。クラスタの `min.insync.replicas` は 2、全てのトピックで unclean な選出は無効 | 日次（設定の変更の事象では即時） |
| AUD-6 | unclean な選出の事象は、runbook の記録と対になっている | 日次 |
| AUD-7 | カナリア：7.3 節の書き込みに、抜け・重複・順序の入れ替えがない | 常時 |

- 不一致はアラートにし、人を呼ぶ。Kora の論文が書くとおり、複製があるので、早く気づけば、壊れたリーダーを外してフォロワーに引き継がせ、データを救えることがある。
- 監査の結果（照合したパーティションの数、不一致の数）を quality.md の指標にする。

### 7.3 カナリア

- 物理クラスタごとに、運用の論理クラスタを 1 つ持ち、全てのブローカーにリーダーが散るようにパーティションを置く。
- 1 秒ごとに、連番を持つレコードを `acks=all`・冪等で書き、別のプロセスが `read_committed` で読み、抜け・重複・順序を確かめる。成功を返した連番が 5 分読めなければ、喪失の疑いとして人を呼ぶ。
- カナリアのレコードは合成のデータで、利用者のデータを含まない。produce と fetch の遅延は、外からの合成監視（observability の領域）と別に、ブローカーの内側の値として使う。

## 8. 障害注入（Jepsen の形）

[ADR-0014](../decisions/0014-durability-audit-and-fault-injection.md)。Jepsen の Kafka のワークロード（[jepsen.tests.kafka](https://jepsen-io.github.io/jepsen/jepsen.tests.kafka.html)）を、自社のブローカーの構成（SASL、名前空間、3 つの rack）に合わせて使う。

### 8.1 検出する異常

jepsen.tests.kafka の検査の名前で書く：`lost-write`、`duplicate`、`poll-skip`・`nonmonotonic`、`int-poll-skip`・`int-send-skip`、`nonmonotonic-send`、`g1a`（中止した読み取り）、`precommitted-read`、`poll-unseen`、G0 などの循環（Elle）。

### 8.2 合格の基準

- `acks=all` の書き込みについて、`lost-write`・`poll-unseen`（回復の後）・`nonmonotonic` が 0 件。冪等なプロデューサーで `duplicate` が 0 件。
- トランザクションの異常は、同じシードと同じ障害を、パッチなしの本家のブローカーにも与えて比べる。本家でも出るもの（KAFKA-17754 など）は「本家と同じ」として既知の制約の一覧に載せる。自社のブローカーだけで出るものは失敗にする。

### 8.3 障害の一覧

| 障害 | 作り方 |
| --- | --- |
| プロセスの強制終了・一時停止 | SIGKILL、SIGSTOP（ブローカー、コントローラー、コントローラーのリーダー） |
| ノードごとの停止 | ページキャッシュを失う停止。ディスクに書いていない末尾を失わせる |
| ネットワークの分断 | 多数派と少数派、1 つの AZ の孤立（その AZ のブローカーとコントローラーを全て切る）、リーダーだけの孤立、片方向の分断 |
| 時計のずれ | 前後への跳び、揺らぎ |
| ディスク | 遅延と I/O エラー（device-mapper）、ボリュームの喪失（空で起動） |
| 構成の変更 | 障害の間の再配置、ブローカーの cordon と退役、コントローラーの追加と削除（KIP-853） |
| ローリング更新 | 本家の版の更新とフィーチャーの版の更新を、障害と重ねる |
| 階層型の保存 | S3 への上げの途中の停止、リモートのメタデータの書き込みの失敗（Kora の表 1 の事例の再現） |
| 回帰の場面 | Jepsen の 2013 年の場面：ISR を 1 つに縮めてから、そのリーダーを止める。`min.insync.replicas=2` なので成功を返さないことを確かめる |

### 8.4 頻度と環境

| 頻度 | 中身 |
| --- | --- |
| `durability:sensitive` の PR ごと | 変更に関わる障害の組み合わせを 1 時間 |
| 日次 | 8.3 節の全ての障害 × queue と txn のワークロード |
| 本家の RC ごと | 日次と同じもの（[protocol-and-compatibility.md](protocol-and-compatibility.md) の 8 節） |

- 環境は、専用の検証の物理クラスタ（3 つの rack を 3 つの AZ に置く）。本番では障害注入をしない。本番では、四半期ごとに 1 つの AZ からリーダーを外す訓練（AZ の退避）を行う。

## 9. 障害と振る舞い

| 障害 | 起きること | 検知 | 回復 |
| --- | --- | --- | --- |
| 1 つのブローカーの喪失 | リーダーが移る。ISR が 2 のパーティションができる | ハートビートの途絶、ISR が 3 未満のパーティションの数 | ブローカーが戻れば追いつく。戻らなければ入れ替え（[broker-and-log-storage.md](broker-and-log-storage.md) の 6.4 節） |
| 1 つの AZ の喪失 | 全てのパーティションで ISR が 2。書き込みは続く | 同上、AZ ごとの到達性 | AZ が戻るのを待つ。3 つ目を他の AZ に作らない（4 節） |
| 2 つの AZ の喪失 | `acks=all` の書き込みが失敗する | `NOT_ENOUGH_REPLICAS` の件数 | 耐久性を優先して止める。リージョンの障害として扱う |
| ISR と ELR が空 | そのパーティションがオフライン | オフラインのパーティションの数 | 複製が戻るのを待つ。最後の手段は 5.2 節 |
| 遅いブローカー | そのブローカーのリーダーの遅延、フォロワーの ISR からの脱落 | 要求の処理時間の外れ値 | リーダーを外す（5.3 節） |
| フォロワーの遅れ（fetch-from-follower） | コンシューマーが `OFFSET_NOT_AVAILABLE` で再試行 | 件数 | 追いついた複製か、リーダーに移る（本家の振る舞い） |
| 監査の不一致 | 喪失か、監査の誤り | 7.2 節 | 人が調べる。喪失なら、壊れた複製を外し、テナントに連絡する |
| カナリアの抜け | 喪失の疑い | 7.3 節 | 最優先で調べる。同じ物理クラスタへの変更を止める |

## 10. セキュリティ

| 脅威 | 対応 |
| --- | --- |
| 耐久性の設定の改ざん（テナント・運用の誤り） | テナントには [ADR-0007](../decisions/0007-topic-config-allowlist.md)。運用のクラスタの設定の変更は、制御面の望ましい状態からだけ流し、AUD-5 で毎日照合する |
| unclean な選出の悪用・誤操作 | ElectLeaders はテナントに拒否（[ADR-0006](../decisions/0006-api-exposure-table-and-denial.md)）。運用では runbook と承認と監査の記録を要件にする |
| 監査の事象への利用者のデータの混入 | 事象はオフセット・範囲・ID・設定だけ。レコードの中身・キー・ヘッダーを入れない（[AGENTS.md](../../AGENTS.md)）。トピックの名前は内部の ID で書く |
| 監査の記録の改ざん | 監査の S3 のバケットは、書き込みだけの権限と Object Lock（保持の期間は security-and-acls の領域） |
| カナリアの論理クラスタの悪用 | 運用の論理クラスタの API キーは、カナリアのプロセスだけが持つ |

この領域の変更は `durability:sensitive` のラベルを付ける（[AGENTS.md](../../AGENTS.md)）。

## 11. テスト

### 11.1 耐久性の性質

- 任意の障害の列（8.3 節）の下で、`acks=all` で成功を返したレコードは、回復の後に同じオフセットで読める（PROP の候補）。
- 任意の障害の列の下で、1 つのパーティションの中のオフセットの順序は変わらない。
- 任意の障害の列の下で、冪等なプロデューサーの再送は、重複を生まない。
- 任意の再配置の列の後で、全てのパーティションの 3 つの複製は異なる 3 つの AZ にある。
- ISR が 2 未満の間に、`acks=all` の produce は成功を返さない。

### 11.2 障害の注入

- 8 節。

### 11.3 決定表

- 3.2 節の表（ISR の大きさ × `acks` × produce と fetch の結果）。
- 5 節の選出の種類（ISR、ELR、優先、unclean の禁止）。

### 11.4 互換性

- 差分テスト：固定した設定の違いだけが「許された違い」に出る（[protocol-and-compatibility.md](protocol-and-compatibility.md) の 7 節）。
- クライアントの行列：`client.rack` を設定したコンシューマーが、同じ AZ の複製から読むこと（対応するクライアントで）。

## 12. ADR

| ADR | 決定 |
| --- | --- |
| [0012](../decisions/0012-durability-settings-and-elr.md) | 複製 3・AZ ID の rack・クラスタの `min.insync.replicas=2`・unclean な選出の禁止・ELR の有効を固定する。アプリの fsync は本家の既定のまま、残りの危険を文書に書く |
| [0013](../decisions/0013-fetch-from-follower.md) | fetch-from-follower は本家の `RackAwareReplicaSelector` で有効にし、クライアントの `client.rack`（AZ ID）に任せる |
| [0014](../decisions/0014-durability-audit-and-fault-injection.md) | Kora の形の耐久性の監査（事象の記録と日次の不変条件の照合）とカナリアを本番で持ち、Jepsen の形の障害注入を PR ごとと日次で回す |

## 13. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E1 | `durability-config-baseline` | 3 節の設定、ELR の有効、AZ ID の rack |
| E1 | `jepsen-harness` | jepsen.tests.kafka を SASL と名前空間の構成で動かす。本家との同じシードの比較 |
| E3 | `fault-injection-matrix` | 8.3 節の障害の一覧と、PR ごと・日次の実行 |
| E3 | `durability-audit-events` | 7.1 節の事象を出すプラグインと、集める経路 |
| E3 | `durability-audit-checks` | 7.2 節の AUD-1〜6 の日次の照合とアラート |
| E3 | `canary-producer-consumer` | 7.3 節のカナリア |
| E3 | `fetch-from-follower` | `RackAwareReplicaSelector`、AZ ID の表示、遅延の測定 |
| E3 | `az-loss-drill` | AZ の喪失の振る舞い（3.2 節）の検証と、AZ の退避の訓練の手順 |
| E5 | `txn-anomaly-baseline` | トランザクションの異常を本家と比べ、既知の制約の一覧を作る（transactions-and-idempotence と一緒に） |
| E10 | `client-rack-guidance` | コンソールと文書の AZ ID と `client.rack` の案内 |
| E12 | `durability-dashboards` | ISR・ELR・オフラインのパーティション・監査・カナリアのダッシュボードとアラート |

## 14. 未解決の問い

### 決定（2026-09-27、既定案）

- **ELR**：有効にする。`min.insync.replicas` はクラスタの単位で 2。
- **アプリの fsync**：本家の既定（しない）。定期のフラッシュは回復の時間のためで、耐久性のためではない（[broker-and-log-storage.md](broker-and-log-storage.md) の 6.3 節）。
- **AZ の喪失の後の 3 つ目の複製**：作らない。
- **fetch-from-follower**：本家の `RackAwareReplicaSelector`。クライアントの設定に任せる。
- **監査**：AUD-1〜7。AUD-3 は週次で 5% の抜き取り。事象は内部のトピック `__<brand>_durability_audit` からエージェントが S3 へ送る（統合の工程で、他の `__<brand>_` の内部のトピックと揃えた）。
- **本番での障害注入**：しない。AZ の退避の訓練は四半期ごと。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| クライアントが `client.rack` を設定しないときに、接続の経路から AZ を推定する選び方を作るか | infrastructure の領域の経路の設計の後（E3） |
| KIP-966 の後半（不正な回復）の本家での状態と、使うか | 本家の版で確かめる（E3） |
| `num.replica.fetchers` とフォロワーの取得の大きさ | E1 の PoC |
| AUD-3 の抜き取りの割合と、全数の照合の費用 | E3 の実測 |
| 1 つの AZ だけの安い層（Kora にある）を出すか | MVP では出さない（ADR-0004）。S2 で metrics-and-billing と一緒に |

## 15. quality.md・runbooks・data-model への項目

### quality.md

- 受け付けた書き込みの喪失の件数（障害注入と本番の監査、カナリア。目標 0。SC-2）。
- ISR が 3 未満のパーティションの数と時間、オフラインのパーティションの数。
- AZ の喪失からリーダーの移動の完了までの時間（目標 1 分以内）。
- 監査の照合の範囲（パーティションの数）と不一致の件数。
- fetch-from-follower の利用率（同じ AZ の複製から読んだバイトの割合）と、端から端の遅延の差。
- Jepsen の形のテストの実行の数と、本家と比べた既知の制約の一覧の件数。

### runbooks

- `runbooks/az-loss.md`：AZ を失ったときの確かめ方、待つか動くかの判断、戻ったときの追いつきの見守り。
- `runbooks/offline-partitions.md`：ISR と ELR が空のパーティションの扱い。人の判断の unclean な選出の手順と承認と記録。
- `runbooks/durability-audit-mismatch.md`：AUD-1〜6 の不一致の調べ方と、壊れた複製の外し方、テナントへの連絡。
- `runbooks/canary-gap.md`：カナリアの抜けの調べ方と、物理クラスタの変更の凍結。
- `runbooks/slow-broker-demotion.md`：遅いブローカーからリーダーを外す判断と戻し方。

### data-model（索引への追加の提案）

| テーブル・記録 | 中身 |
| --- | --- |
| `durability_audit_events`（S3 の上の表） | 7.1 節の事象。`physical_cluster_id`、`topic_id`、`partition`、`broker_id`、`event_type`、値、時刻。レコードの中身を含めない |
| `durability_audit_results`（制御面） | 照合の日、不変条件の ID、照合した数、不一致の数、状態 |
| `durability_incidents`（制御面） | 不一致・カナリアの抜けの調査の記録、影響したテナント、対応 |
| `unclean_elections`（制御面） | パーティション、承認者、理由、失った範囲の見積もり、テナントへの連絡の時刻 |
| KRaft の記録（索引だけ） | PartitionRecord・PartitionChangeRecord の ISR・ELR・リーダー・エポック、BrokerRegistration の rack |

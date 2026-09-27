# Broker and log storage: Kafka

ブローカーのノードの構成、ログのセグメントと索引、保持（retention）と圧縮（compaction）、ローカルのディスク（EBS）の選定と容量の管理、不正な停止（unclean shutdown）の後のログの回復の設計。前提の決定は、本家のブローカーを使うこと（[ADR-0001](../decisions/0001-upstream-brokers-and-stack.md)）、3 つの複製と階層型の保存（[ADR-0002](../decisions/0002-replicated-log-with-tiered-storage.md)）。この文書で決めたことは [ADR-0009](../decisions/0009-ebs-gp3-single-log-volume.md)〜[ADR-0011](../decisions/0011-log-recovery-and-broker-replacement.md)。複製と ISR は [replication-and-durability.md](replication-and-durability.md)、S3 への上げ方は tiered-and-object-storage の領域、台数と費用は capacity の領域で扱う。

本家の振る舞いは、2026-09-27 に kafka.apache.org の 4.3 の文書と KIP で確かめた。AWS の値は、同じ日に docs.aws.amazon.com で確かめた。確かめられなかったものは「未検証」と書く。

## 1. 目的と範囲

- 受け付けた書き込みを、ローカルのディスクに正しく並べ、読めるようにする（オフセットの順序、索引）。
- 保持と圧縮で、テナントの指定どおりにデータを消し、指定より早く消さない。
- ディスクを溢れさせない。溢れそうなときに、書き込みを失わずに逃がす手段を持つ。
- ブローカーが不正に止まっても、ログを壊さずに戻す。戻す時間の上限を持つ。

範囲に入れないもの：複製の数・ISR・リーダーの選出（replication-and-durability）、S3 のキーの設計とリモートのメタデータ（tiered-and-object-storage）、インスタンスの型と台数（capacity、infrastructure）。

## 2. ブローカーのノード

### 2.1 形

- EKS の 1 つのノードに、ブローカーを 1 つだけ置く。ページキャッシュとネットワークを他と分け合わない。
- ブローカーごとに、ログ用の EBS gp3 を 1 本付ける（[ADR-0009](../decisions/0009-ebs-gp3-single-log-volume.md)）。`log.dirs` は 1 つ。`metadata.log.dir` も同じボリュームの別のディレクトリに置く。
- ボリュームは、ブローカーの ID に結び付け、ノードを入れ替えても同じ AZ の新しいノードに付け替える（Kubernetes の永続ボリューム。作り方は control-plane-and-provisioning の領域）。
- ファイルシステムは XFS、`noatime` で載せる。本家は XFS を勧め、どのファイルシステムでも `noatime` を勧める（[Hardware and OS](https://kafka.apache.org/43/operations/hardware-and-os/)）。

### 2.2 OS と JVM

| 項目 | 値 | 理由 |
| --- | --- | --- |
| ファイル記述子の上限 | 1,048,576 | 本家は「少なくとも 100,000」を出発点に勧める（Hardware and OS）。セグメントを小さくするので多めにする |
| `vm.max_map_count` | 262,144 | 本家の既定の約 65,535 では、索引の mmap で足りなくなる。本家の文書は、5 万のパーティションで 10 万の mmap になり、落ちうると書いている（同上） |
| `vm.swappiness` | 1 | ページキャッシュを優先する。本家の 4.3 の Hardware and OS には `vm.swappiness` の推奨の値がない（2026-09-27 に確認）ので、本システムの値として持つ |
| JVM のヒープ | 6 GiB（仮） | 残りのメモリーをページキャッシュに回す。本家の文書は、メモリーを「書き込みの速さ × 30 秒」分のキャッシュで見積もる（同上）。ヒープの大きさは E1 の `broker-node-baseline` で決める（未検証） |
| アプリのフラッシュ | 本家の既定（アプリからの fsync なし）。ただし 6.3 節の定期のフラッシュを PoC で評価する | 本家は既定のフラッシュの設定を勧め、「失った節は複製から戻る」ので耐久性にディスクへの同期は要らないとする（同上）。耐久性の議論は [replication-and-durability.md](replication-and-durability.md) の 3 節 |

## 3. セグメントと索引

### 3.1 ディスクの上の形

```
/var/lib/<brand>/data/                         # log.dirs（1 つ）
  meta.properties                              # ノードの ID、ディレクトリの ID（KRaft）
  recovery-point-offset-checkpoint             # パーティションごとの回復の起点
  log-start-offset-checkpoint
  replication-offset-checkpoint                # 高水位（high watermark）
  .kafka_cleanshutdown                         # 正しく止まったときの印（KIP-966 のブローカーのエポックを含む）
  <内部のトピックの名前>-<パーティション>/
    00000000000000000000.log                   # セグメント。名前は最初のオフセット
    00000000000000000000.index                 # オフセットの索引（疎、mmap）
    00000000000000000000.timeindex             # 時刻の索引（疎、mmap）
    00000000000000000000.txnindex              # 中止したトランザクションの索引
    00000000000000000000.snapshot              # プロデューサーの状態
    leader-epoch-checkpoint
    partition.metadata                         # トピックの ID
  __cluster_metadata-0/                        # KRaft のメタデータのログの写し（metadata.log.dir）
```

- ファイル名と索引の形は本家のまま（[Log](https://kafka.apache.org/43/implementation/log/)）。ファイルとチェックポイントの名前は、本家のソースの名前による（例：`cleaner-offset-checkpoint` は [LogCleanerManager.java](https://github.com/apache/kafka/blob/4.3/storage/src/main/java/org/apache/kafka/storage/internals/log/LogCleanerManager.java)、2026-09-27 に確認）。
- ディレクトリ名は、名前空間のパッチが付けた内部のトピックの名前になる。テナントのトピックの名前を含むので、ディレクトリの一覧をログに出さない（10 節）。

### 3.2 索引

- オフセットの索引と時刻の索引は疎で、`index.interval.bytes`（既定 4096）ごとに 1 つ項目を足す。1 つのセグメントの索引の上限は `segment.index.bytes`（既定 10 MiB）。いずれも本家の既定のまま、テナントに変えさせない（[protocol-and-compatibility.md](protocol-and-compatibility.md) の 5 節）。
- 索引は mmap する。閉じたセグメントの索引も、読まれれば mmap する。ファイル記述子と mmap の上限は 2.2 節。

### 3.3 セグメントの大きさと切り替え

[ADR-0007](../decisions/0007-topic-config-allowlist.md)、[ADR-0010](../decisions/0010-segment-retention-and-compaction-defaults.md)。

| 設定 | 本家の既定 | この設計 | 理由 |
| --- | --- | --- | --- |
| `log.segment.bytes`（トピックでは `segment.bytes`） | 1 GiB | 256 MiB（テナントは 64 MiB〜1 GiB） | S3 に上がるのは閉じたセグメントだけ。大きいと、ローカルに残る量と、上がるまでの遅れが増える |
| `log.roll.ms`（`segment.ms`） | 7 日 | 1 時間（テナントは 10 分〜7 日） | 書き込みの少ないパーティションのセグメントが 7 日閉じないと、S3 と大阪の写しに 7 日上がらない（NFR-009 の S1 の RPO に効く） |
| `log.roll.jitter.ms` | 0 | 5 分 | 多数のパーティションが同じ時刻に切り替わり、S3 への上げが集中するのを避ける。本家の既定は `log.roll.jitter.hours=0`（[Broker Configs](https://kafka.apache.org/43/configuration/broker-configs/)、2026-09-27 に確認）。効果は未検証で、E3 の `segment-and-retention-defaults` で測る |

- セグメントは、大きさ、時間、索引の満杯、オフセットの桁あふれのいずれかで切り替わる（本家）。
- 見積もり（S1、仮）：1 つのブローカーに 2,000 の複製、ローカルの保持 6 時間、1 時間ごとの切り替えなら、ローカルのセグメントは約 1.4 万、ファイルは約 7 万、mmap は約 3 万。2.2 節の上限に収まる。ローカルの保持は 6 時間（[ADR-0019](../decisions/0019-tiered-storage-lifecycle-and-dr-copy.md)）。

## 4. 保持と圧縮

### 4.1 時間と大きさの保持

- 保持の検査は `log.retention.check.interval.ms`（既定 5 分）ごと。消すのは閉じたセグメントだけで、書き込み中のセグメントは消さない（本家）。
- 階層型の保存のトピックでは、ローカルは `local.retention.ms`・`local.retention.bytes` で消し、全体は `retention.ms`・`retention.bytes` で消す。ローカルのセグメントは、S3 に上げ終わるまで消さない（[Tiered Storage](https://kafka.apache.org/43/operations/tiered-storage/)）。
- `retention.bytes` はパーティションごとの上限（本家）。テナントの文書で、トピック全体の上限ではないことを書く。
- 保持による `log-start-offset` の前進は、耐久性の監査の対象にする。Kora は、動的な設定の更新の不具合で保持の時間が勝手に変わった事例と、`log-start-offset` の更新の競合でレコードを早く消した事例を報告している（[Kora](https://vldb.org/pvldb/vol16/p3822-povzner.pdf) の表 1）。監査の中身は [replication-and-durability.md](replication-and-durability.md) の 7 節。

### 4.2 圧縮

[ADR-0010](../decisions/0010-segment-retention-and-compaction-defaults.md)。

| 設定 | 本家の既定 | この設計 |
| --- | --- | --- |
| `log.cleaner.threads` | 1 | 4 |
| `log.cleaner.dedupe.buffer.size` | 134217728（128 MiB。全スレッドの合計） | 512 MiB |
| `log.cleaner.io.max.bytes.per.second` | 無制限（`Double.MAX_VALUE`。[Broker Configs](https://kafka.apache.org/43/configuration/broker-configs/)、2026-09-27 に確認） | 100 MiB/秒（produce と fetch の I/O を守る。PoC で決める） |
| `log.cleaner.min.cleanable.ratio` | 0.5 | 本家のまま（テナントは変えられない） |
| `log.cleaner.delete.retention.ms` | 1 日 | 本家のまま（テナントは `delete.retention.ms` を変えられる） |

- クリーナーのスレッドが例外で止まると、圧縮が進まず、ディスクが増え続ける。`time-since-last-run-ms`・`uncleanable-partitions-count`・`max-dirty-percent`（`kafka.log:type=LogCleanerManager`）と `DeadThreadCount`（`kafka.log:type=LogCleaner`）を監視する。名前は本家の 4.3 のソースで確かめた（[LogCleanerManager.java](https://github.com/apache/kafka/blob/4.3/storage/src/main/java/org/apache/kafka/storage/internals/log/LogCleanerManager.java)、[LogCleaner.java](https://github.com/apache/kafka/blob/4.3/storage/src/main/java/org/apache/kafka/storage/internals/log/LogCleaner.java)、2026-09-27 に確認。4.3 の Monitoring の文書には載っていない）。
- `__consumer_offsets` と `__transaction_state` は圧縮のトピックで、全てのテナントが分け合う。大きさの見積もりは consumer-groups・transactions-and-idempotence の領域と合わせる。

### 4.3 圧縮のトピックは S3 に上がらない

- 本家の階層型の保存は、圧縮のトピックに対応しない（[Tiered Storage](https://kafka.apache.org/43/operations/tiered-storage/) の Limitations）。圧縮のトピック（Kafka Streams の changelog を含む）は、全てのデータがローカルの 3 つの複製に残る。
- そこで、論理クラスタごとに「圧縮のトピックのローカルの量」の上限を掛ける。上限は Basic 50 GiB、Standard の CU あたり 100 GiB（複製の前）で、超えたら圧縮のトピックへの書き込みを throttle する（[multi-tenancy-and-quotas.md](multi-tenancy-and-quotas.md) の 5・6 節）。値は未検証で、E7 の `compacted-size-enforcement` の負荷試験で見直す。
- 階層型の保存の大阪への写し（S1 の災害復旧）にも、圧縮のトピックは入らない。NFR-009 の説明に書く。

## 5. ローカルのディスク

### 5.1 選定

[ADR-0009](../decisions/0009-ebs-gp3-single-log-volume.md)。値は AWS の文書による（2026-09-27 に確認）。

| 候補 | 性能 | 耐久性 | 扱い |
| --- | --- | --- | --- |
| EBS gp3 | 1 GiB〜64 TiB。基本 3,000 IOPS・125 MiB/秒、最大 80,000 IOPS・2,000 MiB/秒（IOPS は 500/GiB まで、スループットは IOPS あたり 0.25 MiB/秒まで）。1 桁 ms の遅延。バーストなし（[gp3](https://docs.aws.amazon.com/ebs/latest/userguide/general-purpose.html)） | 年間故障率 0.2% 以下 | **採用** |
| EBS io2 Block Express | 最大 64 TiB、256,000 IOPS、4,000 MiB/秒。16 KiB の I/O で平均 500 µs 未満（[io2](https://docs.aws.amazon.com/ebs/latest/userguide/provisioned-iops.html)） | 年間故障率 0.001% 以下 | 採らない。Kafka の書き込みはページキャッシュに入り、ディスクの遅延は produce の遅延に直接効かない。耐久性は 3 つの AZ の複製で持つ。費用に見合わない |
| インスタンスストア（NVMe） | 速い | インスタンスの停止で消える | 採らない。ノードの入れ替えのたびに、ローカルの全量を複製し直す |
| EBS st1（HDD） | 順次の読み書き向け | — | 採らない。遅れたコンシューマーの読み取りと索引の参照で、ランダムな I/O が出る |

- gp3 は、容量と IOPS とスループットを別々に決められる。ブローカーの書き込みの量から、スループットを先に決める。
- Elastic Volumes で、止めずに大きくできる。ただし、同じボリュームの次の変更まで 6 時間以上空ける必要があり、小さくはできない（[Modify a volume](https://docs.aws.amazon.com/ebs/latest/userguide/ebs-modify-volume.html)）。この設計では、Strimzi の管理の下にあるので、EBS を直接変えず、KafkaNodePool の `storage.size` を通して広げる（5.3 節）。

### 5.2 大きさの見積もり

ボリュームの容量とスループットは、次の式で出す。値は capacity の領域が持つ。

```
容量 = 設計点のブローカーの書き込み（複製を含む）×（ローカルの保持 ＋ segment.ms）
     + 圧縮のトピックの量
     を 0.85 で割る（設計点で 85%。平均の負荷ではおおむね 60% 以下）

スループット = 書き込み（複製を含む）
           + ページキャッシュに当たらない読み取り（遅れたコンシューマー、S3 への上げ、再配置の送り出し、ログの回復）
           ただし、型の EBS の基準の帯域を上限にする
```

例（[capacity.md](capacity.md) の 4 節。Standard の r8g.4xlarge、設計点 W = 80 MB/秒）：ブローカーの書き込みは複製を含めて 3W = 240 MB/秒。ローカルの保持 6 時間＋`segment.ms` 1 時間で約 6.0 TB。圧縮のトピック 1 TiB を足し、設計点で 85% になるように割ると 8 TiB（平均の負荷ではおおむね 60% 以下）。スループットは 4.6W ≒ 370 MB/秒で、**型の EBS の基準の帯域（r8g.4xlarge で 625 MB/秒）を上限にする**。買うのは 600 MiB/秒・6,000 IOPS。これを超えて買っても、インスタンスの側で使えない。回復と再配置の読み取りは、この帯域の中で throttle する。

### 5.3 容量の管理

| 使用率 | 動き |
| --- | --- |
| 70% | 警告。capacity の見直しの対象にする |
| 75% | データ面のエージェントが、Strimzi の KafkaNodePool の `storage.size` を 25% 大きくし、Strimzi が PVC を広げる（6 時間に 1 回まで。EBS を直接変えない。AZ ごとのプールの全台が一緒に広がる。[control-plane-and-provisioning.md](control-plane-and-provisioning.md) の 7.3 節、[ADR-0032](../decisions/0032-strimzi-for-physical-clusters.md)） |
| 85% | 階層型の保存のトピックの `local.retention.ms` を、ブローカーの設定の既定で一時的に短くする（S3 に上げ終わったセグメントだけが消える。データは失わない）。人を呼ぶ |
| 90% | そのブローカーにパーティションを置かない（cordon。[metadata-and-control.md](metadata-and-control.md) の 5 節）。パーティションを他のブローカーへ移す |
| 95% | そのブローカーのリーダーを持つテナントの produce のクォータを絞る（背圧。multi-tenancy-and-quotas の領域） |

- ディスクが満杯になると、ブローカーはログのディレクトリを失い、`log.dirs` が 1 つなので止まる（本家の 4.3 の `LogManager` は、全てのログのディレクトリが失敗すると `Exit.halt(1)` で止まる。メタデータのログのディレクトリの失敗でも止まる。[LogManager.scala](https://github.com/apache/kafka/blob/4.3/core/src/main/scala/kafka/log/LogManager.scala)、[ReplicaManager.scala](https://github.com/apache/kafka/blob/4.3/core/src/main/scala/kafka/server/ReplicaManager.scala)、2026-09-27 に確認）。止まる前に 85% と 90% で逃がす。
- S3 への上げが止まる（S3 の障害、RemoteStorageManager の不具合）と、ローカルが消えなくなる。上げの遅れ（最古の上げていないセグメントの経過時間）を、tiered-and-object-storage の領域と一緒に監視する。

## 6. ログの回復

[ADR-0011](../decisions/0011-log-recovery-and-broker-replacement.md)。

### 6.1 正しい停止

- `controlled.shutdown.enable=true`（本家の既定）。止める前に、そのブローカーのリーダーを他へ移す。
- 止まるときに、クリーンな停止の印を書く。次の起動では、ログの回復を飛ばす。
- ローリング更新は、1 つの AZ の中で 1 台ずつ、前の台が全ての ISR に戻ってから次へ進む（delivery の領域。Kora も、更新したブローカーが複製の面で戻ったことを確かめてから、次の組へ進む。[Kora](https://vldb.org/pvldb/vol16/p3822-povzner.pdf) の 4.7 節）。

### 6.2 不正な停止（unclean shutdown）

プロセスの強制終了、ノードの停止、カーネルのパニックのとき。

```
1. ブローカーが起動する。クリーンな停止の印がない
2. パーティションごとに、recovery-point-offset-checkpoint より後のセグメントを読み直す
   - 各バッチの CRC と長さを確かめ、壊れたところで切り詰める（本家の Log の記述）
   - 索引とプロデューサーの状態を作り直す
   - num.recovery.threads.per.data.dir のスレッドで並行に行う
3. コントローラーに登録する。PreviousBrokerEpoch が合わないので、コントローラーは
   不正な停止と判定し、このブローカーを ISR と ELR から外す（KIP-966）
4. フォロワーとして、リーダーのエポックでの切り詰め（OffsetForLeaderEpoch）をして追いつく
5. 追いついたら ISR に戻る。リーダーの偏りは、自動のリーダーの再均衡で戻る
```

- 3 が要である。ディスクに書かれていなかった末尾を失ったブローカーが、最後の ISR として選ばれ、他の複製を切り詰めさせる事故（「最後に残った複製」の問題）を、ELR が防ぐ（[KIP-966](https://cwiki.apache.org/confluence/display/KAFKA/KIP-966%3A+Eligible+Leader+Replicas)）。ELR は 4.1 で新しいクラスタの既定になった（[Eligible Leader Replicas](https://kafka.apache.org/41/operations/eligible-leader-replicas/)）。設定は [replication-and-durability.md](replication-and-durability.md) の 3 節。
- `num.recovery.threads.per.data.dir` は、本家の既定 2 から、ノードの vCPU の数に上げる。

### 6.3 回復の時間の上限

- アプリの fsync がないので、回復の起点は、セグメントの切り替え時のフラッシュでしか進まない（切り替えで古いセグメントを非同期にフラッシュし、回復の起点を新しいセグメントの先頭にする。定期のフラッシュは `log.flush.scheduler.interval.ms` の既定が `Long.MAX_VALUE` で動かない。[UnifiedLog.java](https://github.com/apache/kafka/blob/4.3/storage/src/main/java/org/apache/kafka/storage/internals/log/UnifiedLog.java)、[Broker Configs](https://kafka.apache.org/43/configuration/broker-configs/)、2026-09-27 に確認）。回復で読み直す量は、各パーティションの書き込み中のセグメントの合計で、最悪で `log.roll.ms` の間の書き込み全部になる。5.2 節の例では、最悪で `segment.ms` の間の書き込みの約 860 GB（240 MB/秒 × 1 時間）で、EBS の基準の帯域（625 MB/秒）で読んでも 20 分を超える。
- 目標：不正な停止からの回復（2 の完了まで）を、p99 で 5 分以内にする。Kora も、ブローカーの再起動の重い部分としてログの回復を挙げている（論文の 4.7 節）。
- 手段の候補は 2 つ。E1 の PoC で、回復の時間と produce の遅延への影響を測って決める。
  - a. 定期のフラッシュ：`log.flush.scheduler.interval.ms=60000` と `log.flush.interval.ms=300000` で、各パーティションを 5 分ごとに同期し、回復の起点を進める。OS の書き戻しで多くは既にディスクにあるので、同期の費用は小さい見込み（未検証。E1 の `log-recovery-poc` で測る）。
  - b. 回復が上限を超えそうなら、そのブローカーのローカルのデータを捨て、空のブローカーとして複製し直す（6.4 節）。
- 既定案は a。b は a で足りないときの手段として runbook に置く。

### 6.4 ボリュームを失ったとき

- EBS のボリュームが壊れた・失われたときは、同じブローカーの ID で、空の新しいボリュームを付けて起動する。KRaft はディレクトリの ID で新しいディレクトリと分かる。
- 空のフォロワーは、本家の既定ではログの始まりから複製し直す。4.3 の KIP-1023（`follower.fetch.last.tiered.offset.enable`）を有効にすると、S3 に上がった最後のオフセットから複製を始め、ローカルの末尾だけを移す（[KIP-1023](https://cwiki.apache.org/confluence/display/KAFKA/KIP-1023%3A+Follower+fetch+from+tiered+offset)、[4.3.0 の発表](https://kafka.apache.org/blog/2026/05/22/apache-kafka-4.3.0-release-announcement/)）。
- KIP-1023 は 4.3 で入ったばかりで、既定は無効。こうして戻したフォロワーがリーダーになると、S3 から読む量が増える（KIP の本文が認めている）。E3（耐久性）と E4（階層型の保存）で、Jepsen の形のテストと性能のテストを通してから有効にする（tiered-and-object-storage の領域と同じ条件）。

## 7. 障害と振る舞い

| 障害 | 起きること | 検知 | 回復 |
| --- | --- | --- | --- |
| ブローカーのプロセスの強制終了 | そのブローカーのリーダーが移る（`broker.session.timeout.ms` 既定 9 秒で締め出し）。再起動でログの回復 | ハートビートの途絶、再起動の回数 | 6.2 節。回復の時間を監視 |
| ノード（EC2）の喪失 | 同上。ボリュームは残る | 同上 | 同じ AZ の新しいノードにボリュームを付け替える |
| EBS のボリュームの喪失・破損 | そのブローカーの全ての複製を失う。他の 2 つの AZ の複製は残る | I/O エラー、ログのディレクトリの失敗 | 6.4 節。空で起動して複製し直す |
| EBS の性能の低下（遅延の増加） | そのブローカーがリーダーのパーティションの produce が遅れる。フォロワーなら ISR から外れうる | I/O の待ち時間、要求の処理時間の他のブローカーとの比較 | リーダーを外す（[replication-and-durability.md](replication-and-durability.md) の 5.3 節）。直らなければノードとボリュームを入れ替える |
| ディスクの逼迫 | 書き込みが止まりうる | 使用率 | 5.3 節の段階の対応 |
| クリーナーのスレッドの停止 | 圧縮のトピックが増え続ける | クリーナーのメトリクス | ブローカーを再起動。原因のパーティションを調べる |
| 保持の誤作動（早すぎる削除） | 利用者のデータが消える | 耐久性の監査（`log-start-offset` の前進と保持の設定の照合） | 階層型の保存のバックアップから戻せる範囲で戻す（tiered-and-object-storage の領域）。事後の報告 |
| 回復の時間の超過 | ブローカーが長く戻らない。その間、複製が 2 つで動く | 回復の経過時間 | 6.3 節の b |

## 8. セキュリティ

| 脅威 | 対応 |
| --- | --- |
| ディスクの中身の持ち出し | EBS を物理クラスタごとの顧客管理のキー（CMK）で暗号化する。StorageClass の `kmsKeyId` で指定し、アカウントの既定のキー（`aws/ebs`）は使わない（[ADR-0030](../decisions/0030-encryption-and-audit-logs.md)、[security-and-acls.md](security-and-acls.md) の 6.2 節）。スナップショットは取らない（耐久性は複製と S3 で持つ） |
| ノードへのログインでのデータの閲覧 | ブローカーのノードへの対話的なログインを止め、緊急時の手順（break-glass）に限る。`kafka-dump-log.sh` などの道具をブローカーのイメージに入れない |
| ディレクトリ名からのトピックの名前の漏えい | ディレクトリの一覧、ファイルのパスを運用のログに出さない。出すときは内部のトピックの ID にする |
| 消したトピックのデータの残り | 本家はトピックの削除で、ファイルを消す前に `file.delete.delay.ms`（既定 60 秒）待つ。EBS の解放したブロックは暗号化されている。ボリュームを捨てるときは、ボリュームごと消す |
| ヒープダンプへのレコードの混入 | ヒープダンプの自動の取得を無効にし、取るときは暗号化した場所に置き、保持を 7 日に限る |

この領域の変更のうち、保持・圧縮・回復に触れるものは `durability:sensitive` のラベルを付ける（[AGENTS.md](../../AGENTS.md)）。

## 9. テスト

### 9.1 耐久性の性質

- 任意の書き込みと停止（正しい停止・強制終了）の列の後で、`acks=all` で成功を返したレコードが、同じオフセットで読める。
- 任意の保持の設定と時間の経過で、`log-start-offset` は、保持の条件を満たすセグメントの境界より先に進まない（早く消さない）。
- 任意の圧縮の実行の後で、各キーの最新の値（と、`delete.retention.ms` の間の墓標）が残る。オフセットの順序は変わらない。
- ログの回復の後で、索引から引いたオフセットの位置と、セグメントの中身が一致する。

### 9.2 障害の注入

- セグメントの末尾の書き込みの途中でプロセスを強制終了する（ページキャッシュの中身を捨てるために、ノードごと止める形も入れる）。
- ディスクの遅延と I/O エラーを注入する（device-mapper の delay・error、または EBS の性能の制限）。
- ディスクを 95% まで埋め、5.3 節の段階の対応が順に動くことを確かめる。
- 回復の時間：5.2 節の例の書き込みの量で、6.3 節の a の有無で回復の時間を測る。

### 9.3 互換性

- 5 節（[protocol-and-compatibility.md](protocol-and-compatibility.md)）のトピックの設定の範囲の表駆動テスト。
- 本家のブローカーとの差分テストで、`segment.bytes` と `segment.ms` の既定の違いだけが「許された違い」に出る。

## 10. ADR

| ADR | 決定 |
| --- | --- |
| [0009](../decisions/0009-ebs-gp3-single-log-volume.md) | ブローカーごとに EBS gp3 のログのボリュームを 1 本付け、XFS で使う。容量はローカルの保持から出し、75% で自動で広げる |
| [0010](../decisions/0010-segment-retention-and-compaction-defaults.md) | セグメントは 256 MiB・1 時間で切り替える。圧縮のスレッドと I/O を増やして絞り、圧縮のトピックのローカルの量に上限を掛ける |
| [0011](../decisions/0011-log-recovery-and-broker-replacement.md) | 不正な停止の後は本家の回復と ELR に任せ、回復の時間を 5 分に抑える。ボリュームを失ったら空で起動して複製し直し、KIP-1023 は検証の後に有効にする |

## 11. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E1 | `broker-node-baseline` | ノードの OS の設定（XFS、`noatime`、上限）、JVM、ボリュームの付け替え |
| E1 | `log-recovery-poc` | 不正な停止からの回復の時間を、定期のフラッシュの有無で測る |
| E3 | `segment-and-retention-defaults` | ブローカーの既定（3.3 節・4.2 節の表） |
| E3 | `disk-pressure-ladder` | 5.3 節の段階の対応（自動の拡張、ローカルの保持の短縮、cordon、背圧） |
| E3 | `volume-auto-expand` | データ面のエージェントによる KafkaNodePool の `storage.size` の拡張と 6 時間の間隔の管理（control-plane-and-provisioning の `volume-expansion` と同じもの） |
| E3 | `broker-volume-replacement` | 空のボリュームでの起動と複製し直し。KIP-1023 の検証 |
| E3 | `retention-fault-injection` | 9.1・9.2 節の性質と障害の注入 |
| E7 | `compacted-storage-quota` | 圧縮のトピックのローカルの量の上限（multi-tenancy-and-quotas と一緒に） |
| E12 | `broker-storage-alerts` | ディスクの使用率、I/O の待ち時間、クリーナー、回復の時間のアラート |

## 12. 未解決の問い

### 決定（2026-09-27、既定案）

- **ローカルのディスク**：EBS gp3、ブローカーごとに 1 本、XFS。
- **セグメント**：256 MiB、1 時間、揺らぎ 5 分。
- **圧縮**：スレッド 4、重複の除去のバッファ 512 MiB、I/O 100 MiB/秒。
- **ディスクの逼迫**：70%・75%・85%・90%・95% の段階の対応。75% の拡張は KafkaNodePool の `storage.size` で行う。
- **EBS のスループット**：型の EBS の基準の帯域（r8g.4xlarge で 625 MB/秒）を上限にする。
- **暗号化**：物理クラスタごとの CMK。
- **回復の時間**：p99 5 分以内を目標に、定期のフラッシュを既定案とする（PoC で確定）。
- **KIP-1023**：E3・E4 の検証まで無効。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| ローカルの保持の値（`local.retention.ms` の既定） | 6 時間に決めた（[ADR-0019](../decisions/0019-tiered-storage-lifecycle-and-dr-copy.md)）。3 時間への短縮は E9 の T11 の結果で（[ADR-0048](../decisions/0048-broker-design-point-and-cost-model.md)） |
| JVM のヒープ（型は [ADR-0048](../decisions/0048-broker-design-point-and-cost-model.md) で r8g.4xlarge・m8g.4xlarge に決めた） | E1 の PoC |
| 圧縮のトピックのローカルの量の上限の値と掛け方 | multi-tenancy-and-quotas の領域（E7） |
| 定期のフラッシュが produce の遅延（NFR-003）に与える影響 | E1 の PoC |
| 1 つのログのディレクトリの失敗でブローカーが止まるか（4.3） | E1 で試す |
| 複数のボリューム（JBOD）にするか | S2。1 本の上限（64 TiB、2,000 MiB/秒）に近づいたら |

## 13. quality.md・runbooks・data-model への項目

### quality.md

- 不正な停止からの回復の時間（p50・p99）と、回復で読み直した量。
- ディスクの使用率の分布と、段階の対応の発動の回数。
- 保持の監査の不一致（`log-start-offset` が保持の条件より先に進んだ件数。目標 0）。
- 圧縮の遅れ（最も古い未圧縮の部分の経過時間）。

### runbooks

- `runbooks/broker-disk-pressure.md`：5.3 節の段階ごとの確かめ方と手作業での対応。
- `runbooks/broker-slow-recovery.md`：回復が長いときに、待つか、ローカルを捨てて複製し直すか（6.3 節の b）の判断。
- `runbooks/broker-volume-loss.md`：ボリュームを失ったときの入れ替え（6.4 節）。
- `runbooks/log-cleaner-stalled.md`：クリーナーが止まったときの調べ方。

### data-model（索引への追加の提案）

| テーブル・記録 | 中身 |
| --- | --- |
| `broker_volumes`（制御面） | `physical_cluster_id`、`broker_id`、`az_id`、`volume_id`、`size_gib`、`iops`、`throughput_mibps`、`last_modified_at`（6 時間の間隔の管理）、`state` |
| `broker_disk_events`（制御面） | `broker_id`、段階（70〜95%）、動き、時刻 |
| KRaft の記録（索引だけ） | トピックの設定（`segment.bytes` など）の正本は KRaft の ConfigRecord |

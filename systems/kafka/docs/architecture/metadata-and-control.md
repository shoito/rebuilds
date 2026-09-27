# Metadata and control: Kafka

物理クラスタの中のメタデータとその操作の設計。KRaft のクォーラムの構成と入れ替え（KIP-853 の動的なクォーラム）、コントローラーの大きさ、パーティションの配置と再配置、ブローカーの cordon・降格・退役（KIP-1066）、メタデータのログとスナップショットの大きさと上限を扱う。前提の決定は、KRaft を物理クラスタの中の正本にし、制御面は望ましい状態を反映すること（[ADR-0003](../decisions/0003-kraft-metadata-and-cluster-placement.md)）。この文書で決めたことは [ADR-0015](../decisions/0015-kraft-dynamic-quorum-and-controller-sizing.md)〜[ADR-0017](../decisions/0017-metadata-limits-and-snapshots.md)。

本家の振る舞いは、2026-09-27 に kafka.apache.org の 4.3 の文書と KIP で確かめた。確かめられなかったものは「未検証」と書く。論理クラスタの物理クラスタへの配置（どの物理クラスタに載せるか）は ADR-0003 と control-plane-and-provisioning の領域で扱い、この文書は 1 つの物理クラスタの中を扱う。

## 1. 目的と範囲

- 物理クラスタのメタデータ（トピック、パーティション、ISR、ACL、設定、ブローカーの登録）を、1 つの AZ の喪失でも失わず、止めない。
- コントローラーを、クォーラムを止めずに入れ替える。
- パーティションを、AZ の不変条件（[replication-and-durability.md](replication-and-durability.md) の 4 節）を破らずに動かし、ブローカーの追加・退役・負荷の偏りに応じる。
- メタデータの量に上限を持ち、コントローラーの切り替えとブローカーの起動の時間を抑える。

範囲に入れないもの：制御面の望ましい状態の反映のループ（control-plane-and-provisioning）、テナントのクォーラムの外のクォータ（multi-tenancy-and-quotas）、本家の版の更新の手順（delivery）。

## 2. 本家の形（確かめたこと）

| 項目 | 本家 | 出典（2026-09-27 に確認） |
| --- | --- | --- |
| コントローラーの数 | 普通は 3 か 5。N 個の同時の失敗に耐えるには 2N＋1 | [KRaft](https://kafka.apache.org/43/operations/kraft/) |
| 動的なクォーラム | `kraft.version` が 1 以上。`controller.quorum.bootstrap.servers` で見つける。静的なクォーラム（`kraft.version` 0）は `controller.quorum.voters` に全てを書く | 同上、[KIP-853](https://cwiki.apache.org/confluence/display/KAFKA/KIP-853%3A+KRaft+Controller+Membership+Changes) |
| 初期化 | `--standalone`（1 台）、`--initial-controllers`（複数）、`--no-initial-controllers`（既存のクラスタに加わるノード） | KRaft |
| 入れ替え | 追いついた後に `kafka-metadata-quorum.sh add-controller`、止める前に `remove-controller --controller-id --controller-directory-id`。変更は一度に 1 つだけ | KRaft、KIP-853 |
| 複製のディレクトリの ID | 各複製は `meta.properties` に UUID を持ち、同じ ID の別のハードウェアを区別する | KIP-853 |
| 静的から動的へ | `kraft.version` を上げる。1 から 0 へは戻せない | KIP-853 |
| コントローラーの資源 | 普通のクラスタでは、メモリー 5 GB とメタデータのログのディスク 5 GB で足りる | KRaft |
| スナップショット | `metadata.log.max.record.bytes.between.snapshots` 20 MiB、`metadata.log.max.snapshot.interval.ms` 1 時間。`metadata.max.retention.bytes` 100 MiB、`metadata.max.retention.ms` 7 日 | [Broker Configs](https://kafka.apache.org/43/configuration/broker-configs/) |
| 時間 | `controller.quorum.election.timeout.ms` 1 秒、`controller.quorum.fetch.timeout.ms` 2 秒、`broker.heartbeat.interval.ms` 2 秒、`broker.session.timeout.ms` 9 秒 | 同上 |
| cordon | `cordoned.log.dirs`（`*` で全て）。cordon したディレクトリに新しいパーティションを置かない。既存は動き続ける。再配置で cordon したディレクトリを明示すると `KAFKA_STORAGE_ERROR`。4.3 で入った | [KIP-1066](https://cwiki.apache.org/confluence/display/KAFKA/KIP-1066%3A+Mechanism+to+cordon+brokers+and+log+directories)、[4.3.0 の発表](https://kafka.apache.org/blog/2026/05/22/apache-kafka-4.3.0-release-announcement/) |
| スナップショットの取得の大きさ | `controller.quorum.fetch.snapshot.max.bytes`、`controller.quorum.fetch.max.bytes`（KIP-1219、4.3） | 4.3.0 の発表 |
| 道具 | `kafka-metadata-quorum.sh`（状態）、`kafka-dump-log.sh`（ログとスナップショットの解読）、`kafka-metadata-shell.sh`（対話的な閲覧） | KRaft |

Kora（[論文](https://vldb.org/pvldb/vol16/p3822-povzner.pdf)、2026-09-27 に確認）：

- コントローラーを別のプロセスにし、大きなクラスタでは専用のインスタンスに置く。ブローカーを全てロールしても、コントローラーは安定する（3.3 節）。
- 負荷の偏りを、コントローラーの中の Self-Balancing Clusters（Cruise Control に由来）で直す。目標に優先度を付け、ディスクやネットワークの偏りのような重要な指標は再均衡を引き起こす目標にする（4.3.1 節）。
- 拡張では、負荷への寄与の大きい複製から動かす。少数の複製が負荷の多くを生むため（4.3.2 節）。
- 劣化したブローカーから、全てのリーダーを外す「降格」を持つ（4.5 節）。

## 3. KRaft のクォーラム

[ADR-0015](../decisions/0015-kraft-dynamic-quorum-and-controller-sizing.md)。

### 3.1 構成

| 項目 | S1 | S2 |
| --- | --- | --- |
| コントローラーの数 | 3（AZ ごとに 1） | 5（AZ ごとに 2・2・1） |
| クォーラムの種類 | 動的（`kraft.version=1`）。作成時から | 同左 |
| 置き場所 | 専用のノード。ブローカーと同居させない（ADR-0003） | 同左 |
| ディスク | EBS gp3 50 GiB（メタデータのログとスナップショット。本家の目安の 10 倍） | 大きさは 6 節の実測で見直す |
| メモリー | 16 GiB のノード、ヒープ 8 GiB（仮。本家の目安 5 GB の上に余裕） | 同左 |
| リスナー | コントローラーのリスナーは、データ面の内部のネットワークからだけ届く | 同左 |

- 3 台では、1 つの AZ を失うと、残りの 2 台がともに必要になる（失敗にもう耐えられない）。コントローラーの入れ替えやローリング更新の間に 1 台が落ちると、クォーラムが止まる。
- 5 台（2・2・1）では、AZ を失わない限り 2 台の同時の失敗に耐え、ローリング更新と 1 台の故障の重なりに耐える。どの AZ を失っても 3 台以上が残る（2 台の AZ を失うと、それ以上の失敗には耐えない）。S2 で、パーティションとテナントが増え、止まったときの影響が大きくなるので 5 台にする。
- S1 の 3 台の間は、コントローラーのローリング更新を「3 台とも健全で、遅れがない」ときだけ行う（6.4 節の監視）。

### 3.2 作り方

1. 3 台（S2 は 5 台）を、それぞれのディレクトリの ID を決めてから、`--initial-controllers` で初期化する。
2. ブローカーは `controller.quorum.bootstrap.servers` でクォーラムを見つける。ブローカーの設定に投票者の一覧を書かない。
3. `kraft.version` と `metadata.version` を、作成の時点の本家の版の値にする。

### 3.3 コントローラーの入れ替え

KIP-853 の「一度に 1 つ」の制約の下で、足してから外す。

```
1. 新しいノードを、入れ替える台と同じ AZ に作る。--no-initial-controllers で初期化（新しいディレクトリの ID）
2. 観測者（observer）として起動し、メタデータのログに追いつくのを待つ
   （kafka-metadata-quorum.sh describe --replication で遅れが 0）
3. add-controller で投票者に足す（一時的に 4 台。過半数は 3）
4. remove-controller で古い台を外す（ID とディレクトリの ID を指定）
5. 古いノードを止め、ボリュームを消す
```

- 3 と 4 の間は、同じ AZ に投票者が 2 台あり、その AZ を失うと過半数（3）を割る。3 と 4 は続けて行い、この窓を数分に抑える。
- 古い台が既に死んでいるときも同じ順で行う。この場合、2〜4 の間は失敗に耐えない（既に 1 台を失っているため）。runbook で、この間は他の変更を止める。
- ノードの入れ替え（EC2 の故障）で、ボリュームが残っているなら、同じボリュームを新しいノードに付け替えて同じ投票者として戻す。3.3 の手順は、ボリュームを失ったときと、台の型を変えるときに使う。

### 3.4 クォーラムを失ったとき

- 過半数のコントローラーを同時に失うと、メタデータは変えられない。既存のリーダーでの produce と fetch は続く見込みだが、リーダーの移動、ISR の変更、トピックの作成は止まる（ブローカーの振る舞いの詳細は未検証。E3 で確かめる）。
- 過半数のボリュームを失うと、KRaft の正本を失う。本家に、スナップショットからのクォーラムの作り直しの正式な手順はない（未検証）。そこで次を持つ。
  - コントローラーのボリュームは EBS にし、ノードの喪失ではデータを失わない。
  - 最新のスナップショットを 1 時間ごとに S3 に写す（暗号化。調査と、最後の手段の復旧の材料）。
  - 復旧の手順は runbook に書き、検証の環境で年 2 回試す。

## 4. パーティションの配置と再配置

[ADR-0016](../decisions/0016-partition-placement-reassignment-and-cordon.md)。

### 4.1 作成時の配置

- 新しいパーティションは、本家のコントローラーの配置（rack を考えた配置）で、3 つの複製を 3 つの AZ に置く。cordon したブローカーには置かない（KIP-1066）。
- 1 つの論理クラスタのパーティションを、物理クラスタの中のどのブローカーの部分集合（セル）に閉じ込めるかは S2 で決める（ADR-0004）。

### 4.2 再均衡の目標

| 目標 | 種類 |
| --- | --- |
| 3 つの複製は異なる 3 つの AZ にある | 必須（破る計画を作らない、実行しない） |
| ブローカーのディスクの使用率が上限（75%）を超えない | 必須 |
| cordon したブローカーに複製を足さない | 必須 |
| ブローカーの入出力のネットワーク、要求の処理時間（CPU）の偏り | 再均衡を引き起こす目標 |
| 複製の数、リーダーの数の偏り | 最善の努力の目標 |

- Kora と同じく、重要な指標（ディスク、ネットワーク）の偏りは再均衡を引き起こし、他は最善の努力にする（論文の 4.3.1 節）。
- 計画は、Cruise Control（Apache License 2.0）を候補にする。Cruise Control の本体の 4.x への対応は途中で（4.3.1 へ上げる PR がある）、KRaft の 4.3 で使えるかは未検証。E9 の PoC で確かめ、使えなければ、データ面のエージェントに上の目標だけの小さな計画器を作る。

### 4.3 再配置の実行

- 実行は、データ面のエージェントが Admin API の `AlterPartitionReassignments` で行う。テナントには拒否する（[ADR-0006](../decisions/0006-api-exposure-table-and-denial.md)）。
- 1 つのパーティションの 1 回の変更は、複製を 1 つ入れ替えるだけにする。新しい複製を足し（一時的に 4 つ）、追いついてから古い複製を外す（本家の再配置の流れ）。新しい複製は、外す複製と同じ AZ のブローカーにする。これで、途中のどの時点でも 3 つの AZ に複製がある。
- 転送の上限：ブローカーの `leader.replication.throttled.rate`・`follower.replication.throttled.rate` を 1 ブローカーあたり 100 MB/秒（仮）にし、再配置の対象のトピックに throttle の対象の複製を設定する。終わったら外す。
- 同時に動かすのは、1 ブローカーあたり 10 パーティションまで、物理クラスタ全体で 100 パーティションまで（仮）。
- 階層型の保存で、動かすのはローカルの新しいセグメントだけになる（Kora の 3.4 節と同じ効果）。KIP-1023 を有効にすれば、さらに減る（[broker-and-log-storage.md](broker-and-log-storage.md) の 6.4 節）。
- 拡張では、負荷への寄与の大きい複製から動かす（Kora の 4.3.2 節）。NFR-007（ブローカーの追加と再配置を 30 分以内）を E9 で測る。
- 止まった再配置（追いつかない、ブローカーが落ちた）は、30 分ごとに見直し、2 時間進まなければ取り消して人を呼ぶ。

### 4.4 ブローカーの追加

- 3 台ずつ（AZ ごとに 1 台）足す。AZ ごとの台数を揃える。
- 足したブローカーは、はじめは新しいパーティションだけを受ける。再均衡の計画で、既存の複製を移す。

## 5. cordon・退役・降格

[ADR-0016](../decisions/0016-partition-placement-reassignment-and-cordon.md)。

### 5.1 cordon

- 本家の 4.3 の `cordoned.log.dirs=*` をブローカーの動的な設定で掛ける。新しいパーティションの複製は置かれない。既存の複製は動き続ける（KIP-1066）。
- 使う場面：退役の前、ディスクの逼迫（[broker-and-log-storage.md](broker-and-log-storage.md) の 5.3 節の 90%）、ノードやボリュームの劣化の調査中、AZ の不調。
- cordon の状態は、制御面の望ましい状態に持ち、データ面のエージェントが反映する。cordon のままのブローカーの数と期間を監視する（外し忘れの防止）。

### 5.2 退役

```
1. cordon する
2. 降格する（5.3）。リーダーを全て外す
3. 全ての複製を、同じ AZ の他のブローカーへ移す（4.3 の規則）
4. 複製が 0 になったことを確かめる
5. 正しい停止（controlled shutdown）
6. UnregisterBroker で登録を消す
7. ボリュームを消す
```

- 同じ AZ に移す先がないとき（AZ の最後のブローカー）は、退役しない。先に同じ AZ にブローカーを足す。
- 退役は一度に 1 台（AZ ごとに 1 台まで）。

### 5.3 降格（リーダーを外す）

- Kora の降格に倣う（論文の 4.5 節）。データを動かさないので速い。
- やり方：そのブローカーが先頭の複製の一覧を、同じ複製の集合のまま順序だけ入れ替えて（`AlterPartitionReassignments`）、他のブローカーを優先リーダーにし、`ElectLeaders`（PREFERRED）で選び直す。自動のリーダーの再均衡は、新しい優先リーダーを守るので、リーダーが戻ってこない。
- 戻すときは、順序を元に戻して、優先リーダーの選出をする。
- 引き金：ブローカーの要求の処理時間・I/O の待ち時間が、同じ物理クラスタの他のブローカーの中央値より大きく外れる状態が 5 分続く（閾値は observability の領域）。劣化の検出は Kora の 4.5 節と同じく、クラスタ全体との比較で行う。
- 降格の後もフォロワーとして残る。遅いフォロワーは ISR から外れるが、ELR と他の 2 つの複製で耐久性は保たれる。

## 6. メタデータのログとスナップショット

[ADR-0017](../decisions/0017-metadata-limits-and-snapshots.md)。

### 6.1 大きさの見積もり

| 記録 | 1 件の大きさ（仮） | 数 |
| --- | --- | --- |
| パーティション（PartitionRecord。複製、ISR、ELR、ディレクトリの ID を含む） | 約 150 バイト | パーティションの数 |
| トピック（TopicRecord） | 約 100 バイト（名前の長さに依る） | トピックの数 |
| 設定（ConfigRecord） | 約 100 バイト | 既定と違う設定の数 |
| ACL（AccessControlEntryRecord） | 約 150 バイト | ACL の数 |
| クォータ、ブローカーの登録、フィーチャー、プロデューサーの ID の範囲 | 小さい | 少ない |

- 大きさは本家のスキーマから見積もった値で、未検証。E1 の PoC で、`kafka-dump-log.sh` でスナップショットを実測する。
- 見積もり：10 万のパーティション・3 万のトピック・10 万の ACL で、スナップショットは約 35 MB。100 万のパーティションで約 200 MB。

### 6.2 上限（S1）

| 項目 | 上限（仮） | 理由 |
| --- | --- | --- |
| 1 つの物理クラスタのパーティション（複製の前） | 100,000 | コントローラーの切り替えとブローカーの起動の時間を抑える。S1 の全体（20 万、10 物理クラスタ以下）に余裕を持つ |
| 1 つのブローカーの複製 | 4,000 | ファイルと mmap（[broker-and-log-storage.md](broker-and-log-storage.md) の 3.3 節）、ログの回復の時間、フォロワーの取得の数。未検証 |
| 1 つの論理クラスタの ACL | Basic 1,000、Standard 10,000 | メタデータの膨張を抑える。値は [ADR-0029](../decisions/0029-tenant-scoped-acls-and-rbac.md) と [multi-tenancy-and-quotas.md](multi-tenancy-and-quotas.md) の 6 節。物理クラスタの ACL の合計と StandardAuthorizer の評価の性能は E8 の負荷試験で測る |
| パーティションの作成・削除の頻度 | テナントごとの制御の変更のクォータ（本家の `controller_mutation_rate`）で抑える | 値は multi-tenancy-and-quotas の領域 |

- 上限は、制御面の配置（どの物理クラスタに載せるか）と、CreateTopics・CreatePartitions のポリシーで守る。
- 上限の値は、E1 の PoC で、コントローラーの切り替えの時間（目標 5 秒以内）と、ブローカーの起動でメタデータを読み込む時間（目標 30 秒以内）を測って決める。

### 6.3 スナップショットと保持

- スナップショットの間隔と、メタデータのログの保持は本家の既定のまま（20 MiB か 1 時間、100 MiB か 7 日）。
- スナップショットは、6.1 節の大きさでは、コントローラーのディスク（50 GiB）に十分に収まる。
- 4.3 の KIP-1219 の取得の大きさの設定は、既定のまま使い、スナップショットが 100 MB を超える物理クラスタで見直す。
- 3.4 節のとおり、最新のスナップショットを 1 時間ごとに S3 に写す。

### 6.4 監視

- 活動中のコントローラーの数（物理クラスタで常に 1）、リーダーの交代の回数。
- 投票者と観測者の遅れ（`kafka-metadata-quorum.sh` と同じ情報のメタデータのメトリクス。名前は未検証）。
- 最後に適用した記録のオフセットの、コントローラーとブローカーの差。
- メタデータの適用の失敗の件数（本家の `MetadataErrorCount` に当たるもの。名前は未検証）。
- スナップショットの大きさと、最後のスナップショットからの時間。
- 再配置中のパーティションの数と最古の経過時間、cordon のブローカーの数と期間。

## 7. 障害と振る舞い

| 障害 | 起きること | 検知 | 回復 |
| --- | --- | --- | --- |
| コントローラーのリーダーの喪失 | 選挙（1 秒〜数秒）。その間、メタデータの変更が待たされる | リーダーの交代 | 自動 |
| 1 台のコントローラーの喪失（S1） | クォーラムは続く。次の 1 台で止まる | 投票者の到達性 | ボリュームを付け替えて戻す。だめなら 3.3 節 |
| 1 つの AZ の喪失 | コントローラーが 1 台（S2 は最大 2 台）減る。過半数は残る | 同上 | AZ の復旧を待つ。その間、コントローラーの変更をしない |
| 過半数のコントローラーの喪失 | メタデータの変更が止まる。リーダーを失ったパーティションはオフライン | 活動中のコントローラーが 0 | 3.4 節 |
| メタデータのディスクの逼迫 | スナップショットとログが書けない | 使用率 | ボリュームを広げる |
| 再配置が止まる | 一時的に 4 つの複製のまま。throttle が残る | 再配置の経過時間 | 4.3 節の見直しと取り消し |
| cordon の外し忘れ | 新しいパーティションが偏る | cordon の期間 | 望ましい状態との照合で外す |
| 降格の誤作動（健全なブローカーを降格） | リーダーが偏り、他のブローカーが重くなる | 降格の回数、リーダーの偏り | 降格の引き金に、同時に降格する台数の上限（物理クラスタで 1 台）を掛ける |
| メタデータの上限に近い物理クラスタ | 切り替えと起動が遅くなる | パーティションの数、スナップショットの大きさ | 新しい論理クラスタを他の物理クラスタに置く（制御面の配置） |

## 8. セキュリティ

| 脅威 | 対応 |
| --- | --- |
| テナントによる配置・クォーラムの操作 | ElectLeaders、AlterPartitionReassignments、AddRaftVoter などはテナントに拒否する（[ADR-0006](../decisions/0006-api-exposure-table-and-denial.md)）。コントローラーのリスナーは、テナントのネットワークから届かない |
| データ面のエージェントの権限の乱用 | エージェントの主体は、運用の内部のリスナーからだけ認証でき、テナントのリスナーでは使えない。操作は監査ログに残す（security-and-acls の領域） |
| 偽のコントローラーの参加 | コントローラーとブローカーの間は内部の CA の TLS で相互に認証する（方式は security-and-acls の領域）。`add-controller` は運用の手順からだけ行い、投票者の一覧の変化をアラートにする |
| スナップショットの写しからの情報の漏えい | スナップショットには、トピックの名前、ACL の主体、設定の値が入る（レコードの中身はない）。S3 の写しは KMS で暗号化し、読める主体を runbook の手順に限る |
| `kafka-metadata-shell.sh` などの道具の利用 | 本番のノードに入れない。調べるときは S3 の写しを隔離した環境で読む |

この領域の変更のうち、リーダーの選出と再配置に触れるものは `durability:sensitive` のラベルを付ける（[AGENTS.md](../../AGENTS.md)）。

## 9. テスト

### 9.1 性質ベーステスト

- 任意の再配置・cordon・退役・降格の操作の列の後で、全てのパーティションの 3 つの複製は異なる 3 つの AZ にあり、cordon したブローカーに新しい複製はない。
- 任意の再配置の途中のどの時点でも、各パーティションは 3 つの AZ に複製を持つ。
- 降格と戻しを任意の順で繰り返しても、優先リーダーの集合は元に戻る。
- 制御面の望ましい状態（cordon、ブローカーの一覧）を任意の順で与えても、エージェントの結果が同じになる（ADR-0003 の調停の性質）。

### 9.2 障害の注入

- コントローラーのリーダーの強制終了、一時停止、分断（[replication-and-durability.md](replication-and-durability.md) の 8.3 節の一部）。
- 3.3 節の入れ替えの各段で、コントローラーやブローカーを止める。
- 再配置の途中で、足した複製・外す複製・リーダーのブローカーを止める。成功を返した書き込みを失わない。
- 過半数のコントローラーを止め、データの経路がどこまで続くかを測る（3.4 節の未検証の点）。

### 9.3 性能の測定

- 6.2 節の上限の値で、コントローラーの切り替えの時間、ブローカーの起動のメタデータの読み込みの時間、スナップショットの大きさ。
- NFR-007：3 台のブローカーの追加から、負荷が平らになるまでの時間。

### 9.4 互換性

- 差分テストで、配置と再配置の API の拒否が、本家の権限のない主体の応答と同じ（[protocol-and-compatibility.md](protocol-and-compatibility.md)）。

## 10. ADR

| ADR | 決定 |
| --- | --- |
| [0015](../decisions/0015-kraft-dynamic-quorum-and-controller-sizing.md) | KRaft は作成時から動的なクォーラムにし、S1 は専用のコントローラー 3 台、S2 は 5 台（2・2・1）にする。入れ替えは、足してから外す。スナップショットを S3 に写す |
| [0016](../decisions/0016-partition-placement-reassignment-and-cordon.md) | 再配置は 1 回に複製 1 つを同じ AZ の中で入れ替え、throttle と同時数の上限を掛ける。退役は KIP-1066 の cordon から始め、劣化したブローカーは降格する。計画器は Cruise Control を候補に PoC で決める |
| [0017](../decisions/0017-metadata-limits-and-snapshots.md) | 物理クラスタのパーティションを 10 万、ブローカーの複製を 4,000 までにし、スナップショットの設定は本家の既定のまま、大きさと時間を実測して上限を見直す |

## 11. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E1 | `kraft-dynamic-quorum-bootstrap` | 3 台の動的なクォーラムの作成、ブローカーの `controller.quorum.bootstrap.servers` |
| E1 | `metadata-scale-poc` | 6.2 節の上限での切り替え・起動の時間、スナップショットの大きさの実測 |
| E3 | `controller-replacement` | 3.3 節の入れ替えの自動化と、障害注入 |
| E3 | `broker-demotion` | 5.3 節の降格と戻し、引き金 |
| E9 | `reassignment-executor` | 4.3 節の実行（1 つずつ、同じ AZ、throttle、同時数、止まったものの取り消し） |
| E9 | `rebalance-planner` | 4.2 節の目標。Cruise Control の PoC と、だめなら自前の計画器 |
| E9 | `broker-cordon-and-decommission` | 5.1・5.2 節。KIP-1066 の反映と退役の手順 |
| E9 | `broker-scale-out` | 4.4 節の追加と再均衡。NFR-007 の測定 |
| E9 | `metadata-limits-enforcement` | 6.2 節の上限を、配置とポリシーで守る |
| E12 | `kraft-observability` | 6.4 節の監視とアラート |
| E12 | `metadata-snapshot-backup` | スナップショットの S3 への写しと、復旧の訓練 |

## 12. 未解決の問い

### 決定（2026-09-27、既定案）

- **クォーラム**：作成時から動的。S1 は 3 台、S2 は 5 台（2・2・1）。
- **コントローラーの資源**：専用のノード、16 GiB、EBS gp3 50 GiB（仮）。
- **入れ替え**：足してから外す。同じ AZ の中で。
- **再配置**：1 回に複製 1 つ、同じ AZ、100 MB/秒、1 ブローカーあたり 10 パーティション。
- **退役**：cordon → 降格 → 移す → 停止 → 登録の削除。
- **降格**：複製の順序の入れ替えと優先リーダーの選出。同時に 1 台まで。
- **上限**：物理クラスタ 10 万パーティション、ブローカー 4,000 の複製（PoC で見直す）。
- **スナップショットの写し**：1 時間ごとに S3。
- **降格の閾値**：同じ物理クラスタの中央値の 3 倍かつ p99 50ms 超えが 5 分（[observability.md](observability.md) の 5 節）。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| Cruise Control が 4.3 の KRaft で使えるか | E9 の PoC |
| 過半数のコントローラーを失ったときのデータの経路の振る舞いと、スナップショットからの復旧の手順 | E3 の障害注入と、本家の文書・開発者への確認 |
| S1 から 5 台にするか（3 台の間の、入れ替えと故障の重なりの危険） | E3 の運用の実績で。コントローラーの費用は小さいので、前倒しもありうる |
| セル（ブローカーの部分集合）への閉じ込めと、再均衡の目標の関係 | S2。multi-tenancy-and-quotas の領域 |
| コントローラーとブローカーの間の TLS の方式 | security-and-acls の領域（E8） |

## 13. quality.md・runbooks・data-model への項目

### quality.md

- コントローラーの切り替えの時間（p99）、ブローカーの起動のメタデータの読み込みの時間。
- 再配置の完了の時間と、止まった再配置の件数。NFR-007 の実測。
- AZ の不変条件の違反の件数（目標 0。監査の AUD-5 と同じ）。
- 物理クラスタごとのパーティションの数と上限への距離、スナップショットの大きさ。

### runbooks

- `runbooks/controller-replacement.md`：3.3 節の入れ替え。死んだ台の扱いと、その間の変更の凍結。
- `runbooks/kraft-quorum-loss.md`：過半数を失ったときの判断と、スナップショットからの復旧（3.4 節）。
- `runbooks/broker-decommission.md`：5.2 節の退役。
- `runbooks/stuck-reassignment.md`：止まった再配置の調べ方と取り消し、throttle の外し忘れの確認。
- `runbooks/broker-demotion.md`：降格の確かめ方と戻し方。

### data-model（索引への追加の提案）

| テーブル・記録 | 中身 |
| --- | --- |
| `physical_clusters` の追加の欄 | `kraft_version`、`metadata_version`、`controller_count`、`partition_limit` |
| `controllers`（制御面） | `physical_cluster_id`、`node_id`、`directory_id`、`az_id`、`volume_id`、`role`（`voter`・`observer`）、`state` |
| `broker_states`（制御面の望ましい状態） | `physical_cluster_id`、`broker_id`、`az_id`、`cordoned`、`demoted`、`lifecycle`（`active`・`draining`・`decommissioned`）、変更の理由と主体 |
| `reassignment_jobs`（制御面） | `physical_cluster_id`、理由（再均衡・退役・追加）、計画、対象のパーティションの数、throttle、`state`、開始と終了の時刻 |
| `metadata_snapshot_backups`（制御面） | `physical_cluster_id`、スナップショットのオフセットとエポック、S3 のキー、大きさ、時刻 |
| KRaft の記録（索引だけ） | RegisterBrokerRecord・BrokerRegistrationChangeRecord（rack、cordon のディレクトリ）、VotersRecord、PartitionRecord・PartitionChangeRecord |

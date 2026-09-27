# Tiered and object storage: Kafka

階層型の保存（KIP-405）の設計。S3 の RemoteStorageManager、S3 のキーの形、リモートのメタデータ、上げる・消すの流れ、大阪への写し、S2 のディスクレスのトピック（KIP-1150・1163・1164）と費用のモデルを扱う。保存の方式の大枠は [ADR-0002](../decisions/0002-replicated-log-with-tiered-storage.md)、本家の差し込み口で拡張する方針は [ADR-0001](../decisions/0001-upstream-brokers-and-stack.md) にある。

本家の振る舞いは、2026-09-27 に kafka.apache.org の 4.3 の文書、本家のソース（`trunk`）、各 KIP のページで確かめた。AWS の単価は、2026-09-27 に AWS の Price List API（東京 `ap-northeast-1`）で確かめた。確かめられなかったものは「未検証」と書く。要件 ID は、E4 の各変更の `spec.md` に移すときに振る。

## 1. 目的と範囲

- ブローカーのローカルのディスク（EBS）を小さく保つ。閉じたセグメントを S3 へ上げ、ローカルからは早く消す。
- 保持を長くしても、保存の費用を S3 の単価で済ませる。
- ブローカーの追加・入れ替えで移すデータを、ローカルの新しい部分だけにする（NFR-007）。
- コンシューマーからは、ローカルと S3 の境目が見えない 1 本のログに見せる。
- S1 では、S3 に上がったセグメントを大阪へ写し、リージョンの障害のときにログの前の部分を戻せるようにする（NFR-009）。

範囲に入れないもの：

| もの | 扱う場所 |
| --- | --- |
| ローカルのセグメント、索引、保持と圧縮の仕組み、EBS の選定 | `broker-and-log-storage.md` |
| 複製、ISR、耐久性の監査の全体の枠 | `replication-and-durability.md` |
| S3 の暗号化の鍵の管理、データの削除の約束 | security-and-acls.md |
| ブローカーの台数、ディスクの大きさ、費用のモデルの全体（NFR-010） | capacity.md |
| リージョンをまたぐ複製（クラスタの間の複製、S2） | control-plane-and-provisioning.md、infrastructure.md |

## 2. 本家の形（確かめたこと）

| 項目 | 本家 | 出典 |
| --- | --- | --- |
| 状態 | KIP-405 は 3.9 で本番向け | [Tiered Storage GA Release Notes](https://cwiki.apache.org/confluence/x/9xDOEg) |
| 有効化 | ブローカーは `remote.log.storage.system.enable=true`。トピックは `remote.storage.enable=true` | [Tiered Storage](https://kafka.apache.org/43/operations/tiered-storage/) |
| RemoteStorageManager（RSM） | 本家は実装を持たない。`remote.log.storage.manager.class.name` で差し込む。設定は `rsm.config.` の接頭辞で渡す | 同上 |
| RSM の操作 | `copyLogSegmentData`（セグメントと索引を上げる。任意の `CustomMetadata` を返せる）、`fetchLogSegment`（範囲の読み取り）、`fetchIndex`（`OFFSET`・`TIMESTAMP`・`PRODUCER_SNAPSHOT`・`TRANSACTION`・`LEADER_EPOCH`）、`deleteLogSegmentData` | [RemoteStorageManager.java](https://github.com/apache/kafka/blob/trunk/storage/api/src/main/java/org/apache/kafka/server/log/remote/storage/RemoteStorageManager.java) |
| RemoteLogMetadataManager（RLMM） | 既定は `TopicBasedRemoteLogMetadataManager`。内部トピック `__remote_log_metadata` に、セグメントの状態の変化を書く。パーティション 50、複製 3、`min.isr` 2（4.3 の KIP-1235 で設定になった）、保持 `-1`（無期限。階層型のトピックの最大の保持より長くすること） | [Tiered Storage Configs](https://kafka.apache.org/43/configuration/tiered-storage-configs/)、[4.3.0 の発表](https://kafka.apache.org/blog/2026/05/22/apache-kafka-4.3.0-release-announcement/) |
| セグメントの状態 | `COPY_SEGMENT_STARTED` → `COPY_SEGMENT_FINISHED` → `DELETE_SEGMENT_STARTED` → `DELETE_SEGMENT_FINISHED` | [RemoteLogSegmentState.java](https://github.com/apache/kafka/blob/trunk/storage/api/src/main/java/org/apache/kafka/server/log/remote/storage/RemoteLogSegmentState.java) |
| 上げる対象 | アクティブでないセグメントで、終わりのオフセットが LSO（last stable offset）より小さいもの。つまり、開いたトランザクションが残るあいだ、その先は上がらない | [RemoteLogManager.java](https://github.com/apache/kafka/blob/trunk/storage/src/main/java/org/apache/kafka/server/log/remote/storage/RemoteLogManager.java) の `candidateLogSegments` |
| ローカルの保持 | `local.retention.ms`・`local.retention.bytes`（既定 `-2` ＝ `retention.*` と同じ）。上がったセグメントだけがローカルから消える | [Topic Configs](https://kafka.apache.org/43/configuration/topic-configs/) |
| 周期と帯域 | `remote.log.manager.task.interval.ms` 30 秒。上げる帯域 `remote.log.manager.copy.max.bytes.per.second`、読む帯域 `remote.log.manager.fetch.max.bytes.per.second`（どちらも既定は無制限）。読み取りのスレッド `remote.log.reader.threads` 10、待ち行列 `remote.log.reader.max.pending.tasks` 100（満杯なら fetch はエラー）。`remote.fetch.max.wait.ms` 500 | [Tiered Storage Configs](https://kafka.apache.org/43/configuration/tiered-storage-configs/) |
| 止め方 | `remote.log.copy.disable=true` で読み取りだけにする。`remote.storage.enable=false`＋`remote.log.delete.on.disable=true` で S3 の分を消して止める（KRaft だけ） | [Tiered Storage](https://kafka.apache.org/43/operations/tiered-storage/) |
| 制限 | 圧縮（compaction）のトピックは使えない。2.8 より前に作ったトピック（producer snapshot のないセグメント）は使えない | 同上 |
| 新しいフォロワーの立ち上げ | 4.3 の KIP-1023 で、`follower.fetch.last.tiered.offset.enable` により、新しいフォロワーが S3 に上がった最後のオフセットから複製を始められる | [4.3.0 の発表](https://kafka.apache.org/blog/2026/05/22/apache-kafka-4.3.0-release-announcement/) |
| 本家の外の S3 の RSM | Aiven の [tiered-storage-for-apache-kafka](https://github.com/Aiven-Open/tiered-storage-for-apache-kafka)（Apache License 2.0。最新の版 v1.1.1、2025-10-07）。セグメントを 4 MiB の塊（chunk）に分けて圧縮・暗号化し、1 つのオブジェクトにつなげて上げる。塊の索引を持つマニフェスト（`.rsm-manifest`）を別に上げる。ローカルのディスクに塊のキャッシュを持つ。封筒暗号化（セグメントごとの AES-256 の DEK） | 同リポジトリの README |

Kora の論文は、テスト環境で「階層型の保存のメタデータのリーダーとフォロワーの食い違い」によるデータの喪失を観測したと書いている（[Kora](https://vldb.org/pvldb/vol16/p3822-povzner.pdf) の表 1）。また、階層型のデータとメタデータの予備を持ち、ログの前の部分を戻せるようにしている（4.6.2 節）。

## 3. 方針

- **本家の RemoteLogManager と既定の RLMM をそのまま使う。** 上げる・消すの判断、リーダーの交代、状態の遷移は本家に任せる（[ADR-0001](../decisions/0001-upstream-brokers-and-stack.md)）。
- **RSM は、Aiven の Apache License 2.0 の実装を土台にする。** 自前で書き起こさない。足りないもの（キーの形の検査、監査のための出力）は、包む層で足す（[ADR-0018](../decisions/0018-s3-remote-storage-manager.md)）。
- **削除のポリシーのトピックは、すべて階層型にする。** テナントは外せない。圧縮のトピックは、本家の制限でローカルだけに置き、容量の上限を別に掛ける（[ADR-0019](../decisions/0019-tiered-storage-lifecycle-and-dr-copy.md)）。
- **S3 のキーは、テナントで始まる形にする。** テナントの削除、費用の按分、大阪への写しの対象の絞り込みを、キーの前方一致でできるようにする（[ADR-0018](../decisions/0018-s3-remote-storage-manager.md)）。
- **大阪への写しは、S3 のリージョンをまたぐ複製（CRR）で行い、論理クラスタごとに選べるようにする。** 1 GB あたり $0.09 の転送料金だけで NFR-010 の目標（$0.11）に近く、すべてに掛けられないため（[ADR-0019](../decisions/0019-tiered-storage-lifecycle-and-dr-copy.md)）。
- **ディスクレスのトピックは、本家の実装を待つ。** 冪等なプロデューサーとトランザクションに本家が対応するまで提供しない（[ADR-0020](../decisions/0020-diskless-topics-adoption.md)）。

## 4. 構成

```
ブローカー（リーダー）
  └─ RemoteLogManager（本家）
        ├─ RLMCopyTask（30 秒ごと）：LSO より前の閉じたセグメントを選ぶ
        │     ├─ RLMM に COPY_SEGMENT_STARTED を書く（__remote_log_metadata）
        │     ├─ RSM.copyLogSegmentData ─▶ S3（東京）：.log・.indexes・.rsm-manifest
        │     └─ RLMM に COPY_SEGMENT_FINISHED を書く
        ├─ RLMExpirationTask：retention.ms・retention.bytes を超えたセグメントを消す
        │     └─ DELETE_SEGMENT_STARTED → RSM.deleteLogSegmentData → DELETE_SEGMENT_FINISHED
        └─ ローカルの保持：上がったセグメントを local.retention.* で消す
ブローカー（フォロワー）
  └─ RLMFollowerTask：RLMM を読み、上がった位置を知る
fetch（ローカルにない範囲）
  └─ remote.log.reader.threads ─▶ 塊のキャッシュ（ローカルのディスク）─▶ S3
S3（東京）──CRR（選んだ論理クラスタの前方一致だけ）──▶ S3（大阪）
データ面のエージェント
  ├─ RLMM のスナップショットを S3 に書き出す（大阪へも写る）
  └─ 監査：RLMM と S3 の一覧を照合する（日次）
```

## 5. RemoteStorageManager（S3）

### 5.1 土台と包む層

| 部品 | 中身 |
| --- | --- |
| 土台 | Aiven の tiered-storage-for-apache-kafka の S3 の backend（`io.aiven.kafka.tieredstorage.RemoteStorageManager`）。版を固定し、開発リポジトリでソースからビルドする。本家の版を上げるときに、互換性と耐久性のテストを一緒に回す |
| 包む層（Java、自前） | `TenantAwareRemoteStorageManager`。土台に委ねる前後で、(1) トピックの内部の名前がテナントの接頭辞で始まることを確かめる（始まらないものは上げずに失敗させる）、(2) 上げた・消したオブジェクトのキーと大きさを、テナントごとの計数（メトリクスと使用量）に出す、(3) S3 の失敗を分類して数える |
| 設定 | `rsm.config.chunk.size=4194304`（4 MiB。土台の推奨値）。`rsm.config.key.prefix` は空（キーをテナントの接頭辞で始めるため。5.2 節） |
| 圧縮・暗号化 | 土台の圧縮は使わない（クライアントが圧縮したバッチを、さらに圧縮しても縮まない見込み。未検証。E4 の `rsm-tenant-wrapper` で測る）。暗号化は S3 の SSE-KMS（S3 Bucket Keys を有効）に任せ、土台のクライアント側の暗号化は使わない。テナントごとの鍵（BYOK）は S2 の Dedicated で、security-and-acls の領域で決める |
| 塊のキャッシュ | ローカルのディスク（ブローカーの EBS の別の領域）に 50 GiB、保持 10 分、先読み 16 MiB。初期値。capacity の領域で見直す |

README の 4 節の技術スタックは、はじめ「自前の S3 の RemoteStorageManager」としていた。この文書で、土台を OSS にし、包む層だけを自前にする形に改め（[ADR-0018](../decisions/0018-s3-remote-storage-manager.md)）、統合の工程で README も直した。

### 5.2 バケットとキー

- バケットは、物理クラスタごとに 1 つ、東京に置く：`<brand>-tiered-<pc-id>-apne1`。バージョニングを有効にする（CRR の前提）。パブリックアクセスはすべて遮断する。
- ブローカーの IAM のロール（EKS の Pod Identity）は、自分の物理クラスタのバケットだけに `GetObject`・`PutObject`・`DeleteObject`・`AbortMultipartUpload` を許す。`ListBucket` は、監査と削除の掃除をするデータ面のエージェントだけに許す。
- VPC のゲートウェイ型のエンドポイントを通す。同じリージョンの S3 への転送は無料。

土台のキーの形は次のとおり（[ObjectKeyFactory.java](https://github.com/Aiven-Open/tiered-storage-for-apache-kafka/blob/main/core/src/main/java/io/aiven/kafka/tieredstorage/ObjectKeyFactory.java)、2026-09-27 に確認）。

```
<key.prefix><topic>-<topicId>/<partition>/<20 桁の開始オフセット>-<segmentUuid>.<log|indexes|rsm-manifest>
```

テナントの名前空間のパッチで、トピックの内部の名前は `<lc-id>_<テナントが付けた名前>` になる（[multi-tenancy-and-quotas.md](multi-tenancy-and-quotas.md) の 4.1 節）。`key.prefix` を空にすると、キーは次のようになる。

```
lc-7kq2vx_orders-3fA9…Qw/12/00000000000004182731-Zp0….log
lc-7kq2vx_orders-3fA9…Qw/12/00000000000004182731-Zp0….indexes
lc-7kq2vx_orders-3fA9…Qw/12/00000000000004182731-Zp0….rsm-manifest
_rlmm/2026-09-27/partition-17.jsonl.zst        （エージェントが書く。6.5 節）
```

- **テナントで始まる。** `lc-7kq2vx_` の前方一致で、テナントのすべてのオブジェクトを列挙・削除・複製の対象にできる。S3 Storage Lens の前方一致の集計で、テナントごとの保存量を出せる。
- **トピックの ID を含む。** 同じ名前のトピックを消して作り直しても、キーが衝突しない。
- **要求の速さ。** S3 は、前方一致ごとに毎秒 3,500 の PUT 系と 5,500 の GET 系を受け付け、超えると徐々に広がる（その間は 503）（[Optimizing Amazon S3 performance](https://docs.aws.amazon.com/AmazonS3/latest/userguide/optimizing-performance.html)）。256 MiB のセグメントの PUT は十数回（最大の 1 GiB でも数十回）で、テナントとパーティションでキーが散るので、S1 の規模では当たらない見込み。過去のデータの一斉の読み戻し（1 GB あたり 4 MiB の塊で 256 回の GET）が 1 つのトピックに集中したときに、503 が出うる。RSM の再試行（指数的な待ち）で吸収し、件数をメトリクスにする。

### 5.3 セグメントの大きさと周期

| 設定 | 値 | 誰が決めるか |
| --- | --- | --- |
| `segment.bytes` | 256 MiB（テナントは 64 MiB〜1 GiB） | [broker-and-log-storage.md](broker-and-log-storage.md) の 3 節と [ADR-0010](../decisions/0010-segment-retention-and-compaction-defaults.md)、許可リストは [ADR-0007](../decisions/0007-topic-config-allowlist.md) |
| `segment.ms` | 1 時間（テナントは 10 分〜7 日） | 同上。流量の少ないトピックでも 1 時間に 1 回は S3 に上がる。テナントが延ばすと、S3 と大阪への写しが遅れる（12 節の持ち越し） |
| `local.retention.ms` | 6 時間（ブローカーの `log.local.retention.ms`） | この文書（初期値。[broker-and-log-storage.md](broker-and-log-storage.md) の見積もりの仮置きと同じ値にした。capacity の領域で見直す）。テナントは変えられない。本家は `local.retention.ms` が `retention.ms` を超える設定を拒否する（`LogConfig` の検査）。テナントが `retention.ms` を 6 時間より短くしたときは、名前空間のパッチ（P1）が `local.retention.ms = retention.ms` を足す（12 節。本家の検査で作成が失敗するため） |
| `local.retention.bytes` | `-2`（`retention.bytes` に従う） | 同上 |
| `remote.log.manager.task.interval.ms` | 30 秒（本家の既定） | この文書 |
| `remote.log.manager.copy.max.bytes.per.second` | ブローカーごとに 200 MB/秒 | capacity の領域の NIC の予算で見直す |
| `remote.log.manager.fetch.max.bytes.per.second` | ブローカーごとに 300 MB/秒 | 同上 |
| `remote.log.reader.threads`・`remote.log.reader.max.pending.tasks` | 10・100（本家の既定） | 負荷試験で見直す |

ローカルに残る量の目安：ブローカーが受け持つリーダーとフォロワーの書き込みの速さ × (`local.retention.ms` ＋ `segment.ms`)。書き込み 50 MB/秒（複製を含む）のブローカーで、50 MB × 7 時間 ≒ 1.3 TB。EBS の大きさは capacity の領域で決める。

## 6. 流れ

### 6.1 上げる（copy）

1. リーダーの RLMCopyTask が、LSO より前で閉じたセグメントを選ぶ。
2. `COPY_SEGMENT_STARTED` を `__remote_log_metadata` に書く（`acks=all`、`min.isr=2`）。
3. RSM が、`.log`（塊をつないだ 1 つのオブジェクト。マルチパートのアップロード）、`.indexes`、`.rsm-manifest` の順に PUT する。
4. `COPY_SEGMENT_FINISHED` を書く。フォロワーは RLMM を読んで、上がった位置を知る。
5. ローカルの保持を過ぎたセグメントを、ローカルから消す。上がっていないセグメントは、`local.retention.*` を過ぎても消えない。

開いたトランザクションが LSO を止めると、その先は上がらない。長いトランザクション（上限は `transaction.max.timeout.ms` の 15 分）と、ぶら下がったトランザクションは、ローカルのディスクを増やす（[transactions-and-idempotence.md](transactions-and-idempotence.md) の 8 節）。

### 6.2 読む（fetch）

- fetch のオフセットがローカルの先頭より前なら、リモートの読み取りのスレッドに回す。応答は `remote.fetch.max.wait.ms`（500ms）まで待つ。
- 塊のキャッシュに当たれば S3 を読まない。外れたら、塊の範囲だけを GET する。
- コンシューマーは、同じ AZ のフォロワーから読む（fetch-from-follower。`replication-and-durability.md`）。フォロワーも S3 から読めるので、過去の読み戻しも AZ をまたがない。
- リモートの読み取りの帯域は、テナントの読み取りのクォータ（`consumer_byte_rate` 相当）に数える。過去の読み戻しは、通常の読み取りと同じクォータで絞る（[multi-tenancy-and-quotas.md](multi-tenancy-and-quotas.md)）。
- 待ち行列が満杯のときは、本家どおり fetch をエラーにする。クライアントは再試行する。この件数を監視する。

### 6.3 消す（delete）

- 保持を超えたセグメントは、リーダーの RLMExpirationTask が消す。消す前に `DELETE_SEGMENT_STARTED`、消した後に `DELETE_SEGMENT_FINISHED` を書く。本家は、前回消し損ねたもの（dangling）も次の周期で消し直す。
- トピックの削除では、本家がパーティションの停止のときに S3 の分を消す（`deleteRemoteLogPartition`）。
- 論理クラスタの削除では、まずトピックを消し、7 日の猶予の後に、データ面のエージェントが前方一致 `lc-<id>_` で残りを消す（6.6 節）。猶予の長さは、security-and-acls の領域のデータの削除の約束に合わせる。

### 6.4 ブローカーの追加と入れ替え

- 再配置で移すのは、ローカルに残っている部分だけ（最大で `local.retention.ms`＋`segment.ms` の分）。
- 4.3 の KIP-1023（`follower.fetch.last.tiered.offset.enable`）を使うと、新しいフォロワーは S3 に上がった最後のオフセットから複製を始められ、移す量がさらに減る。新しい機能なので、E4 で障害注入のテストを通してから有効にする（13 節）。

### 6.5 RLMM のスナップショット

- RLMM の正本は `__remote_log_metadata`（複製 3）で、物理クラスタの中にある。S3 のオブジェクトだけでは、どれが有効なセグメントか（リーダーのエポック、状態）が分からない。
- データ面のエージェントは、`__remote_log_metadata` を読み続け、パーティションごとの有効なセグメントの一覧（`COPY_SEGMENT_FINISHED` で、`DELETE_SEGMENT_STARTED` が来ていないもの）を、1 時間ごとに `_rlmm/<日付>/partition-<n>.jsonl.zst` に書き出す。
- 用途：日次の監査（6.7 節）と、大阪での戻し（6.6 節）。

### 6.6 大阪への写し

- S3 の CRR（Replication Time Control 付き）で、東京のバケットから大阪のバケットへ写す。RTC は「ほとんどを数秒、99.9% を 15 分以内」に写す（[S3 RTC](https://docs.aws.amazon.com/AmazonS3/latest/userguide/replication-time-control.html)、2026-09-27 に確認）。RTC の SLA は、前方一致ごとの要求の速さの目安と、1 Gbps の既定の転送の上限を超えている間は適用されない（同上）。
- **対象は、写しを有効にした論理クラスタだけ。** 複製の規則を論理クラスタごとに作り、前方一致 `lc-<id>_` で絞る。`_rlmm/` は常に写す。
- 東京から大阪への転送は $0.09/GB（Price List API）。写しを有効にしたテナントの書き込みの量に、ほぼそのまま掛かる。S3 に上がる前に消えるデータ（保持が `local.retention.ms` より短いもの）は写らない。
- **削除は写さない**（削除マーカーの複製を無効）。大阪のバケットは、ライフサイクルの規則で、作ってから「そのテナントの最大の保持＋7 日」で消す。論理クラスタの削除のときは、大阪の前方一致も消す。
- 大阪のバケットは、別の AWS アカウントに置き、東京のブローカーのロールからは書けない・消せないようにする（ランサムウェアと誤操作への備え）。
- 戻せるのは「S3 に上がったログの前の部分」だけ。セグメントは閉じた直後に S3 へ上がり、ローカルの保持（`local.retention.ms`）を待たない。したがって失う範囲は、閉じていないセグメント（最大で `segment.ms` の 1 時間か `segment.bytes` の 256 MiB）＋ LSO で止まった部分 ＋ 上げの遅れ（`remote.log.manager.task.interval.ms` の 30 秒と上げの時間）＋ CRR の遅れ（99.9% は 15 分以内）である。`local.retention.ms` は関係しない。圧縮のトピックも戻せない。これは NFR-009 と、利用規約・SLA の説明（intent.md の L6）に書く。
- S1 の戻しは手順（runbook）で行う：大阪に物理クラスタを作り、`_rlmm/` の最後のスナップショットから、有効なセグメントを RLMM に登録し直して、読み取り専用のトピック（`remote.log.copy.disable=true`）として見せる。本家は、`remote.log.copy.disable=true` のときに `local.retention.ms`・`local.retention.bytes` を `-2` にすることを求める（[Tiered Storage](https://kafka.apache.org/43/operations/tiered-storage/)、2026-09-27 に確認）ので、戻したトピックはこの 2 つを `-2` にする。RLMM に外から登録し直す道具は自前で作る（本家の 4.3 の `bin/` と Tiered Storage の文書に、RLMM を書き換える道具はない。2026-09-27 に確認）。S2 のクラスタの間の複製で置き換える。

### 6.7 監査（日次）

Kora に倣い、階層型の保存の境界を耐久性の監査の対象にする（[ADR-0002](../decisions/0002-replicated-log-with-tiered-storage.md)）。監査の枠と AUD-4（`log-start-offset` からローカルの始まりまでの全てのオフセットが、リモートのメタデータにちょうど 1 回あり、S3 のオブジェクトがあり、大きさが一致する）は [replication-and-durability.md](replication-and-durability.md) の 7.2 節と [ADR-0014](../decisions/0014-durability-audit-and-fault-injection.md) にある。この領域は、AUD-4 を次のように詳しくし、監査の事象を定める。

監査の事象（包む層の RSM が出す。レコードの中身を含めない）：

| 事象 | 欄 |
| --- | --- |
| `remote_segment_copied` | 物理クラスタ、トピックの ID、パーティション、開始・終わりのオフセット、`segmentUuid`、リーダーのエポック、大きさ、3 つのオブジェクトの ETag |
| `remote_segment_deleted` | 物理クラスタ、トピックの ID、パーティション、`segmentUuid`、消した理由（保持の時間・大きさ、トピックの削除、dangling） |
| `remote_copy_failed` | 物理クラスタ、トピックの ID、パーティション、`segmentUuid`、失敗の分類（S3・KMS・RLMM） |

データ面のエージェントが、パーティションごとに次を確かめる。

| 不変条件 | 破れたとき |
| --- | --- |
| RLMM の有効なセグメントのオフセットの範囲は、重ならず、途切れない（ローカルの先頭までつながる） | 重大。耐久性の事故として扱う（runbook） |
| 有効なセグメントの 3 つのオブジェクトが S3 にある（`HeadObject`） | 重大 |
| S3 にあって RLMM に有効な記録のないオブジェクト（孤児）が、7 日より古い | 軽微。費用の漏れ。報告し、10 節の条件を満たすものだけ消す |
| 最も古い有効なセグメントが、`retention.ms` より古くない | 保持の違反（消し残し）。Kora の表 1 にある保持の設定の誤りの型 |
| リーダーとフォロワーの RLMM の見え方が同じ（`__remote_log_metadata` の各パーティションの ISR の複製で、同じオフセットまで読んだ結果が同じ） | 重大。Kora の表 1 の「メタデータの食い違い」 |

## 7. 圧縮のトピック

- 本家の制限で、`cleanup.policy=compact`（`compact,delete` を含む）のトピックは階層型にできない。ローカルのディスクだけに置く。
- ローカルのディスクを守るため、論理クラスタごとに、圧縮のトピックの合計の大きさ（複製の前）の上限を掛ける。値と掛け方は [multi-tenancy-and-quotas.md](multi-tenancy-and-quotas.md) の 6 節（Basic 50 GiB、Standard は CU あたり 100 GiB。[ADR-0010](../decisions/0010-segment-retention-and-compaction-defaults.md) の提案に合わせた）。
- 本家は、`remote.storage.enable=true` のトピックの `cleanup.policy` を `delete` 以外にする変更を、`ConfigException`（クライアントには `INVALID_CONFIG`）で拒否する（[LogConfig.java](https://github.com/apache/kafka/blob/trunk/storage/src/main/java/org/apache/kafka/storage/internals/log/LogConfig.java) の `validateRemoteStorageRequiresDeleteCleanupPolicy`）。階層型のトピックを圧縮に変えたいテナントには、新しいトピックを作ってもらう。この振る舞いは本家と同じで、利用者向けの文書に書く。
- `compact` から `delete` への変更は受け付ける。変更の後、データ面のエージェントが `remote.storage.enable=true` を足して階層型にする（テナントには見えない）。

## 8. ディスクレスのトピック（S2）

### 8.1 本家の状況（2026-09-27）

| KIP | 中身 | 状態 |
| --- | --- | --- |
| [KIP-1150](https://cwiki.apache.org/confluence/display/KAFKA/KIP-1150%3A+Diskless+Topics) | 要求の合意。従来のトピックと並ぶ別の種類のトピック。順序、冪等、トランザクション、グループ、共有のグループ、階層型の保存との互換を保つとする | 採択（2026-03-02。[Aiven の解説](https://aiven.io/blog/kip-1150-accepted-and-the-road-ahead)） |
| [KIP-1163](https://cwiki.apache.org/confluence/display/KAFKA/KIP-1163%3A+Diskless+Core) | 中核。トピックの設定 `diskless.enable`（作成時だけ）。どのブローカーでも produce を受け、`diskless.append.commit.interval.ms`（案は約 250ms）か `diskless.append.buffer.max.bytes`（案は約 4 MiB）で WAL のオブジェクトを閉じて S3 に上げ、コーディネーターにオフセットを振ってもらう。遅延の目標は p50 約 500ms、p99 1〜2 秒。最初の版は、圧縮のトピックとトランザクションに対応しない | 議論中 |
| [KIP-1164](https://cwiki.apache.org/confluence/display/KAFKA/KIP-1164%3A+Diskless+Coordinator) | オフセットを振るコーディネーター。内部トピック `__diskless_metadata` を正本にし、ローカルの SQLite に展開する。冪等の検査は含むが、トランザクションの管理は範囲の外 | 議論中（2026-02-27 の版） |
| [KIP-1165](https://cwiki.apache.org/confluence/display/KAFKA/KIP-1165%3A+Object+Consolidation+for+Diskless) | WAL のオブジェクトを、階層型の保存のセグメントにまとめ直す | 議論中（「Under Discussion (Re-Opened)」。2026-09-27 に確認） |

Aiven は、自社の fork（Inkless）で試していて、本家に入れば fork を捨てる方針とする（同上の解説）。

### 8.2 費用のモデル

1 GB の書き込みあたり、東京の単価で概算する。WAL のオブジェクトは 4 MiB、AZ は 3 つ、保持は 7 日とする。単価は Price List API（2026-09-27）：S3 Standard の保存 $0.025/GB-月、PUT $0.0047/1,000、GET $0.00037/1,000、AZ をまたぐ転送 $0.01/GB（送信と受信で各）。

| 項目 | Standard のトピック（複製 3＋階層型） | ディスクレスのトピック |
| --- | --- | --- |
| AZ をまたぐ転送 | 約 $0.053（README の NFR-010 の表） | 0（プロデューサーが同じ AZ のブローカーに送り、コンシューマーも同じ AZ から読むとき） |
| S3 の PUT | 1 GiB のセグメントでマルチパートの数十回。約 $0.0002 | WAL 256 回＋まとめ直し 数十回。約 $0.0014 |
| S3 の GET | 過去の読み戻しのときだけ | 各 AZ のブローカーが WAL を 1 回ずつ読む 768 回＋まとめ直しの 256 回。約 $0.0004 |
| S3 の保存（7 日） | 約 $0.0058 | 約 $0.0058（WAL の残る期間の分を少し足す） |
| EBS | ローカルの保持の分（capacity の領域） | キャッシュだけ（小さい） |
| 合計（ネットワークと S3） | 約 $0.059 | 約 $0.008 |

- ディスクレスのトピックには、流量によらない下限がある。ブローカーは 250ms ごとに WAL を閉じるので、流量が少なくても 1 台で毎秒 4 回の PUT が出る。1 か月で約 1,040 万回、東京で約 $49/台。共有の物理クラスタでは多くのテナントで割るので、小さなテナントほど得になるわけではない。
- この表は KIP の案の値による概算で、実装で変わる。未検証（E13 の `diskless-upstream-tracking` で、本家の実装が入ったら測り直す）。
- S3 Express One Zone（東京で保存 $0.124/GB-月、PUT $0.00108/1,000、アップロード $0.003/GB）は、1 つの AZ に置くので、AZ の喪失で RPO 0（NFR-001）を満たせない。ディスクレスの正本には使わない（[ADR-0002](../decisions/0002-replicated-log-with-tiered-storage.md)）。

### 8.3 提供の条件

[ADR-0020](../decisions/0020-diskless-topics-adoption.md) で決めた。要点：

- 本家の版に KIP-1163・1164 が入り、冪等なプロデューサーとトランザクションに対応してから提供する。自前で作らない。
- 遅延の目標は別に置く（NFR-004 の注記の p99 1 秒以内。KIP-1163 の目標は p99 1〜2 秒なので、測って見直す）。
- 料金は、Standard のトピックと別の単価にする（metrics-and-billing の領域）。

## 9. 障害のときの振る舞い

| 障害 | 振る舞い | 利用者への影響 |
| --- | --- | --- |
| S3 の PUT の失敗・遅延 | RLMCopyTask が次の周期で再試行する。上がらないセグメントはローカルから消えない | なし。ローカルのディスクが増える。上げの遅れのアラート（30 分）とディスクの使用率のアラート（70%。[broker-and-log-storage.md](broker-and-log-storage.md) の 5.3 節）で気づく |
| S3 が長く使えない（リージョンの S3 の障害） | 上げる・読み戻す・消すが止まる。ローカルの新しい部分の produce・fetch は続く | 過去の範囲の fetch がエラーになる。ディスクが埋まる前に、ローカルの保持の延長の余地（ディスクの空き）を見て、該当する物理クラスタへの新しい論理クラスタの配置を止める |
| `COPY_SEGMENT_STARTED` の後にブローカーが止まる | 新しいリーダーが同じ範囲を別の `segmentUuid` で上げ直す。途中のオブジェクトは孤児になる | なし。監査が孤児として数える |
| `__remote_log_metadata` のパーティションが `min.isr` を割る | RLMM に書けないので、上げる・消すが止まる | ローカルのディスクが増える |
| リモートの読み取りの待ち行列が満杯 | fetch がエラーになる（本家どおり） | 過去の読み戻しが遅れる。クライアントは再試行する |
| KMS の失敗・スロットリング | PUT・GET が失敗する | 上と同じ。S3 Bucket Keys で KMS の呼び出しを減らす |
| 監査で重大な不変条件の破れ | ページングする。該当するパーティションの削除（RLMExpirationTask）を止める仕組みを用意する（`remote.log.copy.disable` ではなく、自前の停止のフラグ。E4 で作る） | 原因を調べる間、保持を超えたデータが消えないことがある |
| 東京のリージョンの喪失 | 大阪のバケットと `_rlmm/` から、写しを有効にした論理クラスタのログの前の部分を戻す（6.6 節） | ローカルだけの部分と圧縮のトピックは失う（NFR-009、L6） |

## 10. セキュリティ（テナントの分離）

- **キーは必ずテナントの接頭辞で始まる。** 包む層が、トピックの内部の名前が `lc-<id>_` で始まることを確かめてから上げる。始まらないもの（内部トピックなど）は上げない。内部トピックは階層型にしない。
- **S3 への経路をテナントに渡さない。** テナントの要求は Kafka のプロトコルだけで、S3 のキー・バケット名・署名つきの URL は応答に出さない。RSM の例外のメッセージをクライアントへのエラーの本文に出さない（本家は内部のエラーを `UNKNOWN_SERVER_ERROR` などに丸める。差分テストで確かめる）。
- **ブローカーは共有なので、IAM でテナントを分けられない。** 分離は、名前空間のパッチ（どのトピックのどのオフセットを読めるか）に頼る。S3 の分離は「物理クラスタの外に出さない」までにとどめる。
- **暗号化**：SSE-KMS（物理クラスタごとの鍵）。テナントごとの鍵は S2（security-and-acls の領域）。
- **消したデータの扱い**：論理クラスタの削除から 7 日で東京の前方一致を消し、大阪はライフサイクルと削除の手順で消す。バージョニングの古い版は、ライフサイクル（`NoncurrentVersionExpiration` 1 日）で消す。孤児を消すのは、(a) トピックの ID が KRaft に存在しない、または (b) RLMM で `DELETE_SEGMENT_FINISHED` の記録がある、のどちらかで、かつ 7 日より古いものだけ。
- **ログ**：S3 のキーにはテナントのトピックの名前が入る。運用のログに出すときは、トピックの名前をハッシュにする（observability の領域）。

## 11. テスト

### 11.1 性質ベーステスト（jqwik）

- 任意の produce・トランザクションの中止・リーダーの交代・ブローカーの停止の列で、上げたセグメントの範囲は LSO を超えない。
- 任意のセグメントの上げ・消しの列で、RLMM の有効なセグメントの範囲は重ならず、途切れない。
- 任意のトピック名（テナントの名前空間を通したもの）で、S3 のキーは `lc-<id>_` で始まり、他のテナントの前方一致と重ならない。

### 11.2 障害注入（Jepsen の形）

- セグメントを上げる途中で、ブローカーの停止、S3 への経路の遮断、`__remote_log_metadata` のリーダーの停止を入れ、`acks=all` で成功を返した書き込みがすべて、ローカルか S3 から順序どおりに読める（[ADR-0002](../decisions/0002-replicated-log-with-tiered-storage.md) の Confirmation）。
- `local.retention.ms` を 1 秒にした試験用のクラスタで、ほぼすべての読み取りを S3 から行わせ、上と同じ検査をする。
- KIP-1023 を有効にして、ブローカーを足して再配置したときに、抜け・重複がない。

### 11.3 結合テスト

- LocalStack ではなく、実際の S3（開発のアカウント）で、マルチパート、503、KMS の失敗を扱う（LocalStack の S3 の振る舞いの差を避ける）。
- CRR：写しを有効にした論理クラスタだけが大阪に写り、無効のものは写らない。
- 戻しの手順：大阪の `_rlmm/` から戻したトピックを読み、元のオフセットと中身が同じ（四半期ごとの演習）。

### 11.4 負荷試験

- 1 つのテナントが 7 日分を最初から読み戻しても、他のテナントの produce の p99（NFR-003）が悪くならない。リモートの読み取りの帯域の上限とテナントのクォータが効く。

## 12. 未解決の問い

### 決定（2026-09-27、既定案）

- **RSM**：Aiven の Apache License 2.0 の実装を土台にし、包む層だけを自前で書く（[ADR-0018](../decisions/0018-s3-remote-storage-manager.md)）。
- **削除のポリシーのトピックはすべて階層型**。テナントは `remote.storage.enable` を変えられない。
- **`local.retention.ms` は 6 時間**。`segment.bytes`・`segment.ms` は [ADR-0010](../decisions/0010-segment-retention-and-compaction-defaults.md) の 256 MiB・1 時間に従う。capacity の領域で見直す。
- **大阪への写しは論理クラスタごとの選択（既定は無効）**。Standard だけに出す。$0.09/GB をすべての論理クラスタに掛けると NFR-010 の目標を超えるため。
- **土台の圧縮とクライアント側の暗号化は使わない**。SSE-KMS に任せる。
- **ディスクレスのトピックは、本家がトランザクションに対応するまで出さない**（[ADR-0020](../decisions/0020-diskless-topics-adoption.md)）。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| 大阪への写しを有効にしたときの料金（1 GB あたりの上乗せ）と、既定を無効にしてよいか | PM と metrics-and-billing の領域。NFR-009 の書き方（「S3 に上がったセグメントだけを大阪から戻せる」を全テナントに約束するか）と合わせて決める |
| KIP-1023 を既定で有効にするか | E4 の障害注入のテストの結果で決める |
| 土台の Aiven の RSM の保守の状況（最新の版が 2025-10）と、本家の 4.x への追従 | E4 の着手時に、本家の最新の版でのビルドと結合テストを確かめる。追従が止まっていれば fork する |
| RLMM に外から登録し直す道具（大阪での戻し）の作り方 | E4。本家の RLMM の公開の API で作れるかを確かめる |
| 圧縮のトピックの容量の上限を超えたときの止め方 | [multi-tenancy-and-quotas.md](multi-tenancy-and-quotas.md) の 6 節の既定（produce の throttle）を、E7 でクライアントの振る舞いを見て確かめる |
| テナントが `retention.ms` を 6 時間より短くしたときに、本家の `local.retention.ms` の検査に当たるか（ブローカーの既定の `log.local.retention.ms` が、トピックの `retention.ms` と比べられるか）。**当たる**（2026-09-27 に本家の 4.3 のソースで確認）。トピックの設定の検査は、ブローカーの既定（`log.local.retention.ms` を `local.retention.ms` として含む）にトピックの指定を重ねてから、`local.retention.ms > retention.ms` を `INVALID_CONFIG` で拒否する（[LogConfig.java](https://github.com/apache/kafka/blob/4.3/storage/src/main/java/org/apache/kafka/storage/internals/log/LogConfig.java) の `validate`・`validateRemoteStorageRetentionTime`、[KafkaConfig.scala](https://github.com/apache/kafka/blob/4.3/core/src/main/scala/kafka/server/KafkaConfig.scala)）。CreateTopics はコントローラーで失敗するので、作成の後にエージェントが直す案は成り立たない。**設計を改めた**：名前空間のパッチの出入口（P1）が、テナントの CreateTopics・AlterConfigs・IncrementalAlterConfigs で `retention.ms` が 6 時間より短いとき、`local.retention.ms = retention.ms` を足して送る（`retention.ms` を戻したときは `local.retention.ms` を 6 時間に戻す）。E4 の `tiered-topic-policy` と E7 の `namespace-request-rewrite` で作る |
| 大阪への写しを有効にした論理クラスタで、`segment.ms` の上限を 1 時間に絞るか（テナントが 7 日にすると、写しが最大 7 日遅れる） | E4。PM と、写しの約束の書き方と合わせて決める |
| 本家の `remote.copy.lag.ms`・`remote.copy.lag.bytes`（KIP-1241。4.4 が目標で、4.3 にはない。2026-09-27 に確認）の扱い | **使わない**（2026-09-27 に改めた）。KIP-1241 は、閉じたセグメントの上げを遅らせて冗長を減らすもので、閉じていないセグメントには効かない（[TopicConfig.java](https://github.com/apache/kafka/blob/trunk/clients/src/main/java/org/apache/kafka/common/config/TopicConfig.java)）。`segment.ms` の上限の代わりにならず、上げを遅らせると大阪で失う範囲が広がる。4.4 を取り込むときは、テナントの設定の許可リストで「運用だけ」にし、既定のまま（遅らせない）にする |
| ディスクレスのトピックの提供の時期 | KIP-1163・1164 の本家への取り込みを四半期ごとに確かめる。S2 の開始の時点で入っていなければ、[ADR-0020](../decisions/0020-diskless-topics-adoption.md) を見直す |

## 13. ADR

| ADR | 決定 |
| --- | --- |
| [0018](../decisions/0018-s3-remote-storage-manager.md) | S3 の RemoteStorageManager は Aiven の Apache License 2.0 の実装を土台にし、テナントの検査と計数の層で包む。キーはテナントの接頭辞で始め、バケットは物理クラスタごとに分ける |
| [0019](../decisions/0019-tiered-storage-lifecycle-and-dr-copy.md) | 削除のポリシーのトピックはすべて階層型にし、ローカルの保持を 6 時間にする。大阪への写しは論理クラスタごとに選べる S3 の CRR と RLMM のスナップショットで行い、日次で監査する |
| [0020](../decisions/0020-diskless-topics-adoption.md) | ディスクレスのトピックは、本家の KIP-1163・1164 が冪等とトランザクションに対応してから、別の種類のトピックとして出す |

## 14. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E1 | `tiered-storage-poc` | 本家の 4.3 ＋ Aiven の RSM ＋ 名前空間のパッチで、キーの形とテナントの前方一致を確かめる |
| E3 | `tiered-boundary-fault-injection` | 11.2 節の障害注入を、耐久性のテストの枠に足す |
| E4 | `rsm-tenant-wrapper` | 包む層：接頭辞の検査、テナントごとの計数、S3 の失敗の分類 |
| E4 | `tiered-bucket-and-iam` | 物理クラスタごとのバケット、SSE-KMS、Pod Identity、ゲートウェイ型のエンドポイント（Terraform） |
| E4 | `tiered-topic-policy` | `remote.storage.enable` の強制（作成時と、`compact` から `delete` への変更の後）、`local.retention.ms` の扱い |
| E4 | `rlmm-snapshot-exporter` | `_rlmm/` のスナップショットの書き出し |
| E4 | `tiered-durability-audit` | 6.7 節の日次の監査と、削除の停止のフラグ |
| E4 | `orphan-sweeper` | 孤児の報告と、条件を満たすものの削除 |
| E4 | `osaka-crr-per-cluster` | 論理クラスタごとの CRR の規則、大阪のバケットのライフサイクル、別のアカウント |
| E4 | `osaka-restore-runbook` | 大阪での戻しの手順と道具、四半期の演習 |
| E4 | `compacted-storage-cap` | 圧縮のトピックの合計の大きさの計数と上限 |
| E7 | `remote-fetch-quota` | 過去の読み戻しをテナントの読み取りのクォータに数える |
| E11 | `tiered-usage-metering` | テナントごとの S3 の保存量（GB-時）と、写しの転送量の計測 |
| E12 | `tiered-storage-dashboards` | 上げる遅れ、リモートの読み取りの待ち行列、S3 の 503、孤児の数 |
| E4 | `follower-fetch-last-tiered-offset` | KIP-1023 の検証（Jepsen の形と性能のテスト）。検証を通すまで既定は無効のまま。E3 の `broker-volume-replacement` と一緒に |
| S2 | `diskless-topics` | [ADR-0020](../decisions/0020-diskless-topics-adoption.md) の条件が満たされたら |

## 15. quality.md・runbooks・data-model への項目

### quality.md

- 上げる遅れ：パーティションごとの「LSO より前の閉じたセグメントのうち、まだ上がっていないバイト数」の最大。目標：30 分以内に上がる。
- 監査の結果：重大な不変条件の破れ 0 件（SC-2）。孤児のバイト数。
- リモートの読み取りの p99 と、待ち行列が満杯になった件数。
- S3 の 503 と 5xx の件数（前方一致ごと）。
- CRR の遅れ（RTC の `ReplicationLatency`）と、15 分を超えた件数。
- ローカルのディスクの使用率（上げる遅れと合わせて見る）。

### runbooks

- `tiered-copy-stalled.md`：上がらない（S3、KMS、RLMM の `min.isr`、長いトランザクション）ときの切り分け。
- `tiered-audit-violation.md`：監査で重大な破れが出たときの、削除の停止、影響の範囲の特定、Kora の表 1 の型との照合。
- `remote-fetch-saturation.md`：リモートの読み取りの待ち行列の満杯と、特定のテナントの読み戻しの絞り方。
- `osaka-restore.md`：東京のリージョンの喪失のときの、大阪での戻し（6.6 節）。
- `tenant-tiered-data-deletion.md`：論理クラスタの削除の後の、東京と大阪の前方一致の削除の確認。

### data-model（索引への追加の提案）

| 置き場所 | 名前 | 中身 |
| --- | --- | --- |
| 制御面（Aurora） | `physical_cluster_buckets` | `pc_id`、`bucket`、`region`、`kms_key_arn`、`dr_bucket`、`dr_account_id` |
| 制御面（Aurora） | `logical_cluster_dr_copy` | `lc_id`、`enabled`、`enabled_at`、`disabled_at`、`replication_rule_id` |
| 制御面（Aurora） | `tiered_audit_runs` | `pc_id`、`started_at`、`finished_at`、`partitions_checked`、`critical_violations`、`orphan_bytes` |
| データ面（KRaft・内部トピック） | `__remote_log_metadata` | 本家の RLMM。セグメントの状態の変化 |
| S3 | `lc-<id>_<topic>-<topicId>/<partition>/…` | セグメント・索引・マニフェスト |
| S3 | `_rlmm/<日付>/partition-<n>.jsonl.zst` | RLMM のスナップショット（エージェントが書く） |

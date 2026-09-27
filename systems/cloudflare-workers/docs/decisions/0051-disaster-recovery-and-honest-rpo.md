---
status: accepted
date: 2026-09-27
---

# ADR-0051: 東京の全体の障害は、関数は自動の迂回、制御プレーンは Aurora の管理された切り替え、ストレージは製品ごとの手動の切り替えで大阪へ移す。RPO は製品ごとの実際の値で示す

詳細は [infrastructure.md](../architecture/infrastructure.md) の 6 節と [runbooks/disaster-recovery.md](../runbooks/disaster-recovery.md)。

## Context

NFR-010 は、ストレージのホームのリージョンの全体の障害で RPO 1 分・RTO 1 時間（手動の移動）を求める。各ストレージの領域は、これを保証できないと報告した。

- KV：DynamoDB のグローバルテーブル（MREC）の複製の遅れ次第。4 KiB を超える値の本体は S3 CRR（[kv-store.md](../architecture/kv-store.md) の 5.5 節）。
- オブジェクトストレージ：S3 CRR。RTC を使っても 99.9% を 15 分以内（[object-storage.md](../architecture/object-storage.md) の 14 節）。
- Durable Objects：S3 に置く前の WAL（最大 10 秒）と CRR の遅れ（[ADR-0031](0031-do-sqlite-replication-and-pitr.md)）。
- キュー：SQS は東京だけ。切り替えない（[queues-and-cron.md](../architecture/queues-and-cron.md) の 8 節）。

AWS の事実（2026-09-27 に確認）：

- DynamoDB の MREC は、ふつう 1 秒以下で非同期に複製し、RPO は複製の遅れ（ふつう数秒）。MRSC は RPO 0 だが、ちょうど 3 つのリージョン（2 つの複製と 1 つの witness でもよい）が要り、東京・大阪・ソウルなどで使える。MRSC は TTL とトランザクションを持たない（[How global tables work](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/V2globaltables_HowItWorks.html)）。
- Aurora Global Database の RPO は「ふつう秒の単位」、管理された切り替え（failover）は数分で終わることが多いが、複製されていない書き込みを失いうる。計画の切り替え（switchover）は RPO 0。PostgreSQL では `rds.global_db_rpo`（20 秒以上）で上限を強制できるが、2 リージョンでは既定のままを勧める（[Using switchover or failover](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-global-database-disaster-recovery.html)）。
- S3 RTC は、ほとんどのオブジェクトを数秒で、99.9% を 15 分以内に複製する（[S3 Replication Time Control](https://docs.aws.amazon.com/AmazonS3/latest/userguide/replication-time-control.html)）。

## Options

1. **関数は GA の迂回（自動）、制御プレーンは Aurora の管理された切り替え、ストレージは製品ごとの手動の切り替え。RPO は製品ごとに実際の値で約束する。NFR-010 の「RPO 1 分」を改める提案をする**
2. NFR-010 を守るため、KV を MRSC、DO の WAL をリージョンをまたいで同期で複製、オブジェクトを 2 つのリージョンへ同期で書く
3. 東京の障害では何も切り替えず、回復を待つ

## Decision

1 を採用する。

| 対象 | 大阪の構成 | 切り替え | RPO（S1 で示す値） | RTO の目標 |
| --- | --- | --- | --- | --- |
| 関数の実行（エッジ） | 大阪が国内の全量を受ける台数（[ADR-0054](0054-capacity-design-point-and-region-sizing.md)） | 自動（GA の健全性）。灰色の障害は `drain` | —（状態なし） | 5 分 |
| 設定の写し（ノード） | 各ノードが持つ | 不要（静的な安定） | — | 0 |
| バンドル | 5 リージョンの S3 に同期で置く | 不要 | 0 | 0 |
| 制御プレーン（Aurora） | Global Database の副、ECS の縮小の構成 | 手動の判断で管理された切り替え。エポックと補正（[ADR-0022](0022-sequenced-change-log-relays-and-lmdb.md)） | 秒の単位（保証なし。`AuroraGlobalDBRPOLag` を示す） | 1 時間 |
| KV（4 KiB 以下の値） | グローバルテーブル（MREC） | 手動（`kv-region-failover`） | 秒の単位（保証なし） | 1 時間 |
| KV（4 KiB を超える値）・オブジェクトストレージ | S3 CRR（RTC を有効） | 手動 | 通常は秒、上限の約束は 15 分（99.9%）。それを超える分は失いうる | 1 時間 |
| Durable Objects（東京のホーム） | WAL とスナップショットの CRR | 手動（`do-region-evacuate`）。古いリージョンの停止を確かめられなければ移さない | 最大 10 秒＋CRR の遅れ（通常は秒、上限の約束は 15 分） | 1 時間 |
| キュー | なし | 切り替えない。回復の後に配る | 失わない（東京の SQS が回復する限り）。東京の SQS の永続の喪失では失う | 東京の回復まで |
| cron | 大阪の待機のスケジューラー、`cron_fires` の複製 | 手動（`cron-region-failover`） | 2 重の起動がありうる | 1 時間 |
| 保存するログ（ClickHouse） | なし（再送用の S3 を大阪へ CRR） | 切り替えない | 最大で取り込みの遅れの分 | 東京の回復まで（新しいログは大阪の S3 に貯める） |
| 使用量 | ノードの spool、Kinesis（各リージョン）、生の束の S3 を大阪へ CRR | 大阪で集計を再開 | 0（束は冪等に再送） | 1 時間 |

- 利用者向けの文書と SLA に、この表の RPO を書く。「RPO 1 分」を約束しない。
- NFR-010 を「関数と設定：RTO 5 分。ストレージのホームのリージョンの全体の障害：RTO 1 時間、RPO は製品ごとの表のとおり」に改める提案を、PM・Ops に出す（README の NFR の表は統合の工程で直す）。
- 手動の切り替えの判断は、東京の障害が 30 分続き、AWS の告知で回復の見込みが 1 時間を超えるとき。判断は Ops の責任者と Dev のテックリードの 2 人。
- 2 を採らない理由：KV の TTL（期限）を MRSC は持たない。DO と オブジェクトの同期の複製は、書き込みの遅延に東京と大阪の往復を足す。S1 の規模と、リージョンの全体の障害のまれさに見合わない。S2 で、データの所在 `jp` の Durable Objects の同期の複製を再評価する。
- 3 を採らない理由：制御プレーンが止まり続けると、新しいデプロイも、不正な利用の停止もできない。

## Consequences

- 良くなること：
  - 利用者が、製品ごとに失いうる範囲を知って選べる。
  - 関数の実行と設定は、東京の障害でも止まらない。
- 引き受けるコスト：
  - intent の「成功を返した書き込みを失わない」は、リージョンの全体の障害では守れない製品がある。
  - 手動の切り替えは、判断と訓練を要する。
  - KV の大きな値は、DynamoDB の項目だけが大阪に届き、S3 の本体が届いていない状態がありうる。切り替えの後、本体のない項目は失われた値として扱い、利用者に知らせる。

## Confirmation

- 半期ごとに、staging で東京の全体の障害の訓練（[disaster-recovery.md](../runbooks/disaster-recovery.md)）を行い、製品ごとの実際の RPO と RTO を記録する。
- 常時の計測：`AuroraGlobalDBRPOLag`、DynamoDB の `ReplicationLatency`、S3 の `ReplicationLatency`・`OperationsFailedReplication`、DO の WAL の転送の遅れ。

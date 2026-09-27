---
status: accepted
date: 2026-09-27
---

# ADR-0009: ブローカーごとに EBS gp3 のログのボリュームを 1 本付け、容量はローカルの保持から出して自動で広げる

詳細は [broker-and-log-storage.md](../architecture/broker-and-log-storage.md) の 2・5 節。

## Context

[ADR-0002](0002-replicated-log-with-tiered-storage.md) は、ローカルのディスクに EBS gp3 を候補にし、インスタンスストアとの比較をこの領域に任せた。耐久性は 3 つの AZ の複製で持ち、古いセグメントは S3 に上げる。

事実（2026-09-27 に確認）：

- gp3：1 GiB〜64 TiB。基本 3,000 IOPS・125 MiB/秒、最大 80,000 IOPS・2,000 MiB/秒。1 桁 ms の遅延。年間故障率 0.2% 以下（[gp3](https://docs.aws.amazon.com/ebs/latest/userguide/general-purpose.html)）。
- io2 Block Express：最大 256,000 IOPS・4,000 MiB/秒、平均 500 µs 未満。年間故障率 0.001% 以下（[io2](https://docs.aws.amazon.com/ebs/latest/userguide/provisioned-iops.html)）。
- Elastic Volumes は止めずに大きくできるが、次の変更まで 6 時間以上空け、小さくはできない（[Modify a volume](https://docs.aws.amazon.com/ebs/latest/userguide/ebs-modify-volume.html)）。
- 本家は XFS と `noatime` を勧め、複数のディスクは RAID なしで使うよう勧める（[Hardware and OS](https://kafka.apache.org/43/operations/hardware-and-os/)）。
- Kora は、階層型の保存でローカルを小さくし、性能のよいディスクを選べるようにした（[Kora](https://vldb.org/pvldb/vol16/p3822-povzner.pdf) の 3.4 節）。

## Options

1. **EBS gp3 を 1 本。XFS**
2. **EBS io2 Block Express を 1 本**
3. **インスタンスストア（NVMe）**
4. **EBS gp3 を複数本（JBOD）**

## Decision

1 を採用する。

- ボリュームはブローカーの ID に結び付け、ノードを入れ替えても同じ AZ で付け替える。
- 容量は「設計点のブローカーの書き込み × (ローカルの保持 ＋ `segment.ms`) ＋ 圧縮のトピック」を 0.85 で割って出す（設計点の負荷で 85%。平均の負荷ではおおむね 60% 以下）。スループットは書き込みとキャッシュに当たらない読み取りの和で出し、型の EBS の基準の帯域（r8g.4xlarge で 625 MB/秒）を上限にする。値は [capacity.md](../architecture/capacity.md) の 4 節と [ADR-0048](0048-broker-design-point-and-cost-model.md) が持つ。
- 使用率 75% で、データ面のエージェントが 25% 広げる（6 時間に 1 回まで）。広げ方は EBS を直接変えず、Strimzi の KafkaNodePool の `storage.size` を変える（[ADR-0032](0032-strimzi-for-physical-clusters.md)。AZ ごとのプールの全台が一緒に広がる）。85% 以上の段階の対応は broker-and-log-storage.md の 5.3 節。
- 2 は、Kafka の書き込みがページキャッシュに入り、ディスクの遅延が produce の遅延に直接効かないので、費用に見合わない。耐久性は複製で持つので、ボリュームの故障率の差は効きにくい。
- 3 は、ノードの入れ替えのたびにローカルの全量を複製し直す。付け替えも広げることもできない。
- 4 は、1 本の上限（64 TiB、2,000 MiB/秒）に届くまで要らない。1 本のディスクの失敗の扱いが増える。S2 で上限に近づいたら見直す。

## Consequences

- 良くなること：
  - ノードの入れ替えでデータを移さない。容量とスループットを別々に、止めずに増やせる。
- 引き受けるコスト：
  - 広げた容量は戻せない。負荷が下がったら、ブローカーごと入れ替える（再配置）ことで小さくする。
  - ボリュームの性能の低下は、ブローカーの遅延として出る。リーダーを外す仕組みが要る（replication-and-durability.md の 5.3 節）。

## Confirmation

- PoC：5.2 節の例の負荷で、produce の p99 と、遅れたコンシューマーの読み取りのスループットを測る（NFR-003、NFR-005）。
- 結合テスト：ノードを消し、同じボリュームを新しいノードに付けて、ログの回復なしに（正しい停止なら）戻る。
- 監視：ボリュームごとの使用率、I/O の待ち時間、スループットの上限への近さ。

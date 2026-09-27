---
status: accepted
date: 2026-09-27
---

# ADR-0019: 削除のポリシーのトピックはすべて階層型にし、大阪への写しは論理クラスタごとに選べる S3 の複製で行う

詳細は [tiered-and-object-storage.md](../architecture/tiered-and-object-storage.md) の 5.3 節、6 節、7 節。

## Context

- ローカルのディスクを小さく保ち、ブローカーの追加・入れ替えを速くするのが、階層型の保存の目的である（[ADR-0002](0002-replicated-log-with-tiered-storage.md)、NFR-007）。
- 本家は、圧縮のトピックを階層型にできない。上がるのは、LSO より前の閉じたセグメントだけ。ローカルの保持は `local.retention.ms`・`local.retention.bytes`。この題材では、セグメントを 256 MiB・1 時間で切り替える（[ADR-0010](0010-segment-retention-and-compaction-defaults.md)）（[Tiered Storage](https://kafka.apache.org/43/operations/tiered-storage/)、[Topic Configs](https://kafka.apache.org/43/configuration/topic-configs/)、2026-09-27 に確認）。
- RLMM の正本は内部トピック `__remote_log_metadata` で、S3 のオブジェクトだけでは有効なセグメントが分からない。
- Kora は、階層型の保存のメタデータの食い違いによるデータの喪失をテスト環境で観測し、階層型のデータとメタデータの予備から、ログの前の部分を戻せるようにしている（[Kora](https://vldb.org/pvldb/vol16/p3822-povzner.pdf) の表 1 と 4.6.2 節）。
- NFR-009 は「S1 では S3 に上がったセグメントだけを大阪から戻せる」とする。
- 東京から大阪への転送は $0.09/GB（AWS Price List API、2026-09-27 に確認）。S3 の RTC は 99.9% を 15 分以内に写す（[S3 RTC](https://docs.aws.amazon.com/AmazonS3/latest/userguide/replication-time-control.html)、2026-09-27 に確認）。NFR-010 の目標は、Standard のトピックで 1 GB の書き込みあたり $0.08 以下。

## Options

階層型の適用：

1. **削除のポリシーのトピックはすべて階層型にし、テナントに外させない**
2. テナントがトピックごとに選ぶ

大阪への写し：

- A. **すべての論理クラスタを写す**
- B. **論理クラスタごとに選べる（既定は無効）**
- C. 写さない（S2 のクラスタの間の複製まで待つ）

写し方：

- X. **S3 の CRR（RTC 付き）＋ RLMM のスナップショットを S3 に書き出す**
- Y. データ面のエージェントが、RLMM を読んでオブジェクトを大阪へ写す

## Decision

1、B、X を採用する。

### ライフサイクルの既定

| 設定 | 値 |
| --- | --- |
| `remote.storage.enable` | 削除のポリシーのトピックで常に `true`。テナントは変えられない |
| `local.retention.ms` | 6 時間（テナントは変えられない）。`retention.ms` が 6 時間より短いトピックは `retention.ms` と同じ値（下の注記） |
| `segment.bytes`・`segment.ms` | 256 MiB・1 時間（[ADR-0010](0010-segment-retention-and-compaction-defaults.md)） |
| `cleanup.policy` の変更 | 階層型のトピックを `compact` にする変更は、本家の検査で `INVALID_CONFIG` になる（本家と同じ）。`compact` から `delete` への変更の後は、データ面のエージェントが `remote.storage.enable=true` を足す |
| 圧縮のトピック | ローカルだけ。論理クラスタごとの合計の上限（[ADR-0026](0026-tenant-quotas-and-tier-limits.md)） |
| 上げる・読む帯域 | ブローカーごとに 200 MB/秒・300 MB/秒 |

### 大阪への写し

- Standard の論理クラスタで、テナントが有効にしたものだけを写す。前方一致 `lc-<id>_` の CRR の規則を論理クラスタごとに作る。
- データ面のエージェントが、有効なセグメントの一覧を 1 時間ごとに `_rlmm/` に書き出し、これは常に写す。
- 削除は写さない。大阪は「最大の保持＋7 日」のライフサイクルと、論理クラスタの削除の手順で消す。大阪のバケットは別の AWS アカウントに置く。
- A を選ばない理由：$0.09/GB だけで NFR-010 の目標を超える。災害復旧を必要としない開発・検証の用途にまで掛けない。
- C を選ばない理由：S1 で、リージョンの喪失に対して何も戻せなくなる。
- Y を選ばない理由：写しの仕組みと再試行を自前で持つことになる。CRR は RTC で遅れを測れる。

### 監査

- 日次で、RLMM の有効なセグメントの範囲の連続、S3 のオブジェクトの存在、保持の違反、孤児、RLMM の複製の間の一致を確かめる。重大な破れはページングし、該当するパーティションの削除を止める。

> 2026-09-27 の注記：本家の 4.3 は、ブローカーの既定の `log.local.retention.ms`（6 時間）がトピックの `retention.ms` を超えると、トピックの作成・設定の変更を `INVALID_CONFIG` で拒否する（[LogConfig.java](https://github.com/apache/kafka/blob/4.3/storage/src/main/java/org/apache/kafka/storage/internals/log/LogConfig.java)、2026-09-27 に確認）。許可リストは `retention.ms` を 1 時間から許すので、1〜6 時間のトピックが作れない。名前空間のパッチ（P1）が、その要求に `local.retention.ms = retention.ms` を足す形に改めた（[tiered-and-object-storage.md](../architecture/tiered-and-object-storage.md) の 12 節）。「テナントは `local.retention.ms` を変えられない」は変えない。

## Consequences

- 良くなること：
  - ローカルのディスクは、おおむね「6 時間＋セグメントの切り替えの間隔」の分で済み、再配置が速い。
  - 階層型の境界を監査でき、Kora が観測した型の事故に気づける。
  - 大阪への写しの費用を、必要なテナントだけが負う。
- 引き受けるコスト：
  - 大阪から戻せるのは、写しを有効にした論理クラスタの、S3 に上がった前の部分だけ。NFR-009 の説明を「写しを有効にしたとき」に絞る必要がある（PM の確認が要る）。
  - 圧縮のトピックはローカルの容量を使い続け、戻せない。
  - 流量の少ないトピックでも 1 時間ごとにセグメントが閉じるので、小さなオブジェクトが増える。

## Confirmation

- 設定のテスト：テナントの API で `remote.storage.enable=false`、`local.retention.ms` の変更が拒否される。`compact` から `delete` に変えたトピックが、一定の時間の中で階層型になる。
- 結合テスト：写しを有効にした論理クラスタだけが大阪に写る。削除は写らない。
- 演習：四半期ごとに、大阪の `_rlmm/` から戻したトピックの中身とオフセットが元と同じであることを確かめる。

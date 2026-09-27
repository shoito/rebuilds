---
status: accepted
date: 2026-09-27
---

# ADR-0045: 大阪への災害復旧は、制御面をウォームスタンバイで持ち、データ面は「書き込みの経路の作り直し」と「写しを有効にした履歴の戻し」に分ける

詳細は [infrastructure.md](../architecture/infrastructure.md) の 8 節と [runbooks/disaster-recovery.md](../runbooks/disaster-recovery.md)。

## Context

- NFR-009：リージョンの障害で、制御面は RPO 1 分・RTO 1 時間。データ面は、S1 では S3 に上がったセグメントだけを大阪から戻せる（[architecture/README.md](../architecture/README.md) の 3 節）。
- [ADR-0019](0019-tiered-storage-lifecycle-and-dr-copy.md) は、大阪への写しを論理クラスタごとの選択（既定は無効）にした。東京から大阪への転送は $0.09/GB で、NFR-010 を超えるため。
- 圧縮のトピックは S3 に上がらない（[ADR-0019](0019-tiered-storage-lifecycle-and-dr-copy.md)）。`__consumer_offsets` と `__transaction_state` も圧縮のトピックである。
- S3 に上がるのは閉じたセグメントだけで、セグメントは 256 MiB か 1 時間で閉じる（[ADR-0010](0010-segment-retention-and-compaction-defaults.md)）。S3 RTC は 99.9% を 15 分以内に写す（[S3 RTC](https://docs.aws.amazon.com/AmazonS3/latest/userguide/replication-time-control.html)、2026-09-27 に確認）。
- Kora は、階層型のデータとメタデータの予備から、ログの前の部分だけを戻せる。上がっていない後ろの部分は戻せない（[Kora](https://vldb.org/pvldb/vol16/p3822-povzner.pdf) の 4.6.2 節）。リージョンの障害には、クラスタの間の複製（Cluster Linking）で、オフセットと API キーを保ったまま切り替える（同 4.6.1 節）。本システムのクラスタの間の複製は S2。
- 制御面は Aurora PostgreSQL（Global Database で大阪へ）。制御面は、KRaft の資源（トピック、設定、ACL）の写しを 30 秒ごとに `kraft_snapshots` に持つ（[control-plane-and-provisioning.md](../architecture/control-plane-and-provisioning.md) の 6.3 節）。

## Options

1. **制御面は大阪にウォームスタンバイ。データ面は常設しない。障害のときに、(a) 同じ論理クラスタの ID・API キー・トピック・ACL で空の書き込みの経路を大阪に作り、(b) 写しを有効にした論理クラスタの履歴を読み取り専用で戻す**
2. 1 に加えて、大阪に物理クラスタを常に待たせる（パイロットライト）
3. 制御面もパイロットライト（大阪は Aurora の二次だけ）

## Decision

1 を採用する。

### 戻せるもの（東京の喪失）

| 対象 | 戻せるか | RPO（目安） | 元 |
| --- | --- | --- | --- |
| 組織、論理クラスタ、API キーのハッシュ、サービスアカウント、ロール、IP の許可リスト、上限、請求 | 戻せる | 通常は秒の単位（Global Database の遅れ）。目標 1 分 | Aurora Global Database |
| トピック、パーティションの数、トピックの設定、ACL | 戻せる | 写しの周期（30 秒）＋ Global Database の遅れ | `kraft_snapshots` |
| 削除のポリシーのトピックのレコード（写しを有効にした論理クラスタ） | 前の部分だけ戻せる | 閉じていないセグメント（最大 1 時間か 256 MiB）＋ LSO で止まった部分＋ CRR の遅れ（99.9% は 15 分以内） | 大阪のバケットと `_rlmm/` |
| 同上（写しが無効） | 戻せない | — | — |
| 圧縮のトピック（Kafka Streams の changelog を含む） | 戻せない | — | — |
| コンシューマーのオフセット、トランザクションの状態 | 戻せない。時刻でのオフセットの指定を案内する | — | — |
| 使用量の生の記録、監査ログ | 戻せる | CRR の遅れ | 大阪へ写したバケット |
| テナントのメトリクスの履歴 | 戻せない | — | — |

### 手順の形

- 制御面：大阪の Aurora を昇格し、ECS の最小のタスクを広げる。RTO 1 時間。
- データ面（a）：大阪に物理クラスタを作り（Terraform と Strimzi）、`kraft_snapshots` から論理クラスタ・トピック・ACL を作り直す。ブートストラップの DNS（`*.<region>`）を大阪の NLB に向ける。API キーはそのまま使える。目標 4 時間（SLA にしない）。
- データ面（b）：写しを有効にした論理クラスタの履歴を、別の名前の読み取り専用のトピックとして戻す（名前の形は E4 で決める）。目標 24 時間。
- 大阪に常設するもの：Aurora の二次、ECS の最小のタスク、VPC とエッジ（NLB と Envoy 2 台）、ブローカーのノードのない EKS 1 つ（Strimzi 入り）、ECR の複製、KMS のキー、証明書（大阪の名前を含む）。
- 2 を選ばない理由：S1 の物理クラスタの大きさ（[capacity.md](../architecture/capacity.md) の 10 節）の待機は、月に数万ドルかかる。待たせても、オフセットと直近のデータは戻らない（複製がないため）。S2 のクラスタの間の複製でまとめて解く。
- 3 を選ばない理由：NFR-009 の制御面の RTO 1 時間に、ECS・ALB・証明書の立ち上げの時間の余裕がない。

## Consequences

- 良くなること：
  - 「何が戻り、何が戻らないか」を利用者と SLA に明記できる。
  - 大阪の待機の費用が小さい（[infrastructure.md](../architecture/infrastructure.md) の 11 節）。
- 引き受けるコスト：
  - NFR-009 の「S3 に上がったセグメントだけを大阪から戻せる」は、写しを有効にした論理クラスタに限られる。NFR-009 の文言の見直しを PM に依頼する（ADR-0019 の Consequences と同じ）。
  - 大阪の EC2 の空きに依存する。リージョンの障害では、他社も大阪に移る。ブローカーの台数の容量の予約はしない（費用）。

> 2026-09-27 の注記：「容量の予約はしない」を一部改めた。コントローラーとエッジが立たないと、書き込みの経路の作り直しが始められないため、1 つの物理クラスタのコントローラー 3 台と Envoy 3 台（AZ ごとに 1 台）だけ、大阪で On-Demand Capacity Reservation を持つ（増える費用は月に約 $654）。ブローカーは予約せず、四半期の `osaka-capacity-check` と年 1 回の訓練で空きを確かめる（[architecture/README.md](../architecture/README.md) の 6 節、[infrastructure.md](../architecture/infrastructure.md) の 8.2 節、[disaster-recovery.md](../runbooks/disaster-recovery.md) の D-1）。**Ops・PM の確認事項。**

  - 大阪で作り直した論理クラスタのオフセットは 0 から始まる。コンシューマーは時刻で位置を決め直す必要がある。

## Confirmation

- 訓練：四半期ごとに、staging で東京の喪失を模し、制御面の切り替え（1 時間以内）、書き込みの経路の作り直し（4 時間以内）、履歴の戻し（中身とオフセットの一致）を行う。
- 監視：Global Database の遅れ、CRR の遅れ（RTC）、`kraft_snapshots` の最新の時刻、KRaft のスナップショットの写しの最新の時刻（[observability.md](../architecture/observability.md) の 7 節）。
- 文書：利用者向けの SLA と文書に、上の表を載せる（法務の確認、intent.md の L6）。

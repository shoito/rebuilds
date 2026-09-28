---
status: accepted
date: 2026-09-28
---

# ADR-0056: 組織の移動は org_id の行の絞りを付けた論理レプリケーションで写して追いつき、数十秒の書き込みの止めの間に照合して置き場所を切り替える

詳細は [infrastructure.md](../architecture/infrastructure.md) の 6 節。

## Context

[ADR-0005](0005-tenancy-and-governor-limits.md) は、組織をセルの間で動かす手順を infrastructure の領域で決めるとした。[ADR-0055](0055-shard-placement-and-stage-criteria.md) は、組織を `shard_no` を変えずに別のクラスタへ動かし、`org_placements` で置き場所を上書きするとした。

- S1 の最大の組織は 5,000 万件（records とピボットで数十 GB、履歴を含めて 100GB を超えうる）。写す間、組織を止め続けられない。
- 組織の行は、主の Aurora の 100 を超える表、`events` のクラスタ、OpenSearch、S3、Valkey にある。
- 監査のハッシュの鎖、変更のイベントの `replay_id`、共有の世代を、移動の前後で続ける必要がある。

PostgreSQL の論理レプリケーションは、PostgreSQL 15 以降で公開（publication）に行の絞り（`WHERE`）を付けられ、初期の同期にも絞りがかかる。`UPDATE`・`DELETE` を公開する時、絞りの列は replica identity に含まれる必要がある。分割の表は `publish_via_partition_root` で根の表の絞りを使える（[Row Filters](https://www.postgresql.org/docs/18/logical-replication-row-filter.html)、2026-09-28 に確認）。Aurora PostgreSQL は論理レプリケーションを持つ（[Aurora PostgreSQL の論理レプリケーション](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/AuroraPostgreSQL.Replication.Logical.html)、2026-09-28 に確認）。

本家は、組織を別のインスタンスへ移す作業で、組織を一定の時間読むだけの状態にすると広く紹介されている（未検証。本システムの止めの長さ（60 秒）は本家に依らず、E12 の `org-migration-tool` で測って決める）。

## Options

1. **`org_id = $1` の絞りを付けた公開を、組織の表の全てに作り、移動の先で購読する。追いついたら、組織を書き込みの止め（`migrating`）にし、差を 0 まで待ち、照合して、置き場所を切り替える**
2. 組織を読むだけにして、ID の範囲ごとに写す（写す間ずっと書けない）
3. アプリで二重に書く（移動の間、元と先の両方に書く）

## Decision

1 を採用する。

- 手順：
  1. 準備：移動の先のクラスタに、同じマイグレーションの版があることを確かめる。組織の `shard_no` の分割が先にあることを確かめる。
  2. 写し：元のクラスタに、組織の表の全てを含む公開 `org_move_<id>` を `WHERE (org_id = '…')`・`publish_via_partition_root = true` で作り、先で購読する（初期の同期と、その後の変更）。
  3. 付随の写し：`events` のクラスタの 3 日分（同じ方法）、S3 の組織の接頭辞（コピーとその後の差分）、OpenSearch（先のセルの索引へ、組織の作り直しのジョブ）。
  4. 追いつきの確認：遅れが 5 秒を下回り続ける。
  5. 書き込みの止め：`orgs.status` の補助の状態 `migrating` にし、新しい書き込みのトランザクションを 503 `ORG_MIGRATING`（`Retry-After`）で断る。読みは元で続ける。Worker の組織の仕事を止める。止めの目標は 60 秒以内。
  6. 差の 0：公開の遅れが 0 になるまで待つ。表ごとの行の数と、ID の範囲ごとのハッシュ（[ADR-0012](0012-derived-copies-consistency-and-projections.md) の整合の検査と同じ関数）で元と先を比べる。
  7. 切り替え：`org_placements` を書き、組織の設定のキャッシュを無効にする。`migrating` を外す。Valkey の組織の鍵は先で作り直す（割り当ては fail open の範囲で数え直す）。
  8. 後始末：購読と公開を消す。元の行は 7 日残し（戻すため）、その後 `admin_cross_org` のロールで消す。
- 監査の鎖・`replay_id`・世代は、行をそのまま写すので続く。錨は組織の `org_id` の単位なので、置き場所に依らない。
- 移動の中止：6 までなら、購読を消して先の行を消し、`migrating` を外すだけで戻る。7 の後の戻しは、同じ手順の逆向きの移動にする。
- 移動の最中の OpenSearch は、先の索引ができるまで元の索引を読む（組織の単位で索引の置き場所を持つ）。
- 2 は、5,000 万件の組織で数時間の書き込みの停止になる。3 は、全ての書き込みの経路とトランザクションの境目を 2 つの DB にそろえることになり、正しさを保てない。

## Consequences

- 良くなること：
  - 大きな組織も、書き込みの止めが数十秒で済む。
  - 移動の前後で、ID・鎖・順の番号が変わらない。
  - 照合で、写しの漏れを切り替えの前に見つけられる。
- 引き受けるコスト：
  - 元のクラスタに、移動の間の論理レプリケーションのスロットと WAL の保持が要る。大きな組織の初期の同期は、元の writer の I/O を使う。夜間に行う。
  - 組織の表の全てを公開に入れ忘れると、写し漏れになる。表の一覧は `org_id` を持つ全ての表から機械的に作り、照合で見つける。
  - DDL は複製されない。移動の間はマイグレーションを止める。

## Confirmation

- 結合テスト（E12）：書き込みを続ける組織を移動し、確定した書き込みが全て先にあり、止めが 60 秒以内。
- 障害の注入：6 の照合で 1 行を欠かせると、切り替えずに止まる。
- 性質ベーステスト：任意の移動の途中で、どの要求も元か先のどちらか一方だけに書く。
- 訓練：staging で四半期に 1 回、最大の組織の写しを移動する（[disaster-recovery.md](../runbooks/disaster-recovery.md) と同じ訓練の枠）。

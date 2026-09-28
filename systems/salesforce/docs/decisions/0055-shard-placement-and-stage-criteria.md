---
status: accepted
date: 2026-09-28
---

# ADR-0055: 論理シャードを物理のクラスタに表で割り当て、組織ごとの上書きを持つ。段階を上げる基準を writer の CPU・保存の量・最大の組織の大きさで決める

詳細は [infrastructure.md](../architecture/infrastructure.md) の 4 節と 5 節。

## Context

[ADR-0005](0005-tenancy-and-governor-limits.md) は、論理シャードを 256 に固定し、`org_id` のハッシュで決め、論理シャードを物理のクラスタに割り当てる表を持つとした。[ADR-0010](0010-record-tables-partitioning-and-pivots.md) は、`orgs.shard_no` を正とし、240〜255 を大口の組織の予約にし、`shard_map(shard_no, cluster_id, state)` を持つとした。段階を上げる判断の基準は infrastructure の領域で決めるとされた（architecture の README の 2 節）。

決めること：

- 組織を、論理シャードとは別に動かせるか（大口の組織を専用のクラスタ・セルへ）。
- `events` のクラスタ、OpenSearch、Valkey を、主のクラスタとどう組にするか。
- S1 → S2 → S3 に上げる時期。

Aurora のクラスタの保存の上限は、Aurora PostgreSQL 17.5 以降で 256 TiB、表の上限は 32 TiB（[Quotas and constraints for Amazon Aurora](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/CHAP_Limits.html)、2026-09-28 に確認）。reader は 1 クラスタ 15 まで（同）。

## Options

1. **`shard_map` に加えて、組織ごとの上書き `org_placements(org_id → cell_id, cluster_id)` を持つ。上書きがあれば優先する。クラスタは「主＋`events`＋OpenSearch のドメイン＋Valkey」の組（セルの中）で持つ**
2. `shard_map` だけ。大口の組織は予約の `shard_no` への付け替えで動かす
3. 組織ごとの割り当ての表だけ（論理シャードを持たない）

## Decision

1 を採用する。

- 組織の置き場所の解決：`org_placements` に行があればそれ、なければ `shard_map[orgs.shard_no]`。結果は組織の設定のキャッシュに持ち、移動の時だけ変える（[ADR-0056](0056-org-migration-by-row-filtered-logical-replication.md)）。
- 組織を別のクラスタへ動かしても `shard_no` は変えない。行の `shard_no` をそのまま写せるので、分割の表の形が移動の前後で同じになる。予約の番号（240〜255）は、作成の時に大口と分かっている組織にだけ使う。
- 1 つのセルは、主の Aurora（writer 1＋reader 2〜5）、`events` の Aurora、OpenSearch のドメイン、Valkey のクラスタ、ECS のサービス一式を持つ。S1 と S2 は 1 つのセルの中に主のクラスタを複数持てる。S3 はセルを増やす。
- 段階を上げる基準（どれか 1 つを 2 週続けて満たしたら、次の段階の準備を始める）：
  - 主の writer の CPU の p95 が 50% を超える。
  - 主のクラスタの保存の量が 20 TiB を超える（上限の 256 TiB の 1 割未満で分け、移動の時間を短く保つ）。
  - 最大の表（`field_history` か `records`）の 1 つの分割が 500GB を超える。
    > 2026-09-28 の注記：`field_history` は S1 から `history` のクラスタに置くことにした（[ADR-0047](0047-field-history-tracking-and-retention.md) の注記）。この基準は主のクラスタでは `records` に、`history` のクラスタでは月ごとの分割（1 つの月が 500GB を超えたら、`history` のクラスタを論理シャードで分ける）に当てる。1 つのセルは `history` の Aurora も持つ。
  - 最大の組織の DB の時間が、クラスタの 20% を常に超える（騒がしい隣人。専用のクラスタの候補）。
  - Sandbox と試用の組織の DB の時間が、クラスタの 30% を超える（S2 の「Sandbox と試用を別のクラスタへ」）。
- 2 は、組織の全ての行の `shard_no` を書き換えるので、移動が「写して書き換える」になり、論理レプリケーションで写せない。3 は、S3 の 50 万の組織の割り当てを 1 件ずつ管理し、新しい組織の置き場所を毎回選ぶことになる。

## Consequences

- 良くなること：
  - 大口の組織を、論理シャードの仲間と切り離して動かせる。
  - 段階の判断が、計測できる値で決まる。
- 引き受けるコスト：
  - 置き場所の解決が 2 段になる。上書きの表を RLS の外の運用の表として持つ。
  - 同じ `shard_no` の分割が、複数のクラスタに存在しうる（上書きで動いた組織の分）。整合の検査は組織の単位で行う。

## Confirmation

- 性質ベーステスト：任意の `shard_map` と `org_placements` で、全ての組織がちょうど 1 つのクラスタに解決される。
- 結合テスト：上書きのある組織の要求が、上書きの先のクラスタにだけ届く。
- 計測：段階の基準の値を、ダッシュボードで毎週見る（[observability.md](../architecture/observability.md)）。

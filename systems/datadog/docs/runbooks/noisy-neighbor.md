# Runbook: うるさい隣人と組織の絞り

- Owner: Ops
- 対応するアラート: 隣人の影響（割り当ての中の組織の、取り込みからクエリまでの p99。上位 1% が 10 分外れたらチケット、全体の 5% で呼び出し）、429 の急増、セルの混雑の段の上がり、インジェスターのメモリーの上限への接近（溢れの急増を伴うとき）
- 最終確認日: 2026-10-09

設計は [ADR-0003](../decisions/0003-tenancy-cells-and-isolation.md)、[ADR-0012](../decisions/0012-intake-quota-coordination.md)、[ADR-0017](../decisions/0017-cardinality-admission-via-control-records.md)、[ADR-0026](../decisions/0026-query-cache-and-admission.md)、[ADR-0064](../decisions/0064-capacity-headroom-and-load-test-gates.md)、[capacity.md](../architecture/capacity.md) の 9.1 節。

## 症状

- 割り当ての中の組織の `svc_tenant_freshness_seconds` の p99 が NFR-002 を外れる。
- 1 つか少数の組織の 429・溢れ・クエリの受け付けの拒否が急に増える。
- セルの混雑の段（混雑 1・2）が上がる。

## 影響

他の組織の取り込みからクエリまでの遅れ（NFR-002）、クエリの p99（NFR-003）、評価の遅れ（NFR-004）を消費する。NFR-007 の約束（割り当ての 10 倍を送る組織がいても他の組織を守る）が崩れている。

## 確認

場面を見分ける（[capacity.md](../architecture/capacity.md) の 9.1 節）。

| 場面 | 見るもの |
| --- | --- |
| 割り当ての超過 | 組織ごとの受けた量と 429。割り当ての 1.25 倍を超えて受けていないか |
| カーディナリティの爆発 | 組織・指標ごとの新しい系列の作成の速さ、溢れの系列、`cardinality_overflow_events` のタグの鍵の上位 3 つ |
| デプロイの嵐 | 有効な系列の入れ替わり（1.2 倍まで）、新しい系列の作成の上限の中か |
| 障害のクエリの嵐 | 組織ごとのクエリの費用、DRR の待ち、ダッシュボードの束の数 |
| 全体の急増 | 全組織の量。割り当ての合計と容量（売りすぎの比 `ops.oversubscription_ratio`） |
| 戻りの殺到 | エージェントの送り直しの量、並行の数の半減が効いているか |
| パーティションの偏り | 組織のパーティションの組 `k` に対して、1 つのパーティションに量が集まっていないか（Express のパーティションあたり 15 MB/秒） |

## 対処

1. **割り当てを下げる**：急増した組織の取り込みの割り当てを一時に下げる（`tenant_quotas` の一時の引き下げ、期限と理由を記録）。その組織は 429 を受け、エージェントはディスクに溜めて待つ。データは失わない。
2. **クエリを絞る**：`ops.query_concurrency_per_tenant` でその組織の並行を下げる（下げるだけ）。
3. **新しい系列を止める**：インジェスターのメモリーが上限に近ければ、割り当てを超えている組織から新しい系列の作成を止める（溢れの系列に入る。[ADR-0006](../decisions/0006-cardinality-policy.md)）。上限の値をコードで変えない。
4. **パーティションの組を広げる**：組織の `k` を上げる（`partition_set_changes`、2 時間以上先の区切りから効く。[ADR-0019](../decisions/0019-partition-mapping-and-head-layout.md)）。急場には効かないので、1〜3 と組み合わせる。
5. **セルの混雑**：全体が溢れているなら、混雑 2（割り当ての 80% を超えた組織にも 429）に上げる。割り当ての中の組織は最後まで受ける。
6. 組織の管理者に知らせる（溢れの知らせは自動。割り当ての引き下げは当番が連絡する）。

## エスカレーション

- 1〜5 で他の組織の SLI が戻らない：Ops の責任者、Dev のテックリード。容量の追加（[capacity.md](../architecture/capacity.md) の 10 節、`capacity-headroom.md` の予定）を判断する。
- 1 つの組織が繰り返す：PM と営業（契約の量、専用のセルの候補。[infrastructure.md](../architecture/infrastructure.md) の 7.2 節）。

## 事後

- 場面と効いた手を記録し、[capacity.md](../architecture/capacity.md) の 9.1 節の場面に足りないものがあれば足す。
- 一時の引き下げを期限で戻したことを確かめる。
- この手順で足りなかったことを、ここに反映する。

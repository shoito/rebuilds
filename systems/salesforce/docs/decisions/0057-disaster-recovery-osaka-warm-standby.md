---
status: accepted
date: 2026-09-28
---

# ADR-0057: 大阪に Aurora Global Database の副と縮めた ECS を置く温かい待機にし、検索の索引と Valkey は切り替えの後に作り直す。切り替えは人が決め、失った範囲を outbox と replay_id で知らせる

詳細は [infrastructure.md](../architecture/infrastructure.md) の 7 節。

## Context

NFR-007 は AZ の障害で RPO 0・RTO 5 分、NFR-008 はリージョンの障害で RPO 1 分以内・RTO 1 時間以内を求める。architecture の README の S1 は「大阪にウォームスタンバイ」とした。

- 主の Aurora と `events` の Aurora は正本と、3 日の再生の置き場所。
- OpenSearch は写しで、作り直せる（[ADR-0031](0031-search-index-and-japanese-analysis.md)）。障害の時は名前の前方一致で答える（`degraded`）。
- Valkey は失われてよい（[ADR-0001](0001-platform-and-stack.md)）。
- データの所在（法務の L6）：大阪は国内。

Aurora Global Database は、計画した切り替え（switchover）では RPO 0、予期しない障害の切り替え（failover）では非同期の複製の遅れの分を失いうる。RPO は普通は秒の単位、RTO は分の単位。管理された failover は、古い主の書き込みを止める試み（write fencing）をするが、確実ではない（[Using switchover or failover in Amazon Aurora Global Database](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-global-database-disaster-recovery.html)、2026-09-28 に確認）。2 つのリージョンだけの時は、`rds.global_db_rpo` を既定のままにすることが勧められている（同）。

## Options

1. **温かい待機：Aurora（主・`events`）の Global Database の副（reader 1 台）、ECS は最小の台数、OpenSearch は小さなドメイン（空）、Valkey は小さなクラスタ（空）。切り替えは人が決める**
2. 冷たい待機：バックアップから大阪で作り直す
3. 東京と大阪の両方で受ける（S3 の形）

## Decision

1 を採用する。S3 で 3 を検討する。

- 切り替えの判断は Ops の当番（IC）が行う。東京の Aurora の writer が 10 分応答せず、AWS の障害の告知か、大阪からの合成監視の失敗が続く時。自動の切り替えはしない（切り替え自体が書き込みを失う操作のため）。
- `rds.global_db_rpo` は設定しない（2 リージョンの推奨）。`AuroraGlobalDBRPOLag` を常に計測し、10 秒を超え続けたら警告する。
- 切り替えの後：
  - OpenSearch は空から作り直す。作り直しが済むまで、全ての組織の検索を `degraded`（名前の前方一致）で答える。組織の作り直しは、有料の本番・ライセンスの多い順に進める。
  - Valkey は空で始まる。メタデータの部品は L3 から作り直す。割り当ては fail open で数え直す（[ADR-0042](0042-org-allocations-fair-queuing-and-limit-info.md)）。
  - Relay は、outbox の未送の行から続ける。`events` の `replay_id` は時刻を含むので、切り替えの前後で逆転しない。失った書き込みの分のイベントは、元から存在しない（正本と一致する）。
- 失った範囲：切り替えの直前の `AuroraGlobalDBRPOLag` の値と、東京が応答しなくなった時刻を記録する。東京が戻ったら、Aurora が作る古い主のスナップショットから、失った書き込み（組織・レコード・メタデータのバージョン）を取り出し、組織ごとに知らせる。自動で書き戻さない（後の書き込みとぶつかるため）。
- S3（一括・レポートの結果、添付、監査の保管）は大阪へ複製する。KMS はマルチリージョンの鍵（[ADR-0052](0052-key-hierarchy-and-per-org-data-keys.md)）。
  > 2026-09-28 の注記：項目の変更の履歴の `history` のクラスタ（[ADR-0047](0047-field-history-tracking-and-retention.md) の注記）も、主・`events` と同じく Global Database の副を大阪に置き、同じ判断で切り替える。
- 2 は、RTO 1 時間に収まらない。3 は、組織ごとの書き手のリージョンを決める仕組みと、リージョンの間の組織の移動が要り、S1 には重い。

## Consequences

- 良くなること：
  - RTO 1 時間の中で、対話の経路と正本を大阪で動かせる。
  - 写し（検索、キャッシュ）を待機させず、費用を抑える。
- 引き受けるコスト：
  - 切り替えの後、検索の質が数時間落ちる。
  - 失った書き込みの組織への知らせと、組織による入れ直しが要る。
  - 大阪の待機の費用（Aurora の副、最小の ECS）が常にかかる。

## Confirmation

- 訓練：staging で四半期に 1 回の failover、本番で年 1 回の switchover（RPO 0）。RTO と、作り直しの時間を記録する（[disaster-recovery.md](../runbooks/disaster-recovery.md)）。
- 計測：`AuroraGlobalDBRPOLag` の p99 が 1 秒以内（NFR-008 の 1 分に余裕を持つ）。
- 結合テスト：Valkey と OpenSearch が空の状態で、対話の経路が動き、検索が `degraded` を返す。

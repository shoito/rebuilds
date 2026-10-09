# Runbook: リージョンの障害と大阪への切り替え

- Owner: Ops
- 対応するアラート: CRR の遅れ（15 分を超える）、Aurora Global Database の遅延（`AuroraGlobalDBRPOLag` 10 秒が 5 分）、東京のリージョンの障害。訓練（半年ごと、E13 の `dr-failover-drill`）
- 最終確認日: 2026-10-09

設計は [infrastructure.md](../architecture/infrastructure.md) の 6 節と [ADR-0061](../decisions/0061-dr-stage-up-and-cell-expansion.md)。目標は NFR-005：管理の面 RPO 1 分・RTO 1 時間、テレメトリー RPO 30 分、取り込みの再開 RTO 1 時間、過去のデータのクエリ RTO 4 時間。

## 症状

- 東京の複数の AZ・リージョンの部品が使えない（AWS の Health Dashboard、selfmon の `canary` の心拍が全信号で欠ける、本番の最小のアラーム）。
- CRR の遅れ・Aurora Global Database の遅延だけが出ている（切り替えの判断の前の段）。

## 影響

切り替えまで、利用者のすべての取り込み・クエリ・評価・通知が止まる。切り替えの後も、失った範囲（最後のチェックポイント・CRR の届いた位置から切り替えまで）のデータはない。

## 確認

1. selfmon（大阪）の Grafana で、東京の取り込み・クエリ・評価・通知の SLI と `canary` の心拍を見る。
2. AWS の Health Dashboard で、東京の障害の範囲と見込みを確かめる。
3. 大阪の待機の状態：Aurora の二次の遅延、S3 の `ReplicationLatency`・`OperationsPendingReplication`、MSK（`express.m7g.large` × 3）、`fleet-ingest` の予備 3 台、EC2 の群れを起こせる容量。

## 対処

切り替えの判断は人（IC と Ops の責任者）が行う。自動では切り替えない。

1. **判断**：東京の回復の見込みが 1 時間を超えるなら切り替える。記録を `dr_events` に始める。
2. **管理の面**：Aurora Global Database の二次を昇格する（計画外のフェイルオーバー）。
3. **MSK**：大阪の MSK を 12 台へ広げ、トピックとパーティションの数を確かめる。
4. **取り込み**：`fleet-ingest` とゲートウェイを起こし、ヘッドのチェックポイントからヘッドを作る。DNS の `intake`・`otlp`・`app`・`api` を大阪へ向ける。エージェントはディスクの待ち行列（2 GB）に溜めた分を送り直す。受け付けの窓（過去 1 時間）の中なら、失った範囲のデータも戻る。
5. **読み手・評価・インデクサー**を起こす。`monitor-evaluator` は水位を待ち、欠けた時間は「不完全」として評価する。失った範囲では、データなし・回復の遷移をしない。
6. **失った範囲**を組織ごとに記録し、クエリが「不完全」の印を返すことを確かめる。公表のページで知らせる。
7. **自己監視**：本番が大阪に来ると selfmon と同じリージョンになる。selfmon の最小の写し（アラームと `canary`）を東京に起こす（[self-monitoring-path-failure.md](self-monitoring-path-failure.md) の場面 3）。東京が使えない間は、本番の大阪の最小のアラームで見る。
8. **確かめ**：見張りの照合で、失った範囲が 30 分以内であること。取り込みの再開が 1 時間以内、過去のクエリが 4 時間以内であること。

### 東京へ戻す（計画作業）

1. 東京の回復を確かめ、大阪で受けた時間のブロック・セグメントを東京へ写す。
2. Aurora を東京へ戻し（計画したフェイルオーバー）、DNS を戻す。
3. 大阪を平常の構成（管理の面のウォームスタンバイ、小さな MSK、群れ 0 台）に縮める。

## エスカレーション

- 切り替えの判断：IC と Ops の責任者。Dev のテックリード、PM（告知）、法務（告知の文面、データの所在の約束。L2・L7）。
- 大阪で EC2 の群れを起こせる容量が足りない：AWS のサポートに容量を求め、起こせる部品から順に（取り込み → 評価 → クエリ）起こす。

## 事後

- 失った範囲、RPO・RTO の実績、手順の詰まりを記録し、`changes/` に起票する。
- 訓練の結果（MSK を広げた時間、ヘッドを作った時間）で、この手順と [infrastructure.md](../architecture/infrastructure.md) の 6.4 節を直す。

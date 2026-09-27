# Runbook: 災害復旧（AZ の障害、リージョンの障害、複製の遅れ、戻し、訓練）

- Owner: Ops
- 対応するアラート: AZ の障害（複数のサービスで 1 つの AZ のターゲットが不健全）、大阪からの合成の監視の連続の失敗、`AuroraGlobalDBRPOLag`（東京 → 大阪）の超過、訓練（四半期に 1 回）
- 最終確認日: 2026-09-27

構成と目標は [infrastructure.md](../architecture/infrastructure.md) の 7 節、方針は [ADR-0039](../decisions/0039-city-cells-and-osaka-warm-standby.md) にある。目標は NFR-007（AZ の障害で RPO 0・RTO 5 分、リージョンの障害で RPO 1 分・RTO 30 分）。

## 症状

| 場面 | 見え方 |
| --- | --- |
| A. AZ の障害 | 1 つの AZ の loc-ingest・rt-gateway・Valhalla・Aurora のインスタンスが不健全。AWS Health に東京の 1 つの AZ のイベント。geo-index・dispatch の主の役の引き継ぎが起きる |
| B. リージョンの障害 | 東京の入口（`api`・`loc`・`rt`）が応答しない。大阪からの合成の監視がすべて失敗する |
| C. 複製の遅れ | `AuroraGlobalDBRPOLag`（`core`・`money`）が 30 秒を超え続ける（東京は正常） |
| D. 戻す | B の後、東京へ戻す計画作業 |
| E. 訓練 | 四半期に 1 回（staging）、年 1 回（本番の計画した切り替え） |

## 影響

- A：数十秒、遷移のコミットが失敗し、アプリが送り直す。配車の検索は待機が答える。乗車の記録は失わない。
- B：切り替えまで（目標 30 分以内）、新しい依頼を受けられない。進行中の乗車は、ドライバーのアプリが通信なしで進める（到着・乗車の開始・降車）。緊急の通報は、端末が 110・119 の画面を開け、運用への知らせは端末に残って送り直される。Aurora の複製の遅れの分（通常は秒の単位、目標 1 分以内）の遷移と依頼が大阪に届かない。遷移は端末の記録から戻す。
- C：この状態で B が起きると、失う範囲が広がる。

## 確認

1. AWS Health と Grafana の AZ ごとの内訳で、1 つの AZ か、リージョン全体かを見分ける。
2. Aurora のクラスタのイベント、Kinesis・DynamoDB・SQS のエラー、ALB の健全性を見る。
3. リージョンの障害を疑うときは、大阪の合成の監視と、別の回線からの到達の両方で確かめる。
4. **`AuroraGlobalDBRPOLag`（`core`・`money`）の直近の値を記録する。** 失う範囲の目安になる（B で使う）。
5. 今の `region_gen` と `ops.region.writable`（AppConfig）を記録する。
6. 進行中の乗車の数（`accepted`〜`awaiting_fare`）と、オンラインのドライバーの数を、最後に取れた値で記録する。

## 対処

### A. AZ の障害

基本は自動で回復する。

1. インシデントを宣言する（SEV2 から。[incident-response.md](incident-response.md)）。
2. geo-index と dispatch のリースの持ち主を見る。主が落ちた AZ にいたなら、待機がリースを取ったこと（`lease_epoch` が増えた）を確かめる。
3. 残る AZ の loc-ingest・rt-gateway・valhalla-eta の CPU と接続を見る。平常の 2/3 を超えていれば、最小のタスク数を上げる。
4. Aurora `core`・`money` が別の AZ へ切り替わったことを確かめる。5 分たっても writer がなければ、手動で切り替える。
5. Valkey `rt` がレプリカへ切り替わったことを確かめる。`rt_resync_total` の急増は正常な振る舞い（アプリが API で読み直す）。
6. `trip_timer_lag_seconds` と `trip_outbox_oldest_seconds` が平常に戻ることを確かめる。
7. AZ が回復したら、台数を平常に戻す。geo-index・dispatch の主と待機が別の AZ にいることを確かめる（同じ AZ に寄っていれば、待機を入れ替える）。

### B. リージョンの障害（東京 → 大阪）

**切り替えの判断は、インシデントの指揮者（IC）が行い、Ops の責任者が承認する。** AWS の見込みで 20 分以内に回復しそうなら、待つことも選ぶ（切り替えると、戻した乗車の確認と、失った依頼の案内が要る）。

1. SEV1 を宣言し、乗客・ドライバー・事業者へ告知する（ステータスページ、事業者の管理画面の連絡先）。
2. **東京の書き込みを止める。** 届くなら、東京の AppConfig で `ops.region.writable` を `none` にし、東京の api・trips・payments・loc-ingest・rt-gateway のタスク数を 0 にする。届かなくても次へ進む（Aurora の write fencing はベストエフォートで、分断が起こりうる。[infrastructure.md](../architecture/infrastructure.md) の 6 節）。
3. **失う範囲を記録する。** 「確認」の 4 の値と、東京が応答しなくなった時刻を、インシデントの記録に書く。
4. **Aurora を切り替える。** `core` と `money` の Global Database の大阪の二次を昇格させる。
   - 東京の writer が生きていれば switchover（RPO 0）。
   - 応答しなければ、計画外の切り替え（`aws rds failover-global-cluster --allow-data-loss`、大阪で実行）。`money` を先にし、支払いの結果不明を増やさない。
   - 大阪の reader を 1 台足す。
5. **世代を上げる。** 大阪の AppConfig で `region_gen = 現在 + 1`、`ops.region.writable = apne3`。以後、割り当ての比較は `(region_gen, assignment_epoch)` になり、東京で使われた epoch と衝突しない。
6. **アプリを広げる。** 「DR：大阪を有効化」のワークフローで、大阪の各サービスのタスク数を東京と同じにする（状態ファイルは大阪のバケット）。valhalla-eta は起動に時間がかかるので最初に始める。Valkey を平常の大きさにする。
7. **入口を切り替える。** Route 53 の `api`・`loc`・`rt`・`operator`・`share` のレコードを大阪の ALB・CloudFront のオリジンにする（TTL 60 秒）。
8. **索引と配車が温まるのを見る。** アプリの位置が大阪の `loc-<city>`（空だったストリーム）に届き始め、geo-index が 35 秒の後に `READY` になる。大阪の空の `geo_shard_leases` から、geo-index と dispatch がリースを取る。
9. **進行中の乗車を戻す。**
   1. ドライバーのアプリは、つながった先に `TripSnapshot` と journal を送る。trips が署名を確かめ、DB にない遷移・乗車を `restored` の印で戻し、新しい世代の epoch で割り当てを結び直す（[ADR-0022](../decisions/0022-trip-outbox-and-offline-continuation.md)）。
   2. `trip_restored_total` と `trip_conflicts_total` を見る。戻した乗車と食い違いは、運用の確認の一覧に出る（`trip-restore-after-failover.md`、[trips-lifecycle.md](../architecture/trips-lifecycle.md) の 14 節）。
   3. `requested` のまま失われた依頼は戻せない。乗客のアプリは「依頼が見つからない」を出す。告知で依頼し直しを案内する。
10. **支払いを結び直す。** payments-workers が、`pending_send`・`unknown` の操作を PSP に照会して確定させる（[payments-and-payouts.md](../architecture/payments-and-payouts.md) の 9 節）。失われた依頼の与信は、照会で見つけて取り消す。確定の遅れた乗車の確定を再開する。
11. **緊急の通報を確かめる。** 大阪の safety-intake が、端末に溜まっていた `SafetyIncident` を受けていることを、`safety_incident_unacked` と担当の画面で確かめる。受けていない通報が 30 秒を超えたら、当番を呼ぶ（[incident-response.md](incident-response.md) の「緊急の通報の受け付けの失敗」）。
12. **受け付けを段階的に再開する。**
    1. 合成の配車の依頼と合成の緊急の通報が大阪で成功することを確かめる。
    2. 受け入れの上限（[capacity.md](../architecture/capacity.md) の 4 節）を平常の 50% にして依頼を受け始め、15 分ごとに上げる。再接続の殺到（アプリ・位置の `backlog`）で位置の取り込みが遅れていないかを見る。
13. 乗客・ドライバー・事業者へ、再開と影響（障害の直前の依頼が失われたこと、戻した乗車の運賃の確認）を告知する。

### C. 複製の遅れ

1. `AuroraGlobalDBRPOLag` が 30 秒を超えたら、AWS Health と Aurora の書き込みの量（大きなバッチの更新、マイグレーションのバックフィル）を見る。バックフィルが原因なら止める。
2. 60 秒を超えたら呼び出し。東京が正常なら、切り替えはしない。
3. `rds.global_db_rpo` で書き込みを止めて RPO を守る設定は、2 リージョンの構成では、切り替えの後に書き込みが止まる恐れがあるので使わない（[Aurora Global Database のディザスタリカバリ](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-global-database-disaster-recovery.html)、2026-09-27 に確認）。

### D. 戻す（大阪 → 東京）

別の計画作業として行う。平日の夜に、事前に告知する。急がない。

1. 東京のリージョンと、Aurora の東京の二次（計画外の切り替えの後、Aurora が自動で二次として加え直す）が追いついていることを確かめる。計画外の切り替えのときに Aurora が作った古い東京のスナップショット（`rds:unplanned-global-failover-...`）は、失った範囲の調べのために手動のスナップショットに写して残す。
2. 受け入れの上限を下げ、`requested` の依頼を減らす。
3. Aurora の switchover（RPO 0）で東京へ戻す（`money` を先に）。
4. 東京の AppConfig で `region_gen = 現在 + 1`、`ops.region.writable = apne1`。東京のタスク数を戻す。
5. Route 53 を東京へ戻す。東京の `loc-<city>` と `geo_shard_leases` から、索引と配車が温まるのを見る。
6. 大阪の台数を縮小したウォームスタンバイへ戻す。

### E. 訓練

| 訓練 | 頻度 | 中身 | 合格の基準 |
| --- | --- | --- | --- |
| 計画外の切り替え | 四半期に 1 回（staging） | `loc-loadgen`・`rider-loadgen`・`driver-bot` で L1 の半分の負荷をかけ、Aurora の複製を止めて 30 秒後に B の手順で切り替える。その後 D | 失った範囲 1 分以内、RTO 30 分以内、戻した乗車の数が「確認」の 6 と整合、二重の割り当て 0、二重の請求 0 |
| 計画した切り替え | 年 1 回（本番、利用の少ない時間帯） | D の逆の手順で大阪へ移し、数時間運用して戻す | 失った範囲 0、RTO の実測 |
| AZ の障害 | 半年に 1 回（staging） | FIS で 1 つの AZ を切り離す | `dispatch_decision` の悪い事象が 5 分で平常、乗車の記録の損失 0 |

- 訓練のたびに、RTO の内訳（判断、Aurora、ECS、Valhalla の起動、DNS、索引）と、大阪の Fargate の起動の成否（容量）を記録し、[infrastructure.md](../architecture/infrastructure.md) の 7.2 節の目安を置き換える。

## エスカレーション

- B の判断：Ops の責任者（承認）、Dev のテックリード（乗車の復元）、お金の持ち主（支払いの結び直し）、安全の責任者（緊急の通報）、PM（告知）。
- B の 9 で `trip_conflicts` が 100 件を超える、または戻した乗車に二重の割り当ての疑い → Dev のテックリードを呼ぶ。二重の割り当ては SEV1 の別の場面として扱う。
- 東京の分断（切り替えの後も東京で書き込みが続いた疑い：切り替えの後の時刻の行が東京のスナップショットにある） → IC に上げ、東京の入口とタスクが本当に止まっているかを確かめる。お金の持ち主と照合を始める。
- 個人情報の漏洩の疑いが出たら → [incident-response.md](incident-response.md) と `personal-data-breach.md`（[security.md](../architecture/security.md) の 14 節）。

## 事後

- 調査結果を `changes/` の新しい `intent.md` として起票する（Maintain 段）。
- 失った依頼の数、戻した乗車の数、食い違いの数と解決の時間、支払いの結び直しの結果を記録する。
- RTO の内訳を、infrastructure.md の 7.2 節に反映する提案を Dev に出す。
- この手順で足りなかったことを、ここに反映する。

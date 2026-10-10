# Runbook: リージョンの障害と大阪への切り替え

- Owner: Ops
- 対応するアラート: Aurora Global Database の遅延（`AuroraGlobalDBRPOLag` 10 秒が 5 分。page）、東京のリージョンの障害。訓練（半年ごと、E18 の `dr-failover-drill`）
- 最終確認日: 2026-10-10

設計は [infrastructure.md](../architecture/infrastructure.md) の 7 節と [ADR-0071](../decisions/0071-osaka-dr-and-stage-up-criteria.md)。目標は NFR-005：AZ の障害で RPO 0、リージョンの障害で RPO 1 分・RTO 1 時間。

## 症状

- 東京の複数の AZ・リージョンの部品が使えない（AWS の Health Dashboard、大阪の `canary` の購入・表示の失敗、本番の最小のアラーム）。
- Aurora Global Database の遅延だけが出ている（切り替えの判断の前の段）。

## 影響

切り替えまで、全ショップのストアフロント（キャッシュのないページ）・チェックアウト・管理画面・Admin API が止まる。エッジのキャッシュのあるページは `stale-if-error`（1 日）で出続ける。切り替えの後も、失った範囲（最大 1 分）の注文・決済の記録はない。カート（Valkey）は引き継がない。検索は作り直しの間（数時間）、名前の前方一致に落ちる。

## 確認

1. 大阪の `canary` の結果と、AWS の Health Dashboard で、東京の障害の範囲と回復の見込みを確かめる。
2. 大阪の待機：全ポッドと全体の Aurora の二次の遅延、S3 の写しの遅れ、ECR・KMS・AppConfig の写し、ECS のサービスの定義。
3. 予定したセールが進行中か（`flash_sales`）。進行中なら、事業者への知らせを先に用意する。

## 対処

切り替えの判断は人（IC と Ops の責任者）が行う。自動では切り替えない。

1. **判断**：東京の回復の見込みが 1 時間を超えるなら切り替える。`dr_events` に記録を始める。
2. **チェックアウトの受け付けを止める**（`ops.checkout_enabled`、全体）。
3. **全体の Aurora の二次を昇格**（計画外のフェイルオーバー）。
4. **全ポッドの Aurora の二次を昇格**（並行 10）。
5. **ECS を広げる**：全体の面（`shop-directory`・`identity`・`edge-router`・`waiting-room`）→ ポッドの `checkout`・`storefront-*`・`workers`・`relay` の順。Valkey を広げる（空で始まる）。
6. **元を切り替える**：KeyValueStore の `sys:region` を `osaka` にする（`fn-route` が大阪の VPC origin を選ぶ）。
7. **照合を全ポッドで回す**：決済と注文（照会の API で、最後の 1 分に決済が済んで注文の行が届いていないものを、決定表で注文を作るか返金する）、在庫の照合（R1〜R4）。チェックアウトの行も届いていない決済は、翌日の `payment-reconciliation-daily` で見つけて返金する。
8. **チェックアウトを開ける**。OpenSearch の索引を Aurora から作り直し始める（その間、検索は前方一致）。
9. **失った範囲**（ポッドごとの時刻の範囲）を `dr_events` に記録し、状況のページで知らせる。

### 東京へ戻す（計画作業）

1. 東京の回復を確かめ、Global Database の管理された切り替え（switchover）で東京へ戻す。
2. `sys:region` を `tokyo` に戻し、大阪を平常の構成（ポッドのサービスはタスク 0）に縮める。
3. 東京の OpenSearch の索引を、大阪の間の変更で作り直す。

## エスカレーション

- 切り替えの判断：IC と Ops の責任者。Dev のテックリード、PM（告知）、法務（告知の文面、データの所在。L3）。
- 大阪で Fargate のタスクを起こせる量が足りない（**未検証**）：AWS のサポートに容量を求め、`checkout` → `storefront-renderer` → 他の順に起こす。

## 事後

- RPO・RTO の実績、失った範囲、手順の詰まりを記録し、`changes/` に起票する。
- 訓練の結果（昇格の時間、ECS を広げた時間、照合の件数）で、この手順と [infrastructure.md](../architecture/infrastructure.md) の 7.2 節を直す。

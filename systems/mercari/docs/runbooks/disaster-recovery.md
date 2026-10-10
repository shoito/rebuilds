# Runbook: 大阪への切り替え（DR）

- Owner: Ops の責任者、IC
- 対応するアラート: Aurora Global Database の遅延（`AuroraGlobalDBRPOLag` 10 秒が 5 分。page）、東京のリージョンの障害、半年ごとの DR の訓練
- 最終確認日: 2026-10-10

構成と順序は [infrastructure.md](../architecture/infrastructure.md) の 7 節（[ADR-0073](../decisions/0073-aurora-layout-osaka-dr-and-ledger-rpo.md)）。目標はリージョンの障害で RPO 1 分・RTO 1 時間（NFR-011）。

## 症状

- 東京のリージョンの複数の部品（Aurora、ECS、ALB）が同時に使えない。AWS の Health Dashboard にリージョンの障害が出ている。
- または、大阪への複製の遅れ（`AuroraGlobalDBRPOLag`）が続き、ledger の commit が `rds.global_db_rpo = 60` で止まっている。

## 影響

- 購入・取引・振込・配送の受け付けが止まる。売上金の反映が遅れる。
- ledger の commit の停止の間、残高での購入の引き当ては 503。カードの購入と取引の遷移は進み、仕訳の事象は core の outbox に溜まる。

## 確認

1. 遅れだけか、リージョンの障害か。遅れだけなら、ledger の commit の待ち（[observability.md](../architecture/observability.md) の 5 節）と、複製の遅れの原因（書き込みの急増、ネットワーク）を見る。切り替えない。
2. 東京の回復の見込み。AWS の発表と、各部品の状態。
3. 大阪の準備：二次のクラスタの遅れ、ECR・AppConfig・Secrets Manager の写し、複数のリージョンの鍵、固定の IP の登録。

## 対処

**遅れだけのとき**

1. ledger の書き込みの急増なら、大型の企画の日の照合の頻度を戻す、Worker の並列を下げる。
2. `rds.global_db_rpo` を外さない（plan のポリシー検査で拒まれる）。止まりが長く利用者に影響するときは、Ops の責任者と財務の判断で値を広げる（変更の記録を残す）。

**切り替え（IC と Ops の責任者が決める。東京の回復の見込みが 1 時間を超えるとき）**

1. 大阪の AppConfig で `ops.purchase_enabled`・`ops.payouts_enabled`・`ops.carrier_enabled.*` を止める。
2. 切り替えの始まりの時刻を `dr_events` に書く。`deadline-runner` は止めたままにする。
3. ledger・core・content の二次を管理されたフェイルオーバーで昇格する（並行）。二次のリージョンのパラメーターのグループは既定のまま（`rds.global_db_rpo` を置かない）。
4. ECS を広げる（`identity`・`app-api`・`transactions` → 他のサービス → Worker）。Valkey を広げる。セッションと `listingVisible()` の写しは core から作り直す。
5. エッジの元を大阪の ALB へ向ける。
6. OpenSearch のドメインを作り、スナップショットから戻す（並行。数時間。待たない）。その間、検索は `ops.search_degraded_mode` で core の読み出しの写しからの「カテゴリの新着」だけを返す。
7. 照合：出品と取引、取引と台帳、直近 10 分の支払いの試行の提供者への照会、配送の照会。
8. 期限をずらす：終わっていない取引の生きている期限を、止まった時間だけ後ろへずらす（1 万件ずつ。[transactions-and-state-machine.md](../architecture/transactions-and-state-machine.md) の 7.3 節）。終わったら `dr_events` に戻した時刻を書き、`deadline-runner` を再開する。
9. 購入と配送の受け付けを開ける。
10. 取引と台帳の照合の不一致が 0 になってから、振込を開ける。
11. 失った範囲（クラスタごとの時刻の範囲）を記録する。失った 60 秒以内の仕訳は、core の outbox の事象の出し直しと提供者の照会で作り直し、残りは日次の 3 者の照合で仮勘定に入れて財務が確かめる。

**東京へ戻す**：計画作業として Global Database の switchover（RPO 0）で行う。購入を止める時間帯を決め、上の 1〜10 と同じ確かめをする。

## エスカレーション

- 昇格の後に照合の不一致が残る：SEV1。Dev のテックリードと財務。
- 大阪の Fargate の起動が遅く RTO を超えそう：AWS のサポート。起こすサービスの順を守り、購入の経路を先にする。

## 事後

- RPO・RTO の実測、失った範囲、照合の結果を `dr_events` と振り返りに残す。
- 半年ごとの訓練では、staging で同じ手順を回し、ECS の起動の時間と OpenSearch の戻しの時間を測る（`dr-failover-drill`）。

# Runbook: 大阪への切り替え（リージョンの障害）

- Owner: Ops の責任者、IC
- 対応するアラート: Aurora Global Database の遅延（`AuroraGlobalDBRPOLag` 10 秒が 5 分。page）、東京のリージョンの障害、半年ごとの DR の訓練
- 最終確認日: 2026-10-10

構成と順序は [infrastructure.md](../architecture/infrastructure.md) の 7 節（[ADR-0077](../decisions/0077-data-stores-layout-and-osaka-dr.md)）。目標はリージョンの障害で RPO 1 分・RTO 1 時間（NFR-011）。

## 症状

- 東京の複数のサービス・Aurora の書き込みが続けて使えず、AWS の Health Dashboard がリージョンの障害を示す。
- 大阪の二次の遅れ（`AuroraGlobalDBRPOLag`）が伸び続ける。ledger は `rds.global_db_rpo = 60` で主の commit が止まりうる。

## 影響

- 予約・決済・送金・PMS の書き込み・iCal の取り込みが止まる。検索は OpenSearch を戻すまで「一時的に検索できない」。
- 失う範囲は、切り替えの時の複製の遅れの分（ledger は 60 秒以内）。

## 確認

1. 東京の回復の見込み。1 時間を超えるなら切り替えを決める（IC と Ops の責任者）。
2. 各クラスタ（core・ledger・content・vault）の二次の遅れ。
3. 大阪の AppConfig・ECR・Secrets Manager・KMS の複数のリージョンの鍵が使えるか。

## 対処

1. 大阪の AppConfig で `ops.booking_enabled`・`ops.payouts_enabled`・`ops.ical_import_enabled`・`ops.partner_api_enabled.*` を止める。`deadline-runner` を止め、止めた時刻を `dr_events` に書く。
2. 4 クラスタの二次を昇格する（管理されたフェイルオーバー、並行）。
3. ECS を広げる（`identity`・`app-api`・`availability`・`booking` → 他 → Worker）。Valkey を広げ、空室の写しを core から作り直す。
4. エッジの元を大阪の ALB に向ける。
5. OpenSearch のドメインを作り、スナップショットから戻し、その後の outbox の事象で追いつく（並行。予約は待たない）。
6. 照合：`stay_claims`、180 日、予約と台帳、直近 15 分の決済の試行の提供者への照会。決済が成功したのに予約がないものは、運用の待ち行列で返金か `reserveStay` での再作成を決める（排他の制約が二重を拒む）。
7. 仮押さえ・リクエスト・見積もり・T&S の `hold`・レビューの期限を、止めた時間だけ後ろへずらす。`payout_release_at` はずらさない。
8. 検索 → 予約 → PMS の書き込み → iCal の取り込みの順に開ける。予約と台帳の照合が 0 になってから送金を開ける。

## エスカレーション

- RTO の 1 時間を超えそう：PM に利用者への知らせを依頼する。決済の提供者と提携銀行に、大阪の固定の IP からの接続を知らせる。
- 失った範囲に確定した予約があった：CS と安全の担当（ゲストが泊まる所を失う前に代わりの宿）。

## 事後

- 失った範囲（クラスタごとの時刻の範囲）と、照合の結果を `dr_events` に残す。
- 東京へ戻すのは計画作業で、Global Database の switchover（RPO 0）で行う。
- 半年ごとの訓練で、ECS の拡大の時間と OpenSearch の戻しの時間を測り、ここに反映する（**未検証**の値）。

# Runbook: 災害復旧（大阪への切り替え）

- Owner: Ops
- 対応するアラート: CRR の遅れ（`ReplicationLatency` が 15 分を超える）、Aurora Global Database の遅延（`AuroraGlobalDBRPOLag` 10 秒が 5 分）、東京のリージョンの障害（[README.md](README.md) の 4 節）。訓練
- 最終確認日: 2026-10-09

手順の設計は [infrastructure.md](../architecture/infrastructure.md) の 6 節と [ADR-0048](../decisions/0048-disaster-recovery-and-content-pending.md)。

## 症状

- 東京の Aurora・S3・ECS のどれかが、リージョンの単位で長く使えない。
- AZ の障害（1 つの AZ）は、この手順を使わない。Aurora の自動のフェイルオーバーと ECS の起動し直しで戻る（RPO 0・RTO 5 分）。

## 影響

- 切り替えまで、同期・API・共有リンク・アップロードが止まる。
- 切り替えで、Global Database の複製の遅れの分の commit（目標 1 分以内）を失いうる。CRR の遅れの分のブロック（目標 15 分以内）が大阪にないことがある。
- `epoch` を上げるので、全端末が木を読み直す（2 時間の窓に散らす）。端末の手元の変更は Synced と比べるので失わない。

## 確認

1. 東京の障害がリージョンの単位か（AWS Health、複数のサービス、合成監視の東京と大阪の差）。
2. 大阪の待機の状態（[infrastructure.md](../architecture/infrastructure.md) の 6.6 節の確認）：Aurora の二次の遅れ、CRR の遅れ（`OperationsPendingReplication`）、大阪の AppConfig とクライアントの最低のバージョンが東京と同じか。
3. 東京が短く戻る見込みがあるか。自動では切り替えない。失う commit と全端末の読み直しの費用が大きいため。

## 対処（切り替え）

切り替えは IC と Ops の責任者が決める。ワークフロー（`dr-failover-workflow`）が次を順に行い、各段の結果を記録する。

1. 東京の入口を止め、`ops.writes_enabled = false`、`ops.uploads_enabled = false`（大阪の AppConfig にも当てる）。
2. Aurora を大阪で昇格する（計画外のフェイルオーバー）。古い一次の書き込みの停止は最善努力なので、東京の `api` のタスクを止めたことを確かめる。
3. `platform_state` の `epoch` を上げ、`dr_failover_at` を記録する。プラットフォームの事象に残す。
4. `dr-content-check` を始める：`dr_failover_at` の前 60 分に確定したリビジョンのブロックを大阪の `blocks` で確かめ、欠けたものを `content_pending_blocks` に入れ、リビジョンを `content_state = pending` にする。
5. 大阪のサービスを広げる（`api`・`auth`・`notify`・`link`・`relay`）。Aurora の reader を 3 台に広げ、木の一覧を専用のエンドポイントで読む。
6. CloudFront のオリジンを大阪へ。`content` の `/b/*` は大阪の写しから読む。
7. `ops.writes_enabled = true`、`ops.uploads_enabled = true`。合成監視の結果を IC に返す。

### 切り替えの後

- 古い `epoch` のカーソルは 409 `reset`。`reset` の応答の `retry_after` で、端末の読み直しを 2 時間の窓に散らす（[capacity.md](../architecture/capacity.md) の 3.3 節）。全端末の読み直しの完了の目標は 4 時間。
- `pending` のリビジョンのダウンロードは 503 `content_pending`。手元のファイルのハッシュが合う端末が、通常のアップロードで欠けたブロックを送り、そろえば `ready` に戻る。`dr-content-check` の残りの数を見る。
- outbox は大阪の `relay` が未送信の行から流し直す。Worker と Webhook は重複を受けても同じ結果になる。

### 失った範囲

- 失った commit は、その commit を出した端末の手元に中身が残っている。端末は読み直しの後、Synced と Remote の差として計画し直し、中身を上げ直す（競合のコピーになることがある）。
- 東京が戻らず、どの端末も持たないブロックを指すリビジョンは `lost` にし、前のリビジョンを残して持ち主に知らせる。`lost` の数を SEV1 の報告に入れる（NFR-005 の中身の RPO 15 分を超えたものを数える）。

## 対処（東京へ戻す）

1. 東京のリージョンの回復を確かめ、東京の Aurora を Global Database の二次として作り直し、追いつかせる。
2. 東京の `blocks` へ、大阪で受けたブロックが大阪 → 東京の CRR で写ったことを確かめる。東京に残っていたブロックで `pending` の残りを埋める。
3. 計画作業として、平日の利用の少ない時間に Aurora の switchover（RPO 0）で戻す。番号が保たれるので `epoch` を上げない。
4. CloudFront のオリジンを東京へ戻す。大阪を待機の大きさへ戻す。

## 訓練の合格基準

staging で四半期ごと、本番の switchover を年 1 回（E13 の `dr-failover-drill`）。

| 項目 | 合格 |
| --- | --- |
| メタデータ | RPO 1 分以内、RTO 1 時間以内（メタデータの API が使えるまで） |
| 中身 | CRR を止めた間のブロックが、すべて `pending` になる（数が一致する）。合成監視の端末からの送り直しで `ready` に戻る。`lost` が 0（訓練では東京が戻る前提） |
| 端末 | 読み直しの間、commit の p99 が 2 秒を超えない。全端末の読み直しが 4 時間以内 |
| 戻し | switchover で `epoch` が変わらず、カーソルの取り直しが起きない |

## エスカレーション

- 切り替えの判断：IC と Ops の責任者。Dev のテックリードを呼ぶ。
- `lost` が 1 件以上：SEV1。持ち主への知らせの文面は法務と相談する（漏えい等の報告の要否は法務の L4、約束は L9）。

## 事後

- 失った commit の数、`pending` と `lost` の数、読み直しの時間を記録し、`changes/` に起票する。
- DR の後の取り直しを失った commit を見た端末だけに絞る改良（[architecture/README.md](../architecture/README.md) の 6 節の持ち越し）の判断の材料にする。

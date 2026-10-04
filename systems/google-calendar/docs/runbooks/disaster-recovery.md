# Runbook: 災害復旧（大阪への切り替え）

- Owner: Ops
- 対応するアラート: DR の複製の遅延（`AuroraGlobalDBRPOLag` 10 秒が 5 分）、リージョンの障害、大阪の待機の構成の異常（[README.md](README.md) の 4 節）。定期作業：DR の訓練（staging 四半期、本番の switchover 年 1 回）
- 最終確認日: 2026-10-04

決定は [ADR-0044](../decisions/0044-disaster-recovery-and-calendar-side-effects.md)、構成は [infrastructure.md](../architecture/infrastructure.md) の 5・6 節にある。

## 症状

- 東京のリージョンの障害で、予定の読み書き・リマインダー・配送が広く止まり、回復の見込みが立たない。
- 複製の遅延が続き、東京が失われたときの RPO 1 分を守れない恐れがある。
- 大阪の待機の構成の確認（合成監視、SES の受信のテスト、Terraform の差分、レプリカ、AppConfig の一致、クォータ）が失敗した。

## 影響

RPO 1 分以内・RTO 1 時間以内（NFR-007）。切り替えると、全クライアント（Web・API・CalDAV）のトークンが 410 になり、取り直す。

## 確認

1. 東京の障害の範囲（AWS Health、合成監視、Aurora の状態）。AZ の障害なら切り替えない（自動のフェイルオーバーで足りる。[infrastructure.md](../architecture/infrastructure.md) の 6.2 節）。
2. 複製の遅延（`AuroraGlobalDBRPOLag`）の今の値。失う範囲の見込み。
3. 大阪の確認の最新の結果：AppConfig の `tzdata.active_version` と `ops.*` が東京と同じか。違えば切り替えの前に合わせる。

## 対処（切り替え）

切り替えは IC と Ops の責任者が決める。エージェントは判断しない（[roadmap.md](../roadmap.md) の「エージェントに任せないこと」）。手順は DR のワークフローで自動化し、各段の結果を記録する。

1. 東京の入口を止める：CloudFront のオリジンを保守の応答に、`alb-dav` の WAF を全拒否に。`ops.writes_enabled = false`。
2. Aurora の計画外のフェイルオーバーで大阪を昇格させる。古い一次の障害の時点のスナップショットがあれば、手動のスナップショットにコピーする。
3. **`sync_epoch` を上げる**：全カレンダーの `epoch` を 1 つ上げる。失った範囲の `change_seq` が、大阪で別の変更に振り直されるため（[ADR-0005](../decisions/0005-change-log-and-sync-tokens.md)）。
4. **`dr_epoch_started_at` を記録する**（`platform_state`）。
5. 大阪のサービスを広げる：`api` 45 タスク、`caldav` 20 タスク、Aurora の reader を 3 台（取り直しの殺到に備える。[capacity.md](../architecture/capacity.md) の 5.4 節）。`notifier` と `reminder-scheduler` を業務の時間の下限の台数に。
6. `ops.writes_enabled = true` にし、CloudFront のオリジンと `dav.<brand>.<domain>` の DNS を大阪へ切り替える。
7. 大阪からの合成監視（Web の API と CalDAV が 410 から取り直して一致すること、iMIP の往復、リマインダー）を確かめる。

### 失った範囲の副作用

| 副作用 | 確かめること |
| --- | --- |
| 外部への iMIP の `SEQUENCE` | `dr_epoch_started_at` の後、外部の参加者のいる予定の最初の送信で、`SEQUENCE` が 1 つ余分に上がっている（`seq_margin_epoch`）。2 回目は上がらない |
| リマインダーの重複 | 大阪の `reminder-scheduler` が `dr_epoch_started_at − 2 分` より前の項目を送らずに数えている。重複は `dr_window` の印で、NFR-003 の重複の率から分けて報告する |
| Webhook・Web Push・メールの通知 | 取り消さない。全部の Webhook の経路へ `exists` を 1 回送り、受け手に差分の同期をさせる |
| 外部からの iMIP の受信 | 障害の間は MX 20 の大阪が受ける。東京の回復の後、`imip-inbound` が東京の S3 の一覧から未処理のメールを拾い直す（同じ `Message-ID` は捨てる） |
| 送信の上限の数（Valkey） | 大阪は空から数え直す。迷惑な送信の上限が一時的に緩むので、Complaint の率を見る |

## 対処（東京へ戻す）

1. 東京の回復の後、Aurora が東京を二次として加え直すのを待つ。
2. 計画作業として switchover（RPO 0）で戻す。番号が保たれるので `sync_epoch` を上げない。
3. CloudFront のオリジン、`dav` の DNS、AppConfig を東京へ戻し、大阪を待機の台数に縮める。

## 訓練の合格基準

| 項目 | 基準 |
| --- | --- |
| RPO | 1 分以内（失った範囲の `change_seq` の数を記録） |
| RTO | 1 時間以内（判断から書き込みの再開まで） |
| 取り直し | 合成監視のクライアント（Web の API と CalDAV）が 410 から取り直し、全件と一致する。取り直しの殺到の間、範囲の読み出しの p95 1 秒以内、30 分で平常へ戻る（[capacity.md](../architecture/capacity.md) の L8） |
| iMIP | 切り替えの後の外部への次の `REQUEST` の `SEQUENCE` に余白が 1 つ付く |
| リマインダー | 重複は `dr_window` に数えられ、送り漏れ 0 |
| tzdb | 大阪の `tzdata.active_version` が東京と同じ |

## エスカレーション

- 切り替えの判断：IC と Ops の責任者。顧客への告知は PM と法務（データを失った範囲の扱い）。
- RTO を超えそうなら、AWS のサポートと経営に知らせる。

## 事後

- 失った範囲（時刻、`change_seq` の数、外部へ出た副作用の数）を記録し、`changes/` の新しい `intent.md` として起票する。
- 手順で足りなかったことを、ここと [infrastructure.md](../architecture/infrastructure.md) の 6 節に反映する。

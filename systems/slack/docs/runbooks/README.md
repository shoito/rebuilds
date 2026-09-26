# Runbooks: Slack

Ops が持つ運用の文書。品質の判定基準は [quality.md](../quality.md) の 4 節にある。

## 1. SLI と SLO

| SLI | SLO | 許容範囲を外れたときの扱い | 品質の判定に使う |
| --- | --- | --- | --- |
| 送信 → 表示の遅延 p99 | 500ms 以内（NFR-002） | 15 分続いたらアラート | |
| 投稿 API の成功率 | 99.9%（NFR-004） | エラーバジェットの消費が早すぎたら、新機能のリリースを止める | |
| クライアントの欠損検知率（`seq` の飛びを検知して差分を取りに行った割合） | 1% 未満 | 急増したら配信系の障害を疑う | ○ |
| 未読数の不一致率（クライアントとサーバーの突合） | 0.1% 未満 | 超えたら QA に共有する | ○ |

「品質の判定に使う」に○がある指標は、QA が品質の判定基準に使う。定義を変えるときは QA と合意する。

## 2. テナント単位の上限と負荷

特定のワークスペースが共有の資源を占有しないよう、テナント単位で上限を設ける（ADR-0009）。**上限の値の正は [rate-limiting.md](../architecture/rate-limiting.md) の 4 節と、プランごとの値（[ADR-0032](../decisions/0032-plans-and-entitlements.md)）にある。** 下の表は、運用でよく見るものの抜粋である。上限を一時的に厳しくする・緩める操作は、ワークスペース単位の上書き（ADR-0032）で行い、監査ログに残す。

| 対象 | 上限（MVP） | 超えたとき |
| --- | --- | --- |
| メンバー数 | 5,000 | 招待を拒否する |
| 投稿のレート | 1 メンバーあたり 1 秒に 1 件、1 ワークスペースあたり 1 秒に 200 件 | 429 を返す |
| ストレージ | プランごとに定める | アップロードを拒否する |
| MCP の呼び出し | 1 トークン 1 分に 60 回（読み取り）・10 回（書き込み）、1 ワークスペース 1 秒に 50 回 | JSON-RPC のエラーで `retry_after` を返す（[mcp.md](../architecture/mcp.md)） |
| 通知の push | 1 ワークスペース 1 秒に 200 件 | 遅らせる（[read-state-and-notifications.md](../architecture/read-state-and-notifications.md)） |
| 検索 | 1 メンバー 1 分に 30 回 | 429 を返す（[search.md](../architecture/search.md)） |

- API・DB・Gateway の主要な指標には `workspace_id` のラベルを付け、上位のテナントを見られるようにする。カーディナリティを抑えるため、上位 N 件以外は「その他」にまとめる。
- 1 つのテナントが全体の負荷の一定割合（例：DB 時間の 30%）を超え続けたら、アラートを出す。

## 3. リリースとロールバック

- すべての新機能は、フィーチャーフラグの裏に置く。
- 社内ワークスペース → 5% → 25% → 100% の順に広げ、各段で 1 節の指標を確認する。
- 指標が許容範囲を外れたら、フラグを切って戻す。ロールバックはデプロイではなくフラグで行う。
- 本番へのリリースは Ops が承認する。

## 4. アラートと手順

「作成済み」以外の手順は、各 Epic の実装に合わせて [templates/runbook.md](../../../../docs/templates/runbook.md) から作る。

| アラート | 手順 | 状態 |
| --- | --- | --- |
| SLO の速いバーンレート、合成監視の連続失敗 | [incident-response.md](incident-response.md) | 作成済み |
| デプロイ中の自動ロールバック、デプロイ後の悪化 | [deploy-and-rollback.md](deploy-and-rollback.md) | 作成済み |
| AZ・リージョンの障害 | [disaster-recovery.md](disaster-recovery.md) | 作成済み |
| outbox の最古の行の経過時間、`outbox_dead` の増加、未処理件数の増加 | `relay-backlog.md`（Relay のリースの交代を含む） | E4 で作成 |
| SQS の DLQ に 1 件以上、キューの最古のメッセージの経過時間 | `dlq-reprocess.md` | E4 で作成 |
| 切断コード 4003・4029 の急増 | `gateway-overload.md` | E4 で作成 |
| Web Push の 404/410 の急増、SES のバウンス率 | `notification-delivery.md`（VAPID の鍵の交換を含む） | E5 で作成 |
| `search_index_lag` の p99 が 10 秒超、indexer の DLQ | `search-indexing.md` | E6 で作成 |
| ファイルが `scanning` のまま 15 分超、`blocked` の発生 | `file-scanning.md` | E6 で作成 |
| ログインの失敗の急増、OTP の到達率の低下 | `auth-anomalies.md` | E2 で作成 |
| MFA を失った利用者からの回復の依頼 | `mfa-recovery.md`（本人確認の手順） | E2 で作成 |
| SSO の障害、IdP の証明書の更新 | `sso-troubleshooting.md` | E8 で作成 |
| Better Auth などの依存のセキュリティ勧告、セキュリティインシデント | `security-incident.md`（個人情報保護委員会への報告を含む） | E7 で作成 |
| 鍵・秘密情報のローテーションの失敗 | `key-rotation.md` | E7 で作成 |
| 削除の処理の遅れ・失敗、リーガルホールドの設定 | `data-deletion.md` | E8 で作成 |
| MCP の呼び出しの急増、書き込みの異常 | `mcp-abuse.md`（クライアントの遮断を含む） | E9 で作成 |
| アプリへの配信の失敗の急増、配信先の無効化、配信の遅れ | `app-event-delivery.md` | E12 で作成 |
| アプリの濫用（スパム、過剰な読み取り） | `app-abuse.md`（インストールの停止を含む） | E12 で作成 |
| 特定のワークスペース・アプリの 429 の急増、上限の一時的な変更 | `tenant-throttling.md`（[rate-limiting.md](../architecture/rate-limiting.md) の 5 節） | E7 で作成 |
| 系列数が AMP の上限の 80%、Terraform のドリフトの検出 | `observability-and-drift.md` | E7 で作成 |

## 5. 定期作業と訓練

| 作業 | 頻度 | 手順 |
| --- | --- | --- |
| カオス試験（Valkey・Gateway・Relay を順に停止） | 月 1 回、ステージング | E7 で作成 |
| バックアップからの復元訓練（削除の再適用を含む） | 四半期に 1 回 | [disaster-recovery.md](disaster-recovery.md) |
| 大阪への切り替え訓練（東京の Terraform の状態ファイルを使わずに行う） | 年 1 回 | [disaster-recovery.md](disaster-recovery.md) |
| Gateway のデプロイ中の k6 試験 | リリース前 | [deploy-and-rollback.md](deploy-and-rollback.md) |
| キャパシティの見直し | 月次 | [capacity.md](../architecture/capacity.md) の 5 節 |
| 外部のペンテスト | 年 1 回と、大きな機能の前 | [security.md](../architecture/security.md) の 10 節 |

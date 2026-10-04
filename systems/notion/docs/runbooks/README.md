# Runbooks: Notion

Ops が持つ運用の文書。品質の判定基準は [quality.md](../quality.md) の 4 節、SLI の計測の仕組みは [observability.md](../architecture/observability.md) にある。**SLO の値とアラートの一覧の正本はこの文書** で、observability.md の 2 節（SLI）と 5 節（アラート）はこれを計測・実装する側の記述である。値を変えるときは、この文書を先に直し、observability.md を合わせる。

## 1. SLI と SLO

observability.md の 2 節の SLI に、NFR から導いた SLO を付けたもの。

| SLI | SLO | 許容範囲を外れたときの扱い | 品質の判定に使う |
| --- | --- | --- | --- |
| 編集の反映の遅延（サーバーの区間：受け付け → Gateway が他の接続へ送り終える） | 500ms 以内の割合 99%（NFR-001） | 速いバーンレートで呼び出し | |
| トランザクションの成功率（5xx でない割合。429・権限・検証の拒否は成功） | 99.9%（NFR-007） | 速いバーンレートで呼び出し。エラーバジェットを使い切ったら、修正以外のデプロイを止める | |
| ページの表示（RUM。最初の 1 画面の描画） | ローカルにないとき p75 1.5 秒、あるとき p75 300ms（NFR-002） | 24 時間の値が目標を外れたらチケット | |
| データベースのビューの問い合わせ（1 万行以下） | p95 1 秒（NFR-003） | 1 時間の値が目標を外れたらチケット | |
| 同期の滞留：outbox の最古の行（論理シャードごと） | 5 秒以内 | 30 秒を 5 分超えたら呼び出し | |
| 同期の滞留：クライアントの未確定の最古（接続中の利用者） | 30 秒以内の利用者が 99% | 30 秒を超える利用者が 1% を超えたら呼び出し | ○ |
| 検索への反映（`search_index_lag`） | 30 秒以内の割合 99%（NFR-006） | 遅いバーンレートでチケット | ○ |
| 権限の監査の不一致（検索・通知・API の結果を判定関数で判定し直す） | 0 件（NFR-010） | 1 件で呼び出し（SEV1） | ○ |
| オフラインの統合の失敗（再接続時に恒久的に送れなかった件数） | 0 件を目標（NFR-005） | 1 件でも QA に共有する | ○ |
| クライアントの欠損の検知（ページの `seq` の飛び） | 1% 未満 | 急増したら配信の障害を疑う | ○ |
| 衝突の記録（`sync_conflicts`）の件数（種類ごと） | 目標なし。過去 4 週との差 | 2 倍を超えたら QA に共有する | ○ |
| ロールアップ・行をまたぐ数式の反映 | p99 5 秒以内 | 15 分続いたらチケット | |
| Webhook の配送の遅れ | p95 1 分、p99 5 分 | 15 分続いたらチケット | |
| リマインダーの発火の遅れ | p99 2 分 | 15 分続いたらチケット | |

- SLO の窓は 30 日（月次）。エラーバジェットとバーンレートは、この窓で計算する（[observability.md](../architecture/observability.md) の 5 節）。
- 「品質の判定に使う」に○がある指標は、QA が品質の判定基準に使う。定義を変えるときは QA と合意する。
- 復旧の目標：AZ の障害は RPO 0・RTO 5 分（NFR-008）、リージョンの障害は RPO 15 分・RTO 4 時間（NFR-009）。受け付けた変更は失わない（NFR-004）。
- 保持の値：ゴミ箱 30 日、完全に削除の後 30 日、履歴 30 日（MVP）、操作のログ 30 日、バックアップ 35 日（[security.md](../architecture/security.md) の 7 節）。

## 2. テナント単位の上限と負荷

特定のワークスペース・ページが共有の資源を占有しないよう、上限を設ける。値の正は各文書にあり、下の表は運用でよく見るものの抜粋である。一時的な変更は `rate_limit_overrides`（ワークスペース・連携ごと）で行い、Ops が承認して監査ログに残す。

| 対象 | 上限（S1） | 超えたとき | 正 |
| --- | --- | --- | --- |
| 1 ワークスペースのトランザクション | 1 秒に 200 件 | 429 と `retry_after` | [capacity.md](../architecture/capacity.md) の 3.5 節 |
| 1 利用者のトランザクション | 1 秒に 20 件 | 同上 | 同上 |
| 1 トランザクション | 操作 1,000、500 KB | 拒否 | [block-model.md](../architecture/block-model.md) の 10 節 |
| 1 ページのブロック | 10 万（5 万で警告） | 追加を拒否 | 同上 |
| 1 データソースの行 | 25 万 | 拒否 | [databases.md](../architecture/databases.md) の 11 節 |
| 検索 | 1 利用者 1 分に 60 回 | 429 | [search.md](../architecture/search.md) の 6.4 節 |
| 公開 API | 1 連携 1 分に 180 回（Business 以上は 600 回） | 429 `rate_limited` | [api-and-integrations.md](../architecture/api-and-integrations.md) の 5 節 |
| MCP の `search` | 1 利用者 1 分に 30 回 | 429 | 同上の 8.1 節 |
| 1 ページへの書き込み | 1 秒に 50 件を目標（超えたら打鍵のまとめを 250ms に広げる） | 在席の配信を間引く | [collaboration.md](../architecture/collaboration.md) の 13 節 |

- API・DB・Gateway の主要な指標に、ワークスペースの上位 N 件（初期値 50）＋「その他」のラベルを付ける。論理シャード（480）は常にラベルにしてよい（ヒストグラムを除く）。
- 1 つのワークスペースが、そのクラスタの DB 時間の 30% を 15 分超えたら、チケットにする（[observability.md](../architecture/observability.md) の 4 節）。

## 3. リリースとロールバック

流れの正は [delivery.md](../architecture/delivery.md)、手順は [deploy-and-rollback.md](deploy-and-rollback.md)。

- すべての新機能は、フィーチャーフラグの裏に置く。割り当ての単位はワークスペース。
- 社内のワークスペース → 5% → 25% → 100% の順に広げ、各段で 24 時間以上、1 節の指標を見る。
- マイグレーションは群れ G0 → G1 → G2 → G3 の順に当て、台帳で全 480 シャードに当たるまで、それに頼るアプリをデプロイしない（[ADR-0031](../decisions/0031-migration-rollout-by-shard-groups.md)）。
- 戻すのはまずフラグ、次にアプリ。マイグレーションは戻さず、前へ進める修正で直す。
- デスクトップは 1% → 10% → 50% → 100% の段階的な自動更新。戻すときは、中身を戻した新しいバージョンを出す。
- 再シャーディングの間は、マイグレーションを含むリリースを止める（[ADR-0028](../decisions/0028-zero-downtime-resharding.md)）。
- 本番へのリリースは Ops が承認する。

## 4. アラートと手順

「作成済み」以外の手順は、表の Epic の実装に合わせて [templates/runbook.md](../../../../docs/templates/runbook.md) から作る。アラートの閾値は [observability.md](../architecture/observability.md) の 5 節。アラートの設定そのものは E8 の `slo-dashboards-and-alerts` で作る。「状態」の列は、手順を作る Story を示す。

| アラート | 重さ | 手順 | 状態 |
| --- | --- | --- | --- |
| 編集の反映の遅延・トランザクションの成功率の速いバーンレート、合成監視の 2 回連続の失敗 | 呼び出し | [incident-response.md](incident-response.md) | 作成済み |
| 権限の監査の不一致が 1 件以上 | 呼び出し（SEV1） | [incident-response.md](incident-response.md)、`security-incident.md` | 作成済み／`security-incident.md` は E8 の `security-incident-runbook` で作成 |
| 同期の滞留（outbox の最古の行、クライアントの未確定の最古） | 呼び出し | [incident-response.md](incident-response.md) の「同期の滞留」 | 作成済み |
| 物理クラスタの writer の CPU、1 シャード・1 ワークスペース・1 ページの占有 | チケット（CPU 80% で呼び出し） | [incident-response.md](incident-response.md) の「重いシャード」 | 作成済み |
| デプロイ中の自動ロールバック、デプロイ後の悪化、マイグレーションの台帳の失敗・停滞 | 通知・チケット | [deploy-and-rollback.md](deploy-and-rollback.md) | 作成済み |
| AZ・リージョンの障害、`AuroraGlobalDBRPOLag` が 5 分を超える | 呼び出し | [disaster-recovery.md](disaster-recovery.md) | 作成済み |
| 検索への反映の遅延の遅いバーンレート、indexer の DLQ、`search-acl` の遅れ | チケット | `search-indexing.md`（再索引、別名の切り替えを含む） | E6 の `search-indexer` で作成 |
| メールのバウンス率、push の失敗の急増、受信箱の計画の遅れ | チケット | `notification-delivery.md` | E6 の `email-and-push-notifications` で作成 |
| Webhook の配送の失敗の急増、egress での拒否の急増、停止した購読の急増 | チケット | `webhook-delivery.md` | E7 の `webhooks` で作成 |
| `age(datfrozenxid)` が 10 億を超える、デッドタプルの増加、`pg_stat_statements` の上限 | 呼び出し | `db-maintenance.md`（VACUUM、周回の回避、480 スキーマの統計） | E8 の `db-maintenance` で作成 |
| 物理削除の遅れ（期限を過ぎて残る行）、削除のジョブの失敗、完全に削除したページの復元の依頼 | チケット | `data-deletion.md`（ADR-0022 の 3 段、ワークスペースの削除、運用者による復元） | E8 の `data-deletion-worker` で作成 |
| 公開サイトの通報、自動の検査での保留、フィッシングの報告 | チケット | `abuse-takedown.md`（`publishing_suspended`、CDN の無効化、所有者への通知） | E8 の `abuse-reporting-and-takedown` で作成 |
| セキュリティインシデント（漏洩の疑い、依存の勧告、鍵の漏洩） | 呼び出し | `security-incident.md`（証拠の保全、個人情報保護委員会への報告の判断を含む） | E8 の `security-incident-runbook` で作成 |
| 論理レプリケーションのスロットの WAL が 100 GB を超える（再シャーディング） | 呼び出し | `resharding.md`（ADR-0028 の段 0〜6、中止と戻し） | E9 の `reshard-automation` で作成 |
| 影の読み取りの、遅延で説明できない不一致が 1 件以上 | チケット（再シャーディングを止める） | `resharding.md` | E9 の `reshard-shadow-reads` で作成 |
| CDC のスロットの WAL が 100 GB を超える、取り込みの遅れ | 呼び出し | `data-lake.md`（スロットを捨ててエクスポートからやり直す） | E9 の `cdc-data-lake` で作成（S2 の CDC） |

## 5. 定期作業と訓練

| 作業 | 頻度 | 手順 |
| --- | --- | --- |
| 復元訓練（1 つの物理クラスタを PITR で隔離した VPC に復元。大阪のスナップショットからも。1 つのワークスペースだけを戻す手順を含む） | 四半期に 1 回 | [disaster-recovery.md](disaster-recovery.md) の D |
| 大阪への切り替え訓練（staging で最後まで。S2 からは複数の物理クラスタの並列の昇格を含む） | 年 1 回 | [disaster-recovery.md](disaster-recovery.md) の B・D |
| 再シャーディングの訓練（staging で物理 1 → 2。切り替え中の k6 で確定の消失 0 件、書き込みの待ち 10 秒以内、影の読み取りの説明できない不一致 0 件、戻しでデータが一致） | S2 の最初の分割の前に 1 回。以後、分割の前ごと | `resharding.md`（E9）、[ADR-0028](../decisions/0028-zero-downtime-resharding.md) の Confirmation |
| 負荷試験（k6）：モデルの 1 倍・2 倍、AZ の喪失、再接続の殺到、巨大なページ・データベース、1 シャードへの集中 | リリース前、四半期 | [capacity.md](../architecture/capacity.md) の 6 節 |
| Gateway のデプロイ中の k6（確定したトランザクションの消失 0 件） | リリース前 | [deploy-and-rollback.md](deploy-and-rollback.md) |
| キャパシティの見直し（論理シャードの偏りを含む） | 月次 | [capacity.md](../architecture/capacity.md) の 6 節 |
| 夜間の 480 シャードへのマイグレーションの試し当て（staging） | 毎日 | [delivery.md](../architecture/delivery.md) の 2.2 節 |
| 外部のペンテスト（公開サイト・埋め込み・MCP を含む） | 年 1 回と、大きな機能の前 | [security.md](../architecture/security.md) の 10 節 |

## 6. 作成済みの手順

| 手順 | 内容 |
| --- | --- |
| [deploy-and-rollback.md](deploy-and-rollback.md) | デプロイ、マイグレーションの群れ、ロールバック、デスクトップの配布の停止 |
| [disaster-recovery.md](disaster-recovery.md) | AZ・リージョンの障害、データの論理的な破損、復元訓練 |
| [incident-response.md](incident-response.md) | インシデントの共通の進め方、重いシャード、同期の滞留 |

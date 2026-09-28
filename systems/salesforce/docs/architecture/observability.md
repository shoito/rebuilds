# Observability: Salesforce

ログ・メトリクス・トレース、SLI と SLO、組織ごとの資源の使用量（DB の時間）、騒がしい隣人の検知、アラートと runbook の対応。土台は [ADR-0001](../decisions/0001-platform-and-stack.md)（OpenTelemetry（ADOT）→ AMP、X-Ray、CloudWatch Logs、Managed Grafana）と [ADR-0042](../decisions/0042-org-allocations-fair-queuing-and-limit-info.md)（組織ごとの DB の時間を 1 分の桶で数える）。この文書で決めたことは、次の 2 つの ADR にある。

- **SLI は経路ごとに、合成監視とサーバーの計測で持つ。** 組織ごとの使用量は DB の表に全件を持ち、メトリクスにはクラスタごとの上位 50 の組織だけをラベルで出す。ログとトレースは組織の ID を持ち、個人データを入れない（[ADR-0058](../decisions/0058-slis-and-per-org-resource-metrics.md)）。
- **騒がしい隣人は、アプリの DB の時間と、DB の側の実行中のセッションの標本の 2 つで見つける。** 自動の対処は Worker の重みまでにし、対話の経路の絞りは人が決める（[ADR-0059](../decisions/0059-noisy-neighbor-detection-two-sources.md)）。

指標の定義・SLO・アラートは Ops が持つ。品質として許容できるかの基準は QA が `quality.md` で持つ（[process.md](../../../../docs/process.md) の 11 節）。

## 1. 道具

| 種類 | 道具 | 保持 |
| --- | --- | --- |
| メトリクス | ADOT → Amazon Managed Service for Prometheus、Grafana | 13 か月（AMP の既定の保持は 150 日で、ワークスペースの設定で 1,095 日まで延ばせる。395 日に設定する。[AMP のワークスペースの設定](https://docs.aws.amazon.com/prometheus/latest/userguide/AMP-workspace-configuration.html)、2026-09-28 に確認） |
| ログ | JSON の構造化ログ → CloudWatch Logs。検索は Logs Insights | 30 日（[security.md](security.md) の 7 節） |
| トレース | OpenTelemetry → X-Ray | 30 日（X-Ray のトレースの保持は 30 日で固定。[X-Ray concepts](https://docs.aws.amazon.com/xray/latest/devguide/xray-concepts.html)、2026-09-28 に確認） |
| 組織ごとの使用量 | Aurora の `org_*_minutes` の表 | 1 分の粒度 7 日、1 時間の粒度 13 か月 |
| 合成監視 | CloudWatch Synthetics（東京と大阪から、監視の組織を使う） | 30 日 |
| DB | Performance Insights、`pg_stat_statements`、`pg_stat_activity` の標本（5 節） | 7 日（Performance Insights は Database Insights に含まれ、既定で 7 日の履歴を追加の料金なしで持つ。延ばすと有料。[Pricing and data retention for Database Insights](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/USER_PerfInsights.Overview.cost.html)、2026-09-28 に確認） |
| 呼び出し | PagerDuty 相当の道具（E1 で選ぶ） | — |

## 2. ログとトレース（ADR-0058）

### 2.1 ログの形

```json
{ "ts": "...", "level": "info", "service": "runtime", "cell": "c1", "cluster": "m1",
  "org_id": "0192...", "shard_no": 17, "user_id": "0192...", "request_id": "req_...", "trace_id": "...",
  "route": "GET /api/v1/query", "status": 200, "duration_ms": 84, "db_ms": 31,
  "query_shape": "sha256:...", "rows": 42, "limits": { "tx.queries": 3, "tx.query_rows": 42 } }
```

- 入れないもの：レコードの値、項目の値、問い合わせのリテラル（AST の形のハッシュだけ。[query-language-and-api.md](query-language-and-api.md) の 8 節）、検索の語（ハッシュと長さだけ。[search.md](search.md) の 9 節）、秘密、トークン、エラーの文言への値の差し込み。
- ログの型で禁止する：ログのライブラリは決まった項目だけを受け、任意のオブジェクトを受けない（lint）。秘密は `Secret<T>` で `[redacted]` になる（[security.md](security.md) の 8 節）。
- 本番のログの標本（1 時間に 1 万行）を、秘密と個人データの形（メール、電話、トークンの接頭辞）で走査し、1 件でも出たら警告する。

### 2.2 トレース

- 属性：`org_id`、`shard_no`、`cluster_id`、`metadata_version`、`perm_shape`（ハッシュ）、`limit_peak`。
- 標本：1%。エラー、1 秒を超える要求、`LIMIT_EXCEEDED`、影の実行の食い違い（[ADR-0063](../decisions/0063-org-staged-release-and-shadow-evaluation.md)）は全て残す。
- DML の手順（[metadata-and-runtime.md](metadata-and-runtime.md) の 6 節）ごとにスパンを切る（検証、保存の前のフロー、書き込み、保存の後のフロー、積み上げ集計、共有の評価、確定）。フローの要素ごとのスパンは持たない（数が多い）。

## 3. SLI と SLO（ADR-0058）

S1 の本番の組織が対象。Sandbox・試用は SLO の外（計測はする）。窓は 30 日の移動の窓（他の題材と同じ）。**値の正本は [runbooks/README.md](../runbooks/README.md) の 1 節**（この表はその写し）。

| SLI | 定義 | SLO | 根拠 |
| --- | --- | --- | --- |
| 対話の可用性 | `runtime` の要求のうち 5xx でない割合（ALB）と、合成監視の成功の割合の低い方 | 99.9% | NFR-006 |
| レコードのページの速さ | `GET /api/v1/ui/records/{id}` の p95・p99 | 300ms・800ms | NFR-001 |
| リストビューの速さ | 最初のページの p95（選択的な条件） | 500ms | NFR-001 |
| REST の 1 件の読み書き | p95・p99（自動化の時間を除く） | 200ms・500ms | NFR-002 |
| 問い合わせ | 選択的な条件の p95 | 500ms | NFR-002 |
| メタデータの記述 | p95 | 100ms | NFR-002 |
| メタデータの反映（K2） | カスタム項目の追加から、別のタスクで使えるまでの p95 | 5 秒 | [ADR-0007](../decisions/0007-segmented-metadata-snapshots.md) |
| メタデータの確定の止まり | 版を上げる排他のロックの間の書き込みの待ちの p99 | 1 秒 | NFR-004 |
| 変更のイベントの遅れ | 確定から購読者に届くまでの p95（合成監視） | 5 秒 | NFR-010 |
| 項目の変更の履歴の写しの遅れ | 確定から `history` のクラスタに入るまでの p95 | 5 秒 | [ADR-0047](../decisions/0047-field-history-tracking-and-retention.md) の注記 |
| Webhook の配信 | 確定から最初の送信までの p95 | 30 秒 | [events-and-integrations.md](events-and-integrations.md) |
| 検索の索引の遅れ | 確定から索引に入るまでの p95 | 5 秒 | [ADR-0031](../decisions/0031-search-index-and-japanese-analysis.md) |
| 検索の速さ | 全体の検索の p95 | 800ms | ADR-0031 |
| レポートの同期 | p95 | 5 秒 | [reports-and-dashboards.md](reports-and-dashboards.md)（初期見積もり） |
| 共有の再計算 | ルールの追加の完了の時間（100 万件）、閉包の世代（同） | 15 分・5 分 | NFR-005（2026-09-28 に改めた） |
| 一括の取り込み | 100 万件の完了の時間（自動化が軽い時） | 30 分 | NFR-010 |
| ログイン | ログインの送信の p95 | 500ms | [orgs-users-and-auth.md](orgs-users-and-auth.md) |
| 公平 | 重い組織がいる時の、他の組織の p95 の悪化 | 10% 以内 | NFR-003 |
| アクセスの判定の正しさ | `access_oracle_mismatch_total{direction="over"}` | 0 | K3、[ADR-0017](../decisions/0017-reference-access-evaluator.md) |

- エラーバジェットは、対話の可用性と速さの SLI に持つ。30 日の窓で 1 時間 14.4 倍・6 時間 6 倍の燃え方で呼び出す（多窓の燃え方。他の題材と同じ形）。
- 合成監視：監視の組織（東京と大阪に 1 つずつ）で、1 分ごとに、ログイン → レコードの作成 → 読み → 問い合わせ → リストビュー → 検索 → 変更のイベントの受け取り → 削除、を通す。監視の組織には上限・割り当ての例外を与えない。

### 3.1 各領域から依頼された SLI

| 領域 | 指標 |
| --- | --- |
| metadata-and-runtime | 確定の時間、K2、部品のキャッシュの命中率、`metadata_compile_failures_total`、`METADATA_CHANGED` の件数 |
| data-storage | `pivot_drift_repaired_total`、消去の遅れ、分割の表の計画の時間の p99、1 件の保存で書くピボットの行の数、行の大きさの p95 |
| sharing | `access_oracle_mismatch_total{direction}`、共有のジョブの時間、`G_me` の読みの p99、閉包の行の数の最大、保留の組織の数 |
| query-language | 問い合わせの p95、`query_replans_total`、`NON_SELECTIVE_QUERY`、見積もりの誤差、状態コードの分布、`api-usage` 80% 超の組織の数 |
| sales-objects | 重複の判定の p95、変換の p95、メールの受信の遅れ、`duplicate_match_overflow_total`、隔離したメールの件数 |
| ui | レコードのページの p95・p99、リストビューの p95、`layout_compile_fallback_total`、`metadata_conflict_total`、`LIST_VIEW_UNAVAILABLE` |
| automation | 保存の後のフローを含む保存の p95、予定の経路の遅れ、`rollup_mismatch_total`、`rollup_parent_lock_wait_seconds`、承認の応答の p95、画面のフローの p95 |
| reports | 同期の p95・p99、非同期の待ち、reader の遅れ、組織ごとのレポートの DB の時間、ダッシュボードの更新の数、定期の配信の遅れ |
| search | 検索の p95・p99、参照の候補の p95、索引の遅れ、`degraded` の率、OpenSearch の CPU と JVM のヒープ、後の確かめの時間、`search_floor_exceeded_ratio`（下限の時間を超えた要求の割合。LEAK-012） |
| events | 確定から `events` までの遅れ、購読者への配信の遅れ、Webhook の成功率と遅れ、`disabled` の宛先の数、`ssrf_blocked_total`、SES の bounce と苦情の率 |
| bulk | 取り込みの行の速さ、ジョブの待ち、失敗の行の率、問い合わせのジョブの時間、`bulk_ingest` の待ち |
| sandboxes | 検証・適用の時間、適用の止まりの p99、戻しの時間、複製の時間と失敗の率、マスキングの警告の件数 |
| governor-limits | 組織ごとの DB の時間の割合、429 の率、`worker_queue_age_seconds{class}`、`tx_limit_peak_ratio{limit}` の p99、`LIMIT_EXCEEDED` の件数 |
| orgs-users-and-auth | ログインの p95、ログインの失敗の率、SSO の失敗の率（IdP ごと）、トークンの発行の数、組織の作成の時間 |
| audit | 監査のイベントの数、`audit_pending` の遅れ、ログインの履歴の書き込みの失敗、履歴の行の数と大きさ、錨の書き込みの成否 |
| extensibility（E13） | 砂場の呼び出しの p95、実体化の時間、燃料の p99、`code_trigger_errors_total`、`code-runner` の再起動 |
| security | 出力の走査の件数、JIT・break-glass の数、全ての `*_overdue`、KMS の `Decrypt` の異常 |

## 4. 組織ごとの資源の使用量（ADR-0058）

| 表 | 中身 | 書き手 |
| --- | --- | --- |
| `org_db_time_minutes` | 組織 × クラスタ × 分 × 経路（`runtime`・`worker`・`reader`）の DB の時間 | 計測器（[governor-limits.md](governor-limits.md) の 7 節） |
| `org_usage_minutes` | 割り当ての使用量 | governor-limits |
| `org_request_minutes` | 組織 × 分の要求の数、5xx、429、p95 の近似（桶の分布） | `runtime` |
| `org_aas_minutes` | 組織 × クラスタ × 分の DB の側の実行中のセッションの平均（5 節） | 監視の Worker |
| `org_worker_minutes` | 組織 × class × 分の Worker の仕事の時間 | `worker` |

- メトリクスの `org` のラベルは、クラスタごとに 1 分ごとに DB の時間の上位 50 を選び、他は `org="_other"`。異なる値の数が 1 時間で 500 を超えないことを見る。
- Grafana の「組織」のダッシュボードは、表から 1 つの組織の使用量を引く（上位 50 の外の組織も見られる）。
- 組織の管理者向けの Setup の「組織の上限」（governor-limits の 9 節）は、同じ表から作る。

## 5. 騒がしい隣人の検知（ADR-0059）

### 5.1 2 つの計測

| 計測 | 取り方 | 強み | 弱み |
| --- | --- | --- | --- |
| アプリの DB の時間 | データ層の計測器が、文の実行の時間を組織ごとに足す | 経路（Runtime・Worker・reader）と組織が正確 | データ層を通らない経路は数えない |
| DB の側の AAS | 監視の Worker が 1 秒ごとに `pg_stat_activity`（`state = 'active'`）を読み、`application_name` の組織ごとに数える | データ層の外も数える | 1 秒より短い文を取りこぼす |

- データ層はトランザクションの開始で `SET LOCAL application_name = 'o:<org_id>:<path>'` を設定する。組織をまたぐ処理は `x:<job>`、保守は `m:<job>`。
- `pg_stat_statements` は文の形ごとなので、組織ごとの分けには使わない。重い文の形を見つけるのに使う。

### 5.2 状態と対処

| 状態 | 条件 | 自動の対処 | 人の対処 |
| --- | --- | --- | --- |
| 重い | アプリの DB の時間がクラスタの 20% を 5 分（ADR-0042） | Worker の重みを半分 | 他の組織の SLI が悪い時だけ呼び出し。runbook で、対話の経路の絞りを判断 |
| 漏れ | AAS の割合がアプリの DB の時間の割合の 2 倍以上を 10 分 | なし | 計測の漏れ（データ層の外の経路）を調べる（チケット） |
| クラスタの飽和 | writer の CPU 80% か、AAS が vCPU の数を 5 分超える | なし | 呼び出し。重い組織と重い文の形を特定 |

- 人の対処の段（[runbooks/incident-response.md](../runbooks/incident-response.md) の「騒がしい隣人」）：組織の長い要求の同時実行の上限を一時的に下げる → 組織の特定の連携のクライアントを止める → 組織の API の割り当てを下げる → 組織の非同期の仕事を止める。全て組織の監査に `support` で残し、組織の管理者に知らせる。
- 対話の経路の絞りを自動にしないのは、誤った検知で営業の業務を止めないため（ADR-0059）。

## 6. ダッシュボード

| ダッシュボード | 中身 |
| --- | --- |
| SLO | 3 節の SLI、エラーバジェット、燃え方 |
| セル | クラスタごとの writer・reader の CPU・AAS・接続・遅れ、OpenSearch、Valkey、ECS |
| 組織 | 1 つの組織の使用量（4 節の表）、上限に近い自動化、429 |
| 騒がしい隣人 | 上位 50 の組織の DB の時間の割合、重い・漏れの状態、`worker_queue_age_seconds{class}` |
| アクセスの判定 | 標本の照合の件数と食い違い、影の実行の食い違い、共有のジョブ |
| 段階の基準 | [infrastructure.md](infrastructure.md) の 5 節の値（毎週見る） |
| データの消去 | 全ての `*_overdue`（[security.md](security.md) の 7 節） |
| リリース | フラグの段ごとの組織の SLI、影の実行（[delivery.md](delivery.md) の 6 節） |

## 7. アラートと runbook

重さ：`page`（呼び出し）、`ticket`（翌営業日）。**アラートと runbook の対応の全ての一覧（各領域の手順と、それを作る Epic を含む）の正本は [runbooks/README.md](../runbooks/README.md) の 4 節**で、この表は主なアラートの条件だけを書く。まだないものは名前だけを書く。

| アラート | 条件 | 重さ | runbook |
| --- | --- | --- | --- |
| SLO の速い燃え方 | 1 時間 14.4 倍 | page | [incident-response.md](../runbooks/incident-response.md) |
| SLO の遅い燃え方 | 6 時間 6 倍 | ticket | incident-response.md |
| 合成監視の連続失敗 | 東京で 3 回 | page | incident-response.md |
| 大阪からの合成監視の全失敗 | 5 分 | page | [disaster-recovery.md](../runbooks/disaster-recovery.md) |
| `AuroraGlobalDBRPOLag`（主・`events`・`history`） | 10 秒を 10 分 | ticket | disaster-recovery.md |
| デプロイの後の悪化 | 入れ替えの後 15 分の比べ | page | [deploy-and-rollback.md](../runbooks/deploy-and-rollback.md) |
| 参照の評価器の食い違い `over` | 1 件 | page（セキュリティ） | incident-response.md の「共有の漏えい」、`access-oracle-mismatch` |
| 参照の評価器の食い違い `under` | 1 件 | ticket | `access-oracle-mismatch` |
| 影の実行の食い違い | 1 件 | ticket（リリースを止める） | deploy-and-rollback.md |
| 騒がしい隣人（重い＋他の組織の悪化） | 5 節 | page | incident-response.md の「騒がしい隣人」、`noisy-neighbor-db-time` |
| 計測の漏れ | 5 節 | ticket | `noisy-neighbor-db-time` |
| Worker の待ち | class で 15 分 | ticket | `worker-queue-backlog` |
| マスキングの警告・伏せていない値の検出 | 1 件 | page（セキュリティ） | incident-response.md の「Sandbox のマスキングの事故」、`sandbox-masking-incident` |
| 監査の鎖の食い違い | 1 件 | page（セキュリティ） | `audit-chain-mismatch` |
| 錨の書き込みの失敗 | 2 日 | ticket | `audit-anchor-failed` |
| 出力の走査で秘密・個人データ | 1 件 | page（セキュリティ） | incident-response.md の「組織のデータの漏えい」、`secret-exposure` |
| 組織をまたぐ漏えいの疑い（性質の検査、利用者の報告） | 1 件 | page（SEV1） | incident-response.md の「組織のデータの漏えい」 |
| Relay の遅れ（変更のイベント・履歴の写し） | p95 30 秒 | page | `event-relay-lag` |
| `history` のクラスタの障害 | 書き込みの失敗が 5 分 | ticket | `history-cluster-degraded` |
| 検索の索引の遅れ | p95 60 秒を 5 分 | ticket | `search-index-lag` |
| OpenSearch の障害 | `degraded` の率 5% | ticket | `search-degraded` |
| 検索の下限の時間の超過（LEAK-012） | `search_floor_exceeded_ratio` 5% を 1 時間 | ticket | `search-floor-exceeded` |
| reader の遅れ | 30 秒・5 分 | ticket・page | `reader-replica-lag` |
| メタデータの確定の止まり | p99 1 秒を 15 分 | ticket | `deploy-lock-stall` |
| ピボットの差 | 1 件 | ticket | `pivot-drift-detected` |
| 積み上げ集計の差 | 1 件 | ticket | `rollup-mismatch` |
| 全ての `*_overdue` | 1 件 | ticket | `purge-overdue` など |
| 共有のジョブの停止 | 1 時間進まない | ticket | `sharing-job-stuck` |
| 一括のジョブの停止 | 1 時間進まない | ticket | `bulk-job-stuck` |
| Webhook の SSRF の拒否の急増 | 平常の 10 倍 | ticket | `outbound-ssrf-blocked-spike` |
| ログインの攻撃 | 1 組織・1 IP の失敗の急増 | page | `login-attack` |
| KMS の異常な操作 | CloudTrail | page（セキュリティ） | incident-response.md |
| `code-runner` の再起動の繰り返し（E13） | 5 分に 3 回 | page | `code-runner-crash-loop` |

## 8. この領域の ADR

| ADR | 決定 |
| --- | --- |
| [0058](../decisions/0058-slis-and-per-org-resource-metrics.md) | SLI は経路ごとに合成監視とサーバーの計測で持ち、組織ごとの使用量は DB の表に全件、メトリクスには上位の組織だけを出す。ログとトレースには組織の ID を持たせ、個人データを入れない |
| [0059](../decisions/0059-noisy-neighbor-detection-two-sources.md) | 騒がしい隣人は、アプリの DB の時間と、DB の側の実行中のセッションの標本の 2 つで見つけ、自動の対処は Worker の重みまでにし、対話の経路の絞りは人が決める |

他の領域への依頼：

- governor-limits の領域：データ層のトランザクションの開始で `application_name` を設定する（5.1 節）。計測器の差し込み口に含める。
- 各領域：3.1 節の指標の名前を、開発リポジトリの計測の名前の一覧に登録する。

## 9. Story の候補

| Epic | Story の候補 |
| --- | --- |
| E1 | ADOT、AMP、Grafana、ログの型と lint、出力の走査 |
| E1 | 合成監視（監視の組織、東京と大阪） |
| E1 | 組織ごとの使用量の表と、上位 50 のラベルの出力 |
| E3 | DML の手順のスパン、`limits` のログの項目 |
| E4 | アクセスの判定のダッシュボード（標本の照合） |
| E12 | 騒がしい隣人の検知（AAS の標本、重い・漏れ）と負荷試験での確かめ |
| E12 | SLO とエラーバジェットの呼び出し、アラートと runbook の対応の確認 |

## 10. 未解決の問い

- 上位 50 の組織だけのラベルで、急に重くなった小さな組織を見逃さないか。
- 1 秒の `pg_stat_activity` の標本が、writer に負荷をかけないか。
- 組織の管理者に、組織の使用量（DB の時間）を見せるか。
- トレースの 1% の標本で、上限に当たる珍しい自動化を追えるか。

### 決定

2026-09-28 の既定案。

- 上位 50 に加え、直近 5 分の増え方の上位 10 もラベルに出す（`org_trend`）。
- 標本は reader でなく writer でも 1 秒ごとに行い、E12 で writer の CPU への影響を測る。1% を超えるなら 5 秒ごとにする。
- DB の時間の生の値は見せない。Setup の「組織の上限」で、割り当ての使用量と、上限に近い自動化だけを見せる（governor-limits の決定のまま）。
- `LIMIT_EXCEEDED` と、`tx_limit_peak_ratio` が 80% を超えたトランザクションは全て残す（2.2 節）。

## 11. quality.md・runbooks・data-model に載せるもの

**quality.md**

- 本番での検証の指標は 3 節。QA は「アクセスの判定の正しさ」「公平」「データの消去の遅れ」を GA の判定の基準に使う。
- 合成監視のシナリオ（3 節）を、E2E の主な流れと揃える。

**runbooks**

- `runbooks/README.md` に 3 節の SLO と、7 節のアラートの表を写す（2026-09-28 に写した。正本は runbooks/README.md の 1・4 節）。
- `noisy-neighbor-db-time`、`worker-queue-backlog`、`reader-replica-lag` など、7 節の名前だけの runbook。

**data-model**

| テーブル | 主な列 | 備考 |
| --- | --- | --- |
| `org_request_minutes` | `org_id`、`minute`、`requests`、`errors_5xx`、`throttled_429`、`latency_buckets` | 7 日（1 時間の粒度は 13 か月） |
| `org_aas_minutes` | `org_id`、`cluster_id`、`minute`、`aas`、`path` | 7 日 |
| `org_worker_minutes` | `org_id`、`class`、`minute`、`busy_ms` | 7 日 |
| `org_db_time_minutes` | governor-limits の表 | 7 日 |

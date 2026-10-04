# Runbooks: Linear

Ops が持つ運用の文書。品質の判定基準は [quality.md](../quality.md) の 4 節、SLI の定義と計測とアラートの条件の実装は [observability.md](../architecture/observability.md) の 5 節にある。**SLO の値とアラートの一覧の正本はこの文書** で、observability.md は、これを計測・実装する側の記述である。値を変えるときは、この文書を先に変え、observability.md を合わせる。

## 1. SLI と SLO

| SLI | 良いイベント（数える場所） | SLO（S1） | 許容範囲を外れたときの扱い | 品質の判定に使う |
| --- | --- | --- | --- | --- |
| 書き込みの経路の可用性 | `submit` のトランザクションのうち、`ok` か検証の拒否で答えたもの。`retry` のうち 60 秒以内に確定しなかったもの、5xx、Gateway の受け付けの失敗は悪い（Gateway、Writer） | **月間 99.9%**（NFR-006） | 1 時間のバーンレート 14.4 倍・6 時間で 6 倍で呼び出し、3 日で 1 倍でチケット。エラーバジェットを使い切ったら、修正以外のデプロイを止める | |
| 差分の配信の可用性 | 合成監視の伝播の確かめのうち、10 秒以内に届いたもの | **月間 99.9%**（NFR-006） | 同上 | |
| ブートストラップの可用性 | ブートストラップの要求のうち、完了したもの（`429` は再試行で完了すれば良い）（Sync API、RUM） | **月間 99.9%**（NFR-006） | 同上 | |
| 公開 API の可用性 | 5xx・時間切れでない応答（エッジ、`public-api`） | **月間 99.9%**（NFR-006） | 同上（書き込みの経路と別に数える） | |
| 送信から ack | クライアントの `submit` から `ack` まで 300ms 以内（RUM、Gateway） | **p99 300ms**（NFR-002） | p99 が 1 秒を 10 分超えたら呼び出し | ○ |
| 伝播 | 確定から他のオンラインのクライアントの適用まで（合成監視の 2 つのクライアント、RUM） | **p99 1 秒、p50 200ms**（NFR-002） | 合成監視の p99 が 3 秒を 10 分、または RUM の p99 が 2 秒を 30 分超えたら呼び出し | ○ |
| 操作の遅延 | 主要な Action の入力から描画（RUM、`ws_band` が L・XL） | **週の p99 50ms**（NFR-001） | 2 日続けて超えたらチケット | ○ |
| 起動 | 経路ごとの操作できるまで（RUM） | **手元 p95 1.5 秒、全体（小）p95 3 秒、部分（最大）p95 10 秒**（NFR-003） | 3 日続けて超えたらチケット | ○ |
| outbox の耐久 | 失った未送信の件数（ブラウザの消去を除き、別に数える）（RUM、`client_devices`） | **0**（NFR-004、K4） | 1 件で呼び出し（SEV2 から） | ○ |
| 収束 | 収束の監査の `unexplained`（[observability.md](../architecture/observability.md) の 4 節） | **0**（NFR-005、K5） | 1 件で呼び出し（SEV2 から） | ○ |
| テナントと非公開のチームの分離 | 配信の監査の不一致、`orphan_rows`、`subscription_drift` の見てよくない方向のずれ（同 4.4 節） | **0**（NFR-008、K7） | 1 件で呼び出し（SEV1 の候補） | ○ |
| 公開 API の遅延 | 1 件の読み出しの GraphQL | **p99 500ms**（NFR-009） | 1 日続けて超えたらチケット | |
| Webhook | 確定から最初の送信 | **p95 30 秒**（NFR-009） | p95 が 5 分を超えたらチケット | |
| 検索 | 変更から検索に出るまで、`/search` の応答 | **p95 10 秒、p99 500ms**（NFR-010） | `search_index_lag_seconds` の p95 が 30 秒を 15 分でチケット、5 分を超えたら呼び出し | ○ |

- SLO の窓は 30 日の移動の窓（報告は暦の月）。エラーバジェットの方針は他の題材と同じ（使い切ったら信頼性の作業を機能より先にする。デプロイの前に残りを確かめる）。
- **数えないもの**：検証の拒否（`forbidden`・`invalid` など）。ただし、拒否の率の急な上がり（observability.md の 5.3 節）はバージョンのずれや規則の誤りの兆候として見る。社内の監視用のワークスペースは SLO の計算から除き、別に見る。
- 伝播の SLI の正本は、合成監視の 2 つのクライアント（同じプロセス、同じ時計）と RUM の両方。RUM は利用者の回線を含む。
- クライアントの計測（操作の遅延、起動、ヒープ）は SLO の表に置くが、呼び出しにはしない（チケットと日次の確認）。QA が品質の判定に使う（[quality.md](../quality.md) の 4.1 節）。
- 「品質の判定に使う」に○がある指標は、QA が品質の判定基準に使う。定義を変えるときは QA と合意する。
- 復旧の目標：AZ の障害は RPO 0・RTO 5 分、リージョンの障害は RPO 1 分・RTO 1 時間（NFR-007）。検索は 4 時間（[ADR-0050](../decisions/0050-disaster-recovery-and-sync-epoch-bump.md)）。

## 2. 上限と容量のパラメーター

値の正本は各文書にある。Ops が運用で変えてよいのは、下の「運用で変えるもの」だけで、変えたら記録を残す。

| 対象 | 値 | 正本 | 運用で変えるもの |
| --- | --- | --- | --- |
| 1 ワークスペースの書き込み | 1 秒 300 変更（見込み。E2 の PoC で確かめる） | [capacity.md](../architecture/capacity.md) の 2.1 節 | — |
| `origin` ごとの枠 | `api` 60（瞬間 300）、`notifier` 50（瞬間 500）、`worker` 50（瞬間 500）、`import` 100（自動で下げる）。`client` は数えない | 同 2.2 節（[ADR-0054](../decisions/0054-per-workspace-write-admission.md)） | `ops.write_budget.<origin>` でワークスペースごとに下げる（`writer-lock-contention.md`） |
| 1 トランザクション・1 回の `submit` | 500 操作・256 KiB、100 トランザクション・1 MiB | [sync-engine.md](../architecture/sync-engine.md) の 4.3 節 | — |
| Writer のロックの待ち | `lock_timeout` 2 秒（非公開への切り替えは 10 秒） | 同 5.2 節 | — |
| outbox（端末） | 未確定 5 万件・100 MiB、警告 1,000 件か 24 時間 | [client-store-and-offline.md](../architecture/client-store-and-offline.md) の 5.3 節 | — |
| Gateway | 1 タスク 3,000 接続（上限 5,000）、`hello` 1 タスク 1 秒 300、最小 12・最大 60 | [capacity.md](../architecture/capacity.md) の 3・6 節 | タスクの数、`hello` の受け付けの上限と `retry_after_ms`（`reconnect-storm.md`） |
| Sync API | 1 タスク 20 の同時のブートストラップ、6〜12 タスク（DR の時 60） | 同 4・6 節 | タスクの数 |
| `epoch` のやり直しの散らし | 既定 10 分、30 分まで | 同 4.2 節（ADR-0013 の注記） | `ops.epoch_reset_spread_min`（[disaster-recovery.md](disaster-recovery.md) の B） |
| 公開 API の枠（1 時間） | API キー 2,500 要求・300 万点、OAuth 5,000 要求・200 万点、ワークスペースの合計 5 万要求・3,000 万点 | [api-and-webhooks.md](../architecture/api-and-webhooks.md) の 4.2 節（ADR-0041） | 主体ごとの一時の引き下げ（`api-abuse.md`） |
| Webhook の送信 | 接続 2 秒・全体 5 秒、再試行 1 分・1 時間・6 時間、24 時間の失敗で止める | 同 5.6 節（ADR-0043） | `ops.webhooks_enabled` |
| インポート | 200 変更の束、1 クラスタ同時 3 ジョブ | [import-export.md](../architecture/import-export.md) の 5.1 節 | `ops.write_budget.import` |
| permessage-deflate | 窓 4 KiB、1 KiB 未満は圧縮しない | [sync-engine.md](../architecture/sync-engine.md) の 9.1 節 | `ops.ws_deflate`（新しい接続で止める） |

## 3. リリースとロールバック

流れの正本は [delivery.md](../architecture/delivery.md)、手順は [deploy-and-rollback.md](deploy-and-rollback.md)。

- **デプロイとリリースを分ける。** デプロイは Ops が承認し、リリース（フラグを広げる）は PM が判断する。未完成の振る舞いは `release.*` のフラグの裏に置く。`release.*` は 100% の後 30 日で消す。
- **同期の意味をフラグにしない。** 競合の規則、`applyOp`、`derive`、同期グループの規則、トランザクションの形は、スキーマのバージョン（`schema_hash`・`fv`）で変える（[ADR-0056](../decisions/0056-flags-client-distribution-and-min-build.md)）。
- **サーバーのデプロイの順**：マイグレーション（広げる段だけ）→ writer（ローリング）→ relay → gateway・sync-api（gateway は 1 タスクずつ 10 分かけて逃がす。全部で約 1 時間）→ public-api・auth・worker-* → Web の資産（置くだけ）。サーバーのバージョンの更新で、クライアントのやり直しを起こさない。自動のロールバックの条件は 5xx、拒否の率の急な上がり、送信から ack の p99、Relay の遅れ。
- **Web のクライアント（コホートの段階）**：端末の ID（`<brand>_cid`）のハッシュの桶と KeyValueStore の割合で `index.html` を選ぶ。1% → 10% → 50% → 100%、各段 4 時間以上。止める条件（前のバージョンとの比べ）：主要な Action の p99 か起動の p95 が 10% 以上遅い、拒否の率・JavaScript のエラーの率が 2 倍、`migration`・`corrupt` のやり直しが 0.5% 以上、収束の監査の `unexplained` が 1 件。戻しは割合を戻す。
- **手元の DB のバージョン（`schema_version`）を上げるリリース**は戻せない。機能の変更と別のリリースにし、1% で 48 時間見てから進め、問題は前へ直す。
- **Electron の殻**：更新の案内を端末の桶で返す。1%（24 時間）→ 10%（24 時間）→ 50% → 100%。Chromium の High 以上の修正を含むバージョンは 24 時間で 100%。止めるは割合 0、戻すは前のコードでバージョンを上げて出す（Squirrel はバージョンを下げられない）。
- **最低のバージョン（`min_build`）**：殻とレンダラーの組で比べる。上げる理由は、プロトコル、互換の一覧の外れ（30 日）、セキュリティに限る。古い端末は送信を止めるが、手元の読み書きと outbox は続ける。上げる前に、古いバージョンの接続の数を確かめる。
- **スキーマの変更（広げる・移る・縮める・消す）**（[ADR-0057](../decisions/0057-schema-change-ordering.md)）：N で DB を広げ、Writer が両方を書き、Worker が枠の中で埋める → N+1 でクライアントを移す（Writer は古い `fv` と新しい `fv` を受ける）→ 古い `schema_hash` の接続が 1% 未満、段 2 から 30 日、古い `fv` の outbox の報告が 0 に近いときに縮める → 縮めたコードが 1 リリース以上動いた後、列を消すマイグレーションを単独で出す。1 つのデプロイで、DB の破壊の変更と、それを読むコードを一緒に出さない。手順は `schema-expand-contract.md`。
- **ロールバック**：まずフラグ（`release.*`・`ops.*`）で戻す。次に 1 つ前のイメージ（マイグレーションは広げる段だけなので、前のバージョンが今の DB で動く）。クライアントは割合を戻す。縮める段の後は前へ戻さない。
- **同期の核の不具合**（収束の不一致、outbox の喪失）は、まず `ops.*` で止められるかを見る。`ops.writes_enabled = false` は最後の手段（止めてもクライアントは outbox に貯める）。
- 本番へのデプロイは Ops が承認する（作成者と別の人）。

### 3.1 デプロイの時間帯と凍結

| 対象 | 時間帯 | 凍結（修正だけ） |
| --- | --- | --- |
| サーバー（writer、relay、gateway、sync-api、public-api、auth、worker-*） | 平日 10〜17 時 | 金曜 15 時以降、日本の祝日の前日、年末年始、エラーバジェットを使い切っている間、夜間の CI（シミュレーター 20 万の列、オフラインの耐久）が 2 日続けて失敗している間 |
| Web・Electron の段階を進める | 平日 10〜15 時（観察を平日に置く） | 同上 |
| 手元の DB のバージョンを上げるリリース、`min_build` の引き上げ | 計画作業として平日 10〜12 時（1% の 48 時間の観察を平日に置く） | 同上 |
| 縮める・消す段のマイグレーション | 計画作業として平日 10〜15 時 | 同上 |
| Terraform（`regional/network`・`regional/data`） | 平日 10〜16 時。Ops の承認 | 同上 |
| DR の戻し（大阪 → 東京の switchover） | 計画作業として | 大きな利用者の催しの日を避ける |

- 上の時間帯と凍結は本システムの既定である。問題の観察と戻しを、人がそろう平日の日中に置くため。本家の運用の値ではない。
- 脆弱性の修正（Critical）と Chromium の High 以上の修正は、時間帯の制限を受けない。レビューと必須の CI（シミュレーター、遅延の予算、オフラインの 3 つの場面を含む）は省かない。
- 凍結の予定は、Ops が四半期ごとにこの表の下に書き足し、PM と合意する。

## 4. アラートと手順

「作成済み」以外の手順は、各 Epic の実装に合わせて [templates/runbook.md](../../../../docs/templates/runbook.md) から作る。「作る Story」の列は、そのアラートの計測と手順を作る [roadmap.md](../roadmap.md) の Story である。手順の文書は、その Story の完了の条件に含める（E12 の分は `runbooks-e12` でもまとめて確かめる）。作るまでは [incident-response.md](incident-response.md) の該当の節で対応する。アラートの条件の実装は [observability.md](../architecture/observability.md) の 5.4 節。すべてのアラートは、対応する runbook の URL を注釈に持つ（CI で検査する）。

| アラート（重さ） | 手順 | 状態 | 作る Story |
| --- | --- | --- | --- |
| 書き込みの経路の SLO の速いバーンレート（page）・遅いバーンレート（ticket）、差分の配信・ブートストラップの SLO | [incident-response.md](incident-response.md) | 作成済み | `slo-dashboards-alerts` |
| 送信から ack の遅れ（p99 1 秒が 10 分。page）、ロックの待ち（上位のワークスペースの p99 200ms が 10 分。ticket） | [incident-response.md](incident-response.md) の「伝播の遅れ」、`writer-lock-contention.md`（sync-engine.md の 15 節、capacity.md の 12 節） | 作成済み（個別の手順は E2 で作成） | `writer-admission-buckets`、`writer-throughput-poc` |
| 伝播の遅れ（page）、差分の配信の停止（page、SEV1 の候補）、Relay の遅れ（`sync_outbox` の最古 5 秒。page）、Gateway の欠けの埋めの急増（ticket） | [incident-response.md](incident-response.md) の「伝播の遅れ」、`sync-propagation-lag.md`（sync-engine.md の 15 節） | 作成済み（個別の手順は E2 で作成） | `propagation-timestamps`、`synthetic-sync-clients`、`relay-workspace-publish` |
| 収束の不一致（`unexplained` 1 件。page、SEV2 から） | [incident-response.md](incident-response.md) の「収束の不一致」、`convergence-mismatch.md`（sync-engine.md の 15 節） | 作成済み（個別の手順は E12 で作成） | `convergence-audit` |
| 非公開のチームの漏えいの疑い（配信の監査、`orphan_rows`、`subscription_drift`。page、SEV1 の候補） | [incident-response.md](incident-response.md) の「非公開のチームの漏えいの疑い」、`private-team-leak-response.md`（bootstrap-and-partial-sync.md の 14 節、permissions-and-teams.md の 13 節） | 作成済み（個別の手順は E4 で作成） | `delivery-audit`、`subscription-audit`、`team-privacy-toggle` |
| 購読のずれ（`subscription_drift` の見てよい方向。ticket） | `subscription-drift-repair.md`（permissions-and-teams.md の 13 節） | E4 で作成 | `subscription-audit` |
| 端末の保存の消去の増加（`lost_local`・`corrupt` が平常の 3 倍を 1 時間。ticket、10 倍で page） | [incident-response.md](incident-response.md) の「端末の保存の消去」、`client-storage-eviction.md`（client-store-and-offline.md の 15 節） | 作成済み（個別の手順は E3 で作成） | `lost-local-notice`、`client-storage-telemetry` |
| outbox の滞留（最古の未送信が 24 時間を超える端末が平常の 3 倍。ticket） | `outbox-backlog.md`（同上） | E3 で作成 | `outbox-store` |
| クライアントのバージョンの後の移行の失敗（新しいバージョンで `migration` のやり直しが 1% 超。page） | [deploy-and-rollback.md](deploy-and-rollback.md)、`client-migration-failure.md`（同上） | 作成済み（個別の手順は E3 で作成） | `client-db-migration` |
| 操作の遅延の後退（RUM の p99 50ms を 2 日。ticket） | `latency-regression.md`（client-app.md の 18 節） | E6 で作成 | `latency-budget-gate`、`rum-latency-marks` |
| IME の不具合の報告（組み立て中の誤った実行） | `ime-regression.md`（同上） | E6 で作成 | `ime-guard` |
| 再接続の殺到（1 分の新しい接続が 1 万超。ticket、`overloaded` が 5 分で page） | `reconnect-storm.md`（capacity.md の 12 節） | E3 で作成 | `gateway-hello-admission`、`gateway-heartbeat-backoff` |
| ブートストラップの過負荷（Sync API の `429` が 1 分 1,000 超。page） | `bootstrap-overload.md`（bootstrap-and-partial-sync.md の 14 節） | E3 で作成 | `bootstrap-stream-api` |
| 同期のログの保持のジョブの失敗、`floor` の遅れ | `sync-log-retention.md`（同上） | E3 で作成 | `sync-log-retention` |
| 拒否の率の急な上がり（平常の 3 倍を 30 分で ticket、10 倍で page）、デプロイ中の自動ロールバック、Web・Electron の段階の止める条件 | [deploy-and-rollback.md](deploy-and-rollback.md) | 作成済み | `ci-pipeline-baseline`、`web-cohort-rollout`、`electron-auto-update` |
| スキーマの変更の段の進め方・縮める前の確認 | `schema-expand-contract.md`（data-model-and-schema.md の 12 節、delivery.md の 12 節） | E12 で作成 | `schema-expand-contract-tooling` |
| DR の複製の遅延（`AuroraGlobalDBRPOLag` 10 秒が 5 分。page）、大阪の待機の構成の異常（ticket、30 分で page）、AZ の障害 | [disaster-recovery.md](disaster-recovery.md) | 作成済み | `osaka-warm-standby`、`dr-failover-workflow`、`dr-drill` |
| 狭める操作の記録の遅れ（`narrowing_outbox` の送り残し 5 秒、`narrowing_journal` の `ReplicationLatency` 10 秒が 5 分。page） | [disaster-recovery.md](disaster-recovery.md) の C | 作成済み | `narrowing-journal`、`dr-narrowing-replay` |
| ワークスペースの時点への戻しの依頼 | [disaster-recovery.md](disaster-recovery.md) の D | 作成済み | `workspace-pitr-restore` |
| 本文のまとめの遅れ（まとめていない `append` の最古） | `doc-compaction-lag.md`（editor-and-descriptions.md の 15 節） | E5 で作成 | `doc-compaction-worker` |
| 本文が開けない・描けない報告 | `doc-corruption.md`（同上） | E5 で作成 | `description-versions` |
| 添付の署名付きの URL の漏えいの疑い | `attachment-url-leak.md`（同上） | E5 で作成 | `attachments-serve` |
| 番号の数の食い違い（番号の重なりの失敗） | `issue-number-repair.md`（data-model-and-schema.md の 12 節） | E5 で作成 | `issue-numbering` |
| 定期処理（自動で閉じる・アーカイブ・ゴミ箱の消去）の遅れ・1 日で終わらないチーム（ticket） | `lifecycle-jobs.md`（issues-and-workflow.md の 19 節） | E5 で作成 | `lifecycle-jobs` |
| 設定の誤りによる大量の自動の処理の戻し | `mass-auto-close-rollback.md`（同上） | E5 で作成 | `lifecycle-jobs` |
| ゴミ箱の 30 日を過ぎた復元の依頼 | `trash-restore-request.md`（同上） | E5 で作成 | `archive-and-trash` |
| 繰り越しの遅れ（境界から 30 分。ticket）、先のサイクルが 1 つ以下のチーム | `cycle-rollover-stuck.md`（cycles-and-projects.md の 13 節） | E7 で作成 | `cycle-rollover`、`cycle-scheduler` |
| サイクルの設定の誤り | `cycle-settings-mistake.md`（同上） | E7 で作成 | `cycle-scheduler` |
| 進捗の食い違い（`progress_reconcile_drift` が 2 日続く。ticket） | `progress-recount.md`（同上） | E7 で作成 | `progress-reconcile` |
| ビューの問い合わせが遅い（`/sync/query` の p99） | `view-query-slow.md`（views-and-filters.md の 13 節） | E8 で作成 | `sync-query-endpoint` |
| 評価のずれ（`view_candidate_rejected` の増加。ticket） | `filter-divergence.md`（同上） | E8 で作成 | `filter-sql-codegen` |
| 検索の遅れ（`search_index_lag_seconds` の p95 30 秒が 15 分で ticket、5 分で page） | `search-index-lag.md`（search.md の 15 節） | E8 で作成 | `search-indexer` |
| 索引の作り直し、1 つのワークスペースの作り直し | `search-reindex.md`（同上） | E8 で作成 | `search-reconcile` |
| OpenSearch のドメインの障害 | `opensearch-outage.md`（同上） | E8 で作成 | `opensearch-domain`、`search-lag-ux` |
| 認証のサービス・メールの送信の障害 | `auth-outage.md`（accounts-and-auth.md の 15 節） | E4 で作成 | `auth-service-skeleton` |
| アカウントの乗っ取りの疑い | `account-takeover-response.md`（同上） | E4 で作成 | `sessions-and-multi-account`、`revocation-propagation` |
| 認証の部品の脆弱性の告知 | `better-auth-advisory.md`（同上） | E4 で作成 | `auth-service-skeleton` |
| 招待のリンク・許可したドメインの悪用 | `invite-abuse.md`（同上） | E4 で作成 | `invite-link-and-domains` |
| 端末の紛失の連絡（遠隔の消去） | `lost-device.md`（security.md の 16 節） | E4 で作成 | `remote-wipe` |
| 大きなチームの非公開への切り替えの前の確認と、途中で止まったときの続け | `team-privacy-toggle.md`（permissions-and-teams.md の 13 節） | E4 で作成 | `team-privacy-toggle` |
| 通知の遅れ（確定から通知の行の p95 60 秒。ticket） | `notifier-lag.md`（notifications-and-inbox.md の 14 節） | E9 で作成 | `notifier-worker` |
| メールの不達・苦情の急増、送信事業者の障害 | `email-delivery-issues.md`（同上） | E9 で作成 | `email-digest` |
| 誤った一括の変更による大量の通知 | `notification-storm.md`（同上） | E9 で作成 | `notifier-worker` |
| 連携の受け口の失敗（署名の失敗の急増、`integration_events` の最古の未処理 10 分。ticket） | `integration-ingress-outage.md`（integrations.md の 13 節） | E10 で作成 | `integrations-ingress`、`git-resync` |
| 連携のトークンの更新の失敗 | `integration-token-failure.md`（同上） | E10 で作成 | `integration-credentials` |
| 誤った結び付けで大量のイシューが動いた | `git-automation-misfire.md`（同上） | E10 で作成 | `git-state-automation` |
| 連携の秘密の漏えいの疑い | `integration-secret-leak.md`（同上） | E10 で作成 | `integration-credentials` |
| Webhook の送りの遅れ（最初の送信の p95 5 分。ticket） | `webhook-backlog.md`（api-and-webhooks.md の 12 節） | E11 で作成 | `webhook-fanout-and-send` |
| 1 つの主体が公開 API を占める | `api-abuse.md`（同上） | E11 で作成 | `api-complexity-rate-limit` |
| シークレットスキャンの通知（本システムの接頭辞のトークン。page） | `leaked-token-response.md`（同上） | E11 で作成 | `api-keys` |
| 取り込みが進まない | `import-stuck.md`（import-export.md の 13 節） | E11 で作成 | `import-commit-throttled` |
| 取り込みで同じワークスペースの操作が遅い | `import-degrades-workspace.md`（同上） | E11 で作成 | `import-commit-throttled` |
| 7 日を過ぎた取り込みの取り消しの依頼 | `import-undo-request.md`（同上） | E11 で作成 | `import-undo` |
| ワークスペースの削除のジョブの失敗 | `workspace-deletion.md`（security.md の 16 節） | E12 で作成 | `workspace-deletion-job` |
| サポートの参照の許しと手順 | `support-access.md`（同上） | E12 で作成 | `support-access-grants` |
| 秘密の出力の検出（page、SEV2）、監査ログのハッシュの連鎖の失敗（page、SEV2） | [incident-response.md](incident-response.md) の「その他」 | 作成済み | `otel-baseline`、`audit-log-table-and-archive` |
| ワークスペースのクラスタの移動（S2） | `workspace-move.md`（infrastructure.md の 14 節） | S2 の着手で作成 | `workspace-move`（[roadmap.md](../roadmap.md) の延期の一覧の S2 の候補） |

### 4.1 領域との対応

| 領域 | アラート・手順 |
| --- | --- |
| [sync-engine.md](../architecture/sync-engine.md) | 書き込みの経路の SLO、`sync-propagation-lag.md`、`writer-lock-contention.md`、`convergence-mismatch.md`、[incident-response.md](incident-response.md) の「伝播の遅れ」「収束の不一致」 |
| [bootstrap-and-partial-sync.md](../architecture/bootstrap-and-partial-sync.md) | `bootstrap-overload.md`、`sync-log-retention.md`、`private-team-leak-response.md`、[disaster-recovery.md](disaster-recovery.md) の D |
| [client-store-and-offline.md](../architecture/client-store-and-offline.md) | `client-storage-eviction.md`、`client-migration-failure.md`、`outbox-backlog.md` |
| [client-app.md](../architecture/client-app.md) | `latency-regression.md`、`ime-regression.md`、[deploy-and-rollback.md](deploy-and-rollback.md) の C |
| [data-model-and-schema.md](../architecture/data-model-and-schema.md) | `schema-expand-contract.md`、`issue-number-repair.md` |
| [editor-and-descriptions.md](../architecture/editor-and-descriptions.md) | `doc-compaction-lag.md`、`doc-corruption.md`、`attachment-url-leak.md` |
| [issues-and-workflow.md](../architecture/issues-and-workflow.md) | `lifecycle-jobs.md`、`mass-auto-close-rollback.md`、`trash-restore-request.md` |
| [cycles-and-projects.md](../architecture/cycles-and-projects.md) | `cycle-rollover-stuck.md`、`cycle-settings-mistake.md`、`progress-recount.md` |
| [views-and-filters.md](../architecture/views-and-filters.md) | `view-query-slow.md`、`filter-divergence.md` |
| [search.md](../architecture/search.md) | `search-index-lag.md`、`search-reindex.md`、`opensearch-outage.md` |
| [permissions-and-teams.md](../architecture/permissions-and-teams.md) | `private-team-leak-response.md`、`subscription-drift-repair.md`、`team-privacy-toggle.md` |
| [accounts-and-auth.md](../architecture/accounts-and-auth.md) | `auth-outage.md`、`account-takeover-response.md`、`better-auth-advisory.md`、`invite-abuse.md` |
| [notifications-and-inbox.md](../architecture/notifications-and-inbox.md) | `notifier-lag.md`、`email-delivery-issues.md`、`notification-storm.md` |
| [integrations.md](../architecture/integrations.md) | `integration-ingress-outage.md`、`integration-token-failure.md`、`git-automation-misfire.md`、`integration-secret-leak.md` |
| [api-and-webhooks.md](../architecture/api-and-webhooks.md) | `webhook-backlog.md`、`api-abuse.md`、`leaked-token-response.md` |
| [import-export.md](../architecture/import-export.md) | `import-stuck.md`、`import-degrades-workspace.md`、`import-undo-request.md` |
| [security.md](../architecture/security.md) | [incident-response.md](incident-response.md)、`lost-device.md`、`workspace-deletion.md`、`support-access.md` |
| [infrastructure.md](../architecture/infrastructure.md)、[capacity.md](../architecture/capacity.md) | [disaster-recovery.md](disaster-recovery.md)、`reconnect-storm.md`、`workspace-move.md`（S2） |
| [delivery.md](../architecture/delivery.md) | [deploy-and-rollback.md](deploy-and-rollback.md)、`schema-expand-contract.md` |
| [observability.md](../architecture/observability.md) | アラートの条件の実装側（5.4 節） |
| [data-model.md](../architecture/data-model.md) | 索引のみ。運用の対象は各領域の文書で扱う |

- 領域の文書が提案した runbook のうち、`sync-epoch-bump.md`・`workspace-restore-and-epoch.md`・`epoch-reset-capacity.md` は [disaster-recovery.md](disaster-recovery.md) の B・D に、`electron-release-halt.md` は [deploy-and-rollback.md](deploy-and-rollback.md) の C に、`privacy-leak-response.md` は `private-team-leak-response.md` にまとめた。

## 5. 定期作業と訓練

| 作業 | 頻度 | 手順 |
| --- | --- | --- |
| 計画外の切り替えの訓練（staging。東京の Aurora を止めて `--allow-data-loss`、直前の 10 秒に狭める操作を入れる。`sync_epoch` の引き上げ、狭める操作のやり直し、やり直しの殺到、戻し） | 四半期 | [disaster-recovery.md](disaster-recovery.md) の E（合格基準は [quality.md](../quality.md) の 2.4 節） |
| 計画的な切り替え（本番の switchover。`sync_epoch` を上げない。1 日運用して戻す） | 年 1 回 | [disaster-recovery.md](disaster-recovery.md) の B・E |
| ワークスペースの差し替えの訓練（staging） | 半年 | [disaster-recovery.md](disaster-recovery.md) の D・E |
| AZ の障害の訓練（staging。FIS で 1 AZ を切り離す。Aurora のフェイルオーバー、Gateway の再接続） | 半年 | [disaster-recovery.md](disaster-recovery.md) の A |
| 大阪の待機の構成の確認（合成監視 1 分、Terraform の差分と ECR・Secrets・KMS のレプリカは日次、スナップショットは 1 時間、クォータは月次） | 月次（まとめ） | [infrastructure.md](../architecture/infrastructure.md) の 6.5 節 |
| 負荷試験（L1〜L9。大きな催しの前は L1 の 2 倍を 1 時間） | 半年ごと、同期エンジンの大きな変更の後、E12 | [capacity.md](../architecture/capacity.md) の 8 節 |
| キャパシティの見直し（接続、変更/秒、上位のワークスペース、ロックの待ち、Gateway の送信、reader の CPU） | 月次（上位の一覧は週次、予測は四半期） | [capacity.md](../architecture/capacity.md) の 9 節 |
| 費用の見直し（タグごと。データ転送と圧縮の率） | 月次 | [infrastructure.md](../architecture/infrastructure.md) の 11 節 |
| 収束の監査・配信の監査の結果の確認 | 日次 | [quality.md](../quality.md) の 4.2 節 |
| 購読の監査（`subscription_drift`） | 日次（自動） | `subscription-drift-repair.md`（E4） |
| 進捗の数え直し（`progress_reconcile_drift`） | 日次（自動） | `progress-recount.md`（E7） |
| シミュレーターのミューテーションの試験（わざと誤りを入れたバージョンで失敗を見つける） | 四半期（QA が実行） | [ADR-0010](../decisions/0010-deterministic-sync-simulator.md) の Confirmation |
| IME の組み合わせの手動の確認 | ブラウザ・OS・Electron の大きなバージョンの更新のたび（QA が実行） | [quality.md](../quality.md) の 2.2.1 節 |
| 固定の機械のランナーの較正の基準の見直し、予備の機械の確認 | 四半期 | [delivery.md](../architecture/delivery.md) の 2.3 節 |
| `release.*` のフラグの消し忘れの一覧 | 週次 | [delivery.md](../architecture/delivery.md) の 3 節 |
| 秘密の入れ替え（添付の `upload_ref` の HMAC の鍵、CloudFront の署名の鍵、CloudFront → ALB の秘密のヘッダー） | 90 日 | [security.md](../architecture/security.md) の 7 節 |
| GitHub App の秘密鍵の入れ替え | 年 1 回 | 同上 |
| 外部のペンテスト | GA の前（E12）、以後年 1 回と大きな変更の後 | [security.md](../architecture/security.md) の 10 節 |
| DAST（staging） | 夜間とリリースの前 | 同上 |
| インシデント対応の机上訓練（非公開のチームの漏えい、収束の不一致、DR の権限の戻りを想定） | 年 1 回 | [incident-response.md](incident-response.md) |
| 訓練の記録の見直し（目標の未達を Intent へ。RTO の内訳、reader の追加の時間、散らしの幅の実績を capacity.md に反映する提案） | 四半期 | 各 runbook の「事後」 |

## 6. 作成済みの runbook

| runbook | 場面 |
| --- | --- |
| [incident-response.md](incident-response.md) | 共通の進め方、伝播の遅れ、収束の不一致、非公開のチームの漏えいの疑い、端末の保存の消去、その他 |
| [deploy-and-rollback.md](deploy-and-rollback.md) | サーバーのリリースとロールバック、Web のクライアント、Electron、収束・outbox に関わる不具合 |
| [disaster-recovery.md](disaster-recovery.md) | AZ の障害、リージョンの障害（`sync_epoch` の引き上げと狭める操作のやり直し）、複製の遅延、ワークスペースの戻し、訓練 |

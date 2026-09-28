# Runbooks: Salesforce

Ops が持つ運用の文書。品質の判定基準は [quality.md](../quality.md) の 4 節、SLI の計測の仕組みは [observability.md](../architecture/observability.md) にある。**SLO の値とアラートの一覧の正本はこの文書** で、observability.md の 3・7 節と [ADR-0058](../decisions/0058-slis-and-per-org-resource-metrics.md) は、これを計測・実装する側の記述である。

作成済みの手順：

| 手順 | 中身 |
| --- | --- |
| [incident-response.md](incident-response.md) | インシデントの宣言と重さ、共通の進め方、この題材に固有の 4 つの場面（共有の漏えい、騒がしい隣人、Sandbox のマスキングの事故、組織のデータの漏えい）、依存先の障害 |
| [deploy-and-rollback.md](deploy-and-rollback.md) | 本番へのデプロイ（アプリ、マイグレーション、Terraform）、フラグの段、影の実行の食い違い、ロールバック |
| [disaster-recovery.md](disaster-recovery.md) | AZ の障害、リージョンの障害（大阪への切り替え）、失った範囲の取り出し、複製の遅れ、論理的な破損、訓練 |

## 1. SLI と SLO

S1 の本番の組織（`kind = production`）が対象。Sandbox・試用・Developer の組織は SLO の外（計測はする）。窓は **28 日の移動の窓**（SLA の報告は暦の月）。

| SLI | 定義 | SLO | 許容範囲を外れたときの扱い | 品質の判定に使う |
| --- | --- | --- | --- | --- |
| 対話の可用性 | `runtime` の要求のうち 5xx でない割合（ALB）と、合成監視の成功の割合の低い方 | **99.9%**（NFR-006） | 速い燃え方（1 時間 14 倍）で呼び出し、遅い燃え方（6 時間 6 倍）でチケット。エラーバジェットを使い切ったら修正以外のデプロイとフラグの拡大を止める | |
| レコードのページの速さ | `GET /api/v1/ui/records/{id}` の p95・p99 | **300ms・800ms**（NFR-001、K1） | 燃え方で扱う。p95 が 15 分続けて超えたらチケット（`record-page-slow`） | ○ |
| リストビューの速さ | 最初のページの p95（選択的な条件、100 万件まで） | **500ms**（NFR-001） | 15 分続けて超えたらチケット | |
| REST の 1 件の読み書き | p95・p99（自動化の時間を除く） | **200ms・500ms**（NFR-002） | 15 分続けて超えたらチケット | |
| 問い合わせ | 選択的な条件の p95 | **500ms**（NFR-002） | 15 分続けて超えたらチケット（`query-plan-regression`） | |
| メタデータの記述 | p95 | **100ms**（NFR-002） | 1 時間続けて超えたらチケット | |
| メタデータの反映 | カスタム項目の追加から、別のタスクで使えるまでの p95 | **5 秒**（K2、[ADR-0007](../decisions/0007-segmented-metadata-snapshots.md)） | 1 時間続けて超えたらチケット | ○ |
| メタデータの確定の止まり | 版を上げる排他のロックの間の書き込みの待ちの p99 | **1 秒**（NFR-004） | 15 分続けて超えたらチケット（`deploy-lock-stall`） | ○ |
| 変更のイベントの遅れ | 確定から購読者に届くまでの p95（合成監視） | **5 秒**（NFR-010） | Relay の遅れ p95 30 秒で呼び出し（`event-relay-lag`） | ○ |
| 項目の変更の履歴の写しの遅れ | 確定から `history` のクラスタに入るまでの p95 | **5 秒**（[ADR-0047](../decisions/0047-field-history-tracking-and-retention.md) の注記） | Relay の遅れと同じに扱う。p95 30 秒で呼び出し | |
| Webhook の配信 | 確定から最初の送信までの p95 | **30 秒** | 1 時間続けて超えたらチケット | |
| 検索の索引の遅れ | 確定から索引に入るまでの p95・p99 | **5 秒・30 秒**（[ADR-0031](../decisions/0031-search-index-and-japanese-analysis.md)。一括の取り込みの分は除く） | p95 60 秒を 5 分でチケット（`search-index-lag`） | |
| 検索の速さ | 全体の検索の p95 | **800ms** | 1 時間続けて超えたらチケット | |
| レポートの同期 | p95 | **5 秒**（初期見積もり） | 1 時間続けて超えたらチケット（`report-heavy-org`） | |
| 共有の再計算 | レコードの条件のルールの追加の完了の時間（100 万件・1,000 人）。閉包の世代（同） | **15 分・5 分**（NFR-005、K6） | 1 時間進まないジョブはチケット（`sharing-job-stuck`） | ○ |
| 一括の取り込み | 100 万件の完了の時間（自動化が軽い時） | **30 分**（NFR-010） | ジョブが 1 時間進まなければチケット（`bulk-job-stuck`） | |
| ログイン | ログインの送信の p95 | **500ms** | 15 分続けて超えたらチケット | |
| 公平 | 重い組織がいる時の、他の組織の p95 の悪化 | **10% 以内**（NFR-003、K4） | 重い組織と悪化が重なったら呼び出し（`noisy-neighbor-db-time`） | ○ |
| アクセスの判定の正しさ | `access_oracle_mismatch_total{direction="over"}` | **0**（K3） | 1 件で呼び出し（セキュリティ。SEV2 から） | ○ |
| 影の実行の食い違い | `shadow_eval_results` の食い違い | **0** | 1 件でリリースを止める（チケット） | ○ |
| 写しの整合 | `pivot_drift_repaired_total`・`rollup_mismatch_total`・`search_drift_repaired_total` | **0** | 1 件でチケット | ○ |
| データの消去の遅れ | 全ての `*_overdue`（[security.md](../architecture/security.md) の 7 節） | **0** | 1 件でチケット | ○ |
| 出力の走査 | ログ・トレースの標本の秘密・個人データの検出 | **0** | 1 件で呼び出し（セキュリティ） | ○ |
| 監査の鎖 | 毎週の鎖の確かめの食い違い | **0** | 1 件で呼び出し（セキュリティ） | ○ |
| DR の複製の遅延 | `AuroraGlobalDBRPOLag`（主・`events`・`history`） | **10 秒以内** | 10 秒超が 10 分続けばチケット | |

- 28 日の窓で 99.9% のエラーバジェットは約 40 分。合成監視（東京で 3 回続けて失敗で呼び出し）と燃え方の 2 つで見る（[observability.md](../architecture/observability.md) の 3 節）。
- 「品質の判定に使う」に○がある指標は、QA が品質の判定基準に使う（[quality.md](../quality.md) の 4.1 節）。定義を変えるときは QA と合意する。
- 組織ごとの可用性と速さも `org_request_minutes` で記録し、大口の組織のサポートと SLA の報告に使う（SLO にはしない）。
- 復旧の目標：AZ の障害は RPO 0・RTO 5 分（NFR-007）、リージョンの障害は RPO 1 分・RTO 1 時間（NFR-008）。

## 2. 組織ごとの上限と割り当て

値の正本は [governor-limits.md](../architecture/governor-limits.md)（登録簿と同じ内容。[ADR-0041](../decisions/0041-limits-registry-and-counting-rules.md)）。1 トランザクションの上限は全ての組織で同じで、エディションで変えない（[ADR-0005](../decisions/0005-tenancy-and-governor-limits.md)）。

- 割り当ての一時的な引き上げ（`org_allocations.source = override`）は Ops が判断し、組織の監査に `support` として残す（`org-allocation-exceeded`）。大きな引き上げ（2 倍以上）は、クラスタの DB の時間の余裕（[capacity.md](../architecture/capacity.md)）を確かめてから承認する。
- 騒がしい隣人の対処の段（長い要求の同時実行の一時的な引き下げ → 連携のクライアントの停止 → 割り当ての引き下げ → 非同期の仕事の停止）は人が決める（[ADR-0059](../decisions/0059-noisy-neighbor-detection-two-sources.md)、[incident-response.md](incident-response.md) の「騒がしい隣人」）。
- 上限の値を本番の障害で先に変える時は、開発リポジトリの `limits-exceptions.yaml` に 24 時間の期限で書き、期限の内に governor-limits.md を直す（[delivery.md](../architecture/delivery.md) の 2.3 節）。

## 3. リリースとロールバック

流れの正本は [delivery.md](../architecture/delivery.md)、手順は [deploy-and-rollback.md](deploy-and-rollback.md)。

- **デプロイとリリースを分ける。** デプロイ（コードを置く）は Ops が承認し、リリース（振る舞いを有効にする）は PM が判断する。全ての新しい振る舞いは release フラグ（AppConfig、組織の ID で評価）の裏に置く。
- **組織を単位に段階で広げる**（[ADR-0063](../decisions/0063-org-staged-release-and-shadow-evaluation.md)）：`internal`（社内の組織と監視の組織）→ `nonprod`（Sandbox・試用・Developer）→ `prod_1` → `prod_10` → `prod_50` → `all`。1 つの段は 24 時間以上、アクセスの判定を変えるものは 72 時間以上。Sandbox は元の本番の組織の段を継ぐが、`nonprod` の段で先に有効になる。組織の移動の間は段を変えない。
- **アクセスの判定を変える時は、`internal` の前に影の段を置く。** アクセスの判定、問い合わせのコンパイラ、共有の条件の生成、検索・レポートのコンパイルを変える時、本番の要求の標本（組織ごとに 1 分 10 件、全体で 1 秒 100 件まで）を新旧のコンパイラで比べる。影の段は 72 時間以上。食い違いが 1 件でもあれば進めない。`new_correct` の `over`（今の本番が多く見せている）は、[incident-response.md](incident-response.md) の「共有の漏えい」へ進む。
- **次の段へ進む条件**：その段の組織の SLI の悪化がない、エラーの率が変わらない、`access_oracle_mismatch_total{direction="over"}` が 0、影の実行の食い違いが 0。Ops が確かめて進める（自動で進めない）。
- **ガード**：段の組織の SLO の燃え方が 1 時間 14 倍を超えたら、フラグを自動で前の段に戻す。
- **デプロイの順**：マイグレーション（expand）→ `worker`・`relay`・`indexer` → `metadata`・`bulk` → `runtime`（blue/green、10% → 50% → 100%）。他は 1 AZ ずつのローリング。prod-egress の `sender` は Elastic IP を変えない（変えるなら `egress-ip-change` の 30 日前の知らせが先）。
- **メタデータのコンパイル済みの部品・カーソル・監査の `details`・パッケージの形を変える時は、新旧の両方を読めるコードを先に出す**（部品の鍵に形の版を含める）。
- `security:sensitive` の変更は、作成者と別の 2 人（Dev のテックリードとセキュリティの担当）の承認が要る。ロールバックの PR だけ、2 人目の承認を事後 24 時間以内でよい（[ADR-0062](../decisions/0062-security-sensitive-change-flow.md)）。
- 上限の登録簿を変える PR は、rebuilds の governor-limits.md が先にマージされている（CI の一致の検査）。
- **ロールバックはまずフラグで行う。** 次に 1 つ前のイメージ。マイグレーションは戻さず、前へ進める修正を書く。

### 3.1 デプロイの時間帯と凍結

| 対象 | 時間帯 | 凍結（修正だけ） |
| --- | --- | --- |
| アプリ（`runtime`、`metadata`、`bulk`、`worker`、`relay`、`indexer`） | 平日 10〜17 時 | 暦の月末の 3 営業日（営業の締め）、年末年始、エラーバジェットを使い切っている間、夜間の CI が失敗している間（フラグの拡大も止める） |
| マイグレーションの contract | 平日の午前、別のデプロイとして | アプリと同じ |
| Terraform（IAM・KMS・SCP・ネットワーク、prod-egress） | 平日 10〜16 時。WAF の新しい Block は Count で 24 時間出してから | アプリと同じ |
| 組織の移動 | 夜間の時間帯。組織の管理者へ 7 日前に知らせる | 月末の 3 営業日、年末年始 |
| DR の switchover（訓練・戻し） | 平日の夜間、組織へ 14 日前に告知 | 大きな営業の締めの日を避ける |

- 脆弱性の修正（Critical）は時間帯の制限を受けない。2 人の承認、決定表・性質・漏えいの経路のテストは省かない。
- 凍結の予定（年末年始、組織から知らされた大きな締め）は、Ops が四半期ごとにこの表の下に書き足し、PM と合意する。

## 4. アラートと手順

「作成済み」以外の手順は、各 Epic の実装に合わせて [templates/runbook.md](../../../../docs/templates/runbook.md) から作る。できるまでは [incident-response.md](incident-response.md) の該当の節で対応する。アラートの条件は [observability.md](../architecture/observability.md) の 7 節。すべてのアラートは、対応する runbook の URL を注釈に持つ（CI で検査する）。重さは `page`（呼び出し）と `ticket`（翌営業日）。

| アラート | 重さ | 手順 | 状態 | Epic |
| --- | --- | --- | --- | --- |
| SLO の速い燃え方（1 時間 14 倍）・遅い燃え方（6 時間 6 倍）、合成監視の連続失敗（東京で 3 回） | page・ticket | [incident-response.md](incident-response.md) | 作成済み | E1 `synthetic-monitoring`、E12 `slo-and-alert-tuning` |
| 大阪からの合成監視の全失敗、AZ・リージョンの障害、`AuroraGlobalDBRPOLag`（10 秒を 10 分）、論理的な破損 | page・ticket | [disaster-recovery.md](disaster-recovery.md) | 作成済み | E1 `osaka-warm-standby-skeleton`、E12 `dr-drills` |
| デプロイの後の悪化、`runtime` の blue/green の自動のロールバック、フラグのガードの自動の段の戻し、影の実行の食い違い | page・ticket | [deploy-and-rollback.md](deploy-and-rollback.md) | 作成済み | E1 `flags-org-stages`、E4 `shadow-evaluation` |
| 参照の評価器の食い違い `over`（1 件） | page（セキュリティ） | [incident-response.md](incident-response.md) の「共有の漏えい」、`access-oracle-mismatch.md` | 共通は作成済み。個別は E4 で作成 | E4 `access-oracle-sampling` |
| 参照の評価器の食い違い `under`（1 件） | ticket | `access-oracle-mismatch.md` | E4 で作成 | E4 `access-oracle-sampling` |
| 組織をまたぐ漏えいの疑い（性質の検査、利用者の報告）、出力の走査で秘密・個人データ | page（SEV1・セキュリティ） | [incident-response.md](incident-response.md) の「組織のデータの漏えい」、`secret-exposure.md` | 共通は作成済み。`secret-exposure` は E1 で作成 | E1 `telemetry-and-log-types` |
| マスキングの警告・伏せていない値の検出 | page（セキュリティ） | [incident-response.md](incident-response.md) の「Sandbox のマスキングの事故」、`sandbox-masking-incident.md` | 共通は作成済み。個別は E10 で作成 | E10 `sandbox-masking` |
| 騒がしい隣人（重い＋他の組織の悪化）、計測の漏れ | page・ticket | [incident-response.md](incident-response.md) の「騒がしい隣人」、`noisy-neighbor-db-time.md` | 共通は作成済み。個別は E12 で作成 | E12 `noisy-neighbor-tests` |
| KMS の異常な操作（CloudTrail）、KMS の障害 | page（セキュリティ） | [incident-response.md](incident-response.md)、`kms-outage.md` | 共通は作成済み。`kms-outage` は E1 で作成 | E1 `kms-and-org-deks` |
| 監査の鎖の食い違い | page（セキュリティ） | `audit-chain-mismatch.md` | E11 で作成 | E11 `audit-events-chain` |
| 錨の書き込みの失敗（2 日） | ticket | `audit-anchor-failed.md` | E11 で作成 | E11 `audit-events-chain` |
| `audit_pending` の移しの遅れ（1 分） | ticket | `audit-pending-lag.md` | E11 で作成 | E11 `audit-events-chain` |
| Relay の遅れ（p95 30 秒。変更のイベント・履歴の写し） | page | `event-relay-lag.md` | E1 で作成 | E1 `outbox-and-relay` |
| `events` のクラスタの障害 | page | `events-cluster-degraded.md` | E8 で作成 | E8 `event-stream-api` |
| `history` のクラスタの障害 | ticket | `history-cluster-degraded.md`（outbox の滞留と、履歴の画面の 503） | E11 で作成 | E11 `field-history-tracking` |
| 検索の索引の遅れ（p95 60 秒を 5 分） | ticket | `search-index-lag.md` | E5 で作成 | E5 `search-index-pipeline` |
| OpenSearch の障害（`degraded` の率 5%） | ticket | `search-degraded.md` | E5 で作成 | E5 `lookup-typeahead-and-degraded` |
| マッピングの変更、組織・オブジェクトの作り直し | — | `search-reindex.md` | E5 で作成 | E5 `search-index-pipeline` |
| 検索の整合の検査の直しの急増 | ticket | `search-drift-high.md` | E5 で作成 | E5 `search-index-pipeline` |
| reader の遅れ（30 秒・5 分） | ticket・page | `reader-replica-lag.md` | E7 で作成 | E7 `report-sync-async` |
| レポートの非同期の待ち（1 時間） | ticket | `report-async-backlog.md` | E7 で作成 | E7 `report-sync-async` |
| 組織のレポートの DB の時間が多すぎる | ticket | `report-heavy-org.md` | E7 で作成 | E7 `report-sync-async` |
| 定期の配信の遅れ（1 時間） | ticket | `report-subscription-delay.md` | E7 で作成 | E7 `subscriptions-and-exports` |
| メタデータの確定の止まり（p99 1 秒を 15 分） | ticket | `deploy-lock-stall.md` | E10 で作成 | E10 `deploy-apply` |
| 組織のメタデータのデプロイの戻し（組織の管理者の依頼） | — | `deploy-rollback.md` | E10 で作成 | E10 `deploy-quick-and-rollback` |
| デプロイの後の仕事の失敗 | ticket | `deploy-post-job-failed.md` | E10 で作成 | E10 `deploy-apply` |
| Sandbox の複製が 24 時間を超える | ticket | `sandbox-copy-stuck.md` | E10 で作成 | E10 `sandbox-data-copy` |
| 部品のコンパイルの失敗（`metadata_compile_failures_total`） | ticket | `metadata-compile-failure.md` | E3 で作成 | E3 `segmented-snapshot-cache` |
| Valkey の障害で L2 が使えない | ticket | `metadata-cache-degraded.md` | E3 で作成 | E3 `segmented-snapshot-cache` |
| 型の変換が 24 時間を超える | ticket | `field-conversion-stuck.md` | E3 で作成 | E3 `field-delete-and-conversion` |
| 削除した項目の消去が 7 日を超える | ticket | `field-purge-overdue.md` | E3 で作成 | E3 `field-delete-and-conversion` |
| ピボットの差（1 件） | ticket | `pivot-drift-detected.md` | E3 で作成 | E3 `consistency-checks` |
| ごみ箱の消去が 24 時間を超える、その他の `*_overdue` | ticket | `purge-overdue.md` | E3 で作成 | E3 `recycle-bin-and-purge`、E11 `retention-and-erasure` |
| 戻すの衝突の問い合わせ | — | `recycle-bin-restore-conflict.md` | E3 で作成 | E3 `recycle-bin-and-purge` |
| 保持の期限の分割の `DROP` の遅れ（7 日） | ticket | `retention-drop-overdue.md` | E11 で作成 | E11 `retention-and-erasure` |
| 組織の消去が 7 日を超える | ticket | `org-purge-overdue.md` | E2 で作成 | E2 `org-deletion-and-purge` |
| 組織の削除の後の DEK の破棄の確かめ | — | `org-key-destroy-verify.md` | E2 で作成 | E2 `org-deletion-and-purge` |
| 問い合わせの p95・`query_replans_total` の悪化 | ticket | `query-plan-regression.md` | E3 で作成 | E3 `query-stats-and-planner` |
| 組織の `NON_SELECTIVE_QUERY` の急増 | ticket | `non-selective-query-spike.md` | E3 で作成 | E3 `query-stats-and-planner` |
| 統計の毎晩のジョブの失敗 | ticket | `stats-job-failed.md` | E3 で作成 | E3 `query-stats-and-planner` |
| 割り当ての 100%・110% | ticket | `org-allocation-exceeded.md` | E3 で作成 | E3 `org-allocations` |
| Valkey と DB の数のずれ（5%） | ticket | `limit-counter-drift.md` | E3 で作成 | E3 `org-allocations` |
| Worker の待ち（class で 15 分） | ticket | `worker-queue-backlog.md` | E9 で作成 | E9 `fair-queue-jobs` |
| 共有のジョブの停止（1 時間）、切り替えの前の照合で止まった | ticket | `sharing-job-stuck.md` | E4 で作成 | E4 `criteria-rules-versioning` |
| 共有の計算の保留が 7 日を超える | ticket | `sharing-deferred-too-long.md` | E4 で作成 | E4 `closure-generations-and-defer` |
| スキュー・閉包の大きさの警告 | ticket | `data-skew-warning.md` | E12 で作成 | E12 `sharing-recalc-load` |
| レコードのページの p95 が 300ms を超える | ticket | `record-page-slow.md` | E5 で作成 | E5 `record-page-api` |
| レイアウトのコンパイルの失敗で既定のレイアウトに落ちる | ticket | `layout-compile-fallback.md` | E5 で作成 | E5 `record-page-api` |
| 選択的でないリストビューが多い組織 | ticket | `list-view-non-selective.md` | E5 で作成 | E5 `list-views` |
| 照合の鍵の作成が 24 時間を超える | ticket | `match-keys-building-stuck.md` | E5 で作成 | E5 `matching-and-duplicate-rules` |
| 候補の上限を超える照合が多い | ticket | `duplicate-overflow-high.md` | E5 で作成 | E5 `matching-and-duplicate-rules` |
| メールの受信の滞留（15 分） | ticket | `email-intake-backlog.md` | E5 で作成 | E5 `email-bcc-logging` |
| 差出人の検査の失敗の急増 | ticket | `email-intake-spoofing.md` | E5 で作成 | E5 `email-bcc-logging` |
| SES の bounce の率の上昇 | ticket | `ses-bounce-rate-high.md` | E5 で作成 | E5 `email-sending` |
| フローの実行時のエラーの急増（1 時間 100 件） | ticket | `flow-runtime-errors-spike.md` | E6 で作成 | E6 `record-triggered-flows` |
| 予定の経路の遅れ（1 時間） | ticket | `flow-scheduled-actions-lag.md` | E6 で作成 | E6 `scheduled-paths-and-async` |
| 積み上げ集計の差（1 件） | ticket | `rollup-mismatch.md` | E6 で作成 | E6 `rollup-summaries` |
| `rollup_stale` が 1 時間を超えてたまる | ticket | `rollup-stale-backlog.md` | E6 で作成 | E6 `rollup-summaries` |
| 承認者を決められない・読めないインスタンス | ticket | `approval-instance-error.md` | E6 で作成 | E6 `approval-processes` |
| スケジュールのフローの 24 時間の上限の超過 | ticket | `scheduled-flow-quota-exceeded.md` | E6 で作成 | E6 `scheduled-flows` |
| Webhook の宛先が 72 時間で止まった | ticket | `webhook-endpoint-disabled.md` | E8 で作成 | E8 `webhooks` |
| 宛先の検査の拒否の急増（平常の 10 倍） | ticket | `outbound-ssrf-blocked-spike.md` | E8 で作成 | E8 `outbound-calls-and-ssrf-guard` |
| 送信元の IP を変える | — | `egress-ip-change.md`（30 日前の知らせ） | E8 で作成 | E8 `prod-egress-account` |
| 一括のジョブの停止（1 時間） | ticket | `bulk-job-stuck.md` | E9 で作成 | E9 `bulk-split-and-process` |
| `UNABLE_TO_LOCK_ROW` が多い組織 | ticket | `bulk-lock-contention.md` | E9 で作成 | E9 `bulk-split-and-process` |
| 一括の結果・元の CSV の消去の遅れ | ticket | `bulk-result-storage-cleanup.md` | E9 で作成 | E9 `bulk-ingest-api` |
| 文字化けの問い合わせ | — | `import-encoding-issue.md` | E9 で作成 | E9 `import-wizard` |
| 1 組織・1 IP のログインの失敗の急増 | page | `login-attack.md` | E2 で作成 | E2 `better-auth-login-mfa` |
| 組織の IdP の障害 | ticket | `org-idp-outage.md`（`sso_bypass` の案内） | E2 で作成 | E2 `org-sso-saml-oidc` |
| Better Auth の勧告 | ticket | `better-auth-advisory.md` | E2 で作成 | E2 `better-auth-login-mfa` |
| 最後の管理者を失った組織の復旧 | — | `last-admin-recovery.md`（2 人の承認） | E4 で作成 | E4 `system-permissions-and-delegation` |
| break-glass の申請 | — | `support-break-glass.md` | E1 で作成 | E1 `operator-jit-access` |
| 履歴の行が見積もりを大きく超える組織 | ticket | `field-history-growth.md` | E11 で作成 | E11 `field-history-tracking` |
| 組織の移動 | — | `org-migration.md`（手順と中止） | E12 で作成 | E12 `org-migration-tool` |
| 主のクラスタの分割（段階の基準） | — | `cluster-split.md` | S2 の前に作成 | S2 の準備 |
| 射影の表の作成・作り直し・廃止 | — | `projection-create.md`・`projection-rebuild.md`・`projection-drop.md` | E12 で作成（S2 の準備） | E12 `projections-s2-prep` |
| 四半期のキャパシティの見直し | — | `capacity-review.md` | E12 で作成 | E12 `capacity-review-and-cost` |
| `code-runner` の再起動の繰り返し（5 分に 3 回） | page | `code-runner-crash-loop.md` | E13 で作成 | E13 `code-runner` |
| トリガーのエラーの急増 | ticket | `code-trigger-errors-spike.md` | E13 で作成 | E13 `triggers-in-dml` |
| Wasmtime・QuickJS-ng の勧告 | ticket | `wasm-runtime-advisory.md` | E13 で作成 | E13 `code-runner` |
| 配布者の鍵の失効 | — | `package-signing-key-revoked.md` | E14 で作成 | E14 `namespaces-and-publisher-keys` |

### 4.1 領域との対応

| 領域 | アラート・手順 |
| --- | --- |
| [metadata-and-runtime.md](../architecture/metadata-and-runtime.md) | `metadata-compile-failure`、`metadata-cache-degraded`、`field-conversion-stuck`、`field-purge-overdue`、メタデータの反映（K2）・確定の止まりの SLO |
| [data-storage.md](../architecture/data-storage.md) | `pivot-drift-detected`、`purge-overdue`、`recycle-bin-restore-conflict`、`projection-*`（S2） |
| [sharing-and-record-access.md](../architecture/sharing-and-record-access.md) | `access-oracle-mismatch`、`sharing-job-stuck`、`sharing-deferred-too-long`、`data-skew-warning`、[incident-response.md](incident-response.md) の「共有の漏えい」 |
| [query-language-and-api.md](../architecture/query-language-and-api.md) | `query-plan-regression`、`non-selective-query-spike`、`stats-job-failed` |
| [sales-objects.md](../architecture/sales-objects.md) | `match-keys-building-stuck`、`duplicate-overflow-high`、`email-intake-backlog`、`email-intake-spoofing` |
| [ui-layouts-and-list-views.md](../architecture/ui-layouts-and-list-views.md) | `record-page-slow`、`layout-compile-fallback`、`list-view-non-selective` |
| [automation-flows.md](../architecture/automation-flows.md) | `flow-runtime-errors-spike`、`flow-scheduled-actions-lag`、`rollup-mismatch`、`rollup-stale-backlog`、`approval-instance-error`、`scheduled-flow-quota-exceeded` |
| [reports-and-dashboards.md](../architecture/reports-and-dashboards.md) | `reader-replica-lag`、`report-async-backlog`、`report-heavy-org`、`report-subscription-delay` |
| [search.md](../architecture/search.md) | `search-index-lag`、`search-degraded`、`search-reindex`、`search-drift-high` |
| [events-and-integrations.md](../architecture/events-and-integrations.md) | `event-relay-lag`、`events-cluster-degraded`、`webhook-endpoint-disabled`、`outbound-ssrf-blocked-spike`、`egress-ip-change`、`ses-bounce-rate-high` |
| [bulk-and-import.md](../architecture/bulk-and-import.md) | `bulk-job-stuck`、`bulk-lock-contention`、`bulk-result-storage-cleanup`、`import-encoding-issue` |
| [sandboxes-and-deploy.md](../architecture/sandboxes-and-deploy.md) | `sandbox-copy-stuck`、`sandbox-masking-incident`、`deploy-lock-stall`、`deploy-rollback`、`deploy-post-job-failed` |
| [governor-limits.md](../architecture/governor-limits.md) | `org-allocation-exceeded`、`noisy-neighbor-db-time`、`worker-queue-backlog`、`limit-counter-drift` |
| [orgs-users-and-auth.md](../architecture/orgs-users-and-auth.md) | `login-attack`、`org-idp-outage`、`better-auth-advisory`、`last-admin-recovery`、`org-purge-overdue` |
| [audit-and-field-history.md](../architecture/audit-and-field-history.md) | `audit-chain-mismatch`、`audit-anchor-failed`、`audit-pending-lag`、`field-history-growth`、`retention-drop-overdue`、`history-cluster-degraded` |
| [extensibility.md](../architecture/extensibility.md) | `code-runner-crash-loop`、`code-trigger-errors-spike`、`wasm-runtime-advisory`、`package-signing-key-revoked` |
| [security.md](../architecture/security.md) | [incident-response.md](incident-response.md)、`secret-exposure`、`support-break-glass`、`org-key-destroy-verify` |
| [infrastructure.md](../architecture/infrastructure.md)、[capacity.md](../architecture/capacity.md) | [disaster-recovery.md](disaster-recovery.md)、`org-migration`、`cluster-split`、`kms-outage`、`capacity-review` |
| [delivery.md](../architecture/delivery.md) | [deploy-and-rollback.md](deploy-and-rollback.md) |
| [observability.md](../architecture/observability.md) | アラートの条件の実装側（7 節） |
| [data-model.md](../architecture/data-model.md) | 索引のみ。運用の対象は各領域の文書で扱う |

## 5. 定期作業と訓練

| 作業 | 頻度 | 手順 |
| --- | --- | --- |
| staging の failover（書き込みを流しながら。主・`events`・`history`） | 四半期 | [disaster-recovery.md](disaster-recovery.md) の E（合格基準は [quality.md](../quality.md) の 2.5 節） |
| 本番の switchover（大阪で受けて戻す） | 年 1 回 | [disaster-recovery.md](disaster-recovery.md) の E |
| 論理的な破損の復旧（行の範囲と組織の全体） | 半年ごと（staging） | [disaster-recovery.md](disaster-recovery.md) の E |
| 組織の移動（最大の組織の写し） | 四半期（staging） | [disaster-recovery.md](disaster-recovery.md) の E、`org-migration`（E12） |
| 大阪の待機の構成の確認 | 月次（合成監視は 1 分ごと） | [disaster-recovery.md](disaster-recovery.md)、[infrastructure.md](../architecture/infrastructure.md) の 7 節 |
| 障害の注入（Relay の停止と二重の送信、Worker の停止、共有のジョブの途中の停止、Valkey の停止） | 夜間（CI）、四半期（staging） | [delivery.md](../architecture/delivery.md) の 2.2 節 |
| 監査の鎖の確かめ（全ての組織） | 毎週 | [audit-and-field-history.md](../architecture/audit-and-field-history.md) の 3.3 節 |
| 監査の改ざんの訓練（保守のロールで行を書き換え、鎖の確かめが見つける） | 半年ごと（staging） | `audit-chain-mismatch`（E11） |
| 共有の漏えいの机上訓練（`over` の食い違いから安全の設定まで） | 半年ごと | [incident-response.md](incident-response.md) の「共有の漏えい」 |
| Sandbox のマスキングの事故の机上訓練 | 年 1 回 | [incident-response.md](incident-response.md) の「Sandbox のマスキングの事故」 |
| 騒がしい隣人の訓練（重い組織を作り、検知と対処の段を通す） | 四半期（staging） | [incident-response.md](incident-response.md) の「騒がしい隣人」 |
| KMS の障害の縮退の確認 | 年 1 回（staging） | `kms-outage`（E1） |
| break-glass の訓練（申請、2 人の承認、記録、事後の知らせ） | 年 2 回（staging） | `support-break-glass`（E1） |
| 負荷試験（L1〜L8） | 半年ごと、リリース前、大きな変更の後 | [quality.md](../quality.md) の 2.4 節、[capacity.md](../architecture/capacity.md) |
| キャパシティの見直し（係数、段階の基準、OpenSearch の台数） | 四半期 | `capacity-review`、[capacity.md](../architecture/capacity.md) の 8 節 |
| 整合の検査の一周（ピボット・照合の鍵・積み上げ集計・検索） | 7 日で一周（小さなオブジェクトは毎日） | [data-storage.md](../architecture/data-storage.md) の 6 節 |
| 本番の標本の照合（参照の評価器） | 連続 | [sharing-and-record-access.md](../architecture/sharing-and-record-access.md) の 9.3 節 |
| 出力の走査（ログの標本） | 1 時間ごと | [observability.md](../architecture/observability.md) の 2.1 節 |
| ラベルのない PR の標本の見直し（20 件） | 四半期 | [delivery.md](../architecture/delivery.md) の 4.2 節 |
| 漏えいの経路の登録簿の見直し | 四半期 | [security.md](../architecture/security.md) の 4 節 |
| 運用者のアクセスのレビュー、期限を過ぎた割り当ての確認 | 四半期（期限の確認は週次） | [security.md](../architecture/security.md) の 6 節 |
| CloudFront → ALB の秘密のヘッダー、合成監視の資格情報のローテーション | 90 日 | [infrastructure.md](../architecture/infrastructure.md) の 2.1 節 |
| インシデント対応の机上訓練（組織をまたぐ漏えいを想定） | 年 1 回 | [incident-response.md](incident-response.md) |
| 外部のペンテスト | E12 と、その後は年 1 回と大きな変更の後。E13 の前に砂場 | [security.md](../architecture/security.md) の 9 節 |
| 訓練の記録の見直し（目標の未達を Intent へ） | 四半期 | 各 runbook の「訓練の記録」 |

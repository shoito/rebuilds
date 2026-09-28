# Runbooks: ServiceNow

Ops が持つ運用の文書。品質の判定基準は [quality.md](../quality.md) の 4 節、SLI の計測の仕組みは [observability.md](../architecture/observability.md) にある。**SLO の値とアラートの一覧の正本はこの文書** で、observability.md の 3.1・7.2 節と [ADR-0059](../decisions/0059-slis-timer-lag-and-correctness-monitors.md)・[ADR-0060](../decisions/0060-alerts-and-runbook-mapping.md) は、これを計測・実装する側の記述である。

| 作成済みの runbook | 中身 |
| --- | --- |
| [incident-response.md](incident-response.md) | 共通の進め方と、この題材に固有の場面（タイマーの遅れ、ACL の漏れの疑い、テナントの分離の破れの疑い、メールのループ、CMDB の誤った統合） |
| [deploy-and-rollback.md](deploy-and-rollback.md) | セルの段のデプロイ、メタデータのコンパイルの検査、フラグのガード、戻し方 |
| [disaster-recovery.md](disaster-recovery.md) | AZ・リージョンの障害、失った範囲の取り込み直し、論理的な破損、訓練 |

## 1. SLI と SLO

| SLI | SLO | 許容範囲を外れたときの扱い | 品質の判定に使う |
| --- | --- | --- | --- |
| 可用性（本番のテナントの画面・API・ポータル。エッジで数え、分類は observability の 3.2 節：4xx・429・421 は成功、503・5xx・タイムアウトは失敗。メールの受信を含む） | **月間 99.95%（セルごと）**（NFR-006、K5） | 速いバーンレートで呼び出し。エラーバジェットを使い切ったら修正以外のデプロイを止める | |
| フォームのサーバーの時間（レコード＋関連リストの最初の 1 ページ、ACL を含む） | **p99 300ms**（NFR-001、K1） | 15 分続いたらチケット。1 時間で呼び出し | |
| フォームを開くまで（RUM） | **p95 1 秒**（NFR-001、K1） | 1 日続いたらチケット | ○ |
| リストの 1 ページ（索引のある条件、50 行まで） | **p99 500ms**（NFR-001） | 15 分続いたらチケット。1 時間で呼び出し | |
| 保存（Record Service の `save`） | **p99 700ms**（NFR-002） | 15 分続いたらチケット | |
| タイマーの遅れ（発火のコミットの時刻 − `due_at`） | **優先度 0・1：p99 60 秒。優先度 2・3：9 時の山の間 p99 5 分**（NFR-003・004、[ADR-0061](../decisions/0061-load-model-cell-sizing-and-timer-bursts.md)） | 優先度 0 の p99 60 秒超が 5 分で呼び出し（SEV2） | ○ |
| SLA の違反の発火の遅れ（`sla.breached` のコミット − `planned_end`） | **p99 60 秒**（NFR-003、K2） | 同上 | ○ |
| 期限を過ぎた未発火の違反 | **0 件**（9 時の山でも） | 1 件以上が 5 分で呼び出し（SEV2） | ○ |
| 止まった実行（INV-FLOW-001） | **0 件** | 1 件でチケット（SEV3）、1 時間に 10 件で呼び出し | ○ |
| 索引の遅れ（コミットから検索できるまで） | **p95 5 秒、p99 30 秒** | p99 30 秒超が 15 分でチケット、5 分超で呼び出し | |
| メールの取り込みの遅れ（SES の受信から `processed` まで） | **p99 2 分**（K7） | p99 10 分、または DLQ 1 件で呼び出し | ○ |
| 通知の送信の遅れ（事象のコミットから SES の受け付け） | **p99 2 分** | 1 時間続いたらチケット | |
| Webhook の配達の遅れ（受け手の失敗を除く） | **p99 1 分** | 最古の配達が 30 分でチケット | |
| CMDB の取り込みの速さ | **1 セル 1,000 CI/秒を保てる**（NFR-005） | 夜間の取り込みが 1 時間で終わらなければチケット | |
| DR の複製の遅延（`AuroraGlobalDBRPOLag`） | **10 秒以内**（NFR-008） | 10 秒超が 5 分で呼び出し | |
| 正しさの監視（承認なしの実施、監査の鎖、重複の CI、存在しない参照、SLA の抜き取りの計算し直し） | **0 件**（K2〜K4、NFR-010） | 4 節の表 | ○ |
| 本番の漏れの合成監視 | **検出 0 件**（K6） | 1 件で呼び出し（SEV1） | ○ |

- SLO の窓は 30 日の移動の窓（SLA の報告は暦の月）。99.95% のエラーバジェットは約 21.6 分。バーンレートは observability の 7.1 節（1 時間・5 分で 14.4、6 時間・30 分で 6 を呼び出し、3 日・6 時間で 1 をチケット）。
- 対象は `environment = production` のテナントだけ。サブプロダクションのテナントは SLO の対象外で、別に見る（[ADR-0002](../decisions/0002-tenancy-and-isolation.md)）。可用性はセルごとに数え、全体の平均で薄めない。
- 「品質の判定に使う」に○がある指標は、QA が品質の判定基準に使う。定義を変えるときは QA と合意する。
- 復旧の目標：AZ の障害は RPO 0・RTO 5 分（NFR-007）、リージョンの障害は RPO 1 分・RTO 1 時間（NFR-008。S2 で RTO 15 分）。検索の全体は、リージョンの切り替えの後、索引の作り直しまで数時間使えない（`kb`・`catalog` を先に戻す）。
- アラートの値は案で、E12 の負荷試験と運用の最初の 3 か月で調整する（E12 `slo-and-alert-tuning`）。

## 2. テナント単位の上限

上限の値の正本は各領域の文書（API のレート制限は [api-and-integrations.md](../architecture/api-and-integrations.md) の 7.1 節、フローは [workflow-engine.md](../architecture/workflow-engine.md) の 8.1 節、メールの流量は [notifications-and-email-ingest.md](../architecture/notifications-and-email-ingest.md) の 6.2 節、レポートは [reports.md](../architecture/reports.md) の 4.2 節）。大口のテナントの上限の変更は、制御の面の台帳で行い、Ops が承認して監査に残す。全体を 2 倍以上にする変更は、容量（[capacity.md](../architecture/capacity.md)）を確かめてから承認する。

## 3. リリースとロールバック

流れの正本は [delivery.md](../architecture/delivery.md)、手順は [deploy-and-rollback.md](deploy-and-rollback.md)。

- **デプロイはセルを単位に段で行う**（[ADR-0063](../decisions/0063-flags-and-staged-release-per-cell.md)）：control・mail-ingress → cell-s01（カナリアのセル）→ 60 分の観察 → ほかの共有のセル（S2 からは 25% ずつ）→ 専用のセル。各段で Ops が承認する。セルの中は、メタデータのコンパイルの検査 → マイグレーション（expand）→ relay・indexer・notifier・notifier-egress・ingest → engine → app（blue/green のカナリア 10% → 100%）の順。
- **振る舞いはフラグで広げる**：社内・監視用のテナント → サブプロダクションのテナントの 100%（最低 7 日）→ cell-s01 の 10%・100% → 全共有のセルの 50%・100%（各段 24 時間以上）→ 専用のセル → 100% で 2 週間の後に古いコードとフラグを消す。
- **顧客が時期を選べる変更**：業務の画面・流れ・通知の文面が変わる変更は「選べる変更」の印を付け、本番の段に入ってから **最大 60 日**、テナントの管理者が有効にする日を選べる。60 日を過ぎると全テナントで有効にする。選べるのは時期だけで、コードの版は選べない。セキュリティと正しさの修正は選べる変更にしない（ADR-0063、[ADR-0002](../decisions/0002-tenancy-and-isolation.md)）。
- **ガード**：保存の 422・403 の率（無効な側の 2 倍、15 分）、期限を過ぎた未発火の違反（1 件）、本番の漏れの合成監視の検出（即時）、5xx（0.1%）、フォームの p99（1.5 倍、15 分）で、AppConfig のアラームがフラグを自動で切る。
- **メタデータのコンパイルの検査**が 1 件でも失敗したら、そのセルのデプロイを止める（[ADR-0064](../decisions/0064-migrations-and-metadata-compatibility-check.md)）。テナントのメタデータを手で書き換えて通さない。
- ロールバックはまずフラグで行う。次に 1 つ前のイメージ（セルごと）。マイグレーションは戻さない。誤った遷移は、修正のジョブ（Record Service を通す）で直し、DB を直接書き換えない。
- 本番へのデプロイは Ops が承認する。リリースの判断は PM（社内 → サブプロダクション → cell-s01 の 10%）、PM と Ops（cell-s01 の 100% → 全体）。権限を広げる方向の変更は PM とセキュリティの担当。

### 3.1 デプロイの時間帯と凍結

| 対象 | 時間帯 | 凍結（修正だけ） |
| --- | --- | --- |
| アプリ（全サービス） | 平日 13〜17 時 | 平日 8:30〜10:30（9 時の山）、月末の最後の 2 営業日、期末（3 月 25 日〜4 月 5 日、9 月 25 日〜10 月 5 日）、年末年始、エラーバジェットを使い切っている間、夜間の CI が 2 日続けて失敗している間（フラグの拡大も止める）、専用のセルの顧客が知らせた繁忙の時間帯 |
| Terraform（`cell/*`、`global/edge`、KMS・IAM・WAF・ルーターの関数） | 平日 10〜16 時。WAF の新しい Block は Count で 24 時間出してから | アプリと同じ |
| DR のフェイルバック（東京へ戻す switchover） | 計画作業として、業務の少ない休日 | 期末・年末年始を避ける |

- テナントの分離の破れ・ACL の漏れ・監査の改ざん・承認の偽りの修正は、時間帯の制限を受けない。2 人の承認、漏れの試験、分離の試験は省かない。カナリアのセルの観察を 15 分に縮めてよい（[delivery.md](../architecture/delivery.md) の 7 節）。
- 凍結の予定は、Ops が四半期ごとにこの表の下に書き足し、PM と合意する。

## 4. アラートと手順

「作成済み」は、その場面の専用の手順（個別の runbook か、incident-response・deploy-and-rollback・disaster-recovery の中の専用の場面）があるものだけを指す。共通の進め方だけで受けているものは「E? で作成」とし、それまでの受け皿を手順の列に書いた（2026-09-28 の統合の後の見直し）。「作成済み」以外の手順は、各 Epic の実装に合わせて [templates/runbook.md](../../../../docs/templates/runbook.md) から作る。できるまでは [incident-response.md](incident-response.md) の該当の場面で対応する（[ADR-0060](../decisions/0060-alerts-and-runbook-mapping.md)）。アラートの条件は [observability.md](../architecture/observability.md) の 7.2 節。すべてのアラートは、対応する runbook の URL を注釈に持つ（CI で検査する）。呼び出しは SLO、正しさの約束（0 件の監視）、セキュリティの症状に限る。

### 4.1 アラート → runbook

| アラート | 重さ | 手順 | 状態 | 作る Story（[roadmap.md](../roadmap.md)） |
| --- | --- | --- | --- | --- |
| 可用性の SLO の速いバーンレート（セル別）、合成監視の連続失敗 | 呼び出し | `availability-burn.md`（それまでは [incident-response.md](incident-response.md) の共通の進め方） | E1 で作成 | E1 `edge-availability-sli` |
| フォーム・リストの遅れ | チケット（1 時間で呼び出し） | `form-list-latency.md`（それまでは [incident-response.md](incident-response.md) の共通の進め方） | E2 で作成 | E2 `save-pipeline` |
| **タイマーの遅れ**（優先度 0 の p99 60 秒を 5 分、期限を 60 秒過ぎた優先度 0 のタイマー 100 件） | 呼び出し（SEV2） | [incident-response.md](incident-response.md) の「タイマーの遅れ」→ `timer-lag.md` | E4 で作成 | E4 `timer-lag-sli` |
| **期限を過ぎた未発火の違反**（1 件以上が 5 分） | 呼び出し（SEV2） | 同上 → `sla-breach-lag.md` | E5 で作成 | E5 `sla-correctness-monitors` |
| 止まった実行の回収 | SEV3（10 件/時で SEV2） | `stuck-flow-runs.md` | E4 で作成 | E4 `stuck-run-reconciler` |
| テナントのフローの暴走（トリガーの抑え・実行の数の上限） | チケット | `flow-runaway.md` | E4 で作成 | E4 `flow-limits-and-fairness` |
| **承認なしの実施の検出** | 呼び出し（SEV2） | `change-without-approval-detected.md` | E7 で作成 | E7 `change-approval-reconciliation` |
| **監査のハッシュの鎖の食い違い** | 呼び出し（SEV2） | `audit-chain-mismatch.md`（証拠の保全は [incident-response.md](incident-response.md) の「ACL の漏れの疑い」と併せて） | E2 で作成 | E2 `audit-digest-verify` |
| **本番の漏れの合成監視の検出** | 呼び出し（SEV1） | [incident-response.md](incident-response.md) の「ACL の漏れの疑い」（access-control の提案の `suspected-acl-leak.md` はここに含めた） | 作成済み | E3 `leak-synthetic-monitor` |
| テナントの分離の破れの疑い（SQS のテナントの食い違い、テナントの報告） | 呼び出し（SEV1） | [incident-response.md](incident-response.md) の「テナントの分離の破れの疑い」 | 作成済み | E1 `rls-null-rows-and-cross-tenant-roles` |
| ACL の条件の評価の失敗の急増、ACL の規則のコンパイルの失敗 | SEV3・呼び出し（SEV2） | `acl-compile-failure.md` | E3 で作成 | E3 `acl-condition-compiler` |
| ACL の変更の誤りで管理者も読めない | 報告から | `acl-lockout.md` | E3 で作成 | E3 `acl-rule-model-and-decide` |
| テナントの IdP の障害、証明書の切り替え | 報告から | `idp-outage.md`、`idp-certificate-rotation.md` | E3 で作成 | E3 `tenant-sso-saml-oidc` |
| API の秘密・トークン・Webhook の秘密の漏えい（シークレットスキャンの通知） | 呼び出し | `leaked-api-credential.md` | E3 で作成 | E3 `api-clients-and-oauth` |
| 期限を過ぎた運用者の権限、四半期のアクセスのレビュー | チケット | `operator-access-review.md` | E3 で作成 | E3 `break-glass-and-operator-jit` |
| **メールのループの疑い** | チケット（全体で 10 倍なら呼び出し） | [incident-response.md](incident-response.md) の「メールのループ」→ `mail-loop-detected.md` | E6 で作成 | E6 `mail-loop-prevention` |
| メールの取り込みの遅れ・DLQ | 呼び出し | `inbound-email-backlog.md` | E6 で作成 | E6 `inbound-email-pipeline` |
| `mail-router` の滞留、解決できない受け手の急増 | 呼び出し（1 日の中で処理できなければ SEV2） | `mail-ingress-backlog.md` | E1 で作成 | E1 `mail-ingress-router` |
| 送信の評判（バウンス・苦情の率） | 呼び出し | `sending-reputation.md` | E6 で作成 | E6 `bounce-and-suppression` |
| 文字化けの報告 | 報告から | `mojibake-report.md` | E6 で作成 | E6 `japanese-mime-decoding` |
| 社内のドメインを名乗る保留のメールの増加 | チケット | `spoofed-internal-sender.md` | E6 で作成 | E6 `inbound-reply-and-sender-trust` |
| メジャーインシデントの子への伝播の停止 | チケット | `major-incident-cascade-stuck.md` | E6 で作成 | E6 `major-incident-promotion-and-cascade` |
| **CMDB の統合の後の保留の急増** | チケット | [incident-response.md](incident-response.md) の「CMDB の誤った統合」→ `cmdb-wrong-merge.md` | E10 で作成 | E10 `ci-merge` |
| 重複の CI の検出 | チケット | `cmdb-duplicate-detected.md` | E10 で作成 | E10 `duplicate-detection-job` |
| CI の保留の急増 | チケット | `cmdb-hold-surge.md` | E10 で作成 | E10 `ci-hold-and-duplicate-tasks` |
| 取り込み元の停止で廃止の候補が増えた | チケット | `cmdb-source-outage.md` | E10 で作成 | E10 `ci-staleness` |
| 影響の範囲の走査の遅れ・打ち切り | チケット | `impact-traversal-slow.md` | E10 で作成 | E10 `impact-traversal` |
| 索引の遅れ | チケット（5 分超は呼び出し） | `search-index-lag.md` | E9 で作成 | E9 `indexer-outbox-external-version` |
| 検索のドメインの赤の状態 | 呼び出し | `opensearch-domain-degraded.md` | E9 で作成 | E9 `index-layout-and-mappings` |
| 索引の突き合わせの違い（0.1% 超） | SEV3 | `search-reconcile-mismatch.md`、作り直しは `search-index-rebuild.md` | E9 で作成 | E9 `index-reconcile-and-rebuild` |
| 誤って公開した記事、公開の承認の滞留 | 報告から・チケット | `kb-article-wrongly-published.md`、`kb-approval-backlog.md` | E9 で作成 | E9 `kb-articles-and-versions`、`kb-publish-approval` |
| 自己解決の集計のジョブの失敗 | チケット | `deflection-job-failure.md` | E9 で作成 | E9 `deflection-metrics` |
| Webhook の配達の滞留、外の宛先の停止 | チケット | `webhook-delivery-backlog.md`、`webhook-destination-down.md` | E11・E4 で作成 | E11 `webhook-subscriptions-and-delivery`、E4 `webhook-step-and-idempotency` |
| レポートの reader の飽和 | チケット | `report-reader-saturation.md` | E11 で作成 | E11 `report-definition-and-runner` |
| 定期の配信の滞留、日次の事実の表のジョブの失敗 | チケット | `scheduled-report-backlog.md`、`daily-facts-job-failure.md` | E11 で作成 | E11 `scheduled-report-delivery`、`task-daily-facts` |
| 429 の急増 | チケット | `api-rate-limit-storm.md` | E11 で作成 | E11 `tenant-rate-limits` |
| 取り込みの変換の停止・失敗 | チケット | `import-run-stuck-or-failed.md` | E11 で作成 | E11 `import-runs-and-transform-maps` |
| outbox の遅れ（最古の行が 30 秒） | 呼び出し | `outbox-lag.md`（それまでは [incident-response.md](incident-response.md) の共通の進め方） | E1 で作成 | E1 `outbox-and-relay` |
| 当番の呼び出しの未達（`page_attempt` の失敗が経路で 10%） | 呼び出し | `paging-not-delivered.md` | E5 で作成 | E5 `pager-channel-interface` |
| 呼び出しの洪水、当番の空き、未割り当ての滞留 | チケット | `paging-storm.md`、`on-call-gap.md`、`unassigned-queue-growth.md` | E5 で作成 | E5 `escalation-policies-and-paging`、`on-call-schedules`、`assignment-rules` |
| 祝日の取り込みの失敗、収録の残り 10 か月 | チケット | `holiday-import.md` | E5 で作成 | E5 `jp-holiday-import` |
| 計算し直しのジョブの停止、カレンダーの誤りで計時が始まらない | チケット | `sla-recalculation.md`、`calendar-misconfiguration.md` | E5 で作成 | E5 `sla-recalculation-job`、`calendar-model-and-versions` |
| 衝突の計算し直しの遅れ、凍結期間の登録 | チケット・定期 | `conflict-recompute-lag.md`、`freeze-window-setup.md` | E7 で作成 | E7 `change-conflict-detection`、`change-windows-and-freeze` |
| 承認の有無の問い合わせ（監査） | 報告から | `approval-dispute.md` | E4 で作成 | E4 `approvals-core` |
| 実行のフローの失敗、誤った品目の版、要求の状態の食い違い | チケット | `fulfillment-flow-failed.md`、`catalog-item-rollback.md`、`request-rollup-mismatch.md` | E8 で作成 | E8 `catalog-fulfillment-flows`、`catalog-item-versions`、`request-item-stages-and-rollup` |
| Web Push の配信の失敗 | チケット | `web-push-delivery-failure.md` | E8 で作成 | E8 `web-push-and-pwa` |
| 画面のモデルのコンパイルの失敗、静的な資産の配信の障害 | SEV3・SEV2 | `ui-model-compile-failure.md`、`static-assets-outage.md` | E2 で作成 | E2 `ui-model-api` |
| メタデータのコンパイルの検査の失敗 | デプロイの停止 | [deploy-and-rollback.md](deploy-and-rollback.md) の「検査で止まったとき」→ `metadata-compile-check-failure.md` | E2 で作成 | E2 `metadata-compile-check-task` |
| 索引を写すジョブの停止、存在しない参照、パッケージの適用の失敗、番号の定義の誤り | チケット | `extension-index-backfill.md`、`dangling-reference.md`、`package-apply-failure.md`、`number-counter-exhausted-or-reset.md` | E2 で作成 | E2 `ext-and-extension-index`、`reference-integrity`、`config-packages`、`record-numbering` |
| マルウェアの検出 | 呼び出し | `malware-detected.md` | E2 で作成 | E2 `attachment-malware-scan` |
| デプロイ中の自動のロールバック、フラグのガード | 呼び出し | [deploy-and-rollback.md](deploy-and-rollback.md) | 作成済み | E1 `cell-staged-deploy`、`appconfig-flags-per-cell-tenant` |
| ルーターの 421 の急増（テナントの移動の外） | 呼び出し | `router-mapping-mismatch.md`（それまでは [incident-response.md](incident-response.md) の共通の進め方） | E1 で作成 | E1 `edge-router-kvs` |
| AZ・リージョンの障害、`AuroraGlobalDBRPOLag` の超過、大阪の待機の構成の異常、論理的な破損、東京の SES の受信の障害（MX の切り替え。notifications の提案の `ses-inbound-failover.md` はここに含めた） | 呼び出し（大阪の待機の構成の異常はチケット、30 分続いたら呼び出し） | [disaster-recovery.md](disaster-recovery.md) | 作成済み | E12 `dr-failover-drill` |
| テナントのセル間の移動 | 計画作業 | `tenant-cell-move.md` | E12 で作成 | E12 `tenant-cell-move-drill` |
| テナントの削除の停止 | チケット | `tenant-deletion.md` | E12 で作成 | E12 `tenant-deletion-job` |
| 秘密・個人データの形のログの検出、重要なセキュリティの仕組みの停止 | 呼び出し（SEV2） | `sensitive-data-in-logs.md`、`security-control-disabled.md`（それまでは [incident-response.md](incident-response.md) の共通の進め方と「ACL の漏れの疑い」の証拠の保全） | E1 で作成 | E1 `telemetry-package` |
| 週次のキャパシティの見直し | 定期 | `capacity-review.md` | E12 で作成 | E12 `slo-and-alert-tuning` |

## 5. 定期作業と訓練

| 作業 | 頻度 | 手順 |
| --- | --- | --- |
| 計画外のフェイルオーバーと失った範囲の取り込み直し（staging） | 四半期 | [disaster-recovery.md](disaster-recovery.md) の E（合格基準は [quality.md](../quality.md) の 2.4 節） |
| 本番の switchover（1 つのセル。東京 → 大阪 → 東京） | 年 1 回 | [disaster-recovery.md](disaster-recovery.md) の E |
| AZ の障害（9 時の山の負荷の中、staging） | 四半期 | [disaster-recovery.md](disaster-recovery.md) の E |
| PITR からの隔離した復元（staging） | 四半期 | [disaster-recovery.md](disaster-recovery.md) の D |
| 大阪での索引の作り直しの時間 | 四半期（DR の訓練と一緒に） | [search.md](../architecture/search.md) の 9 節 |
| セルの間のテナントの移動 | E12 の前、その後は年 1 回（staging） | `tenant-cell-move.md`（[infrastructure.md](../architecture/infrastructure.md) の 4.2 節） |
| 大阪の待機の構成の確認 | 合成監視は 1 分、plan の差分・KMS のレプリカは日次、クォータは月次 | [infrastructure.md](../architecture/infrastructure.md) の 6.5 節 |
| Aurora の実際のフェイルオーバー（staging） | 週 1 回 | [delivery.md](../architecture/delivery.md) の 2.3 節 |
| 負荷試験（`timer-burst-load-test` ほか。大きな変更の後も） | 半年ごと、リリース前 | [capacity.md](../architecture/capacity.md) の 5 節 |
| キャパシティの見直し（writer の CPU、9 時の山の遅れ、テナントの占有） | 週次 | `capacity-review.md`（[capacity.md](../architecture/capacity.md) の 6 節） |
| 国民の祝日の取り込みの承認 | 取り込みの草案ができたとき（2 月は毎週の取得） | `holiday-import.md`（[ADR-0020](../decisions/0020-japanese-holiday-data.md)） |
| 年末年始・期末の凍結期間の登録 | 四半期 | `freeze-window-setup.md` |
| 正しさの監視・監査のハッシュの鎖の検証 | 毎分・日次（自動） | [observability.md](../architecture/observability.md) の 5 節 |
| 本番の漏れの合成監視 | 5 分（自動） | 同上 |
| ログの走査の健全さ（合成の値） | 日次 | [observability.md](../architecture/observability.md) の 8 節 |
| 運用者のアクセスのレビュー | 四半期（期限の確認は週次） | `operator-access-review.md` |
| 合成監視の資格情報、CloudFront → ALB の秘密のヘッダーのローテーション | 90 日 | [security.md](../architecture/security.md) の 7 節 |
| インシデント対応の机上訓練（ACL の漏れ、メールのループを想定） | 年 1 回 | [incident-response.md](incident-response.md) |
| 外部のペンテスト | E12 と、その後は年 1 回と大きな変更の後 | [security.md](../architecture/security.md) の 11 節 |
| アラートの鳴った回数と、対応の要らなかった割合の見直し | 四半期 | [ADR-0060](../decisions/0060-alerts-and-runbook-mapping.md) |
| 訓練の記録の見直し（目標の未達を Intent へ） | 四半期 | 各 runbook の「訓練の記録」 |

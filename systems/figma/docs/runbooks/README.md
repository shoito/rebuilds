# Runbooks: Figma

Ops が持つ運用の文書。品質の判定基準は [quality.md](../quality.md) の 4 節、SLI の計測の仕組みとアラートの条件の実装は [observability.md](../architecture/observability.md) の 5・6 節にある。**SLO の値とアラートの一覧の正本はこの文書** で、observability.md と [ADR-0050](../decisions/0050-editing-slis-and-slos.md) は、これを計測・実装する側の記述である。値を変えるときは、この文書を先に変え、observability.md を合わせる。

## 1. SLI と SLO

| SLI | 良いイベント（数える場所） | SLO（月間、S1） | 許容範囲を外れたときの扱い | 品質の判定に使う |
| --- | --- | --- | --- | --- |
| `edit_open` | 有効なチケットの `Hello` から `Welcome` まで 10 秒以内（Gateway） | **99.95%**（NFR-008） | 1 時間のバーンレート 14.4 倍で呼び出し、6 時間で 6 倍でチケット。エラーバジェットを使い切ったら、修正以外のデプロイを止める | |
| `edit_commit` | 検証を通った `ChangeSet` に 2 秒以内に `Ack`（Document Server） | **99.95%**（NFR-008） | 同上 | |
| `edit_propagation` | 合成のボットの組で、送ってから相手が受け取るまで 250 ms 以内（東京の 3 AZ） | **99%**（NFR-001 の p99） | p99 が 250 ms を 15 分超えたら呼び出し | ○ |
| `owner_recovery` | 持ち主の生存が切れてから、新しい持ち主が受け付けを始めるまで 15 秒以内（Router と Document Server の記録） | **95%**（NFR-007 の p95） | p95 が 15 秒を 10 分超えたら呼び出し | ○ |
| `metadata_api` | ALB と API の 5xx でない応答 | **99.9%**（NFR-008） | バーンレートで呼び出し（編集と別に数える） | |
| `realtime_delivery` | コミットから購読者への送信まで 1 秒以内（Realtime の edge） | **99%** | p99 が 1 秒を 15 分超えたらチケット | ○ |
| `journal_replication` | `ReplicationLatency`（東京 → 大阪）が 30 秒以内の時間の割合 | **99.9%**（NFR-009） | 10 秒超で警告、30 秒超で呼び出し | |
| 公開 API の可用性（E15） | `api.<domain>` の 5xx でない応答 | 99.9% | バーンレートでチケット | |

- **数えないもの**：クライアントの側の理由の失敗（チケットの期限切れ、`forbidden`、`Reject` の検証の失敗、`version_mismatch`）。持ち主が変わる間の確定の失敗は `edit_commit` に数えず、`owner_recovery` で数える（二重に数えない。ADR-0050）。`Reject` と `version_mismatch` の率は別に見て、急増は警告にする。
- **編集の可用性**は、`edit_open` と `edit_commit` の悪いイベントの率の大きい方で報告する。
- 合成のボットの組織は、SLO の計算から除く。
- SLO の窓は 30 日の移動の窓（報告は暦の月）。エラーバジェットの方針は Slack と同じ（使い切ったら信頼性の作業を機能より先にする。デプロイの前に残りを確かめる）。
- クライアントの計測（フレーム時間、開く時間、メモリ、異常終了）は SLO にしない。QA が品質の判定に使う（[quality.md](../quality.md) の 4.1 節）。
- 「品質の判定に使う」に○がある指標は、QA が品質の判定基準に使う。定義を変えるときは QA と合意する。
- 復旧の目標：AZ の障害は確定の損失 0（NFR-006）・`owner_recovery` の p95 15 秒（NFR-007）。リージョンの障害は RPO 1 分・RTO 1 時間（NFR-009）。

## 2. 上限と容量のパラメーター

値の正本は各文書にある。Ops が運用で変えてよいのは、下の「運用で変えるもの」だけで、変えたら記録を残す。

| 対象 | 値 | 正本 | 運用で変えるもの |
| --- | --- | --- | --- |
| 1 ファイルの参加 | 500 人（編集 200 人、編集の権限の枠 20 人） | [multiplayer.md](../architecture/multiplayer.md) の 4.6 節（ADR-0011） | — |
| 1 セッションの送信 | 毎秒 60 `ChangeSet`・4 MiB | 同上 | — |
| 1 ファイルの書き込みの予算 | 毎秒 400 単位、段 50%・80%・100% | [capacity.md](../architecture/capacity.md) の 10 節（ADR-0052） | 人が集まるファイルのまとめの間隔（`document-server-hot-file.md`） |
| Document Server の受け入れ | タスクのメモリの 75%、新規を止める 80%、渡し 85%、`ds-large` は 1.5 GiB 超 | capacity.md の 10 節（ADR-0051） | タスクの数 |
| Gateway | 1 タスク 1 万接続、`Kick(server_shutdown)` の散らし 0〜60 秒 | capacity.md の 2 節 | タスクの数、`retry_after_ms` の引き上げ（`multiplayer-reconnect-storm.md`） |
| 生存の期限・延長・猶予 | 10 秒・2 秒・2 秒 | [ADR-0047](../decisions/0047-router-task-liveness-and-file-assignment.md) | — |
| 回復のジョブ | 1 秒に 50 ファイル | [infrastructure.md](../architecture/infrastructure.md) の 5.3 節 | 引き上げ（DR の B） |
| ファイル・ノードの上限 | 1 ファイル 100 万ノード、1 ページ 30 万 | [document-model.md](../architecture/document-model.md) の 11 節 | — |

## 3. リリースとロールバック

流れの正本は [delivery.md](../architecture/delivery.md)、手順は [deploy-and-rollback.md](deploy-and-rollback.md)。

- **デプロイとリリースを分ける。** デプロイは Ops が承認し、リリース（フラグを広げる）は PM が判断する。すべての新しい振る舞いは release フラグの裏に置く。
- **フラグは 2 種類**（[ADR-0055](../decisions/0055-staged-rollout-and-schema-changes.md)）：UI のフラグ（`release.ui.*`。利用者の組織で割り当てる）と、文書のフラグ（`release.doc.*`。ファイルと、ファイルを持つ組織で Document Server が決めて `Welcome.features` で配る）。変更の適用・レイアウト・描画の結果を変えるものは、必ず文書のフラグにする。
- **デプロイの順**：マイグレーション（expand）→ Worker・Render Worker・file-read → Document Server（ドレインの波。10% ずつ）→ router → gateway（1 回に 10%）→ api・realtime（blue/green のカナリア 10% → 100%）→ クライアントのビルド（段階的）→ 書き込みの解禁のフラグ。サーバーを先に、クライアントを後に出す。
- **クライアントのビルド**：社内の組織 → 1% → 10% → 50% → 100%。各段で 24 時間、前のビルドと比べ、panic の率が 2 倍未満、フレーム時間の p95 の悪化が 10% 未満、メモリの警告の率の増加が 20% 未満なら次へ進む。同時に配るビルドは 2 つまで。
- **プロパティの表の変更**：サーバー → クライアントのビルド → 接続の 95% が新しい `schema_hash` になってから `schema.<prop>.write`。書き込みの解禁は戻せないので、PM の判断を記録する。`schema-breaking` と `protocol_version` の打ち切りは、ADR と Dev のテックリードの承認を要する計画作業にする。
- **ロールバック**：まずフラグで戻す（文書のフラグは開いているファイルを `Kick(resync_required)`）。次に 1 つ前のイメージ（Document Server は同じドレインの波）。新しい `protocol_version` のクライアントが配信されていれば、先にクライアントの配信を戻す。クライアントのビルドは配信の割合を 0 にし、要れば `min_client_build` を上げる。マイグレーションは戻さない。
- 本番へのデプロイは Ops が承認する（作成者と別の人）。

### 3.1 デプロイの時間帯と凍結

| 対象 | 時間帯 | 凍結（修正だけ） |
| --- | --- | --- |
| サーバー（api、realtime、workers、render-worker、router、gateway、Document Server） | 平日 10〜17 時 | 金曜 15 時以降、日本の祝日の前日、年末年始、大きな利用者の催しの日、エラーバジェットを使い切っている間、夜間の CI（`parity`・シミュレーター・参照画像）が 2 日続けて失敗している間 |
| クライアントのビルドの段を進める | 平日 10〜15 時（24 時間の観察を平日に置く） | 同上 |
| 書き込みの解禁（`schema.<prop>.write`） | 平日 10〜15 時 | 同上 |
| 互換を切る変更（`schema-breaking`、`protocol_version` の打ち切り、`min_client_build` の引き上げ） | 計画作業として平日 19 時以降 | 同上 |
| Terraform（`network`・`data`） | 平日 10〜16 時。Ops の承認 | 同上 |
| DR の戻し（大阪 → 東京） | 計画作業として | 大きな催しの日を避ける |

- 脆弱性の修正（重大）は時間帯の制限を受けない。レビューと必須の CI（`parity` を含む）は省かない。
- 凍結の予定は、Ops が四半期ごとにこの表の下に書き足し、PM と合意する。

## 4. アラートと手順

「作成済み」以外の手順は、各 Epic の実装に合わせて [templates/runbook.md](../../../../docs/templates/runbook.md) から作る。「作る Story」の列は、そのアラートの計測と手順を作る [roadmap.md](../roadmap.md) の Story である。手順の文書は、その Story の完了の条件に含める（E12 の分は `runbooks-e12` でもまとめて確かめる）。作るまでは [incident-response.md](incident-response.md) の該当の節で対応する。アラートの条件の実装は [observability.md](../architecture/observability.md) の 6 節。すべてのアラートは、対応する runbook の URL を注釈に持つ（CI で検査する）。呼び出し（page）は、利用者に影響が出ているか、放っておくとデータを失うものだけにする。

| アラート（重さ） | 手順 | 状態 | 作る Story |
| --- | --- | --- | --- |
| 編集の SLO の速いバーンレート（page）・遅いバーンレート（ticket）、反映の遅延（page）、持ち主の回復の遅れ（page） | [incident-response.md](incident-response.md) | 作成済み | `mp-metrics-and-slis`、`synthetic-bots` |
| 二重の持ち主（`ds_fence_lost_total` が 5 分で 10 超、デプロイの外。page） | [incident-response.md](incident-response.md) の「二重の持ち主」 | 作成済み | `mp-metrics-and-slis`、`durability-fault-injection` |
| 人が集まるファイル（予算の段 100% が 5 分、1 タスクの CPU 80%。ticket） | [incident-response.md](incident-response.md) の「人が集まるファイル」 | 作成済み | `hot-files-log`、`journal-write-budget` |
| 再接続の殺到（`gw_reconnect_total` が平常の 10 倍、API の 429 が 1 分。page） | [incident-response.md](incident-response.md) の「再接続の殺到」 | 作成済み | `reconnect-resume`、`gateway-resume-token` |
| ジャーナルの飛び（page）、作り直しの検証の不一致（page） | [incident-response.md](incident-response.md) の「ジャーナルの飛び」「ファイルの状態の食い違い」、`journal-gap-or-corruption.md` | 作成済み（個別の手順は E7 で作成） | `journal-fencing-recovery`、`shadow-replay-validation` |
| 漏洩の疑い（監査の不一致、通報） | [incident-response.md](incident-response.md) の「テナントの分離の破れ」、`tenant-isolation-breach.md` | 作成済み（個別の手順は E9 で作成） | `leak-test-suite`、`audit-events-core` |
| デプロイの後の悪化、api の blue/green の自動の戻し、ドレインの停滞（`router_drain_remaining_files` が 30 分減らない。ticket）、新しいビルドの異常終了の急増 | [deploy-and-rollback.md](deploy-and-rollback.md) | 作成済み | `ds-drain-deploy`、`client-build-channels` |
| 大阪への複製の遅れ（10 秒で警告、30 秒・S3 の RTC の 15 分超で page）、大阪からの合成の監視の連続の失敗（page）、AZ の障害 | [disaster-recovery.md](disaster-recovery.md) | 作成済み | `osaka-warm-standby`、`synthetic-bots`、`dr-drill` |
| Document Server のメモリ（`ds_memory_budget_ratio` 85% が 10 分。ticket） | `ds-memory-pressure.md`（capacity.md の 13 節） | E3 で作成 | `ds-memory-accounting`、`ds-admission-and-shedding` |
| ジャーナルの遅延・スロットリング（書き込みの p99 100 ms が 10 分、`ThrottledRequests` > 0。page） | `journal-throttling.md`（file-storage-and-history.md の 17 節） | E3 で作成 | `dynamodb-warm-throughput`、`journal-write-budget` |
| 1 ファイルへの集中の調べ方と、まとめの間隔の変更、大きいタスクへの移し | `document-server-hot-file.md`（multiplayer.md の 18 節） | E3 で作成 | `hot-files-log` |
| 再接続の集中での `retry_after_ms` の引き上げ | `multiplayer-reconnect-storm.md`（multiplayer.md の 18 節） | E3 で作成 | `reconnect-resume` |
| ドレインが進まない（手でファイルを渡す） | `ds-drain-stuck.md`（infrastructure.md の 14 節） | E3 で作成 | `ds-drain-controller` |
| router の停止（新しく開けない） | `router-down.md`（infrastructure.md の 14 節） | E3 で作成 | `router-assignment` |
| Fargate の退役の通知（定期の作業） | `fargate-retirement.md`（infrastructure.md の 14 節） | E3 で作成 | `ds-drain-controller` |
| プロパティの表の変更の出し方と戻し方 | `schema-rollout.md`（document-model.md の 17 節、delivery.md の 6.3 節） | E3 で作成 | `schema-write-gate` |
| `min_client_build` を上げる強い再読み込み | `forced-reload.md`（delivery.md の 11 節） | E3 で作成 | `protocol-and-schema-compat` |
| 不変条件の破れ（サーバーの抜き取り。ticket） | `document-invariant-violation.md`（document-model.md の 17 節） | E3 で作成 | `tree-invariants` |
| 能力のチケットの署名の鍵と、再開のトークンの鍵の入れ替え（定期と漏洩のとき） | `ticket-signing-key-rotation.md`（security.md の 14 節） | E3 で作成 | `capability-tickets`、`gateway-resume-token` |
| 受け口の停止（計測の欠け） | `telemetry-ingest-down.md`（observability.md の 10 節） | E2 で作成 | `telemetry-ingest` |
| GPU の切り替えの急増（特定の GPU。ticket） | `gpu-blocklist.md`（rendering-engine.md の 19 節） | E2 で作成 | `gpu-backend-selection`、`render-telemetry-and-blocklist` |
| ブラウザの新しい版での描画の崩れ | `browser-render-regression.md`（rendering-engine.md の 19 節） | E2 で作成 | `golden-image-harness` |
| 特定のファイルでタブが落ちる問い合わせ | `file-crashes-tab.md`（rendering-engine.md の 19 節） | E2 で作成 | `render-memory-budget` |
| クライアントの異常終了の急増（新しいビルドで 2 倍。ticket） | `engine-panic-spike.md`（editor-and-tools.md の 20 節）、[deploy-and-rollback.md](deploy-and-rollback.md) | E2 で作成 | `wasm-error-reports` |
| IME の不具合の報告、イベントの順序の食い違いの急増 | `ime-regression.md`（editor-and-tools.md の 20 節） | E4 で作成 | `text-editing`、`editor-telemetry` |
| レイアウトの食い違い（`layout_divergence` ≥ 1。ticket） | `layout-divergence.md`（layout.md の 17 節） | E5 で作成 | `layout-repair`、`layout-telemetry` |
| レイアウト・整形の部品の版の上げ | `layout-engine-upgrade.md`（layout.md の 17 節） | E5 で作成 | `taffy-differential-test` |
| 「見つからないコンポーネント」の問い合わせ、導出の上限に達したファイル | `missing-component-and-materialize-limit.md`（components-and-libraries.md の 12 節） | E6 で作成 | `incremental-materialize` |
| 手放さずに残るファイル（1 日超。ticket） | `orphaned-file-recovery.md`（file-storage-and-history.md の 17 節） | E7 で作成 | `orphan-recovery-job` |
| チェックポイントの停滞（30 分。ticket） | `checkpoint-stalled.md`（同上） | E7 で作成 | `checkpoint-writer` |
| ジャーナルの飛び・チャンクの破損の直し方（PITR と日ごとのチェックポイント） | `journal-gap-or-corruption.md`（同上） | E7 で作成 | `journal-fencing-recovery` |
| 完全な削除の依頼と、バックアップに残る期間の説明 | `file-purge-request.md`（同上。法務の L4 の後） | E7 で作成 | `trash-and-purge` |
| サポートによる版の復元・複製 | `version-restore-support.md`（同上） | E7 で作成 | `version-restore` |
| 通知・メールが届かない | `notification-delivery.md`（comments-and-notifications.md の 11 節） | E8 で作成 | `email-notifications`、`in-app-notifications` |
| Realtime・通知の遅れ（p99 1 秒を 15 分。ticket）、edge の再起動と再接続の集中、トリガーの負荷 | `realtime-degraded.md`（同上） | E8 で作成 | `realtime-skeleton`、`in-app-notifications` |
| 権限の取り消しの遅れ（p99 10 秒超。ticket）、「共有を外したのに見えている」 | `acl-revocation-lag.md`（multiplayer.md の 18 節、permissions-and-sharing.md の 16 節） | E9 で作成 | `acl-version-and-revalidation`、`acl-change-kick` |
| リンクの期限のスケジューラーの遅れ | `link-expiry-lag.md`（permissions-and-sharing.md の 16 節） | E9 で作成 | `link-expiration` |
| 組織をまたぐ漏洩の疑いの範囲の調べ方と報告の判断 | `tenant-isolation-breach.md`（security.md の 14 節。報告は法務の L5） | E9 で作成 | `leak-test-suite`、`audit-events-core` |
| アカウントの乗っ取りの疑い | `session-compromise.md`（security.md の 14 節） | E9 で作成 | `session-revocation-kick` |
| Render Worker の滞留（`render-export` の最古 5 分、`render-thumbnail` 30 分。ticket） | `render-worker-backlog.md`（export-and-assets.md の 16 節） | E10 で作成 | `render-worker-core` |
| CloudFront の障害（S3 の署名付き GET への切り替え） | `cdn-fallback.md`（同上） | E10 で作成 | `assets-bucket-and-cdn`、`files-bucket` |
| 画像の `rejected` の急増 | `image-rejected-spike.md`（同上） | E10 で作成 | `image-ingest-worker` |
| 検索が遅い、あるはずのファイルが出ない | `search-troubleshooting.md`（search.md の 10 節） | E11 で作成 | `name-search`、`search-perf-baseline` |
| 権利の侵害の申し立て、フィッシングの取り下げ、濫用のコメント | `abuse-takedown.md`（security.md の 14 節、export-and-assets.md の `asset-takedown.md` を含む。法務の L2・L3 の後） | E12 で作成 | `abuse-takedown-console`、`asset-takedown` |
| ライブラリの公開の job の失敗 | `library-publish-failure.md`（components-and-libraries.md の 12 節） | E13 で作成 | `library-publish` |
| 悪意のあるプラグインの停止 | `plugin-kill-switch.md`（plugins.md の 16 節） | E14 で作成 | `plugin-kill-switch` |
| QuickJS・membrane の脆弱性 | `plugin-sandbox-vulnerability.md`（同上） | E14 で作成 | `plugin-membrane` |
| 審査の滞留 | `plugin-review-queue.md`（同上） | E14 で作成 | `plugin-public-review` |
| トークンの漏れ（シークレットスキャンの通報） | `api-token-leak.md`（api-and-webhooks.md の 14 節） | E15 で作成 | `personal-access-tokens` |
| 公開 API だけを止める | `public-api-kill-switch.md`（同上） | E15 で作成 | `public-api-service` |
| Webhook の配送の滞留 | `webhook-backlog.md`（同上） | E15 で作成 | `webhooks-v1` |
| 悪意のある OAuth のアプリ | `oauth-app-suspend.md`（同上） | E15 で作成 | `oauth-app-review` |

### 4.1 領域との対応

| 領域 | アラート・手順 |
| --- | --- |
| [document-model.md](../architecture/document-model.md) | `document-invariant-violation.md`、`schema-rollout.md` |
| [multiplayer.md](../architecture/multiplayer.md) | 編集の SLO、`document-server-hot-file.md`、`multiplayer-reconnect-storm.md`、`acl-revocation-lag.md`、[incident-response.md](incident-response.md) の「二重の持ち主」 |
| [rendering-engine.md](../architecture/rendering-engine.md) | `gpu-blocklist.md`、`browser-render-regression.md`、`file-crashes-tab.md` |
| [editor-and-tools.md](../architecture/editor-and-tools.md) | `ime-regression.md`、`engine-panic-spike.md` |
| [layout.md](../architecture/layout.md) | `layout-divergence.md`、`layout-engine-upgrade.md` |
| [components-and-libraries.md](../architecture/components-and-libraries.md) | `missing-component-and-materialize-limit.md`、`library-publish-failure.md` |
| [file-storage-and-history.md](../architecture/file-storage-and-history.md) | `journal-throttling.md`、`journal-gap-or-corruption.md`、`orphaned-file-recovery.md`、`checkpoint-stalled.md`、`file-purge-request.md`、`version-restore-support.md` |
| [comments-and-notifications.md](../architecture/comments-and-notifications.md) | `notification-delivery.md`、`realtime-degraded.md` |
| [permissions-and-sharing.md](../architecture/permissions-and-sharing.md) | `acl-revocation-lag.md`、`link-expiry-lag.md`、`tenant-isolation-breach.md` |
| [search.md](../architecture/search.md) | `search-troubleshooting.md` |
| [export-and-assets.md](../architecture/export-and-assets.md) | `render-worker-backlog.md`、`cdn-fallback.md`、`image-rejected-spike.md`、`abuse-takedown.md` |
| [plugins.md](../architecture/plugins.md) | `plugin-kill-switch.md`、`plugin-sandbox-vulnerability.md`、`plugin-review-queue.md` |
| [api-and-webhooks.md](../architecture/api-and-webhooks.md) | `api-token-leak.md`、`public-api-kill-switch.md`、`webhook-backlog.md`、`oauth-app-suspend.md` |
| [security.md](../architecture/security.md) | [incident-response.md](incident-response.md)、`session-compromise.md`、`ticket-signing-key-rotation.md`、`tenant-isolation-breach.md`、`abuse-takedown.md` |
| [infrastructure.md](../architecture/infrastructure.md)、[capacity.md](../architecture/capacity.md) | [disaster-recovery.md](disaster-recovery.md)、`ds-drain-stuck.md`、`router-down.md`、`fargate-retirement.md`、`ds-memory-pressure.md` |
| [delivery.md](../architecture/delivery.md) | [deploy-and-rollback.md](deploy-and-rollback.md)、`forced-reload.md`、`schema-rollout.md` |
| [observability.md](../architecture/observability.md) | アラートの条件の実装側（6 節）、`telemetry-ingest-down.md` |
| [data-model.md](../architecture/data-model.md) | データモデルの正本。運用の対象は各領域の文書で扱う |

## 5. 定期作業と訓練

| 作業 | 頻度 | 手順 |
| --- | --- | --- |
| 計画外の切り替えの訓練（staging。`mp-loadbot` の負荷、FIS で複製を止めて 30 秒後に切り替え、取り戻し、戻し） | 四半期 | [disaster-recovery.md](disaster-recovery.md) の F（合格基準は [quality.md](../quality.md) の 2.4 節） |
| 計画的な切り替え（本番。大阪で 1 日運用して戻す） | 年 1 回 | [disaster-recovery.md](disaster-recovery.md) の E・F |
| AZ の障害の訓練（staging。FIS で 1 AZ を切り離す） | 半年 | [disaster-recovery.md](disaster-recovery.md) の F |
| ジャーナルの PITR からの項目の戻し（staging） | 四半期 | [incident-response.md](incident-response.md) の「ジャーナルの飛び」、`journal-gap-or-corruption.md`（E7） |
| KMS のレプリカでの読み取り（staging） | 年 1 回 | [ADR-0044](../decisions/0044-encryption-keys-and-client-cache.md) の Confirmation |
| 大阪の待機の構成の確認（合成の監視は 1 分ごと、Terraform の差分と `ReplicationLatency` は日次） | 月次 | [disaster-recovery.md](disaster-recovery.md)、[infrastructure.md](../architecture/infrastructure.md) の 7.2 節 |
| 手放さずに残るファイルの見張り（`router_orphan_oldest_seconds`） | 日次（自動） | `orphaned-file-recovery.md`（E7） |
| 負荷試験（L1〜L10。大きな催しの前は L1 の 2 倍を 1 時間） | 半年ごと、リリース前、大きな変更の後 | [capacity.md](../architecture/capacity.md) の 9 節 |
| キャパシティの見直し（接続、開いたファイル、Document Server のメモリ、`journal` の書き込みの単位、段階の移行の目安） | 月次（予測は四半期） | [capacity.md](../architecture/capacity.md)、[infrastructure.md](../architecture/infrastructure.md) の 9 節 |
| 費用の見直し（タグごと） | 月次 | [infrastructure.md](../architecture/infrastructure.md) の 11 節 |
| 能力のチケットの署名の鍵と、再開のトークンの鍵の入れ替え | 90 日 | `ticket-signing-key-rotation.md`（E3） |
| Fargate の退役の通知への対応（待つ期間 14 日の平日の昼にドレイン） | 通知のたび | `fargate-retirement.md`（E3） |
| GPU のブロックリストの見直し（7 日で 1%・100 セッション以上の組） | 週次 | `gpu-blocklist.md`（E2） |
| クライアントのビルドの段の判定 | 段ごと（24 時間） | [deploy-and-rollback.md](deploy-and-rollback.md) |
| IME の組み合わせの確認（15 組） | ブラウザ・OS の大きな版の更新のたび（QA が実行） | [quality.md](../quality.md) の 2.2.1 節 |
| 作り直しの影の検証・一致の抜き取りの結果の確認 | 日次 | [quality.md](../quality.md) の 4.2 節 |
| 漏洩の監査 | 週次 | [quality.md](../quality.md) の 4.2 節 |
| 外部の侵入試験 | GA の前（E12）、以後年 1 回、プラグインの公開の前 | [security.md](../architecture/security.md) の 11 節 |
| DAST（staging） | 週次 | 同上 |
| インシデント対応の机上訓練（組織をまたぐ漏洩、ジャーナルの飛びを想定） | 年 1 回 | [incident-response.md](incident-response.md) |
| 訓練の記録の見直し（目標の未達を Intent へ。RTO の内訳を infrastructure.md に反映する提案） | 四半期 | 各 runbook の「事後」 |

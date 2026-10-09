# Runbooks: Dropbox

Ops が持つ運用の文書。品質の判定基準は [quality.md](../quality.md) の 4 節にある。SLI の計測とアラートの条件の実装は [observability.md](../architecture/observability.md) にある。**SLO の値とアラートの一覧の正本はこの文書** で、値を変えるときは、この文書を先に変える。

## 1. SLI と SLO

| SLI | 良いイベント（数える場所） | SLO（S1） | 許容範囲を外れたときの扱い | 品質の判定に使う |
| --- | --- | --- | --- | --- |
| メタデータと同期の可用性 | API の要求（木の読み出し、commit、`list/continue`）のうち、5xx・時間切れでないもの（エッジ、API） | **月間 99.9%**（NFR-006） | 1 時間のバーンレート 14.4 倍・6 時間で 6 倍で呼び出し、3 日で 1 倍でチケット。エラーバジェットを使い切ったら、修正以外のデプロイを止める | |
| ダウンロードの可用性 | ブロックの配信の要求のうち、5xx・時間切れでないもの（CloudFront） | **月間 99.9%**（NFR-006） | 同上（別に数える） | |
| アップロードの可用性 | `incoming` への PUT と `block-verifier` の確かめのうち、成功したもの（チェックサムの不一致を除く） | **月間 99.9%** | 同上 | |
| 共有リンクの可用性 | 共有リンクの表示とダウンロードのうち、5xx・時間切れでないもの | **月間 99.9%**（NFR-006） | 同上（別に数える） | |
| commit の速さ | 操作 100 件までの commit が 500ms 以内 | **p99 500ms**（NFR-001） | p99 が 2 秒を 10 分超えたら呼び出し | |
| 読み出しの速さ | 1 フォルダー 1,000 件までの読み出しが 300ms 以内 | **p99 300ms**（NFR-001） | 1 日続けて超えたらチケット | |
| 伝播 | 確定から、合成監視の他の端末が変更を受けるまで（正本）。サーバーの時計で測る受け渡しの遅れ（`delivery_samples`）を並べて見る | **p99 5 秒**（NFR-002） | p99 が 30 秒を 10 分超えたら呼び出し | ○ |
| 小さなファイルの届き | 1 MiB 以下のファイルの確定から、他の端末で開けるまで（合成監視） | **p95 10 秒**（NFR-002、K3） | p95 が 60 秒を 10 分超えたら呼び出し | ○ |
| 中身の耐久性 | ブロックの参照の監査（参照のあるブロックが索引にない・S3 にない） | **0**（NFR-005、K2） | 1 件で呼び出し（SEV1 の候補）。GC を `ops.block_gc_enabled` で止める | ○ |
| チェックサムの照合 | 抜き取りの照合の不一致 | **0** | 1 件で呼び出し（SEV2 から） | ○ |
| ジャーナルの連続 | 名前空間ごとの番号の欠け | **0**（NFR-010） | 1 件でチケット、10 件で呼び出し | ○ |
| 差分の取得 | 変更 2,000 件以下の `list/continue` が 1 秒以内 | **p99 1 秒**（NFR-010） | 1 日続けて超えたらチケット | |
| 権限の分離 | 応答の監査の不一致 | **0**（NFR-007、K7） | 1 件で呼び出し（SEV1 の候補） | ○ |
| 端末の健全さ | 同期が 1 時間を超えて止まっていない端末の割合（匿名の計測） | **99.5%** | 1 日で外れたらチケット。クライアントのリリースの直後なら段階の配布を止める | ○ |
| 復元 | 10 万ファイルのフォルダーの復元が 10 分以内、巻き戻しの開始から完了まで | **NFR-009 の値** | 超えたらチケット | ○ |
| プレビュー | サムネイルの最初の生成が 2 秒以内、キャッシュから 200ms 以内 | **p95 2 秒・p95 200ms**（NFR-011） | 1 日続けて超えたらチケット | |
| 検索 | 名前の検索の応答、変更から名前の索引まで、本文の索引まで | **p99 1 秒、p95 60 秒、p95 15 分**（NFR-011） | 名前の索引の遅れの p95 が 10 分を超えたらチケット | ○ |
| Webhook | 変更から最初の送信まで | **p95 30 秒**（NFR-012） | p95 が 5 分を超えたらチケット | |

- SLO の窓は 30 日の移動の窓（報告は暦の月）。エラーバジェットを使い切ったら、信頼性の作業を機能より先にする。デプロイの前に残りを確かめる。
- **数えないもの**：検証の拒否（4xx）、条件の不一致（409。同期の正常な振る舞い）。ただし 409 と 4xx の率の急な上がりは、クライアントとの食い違いの兆候として見る。社内の監視用のチームは SLO の計算から除き、別に見る。
- 「品質の判定に使う」に○がある指標は、QA が品質の判定基準に使う（[quality.md](../quality.md) の 4.1 節）。定義を変えるときは QA と合意する。
- 復旧の目標：AZ の障害は RPO 0・RTO 5 分。リージョンの障害は、メタデータ RPO 1 分・RTO 1 時間、中身 RPO 15 分（NFR-005）。
- 本家のサービスの SLA は、公式の資料で確かめなかった（**未検証**）。本システムの SLO は他の題材と同じ水準にする。

## 2. 上限と容量のパラメーター

値の正本は、各 ADR と領域の文書にある。Ops が運用で変えてよいのは、下の「運用で変えるもの」だけで、変えたら記録を残す。

| 対象 | 値 | 正本 | 運用で変えるもの |
| --- | --- | --- | --- |
| ファイルの大きさ | 最大 2 TiB | [ADR-0002](../decisions/0002-chunking-and-block-addressing.md) | — |
| ブロックの大きさ | 最小 1 MiB・平均 4 MiB・最大 16 MiB（`chunker_version` 1） | 同上 | — |
| 名前 | NFC で 255 バイト、深さ 256 段 | [ADR-0008](../decisions/0008-node-identity-and-names.md) | — |
| 1 回の commit | 1 名前空間、操作 1,000 件まで | [ADR-0005](../decisions/0005-namespace-journal-and-cursors.md) | — |
| 1 名前空間の書き込み | 1 秒 200 件（見込み。E3 の PoC で確かめる）。超えたら 429 | 同上 | `ops.ns_commit_rate_limit`（下げるだけ） |
| ジャーナルの保持、カーソルの有効の期間 | 分割 92 日、カーソルは最後の利用から 90 日（法務の L6 の後に確定） | [ADR-0005](../decisions/0005-namespace-journal-and-cursors.md)、[ADR-0023](../decisions/0023-tree-listing-snapshot-and-journal-retention.md) | — |
| 1 回の commit のブロックの一覧 | 1,024 ブロック（超えたらアップロードのセッション） | [ADR-0018](../decisions/0018-upload-sessions-and-block-grants.md) | — |
| 署名つき URL の期限 | PUT 15 分（モバイルの背景は持ち越し）、ブロックの配信 1 時間、共有リンクのブロック 15 分、プレビュー 10 分（共有リンク 5 分）、組み立てたダウンロード 1 時間 | [ADR-0007](../decisions/0007-block-storage-layout-on-s3.md)、[ADR-0027](../decisions/0027-shared-link-model-and-resolution.md)、[ADR-0033](../decisions/0033-preview-cache-and-delivery.md)、[ADR-0054](../decisions/0054-server-assembled-downloads.md) | — |
| 組み立てたダウンロード | 10,000 ファイル・20 GiB、`exports` は 1 日 | [ADR-0054](../decisions/0054-server-assembled-downloads.md) | — |
| `incoming` の保持 | 2 日 | 同上 | — |
| GC の猶予、削除の後の戻せる期間 | 参照 0 から 7 日、S3 のバージョニングで 30 日 | 同上 | `ops.block_gc_enabled`（止めるだけ）、`ops.block_gc_rate` |
| CRR の遅れ | 15 分（Replication Time Control） | 同上 | — |
| 消しすぎの止め | 5 分の窓で 1,000 ファイルか木の 10% | [ADR-0006](../decisions/0006-sync-conflict-model.md)、[sync-engine.md](../architecture/sync-engine.md) の 10 節 | — |
| バージョンの保持 | 30 日・180 日・365 日（プラン） | [architecture/README.md](../architecture/README.md) の 6 節 | — |
| アップロードの並行 | 端末ごとに 8 本（16 本まで広げる） | [block-storage.md](../architecture/block-storage.md) の 4.2 節 | `ops.client_upload_concurrency`（AppConfig でクライアントへ配る） |
| アップロードの受け入れ | 全体 2.5 GB/秒、テナントは個人 100 MB/秒・チーム 1 GB/秒 | [ADR-0051](../decisions/0051-load-shaping-uploads-signals-and-reconnects.md) | `ops.upload_admission_global_bps`、`ops.upload_admission_tenant_bps` |
| アップロード・書き込みの停止 | — | [infrastructure.md](../architecture/infrastructure.md) の 6.3 節 | `ops.uploads_enabled`、`ops.writes_enabled`（止めるだけ。読み出しは続ける） |
| プレビューの形式 | — | [security.md](../architecture/security.md) の 11 節 | `ops.preview_formats_enabled`（形式ごとに止める） |
| 検索 | — | [search.md](../architecture/search.md) の 9 節 | `ops.search_enabled`（止めるだけ） |
| 共有リンクの悪用の上限 | [shared-links.md](../architecture/shared-links.md) の 9 節 | [ADR-0028](../decisions/0028-shared-link-abuse-controls.md) | `ops.*` で下げるだけ |
| 中身の検査の範囲 | 本番は `none`（法務の L1・L2 の結論まで） | [ADR-0046](../decisions/0046-content-scanning-framework.md) | `content_scan_policy`（法務の結論の後に、監査に残して変える） |
| クライアントの最低のバージョン、止めたバージョン、段階 | — | [ADR-0052](../decisions/0052-client-signing-staged-rollout-and-minimum-version.md) | `client.min_supported_version`、`client.blocked_versions`、`client.rollout` |

## 3. リリースとロールバック

- **デプロイとリリースを分ける。** デプロイは Ops が承認し、リリース（フラグを広げる）は PM が判断する。未完成の振る舞いは `release.*` のフラグの裏に置く。`release.*` は 100% の後 30 日で消す。
- **同期・名前・分割・権限の規則をフラグにしない。** 衝突の決定表、`name_key`、分割の規則、`can()` の変更は、コードのバージョンとして出し、本番の照合の指標で見る。
- **サーバーのデプロイの順**：マイグレーション（広げる段だけ）→ API・Link・Auth（ローリング）→ Relay → Worker（`block-gc` は最後。新しいバージョンの GC は、参照の監査が 24 時間 0 のときだけ有効にする）→ Notify（1 タスクずつ逃がす）→ Web の資産（置くだけ）。自動のロールバックの条件は、5xx、commit の p99、409 と 4xx の率の急な上がり、参照の監査の不一致。
- **クライアントの配布**：デスクトップとモバイルは、社内 → 1% → 10% → 50% → 100%、各段 48 時間以上（モバイルはストアの段階の公開を使う。iOS は App Store の 7 日の段階に同じ止める基準を当てる。[delivery.md](../architecture/delivery.md) の 5.5 節）。止める条件：クラッシュの率、端末の健全さ、競合のコピー・消しすぎの止め・走査し直しの率がリリースの前の 2 倍。クライアントは古いバージョンへ戻せない前提で、サーバーは少なくとも 2 つ前までのクライアントのバージョンを受ける。止めたクライアントのバージョンは、AppConfig で同期を止めて（読み出しだけにして）利用者に更新を促せるようにする。
- **ロールバック**：まずフラグで戻す。次に 1 つ前のイメージ（マイグレーションは広げる段だけなので、前のバージョンが今の DB で動く）。縮める段の後は前へ戻さない。
- 本番へのデプロイは Ops が承認する（作成者と別の人）。

### 3.1 デプロイの時間帯と凍結

| 対象 | 時間帯 | 凍結（修正だけ） |
| --- | --- | --- |
| サーバー、Web のクライアント | 平日 10〜17 時 | 金曜 15 時以降、日本の祝日の前日、年末年始、年度末（3 月の最後の週）、エラーバジェットを使い切っている間 |
| デスクトップ・モバイルのクライアントの段階を進める | 平日 10〜15 時 | 同上。OS の大きな更新の公開の週 |
| `block-gc` の新しいバージョンの有効化 | 平日 10〜15 時 | 同上 |
| マイグレーション（縮める・消す段） | 計画作業として平日 10〜15 時 | 同上 |
| Terraform（ネットワーク、データ、S3 の方針） | 平日 10〜16 時。Ops の承認 | 同上 |

- 上の時間帯と凍結は本システムの既定である。年度末は、決算と書類の受け渡しでファイルの共有が増えると見込んだ（本システムの想定）。本家の運用の値ではない。

### 3.2 長く残すフラグ（30 日で消す規則の例外）

法務の結論や計測の結果を待つ `release.*` は、100% の後 30 日で消す規則の例外として、ここに載せる。ここにないものが 30 日を超えて残っていれば、週次で `flags-appconfig` の担当に知らせる。

| フラグ | 有効にする条件 | 正本 |
| --- | --- | --- |
| `release.shared-links-public` | 法務の L1・L2・L5 の結論と、PM・法務の判断 | [ADR-0028](../decisions/0028-shared-link-abuse-controls.md) |
| `release.eager-thumbnails`、`release.fulltext-extraction` | 法務の L1 の結論 | [ADR-0033](../decisions/0033-preview-cache-and-delivery.md)、[previews-and-thumbnails.md](../architecture/previews-and-thumbnails.md) の 5 節 |
| `release.mobile-push` | 法務の L4 の結論 | [ADR-0037](../decisions/0037-mobile-offline-files-and-content-free-push.md) |
| `release.admin-member-access` | 法務の L7 の結論 | [ADR-0043](../decisions/0043-admin-roles-device-wipe-and-member-access.md) |
| `release.small-block-packing` | `small-block-pack-poc` で費用が 20% 以上下がり、範囲の署名を確かめたとき | [ADR-0020](../decisions/0020-small-block-packing-for-s2.md) |

## 4. アラートと手順

作成済みの手順は 6 節。ほかは各 Epic の実装に合わせて [templates/runbook.md](../../../../docs/templates/runbook.md) から作る。「作る Story」の列は、そのアラートの計測と手順を作る [roadmap.md](../roadmap.md) の Story である。手順の文書は、その Story の完了の条件に含める（E13 の `runbooks-e13` でまとめて確かめる）。条件の実装は [observability.md](../architecture/observability.md) の 6 節。

| アラート（重さ） | 手順 | 作る Story |
| --- | --- | --- |
| メタデータと同期の SLO のバーンレート（page・ticket）、秘密・名前の形がログに出た（page） | [incident-response.md](incident-response.md) | `slo-dashboards-alerts`、`otel-baseline` |
| ブロックの参照の監査の不一致、照合のジョブが動かなかった（page、SEV1 の候補） | `block-integrity-incident.md`（GC の停止、`block_gc_log` から S3 の古いバージョンでの戻しを含む） | `block-scrubber-and-audit`、`block-restore-drill` |
| チェックサムの照合の不一致（page） | `block-checksum-mismatch.md` | `block-scrubber-and-audit` |
| `block-verifier` の滞留（SQS の最古 60 秒。page）、`incoming` の溢れ、`background` の 429 の急増 | `upload-pipeline-lag.md` | `block-index-and-verifier`、`upload-admission` |
| 名前空間のロックの待ち（上位の名前空間の p99 200ms が 10 分。ticket）、429・`subtree_locked` の急増 | `namespace-lock-contention.md` | `committer-and-journal-skeleton`、`namespace-write-throughput-poc` |
| 名前空間をまたぐバッチが止まった（30 分の期限に近い） | `cross-namespace-batch-stuck.md` | `cross-namespace-move` |
| ジャーナルの番号の欠け（1 件で ticket、10 件で page） | `journal-gap.md`（まずは [incident-response.md](incident-response.md) の場面 2） | `committer-and-journal-skeleton` |
| 伝播の遅れ（page）、Notify の再接続の殺到 | `propagation-lag.md` | `notify-gateway`、`propagation-sli` |
| カーソルの取り直しの急増（ticket） | `cursor-reset-spike.md` | `list-folder-and-cursor` |
| 権限の漏れの疑い（応答の監査。page、SEV1 の候補）、人のロールの復号・`GetObject` の試み（page） | `access-leak-response.md` | `access-can`、`leak-path-tests`、`response-audit` |
| 端末の健全さの低下、クライアントの異常終了の急増、競合・消しすぎの止め・走査し直し・`stuck` の急増 | `client-regression.md`（段階の配布の停止、`client.blocked_versions`、戻しのリリース） | `desktop-distribution`、`client-resource-bench`、`client-telemetry` |
| 一斉の変更の検知（`alert`）とその急増（ランサムウェア・一斉の削除の疑い） | [mass-change-response.md](mass-change-response.md) | `mass-change-detector`、`namespace-rewind` |
| 復元・巻き戻しのジョブが止まった、保持の期限の処理が 7 日遅れた | `restore-job-stuck.md`、`retention-lifecycle-lag.md` | `namespace-rewind`、`revision-retention` |
| 乗っ取りの疑い（一斉の変更と新しい端末の組） | `account-takeover.md` | `session-revocation`、`step-up-auth` |
| IdP の障害 | `idp-outage.md` | `sso-saml-oidc` |
| 共有リンクの悪用・違法なコンテンツの通報、`hash_match`・`integrity_mismatch` | `abuse-and-takedown.md`（法務の L2 の後に確定） | `link-abuse-report`、`content-scanner-framework` |
| 開示の請求・捜査機関からの照会 | `legal-request.md`（法務の L3 の後に確定） | `audit-log-ui-export` |
| プレビューの変換の隔離の違反（外への通信の試み）、変換の失敗の急増 | `preview-sandbox-incident.md` | `preview-sandbox` |
| 検索の索引の遅れ（名前の索引の p95 が 10 分） | `search-index-lag.md` | `search-names` |
| Webhook の送信の失敗の増加、`webhook-fanout` の遅れ（p95 5 分） | `webhook-delivery.md` | `webhooks` |
| CRR の遅れ（15 分を超える。page）、Aurora Global Database の遅延（`AuroraGlobalDBRPOLag` 10 秒が 5 分。page）、リージョンの障害 | [disaster-recovery.md](disaster-recovery.md) | `osaka-warm-standby`、`dr-failover-workflow`、`dr-failover-drill` |
| `content` の東京のオリジンの障害 | `cdn-origin-failover.md` | `edge-and-waf` |
| デプロイ中の自動ロールバック、マイグレーションの失敗 | [deploy-and-rollback.md](deploy-and-rollback.md)、`schema-expand-contract.md` | `ci-pipeline-baseline`、`schema-migration-gates` |
| 解約の後の消去の遅れ・失敗 | `tenant-purge.md` | `data-lifecycle` |
| 端末の消去の依頼の確かめ | `device-wipe-request.md`（法務の L7 の後） | `remote-unlink-and-wipe` |

- すべてのアラートは、対応する手順の URL を注釈に持つ（CI で検査する）。
- 個別の手順を作るまでは、[incident-response.md](incident-response.md) の共通の進め方で対応する。

## 5. 定期作業と訓練

| 作業 | 頻度 | 手順 | 持ち主 |
| --- | --- | --- | --- |
| S3 Inventory と索引の突き合わせの結果の確認 | 毎週 | `block-integrity-incident.md` | Ops |
| ブロックの戻しの訓練（検証の環境、E13 で本番と同じ構成） | 毎月 | `block-integrity-incident.md` | Ops、Dev |
| DR の訓練（staging の切り替え、本番の switchover） | staging は四半期、本番は年 1 回 | [disaster-recovery.md](disaster-recovery.md) | Ops |
| 巻き戻しの訓練（100 万ファイル） | E13 と半年ごと | [mass-change-response.md](mass-change-response.md) | Ops、QA |
| OS のベータでのファイルシステムの端の場合の試験の結果の確認 | OS のベータの公開ごと | `client-regression.md` | QA、Dev |
| 費用とキャパシティの見直し（TB あたりの費用、層の割合、段階の指標、購読の多い名前空間） | 毎月 | `capacity-review.md` | Ops、PM |
| 長く残すフラグと、30 日を超えた `release.*` の一覧 | 毎週 | 3.2 節 | Ops |

## 6. 作成済みの runbook

| ファイル | 中身 |
| --- | --- |
| [incident-response.md](incident-response.md) | 共通の進め方（重さ、IC、告知、調べ方）と、個別の手順のないアラートの最初の切り分け（同期の SLO、ジャーナルの欠け、SLI の集計の欠け、秘密の出力） |
| [deploy-and-rollback.md](deploy-and-rollback.md) | サーバーのデプロイの順、自動のロールバック、前のイメージへの戻し、`block-gc` の有効化、クライアントの段階の配布の止め方、リリースの前の確認 |
| [disaster-recovery.md](disaster-recovery.md) | 大阪への切り替えのワークフロー、`epoch`、中身の待ちと端末からの送り直し、`lost` の扱い、東京へ戻す、訓練の合格基準 |
| [mass-change-response.md](mass-change-response.md) | 一斉の削除とランサムウェアからの回復（検知の確かめ、端末の切り離し、時点の選び方、巻き戻し、取り消し） |

計画の runbook（4・5 節のリンクのないもの）：`block-integrity-incident.md`、`block-checksum-mismatch.md`、`upload-pipeline-lag.md`、`namespace-lock-contention.md`、`cross-namespace-batch-stuck.md`、`journal-gap.md`、`propagation-lag.md`、`cursor-reset-spike.md`、`access-leak-response.md`、`client-regression.md`、`restore-job-stuck.md`、`retention-lifecycle-lag.md`、`account-takeover.md`、`idp-outage.md`、`abuse-and-takedown.md`、`legal-request.md`、`preview-sandbox-incident.md`、`search-index-lag.md`、`webhook-delivery.md`、`cdn-origin-failover.md`、`schema-expand-contract.md`、`tenant-purge.md`、`device-wipe-request.md`、`capacity-review.md`。

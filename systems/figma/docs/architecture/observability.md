# Observability: Figma

ログ、メトリクス、トレース、クライアントの計測（フレーム時間、メモリ、WASM の異常終了）、SLI と SLO、アラートと runbook の対応、合成の監視。道具は Slack の [ADR-0021](../../../slack/docs/decisions/0021-observability-stack.md) を引き継ぐ（OpenTelemetry → AMP・X-Ray・CloudWatch Logs、Grafana で横断）。SLO の値とアラートの一覧の正本は Ops の [runbooks/README.md](../runbooks/README.md) に置く。ここには、それを計る仕組みを書く。

| ADR | 決定 |
| --- | --- |
| [0049](../decisions/0049-client-telemetry-without-content.md) | クライアントの計測は、ブラウザの中で集計してから、中身を含まない形で自前の受け口へ送る。panic は場所と種類だけ |
| [0050](../decisions/0050-editing-slis-and-slos.md) | 編集の SLO は「開ける」と「確定する」の 2 つのイベントの SLI で数え、反映の遅延は合成のボットで、回復の時間は Router の記録で測る |

## 1. 全体の流れ

```
ブラウザ（エンジン＋UI の殻）
   │ 60 秒ごとの集計（ヒストグラム）、異常終了の報告
   ▼
telemetry-ingest（telemetry.<brand>.<domain>）── ラベルの許可の一覧 ──▶ AMP（メトリクス）
   └─▶ CloudWatch Logs（異常終了の報告、30 日）─▶ 名前の表で読み替え（shared の S3）

gateway / ds-* / router / api / realtime / workers / render-worker
   │ OTLP（各タスクの ADOT Collector のサイドカー）
   ├─ metrics ─▶ AMP
   ├─ traces  ─▶ X-Ray（標本化）
   └─ logs    ─▶ CloudWatch Logs ─▶ Firehose ─▶ log-archive の S3

AWS のリソース（DynamoDB・S3・ALB・CloudFront・Aurora）─▶ CloudWatch のメトリクス
合成のボット（東京の 3 AZ、大阪）─▶ AMP

Grafana（shared）：横断のダッシュボード
アラート：AMP のルール → Alertmanager → SNS → オンコール。AWS のリソースは CloudWatch アラーム → SNS
```

## 2. サーバーの計装

- 計装は、Rust は `crates/telemetry`、TypeScript は `packages/telemetry` に集め、属性名とメトリクスの名前を定数で定義する。
- 共通の属性：`service.name`、`service.version`（ビルドの ID）、`deployment.environment`、`cloud.region`、`cloud.availability_zone`、`region_gen`（[ADR-0048](../decisions/0048-osaka-dr-with-journal-generations.md)）。
- **書いてよいもの**：`file_id`、`session_id`、`seq`、`epoch`、ノードの ID、大きさ、件数、理由のコード。**書かないもの**：ファイル・ノード・ページの名前、テキスト、画像のハッシュ、フォントの名前（[AGENTS.md](../../AGENTS.md)）。
- `file_id`・`session_id` は、ログとトレースの属性には書くが、**メトリクスのラベルには入れない**（数が多すぎる）。ファイルごとの様子は 4.3 節の上位のファイルの記録で見る。

### 2.1 主なメトリクス

| 部品 | メトリクス | 種類 | 使いどころ |
| --- | --- | --- | --- |
| gateway | `gw_connections`（`state`） | gauge | 容量、偏り |
| gateway | `gw_open_total`（`result`）、`gw_open_seconds` | counter、histogram | SLI `edit_open` |
| gateway | `gw_kick_total`（`reason`） | counter | 再接続の殺到、版の食い違い |
| gateway | `gw_send_queue_bytes` | histogram | 遅い読み手 |
| gateway | `gw_reconnect_total`（`resumed`・`reload`） | counter | 再接続の結果 |
| ds | `ds_commit_total`（`result`）、`ds_commit_seconds`（`Changes` の受信 → `Ack`） | counter、histogram | SLI `edit_commit`、NFR-001 の予算の区間（[multiplayer.md](multiplayer.md) の 8 節） |
| ds | `ds_reject_total`（`code`） | counter | 競合の多さ、クライアントの不具合 |
| ds | `ds_journal_write_seconds`、`ds_journal_batch_bytes`、`ds_journal_batch_changes` | histogram | ジャーナルの遅延と大きさ |
| ds | `ds_journal_retry_total`（`reason`：`conflict`・`throttle`・`timeout`・`5xx`） | counter | DynamoDB の不調 |
| ds | `ds_fence_lost_total` | counter | 二重の持ち主（[ADR-0024](../decisions/0024-journal-items-and-fencing.md)） |
| ds | `ds_journal_gap_total` | counter | ジャーナルの飛び（回復での検知） |
| ds | `ds_write_budget_files`（`stage`） | gauge | 1 ファイルの書き込みの予算の段（[ADR-0052](../decisions/0052-journal-throughput-and-hot-file-budget.md)） |
| ds | `ds_files_open`（`pool`）、`ds_memory_bytes`（`kind`：`docs`・`tail`・`serialize`）、`ds_memory_budget_ratio` | gauge | [ADR-0051](../decisions/0051-document-server-memory-admission.md) の受け入れ |
| ds | `ds_checkpoint_seconds`、`ds_checkpoint_bytes`、`ds_checkpoint_stalled_files`（10 分進まない） | histogram、gauge | [file-storage-and-history.md](file-storage-and-history.md) の 12 節 |
| ds | `ds_recovery_seconds`（`source`：`checkpoint`・`journal`）、`ds_recovery_journal_items` | histogram | NFR-007 の内訳 |
| ds | `ds_presence_batch_bytes`、`ds_participants` | histogram | 人が集まるファイル |
| router | `router_assign_total`（`kind`：`open`・`handoff`・`recover_only`・`drain`） | counter | 割り当ての量 |
| router | `router_owner_recovery_seconds` | histogram | SLI `owner_recovery` |
| router | `router_orphans`（生存の切れた持ち主の割り当て）、`router_orphan_oldest_seconds` | gauge | 回復のジョブの見張り（[ADR-0047](../decisions/0047-router-task-liveness-and-file-assignment.md)） |
| router | `router_drain_remaining_files` | gauge | ドレインの進み |
| api | `api_ticket_issued_total`、`api_ticket_seconds`、`api_http_*` | counter、histogram | チケットの発行、SLI `metadata_api` |
| DynamoDB | `ThrottledRequests`、`SuccessfulRequestLatency`、`ReplicationLatency`（東京 → 大阪）、`ConsumedWriteCapacityUnits` | CloudWatch | ジャーナルの容量と複製 |
| S3 | 複製の待ち（`OperationsPendingReplication`）、RTC の 15 分超えの事象 | CloudWatch | 大阪への複製（[S3 Replication Time Control](https://docs.aws.amazon.com/AmazonS3/latest/userguide/replication-time-control.html)、2026-09-27 に確認） |

- DynamoDB の `ReplicationLatency` は、MREC のグローバルテーブルが、送り元と送り先のリージョンの組ごとに出す（[How DynamoDB global tables work](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/V2globaltables_HowItWorks.html)、2026-09-27 に確認）。

### 2.2 トレース

| 境界 | 運び方 |
| --- | --- |
| ブラウザ → API | `traceparent` を受け付けない（外部の値を信頼しない）。API が始める |
| ブラウザ → Gateway | 受け付けない。Gateway が接続ごとにトレースを始める（`Hello` から `Welcome` まで） |
| Gateway → Document Server | `open_session` と、標本化した `Changes`（1% と、500ms を超えたもの）に `traceparent` を付ける |
| Document Server → DynamoDB・S3 | SDK の計装 |
| API → SQS → Worker | メッセージ属性の `traceparent` |

- 変更 1 件ごとのトレースは量が多すぎるので取らない。遅いものだけを後から残す（tail sampling）。
- Document Server のスパン：`file.recover`（チェックポイント、ジャーナル、当て直し）、`journal.write`（再試行ごと）、`checkpoint.write`（直列化、PUT、Aurora の更新）、`file.handoff`。

## 3. クライアントの計測

[ADR-0049](../decisions/0049-client-telemetry-without-content.md) による。

### 3.1 計る物

| 指標 | 計り方 | 関係する NFR |
| --- | --- | --- |
| フレーム時間（`pan`・`zoom`・`drag`・`idle` の別） | エンジンが `performance.now()` で 1 フレームの各段（入力、レイアウト、シーングラフ、タイル、合成）を測る | NFR-005 |
| 入力から描画まで | 入力のイベントの時刻から、その変更を含むフレームの提示まで | NFR-002 |
| 開く時間（キャッシュあり・なし） | `Hello` の送信から、最初のページが操作できるまで。チャンクの取得、復号、`tail` の適用の内訳（[file-storage-and-history.md](file-storage-and-history.md) の 17 節） | NFR-003 |
| メモリ | WASM の線形メモリの大きさ、エンジンの予算の内訳（[rendering-engine.md](rendering-engine.md) の 11 節）、GPU の予算の使用。Chromium では `measureUserAgentSpecificMemory()` を補助に使う（cross-origin isolation を要する。[MDN](https://developer.mozilla.org/en-US/docs/Web/API/Performance/measureUserAgentSpecificMemory)、2026-09-27 に確認） | NFR-004 |
| メモリの警告 | 80% の警告を出した回数 | NFR-004 |
| 異常終了 | Rust の panic、WASM の trap（`unreachable`、メモリの確保の失敗）、GPU のコンテキストの喪失、安全な描画の状態に入った回数 | — |
| GPU のバックエンド | WebGPU・WebGL2 の別、切り替えの回数と理由 | [ADR-0014](../decisions/0014-gpu-backend-selection-and-fallback.md) |
| マルチプレイヤー | `pending` の件数の最大、`Disconnected` の時間、読み込み直しの回数 | — |
| 反映の遅延（体感） | 他の人の `Committed` の受信から、画面に出るまで | NFR-001 の最後の区間 |

- Long Animation Frames の API は、実験的で主要なブラウザのすべてでは動かない（[MDN: PerformanceLongAnimationFrameTiming](https://developer.mozilla.org/en-US/docs/Web/API/PerformanceLongAnimationFrameTiming)、2026-09-27 に確認）。使えるブラウザでは、React の殻の遅いフレームの原因の調べに使う。

### 3.2 送り方

- 60 秒ごと（タブを隠したとき、閉じるときも）に、対数の区間のヒストグラムにまとめて `sendBeacon` で送る。
- ラベル（許可の一覧）：ビルドの ID、ブラウザの種類と大きな版、OS の種類、GPU のバックエンド、GPU の区分（ベンダーを丸めたもの）、ファイルの大きさの区分（ノードの数を 5 段）、組織のプラン。
- 受け口は、許可の一覧にないラベルと長さの上限を超える値を捨て、OTel のメトリクスに変えて AMP へ送る。
- 本家は、本番の端末の計測の仕組みを公開していない（**未検証**）。PR ごとの性能の CI は本家に倣う（[delivery.md](delivery.md) の 3 節）。

### 3.3 異常終了の報告

```
ErrorReport {
  kind: Panic | Trap(Unreachable | OutOfMemory | ...) | GpuLost | SafeMode,
  location: "crates/scene/src/tile.rs:212:9",   // panic の場所。メッセージは送らない
  wasm_frames: [u32],                           // 関数の番号の列
  build_id, browser, os, gpu_backend,
  file_id?, session_id?, node_id?, node_count, pending_count,
}
```

- 受け口は、ビルドごとの名前の表（shared の S3）で `wasm_frames` を関数の名前に読み替える。
- 同じ `location` の報告は、1 セッション 1 回に絞る。
- 報告の急増（ビルドごと・場所ごと）は、[editor-and-tools.md](editor-and-tools.md) の 20 節の `engine-panic-spike.md` の手順につなぐ。

### 3.4 見方

- 日次で、ブラウザ・OS・GPU・ビルドの別に、フレーム時間の p95、開く時間の p75、メモリの警告の率、異常終了の率（1,000 セッションあたり）を見る。
- 新しいビルドの段階的な配信（[ADR-0055](../decisions/0055-staged-rollout-and-schema-changes.md)）では、前のビルドと同じ期間・同じ組の分布を並べて比べる。

## 4. ログ

### 4.1 規則

- 構造化したログ（JSON）。1 つの要求・接続・ジョブに `request_id`・`session_id`・`job_id` を付ける。
- 2 節の「書かないもの」を、ログの型で防ぐ（名前・テキストの型は `Display` を持たない。`Debug` は伏せ字にする）。
- レベル：`error` は Ops が見るべきもの、`warn` は自動で回復したもの、`info` は状態の変化（ファイルの割り当て、手放し、回復、チェックポイント）。変更 1 件ごとのログは書かない。

### 4.2 保持

| ログ | 保持 |
| --- | --- |
| アプリのログ（CloudWatch Logs） | 30 日 |
| log-archive の S3（Firehose 経由） | 1 年 |
| クライアントの異常終了の報告 | 30 日 |
| 監査ログ | [security.md](security.md) の 6 節 |

### 4.3 上位のファイルの記録

- 各 Document Server は、10 秒ごとに、自分のファイルのうち上位 20 件（確定の数、書き込みの単位、参加の数、メモリで）を 1 行のログに書く（`file_id`・数だけ）。
- Grafana の「人が集まるファイル」の表は、CloudWatch Logs Insights でこのログを集めて出す。[runbooks/incident-response.md](../runbooks/incident-response.md) の「人が集まるファイル」で使う。

## 5. SLI と SLO

[ADR-0050](../decisions/0050-editing-slis-and-slos.md) による。値の正本は [runbooks/README.md](../runbooks/README.md) の 1 節。

| SLI | 計り方 | SLO（月間、S1） | 関係する NFR |
| --- | --- | --- | --- |
| `edit_open` | `gw_open_total`：有効なチケットの `Hello` → `Welcome` が 10 秒以内。クライアントの側の理由（期限切れ、`forbidden`、`version_mismatch`）は数えない | 99.95% | NFR-008 |
| `edit_commit` | `ds_commit_total`：検証を通った `ChangeSet` → `Ack` が 2 秒以内。持ち主の交代の間の失敗は数えない | 99.95% | NFR-008 |
| `edit_propagation` | 合成のボットの組（7 節）：送信 → 相手の受信が 250ms 以内 | 99% | NFR-001 |
| `owner_recovery` | `router_owner_recovery_seconds`：生存の切れ → 新しい持ち主の受け付けが 15 秒以内 | 95% | NFR-007 |
| `metadata_api` | ALB と API の 5xx でない応答 | 99.9% | NFR-008 |
| `realtime_delivery` | コミット → 購読者への送信が 1 秒以内 | 99% | [comments-and-notifications.md](comments-and-notifications.md) の 5.3 節 |
| `journal_replication` | `ReplicationLatency`（東京 → 大阪）が 30 秒以内の時間の割合 | 99.9% | NFR-009 |

- クライアントの計測（3 節）は SLO にしない。quality.md の品質の指標として QA が見る（ADR-0050）。
- エラーバジェットの方針は Slack と同じ。

## 6. アラートと runbook

呼び出し（page）は、利用者に影響が出ているか、放っておくとデータを失うものだけにする。

| アラート | 条件 | 重さ | runbook |
| --- | --- | --- | --- |
| 編集の SLO の速いバーンレート | `edit_open` か `edit_commit` の 1 時間のバーンレートが 14.4 倍 | page | [incident-response.md](../runbooks/incident-response.md) |
| 編集の SLO の遅いバーンレート | 6 時間で 6 倍 | ticket | 同上 |
| 反映の遅延 | `edit_propagation` の p99 が 250ms を 15 分超える | page | 同上 |
| 持ち主の回復の遅れ | `owner_recovery` の p95 が 15 秒を 10 分超える | page | 同上 |
| 二重の持ち主 | `ds_fence_lost_total` が 5 分で 10 を超える（デプロイの外） | page | 同上 |
| ジャーナルの飛び | `ds_journal_gap_total` が 1 以上 | page | [incident-response.md](../runbooks/incident-response.md) の「ジャーナルの飛び」、`journal-gap-or-corruption.md`（file-storage-and-history.md の 17 節） |
| ジャーナルの遅延・スロットリング | `ds_journal_write_seconds` の p99 が 100ms を 10 分、または `ThrottledRequests` が 0 でない | page | `journal-throttling.md`（同上） |
| 人が集まるファイル | `ds_write_budget_files{stage="100%"}` が 1 以上を 5 分、または 1 タスクの CPU 80% | ticket | [incident-response.md](../runbooks/incident-response.md) の「人が集まるファイル」 |
| 再接続の殺到 | `gw_reconnect_total` が平常の 10 倍、または API の 429 が 1 分続く | page | [incident-response.md](../runbooks/incident-response.md) の「再接続の殺到」 |
| Document Server のメモリ | `ds_memory_budget_ratio` が 85% を 10 分 | ticket | `ds-memory-pressure.md`（[capacity.md](capacity.md) の 13 節） |
| 手放さずに残るファイル | `router_orphan_oldest_seconds` が 1 日を超える | ticket | `orphaned-file-recovery.md`（file-storage-and-history.md の 17 節） |
| チェックポイントの停滞 | `ds_checkpoint_stalled_files` が 0 でないのが 30 分 | ticket | `checkpoint-stalled.md`（同上） |
| ドレインの停滞 | `router_drain_remaining_files` が 30 分減らない | ticket | [deploy-and-rollback.md](../runbooks/deploy-and-rollback.md) |
| 大阪への複製の遅れ | `ReplicationLatency` が 10 秒で警告、30 秒で page。S3 の RTC の 15 分超え | page | [disaster-recovery.md](../runbooks/disaster-recovery.md) |
| 大阪からの合成の監視の連続の失敗 | 東京の入口への合成の監視が 3 回続けて失敗 | page | [disaster-recovery.md](../runbooks/disaster-recovery.md) |
| 作り直しの検証の不一致 | [file-storage-and-history.md](file-storage-and-history.md) の 14.3 節の不一致が 1 以上 | page | `journal-gap-or-corruption.md` |
| 不変条件の破れ | サーバーの抜き取りの検査の破れが 1 以上 | ticket | `document-invariant-violation.md`（[document-model.md](document-model.md) の 17 節） |
| クライアントの異常終了の急増 | 新しいビルドの panic の率が前のビルドの 2 倍 | ticket | `engine-panic-spike.md`（editor-and-tools.md の 20 節）、[deploy-and-rollback.md](../runbooks/deploy-and-rollback.md) |
| GPU の切り替えの急増 | WebGPU → WebGL2 の率が特定の GPU で急増 | ticket | `gpu-blocklist.md`（[rendering-engine.md](rendering-engine.md) の 19 節） |
| レイアウトの食い違い | `layout_divergence` が 1 以上 | ticket | `layout-divergence.md`（[layout.md](layout.md) の 17 節） |
| 権限の取り消しの遅れ | 権限を外してから接続が切れるまで p99 10 秒を超える | ticket | `acl-revocation-lag.md`（[multiplayer.md](multiplayer.md) の 18 節） |
| Render Worker の滞留 | `render-export` の最古が 5 分、`render-thumbnail` が 30 分 | ticket | `render-worker-backlog.md`（[export-and-assets.md](export-and-assets.md) の 16 節） |
| Realtime・通知の遅れ | `realtime_delivery` の p99 が 1 秒を 15 分超える | ticket | [comments-and-notifications.md](comments-and-notifications.md) の 11 節 |

- 名前だけを書いた runbook は、各領域が提案したもので、作る Epic を [runbooks/README.md](../runbooks/README.md) の 4 節に書いた。
- デプロイの直後 30 分の SLO の悪化は、[deploy-and-rollback.md](../runbooks/deploy-and-rollback.md) の「悪化したとき」を先に見る。

## 7. 合成の監視

| 監視 | 中身 | 場所と頻度 |
| --- | --- | --- |
| 反映のボットの組 | ボット A が `transform` を変え、ボット B が `Committed` を受け取るまでの時間。ボット用の組織とファイル（1 千ノード） | 東京の 3 AZ から、1 分ごとに 10 回 |
| 開くボット | 1 万ノードの参照ファイルを、キャッシュなしで開く（チケット → `Welcome` → チャンク → 最初のページ） | 東京から 5 分ごと |
| 人が集まるファイルのボット | 50 接続の在席と編集 | 東京から 1 時間ごと 5 分間 |
| 書き出しのボット | サーバーの書き出し（PNG）を 1 つ | 15 分ごと |
| 大阪からの外形の監視 | 東京の入口（`app`・`mp`・`api`）への到達 | 大阪から 1 分ごと |

- ボットの組織は、本番の SLO の計算から除く（ボットの `org_id` をラベルで分ける）。
- ボットのファイルの中身は、固定の生成物（利用者のデータではない）。

## 8. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E1 | `otel-rust-baseline` | Rust の OTel（ADOT のサイドカー）、共通の属性、ログの型の規則 |
| E2 | `client-frame-telemetry` | 3.1 節のフレーム時間とメモリの集計 |
| E2 | `telemetry-ingest` | 受け口、ラベルの許可の一覧、AMP への変換 |
| E2 | `wasm-error-reports` | 3.3 節の panic・trap の報告と、ビルドの名前の表 |
| E3 | `mp-metrics-and-slis` | 2.1 節の gateway・ds・router のメトリクスと、SLI の良い・悪いの判定 |
| E3 | `hot-files-log` | 4.3 節 |
| E12 | `synthetic-bots` | 7 節 |
| E12 | `alerts-and-dashboards` | 6 節のアラートと、Grafana のダッシュボード |

## 9. 未解決の問い

### 決定（2026-09-27、既定案）

- クライアントの計測は自前の受け口。外部の RUM は使わない。
- `file_id` はメトリクスのラベルに入れない。上位のファイルの記録で見る。
- 編集の SLO は `edit_open` と `edit_commit` の 2 つで守る。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| GPU のメモリをタブのメモリに数えるか（NFR-004 の定義） | QA（[rendering-engine.md](rendering-engine.md) の 19 節） |
| クライアントの計測の利用規約への書き方 | 法務（[security.md](security.md) の 10 節） |
| cross-origin isolation を有効にするか（`measureUserAgentSpecificMemory` のため。埋め込みやプラグインの iframe への影響） | E2 の PoC |
| 反映のボットの組を大阪にも置くか | S2 |

## 10. quality.md・runbooks・data-model への項目

### quality.md

- 3.1 節のクライアントの指標（フレーム時間の p95、開く時間の p75、メモリの警告の率、異常終了の率）を、ブラウザ・OS・GPU の別に日次で見る。許容の範囲を QA が決める。
- ビルドの段階的な配信の各段の合否（前のビルドとの比較）の基準。

### runbooks

- [runbooks/README.md](../runbooks/README.md) に、5 節の SLO と 6 節のアラートの一覧を置いた（統合の工程）。
- `telemetry-ingest-down.md`：受け口が止まったときの影響（計測の欠け。利用者への影響なし）と、再開。

### data-model

| 置き場所 | 中身 |
| --- | --- |
| AMP | 2.1 節と 3.1 節のメトリクス |
| CloudWatch Logs `/<brand>/{service}` | アプリのログ（30 日）、上位のファイルの記録、異常終了の報告 |
| S3（shared）`wasm-symbols/{build_id}/…` | ビルドごとの関数の名前の表 |

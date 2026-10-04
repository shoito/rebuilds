# Roadmap: Linear

## 進め方の原則

- **最初に walking skeleton を通す。** E1〜E3 で、スキーマの定義と生成・Writer・`sync_actions`・Relay・Gateway・Sync API・IndexedDB と outbox を端から端まで貫き、2 つのブラウザで同じイシューの状態を変えて、オフラインで書いて戻れるところまで作ってから、機能を広げる。収束のシミュレーター（[ADR-0010](decisions/0010-deterministic-sync-simulator.md)）、オフラインと再送の 3 つの場面、遅延の予算の CI（[ADR-0055](decisions/0055-ci-gates-latency-convergence-ime.md)）、FORCE RLS と同期グループの絞り込み（[ADR-0004](decisions/0004-tenancy-and-permissions.md)）は、E1〜E3 から本物の形で作る。後から足すと直せないため。
- **PoC を先に済ませる。** 次の PoC は、それぞれの Epic の Story の spec を承認する前に結果を記録する。
  - E2 の前：1 ワークスペースの書き込みの上限（`writer-throughput-poc`。1 秒 300 変更、最初にロックを取る方式で届くか）、反応型のストアとメモリーの階層（`memory-tiers-poc`。MobX か自前か、イシュー 50 万件）。
  - E3 の前：IndexedDB の一括の書き込みと部分のブートストラップの時間（基準の端末で p95 10 秒。だめなら SQLite の WASM の ADR）と、Aurora の reader での 10 秒の `REPEATABLE READ` の読み取り（`bootstrap-poc`）、全体と部分の閾値（`bootstrap-kind-threshold`）。
  - E6 の前：IME のイベントの順序と `Process` のキー（`ime-shortcut-poc`）。
  - E8 の前：OpenSearch の費用・索引の大きさ・p99（`search-poc`）。
- **規則は 1 つのコードに。** 競合の規則・`applyOp`・`derive`・検証はスキーマの定義から生成した共有のパッケージ、権限は `packages/policy`、フィルターは `packages/filter` にだけ書く。同期の意味（競合の規則、同期グループの規則、トランザクションの形）はフラグにせず、スキーマのバージョンで変える（[ADR-0056](decisions/0056-flags-client-distribution-and-min-build.md)）。
- **契約を先に固定する。** スキーマの定義（`packages/schema`）、Gateway のプロトコル、ブートストラップのストリームの形、`sync_actions` の形、権限の決定表は、人間がレビューして確定する。エージェントは勝手に変えない。破壊の変更は広げる・移る・縮める・消すの順（[ADR-0057](decisions/0057-schema-change-ordering.md)）で、Dev のテックリードの承認を要する。
- **法務の確認待ちの Story は、spec を承認しない。** 設計と、法務に依らない Story は進めてよい（[intent.md](intent.md) の「法務の確認待ち」L1〜L8）。下の表で「法務：L*」と書いた Story が当たる。
- **1 変更 1 PR を目安に、差分を小さくする。** Gateway の入れ替えは 1 タスクずつ逃がし、Web と Electron は端末の桶で段階的に出す（[delivery.md](architecture/delivery.md) の 4〜6 節）。

## Epic

PM が持つ。変更の一覧はここに書かず、各変更の `spec.md` の frontmatter（`epic`）から集計する（[process.md](../../../docs/process.md) の「粒度」）。各 Epic の品質の重点と合否基準は [quality.md](quality.md) の 5 節にある。

| Epic | 目的 | 状態 |
| --- | --- | --- |
| E1 基盤 | AWS・Terraform・CI（遅延の予算の固定の機械、シミュレーター、オフラインの 3 つの場面、生成とマイグレーションの検査の枠）、Aurora と RLS、スキーマの定義と生成、フラグとクライアントの配布、可観測性（RUM を含む）、監査ログ、大阪の骨格 | 設計中 |
| E2 同期エンジンの核 | トランザクション、Writer（検証・適用・`sync_id`・冪等・枠）、`sync_actions`、Relay、Gateway（範囲の証明、握手、圧縮）、取り戻し、載せ直し、競合の規則、分数インデックスの鍵、上書きの記録、決定的なシミュレーター、伝播の計測 | 未着手（前に書き込みの上限とメモリーの PoC） |
| E3 ブートストラップとオフライン | 全体・部分・手元から・やり直しのブートストラップ、遅延の読み込みと被覆、墓標、同期グループの参加・脱退・移動、ログの保持、IndexedDB と outbox、複数のタブ、手元の移行、保存の上限と消去、オフラインの表示と再送の試験 | 未着手（前に IndexedDB と reader の PoC。ログの保持の確定は法務：L5） |
| E4 アカウントと権限 | 認証（Better Auth）、セッションと同期のチケット、招待、ワークスペースの行と設定、ロール、チーム、非公開のチーム、`can()`、購読の監査、遠隔の消去、狭める操作の記録 | 未着手 |
| E5 イシューとワークフロー | 状態、優先度、ラベル、見積もり、親子と関連、重複、Triage、ゴミ箱、履歴、定期処理、本文の同時編集（Yjs）、コメント、メンション、添付、番号と識別子 | 未着手（前に知らないノードの PoC。コメントの公開は法務：L2） |
| E6 キーボード中心の画面とデスクトップ | 画面の骨格、入力の経路、一覧とボードの仮想化、Action とショートカット、コマンドメニュー、IME、Undo、Service Worker、Electron（シェル、ディープリンク、自動更新）、遅延の予算の達成 | 未着手（前に IME の PoC。ショートカットと画面の寄せ方は法務：L8） |
| E7 サイクル、プロジェクト、イニシアチブ | サイクルの行と繰り越し、プロジェクトとチームのつながり、マイルストーン、更新と催促、イニシアチブ、進捗の集計 | 未着手 |
| E8 ビュー・フィルター・検索 | フィルターの言語と共有の評価、SQL の生成、ビューの計画と問い合わせ、保存したビュー、OpenSearch の検索と権限 | 未着手（前に検索の PoC） |
| E9 通知とインボックス | 通知係、インボックス、既読とスヌーズ、購読、設定、デスクトップの通知、メール、Urgent、権限の後始末 | 未着手（メールは法務：L1、通知の公開は法務：L2） |
| E10 連携 | GitHub・GitLab の結び付けと状態の自動化、Slack のインストール・メッセージからの作成・チャンネルへの通知・リンクの展開・個人への通知、連携の資格情報 | 未着手（Slack は法務：L1） |
| E11 公開 API、Webhook、インポートと書き出し | GraphQL、API キーと OAuth、Webhook、インポート（Jira・GitHub Issues・Asana・Shortcut・CSV）、書き出し | 未着手（インポートの取り出しは法務：L3） |
| E12 本番の準備と GA の判定 | 負荷試験 L1〜L9、オフラインの耐久と障害の注入、DR のワークフローと訓練（`sync_epoch` と狭める操作のやり直し）、収束の監査、配信の監査、SLO とアラート、外部のペンテスト、データのライフサイクル、GA の判定 | 未着手（GA の判定は法務：L1・L4・L5・L7） |
| E13 ゲストとチームの拡張（MVP の後） | ゲストのロールの公開、チームのオーナー、サブチーム、イシューの個別の共有 | 未着手（MVP の後） |
| E14 Enterprise の認証と監査（MVP の後） | SAML・SCIM、監査ログの画面とストリーム、セッションの絶対の期限、細かな管理の設定 | 未着手（MVP の後） |
| E15 ロードマップとインサイト（MVP の後） | ロードマップの表示、集計とダッシュボード | 未着手（MVP の後） |
| E16 トリアージの自動化（MVP の後） | 振り分けの規則、提案 | 未着手（MVP の後） |
| E17 AI の機能（MVP の後） | 要約、重複の検出、振り分けの提案、エージェントへの委任、MCP のサーバー | 未着手（MVP の後。法務：L6） |
| E18 顧客の要望と SLA（MVP の後） | 外部の窓口との連携、期限の計算 | 未着手（MVP の後） |
| E19 モバイルのアプリ（MVP の後） | iOS・Android の手元の保存と同期のクライアント | 未着手（MVP の後） |

E1〜E12 が MVP（S1）。領域の文書の「Story の候補」は、この番号で書く。

## Story

各 Story は、着手するときに `changes/YYMMDD-<slug>/` として起票する。ここは計画で、進み具合は各変更の `spec.md` の frontmatter で見る。順序は Epic の中での目安で、依存があるものを先に置いた。各領域の文書の「Story の候補」から集めた。同じ中身の Story が 2 つの文書にあるものは 1 つにした（統合の工程で Epic が食い違っていた `electron-auto-update` は E6、`opensearch-domain` は E8 に揃えた）。

### E1 基盤

設計：[infrastructure.md](architecture/infrastructure.md)、[delivery.md](architecture/delivery.md)、[observability.md](architecture/observability.md)、[security.md](architecture/security.md)、[data-model-and-schema.md](architecture/data-model-and-schema.md)、[data-model.md](architecture/data-model.md)

| Story | 内容 |
| --- | --- |
| `dev-repo-bootstrap` | Linear の再構築の開発リポジトリを作り、`changes/`・`specs/`・開発向けの `AGENTS.md`、CODEOWNERS（`packages/schema`・`packages/policy`・`packages/sync-*` はテックリード）を置く（リポジトリ共通の ADR-0005） |
| `aws-accounts-and-scp` | アカウントと SCP（[infrastructure.md](architecture/infrastructure.md) の 1 節）。データの所在の約束は法務：L4 |
| `vpc-and-subnets` | VPC（egress を含む）、Network Firewall、VPC エンドポイント（同 2.1 節） |
| `edge-and-websocket-origin` | CloudFront の配信、WebSocket のオリジンのリクエストポリシー（`Sec-WebSocket-Extensions` を含む）、ALB の時間切れ、WAF（同 2.2 節） |
| `ecs-services-skeleton` | サービス、Service Connect、タスクのロール（同 3 節） |
| `terraform-root-modules` | ルートモジュールとポリシー検査（同 7.2 節） |
| `kms-keys-and-envelope` | KMS の鍵と `packages/envelope`（[security.md](architecture/security.md) の 5.2 節） |
| `rls-migration-guard` | RLS の検査、RLS の外の表と関数の許可リスト（[data-model.md](architecture/data-model.md) の 5 節） |
| `schema-dsl` | 定義の言語と、型・`conflict` の組み合わせの検査（[data-model-and-schema.md](architecture/data-model-and-schema.md) の 3 節） |
| `schema-conflict-kinds` | `conflict`・`order_scope`・`track_overwrites`・`groups` の必須化（sync-engine と共同） |
| `schema-load-strategy` | `load`・`condition`・`include`・被覆の鍵の生成（bootstrap-and-partial-sync と共同） |
| `schema-group-rules-ext` | `workspace_members`・`team_row`・`view_scope` の規則、`teams` を結び付けのモデルから読む形、`guest_visible`・`derive_only`・`import_writable` の検査（permissions-and-teams・cycles-and-projects・views-and-filters の Story の候補をまとめた） |
| `codegen-db-desired-state` | DB の望む形、RLS のポリシー、マイグレーションの差分の検査 |
| `codegen-model-package` | `packages/model`（型、Zod、`applyOp`、`groupsOf`、`via` の逆向きの表） |
| `codegen-client-layout` | IndexedDB の構成、M2 の列、`schema_version`・`schema_hash` |
| `client-schema-version-check` | `schema_version` の上げ忘れを CI で失敗させる（[client-store-and-offline.md](architecture/client-store-and-offline.md)） |
| `schema-change-classifier` | 変更の分類と、破壊の変更の CI の検査 |
| `ci-pipeline-baseline` | PR の関門、パスでの関門の追加、テストの緩和の検出（[delivery.md](architecture/delivery.md) の 2.1 節） |
| `latency-bench-harness` | 固定の機械のランナー、較正、合成のワークスペース（イシュー 50 万件）、判定（client-app と共同） |
| `flags-appconfig-and-client` | `release.*`・`ops.*`・クライアントのフラグ（delivery.md の 3 節） |
| `web-cohort-rollout` | CloudFront Functions と KeyValueStore の段階の切り替え（同 5 節） |
| `otel-baseline` | ADOT、AMP、X-Ray、ログの形、中身を出さない規則と走査（[observability.md](architecture/observability.md) の 2 節） |
| `rum-latency-marks` | 遅延の印、Event Timing、RUM の口と端末の集め方（client-app と共同） |
| `audit-log-table-and-archive` | `audit_events`、log-archive への写しとハッシュの連鎖（security.md の 6 節） |
| `csp-and-security-headers` | CSP、Trusted Types、HSTS、添付の別のドメイン |
| `osaka-warm-standby` | 大阪の骨格、Global Database、待機の構成の確認（infrastructure.md の 5・6.5 節） |

### E2 同期エンジンの核

設計：[sync-engine.md](architecture/sync-engine.md)、[capacity.md](architecture/capacity.md) の 2・3 節、[observability.md](architecture/observability.md) の 3・6 節、[ADR-0006](decisions/0006-transactions-writer-and-idempotency.md)〜[ADR-0010](decisions/0010-deterministic-sync-simulator.md)、[ADR-0054](decisions/0054-per-workspace-write-admission.md)

| Story | 内容 |
| --- | --- |
| `writer-throughput-poc` | PoC：1 ワークスペース 1 秒 300 変更、ロックの待ちの p99、送信から ack の p99（capacity.md の 2.1 節） |
| `memory-tiers-poc` | PoC：M1・M2・M3 と、反応型のストア（MobX か自前か）の選定の計測（client-store-and-offline.md の 7 節） |
| `uuidv7-validation` | UUIDv7 の検証（data-model-and-schema.md の 5.1 節） |
| `object-pool-two-layer` | プール、`confirmed`・`pendingByModel`・`view`、`applyOp` の共有 |
| `tx-format-and-lifecycle` | トランザクションの形と状態、一括の編集の分割 |
| `writer-commit-path` | 1 回の書き込みの手順、ロック、savepoint、`sync_outbox`（`committed_at`）、`retry` |
| `writer-validation-table` | 検証の決定表と表駆動テスト |
| `tx-results-idempotency` | `tx_results`、再送に前の結果、90 日のパーティション |
| `writer-admission-buckets` | `origin` ごとの枠と混雑の制御（ADR-0054） |
| `sync-actions-log` | `sync_actions` の表、日ごとのパーティション、`(workspace_id, model, model_id, sync_id)` の索引 |
| `relay-workspace-publish` | Relay と Valkey のワークスペースのチャンネル |
| `relay-partition-lease` | Relay の区画と担当（infrastructure.md の 3.2 節） |
| `gateway-range-proof` | 絞り込み、範囲の証明、欠けの埋め、`evict` |
| `gateway-shared-serialization` | 同じ `groups` の接続の間の直列化の使い回し（capacity.md の 3.2 節） |
| `gateway-protocol-handshake` | メッセージ、チケット、握手の決定表 |
| `gateway-permessage-deflate` | 差分の流れの圧縮（窓 4 KiB）、`ops.ws_deflate`（sync-engine.md の 9.1 節） |
| `client-gap-detection` | 欠けの判定、取り戻し、持つパケットの上限 |
| `sync-api-deltas` | 取り戻しの API |
| `rebase-and-ack` | 載せ直しの規則、ちらつきの防止、`server_ops` |
| `fractional-keys` | 分数インデックスの鍵、乱数の接頭辞、重なりと窓の振り直し、Worker の全体の振り直し |
| `overwrite-record` | `field_sync_ids`、履歴への記録、本人への通知 |
| `sync-simulator` | シミュレーターと PROP-SYNC-001〜010、回帰の種の保存 |
| `sim-in-ci` | シミュレーターの PR（2,000 の列）・夜間（20 万の列）の関門（delivery.md） |
| `propagation-timestamps` | `committed_at`、`c` の運び、`pong` の時刻、区間のヒストグラム（observability.md の 3.3 節） |
| `synthetic-sync-clients` | 伝播の合成監視（同 6 節） |

### E3 ブートストラップとオフライン

設計：[bootstrap-and-partial-sync.md](architecture/bootstrap-and-partial-sync.md)、[client-store-and-offline.md](architecture/client-store-and-offline.md)、[ADR-0011](decisions/0011-bootstrap-stream-and-chunked-snapshots.md)〜[ADR-0016](decisions/0016-memory-tiers-quota-and-offline-ux.md)

| Story | 内容 |
| --- | --- |
| `bootstrap-poc` | PoC：基準の端末での IndexedDB の一括の書き込みと部分のブートストラップの時間（p95 10 秒）、Aurora の reader での 10 秒の `REPEATABLE READ` の読み取り（bootstrap-and-partial-sync.md の 4.3・4.7 節）。E3 の前 |
| `idb-layout` | データベース・store（`_doc_state`・`_doc_updates`・`_drafts` を含む）・索引・行の形と、登録 |
| `idb-write-paths` | 書き込みの経路と `durability`、保存してから当てる順 |
| `outbox-store` | outbox の行・状態・上限・送信、`done` の 15 分 |
| `offline-attachments` | `_blobs` と上げの順序 |
| `client-db-migration` | 移行の手順、`_meta.migration` の再開、`blocked` の扱い |
| `outbox-upcast` | outbox の変換と、変換の関数の保持（180 日） |
| `multi-tab-leader` | 書き手の選出、凍結での降り方、`steal` |
| `multi-tab-broadcast` | タブの間の通知と取りこぼし |
| `bootstrap-stream-api` | ブートストラップの API、チャンクの境、チャンクごとの写し |
| `bootstrap-client-writer` | ブートストラップの書き込み、`_meta.bootstrap` の状態、画面を先に出す |
| `bootstrap-resume` | 再開と `409 restart` |
| `bootstrap-kind-threshold` | 全体と部分の切り替え、`workspace_stats`（閾値は PoC で） |
| `local-bootstrap` | 手元からの起動と時間の予算（p95 1.5 秒） |
| `lazy-load-api` | 遅延の読み込みの API、まとめ、ページング、`min_sync_id` |
| `partial-index-coverage` | 被覆の鍵と突き合わせ |
| `tombstones` | 墓標と 15 分の規則 |
| `sync-subscriptions` | 購読の表、Writer での計算、Gateway の購読の変化 |
| `group-join-bootstrap` | グループへの参加 |
| `group-leave-purge` | 脱退の消去（握手での差を含む） |
| `cross-group-move` | グループをまたぐ移動と依存の行、Worker の続き |
| `sync-log-retention` | 保持のジョブと `floor`。**30 日の確定は法務：L5** |
| `reset-bootstrap` | やり直しと、outbox を残す手順 |
| `stale-outbox-review` | 90 日を超えた outbox の確認の画面 |
| `gateway-heartbeat-backoff` | 心拍、背圧、再接続の待ち（sync-engine.md の 9.6 節） |
| `gateway-hello-admission` | `hello` の受け付けの上限（capacity.md の 3.3 節） |
| `storage-quota-watch` | `persist`・`estimate`・退かし・読み取りの専用 |
| `lost-local-notice` | 端末の ID と、失った件数の知らせ |
| `offline-status-ui` | オフラインの表示と `_rejected` の一覧（client-app と共同） |
| `device-wipe-on-logout` | ログアウト・除外の消去の試験（security.md の 4.3 節） |
| `client-storage-telemetry` | outbox・保存・やり直しの RUM（observability.md） |
| `offline-replay-tests` | オフラインの 3 つの場面の Playwright の試験 |
| `offline-scenarios-ci` | オフラインの 3 つの場面を必須の関門に（delivery.md） |
| `bootstrap-sim-props` | PROP-BOOT-001〜006 |
| `store-sim-props` | PROP-STORE-001〜006 |

### E4 アカウントと権限

設計：[accounts-and-auth.md](architecture/accounts-and-auth.md)、[permissions-and-teams.md](architecture/permissions-and-teams.md)、[security.md](architecture/security.md) の 4 節、[ADR-0032](decisions/0032-single-policy-module-and-group-mapping.md)〜[ADR-0035](decisions/0035-sessions-and-sync-ticket.md)、[ADR-0058](decisions/0058-dr-permission-narrowing-journal.md)

| Story | 内容 |
| --- | --- |
| `auth-service-skeleton` | 認証のサービス、Better Auth、`auth` スキーマ、`packages/auth` の包み |
| `login-email-otp` | メールのコードとリンク、流量の制限 |
| `login-google` | Google と DT-AUTH-001 |
| `login-passkey` | パスキー |
| `sessions-and-multi-account` | クッキー、期限、ログアウト、セッションの一覧と取り消し |
| `workspace-model-and-settings` | `Workspace`・`WorkspaceSettings`、`resolve_workspace_slug`、作成の流れ（permissions-and-teams.md の 3.3 節） |
| `workspace-directory` | 入り口の表と、ワークスペースの選択の画面 |
| `sync-ticket` | チケットの発行と消費、DT-AUTH-002（sync-engine と共同） |
| `revocation-propagation` | Gateway への知らせと 5 分の確かめ |
| `electron-login` | システムのブラウザでのログインとコードの交換（client-app と共同） |
| `policy-module` | `packages/policy`、`can()`・`groupsFor`・範囲の重ね方、lint |
| `workspace-roles` | ロールと DT-PERM-002 |
| `team-model-and-membership` | `Team`・`TeamMembership`、参加・脱退 |
| `team-key` | チームの識別子と `team_key_aliases`（data-model-and-schema と共同） |
| `private-teams` | 非公開のチーム、DT-PERM-001 の行 3・4、管理者の参加と監査 |
| `team-privacy-toggle` | 非公開への切り替えと DT-PERM-004、同期の側（bootstrap-and-partial-sync.md の 7.8 節）を含む |
| `role-change-and-suspend` | ロールの変更と停止・戻し |
| `workspace-removal-purge` | ワークスペースからの除外と手元の消去（bootstrap-and-partial-sync.md の 7.6 節） |
| `invitations` | 招待と DT-AUTH-003 |
| `invite-link-and-domains` | 招待のリンク、許可したドメインと DNS の確認 |
| `workspace-login-methods` | ワークスペースのログインの制限 |
| `account-email-change-and-delete` | メールアドレスの変更とアカウントの削除 |
| `remote-wipe` | 遠隔の消去、`401 wipe_required`（security と共同） |
| `shared-device-mode` | 「この端末に保存しない」の入り方 |
| `narrowing-journal` | 権限を狭める操作の `narrowing_outbox` と DynamoDB の `narrowing_journal`、Relay の送り直し（ADR-0058。infrastructure と共同） |
| `subscription-audit` | 購読の監査のジョブ（`subscription_drift`） |
| `policy-decision-tables` | DT-PERM-001〜004 の表駆動テスト、PROP-PERM-001 |
| `permission-sim-props` | PROP-PERM-002〜004 |

### E5 イシューとワークフロー

設計：[issues-and-workflow.md](architecture/issues-and-workflow.md)、[editor-and-descriptions.md](architecture/editor-and-descriptions.md)、[data-model-and-schema.md](architecture/data-model-and-schema.md) の 5 節、[ADR-0020](decisions/0020-ids-and-human-identifiers.md)〜[ADR-0025](decisions/0025-derived-changes-in-writer.md)

| Story | 内容 |
| --- | --- |
| `doc-schema-compat` | 本文のスキーマの追加の手順（読めるバージョン → `min_build` → 作成のフラグ）と試験（editor-and-descriptions.md の 3.2 節。y-prosemirror が知らないノードを消すことは 2026-09-28 に確かめた） |
| `workflow-states` | 状態、種類、最低の数、Duplicate の自動の作成 |
| `state-timestamps-derive` | DT-ISSUE-001 と派生の仕組み（ADR-0025） |
| `issue-core-fields` | フィールド、優先度、担当、購読の派生 |
| `issue-numbering` | 番号と、ack の `server_ops` での受け取り、仮の表示 |
| `labels-and-groups` | ラベル、グループの排他、アーカイブ、消去のジョブ |
| `estimates` | 見積もりの尺度と検証 |
| `sub-issues` | 親子、深さ、並び |
| `issue-relations` | 関連と正規化 |
| `duplicates` | 重複、連鎖、解除 |
| `triage-intake` | Triage の入り口（DT-ISSUE-002。`import` の行を含む）と操作 |
| `archive-and-trash` | アーカイブとゴミ箱（DT-ISSUE-003）、戻し |
| `issue-team-move` | チームの移動の派生と、別名・`resolve`・URL の転送（data-model-and-schema.md の 5.4 節を含む） |
| `auto-close-parent-sub` | 親子の自動で閉じる（DT-ISSUE-004） |
| `state-delete-migration` | 状態の削除とイシューの移しのジョブ |
| `issue-history` | 履歴と、活動の表示の元（client-app と共同） |
| `issue-templates-drafts` | テンプレートと下書き |
| `lifecycle-jobs` | 自動で閉じる・アーカイブ・ゴミ箱の消去（`worker` の枠、開始の時刻の散らし） |
| `issue-sim-props` | PROP-ISSUE-001〜007 |
| `doc-package` | `packages/doc`（Yjs と y-prosemirror を閉じる API） |
| `description-editor` | エディタのスキーマ、入力の補助、貼り付け、Undo |
| `description-append-sync` | 本文の送り方と Writer の検証 |
| `doc-compaction-worker` | まとめ、テキストの抜き出し、保持のジョブとの連携 |
| `description-lazy-load` | 本文の読み込み（読んだ時点までを合わせる） |
| `doc-local-store` | `_doc_state`・`_doc_updates`、拒否の作り直し（client-store-and-offline と共同） |
| `description-versions` | 本文のバージョン、戻し、管理者のバージョンの削除 |
| `comments-and-threads` | コメント、スレッド、解決、削除。**公開は法務：L2** |
| `reactions` | リアクション |
| `mentions` | メンションの候補、描画、コメントの派生、本文の Worker の抜き出し |
| `inline-comments` | アンカー、装飾、外れた表示 |
| `attachments-upload` | 添付の上げ、`upload_ref`、Worker の確かめ |
| `attachments-serve` | 添付の配り、別のドメイン、署名付きの URL |
| `doc-sim-props` | PROP-DOC-001〜005 |

### E6 キーボード中心の画面とデスクトップ

設計：[client-app.md](architecture/client-app.md)、[delivery.md](architecture/delivery.md) の 6 節、[ADR-0017](decisions/0017-keymap-command-menu-and-ime.md)・[ADR-0018](decisions/0018-render-path-and-latency-budget.md)

| Story | 内容 |
| --- | --- |
| `ime-shortcut-poc` | PoC：OS × IME × ブラウザのイベントの順序、`Process` のキー（E6 の前） |
| `app-shell-and-routes` | 骨格、ルート、古い識別子の転送。**画面の寄せ方は法務：L8** |
| `input-path` | 入力の経路、描画の後の outbox のコミット |
| `action-registry-and-keymap` | Action の登録、範囲、2 打の列 |
| `ime-guard` | IME の規則（DT-APP-001・PROP-APP-001） |
| `ime-ci-tests` | IME の自動のテスト（delivery と共同） |
| `default-shortcuts` | 既定の割り当てと一覧のダイアログ。**法務：L8** |
| `command-menu` | 候補、照合（M2 の `identifier`・`title_norm`）、並べ方、サーバーの検索への渡し |
| `virtual-list` | 一覧、行ごとの購読、フォーカスの行 |
| `virtual-board` | ボード |
| `m2-index-views` | M2 の上での一覧・フィルター（views-and-filters・client-store-and-offline と共同） |
| `drag-reorder` | 並べ替えとキーの代わり |
| `bulk-actions` | 一括の操作の分けた当て方 |
| `app-undo` | Undo |
| `triage-view-shortcuts` | Triage の一覧と `1`・`2`・`3`・`H`（issues-and-workflow と共同）。**法務：L8** |
| `view-latency-bench` | ビューのベンチマーク（views-and-filters と共同） |
| `latency-budget-gate` | 遅延の全場面を E6 のリリースの基準に |
| `service-worker-shell` | Service Worker の殻 |
| `electron-shell` | Electron の設定、preload、IPC の確かめ、複数のウィンドウ |
| `electron-deep-links` | ディープリンク |
| `electron-crash-reporting-off` | ミニダンプを外へ送らない（security.md の 4.4 節） |
| `electron-auto-update` | 更新の案内、端末の桶での段階、署名（delivery と共同） |

### E7 サイクル、プロジェクト、イニシアチブ

設計：[cycles-and-projects.md](architecture/cycles-and-projects.md)、[ADR-0026](decisions/0026-cycle-rows-and-rollover.md)・[ADR-0027](decisions/0027-progress-stats-per-team-via-derive.md)

| Story | 内容 |
| --- | --- |
| `cycle-settings` | サイクルの設定と権限 |
| `cycle-bounds` | `cycleBounds` とタイムゾーンの例示テスト |
| `cycle-scheduler` | 先のサイクルの作成と設定の変更（DT-CYCLE-003） |
| `cycle-rollover` | 繰り越し（DT-CYCLE-001）、PROP-CYCLE-002・003 |
| `cycle-assignment-rules` | 割り当ての検証と自動の追加（DT-CYCLE-002） |
| `cycle-snapshot-and-graph` | 完了の写しと、容量の表示（client-app と共同） |
| `project-model` | プロジェクト、状態、時刻の派生 |
| `project-teams` | `ProjectTeam`、グループの移動（DT-PROJ-002） |
| `issue-project-milestone` | イシューとプロジェクト・マイルストーン（DT-PROJ-001） |
| `progress-stats-derive` | 進捗の数え方と派生、PROP-PROG-001・003 |
| `progress-points-and-prediction` | 日ごとの点と予測 |
| `progress-reconcile` | 数え直しと差分テスト |
| `project-updates` | 更新と健康状態の派生 |
| `project-update-reminders` | 催促（notifications-and-inbox と共同） |
| `project-update-notifications` | DT-NOTIF-001 の更新の行（notifications-and-inbox と共同） |
| `initiatives` | イニシアチブ、入れ子、つながり |
| `cycles-projects-privacy-props` | PROP-PROG-002 と、つながりの漏れの試験（permissions-and-teams と共同） |

### E8 ビュー・フィルター・検索

設計：[views-and-filters.md](architecture/views-and-filters.md)、[search.md](architecture/search.md)、[ADR-0028](decisions/0028-filter-language-and-shared-evaluation.md)〜[ADR-0031](decisions/0031-search-permission-by-sync-groups.md)

| Story | 内容 |
| --- | --- |
| `search-poc` | PoC：索引の大きさ、p99、費用（OpenSearch の決定を確かめる） |
| `filter-ast-and-validation` | 文法、型の検査、正準の形、上限 |
| `filter-null-semantics` | 空の値（DT-FILTER-001）、共有のテストの例の集まりの枠 |
| `filter-resolve` | 動的な値の解決 |
| `filter-eval-m2` | クライアントの評価と増分 |
| `filter-sql-codegen` | SQL の生成と PROP-VIEW-001 の差分テスト |
| `ordering-codepoint` | 並べ方（DT-FILTER-002）、`cmpCodepoint` と lint |
| `grouping-and-board` | グループ化とボードの移動（DT-VIEW-002。client-app と共同） |
| `view-planner` | ビューの計画（DT-VIEW-001）、PROP-VIEW-003 |
| `sync-query-endpoint` | `POST /sync/query`、PROP-VIEW-004 |
| `view-hybrid-merge` | 手元とサーバーの組み合わせ、PROP-VIEW-005 |
| `saved-views` | `View`・`ViewPreference`、範囲とグループ |
| `view-reference-scope` | 参照の範囲（DT-VIEW-003） |
| `view-url-share` | URL と共有 |
| `opensearch-domain` | OpenSearch のドメイン、VPC、IAM、スナップショットの大阪への写し（infrastructure と共同） |
| `search-index-mapping` | 索引、フィールド、アナライザー、正規化 |
| `search-indexer` | 索引の Worker、外部のバージョン、墓標 |
| `search-query-and-rehydrate` | `buildSearchRequest`、読み直し、抜粋、PROP-SEARCH-001・002 |
| `search-api` | 検索の API、識別子の解決、上限 |
| `search-local-merge` | 手元とサーバーの組み合わせ（client-app と共同） |
| `search-reconcile` | 数え直し、作り直し、PROP-SEARCH-003 |
| `search-lag-ux` | 遅れの計測と表示、縮退 |

### E9 通知とインボックス

設計：[notifications-and-inbox.md](architecture/notifications-and-inbox.md)、[ADR-0036](decisions/0036-notifications-derived-by-notifier.md)・[ADR-0037](decisions/0037-notification-delivery-channels.md)

| Story | 内容 |
| --- | --- |
| `notifier-worker` | 通知係、生成、冪等の鍵、PROP-NOTIF-001。`notifier` の枠と受け手ごとの 5 秒のまとめ（[notifications-and-inbox.md](architecture/notifications-and-inbox.md) の 5.5 節、[ADR-0054](decisions/0054-per-workspace-write-admission.md)） |
| `notification-model-and-inbox` | `Notification`・`InboxState`、インボックスの画面（client-app と共同）。**公開は法務：L2** |
| `read-snooze-delete` | 既読、スヌーズ、削除、PROP-NOTIF-003 |
| `issue-reminders` | 後で知らせる |
| `notification-subscriptions` | `NotificationSubscription` と派生 |
| `notification-preferences` | 通知の設定 |
| `notification-access-sweep` | 権限の後始末、PROP-NOTIF-002（permissions-and-teams と共同） |
| `mention-notifications` | メンションの通知の事象（editor-and-descriptions と共同） |
| `desktop-notifications` | デスクトップの通知（client-app と共同） |
| `urgent-handling` | Urgent の扱い |
| `email-digest` | メールの待ちとまとめ（DT-NOTIF-002）、PROP-NOTIF-004。**法務：L1・L2** |

### E10 連携

設計：[integrations.md](architecture/integrations.md)、[ADR-0038](decisions/0038-git-hosting-linking-and-state-automation.md)〜[ADR-0040](decisions/0040-integration-installations-and-credential-storage.md)

| Story | 内容 |
| --- | --- |
| `integrations-ingress` | 受け口、署名の検査、`integration_events`、FIFO への投入 |
| `integration-credentials` | `integration_secrets`、KMS の鍵、トークンの更新 |
| `github-app-install` | GitHub のインストールと確かめ。**外国への提供の扱いは法務：L1** |
| `gitlab-install` | GitLab のトークンと Webhook の署名の鍵、egress の経路。**法務：L1** |
| `git-link-parser` | 結び付けの規則（DT-INT-001）と `resolve` |
| `git-link-model` | `GitLink` と被覆の鍵 |
| `git-state-automation` | 状態の自動化の設定、DT-INT-002・003、履歴 |
| `git-link-comment` | PR への返しのコメント |
| `external-account-link` | 利用者の外部のアカウントの結び付け |
| `git-resync` | 失敗した配送の再送と読み直し |
| `slack-install` | Slack のインストールとトークンの入れ替え。**法務：L1** |
| `slack-create-issue` | メッセージからの作成。**法務：L1** |
| `slack-channel-notifications` | チャンネルへの通知（公開のチームだけ）。**法務：L1** |
| `slack-unfurl` | リンクの展開（公開のチームだけ）。**法務：L1** |
| `slack-personal-notifications` | 個人への通知の口と送り（notifications-and-inbox.md の同名の Story と integrations.md の 5.5 節を含む）。**法務：L1** |

### E11 公開 API、Webhook、インポートと書き出し

設計：[api-and-webhooks.md](architecture/api-and-webhooks.md)、[import-export.md](architecture/import-export.md)、[ADR-0041](decisions/0041-public-graphql-generated-schema-and-writer-mutations.md)〜[ADR-0045](decisions/0045-export-by-permission-to-private-download.md)

| Story | 内容 |
| --- | --- |
| `codegen-graphql-types` | GraphQL の型の生成（data-model-and-schema と共同） |
| `graphql-endpoint` | 入口、`packages/query` の読み出し、DataLoader |
| `api-filter-input` | フィルターの木を入力の型に写す（views-and-filters と共同） |
| `graphql-mutations-writer` | mutation、冪等、本文の `append`、拒否の写し |
| `api-complexity-rate-limit` | 複雑さ、枠、ヘッダー |
| `api-keys` | API キー、シークレットスキャンの口 |
| `oauth-apps` | OAuth のアプリ、`oauth_app_public` |
| `webhook-model-and-rules` | Webhook と DT-HOOK-001 |
| `webhook-fanout-and-send` | 振り分け、egress の経路、再試行、停止 |
| `webhook-delivery-log` | 送りの記録と手の再送 |
| `api-deprecation-tracking` | 廃止の利用の数え |
| `public-sdk` | SDL から公式の SDK を生成（TypeScript） |
| `import-job-model` | `ImportJob`、状態、`import_secrets`、段置き |
| `import-mapping-ui` | 対応付けと試しの実行の件数の表 |
| `import-commit-throttled` | 束、`import` の枠、自動の調整、ID の作り方、DT-IMPORT-002 |
| `import-csv` | CSV の 2 つの形、文字コードの判定 |
| `import-adapter-jira` | Jira Cloud の取り出しと正規化。**法務：L3** |
| `import-adapter-github` | GitHub Issues。**法務：L3** |
| `import-adapter-asana` | Asana。**法務：L3** |
| `import-adapter-shortcut` | Shortcut。**法務：L3** |
| `import-attachments` | 添付の取り出しと `ready` |
| `import-undo` | 取り消し（7 日、人が触れていない行だけ） |
| `import-acceptance-k8` | K8 の受け入れ試験（合成の Jira のイシュー 1 万件を 30 分以内、対応付けの誤り 0。[quality.md](quality.md) の 2.2.1 節） |
| `export-csv` | CSV の書き出し、式の注入の対策 |
| `export-workspace-json` | ワークスペースの JSON の書き出し |

### E12 本番の準備と GA の判定

設計：[capacity.md](architecture/capacity.md) の 8 節、[infrastructure.md](architecture/infrastructure.md) の 6 節、[observability.md](architecture/observability.md) の 4・5 節、[security.md](architecture/security.md) の 9・10 節、[ADR-0050](decisions/0050-disaster-recovery-and-sync-epoch-bump.md)、[ADR-0053](decisions/0053-convergence-audit.md)、[ADR-0058](decisions/0058-dr-permission-narrowing-journal.md)

| Story | 内容 |
| --- | --- |
| `sync-load-client` | 同期のクライアントの模擬（`packages/sync-client` をヘッドレスで） |
| `load-tests-l1-l9` | 負荷試験 L1〜L9 |
| `bootstrap-load-test` | 最大のワークスペースの部分のブートストラップと、やり直しの殺到 |
| `rollover-load-test` | 全チームの繰り越しが重なる負荷 |
| `notification-load-test` | 繰り越し・一括の編集・大きな購読者での通知係の負荷。`notifier` の枠と受け手ごとのまとめ（notifications-and-inbox.md の 5.5 節） |
| `offline-endurance` | 7 日のオフラインの耐久試験 |
| `sync-fault-injection` | 障害注入（Writer・Aurora・Valkey・Relay・Gateway・reader） |
| `schema-compat-drill` | 1 つ前のバージョンのクライアントとの往復の試験をリリースの前の必須に |
| `schema-expand-contract-tooling` | 広げる・縮めるの段の確かめ（古い `schema_hash` の接続の数、`fv` の報告） |
| `min-build-enforcement` | `min_build` の殻とレンダラーの組の比べ |
| `sync-epoch-dr` | `sync_epoch` と、直近の確定の送り直し |
| `epoch-reset-spread-flag` | `ops.epoch_reset_spread_min` |
| `dr-failover-workflow` | 昇格のワークフロー（書き込みの停止、昇格、`sync_epoch`、狭める操作のやり直し、構成の広げ、入口の切り替え） |
| `dr-narrowing-replay` | 狭める操作のやり直しのジョブと `ops.dr_replay_mode`、PROP-DR-001 |
| `dr-drill` | DR の訓練（staging 四半期、本番の switchover 年 1 回） |
| `workspace-pitr-restore` | ワークスペースの戻し |
| `convergence-audit` | 収束の監査（K5） |
| `delivery-audit` | 配信の監査の抜き取り（K7） |
| `slo-dashboards-alerts` | SLI、ダッシュボード、アラート、runbook の URL の検査 |
| `runbooks-e12` | [runbooks/README.md](runbooks/README.md) の 4 節の「E12 で作成」の手順がそろっていることの確かめ |
| `retention-jobs` | 保持のジョブ（パーティションの落とし） |
| `workspace-deletion-job` | ワークスペースの削除のジョブ |
| `account-deletion-pseudonymize` | アカウントの削除と仮名 |
| `support-access-grants` | サポートの参照の許し |
| `attachment-storage-lifecycle` | 添付の消去、`pending` のライフサイクル |
| `cost-baseline` | 費用の確定、データ転送と permessage-deflate の圧縮の率 |
| `privacy-pentest-scope`・`auth-pentest-scope`・`search-privacy-synthetic` | 外部のペンテストの範囲（非公開のチームの全部の経路、認証、検索）と、検索の漏れの合成監視 |
| `external-pentest` | 外部のペンテスト |
| `ga-readiness-review` | GA の判定（[quality.md](quality.md) の 5 節の E12 の行。法務：L1・L4・L5・L7） |

### E13〜E19（MVP の後）

Story は、着手するときに `intent.md` から起票する。領域の文書にある候補は次のとおり。

| Epic | Story の候補 |
| --- | --- |
| E13 ゲストとチームの拡張 | `guests`（ゲストのロールの公開、招き方。permissions-and-teams.md の 6 節）、`team-owner-role`、`sub-teams`、イシューの個別の共有 |
| E14 Enterprise の認証と監査 | `saml-sso`、`scim`（accounts-and-auth.md の 9 節）、監査ログの画面とストリーム（security.md の 6 節）、セッションの絶対の期限（accounts-and-auth.md の 6.2 節）、MDM での端末の条件 |
| E15 ロードマップとインサイト | 同期したデータの上の読み出しの機能（intent.md） |
| E16 トリアージの自動化 | 規則のエンジン、振り分けの提案 |
| E17 AI の機能 | 要約、重複の検出、振り分けの提案、エージェントへの委任（`actor=app`・client credentials。api-and-webhooks.md の 6.3 節）、MCP のサーバー。法務：L6 |
| E18 顧客の要望と SLA | 外部の窓口との連携、期限の計算 |
| E19 モバイルのアプリ | ネイティブかクロスプラットフォームの同期のクライアント |

## エージェントに任せないこと

- **契約（スキーマの定義、Gateway のプロトコル、ブートストラップのストリームの形、`sync_actions` の形、権限の決定表、公開 API の形）の確定**：クライアントに配った後や、ログに書いた後に変えるコストが最も高い。
- **遅延の予算・シミュレーターの回数・較正の基準の変更**：値は QA が決め、Dev が承認する。
- **破壊のスキーマの変更、手元の DB のバージョンの引き上げ、`min_build` の引き上げ、`groups` の規則の変更**：Dev のテックリードと Ops が判断する。
- **大阪への切り替えの判断、`sync_epoch` の引き上げ、狭める操作のやり直しの結果の扱い**：IC と Ops の責任者（[runbooks/disaster-recovery.md](runbooks/disaster-recovery.md)）。
- **法務の判断**（L1〜L8）。
- **負荷試験・PoC の結果の解釈**：数字は出せるが、上限・閾値・退路（楽観的な検証、SQLite の WASM、`pg_bigm`）の採否は Dev と PM の判断。

## 延期の一覧

MVP の後に検討する。E13〜E19 に入れなかったもの。着手するときに `intent.md` から起票する（[intent.md](intent.md) の「MVP の後の Epic で扱う」と、各領域の文書の持ち越し）。

- **ドキュメント（プロジェクト・チームの文書）、外部からの受付、リリースの管理**（intent.md）。
- **Slack のスレッドの同期**（[integrations.md](architecture/integrations.md) の 5.6 節、[ADR-0039](decisions/0039-slack-app-issue-creation-and-channel-notifications.md)）、Slack の複数のワークスペース、非公開のチームのチャンネルへの通知。
- **コミット（push）の結び付け**、対象のブランチごとの規則（integrations.md の 12 節）。
- **本文のカーソルと在席の表示**、表と埋め込み（[editor-and-descriptions.md](architecture/editor-and-descriptions.md) の 14 節）。
- **プロジェクトの更新へのコメント、イニシアチブの更新、チームごとのプロジェクトの状態、イニシアチブのリードのチーム、イニシアチブの複数の親**（[cycles-and-projects.md](architecture/cycles-and-projects.md) の 12 節）。
- **コメントのスレッドだけの購読、一括の編集の通知のまとめ**（[notifications-and-inbox.md](architecture/notifications-and-inbox.md) の 13 節）。
- **利用者によるショートカットの割り当ての変更**（[client-app.md](architecture/client-app.md) の 5.2 節）。
- **スプリントをサイクルに写すこと、取り込みの後の差分の取り込み**（[import-export.md](architecture/import-export.md) の 12 節）。
- **遅延のモデル（コメント）と本文を収束の監査に入れること**、部分のブートストラップの端末の完全さの監査（[observability.md](architecture/observability.md) の 11 節）。
- **未送信の中身をサーバーに一時に預けて、ブラウザの消去から守ること**（[client-store-and-offline.md](architecture/client-store-and-offline.md) の 14 節）。
- **グループと `as_of` の組での写しのキャッシュ**（[bootstrap-and-partial-sync.md](architecture/bootstrap-and-partial-sync.md) の 13 節）。
- **S2 の構成**（ワークスペースのシャード、移動の方式の ADR、Gateway の接続のワークスペースでの寄せ、大口の専用の検索の索引。Story の候補：`workspace-sharding`、`workspace-move`）と **S3 のセル構成と海外のリージョン**（[infrastructure.md](architecture/infrastructure.md) の 10 節、[ADR-0051](decisions/0051-workspace-sharding-and-cells.md)）。

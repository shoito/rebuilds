# Roadmap: Notion

## 進め方の原則

- **最初に walking skeleton を通す。** E1 で、論理シャード・ルーター・ブロックの表・トランザクションとページの `seq`・最小の Web 表示を端から端まで貫いてから、機能を広げる。木の不変条件（T1〜T8）と RLS は、E1 から本物の形で作る。後から足すと、壊れたデータを直す作業になるため。
- **論理シャードは最初から 480。** 物理は 1 つのまま、ルーター・スキーマ・マイグレーションの群れを E1 で作る（[ADR-0003](decisions/0003-workspace-sharding.md)、[ADR-0027](decisions/0027-shard-router.md)、[ADR-0031](decisions/0031-migration-rollout-by-shard-groups.md)）。CI とローカルは 8 シャードで動かす。
- **権限を先に固める。** E2 で判定関数 `can()`・決定表・`acl_version` を作り、以後の Epic の中身を返す経路は、すべてこれを通す。経路を足す変更は、[quality.md](quality.md) の漏洩の行列に行を足す。
- **契約を先に固定する。** トランザクションの操作の形、WebSocket のイベント、リッチテキストのスパン（[ADR-0006](decisions/0006-rich-text-as-normalized-spans.md)）、公開 API の形とバージョン（[ADR-0024](decisions/0024-integration-access-model.md)）は、人間がレビューして確定する。エージェントは勝手に変えない。
- **PoC を先に行う。** E3 の前にエディタの計測（ADR-0007）、E4 の前に OPFS の各ブラウザでの確認（ADR-0008・0013）を行い、結果で設計を見直してから Story に入る。
- **1 変更 1 PR を目安に、差分を小さくする。** 並列に動くエージェントどうしが同じファイルを触らないよう、パッケージの境界（`packages/ops`、`packages/rich-text`、`packages/text-crdt`、`packages/shard-router`）で変更を切る。

## Epic

PM が持つ。変更の一覧はここに書かず、各変更の `spec.md` の frontmatter（`epic`）から集計する（[process.md](../../../docs/process.md) の「粒度」）。

| Epic | 目的 | 状態 |
| --- | --- | --- |
| E1 Walking skeleton | 開発と運用の基盤、論理シャードとルーター、ブロックの表と木の不変条件、トランザクションとページの `seq`、最小の Web 表示 | 設計中 |
| E2 権限と共有 | 認証、アカウントとメンバー、ゲスト、チームスペース、ページの権限と継承、決定表、`acl_version`、共有の画面、Web への公開、監査ログの記録 | 未着手 |
| E3 エディタ | ブロックの種類、ブロックごとの ProseMirror、スラッシュコマンド、Markdown、並べ替え、貼り付け、メンション、ファイル、埋め込み、同期ブロック、履歴とゴミ箱、巨大なページ | 未着手（PoC が前提） |
| E4 共同編集とオフライン | Relay と Sync Gateway、テキストの CRDT、構造とプロパティの規則、在席、端末の SQLite、オフライン、デスクトップアプリ | 未着手（OPFS の PoC が前提） |
| E5 データベース | データソースとプロパティ、問い合わせの索引、ビュー、フィルタ・並べ替え・グループ、リレーション、ロールアップ、数式 | 未着手 |
| E6 検索・コメント・通知 | OpenSearch の検索と権限キー、クイック検索、コメントとディスカッション、メンションの通知、リマインダー、受信箱、メール・push、ページの更新 | 未着手 |
| E7 API・連携・MCP | 公開 API とバージョン、連携とトークン、Webhook、リモートの MCP サーバー、インポートとエクスポート | 未着手 |
| E8 本番運用 | 負荷試験、SLO とアラート、災害復旧と訓練、削除の 3 段、濫用対策、セキュリティの試験、runbook | 未着手 |
| E9 S2 への拡張 | 物理クラスタの分割（再シャーディング）、`global` の分離、Valkey の sharded pub/sub、検索のドメインの分割、CDC のデータレイク | 未着手（[infrastructure.md](architecture/infrastructure.md) の 12 節の基準を満たしたら） |
| E10 企業向け機能 | SAML SSO、SCIM、監査ログの閲覧と出力、メンバーの管理者、ワークスペースの方針、ゴミ箱の保持期間の変更、管理者の内容の検索（監査付き）、無効化したメンバーのページの移し替え、制限付きメンバー | 未着手（MVP の後。intent.md の Non-goals） |

## Story

各 Story は、着手するときに `changes/YYMMDD-<slug>/` として起票する（[process.md](../../../docs/process.md) の「粒度」）。ここは計画で、進み具合は各変更の `spec.md` の frontmatter で見る。順序は Epic の中での目安で、依存があるものを先に置いた。各領域の文書の設計・決定・持ち越しから集めた。

### E1 Walking skeleton

| Story | 内容 |
| --- | --- |
| `dev-repo-bootstrap` | Notion の開発リポジトリを作り、`changes/`・`specs/`・開発向けの `AGENTS.md` を置く。rebuilds の設計へのリンクを置く（リポジトリ共通の [ADR-0005](../../../docs/decisions/0005-design-record-repository.md)） |
| `terraform-foundation` | AWS の Organizations、アカウント、VPC、Terraform の状態、GitHub Actions の OIDC（[infrastructure.md](architecture/infrastructure.md) の 1 節） |
| `app-infra-baseline` | ECS・ALB・Aurora（`rds.logical_replication = 1` を最初から）・Valkey・SQS・CloudFront（[infrastructure.md](architecture/infrastructure.md) の 2・7 節） |
| `github-project-setup` | ラベル・Issue Forms・Projects の項目とビュー・同期のワークフロー（[project-management.md](../../../docs/project-management.md)） |
| `ci-pipeline` | PR の CI、merge queue、ID の追跡、マイグレーションの lint、論理シャード 8 の段、夜間の CI（[delivery.md](architecture/delivery.md) の 2 節） |
| `agent-skills-foundation` | spec の起草・レビュー（QA 役）の Skill と eval（[quality.md](quality.md) の 3 節） |
| `telemetry-package` | 計装の共通部品。`db.shard.logical`・`db.cluster` の属性（[observability.md](architecture/observability.md) の 1 節） |
| `feature-flags-appconfig` | ワークスペース単位のフラグ、群れで広げるフラグ（[delivery.md](architecture/delivery.md) の 5 節） |
| `shard-router` | `packages/shard-router`、`global.shard_map`、`search_path` とテナントのコンテキスト、フェンス（[ADR-0027](decisions/0027-shard-router.md)） |
| `migration-rollout-shard-groups` | migrator、`schema_migrations` と `global.migration_ledger`、群れ G0〜G3、デプロイの関門（[ADR-0031](decisions/0031-migration-rollout-by-shard-groups.md)） |
| `block-table-and-invariants` | `blocks` の表と RLS、`packages/ops` の `applyOperation` と T1〜T8 の検査（[block-model.md](architecture/block-model.md) の 2・5・11 節） |
| `transactions-and-page-seq` | `POST /transactions`、`page_seqs`・`page_ops`・`device_cursors`、`outbox`（[ADR-0005](decisions/0005-transactions-as-unit-of-change.md)、[collaboration.md](architecture/collaboration.md) の 4・7 節） |
| `rich-text-spans` | `packages/rich-text` のスパンの正規化と `plain_text`（[ADR-0006](decisions/0006-rich-text-as-normalized-spans.md)、[block-model.md](architecture/block-model.md) の 4 節） |
| `dev-session-and-workspaces` | 開発用のサインインとワークスペースの作成（ID はサーバーで作る。E2 で本番のログインに置き換える） |
| `web-app-shell-routing` | アプリの骨格、ルート `/{workspace_slug}/{page_id}`（[editor.md](architecture/editor.md) の 2 節） |
| `page-load-chunks` | ページの読み込みを文書の順の区切りで返す API と、静的な描画（[editor.md](architecture/editor.md) の 4.1 節） |

### E2 権限と共有

| Story | 内容 |
| --- | --- |
| `auth-and-sessions` | ログイン、セッション、WebSocket のチケット（Slack の ADR-0012 を先例に。[permissions-and-sharing.md](architecture/permissions-and-sharing.md) の 1 節） |
| `accounts-and-members` | `accounts` と `members`、メンバーの解決のミドルウェア（[ADR-0021](decisions/0021-accounts-members-guests-and-teamspaces.md)） |
| `workspace-roles-and-admin` | ロール、招待、無効化、最後の所有者の保護（[permissions-and-sharing.md](architecture/permissions-and-sharing.md) の 2.2 節） |
| `guests-and-limits` | ゲスト、ゲストの上限と `guest_limit`（同じ文書の 2.3 節） |
| `teamspaces` | 4 種類のチームスペース、最上位の暗黙の ACL、サイドバーの並び（同じ文書の 3 節） |
| `groups` | グループとメンバー（同じ文書の 2.4 節） |
| `page-acls-and-can` | `page_acls`・`page_acl_entries`、置き換えの継承、`can()` と素朴な実装（[ADR-0018](decisions/0018-permission-levels-and-inheritance.md)） |
| `authorization-decision-tables` | 4.5・4.6・3.3 節の決定表を `DT-PRM-*` として定め、表駆動テスト（[quality.md](quality.md) の 2.2.3 節） |
| `acl-version-cache` | `workspace_acl_versions`、キャッシュ、`acl.changed` の outbox（[ADR-0019](decisions/0019-workspace-acl-version-cache.md)） |
| `share-dialog` | 共有の画面、「親と異なる」印、「子孫にも加える」（既定の決定は [permissions-and-sharing.md](architecture/permissions-and-sharing.md) の 11 節） |
| `general-access-and-links` | 一般アクセス（ワークスペース・リンク）と期限、`hide_from_search`（同じ文書の 7 節） |
| `page-move-permissions` | 実効の権限が変わる移動に `full_access` を求める（同じ文書の 4.2 節） |
| `leak-safe-navigation` | パンくず・サイドバー・読めないページの 404（同じ文書の 4.7 節） |
| `published-sites` | `<brand>.site` の描画サービス、noindex の既定、取り下げ、テンプレートとしての複製（[ADR-0020](decisions/0020-published-pages-isolation.md)） |
| `audit-log-core` | `audit_events` を操作と同じトランザクションで書く（[security.md](architecture/security.md) の 6 節） |

### E3 エディタ

| Story | 内容 |
| --- | --- |
| `editor-poc` | 1,000 ブロックのページの表示、`EditorView` の生成の費用、IME の計測（[ADR-0007](decisions/0007-block-editor-with-per-block-prosemirror.md) の Confirmation） |
| `block-editor-core` | ブロックの層、ブロックごとの ProseMirror、選択、構造を変えるキー操作、取り消し（[editor.md](architecture/editor.md) の 3 節） |
| `block-types-mvp` | MVP のブロックの種類と、未知の種類の読み取り専用の表示（[block-model.md](architecture/block-model.md) の 3 節） |
| `slash-commands` | スラッシュコマンドと `Cmd/Ctrl+/`（[editor.md](architecture/editor.md) の 5 節） |
| `markdown-shortcuts` | 行頭・行の中の Markdown のショートカット（同じ文書の 6 節） |
| `drag-and-keyboard-reorder` | ドラッグと、キー操作・メニューでの代替（同じ文書の 7 節） |
| `paste-and-copy` | 貼り付けの無害化と変換、コピー（同じ文書の 8 節） |
| `mentions-and-autocomplete` | 人・ページ・日付のメンション、`[[`、読めないページの表示（同じ文書の 9 節） |
| `inline-equations` | KaTeX の描画の隔離（同じ文書の 14 節） |
| `files-and-images` | アップロード、スキャン、署名付き URL、画像のプロキシ（[block-model.md](architecture/block-model.md) の 3 節、[security.md](architecture/security.md) の 3.6 節） |
| `embed-block` | 埋め込みの許可する提供元の一覧、sandbox の iframe（[security.md](architecture/security.md) の 3.5 節） |
| `synced-blocks` | 元と参照、元の位置での判定、解除、元を削除しても参照を残す（[block-model.md](architecture/block-model.md) の 7 節） |
| `large-page-rendering` | `content-visibility`、2,000 ブロックを超えたら仮想化、ProseMirror の遅延の生成（[editor.md](architecture/editor.md) の 4 節） |
| `trash-and-restore` | ゴミ箱、戻す先、`can_edit` 以上だけに見える一覧（[block-model.md](architecture/block-model.md) の 9 節、[ADR-0022](decisions/0022-trash-history-and-deletion-retention.md)） |
| `page-history-snapshots` | スナップショットの作成・一覧・比較・復元（[block-model.md](architecture/block-model.md) の 8 節） |
| `editor-a11y-and-i18n` | WCAG 2.2 AA、ja / en（[editor.md](architecture/editor.md) の 12・13 節） |

### E4 共同編集とオフライン

| Story | 内容 |
| --- | --- |
| `opfs-poc` | 各ブラウザ（プライベートブラウズを含む）での OPFS と容量の確認（[ADR-0008](decisions/0008-sqlite-wasm-opfs-local-store.md)、[ADR-0013](decisions/0013-offline-availability-policy.md)） |
| `relay-shard-leases` | 物理クラスタごとの Relay の群れと、論理シャードごとのリース（[collaboration.md](architecture/collaboration.md) の 7.3 節） |
| `sync-gateway-subscriptions` | ページ単位の購読、`can()` での判定、`page.revoked`、閲覧者が多いページの `page.head`（同じ文書の 7.2 節） |
| `page-ops-catch-up` | `seq` の飛びの検知と `GET /pages/{id}/ops`、スナップショットの取り直し（同じ文書の 8 節） |
| `text-crdt-package` | `packages/text-crdt` の Fugue＋Peritext、`block_text_states`、展開（[ADR-0010](decisions/0010-text-crdt-with-server-ordered-structure.md)） |
| `text-split-join-slices` | text slice と `text_slices` の索引（[collaboration.md](architecture/collaboration.md) の 5.3 節） |
| `structural-conflict-rules` | 構造とプロパティの規則、兄弟のアンカー、`sync_conflicts`（[ADR-0011](decisions/0011-structural-and-property-conflict-rules.md)、[ADR-0012](decisions/0012-child-order-by-sibling-anchors.md)） |
| `presence-and-cursors` | ページの在席とカーソル（[collaboration.md](architecture/collaboration.md) の 9 節） |
| `local-sqlite-store` | SQLite（WASM、`opfs-sahpool`）、書くタブを 1 つに限る、RecordCache と TransactionQueue（[editor.md](architecture/editor.md) の 10 節） |
| `sharedworker-sync-engine` | 同期のエンジンを SharedWorker に置く（[editor.md](architecture/editor.md) の 2.3 節） |
| `offline-pages-policy` | 理由ごとのオフラインのページ、上限（[collaboration.md](architecture/collaboration.md) の 11.1 節） |
| `sync-heads` | `POST /sync/heads` での鮮度の照合と、読めなくなったページの消去（同じ文書の 11.3 節） |
| `offline-merge-and-conflicts-ui` | 長時間のオフラインの統合、送れなかった変更、衝突の見せ方、同期の状態の表示（同じ文書の 10・11 節） |
| `desktop-electron-shell` | Electron の設定、ディープリンク、通知（[ADR-0009](decisions/0009-electron-desktop-shell.md)、[editor.md](architecture/editor.md) の 11 節） |
| `desktop-auto-update` | 自前の更新の情報の API、段階的な配布、署名の検証（[delivery.md](architecture/delivery.md) の 6.2 節。`electron-updater` の `generic` の提供元で作る） |

### E5 データベース

| Story | 内容 |
| --- | --- |
| `data-source-and-schema` | `database` ブロック、`data_sources`、プロパティの種類、行（`parent_type = data_source`）（[databases.md](architecture/databases.md) の 2 節） |
| `db-query-index` | `dbx_rows`・`dbx_values`、押し下げと評価器、キーセットと `query_id`（[ADR-0014](decisions/0014-database-query-index.md)） |
| `view-table` | 表のビュー、最初の 50 行とスクロール（[databases.md](architecture/databases.md) の 3.2・4 節） |
| `filters-sorts-groups` | フィルタ（3 段）・並べ替え・グループとサブグループ、「自分だけ」（同じ文書の 4 節） |
| `view-board-list-gallery` | ボード・リスト・ギャラリー |
| `view-calendar-timeline` | カレンダー・タイムライン（期間での問い合わせ） |
| `relations` | `relation_edges`、両方向、上限 10,000（[ADR-0016](decisions/0016-relation-edges-as-single-source.md)） |
| `rollups` | ロールアップと Worker での計算し直し（[databases.md](architecture/databases.md) の 7 節） |
| `formula-evaluator` | 構文解析と評価器、依存の検査、実体化（[ADR-0015](decisions/0015-formula-evaluation-model.md)） |
| `row-acl-readable-rollups` | 行に固有の ACL、早い経路と遅い経路（[ADR-0017](decisions/0017-rollups-over-readable-rows-only.md)） |
| `linked-views` | リンクドビュー（[databases.md](architecture/databases.md) の 3.3 節） |
| `property-type-change` | 種類の変更と、数式の定義の変更の全行の計算し直しのジョブ（同じ文書の 2.1・8.3 節） |
| `db-index-consistency-check` | `properties` と `dbx_values` の整合の検査のジョブ（同じ文書の 3.1 節） |

### E6 検索・コメント・通知

| Story | 内容 |
| --- | --- |
| `search-opensearch-domain` | OpenSearch のドメイン、Sudachi、別名 `pages`（[search.md](architecture/search.md) の 4・9 節） |
| `search-indexer` | `search-index` のキュー、5 秒の窓、外部バージョン、runbook の `search-indexing.md`（同じ文書の 8 節） |
| `search-access-keys` | `accessKeysFor`、`search-acl` のキュー、1 時間ごとの突き合わせ（同じ文書の 5 節、[ADR-0023](decisions/0023-search-engine-and-permission-filtering.md)） |
| `search-query-and-hydration` | `buildSearchRequest`、読み直し、抜粋、絞り込みと並べ替え（[search.md](architecture/search.md) の 5.4・6 節） |
| `quick-search` | クイック検索とオフラインのタイトルの検索（同じ文書の 7 節） |
| `search-relevance-eval` | 評価のクエリの集合と重みの決定（[quality.md](quality.md) の 3 節） |
| `comments-and-discussions` | ページ・ブロック・テキストの範囲へのコメント、解決、リアクション（[comments-and-notifications.md](architecture/comments-and-notifications.md) の 2 節） |
| `mentions-and-backlinks` | メンションの記録、バックリンク、読めない人への通知をしない（同じ文書の 3 節） |
| `reminders` | リマインダーのスケジューラー（同じ文書の 4 節） |
| `notification-planner-and-inbox` | 通知の計画、3 か所の判定、受信箱（同じ文書の 5 節） |
| `email-and-push-notifications` | メール（SES）と Web・デスクトップの push、runbook の `notification-delivery.md`（同じ文書の 5.4・5.5 節） |
| `page-subscriptions-and-updates` | 購読の水準、ページの更新の欄（同じ文書の 5.1・6 節） |

### E7 API・連携・MCP

| Story | 内容 |
| --- | --- |
| `public-api-foundation` | `api.<domain>` のサービス、`<Brand>-Version` とバージョンの変換層、エラーの形（[api-and-integrations.md](architecture/api-and-integrations.md) の 2・4 節、[ADR-0024](decisions/0024-integration-access-model.md)） |
| `internal-integrations-and-tokens` | 内部の連携、`<brand>_int_` のトークン、能力、`bot:` の共有（同じ文書の 3 節） |
| `pages-and-blocks-api` | ページ・ブロック・子・移動・Markdown の API、`Idempotency-Key`（同じ文書の 4.2 節） |
| `databases-and-data-sources-api` | データベース・データソース・問い合わせ（同じ文書の 4.2 節） |
| `comments-users-search-api` | コメント・利用者・タイトルの検索の API |
| `file-uploads-api` | ファイルのアップロードの API |
| `api-rate-limits` | 連携・ワークスペース・エンドポイントの上限（同じ文書の 5 節） |
| `webhooks` | 購読と確認、イベント、まとめ、配送、`webhook-egress` の Lambda、runbook の `webhook-delivery.md`（同じ文書の 6 節、[ADR-0025](decisions/0025-webhook-delivery.md)） |
| `mcp-server-read` | リモートの MCP サーバーの読み取りのツール、OAuth 2.1、監査（同じ文書の 8 節、[ADR-0026](decisions/0026-remote-mcp-server.md)） |
| `mcp-write-tools` | 書き込みのツール（既定で無効。[quality.md](quality.md) の 3 節の eval の後） |
| `import-markdown-csv-html` | Markdown（ZIP）・CSV・HTML・テキストのインポート（[api-and-integrations.md](architecture/api-and-integrations.md) の 7.1 節） |
| `export-markdown-csv-html` | ページとワークスペースのエクスポート（同じ文書の 7.2 節） |
| `oauth-public-integrations` | 公開の連携（OAuth 2.1、ページの選択）。E7 の後半 |
| `export-pdf` | PDF のエクスポート。E7 の後半 |
| `views-api-and-webhooks` | ビューの API と `view.*` の Webhook。E5 の後の E7 の後半 |

### E8 本番運用

| Story | 内容 |
| --- | --- |
| `load-test-k6` | 負荷のモデルの 1 倍・2 倍、再接続の殺到、巨大なページ・データベース（[capacity.md](architecture/capacity.md)）。結果で capacity.md と infrastructure.md を更新する。OpenSearch の単価もここで確かめ、コストの概算を直す（[infrastructure.md](architecture/infrastructure.md) の 13 節） |
| `slo-dashboards-and-alerts` | SLO、バーンレート、偏りの検出（[runbooks/README.md](runbooks/README.md)、[observability.md](architecture/observability.md)） |
| `synthetic-monitoring` | 大阪からの合成監視（[observability.md](architecture/observability.md) の 6 節） |
| `dr-global-database` | 大阪の Global Database の二次、パイロットライト、訓練（[ADR-0029](decisions/0029-disaster-recovery.md)） |
| `backups-and-restore-drill` | AWS Backup、Vault Lock、1 つのワークスペースだけを戻す手順（[infrastructure.md](architecture/infrastructure.md) の 8 節） |
| `db-maintenance` | VACUUM と周回の監視、`pg_stat_statements`、runbook の `db-maintenance.md`（[capacity.md](architecture/capacity.md) の 3.1 節） |
| `data-deletion-worker` | 削除の 3 段と物理削除、運用者による復元、runbook の `data-deletion.md`（[ADR-0022](decisions/0022-trash-history-and-deletion-retention.md)） |
| `workspace-and-account-deletion` | ワークスペースの削除（30 日の猶予）、アカウントの削除と匿名化（[security.md](architecture/security.md) の 7 節） |
| `abuse-reporting-and-takedown` | 通報、自動の検査、`publishing_suspended`、runbook の `abuse-takedown.md`（[security.md](architecture/security.md) の 8 節） |
| `security-incident-runbook` | runbook の `security-incident.md` と、外部のペンテスト（[security.md](architecture/security.md) の 10 節） |
| `analytics-daily-export` | S1 の分析：Aurora の日次のエクスポートと Athena（[ADR-0030](decisions/0030-cdc-data-lake.md) の S1） |

### E9 S2 への拡張

| Story | 内容 |
| --- | --- |
| `reshard-automation` | `reshard` のワークフロー、パブリケーション、切り替えと戻し、runbook の `resharding.md`（[ADR-0028](decisions/0028-zero-downtime-resharding.md)） |
| `reshard-shadow-reads` | 影の読み取りと不一致の分類、不一致のアラート（[quality.md](quality.md) の 2.2.4 節） |
| `reshard-drill-staging` | staging での物理 1 → 2 の訓練 |
| `global-cluster-split` | `global` を独立したクラスタへ（[infrastructure.md](architecture/infrastructure.md) の 3.1 節） |
| `api-pools-per-cluster` | クラスタごとの小さなプール、または接続の集約（[capacity.md](architecture/capacity.md) の 2.3 節） |
| `valkey-sharded-pubsub` | Valkey のクラスタモードと sharded pub/sub（[collaboration.md](architecture/collaboration.md) の 13 節） |
| `search-domains-by-shard-range` | 論理シャードの範囲ごとの検索のドメイン（[search.md](architecture/search.md) の 9.2 節） |
| `cdc-data-lake` | Debezium・MSK・Hudi か Iceberg、runbook の `data-lake.md`（ADR-0030 を accepted にしてから） |
| `multi-cluster-dr-automation` | 複数の物理クラスタの並列の昇格（[ADR-0029](decisions/0029-disaster-recovery.md)） |
| `acl-version-contention` | `acl_version` の競合の計測と、必要なら分け方の ADR（[ADR-0019](decisions/0019-workspace-acl-version-cache.md)） |

### E10 企業向け機能

| Story | 内容 |
| --- | --- |
| `saml-sso` | SAML SSO、ドメインの確認（[permissions-and-sharing.md](architecture/permissions-and-sharing.md) の 6 節） |
| `scim` | SCIM のユーザーとグループ |
| `audit-log-viewer` | 監査ログの閲覧、CSV、SIEM への送信（[security.md](architecture/security.md) の 6 節） |
| `membership-admin-role` | メンバーの管理者 |
| `workspace-security-policies` | 公開・ゲスト・エクスポート・連携の禁止、ゲストの追加の申請（[permissions-and-sharing.md](architecture/permissions-and-sharing.md) の 4.6・10 節） |
| `enterprise-trash-retention` | ゴミ箱の保持期間の変更（[ADR-0022](decisions/0022-trash-history-and-deletion-retention.md)） |
| `plan-history-retention` | プランごとの履歴の日数（7・30・90 日・無期限） |
| `deprovisioned-content-transfer` | 無効化したメンバーのプライベートのページを、所有者が中身を読まずに別のメンバーへ移す。30 日以内、監査ログに残す（[ADR-0033](decisions/0033-transfer-private-pages-of-deactivated-members.md)） |
| `restricted-member-role` | 制限付きメンバーのロール `restricted_member`（[permissions-and-sharing.md](architecture/permissions-and-sharing.md) の 2.2 節、[ADR-0021](decisions/0021-accounts-members-guests-and-teamspaces.md) の注記） |
| `admin-content-search` | 管理者の内容の検索。監査ログに残す別の経路で、ページの権限の判定は変えない（[permissions-and-sharing.md](architecture/permissions-and-sharing.md) の 2.2 節） |

各 Epic の品質面の重点と合否基準は、[quality.md](quality.md) の 5 節にある。

## エージェントに任せないこと

- **契約（トランザクションの操作、WebSocket のイベント、スパンの形、公開 API とバージョン、MCP のツール）の確定**：後から変えるコストがいちばん高い。
- **権限の決定表と漏洩の行列の最終確認**：テストが通っていても、ケースの漏れはエージェント自身では気づきにくい。
- **CRDT と衝突の規則の変更**：収束の性質が通っても、利用者の意図に合うかは人が判断する。
- **再シャーディングの切り替えの実行と判断**：runbook に従い Ops が行う。
- **体験の良し悪し**：IME、カーソルの移動、ドラッグ、衝突の見せ方など、触らないとわからない品質。
- **負荷試験の結果の解釈**：数字は出せるが、どこに投資するかはプロダクトの判断。
- **法務の判断**（[intent.md](intent.md) の「法務の確認待ち」）。

## 後回しにしたもの

MVP の後に検討する。着手するときに `intent.md` から起票する。

- **Notion AI に相当する機能**（要約、生成、AI による検索、意味検索）：権限を先に適用する前提で作る。データレイクは権限の判定を通らないので、元にしない（[ADR-0030](decisions/0030-cdc-data-lake.md)）。
- **フォーム、ボタン、オートメーション**、データベースのテンプレート。
- **ビュー**：チャート、フォーム、マップ、ダッシュボード。データベースのプロパティへのコメント。
- **ブロックの種類**：列、表、ブックマーク、目次、数式のブロック、パンくず、ボタン、`heading_4`（[block-model.md](architecture/block-model.md) の 3 節）。
- **エディタ**：ブロックの間にまたがる部分的なテキストの選択。
- **クライアント**：モバイルのネイティブアプリ（PWA で代替）、デスクトップの Linux 版、デスクトップのネイティブの SQLite とローカルの保存の暗号化（S2 の候補。S1 の計測で決める。[ADR-0032](decisions/0032-desktop-uses-wasm-sqlite-in-s1.md)）。
- **API**：個人のアクセストークン、Webhook の署名の秘密の入れ替え。
- **通知**：ダイジェストのメール、Slack・Microsoft Teams への通知、端末をまたぐ閲覧の履歴での検索の加点。
- **権限**：データベースの `can_create` の水準と行単位の権限、リンクでの閲覧者へのコメント・編集の許可。
- **企業向け**：リーガルホールド、ワークスペースごとの鍵（EKM）、データの保管地域の選択。
- **S3 への拡張**（E11 の候補）：複数リージョン、リージョンの間のワークスペースの移動、ウォームスタンバイ（[infrastructure.md](architecture/infrastructure.md) の 11 節。着手の前に ADR を起票する）。
- **確定済みのトランザクションの保持と再送**（リージョンの切り替えで失った分の回復。[collaboration.md](architecture/collaboration.md) の 14 節）：E8 の DR 訓練の結果で決める。

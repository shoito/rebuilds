# Data model: Linear

データモデルの索引。モデルの定義の言語と生成は [data-model-and-schema.md](data-model-and-schema.md)（[ADR-0019](../decisions/0019-schema-definition-and-codegen.md)）、テナントと権限は [ADR-0004](../decisions/0004-tenancy-and-permissions.md)、同期のログは [ADR-0007](../decisions/0007-sync-actions-and-range-proof-deltas.md) に従う。**各モデル・表の定義の正本は、下の索引の「定義の場所」にある文書**で、ここは置き場所、横断の規則、RLS の外の表、全部の表と store の索引をまとめる。

2026-09-28 の統合の工程で、全領域の文書の「data-model への項目」を集め、各領域から出た追加の依頼を定義の文書に反映した（8 節）。重なりと持ち主の未定（`Workspace`）も解消した（9 節）。

## 1. 置き場所

| 置き場所 | 中身 |
| --- | --- |
| Aurora PostgreSQL 18（主。東京、大阪は Global Database の二次） | 唯一の正本。モデルの表、`sync_actions`・`workspace_sync`・`tx_results`・`sync_outbox`、サーバーだけの表、監査、`auth` スキーマ（Better Auth） |
| Aurora（ディレクトリのクラスタ。S2 から） | `workspace_directory`、`auth` スキーマ（[ADR-0051](../decisions/0051-workspace-sharding-and-cells.md)） |
| DynamoDB（東京、大阪をレプリカにしたグローバルテーブル） | `narrowing_journal`：権限を狭める操作の追記だけの記録（[ADR-0058](../decisions/0058-dr-permission-narrowing-journal.md)、[infrastructure.md](infrastructure.md) の 6.3 節）。35 日 |
| Valkey | 差分の pub/sub、チケット、セッションの写し、取り消しの知らせ、レート制限、書き込みの枠、Relay の担当。失ってよい |
| OpenSearch | 検索の索引 `docs`（[search.md](search.md) の 4 節）。RLS の外 |
| S3 | 添付 `ws/<workspace_id>/att/…`、インポートの段置き `ws/<workspace_id>/imports/…`（30 日）、書き出し `ws/<workspace_id>/exports/…`（24 時間）、Web の資産、Electron の配布物、OpenSearch のスナップショット、RUM の Parquet、配信の監査の抜き取り |
| S3（log-archive、Object Lock） | 監査ログの写し（ハッシュの連鎖）、CloudTrail、CloudFront・WAF のログ |
| SQS | 通知、索引（`search-index`・`search-bulk`）、Webhook（`webhook-fanout`・`webhook-send`）、連携（`integrations` FIFO、`integrations-out`）、インポート、監査 |
| Secrets Manager | プラットフォームの秘密（GitHub App の鍵、Slack の署名の秘密、DB の認証情報、署名付きの URL の鍵） |
| AppConfig・CloudFront KeyValueStore | フラグ（`release.*`・`ops.*`・クライアントのフラグ）、`min_build`、互換の一覧、Web と Electron の版の割合（[delivery.md](delivery.md)） |
| 利用者の端末（IndexedDB） | ワークスペースごとの DB（6 節） |

## 2. 横断の規則

- **ワークスペースの表は `workspace_id` を持ち、主キーと索引の先頭に置く。** ID は UUIDv7（[ADR-0020](../decisions/0020-ids-and-human-identifiers.md)）。`FORCE ROW LEVEL SECURITY` と、トランザクションごとの `SET LOCAL app.workspace_id`（ADR-0004）。マイグレーションの CI で確かめる（[delivery.md](delivery.md) の 2.1 節）。
- **外部キーは `workspace_id` を含む複合キーにする。**
- **モデルの表の共通の列**（生成。[data-model-and-schema.md](data-model-and-schema.md) の 4 節）：`workspace_id`、`id`、`created_at`、`updated_sync_id`、`sync_groups`、`field_sync_ids`、`archived_at`。
- **サーバーだけの表**（モデルにしない。差分に載らない）は、名前を 5 節に挙げる。秘密・ハッシュ・送りの記録は、ここに置く（モデルに置くと端末の IndexedDB に残る。[ADR-0040](../decisions/0040-integration-installations-and-credential-storage.md)）。
- **秘密の列の型**：
  | 種類 | 列 | 例 |
  | --- | --- | --- |
  | 高いエントロピーの秘密 | `*_hash`（SHA-256、`bytea`） | `api_keys.key_hash`、`oauth_tokens.token_hash`、`invitation_tokens.token_hash`、同期のチケット（Valkey） |
  | 戻す必要のある秘密 | `ciphertext`・`dek_ciphertext`（AES-256-GCM、AAD、`packages/envelope`） | `integration_secrets`、`webhook_secrets`、`import_secrets`、`webhook_deliveries.payload_ct` |
  マイグレーションの CI で、`secret`・`token`・`key` を含む名前の列が、上のどちらかの型であることを確かめる。
- **個人データの注記**：モデルのフィールドは `pii: identity | content`（[data-model-and-schema.md](data-model-and-schema.md) の 3.2 節）。サーバーだけの表にも同じ注記をマイグレーションのコメントで付け、保持の表（[security.md](security.md) の 9 節）と突き合わせる。
- **保持の期間の正本は [security.md](security.md) の 9 節**。各領域の文書の値は、それに揃えた（2026-09-28）。
- **時間で消える表は日ごとのパーティションで持ち、`DROP` で消す**：`sync_actions`（30 日）、`tx_results`（90 日）、`integration_events`（30 日）、`webhook_deliveries`（14 日）、`audit_events`（1 年）、`convergence_audits`（90 日）、`notification_keys`（30 日）。
- **新しい表・S3 の接頭辞・DynamoDB の項目を足すとき**は、ワークスペースの削除のジョブ（[ADR-0048](../decisions/0048-data-lifecycle-and-workspace-deletion.md)）と保持の表に足す。
- **DB のロール**（2026-09-28 に確定）：

  | ロール | 使うサービス | 権限 |
  | --- | --- | --- |
  | `migrator` | マイグレーション | 所有者 |
  | `writer` | Writer | モデルの表・同期の表・監査・`narrowing_outbox` の書き込み。RLS の対象 |
  | `sync_reader` | Sync API、Gateway、audit-worker | モデルの表・同期の表の読み取り。RLS の対象 |
  | `public_api` | Public API | 読み取り（reader）と、OAuth・API キーの表。RLS の対象 |
  | `auth` | 認証のサービス | `auth` スキーマ、`narrowing_outbox` の書き込み（RLS の外） |
  | `relay` | Relay | `sync_outbox`・`sync_actions` の読み取りと送信済みの印、`narrowing_outbox` の送信済みの印 |
  | `worker` | Worker | ジョブごとにワークスペースのコンテキストを設定。RLS の対象 |
  | `integrations` | 連携の Worker と受け口 | `integration_secrets`・`integration_events` と連携のモデルの読み取り |
  | `platform` | ワークスペースをまたぐ処理（保持のジョブ、削除のジョブ、DR の `sync_epoch` の引き上げと狭める操作のやり直し、課金の集計） | RLS を迂回。操作はプラットフォームの監査へ |

## 3. RLS の例外（ワークスペースの外の表）

**ここにない表は、すべて `workspace_id` と RLS を持つ。** マイグレーションの CI の許可リストは、この表と一致させる。追加は、この表と [security.md](security.md) を合わせて更新し、Dev のテックリードとセキュリティの担当の承認を得る。

| 表 | RLS の外に置く理由 | 読める主体 | 書ける主体 | 定義の場所 |
| --- | --- | --- | --- | --- |
| `auth.user`・`auth.account`・`auth.session`・`auth.verification`・`auth.passkey` | アカウントはワークスペースをまたぐ | `auth` | `auth` | [accounts-and-auth.md](accounts-and-auth.md) の 3.3 節 |
| `auth.workspace_directory` | アカウント → ワークスペースの入り口の写し | `auth` | `auth`・`writer`（関数経由） | 同 4.1 節 |
| `workspace_directory`（S2 から） | ワークスペース → クラスタ | 全サービス | `platform` | [infrastructure.md](infrastructure.md) の 10.1 節 |
| `sync_outbox` | Relay が全ワークスペースを順に読む。行は `workspace_id` と範囲と時刻だけ | `relay` | `writer` | [sync-engine.md](sync-engine.md) の 7.1 節 |
| `narrowing_outbox` | Relay が全ワークスペースの送り残しを順に読む。行は ID と列挙の値だけ | `relay` | `writer`・`auth` | [infrastructure.md](infrastructure.md) の 6.3 節（ADR-0058） |
| `platform_audit_events` | ワークスペースをまたぐ操作 | `platform`、監査のロール | 各サービス（追記だけ） | [security.md](security.md) の 6 節 |
| `legal_holds` | 保持のジョブがワークスペースをまたいで読む | `platform` | `platform`（法務の指示） | 同 9 節 |
| `client_devices` | 端末の ID はワークスペースを決める前（握手の前、DB がない時）に引く。行は `(device_id, account_id, workspace_id)` ごと | Gateway、`sync_reader` | Gateway | [client-store-and-offline.md](client-store-and-offline.md) の 9.3 節 |

- **ワークスペースのコンテキストの前の読み出しは、関数にする**（統合の工程で決めた）。次の 2 つは表を RLS の中に置き、`SECURITY DEFINER` の関数だけで、決まった列を返す。
  | 関数 | 返すもの | 表 | 定義の場所 |
  | --- | --- | --- | --- |
  | `resolve_workspace_slug(slug)` | `(id, status, region)` | `workspaces`（`Workspace`） | [permissions-and-teams.md](permissions-and-teams.md) の 3.3 節 |
  | `oauth_app_public(client_id)` | `(workspace_id, name, redirect_uris, scopes)` | `oauth_apps` | [api-and-webhooks.md](api-and-webhooks.md) の 6.3 節 |
- 関数の持ち主は `migrator`、実行できるのは `auth`・`public_api`・`sync_reader` だけ。関数の追加も、この節の更新とセキュリティの担当の承認を要する。

## 4. 同期するモデル

グループの規則と読み込みの方針は、各領域の `model()` の定義から写した。グループの規則の意味は [data-model-and-schema.md](data-model-and-schema.md) の 3.5 節、グループを購読する人は [permissions-and-teams.md](permissions-and-teams.md) の 5.1 節。

| モデル | 表 | グループ | 読み込み | 定義の場所 |
| --- | --- | --- | --- | --- |
| `Workspace` | `workspaces` | `workspace` | instant | [permissions-and-teams.md](permissions-and-teams.md) の 3.3 節 |
| `WorkspaceSettings` | `workspace_settings` | `workspace_members` | instant | 同上 |
| `User` | `users` | `workspace` | instant | 同 3.2 節 |
| `Team` | `teams` | `team_row` | instant | 同上（ワークフロー・サイクル・連携の設定の列は [issues-and-workflow.md](issues-and-workflow.md) の 3.1 節、[cycles-and-projects.md](cycles-and-projects.md) の 3.1 節） |
| `TeamMembership` | `team_memberships` | `team_row` | instant | 同上 |
| `SyncSubscription` | `sync_subscriptions` | `user` | instant | [bootstrap-and-partial-sync.md](bootstrap-and-partial-sync.md) の 7.1 節 |
| `Invitation` | `invitations` | `admin` | instant | [accounts-and-auth.md](accounts-and-auth.md) の 7.1 節 |
| `WorkflowState` | `workflow_states` | `team` | instant | [issues-and-workflow.md](issues-and-workflow.md) の 3.2 節 |
| `Issue` | `issues` | `team` | partial（`issue_active_30d`） | [data-model-and-schema.md](data-model-and-schema.md) の 3.1 節、[issues-and-workflow.md](issues-and-workflow.md) の 3.3 節 |
| `IssueLabel` | `issue_labels` | `team_or_workspace` | instant | [issues-and-workflow.md](issues-and-workflow.md) の 3.4 節 |
| `IssueRelation` | `issue_relations` | `via`（両方） | lazy | 同 3.5 節 |
| `IssueHistory` | `issue_history` | `via` | lazy | 同 11 節 |
| `IssueTemplate`・`IssueDraft` | `issue_templates`・`issue_drafts` | `team_or_workspace`・`user` | instant・lazy | 同 12 節 |
| `IssueAlias` | `issue_aliases` | `via` | lazy | [data-model-and-schema.md](data-model-and-schema.md) の 5.4 節 |
| `IssueDescription` | `issue_descriptions` | `via` | lazy | [editor-and-descriptions.md](editor-and-descriptions.md) の 4.1 節 |
| `IssueDescriptionVersion` | `issue_description_versions` | `via` | lazy | 同 4.7 節 |
| `Comment`・`Reaction` | `comments`・`reactions` | `via` | lazy | 同 5.1 節 |
| `Attachment` | `attachments` | `via` | lazy | 同 8.1 節 |
| `Cycle` | `cycles` | `team` | instant | [cycles-and-projects.md](cycles-and-projects.md) の 3.2 節 |
| `Project`・`ProjectTeam` | `projects`・`project_teams` | `teams`（`ProjectTeam.team_id` から）・`team` | instant | 同 3.3 節 |
| `ProjectStatus`・`ProjectMilestone` | `project_statuses`・`project_milestones` | `workspace`・`via` | instant | 同 3.5・3.6 節 |
| `Initiative`・`InitiativeProject` | `initiatives`・`initiative_projects` | `workspace_members`・`via` | instant | 同 3.7 節 |
| `ProjectUpdate` | `project_updates` | `via` | lazy | 同 6.1 節 |
| `ProgressStat`・`ProgressPoint` | `progress_stats`・`progress_points` | `team` | instant・lazy | 同 7.2・7.4 節 |
| `View`・`ViewPreference` | `views`・`view_preferences` | `view_scope`・`user` | instant | [views-and-filters.md](views-and-filters.md) の 7.1 節 |
| `Notification`・`InboxState`・`NotificationSubscription`・`NotificationPreference`・`IssueReminder` | `notifications`・`inbox_states`・`notification_subscriptions`・`notification_preferences`・`issue_reminders` | `user` | instant | [notifications-and-inbox.md](notifications-and-inbox.md) の 4 節 |
| `IntegrationInstallation` | `integration_installations` | `admin` | instant | [integrations.md](integrations.md) の 4.1 節 |
| `GitLink` | `git_links` | `via` | lazy | 同 4.3 節 |
| `ExternalAccountLink` | `external_account_links` | `user` | instant | 同 4.6 節 |
| `SlackChannelSubscription` | `slack_channel_subscriptions` | `admin` | instant | 同 5.3 節 |
| `Webhook` | `webhooks` | `admin` | instant | [api-and-webhooks.md](api-and-webhooks.md) の 5.1 節 |
| `ImportJob` | `import_jobs` | `admin` | instant | [import-export.md](import-export.md) の 3 節 |
| `ExportJob` | `export_jobs` | `user` | instant | 同 7 節 |

- 規則が `workspace` のモデル（`Workspace`、`User`、`ProjectStatus`、ワークスペースのラベル・テンプレート）は、`guest_visible` の注記を持つ（[data-model-and-schema.md](data-model-and-schema.md) の 4.1 節の行 11）。
- `Issue` の `include`：`IssueDescription:id`、`Comment:issue_id`、`IssueHistory:issue_id`、`Attachment:issue_id`、`IssueRelation:issue_id`・`related_issue_id`、`IssueAlias:issue_id`、`GitLink:issue_id`。

## 5. サーバーだけの表（ワークスペースの表、RLS）

| 表 | 中身 | 保持 | 定義の場所 |
| --- | --- | --- | --- |
| `workspace_sync` | `last_sync_id`、`floor_sync_id`、`sync_epoch` | — | [sync-engine.md](sync-engine.md) の 7.1 節 |
| `sync_actions` | 変更のログ（日ごとのパーティション）。索引 `(workspace_id, model, model_id, sync_id)` | 30 日 | 同上 |
| `tx_results` | 冪等の記録 | 90 日 | 同 5.4 節 |
| `workspace_stats` | グループごとのモデルの数の見積もり | — | [bootstrap-and-partial-sync.md](bootstrap-and-partial-sync.md) の 4.1 節 |
| `team_key_aliases` | チームの古い識別子 | — | [data-model-and-schema.md](data-model-and-schema.md) の 5.4 節 |
| `invitation_tokens`、`workspace_invite_links` | 招待のトークンのハッシュ、招待のリンク | — | [accounts-and-auth.md](accounts-and-auth.md) の 7 節 |
| `workspace_domain_verifications` | 許可したドメインの確認の値と状態 | ドメインを外すまで | 同 7.4 節 |
| `doc_states`、`doc_mentions` | 本文のまとめた状態、メンション | イシューがある間 | [editor-and-descriptions.md](editor-and-descriptions.md) の 4.2・6 節 |
| `notification_keys`、`notification_deliveries` | 通知の冪等の鍵、送りの予定と結果 | 30 日、通知の領域 | [notifications-and-inbox.md](notifications-and-inbox.md) の 5.2・8 節 |
| `integration_secrets`、`integration_events` | 連携の秘密、受けた事象 | インストールがある間、30 日 | [integrations.md](integrations.md) の 3・6 節 |
| `api_keys`、`oauth_apps`、`oauth_grants`、`oauth_tokens` | API キーと OAuth | 期限まで | [api-and-webhooks.md](api-and-webhooks.md) の 6 節 |
| `webhook_secrets`、`webhook_deliveries` | Webhook の秘密、送りの記録 | Webhook がある間、14 日（本文 72 時間） | 同 5 節 |
| `import_mappings`、`import_items`、`import_secrets` | 対応付け、元の記録 → ID、元の認証 | ジョブの後の 30 日、`import_items` はワークスペースがある間、認証はジョブの後に消す | [import-export.md](import-export.md) の 3〜5 節 |
| `audit_events` | ワークスペースの監査 | 1 年（log-archive 3 年） | [security.md](security.md) の 6 節 |
| `workspace_support_grants` | サポートの参照の許し | 期限まで | 同 8 節 |
| `convergence_audits`、`convergence_mismatches` | 収束の監査の報告と不一致 | 90 日、1 年 | [observability.md](observability.md) の 4 節 |

- `oauth_apps` の、認可の画面でワークスペースを選ぶ前に読む部分は、3 節の関数 `oauth_app_public` で返す。

## 6. 手元（IndexedDB）

| DB・store | 中身 | 定義の場所 |
| --- | --- | --- |
| `<brand>_registry.databases` | ワークスペースの DB の一覧 | [client-store-and-offline.md](client-store-and-offline.md) の 3.1 節 |
| モデルごとの store（`_u`・`_g` 付き） | 確定した行 | 同 3.2・3.3 節 |
| `_meta` | `last_sync_id`、`sync_epoch`、`groups`、`groups_hash`、`schema_version`、`schema_hash`、`bootstrap`、`reset`、`migration`、`client_id`、`flags` | 同 3.2 節、[delivery.md](delivery.md) の 3 節 |
| `_outbox`、`_rejected`、`_blobs` | 未確定と確定から 15 分（`done`）、拒否、オフラインの添付 | 同 5 節 |
| `_partial_indexes`、`_tombstones` | 被覆の鍵、墓標（15 分） | [bootstrap-and-partial-sync.md](bootstrap-and-partial-sync.md) の 6 節 |
| `_doc_state`、`_doc_updates` | 本文の状態、被覆のない本文への `append` | [client-store-and-offline.md](client-store-and-offline.md) の 3.2 節、[editor-and-descriptions.md](editor-and-descriptions.md) の 4.5 節 |
| `_drafts` | 一時の下書き（端末だけ） | [client-store-and-offline.md](client-store-and-offline.md) の 3.2 節 |
| メモリーの M2 | イシューの詰めた索引の列と、派生の列 `identifier`・`title_norm` | 同 7.1 節 |
| `localStorage` | 最後に開いたビュー、表示の設定（ID だけ） | [client-app.md](client-app.md) の 3.3 節 |

## 7. Valkey・S3・OpenSearch・DynamoDB の鍵

| 鍵・接頭辞 | 中身 | 定義の場所 |
| --- | --- | --- |
| `sync:<workspace_id>` | 絞る前の差分の配信 | [sync-engine.md](sync-engine.md) の 7.3 節 |
| チケット（SHA-256、60 秒） | WebSocket の認証 | 同 9.3 節 |
| `auth:revoked`・`auth:member_removed`、セッションの写し | 取り消しの知らせ | [accounts-and-auth.md](accounts-and-auth.md) の 6 節 |
| `ws:<id>:wr:<origin>`、`ws:<id>:lockwait` | 書き込みの枠、ロックの待ち | [capacity.md](capacity.md) の 2.2 節 |
| `relay:lease:<区画>` | Relay の区画の担当 | [infrastructure.md](infrastructure.md) の 3.2 節 |
| レート制限のバケット | 公開 API | [api-and-webhooks.md](api-and-webhooks.md) の 4.2 節 |
| S3 `ws/<workspace_id>/att/`・`imports/`・`exports/` | 添付、段置き、書き出し | [editor-and-descriptions.md](editor-and-descriptions.md) の 8.2 節、[import-export.md](import-export.md) |
| OpenSearch `docs` | 行ごとの文書、`groups`、版 | [search.md](search.md) の 4 節 |
| DynamoDB `narrowing_journal`（`pk = workspace_id`、`sk = <committed_at>#<client_tx_id>`） | 権限を狭める操作の記録 | [infrastructure.md](infrastructure.md) の 6.3 節 |

## 8. 各領域からの追加の依頼（2026-09-28 に反映済み）

統合の工程で、依頼を依頼先の文書に反映した。今後の追加は、依頼先の文書を直接直し、この表には足さない。

| 依頼元 | 依頼先 | 中身 | 反映した場所 |
| --- | --- | --- | --- |
| [integrations.md](integrations.md) | data-model-and-schema | `Issue.include` に `GitLink:issue_id` | [data-model-and-schema.md](data-model-and-schema.md) の 3.1 節 |
| integrations | issues-and-workflow（`Team`） | `git_on_draft`・`git_on_open`・`git_on_review`・`git_on_merge`・`git_link_comment` の列 | [issues-and-workflow.md](issues-and-workflow.md) の 3.1 節 |
| integrations | permissions-and-teams | DT-PERM-002 に連携の作成・削除、DT-PERM-003 に `SlackChannelSubscription` | [permissions-and-teams.md](permissions-and-teams.md) の 4.4・4.5 節 |
| [api-and-webhooks.md](api-and-webhooks.md) | permissions-and-teams | `Principal.scopes`・チームの絞りの重ね方 | 同 4.1 節 |
| api-and-webhooks、[observability.md](observability.md) | sync-engine | `sync_actions` の索引 `(workspace_id, model, model_id, sync_id)` | [sync-engine.md](sync-engine.md) の 7.1 節 |
| api-and-webhooks | ワークスペースの設定 | `api_keys_allowed`、`oauth_apps_allowed` | [permissions-and-teams.md](permissions-and-teams.md) の 3.3 節（`WorkspaceSettings`） |
| [import-export.md](import-export.md) | sync-engine、data-model-and-schema | `origin = import` の扱い（DT-IMPORT-002）：`created_at`・作者・完了の時刻を操作の値で受ける | [data-model-and-schema.md](data-model-and-schema.md) の 3.2 節（`import_writable`）、[sync-engine.md](sync-engine.md) の 5.1 節 |
| import-export | issues-and-workflow | `Issue.creator_id` と `import` での例外、DT-ISSUE-002 の `import` の行 | [issues-and-workflow.md](issues-and-workflow.md) の 3.3・10.1 節 |
| import-export | permissions-and-teams | DT-PERM-002 にインポート | [permissions-and-teams.md](permissions-and-teams.md) の 4.4 節 |
| [security.md](security.md) | accounts-and-auth | セッションに `wipe_requested`、DT-AUTH-002 に `401 wipe_required` | [accounts-and-auth.md](accounts-and-auth.md) の 6.3 節 |
| security | editor-and-descriptions | 本文の版を消す管理者の操作 | [editor-and-descriptions.md](editor-and-descriptions.md) の 4.7 節、DT-PERM-003 |
| security、[infrastructure.md](infrastructure.md) | （定義の文書なし → permissions-and-teams） | `workspaces.status` に `pending_deletion`・`moving`、`deletion_requested_at` | [permissions-and-teams.md](permissions-and-teams.md) の 3.3 節 |
| observability | sync-engine | `sync_outbox.committed_at`、`deltas` に `c`、`pong` に Gateway の時刻、`welcome.audit_followup` | [sync-engine.md](sync-engine.md) の 7.1・9.2 節 |
| [delivery.md](delivery.md) | sync-engine | `hello.build` を殻とレンダラーの組（`shell@x.y.z+web@<hash>`） | 同 9.2 節 |
| delivery | client-store-and-offline | `_meta.flags` | [client-store-and-offline.md](client-store-and-offline.md) の 3.2 節 |
| [editor-and-descriptions.md](editor-and-descriptions.md) | client-store-and-offline | `_doc_state`・`_doc_updates` の store | 同上 |
| [issues-and-workflow.md](issues-and-workflow.md) | client-store-and-offline | `_drafts` の store | 同上 |
| [client-app.md](client-app.md) | client-store-and-offline | M2 の列 `identifier`・`title_norm` | 同 7.1 節 |
| [capacity.md](capacity.md) | issues-and-workflow | ADR-0023 の自動の処理の流量を `worker` の枠に合わせる | [ADR-0023](../decisions/0023-workflow-states-and-lifecycle-automation.md) の注記、[issues-and-workflow.md](issues-and-workflow.md) の 13 節 |
| [permissions-and-teams.md](permissions-and-teams.md)、[cycles-and-projects.md](cycles-and-projects.md)、[views-and-filters.md](views-and-filters.md) | data-model-and-schema | `workspace_members`・`team_row`・`view_scope` の規則、`teams` の結び付けのモデルからの読み方、`guest_visible` の注記の検査、`counter` の `derive_only`、M2 の列と `packages/filter` の突き合わせ | [data-model-and-schema.md](data-model-and-schema.md) の 3.2・3.4・3.5・4.1 節 |

## 9. 統合で決めたこと（2026-09-28）

- **`workspaces` の表（`Workspace` のモデル）の持ち主は permissions-and-teams。** slug、名前、タイムゾーン、リージョン、状態（`active`・`pending_deletion`・`moving`）、`deletion_requested_at` を `Workspace`（`workspace` のグループ）に、ログインの手段の制限・招待・API・Slack の展開・催促・既定のチームの設定を `WorkspaceSettings`（`members` のグループ）に分けた（[permissions-and-teams.md](permissions-and-teams.md) の 3.3 節）。表は RLS の中に置き、コンテキストの前の slug の解決は関数 `resolve_workspace_slug` にした（3 節）。
- **RLS の外の表**：`sync_outbox`・`client_devices`・`narrowing_outbox` は RLS の外（Relay・Gateway がワークスペースを決める前、またはまたいで読むため。行は ID と数だけ）。`oauth_apps` と `workspaces` は RLS の中に置き、関数で決まった列だけを返す（3 節）。
- **DB のロールの一覧**（2 節）を確定した。
- [sync-engine.md](sync-engine.md) の 8.1 節の例を、ADR-0019 の規則の形（`{ rule, from }`）に揃えた。
- **保持の期間の正本は [security.md](security.md) の 9 節**。`convergence_audits`・`convergence_mismatches`・`notification_keys`・`narrowing_outbox`・`narrowing_journal`・配信の監査の抜き取りの行を足した。
- **`teams` の規則は、行の中の集合から読まない。** 結び付けのモデル（`ProjectTeam`）から読む（[data-model-and-schema.md](data-model-and-schema.md) の 3.5 節）。行の中の集合からグループを決めると、公開のチームの人に非公開のチームの ID が届くため。

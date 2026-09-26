# Data model: GitHub

メタデータの正本は Aurora PostgreSQL、リポジトリの中身の正本は Git（[ADR-0005](../decisions/0005-git-as-source-of-truth.md)）。権限はテナントの RLS ではなく、リポジトリの単位の判定関数で守る（[ADR-0002](../decisions/0002-repository-permission-model.md)）。ID は数値の `id`（REST・Webhook に出す）と、GraphQL と共通の `node_id`（型と `id` を符号化した不透明な文字列）を持つ（[api-and-webhooks.md](api-and-webhooks.md) の 3.1 節）。

ここには中核のテーブルと、領域ごとのテーブルの索引だけを置く。列の定義は各領域の文書を正とする。実装の変更（`changes/`）でマイグレーションを書くときに、ここと各文書を合わせて更新する。

## 1. 中核のテーブル

```sql
-- アカウントと名前空間
users              (id, login, ...)                             -- Better Auth の user。login は大文字小文字を区別せず一意
organizations      (id, login, base_permission,                 -- none / read / write / admin（既定 read）
                    members_can_fork_private, two_factor_required, ...)
owners             (id, kind, login, ...)                       -- users と organizations の共通の名前空間。login の一意性と変更の履歴
org_memberships    (org_id, user_id, role)                      -- owner / member
teams              (id, org_id, parent_team_id NULL, name, privacy)  -- visible / secret
team_memberships   (team_id, user_id, role)                     -- maintainer / member
team_closure       (ancestor_id, descendant_id, depth)

-- リポジトリと権限
repositories       (id, owner_id, name, visibility,             -- public / private / internal（internal は E10）
                    network_id, parent_repo_id NULL,            -- fork の親
                    default_branch, archived_at, disabled_reason NULL,
                    next_issue_number,                          -- Issue と PR で共有する採番（ADR-0017）
                    deleted_at NULL, created_at,
                    UNIQUE (owner_id, lower(name)) WHERE deleted_at IS NULL)
repository_collaborators (repo_id, user_id, role)               -- read / triage / write / maintain / admin
team_repository_roles    (team_id, repo_id, role)
permission_epochs  (scope_kind, scope_id, epoch)                -- 権限のキャッシュの世代（identity-and-permissions.md の 9 節）

-- Git のストレージ（ルーティングと合意）
repository_networks (network_id, root_repo_id, visibility_class, size_bytes, placement_class)
network_replicas    (network_id, node_id, state)                -- healthy / out_of_sync / creating / removing
storage_nodes       (node_id, az, state, capacity_bytes, used_bytes, weight)
repository_checksums (repo_id, checksum, version, pending_version NULL)  -- ref の状態の要約と通し番号（ADR-0006）
ref_transactions    (txn_id, repo_id, base_version, state, updates, created_at)

-- Git の写し（正本ではない。ADR-0005）
repository_refs     (repo_id, ref_name, sha, updated_version)   -- fillfactor = 70（capacity.md の 3.4 節）
push_events         (repo_id, version, pusher_id, via, updates, occurred_at)  -- 失った push の列挙と監査に使う

-- Issue と Pull Request（ADR-0017）
issues             (id, repo_id, number, author_id, title, body, state, state_reason,
                    locked, lock_reason, type_id NULL, milestone_id NULL,
                    created_at, updated_at, closed_at,
                    UNIQUE (repo_id, number))
pull_requests      (issue_id, base_repo_id, base_ref, head_repo_id, head_ref,
                    base_sha, head_sha, merge_base_sha,          -- 写し（ADR-0005）
                    draft, maintainer_can_modify, merged_at, merge_commit_sha)

-- 連携
outbox             (id, repo_id NULL, event_type, payload, trace_context, created_at)
audit_events       (...)                                        -- 追記のみ（ADR-0029）
platform_audit_events (...)                                     -- 運用者の措置、アカウントの削除の完了など（ADR-0029）
```

- **リポジトリのデータを持つテーブルは、すべて `repo_id` を持つ**（PR は base のリポジトリ）。`packages/authz` の外から権限の表（`repository_collaborators`・`team_repository_roles`・`org_memberships` など）を読むことと、判定を経ずに `repo_id` を持つテーブルを読むことを lint で禁止する（ADR-0002、[ADR-0018](../decisions/0018-repository-roles-and-permission-composition.md)）。
- **一覧・検索は、判定の結果で前段から絞る。** `accessPredicate(actor)` の条件（公開の種類、持ち主、リポジトリの ID の集合）をクエリの `WHERE` に入れる（[identity-and-permissions.md](identity-and-permissions.md) の 5.1 節）。後から除かない。
- **Git の写しは正本ではない。** `repository_refs`・`pull_requests` の SHA は push の Event（`version` の順）で更新し、食い違ったら Git から作り直す。マージの判定は必ず Git の現在の ref で行う（[pull-requests.md](pull-requests.md) の 6.2 節）。
- **push の成功の確定と、outbox の Event は同じトランザクション**（`repository_checksums` の更新、`push_events`、`outbox`。[git-storage.md](git-storage.md) の 5.2 節）。
- ディスク上のパスは名前ではなく `network_id`・`repo_id` から作る。名前の変更・移管でパスは変わらない。
- 削除は論理削除（`deleted_at`）から始め、90 日の後に消去のジョブで消す。消去の対象のテーブルの一覧はスキーマの定義から得て、CI で漏れを検査する（[ADR-0030](../decisions/0030-data-retention-and-deletion.md)）。

## 2. 領域ごとの追加

上の中核に加えて、各領域の設計で次のテーブルを定めた。定義は、それぞれの文書を正とする。

| 領域 | テーブル | 定義の場所 |
| --- | --- | --- |
| 認証 | Better Auth が持つテーブル（`users`、`sessions`、`passkeys`、`two_factors`、`verifications`） | [identity-and-permissions.md](identity-and-permissions.md) の 11 節、[ADR-0019](../decisions/0019-authentication-and-token-model.md) |
| 認証・資格情報 | `user_emails`、`org_invitations`、`repository_invitations`、`user_blocks`・`org_blocks`、`ssh_keys`、`deploy_keys`、`gpg_keys`、`commit_verifications`、`personal_access_tokens`、`pat_repositories`、`credential_sso_authorizations`（E10） | [identity-and-permissions.md](identity-and-permissions.md) の 11 節 |
| Git のストレージ | `repair_jobs`（上の中核のルーティング・合意の表に加えて） | [git-storage.md](git-storage.md) の 4.1 節 |
| Git のプロトコル | LFS の objects の表（`lfs_objects`：`network_id`、oid、大きさ、verify の日時）、LFS の容量と転送量の計数 | [git-protocols.md](git-protocols.md) の 7 節、[ADR-0009](../decisions/0009-lfs-storage-on-s3.md) |
| Pull Request | `pull_request_merge_states`、`pull_request_reviews`、`review_threads`・`review_comments`、`review_requests`、`pull_request_merges`、`auto_merge_requests`、`pull_request_events` | [pull-requests.md](pull-requests.md) の 13 節 |
| ruleset・merge queue | `rulesets`、`ruleset_rules`、`ruleset_bypass_actors`、`ruleset_evaluations`、`merge_queue_entries`、`merge_groups` | [pull-requests.md](pull-requests.md) の 13 節、[ADR-0011](../decisions/0011-rulesets-as-single-protection-model.md)、[ADR-0012](../decisions/0012-merge-queue-with-speculative-groups.md) |
| Issue | `labels`、`milestones`、`issue_types`、`sub_issues`、`issue_assignees`、`issue_labels`、`issue_events`、`issue_references`、`reactions`、`pinned_issues`、`issue_redirects`、`user_content_edits` | [issues.md](issues.md) |
| 通知 | `repo_watches`、`thread_subscriptions`、`notification_inbox`（`user_id` のハッシュで 64 分割）、`user_notification_prefs`、`user_org_email_routes`、`notification_deliveries` | [notifications.md](notifications.md) |
| 検索 | `code_index_shards`、`code_index_placements`、`code_index_state`、`search_exclusions` | [search.md](search.md)、[ADR-0015](../decisions/0015-search-permission-filtering.md) |
| API・App・Webhook | `apps`、`app_keys`、`app_client_secrets`、`app_installations`、`app_installation_repositories`、`app_permission_requests`、`installation_tokens`（時間でパーティション）、`app_user_tokens`、`oauth_apps`、`oauth_tokens`、`org_oauth_app_approvals`、`webhooks`、`webhook_deliveries`（日でパーティション）、`webhook_delivery_attempts`、`idempotency_keys` | [api-and-webhooks.md](api-and-webhooks.md) の 12 節 |
| Actions | `workflow_runs`、`workflow_jobs`（`queued` の行がキューの正本）、`job_steps`、`job_action_resolutions`、`concurrency_groups`、`owner_actions_limits`、`actions_secrets`、`actions_secret_keys`、`environments`、`environment_reviewers`、`deployment_reviews`、`runners`、`runner_groups`、`artifacts`、`cache_entries`、`oidc_sub_templates`、`actions_usage` | [actions.md](actions.md) の 15 節 |
| 監査 | `audit_events`（追記のみ、ハッシュの連鎖）、`platform_audit_events`、Git のアクセスログ（DB の外。90 日） | [ADR-0029](../decisions/0029-audit-log.md)、[security.md](security.md) の 14 節 |
| 削除と保持 | 名前の予約（`name_reservations`）、名前の変更・移管の転送（`repository_redirects`）、消去の予定と削除の記録（バックアップと別に 35 日以上）、リーガルホールド | [ADR-0030](../decisions/0030-data-retention-and-deletion.md)、[identity-and-permissions.md](identity-and-permissions.md) の 14 節、[web.md](web.md) の 2 節 |

- `lfs_objects`・`push_events`・`repository_refs`・`name_reservations`・`repository_redirects`・`issue_assignees`・`issue_labels` の名前は、この索引で仮に付けた。定義は各文書の記述から作る。
- S2 の候補：実効のロールの事前計算の表（`effective_repo_roles`）。Organization の大きさで判定の遅さを測ってから採るかを決める（[identity-and-permissions.md](identity-and-permissions.md) の 13 節）。
- 更新の多いテーブルの設定（`fillfactor`、パーティション、古いパーティションの `DROP`）は [capacity.md](capacity.md) の 3.4 節にある。
- Aurora の外に置くもの：Git の中身（ストレージのノード）、LFS・成果物・ログ・キャッシュ・バックアップ（S3）、検索の索引（Zoekt・OpenSearch）、権限・ルーティング・レート制限のキャッシュとログのライブ表示（Valkey）。どれも正本は上の表か Git にあり、作り直せる。

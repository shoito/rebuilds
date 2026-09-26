# Data model: Notion

データモデルの索引。全テーブルの置き場所と要点を並べ、定義は各文書へ案内する。**定義の正は、各文書と ADR にある。** ここと食い違ったら、各文書を正とし、ここを直す。実装の変更（`changes/`）でマイグレーションを書くときは、ここと各文書を合わせて更新する。

前提の決定：

- すべてはブロック（[ADR-0002](../decisions/0002-everything-is-a-block.md)）
- ワークスペースで RLS と論理シャード（[ADR-0003](../decisions/0003-workspace-sharding.md)）、論理シャードは PostgreSQL のスキーマ（[ADR-0027](../decisions/0027-shard-router.md)）
- 変更はトランザクションとページごとの `seq`（[ADR-0005](../decisions/0005-transactions-as-unit-of-change.md)）
- テナントの中のデータは `member_id` を参照し、`account_id` を参照しない（[ADR-0021](../decisions/0021-accounts-members-guests-and-teamspaces.md)）
- ID は UUIDv7（[block-model.md](block-model.md) の 6 節）

## 1. 配置

```
Aurora の物理クラスタ
 ├─ global                       … シャードに分けないもの（RLS なし。専用のモジュールだけが触れる）
 └─ shard000 〜 shard479         … 論理シャード。同じテーブルの一式（RLS あり）
```

| 置き場所 | 規則 |
| --- | --- |
| `global` | ワークスペースをまたぐものだけ：アカウントと認証、ワークスペースの一覧と所在、シャードの割り当て、マイグレーションの台帳、公開の連携の定義 |
| `shardNNN` | ブロックと、ブロックから外部キーでたどれるもののすべて（本家と同じ方針。[Herding elephants](https://www.notion.com/blog/sharding-postgres-at-notion)） |
| DB の外 | 検索の索引（OpenSearch）、ページのスナップショットの本体とファイル（S3）、配信のバス（Valkey）、データレイク（S3） |
| クライアント | ローカルの保存（SQLite（WASM、OPFS）。5 節） |

シャードのテーブルの規則（Slack の [data-model.md](../../../slack/docs/architecture/data-model.md) と同じ）：

- 全テーブルが `workspace_id` を持ち、主キー・外部キーは `workspace_id` を含む複合キーにする。
- `ENABLE`・`FORCE ROW LEVEL SECURITY` とポリシーを、テーブルの作成と同じマイグレーションで付ける。
- 索引は `workspace_id` を先頭に置く。
- マイグレーションは 1 シャード分の変更として書き、群れの順に 480 のスキーマへ当てる（[ADR-0031](../decisions/0031-migration-rollout-by-shard-groups.md)）。
- 論理レプリケーション（再シャーディング、CDC）のため、全テーブルに主キーを持たせる。シーケンスに頼らない（[ADR-0028](../decisions/0028-zero-downtime-resharding.md)）。例外（`outbox` の `id`）は、切り替えの前に移動先のシーケンスを進める。
- ブロックの表の名前は単数形の `block` にする（[block-model.md](block-model.md) の 11 節）。`blocks` とは書かない。

## 2. `global`

```sql
accounts          (id, email, email_verified_at, created_at, deleted_at)
sessions          (id, account_id, ..., expires_at, revoked_at)          -- Slack の ADR-0012（Better Auth）を先例にする
auth_identities   (account_id, provider, subject, ...)
workspaces        (id, slug, name, region, logical_shard, status,        -- logical_shard は ID から計算した値の控え（ADR-0027）
                   created_at)
shard_map         (region, logical_shard, cluster_id,
                   state,                                                -- active / frozen / fenced
                   version, updated_at,
                   PRIMARY KEY (region, logical_shard))
shard_groups      (logical_shard, migration_group)                       -- G0〜G3（ADR-0031）
migration_ledger  (logical_shard, last_applied, status, updated_at)     -- 各シャードの schema_migrations の集約
public_integrations (id, name, owner_account_id, redirect_uris,          -- 公開の連携（OAuth のクライアント）の定義
                   capabilities, created_at)
search_cluster_map (logical_shard, search_cluster)                       -- S2 から（search.md の 9.2 節）
```

- アカウントと認証の形は [permissions-and-sharing.md](permissions-and-sharing.md) の 2.1 節と Slack の identity-and-access.md に従う。
- `region` は S1 では常に東京。S3 の複数リージョン（[infrastructure.md](infrastructure.md) の 11 節）のために最初から持つ。
- ワークスペースの権限の版（`acl_version`）は `global.workspaces` ではなく、シャードの `workspace_acl_version` に置く。権限の変更と同じトランザクションで上げるため（1 つのトランザクションは 1 つのシャードで閉じる。[ADR-0019](../decisions/0019-workspace-acl-version-cache.md)）。

## 3. 各シャード（`shardNNN`）

### 3.1 ブロック・履歴・共同編集

| テーブル | 要点 | 正 |
| --- | --- | --- |
| `block` | すべてのブロック（ページ、データベースの行を含む）。`type`、`properties`、`format`、`parent_type`（`workspace` / `teamspace` / `block` / `data_source`）、`parent_id`、`page_id`、`content`、`synced_from`、`alive`、`trashed_at`、`purged_at`、`version`。主キー `(workspace_id, id)` | [block-model.md](block-model.md) の 2・11 節 |
| `page_seq` | ページごとの `seq` の採番（`page_id`、`last_seq`）。行ロックがページの書き込みの直列化になる | [collaboration.md](collaboration.md) の 7 節 |
| `page_ops` | 操作のログ（`page_id`、`seq`、`tx_id`、`actor_id`、`device_id`、`ops`、`client_created_at`、`committed_at`）。差分取得の元。30 日保持。時間でパーティション | [collaboration.md](collaboration.md) の 7・8 節 |
| `block_text_state` | ブロックのテキストの CRDT の状態（Fugue＋Peritext） | [collaboration.md](collaboration.md) の 5 節、[ADR-0010](../decisions/0010-text-crdt-with-server-ordered-structure.md) |
| `text_slices` | テキストのインスタンスと ID の範囲 → 今それを持つブロック（分割・結合） | [collaboration.md](collaboration.md) の 5.3 節 |
| `device_cursors` | 端末ごとに適用済みの `tx_counter` の最大値（冪等） | [collaboration.md](collaboration.md) の 4 節 |
| `sync_conflicts` | 上書き・不適用になった操作の記録。30 日 | [collaboration.md](collaboration.md) の 6・11.5 節、[ADR-0011](../decisions/0011-structural-and-property-conflict-rules.md) |
| `outbox` | 配信とジョブのイベント（`id`、`page_id`、`event_type`、`payload`、`trace_context`）。論理シャードごとに Relay がリースを持って `id` の順に読む。時間でパーティションを切り `DROP` する | [collaboration.md](collaboration.md) の 7.3 節、[capacity.md](capacity.md) の 3.1 節 |
| `page_snapshot` | 履歴のスナップショットの目録（`page_id`、`seq`、`editors`、`s3_key`、`size`）。本体は S3 | [block-model.md](block-model.md) の 8 節 |
| `page_activity` | ページの更新の欄の要約（人と 10 分の窓） | [comments-and-notifications.md](comments-and-notifications.md) の 6.1 節 |
| `files` | アップロードしたファイルの記録（`storage_key` は `ws/{workspace_id}/...`、スキャンの状態） | [block-model.md](block-model.md) の 3 節、[infrastructure.md](infrastructure.md) の 5 節 |
| `schema_migrations` | このシャードに当てたマイグレーション | [ADR-0031](../decisions/0031-migration-rollout-by-shard-groups.md) |

### 3.2 データベース

| テーブル | 要点 | 正 |
| --- | --- | --- |
| `data_source` | スキーマ（プロパティ ID → 名前・種類・設定）、親の `database` ブロック、行の数、固有の ACL を持つ行の数。ブロックではない | [databases.md](databases.md) の 2 節 |
| `view` | 対象の `data_source_id`、種類、フィルタ・並べ替え・グループの設定 | [databases.md](databases.md) の 4 節 |
| `view_member_overrides` | 「自分だけ」のフィルタ・並べ替え。配信しない | [databases.md](databases.md) の 4 節 |
| `relation_edge` | リレーションの辺（`from_property_id`、`from_row_id`、`to_row_id`、`from_pos`、`to_pos`）。リレーションの値の正本 | [databases.md](databases.md) の 6 節、[ADR-0016](../decisions/0016-relation-edges-as-single-source.md) |
| `dbx_row` | 問い合わせの索引（行ごと） | [databases.md](databases.md) の 3.1 節、[ADR-0014](../decisions/0014-database-query-index.md) |
| `dbx_value` | 問い合わせの索引（プロパティの値ごと。`v_text`・`v_num`・`v_ts`・`v_ts_end`・`v_bool`・`v_ref`）。数式・ロールアップの実体化した値も入る | 同上、[ADR-0015](../decisions/0015-formula-evaluation-model.md) |

- 行は `block`（`type = page`、`parent_type = data_source`）で、`data_source` の `content` には並べない（[block-model.md](block-model.md) の 5 節）。

### 3.3 メンバー・権限・共有

| テーブル | 要点 | 正 |
| --- | --- | --- |
| `members` | `account_id`（連携は NULL）、`kind`（`human` / `bot`）、`role`（`owner` / `membership_admin` / `member` / `guest`）、表示名、無効化日時、個人のページの並び | [permissions-and-sharing.md](permissions-and-sharing.md) の 2・10 節、[ADR-0021](../decisions/0021-accounts-members-guests-and-teamspaces.md) |
| `groups`、`group_members` | グループ（メンバーだけ） | 同上の 2.4 節 |
| `teamspaces`、`teamspace_members` | 種類、`member_access_level`、`workspace_access_level`、最上位のページの並び。メンバーのロール（`owner` / `member`） | 同上の 3 節 |
| `page_acls`、`page_acl_entries` | ACL を持つページとその項目（`principal`、`level`、`expires_at`） | 同上の 4.3 節、[ADR-0018](../decisions/0018-permission-levels-and-inheritance.md) |
| `page_general_access` | 一般アクセス（`workspace` / `public`、`hide_from_search`、`expires_at`） | 同上の 4.3・7 節 |
| `workspace_acl_version` | ワークスペースの権限の版 | 同上の 5 節、[ADR-0019](../decisions/0019-workspace-acl-version-cache.md) |
| `workspace_security_policies` | 公開・ゲスト・エクスポート・連携の禁止（Enterprise） | 同上の 10 節 |
| `guest_requests` | ゲストの追加の申請（Enterprise） | 同上 |
| `published_sites` | 公開サイト（`page_id`、`slug`、`search_indexing`、`allow_duplicate`、公開・取り下げの日時、濫用による停止） | 同上の 8 節、[ADR-0020](../decisions/0020-published-pages-isolation.md) |

### 3.4 コメント・通知

| テーブル | 要点 | 正 |
| --- | --- | --- |
| `discussions` | `page_id`、`anchor_kind`（`page` / `block` / `text` / `property`）、解決、`anchor_lost` | [comments-and-notifications.md](comments-and-notifications.md) の 2 節 |
| `comments`、`comment_reactions` | 本文（リッチテキスト）、添付（3 件まで）、リアクション | 同上 |
| `mentions`、`backlinks` | メンションの記録（新しいメンションにだけ通知）、ページのバックリンク | 同上の 3 節 |
| `reminders` | `fire_at`（UTC）、`tz`、`state`。論理シャードごとのスケジューラーが読む | 同上の 4 節 |
| `page_subscriptions` | ページの購読の水準 | 同上の 5.1 節 |
| `inbox_items` | 受信箱（ID と種類だけ。タイトルや本文の写しを持たない）。180 日 | 同上の 5.3 節 |
| `notification_pending_emails` | メールの送信待ち | 同上の 5 節 |

### 3.5 連携・API・MCP

| テーブル | 要点 | 正 |
| --- | --- | --- |
| `integrations` | 内部の連携（ワークスペースの所有者が作る）。能力、`bot` のメンバー | [api-and-integrations.md](api-and-integrations.md) の 3 節、[ADR-0024](../decisions/0024-integration-access-model.md) |
| `integration_installations` | 公開の連携のインストール（`global.public_integrations` を ID で指す。外部キーは張らない） | 同上 |
| `api_tokens` | 内部の連携のトークン、公開の連携のアクセス・リフレッシュトークン（ハッシュだけ） | 同上の 3.1 節 |
| `webhook_subscriptions`、`webhook_deliveries` | 購読（URL、種類、`verification_token`、停止）と配送の記録 | 同上の 6 節、[ADR-0025](../decisions/0025-webhook-delivery.md) |
| `idempotency_keys` | `POST` の `Idempotency-Key` と応答。24 時間 | 同上の 4.2 節 |
| `mcp_grants` | MCP の同意（メンバー、クライアント、スコープ）と、管理者の許可 | 同上の 8 節、[ADR-0026](../decisions/0026-remote-mcp-server.md) |
| `import_jobs`、`export_jobs` | インポート・エクスポートのジョブの状態 | 同上の 7 節 |
| `rate_limit_overrides` | ワークスペース・連携ごとの上限の一時的な変更（監査ログに残す） | [capacity.md](capacity.md) の 3.5 節 |

### 3.6 セキュリティ・運用

| テーブル | 要点 | 正 |
| --- | --- | --- |
| `audit_events` | 監査ログ。操作と同じトランザクションで書き、Object Lock の S3 へ送る。DB に 365 日 | [security.md](security.md) の 6 節 |
| `deletion_jobs` | 物理削除・ワークスペースの削除の進み具合と再実行 | [security.md](security.md) の 7 節、[ADR-0022](../decisions/0022-trash-history-and-deletion-retention.md) |
| `abuse_reports` | 公開サイトの通報と確認の状態 | [security.md](security.md) の 8 節 |
| Relay のリース | 論理シャードごとのリース（物理クラスタの中に持つ） | [collaboration.md](collaboration.md) の 7.3 節 |

## 4. DB の外

| 置き場所 | 中身 | 正 |
| --- | --- | --- |
| OpenSearch（別名 `pages`） | ページ単位の文書（`access_keys`、`acl_source_id`、`index_version`、`acl_version`） | [search.md](search.md) の 3 節、[ADR-0023](../decisions/0023-search-engine-and-permission-filtering.md) |
| S3 | ファイル（`ws/{workspace_id}/...`）、スナップショットの本体（`workspaces/{workspace_id}/pages/{page_id}/snapshots/{seq}.json.gz`）、エクスポートの成果物（7 日）、監査ログのアーカイブ | [block-model.md](block-model.md) の 8 節、[infrastructure.md](infrastructure.md) の 5 節 |
| Valkey | ページのチャンネル `ws:{w}:pg:{page_id}`、メンバー、権限の変更、在席（TTL 90 秒） | [collaboration.md](collaboration.md) の 7.2・9 節 |
| データレイク | S1 は Aurora の日次のエクスポート（Parquet）、S2 は CDC | [infrastructure.md](infrastructure.md) の 10 節、[ADR-0030](../decisions/0030-cdc-data-lake.md) |

## 5. クライアント（ローカルの保存）

SQLite（WASM、`opfs-sahpool`）。アカウントごとにファイルを分け、ログアウトで消す（[ADR-0008](../decisions/0008-sqlite-wasm-opfs-local-store.md)、[ADR-0013](../decisions/0013-offline-availability-policy.md)）。

| テーブル | 要点 | 正 |
| --- | --- | --- |
| `record` | レコードの写し（`(table, workspace_id, id)`、値、`version`）。LRU で追い出す | [editor.md](editor.md) の 10 節 |
| `text_state` | ブロックのテキストの CRDT の状態 | 同上、[collaboration.md](collaboration.md) の 11.2 節 |
| `transaction_queue` | 未確定のトランザクション（FIFO）。追い出さない | 同上 |
| `offline_page`、`offline_action` | オフラインで使うページと理由 | 同上、[collaboration.md](collaboration.md) の 11.1 節 |
| `failed_changes` | 送れなかった変更（30 日） | [collaboration.md](collaboration.md) の 10.1 節 |
| `meta` | スキーマの版、総量 | [editor.md](editor.md) の 10 節 |

## 6. テナントのコンテキスト

```
Request ─▶ 認証（global のセッションから account を得る）
        ─▶ パスの workspace_id から member を解決する（なければ 404）
        ─▶ shard-router：logical_shard → 物理クラスタ → 接続
            BEGIN; SET LOCAL search_path = shardNNN;
                   SET LOCAL app.workspace_id = …; SET LOCAL app.member_id = …
        ─▶ ハンドラー（以降のクエリはすべて RLS の下）
        ─▶ COMMIT
```

- DB ロールは `migrator`（所有者）、`app`（RLS の対象。既定の `search_path` は空）、`relay`（`outbox` のみ）、`replicator`（論理レプリケーション。再シャーディングと CDC）に分ける。`app` は `BYPASSRLS` を持たない。
- Worker は、ジョブが持つ `workspace_id` でルーターを通してから処理する。
- 公開 API はパスにワークスペースを含めず、トークンの `workspace_id` から解決する（[api-and-integrations.md](api-and-integrations.md) の 2 節）。

## 7. 未整理の点

- テーブル名の単数・複数が混在している（ブロックと共同編集・データベースは単数、権限・コメント・連携は複数）。`block` は単数に揃えた。ほかは、開発リポジトリの最初のマイグレーションの前に Dev が決め、この表と各文書を揃える。
- 連携・MCP・ジョブの表（3.5・3.6 節）は、各文書に列の定義がない。E7・E8 の Story の `spec.md` で定める。

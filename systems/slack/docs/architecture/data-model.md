# Data model: Slack

テナントの分離は [ADR-0009](../decisions/0009-pooled-tenancy-with-rls.md)、アカウントとメンバーの関係は [ADR-0010](../decisions/0010-accounts-and-workspace-members.md) に従う。ID はすべて UUIDv7。

```sql
-- テナントの外（RLS なし）
accounts        (id, email, auth_provider, created_at)          -- 認証のためだけ
workspaces      (id, name, created_at)

-- テナントの中（すべて workspace_id を持ち、RLS を有効にする）
members         (workspace_id, id, account_id NULL,              -- NULL はボット / エージェント
                 display_name, real_name, avatar_key,
                 role,                                           -- owner / admin / member / guest
                 deactivated_at, created_at,
                 PRIMARY KEY (workspace_id, id),
                 UNIQUE (workspace_id, account_id))

channels        (workspace_id, id, kind, name, is_private,       -- kind: channel / dm / group_dm
                 last_seq, created_at,
                 PRIMARY KEY (workspace_id, id))
channel_members (workspace_id, channel_id, member_id,
                 last_read_seq, notify_level, joined_at,
                 PRIMARY KEY (workspace_id, channel_id, member_id))

messages        (workspace_id, id, channel_id, seq, member_id,
                 thread_root_id NULL,                            -- スレッド返信なら親メッセージ
                 body, body_format,
                 client_msg_id,                                  -- 冪等キー
                 reply_count, last_reply_at,                     -- スレッド親に非正規化
                 edited_at, deleted_at, created_at,
                 PRIMARY KEY (workspace_id, id),
                 UNIQUE (workspace_id, channel_id, seq),
                 UNIQUE (workspace_id, channel_id, member_id, client_msg_id))

reactions       (workspace_id, message_id, member_id, emoji, created_at,
                 PRIMARY KEY (workspace_id, message_id, member_id, emoji))
mentions        (workspace_id, message_id, member_id, channel_id, created_at)
files           (workspace_id, id, uploader_member_id,
                 storage_key,                                    -- ws/{workspace_id}/files/{id}
                 mime, size, created_at,
                 PRIMARY KEY (workspace_id, id))
message_files   (workspace_id, message_id, file_id)

outbox          (id BIGSERIAL, workspace_id, channel_id, event_type, payload JSONB, created_at)
```

- **外部キーはすべて `workspace_id` を含む複合キーにする**（例：`messages (workspace_id, channel_id)` → `channels (workspace_id, id)`）。別テナントの行を参照するデータは、DB が拒否する。
- **テナントの中のデータは `member_id` を参照し、`account_id` を参照しない**（ADR-0010）。
- **インデックスは `workspace_id` を先頭に置く。** RLS のポリシーがクエリの条件に加わるため。
- **`seq`（チャンネル内の連番）が設計の中心**（[ADR-0001](../decisions/0001-per-channel-sequence.md)）。表示順、欠損検知、既読位置、差分取得のすべてを `seq` で表す。
- `channels.last_seq` を `UPDATE ... SET last_seq = last_seq + 1 RETURNING last_seq` で採番し、メッセージの INSERT と同じトランザクションで行う。チャンネル単位の行ロックになるが、1 チャンネルへの投稿頻度は低いので問題にならない。
- 編集・削除・リアクションも、`seq` を消費するイベントとして outbox に積む。メッセージ本体の `seq` は変わらない。

## テナントのコンテキスト

```
Request ─▶ 認証ミドルウェア
            1. セッションから account_id を得る
            2. パスの workspace_id と account_id から member を解決する（なければ 404）
            3. BEGIN; SET LOCAL app.workspace_id = …; SET LOCAL app.member_id = …
         ─▶ ハンドラー（以降のクエリはすべて RLS の下で実行される）
         ─▶ COMMIT（SET LOCAL の値はここで消える）
```

- API のパスは `/workspaces/{workspace_id}/...` の形にし、テナントを明示する。内部 API は `/api` を接頭辞に持つ（Web と同じオリジンで SPA のルートと分けるため。例：`/api/workspaces/{ws}/channels`）。設計文書では、接頭辞を省いて書くことがある。
- DB ロールは `migrator`（所有者）、`app`（RLS の対象）、`relay`（`outbox` のみ）に分ける。`app` は `BYPASSRLS` を持たない。
- Worker は、ジョブが持つ `workspace_id` でコンテキストを設定してから処理する。


## 領域ごとの追加

上のモデルは中核のテーブルだけを示す。各領域の設計で、次のテーブルと列を追加した。定義は、それぞれの文書を正とする。実装の変更（`changes/`）でマイグレーションを書くときに、ここと各文書を合わせて更新する。

| 領域 | テーブル・列 | 定義の場所 |
| --- | --- | --- |
| 認証 | Better Auth が持つテーブル（`accounts` を Better Auth の user として使う、`sessions`、`verifications`、`passkeys`、`two_factors`、`sso_providers`） | [identity-and-access.md](identity-and-access.md)、[ADR-0012](../decisions/0012-self-hosted-auth-with-better-auth.md) |
| 認証 | `invitations`、`api_tokens`、`workspace_domains`、`workspace_auth_policies`、`workspace_sso_connections` | [identity-and-access.md](identity-and-access.md) |
| 認証 | `members.role` を `owner / admin / member / guest_multi / guest_single` にする | [identity-and-access.md](identity-and-access.md) |
| 会話 | `messages` に `also_send_to_channel`、`broadcast_mention`、`reply_member_ids`、`content_seq`、`last_reply_seq`。`mentions` に `seq` | [messaging.md](messaging.md)、[read-state-and-notifications.md](read-state-and-notifications.md) |
| 会話 | `thread_subscriptions`、`link_previews`、`message_unfurls`、`pins` | [messaging.md](messaging.md) |
| リアルタイム | `channel_events`（差分取得の元。`seq` を消費するイベントを保持する）、`outbox_dead`、`outbox` の時間でのパーティション、`outbox.trace_context` | [realtime.md](realtime.md)、[observability.md](observability.md) |
| 通知 | `member_notification_prefs`、`push_subscriptions`、`notification_log`、`notification_pending_emails` | [read-state-and-notifications.md](read-state-and-notifications.md) |
| 検索 | `search.message_docs`（RLS の例外。関数を経由してだけ読み書きする） | [search.md](search.md)、[ADR-0027](../decisions/0027-search-table-rls-exception.md) |
| ファイル | `files` のスキャンの状態、`message_files` に `UNIQUE (workspace_id, file_id)` | [files.md](files.md)、[ADR-0015](../decisions/0015-file-upload-scan-and-delivery.md) |
| アプリ・公開 API（E12） | アプリ、インストール、トークン、イベントの購読・配信の記録などのテーブル。`members.kind`（`human` / `bot` / `agent`）、`messages.ui_blocks`・`installation_id`、`api_tokens.installation_id`、`api_idempotency_keys` | [apps.md](apps.md)、[public-api.md](public-api.md)、[ADR-0031](../decisions/0031-app-platform.md) |
| プラン | `plans`、`workspace_entitlements` | [ADR-0032](../decisions/0032-plans-and-entitlements.md) |
| 会話の周辺 | `user_groups`・`user_group_members`、`scheduled_messages`、`custom_emoji`、`saved_items`、`channel_bookmarks` | [messaging.md](messaging.md) |
| プロフィール・リマインダー | `members` のプロフィールの列、`member_statuses`、`reminders` | [identity-and-access.md](identity-and-access.md)、[read-state-and-notifications.md](read-state-and-notifications.md) |
| 監査 | `audit_events`（追記のみ） | [ADR-0018](../decisions/0018-audit-log.md) |
| 保持と削除 | 保持ポリシー、リーガルホールド、エクスポート、削除の予定 | [ADR-0019](../decisions/0019-data-retention-and-deletion.md)、[security.md](security.md) の 14 節 |

- テナントの中のテーブルは、どれも ADR-0009 の規則（`workspace_id`、複合キー、`FORCE ROW LEVEL SECURITY`）に従う。例外は `search` スキーマだけ（ADR-0027）。
- 更新の多いテーブルの設定（`fillfactor`、VACUUM）は [capacity.md](capacity.md) の 3.1 節にある。

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

- API のパスは `/workspaces/{workspace_id}/...` の形にし、テナントを明示する。
- DB ロールは `migrator`（所有者）、`app`（RLS の対象）、`relay`（`outbox` のみ）に分ける。`app` は `BYPASSRLS` を持たない。
- Worker は、ジョブが持つ `workspace_id` でコンテキストを設定してから処理する。


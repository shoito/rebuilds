# Architecture: Slack

## 1. 全体構成

```
                ┌──────────────┐
  Browser ──────┤  CDN / LB    │
   │  ▲         └──────┬───────┘
   │  │ WebSocket      │ HTTPS
   │  │                ▼
   │  │         ┌──────────────┐   write (tx: message + outbox)   ┌────────────┐
   │  │         │  API server  │ ───────────────────────────────▶ │ PostgreSQL │
   │  │         └──────────────┘                                   └─────┬──────┘
   │  │                                                                  │ outbox
   │  │         ┌──────────────┐   subscribe ch:{id}  ┌───────────┐     ▼
   │  └─────────┤   Gateway    │ ◀─────────────────── │   Redis   │ ◀── Relay
   │            │ (WS 常時接続)│                       │  Pub/Sub  │     │
   │            └──────────────┘                       └───────────┘     │
   │                                                                     ▼
   │ upload (presigned URL)                             ┌──────────────────────┐
   └──────────────────────────▶ Object Storage (S3)     │ Workers              │
                                                        │  - search indexer    │
                                                        │  - notification      │
                                                        │  - thumbnail         │
                                                        └──────────────────────┘
```

| コンポーネント | 責務 |
| --- | --- |
| API server | 認証・認可、書き込みのすべて、履歴取得。**状態を持たない** |
| Gateway | WebSocket 接続の保持、購読管理、イベントのファンアウト。書き込みはしない |
| Relay | outbox テーブルを順に読み、Redis と各 Worker 向けキューに流す |
| Workers | 検索インデックス更新、通知（メール / Web Push）、サムネイル生成 |
| PostgreSQL | 唯一の正本（source of truth） |
| Redis | リアルタイム配信用のバス。**失われてもよい**（クライアントが差分取得で回復する） |

ポイントは **書き込み経路（API → DB）と配信経路（Relay → Gateway）を分ける** こと（[ADR-0002](decisions/0002-db-as-source-of-truth-with-outbox.md)）。配信が落ちてもデータは失われず、クライアントは再接続時の差分取得で追いつく。

## 2. データモデル

```sql
workspaces      (id, name, created_at)
users           (id, email, name, created_at)
memberships     (workspace_id, user_id, role)                 -- owner / admin / member / guest

channels        (id, workspace_id, kind, name, is_private,    -- kind: channel / dm / group_dm
                 last_seq, created_at)
channel_members (channel_id, user_id, last_read_seq, notify_level, joined_at)

messages        (id, channel_id, seq, user_id,
                 thread_root_id NULL,                         -- スレッド返信なら親メッセージ
                 body, body_format,
                 client_msg_id,                               -- 冪等キー
                 reply_count, last_reply_at,                  -- スレッド親に非正規化
                 edited_at, deleted_at, created_at,
                 UNIQUE (channel_id, seq),
                 UNIQUE (channel_id, user_id, client_msg_id))

reactions       (message_id, user_id, emoji, created_at, PRIMARY KEY (message_id, user_id, emoji))
mentions        (message_id, user_id, channel_id, created_at) -- メンション一覧・バッジ用
files           (id, workspace_id, uploader_id, storage_key, mime, size, created_at)
message_files   (message_id, file_id)

outbox          (id BIGSERIAL, channel_id, event_type, payload JSONB, created_at)
```

- **`seq`（チャンネル内の連番）が設計の中心**（[ADR-0001](decisions/0001-per-channel-sequence.md)）。表示順、欠損検知、既読位置、差分取得のすべてを `seq` で表す。
- `channels.last_seq` を `UPDATE ... SET last_seq = last_seq + 1 RETURNING last_seq` で採番し、メッセージの INSERT と同じトランザクションで行う。チャンネル単位の行ロックになるが、1 チャンネルへの投稿頻度は低いので問題にならない。
- 編集・削除・リアクションも、`seq` を消費するイベントとして outbox に積む。メッセージ本体の `seq` は変わらない。
- 全テーブルが `workspace_id` を直接または間接に持ち、将来はワークスペース単位でシャードできるようにする。

## 3. 主要フロー

### 3.1 投稿

1. クライアントが `client_msg_id`（UUID）を生成し、画面に「送信中」で仮表示する。
2. `POST /channels/{id}/messages` を送る。
3. API は 1 トランザクションで次を行う。
   - メンバーであることを確認する
   - `last_seq` を採番する
   - `messages` に INSERT する（`client_msg_id` の一意制約に当たったら、既存の行を返す）
   - `mentions` と `outbox` に INSERT する
4. コミット後、`seq` 付きのメッセージを返す。クライアントは仮表示を確定させる。
5. Relay が outbox を読み、Redis の `ch:{channel_id}` に publish する。
6. 購読中の Gateway が、接続中のメンバーへ WebSocket で push する。

### 3.2 再接続と差分取得

1. クライアントはチャンネルごとに「最後に受け取った `seq`」を保持する。
2. WebSocket で受け取ったイベントの `seq` が `last + 1` でなければ、欠損とみなす。
3. 再接続時・欠損検知時は `GET /channels/{id}/events?after_seq=N` で差分を取得し、`seq` 順に適用する。
4. 差分が多すぎる場合（例：1,000 件超）は差分を諦め、最新ページを取り直す。

これにより、**Redis や Gateway の配信を「ベストエフォート」にしても正しさが保たれる**。

### 3.3 既読と未読数

- 未読数は `channels.last_seq - channel_members.last_read_seq` を基本とする。自分の投稿やスレッド返信など、本来は数えないものが含まれても近似として許容する（正確な数よりもバッジの有無が重要なため）。
- 既読更新は `POST /channels/{id}/read {seq}` で行い、`GREATEST(last_read_seq, :seq)` で後退しないようにする。
- 既読イベントは、同じユーザーの他端末にだけ配信する。

## 4. 非機能要件

| ID | 項目 | 目標 |
| --- | --- | --- |
| NFR-001 | 規模（MVP 想定） | 1 ワークスペース最大 5,000 人、全体で同時接続 5 万 |
| NFR-002 | 送信 → 他者の画面に表示 | p99 500ms 以内（同一リージョン） |
| NFR-003 | メッセージ投稿 API | p99 200ms 以内 |
| NFR-004 | 可用性 | 月間 99.9% |
| NFR-005 | 耐久性 | 投稿 API が成功を返したメッセージは失わない |
| NFR-006 | 検索への反映 | 投稿から 10 秒以内 |

## 5. 技術スタック

| 層 | 選定 | AI エージェント視点での理由 |
| --- | --- | --- |
| 言語 | TypeScript（フロント・バック共通） | 型を API 契約として共有でき、エージェントが境界をまたいでも整合を保ちやすい |
| API | Hono RPC＋Zod | API の型をクライアントが直接参照し、生成を挟まずに契約を共有できる。入出力の変更が型検査の失敗として即座に見える（ADR-0008） |
| Gateway | Node.js＋`ws` | 同じ言語・同じイベント型を使える |
| DB | PostgreSQL 17＋Drizzle | SQL に近く、生成されるクエリが読みやすい。マイグレーションをレビューしやすい |
| Web | React＋TanStack Query＋Vite | 学習データが多く、エージェントの出力品質が安定する |
| テスト | Vitest、fast-check、Testcontainers、Playwright | 実 DB・実ブラウザで検証でき、モックで誤魔化せない |
| ローカル環境 | Docker Compose（Postgres、Redis、MinIO） | エージェントが 1 コマンドで起動・破棄できる |

詳細は [ADR-0007](decisions/0007-typescript-stack.md)、API の契約の持ち方は [ADR-0008](decisions/0008-hono-rpc-for-api-contract.md)。

## 6. 主な決定

| ADR | 決定 |
| --- | --- |
| [0001](decisions/0001-per-channel-sequence.md) | 順序付けはチャンネル内連番 `seq` |
| [0002](decisions/0002-db-as-source-of-truth-with-outbox.md) | DB を唯一の正本とし、配信はベストエフォート。連携は transactional outbox |
| [0003](decisions/0003-redis-pubsub-for-fanout.md) | リアルタイム配信のバスは Redis Pub/Sub |
| [0004](decisions/0004-postgres-fulltext-search-first.md) | 検索は PostgreSQL＋pg_bigm で始める |
| [0005](decisions/0005-single-authorization-check.md) | 権限判定を 1 つの関数に集約する |
| [0006](decisions/0006-message-body-ast.md) | 本文は独自の軽量 AST（JSON） |
| [0007](decisions/0007-typescript-stack.md) | TypeScript で統一した技術スタック |
| [0008](decisions/0008-hono-rpc-for-api-contract.md) | API の契約を Hono RPC の型で共有する。WebSocket イベントは Zod スキーマで検証する |

## 7. リスクと未解決事項

- **巨大チャンネル（数千人）のファンアウト**：1 投稿あたり数千件の push になる。Gateway 側で購読をチャンネル単位にまとめ、Redis からの受信を Gateway 1 台につき 1 回にする設計で足りるかは、負荷試験で確認する。
- **`last_seq` 採番のホットスポット**：全社アナウンスのように書き込みが集中するチャンネルでは、行ロックの待ちが発生しうる。書き込み頻度は低いため問題になりにくいと見込むが、計測する。
- **未読数の正確さ**：近似で許容したが、「未読 3 件と出ているのに見当たらない」はユーザーの不信を招く。
- **データ保持と削除**：保持期間ポリシーやリーガルホールドは MVP に含めていないが、企業利用では早い段階で要求される。

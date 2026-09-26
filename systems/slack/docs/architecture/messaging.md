# Messaging: Slack

投稿・編集・削除・スレッド・リアクション・メンション、本文の AST、リンクのプレビュー。順序付けは [ADR-0001](../decisions/0001-per-channel-sequence.md)、配信は [ADR-0002](../decisions/0002-db-as-source-of-truth-with-outbox.md)、権限は [ADR-0005](../decisions/0005-single-authorization-check.md)、本文は [ADR-0006](../decisions/0006-message-body-ast.md) に従う。

## 投稿

1. クライアントが `client_msg_id`（UUID）を生成し、画面に「送信中」で仮表示する。
2. `POST /workspaces/{ws}/channels/{id}/messages` を送る。
3. 認証ミドルウェアがメンバーを解決し、テナントのコンテキストを設定したトランザクションを開始する（[data-model.md](data-model.md) の「テナントのコンテキスト」）。API はその中で次を行う。
   - チャンネルのメンバーであることを確認する
   - `last_seq` を採番する
   - `messages` に INSERT する（`client_msg_id` の一意制約に当たったら、既存の行を返す）
   - `mentions` と `outbox` に INSERT する
4. コミット後、`seq` 付きのメッセージを返す。クライアントは仮表示を確定させる。
5. Relay が outbox を読み、Valkey の `ws:{workspace_id}:ch:{channel_id}` に publish する。
6. 購読中の Gateway が、接続中のメンバーへ WebSocket で push する。

## 共通の規則

- **チャンネルの状態を変える操作は、すべて `seq` を 1 つ消費するイベントになる。** 対象は投稿、スレッド返信、編集、削除、リアクションの追加・削除、リンクのプレビューの更新、ピン留め、添付ファイルの状態の変化。メッセージ本体の `seq`（作成時の値）は変わらない。
- **状態が変わらない操作は、イベントを作らず `seq` も消費しない。** 同じ本文での編集、削除済みの削除、付いているリアクションの追加などがこれにあたる。再送しても結果が同じになる（冪等）。
- 操作の前に、必ず判定関数（ADR-0005）でチャンネルを読めるかを確かめる。読めなければ 404 を返す（存在を漏らさない）。
- 削除済みのメッセージへの操作（編集、返信、リアクション、ピン留め）は 404 を返す。

## 編集

- `PATCH /workspaces/{ws}/channels/{ch}/messages/{id}` `{ body }`
- **編集できるのは投稿者だけ。** 管理者も他人の本文は編集できない。削除はできる（下記）。
- 時間の制限は設けない（MVP）。ワークスペース設定での制限は後回しにする。
- 本文の検証は投稿と同じ（長さ、AST のスキーマ、メンションの権限）。
- `messages.body` を上書きし、`edited_at` を設定する。
- メンションは作り直す（`mentions` を削除して再挿入）。**編集で増えたメンションには通知を送らない。** 通知を後から大量に送る手段にさせないため。メンション一覧には反映される。
- リンクが変わったら、プレビューを取り直す（「リンクのプレビュー」）。
- 競合は後勝ちとする。編集できるのは投稿者 1 人なので、実害は小さい。

### 編集履歴は持たない

- 前の本文は保存しない。利用者は「編集すれば前の内容は消える」と期待する。削除の意味（下記）とも揃う。
- 保持期間やリーガルホールドで前の本文が必要になったら、編集の経路（1 か所）に「改訂の保存」を足す。詳細は [security.md](security.md) で扱う。

## 削除

- `DELETE /workspaces/{ws}/channels/{ch}/messages/{id}` → 204。削除済みでも 204（イベントは作らない）。
- 削除できる主体：

  | 主体 | 自分のメッセージ | 他人のメッセージ |
  | --- | --- | --- |
  | owner / admin | ○ | ○（読めるチャンネルに限る） |
  | member | ○ | × |
  | guest | ○ | × |

  - 管理者も、読めないチャンネル（参加していないプライベートチャンネル、DM）のメッセージは削除できない。見えないものを消させない。
  - 他人のメッセージの削除は、監査ログに残す（[security.md](security.md)）。
- **行は残し、中身を消す（tombstone）。** 同じトランザクションで次を行う。
  - `deleted_at` を設定し、`body` を空にする。本文を残さない。
  - `mentions`、`reactions`、プレビューの紐付け、ピン留めを削除する。
  - 添付ファイルを削除の対象にする（[files.md](files.md) の「削除」）。
- 行を残す理由：
  - `seq` と `client_msg_id` の一意性を保つ。再送が新しい投稿にならない。
  - 返信のあるスレッドの親を、「このメッセージは削除されました」として表示し続ける。
- 履歴 API は、返信のない削除済みメッセージを返さない。返信のある親は tombstone として返す。
- スレッドの親を削除しても、返信は残る。返信の削除は、親の `reply_count` を減らす。

## スレッド

### 返信も、チャンネルの `seq` を消費する

返信専用の連番（スレッド内 `seq`）は持たず、返信にもチャンネルの `seq` を付ける。

- チャンネルごとのイベント列が 1 本のまま保てる。欠損検知・差分取得（[realtime.md](realtime.md)）は、チャンネルの `seq` だけを見ればよい。
- 返信が来ると、親の返信数と最終返信時刻が変わる。スレッドを開いていないメンバーにも、この変化をチャンネルのイベントとして届ける必要がある。スレッド内 `seq` を別に持っても、チャンネルのイベントは結局必要になる。
- スレッド内の並び順は、返信の `seq` の昇順で決まる（チャンネルの `seq` の部分列なので単調増加）。
- 代わりに、未読数（`last_seq - last_read_seq`）に返信が含まれる。これは [read-state-and-notifications.md](read-state-and-notifications.md) で近似として許容済み。
- 親の行の更新（`reply_count` など）は、`last_seq` の採番と同じトランザクションで行う。チャンネルの行ロックで直列化済みなので、ロックの待ちは増えない。

### 返信の規則

- 投稿 API に `thread_root_id` を付けて返信する。
- 親は、同じチャンネルの、削除されていない、返信でないメッセージに限る。スレッドは 1 段だけ。条件を満たさなければ 404 を返す。
- **「チャンネルにも投稿する」**：`also_send_to_channel: true` を付けると、返信がチャンネルの一覧にも出る。
  - 行は 1 つだけ作り、フラグで表す。2 行に複製しないので、編集・削除・リアクションが 1 か所で済む。
  - 履歴 API は `thread_root_id IS NULL OR also_send_to_channel` の行を返す。
  - フラグは投稿時にだけ決め、編集では変えない。
- スレッドの取得：`GET /workspaces/{ws}/channels/{ch}/messages/{root_id}/replies?after_seq&limit` → `seq` の昇順。`limit` は最大 100。

### 返信数

親の行に非正規化して持つ（[data-model.md](data-model.md)）。

| 列 | 更新のタイミング |
| --- | --- |
| `reply_count` | 返信の投稿で +1、返信の削除で -1 |
| `last_reply_at` | 返信の投稿 |
| `reply_member_ids`（先頭 5 人） | 返信の投稿。一覧のアイコン表示用 |

返信の `message.created` と `message.deleted` のイベントに、親の新しい値を載せる。親の更新のために、別のイベントは作らない。

### スレッドの購読

「フォロー中のスレッド」とスレッドの通知のために、購読を持つ。

```sql
thread_subscriptions (workspace_id, root_message_id, member_id,
                      subscribed,            -- false は明示的な解除
                      last_read_seq,         -- スレッド内で読んだ最後の返信の seq
                      updated_at,
                      PRIMARY KEY (workspace_id, root_message_id, member_id))
```

- **自動で購読する**：親の投稿者、返信した人、スレッドの中でメンションされた人。
- **明示的な購読・解除**：`PUT` / `DELETE .../messages/{root_id}/subscription`。解除した人は、再び返信するかメンションされるまで自動購読しない（`subscribed = false` の行を残す）。
- 購読の変化は、そのメンバーの他の端末にだけ届ける（既読イベントと同じ扱い）。チャンネルの `seq` は消費しない。
- 未読と通知の扱いは [read-state-and-notifications.md](read-state-and-notifications.md) で決める。

## リアクション

- `PUT /workspaces/{ws}/channels/{ch}/messages/{id}/reactions/{emoji}` で付け、`DELETE` で外す。どちらも冪等。
- **サーバーの API はトグルにしない。** トグルは再送で結果が反転する。画面上のトグルは、クライアントが現在の状態を見て `PUT` か `DELETE` を選ぶ。
- 付ける：`INSERT ... ON CONFLICT DO NOTHING`。行が増えたときだけ、`reaction.added` を outbox に積む。
- 外す：行が消えたときだけ、`reaction.removed` を積む。
- 絵文字は、Unicode の標準絵文字の短縮名に限る（肌の色は `thumbsup::skin-tone-2` の形）。一覧は `packages/contract` に固定したバージョンで持つ。カスタム絵文字は MVP の範囲外。
- 表示用の集計（絵文字ごとの件数と、自分が付けたか）は、履歴の取得時に `reactions` から集計する。主キーの先頭が `(workspace_id, message_id)` なので、1 ページ 50 件分なら軽い。

## メンション

### 種類

| 種類 | AST のノード | 対象 |
| --- | --- | --- |
| @メンバー | `mention { member_id }` | そのメンバー |
| @here | `broadcast { range: "here" }` | チャンネルのメンバーのうち、アクティブな人 |
| @channel | `broadcast { range: "channel" }` | チャンネルの全メンバー |
| @everyone | `broadcast { range: "everyone" }` | ワークスペースの全メンバー。**既定のチャンネル（全員が参加する #general）でだけ使える** |

- @メンバーの `member_id` は、同じワークスペースのメンバーでなければ 400 を返す（RLS の下で存在を確認する）。
- チャンネルを読めないメンバーへのメンションは保存するが、通知しない。判定関数（ADR-0005）で読めるかを確かめる。クライアントは送信前に「このメンバーはチャンネルにいません」と警告する。自動で参加させない。
- @here の「アクティブ」は、通知を送る時点の在席状態で決める（[realtime.md](realtime.md)）。

### 誰が使えるか

| ロール | @メンバー | @here / @channel | @everyone（既定のチャンネル） |
| --- | --- | --- | --- |
| owner / admin | ○ | ○ | ○ |
| member | ○ | ○ | × |
| guest | ○ | × | × |

- 使えないメンションを含む投稿は、403 を返す。チャンネルを読めることは確認済みなので、存在は漏れない。
- 既定のチャンネル以外での @everyone は、400 を返す。
- DM・グループ DM での @here / @channel は受け付けるが、通知の対象はもともと全員なので意味は変わらない。
- 本家 Slack に寄せて、次の制限と確認を置く（2026-09-26 に決定。[README.md](README.md) の 6 節）。詳しい規則と決定表は E3 の `mentions-and-broadcast` の spec に書く。
  - **確認**：参加者が 6 人以上のチャンネルで @channel / @here / @everyone を含めて送ろうとしたら、クライアントが送信前に確認を求める（通知する人数を示す）。owner・admin は、ワークスペースの設定でこの確認を無効にできる。
  - **使える人の制限**：owner・admin は、ワークスペースの設定で @channel / @here / @everyone を使えるロールを絞れる（既定は上の表）。
  - **大規模チャンネル**：参加者が 10,000 人以上のチャンネルでは、@channel / @here を使えるのは owner・admin だけにする。S1（最大 5,000 人）では当たらない。
  - **スレッドの中**：スレッドの返信に含めた @channel / @here / @everyone では、通知しない（本文はそのまま残す）。

### 保存

- `mentions` には @メンバーだけを入れる。
- @here / @channel / @everyone は、`messages.broadcast_mention`（`none` / `here` / `channel` / `everyone`）に持つ。**メンバーごとの行に展開しない。** 5,000 人のチャンネルでは、1 投稿で 5,000 行になるため。展開は通知の Worker が行う。

### ユーザーグループ（@team）

本家 Slack のユーザーグループに相当する。E3 の `user-groups` で作る。

- `user_groups (workspace_id, id, handle, name, created_by, archived_at)` と `user_group_members (workspace_id, group_id, member_id)` を持つ。`handle` はワークスペースの中で一意で、メンバーの表示名とは別の名前空間にする。
- 本文には、AST に `group_mention { group_id }` のノードを足して表す。AST v1 には無いので、E3 で版の規則（「バージョン管理」）に従って追加する。
- 通知の Worker は、投稿の時点のグループのメンバーに展開する。そのうえで、チャンネルを読めないメンバーには通知しない（ADR-0005）。展開の上限は、@channel と同じく 500 人ずつに分けて処理する（[read-state-and-notifications.md](read-state-and-notifications.md)）。
- 作成・編集できるのは owner / admin と、ワークスペースの設定で許可された member。ゲストは使えない。

## 予約送信

E3 の `scheduled-messages` で作る。

- `scheduled_messages (workspace_id, id, channel_id, member_id, body, client_msg_id, send_at, state)` に置く。送信の時刻になるまで、`messages` には入れない（`seq` を消費しない）。
- 送信は、1 分ごとに動く Worker が `send_at` を過ぎた行を取り、通常の投稿と同じ経路（権限の判定、`client_msg_id` による冪等）で投稿する。SQS の遅延（最大 15 分）は使わない。
- 送信の時点で、投稿者がチャンネルを読めない・無効化されている場合は送らず、状態を `failed` にして本人に知らせる。
- 予約は、本人だけが一覧・編集・取り消しできる。

## カスタム絵文字

E3 の `custom-emoji` で作る。

- `custom_emoji (workspace_id, name, file_id, alias_of, created_by)`。画像は [files.md](files.md) の経路でアップロードし、スキャンと再エンコードを経たものだけを使う。
- 名前の形は AST の `emoji` の規則（`/^[a-z0-9_+-]{1,64}$/`）に従い、標準の絵文字の名前と重ならないようにする。
- 本文とリアクションでは名前で参照する。削除された絵文字は、名前のまま表示する。

## 保存とブックマーク

E3 の `saved-items-and-bookmarks` で作る。

- **後で読む（保存）**：`saved_items (workspace_id, member_id, message_id, saved_at, remind_at)`。本人だけが見られる。`remind_at` はリマインダー（[read-state-and-notifications.md](read-state-and-notifications.md)）と同じ仕組みで知らせる。
- **チャンネルのブックマーク**：`channel_bookmarks (workspace_id, channel_id, id, title, url, created_by)`。URL は `isSafeUrl` で検査する。追加・変更は `seq` を消費するイベントとして、チャンネルのメンバーに配る。

## 本文（AST）

### スキーマ

`packages/contract` に Zod スキーマとして置き、API・Web・Worker で共有する。

```ts
type Body = { v: 1; blocks: Block[] };

type Block =
  | { type: "paragraph"; children: Inline[] }
  | { type: "code_block"; text: string; lang?: string }
  | { type: "quote"; children: Block[] }
  | { type: "list"; ordered: boolean; items: Block[][] };

type Inline =
  | { type: "text"; text: string; marks?: ("bold" | "italic" | "strike" | "code")[] }
  | { type: "link"; url: string; text?: string }        // url は http / https / mailto だけ
  | { type: "mention"; member_id: string }
  | { type: "channel_link"; channel_id: string }
  | { type: "broadcast"; range: "here" | "channel" | "everyone" }
  | { type: "emoji"; name: string };
```

- 入力欄から AST への変換はクライアントが行う。サーバーは Zod で検証するだけで、Markdown を解釈しない。
- 表示名は保存しない。描画時に `member_id` から引く。表示名の変更が過去のメッセージにも反映される。
- `channel_link` の先が読めないチャンネルなら、「プライベートチャンネル」とだけ描画する。
- テキスト化（`toPlainText`）は 1 つの関数にし、長さの検査・検索（[search.md](search.md)）・通知の本文に使う。

### バージョン管理

- `messages.body_format` に AST のバージョン（今は `1`）を入れる。
- 書き込みは常に最新のバージョンで行う。
- バージョンを上げるときは、`packages/contract` に変換関数 `upgrade_vN_to_vN+1` を足す。読み出し時に最新まで変換して返す。保存済みの行は一括で書き換えない。
- API は常に最新のバージョンで返す。Web クライアントは API と同時にデプロイされる。古いクライアント（開いたままのタブ）は、未知のバージョンを受け取ったら再読み込みを促す。
- ノードの削除や意味の変更は、変換関数で表せるものに限る。表せない変更は ADR を起票する。

## 上限

| 対象 | 上限 | 超えたとき |
| --- | --- | --- |
| 本文の長さ | 40,000 文字（REQ-MSG-006）。`toPlainText` の結果で数える | 400 |
| AST の JSON のサイズ | 128 KiB | 400 |
| AST の入れ子の深さ | 6 | 400 |
| 1 メッセージの @メンバー（異なる人数） | 50 | 400 |
| 1 メッセージの添付ファイル | 10 | 400 |
| 1 メッセージのリンクのプレビュー | 先頭の 3 URL | それ以降は展開しない |
| 1 メッセージの異なる絵文字 | 50 | 409 |
| 1 メンバーが 1 メッセージに付ける絵文字 | 20 | 409 |
| 1 チャンネルのピン留め | 100 | 409 |
| スレッドの深さ | 1 段 | 404（返信への返信） |

投稿のレートの上限は [rate-limiting.md](rate-limiting.md) の 4.2 節にある。

## リンクのプレビュー

外部の URL の取得は、隔離した取得器で行う（[ADR-0016](../decisions/0016-isolated-link-unfurling.md)）。

1. `message.created` / `message.edited` を、unfurl の Worker が SQS から受け取る。
2. 本文の `link` ノードから、先頭 3 つの URL を取り出す（重複を除く）。コードブロックとインラインコードの中は対象にしない。
3. ワークスペースごとのキャッシュ（`link_previews`、24 時間）を引く。なければ取得器を呼ぶ。
4. 取得器は、タイトル・説明・サイト名と、再エンコード済みの画像だけを返す。
5. Worker は結果を `link_previews` に保存し、画像を S3 に置く。`message_unfurls` にメッセージとの紐付けを書き、`message.unfurls_updated` を outbox に積む（`seq` を消費する）。

```sql
link_previews   (workspace_id, url_hash, url, status,       -- ok / failed / blocked
                 title, description, site_name, image_key, fetched_at,
                 PRIMARY KEY (workspace_id, url_hash))
message_unfurls (workspace_id, message_id, url_hash, position, hidden,
                 PRIMARY KEY (workspace_id, message_id, url_hash))
```

- キャッシュはワークスペースをまたがない。URL そのものが秘密（共有リンクなど）でありうるため（ADR-0009）。
- 画像は直リンクしない。S3 に置き直し、ファイルと同じ署名付き URL で配る（[files.md](files.md)）。閲覧者の IP を外部サイトに渡さず、後からの差し替えも防ぐ。
- 投稿者は、プレビューを消せる（`hidden = true`、`message.unfurls_updated`）。
- ワークスペースの設定で、プレビューを無効にできる。
- 自分たちのドメイン（アプリ・ファイル配信）の URL は取得器に渡さない。メッセージのパーマリンクの展開は、閲覧者の権限で描画する必要があり、MVP の範囲外。

## ピン留め

実装が安いので、E3 の任意の Story として扱う。

```sql
pins (workspace_id, channel_id, message_id, pinned_by_member_id, created_at,
      PRIMARY KEY (workspace_id, channel_id, message_id))
```

- `PUT` / `DELETE /workspaces/{ws}/channels/{ch}/pins/{message_id}`（冪等）、`GET .../pins`。
- チャンネルのメンバーなら誰でも付け外しできる（guest を含む）。
- 状態が変わったときだけ `pin.added` / `pin.removed` を積む。メッセージを削除すると、ピン留めも消える（`message.deleted` に含める）。

## イベント

outbox に積むイベントの一覧。Relay が Valkey の Pub/Sub（リアルタイム配信）と、Worker ごとの SQS キューに流す。

| イベント | `seq` | 主な中身 | リアルタイム | 検索 | 通知 | unfurl | ファイル |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `message.created` | 消費する | メッセージ全体（AST、`thread_root_id`、`also_send_to_channel`、`broadcast_mention`、添付）。返信なら親の `reply_count` など | ○ | ○ | ○ | ○ | ○（添付の確定） |
| `message.edited` | 消費する | `message_id`、`body`、`edited_at`、`content_seq` | ○ | ○ | | ○ | |
| `message.deleted` | 消費する | `message_id`、`thread_root_id`、親の新しい `reply_count`、`content_seq` | ○ | ○ | ○（未送信の通知の取り消し） | | ○（添付の削除） |
| `message.unfurls_updated` | 消費する | `message_id`、プレビューの一覧 | ○ | | | | |
| `reaction.added` / `reaction.removed` | 消費する | `message_id`、`emoji`、`member_id` | ○ | | | | |
| `pin.added` / `pin.removed` | 消費する | `message_id`、`member_id` | ○ | | | | |
| `file.updated` | 消費する | `file_id`、`message_id`、状態、サムネイルの有無（[files.md](files.md)） | ○ | | | | |
| `channel.created` | 消費する | `channel_id`、名前、種類、作成者 | ○ | | | | |
| `channel.renamed` | 消費する | `channel_id`、新しい名前 | ○ | | | | |
| `channel.archived` | 消費する | `channel_id`、`archived_by` | ○ | | | | |
| `channel.updated` | 消費する | `channel_id`、変わった属性（トピック、説明など） | ○ | | | | |
| `channel.member_joined` / `channel.member_left` | 消費する | `channel_id`、`member_id` | ○ | | ○（`member_left` だけ。未送信の通知の取り消し） | | |
| `thread_subscription.updated` | 消費しない | `root_message_id`、`subscribed`、`last_read_seq` | ○（本人の端末だけ） | | | | |

- **Worker は、イベントを「きっかけ」として扱い、中身は DB から読み直す。** SQS（標準キュー）は順序を保証せず、重複もある。DB の現在の状態を読めば、順序が入れ替わっても最終状態が正しくなる。
- `content_seq` は、本文を最後に変えたイベント（作成・編集・削除）の `seq`。検索インデックスの書き込みで、古い内容が新しい内容を上書きしないための版番号に使う（[search.md](search.md)）。
- Worker の冪等キーは `(workspace_id, channel_id, seq)`。
- `channel.*` のイベントは、アプリへのイベント（[apps.md](apps.md) の 6.2 節）の元にもなる。自分の参加・退出は、別にメンバーのストリームの `channel.joined` / `channel.left` で知らせる（[realtime.md](realtime.md) の 5 節）。
- 差分取得（`GET .../events?after_seq=N`）は、outbox ではなく、イベントを保存するテーブルから読む。テーブルの形は [realtime.md](realtime.md) で決める。

## データモデルへの追加

[data-model.md](data-model.md) に反映が必要な列とテーブル。

| 対象 | 追加 |
| --- | --- |
| `messages` | `also_send_to_channel`、`broadcast_mention`、`reply_member_ids`、`content_seq` |
| 新規 | `thread_subscriptions`、`link_previews`、`message_unfurls`、`pins` |
| `message_files` | `UNIQUE (workspace_id, file_id)`（1 つのファイルは 1 つのメッセージにだけ付く。[files.md](files.md)） |

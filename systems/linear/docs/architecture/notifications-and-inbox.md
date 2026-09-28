# Notifications and Inbox: Linear

購読、インボックスの通知、既読とスヌーズ、メール（まとめて送る）、デスクトップの通知、Slack の個人への通知を決める。通知の行は、確定した変更から Worker が作り、同期するモデルとして全端末に届く。既読とスヌーズは、その行のフィールドなので、端末をまたいで揃う。

前提となる決定は、同期のモデル（[ADR-0002](../decisions/0002-sync-model.md)）、読み込みの方針（[ADR-0003](../decisions/0003-bootstrap-and-partial-sync.md)）、非公開のチーム（[ADR-0004](../decisions/0004-tenancy-and-permissions.md)）、トランザクションと冪等性（[ADR-0006](../decisions/0006-transactions-writer-and-idempotency.md)）、複数のタブ（[ADR-0015](../decisions/0015-multi-tab-leader-and-broadcast.md)）、メンションの抜き出し（[ADR-0022](../decisions/0022-comments-anchors-mentions-attachments.md)）、派生の変更（[ADR-0025](../decisions/0025-derived-changes-in-writer.md)）、権限の関数（[ADR-0032](../decisions/0032-single-policy-module-and-group-mapping.md)）。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0036](../decisions/0036-notifications-derived-by-notifier.md) | 通知の行は、Writer の `derive` ではなく、確定の後に Worker（通知係）が `sync_actions` と履歴から作り、Writer のシステムのトランザクションで `Notification`（`user:<id>` のグループ）として書く。受け手は決定表で決め、作る時に `can()` で絞る。行は中身を持たず、種類・主題の ID・行為者だけを持つ。冪等の鍵で 1 つの事象から 1 行だけを作る。既読とスヌーズは行の LWW のフィールドと、利用者ごとの既読の水位で持ち、同期で端末をまたいで揃う |
| [0037](../decisions/0037-notification-delivery-channels.md) | デスクトップの通知は、同期で届いた行をクライアントが OS に出す（別の push の基盤を持たない）。メールは種類の急ぎの度合いで送るまでの待ちを決め、送る時にまだ未読でスヌーズでない行だけを 1 通にまとめる。Slack の個人への通知は 30 秒待って未読なら送る。メールと Slack は送る時にもう一度 `can()` で確かめ、中身はそのときに読んで入れる |

## 1. 目的と範囲

- 扱う：
  - 購読（イシュー、プロジェクト、チームの新しいイシュー）
  - 通知の事象と受け手の決定表、通知の行の作り方（通知係）
  - インボックス：既読・未読、スヌーズ、削除、上限、主題ごとのまとめの表示
  - 利用者の通知の設定
  - 配り：デスクトップ（Web と Electron）、メール（まとめて送る）、Slack の個人への通知、Urgent の扱い
  - 権限の再確認と、非公開への切り替えのときの通知の後始末
- 扱わない：
  - メンションの抜き出し（[editor-and-descriptions.md](editor-and-descriptions.md) の 6 節）。ここは、抜き出した事象を受ける
  - 購読者の派生（`subscriber_ids` に作った人・担当・メンションされた人を足す。[issues-and-workflow.md](issues-and-workflow.md) の 5 節）
  - Slack のチャンネルへの通知、Slack のアカウントの結び付け（[integrations.md](integrations.md)）
  - OS の通知の出し方の実装（[client-app.md](client-app.md) の 11 節）
  - モバイルの push（MVP の後）

## 2. 本家の形（確かめたこと）

いずれも公式の文書。2026-09-28 に確認。

| 項目 | 内容 | 出典 |
| --- | --- | --- |
| 手段 | デスクトップ・モバイル・メール・Slack。デスクトップ・モバイル・Slack は即時。メールはまとめて送るか、即時か | [Notifications](https://linear.app/docs/notifications) |
| メール | 急ぎの度合い（イシューの状態などの属性）に応じた時間の後に、未読の通知をまとめて送る。インボックスで既読にしたものは送らない | 同上 |
| 種類のまとまり | 種類をまとまり（category）ごとに設定し、まとまりの中の 1 つだけを選べない。例：状態の変化のまとまりは、完了・取り消し、Urgent への変更、blocking の関連の変化 | 同上 |
| 自動の購読 | イシューを作る、担当になる、コメント・本文でメンションされる。コメントのスレッドでメンションされたら、スレッドを購読し、イシュー全体は購読しない | 同上 |
| ブラウザの push | 新しいブラウザの push の購読の設定はできない | 同上 |
| 上限 | 開いている通知は 2,000 件まで。超えたら古いものは残らない | [Notifications](https://linear.app/docs/notifications)、[Inbox](https://linear.app/docs/inbox) |
| 既読 | `U` で切り替え、`Option/Alt U` で全部を既読 | [Inbox](https://linear.app/docs/inbox) |
| スヌーズ | `H`。決まった間隔か、自由な指定（「Jan 3 10am」「next quarter」「for X days」）。その時刻に戻る | 同上 |
| 削除 | 削除だけ。アーカイブはない。`Shift Backspace` で既読を全部消す。`Shift S` で購読をやめる | 同上 |
| Slack の個人への通知 | 個人の設定で Slack に認証し、受ける通知を選ぶ。インボックス・メール・デスクトップと同じ更新が、Slack のアプリからの DM で届く | [Slack](https://linear.app/docs/slack) |
| Urgent | 担当に通知し、メールでも知らせる | [Priority](https://linear.app/docs/priority) |
| プロジェクトの更新 | 通知は Slack・インボックス・両方へ。更新のスレッドのコメントは、書いた人と参加した人に届く | [Initiative and Project updates](https://linear.app/docs/initiative-and-project-updates) |

- メールを送るまでの待ちの具体の時間、まとまりの一覧、同じ主題の通知のまとめ方は、文書に書かれていない（**未検証**）。本システムの値は 8.2 節。
- Slack の DM からの操作（既読にするなど）は、文書に書かれていない（**未検証**）。

## 3. 全体の流れ

```
 Writer（確定）── sync_actions・履歴・doc_mentions の事象
     │ outbox
     ▼
 Relay ─▶ SQS（notify）─▶ 通知係（Worker）
                              │ (1) 事象 → 受け手（DT-NOTIF-001）
                              │ (2) 受け手ごとに can(受け手, read, 主題)、設定、行為者の除外
                              │ (3) 冪等の鍵で重複を捨てる
                              ▼
                        Writer のシステムのトランザクション（Notification の create。500 件ずつ）
                              │                              │
                              ▼                              ▼
                   同期（user:<id> の差分）          配りの予定（notification_deliveries）
                              │                              │
                  ┌───────────┴─────────┐          ┌─────────┴──────────┐
                  ▼                     ▼          ▼                    ▼
           インボックス（全端末）   デスクトップの通知   メールの送り係        Slack の送り係
                                   （クライアントが出す） （まとめ、未読だけ）  （30 秒後、未読だけ）
```

- 通知の行ができるまで：確定から p95 5 秒（Relay 1 秒、SQS と通知係 2 秒、Writer 1 秒、余裕 1 秒）。その後、差分で他の端末に p99 1 秒（NFR-002）。
- 通知係は、事象の中身（タイトルなど）を行に写さない（4.2 節）。

## 4. モデル

### 4.1 購読

| 対象 | 持ち方 | 足す | 外す |
| --- | --- | --- | --- |
| イシュー | `Issue.subscriber_ids`（[issues-and-workflow.md](issues-and-workflow.md) の 3.3 節） | 作った人・担当・メンションされた人（派生）、本人 | 本人の `remove`（インボックスの `Shift S` も） |
| プロジェクト | `NotificationSubscription(target_kind = project)` | リーダーとメンバー（派生）、本人 | 本人 |
| チームの新しいイシュー | `NotificationSubscription(target_kind = team, events = [issue_created, triage])` | 本人 | 本人 |

```ts
model("NotificationSubscription", {
  groups: { rule: "user", from: "user_id" }, load: { strategy: "instant" }, delete: { mode: "hard" },
  fields: {
    user_id:     { type: "ref:User", conflict: "server_only", on_delete: "cascade", index: true },
    target_kind: { type: "enum<project,team>", conflict: "server_only" },
    target_id:   { type: "uuid", conflict: "server_only", index: true },
    events:      { type: "set<string>", conflict: "set", max: 10 },
  },
});
```

- 行は本人のグループ（`user:<id>`）。誰がプロジェクトを購読しているかは、本人にしか見えない。通知係はサーバーの表を読む。
- プロジェクトのリーダー・メンバーに足すのは、`Project.lead_id`・`member_ids` の変更の派生（ADR-0025）。人に結び付く派生なので、`can()` で読める人だけ。
- 本家の「コメントのスレッドでメンションされたら、スレッドだけを購読する」は採らない。editor-and-descriptions の 6 節は、メンションされた人をイシューの `subscriber_ids` に足すと決めている。スレッドの購読のモデルを足すかは 13 節の問い。

### 4.2 `Notification`

```ts
model("Notification", {
  groups: { rule: "user", from: "user_id" },
  load: { strategy: "instant" },              // 1 人 2,000 件まで（5.4 節）
  delete: { mode: "hard" },
  fields: {
    user_id:      { type: "ref:User", conflict: "server_only", on_delete: "cascade", index: true },
    kind:         { type: "enum<assigned,unassigned,mentioned,comment,reply,status_done,urgent,blocking,triage_new,issue_created,project_update,project_update_due,reaction,auto_closed,reminder,admin_joined_private_team,view_references_private_team>", conflict: "server_only" },
    category:     { type: "enum<assignments,mentions,comments,status_changes,triage,projects,reactions,reminders,system>", conflict: "server_only" },
    subject_kind: { type: "enum<issue,project,project_update,team,view>", conflict: "server_only" },
    subject_id:   { type: "uuid", conflict: "server_only", index: true },
    ref_id:       { type: "uuid", conflict: "server_only", nullable: true },   // コメントなど
    actor_id:     { type: "ref:User", conflict: "server_only", nullable: true, on_delete: "nullify" },
    urgent:       { type: "bool", conflict: "server_only" },
    source_sync_id: { type: "int", conflict: "server_only" },
    read_at:      { type: "timestamp", conflict: "lww", nullable: true },
    snoozed_until:{ type: "timestamp", conflict: "lww", nullable: true },
  },
});
model("InboxState", {                          // 1 人 1 行
  groups: { rule: "user", from: "user_id" }, load: { strategy: "instant" }, delete: { mode: "hard" },
  fields: {
    user_id:     { type: "ref:User", conflict: "server_only", on_delete: "cascade" },
    read_before: { type: "int", conflict: "lww", nullable: true },   // この source_sync_id 以下を既読とみなす
  },
});
```

- **中身を持たない。** タイトル・コメントの抜粋・プロジェクトの名前を行に入れない。画面は `subject_id` から手元のモデルで描く。手元にないイシューは `Issue:id=…` の遅延の読み込み（同期グループで絞る）で得る。見てよくなくなったイシューは「非公開のイシュー」と描く。中身を写さないのは、主題の権限が変わっても、通知の行から中身が漏れないようにするため（7 節）。
- `created_at` は Writer が書く共通の列。並びは `source_sync_id` の降順。
- 画面は、同じ主題（`subject_id`）の通知を 1 行にまとめて見せる。行はまとめない（まとめると、既読の単位と冪等の鍵が複雑になるため）。

### 4.3 通知の設定

```ts
model("NotificationPreference", {             // 1 人 1 行
  groups: { rule: "user", from: "user_id" }, load: { strategy: "instant" }, delete: { mode: "hard" },
  fields: {
    user_id:  { type: "ref:User", conflict: "server_only", on_delete: "cascade" },
    channels: { type: "json", conflict: "lww", schema: "NotificationChannels" },
    email_mode: { type: "enum<digest,immediate,off>", conflict: "lww", default: "digest" },
    desktop_content: { type: "enum<full,minimal>", conflict: "lww", default: "full" },
  },
});
```

- `channels`：`{ <category>: { inbox: true, desktop: bool, email: bool, slack: bool } }`。インボックスは常に真（本家と同じく、インボックスには必ず出る）。
- 既定：`assignments`・`mentions`・`comments`・`status_changes`・`projects`・`reminders` はデスクトップとメールが真、`triage`・`reactions` はデスクトップだけ、`system` はメールとデスクトップ。Slack は結び付けた後に既定で真。本システムの値。
- 本家と同じく、まとまりの中の種類を 1 つずつは選べない。

## 5. 生成

ADR-0036。

### 5.1 事象と受け手

DT-NOTIF-001。どの行でも、次の共通の規則を当てる：行為者自身には出さない。受け手は `active`。受け手が主題を `can(受け手, "read", 主題)` で読める。受け手の設定でそのまとまりのインボックスが偽なら出さない（インボックスは常に真なので、実際には出す）。

| # | 事象（元） | 受け手 | `kind` | `category` | `urgent` |
| --- | --- | --- | --- | --- | --- |
| 1 | `Issue.assignee_id` が X になった | X | `assigned` | `assignments` | 優先度が Urgent なら真 |
| 2 | `Issue.assignee_id` が X から外れた | X | `unassigned` | `assignments` | 偽 |
| 3 | コメントのメンション（`create Comment`・`set body` の派生の事象） | メンションされた人 | `mentioned` | `mentions` | 偽 |
| 4 | 本文のメンション（`doc_mentions` の増分） | メンションされた人 | `mentioned` | `mentions` | 偽 |
| 5 | コメントの作成（スレッドの最初） | イシューの購読者 | `comment` | `comments` | 偽 |
| 6 | コメントの作成（返信） | スレッドの参加者（スレッドのコメントを書いた人）と、イシューの購読者 | `reply` | `comments` | 偽 |
| 7 | 状態の種類が `completed`・`canceled` になった | イシューの購読者 | `status_done` | `status_changes` | 偽 |
| 8 | 優先度が Urgent になった | 担当（本家と同じ）と、イシューの購読者 | `urgent` | `status_changes` | 担当には真 |
| 9 | `blocks` の関連の作成・削除 | 塞がれた側のイシューの購読者 | `blocking` | `status_changes` | 偽 |
| 10 | チームにイシューが作られた（Triage に入ったなら `triage_new`） | チームの `NotificationSubscription` の持ち主 | `issue_created`・`triage_new` | `triage` | 偽 |
| 11 | `ProjectUpdate` の作成 | プロジェクトの購読者 | `project_update` | `projects` | 偽 |
| 12 | 更新の催促（[cycles-and-projects.md](cycles-and-projects.md) の 6.2 節） | リーダー（なければ作った人） | `project_update_due` | `projects` | 偽 |
| 13 | 自分のコメントへのリアクション | コメントを書いた人 | `reaction` | `reactions` | 偽 |
| 14 | 自動で閉じる・自動のアーカイブ（履歴の `{k: "auto"}`） | イシューを作った人 | `auto_closed` | `status_changes` | 偽 |
| 15 | リマインダーの時刻（6.3 節） | 本人 | `reminder` | `reminders` | 偽 |
| 16 | 管理者が非公開のチームに参加（[permissions-and-teams.md](permissions-and-teams.md) の 7.1 節） | そのチームのメンバー | `admin_joined_private_team` | `system` | 偽 |
| 17 | ビューが非公開のチームを参照（同 7.2 節） | ビューの持ち主、管理者 | `view_references_private_team` | `system` | 偽 |

- 1 つの事象で同じ人が複数の行に当たる（担当で、購読者で、メンションされた）ときは、表の上の行の 1 つだけを出す。
- 行 3・4 は、同じコメント・本文で同じ人を 2 度メンションしても 1 回。
- 行 6 の「スレッドの参加者」は、通知係がサーバーの表で求める（コメントは遅延のモデルだが、サーバーには全部ある）。
- Worker の定期処理（`origin = worker`）の変更は、行 14 のほかは通知しない（繰り越しで 5,000 件が動いても、購読者に 5,000 通を出さない）。インポート（`origin = import`）の変更は通知しない。

### 5.2 冪等の鍵

- 鍵：`SHA-256(user_id | kind | subject_id | ref_id | source_sync_id)`。定期の事象（催促、リマインダー）は `source_sync_id` の代わりに予定の時刻と回を使う。
- サーバーだけの表 `notification_keys(workspace_id, key)` を、`Notification` の作成と同じトランザクションで書く。一意の制約に当たったら、その行は作らない（トランザクション全体は拒否しない。通知係は、作る行ごとに `INSERT … ON CONFLICT DO NOTHING` の結果を見て `create` を足す）。
- 通知係は、SQS の少なくとも 1 回の配送で同じ事象を 2 度受けても、1 行だけを作る。鍵の表は 30 日で消す（SQS の保持と `sync_actions` の保持より長い）。

### 5.3 権限の確認（作る時）

- 通知係は、事象の `sync_id` 以後の状態を Aurora の reader から読み（`min_sync_id`、2 秒で writer）、受け手ごとに `can(受け手, "read", 主題)` を確かめる。`Facts` は `sync_subscriptions` とチームの公開から（[permissions-and-teams.md](permissions-and-teams.md) の 4.1 節）。
- 読めない受け手（非公開のチームのイシューで、メンバーでない人がメンションされた）には出さない。本家もメンバーでない人をメンションできない。

### 5.4 上限

- 1 人の `Notification` は 2,000 件まで（本家と同じ）。通知係は作った後に数え、超えた分を、古い順（既読を先に）に同じトランザクションで `delete` する。
- 1 つの事象の受け手が 500 人を超える（購読者の上限と同じ）ことはない。超えたら 500 人ずつのトランザクションに分ける。

## 6. 既読・スヌーズ・削除

ADR-0036。

### 6.1 既読

- 行が既読 ⇔ `read_at` がある、または `source_sync_id ≤ InboxState.read_before`。
- 1 件を既読・未読にする：`set read_at`（未読は `null`）。
- 全部を既読（`Option/Alt U`）：`InboxState.read_before` を、手元の最大の `source_sync_id` にする。1 つの `set` で済み、2,000 件の行を書き換えない。その後の新しい通知は未読のまま。
- 主題を開いたら、クライアントがその主題の未読の通知に `set read_at` を送る（1 つのトランザクション）。
- 既読は同期で全端末に届く（`user:<id>` のグループ）。LWW なので、2 台で同時に既読・未読を切り替えたら、後に確定した方が残る。
- メールと Slack の送り係は、同じ規則で既読を判定する（8 節）。

### 6.2 スヌーズ

- `set snoozed_until`。画面は `snoozed_until > 手元の今` の行を隠し、その時刻に出す（手元の時計で十分。表示だけの判定で、端末ごとにずれても害がない）。
- スヌーズの時刻が来た行を、メールと Slack で改めて送るかは送らない（既に一度は届く機会があったため）。スヌーズの間はメールと Slack の対象から外す。
- 自由な指定（「next quarter」など）の解析は、クライアントの共有の関数で、日本語と英語の両方を受ける。
- 同じ主題に新しい通知が来たら、新しい行はスヌーズされていないので出る。前の行はスヌーズのまま。

### 6.3 リマインダー

- イシューの「後で知らせる」（本家の `H` の remind）：`IssueReminder`（`user:<id>` のグループ、`{issue_id, remind_at}`）を作る。Worker が 1 分ごとに期限の来たものを探し、DT-NOTIF-001 の行 15 の事象にする。
- リマインダーの時刻はサーバーの時計で決める（メールに載るため）。

### 6.4 削除

- 本人が `delete` する（本家と同じく、アーカイブはない）。既読を全部消す（`Shift Backspace`）は、既読の行の `delete` を 500 件ずつのトランザクションにする。
- 購読をやめる（`Shift S`）は、`Issue.subscriber_ids` の `remove`。

## 7. 権限の再確認と、非公開への切り替え

ADR-0036・ADR-0037。

- 通知の行は中身を持たないので、主題が読めなくなっても、行から中身は漏れない。ただし「誰が何かをした」という事実（`kind`・`actor_id`）は残る。
- 通知係は、主題の読める範囲が狭くなる変更（`groups_before` 付きの `update` でイシュー・プロジェクトのグループが変わった、チームが非公開になった、チームから外れた）を受けたら、読めなくなった人の、その主題の `Notification` の行を消す（500 件ずつのシステムのトランザクション）。
- 非公開への切り替え（[permissions-and-teams.md](permissions-and-teams.md) の 7.2 節の行 7）もこの規則で扱う。
- メールと Slack の送り係は、送る直前に、もう一度 `can(受け手, "read", 主題)` を確かめ、読めなければ送らない（8.2・8.3 節）。中身（タイトル、抜粋）はそのときに読む。

## 8. 配り

ADR-0037。

### 8.1 デスクトップ（Web・Electron）

- 別の push の基盤を持たない。同期の差分で届いた `Notification` の `create` を見て、クライアントが OS の通知を出す（Web は Notification API、Electron は同じ API を main が許す。[client-app.md](client-app.md) の 11 節）。本家もブラウザの push の新しい購読を受けない。
- 出す条件（全部を満たすとき）：
  - そのまとまりの `desktop` が真。
  - 書き手のタブ（[ADR-0015](../decisions/0015-multi-tab-leader-and-broadcast.md)）である。同じ端末の他のタブは出さない。
  - 行の `created_at` が、受けた時刻から 2 分以内（再接続の後にたまった古い通知を一斉に出さない。たまった分は「N 件の新しい通知」の 1 つにする）。
  - アプリの窓に焦点がない、または焦点があっても、その主題を開いていない。
  - 既読でなく、スヌーズでない。
- 文面：`desktop_content = full` なら「<行為者> が <識別子> <タイトル> にコメントしました」。`minimal` なら「新しい通知があります」。中身は手元のモデルから作る（端末の外へ送らない）。OS の通知の履歴がクラウドで同期されるか（OS の機能）は**未検証**なので、`minimal` の設定を置く。
- Electron の Dock・タスクバーのバッジは、手元の未読の数。

### 8.2 メール

- 送り係は、`Notification` の作成の時に `notification_deliveries(notification_id, channel = email, deliver_after)` を書く（通知係が同じトランザクションで）。

DT-NOTIF-002。`deliver_after` の決め方。上から評価し、最初に当たった行。

| # | 条件 | 待ち |
| --- | --- | --- |
| 1 | `email_mode = off`、またはまとまりの `email` が偽 | 送らない（行を作らない） |
| 2 | `urgent` が真 | 1 分 |
| 3 | `email_mode = immediate` | 1 分 |
| 4 | `assignments`・`mentions`・`reminders`・`system` | 10 分 |
| 5 | `comments`・`projects` | 30 分 |
| 6 | それ以外 | 60 分 |

- 送り係は 1 分ごとに、`deliver_after ≤ now` の行を持つ受け手を集め、受け手ごとに 1 通にまとめる。
- まとめる前に、各行について次を確かめ、当たったものを落とす：既読（6.1 節）、スヌーズの間、行が消された、`can(受け手, "read", 主題)` が偽、受け手が `active` でない。
- 1 人に送るメールの間隔は、Urgent を除き、10 分以上あける。10 分の中に来た行は次のメールに入る。
- 待ちの時間は本システムの値（本家は「急ぎの度合いに応じた時間」とだけ書く。**未検証**）。
- メールの中身：主題ごとに、識別子、タイトル、行為者、種類、コメントの抜粋（200 字）。送る時に Aurora から読む。インボックスへのリンク。
- 送信：Amazon SES（東京）を第一の候補にする。差出人のドメインは `notifications.<brand>.<domain>`、SPF・DKIM・DMARC。`List-Unsubscribe` と、1 回の操作での配信の停止（RFC 8058）でメールのまとまりを止める。宛先の不達（ハードバウンス）と苦情で、そのアカウントのメールを止め、画面に示す。
- メールの送信事業者に渡すのは、メールアドレスと本文（イシューのタイトル、コメントの抜粋）。これは法務の L1（外国にある第三者への提供、委託）の対象になりうる。SES の東京のリージョンでも、事業者の扱いは法務の確認を待つ。**E9 のメールの送信の spec は、L1 の結論まで承認しない**（[intent.md](../intent.md)）。

### 8.3 Slack の個人への通知

- 利用者が Slack のアカウントを結び付けた後（integrations の領域）に使える。
- 送り係は、`deliver_after = created_at + 30 秒` で予定を作る。30 秒の間にインボックスで既読にしたら送らない（アプリで見ている人に二重に届かないように）。
- 送る前の確かめは 8.2 節と同じ。中身は識別子、タイトル、行為者、種類、アプリへのリンク。コメントの抜粋は入れない（Slack のワークスペースの保持の規則の外に中身が残るため。本システムの決定）。
- 同じ受け手への 30 秒の中の複数の行は、1 つの DM にまとめる。
- DM からの操作（既読にする、購読をやめる）は MVP では持たない。
- Slack へ渡すのも法務の L1 の対象。**E10 の Slack の連携の spec は L1 の結論まで承認しない**。

### 8.4 Urgent

- Urgent の担当への通知（DT-NOTIF-001 の行 1・8）は、メールを 1 分で送り（DT-NOTIF-002 の行 2）、メールの間隔の制限（10 分）を受けない。
- デスクトップでは、Urgent の通知を、焦点の条件にかかわらず出す。

## 9. 障害のときの振る舞い

| 事象 | 起きること | 備え |
| --- | --- | --- |
| 通知係が遅れる・止まる | 通知が遅れる | SQS に残るので、戻れば続きから作る。確定から行ができるまでの p95 を監視（5 秒）。60 秒を超えたら警告 |
| 同じ事象を 2 度受けた | — | 冪等の鍵（5.2 節） |
| 送り係が止まる | メールが遅れる | `deliver_after` の予定が残るので、戻れば送る。予定から 30 分遅れたものは、まとめて 1 通にする（古い通知を 1 件ずつ送らない） |
| メールの送信事業者の障害 | 送れない | 指数の待ちで再試行（6 時間まで）。その後は送らず、インボックスに残る |
| 大量の通知（一括の編集、関係の多いイシュー） | 受け手のインボックスが埋まる | 一括の編集（500 件）の変更は、受け手ごとに 1 つの通知にまとめる（`kind` と行為者が同じなら、主題の代わりに「N 件のイシュー」の行。`subject_kind = view` の一時の集まり）は MVP の後。MVP は 5.4 節の上限で抑える |
| クライアントの時計がずれている | スヌーズの戻りの時刻がずれる | 表示だけなので受け入れる |

## 10. セキュリティ

- **中身を行に入れない**（4.2 節）。通知の行は ID と種類だけ。主題の権限が変わっても、手元の通知から中身は漏れない。
- **作る時と送る時の二度の確かめ**：通知係は作る時に `can()`、メールと Slack は送る時にもう一度 `can()`（7 節）。
- **非公開のチームのメンション**：メンバーでない人には出さない（5.3 節）。メンションの候補にも出さない（[editor-and-descriptions.md](editor-and-descriptions.md) の 6 節）。
- **行為者の名前**：通知は `actor_id` を持つ。受け手は行為者の `User` を読める（`workspace` のグループ）。
- **購読の一覧**：`NotificationSubscription` は本人のグループ。誰がプロジェクトを購読しているかは他の人に届かない。`Issue.subscriber_ids` はイシューと同じグループ（イシューを読める人に届く。本家と同じく、購読者の一覧は見える）。
- **メールの宛先**：`User.email` ではなく、アカウントの確認済みのメールアドレス（[accounts-and-auth.md](accounts-and-auth.md) の 4.2 節）に送る。
- **メールのリンク**：ログインのトークンを入れない。リンクはアプリの URL だけで、開けばログインを求める。
- **ログ**：通知の中身（タイトル、抜粋）をログに書かない。ID・種類・受け手の数だけ。
- **法務**：L1（送信事業者と Slack への提供）、L2（利用者の間の意思の伝達の媒介）の結論まで、E9 のメール・通知の公開の spec を承認しない。

## 11. テスト

- **表駆動テスト**：DT-NOTIF-001（事象と受け手）、DT-NOTIF-002（メールの待ち）。
- **性質ベーステスト**（[ADR-0010](../decisions/0010-deterministic-sync-simulator.md) のシミュレーターに通知係を足す）：
  - **PROP-NOTIF-001（1 回だけ）**：任意の事象の重複・並べ替え・通知係の落ちと再開の後、各（受け手、事象）について `Notification` はちょうど 0 か 1 行。
  - **PROP-NOTIF-002（読める人だけ）**：任意のメンバーシップ・非公開への切り替え・移動の列の後、通知係と後始末が終わった状態で、各人の `Notification` の主題は、その人が読めるものだけ。
  - **PROP-NOTIF-003（既読の収束）**：任意の端末での既読・未読・全部を既読・スヌーズの列の後、全端末の既読の判定が一致する。
  - **PROP-NOTIF-004（送り）**：任意の既読とスヌーズの時刻の列で、メールに入るのは、送る時に未読でスヌーズでなく、読める主題の行だけ。
- **結合テスト**：時計を進めて送り係を回し、まとめ、間隔（10 分）、Urgent の 1 分、`List-Unsubscribe` の停止を確かめる（メールの送信は模擬）。
- **E2E**（Playwright）：2 つのブラウザで、片方で既読にすると他方のインボックスが 1 秒以内に既読になる。書き手のタブだけが OS の通知を出す。

## 12. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E9 | `notifier-worker` | 3 節の流れ、5.1〜5.4 節の生成、冪等の鍵、PROP-NOTIF-001 |
| E9 | `notification-model-and-inbox` | 4.2 節の `Notification`・`InboxState`、インボックスの画面（client-app と共同） |
| E9 | `read-snooze-delete` | 6.1・6.2・6.4 節、PROP-NOTIF-003 |
| E9 | `issue-reminders` | 6.3 節 |
| E9 | `notification-subscriptions` | 4.1 節の `NotificationSubscription` と派生 |
| E9 | `notification-preferences` | 4.3 節 |
| E9 | `notification-access-sweep` | 7 節の後始末、PROP-NOTIF-002（permissions-and-teams と共同） |
| E9 | `desktop-notifications` | 8.1 節（client-app の同名の Story と同じ） |
| E9 | `email-digest` | 8.2 節と DT-NOTIF-002、PROP-NOTIF-004。**法務の L1・L2 の後に承認** |
| E9 | `urgent-handling` | 8.4 節 |
| E9 | `mention-notifications` | DT-NOTIF-001 の行 3・4（editor-and-descriptions の同名の Story と同じ） |
| E10 | `slack-personal-notifications` | 8.3 節（integrations と共同）。**法務の L1 の後に承認** |
| E7 | `project-update-notifications` | DT-NOTIF-001 の行 11・12（cycles-and-projects と共同） |
| E12 | `notification-load-test` | 繰り越し・一括の編集・大きなイシューの購読者での通知係の負荷 |

## 13. 未解決の問い

- 通知の行を Writer の `derive` で作るか、確定の後の Worker で作るか。
- 通知の行にタイトルなどの中身を写すか。
- コメントのスレッドだけの購読（本家）を持つか。
- 同じ主題の通知を、行でまとめるか、画面でまとめるか。
- メールの待ちの時間。
- デスクトップの通知を、端末ごとに出すか、1 台だけに出すか。
- Slack の DM に抜粋を入れるか。

### 決定

2026-09-28 の既定案。E9 の実装と試用の声で覆りうる。

- **作り方**：確定の後の通知係（Worker）。Writer のシステムのトランザクションで書く（ADR-0036）。受け手の数・設定・権限の確かめを、Writer のロックの外で行うため。
- **中身**：写さない。ID と種類だけ（ADR-0036）。
- **スレッドの購読**：MVP では持たない。メンションされた人はイシューを購読する（editor-and-descriptions の決定に従う）。本家との違いとして残す。
- **まとめ**：画面でまとめる。行は事象ごと（ADR-0036）。
- **メールの待ち**：Urgent 1 分、担当・メンション 10 分、コメント・プロジェクト 30 分、他 60 分。間隔 10 分（ADR-0037）。
- **デスクトップ**：端末ごとに、書き手のタブだけが出す。2 分より古いものは出さない（ADR-0037）。
- **Slack の抜粋**：入れない（ADR-0037）。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| メールの送信事業者と、中身を入れてよいか | 法務の L1 の結論の後（E9） |
| 通知・コメントが電気通信事業の届出に当たるか | 法務の L2（E9 の通知の公開の前） |
| 一括の編集の通知のまとめ（「N 件のイシュー」） | MVP の後。本番の通知の数を見て |
| スレッドの購読のモデル | 試用の声を見て。足すなら editor-and-descriptions と共同で ADR を書く |
| 本家のメールの待ち、まとまりの一覧、Slack の DM の操作 | 公式の資料では確かめられなかった（**未検証**のまま） |

## 14. quality.md・runbooks・data-model への項目

### quality.md

- DT-NOTIF-001・002 の表駆動テストと、PROP-NOTIF-001〜004 を E9 のリリースの基準にする。PROP-NOTIF-002 は NFR-008 の試験の一部にする。
- 本番：確定から通知の行ができるまでの p95（5 秒）、予定から送信までの遅れ、メールの不達と苦情の率。
- 本番：送る時の確かめで落とした数（既読、スヌーズ、権限）。権限で落ちた数が、切り替えの直後以外で出たら調べる。
- 本番：1 人の通知が 2,000 件の上限に当たった人の数。

### runbooks

- `notifier-lag.md`：通知係の遅れの切り分け（Relay、SQS の滞留、Writer の待ち）と、Worker を増やす手順。
- `email-delivery-issues.md`：送信事業者の障害、不達の急増、差出人のドメインの評判の低下への対応。
- `notification-storm.md`：誤った一括の変更で大量の通知が出たときの止め方（通知係のワークスペースごとの停止のフラグ）と、出た通知の消し方。

### data-model（索引への追加の提案）

| 表・モデル | 中身 | 節 |
| --- | --- | --- |
| `notifications`（`Notification`） | 受け手、種類、主題の ID、行為者、既読、スヌーズ | 4.2 |
| `inbox_states`（`InboxState`） | 全部を既読の水位 | 4.2 |
| `notification_subscriptions`（`NotificationSubscription`） | プロジェクト・チームの購読 | 4.1 |
| `notification_preferences`（`NotificationPreference`） | まとまりごとの手段、メールの形、デスクトップの文面 | 4.3 |
| `issue_reminders`（`IssueReminder`） | 後で知らせる | 6.3 |
| `notification_keys`（サーバーだけ） | 冪等の鍵（30 日） | 5.2 |
| `notification_deliveries`（サーバーだけ） | メール・Slack の送りの予定と結果 | 8.2、8.3 |

## 出典

いずれも 2026-09-28 に確認。

- Linear Docs, [Notifications](https://linear.app/docs/notifications)、[Inbox](https://linear.app/docs/inbox)、[Slack](https://linear.app/docs/slack)、[Priority](https://linear.app/docs/priority)、[Initiative and Project updates](https://linear.app/docs/initiative-and-project-updates)
- IETF, [RFC 8058: Signaling One-Click Functionality for List Email Headers](https://www.rfc-editor.org/rfc/rfc8058)

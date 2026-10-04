# Permissions and Teams: Linear

ワークスペースのロール（オーナー・管理者・メンバー・ゲスト）、チームとメンバーシップ（参加・脱退）、非公開のチーム、1 つの権限の関数 `can()`、同期グループとの対応、権限の変化の配り方を決める。ゲストは MVP の後に出すが、同期グループの形は今決める。

前提となる決定は、テナントと非公開のチーム（[ADR-0004](../decisions/0004-tenancy-and-permissions.md)）、同期グループと購読の変化（[ADR-0003](../decisions/0003-bootstrap-and-partial-sync.md)、[ADR-0013](../decisions/0013-sync-group-changes-retention-and-reset.md)）、Writer の検証（[ADR-0006](../decisions/0006-transactions-writer-and-idempotency.md)）、定義の言語と同期グループの規則（[ADR-0019](../decisions/0019-schema-definition-and-codegen.md)）、派生の変更の権限（[ADR-0025](../decisions/0025-derived-changes-in-writer.md)）。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0032](../decisions/0032-single-policy-module-and-group-mapping.md) | 権限は `packages/policy` の純粋な関数 `can(principal, action, target)` と `groupsFor(principal)` にまとめ、Writer・Sync API・Gateway・検索・ビューの問い合わせ・通知・公開 API とクライアントが同じコードを使う。読む権限は「行の同期グループと、その人の購読が交わる」と同じ意味にし、性質ベーステストで両者の一致を確かめる。書く権限と管理の権限は決定表（DT-PERM-001〜003）で決める |
| [0033](../decisions/0033-team-visibility-changes-and-guests.md) | 同期グループに `members`（ゲストを除くワークスペースのメンバー）を足し、ゲストに届けないワークスペースの行（イニシアチブ、ワークスペースのビュー）をそこに置く。チームの行は、公開なら `workspace`、非公開なら `team:<id>` と `role:admin` に属す。非公開への切り替えは、同期（ADR-0004・0013）に加えて、プロジェクトのつながり・ビュー・通知・検索の後始末を、同じトランザクションか、それに続く Worker で行う。管理者は非公開のチームに自分で参加でき、その参加を監査に残す |

## 1. 目的と範囲

- 扱う：
  - ワークスペースの行と設定（`Workspace`・`WorkspaceSettings`）の定義
  - ワークスペースのロールと、メンバーの停止
  - チーム、公開と非公開、チームのメンバーシップ（参加・脱退・招き入れ）
  - `can()` の形、入力、決定表
  - 同期グループの一覧と、モデルごとの規則の確認（`team_or_workspace`・`via` など）
  - 権限の変化（参加・脱退、非公開への切り替え、ロールの変更、停止）の配り方
  - ゲスト（MVP の後。形だけ今決める）
- 扱わない：
  - ログイン、セッション、招待のメール、SAML・SCIM（[accounts-and-auth.md](accounts-and-auth.md)）
  - 購読の変化の同期の手順（[bootstrap-and-partial-sync.md](bootstrap-and-partial-sync.md) の 7 節。ここでは、何がいつ変わるかだけを決める）
  - 公開 API のキー・OAuth のアプリ・Webhook の権限（[api-and-webhooks.md](api-and-webhooks.md)。`can()` を使う）
  - サブチーム（入れ子のチーム）、チームのオーナーのロール、イシューの個別の共有（MVP の後）

## 2. 本家の形（確かめたこと）

いずれも公式の文書。2026-09-28 に確認。

| 項目 | 内容 | 出典 |
| --- | --- | --- |
| オーナー | Enterprise だけ。請求・セキュリティ・監査ログを含む全部の管理 | [Members and roles](https://linear.app/docs/members-roles) |
| 管理者 | 日々のワークスペースの管理。Free では全員が管理者 | 同上 |
| メンバー | 見られるチームで協働する。ワークスペースの管理の画面に入れない | 同上 |
| ゲスト | Business 以上。メンバーと同じ料金。指定したチームだけ。ワークスペースのビュー・顧客の要望・イニシアチブを見られない。設定はアカウントの欄だけ | 同上 |
| チームのオーナー | Business 以上。チームの削除や非公開の設定などを、チームのオーナーに限れる | 同上 |
| 停止 | 管理者がメンバーを停止すると、すぐに全部のアクセスを失う。履歴のために一覧に残る | 同上 |
| チームへの参加 | 非公開でないチームは、全メンバーが見て参加できる。チームに参加しなくても、イシューを作り、担当になれる | [Teams](https://linear.app/docs/teams) |
| 非公開のチームの作成 | 誰でも作れる。オーナーが招く。自分で抜けた人は、招かれない限り戻れない | [Private teams](https://linear.app/docs/private-teams) |
| 非公開への切り替え | メンバーでない人は、開いているイシューの担当から外れ、購読も外れる。管理者が戻せる | 同上 |
| 管理者の見え方 | 管理の設定でチームの存在が見える。イシューを見るには参加が要る。参加の前に警告が出る | 同上 |
| メンション | メンバーでない人を、非公開のチームのイシューでメンションできない | 同上 |
| チームの上限 | Free は 2、Basic は 5、Business 以上は無制限 | [Teams](https://linear.app/docs/teams) |

- ゲストが公開のチームの一覧（名前）を見られるか、ゲストに他のメンバーのメールアドレスが見えるかは、文書に書かれていない（**未検証**）。
- [ADR-0004](../decisions/0004-tenancy-and-permissions.md) と [architecture/README.md](README.md) の 7 節は、ロールを「オーナー・管理者・メンバー」とし、ゲストを MVP の後としている。この文書はそれに従い、ゲストの形（6 節）を足す。

## 3. 主体とモデル

### 3.1 ワークスペースのロール

| ロール | 数 | できること（概要） |
| --- | --- | --- |
| `owner` | 1 人以上 | 管理者の全部に加えて、請求、セキュリティ（ログインの手段の制限、SAML）、ワークスペースの削除、オーナーの付け外し |
| `admin` | 0 人以上 | メンバーの招待・停止・ロールの変更（オーナーを除く）、チームの作成・削除・公開の切り替え、ワークスペースの設定、連携 |
| `member` | — | 見てよいチームで読み書き。チームを作る（非公開を含む）。公開のチームに参加・脱退 |
| `guest` | — | 参加させられたチームだけで読み書き。自分でチームに参加しない。ワークスペースのビュー・イニシアチブを見ない |

- 本家はオーナーを Enterprise に限る。本システムは MVP からオーナーを置く（ADR-0004）。請求とセキュリティの設定を、日々の管理と分けるため。
- 最後のオーナーの降格・停止は `workflow_violation`。

### 3.2 モデル

```ts
model("User", {                       // ワークスペースの中の人。アカウント（accounts-and-auth）とは別
  groups: { rule: "workspace" }, load: { strategy: "instant" }, delete: { mode: "hard" },
  fields: {
    account_id:   { type: "uuid", conflict: "server_only", api: "internal" },
    name:         { type: "string", conflict: "lww", max: 128, pii: "identity" },
    display_name: { type: "string", conflict: "lww", max: 64, pii: "identity" },
    email:        { type: "string", conflict: "server_only", max: 320, pii: "identity" },
    avatar_url:   { type: "string", conflict: "lww", nullable: true, max: 1024 },
    role:         { type: "enum<owner,admin,member,guest>", conflict: "lww" },
    status:       { type: "enum<active,suspended>", conflict: "lww" },
    timezone:     { type: "string", conflict: "lww", max: 64 },
  },
});
model("Team", {
  groups: { rule: "team_row" },       // 公開：workspace。非公開：team:<id> と role:admin（6.3 節）
  load: { strategy: "instant" }, archivable: true, delete: { mode: "trash", purge_after_days: 30 },
  fields: {
    key:        { type: "string", conflict: "lww", max: 7 },          // data-model-and-schema の 5.2 節
    name:       { type: "string", conflict: "lww", max: 80 },
    visibility: { type: "enum<public,private>", conflict: "lww" },
    /* ワークフロー（issues-and-workflow の 3.1 節）とサイクル（cycles-and-projects の 3.1 節）の設定 */
  },
});
model("TeamMembership", {
  groups: { rule: "team_row", from: "team_id" },   // チームの行と同じグループ
  load: { strategy: "instant" }, delete: { mode: "hard" },
  fields: {
    team_id: { type: "ref:Team", conflict: "server_only", on_delete: "cascade", index: true },
    user_id: { type: "ref:User", conflict: "server_only", on_delete: "cascade", index: true },
  },
});
```

- `User.role`・`User.status` を変える操作は、`can(actor, "manage_member", user)`（DT-PERM-002）。Writer は同じトランザクションで購読を計算し直す（7 節）。
- `User` の `email` は、ワークスペースの全員（ゲストを含む）に届く。担当の候補とメンションで本人を見分けるため。ゲストに見せるかは 12 節の問い。
- `TeamMembership` は `(team_id, user_id)` で一意。作ると参加、消すと脱退。
- チームのオーナーのロール（本家の Business 以上）は MVP の後。`TeamMembership` に `role` を足す形で、広げる変更として足せる。

### 3.3 `Workspace` と `WorkspaceSettings`

ワークスペースの行の定義の正本はこの節である（統合の工程で、accounts-and-auth・security・infrastructure・api-and-webhooks に散っていた列をここに集めた）。

```ts
model("Workspace", {                  // 1 ワークスペース 1 行。id = workspace_id
  table: "workspaces",
  groups: { rule: "workspace" },
  guest_visible: "名前・slug・タイムゾーンは、ゲストの画面の表示と URL に要る",
  load: { strategy: "instant" }, delete: { mode: "hard" },   // 消すのは削除のジョブだけ（security の 9.1 節）
  fields: {
    slug:     { type: "string", conflict: "lww", max: 48 },                 // URL の /<workspace-slug>/。全体で一意
    name:     { type: "string", conflict: "lww", max: 80 },
    timezone: { type: "string", conflict: "lww", max: 64 },                 // IANA の名前。既定 Asia/Tokyo
    region:   { type: "enum<tokyo>", conflict: "server_only" },             // S3 で海外のリージョンを足す（作る時に決め、変えない）
    status:   { type: "enum<active,pending_deletion,moving>", conflict: "server_only" },
    deletion_requested_at: { type: "timestamp", conflict: "server_only", nullable: true },
  },
});
model("WorkspaceSettings", {          // 1 ワークスペース 1 行
  groups: { rule: "workspace_members" },   // ゲストに届けない（6 節）
  load: { strategy: "instant" }, delete: { mode: "hard" },
  fields: {
    members_can_invite:    { type: "bool", conflict: "lww", default: false },
    allowed_email_domains: { type: "set<string>", conflict: "set", max: 10 },   // 確認の状態はサーバーだけの表
    login_methods:         { type: "set<string>", conflict: "set", max: 4 },    // email_otp・google・passkey（後に saml）
    api_keys_allowed:      { type: "enum<all,admins,none>", conflict: "lww", default: "all" },
    oauth_apps_allowed:    { type: "bool", conflict: "lww", default: true },
    slack_unfurl_enabled:  { type: "bool", conflict: "lww", default: true },
    update_reminder:       { type: "json", conflict: "lww", schema: "UpdateReminder" },
    default_team_id:       { type: "ref:Team", conflict: "lww", nullable: true, on_delete: "nullify" },
  },
});
```

| 列 | 使う領域 |
| --- | --- |
| `slug`・`name`・`timezone` | 画面と URL（[client-app.md](client-app.md) の 3.3 節）、サイクルと催促の既定のタイムゾーン（[cycles-and-projects.md](cycles-and-projects.md)） |
| `region` | S3 のリージョンの固定（[infrastructure.md](infrastructure.md) の 10.2 節） |
| `status`・`deletion_requested_at` | ワークスペースの削除の猶予（[security.md](security.md) の 9.1 節）、S2 のクラスタの移動（[infrastructure.md](infrastructure.md) の 10.1 節）。`pending_deletion`・`moving` の間、Writer は利用者の書き込みを受けない（`moving` は `retry`、`pending_deletion` は `forbidden`） |
| `members_can_invite`・`allowed_email_domains`・`login_methods`・`default_team_id` | 招待と参加、ログインの制限（[accounts-and-auth.md](accounts-and-auth.md) の 7・8 節） |
| `api_keys_allowed`・`oauth_apps_allowed` | 公開 API（[api-and-webhooks.md](api-and-webhooks.md) の 6.2・6.3 節） |
| `slack_unfurl_enabled` | Slack のリンクの展開（[integrations.md](integrations.md) の 5.4 節） |
| `update_reminder` | プロジェクトの更新の催促（[cycles-and-projects.md](cycles-and-projects.md) の 6.2 節） |

- `workspaces` の表も、他のワークスペースの表と同じく `workspace_id`（= `id`）と FORCE RLS を持つ。ワークスペースのコンテキストを決める前に slug から ID を引く処理（画面の最初の URL の解決）は、`SECURITY DEFINER` の関数 `resolve_workspace_slug(slug)` だけで行い、`(id, status, region)` だけを返す（[data-model.md](data-model.md) の 5 節）。アカウントから入れるワークスペースの一覧は `auth.workspace_directory`（[accounts-and-auth.md](accounts-and-auth.md) の 4.1 節）。
- 行はワークスペースを作る時に Writer が作る。`status` と `region` は Writer のシステムのトランザクション（削除のジョブ、移動のジョブ）だけが書く。
- `members_can_invite` の既定は偽（招待は管理者だけ）。本家の有料のプランの既定と同じで、管理者が設定で全員に広げられる（[Invite members](https://linear.app/docs/invite-members)、[Members and roles](https://linear.app/docs/members-roles)、2026-09-28 に確認）。B2B の利用で、知らない人が勝手に招かれない安全な既定にするため。
  > 2026-09-28 の注記：当初の既定は真（本家の無料のプランの振る舞い）だった。PM の判断で偽に替えた（[README.md](README.md) の 6 節の決定）。
- `slug` の長さ（48 文字まで）は本システムの既定である。URL に入れて読める長さに抑えるため。本家の上限は公式の資料で確かめられなかった（**未検証**）。
- 書ける人は DT-PERM-002 の行 1・行 17 と DT-PERM-003。

## 4. `can()`

ADR-0032。

### 4.1 形

```ts
// packages/policy（手で書く。data-model-and-schema の 4.3 節）
type Principal = {
  kind: "user" | "system" | "api_key" | "oauth_app";
  user_id: string | null;
  role: "owner" | "admin" | "member" | "guest" | null;
  status: "active" | "suspended";
  teams: ReadonlySet<string>;                 // TeamMembership のチーム
  scopes?: ReadonlySet<string>;               // API キー・OAuth の範囲（api-and-webhooks の 3.5 節）
  teams_restriction?: ReadonlySet<string>;    // API キーのチームの絞り（なければ絞らない）
};
type Facts = {                                 // 判定に要る、他の行の値
  teamVisibility(team_id): "public" | "private" | null;
  groupsOf(model, row): string[];              // 生成したコード（data-model-and-schema の 3.5 節）
};
function can(p: Principal, action: Action, target: Target, facts: Facts): boolean;
function groupsFor(p: Principal, facts: Facts): string[];   // 5.1 節
```

- 純粋な関数。I/O をしない。`Facts` の中身は、Writer では DB から（ロックの中で）、クライアントでは手元のモデルから、Gateway・Sync API では握手の時に DB から読む。
- `system`（Worker の定期処理）は、すべての行を読み書きできる。ただし、人に結び付く派生（購読者を足す、通知を作る）は、受け手の `can(受け手, "read", …)` で絞る（ADR-0025）。
- クライアントの `can()` は、画面で操作を出す・出さないのためだけに使う（[client-app.md](client-app.md) の 7 節）。正はサーバー。
- **公開 API の主体の重ね方**：`kind` が `api_key`・`oauth_app` のとき、`can()` は `can(user, action, target) ∧ scopeAllows(scopes, action, target) ∧ teamAllows(teams_restriction, target)` を返す（ADR-0042、[api-and-webhooks.md](api-and-webhooks.md) の 3.5 節）。`scopeAllows`（範囲の表）と `teamAllows`（キーのチームの絞り）も `packages/policy` に置き、`Principal` に `scopes` と `teams_restriction` を持つ。範囲で許す操作の表の正本は api-and-webhooks の 3.5 節で、`packages/policy` はそれを実装する。
- **狭める操作の印**：`packages/policy` は、権限を狭める操作（停止、ロールの引き下げ、非公開への切り替え、脱退、取り消し）の一覧を持つ。Writer と認証のサービスは、これに当たる操作を確定したとき、DR のための追記だけの記録にも書く（[ADR-0058](../decisions/0058-dr-permission-narrowing-journal.md)）。

### 4.2 読む権限と同期グループ

- **定義**：`can(p, "read", row) ⇔ groupsOf(row) ∩ groupsFor(p) ≠ ∅`。
- 読む権限を、行の中身から別に計算しない。この定義にすることで、同期（差分・ブートストラップ・遅延の読み込み）、ビューの問い合わせ、検索、通知が、同じ答えを返す。PROP-PERM-001 で、決定表（4.3 節）とこの定義が一致することを確かめる。
- 例外はない。「行は届くが、ある人には読めない」行を作らない。その必要があるものは、モデルを分ける（プロジェクトのチームのつながりを `ProjectTeam` に分けたのと同じ。[cycles-and-projects.md](cycles-and-projects.md) の 3.3 節）。

### 4.3 チームの行の読み書き

DT-PERM-001。対象が、チームのグループの行（イシュー、コメント、状態、ラベル、サイクル、チームのビュー、`ProjectTeam` など）のとき。上から評価し、最初に当たった行。

| # | `status` | ロール | チーム | メンバーか | 読む | 書く（作る・変える・消す） |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `suspended` | どれでも | — | — | 否 | 否 |
| 2 | `active` | `owner`・`admin`・`member` | 公開 | どちらでも | 可 | 可 |
| 3 | `active` | どれでも | 非公開 | はい | 可 | 可 |
| 4 | `active` | `owner`・`admin` | 非公開 | いいえ | 否（チームの行と `TeamMembership` だけ可） | 否 |
| 5 | `active` | `guest` | どれでも | はい | 可 | 可 |
| 6 | `active` | `guest`・`member` | 非公開・公開（ゲスト） | いいえ | 否 | 否 |

- 行 2：公開のチームは、参加していなくても読み書きできる（本家と同じ）。参加はサイドバーと通知の既定だけを変える。
- 行 4：管理者は非公開のチームの存在と名前・メンバーを見られるが、イシューは見られない（本家と同じ）。見るには参加する（7.1 節）。

### 4.4 管理の操作

DT-PERM-002。上から評価し、最初に当たった行。`actor` が `suspended` なら、どれも否。

| # | 操作 | 可 |
| --- | --- | --- |
| 1 | ワークスペースの削除、請求、ログインの手段の制限、オーナーの付け外し | `owner` |
| 2 | メンバーの停止・戻し、ロールの変更（`owner` 以外への） | `owner`・`admin`。自分自身の降格は、最後の管理者・オーナーでなければ可 |
| 3 | 招待を作る・取り消す | `owner`・`admin`。ワークスペースの設定 `members_can_invite` が真なら `member` も（本家と同じ） |
| 4 | チームを作る | `owner`・`admin`・`member`（ゲストは否） |
| 5 | チームの削除、公開・非公開の切り替え | `owner`・`admin` |
| 6 | チームの設定（ワークフロー、サイクル、見積もり、ラベル、テンプレート） | `owner`・`admin`、そのチームのメンバー（ゲストを除く） |
| 7 | 公開のチームに自分で参加・脱退 | `owner`・`admin`・`member` |
| 8 | 非公開のチームに自分で参加 | `owner`・`admin`（警告を出し、監査に残す。7.1 節） |
| 9 | チームに他の人を加える | 公開：`owner`・`admin`・そのチームのメンバー（ゲストを除く）。非公開：`owner`・`admin`（参加している）・そのチームのメンバー（ゲストを除く） |
| 10 | チームから他の人を外す | `owner`・`admin`・そのチームのメンバー（ゲストを除く） |
| 11 | 非公開のチームから自分で抜ける | 可。ただし最後のメンバーは否（`workflow_violation`）。戻るには招き入れが要る（行 8・9） |
| 12 | ゲストをチームに加える | `owner`・`admin` |
| 13 | 連携のインストールの作成・削除（GitHub・GitLab・Slack） | `owner`・`admin`（[integrations.md](integrations.md) の 4.1・5.1 節） |
| 14 | インポートの開始・取り消し、ワークスペースの JSON の書き出し | `owner`・`admin`（[import-export.md](import-export.md) の 3・6・7 節） |
| 15 | OAuth のアプリの登録・削除、Webhook の作成（DT-HOOK-001） | `owner`・`admin`（[api-and-webhooks.md](api-and-webhooks.md) の 5.2・6.3 節） |
| 16 | API キーを作る | `WorkspaceSettings.api_keys_allowed` が `all` なら `owner`・`admin`・`member`、`admins` なら `owner`・`admin`、`none` なら否 |
| 17 | `Workspace`・`WorkspaceSettings` を変える（`login_methods` を除く） | `owner`・`admin` |

- 非公開のチームの招き入れを、チームのメンバーに許すのは、本家の「チームのオーナーが招く」の代わりである。チームのオーナーのロールは MVP の後。

### 4.5 モデルごとの規則

DT-PERM-003。4.3 節で「書く：可」のときに、さらに当てる規則。

| モデル | 操作 | 規則 |
| --- | --- | --- |
| `Comment`・`ProjectUpdate` | `set body` | 書いた人だけ（[ADR-0022](../decisions/0022-comments-anchors-mentions-attachments.md)） |
| `Comment` | `delete` | 書いた人か、`owner`・`admin` |
| `Reaction` | `create`・`delete` | 本人の行だけ |
| `View`（`personal`） | どれでも | 持ち主だけ |
| `View`（`team`・`workspace`） | `set`・`delete` | 持ち主か、`owner`・`admin`（[views-and-filters.md](views-and-filters.md) の 7.1 節） |
| `Notification`・`ViewPreference`・`IssueDraft` | どれでも | 本人の行だけ（`user:<id>` のグループ） |
| `ProjectStatus`・`update_reminder` | どれでも | `owner`・`admin` |
| `Initiative` | どれでも | `owner`・`admin`・`member`（ゲストは読めないので否） |
| `ProjectTeam` | `create`・`delete` | 両方のチームの行を書ける人（そのチームを見てよい人） |
| `Issue` | `set assignee_id` | 担当になる人がそのチームを読める（見てよくなければ `invalid_reference`） |
| 本文・コメントのメンション | 候補 | メンションされる人がそのイシューを読める（本家と同じ） |
| `SlackChannelSubscription` | `create`・`delete` | `owner`・`admin` と、対象のチームのメンバー（ゲストを除く）。対象は公開のチームと、公開のチームだけにつながるプロジェクト（[integrations.md](integrations.md) の 5.3 節） |
| `IssueDescriptionVersion` | `delete` | `owner`・`admin`（消したつもりの秘密をバージョンから消す。監査に残す。[editor-and-descriptions.md](editor-and-descriptions.md) の 4.7 節、[security.md](security.md) の 9 節） |
| `Workspace` | `set slug`・`set name`・`set timezone` | `owner`・`admin` |
| `WorkspaceSettings` | `set login_methods`・`add`・`remove` | `owner` だけ（DT-PERM-002 の行 1） |

## 5. 同期グループとの対応

ADR-0032。

### 5.1 `groupsFor`

| グループ | 購読する人 |
| --- | --- |
| `workspace` | `active` の全員（ゲストを含む） |
| `members` | `active` の `owner`・`admin`・`member`（ゲストを除く） |
| `team:<id>`（公開） | `active` の `owner`・`admin`・`member` の全員と、そのチームのゲスト |
| `team:<id>`（非公開） | そのチームの `TeamMembership` のある `active` の人 |
| `user:<id>` | 本人（`active`） |
| `role:admin` | `active` の `owner`・`admin` |

- `suspended` の人の購読は空。Writer は停止のトランザクションで、その人の `SyncSubscription` を全部消す（7.4 節）。
- `members` は ADR-0033 で足す。[ADR-0003](../decisions/0003-bootstrap-and-partial-sync.md) の 4 つのグループの表への追加である。

### 5.2 モデルごとの規則（確認）

[data-model-and-schema.md](data-model-and-schema.md) の 3.5 節の規則を、各領域の定義と照らして確かめた。

| 規則 | 行のグループ | 使うモデル | 確かめたこと |
| --- | --- | --- | --- |
| `workspace` | `workspace` | `Workspace`、`User`、`ProjectStatus` | ゲストも要る行だけに使う |
| `workspace_members`（新規） | `members` | `WorkspaceSettings`、`Initiative`、ワークスペースの `View` | ADR-0033 |
| `team` | `team:<from>` | `Issue`、`WorkflowState`、`Cycle`、`ProjectTeam`、`ProgressStat` | — |
| `team_or_workspace` | `from` があれば `team:<値>`、`null` なら `workspace` | `IssueLabel`、`IssueTemplate` | ワークスペースのラベルはゲストも付ける・読むので `workspace` で正しい（`members` にしない） |
| `team_row`（新規） | 公開：`workspace`。非公開：`team:<id>` と `role:admin` | `Team`、`TeamMembership` | ADR-0033。公開のチームの一覧は全員（ゲストを含む）に届く |
| `via` | 参照先の行のグループ。2 つの参照なら和 | `Comment`、`Reaction`（2 段）、`IssueDescription`、`IssueHistory`、`IssueAlias`、`IssueRelation`（両方）、`ProjectMilestone`、`ProjectUpdate`、`InitiativeProject` | 参照先がチームを移ると、Writer が依存の行を移す（[bootstrap-and-partial-sync.md](bootstrap-and-partial-sync.md) の 7.7 節）。`via` の先が `Project`（`teams` の規則）でも同じ |
| `teams` | 結び付けのモデルのチームのグループの和 | `Project` | 行の中の集合から読まず、`ProjectTeam` の行から読む（[data-model-and-schema.md](data-model-and-schema.md) の 3.5 節、[cycles-and-projects.md](cycles-and-projects.md) の 3.3 節） |
| `user` | `user:<from>` | `Notification`、`SyncSubscription`、`ViewPreference`、`IssueDraft`、個人の `View` | — |
| `admin` | `role:admin` | 連携の設定、`Invitation` | — |
| `view_scope`（新規） | `scope` で `user:`・`team:`・`members` | `View` | [views-and-filters.md](views-and-filters.md) の 7.1 節 |

- `IssueRelation` の `via` の和：公開のチームのイシューと、非公開のチームのイシューの関連の行は、両方のグループに入る。行は ID だけを持つ（ADR-0004）。公開のチームのメンバーには、非公開のチームのイシューの ID が 1 つ届く。これは ADR-0004 が受け入れたこと。画面は「非公開のイシュー」と描く。
- `Reaction` → `Comment` → `Issue` の 2 段の `via` は、上限（2 段）の中。

### 5.3 購読の計算の場所

- 購読（`SyncSubscription`）は、Writer がメンバーシップ・ロール・状態・チームの公開を変えるトランザクションの中で、`groupsFor` の前と後の差として書く（ADR-0013）。Gateway・Sync API は、握手の時に `sync_subscriptions` を読む（`groupsFor` を DB から計算し直さない）。
- Writer の中の `groupsFor` と、表の `sync_subscriptions` の食い違いは、1 日 1 回の監査のジョブで数える（`subscription_drift`）。0 でなければ、差を Writer のシステムのトランザクションで直し、調べる。

## 6. ゲストと `members` のグループ

ADR-0033。

### 6.1 ゲストに届けないもの

- 本家は、ゲストにワークスペースのビュー・イニシアチブ・顧客の要望を見せない。これらはワークスペース全体の行（今の `workspace` のグループ）なので、ゲストに `workspace` を購読させると届いてしまう。
- そこで、ゲストを除くメンバーだけが購読する `members` を足し、ゲストに届けないワークスペースの行をそこに置く。

### 6.2 各グループの行の振り分け

| グループ | 行 |
| --- | --- |
| `workspace`（ゲストを含む） | `Workspace`（名前、slug、タイムゾーン）、`User`、公開の `Team` と `TeamMembership`、ワークスペースの `IssueLabel`・`IssueTemplate`、`ProjectStatus` |
| `members`（ゲストを除く） | `WorkspaceSettings`、`Initiative`、ワークスペースの `View`、今後のワークスペース全体の機能（顧客の要望、ドキュメント） |

- 新しいワークスペースの行のモデルは、既定で `members` にし、ゲストに要ると判断したものだけを `workspace` にする。生成の検査で、`workspace` の規則のモデルには理由の注記（`guest_visible: "..."`）を必須にする（data-model への項目）。

### 6.3 チームの行

- 公開のチームの `Team` と `TeamMembership` は `workspace`。ゲストにも公開のチームの名前とメンバーの一覧が届く。本家の見え方は**未検証**。ゲストは担当の候補とメンションで人を選ぶのに、どのチームの人かを見る必要がある、と判断した。
- 非公開のチームの `Team` と `TeamMembership` は `team:<id>` と `role:admin`。管理者は、参加していなくても、非公開のチームの存在・名前・メンバーを見られる（本家と同じ）。

### 6.4 リリース

- ゲストのロールは MVP の後に出す（[intent.md](../intent.md)）。`guest` のロールを付ける操作は、フラグの裏に置く。
- `members` のグループと `workspace_members`・`team_row` の規則は、MVP から使う。後でゲストを足すときに、行のグループを変える（破壊の変更。[data-model-and-schema.md](data-model-and-schema.md) の 6.2 節）必要をなくすため。

## 7. 権限の変化

ADR-0033。同期の側の手順は [bootstrap-and-partial-sync.md](bootstrap-and-partial-sync.md) の 7 節。ここでは、どのトランザクションで何を書くかを決める。

### 7.1 チームへの参加・脱退

| 変化 | Writer（1 つのトランザクション） | 購読の差 |
| --- | --- | --- |
| 公開のチームに参加（メンバー） | `TeamMembership` を作る | なし（公開のチームは既に購読している） |
| 公開のチームに参加（ゲスト） | 同上 | `team:<id>` を足す |
| 非公開のチームに参加 | 同上 | `team:<id>` を足す |
| 管理者が非公開のチームに自分で参加 | 同上。監査の記録（`admin_joined_private_team`）を書く | `team:<id>` を足す |
| 公開のチームから脱退（メンバー） | `TeamMembership` を消す | なし |
| 非公開のチームから脱退 | `TeamMembership` を消す。その人を、そのチームの開いているイシューの担当から外し、購読者から外す（非公開への切り替えと同じ扱い） | `team:<id>` を消す |

- 非公開のチームから外れた人の担当と購読を外すのは、その人がもう読めないイシューの担当・購読者のままだと、通知の受け手の計算と、担当の表示が、読めない人を指し続けるため。本家は非公開への切り替えで同じことをする。脱退の扱いは本家の文書で確かめられない（**未検証**）。
- 担当・購読の外しが 1 万件を超えるときは、Writer は最初の 1 万件を同じトランザクションで、残りを Worker が 1,000 件ずつ外す。外し終わるまでの間も、その人の購読はもうないので、イシューの中身は届かない。

### 7.2 非公開への切り替え

DT-PERM-004。公開 → 非公開のトランザクションとその後。

| # | 対象 | 何をするか | どこで |
| --- | --- | --- | --- |
| 1 | `Team`・`TeamMembership` | `visibility = private`。行のグループを `workspace` から `team:<id>`・`role:admin` へ移す（`groups_before` 付きの `update`） | Writer（同じトランザクション） |
| 2 | 購読 | メンバーでない人（ゲストを含む）の `team:<id>` の `SyncSubscription` を消す | 同上 |
| 3 | 担当 | メンバーでない人を、開いているイシューの担当から外す（本家と同じ） | 同上（1 万件を超えたら Worker） |
| 4 | 購読者 | メンバーでない人を `subscriber_ids` から外す（本家と同じ） | 同上 |
| 5 | プロジェクト | 何もしない。`ProjectTeam` の行は既に `team:<id>` のグループなので、メンバーでない人の手元からは、つながりとチームごとの進捗が消える | — |
| 6 | ワークスペースのビュー | 何もしない（結果は同期グループで空になる）。このチームの ID を参照するワークスペースのビューの持ち主と管理者に、通知の事象 `view_references_private_team` を出す | Worker |
| 7 | 通知 | メンバーでない人の、このチームのイシューを主題とする `Notification` の行を消す（[notifications-and-inbox.md](notifications-and-inbox.md) の 7 節） | Worker（500 件ずつ） |
| 8 | 検索 | 何もしない（文書の `groups` はチームの ID。購読の側で次の検索から効く。[search.md](search.md) の 6.4 節） | — |
| 9 | メンションの候補 | 何もしない（候補は `can()` で絞る） | — |

- ロックの保持が長くなるので、このトランザクションだけ `lock_timeout` を 10 秒にする（[bootstrap-and-partial-sync.md](bootstrap-and-partial-sync.md) の 7.8 節）。
- 非公開 → 公開は、行 1 の逆（`team:<id>`・`role:admin` → `workspace`）と、ワークスペースの全メンバーの `SyncSubscription` を足すこと。担当・購読者は戻さない。

### 7.3 ロールの変更

| 変化 | 購読の差 |
| --- | --- |
| `member` → `admin`・`owner` | `role:admin` を足す |
| `admin` → `member` | `role:admin` を消す |
| `member` → `guest` | `members` と、参加していない公開のチームの `team:<id>` を消す |
| `guest` → `member` | `members` と、全部の公開のチームの `team:<id>` を足す |

### 7.4 停止と戻し

- 停止（`status = suspended`）：Writer は同じトランザクションで、その人の `SyncSubscription` を全部消す。担当・購読者は外さない（[issues-and-workflow.md](issues-and-workflow.md) の 5 節の「無効な利用者の担当は外さない」）。アカウントの側は、そのワークスペースのセッションの使用を止め、Gateway に `kick: forbidden` を送る（[accounts-and-auth.md](accounts-and-auth.md) の 6 節）。
- クライアントは、ワークスペースからの除外として手元の DB を消す（[bootstrap-and-partial-sync.md](bootstrap-and-partial-sync.md) の 7.6 節）。
- 戻し：`status = active`。ロールとチームのメンバーシップから購読を足す。
- メンバーを消すこと（`User` の削除）はしない。本家と同じく、停止だけにし、履歴の中の名前を残す。

## 8. 障害のときの振る舞い

| 事象 | 起きること | 備え |
| --- | --- | --- |
| `groupsFor` と `sync_subscriptions` がずれた | 見てよいのに届かない、または見てよくないのに届く | 5.3 節の監査。見てよくない方向のずれは漏えいとして扱い、runbook に従う |
| 非公開への切り替えのトランザクションが時間切れ | 切り替わらない | `retry`。大きなワークスペース（メンバー 2,000）で 10 秒に収まるかを E4 で測る |
| 担当・購読者の外しの Worker が遅れる | 外れる前の担当が画面に残る | 中身は届かない（購読がない）。表示は「非公開のイシュー」 |
| 通知の行の消しが遅れる | メンバーでない人の手元に、非公開のチームのイシューを主題とする通知の行が残る | 行は ID と種類だけで中身を持たない（[notifications-and-inbox.md](notifications-and-inbox.md) の 4.2 節）。描くときはイシューが手元にないので「非公開」と描く |
| クライアントの `can()` が古い | 画面で出した操作がサーバーで `forbidden` | 拒否の一覧に示す（ADR-0005） |

## 9. セキュリティ

- **判定を 1 か所にする。** `can()`・`groupsFor` の外に権限の条件を書かない。Writer・Sync API・Gateway・検索・ビューの問い合わせ・通知・公開 API が、`packages/policy` だけを呼ぶ。他の場所で `role ===` や `visibility ===` を書くことを lint で禁止する。
- **読む権限の定義を同期グループにする**（4.2 節）。検索（[search.md](search.md)）、ビューの問い合わせ（[views-and-filters.md](views-and-filters.md)）、通知の受け手（[notifications-and-inbox.md](notifications-and-inbox.md)）の漏れを、同期グループの試験でまとめて防ぐ。
- **行の中の他のグループの ID**：関連（`IssueRelation`）、担当（読めないチームへの担当は拒否）、ビューのフィルター（DT-VIEW-003）、プロジェクトのつながり（`ProjectTeam` に分けた）。行を加えるときは、他のグループの行を指す ID を持つかを、スキーマのレビューの項目にする。
- **管理者の非公開のチームへの参加**：可能だが、監査の記録に残し、チームのメンバーに「管理者が参加しました」と知らせる（通知の事象 `admin_joined_private_team`）。
- **存在を明かさない**：見てよくない行への参照・問い合わせ・URL は、ないのと同じに返す（ADR-0004）。
- **停止の即時性**：停止から、全部の接続の切断まで p99 5 秒（Gateway への知らせ。[accounts-and-auth.md](accounts-and-auth.md) の 6 節）。
- **ゲスト**：ゲストに届けない行を `members` に置き、新しいモデルは既定で `members`（6.2 節）。

## 10. テスト

- **表駆動テスト**：DT-PERM-001〜004 の全行を、spec から読み込み、Writer の検証とクライアントの `can()` の両方で確かめる（ADR-0004 の Confirmation）。
- **性質ベーステスト**（[ADR-0010](../decisions/0010-deterministic-sync-simulator.md) のシミュレーター）：
  - **PROP-PERM-001（読む権限と同期グループの一致）**：任意のロール・メンバーシップ・チームの公開・行で、DT-PERM-001 の「読む」と、`groupsOf(row) ∩ groupsFor(p) ≠ ∅` が一致する。
  - **PROP-PERM-002（手元の集合）**：任意のロールの変更・参加・脱退・非公開への切り替え・停止の列の後、各クライアントの手元（メモリー、IndexedDB）の行は、その時点で `can(p, "read", row)` が真のものだけ（ADR-0004 の Confirmation を、ゲストと `members` に広げたもの）。
  - **PROP-PERM-003（購読の一致）**：任意の列の後、`sync_subscriptions` が `groupsFor` と一致する。
  - **PROP-PERM-004（切り替えの後始末）**：非公開への切り替えの後、Worker が終わった状態で、メンバーでない人が、そのチームの開いているイシューの担当・購読者でなく、そのチームのイシューを主題とする通知の行を持たない。
- **lint**：`packages/policy` の外での権限の条件、`workspace` の規則のモデルの `guest_visible` の注記。
- **結合テスト**：停止から Gateway の切断までの時間、非公開への切り替えのトランザクションの時間（メンバー 2,000、イシュー 5 万）。
- **ペンテスト**（E12）：非公開のチームのデータを、同期・遅延の読み込み・ビューの問い合わせ・検索・通知・公開 API のどれかで得ようとする。

## 11. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E4 | `policy-module` | 4.1 節の `packages/policy`、`can()`・`groupsFor`、lint |
| E4 | `workspace-model-and-settings` | 3.3 節の `Workspace`・`WorkspaceSettings`、`resolve_workspace_slug`、作成の流れ |
| E4 | `workspace-roles` | 3.1 節のロール、DT-PERM-002 の管理の操作 |
| E4 | `team-model-and-membership` | 3.2 節の `Team`・`TeamMembership`、参加・脱退（7.1 節） |
| E4 | `private-teams` | 非公開のチームの作成、DT-PERM-001 の行 3・4、管理者の参加と監査 |
| E4 | `team-privacy-toggle` | 7.2 節と DT-PERM-004（bootstrap-and-partial-sync の 7.8 節の同期の側を含む） |
| E4 | `role-change-and-suspend` | 7.3・7.4 節 |
| E4 | `policy-decision-tables` | DT-PERM-001〜004 の表駆動テスト、PROP-PERM-001 |
| E4 | `permission-sim-props` | PROP-PERM-002〜004 |
| E4 | `subscription-audit` | 5.3 節の監査のジョブ |
| E1 | `schema-group-rules-ext` | `workspace_members`・`team_row`・`view_scope` の規則と、`guest_visible` の検査（data-model-and-schema と共同） |
| E12 | `privacy-pentest-scope` | 10 節のペンテストの範囲 |
| E13 以降 | `guests` | 6 節のゲストのロールの公開（フラグ）、招き方 |
| E13 以降 | `team-owner-role`・`sub-teams` | チームのオーナー、サブチーム |

## 12. 未解決の問い

- ロールにオーナーを MVP から置くか。
- ゲストを MVP に入れるか。入れないなら、同期グループの形を今決めるか。
- 公開のチームに参加していないメンバーが、そのチームのイシューを書けるか。
- 非公開のチームの招き入れを、チームのメンバーに許すか（本家はチームのオーナー）。
- 非公開のチームから抜けた人の担当と購読を外すか。
- ゲストに、公開のチームの一覧と、メンバーのメールアドレスを見せるか。
- 管理者が非公開のチームに自分で参加できるか。

### 決定

2026-09-28 の既定案。E4 の実装とセキュリティのレビューで覆りうる。

- **オーナー**：MVP から置く（ADR-0004）。
- **ゲスト**：MVP の後に出す。`members` のグループと規則は MVP から使う（ADR-0033）。
- **公開のチーム**：参加していなくても読み書きできる（本家と同じ）。
- **招き入れ**：非公開のチームのメンバー（ゲストを除く）と、参加している管理者が招ける。
- **脱退**：非公開のチームから抜けたら、担当と購読者から外す（7.1 節）。
- **ゲストに見せるもの**：公開のチームの一覧とメンバー、メールアドレスは見せる（6.3 節）。セキュリティのレビューで覆りうる。
- **管理者の参加**：できる。監査とチームへの知らせを残す（ADR-0033）。
- **メンバーの招待**：既定では管理者だけ（`members_can_invite` の既定は偽。本家の有料のプランと同じ）。管理者が設定で全員に広げられる（3.3 節。2026-09-28 に PM が決定）。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| 非公開への切り替えのトランザクションが、最大のワークスペースで 10 秒に収まるか | E4 で測る。収まらなければ担当・購読者の外しを全部 Worker に回す |
| ゲストのメールアドレスの見え方 | ゲストの Epic（E13 以降）の着手の前に、セキュリティのレビューで |
| チームのオーナー、サブチーム、イシューの個別の共有 | MVP の後 |
| 本家のゲストの見え方、脱退の扱い | 公式の資料では確かめられなかった（**未検証**のまま） |

## 13. quality.md・runbooks・data-model への項目

### quality.md

- DT-PERM-001〜004 の表駆動テストと PROP-PERM-001〜004 を E4 のリリースの基準にする。PROP-PERM-002 は NFR-008 の試験として、E12 まで毎回の CI で回す。
- 本番：`subscription_drift`（購読の監査のずれ）が 0。
- 本番：配信の監査（ADR-0004）の不一致が 0。
- 本番：停止から切断までの p99 5 秒。
- E12 の外部のペンテストに、非公開のチームの漏れの経路の全部（10 節）を入れる。

### runbooks

- `private-team-leak-response.md`（bootstrap-and-partial-sync の依頼と同じ runbook にまとめた）：非公開のデータが届いた疑いのときの手順（配信の監査の記録の確認、影響した接続と端末の特定、`sync_epoch` を上げずに該当の人の手元を消す方法（`kick: forbidden` と握手の `groups`）、法務への報告の判断（法務の L1））。
- `subscription-drift-repair.md`：購読の監査でずれが出たときの直し方。
- `team-privacy-toggle.md`：大きなチームの非公開への切り替えの前の確認（メンバーの数、担当の数、時間の見込み）と、途中で止まったときの続け方。

### data-model（索引への追加の提案）

| 表・モデル | 中身 | 節 |
| --- | --- | --- |
| `workspaces`（`Workspace`）・`workspace_settings`（`WorkspaceSettings`） | ワークスペースの行と設定（定義の正本） | 3.3 |
| `users`（`User`） | ワークスペースの中の人、ロール、状態 | 3.2 |
| `teams`（`Team`） | 公開・非公開 | 3.2 |
| `team_memberships`（`TeamMembership`） | チームのメンバー | 3.2 |
| `sync_subscriptions` | 購読（[bootstrap-and-partial-sync.md](bootstrap-and-partial-sync.md) の 7.1 節）。`members` のグループを足す | 5.1 |
| `packages/policy` | `can()`・`groupsFor` | 4.1 |
| 監査の記録 | `admin_joined_private_team`、ロールの変更、停止、非公開への切り替え（security の領域の監査ログへ） | 7 |
| data-model-and-schema への依頼（反映済み） | `workspace_members`・`team_row`・`view_scope` の規則、`teams` の結び付けのモデルからの読み方、`guest_visible` の注記の検査（[data-model-and-schema.md](data-model-and-schema.md) の 3.4・3.5・4.1 節） | 5.2、6.2 |

## 出典

いずれも 2026-09-28 に確認。

- Linear Docs, [Members and roles](https://linear.app/docs/members-roles)、[Teams](https://linear.app/docs/teams)、[Private teams](https://linear.app/docs/private-teams)

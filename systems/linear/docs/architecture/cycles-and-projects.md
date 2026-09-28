# Cycles and Projects: Linear

サイクル、プロジェクト、マイルストーン、イニシアチブ、進捗の集計、プロジェクトの更新（健康状態）を決める。サイクルの行の作り方、クールダウン、未完了のイシューの繰り越し、自動の追加、タイムゾーンを扱う。進捗は `derive`（[ADR-0025](../decisions/0025-derived-changes-in-writer.md)）で数を保つ。

前提となる決定は、同期のモデル（[ADR-0002](../decisions/0002-sync-model.md)）、読み込みの方針と同期グループ（[ADR-0003](../decisions/0003-bootstrap-and-partial-sync.md)）、非公開のチーム（[ADR-0004](../decisions/0004-tenancy-and-permissions.md)）、トランザクション（[ADR-0006](../decisions/0006-transactions-writer-and-idempotency.md)）、定義の言語（[ADR-0019](../decisions/0019-schema-definition-and-codegen.md)）、状態の種類と定期処理（[ADR-0023](../decisions/0023-workflow-states-and-lifecycle-automation.md)）、派生の変更（[ADR-0025](../decisions/0025-derived-changes-in-writer.md)）。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0026](../decisions/0026-cycle-rows-and-rollover.md) | サイクルはチームごとの行で、Worker がチームのタイムゾーンで先の分を作る。境界の時刻はサーバーだけが計算し、行に持つ。クールダウンは行を作らない隙間で表す。繰り越しは次のサイクルの始まりに Worker のシステムのトランザクションで行う。終わったサイクルへの遅れた割り当ては、派生で繰り越し先へ付け替える |
| [0027](../decisions/0027-progress-stats-per-team-via-derive.md) | 進捗は `(対象, チーム)` ごとの `ProgressStat` の行に、点数と件数の合計を `counter` で持つ。イシューの変更の `derive` が増減を出し、Writer が同じトランザクションで当てる。行はチームの同期グループに属し、非公開のチームの数は、そのチームのメンバーにだけ届く。イニシアチブの進捗は保存せず、見える行から画面で足す。日ごとの点は Worker が書き、1 日 1 回、SQL で数え直して食い違いを直す |

## 1. 目的と範囲

- 扱う：
  - `Cycle` とチームのサイクルの設定、境界の計算、先の分の作成、繰り越し、自動の追加
  - `Project`・`ProjectTeam`・`ProjectStatus`・`ProjectMilestone`・`ProjectUpdate`
  - `Initiative`・`InitiativeProject`（入れ子のイニシアチブを含む）
  - 進捗の集計（`ProgressStat`、`ProgressPoint`）、予測、プロジェクトの更新の催促
- 扱わない：
  - イシューの状態・見積もりの尺度・`unestimated_as_one`（[issues-and-workflow.md](issues-and-workflow.md)）
  - サイクル・プロジェクトで絞るビュー（[views-and-filters.md](views-and-filters.md)）
  - 催促とプロジェクトの更新の通知の配り方（[notifications-and-inbox.md](notifications-and-inbox.md)）
  - Slack のチャンネルへの更新の投稿（[integrations.md](integrations.md)）
  - ロードマップの表示、インサイト（MVP の後。[intent.md](../intent.md)）
  - プロジェクトの説明の本文（[editor-and-descriptions.md](editor-and-descriptions.md) と同じ方式を使う）

## 2. 本家の形（確かめたこと）

いずれも公式の文書。2026-09-28 に確認。

| 項目 | 内容 | 出典 |
| --- | --- | --- |
| サイクルの長さ | 1〜8 週。選んだ曜日から繰り返す | [Cycles](https://linear.app/docs/use-cycles) |
| 始まりの時刻 | チームの設定のタイムゾーンで、選んだ曜日の午前 0 時 1 分 | 同上 |
| クールダウン | 任意。クールダウンにはイシューを割り当てられない | 同上 |
| 先のサイクル | 作れる先のサイクルは最大 15 | 同上 |
| 繰り越し | 未完了のイシューは次のサイクルへ自動で移る。クールダウンの間に Backlog・Triage・Canceled・Completed へ移したものは移らない | 同上 |
| 自動の追加 | 設定で、サイクルのない Started のイシューを次のサイクルへ自動で足す | 同上 |
| 容量 | 直前の完了した 3 サイクルの速さから見積もる | 同上 |
| サイクルの成功 | 完了を 1、Started を 25% と数える。完了 5・Started 4・手つかず 1 なら 60% | [Cycle graph](https://linear.app/docs/cycle-graph) |
| 範囲 | 見積もりの点（見積もりのないものはチームの既定）か、件数 | 同上 |
| サイクルの図の保存 | 完了した時点の図を写しとして残す。後でイシューが変わっても図は変わらない | [Cycles](https://linear.app/docs/use-cycles) |
| プロジェクトの進捗 | 残りの点は、未完了のイシューの点の和に、進行中のものへ 1/4 の係数を掛けて求める。取り消し・外したものは範囲を減らす。見積もりが無効なチームは全部を 1 点と数える | [Project graph](https://linear.app/docs/project-graph) |
| 予測 | 週の速さ（最近の週を重く）から完了日を予測し、楽観・悲観に ±40%。少なくとも 1 週のデータが要る。1 時間ごとに更新 | 同上 |
| プロジェクト | リーダーは 1 人。複数のチームにまたがり、リードのチームが使える状態を決める。イシューは 1 つのプロジェクトにだけ属す | [Projects](https://linear.app/docs/projects) |
| プロジェクトの状態 | ワークスペースの状態を管理者が名前・色を変えられる。Business 以上はチームごとの状態。リードのチームを変えると、同じ種類の状態へ合わせる | [Project status](https://linear.app/docs/project-status) |
| マイルストーン | 説明と任意の目標日。並べ替えられる。リンクしたイシューの完了の割合を示す | [Project milestones](https://linear.app/docs/project-milestones) |
| 更新 | 健康状態は On track・At risk・Off track の 3 つと本文。催促は毎日・毎週・隔週で曜日と時刻を選び、1 営業日後と 2 営業日後にも催促する。催促の周期＋3 日を過ぎると「更新がない」。進捗が 2% を超えて変わったら自動の要約を付ける | [Initiative and Project updates](https://linear.app/docs/initiative-and-project-updates) |
| イニシアチブ | 状態は Proposed・Planned・Active・Completed・Canceled。オーナー、リードのチーム、目標日、サブイニシアチブ。識別子は `I` と連番 | [Initiatives](https://linear.app/docs/initiatives) |
| 非公開のチーム | 公開のチームのプロジェクトを非公開のチームと共有できる。そのつながりは非公開のチームのメンバーにだけ見える | [Private teams](https://linear.app/docs/private-teams) |

- プロジェクトの状態の種類の名前（Backlog・Planned・In Progress・Paused・Completed・Canceled）は、状態の文書に列挙がなく、**未検証**。本システムは 3.5 節の 6 種類にする。
- 1 つのプロジェクトが複数のイニシアチブに属せるか、サブイニシアチブの深さの上限は、文書に書かれていない（**未検証**）。
- 「クールダウンの間に Backlog へ移したものは移らない」は、クールダウンの前から Backlog だったイシューの扱いを書いていない（**未検証**）。本システムの決定は 4.4 節。
- 始まりの時刻の「0 時 1 分」は採らず、0 時 0 分にする（4.2 節）。

## 3. モデル

定義の言語は [data-model-and-schema.md](data-model-and-schema.md) の 3 節。主なフィールドだけを書く。

### 3.1 チームのサイクルの設定（`Team` に足すフィールド）

| フィールド | 型・`conflict` | 意味 |
| --- | --- | --- |
| `cycles_enabled` | `bool`・`lww` | 既定 `false` |
| `cycle_weeks` | `enum<1,2,3,4,5,6,7,8>`・`lww` | 長さ。既定 2 |
| `cycle_cooldown_weeks` | `enum<0,1,2,3,4>`・`lww` | クールダウン。既定 0 |
| `cycle_start_weekday` | `enum<1..7>`・`lww` | ISO の曜日（1 = 月曜）。既定 1 |
| `cycle_upcoming` | `int`・`lww`、`range: [1, 15]` | 先に作っておく数。既定 3 |
| `cycle_auto_add_started` | `bool`・`lww` | Started になったサイクルのないイシューを足す。既定 `true` |
| `timezone` | `string`・`lww`、`max: 64` | IANA の名前。既定はワークスペースのタイムゾーン（既定 `Asia/Tokyo`） |

- 設定を変える操作は `can(actor, "update_settings", team)`（[permissions-and-teams.md](permissions-and-teams.md)）。
- クールダウンの上限 4 週と既定値は本システムの決定（本家の値は**未検証**）。

### 3.2 `Cycle`

```ts
model("Cycle", {
  groups: { rule: "team", from: "team_id" },
  load: { strategy: "instant" },          // 完了して 90 日を過ぎたものは Worker がアーカイブ → 遅延
  archivable: true, delete: { mode: "hard" },
  fields: {
    team_id:       { type: "ref:Team", conflict: "server_only", on_delete: "cascade", index: true },
    number:        { type: "int", conflict: "server_only" },          // チームの中の連番
    name:          { type: "string", conflict: "lww", nullable: true, max: 80 },
    starts_at:     { type: "timestamp", conflict: "server_only", index: true },
    ends_at:       { type: "timestamp", conflict: "server_only" },
    status:        { type: "enum<upcoming,active,completed>", conflict: "server_only" },
    rolled_to_id:  { type: "ref:Cycle", conflict: "server_only", nullable: true, on_delete: "nullify" },
    snapshot:      { type: "json", conflict: "server_only", nullable: true, schema: "CycleSnapshot" },
  },
});
```

- `Cycle` の行は Worker だけが作る（4.1 節）。利用者が送れるのは `name` の `set` だけ。
- `status` は Worker が境界で書く。画面は `starts_at`・`ends_at` と手元の時刻で「今」を決めてよいが、繰り越しの判定には使わない。
- 1 チームのサイクルの行は、先の 15 と、過去の分。過去の分は完了から 90 日でアーカイブし、遅延のモデルにする（ADR-0003 の「アーカイブしたモデル」）。

### 3.3 `Project` と `ProjectTeam`

```ts
model("Project", {
  groups: { rule: "teams", from: "ProjectTeam.team_id" },   // 下の注を見る
  load: { strategy: "instant" }, archivable: true, delete: { mode: "trash", purge_after_days: 30 },
  fields: {
    name:            { type: "string", conflict: "lww", max: 255, search: true, pii: "content" },
    status_id:       { type: "ref:ProjectStatus", conflict: "lww", on_delete: "restrict" },
    lead_id:         { type: "ref:User", conflict: "lww", nullable: true, on_delete: "nullify" },
    member_ids:      { type: "set<ref:User>", conflict: "set", max: 500, on_delete: "remove" },
    start_date:      { type: "date", conflict: "lww", nullable: true },
    start_res:       { type: "enum<day,month,quarter,half,year>", conflict: "lww", default: "day" },
    target_date:     { type: "date", conflict: "lww", nullable: true },
    target_res:      { type: "enum<day,month,quarter,half,year>", conflict: "lww", default: "day" },
    health:          { type: "enum<none,on_track,at_risk,off_track>", conflict: "server_only", default: "none" },
    last_update_at:  { type: "timestamp", conflict: "server_only", nullable: true },
    started_at:      { type: "timestamp", conflict: "server_only", nullable: true },
    completed_at:    { type: "timestamp", conflict: "server_only", nullable: true },
    canceled_at:     { type: "timestamp", conflict: "server_only", nullable: true },
  },
});
model("ProjectTeam", {
  groups: { rule: "team", from: "team_id" }, load: { strategy: "instant" }, delete: { mode: "hard" },
  fields: {
    project_id: { type: "ref:Project", conflict: "server_only", on_delete: "cascade", index: true },
    team_id:    { type: "ref:Team", conflict: "server_only", on_delete: "cascade", index: true },
    is_lead:    { type: "bool", conflict: "lww" },
  },
});
```

- **チームのつながりを行に分ける理由**：チームの集合を `Project` の行の `set` フィールドに持つと、行は全部のチームのグループに届くので、公開のチームのメンバーにも非公開のチームの ID が届く。本家は、つながりを非公開のチームのメンバーにだけ見せる。そこで、つながりを `ProjectTeam` の行（そのチームのグループ）にし、リードのチームも `is_lead` でそこに持つ。
- `Project` の行のグループは、`ProjectTeam` の行のチームのグループの和。Writer は `ProjectTeam` の作成・削除の同じトランザクションで、`Project` と、`via` で依存する行（`ProjectMilestone`、`ProjectUpdate`、`InitiativeProject`）の `sync_groups` を変え、`groups_before` 付きの `update` を書く（[bootstrap-and-partial-sync.md](bootstrap-and-partial-sync.md) の 7.7 節と同じ手順）。
- `teams` の規則は、結び付けのモデル（`ProjectTeam.team_id`）から読む（[data-model-and-schema.md](data-model-and-schema.md) の 3.5 節。統合の工程で、行の中の集合から読む形をやめた）。
- `ProjectTeam` は 1 プロジェクトに少なくとも 1 行で、`is_lead` はちょうど 1 行（DT-PROJ-002）。
- `health`・`last_update_at` は `ProjectUpdate` の作成の派生で書く（6 節）。
- `started_at` などは、状態の種類の変化の派生で書く（イシューの DT-ISSUE-001 と同じ形）。

### 3.4 イシューに足すフィールド

| フィールド | 型・`conflict` | 規則 |
| --- | --- | --- |
| `cycle_id` | `ref:Cycle`・`lww`、nullable、`on_delete: nullify`、`m2` | 同じチームのサイクルだけ（4.5 節） |
| `project_id` | `ref:Project`・`lww`、nullable、`on_delete: nullify`、`m2` | イシューのチームがプロジェクトのチームのどれか（DT-PROJ-001） |
| `project_milestone_id` | `ref:ProjectMilestone`・`lww`、nullable、`on_delete: nullify`、`m2` | `project_id` のマイルストーンだけ。`project_id` を変えたら派生で外す |

- どれも `history` と `track_overwrites` に入れる（[data-model-and-schema.md](data-model-and-schema.md) の 3.1 節の例に既にある `cycle_id`・`project_id` と同じ）。

### 3.5 `ProjectStatus`

| フィールド | 型・`conflict` | 意味 |
| --- | --- | --- |
| `category` | `enum<backlog,planned,started,paused,completed,canceled>`・`server_only` | 作成の時に決め、変えない |
| `name`・`color`・`description` | `string`・`lww` | 管理者が変える |
| `position` | `order_key`・`order`、`order_scope: ["category"]` | 種類の中の並び |

- グループは `workspace`（ゲストも、見えるプロジェクトの状態を描くのに要る）。`instant`。
- 各種類に少なくとも 1 つ。最後の 1 つの削除は `workflow_violation`（ワークフローの状態の 4.1 節と同じ）。
- チームごとの状態（本家の Business 以上）は MVP の後。

### 3.6 `ProjectMilestone`

| フィールド | 型・`conflict` | 意味 |
| --- | --- | --- |
| `project_id` | `ref:Project`・`server_only`、`on_delete: cascade` | — |
| `name` | `string`・`lww`、`max: 80` | — |
| `description` | `string`・`lww`、`max: 2000` | 短い文。リッチテキストにしない |
| `target_date` | `date`・`lww`、nullable | — |
| `sort_key` | `order_key`・`order`、`order_scope: ["project_id"]` | 並び |

- グループは `via`（`project_id`）。`instant`。1 プロジェクト 100 個まで（本システムの値）。
- 削除すると、イシューの `project_milestone_id` は `nullify` で外れ、プロジェクトには残る（本家と同じ）。
- 「今のマイルストーン」は、未完了のイシューを持つ最初のマイルストーン（並びの順）。画面で決める。

### 3.7 `Initiative` と `InitiativeProject`

```ts
model("Initiative", {
  groups: { rule: "workspace_members" },   // ゲストに届けない（permissions-and-teams の 6 節）
  load: { strategy: "instant" }, archivable: true, delete: { mode: "trash", purge_after_days: 30 },
  fields: {
    number:     { type: "int", conflict: "server_only" },                 // I-123 の番号
    name:       { type: "string", conflict: "lww", max: 255, search: true, pii: "content" },
    status:     { type: "enum<proposed,planned,active,completed,canceled>", conflict: "lww" },
    owner_id:   { type: "ref:User", conflict: "lww", nullable: true, on_delete: "nullify" },
    parent_id:  { type: "ref:Initiative", conflict: "lww", nullable: true, on_delete: "nullify" },
    target_date:{ type: "date", conflict: "lww", nullable: true },
    health:     { type: "enum<none,on_track,at_risk,off_track>", conflict: "server_only", default: "none" },
  },
});
model("InitiativeProject", {
  groups: { rule: "via", from: "project_id" }, load: { strategy: "instant" }, delete: { mode: "hard" },
  fields: {
    initiative_id: { type: "ref:Initiative", conflict: "server_only", on_delete: "cascade", index: true },
    project_id:    { type: "ref:Project", conflict: "server_only", on_delete: "cascade", index: true },
  },
});
```

- 1 つのプロジェクトは複数のイニシアチブに属せる（本家は**未検証**。本システムの決定）。
- `InitiativeProject` はプロジェクトのグループに属す。非公開のチームだけのプロジェクトのつながりは、そのチームのメンバーにだけ届く。イニシアチブの画面は、手元にあるつながりだけを描く。
- 入れ子は `parent_id` の LWW と循環の拒否（`cycle`）。深さは 5 まで（本システムの値。イシューの親子の ADR-0024 と同じ検証）。
- イニシアチブのリードのチーム（本家）は MVP では持たない。
- イニシアチブの番号はワークスペースの連番で、Writer が振る（イシューの番号と同じ。[ADR-0020](../decisions/0020-ids-and-human-identifiers.md)）。
- イニシアチブの更新（本家）は `ProjectUpdate` と同じ形の `InitiativeUpdate` で持つ。MVP ではプロジェクトの更新だけを作り、イニシアチブの更新は MVP の後。

## 4. サイクル

ADR-0026。

### 4.1 行の作成（Worker）

- Worker のジョブ `cycle-scheduler` は、1 時間ごとに、サイクルが有効な各チームを見る。
- 先のサイクル（`status = upcoming`）が `cycle_upcoming` より少なければ、足りない分を作る。1 つのチームで 1 回に 15 まで。
- 作る行の番号は、チームの最後のサイクルの番号＋1。境界は 4.2 節で計算する。
- ジョブは `actor = system`、`origin = worker` の Writer のトランザクションで書く。1 ワークスペースの `worker` の枠（1 秒 50 変更。[ADR-0054](../decisions/0054-per-workspace-write-admission.md)）に従う（[issues-and-workflow.md](issues-and-workflow.md) の 13 節と同じ）。
- 同じチームで 2 つのジョブが走っても重ならないよう、Writer は `(workspace_id, team_id, number)` の一意の索引で 2 つ目を拒否する。ジョブは拒否を「済み」として扱う。

### 4.2 境界の計算

```
start(n) = 最初のサイクルの始まりの日 + (n − 1) × (cycle_weeks + cycle_cooldown_weeks) 週
starts_at = start(n) の日の 00:00（team.timezone）を UTC の時刻にしたもの
ends_at   = (start(n) + cycle_weeks 週) の日の 00:00（team.timezone）
```

- 計算はサーバーの共有のパッケージの 1 つの関数 `cycleBounds(team, n)` だけで行う。IANA のタイムゾーンの表は Node.js の `Intl` を使う。クライアントは計算しない（行の値を使う）。
- 夏時間のあるタイムゾーンでも、日付の 00:00 を基準にするので、サイクルの長さは「日の数」で揃い、時間の数は揃わない。その日の 00:00 が存在しない場合（夏時間の始まり）は、その日の最初の時刻にする。
- 本家は 0 時 1 分に始める。本システムは 0 時 0 分にする。ends_at と次の starts_at が同じ時刻になり、隙間ができないため。
- クールダウンは行を作らない。`ends_at` と次の `starts_at` の間がクールダウンである。本家の「クールダウンに割り当てられない」は、割り当てる先の行がないことで成り立つ。

### 4.3 設定の変更

DT-CYCLE-003。上から評価し、最初に当たった行。

| # | 変更 | 起きること |
| --- | --- | --- |
| 1 | `cycles_enabled` を偽にする | 先のサイクルの行を消す（`on_delete: nullify` でイシューから外れる）。今のサイクルは終わりまで残し、繰り越さない。Worker が 500 件ずつ行う |
| 2 | `cycle_weeks`・`cycle_cooldown_weeks`・`cycle_start_weekday`・`timezone` を変える | 今のサイクルは変えない。先のサイクルの行は、同じ ID と番号のまま、境界だけを計算し直す（割り当てたイシューはそのまま付いてくる） |
| 3 | `cycle_upcoming` を減らす | イシューの付いていない先のサイクルだけを、遠い方から消す。付いているものは残す |
| 4 | `cycles_enabled` を真にする | 最初のサイクルは、次の `cycle_start_weekday` の日から。4.1 節の作成を即座に 1 回走らせる |

- 行 2 で、新しい境界が今の時刻より前に始まる先のサイクルはない（今のサイクルの `ends_at` の後から並べる）。

### 4.4 繰り越し

DT-CYCLE-001。サイクル `C` の次のサイクル `N` の `starts_at` に、`C` に残るイシューごとに決める。上から評価し、最初に当たった行。

| # | イシューの種類（そのとき） | 起きること |
| --- | --- | --- |
| 1 | アーカイブ済み・ゴミ箱 | 何もしない |
| 2 | `completed`・`canceled`・`duplicate` | 何もしない（`C` の実績として残る） |
| 3 | `triage`・`backlog` | 何もしない（`C` に残す。未完了として数える） |
| 4 | `unstarted`・`started` | `set cycle_id = N`。履歴に `{k: "auto", rule: "cycle_rollover", from: C}` |

- 繰り越しを `C` の `ends_at` ではなく `N` の `starts_at` に行うのは、本家の「クールダウンの間に Backlog などへ移したものは移らない」に合わせるため。クールダウンが 0 なら同じ時刻である。
- 行 3 は本家の文書では確かめられない（**未検証**）。Backlog は「まだ計画していない」ものなので、次のサイクルへ自動で持ち込まない。
- ジョブ `cycle-rollover` は、1 時間ごとに `starts_at ≤ now` で繰り越していない `N`（`C.rolled_to_id IS NULL`）を探す。500 件ずつのシステムのトランザクションで当て、最後のトランザクションで `C.status = completed`・`C.rolled_to_id = N`・`N.status = active` を書く。途中で落ちても、次の回で残りから続ける（冪等）。
- 目標：境界から 5 分以内に始め、1 チーム 5,000 件を 10 分以内に終える。
- 次のサイクルがない（サイクルを無効にした、先の行がない）ときは、`rolled_to_id` を空のまま `C` を完了にし、イシューは `C` に残す。

### 4.5 割り当ての検証と、遅れた割り当て

DT-CYCLE-002。`set cycle_id = X`（`X` が `null` でない）を当てるとき。上から評価し、最初に当たった行。

| # | 条件 | 結果 |
| --- | --- | --- |
| 1 | `X` が別のチームのサイクル、見てよくない | 拒否 `invalid_reference` |
| 2 | チームの `cycles_enabled` が偽 | 拒否 `workflow_violation` |
| 3 | `X.status` が `upcoming`・`active` | 受け付け |
| 4 | `X` が完了し、`X.rolled_to_id = N` があり、イシューが `unstarted`・`started` | 受け付けて、派生で `set cycle_id = N` に付け替える。履歴に `{k: "auto", rule: "cycle_late_rollover", from: X}` |
| 5 | `X` が完了し、イシューが上の行以外 | 受け付け（完了したサイクルへの記録として残す） |

- 行 4 は、オフラインでサイクルに入れた変更が、繰り越しの後に確定する場面のための規則である。繰り越しのジョブが先に当たっても、後に当たっても、結果は同じ（イシューは `N` に入る）。PROP-CYCLE-002 で確かめる。
- 完了したサイクルの図は写し（4.7 節）なので、行 5 の記録は図を変えない。

### 4.6 自動の追加

- `set state_id` の派生（ADR-0025）：後の種類が `started` で、`cycle_id` が空で、チームの `cycle_auto_add_started` が真なら、`set cycle_id = 今の active のサイクル`。今がクールダウンなら次の `upcoming` のサイクル。どちらもなければ何もしない。
- 「今」は Writer の確定の時刻で決める。クライアントの予測は手元の時刻で行い、差分で正される。
- チームを移ったイシューのサイクルは、移った先に同じ番号のサイクルがあってもつなぎ替えず外す（本家の「対応がなければ外れる」の「対応」の意味は**未検証**。本システムは常に外す）。

### 4.7 完了の写し

- `cycle-rollover` の最後のトランザクションの直前に、`C` の `ProgressStat` の行（チームは 1 つ）と、`C` の日ごとの点（7.4 節）から、`CycleSnapshot` を作り `C.snapshot` に書く。

```json
{ "at": "2026-09-28T00:00:00Z", "unit": "points",
  "scope": 40, "completed": 28, "started": 6, "success_pct": 73.75,
  "points": [{ "d": "2026-09-14", "scope": 36, "completed": 0, "started": 4 }, …],
  "carried_over": 7 }
```

- 図は写しから描く（本家と同じ。後でイシューが変わっても図は変わらない）。
- `success_pct = (completed + started / 4) / scope × 100`（本家の例：完了 5・Started 4・手つかず 1 で 60%）。

### 4.8 容量の見積もり

- 画面は、直前の完了した 3 サイクルの `snapshot.completed` の平均を容量として示す（本家と同じ）。サーバーでは計算しない。

## 5. プロジェクトの規則

### 5.1 イシューとプロジェクト

DT-PROJ-001。`set project_id = P` を当てるとき。上から評価し、最初に当たった行。

| # | 条件 | 結果 |
| --- | --- | --- |
| 1 | `P` を見てよくない、ない、削除済み | 拒否 `invalid_reference` |
| 2 | イシューのチームの `ProjectTeam` が `P` にない | 拒否 `invalid_reference`。画面は「チームをプロジェクトに足しますか」を出す |
| 3 | それ以外 | 受け付け。`project_milestone_id` が `P` のものでなければ派生で外す |

- 行 2 で自動にチームを足さないのは、`ProjectTeam` の作成がプロジェクトの同期グループを変え（依存の行の移動を伴う）、イシューの操作の副作用として重すぎるため。
- イシューをチームへ移すと、移った先のチームが `P` の `ProjectTeam` になければ、派生で `project_id` を外す（本家の「プロジェクトは外れる」を、プロジェクトに移った先のチームがあれば外さないよう狭める）。

### 5.2 チームのつながり

DT-PROJ-002。

| # | 操作 | 条件 | 結果 |
| --- | --- | --- | --- |
| 1 | `create ProjectTeam` | 同じ組がある | `already_exists` |
| 2 | `create ProjectTeam` | `actor` がそのチームを見てよくない | `forbidden` |
| 3 | `delete ProjectTeam` | 最後の 1 行 | `workflow_violation` |
| 4 | `delete ProjectTeam` | `is_lead` の行 | `workflow_violation`（先に別の行をリードにする） |
| 5 | `delete ProjectTeam` | そのチームのイシューが `P` に残る | 受け付け。Worker が 500 件ずつ `project_id` を外す |
| 6 | `set is_lead = true` | — | 受け付け。派生で他の行の `is_lead` を偽にする |

- リードのチームを変えても、`ProjectStatus` はワークスペースのものなので変えない（チームごとの状態は MVP の後）。

### 5.3 状態の時刻

- `status_id` の変更の派生で、種類が `started` になったら `started_at` を（空なら）今に、`completed` なら `completed_at` を今に、`canceled` なら `canceled_at` を今にする。開いた種類へ戻したら `completed_at`・`canceled_at` を空にする。
- プロジェクトの完了で、未完了のイシューは動かさない（本家の振る舞いは**未検証**）。

## 6. プロジェクトの更新と健康状態

### 6.1 モデル

```ts
model("ProjectUpdate", {
  groups: { rule: "via", from: "project_id" }, load: { strategy: "lazy" }, delete: { mode: "hard" },
  fields: {
    project_id: { type: "ref:Project", conflict: "server_only", on_delete: "cascade", index: true },
    author_id:  { type: "ref:User", conflict: "server_only", nullable: true, on_delete: "nullify" },
    health:     { type: "enum<on_track,at_risk,off_track>", conflict: "lww" },
    body:       { type: "json", conflict: "lww", schema: "RichTextDoc", max_bytes: 65536, pii: "content" },
    progress:   { type: "json", conflict: "server_only", nullable: true, schema: "UpdateProgressDiff" },
    edited_at:  { type: "timestamp", conflict: "server_only", nullable: true },
  },
});
```

- 本文はコメントと同じく ProseMirror の JSON を LWW で持ち、直せるのは書いた人だけ（[ADR-0022](../decisions/0022-comments-anchors-mentions-attachments.md) と同じ理由）。
- 1 プロジェクトの最新の 3 件は、プロジェクトの `include` で一緒に読む。古いものは `ProjectUpdate:project_id=…` の被覆で読む。
- 派生（作成の時）：`Project.health = health`、`Project.last_update_at = 今`。`progress` に、前の更新からの進捗の変化（点、割合、目標日の変化、マイルストーンの完了）を書く。変化が 2% 以下なら `null`（本家と同じ閾値）。
- 最新の更新を消したら、派生で `Project.health` を 1 つ前の更新の値に戻す（なければ `none`）。
- 更新へのコメント・リアクションは MVP の後（コメントのモデルはイシューに結び付いているため。editor-and-descriptions の領域と決める）。

### 6.2 催促

- ワークスペースの設定 `update_reminder`：`{cadence: off|weekly|biweekly, weekday: 1..7, hour: 0..23}`。時刻はワークスペースのタイムゾーン。既定は `weekly`・金曜・10 時（本システムの値）。
- Worker のジョブ `project-update-reminder` は 1 時間ごとに走り、`cadence` の日と時刻に当たったワークスペースで、状態の種類が `started` のプロジェクトのうち、前の催促の時刻より後に更新がないものについて、リーダー（なければ作った人）へ通知の事象 `project_update_due` を出す（[notifications-and-inbox.md](notifications-and-inbox.md)）。
- 1 営業日後と 2 営業日後に、まだ更新がなければもう一度出す（本家と同じ）。営業日は月〜金。祝日は数えない（本システムの決定）。
- 「更新がない」の表示：`now > last_update_at + 周期 + 3 日` なら画面で「更新がない」と示す（本家と同じ）。保存しない。画面が手元の値から計算する。

## 7. 進捗の集計

ADR-0027。

### 7.1 数え方

1 件のイシューの点 `w(i)`：

| # | 条件（イシューのチームの設定） | `w(i)` |
| --- | --- | --- |
| 1 | `estimate_scale = none` | 1 |
| 2 | `estimate` あり | `estimate` |
| 3 | `estimate` なし、`unestimated_as_one` が真 | 1 |
| 4 | `estimate` なし、`unestimated_as_one` が偽 | 0 |

1 件のイシューが集計のどの欄に入るか（DT-PROG-001）：

| イシューの種類 | `scope` | `started` | `completed` |
| --- | --- | --- | --- |
| `triage`・`backlog`・`unstarted` | `+w` | — | — |
| `started` | `+w` | `+w` | — |
| `completed` | `+w` | — | `+w` |
| `canceled`・`duplicate` | — | — | — |
| ゴミ箱（`trashed_at` あり） | — | — | — |

- アーカイブしたイシュー（完了から自動のアーカイブ）は、種類のとおり数える。
- 取り消し・重複を範囲から外すのは本家と同じ。
- 割合 `progress = (completed + started / 4) / scope`。`scope = 0` なら「なし」。
- 親の見積もりに子を足さない。親子のどちらも、それぞれ 1 件として数える（[issues-and-workflow.md](issues-and-workflow.md) の 6.2 節）。
- 件数の欄（`scope_n`・`started_n`・`completed_n`）も同じ規則で `w = 1` として持つ。画面は点か件数かを選べる。

### 7.2 `ProgressStat`

```ts
model("ProgressStat", {
  groups: { rule: "team", from: "team_id" },
  load: { strategy: "instant" },            // 対象がアーカイブされたら、同じくアーカイブ → 遅延
  archivable: true, delete: { mode: "hard" },
  fields: {
    target_kind: { type: "enum<cycle,project,milestone>", conflict: "server_only" },
    target_id:   { type: "uuid", conflict: "server_only", index: true },
    team_id:     { type: "ref:Team", conflict: "server_only", on_delete: "cascade" },
    scope:       { type: "int", conflict: "counter", derive_only: true },
    started:     { type: "int", conflict: "counter", derive_only: true },
    completed:   { type: "int", conflict: "counter", derive_only: true },
    scope_n:     { type: "int", conflict: "counter", derive_only: true },
    started_n:   { type: "int", conflict: "counter", derive_only: true },
    completed_n: { type: "int", conflict: "counter", derive_only: true },
  },
});
```

- 行は `(target, team)` ごとに 1 つ。サイクルは 1 行、プロジェクトとマイルストーンは `ProjectTeam` の行の数だけ。
- 行は、対象（サイクル、`ProjectTeam`、マイルストーン×チーム）を作る同じトランザクションで Writer が作る。派生は既にある行に `incr` を当てるだけにする。クライアントの予測は、自分が作っていない行の ID を知る必要がない。
- `derive_only` は、利用者の送った `incr` を `forbidden` で拒否し、派生からの `incr` だけを受ける印（data-model への項目。15 節）。
- **グループをチームにする理由**：プロジェクトの進捗を 1 行にすると、非公開のチームのイシューの点数が、公開のチームのメンバーに届く（非公開のチームの仕事の量が漏れる）。チームごとの行なら、各人は見てよいチームの行だけを受け、画面はそれを足す。公開のチームのメンバーが見るプロジェクトの進捗は、非公開のチームの分を含まない。本家の「非公開のチームとのつながりはメンバーにだけ見える」と同じ見え方になる。

### 7.3 派生

- 登録：`Issue` の `derive` に `progressDelta` を足す。入力はイシューの前の行と後の行（ADR-0025 の `state_before`）。
- 前の行が属していた欄（サイクル・プロジェクト・マイルストーン × 7.1 節の欄）から `−w_before`、後の行の欄へ `+w_after` を、対象の `ProgressStat` の行に `incr` で出す。変化のない欄は出さない。
- 引き金：`state_id`（種類が変わるとき）、`estimate`、`cycle_id`、`project_id`、`project_milestone_id`、`team_id`、`trashed_at`、作成、削除。
- チームの `estimate_scale`・`unestimated_as_one` の変更は、そのチームの全イシューの `w` を変える。派生で行わず、Worker が 7.5 節の数え直しを、そのチームについて即座に走らせる。
- `counter` の `incr` は交換できるので、同時の変更でも、確定の順にかかわらず合計が合う（ADR-0002 の数の加算）。クライアントの予測は手元の前の行から出すので、手元の前の行が確定の前の行と違えば予測はずれるが、差分で正される。
- 1 件のイシューの 1 回の変更で出す `incr` は、最大 3 対象 × 2（前・後）× 6 欄 = 36 操作。派生の 500 操作の上限（ADR-0025）に余裕がある。一括の変更（500 件）では、同じ行への `incr` を 1 つに畳んでから当てる。

### 7.4 日ごとの点（図）

- Worker のジョブ `progress-points` は、1 日 1 回（ワークスペースのタイムゾーンの 00:10）、`active` のサイクル・`started` の種類のプロジェクト・そのマイルストーンの `ProgressStat` を読み、`ProgressPoint` を書く。

| フィールド | 中身 |
| --- | --- |
| `stat_id`・`team_id`・`d`（日付） | どの行の、どの日の点か |
| `scope`・`started`・`completed`（と件数） | その時刻の値 |

- グループは `team`（`ProgressStat` と同じ）。`lazy`。図を開いたときに `ProgressPoint:stat_id=…` の被覆で読む。
- 本家は 1 時間ごとに更新する。本システムは日ごとの点と、今の `ProgressStat` の値（最新の点）で描く。粒度は本家の図と同じく日（週）で足りる。
- 予測（プロジェクト）：画面が、`ProgressPoint` から週ごとの完了の点を求め、直近の週ほど重い加重平均（重み 4・3・2・1、直近 4 週）で速さを出し、残り（`scope − completed − started / 4`）を割って完了の週を出す。楽観・悲観は速さの ±40%（本家と同じ）。1 週の点がなければ出さない。

### 7.5 数え直し

- Worker のジョブ `progress-reconcile` は、1 日 1 回、ワークスペースごとに、`active`・`upcoming` のサイクルと、完了していないプロジェクト・マイルストーンについて、SQL で 7.1 節の数を数え、`ProgressStat` と比べる。
- 違えば、差を `incr` のシステムのトランザクションで当てる（`set` にしない。途中の派生の `incr` と交換できるように）。読んでから当てるまでに派生が当たっても、次の回で直る。
- 違いの件数を `progress_reconcile_drift` として数える。0 でない日が続けば、派生の誤りとして調べる。
- 数え直しの SQL は、派生と同じ `w` と欄の規則を、共有のパッケージから生成した SQL の式で書く（[views-and-filters.md](views-and-filters.md) の生成の仕組みを使う）。

### 7.6 イニシアチブの進捗

- 保存しない。画面は、イニシアチブと子のイニシアチブに属す、手元のプロジェクトの `ProgressStat` の行を足す。
- 各人の画面の値は、見てよいチームの分だけの和になる。人によって値が違うのは仕様である（7.2 節の理由）。
- 公開 API も、呼んだ人の同期グループで絞った行から同じ関数で計算する。

## 8. 障害のときの振る舞い

| 事象 | 起きること | 備え |
| --- | --- | --- |
| `cycle-scheduler` が止まった | 先のサイクルが作られない。今のサイクルが終わると、次がない | 先を 3 つ持つので、2 サイクル分の猶予がある。先のサイクルが 1 つ以下のチームの数を監視する |
| `cycle-rollover` が遅れた・途中で落ちた | 次のサイクルが始まったのに、前のサイクルにイシューが残る | 1 時間ごとに残りから続ける。境界から 30 分で終わらなければ警告。画面は `rolled_to_id` がない完了済みのサイクルを「繰り越し中」と示す |
| オフラインの割り当てが繰り越しの後に確定 | 完了したサイクルに入る | DT-CYCLE-002 の行 4 で繰り越し先へ付け替える |
| タイムゾーンの表の更新（政令の変更） | 先のサイクルの境界がずれる | Node.js の更新の後、`cycle-scheduler` が先のサイクルの境界を計算し直す（DT-CYCLE-003 の行 2 と同じ） |
| 派生の誤りで `ProgressStat` がずれた | 進捗の表示が違う | 1 日 1 回の数え直し。runbook で即座の数え直し |
| 大きなプロジェクトのチームを外す | Worker が長く動く | 500 件ずつ。その間、外れたチームのイシューはプロジェクトに残って見える |
| 催促が二重に出る | 同じ通知が 2 通 | 通知の事象の冪等の鍵 `(project_id, 催促の予定の時刻, 回)`（notifications-and-inbox の 5.2 節） |

## 9. セキュリティ

- **非公開のチームの量の漏れ**：進捗をチームごとの行にする（7.2 節）。1 行に合わせると、公開のチームのメンバーに、非公開のチームのイシューの数と点が届く。
- **つながりの漏れ**：プロジェクトとチームのつながりを `ProjectTeam` の行（そのチームのグループ）に持つ（3.3 節）。プロジェクトの行に、チームの ID の集合を持たない。
- **イニシアチブ**：イニシアチブとプロジェクトのつながりは、プロジェクトのグループに入る。イニシアチブの画面に、見てよくないプロジェクトは数も出さない（「ほかに N 件の非公開のプロジェクト」も出さない。存在を明かさない。[ADR-0004](../decisions/0004-tenancy-and-permissions.md)）。
- **更新の本文**：`pii: content`。ログに書かない。Slack への投稿は integrations の領域で、チャンネルが見てよい範囲（公開のチームのプロジェクトだけ）に限る。
- **催促の通知**：受け手がプロジェクトを見てよいことを、出す時と配る時に確かめる（[notifications-and-inbox.md](notifications-and-inbox.md) の 7 節）。
- **写し**：`Cycle.snapshot` はサイクルのチームのグループにだけ届く。サイクルは 1 チームなので、非公開のチームの数が他に漏れない。

## 10. テスト

- 表駆動テスト（決定表を spec から読み込む）：DT-CYCLE-001（繰り越し）、DT-CYCLE-002（割り当て）、DT-CYCLE-003（設定の変更）、DT-PROJ-001・002、DT-PROG-001（欄）。クライアントの予測と Writer の両方で全行を確かめる。
- 例示テスト：`cycleBounds` を、`Asia/Tokyo`・`America/New_York`（夏時間の始まりと終わりをまたぐ）・`Australia/Lord_Howe`（30 分の夏時間）で、1〜8 週とクールダウン 0〜4 週の組み合わせについて確かめる。
- 性質ベーステスト（[ADR-0010](../decisions/0010-deterministic-sync-simulator.md) のシミュレーター）：
  - **PROP-CYCLE-001（隙間と重なり）**：任意の設定の変更の列の後、1 つのチームのサイクルの `[starts_at, ends_at)` は重ならず、番号の順に並び、隙間はクールダウンの長さに等しい。
  - **PROP-CYCLE-002（繰り越しの順序の独立）**：任意のオフラインの割り当てと、繰り越しのジョブの任意の順序の後、未完了のイシューは完了したサイクルに残らない（DT-CYCLE-001 の行 3 を除く）。
  - **PROP-CYCLE-003（冪等）**：繰り越しのジョブを任意の位置で落として走らせ直しても、同じイシューを 2 度動かさず、履歴の `cycle_rollover` は 1 件のイシューにつき 1 行。
  - **PROP-PROG-001（一致）**：任意のイシューの変更の列の後、変更が止まった状態で、各 `ProgressStat` の値が、SQL の数え直しの値と等しい（数え直しのジョブを走らせずに）。
  - **PROP-PROG-002（見える分の和）**：任意のメンバーシップと非公開への切り替えの列の後、各クライアントの手元の `ProgressStat` は、見てよいチームの行だけで、画面の合計はその和に等しい。
  - **PROP-PROG-003（予測と確定の収束）**：クライアントの `progressDelta` の予測と Writer の結果は、確定の順で当てたとき一致する。
- 結合テスト：時計を進めて、`cycle-scheduler`・`cycle-rollover`・`progress-points`・`progress-reconcile`・`project-update-reminder` を回す。
- 差分テスト：数え直しの SQL（生成）と、共有のパッケージの `progressDelta` の和が、任意のデータで一致する。

## 11. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E7 | `cycle-settings` | 3.1 節の設定と、`can()` の設定の権限 |
| E7 | `cycle-bounds` | 4.2 節の `cycleBounds` とタイムゾーンの例示テスト |
| E7 | `cycle-scheduler` | 4.1・4.3 節の作成と設定の変更（DT-CYCLE-003） |
| E7 | `cycle-rollover` | 4.4 節の繰り越し（DT-CYCLE-001）、PROP-CYCLE-002・003 |
| E7 | `cycle-assignment-rules` | 4.5・4.6 節（DT-CYCLE-002、自動の追加の派生） |
| E7 | `cycle-snapshot-and-graph` | 4.7・4.8 節の写しと、容量の表示（client-app と共同） |
| E7 | `project-model` | 3.3・3.5・5.3 節のプロジェクト、状態、時刻の派生 |
| E7 | `project-teams` | 3.3・5.2 節の `ProjectTeam`、グループの移動（DT-PROJ-002） |
| E7 | `issue-project-milestone` | 3.4・3.6・5.1 節（DT-PROJ-001） |
| E7 | `progress-stats-derive` | 7.1〜7.3 節、PROP-PROG-001・003 |
| E7 | `progress-points-and-prediction` | 7.4 節 |
| E7 | `progress-reconcile` | 7.5 節と差分テスト |
| E7 | `project-updates` | 6.1 節の更新と健康状態の派生 |
| E7 | `project-update-reminders` | 6.2 節（notifications-and-inbox と共同） |
| E7 | `initiatives` | 3.7・7.6 節のイニシアチブ、入れ子、つながり |
| E7 | `cycles-projects-privacy-props` | PROP-PROG-002 と、つながりの漏れの試験（permissions-and-teams と共同） |
| E1 | `schema-teams-via-join` | `teams` 規則を結び付けのモデルから読む形と、`derive_only`（data-model-and-schema と共同） |
| E12 | `rollover-load-test` | 最大のワークスペース（チーム 200）で、同じ時刻に全チームの繰り越しが重なる負荷の試験 |

## 12. 未解決の問い

- Backlog のイシューを繰り越すか。
- 境界の時刻を 0 時 0 分にするか、本家と同じ 0 時 1 分にするか。
- プロジェクトの進捗を 1 行で持つか、チームごとの行で持つか。
- イシューのチームがプロジェクトにないとき、チームを自動で足すか。
- 1 つのプロジェクトを複数のイニシアチブに入れられるか。
- 図の粒度を 1 時間にするか、日にするか。
- プロジェクトの更新へのコメントを MVP に入れるか。

### 決定

2026-09-28 の既定案。E7 の実装と試用の声で覆りうる。

- **Backlog の繰り越し**：しない。Triage と Backlog は元のサイクルに残す（DT-CYCLE-001。ADR-0026）。
- **境界**：チームのタイムゾーンの 0 時 0 分。終わりと次の始まりを同じ時刻にする（ADR-0026）。
- **遅れた割り当て**：繰り越し先へ付け替える（DT-CYCLE-002 の行 4。ADR-0026）。
- **進捗の行**：`(対象, チーム)` ごと。非公開のチームの量を漏らさない（ADR-0027）。
- **チームの自動の追加**：しない。画面で聞く（DT-PROJ-001 の行 2）。
- **複数のイニシアチブ**：入れられる（`InitiativeProject`）。
- **図の粒度**：日。今の値は `ProgressStat` から（ADR-0027）。
- **更新へのコメント**：MVP の後。
- **催促の既定**：毎週金曜の 10 時（ワークスペースのタイムゾーン）。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| 派生の `incr` が 1 ワークスペースの書き込みの上限をどれだけ食うか | E5 の派生の計測に、E7 で進捗の派生を足して測る |
| 同じ時刻に多くのチームの繰り越しが重なるときの Writer の負荷 | E12 の `rollover-load-test` |
| チームごとのプロジェクトの状態、イニシアチブの更新、リードのチーム | MVP の後 |
| 本家のプロジェクトの状態の種類、Backlog の繰り越し、複数のイニシアチブ | 公式の資料では確かめられなかった（**未検証**のまま） |

## 13. quality.md・runbooks・data-model への項目

### quality.md

- DT-CYCLE-001〜003、DT-PROJ-001・002、DT-PROG-001 の表駆動テストと、PROP-CYCLE-001〜003、PROP-PROG-001〜003 を E7 のリリースの基準にする。
- `cycleBounds` のタイムゾーンの例示テストを、Node.js の更新（IANA の表の更新）の PR の必須にする。
- 本番：`progress_reconcile_drift`（数え直しで直した件数）が 0 であること。0 でない日が 2 日続けば調べる。
- 本番：境界から繰り越しの完了までの時間の p95（目標 10 分以内）と、`rolled_to_id` のない完了済みのサイクルの数。
- 本番：先のサイクルが 1 つ以下のチームの数が 0 であること。

### runbooks

- `cycle-rollover-stuck.md`：繰り越しが終わらないときの確かめ方（残りのイシューの数、ジョブのログ）、手で 1 チームを走らせる方法、止め方。
- `cycle-settings-mistake.md`：設定の誤り（長さ、タイムゾーン）で先のサイクルがずれたときの戻し方。
- `progress-recount.md`：1 つの対象・チーム・ワークスペースの進捗を即座に数え直す方法。

### data-model（索引への追加の提案）

| 表・モデル | 中身 | 節 |
| --- | --- | --- |
| `teams` のサイクルの設定 | 長さ、クールダウン、曜日、先の数、自動の追加、タイムゾーン | 3.1 |
| `cycles`（`Cycle`） | 境界、状態、繰り越し先、写し | 3.2 |
| `projects`（`Project`） | 状態、リーダー、メンバー、日付と粒度、健康状態 | 3.3 |
| `project_teams`（`ProjectTeam`） | プロジェクトとチームのつながり、リードのチーム | 3.3 |
| `issues` に足す列 | `cycle_id`、`project_id`、`project_milestone_id` | 3.4 |
| `project_statuses`（`ProjectStatus`） | ワークスペースのプロジェクトの状態 | 3.5 |
| `project_milestones`（`ProjectMilestone`） | マイルストーン | 3.6 |
| `initiatives`・`initiative_projects` | イニシアチブ、入れ子、プロジェクトとのつながり | 3.7 |
| `project_updates`（`ProjectUpdate`） | 健康状態、本文、進捗の変化 | 6.1 |
| `progress_stats`（`ProgressStat`） | `(対象, チーム)` ごとの点と件数 | 7.2 |
| `progress_points`（`ProgressPoint`） | 日ごとの点 | 7.4 |
| data-model-and-schema への依頼（反映済み） | `teams` 規則を結び付けのモデル（`ProjectTeam.team_id`）から読む形。`counter` の `derive_only` の印。`workspace_members` の規則（[data-model-and-schema.md](data-model-and-schema.md) の 3.2・3.5 節） | 3.3、7.2 |

## 出典

いずれも 2026-09-28 に確認。

- Linear Docs, [Cycles](https://linear.app/docs/use-cycles)、[Cycle graph](https://linear.app/docs/cycle-graph)、[Projects](https://linear.app/docs/projects)、[Project status](https://linear.app/docs/project-status)、[Project milestones](https://linear.app/docs/project-milestones)、[Project graph](https://linear.app/docs/project-graph)、[Initiative and Project updates](https://linear.app/docs/initiative-and-project-updates)、[Initiatives](https://linear.app/docs/initiatives)、[Private teams](https://linear.app/docs/private-teams)

# Issues and Workflow: Linear

イシューと、チームごとのワークフローを決める。ワークフローの状態と種類、優先度、ラベルとグループ、見積もりの尺度、担当と購読、親子と関連、重複、Triage、自動で閉じる・アーカイブする規則、ゴミ箱、テンプレートと下書き、履歴を扱う。

前提となる決定は、同期のモデル（[ADR-0002](../decisions/0002-sync-model.md)）、テナントと非公開のチーム（[ADR-0004](../decisions/0004-tenancy-and-permissions.md)）、トランザクションと Writer の検証（[ADR-0006](../decisions/0006-transactions-writer-and-idempotency.md)）、競合の規則と上書きの記録（[ADR-0008](../decisions/0008-conflict-rules-and-fractional-keys.md)）、定義の言語（[ADR-0019](../decisions/0019-schema-definition-and-codegen.md)）、識別子（[ADR-0020](../decisions/0020-ids-and-human-identifiers.md)）。本文とコメントは [editor-and-descriptions.md](editor-and-descriptions.md) にある。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0023](../decisions/0023-workflow-states-and-lifecycle-automation.md) | ワークフローの状態はチームごとの行で、種類（Triage・Backlog・Unstarted・Started・Completed・Canceled・Duplicate）の順は固定。状態の間の移り変わりは制限しない。Duplicate はシステムだけが付ける。自動で閉じる・アーカイブするは Worker の日ごとのシステムのトランザクションで行い、削除はアーカイブと `trashed_at` の組で表して 30 日後に消す |
| [0024](../decisions/0024-hierarchy-relations-duplicates-and-triage.md) | 親子は `parent_id` の LWW と循環の拒否（深さ 10 まで）。関連は向きを正規化した `IssueRelation` の行で、両方のイシューのグループに属し、ID だけを持つ。重複は `duplicate` の関連の作成で表し、状態は派生の変更で Duplicate にする。連鎖は元の 1 件へつなぎ直す。Triage への振り分けは Writer が作成の時に決める |
| [0025](../decisions/0025-derived-changes-in-writer.md) | ある変更から決まる別の変更（ラベルのグループの排他、状態の時刻、重複の状態、親子の自動で閉じる、購読、履歴）は、共有のコードの `derive` で求める。Writer は同じトランザクションで書き、クライアントは同じコードで予測して画面に重ねる |

## 1. 目的と範囲

- 扱う：
  - `Team` のワークフローの設定、`WorkflowState`、`Issue`、`IssueLabel`、`IssueRelation`、`IssueHistory`、`IssueTemplate`、`IssueDraft` の形と規則
  - 状態の移り変わりと、それに伴う時刻・自動の処理
  - 派生の変更（ADR-0025）と、その決定表
  - Worker の定期処理（自動で閉じる、自動のアーカイブ、ゴミ箱の消去）
- 扱わない：
  - 本文・コメント・添付・メンション（[editor-and-descriptions.md](editor-and-descriptions.md)）
  - 識別子と番号（[data-model-and-schema.md](data-model-and-schema.md) の 5 節）
  - サイクル・プロジェクトへの割り当ての規則と集計（[cycles-and-projects.md](cycles-and-projects.md)）
  - 通知の配り先と既読（[notifications-and-inbox.md](notifications-and-inbox.md)）
  - `can()` の決定表（[permissions-and-teams.md](permissions-and-teams.md)）
  - Triage の規則による自動の振り分け・担当の当番（MVP の後。[intent.md](../intent.md)）

## 2. 本家の形（確かめたこと）

いずれも公式の文書。2026-09-28 に確認。

| 項目 | 内容 | 出典 |
| --- | --- | --- |
| 状態の種類 | Backlog・Unstarted・Started・Completed・Canceled・Duplicate の固定の種類。種類の中で状態を並べ替えられるが、種類の順は固定 | [Issue status](https://linear.app/docs/configuring-workflows) |
| 既定の状態 | 新しいイシューは既定の状態（ふつうは最初の Backlog）になる。変えられる | 同上 |
| 最低の数 | 各種類に少なくとも 1 つの状態が要る。Duplicate はシステムが管理し、変えられない | 同上 |
| Triage | 連携（Slack など）から作られたもの、Triage のビューで作ったもの、チームのメンバーでない人が作ったものが Triage に入る。受け入れ（`1`）は既定の状態へ、却下（`2`）は Canceled へ、重複（`3`）、スヌーズ（`H`）。当番・規則は Business 以上 | [Triage](https://linear.app/docs/triage) |
| 優先度 | なし・Low・Medium・High・Urgent の 5 つ。なしは並びで最後。Urgent は担当に通知し、メールでも知らせる | [Priority](https://linear.app/docs/priority) |
| ラベル | ワークスペースのラベルとチームのラベル。グループは 1 段の入れ子で、グループの中から 1 つだけ付けられる。1 グループ 250 個まで。アーカイブしたラベルは付いたまま残るが、新しく付けられない | [Issue labels](https://linear.app/docs/labels) |
| 見積もり | 指数（1・2・4・8・16）、フィボナッチ（1・2・3・5・8）、線形（1〜5）、T シャツ（XS〜XL。数はフィボナッチ）。拡張で 2 つ足せる（32・64、13・21、6・7、XXL・XXXL）。0 を許す設定。見積もりのないイシューは既定で 1 と数える（外せる） | [Estimates](https://linear.app/docs/estimates) |
| 親子 | サブイシューは親のチーム・優先度・プロジェクトを受け継ぐ（ラベルは受け継がない）。親の自動で閉じる（全部のサブイシューが完了したら親も完了）とサブイシューの自動で閉じる（親が完了したら残りも完了）の 2 つの設定。深さの上限は書かれていない | [Parent and sub-issues](https://linear.app/docs/parent-and-sub-issues) |
| 関連 | Related・Blocked by・Blocks・Duplicate。重複はいま見ているイシューを別のイシューの重複にする向きだけ。重複は予約の Duplicate の状態になる。数の上限は書かれていない | [Issue relations](https://linear.app/docs/issue-relations) |
| チームの移動 | 新しい識別子になる。チームのラベルとプロジェクトは外れる。サイクルは対応がなければ外れる。状態は移った先に合わせる。関連と優先度は残る | [Edit issues](https://linear.app/docs/editing-issues) |
| 削除 | 削除したイシューはアーカイブに 30 日置き、その後に消える。`Cmd/Ctrl Z` か、アーカイブの「最近削除したもの」から戻せる | [Delete and archive issues](https://linear.app/docs/delete-archive-issues) |
| 自動の処理 | 自動で閉じるは、一定の期間更新のないイシューを閉じる。自動のアーカイブは、閉じたイシューを一定の期間の後にアーカイブし、作った人に知らせる。新しいチームでは両方が有効 | [Issue status](https://linear.app/docs/configuring-workflows)、[Auto-close and auto-archive](https://linear.app/changelog/2020-08-19-auto-close-and-auto-archive)（2020-08-19） |
| 自動の処理の除外 | 自動で閉じるは、進行中のサイクル・未完了のプロジェクトのイシューを閉じない。期日が先のもの、閉じられないサブイシューを持つものは遅らせる。自動のアーカイブは、閉じて活動のないまま期間を過ぎたものだけ。親が閉じていない、サブイシューが閉じていない、最近の活動がある、進行中のサイクル・未完了のプロジェクトにある（それらが完了して期間を過ぎるまで）ものはアーカイブしない。期間の変更は次の実行（ふつう 24 時間以内）で効く。アーカイブは自動だけで、手動の操作はない | [Delete and archive issues](https://linear.app/docs/delete-archive-issues) |
| スヌーズ | Triage のスヌーズはイシューごとで、他の人の Triage からも隠れる。選んだ時刻か、イシューに新しい活動があった時の早い方で戻る | [Triage](https://linear.app/docs/triage) |
| 下書き | 画面を離れると手元に一時の下書き。閉じると端末をまたぐ下書きになり、6 か月で消える | [Create issues](https://linear.app/docs/creating-issues) |

- 自動のアーカイブの期間を「1〜12 か月」「既定 6 か月」とする記載を検索の抜粋で見たが、文書の本文では選べる値と既定を確かめられなかった（**未検証**）。自動で閉じるの期間の選択肢と既定値、対象の種類も**未検証**。
- 本家のアーカイブは自動だけで、手動の操作がない。本システムは手動のアーカイブ（4.5 節の DT-ISSUE-003 の行 7）を持つ。本家との意図した差異で、残す（18 節の決定。2026-09-28 に PM が決定）。
- Triage の文書は「重複にすると Canceled になる」、関連の文書は「予約の Duplicate の状態になる」と書き、食い違う。本システムは Duplicate の状態に統一する（8 節）。

## 3. モデル

定義の言語は [data-model-and-schema.md](data-model-and-schema.md) の 3 節。主なフィールドだけを書く。

### 3.1 `Team` のワークフローの設定

| フィールド | 型・`conflict` | 意味 |
| --- | --- | --- |
| `default_state_id` | `ref:WorkflowState`・`lww` | 作成と Triage の受け入れの既定。Backlog か Unstarted の状態 |
| `triage_enabled` | `bool`・`lww` | Triage を使うか |
| `estimate_scale` | `enum<none,exponential,fibonacci,linear,tshirt>`・`lww` | 見積もりの尺度 |
| `estimate_extended`・`estimate_allow_zero` | `bool`・`lww` | 拡張の 2 値、0 を許す |
| `unestimated_as_one` | `bool`・`lww` | 集計で見積もりのないものを 1 と数える（既定 `true`） |
| `auto_close_months` | `enum<0,1,3,6,9,12>`・`lww` | 0 は無効。既定 6 |
| `auto_close_state_id` | `ref:WorkflowState`・`lww` | Canceled か Completed の状態 |
| `auto_archive_months` | `enum<1,3,6,9,12>`・`lww` | 既定 6 |
| `parent_auto_close`・`sub_auto_close` | `bool`・`lww` | 親子の自動で閉じる（既定 `false`） |
| `git_on_draft`・`git_on_open`・`git_on_review`・`git_on_merge` | `ref:WorkflowState`・`lww`、nullable、`on_delete: nullify` | PR の状態で動かす行き先（[integrations.md](integrations.md) の 4.4 節。既定は `git_on_open` が最初の `started`、`git_on_merge` が最初の `completed`、他はなし） |
| `git_link_comment` | `bool`・`lww` | PR に返しのコメントを書くか（既定 `true`） |

- 期間の選択肢と既定値は本システムの決定である（本家の値は**未検証**）。

### 3.2 `WorkflowState`

```ts
model("WorkflowState", {
  groups: { rule: "team", from: "team_id" }, load: { strategy: "instant" },
  archivable: true, delete: { mode: "hard" },
  fields: {
    team_id:  { type: "ref:Team", conflict: "lww", on_delete: "cascade" },
    name:     { type: "string", conflict: "lww", max: 64 },
    category: { type: "enum<triage,backlog,unstarted,started,completed,canceled,duplicate>", conflict: "server_only" },
    color:    { type: "string", conflict: "lww", max: 16 },
    position: { type: "order_key", conflict: "order", order_scope: ["team_id", "category"] },
  },
});
```

- `category` は作成の時に決め、後から変えない（`server_only` は作成の値だけを受ける）。別の種類にしたいときは、新しい状態を作ってイシューを移す。
- 1 チーム 50 状態まで（本システムの値）。

### 3.3 `Issue`

[data-model-and-schema.md](data-model-and-schema.md) の 3.1 節の例に加えて、次を持つ。

| フィールド | 型・`conflict` | 書く人 |
| --- | --- | --- |
| `subscriber_ids` | `set<ref:User>`・`set`、500 まで | 利用者、派生（10 節） |
| `started_at`・`completed_at`・`canceled_at`・`triaged_at` | `timestamp`・`server_only`。`completed_at`・`canceled_at` は `import_writable` | 派生（4.3 節）。`origin = import` は `completed_at`・`canceled_at` に操作の値を受ける（DT-IMPORT-002） |
| `activity_at` | `timestamp`・`server_only` | 派生。イシューの変更とコメントの作成で進む（自動で閉じるの判定） |
| `triage_snoozed_until` | `timestamp`・`lww` | 利用者。活動があれば派生で外す |
| `trashed_at` | `timestamp`・`lww` | 利用者（削除と戻し） |
| `creator_id` | `ref:User`・`server_only`、`import_writable` | Writer（`actor`）。`origin = import` だけは操作の値（元のツールの作者に対応付けた `User`）を受ける（DT-IMPORT-002） |

### 3.4 `IssueLabel`

```ts
model("IssueLabel", {
  groups: { rule: "team_or_workspace", from: "team_id" },   // team_id が null ならワークスペース
  load: { strategy: "instant" }, archivable: true, delete: { mode: "hard" },
  fields: {
    team_id:   { type: "ref:Team", conflict: "lww", nullable: true, on_delete: "cascade" },
    parent_id: { type: "ref:IssueLabel", conflict: "lww", nullable: true, on_delete: "restrict" },
    is_group:  { type: "bool", conflict: "server_only" },
    name:      { type: "string", conflict: "lww", max: 80 },
    color:     { type: "string", conflict: "lww", max: 16 },
  },
});
```

- `team_or_workspace` は `team` と `workspace` を `team_id` の有無で選ぶ規則である（[data-model-and-schema.md](data-model-and-schema.md) の 3.5 節）。
- 入れ子は 1 段：グループ（`is_group`）の `parent_id` は `null`、グループの中のラベルの `parent_id` はグループ。グループそのものはイシューに付けられない。
- 1 グループ 250 個（本家と同じ）。ワークスペースで 5,000 個（本システムの値）。

### 3.5 `IssueRelation`

```ts
model("IssueRelation", {
  groups: { rule: "via", from: ["issue_id", "related_issue_id"] },   // 両方のイシューのグループの和
  load: { strategy: "lazy" }, delete: { mode: "hard" },
  fields: {
    issue_id:         { type: "ref:Issue", conflict: "server_only", on_delete: "cascade", index: true },
    related_issue_id: { type: "ref:Issue", conflict: "server_only", on_delete: "cascade", index: true },
    type:             { type: "enum<blocks,related,duplicate>", conflict: "server_only" },
    prev_state_id:    { type: "ref:WorkflowState", conflict: "server_only", nullable: true, on_delete: "nullify" },
  },
});
```

- `via` の `from` に 2 つの参照を書くと、両方の参照先のグループの和になる（[data-model-and-schema.md](data-model-and-schema.md) の 3.5 節）。行は ID だけを持ち、相手のタイトルや状態を持たない（ADR-0004）。
- 関連は作るか消すかだけで、書き換えない。向きの正規化は 7 節。

### 3.6 `IssueHistory`

11 節。

## 4. ワークフローの状態

ADR-0023。

### 4.1 種類と順

```
 triage ─▶ backlog ─▶ unstarted ─▶ started ─▶ completed
                                          └──▶ canceled
                                               duplicate（システムだけ）
```

- 表示と並びの順は、種類の順（上の順）、同じ種類の中は `position` の順。本家と同じく、種類の順は変えられない。
- **最低の数**：`backlog`・`unstarted`・`started`・`completed`・`canceled` は、それぞれ少なくとも 1 つ。`duplicate` はちょうど 1 つで、チームを作る時に Writer が作る。`triage` は `triage_enabled` の間ちょうど 1 つ。
- 最後の 1 つの状態の削除・アーカイブは `workflow_violation` で拒否する。

### 4.2 移り変わり

- 利用者は、どの状態からどの状態へも移せる。本家もワークフローの移り変わりを制限していない（未検証だが、公式の文書に制限の記載がない）。
- 例外（`workflow_violation`）：
  - `duplicate` の状態へ `set state_id` で移すこと（重複の関連の作成でだけ入る。8 節）。
  - `triage` の状態へ移すこと（`triage_enabled` が偽のとき）。
  - 別のチームの状態を指すこと（`invalid_reference`）。

### 4.3 状態の時刻（派生）

DT-ISSUE-001。状態の変更（作成を含む）で、前の種類 → 後の種類から時刻を決める。上から評価し、最初に当たった行。

| # | 後の種類 | 前の種類 | `started_at` | `completed_at` | `canceled_at` | `triaged_at` | その他 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 同じ | 同じ | 変えない | 変えない | 変えない | 変えない | — |
| 2 | `started` | - | 空なら今 | 空にする | 空にする | 前が `triage` なら今 | — |
| 3 | `completed` | - | 変えない | 今 | 空にする | 前が `triage` なら今 | 親子の自動で閉じる（9.3 節） |
| 4 | `canceled`・`duplicate` | - | 変えない | 空にする | 今 | 前が `triage` なら今 | — |
| 5 | `backlog`・`unstarted` | `triage` | 変えない | 空にする | 空にする | 今 | — |
| 6 | `backlog`・`unstarted`・`triage` | - | 変えない | 空にする | 空にする | 変えない | アーカイブ済みなら `unarchive`（4.5 節） |

- 「今」は Writer の確定の時刻。クライアントは予測に手元の時刻を使い、差分で正される（ADR-0025）。

### 4.4 状態の削除とイシューの移し

- イシューが残っている状態は削除できない（`on_delete: restrict`）。画面は「移す先」を選ばせ、Worker のジョブが 500 件ずつのシステムのトランザクションで `set state_id` を当ててから、状態を削除する。
- ジョブの途中で利用者がその状態を選んだ場合、移し終えた後の削除が `restrict` で失敗する。ジョブは残りを移し直して、もう一度削除する（3 回まで）。

### 4.5 アーカイブと削除

DT-ISSUE-003。アーカイブ済み・ゴミ箱のイシューへの操作。

| # | イシューの状態 | 操作 | 結果 |
| --- | --- | --- | --- |
| 1 | 削除済み（消去の後） | どれでも | 拒否 `deleted`（[sync-engine.md](sync-engine.md) の 5.3 節） |
| 2 | ゴミ箱（`trashed_at` あり） | `unarchive` と `set trashed_at = null` の組 | 受け付け（戻す） |
| 3 | ゴミ箱 | それ以外 | 拒否 `workflow_violation`（戻してから編集する） |
| 4 | アーカイブ済み | `set state_id`（開いた種類へ） | 受け付け。派生で `unarchive` |
| 5 | アーカイブ済み | その他の `set`・`add`・`remove`、コメントの作成 | 受け付け。アーカイブのまま（ADR-0002） |
| 6 | 開いている | `archive` と `set trashed_at` の組 | 受け付け（削除 = ゴミ箱へ） |
| 7 | 開いている | `archive` だけ | 受け付け（手動のアーカイブ） |

- **削除はゴミ箱**：利用者の「削除」は、`archive` と `set trashed_at` を 1 つのトランザクションで送る。クライアントの手元ではアーカイブと同じく遅延のモデルになる。30 日後に Worker が本当に消し（`delete` の差分）、参照は `on_delete` に従う（サブイシューの `parent_id` は外れる）。本家の「30 日」と同じ。
- 新しい操作の種類（`restore` など）は足さない。トランザクションの操作の種類（ADR-0006）で表せるため。

## 5. 優先度・担当・購読

- `priority`：`0` なし、`1` Urgent、`2` High、`3` Medium、`4` Low。並べ替えでは 1 → 4 → 0 の順（なしは最後。本家と同じ）。数の割り当ては本システムの決定。
- Urgent にしたときの担当への通知とメールは notifications-and-inbox の領域が扱う。この領域は履歴に残すだけ。
- `assignee_id`：1 人。そのイシューのチームを見てよい人だけ（見てよくない人は `invalid_reference`。存在を明かさない）。チームが非公開になるときに外すのは ADR-0004 のとおり。
- 利用者を無効にしても、担当は外さず、画面で「無効な利用者」と示す（本家の振る舞いは**未検証**）。
- 購読（`subscriber_ids`）：作った人・担当・メンションされた人を派生で足す（ADR-0025）。外すのは本人の `remove` だけ。

## 6. ラベル・見積もり

### 6.1 ラベルのグループの排他

- `label_ids` は `set` の競合（ADR-0002）。そのままだと、同じグループの別のラベルを 2 人が同時に足すと両方が残り、本家の「グループの中から 1 つ」が崩れる。
- そこで、`add label_ids x`（`x` はグループ `G` の中）の派生として、同じイシューの `G` の他のラベルを `remove` する（ADR-0025）。Writer は確定の順で当てるので、同時に足した 2 人のうち、後に確定した方のラベルだけが残る。クライアントは同じ `derive` で予測する。
- 付けられないもの（`invalid_reference`）：グループそのもの、アーカイブしたラベル、別のチームのラベル。外す（`remove`）のは、アーカイブしたラベルでもできる。
- ラベルを消すときは、Worker がイシューから 500 件ずつ外してから行を消す（`on_delete: remove` を 1 つのトランザクションでしない。大きなラベルで書き込みが大きくなるため）。

### 6.2 見積もり

- `estimate` は点数の整数で持つ。尺度は表示の形だけを決める。

| 尺度 | 値 | 拡張 |
| --- | --- | --- |
| `exponential` | 1・2・4・8・16 | 32・64 |
| `fibonacci` | 1・2・3・5・8 | 13・21 |
| `linear` | 1・2・3・4・5 | 6・7 |
| `tshirt` | XS=1・S=2・M=3・L=5・XL=8 | XXL=13・XXXL=21 |

- Writer は、書き込みの時点のチームの尺度（拡張と 0 を含む）にない値を `invalid` で拒否する。
- 尺度を変えても、既にある値を書き換えない。尺度にない値は数のまま「尺度の外」と示す。チームを移したときも同じ。
- 集計（サイクル・プロジェクト）での数え方（`unestimated_as_one`）は cycles-and-projects の領域が使う。親の見積もりに子の合計を足し込まない。

## 7. 関連

ADR-0024。

| 利用者の操作 | 作る行（正規化） |
| --- | --- |
| A は B を塞ぐ（blocks） | `{issue_id: A, related_issue_id: B, type: blocks}` |
| A は B に塞がれる（blocked by） | `{issue_id: B, related_issue_id: A, type: blocks}` |
| A と B は関係する（related） | ID の小さい方を `issue_id` にした `related` |
| A は B の重複 | `{issue_id: A, related_issue_id: B, type: duplicate}`（8 節） |

- 正規化はクライアントの共有のコードで行い、Writer が同じ関数で確かめる（違えば `invalid`）。
- 同じ組と種類の行が既にある場合は `already_exists` で拒否する。同時に 2 人が同じ関連を作った場合に起きる。クライアントはこのコードの拒否を利用者に示さず、手元から消すだけにする（既に同じ関連があるので）。
- 自分自身との関連は `invalid`。1 イシュー 500 関連まで（本システムの値）。
- 塞ぐ関連の循環は拒否しない。「塞がれている」の印はクライアントが関連の行から計算し、フィールドに持たない。
- 相手を見てよくない場合、画面は「非公開のイシュー」と示す（ADR-0004）。

## 8. 重複

ADR-0024、ADR-0025。

- 重複にする操作は `create IssueRelation {type: duplicate}` の 1 つ。派生で、A の状態を A のチームの `duplicate` の状態にし、前の状態を関連の `prev_state_id` に書き、A の購読者を B に足す。
- **連鎖**：B がすでに C の重複なら、Writer は関連の相手を C（元の 1 件）に書き換える（`server_ops`）。A が他のイシューの元になっているとき、それらの重複の関連も C へつなぎ直す（派生）。これで重複の関連は、常に重複でないイシューを指す。
- **循環**：C が A の重複になるなど、元へたどると自分に戻る場合は `cycle` で拒否する。
- **解除**：関連の `delete`。派生で、A の状態を `prev_state_id` に戻す。その状態がもうなければ、A のチームの `default_state_id` にする。
- 本家の Triage の重複は添付を元へ移すと書かれている。MVP は購読者だけを移し、添付とコメントは移さない（本家との差異）。

## 9. 親子

ADR-0024。

### 9.1 規則

- `parent_id` は LWW。Writer は循環（`cycle`）と、深さ 10 を超える木（`invalid`）を拒否する。1 つの親の子は 1,000 件まで。深さと子の数は本システムの値（本家の上限は書かれていない）。
- 子は親と別のチームでもよい。親を見てよくない人には、親は「非公開のイシュー」と示す。
- 作成の既定：サブイシューを作る画面は、親のチーム・優先度・プロジェクトを初期値にする（本家と同じ）。これは画面の既定で、Writer の規則ではない。
- 子の並びは `sub_sort_key`（`order_scope: parent_id`）。

### 9.2 チームの移動

- イシューを移すと、派生で次を行う（本家と同じ振る舞い）：チームのラベルを外す、プロジェクトを外す、移った先に対応するサイクルがなければ外す、状態を移った先の同じ名前の状態か、なければ同じ種類の最初の状態にする。番号と別名は ADR-0020。
- 子と関連は動かさない。

### 9.3 自動で閉じる

DT-ISSUE-004。完了（`completed`）への変更の派生。

| # | 設定 | 出来事 | 派生 |
| --- | --- | --- | --- |
| 1 | 親のチームの `parent_auto_close` | 子が閉じた（`completed`・`canceled`・`duplicate`）結果、親の子がすべて閉じ、1 つ以上が `completed` | 親を親のチームの最初の `completed` の状態へ |
| 2 | 子のチームの `sub_auto_close` | 親が `completed` になった | 開いている子を、それぞれのチームの最初の `completed` の状態へ |
| 3 | どちらも偽 | — | なし |

- 派生は上（親）へも下（子）へも連なるが、1 回の派生の中で同じイシューを 2 度変えない（訪ねた集合を持つ）。深さ 10 と子の 1,000 件の上限で、派生の量に上限がある。
- 1 つのトランザクションの派生の変更が 500 件を超えたら、残りを Worker のシステムのトランザクションに回す。画面は「n 件を閉じています」と示す。

## 10. Triage

ADR-0024。MVP は Triage の状態と手動の振り分けだけにする（[intent.md](../intent.md)）。

### 10.1 入り口

DT-ISSUE-002。`create Issue` の時の状態を Writer が決める。上から評価し、最初に当たった行。

| # | `triage_enabled` | `origin` | 作った人がチームのメンバー | クライアントの `state_id` | 結果の状態 |
| --- | --- | --- | --- | --- | --- |
| 1 | - | `import` | - | あり | クライアントの値（元のツールの状態の対応付け。DT-IMPORT-002 の行 4） |
| 2 | 偽 | - | - | あり | クライアントの値 |
| 3 | 偽 | - | - | なし | `default_state_id` |
| 4 | 真 | `api`・`worker`（連携の受付） | - | - | Triage |
| 5 | 真 | `client` | いいえ | - | Triage |
| 6 | 真 | `client` | はい | あり | クライアントの値 |
| 7 | 真 | `client`・`import` | はい・- | なし | `default_state_id` |

- Writer がクライアントの値を Triage に替えたときは、`server_ops` で知らせる。クライアントは同じ表で予測できる（チームのメンバーシップは手元にある）ので、通常は画面が動かない。
- 行 1：`origin = import` は、元のツールの状態の対応付け（[import-export.md](import-export.md) の 4 節）に従い、Triage に替えない。対応付けに状態がない行は行 7 で `default_state_id` にする。統合の工程で、import-export の依頼を受けて足した。

### 10.2 操作

| 操作 | キー（本家） | トランザクション |
| --- | --- | --- |
| 受け入れ | `1` | `set state_id = default_state_id`（別の状態を選んでもよい） |
| 却下 | `2` | `set state_id = 最初の canceled`。理由があれば `create Comment` を同じトランザクションに |
| 重複にする | `3` | 8 節 |
| スヌーズ | `H` | `set triage_snoozed_until` |

- スヌーズはイシューごと（チームで共有）にする。コメントの作成とイシューの変更の派生で `triage_snoozed_until` を外す（本家と同じ。2 節）。
- ショートカットをどこまで本家に寄せるかは法務の L8 の後に見直す（[client-app.md](client-app.md) の 5 節）。

## 11. 履歴

ADR-0025。

```ts
model("IssueHistory", {
  groups: { rule: "via", from: "issue_id" }, load: { strategy: "lazy" }, delete: { mode: "hard" },
  fields: {
    issue_id: { type: "ref:Issue", conflict: "server_only", on_delete: "cascade", index: true },
    actor_id: { type: "ref:User", conflict: "server_only", nullable: true, on_delete: "nullify" },
    origin:   { type: "enum<client,api,worker,notifier,import>", conflict: "server_only" },
    tx_id:    { type: "uuid", conflict: "server_only" },
    changes:  { type: "json", conflict: "server_only", schema: "HistoryChanges" },
  },
});
```

```json
{ "changes": [
    { "f": "state_id", "from": "…", "to": "…" },
    { "f": "label_ids", "added": ["…"], "removed": ["…"] },
    { "f": "title", "from": "旧", "to": "新", "overwrite": { "old_actor": "…", "old_sync_id": 18200 } },
    { "k": "relation", "type": "duplicate", "to": "…" },
    { "k": "auto", "rule": "auto_close" } ] }
```

- Writer が、1 つのトランザクションで変わったイシューごとに 1 行を、同じ DB のトランザクションで書く（派生）。対象は定義の `history` に挙げたフィールドと、関連・移動・アーカイブ・自動の処理。上書きの記録（ADR-0008）も同じ行に入れる。
- 本文の変更は履歴に入れない（本文の版は [editor-and-descriptions.md](editor-and-descriptions.md) の 4.7 節）。
- 画面の「活動」は、履歴とコメントを `sync_id` の順に並べたもの。同じ人の 5 分以内の続けての変更は、画面でまとめて見せる（サーバーではまとめない。行を書き換えると差分が増えるため）。
- 保持の期間は、イシューがある間。法務の L5 の結論で見直す。

## 12. テンプレートと下書き

- `IssueTemplate`：`team_id`（`null` はワークスペース）、`name`、`data`（`json`。作成の既定のフィールドと、本文の ProseMirror の JSON）。`instant`。適用は画面が行い、普通の `create` のトランザクションになる。Writer はテンプレートを知らない。
- `IssueDraft`：`user:<id>` のグループ、`lazy`。本文はテンプレートと同じ JSON で持ち、CRDT にしない（書くのは本人だけ）。180 日で Worker が消す（本家の 6 か月に合わせる）。画面を離れたときの一時の下書きは手元（`localStorage` ではなく IndexedDB の `_drafts`。[client-store-and-offline.md](client-store-and-offline.md) の 3.2 節）。

## 13. 定期処理（Worker）

ADR-0023。

| ジョブ | いつ | 対象 | 当てる操作 |
| --- | --- | --- | --- |
| 自動で閉じる | チームごとに 1 日 1 回（ワークスペースのタイムゾーンで 03:00〜05:00 に散らす） | `backlog`・`unstarted` の種類で、`activity_at` が `auto_close_months` より前、アーカイブ・ゴミ箱でない。ただし、進行中のサイクル（`Cycle.status = active`）のもの、未完了のプロジェクト（状態の種類が完了・取り消しでない）のもの、`due_date` が今日より後のもの、自動で閉じる条件を満たさない開いたサブイシューを持つものは除く | `set state_id = auto_close_state_id` |
| 自動のアーカイブ | 同上 | `completed`・`canceled`・`duplicate` の種類で、`completed_at`・`canceled_at` と `activity_at` の遅い方が `auto_archive_months` より前。ただし、親が閉じていないもの、閉じていないサブイシューを持つもの、サイクル・プロジェクトにあり、そのサイクル・プロジェクトが完了から `auto_archive_months` を過ぎていないものは除く | `archive` |
| ゴミ箱の消去 | 1 日 1 回 | `trashed_at` が 30 日より前 | `delete` |
| 状態・ラベルの消去の続き | 4.4・6.1 節の操作の後 | 移すイシュー | `set`・`remove` |
| 派生の続き | 9.3 節の 500 件の超過 | 残りのイシュー | 9.3 節の派生 |

- すべて `actor = system`、`origin = worker` の Writer のトランザクションで、100 件ずつ。1 ワークスペースの `worker` の枠（1 秒 50 変更、瞬間 500。[ADR-0054](../decisions/0054-per-workspace-write-admission.md)、[capacity.md](capacity.md) の 2.2 節）に従い、枠を超えたら `retry` を待って続ける。利用者の書き込みのロックの待ち（`lock_timeout` 2 秒）を伸ばさない。自動で閉じる・アーカイブの開始の時刻は、ワークスペースの ID のハッシュで 03:00〜05:00 に散らし、1 つの Aurora のクラスタで同時に走るワークスペースを 20 までにする（ADR-0023 の注記）。
- 自動の処理の結果は履歴に `{k: "auto", rule}` で残る。作った人への知らせは notifications-and-inbox の領域が、履歴の行から作る。
- 除外の条件は本家の文書に合わせた（2 節。2026-09-28 の注記：当初は期間と種類だけを見ていた）。サイクル・プロジェクトの除外は、進行中の計画の中のイシューを、動いていないだけで閉じない・隠さないため。
- `activity_at` と閾値の比較は Writer の中でもう一度行う。ジョブが読んでから書くまでの間に活動があったイシューは、飛ばす（`workflow_violation` にせず、その件だけ外す）。

## 14. 障害のときの振る舞い

| 事象 | 起きること | 備え |
| --- | --- | --- |
| クライアントとサーバーの `derive` の結果が違う | 画面の予測が差分で正されるまでずれる | 同じ共有のコード（ADR-0025）。差分テスト。版の違いは互換の一覧で弾く |
| 同時に同じグループのラベルを足した | 片方だけが残る（後に確定した方） | 仕様。履歴に両方の操作が残る |
| 同時に同じ関連を作った | 片方が `already_exists` | 画面には示さない |
| オフラインで重複にしたが、元のイシューが先に削除された | `invalid_reference` で拒否 | 拒否の一覧に示す（[client-store-and-offline.md](client-store-and-offline.md) の 9.4 節） |
| 自動で閉じるのジョブが遅れた・止まった | 閉じるのが遅れる | 翌日に続きから。1 日で終わらなければ警告 |
| 派生の連なりが大きい | ワークスペースのロックが長くなる | 500 件で Worker に回す（9.3 節） |
| 状態の消去のジョブが繰り返し失敗 | 状態が残る | 3 回で止め、管理者に示す |

## 15. セキュリティ

- 状態・ラベル・担当・親・関連の参照先は、`actor` が見てよいものだけ（[sync-engine.md](sync-engine.md) の 5.3 節の行 8）。見てよくない参照の拒否は、存在を明かさない文言にする。
- 関連の行は両方のグループに入るが、相手のタイトルや状態を持たない（ADR-0004）。重複の派生で相手の購読者を足すときも、相手を見てよくない人は足さない（`can()` で絞る）。
- 派生の変更は `actor` の権限ではなく、元の変更が許されたことを根拠に当てる。たとえば、非公開のチームの親を、子のチームだけのメンバーが自動で閉じることがある。これは設定（`parent_auto_close`）を置いたチームの意図として受け入れ、履歴に `{k: "auto"}` と元の `tx_id` を残す。
- 履歴の `changes` の値（タイトル）は、行と同じ同期グループにだけ届く。ログには値を書かない。

## 16. テスト

- 表駆動テスト（決定表を spec から読み込む）：DT-ISSUE-001（状態の時刻）、DT-ISSUE-002（Triage の入り口）、DT-ISSUE-003（アーカイブとゴミ箱）、DT-ISSUE-004（自動で閉じる）。クライアントの予測と Writer の両方で全行を確かめる。
- 性質ベーステスト（[ADR-0010](../decisions/0010-deterministic-sync-simulator.md) のシミュレーター）：
  - **PROP-ISSUE-001（グループの排他）**：任意の同時のラベルの操作の後、どのイシューもグループごとにラベルを 1 つ以下しか持たず、全クライアントで同じ。
  - **PROP-ISSUE-002（派生の一致）**：任意のトランザクションについて、クライアントの `derive` の予測と Writer の結果が、確定の順で当てたとき一致する（時刻の値を除く）。
  - **PROP-ISSUE-003（重複の元）**：任意の重複の作成・解除・削除の列の後、`duplicate` の関連の相手は重複でないイシューで、循環がない。解除したイシューは Duplicate でない状態にある。
  - **PROP-ISSUE-004（木）**：任意の親の変更の列の後、親子は循環のない深さ 10 以下の森である。
  - **PROP-ISSUE-005（自動で閉じるの停止）**：任意の木と設定で、自動で閉じるの派生は有限で終わり、同じイシューを 1 回の派生で 2 度変えない。
  - **PROP-ISSUE-006（最低の数）**：任意の状態の作成・削除・アーカイブの列の後、各チームは 4.1 節の最低の数を満たす。
  - **PROP-ISSUE-007（履歴）**：`history` のフィールドを変えた確定のトランザクションごとに、変えたイシューの履歴の行がちょうど 1 つある。
- 結合テスト：自動で閉じる・アーカイブ・ゴミ箱の消去のジョブを、時計を進めて回し、`worker` の枠と開始の時刻の散らしと、読んでから書くまでの間の活動の除外を確かめる。

## 17. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E5 | `workflow-states` | 3.2・4.1・4.2 節の状態、種類、最低の数、Duplicate の自動の作成 |
| E5 | `state-timestamps-derive` | DT-ISSUE-001 と派生の仕組み（ADR-0025） |
| E5 | `state-delete-migration` | 4.4 節の移しのジョブ |
| E5 | `issue-core-fields` | 3.3 節のフィールド、優先度、担当、購読の派生 |
| E5 | `labels-and-groups` | 3.4・6.1 節のラベル、グループの排他、アーカイブ、消去のジョブ |
| E5 | `estimates` | 6.2 節の尺度と検証 |
| E5 | `sub-issues` | 9.1 節の親子、深さ、並び |
| E5 | `issue-team-move` | 9.2 節の移動の派生（data-model-and-schema の 5.4 節を含む） |
| E5 | `auto-close-parent-sub` | 9.3 節と DT-ISSUE-004 |
| E5 | `issue-relations` | 7 節の関連と正規化 |
| E5 | `duplicates` | 8 節の重複、連鎖、解除 |
| E5 | `triage-intake` | 10 節と DT-ISSUE-002、操作 |
| E5 | `archive-and-trash` | 4.5 節と DT-ISSUE-003、戻し |
| E5 | `issue-history` | 11 節の履歴と、活動の表示の元（client-app と共同） |
| E5 | `issue-templates-drafts` | 12 節 |
| E5 | `lifecycle-jobs` | 13 節の自動で閉じる・アーカイブ・ゴミ箱の消去 |
| E5 | `issue-sim-props` | 16 節の PROP-ISSUE-001〜007 |
| E6 | `triage-view-shortcuts` | Triage の一覧と `1`・`2`・`3`・`H`（client-app と共同。L8 の後に承認） |

## 18. 未解決の問い

- 状態の移り変わりを制限できるようにするか（例：Backlog から Completed へ直接は移せない）。
- 自動で閉じる・アーカイブの期間の選択肢と既定値。
- 重複にしたとき、添付とコメントを元へ移すか。
- スヌーズを利用者ごとにするか、イシューごとにするか。
- 親子の深さと子の数の上限。
- 利用者を無効にしたとき、担当を外すか。
- 履歴をサーバーでまとめるか。

### 決定

2026-09-28 の既定案。E5 の実装と試用の声で覆りうる。

- **移り変わり**：制限しない。Duplicate へは重複の関連でだけ入る（ADR-0023）。
- **期間**：自動で閉じるは 0（無効）・1・3・6・9・12 か月から選び、既定 6 か月、閉じる先は最初の Canceled。自動のアーカイブは 1・3・6・9・12 か月、既定 6 か月（ADR-0023）。
- **削除**：アーカイブと `trashed_at` の組でゴミ箱へ、30 日で消す（ADR-0023）。
- **手動のアーカイブ**：残す（DT-ISSUE-003 の行 7）。本家はアーカイブを自動だけにするが、利用者が自動のアーカイブを待たずに片付けられるようにする。本家との意図した差異（2026-09-28 に PM が決定）。
- **重複**：Duplicate の状態に統一（本家の文書の食い違いは Triage の文書を採らない）。購読者だけを元へ移す（ADR-0024）。
- **スヌーズ**：イシューごと。活動で外す（本家と同じ。2 節）。
- **親子**：深さ 10、子 1,000 件（ADR-0024）。
- **無効な利用者の担当**：外さない。
- **履歴**：トランザクションとイシューごとに 1 行。まとめは画面だけ（ADR-0025）。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| 派生の変更が 1 ワークスペースの書き込みの上限（1 秒 300 件）をどれだけ食うか | E2 の PoC の後、E5 で派生を含めて測る |
| 本家の自動の処理の期間の選択肢と既定値、無効な利用者の担当の扱い | 公式の資料で確かめられなかった（**未検証**のまま） |
| ショートカットの割り当てを本家に寄せる範囲 | 法務の L8 |

## 19. quality.md・runbooks・data-model への項目

### quality.md

- DT-ISSUE-001〜004 の表駆動テストと PROP-ISSUE-001〜007 を E5 のリリースの基準にする。
- 本番：`workflow_violation`・`already_exists`・`cycle` の拒否の率。`already_exists` の急な増加は正規化のずれの目安。
- 本番：派生の変更の件数の分布（1 トランザクションあたり）と、Worker に回した回数。
- 本番：定期処理のジョブの終わりの時刻と、1 日で終わらなかったチームの数。
- 抜き取りの監査：グループに 2 つ以上のラベルを持つイシュー、Duplicate の状態で関連のないイシュー、最低の数を満たさないチームが 0 件。

### runbooks

- `lifecycle-jobs.md`：自動で閉じる・アーカイブ・ゴミ箱の消去のジョブの遅れと失敗の確かめ方、止め方（チームごとの停止のフラグ）、再開。
- `mass-auto-close-rollback.md`：設定の誤りで大量に閉じた・アーカイブしたときの戻し方（履歴の `{k: "auto"}` と `tx_id` から、逆の操作を Worker で当てる）。
- `trash-restore-request.md`：ゴミ箱の 30 日を過ぎた復元の依頼への対応（PITR からの取り出し。`sync_epoch` を上げない部分の戻し方の判断）。

### data-model（索引への追加の提案）

| 表・モデル | 中身 | 節 |
| --- | --- | --- |
| `teams` のワークフローの設定 | 既定の状態、Triage、見積もり、自動の処理の期間、親子の自動で閉じる、PR の状態の自動化（`git_on_*`・`git_link_comment`） | 3.1 |
| `workflow_states` | 状態、種類、並び | 3.2 |
| `issues` | 状態の時刻、`activity_at`、`triage_snoozed_until`、`trashed_at`、`subscriber_ids` | 3.3 |
| `issue_labels` | ワークスペース・チームのラベル、グループ | 3.4 |
| `issue_relations` | 正規化した関連、`prev_state_id` | 3.5 |
| `issue_history` | トランザクションとイシューごとの変更、上書き、自動の処理 | 11 |
| `issue_templates`・`issue_drafts` | テンプレートと端末をまたぐ下書き | 12 |

## 出典

いずれも 2026-09-28 に確認。

- Linear Docs, [Issue status](https://linear.app/docs/configuring-workflows)、[Triage](https://linear.app/docs/triage)、[Priority](https://linear.app/docs/priority)、[Issue labels](https://linear.app/docs/labels)、[Estimates](https://linear.app/docs/estimates)、[Parent and sub-issues](https://linear.app/docs/parent-and-sub-issues)、[Issue relations](https://linear.app/docs/issue-relations)、[Edit issues](https://linear.app/docs/editing-issues)、[Delete and archive issues](https://linear.app/docs/delete-archive-issues)、[Create issues](https://linear.app/docs/creating-issues)
- Linear Changelog, [Auto-close and auto-archive](https://linear.app/changelog/2020-08-19-auto-close-and-auto-archive)（2020-08-19）

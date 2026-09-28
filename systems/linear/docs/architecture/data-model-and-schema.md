# Data Model and Schema: Linear

モデルの定義の言語と、そこから生成するコードを決める。フィールドの型と競合の種類、参照と削除の規則、読み込みの方針、同期グループ、`order_scope`、`include`、生成の出力（DB・サーバー・クライアント・GraphQL）、スキーマの版と後方互換、ID と人が読む識別子（`ENG-123`）を扱う。

前提となる決定は、基盤（[ADR-0001](../decisions/0001-platform-and-stack.md)）、同期のモデル（[ADR-0002](../decisions/0002-sync-model.md)）、読み込みの方針と同期グループ（[ADR-0003](../decisions/0003-bootstrap-and-partial-sync.md)）、テナントと RLS（[ADR-0004](../decisions/0004-tenancy-and-permissions.md)）、手元の移行と outbox の変換（[ADR-0005](../decisions/0005-client-persistence-and-offline.md)、[ADR-0014](../decisions/0014-indexeddb-layout-durability-and-migrations.md)）、競合の規則の置き場所（[ADR-0008](../decisions/0008-conflict-rules-and-fractional-keys.md)）。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0019](../decisions/0019-schema-definition-and-codegen.md) | モデルは TypeScript の宣言（`model()`）で 1 か所に書き、DB の望む形・サーバーとクライアントの共有のパッケージ・IndexedDB の構成・被覆の鍵・GraphQL の型を生成する。`conflict`・`groups`・`load`・参照の削除の規則のどれかが欠けたら生成を失敗させる。スキーマの変更は「互換」と「破壊」に機械で分け、破壊の変更は広げてから縮める 2 段で行う |
| [0020](../decisions/0020-ids-and-human-identifiers.md) | モデルの ID はクライアントが振る UUIDv7。人が読む番号はチームごとの数から Writer が確定の時に振り、再利用しない。チームを移したイシューは移った先で番号を振り直し、古い識別子は別名の表で引けるようにする |

## 1. 目的と範囲

- 扱う：
  - モデルの定義の言語（モデル・フィールド・参照・索引の書き方）
  - 型と競合の種類の組み合わせの規則
  - 読み込みの方針（`load`）、`include`、同期グループの規則（`groups`）、`order_scope`
  - 生成するもの（DB の望む形、共有のパッケージ、クライアントの構成、GraphQL の型）と、生成の検査
  - スキーマの版（`schema_version`・`schema_hash`・`fv`）と、変更の分類
  - ID、人が読む識別子、チームの移動と接頭辞の変更
- 扱わない：
  - 競合の規則そのもの、並びの鍵の算法（[sync-engine.md](sync-engine.md) の 8 節）
  - ブートストラップと被覆の鍵の意味（[bootstrap-and-partial-sync.md](bootstrap-and-partial-sync.md)）
  - IndexedDB の移行の手順（[client-store-and-offline.md](client-store-and-offline.md) の 6 節）
  - 個々のモデルの中身（イシューは [issues-and-workflow.md](issues-and-workflow.md)、本文は [editor-and-descriptions.md](editor-and-descriptions.md)）
  - `can()` の決定表（[permissions-and-teams.md](permissions-and-teams.md)）
  - 公開 API のスキーマの形、ページング、複雑さ（[api-and-webhooks.md](api-and-webhooks.md)）

## 2. 本家の形（確かめたこと）

いずれも 2026-09-28 に確認。

| 項目 | 内容 | 出典 |
| --- | --- | --- |
| 識別子（公式） | イシューは、作った順に続く番号を持つ。識別子はチームの識別子と番号を組み合わせたもの | [Create issues](https://linear.app/docs/creating-issues) |
| チームの移動（公式） | 別のチームへ移すと、新しい識別子と URL になる。古い URL は新しい URL へ転送され、古い識別子で検索しても今のイシューが出る。本文の中の古い識別子の参照は、押せば転送されるが、見た目は古いまま | [Edit issues](https://linear.app/docs/editing-issues) |
| 移動での値（公式） | チームのラベルとプロジェクトは外れる。サイクルは移った先に対応がなければ外れる。状態は移った先のワークフローに合わせる。関連と優先度は残る | 同上 |
| モデルの登録（第三者の解析） | `ModelRegistry` がモデル（約 80 種）とプロパティのメタデータを持ち、そこからスキーマのハッシュを計算する。プロパティには読み込みの方針（instant・lazy など）の印がある | [wzhudev/reverse-linear-sync-engine](https://github.com/wzhudev/reverse-linear-sync-engine)（本家の保証ではない） |

- チームの識別子の長さ・使える文字、識別子を変えたときの古い識別子の扱いは、公式の資料で確かめられなかった（**未検証**）。
- 本家がモデルの定義から DB やクライアントのコードを生成しているかは、**未検証**。この設計は、定義を 1 か所に書く考え方だけを参考にし、コードは自前で書く（[リポジトリ共通の ADR-0007](../../../../docs/decisions/0007-no-reuse-of-original-implementation.md)）。

## 3. 定義の言語

ADR-0019。

### 3.1 形

定義は、共有のパッケージ `packages/schema` の TypeScript のファイルに書く。実行時のコードではなく、生成器が読む宣言である。

```ts
model("Issue", {
  table: "issues",
  groups: { rule: "team", from: "team_id" },           // team:<team_id>
  load: { strategy: "partial", condition: "issue_active_30d" },
  include: ["IssueDescription:id", "Comment:issue_id", "IssueHistory:issue_id", "Attachment:issue_id",
            "IssueRelation:issue_id", "IssueRelation:related_issue_id", "IssueAlias:issue_id",
            "GitLink:issue_id"],                              // GitLink は integrations の 4.3 節
  archivable: true,
  delete: { mode: "trash", purge_after_days: 30 },
  history: ["title", "state_id", "priority", "assignee_id", "estimate", "label_ids", "parent_id",
            "cycle_id", "project_id", "due_date", "team_id"],
  track_overwrites: ["title", "state_id", "priority", "assignee_id", "estimate", "due_date",
                     "cycle_id", "project_id", "parent_id"],
  fields: {
    team_id:     { type: "ref:Team", conflict: "lww", on_delete: "restrict", index: true, m2: true },
    number:      { type: "int", conflict: "server_only", m2: true },
    title:       { type: "string", conflict: "lww", max: 512, search: true, pii: "content", m2: true },
    state_id:    { type: "ref:WorkflowState", conflict: "lww", on_delete: "restrict", m2: true },
    priority:    { type: "enum<0,1,2,3,4>", conflict: "lww", default: 0, m2: true },
    assignee_id: { type: "ref:User", conflict: "lww", nullable: true, on_delete: "nullify", index: true, m2: true },
    label_ids:   { type: "set<ref:IssueLabel>", conflict: "set", max: 100, on_delete: "remove", m2: true },
    parent_id:   { type: "ref:Issue", conflict: "lww", nullable: true, on_delete: "nullify", index: true, m2: true },
    sort_key:    { type: "order_key", conflict: "order", order_scope: ["team_id"], m2: true },
    sub_sort_key:{ type: "order_key", conflict: "order", order_scope: ["parent_id"] },
    estimate:    { type: "int", conflict: "lww", nullable: true, range: [0, 1000], m2: true },
    due_date:    { type: "date", conflict: "lww", nullable: true, m2: true },
    completed_at:{ type: "timestamp", conflict: "server_only", nullable: true, m2: true, import_writable: true },
    creator_id:  { type: "ref:User", conflict: "server_only", nullable: true, on_delete: "nullify", import_writable: true },
    trashed_at:  { type: "timestamp", conflict: "lww", nullable: true },
  },
});
```

- 1 つのモデルは 1 つの `model()` で書く。フィールドの意味（例：`completed_at` を誰がいつ書くか）は、各領域の文書が決め、ここには形だけを書く。
- 定義から外れた書き方（任意の関数、条件分岐）は許さない。例外は `groups` の規則と `load.condition` で、どちらも名前の付いた既定の部品から選ぶ（3.5・3.6 節）。生成器が SQL とクライアントのコードの両方に訳せる必要があるため。

### 3.2 フィールドの属性

| 属性 | 必須 | 意味 |
| --- | --- | --- |
| `type` | 必須 | 3.3 節の型 |
| `conflict` | 必須 | `lww`・`set`・`order`・`counter`・`server_only`・`crdt`（ADR-0008） |
| `nullable` | — | 既定は `false` |
| `default` | — | `create` で省いたときの値。必須のフィールドを後から足すときは必須（6.3 節） |
| `max`・`range`・`enum` の値 | 型による | `string` は `max` が必須。`set` は要素の数の `max` が必須 |
| `on_delete` | `ref`・`set<ref>` で必須 | 参照先が消えたとき：`restrict`（消すのを拒否）・`nullify`（参照を外す）・`remove`（集合から除く）・`cascade`（一緒に消す） |
| `order_scope` | `order` で必須 | 鍵が一意である範囲のフィールドの列（ADR-0008） |
| `index` | — | サーバーの索引、手元の IndexedDB の索引、被覆の鍵のフィールドになる |
| `m2` | — | 手元の詰めた索引（M2）の列に入れる（[client-store-and-offline.md](client-store-and-offline.md) の 7.1 節） |
| `search` | — | 検索の索引に入れる（search の領域） |
| `api` | — | `public`（公開 API に出す。既定）・`internal`（出さない） |
| `pii` | — | `identity`（名前・メールアドレス）・`content`（利用者が書いた中身）。ログへの出力の禁止、書き出し、保持の判断に使う |
| `derive_only` | — | `counter` だけ。利用者の送った `incr` を `forbidden` で拒否し、派生（ADR-0025）の `incr` だけを受ける（例：`ProgressStat`。[cycles-and-projects.md](cycles-and-projects.md) の 7.2 節） |
| `import_writable` | — | `server_only` のフィールドのうち、`origin = import` のトランザクションだけが操作の値で書けるもの（`created_at`、作者、`completed_at`・`canceled_at`。DT-IMPORT-002。[import-export.md](import-export.md) の 5.2 節）。他の `origin` の値は捨てずに拒否する（`invalid`） |
| `since` | 生成器が付ける | そのフィールドを足した `schema_version` |

### 3.3 型と競合の種類の組み合わせ

| 型 | 使える `conflict` | 備考 |
| --- | --- | --- |
| `string`・`int`・`float`・`bool`・`date`・`timestamp`・`uuid` | `lww`・`server_only`。`int` は `counter` も | `timestamp` は ISO 8601 の UTC。`date` は日付だけ（タイムゾーンなし） |
| `enum<...>` | `lww`・`server_only` | 知らない値を受けても落ちないこと（6.3 節）を生成したコードで守る |
| `ref:<Model>` | `lww`・`server_only` | `on_delete` が必須 |
| `set<ref:<Model>>`・`set<string>` | `set` | 集合の全体の置き換えを受けない（ADR-0008） |
| `order_key` | `order` | `order_scope` が必須 |
| `crdt_doc` | `crdt` | 本文のモデル（`IssueDescription` など）だけ。1 つのモデルに 1 つ（[editor-and-descriptions.md](editor-and-descriptions.md)） |
| `json` | `lww` | 中身の JSON Schema を必須にする。任意の形は許さない |
| `bytes` | `server_only` | バイト列（JSON では base64）。`max_bytes` が必須。行の JSON・差分・ブートストラップに載せず、ID の読み込み（`<Model>:id=…`）の応答だけで返す（`crdt_doc` と同じ扱い）。例：`IssueDescriptionVersion.state`（[data-model.md](data-model.md) の 2.5 節。2026-09-28 に足した） |

- 表にない組み合わせは生成で失敗させる。たとえば `set<...>` を `lww` にすると、同時に別の要素を足した 2 人の変更の片方が消える（ADR-0002 が退けた形）。

### 3.4 モデルの属性

| 属性 | 必須 | 意味 |
| --- | --- | --- |
| `groups` | 必須 | 行の同期グループの規則（3.5 節） |
| `load` | 必須 | `instant`・`partial`・`lazy`（ADR-0003）。`partial` は `condition` が必須 |
| `include` | — | この行を ID で読み込んだとき、一緒に読む被覆の鍵（3.7 節） |
| `archivable` | — | `archive`・`unarchive` を受けるか |
| `delete` | 必須 | `hard`（すぐに消す）か `trash`（アーカイブしてゴミ箱に置き、後で消す。`purge_after_days`）。`trash` のモデルに `trashed_at`（`timestamp`・`lww`）の宣言がなければ、生成器が足す |
| `history` | — | 履歴に残すフィールド（[issues-and-workflow.md](issues-and-workflow.md) の 11 節） |
| `track_overwrites` | — | 上書きを記録するフィールド（ADR-0008） |
| `derive` | — | 派生の変更の関数の名前（[issues-and-workflow.md](issues-and-workflow.md) の ADR-0025） |
| `guest_visible` | `groups` が `workspace` の規則のとき必須 | ゲストにも届けてよい理由の文（[permissions-and-teams.md](permissions-and-teams.md) の 6.2 節）。ワークスペースの行のモデルは既定で `workspace_members` にし、ゲストに要るものだけを `workspace` にする |

### 3.5 同期グループの規則

| `rule` | 行の同期グループ | 例 |
| --- | --- | --- |
| `workspace` | `workspace`（ゲストを含む全員） | `Workspace`、`User`、`ProjectStatus`、ワークスペースのラベル（`team_or_workspace` の `null` の側）。`guest_visible` が必須 |
| `workspace_members` | `members`（ゲストを除くメンバー） | `WorkspaceSettings`、`Initiative`（[ADR-0033](../decisions/0033-team-visibility-changes-and-guests.md)） |
| `team` | `team:<from の値>` | `Issue`、`WorkflowState`、`Cycle`、`ProjectTeam`、`ProgressStat` |
| `team_or_workspace` | `from` の値があれば `team:<値>`、`null` なら `workspace` | `IssueLabel`、`IssueTemplate` |
| `team_row` | チームの行とメンバーシップ：公開のチームなら `workspace`、非公開なら `team:<id>` と `role:admin`（`from` はチームの ID。`Team` では自分の `id`） | `Team`、`TeamMembership`（ADR-0033） |
| `via` | 参照先の行のグループをそのまま使う（`from` は参照のフィールド）。`from` に 2 つの参照を書くと、両方のグループの和 | `Comment`（`issue_id` のイシューのグループ）、`IssueDescription`、`IssueHistory`、`IssueRelation`（両方のイシュー）、`ProjectMilestone`・`ProjectUpdate`・`InitiativeProject`（プロジェクト） |
| `user` | `user:<from の値>` | `Notification`、`SyncSubscription`、`IssueDraft`、個人の `View` |
| `admin` | `role:admin` | 連携の設定、招待、Webhook |
| `teams` | **結び付けのモデル**の行のチームのグループの和。`from` は `<結び付けのモデル>.<チームの参照>`（例：`ProjectTeam.team_id`）で、自分の行のフィールドを指せない | `Project`（[cycles-and-projects.md](cycles-and-projects.md) の 3.3 節） |
| `view_scope` | `scope` の値で選ぶ：`personal` は `user:<owner_id>`、`team` は `team:<team_id>`、`workspace` は `members` | `View`（[views-and-filters.md](views-and-filters.md) の 7.1 節） |

- **`teams` を行の中の集合から読まない。** 行の `set<ref:Team>` のフィールドからグループを決めると、行は全部のチームのグループに届き、公開のチームの人にも非公開のチームの ID が届く（ADR-0004 の分離に反する）。つながりはチームごとの結び付けのモデル（`ProjectTeam`、それぞれのチームのグループ）に分け、Writer は結び付けの行の作成・削除の同じトランザクションで、親の行（`Project`）と `via` で依存する行の `sync_groups` を計算し直し、`groups_before` 付きの `update` を書く（ADR-0033、[ADR-0003](../decisions/0003-bootstrap-and-partial-sync.md) の 2026-09-28 の注記）。
- 1 つの行が 2 つ以上のグループの和に入る規則（`via` の 2 つの参照、`teams`、`team_row` の非公開）は、行が ID と、どのグループの読み手にも見せてよい値だけを持つことを、スキーマのレビューで確かめる（[permissions-and-teams.md](permissions-and-teams.md) の 9 節）。

- `via` の依存は、生成器が逆向きの表（参照先 → 依存するモデルとフィールド）にする。Writer は、イシューがチームを移ったとき、この表から依存の行を引いて `sync_groups` を変える（[bootstrap-and-partial-sync.md](bootstrap-and-partial-sync.md) の 7.7 節）。
- `via` の連鎖は 2 段まで（例：`Reaction` → `Comment` → `Issue`）。深い連鎖は移動の書き込みを大きくするため。
- 規則のないモデルは生成で失敗させる（ADR-0004 の Confirmation）。

### 3.6 読み込みの条件

- `partial` の `condition` は、名前の付いた条件から選ぶ。条件ごとに、サーバーの SQL の述語と、クライアントの被覆の鍵の接尾辞（例：`:active`）を生成器が持つ。
- S1 の条件は `issue_active_30d`（未完了、または完了・取り消しから 30 日以内。ADR-0003 の仮の値）だけ。

### 3.7 `include`

- `include` は被覆の鍵の雛形の列である。`IssueDescription:id` は「この行と同じ ID の本文」、`Comment:issue_id` は「この行の ID を `issue_id` に持つコメント」を表す。
- 本家の解析にある、参照を 3 段までたどる読み方は採らない（ADR-0012）。読み込みの量を定義から読めるようにするため。

## 4. 生成するもの

ADR-0019。

| 出力 | 中身 | 使う場所 |
| --- | --- | --- |
| DB の望む形 | 表、列、`workspace_id` を先頭にした主キーと索引、RLS のポリシー（`FORCE`）、共通の列（`created_at`・`updated_at`・`updated_sync_id`・`sync_groups`・`field_sync_ids`・`archived_at`、`trash` のモデルは `trashed_at`。[data-model.md](data-model.md) の 2.4 節） | マイグレーションの差分の検査（4.2 節） |
| `packages/model` | TypeScript の型、Zod の検証、`applyOp` の表、`groupsOf`、`via` の逆向きの表、`derive` の登録、`on_delete` の表 | Writer とクライアントで同じコード（ADR-0001） |
| クライアントの構成 | IndexedDB の store と索引、M2 の列の並び、`schema_version`、`schema_hash`、被覆の鍵の生成と解析 | 保存の層、プール |
| Sync API の構成 | 被覆の鍵の検証、`partial` の条件の SQL | ブートストラップ、遅延の読み込み |
| GraphQL の型 | `api: public` のモデルとフィールドの object の型と列挙 | 公開 API（形の細部は api-and-webhooks の領域） |
| 参照の文書 | モデルとフィールドの一覧、競合の種類、同期グループ | 開発リポジトリの文書 |

### 4.1 生成の検査（失敗させるもの）

| # | 条件 |
| --- | --- |
| 1 | フィールドに `conflict` がない |
| 2 | 型と `conflict` の組み合わせが 3.3 節の表にない |
| 3 | `order` に `order_scope` がない。`order_scope` のフィールドが同じモデルにない |
| 4 | モデルに `groups`・`load`・`delete` がない。`partial` に `condition` がない |
| 5 | `ref`・`set<ref>` に `on_delete` がない。`string` に `max` がない。`set` に `max` がない |
| 6 | `via` の連鎖が 3 段以上、または循環する |
| 7 | `include` の鍵が、参照先のモデルの `index` のフィールドでない |
| 8 | `schema_hash` が変わったのに `schema_version` が上がっていない（[client-store-and-offline.md](client-store-and-offline.md) の 6.1 節） |
| 9 | 破壊の変更（6.2 節）が、同じ PR の中で広げる段を経ていない |
| 10 | `crdt_doc` のフィールドが本文のモデルの外にある、または 1 つのモデルに 2 つある |
| 11 | `groups` が `workspace` の規則のモデルに `guest_visible` がない |
| 12 | `teams` の規則の `from` が結び付けのモデルのフィールドでない（自分の行の集合を指す） |
| 13 | `derive_only` が `counter` でないフィールドにある。`import_writable` が `server_only` でないフィールドにある |
| 14 | `m2` のフィールドと、`packages/filter` に登録したフィールドの M2 の列（[views-and-filters.md](views-and-filters.md) の 3.2 節）が食い違う（登録にあるのに `m2` でない、型が違う） |

### 4.2 マイグレーション

- 生成器は DB の「望む形」を出す。マイグレーションのファイルは生成器が差分から下書きし、人がレビューして開発リポジトリに置く。
- CI は、空の DB に全マイグレーションを当てた結果と、望む形を比べ、ずれがあれば失敗させる。自動の差分の適用はしない。列の削除や型の変更は、データを壊すので人の判断を挟む。
- 新しい表に `workspace_id` と RLS のポリシーがなければ失敗させる（ADR-0004）。

### 4.3 手で書くもの

- `can()`（permissions-and-teams の領域）、`derive` の中身（各領域）、`upcast`（outbox の形の変換）、手元の行の移行の関数は、手で書く。生成器は、それらが登録されていることを確かめる。

## 5. ID と人が読む識別子

ADR-0020。

### 5.1 モデルの ID

- すべてのモデルの ID は UUIDv7。クライアントが振る（ADR-0002）。サーバーが作る行（履歴、購読、派生の行）も Writer が UUIDv7 で振る。
- Writer の検証：版の 4 ビットが 7 で、変種が RFC 9562 のもの。時刻の部分が今より 1 日以上先なら `invalid`（[sync-engine.md](sync-engine.md) の 5.4 節）。過去の側は制限しない（長いオフラインで作った行を受けるため）。
- ID の時刻の部分は、作った時刻の目安として並べ替えに使ってよいが、正しさの判断に使わない。`created_at` は Writer が確定の時刻で書く（`server_only`）。

### 5.2 チームの識別子

- `teams.key`：`^[A-Z][A-Z0-9]{0,6}$`（1〜7 文字）。ワークスペースの中で一意（大文字・小文字を区別しない）。本家の制約は**未検証**で、この値は本システムの決定である。
- 識別子を変えたら、古い識別子を `team_key_aliases` に残す。同じワークスペースの別のチームが、他のチームの古い識別子を新しい識別子に使うことは拒否する（古い識別子の参照が別のチームを指さないように）。

### 5.3 イシューの番号

- `teams.next_issue_number` から、Writer が `create Issue` を当てる時に振る。`number` は `server_only`。
- Writer はワークスペースの行を最初にロックしている（ADR-0006）ので、チームの数の行で別の競合は起きない。番号の順は確定の順である。
- 番号は再利用しない。イシューを削除・移動しても、その番号は空いたままにする。
- クライアントは ack の `server_ops` で番号を受ける。ack までは仮の表示（`ENG-…`）にする（ADR-0002）。オフラインで作ったイシューも同じ。
- 本文の中の参照（メンション）は、識別子ではなく ID で持つ（[editor-and-descriptions.md](editor-and-descriptions.md) の 6 節）。仮の間に参照を作っても、確定の後に正しい識別子で描ける。

### 5.4 チームの移動と別名

```sql
CREATE TABLE issue_aliases (          -- モデル IssueAlias。共通の列（updated_sync_id など）は生成で足す
  workspace_id  uuid    NOT NULL,
  id            uuid    NOT NULL,     -- モデルの ID（UUIDv7。Writer が振る）
  team_id       uuid    NOT NULL,     -- 移動の前のチーム
  number        bigint  NOT NULL,     -- 移動の前の番号
  issue_id      uuid    NOT NULL,
  sync_groups   text[]  NOT NULL,     -- 今のイシューのグループ（移動のたびに直す）
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, team_id, number)
);
CREATE TABLE team_key_aliases (
  workspace_id  uuid NOT NULL,
  key           text NOT NULL,        -- 大文字に正規化
  team_id       uuid NOT NULL,
  PRIMARY KEY (workspace_id, key)
);
```

- イシューを別のチームへ移すと、Writer は同じトランザクションで、移った先の番号を振り、前の `(team_id, number)` を `issue_aliases` に書く（本家と同じく、新しい識別子にし、古い識別子で引けるようにする）。
- 別名の行（`IssueAlias` のモデル、`lazy`。イシューの `include` で一緒に読む）は、今のイシューの同期グループに属する（`via`）。前のチームのメンバーでも、今のイシューを見てよくない人には、別名も届かない。
- `resolve(key, number)` の順：今の識別子のチーム → `team_key_aliases` のチーム → そのチームの `(team_id, number)` のイシュー → `issue_aliases`。クライアントは手元の M2 と手元の別名で引き、なければ Sync API の `GET /sync/resolve?ref=ENG-123`（同期グループで絞る。見てよくないものは `404`）で ID を得て、`Issue:id=<id>` を読み込む。
- URL は `/<workspace-slug>/issue/<KEY>-<number>`。タイトルを URL に入れない。古い識別子の URL は今の URL へ転送する。仮の番号のイシューは `/<workspace-slug>/issue/<uuid>` で開ける。

## 6. スキーマの版と後方互換

ADR-0019。

### 6.1 3 つの版

| 版 | 何を表すか | 上げる時 | 使う場所 |
| --- | --- | --- | --- |
| `schema_version` | クライアントが見る形（store・索引・行の形）の整数の版 | `schema_hash` が変わった時。生成器が判定し、上げ忘れを CI で失敗させる | IndexedDB の版（[client-store-and-offline.md](client-store-and-offline.md) の 3.1 節） |
| `schema_hash` | クライアントが見る定義の正準形の JSON の SHA-256 | 自動 | 握手の互換の判定（[sync-engine.md](sync-engine.md) の 9.4 節） |
| `fv` | トランザクションの形の版 | 操作の形が変わった時（フィールドの削除・改名、型・`conflict` の変更） | outbox の変換（ADR-0005、ADR-0014） |

- Gateway は互換の一覧（今の `schema_hash` と、1 つ前のリリースの `schema_hash`）を持つ。1 つ前はリリースから 30 日受ける。`fv` の受け付けの期間（ADR-0005）と同じにする。

### 6.2 変更の分類

生成器が前のリリースの定義と比べて、変更を分類する。

| 変更 | 分類 | 古いクライアントで起きること | 必要なもの |
| --- | --- | --- | --- |
| 任意のフィールドを足す | 互換 | 知らないフィールドの付いた行を受ける。行をそのまま保存する（知らないフィールドを捨てない） | 手元の移行（既定値で埋める） |
| モデルを足す | 互換 | 知らないモデルの差分を受ける。当てずに `last_sync_id` だけ進める | 新しいクライアントは、そのモデルだけを取り直す（[client-store-and-offline.md](client-store-and-offline.md) の 6.2 節） |
| 列挙の値を足す | 互換 | 知らない値を受ける。「不明」として描き、書き換えない | 生成したコードは知らない値で落ちない |
| 索引・`m2`・`search` を変える | 互換 | 影響なし | 手元の移行（索引の張り直し） |
| 必須のフィールドを足す | 破壊 | 古いクライアントの `create` にその値がない | `default` を必須にすれば互換として扱う |
| フィールドの削除・改名、型・`conflict` の変更 | 破壊 | 古い操作の形が合わない | 広げてから縮める（6.3 節）と `fv` の変換 |
| `groups` の規則の変更 | 破壊 | 行の配り先が変わる | 全行の `sync_groups` の計算し直しと移動の差分。別の ADR が要る |
| 本文のスキーマにノード・装飾・属性を足す | 破壊 | y-prosemirror が知らない要素を共有の文書から消し、消した更新が全員に届く | 読める版を出す → `min_build` をその版まで上げる → 作る操作のフラグを開く（[editor-and-descriptions.md](editor-and-descriptions.md) の 3.2 節、ADR-0057） |
| `load` の変更 | 互換 | 次のブートストラップから効く | なし |

### 6.3 広げてから縮める

1. **広げる**：新しいフィールドを足す。Writer の `derive` で、古いフィールドへの操作を新しいフィールドにも写す（両方を書く）。既存の行は Worker が埋める（`origin = worker`、500 件ずつのシステムのトランザクション）。
2. **移る**：クライアントを新しいフィールドを使う版にする。`upcast` で古い形の outbox を新しい形へ変換する。
3. **縮める**：古い `schema_hash` が互換の一覧から外れた後（30 日）、古いフィールドを消す。

- `conflict` の種類を同じフィールドのまま変えることはしない。新しいフィールドにする。

## 7. 障害と誤りのときの振る舞い

| 事象 | 起きること | 備え |
| --- | --- | --- |
| クライアントとサーバーで `applyOp` が違う | 画面の値が差分で正されるまでずれる | 同じ生成のパッケージを使うことを依存の検査で確かめる（ADR-0008 の Confirmation）。版の違いは互換の一覧で弾く |
| 生成したマイグレーションと本番の DB がずれる | Writer の書き込みが失敗する | 4.2 節の CI の比較。デプロイの前に本番の読み取りの写しで比べる |
| 古いクライアントが知らない値を受ける | 描けない、落ちる | 6.2 節の規則（行を捨てない、「不明」と描く）を生成したコードで守り、1 つ前の版の試験で確かめる |
| 番号の数の行が壊れた（手の修正の誤り） | 番号の重なり | `(workspace_id, team_id, number)` の一意の索引で書き込みが失敗する。runbook で数を直す |
| 識別子の別名が見てよくない人に届く | 移動の前のチームの人に、今の場所が漏れる | 別名を今のイシューのグループに入れる（5.4 節）。性質ベーステスト |

## 8. セキュリティ

- 同期グループの規則（3.5 節）が、配ってよい範囲を決める。規則の誤りはそのまま漏えいになる。`via` の依存は生成器が機械で作り、手で書かない。
- `pii` の印のあるフィールドは、ログ・トレース・メトリクスに出さない（[sync-engine.md](sync-engine.md) の 11 節）。lint で、ログの呼び出しに `pii` のフィールドを渡すコードを禁止する。
- 見てよくない参照は、存在を明かさない（ADR-0004）。識別子の解決（`resolve`）も、見てよくないイシューは「ない」と同じに返す。
- 番号は連番なので、チームのイシューの数の目安が、そのチームを見られる人に分かる。見られない人には、番号も識別子も届かない。
- GraphQL の型は `api: public` のフィールドだけから作る。`internal` のフィールド（`field_sync_ids`、`sync_groups`）を出さない。

## 9. テスト

- **生成の検査**：4.1 節の各行を、わざと誤った定義で失敗させる例示テスト。
- **性質ベーステスト**：
  - **PROP-SCHEMA-001（往復）**：任意の定義から生成した Zod の検証と `applyOp` で作った行は、DB の望む形と IndexedDB の構成の両方に、欠けなく保存でき、読み戻して同じ値になる。
  - **PROP-SCHEMA-002（古いクライアントの許容）**：6.2 節の「互換」の変更を任意に重ねた定義の行を、前の版の生成のコードが受けても、例外を出さず、知らないフィールドを捨てずに保存する。
  - **PROP-SCHEMA-003（番号）**：任意の作成・移動・削除の列の後、チームの中の番号は一意で、番号も別名もイシューを 1 つだけ指す。移動の前の識別子は `resolve` で今のイシューを返す。
  - **PROP-SCHEMA-004（別名の権限）**：任意のメンバーシップと移動の列の後、クライアントの手元の `IssueAlias` は、そのクライアントが見てよいイシューを指すものだけ。
- **マイグレーションの比較**（4.2 節）を CI の必須のチェックにする。
- **1 つ前の版の試験**：1 つ前のリリースの生成のコードを持つクライアントを、今のサーバーにつなぎ、差分とトランザクションを往復させる（[client-store-and-offline.md](client-store-and-offline.md) の 11.1 節の「古い版の outbox」の場面と一緒に回す）。

## 10. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E1 | `schema-dsl` | 3 節の定義の言語と、型・`conflict` の組み合わせの検査 |
| E1 | `schema-conflict-kinds` | `conflict`・`order_scope`・`track_overwrites`・`groups` の必須化（[sync-engine.md](sync-engine.md) の 13 節と同じ Story） |
| E1 | `schema-load-strategy` | `load`・`condition`・`include`・被覆の鍵の生成（[bootstrap-and-partial-sync.md](bootstrap-and-partial-sync.md) の 12 節と同じ Story） |
| E1 | `codegen-db-desired-state` | DB の望む形、RLS のポリシー、マイグレーションの差分の検査 |
| E1 | `codegen-model-package` | `packages/model`（型、Zod、`applyOp`、`groupsOf`、`via` の逆向きの表） |
| E1 | `codegen-client-layout` | IndexedDB の構成、M2 の列、`schema_version`・`schema_hash` |
| E1 | `schema-change-classifier` | 6.2 節の分類と、破壊の変更の CI の検査 |
| E2 | `uuidv7-validation` | 5.1 節の検証 |
| E4 | `team-key` | 5.2 節のチームの識別子と `team_key_aliases`（permissions-and-teams と共同） |
| E5 | `issue-numbering` | 5.3 節の番号と、ack の `server_ops` での番号の受け取り、仮の表示 |
| E5 | `issue-team-move` | 5.4 節の移動、別名、`resolve`、URL の転送（issues-and-workflow の同名の Story と 1 つ） |
| E11 | `codegen-graphql-types` | GraphQL の型の生成（api-and-webhooks と共同） |
| E12 | `schema-compat-drill` | 1 つ前の版のクライアントとの往復の試験を、リリースの前の必須にする |

## 11. 未解決の問い

- 定義の言語を TypeScript の宣言にするか、独自の DSL（別のファイルの形式）にするか。
- マイグレーションを自動で当てるか、人のレビューを挟むか。
- チームの識別子の長さと文字の制約。
- 古いクライアントが知らないモデルの差分を、保存するか捨てるか。
- 移動の前のチームを見られる人に、「移動した」ことだけを見せるか。

### 決定

2026-09-28 の既定案。E1・E2 の実装で覆りうる。

- **定義の言語**：`packages/schema` の TypeScript の宣言（`model()`）。型の補完が効き、同じ言語で生成器を書ける。独自の DSL は、構文解析と編集の道具の費用に見合わない（ADR-0019）。
- **マイグレーション**：生成器は望む形と下書きを出し、人がレビューする。CI で望む形とのずれを失敗させる（ADR-0019）。
- **チームの識別子**：`^[A-Z][A-Z0-9]{0,6}$`。変えたら古い識別子を別名に残し、他のチームに使わせない（ADR-0020）。
- **知らないモデルの差分**：当てずに捨て、`last_sync_id` だけ進める。新しい版に上げた時にそのモデルを取り直す。
- **移動の知らせ**：見てよくない人には何も見せない。前のチームのビューからは消えるだけにする（ADR-0004 の「存在を明かさない」に合わせる）。
- **番号の再利用**：しない（ADR-0020）。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| `update` の行の全体で、モデルの数十種の中に大きな行（`json` のフィールド）があるか | E2 で行の大きさを測る（[sync-engine.md](sync-engine.md) の 14 節と同じ） |
| `groups` の規則の変更（破壊）を、どの手順で行うか | 初めて必要になった時に ADR を書く |
| 本家のチームの識別子の制約、識別子の変更での古い識別子の扱い | 公式の資料では確かめられない（**未検証**のまま） |

## 12. quality.md・runbooks・data-model への項目

### quality.md

- 生成の検査（4.1 節）と、マイグレーションの比較を、E1 からの CI の必須のチェックにする。
- 1 つ前の版のクライアントとの往復の試験を、スキーマを変えるリリースの基準にする。
- 本番：`schema_hash` ごとの接続の数。互換の一覧から外れる前に、古い版の接続が 1% 未満になっていること。
- 本番：`invalid`（型・範囲）の拒否の率。上がったらクライアントとサーバーの定義のずれを疑う。

### runbooks

- `schema-expand-contract.md`：破壊の変更の 3 段（広げる・移る・縮める）の進め方と、縮める前の確認（古い `schema_hash` の接続の数、outbox の古い `fv` の報告）。
- `issue-number-repair.md`：チームの番号の数が実際の最大の番号より小さくなったとき（手の修正の誤り、復元）の直し方。

### data-model（索引への追加の提案）

2026-09-28 に [data-model.md](data-model.md) と [data-model/](data-model/) へ反映した。

| 表・置き場所 | 中身 | 節 |
| --- | --- | --- |
| `packages/schema` | モデルの定義（正本） | 3 |
| モデルの表の共通の列 | `workspace_id`、`id`（UUIDv7）、`created_at`、`updated_sync_id`、`sync_groups`、`field_sync_ids`、`archived_at` | 4 |
| `teams.key`・`teams.next_issue_number` | チームの識別子と、次の番号 | 5.2、5.3 |
| `issue_aliases`（`IssueAlias`） | 移動の前の識別子 → イシュー | 5.4 |
| `team_key_aliases` | チームの古い識別子 → チーム | 5.4 |
| `schema_versions`（開発リポジトリ） | リリースごとの `schema_version`・`schema_hash`・`fv` と互換の一覧 | 6.1 |

## 出典

いずれも 2026-09-28 に確認。

- Linear Docs, [Create issues](https://linear.app/docs/creating-issues)、[Edit issues](https://linear.app/docs/editing-issues)
- 第三者の解析：[wzhudev/reverse-linear-sync-engine](https://github.com/wzhudev/reverse-linear-sync-engine)
- IETF, [RFC 9562: Universally Unique IDentifiers (UUIDs)](https://www.rfc-editor.org/rfc/rfc9562)（UUIDv7 の形）

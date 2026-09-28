# Views and Filters: Linear

フィルターの言語、グループ化と並べ方、一覧とボード、保存したビュー（個人・チーム・ワークスペース）、共有を決める。フィルターは、クライアントの手元（M2）とサーバー（SQL）で同じ結果を返す。手元にないデータを含むビューは、被覆の鍵で判定し、サーバーの問い合わせで補う。

前提となる決定は、読み込みの方針と同期グループ（[ADR-0003](../decisions/0003-bootstrap-and-partial-sync.md)）、非公開のチーム（[ADR-0004](../decisions/0004-tenancy-and-permissions.md)）、被覆の鍵（[ADR-0012](../decisions/0012-lazy-loading-coverage-and-tombstones.md)）、メモリーの 3 層（[ADR-0016](../decisions/0016-memory-tiers-quota-and-offline-ux.md)）、描画の経路（[ADR-0018](../decisions/0018-render-path-and-latency-budget.md)）、定義の言語（[ADR-0019](../decisions/0019-schema-definition-and-codegen.md)）。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0028](../decisions/0028-filter-language-and-shared-evaluation.md) | フィルターは型の付いた JSON の木で持つ。共有のパッケージの 1 つの定義から、クライアントの評価の関数（M2 の列の上）と、サーバーの SQL の生成を作る。空の値、文字の正規化、並びの比較（符号位置の順）を言語の側で決める。両者の一致は、共有のテストの例の集まりと、無作為のフィルターの差分テストで確かめる |
| [0029](../decisions/0029-view-coverage-planner-and-server-query.md) | ビューを開くと、計画の関数が、フィルターと手元の被覆の鍵から「手元だけ」「手元とサーバー」「サーバー」を決める。サーバーは同じ SQL を同期グループで絞って行を返し、クライアントはそれを候補として手元に足し、同じ評価の関数で並べる。保存したビューは範囲ごとに同期グループを持ち、フィルターが参照する ID は、ビューを見る全員が見てよいものに限る |

## 1. 目的と範囲

- 扱う：
  - フィルターの言語（文法、フィールド、演算子、値、空の値の意味、動的な値）
  - クライアントの評価（M2 の上、増分）とサーバーの評価（SQL）、その一致の試験
  - グループ化、下位のグループ化、並べ方、完了したイシューの表示の窓、サブイシューの表示
  - 一覧とボードの意味（ボードの列の間の移動が何の変更になるか）
  - 保存したビュー（`View`）と個人の表示の設定（`ViewPreference`）、共有、URL
  - 手元にないデータを含むビューの計画と、サーバーの問い合わせ（`POST /sync/query`）
- 扱わない：
  - 仮想化、行の描画、キーボード（[client-app.md](client-app.md) の 8 節）
  - M2 の列の保持と追い出し（[client-store-and-offline.md](client-store-and-offline.md) の 7 節）
  - 全文検索（[search.md](search.md)）。ビューの中の「タイトルに含む」は、この文書のフィルターで扱う
  - 公開 API のフィルターの形（[api-and-webhooks.md](api-and-webhooks.md)。同じ木を GraphQL の入力の型に写す）
  - ロードマップ、タイムラインの表示（MVP の後）

## 2. 本家の形（確かめたこと）

いずれも公式の文書。2026-09-28 に確認。

| 項目 | 内容 | 出典 |
| --- | --- | --- |
| フィールド | 担当、状態、ラベル、プロジェクト、サイクル、チーム、優先度、作った人、購読者、マイルストーン、日付、外部のリンクなど | [Filters](https://linear.app/docs/filters) |
| 演算子 | 1 つの値のフィールドは「is・is not」、複数の値は「is either of・is not」、ラベルとリンクは「includes any・all・neither・either・none」、日付は「before・after」 | 同上 |
| AND・OR | 高度なフィルターで、条件の組を AND・OR で組み合わせ、入れ子にできる | 同上 |
| URL | 付けたフィルターはブラウザの URL に反映される | 同上 |
| 制限 | マイルストーンで絞るには、先にプロジェクトを選ぶ。「ラベルなし」は全部のラベルを選んで演算子を反転する | 同上 |
| ビューの範囲 | ワークスペースのビュー（全メンバー）、チームのビュー、文脈のビュー。持ち主（既定は作った人） | [Custom views](https://linear.app/docs/custom-views) |
| 共有 | リンクを共有しても、見る権限は与えない | 同上 |
| 表示 | 一覧とボード。状態・担当・プロジェクト・優先度・サイクル・ラベルなどでグループ化、下位のグループ化、並べ方（状態、優先度、作成日、手動など）、サブイシューの表示、空のグループの表示。個人の設定か、「既定にする」でワークスペースの既定 | [Display options](https://linear.app/docs/display-options) |
| ゲスト | ワークスペースのビューを見られない | [Members and roles](https://linear.app/docs/members-roles) |

- フィルターの条件の数・入れ子の深さの上限、空の値の扱い（「is not」が空を含むか）は、文書に書かれていない（**未検証**）。本システムの決定は 3 節。
- 本家がクライアントとサーバーで同じ評価を持つかは、公開の資料では分からない（**未検証**）。

## 3. フィルターの言語

ADR-0028。

### 3.1 文法

```
Filter  := { "and": [Filter, …] }       // 1〜20 要素
         | { "or":  [Filter, …] }       // 1〜20 要素
         | { "not": Filter }
         | Cond
Cond    := { "f": Field, "op": Op, "v"?: Value }
Value   := Scalar | [Scalar, …]          // 配列は 100 要素まで
Scalar  := string | number | boolean | null | Dyn | Rel
Dyn     := { "dyn": "me" | "current_cycle" | "previous_cycle" | "next_cycle" | "today" }
Rel     := { "rel": "<ISO 8601 の期間。符号付き>" }   // 例 "-P7D"：今から 7 日前
```

- 上限：入れ子の深さ 5、条件（`Cond`）の数 50、JSON の大きさ 8 KiB。超えたら `invalid`（保存のとき Writer が、問い合わせのとき Sync API が拒否する）。
- 正準の形：`and`・`or` の 1 要素は中身に畳む。`not` の `not` は消す。同じ要素の重複は 1 つにする。保存の前にクライアントで正準にし、Writer は正準であることを確かめる（URL と比較を安定させるため）。
- 型の検査：フィールドと演算子と値の型の組み合わせは 3.3 節の表で決める。表にない組み合わせは `invalid`。

### 3.2 フィールド（`Issue`）

「手元」の列が M2 のものは、手元で評価できる。「サーバー」のものは、手元で評価できないので、ビューは 6 節のサーバーの経路になる。

| `f` | 型 | 手元 | 意味 |
| --- | --- | --- | --- |
| `team` | ref | M2 | `team_id` |
| `state` | ref | M2 | `state_id` |
| `state_type` | enum | M2 | 状態の種類（`triage`〜`duplicate`）。`state_id` から手元の `WorkflowState` で引く |
| `assignee` | ref | M2 | `assignee_id` |
| `creator` | ref | M2 | `creator_id` |
| `priority` | enum | M2 | `0`〜`4` |
| `labels` | set | M2 | `label_ids` |
| `label_group` | ref | M2 | 付いているラベルのグループ（`label_ids` から手元の `IssueLabel` で引く） |
| `estimate` | int | M2 | — |
| `cycle` | ref | M2 | `cycle_id` |
| `project` | ref | M2 | `project_id` |
| `milestone` | ref | M2 | `project_milestone_id`。本家と違い、プロジェクトを先に選ぶ必要はない |
| `parent` | ref | M2 | `parent_id` |
| `due_date` | date | M2 | — |
| `created_at`・`updated_at`・`started_at`・`completed_at`・`canceled_at` | timestamp | M2 | — |
| `title` | text | M2（`title_norm`） | 正規化した文字の部分一致 |
| `subscribers` | set | サーバー | `subscriber_ids`（M2 に持たない。人の数が多く、列が大きい） |
| `has_blocking`・`has_blocked_by`・`has_duplicate` | bool | サーバー | 関連は遅延のモデル（`IssueRelation`） |
| `archived` | bool | M2 | アーカイブ済み。既定のフィルターは `false`（4.4 節） |

- `state_type`・`label_group` のように、手元の別のモデル（`instant`）で引くフィールドは、評価の前の「解決」の段（3.5 節）で ID の集合に直す。評価の関数は ID の比較だけを行う。
- 新しいフィールドは、`packages/filter` の登録（型、M2 の列、SQL の式）を足すまで使えない。モデルの定義の `m2` の印と登録が合わないと、生成で失敗させる。
- `Project` の一覧にも同じ言語を使う。フィールドは `status`・`status_type`・`lead`・`members`・`team`・`initiative`・`start_date`・`target_date`・`health`・`name`。プロジェクトは `instant` なので、常に手元で評価できる。

### 3.3 演算子

| 型 | 演算子 | 値 |
| --- | --- | --- |
| ref・enum | `eq`・`neq` | 1 つ（`null` 可） |
| ref・enum | `in`・`nin` | 配列 |
| ref・enum・int・date・timestamp | `is_null`・`not_null` | なし |
| set | `any`（どれかを含む）・`all`（全部を含む）・`none`（どれも含まない） | 配列 |
| set | `empty`・`not_empty` | なし |
| int | `eq`・`neq`・`lt`・`lte`・`gt`・`gte` | 数 |
| date・timestamp | `before`・`after`・`on_or_before`・`on_or_after` | 絶対（ISO 8601）、`Rel`、`Dyn` の `today` |
| text | `contains`・`not_contains` | 文字（1〜200 字） |
| bool | `eq` | 真偽 |

### 3.4 空の値の意味

DT-FILTER-001。値のないフィールド（`null`、空の集合）に対する結果。SQL の三値の論理に任せず、言語の側で真か偽に決める。

| 演算子 | フィールドが空 | SQL の書き方 |
| --- | --- | --- |
| `eq v`・`in [..]`（`null` を含まない） | 偽 | `x = $v`、`x = ANY($a)` |
| `eq null`・`is_null` | 真 | `x IS NULL` |
| `neq v`・`nin [..]` | **真** | `x IS DISTINCT FROM $v`、`NOT (x = ANY($a)) OR x IS NULL` |
| `in [.., null]` | 真 | `x = ANY($a) OR x IS NULL` |
| `any`・`all` | 偽（`all []` は真） | `x && $a`、`x @> $a` |
| `none` | 真 | `NOT (x && $a)` |
| `lt`・`before` など比較 | 偽 | `x < $v`（`NULL` は偽と同じに扱うため、`not` の中では `COALESCE(x < $v, false)`） |
| `contains` | 偽 | 4.2 節 |
| `not_contains` | 真 | `NOT COALESCE(…, false)` |

- 「担当が Alice でない」に担当なしを含めるのは、画面の言葉（「is not」）の素直な読みに合わせるため。本家の振る舞いは**未検証**。
- `not` は子の結果の否定。子は必ず真か偽を返す（上の `COALESCE`）ので、`not` の結果も定まる。SQL の生成は、比較の式をすべて `COALESCE(式, false)` で包む。

### 3.5 評価の文脈と解決

```ts
type EvalContext = {
  now: string;        // ISO 8601 UTC。問い合わせの時刻
  tz: string;         // 見る人のタイムゾーン（IANA）
  me: string;         // 見る人の User の ID
};
```

- **解決**：評価の前に、`Dyn`・`Rel`・引きのフィールド（`state_type`・`label_group`）を具体の値に直す。
  - `me` → `ctx.me`。
  - `current_cycle` → チームごとの `active` のサイクルの ID の集合。`cycle eq {dyn: current_cycle}` は `cycle in [各チームの今のサイクル]` になる。
  - `today` → `ctx.tz` の今日の日付。`Rel` → `now + 期間` の時刻（`timestamp`）か、`today + 期間` の日付（`date`）。
  - `state_type in [started]` → `state in [started の種類の全状態の ID]`。
- 解決は共有のパッケージの 1 つの関数 `resolveFilter(filter, ctx, lookups)` で行う。`lookups` は、クライアントでは手元の `instant` のモデル、サーバーでは同じモデルの SQL の読み出し。解決の後の木には `Dyn`・`Rel`・引きのフィールドが残らない。
- サーバーの問い合わせでは、クライアントが解決の後の木と `ctx` を送る。サーバーは解決し直さず、送られた ID の集合を使う。ただし、ID は見てよいものに限る（7 節）。これで、両者の今のサイクルの判定のずれ（時計、境界の直後）が結果に出ない。
- `tz` は見る人のもの。同じ保存したビューでも、「今日が期日」は人ごとのタイムゾーンで決まる。

## 4. 評価

ADR-0028。

### 4.1 クライアント（M2）

- 解決した木を、M2 の列の配列の上の述語 `(row: number) => boolean` に組み立てる（評価のたびに木をたどらない）。
- 集合（ラベル）は、M2 の中で行ごとの整数の配列（ラベルの ID を手元の番号にしたもの）で持つ。`any`・`all`・`none` は小さな配列の照合にする。
- **増分の評価**：ビューは、条件に合う行の ID を、並びの順の配列で持つ。差分で行が変わったら、その行だけを評価し直し、前の位置から外し、二分探索で新しい位置に入れる。全件を並べ直さない（[client-app.md](client-app.md) の 4.1 節）。
- 解決に使ったモデル（状態、サイクル、ラベル）が変わったら（例：今のサイクルが替わった）、解決からやり直し、全件を評価し直す。これは入力の経路の外（次のフレーム以降）で行う。

### 4.2 文字の一致

- `title contains q`：`norm(title)` が `norm(q)` を部分文字列として含む。
- `norm` は共有のパッケージの `normalizeForSearch`：NFKC → 英字の小文字化 → カタカナをひらがなに寄せる → 連続する空白を 1 つにする（[client-app.md](client-app.md) の 6 節のコマンドメニューの照合、[search.md](search.md) の 5.1 節と同じ関数）。
- M2 の `title_norm` はクライアントが同じ関数で作る。サーバーは、Writer が `issues.title_norm`（サーバーだけの列。同期しない）を同じ関数で書く。SQL は `strpos(title_norm, $q_norm) > 0`。PostgreSQL の正規化の関数を使わないのは、Unicode の版の違いで結果がずれうるため。
- `issues.title_norm` の索引は張らない（ビューの問い合わせは他の条件で絞った後に走査する）。全文の検索は [search.md](search.md) で扱う。

### 4.3 並べ方

- 並べ方は `order: [{f, dir}]`（1〜3 個）。最後に必ず `id` の昇順を足し、同じ値の行の順を決める。
- 比較の規則（DT-FILTER-002）：

| 型 | 比較 | SQL |
| --- | --- | --- |
| 数・時刻・日付 | 数の大小 | そのまま |
| 文字 | **Unicode の符号位置の順** | `COLLATE "C"`（UTF-8 のバイト順は符号位置の順と同じ） |
| `priority` | 1・2・3・4・0 の順（なしは最後。[issues-and-workflow.md](issues-and-workflow.md) の 5 節） | `CASE` の式 |
| 状態 | 種類の順、同じ種類の中は `position` | 状態の表の結合 |
| 参照（担当、プロジェクト） | 参照先の名前の符号位置の順、次に参照先の ID | 結合 |
| 手動（`manual`） | `sort_key` のバイト順 | `COLLATE "C"` |
| 空の値 | 向きにかかわらず最後 | `NULLS LAST` を向きごとに書く |

- JavaScript の文字の `<` は UTF-16 の単位で比べるので、BMP の外の文字（絵文字）で符号位置の順とずれる。クライアントは共有の `cmpCodepoint` を使い、`<` と `localeCompare` を lint で禁止する（並べ方のコードで）。
- 名前で並べる参照（担当の名前）は、名前の変更で並びが変わる。名前の変更の差分で、そのフィールドで並べているビューは並べ直す（4.1 節の「解決からやり直し」と同じ扱い）。

### 4.4 既定の条件

ビューの条件に、次を AND で足してから評価する（利用者の木には書かない）。

| 条件 | 既定 |
| --- | --- |
| ゴミ箱 | 含めない（`trashed_at is_null`） |
| アーカイブ | 含めない。表示の設定 `show_archived` で含める |
| 完了の窓 | 表示の設定 `completed: all｜day｜week｜month｜none`。`month` なら「種類が `completed`・`canceled`・`duplicate` のものは、完了・取り消しが 30 日以内」 |
| サブイシュー | 表示の設定 `sub_issues: show｜hide`。`hide` なら `parent is_null` |

- 完了の窓の `month` を 30 日とするのは、部分のブートストラップの条件（`issue_active_30d`）と同じ長さにし、既定のビューを手元だけで答えられるようにするため（6.2 節）。本家の「past month」の長さは**未検証**。

## 5. グループ化・ボード

### 5.1 グループ化

- `group_by` と `sub_group_by` は、`status`・`assignee`・`project`・`priority`・`cycle`・`labels`・`label_group:<id>`・`team`・`parent`・`milestone`・`none` から選ぶ。
- グループの順は 4.3 節の比較と同じ規則。空のグループ（担当なし、プロジェクトなし）は最後。
- `labels` でグループ化すると、ラベルを 2 つ持つイシューは 2 つのグループに出る（同じ ID の行が 2 回）。`label_group:<id>` なら、グループの排他（[issues-and-workflow.md](issues-and-workflow.md) の 6.1 節）で 1 つにだけ出る。
- `show_empty_groups`：真なら、候補の全部（そのチームの全状態、全優先度）を空でも出す。担当・プロジェクトは候補が多いので、空のグループを出さない。

### 5.2 ボードの列の間の移動

DT-VIEW-002。カードを別の列（グループ）へ移したときに作るトランザクション。

| `group_by` | 作る操作 | できない場合 |
| --- | --- | --- |
| `status` | `set state_id` | Duplicate の列へは移せない（`workflow_violation`） |
| `assignee`・`project`・`cycle`・`priority`・`milestone`・`team` | 同じフィールドの `set`。`team` は移動（[data-model-and-schema.md](data-model-and-schema.md) の 5.4 節） | サイクルの列へは、そのチームのサイクルだけ |
| `label_group:<id>` | 前のラベルの `remove` と新しいラベルの `add` | — |
| `labels` | 移さない（1 つの行が複数の列にあるため） | 画面は移動を受け付けない |
| `parent` | `set parent_id` | 循環は `cycle` |

- 列の中の上下の移動は、並べ方が `manual` のときだけ `sort_key` の `set` にする。他の並べ方では、列の中の位置は並べ方で決まるので、上下の移動を受け付けない。本家も、ドラッグで位置を変えるのは並べ方が Manual のときで、Manual はボードの既定である（[Display options](https://linear.app/docs/display-options)、[Board layout](https://linear.app/docs/board-layout)、2026-09-28 に確認）。本家が Manual 以外で列の中の上下の移動を断るかは書かれていない（**未検証**）。
- 1 回の移動は 1 つのトランザクション。複数選んだカードの移動は、500 操作ずつに分ける（[client-app.md](client-app.md) の 4.3 節）。

## 6. 手元にないデータを含むビュー

ADR-0029。

### 6.1 計画の関数

ビューを開くとき（とフィルターを変えたとき）、`planView(filter, display, coverage)` が経路を決める。

DT-VIEW-001。上から評価し、最初に当たった行。

| # | 条件 | 経路 |
| --- | --- | --- |
| 1 | フィルターに「サーバー」のフィールド（3.2 節）がある | `server` |
| 2 | `show_archived` が真 | `server` |
| 3 | 範囲の全チーム `t` に `Issue:team_id=t:all` の被覆がある | `local` |
| 4 | 範囲の全チーム `t` に `Issue:team_id=t:active` の被覆があり、条件が「開いている」ことを含意する（6.2 節） | `local` |
| 5 | それ以外 | `hybrid` |

- **範囲のチーム**：フィルターのトップの `and` に `team eq`・`team in` があればその集合。チームのビューならそのチーム。なければ、手元で見てよい全チーム（`_meta.groups` の `team:*`）。
- `local`：手元の評価だけで答える（NFR-001 の対象）。
- `hybrid`：手元の評価の結果をすぐに描き、「一部」と示し、サーバーに問い合わせて補う（6.3 節）。
- `server`：手元の結果も描くが、サーバーの結果がそろうまで「読み込み中」を示す。オフラインなら「オフラインのため表示できない条件があります」と示し、手元の結果だけを描く。

### 6.2 「開いている」ことの含意

- 次のどれかが、条件のトップの `and` の要素（4.4 節の既定の条件を含む）にあれば、含意するとみなす。
  - `state_type` が `triage`・`backlog`・`unstarted`・`started` の部分集合に限られる（`in`・`eq`）。
  - 完了の窓が `none`・`day`・`week`・`month`。
  - `completed_at`（と `canceled_at`）が `after` で、`now − 30 日` 以後を指す。
- 判定は構文の上の保守的なもの。含意を証明できない式（`or` の中の状態の条件など）は含意しないとみなし、`hybrid` にする。誤って `local` にすると結果が欠けるが、誤って `hybrid` にしても余計な問い合わせが増えるだけである。
- 被覆は時間で縮まない。部分のブートストラップの時に読んだ「30 日以内の完了」の行は、その後 30 日を過ぎても手元に残り、その後に完了したものは差分で届く。手元の保存の退かし（ADR-0016）は、被覆のある `partial` の行を退かさない。したがって `Issue:team_id=t:active` は「今の時点で開いているか、30 日以内に閉じた、チーム t のイシューはすべて手元にある」を保つ。

### 6.3 サーバーの問い合わせ

```
POST /sync/query
{ "workspace": "…", "model": "Issue",
  "filter": { …解決の後の木… }, "order": [{"f":"priority","dir":"asc"}],
  "ctx": { "now": "2026-09-28T01:00:00Z", "tz": "Asia/Tokyo", "me": "…" },
  "limit": 200, "cursor": null }
→ 200 application/x-ndjson
{"t":"head","as_of":18251}
{"t":"rows","m":"Issue","rows":[…行の全体…]}
{"t":"page","cursor":"…","frontier":[2,"…"]}     // 続きがあるとき。frontier は最後の行の並びの値
{"t":"end"}
```

- SQL は 3〜4 節の生成の関数で作り、`WHERE workspace_id = $ws AND sync_groups && $groups AND (フィルター)` の形にする。`$groups` は、握手と同じ関数（`groupsFor`）で求めた、呼んだ人の購読（[permissions-and-teams.md](permissions-and-teams.md) の 5 節）。RLS も効く。
- 返すのは行の全体（遅延の読み込みと同じ形）。クライアントは [bootstrap-and-partial-sync.md](bootstrap-and-partial-sync.md) の 6.3 節の規則（`_u` と墓標）で IndexedDB と M2 に書く。被覆の鍵は記録しない（フィルターの結果は被覆の単位ではないため）。
- 1 ページ 200 行、1 回の開きで 5 ページ（1,000 行）まで自動で読む。その先は「さらに読み込む」。1 回の問い合わせの SQL の時間の上限は 2 秒（`statement_timeout`）。超えたら `422 query_too_expensive` を返し、画面は条件を絞るよう示す。
- 読むのは Aurora の reader。`as_of` はその時点の `last_sync_id`。
- 同じフィルター・並べ方・`ctx.me` の問い合わせは、クライアントで 60 秒持ち、同じビューを開き直しても問い合わせない。

### 6.4 組み合わせ

- **サーバーの行は候補にすぎない。** 画面の結果は、手元の行（サーバーから足した行を含む）を、クライアントの評価の関数で評価し直したもの。サーバーの結果の集合をそのまま出さない。これで、問い合わせの後に届いた差分も同じ規則で反映され、サーバーとクライアントの評価の違いが画面に出ない。
- **境（frontier）**：サーバーの結果にページの続きがあるとき、最後に読んだ行の並びの値を境とする。画面は、境より前に並ぶ行だけを出し、境より後の手元の行は「さらに読み込む」の後ろに隠す。境より後には、まだ読んでいないサーバーの行が挟まりうるため。
- グループ化したボードで続きがあるときは、各列の件数を「N+」と示す。
- **完全さ**：最後のページを読み、手元の `last_sync_id ≥ as_of` になったら、ビューは完全である。「一部」の印を消す。
- サーバーから足した行は、M3（IndexedDB）と M2 に入る。M2 の行が増えすぎないよう、被覆のない行は、ビューを閉じて 10 分たったら M2 から外す（IndexedDB には残し、保存の退かしの対象にする）。

## 7. 保存したビュー

ADR-0029。

### 7.1 モデル

```ts
model("View", {
  groups: { rule: "view_scope" },            // 下の表
  load: { strategy: "instant" }, archivable: false, delete: { mode: "hard" },
  fields: {
    scope:     { type: "enum<personal,team,workspace>", conflict: "server_only" },
    owner_id:  { type: "ref:User", conflict: "lww", nullable: true, on_delete: "nullify" },   // nullify に合わせて nullable（2026-09-28）
    team_id:   { type: "ref:Team", conflict: "server_only", nullable: true, on_delete: "cascade" },
    model:     { type: "enum<Issue,Project>", conflict: "server_only" },
    name:      { type: "string", conflict: "lww", max: 80, pii: "content" },
    filter:    { type: "json", conflict: "lww", schema: "Filter" },
    display:   { type: "json", conflict: "lww", schema: "ViewDisplay" },
  },
});
model("ViewPreference", {
  groups: { rule: "user", from: "user_id" }, load: { strategy: "instant" }, delete: { mode: "hard" },
  fields: {
    user_id:  { type: "ref:User", conflict: "server_only", on_delete: "cascade" },
    view_key: { type: "string", conflict: "server_only", max: 128 },   // View の ID か、既定のビューの名前（"team:<id>:active" など）
    display:  { type: "json", conflict: "lww", schema: "ViewDisplay" },
    favorite: { type: "bool", conflict: "lww" },
  },
});
```

| `scope` | 同期グループ | 作れる人 | 変えられる人 |
| --- | --- | --- | --- |
| `personal` | `user:<owner_id>` | 本人 | 本人 |
| `team` | `team:<team_id>` | そのチームを見てよいメンバー | 持ち主、チームの管理者（MVP では管理者とオーナー） |
| `workspace` | `members`（`workspace_members` の規則。ゲストを除く。[permissions-and-teams.md](permissions-and-teams.md) の 6 節） | メンバー | 持ち主、管理者 |

- `view_scope` は `scope` の値でグループを選ぶ規則。data-model への項目（12 節）。`scope` を後から変えることはしない（グループの移動を避ける）。変えたいときは複製して消す。
- `display`：`{layout: list｜board, group_by, sub_group_by, order, completed, sub_issues, show_archived, show_empty_groups, fields: [...]}`。
- 個人の表示の変更は `ViewPreference` に書き、ビューそのものは変えない。「既定にする」でビューの `display` に書く（本家の「Set as default」と同じ）。
- 既定のビュー（チームの Active・Backlog・All、自分のイシュー）は行を持たない。表示の設定だけを `ViewPreference`（`view_key` が名前）に持つ。

### 7.2 参照の範囲の規則

DT-VIEW-003。`View` の `create` と `set filter` の Writer の検証。フィルターが参照する ID（チーム、ラベル、利用者、状態、サイクル、プロジェクト）ごとに、上から評価する。

| # | 条件 | 結果 |
| --- | --- | --- |
| 1 | `actor` がその ID を見てよくない | 拒否 `invalid_reference`（存在を明かさない） |
| 2 | `scope = personal` | 受け付け |
| 3 | 参照先の同期グループの読み手が、ビューの読み手を含む（参照先が `workspace`、または `team:<ビューのチーム>`） | 受け付け |
| 4 | それ以外（ワークスペースのビューが、非公開のチームのラベル・状態・イシューを参照する） | 拒否 `invalid_reference`。画面は「チームのビューか個人のビューにしてください」と示す |

- 行 4 の理由：ワークスペースのビューの `filter` は全メンバーに届く。非公開のチームの ID を入れると、そのチームがあること（と、ビューの名前に書いた中身）が、メンバーでない人に届く。ID だけの参照は ADR-0004 で許しているが、ビューは「そのチームの何かを見るためのもの」であることが名前と条件から読めてしまう。
- 公開のチームが後で非公開になった場合、既にあるワークスペースのビューはそのまま残る。フィルターの ID は残るが、結果は同期グループで絞られて空になる。非公開への切り替えの処理（[permissions-and-teams.md](permissions-and-teams.md) の 7 節）で、そのようなビューの持ち主と管理者に知らせる。

### 7.3 URL と共有

- 保存したビューの URL は `/<ws>/view/<id>`。見てよくない・ないビューは、同じ「見つかりません」を出す。リンクを共有しても権限は与えない（本家と同じ）。
- 保存していないフィルターは `?f=<base64url(正準の JSON)>` に入れる（本家と同じく URL に反映する）。2 KiB を超えたら URL に入れず、「保存してください」と示す。
- URL には ID だけが入り、名前や文字の条件（`title contains`）も入る。文字の条件は利用者が書いた中身なので、アクセスのログに URL の問い合わせの部分を書かない（observability の領域への項目）。

## 8. 障害のときの振る舞い

| 事象 | 起きること | 備え |
| --- | --- | --- |
| クライアントとサーバーの評価がずれる | サーバーから来た候補が、手元の評価で落ちる（逆はない。画面は手元の評価だけで決まる） | 6.4 節の「候補にすぎない」。落ちた数を `view_candidate_rejected` として数え、0 でなければ差分テストの例を足す |
| 計画の関数が誤って `local` にする | 結果が欠ける（古い完了のイシューが出ない） | 6.2 節の保守的な判定。PROP-VIEW-003 |
| サーバーの問い合わせが重い | 2 秒で打ち切り | `422` と、画面の「条件を絞る」の案内。遅い問い合わせの形を記録（中身の値を除く） |
| 解決の後の木の ID が古い（今のサイクルが替わった直後） | 前のサイクルで問い合わせる | 手元の評価は新しい解決で行うので、画面は正しい。候補が足りなければ次の問い合わせで補う |
| 大きな一覧（数万件）の増分の評価 | 配列の挿入のコピーが重い | 10 万件で 1 回 1ms 以内の見込み（E6 で測る）。超えればブロックに分けた配列にする |
| ビューのフィルターの形が古い（フィールドを消した） | 評価できない | フィールドの削除は広げてから縮める（[data-model-and-schema.md](data-model-and-schema.md) の 6.3 節）。縮める前に、古いフィールドを使うビューを Worker が書き換える |

## 9. セキュリティ

- **サーバーの問い合わせは同期グループで絞る。** SQL の条件に `sync_groups && $groups` を必ず入れる。条件を組み立てる関数は 1 つにし、`sync_groups` の条件のない問い合わせを作れない形にする（性質ベーステスト PROP-VIEW-004）。RLS でワークスペースを分ける（ADR-0004）。
- **フィルターの ID の検査**：問い合わせの木に、呼んだ人が見てよくない ID があれば、その条件を「どの行にも合わない」に置き換える（拒否すると、拒否の有無で ID の存在が分かるため）。
- **件数を返さない。** サーバーの問い合わせは合計の件数を返さない。ボードの列の件数も、手元にある行の数と「N+」だけにする。
- **ビューの定義の漏れ**：DT-VIEW-003 の行 4。
- **SQL の注入**：値はすべてパラメーター。フィールドと演算子は登録の表から引き、利用者の文字を SQL の識別子にしない。
- **重い問い合わせ**：`statement_timeout` 2 秒、1 人 1 秒に 5 回、ワークスペースで 1 秒に 50 回まで。
- **URL**：7.3 節。

## 10. テスト

- **共有のテストの例の集まり**（ADR-0028）：`packages/filter/vectors/*.json` に、`{dataset, ctx, filter, order, expected}` を置く。`dataset` は合成のイシュー・状態・ラベル・サイクルの行。同じファイルを、クライアントの評価（Vitest、M2 を組み立てて）と、SQL の生成（Testcontainers の PostgreSQL 18、同じ行を入れて）の両方で走らせ、`expected` の ID の並びと比べる。例は DT-FILTER-001・002 の全行、BMP の外の文字、夏時間をまたぐ `Rel`、`null` を含む `in` を含める。
- **性質ベーステスト**：
  - **PROP-VIEW-001（評価の一致）**：任意の文法に合うフィルター（fast-check で文法から生成）と任意のデータで、クライアントの評価の結果の集合と並びが、SQL の結果と等しい。失敗した例は例の集まりに足す。
  - **PROP-VIEW-002（増分と全件）**：任意の差分の列の後、増分の評価で持つ配列が、全件を評価し直して並べた配列と等しい。
  - **PROP-VIEW-003（計画の安全）**：任意の被覆とフィルターで、`planView` が `local` を返すとき、手元の行の評価の結果が、サーバーの全データの評価の結果（見てよい範囲）と等しい。
  - **PROP-VIEW-004（問い合わせの絞り込み）**：任意のフィルターで、生成した SQL が `workspace_id` と `sync_groups` の条件を含む。任意のメンバーシップで、問い合わせの結果が見てよい行だけ。
  - **PROP-VIEW-005（組み合わせの収束）**：任意の問い合わせと差分の到着の順で、`hybrid` のビューが完全になった後の結果が、`local` で全部が手元にある場合と等しい。
- **表駆動テスト**：DT-VIEW-001（計画）、DT-VIEW-002（ボードの移動）、DT-VIEW-003（参照の範囲）。
- **CI のベンチマーク**：基準のワークスペース（イシュー 50 万件、部分のブートストラップで手元 10 万件）で、ビューの切り替え、フィルターの 1 条件の追加、グループ化の変更の p99 50ms（NFR-001）。

## 11. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E8 | `filter-ast-and-validation` | 3.1〜3.3 節の文法、型の検査、正準の形、上限 |
| E8 | `filter-null-semantics` | 3.4 節と DT-FILTER-001、共有のテストの例の集まりの枠 |
| E8 | `filter-resolve` | 3.5 節の解決（動的な値、引きのフィールド） |
| E8 | `filter-eval-m2` | 4.1 節のクライアントの評価と増分（client-store-and-offline と共同） |
| E8 | `filter-sql-codegen` | 4 節の SQL の生成と、PROP-VIEW-001 の差分テスト |
| E8 | `ordering-codepoint` | 4.3 節と DT-FILTER-002、`cmpCodepoint` と lint |
| E8 | `grouping-and-board` | 5 節のグループ化とボードの移動（DT-VIEW-002。client-app と共同） |
| E8 | `view-planner` | 6.1・6.2 節と DT-VIEW-001、PROP-VIEW-003 |
| E8 | `sync-query-endpoint` | 6.3 節の `POST /sync/query`、PROP-VIEW-004 |
| E8 | `view-hybrid-merge` | 6.4 節の組み合わせと境、PROP-VIEW-005 |
| E8 | `saved-views` | 7.1 節の `View`・`ViewPreference`、範囲とグループ |
| E8 | `view-reference-scope` | 7.2 節と DT-VIEW-003 |
| E8 | `view-url-share` | 7.3 節 |
| E6 | `view-latency-bench` | 10 節のベンチマーク（client-app と共同） |
| E11 | `api-filter-input` | 同じ木を公開 API の入力の型に写す（api-and-webhooks と共同） |
| E1 | `schema-group-rules-ext` | `view_scope` と `workspace_members` の規則（data-model-and-schema と共同。roadmap で 1 つにまとめた） |

## 12. 未解決の問い

- 「is not」に空の値を含めるか。
- 文字の比較を符号位置の順にするか、日本語の読みの順（照合）にするか。
- サーバーの問い合わせの結果を、被覆として記録するか。
- ワークスペースのビューが非公開のチームを参照することを許すか。
- 完了の窓の「month」を 30 日にするか、暦の 1 か月にするか。
- 見る人のタイムゾーンで評価するか、ビューのタイムゾーンで評価するか。

### 決定

2026-09-28 の既定案。E8 の実装と試用の声で覆りうる。

- **空の値**：`neq`・`nin`・`none`・`not_contains` は空を含む。比較は空を含まない（DT-FILTER-001。ADR-0028）。
- **文字の順**：符号位置の順。日本語の読みの順は、漢字の読みを持たないので作れない。名前の並びの揺れは受け入れる（ADR-0028）。
- **被覆**：記録しない。サーバーの行は候補にすぎない（ADR-0029）。
- **非公開のチームの参照**：ワークスペースのビューでは拒否する（DT-VIEW-003。ADR-0029）。
- **完了の窓**：30 日。部分のブートストラップの条件と合わせる。
- **タイムゾーン**：見る人のもの。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| M2 の走査で、10 万件のフィルターと増分の評価が予算に収まるか | E6・E8 のベンチマーク |
| 購読者・関連で絞るビューを手元で答えるか（M2 に列を足すか） | 本番の利用の頻度を見て決める |
| `title contains` の SQL の走査が大きなワークスペースで重いか | E8 で測る。重ければ pg_bigm の索引（[search.md](search.md) の 3 節の代案）を足す ADR を書く |
| 本家の「is not」の空の扱い、条件の上限、Manual 以外のボードの列の中の移動 | 公式の資料では確かめられなかった（**未検証**のまま） |

## 13. quality.md・runbooks・data-model への項目

### quality.md

- 共有のテストの例の集まりを、クライアントと SQL の両方で CI の必須のチェックにする。PROP-VIEW-001 の差分テストを毎回 1,000 例、夜間に 10 万例。
- DT-FILTER-001・002、DT-VIEW-001〜003 の表駆動テストと、PROP-VIEW-002〜005 を E8 のリリースの基準にする。
- ビューの遅延のベンチマーク（NFR-001）を E6・E8 から CI に入れる。
- 本番：`view_candidate_rejected`（サーバーの候補が手元の評価で落ちた数）が 0 に近いこと。増えたら評価のずれを疑う。
- 本番：ビューの経路（`local`・`hybrid`・`server`）の割合と、`hybrid` が完全になるまでの時間の p95。
- 本番：`/sync/query` の p99 と `422` の率。

### runbooks

- `view-query-slow.md`：重い問い合わせの形の見つけ方（中身の値を除いた木の形）、1 つのワークスペースの問い合わせの上限の一時的な引き下げ。
- `filter-divergence.md`：`view_candidate_rejected` が増えたときの調べ方（例の再現、クライアントの版ごとの割合、評価のパッケージの版の確認）。

### data-model（索引への追加の提案）

| 表・モデル | 中身 | 節 |
| --- | --- | --- |
| `views`（`View`） | 範囲、持ち主、チーム、フィルター、表示 | 7.1 |
| `view_preferences`（`ViewPreference`） | 個人の表示の設定、お気に入り | 7.1 |
| `issues.title_norm`（サーバーだけ） | 正規化したタイトル | 4.2 |
| `packages/filter` | 文法、フィールドの登録、評価、SQL の生成、テストの例の集まり | 3、4、10 |
| data-model-and-schema への依頼（反映済み。[data-model.md](data-model.md) の 9 節） | `view_scope` の規則、M2 の列と `packages/filter` の登録の突き合わせの生成の検査 | 3.2、7.1 |

## 出典

いずれも 2026-09-28 に確認。

- Linear Docs, [Filters](https://linear.app/docs/filters)、[Custom views](https://linear.app/docs/custom-views)、[Display options](https://linear.app/docs/display-options)、[Members and roles](https://linear.app/docs/members-roles)
- PostgreSQL 18 Documentation, [Collation Support](https://www.postgresql.org/docs/18/collation.html)（`C` の照合はバイトの順で比べる）

# Service catalog and requests: ServiceNow

サービスカタログ（カテゴリ、品目）、入力の項目（変数）と表示の条件、利用できる人の条件、要求 → 要求の品目 → 実行のタスクのモデル、承認と実行のフロー、ポータルの依頼者が見られる範囲、フォームからのレコードの作成（インシデントの報告など）を決める。

前提の決定は、要求・要求の品目・実行のタスクを `task` の子のクラスにすること（[ADR-0003](../decisions/0003-table-hierarchy-and-extensible-schema.md)）、フローをバージョン付きの不変の文書にし、実行を開始の時のバージョンに固定すること（[ADR-0014](../decisions/0014-flow-dsl-and-versioning.md)）、承認を 1 回だけ反映すること（[ADR-0016](../decisions/0016-approvals.md)）、ACL の条件を SQL の述語にコンパイルできる式に限ること（[ADR-0012](../decisions/0012-acl-enforcement-at-every-exit.md)）、フィールドの型を 14 種に限ること（[ADR-0006](../decisions/0006-data-dictionary-and-field-types.md)）である。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0028](../decisions/0028-catalog-items-and-variables.md) | 品目は公開で不変のバージョンになる。変数は辞書の型に対応する 12 種と、配置の 2 種に限る。表示・必須・読み取り専用の条件は式の言語で書き、画面とサーバーで同じ評価器を使い、サーバーの評価を正とする。回答は要求の品目に、品目のバージョンに結び付けた JSON の写しとして持つ |
| [0029](../decisions/0029-request-item-task-model.md) | 1 回の申請で、要求 1 件と品目ごとの要求の品目を 1 つのトランザクションで作る。申請は依頼者の冪等のキーで 1 回だけにする。要求の品目ごとに、品目のバージョンに固定した実行のフローを動かす。要求の状態は、要求の品目の状態から決まった規則で導く |
| [0030](../decisions/0030-portal-requester-scope-and-record-producers.md) | 依頼者は、自分が依頼した・自分のための・見守りに入った要求だけを見る。変数ごとに依頼者に見せるかを持つ。他人のための申請は、品目の許可と、上長か代理の関係があるときだけ。フォームからのレコードの作成も、依頼者の主体で Record Service を通す |

この文書の決定表・性質は設計の草案である。ID は E8 の各変更の `spec.md` に移すときに確定する。

## 1. 目的と範囲

- 扱う：カタログとカテゴリ、品目とバージョン、変数と変数のまとまり、表示の条件、利用できる人の条件、申請（カート）、要求・要求の品目・実行のタスク、承認と実行のフロー、状態の導出、依頼者の見える範囲、他人のための申請、フォームからのレコードの作成、品目の画面の検索の索引への反映の約束。
- 扱わない：フローの実行の仕組み（[workflow-engine.md](workflow-engine.md)）、ポータルの見た目とテーマ（`portal-and-ui.md`）、カタログの検索（`search.md`）、価格と課金（MVP に入れない。通貨の型を持たないため。[ADR-0006](../decisions/0006-data-dictionary-and-field-types.md)）、資産の払い出し（資産管理は MVP の後）、承認の画面（ポータルの承認の一覧は `portal-and-ui.md`）。

## 2. 本家の形（確かめたこと）

| 項目 | 本家 | 出典（2026-09-28 に確認） |
| --- | --- | --- |
| 変数の型 | 添付、区切り、チェックボックス、コンテナ、日付・日時・長さ、メール、HTML、IP アドレス、ラベル、リストの選択、参照の複数選択、参照の選択、カスタム、マスク、複数行の文字列、複数の選択肢、数値の尺度、参照、依頼の対象者、リッチテキストのラベル、選択、1 行の文字列、UI ページ、URL、幅広の 1 行の文字列、はい・いいえ | [Types of service catalog variables](https://www.servicenow.com/docs/bundle/xanadu-servicenow-platform/page/product/service-catalog-management/reference/r_VariableTypes.html) |
| 要求・要求の品目・実行のタスク | 1 つの要求は 1 つ以上の要求の品目を持ち、要求の品目はそれぞれのフローを持ち、フローの中で実行のタスクを作る。すべての要求の品目が閉じると要求が閉じる | コミュニティの記事で確認（[Request - Request Item - Task Why three?](https://www.servicenow.com/community/developer-forum/request-request-item-task-why-three/m-p/2116744) など）。公式の [Service Catalog request fulfillment](https://www.servicenow.com/docs/r/servicenow-platform/service-catalog/request-fulfillment.html) は、注文で要求ができ、実行の流れで承認・タスク・完了を定めるとだけ書く。3 段の閉じ方の細部は未検証（本家の振る舞いで、設計の前提ではない） |
| 参照の絞り込み | 参照の変数の候補を、他の変数の値でスクリプトの条件により絞れる | コミュニティと二次の資料で確認。未検証（本家の振る舞いで、設計の前提ではない） |
| 利用できる人の条件 | 品目・カテゴリに「利用できる人」「利用できない人」の条件（ユーザーの条件）を付ける。両方の一覧に入る人には「利用できない人」が勝つ | [Apply user criteria to items and categories](https://www.servicenow.com/docs/bundle/zurich-servicenow-platform/page/product/service-catalog-management/task/t_AppUserCritItemsCat.html) |
| 自己解決の計測 | ポータルのフォームで、入力の内容に合うナレッジの記事を示し、記事を見て申請をやめたことを計測する | [KB0712999](https://support.servicenow.com/kb?id=kb_article_view&sysparm_article=KB0712999)（検索の結果の抜粋）。未検証（本家の振る舞いで、設計の前提ではない） |

- 本家のスクリプトの変数（UI ページ、カスタム）、HTML の変数は持たない（[ADR-0001](../decisions/0001-platform-and-stack.md)、[intent.md](../intent.md) の Non-goals）。
- 本家のテーブルの名前、変数の内部の名前は写さない（[リポジトリ共通の ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。

## 3. カタログと品目（[ADR-0028](../decisions/0028-catalog-items-and-variables.md)）

### 3.1 表

| 表 | 列 |
| --- | --- |
| `catalog` | `tenant_id`、`id`、`stable_key`、`name`、`active` |
| `catalog_category` | `tenant_id`、`id`、`catalog_id`、`parent_id`（深さ 4 まで）、`name`、`order`、`audience_id` |
| `catalog_item` | `tenant_id`、`id`、`stable_key`、`kind`（`request_item` / `record_producer`）、`draft`（編集中の定義）、`active_version_id`、`owner_group_id`、`active` |
| `catalog_item_version` | `tenant_id`、`id`、`item_id`、`version_no`、`definition`（下の 3.2 節）、`content_hash`、`fulfillment_flow_version_id`（`request_item` のとき）、`published_at`、`published_by` |
| `audience` | `tenant_id`、`id`、`name`、`include`（条件の一覧）、`exclude`（条件の一覧） |
| `variable_set` | 複数の品目で使い回す変数のまとまり。バージョンを持ち、品目の公開の時に中身を品目のバージョンへ写す |

- **品目は公開で不変のバージョンになる。** `draft` を編集し、公開すると検証（DT-CAT-001）を通して新しい `catalog_item_version` を作る。申請は、申請の時点の `active_version_id` を要求の品目に固定する。後で品目を直しても、進行中の要求の品目の変数と実行のフローは変わらない（フローのバージョンの固定と同じ考え。[ADR-0014](../decisions/0014-flow-dsl-and-versioning.md)）。
- 変数のまとまりは、品目の公開の時に中身を写す（参照しない）。変数のまとまりを直したら、使っている品目を公開し直す（画面で一覧を出す）。

### 3.2 品目の定義

```
ItemDefinition {
  name, title, description（Markdown の制限付き。HTML を受けない）, category_ids, icon
  audience_id                         ← 利用できる人（6 節）
  allow_request_for_others: bool
  quantity: { enabled, max }          ← 既定は無効
  variables: [Variable]               ← 最大 150
  ui_rules: [UiRule]                  ← 最大 100
  producer?: { table_id, field_map }  ← kind = record_producer のとき（7 節）
  fulfillment_flow_id?                ← kind = request_item のとき。公開の時に有効なバージョンに固定
  deflection_hint_query?              ← ナレッジの候補を出す検索の語の組み立て（knowledge.md の 7 節）
}
Variable { id, name（品目の中で一意、公開の後に変えない）, label, type, help, order,
           default_expr?, mandatory: bool, read_only: bool,
           choices? | ref_table? + ref_condition?,
           visible_to_requester: bool（既定 真）, visible_to_fulfiller: bool（既定 真）,
           reportable: bool（既定 偽） }
UiRule { condition: 式, effects: [{ variable, visible?, mandatory?, read_only?, set_value? }], order }
```

### 3.3 変数の型

| 変数の型 | 辞書の型（[data-dictionary-and-tables.md](data-dictionary-and-tables.md) の 3.3 節） | 備考 |
| --- | --- | --- |
| `single_line` | `string` | 最大 255 |
| `multi_line` | `text` | 最大 64 KB |
| `number` | `decimal` | 最小・最大 |
| `yes_no` | `boolean` | |
| `checkbox` | `boolean` | |
| `date` | `date` | |
| `datetime` | `datetime` | |
| `select` | `choice` | 選択肢は品目のバージョンの中に持つ |
| `reference` | `reference` | 参照先の読み取りは依頼者の ACL で判定。`ref_condition` は式（他の変数の値を読める） |
| `email` | `email` | |
| `url` | `url` | |
| `attachment` | （添付ファイル） | 1 つの変数で 1 ファイル、最大 25 MB。要求の品目の添付として保存 |
| `label` | なし（配置） | 見出しと説明の文 |
| `container` | なし（配置） | 1 列・2 列の区切り |

- 本家の多くの型（リストの選択、マスク、HTML、UI ページ、カスタム、IP アドレス、数値の尺度、依頼の対象者）は MVP に入れない。依頼の対象者は、変数ではなく申請の共通の項目（`requested_for`）として持つ（8 節）。
- **マスク（パスワードなどの秘密）を持たない。** 秘密の値を要求の品目に入れると、監査の履歴・通知・エクスポートの出口のすべてで守る必要がある。パスワードの初期化などは、実行のフローから外のシステムへ依頼し、本人に直接届ける形にする（持ち越し）。
- 複数選択は、`checkbox` の組で表す（通貨・複数選択の型の持ち越しと同じ。[data-dictionary-and-tables.md](data-dictionary-and-tables.md) の 15 節）。

### 3.4 公開の時の検証（DT-CAT-001）

| # | 検査 | 失敗のとき |
| --- | --- | --- |
| 1 | 変数の数（150）、UI の規則の数（100）、選択肢の数（1,000） | 422 |
| 2 | 変数の名前が品目の中で一意、前のバージョンの名前を消していない（消すときは `retired` の印を付ける） | 422 `variable_name_conflict` |
| 3 | 式（`default_expr`、`ref_condition`、UI の規則の条件と値）の型検査。変数と依頼者の属性だけを読む | 422 `expression_error` |
| 4 | UI の規則の効果が同じ変数の同じ属性を別の値にする規則どうしで、条件が同時に真になりうるときは、`order` の後のほうが勝つ（警告だけ） | 警告 |
| 5 | `record_producer` の `field_map` の先のフィールドが、依頼者（`requester`）の書き込みの ACL で書ける（7 節） | 422 `producer_field_not_writable` |
| 6 | `request_item` に実行のフローがあり、フローのトリガーが `catalog_fulfillment` の種類 | 422 |
| 7 | `audience` が存在する | 422 |

## 4. 表示の条件と回答の検証（[ADR-0028](../decisions/0028-catalog-items-and-variables.md)）

### 4.1 同じ評価器を画面とサーバーで使う

- UI の規則と `ref_condition` の式は、式の言語の評価器（TypeScript の純粋な関数。[ADR-0001](../decisions/0001-platform-and-stack.md)）を画面とサーバーの両方で動かす。画面の評価は入力の手助けで、**正はサーバーの評価である。**
- 評価の入力は、変数の今の値と依頼者（申請の主体と `requested_for`）の属性（会社、部署、場所、上長、言語）だけ。DB を読まない。参照の変数の表示の値は、画面が別に取る。

### 4.2 回答の正規化（DT-VAR-001）

申請の時、サーバーは品目のバージョンの定義と回答から、UI の規則を `order` の順に適用して、各変数の実効の `visible`・`mandatory`・`read_only` を求め、次の表で回答を正規化する。

| # | 変数の実効の状態 | 回答 | 結果 |
| --- | --- | --- | --- |
| 1 | 定義にない変数 | - | 422 `unknown_variable` |
| 2 | 見えない | 値あり | 値を捨てる（保存しない） |
| 3 | 見えない | 値なし | 何もしない |
| 4 | 見える、読み取り専用 | 既定値・規則の値と違う | 既定値・規則の値に置き換える（利用者の値を捨てる） |
| 5 | 見える、必須 | 空 | 422 `mandatory`（変数の名前の一覧） |
| 6 | 見える | 型・長さ・選択肢・参照（依頼者が読めない・`ref_condition` に合わない）が合わない | 422 `invalid_value`（読めない参照は存在しない参照と同じ応答） |
| 7 | 見える | 合う | 保存する |

- 見えない変数の値を捨てるのは、画面を通さない API の申請で、隠れた変数に値を入れて実行のフローの分岐を操作されないためである。
- **フォームの画面の規則とは扱いが違う（意図したもの）。** フォームの画面の規則で隠したフィールドの値は、保存で捨てない（[portal-and-ui.md](portal-and-ui.md) の DT-UI-001 の 5 行）。フォームのフィールドはレコードの値で、守るのはフィールドの ACL である。カタログの回答は申請の入力で、見えない変数の値は申請の意味を持たないので捨てる。統合で、両方の文書に書くと決めた。
- UI の規則の `set_value` は、サーバーでも同じく適用する（4 行）。

### 4.3 回答の保存

| 表・列 | 中身 |
| --- | --- |
| `task.ext` ではなく、要求の品目の専用の列 `answers`（JSONB） | `{ <variable_id>: 値 }`。品目のバージョンの `item_version_id` を同じ行に持つ |
| `answer_index` | `reportable = true` の変数だけ、`(tenant_id, item_id, variable_name, value_text | value_number | value_time | value_ref, record_id)` に写す。同じトランザクション |

- 回答は申請の後に変えられるのは、依頼者の「回答の修正」（承認の前だけ）と、`catalog_admin`・担当者の修正（理由付き）だけ。どちらも保存の流れを通り、監査の履歴に残る。修正でも DT-VAR-001 の正規化をやり直す。
- 回答をテナントのフィールドの `ext` に入れないのは、品目ごとに変数が違い、フィールドの上限（300）と辞書の管理に合わないためである。レポートで使う変数は `reportable` で索引に写す。

## 5. 要求・要求の品目・実行のタスク（[ADR-0029](../decisions/0029-request-item-task-model.md)）

### 5.1 クラス

| クラス | 親 | 主な列 |
| --- | --- | --- |
| `request` | `task` | `requested_by_id`（申請した人）、`requested_for_id`、`submission_key`、`approval_state`（導出）、`stage`（導出） |
| `request_item` | `task` | `request_id`（`parent_id` と同じ）、`item_id`、`item_version_id`、`quantity`、`answers`、`stage`、`approval_state`、`fulfillment_run_id` |
| `catalog_task` | `task` | `request_item_id`（`parent_id` と同じ）、`kind`（`fulfillment` / `approval_prep` など、テナントの選択肢） |

### 5.2 申請（カート）

```
POST /requests  { submission_key, requested_for, items: [{ item_id, quantity, answers }] }
BEGIN
  submission_key の一意（(tenant_id, requested_by_id, submission_key)、24 時間）
     → すでにあれば、その request を返す（200、作らない）
  依頼者の判定（6 節：品目が見える、他人のための申請の許可）
  品目ごとに active_version を読み、DT-VAR-001 で回答を正規化
  番号をまとめて取る（別の短いトランザクションで、1 + 品目の数。ADR-0008）
  request を作る、request_item を品目 × 数量（数量は 1 行の quantity に持つ）で作る
  各 request_item の保存の流れで、実行のフローのトリガー（catalog_fulfillment）が実行を作る
COMMIT
```

- 1 回の申請は 20 品目まで。
- **申請の冪等**：画面は申請の画面を開いた時に `submission_key`（UUIDv7）を作り、送り直しでも同じ値を送る。二重の押下・通信の切断の送り直しで、要求が 2 つできない（PROP-REQ-001）。
- 番号は保存の前の別のトランザクションで取るので、冪等の重複の時は番号が欠番になる（[ADR-0008](../decisions/0008-record-numbering.md) の約束の中）。

### 5.3 実行のフロー

- 要求の品目ごとに、品目のバージョンに固定した `fulfillment_flow_version_id` の実行を 1 つ作る（トリガーの種類 `catalog_fulfillment`。[workflow-engine.md](workflow-engine.md) の 3.2 節の `record_created` の特別の形）。
- フローは、承認（`ask_approval`）、実行のタスクの作成（`create_task` で `catalog_task` を作り、完了を待つ）、外への呼び出しを組み合わせる。組み込みの雛形のフローを 3 つ用意する：「承認なし・タスク 1 つ」「上長の承認・タスク 1 つ」「上長と品目の持ち主のグループの承認・タスク 1 つ」。
- 要求の品目の `stage` はフローが書く。フローが終わると（`end` のノード）、`stage` を `completed` にし、要求の品目を閉じる。フローが `failed` になると、`stage` を `fulfillment_failed` にし、品目の持ち主のグループに知らせる（要求の品目は開いたまま。担当者が手で進めるか取り消す）。

### 5.4 状態

要求の品目の `stage`：

| 値 | 意味 | `task.state`（generic_task） |
| --- | --- | --- |
| `waiting_approval` | 承認待ち | `open` |
| `approved` | 承認済み、実行の前 | `open` |
| `fulfillment` | 実行中 | `work_in_progress` |
| `completed` | 完了 | `closed_complete` |
| `rejected` | 却下 | `closed_incomplete` |
| `cancelled` | 取り消し | `closed_skipped` |
| `fulfillment_failed` | フローの失敗 | `work_in_progress`（人の対応待ち） |

DT-REQ-001（要求の状態の導出。要求の品目の保存の後のルールで、親の要求を更新する）：

| # | 要求の品目の `stage` の集合 | 要求の `approval_state` | 要求の `stage` | 要求の `task.state` |
| --- | --- | --- | --- | --- |
| 1 | すべて `completed`・`rejected`・`cancelled`、うち 1 つ以上 `completed` | `approved` | `completed` | `closed_complete` |
| 2 | すべて `rejected`・`cancelled`、うち 1 つ以上 `rejected` | `rejected` | `closed_rejected` | `closed_incomplete` |
| 3 | すべて `cancelled` | - | `cancelled` | `closed_skipped` |
| 4 | 1 つ以上 `waiting_approval` | `requested` | `waiting_approval` | `open` |
| 5 | 1 つ以上 `fulfillment_failed` | （そのまま） | `attention` | `work_in_progress` |
| 6 | そのほか（1 つ以上 `approved`・`fulfillment`） | `approved` | `fulfillment` | `work_in_progress` |

- 導出は、要求の品目の保存の後のルール（同じトランザクション、1 件の他のレコードの更新）で、親の要求の行をロックして、すべての子の `stage` を読んで行う。子の並行の保存は、親の行のロックで直列になる（1 つの要求の子は 20 件までなので詰まらない）。
- 要求は利用者が直接状態を変えられない（取り消しは 5.5 節の操作だけ）。

### 5.5 取り消し

- 依頼者は、承認の前（`waiting_approval`）の要求の品目を取り消せる。承認の後は、担当者（品目の持ち主のグループ）だけが取り消せる。
- 取り消しは、要求の品目を `cancelled` にし、同じトランザクションで実行のフローを取り消す（[workflow-engine.md](workflow-engine.md) の DT-FLOW-002 の 8 行。開いている承認と子のタスクも取り消す）。
- 要求の取り消しは、すべての開いている要求の品目の取り消し（それぞれの権限の判定を通す）。

## 6. 依頼者の見える範囲と利用できる人（[ADR-0030](../decisions/0030-portal-requester-scope-and-record-producers.md)）

### 6.1 利用できる人

- `audience` は、条件の一覧（ロール、グループ、会社、部署、場所、利用者の属性の式）の「どれかに合う」`include` と、「どれかに合えば除く」`exclude` を持つ。**除くほうが勝つ。** `include` が空なら誰も使えない（既定の拒否。[ADR-0011](../decisions/0011-roles-groups-and-acl-evaluation.md) と同じ考え）。
- 条件は、主体の属性だけで評価できる式に限る（レコードを読まない）。主体ごとに `(tenant_id, user_id, acl_version, meta_version)` をキーに、見える品目とカテゴリの ID の集合をキャッシュする。
- カテゴリの `audience` と品目の `audience` の両方に合うと品目が見える。見えない品目の申請は 404（存在を知らせない）。
- カタログの検索（`search.md`）は、同じ集合で絞る。

### 6.2 依頼者の ACL（組み込みの規則）

DT-REQ-002（`requester` のロールだけの利用者が、要求・要求の品目・実行のタスクを読めるか）：

| # | 対象 | 条件 | 読める範囲 |
| --- | --- | --- | --- |
| 1 | `request`・`request_item` | `requested_by_id = me` または `requested_for_id = me` または `me ∈ watchers` | 行と、共通の項目（番号、状態、`stage`、作成・更新の時刻、品目の名前） |
| 2 | 同上の `answers` | 1 と同じ | `visible_to_requester = true` の変数だけ（フィールドの判定の中で変数ごとに絞る） |
| 3 | 同上の作業メモ（`work_note`） | - | 読めない |
| 4 | 同上のコメント（`comment`） | 1 と同じ | 読める・書ける |
| 5 | `catalog_task` | 親の要求の品目が 1 に当たる | 番号・状態・短い説明だけ。担当者と作業メモは読めない |
| 6 | 承認の行 | 親が 1 に当たる | 承認者の名前・状態・時刻（コメントは読めない） |
| 7 | そのほか | - | 読めない（既定の拒否） |

- ポータルの「自分の要求」は、この規則をそのまま使う（[access-control.md](access-control.md) の 6.2 節の 16 行。ポータル用の抜け道を作らない）。
- `requested_for` に指定された人は、自分のための要求を読めるが、依頼者が取り消せる範囲（承認の前）を除いて、取り消せない。

### 6.3 他人のための申請

DT-REQ-003：

| # | 品目の `allow_request_for_others` | 申請者と `requested_for` の関係 | 結果 |
| --- | --- | --- | --- |
| 1 | - | 同じ人 | 許可 |
| 2 | 偽 | 別の人 | 403 `request_for_others_not_allowed` |
| 3 | 真 | 申請者が `requested_for` の上長（`manager_id` を 3 段までさかのぼる） | 許可 |
| 4 | 真 | `requested_for` から申請者への有効な代理（`delegation` の `scope` に `requests`。[workflow-engine.md](workflow-engine.md) の 7.1 節） | 許可 |
| 5 | 真 | 申請者が `agent`（サービスデスクの代行） | 許可。`channel = agent_on_behalf` を残す |
| 6 | 真 | `requested_for` がその品目の `audience` に合わない | 422 `item_not_available_for_target` |
| 7 | 真 | そのほか | 403 |

- 6 行は 3〜5 より先に評価する（品目が対象者に使えないなら、関係があっても申請できない）。表の順は `spec.md` で確定する。
- 利用できる人の判定は、申請者と対象者の両方で行う（申請者には品目が見え、対象者には使える）。

## 7. フォームからのレコードの作成（[ADR-0030](../decisions/0030-portal-requester-scope-and-record-producers.md)）

- `kind = record_producer` の品目は、変数の回答からレコード（インシデントなど）を作る。要求・要求の品目は作らない。
- `field_map`：`{ target_field: 式（変数の値と依頼者の属性） }`。公開の時に、先のフィールドが依頼者の書き込みの ACL で書けることを検査する（DT-CAT-001 の 5 行）。
- 作成は、**依頼者の主体で Record Service の保存を通す**（ACL、辞書の検証、割り当ての規則、SLA、フローがすべて通常どおり動く）。`channel = portal`、`opened_by = 依頼者` はシステムが入れる。
- マップしなかった変数の回答は、作ったレコードの作業メモではなく、コメントの 1 件目に「入力された内容」として整形して残す（依頼者が自分の入力を見られるように）。`visible_to_requester = false` の変数は、作業メモに残す。
- 自己解決の候補（ナレッジの記事）を入力の途中に出し、記事を見て申請をやめたことを計測する（[knowledge.md](knowledge.md) の 7 節）。

## 8. 障害のときの振る舞い

| 障害 | 振る舞い |
| --- | --- |
| 申請の送り直し（通信の切断） | `submission_key` で同じ要求を返す |
| 申請のトランザクションの途中の失敗 | 全体が巻き戻る。番号は欠番になる。フローの実行も作られない |
| 品目の公開と申請が同時 | 申請は、トランザクションの中で読んだ `active_version_id` に固定される。どちらのバージョンでも一貫する |
| 実行のフローの失敗 | 要求の品目を `fulfillment_failed` にし、持ち主のグループに知らせる。要求は `attention` |
| 参照の変数の先のレコードの削除 | 回答は ID のまま残る。表示は「（表示できないレコード）」（[access-control.md](access-control.md) の 6.2 節の 6 行） |
| 利用できる人のキャッシュの古さ | `acl_version`・`meta_version` をキーにするので、権限・品目の変更の後の要求は新しい判定になる |

## 9. セキュリティ

- 品目の説明は Markdown の制限付きの形だけで、HTML・スクリプトを受けない。
- 見えない変数の値を捨て（4.2 節）、画面を通さない API の申請でも同じ正規化をする。
- 参照の変数の候補と検証は、依頼者の ACL で行う。読めないレコードは存在しないものと同じ応答にする。
- 秘密の値の変数（マスク）を持たない（3.3 節）。
- 他人のための申請は、品目の許可と関係（上長・代理・サービスデスク）を要る（6.3 節）。
- 依頼者は作業メモ・実行のタスクの担当者を読めない（6.2 節）。
- 添付の変数のファイルは、ウイルスの検査（`security.md`）を通るまで実行のフローに渡さない。

## 10. テスト

### 10.1 決定表

- DT-CAT-001（公開の検証）、DT-VAR-001（回答の正規化）、DT-REQ-001（要求の状態の導出）、DT-REQ-002（依頼者の見える範囲）、DT-REQ-003（他人のための申請）を、`spec.md` から読む表駆動テストにする。

### 10.2 性質ベーステスト（fast-check）

- **PROP-REQ-001（申請の冪等）**：任意の送り直しの回数・並行度で、同じ `submission_key` の申請は要求をちょうど 1 つ作る。
- **PROP-REQ-002（状態の導出）**：任意の要求の品目の `stage` の遷移の列（並行を含む）の後で、要求の `stage` は DT-REQ-001 を今の子の集合に当てはめた値に等しい。
- **PROP-VAR-001（画面とサーバーの一致）**：任意の品目の定義と回答で、画面の評価器とサーバーの評価器の実効の `visible`・`mandatory`・`read_only` は一致する（同じコードの 2 つのビルドで確かめる）。
- **PROP-VAR-002（見えない値は残らない）**：任意の回答で、保存された `answers` のキーは、実効で見える変数だけ。
- **PROP-VAR-003（バージョンの固定）**：任意の申請の後の品目の公開の列で、要求の品目の `answers` の解釈（変数の定義）と実行のフローのバージョンは、申請の時のバージョンのまま。
- **PROP-REQ-003（依頼者の範囲）**：任意の要求の集合と依頼者で、依頼者が読める要求は DT-REQ-002 の 1 行に当たるものだけ（リスト・件数・検索の出口で確かめる）。

## 11. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E8 | `catalog-and-categories` | 3.1 節、`audience`（6.1 節） |
| E8 | `catalog-item-versions` | 3.1・3.2 節、DT-CAT-001（PROP-VAR-003） |
| E8 | `catalog-variables-and-ui-rules` | 3.3・4 節、DT-VAR-001（PROP-VAR-001・002） |
| E8 | `request-submission` | 5.2 節（PROP-REQ-001） |
| E8 | `request-item-stages-and-rollup` | 5.4 節、DT-REQ-001（PROP-REQ-002） |
| E8 | `catalog-fulfillment-flows` | 5.3 節、組み込みの雛形のフロー（workflow-engine と一緒に） |
| E8 | `request-cancellation` | 5.5 節 |
| E8 | `requester-acl` | 6.2 節、DT-REQ-002（PROP-REQ-003。access-control と一緒に） |
| E8 | `request-for-others` | 6.3 節、DT-REQ-003 |
| E8 | `record-producers` | 7 節（インシデントの報告のフォーム） |
| E8 | `portal-catalog-ui` | ポータルのカタログ・申請・自分の要求の画面（portal-and-ui と一緒に） |
| E9 | `catalog-search` | カタログの品目の検索の索引とポータルの検索（search と一緒に。同じ Story） |
| E11 | `catalog-answer-reports` | `answer_index` を使う集計（reports と一緒に） |

## 12. 未解決の問い

### 決定（2026-09-28、既定案）

- **品目は公開で不変のバージョンになり、申請の時のバージョンに固定する**（3.1 節、ADR-0028）。
- **変数の型を 12 種と配置の 2 種に限り、マスク・HTML・スクリプトの型を持たない**（3.3 節）。
- **見えない変数の値は捨て、サーバーの評価を正にする**（4.2 節）。フォームの画面の規則（隠しても捨てない）との違いは意図したもの。
- **回答は要求の品目の `answers` に持ち、レポートに使う変数だけを索引に写す**（4.3 節）。
- **申請は `submission_key` で冪等にする**（5.2 節、ADR-0029）。
- **要求の状態は子から導き、利用者に直接変えさせない**（5.4 節）。
- **利用できる人は除くほうが勝ち、含む条件が空なら誰も使えない**（6.1 節、ADR-0030）。
- **他人のための申請は、上長（3 段まで）・代理・サービスデスクに限る**（6.3 節）。
- **フォームからのレコードの作成は依頼者の主体で保存する**（7 節）。
- **価格・カートの保存・注文のガイド（複数品目の案内）は MVP に入れない。**

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| 秘密の値の受け渡し（パスワードの初期化など） | MVP の後。外のシステムへの直接の受け渡しの形を `security.md` と一緒に |
| 価格と承認の金額の条件（通貨の型） | 通貨の型の持ち越しと一緒に |
| 複数品目の案内（注文のガイド）、カートの保存 | E8 の利用者の調査で |
| 参照の複数選択の変数 | 複数選択の型の持ち越しと一緒に |
| 本家の利用できる人の条件の意味（除くの優先など） | 本家の公式の本文で確かめられたら 2 節を直す |

## 13. quality.md・runbooks・data-model への項目

### quality.md

- 申請の二重（同じ依頼者・同じ品目・近い時刻の要求の組）の件数：`submission_key` の効果の確認。
- 要求の品目の `fulfillment_failed` の割合（品目別）。
- 申請から完了までの時間の p50・p90（品目別）。
- 回答の正規化で捨てた値の件数（多いと画面と定義のずれ、または API の誤用の兆し）。
- 依頼者の範囲の漏れの試験の結果（出口ごと。K6）。

### runbooks

- `fulfillment-flow-failed.md`：実行のフローの失敗の調べ方と、手での進め方・取り消し方。
- `catalog-item-rollback.md`：誤った品目のバージョンを公開したときの戻し方（前のバージョンの定義で新しいバージョンを公開する）。
- `request-rollup-mismatch.md`：要求の状態が子と合わないときの調べ方と、導出のやり直し。

### data-model（索引への追加の提案）

| 置き場所 | 中身 |
| --- | --- |
| Aurora `catalog`、`catalog_category`、`catalog_item`、`catalog_item_version`、`variable_set`、`audience` | 3.1 節。メタデータ（`catalog_item_version` は変えない） |
| Aurora `task`（クラス `request`、`request_item`、`catalog_task` の型付きの列） | 5.1 節。`answers`（JSONB）、`item_version_id`、`submission_key` |
| Aurora `answer_index` | 4.3 節 |
| Aurora 一意の索引 `(tenant_id, requested_by_id, submission_key)` | 5.2 節。24 時間の後に `submission_key` を空にするジョブ |
| Valkey 見える品目の集合のキャッシュ | 6.1 節。失われてもよい |

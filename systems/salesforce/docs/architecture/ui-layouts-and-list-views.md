# UI, layouts and list views: Salesforce

ページレイアウト、関連リスト、レコードタイプごとの画面、リストビュー（条件の保存、問い合わせの言語へのコンパイル、共有に従う件数）、インライン編集、メタデータを変える Setup の画面、アクセシビリティの設計。土台は [ADR-0003](../decisions/0003-metadata-driven-runtime.md)（メタデータの版とコンパイル）、[ADR-0007](../decisions/0007-segmented-metadata-snapshots.md)（`layouts:<object_id>` の部品）、[ADR-0018](../decisions/0018-record-query-language.md)（問い合わせの言語）、[ADR-0020](../decisions/0020-rest-api-shape-and-versioning.md)（REST API）。この文書で決めたことは、次の 2 つの ADR にある。

- ページレイアウトとレコードタイプは、オブジェクトごとの `layouts` の部品にコンパイルする。レコードの画面は、レイアウト・値・関連リストの最初のページを 1 回の要求で組み立てる「レコードのページ」の API で返す。レイアウトはアクセスを与えず、FLS と共有が常に優先する（[ADR-0023](../decisions/0023-layouts-and-record-page-composition.md)）。
- リストビューの条件は、問い合わせの言語の文字列ではなく、条件の AST（JSON）で保存し、見る人の権限で毎回コンパイルする。共有するのは定義だけで、データではない。見る人が読めない項目を条件に持つリストビューは、条件を落とさず、その人には開けないものにする（[ADR-0024](../decisions/0024-list-views-as-filter-ast.md)）。

本家の振る舞いは、2026-09-28 に次の資料で確かめた。確かめられなかったものは「未検証」と書く。

## 1. 目的と範囲

| 範囲に含む | 範囲に含まない（担当の領域） |
| --- | --- |
| ページレイアウト、コンパクトレイアウト、関連リスト、レイアウトの割り当て | 項目・レコードタイプ・選択リストのデータ辞書（[metadata-and-runtime.md](metadata-and-runtime.md)） |
| レコードタイプごとの選択リストの値と画面 | FLS と共有の判定（[sharing-and-record-access.md](sharing-and-record-access.md)） |
| レコードのページの API と、画面の組み立て | 問い合わせの言語と計画（[query-language-and-api.md](query-language-and-api.md)） |
| リストビュー（条件、列、並べ替え、範囲、共有、件数）、最近見たもの | レポート（[reports-and-dashboards.md](reports-and-dashboards.md)） |
| インライン編集（詳細・リストビュー） | 全文検索の画面（search の領域） |
| Setup の画面の枠（メタデータの編集、版、同時編集） | フローのビルダーの中身（[automation-flows.md](automation-flows.md)）、デプロイ（sandboxes-and-deploy の領域） |
| アクセシビリティ、日本語・英語の表示 | 利用者・ログイン（orgs-users-and-auth の領域） |

## 2. 本家の仕組み（確かめたこと）

| 項目 | 本家 | 出典 |
| --- | --- | --- |
| リストビューの形 | 列、条件の行、条件の論理（`(1 AND 2) OR 3`）、範囲（`filterScope`）、共有先（`sharedTo`）を持つ。「自分だけ」のリストビューはメタデータとして扱えない | [Metadata API Developer Guide](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/api_meta.pdf)（Winter '27 版、以下「MDAPI」）の ListView |
| 条件の演算 | 等しい、等しくない、より小さい、より大きい、以下、以上、含む、含まない、で始まる、複数選択の含む・含まない | MDAPI の ListView |
| 範囲 | すべて、自分の、自分とキュー、キュー、チーム（部下）、商談チームなど | MDAPI の FilterScope |
| 列と条件の数 | 列 15、条件の行 10 と読める記事とコミュニティの投稿がある。本家のヘルプ（条件の編集の記事）には数が書かれていない（未検証。E5 の `list-views` で試用の組織で確かめる）。条件の値は 32 ビットの整数の範囲まで、`NOT` は括弧の式に効かない | [Edit List View Filters in Lightning Experience](https://help.salesforce.com/s/articleView?id=xcloud.customviews_edit_filters_lex.htm&type=5)（2026-09-28 に確認） |
| リストビューの問い合わせ | リストビュー・レポート・問い合わせは、同じ問い合わせの最適化器で選択性を判定する | [Best Practices for Deployments with Large Data Volumes](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_large_data_volumes_bp.pdf)（以下「LDV」） |
| レイアウトの種類 | 画面の API は、レイアウトを `Full` と `Compact` の種類、作成・編集・表示のモードで返す。FLS・共有・権限を確かめて返す | [User Interface API Developer Guide](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/api_ui.pdf)（Winter '27 版、以下「UI API」） |
| レイアウトの項目の数 | 250 項目を超えるレイアウトは、自動で作る問い合わせが大きくなりすぎて失敗しうる | [Developer Limits and Allocations Quick Reference](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_app_limits_cheatsheet.pdf)（以下「Limits」） |
| レイアウトの必須と API | レイアウトで必須にした項目が API の保存でも必須になるかは、確かめられなかった（未検証。一般には画面だけと言われる。E4 の `layout-access-dt-ui` で試用の組織で確かめる） | — |
| レコードタイプ | レコードタイプごとに使える選択リストの値を持つ。プロファイルでレコードタイプとレイアウトを割り当てる | MDAPI の RecordType、Layout。プロファイルが既定のレコードタイプとレイアウトを持つことは [Permissions in Profiles Retirement Cancelled](https://help.salesforce.com/s/articleView?id=003834041&type=1)（2026-09-28 に確認） |

## 3. ページレイアウト（ADR-0023）

### 3.1 形

```
layout（object、api_name、版）
 ├─ sections[]：label、columns（1・2）、collapsed、tab_order（横・縦）
 │    └─ items[]：field_id | blank | canvas_component、behavior（edit | readonly | required）
 ├─ related_lists[]：child_relationship、columns（10 まで）、sort、page_size（5・10・25）、actions
 ├─ highlights（コンパクトレイアウト）：fields（10 まで）
 └─ actions[]：標準の操作（編集、削除、所有者の変更、共有、変換、承認の申請）と、画面のフロー
```

- レイアウトは `md_layouts` にメタデータとして持ち、変更で版を上げる。コンパイルして `layouts:<object_id>` の部品に入れる（ADR-0007）。
- 1 つのレイアウトの項目は 200 まで、関連リストは 20 まで。本家は 250 項目を超えると問い合わせが大きくなりすぎると書く（Limits）。
- `canvas_component` は、MVP では「活動のタイムライン」「関連するレコードの要約」「承認の履歴」の組み込みの部品だけ。利用者の作る部品は MVP の後。

### 3.2 割り当て

| 入力 | 決め方 |
| --- | --- |
| プロファイル × レコードタイプ | `layout_assignments(profile_id, object_id, record_type_id) → layout_id` |
| 割り当てがない | オブジェクトの既定のレイアウト |
| レコードタイプがない（オブジェクトにレコードタイプがない） | `record_type_id` を空として引く |

- 割り当てはプロファイルの既定値（[sharing-and-record-access.md](sharing-and-record-access.md) の 3.1 節。プロファイルは既定値の入れ物）。
- 割り当ての変更はメタデータの変更で、版を上げる。

### 3.3 レイアウトはアクセスを与えない

**DT-UI-001：レイアウトの項目の見え方と書け方**（上から評価し、最初に一致した行を採る）

| # | FLS の `read` | FLS の `edit` | レコードの水準 | レイアウトの `behavior` | 項目の種類 | 表示 | 編集 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | なし | - | - | - | - | 出さない（項目の枠ごと消す） | 不可 |
| 2 | あり | - | `read` | - | - | 読むだけ | 不可 |
| 3 | あり | - | - | - | 数式・積み上げ集計・自動採番・システム | 読むだけ | 不可 |
| 4 | あり | なし | - | - | - | 読むだけ | 不可 |
| 5 | あり | あり | `edit` 以上 | `readonly` | - | 読むだけ | 不可（画面） |
| 6 | あり | あり | `edit` 以上 | `required` | - | 必須の印 | 可（画面の保存で空を断る） |
| 7 | あり | あり | `edit` 以上 | `edit` | - | 編集できる | 可 |

- **レイアウトは狭めるだけで、広げない。** FLS で読めない項目がレイアウトにあっても出さない（行 1）。レイアウトにない項目は画面に出ないが、API では FLS のとおり読み書きできる。
- **レイアウトの `readonly`・`required` は画面の保存だけに効く。** 画面の保存の要求は `layout_id` を付け、Runtime は保存の手順 2 で、そのレイアウトの `readonly` の項目の変更を 400 `FIELD_NOT_EDITABLE`、`required` の項目の空を 400 `REQUIRED_FIELD_MISSING` にする。`layout_id` のない API の保存には効かない。どの経路でも守りたい規則は、項目の `required` か入力規則で書く（Setup にそう書く）。
- 本家のレイアウトの必須が API に効くかは未検証（2 節。E4 の `layout-access-dt-ui` で確かめる）。本システムは、効く範囲を要求の印で明示する。

### 3.4 レコードタイプ

- レコードタイプは、使える選択リストの値（`md_record_type_values`）、既定の値、割り当てるレイアウト（3.2 節）を決める。
- 利用者が作成で選べるレコードタイプは、プロファイルの「使えるレコードタイプ」で決める。既定のレコードタイプがあれば、選ぶ画面を飛ばせる。
- レコードタイプで使えない選択リストの値の保存は、保存の手順 2 で 400 `INVALID_VALUE` にする（画面・API とも）。レコードタイプは画面だけの概念ではなく、値の検証に効く。
- レコードタイプの変更は、`edit` の水準と、変更先のレコードタイプを使えることが要る。変更で使えなくなる選択リストの値は、保存を断り、画面は直す項目を示す。

## 4. レコードのページの API（ADR-0023）

### 4.1 1 回の要求で組み立てる

```
GET /api/v1/ui/records/{id}?mode=view|edit
GET /api/v1/ui/objects/{object}/new?record_type=...
```

応答：

```json
{
  "record": { "id": "...", "object": "opportunity", "row_version": 12, "fields": { } },
  "layout": { "id": "...", "etag": "\"seg:9f..\"", "sections": [ ], "highlights": [ ] },
  "related_lists": [
    { "name": "contact_roles", "records": [ ], "done": false, "next": "/api/v1/query/cursor/..." }
  ],
  "record_type": { "id": "...", "picklists": { "stage": ["prospecting", "proposal"] } },
  "actions": ["edit", "delete", "change_owner", "share", "submit_for_approval"]
}
```

- 手順：版を固定 → レイアウトを決める（3.2 節）→ レコードを読む（レイアウトの項目のうち読めるものだけ。FLS で落として返す画面用の要求。ADR-0003）→ 関連リストの最初のページを並行で読む → 操作の一覧を、水準とオブジェクトの権限で決める。
- NFR-001（レコードの詳細の API の p95 300ms）に収めるため、次の予算を置く。

| 予算 | 値 | 超えた時 |
| --- | --- | --- |
| 最初に読む関連リスト | 6 まで（レイアウトの上から） | 残りは `deferred: true` で返し、画面がスクロールで読む |
| 1 つの関連リストの最初のページ | `page_size`（既定 5、最大 25） | 続きはカーソル |
| 1 回の要求の問い合わせ | 10 まで（レコード 1、親の名前 1、関連リスト 6、他） | トランザクションの問い合わせの数（100。ADR-0005）の内側 |

- 関連リストは、子の関係の問い合わせ（[query-language-and-api.md](query-language-and-api.md) の 3.2 節）を見る人の権限でコンパイルしたもの。見えない子は出さない。件数は出さず「さらにある」だけを返す（件数を出すと重く、見えない子の数と混同しやすい）。
- 活動のタイムラインは、主の親がこのレコードの活動と、追加の関係者がこのレコードの活動を、見る人の水準で絞って並べる（[sales-objects.md](sales-objects.md) の 4 節）。
- レイアウトの記述は、部品の鍵と権限の形から `ETag` を作る。画面は記述を持ち続け、`If-None-Match` で 304 を受ける（ADR-0020 の記述と同じ）。

### 4.2 最近見たもの

- `recent_items(org_id, user_id, object_id, record_id, viewed_at)` に、レコードのページの表示で 1 行を足す（利用者ごとに 1 オブジェクト 100 件まで。古いものを消す）。書き込みは確定の後に非同期で行い、表示の読みを遅くしない。
- リストビューの「最近見たもの」は、この表の ID を、見る人の権限で問い合わせ直して返す。権限を失ったレコードは出さない。

## 5. リストビュー（ADR-0024）

### 5.1 形

```json
{
  "object": "opportunity",
  "api_name": "my_open_deals",
  "label": "自分の進行中の商談",
  "scope": "mine",
  "filters": [
    { "no": 1, "field": "stage", "op": "not_in", "values": ["closed_won", "closed_lost"] },
    { "no": 2, "field": "close_date", "op": "eq", "values": [{ "fn": "THIS_FISCAL_QUARTER" }] },
    { "no": 3, "field": "account.x_region", "op": "eq", "values": ["kanto"] }
  ],
  "logic": "1 AND (2 OR 3)",
  "columns": ["name", "account.name", "amount", "close_date", "stage", "owner.name"],
  "sort": [{ "field": "close_date", "dir": "asc" }],
  "visibility": { "kind": "groups", "groups": ["<公開グループの ID>", "<ロールと部下の ID>"] }
}
```

- 条件は、問い合わせの言語の AST の部分集合を JSON にしたもの（[ADR-0018](../decisions/0018-record-query-language.md) は、画面とフローが AST の JSON を直接作ってよいとした）。項目は API の名前ではなく `field_id` で保存し、名前の変更で壊れないようにする（上の例は読みやすさのため名前で書いた）。
- 演算：`eq`、`ne`、`lt`、`gt`、`le`、`ge`、`contains`、`not_contains`、`starts_with`、`in`、`not_in`、`is_null`、`is_not_null`、`has_any`、`has_none`。値は定数、日付の関数、`$me`（見る人）だけ。本家の演算（MDAPI）に寄せる。
- `scope`：`all`、`mine`、`team`（本人と部下）、`queues`（本人のキュー）、`mine_and_queues`。問い合わせの言語の `SCOPE` に写す。**共有の条件に加えて絞るだけで、広げない**（ADR-0018）。
- 上限：条件の行 10、列 15、並べ替え 2、親への参照 2 段。本家の値は未検証（2 節。E5 の `list-views` で確かめる）。10 行を超える条件が要る時は、数式の項目かレポートを勧める。
- `visibility`：`private`（作った人だけ）、`all`（組織の全員）、`groups`（公開グループ・ロール・ロールと部下）。

### 5.2 コンパイルと実行

```
リストビューの定義（AST の JSON）
   │ 見る人の版・権限の形で
   ▼
束縛（field_id → 項目）→ 型の検査 → 権限（FLS：条件・列・並べ替え）→ 共有の条件の付加 → 計画 → SQL
```

- **毎回、見る人の権限でコンパイルする。** リストビューを共有しても、共有するのは定義だけで、データは見る人が見られるものだけになる。
- コンパイル結果は、問い合わせと同じく `(org_id, metadata_version, AST のハッシュ, 権限の形)` でキャッシュする（ADR-0003）。同じリストビューを見る、同じ権限の形の利用者は、コンパイルを共有する（共有の条件の値 `$me` はバインド変数なので、結果は共有しない）。

**DT-LV-001：見る人が読めない項目**（上から評価）

| # | 読めない項目の場所 | 結果 |
| --- | --- | --- |
| 1 | 条件（`filters`）か並べ替え（`sort`） | そのリストビューはその人には開けない。400 `LIST_VIEW_UNAVAILABLE`（「条件に使っている項目を表示する権限がありません」）。条件を落として開かない |
| 2 | 列だけ | その列を落として開く |
| 3 | 親への参照の親が読めない（レコードの単位） | その行の親の列を空にする（共有の領域の 6.4 節） |
| 4 | なし | 開く |

- 行 1 で条件を落とすと、結果が広がって意図しないレコードが並び、読めない項目の値で絞った結果の差から値を推し量れる（ADR-0013 の「読めない項目は存在しない項目と同じ」の趣旨）。
- 作った人と見る人の権限が違う時に開けないことがある。リストビューの保存の時に、`visibility` の相手のうち、条件の項目を読めない権限の形があれば、Setup と作った人に警告する（相手の名前は、作った人が見られる範囲で）。

### 5.3 件数

- 件数は既定で出さない。画面が「件数」を求めた時だけ、見る人の共有の条件をかけた `COUNT` を、1 万件で打ち切って返す（「10,000 件以上」。ADR-0020 の `total_capped`）。
- 件数も見る人が見られる行だけを数える（intent の「利用者が見られないレコードは、リストビューの件数に現れない」）。組織全体の統計（[query-language-and-api.md](query-language-and-api.md) の 4.2 節）から件数を出さない。
- 件数の問い合わせは、ページの問い合わせとは別の問い合わせに数える。

### 5.4 選択性

- リストビューは対話の経路なので、20 万件を超えるオブジェクトで選択的でない条件は 400 `NON_SELECTIVE_QUERY` になる（[query-language-and-api.md](query-language-and-api.md) の 4.5 節）。
- リストビューの保存の時に、計画の説明で選択性を確かめ、選択的でなければ保存の画面で警告する。見積もりの数は、`customize_application` か `view_all_data` を持つ人にだけ出す（4.6 節）。それ以外の人には「条件をさらに絞ってください」とだけ出す。
- 既定の並べ替えは、索引のある項目（名前、作成・更新の日時）にする。索引の順の計画（P3）が使えるようにするため。
- 本家も、リストビュー・レポート・問い合わせを同じ最適化器で判定する（LDV）。

### 5.5 API

| メソッドとパス | 操作 |
| --- | --- |
| `GET /api/v1/objects/{object}/list-views` | 見る人が使えるリストビューの一覧 |
| `GET /api/v1/objects/{object}/list-views/{id}/records?page_size=50` | 結果（カーソル付き）。`count=true` で打ち切った件数 |
| `POST`・`PATCH`・`DELETE /api/v1/objects/{object}/list-views[/{id}]` | 作成・変更・削除 |

- `visibility = private` のリストビューは、作った人のデータ（`user_list_views`）で、メタデータの版を上げない。`all`・`groups` のものはメタデータ（`md_list_views`）で、`manage_public_list_views` のシステムの権限か `customize_application` が要り、版を上げる。本家も「自分だけ」のリストビューをメタデータにしない（MDAPI）。

## 6. インライン編集

- レコードのページとリストビューで、項目を直接書き換える。保存は `PATCH /api/v1/objects/{object}/records/{id}` に `If-Match: "<row_version>"` と `layout_id`（レコードのページ）を付ける。
- リストビューの複数の行の編集は、`collections`（200 件まで、`all_or_none = false`）で送る（[query-language-and-api.md](query-language-and-api.md) の 5.4 節）。失敗した行だけを画面で赤く示し、エラーの `index` と `fields` で場所を示す。
- 編集できるかは DT-UI-001（リストビューではレイアウトがないので、行 5・6 を除いた表）で決める。画面は、読んだ時の水準で編集の枠を出すが、正は保存の結果にする。
- `412 PRECONDITION_FAILED`（他の人が先に保存した）では、画面は最新の値を読み直し、利用者の変更した項目と相手の変更が重ならなければ、自動で当て直して保存し直す（1 回まで）。重なれば、両方の値を示して選ばせる。
- 保存の後のフローや積み上げ集計で他の項目が変わるので、保存の応答は、変わった全ての項目を返す（`PATCH` の 204 ではなく、画面用の要求では 200 とレコードを返す。`Prefer: return=representation`）。

## 7. Setup の画面

### 7.1 形

- Setup は、メタデータの種類ごとの JSON Schema から作る**汎用の編集の画面**と、専用のビルダー（レイアウト、リストビュー、フロー、レポートの型、承認）で作る。新しいメタデータの種類は、Schema を足すだけで一覧・詳細・編集の画面ができる。
- Setup の要求は Metadata のサービスが受け、1 回の保存は 1 つのメタデータの版になる（ADR-0003。[metadata-and-runtime.md](metadata-and-runtime.md) の 4.1 節）。
- Setup に入れるのは `customize_application` を持つ利用者。利用者・権限の画面は `manage_users`、共有の画面は `manage_sharing` も見る（共有の領域の 3.2 節）。

### 7.2 同時編集

- 2 人の管理者が同じ要素（例：同じレイアウト）を同時に編集した時、後の保存が先の保存を黙って上書きしないよう、要素ごとの `updated_version` を楽観の鍵にする。編集を始めた時の `updated_version` を保存に付け、違えば 409 `METADATA_CONFLICT` にし、差分を見せる。
- 組織の版（`metadata_version`）全体を鍵にしない。別の要素の変更で、関係ない編集が失敗するため。

### 7.3 変更の下見と影響

- 項目の削除、型の変換、レコードタイプの無効化、レイアウトの割り当ての変更は、保存の前に「影響」を出す：依存（`md_dependencies`）、影響を受けるリストビュー・レポート・フロー・承認・重複の規則の数。
- 影響の一覧は、管理者が見られる要素だけで作る（`private` のリストビューは件数だけを出す。名前は出さない）。

## 8. アクセシビリティと表示

- WCAG 2.2 の AA を目標にする。レコードのページ、リストビュー、インライン編集、Setup の汎用の画面を、キーボードだけで操作できるようにする。
- レイアウトのビルダーのドラッグ＆ドロップには、同じ操作をキーボードで行う「上へ・下へ・別の区画へ」のボタンを付ける。
- エラーは項目の近くと画面の上の要約の両方に出し、要約から項目へ移れるようにする。色だけで状態を示さない。
- ラベルは日本語と英語（intent）。ラベルの翻訳は `md_translations(org_id, entity_kind, entity_id, attr, locale, text)` に持ち、`layouts`・`object` の部品にロケールごとに入れる。
- 日付・数・通貨は、利用者のロケールで表示する。API は常に ISO 8601 と 10 進の文字列（ADR-0020）。

## 9. 障害のとき

| 事象 | 振る舞い |
| --- | --- |
| レイアウトの部品のコンパイルに失敗する | そのオブジェクトの既定の「全項目のレイアウト」（読める項目を順に並べたもの）で表示する。`layout_compile_fallback_total` を数える |
| 関連リストの 1 つが遅い・失敗する | その関連リストだけ `error: true` で返し、ページは返す |
| リストビューが `NON_SELECTIVE_QUERY` | 画面は「条件を絞ってください」と、使える索引のある項目の候補を出す |
| リストビューの定義の項目が削除された | その条件の行を「削除された項目」と示し、開かない（DT-LV-001 の行 1 と同じ扱い）。項目を戻すと開ける |
| 最近見たものの非同期の書き込みが遅れる | 表示には影響しない。欠けても再表示で埋まる |
| メタデータの競合（409）が多い | 同じ要素を多くの管理者が触る組織への案内。`metadata_conflict_total` を数える |

## 10. セキュリティ

- レイアウトは狭めるだけで広げない（DT-UI-001）。レイアウトの `readonly` を、アクセス制御の代わりにしないよう Setup に書く。
- リストビューは毎回、見る人の権限でコンパイルする。定義を共有してもデータを共有しない。読めない項目を条件に持つリストビューを、条件を落として開かない（DT-LV-001）。
- 件数は見る人が見られる行だけ。組織の統計から件数や見積もりを出さない（見積もりは管理者だけ）。
- 関連リストに件数を出さない。
- Setup の影響の一覧で、管理者が見られない要素の名前を出さない。
- 画面の HTML は、利用者のデータを全てテキストとして描く（React の既定のエスケープ）。リッチテキストの項目は、許可リストのタグだけに消毒してから描く。
- `security:sensitive` の対象：DT-UI-001・DT-LV-001 の判定、リストビューのコンパイル、件数の問い合わせ。

## 11. テスト

- 決定表：`DT-UI-001`、`DT-LV-001` を spec から読み込む表駆動テストにする。
- 性質ベーステスト（fast-check）：
  - 任意のリストビューの定義と任意の権限・共有の設定で、リストビューの結果が、同じ条件を参照の評価器（問い合わせの言語）と参照のアクセスの評価器（共有の領域の 9 節）で求めたものと一致する。
  - 任意のリストビューで、`scope` を付けた結果は、付けない結果の部分集合になる（広げない）。
  - 任意の権限の形で、レコードのページの応答に、FLS で読めない項目の値が出ない（レイアウトに関わらず）。
  - 任意のインライン編集の競合の列で、自動の当て直しが、重ならない変更だけを当てる。
- 経路ごとの否定側のテスト：読めない項目を条件に持つ共有のリストビューが開けない。関連リストに見えない子が出ない。件数に見えない行が数えられない。
- 上限の試験：レイアウトの項目 200・関連リスト 20、リストビューの条件 10・列 15、レコードのページの問い合わせ 10。
- 性能テスト：レコードのページの API の p95 300ms（NFR-001。関連リスト 6、項目 100 のレイアウト）。リストビューの最初のページの p95 500ms（100 万件、選択的な条件）。
- アクセシビリティ：Playwright と axe で、主な画面の自動の検査を CI で回す。キーボードだけの操作のシナリオ。

## 12. この領域の ADR

| ADR | 決定 |
| --- | --- |
| [0023](../decisions/0023-layouts-and-record-page-composition.md) | レイアウトとレコードタイプを `layouts` の部品にコンパイルし、レコードのページを 1 回の要求で組み立てる。レイアウトは狭めるだけで、`readonly`・`required` は画面の保存にだけ効く |
| [0024](../decisions/0024-list-views-as-filter-ast.md) | リストビューを条件の AST で保存し、見る人の権限で毎回コンパイルする。共有は定義だけ。読めない項目を条件に持つリストビューはその人には開けない。件数は見られる行を 1 万件で打ち切る |

他の領域への依頼：

- 共有の領域：システムの権限に `manage_public_list_views` を足す。
- query-language-and-api の領域：`/api/v1/ui/...` と `/list-views` のリソースを REST の一覧に足す（v1 の中の追加の変更）。

## 13. Story の候補

| Epic | Story の候補 |
| --- | --- |
| E1 | CI：`DT-UI-001`・`DT-LV-001` の表駆動テストの枠、Playwright と axe の検査の枠 |
| E2 | Setup の画面の骨格：JSON Schema からの汎用の編集の画面、要素ごとの楽観の鍵（7.2 節） |
| E2 | 日本語・英語のラベルと `md_translations` |
| E3 | レイアウトのメタデータと `layouts` の部品のコンパイル、既定の全項目のレイアウト |
| E3 | レコードタイプと、使える選択リストの値の検証（保存の手順 2） |
| E4 | DT-UI-001 の判定（FLS・水準・レイアウト）と、画面の保存での `readonly`・`required` |
| E5 | レコードのページの API（4 節）と予算、関連リストの遅延の読み込み |
| E5 | レコードのページの画面（React）、ハイライト、活動のタイムライン |
| E5 | リストビューの定義（AST）、ビルダー、`scope`、`visibility` |
| E5 | リストビューのコンパイル（DT-LV-001）と、件数（1 万件で打ち切り） |
| E5 | インライン編集（詳細・リストビュー）、競合の自動の当て直し |
| E5 | 最近見たもの |
| E5 | アクセシビリティ：キーボードの操作、レイアウトのビルダーの代わりの操作 |
| E7 | レポートの画面と共通の表・グラフの部品（reports-and-dashboards と共有） |
| E10 | レイアウト・リストビュー（公開のもの）・翻訳のメタデータのデプロイの対象への追加 |
| E12 | レコードのページとリストビューの性能テスト（NFR-001） |

## 14. 未解決の問い

- レイアウトの `required` を API にも効かせるべきか（本家の振る舞いは未検証。E4 の `layout-access-dt-ui` で確かめる）。
- リストビューの条件 10・列 15 で足りるか（本家の値は未検証。E5 の `list-views` で確かめる）。
- 読めない項目を条件に持つ共有のリストビューを、開けなくする代わりに「その人用の写し」を作る案を持つか。
- 関連リストに件数を出さないことで、利用者が困らないか。
- 本家のページのビルダー（部品を自由に並べる画面）に相当するものを MVP に入れるか。
- インライン編集の自動の当て直しを入れるか（予期しない上書きに見えないか）。

### 決定

2026-09-28 の既定案。

- `required` は画面の保存だけに効かせる。どこでも守る規則は項目の `required` か入力規則で書くよう Setup で案内する。
- 条件 10・列 15 で作り、E5 の利用の計測で見直す。
- 写しは作らない。開けないことと理由を示し、作った人に警告する。
- 関連リストは件数を出さず「さらにある」だけにする。件数の要望が多ければ、見る人の権限での打ち切った件数を、関連リストの見出しを開いた時だけ出す形を検討する。
- ページのビルダーは MVP に入れない。レイアウト（区画と項目）と組み込みの部品だけにする。
- 自動の当て直しは、変更した項目が重ならない時だけ 1 回行い、画面に「他の人の変更を取り込みました」と出す。

## 15. quality.md・runbooks・data-model に載せるもの

**quality.md**

- リスク：リストビュー・関連リスト・件数を通した、見えないレコードと読めない項目の漏れ。DT-LV-001、性質ベーステスト、経路ごとの否定側のテスト。
- リスク：レイアウトがアクセス制御と誤解され、API で書き換えられる。DT-UI-001 の表と Setup の案内。
- リスク：レコードのページが NFR-001 に収まらない。予算（関連リスト 6、問い合わせ 10）と性能テスト。
- アクセシビリティの検査を CI の関門にする（axe の重大な違反 0 件）。
- 本番での検証：レコードのページの p95、`LIST_VIEW_UNAVAILABLE` の件数、`NON_SELECTIVE_QUERY` のリストビューの件数。

**runbooks**

- `layout-compile-fallback`：レイアウトのコンパイルの失敗で既定のレイアウトに落ちている。
- `record-page-slow`：レコードのページの p95 が 300ms を超えた。関連リスト・項目の多いレイアウトを特定する。
- `list-view-non-selective`：選択的でないリストビューが多い組織への案内（索引の指定、既定の条件）。
- SLI の追加の依頼（Ops へ）：レコードのページの API の p95・p99、リストビューの最初のページの p95、`layout_compile_fallback_total`、`metadata_conflict_total`、`LIST_VIEW_UNAVAILABLE` の件数。

**data-model**

| テーブル | 主な列 | 備考 |
| --- | --- | --- |
| `md_layouts` | `org_id`、`layout_id`、`object_id`、`api_name`、`definition`（JSONB：区画・項目・関連リスト・ハイライト・操作） | メタデータ |
| `layout_assignments` | `org_id`、`profile_id`、`object_id`、`record_type_id`、`layout_id` | メタデータ |
| `md_list_views` | `org_id`、`list_view_id`、`object_id`、`api_name`、`definition`（JSONB：条件の AST・列・並べ替え・`scope`）、`visibility` | 公開のもの。メタデータ |
| `user_list_views` | `org_id`、`user_id`、`list_view_id`、`object_id`、`definition` | 自分だけのもの。データ |
| `recent_items` | `org_id`、`user_id`、`object_id`、`record_id`、`viewed_at` | 利用者 × オブジェクトで 100 件 |
| `md_translations` | `org_id`、`entity_kind`、`entity_id`、`attr`、`locale`、`text` | メタデータ |

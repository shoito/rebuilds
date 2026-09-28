# Block model: Notion

ブロックのデータモデル、ページの木、同期ブロック、履歴、ゴミ箱、保存の形。

前提として、次の決定に従う。

| 決定 | この文書への影響 |
| --- | --- |
| [ADR-0002](../decisions/0002-everything-is-a-block.md) | ページもデータベースの行も、1 つの `blocks` の表に持つ |
| [ADR-0003](../decisions/0003-workspace-sharding.md) | すべての行に `workspace_id` を持ち、1 つのトランザクションは 1 つのワークスペースで閉じる |
| [ADR-0004](../decisions/0004-inherited-page-permissions.md) | 中身を返す経路は、必ず `can(actor, action, block)` を通す |
| [ADR-0005](../decisions/0005-transactions-as-unit-of-change.md) | 変更は操作のトランザクションで送る。ページごとに `seq` を振り、操作のログに書く |
| [ADR-0006](../decisions/0006-rich-text-as-normalized-spans.md) | リッチテキストは、正規化したスパンの配列で持つ |

テキストの同時編集の統合（CRDT か操作の変換か）、操作のログの形、配信は [collaboration.md](collaboration.md) で決める。この文書は、確定した後のブロックの値の形を決める。

## 1. 本家の形

本家のブロックは、`id`（UUIDv4）、`type`、`properties`（`title` が最も多い）、`content`（子の ID の順序付きの並び）、`parent`（権限のために祖先をたどる上向きの参照）を持つ。変更は 1 つのレコードを作成・更新する操作で表し、操作をまとめたトランザクションを `/saveTransactions` で送る。サーバーは変更前の値に操作を当てて変更後の値を作り、権限と整合を検証してから確定する（[The data model behind Notion's flexibility](https://www.notion.com/blog/data-model-behind-notion)）。

- ブロックの数は 2021 年の 200 億から、2024 年に 2,000 億を超えた。書き込みの 90% は既存の行の更新である（[Building and scaling Notion's data lake](https://www.notion.com/blog/building-and-scaling-notions-data-lake)）。
- 論理シャードは Postgres のスキーマで表し（`schema001.block` など）、`space_id`（ワークスペース）で割り当てる。`block` から外部キーでたどれる表（`collection`、`space`、`discussion`、`comment`）を同じシャードに置く。`block` の行は `id` と `space_id` の複合キーを持つ（[Herding elephants](https://www.notion.com/blog/sharding-postgres-at-notion)）。
- 公開 API のブロックは、`id`、`parent`、`type`、`created_time`、`created_by`、`last_edited_time`、`last_edited_by`、`has_children`、`in_trash`（旧 `archived`）を持つ（[Block object](https://developers.notion.com/reference/block)）。

このシステムも同じ形にする。違いは ID を UUIDv7 にすること（ADR-0002）と、表示の設定を `format` に分けること（2 節）である。本家の内部の表に `format` や `alive` の列があるかは、公式の文書では確かめられなかった（未検証。2026-09-27 にも、本家の記事が挙げる列は `id`・`type`・`properties`・`content`・`parent` だけだった。[The data model behind Notion's flexibility](https://www.notion.com/blog/data-model-behind-notion)）。

## 2. ブロックの形

| 項目 | 型 | 内容 |
| --- | --- | --- |
| `workspace_id` | uuid | テナントとシャードの鍵（ADR-0003） |
| `id` | uuid | UUIDv7。クライアントが作る（6 節） |
| `type` | text | ブロックの種類（3 節） |
| `properties` | jsonb | 中身。リッチテキスト（`title`）、チェック、ファイルの参照、URL など。検索の索引の対象 |
| `format` | jsonb | 表示の設定。色、アイコン、幅、折りたたみの見出しかどうか、など。検索の索引の対象外 |
| `parent_type` | text | `teamspace` / `member` / `block` / `data_source`。`member` はプライベートの領域の最上位のページで、`parent_id` は持ち主の `member_id`（2026-09-28 に `workspace` を改めた。[data-model.md](data-model.md) の 6 節）。`data_source` はデータベースの行のページだけ（[databases.md](databases.md) の 2 節） |
| `parent_id` | uuid | 親の ID。権限の継承と、削除・ゴミ箱からの復元先に使う |
| `page_id` | uuid | 自分を含む最も近いページ。ページ自身なら自分の ID。ページごとの `seq`・購読・履歴の単位 |
| `content` | uuid[] | 子の ID の並び。表示の順 |
| `synced_from` | uuid | 同期ブロックの参照のときだけ、元のブロックの ID（7 節） |
| `alive` | boolean | 偽なら削除済み（9 節） |
| `trashed_at` / `trashed_by` | timestamptz / uuid | ページをゴミ箱に入れたとき、その根のページにだけ付ける（9 節） |
| `purged_at` | timestamptz | ゴミ箱の根が「完全に削除」の段階に入った時刻（9 節、[ADR-0022](../decisions/0022-trash-history-and-deletion-retention.md)） |
| `created_at` / `created_by` | timestamptz / uuid | 作成。`created_by` はメンバー・ボット（連携）の ID |
| `updated_at` / `updated_by` | timestamptz / uuid | 最後の更新。サーバーの確定の時刻 |
| `version` | bigint | 行の版。更新ごとに 1 増やす。クライアントのキャッシュの鮮度の判定に使う（11 節） |

- 権限の設定（ACL）は、ブロックの列ではなく、別の表に設定のあるページの分だけ持つ（[permissions-and-sharing.md](permissions-and-sharing.md)）。
- ページの `properties` は、データベースの行のときにプロパティの値も持つ。形は [databases.md](databases.md) で決める。
- `created_at` などの時刻はサーバーの時刻にする。クライアントの時刻は、オフラインの編集で狂いうるので信用しない。

## 3. ブロックの種類（MVP）

名前は公開 API の種類の名前に合わせる（[Block object](https://developers.notion.com/reference/block)）。本家の内部の名前（`text`、`header` など）は公式の文書にないので使わない。

| `type` | `properties` | `format` | 子 |
| --- | --- | --- | --- |
| `page` | `title` | `icon`、`cover`、`full_width`、`small_text`、`font` | 持つ（ページの本文） |
| `paragraph` | `title` | `color` | 持つ（インデントした子） |
| `heading_1` / `heading_2` / `heading_3` | `title` | `color`、`toggleable` | `toggleable` のときだけ持つ |
| `bulleted_list_item` / `numbered_list_item` | `title` | `color` | 持つ |
| `to_do` | `title`、`checked` | `color` | 持つ |
| `toggle` | `title` | `color` | 持つ |
| `quote` | `title` | `color` | 持つ |
| `callout` | `title` | `icon`、`color` | 持つ |
| `code` | `title`（装飾なし）、`language`、`caption` | `wrap` | 持たない |
| `image` | `source`、`caption` | `width`、`align` | 持たない |
| `file` | `source`、`name`、`size`、`caption` | — | 持たない |
| `embed` | `url`、`caption` | `width`、`height` | 持たない |
| `divider` | — | — | 持たない |
| `synced_block` | — | — | 元は持つ。参照は持たない（7 節） |
| `database` | [databases.md](databases.md) で決める | | 持たない。行（`page`）は `parent_type = data_source` で持ち、どの `content` にも入れない（5 節） |

- **子ページ**は、親の `content` に入った `page` のブロックである。種類を別に作らない。
- **見出しの折りたたみ**：`toggleable` を偽に戻すときは、子を見出しの後ろの兄弟へ移す（本家と同じ振る舞いかは未検証）。
- **`source`**：アップロードしたファイルは `{ "type": "file", "file_id": "..." }`、外部の URL は `{ "type": "external", "url": "..." }`。ファイルの URL は保存せず、読み出しのたびに署名付き URL を発行する（[security.md](security.md)）。外部の画像は画像のプロキシ経由で表示する（閲覧者の IP を外部へ出さないため）。
- **`language`**：コードの言語は、同梱のハイライターが知る名前の列挙にする。未知の値は `plain text` として表示する。
- **種類の変更**：`paragraph` から `heading_1` への変更などは `type` の更新 1 つで行う。子を持てない種類へ変えるときは、子を後ろの兄弟へ移す操作を同じトランザクションに含める。
- MVP に含めない種類（列、表、ブックマーク、目次、数式のブロック、パンくず、ボタン、`heading_4`）は、`type` を足すだけで加えられる。未知の `type` を受け取った古いクライアントは「このブロックは表示できません」として描画し、編集させない。

## 4. リッチテキスト

形の選択は [ADR-0006](../decisions/0006-rich-text-as-normalized-spans.md) にある。本家の公開 API のリッチテキストは、`text`・`mention`・`equation` の 3 種類と、`bold`・`italic`・`strikethrough`・`underline`・`code`・`color` の装飾を持つ（[Rich text object](https://developers.notion.com/reference/rich-text)）。これに合わせる。

### 4.1 形

`properties.title` などのリッチテキストは、スパンの配列である。

```json
[
  { "text": "会議は " },
  { "text": "明日", "marks": { "bold": true, "color": "red" } },
  { "text": " の予定。担当 " },
  { "text": "‣", "mention": { "type": "user", "user_id": "0192..." } },
  { "text": "、式 " },
  { "text": "‣", "equation": "E = mc^2" },
  { "text": " 資料", "marks": { "link": "https://example.com/doc" } }
]
```

| 要素 | 内容 |
| --- | --- |
| `text` | 文字列。メンションと数式は、置き換え文字 `‣`（U+2023）1 文字 |
| `marks.bold` / `italic` / `underline` / `strikethrough` / `code` | 真のときだけ持つ |
| `marks.color` | `gray`、`brown`、`orange`、`yellow`、`green`、`blue`、`purple`、`pink`、`red` と、それぞれの `_background`（本家の API の色と同じ） |
| `marks.link` | URL。`http:` / `https:` / `mailto:` と、ワークスペースの中のページへのリンクだけを許す |
| `marks.comments` | 本文に付けたコメントのスレッドの ID の配列（[comments-and-notifications.md](comments-and-notifications.md)） |
| `mention` | `user`（`user_id`）、`page`（`page_id`）、`date`（`start`、`end`、`time_zone`）。本家の `database`・`link_preview`・`template_mention` は MVP に含めない |
| `equation` | KaTeX の式（インラインの数式） |

### 4.2 正規化

保存する値は、次の規則で正規化した形だけにする。サーバーは正規化されていない値を拒否する。

- 空の `text` のスパンを持たない。
- 隣り合う 2 つのスパンの `marks` が同じで、どちらもメンション・数式でなければ、1 つにまとめる。
- `marks` の偽の値と空の `marks` を書かない。
- メンション・数式のスパンの `text` は常に `‣` の 1 文字。
- 位置と長さは UTF-16 の単位で数える（ブラウザとエディタの単位に合わせるため）。サロゲートペアの途中で分けない。

正規化により、同じ内容は同じ JSON になる。差分の判定、履歴の比較、テストの等価の判定を、値の比較で行える。

### 4.3 装飾の広がり

カーソルの位置で文字を打ったとき、前の文字の装飾を引き継ぐかを、装飾ごとに決める。本家は Peritext を元に、太字のように広がる装飾と、リンクのように広がらない装飾を区別している（[How Notion handles concurrent editing with CRDTs](https://www.notion.com/blog/how-notion-handles-concurrent-editing-with-crdts)）。

| 装飾 | 末尾で打った文字に広がるか |
| --- | --- |
| `bold`、`italic`、`underline`、`strikethrough`、`color` | 広がる |
| `code`、`link`、`comments` | 広がらない |

同時編集で装飾の境界がどう統合されるかは [collaboration.md](collaboration.md) で決め、この表と矛盾させない。

### 4.4 描画と参照の解決

- メンションはタイトルや名前を持たない。描画のたびに ID から引き、`can(actor, read, page)` が偽のページは「アクセスできないページ」と出す。タイトルを本文に写さないので、権限のない人にタイトルが漏れない（ADR-0004）。
- 検索の索引に入れる文字列（`plain_text`）では、メンションと数式を空にする。ページのメンションの先のタイトルを、別のページの本文として索引しない（[search.md](search.md)）。
- 数式は KaTeX で描画し、`trust` を偽にする（`\href` などを無効にする）。式の長さは 1,000 文字までにする（本家の API の上限に合わせる。[Request limits](https://developers.notion.com/reference/request-limits)）。

## 5. ページの木の不変条件

サーバーはトランザクションを確定する前に、変更後の値について次を検査し、1 つでも破れたらトランザクション全体を拒否する（[AGENTS.md](../../AGENTS.md)）。対象は `alive` が真のブロックである。

| # | 不変条件 |
| --- | --- |
| T1 | 親は 1 つ。`parent_type = block` のブロックは、`parent_id` の指すブロックの `content` に、ちょうど 1 回だけ現れる。他のブロックの `content` には現れない。`parent_type = data_source` の行は、どの `content` にも現れない |
| T2 | `content` に同じ ID が 2 回現れない。`content` の各 ID の `parent_id` は、そのブロック自身である |
| T3 | 循環がない。`parent_id` をたどると（行は `data_source` → `database` ブロックを経て）、有限の段数で `teamspace` / `member` に着く |
| T4 | 親と子は同じワークスペースにある |
| T5 | 子を持てない種類（3 節）の `content` は空 |
| T6 | `page_id` は、自分を含む最も近い `page` の ID と一致する |
| T7 | 同期ブロックの参照は子を持たず、自分の元の部分木の中にない。同期ブロックの中に同期ブロックを置かない（7 節） |
| T8 | ゴミ箱の根（`trashed_at` あり）と削除済み（`alive` が偽）のブロックは、どの `content` にも現れない。`parent_id` は復元先として残す |

- **データベースの行**：行は `data_source` の `content` に並べない（[ADR-0014](../decisions/0014-database-query-index.md)）。行は数十万になり、並びはビューごとに決まるため。行の集合は索引の表（`dbx_rows`）で列挙する。ADR-0002 の「親の `content` にだけ現れる」は、行については「親の `data_source` がちょうど 1 つで、どの `content` にも現れない」と読み替える。行の本文（行のページの子）は、通常のブロックと同じく T1〜T8 に従う。
- T1〜T3 は ADR-0002 の性質そのものである。T1 は `content`（下向き）と `parent_id`（上向き）の二重の持ち方が食い違わないことを保証する。本家も、描画には `content`、権限には `parent` を使う（1 節）。
- **移動**は「元の親の `content` から除く」「新しい親の `content` に入れる」「`parent_id` を変える」を 1 つのトランザクションで行う。ページをまたぐ移動では、動かした部分木の中の、次のページの境界までの `page_id` を書き換える。
- 循環の検査（T3）は、新しい親の祖先の鎖に、動かすブロックが含まれないことで判定する。祖先の鎖は権限の判定と共有する（[permissions-and-sharing.md](permissions-and-sharing.md)）。
- ページの一覧の先頭（ワークスペース・チームスペースの直下）の並びと、個人のページの並びは、ブロックではなく、チームスペースとメンバーの側に持つ（[permissions-and-sharing.md](permissions-and-sharing.md)）。

## 6. ID

- すべてのブロックの ID は UUIDv7 で、**クライアントが作る**。オフラインで作ったブロックを、確定の前から他のブロックの `content` やメンションで参照するため（本家のクライアントも、作成の操作に ID を含めて送る）。
- 主キーは `(workspace_id, id)` にする。ID の一意性はワークスペースの中で検査し、衝突したらトランザクションを拒否する。ワークスペースの外の ID と衝突しても、すべての読み取りはワークスペースを指定して行うので害がない。
- UUIDv7 の時刻の部分は信用しない。並びや作成時刻の判断に使わない（`created_at` を使う）。
- URL は `/{workspace_slug}/{page_id}` にする。ワークスペースを URL から決められるので、シャードへの振り分けに引き直しが要らない。本家の URL はタイトルを含む（`/{workspace}/{title}-{id}`）が、タイトルがアクセスログや `Referer` に残るのを避けるため、含めない。

## 7. 同期ブロック

本家の同期ブロックは、元（`synced_from` が null で子を持つ）と参照（`synced_from.block_id` で元を指す）の 2 つの形を持つ（[Block object](https://developers.notion.com/reference/block)）。どの参照から編集しても、すべての場所に反映される。元のページにアクセスできない人は、中身を見られない（[Synced blocks](https://www.notion.com/help/synced-blocks)）。

- **元**：`type = synced_block`、`synced_from = null`。子は通常のブロックとして元の `content` に持つ。
- **参照**：`type = synced_block`、`synced_from = 元の ID`、`content` は空。
- **読み込み**：参照を含むページを開いたら、元の部分木も読み込む。元の部分木の中身を返す前に、元の位置で `can(actor, read, 元)` を判定する。偽なら、参照の場所に「アクセスできない同期ブロック」を出し、中身を返さない。
- **編集**：参照の中での編集は、元の部分木への操作として送る。操作の `seq` は元のページのものになり、参照を含むページを開いている人へは、元のページの購読経由で届く（[collaboration.md](collaboration.md)）。編集の権限は元の位置で判定する。
- **同じワークスペースだけ**：参照と元は同じワークスペースに置く（ADR-0003）。他のワークスペースのブロックを指す参照は作れない。
- **入れ子の禁止**：参照が自分の元の部分木の中にあると、描画が終わらない。同期ブロックの中に同期ブロックを置くことも禁止する（T7）。本家も入れ子を禁止しているかは未検証。
- **元の削除**：元を削除・ゴミ箱に入れたら、参照には「元のブロックが削除されました」を出す。元を戻せば、参照も戻る。本家は、参照が 10 を超える元を削除すると参照もすべて消え、元に戻す操作でも戻らない（[Synced blocks](https://www.notion.com/help/synced-blocks)）。このシステムは参照を消さずに残すので、この点は本家と違う。
- **同期の解除**：参照の解除は、元の子を複製して参照の子にし、`synced_from` を外す 1 つのトランザクションにする。元の解除（すべての解除）は、各参照に同じことを行う。
- どの参照が元を指しているかを引くため、`(workspace_id, synced_from)` に索引を張る。

## 8. ページの履歴

履歴は、操作のログ（ADR-0005）とスナップショットの 2 段で持つ。本家の履歴の保持期間は、Free が 7 日、Plus が 30 日、Business が 90 日、Enterprise は任意である（[Duplicate, delete, and restore content](https://www.notion.com/help/duplicate-delete-and-restore-content)）。

| 段 | 単位 | 保持 | 用途 |
| --- | --- | --- | --- |
| 操作のログ（`page_ops`） | トランザクション（ページごとの `seq`） | 30 日（[collaboration.md](collaboration.md) の 8・12 節） | 再接続時の差分の取得、細かい単位の取り消し、スナップショットの作成、ページの更新の欄 |
| スナップショット | ページ | ワークスペースの設定（MVP の既定は 30 日） | 履歴の一覧、比較、復元 |

- **スナップショットの作成**：ページの編集が止まって 10 分たったとき、または編集が続いても 1 時間ごとに、Worker が作る（間隔は既定案。本家は、編集中は 10 分ごとと、最後の編集の 2 分後に版を記録する。[Duplicate, delete, and restore content](https://www.notion.com/help/duplicate-delete-and-restore-content)、2026-09-27 に確認。本システムは本家より粗く、ストレージを抑える側に倒した）。中身は、そのページの部分木のうち、子ページの境界までのブロックの値（子ページは参照だけ）と、そのときの `seq` と、その間に編集したメンバーの一覧である。
- **置き場所**：スナップショットの本体は、gzip した JSON を S3 に置く（`ws/{workspace_id}/pages/{page_id}/snapshots/{seq}.json.gz`）。Aurora には `page_snapshots` の行（`workspace_id`、`page_id`、`seq`、`created_at`、`editors`、`s3_key`、`size`）だけを持つ。
- **表示**：スナップショットの本文を描画する前に、現在のページの `can(actor, read, page)` を判定する。同期ブロックの参照は、現在の元の中身ではなく、「同期ブロック」の枠だけを出す。
- **復元**：過去の版に「巻き戻す」のではなく、現在の値からスナップショットの値へ変える操作を作り、新しいトランザクションとして送る。削除済みのブロックは `alive` を真に戻す（ID が同じまま戻る）。復元にはページの編集の権限が要る。復元そのものも履歴に残り、取り消せる。
- **期限切れ**：保持期間を過ぎたスナップショットは、日次の Worker が S3 と Aurora から消す。操作のログは、30 日を過ぎたパーティションを消す（スナップショットに含まれていることを確かめてから）。
- データベースの行はページなので、行ごとに履歴を持つ。データベースのスキーマの変更の履歴は [databases.md](databases.md) で扱う。

## 9. 削除とゴミ箱

| 対象 | 操作 | 保存上の状態 | 戻し方 | 物理的な削除 |
| --- | --- | --- | --- | --- |
| ページ以外のブロック | 削除 | `alive = false`、親の `content` から除く | 取り消し、ページの履歴の復元 | 履歴の保持期間を過ぎたら、日次の Worker が消す |
| ページ | ゴミ箱へ | 根のページに `trashed_at`・`trashed_by`、親の `content` から除く。子孫はそのまま | ゴミ箱から戻す | 下の 3 段（ADR-0022） |

- 本家は、削除したページを 30 日ゴミ箱に置き、Enterprise では期間を変えられる（[Duplicate, delete, and restore content](https://www.notion.com/help/duplicate-delete-and-restore-content)）。MVP は 30 日に固定する。
- ゴミ箱の根の子孫は、行を書き換えずに「ゴミ箱の中」とみなす。祖先の鎖に `trashed_at` のあるページがあれば、ゴミ箱の中である。検索・通知・API・メンション・リレーションは、ゴミ箱の中のページを通常の結果として返さない。
- **戻す**：元の親が生きていて、戻す人がそこへの編集の権限を持つなら、元の親の `content` の末尾に戻す。そうでなければ、戻す人の個人のページの先頭に戻す。
- **削除の段階**は [ADR-0022](../decisions/0022-trash-history-and-deletion-retention.md) に従う。
  1. ゴミ箱（`trashed_at`）：`can_edit` 以上の人が 30 日の間、戻せる。
  2. 完全に削除（`purged_at`）：ゴミ箱に入れて 30 日後、または利用者が「完全に削除」を選んだ時点。利用者からは見えず、戻せない。30 日の間は、所有者の依頼で運用者だけが戻せる（監査ログに残す）。
  3. 物理削除：`purged_at` から 30 日後に、Worker が部分木のすべての行を消し、同時に、ファイルの実体、スナップショット、操作のログ、検索の索引、コメント、通知を消す。消す順序と、途中で止まったときのやり直しは [security.md](security.md) の 7 節で扱う。バックアップには最長 35 日残る。
- 完全に削除する権限は、そのページで `full_access` を持つ人に限る（[permissions-and-sharing.md](permissions-and-sharing.md) の 4.2・4.5 節）。**ワークスペースの所有者・管理者も、ページの権限を迂回しない。** ゴミ箱の一覧に出るのは、自分が `can_edit` 以上を持つページだけで、管理者も同じである。読めないページを含むワークスペース単位の削除・復元（ワークスペースの削除、完全に削除したページの復元）は、利用者の画面ではなく、運用者の経路（所有者の依頼と監査ログ）で行う。

## 10. 大きさと数の上限

本家の公開 API は、1 回の要求の大きさを制限している。リッチテキストの 1 つの `content` は 2,000 文字、リッチテキストの配列は 100 要素、式は 1,000 文字、URL は 2,000 文字、1 回の要求のブロックは 1,000、本体は 500KB まで（[Request limits](https://developers.notion.com/reference/request-limits)、2026-09-27 に確認）。これは要求の上限で、エディタで作れるブロックの大きさの上限ではない。本家のエディタの上限は公開されていない（未検証）。

このシステムの上限（既定案。[capacity.md](capacity.md) で負荷のモデルと合わせて確かめる）：

| 対象 | 上限 | 超えたとき |
| --- | --- | --- |
| 1 ブロックのリッチテキスト | 50,000（UTF-16 の単位）、スパン 2,000 個 | 貼り付けは複数のブロックに分ける。入力は止める |
| 1 ブロックの `properties` と `format` の合計 | 256KB（JSON） | 拒否 |
| 1 ブロックの子（`content`） | 10,000 | 拒否。貼り付け・インポートでは子ページに分ける |
| 1 ページの中の入れ子の深さ | 20 | インデントを止める |
| ページの木の深さ（祖先のページの数） | 100 | 拒否 |
| 1 ページのブロックの数（子ページの境界まで） | 100,000 | 読み込みは分割する（[editor.md](editor.md) の 4 節）。超えたら新しいブロックの追加を拒否 |
| 1 トランザクション | 操作 1,000、本体 500KB | 拒否。クライアントは分けて送る |

- `content` は配列なので、子が多いブロックへの挿入は、配列全体を書き直す。Postgres では大きな配列は TOAST に置かれ、更新のたびに書き直しが起きる。子の上限はこの書き直しの量を抑えるための値でもある。
- 上限の値はワークスペースごとに変えない。変えるときは、クライアントとサーバーの両方の検査を同時に変える。

## 11. 保存の形（Aurora PostgreSQL）

ADR-0003 に従い、論理シャードを Postgres のスキーマで表す（本家と同じ。1 節）。S1 は 1 つのクラスタに `shard000`〜`shard479` の 480 スキーマを置く。

```sql
CREATE TABLE shard042.blocks (
  workspace_id uuid        NOT NULL,
  id           uuid        NOT NULL,
  type         text        NOT NULL,
  properties   jsonb       NOT NULL DEFAULT '{}',
  format       jsonb       NOT NULL DEFAULT '{}',
  parent_type  text        NOT NULL,
  parent_id    uuid        NOT NULL,
  page_id      uuid        NOT NULL,
  content      uuid[]      NOT NULL DEFAULT '{}',
  synced_from  uuid,
  alive        boolean     NOT NULL DEFAULT true,
  trashed_at   timestamptz,
  trashed_by   uuid,
  purged_at    timestamptz,
  created_at   timestamptz NOT NULL,
  created_by   uuid        NOT NULL,
  updated_at   timestamptz NOT NULL,
  updated_by   uuid        NOT NULL,
  version      bigint      NOT NULL DEFAULT 1,
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX ON shard042.blocks (workspace_id, parent_id);
CREATE INDEX ON shard042.blocks (workspace_id, page_id);
CREATE INDEX ON shard042.blocks (workspace_id, synced_from) WHERE synced_from IS NOT NULL;
CREATE INDEX ON shard042.blocks (workspace_id, trashed_at) WHERE trashed_at IS NOT NULL;
```

- RLS と `FORCE ROW LEVEL SECURITY` は、Slack の ADR-0009 と同じ形で全スキーマの表に付ける（ADR-0003）。
- `content` の要素の参照の整合（T1・T2）は、外部キーでは表せないので、トランザクションの検証で保証する（5 節）。
- ページの読み込みは `(workspace_id, page_id)` の索引で、ページの中のブロックを 1 回で取る。子ページの境界の先は取らない。
- 書き込みの大半は更新なので、`fillfactor` を下げて HOT 更新を効かせる（値は [capacity.md](capacity.md) で決める）。`properties` の索引は張らない。データベースの問い合わせは別の索引で行う（ADR-0002、[databases.md](databases.md)）。
- 同じシャードに置く表：`page_snapshots`、ACL、データベースの定義、コメント、操作のログ、ファイルの記録。どれも `workspace_id` を先頭に持つ。列・制約・索引の正は [data-model.md](data-model.md) にある。

## 12. クライアントのレコードキャッシュ

本家のクライアントは、読んだレコードを SQLite や IndexedDB の LRU のキャッシュ（RecordCache）に持ち、未確定のトランザクションを確定まで永続の待ち行列（TransactionQueue）に置く。変更は WebSocket で「版が上がった」ことだけが届き、クライアントが値を取り直す（`syncRecordValues`）（[The data model behind Notion's flexibility](https://www.notion.com/blog/data-model-behind-notion)）。このシステムも同じ 3 層にする。

| 層 | 持つもの | 置き場所 |
| --- | --- | --- |
| RecordStore | 画面が使うレコード（ブロック、ユーザー、データベースの定義など）。キーは `(record_type, workspace_id, id)`、値と `version` | メモリ |
| RecordCache | 読んだレコードの写し、オフラインで使えるページの一覧 | SQLite（WASM、OPFS）。[ADR-0008](../decisions/0008-sqlite-wasm-opfs-local-store.md) |
| TransactionQueue | 送信前・確定前のトランザクション | 同上。追い出さない |

- 画面は RecordStore を ID ごとに購読する（`useSyncExternalStore`）。ブロックのコンポーネントは自分の ID のレコードだけを読み、兄弟の変更で描き直されない。
- クライアントの表示の値は「確定した値 ＋ 未確定のトランザクションを順に当てた値」である。確定の順序が変わって当て直しが要るときの扱いは [collaboration.md](collaboration.md) に従う。
- `version` が手元より新しいという通知を受けたら、その ID の値を取り直す。手元の `version` 以下の値は捨てる。
- 権限を失ったページ（取り直しで 404）は、RecordStore と RecordCache から、そのページの部分木を消す。
- クライアントが操作を当てる処理（`applyOperation`）と、サーバーが検証の前に当てる処理は、同じ TypeScript のパッケージを使う。両者の結果がずれないようにするため。

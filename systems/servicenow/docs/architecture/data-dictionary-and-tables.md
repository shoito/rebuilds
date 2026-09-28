# Data dictionary and tables: ServiceNow

データ辞書（テーブル・フィールド・型・参照・選択肢）、クラスの継承と物理の配置、テナントのフィールドとテーブル、番号の採番、レコードの監査の履歴と作業メモ、メタデータの版、テナントの間の設定の移送を決める。

前提の決定は、テーブルをクラスの継承の階層として辞書に持ち、組み込みのクラスは型付きの列、テナントの拡張は JSONB（`ext`）と型付きの索引の表で持つこと（[ADR-0003](../decisions/0003-table-hierarchy-and-extensible-schema.md)）、テナントを RLS で分け、同じ顧客のテナントを同じセルに置くこと（[ADR-0002](../decisions/0002-tenancy-and-isolation.md)）である。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0006](../decisions/0006-data-dictionary-and-field-types.md) | 辞書は組み込みの定義（コードの版）とテナントの定義（DB）を重ねて持つ。フィールドの型は 14 種に限る。子のクラスは親のフィールドの属性を「上書き」で変えられるが、型は変えられない |
| [0007](../decisions/0007-physical-layout-and-extension-index.md) | `task`・`ci` を階層ごとに 1 つの表に置き、S1 ではパーティションを切らない。テナントのフィールドは `ext` に ID をキーにして入れ、索引は `ext_index` に同じトランザクションで写す。参照のフィールドは必ず索引に写す |
| [0008](../decisions/0008-record-numbering.md) | 番号はテナント・番号の定義ごとの数の行から、保存とは別の短いトランザクションで取る。一意と増加を約束し、欠番のないことは約束しない |
| [0009](../decisions/0009-record-audit-history-and-journal.md) | 監査の履歴は保存ごとに 1 行、変更と同じトランザクションで追記だけの表に書く。作業メモとコメントは別の追記だけの表に持つ。日ごとのハッシュの鎖を S3 Object Lock に置く |
| [0010](../decisions/0010-metadata-versions-and-config-packages.md) | メタデータの変更はテナントの版の番号を上げる 1 つのトランザクションで行う。設定の移送は、安定したキーと元の版のハッシュを持つパッケージで行い、衝突は人が決め、適用は 1 つのトランザクションで行う |

この文書の決定表・性質は設計の草案である。ID（`DT-...`・`PROP-...`）は、E2 の各変更の `spec.md` に移すときに確定する。

## 1. 目的と範囲

- 扱う：辞書のモデル、フィールドの型と検証、参照と選択肢、クラスの継承と上書き、物理の配置と索引、テナントのフィールド・テーブルの追加・変更・削除、番号、監査の履歴、作業メモ・コメント、メタデータの版とキャッシュの入れ替え、設定のパッケージ（開発 → 本番）。
- 扱わない：ACL（[access-control.md](access-control.md)）、レコードのルールとフロー（[workflow-engine.md](workflow-engine.md)）、フォームとリストの描き方（`portal-and-ui.md`）、検索の索引（`search.md`）、CI の識別と調整（`cmdb-and-reconciliation.md`）、保持と削除の全体の方針（`security.md`）。
- **テナントテーブルの読み書きは Record Service だけが行う**（[ADR-0001](../decisions/0001-platform-and-stack.md) の Confirmation）。この文書の「保存の流れ」は Record Service の中の順序である。

## 2. 本家の形（確かめたこと）

| 項目 | 本家 | 出典（2026-09-28 に確認） |
| --- | --- | --- |
| 継承と物理の配置 | 子のクラスは親のフィールドを継承する。物理の配置は 3 つ：階層ごとに 1 つの表（タスクの階層。クラスの名前の列で分ける）、クラスごとの表（子のレコードを同じ ID で親の表に複製する）、パーティションごとの表（CI の基底の表。上限に達すると区画を足す） | [Table extension and classes](https://www.servicenow.com/docs/r/platform-administration/table-administration-and-data-management/table-extension-and-classes.html) |
| 辞書の上書き | 子のテーブルだけで、継承したフィールドの既定値・読み取り専用・必須・参照の絞り込みなどを変えられる | [Define a dictionary override](https://docs.servicenow.com/en-US/bundle/vancouver-platform-administration/page/administer/data-dictionary-tables/task/t_DefineADictionaryOverride.html)（検索の結果の抜粋で確認。本文は未検証） |
| 番号 | テーブルごとに 1 つの番号の書式（接頭辞、開始の番号、桁数）を持つ。桁の埋めは既存と新規のレコードに効く | コミュニティの記事と検索の結果の抜粋で確認（[Number Maintenance](https://www.servicenow.com/community/itsm-forum/number-maintenance-auto-numbering-records/td-p/711117)）。公式の文書の本文は未検証 |
| 監査の履歴 | フィールドの値の変更は監査の表に、作業メモ・コメントは別の表に入る。テーブル・フィールドの単位で監査を止められる | コミュニティの記事で確認（[How to activate/deactivate auditing](https://www.servicenow.com/community/developer-blog/servicenow-things-to-know-55-how-to-activate-deactivate-auditing/ba-p/2774658)）。公式の文書は未検証 |
| 設定の移送（更新のセット） | 衝突は、更新の記録の「名前」と「更新の時刻」を比べて見つける。一部の表は ID ではなく一意の列の組（coalesce）で同じレコードを見つける。移送のときに、参照の ID を書き換える | [Update set collision resolution](https://www.servicenow.com/docs/r/application-development/system-update-sets/update-set-collisions.html) |
| 移送の手順 | 取り込んだ更新のセットをプレビューし、問題（衝突・依存の欠け）を「取り込む」か「飛ばす」で決めてからコミットする | コミュニティの記事で確認（[Update set branch/collision detection](https://www.servicenow.com/community/developer-articles/update-set-branch-collision-detection/ta-p/2320755)）。公式の手順の本文は未検証 |

- 本家の内部の表の名前・フィールドの名前は写さない（[リポジトリ共通の ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。本家の更新のセットの形式は読み込まない（[intent.md](../intent.md) の Non-goals）。

## 3. 辞書のモデル（[ADR-0006](../decisions/0006-data-dictionary-and-field-types.md)）

### 3.1 2 つの層

```
組み込みの定義（コードの版に含む。全テナントで同じ）
   task, incident, problem, change, request, request_item, catalog_task, problem_task, change_task,
   ci と CI のクラス, user, group, role, ...
        ＋
テナントの定義（Aurora、テナントごと、版付き）
   - 組み込みのクラスへのフィールドの追加（c_ で始まる名前）
   - 組み込みのクラスの子のクラス（例：task → c_facilities_request）
   - 独立のテーブル（親を持たない）
   - 上書き（ラベル・既定値・必須・読み取り専用・選択肢の追加・参照の絞り込み・説明）
        ＝
実効の辞書（テナント × メタデータの版ごとにコンパイルし、キャッシュする）
```

- 組み込みの定義は、コードと一緒にリリースする。組み込みの定義の変更は、コードのマイグレーション（`delivery.md`）で行い、振る舞いの変更はフラグの裏に置く。
- テナントの名前は `c_` で始める。組み込みの名前とぶつからないようにする。本家の接頭辞は使わない。
- **テーブルとフィールドの内部の名前は、作成の後に変えない。** ラベルは変えられる。値は `ext` の中でフィールドの ID をキーにして持つ（ADR-0003）ので、名前を変えても値の移し替えは要らない。ただし、REST API・パッケージ・フローの参照が名前を使うので、名前を固定する（4.4 節）。

### 3.2 表

| 表 | 主な列 |
| --- | --- |
| `dict_table` | `tenant_id`（組み込みは NULL）、`id`、`name`、`label`、`parent_id`、`kind`（`builtin` / `tenant_class` / `tenant_table`）、`physical`（`task` / `ci` / `custom_record` / 専用の表の名前）、`audited`、`number_def_id`、`display_field_id`、`searchable`（検索の索引に入れるか。[search.md](search.md) の 3 節の `record`）、`deleted_at` |
| `dict_field` | `tenant_id`、`id`、`table_id`、`name`、`label`、`type`、`storage`（`column` / `ext`）、`column_name`（`column` のとき）、型ごとの設定（長さ、精度、参照先、選択肢の集合）、`mandatory`、`read_only`、`default_expr`、`indexed`、`searchable`（検索の入れ子の枠に入れるか。`string`・`text` だけ、1 テーブル 20 まで。[search.md](search.md) の 5.2 節）、`audited`、`hidden_at`、`purge_after` |
| `dict_override` | `tenant_id`、`table_id`（子のクラス）、`field_id`（祖先のフィールド）、上書きする属性（`label`、`default_expr`、`mandatory`、`read_only`、`ref_condition`、`choice_set_id`、`help`） |
| `dict_choice_set`、`dict_choice` | 選択肢の集合と値（`value`、`label`、`order`、`inactive`、`dependent_value`） |

- 組み込みの行（`tenant_id` が NULL）は、コードの版の中の定義から起動時に読み込む。DB の行は、テナントの行の参照の先として使うだけである。
- 上書きは、子のクラスから祖先へたどって最初に見つかったものを使う。上書きは型・保存の場所・参照先のテーブルを変えられない。

### 3.3 フィールドの型

| 型 | 値 | DB（`column` のとき） | `ext` の JSON | 索引の列 | 検証 |
| --- | --- | --- | --- | --- | --- |
| `string` | 1 行の文字列 | `text` ＋ CHECK 長さ | 文字列 | `value_text` | 最大長（既定 255、上限 4,000）。NFC に正規化 |
| `text` | 複数行の文字列 | `text` | 文字列 | 索引にできない（全文は検索の索引） | 最大 64 KB |
| `integer` | 整数 | `bigint` | 数（安全な整数の範囲） | `value_number` | −2^53+1〜2^53−1 |
| `decimal` | 10 進数 | `numeric(p,s)` | 文字列（桁落ちを防ぐ） | `value_number` | 精度・小数の桁 |
| `boolean` | 真偽 | `boolean` | 真偽 | `value_number`（0/1） | |
| `date` | 暦の日付 | `date` | `YYYY-MM-DD` | `value_time`（UTC の 0 時） | |
| `datetime` | 時刻（UTC） | `timestamptz` | ISO 8601（Z） | `value_time` | 秒の単位に切り捨てない（SLA の計時の側で切る） |
| `duration` | 長さ（秒） | `bigint` | 数 | `value_number` | 0 以上 |
| `choice` | 選択肢の値 | `text` | 文字列 | `value_text` | 集合の中の値（無効の値は既存の値のままなら許す） |
| `reference` | 他のレコードの ID | `uuid` ＋ 外部キー（組み込みどうし） | 文字列（UUID） | `value_ref` | 参照先の存在、同じテナント、参照の絞り込みの条件 |
| `email`・`url` | 書式付きの文字列 | `text` | 文字列 | `value_text` | 書式 |
| `journal` | 作業メモ・コメント | 列を持たない | 持たない | なし | 7 節の表に書く |
| `condition` | 式の言語の条件 | `jsonb` | 式の木 | なし | 式の言語の検証（[ADR-0001](../decisions/0001-platform-and-stack.md)） |

- 型を 14 種に限る。通貨・複数選択・添付の型は MVP に入れない（持ち越し）。
- **例外：CMDB の複数の値の属性（`multi`）。** CI の属性の定義（`ci_attribute`）で `multi: true` の属性（`ip_addresses`、`mac_addresses` など）だけは、`ci.ext` の中で配列を持てる。配列の各要素は 14 種の型で検証する。この例外は CMDB の識別と調整の入口（[cmdb-and-reconciliation.md](cmdb-and-reconciliation.md) の 3.2 節、[ADR-0036](../decisions/0036-ci-classes-and-identification-rules.md)）の中だけのもので、辞書の型を増やさず、テナントの他のテーブル・フィールドには広げない（統合で決めた）。CI のクラスの付け替えは、引き続き持ち越し（3.4 節）。添付ファイルはレコードに紐付く別の表で持つ（`security.md` と `api-and-integrations.md`）。
- **組み込みのフィールドの型は変えられない。** テナントのフィールドの型の変更は、互換のある変更（`string` の長さを延ばす、`integer` → `decimal`、`string` → `text`）だけを即時に許す。それ以外は、新しいフィールドを作り、値を写すジョブで行う（DT-DICT-002）。

### 3.4 子のクラスと継承

- 子は、親のフィールド、ACL、レコードのルール、フローのトリガー、SLA の定義の対象を継承する（ADR-0003）。
- テナントのクラスは、組み込みのクラスとテナントのクラスを親にできる。**階層の深さは、ルートから 6 段まで**にする（`task` → `change` → テナントの子 → …）。
- **レコードのクラスは、作成の後に変えない。** インシデントを問題に変えたいときは、新しいレコードを作って関係で結ぶ（`itsm-processes.md`）。本家がクラスの変更を許すかは未検証。
- テナントのクラスを削除できるのは、行が 0 件で、子のクラスがないときだけにする。

## 4. 物理の配置（[ADR-0007](../decisions/0007-physical-layout-and-extension-index.md)）

### 4.1 表の割り当て

| 物理の表 | 置くクラス | 列 |
| --- | --- | --- |
| `task` | `task` と、組み込み・テナントの子のクラスすべて | 共通の列（`tenant_id`、`id`、`class_id`、`number`、`state`、`active`、`priority`、`impact`、`urgency`、`assignment_group_id`、`assigned_to_id`、`opened_by_id`、`caller_id`、`cmdb_ci_id`、`short_description`、`description`、`opened_at`、`resolved_at`、`closed_at`、`due_at`、`parent_id`、`version`、`created_at`、`created_by`、`updated_at`、`updated_by`）＋ 組み込みの子のクラスの型付きの列（変更の予定の時刻、リスクなど）＋ `ext` |
| `ci` | CI の全クラス | 共通の属性の型付きの列 ＋ クラスに固有の属性（組み込みも）を `ext`（ADR-0003 の例外） |
| `custom_record` | テナントの独立のテーブル | `tenant_id`、`id`、`table_id`、`number`、`version`、作成・更新の人と時刻、`ext` |
| 専用の表 | `user`、`group`、`role`、`kb_article`、`catalog_item` など | 型付きの列 ＋ `ext` |

- 主キーは `(tenant_id, id)`、`id` は UUIDv7（[ADR-0002](../decisions/0002-tenancy-and-isolation.md)）。
- `version` は保存ごとに 1 上げる。更新は `WHERE version = $expected` で行い、一致しなければ 409（`record_changed`）にする。フォームは読んだときの版を送る。
- `task` の主な索引（すべて `tenant_id` を先頭に置く）：`(tenant_id, number)` 一意、`(tenant_id, assignment_group_id, active, updated_at)`、`(tenant_id, assigned_to_id) WHERE active`、`(tenant_id, class_id, state) WHERE active`、`(tenant_id, caller_id, opened_at)`、`(tenant_id, cmdb_ci_id) WHERE active`、`(tenant_id, parent_id)`。
- **S1 では `task` と `ci` をパーティションに分けない。** 完了したレコードを別の区画に移すと、再オープンのたびに行が区画をまたいで動き、索引の書き込みが増える。進行中のレコードの問い合わせは `WHERE active` の部分索引で速くする。S1 の見込み（`task` が年 7,000 万行）で、1 つの表の vacuum と索引の大きさを E2 の計測で確かめ、S2 の前に分け方（テナントのハッシュ、または完了の年）を決め直す（持ち越し）。
- 監査の履歴と作業メモは、追記だけで大きくなるので、月ごとの範囲のパーティションにする（7 節）。

### 4.2 `ext` と索引の表

```
task（tenant_id, id, ..., ext jsonb）
  ext = { "<field_id>": <値>, ... }       ← キーはフィールドの ID（UUID の短い形）

ext_index（tenant_id, field_id, record_id, value_text, value_number, value_time, value_ref）
  PK (tenant_id, field_id, record_id)
  索引：(tenant_id, field_id, value_text) WHERE value_text IS NOT NULL
        (tenant_id, field_id, value_number) WHERE ...
        (tenant_id, field_id, value_time)   WHERE ...
        (tenant_id, field_id, value_ref)    WHERE ...
```

- 管理者が「索引を付ける」を選んだフィールドと、**すべての `reference` のフィールド**を `ext_index` に写す。参照のフィールドを必ず写すのは、参照先の削除のときに、逆向きに参照元を探すためである（4.3 節）。
- `ext` と `ext_index` は、Record Service が同じトランザクションで書く。`ext_index` の値は常に `ext` の値と一致する（PROP-DICT-002）。
- 索引を後から付けると、既存の行を写すジョブを動かす。ジョブが終わるまで、そのフィールドでの絞り込みは「索引の準備中」として、件数の上限（5 節）の中でだけ許す。

### 4.3 参照の整合

- 組み込みの型付きの列どうしの参照は、DB の外部キーで守る。
- `ext` の参照と、組み込みからテナントのテーブルへの参照は、DB の制約が効かない。Record Service が書き込みの前に参照先の存在とテナントを確かめる。
- 参照先を削除するときの振る舞いは、フィールドごとに `on_delete`（`restrict` / `clear` / `cascade`）で決める。既定は `clear`。`cascade` は、同じテーブルの階層の中だけで許し、1 回の削除で 1,000 件までにする。
- 日次の整合の検査で、存在しない参照を数え、0 件でなければチケットにする（quality の項目）。

### 4.4 上限（S1 の既定。E2 の計測で見直す）

| 項目 | 上限 | 超えたとき |
| --- | --- | --- |
| テナントのフィールド（1 つのクラスと祖先のテナントのフィールドの合計） | 300 | 409 `field_limit` |
| 索引を付けたテナントのフィールド（テーブルの階層ごと。参照のフィールドを除く） | 20 | 409 `index_limit` |
| 参照のテナントのフィールド（テーブルの階層ごと） | 50 | 409 `reference_limit` |
| テナントのテーブル（独立のテーブルとクラスの合計） | 500 | 409 `table_limit` |
| 1 行の `ext` の大きさ | 64 KB | 422 `ext_too_large` |
| 階層の深さ | 6 | 422 `hierarchy_too_deep` |
| 選択肢の集合の値の数 | 1,000 | 422 |

- 本家の上限の値は、公開の資料で確かめられなかった（未検証）。

## 5. 保存の流れ

Record Service の `save(actor, table, id?, changes, expected_version?)` は、次の順で 1 つのトランザクションで行う。順序は、フロー・ACL・SLA の各領域と共有する正本である。

```
 0. テナントのコンテキスト（SET LOCAL app.tenant_id）と、メタデータの版を読む（9.2 節）
 1. ACL：作成・書き込みの行の判定と、変えたフィールドの判定（access-control の 5 節）
 2. 既定値（作成のとき）と型の変換
 3. 同期のレコードのルール（保存の前）：値の設定、中止（workflow-engine の 6 節）
 4. 辞書の検証：必須、型、長さ、選択肢、参照の存在と絞り込み
 5. 番号（作成のとき。8 節。番号は保存の前の別のトランザクションで取っておく）
 6. 行の書き込み（version の条件付き）、ext_index、record_change（7 節）、journal_entry
 7. 同期のレコードのルール（保存の後）：他のレコードの更新（上限あり）
 8. SLA の条件の評価と計時の行・タイマー（sla-and-calendars の 6 節）
 9. フローのトリガーと、条件の待ちの照合（workflow-engine の 4 節）
10. outbox：record.changed（変わったフィールドの ID の一覧。値は入れない）
11. コミット
```

- 6〜10 の書き込みは、どれか 1 つが失敗すれば全体を巻き戻す。監査の履歴が欠けたレコードの変更は起きない（NFR-010）。
- 索引のないテナントのフィールドでの絞り込みは、索引のある条件で 10,000 行以下に絞った後にだけ許す。超えるときは 422 `unindexed_filter` を返し、画面は索引を付けるか検索を使うよう示す。

DT-DICT-001（書き込みの値の検証）：

| # | フィールド | 値 | 状況 | 結果 |
| --- | --- | --- | --- | --- |
| 1 | 存在しない、削除済み、非表示 | - | - | 422 `unknown_field` |
| 2 | 読み取り専用（実効の辞書） | 今の値と違う | 利用者・API の書き込み | 403 `field_read_only` |
| 3 | 読み取り専用 | 今の値と同じ | - | 無視する（フォームは全体を送る） |
| 4 | 必須 | 空 | 保存の後の値が空 | 422 `mandatory` |
| 5 | 型・長さ・書式が合わない | - | - | 422 `invalid_value` |
| 6 | `choice` | 集合にない | 今の値と違う | 422 `invalid_choice` |
| 7 | `choice` | 無効にした値 | 今の値と同じ | 許す |
| 8 | `reference` | 存在しない、別のテナント、絞り込みの条件に合わない | - | 422 `invalid_reference`（別のテナントも同じ応答にする） |
| 9 | - | - | 上の行に当たらない | 許す |

DT-DICT-002（テナントのフィールドの型の変更）：

| # | 元の型 | 新しい型 | 結果 |
| --- | --- | --- | --- |
| 1 | `string`（長さ n） | `string`（長さ m ≥ n） | 即時に反映 |
| 2 | `string` | `text` | 即時に反映。索引を外す（`text` は索引にできない） |
| 3 | `integer` | `decimal` | 即時に反映。索引の値は同じ |
| 4 | `string`（長さ n） | `string`（長さ m < n） | 409。新しいフィールドと写すジョブを案内する |
| 5 | そのほか | - | 409 `incompatible_type_change` |

## 6. フィールド・テーブルの変更と削除

- フィールドの追加・ラベルの変更・上書きは、DDL を発行せず、メタデータの版を上げるだけで即時に反映する（ADR-0003 の Confirmation）。
- **フィールドの削除は 2 段で行う。** まず非表示（`hidden_at`）にし、フォーム・リスト・API・フローから見えなくする。値は保持する。30 日後に、値を消すジョブ（`ext` のキーと `ext_index` の行を消す）を動かす。30 日の間は戻せる。フローや ACL が参照しているフィールドは、参照を外すまで削除できない（409 `field_in_use`）。
- テナントのテーブルの削除は、行が 0 件のときだけ許す。行があるときは、先にデータを消すジョブを別に動かす（監査の履歴に残す）。
- 組み込みのフィールドは、削除できない。非表示（画面から隠す）は上書きで行う。

## 7. 監査の履歴と作業メモ（[ADR-0009](../decisions/0009-record-audit-history-and-journal.md)）

### 7.1 表

| 表 | 列 | 備考 |
| --- | --- | --- |
| `record_change` | `tenant_id`、`table_id`、`record_id`、`record_version`、`op`（`insert` / `update` / `delete`）、`changed_at`、`tx_id`、`actor_kind`（`user` / `flow` / `rule` / `integration` / `system`）、`actor_id`、`real_actor_id`（成り代わりのとき本人）、`channel`（`ui` / `api` / `email` / `flow` / `import` / `package`）、`cause_id`（フローの実行・ルール・取り込みの ID）、`changes`（`{field_id: [old, new]}`）、`snapshot`（削除のときだけ、削除の前の全体の値） | 月ごとのパーティション。保存ごとに 1 行 |
| `journal_entry` | `tenant_id`、`table_id`、`record_id`、`id`、`kind`（`work_note` / `comment`）、`body`、`created_by`、`real_actor_id`、`created_at`、`channel`、`source_message_id`（メールから） | 月ごとのパーティション。編集・削除しない |
| `audit_digest` | `tenant_id`、`day`、`partition`、`row_count`、`chain_hash` | 日次。S3 Object Lock（compliance モード）にも写す |

- `record_change` は保存ごとに 1 行にし、変えたフィールドを `changes` にまとめる。フィールドごとに 1 行にすると、S1 の書き込みが数倍になる。フィールドの履歴の画面は、`(tenant_id, table_id, record_id, changed_at)` の索引で読み、`changes` を展開する。
- **監査の対象**：組み込みのテーブル（`task`、`ci`、利用者・グループ・ロール・ACL・フロー・SLA の定義など）はすべて対象にし、止められない。テナントのテーブルは既定で対象にし、管理者が止められる（止めた操作自体を履歴に残す）。フィールドの単位で外せるのは、テナントのフィールドだけにする。
- 監査から外す列：`version`、`updated_at`、`updated_by`（行に同じ値がある）。
- `text` の値は、変更の前後を全体で残す（最大 64 KB。3.3 節の上限と同じ）。
- 作業メモとコメントは、保存と同じトランザクションで `journal_entry` に書く。`record_change` には「作業メモを 1 件追加」だけを残し、本文は重ねて持たない。

### 7.2 改ざんの防止

- アプリの DB のロールは、`record_change` と `journal_entry` に `INSERT` と `SELECT` だけを持つ。`UPDATE`・`DELETE` の権限を与えない。
- 保持の期間を過ぎたパーティションは、保守の専用のロールが `DETACH` して消す。個々の行は消さない。
- 日次のジョブが、テナント・日ごとに行のハッシュを順に連ねた `chain_hash`（前日の値を含む）を計算し、S3 Object Lock に置く。監査の担当は、エクスポートした履歴とハッシュを突き合わせて改ざんのないことを確かめられる（Story `audit-digest-verify`）。

### 7.3 保持

- **既定の保持は 7 年にする**（決定。15 節）。テナントは延ばせる（最大 10 年）が、短くはできない。法務の確認（[intent.md](../intent.md) の L4）の結論で既定の値を変える。L4 が済むまで、E2 の監査の履歴の `spec.md` は承認しない。
- レコードを削除しても、監査の履歴は保持の期間まで残す。削除のときの `snapshot` から、保持の期間の中なら管理者がレコードを戻せる（戻したことも履歴に残す）。
- 個人の削除の請求と監査の履歴の関係（利用者の参照を仮名にするか）は、法務の確認（L1・L4）の後に `security.md` で決める。

### 7.4 閲覧

- 履歴の画面・API は、履歴の各フィールドに、今のフィールドの読み取りの ACL を効かせる（[access-control.md](access-control.md) の 6 節）。読めないフィールドの変更は、変更があったことも出さない。
- 監査の担当のロール（`auditor`）は、テナントの全テーブルの履歴を読み取り専用で読める。レコードの本体の ACL は `auditor` を別に扱う（access-control の 3.3 節）。

## 8. 番号（[ADR-0008](../decisions/0008-record-numbering.md)）

| 表 | 列 |
| --- | --- |
| `number_def` | `tenant_id`、`id`、`table_id`、`prefix`、`digits`（既定 7）、`start` |
| `number_counter` | `tenant_id`、`number_def_id`、`next` |

- 組み込みの既定の接頭辞：インシデント `INC`、問題 `PRB`、変更 `CHG`、要求 `REQ`、要求の品目 `RQI`、実行のタスク `FTK`、問題のタスク `PRT`、変更のタスク `CHT`。テナントは変えられる。
- テナントのクラスは、自分の定義がなければ親の定義（と数）を共有する。テナントの独立のテーブルは、番号を持つかを選べる。
- **番号は、保存とは別の短いトランザクションで取る。** `UPDATE number_counter SET next = next + 1 ... RETURNING next - 1` を単独でコミットしてから、保存のトランザクションを始める。保存が失敗すると、その番号は使われない（欠番になる）。保存のトランザクションの中で取ると、数の行のロックが保存の終わり（p99 700ms）まで続き、同じテナントのインシデントの作成が直列になるためである。
- 一括の取り込みは、1 回で N 個（最大 1,000）をまとめて取る。
- 約束すること：テナント・番号の定義の中で一意（`(tenant_id, number)` の一意の索引。接頭辞を含む文字列）。取った順に増える。**欠番のないことは約束しない**（画面の文言と契約の文書に書く）。
- 桁数を超えたら、桁を増やして続ける（`INC9999999` の次は `INC10000000`）。桁数を変えても既存の番号は書き換えない。本家は既存のレコードにも桁の埋めを効かせる（2 節）が、本システムは番号を不変の識別子として扱う（差異）。
- 接頭辞の変更は、新しい番号だけに効く。既存の番号は変えない。

## 9. メタデータの版（[ADR-0010](../decisions/0010-metadata-versions-and-config-packages.md)）

### 9.1 表

| 表 | 列 |
| --- | --- |
| `tenant_meta` | `tenant_id`、`meta_version`（単調に増える整数）、`acl_version`（[access-control.md](access-control.md) の 7 節） |
| `meta_change` | `tenant_id`、`meta_version`、`committed_at`、`actor_id`、`real_actor_id`、`package_apply_id`、`objects`（変えたメタデータのオブジェクトの `stable_key` と前後のハッシュ） |
| メタデータの各表（`dict_*`、`acl_rule`、`flow_def`、`record_rule`、`sla_def`、`calendar` など） | 共通の列：`stable_key`、`rev`、`content_hash`、`updated_in_version`、`deleted` |

### 9.2 反映

- メタデータの変更は、1 つのトランザクションで、オブジェクトの行、`tenant_meta.meta_version += 1`、`meta_change`、outbox（`meta.changed`）を書く。同じテナントのメタデータの変更は、`tenant_meta` の行のロックで直列になる（S1 の見込みでは、1 テナントで毎分数件）。
- App と Engine は、要求・ステップの始めにテナントのコンテキストを設定する同じ往復で `meta_version` を読む。手元のコンパイル済みの辞書・判定・ルールの版が古ければ、読み直す。キャッシュのキーは `(tenant_id, meta_version)` にする。変更のコミットの後に始まった要求が、古いメタデータで保存することはない。
- `meta.changed` は、Valkey の通知で各プロセスに先に知らせる（最適化）。通知を落としても、上の読み取りで正しさは保たれる。
- コンパイル済みの辞書は、プロセスの中の LRU（テナント × 版、最大 2,000 件）と Valkey に置く。Valkey は失われてもよい（DB から作り直す）。

## 10. 設定のパッケージ（開発 → 本番）（[ADR-0010](../decisions/0010-metadata-versions-and-config-packages.md)）

### 10.1 対象

- 移送するのは**メタデータだけ**：辞書（テーブル・フィールド・上書き・選択肢）、ACL の規則、レコードのルール、フロー、SLA の定義、カレンダー（祝日の集合の参照を含む）、フォーム・リストの配置と `view_rule`・画面の規則、翻訳（`translation`）、通知のテンプレート、カタログの品目の定義、割り当ての規則。レポートとダッシュボードは、`packaged` の印の付いたものだけを移す（統合で決めた。[reports.md](reports.md) の 3 節）。
- 移送しないもの：レコード（インシデント、CI、ナレッジの記事）、利用者、グループの所属、番号の数、秘密の値（Webhook の資格情報）。グループ・ロール・利用者への参照は、`stable_key`（グループの名前など）で持ち、適用先で解決する。
- 移送は、同じ顧客の、同じセルのテナントの間でだけ行う（[ADR-0002](../decisions/0002-tenancy-and-isolation.md)）。顧客の設定で、移送の元と先の組を登録する（例：`dev` → `test` → `prod`）。

### 10.2 ID と安定したキー

- メタデータのオブジェクトは、作成のときに UUIDv7 の `id` と `stable_key`（辞書は `field:<table>.<field>` の形、そのほかは `id` と同じ）を持つ。**パッケージで移したオブジェクトは、移送先でも同じ `id` を使う。** 主キーは `(tenant_id, id)` なので、テナントをまたいで同じ `id` でも衝突しない。そのため、パッケージの中の参照を書き換えない。本家は移送のときに参照の ID を書き換える（2 節）。
- 移送先で先に同じ `stable_key` のオブジェクトを手で作っていたとき（例：本番で先に同じ名前のフィールドを作った）は、`id` が違う。これは衝突として扱う（DT-PKG-001 の 5 行）。

### 10.3 パッケージの作り方と形

```
開発のテナント：管理者が「作業のパッケージ」を開く
   → そのパッケージを「今のパッケージ」にしている間のメタデータの変更は、meta_change に package_id を付けて記録する
   → 閉じると、変更したオブジェクトごとに「元の版のハッシュ（base_hash）」と「最後の内容（content）」を集めて固める

パッケージ（JSON、署名付き）
 { id, source_tenant_id, created_at, created_by, items: [
     { stable_key, id, kind, op: upsert | delete, base_hash, content, content_hash, depends_on: [stable_key...] } ...
 ], signature }
```

- 固めたパッケージは変えない。直すときは新しいパッケージを作る。
- 署名は、セルの KMS の鍵で行う。移送先は署名と、元のテナントが登録済みの組であることを確かめる。

### 10.4 プレビューと衝突

移送先で、項目ごとに次の表で判定する。すべての項目の判定を画面に出し、衝突は人が「パッケージの内容で上書き」か「移送先の内容を残す」を選ぶ。

DT-PKG-001：

| # | 操作 | 移送先のオブジェクト | 比較 | 判定 |
| --- | --- | --- | --- | --- |
| 1 | - | - | 依存（`depends_on`）が、移送先にもパッケージにもない | エラー（`missing_dependency`）。コミットできない |
| 2 | `upsert` | ない | - | 作成する |
| 3 | `upsert` | ある | 移送先のハッシュ ＝ `content_hash` | 飛ばす（適用済み） |
| 4 | `upsert` | ある | 移送先のハッシュ ＝ `base_hash` | 更新する |
| 5 | `upsert` | ある（`stable_key` が同じで `id` が違う、またはハッシュが `base_hash` とも `content_hash` とも違う） | - | 衝突。人が決める |
| 6 | `delete` | ない、または削除済み | - | 飛ばす |
| 7 | `delete` | ある | 移送先のハッシュ ＝ `base_hash` | 削除する（6 節の 2 段の削除に従う） |
| 8 | `delete` | ある | 移送先のハッシュ ≠ `base_hash` | 衝突。人が決める |
| 9 | - | - | 辞書の型の変更が DT-DICT-002 で許されない | エラー（`incompatible_type_change`） |

- 本家は名前と更新の時刻で衝突を見つける（2 節）。本システムは内容のハッシュで比べる。時計のずれと、同じ内容の二重の適用で誤った衝突を出さないためである。

### 10.5 適用と取り消し

- **適用は 1 つのトランザクションで行う。** すべての項目の書き込み、`meta_version` の 1 回の増加、`meta_change`（`package_apply_id` 付き）、適用の記録を同じトランザクションで書く。途中で失敗したら、何も変わらない。
- 1 つのパッケージは 5,000 項目までにする。超えたら分ける（大きなトランザクションで、テナントのメタデータの変更を長く止めないため）。
- 適用の記録には、各項目の適用の前の内容を残す。**取り消しは、前の内容から作った逆のパッケージを適用して行う。** 取り消しも、同じプレビューと衝突の判定を通る（適用の後に移送先で手で変えた項目は衝突になる）。
- 適用の権限：移送先で `tenant_admin`。本番のテナントへの適用は、顧客の設定で「別の人の承認」を必須にできる（既定はオン）。承認は [workflow-engine.md](workflow-engine.md) の承認の仕組みを使う。

## 11. 障害のときの振る舞い

| 障害 | 振る舞い |
| --- | --- |
| Aurora の writer のフェイルオーバー | 保存が数十秒失敗する。画面と API は同じ要求を送り直す。番号を取った後に保存が失敗したら、その番号は欠番になる |
| Valkey が落ちる | コンパイル済みの辞書を DB から作り直す。応答は遅くなるが正しい |
| `meta.changed` の通知の欠け | 要求の始めの `meta_version` の読み取りで追いつく |
| 索引を写すジョブの途中の停止 | ジョブは `(field_id, 最後の record_id)` から再開する。完了までそのフィールドは「索引の準備中」 |
| 日次のハッシュの鎖のジョブの失敗 | 翌日に前日の分から計算し直す。2 日続けて失敗したら SEV3 |
| パッケージの適用の途中の失敗 | トランザクションが巻き戻る。適用の記録は `failed` と理由を残す |

## 12. セキュリティ

- テナントのテーブル・フィールドの名前、選択肢のラベル、上書きの説明は、画面に出す前にエスケープする。テナントの HTML を描かない（[intent.md](../intent.md) の Non-goals）。
- `ext` のキーはフィールドの ID で、利用者の入力のキーを受けない。辞書にないキーは 422 にする（DT-DICT-001 の 1 行）。
- 参照の検証で、別のテナントの ID と存在しない ID を同じ応答にする（DT-DICT-001 の 8 行）。ID の推測で他のテナントの存在を知られないようにする。RLS がそもそも別のテナントの行を返さない。
- 監査の履歴は追記だけ（7.2 節）。保守のロールの操作は、運用の監査ログ（`security.md`）に残す。
- パッケージは署名と登録済みの組で確かめる。パッケージに秘密の値を入れない。
- パッケージの JSON に、テナントのフィールドの名前などの設定の情報が入る。ダウンロードは `tenant_admin` だけにし、運用の監査ログに残す。

## 13. テスト

### 13.1 決定表

- DT-DICT-001（値の検証）、DT-DICT-002（型の変更）、DT-PKG-001（パッケージのプレビュー）を、`spec.md` から読む表駆動テストにする。

### 13.2 性質ベーステスト（fast-check、DB は Testcontainers の PostgreSQL）

- **PROP-DICT-001（保存と読み出し）**：任意の辞書の定義（型・上書き・継承の深さ）と、それに合う値の組で、保存して読み出すと同じ値が返る（ADR-0003 の Confirmation）。合わない値は、DT-DICT-001 のどれかの行で拒否され、DB が変わらない。
- **PROP-DICT-002（索引の一致）**：任意の保存・更新・削除・フィールドの索引の付け外し・写すジョブの途中の停止と再開の列の後で、`ext_index` の値は `ext` の値と一致する。
- **PROP-DICT-003（監査の完全）**：任意の保存の列（途中で失敗する保存を含む）で、コミットした保存と `record_change` の行が 1 対 1 に対応し、`changes` を順に適用すると今の行の値になる。
- **PROP-DICT-004（番号の一意と増加）**：任意の並行の作成（失敗を含む）で、番号は重ならず、同じ番号の定義の中でコミットの順に並べた番号は増える。
- **PROP-PKG-001（適用の冪等）**：同じパッケージを 2 回適用すると、2 回目はすべて「飛ばす」になり、`meta_version` を上げない。
- **PROP-PKG-002（取り消しで戻る）**：任意のパッケージを適用し、その取り消しを適用すると、移送先のメタデータは適用の前と同じハッシュになる（その間に手で変えていないとき）。
- **PROP-PKG-003（原子性）**：適用の任意の点で失敗を注入すると、移送先のメタデータは適用の前のまま。

### 13.3 障害注入と結合テスト

- 保存のトランザクションのコミットの直前にプロセスを落とし、行・`ext_index`・`record_change`・outbox のどれも残らないことを確かめる。
- テナントのフィールドの追加・名前の変更の禁止・削除が、DDL を発行しないこと（マイグレーションの記録が増えない）。
- 2 つのプロセスで、メタデータの変更の直後の保存が新しい版の検証を使うこと。

## 14. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E1 | `tenant-meta-and-rls-baseline` | `tenant_meta`、RLS のポリシーの検査を辞書の表に広げる |
| E2 | `dictionary-core` | 3 節の表、組み込みの定義の読み込み、実効の辞書のコンパイル、Zod のスキーマの生成（PROP-DICT-001） |
| E2 | `field-types-and-validation` | 3.3 節の型と DT-DICT-001 |
| E2 | `class-inheritance-and-overrides` | 3.4 節、上書き、深さの上限 |
| E2 | `task-and-ci-physical-tables` | 4.1 節の表と索引、`version` の楽観的な排他 |
| E2 | `ext-and-extension-index` | 4.2 節、索引を写すジョブ（PROP-DICT-002） |
| E2 | `reference-integrity` | 4.3 節、`on_delete`、日次の整合の検査 |
| E2 | `save-pipeline` | 5 節の順序（ACL・ルール・SLA・フローの差し込み口は各 Epic で埋める） |
| E2 | `field-lifecycle` | 6 節の非表示と消すジョブ、DT-DICT-002 |
| E2 | `record-audit-and-journal` | 7 節（PROP-DICT-003）。L4 の確認待ち |
| E2 | `audit-digest-verify` | 7.2 節のハッシュの鎖と、監査の担当の突き合わせの道具 |
| E2 | `record-numbering` | 8 節（PROP-DICT-004） |
| E2 | `meta-version-cache` | 9 節の版とキャッシュの入れ替え |
| E2 | `config-packages` | 10 節（DT-PKG-001、PROP-PKG-001〜003） |
| E6 | `incident-number-and-audit-view` | インシデントの画面の番号・履歴・作業メモの表示（読めないフィールドの除外を含む） |
| E11 | `table-api-dictionary-driven` | REST のテーブルの API を実効の辞書から作る（`api-and-integrations.md` と一緒に） |
| E12 | `task-table-scale-test` | `task` 7,000 万行・索引の数を変えたリストの応答時間の計測（NFR-001）。パーティションの判断の材料 |

## 15. 未解決の問い

### 決定（2026-09-28、既定案）

- **番号を保存と別のトランザクションで取る**：欠番を許し、作成の直列を避ける（8 節、ADR-0008）。
- **既存の番号の桁を書き換えない**：番号を不変の識別子にする（本家との差異。8 節）。
- **監査の履歴は保存ごとに 1 行**：フィールドごとの行にしない（7.1 節、ADR-0009）。
- **既定の保持は 7 年、延長は 10 年まで**：L4 の結論で見直す（7.3 節）。
- **S1 で `task` をパーティションに分けない**：部分索引で進行中の問い合わせを速くする（4.1 節、ADR-0007）。
- **参照のフィールドは必ず索引に写す**：参照先の削除と逆向きの参照の一覧のため（4.2 節）。
- **レコードのクラスを変えない**（3.4 節）。
- **パッケージのオブジェクトは移送先でも同じ ID**：参照を書き換えない（10.2 節）。
- **辞書に `searchable` の列を持つ**（3.2 節。統合で決めた）。
- **配置・画面の規則・翻訳をパッケージの対象にし、レポートは `packaged` の印の付いたものだけ**（10.1 節。統合で決めた）。
- **CMDB の `multi` の属性だけを、辞書の型の例外にする**（3.3 節。統合で決めた）。
- **本番への適用に別の人の承認を既定で要る**（10.5 節）。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| 監査の履歴の保持の年数と、削除の請求との関係（L1・L4） | 法務の確認の後、`security.md` で |
| `task` のパーティションの分け方（テナントのハッシュか完了の年か） | E12 の `task-table-scale-test` の後、S2 の前 |
| 索引の上限（20）とテナントのフィールドの上限（300）の値 | E2 の計測 |
| 通貨・複数選択の型 | MVP の後。要る Epic で |
| テナントをまたぐ移送（別のセルの開発のテナント） | 専用のセルの顧客が出る S2 の前に、制御の面を経る形を検討する |

## 16. quality.md・runbooks・data-model への項目

### quality.md

- 監査の履歴の欠け（保存と `record_change` の突き合わせ）：常に 0 件。
- 日次のハッシュの鎖の検証の失敗：0 件。
- 存在しない参照の件数（日次）。
- `ext_index` と `ext` の食い違いの件数（日次の抜き取り）：0 件。
- 保存の p99（NFR-002）の内訳（ルール・検証・書き込み）。
- `unindexed_filter` の件数（索引を付ける候補の発見に使う）。
- パッケージの適用の失敗の割合と、衝突の件数。

### runbooks

- `audit-chain-mismatch.md`：ハッシュの鎖の検証の失敗の調べ方（行の欠け・書き換え・ジョブの誤り）と、セキュリティの事案への引き上げ。
- `extension-index-backfill.md`：索引を写すジョブの進み具合の確かめ方、止まったときの再開。
- `package-apply-failure.md`：パッケージの適用の失敗と取り消しの手順。
- `dangling-reference.md`：存在しない参照の直し方。
- `number-counter-exhausted-or-reset.md`：番号の定義の誤設定（開始の番号の巻き戻し）の検出と直し方。

### data-model（索引への追加の提案）

| 置き場所 | 中身 |
| --- | --- |
| Aurora `dict_table`、`dict_field`、`dict_override`、`dict_choice_set`、`dict_choice` | 3.2 節 |
| Aurora `task`、`ci`、`custom_record` | 4.1 節。`ext` と `version` を持つ |
| Aurora `ext_index` | 4.2 節。`value_text`・`value_number`・`value_time`・`value_ref` |
| Aurora `record_change`、`journal_entry` | 7.1 節。月ごとのパーティション、追記だけ |
| Aurora `audit_digest`、S3 Object Lock の日次のハッシュ | 7.2 節 |
| Aurora `number_def`、`number_counter` | 8 節 |
| Aurora `tenant_meta`、`meta_change` | 9.1 節 |
| Aurora `config_package`、`config_package_apply`（適用の記録、前の内容） | 10 節 |

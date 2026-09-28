# Metadata and runtime: Salesforce

ユニバーサルなデータ辞書（オブジェクト、項目、関係、レコードタイプ、選択リスト）、メタデータの版とキャッシュ、要求のコンパイル、DML の実行の順序、数式の言語と評価器、項目の型の変換と削除・復元の設計。土台は [ADR-0002](../decisions/0002-custom-object-storage.md)（保存の形）と [ADR-0003](../decisions/0003-metadata-driven-runtime.md)（版とコンパイル）。この文書で決めたことは、次の 4 つの ADR にある。

- データ辞書は、項目の ID と、オブジェクトの中で再利用しない短い番号（`field_no`）を分けて持つ。型の変換は新しい番号へ写して切り替え、削除は印を付けて 15 日保つ（[ADR-0006](../decisions/0006-data-dictionary-and-field-lifecycle.md)）。
- コンパイル済みのスナップショットを、オブジェクトごとの内容で番地を決めた部品に分け、変わった部品だけをコンパイルし直す（[ADR-0007](../decisions/0007-segmented-metadata-snapshots.md)）。
- DML は 13 の手順で処理し、項目の変更の履歴・共有の評価・outbox は確定の直前に最上位で 1 回だけ行う。保存の前・後の手順は、フローとトリガー（E13）を並べるため 3a・3b・7a・7b に分ける。同じレコードの再保存は、入れ子の保存として数える（[ADR-0008](../decisions/0008-dml-order-of-execution.md)）。
- 数式は表計算に寄せた独自の言語にし、決定性で 4 つに分けて、SQL にするか評価器で判定するか、索引にできるかを決める。数式の値は、参照する項目をすべて読める人にだけ返す（[ADR-0009](../decisions/0009-formula-language-and-evaluator.md)）。

本家の振る舞いは、2026-09-28 に次の資料で確かめた。確かめられなかったものは「未検証」と書く。

## 1. 目的と範囲

| 範囲に含む | 範囲に含まない（担当の領域） |
| --- | --- |
| データ辞書の表と、項目の型・上限 | `records` とピボットの表の物理の形（[data-storage.md](data-storage.md)） |
| メタデータの版、スナップショット、キャッシュ、無効化 | デプロイの形式と、組織の間の差分（sandboxes-and-deploy の領域） |
| 要求のコンパイルの段と、コンパイル結果のキャッシュ | 問い合わせの言語の文法と計画（[query-language-and-api.md](query-language-and-api.md)） |
| DML の実行の順序と、再帰の規則 | フローのエンジンの中身、承認、積み上げ集計の式（automation-flows の領域） |
| 数式の言語、型、評価器、SQL へのコンパイル | 権限・共有の判定の中身（[sharing-and-record-access.md](sharing-and-record-access.md)） |
| 項目・オブジェクトの型の変換、削除、復元、確定 | 上限の値の最終の決定（governor-limits の領域） |

## 2. 本家の仕組み（確かめたこと）

| 項目 | 本家 | 出典 |
| --- | --- | --- |
| データ辞書 | オブジェクトの定義を MT_Objects、項目の定義を MT_Fields（型、索引の要否、位置 FieldNum）に持つ | [Platform Multitenant Architecture](https://architect.salesforce.com/docs/architect/fundamentals/guide/platform-multitenant-architecture.html)（以下「MT」） |
| 値の置き場所 | MT_Data の文字列の flex 列（Value0〜ValueN）。列の数は資料に書かれていない（未検証） | MT |
| 型の変更 | 項目の値のために新しい列を割り当て、既存の値を一括で写し、メタデータの指す先を切り替える。変換の間も読める | MT |
| 項目の削除 | 消した項目と値は、確定するか期間が過ぎるまで、ごみ箱から戻せる（期間の日数は項目については未検証） | MT |
| メタデータのキャッシュ | よく使うメタデータを、大きなメタデータのキャッシュに持つ。コンパイル済みのコードは組織ごとの MRU のキャッシュに持つ | MT |
| 保存の順序 | 元のレコードを読む → 要求の値を当ててシステムの検証 → 保存の前のフロー → before トリガー → システムの検証と入力規則 → 重複の規則 → 保存（未確定）→ after トリガー → 割り当てのルール → 自動応答 → ワークフロー（項目の更新があれば、トリガーをもう 1 回だけ） → エスカレーション → Process Builder など → 保存の後のフロー → エンタイトルメント → 親の積み上げ集計 → 祖父母の積み上げ集計 → 条件に基づく共有の評価 → 確定 → 確定の後の処理（メール、非同期の処理） | [Apex Developer Guide](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_apex_developer_guide.pdf)（Winter '27 版）の「Triggers and Order of Execution」 |
| 再帰の保存 | 再帰の保存では、割り当てのルールから祖父母の積み上げ集計まで（9〜17）を飛ばす | 同上 |
| 一括の単位 | API の要求は、200 件ずつの塊でトリガーを動かす | 同上 |
| 数式の大きさ | 3,900 文字まで。保存時の大きさ 4,000 バイトまで。コンパイル後の大きさ 15,000 バイトまで。他の数式項目を参照すると、その大きさが加わる | [Tips for Reducing Formula Size](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_formula_size_tipsheet.pdf)（Winter '27 版） |
| 数式の保存時の大きさ | ヘルプの記事の検索結果の要約では「保存時も 15,000 バイト」と読めた。上の資料（4,000 バイト）と食い違う。ヘルプの本文は読めなかった（未検証） | [Formula Field Limits and Restrictions](https://help.salesforce.com/s/articleView?language=en_US&id=platform.formula_field_limits.htm&type=5) |
| 数式の索引 | 決定的な数式には索引を張れる。他のオブジェクトを参照する数式、時刻で変わる数式には張れない | [Best Practices for Deployments with Large Data Volumes](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_large_data_volumes_bp.pdf)（以下「LDV」） |
| 関係の数 | カスタムオブジェクトは 40 の関係まで持てる | [SOQL and SOSL Reference](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_soql_sosl.pdf)（Winter '27 版）の「Understanding Relationship Query Limitations」 |
| 項目の数、主従の数、積み上げ集計の数、選択リストの値の数、数式がたどれる関係の数 | 公式の資料では確かめられなかった（未検証） | — |

## 3. データ辞書（ADR-0006）

### 3.1 表

メタデータの表は、全て `org_id` を主キーの先頭に置き、RLS をかける（[ADR-0005](../decisions/0005-tenancy-and-governor-limits.md)）。各行は、作られた版（`created_version`）と最後に変わった版（`updated_version`）を持つ。

| 表 | 主な列 | 備考 |
| --- | --- | --- |
| `md_objects` | `object_id`、`api_name`、`label`、`plural_label`、`kind`（`standard`・`custom`）、`owd`、`grant_via_hierarchy`、`name_kind`（`text`・`autonumber`）、`autonumber_format`、`next_field_no`、`field_history_enabled`、`allow_activities`（活動の `what` になれるか。[sales-objects.md](sales-objects.md) の 3.6 節）、`deleted_at` | 標準オブジェクトも行として持つ（組織の作成時に種から入れる） |
| `md_fields` | `field_id`（UUIDv7）、`object_id`、`field_no`、`api_name`、`label`、`type`、`type_params`（JSONB）、`required`、`unique`、`unique_case_sensitive`、`external_id`、`indexed`、`default_expr`、`help_text`、`data_class`（`none`・`personal`・`sensitive`。[ADR-0038](../decisions/0038-sandbox-types-and-masked-copy.md)）、`searchable`（1 オブジェクト 20 まで。[ADR-0031](../decisions/0031-search-index-and-japanese-analysis.md)）、`track_history`（1 オブジェクト 20 まで。[ADR-0047](../decisions/0047-field-history-tracking-and-retention.md)）、`state`（`active`・`converting`・`building`・`deleted`）、`deleted_at` | 3.2 節。`building` は積み上げ集計の作成・変更の間（[automation-flows.md](automation-flows.md) の 7.4 節） |
| `md_relationships` | `field_id`、`child_object_id`、`parent_object_id`、`kind`（`lookup`・`master_detail`）、`master_order`（1・2）、`child_relationship_name`、`on_parent_delete`（`set_null`・`restrict`・`cascade`）、`reparentable` | 主従の 1 本目を `records.parent_id` に写す（[data-storage.md](data-storage.md) の 3.1 節） |
| `md_picklists`、`md_picklist_values` | 選択リストの ID、`restricted`、`global`。値の `value_id`、`api_value`、`label`、`sort`、`active`、`is_default`、`attrs`（JSONB。フェーズ・リードの状態・ToDo の状態の意味。[sales-objects.md](sales-objects.md) の 3.4.1 節） | 値は `value_id` で持つ。ラベルの変更で `records` を書き換えない |
| `md_record_types`、`md_record_type_values` | `record_type_id`、`object_id`、`api_name`、`active`。レコードタイプごとに使える選択リストの値 | |
| `md_dependencies` | `from_kind`、`from_id`、`to_field_id` | 数式・入力規則・フロー・レイアウト・リストビュー・共有ルールが参照する項目。コンパイルの時に作る |
| `md_versions` | `version`、`created_at`、`actor_id`、`source`（`setup`・`deploy`・`system`）、`summary` | 版ごとに 1 行 |
| `md_changes` | `version`、`entity_kind`、`entity_id`、`op`（`add`・`update`・`delete`・`restore`）、`before`、`after` | 版の差分。直前の版へ戻すデプロイは、差分を逆に当てた新しい版として作る（ADR-0003） |

- 組織の今の版は `orgs.metadata_version` に持つ（ADR-0003）。
- API の名前は組織の中で一意にする。**標準は接頭辞なしの小文字のスネーク（`account`、`close_date`）、カスタムは `x_` の接頭辞（`x_region`、`x_contract`）** にする。本家の `__c` の接尾辞は使わない（[リポジトリ共通の ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。接頭辞で分けるので、標準オブジェクトに後から項目を足しても、組織のカスタム項目と名前がぶつからない。
- 名前の変更はメタデータだけで済む。`records.data` のキーは `field_no` なので、値を書き換えない。

### 3.2 `field_id` と `field_no`

- `field_id` は UUIDv7 で、メタデータ・デプロイ・監査で項目を指す。**一意の範囲は組織の系統（本番の組織と、その Sandbox）の中**にする。Sandbox は元の組織の ID をそのまま使うため（[ADR-0038](../decisions/0038-sandbox-types-and-masked-copy.md)、ADR-0006 の 2026-09-28 の注記）。全ての表の主キーの先頭は `org_id` なので衝突しない。
- `field_no` は、オブジェクトの中の連番（`md_objects.next_field_no` から採る）で、**再利用しない**。`records.data` の JSONB のキーは、`field_no` の 10 進の文字列にする（`{"12": "..."}`）。
- 分ける理由：ADR-0002 は「項目の ID をキーにする」とした。UUID をそのままキーにすると、500 項目のオブジェクトでキーだけで 1 行 18KB になる。`field_no` は再利用しないので、名前の変更と削除に強いという ADR-0002 の意図を保ったまま、行を小さくできる。
- 型の変換は、新しい `field_no` を割り当てて行う（5 節）。1 つの `field_id` が、変換の前後で 2 つの `field_no` を持つ時期がある。

### 3.3 項目の型

| 型 | `type_params` | `data` の中の値 | ピボット |
| --- | --- | --- | --- |
| `text` | `length`（1〜255） | 文字列 | `v_text`（正規化） |
| `text_area` | 255 まで | 文字列 | なし |
| `long_text`、`rich_text` | `length`（131,072 まで） | `data` に持たず `record_long_texts`（[data-storage.md](data-storage.md)） | なし |
| `number`、`percent` | `precision`（最大 18）、`scale` | 10 進の文字列（`"1234.50"`） | `v_num` |
| `currency` | `precision`、`scale`（JPY は 0） | 10 進の文字列 | `v_num` |
| `date` | — | `"2026-09-28"` | `v_ts`（UTC の 0 時） |
| `datetime` | — | `"2026-09-28T01:02:03.456Z"`（UTC、ミリ秒） | `v_ts` |
| `checkbox` | — | `true`・`false`（空はない） | `v_bool` |
| `picklist` | `picklist_id` | `value_id` | `v_text`（`value_id`） |
| `multi_picklist` | `picklist_id`、最大 100 個 | `value_id` の配列 | `v_text`（値ごとに 1 行） |
| `email`、`phone`、`url` | — | 文字列 | `v_text` |
| `lookup`、`master_detail` | 親のオブジェクト | 親の ID | `record_relationships` |
| `polymorphic_lookup` | 参照先にできるオブジェクトの一覧（活動の `who`・`what`） | `{"id": ..., "object": ...}` | `record_relationships`（参照先のオブジェクトの ID を行に含める。[sales-objects.md](sales-objects.md) の 3.6 節） |
| `formula` | 式、結果の型、`blank_as_zero` | 持たない（読む時に計算。7 節） | 実体化した時だけ（7.5 節） |
| `rollup_summary` | 子の関係、集計、条件 | 数値・日付の文字列（親に保存する） | `v_num`・`v_ts` |
| `autonumber` | 書式（`INV-{0000}`） | 文字列 | `v_text` |

- **空の値はキーを書かない。** `null` を書かないので、行が小さくなる。空の文字列は空として扱う（`""` を保存しない）。
- 数は JSON の数ではなく、10 進の文字列にする。JSON の数は JS の倍精度で丸まるため（ADR-0002）。
- `unique`・`external_id` は `text`・`number`・`email`・`autonumber` にだけ付けられる。

### 3.4 上限（S1 の初期値）

| 上限 | 値 | 本家 |
| --- | --- | --- |
| 組織のカスタムオブジェクト | 800 | 未検証 |
| オブジェクトの項目（標準を含む、削除中を含む） | 500 | 未検証 |
| オブジェクトの関係（参照・主従） | 40 | 40（SOQL and SOSL Reference） |
| オブジェクトの主従 | 2 | 未検証 |
| 主従の段（孫まで） | 3 | 未検証 |
| オブジェクトの積み上げ集計 | 25 | 未検証 |
| 索引を張る項目（`indexed`・`external_id`・名前を含む） | 50 | 本家はサポートへの依頼で張る（LDV） |
| 一意の項目 | 25 | 未検証 |
| 選択リストの値（有効なもの） | 1,000 | 未検証 |
| `records.data` の大きさ（長いテキストを除く） | 64KB | — |
| 1 回のメタデータの変更（1 つの版）で変える要素の数 | 10,000 | — |

- 上限は governor-limits の領域の一覧にも載せ、値はそちらを正とする。項目の数に削除中の項目を数えるのは、確定までキーが `records.data` に残るため。
- 64KB は、PostgreSQL が JSONB を TOAST に出す大きさ（約 2KB）を大きく超える。1 行の更新での書き直しの量を抑えるため、上限に近いオブジェクトは警告する（[data-storage.md](data-storage.md) の 3.3 節）。

## 4. 版、スナップショット、キャッシュ（ADR-0007）

### 4.1 版を上げる

- メタデータの変更は、Metadata のサービスだけが行う（architecture の 1.2 節）。1 つの変更は 1 つのトランザクションで、次の順に行う。
  1. 組織のメタデータの鍵の排他のロック（`pg_advisory_xact_lock`）を取る。
  2. 変更を検証する（名前の重複、上限、依存、数式の型の検査）。
  3. メタデータの表を書き、`md_changes` に差分を、`md_versions` に 1 行を書く。
  4. `orgs.metadata_version` を 1 つ上げる。
  5. outbox に `metadata.version_changed` を書く。
  6. 確定する。確定の後に、Relay が Valkey の今の版の値と Pub/Sub を更新する。
- 時間のかかる処理（型の変換、索引の作り直し、共有の再計算、項目の値の消去）は、確定の後に Worker で行う（ADR-0003）。確定の間の書き込みの止まりを p99 1 秒以内にする（NFR-004）。

### 4.2 部品に分けたスナップショット

ADR-0003 は「版ごとに 1 つのスナップショット」とし、大きな組織では差分のコンパイルが要るかもしれないとした。ここでは、次のように部品に分ける。

```
manifest(org, version)
 ├─ segment "object:<object_id>"  → hash_a   （オブジェクト・項目・関係・レコードタイプ・入力規則・数式の AST と型・フローの呼び出しの表・検索の項目・有効なトリガーの表（E13））
 ├─ segment "object:<object_id>"  → hash_b
 ├─ segment "picklists"            → hash_c
 ├─ segment "sharing"              → hash_d   （OWD、共有ルール、世代の番号）
 ├─ segment "permsets"             → hash_e   （権限セットの定義）
 ├─ segment "layouts:<object_id>"  → hash_f
 └─ segment "report_types"         → hash_g   （レポートの型。reports-and-dashboards.md の 3.2 節）
```

- **部品は内容で番地を決める。** 部品の鍵は、その部品の入力（メタデータの行と、参照する他の部品のハッシュ）と、コンパイルした部品の形の版の SHA-256 にする。同じ入力なら同じ鍵になる。形の版を含めるのは、新旧のタスクが同時に動いても互いの部品を読み違えないため（[delivery.md](delivery.md) の 5.1 節、[ADR-0063](../decisions/0063-org-staged-release-and-shadow-evaluation.md)）。
- 版が上がると、`md_changes` の差分から変わった部品と、それに依存する部品（数式が参照する親のオブジェクトなど）を求め、その部品だけコンパイルし直す。依存は `md_dependencies` から作る。
- **manifest は不変にする。** 部品の鍵の一覧だけを持ち、`(org_id, version)` をキーにする。
- 部品は組織をまたいで共有しない（中身に組織の ID が入る）。Sandbox の作成の直後は、元の組織と同じハッシュになるが、別の鍵の空間（`org_id` を鍵に含める）に置く。キャッシュの中身から他の組織の定義が見えないようにするため。

### 4.3 キャッシュ

| 層 | 鍵 | 中身 | 無効化 |
| --- | --- | --- | --- |
| L1（Runtime のプロセスの中の LRU） | 部品：`(org_id, hash)`、manifest：`(org_id, version)` | デシリアライズ済みの部品 | しない（不変）。LRU で追い出す。上限はタスクのメモリーの 25% |
| L2（Valkey） | `md:{o:<org_id>}:seg:<hash>`、`md:{o:<org_id>}:man:<version>` | シリアライズした部品（MessagePack＋zstd） | しない。7 日使われなければ TTL で消える |
| L3（Aurora） | メタデータの表 | 正本 | — |
| 今の版 | `md:{o:<org_id>}:cur` | 版の番号 | Pub/Sub で配り、プロセスは 5 秒ごとにも読み直す（ADR-0003） |

- 要求の開始時に今の版を読み、manifest を引く。部品は使う時に遅れて読む（1 件の要求は、多くの組織で数個のオブジェクトしか使わない）。
- L2 にない部品は、L3 から作る。同じ部品を複数のタスクが同時に作らないよう、Valkey の短い鍵（`SET NX`、10 秒）で 1 つだけが作り、他は待つ。待ちきれなければ自分で作る（Valkey の障害時も動く）。
- Valkey が使えない時は、L1 と L3 だけで動く。今の版は、DB の `orgs.metadata_version` を要求ごとに読む（1 行の主キーの読み）。

### 4.4 要求を版に固定する

- ADR-0003 のとおり、データを書くトランザクションは、メタデータの鍵の共有のロック（`pg_advisory_xact_lock_shared`）を取り、`orgs.metadata_version` が要求の開始時の版と同じかを確かめる。違えば、新しい版でコンパイルし直して 1 回だけやり直す。2 回目も違えば 503 `METADATA_CHANGED` と `Retry-After: 1` を返す。
- 読むだけの要求はロックを取らない。開始時の版で最後まで読む。途中でメタデータが変わっても、古い版のスナップショットで一貫した結果を返す。
- 共有の世代の番号も `sharing` の部品に入れる（[sharing-and-record-access.md](sharing-and-record-access.md) の 7 節）。1 つの要求は、1 つの版に固定されることで、1 つの世代にも固定される。

### 4.5 コンパイルの時間の予算

| 対象 | 予算（p99） | 超えた時 |
| --- | --- | --- |
| 1 つのオブジェクトの部品 | 200ms | 警告。E3 で測り、部品をさらに分けるかを決める |
| 1 回の版の変更での、部品のコンパイルの合計 | 5 秒 | 版の変更は確定する。コンパイルは要求の側で遅れて行う（K2 の 5 秒に入らなければ警告） |
| 組織の全部品（組織の作成、Sandbox の作成） | 30 秒 | 事前に Worker で作って L2 に置く |

## 5. 項目の型の変換と、削除・復元（ADR-0006）

### 5.1 型の変換の表

| 元 → 先 | 可否 | 変換できない値 |
| --- | --- | --- |
| `text` → `number`・`currency`・`percent` | 可 | 数として読めない値、桁の超過 |
| `text` → `date`・`datetime` | 可 | ISO 8601 として読めない値 |
| `text` → `picklist` | 可 | なし（ない値は、無効な値として選択リストに足す） |
| `text` → `long_text` | 可 | なし |
| `long_text` → `text` | 可 | 255 文字を超える値 |
| `number` 系 → `text` | 可 | 長さの超過 |
| `number` ↔ `currency` ↔ `percent` | 可 | 桁の超過 |
| `date` → `datetime` | 可 | なし（組織の既定のタイムゾーンの 0 時） |
| `datetime` → `date` | 可 | なし（組織の既定のタイムゾーンで日付に切る） |
| `picklist` → `text` | 可 | なし（`api_value` を入れる） |
| `picklist` ↔ `multi_picklist` | 可 | 複数から単数：2 つ以上の値を持つレコード |
| `lookup` → `master_detail` | 可 | 空の値を持つレコード（全件に親が要る）。共有の再計算が要る |
| `master_detail` → `lookup` | 可 | なし。共有の再計算が要る |
| `formula`・`rollup_summary`・`autonumber` ↔ 他 | 不可 | 作り直してもらう |
| `checkbox` ↔ 他 | 不可 | |

### 5.2 変換の手順

1. **下見**：管理者が変換を選ぶと、Worker が変換できない値の件数と例（最大 20 件、読める項目だけ）を数える。依存（数式、入力規則、フロー、共有ルール、リストビュー）のうち、型が合わなくなるものを一覧にする。依存が合わなければ、変換を始められない。
2. **承認と開始**：管理者は、変換できない値を「空にする」か「中止する」かを選ぶ。1 つの版で、項目を `converting` にし、新しい `field_no` と新しい型を `md_fields.type_params.target` に入れる。
3. **写す**：Worker が、ID の範囲ごと（1 万件）に、古いキーの値を変換して新しいキーに書き、新しい型のピボットの行を書く。レコードの行ロックを範囲ごとに取る。
4. **変換の間**：
   - 読みは、新しいキーに値があればそれを、なければ古いキーの値を変換関数で変換して返す。どちらの経路も同じ変換関数を使う。
   - その項目の書き込みは 409 `FIELD_CONVERTING` で断る。他の項目の書き込みは止めない。
   - 問い合わせの条件にその項目を使うと、ピボットを使わず、評価器で判定する（[query-language-and-api.md](query-language-and-api.md) の 4 節）。大きなオブジェクトでは選択的でない問い合わせとして断られうる。
5. **切り替え**：全ての範囲が済んだら、1 つの版で、項目の指す `field_no` を新しいものにし、`active` に戻す。古い `field_no` の値は 15 日残してから消去の予定に入れる（5.4 節）。デプロイの戻しで古い型へ切り替え直せるようにするため（[sandboxes-and-deploy.md](sandboxes-and-deploy.md) の 6.5 節）。
6. 中止：変換の間に管理者が中止したら、1 つの版で古い `field_no` に戻し、新しいキーとピボットの行を消去の予定に入れる。

本家も、新しい置き場所を割り当てて写し、メタデータの指す先を切り替える（MT）。本家は変換の間の書き込みを止めるかを資料に書いていない（未検証）。

### 5.3 削除と復元

| 操作 | 版の変更 | データ |
| --- | --- | --- |
| 項目の削除 | `state = deleted`、`deleted_at` を入れる。API・画面・問い合わせから消える | `records.data` のキー、ピボットの行はそのまま残す |
| 項目の復元（15 日以内） | `state = active` に戻す | 残っている値で元どおり。削除の間に作られたレコードは空 |
| オブジェクトの削除 | `deleted_at` を入れる。関係を持つ子のオブジェクトの項目は、同じ版で削除の状態にする | レコードはそのまま残す |
| オブジェクトの復元（15 日以内） | 元に戻す | そのまま |
| 削除の確定（15 日の後、または管理者の操作） | 定義の行を消す（`field_no` は欠番にする） | 消去の予定に入れる（5.4 節） |

- 依存（`md_dependencies`）のある項目は削除できない。依存の一覧を返す。
- 削除した項目の名前は、確定までは再利用できない。
- 15 日は、本家のレコードのごみ箱の期間に合わせた（MT、LDV）。本家の項目の削除の保持の日数は未検証。法務の L5 の結論で見直す。

### 5.4 消去

- Worker が、組織の公平な順番（ADR-0005）で、`records.data` からキーを外す `UPDATE` を範囲ごと（1 万件）に行い、ピボット・長いテキストの行を消す。
- 消去は、確定から 7 日以内に終える。終わったら監査に残す。個人データを含む項目の値を、確定の後に長く残さないため。
- `field_no` は再利用しないので、消去の途中に残ったキーが、新しい項目の値と取り違えられることはない。

## 6. DML の実行の順序（ADR-0008）

### 6.1 手順

1 つの DML（作成・更新・upsert・削除・復元）は、200 件ずつの塊で、次の手順を塊ごとにまとめて行う。本家の 200 件の塊（Apex Developer Guide）に合わせ、フローが塊の単位で問い合わせを 1 回にまとめられるようにする。

| # | 手順 | 失敗した時 |
| --- | --- | --- |
| 0 | 版を固定し、メタデータの共有のロックを取る（4.4 節）。上限の計測を始める | — |
| 1 | 元のレコードを読む（更新・削除は `FOR UPDATE`）。`row_version` の条件があれば比べる | 409 `CONFLICT` |
| 2 | 要求の値を当てる。**システムの検証**：オブジェクトの権限、FLS の編集、型・長さ・形式、制限付きの選択リスト、参照先が存在して利用者が読めること | 400（`INVALID_FIELD`、`FIELD_NOT_EDITABLE` など）、404 |
| 3a | **保存の前のフロー**。同じレコードの項目だけを変えられる。DML はできない | フローのエラー |
| 3b | **before トリガー**（E13。[extensibility.md](extensibility.md) の 5 節）。3a と同じ制約 | トリガーのエラー |
| 4 | システムの検証をもう一度（必須、型）と、**入力規則**（7 節の言語） | 400 `VALIDATION_RULE_FAILED` |
| 5 | **重複の規則**（sales-objects の領域）。止める設定なら、ここで止める | 400 `DUPLICATE_DETECTED` |
| 6 | **書く**：`records`、ピボット、長いテキスト、関係。一意の違反はここで DB が検出する。未確定 | 400 `DUPLICATE_VALUE` |
| 7a | **after トリガー**（E13）。他のレコードへの DML は入れ子の保存になる | トリガーのエラー |
| 7b | **保存の後のフロー**。他のレコードへの DML は入れ子の保存になる | フローのエラー |
| 8 | **積み上げ集計**：親を集計し直し、値が変われば親を入れ子で保存する（親の手順 1〜8）。祖父母も同じ | |
| 9 | **項目の変更の履歴**：最上位で 1 回だけ、トランザクションの最初の値と最後の値の差を outbox（`field_history`）に書く。Relay が `history` のクラスタへ写す（[audit-and-field-history.md](audit-and-field-history.md) の 5.2 節） | |
| 10 | **共有の評価**：このトランザクションで変わった全てのレコードについて、1 回だけ行う（8 節） | |
| 11 | outbox に変更のイベントを書く | |
| 12 | 確定 | 上限の超過などで全体を巻き戻す |
| 13 | 確定の後：フローの非同期の経路、after_commit のトリガー（E13）、メール、Webhook、検索の索引、履歴の写し（outbox から） | 再送（各領域） |

- **共有の評価を、確定の直前の 1 回にする。** ADR-0003 は「書き込み → 共有の行の更新 → 保存の後のフロー」としたが、保存の後のフローと積み上げ集計が、共有ルールの条件の項目や所有者を変えうる。途中で評価すると、最後の値と合わない共有の行が残る。本家も、条件に基づく共有の評価を確定の直前（18 番目）に置く（Apex Developer Guide）。ADR-0003 は「詳細は metadata-and-runtime で決める」としていたので、ここで決め直す。
- 手順 12 までの全てが、同じ DB のトランザクションの中で行われる。どこで上限を超えても、全体が巻き戻る（ADR-0005）。
- **手順 3・7 の分け方**（2026-09-28。extensibility の領域の依頼）：同じ手順の中でフローとトリガーを混ぜず、フロー → トリガー（3a → 3b）、トリガー → フロー（7a → 7b）の固定の順にする。本家の順（保存の前のフロー → before トリガー、after トリガー → …… → 保存の後のフロー）に寄せた。MVP ではトリガーがないので、3b・7a は空の手順になる。
- **手順 9 は最上位で 1 回**（2026-09-28。audit-and-field-history の領域の依頼。ADR-0008 の注記）：手順 10・11 と同じく入れ子の保存では行わない。1 つのトランザクションの中の途中の値を履歴に残さないため。
- 削除は、手順 2（権限）→ 3b（`before_delete` のトリガー。E13。削除の前のフローは MVP で持たない）→ 7a（`after_delete` のトリガー）→ 7b（削除の後のフロー）→ 8 → 9 → 10 → 11 → 12 の順にする。ごみ箱の扱いは [data-storage.md](data-storage.md) の 5 節。

### 6.2 再帰と入れ子

| 事象 | 規則 |
| --- | --- |
| 保存の後のフロー（7b）・after トリガー（7a）が、同じレコードを更新する | 入れ子の保存として手順 1〜8 をもう一度行う。**同じフロー・同じトリガーは、同じトランザクションで同じレコードに対して 1 回しか動かない**（`DT-FLW-001`、`DT-EXT-001`） |
| 保存の後のフローが、他のレコードを作る・変える | 入れ子の保存。そのレコードの手順 1〜8 |
| 積み上げ集計で親が変わる | 親の入れ子の保存。親の保存の後のフローも動く |
| 入れ子の深さ | 16 まで（ADR-0005）。超えたら全体を巻き戻す |
| 項目の変更の履歴（9）、共有の評価（10）、outbox（11） | 入れ子の保存では行わない。最上位の保存の最後に、全てのレコードについて 1 回だけ行う |

- 本家は再帰の保存で 9〜17 を飛ばし、ワークフローの項目の更新ではトリガーを「もう 1 回だけ」動かす（Apex Developer Guide）。本システムにはワークフロー・割り当てのルール・エスカレーションがないので、規則を「同じフロー × 同じレコードで 1 回」にまとめた。フローの中の細かな規則は automation-flows の領域で決める。

### 6.3 部分の成功

- `all_or_none = true`（既定）：1 件でも失敗したら全体を巻き戻す。
- `all_or_none = false`：失敗したレコードを外し、残りで手順をやり直す。やり直しは 2 回まで。3 回目も失敗が出たら、残り全てを失敗にする。やり直しの前の上限の数は巻き戻す（トランザクションのセーブポイントで戻す）。本家も部分の成功でトリガーをやり直す（Apex Developer Guide）。本家のやり直しの回数は未検証。

## 7. 数式の言語と評価器（ADR-0009）

### 7.1 文法

表計算の関数に寄せる。キーワードと関数の名前は大文字・小文字を区別しない。

```ebnf
formula     = expr ;
expr        = or_expr ;
or_expr     = and_expr { "||" and_expr } ;
and_expr    = cmp_expr { "&&" cmp_expr } ;
cmp_expr    = cat_expr [ ( "=" | "==" | "<>" | "!=" | "<" | "<=" | ">" | ">=" ) cat_expr ] ;
cat_expr    = add_expr { "&" add_expr } ;            (* 文字列の連結 *)
add_expr    = mul_expr { ( "+" | "-" ) mul_expr } ;
mul_expr    = pow_expr { ( "*" | "/" ) pow_expr } ;
pow_expr    = unary [ "^" unary ] ;
unary       = [ "-" | "!" ] primary ;
primary     = literal | ref | call | "(" expr ")" ;
ref         = ident { "." ident } | "$" ident "." ident ; (* 項目、親への参照、$User.id など *)
call        = ident "(" [ expr { "," expr } ] ")" ;
literal     = number | string | "TRUE" | "FALSE" | "NULL" ;
```

関数（MVP）：

| 種類 | 関数 |
| --- | --- |
| 論理 | `IF`、`AND`、`OR`、`NOT`、`CASE`、`ISBLANK`、`BLANKVALUE`、`ISPICKVAL`、`INCLUDES` |
| 数 | `ROUND`、`FLOOR`、`CEILING`、`ABS`、`MIN`、`MAX`、`MOD` |
| 文字列 | `LEN`、`LEFT`、`RIGHT`、`MID`、`FIND`、`CONTAINS`、`BEGINS`、`SUBSTITUTE`、`UPPER`、`LOWER`、`TRIM`、`TEXT`、`VALUE`、`HYPERLINK` |
| 日付 | `TODAY`、`NOW`、`DATE`、`DATEVALUE`、`YEAR`、`MONTH`、`DAY`、`WEEKDAY`、`ADDMONTHS` |
| 入力規則・フローだけ | `ISNEW`、`ISCHANGED`、`PRIORVALUE` |

関数の名前は表計算で一般的なもので、本家の識別子ではない。本家の数式との互換は目標にしない（[ADR-0001](../decisions/0001-platform-and-stack.md)）。

### 7.2 型と空の扱い

- 型は `text`、`number`（精度と桁を持つ 10 進）、`currency`、`percent`、`date`、`datetime`、`boolean`、`picklist`（`ISPICKVAL`・`TEXT`・`CASE` の中だけで使える）、`null`。暗黙の型の変換はしない（`TEXT`・`VALUE`・`DATEVALUE` で変える）。
- 数の計算は 10 進（38 桁）で行う。割り算の途中は小数 18 桁で、`ROUND` は四捨五入（0.5 は 0 から遠い方へ）。結果は項目の `scale` に丸める。
- 空の扱い：
  - 数の項目の空は、数式ごとの設定 `blank_as_zero` で、0 として扱うか空のまま伝えるかを選ぶ。既定は空のまま。
  - 空のままのとき、算術の演算子と比較は、どちらかが空なら空を返す。`IF` の条件が空なら偽として扱う。
  - 文字列の空と `""` は同じにする。
  - `&&`・`||` は、空を偽として扱う 2 値にする。問い合わせの言語の 3 値（[query-language-and-api.md](query-language-and-api.md) の 3.3 節）とは違う。数式は値を作る言語で、利用者が表計算の感覚で書くため。
- 日付と時刻：`TODAY()` と `NOW()` は、実行する利用者のタイムゾーンで日付を決める。`datetime` は UTC で持ち、表示の時にだけ変える。

### 7.3 決定性の分類

| 分類 | 例 | SQL にするか | 実体化（索引） | 変わる時 |
| --- | --- | --- | --- | --- |
| A：同じレコードで決まる | `amount * 0.1`、`LEFT(name, 3)` | する | できる | そのレコードの保存 |
| B：親をたどる | `account.industry` | する（親との結合） | できない | 親の保存 |
| C：時刻・利用者で変わる | `TODAY() - close_date`、`$User.id` | する（値はバインド変数） | できない | 常に |
| D：評価器だけ | SQL にできない関数を含む（MVP では `HYPERLINK` の組み立てなど表示用のもの） | しない | できない | 分類 A〜C による |

- 分類は、コンパイルの時に型の検査と同時に決め、スナップショットに入れる。
- 分類 D の数式を問い合わせの条件に使うと、他の条件で絞った候補を評価器で判定する。候補が絞れない大きなオブジェクトでは、選択的でない問い合わせとして断る（[query-language-and-api.md](query-language-and-api.md) の 4 節）。
- 本家も、時刻で変わる数式と、他のオブジェクトを参照する数式には索引を張れない（LDV）。

### 7.4 評価器と SQL の生成

- **参照の評価器**：TypeScript の純粋な関数 `evaluate(ast, record, parents, context) → value`。数式・入力規則・問い合わせの条件で共有する（ADR-0003）。評価器が意味の正本で、SQL の生成は評価器と同じ結果を返さなければならない。
- **SQL の生成**：分類 A〜C の AST を、PostgreSQL の式にする。`data->>'12'` を型に合わせて `::numeric`・`::timestamptz` に変える。10 進の割り算、四捨五入、空の伝わり方は、評価器と同じになるよう、生成する SQL の形を固定する（例：`ROUND` は `round(x, n)` ではなく、0 から遠い方へ丸める式にする）。
- 数式が他の数式項目を参照したら、参照先の AST を展開する（インライン化）。展開した後の大きさを 7.6 節の上限で測る。本家も、参照した数式の大きさを足してコンパイル後の大きさを測る（Tips for Reducing Formula Size）。
- 循環の参照は、コンパイルの時に拒否する。

### 7.5 実体化

- 分類 A の数式項目に `indexed` を付けると、保存の手順 6 で値を計算し、ピボットの表に書く。`records.data` には書かない（正本は式）。
- 数式を変えたら、その項目のピボットの行を Worker が作り直す。作り直しの間、その項目の条件はピボットを使わない（型の変換と同じ）。

### 7.6 数式の上限

| 上限 | 値 | 本家 |
| --- | --- | --- |
| 式の文字数 | 5,000 | 3,900 文字（Tips for Reducing Formula Size） |
| 展開した後の AST の節の数 | 2,000 | コンパイル後 15,000 バイト（同上）。単位が違うので、値は E6 で測って決める |
| 生成した SQL の式の大きさ | 32KB | — |
| 親への参照の段 | 5 | 未検証 |
| 1 つのオブジェクトの数式がたどる別々の関係の数 | 15 | 未検証 |
| 数式から数式への参照の深さ | 10 | — |

本家より文字数を増やすのは、日本語の項目の名前やコメントを含めると 3,900 文字が窮屈になるためである。展開した後の大きさの上限で、実行の費用は抑える。

### 7.7 数式と FLS

- **数式の値は、見る人が数式の項目と、数式が（展開した後に）参照する全ての項目を読める時にだけ返す。** 1 つでも読めなければ、その数式の項目を FLS で読めない項目として扱う。
- 数式を通して、読めない項目の値が漏れないようにするため（intent の「守るべき振る舞い」）。本家は、参照先の項目の FLS に関わらず数式の値を見せると言われる（未検証）。本システムは、それより厳しくする。
- 管理者が、数式の項目の FLS を「読める」にしようとして、参照先に読めない項目がある権限セットがあれば、Setup の画面で警告する。
- 入力規則とフローの中の数式は、システムの文脈で評価する（利用者の FLS に関わらず全ての項目を読む）。入力規則のエラーの文言に、読めない項目の値を差し込めないようにする（差し込めるのは、項目の名前だけ）。

## 8. 共有の評価の呼び出し（手順 10）

手順 10 では、共有の領域の関数 `applySharingDelta(txChangedRecords)` を 1 回呼ぶ。中身は [sharing-and-record-access.md](sharing-and-record-access.md) の 6.3 節。この領域が決めるのは、呼ぶ時と、渡す集合だけである。

- 渡すのは、このトランザクションで作った・変えた・消した・戻した全てのレコードの ID と、変わった項目の集合（共有ルールの条件の項目、所有者、親の参照）。
- 変わった項目が、共有に関わらない項目だけなら、何もしない（スナップショットに、オブジェクトごとの「共有に関わる項目」の集合を持つ）。

## 9. 障害のとき

| 事象 | 振る舞い |
| --- | --- |
| Valkey の障害 | L1 と L3 で動く。今の版は DB を読む。部品の作成の重複が増える |
| Pub/Sub の通知が落ちる | 5 秒の読み直しで追いつく。K2 の 5 秒を超えうる |
| 部品のコンパイルが失敗する（壊れたメタデータ） | 版の変更の検証で防ぐ。すり抜けたら、その部品を使う要求は 500 にし、他のオブジェクトの要求は動かす。`metadata_compile_failures_total` で警告 |
| 型の変換・消去の Worker が止まる | 範囲ごとに冪等なので、再開で続ける。変換の間の項目は書けないままになるので、24 時間を超えたら警告 |
| メタデータの変更が長くロックを持つ | 検証を確定の前に済ませ、確定は行の書き込みだけにする。ロックの保持が 1 秒を超えたら警告 |
| 評価器と SQL の結果が違う（本番の標本の照合） | 警告。その数式の分類を D に落とす設定（機能フラグ）で、SQL にしないようにできる |

## 10. セキュリティ

- メタデータの変更は、「アプリケーションのカスタマイズ」のシステムの権限を持つ利用者と、デプロイだけが行える（[sharing-and-record-access.md](sharing-and-record-access.md) の 3 節）。
- キャッシュの鍵に `org_id` を必ず含める。内容で番地を決める部品も、組織ごとの鍵の空間に置く（4.2 節）。
- 数式と入力規則は、値を全てバインド変数にした SQL にする。式の文字列を SQL に連結しない（ADR-0003）。
- 数式の FLS（7.7 節）。
- 型の変換の下見で見せる例は、管理者が読める項目だけにする。
- 削除した項目の値は、確定から 7 日以内に消す（5.4 節）。
- `security:sensitive` の対象：数式の FLS の判定、コンパイラの権限の段、キャッシュの鍵の形。

## 11. テスト

- 決定表（`DT-MDR-*` の草案）：5.1 節の型の変換の表（元・先・値 → 可否と結果）。6.2 節の再帰の規則。
- 性質ベーステスト（fast-check）：
  - 任意の数式（文法から生成した AST）と任意のレコードで、生成した SQL の結果と参照の評価器の結果が一致する（ADR-0003）。空・0・負・大きな桁・うるう日・タイムゾーンの境界を多めに出す。
  - 任意の型の変換の列（途中で中止を含む）で、変換できる値は変換の後に同じ意味の値になり、変換の間の読みは、変換の後の読みと一致する。
  - 任意のメタデータの変更の列で、部品に分けたスナップショットが、全体を一度にコンパイルしたスナップショットと同じ意味になる（部品の差分のコンパイルの正しさ）。
  - 任意の DML の列（フローが同じレコードと他のレコードを変える）で、共有の行が、確定の時のレコードの値だけから決まる（手順 10 が最後の値を見る）。
  - 任意の項目の削除・復元・確定の列で、確定の前は値が失われない（ADR-0002）。
- 上限の試験：3.4 節と 7.6 節の全ての上限で、ちょうどで通り、1 つ超えたら拒否する。入れ子の深さ 16 で通り、17 で全体が巻き戻る。
- 結合テスト：カスタム項目の追加から、別の Runtime のタスクで使えるまで 5 秒以内（K2）。Valkey を止めても通る。
- 結合テスト：変換の間の項目への書き込みが 409 になり、他の項目は書ける。
- 結合テスト：数式が読めない項目を参照するとき、その数式の項目が API・リストビュー・レポートのどこにも出ない。

## 12. この領域の ADR

| ADR | 決定 |
| --- | --- |
| [0006](../decisions/0006-data-dictionary-and-field-lifecycle.md) | データ辞書は `field_id` と再利用しない `field_no` を分けて持ち、カスタムの名前は `x_` の接頭辞にする。型の変換は新しい `field_no` へ写して切り替え、削除は 15 日保って確定から 7 日以内に消す |
| [0007](../decisions/0007-segmented-metadata-snapshots.md) | スナップショットを内容で番地を決めたオブジェクトごとの部品と不変の manifest に分け、変わった部品だけをコンパイルし直す |
| [0008](../decisions/0008-dml-order-of-execution.md) | DML は 200 件の塊で 13 の手順（3・7 は 3a・3b・7a・7b に分ける）で処理し、項目の変更の履歴・共有の評価・outbox は確定の直前に最上位で 1 回だけ行う。同じフローは同じレコードに 1 回だけ動く |
| [0009](../decisions/0009-formula-language-and-evaluator.md) | 数式は表計算に寄せた独自の言語で、決定性で 4 つに分けて SQL にするか評価器で判定するかを決める。数式の値は参照先を全て読める人にだけ返す |

## 13. Story の候補

| Epic | Story の候補 |
| --- | --- |
| E1 | CI：メタデータの経路での DDL の禁止、数式の SQL と評価器の一致の性質ベーステストの枠 |
| E2 | 組織の作成で、標準オブジェクトのデータ辞書を種から入れ、全部品を事前にコンパイルする |
| E3 | データ辞書の表と、オブジェクト・項目の作成・名前の変更（`field_no` の採番） |
| E3 | 版を上げる 1 つのトランザクション、`md_changes`、今の版の配布（Pub/Sub と 5 秒の読み直し） |
| E3 | 部品に分けたスナップショット、L1・L2・L3 のキャッシュ、部品の作成の重複の抑え |
| E3 | DML の手順 0〜2・6・10〜12（フローなし）と、200 件の塊、部分の成功 |
| E3 | 項目の削除・復元・確定と、消去の Worker |
| E3 | 項目の型の変換（下見、写す、切り替え、中止） |
| E6 | 数式の言語：パーサー、型の検査、分類、評価器 |
| E6 | 数式の SQL の生成と、評価器との一致の性質ベーステスト |
| E6 | 入力規則（手順 4）と、保存の前・後のフローの呼び出し（手順 3a・7b）、再帰の規則 |
| E6 | 数式の実体化（索引）と、数式の変更での作り直し |
| E6 | 数式の FLS（参照先を全て読める時だけ返す）と、Setup の警告 |
| E12 | 大きな組織（オブジェクト数百・項目数万）でのコンパイルの時間の計測と、部品の分け方の見直し |

## 14. 未解決の問い

- 数式の上限（展開した後の AST の節の数）の値を、何を基準に決めるか。
- 部品の粒度を、オブジェクトより細かくする必要があるか（1 つのオブジェクトが項目 500・入力規則 数百を持つ時）。
- 型の変換の間、その項目の書き込みを止めるのは利用者に重くないか。本家の振る舞いは未検証。
- 項目の削除の保持の期間（15 日）は、法務の L5 の結論で変わりうる。
- 数式の FLS を本家より厳しくすることで、本家から移る組織の画面が変わる。受け入れられるか。
- 数式の保存時の大きさの本家の値（4,000 バイトか 15,000 バイトか）の食い違い。

### 決定

2026-09-28 の既定案。

- AST の節の上限は 2,000 で始め、E6 で、生成した SQL の計画の時間が 10ms を超える大きさを測って決め直す。
- 部品はオブジェクトの単位で始める。E12 で 1 部品のコンパイルが 200ms を超える組織が 1% を超えたら、入力規則とフローの呼び出しの表を別の部品に分ける。
- 型の変換の間の書き込みは止める。変換は 1 万件の範囲ごとに進み、S1 の最大の組織（5,000 万件）でも数十分で終わる見込み。E3 で測り、1 時間を超えるなら、両方のキーへ書く方式を検討する。
- 削除の保持は 15 日で作り、値を設定で変えられるようにする。
- 数式の FLS は厳しい方で作る。移行の文書に書く。
- 本家の数式の保存時の大きさは確かめない。本システムは文字数と展開後の大きさで上限を持つので、影響しない。

## 15. quality.md・runbooks・data-model に載せるもの

**quality.md**

- リスク：数式・入力規則の SQL と評価器の不一致（誤った絞り込み、誤った検証）。性質ベーステストと本番の標本の照合で見る。
- リスク：数式を通した FLS の漏れ。数式の FLS の決定表と、経路ごとの否定側のテスト。
- リスク：型の変換・削除での値の消失。変換の性質ベーステストと、削除・復元の性質ベーステスト。
- 上限の試験：3.4 節・7.6 節の上限と、入れ子の深さ。
- 本番での検証：数式の標本の照合（評価器と SQL）を 1 組織 1 分 10 件まで。

**runbooks**

- `metadata-compile-failure`：部品のコンパイルの失敗。版の差分を見て、直前の版へ戻すデプロイを作るか判断する。
- `field-conversion-stuck`：型の変換が 24 時間を超えた。範囲の進みを見て再開か中止を判断する。
- `field-purge-overdue`：確定から 7 日を超えて消去が終わらない。
- `metadata-cache-degraded`：Valkey の障害で L2 が使えない。DB の読みの増え方を見る。
- SLI の追加の依頼（Ops へ）：メタデータの変更の確定の時間（p99 1 秒）、カスタム項目の追加から使えるまでの時間（K2）、部品のキャッシュの命中率、`metadata_compile_failures_total`、`METADATA_CHANGED` の件数。

**data-model**

| テーブル | 主な列 | 備考 |
| --- | --- | --- |
| `md_objects` | `org_id`、`object_id`、`api_name`、`kind`、`owd`、`grant_via_hierarchy`、`next_field_no`、`field_history_enabled`、`allow_activities`、`deleted_at` | RLS |
| `md_fields` | `org_id`、`field_id`、`object_id`、`field_no`、`api_name`、`type`、`type_params`、`required`、`unique`、`external_id`、`indexed`、`data_class`、`searchable`、`track_history`、`state`、`deleted_at` | `(org_id, object_id, field_no)` は一意。`field_id` は組織の系統の中で一意 |
| `md_relationships` | `org_id`、`field_id`、`child_object_id`、`parent_object_id`、`kind`、`master_order`、`on_parent_delete` | |
| `md_picklists`、`md_picklist_values` | `org_id`、`picklist_id`、`value_id`、`api_value`、`label`、`active`、`attrs` | |
| `md_record_types`、`md_record_type_values` | `org_id`、`record_type_id`、`object_id`、`api_name`、`active` | |
| `md_dependencies` | `org_id`、`from_kind`、`from_id`、`to_field_id` | コンパイルで作る |
| `md_versions`、`md_changes` | `org_id`、`version`、`actor_id`、`source`、`entity_kind`、`entity_id`、`op`、`before`、`after` | 監査にも使う（audit-and-field-history の領域） |
| `field_conversions` | `org_id`、`field_id`、`from_field_no`、`to_field_no`、`state`、`policy`、`progress` | 型の変換の進み |
| `purge_jobs` | `org_id`、`kind`（`field`・`object`）、`target_id`、`confirmed_at`、`progress`、`finished_at` | 消去の進み |

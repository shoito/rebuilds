# Query language and API: Salesforce

独自の問い合わせの言語（構文、関係のたどり方、集計）、選択性の見積もりと計画、REST API（レコード、問い合わせ、記述、複合の要求）、版、エラー、`<Brand>-Limit-Info` の見出しの設計。土台は [ADR-0002](../decisions/0002-custom-object-storage.md)（ピボットの表）、[ADR-0003](../decisions/0003-metadata-driven-runtime.md)（AST からのコンパイル）、[ADR-0005](../decisions/0005-tenancy-and-governor-limits.md)（上限と割り当て）。この文書で決めたことは、次の 3 つの ADR にある。

- 問い合わせの言語は、SQL に寄せた独自の言語（仮称 RQL、Record Query Language）にする。関係は親へのドットと、子の副問い合わせでたどる。論理は SQL と同じ 3 値にし、文字列は正規化した値で比べる（[ADR-0018](../decisions/0018-record-query-language.md)）。
- 計画は、組織・オブジェクト・項目ごとの自前の統計で選択性を見積もり、駆動する条件を選ぶ。PostgreSQL の計画に任せず、実体化した CTE で駆動の順を固定し、候補が見積もりを大きく超えたら途中で計画を変える。対話の経路では、選択的でない大きな問い合わせを断る（[ADR-0019](../decisions/0019-selectivity-statistics-and-planning.md)）。
- REST API は `/api/v1` の下のリソースにし、版の中では足す変更だけをする。レコードの JSON はシステムの項目と利用者の項目を分け、数は文字列で返す。カーソルは暗号化したキーセットにする（[ADR-0020](../decisions/0020-rest-api-shape-and-versioning.md)）。

本家の振る舞いは、2026-09-28 に次の資料で確かめた。確かめられなかったものは「未検証」と書く。本家の言語（SOQL）との互換は目標にしない（[ADR-0001](../decisions/0001-platform-and-stack.md)）。

## 1. 目的と範囲

| 範囲に含む | 範囲に含まない（担当の領域） |
| --- | --- |
| 問い合わせの言語の文法と意味、上限 | 数式の言語（[metadata-and-runtime.md](metadata-and-runtime.md) の 7 節） |
| 選択性の見積もり、統計、計画、SQL の形 | 共有の条件の中身（[sharing-and-record-access.md](sharing-and-record-access.md) の 6.2 節）。ここではどの枝から進めるかだけ |
| REST API のリソース、JSON、カーソル、複合の要求 | 一括の API（bulk-and-import の領域）、メタデータの API（sandboxes-and-deploy の領域） |
| 版、エラー、条件付きの要求、`<Brand>-Limit-Info` | 上限の値の一覧と、上限の情報の全ての返し方（governor-limits の領域） |
| | 全文検索の言語（search の領域）、トークンと認証（orgs-users-and-auth の領域） |

## 2. 本家の仕組み（確かめたこと）

| 項目 | 本家 | 出典 |
| --- | --- | --- |
| 文の長さ | 100,000 文字まで。数式の項目を多く含むと、内部で展開されて `QUERY_TOO_COMPLICATED` になりうる | [SOQL and SOSL Reference](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_soql_sosl.pdf)（Winter '27 版、以下「SOQL」） |
| 文字列のリテラル | `WHERE` の中の 1 つの文字列は 4,000 文字まで | [Developer Limits and Allocations Quick Reference](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_app_limits_cheatsheet.pdf)（以下「Limits」） |
| 関係 | 子から親へは 55 まで、1 本は 5 段まで。親から子へは 20 まで。API の版 58.0 以降は、親から子へ 5 段まで | SOQL、Limits |
| OFFSET | 2,000 行まで | SOQL |
| 並び | `ORDER BY` がなければ、順は保証しない | SOQL |
| 1 回の結果の大きさ | 既定・最大 2,000 件、最小 200 件。ロングテキストを 2 つ以上選ぶと 200 件まで | [REST API Developer Guide](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/api_rest.pdf)（Winter '27 版、以下「REST」）、SOQL |
| 次のページ | REST は `nextRecordsUrl` で続きを読む | SOQL |
| 選択性の閾値 | 標準の索引：最初の 100 万件の 30%、それ以降の 15%。カスタムの索引：最初の 100 万件の 10%、それ以降の 5%。条件を満たさない索引だけが外れる | [Best Practices for Deployments with Large Data Volumes](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_large_data_volumes_bp.pdf)（以下「LDV」） |
| 閾値の上限 | カスタムの索引は 333,333 件、標準の索引は 100 万件が上限（どちらも全体が 560 万件を超えた時に当たる） | [Make Salesforce Platform SOQL Query Selective](https://help.salesforce.com/s/articleView?id=000385218&type=1)（2026-09-28 に確認） |
| AND・OR | AND の複合の条件は、各条件が閾値の 2 倍以内か、交わりが閾値以内なら選択的。OR は各条件が閾値を満たす必要がある。OR の全ての項目に索引が要る | LDV |
| 統計 | 組織・グループ・利用者の単位の統計を持つ。選択リストの値の数、カスタム索引の非空の値と一意の値の数 | [Platform Multitenant Architecture](https://architect.salesforce.com/docs/architect/fundamentals/guide/platform-multitenant-architecture.html) |
| 事前の問い合わせ | 統計の表への事前の問い合わせで、索引を使うかを決める | LDV |
| 空の値 | 選択リストと参照の空で絞る条件は、索引を使わない | LDV |
| 計画の説明 | REST の `explain` の引数で、実行せずに計画の情報を返す | REST |
| 上限の見出し | 全ての応答（版の一覧を除く）に `Sforce-Limit-Info: api-usage=10018/100000` の形で、24 時間の API の使用量を返す | REST |
| エラーの本文 | `[{"fields": [...], "message": "...", "errorCode": "MALFORMED_ID"}]` の配列 | REST |
| 状態 | 300（外部 ID が複数のレコードに当たる）、304、400、401、403（`REQUEST_LIMIT_EXCEEDED` を含む）、404、405、409、410（廃止した版）、412、414（URI 16,384 バイト超）、415、428、431、500、502、503 | REST |
| 条件付きの要求 | `ETag`、`If-Match`（合わなければ 412）、`If-None-Match`（304）、`If-Modified-Since`、`If-Unmodified-Since` | REST |
| 複合の要求 | 25 の副要求まで（グラフの形は 500）。sObject Collections は 200 件まで | REST |
| 版の維持 | 各版を、最初の公開から最低 3 年保つ。廃止した版には 410 を返す | REST |

## 3. 問い合わせの言語（ADR-0018）

### 3.1 文法

キーワードは大文字・小文字を区別しない。名前（オブジェクト・項目・関係）は API の名前で書く（[metadata-and-runtime.md](metadata-and-runtime.md) の 3.1 節）。

```ebnf
query        = select , from , [ scope ] , [ where ] , [ group_by , [ having ] ] ,
               [ order_by ] , [ limit ] , [ offset ] ;
select       = "SELECT" , select_item , { "," , select_item } ;
select_item  = path , [ "AS" , ident ]
             | aggregate , [ "AS" , ident ]
             | "(" , child_query , ")"
             | "FIELDS" , "(" , ( "ALL" | "STANDARD" | "CUSTOM" ) , ")" ;
path         = ident , { "." , ident } ;                     (* 親への参照は 5 段まで *)
child_query  = "SELECT" , path , { "," , path } , "FROM" , ident ,
               [ where ] , [ order_by ] , [ limit ] ;         (* ident は子の関係の名前 *)
aggregate    = "COUNT" , "(" , [ "*" | path ] , ")"
             | ( "COUNT_DISTINCT" | "SUM" | "AVG" | "MIN" | "MAX" ) , "(" , path , ")" ;
from         = "FROM" , ident ;
scope        = "SCOPE" , ( "MINE" | "TEAM" | "QUEUES" ) ;
where        = "WHERE" , cond ;
cond         = and_cond , { "OR" , and_cond } ;
and_cond     = not_cond , { "AND" , not_cond } ;
not_cond     = [ "NOT" ] , ( predicate | "(" , cond , ")" ) ;
predicate    = operand , cmp_op , operand
             | path , "IS" , [ "NOT" ] , "NULL"
             | path , [ "NOT" ] , "IN" , "(" , ( value_list | semi_join ) , ")"
             | path , [ "NOT" ] , "LIKE" , ( string | bind )
             | path , ( "HAS_ANY" | "HAS_ALL" | "HAS_NONE" ) , "(" , value_list , ")" ;
semi_join    = "SELECT" , path , "FROM" , ident , [ where ] ;  (* 入れ子にしない *)
operand      = path | value ;
cmp_op       = "=" | "!=" | "<" | "<=" | ">" | ">=" ;
value_list   = value , { "," , value } ;
value        = string | number | "TRUE" | "FALSE" | bind | date_fn ;
bind         = ":" , ident ;
date_fn      = ( "TODAY" | "YESTERDAY" | "TOMORROW" | "THIS_WEEK" | "LAST_WEEK" | "THIS_MONTH"
               | "LAST_MONTH" | "NEXT_MONTH" | "THIS_QUARTER" | "THIS_YEAR"
               | "THIS_FISCAL_QUARTER" | "THIS_FISCAL_YEAR" ) , "(" , ")"
             | ( "LAST_DAYS" | "NEXT_DAYS" | "LAST_MONTHS" | "NEXT_MONTHS" ) , "(" , integer , ")" ;
group_by     = "GROUP" , "BY" , group_item , { "," , group_item } ; (* 3 つまで *)
group_item   = path
             | ( "YEAR" | "QUARTER" | "MONTH" | "DAY" | "FISCAL_YEAR" | "FISCAL_QUARTER" ) , "(" , path , ")" ;
having       = "HAVING" , cond ;                              (* 集計と group_item だけを参照 *)
order_by     = "ORDER" , "BY" , order_item , { "," , order_item } ;
order_item   = ( path | aggregate | ident ) , [ "ASC" | "DESC" ] , [ "NULLS" , ( "FIRST" | "LAST" ) ] ;
limit        = "LIMIT" , ( integer | bind ) ;
offset       = "OFFSET" , ( integer | bind ) ;                (* 2,000 まで *)
```

例：

```
SELECT name, amount, account.name, owner.name,
       (SELECT name, email FROM contact_roles LIMIT 5)
FROM opportunity
WHERE stage IN ('proposal', 'negotiation')
  AND close_date = THIS_FISCAL_QUARTER()
  AND account.x_region = :region
ORDER BY amount DESC NULLS LAST
LIMIT 50
```

- `SCOPE MINE` は所有者が本人、`TEAM` は本人と部下、`QUEUES` は本人が属するキュー。共有の条件（[sharing-and-record-access.md](sharing-and-record-access.md) の 6.2 節）に**加えて**絞る。広げることはない。
- `FIELDS(ALL)` は、読める全ての項目（200 項目まで）。`LIMIT` 200 以下と組み合わせる時だけ許す。
- 値は全て、リテラルかバインド変数にする。パーサーが値を AST の定数の節にし、SQL ではバインド変数になる（ADR-0003）。
- 複数選択の選択リストは `HAS_ANY`・`HAS_ALL`・`HAS_NONE` で絞る。多態の参照（活動の関連先など）の扱いは sales-objects の領域で決める。
- 名前は仮称。開発リポジトリの作成時に決める。本家の言語の名前と構文の独自の部分（`__c`、`__r`、日付のリテラルの `LAST_N_DAYS:n` の形）は使わない。

### 3.2 関係のたどり方

| 向き | 書き方 | 上限 | 読めない時 |
| --- | --- | --- | --- |
| 子から親 | `account.owner.name` | 1 本 5 段。1 つの問い合わせで別々の関係 35 まで | 親を読めなければ、親の項目は空。親の項目の条件は「親がない」として評価する（3.3 節の 3 値で `UNKNOWN`） |
| 親から子 | `(SELECT ... FROM contacts)` | 1 つの問い合わせに 10 まで。1 段だけ | 読める子だけを返す |
| 半結合 | `id IN (SELECT account FROM opportunity WHERE ...)` | 1 つの問い合わせに 2 まで。入れ子にしない | 内側も利用者の権限で絞る |

- 子の副問い合わせは、親 1 件あたり 200 件まで返す。超えた分は、子の結果に `next`（カーソル）を付ける（5.3 節）。
- 親の関係は `record_relationships` か、`records.data` の参照の値と `records` の結合にする。子は `record_relationships` の `(org_id, parent_id, child_object_id, field_no)` の索引で引く（[data-storage.md](data-storage.md) の 3.2 節）。
- 本家は API の版 58.0 以降、親から子へ 5 段をたどれる（SOQL）。本システムは MVP では 1 段にする（14 節）。

### 3.3 意味

- **3 値の論理（SQL と同じ）。** 比べる値のどちらかが空なら `UNKNOWN`。`WHERE`・`HAVING` は `TRUE` の行だけを残す。`NOT UNKNOWN` は `UNKNOWN`。したがって `amount != 100` は `amount` が空の行を含まない。空を含めたい時は `OR amount IS NULL` と書く。数式の言語の 2 値とは違う（[metadata-and-runtime.md](metadata-and-runtime.md) の 7.2 節）。
- **文字列の比較**：`=`・`!=`・`<`・`IN`・`LIKE` は、NFKC で正規化して小文字にした値で比べる（[data-storage.md](data-storage.md) の 3.2 節）。全角・半角の英数字と、大文字・小文字を区別しない。
- **`LIKE`**：`%` と `_`。`\` で逃がす。先頭が `%` の条件は、3 文字以上なら trigram の索引を候補にし、それ以外は他の条件で絞った候補に評価器で当てる。
- **日付の関数**は範囲を表す。`close_date = THIS_MONTH()` は範囲の中、`<` は範囲の始めより前、`>` は範囲の終わりより後。範囲の境目は、実行する利用者のタイムゾーンで決め、`datetime` の項目では UTC の時刻の範囲に直す。会計年度は組織の設定（開始の月）で決める。
- **選択リスト**は `api_value` で書く。コンパイルの時に `value_id` に直す。存在しない値は `INVALID_VALUE` にする。
- **並び**：`ORDER BY` がなければ `id` の昇順（UUIDv7 なので、ほぼ作成の順）にする。本家は順を保証しないが（SOQL）、本システムは決定的にする。空の並びは PostgreSQL と同じ（昇順で最後、降順で最初）。文字列の並びは、正規化した値のコードポイントの順（[data-storage.md](data-storage.md) の 14 節）。
- **意味の正本は参照の評価器**（ADR-0003）。SQL の生成は、評価器と同じ結果を返す形に固定する。

### 3.4 集計

- 集計の関数と `GROUP BY` は、同じ `SELECT` にグループの項目以外の項目を混ぜられない。子の副問い合わせとも混ぜられない。
- 結果のグループは 2,000 行まで。超えたら `LIMIT_EXCEEDED`。カーソルは使えない。大きな集計はレポート（reports-and-dashboards の領域）か一括の問い合わせで行う。
- 集計した行の数は、トランザクションの「問い合わせで取得する行」（ADR-0005、50,000）に数える。数えないと、上限の外で大きな読みができるため。本家も、`COUNT()` 以外の集計の関数は集計に使った行を全て取得の行に数える（`COUNT()` は 1 行、`GROUP BY` があればグループごとに 1 行。[Apex Developer Guide](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_apex_developer_guide.pdf)、Winter '27 版、2026-09-28 に確認）。本システムは `COUNT()` も使った行で数え、本家より厳しい。
- 例外（[ADR-0041](../decisions/0041-limits-registry-and-counting-rules.md)、ADR-0018 の 2026-09-28 の注記）：保存の手順 8 の積み上げ集計の集計し直しは取得の行に数えない（子 5 万件の `rollup.sync_recalc_children` で抑える）。レポート（`report.*`）と一括の問い合わせ（`bulk.query`）は、トランザクションの上限の外の予算で抑える。
- 見る人が読めるレコードだけを集計する（共有の条件と FLS をかけてから集計する）。

### 3.5 上限

| 上限 | 値 | 本家 |
| --- | --- | --- |
| 問い合わせの文字数 | 100,000 | 100,000（SOQL） |
| 1 つの文字列のリテラル | 4,000 文字 | 4,000（Limits） |
| 親への参照の段 | 5 | 5（SOQL） |
| 親への別々の関係 | 35 | 55（SOQL） |
| 子の副問い合わせ | 10 | 20（SOQL） |
| 子の副問い合わせの段 | 1 | 5（SOQL） |
| 半結合 | 2 | 1 つの半結合・反結合の問い合わせの副問い合わせ 2（SOQL） |
| `IN` の値 | 1,000 | 未検証 |
| `GROUP BY` の項目 | 3 | `ROLLUP`・`CUBE` は 3（SOQL）。ただの `GROUP BY` の上限は書かれていない |
| 集計の結果のグループ | 2,000 | 集計の結果は `queryMore` できず、Apex の for で 2,000 行を超えると実行時の例外（Apex Developer Guide） |
| `OFFSET` | 2,000 | 2,000（SOQL） |
| 1 ページの件数 | 200〜2,000、既定 2,000（ロングテキストを 2 つ以上選ぶと 200） | 同じ（REST、SOQL） |
| AST の節（数式の項目を展開した後） | 5,000 | 値は未公開（SOQL の `QUERY_TOO_COMPLICATED`） |
| 生成した SQL の結合 | 20 | — |
| 同期の問い合わせの時間 | 30 秒 | 実行 2 分、結果の処理 30 分（Limits） |

本家の列の「未検証」は、本家の値を公開の資料で確かめていないもの。本システムの値は本家に依らず、E12 の `limits-final-values` で決める。

- 値は governor-limits の領域の一覧にも載せる。トランザクションの上限（問い合わせの数、取得の行）は ADR-0005 の値に従う。
- 本家より関係と副問い合わせの数を小さくするのは、生成する SQL の結合の数を抑えるためである。E12 で見直す。

### 3.6 コンパイル

ADR-0003 の段に沿って、次の順に処理する。

1. **構文**：文字列を AST にする。構文の誤りは `MALFORMED_QUERY`（位置を返す）。
2. **束縛**：名前をスナップショットで ID と型に解決する。無い名前、読めない項目は `INVALID_FIELD`（[sharing-and-record-access.md](sharing-and-record-access.md) の 3.4 節。区別しない）。
3. **型の検査**：比べる型、関数の引数、集計の型。
4. **権限**：オブジェクトの読みの権限。FLS（3.4 節の表）。
5. **共有の条件の付加**：[sharing-and-record-access.md](sharing-and-record-access.md) の 6.2 節。
6. **計画**：4 節。
7. **SQL の生成と実行**：値はバインド変数。上限の計測の下で実行する。

- コンパイル結果（計画の前まで）は `(org_id, metadata_version, AST のハッシュ, 権限の形)` でキャッシュする（ADR-0003）。計画は値と統計で変わるので、実行のたびに選ぶ（見積もりはメモリーの中で数十 µs で済む）。SQL の文字列は、計画の形ごとにキャッシュする。

## 4. 選択性の見積もりと計画（ADR-0019）

### 4.1 計画の候補

| 候補 | 使う時 | 進め方 |
| --- | --- | --- |
| P0 ID | `id = ...` か `id IN (...)`（1,000 まで） | 主キー |
| P1 索引から | 選択的な条件が、索引のある項目にある | ピボットかシステムの列の索引で候補の ID を得て、`records` と結ぶ |
| P2 共有から | 非公開のオブジェクトで、利用者が見られる件数の見積もりが選択的 | `owner_id` の索引（本人・部下・キュー）と、`record_shares` の利用者のグループの行から候補を得る |
| P3 索引の順 | `ORDER BY` の先頭が索引のある項目で、`LIMIT` が 2,000 以下 | 索引の順に読み、条件を当てて `LIMIT` で止める。読む行は 20 万行まで |
| P4 射影 | 参照する全ての項目が射影の表にある（S2） | 射影の表を読む（[data-storage.md](data-storage.md) の 7 節） |
| P5 全体 | オブジェクトの生きている行が 20 万件以下、または一括の問い合わせ | 組織・オブジェクトの範囲を主キーで読む |

- P0 → P1・P2 のうち見積もりの最も小さいもの → P4 → P3 → P5 の順に選ぶ。どれも使えなければ 4.5 節。

### 4.2 統計

| 表 | 中身 | 更新 |
| --- | --- | --- |
| `stats_objects` | `org_id`、`object_id`、`live_rows`、`deleted_rows` | outbox から 1 分ごとに足し引き |
| `stats_fields` | `org_id`、`object_id`、`field_no`、`ndv`（異なる値の数）、`null_frac`、`mcv`（多い値の上位 100 と頻度）、`histogram`（100 の区切り）、`sample_rows`、`computed_at` | 毎晩。`live_rows` が前回から 20% 変わったら、その日のうちに |
| `stats_owner_counts` | `org_id`、`object_id`、`owner_id`、`rows` | outbox から 1 分ごと |
| `stats_share_counts` | `org_id`、`object_id`、`grantee_group_id`、`rows` | 毎晩 |

- 標本：1 オブジェクト 3 万行を、主キー（UUIDv7）の範囲の無作為な位置から読む。UUIDv7 は作成の時刻の順なので、偏りを E3 の PoC で確かめる。
- 統計は組織ごとで、全組織をまとめた統計は使わない。本家も組織・利用者の単位の統計を持つ（Platform Multitenant Architecture）。
- Runtime は統計を Valkey（`st:{o:<org_id>}:<object_id>`、1 時間）と L1 に持つ。統計が無い時（新しいオブジェクト）は、`live_rows` だけで見積もる。

### 4.3 見積もりと閾値

- 1 つの条件の見積もり：等価は `mcv` にあればその頻度、なければ `(1 − null_frac − mcv の合計) / (ndv − mcv の数)`。範囲は `histogram`。`IS NULL` は `null_frac`。`IN` は各値の和。
- 閾値 `T(N)`（`N` は生きている行の数）：

| 索引の種類 | 式 | 上限 |
| --- | --- | --- |
| システムの列（`id`、`owner_id`、`created_at`、`updated_at`、`record_type_id`、`parent_id`、名前） | `0.30 × min(N, 100万) + 0.15 × max(N − 100万, 0)` | 100 万件 |
| ピボット（`record_index_values`） | `0.10 × min(N, 100万) + 0.05 × max(N − 100万, 0)` | 333,333 件 |

- 本家の閾値（LDV）と上限（2 節）に合わせる。本家から移る管理者が、同じ感覚で索引を選べるようにするため。
- **AND**：選択的な条件のうち、見積もりの最も小さいものから進め、残りは結んだ後に当てる。複数の条件をまたいだ索引（2 列の索引）は持たない。
- **OR**：全ての枝が索引のある項目の選択的な条件で、見積もりの和が閾値以内の時だけ、候補の和集合から進める。1 つでも欠ければ、OR 全体は選択的でない。本家も同じ（LDV）。
- **選択的にならないもの**：`!=`、`NOT IN`、`NOT LIKE`、`HAS_NONE`、先頭が `%` の `LIKE`（trigram を除く）、分類 B〜D の数式（[metadata-and-runtime.md](metadata-and-runtime.md) の 7.3 節）、型の変換中の項目。
- **空の条件**：`IS NULL` もピボットの空の印の行（[data-storage.md](data-storage.md) の 3.2 節）で選択的になりうる。本家は空で絞る条件に索引を使わない（LDV）が、本システムは使う。
- **P2 の見積もり**：`stats_owner_counts` の本人・部下・キューの行の和と、`stats_share_counts` の利用者のグループの行の和（重なりは足したままの上限の見積もり）。閾値はシステムの列と同じ。

### 4.4 SQL の形と、途中での計画の変更

PostgreSQL にはヒントがない。駆動の順を固定するため、候補を実体化した CTE にする。

```sql
WITH cand AS MATERIALIZED (
  SELECT record_id
  FROM record_index_values
  WHERE org_id = $1 AND shard_no = $2 AND object_id = $3 AND field_no = $4
    AND v_num >= $5 AND v_num < $6
  LIMIT $7                                    -- 候補の上限 ＝ 見積もりの閾値の 2 倍 ＋ 1
)
SELECT r.id, r.data, ...
FROM cand
JOIN records r
  ON r.org_id = $1 AND r.shard_no = $2 AND r.object_id = $3 AND r.id = cand.record_id
WHERE r.deleted_at IS NULL
  AND <残りの条件>
  AND <共有の条件>                            -- sharing-and-record-access.md の 6.2 節
ORDER BY ... LIMIT ...;
```

- 候補の数が上限（`$7`）に達したら、見積もりが外れたとみなし、その実行を捨てて次に見積もりの小さい候補で 1 回だけ計画し直す。2 回目も外れたら 4.5 節の扱いにする。統計を、その日のうちに取り直す予定に入れる。
- P3 は `ORDER BY` の索引の順に読み、読んだ行が 20 万行に達したら止め、4.5 節の扱いにする。
- 生成する SQL には、必ず `org_id`・`shard_no` の定数を入れる（[data-storage.md](data-storage.md) の 4 節）。
- `statement_timeout` を、対話の経路は 30 秒、一括の問い合わせは 10 分に設定する（ADR-0005 の最後の守り）。

### 4.5 選択的でない問い合わせ

| 経路 | オブジェクトの生きている行 | 使える候補がない時 |
| --- | --- | --- |
| 対話（画面・REST） | 20 万件以下 | P5 で実行する |
| 対話（画面・REST） | 20 万件を超える | 400 `NON_SELECTIVE_QUERY`。索引のある項目での絞り込み、索引の指定、一括の問い合わせを案内する |
| 一括の問い合わせ（bulk-and-import の領域） | 問わない | P5 で、reader で ID の範囲（25 万行）ごとに実行する。トランザクションの上限ではなく **`bulk.query` の予算**（1 ジョブの DB の時間 60 分、結果の 1 ファイル 1GB。[governor-limits.md](governor-limits.md) の 5 節、[ADR-0041](../decisions/0041-limits-registry-and-counting-rules.md)）で抑える。取得の行（5 万）には当たらない |
| レポート（reports-and-dashboards の領域） | 問わない | その領域で決める（reader、非同期の実行） |

- エラーの文言に、件数や見積もりを入れない（8 節）。
- 本家も、選択的でない問い合わせを大きなオブジェクトで断る場面がある。その件数の境目は、公開の資料に書かれていない（未検証。E3 の `query-stats-and-planner` で試用の組織で確かめる）。

### 4.6 計画の説明

- `GET /api/v1/query/explain?q=...`：実行せずに、計画の候補（駆動の条件、見積もり、閾値、相対の費用、選んだもの）と注意（「この項目に索引がない」など）を返す。本家の `explain` に寄せる（REST）。
- 見積もりは、見る人が読めないレコードを含む組織全体の統計から出る。件数を推し量らせないため、`customize_application` か `view_all_data` を持つ利用者だけに許す。

## 5. REST API（ADR-0020）

### 5.1 URL とリソース

基底は `https://<org>.my.<brand>.<domain>/api/v1`（[リポジトリ共通の ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。

| メソッドとパス | 操作 |
| --- | --- |
| `GET /api/versions` | 使える版の一覧（認証なし、割り当てに数えない） |
| `GET /api/v1` | リソースの一覧 |
| `GET /api/v1/objects` | 読めるオブジェクトの一覧（記述の要約） |
| `GET /api/v1/objects/{object}/describe` | オブジェクトの記述（読める項目、関係、選択リスト、レコードタイプ）。`ETag` と `If-None-Match` |
| `POST /api/v1/objects/{object}/records` | 作成（201） |
| `GET /api/v1/objects/{object}/records/{id}` | 読む（`fields=` で項目を選ぶ） |
| `PATCH /api/v1/objects/{object}/records/{id}` | 更新（204）。`If-Match` を受ける |
| `DELETE /api/v1/objects/{object}/records/{id}` | 削除（204。ごみ箱へ） |
| `POST /api/v1/objects/{object}/records/{id}/restore` | ごみ箱から戻す（[data-storage.md](data-storage.md) の 5.2 節） |
| `PUT /api/v1/objects/{object}/by-external-id/{field}/{value}` | 外部 ID で upsert（作成は 201、更新は 200） |
| `GET /api/v1/objects/{object}/records/{id}/shares`、`POST`、`DELETE .../shares/{share_id}` | 手動の共有（[sharing-and-record-access.md](sharing-and-record-access.md) の 5.3 節） |
| `GET /api/v1/query?q=...`、`POST /api/v1/query` | 問い合わせ。`POST` は `{"q": "...", "binds": {...}, "page_size": 500}` |
| `GET /api/v1/query/cursor/{cursor}` | 次のページ |
| `GET /api/v1/query-all?q=...`、`POST /api/v1/query-all` | ごみ箱を含む問い合わせ |
| `GET /api/v1/query/explain?q=...` | 計画の説明（4.6 節） |
| `POST /api/v1/composite` | 複合の要求（5.4 節） |
| `POST`・`PATCH`・`DELETE /api/v1/collections/{object}` | 同じオブジェクトの 200 件までの一括 |
| `GET /api/v1/limits` | 組織の割り当ての残り |
| `GET /api/v1/openapi.json` | この利用者が読めるオブジェクト・項目だけで作った OpenAPI 3.1（architecture の 4 節） |

- **認証**：`/api/v1` は OAuth のアクセストークン（`<brand>_at_`）で通り、`api_enabled` の権限が要る。本システムの画面（SPA）の要求はセッションの Cookie だけで通り、OAuth のトークンでは通らない。連携が画面の API を使って API の割り当ての外で動くことを防ぐ（[orgs-users-and-auth.md](orgs-users-and-auth.md) の 6.5・6.6 節、[ADR-0044](../decisions/0044-authentication-better-auth-sso-and-mfa.md)）。
- 他の領域が同じ `/api/v1` の下に足すリソース（v1 の中の足す変更。形と権限は各領域の文書が正）：

| パス | 中身 | 領域 |
| --- | --- | --- |
| `/api/v1/ui/records/{id}`、`/api/v1/ui/objects/{object}/new`、`/api/v1/objects/{object}/list-views[...]` | レコードのページ、リストビュー | [ui-layouts-and-list-views.md](ui-layouts-and-list-views.md) |
| `/api/v1/search` | 全文検索 | [search.md](search.md) |
| `/api/v1/leads/convert` | リードの変換 | [sales-objects.md](sales-objects.md) |
| `/api/v1/approvals/...`、`/api/v1/flows/{id}/versions/{v}/debug` | 承認の申請・応答、フローのデバッグ | [automation-flows.md](automation-flows.md) |
| `/api/v1/reports/...`、`/api/v1/dashboards/...` | レポートの実行・非同期の結果、ダッシュボード | [reports-and-dashboards.md](reports-and-dashboards.md) |
| `/api/v1/events/...` | 変更のイベント・組織のイベントの購読と発行 | [events-and-integrations.md](events-and-integrations.md) |
| `/api/v1/jobs/ingest/...`、`/api/v1/jobs/query/...` | 一括の取り込み・問い合わせ | [bulk-and-import.md](bulk-and-import.md) |
| `/api/v1/metadata/retrieves`、`/api/v1/metadata/deploys/...`、`/api/v1/sandboxes` | 書き出し、デプロイ、Sandbox | [sandboxes-and-deploy.md](sandboxes-and-deploy.md) |
| `/api/v1/audit/...`、`/api/v1/objects/{object}/records/{id}/history[...]` | 監査・書き出し・鎖の確かめ、項目の変更の履歴 | [audit-and-field-history.md](audit-and-field-history.md) |

- 外部 ID の項目は必ず一意にする（[metadata-and-runtime.md](metadata-and-runtime.md) の 3.3 節）。本家は外部 ID が複数のレコードに当たると 300 を返す（REST）が、本システムでは起きない。
- `q` を URL に入れると、途中の機器のログに値が残りうる。個人データを含む条件は `POST /api/v1/query` とバインド変数を勧める。

### 5.2 レコードの JSON

```json
{
  "id": "01927c5e-8a3b-7c11-9f00-3b2d1e0a4c55",
  "object": "opportunity",
  "row_version": 12,
  "fields": {
    "name": "2026 年度 更新",
    "amount": "1200000",
    "close_date": "2026-10-31",
    "stage": "negotiation",
    "account": "01927c5e-7a10-7c11-9f00-000000000001",
    "x_region": "kanto"
  },
  "parents": {
    "account": { "id": "01927c5e-7a10-7c11-9f00-000000000001", "object": "account", "fields": { "name": "例示商事" } }
  },
  "children": {
    "contact_roles": { "records": [], "done": true, "next": null }
  }
}
```

- システムの値（`id`、`object`、`row_version`）と、利用者の項目（`fields`）を分ける。カスタムの項目の名前が、システムの値の名前とぶつからない。
- **数（`number`・`currency`・`percent`）は文字列で返す。** JSON の数を JS の倍精度で読むと、大きな金額や小数が丸まるため。本家の画面の API は、通貨・倍精度・整数・割合を JSON の数で返す（[User Interface API Developer Guide](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/api_ui.pdf)、Winter '27 版、2026-09-28 に確認）。
- 日付は `YYYY-MM-DD`、日時は UTC の ISO 8601（ミリ秒）。選択リストは `api_value`、複数選択は配列。空の項目は `null` を返す（キーを省かない）。
- 作成・更新の本文も同じ `fields` の形にする。未知の項目は 400 `INVALID_FIELD`。

### 5.3 問い合わせとカーソル

```json
{
  "records": [ { "id": "...", "object": "opportunity", "fields": { } } ],
  "done": false,
  "next": "/api/v1/query/cursor/eyJ2IjoxLC..."
}
```

- 件数（`total`）は既定で返さない。`count=true` の時だけ、1 万件で打ち切った件数と `total_capped` を返す。件数の計算は、ページの読みより重いため。
- **カーソルはキーセットにする。** 中身は `{v, org_id, user_id, query_hash, metadata_version, last_sort_values, last_id, issued_at}` を、組織のセルごとの鍵（KMS のデータキー）で AES-256-GCM で暗号化したもの。サーバーに状態を持たない。
- カーソルは 24 時間有効。他の利用者・他の問い合わせでは使えない（400 `INVALID_CURSOR`）。期限切れは 410 `CURSOR_EXPIRED`。
- 次のページは、最後の行の並びの値と `id` より後から読む。スナップショットではないので、読んでいる間に追加・変更された行は、並びの位置によって出たり出なかったりする。並びの値が変わらない行は、ちょうど 1 回だけ出る。
- ページの間にメタデータの版が変わったら、問い合わせを新しい版でコンパイルし直す。コンパイルできなければ（項目の削除など）409 `QUERY_INVALIDATED`。
- 集計の問い合わせには、カーソルを付けない（3.4 節）。

### 5.4 複合の要求

- `POST /api/v1/composite`：副要求 25 まで。前の副要求の結果を `@{ref.id}` で参照できる。
  - `all_or_none: true`：全体を 1 つのトランザクションで行い、上限を全体で 1 回数える。1 つでも失敗したら全て巻き戻す。
  - `all_or_none: false`：副要求ごとに別のトランザクション。
- `collections/{object}`：同じオブジェクトの 200 件まで。`all_or_none` は [metadata-and-runtime.md](metadata-and-runtime.md) の 6.3 節の部分の成功に従う。
- 複合の要求は、API の割り当てに 1 回と数える。本家も複合の要求と sObject Tree は全体で 1 回と数え、Composite Batch は副の要求ごとに数える（[REST API Developer Guide](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/api_rest.pdf)、Winter '27 版、2026-09-28 に確認）。

## 6. 版、エラー、条件付きの要求、上限の見出し（ADR-0020）

### 6.1 版

- 版は URL の大きな番号（`/api/v1`）だけにする。v1 の中では、足す変更（新しいリソース、任意の引数、新しい項目、新しいエラーの `code`、列挙の値の追加）だけをする。利用者には、未知の項目と値を無視するよう文書に書く。
- 壊す変更は次の版（`/api/v2`）で行う。前の版は、次の版の公開から最低 3 年保つ。本家も各版を最低 3 年保つ（REST）。廃止した版には 410 `VERSION_RETIRED` を返す。
- 廃止を予定した版・リソースの応答に、`Deprecation` と `Sunset` の見出しを付ける。
- 組織のメタデータの変更（項目の追加・削除）は API の版と関係なく反映される。記述と OpenAPI を読み直してもらう。
- CI で、OpenAPI の前の版と比べて壊す変更がないことを検査する（delivery の領域）。

### 6.2 エラーの形

```json
{
  "errors": [
    { "code": "INVALID_FIELD", "message": "No such field: x_regoin", "fields": ["x_regoin"], "index": null }
  ],
  "request_id": "req_01927c5e..."
}
```

- `errors` は配列で、入力の検証では複数の誤りを返す。`fields` は関係する項目、`index` は複合・一括の副要求の番号。
- 本家は配列だけを本文にする（REST）。本システムは `request_id` を足すため、オブジェクトで包む。
- `message` に、読めない項目の値、他の組織の情報、件数の見積もり、内部の SQL を入れない。

### 6.3 状態と `code`

| 状態 | `code` の例 | 使う場面 |
| --- | --- | --- |
| 400 | `MALFORMED_QUERY`、`MALFORMED_ID`、`INVALID_FIELD`、`INVALID_TYPE`、`INVALID_VALUE`、`REQUIRED_FIELD_MISSING`、`FIELD_NOT_EDITABLE`、`VALIDATION_RULE_FAILED`、`DUPLICATE_VALUE`、`DUPLICATE_DETECTED`、`DELETE_RESTRICTED`、`PARENT_DELETED`、`NON_SELECTIVE_QUERY`、`QUERY_TOO_COMPLEX`、`LIMIT_EXCEEDED`、`INVALID_CURSOR` | 入力と、トランザクションの上限の超過（`LIMIT_EXCEEDED` は上限の名前・使った量・上限を返す） |
| 401 | `INVALID_SESSION` | トークンの期限切れ・不正 |
| 403 | `INSUFFICIENT_ACCESS`、`API_DISABLED` | 読めるが操作できない。API の権限がない |
| 404 | `NOT_FOUND` | 無い、または読めない（区別しない） |
| 409 | `CONFLICT`、`FIELD_CONVERTING`、`QUERY_INVALIDATED`、`ENTITY_IS_DELETED` | `row_version` の衝突、型の変換中、ページの間の項目の削除、削除中のオブジェクト |
| 410 | `VERSION_RETIRED`、`CURSOR_EXPIRED` | |
| 412 | `PRECONDITION_FAILED` | `If-Match` が合わない |
| 413 | `PAYLOAD_TOO_LARGE` | 本文が 10MB を超える |
| 414 | `URI_TOO_LONG` | URI が 16KB を超える（本家は 16,384 バイト。REST） |
| 429 | `REQUEST_LIMIT_EXCEEDED`、`CONCURRENT_LIMIT_EXCEEDED` | 24 時間の API の割り当て、長い要求の同時実行（ADR-0005）。`Retry-After` を付ける |
| 503 | `METADATA_CHANGED`、`TEMPORARILY_UNAVAILABLE` | 版の変更とのやり直しの失敗（[metadata-and-runtime.md](metadata-and-runtime.md) の 4.4 節）、DB の切り替え。`Retry-After` を付ける |

- 本家は 24 時間の割り当ての超過を 403 で返す（REST）。本システムは HTTP の意味に合わせて 429 にする。
- 読めないレコードは 404、読めるが操作できないレコードは 403（[sharing-and-record-access.md](sharing-and-record-access.md) の DT-SHR-002）。

### 6.4 条件付きの要求

- レコードの `ETag` は `"<row_version>"`（強い検証子）。`PATCH`・`DELETE` の `If-Match` が合わなければ 412。`GET` の `If-None-Match` が合えば 304。
- 記述の `ETag` は、そのオブジェクトの部品の鍵と権限の形のハッシュ。版が上がっても、そのオブジェクトと権限が変わらなければ 304 を返せる（[metadata-and-runtime.md](metadata-and-runtime.md) の 4.2 節）。
- `If-Modified-Since`・`If-Unmodified-Since` は MVP では受けない。

### 6.5 `<Brand>-Limit-Info`

```
<Brand>-Limit-Info: api-usage=10018/115000; long-running=3/25
```

- 版の一覧（`/api/versions`）を除く全ての応答に付ける。形は本家の `Sforce-Limit-Info` に寄せる（REST）。名前は本家のものを使わない（[リポジトリ共通の ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。
- `api-usage` は組織の 24 時間の API の使用量と割り当て、`long-running` は長い要求（20 秒以上）の同時実行の数と上限（ADR-0005）。
- トランザクションの上限の使用量は、要求の見出し `<Brand>-Tx-Usage: request` で求めた時だけ、応答の `<Brand>-Tx-Usage` で返す（`queries=12/100; query-rows=3401/50000; …`）。形と `/limits` の中身の正本は [governor-limits.md](governor-limits.md) の 9 節（[ADR-0042](../decisions/0042-org-allocations-fair-queuing-and-limit-info.md)）。

## 7. 障害のとき

| 事象 | 振る舞い |
| --- | --- |
| 統計が古い・無い | `live_rows` だけで見積もる。外れたら 4.4 節の途中の計画の変更で守る |
| Valkey の障害 | 統計を DB から読む。メタデータは [metadata-and-runtime.md](metadata-and-runtime.md) の 9 節 |
| 計画が外れて遅い | 候補の上限、P3 の 20 万行、`statement_timeout` の 3 段で止める。`query_replans_total` と `NON_SELECTIVE_QUERY` を計測する |
| reader の遅れ | 問い合わせは writer と同じ Aurora の reader で読みうる（レポート以外は writer）。書いた直後の読みは writer で行う |
| カーソルの鍵が読めない | 起動時に復号してメモリーに持つ。KMS の障害中は、新しいタスクのカーソルの読みを 503 にする |
| メタデータの変更とぶつかる | 503 `METADATA_CHANGED` と `Retry-After: 1` |

## 8. セキュリティ

- 値は全てバインド変数。問い合わせの文字列を SQL に連結しない（ADR-0003）。
- 読めないレコードは 404、読めない項目は存在しない項目と同じ `INVALID_FIELD`（[sharing-and-record-access.md](sharing-and-record-access.md) の 3.4 節）。`WHERE`・`ORDER BY`・`GROUP BY`・集計・半結合・子の副問い合わせの全てで、共有と FLS をかける。
- 計画の説明と `NON_SELECTIVE_QUERY` の文言は、組織全体の統計から件数を推し量らせる。説明は `customize_application` か `view_all_data` に限り、エラーの文言には件数を入れない。
- カーソルは暗号化し、組織・利用者・問い合わせに結び付ける。
- アクセスのログには、問い合わせの AST の形のハッシュだけを残し、リテラルの値を残さない（個人データを含みうるため）。
- 記述と OpenAPI は、利用者が読めるオブジェクトと項目だけで作る。
- `security:sensitive` の対象：コンパイラの段 2〜5、カーソルの暗号、計画の説明の権限。

## 9. テスト

- 決定表（`DT-QRY-*` の草案）：4.3 節の閾値と候補の選び方（条件の種類 × 索引 × 見積もり → 候補）、4.5 節の選択的でない問い合わせの扱い、6.3 節のエラーの表。
- 性質ベーステスト：
  - 任意の問い合わせ（文法から生成）で、構文の出力と読み直しが同じ AST になる。
  - 任意のスキーマ・レコード・問い合わせで、コンパイルした SQL の結果が、参照の評価器で全行を判定した結果と一致する（ADR-0002、ADR-0003）。3 値の論理、空、正規化、日付の範囲、タイムゾーン、会計年度の境目を多めに出す。
  - **計画に依らない**：同じ問い合わせを、候補（P1〜P5）を強制して実行した結果が全て同じになる。
  - 任意の静的なデータで、カーソルでページを最後まで読むと、各行をちょうど 1 回返す。並びの値を変えない変更が途中に入っても、同じ。
  - 任意の利用者と問い合わせで、結果・件数・集計・子・親の項目に、参照の評価器で読めないレコードと項目が出ない（[sharing-and-record-access.md](sharing-and-record-access.md) の PROP-SHR-003）。
- 上限の試験：3.5 節の全ての上限で、ちょうどで通り、1 つ超えたら拒否する。集計の行を取得の行に数え、50,000 で通り、50,001 で巻き戻る。
- 契約テスト：OpenAPI の前の版と比べて壊す変更がない。エラーの本文の形。
- 結合テスト：他の組織・他の利用者のカーソルが拒否される。期限切れのカーソルが 410 になる。
- 性能テスト（E3）：1 オブジェクト 5,000 万件の組織で、選択的な条件の問い合わせが p95 500ms（NFR-002）。統計の標本の偏りの確認。

## 10. この領域の ADR

| ADR | 決定 |
| --- | --- |
| [0018](../decisions/0018-record-query-language.md) | 問い合わせの言語は SQL に寄せた独自の言語（仮称 RQL）にし、親へのドットと 1 段の子の副問い合わせでたどり、3 値の論理と正規化した文字列の比較にする |
| [0019](../decisions/0019-selectivity-statistics-and-planning.md) | 組織ごとの自前の統計と本家に寄せた閾値で駆動の条件を選び、実体化した CTE で順を固定し、見積もりが外れたら 1 回だけ計画し直す。対話の経路では大きな選択的でない問い合わせを断る |
| [0020](../decisions/0020-rest-api-shape-and-versioning.md) | REST API は `/api/v1` の下で足す変更だけをし、レコードの JSON はシステムの値と `fields` を分けて数を文字列で返す。カーソルは暗号化したキーセット、エラーは `errors` の配列、上限は `<Brand>-Limit-Info` |

## 11. Story の候補

| Epic | Story の候補 |
| --- | --- |
| E1 | CI：問い合わせのコンパイラと評価器の一致、計画に依らない結果の性質ベーステストの枠。OpenAPI の壊す変更の検査 |
| E3 | 問い合わせの言語のパーサー、AST、構文の出力と、構文の誤りの位置 |
| E3 | 束縛・型の検査・FLS・共有の条件の付加（段 2〜5） |
| E3 | 3 値の論理、正規化した文字列、日付の関数（会計年度を含む）の SQL の生成と評価器 |
| E3 | 親へのたどり（5 段）と子の副問い合わせ（1 段、親 1 件 200 件）、半結合 |
| E3 | 集計と `GROUP BY`、集計の行の上限の計測 |
| E3 | 統計の表と、outbox からの数の更新、毎晩の標本 |
| E3 | 計画の候補（P0〜P3・P5）と閾値、実体化した CTE、途中の計画の変更、`NON_SELECTIVE_QUERY` |
| E3 | REST API の骨格：レコードの CRUD、外部 ID の upsert、戻す、記述、エラーの形、`ETag` |
| E3 | 問い合わせの API とキーセットのカーソル（暗号化） |
| E3 | `<Brand>-Limit-Info` と `/limits` の枠 |
| E3 | OpenAPI の動的な生成（読める項目だけ） |
| E4 | 手動の共有の API（`/shares`） |
| E5 | 画面のリストビューからの問い合わせ（`SCOPE`、`OFFSET`、索引の順の計画） |
| E5 | 複合の要求と collections |
| E12 | 計画の説明（`explain`）と権限。統計の偏りと閾値の見直し。上限（関係の数、副問い合わせの段）の見直し |
| E12（S2 の準備） | 射影の表を使う計画（P4） |

## 12. 未解決の問い

- 子の副問い合わせを 1 段にとどめてよいか（本家は 5 段）。
- 閾値を本家の値に合わせたままでよいか。PostgreSQL とピボットの形での損益の分かれ目は、本家の DB と違いうる。
- 統計の標本を、UUIDv7 の範囲から取ることの偏り。
- 対話の経路での `NON_SELECTIVE_QUERY` の境目（20 万件）の値。
- 数を JSON の文字列で返すことで、連携の開発者の手間が増えないか。
- 冪等キー（`Idempotency-Key`）を作成の API に持つか。
- 本家の閾値の上限（333,333 件、100 万件）をそのまま使ってよいか。

### 決定

2026-09-28 の既定案。

- 子の副問い合わせは 1 段で作る。画面（関連リスト）の要件で 2 段が要ると分かったら、E5 で 2 段に広げる。
- 閾値は本家の値で始め、E3 の性能テストで、ピボットから進める計画と全体を読む計画の損益の分かれ目を測って見直す。値は設定にし、コードに埋めない。
- 統計の標本は UUIDv7 の範囲から取る。E3 の PoC で、作成の時期で分布が変わる項目（フェーズなど）の見積もりの誤差を測る。誤差が 3 倍を超えるなら、ピボットの表から直接数える方法に替える。
- `NON_SELECTIVE_QUERY` の境目は 20 万件で始め、E12 の負荷試験で決める。
- 数は文字列で返す。公式の SDK（ADR-0006 の Consequences）で 10 進の型に直す。
- 冪等キーは MVP で持たない。外部 ID の upsert を、連携の再試行の手段として案内する。
- 本家の閾値の上限（2026-09-28 にヘルプで確かめた）を使う。本システムの値として持ち、本家との一致は目標にしない。

## 13. quality.md・runbooks・data-model に載せるもの

**quality.md**

- リスク：コンパイラと評価器の不一致による誤った結果、共有・FLS の条件の付け漏れ。性質ベーステスト（評価器との一致、計画に依らない結果、読めないものが出ない）。
- リスク：計画の外れによる遅い問い合わせと、DB の占有。途中の計画の変更と、`NON_SELECTIVE_QUERY` の試験。
- 契約テスト：OpenAPI の壊す変更の検査を、API を変える PR の必須のチェックにする。
- 上限の試験：3.5 節の上限。
- 本番での検証：合成監視で、問い合わせ・カーソル・`<Brand>-Limit-Info` の形を毎時確かめる。

**runbooks**

- `query-plan-regression`：`query_replans_total` や問い合わせの p95 が急に悪化した。統計の取り直し、索引の指定の案内、閾値の設定の見直し。
- `non-selective-query-spike`：特定の組織の `NON_SELECTIVE_QUERY` の急増。連携の変更か、データの増加かを調べ、組織に案内する。
- `stats-job-failed`：統計の毎晩のジョブの失敗。
- SLI の追加の依頼（Ops へ）：問い合わせの p95（NFR-002）、`query_replans_total`、`NON_SELECTIVE_QUERY` の件数、候補の数と実際の行の比（見積もりの誤差）、API の状態コードの分布、`<Brand>-Limit-Info` の `api-usage` が 80% を超えた組織の数。

**data-model**

| テーブル | 主な列 | 備考 |
| --- | --- | --- |
| `stats_objects` | `org_id`、`object_id`、`live_rows`、`deleted_rows`、`updated_at` | RLS |
| `stats_fields` | `org_id`、`object_id`、`field_no`、`ndv`、`null_frac`、`mcv`、`histogram`、`sample_rows`、`computed_at` | RLS |
| `stats_owner_counts` | `org_id`、`object_id`、`owner_id`、`rows` | RLS。スキューの検知にも使う |
| `stats_share_counts` | `org_id`、`object_id`、`grantee_group_id`、`rows` | RLS |
| `api_versions` | `version`、`released_at`、`deprecated_at`、`sunset_at` | 本システムの設定 |

カーソルは DB に保存しない（暗号化した文字列に状態を持たせる）。

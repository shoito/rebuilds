# Reports and dashboards: Salesforce

レポートの型、表形式・サマリー・マトリックスのレポート、集計の実行（reader での同期と非同期、事前の計算をしない理由）、見る人の権限での集計（見られる行だけを数える）、ダッシュボード（見る人と、部下の視点）、レポートの定期の配信の設計。土台は [ADR-0004](../decisions/0004-record-access-model.md)（共有の判定。レポートの集計でも同じ判定を通る）、[ADR-0018](../decisions/0018-record-query-language.md)・[ADR-0019](../decisions/0019-selectivity-statistics-and-planning.md)（問い合わせの言語と計画）、[ADR-0002](../decisions/0002-custom-object-storage.md)（JSONB からの集計は遅いので reader で受ける）。この文書で決めたことは、次の 2 つの ADR にある。

- レポートは、定義（AST）を見る人の権限で毎回コンパイルし、オブジェクトごとの共有の条件と FLS をかけてから、Aurora の reader で集計する。予算に収まらない実行は、自動で非同期の実行に切り替える。見る人をまたいで共有する事前の集計は持たず、結果のキャッシュも見る人ごとにする（[ADR-0029](../decisions/0029-report-execution-on-reader-per-viewer.md)）。
- ダッシュボードは、見る人の権限で集計する形を既定にし、本家の「指定した実行ユーザー」の形は持たない。上司が部下の視点で見る形は、部下の権限と見る人の権限の**共通部分**で集計する。定期の配信も受け取る人ごとに実行する（[ADR-0030](../decisions/0030-dashboards-viewer-intersection-and-subscriptions.md)）。

本家の振る舞いは、2026-09-28 に次の資料で確かめた。確かめられなかったものは「未検証」と書く。ヘルプの記事は検索結果の要約でしか読めなかったものが多く、その値は未検証として扱う。

## 1. 目的と範囲

| 範囲に含む | 範囲に含まない（担当の領域） |
| --- | --- |
| レポートの型（標準、カスタム）、フォルダ | 問い合わせの言語と計画（[query-language-and-api.md](query-language-and-api.md)） |
| レポートの定義（表形式・サマリー・マトリックス）、条件、集計、グラフ | 共有の判定の本体（[sharing-and-record-access.md](sharing-and-record-access.md)） |
| 実行（同期・非同期）、予算、結果の保存とキャッシュ | 分析用の写し（S2。この文書では持ち越しとして書く） |
| 見る人の権限での集計、FLS | 結合のレポート（複数のブロック）、履歴の傾向のレポート、スナップショットのレポート（MVP の後） |
| ダッシュボードの部品、見る人の形、部下の視点、ダッシュボードの条件 | 売上予測（MVP の後。intent） |
| レポートの定期の配信、エクスポート | メールの送信の仕組み（events-and-integrations の領域） |

## 2. 本家の仕組み（確かめたこと）

| 項目 | 本家 | 出典 |
| --- | --- | --- |
| レポートの形式 | 表形式、サマリー、マトリックスを同期・非同期で実行できる | [Reports and Dashboards REST API Developer Guide](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_analytics_rest_api.pdf)（Winter '27 版、以下「RD API」） |
| 行の数 | API は最初の 2,000 行まで返す。条件で絞る | RD API |
| 列の数 | API は列に選んだ項目が 100 までのレポートだけを扱える | RD API |
| 実行の数 | 組織で 1 時間に同期の実行 500、同時に 20。非同期の実行 1,200 | RD API |
| 非同期の結果 | 24 時間の間、取り出せる。1 つのレポートの非同期の実行の一覧は 2,000 まで | RD API |
| 非同期の理由 | 長いレポートは非同期の方が時間切れに当たりにくい。API の全体の 2 分の時間切れは非同期には効かない | RD API |
| 実行の時の条件 | 実行の時に 20 のカスタムの項目の条件を足せる | RD API |
| ダッシュボード | 組織で 1 時間にダッシュボードの更新 200、結果の取得 5,000 | RD API |
| 通知 | 1 人の利用者が購読できるレポートは 5 | RD API |
| カスタムのレポートの型 | 主のオブジェクトに、最大 4 つのオブジェクトを結べる。外部結合（あってもなくても）を選べる。外部結合の後に内部結合を置けない | [Metadata API Developer Guide](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/api_meta.pdf)（Winter '27 版、以下「MDAPI」）の ReportType |
| ダッシュボードの見え方 | 指定した実行ユーザー（全員がその人の権限で見る）、ログインしている利用者（動的なダッシュボード）、自分のチームの利用者（上司が部下の視点で見る）の 3 つ | MDAPI の Dashboard（`dashboardType`）、RD API |
| 動的なダッシュボードの数 | Enterprise 5、Unlimited 10、Developer 3 | [Dynamic Dashboards](https://help.salesforce.com/s/articleView?language=en_US&id=analytics.dashboards_dynamic_overview.htm&type=5)（ヘルプの要約。未検証） |
| 実行ユーザーの選び方 | 他の人を実行ユーザーにするには「すべてのデータの参照」が要る。「自分のチームのダッシュボードの参照」で部下の視点を選べる | [Configure Dashboard Data Visibility](https://help.salesforce.com/s/articleView?id=sf.dashboards_select_running_user.htm&language=en_US&type=5)（ヘルプの要約。未検証） |
| 画面の上限 | 表示 2,000 行。サマリーのグループ 3 段、マトリックスの行 2・列 2。条件 20。クロス条件 3（各 5 の副条件）。グラフのグループ 2,000。ダッシュボードの部品 20（Lightning は部品 25 のうちグラフと表 20）。ダッシュボードの条件 5（各 50 の値） | [Reports and Dashboards Limits and Allocations](https://help.salesforce.com/s/articleView?id=rd_reports_dashboards_limits.htm&language=en_US&type=5)（ヘルプの要約。未検証） |
| 大きなデータのレポート | 選択的な条件、索引のある項目の条件、結合の数を減らす、親に集計を持たせる（子を集計させない）、集計用のオブジェクトを作る | [Best Practices for Deployments with Large Data Volumes](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_large_data_volumes_bp.pdf)（以下「LDV」） |
| レポートと共有 | 見る人の共有で行を絞ることは本家の前提と読めるが、集計の中身（見えない行を数えないか）の資料は確かめられなかった（未検証） | — |

## 3. レポートの型

### 3.1 標準のレポートの型

組織の作成と、オブジェクトの作成で、システムが作る。

| 型 | 主 | 結ぶもの |
| --- | --- | --- |
| `<object>` | 各オブジェクト | なし（親への参照の項目は 5 段まで列に使える） |
| `accounts_with_contacts`、`accounts_with_opportunities` | 取引先 | 取引先責任者、商談（内部結合） |
| `opportunities_with_contact_roles` | 商談 | 商談の取引先責任者の役割 |
| `opportunity_history` | 商談の履歴 | 商談（親） |
| `activities_with_<object>` | 活動 | 主の親 |
| `<master>_with_<detail>` | 主従の親 | 子（カスタムの主従ごとに作る） |
| `<object>_field_history` | 項目の変更の履歴 | レコード（親）。項目の変更の履歴を有効にしたオブジェクトごと（audit-and-field-history の領域の依頼） |

- `<object>_field_history` は、履歴が `history` のクラスタにある（[audit-and-field-history.md](audit-and-field-history.md) の 5.2 節）ので、主のクラスタのレコードと 1 つの SQL で結べない。実行器は、親のレコードの条件・共有の条件・FLS を主の reader で先に当てて ID の束（1,000 件ずつ）を作り、`history` の reader を `(org_id, record_id)` の束で引いて結ぶ。履歴の行の項目の FLS（読めない項目の行を出さない）は結んだ後に当てる。親の候補が 1 万件を超える時は非同期に回す（DT-RPT-002 の行 4 と同じ扱い）。

### 3.2 カスタムのレポートの型

```
report_type（api_name、label、category、deployed）
 ├─ base：オブジェクト
 └─ join（3 まで。合わせて 4 オブジェクト）
      ├─ relationship：子の関係（前のオブジェクトの子）
      ├─ outer：真（あってもなくても）・偽（あるものだけ）
      └─ join（入れ子）
 └─ sections：列の候補（項目、親への参照の項目）
```

- 本家と同じく、4 オブジェクトまで、外部結合の後に内部結合を置けない（MDAPI）。後者は、外部結合で空になった行を内部結合で落とす意味の混乱を避けるため。
- レポートの型はメタデータで、`md_report_types` に持つ。コンパイルした形を、部品 `report_types` に入れる（2026-09-28 に ADR-0007 の部品の一覧に足した。[metadata-and-runtime.md](metadata-and-runtime.md) の 4.2 節）。
- オブジェクト・項目の削除で、依存（`md_dependencies`）のあるレポートの型は、削除の下見に出す（[ui-layouts-and-list-views.md](ui-layouts-and-list-views.md) の 7.3 節）。

## 4. レポートの定義

### 4.1 形

```json
{
  "report_type": "accounts_with_opportunities",
  "format": "summary",
  "scope": "all",
  "date_filter": { "field": "opportunity.close_date", "range": { "fn": "THIS_FISCAL_YEAR" } },
  "filters": [
    { "no": 1, "field": "opportunity.stage", "op": "not_in", "values": ["closed_lost"] },
    { "no": 2, "field": "account.industry", "op": "eq", "values": ["manufacturing"] }
  ],
  "logic": "1 AND 2",
  "cross_filters": [ { "object": "account", "with": false, "child": "task", "subfilters": [] } ],
  "groupings": { "rows": [ { "field": "account.billing_prefecture" }, { "field": "opportunity.stage" } ], "columns": [] },
  "aggregates": [ { "fn": "sum", "field": "opportunity.amount" }, { "fn": "count" } ],
  "columns": ["account.name", "opportunity.name", "opportunity.amount", "opportunity.close_date"],
  "show_details": true,
  "row_limit": null,
  "chart": { "kind": "bar", "group": "account.billing_prefecture", "value": "sum(opportunity.amount)" }
}
```

- リストビューと同じく、項目は `field_id` で保存する（[ADR-0024](../decisions/0024-list-views-as-filter-ast.md)）。上の例は読みやすさのため名前で書いた。
- `format`：`tabular`（グループなし）、`summary`（行のグループ 3 段まで）、`matrix`（行 2・列 2）。
- 集計：`count`、`sum`、`avg`、`min`、`max`、`count_distinct`。数と通貨は 10 進で計算する。
- `scope`：`mine`、`team`、`queues`、`all`。共有の条件に加えて絞るだけ（ADR-0018 の `SCOPE`）。
- `cross_filters`：「子を持つ・持たない」の条件（`EXISTS`・`NOT EXISTS`）。3 まで、副条件 5 まで。子の存在は、見る人が見られる子だけで判定する（6 節）。
- `row_limit`：`{field, dir, n}` で上位 N 件。表形式だけ。
- 数式のレポートの列（本家のサマリーの数式）とバケットの項目は MVP の後。

### 4.2 フォルダ

- レポートとダッシュボードはフォルダに入る。フォルダは利用者・ロール・ロールと部下・公開グループに `view`・`edit`・`manage` で共有する。各利用者の「自分のフォルダ」がある。
- **フォルダの共有は定義を見せるだけで、データを見せない。** 共有されたレポートを開くと、見る人の権限で実行する（5 節）。
- フォルダの権限の判定は、共有の領域の閉包（`group_members_closure`）を使う。

## 5. 実行（ADR-0029）

### 5.1 コンパイル

```
レポートの定義（AST）
  │ 見る人の版・権限の形で
  ▼
束縛 → 型の検査 → FLS（DT-RPT-001）→ オブジェクトごとの共有の条件 → 計画 → SQL（reader）
```

- 結ぶ全てのオブジェクトに、そのオブジェクトの共有の条件（[sharing-and-record-access.md](sharing-and-record-access.md) の 6.2 節）を別々にかける。主の行だけでなく、結んだ子の行も、見られるものだけが結果に入る。
- 親への参照の項目は、親を見られなければ空にする（共有の領域の 6.4 節）。グループの見出しも空（「（表示できません）」）にし、その行は 1 つのグループにまとめる。子の行そのものは見られるので、数えてよい。
- SQL の形：主のオブジェクトから、共有の条件で絞った候補を実体化した CTE にし（[ADR-0019](../decisions/0019-selectivity-statistics-and-planning.md) の計画）、子を結び、`GROUP BY` と集計をする。`data->>'<field_no>'` を型に合わせて `::numeric`・`::timestamptz` に変える（ADR-0002）。
- コンパイル結果は `(org_id, metadata_version, 定義のハッシュ, 権限の形)` でキャッシュする。

**DT-RPT-001：見る人が読めない項目**（上から評価）

| # | 読めない項目の場所 | 結果 |
| --- | --- | --- |
| 1 | 条件、クロス条件、日付の条件、グループ、集計、`row_limit`、グラフ | そのレポートはその人には実行できない。400 `REPORT_UNAVAILABLE`。条件・グループを落として実行しない |
| 2 | 列（詳細の行）だけ | その列を落として実行する |
| 3 | 数式の項目で、参照先に読めない項目がある | 数式の項目を読めない項目として 1・2 を当てる（ADR-0009） |
| 4 | 積み上げ集計で、集計する子の項目に読めない項目がある | 同上（[ADR-0027](../decisions/0027-roll-up-summaries-incremental-with-reconciliation.md)） |
| 5 | なし | 実行する |

- 行 1 で落とさないのは、リストビューと同じ理由（[ADR-0024](../decisions/0024-list-views-as-filter-ast.md)）。読めない項目でグループを作ると、グループの件数から値の分布が分かる。

### 5.2 同期と非同期

**DT-RPT-002：実行の経路**（上から評価）

| # | 起動 | 見積もり（計画の読む行） | 結果 |
| --- | --- | --- | --- |
| 1 | 定期の配信、エクスポート、ダッシュボードの定期の更新 | - | 非同期 |
| 2 | API で `async=true` | - | 非同期 |
| 3 | 画面・API（同期） | 100 万行以下 | 同期（reader。予算は 5.3 節） |
| 4 | 画面・API（同期） | 100 万行を超える、または選択的な条件がない 20 万件を超えるオブジェクト | 非同期に切り替え、画面は「集計中」を出して結果を待つ（API は 202 と実行の ID） |

- 対話の問い合わせは、選択的でない条件を `NON_SELECTIVE_QUERY` で断る（[query-language-and-api.md](query-language-and-api.md) の 4.5 節）。レポートは断らず、非同期に回す。レポートは広い範囲を集計する道具だからである。
- 同期の実行が予算を超えて打ち切られたら、同じ要求を非同期に回し直す（1 回）。

### 5.3 予算

| 予算 | 同期 | 非同期 |
| --- | --- | --- |
| DB の時間（`statement_timeout`） | 20 秒 | 10 分 |
| 読む行の見積もり | 100 万行 | 5,000 万行（超えたら 400 `REPORT_TOO_LARGE`。条件を足すよう案内） |
| 返す詳細の行 | 2,000 | 画面 2,000、エクスポート 100 万 |
| グループ | 2,000（グラフも） | 同じ |
| 同時の実行 | 利用者 2、組織 20 | 組織 5（Worker の公平な順番。ADR-0005） |
| 組織の 1 時間の実行 | API の同期 500、非同期 1,200。画面は同時の実行で抑える | 同じ |

- レポートの実行は、DML のトランザクションではない。ADR-0005 のトランザクションの上限（問い合わせ 100、取得の行 50,000）ではなく、上の予算で抑える。上限の一覧（governor-limits の領域）にレポートの予算として載せる。
- 同期 500・非同期 1,200・結果の 24 時間は、本家の API の値に合わせる（RD API）。
- reader の DB の時間は、組織ごとの DB の時間の計測（ADR-0005）に数える。

### 5.4 reader と時点

- 実行は Aurora の reader で行う。書き込みの経路（writer）の資源を使わない（architecture の 6 節の「JSONB の本体での集計の遅さ」）。
- 結果に `as_of`（reader が反映した時刻）を付けて返す。保存の直後に実行すると、数秒前の状態を返しうる。画面に時点を出す。
- reader の遅れが 30 秒を超えたら、結果に警告を付ける。5 分を超えたら Ops に知らせ、同期の実行を止めて非同期に回す（非同期も reader の遅れが戻るまで待つ）。
- 共有の条件の閉包の世代・ルールの集合は、要求を固定した版のもの（ADR-0003）を使う。reader が版の変更をまだ反映していない時は、版の表で待つ（最大 5 秒）か、`METADATA_CHANGED` にする。

### 5.5 結果の保存とキャッシュ

- 非同期の結果は、S3 に組織のデータキーで暗号化して置き、24 時間で消す。取り出せるのは、実行した利用者だけ（`report_runs.user_id` と一致する時）。
- 同期の結果のキャッシュは、Valkey に `(定義のハッシュ, user_id, 権限の形, metadata_version, as_of の 60 秒の区切り)` をキーにして 5 分持つ。**利用者をまたいで共有しない。**
- 同じ権限の形でも、`$me`・部下・キューで共有の条件が違うので、結果を共有できない。コンパイル結果（SQL の形）だけを共有する。

### 5.6 事前の計算をしない理由

- 見る人をまたいで使える事前の集計（組織ごとの集計の表）は、見る人ごとの共有の条件で切り直せない。使えるのは `view_all_data` を持つ人だけになる。
- 事前の集計を見る人ごとに持つと、共有の変更・所属の変更のたびに作り直しになり、共有の再計算と同じ問題（ADR-0004）を持つ。
- MVP は、reader での集計と、見る人ごとの短いキャッシュで受ける。遅いレポートには、本家と同じく、親に積み上げ集計を持たせて子の集計を避けること、索引のある項目で条件を付けることを勧める（LDV）。
- S2 で、分析用の写し（列指向の置き場所）を検討する。写しにも共有の条件（閉包と共有の行の写し）を持ち込んで、見る人ごとに絞る形にする。別の ADR で決める（14 節）。

## 6. 見る人の権限での集計

- **集計は、見る人が見られる行だけで行う。** 件数、合計、平均、最小、最大、グループの数、クロス条件の子の有無、`row_limit` の順位の全てで、見えない行を無いものとして扱う（intent の「利用者が見られないレコードは、レポートの集計に現れない」）。
- 形式として：DB の状態 S、見る人 U、レポート R について、`run(R, U, S) = evaluate(R, restrict(S, U))`。`restrict(S, U)` は、U が `read` 以上で見られない行を消し、U が読めない項目を DT-RPT-001 で扱った状態。`evaluate` は、問い合わせの言語の参照の評価器で集計したもの。これを性質ベーステストの性質（`PROP-RPT-001`）にする。
- 外部結合（あってもなくても）では、子が全て見えない親は「子のない親」として出る。見る人から見た世界として一貫する。
- 組織全体の統計（計画の見積もり）を、結果にも画面にも出さない。
- 本家の集計が見えない行を数えないかの資料は確かめられなかった（未検証）。本システムは intent の約束として守る。

## 7. ダッシュボード（ADR-0030）

### 7.1 形

```
dashboard（folder、版、layout）
 ├─ view_mode：viewer（既定）| team_member
 ├─ filters（5 まで、各 50 の値）：部品のレポートの項目への条件
 └─ components（20 まで）
      ├─ source_report（サマリーかマトリックス）
      ├─ kind：bar | column | line | donut | funnel | metric | gauge | table
      └─ 表示の設定（並べ方、上位 N、単位）
```

- 部品 20・条件 5（各 50 の値）は、本家の値に合わせる（2 節。ヘルプの要約）。
- 部品は、元のレポートの定義に、ダッシュボードの条件を足したものを実行する。

### 7.2 見え方

**DT-DSH-001：ダッシュボードの見え方**（上から評価）

| # | `view_mode` | 見る人の権限 | 選んだ視点 | 集計の権限 |
| --- | --- | --- | --- | --- |
| 1 | - | フォルダの `view` なし | - | 開けない（404） |
| 2 | `viewer` | - | - | 見る人 |
| 3 | `team_member` | `view_my_team_dashboards` なし | - | 見る人（視点を選べない） |
| 4 | `team_member` | `view_my_team_dashboards` あり | なし（既定） | 見る人 |
| 5 | `team_member` | `view_my_team_dashboards` あり | ロール階層の部下 S | **S の権限 ∩ 見る人の権限** |
| 6 | `team_member` | `view_all_data` あり | 組織の任意の利用者 S | **S の権限 ∩ 見る人の権限**（`view_all_data` なので見る人の側は全て） |

- **共通部分**：行は「S が見られて、かつ見る人が見られる」ものだけ。項目は「S も見る人も読める」ものだけ。SQL では、S の共有の条件と見る人の共有の条件を `AND` でつなぎ、FLS は両方の権限の形の共通部分で DT-RPT-001 を当てる。
- 共通部分にするので、視点を選んでも、見る人が見られない行・項目は決して集計に入らない。部下の視点は「部下が見ている範囲に絞る」道具になり、広げる道具にならない。
- ロール階層の上司は、`grant_via_hierarchy` のオブジェクトでは部下の見られる行を見られる（共有の領域の 4.4 節）。その場合、共通部分は部下の見られる行と同じになる。
- 本家の「指定した実行ユーザー」（全員が特定の人の権限で見る。MDAPI の `SpecifiedUser`）は持たない。この形では、見る人が見られない行が集計に入り、intent の約束に反するため。本家から移る組織への影響は 16 節。

### 7.3 実行とキャッシュ

- 部品の実行は、レポートの実行（5 節）と同じ経路・予算を使う。1 つのダッシュボードの部品は並行で 4 つまで実行する。
- 結果は見る人ごと（部下の視点なら見る人 × 部下）に 10 分キャッシュする。「更新」の操作でキャッシュを使わずに実行し直す。1 人 1 分に 1 回まで。
- 組織のダッシュボードの更新は 1 時間に 200、結果の取得は 5,000 まで（RD API の値に合わせる）。全てのダッシュボードが見る人ごとの集計なので、本家の動的なダッシュボードの数の上限（エディションごと）は持たない。代わりに、この 1 時間の割り当てと、部品の数と、キャッシュで費用を抑える。
- 部品から元のレポートへのドリルダウンは、見る人の権限で（部下の視点なら同じ共通部分で）レポートを開く。

## 8. 定期の配信とエクスポート

### 8.1 定期の配信

- 利用者は、レポート・ダッシュボードを購読できる：頻度（毎日・毎週・毎月、時刻）、条件（「行が N を超えたら」など）、受け取る人。
- **受け取る人ごとに、その人の権限で実行する。** 購読した人の権限で 1 回実行して全員に送らない。受け取る人がフォルダを見られなければ、その人には送らない。
- 他の人を受け取る人に加えるには、`schedule_reports_for_others` のシステムの権限が要る。受け取る人は組織の利用者と、その利用者を含む公開グループ・ロールだけ。組織の外のアドレスには送らない（法務の L2・L4）。
- 1 人の購読は 5 まで（本家の値に合わせる。RD API）、1 つの購読の受け取る人は 50 まで。
- 実行は、指定の時刻から 30 分の中に散らす（毎時 0 分への集中を避ける）。非同期の経路（DT-RPT-002 の行 1）。
- メールの本文は、グループの上位 20 行とグラフの画像（部品）と、レポートへのリンク。詳細の行の添付（CSV）は、受け取る人が `export_reports` を持つ時だけ付ける。

### 8.2 エクスポート

- `export_reports` のシステムの権限を持つ人だけが、詳細の行を CSV・Excel で取り出せる（[sharing-and-record-access.md](sharing-and-record-access.md) の 3.2 節）。
- 非同期で実行し、100 万行まで。結果は S3 に 24 時間、本人だけが取り出せる。
- エクスポートは監査に残す（誰が、どのレポートを、何行、いつ）。audit-and-field-history の領域。

## 9. 上限（S1 の初期値）

| 上限 | 値 | 本家 |
| --- | --- | --- |
| レポートの型のオブジェクト | 4 | 4（MDAPI） |
| 列 | 100 | 100（RD API） |
| 表示の詳細の行 | 2,000 | 2,000（RD API、ヘルプの要約） |
| グループ | サマリー 3、マトリックス 行 2・列 2 | 同じ（ヘルプの要約） |
| 条件 | 20 | 20（RD API、ヘルプの要約） |
| クロス条件 | 3（副条件 5） | 3・5（ヘルプの要約） |
| グラフ・集計のグループ | 2,000 | 2,000（ヘルプの要約） |
| 同期の実行（API、組織、1 時間） | 500 | 500（RD API） |
| 非同期の実行（組織、1 時間） | 1,200 | 1,200（RD API） |
| 同時の同期の実行 | 利用者 2、組織 20 | 組織 20（RD API） |
| 非同期の結果の保持 | 24 時間 | 24 時間（RD API） |
| ダッシュボードの部品・条件 | 20・5（各 50 の値） | 20・5（ヘルプの要約） |
| ダッシュボードの更新・結果の取得（組織、1 時間） | 200・5,000 | 200・5,000（RD API） |
| 1 人の購読 | 5 | 5（RD API） |
| エクスポート | 100 万行 | 未検証 |

## 10. 障害のとき

| 事象 | 振る舞い |
| --- | --- |
| reader の遅れ | 30 秒で警告を付け、5 分で同期を止めて非同期に回す（5.4 節） |
| reader の障害 | 別の reader へ。全ての reader が使えなければ、レポートは非同期の待ちにし、writer では実行しない（書き込みの経路を守る） |
| 非同期の実行の Worker が止まる | 実行は `queued` のまま残る。再開で続ける。1 時間を超えたら利用者に知らせる |
| 結果が予算を超える | 同期は非同期に回し直す。非同期で 5,000 万行を超えたら `REPORT_TOO_LARGE` |
| 定期の配信の集中 | 30 分の中に散らす。遅れが 1 時間を超えたら警告 |
| レポートの型の元の項目の削除 | そのレポートは `REPORT_UNAVAILABLE`（項目が削除された）。項目の復元で戻る |
| キャッシュ（Valkey）の障害 | キャッシュなしで実行する。reader の負荷が増える |

## 11. セキュリティ

- 集計は見る人が見られる行だけ（6 節）。結んだ全てのオブジェクトに共有の条件をかける。
- 読めない項目を条件・グループ・集計に使うレポートは実行しない（DT-RPT-001）。数式と積み上げ集計の FLS を通す。
- ダッシュボードは、部下の視点でも共通部分で集計する（DT-DSH-001）。本家の「指定した実行ユーザー」の形を持たない。
- 定期の配信は受け取る人ごとに実行する。組織の外に送らない。
- 結果のキャッシュ・非同期の結果は利用者ごとで、他の人が取り出せない。S3 の結果は暗号化し、24 時間で消す。
- 計画の見積もり・組織の統計を、結果にも画面にも出さない。
- エクスポートは権限と監査で守る。
- フォルダの共有は定義だけを見せる。
- `security:sensitive` の対象：レポートのコンパイル（共有の条件と FLS）、DT-DSH-001 の共通部分、定期の配信の受け取る人ごとの実行、結果の保存の鍵。

## 12. テスト

- 決定表：`DT-RPT-001`（読めない項目）、`DT-RPT-002`（実行の経路）、`DT-DSH-001`（ダッシュボードの見え方）を spec から読み込む表駆動テストにする。
- 性質ベーステスト（fast-check）：
  - `PROP-RPT-001`（草案）：任意の DB の状態・利用者・レポートの定義（生成した型・条件・グループ・集計・クロス条件）で、本番の経路（Testcontainers の PostgreSQL で生成した SQL）の結果が、`evaluate(R, restrict(S, U))` と一致する。`restrict` は共有の領域の参照の評価器を使う。
  - `PROP-RPT-002`（草案）：任意の見る人 U と部下の視点 S で、部下の視点の結果が `evaluate(R, restrict(restrict(S_db, S), U))` と一致し、見る人の結果に入らない行が 1 つも入らない。
  - 任意の定義で、同期と非同期の結果が同じ（同じ時点の状態で）。
  - 任意の権限の変更の列で、キャッシュが他の利用者の結果を返さない（キャッシュのキーに利用者と権限の形が入る）。
- 経路ごとの否定側のテスト：見えない行が件数・合計・グループ・クロス条件・`row_limit` に効かない。見えない親の名前がグループの見出しに出ない。読めない項目で絞るレポートが実行できない。
- 上限の試験：9 節の各値で、ちょうどで通り、1 つ超えたら拒否（または非同期に回る）。
- 性能テスト：100 万件の商談の組織で、選択的な条件のサマリーのレポートの同期の実行が p95 5 秒以内。500 万件の全体の集計が非同期で 2 分以内。

## 13. この領域の ADR

| ADR | 決定 |
| --- | --- |
| [0029](../decisions/0029-report-execution-on-reader-per-viewer.md) | レポートは見る人の権限で毎回コンパイルし、結ぶ全てのオブジェクトに共有の条件と FLS をかけて reader で集計する。予算を超えたら非同期に回す。見る人をまたぐ事前の集計とキャッシュを持たない |
| [0030](../decisions/0030-dashboards-viewer-intersection-and-subscriptions.md) | ダッシュボードは見る人の権限で集計し、部下の視点は部下と見る人の権限の共通部分にする。指定した実行ユーザーの形は持たない。定期の配信は受け取る人ごとに実行する |

## 14. 他の領域への依頼と持ち越し

- metadata-and-runtime の領域：ADR-0007 の部品の一覧に `report_types` を足す。（2026-09-28 に反映済み：ADR-0007 の注記）
- 共有の領域：システムの権限に `view_my_team_dashboards`、`schedule_reports_for_others`、`manage_report_folders` を足す。
- governor-limits の領域：レポートの予算（5.3 節）を、トランザクションの上限とは別の一覧として載せる。
- query-language-and-api の領域：`/api/v1/reports/...`（実行、非同期の実行、結果）と `/api/v1/dashboards/...` を REST の一覧に足す。
- 持ち越し（S2）：分析用の写し。写しにも共有の条件を持ち込む。別の ADR で、置き場所（Aurora の別のクラスタの列指向の拡張、別の分析の DB など）を PoC で決める。

## 15. Story の候補

| Epic | Story の候補 |
| --- | --- |
| E1 | CI：`DT-RPT-*`・`DT-DSH-001` の表駆動テストの枠、`PROP-RPT-001`・`002` の性質ベーステストの枠 |
| E1 | Aurora の reader の構成と、reader の遅れの計測 |
| E2 | レポートとダッシュボードのフォルダと、自分のフォルダ |
| E3 | 問い合わせのコンパイラに、結ぶ全てのオブジェクトの共有の条件と、集計の SQL の生成を足す |
| E4 | 部下の視点の共通部分（2 人の共有の条件の `AND`、2 つの権限の形の FLS の共通部分）のコンパイラの部品 |
| E7 | 標準のレポートの型の自動の作成と、カスタムのレポートの型（4 オブジェクト、外部結合の規則） |
| E7 | レポートの定義（AST）と、表形式・サマリー・マトリックス、条件、クロス条件、`row_limit` |
| E7 | DT-RPT-001（読めない項目）と、見えない親のグループの見出し |
| E7 | 同期の実行（reader、予算、`as_of`）と、非同期への切り替え（DT-RPT-002） |
| E7 | 非同期の実行（Worker、S3 の結果、24 時間）と、見る人ごとのキャッシュ |
| E7 | グラフと、レポートの画面（[ui-layouts-and-list-views.md](ui-layouts-and-list-views.md) と共通の部品） |
| E7 | ダッシュボードの部品・条件・並べ方、見る人の形 |
| E7 | 部下の視点（DT-DSH-001）と `view_my_team_dashboards` |
| E7 | 定期の配信（受け取る人ごとの実行、散らし、本文）とエクスポート（権限、監査） |
| E7 | `PROP-RPT-001`・`002` と、経路ごとの否定側のテスト |
| E10 | レポートの型・レポート・ダッシュボードのメタデータのデプロイの対象への追加 |
| E11 | エクスポートと、他の人への配信の監査 |
| E12 | 大きな組織のレポートの性能テストと、reader の台数の見積もり（capacity の領域） |

## 16. 未解決の問い

- 本家の「指定した実行ユーザー」のダッシュボードを持たないことを、PM が受け入れるか。本家から移る組織では、全員が同じ数字を見る経営のダッシュボードが作れなくなる。
- 本家のレポートの集計が、見えない行を数えないか（未検証）。
- 同期の予算（20 秒、100 万行）は、画面の体験として妥当か。
- レポートを writer で実行しない方針で、reader の障害の時にレポートが止まってよいか。
- 分析用の写し（S2）の置き場所。
- 結合のレポート、サマリーの数式、バケットの項目、履歴の傾向のレポートをいつ入れるか。

### 決定

2026-09-28 の既定案。

- 「指定した実行ユーザー」は持たない（ADR-0030）。全員に同じ数字を見せたい時は、`view_all_data` を持つ人が、集計の値だけをスナップショットとして別のオブジェクトに保存するスケジュールのフローを作る案を、MVP の後に検討する。スナップショットのオブジェクトの共有は、通常の共有で決める。intent の約束との関係を PM に確認する（intent の変更が要るかもしれない）。
- 本家の振る舞いは確かめない。本システムは intent の約束として、見えない行を数えない。
- 同期は 20 秒・100 万行で始め、E7 の利用の計測で見直す。
- reader の障害の時は、レポートを待たせる。writer の書き込みの経路を守ることを優先する。
- 分析用の写しは S2 の前に PoC をして別の ADR にする。
- 結合のレポート・サマリーの数式・バケットは E7 の後半の Story の候補にし、履歴の傾向のレポートは MVP の後にする。

## 17. quality.md・runbooks・data-model に載せるもの

**quality.md**

- リスク：レポートの集計を通した、見えない行・読めない項目の漏れ（最重要の 1 つ）。`PROP-RPT-001`、経路ごとの否定側のテスト、共有の領域の本番の標本の照合をレポートの結果の行にも当てる。
- リスク：部下の視点で、見る人が見られない行が入る。`PROP-RPT-002`。
- リスク：キャッシュ・非同期の結果の取り違え（他の人の結果）。キーの性質ベーステストと結合テスト。
- リスク：レポートの負荷が reader を詰まらせ、他の組織のレポートを遅くする。組織ごとの同時の実行と DB の時間の計測。
- 上限の試験：9 節。
- 本番での検証：レポートの同期の実行の p95、非同期への切り替えの率、reader の遅れ、`REPORT_UNAVAILABLE` の件数。

**runbooks**

- `reader-replica-lag`：reader の遅れが 30 秒・5 分を超えた。
- `report-async-backlog`：非同期の実行の待ちが 1 時間を超えた。
- `report-heavy-org`：ある組織のレポートの DB の時間が多すぎる。重いレポートを特定し、条件の追加・積み上げ集計の利用を案内する。
- `report-subscription-delay`：定期の配信の遅れが 1 時間を超えた。
- SLI の追加の依頼（Ops へ）：レポートの同期の実行の p95・p99、非同期の実行の待ちの時間、reader の遅れ、組織ごとのレポートの DB の時間、ダッシュボードの 1 時間の更新の数、定期の配信の遅れ。

**data-model**

| テーブル | 主な列 | 備考 |
| --- | --- | --- |
| `md_report_types` | `org_id`、`report_type_id`、`api_name`、`base_object_id`、`joins`（JSONB）、`sections`、`is_standard`、`deployed` | メタデータ |
| `report_folders`、`report_folder_shares` | `org_id`、`folder_id`、`kind`（`report`・`dashboard`）、`owner_id`、`grantee_group_id`、`access`（`view`・`edit`・`manage`） | |
| `reports` | `org_id`、`report_id`、`folder_id`、`report_type_id`、`definition`（JSONB）、`version`、`owner_id` | 利用者の作るものなので、データとして持つ（版を上げない）。デプロイの対象にはする |
| `report_runs` | `org_id`、`run_id`、`report_id`、`user_id`、`view_as_user_id`、`mode`（`sync`・`async`）、`state`、`as_of`、`s3_key`、`rows`、`db_ms`、`expires_at` | 非同期の結果は 24 時間 |
| `dashboards`、`dashboard_components` | `org_id`、`dashboard_id`、`folder_id`、`view_mode`、`filters`、`component_id`、`source_report_id`、`kind`、`settings` | |
| `report_subscriptions`、`report_subscription_recipients` | `org_id`、`subscription_id`、`target_kind`、`target_id`、`owner_id`、`schedule`、`condition`、`recipient_kind`、`recipient_id` | 受け取る人ごとに実行 |
| `report_exports` | `org_id`、`export_id`、`report_id`、`user_id`、`rows`、`s3_key`、`created_at`、`expires_at` | 監査にも写す |

# Reporting: Workday

レポートを決める。時点を指定したレポート（`effective_on`・`known_at`）、組織図、人員の推移、残業・休暇・給与の集計、法定の帳簿の出力、権限の効くレポートの実行、少人数の集計の抑止、出力、分析用の基盤（S2）を扱う。

前提の決定は、人事のデータを 2 軸で持つこと（[ADR-0002](../decisions/0002-effective-dated-data-model.md)）、時点の問い合わせの `known_at` を安定の境界より前に限ること（[ADR-0008](../decisions/0008-point-in-time-queries-and-activation-timers.md)）、画面・API・レポート・一括の出力で同じ権限の判定を通すこと（[ADR-0005](../decisions/0005-security-and-my-number.md)、[ADR-0017](../decisions/0017-authorization-evaluator.md)）、機微なドメインの閲覧を記録すること（[ADR-0020](../decisions/0020-sensitive-read-audit-and-access-explanations.md)）。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0040](../decisions/0040-declarative-reports-and-analytics-store.md) | レポートは宣言の定義（データの元、列、条件、集計、時点の引数）で持ち、テナントに SQL を書かせない。実行は `scopeFilter`・`project` を通した SQL で行い、実行ごとに時点・定義のバージョン・結果のハッシュを記録する。S1 は Aurora のレポート専用の reader、S2 は S3 の Iceberg の表と Athena に移す。分析用の基盤も、同じレポートのサービスからだけ読む |
| [0041](../decisions/0041-small-cell-suppression-for-sensitive-aggregates.md) | 給与の額などの機微な値の集計は、個々の値を見る権限のない利用者に対して、人数 5 人未満の区分を伏せ、伏せた区分が合計から逆算できないよう 2 次の抑止をかける。集計の軸と条件を許可リストに限る |

## 1. 目的と範囲

- 扱う：レポートの定義と実行、時点の指定、組織図、標準のレポートの一覧、法定の帳簿（労働者名簿、賃金台帳、出勤簿、年次有給休暇管理簿）の出力、権限と閲覧の記録、少人数の集計の抑止、出力の形式と取り出し、実行の資源の上限、分析用の基盤（S2）。
- 扱わない：画面の部品（[self-service-ui.md](self-service-ui.md)）、権限の判定そのもの（[security-model.md](security-model.md)）、一括の出力（連携の形式。[integrations-and-bulk.md](integrations-and-bulk.md)。ただし実行の仕組みはこの文書と共有する）、帳簿の保存の期間（[audit-and-retention.md](audit-and-retention.md)）、給与の仕訳の出力（[payments-and-accounting.md](payments-and-accounting.md) の 7 節）。
- **レポートのために別の経路で DB を読まない**（[AGENTS.md](../../AGENTS.md)）。レポートも、`packages/authz` の `scopeFilter` と `project` を通す。

## 2. 本家の形（確かめたこと）

本家の実装は使わない（[リポジトリ共通の ADR-0007](../../../../docs/decisions/0007-no-reuse-of-original-implementation.md)）。

| 本家の考え方 | 内容 | このシステムでの扱い |
| --- | --- | --- |
| レポートと権限 | レポート・モバイル・API・業務プロセスに同じロールの権限が効く（[ホワイトペーパー](https://www.workday.com/content/dam/web/en-us/documents/whitepapers/whitepaper_workday_technology_platform_devt_process.pdf)、2026-09-28 に確認） | 同じ（4 節） |
| 有効日付とレポート | 追記の DB を、有効日付と時点のレポートに使う（[DBMS2, 2010](https://www.dbms2.com/2010/08/22/workday-technology-stack/)。古い第三者の記事で、現在の実装は未検証） | `effective_on`・`known_at` の引数（3 節） |
| レポートの作り方 | データの元（data source）と項目を選んでレポートを作る利用者向けの道具を持つとされる（二次資料。未検証） | 宣言の定義（[ADR-0040](../decisions/0040-declarative-reports-and-analytics-store.md)）。SQL は書かせない |

## 3. 時点（[ADR-0040](../decisions/0040-declarative-reports-and-analytics-store.md)）

| 引数 | 意味 | 既定 | 権限 |
| --- | --- | --- | --- |
| `effective_on` | 有効日。1 日、または期間（`from`〜`to`。推移のレポート） | 今日 | レポートのドメインの `view` |
| `known_at` | 記録時刻。この時刻にシステムが知っていた内容で出す | 省く（現在の知識） | 加えて `audit` |

- `known_at` は安定の境界（今 − 10 秒）以下に丸め、実行の記録に丸めた値を残す（[ADR-0008](../decisions/0008-point-in-time-queries-and-activation-timers.md)）。
- `known_at` を省いた実行も、開始の時刻を `resolved_known_at` として記録する。同じ定義のバージョン・同じ引数・同じ `resolved_known_at` で出し直すと、同じ行が出る（PROP-RPT-001）。現在の知識の表で読んだ実行は、監査の画面で「再現」を押したとき、バージョンの表で読み直して一致を確かめる。
- 期間の推移（例：4 月〜翌 3 月の月末ごとの人員）は、各点の `effective_on` を並べて評価する。1 回の実行で最大 60 点。
- 組織の範囲の判定（`scopeFilter`）は、`effective_on` と今日の早いほうの時点の組織で行う（[security-model.md](security-model.md) の 4.2 節）。**レポートの時点の組織ではなく、権限の規則の時点で絞る。**

## 4. 定義と実行（[ADR-0040](../decisions/0040-declarative-reports-and-analytics-store.md)）

### 4.1 データの元

システムがデータの元（report source）を持つ。テナントは足せない。データの元は、読む表と、選べる列（列ごとにドメイン）と、主体の組織の列（`scopeFilter` の対象）を宣言する。

| データの元 | 行の単位 | 主な列（ドメイン） |
| --- | --- | --- |
| `workers_as_of` | 雇用 × 主たる職務（時点） | 表示の名前・所属・職位（`worker.public`）、職務・等級・事業所（`worker.job`）、在籍・入社日・雇用区分（`worker.employment`）、基本給（`worker.compensation`） |
| `job_history` | 職務の割り当てのバージョン | 異動・昇格の履歴（`worker.job`） |
| `org_tree_as_of` | 組織（時点） | 組織、親、上長、人数（`org.structure`） |
| `positions_as_of` | ポジション | 空き、職務（`position.management`） |
| `time_summaries` | 雇用 × 月 | 労働時間の区分、36 協定の値（`time.records`） |
| `leave_balances_as_of` | 雇用 × 休暇の種類 | 残り、取得、年 5 日の進み（`absence`） |
| `payroll_result_lines` | 雇用 × 実行 × 項目 | 金額（`payroll.results`） |
| `bp_cases` | 案件 | 種類、状態、期限、担当（業務プロセスの `view`） |

- マイナンバー、口座番号、要配慮個人情報は、どのデータの元にも列を持たない。
- 列の追加はデータの元のバージョンの変更で、CI で「ドメインのない列」を拒む（[security-model.md](security-model.md) の 3.1 節と同じ規則）。

### 4.2 定義

```ts
// Report definition (tenant data, versioned). No free-form SQL.
type ReportDefinition = {
  source: ReportSourceId;
  columns: ColumnRef[];                 // must exist in the source; each has a domain
  filters: FilterExpr;                  // same typed expression tree as BP conditions (ADR-0013)
  groupBy?: ColumnRef[];                // only dimensions allowed by the source
  measures?: { fn: "count" | "sum" | "avg" | "min" | "max"; column: ColumnRef }[];
  asOf: { kind: "date" | "series"; from?: string; to?: string; step?: "month_end" | "day" };
  freshness?: "live" | "previous_day";  // S2: analytics store allowed when previous_day
  sort?: SortSpec[];
};
```

- 定義は `report_definitions`（バージョンつき）。条件は業務プロセスの式の木（[ADR-0013](../decisions/0013-bp-definition-format-and-versions.md)）の核を使う。
- 標準のレポート（5 節）はシステムの定義で、テナントは写して変えられる。
- 定義の保存のとき、列・条件・集計の型と、機微な値の集計の規則（7 節）を静的に検査する。

### 4.3 実行

```
画面・API ─▶ report-service（API のプロセスの中のモジュール）
   1. 定義のバージョンと引数を決める（resolved_known_at を含む）
   2. 列ごとに、利用者の権限で見られるかを project で判定し、見られない列を落とす
   3. scopeFilter の SQL の条件を足して、SQL を組み立てる（パラメーター化。文字列の連結はしない）
   4. 行数の見込みが 1,000 以下なら同期で返す。超えるなら非同期のジョブ（Worker）にする
   5. 機微な値の集計なら、抑止（7 節）をかける
   6. 実行の記録（report_runs）と、閲覧の記録（ADR-0020）を書く
```

- 同期の実行は `statement_timeout = 10s`。非同期は 15 分で打ち切る。
- 非同期の結果は S3 の `report-outputs/{tenant}/{run_id}`（テナントのデータの鍵。[security.md](security.md) の 5 節）に置き、7 日で消す。取り出しは実行した本人だけ、15 分の 1 回限りの URL で、取り出しを記録する。
- テナントごとの同時の非同期の実行は 5、利用者ごとは 2。支給日の前の 5 営業日は、給与の担当の実行を先にする（6 節）。
- 実行の記録（`report_runs`）：定義のバージョン、引数、`resolved_known_at`、利用者、落とした列、抑止した区分の数、行数、結果の SHA-256、所要時間。値は記録しない。

### 4.4 出力の形式

| 形式 | 用途 | 注意 |
| --- | --- | --- |
| 画面の表 | 同期の実行 | 1,000 行まで |
| CSV | 表計算への取り込み | UTF-8（BOM つきを選べる）。`=`・`+`・`-`・`@` で始まる値の先頭に `'` を足す（数式の注入を防ぐ） |
| Excel（xlsx） | 同上 | 値は文字列か数で書き、式を書かない |
| PDF | 法定の帳簿、組織図 | 実行の時刻と定義のバージョンを欄外に出す |

## 5. 標準のレポート

| レポート | データの元 | 時点 | Epic |
| --- | --- | --- | --- |
| 人員の一覧 | `workers_as_of` | 1 日 | E12 |
| 人員の推移（月末ごと、組織別） | `workers_as_of` | 期間 | E12 |
| 異動の履歴 | `job_history` | 期間 | E12 |
| 組織図 | `org_tree_as_of` | 1 日（8 節） | E12 |
| 残業の集計（組織別、36 協定の段） | `time_summaries` | 月 | E12 |
| 休暇の取得状況（年 5 日の進み） | `leave_balances_as_of` | 1 日 | E12 |
| 給与の集計（組織・項目別） | `payroll_result_lines` | 実行 | E12 |
| 従業員ごとの補助元帳（仕訳の従業員の内訳） | `payroll_result_lines` | 実行 | E12（[ADR-0037](../decisions/0037-payroll-journal-export.md) の Consequences） |
| 業務プロセスの滞留 | `bp_cases` | 今 | E12 |

### 5.1 法定の帳簿

| 帳簿 | 根拠 | 元のデータ | 決めた領域 |
| --- | --- | --- | --- |
| 労働者名簿 | 労働基準法 107 条 | 人・雇用・職務の facet の時点の値 | [core-hr.md](core-hr.md)（`statutory-registers`） |
| 賃金台帳 | 108 条、施行規則 54 条 | `wage_ledger`（射影） | [payments-and-accounting.md](payments-and-accounting.md) の 6 節 |
| 出勤簿（労働時間の記録） | 109 条（その他の重要な書類） | 日ごとの結果と打刻 | [time-and-attendance.md](time-and-attendance.md)（`statutory-registers`） |
| 年次有給休暇管理簿 | 施行規則 24 条の 7 | 台帳の射影 | [absence-and-leave.md](absence-and-leave.md) の 6 節 |

- 帳簿の出力は、この文書の実行の仕組み（4.3 節）で行う。帳簿の保存（何年、いつから数えるか）は [audit-and-retention.md](audit-and-retention.md) の規則表で決め、出力のファイルではなく元のデータを保存の対象にする。
- 帳簿の記入の事項を満たすかは、各領域の社労士の確認（L16、L39）に従う。

## 6. 資源の上限と実行の場所（[ADR-0040](../decisions/0040-declarative-reports-and-analytics-store.md)）

### 6.1 S1

- Aurora のレポート専用の reader を 1 台置き、カスタムエンドポイント（`reports`）で分ける。セルフサービスと給与の入力の固定は、別の reader を使う（[infrastructure.md](infrastructure.md) の 5 節）。
- レポートの DB のロール `report_app` は、読み取りだけ・RLS の対象・`statement_timeout` を持つ。
- `known_at` を指定した大きな一覧は、バージョンの表の GiST の索引（[ADR-0006](../decisions/0006-temporal-table-triplet-and-fold.md)）で引く。同期の画面では 1,000 行まで（[object-model-and-effective-dating.md](object-model-and-effective-dating.md) の 7 節）。

### 6.2 S2：分析用の基盤

S2（最大のテナント 10 万人）では、推移・集計のレポートが Aurora の reader を圧迫する見込みなので、分析用の基盤に移す（[architecture/README.md](README.md) の 2 節）。

```
Aurora（正本）──▶ 夜間の書き出し（テナントごと、変更した主体だけ）──▶ S3
                    データの元の列だけを Apache Iceberg の表に                Iceberg の表：tenant_id でパーティション
                                                                                   ▲
report-service ── 同じ定義・同じ scopeFilter・project の SQL を Athena 向けに組み立てる ─┘
```

- 書き出すのは、データの元（4.1 節）の列だけ。マイナンバー・口座・住所・要配慮は書き出さない。氏名は表示の名前だけ。
- 分析用の基盤には、組織の閉包も書き出し、`scopeFilter` を同じ形で組み立てる。
- Athena の問い合わせは report-service のロールだけが実行できる。利用者やテナントの管理者に Athena や S3 の直接の権限を与えない。Lake Formation の行の絞り込みは使わない（利用者ごとの範囲が動的で、report-service の判定と二重になるため）。
- 鮮度は前日の終わりまで。当日の値が要るレポートは Aurora の reader で実行する（定義の `freshness`）。
- 費用：Athena は東京で走査 1 TB あたり 5 USD（[AWS Price List API](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonAthena/current/ap-northeast-1/index.json)、2026-09-28 に確認）。パーティションと列の選び方で走査を減らす。
- 移る時期と基準は [infrastructure.md](infrastructure.md) の 9 節。

## 7. 少人数の集計の抑止（[ADR-0041](../decisions/0041-small-cell-suppression-for-sensitive-aggregates.md)）

### 7.1 問題

- 部長が、自部署の給与の合計は見てよいが、個人の給与は見てはならない、という設定がありうる。部署が 1〜2 人なら、合計がそのまま個人の額になる。
- 区分を細かく重ねる（組織 × 等級 × 入社の年）と、1 人の区分ができる。
- 合計と、1 つを除くすべての区分を出すと、残りの 1 つが逆算できる。
- 条件を少しずつ変えて 2 回実行し、差を取ると、1 人の値が分かる（差分の攻撃）。

### 7.2 規則（DT-RPT-002）

| # | 規則 |
| --- | --- |
| 1 | 機微な値（[security-model.md](security-model.md) の 3.1 節の「機微」のドメインの列。給与の額、休職の種類など）の集計に適用する。人数の数え上げ（`count`）だけのレポートには適用しない |
| 2 | 利用者が、その区分の全員について、その値を 1 人ずつ見る権限（`view`）を持つなら、抑止しない（給与の担当など） |
| 3 | そうでなく、集計だけを許す権限（操作 `aggregate`。[security-model.md](security-model.md) の 3.2 節）で見るとき、人数が `k` 未満の区分の値を伏せる。`k` の既定は 5。テナントは上げられるが、3 未満にはできない |
| 4 | 1 次で伏せた区分があれば、行・列の合計から逆算できないよう、同じ行・列で次に小さい区分も伏せる（2 次の抑止）。合計の行は「伏せた区分を除く合計」と明示する |
| 5 | 集計の軸（`groupBy`）は、データの元が許した軸（組織、等級、雇用区分、事業所、月）だけ。条件（`filters`）に個人を特定できる列（入社日の等号、社員番号、表示の名前）を使えない |
| 6 | 同じ利用者が、同じデータの元・同じ値の列で、条件だけが違う実行を 24 時間に繰り返したとき、2 つの実行の対象の集合の差が `k` 未満になれば、後の実行の値を伏せる。対象の ID の集合は report-service の中だけで持ち、24 時間で消す |

- 伏せた区分は「—（5 人未満）」と出す。値の有無や大きさを推測させない。
- 抑止をかけた実行は、実行の記録に抑止の数を残す（どの区分を伏せたかは残さない）。
- 抑止は report-service の最後の段で行い、画面・CSV・PDF・API のどれでも同じ結果にする（PROP-RPT-002）。

### 7.3 限界

- 規則 6 は、同じ利用者の短い期間の繰り返しだけを見る。複数の利用者の結託や、長い期間の蓄積は防げない。集計だけの権限を与える人を少なくし、実行の記録の抜き取りで見る。
- 仕訳の出力（部門 × 勘定）は、このレポートの外で、出力の権限を経理の担当に絞って扱う（[payments-and-accounting.md](payments-and-accounting.md) の 10 節）。部門の人数が少ないときに同じ `k` で警告を出す案を E10 で決める。

## 8. 組織図

- `org_tree_as_of(effective_on)` で、閉包（[ADR-0011](../decisions/0011-effective-dated-org-hierarchy-closure.md)）から、指定の組織の下 2 段を返す。深い段は開いたときに読む。
- 1 つの箱に、組織の名前、上長（表示の名前と写真。`worker.public`）、人数、空きのポジションの数を出す。人数は在籍の数（7 節の規則 1 で抑止しない）。
- 兼務の人は、主たる職務の組織に出し、兼務の組織には印つきで出す。
- 将来の再編（将来日付の差分）は、`asOf` を変えて見る（[self-service-ui.md](self-service-ui.md) の 5 節）。「今日」と「4 月 1 日」を並べる表示を持つ。
- 全社の組織図の PDF は非同期の実行。3,000 組織で 60 秒以内を目標にする。

## 9. 規模

- S1：レポートの実行は 1 日数万回（多くは画面の同期の一覧）。非同期は 1 日数千回。支給日の前と年度の変わり目（4 月）に集中する（初期見積もり）。
- 最大のテナント（3 万人）の人員の推移（12 点）は、Aurora の reader で 1〜2 分の見込み（初期見積もり。E12 で測る）。
- S2 の分析用の基盤の書き出し：夜間の差分で 1 日数百万行（初期見積もり）。

## 10. 障害のときの振る舞い

| 障害 | 振る舞い |
| --- | --- |
| レポートの reader が落ちる | カスタムエンドポイントの残りの reader に移る。なければ非同期の実行を待たせ、同期の実行は 503。writer には回さない |
| 非同期のジョブの途中の失敗 | 1 回だけ再試行する。失敗したら利用者に通知し、実行の記録に失敗を残す |
| 権限の判定の失敗 | 拒否にする（fail closed。[security-model.md](security-model.md) の 12 節） |
| 分析用の基盤の書き出しの遅れ | `freshness` が前日のレポートに「データは YYYY-MM-DD まで」を出す。24 時間を超えたら Aurora の reader で実行する（遅くてよい） |
| 抑止の処理の例外 | 値の列をすべて伏せて返す（fail closed） |

## 11. セキュリティとプライバシー

- レポートの SQL は report-service だけが組み立てる。テナントの定義の値はパラメーターとして渡す。
- 閲覧の記録（[ADR-0020](../decisions/0020-sensitive-read-audit-and-access-explanations.md)）：機微なドメインの列を含む実行は、要求ごとに条件・件数・対象の一覧のハッシュを記録する。取り出しも記録する。
- 出力のファイルは 7 日で消す。利用者がダウンロードした後のファイルはシステムの外なので、画面で「個人情報を含みます」を出す。
- テストのデータは合成の人だけ（[AGENTS.md](../../AGENTS.md)）。

## 12. テスト

### 12.1 決定表

- DT-RPT-001：列の扱い（列のドメイン × 利用者の権限（`view`・`aggregate`・なし）× 集計の有無 → 出す・集計だけ・落とす）。
- DT-RPT-002：抑止（7.2 節。区分の人数 × 利用者が全員の `view` を持つか × `k` → 出す・伏せる。2 次の抑止の行を含む）。

### 12.2 性質ベーステスト

| ID | 性質 |
| --- | --- |
| PROP-RPT-001 | 任意の定義・引数で、同じ定義のバージョン・同じ引数・同じ `resolved_known_at` の 2 回の実行は、同じ行（同じハッシュ）を返す。その間に有効日付の書き込みがあっても変わらない |
| PROP-RPT-002 | 任意の権限の割り当てで、レポートの行と列は、同じ対象への `can`・`project` の結果と一致する（PROP-SEC-001 のレポートのバージョン）。画面・CSV・API で同じ |
| PROP-RPT-003 | 任意の機微な値の集計で、抑止の後の表から、`k` 未満の区分の値を、表に出た値の足し算・引き算で求められない |
| PROP-RPT-004 | 任意の 2 テナントで、一方のレポートに他方の行が出ない（Aurora と分析用の基盤の両方） |

### 12.3 例と結合

- 3 人の部署の給与の合計が、集計だけの権限の利用者に伏せられ、給与の担当には出る。
- 条件を 1 人ずつ変えた 2 回の実行で、後の実行が伏せられる（規則 6）。
- CSV の数式の注入の値が無害になる。

## 13. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E12 | `report-sources-and-definitions` | 4.1・4.2 節。データの元の宣言、定義のバージョン、静的な検査 |
| E12 | `report-runner` | 4.3 節（PROP-RPT-001・002・004）。同期と非同期、実行の記録、出力 |
| E12 | `report-point-in-time` | 3 節。`effective_on`・`known_at`・期間 |
| E12 | `report-suppression` | 7 節（DT-RPT-002、PROP-RPT-003） |
| E12 | `org-chart` | 8 節 |
| E12 | `standard-reports` | 5 節の標準のレポート |
| E12 | `statutory-registers` | 5.1 節の 4 つの帳簿の出力（各領域の Story と一緒に） |
| S2 の前 | `analytics-store` | 6.2 節。Iceberg の書き出し、Athena の実行、鮮度 |

## 14. 未解決の問い

### 決定

- **テナントに SQL を書かせない。** データの元はシステムが持つ。
- **レポートの組織の範囲は、権限の規則の時点（`effective_on` と今日の早いほう）で絞る。**
- **機微な値の集計の抑止の `k` は既定 5、下限 3。**
- **S2 の分析用の基盤は S3 の Iceberg と Athena。report-service からだけ読む。**
- **出力のファイルは 7 日で消す。**
- **集計だけの操作 `aggregate` を [security-model.md](security-model.md) の 3.2 節に足す**（統合の工程で決めた）。部門の長に個人の額を見せずに人件費の合計を見せる運用のため。`aggregate` の集計は必ず 7 節の抑止を通る。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| 仕訳の出力の少人数の部門の扱い | E10 で payments-and-accounting と |
| 分析用の基盤のアカウント（prod の中か、別の analytics のアカウントか） | S2 の前に infrastructure と |
| テナントに外部の BI の道具への連携を出すか | MVP の後。出すなら一括の出力（[integrations-and-bulk.md](integrations-and-bulk.md)）の経路で |

## 15. quality.md・runbooks・data-model への項目

### quality.md

- レポートと API の判定の突き合わせ（PROP-RPT-002 の本番の抜き取り）の不一致の件数（目標 0）。
- 抑止の件数と、規則 6 の検知の件数。
- 同期のレポートの p95、非同期の完了の時間。
- `known_at` の実行の再現の確認の不一致（目標 0）。

### runbooks

- `report-reader-saturation.md`：レポートの reader の飽和。同時の実行の上限の引き下げ、重い定義の特定。
- `analytics-export-lag.md`：分析用の基盤の書き出しの遅れ（S2）。

### data-model（索引への追加の提案）

| 置き場所 | 中身 |
| --- | --- |
| Aurora（テナントの外）`report_sources` | 4.1 節。システムの定義 |
| Aurora `report_definitions`（バージョン） | 4.2 節 |
| Aurora `report_runs` | 4.3 節。値は持たない |
| S3 `report-outputs/{tenant}/{run_id}` | 7 日で消す |
| S3（S2）分析用の Iceberg の表 | 6.2 節。`tenant_id` でパーティション |

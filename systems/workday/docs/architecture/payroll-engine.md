# Payroll engine: Workday

給与計算の実行（準備、入力の固定、計算、確認、確定、支払、取消）、入力のスナップショット（`known_at` とハッシュ）、支給・控除の項目の依存のグラフ、テナントが定義する式、再現性、遡及の差額、賞与と臨時の実行、並行稼働の比較、Payroll Compute の分割、営業日の暦を決める。

前提の決定は、給与計算を入力のスナップショット・規則表の版・エンジンの版から決まる純粋な計算にし、遡及は差額として次の計算に出すこと（[ADR-0004](../decisions/0004-payroll-engine.md)）、お金は整数の円と固定小数点で扱い、丸めは名前付きの関数だけで行うこと（[ADR-0001](../decisions/0001-platform-and-stack.md)）、`known_at` は安定の境界より前に限ること（[ADR-0008](../decisions/0008-point-in-time-queries-and-activation-timers.md)）。日本の法定の計算の中身は [payroll-jp-rules.md](payroll-jp-rules.md)、振込・明細・仕訳は [payments-and-accounting.md](payments-and-accounting.md) にある。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0026](../decisions/0026-payroll-run-stages-and-input-snapshot.md) | 給与の実行は給与のグループ × 期間 × 種類ごとの状態機械で、段の移動は業務プロセスで行う。入力の固定は、1 人ずつの入力の文書を JSON の正規の形（RFC 8785）にして SHA-256 を取り、S3 に内容のアドレスで置く。結果は入力のハッシュ・規則表の版・エンジンのダイジェスト・設定の版とともに追記する |
| [0027](../decisions/0027-pay-item-graph-and-formula-language.md) | 項目は段（支給、控除の前、社会保険、税、控除、差引）を持つ依存のグラフで、保存のときに循環を拒む。テナントの式は型のある式の木（業務プロセスの式と同じ核）で、円と 10 進と分の型を区別し、円への変換は名前付きの丸めだけ。割り算は按分と時間単価の関数だけ。法定の項目はシステムが持ち、テナントは変えられない |
| [0028](../decisions/0028-retro-deltas-and-bonus-runs.md) | 遡及は、確定した期間を新しい `known_at` の入力と、その期間の規則表で計算し直し、元の結果（と前の差額）との差を項目ごとに当期の差額の行として出す。元の入力をいまのエンジンで計算して一致しなければ止める。既定の窓は 24 か月。賞与は別の種類の実行で、前月の月次の確定を前提にする |
| [0029](../decisions/0029-parallel-run-and-compute-partitioning.md) | 計算は、従業員の ID の順の決まった束（既定 250 人）ごとに ECS のタスクで行い、束の結果をファイルにしてから DB に 1 トランザクションで入れる。並行稼働は現行のシステムの結果を項目の対応表で取り込み、従業員 × 項目 × 月の差を分類する。3 か月（賞与の月を含む）続けて説明のない差が 0 件で切り替える |

## 1. 目的と範囲

- 扱う：給与のグループと期間、営業日の暦、実行の段と状態、入力の固定、計算の順序と項目、テナントの式、結果の保存、確認の検査、確定と取消、遡及、賞与と臨時の実行、並行稼働、計算の分割と並列、再現の検査、ゴールデンデータセットの形。
- 扱わない：源泉所得税・社会保険料・雇用保険料・住民税・割増賃金の計算の中身（[payroll-jp-rules.md](payroll-jp-rules.md)）、振込ファイル・明細・賃金台帳・仕訳（[payments-and-accounting.md](payments-and-accounting.md)）、勤怠の集計（[time-and-attendance.md](time-and-attendance.md)）、年末調整（E13。[payroll-jp-rules.md](payroll-jp-rules.md) の 10 節）。

## 2. 本家の形（確かめたこと）

- 本家は給与計算のような重い計算を、別の計算のサービスで、メモリーの中のデータのスナップショットから行う（[ホワイトペーパー](https://www.workday.com/content/dam/web/en-us/documents/whitepapers/whitepaper_workday_technology_platform_devt_process.pdf)、2026-09-28 に確認）。
- 日本の給与計算を本家が自社の機能で持つかは確かめられず、パートナーとの連携で扱う形と見られる（[ADR-0004](../decisions/0004-payroll-engine.md) の Context。未検証）。
- 本家の遡及（retro）の計算の細部と、給与の項目の定義の形は確かめていない（未検証）。本システムの設計は本家に依らない（[リポジトリ共通の ADR-0007](../../../../docs/decisions/0007-no-reuse-of-original-implementation.md)）。

## 3. 給与のグループ、期間、暦

### 3.1 給与のグループ

```sql
pay_groups (tenant_id, id, company_id, code, frequency text,   -- monthly (MVP)
            cutoff_rule jsonb,     -- e.g. {"day": 20} or {"day": "eom"}
            pay_date_rule jsonb,   -- e.g. {"month_offset": 0, "day": 25, "if_holiday": "previous_business_day"}
            time_period_link text, -- same_as_payroll | previous_period
            si_deduction_timing text,  -- next_month (default) | same_month  (payroll-jp-rules 4.5)
            calendar_id, go_live_on date,  -- integrations-and-bulk 4.2
            valid daterange)
pay_periods (tenant_id, id, pay_group_id, period_start, period_end, pay_date, cutoff_date,
             time_period_id, state)
```

- 1 人は、日ごとにちょうど 1 つの給与のグループに属する（雇用の facet `employment_pay_group`。会社の中で選ぶ）。月の途中の移動は、移動の前と後の期間でそれぞれ日割りにする（[payroll-jp-rules.md](payroll-jp-rules.md) の 8 節）。
- MVP の頻度は月給だけ。半月・週の支払いは持たない（日額表の日給・日割りの支払いは、月 1 回の支払いの中の計算で扱う）。

### 3.2 営業日の暦

- 営業日の暦（`business_calendars`）はこの領域が持つ。業務プロセスの期限（[business-process-engine.md](business-process-engine.md) の 10.1 節）も同じ表を使う。
- 中身：土日、国民の祝日（内閣府の [syukujitsu.csv](https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv) を規則表 `holidays_jp` として取り込む。形式は [payroll-jp-rules.md](payroll-jp-rules.md) の 2.1 節）、テナントの休日、銀行の休業日（銀行の休日は、国民の祝日に関する法律の休日、12 月 31 日〜1 月 3 日、土曜日。[銀行法施行令](https://laws.e-gov.go.jp/law/357CO0000000040) 5 条 1 項、e-Gov で 2026-09-28 に確認）。
- 支給日が休日のときの扱いは給与のグループの設定（前の営業日が既定）。

## 4. 実行の段（[ADR-0026](../decisions/0026-payroll-run-stages-and-input-snapshot.md)）

### 4.1 状態

```
 draft ─freeze─▶ frozen ─compute─▶ computing ─▶ computed ─review─▶ in_review ─finalize(bp)─▶ finalized ─release(bp)─▶ released
   │               │                               │                 │   ▲                      │
   └──────────────┴───────────── cancel ──────────┴─────────────────┘   └ recompute_one          └ payroll_cancel(bp) ─▶ cancelled
```

| 段 | すること | 業務プロセス | 取り消し |
| --- | --- | --- | --- |
| `draft` | 対象の給与のグループ、期間、種類（`regular`・`bonus`・`off_cycle`）、対象者の条件を決める | — | できる |
| `frozen` | 入力を固定する（5 節）。勤怠の期間が `hr_locked` でない人がいれば、一覧を出して止める（人事が理由つきで除外できる） | — | できる（捨てて作り直す） |
| `computing` | 束ごとに計算する（9 節） | — | できる |
| `computed` → `in_review` | 確認の検査（11 節）、前回との差、並行稼働の差 | — | できる |
| 1 人の再計算 | 1 人の入力を新しい `known_at` で固定し直して計算する（NFR-003 の 5 秒） | — | — |
| `finalized` | 結果を固定する。仕訳を作る。明細を作る（公開は `released` の後） | `payroll_finalize`（委任は既定で不可） | 支払の前なら `payroll_cancel` |
| `released` | 振込ファイルの承認、明細の公開 | `payroll_payment_release` | できない。誤りは次の実行の差額で直す |
| `cancelled` | 結果を無効にする。仕訳は逆仕訳。明細は公開の前に破棄 | `payroll_cancel` | — |

- 同じ給与のグループ・期間・種類で、`cancelled` 以外の実行は 1 つだけ（`regular`）。`bonus` と `off_cycle` は同じ月に複数を許すが、順に確定する（8 節）。
- 状態の遷移は `payroll_runs` の楽観ロックと、`bp_events` の記録で行う。遷移の表は DT-PAY-001。
- 職務分掌：`payroll.input` の個別の調整と `payroll_finalize` の承認、`compensation_change` と `payroll_finalize`、口座の変更の承認と `payroll_payment_release` は同じ人が持てない（[security-model.md](security-model.md) の 5 節の S1・S2・S4）。

### 4.2 期限

- 実行の予定（支給日から逆算した、勤怠の締め・入力の固定・確定・振込ファイルの承認の期限）を `pay_periods` から作り、受信箱と勤怠の締めの期限に出す。
- 振込の締め切り（銀行ごと）は [payments-and-accounting.md](payments-and-accounting.md) の 3.5 節。既定は支給日の 3 営業日前に `released`。

## 5. 入力のスナップショット（[ADR-0026](../decisions/0026-payroll-run-stages-and-input-snapshot.md)）

### 5.1 固定の手順

1. `known_at` ＝ 固定の開始の時刻 − 10 秒。読み始める前に 10 秒待つ（[ADR-0008](../decisions/0008-point-in-time-queries-and-activation-timers.md)）。
2. 対象の雇用を、期間のどこかで給与のグループに属し、`employee` の雇用であるもの（`contingent` は除く。[ADR-0010](../decisions/0010-person-employment-job-assignment-model.md)）として選ぶ。
3. 1 人ずつ、期間の各日の有効日付のデータを `known_at` の知識で読み、値の変わる区切りごとの区間の列にする。
4. 勤怠の集計の版（[time-and-attendance.md](time-and-attendance.md) の 7.3 節）、休暇の取得、個別の調整の入力、住民税の月割額、前の実行の結果から要る値（賞与の税率の表を引く前月の給与、健康保険の標準賞与額の年度の累計など）を加える。
5. 規則表の版の ID の一覧と、テナントの計算の設定の版を加える。
6. 正規の形にしてハッシュを取り、保存する。

### 5.2 文書の形

```jsonc
{
  "schema": "payroll-input/1",
  "tenant_id": "…", "run_id": "…", "employment_id": "…",
  "run_type": "regular",
  "period": { "start": "2026-09-21", "end": "2026-10-20", "pay_date": "2026-10-23", "premium_month": "2026-09" },
  "known_at": "2026-10-21T01:00:00.000Z",
  "facts": {
    "employment": [ { "valid": ["2026-09-21", "2026-10-21"], "status": "active", "company_id": "…", "location_id": "…", "employment_class": "regular", "scheduled_minutes_per_day": 480 } ],
    "compensation": [ { "valid": ["2026-09-21", "2026-10-21"], "pay_basis": "monthly", "base": 300000, "allowances": [ { "code": "family", "amount": 10000 } ] } ],
    "tax": [ { "valid": ["2026-09-21", "2026-10-21"], "column": "ko", "dependents_count": 2, "method": "table" } ],
    "social_insurance": [ { "valid": ["…"], "insurer_id": "…", "health_grade": 22, "pension_grade": 19, "kaigo_2go": false } ],
    "employment_insurance": [ { "valid": ["…"], "insured": true, "business_type": "general" } ],
    "resident_tax": { "municipality_code": "…", "monthly_amount": 12300, "notice_version": "…" }
  },
  "time": { "summary_id": "…", "version": 1, "hash": "…", "minutes": { "statutory_ot": 1230, "night": 60 }, "days": { "scheduled_days": 21, "worked_days": 20 } },
  "absence": [ { "date": "2026-10-02", "type": "annual", "unit": "day" } ],
  "adjustments": [ { "item": "adhoc_allowance", "amount": 5000, "case_id": "…" } ],
  "history": { "prev_month_regular_after_si": 262500, "health_std_bonus_fy_total": 0 },
  "rule_versions": { "wht_monthly": "…", "si_rates": "…", "si_grades": "…", "ei_rates": "…" },
  "config_version": "…"
}
```

- 金額は整数の円（JSON の数。`Number.MAX_SAFE_INTEGER` 以内）、率は 10 進の文字列、日付は `YYYY-MM-DD`、時刻は UTC の ISO 8601（ミリ秒まで）。
- 正規の形は RFC 8785（JSON Canonicalization Scheme）。ハッシュは SHA-256。
- **入れないもの**：マイナンバー（保管庫の外に出さない。[ADR-0005](../decisions/0005-security-and-my-number.md)）、口座番号（振込は [payments-and-accounting.md](payments-and-accounting.md) が別に読む）、住所、氏名。明細と賃金台帳は結果と人事のデータを結んで作る。
- 保存：S3 の `payroll-inputs/{tenant}/{sha256}.json`（SSE-KMS、テナントの鍵）と、`payroll_inputs (run_id, employment_id, input_hash, known_at, s3_key)`。同じハッシュは 1 回だけ置く。

### 5.3 再現性

- 結果の行は、入力のハッシュ、規則表の版の一覧のハッシュ、エンジンのイメージのダイジェスト、設定の版を持つ（[ADR-0004](../decisions/0004-payroll-engine.md)）。
- 同じ 4 つで計算し直すと、1 円も違わない。夜間に、確定した結果の 1% を記録したエンジンのイメージで計算し直して比べる。不一致は SEV1。
- エンジンのイメージは、結果の保存の期間の間 ECR に残す（ライフサイクルの規則で消さない。保存の期間は [intent.md](../intent.md) の L5）。

## 6. 項目と計算のグラフ（[ADR-0027](../decisions/0027-pay-item-graph-and-formula-language.md)）

### 6.1 項目

```sql
pay_items (tenant_id /* null = system */, code, version, name,
           phase smallint,            -- 1 earnings, 2 absence_deduction, 3 gross, 4 social_insurance,
                                      -- 5 employment_insurance, 6 income_tax, 7 resident_tax,
                                      -- 8 other_deduction, 9 net, 0 intermediate
           kind text,                 -- earning | deduction | intermediate | employer_cost | info
           owner text,                -- system | tenant
           formula jsonb,             -- expression tree (tenant) or builtin id (system)
           flags text[],              -- taxable, si_remuneration, ei_wage, overtime_base, fixed_wage,
                                      -- non_taxable_commute, requires_art24_agreement, retro_eligible
           rounding text,             -- named rounding for the item result
           payslip_section text, gl_mapping_key text,
           valid daterange)
pay_item_sets (tenant_id, pay_group_id, version, item_refs jsonb, activated_at, activated_by)
```

- 法定の項目（源泉所得税、社会保険料、雇用保険料、住民税、割増賃金の最低、非課税の通勤手当の上限の判定）は `owner = system`。テナントは式を変えられない。システムの行は `tenant_id` が空で、全テナントが読むだけの RLS の部分の例外にし、コードに `jp.` の接頭辞を付ける（[data-model.md](data-model.md) の 3.3.1 節）。割増の率は法定より高くだけできる（[payroll-jp-rules.md](payroll-jp-rules.md) の 7 節）。
- フラグは、どの法定の計算の基礎に入るかを決める。例：通勤手当は `si_remuneration`・`ei_wage` を持ち、`taxable` は持たない（非課税の上限を超える分はシステムの項目が課税に移す）。フラグの誤りは税と保険の誤りになるので、項目の版の有効化に給与の担当の承認を要する（`pay_item_change` の業務プロセス）。
- 法定外の控除（組合費、社宅の費用など）は `requires_art24_agreement` を持ち、労使協定の記録（24 条 1 項ただし書）がテナントになければ有効化を拒む。

### 6.2 評価の順序

1. 項目を段の順に並べ、同じ段の中は依存のグラフの位相の順（同じ順位は `code` の辞書順）で評価する。
2. 依存は、前の段の項目と同じ段の項目だけを参照できる。後の段の参照は保存のときに拒む（例：支給の式が源泉所得税を参照する）。
3. 循環は保存のときに拒む（`CYCLE`、循環の経路を示す）。
4. 評価の中で例外（0 での割り算、表の引き当てなし）が出たら、その人の結果を `error` にし、項目と理由を確認の画面に出す。0 や前回の値で黙って埋めない。

### 6.3 テナントの式

式は JSON の式の木。業務プロセスの条件の式（[ADR-0013](../decisions/0013-bp-definition-format-and-versions.md)）と同じ評価器の核に、お金の型を足したもの。

| 型 | 意味 |
| --- | --- |
| `Yen` | 整数の円（`bigint`） |
| `Dec` | 10 進の固定小数点。小数 10 桁 |
| `Minutes` | 分の整数 |
| `Int`・`Bool`・`Date`・`Code` | 整数、真偽、日付、コード |

| 節 | 型の規則 |
| --- | --- |
| `const`、`ref`（項目、事実、勤怠の区分、休暇の日数） | 参照先の型 |
| `add`・`sub` | 同じ型どうし（`Yen + Yen → Yen`、`Dec + Dec → Dec`）。`Yen + Dec` は拒む |
| `mul` | `Yen × Dec → Dec`、`Dec × Dec → Dec`、`Int × Yen → Yen` |
| `per_hour(amount: Yen, minutes: Minutes) → Dec` | 時間単価。`minutes = 0` は評価の例外 |
| `prorate(amount: Yen, num: Int, den: Int) → Dec` | 按分（日割りなど）。`den = 0` は評価の例外 |
| `hours(Minutes) → Dec` | 分を時間に |
| `round(rule, Dec) → Yen` | 名前付きの丸めだけ（`round_down_yen`、`round_half_up_yen`、`round_up_yen`、`round_si_employee_share`） |
| `min`・`max`・`if`・比較・論理 | 同じ型 |
| `lookup(table, key) → 値` | テナントの表（例：等級ごとの手当）。行は 1,000 まで |
| `days_in(period, kind)` | 期間の暦日・所定労働日・出勤日の数 |

- 項目の結果の型は `Yen` でなければならない（`intermediate` は `Dec` を許す）。`Dec` から `Yen` へは `round` だけ。
- 汎用の割り算（`div`）は持たない。按分と時間単価の 2 つで足りる（ADR-0001 の「割り算は商と余りを明示する」の考え方）。
- 上限：深さ 10、節 200（業務プロセスの式と同じ）。ループと再帰はない。評価は必ず止まる。
- `Dec` の中間の値は小数 10 桁で、掛け算の後の桁の切り詰めは 0 の向きに切り捨てる（向きを固定する）。法令の丸めは項目の結果の `round` だけで行う。[ADR-0001](../decisions/0001-platform-and-stack.md) の最初の想定（1 円の 1 万分の 1）より細かくし、ADR-0001 もこの桁に直した。
- マイナンバー・口座番号・住所の事実は参照できない。

例（等級の手当 × 出勤日の日割り）：

```jsonc
{ "round": "round_down_yen",
  "arg": { "prorate": { "amount": { "lookup": { "table": "grade_allowance", "key": { "ref": "facts.compensation.grade" } } },
                        "num": { "days_in": ["period", "worked_days"] },
                        "den": { "days_in": ["period", "scheduled_days"] } } } }
```

### 6.4 結果

```sql
payroll_results (tenant_id, id, pay_date date /* partition key */, run_id, employment_id, status text,  -- ok | error | excluded
                 input_hash bytea, rule_versions_hash bytea, engine_digest text, config_version_id,
                 gross bigint, total_deductions bigint, net bigint, computed_at,
                 superseded_by uuid,  -- only within a run before finalize (recompute_one)
                 UNIQUE (tenant_id, run_id, employment_id, pay_date) WHERE superseded_by IS NULL)
payroll_result_lines (tenant_id, result_id, pay_date, seq, item_code, item_version, amount bigint,
                      quantity numeric, rate text, basis jsonb,
                      retro_period date, retro_of_result_id uuid)
```

- `finalized` の後、結果と行はアプリのロールから書き換えられない（トリガーで拒む）。
- 差引の支給額 ＝ 支給の合計 − 控除の合計（PROP-PAY-002）。

## 7. 遡及（[ADR-0028](../decisions/0028-retro-deltas-and-bonus-runs.md)）

### 7.1 候補

| 元 | 事象 |
| --- | --- |
| 有効日付の過去日付の変更・訂正・取消 | `temporal.retro_detected`（[object-model-and-effective-dating.md](object-model-and-effective-dating.md) の 6.4 節） |
| 勤怠の締めた後の訂正 | `time.summary_superseded` |
| 休暇の過去の取得・取消 | `absence.retro_changed` |
| 規則表の訂正（同じ適用の期間の新しい版） | `rule_table.corrected`（[payroll-jp-rules.md](payroll-jp-rules.md) の 2 節） |
| 個別の調整の過去の期間への入力 | `payroll.adjustment_retro` |

- 候補（`retro_candidates`：雇用、期間、元、検知の時刻）を、確定した期間（`finalized` か `released`）と突き合わせて作る。まだ確定していない期間は、その期間の実行がふつうに拾う。
- 給与の担当は、候補を理由つきで除外できる（例：手で精算済み）。除外は監査の報告に出す。

### 7.2 計算

次の実行の入力の固定のとき、候補の各期間 P について：

1. **再現の確認**：P の元の入力の文書と元の規則表の版を、いまのエンジンで計算し、元の結果と比べる。違えば `ENGINE_DRIFT` で実行を止める（エンジンの変更による差を、データの遡及として払わない）。
2. **計算し直し**：P の入力を、今回の `known_at` で作り直し、P の期間に有効な最新の規則表の版で計算する。
3. **差**：項目ごとに、新しい値 −（元の結果 ＋ P に対する前の差額の合計）。
4. **当期の行**：差が 0 でない項目を、当期の結果に `retro_period = P` の行として足す。税・保険の扱いは項目の種類ごとの決定表（DT-PAY-003）で決める。

DT-PAY-003（遡及の差の扱い。上から評価。法令の扱いは [payroll-jp-rules.md](payroll-jp-rules.md) の DT-JP-006 が決める）：

| # | 差の項目 | 当期での扱い |
| --- | --- | --- |
| 1 | 支給（`taxable`・`si_remuneration`・`ei_wage` を持つ） | 当期の支給に足す。当期の源泉所得税・雇用保険料の基礎に入る。社会保険の随時改定の候補の検知に「遡及の支払い」として渡す |
| 2 | 社会保険料（P の標準報酬月額が変わった場合だけ差が出る） | 当期の控除に足す（差が負なら返す） |
| 3 | 源泉所得税 | 差を出さない。遡及の支給を当期の支払いとして当期で計算する（#1） |
| 4 | 雇用保険料 | 差を出さない（#1 で当期の賃金として計算する） |
| 5 | 住民税 | 差を出さない（通知の月割額による） |
| 6 | テナントの控除 | 項目の `retro_eligible` があれば差を出す。なければ出さない |

- 窓：確定した期間のうち、当期の期間の始まりから 24 か月前まで。超える候補は、`payroll.retro_override` の権限で 36 か月（賃金の請求権の時効。労基法 115 条と 143 条の当分の間 3 年）まで広げられる。それより前は手の調整にする。
- 差で差引の支給額が負になれば、振込は 0 円にし、不足を「回収の候補」として給与の担当に示す。次の給与から差し引くには、テナントに 24 条の労使協定の記録と、本人への通知が要る（L28）。システムは自動で差し引かない。

## 8. 賞与と臨時の実行（[ADR-0028](../decisions/0028-retro-deltas-and-bonus-runs.md)）

- `bonus` の実行は、支給額の入力（一括の取り込みか `bonus_entry` の業務プロセス）と、社会保険・税の計算だけを持つ。勤怠は読まない。
- 賞与の源泉所得税は前月の普通給与（社会保険料等の控除後）で率を引く（[payroll-jp-rules.md](payroll-jp-rules.md) の 3.4 節）。そのため、賞与の支給日の前月の `regular` の実行が `finalized` でなければ、賞与の入力の固定を拒む。前月に普通給与の支払いがない人は、支払いがないことを事実として入力に入れる。
- 健康保険の標準賞与額の年度（4 月〜翌 3 月）の累計と、厚生年金の同じ月の賞与の合算は、同じ年度・同じ月の確定した賞与の実行の結果から作る。同じ月に 2 回目の賞与の実行を固定するときは、1 回目が `finalized` であることを要する。
- `off_cycle` の実行は、退職の精算、振込の不能の後の再支払い、手の訂正に使う。対象者を指定し、入力の固定と計算は `regular` と同じ。社会保険料の月の控除の重複を防ぐため、同じ月の `regular` で控除した保険料の月を入力に入れる。

## 9. 計算の分割（[ADR-0029](../decisions/0029-parallel-run-and-compute-partitioning.md)）

```
freeze ─▶ inputs (S3, per employee) ─▶ chunk manifest (employment_id order, 250 each)
      ─▶ SQS (chunk ids) ─▶ Payroll Compute (ECS tasks × worker threads)
      ─▶ payroll-results/{tenant}/{run}/{chunk}.jsonl + sha256 (S3) ─▶ Loader (Worker): 1 tx per chunk ─▶ payroll_results
```

- 束は、雇用の ID の順に 250 人ずつ（既定。E12 の負荷試験で決める）。束の中身は `payroll_chunks (run_id, chunk_no, employment_ids, manifest_hash)` に記録し、再試行でも変えない。
- タスクは S3 から入力を読み、規則表の版をメモリーに持ち、結果の束のファイルを書く。DB は読まない（[ADR-0004](../decisions/0004-payroll-engine.md)）。
- 取り込み（Loader）は、束のファイルのハッシュを確かめ、1 束を 1 トランザクションで入れる。`(run_id, employment_id)` の一意で、再試行の二重の取り込みは何もしない。
- 1 人の計算の例外は、その人を `error` にするだけで、束は成功にする。タスクの異常終了は束ごとに 3 回まで再試行し、それでも失敗すれば束を `failed` にして担当に出す。
- 同時に動くタスクは、テナントごとに上限（既定 20）と全体の上限を持つ。支給日の近い実行を先にする。
- 目安：1 人 5〜20ms（項目 50〜200）。1 万人 ＝ 40 束。20 タスク × 4 スレッドで数分。NFR-003（1 万人 15 分、3 万人 45 分、1 人 5 秒）は、入力の固定（DB の読み取り）が主な時間になる見込み。固定も雇用の束ごとに並列にする。

## 10. 並行稼働（[ADR-0029](../decisions/0029-parallel-run-and-compute-partitioning.md)）

- 現行のシステムの結果（従業員 × 項目 × 月の額）を一括の取り込みで入れる（`legacy_payroll_results`）。項目の対応表（`legacy_item_map`：現行のコード → 本システムの項目、または「比べない」）をテナントごとに持つ。
- 本システムの結果（`finalized` にしない比較の実行、`run_type = parallel`）と比べ、従業員 × 項目 × 月の差を `parallel_diffs` に書く。許容の幅は持たない（1 円の差も差）。
- 差の分類：`our_bug`（本システムの誤り）、`legacy_bug`（現行の誤り）、`config_diff`（設定の差）、`rounding_rule_diff`（端数の規則の差）、`input_diff`（入力の差）、`timing_diff`（適用の月の差）。
- 説明は給与の担当が付け、QA が承認する。`our_bug` は説明済みにならない。直して計算し直し、差が消えて初めて閉じる。
- 切り替えの条件（NFR-001、K2）：3 か月続けて（賞与の月を 1 回以上含む）、説明のない差が 0 件。条件の判定は `parallel_run_gates` に月ごとに記録する。
- 比較は本番の環境の中だけで行う。報告の外への出力は、従業員をテナントの鍵の HMAC の仮の ID にし、氏名・社員番号・額を出さない（差の件数と分類と項目だけ）。取り込みの契約の扱いは法務の確認待ち（[intent.md](../intent.md) の L11）。

## 11. 確認の検査

DT-PAY-004（`in_review` で全員に行う。当たる行をすべて出す）：

| # | 条件 | 重さ |
| --- | --- | --- |
| 1 | 結果が `error` | 止める（確定できない。除外は理由つき） |
| 2 | 差引の支給額が負 | 止める |
| 3 | 差引の支給額が 0 で、在籍の日がある | 警告 |
| 4 | 前回の同じ種類の実行から、差引の支給額が ±30% 以上変わった（テナントの設定） | 警告 |
| 5 | 社会保険の被保険者なのに保険料が 0（免除の印がない） | 警告 |
| 6 | 勤怠の集計が未確定（`hr_locked` でない）のまま除外されていない | 止める |
| 7 | 遡及の候補が窓の外 | 警告 |
| 8 | 随時改定の候補がある | 情報（[payroll-jp-rules.md](payroll-jp-rules.md) の 4.6 節） |
| 9 | 並行稼働の差がある（並行稼働の期間） | 情報 |
| 10 | 振込先の口座（`worker_payment_election`）を変える案件が、支給日の 10 営業日前より後に完了した（[security.md](security.md) の THR-020） | 警告。確認の画面に、変更の日、承認者、本人への変更の通知の送信の結果を出す。給与の担当は本人に確かめたうえで進めるか、その人を振込から外して `off_cycle` で払う |

## 12. 規模

- S1：月末〜25 日の前の 5 日に 70 万人。1 日の平均 14 万人、再計算を含めて 2 倍。束 250 人で 1 日 1,100 束ほど。
- 入力の文書：1 人数 KB〜数十 KB。月に数十 GB（[ADR-0004](../decisions/0004-payroll-engine.md) の見積もり）。同じハッシュは 1 回だけ置くので、再計算で増えにくい。
- 結果の行：1 人 50〜200 行。S1 で月に 1〜2 億行。`payroll_result_lines` は実行の月ごとのパーティション。

## 13. 障害のときの振る舞い

| 障害 | 振る舞い |
| --- | --- |
| 入力の固定の途中で失敗 | 実行を `draft` に戻し、固定し直す。書きかけの `payroll_inputs` は `run_id` ごとに捨てる（S3 の文書は内容のアドレスなので残してよい） |
| Payroll Compute のタスクの異常終了 | 束ごとの再試行（9 節）。同じ束を 2 回計算しても、結果は同じで、取り込みは 1 回 |
| Loader の途中で失敗 | 束のトランザクションが戻る。再実行で同じ束を入れ直す |
| 再現の不一致（夜間の抜き取り、遡及の `ENGINE_DRIFT`） | SEV1。新しい確定を止め、原因（エンジンの非決定性、規則表の版の誤り）を調べる。runbooks の手順 |
| 支給日の前にリージョンが落ちる | 大阪の DR で、確定済みの実行の振込ファイルを作れる（NFR-006）。入力の文書と結果は S3 のリージョン間の複製で持つ |
| 確定の後に誤りが見つかる（支払の前） | `payroll_cancel` で取り消し、作り直す。支払の後なら次の実行の差額か `off_cycle` |

## 14. セキュリティとプライバシー

- ドメイン：`payroll.input`（個別の調整）、`payroll.results`、`payroll.run`（実行の操作）（[security-model.md](security-model.md) の 3 節）。給与の担当のロールは組織か給与のグループで範囲を絞る。
- 入力の文書と結果には氏名・住所・口座・マイナンバーを入れない（5.2 節）。それでも額は機微なので、S3 はテナントの KMS の鍵で暗号化し、読むのは Payroll Compute のロールと監査の権限だけにする。
- Payroll Compute のタスクは、入力の S3 と結果の S3 のプレフィックスにだけ権限を持つ。DB の資格情報を持たない。
- ログ・トレースに額と従業員の ID を出さない。束の番号、件数、時間だけ。
- テナントの式は、参照できる事実を許可リストで限る（6.3 節）。
- テストとゴールデンデータセットは合成の人だけ（[AGENTS.md](../../AGENTS.md)）。

## 15. テスト

### 15.1 ゴールデンデータセット

- 置き場所：開発リポジトリの `golden/payroll/<case_id>/`。`input.json`（5.2 節の形）、`rules.lock`（規則表の版）、`expected.json`（項目ごとの額）、`provenance.md`（確かめた人・方法・日付）。
- 例の軸（[ADR-0004](../decisions/0004-payroll-engine.md) を具体にしたもの）：甲欄の扶養 0〜7 人と 8 人以上、乙欄、月額表と電算機特例、賞与（前月の給与なし、前月の 10 倍超）、年齢の境界（40・65・70・75 歳の誕生日の前日の月）、協会けんぽの都道府県と健康保険組合、等級の境界（上限・下限）、子ども・子育て支援金の始まりの月（令和 8 年 4 月分）、雇用保険の料率の改定の締日の前後、月の途中の入社・退職（末日の退職で 2 か月の控除）、休職（産休・育休の免除）、欠勤・遅刻、月 60 時間の前後、深夜と休日の重なり、遡及の昇給、住民税の 6 月と退職の一括徴収、通勤手当の非課税の上限。
- 全件一致を CI の必須のチェックにする。期待値の変更は QA の承認と、法令の解釈に関わるものは社労士・税理士の確認の記録を要する（[AGENTS.md](../../AGENTS.md)）。

### 15.2 決定表

| ID | 内容 |
| --- | --- |
| DT-PAY-001 | 実行の状態の遷移（4.1 節） |
| DT-PAY-002 | 式の型の検査（6.3 節の型の規則。受ける・拒む） |
| DT-PAY-003 | 遡及の差の扱い（7.2 節） |
| DT-PAY-004 | 確認の検査（11 節） |

### 15.3 性質ベーステスト

| ID | 性質 |
| --- | --- |
| PROP-PAY-001 | 任意の入力で、同じ入力・規則表・エンジン・設定の計算を 2 回すると、全行が一致する（束の分け方・タスクの数・再試行によらない） |
| PROP-PAY-002 | 任意の入力で、差引の支給額 ＝ 支給の合計 − 控除の合計 |
| PROP-PAY-003 | 任意の入力の文書で、キーの順序と空白を変えても正規の形とハッシュは同じ。値を 1 つ変えればハッシュが変わる |
| PROP-PAY-004 | 任意の遡及の列で、DT-PAY-003 の #1・#2・#6 の項目について、「元の結果 ＋ 差額の合計」が「最新の知識で計算し直した結果」に一致する |
| PROP-PAY-005 | 型の検査を通った任意の式の木は、任意の入力で停止し、`Yen` の項目は整数の円を返すか評価の例外を返す（黙って 0 にならない） |
| PROP-PAY-006 | 任意の項目の定義の集合で、保存を受けたものは循環がなく、後の段を参照しない |
| PROP-PAY-007 | 任意の束の分け方で、取り込んだ結果の集合は同じ（重複も欠けもない） |

### 15.4 再現と負荷

- 再現：CI で、ゴールデンデータセットを 2 つの異なる束の大きさとスレッド数で計算して一致を確かめる。
- 負荷（E12）：合成の 3 万人・10 万人で NFR-003 を測る。

## 16. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E8 | `pay-groups-and-periods` | 3 節。給与のグループ、期間、支給日、営業日の暦（`business_calendars`） |
| E8 | `payroll-run-state-machine` | 4 節（DT-PAY-001）。`payroll_finalize`・`payroll_cancel` の業務プロセス |
| E8 | `payroll-input-freeze` | 5 節（PROP-PAY-003）。正規の形とハッシュ、S3 と DB |
| E8 | `pay-item-graph` | 6.1・6.2 節（PROP-PAY-006） |
| E8 | `tenant-formula-language` | 6.3 節（DT-PAY-002、PROP-PAY-005） |
| E8 | `payroll-results-store` | 6.4 節（PROP-PAY-002）。確定の後の書き換えの拒否 |
| E8 | `payroll-compute-chunks` | 9 節（PROP-PAY-001・007） |
| E8 | `payroll-review-checks` | 11 節（DT-PAY-004）。1 人の再計算 |
| E8 | `golden-dataset-harness` | 15.1 節。CI の必須のチェック |
| E8 | `reproducibility-sampler` | 5.3 節。夜間の抜き取りの再計算 |
| E9 | `retro-detection-and-delta` | 7 節（DT-PAY-003、PROP-PAY-004） |
| E9 | `bonus-runs` | 8 節 |
| E9 | `off-cycle-runs` | 8 節 |
| E9 | `parallel-run-compare` | 10 節。取り込み、項目の対応、差の分類、説明と承認、切り替えの判定 |
| E12 | `load-test-suite` | 9 節。NFR-003（[capacity.md](capacity.md) の 7 節の負荷試験と 1 つにした） |

## 17. 未解決の問い

### 決定

- **営業日の暦はこの領域が持ち、業務プロセスの期限と共有する**。[business-process-engine.md](business-process-engine.md) の 17 節の持ち越しをこれで閉じる。
- **入力の正規の形は RFC 8785、ハッシュは SHA-256**（[ADR-0026](../decisions/0026-payroll-run-stages-and-input-snapshot.md)）。
- **入力の文書に氏名・住所・口座・マイナンバーを入れない**。
- **`Dec` は小数 10 桁、中間の桁の切り詰めは 0 の向き**。法令の丸めは項目の結果だけ（[ADR-0027](../decisions/0027-pay-item-graph-and-formula-language.md)）。
- **汎用の割り算は持たず、按分と時間単価だけ**。
- **遡及の窓は 24 か月、権限で 36 か月まで。元の入力の再現が崩れたら遡及を止める**（[ADR-0028](../decisions/0028-retro-deltas-and-bonus-runs.md)）。
- **遡及で差引が負になっても自動で差し引かない**。
- **賞与の入力の固定は、前月の月次の確定を前提にする**。
- **束は雇用の ID の順に 250 人。並行稼働に許容の幅を持たない**（[ADR-0029](../decisions/0029-parallel-run-and-compute-partitioning.md)）。

### 確認待ち（[intent.md](../intent.md) に載せたもの）

| # | 問い | 確認先 | 止める spec |
| --- | --- | --- | --- |
| L28 | 過払い（遡及で差引が負、誤った支払い）を次の給与から差し引く条件（24 条の協定、本人の同意、1 回に差し引ける額） | 社労士 | E9 の `retro-detection-and-delta` |
| L29 | 遡及の支給を当期の支払いとして源泉徴収する扱い（支給日の属する年の税額表、年をまたぐ遡及） | 税理士 | 同上 |

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| 束の大きさ、タスクの数、入力の固定の並列の度合い | E12 の負荷試験 |
| 国民の祝日と銀行の休業日の取り込みの元（形式と URL） | E8 の着手の前 |
| 半月・週の支払いの給与のグループ | 需要を見て MVP の後 |
| 退職金の計算 | MVP の後（intent） |

## 18. quality.md・runbooks・data-model への項目

### quality.md

- NFR-001：ゴールデンデータセットの一致（CI）と、並行稼働の説明のない差の件数（月ごと）。
- NFR-003：実行ごとの固定・計算・取り込みの時間。1 人の再計算の p99。
- 夜間の再現の抜き取りの不一致（目標 0。SEV1）。
- 確認の検査の警告の件数と、除外の件数。
- 遡及の候補の件数、除外の件数、窓の外の件数。
- 支給日の前の口座の変更の警告（DT-PAY-004 の #10）の件数と、その後に不正と分かった件数。

### runbooks

- `payroll-run-stuck.md`：実行が `computing` で止まったとき（束の失敗、Loader の遅れ）。
- `payroll-reproducibility-mismatch.md`：再現の不一致・`ENGINE_DRIFT` への対応。確定の停止と原因の調べ方。
- `payroll-cancel-and-rerun.md`：確定の後、支払の前の取り消しと作り直し。
- `payday-peak-capacity.md`：支給日の前の 5 日の容量の準備（タスクの上限、Aurora の reader）。
- `parallel-run-monthly-review.md`：並行稼働の月次の差の確認と承認の流れ。

### data-model（索引への追加の提案）

| 置き場所 | 中身 |
| --- | --- |
| Aurora `pay_groups`、`pay_periods`、facet `employment_pay_group`、`business_calendars` | 3 節 |
| Aurora `payroll_runs`、`payroll_inputs`、`payroll_chunks` | 4・5・9 節 |
| Aurora `pay_items`、`pay_item_sets`（版） | 6.1 節 |
| Aurora `payroll_results`、`payroll_result_lines` | 6.4 節。確定の後は書き換えない。月ごとのパーティション |
| Aurora `retro_candidates` | 7.1 節 |
| Aurora `legacy_payroll_results`、`legacy_item_map`、`parallel_diffs`、`parallel_run_gates` | 10 節 |
| S3 `payroll-inputs/{tenant}/{sha256}.json`、`payroll-results/{tenant}/{run}/{chunk}.jsonl` | 5.2・9 節。SSE-KMS（テナントの鍵）。大阪へ複製 |
| ECR のエンジンのイメージ | 5.3 節。保存の期間の間消さない |

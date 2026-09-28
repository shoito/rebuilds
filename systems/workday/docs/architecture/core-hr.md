# Core HR: Workday

従業員（人）、雇用、職務の割り当て、ポジションと職務、組織（監督組織、会社、コストセンター、事業所）と階層、入社・異動・休職・退職の事象、個人の情報、業務委託などの外部の人（contingent worker）、組織の再編を決める。

前提の決定は、データを有効時間と記録時間の 2 軸で持つこと（[ADR-0002](../decisions/0002-effective-dated-data-model.md)）、変更は業務プロセスを通すこと（[ADR-0003](../decisions/0003-business-process-engine.md)）、権限はドメインと組織で絞るロールで判定すること（[ADR-0005](../decisions/0005-security-and-my-number.md)）。有効日付の共通の仕組みは [object-model-and-effective-dating.md](object-model-and-effective-dating.md) にある。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0010](../decisions/0010-person-employment-job-assignment-model.md) | 人・雇用・職務の割り当ての 3 層で持つ。人員の枠はすべてポジションで表し、ジョブ管理の組織では入社のときにポジションを自動で作る。外部の人は雇用の種類 `contingent` で持ち、給与の対象にしない |
| [0011](../decisions/0011-effective-dated-org-hierarchy-closure.md) | 組織の階層は有効日付の親子の辺で持ち、日付の範囲つきの閉包テーブルを同じトランザクションで作り直す。循環と、所属の残る組織の廃止を拒む |
| [0012](../decisions/0012-worker-lifecycle-events-and-legal-checks.md) | 入社・異動・休職・退職は、雇用の状態の facet と職務の facet への差分として書く。退職日は最後の在籍日とし、有効期間の終わりは翌日にする。解雇の予告・解雇の制限などの法令の検査は、止めずに警告と理由の記録にする |

## 1. 目的と範囲

- 扱う：人と雇用と職務の割り当て、facet の分け方、組織の種類と階層、ポジションと職務の目録、人員の管理（ポジション）、組織のロールの割り当ての持ち方、入社・再雇用・異動・昇格・降格・休職・復職・退職の事象と日付の意味、個人の情報（氏名、住所、扶養、口座、緊急連絡先）、外部の人、組織の再編、労働者名簿の元のデータ。
- 扱わない：有効日付の共通の仕組み（[object-model-and-effective-dating.md](object-model-and-effective-dating.md)）、承認の流れ（[business-process-engine.md](business-process-engine.md)）、権限の判定（[security-model.md](security-model.md)）、年次有給休暇の付与と残日数・休暇の申請（[absence-and-leave.md](absence-and-leave.md)）、給与の計算と社会保険の資格（[payroll-engine.md](payroll-engine.md)・[payroll-jp-rules.md](payroll-jp-rules.md)）、マイナンバー（[my-number-vault.md](my-number-vault.md)）、一括の取り込みと移行（[integrations-and-bulk.md](integrations-and-bulk.md)）。
- **人事のデータは、この文書の事象の業務プロセスを通してだけ変わる**（[AGENTS.md](../../AGENTS.md)）。

## 2. 本家の形（確かめたこと）

どれも 2026-09-28 に確認した。本家の実装は使わない（[リポジトリ共通の ADR-0007](../../../../docs/decisions/0007-no-reuse-of-original-implementation.md)）。

| 本家の考え方 | 内容 | このシステムでの扱い |
| --- | --- | --- |
| 監督組織 | 上長と部下の組。人の所属と承認の起点になる（大学の案内 [Workday: Basic concepts](https://workdaytraining.geisinger.org/PDFContent/J036_WDBasicConceptsTerms.pdf)。二次資料） | `supervisory` の組織。上長のロールの割り当てを持つ |
| 人員の管理のモデル | 監督組織ごとに、ポジション管理（空いた承認済みのポジションがないと採用・異動できない。ポジションごとの制限）かジョブ管理（組織ごとの制限。数の上限なし）を選ぶ。同じ階層で混ぜられる（[Staffing Models](https://doc.workday.com/workday-education/en-us/course-manuals/hcm-core-for-administrators/staffing-models.html)） | ポジションに一本化し、ジョブ管理の組織はポジションを自動で作る（[ADR-0010](../decisions/0010-person-employment-job-assignment-model.md)） |
| 外部の人 | 本家の給与で払わないが、組織の必要を満たす人（大学の案内による。二次資料。未検証） | 雇用の種類 `contingent`（7 節） |
| 組織の種類 | 監督組織のほか、会社、コストセンター、地域など（[Security](https://doc.workday.com/workday-education/en-us/course-manuals/financial-management-for-administrators/security.html)。種類の全体の一覧は未検証） | 監督組織、会社、コストセンター、事業所の 4 つ（4 節） |
| ロールの割り当て | ロールはポジションや職務に割り当て、組織に絞れる（[Security Group Configuration and Constraints](https://doc.workday.com/workday-education/en-us/course-manuals/security-for-administrators/security-group-configuration-and-constraints.html)、検索の要約による） | ロールはポジションに割り当てる。人が異動するとロールはポジションに残る（4.5 節） |

- 本家の「兼務（additional job）」の細かい規則（給与の扱い、上長の決まり方）は確かめられなかった（未検証）。本システムの兼務は 3.2 節で決める。

## 3. 人・雇用・職務の割り当て（[ADR-0010](../decisions/0010-person-employment-job-assignment-model.md)）

### 3.1 3 つの層

```
worker（人）1 ─── n employment（雇用：会社ごと・期間ごと）1 ─── n job_assignment（職務の割り当て：主と兼務）
                                                                   └─ position（ポジション）
```

| 層 | 意味 | 変わらない属性（有効日付でない） | 有効日付の facet |
| --- | --- | --- | --- |
| 人（`workers`） | 同じ個人。再雇用でも同じ | `id`、`tenant_id`、作成の時刻 | `worker_personal`、`worker_address`、`worker_contact`、`worker_dependents`、`worker_emergency_contacts` |
| 雇用（`employments`） | 1 つの会社との 1 回の雇用の期間。退職と再雇用で別の雇用になる | `id`、`worker_id`、`company_id`、`kind`（`employee`・`contingent`）、`employee_number` | `employment_status`、`employment_primary_job`、`worker_compensation`、`worker_payment_election`、`employment_contract` |
| 職務の割り当て（`job_assignments`） | 雇用の中の 1 つの仕事。主たる職務と兼務 | `id`、`employment_id` | `worker_job` |

- **社員番号**（`employee_number`）はテナントの中で一意。同じ人の再雇用では同じ番号を使う（テナントの設定で新しい番号にもできる）。番号の形式はテナントが決める。
- 同じ人が、同じ会社で同時に 2 つの雇用を持つことは拒む（部分的な重なりも）。別の会社（グループ会社への出向の受け入れなど）との同時の雇用は受ける。出向の扱いは 14 節の持ち越し。
- 主たる職務は `employment_primary_job` の facet で、雇用ごとに毎日ちょうど 1 つ（contiguous）。給与の計算の既定の組織・事業所・コストセンターは、主たる職務から取る。

### 3.2 兼務

- 兼務は、同じ雇用の中の 2 つ目以降の職務の割り当て。自分のポジションと組織を持つ。
- 兼務の上長も承認の担当になりうる。ルーティングは、案件の対象の職務の割り当てから起点の組織を決める（[business-process-engine.md](business-process-engine.md) の 5 節）。人の全体に関わる案件（住所の変更、退職）は主たる職務から決める。
- 兼務の給与（兼務手当）は、`worker_compensation` の手当の項目として持つ。兼務ごとに別の基本給は持たない（MVP）。

### 3.3 facet の項目

| facet | 主な項目 | 隙間 | 主な業務プロセス |
| --- | --- | --- | --- |
| `worker_personal` | 氏名（漢字・カナ・ローマ字）、旧姓の併記の希望、生年月日、性別、国籍 | contiguous | `personal_change`（氏名）、`data_correction`（生年月日・性別は訂正だけ） |
| `worker_address` | 住所の種類（住民票、居所）、郵便番号、都道府県、市区町村、町域以下 | gapped（種類ごとに主体を分ける） | `address_change` |
| `worker_contact` | 電話、個人のメール | contiguous | `contact_change` |
| `worker_dependents` | 扶養の親族ごと：続柄、氏名、生年月日、同居、障害の区分の有無、税の扶養・社会保険の扶養の区分 | gapped（親族ごと） | `dependent_change` |
| `employment_status` | 在籍の区分（`active`・`on_leave`）、休職の種類、雇用区分（正社員、契約社員、パート・アルバイト、嘱託）、時間の区分（フルタイム・パートタイム）、所定労働時間 | gapped | `hire`、`leave_start`、`leave_return`、`terminate` |
| `employment_contract` | 有期の契約の開始・終了、更新の回数、就業の場所・業務の変更の範囲（5.1 節） | gapped | `hire`、`contract_renewal` |
| `worker_job` | ポジション、職務（`job_profile_id`）、監督組織、会社、コストセンター、事業所、等級、職位 | contiguous | `job_change`、`transfer`、`promotion`、`demotion` |
| `worker_compensation` | 基本給の種類（月給・日給・時給）と額、手当の一覧（コードと額）、等級の号俸 | contiguous | `compensation_change` |
| `worker_payment_election` | 振込先（最大 3 口座：銀行・支店のコード、種目、口座番号の暗号文 `account_number_ct`、重複の検知の `account_hmac`（テナントの HMAC の鍵。[security.md](security.md) の THR-022）、名義のカナ、配分の規則） | gapped | `payment_election_change` |
| `worker_emergency_contacts` | 緊急連絡先 | gapped | `contact_change` |

- 項目は「一緒に変わるもの」でまとめた（[ADR-0002](../decisions/0002-effective-dated-data-model.md) の Consequences）。住所と口座と扶養は、変わる時期も権限のドメインも違うので分けた。
- 税の区分（甲欄・乙欄）、社会保険の資格、住民税の月額は給与の領域の facet（[payroll-jp-rules.md](payroll-jp-rules.md)）。この領域は持たない。
- 要配慮個人情報（健康、障害の詳細、労災の内容）は、この facet に入れない。休職の種類は「業務上の傷病による休業」のような区分だけを持ち、診断の内容は持たない（[security-model.md](security-model.md) の 6 節、[intent.md](../intent.md) の L10）。障害者控除の区分の有無は税の計算に要るので、扶養と本人の区分として持つ（詳細の病名は持たない）。

### 3.4 上限

| 項目 | 上限 |
| --- | --- |
| 1 つの雇用の職務の割り当て（同時） | 5（主 1、兼務 4） |
| 振込先の口座 | 3 |
| 扶養の親族 | 20 |
| 手当の項目（1 人・同時） | 50 |
| 1 テナントの組織（全種類） | 20,000 |
| 組織の階層の深さ | 15 |

## 4. 組織（[ADR-0011](../decisions/0011-effective-dated-org-hierarchy-closure.md)）

### 4.1 種類

| 種類 | 意味 | 階層 | 主な使いみち |
| --- | --- | --- | --- |
| `supervisory` | 上長と部下の組（部・課・チーム） | あり（1 つの木） | 所属、承認のルーティング、権限の範囲 |
| `company` | 法人 | なし（テナントに複数） | 雇用の相手、給与の実行の単位、仕訳 |
| `cost_center` | 費用の集計の単位 | あり（任意） | 仕訳の配賦 |
| `location` | 事業所（働く場所）。社会保険・労働保険の適用事業所の番号を持てる | なし | 36 協定（事業場ごと）、社会保険の適用事業所、労働者名簿の事業場 |

- 監督組織の木は、テナントに 1 つ（根は 1 つ）。組織は `organization` の facet（名前、コード、種類、状態）と、階層の辺の facet（`org_parent`）で持つ。
- 事業所と適用事業所は同じでないことがある（本社で一括して適用を受けるなど）。事業所の facet に「社会保険の適用事業所」と「労働保険の適用事業所」への参照を別に持つ（[payroll-jp-rules.md](payroll-jp-rules.md) と合わせる）。

### 4.2 階層と閉包

```sql
-- Parent edge as an effective-dated facet (subject = child org).
org_parent (tenant_id, subject_id /* child */, valid daterange, version_id, parent_id,
            PRIMARY KEY (tenant_id, subject_id, valid WITHOUT OVERLAPS),
            FOREIGN KEY (tenant_id, parent_id, PERIOD valid)
              REFERENCES organization (tenant_id, subject_id, PERIOD valid))

-- Date-ranged closure, derived. Rebuilt in the same tx as org_parent changes.
org_closure (tenant_id, ancestor_id, descendant_id, depth smallint, valid daterange,
             PRIMARY KEY (tenant_id, ancestor_id, descendant_id, valid WITHOUT OVERLAPS))
CREATE INDEX ON org_closure USING gist (tenant_id, descendant_id, valid);
```

- 辺の変更（組織の移動）が入ったら、動いた組織の部分木について、影響の始まりの日から後の閉包を作り直す。同じトランザクションで行う。
- 閉包を持つ理由：権限の範囲（「組織 A とその下位」）とルーティング（上へたどる）は、すべての読み取りに入る。再帰の問い合わせを毎回走らせない。
- **循環を拒む**：新しい辺 `child → parent` の期間のどこかで、`parent` が `child` の子孫なら拒む（`ORG_CYCLE`）。閉包を引いて判定する。
- 深さ 15 を超える辺を拒む。
- 閉包の作り直しの行数は、部分木の大きさ × 日付の区切りの数。部分木 2,000 組織を超える移動は、一括の業務プロセスで夜間に回す（9 節）。

### 4.3 ポジションと職務の目録

| 表 | 内容 | 有効日付 |
| --- | --- | --- |
| `job_families`・`job_profiles` | 職種と職務（名前、職務の等級の範囲、管理監督者に当たりうるかの印、既定の雇用区分） | `job_profile` の facet |
| `grades` ＋ `grade_detail` | 等級と号俸の表（テナントが定義）。`grades` は主体、中身は facet `grade_detail` | `grade_detail` の facet |
| `positions` ＋ `position_detail` | ポジション（所属の監督組織、職務、事業所、コストセンター、状態 `open`・`filled`・`frozen`・`closed`、自動で作ったかの印） | facet（gapped） |

- ポジションには同時に 1 人（MVP）。ジョブシェアは持たない。
- 空いたポジション（`open`）を作るには `position_create` の業務プロセスを通す。ジョブ管理の組織（`staffing_model = job`）では、入社・異動の完了のときに `position_create` を子の案件として自動で作り、承認を省く（[ADR-0010](../decisions/0010-person-employment-job-assignment-model.md)）。
- 「管理監督者に当たりうるか」は、労働時間の規制の対象の判定の入力の 1 つ（[time-and-attendance.md](time-and-attendance.md)）。当たるかの判断は企業と社労士が行う（[intent.md](../intent.md) の L6）。

### 4.4 組織の廃止と参照の順序

`PERIOD` の外部キーは `NO ACTION` だけなので（[object-model-and-effective-dating.md](object-model-and-effective-dating.md) の 4 節）、参照が残る組織を閉じられない。組織の廃止の業務プロセスは、次の順を守る。

1. 廃止の日から後に、その組織に所属する職務の割り当て、ポジション、子の組織、ロールの割り当てを列挙する。
2. 残っていれば、移し先を指定させる（一括の子の案件）。
3. 子の案件が全部完了した後に、組織の `end` の差分を書く。

### 4.5 組織のロールの割り当て

- ロール（`manager`、`hr_partner`、`payroll_admin`、`time_admin` など）は、組織とポジションの組に割り当てる（`org_role_assignment` の facet。主体は組織×ロール、値は割り当てたポジションの一覧）。
- 人がポジションを離れると、ロールはポジションに残る。後任が来れば、そのまま後任のロールになる。空いたポジションのロールは「担当なし」として扱い、ルーティングは予備の担当へ回す（[business-process-engine.md](business-process-engine.md) の 5.3 節）。
- 監督組織の `manager` は 1 つのポジション（兼務でもよい）。他のロールは複数可。
- ポジションを持たない外部の人に、ロールは割り当てない（MVP）。
- ロールの割り当ての変更は `role_assignment_change` の業務プロセスを通し、権限の変更として監査する（[security-model.md](security-model.md) の 4 節）。

## 5. ライフサイクルの事象（[ADR-0012](../decisions/0012-worker-lifecycle-events-and-legal-checks.md)）

### 5.1 日付の決まり

| 事象 | 業務の日付 | 有効期間での書き方 |
| --- | --- | --- |
| 入社 | 入社日（最初の在籍日） | `employment_status` を入社日から始める |
| 退職 | 退職日（最後の在籍日） | `employment_status` の `end` を退職日の翌日に書く。`[入社日, 退職日＋1)` |
| 異動・昇格など | 発令日 | `worker_job` の差分をその日に書く |
| 休職 | 休職の開始日 | `employment_status` の在籍の区分を `on_leave` にする |
| 復職 | 復職日（最初の出勤できる日） | `active` に戻す |
| 再雇用 | 新しい入社日 | 新しい雇用を作る |

- 社会保険の資格の喪失日は「退職日の翌日」になる。その計算は給与の領域が行う（[payroll-jp-rules.md](payroll-jp-rules.md)）。この領域は退職日だけを持つ。
- 入社日の訂正は、`employment_status` の最初の差分と、職務・給与などの最初の差分を同じ日に動かす（[object-model-and-effective-dating.md](object-model-and-effective-dating.md) の DT-TEMP-003 の #4）。

### 5.2 雇用の状態

```
               hire（入社日 > 今日なら「入社予定」として見える）
    (なし) ─────────────────────────▶ active ◀──── leave_return ──── on_leave
                                        │  └──── leave_start ────────▶  │
                                        │                               │
                                        └──── terminate ───▶ (なし) ◀───┘ terminate
                                                               │
                                                  rehire（新しい雇用）
```

事象の受け入れ（DT-HR-001）。「有効日の状態」は、事象の有効日の前日の、現在の知識での状態。

| # | 事象 | 有効日の状態 | その他の条件 | 結果 |
| --- | --- | --- | --- | --- |
| 1 | `hire` | 雇用なし（同じ会社で重なる雇用もなし） | ポジションが `open`（ジョブ管理の組織なら自動で作る） | 受ける |
| 2 | `hire` | 同じ会社の雇用と重なる | - | 拒む（`EMPLOYMENT_OVERLAP`） |
| 3 | `rehire` | 前の雇用が有効日より前に終わっている | 同じ人 | 受ける。新しい雇用 |
| 4 | `job_change`・`transfer`・`promotion`・`demotion` | `active`・`on_leave` | 移る先のポジションが `open` | 受ける |
| 5 | 同上 | 雇用なし | - | 拒む（`NOT_EMPLOYED`） |
| 6 | `leave_start` | `active` | - | 受ける |
| 7 | `leave_start` | `on_leave` | 種類が違う | 受ける（休職の種類の切り替え。例：産前産後休業から育児休業） |
| 8 | `leave_return` | `on_leave` | - | 受ける |
| 9 | `leave_return` | `active` | - | 拒む（`NOT_ON_LEAVE`） |
| 10 | `terminate` | `active`・`on_leave` | 退職日より後に、取り消されていない将来日付の差分がない | 受ける。5.4 節の警告を出す |
| 11 | `terminate` | 同上 | 退職日より後に将来日付の差分がある | 拒む（`FUTURE_CHANGES_EXIST`）。先に取り消すか、退職の案件で一緒に取り消す（子の案件） |
| 12 | 何でも | 有効日が今日＋3 年より後 | - | 拒む（[object-model-and-effective-dating.md](object-model-and-effective-dating.md) の 3.1 節） |

- `terminate` で雇用が閉じると、coverage の子（職務、給与、振込先、主たる職務）は同じトランザクションで退職日の翌日に切れる（DT-TEMP-002 の #6）。ポジションは `open` に戻る（ジョブ管理の自動のポジションは `closed`）。
- 休職の種類（`leave_of_absence_types`）：業務上の傷病による休業、私傷病による休職、産前産後休業、育児休業、介護休業、出向、その他（テナントが足せる）。種類ごとに、給与の扱い（無給・一部支給）、社会保険料の免除の対象になりうるか、解雇の制限の対象か、年休の出勤率で「出勤とみなすか」（[absence-and-leave.md](absence-and-leave.md) の 3.1 節）の印を持つ。印の意味の判定は給与の領域と社労士の確認で決める。

### 5.3 入社

入社の業務プロセスの既定の定義（テナントが変えられる）：

1. 起票（人事）：人（既存の人の検索で重複を確かめる）、雇用、職務、給与、雇用区分、契約の期間、就業の場所・業務の変更の範囲。
2. 承認（上長の上長 → 人事の担当）。
3. アクション：労働条件の通知の書面を確認し、交付を記録する（書面の作成は MVP では外で行い、写しを添付する）。
4. 子の案件（本人のセルフサービス）：住所、口座、扶養、緊急連絡先、マイナンバーの提出（[my-number-vault.md](my-number-vault.md)）。
5. サービス：SSO のアカウントの作成の予定（入社日に発効。[object-model-and-effective-dating.md](object-model-and-effective-dating.md) の 8 節）。
6. 完了：差分を書く。

- 労働条件の明示は、令和 6 年 4 月から、雇い入れ直後の就業の場所・業務に加えて、その変更の範囲の明示が要る（[厚生労働省：2024年4月から労働条件明示のルールが変わります](https://www.mhlw.go.jp/stf/newpage_32105.html)、2026-09-28 に確認）。本システムは、変更の範囲を `employment_contract` の項目として持ち、交付の記録を残す。書面の様式と、どの項目をシステムで作るかは、社労士の確認待ち（14 節の L14）。
- 入社の前の人（入社日が将来）は、見える範囲を絞る。本人のセルフサービスの子の案件だけを開き、組織図には入社日から出す。

### 5.4 退職と、法令に関わる警告

退職の業務プロセスは、退職の理由の区分（自己都合、会社都合、解雇、定年、契約期間の満了、死亡、転籍、その他）、退職日、最終出勤日、通知の日（解雇なら予告の日）を持つ。

法令の検査は止めずに警告にし、警告を見たうえで進める理由の入力を必須にする（[ADR-0012](../decisions/0012-worker-lifecycle-events-and-legal-checks.md)）。法令の要件は e-Gov の労働基準法の条文から確かめた（[労働基準法](https://laws.e-gov.go.jp/law/322AC0000000049)、2026-09-28 に確認）。当てはめの結論は出さない。

警告の表（DT-HR-002。当たる行をすべて出す）：

| # | 条件 | 警告 | 根拠（確認待ち） |
| --- | --- | --- | --- |
| 1 | 理由が解雇、かつ 予告の日から退職日までが 30 日未満 | 「解雇の予告が 30 日に足りない。不足の日数分の平均賃金（解雇予告手当）の支払いの要否を確かめる」。不足の日数を示す | 20 条（30 日前の予告、または 30 日分以上の平均賃金。予告の日数は平均賃金を払った日数だけ短縮できる） |
| 2 | 理由が解雇、かつ 退職日の時点で、解雇の制限の印を持つ休職の中、またはその終わりから 30 日以内 | 「解雇の制限の期間にかかる可能性がある」 | 19 条（業務上の傷病の療養の休業の期間とその後 30 日、産前産後の休業の期間とその後 30 日） |
| 3 | 理由が解雇、かつ 雇用区分・契約の期間が 21 条の各号に当たりうる（日雇い、2 か月以内の期間、季節的業務で 4 か月以内、試用の期間） | 「解雇の予告の規定の適用の除外に当たるか、継続の期間で確かめる」 | 21 条 |
| 4 | 理由が解雇で、除外の認定（天災事変など、労働者の責に帰すべき事由）を理由にする | 「労働基準監督署長の認定の有無を記録する」。認定の記録（日付、添付）を求める | 20 条 1 項ただし書、3 項 |
| 5 | 退職日が今日より前（遡って入力） | 「退職日より後の給与の支払い・勤怠の記録を確かめる」。確定した給与の期間にかかれば遡及の候補 | — |
| 6 | 有期の契約の満了で、更新の回数・通算の期間が多い | 「雇止めの予告・無期転換の申込みの権利の確認」 | 労働契約法と告示（詳細は未検証。L13） |

- 退職の後の手続きの子の案件（既定）：退職の証明書の請求があれば交付を記録するアクション（22 条。請求があれば遅滞なく交付）、最後の給与の支払いの確認（23 条。請求があれば 7 日以内に賃金を支払う）、貸与品の回収、SSO のアカウントの無効化の予定。
- 解雇予告手当の額の計算（平均賃金）は給与の領域（[payroll-jp-rules.md](payroll-jp-rules.md)）。この領域は不足の日数だけを示す。
- 解雇の有効性（労働契約法 16 条の客観的に合理的な理由・社会通念上の相当性）は、システムは判定しない（[intent.md](../intent.md) の Non-goals の「労務の判断の代行」）。

### 5.5 異動・昇格・降格

- 1 つの案件で、`worker_job`（ポジション、組織、等級）と `worker_compensation`（等級に伴う給与）を同じ有効日に変えられる。給与の変更は `depends_on: job_change` を宣言し、昇格の取消の前に取り消させる（DT-TEMP-004 の #6）。
- 異動の起票は、送り出す側の上長か人事。承認は、送り出す側と受け入れる側の両方の上長（並列の承認）→ 人事。
- 事業所が変わる異動は、36 協定の事業場、社会保険の適用事業所、住民税の特別徴収の変更の候補に影響する。outbox の `temporal.changed` を各領域が購読する。

## 6. 個人の情報の変更

| 変更 | 起票 | 既定の承認 | 備考 |
| --- | --- | --- | --- |
| 住所 | 本人 | 人事の担当（確認） | 通勤の経路と手当の見直しの子の案件を作る（[time-and-attendance.md](time-and-attendance.md) と給与の手当） |
| 氏名（婚姻など） | 本人 | 人事の担当 | 旧姓の併記の希望。社会保険・マイナンバーの届出の候補 |
| 振込先の口座 | 本人 | 給与の担当（本人以外の承認） | 口座の変更と振込ファイルの承認の職務分掌（[security-model.md](security-model.md) の 5 節）。本人の申請だけで受けてよいかは L4 |
| 扶養 | 本人 | 人事の担当 | 税・社会保険の扶養の判定は給与の領域 |
| 緊急連絡先・連絡先 | 本人 | 承認なし（通知だけ） | テナントの定義で承認を足せる |

- 本人の申請は本人の起票として扱い、承認は別の人が行う（[ADR-0005](../decisions/0005-security-and-my-number.md)）。
- 振込先の変更は、支払の締め切りに近いと、次の給与に間に合わない。締め切りは給与の実行の予定から示す（[payments-and-accounting.md](payments-and-accounting.md)）。

## 7. 外部の人（contingent worker）

- 雇用の種類 `contingent` の雇用で持つ。派遣の労働者、業務委託の人、受け入れの出向者などを想定する。
- 給与の計算の対象にしない（Payroll の入力のスナップショットに入れない）。
- 契約の終了日を必須にする。終了日の 30 日前に、上長と人事に通知する（発効のタイマー）。終了日を過ぎたら、雇用を自動で閉じる子の案件を作る（承認なしの `contract_end`）。
- 持てる facet は `worker_personal`（氏名だけ）、`worker_contact`、`worker_job`（組織・職務・事業所）、`employment_status`、`employment_contract`（提供元の会社、契約の番号）。住所・扶養・口座・給与は持たない。マイナンバーは集めない。
- 権限：本人のセルフサービスは、自分の情報の閲覧と、打刻（テナントが有効にしたとき）だけ。
- 労働者名簿・賃金台帳の対象にしない。派遣の労働者の派遣先管理台帳などの法定の帳簿を本システムで持つかは、社労士の確認待ち（L15）。

## 8. 組織の再編

- 組織の新設・統合・廃止・移動と、多数の人の所属の変更を、1 つの親の案件（`reorganization`）で起票する。有効日は 1 つ。
- 親の案件は、変更の一覧（組織の辺、ポジションの移動、職務の割り当ての移動、ロールの割り当て）を持ち、完了のときに子の案件を 200 件ずつの束で作る（[business-process-engine.md](business-process-engine.md) の 9 節）。子の案件は承認を省き、親の承認を引き継ぐ。
- 順序：組織の新設 → 辺の変更（閉包の作り直し）→ ポジションの移動 → 職務の割り当ての移動 → ロールの割り当て → 組織の廃止（4.4 節）。
- 途中で子の案件が失敗したら、親の案件を `partially_applied` で止め、失敗の一覧を人事に示す。成功した子の案件は取り消さない（それぞれ差分として正しい）。直した後に残りを再実行する。
- 再編の前に、「有効日の時点の組織図」の差分の予覧（前後の組織図と、影響を受ける人数・承認の担当の変化）を出す。

## 9. 規模

- S1 の最大のテナント 3 万人：組織 3,000、ポジション 3.5 万、閉包の行は 1 日の区切りあたり 3,000 × 平均の深さ 6 ≒ 1.8 万行。年に数回の再編で区切りが増えても 10 万行程度。
- 4 月 1 日付の定期の異動で、1 万人の職務の変更が数日で入る想定。1 人の案件の完了は 50ms 以内（畳み込みを含む）を目標にし、一括の子の案件で 1 時間に 1 万件を処理する（E3 で測る）。

## 10. 障害のときの振る舞い

| 障害 | 振る舞い |
| --- | --- |
| 閉包の作り直しがトランザクションの時間の上限（5 秒）を超える | 大きな部分木の移動は起票のときに検知し、夜間の一括の実行に回す。それでも超えたら失敗させ、分割の手順を示す |
| 組織の廃止で参照が残る | `PERIOD` の外部キーで失敗する前に、4.4 節の列挙で止め、移し先を求める |
| 閉包と辺の食い違い（バグ） | 夜間の検査で検知（SEV2）。`rebuild_org_closure(tenant)` で辺から作り直す。権限の判定は閉包を使うので、作り直すまでの間、食い違った組織の範囲の権限の判定を「拒否」に倒す |
| 退職の後に将来日付の差分が見つかる | DT-HR-001 の #11 で拒む |
| 同じ人の二重の登録（入社のときの重複） | 起票のときに氏名・生年月日・前の社員番号で候補を示す。登録した後に分かったら、人の統合の業務プロセス（MVP は運用の手順で、持ち越し） |

## 11. セキュリティとプライバシー

- facet ごとにドメインを分ける：`worker.personal`（氏名など）、`worker.address`、`worker.contact`、`worker.dependents`、`worker.job`、`worker.compensation`、`worker.payment_election`、`worker.employment`。上長は既定で `worker.job` と `worker.employment` の一部だけを見る（[security-model.md](security-model.md) の 3 節）。
- 口座番号は項目ごとに暗号化する（[ADR-0005](../decisions/0005-security-and-my-number.md)）。画面では末尾 4 桁だけを出す。
- 生年月日は年齢の判定（介護保険、定年）に要るが、上長には既定で見せない。
- 休職の種類は、業務上の傷病・私傷病・産前産後などの区分そのものが機微な情報になりうる。上長に見せるのは「休職中」だけにし、種類は人事と給与の担当に限る。
- 退職の理由の区分と、解雇の警告への理由の入力は、`worker.employment` の中でも別の項目の権限（`termination_details`）にする。
- テストのデータは合成の人だけにする（[AGENTS.md](../../AGENTS.md)）。

## 12. テスト

### 12.1 決定表

- DT-HR-001（事象の受け入れ）、DT-HR-002（退職の警告）、DT-HR-003（人員の管理のモデル：ポジション管理の組織で `open` のポジションがない入社・異動を拒む、ジョブ管理の組織で自動で作る）を、`spec.md` から読む表駆動テストにする。
- DT-HR-002 は、境界（予告の日から退職日まで 29 日・30 日・31 日、休業の終わりから 30 日目・31 日目）の行を持つ。境界の数え方（初日を含むか）は L12 の確認で決める。

### 12.2 性質ベーステスト

| ID | 性質 |
| --- | --- |
| PROP-HR-001 | 任意の入社・異動・休職・復職・退職・再雇用・取消の列の後、同じ人・同じ会社の雇用の期間は重ならない |
| PROP-HR-002 | 任意の日で、在籍中の雇用には主たる職務がちょうど 1 つあり、職務・給与・振込先の期間は雇用の期間の中にある |
| PROP-HR-003 | 任意の組織の辺の変更の列の後、どの日でも監督組織の辺は循環せず、根は 1 つで、閉包は辺から作り直したものと一致する |
| PROP-HR-004 | 任意の日で、ポジション（`filled`）には高々 1 人の職務の割り当てがある |
| PROP-HR-005 | 任意の再編の列で、組織の廃止の日以降に、その組織を参照する職務・ポジション・子の組織・ロールの割り当てがない |

### 12.3 例のテスト

- 4 月 1 日付の昇格を 3 月に入れ、その後 3 月 15 日付の所属の変更を入れる。4 月 1 日以降も新しい所属になる（[ADR-0002](../decisions/0002-effective-dated-data-model.md) の例）。
- 退職日 3 月 31 日の退職で、雇用の期間が `[入社日, 4 月 1 日)` になり、4 月 1 日の問い合わせで在籍していない。

## 13. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E3 | `org-model-and-hierarchy` | 4.1・4.2 節。組織の facet、辺、閉包、循環の検査（PROP-HR-003） |
| E3 | `job-catalog-and-positions` | 4.3 節。職務の目録、等級、ポジション、人員の管理のモデル（DT-HR-003、PROP-HR-004） |
| E3 | `worker-employment-model` | 3 節の 3 層と facet の宣言、社員番号（PROP-HR-001・002） |
| E3 | `hire-process` | 5.3 節の入社の業務プロセスと子の案件。労働条件の通知の交付の記録 |
| E3 | `job-change-and-transfer` | 5.5 節（DT-HR-001 の #4・5） |
| E3 | `leave-of-absence-status` | 5.2 節の休職・復職と休職の種類の印（absence の Story と合わせる） |
| E3 | `termination-and-legal-warnings` | 5.4 節（DT-HR-001 の #10・11、DT-HR-002） |
| E3 | `rehire` | 再雇用と社員番号の引き継ぎ |
| E3 | `personal-data-changes` | 6 節の個人の情報の変更の業務プロセス（セルフサービスの画面は E5） |
| E3 | `org-role-assignments` | 4.5 節。ロールのポジションへの割り当て（security-model の Story と一緒に） |
| E3 | `contingent-workers` | 7 節 |
| E3 | `org-inactivation-and-reorg` | 4.4・8 節（PROP-HR-005）。再編の予覧 |
| E12 | `statutory-registers` | 労働者名簿の元のデータの出力（[reporting.md](reporting.md) の 5.1 節の 4 つの帳簿と 1 つにした） |

## 14. 未解決の問い

### 決定

- **人員の枠はポジションに一本化し、ジョブ管理の組織はポジションを自動で作る**（[ADR-0010](../decisions/0010-person-employment-job-assignment-model.md)）。
- **ロールは組織×ポジションに割り当てる**。人が離れてもロールはポジションに残る。
- **退職日は最後の在籍日。有効期間の終わりは翌日**。
- **解雇の予告・制限などの法令の検査は警告にとどめ、理由の入力を必須にする**。止めるかの判断は企業が行う。
- **兼務は同じ雇用の中の職務の割り当て**。兼務ごとの基本給は持たない。
- **外部の人は給与の対象にせず、住所・口座・扶養・マイナンバーを持たない**。
- **退職の後に将来日付の差分が残る退職は拒む**。退職の案件の子の案件で一緒に取り消せる。
- **休職・復職は core-hr の `leave_start`・`leave_return` が持つ**（[ADR-0025](../decisions/0025-special-leave-and-leave-of-absence-boundary.md)）。休暇の領域は `employment_status` を読むだけ。休職の種類の表は `leave_of_absence_types`（休暇の種類の `leave_types` と別。[data-model.md](data-model.md) の 6 節の DM-1）。

### 法務・社労士の確認待ち（[intent.md](../intent.md) に載せたもの）

| # | 問い | 確認先 | 止める spec |
| --- | --- | --- | --- |
| L12 | 解雇の予告の 30 日の数え方（予告の日を含むか、退職日を含むか）と、解雇の制限の「その後 30 日間」の数え方。警告の境界の決定表の行 | 社労士 | E3 の `termination-and-legal-warnings` |
| L13 | 有期の契約の雇止めの予告と、無期転換の申込みの権利の発生の判定を、システムの警告にどこまで入れるか | 社労士 | 同上 |
| L14 | 労働条件の通知の書面：システムで作る項目の範囲、電子での交付（本人の希望）の記録の取り方、変更の範囲の記載の例 | 社労士 | E3 の `hire-process` |
| L15 | 派遣の労働者・業務委託の人を登録するときの、個人情報の取得の根拠と、派遣先管理台帳などの法定の帳簿を持つか | 法務・社労士 | E3 の `contingent-workers` |
| L16 | 労働者名簿（107 条）の記入の事項を、本システムのデータで満たすか（履歴、退職の事由など）と、保存（109 条で 5 年、当分の間 3 年。[intent.md](../intent.md) の L5 と合わせる） | 社労士 | E12 の `statutory-registers` |

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| 在籍出向・転籍の持ち方（出向元と出向先の 2 つの雇用か、休職の種類「出向」か） | E3 の着手の前に、対象のテナントの業務を聞いて決める。給与の負担の区分と合わせる |
| 同じ人の二重の登録の統合の業務プロセス | E3 の後。MVP は運用の手順 |
| ジョブシェア（1 つのポジションに複数人） | 需要を見て MVP の後 |
| 休職の種類ごとの給与・社会保険の扱いの印の意味 | [payroll-jp-rules.md](payroll-jp-rules.md) と社労士の確認 |

## 15. quality.md・runbooks・data-model への項目

### quality.md

- 入社・異動・退職の案件の件数と、完了までの時間（起票から完了）。
- DT-HR-002 の警告の件数と、理由を入力して進めた件数（監査の対象の抜き取り）。
- 閉包と辺の食い違いの件数（目標 0）。
- 雇用の重なり、主たる職務の欠け（夜間の検査。目標 0）。
- 組織の再編の子の案件の失敗の率。

### runbooks

- `org-closure-rebuild.md`：閉包の食い違いの検知から作り直しまで。作り直しの間の権限の扱い。
- `reorg-partial-failure.md`：再編の親の案件が `partially_applied` で止まったときの確かめ方と再実行。
- `april-mass-transfer.md`：4 月 1 日付の定期の異動の前の容量の準備（BP Worker、発効の予定の監視）。
- `duplicate-worker-merge.md`：二重に登録した人の扱い（MVP の運用の手順）。

### data-model（索引への追加の提案）

| 置き場所 | 中身 |
| --- | --- |
| Aurora `workers`、`employments`、`job_assignments` | 3.1 節の変わらない属性。1 つの `employee_number` は 1 人だけを指す（再雇用の同じ番号は許す） |
| Aurora `worker_address_subjects`、`dependents`、`emergency_contacts` | 住所の種類・扶養の親族・緊急連絡先ごとの facet の主体 |
| Aurora `employment_terminations` | 5.4 節。退職の理由・通知の日・警告への理由（労働者名簿の退職の事由） |
| Aurora facet（3 つのテーブルずつ）：`worker_personal`、`worker_address`、`worker_contact`、`worker_dependents`、`worker_emergency_contacts`、`employment_status`、`employment_contract`、`employment_primary_job`、`worker_job`、`worker_compensation`、`worker_payment_election` | 3.3 節 |
| Aurora facet：`organization`、`org_parent`、`position_detail`、`job_profile`、`grade_detail`、`org_role_assignment` | 4 節。主体の表は `organizations`・`positions`・`job_profiles`・`grades`・`org_role_assignments`（[data-model/core-hr.md](data-model/core-hr.md)） |
| Aurora `org_closure` | 4.2 節。派生。`WITHOUT OVERLAPS` の主キー |
| Aurora `organizations`、`positions`（変わらない属性） | 4 節 |
| Aurora `leave_of_absence_types`（休職の種類）、`termination_reasons` | 5.2・5.4 節。テナントの設定 |

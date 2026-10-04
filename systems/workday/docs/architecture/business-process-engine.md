# Business process engine: Workday

業務プロセスの定義とバージョン、ステップの種類と条件、組織のロールによるルーティング、委任、案件の状態機械、取消・訂正・キャンセル、親子の案件、期限と督促、受信箱、定義の検証と有効化を決める。

前提の決定は、業務プロセスをバージョンつきの定義と Aurora に永続する状態機械で自前に作ること（[ADR-0003](../decisions/0003-business-process-engine.md)）、人事のデータは完了のステップで有効日付の差分として書くこと（[ADR-0002](../decisions/0002-effective-dated-data-model.md)）、権限と職務分掌（[ADR-0005](../decisions/0005-security-and-my-number.md)）。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0013](../decisions/0013-bp-definition-format-and-versions.md) | 定義は JSON の宣言（ステップの一覧と、型のある式の木の条件）にする。定義は有効開始日つきのバージョンを持ち、案件は起票の日に有効なバージョンに固定する。子の案件は親の起票の日でバージョンを選ぶ |
| [0014](../decisions/0014-bp-routing-and-delegation.md) | 担当は、ステップに入った時点の組織のロールの割り当てと閉包で決め、起票者と対象の本人を除いて上へたどる。委任は期間と業務プロセスの種類で決め、期間中は未完了のタスクも代理人が操作できる。再委任はしない。権限は委任した人で、職務分掌は実際の操作者で判定する |
| [0015](../decisions/0015-bp-deadlines-reminders-and-inbox.md) | 期限は営業日で決め、督促とエスカレーションを `bp_timers` で行う。受信箱は担当の割り当ての射影を同じトランザクションで保ち、委任は読むときに結ぶ。通知の本文に個人情報を入れない |
| [0016](../decisions/0016-bp-definition-validation-and-activation.md) | 定義は保存のときに静的に検査し、模擬の実行で担当を確かめる。定義の変更は下書きと有効化に分け、有効化は別の人が行う |

## 1. 目的と範囲

- 扱う：業務プロセスの種類と定義、定義のバージョンと選び方、ステップの種類、条件の式、ルーティング、予備の担当、委任、案件とステップの状態と遷移、完了のトランザクション、キャンセル・取消・訂正・差し戻し・却下、親子の案件と一括、期限・督促・エスカレーション、受信箱、通知の依頼、定義の検証・模擬の実行・有効化。
- 扱わない：有効日付の差分の書き方（[object-model-and-effective-dating.md](object-model-and-effective-dating.md)）、事象ごとの業務の中身（[core-hr.md](core-hr.md)、[payroll-engine.md](payroll-engine.md) など）、権限の判定そのもの（[security-model.md](security-model.md)）、受信箱の画面（[self-service-ui.md](self-service-ui.md)）、通知の届け方。
- **人事のデータを変える書き込みは、このエンジンの完了のステップだけが行う**（[AGENTS.md](../../AGENTS.md)）。

## 2. 本家の形（確かめたこと）

どれも 2026-09-28 に確認した。本家の実装は使わない（[リポジトリ共通の ADR-0007](../../../../docs/decisions/0007-no-reuse-of-original-implementation.md)）。

| 本家の考え方 | 内容 | このシステムでの扱い |
| --- | --- | --- |
| 定義の有効日 | 定義の変更は有効日を持ち、その日から使える。業務プロセスの案件の有効日は別の意味（昇給の始まりの日など）（[Concept: Effective Dates](https://doc.workday.com/admin-guide/en-us/manage-workday/business-processes/business-process-framework-concepts/dan1370796344630.html)） | 定義のバージョンに `effective_from` を持つ。案件の `effective_on` とは別 |
| 進行中の案件 | 進行中の案件は、定義の変更を拾わない。新しく起票した案件だけが新しい定義を使う（検索の要約と講座の資料による。[Business Process Framework](https://doc.workday.com/workday-education/en-us/course-manuals/hcm-core-for-administrators/business-process-framework.html)） | 同じ（[ADR-0003](../decisions/0003-business-process-engine.md)）。起票の時点のバージョンに固定する |
| 子のプロセス | 子のプロセスは既定で親の有効日を引き継ぐ（[Concept: Effective Dates](https://doc.workday.com/admin-guide/en-us/manage-workday/business-processes/business-process-framework-concepts/dan1370796344630.html)） | 子の案件は親の起票の日で定義のバージョンを選び、親の `effective_on` を引き継ぐ |
| 委任 | 開始日の 0 時から終了日の終わりまで、委任した人のタイムゾーンで効く。委任された人は、委任されたタスクを再委任できない。委任の履歴を本人と管理者が見られる（[Delegate My Tasks](https://doc.workday.com/admin-guide/en-us/manage-workday/business-processes/delegate-business-processes/business-process-task-delegation/dan1370796482940.html)） | 同じ考え方。テナントの暦で日単位 |
| 委任と進行中のタスク | 公式の文書は「委任した人に向かうはずのタスクを代理人が受ける」と書く。大学の案内は「委任の前に起票された案件は元の承認者に流れ続ける」と書く（[CCA の案内](https://portal.cca.edu/knowledge-base/workday/delegate-your-workday-inbox-or-tasks/)。二次資料） | 両者が食い違う（未検証）。本システムは、期間中は未完了のタスクも代理人が操作できるとした（[ADR-0014](../decisions/0014-bp-routing-and-delegation.md)） |
| 取消・訂正・キャンセル | 取消は完了した案件、キャンセルは進行中の案件に使い、元に戻せない。訂正は承認に回らない（[Correct, Cancel, and Rescind](https://it.tamus.edu/workdayservices/training/job_aid/correct-cancel-and-rescind/)。二次資料） | 取消・訂正の承認は定義で決め、給与・口座の訂正は既定で承認（[ADR-0003](../decisions/0003-business-process-engine.md)） |

## 3. 定義（[ADR-0013](../decisions/0013-bp-definition-format-and-versions.md)）

### 3.1 業務プロセスの種類

システムが種類と既定の定義を持つ。テナントは既定の定義を写して変える。種類を足すことはできない（MVP）。

| 種類 | 対象 | 完了で書くもの |
| --- | --- | --- |
| `hire`・`rehire`・`terminate`・`contract_end` | 人・雇用 | 雇用、職務、給与などの差分（[core-hr.md](core-hr.md) の 5 節） |
| `job_change`・`transfer`・`promotion`・`demotion` | 職務の割り当て | `worker_job` など |
| `compensation_change` | 雇用 | `worker_compensation` |
| `leave_start`・`leave_return` | 雇用 | `employment_status` |
| `address_change`・`personal_change`・`contact_change`・`dependent_change`・`payment_election_change` | 人・雇用 | 個人の facet |
| `position_create`・`position_change`・`position_close` | ポジション | `position_detail` |
| `org_create`・`org_change`・`org_inactivate`・`reorganization` | 組織 | `organization`、`org_parent` |
| `role_assignment_change` | 組織×ロール | `org_role_assignment` |
| `contract_renewal` | 雇用 | `employment_contract`（[core-hr.md](core-hr.md) の 3.3 節） |
| `security_group_membership_change` | セキュリティグループ | `security_group_members`（[security-model.md](security-model.md) の 4.4 節） |
| `delegation` | 人 | 委任の設定（7 節） |
| `time_correction`、`time_period_reopen`、`timesheet_approval` | 雇用・勤怠の締めの期間 | 打刻の訂正、締めた月の開き直し、上長の承認（[time-and-attendance.md](time-and-attendance.md) の 3.4・7.2 節） |
| `overtime_agreement_change` | 事業所 | `overtime_agreements`（同 6.1 節） |
| `time_off_request`、`annual_leave_designation`、`special_leave_grant`、`leave_balance_adjustment` | 雇用 | 休暇の申請、時季の指定、特別休暇の付与、残日数の調整（[absence-and-leave.md](absence-and-leave.md) の 3.1 節、[ADR-0025](../decisions/0025-special-leave-and-leave-of-absence-boundary.md)） |
| `leave_policy_change` | テナント | 斉一的付与などの付与の方針のバージョン（[absence-and-leave.md](absence-and-leave.md) の 4.4 節） |
| `pay_item_change` | 給与のグループ | 項目と項目の組のバージョン（[payroll-engine.md](payroll-engine.md) の 6.1 節） |
| `bonus_entry` | 給与の実行（賞与） | 賞与の支給額の入力（同 8 節） |
| `resident_tax_notice` | 雇用 | 住民税の特別徴収の通知（`resident_tax_notices`。一括の取り込みの雛形で入れる。[payroll-jp-rules.md](payroll-jp-rules.md) の 6.2 節） |
| `si_grade_change` | 雇用 | `worker_social_insurance` の等級の決定（随時改定・定時決定・保険者決定。[payroll-jp-rules.md](payroll-jp-rules.md) の 4.6・4.7 節） |
| `payroll_finalize`・`payroll_cancel`・`payroll_payment_release` | 給与の実行 | 給与・支払の領域の表（振込ファイルの承認は `payroll_payment_release`） |
| `mn_handler_designation` | 人 | 事務取扱担当者の指定（完了の事象を保管庫へ送る。[my-number-vault.md](my-number-vault.md) の 6.3 節） |
| `bulk_import` | テナント | 一括の取り込みの親の案件。行ごとに子の案件を作る（[integrations-and-bulk.md](integrations-and-bulk.md) の 3 節） |
| `migration` | 人・雇用・組織 | 移行の差分。テナントが `implementing` の間か、本番を始める前の雇用にだけ使える（同 4.2 節） |
| `security_policy_activation` | テナント | 権限のバージョン（[security-model.md](security-model.md) の 8 節） |
| `bp_definition_activation` | テナント | 定義のバージョン（11 節） |

- 上の一覧は、統合の工程で各領域の文書が足した種類を集めたもの。種類を足すときは、この表と、種類ごとの payload のスキーマと、既定の定義を同じ変更で足す。
- 業務プロセスの種類によらない権限に、`retro_override`（90 日より前の過去日付の変更の起票。業務プロセスの操作）と `payroll.retro_override`（給与の遡及の窓を 24 か月から 36 か月に広げる）がある（[security-model.md](security-model.md) の 4.3 節）。

### 3.2 形

定義は JSON で、Zod のスキーマで検証する。条件は文字列の式ではなく、型のある式の木にする（構文の誤りと注入を避け、静的に型を検査できる）。

```jsonc
{
  "process_type": "compensation_change",
  "version": 7,
  "effective_from": "2026-10-01",
  "subject": "employment",
  "depends_on": ["job_change", "promotion"],          // DT-TEMP-004 row 6
  "steps": [
    { "key": "initiate", "type": "initiation",
      "initiators": ["role:manager", "role:hr_partner"] },
    { "key": "mgr2", "type": "approval",
      "assignee": { "role": "manager", "from": "subject_org", "levels_up": 1, "walk": "up_until_found" },
      "due": { "business_days": 3 } },
    { "key": "hr", "type": "approval",
      "assignee": { "role": "hr_partner", "from": "subject_org", "walk": "up_until_found" },
      "when": { "op": ">", "left": { "field": "case.increase_pct" }, "right": { "const": "10" } },
      "due": { "business_days": 2 } },
    { "key": "notify", "type": "notification", "to": ["subject", "role:manager"] },
    { "key": "complete", "type": "completion" }
  ],
  "cancel":  { "allowed": ["initiator", "role:hr_partner"] },
  "rescind": { "approval": "none" },
  "correct": { "approval": "route", "route_from": "hr" }
}
```

- ステップは、直列の並びと、並列の承認のまとまり（`approval_group`）と、条件（`when`）で表す。任意のグラフ（戻りの辺、合流）は書かせない。差し戻しは「前のステップに戻る」操作で、辺として書かない。
- 条件の式の木：比較（`=`・`!=`・`<`・`<=`・`>`・`>=`）、`and`・`or`・`not`、`in`、`is_null`、項目の参照（`case.*`・`subject.*`・`initiator.*`）、定数、組み込みの関数（`age_on(date)`・`org_is_under(org_id)`・`days_between(a, b)`）だけ。数は 10 進の文字列で持ち、`packages/money` の比較で評価する。
- 式の上限：深さ 10、節 200。評価は副作用なし。
- `subject.*` は、案件の `effective_on` の時点の、現在の知識で読む。

### 3.3 バージョンと選び方

```sql
bp_definitions (tenant_id, id, process_type, version int,
                effective_from date,
                body jsonb, body_hash bytea,
                status text,          -- draft / pending_activation / active / retired
                based_on_version int, -- copied from
                created_by, created_at, activated_by, activated_at,
                PRIMARY KEY (tenant_id, id),
                UNIQUE (tenant_id, process_type, version))
```

- 案件の起票のとき、`status = active` で `effective_from ≤ 起票の日（テナントの暦）` のうち、`effective_from` が最も新しいバージョンを選び、案件に `definition_id` を固定する。
- 案件の `effective_on`（発令の日）では選ばない。3 月に 4 月 1 日付の発令を起票したら、3 月に有効な定義で進む。
- 子の案件は、親の案件の起票の日でバージョンを選ぶ。親子で定義の世代が混ざらない。
- 有効化したバージョンは書き換えない。直すときは新しいバージョンを作る。元に戻すときは、古いバージョンの中身を写した新しいバージョンを有効化する。
- システムの既定の定義の新しいバージョン（本システムのリリース）は、テナントの写しを上書きしない。テナントの管理者に「既定の定義が変わった」ことと差分を知らせる。法令の要件に関わる既定のステップ（例：退職の後の手続き）の変更は、リリースノートで示す。

## 4. ステップの種類

| 種類 | 担当 | 操作 | 進み方 |
| --- | --- | --- | --- |
| `initiation` | 起票の権限を持つ人（[security-model.md](security-model.md) の 4.3 節） | 起票 | 次へ |
| `approval` | ルーティングで決まった人（5 節） | 承認・差し戻し・却下 | 承認で次へ。差し戻しで前のステップへ。却下で `denied` |
| `approval_group` | 並列のメンバー（各メンバーは `approval` と同じ指定） | 同上 | `mode`：`all`（全員）・`any`（1 人）・`quorum`（N 人）。却下は 1 人で `denied` |
| `action` | ルーティングで決まった人 | 完了（添付・入力を伴いうる）・差し戻し | 完了で次へ |
| `sub_process` | — | — | 子の案件を作り、完了を待つ（9 節） |
| `service` | システム | — | 冪等なシステムの処理。成功で次へ。失敗は再試行の後に `action` のステップ（担当は予備の担当）を差し込む |
| `notification` | — | — | 通知の依頼を outbox に書いて、すぐ次へ |
| `completion` | システム | — | 差分の書き込みと案件の完了（6.3 節） |

- 条件（`when`）が偽のステップは `skipped` にする。条件はステップに入る時に評価し、結果をイベントに残す。
- `service` のステップは、完了の前に外の世界を変えうる（例：入社の前の SSO のアカウントの予約）。そういうサービスは、補償の処理（`compensate`）を登録しなければならない。キャンセル・却下のときに、完了した `service` のステップの補償を逆の順で行う。
- 上限：1 つの定義のステップは 30 まで、`approval_group` のメンバーは 10 まで、`sub_process` の入れ子は 2 段まで。

## 5. ルーティング（[ADR-0014](../decisions/0014-bp-routing-and-delegation.md)）

### 5.1 担当の指定

| 指定 | 意味 |
| --- | --- |
| `role` | 組織のロール（`manager`・`hr_partner`・`payroll_admin`・`time_admin` など。[core-hr.md](core-hr.md) の 4.5 節） |
| `from` | 起点の組織。`subject_org`（対象の職務の割り当ての監督組織。人の全体の案件は主たる職務）、`initiator_org`、`fixed:<org_id>`、`target_org`（異動の受け入れ先） |
| `levels_up` | 起点から何段上から始めるか（既定 0） |
| `walk` | `exact`（その組織だけ）・`up_until_found`（見つかるまで上へ） |
| `group` | ロールの代わりに、セキュリティグループ（例：`payroll_admins`）。組織に依らない |
| `subject` | 対象の本人（本人の確認のステップ） |

### 5.2 決め方

ステップに入った時点で、次の順で担当の候補を決め、`bp_step_assignees` に記録する。

1. 起点の組織を決める。組織は、今日（テナントの暦）の現在の知識で読む（[ADR-0003](../decisions/0003-business-process-engine.md)）。
2. `levels_up` だけ閉包で上がる。
3. その組織の `role` の割り当てのポジションを読み、今日そのポジションにいる人を候補にする。
4. 候補から、除外の人（5.4 節）を除く。
5. 候補が空で `walk = up_until_found` なら、1 つ上の組織で 3 からやり直す。根まで行っても空なら 5.3 節。

- 決まった担当は、後で組織が変わっても自動では付け替えない。上長の変更の発効のときに、進行中のタスクの担当の確認を人事に通知する（[object-model-and-effective-dating.md](object-model-and-effective-dating.md) の 8 節）。付け替えは人事の `reassign` の操作で行い、記録する。
- 将来日付の発令（例：4 月 1 日付の異動を 3 月に起票）でも、担当は今日の組織で決まる。受け入れ先の上長の承認が要るなら、定義で `from: target_org` を使う。

### 5.3 予備の担当

- 担当が決まらないとき、定義のステップの `fallback`（指定がなければテナントの設定の予備のグループ、既定は人事の管理者）に回し、`ROUTING_FALLBACK` の警告を案件と監視に出す。
- 予備のグループも空なら、ステップを `stuck` にし、テナントの管理者と本システムの監視に出す。`stuck` は 24 時間で SEV3。

### 5.4 除外（DT-BP-002）

上から評価し、当たった行の結果を採る。

| # | 候補 | 起票者（実際の操作者） | 対象の本人 | ステップ | 結果 |
| --- | --- | --- | --- | --- | --- |
| 1 | 対象の本人 | - | はい | `approval`・`approval_group` | 除く（本人の案件を本人が承認しない。上長の昇給を本人が上長として承認する形を防ぐ） |
| 2 | 対象の本人 | - | はい | `action`・`subject` の指定 | 残す（本人の確認のステップ） |
| 3 | 起票者 | はい | - | `approval`・`approval_group` | 除く（職務分掌。[ADR-0005](../decisions/0005-security-and-my-number.md)） |
| 4 | 起票者 | はい | - | `action` | 残す |
| 5 | この案件で前の承認をした人 | - | - | `approval` | 定義の `distinct_approvers: true` なら除く（既定 false） |
| 6 | 職務分掌の規則表で、案件の種類の承認と両立しない権限を持つ人 | - | - | `approval` | 除く（[security-model.md](security-model.md) の 5 節） |
| 7 | それ以外 | - | - | - | 残す |

- 除外で空になったら、`walk` に従って上へたどる（5.2 節の 5）。
- 除外は、操作の時にもう一度確かめる（委任を経た実際の操作者で。7 節）。ルーティングのときの除外だけに頼らない。

## 6. 案件の状態機械

### 6.1 表

```sql
bp_cases (tenant_id, id, process_type, definition_id,
          parent_case_id,
          subject_type, subject_id, job_assignment_id,
          effective_on date,
          state text,       -- in_progress / completed / partially_applied / cancelled / denied / rescinded
          payload jsonb,    -- proposed values (Zod-validated per process type)
          based_on_version_ids uuid[],
          initiated_by, initiated_on_behalf_of, initiated_at,
          completed_at, lock_version int,
          PRIMARY KEY (tenant_id, id))

bp_steps (tenant_id, id, case_id, step_key, attempt int,
          state text,       -- pending / open / completed / skipped / sent_back / cancelled / stuck
          due_at timestamptz, opened_at, closed_at,
          acted_by, acted_on_behalf_of, action text, comment_ref,
          PRIMARY KEY (tenant_id, id))

bp_step_assignees (tenant_id, step_id, worker_id, via text,   -- role / group / fallback / reassign
                   PRIMARY KEY (tenant_id, step_id, worker_id))

bp_events   (tenant_id, id, case_id, seq, type, payload jsonb, actor, on_behalf_of, recorded_at)  -- append-only
bp_commands (tenant_id, command_id, case_id, result jsonb, created_at)                              -- idempotency, 30 days
bp_timers   (tenant_id, id, case_id, step_id, kind, fire_at, fired_at, state)                       -- 10 節
```

### 6.2 遷移（DT-BP-001）

案件の状態 × 操作。表にない組は拒む（`INVALID_TRANSITION`）。

| # | 案件の状態 | 操作 | 条件 | 次の状態 | 備考 |
| --- | --- | --- | --- | --- | --- |
| 1 | （なし） | `initiate` | 起票の権限。payload の検証 | `in_progress` | 最初のステップを開く |
| 2 | `in_progress` | `approve`・`complete_action` | 操作者が開いたステップの担当（委任を含む）。除外に当たらない | `in_progress` | 次のステップへ。最後なら 6.3 節 |
| 3 | `in_progress` | `send_back` | 同上。差し戻し先は前の人のステップ（既定は起票） | `in_progress` | 差し戻し先のステップを `attempt + 1` で開き直す。差し戻しは 1 案件 5 回まで |
| 4 | `in_progress` | `deny` | 承認のステップの担当 | `denied` | 完了した `service` の補償を行う |
| 5 | `in_progress` | `cancel` | 定義の `cancel.allowed` | `cancelled` | 同上 |
| 6 | `in_progress` | `reassign` | 人事の管理者 | `in_progress` | 担当の差し替えを記録 |
| 7 | `in_progress` | `timer_fired` | 期限・督促・エスカレーション | `in_progress` | 10 節 |
| 8 | `in_progress` | `service_result` | サービスのステップ | `in_progress` | 失敗が続けば `action` を差し込む |
| 9 | `in_progress` | 完了のステップ | 6.3 節の検査 | `completed` | 差分を書く |
| 10 | `in_progress`（親） | 子の完了 | 子の一部が失敗 | `partially_applied` | 9 節 |
| 11 | `partially_applied` | `retry_children` | 人事 | `in_progress` | 失敗した子だけを作り直す |
| 12 | `completed` | `rescind` | 取消の権限。8 節の DT-BP-003 | `rescinded` | 差分に取消の印 |
| 13 | `completed` | `correct` | 訂正の権限。8 節の DT-BP-003 | `completed` | 訂正の案件（子）を作る。元の案件の状態は変えない |
| 14 | `cancelled`・`denied`・`rescinded` | 何でも | - | 変えない | 終端 |

- 操作は冪等にする。画面・API は `command_id` を付け、`bp_commands` で 2 回目に同じ結果を返す。
- 同じ案件への同時の操作は `lock_version` の楽観ロックで 1 つにする。負けた側は `CONFLICT` を返し、画面は読み直す。

### 6.3 完了のトランザクション

最後のステップが終わったトランザクションの中で、次を行う（[ADR-0003](../decisions/0003-business-process-engine.md)）。

1. 案件の行を `FOR UPDATE` でロックする。
2. **見ていたバージョンの確認**：`based_on_version_ids` のうち、案件が書く facet のバージョンが、現在の知識で置き換えられていないか確かめる。置き換えられていて、案件の項目と重なるなら、完了しない。起票者に `resubmit` の `action` のステップを開き、差（何が誰の案件で変わったか）を示す（`STALE_BASIS`）。重ならなければ、バージョンの ID を新しいものに更新して進める。
3. 職務分掌を確かめ直す（起票者と承認者、[security-model.md](security-model.md) の 5 節）。
4. `packages/temporal` で差分を書く（[object-model-and-effective-dating.md](object-model-and-effective-dating.md) の 5 節）。DT-TEMP-001〜004 の拒否は、案件を完了させず、起票者への `action` のステップにする。
5. 案件を `completed` にし、`bp_events` と outbox（`bp.case_completed`）を書く。
6. どれかが失敗したら、全体を戻す。

- 1 つの案件の完了は 1 つのトランザクションにする。書く主体が多い案件（一括）は親子の案件に分ける（9 節）。
- 完了のトランザクションにも `transaction_timeout = 5s` が掛かる（[ADR-0008](../decisions/0008-point-in-time-queries-and-activation-timers.md)）。

## 7. 委任（[ADR-0014](../decisions/0014-bp-routing-and-delegation.md)）

```sql
bp_delegations (tenant_id, id, delegator_id, delegate_id, alternate_id,
                scope text,              -- initiate / inbox / both
                process_types text[],    -- empty = all delegable types
                start_on date, end_on date,   -- tenant calendar, inclusive
                created_by_case_id, revoked_at,
                PRIMARY KEY (tenant_id, id))
```

- 委任の設定は `delegation` の業務プロセスで行う（既定は承認なし・上長に通知）。取り消しもできる。
- 期間：開始日の 0 時から終了日の終わりまで（テナントの暦）。最長 180 日。同じ委任した人・同じ業務プロセスの種類で、重なる委任は 1 つ。
- 期間中は、委任した人に開いているタスク（期間の前から開いているものを含む）を、代理人も操作できる。委任した人も操作できる。先に操作した方が有効（楽観ロック）。
- 代理人は再委任できない。代理人が不在なら `alternate_id` が受ける。
- 委任できない業務プロセスの種類：`security_policy_activation`、`bp_definition_activation`、`payroll_finalize`（既定。テナントが変えられるのは `payroll_finalize` だけ）。
- 判定（DT-BP-005）：

| # | 判定 | 誰で判定するか |
| --- | --- | --- |
| 1 | そのタスクを操作する権限（業務プロセスの権限、ドメインの権限） | 委任した人 |
| 2 | 職務分掌（起票者と承認者が同じでない、規則表の両立しない権限） | 実際の操作者（代理人）と、委任した人の両方 |
| 3 | 対象の本人でない（5.4 節の #1） | 実際の操作者と、委任した人の両方 |
| 4 | 画面・API で見える項目（給与の額など） | 委任した人の権限と、代理人の権限の共通部分。代理人に見えない項目は、承認の画面で伏せる |
| 5 | 監査の記録 | `acted_by` = 代理人、`acted_on_behalf_of` = 委任した人 |

- #4 は、代理人に給与の閲覧の権限がないときに、給与の変更の承認を任されても、額を見ずに承認することになる。これを避けるため、委任の設定のときに、対象の業務プロセスの種類の承認に要る項目を代理人が見られるかを確かめ、見られなければ警告する（止めない）。
- 起票の委任（`scope = initiate`）は、代理人が委任した人の名前で起票する。起票者は委任した人、実際の操作者は代理人として両方を記録し、以後の除外（5.4 節）は両方に当てる。

## 8. 取消・訂正・キャンセル

[ADR-0003](../decisions/0003-business-process-engine.md) の表に従う。細部をこの節で決める。

### 8.1 取消（rescind）

- 取消は、案件（と、その子の案件）が書いたすべての差分に、1 つのトランザクションで取消の印を付ける。子の案件は後に作られたものから逆の順に取り消す。どれか 1 つでも依存（DT-TEMP-004）で拒まれたら、全体を拒む。
- 取消の後、発効の予定の取り消しと逆の副作用（DT-TEMP-005）を同じトランザクションで行う。
- 取消は新しい案件（`rescind` の案件）として起票し、定義の `rescind.approval` に従って承認を経る。元の案件は `rescinded` になる。

### 8.2 訂正（correct）

- 訂正は、元の案件の子として訂正の案件を作る。訂正の案件の payload は元の payload の修正で、差分は `kind = correction`（[object-model-and-effective-dating.md](object-model-and-effective-dating.md) の 6.2 節）。
- 訂正の案件の承認の流れは、**今** 有効な定義の `correct` の方針で決める（元の案件のバージョンではない）。訂正の方針を厳しくした変更が、過去の案件の訂正にも効くようにする。
- 給与（`worker_compensation`）・口座（`worker_payment_election`）・雇用の日付（入社日・退職日）に触れる訂正は、既定で承認に回す。承認なしの訂正は、テナントが定義で明示したときだけ許し、監査の報告に出す。

### 8.3 取消・訂正を受ける条件（DT-BP-003）

| # | 操作 | 案件の種類 | 確定した給与の期間にかかる | その他 | 結果 |
| --- | --- | --- | --- | --- | --- |
| 1 | `rescind` | `hire` | はい（その雇用に確定した給与の結果がある） | - | 拒む（`PAYROLL_EXISTS`）。退職で扱う |
| 2 | `rescind` | `hire` | いいえ | - | 受ける（DT-TEMP-004 の #1 で後の案件がないこと） |
| 3 | `rescind` | `terminate` | - | 雇用の後に同じ人の再雇用がある | 拒む（先に再雇用を取り消す） |
| 4 | `rescind`・`correct` | 何でも | はい | - | 受ける。遡及の候補を給与の担当に示す（`temporal.retro_detected`） |
| 5 | `rescind`・`correct` | `payroll_finalize` | - | - | 拒む。給与の実行の取消は `payroll_cancel` の業務プロセス（[payroll-engine.md](payroll-engine.md)） |
| 6 | `rescind`・`correct` | `security_policy_activation`・`bp_definition_activation` | - | - | 拒む。前のバージョンを有効化し直す |
| 7 | `correct` | 何でも | - | 訂正で有効日を動かす | DT-TEMP-003 に従う |
| 8 | `rescind`・`correct` | それ以外 | いいえ | - | 受ける |

### 8.4 キャンセルと却下

- 進行中の案件のキャンセル・却下では、データは変わっていない。完了した `service` のステップの補償だけを行う。
- 補償が失敗したら、案件は `cancelled`・`denied` にしたうえで、補償の `action` のタスクを予備の担当に作る。

## 9. 親子の案件と一括

- 親の案件（`reorganization`、一括の取り込み、退職の後の手続き）は、`sub_process` のステップで子の案件を作る。
- 子の案件は、親が承認済みなら承認のステップを省く定義（`inherit_approval: true`）で作れる。省いたことを子の案件のイベントに残す。
- 一括の子の案件は 200 件ずつの束で作り、束ごとに SQS のメッセージにして BP Worker が完了させる。1 テナントの同時の束は 4 まで。
- 子の一部が失敗したら、親を `partially_applied` にし、失敗の一覧（子の案件、誤りのコード）を示す。成功した子は取り消さない。直した後に `retry_children` で失敗した子だけを作り直す。
- 一括の取り込み（表計算の雛形）も、行ごとに子の案件を作る（[integrations-and-bulk.md](integrations-and-bulk.md)）。検証の失敗は、子の案件を作る前に行ごとに返す。

## 10. 期限・督促・受信箱（[ADR-0015](../decisions/0015-bp-deadlines-reminders-and-inbox.md)）

### 10.1 期限と督促

| 設定 | 既定 | 上限 |
| --- | --- | --- |
| 期限（`due`） | 承認 3 営業日、アクション 5 営業日 | 30 営業日 |
| 督促 | 期限の 1 営業日前に 1 回、期限を過ぎたら 1 営業日ごと | 督促は 5 回まで |
| エスカレーション | 期限を 3 営業日過ぎたら、担当の上長を担当に足す（`via = escalation`） | 1 段まで |
| 自動の処理 | なし（自動で承認・却下しない） | テナントは `auto_deny_after` を承認以外のアクションに設定できる。承認には設定できない |

- 営業日はテナントの暦（土日・祝日・テナントの休日）で数える。暦の表は給与の領域と共通にする。
- 期限は、ステップが開いたとき、`bp_timers` に `due`・`remind`・`escalate` の行を同じトランザクションで作る。ステップが閉じたら、同じトランザクションで `cancelled` にする。
- BP Worker が `fire_at` の来たタイマーを `FOR UPDATE SKIP LOCKED` で取り、`timer_fired` の操作として状態機械に渡す。ステップが既に閉じていれば何もしない。
- 業務の期限（例：給与の締め）は、定義の期限ではなく、給与の実行の予定から「この日までに完了しないと今月の給与に入らない」を受信箱に出す（[payroll-engine.md](payroll-engine.md)）。

### 10.2 受信箱

```sql
inbox_items (tenant_id, worker_id, step_id, case_id, process_type,
             reason text,          -- assigned / escalation / fyi
             due_at, opened_at, state text,  -- open / done / withdrawn
             PRIMARY KEY (tenant_id, worker_id, step_id))
CREATE INDEX ON inbox_items (tenant_id, worker_id, state, due_at);
```

- `bp_step_assignees` が変わるトランザクションの中で、`inbox_items` を足す・閉じる。
- 委任は `inbox_items` に写さない。受信箱を読むときに、今日有効な委任（`bp_delegations`）で、委任した人の開いた項目を結ぶ。委任の開始・終了で行を書き換えずに済む。
- 受信箱の項目には、案件の種類、対象の人の表示の名前（見る権限があるとき）、期限、代理の印（「〇〇さんの代理」）を出す。項目を開いたときに、権限の判定を通して案件の詳細を読む。
- 表示：期限の順、50 件ずつ。完了した項目は 90 日で受信箱から消える（案件と記録は残る）。
- まとめての承認：同じ業務プロセスの種類の項目を 50 件まで選んで承認できる。承認は 1 件ずつの操作（`command_id` を件ごと）として実行し、職務分掌と除外を件ごとに確かめる。失敗した件だけを示す。

### 10.3 通知

- 通知（メール、画面）は outbox から通知の worker に渡す。
- メールの本文に個人情報（対象の人の氏名、給与の額、休職の種類）を入れない。「承認の依頼が 1 件あります（業務プロセスの種類）」と、ログインを要するリンクだけにする。
- 1 人への通知は、テナントの設定で 1 日 1 回のまとめにできる。

## 11. 定義の検証と有効化（[ADR-0016](../decisions/0016-bp-definition-validation-and-activation.md)）

### 11.1 静的な検査（保存のたびに行う）

| # | 検査 | 誤りのコード |
| --- | --- | --- |
| 1 | JSON が種類ごとのスキーマに合う | `SCHEMA` |
| 2 | 最初が `initiation`、最後が `completion`、それぞれ 1 つ | `SHAPE` |
| 3 | ステップの `key` が一意、ステップ 30 以下、入れ子 2 段以下 | `LIMIT` |
| 4 | 条件の式が型に合う（項目の参照が payload・対象・起票者のスキーマにある、比較の型が合う）。深さ・節の上限 | `EXPR_TYPE` |
| 5 | 担当の指定のロール・グループがテナントに存在する | `UNKNOWN_ROLE` |
| 6 | 少なくとも 1 つの承認のステップが、条件なしで必ず通る（`approval_required` の種類だけ。給与・口座・退職・権限など） | `NO_MANDATORY_APPROVAL` |
| 7 | 承認のステップの担当の指定が、起票できるグループと同じだけ（起票者しか候補にならない）でない | `SELF_APPROVAL_ONLY` |
| 8 | 差し戻し先が、そのステップより前にある | `SEND_BACK_TARGET` |
| 9 | 期限・督促・エスカレーションが上限の中 | `LIMIT` |
| 10 | 承認に `auto_deny_after` や自動の承認がない | `AUTO_APPROVAL` |
| 11 | `service` のステップが、登録済みのサービスで、補償を持つ | `SERVICE` |
| 12 | 訂正の方針が、給与・口座・雇用の日付の訂正を承認なしにしている | 警告（`CORRECTION_WITHOUT_APPROVAL`）。有効化の画面で明示の確認を求める |

- 直列と並列と条件だけの形なので、到達できないステップは「常に偽の条件」だけになる。式の定数の畳み込みで常に偽の条件を見つけ、警告にする。
- 終わらない差し戻しは、差し戻しの回数の上限（5 回）で構造上起きない。

### 11.2 模擬の実行

- 定義の下書きを、テナントの実在の対象（人、組織）か合成の対象に当て、今日の組織で「どのステップに、誰が担当になるか」「条件がどう評価されるか」を示す。データは書かない。
- 模擬の実行は読み取りだけで、権限の判定を通す（操作者が見られない人を対象にできない）。
- 有効化の前に、代表の組織（テナントの監督組織の各階層から 1 つ以上）の模擬の実行を必須にし、担当が決まらない組織の一覧を出す。

### 11.3 有効化

- 定義の変更は `draft` で保存し、`bp_definition_activation` の業務プロセスで有効化する。起票者（編集者）と有効化の承認者は別の人にする（職務分掌の規則表の既定の行。[security-model.md](security-model.md) の 5 節）。
- 有効化で `status = active` にし、`effective_from` の日から新しい起票に使われる。前のバージョンは、次のバージョンの `effective_from` の前日まで使われ、その後 `retired` になる。
- 有効化は監査に残す（誰が、いつ、どのバージョンを、どの差分で）。

## 12. 規模

- S1 の案件の数の見積もり：休暇の申請が大半で、従業員 100 万人 × 月 3 件 ≒ 月 300 万件、1 日の平均 10 万件、ピーク 1 時間 3 万件。人事の案件（異動・給与の変更など）は 4 月に集中し、1 日 10 万件。
- `bp_events` は 1 案件 5〜10 行で、月 3,000 万行。`recorded_at` の月ごとのパーティションにする。
- 受信箱の読み取り（p95 200ms）：`inbox_items` の索引の引きと、委任の結び。
- タイマー：開いたステップ × 3 行。S1 で常時 50 万行程度。

## 13. 障害のときの振る舞い

| 障害 | 振る舞い |
| --- | --- |
| 完了のトランザクションの途中の失敗 | 全体を戻す。案件は `in_progress` のまま。BP Worker が再試行する（冪等） |
| `STALE_BASIS` | 起票者に `resubmit` のアクションを開く |
| 担当が決まらない | 予備の担当へ（5.3 節）。予備も空なら `stuck`（24 時間で SEV3） |
| サービスのステップの失敗 | 指数の待ちで 5 回まで再試行。続けて失敗すれば予備の担当に `action` を差し込む |
| BP Worker の停止 | 操作（承認など）は API で受け、状態は進む。タイマーとサービスのステップだけが遅れる。タイマーの遅れ 5 分で警告 |
| SQS の重複の配信 | 冪等キー（案件 ID＋ステップ＋`attempt`）で 2 回目は何もしない |
| 定義の誤り（有効化の後に分かった） | 前のバージョンの中身で新しいバージョンを作り、有効化する。進行中の案件は誤ったバージョンで進むので、人事が `reassign` かキャンセルで扱う。影響を受けた案件の一覧を出す |

## 14. セキュリティとプライバシー

- 起票・承認・取消・訂正・キャンセル・閲覧の権限は、業務プロセスの種類ごとの権限で判定する（[security-model.md](security-model.md) の 4.3 節）。担当に割り当てられただけでは、ドメインの権限を超えて項目を見られない。承認の画面の項目は、担当のドメインの権限で絞る。
- 起票者と承認者の分離、委任の後の実際の操作者での判定は、ルーティングと操作の時の 2 回確かめる（5.4 節、7 節）。
- `bp_events` は監査の正本の 1 つ。追記のみ（アプリのロールから `UPDATE`・`DELETE` を外す）。
- payload とイベントに個人情報が入る。案件の詳細の読み取りも、対象の facet のドメインの権限で絞る。コメントは別の表に置き、案件の閲覧の権限で読む。
- 定義の条件の式は、項目の参照を許可した名前空間（`case.*`・`subject.*`・`initiator.*`）に限る。マイナンバー・口座番号の項目は、式から参照できない。
- 通知に個人情報を入れない（10.3 節）。

## 15. テスト

### 15.1 決定表

- DT-BP-001（遷移）、DT-BP-002（除外）、DT-BP-003（取消・訂正の条件）、DT-BP-004（11.1 節の静的な検査）、DT-BP-005（委任の判定）を、`spec.md` から読む表駆動テストにする。
- 否定の表：DT-BP-001 にない（状態、操作）の組をすべて作り、拒否され、DB が変わらないことを確かめる。

### 15.2 性質ベーステスト

| ID | 性質 |
| --- | --- |
| PROP-BP-001 | 任意の起票・承認・差し戻し・却下・キャンセル・委任・担当の差し替え・タイマーの列で、案件の遷移は DT-BP-001 のとおりで、終端の案件は変わらない |
| PROP-BP-002 | 完了した案件の数と、差分を書いた案件の数が一致する（完了していない案件の差分はない） |
| PROP-BP-003 | どの完了した案件でも、起票者（実際の操作者と、代理で起票された人の両方）と承認者（同）が一致しない |
| PROP-BP-004 | 任意の操作を 2 回ずつ送り直した列でも、最後の状態と `bp_events` は同じ（冪等） |
| PROP-BP-005 | 案件は、起票の日に有効だった定義のバージョンで最後まで進む（途中の定義の有効化に影響されない） |
| PROP-BP-006 | 開いたステップごとに、`due` のタイマーはちょうど 1 つあり、閉じたステップには発火していないタイマーがない |
| PROP-BP-007 | 受信箱の開いた項目は、開いたステップの担当とちょうど一致する（委任を結んだ後の見え方も、今日の委任から一意に決まる） |
| PROP-BP-008 | 静的な検査を通った任意の定義（生成した定義）で、任意の条件の値の組に対し、案件は `completion` か終端の状態に有限のステップで着く |

### 15.3 結合・障害注入

- 完了のトランザクションの途中で接続を切っても、案件の状態と人事のデータが食い違わない。
- 同じタスクを、委任した人と代理人が同時に承認しても、1 つだけが効く。
- BP Worker を止めて再開し、タイマーの追いつきで督促が重複しない。

## 16. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E4 | `bp-definition-schema` | 3 節の定義の形、式の木と評価器、種類ごとの payload のスキーマ |
| E4 | `bp-definition-versions` | 3.3 節のバージョンと選び方（PROP-BP-005） |
| E4 | `bp-case-state-machine` | 6 節の表、遷移、冪等、楽観ロック（DT-BP-001、PROP-BP-001・004） |
| E4 | `bp-completion-transaction` | 6.3 節。見ていたバージョンの確認、差分の書き込み（PROP-BP-002） |
| E4 | `bp-routing` | 5 節。担当の決め方、予備の担当、除外（DT-BP-002、PROP-BP-003） |
| E4 | `bp-delegation` | 7 節（DT-BP-005） |
| E4 | `bp-rescind-and-correct` | 8 節（DT-BP-003）。遡及の候補の通知 |
| E4 | `bp-parent-child-and-bulk` | 9 節。束の実行、`partially_applied` |
| E4 | `bp-deadlines-and-timers` | 10.1 節（PROP-BP-006） |
| E4 | `bp-inbox` | 10.2・10.3 節（PROP-BP-007）。画面は E5 |
| E4 | `bp-definition-validation-and-simulation` | 11.1・11.2 節（DT-BP-004、PROP-BP-008） |
| E4 | `bp-definition-activation` | 11.3 節。編集と有効化の分離 |
| E5 | `ui-inbox` | 受信箱の画面、まとめての承認（[self-service-ui.md](self-service-ui.md) の同じ名前の Story） |
| E12 | `load-test-suite` | 4 月の集中と休暇の申請のピークの負荷試験（[capacity.md](capacity.md) の 7 節の負荷試験と 1 つにした） |

## 17. 未解決の問い

### 決定

- **定義は JSON の宣言と式の木**。任意のグラフと任意のコードは書かせない。
- **案件は起票の日に有効な定義のバージョンに固定する。子の案件は親の起票の日で選ぶ**。発令の日（`effective_on`）では選ばない。
- **訂正の案件の承認の流れは、今有効な定義の方針で決める**。
- **委任の期間中は、期間の前から開いているタスクも代理人が操作できる**。本家の資料の食い違い（2 節）は未検証のまま、この決定で進める。
- **権限は委任した人で、職務分掌と本人の除外は実際の操作者と委任した人の両方で判定する**。
- **承認の自動の処理（期限切れでの承認・却下）は持たない**。エスカレーションは担当の上長を足す 1 段まで。
- **雇用に確定した給与がある入社の取消は拒み、退職で扱う**。
- **差し戻しは 1 案件 5 回まで**。
- **通知の本文に個人情報を入れない**。
- **営業日の暦（`business_calendars`）は給与の領域が持ち、期限の計算で共有する**（[payroll-engine.md](payroll-engine.md) の 3.2 節、[ADR-0026](../decisions/0026-payroll-run-stages-and-input-snapshot.md)）。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| 外部のシステムの応答を待つステップ（電子申請の結果など） | 電子申請の Epic（E14）で ADR にする（[ADR-0003](../decisions/0003-business-process-engine.md) の Consequences） |
| テナントが業務プロセスの種類を足すこと | MVP の後。需要を見て |
| 担当の自動の付け替え（組織が変わったとき） | E4 の後、`reassign` の件数を見て決める |
| 受信箱のまとめての承認で、給与の変更の額を一覧で見せるか | E5 で PM と利用者の試験で決める |

## 18. quality.md・runbooks・data-model への項目

### quality.md

- 案件の種類ごとの、起票から完了までの時間の分布と、期限を過ぎたステップの割合。
- `ROUTING_FALLBACK`・`stuck`・`STALE_BASIS` の件数（定義と組織の設定の質の指標）。
- 承認なしの訂正の件数（監査の報告）。
- 委任による操作の割合。
- 定義の有効化の件数と、有効化の後に前のバージョンに戻した件数。
- 完了の案件と差分の件数の突き合わせの不一致（目標 0）。

### runbooks

- `bp-stuck-steps.md`：`stuck` のステップの確かめ方（組織のロールの空き、予備のグループ）と、`reassign` の手順。
- `bp-timer-lag.md`：タイマーの遅れの確かめ方と BP Worker の増やし方。
- `bp-bad-definition-rollback.md`：誤った定義を有効化したときの、前のバージョンへの戻し方と、影響を受けた案件の一覧。
- `bp-partial-bulk.md`：一括の親の案件が `partially_applied` のときの対応。

### data-model（索引への追加の提案）

| 置き場所 | 中身 |
| --- | --- |
| Aurora `bp_definitions` | 3.3 節 |
| Aurora `bp_cases`、`bp_steps`、`bp_step_assignees` | 6.1 節 |
| Aurora `bp_events` | 追記のみ。`recorded_at` の月ごとのパーティション |
| Aurora `bp_commands` | 冪等（30 日） |
| Aurora `bp_timers` | 10.1 節 |
| Aurora `bp_delegations` | 7 節 |
| Aurora `inbox_items` | 10.2 節 |
| outbox の事象 `bp.case_completed`・`bp.step_opened`・`bp.notification_requested` | 6.3・10.3 節 |

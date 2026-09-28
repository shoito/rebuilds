# Data model: Workday

データモデルの索引。**各テーブルの定義の正本は、下の索引の「定義の場所」にある文書**で、ここは置き場所・横断の規則・テナントの外の表・全領域の表の索引を書く。実装の変更（`changes/`）でマイグレーションを書くときに、ここと各文書を合わせて更新する。

各領域の文書の「data-model への項目」を集め、統合の工程（2026-09-28）で、名前の重なりと規則の食い違いを解消した（6 節）。表の列の定義は各領域の文書にあり、ここには写さない。

前提の決定：有効日付の 3 つのテーブル（[ADR-0002](../decisions/0002-effective-dated-data-model.md)、[ADR-0006](../decisions/0006-temporal-table-triplet-and-fold.md)）、共有スキーマと RLS（[ADR-0005](../decisions/0005-security-and-my-number.md)）、保管庫は別のアカウント（[ADR-0054](../decisions/0054-accounts-network-and-vault-boundary.md)）、個人情報の区分（[ADR-0051](../decisions/0051-threat-model-and-pii-classification.md)）、保存の期間の規則表（[ADR-0049](../decisions/0049-retention-rules-table-and-legal-hold.md)）。

## 1. 置き場所

| 置き場所 | 中身 |
| --- | --- |
| Aurora PostgreSQL 18（人事。prod。東京が主、大阪は Global Database の二次） | 唯一の正本。有効日付の facet、業務プロセス、勤怠、休暇、給与の実行と結果、支払、仕訳、権限、監査（13 か月）、規則表、outbox |
| Aurora PostgreSQL 18（保管庫。vault-prod） | マイナンバーの本体、本人確認、担当者、書類の索引、アクセスの記録、削除の記録 |
| Valkey | セッションのキャッシュ、権限の表のキャッシュ、レート制限。失ってよい |
| S3（prod） | 給与の入力の文書・結果の束、明細、振込ファイル、レポートの出力、取り込みのファイル、SPA の資産 |
| S3（vault-prod） | 保管庫の書類、本人確認の画像（Object Lock なし） |
| S3（log-archive、Object Lock） | 監査のセグメントと日の署名、保管庫の記録、規則表の元のファイル、CloudTrail・Config・アプリのログ |
| S3（S2。分析用の基盤） | Iceberg の表（[reporting.md](reporting.md) の 6.2 節） |
| ECR | Payroll Compute のエンジンのイメージ（給与の保存の期間の間消さない） |
| ブラウザ IndexedDB | 未送信の打刻（`pending_clock_events`） |

## 2. 横断の規則

- **テナントテーブルは `tenant_id` を持ち、主キーとインデックスの先頭に置く。** ID は UUIDv7。`FORCE ROW LEVEL SECURITY` と、トランザクションごとの `SET LOCAL app.tenant_id`（[ADR-0005](../decisions/0005-security-and-my-number.md)）。保管庫の Aurora も同じ規則。例外は 3 節の表だけで、マイグレーションの CI の許可リストと一致させる。
- **外部キーは `tenant_id` を含む複合キーにする。** 有効日付の参照は `PERIOD` の外部キー（[ADR-0006](../decisions/0006-temporal-table-triplet-and-fold.md)）。
- **有効日付のデータは facet ごとに `<facet>_changes`・`<facet>_versions`・`<facet>` の 3 つ**を `FacetSpec` から生成する。現在のテーブルは書き込みの専用の経路だけが書く。
- **追記のみの表**（アプリのロールに `UPDATE`・`DELETE` を与えない）：有効日付の差分と版（印の埋め込みを除く）、`bp_events`、`time_clock_events`、`time_clock_corrections`、`leave_grants`、`leave_ledger_entries`、`payroll_results`・`payroll_result_lines`（確定の後）、`payroll_journal_entries`・`payroll_journal_lines`、`payslip_delivery_consents`、`payslip_paper_requests`、`wage_payment_consents`、`audit_events`、`platform_audit_events`、保管庫の `mn_access_log`・`mn_deletions`。削除は保存の期間の `retention_purger` だけ（[ADR-0049](../decisions/0049-retention-rules-table-and-legal-hold.md)）。
- **列ごとに個人情報の区分（`pii_class`：P0〜P4）を注記する。** 区分のない列を CI で拒む。P4（個人番号）は保管庫の外の列に置かない（[ADR-0051](../decisions/0051-threat-model-and-pii-classification.md)）。
- **金額は `bigint` の円、率は 10 進の固定小数点（小数 10 桁）**（[ADR-0001](../decisions/0001-platform-and-stack.md)、[ADR-0027](../decisions/0027-pay-item-graph-and-formula-language.md)）。`numeric` の自由な精度や `double precision` を金額に使わない。
- **暗号文の列**：口座番号は `*_ct`（例：`account_number_ct`。テナントの鍵の DEK、AAD に `tenant_id` と行の ID）。重複の検知は `*_hmac`（例：`account_hmac`。テナントの HMAC の鍵。[security.md](security.md) の THR-022）。
- **保存の期間**：表ごとに `retention_rules` のデータの種類を割り当てる（4 節の「保存」の列）。時間で並ぶ表は月ごとのパーティション。
- **DB のロール**：

  | ロール | 使うサービス | 権限 |
  | --- | --- | --- |
  | `migrator` | マイグレーション | 所有者。`BYPASSRLS`（`pay_items` のシステムの行などを書く） |
  | `temporal_owner` | 有効日付の書き込みの関数（`temporal.apply_fold` など） | 差分・版の印の埋め込みと現在のテーブルの差し替えだけ。関数の方式か専用のロールかは E1 の PoC で決める（6 節の残り） |
  | `app` | api、worker、bp-worker、loader | RLS の対象。`BYPASSRLS` なし。有効日付の書き込みの関数の実行 |
  | `report_app` | report-service（レポートの reader） | 読み取りだけ。RLS の対象。`statement_timeout` |
  | `relay` | Relay | outbox の読み取りと送信済みの印だけ |
  | `audit_archiver` | audit-archiver | `audit_events`・`bp_events` などの読み取り、`audit_segments` への追記 |
  | `retention_purger` | 保存の期間の削除のジョブ | 追記のみの表の `DELETE`（実行の記録のあるトランザクションだけ） |
  | `platform` | テナントの作成・削除、規則表の公開、課金の集計 | RLS を迂回できる。操作はプラットフォームの監査へ |
  | `vault_app`（保管庫） | vault-api、vault-docgen | 保管庫の Aurora。RLS の対象 |

## 3. RLS の例外（テナントの外の表）

RLS を掛けない表と、一部だけ例外にする表の全部。**ここにない表は、すべて `tenant_id` と FORCE RLS を持つ。** マイグレーションの CI の許可リストは、この表と一致させる。行の追加は `security:sensitive` で、理由を書く。

| テーブル | 例外の形 | RLS の外に置く理由 | 書ける主体 | 定義の場所 |
| --- | --- | --- | --- | --- |
| `tenants`、`tenant_hostnames`、`tenant_keys`、`tenant_directory`（S2） | 全体 | テナントの解決の前に読む | `platform` | [security.md](security.md) の 5.2 節、[infrastructure.md](infrastructure.md) の 8 節 |
| `rule_tables`、`rule_rows_*` | 全体 | 全テナントに共通の規則表 | `platform`（公開の手順。`rules.publish`） | [payroll-jp-rules.md](payroll-jp-rules.md) の 2.1 節 |
| `retention_rules` | 全体 | 全テナントに共通の保存の規則 | `platform` | [audit-and-retention.md](audit-and-retention.md) の 5.1 節 |
| `report_sources` | 全体 | システムのデータの元の定義 | `migrator` | [reporting.md](reporting.md) の 4.1 節 |
| `platform_audit_events` | 全体 | テナントをまたぐ運用の記録 | `app`（追記）、`platform` | [audit-and-retention.md](audit-and-retention.md) の 3 節 |
| `auth_accounts`、`auth_identities`、`auth_sessions`、`sso_providers`（Better Auth） | 全体 | 3.2 節（DM-3） | `app`（`packages/auth` の Better Auth の経路だけ） | [integrations-and-bulk.md](integrations-and-bulk.md) の 7 節 |
| `pay_items` | **部分**（`tenant_id IS NULL` のシステムの行を、全テナントが読むだけ） | 3.1 節（DM-2） | システムの行は `migrator`。テナントの行は `app` | [payroll-engine.md](payroll-engine.md) の 6.1 節 |
| `mn_purposes`（保管庫） | 全体 | システムの目的の表 | `migrator` | [my-number-vault.md](my-number-vault.md) の 6.3 節 |

- CI は、`tenant_id` のない表、RLS のない表、`tenant_id IS NULL` を含むポリシーを、この表にあるものだけに許す。

### 3.1 `pay_items` のシステムの行（DM-2）

法定の項目（源泉所得税、社会保険料など）はシステムの行（`tenant_id IS NULL`、`owner = system`）、テナントの項目はテナントの行として、同じ表に置く。

```sql
ALTER TABLE pay_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE pay_items FORCE ROW LEVEL SECURITY;
-- Read: own tenant rows + system rows.
CREATE POLICY pay_items_read ON pay_items FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id')::uuid OR tenant_id IS NULL);
-- Write: own tenant rows only. System rows are written by migrator (BYPASSRLS) in migrations.
CREATE POLICY pay_items_write ON pay_items FOR ALL
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
```

- 別の表（`system_pay_items`）に分けない。項目の依存のグラフ、`pay_item_sets`、結果の行（`payroll_result_lines.item_code`・`item_version`）が、システムとテナントの項目を同じ形で指すため。分けると、参照と版の検査を 2 つの表の和で書くことになる。
- システムの項目のコードは `jp.` の接頭辞を持ち、テナントはこの接頭辞のコードを作れない（`CHECK`）。テナントの項目がシステムの項目を隠すことはない。
- システムの行の変更は、エンジンのリリース（マイグレーション）で行う。テナントは式を変えられない（[ADR-0027](../decisions/0027-pay-item-graph-and-formula-language.md)）。

### 3.2 Better Auth の表（DM-3）

ログインのアカウント・外部の ID・セッション・SSO の接続の表は、テナントの外に置く。

- **理由**：
  - セッションの読み取りは、要求ごとに、テナントのコンテキストを決める前に行う（セッション → テナント → `SET LOCAL`）。RLS の中に置くと、コンテキストのない読み取りが要る。
  - Better Auth のアダプターは、問い合わせごとに `app.tenant_id` を設定しない。RLS の中に置くには、ライブラリのアダプターを手で直すことになり、版の固定と脆弱性の修正の取り込み（[security.md](security.md) の 9 節）が重くなる。
  - グループの会社を別のテナントにしたとき、同じ人が 1 つのアカウント（パスキー、メール）で複数のテナントに入れる。Slack の題材も同じくアカウントをテナントの外に置いた。
- **補う統制**：
  - これらの表に人事のデータを置かない。`auth_accounts` はログインの識別子（メール、パスキーの資格情報の ID）だけ。人との結びは `worker_accounts`（テナントの中、RLS）。
  - `auth_sessions` と `sso_providers` は `tenant_id` の列を持つ。API は、セッションのテナントとホスト名のテナントが一致しなければ拒む（THR-002）。
  - 読み書きは `packages/auth`（Better Auth の経路）だけ。他のパッケージからこれらの表を読むコードを lint で禁じる。
  - SSO の接続の秘密は、テナントの鍵のエンベロープ暗号化で持つ（[security.md](security.md) の 6 節）。
- テナントの中に置く案は、上の理由で採らない。S3 のセル構成では、表はセルごとに持ち、テナントとアカウントを同じセルに置く（[infrastructure.md](infrastructure.md) の 9 節）。

## 4. 索引

「保存」はデータの種類（[audit-and-retention.md](audit-and-retention.md) の 5.2 節の行）。「区分」は最も重い列の個人情報の区分。

### 4.1 有効日付の共通の仕組み（[object-model-and-effective-dating.md](object-model-and-effective-dating.md)）

| テーブル | 形 | 区分 | 保存 |
| --- | --- | --- | --- |
| `<facet>_changes`、`<facet>_versions`、`<facet>` | 3 つの組。追記のみ（印を除く）。版は GiST (`tenant_id`, `subject_id`, `valid`, `known`) | facet による | facet の主体のデータの種類 |
| `temporal_activations` | 発効の予定 | P0 | 1 年（運用の記録） |
| outbox の事象 `temporal.changed`・`temporal.retro_detected` | outbox | P0 | 送信の後に削除 |

### 4.2 Core HR（[core-hr.md](core-hr.md)）

| テーブル | 形 | 区分 | 保存 |
| --- | --- | --- | --- |
| `workers`、`employments`、`job_assignments` | 変わらない属性。`employee_number` はテナントで一意 | P1 | 労働者名簿 |
| facet：`worker_personal`（`mn_ref`・`mn_status` を含む）、`worker_address`、`worker_contact`、`worker_dependents`（`mn_ref`・`mn_status` を含む）、`worker_emergency_contacts` | 人の単位 | P2 | 労働者名簿、退職者の facet |
| facet：`employment_status`、`employment_contract`、`employment_primary_job`、`worker_compensation`、`worker_payment_election`（`account_number_ct`・`account_hmac`） | 雇用の単位 | P2 | 労働者名簿・賃金に関する書類 |
| facet：`worker_job` | 職務の割り当ての単位 | P1 | 労働者名簿 |
| facet：`organization`、`org_parent`、`position_detail`、`job_profile`、`grades`、`org_role_assignment` | 組織 | P0 | テナントの契約の間 |
| `org_closure` | 派生。`WITHOUT OVERLAPS` の主キー | P0 | 同上 |
| `organizations`、`positions` | 変わらない属性 | P0 | 同上 |
| `leave_of_absence_types`（休職の種類。DM-1）、`termination_reasons` | テナントの設定 | P0 | 同上 |

### 4.3 業務プロセス（[business-process-engine.md](business-process-engine.md)）

| テーブル | 形 | 区分 | 保存 |
| --- | --- | --- | --- |
| `bp_definitions` | 版 | P0 | 契約の間 |
| `bp_cases`、`bp_steps`、`bp_step_assignees` | 状態 | P1（payload は種類による） | 案件の対象のデータの種類 |
| `bp_events` | 追記のみ。月ごとのパーティション | 同上 | 監査ログ |
| `bp_commands` | 冪等（30 日） | P0 | 30 日 |
| `bp_timers`、`bp_delegations`、`inbox_items` | — | P0 | 1 年 |

### 4.4 権限（[security-model.md](security-model.md)）

| テーブル | 形 | 区分 | 保存 |
| --- | --- | --- | --- |
| `security_policy_versions` | 版。有効化した版は書き換えない | P0 | 監査ログ |
| `security_groups`、`security_group_members` | 所属は有効日付 | P0 | 同上 |
| `security_effective_grants` | 派生 | P0 | — |
| `sod_rules`（方針の版の一部）、`sod_violations` | — | P0 | 監査ログ |
| `proxy_sessions` | — | P0 | 監査ログ |
| Valkey `authz:{tenant}:{worker}:{policy_version}:{membership_version}` | キャッシュ | P0 | 失ってよい |

### 4.5 勤怠（[time-and-attendance.md](time-and-attendance.md)）

| テーブル | 形 | 区分 | 保存 |
| --- | --- | --- | --- |
| `time_clock_events` | 追記のみ。月ごとのパーティション | P2 | 賃金その他労働関係に関する重要な書類 |
| `time_clock_corrections`、`time_objective_logs`、`time_divergences` | — | P2 | 同上 |
| `work_rules`（版）、facet `employment_work_rule`、`shift_patterns`、`shift_assignments` | — | P1 | 同上 |
| `work_day_results` | 版の追記 | P2 | 同上 |
| facet `overtime_agreements`、`overtime_alerts` | — | P1 | 36 協定の記録 |
| `time_periods`、`time_period_summaries` | 集計の版とハッシュ | P2 | 賃金その他… |

### 4.6 休暇（[absence-and-leave.md](absence-and-leave.md)）

| テーブル | 形 | 区分 | 保存 |
| --- | --- | --- | --- |
| `leave_types`（休暇の種類）、`leave_grant_policies`（版） | テナントの設定 | P0 | 契約の間 |
| `leave_grants`、`leave_ledger_entries` | 追記のみ | P2 | 年次有給休暇管理簿 |
| `leave_balances` | 派生 | P2 | — |
| `annual_leave_obligations`、`annual_leave_register`（ビュー） | — | P2 | 年次有給休暇管理簿 |
| `time_off_requests` | 業務プロセスの案件の中身 | P2 | 同上 |

### 4.7 給与の計算（[payroll-engine.md](payroll-engine.md)、[payroll-jp-rules.md](payroll-jp-rules.md)）

| テーブル | 形 | 区分 | 保存 |
| --- | --- | --- | --- |
| `pay_groups`、`pay_periods`、facet `employment_pay_group`、`business_calendars` | — | P0 | 給与の入力・結果 |
| `payroll_runs`、`payroll_inputs`、`payroll_chunks` | — | P0 | 同上 |
| `pay_items`、`pay_item_sets`（版） | システムの行（`tenant_id IS NULL`）は 3.1 節 | P0 | 同上 |
| `payroll_results`、`payroll_result_lines` | 確定の後は書き換えない。月ごとのパーティション | P2 | 給与の入力・結果（既定 7 年） |
| `retro_candidates` | — | P1 | 同上 |
| `legacy_payroll_results`、`legacy_item_map`、`parallel_diffs` | 並行稼働 | P2 | 本番の開始から 1 年（DM-4） |
| `parallel_run_gates` | 切り替えの判定。額を持たない | P0 | 監査ログ（DM-4） |
| `rule_tables`、`rule_rows_*`（テナントの外）、`tenant_rule_tables` | 版 | P0 | 給与の入力・結果 |
| facet `worker_tax_profile`、`worker_social_insurance`、`worker_employment_insurance` | — | P2 | 扶養控除等申告書・社会保険の書類 |
| `company_payroll_settings`（版） | — | P0 | 給与の入力・結果 |
| `resident_tax_notices` | — | P2 | 住民税の通知（7 年。DM-4） |
| `si_revision_candidates`、`si_regular_determinations` | — | P2 | 健康保険・厚生年金の書類 |
| S3 `payroll-inputs/{tenant}/{sha256}.json`、`payroll-results/{run}/{chunk}.jsonl` | 内容のアドレス。テナントの鍵 | P2 | 給与の入力・結果 |
| S3（Object Lock）`rule-sources/{kind}/{sha256}` | 元のファイル | P0 | 給与の入力・結果 |
| ECR のエンジンのイメージ | ダイジェストで結果から引く | P0 | 給与の入力・結果（消さない） |

### 4.8 支払と会計（[payments-and-accounting.md](payments-and-accounting.md)）

| テーブル | 形 | 区分 | 保存 |
| --- | --- | --- | --- |
| `payer_accounts`、`wage_payment_consents` | 同意は追記のみ | P2 | 賃金に関する書類 |
| `payment_instructions`、`bank_files` | 口座は暗号文 | P2 | 振込ファイル |
| `payslips`、`payslip_delivery_consents`、`payslip_paper_requests` | — | P2 | 給与明細 |
| `wage_ledger`（ビュー） | 射影 | P2 | 賃金台帳 |
| `gl_account_maps`（版）、`payroll_journal_entries`、`payroll_journal_lines`、`gl_export_batches`、`si_premium_notices` | 追記のみ。遅延制約で釣り合い | P0（従業員の ID を持たない） | 給与の仕訳 |
| S3 `bank-files/{tenant}/{file_id}`（`<brand>-bank-files` の鍵）、`payslips/{tenant}/{id}.json|.pdf`、`gl-exports/{tenant}/{seq}.csv` | 大阪へ複製 | P2 | 各行 |

### 4.9 セルフサービス（[self-service-ui.md](self-service-ui.md)）

| テーブル | 形 | 区分 | 保存 |
| --- | --- | --- | --- |
| `user_preferences` | — | P1 | 雇用の終わりまで |
| `ui_task_timings` | 個人を特定しない集計 | P0 | 2 年 |
| S3 `web-assets/{version}/` | SPA の静的な資産 | P0 | 版ごと（前の版を戻しのために残す） |

### 4.10 レポート（[reporting.md](reporting.md)）

| テーブル | 形 | 区分 | 保存 |
| --- | --- | --- | --- |
| `report_sources`（テナントの外）、`report_definitions`（版） | — | P0 | 契約の間 |
| `report_runs` | 値を持たない | P0 | 監査ログ |
| S3 `report-outputs/{tenant}/{run_id}` | — | P2 | 7 日 |

### 4.11 連携（[integrations-and-bulk.md](integrations-and-bulk.md)）

| テーブル | 形 | 区分 | 保存 |
| --- | --- | --- | --- |
| `bulk_import_batches`、`bulk_import_rows` | 値を持たない | P0 | 1 年 |
| `migration_runs`、`payroll_ytd_opening`、`overtime_ytd_opening` | 期首の値 | P2 | 給与の入力・結果 |
| `legacy_time_summaries` | 並行稼働 | P2 | 本番の開始から 1 年（DM-4） |
| `api_clients`、`integration_users`、`api_idempotency_keys`、`webhook_endpoints`、`webhook_deliveries` | — | P0 | 契約の間（冪等は 24 時間） |
| `auth_accounts`、`auth_identities`、`auth_sessions`、`sso_providers`（テナントの外。3.2 節）、`worker_accounts` | Better Auth | P1 | 雇用の終わりまで＋監査 |
| `clock_terminals`、`terminal_badges`、`unmatched_clock_events` | — | P1 | 賃金その他… |
| S3 `import-files/{tenant}/{batch_id}`、`export-files/{tenant}/{run_id}` | — | P2 | 30 日・7 日 |

### 4.12 マイナンバーの保管庫（[my-number-vault.md](my-number-vault.md)。vault-prod）

| テーブル | 形 | 区分 | 保存 |
| --- | --- | --- | --- |
| `mn_records`、`mn_verifications` | エンベロープ暗号化、HMAC | P4 | [my-number-vault.md](my-number-vault.md) の 10 節 |
| `mn_handlers`、`mn_purposes`（システム）、`mn_purpose_notices` | — | P1 | 監査ログ |
| `mn_documents` | 書類の索引 | P0（書類そのものは S3 で P4） | 書類の種類ごと |
| `mn_access_log` | 追記のみ。ハッシュの連鎖。番号を含まない | P1 | 監査ログ |
| `mn_deletions`、`mn_deletion_candidates`、`mn_legal_holds` | 番号を含まない | P1 | 監査ログ |
| S3 `docs/{tenant}/{document_id}`、`verification-images/{tenant}/{id}` | `vault-docs` の鍵。Object Lock なし | P4 | 書類の種類ごと、画像は 30 日 |
| 人事の側 `mn_handler_designations` | 業務プロセスの中身 | P1 | 監査ログ |

### 4.13 監査と保存（[audit-and-retention.md](audit-and-retention.md)）

| テーブル | 形 | 区分 | 保存 |
| --- | --- | --- | --- |
| `audit_events` | 追記のみ。月ごとのパーティション。Aurora に 13 か月 | P1（値を持たない） | 監査ログ |
| `platform_audit_events`（テナントの外） | 同上 | P1 | 監査ログ |
| `audit_segments` | セグメントのハッシュの控え | P0 | 監査ログ |
| `retention_rules`（テナントの外）、`tenant_retention_overrides`、`legal_holds`、`retention_executions` | — | P0 | 監査ログ |
| S3（log-archive）`audit/{tenant}/...`、`anchors/{date}.json`、`vault-audit/{tenant}/...` | Object Lock コンプライアンス | P1 | 監査ログ |

### 4.14 セキュリティ（[security.md](security.md)）

| テーブル | 形 | 区分 | 保存 |
| --- | --- | --- | --- |
| `support_access_grants` | テナントの管理者の許可（期限、ドメイン） | P0 | 監査ログ |
| `tenant_keys`（テナントの外） | テナントの KMS の鍵の ARN と状態。S2 からは、セルの鍵で包んだテナントの DEK と破棄の記録も持つ（[security.md](security.md) の 5.3 節） | P0 | テナントの削除の後も記録（包んだ DEK は破棄で消す） |

## 5. outbox の事象（主なもの）

| 事象 | 出す領域 | 受ける領域 |
| --- | --- | --- |
| `temporal.changed`、`temporal.retro_detected` | 有効日付 | 給与（遡及の候補）、休暇（付与の再判定）、勤怠（36 協定の事業場）、権限（キャッシュ）、分析用の書き出し（S2） |
| `bp.case_completed`、`bp.step_opened`、`bp.notification_requested` | 業務プロセス | 通知、Webhook、保管庫（担当者の指定） |
| `time.summary_superseded` | 勤怠 | 給与（遡及の候補） |
| `absence.retro_changed` | 休暇 | 給与（遡及の候補） |
| `payroll.adjustment_retro` | 給与（個別の調整） | 給与（遡及の候補） |
| `rule_table.corrected` | 規則表 | 給与（遡及の候補） |
| `payroll.run_state_changed` | 給与 | 支払、仕訳、Webhook、里程標の記録 |
| `mn.handler_designated` | 業務プロセス（`mn_handler_designation`） | 保管庫（署名つき。`mn_handlers` へ） |

## 6. 統合で決めたこと（2026-09-28）

各領域の文書の間で見つけた重なりと食い違いを、既定案で決めた。各領域の文書も合わせて直した。

| # | 論点 | 決定 |
| --- | --- | --- |
| DM-1 | `leave_types` の名前が 2 つの領域で別の意味だった（[core-hr.md](core-hr.md) は休職の種類、[absence-and-leave.md](absence-and-leave.md) は休暇の種類） | core-hr の休職の種類を `leave_of_absence_types` に改名した。`leave_types` は休暇の種類だけを指す（[ADR-0025](../decisions/0025-special-leave-and-leave-of-absence-boundary.md) の境界と同じ） |
| DM-2 | `pay_items` がシステムの行（`tenant_id` が空）とテナントの行を同じ表に持つ | 同じ表のまま、3 節の表に「部分の例外」として載せ、読み取りだけを `tenant_id IS NULL` まで広げる RLS のポリシーにした（3.1 節）。システムの行を書くのは `migrator` だけ。コードの接頭辞でテナントの項目と分ける |
| DM-3 | Better Auth の表をテナントの外に置くか | テナントの外に置く（3.2 節）。セッションの読み取りがテナントの解決の前に要ること、ライブラリのアダプターが RLS のコンテキストを設定しないこと、グループの会社の複数のテナントに 1 つのアカウントで入れること。人事のデータを置かず、`tenant_id` の照合と経路の lint で補う |
| DM-4 | `resident_tax_notices`、並行稼働の表、`legacy_*` の保存の期間 | 住民税の通知は 7 年（源泉徴収簿に準じる）、並行稼働の現行の結果・対応表・差は本番の開始から 1 年、切り替えの判定は監査ログと同じ 10 年。[audit-and-retention.md](audit-and-retention.md) の 5.2 節の規則表に行を足した（確認待ちの L5・L11・L42・L52） |
| DM-5 | 退職者を見られる期間（[security-model.md](security-model.md) の DT-SEC-001 の 3 年）と、保存の期間の既定（5 年）が食い違って見えた | 保存と閲覧を分ける。人事の担当は、機微でないドメインを保存の期間（既定 5 年）の間ずっと見られる。機微なドメインは退職から 3 年を過ぎたら、`all` の範囲の権限か `audit` だけで見られる（DT-SEC-001 の #1）。3 年は経過措置と賃金の請求権の時効に、5 年は確認待ちの間は長いほうで持つ規則に合わせた。理由は [security-model.md](security-model.md) の 4.2 節 |
| DM-6 | 口座の重複の検知の HMAC（[security.md](security.md) の THR-022）の置き場所 | `worker_payment_election` に `account_hmac` を足した（[core-hr.md](core-hr.md) の 3.3 節） |
| DM-7 | 各表の `pii_class` の注記の一覧 | 一覧はこの文書に写さない。マイグレーションの注記を正本にし、E1 の `migration-ci-guards`（[roadmap.md](../roadmap.md)）で CI の検査と一緒に作る。各表の「区分」の列は、最も重い列の区分の目安 |

その他に揃えたもの：

- 暗号文と HMAC の列の名前を `*_ct`・`*_hmac` に揃えた（2 節）。
- outbox の事象に、休暇の遡及（`absence.retro_changed`）、個別の調整の遡及（`payroll.adjustment_retro`）、事務取扱担当者の指定（`mn.handler_designated`）を足した（5 節。[payroll-engine.md](payroll-engine.md) の 7.1 節、[my-number-vault.md](my-number-vault.md) の 6.3 節）。

残り（マイグレーションを書く Story で確かめる）：

- すべてのテナントの表に RLS があり、3 節の例外が網羅されていることを、マイグレーションの CI の許可リストと照合する（E1）。
- 有効日付の書き込みを関数だけに限る方式（`SECURITY DEFINER` か専用のロール）は、E1 の `temporal-constraints-poc` で決める（[object-model-and-effective-dating.md](object-model-and-effective-dating.md) の 4 節）。決まったら 2 節の `temporal_owner` の行を直す。
- 版と差分の表のパーティションの時期（S2 の前の計測）。

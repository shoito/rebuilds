# Roadmap: Workday

## 進め方の原則

- **最初に walking skeleton を通す。** E1〜E4 で、Aurora と RLS、`packages/money`、`packages/temporal` の 3 つのテーブルの生成と畳み込み、業務プロセスの完了のトランザクション、権限の判定を端から端まで貫き、「1 人を入社させ、将来日付の異動を起票・承認し、時点を変えて見る」ところまで作ってから、機能を広げる。有効日付の参照のモデル、ゴールデンデータセットの CI の枠、RLS とマイグレーションの検査、個人情報の走査は、E1・E2 から本物の形で作る。後から足すと直せないため。
- **PoC を先に済ませる。** 次の PoC は、それぞれの Epic の Story の spec を承認する前に結果を記録する：Aurora PostgreSQL 18 の時間の制約と RLS と書き込みの関数の権限（E1 の `temporal-constraints-poc`。[ADR-0006](decisions/0006-temporal-table-triplet-and-fold.md)）、1 人・1 facet の畳み込みの時間（E2）、打刻機の機種と形式（E6 の前）、PDF のライブラリ（E10 の `payslip-pdf`）、Payroll Compute の束の大きさとタスクの数（E12 の負荷試験で決め直す）。
- **正解を実装と独立に持つ。** 給与の期待値はゴールデンデータセット（社労士・税理士か公的な資料で確かめたもの）、有効日付の正解は参照のモデル、規則は `spec.md` の決定表。エージェントは期待値と決定表を実装に合わせて変えない（[ADR-0061](decisions/0061-golden-dataset-ci.md)）。
- **法令の値はコードでなく規則表で届ける。** 規則表のリリースはコードのリリースと別にし、改正の暦で動かす（[ADR-0062](decisions/0062-rule-table-release-calendar.md)）。
- **法務・社労士・税理士の確認待ちの Story は、spec を承認しない。** 設計と、確認に依らない Story は進めてよい（[intent.md](intent.md) の L1〜L58）。下の表で「確認：L*」と書いた Story が当たる。
- **1 変更 1 PR を目安に、差分を小さくする。** 給与の経路の変更は、支給日の前の凍結の日を避けて出す（[ADR-0063](decisions/0063-payroll-flags-pinning-and-freeze-windows.md)）。

## Epic

PM が持つ。変更の一覧はここに書かず、各変更の `spec.md` の frontmatter（`epic`）から集計する（[process.md](../../../docs/process.md) の「粒度」）。各 Epic の品質の重点と合否基準は [quality.md](quality.md) の 5 節にある。

| Epic | 目的 | 状態 |
| --- | --- | --- |
| E1 基盤 | AWS・Terraform・CI（決定表・性質・ゴールデンデータの枠・給与の lint・マイグレーションの検査）、Aurora と RLS、KMS、フラグ、可観測性と個人情報の走査、監査ログの骨格、`packages/money`、時間の制約の PoC | 設計中 |
| E2 オブジェクトモデルと有効日付 | `packages/temporal`、3 つのテーブルの生成、畳み込みと同じ日の順序、訂正と取消の依存、時点の問い合わせ、発効のタイマー、遡及の事象、夜間の整合の検査 | 未着手（前に E1 の時間の制約の PoC） |
| E3 Core HR | 組織と階層の閉包、ポジションと職務、人・雇用・職務、入社・異動・休職・復職・退職と法令の警告、個人の情報、外部の人、組織の再編 | 未着手（退職の警告の境界は確認：L12・L13、入社の書面は L14、外部の人は L15） |
| E4 業務プロセスと権限 | 定義と版、状態機械、ルーティングと除外、委任、取消・訂正、期限と受信箱、定義の検証と有効化、ドメインと業務プロセスの権限、セキュリティグループ、職務分掌、方針の版 | 未着手 |
| E5 セルフサービスとログイン | 画面の殻、時点の見せ方、変更の申請、受信箱の画面、マネージャーの画面、画面の計測、Better Auth・パスキー・SSO | 未着手 |
| E6 勤怠 | 打刻（オフライン、打刻機）、訂正、客観的な記録、勤務体系、労働時間の計算、36 協定の警告、月次の締めと給与への連携 | 未着手（前に打刻機の選定。36 協定・区分の一部は確認：L6・L17〜L22・L43） |
| E7 休暇 | 年休の付与と台帳、出勤率、斉一的付与、時効、半日・時間単位、年 5 日の義務、管理簿、特別休暇、休暇の申請 | 未着手（確認：L7・L23〜L27） |
| E8 月次の給与計算 | 給与のグループと暦、実行と入力の固定、項目のグラフと式、結果、計算の分割、確認の検査、規則表の取り込みとリリース、源泉所得税・社会保険料・雇用保険料・住民税・割増賃金・日割り、ゴールデンデータセット、再現の抜き取り、合成の給与の実行、凍結 | 未着手（前に一次の資料の確認。確認：L8・L31〜L33・L35〜L37） |
| E9 賞与・遡及・並行稼働 | 遡及の差額、賞与と臨時の実行、随時改定と定時決定、並行稼働の取り込みと比較、年休の残りの移行 | 未着手（確認：L11・L28〜L30・L34・L42） |
| E10 支払と会計 | 振込先の配分と同意、支払の指示、全銀協の形式のファイル、承認と取り出し、明細と電子交付、賃金台帳、仕訳と出力、大阪での作り直しの確認 | 未着手（確認：L3・L4・L9・L38〜L40・L58） |
| E11 マイナンバーと監査 | 保管庫のアカウントと API、収集と本人確認、担当者、アクセスの記録、書類の生成、削除、監査の連鎖、保存の期間の規則表と保全、監査人の画面、閲覧の記録と説明の報告、代理のログイン | 未着手（保管庫の本番の利用は確認：L1、削除は L2・L48・L50、収集は L44〜L46） |
| E12 レポート・連携・本番の準備 | 時点のレポートと抑止、法定の帳簿、組織図、一括の取り込み・出力、移行、公開の API と Webhook、電子帳簿保存法、負荷試験、DR の訓練、ペンテスト、GA の判定 | 未着手（GA の判定は確認：L10・L49・L56・L57） |
| E13 年末調整と法定調書（MVP の後） | 年末調整の計算と申告の画面、源泉徴収票・給与支払報告書（保管庫の中） | 未着手（MVP の後） |
| E14 電子申請（MVP の後） | 社会保険・雇用保険の届出の電子申請、住民税の特別徴収税額通知の電子の取り込みと異動届、法定調書の電子の提出 | 未着手（MVP の後） |
| E15 退職所得と退職金（MVP の後） | 退職所得の源泉徴収、退職金の計算 | 未着手（MVP の後） |
| E16 タレント管理（MVP の後） | 目標、評価、後継者の計画 | 未着手（MVP の後） |

E1〜E12 が MVP（S1）。領域の文書の「Story の候補」は、この番号で書く。

## Story

各 Story は、着手するときに `changes/YYMMDD-<slug>/` として起票する。ここは計画で、進み具合は各変更の `spec.md` の frontmatter で見る。順序は Epic の中での目安で、依存があるものを先に置いた。各領域の文書の「Story の候補」と「Epic との対応」から集めた。同じ中身の Story が 2 つの文書にあるものは 1 つにした（[architecture/README.md](architecture/README.md) の 6 節の「決定」）。

### E1 基盤

設計：[infrastructure.md](architecture/infrastructure.md)、[delivery.md](architecture/delivery.md)、[observability.md](architecture/observability.md)、[security.md](architecture/security.md)、[capacity.md](architecture/capacity.md)、[data-model.md](architecture/data-model.md)

| Story | 内容 |
| --- | --- |
| `dev-repo-bootstrap` | Workday の再構築の開発リポジトリを作り、`changes/`・`specs/`・開発向けの `AGENTS.md`、CODEOWNERS（[delivery.md](architecture/delivery.md) の 1.1 節の区分）、`.github/security-sensitive-paths.yml` を置く（リポジトリ共通の ADR-0005） |
| `aws-accounts-and-scp` | アカウント（prod、vault-prod、log-archive など）、OU、SCP（[infrastructure.md](architecture/infrastructure.md) の 1 節、[ADR-0054](decisions/0054-accounts-network-and-vault-boundary.md)） |
| `network-and-subnets` | prod の VPC（payroll・egress・isolated・vault-link のサブネット）、Network Firewall、VPC エンドポイント（同 2 節） |
| `terraform-layout-and-policy-checks` | ルートモジュールの分け方、状態ファイル、plan のポリシー検査（payroll の経路表、`vault-mn` の復号、KMS の削除の待ち、Object Lock。同 10 節） |
| `kms-keys-and-policies` | 用途ごとの KMS の鍵、キーポリシー、大阪のレプリカ、テナントの鍵の作成の処理（[ADR-0052](decisions/0052-kms-key-hierarchy.md)） |
| `ecs-services-baseline` | ECS のサービスの骨格（api、bp-worker、worker、relay、loader、egress-worker、audit-archiver）、ARM64、ログ、ADOT |
| `aurora-and-rls` | Aurora PostgreSQL 18、テナントの表と FORCE RLS、`SET LOCAL app.tenant_id`、DB のロール（[data-model.md](architecture/data-model.md) の 2 節） |
| `temporal-constraints-poc` | PoC：Aurora の実際の版で `WITHOUT OVERLAPS`・`PERIOD`・`btree_gist`・RLS の組み合わせ。書き込みの関数の権限の方式（[object-model-and-effective-dating.md](architecture/object-model-and-effective-dating.md) の 4 節） |
| `migration-ci-guards` | マイグレーションの CI：`tenant_id`・RLS・RLS の例外の許可リスト（data-model の 3 節）、列の `pii_class`（DM-7）、有効日付の 3 つのテーブル、追記のみの表の権限（[ADR-0051](decisions/0051-threat-model-and-pii-classification.md)） |
| `packages-money` | `Yen`・`Dec`（小数 10 桁）、按分、名前付きの丸めの枠、表示の関数。給与の lint（[ADR-0001](decisions/0001-platform-and-stack.md)、[ADR-0027](decisions/0027-pay-item-graph-and-formula-language.md)） |
| `ci-baseline` | PR の CI：決定表を `spec.md` から読む表駆動の仕組み、性質ベーステスト、要件 ID と `THR-` の追跡、ゴールデンデータセットの枠（空の事例で動く）、merge queue（[delivery.md](architecture/delivery.md) の 2 節） |
| `flags-appconfig` | release・payroll・ops・permission の 4 種類のフラグ、テナントのカナリア、ガード（[delivery.md](architecture/delivery.md) の 8 節） |
| `telemetry-baseline` | `packages/telemetry`（型付きのイベント、`Pii<T>`）、Collector の属性の許可リスト、URL の規則の lint（[ADR-0058](decisions/0058-pii-free-telemetry.md)） |
| `pii-and-mn-scanners` | ログの走査の Lambda、合成の番号による生存の確認、CI の個人情報・個人番号の形の走査（[observability.md](architecture/observability.md) の 4.3 節） |
| `edge-sli-and-alert-annotations` | CloudFront のリアルタイムのログからの可用性の SLI、アラートの runbook の注釈の CI |
| `audit-events-skeleton` | `audit_events` の表、許可リストのスキーマ、同じトランザクションの書き込み（PROP-AUD-001・004。[audit-and-retention.md](architecture/audit-and-retention.md) の 3.1 節） |
| `thr-platform-negative-tests` | THR-050〜053（RLS のコンテキストの漏れ、監査ログの改ざん、本番のデータ、CI/CD）の拒否の側のテスト |
| `scheduled-scaling-framework` | 予定のスケールの仕組み（AppConfig の予定の表、ECS の最小の上書き。[ADR-0060](decisions/0060-scheduled-peak-capacity.md)） |
| `quota-requests` | Fargate の vCPU（東京・大阪）、KMS の要求数の確認と申請（[capacity.md](architecture/capacity.md) の 6 節） |
| `osaka-warm-standby-skeleton` | 大阪のウォームスタンバイの骨格（Aurora Global Database の二次、最小のタスク、複製） |

### E2 オブジェクトモデルと有効日付

設計：[object-model-and-effective-dating.md](architecture/object-model-and-effective-dating.md)、[ADR-0006](decisions/0006-temporal-table-triplet-and-fold.md)〜[ADR-0009](decisions/0009-temporal-reference-model-testing.md)

| Story | 内容 |
| --- | --- |
| `temporal-types` | 3 節の型、`CivilDate` の変換、上限の検査 |
| `temporal-ddl-generator` | `FacetSpec` から 3 つのテーブル・制約・RLS・トリガーを生成。CI の検査 |
| `temporal-fold-and-write-path` | 5 節の手順、DT-TEMP-001・002、PROP-TEMP-001・002・004・006・009。参照のモデルとのモデルベーステストの仕組み |
| `temporal-correction-and-rescind` | 6 節、DT-TEMP-003・004、PROP-TEMP-007 |
| `temporal-point-in-time-query` | 7 節の API、安定の境界、PROP-TEMP-003・005 |
| `temporal-activation-timers` | 8 節、DT-TEMP-005、PROP-TEMP-008 |
| `temporal-retro-events` | `temporal.retro_detected` と購読の契約 |
| `temporal-nightly-consistency` | 夜間の検査と `rebuild_current`。`temporal-consistency-mismatch.md` の runbook |

### E3 Core HR

設計：[core-hr.md](architecture/core-hr.md)、[ADR-0010](decisions/0010-person-employment-job-assignment-model.md)〜[ADR-0012](decisions/0012-worker-lifecycle-events-and-legal-checks.md)

| Story | 内容 |
| --- | --- |
| `org-model-and-hierarchy` | 組織の facet、辺、閉包、循環の検査（PROP-HR-003）。`org-closure-rebuild.md` |
| `job-catalog-and-positions` | 職務の目録、等級、ポジション、人員の管理のモデル（DT-HR-003、PROP-HR-004） |
| `worker-employment-model` | 人・雇用・職務の 3 層と facet の宣言、社員番号、振込先の `account_hmac`（PROP-HR-001・002） |
| `hire-process` | 入社の業務プロセスと子の案件、労働条件の通知の交付の記録（確認：L14） |
| `job-change-and-transfer` | 異動・昇格・降格（DT-HR-001 の #4・5） |
| `leave-of-absence-status` | 休職・復職と `leave_of_absence_types` の印（[ADR-0025](decisions/0025-special-leave-and-leave-of-absence-boundary.md)） |
| `termination-and-legal-warnings` | 退職と法令の警告（DT-HR-001 の #10・11、DT-HR-002。確認：L12・L13） |
| `rehire` | 再雇用と社員番号の引き継ぎ |
| `personal-data-changes` | 個人の情報の変更の業務プロセス（画面は E5） |
| `org-role-assignments` | ロールのポジションへの割り当て（`role_assignment_change`） |
| `contingent-workers` | 外部の人（確認：L15） |
| `org-inactivation-and-reorg` | 組織の廃止と再編、予覧（PROP-HR-005）。`reorg-partial-failure.md` |
| `temporal-history-ui` | 履歴と差分の画面（core-hr の画面と一緒に） |
| `april-mass-transfer-readiness` | 4 月 1 日の定期の異動の準備（発効の予定の監視、BP Worker の予定のスケール）。`april-mass-transfer.md` |

### E4 業務プロセスと権限

設計：[business-process-engine.md](architecture/business-process-engine.md)、[security-model.md](architecture/security-model.md)、[ADR-0013](decisions/0013-bp-definition-format-and-versions.md)〜[ADR-0020](decisions/0020-sensitive-read-audit-and-access-explanations.md)

| Story | 内容 |
| --- | --- |
| `bp-definition-schema` | 定義の形、式の木と評価器、種類ごとの payload のスキーマ（3.1 節の種類の一覧） |
| `bp-definition-versions` | 版と選び方（PROP-BP-005） |
| `bp-case-state-machine` | 状態、遷移、冪等、楽観ロック（DT-BP-001、PROP-BP-001・004） |
| `bp-completion-transaction` | 見ていた版の確認、差分の書き込み（PROP-BP-002） |
| `bp-routing` | 担当の決め方、予備の担当、除外（DT-BP-002、PROP-BP-003）。`bp-stuck-steps.md` |
| `bp-delegation` | 委任（DT-BP-005） |
| `bp-rescind-and-correct` | 取消・訂正（DT-BP-003）、遡及の候補の通知。`rescind-chain.md` |
| `bp-parent-child-and-bulk` | 親子の案件、束の実行、`partially_applied`。`bp-partial-bulk.md` |
| `bp-deadlines-and-timers` | 期限・督促・エスカレーション（PROP-BP-006）。`bp-timer-lag.md` |
| `bp-inbox` | 受信箱の射影と通知（PROP-BP-007）。画面は E5 の `ui-inbox` |
| `bp-definition-validation-and-simulation` | 静的な検査と模擬の実行（DT-BP-004、PROP-BP-008） |
| `bp-definition-activation` | 編集と有効化の分離。`bp-bad-definition-rollback.md` |
| `authz-domains-and-field-map` | ドメインの一覧（`security.admin` を含む）、facet の項目の割り当て、CI の検査 |
| `authz-evaluator` | `can`・`scopeFilter`・`project`・`canBp`（DT-SEC-001・003、PROP-SEC-001・003・007）。`aggregate` の操作 |
| `authz-cache` | 権限の表のキャッシュ（PROP-SEC-005） |
| `security-groups` | グループの種類と所属、`security_group_membership_change` |
| `bp-security-policies` | 業務プロセスの権限、`retro_override`・`payroll.retro_override` |
| `security-policy-versions` | 方針の版と有効化（DT-SEC-004、PROP-SEC-006）。`security-policy-rollback.md` |
| `sod-rules-and-checks` | 規則表 S1〜S7、4 つの検査点、夜間の走査（DT-SEC-002、PROP-SEC-004）。`sod-violation-report.md` |
| `tenant-isolation-properties` | PROP-SEC-002（RLS と判定の両方） |
| `thr-authz-negative-tests` | THR-010〜016 の拒否の側のテスト。`authz-deny-spike.md` |

### E5 セルフサービスとログイン

設計：[self-service-ui.md](architecture/self-service-ui.md)、[integrations-and-bulk.md](architecture/integrations-and-bulk.md) の 7 節、[ADR-0038](decisions/0038-single-responsive-spa-and-offline-clock.md)・[ADR-0039](decisions/0039-effective-dated-views-and-change-requests.md)・[ADR-0044](decisions/0044-sso-api-clients-and-clock-terminals.md)

| Story | 内容 |
| --- | --- |
| `ui-shell-and-design-system` | `packages/ui`、`packages/i18n`、ルーティング、権限による画面の出し分け、axe の CI。`ui-asset-release-rollback.md` |
| `auth-better-auth-and-sessions` | ログイン、パスキー、メールの OTP、セッション、再認証 |
| `sso-saml-oidc` | SSO の接続の登録、属性の結び（DT-INT-004）。`idp-outage.md` |
| `account-lifecycle-timers` | 入社・退職の発効でのアカウントの有効化・無効化 |
| `ui-as-of-and-history` | 時点の見せ方、将来の変更と保留中の案件（PROP-UI-002） |
| `ui-change-requests` | 変更の申請の画面（DT-UI-001） |
| `ui-inbox` | 受信箱の画面とまとめての承認（DT-UI-002。business-process-engine の `inbox-ui` と 1 つ） |
| `ui-manager-team` | チーム、組織図、起票 |
| `ui-task-timing` | 画面の計測（K8） |
| `thr-edge-and-sso-tests` | THR-001〜005、THR-044 の拒否の側のテスト |

### E6 勤怠

設計：[time-and-attendance.md](architecture/time-and-attendance.md)、[ADR-0021](decisions/0021-clock-events-corrections-and-objective-records.md)〜[ADR-0023](decisions/0023-overtime-agreement-monitoring-and-monthly-close.md)

| Story | 内容 |
| --- | --- |
| `clock-events-ingest` | 冪等の打刻、端末の一時の保存、印（PROP-TIME-002）。`clock-ingest-backlog.md` |
| `ui-clock-offline` | 打刻の画面のオフライン（PROP-UI-001） |
| `clock-terminal-integration` | 打刻機の直接の送信とファイルの取り込み、カードの結び（PROP-INT-003、THR-043。time の `terminal-import` と 1 つ。確認：L43）。`clock-terminal-silent.md` |
| `time-correction-process` | 打刻の訂正（PROP-TIME-005） |
| `objective-records-divergence` | PC のログ・入退室の取り込みと乖離（DT-TIME-001。確認：L20）。`objective-log-import-failure.md` |
| `work-rules-and-shifts` | 勤務の規則とシフト（DT-TIME-004。確認：L21） |
| `work-hour-calc-fixed-shift` | 固定・シフトの区分（DT-TIME-002、PROP-TIME-001・003・004・007。確認：L18・L19） |
| `work-hour-calc-monthly-variable` | 1 か月単位の変形（確認：L22） |
| `work-hour-calc-flex` | フレックス（清算期間 1 か月） |
| `overtime-agreements` | 協定の設定と保存の検査（`overtime_agreement_change`） |
| `overtime-alerts` | 判定と警告（DT-TIME-003、PROP-TIME-006）、K5 の計測（確認：L6・L17）。`overtime-alert-job-delay.md` |
| `monthly-close` | 本人の確認、`timesheet_approval`、`hr_locked`、`time_period_reopen`（DT-TIME-005）。`time-period-reopen.md` |
| `time-to-payroll-handoff` | 集計の版とハッシュ |
| `ui-timesheet-and-overtime` | 勤怠、乖離の理由、36 協定の段の画面 |
| `clock-sli-and-scheduled-scaling` | 打刻の SLI、始業の打刻の予定の作成、36 協定の判定の遅れの監視 |

### E7 休暇

設計：[absence-and-leave.md](architecture/absence-and-leave.md)、[ADR-0024](decisions/0024-annual-leave-grant-ledger.md)・[ADR-0025](decisions/0025-special-leave-and-leave-of-absence-boundary.md)

| Story | 内容 |
| --- | --- |
| `leave-types-config` | 休暇の種類の設定（`leave_types`）、法定の短期の休暇の既定 |
| `annual-leave-ledger` | 付与と台帳（PROP-ABS-001・002・005）。`leave-balance-rebuild.md` |
| `annual-leave-grant-rules` | 付与の要件と出勤率（DT-ABS-001・002。確認：L23・L24）。`leave-grant-job-catchup.md` |
| `uniform-grant-policy` | 斉一的付与と法定を下回らない検査（PROP-ABS-003、`leave_policy_change`。確認：L26）。`uniform-grant-cutover.md` |
| `leave-expiry` | 失効と事前の案内（確認：L25） |
| `hourly-and-half-day-leave` | 半日と時間単位（PROP-ABS-004。確認：L25） |
| `five-day-obligation` | 年 5 日の義務と時季の指定（DT-ABS-003、PROP-ABS-006、`annual_leave_designation`。確認：L26） |
| `annual-leave-register` | 管理簿の射影と出力 |
| `time-off-request` | 休暇の申請と勤怠への連携（DT-ABS-004） |
| `special-leaves` | 特別休暇と法定の短期の休暇（`special_leave_grant`、`leave_balance_adjustment`。確認：L27） |
| `leave-of-absence-integration` | 休職の読み取り、休職の開始で承認済みの年休を示す（core-hr の `leave-of-absence-status` と一緒に） |
| `ui-time-off` | 休暇の申請と残りの画面 |

### E8 月次の給与計算

設計：[payroll-engine.md](architecture/payroll-engine.md)、[payroll-jp-rules.md](architecture/payroll-jp-rules.md)、[delivery.md](architecture/delivery.md) の 4・6・8 節、[observability.md](architecture/observability.md) の 3.3・3.5 節、[ADR-0026](decisions/0026-payroll-run-stages-and-input-snapshot.md)〜[ADR-0034](decisions/0034-overtime-premiums-and-proration.md)、[ADR-0059](decisions/0059-payroll-run-slo-and-synthetic-run.md)、[ADR-0061](decisions/0061-golden-dataset-ci.md)〜[ADR-0063](decisions/0063-payroll-flags-pinning-and-freeze-windows.md)

| Story | 内容 |
| --- | --- |
| `pay-groups-and-periods` | 給与のグループ、期間、支給日、営業日の暦（`business_calendars`） |
| `payroll-run-state-machine` | 実行の段（DT-PAY-001）、`payroll_finalize`・`payroll_cancel` の業務プロセス。`payroll-cancel-and-rerun.md` |
| `payroll-input-freeze` | 入力の固定、正規の形とハッシュ（PROP-PAY-003） |
| `pay-item-graph` | 項目と段と依存のグラフ（PROP-PAY-006）、`pay_items` のシステムの行（data-model の 3.1 節）、`pay_item_change` |
| `tenant-formula-language` | テナントの式の型の検査（DT-PAY-002、PROP-PAY-005） |
| `payroll-results-store` | 結果の保存と確定の後の書き換えの拒否（PROP-PAY-002） |
| `payroll-compute-chunks` | 束の計算、RunTask、payroll のサブネット、取り込み（PROP-PAY-001・007）。`payroll-run-stuck.md` |
| `payroll-concurrency-and-priority` | 同時の上限と支給日の近さの優先、給与の用の reader の予定の追加。`payday-peak-capacity.md` |
| `payroll-review-checks` | 確認の検査（DT-PAY-004。#10 の支給日の前の口座の変更を含む）、1 人の再計算 |
| `golden-dataset-harness` | ゴールデンデータセットの CI、分類の網羅、`pending_fix` |
| `reproducibility-sampler` | 夜間の抜き取りの再計算、前のリリースのエンジンとの比較。`payroll-reproducibility-mismatch.md` |
| `rule-table-ingestion` | 取得、読み取り、自動の検査、2 人の照合（`rules.import`・`rules.verify`、S8）。`rule-table-import-and-verify.md`、`rule-table-correction.md` |
| `rule-table-release-pipeline` | 署名した束、staging と本番の公開（`rules.publish`）、改正の暦の監視。`statutory-rate-calendar.md` |
| `rule-tables-r8` | 令和 8 年の各表の取り込み（源泉、協会けんぽの 47 都道府県、支援金、年金、雇用保険、等級表） |
| `named-roundings` | 名前付きの丸め（DT-JP-010）と境界のテスト |
| `wht-monthly-table` | 源泉の欄と表（DT-JP-001・002、PROP-JP-001。確認：L31） |
| `wht-computer-method` | 電算機特例（PROP-JP-002） |
| `social-insurance-premiums` | 社会保険料（DT-JP-003・004、PROP-JP-003・004。確認：L8・L32・L33） |
| `employment-insurance` | 雇用保険料（DT-JP-007。確認：L37） |
| `resident-tax-withholding` | 住民税の特別徴収と通知の取り込み（DT-JP-008、PROP-JP-007。確認：L35）。`resident-tax-notice-import.md` |
| `overtime-premiums` | 割増賃金（DT-JP-009、PROP-JP-006） |
| `proration-and-absence-deduction` | 日割りと欠勤控除、通勤手当の非課税（DT-JP-011、PROP-JP-005） |
| `leave-pay-and-average-wage` | 休暇の日の賃金と平均賃金（確認：L36） |
| `payroll-milestones-and-synthetic-run` | 給与の実行の里程標と SLI、合成の給与の実行、給与の実行のダッシュボード（[ADR-0059](decisions/0059-payroll-run-slo-and-synthetic-run.md)） |
| `payroll-flags-and-freeze-calendar` | 給与に効くフラグの固定と影の比較、凍結の暦（[ADR-0063](decisions/0063-payroll-flags-pinning-and-freeze-windows.md)） |
| `thr-payroll-negative-tests` | THR-024・025 の拒否の側のテスト |

### E9 賞与・遡及・並行稼働

設計：[payroll-engine.md](architecture/payroll-engine.md) の 7・8・10 節、[payroll-jp-rules.md](architecture/payroll-jp-rules.md) の 3.4・4.6〜4.8 節、[integrations-and-bulk.md](architecture/integrations-and-bulk.md) の 5 節、[ADR-0028](decisions/0028-retro-deltas-and-bonus-runs.md)、[ADR-0029](decisions/0029-parallel-run-and-compute-partitioning.md)、[ADR-0043](decisions/0043-migration-history-and-parallel-run-inputs.md)

| Story | 内容 |
| --- | --- |
| `retro-detection-and-delta` | 遡及の候補と差額（DT-PAY-003、PROP-PAY-004。確認：L28・L29） |
| `bonus-runs` | 賞与の実行と `bonus_entry` |
| `off-cycle-runs` | 臨時の実行 |
| `wht-bonus` | 賞与の源泉（確認：L30） |
| `si-bonus-premiums` | 賞与の社会保険料 |
| `interim-revision-detection` | 随時改定の候補と月額変更届の帳票（DT-JP-005、PROP-JP-008、`si_grade_change`。確認：L34） |
| `regular-determination` | 定時決定と算定基礎届の帳票（確認：L34） |
| `parallel-run-imports` | 現行の結果と勤怠の集計の取り込み（確認：L11・L42） |
| `parallel-run-compare` | 項目の対応、差の分類、説明と承認、切り替えの判定（確認：L11）。`parallel-run-monthly-review.md` |
| `leave-balance-migration` | 年休の期首の残りの移行 |

### E10 支払と会計

設計：[payments-and-accounting.md](architecture/payments-and-accounting.md)、[infrastructure.md](architecture/infrastructure.md) の 6.4 節、[ADR-0035](decisions/0035-bank-transfer-files.md)〜[ADR-0037](decisions/0037-payroll-journal-export.md)

| Story | 内容 |
| --- | --- |
| `payment-allocation` | 振込先の配分（PROP-PMT-001） |
| `wage-payment-consent` | 口座振込の同意（確認：L4） |
| `payment-election-change-notice` | 振込先の変更の本人への通知と再認証（THR-020。確認：L58） |
| `payment-instructions` | 支払の指示（DT-PMT-002） |
| `zengin-file-generation` | 全銀協の形式のファイル、カナの変換、支払元の口座の設定（DT-PMT-001、PROP-PMT-002・003） |
| `payment-release-approval` | ハッシュに結ぶ承認、取り出しの手順。`bank-file-release.md` |
| `payment-returns-and-reissue` | 振込の不能と再支払い、振込以外の支払い。`payment-return-handling.md` |
| `bank-file-osaka-rebuild-check` | 大阪での振込ファイルの作り直しとハッシュの一致の確認（[ADR-0055](decisions/0055-disaster-recovery-and-payday-continuity.md)） |
| `payslip-documents` | 明細の文書、公開、通知。`payslip-publish-delay.md` |
| `payslip-pdf` | PDF（PROP-PMT-004）とライブラリの PoC |
| `payslip-e-delivery-consent` | 電子交付の承諾（DT-PMT-003。確認：L3・L38） |
| `wage-ledger` | 賃金台帳（確認：L39） |
| `gl-account-mapping` | 勘定の対応 |
| `payroll-journal-entries` | 仕訳（DT-PMT-004、PROP-PMT-005。確認：L9・L40） |
| `gl-export` | 出力の束（PROP-PMT-006）。`gl-export-rejected.md` |
| `employer-si-adjustment` | 納入告知の取り込みと調整の仕訳。`employer-si-notice-adjustment.md` |
| `ui-payslips` | 明細の一覧・表示・PDF・承諾の画面 |
| `thr-money-negative-tests` | THR-020〜023 の拒否の側のテスト（口座の重複の HMAC を含む） |

### E11 マイナンバーと監査

設計：[my-number-vault.md](architecture/my-number-vault.md)、[audit-and-retention.md](architecture/audit-and-retention.md)、[security-model.md](architecture/security-model.md) の 9・10 節、[security.md](architecture/security.md) の 7 節、[ADR-0045](decisions/0045-my-number-collection-and-identity-verification.md)〜[ADR-0050](decisions/0050-electronic-books-act-readiness.md)、[ADR-0053](decisions/0053-operator-access-and-vault-break-glass.md)、[ADR-0057](decisions/0057-vault-delivery-separation.md)

| Story | 内容 |
| --- | --- |
| `vault-account-and-network` | vault-prod のアカウント、PrivateLink の両方向、相互 TLS、保管庫の CloudFront と WAF、保管庫の Terraform とパイプライン |
| `vault-storage-and-keys` | 保管と暗号（PROP-MN-004） |
| `vault-api` | 目的に縛った API と操作者の主張（DT-MN-001、PROP-MN-001・003。確認：L47） |
| `mn-handlers` | 事務取扱担当者の指定（`mn_handler_designation`）と保管庫への反映 |
| `mn-collection-and-verification` | 保管庫の画面での収集と本人確認（確認：L44〜L46） |
| `ui-my-number-entry` | 人事の画面から保管庫の画面への入口 |
| `vault-access-log` | 記録の連鎖、ALB との突き合わせ、取扱状況の確認（PROP-MN-002）。`vault-access-log-gap.md` |
| `vault-docgen` | 書類の生成の仕組みと 1 種の書類 |
| `mn-retention-and-deletion` | 削除の候補と実行（DT-MN-002。確認：L2・L48・L50）。`mn-deletion-overdue.md` |
| `vault-telemetry` | 保管庫のアカウントのテレメトリーと記録の突き合わせのアラート |
| `vault-break-glass-procedure` | 保管庫の緊急の操作の手順と 3 者の承認。`vault-break-glass.md` |
| `thr-vault-negative-tests` | THR-030〜035 の拒否の側のテスト |
| `audit-archiver-and-chain` | セグメント、日の署名、検証、突き合わせ（PROP-AUD-002・003）。`audit-chain-verification-failure.md`、`audit-archiver-lag.md` |
| `retention-rules-table` | 保存の期間の規則表（DT-AUD-001。住民税の通知・並行稼働の表・給与明細・振込ファイルの行を含む。確認：L5・L51〜L53） |
| `retention-purge-jobs` | 削除の実行（DT-AUD-002、PROP-AUD-005）、`retention_purger`、予覧と承認（確認：L54）。`retention-purge-run.md` |
| `legal-holds` | 保全の設定と解除。`legal-hold.md` |
| `auditor-console` | 監査人の画面 |
| `sensitive-read-audit` | 機微なドメインの閲覧の記録 |
| `access-explanation-reports` | 説明の報告 |
| `proxy-login` | 代理のログイン。`proxy-login-review.md` |
| `support-access-grants` | テナントの許可によるサポートの参照、運用者の期限つきの権限。`operator-access-review.md` |

### E12 レポート・連携・本番の準備

設計：[reporting.md](architecture/reporting.md)、[integrations-and-bulk.md](architecture/integrations-and-bulk.md)、[capacity.md](architecture/capacity.md) の 7 節、[infrastructure.md](architecture/infrastructure.md) の 6 節、[security.md](architecture/security.md) の 8 節、[runbooks/](runbooks/README.md)

| Story | 内容 |
| --- | --- |
| `report-sources-and-definitions` | データの元の宣言、定義の版、静的な検査 |
| `report-runner` | 同期と非同期、実行の記録、出力（PROP-RPT-001・002・004）。`report-reader-saturation.md` |
| `report-point-in-time` | `effective_on`・`known_at`・期間 |
| `report-suppression` | 少人数の抑止（DT-RPT-002、PROP-RPT-003） |
| `org-chart` | 組織図 |
| `standard-reports` | 標準のレポート |
| `statutory-registers` | 労働者名簿・賃金台帳・出勤簿・年次有給休暇管理簿の出力（core-hr の `worker-register-report`、time の `attendance-register-report` と 1 つ。確認：L16） |
| `bulk-import-templates` | 雛形 |
| `bulk-import-pipeline` | 一括の取り込み（DT-INT-001・002、PROP-INT-001・002）。`bp-partial-bulk.md` に一括の取り込みの節を足す |
| `bulk-export` | 一括の出力 |
| `migration-loads` | 移行と期首の値の台帳、検証の報告（DT-INT-003。確認：L41）。`migration-cutover.md` |
| `mn-migration` | マイナンバーの移行（保管庫の画面から） |
| `public-api-and-clients` | 公開の API と API の利用者（PROP-INT-004） |
| `webhooks` | Webhook。`webhook-endpoint-disabled.md` |
| `ebooks-act-readiness` | 概要書・操作説明書、ダウンロードの求めの出力、検索の条件（確認：L55） |
| `thr-integration-negative-tests` | THR-040〜042・045 の拒否の側のテスト |
| `load-test-suite` | 負荷試験の 7 シナリオ（time の `clock-load-test`、payroll-engine の `payroll-load-test`、business-process-engine の `bp-load-test` と 1 つ） |
| `dr-drills` | DR の訓練（支給日の DR を含む）と本番の switchover |
| `synthetic-canaries` | 合成監視のカナリア（大阪から東京、監視用のテナント。[observability.md](architecture/observability.md) の 6 節） |
| `slo-and-alert-tuning` | SLO の確定、アラートの調整、DR のダッシュボード |
| `pentest-and-fixes` | 外部のペンテストと修正（security-model の `authz-pentest` と 1 つ） |
| `incident-tabletop` | インシデントの机上訓練（マイナンバーの漏えい、給与の誤り） |
| `tenant-offboarding` | 解約のテナントのデータの返却と鍵の削除（確認：L57）。`tenant-offboarding-crypto-erase.md` |
| `security-txt-and-disclosure` | `security.txt` と脆弱性の報告の窓口 |
| `cost-baseline` | 費用の単価の置き換えとタグごとの可視化 |
| `runbooks-e12` | [runbooks/README.md](runbooks/README.md) の 4 節で「E12 で作成」とした手順 |

### E13 年末調整と法定調書（MVP の後）

設計：[payroll-jp-rules.md](architecture/payroll-jp-rules.md) の 10 節、[my-number-vault.md](architecture/my-number-vault.md) の 6.4 節。ADR は 0064〜0066（[architecture/README.md](architecture/README.md) の 7 節）

| Story | 内容 |
| --- | --- |
| `year-end-adjustment` | 1 年分の確定した結果と申告から年税額と過不足を求める純粋な計算、過不足の差額の行 |
| `year-end-declarations-ui` | 扶養控除等・保険料控除・住宅借入金等特別控除の申告の画面 |
| `statutory-reports-in-vault` | 源泉徴収票・給与支払報告書（保管庫の中） |

### E14 電子申請（MVP の後）

| Story | 内容 |
| --- | --- |
| `bp-external-wait-step` | 外部のシステムの応答を待つステップ（ADR。[ADR-0003](decisions/0003-business-process-engine.md) の Consequences） |
| `vault-egress-for-filing` | 保管庫からの電子申請の出口（ADR。[my-number-vault.md](architecture/my-number-vault.md) の 15 節） |
| `si-ei-e-filing` | 社会保険・雇用保険の届出の電子申請 |
| `resident-tax-notice-e-import` | 住民税の特別徴収税額通知の電子の取り込み、異動届 |
| `statutory-reports-e-filing` | 法定調書の電子の提出 |

### E15 退職所得と退職金（MVP の後）

| Story | 内容 |
| --- | --- |
| `retirement-income-withholding` | 退職所得の源泉徴収 |
| `retirement-allowance-calc` | 退職金の計算 |

### E16 タレント管理（MVP の後）

| Story | 内容 |
| --- | --- |
| `goals-and-reviews` | 目標と評価 |
| `succession-planning` | 後継者の計画 |

## エージェントに任せないこと

- **ゴールデンデータの期待値の決定と変更**：期待値は社労士・税理士か公的な資料で確かめ、QA が承認する。
- **規則表の照合と公開**：取り込みと照合は別の人（S8）、公開は Ops の承認。
- **並行稼働の差の説明の承認と、切り替えの判定**：給与の担当と QA。
- **法務・社労士・税理士の判断**（L1〜L58）。
- **権限の方針の有効化、職務分掌の例外、保管庫の緊急の操作**：人のロールの持ち主が行う。
- **支給日の DR の切り替えの判断、仮払いの判断**：IC・Ops の責任者とテナント（[runbooks/disaster-recovery.md](runbooks/disaster-recovery.md)）。
- **負荷試験・PoC の結果の解釈**：数字は出せるが、束の大きさ・台数・段階を上げる判断は Dev と Ops。

## 延期の一覧

MVP の後に検討する。E13〜E16 に入れなかったもの。着手するときに `intent.md` から起票する（[intent.md](intent.md) の「MVP の後の Epic で扱う」と、各領域の文書の持ち越し）。

- **採用、学習、報酬の計画**（昇給の予算、配分のシミュレーション）。
- **海外の給与計算**と、財務会計（Financials）。
- **1 年単位の変形労働時間制、裁量労働制の計算、高度プロフェッショナル制度、清算期間が 1 か月を超えるフレックス**（[time-and-attendance.md](architecture/time-and-attendance.md) の 13 節）。代替休暇、建設・自動車の運転・医師の上限の特例、位置の情報の打刻。
- **在籍出向・転籍の持ち方、二重の登録の人の統合の業務プロセス、ジョブシェア**（[core-hr.md](architecture/core-hr.md) の 14 節）。
- **依存の連鎖をまとめて取り消す操作**（[object-model-and-effective-dating.md](architecture/object-model-and-effective-dating.md) の 14 節）、担当の自動の付け替え、テナントが業務プロセスの種類を足すこと（[business-process-engine.md](architecture/business-process-engine.md) の 17 節）。
- **半月・週の支払い**、年休の買い上げ、産前産後・育児休業の保険料の免除の月の自動の判定。
- **銀行の API での送信と振込の結果の取り込み、会計システムの固有の形式**（[payments-and-accounting.md](architecture/payments-and-accounting.md) の 13 節）。
- **SCIM（受け手と送り手）、外へ押し出す SFTP の出力、外部の BI の道具への連携**（[integrations-and-bulk.md](architecture/integrations-and-bulk.md) の 14 節、[reporting.md](architecture/reporting.md) の 14 節）。
- **公的個人認証での本人確認**（[my-number-vault.md](architecture/my-number-vault.md) の 15 節）。
- **Web Push、英語以外の言語、打刻の画面の PWA のインストールの案内**（[self-service-ui.md](architecture/self-service-ui.md) の 14 節）。
- **S2 の構成**（テナントの対応表での Aurora のクラスタの分割、大口のテナントの専用のクラスタ、分析用の基盤 `analytics-store`、`analytics-export-lag.md`）と **S3 のセル構成**（[infrastructure.md](architecture/infrastructure.md) の 8・9 節、[reporting.md](architecture/reporting.md) の 6.2 節）。
- **日の署名の第三者のタイムスタンプ**（[audit-and-retention.md](architecture/audit-and-retention.md) の 13 節。L55 の確認と合わせる）。

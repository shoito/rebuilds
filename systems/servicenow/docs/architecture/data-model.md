# Data model: ServiceNow

データモデルの索引。テナントの分け方は [ADR-0002](../decisions/0002-tenancy-and-isolation.md)、テーブルの階層と拡張は [ADR-0003](../decisions/0003-table-hierarchy-and-extensible-schema.md)、物理の配置は [ADR-0007](../decisions/0007-physical-layout-and-extension-index.md)、NULL の `tenant_id` の行とテナントをまたぐロールは [ADR-0054](../decisions/0054-shared-reference-rows-and-cross-tenant-roles.md) に従う。**各テーブルの定義の正本は、下の索引の「定義の場所」にある文書**で、ここは置き場所・横断の規則・索引を書く。

この文書は、各領域の文書の「data-model への項目」を集め、2026-09-28 の統合の工程で重なりの解消と名前の揃えを行ったものである。統合で決めたことは 5 節にある。実装の変更（`changes/`）でマイグレーションを書くときに、ここと各文書を合わせて更新する。

## 1. 置き場所

| 置き場所 | 中身 |
| --- | --- |
| セルの Aurora PostgreSQL 18（東京が主、大阪は Global Database の二次） | セルの唯一の正本。テナントのレコード（`task`・`ci`・`custom_record`・専用の表）、辞書とメタデータ、ACL、フローの実行とタイマー、SLA の計時、監査の履歴、outbox、メール・Webhook・取り込みの記録 |
| 制御の面の Aurora（control のアカウント） | テナントの台帳（ホスト名・受信のアドレス → テナント → セル）、セルの一覧、テナントの移動、レート制限の段、課金の集計。セルの DB にテナントの台帳を置かない |
| セルの Valkey | キャッシュと数（コンパイル済みの辞書・ACL・画面のモデル、主体、見える品目、レポートの結果、レート制限、メールの流量の窓、セッション）。失われてもよい |
| セルの OpenSearch | 検索の索引（`task`・`ci`・`kb`・`catalog`・`record`）。DB の写しで、作り直せる |
| セルの S3（大阪へレプリケーション） | 添付、受信のメールの原本、エクスポート、取り込みの原本、祝日の CSV の原本 |
| mail-ingress の S3（1 日） | 受信のメールの一時の置き場所。読めるのは `mail-router` だけ（[infrastructure.md](infrastructure.md) の 2.3 節） |
| log-archive の S3（Object Lock） | 監査の日次のハッシュの鎖、プラットフォームの監査、CloudTrail、アプリのログの保管 |
| CloudFront KeyValueStore | ホスト名 → セル（制御の面の写し） |
| コードの版 | 組み込みの定義の正本（辞書・ACL の規則・ロール・状態のモデル・配置・文言の辞書・組み込みのレポートなど）。DB の NULL の行へ読み込むもの、コードの中だけに持つもの、テナントの作成の時に行を作るものの 3 つに分ける（3.1 節） |

## 2. 横断の規則

- **テナントテーブルは `tenant_id` を持ち、主キーとインデックスの先頭に置く。** ID は UUIDv7。`FORCE ROW LEVEL SECURITY` と、トランザクションごとの `SET LOCAL app.tenant_id`（[ADR-0002](../decisions/0002-tenancy-and-isolation.md)）。
- **外部キーは `tenant_id` を含む複合キーにする。** 例外は 3 節の NULL の行への参照だけ。`ext` の参照は DB の制約が効かないので、`ext_index` と Record Service で守る（[ADR-0007](../decisions/0007-physical-layout-and-extension-index.md)）。
- **テナントの解決の前に、テナントテーブルを読まない。** 解決に使う表（台帳）は制御の面にあり、セルの DB にはない。
- **行は `version` を持ち、更新は版の条件付き**（レコード、実行、承認、計時の行、呼び出し）。
- **メタデータの表は共通の列**（`stable_key`、`rev`、`content_hash`、`updated_in_version`、`deleted`）を持ち、変更は `meta_version` を上げる 1 つのトランザクションで行う（[ADR-0010](../decisions/0010-metadata-versions-and-config-packages.md)）。
- **追記だけの表**（`record_change`、`journal_entry`、`task_sla_event`、`meta_change`）は、アプリのロールに `UPDATE`・`DELETE` を与えない。
- **時間で消える表は、時間のパーティションで持ち、`DROP` で消す**（[ADR-0053](../decisions/0053-data-retention-and-deletion.md)）。
- **テナントの秘密の列**は、テナントの DEK のエンベロープ暗号化（`*_ciphertext`）か、ハッシュ（`*_hash`）にする（[security.md](security.md) の 5・7 節）。
- **DB のロール**：アプリのロール（RLS の対象）、`migrator`、`catalog_loader`（NULL の行だけ）、`engine_scheduler`（`claim_due_timers` で `(timer_id, tenant_id)` だけ）・`relay`（outbox だけ）・`indexer_scan`（`(tenant_id, id, version)` だけ）、`platform`（`BYPASSRLS`、期限付き）、`maintenance`（パーティションの操作だけ）（[security.md](security.md) の 10.4 節）。

## 3. NULL の `tenant_id` と RLS の外

### 3.1 組み込みのデータの置き場所と、`tenant_id` が NULL の行を持つ表

正本は [security.md](security.md) の 10.2 節（[ADR-0054](../decisions/0054-shared-reference-rows-and-cross-tenant-roles.md) と注記、[ADR-0002](../decisions/0002-tenancy-and-isolation.md) の注記）。マイグレーションの CI の許可の一覧と一致させる。

**規則**：組み込みのデータの定義の正本はコードの版にある。そのうち、テナントの行が外部キーで参照するもの、またはテナントの行と同じ一意の空間で照合するものだけを、起動の時に DB の NULL の行へ読み込む（`catalog_loader`）。テナントが自由に変える既定の設定は、テナントの作成の時にテナントの行として作る。それ以外はコードの中だけに持ち、テナントは自分の行で上書き・無効・複製をして、組み込みのものを `stable_key` で指す（外部キーにしない）。

| 組み込みのデータ | 置き場所 | 理由・テナントの変え方 | 定義の場所 |
| --- | --- | --- | --- |
| 辞書（`dict_table`、`dict_field`、`dict_choice_set`、`dict_choice`） | **NULL の行** | テナントの `c_` のフィールド・上書き・子のクラスが参照する | [data-dictionary-and-tables.md](data-dictionary-and-tables.md) の 3.2 節 |
| ロール（`role`） | **NULL の行** | `group_role`・`user_role` が参照する | [access-control.md](access-control.md) の 3.3 節 |
| ACL の規則（`acl_rule`） | **NULL の行** | テナントの無効の印が参照する。組み込みの `deny_unless` は無効にできない | [access-control.md](access-control.md) の 4.1 節 |
| 国民の祝日（`holiday_set`、`holiday_set_version`、`holiday`） | **NULL の行**（運用者 2 人の承認の後に公開） | テナントのカレンダーの版が参照する | [sla-and-calendars.md](sla-and-calendars.md) の 5 節 |
| 番号の定義（`number_def`） | **NULL の行** | 組み込みの辞書の `number_def_id` と、テナントの `number_counter` が参照する。接頭辞・桁の変更は、同じテーブルのテナントの行で上書きする | [data-dictionary-and-tables.md](data-dictionary-and-tables.md) の 8 節 |
| CI の関係の型（`ci_relation_type`） | **NULL の行** | テナントの `ci_relation` が参照する。テナントは型を足せる | [cmdb-and-reconciliation.md](cmdb-and-reconciliation.md) の 7.1 節 |
| CI の属性と識別の規則（`ci_attribute`、`ci_identification_rule`） | **NULL の行** | テナントの `ci_precedence`・`ci_identifier` が参照する。テナントの同じクラスの規則は組み込みの行に勝つ | 同上の 3.2・4.1 節 |
| 組み込みのフロー（`flow_def`、`flow_version`：`change_approval_policy`、`incident_auto_close`、`kb_publish_approval`、`major_incident_response`、カタログの雛形） | **NULL の行** | テナントの `flow_run` が版を参照する。コードの新しい版は新しい `flow_version` の行にし、前の版を変えない。テナントが変える値（承認者・規則）は、フローの入力となるテナントの行に持つ | [workflow-engine.md](workflow-engine.md) の 3.4 節 |
| 優先度の表の既定（`priority_matrix`） | コードの版だけ | テナントはテーブルごとの行で上書きする。行がなければ親のクラス、最後はコードの既定 | [itsm-processes.md](itsm-processes.md) の 5.1 節 |
| 配置と画面の規則の既定（`form_layout`、`list_layout`、`view_rule`、`ui_rule`） | コードの版だけ | テナントは `view` を足すか、既定を上書きする | [portal-and-ui.md](portal-and-ui.md) の 4.2 節 |
| 状態のモデル、組み込みのレコードのルール | コードの版だけ | テナントは条件と保留の理由だけを足す | [itsm-processes.md](itsm-processes.md) の 3 節、[workflow-engine.md](workflow-engine.md) の 6 節 |
| 通知の規則とテンプレートの既定（`notification_rule`、`notification_template`） | コードの版だけ | テナントは `stable_key` で無効にし、自分の行で規則とテンプレートを足す（組み込みのテンプレートを使うときは複製する） | [notifications-and-email-ingest.md](notifications-and-email-ingest.md) の 3.1・4 節 |
| 組み込みのレポートとダッシュボード（`report_def`、`dashboard`） | コードの版だけ | テナントは複製して変える | [reports.md](reports.md) の 8.3 節 |
| 画面の文言の辞書（`ja.json`・`en.json`） | コードの版だけ | テナントの文言は `translation` | [portal-and-ui.md](portal-and-ui.md) の 7.2 節 |
| 取り込み元の優先度とデータ源の規則の既定（`ci_precedence`、`ci_source_rule`） | コードの版だけ | テナントの行が既定に勝つ | [cmdb-and-reconciliation.md](cmdb-and-reconciliation.md) の 5.1・6.2 節 |
| 既定のカレンダー（`calendar`、`calendar_version`） | テナントの作成の時のテナントの行 | テナントが自由に変える | [sla-and-calendars.md](sla-and-calendars.md) の 3.1 節 |
| 組み込みの SLA の定義（インシデントの応答・解決、OLA。`sla_def`） | テナントの作成の時のテナントの行 | テナントが変える。`task_sla` はテナントの行を参照する | [itsm-processes.md](itsm-processes.md) の 4.4 節 |
| 既定のポータルとテーマ（`portal`、`portal_theme`）、既知のエラーのナレッジベース（`kb_base`） | テナントの作成の時のテナントの行 | テナントが変える | [portal-and-ui.md](portal-and-ui.md) の 6.2 節、[knowledge.md](knowledge.md) の 5 節 |
| 組み込みの取り込み元（`ci_source` の `manual`・`system_group`）、連携の主体（`user` の `email_intake`） | テナントの作成の時のテナントの行 | 連携の主体（利用者の行）を持つので、テナントごとに要る | [cmdb-and-reconciliation.md](cmdb-and-reconciliation.md) の 5.1・7.4 節、[notifications-and-email-ingest.md](notifications-and-email-ingest.md) の 5.6 節 |

- NULL の行は、アプリのロールから読み取りだけ。書くのは `catalog_loader` だけ。NULL の行はテナントの行を参照しない。
- テナントの作成の時に作る行は、コードの新しい版で書き換えない（既定の変更は新しいテナントにだけ効く）。既存のテナントに効かせたいときは、変更の Story で移行のジョブを作る（[delivery.md](delivery.md) の 4 節）。
- **NULL の行を持つ表の許可の一覧**：`dict_table`、`dict_field`、`dict_choice_set`、`dict_choice`、`role`、`acl_rule`、`holiday_set`、`holiday_set_version`、`holiday`、`number_def`、`ci_relation_type`、`ci_attribute`、`ci_identification_rule`、`flow_def`、`flow_version`。ここにない表の `tenant_id` は NOT NULL。

### 3.2 セルの DB の外に置く表（制御の面）

| 表 | 中身 | 定義の場所 |
| --- | --- | --- |
| `tenant_registry` | テナント、ホスト名、環境、セル、状態 | [infrastructure.md](infrastructure.md) の 13 節 |
| `inbound_address` | 受信のアドレス（別名を含む）→ テナント | 同上、[notifications-and-email-ingest.md](notifications-and-email-ingest.md) の 13 節 |
| `cell` | セルの一覧（`cells.yaml` と突き合わせる） | [infrastructure.md](infrastructure.md) の 7.2 節 |
| `tenant_move_run` | セル間の移動 | [infrastructure.md](infrastructure.md) の 4.2 節 |
| テナントのレート制限の段 | 契約の段の値 | [api-and-integrations.md](api-and-integrations.md) の 7.1 節 |

## 4. 索引（セルの Aurora の表）

保持の列の「監査」は、監査の履歴と同じ期間（既定 7 年。[ADR-0053](../decisions/0053-data-retention-and-deletion.md)）。「テナント」は、テナントが消すまで。

### 4.1 辞書・メタデータ・レコードの基盤（E2）

| 表 | 中身 | 保持 | 定義の場所 |
| --- | --- | --- | --- |
| `dict_table`、`dict_field`、`dict_override`、`dict_choice_set`、`dict_choice` | 辞書。組み込みは NULL の行。`dict_table.searchable`・`dict_field.searchable` を持つ | メタデータ | [data-dictionary-and-tables.md](data-dictionary-and-tables.md) の 3.2 節 |
| `task` | タスクの階層のすべてのクラス（1 つの表）。`ext`、`version` | テナント | 同上の 4.1 節。列の追加は [itsm-processes.md](itsm-processes.md) の 15 節、[service-catalog-and-requests.md](service-catalog-and-requests.md) の 13 節、[assignment-and-on-call.md](assignment-and-on-call.md) の 12 節、[cmdb-and-reconciliation.md](cmdb-and-reconciliation.md) の 15 節 |
| `ci` | CI の全クラス（1 つの表） | テナント | 同上の 4.1 節、[cmdb-and-reconciliation.md](cmdb-and-reconciliation.md) の 3.2 節 |
| `custom_record` | テナントの独立のテーブル | テナント | [data-dictionary-and-tables.md](data-dictionary-and-tables.md) の 4.1 節 |
| `ext_index` | テナントのフィールドの型付きの索引（`value_text`・`value_number`・`value_time`・`value_ref`。参照は必ず） | 行に従う | 同上の 4.2 節 |
| `record_change`、`journal_entry` | 監査の履歴、作業メモ・コメント。月ごとのパーティション、追記だけ | 監査 | 同上の 7.1 節 |
| `audit_digest` | 日次のハッシュの鎖（S3 Object Lock にも） | 監査 | 同上の 7.2 節 |
| `number_def`（組み込みは NULL の行）、`number_counter` | 番号 | テナント | 同上の 8 節 |
| `tenant_meta`（`meta_version`、`acl_version`）、`meta_change` | メタデータの版 | 監査 | 同上の 9.1 節 |
| `config_package`、`config_package_apply` | 設定のパッケージ | 監査 | 同上の 10 節 |
| `attachment` | 添付（S3 のキー、マルウェアの検査の状態） | 親のレコードに従う | [security.md](security.md) の 5.3 節 |

### 4.2 アクセス制御（E3）

| 表 | 中身 | 保持 | 定義の場所 |
| --- | --- | --- | --- |
| `user`、`group`、`group_member`、`group_role`、`role`、`user_role` | 主体。組み込みのロールは NULL の行 | テナント（削除の請求で仮名化） | [access-control.md](access-control.md) の 3 節、[security.md](security.md) の 9.2 節 |
| `acl_rule` | ACL の規則。組み込みは NULL の行 | メタデータ | [access-control.md](access-control.md) の 4.1 節 |
| `impersonation_session` | 成り代わり | 監査 | 同上の 8 節 |
| `idp_config`、`user_identity`、`tenant_auth_policy`、`domain_verification` | テナントの SSO | テナント | 同上の 9 節 |
| `api_client`、`api_client_secret`、`oauth_token`、`oauth_refresh_family` | API のクライアントとトークン（ハッシュ） | クライアントはテナント。秘密・トークンは失効の後 30 日 | [api-and-integrations.md](api-and-integrations.md) の 3.1 節 |
| `tenant_dek` | テナントの DEK の暗号文 | テナント | [security.md](security.md) の 5.2 節 |
| `tenant_audit_event` | テナントの監査ログ | DB 1 年、log-archive 7 年 | 同上の 6 節 |
| `support_access_grant` | 運用者のサポートの参照の許可 | 監査 | 同上の 8 節 |
| `legal_hold` | リーガルホールド | 解除の後 7 年 | 同上の 9.3 節 |

### 4.3 フロー・承認・タイマー（E4）

| 表 | 中身 | 保持 | 定義の場所 |
| --- | --- | --- | --- |
| `flow_def`、`flow_version` | フローの定義と不変の版。組み込みのフローは NULL の行 | メタデータ | [workflow-engine.md](workflow-engine.md) の 3.4 節 |
| `flow_run`、`flow_step`（月ごと）、`flow_wait`、`bulk_job` | 実行 | 完了の後 90 日 | 同上の 5.1 節 |
| `timer` | フロー・承認・SLA・当番の呼び出しで共有。`(shard, due_at)`、`(tenant_id, target_id)`。種類と優先度は 4.3.1 節 | 発火で消える | 同上の 5.1・8.2 節 |
| `approval_set`、`approval`、`delegation`（`scope`：`approvals`・`requests`） | 承認と代理 | 監査 | 同上の 7.1 節 |
| `record_rule` | レコードのルール | メタデータ | 同上の 6 節 |
| `webhook_result`、`tenant_secret`、`webhook_allowlist` | 外への呼び出し。秘密は DEK で暗号化 | 結果は 90 日 | 同上の 5.5 節 |
| `flow_trigger_suppressed` | 抑えたトリガー | 30 日 | 同上の 4・8 節 |

#### 4.3.1 タイマーの種類と優先度（統合した定義）

| `kind` | 対象 | `priority` | 登録する領域 |
| --- | --- | --- | --- |
| `sla_warning`、`sla_breach` | 計時の行 | 0 | [sla-and-calendars.md](sla-and-calendars.md) の 7 節 |
| `page_escalation` | 当番の呼び出し | 0 | [assignment-and-on-call.md](assignment-and-on-call.md) の 6.3 節 |
| `approval_due` | 承認のまとまり | 1 | [workflow-engine.md](workflow-engine.md) の 7.4 節 |
| `run_step`（承認の決着の後）、`wait_timeout` | 実行 | 1 | 同上の 5・8.2 節 |
| `run_step`（そのほか。自動の完了・記事の有効の期限の組み込みのフローを含む）、`schedule_trigger` | 実行・フロー | 2 | 同上の 3.2・5 節 |
| `bulk_step` | `bulk_job` | 3 | 同上の 5.3 節 |

- 候補の取得は `engine_scheduler` の `claim_due_timers` だけがテナントをまたいで読み、`(timer_id, tenant_id)` だけを返す。本文はテナントのコンテキストで取り直す（[workflow-engine.md](workflow-engine.md) の 5.3・8.3 節）。

### 4.4 SLA とカレンダー（E5）

| 表 | 中身 | 保持 | 定義の場所 |
| --- | --- | --- | --- |
| `calendar`、`calendar_version` | 業務カレンダー | メタデータ | [sla-and-calendars.md](sla-and-calendars.md) の 3.1 節 |
| `holiday_set`、`holiday_set_version`、`holiday` | 祝日。国民の祝日は NULL の行 | 版を消さない | 同上の 5 節 |
| `sla_def` | SLA の定義（版付き） | メタデータ | 同上の 6.1 節 |
| `task_sla` | 計時の行。部分一意索引。`breach_disputed_at` の列を持つ（統合で足した。[reports.md](reports.md) の 8.2 節の分類に使う） | タスクに従う | 同上の 6.2 節 |
| `task_sla_event` | 計時の事象。追記だけ、月ごと | 監査 | 同上の 6.2 節 |

### 4.5 割り当てとオンコール（E5）

| 表 | 中身 | 保持 | 定義の場所 |
| --- | --- | --- | --- |
| `assignment_rule` | 割り当ての規則 | メタデータ | [assignment-and-on-call.md](assignment-and-on-call.md) の 3.1 節 |
| `skill`、`user_skill`、`user_availability` | メンバーの状態 | テナント | 同上の 4.1 節 |
| `on_call_schedule`、`on_call_schedule_version`、`on_call_override` | 当番表 | 版を消さない | 同上の 5.1 節 |
| `escalation_policy` | 方針（版付き） | メタデータ | 同上の 6.1 節 |
| `page`、`page_attempt` | 呼び出し | 監査 | 同上の 6.3 節 |

### 4.6 ITSM のプロセス（E6・E7）

| 表 | 中身 | 保持 | 定義の場所 |
| --- | --- | --- | --- |
| `priority_matrix` | 優先度の表 | メタデータ | [itsm-processes.md](itsm-processes.md) の 5.1 節 |
| `major_incident_candidate`、`major_incident_trigger` | メジャーインシデント | テナント | 同上の 6.1 節 |
| `std_change_template`、`std_change_template_version` | 標準の変更の雛形 | 版を消さない | 同上の 8.2 節 |
| `risk_condition`、`risk_questionnaire`、`change_risk_assessment` | リスクの評価 | 監査 | 同上の 8.3 節 |
| `cab_definition`、`cab_meeting`、`cab_agenda_item` | CAB | 監査 | 同上の 8.6 節 |
| `change_window`、`change_conflict`、`change_impact_snapshot`、`change_affected_ci` | 予定表・衝突・影響 | 変更に従う | 同上の 9 節、[cmdb-and-reconciliation.md](cmdb-and-reconciliation.md) の 8.2 節 |

### 4.7 カタログと要求（E8）

| 表 | 中身 | 保持 | 定義の場所 |
| --- | --- | --- | --- |
| `catalog`、`catalog_category`、`catalog_item`、`catalog_item_version`、`variable_set`、`audience` | カタログ | メタデータ（版は変えない） | [service-catalog-and-requests.md](service-catalog-and-requests.md) の 3.1 節 |
| `answer_index` | 回答の索引 | 要求に従う | 同上の 4.3 節 |

### 4.8 ナレッジ（E9）

| 表 | 中身 | 保持 | 定義の場所 |
| --- | --- | --- | --- |
| `kb_base`、`kb_category` | ナレッジベース | メタデータ | [knowledge.md](knowledge.md) の 3.1 節 |
| `kb_article`、`kb_article_version` | 記事と版 | 監査 | 同上の 3.1 節 |
| `kb_rating`、`kb_flag` | 評価と旗 | テナント | 同上の 7.1 節 |
| `portal_event` | 自己解決の事象（仮名のセッション。日ごと） | 90 日 | 同上の 7.3 節 |
| `deflection_daily` | 自己解決の集計 | テナント | 同上の 7.4 節 |

### 4.9 通知とメール（E6）

| 表 | 中身 | 保持 | 定義の場所 |
| --- | --- | --- | --- |
| `notification_rule`、`notification_template` | 通知の規則とテンプレート（言語ごと） | メタデータ | [notifications-and-email-ingest.md](notifications-and-email-ingest.md) の 3.1・4 節 |
| `notification_message` | 通知（一意で 1 回） | 30 日 | 同上の 3.2 節 |
| `email_outbound` | 送ったメール | 90 日 | 同上の 3.5 節 |
| `email_watermark` | 参照の印 | 1 年 | 同上の 5.4 節 |
| `email_suppression` | 抑止のリスト | テナント | 同上の 3.6 節 |
| `inbound_email` | 受けたメール（`(tenant_id, ses_message_id)` 一意）。`mail-router` がセルへ振り分けた後に作る | 1 年 | 同上の 5.2 節 |
| `inbound_rule`、`tenant_mail_relay`、`tenant_mail_alias` | 受信の規則、転送の元、別名 | メタデータ | 同上の 5.6・5.7・5.1 節 |
| `user_notification_pref` | 利用者の通知の設定 | テナント | 同上の 3.2 節 |
| `push_subscription` | Web Push の購読 | 失効で消す | [portal-and-ui.md](portal-and-ui.md) の 6.4 節 |

### 4.10 CMDB（E10）

| 表 | 中身 | 保持 | 定義の場所 |
| --- | --- | --- | --- |
| `ci_attribute`（`multi` の印を含む）、`ci_identification_rule` | 属性と識別の規則。組み込みは NULL の行 | メタデータ | [cmdb-and-reconciliation.md](cmdb-and-reconciliation.md) の 3.2・4.1 節 |
| `ci_identifier` | 識別の値（一意の制約が重複の防止の要） | CI に従う | 同上の 4.3 節 |
| `ci_identifier_exclusion` | 「別の機器」の除外 | テナント | 同上の 5.5 節 |
| `ci_source`、`ci_source_rule`、`ci_precedence` | 取り込み元と優先度 | メタデータ | 同上の 5.1・6.2 節 |
| `ci_source_state` | 取り込み元ごとの観測の状態 | CI に従う | 同上の 6.1 節 |
| `ingest_batch`、`ingest_item` | 取り込みのまとまりと結果 | 30 日 | 同上の 5.2・5.4 節 |
| `ci_hold`、`task`（クラス `ci_duplicate_task`） | 保留 | テナント | 同上の 5.5 節 |
| `ci_merge_log` | 統合の前の状態 | 監査 | 同上の 5.6 節 |
| `ci_relation_type`（組み込みは NULL の行）、`ci_relation`、`ci_relation_source_state` | 関係 | CI に従う（型はメタデータ） | 同上の 7 節 |

### 4.11 画面・検索・レポート・API（E2・E9・E11）

| 表 | 中身 | 保持 | 定義の場所 |
| --- | --- | --- | --- |
| `form_layout`、`list_layout`、`view_rule`、`ui_rule` | 配置と画面の規則 | メタデータ | [portal-and-ui.md](portal-and-ui.md) の 4.2・4.3 節 |
| `user_list_pref` | 利用者のリストの設定 | テナント | 同上の 4.2 節 |
| `portal`、`portal_page`、`portal_theme` | ポータル | メタデータ | 同上の 6.2 節 |
| `translation` | テナントの文言の翻訳 | メタデータ | 同上の 7.2 節 |
| `search_synonym`、`search_reconcile_run` | 同義語、索引の突き合わせ | メタデータ・90 日 | [search.md](search.md) の 4.2・7.3 節 |
| `report_def`、`dashboard`、`dashboard_widget`、`report_schedule`、`report_run`、`export_job` | レポート | テナント（実行の記録は 30 日） | [reports.md](reports.md) の 3・9・10・11 節 |
| `task_daily_fact` | 日次の事実の表（月ごと） | 13 か月 | 同上の 6 節 |
| `idempotency_key` | 冪等のキー | 24 時間 | [api-and-integrations.md](api-and-integrations.md) の 4.5 節 |
| `import_source`、`transform_map` | 取り込みの定義（変換の対応は版付き） | メタデータ | 同上の 5.2 節 |
| `import_run`、`import_row` | 取り込みの実行と原本の写し | `import_row` は 30 日 | 同上の 5.2 節 |
| `webhook_subscription`、`webhook_secret`、`webhook_delivery` | Webhook | 配達は 7 日 | 同上の 6 節 |

### 4.12 運用

| 表 | 中身 | 保持 | 定義の場所 |
| --- | --- | --- | --- |
| outbox | 事象（`trace_context` を含む） | 送った後に消す（時間のパーティション） | [architecture/README.md](README.md) の 1.2 節 |
| `correctness_check_run` | 正しさの監視の結果 | 90 日 | [observability.md](observability.md) の 5 節 |
| `tenant_deletion_run` | テナントの削除 | 監査 | [security.md](security.md) の 9.1 節 |

## 5. 保持

保持の期間の正本は [security.md](security.md) の 9 節（[ADR-0053](../decisions/0053-data-retention-and-deletion.md)）。各領域の文書で「（案）」としたもの（`page`、`ci_merge_log`、`legal_hold`、API の秘密とトークン、`webhook_result` など）は、統合で 9 節の表に一本化した。4 節の保持の列は、その要約である。監査の履歴と同じ保持のものは、法務の L4 の結論で見直す。

## 6. 統合で決めたこと（2026-09-28）

各領域の文書を集めて見つかった重なり・食い違い・未確定の点を、次のとおり決めた（[architecture/README.md](README.md) の「決定（2026-09-28、既定案）」）。

| # | 点 | 決定 | 直した文書 |
| --- | --- | --- | --- |
| 1 | 3.1 節の候補の表（組み込みの行を DB に NULL の行として持つか、コードの中だけにするか） | 3 つに分けた（NULL の行、コードの版だけ、テナントの作成の時の行）。NULL の行はテナントの行が外部キーで参照するか同じ一意の空間で照合するものだけ。`number_def`・`ci_relation_type`・`ci_attribute`・`ci_identification_rule`・`flow_def`・`flow_version` を許可の一覧に足した | この文書の 3.1 節、security の 10.2 節、ADR-0054・ADR-0002 の注記、AGENTS.md |
| 2 | `task_sla.breach_disputed_at` の列の追加 | 足す。計算し直しのジョブが `breach_disputed` の事象と同じトランザクションで入れる | sla-and-calendars の 6.2・8 節、reports の 8.2 節、ADR-0047 の注記 |
| 3 | `timer` の取得の SQL がテナントをまたいで読む | `engine_scheduler` の関数 `claim_due_timers` に置き換え、識別子だけを返す | workflow-engine の 5.3・8.3 節、security の 10.4 節、ADR-0004・0015・0018 の注記 |
| 4 | 受信のメールの経路と、解決できない受け手のバウンス | infrastructure の形（mail-ingress の共有の入口と `mail-router`）に揃え、バウンスしない（後方散乱を避ける） | notifications-and-email-ingest の 5.1 節、infrastructure の 2.3 節、ADR-0034・0035 の注記 |
| 5 | `dict_table.searchable`・`dict_field.searchable` の列 | 辞書の列に足す | data-dictionary-and-tables の 3.2 節、search の 14 節 |
| 6 | レポートの定義・翻訳・画面の配置をパッケージの対象に入れるか | 配置・`view_rule`・画面の規則・翻訳は入れる。レポートとダッシュボードは `packaged` の印の付いたものだけ | data-dictionary-and-tables の 10.1 節、reports の 3 節 |
| 7 | 監査の保持の案（「（案）」と書いたもの） | security の 9 節の表に一本化した | security の 9 節、この文書の 4・5 節 |
| 8 | 組み込みのロールに `problem_manager`・`major_incident_manager` があるか | 組み込みのロールに足す（どちらも `agent` を含む）。あわせて、`requester` がポータルから自分のインシデントを作る組み込みの規則を足す | access-control の 3.3 節、itsm-processes の 11 節 |

そのほかに統合で揃えたもの：

- `ext_index` に `value_ref` を持つ（ADR-0003 の注記、[data-dictionary-and-tables.md](data-dictionary-and-tables.md) の 4.2 節）。
- CMDB の複数の値の属性（`multi`）は、CMDB の入口だけの辞書の型の例外にする（[data-dictionary-and-tables.md](data-dictionary-and-tables.md) の 3.3 節）。CI のクラスの付け替えは持ち越し。
- タイマーの種類に `page_escalation`（優先度 0）と `bulk_step`（優先度 3）を足した（4.3.1 節）。
- `delegation.scope` に `requests` を足した（[workflow-engine.md](workflow-engine.md) の 7.1 節）。

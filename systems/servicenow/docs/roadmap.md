# Roadmap: ServiceNow

## 進め方の原則

- **最初に walking skeleton を通す。** E1〜E3 で、セルとルーター・RLS と NULL の行・辞書と保存の流れ・監査の履歴・ACL の判定と出口を端から端まで貫いてから、業務の機能を広げる。テナントの分離、1 つの判定の関数、仕様から動く CI（決定表・性質・漏れの試験）は、E1 から本物の形で作る。後から足すと直せないため。
- **「0 件の約束」を先にテストにする。** ACL の漏れ、承認なしの実施、遷移の二重、重複の CI、監査の欠けは、決定表・性質・障害注入・漏れの試験（[quality.md](quality.md) の 2.2.1 節）が通ってからマージする。
- **契約を先に固定する。** 保存の流れの順序（[data-dictionary-and-tables.md](architecture/data-dictionary-and-tables.md) の 5 節）、16 の出口（[access-control.md](architecture/access-control.md) の 6.2 節）、フローの DSL（[ADR-0014](decisions/0014-flow-dsl-and-versioning.md)）、REST API と Webhook の形（[ADR-0048](decisions/0048-dictionary-driven-table-api.md)、[ADR-0050](decisions/0050-signed-webhooks-and-tenant-rate-limits.md)）は、人間がレビューして確定する。エージェントは勝手に変えない。
- **`security:sensitive` の変更は 2 人の人が承認する**（[ADR-0051](decisions/0051-threat-model-and-security-checklist.md)）。振る舞いの変更はフラグで、社内 → サブプロダクション → カナリアのセルの順に広げる（[ADR-0063](decisions/0063-flags-and-staged-release-per-cell.md)）。
- **法務の確認待ちの Story は、spec を承認しない。** 設計と、法務に依らない Story は進めてよい（[intent.md](intent.md) の「法務の確認待ち」）。下の表で「法務：L*」と書いた Story が当たる。
- **1 変更 1 PR を目安に、差分を小さくする。** 組み込みの定義（`builtin/`）の変更と、DB のマイグレーション（expand・contract）は別の PR にする（[delivery.md](architecture/delivery.md) の 4 節）。

## Epic

PM が持つ。変更の一覧はここに書かず、各変更の `spec.md` の frontmatter（`epic`）から集計する（[process.md](../../../docs/process.md) の「粒度」）。

| Epic | 目的 | 状態 |
| --- | --- | --- |
| E1 基盤 | AWS のアカウントとセル、ルーター（CloudFront Functions と KeyValueStore）、制御の面、mail-ingress、Aurora と RLS・NULL の行、鍵、CI（仕様から動く CI）、フラグ、可観測性 | 設計中 |
| E2 記録の基盤 | データ辞書、クラスの継承、カスタムのフィールドとテーブル、保存の流れ、状態のモデルの仕組み、番号、監査の履歴、メタデータの版、設定のパッケージ、画面のモデルとフォーム・リスト | 未着手（監査の履歴は法務：L1・L4） |
| E3 アクセス制御 | 利用者・グループ・ロール、ACL と判定の関数、16 の出口、キャッシュ、成り代わり、テナントの SSO、API のクライアント、運用者のアクセス、人事の取り込み | 未着手（人事の取り込みは法務：L1） |
| E4 ワークフローと承認 | フローの DSL と版、実行とタイマー、承認と代理、レコードのルール、上限と公平性、障害注入 | 未着手 |
| E5 SLA・割り当て・オンコール | 業務カレンダーと日本の祝日、SLA の計時、割り当ての規則、当番表と呼び出し（メールの経路から） | 未着手（祝日の取り込みは法務：L9） |
| E6 インシデントと問題、メール | インシデント・問題の状態、優先度、メジャーインシデント、作業の画面、通知、メールからのチケット | 未着手（メールの受信は法務：L2。画面の文言は L6） |
| E7 変更 | 種類、リスクの評価、承認の方針と CAB、予定表と衝突、凍結期間 | 未着手（承認の証跡は法務：L4） |
| E8 カタログとポータル | カタログと品目、変数、要求・要求の品目・実行のタスク、依頼者の範囲、ポータル、Web Push | 未着手 |
| E9 ナレッジと検索 | 記事と版、公開の流れ、評価と自己解決、OpenSearch の索引、ACL を効かせた検索、解析器の評価 | 未着手 |
| E10 CMDB | CI のクラスと識別、1 つの入口、調整、保留と統合、関係と影響の範囲、サービスのモデル、取り込みの API | 未着手 |
| E11 レポートと API | レポートとダッシュボード、SLA の達成率、定期の配信、REST のテーブルの API、取り込み、Webhook、レート制限 | 未着手 |
| E12 本番の準備 | 負荷試験（9 時の山）、DR とセルの移動の訓練、外部のペンテスト、保持と削除、SLO の確定、GA の判定 | 未着手（GA の判定は法務：L1・L3・L5） |
| E13 SMS・音声の呼び出し（MVP の後） | 当番の呼び出しの SMS・音声の経路と、その受け付けの本人性 | 未着手（法務：L8） |
| E14 ディスカバリーとサービスマッピング（MVP の後） | 顧客の網の中のエージェントでの収集を、CMDB の入口の取り込み元として足す | 未着手 |
| E15 本家からの移行（MVP の後） | 本家のインスタンスからのデータの取り出しと取り込み、HTML の記事の変換 | 未着手（法務：L7） |

## Story

各 Story は、着手するときに `changes/YYMMDD-<slug>/` として起票する。ここは計画で、進み具合は各変更の `spec.md` の frontmatter で見る。順序は Epic の中での目安で、依存があるものを先に置いた。各領域の文書の「Story の候補」「Epic との対応」から集め、統合で Epic の食い違いを揃えた（[architecture/README.md](architecture/README.md) の「決定（2026-09-28、既定案）」）。各 Epic の品質の重点と合否基準は [quality.md](quality.md) の 5 節にある。

### E1 基盤

設計：[infrastructure.md](architecture/infrastructure.md)、[delivery.md](architecture/delivery.md)、[observability.md](architecture/observability.md)、[security.md](architecture/security.md)、[data-model.md](architecture/data-model.md)

| Story | 内容 |
| --- | --- |
| `dev-repo-bootstrap` | ServiceNow の再構築の開発リポジトリを作り、`changes/`・`specs/`・開発向けの `AGENTS.md`、CODEOWNERS と `.github/security-sensitive-paths.yml` を置く（リポジトリ共通の ADR-0005、[delivery.md](architecture/delivery.md) の 1.1・3 節） |
| `accounts-and-scp` | management・security・log-archive・shared・edge・control・mail-ingress・`cell-*`・dev・staging のアカウントと SCP（[ADR-0055](decisions/0055-accounts-cells-and-edge-router.md)、[infrastructure.md](architecture/infrastructure.md) の 1 節） |
| `cell-terraform-module` | セルのモジュール 1 つと `cells.yaml`、台帳との突き合わせの CI（[ADR-0058](decisions/0058-terraform-layout-stages-and-cost.md)） |
| `control-plane-ledger` | 制御の面の台帳（`tenant_registry`、`inbound_address`、`cell`）とテナントの作成（[data-model.md](architecture/data-model.md) の 3.2 節） |
| `edge-router-kvs` | CloudFront Functions と KeyValueStore のルーター、セルの App の解決し直しと 421（[infrastructure.md](architecture/infrastructure.md) の 3.1 節） |
| `ses-inbound-infrastructure` | mail-ingress の SES の受信の規則、一時の S3、SNS、SQS、大阪（[notifications-and-email-ingest.md](architecture/notifications-and-email-ingest.md) の 5.1 節） |
| `mail-ingress-router` | `mail-router`：封筒の受け手 → テナント → セル、セルの S3・SQS への振り分け、解決できない受け手はバウンスしない（[infrastructure.md](architecture/infrastructure.md) の 2.3 節） |
| `osaka-warm-standby-skeleton` | 大阪の Global Database の二次、最小のタスク、KMS のレプリカ、大阪からの合成監視（[ADR-0057](decisions/0057-disaster-recovery-per-cell.md)） |
| `opensearch-domain-per-cell` | セルの OpenSearch のドメイン、VPC、IAM、Sudachi のパッケージの関連付け（[search.md](architecture/search.md) の 5.1 節） |
| `kms-keys-per-cell` | セル・用途ごとの KMS の鍵、マルチリージョン（[security.md](architecture/security.md) の 5.2 節） |
| `tenant-dek-envelope` | テナントの DEK とエンベロープ暗号化（AAD） |
| `tenant-meta-and-rls-baseline` | `tenant_meta`、FORCE RLS、`SET LOCAL` の検査を全テナントテーブルに（[ADR-0002](decisions/0002-tenancy-and-isolation.md)） |
| `rls-null-rows-and-cross-tenant-roles` | NULL の行の許可の一覧と `catalog_loader`、`engine_scheduler`（`claim_due_timers`）・`relay`・`indexer_scan`・`platform`・`maintenance` のロール、マイグレーションの CI（[ADR-0054](decisions/0054-shared-reference-rows-and-cross-tenant-roles.md)、[security.md](architecture/security.md) の 10 節） |
| `outbox-and-relay` | outbox（`trace_context`）、Relay、SQS、DLQ（[architecture/README.md](architecture/README.md) の 1.2 節） |
| `platform-audit-and-log-archive` | プラットフォームの監査、log-archive の Object Lock |
| `ci-pipeline-baseline` | PR の CI の段（lint、型、単体、結合、マイグレーションの規則、テストのデータの検査）と merge queue（[delivery.md](architecture/delivery.md) の 2.1 節） |
| `spec-table-loader` | `spec.md` の決定表を読み込む道具と、最後の行のケースの検査（[ADR-0062](decisions/0062-spec-driven-ci-fault-injection-and-leak-suite.md)） |
| `id-traceability-ci` | `REQ`・`PROP`・`DT`・`SEC` の追跡と ID の重複の検査 |
| `sec-checklist-traceability-ci` | `SEC-` の表とテストの参照の CI（[ADR-0051](decisions/0051-threat-model-and-security-checklist.md)） |
| `cell-staged-deploy` | control・mail-ingress → cell-s01 → 共有のセル → 専用のセルの段と承認（[ADR-0063](decisions/0063-flags-and-staged-release-per-cell.md)） |
| `appconfig-flags-per-cell-tenant` | セル・テナントの単位のフラグ、ガードのアラーム |
| `telemetry-package` | `packages/telemetry`、Collector の許可の一覧、ログの走査と合成の値、アラートの runbook の注釈の CI（[observability.md](architecture/observability.md) の 2・8 節） |
| `edge-availability-sli` | CloudFront のリアルタイムのログからのセル別の可用性、バーンレートのアラート（[ADR-0059](decisions/0059-slis-timer-lag-and-correctness-monitors.md)） |
| `engine-scheduled-scaling` | engine・app の平日 8:50 の予定の台数の拡大、国民の祝日の扱い（[capacity.md](architecture/capacity.md) の 2.2 節） |

### E2 記録の基盤

設計：[data-dictionary-and-tables.md](architecture/data-dictionary-and-tables.md)、[portal-and-ui.md](architecture/portal-and-ui.md) の 4・7 節、[itsm-processes.md](architecture/itsm-processes.md) の 3 節、[delivery.md](architecture/delivery.md) の 4 節

| Story | 内容 |
| --- | --- |
| `dictionary-core` | 辞書の表（`searchable` を含む）、組み込みの定義の NULL の行への読み込み、実効の辞書のコンパイル、Zod のスキーマ（PROP-DICT-001） |
| `field-types-and-validation` | 14 種の型と DT-DICT-001 |
| `class-inheritance-and-overrides` | 子のクラス、上書き、深さの上限 |
| `task-and-ci-physical-tables` | `task`・`ci`・`custom_record` と索引、`version` の楽観的な排他 |
| `ext-and-extension-index` | `ext` と `ext_index`（`value_ref` を含む）、索引を写すジョブ（PROP-DICT-002） |
| `reference-integrity` | `on_delete`、日次の整合の検査 |
| `save-pipeline` | 保存の流れの 11 段と差し込み口、保存のスパンとヒストグラム |
| `process-model-engine` | 状態のモデルの遷移の表と保存の流れでの照合（PROP-INC-001） |
| `field-lifecycle` | 非表示と消すジョブ、DT-DICT-002 |
| `record-audit-and-journal` | `record_change`・`journal_entry`（PROP-DICT-003）。法務：L1・L4 |
| `audit-digest-verify` | 日次のハッシュの鎖と、監査の担当の突き合わせの道具 |
| `record-numbering` | 番号（PROP-DICT-004） |
| `meta-version-cache` | `meta_version` とキャッシュの入れ替え |
| `config-packages` | 設定のパッケージ（配置・画面の規則・翻訳、`packaged` のレポートを含む。DT-PKG-001、PROP-PKG-001〜003） |
| `metadata-compile-check-task` | リリースの前の全テナントのメタデータのコンパイルの検査（[ADR-0064](decisions/0064-migrations-and-metadata-compatibility-check.md)） |
| `builtin-definition-checks` | `builtin/` の検査（ACL の規則のコンパイル、`deny_unless` の消失、文言のキー） |
| `ui-model-api` | 画面のモデル、キャッシュ（PROP-UI-002） |
| `form-and-list-layouts` | 配置、`view_rule`、組み込みの既定（コードの版） |
| `ui-rules-shared-evaluator` | 画面の規則の共有の評価器、DT-UI-001（PROP-UI-001） |
| `list-keyset-paging-and-capped-count` | キーセットのページ送りと上限付きの件数（PROP-UI-003） |
| `form-conflict-merge` | 409 の画面 |
| `i18n-message-catalogs` | 組み込みの文言の辞書、キーの抜けの CI |
| `tenant-translations` | 翻訳の表、訳のない文言の一覧 |
| `attachment-malware-scan` | 添付のマルウェアの検査（[security.md](architecture/security.md) の 5.3 節） |

### E3 アクセス制御

設計：[access-control.md](architecture/access-control.md)、[api-and-integrations.md](architecture/api-and-integrations.md) の 3 節、[security.md](architecture/security.md) の 8 節

| Story | 内容 |
| --- | --- |
| `principals-users-groups-roles` | 主体の表、組み込みのロール（`major_incident_manager`・`problem_manager` を含む）、ロールの閉包 |
| `group-member-assignability` | `group_member` の列の追加、不在の予定（[assignment-and-on-call.md](architecture/assignment-and-on-call.md) の 4.1 節） |
| `acl-rule-model-and-decide` | `decide`、DT-ACL-001・002（PROP-ACL-001・002） |
| `acl-condition-compiler` | 述語へのコンパイル、保存の時の検証（PROP-ACL-003） |
| `acl-exits-null-semantics` | `visible(f)` と 16 の出口、DT-ACL-003（PROP-ACL-004） |
| `acl-version-cache` | `acl_version`（PROP-ACL-005） |
| `builtin-acl-rules` | 組み込みの規則（`requester` のポータルからのインシデントの作成を含む） |
| `acl-leak-suite` | 16 の出口の漏れの試験と、夜間の CI への組み込み。後の Epic が出口を足すたびに広げる |
| `leak-synthetic-monitor` | 本番の漏れの合成監視（監視用のテナント・利用者・印。[observability.md](architecture/observability.md) の 5 節） |
| `acl-explain` | 「なぜ見えないか」の画面と API |
| `impersonation` | 成り代わり（DT-IMP-001、PROP-ACL-006） |
| `tenant-sso-saml-oidc` | テナントの SSO（DT-SSO-001）、ドメインの確認、IdP の証明書の切り替え |
| `break-glass-admins` | テナントの非常用の管理者 |
| `api-clients-and-oauth` | API のクライアント、クライアントクレデンシャル、認可コード＋PKCE、スコープ |
| `user-notification-preferences` | 利用者の通知の設定 |
| `support-access-grant` | 運用者のサポートの参照の許可と運用の画面（[ADR-0052](decisions/0052-keys-encryption-and-operator-access.md)） |
| `break-glass-and-operator-jit` | 運用者の期限付きの権限と、四半期のアクセスのレビュー |
| `hr-import-principals` | 人事のシステムからの利用者・部署・上長・グループの取り込み（法務：L1） |

### E4 ワークフローと承認

設計：[workflow-engine.md](architecture/workflow-engine.md)、[capacity.md](architecture/capacity.md) の 2.2 節

| Story | 内容 |
| --- | --- |
| `flow-dsl-schema-and-validation` | フローの文書と DT-FLOW-001 |
| `flow-versioning-and-publish` | 版と公開、組み込みのフローの NULL の行（PROP-FLOW-004） |
| `record-triggers-in-save-tx` | 保存のトランザクションの中のトリガー、原因の連鎖（PROP-FLOW-002） |
| `flow-runner-and-timers` | 実行とタイマー、`claim_due_timers` からの取得、DT-FLOW-002（PROP-FLOW-001） |
| `flow-wait-condition` | `flow_wait` と保存の時の照合、期限 |
| `flow-run-as` | 実行の主体 |
| `webhook-step-and-idempotency` | `call_webhook`、冪等のキー（`iteration`）、SSRF の対策 |
| `stuck-run-reconciler` | 止まった実行の回収（PROP-FLOW-005） |
| `record-rules` | レコードのルール（[ADR-0017](decisions/0017-no-code-record-rules.md)） |
| `approvals-core` | 承認のまとまりと回答、DT-APR-001（PROP-FLOW-003） |
| `approval-delegation-and-due` | 代理（`delegation.scope`）と期限切れ |
| `flow-limits-and-fairness` | 上限、テナントの取り分、優先度（`page_escalation`・`bulk_step` を含む。PROP-FLOW-006・007） |
| `flow-fault-injection-suite` | 障害の点と、PR・夜間の CI への組み込み |
| `timer-lag-sli` | コミットの時刻での遅れ、期限を過ぎたタイマーの毎分の数え、止まった実行の監視 |
| `timer-burst-generator` | タイマーの山の生成の道具と、仮の構成での負荷試験 |
| `schedule-trigger-jitter` | 定期のトリガー・日次のジョブの 0〜5 分のばらつき（[ADR-0061](decisions/0061-load-model-cell-sizing-and-timer-bursts.md)） |
| `flow-admin-ui` | フローの編集・公開・実行の一覧と詳細・一括の取り消し |

### E5 SLA・割り当て・オンコール

設計：[sla-and-calendars.md](architecture/sla-and-calendars.md)、[assignment-and-on-call.md](architecture/assignment-and-on-call.md)

| Story | 内容 |
| --- | --- |
| `business-time-functions` | 業務時間の区間と計時の関数、参照の実装（PROP-SLA-001〜008）と CI の比較 |
| `calendar-model-and-versions` | カレンダーの版、DT-CAL-001、既定のカレンダー（テナントの作成の時の行） |
| `jp-holiday-import` | 内閣府の CSV の取り込み、DT-HOL-001（PROP-HOL-001）、承認の画面（法務：L9） |
| `tenant-holiday-sets` | テナントの祝日の集合 |
| `holiday-coverage-monitor` | 収録の範囲の監視 |
| `sla-definition-model` | SLA の定義と版 |
| `sla-clock-evaluation-in-save` | 保存の時の評価、DT-SLA-001（PROP-SLA-009） |
| `sla-retroactive-pause` | さかのぼりの一時停止 |
| `sla-timers-and-notifications` | 警告と違反のタイマー、DT-SLA-002 |
| `sla-recalculation-job` | 計算し直し、`breach_disputed` と `breach_disputed_at`（PROP-SLA-010） |
| `sla-remaining-time-api` | 残り時間の API と画面の部品 |
| `sla-correctness-monitors` | 期限を過ぎた未発火の違反、SLA の抜き取りの計算し直し、SLA の合成監視 |
| `business-time-wait` | フローの業務時間の待ち（workflow-engine と一緒に） |
| `assignment-rules` | 割り当ての規則、DT-ASG-001（PROP-ASG-001・003） |
| `member-selection` | 担当者の選び方、DT-ASG-002（PROP-ASG-002） |
| `skills` | スキルの表と画面 |
| `on-call-schedules` | 当番表と当番の関数（PROP-ONC-001〜003） |
| `on-call-overrides` | 差し替え |
| `escalation-policies-and-paging` | 方針と呼び出しの状態機械、`page_escalation`、DT-PAGE-001（PROP-PAGE-001・002） |
| `pager-channel-interface` | 経路の差し込み口とメールの経路。プッシュの経路は E8 の `web-push-and-pwa` の後にフラグで有効にする |
| `paging-ack-channels` | 受け付け（メールのリンクからのログイン。プッシュは E8 の後） |

### E6 インシデントと問題、メール

設計：[itsm-processes.md](architecture/itsm-processes.md) の 4〜7 節、[notifications-and-email-ingest.md](architecture/notifications-and-email-ingest.md)、[portal-and-ui.md](architecture/portal-and-ui.md) の 5 節

| Story | 内容 |
| --- | --- |
| `incident-lifecycle` | インシデントの状態、DT-INC-001、自動の完了 |
| `incident-acl-defaults` | インシデント・問題の既定の規則（担当のグループ、依頼者本人） |
| `priority-matrix` | 優先度の表、DT-PRIO-001・002（PROP-PRIO-001） |
| `incident-default-slas` | 組み込みの SLA の定義（応答・解決・OLA、一時停止の既定。テナントの作成の時の行） |
| `major-incident-candidates` | 候補、DT-MIM-001、トリガーの規則（PROP-MIM-001） |
| `major-incident-promotion-and-cascade` | 昇格、`major_incident_response` のフロー、子への伝播 |
| `major-incident-paging` | 昇格からの当番の呼び出し |
| `major-incident-ui` | メジャーインシデントの画面 |
| `problem-lifecycle-and-known-error` | 問題の状態、DT-PRB-001、既知のエラーの印（記事は E9） |
| `problem-incident-propagation` | 問題の解決の伝播の `bulk_job` |
| `agent-workspace-core` | 自分の作業、フォームの帯、作業メモの時系列、キーボードの操作 |
| `incident-number-and-audit-view` | 番号・履歴・作業メモの表示 |
| `notification-rules-and-templates` | 通知の規則とテンプレート（PROP-NTF-002） |
| `notifier-outbound-email` | 送信、ヘッダー、送った ID の記録（PROP-NTF-001） |
| `tenant-sending-domain` | テナントの独自の送信のドメイン |
| `bounce-and-suppression` | 配信の失敗と抑止のリスト |
| `inbound-email-pipeline` | 受信の冪等（PROP-MAIL-001）（法務：L2） |
| `inbound-threading` | 紐付け、参照の印、DT-MAIL-001（法務：L2） |
| `inbound-reply-and-sender-trust` | 返信の追記と差出人の信頼、DT-MAIL-002・003（PROP-MAIL-004）（法務：L2） |
| `inbound-new-record-rules` | 受信の規則（法務：L2） |
| `inbound-body-extraction` | 本文の取り出しと添付（法務：L2） |
| `mail-loop-prevention` | ループの防止、DT-MAIL-004（PROP-MAIL-002） |
| `japanese-mime-decoding` | 文字コードの復号、DT-MAIL-005（PROP-MAIL-003） |
| `inbound-quarantine-ui` | 保留の一覧と処理の画面 |
| `email-ingest-sli` | メールの取り込みの SLI、メールの合成監視、ループの兆し（[observability.md](architecture/observability.md) の 3・7.2 節） |

### E7 変更

設計：[itsm-processes.md](architecture/itsm-processes.md) の 8・9 節

| Story | 内容 |
| --- | --- |
| `change-models` | 変更の種類と状態、DT-CHG-001（PROP-CHG-001・002）（法務：L4） |
| `standard-change-templates` | 標準の変更の雛形 |
| `change-risk-assessment` | リスクの評価、DT-RISK-001 |
| `change-approval-policy-flows` | 承認の方針、DT-CHG-002（組み込みのフロー `change_approval_policy`）、テナントの設定の表 `change_approval_policy_rule` と DT-CHG-003（[itsm-processes.md](architecture/itsm-processes.md) の 8.5.1 節）（法務：L4） |
| `cab-meetings` | CAB の会議 |
| `change-windows-and-freeze` | 禁止期間・保守の時間帯・凍結期間 |
| `change-conflict-detection` | 衝突の関数、DT-CONF-001（PROP-CONF-001・002） |
| `change-impact-snapshot` | 影響の範囲の写し（cmdb と一緒に） |
| `change-schedule-view` | 予定表 |
| `change-calendar-and-cab-ui` | 予定表と CAB の会議の画面 |
| `ecab-paging` | 緊急の変更の ECAB の呼び出し |
| `change-approval-reconciliation` | 承認の決着のない `implement` の日次の突き合わせ |

### E8 カタログとポータル

設計：[service-catalog-and-requests.md](architecture/service-catalog-and-requests.md)、[portal-and-ui.md](architecture/portal-and-ui.md) の 6 節

| Story | 内容 |
| --- | --- |
| `catalog-and-categories` | カタログ、カテゴリ、`audience` |
| `catalog-item-versions` | 品目の版、DT-CAT-001（PROP-VAR-003） |
| `catalog-variables-and-ui-rules` | 変数と UI の規則、DT-VAR-001（PROP-VAR-001・002） |
| `request-submission` | 申請と `submission_key`（PROP-REQ-001） |
| `request-item-stages-and-rollup` | 状態の導出、DT-REQ-001（PROP-REQ-002） |
| `catalog-fulfillment-flows` | 実行のフローと組み込みの雛形 |
| `request-cancellation` | 取り消し |
| `requester-acl` | 依頼者の範囲、DT-REQ-002（PROP-REQ-003）とポータルの出口の漏れの試験 |
| `request-for-others` | 他人のための申請、DT-REQ-003（`delegation.scope = requests`） |
| `record-producers` | フォームからのレコードの作成（インシデントの報告） |
| `portal-shell-and-themes` | ポータルの画面の束、テーマ、コントラストの検査 |
| `portal-catalog-ui` | カタログと申請の画面 |
| `portal-approvals-mobile` | スマートフォンでの 1 回の操作の承認 |
| `web-push-and-pwa` | Web Push、購読、当番の端末のセッション。E5 の呼び出しのプッシュの経路を有効にする |
| `portal-rum` | RUM の送信（ポータルの LCP。[portal-and-ui.md](architecture/portal-and-ui.md)、[observability.md](architecture/observability.md) の 3 節） |

### E9 ナレッジと検索

設計：[knowledge.md](architecture/knowledge.md)、[search.md](architecture/search.md)

| Story | 内容 |
| --- | --- |
| `kb-bases-and-categories` | ナレッジベースとカテゴリ（既知のエラーのナレッジベースはテナントの作成の時の行） |
| `kb-articles-and-versions` | 記事と版、DT-KB-001（PROP-KB-001） |
| `kb-markdown-rendering` | 制限付きの Markdown とサニタイズ |
| `kb-publish-approval` | 公開の流れ（PROP-KB-002） |
| `kb-validity-and-review` | 有効の期限と見直し |
| `kb-read-acl` | 読める範囲（PROP-KB-003） |
| `kb-ratings-and-flags` | 評価と旗、DT-KB-002（PROP-KB-005） |
| `known-error-articles` | 問題からの既知のエラーの記事 |
| `portal-deflection-events` | 自己解決の事象 |
| `deflection-metrics` | 自己解決の数え方、DT-KB-003（PROP-KB-004） |
| `search-analyzer-evaluation` | 解析器の評価と決定の確認、評価の CI |
| `index-layout-and-mappings` | 索引の配置、入れ子の枠、`routing` |
| `indexer-outbox-external-version` | 索引への反映（PROP-SRCH-004） |
| `acl-predicate-to-search-filter` | 述語の写し、DT-SRCH-001（PROP-SRCH-002） |
| `search-db-recheck-and-highlight` | DB での確かめ直しと強調（PROP-SRCH-001・003・005） |
| `knowledge-search-and-portal-suggest` | ナレッジの検索とポータルの候補 |
| `catalog-search` | カタログの検索 |
| `catalog-form-kb-suggestions` | 品目の入力の途中の候補の記事 |
| `index-reconcile-and-rebuild` | 突き合わせと作り直し |
| `search-leak-suite` | 検索の出口の漏れの試験 |

### E10 CMDB

設計：[cmdb-and-reconciliation.md](architecture/cmdb-and-reconciliation.md)、[api-and-integrations.md](architecture/api-and-integrations.md) の 5.5 節

| Story | 内容 |
| --- | --- |
| `ci-class-hierarchy` | CI のクラスと属性、`multi` の属性（辞書の例外） |
| `identification-rules-and-normalization` | 識別の規則と正規化（PROP-CMDB-007） |
| `ci-ingest-entry-point` | 1 つの入口、DT-CMDB-001・003（PROP-CMDB-001・003・008） |
| `ci-hold-and-duplicate-tasks` | 保留と重複の候補（PROP-CMDB-004） |
| `ci-merge` | 統合（PROP-CMDB-005） |
| `attribute-reconciliation` | 取り込み元ごとの状態と `choose`、DT-CMDB-002（PROP-CMDB-002） |
| `ci-staleness` | 最後に見た時刻と廃止の候補 |
| `ci-relations` | 関係、DT-CMDB-004 |
| `dynamic-ci-groups` | 動的な CI のまとまり |
| `impact-traversal` | 影響の範囲の走査（PROP-CMDB-006）と計測 |
| `service-model` | サービスのモデルと画面 |
| `cmdb-ingest-api` | `POST /api/v1/cmdb/ingest` |
| `cmdb-csv-import` | CSV の取り込みの道具 |
| `cmdb-manual-edit-via-entry` | 画面の手入力を入口に通す |
| `duplicate-detection-job` | 日次の重複の検出 |
| `ci-search` | CI の索引と参照の候補 |
| `ci-form-provenance-and-impact` | CI の画面の来歴と影響の範囲 |
| `impact-for-change-and-incident` | 変更とメジャーインシデントの画面の影響の範囲 |

### E11 レポートと API

設計：[reports.md](architecture/reports.md)、[api-and-integrations.md](architecture/api-and-integrations.md)

| Story | 内容 |
| --- | --- |
| `report-definition-and-runner` | レポートの定義、reader B、上限 |
| `report-acl-aggregation` | ACL を効かせた集計、DT-RPT-001（PROP-RPT-001・002） |
| `report-result-cache` | 結果のキャッシュ（PROP-RPT-003） |
| `task-daily-facts` | 日次の事実の表 |
| `sla-attainment-report` | 達成率、DT-RPT-002（`breach_disputed_at`。PROP-RPT-004・005） |
| `builtin-reports` | 組み込みのレポート |
| `dashboards` | ダッシュボード |
| `scheduled-report-delivery` | 定期の配信 |
| `report-export-csv` | エクスポート |
| `report-leak-suite` | 集計の出口の漏れの試験 |
| `itsm-process-reports` | 状態ごとの滞留、変更の成功率、メジャーインシデントの件数 |
| `kb-reports` | 閲覧・評価・自己解決の率 |
| `catalog-answer-reports` | `answer_index` を使う集計 |
| `table-api-dictionary-driven` | テーブルの API（PROP-API-002） |
| `api-query-language-and-cursor` | `q`・`cursor`・`count=capped` |
| `api-idempotency-and-etag` | 冪等と `If-Match`、DT-API-001（PROP-API-001） |
| `api-problem-details-and-versions` | エラーと API の版 |
| `tenant-openapi` | テナントの OpenAPI |
| `import-runs-and-transform-maps` | 取り込み、DT-IMP-001（PROP-IMP-001・002） |
| `webhook-subscriptions-and-delivery` | Webhook、DT-WH-001（PROP-WH-002） |
| `webhook-signing-and-rotation` | 署名と入れ替え（PROP-WH-001） |
| `tenant-rate-limits` | レート制限 |

### E12 本番の準備

設計：[capacity.md](architecture/capacity.md)、[infrastructure.md](architecture/infrastructure.md) の 4・6 節、[security.md](architecture/security.md) の 9・11 節、[delivery.md](architecture/delivery.md) の 6 節

| Story | 内容 |
| --- | --- |
| `timer-burst-load-test` | 9 時のタイマーの山と 1 テナントの暴走の負荷試験（本番の構成。[quality.md](quality.md) の 2.2.1 節） |
| `task-table-scale-test` | `task` 7,000 万行のリストとフォーム |
| `api-load-and-abuse-test` | API のピークとレート制限 |
| `cmdb-ingest-load-test` | 1,000 CI/秒 |
| `report-load-test` | 月初のレポートとダッシュボード |
| `paging-fault-injection` | 呼び出しの障害注入 |
| `search-rebuild-drill` | 大阪での索引の作り直しの時間 |
| `dr-failover-drill` | DR の訓練と失った範囲の取り込み直し |
| `tenant-cell-move-drill` | セルの間のテナントの移動 |
| `dedicated-cell-provisioning` | 専用のセル |
| `quota-increases` | クォータの引き上げ |
| `cost-baseline` | 費用の基準とセル別の配分 |
| `slo-and-alert-tuning` | SLO の確定、アラートの値の調整、9 時の山の系列、キャパシティの見直しの手順 |
| `tenant-selectable-changes` | 選べる変更（最大 60 日）とガードの確定 |
| `accessibility-audit` | 手での検査（NVDA・VoiceOver） |
| `external-pentest` | 外部のペンテスト（出口の推測、成り代わり、分離、SSO、メール、Webhook） |
| `tenant-deletion-job` | テナントの削除 |
| `retention-jobs` | 保持のジョブとパーティションの `DROP` |
| `legal-items-closure` | 法務の論点の確定と保持の期間の確定（法務：L1〜L9） |
| `ga-review` | GA の判定（[quality.md](quality.md) の 5 節の E12 の基準） |

### E13 SMS・音声の呼び出し（MVP の後）

設計：[assignment-and-on-call.md](architecture/assignment-and-on-call.md) の 6.5 節

| Story | 内容 |
| --- | --- |
| `sms-voice-ack-adr` | SMS・音声の受け付けの本人性を決める ADR（[assignment-and-on-call.md](architecture/assignment-and-on-call.md) の 6.5 節。法務：L8） |
| `pager-sms-voice` | `PagerChannel` の `sms`・`voice` の実装（法務：L8） |

### E14 ディスカバリーとサービスマッピング（MVP の後）

設計：[cmdb-and-reconciliation.md](architecture/cmdb-and-reconciliation.md) の 1・14 節

| Story | 内容 |
| --- | --- |
| `discovery-agent-adr` | 顧客の網の中で動く部品の配布・更新・セキュリティの ADR（[cmdb-and-reconciliation.md](architecture/cmdb-and-reconciliation.md) の 1 節） |
| `discovery-source` | ディスカバリーを入口の取り込み元 `discovery` として足し、優先度の既定を決める |
| `network-adapter-identification` | アダプターの表の識別が要るなら、別の ADR で足す（[ADR-0036](decisions/0036-ci-classes-and-identification-rules.md)） |

### E15 本家からの移行（MVP の後）

設計：[api-and-integrations.md](architecture/api-and-integrations.md) の 5 節、[knowledge.md](architecture/knowledge.md) の 3.5 節

| Story | 内容 |
| --- | --- |
| `migration-extract-tool` | 本家のインスタンスからの取り出し（[intent.md](intent.md) の L7。法務：L7） |
| `migration-transform-maps` | 取り込みの変換の対応の雛形（[api-and-integrations.md](architecture/api-and-integrations.md) の 5 節） |
| `kb-html-to-markdown` | HTML の記事の変換（[knowledge.md](architecture/knowledge.md) の 3.5 節） |

## エージェントに任せないこと

- **契約（保存の流れの順序、16 の出口、フローの DSL、REST API と Webhook の形）の確定**。
- **`security:sensitive` の承認**：Dev のテックリードとセキュリティの担当の 2 人が行う。
- **国民の祝日の版の公開の承認**：運用者 2 人（[ADR-0020](decisions/0020-japanese-holiday-data.md)）。
- **CMDB の統合**：`cmdb_admin` の人だけ（[ADR-0037](decisions/0037-ci-ingest-entry-point-and-ambiguity-hold.md)）。
- **リージョンの切り替えの判断**：インシデントの指揮者と Ops の責任者。
- **法務の判断**（L1〜L9）。
- **負荷試験の結果の解釈**：数字は出せるが、セルの大きさと優先度 2・3 の遅れの許容の判断は Ops と PM。

## 後回しにしたもの

MVP の後に検討する。着手するときに `intent.md` から起票する（[intent.md](intent.md) の「MVP の後の Epic で扱う」と Non-goals）。E13〜E15 に入れなかったもの。

- **イベント管理と AIOps**、**HR・CSM のアプリ**、**仮想エージェント**（生成 AI の利用の方針の intent の後）、**テナントのカスタムアプリ（任意のコード）**（別の ADR。[ADR-0001](decisions/0001-platform-and-stack.md)）、**資産管理とベンダーの管理**、**海外のリージョン**（S3）。
- 辞書：**通貨・複数選択の型**、参照の複数選択の変数（[data-dictionary-and-tables.md](architecture/data-dictionary-and-tables.md) の 15 節）。**CI のクラスの付け替え**（辞書の「クラスを変えない」の例外の ADR が要る）。
- CMDB：**統合を戻す操作**、部分の識別（`allow_partial`）、動的な調整の規則。
- ワークフロー：**メールでの承認**（署名付きの一回だけのリンク）、テナントのコードのステップ。
- ITSM：影響度の自動の設定、機械学習によるリスクの予測、CAB の会議のリアルタイムの画面、標準の変更の雛形の自動の廃止。
- レポート：**外部の受け手への定期の配信**、件数だけの権限、PNG・PDF の配信、S2 の分析の置き場所。
- API：承認・遷移の専用の操作の API、長く有効な API キー、mTLS、差分の取り出し。
- 画面：**ネイティブのアプリ**、在席の表示、読みでの並べ替え、和暦。
- ナレッジと検索：多言語の記事、匿名の閲覧、`minor_fix`、意味の検索、添付の本文の検索、テナントの利用者の辞書、検索の語の集計の分析。
- メール：ARC の扱い、通知のまとめ（1 日の要約）、ISO-2022-JP での送信。
- 基盤とセキュリティ：**顧客の管理する鍵**（専用のセル）、カスタムドメイン、RTO 15 分の自動の切り替え（S2）、S3 のレプリケーションの時間の保証（RTC）、S2・S3 のセルの構成。
- SLA：相対の長さ（「翌営業日の 12 時まで」）、海外の祝日の公式のデータの取り込み。

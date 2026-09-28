# ITSM processes: ServiceNow

インシデント・問題・変更の状態のモデル、優先度の表（影響度 × 緊急度）、メジャーインシデント、問題と既知のエラー、変更の種類（標準・通常・緊急）、リスクの評価、承認の方針と CAB、変更の予定表・衝突の検知・凍結期間を決める。

前提の決定は、タスクの階層を 1 つの表 `task` に置くこと（[ADR-0003](../decisions/0003-table-hierarchy-and-extensible-schema.md)、[ADR-0007](../decisions/0007-physical-layout-and-extension-index.md)）、遷移をレコードと同じトランザクションで 1 回だけ行うこと（[ADR-0004](../decisions/0004-workflow-and-sla-engine.md)）、承認を承認のまとまりと個々の承認の行で持ち、変更では本人の承認と期限切れの自動の承認を禁止すること（[ADR-0016](../decisions/0016-approvals.md)）、影響の範囲を CMDB の関係のグラフから求めること（[ADR-0005](../decisions/0005-cmdb-identification-and-reconciliation.md)）である。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0022](../decisions/0022-process-state-machines.md) | インシデント・問題・変更の状態のモデルは、コードの版に含む宣言の遷移の表で持つ。状態の変更は保存の流れの中で表と照合し、表にない遷移は 422 にする。テナントは状態と辺を足せず、条件（必須のフィールド）と保留の理由だけを足せる。既知のエラーは問題の状態ではなく印にする |
| [0023](../decisions/0023-priority-matrix-and-major-incident.md) | 優先度は影響度 × 緊急度の表から導き、利用者は直接書けない。上書きは専用の権限と理由を要る。メジャーインシデントは候補の行（提案 → 昇格・却下）で扱い、自動では昇格させない。昇格したインシデントを親にし、子の解決は非同期のまとめての更新で行う |
| [0024](../decisions/0024-change-models-risk-and-cab.md) | 変更の種類ごとに状態のモデルを持つ。リスクは規則の条件と質問票の得点の高いほうにする。承認の方針は種類 × リスクの決定表で決め、組み込みのフローで承認を依頼する。CAB の会議は議題と記録を持つが、承認は各承認者の回答として 1 件ずつ反映する。緊急の変更も、1 人以上の承認なしに「実施」へ進めない |
| [0025](../decisions/0025-change-schedule-and-conflict-detection.md) | 禁止期間と保守の時間帯は、業務カレンダーと同じ半開区間の表現で、CI の条件に結び付けて持つ。衝突は純粋な関数で求め、保存の時と「予定済み」への遷移の時に評価する。禁止期間（凍結期間を含む）に重なる変更は、例外の承認なしに「予定済み」へ進めない。ほかの衝突は警告にする |

この文書の決定表・性質は設計の草案である。ID は E6・E7 の各変更の `spec.md` に移すときに確定する。

## 1. 目的と範囲

- 扱う：インシデント・問題・変更（と、その子のタスク）の状態、遷移の条件、保留の理由、自動の完了、再オープン、優先度の導出と上書き、メジャーインシデントの候補と昇格、親子のインシデント、問題とインシデントの関係、既知のエラー、変更の種類と標準の変更の雛形、リスクの評価、承認の方針、CAB の会議、変更の予定表、禁止期間と保守の時間帯、衝突の検知。
- 扱わない：承認の仕組み（[workflow-engine.md](workflow-engine.md) の 7 節）、SLA の計時（[sla-and-calendars.md](sla-and-calendars.md)。一時停止の条件の既定だけをこの文書で決める）、割り当て（[assignment-and-on-call.md](assignment-and-on-call.md)）、要求と要求の品目（[service-catalog-and-requests.md](service-catalog-and-requests.md)）、既知のエラーの記事の中身と公開の流れ（[knowledge.md](knowledge.md)）、メールからの起票（[notifications-and-email-ingest.md](notifications-and-email-ingest.md)）、影響の範囲の走査の中身（[cmdb-and-reconciliation.md](cmdb-and-reconciliation.md)）、画面（`portal-and-ui.md`）。
- **状態の遷移は Record Service の保存の流れの中でだけ起きる。** 画面の操作（「解決」「承認を依頼」など）、API、フロー、メールは、どれも同じ遷移の表で判定される。

## 2. 本家の形（確かめたこと）

| 項目 | 本家 | 出典（2026-09-28 に確認） |
| --- | --- | --- |
| インシデントの状態 | 新規、対応中、保留、解決、完了、取り消し。保留には理由（依頼者の回答待ち、変更待ち、問題待ち、ベンダー待ち）がある | コミュニティの記事と検索の結果の抜粋（[Incident Management State Model KB0564465](https://support.servicenow.com/kb?id=kb_article_view&sysparm_article=KB0564465) など）。公式の文書の本文は未検証 |
| 解決の後の自動の完了 | 解決から一定の日数で自動で完了にする設定がある。既定は 7 日とされる | コミュニティの記事（[Auto close configuration](https://www.servicenow.com/community/itsm-articles/incident-auto-close-configuration/ta-p/2302132)）。既定の値は未検証 |
| 優先度 | 優先度は読み取り専用で、影響度と緊急度から、データの参照の規則（一致の列と設定の列）で決まる。既定の 3 × 3：高・高 → 1、高・中 → 2、高・低 → 3、中・高 → 2、中・中 → 3、中・低 → 4、低・高 → 3、低・中 → 4、低・低 → 4 | [Define priority lookup rules](https://www.servicenow.com/docs/r/it-service-management/incident-management/def-prio-lookup-rules.html) |
| メジャーインシデント | 候補は、トリガーの規則、担当者の提案、直接の作成で作る。状態は提案・昇格・却下。昇格すると親のインシデントを作り、候補を子にする。解決・完了・取り消しのインシデントからは提案できない | [Create a major incident candidate](https://www.servicenow.com/docs/bundle/zurich-it-service-management/page/product/incident-management/task/create-major-incident-candidate.html) |
| 問題の状態 | 新規、評価、根本原因の分析、修正中、解決、完了。既知のエラーは状態ではなく分類として扱う | コミュニティの記事と検索の結果の抜粋（[Investigate root cause of a problem](https://www.servicenow.com/docs/bundle/zurich-it-service-management/page/product/problem-management/task/investigate-root-cause.html) の存在を確認）。状態の一覧の公式の本文は未検証 |
| 変更の状態 | 通常：新規 → 評価 → 承認 → 予定済み → 実施 → 振り返り → 完了。標準：新規 → 予定済み → 実施 → 振り返り → 完了。緊急：新規 → 承認 → 予定済み → 実施 → 振り返り → 完了。振り返りと完了は取り消せない。遷移は時間の経過ではなく、条件・操作・承認の結果で起きる | [State progression for change models](https://www.servicenow.com/docs/r/it-service-management/change-management/normal-standard-emergency-states.html) |
| 標準の変更 | 雛形の提案を変更管理のチームが承認すると、カタログに加わる。雛形から作った変更は人の承認を要らない | [Propose a standard change template](https://www.servicenow.com/docs/bundle/xanadu-it-service-management/page/product/change-management/task/propose-standard-chg-template.html)（検索の結果の抜粋で確認。本文は未検証） |
| リスクの評価 | 質問票（重み付きの得点としきい値）と、リスクの条件（規則）を持つ。両方を定義すると条件が優先するとされる | コミュニティの記事と KB（[KB0825522](https://support.servicenow.com/kb?id=kb_article_view&sysparm_article=KB0825522)、検索の結果の抜粋）。未検証 |
| CAB | CAB の作業台で、会議の議題（変更の一覧）、議題ごとの時間、出席者、決定の記録を扱う。議題の決定は会議の記録に残る | [CAB meeting management using the CAB workbench](https://www.servicenow.com/docs/r/it-service-management/change-management/manage-cab-meeting-using-cab-workbench.html) |
| 衝突の検知 | CI がすでに予定済み、親・子の CI がすでに予定済み、CI が保守の時間帯の外、親・子が保守の時間帯の外、CI が禁止期間の中、親・子が禁止期間の中、担当者がすでに予定済み。CI・予定の開始と終わりが入ったとき、変わったとき、状態が変わったときに動く | [Conflict detection](https://www.servicenow.com/docs/r//washingtondc/it-service-management/change-management/c_ConflictDetection.html) |
| 衝突の設定 | 次の空きの探索は 90 日・候補 100 件、衝突の件数の上限 1,000、連続する変更を許す、など | [Detect change conflicts](https://www.servicenow.com/docs/r/it-service-management/change-management/configure-conflict-properties.html) |
| 禁止期間と保守の時間帯 | CMDB のクラスと条件に結び付けたスケジュールとして持つ | [Blackout & Maintenance Schedules in a nutshell](https://www.servicenow.com/community/itsm-blog/blackout-maintenance-schedules-in-a-nutshell/ba-p/2269223)（コミュニティの記事）。公式の本文は未検証 |
| ITIL 4 | 変更の実現（change enablement）は、標準・通常・緊急の 3 種を持ち、承認する者を「変更の権限者」と呼ぶ | [Change Enablement in ITIL 4](https://itsm.tools/change-enablement/)（二次の資料）。PeopleCert のプラクティスガイドの原典は未検証 |

- 本家の状態の値（数値）、テーブルの名前、画面の文言は写さない（[リポジトリ共通の ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。
- 本家の CAB の会議のリアルタイムの画面（出席者の在席の表示など）は、MVP では写さない。

## 3. 状態のモデルの仕組み（[ADR-0022](../decisions/0022-process-state-machines.md)）

### 3.1 モデルの形

```
ProcessModel {
  key: "incident" | "problem" | "change.normal" | "change.standard" | "change.emergency"
       | "incident_task" | "problem_task" | "change_task"
  states: [{ value, label_key, category: open | hold | resolved | closed | cancelled, active: bool }]
  transitions: [{
    from, to, action,                         ← action は画面・API の操作の名前（resolve、close、cancel …）
    by: [actor_kind]                           ← user / flow / rule / system / email
    roles?: [role]                             ← 利用者が行うときに要るロール（ACL とは別の業務の条件）
    guard?: 式                                 ← 式の言語。保存の後の値で評価
    requires: [field]                          ← 遷移の時に空であってはならないフィールド
    effects: [組み込みの効果]                   ← resolved_at を入れる、承認を依頼する、など
  }]
}
```

- モデルはコードの版に含め、全テナントで同じにする（辞書と同じ扱い。[ADR-0006](../decisions/0006-data-dictionary-and-field-types.md)）。
- **テナントは、状態と遷移の辺を足せない。** 足せるのは、遷移の追加の `requires`（必須のフィールド）と追加の `guard`（式）、保留の理由の選択肢、状態のラベルの上書きだけである。状態を足せると、SLA の条件・レポート・承認の方針・メールの処理の前提が、テナントごとに変わるためである。
- テナントのクラス（例：`task` → `c_facilities_request`）は、組み込みの汎用のモデル `generic_task`（`open` → `work_in_progress` → `closed_complete` / `closed_incomplete` / `closed_skipped`）を使う。

### 3.2 保存の流れでの照合

保存の流れ（[data-dictionary-and-tables.md](data-dictionary-and-tables.md) の 5 節）の 3 段（保存の前のルール）の後、4 段（辞書の検証）の前に、次を行う。

```
if changes に state がある:
  t = model.transitions.find(from = 前の state, to = 新しい state, actor_kind が by に入る)
  なければ 422 invalid_transition
  roles があり、主体が持たなければ 403 transition_forbidden
  requires のフィールドが保存の後の値で空なら 422 transition_requires（空のフィールドの一覧）
  guard が偽なら 422 transition_guard（guard の説明のキー）
  effects を適用（同じトランザクション）
```

- **同じ保存で state 以外を変えても、遷移の判定は保存の後の値で行う。** 例：「解決」と同時に解決のコードを入れてよい。
- 行の `version` の条件付きの更新（[ADR-0007](../decisions/0007-physical-layout-and-extension-index.md)）で、2 人が同時に同じ遷移を押しても、後のほうは 409 `record_changed` になる。遷移の効果（承認の依頼、SLA の停止）は 1 回だけ起きる。
- `action` は、画面と API が「どの操作で遷移したか」を示す名前である。API は `PATCH` で state を直接書いてもよく、そのときも同じ表で判定する（操作の名前は、表から一意に決まる）。

### 3.3 共通の効果

| 効果 | 中身 |
| --- | --- |
| `set_resolved` | `resolved_at = now`、`resolved_by = 主体`。解決のコードと解決のメモを `requires` に持つ |
| `clear_resolved` | 再オープンで `resolved_at`・`resolved_by` を空にし、`reopen_count += 1` |
| `set_closed` | `closed_at = now`、`active = false` |
| `schedule_auto_close` | 自動の完了のタイマー（4.3 節） |
| `request_approval(policy)` | 承認の方針の組み込みのフローを始める（8.5 節） |
| `recompute_conflicts` | 変更の衝突を計算し直す（9 節） |
| `cascade_children(action)` | 子のレコードへの同じ操作を、非同期のまとめての更新（[workflow-engine.md](workflow-engine.md) の 5.3 節の `bulk_job`）で行う |

- `active` は `category` が `resolved` 以外の終わり（`closed`・`cancelled`）で偽にする。解決（`resolved`）は `active = true` のままにする（依頼者の再オープンを待つ間、担当の一覧に残す）。

## 4. インシデント

### 4.1 状態

| 値 | カテゴリ | 意味 |
| --- | --- | --- |
| `new` | open | 受け付けた直後。まだ担当者が着手していない |
| `in_progress` | open | 対応中 |
| `on_hold` | hold | 保留。`hold_reason` を必須にする |
| `resolved` | resolved | 解決。依頼者の確認を待つ |
| `closed` | closed | 完了 |
| `cancelled` | cancelled | 取り消し（重複、誤りの起票） |

`hold_reason` の組み込みの値：`awaiting_caller`（依頼者の回答待ち）、`awaiting_vendor`（ベンダー待ち）、`awaiting_problem`（問題の修正待ち）、`awaiting_change`（変更の実施待ち）。テナントは値を足せる。

### 4.2 遷移の表（DT-INC-001）

| # | 前 | 後 | 操作 | 主体 | 条件・必須 | 効果 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `new` | `in_progress` | `start` | user、rule、flow | `assigned_to` があること | |
| 2 | `new`・`in_progress` | `on_hold` | `hold` | user、flow | `hold_reason` | |
| 3 | `on_hold` | `in_progress` | `resume` | user、flow、email、system | - | `hold_reason` を空にする |
| 4 | `new`・`in_progress`・`on_hold` | `resolved` | `resolve` | user、flow、system | `resolution_code`、`resolution_notes`。子のインシデントは親が解決済みでなくてもよい | `set_resolved`、`schedule_auto_close`、メジャーなら `cascade_children(resolve)` |
| 5 | `resolved` | `in_progress` | `reopen` | user（依頼者・担当者）、email | 解決から `reopen_window`（既定 14 日）の中 | `clear_resolved`、自動の完了のタイマーを消す |
| 6 | `resolved` | `closed` | `close` | user（依頼者・担当者）、system（自動の完了） | - | `set_closed` |
| 7 | `new`・`in_progress`・`on_hold` | `cancelled` | `cancel` | user（`agent`） | `cancel_reason`。メジャーインシデントの親は取り消せない（解決する） | `set_closed` |
| 8 | `closed`・`cancelled` | どれも | - | - | - | 422 `invalid_transition`（終わったインシデントは戻さない。新しく起票し `reopened_from` で結ぶ） |
| 9 | 上のどれにも当たらない | | | | | 422 `invalid_transition` |

- `on_hold` で `hold_reason = awaiting_caller` のとき、依頼者のコメント（ポータル・メールの返信）が付くと、組み込みのルールで `resume` を行う（主体は `system`、`cause` はコメントの `journal_entry`）。
- 担当のグループが変わっても状態は変えない（本家の「割り当て済み」の状態は持たない。割り当ては `assignment_group_id` と `assigned_to_id` だけで表す）。

### 4.3 自動の完了

- `resolve` の効果で、`auto_close_at = resolved_at + auto_close_days`（既定 7 日、テナントで 0〜30。0 は自動の完了なし）の時刻のタイマー（`kind = run_step`、組み込みのフロー `incident_auto_close`）を登録する。
- 日数は暦の日で数える。業務カレンダーを使わない（本家の既定の意味は未検証。依頼者に示す文言を単純にするため）。
- 発火のとき、インシデントの `version` がタイマーの `target_version` と同じで、状態が `resolved` のままなら `close` を行う。再オープン・手での完了の後の発火は何もしない（[workflow-engine.md](workflow-engine.md) の DT-FLOW-002 の 10 行）。

### 4.4 SLA の一時停止の既定

[sla-and-calendars.md](sla-and-calendars.md) の 13 節の持ち越し（一時停止の条件の既定）をここで決める。

| SLA の定義（組み込みの既定） | 開始 | 一時停止 | 停止 |
| --- | --- | --- | --- |
| インシデントの応答（`response`） | 作成 | なし | `state != new`、または `assigned_to` が入った |
| インシデントの解決（`resolution`） | 作成 | `state = on_hold AND hold_reason = awaiting_caller`、または `state = resolved` | `state IN (closed, cancelled)` |
| インシデントの解決の OLA（担当のグループ） | `assignment_group_id` が入った | `state = on_hold AND hold_reason IN (awaiting_caller, awaiting_vendor)` | `state IN (resolved, closed, cancelled)` |

- **依頼者の回答待ちだけで SLA を止める。** ベンダー待ち・問題待ち・変更待ちは IT の側の都合なので、依頼者との約束（SLA）を止めない。担当のグループの OLA は、ベンダー待ちでも止める（グループの責任の外）。
- `resolved` で一時停止にするのは、再オープンで計時を続けるためである（停止すると、再オープンで新しい計時が始まる）。テナントは定義を変えられる。

### 4.5 親子と重複

- `parent_id`（`task` の共通の列）で、インシデントどうしの親子を持つ。深さは 1 段にする（子の子を作らない）。親の解決は、子へ `cascade_children(resolve)` で伝わる（6.4 節）。
- 重複は `cancel`（`cancel_reason = duplicate`）と `duplicate_of` の参照で表す。重複の元の作業メモに「重複を 1 件受けた」を残す。

## 5. 優先度（[ADR-0023](../decisions/0023-priority-matrix-and-major-incident.md)）

### 5.1 表

- `impact`・`urgency` は 1（高）〜3（低）、`priority` は 1（緊急）〜5（計画）。5 は表から導かれず、上書きだけで使う（計画の作業のため）。
- 優先度の表 `priority_matrix(tenant_id, table_id, impact, urgency, priority)` を、テーブル（クラス）ごとに持つ。子のクラスは、自分の表がなければ親の表を使う。

DT-PRIO-001（組み込みの既定。本家の既定と同じ形にした）：

| # | 影響度 | 緊急度 | 優先度 |
| --- | --- | --- | --- |
| 1 | 1 | 1 | 1 |
| 2 | 1 | 2 | 2 |
| 3 | 1 | 3 | 3 |
| 4 | 2 | 1 | 2 |
| 5 | 2 | 2 | 3 |
| 6 | 2 | 3 | 4 |
| 7 | 3 | 1 | 3 |
| 8 | 3 | 2 | 4 |
| 9 | 3 | 3 | 4 |

- テナントは表の値を変えられる。**表は 9 行すべてを持つことを保存の時に検査する**（抜けがあると優先度が空になるため）。表の変更はメタデータの変更で、既存のレコードの優先度は変えない。

### 5.2 導出と上書き

DT-PRIO-002（保存の時の優先度）：

| # | `priority_override` | 変わったフィールド | 結果 |
| --- | --- | --- | --- |
| 1 | あり（上書き中） | `priority` を利用者が書いた | `priority_override` の権限がなければ 403。あれば `priority_override_reason` を必須にして受ける |
| 2 | なし | `priority` を利用者が書いた | 403 `priority_read_only`（上書きの操作を使うよう示す） |
| 3 | あり | `impact`・`urgency` | 表で計算した値を `priority_computed` に入れるだけ。`priority` は上書きのまま |
| 4 | なし | `impact`・`urgency`、または作成 | `priority = matrix(impact, urgency)`、`priority_computed` も同じ |
| 5 | - | 上書きの解除（`clear_priority_override`） | `priority = priority_computed` |
| 6 | - | それ以外 | 変えない |

- 上書きのロールは、組み込みでは `major_incident_manager` と `agent_admin`。上書きは監査の履歴に理由と一緒に残る。
- 影響度を CI・サービスの重要度から自動で入れる規則は MVP に入れない（持ち越し）。割り当ての規則（[assignment-and-on-call.md](assignment-and-on-call.md)）で既定値を入れることはできる。

## 6. メジャーインシデント（[ADR-0023](../decisions/0023-priority-matrix-and-major-incident.md)）

### 6.1 候補

| 表 | 列 |
| --- | --- |
| `major_incident_candidate` | `tenant_id`、`id`、`incident_id`、`state`（`proposed` / `promoted` / `rejected` / `withdrawn`）、`source`（`trigger_rule` / `proposal`）、`rule_id`、`proposed_by`、`reason`、`business_impact`、`decided_by`、`decided_at`、`decision_note`、`version` |
| `major_incident_trigger` | メタデータ。`table_id`、`condition`（式）、`active` |

DT-MIM-001：

| # | 事象 | インシデントの状態 | 候補の今の状態 | 主体 | 結果 |
| --- | --- | --- | --- | --- | --- |
| 1 | 提案・トリガーの規則 | `resolved`・`closed`・`cancelled` | - | - | 何もしない（提案は 422 `incident_not_open`） |
| 2 | 提案・トリガーの規則 | open・hold | `proposed`・`promoted` がある | - | 何もしない（提案は 409 `already_candidate`） |
| 3 | 提案 | open・hold | ない、または `rejected`・`withdrawn` だけ | `agent` | `proposed` の候補を作る。`major_incident_manager` のグループに通知 |
| 4 | トリガーの規則が偽 → 真 | open・hold | ない | system | `proposed`（`source = trigger_rule`）。**自動では昇格しない** |
| 5 | 昇格 | open・hold | `proposed` | `major_incident_manager` | `promoted`。6.2 節 |
| 6 | 却下 | - | `proposed` | `major_incident_manager` | `rejected`、`decision_note` を必須 |
| 7 | 取り下げ | - | `proposed` | 提案した人 | `withdrawn` |
| 8 | それ以外 | | | | 409 |

- トリガーの規則の評価は、保存の流れの 9 段（フローのトリガー）と同じ場所で、式の評価だけで行う。規則の例：`priority = 1 AND business_service.criticality = 'mission_critical'`。
- 自動で昇格させないのは、メジャーインシデントの宣言が、経営への連絡と当番の呼び出しを伴う重い判断だからである（本家もトリガーの規則は候補を作るだけ。2 節）。

### 6.2 昇格

- 昇格は、1 つのトランザクションで次を行う。
  - 候補を `promoted`、候補のインシデントに `major = true`、`major_manager_id` を入れる。
  - 本家は新しい親のインシデントを作って候補を子にする（2 節）。**本システムは新しい親を作らず、候補のインシデント自体を親にする。** 番号・SLA・作業メモ・依頼者が 1 つの記録に残り、担当者と依頼者が同じ番号で話せるためである。
  - 優先度を 1 に上書きする（理由は「メジャーインシデントに昇格」）。
  - 組み込みのフロー `major_incident_response` を始める：当番の呼び出し（[assignment-and-on-call.md](assignment-and-on-call.md) の 6 節）、関係者への通知、連絡の周期のタイマー（既定 30 分ごとに「状況の更新」を担当に促す）。
- 同じ障害の他のインシデントは、担当者が「子にする」で `parent_id` を入れる。子にしたとき、子の依頼者には親の状況の更新（コメント）が伝わる（通知の規則 `major_incident_update`）。

### 6.3 振り返りと問題

- メジャーインシデントの完了（`close`）の `guard`：関連の問題が 1 件以上ある、または `problem_waiver_reason`（問題を作らない理由）がある。メジャーインシデントの根本原因を問題として追うことを既定にするためである（ITIL の実務の一般的な形。本家の既定は未検証）。
- 振り返りの記録（時系列、影響、対応、再発の防止）は、インシデントの `ext` のフィールドではなく、問題の側に持つ（7 節）。

### 6.4 子への伝播

- 親の `resolve` の効果 `cascade_children(resolve)` は、`bulk_job` を作り、子のうち open・hold のものを 100 件ずつ、別のトランザクションで `resolve` する（解決のコードは親の値、解決のメモは「親 INC… の解決による」）。
- 保存の後のルール（1 回の保存で 10 件まで。[ADR-0017](../decisions/0017-no-code-record-rules.md)）で行わないのは、メジャーインシデントの子が数百件になりうるためである。親の解決の直後の数秒、子が open のまま見えることを受け入れる。
- 子の解決に失敗した行（遷移の表に合わない、版の競合）は、`bulk_job` の結果に残し、再試行（3 回）の後も失敗なら担当に知らせる。

## 7. 問題と既知のエラー（[ADR-0022](../decisions/0022-process-state-machines.md)）

### 7.1 状態

| 値 | カテゴリ | 意味 |
| --- | --- | --- |
| `new` | open | 起票 |
| `assess` | open | 問題として扱うかの評価 |
| `root_cause_analysis` | open | 根本原因の調査 |
| `fix_in_progress` | open | 恒久の対策の実施中（変更と結ぶ） |
| `resolved` | resolved | 解決（対策の効果の確認待ち） |
| `closed` | closed | 完了 |
| `cancelled` | cancelled | 取り消し（重複、問題でない） |

DT-PRB-001：

| # | 前 | 後 | 操作 | 条件・必須 | 効果 |
| --- | --- | --- | --- | --- | --- |
| 1 | `new` | `assess` | `assess` | `assignment_group_id` | |
| 2 | `assess` | `root_cause_analysis` | `confirm` | ロール `problem_manager` | |
| 3 | `root_cause_analysis` | `fix_in_progress` | `fix` | `cause_notes` | |
| 4 | `fix_in_progress` | `root_cause_analysis` | `reanalyze` | - | |
| 5 | `root_cause_analysis`・`fix_in_progress` | `resolved` | `resolve` | `resolution_code`、`fix_notes`。`resolution_code = fix_applied` なら、関連の変更が 1 件以上 `closed`（成功）であること | 関連のインシデントの伝播（7.3 節） |
| 6 | `resolved` | `closed` | `close` | ロール `problem_manager` | |
| 7 | `resolved` | `root_cause_analysis` | `reopen` | - | |
| 8 | `new`・`assess`・`root_cause_analysis` | `cancelled` | `cancel` | `cancel_reason`。重複なら `duplicate_of` | |
| 9 | そのほか | | | | 422 `invalid_transition` |

### 7.2 既知のエラー

- **既知のエラーは状態ではなく印（`known_error = true`）にする。** 根本原因の調査中でも、回避策が分かった時点で既知のエラーにできる。状態にすると、「修正中だが既知のエラー」を表せないためである（本家も分類として扱う。2 節）。
- `known_error` を真にする条件：`workaround` が空でない。`cause_notes` は空でもよい（原因は不明でも回避策はありうる）。
- 既知のエラーにすると、ナレッジの記事の草案を作る操作（`publish_known_error_article`）を使える。記事の公開の流れは [knowledge.md](knowledge.md) の 5 節。記事は問題を `source_task_id` で参照し、問題の `workaround` の変更は記事の新しい版の草案を作る（自動では公開しない）。

### 7.3 インシデントとの関係

- インシデントは `problem_id`（参照）で問題に結ぶ。1 つのインシデントは 1 つの問題にだけ結ぶ。
- 問題の `resolve` のとき、`problem_id` でこの問題に結ばれ、`on_hold` かつ `hold_reason = awaiting_problem` のインシデントを、`bulk_job` で処理する。既定は「解決」（解決のコード `problem_fixed`）。テナントは「対応中に戻す」を選べる。本家は問題の完了で結ばれたインシデントを解決するとみられる（[KB0955987](https://support.servicenow.com/kb?id=kb_article_view&sysparm_article=KB0955987) の題名から推した。未検証）。
- 問題の子のタスク（`problem_task`）は、`generic_task` のモデルに `problem_task` 用の種類（調査・回避策の検証）の選択肢を足したものにする。

## 8. 変更（[ADR-0024](../decisions/0024-change-models-risk-and-cab.md)）

### 8.1 種類と状態

| 値 | カテゴリ | 通常 | 標準 | 緊急 |
| --- | --- | --- | --- | --- |
| `new` | open | ○ | ○ | ○ |
| `assess` | open | ○ | - | - |
| `authorize` | open | ○ | - | ○ |
| `scheduled` | open | ○ | ○ | ○ |
| `implement` | open | ○ | ○ | ○ |
| `review` | resolved | ○ | ○ | ○ |
| `closed` | closed | ○ | ○ | ○ |
| `cancelled` | cancelled | ○ | ○ | ○ |

- 種類（`change_type`）は作成の時に決め、後から変えない。変えたいときは取り消して作り直す（状態のモデルが種類で決まるため）。
- 変更の固有のフィールド（`task` の型付きの列）：`change_type`、`risk`（1 高〜4 低。`risk_source`）、`planned_start`、`planned_end`、`actual_start`、`actual_end`、`implementation_plan`、`backout_plan`、`test_plan`、`justification`、`std_template_version_id`、`close_code`（`successful` / `successful_with_issues` / `unsuccessful`）、`conflict_status`（`none` / `warning` / `blocking` / `not_checked`）、`conflict_checked_at`、`cab_required`、`cab_meeting_id`、`emergency_post_review_required`。

DT-CHG-001（遷移）：

| # | 種類 | 前 | 後 | 操作 | 条件・必須 | 効果 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 通常 | `new` | `assess` | `request_assessment` | `cmdb_ci_id`、`planned_start`、`planned_end`、`implementation_plan`、`backout_plan`、`test_plan`、`justification` | リスクの評価（8.3 節）、`recompute_conflicts`、`request_approval(assess)`（8.5 節の技術の承認） |
| 2 | 通常 | `assess` | `authorize` | system（技術の承認の決着） | 承認のまとまりが `approved` | `request_approval(authorize)`（CAB など） |
| 3 | 通常 | `authorize` | `scheduled` | system（承認の決着） | 承認のまとまりが `approved`、`conflict_status != blocking` | |
| 4 | 通常・緊急 | `assess`・`authorize` | `new` | system（承認の却下） | 承認のまとまりが `rejected` | 却下の理由を作業メモに |
| 5 | 標準 | `new` | `scheduled` | `schedule` | `std_template_version_id` が有効、`planned_start`・`planned_end`、`conflict_status != blocking` | `recompute_conflicts` |
| 6 | 緊急 | `new` | `authorize` | `request_emergency_authorization` | `cmdb_ci_id`、`justification`、`implementation_plan`、`backout_plan` | リスクを 1（高）、`request_approval(emergency)` |
| 7 | 緊急 | `authorize` | `scheduled` | system（承認の決着） | 承認のまとまりが `approved`。禁止期間の衝突は許す（記録する） | `emergency_post_review_required = true` |
| 8 | 全種 | `scheduled` | `implement` | `implement` | `planned_start - 実施の前倒しの許容（既定 0）≤ now`、直前の衝突の再計算で `blocking` がない（緊急を除く） | `actual_start = now` |
| 9 | 全種 | `implement` | `review` | `complete_implementation` | `close_code`、`close_notes` | `actual_end = now` |
| 10 | 全種 | `review` | `closed` | `close` | 緊急なら事後の CAB の承認のまとまりが `approved`。`close_code = unsuccessful` なら関連のインシデントか `review_notes` | |
| 11 | 全種 | `new`・`assess`・`authorize`・`scheduled`・`implement` | `cancelled` | `cancel` | `cancel_reason`。`implement` からの取り消しは `backout_performed` を必須 | 開いている承認を `cancelled` |
| 12 | 全種 | `scheduled` | `new`（通常・標準）・`authorize`（緊急） | `reschedule` | `planned_start` か `planned_end` か `cmdb_ci_id` を変えるとき | 承認を取り直す（通常は `assess` から） |
| 13 | 全種 | `review`・`closed`・`cancelled` | 取り消し・前の状態 | - | - | 422（振り返りと完了は取り消せない。本家と同じ） |
| 14 | そのほか | | | | | 422 `invalid_transition` |

- **どの種類も、承認のまとまりが `approved` にならないと `scheduled` を通れず、`scheduled` を通らないと `implement` に入れない。** 標準の変更の承認は、雛形の版の承認（8.2 節）で済んだものとみなす。これで [intent.md](../intent.md) の「変更の記録は、承認のないまま実施に進まない」を、遷移の表の上で確かめられる（PROP-CHG-001）。
- 承認済みの変更で、予定の時刻・CI を変えると、`reschedule` で承認を取り直す（12 行）。承認のときに見た予定と違う予定で実施させないためである。`scheduled` の中で、予定の時刻・CI を `reschedule` 以外で変える保存は 422 `approved_fields_locked` にする（承認の対象のフィールドの一覧を固定する）。

### 8.2 標準の変更の雛形

| 表 | 列 |
| --- | --- |
| `std_change_template` | `tenant_id`、`id`、`stable_key`、`name`、`category`、`active_version_id`、`owner_group_id` |
| `std_change_template_version` | `tenant_id`、`id`、`template_id`、`version_no`、`field_values`（作る変更の既定値）、`allowed_ci_condition`（式）、`max_duration`、`state`（`proposed` / `approved` / `rejected` / `retired`）、`approved_set_id`、`content_hash` |

- 雛形の新しい版は「提案」として作り、`change_manager` のグループの承認（[workflow-engine.md](workflow-engine.md) の承認）を経て `approved` にする。承認済みの版は変えない。
- 標準の変更は、作成の時に `std_template_version_id` を固定する。雛形の版の既定値を入れ、`allowed_ci_condition` と `max_duration`（予定の長さの上限）を `schedule` の `guard` で確かめる。
- 雛形の版の承認の記録が、個々の標準の変更の承認の証跡になる（J-SOX の説明のため、変更の画面から雛形の版の承認へたどれるようにする）。
- 標準の変更が `unsuccessful` で終わったら、雛形の持ち主のグループに知らせる。同じ雛形で 90 日に 3 回 `unsuccessful` なら、雛形を自動で `retired` にはせず、`change_manager` に見直しのタスクを作る。

### 8.3 リスクの評価

- リスクは 2 つの方法で求め、**高いほう（数値の小さいほう）を採る。** 本家は規則の条件を優先するとされる（2 節）が、規則が「低」を返して質問票が「高」を返すとき、低いほうを採る理由がない。
  - 規則（`risk_condition`）：メタデータ。`condition`（式）と `risk`、`order`。一致したすべての規則のうち、最も高いリスク。CI の重要度、影響を受けるサービスの数（9.4 節の影響の範囲の件数）、過去 90 日の同じ CI の `unsuccessful` の件数、禁止期間への近さを式で使える。
  - 質問票（`risk_questionnaire`）：質問ごとに選択肢と得点、重み。合計の得点をしきい値でリスクに写す。
- DT-RISK-001：

| # | 規則の結果 | 質問票の状態 | 結果の `risk` | `risk_source` |
| --- | --- | --- | --- | --- |
| 1 | あり（r1） | 回答済み（r2） | min(r1, r2) | 小さいほうの出どころ |
| 2 | あり（r1） | 未回答 | r1。ただし通常の変更は `assess` へ進めない（`guard`：質問票の回答が必須） | `rule` |
| 3 | なし | 回答済み（r2） | r2 | `questionnaire` |
| 4 | なし | 未回答 | 通常：進めない。緊急：1（高） | `default` |

- 評価は `request_assessment` の効果として同じトランザクションで行い、評価の入力（規則の版、回答、影響の範囲の件数）を `change_risk_assessment` に残す。評価の後に入力が変わったら（CI の変更）、`reschedule` で評価し直す。
- 機械学習によるリスクの予測は MVP に入れない（[intent.md](../intent.md) の「選定・計測で決めるもの」）。

### 8.4 変更のタスク

- `change_task` は `generic_task` のモデルに、`planned_start`・`planned_end` と種類（実施・テスト・切り戻し）を足したもの。変更の `complete_implementation` の `guard`：`change_task` のうち必須の印のものがすべて終わっている。

### 8.5 承認の方針

DT-CHG-002（種類 × リスク → 承認の段）：

| # | 種類 | リスク | 段 1（`assess` で） | 段 2（`authorize` で） | 期限切れの動作 |
| --- | --- | --- | --- | --- | --- |
| 1 | 標準 | - | なし（雛形の版の承認） | なし | - |
| 2 | 通常 | 4（低） | CI の `support_group` の管理者（`any`） | `change_manager` のグループ（`any`） | 引き上げ（`escalate`） |
| 3 | 通常 | 3（中） | CI の `support_group` の管理者（`any`） | `change_manager` のグループ（`any`） | 引き上げ |
| 4 | 通常 | 2（高） | CI の `support_group` の管理者（`any`） | CAB（`percent(50)`）。`cab_required = true` | 却下 |
| 5 | 通常 | 1（最高） | CI の `support_group` の管理者（`any`） | CAB（`percent(50)`）＋ 影響を受けるビジネスのサービスの持ち主（`all`） | 却下 |
| 6 | 緊急 | - | - | ECAB（緊急の CAB のグループ、`any`） | 却下 |
| 7 | 緊急（`review` で） | - | - | 事後の CAB（`percent(50)`） | 引き上げ |

- 方針は組み込みのフロー `change_approval_policy`（[workflow-engine.md](workflow-engine.md) の 13 節の Story `change-approval-policy-flows`）で実装する。テナントは、決定表の段の承認者と規則を変えられる。**段を「なし」にできるのは標準だけである**（保存の時の検査）。
- 承認のまとまりは `requires_explicit_approval` の変更のテーブルの上にあるので、期限切れの自動の承認は選べず、本人の承認は禁止される（[ADR-0016](../decisions/0016-approvals.md)）。承認者が依頼者・担当者と同じ人なら、その人の承認の行を作らない（まとまりの規則の分母から除く）。除いた結果、承認者が 0 人になれば、方針の検査で 422 にし、`change_manager` に承認者の設定の不足を知らせる。
- **緊急の変更も、1 人以上の承認なしに `implement` へ進めない。** 緊急の変更で CAB を待てないときは ECAB の 1 人の承認で進め、事後の CAB の承認（7 行）を完了の条件にする（[intent.md](../intent.md) の「緊急の変更は、事後の承認の記録を必須にする」）。

### 8.6 CAB の会議

| 表 | 列 |
| --- | --- |
| `cab_definition` | `tenant_id`、`id`、`name`、`cab_group_id`、`recurrence`（毎週の曜日と時刻、テナントのタイムゾーン）、`duration`、`agenda_condition`（式。既定：`cab_required AND state = authorize`）、`agenda_window`（会議の前の何日から後の何日までに予定の開始がある変更） |
| `cab_meeting` | `tenant_id`、`id`、`definition_id`、`starts_at`、`ends_at`、`state`（`planned` / `in_progress` / `completed` / `cancelled`）、`notes`、`version` |
| `cab_agenda_item` | `tenant_id`、`meeting_id`、`change_id`、`order`、`allotted_minutes`、`state`（`pending` / `in_discussion` / `decided` / `skipped` / `deferred`）、`decision_summary` |

- 議題は、会議の 1 日前（既定）のジョブで `agenda_condition` から作り、CAB の管理者が並べ替え・追加・除外できる。
- **会議での決定は、各承認者が自分の承認の行に回答することで反映する。** CAB の管理者がまとめて「承認済み」にする操作は作らない。承認の証跡を、承認者本人の回答として残すためである（成り代わり・代理の規則も [workflow-engine.md](workflow-engine.md) の DT-APR-001 のまま効く）。回答の `channel` は `cab_meeting`、`cab_meeting_id` を残す。
- 議題の `decision_summary` と会議の `notes` は、議事の記録であり、承認そのものではない。
- 会議の画面（議題の進行、時間の表示）は `portal-and-ui.md` と一緒に E7 で作る。出席者の在席の表示は持たない。

## 9. 変更の予定表と衝突（[ADR-0025](../decisions/0025-change-schedule-and-conflict-detection.md)）

### 9.1 時間帯

| 表 | 列 |
| --- | --- |
| `change_window` | `tenant_id`、`id`、`stable_key`、`kind`（`blackout` / `maintenance`）、`name`、`calendar_id`（区間の定義。[sla-and-calendars.md](sla-and-calendars.md) の 3 節のカレンダーの版を使う）、`ci_condition`（式。CI の条件）、`scope`（`ci` / `tenant_wide`）、`applies_to_types`（既定：通常・標準）、`active` |

- **区間はカレンダーと同じ表現にする。** 禁止期間は「閉じる」ではなく「この区間は変更を禁止する」の意味で、カレンダーの週の型と例外で区間を作る。区間の計算は [ADR-0019](../decisions/0019-business-calendar-and-pure-time-functions.md) の半開区間の関数を共有する。
- **凍結期間**（年末年始、期末、大型のイベント）は、`scope = tenant_wide` の禁止期間として持つ。CI の条件を持たず、全 CI に効く。
- 保守の時間帯は、CI の条件に合う CI の「変更してよい区間」である。保守の時間帯を持つ CI の変更が区間の外なら、衝突（警告）にする。保守の時間帯を持たない CI は、この検査をしない。

### 9.2 衝突の関数

```
conflicts(change, ctx) → [Conflict]
  change：cmdb_ci_id、影響を受ける CI の一覧（affected_ci）、planned_start、planned_end、assigned_to_id、change_type
  ctx：時間帯の一覧と区間（コンパイル済み）、関係のグラフの近傍（親・子、深さ 1）、
       同じ期間に予定のある他の変更（state IN (scheduled, implement)、および authorize）、担当者の他の変更
Conflict = { kind, severity, ci_id, other_change_id?, window_id?, overlap: [s, e) }
```

- 関数は純粋にし、DB を読まない。呼ぶ側が `ctx` を集める（`[planned_start − 1 日, planned_end + 1 日)` の範囲の変更と時間帯を索引で読む）。

DT-CONF-001（衝突の種類と重さ）：

| # | 種類 | 条件 | 重さ（通常・標準） | 重さ（緊急） |
| --- | --- | --- | --- | --- |
| 1 | `blackout` | 対象の CI（`cmdb_ci_id` と `affected_ci`）が、禁止期間の区間と重なる | `blocking` | `warning`（記録する） |
| 2 | `blackout_related` | 親・子の CI が禁止期間と重なる | `warning` | `warning` |
| 3 | `freeze` | `tenant_wide` の禁止期間と重なる | `blocking` | `warning` |
| 4 | `outside_maintenance` | 対象の CI が保守の時間帯を持ち、予定がその外にはみ出る | `warning` | `warning` |
| 5 | `outside_maintenance_related` | 親・子の CI について 4 と同じ | `warning` | `warning` |
| 6 | `ci_overlap` | 同じ CI に、予定の重なる他の変更がある | `warning` | `warning` |
| 7 | `related_ci_overlap` | 親・子の CI に、予定の重なる他の変更がある | `warning` | `warning` |
| 8 | `assignee_overlap` | 同じ担当者に、予定の重なる他の変更がある | `warning`（テナントの設定で無効にできる） | `warning` |
| 9 | - | どれにも当たらない | なし | なし |

- 区間は半開区間で比べる。前の変更の終わりと次の変更の始まりが同じ時刻なら重ならない（本家の「連続する変更を許す」に当たる。2 節）。
- `conflict_status` は、衝突の中で最も重いもの（`blocking` ＞ `warning` ＞ `none`）。
- **禁止期間の例外**：`blocking` の変更は、`blackout_exception` の承認（`change_manager` のグループ、`any`）が `approved` なら `warning` に下げる。例外の承認は、変更の `version` と衝突の内容のハッシュに結び、予定を変えたら無効にする。

### 9.3 評価の時点

| 時点 | どこで | 振る舞い |
| --- | --- | --- |
| `planned_start`・`planned_end`・`cmdb_ci_id`・`affected_ci`・`assigned_to_id` の変更 | 保存の流れの効果 `recompute_conflicts`（同じトランザクション） | `change_conflict` を書き直し、`conflict_status` と `conflict_checked_at` を更新 |
| `assess`・`schedule`・`implement` への遷移 | 遷移の `guard` の前 | 計算し直し、`blocking` なら遷移を 422 `blocking_conflict` |
| 他の変更の予定の変更、時間帯の追加・変更 | outbox の `record.changed` から、非同期のジョブ | 影響を受ける変更（同じ CI・期間）を計算し直す。`blocking` が新しく出たら担当と `change_manager` に知らせる |

- 並行に同じ CI の 2 つの変更を予定すると、どちらのトランザクションも相手を見ない。これは `ci_overlap`（警告）なので、非同期のジョブで後から両方に付け、知らせることで足りるとする。**`blocking` の判定は時間帯だけから決まり、他の変更の保存に左右されない**ので、並行の保存で `blocking` を見落とすことはない。
- 衝突の件数は 1 つの変更で 1,000 件まで持つ（本家の上限の既定と同じ値。2 節）。超えたら切り、`truncated` を立てる。

### 9.4 影響の範囲

- `request_assessment` の時に、[cmdb-and-reconciliation.md](cmdb-and-reconciliation.md) の 8 節の影響の走査で、影響を受けるサービスと CI を求め、`change_impact_snapshot` に残す。CAB は、承認の依頼の時点の影響の範囲を見る。後で CMDB が変わっても、承認の根拠の記録は変えない。
- 影響を受けるビジネスのサービスの持ち主は、DT-CHG-002 の 5 行の承認者になる。

### 9.5 予定表

- 予定表の画面は、期間と CI・サービス・グループの条件で、変更（`scheduled`・`implement`・`authorize`）と時間帯の区間を並べる。読み取りは見る人の ACL で行う（[access-control.md](access-control.md) の 6.2 節の 2 行）。読めない変更は「予定あり（詳細なし）」の区間として出すかを、テナントの設定で決める（既定は出さない）。
- 次の空きの探索（衝突のない最も早い区間）は、90 日先まで、候補 100 件までにする（本家の既定と同じ値。2 節）。

## 10. 障害のときの振る舞い

| 障害 | 振る舞い |
| --- | --- |
| 同じレコードの並行の遷移 | 版の条件で後のほうが 409。効果（承認の依頼・SLA の停止）は 1 回だけ |
| 自動の完了のタイマーの発火と再オープンが同時 | 版の条件で先にコミットしたほうだけが効く |
| 子への伝播の `bulk_job` の途中の停止 | `bulk_job` の続きから再開する。子は 1 件ずつのトランザクションなので、半端な子はない |
| 衝突の非同期の計算し直しの遅れ | `conflict_checked_at` が古い変更は、画面に「確認の時刻」を出す。遷移の時は必ず同期で計算し直すので、遷移の判定は遅れの影響を受けない |
| CMDB の走査が上限で打ち切られた | 影響の範囲に `truncated` を残し、リスクの規則で「影響の範囲の不明」を高リスクとして扱える |
| 承認者の設定の不足（承認者 0 人） | 承認を依頼せず 422。`change_manager` に知らせる |
| CAB の会議が開けない | 承認は各承認者の回答で進むので、会議なしでも決着できる |

## 11. セキュリティ

- 状態の遷移の `roles` は業務の条件で、ACL の書き込みの判定（[access-control.md](access-control.md)）の後に追加で効く。ACL で書けない利用者は、遷移の表を見る前に 403 になる。
- 変更のテーブルは `requires_explicit_approval` で、本人の承認の禁止と期限切れの自動の承認の禁止を外せない（[ADR-0016](../decisions/0016-approvals.md)）。職務の分離のため、変更の依頼者・担当者を承認者から除く（8.5 節）。
- 承認済みのフィールド（予定・CI）の固定で、承認の後の予定のすり替えを防ぐ（8.1 節）。
- 優先度の上書きは理由付きで履歴に残す。メジャーインシデントの昇格・却下は `major_incident_manager` だけにする。
- 予定表と影響の範囲の表示は、見る人の ACL で絞る。サービスの名前（例：M&A の案件のシステム）が機微なときに漏れないようにする。
- 組み込みのロール `major_incident_manager`、`problem_manager` は、統合で [access-control.md](access-control.md) の 3.3 節の一覧に足した。`change_manager` は既存。

## 12. テスト

### 12.1 決定表（`spec.md` から読む表駆動テスト）

- DT-INC-001、DT-PRB-001、DT-CHG-001（種類ごと）、DT-PRIO-001、DT-PRIO-002、DT-MIM-001、DT-RISK-001、DT-CHG-002、DT-CONF-001。
- 否定の表：各モデルで、表にない（前、後、主体）の組をすべて作り、422 で DB が変わらないことを確かめる。

### 12.2 性質ベーステスト（fast-check）

- **PROP-CHG-001（承認なしに実施しない）**：任意の変更の種類と、任意の操作・承認の回答・期限の発火・予定の変更の列で、`implement` に入った変更は、その直前の `scheduled` への遷移の時点で、決着が `approved` の承認のまとまり（標準は承認済みの雛形の版）を持つ。
- **PROP-CHG-002（予定の固定）**：任意の列で、`implement` に入った変更の `planned_start`・`planned_end`・`cmdb_ci_id` は、最後の承認の決着の時点の値と同じ。
- **PROP-PRIO-001（優先度の導出）**：任意の影響度・緊急度・上書きの操作の列で、上書きがない間は `priority = matrix(impact, urgency)`。
- **PROP-CONF-001（衝突の関数の対称と単調）**：任意の 2 つの変更で、`ci_overlap` は両方の側に出る（対称）。予定の区間を縮めても、衝突の集合は増えない（単調）。
- **PROP-CONF-002（blocking は時間帯だけで決まる）**：任意の他の変更の集合を足しても消しても、`blocking` の衝突の集合は変わらない。
- **PROP-INC-001（状態の到達）**：任意の操作の列で、インシデントは表にない状態に入らず、`closed`・`cancelled` から出ない。
- **PROP-MIM-001（昇格は人だけ）**：任意の保存とトリガーの規則の列で、`promoted` の候補は、`major_incident_manager` の主体の昇格の操作からだけ生じる。

### 12.3 結合テスト・障害注入

- 同じインシデントへの並行の `resolve` と `reopen`、自動の完了の発火と再オープン：効果がちょうど 1 回。
- 子のインシデント 500 件のメジャーインシデントの解決で、`bulk_job` の途中にプロセスを落とし、すべての子がちょうど 1 回解決される。
- 緊急の変更で ECAB の承認の回答とコミットの直後にプロセスを落とし、`scheduled` への遷移が 1 回だけ。

## 13. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E2 | `process-model-engine` | 3 節の遷移の表と保存の流れでの照合（PROP-INC-001） |
| E6 | `incident-default-slas` | 4.4 節の組み込みの SLA の定義（sla-and-calendars と一緒に。同じ Story） |
| E6 | `incident-lifecycle` | 4 節、DT-INC-001、自動の完了 |
| E6 | `priority-matrix` | 5 節、DT-PRIO-001・002（PROP-PRIO-001） |
| E6 | `major-incident-candidates` | 6.1 節、DT-MIM-001、トリガーの規則（PROP-MIM-001） |
| E6 | `major-incident-promotion-and-cascade` | 6.2〜6.4 節、`major_incident_response` のフロー |
| E6 | `problem-lifecycle-and-known-error` | 7 節、DT-PRB-001、既知のエラーの印（記事の草案は E9 の `known-error-articles`） |
| E6 | `problem-incident-propagation` | 7.3 節の `bulk_job` |
| E7 | `change-models` | 8.1 節、DT-CHG-001（PROP-CHG-001・002） |
| E7 | `standard-change-templates` | 8.2 節 |
| E7 | `change-risk-assessment` | 8.3 節、DT-RISK-001 |
| E7 | `change-approval-policy-flows` | 8.5 節、DT-CHG-002（workflow-engine と一緒に） |
| E7 | `cab-meetings` | 8.6 節と画面 |
| E7 | `change-windows-and-freeze` | 9.1 節 |
| E7 | `change-conflict-detection` | 9.2・9.3 節、DT-CONF-001（PROP-CONF-001・002） |
| E7 | `change-impact-snapshot` | 9.4 節（cmdb と一緒に） |
| E7 | `change-schedule-view` | 9.5 節 |
| E10 | `impact-for-change-and-incident` | 影響の範囲の走査を変更とメジャーインシデントの画面に出す |
| E11 | `itsm-process-reports` | 状態ごとの滞留、変更の成功率、メジャーインシデントの件数（reports と一緒に） |

## 14. 未解決の問い

### 決定（2026-09-28、既定案）

- **テナントは状態と遷移の辺を足せない**：条件と保留の理由だけを足せる（3.1 節、ADR-0022）。
- **インシデントに「割り当て済み」の状態を持たない**：割り当てはフィールドで表す（4.2 節）。
- **自動の完了は解決から暦の 7 日**（4.3 節）。
- **SLA は依頼者の回答待ちだけで止め、OLA はベンダー待ちでも止める**（4.4 節）。
- **優先度 5 は表から導かず、上書きだけで使う**（5.1 節）。
- **メジャーインシデントは自動で昇格させず、新しい親を作らずに候補のインシデント自体を親にする**（6 節、ADR-0023）。
- **子の解決は非同期のまとめての更新で行う**（6.4 節）。
- **既知のエラーは状態でなく印にする**（7.2 節）。
- **問題の解決で、問題待ちのインシデントを既定で解決する**（7.3 節）。
- **リスクは規則と質問票の高いほうを採る**（8.3 節、ADR-0024）。
- **CAB の決定は各承認者の回答で反映し、まとめての承認の操作を作らない**（8.6 節）。
- **緊急の変更も 1 人以上の承認なしに実施へ進めず、事後の CAB の承認を完了の条件にする**（8.5 節）。
- **禁止期間と凍結期間だけを blocking にし、ほかの衝突は警告にする**（9.2 節、ADR-0025）。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| 影響度を CI・サービスの重要度から自動で入れるか | E10 の CSDM のモデルができた後、E6 の利用者の調査で |
| 親子の CI の衝突の深さ（S1 は 1 段） | E7 の利用者の調査と、E10 の走査の計測で |
| 標準の変更の雛形の自動の廃止（失敗の回数） | E7 の運用の後。MVP は見直しのタスクだけ |
| 機械学習によるリスクの予測 | MVP の後。変更の履歴がたまった後 |
| CAB の会議のリアルタイムの画面（在席、議題の自動の進行） | E7 の後。利用者の要望で |
| 変更の承認の記録を J-SOX の証跡として出す形式（CSV、PDF） | L4 の確認と E11 のエクスポートで |
| 本家の既定の値（自動の完了の日数、状態の値、リスクの優先の順） | 本家の公式の本文で確かめられたら 2 節を直す。設計は本システムの値で進める |

## 15. quality.md・runbooks・data-model への項目

### quality.md

- 承認なしに `implement` に入った変更の件数：常に 0（本番の突き合わせのジョブで日次に数える。PROP-CHG-001 の本番の版）。
- 緊急の変更の割合と、事後の CAB の承認の滞留（`review` の日数）。
- 禁止期間の例外の承認の件数（月次）。
- 変更の成功率（`close_code` 別）、標準の変更の雛形ごとの失敗の件数。
- メジャーインシデントの候補の件数と、昇格・却下の割合、提案から決定までの時間。
- 自動の完了の件数と、再オープンの割合。
- 優先度の上書きの割合（高すぎると表の設計の誤りの兆し）。
- 衝突の非同期の計算し直しの遅れの p99。

### runbooks

- `change-without-approval-detected.md`：突き合わせのジョブが承認のない実施を見つけたときの調べ方（遷移の履歴、承認の行、成り代わりの記録）と、監査の担当への報告。
- `major-incident-cascade-stuck.md`：子への伝播の `bulk_job` が止まったときの確かめ方と手での再開。
- `freeze-window-setup.md`：年末年始・期末の凍結期間の登録と、例外の承認の運用。
- `conflict-recompute-lag.md`：衝突の計算し直しのジョブの遅れの確かめ方。

### data-model（索引への追加の提案）

| 置き場所 | 中身 |
| --- | --- |
| コードの版 | 状態のモデル（`incident`、`problem`、`change.*`、`generic_task`） |
| Aurora `task`（型付きの列の追加） | インシデント：`hold_reason`、`resolution_code`、`resolution_notes`、`resolved_by`、`reopen_count`、`auto_close_at`、`priority_computed`、`priority_override`、`priority_override_reason`、`major`、`major_manager_id`、`problem_id`、`duplicate_of`、`cancel_reason`。問題：`known_error`、`workaround`、`cause_notes`、`fix_notes`。変更：8.1 節の列 |
| Aurora `priority_matrix` | 5.1 節。メタデータ |
| Aurora `major_incident_candidate`、`major_incident_trigger` | 6.1 節 |
| Aurora `std_change_template`、`std_change_template_version` | 8.2 節 |
| Aurora `risk_condition`、`risk_questionnaire`、`change_risk_assessment` | 8.3 節 |
| Aurora `cab_definition`、`cab_meeting`、`cab_agenda_item` | 8.6 節 |
| Aurora `change_window` | 9.1 節。区間はカレンダーの版 |
| Aurora `change_conflict`（変更ごとの衝突の行）、`change_impact_snapshot` | 9.2〜9.4 節。`(tenant_id, change_id)`、`(tenant_id, ci_id, overlap)` |
| Aurora `change_affected_ci` | 影響を受ける CI の一覧（変更 × CI） |

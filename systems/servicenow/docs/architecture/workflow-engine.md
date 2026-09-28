# Workflow engine: ServiceNow

フローの定義（ノーコードの DSL）と版、トリガー、実行とタイマー、承認（多段・代理・期限切れ）、レコードのルール（同期・非同期、スクリプトなし）、外への呼び出し、上限とテナントの間の公平性を決める。

前提の決定は、ワークフロー・承認・SLA を Aurora の上の自前のエンジンで動かし、遷移をレコードと同じトランザクションで 1 回だけ行うこと（[ADR-0004](../decisions/0004-workflow-and-sla-engine.md)）、テナントに任意のコードを書かせず、条件は副作用のない式の言語で書くこと（[ADR-0001](../decisions/0001-platform-and-stack.md)）である。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0014](../decisions/0014-flow-dsl-and-versioning.md) | フローは JSON の文書で、決まった 16 種のノードと式の言語だけで書く。公開すると内容のハッシュを持つ不変の版になる。実行は開始したときの版に固定し、版の移し替えはしない |
| [0015](../decisions/0015-flow-execution-and-timers.md) | 実行は `flow_run`・`flow_step`・`timer` の表で持ち、1 回のステップの進みを 1 つのトランザクションで行う。トリガーはレコードの保存と同じトランザクションで実行を作る。止まった実行は不変条件の検査で見つけて戻す |
| [0016](../decisions/0016-approvals.md) | 承認は承認のまとまりと個々の承認の 2 つの行で持ち、回答は版の条件付きの更新で 1 回だけ反映する。本人の承認の禁止を既定にし、承認の記録が要るテーブルでは期限切れの自動の承認を許さない。メールの返信での承認は MVP で受けない |
| [0017](../decisions/0017-no-code-record-rules.md) | レコードのルールは「保存の前」「保存の後（同じトランザクション）」「非同期」の 3 種で、決まった操作だけを持つ。連鎖の深さを 3、同じ原因の中の同じルールの再実行を禁止する |
| [0018](../decisions/0018-flow-limits-and-tenant-fairness.md) | テナントごと・実行ごとの上限を置き、タイマーの取得をテナントごとの取り分で行い、SLA と承認の発火をフローのステップより先にする |

この文書の決定表・性質は設計の草案である。ID は E4 の各変更の `spec.md` に移すときに確定する。

## 1. 目的と範囲

- 扱う：フローの DSL と検証、版と公開、トリガー（レコード・時刻・手動・API）、実行の状態機械、ステップの実行とタイマー、条件の待ち、サブフロー、承認と代理と期限切れ、レコードのルール、外への呼び出し（Webhook）、再試行と失敗の扱い、上限と公平性、完了した実行の保持。
- 扱わない：SLA の計時（[sla-and-calendars.md](sla-and-calendars.md)。タイマーの表は共有する）、通知のテンプレートと配信（`notifications-and-email-ingest.md`）、変更の承認の方針（CAB、リスク）の業務の中身（`itsm-processes.md`）、カタログの品目のフロー（`service-catalog-and-requests.md`）、割り当ての規則（`assignment-and-on-call.md`）。
- **状態の遷移は、この領域の実行器だけが行う。** 画面・API・メールは、承認の回答やレコードの保存を Record Service に渡し、実行器が同じトランザクションの中で次の遷移を決める。

## 2. 本家の形（確かめたこと）

| 項目 | 本家 | 出典（2026-09-28 に確認） |
| --- | --- | --- |
| フローの部品 | トリガー、アクション、サブフロー、条件（フローの論理）でフローを組む | [Flows, subflows, and actions reference](https://www.servicenow.com/docs/bundle/yokohama-build-workflows/page/administer/flow-designer/reference/flow-designer-reference.html) |
| 承認のアクション | 規則：「誰か 1 人が承認」「全員が承認」「全員が回答し、誰か 1 人が承認」「% の人が承認」「n 人が承認」。却下の規則も持つ。期限を過ぎたら自動で承認・却下・取り消しにできる。承認の結果を待って次へ進む | [Ask for Approval action](https://www.servicenow.com/docs/r/washingtondc/build-workflows/ask-approval-flow-designer.html) |
| 上限の既定値 | ループの繰り返し 1,000、フローのアクション 50、アクションのステップ 20、アクションの入力 20、分岐 100 など | [Flow Designer system properties](https://www.servicenow.com/docs/bundle/washingtondc-build-workflows/page/administer/flow-designer/reference/flow-designer-system-properties.html) |
| 版 | 公開した版は 1 つだけ有効で、過去の版は記録として残る。新しい版を公開しても、動いている実行は影響を受けない | 旧来のワークフローについての本家の KB（[Overview: Workflow Versioning](https://support.servicenow.com/kb?id=kb_article_view&sysparm_article=KB0538526)、検索の結果の抜粋で確認）。Flow Designer のフローで同じかは未検証 |
| 条件の待ち | フローの中で、レコードの条件が真になるまで待つアクションがある | [Wait For Condition](https://www.servicenow.com/docs/bundle/yokohama-build-workflows/page/administer/flow-designer/reference/wait-for-condition-flow-designer.html)（本文は取得できず、検索の結果で存在だけ確認。未検証） |
| レコードのルール | サーバーのスクリプト（Business Rules）で、保存の前・後・非同期に処理を書く | [ADR-0001](../decisions/0001-platform-and-stack.md) の Context。順序と種類の細部は未検証 |

- 本家のフローの実行の基盤（表の形、タイマーの取り方）は、公開の資料で確かめられなかった（未検証）。
- 本家のフローの定義の形式・アクションの名前は写さない。スクリプトのステップは持たない（[ADR-0001](../decisions/0001-platform-and-stack.md)）。

## 3. フローの DSL と版（[ADR-0014](../decisions/0014-flow-dsl-and-versioning.md)）

### 3.1 文書の形

```
FlowDocument {
  schema: 1
  trigger: Trigger
  inputs: [{ name, type, required }]          ← サブフローと手動・API のトリガーのとき
  variables: [{ name, type }]
  nodes: { <node_id>: Node }                   ← 最大 200
  start: <node_id>
  error_handler?: <node_id>                     ← 失敗したときに進むノード（任意）
  run_as: "flow_owner_role" | "system_declared"
  writes: [<table_id>]                          ← このフローが書いてよいテーブル（5.4 節）
}

Node = { type, next?: <node_id>, ...type ごとの設定 }
値の指定は式の言語の式：trigger.record.priority、steps.<node_id>.outputs.<name>、vars.<name>
```

- 文書は Zod のスキーマで検証する。式は式の言語の型検査を通す（参照するフィールドが辞書にあり、型が合う）。
- ノードの間は木ではなくグラフでよいが、**後ろ向きの辺（ループ）を持たせない。** 繰り返しは `for_each` のノードだけで書く（停止を保証するため）。

### 3.2 トリガー

| 種類 | 設定 | 実行の作成の時点 |
| --- | --- | --- |
| `record_created` | テーブル、条件 | 保存のトランザクションの中（4 節） |
| `record_updated` | テーブル、条件、変わったフィールドの指定（任意）、「条件が偽から真になったときだけ」か「真の間は毎回」 | 同上 |
| `record_created_or_updated` | 同上 | 同上 |
| `schedule` | 繰り返し（毎日・毎週・毎月の時刻、テナントのタイムゾーン）、業務カレンダー（任意） | タイマーの発火 |
| `manual` | 入力 | 画面の操作（`tenant_admin` か、フローで指定したロール） |
| `api` | 入力 | REST API（`api-and-integrations.md`） |
| `subflow` | 入力・出力 | 親のフローのステップ |

- `record_updated` の既定は「条件が偽から真になったときだけ」にする。「真の間は毎回」は、保存のたびに実行が増えるので、画面で注意を出す。

### 3.3 ノードの種類

| ノード | 中身 | 待つか | 上限 |
| --- | --- | --- | --- |
| `if` | 条件の分岐（`branches: [{condition, next}]`、`else`） | いいえ | 分岐 10 |
| `set_variable` | 変数に式の値を入れる | いいえ | |
| `lookup_records` | テーブルと条件でレコードを読む | いいえ | 100 件 |
| `create_record` | レコードを作る（Record Service を通す） | いいえ | |
| `update_record` | 1 件のレコードを更新する | いいえ | |
| `update_records` | 条件で複数を更新する | いいえ | 1,000 件。100 件を超える分は非同期のバッチ（5.3 節） |
| `create_task` | タスクのクラスのレコードを作り、任意でその完了を待つ | 任意 | |
| `ask_approval` | 承認を依頼し、結果を待つ（7 節） | はい | 承認者 500 人 |
| `notify` | 通知の依頼を outbox に書く | いいえ | |
| `call_webhook` | 外への呼び出し（5.5 節）。結果を待つか選べる | 任意 | |
| `wait_duration` | 長さだけ待つ（業務カレンダー上の時間も選べる） | はい | 最長 366 日 |
| `wait_until` | 時刻（式）まで待つ | はい | 366 日先まで |
| `wait_condition` | レコードの条件が真になるまで待つ。**期限を必須にする** | はい | 期限は 366 日まで |
| `for_each` | 一覧の要素ごとに、中のノードの列を順に動かす | 中による | 繰り返し 1,000 |
| `subflow` | 公開済みのサブフローを呼び、終わりを待つ | はい | 入れ子の深さ 3 |
| `end` | 終える（出力を返す） | - | |

- `wait_condition` の期限を必須にするのは、条件が永遠に真にならない実行を残さないためである。期限が来たら、`on_timeout` の辺へ進む。
- `wait_duration` の業務カレンダーの時間は、[sla-and-calendars.md](sla-and-calendars.md) の `addBusinessTime` で待ち終わりの時刻を計算し、タイマーに登録する。

### 3.4 版と公開

| 表 | 列 |
| --- | --- |
| `flow_def` | `tenant_id`、`id`、`stable_key`、`name`、`kind`（`flow` / `subflow`）、`draft`（編集中の文書）、`active_version_id`、`active`、`owner_role_id` |
| `flow_version` | `tenant_id`、`id`、`flow_def_id`、`version_no`、`document`、`content_hash`、`compiled`（コンパイル済みの形）、`published_at`、`published_by`、`engine_schema` |

- 管理者は `draft` を編集する。**公開すると、`draft` を検証・コンパイルし、新しい `flow_version` の行を作る。** `flow_version` は変えない（DB のロールで `UPDATE` を与えない）。`active_version_id` を新しい版に向け、`meta_version` を上げる（[data-dictionary-and-tables.md](data-dictionary-and-tables.md) の 9 節）。
- **実行は `flow_version_id` を持ち、最後までその版で進む。** 新しい版への移し替えはしない。古い版で止めたい実行は、管理者が「取り消し」にして、新しい版で始め直す（画面で対象の実行を条件で選んで一括で行える）。
- サブフローの呼び出しは、呼ぶ側の公開の時点のサブフローの版に固定する（`subflow` のノードに `flow_version_id` をコンパイルの時に書き込む）。サブフローを新しく公開しても、呼ぶ側を公開し直すまで古い版を呼ぶ。版の間の依存を実行の時に解かないためである。
- 動いている実行が 1 つでも使っている版は消さない。完了した実行の保持（13 節）の後に、使われていない古い版を消せる。
- エンジンの版（`engine_schema`）：DSL の意味を変える変更（ノードの振る舞いの修正）は、新しい `engine_schema` として出し、古い `engine_schema` の版は古い意味で動かす。コードは両方の意味を持つ（`delivery.md` のフラグと同じ扱い）。

### 3.5 公開の時の検証（DT-FLOW-001）

| # | 検査 | 失敗のとき |
| --- | --- | --- |
| 1 | 文書のスキーマ、ノードの数（200）、分岐（10） | 422 |
| 2 | すべてのノードが `start` から到達でき、`end` か終わりに至る。後ろ向きの辺がない | 422 `unreachable_node` / `cycle` |
| 3 | 式の型検査（辞書のフィールドの存在と型） | 422 `expression_error` |
| 4 | `writes` に書くテーブルがすべて入っている | 422 `undeclared_write` |
| 5 | `wait_condition` に期限がある | 422 |
| 6 | サブフローの入れ子の深さ（呼ぶ先の版を含めて 3） | 422 |
| 7 | 同じテーブルの `record_updated` のトリガーで、自分が書くフィールドを条件に含み「真の間は毎回」 | 警告（公開はできる。自己の再起動の危険） |
| 8 | 承認の記録が要るテーブル（`requires_explicit_approval`）で、期限切れの動作が「承認」 | 422 `auto_approve_forbidden`（7.4 節） |

## 4. トリガーと条件の待ちの照合

- **レコードのトリガーは、保存のトランザクションの中で評価する**（[data-dictionary-and-tables.md](data-dictionary-and-tables.md) の 5 節の 9 段）。有効なフローのうち、テーブル（祖先を含む）と操作が合うものの条件を、保存の前後の値で評価し、合えば `flow_run`（`state = pending`）と、今すぐのタイマー（`kind = run_step`）を同じトランザクションで作る。保存がコミットされれば実行はちょうど 1 つでき、巻き戻れば実行もない。
- トリガーの評価は式の評価だけで、DB を読まない（保存の値と主体の属性だけを使う）。1 回の保存で評価するトリガーは 50 まで（テーブルごとの有効なトリガーの上限。8 節）。
- **条件の待ちの照合も、保存のトランザクションの中で行う。** `wait_condition` のステップは、`flow_wait(tenant_id, table_id, record_id, run_id, node_id)` の行を持つ。保存のとき、そのレコードの `flow_wait` の行を索引で引き、条件を評価し、真なら今すぐのタイマーを作る。待ちのために定期的にレコードを読み直さない。
- 原因の連鎖：保存が別のフロー・ルールから来たとき、`cause_depth`（原因の深さ）と `cause_chain`（原因のフローの ID の集合）を受け継ぐ。`cause_depth` が 5 を超えるか、同じフローが `cause_chain` にあれば、そのトリガーは実行を作らず、`flow_trigger_suppressed` を記録する（無限の連鎖を防ぐ。8 節）。

## 5. 実行とタイマー（[ADR-0015](../decisions/0015-flow-execution-and-timers.md)）

### 5.1 表

| 表 | 列 |
| --- | --- |
| `flow_run` | `tenant_id`、`id`、`flow_version_id`、`state`、`version`、`trigger_table_id`、`trigger_record_id`、`inputs`、`vars`、`cursor`（次に動かすノードと `for_each` の位置）、`cause_depth`、`cause_chain`、`run_as`、`steps_executed`、`started_at`、`ended_at`、`error` |
| `flow_step` | `tenant_id`、`run_id`、`seq`、`node_id`、`iteration`、`state`（`completed` / `waiting` / `failed` / `skipped`）、`outputs`、`started_at`、`ended_at`、`attempt`、`error` |
| `timer` | `tenant_id`、`id`、`shard`（0〜63）、`due_at`、`priority`（0 が高い）、`kind`（`run_step` / `wait_timeout` / `approval_due` / `schedule_trigger` / `sla_warning` / `sla_breach` / `page_escalation` / `bulk_step`）、`target_id`、`target_version`、`created_at` |
| `flow_wait` | 4 節 |

- `timer` は [ADR-0004](../decisions/0004-workflow-and-sla-engine.md) の 1 つの表で、フロー・承認・SLA・当番の呼び出しが共有する。索引は `(shard, due_at)` と `(tenant_id, target_id)`。
- 種類の追加（統合で決めた）：`page_escalation` は当番の呼び出しの段の進み（[assignment-and-on-call.md](assignment-and-on-call.md) の 6.3 節。優先度 0）、`bulk_step` は `bulk_job` の次の 100 件の処理（5.3 節。優先度 3）。種類を足すときは、8.2 節の表と観測のヒストグラムの種類のラベル（[observability.md](observability.md) の 3.3 節）を同じ PR で足す。
- `target_version`：タイマーを作ったときの対象（実行・承認・SLA の計時）の版。発火のときに対象の版と違えば、何もせず消す（古いタイマー）。

### 5.2 実行の状態機械

```
          作成（保存のトランザクション）
               │
               ▼
          pending ──ステップを動かす──▶ running ──待つノード──▶ waiting
               ▲                        │  ▲                     │
               │                        │  └──待ちが解ける──────┘
               │                        │
               │           end / 最後のノード ▶ completed
               │           失敗（error_handler なし）▶ failed
               └── 取り消し（管理者・トリガーのレコードの削除・親の実行の取り消し）▶ cancelled
```

- `running` は「今すぐのタイマーがある」状態で、ワーカーがそれを取ると次のノードを動かす。`waiting` は「承認・条件・時刻・子の実行・外への呼び出しの結果」を待つ状態。
- **不変条件（INV-FLOW-001）**：終わっていない実行は、次のどれか 1 つをちょうど持つ。今すぐの `run_step` のタイマー、待ちに対応するタイマーか待ちの行（`flow_wait`、承認のまとまり、子の実行、呼び出しの結果）。どれも持たない実行は「止まった実行」である（5.6 節）。

DT-FLOW-002（実行の遷移）：

| # | 今の状態 | 事象 | 次の状態 | 同じトランザクションで書くもの |
| --- | --- | --- | --- | --- |
| 1 | `pending`・`running` | `run_step` のタイマーの発火、次のノードが待たない | `running` | ノードの効果、`flow_step`、次の `run_step` のタイマー |
| 2 | `pending`・`running` | 同上、次のノードが待つ | `waiting` | 待ちの行・タイマー、`flow_step`（`waiting`） |
| 3 | `pending`・`running` | 同上、次がない・`end` | `completed` | 出力、親の実行への通知のタイマー |
| 4 | `pending`・`running` | ノードの失敗、`error_handler` あり | `running` | `flow_step`（`failed`）、`error_handler` への `run_step` |
| 5 | `pending`・`running` | ノードの失敗、`error_handler` なし | `failed` | `flow_step`（`failed`）、失敗の通知 |
| 6 | `waiting` | 待ちが解ける（承認の決着、条件が真、時刻、子の完了、呼び出しの結果） | `running` | `flow_step`（`completed`）、`run_step` のタイマー、待ちの行・残りのタイマーを消す |
| 7 | `waiting` | 待ちの期限 | `running` | `on_timeout` の辺への `run_step` |
| 8 | 終わっていない | 取り消し | `cancelled` | 待ちの行・タイマーを消す、開いている承認を `cancelled`、子の実行の取り消し |
| 9 | `completed`・`failed`・`cancelled` | どの事象も | 変わらない | 何もしない（古いタイマーを消すだけ） |
| 10 | - | 対象の版とタイマーの `target_version` が違う | 変わらない | タイマーを消すだけ |

### 5.3 1 回の進み ＝ 1 つのトランザクション

```
worker loop（shard ごと）:
  候補 = claim_due_timers($my_shards, 100)    ← engine_scheduler のロールの関数。(timer_id, tenant_id) だけを返す
                                                  取り分は 8.3 節。行をロックせず、本文を返さない

  for each (timer_id, tenant_id) in 候補:
    BEGIN（アプリのロール）
      SET LOCAL app.tenant_id = tenant_id
      t = SELECT * FROM timer WHERE id = timer_id FOR UPDATE SKIP LOCKED   ← RLS の下。取れなければ他のワーカーが処理中か、消化済み
      SELECT * FROM flow_run WHERE id = t.target_id FOR UPDATE
      if run.version != t.target_version or 終わっている: DELETE timer; COMMIT; continue
      ノードを動かす（Record Service を通した書き込み、承認の作成、outbox への通知・呼び出し）
      待たないノードが続くなら、同じトランザクションで続ける（最大 20 ノードか 200ms まで）
      flow_step を書き、run.version += 1、cursor を進め、次のタイマーを作り、t を DELETE
    COMMIT
```

- **ノードの効果、実行の状態、タイマーの消化と登録、outbox は 1 つのトランザクションでコミットする**（[ADR-0004](../decisions/0004-workflow-and-sla-engine.md)）。コミットの前に落ちれば全体が巻き戻り、タイマーは残るので、他のワーカーが取り直す。コミットの後に落ちれば、タイマーはもうないので 2 回目は起きない。
- **テナントをまたいで `timer` の本文を読まない。** 候補の取得だけが `engine_scheduler` のロールでテナントをまたぎ、識別子だけを返す（[ADR-0054](../decisions/0054-shared-reference-rows-and-cross-tenant-roles.md)、[security.md](security.md) の 10.4 節）。本文の読み取りと遷移は、テナントのコンテキストを設定したアプリのロールのトランザクションで行う。候補を取ってから処理するまでに他のワーカーが消化したタイマーは、取り直しで見つからないので飛ばす。
- 時刻は DB の時計（`now()`）を使う。ワーカーのプロセスの時計を使わない。
- 待たないノードを続けて動かすのは、1 つの実行のノードの列（`if` → `set_variable` → `update_record` → …）ごとに往復しないためである。上限を超えたら、今すぐのタイマーを作って区切る（他の実行に順番を譲る）。
- `update_records` の 100 件を超える分は、`bulk_job` の行に分け、別のトランザクションで 100 件ずつ進める（次の 100 件は `bulk_step` のタイマー。優先度 3）。すべて終わったら実行を進める（実行は `waiting`）。1 つのトランザクションで大量の行をロックしないためである。

### 5.4 実行の主体と権限

- フローの書き込み・読み取りは、実行の主体 `flow:<flow_def_id>` で Record Service を通す。
- `run_as = flow_owner_role`（既定）：フローの定義の `owner_role_id` のロールを持つ主体として ACL で判定する。テナントの管理者は、フローに必要なロールを持つ「フロー用のロール」を作って割り当てる。
- `run_as = system_declared`：ACL の行・フィールドの判定を行わない代わりに、書き込めるテーブルを `writes` に宣言したものに限る。読み取りは、`lookup_records` の結果を通知・Webhook に出す前に、受け手の主体で判定し直す（[access-control.md](access-control.md) の 6.2 節の 11・12 行）。`system_declared` を選べるのは `tenant_admin` と `acl_admin` の両方の承認があるときだけにする（決定。14 節）。
- 実行を始めた利用者（トリガーのレコードを保存した人）の権限は使わない。人ごとにフローの結果が変わらないようにするためである。
- 履歴（[data-dictionary-and-tables.md](data-dictionary-and-tables.md) の 7.1 節）には、`actor_kind = flow`、`actor_id = flow_def_id`、`cause_id = run_id` を残す。

### 5.5 外への呼び出し

- `call_webhook` は、outbox に `webhook.request` を書く。Notifier が送る。
- **冪等のキーは、`run_id`・`node_id`・`iteration` から作る。** 配送の再試行（同じ依頼の送り直し）は同じキーを使い、`<Brand>-Idempotency-Key` のヘッダーで送る（ヘッダーの形は `api-and-integrations.md`）。[ADR-0004](../decisions/0004-workflow-and-sla-engine.md) の「`(flow_run, step, attempt)` から作った冪等のキー」の `attempt` は、このノードの実行の回（`iteration`）と読む。配送の再試行の回数をキーに入れると、受け手が重複を見分けられないためである。
- 配送の再試行：指数の間隔（最初 10 秒、最大 1 時間）で、24 時間まで。4xx（408・429 を除く）は再試行しない。
- 結果を待つとき：Notifier が結果（状態のコード、応答の本文の先頭 64 KB）を `webhook_result` として書き、同じトランザクションで実行の `run_step` のタイマーを作る。結果が同じキーで 2 回届いても、2 回目は実行の版が進んでいるので何もしない。
- 秘密の値（資格情報）は、フローの文書に入れず、テナントの資格情報の保管（KMS で暗号化）を名前で参照する。
- 宛先は、テナントが登録した許可の一覧のホストだけにする。プライベートの IP・リンクローカル・メタデータのアドレスへの解決を拒否する（SSRF の対策。Notifier で名前解決の後に確かめる）。

### 5.6 止まった実行の回収

- 1 分ごとの検査のジョブが、INV-FLOW-001 に反する実行（終わっていないのに、タイマーも待ちの行もない）を探す。見つけたら、`run_step` のタイマーを作り直し、`flow_recovered` の事象を残し、SEV3 の警告を出す（本来は起きないので、原因を調べる）。
- タイマーの遅れ（`due_at` から取得までの時間）の p99 を計測し、60 秒を超えたら SEV2（NFR-004 の「60 秒以内に再開」）。
- ワーカーは長いロックを持たない（1 件のトランザクションは上の上限の中）。プロセスが落ちても、DB のトランザクションが巻き戻るだけなので、「持ち主の切れたリース」を回収する仕組みは要らない。

## 6. レコードのルール（[ADR-0017](../decisions/0017-no-code-record-rules.md)）

### 6.1 種類

| 種類 | 実行の時点 | 使える操作 | 使えない操作 |
| --- | --- | --- | --- |
| `before_save` | 保存の流れの 3 段（検証の前） | 自分のフィールドに値を入れる、保存を中止する（メッセージ付き）、作業メモを足す | 他のレコードの更新、外への呼び出し、通知 |
| `after_save` | 保存の流れの 7 段（同じトランザクション） | 他のレコードの作成・更新（1 回の保存で 10 件まで）、通知の依頼 | 外への呼び出し、自分のレコードの更新（`before_save` で行う） |
| `async` | コミットの後、outbox から Engine が行う | `after_save` と同じ＋外への呼び出し | - |

- ルールは `record_rule(tenant_id, id, stable_key, table_id, kind, on: [insert, update, delete], condition, actions[], order, active)` で、メタデータとして版を持つ。
- 親のクラスのルールは子のクラスにも効く。順序は `order` の昇順、同じなら親のクラスのルールが先、さらに同じなら `stable_key` の順。
- 条件と値は式の言語で書く。`before_save` の条件は、変わったフィールド（`changes.<field>`）と前の値（`previous.<field>`）を読める。
- 組み込みのルール（例：状態が「解決」になったら `resolved_at` を入れる）も同じ仕組みで持つ（コードの版に含む）。

### 6.2 連鎖と上限

- `after_save` のルールが他のレコードを更新すると、その保存の流れでもルールとトリガーが動く。**連鎖の深さは 3 まで。** 4 段目の保存は中止し、全体を巻き戻して 422 `rule_cascade_too_deep` を返す（黙って打ち切ると、データが半端になるため）。
- 同じ原因の連鎖の中で、同じルールが同じレコードに 2 回動くことを禁止する（2 回目は動かさず、`rule_suppressed` を記録する）。
- 1 回の保存でのルールの実行の時間の合計は 200ms まで。超えたら中止して 503 `rule_time_budget_exceeded`（NFR-002 の 700ms を守るため）。管理者の画面で、時間を多く使うルールを示す。
- テーブルごとの有効なルールは 50 まで。

### 6.3 ルールの値とフィールドの ACL

- ルールが入れた値は、保存した利用者のフィールドの `write` の ACL を通さない（[access-control.md](access-control.md) の 5 節）。ルールは管理者が定義したもので、利用者の入力ではないためである。
- ただし `after_save` のルールで他のレコードを書くときは、その書き込みの行の判定をフローと同じく `run_as` の主体で行う（ルールの定義に `run_as` を持たせる。既定は `flow_owner_role` と同じ形の「ルールの持ち主のロール」）。

## 7. 承認（[ADR-0016](../decisions/0016-approvals.md)）

### 7.1 表

| 表 | 列 |
| --- | --- |
| `approval_set` | `tenant_id`、`id`、`run_id`、`node_id`、`target_table_id`、`target_record_id`、`rule`、`reject_rule`、`state`（`requested` / `approved` / `rejected` / `cancelled` / `expired`）、`version`、`due_at`、`on_due`、`decided_at` |
| `approval` | `tenant_id`、`id`、`set_id`、`approver_id`、`state`（`requested` / `approved` / `rejected` / `no_longer_required` / `cancelled`）、`version`、`answered_by`（代理のとき代理の人）、`answered_at`、`comment`、`channel` |
| `delegation` | `tenant_id`、`user_id`、`delegate_id`、`starts_at`、`ends_at`、`scope`（`approvals` / `requests` の集合。`approvals` は承認の代理（DT-APR-001）、`requests` は本人のための申請の代理（[service-catalog-and-requests.md](service-catalog-and-requests.md) の DT-REQ-003 の 4 行）） |

- 承認者は、`ask_approval` のノードの設定（利用者、グループのメンバー、式：`trigger.record.caller.manager` など）から、ノードの実行の時に決めて `approval` の行にする。後からグループのメンバーが変わっても、行は変えない（誰に依頼したかを証跡として固定する）。

### 7.2 規則

| 規則 | 承認に決まる条件 | 却下に決まる条件（`reject_rule` の既定） |
| --- | --- | --- |
| `any` | 1 人が承認 | 全員が却下 |
| `all` | 全員が承認 | 1 人が却下 |
| `all_responded_any_approves` | 全員が回答し、1 人以上が承認 | 全員が回答し、全員が却下 |
| `percent(p)` | 承認の数 ≥ ⌈n × p / 100⌉ | 承認に届く見込みがなくなった（残りの全員が承認しても届かない） |
| `count(k)` | 承認の数 ≥ k | 承認に届く見込みがなくなった |

- 多段の承認は、`ask_approval` のノードを順に並べて書く（1 つのまとまりに段を持たせない）。
- 決着したら、残りの `requested` の承認を `no_longer_required` にする。

### 7.3 回答の反映

```
answer(approval_id, actor, decision, expected_version):
  BEGIN
    approval を FOR UPDATE。state != requested なら 409 already_answered
    version != expected_version なら 409
    DT-APR-001 で actor が答えられるか判定
    approval を更新（state, answered_by, answered_at, version+1）
    approval_set を FOR UPDATE。規則で決着したか評価
    決着したら：set の state と version、残りの承認を no_longer_required、
               実行の run_step のタイマー（set の結果を待ちの解けとして）
    record_change（承認のテーブルは監査の対象）、outbox（通知）
  COMMIT
```

- 同じ承認への 2 つの回答は、行のロックと版の条件で、先にコミットしたほうだけが効く。後のほうは 409 になる。
- まとまりの決着は、`approval_set` の行のロックの下で評価するので、並行の 2 つの回答が同時に「最後の 1 人」を数えても、決着は 1 回だけ起きる（PROP-FLOW-003）。

DT-APR-001（回答できるか）：

| # | 回答者 | 承認の状態 | 条件 | 結果 |
| --- | --- | --- | --- | --- |
| 1 | - | `requested` 以外 | - | 409 `already_answered` |
| 2 | 成り代わりの間 | - | - | 403（[access-control.md](access-control.md) の 8 節） |
| 3 | 承認者本人 | `requested` | 本人の承認の禁止があり、本人が対象のレコードの依頼者・作成者 | 403 `self_approval_forbidden` |
| 4 | 承認者本人 | `requested` | - | 許可 |
| 5 | 承認者の有効な代理（`delegation` が回答の時点で有効） | `requested` | 代理が本人の承認の禁止に当たる（代理が依頼者） | 403 |
| 6 | 承認者の有効な代理 | `requested` | - | 許可。`answered_by` に代理を残す |
| 7 | それ以外 | - | - | 403 |

- **本人の承認の禁止**は、`ask_approval` のノードの設定で、既定をオンにする。変更（`change`）のテーブルでは、オフにできない（組み込みの `deny_unless` の規則。J-SOX の職務の分離）。
- 代理は、回答の時点の `delegation` で判定する。依頼の時点で代理を承認者に加えない（代理の期間が変わっても、依頼の行を書き換えずに済む）。
- 管理者による「承認者の付け替え」は、元の承認を `cancelled` にし、新しい承認の行を足す（`approval` の行の承認者を書き換えない）。

### 7.4 期限切れ

- `due_at` は、ノードの設定（長さ、業務カレンダー上の長さ、式の時刻）から決め、`approval_due` のタイマーを登録する。
- `on_due`：`reject`（既定）、`cancel`、`escalate`（承認者の上長に新しい承認を足し、期限を延ばす。1 回だけ）、`approve`。
- **`approve` は、承認の記録が要るテーブル（辞書の `requires_explicit_approval`。変更は組み込みで真）では選べない**（公開の検証 DT-FLOW-001 の 8 行）。[intent.md](../intent.md) の「変更の記録は、承認のないまま実施の状態に進まない」を守るためである。本家は期限で自動の承認を選べる（2 節）。
- 期限の発火とちょうど同じ時刻の回答は、どちらか先にコミットしたほうが効く。後のほうは、まとまりが決着済みなので何もしない（回答なら 409）。

### 7.5 回答の経路

- 画面（作業の画面とポータル）と REST API（利用者の主体のトークン）で受ける。
- **メールの返信での承認は、MVP で受けない。** 差出人のなりすましの対策（SPF・DKIM・DMARC）は受信のサーバーの設定に左右され、承認の証跡の本人性を保証できない。承認の依頼のメールには、ログインを求める画面へのリンクだけを入れる（`notifications-and-email-ingest.md`）。本家がメールでの承認を持つかは未検証。

## 8. 上限と公平性（[ADR-0018](../decisions/0018-flow-limits-and-tenant-fairness.md)）

### 8.1 上限（S1 の既定。E4 の計測で見直す）

| 項目 | 上限 | 超えたとき |
| --- | --- | --- |
| フローのノードの数 | 200 | 公開できない |
| `if` の分岐 | 10 | 公開できない |
| `for_each` の繰り返し | 1,000 | そのノードを失敗にする |
| 1 つの実行で動かすノードの合計 | 5,000 | 実行を `failed`（`step_limit`） |
| サブフローの入れ子 | 3 | 公開できない |
| `lookup_records` の件数 | 100 | 先頭の 100 件だけ（出力に「打ち切り」の印） |
| `update_records` の件数 | 1,000 | そのノードを失敗にする |
| 原因の連鎖の深さ（フローとルールの間） | 5 | トリガーを抑える（4 節） |
| テーブルごとの有効なトリガー | 50 | 有効にできない |
| テナントの終わっていない実行 | 50 万 | 新しい実行の作成を抑え、`flow_run_quota_exceeded` を記録し、管理者に知らせる。保存は止めない |
| テナントの 1 分の実行の作成 | 1 万 | 超えた分の実行を `pending` のまま遅らせる（タイマーの `due_at` を後ろにずらす） |
| 実行の変数と出力の大きさ | 256 KB | ノードを失敗にする |

- 本家の既定値（ループ 1,000、アクション 50 など。2 節）は参考にし、同じ値にはしていない。
- 「新しい実行の作成を抑える」ときも、レコードの保存は止めない。業務の記録を止めるより、自動の処理が遅れるほうを選ぶ。抑えた実行は、管理者が後から一括で作り直せる（`flow_trigger_suppressed` の記録から）。

### 8.2 優先度

| `priority` | タイマーの種類 |
| --- | --- |
| 0 | `sla_breach`、`sla_warning`、`page_escalation`（当番の呼び出しの段の進み。[assignment-and-on-call.md](assignment-and-on-call.md) の 6.3 節） |
| 1 | `approval_due`、承認の決着の後の `run_step`、`wait_timeout` |
| 2 | そのほかの `run_step`、`schedule_trigger` |
| 3 | `bulk_step`（`bulk_job` の続き） |

- 平日 9 時の集中で、SLA の警告と違反の発火（NFR-003 の p99 60 秒）と当番の呼び出しを、フローの一括の処理より先にする。

### 8.3 テナントの取り分

- タイマーの取得は、1 回に最大 100 件、うち 1 つのテナントから最大 20 件にする。
- この問い合わせはテナントをまたいで `timer` を読むので、`engine_scheduler` のロールの `SECURITY DEFINER` の関数 `claim_due_timers` の中だけで行い、`(timer_id, tenant_id)` だけを返す（5.3 節、[ADR-0054](../decisions/0054-shared-reference-rows-and-cross-tenant-roles.md)）。関数はアプリのロールから直接呼べず、engine のワーカーの接続だけが使う。

```sql
CREATE FUNCTION claim_due_timers(p_shards int[], p_limit int)
  RETURNS TABLE (timer_id uuid, tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT id, tenant_id FROM (
    SELECT id, tenant_id, priority, due_at,
           row_number() OVER (PARTITION BY tenant_id ORDER BY priority, due_at) AS rn
    FROM timer
    WHERE shard = ANY(p_shards) AND due_at <= now()
    ORDER BY priority, due_at
    LIMIT 2000                                   -- 候補の窓
  ) c
  WHERE rn <= 20
  ORDER BY priority, due_at
  LIMIT p_limit
$$;
```

- 大きなテナントの大量のタイマー（月末の一括の処理）が、小さなテナントの発火を待たせない。窓（2,000 件）の外のテナントは、次の回に取られる。窓の大きさと取り分は E4 の計測で決める。
- `shard` は `hash(tenant_id, target_id) mod 64`。ワーカーの数に応じて、担当の `shard` を分ける（担当はワーカーの起動のときに Valkey のリースで決め、リースが切れたら他のワーカーが引き継ぐ。取得は `SKIP LOCKED` なので、担当が重なっても二重の処理にはならない）。

## 9. 完了した実行の保持

- 完了・失敗・取り消しの実行（`flow_run` と `flow_step`）は、90 日保持し、その後に消す。承認の行（`approval_set`・`approval`）は、監査の証跡なので、監査の履歴と同じ保持（[data-dictionary-and-tables.md](data-dictionary-and-tables.md) の 7.3 節）にする。
- 数か月続く実行（変更の予定）は、終わるまで残す。
- `flow_step` は大きくなるので、月ごとのパーティションにする。

## 10. 障害のときの振る舞い

| 障害 | 振る舞い |
| --- | --- |
| ワーカーのプロセスが落ちる | そのトランザクションは巻き戻り、タイマーは残る。他のワーカーが取る |
| Aurora の writer のフェイルオーバー | 数十秒、発火が止まる。復旧の後、`due_at` の古い順（優先度の順）に処理する。遅れは計測し、60 秒を超えたら SEV2 |
| outbox の中継が止まる | 通知と外への呼び出しが遅れる。実行の状態は進む。結果を待つ `call_webhook` は待ちのまま |
| 外の宛先が落ちている | 24 時間まで再試行し、その後ノードを失敗にする（`error_handler` へ） |
| フローの設計の誤り（大量のトリガー） | 8.1 節の上限で抑え、管理者に知らせる。保存は止めない |
| 式の評価の失敗 | そのノードを失敗にする（`error_handler` へ）。トリガーの条件の評価の失敗は、実行を作らず `flow_trigger_error` を記録する（保存は止めない） |
| 止まった実行 | 5.6 節の検査で戻す |

## 11. セキュリティ

- フローの作成・公開は `tenant_admin`。`run_as = system_declared` は `acl_admin` の承認も要る（5.4 節）。
- フローは任意のコードを持たない。式の評価器は副作用を持たない（[ADR-0001](../decisions/0001-platform-and-stack.md)）。
- 外への呼び出しの宛先は許可の一覧だけで、SSRF を防ぐ（5.5 節）。資格情報は名前で参照し、フローの文書・実行の変数・ログに入れない。
- 承認は、本人の承認の禁止、成り代わりの禁止、メールの返信を受けないことで、本人性を守る（7 節）。
- 実行の変数と出力には、読んだレコードの値が入る。実行の詳細の画面は `tenant_admin` だけにし、レコードの値は見る人の ACL で判定し直して出す。

## 12. テスト

### 12.1 決定表

- DT-FLOW-001（公開の検証）、DT-FLOW-002（実行の遷移）、DT-APR-001（回答できるか）、承認の規則の表（7.2 節）を、`spec.md` から読む表駆動テストにする。
- 否定の表：DT-FLOW-002 にない（状態、事象）の組をすべて作り、状態が変わらないことを確かめる。

### 12.2 性質ベーステスト（fast-check、DB は Testcontainers の PostgreSQL）

- **PROP-FLOW-001（ちょうど 1 回）**：任意のフローの文書と、任意の順序・重複のタイマーの発火と、任意のワーカーの数で、各ノードの効果（`flow_step` の `completed` の行とレコードへの書き込み）は、実行の経路の上でちょうど 1 回。
- **PROP-FLOW-002（実行の作成）**：任意の保存の列（途中で巻き戻る保存を含む）で、トリガーに合うコミットした保存と作られた実行が 1 対 1 に対応する。
- **PROP-FLOW-003（承認の 1 回の決着）**：任意の承認の規則・承認者の数・並行の回答・期限の発火の列で、まとまりの決着はちょうど 1 回、実行の再開もちょうど 1 回。
- **PROP-FLOW-004（版の固定）**：任意の実行の途中で任意の回数だけ新しい版を公開しても、その実行が動かすノードは、開始したときの版のノードだけ。
- **PROP-FLOW-005（止まらない）**：任意の事象の列の後で、INV-FLOW-001 が成り立つ。
- **PROP-FLOW-006（停止）**：任意の公開できたフローの文書で、実行が動かすノードの数は、ノードの数と `for_each` の上限から決まる有限の値を超えない。
- **PROP-FLOW-007（公平）**：任意のテナントごとのタイマーの数の偏りで、1 回の取得に 1 つのテナントのタイマーは 20 件を超えず、期限の来たタイマーを持つテナントは有限の回の取得で必ず取られる。

### 12.3 障害注入（E4 の必須のチェック。E12 で本番の構成でも行う）

- 障害の点：ノードの効果の途中、`flow_step` の書き込みの後、コミットの直前、コミットの直後（応答の前）、タイマーの取得の直後、承認の回答のまとまりの評価の途中、`bulk_job` の途中、outbox の中継の送信の直後。
- 各点でプロセスを落とし（`SIGKILL`）、DB の接続を切り、Aurora のフェイルオーバーを起こす。再開の後に次を確かめる（[AGENTS.md](../../AGENTS.md)）。
  - 各遷移がちょうど 1 回だけ起きる（PROP-FLOW-001 の検査を、障害の後の DB に対して行う）。
  - タイマーが失われない（INV-FLOW-001）。
  - 同じ承認の二重の反映が起きない。
  - 外への呼び出しの冪等のキーが、送り直しで同じ。
- 障害の注入の道具は、テストのビルドにだけ入る「障害の点」の呼び出し（名前付き）で行う。本番のビルドには入れない。

## 13. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E4 | `flow-dsl-schema-and-validation` | 3.1〜3.3 節の文書、DT-FLOW-001 |
| E4 | `flow-versioning-and-publish` | 3.4 節（PROP-FLOW-004） |
| E4 | `record-triggers-in-save-tx` | 4 節、原因の連鎖（PROP-FLOW-002） |
| E4 | `flow-runner-and-timers` | 5.1〜5.3 節、DT-FLOW-002（PROP-FLOW-001） |
| E4 | `flow-wait-condition` | `flow_wait` と保存の時の照合、期限 |
| E4 | `flow-run-as` | 5.4 節 |
| E4 | `webhook-step-and-idempotency` | 5.5 節、SSRF の対策 |
| E4 | `stuck-run-reconciler` | 5.6 節（PROP-FLOW-005） |
| E4 | `record-rules` | 6 節 |
| E4 | `approvals-core` | 7.1〜7.3 節、DT-APR-001（PROP-FLOW-003） |
| E4 | `approval-delegation-and-due` | 7.3 節の代理、7.4 節の期限切れ |
| E4 | `flow-limits-and-fairness` | 8 節（PROP-FLOW-006・007） |
| E4 | `flow-fault-injection-suite` | 12.3 節 |
| E4 | `flow-admin-ui` | フローの編集・公開・実行の一覧と詳細・一括の取り消し（`portal-and-ui.md` と一緒に） |
| E5 | `business-time-wait` | `wait_duration` の業務カレンダー（sla-and-calendars と一緒に） |
| E7 | `change-approval-policy-flows` | 変更の承認の方針（リスク・種類 → 段）を組み込みのフローで（`itsm-processes.md`） |
| E8 | `catalog-fulfillment-flows` | 品目ごとの承認と実行のタスク（`service-catalog-and-requests.md`） |
| E12 | `timer-burst-load-test` | 平日 9 時の集中の負荷試験（SLA 200 万件・実行 100 万件） |

## 14. 未解決の問い

### 決定（2026-09-28、既定案）

- **実行の新しい版への移し替えはしない**：取り消して始め直す（3.4 節、ADR-0014）。
- **サブフローの版は、呼ぶ側の公開の時点に固定する**（3.4 節）。
- **`wait_condition` の期限を必須にする**（3.3 節）。
- **待たないノードは 1 つのトランザクションで最大 20 ノード・200ms まで続ける**（5.3 節、ADR-0015）。
- **フローの実行の主体は、始めた利用者ではなくフローの定義で決める**（5.4 節）。
- **冪等のキーは `run_id`・`node_id`・`iteration` から作り、配送の再試行の回数を入れない**（5.5 節。ADR-0004 の `attempt` の読み方）。
- **本人の承認の禁止を既定にし、変更ではオフにできない**（7.3 節、ADR-0016）。
- **承認の記録が要るテーブルでは期限切れの自動の承認を許さない**（7.4 節）。
- **メールの返信での承認を MVP で受けない**（7.5 節）。
- **レコードのルールの連鎖が深すぎたら、打ち切らずに全体を巻き戻す**（6.2 節、ADR-0017）。
- **実行の数の上限を超えても、保存は止めない**（8.1 節、ADR-0018）。
- **タイマーの候補は `engine_scheduler` の関数 `claim_due_timers` から識別子だけで受け取り、テナントのコンテキストで取り直す**（5.3・8.3 節。統合で決めた。[ADR-0054](../decisions/0054-shared-reference-rows-and-cross-tenant-roles.md)）。
- **タイマーの種類に `page_escalation`（優先度 0）と `bulk_step`（優先度 3）を足す**（5.1・8.2 節。統合で決めた）。
- **代理の範囲 `delegation.scope` に `requests`（本人のための申請の代理）を足す**（7.1 節。統合で決めた）。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| タイマーの取得の窓（2,000）・取り分（20）・1 回の件数（100）・shard の数（64） | E4 の計測と E12 の `timer-burst-load-test` |
| 1 つのトランザクションで続けるノードの数と時間の上限 | E4 の計測（NFR-002 と画面の保存の遅れの関係） |
| 完了した実行の保持（90 日） | E11 のレポートの要件（フローの実行の分析）を見て |
| メールでの承認（署名付きの一回だけのリンクと、送信のドメインの認証の組み合わせ） | MVP の後。L2 の確認と、受信の側の認証の仕組みを `notifications-and-email-ingest.md` で決めた後 |
| テナントの任意のコードのステップ | MVP の後の別の ADR（[ADR-0001](../decisions/0001-platform-and-stack.md)） |

## 15. quality.md・runbooks・data-model への項目

### quality.md

- 障害注入の試験の結果：遷移の欠落・二重の反映 0 件（K3、NFR-004）。
- タイマーの遅れの p50・p99（種類別・優先度別）。平日 9 時の山の値。
- 止まった実行の回収の件数（常に 0 が目標）。
- 実行の失敗の割合（理由別：式、上限、外の呼び出し）。
- トリガーの抑えの件数（連鎖の深さ、同じフローの再起動、実行の数の上限）。
- 承認の回答の 409（二重の回答）の件数、期限切れの割合。
- ルールの時間の超過の件数と、時間を多く使うルールの上位。
- 外への呼び出しの再試行の回数と、24 時間の後の失敗の件数。

### runbooks

- `timer-lag.md`：タイマーの遅れの警告の確かめ方（窓・取り分・ワーカーの数・DB の負荷）と、ワーカーの増やし方。
- `stuck-flow-runs.md`：止まった実行の回収が出たときの原因の調べ方。
- `flow-runaway.md`：テナントのフローの暴走（大量のトリガー・連鎖）の止め方（フローの無効化、実行の一括の取り消し、上限の一時の引き下げ）。
- `webhook-destination-down.md`：外の宛先が落ちたときの再試行の状況の確かめ方と、手での再送。
- `approval-dispute.md`：承認の有無の問い合わせ（監査）への答え方（`approval`・`record_change`・成り代わりの記録の読み方）。

### data-model（索引への追加の提案）

| 置き場所 | 中身 |
| --- | --- |
| Aurora `flow_def`、`flow_version` | 3.4 節。`flow_version` は変えない |
| Aurora `flow_run`、`flow_step`（月ごとのパーティション）、`flow_wait`、`bulk_job` | 5.1 節 |
| Aurora `timer` | 5.1 節。フロー・承認・SLA・当番の呼び出しで共有。`(shard, due_at)`、`(tenant_id, target_id)`。取得の候補は `claim_due_timers`（`engine_scheduler`）だけがテナントをまたいで読む |
| Aurora `approval_set`、`approval`、`delegation` | 7.1 節。監査の対象 |
| Aurora `record_rule` | 6 節。メタデータ |
| Aurora `webhook_result`、`tenant_secret`（KMS で暗号化）、`webhook_allowlist` | 5.5 節 |
| Aurora `flow_trigger_suppressed`（抑えたトリガーの記録。30 日） | 4・8 節 |

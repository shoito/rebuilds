# Assignment and on-call: ServiceNow

割り当ての規則（どのグループに、誰に）、グループの中の担当者の選び方（順番・負荷・スキル）、当番表とローテーション、当番の呼び出しとエスカレーションを決める。SMS・音声での呼び出しは MVP の後（[intent.md](../intent.md) の L8）で、この文書は差し込み口だけを決める。

前提の決定は、タスクを 1 つの表 `task` に置き、`assignment_group_id`・`assigned_to_id` を共通の列に持つこと（[ADR-0003](../decisions/0003-table-hierarchy-and-extensible-schema.md)、[data-dictionary-and-tables.md](data-dictionary-and-tables.md) の 4.1 節）、テナントに任意のコードを書かせず、条件を式の言語で書くこと（[ADR-0001](../decisions/0001-platform-and-stack.md)）、タイマーを 1 つの表で持ち、遷移をちょうど 1 回にすること（[ADR-0004](../decisions/0004-workflow-and-sla-engine.md)、[ADR-0015](../decisions/0015-flow-execution-and-timers.md)）、業務時間を半開区間の純粋な関数で扱うこと（[ADR-0019](../decisions/0019-business-calendar-and-pure-time-functions.md)）である。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0026](../decisions/0026-assignment-rules-and-member-selection.md) | 割り当ての規則は順序付きの規則の表で、最初に一致した規則だけを使う。利用者が入れた割り当ては上書きしない。グループの中の担当者は、順番（最後に割り当てた時刻の古い順）・負荷・スキルのどれかで選び、メンバーの行を `FOR UPDATE SKIP LOCKED` で取って、並行の割り当てを同じ人に偏らせない |
| [0027](../decisions/0027-on-call-rotations-and-escalation.md) | 当番表は不変の版を持つ層（ローテーション）と一時の差し替えで持ち、「時刻 t の当番」を純粋な関数で求める。呼び出しは専用の状態機械とタイマーで行い、応答（受け付け）で止まる。呼び出しの経路は差し込み口にし、MVP はメールとアプリのプッシュだけにする |

この文書の決定表・性質は設計の草案である。ID は E5 の各変更の `spec.md` に移すときに確定する。

## 1. 目的と範囲

- 扱う：割り当ての規則とその評価の時点、グループの既定、担当者の選び方、メンバーの状態（不在・受け持ちの上限）、スキル、当番表（層、ローテーション、引き継ぎの時刻、差し替え）、当番の解決の関数、エスカレーションの方針、呼び出しの状態機械、応答の経路、呼び出しの経路の差し込み口。
- 扱わない：グループとメンバーの基本のモデル（[access-control.md](access-control.md) の 3.2 節）、通知のテンプレートと配信（[notifications-and-email-ingest.md](notifications-and-email-ingest.md)）、SLA のエスカレーション（[sla-and-calendars.md](sla-and-calendars.md) の違反の通知とフロー）、メジャーインシデントの宣言（[itsm-processes.md](itsm-processes.md) の 6 節。この文書は呼び出される側）、プッシュの配信の基盤（`portal-and-ui.md` のアプリ）。
- ACL と割り当ては別である。割り当ての規則は「誰の仕事か」を決め、読み書きの権限は ACL が決める（担当のグループのメンバーが読める、は ACL の規則で書く）。

## 2. 本家の形（確かめたこと）

| 項目 | 本家 | 出典（2026-09-28 に確認） |
| --- | --- | --- |
| 割り当ての規則とデータの参照の規則 | 割り当ての規則は条件でグループ（と担当者）を入れる。データの参照の規則は一致の列の完全一致で値を入れる。順序（order）の既定は 100 | コミュニティの記事と検索の結果の抜粋（[Difference between assignment rule and data lookup](https://www.servicenow.com/community/itsm-forum/difference-between-assignment-rule-and-data-lookup/td-p/544009)）。未検証 |
| 評価の順序 | 保存の前のスクリプト（order < 1000）→ データの参照・割り当てなどのエンジン → 保存の前のスクリプト（order ≥ 1000）。エンジンどうしの順序は決まっていない | [Precedence between data lookup, assignment, and business rules](https://www.servicenow.com/docs/bundle/xanadu-platform-administration/page/administer/task-table/concept/c_PrecBetweenAssignmentAndBusRules.html) |
| 担当者の選び方 | 作業の割り当ての機能（Advanced Work Assignment）は、「最後に割り当てた」（順番）や「最も余裕がある」の方針と、スキルの一致・必須のスキルを持つ | コミュニティの記事と検索の結果の抜粋。公式の本文は未検証 |
| 当番のエスカレーション | 応答がないと次の段へ進む。受け付けの要求を SMS・音声・メールで送る。「最後の受け手（catch-all）」がある。トリガーの規則で始まる | [Escalations in On-Call Scheduling](https://www.servicenow.com/docs/r/it-service-management/on-call-scheduling/escalations-oncall.html)、コミュニティの記事。段の間の既定の時間は未検証 |
| メジャーインシデントとの関係 | 昇格のとき、当番の機能が有効なら当番へ割り当てうる | [Create a major incident candidate](https://www.servicenow.com/docs/bundle/zurich-it-service-management/page/product/incident-management/task/create-major-incident-candidate.html) |

- 本家の当番表の内部のモデル（ロスターとシフトの表）と既定の値は、公開の資料で確かめられなかった（未検証）。本システムのモデルは、当番の SaaS で一般的な「層とローテーション」の形で自前に設計する。
- 本家の「割り当てとデータの参照の順序が決まっていない」は採らない。本システムは順序を明示する（3.2 節）。

## 3. 割り当ての規則（[ADR-0026](../decisions/0026-assignment-rules-and-member-selection.md)）

### 3.1 規則の形

| 列 | 意味 |
| --- | --- |
| `id`、`stable_key` | メタデータの共通の列（[data-dictionary-and-tables.md](data-dictionary-and-tables.md) の 9 節） |
| `table_id` | 対象のクラス。子のクラスにも効く |
| `order` | 小さいほど先。同じなら子のクラスの規則が先、次に `stable_key` の順 |
| `condition` | 式の言語の条件（保存の後の値。カテゴリ、CI、CI のサポートのグループ、場所、サービス、依頼者の部署など） |
| `set_group` | 固定のグループ、または式（例：`cmdb_ci.support_group`） |
| `set_fields` | 任意。影響度・緊急度などの既定値（空のフィールドにだけ入れる） |
| `member_selection` | `none`（グループのキューに置く）/ `round_robin` / `least_loaded` / `skills`（4 節） |
| `required_skills` | `skills` のとき。スキルの一覧 |
| `active` | |

- 規則は保存の前のルール（[ADR-0017](../decisions/0017-no-code-record-rules.md)）と同じ段で動く、組み込みの種類のルールである。上限（テーブルごとの有効なルール 50）には数えない。割り当ての規則はテーブルごとに 500 まで。
- 本家のデータの参照の規則（完全一致の表）は、同じ規則の `condition` で書ける（`category = 'network' AND subcategory = 'vpn'`）。別の仕組みにしない。

### 3.2 評価（DT-ASG-001）

保存の流れ（[data-dictionary-and-tables.md](data-dictionary-and-tables.md) の 5 節）の 3 段で、テナントの保存の前のルールの後に評価する。順序：テナントの保存の前のルール → 割り当ての規則 → 状態の遷移の照合（[itsm-processes.md](itsm-processes.md) の 3.2 節）。

| # | 操作 | この保存で利用者・API・メールがグループを入れた | 今のグループ | 規則のきっかけのフィールドが変わった | 結果 |
| --- | --- | --- | --- | --- | --- |
| 1 | - | はい | - | - | 規則を評価しない（人の判断を上書きしない） |
| 2 | 作成 | いいえ | 空 | - | 規則を `order` の順に評価し、最初に一致した規則を適用する |
| 3 | 更新 | いいえ | 空 | はい | 2 と同じ |
| 4 | 更新 | いいえ | あり | - | 評価しない（割り当て済みのものは動かさない） |
| 5 | 更新 | いいえ | 空 | いいえ | 評価しない |
| 6 | 2・3 で一致がない | | | | テーブルの既定のグループ（テナントの設定）。なければ空のまま「未割り当て」の一覧に出す |

- きっかけのフィールドは、規則の `condition` が参照するフィールドの和集合（コンパイルの時に求める）。
- 規則が入れたグループは、保存の流れの 4 段で、グループが `assignment` の種類を持ち `active` であることを確かめる。満たさなければ、その規則は一致しなかったとして次の規則へ進む（無効のグループへの割り当てを防ぐ）。
- **割り当てのやり直し**：担当者が「グループを空にして割り当てし直す」を押すと、`assignment_group_id` と `assigned_to_id` を空にする保存を行い、2 行（作成と同じ）で評価する。自動の付け替えはしない。

### 3.3 グループの変更と担当者

- グループが変わった保存で、`assigned_to_id` が新しいグループのメンバーでなければ空にする（組み込みの保存の前のルール）。`reassignment_count` を 1 上げる。
- `assigned_to_id` を人が入れるとき、その人が `assignment_group_id` のメンバーでなければ 422 `assignee_not_in_group`。グループが空なら、その人の既定のグループ（`user.default_group_id`）を入れる。

## 4. グループの中の担当者の選び方（[ADR-0026](../decisions/0026-assignment-rules-and-member-selection.md)）

### 4.1 メンバーの状態

| 表 | 列 |
| --- | --- |
| `group_member`（access-control の表に列を足す） | `last_assigned_at`、`assignable`（真偽。休暇などで外す）、`max_open`（受け持ちの上限。空は上限なし） |
| `user_skill` | `tenant_id`、`user_id`、`skill_id`、`level`（1〜5） |
| `skill` | `tenant_id`、`id`、`name`、`active` |
| `user_availability` | `tenant_id`、`user_id`、`[s, e)`、`kind`（`out_of_office`） |

### 4.2 選び方（DT-ASG-002）

候補 = グループのメンバーのうち、`user.active`、`group_member.assignable`、時刻 `now` に `out_of_office` でない人。

| # | `member_selection` | 候補 | 結果 |
| --- | --- | --- | --- |
| 1 | `none` | - | `assigned_to_id` を空のまま（グループのキュー） |
| 2 | どれも | 0 人 | 空のまま。グループの管理者に「割り当てられる人がいない」を知らせる（同じグループで 1 時間に 1 回まで） |
| 3 | `round_robin` | 1 人以上 | `last_assigned_at` の古い順（空は最も古い）、同じなら `user_id` の順で最初の人 |
| 4 | `least_loaded` | 1 人以上 | 受け持ち（`active` のタスクの件数）の少ない順、同じなら 3 の順。`max_open` に達した人を除く。全員が達していれば 2 と同じ |
| 5 | `skills` | 1 人以上 | `required_skills` をすべて持つ人に絞り、その中で 4 と同じ。絞った結果 0 人なら 2 と同じ（スキルを外して選ばない） |

- **並行の割り当て**：候補の `group_member` の行を、選ぶ順に並べて `FOR UPDATE SKIP LOCKED LIMIT 1` で取り、その人に割り当て、同じトランザクションで `last_assigned_at = now` にする。同時に同じグループへ割り当てる 2 つの保存は、ロック中の行を飛ばして次の人を取るので、同じ人に偏らない。ロックはその保存のコミットまで続く（保存の p99 700ms の中）。
- 受け持ちの件数は、`task` の `(tenant_id, assigned_to_id) WHERE active` の索引で数える。`least_loaded`・`skills` は、メンバーが 200 人以下のグループだけで選べる（保存の時に検査する）。数える時間を保存の予算に収めるためである。
- 選んだ結果は `record_change` の `cause_id` に規則の ID を残す（なぜその人に割り当たったかを説明できる）。
- 在席（オンラインかどうか）で選ぶことは MVP でしない。チャットの受け付けの要件（仮想エージェント）と一緒に MVP の後で扱う。

## 5. 当番表（[ADR-0027](../decisions/0027-on-call-rotations-and-escalation.md)）

### 5.1 モデル

```
OnCallSchedule {                      ← グループごとに 0 個以上
  id, group_id, name, time_zone (IANA)
  versions: 公開ごとに不変の版
}
ScheduleVersion {
  layers: [Layer]                     ← 上の層ほど優先
  effective_from                      ← この版が効き始める時刻（過去には効かせない）
}
Layer {
  members: [user_id]                  ← 順番
  rotation: { kind: daily | weekly | hours(n), handoff_local: "09:00", handoff_weekday?: mon..sun }
  anchor: 日付（ローテーションの起点。members[0] がこの日の引き継ぎから当番）
  restriction?: 週の型の区間（例：平日 18:00〜翌 09:00、土日終日）。区間の外はこの層は当番を出さない
}
Override { user_id, [s, e), reason }  ← 一時の差し替え。版の外に持つ（すぐ効かせたいため）
```

- 当番表の変更は新しい版で、`effective_from` を未来か今にする。過去の当番は変えない（誰が当番だったかの記録を守る）。
- 差し替えは版の外の行で、いつでも足せる。過去の区間の差し替えは作れない（`s ≥ now − 5 分`）。

### 5.2 当番の関数

```
onCall(version, overrides, t) → { user_id?, layer_index?, source: override | layer | none }
  1. overrides のうち [s, e) に t を含むもの。複数なら作成の新しいもの → そのユーザー
  2. layers を上から順に：restriction が t を含む（なければ常に含む）層で、
       k = floor((t − anchor の引き継ぎの時刻) / 周期)、user = members[k mod len]
     最初に見つかった層のユーザー
  3. どれもなければ none（当番の空き）
```

- 引き継ぎの時刻は現地の時刻で、夏時間の空白・重なりは [ADR-0019](../decisions/0019-business-calendar-and-pure-time-functions.md) と同じ規則（空白は直後に寄せ、重なりは早いほう）にする。周期 k の計算は、現地の暦の日・週で数える（24 時間の倍数で数えない）。夏時間のある拠点でも、引き継ぎが毎日同じ現地の時刻になるためである。
- 関数は純粋にし、現在の時刻・DB を読まない。区間の列（`[s, e) → user`）を 90 日先まで展開して画面に出す（当番の予定表）。
- **当番の空き**を、版の公開の時に 90 日先まで検査し、空きがあれば警告を出す（公開はできる）。空きの時刻の呼び出しは、エスカレーションの方針の次の段へ進む（6.3 節）。

## 6. 呼び出しとエスカレーション（[ADR-0027](../decisions/0027-on-call-rotations-and-escalation.md)）

### 6.1 方針

```
EscalationPolicy {
  id, group_id, name
  levels: [{ targets: [ schedule(id) | user(id) | group_manager ], ack_timeout: 分（既定 15、1〜120） }]
  repeat: 0〜3（既定 1。全段を回り終えたら何回繰り返すか）
  catch_all: user_id | group_manager（既定 group_manager）
  channels: [email, push]              ← MVP。sms・voice は差し込み口だけ（6.5 節）
}
```

### 6.2 呼び出しの始まり

| きっかけ | 中身 |
| --- | --- |
| メジャーインシデントの昇格 | [itsm-processes.md](itsm-processes.md) の 6.2 節の組み込みのフローが、担当のグループの方針で呼ぶ |
| 規則 | 組み込みの操作 `page_on_call(group, task, policy?)` を、フローのノード（`notify` の種類の 1 つ）とレコードのルール（非同期）から使える。例：「P1 のインシデントが業務時間の外に作られたら、担当のグループの当番を呼ぶ」 |
| 手で | 担当者の「当番を呼ぶ」の操作（`agent`） |

- 呼び出しは `(task_id, group_id)` ごとに、開いているものを 1 つだけにする（部分一意索引）。同じタスクで同じグループを 2 回呼ぶ操作は、開いている呼び出しを返す（冪等）。

### 6.3 呼び出しの状態機械

| 表 | 列 |
| --- | --- |
| `page` | `tenant_id`、`id`、`task_id`、`group_id`、`policy_version_id`、`state`（`notifying` / `acknowledged` / `resolved` / `exhausted` / `cancelled`）、`level`、`round`、`version`、`acked_by`、`acked_at`、`ack_channel`、`created_at` |
| `page_attempt` | `tenant_id`、`page_id`、`level`、`round`、`user_id`、`channel`、`sent_at`、`delivery_status` |

DT-PAGE-001：

| # | 今の状態 | 事象 | 次の状態 | 同じトランザクションで書くもの |
| --- | --- | --- | --- | --- |
| 1 | - | 呼び出しの開始 | `notifying`（level 0、round 0） | 段の受け手を解き（5.2 節の関数、時刻は DB の時刻）、`page_attempt` と outbox の通知、`ack_timeout` のタイマー |
| 2 | `notifying` | 段の受け手が 0 人（当番の空き） | `notifying`（次の段） | 空きを記録し、すぐ次の段の 1 と同じ処理 |
| 3 | `notifying` | `ack_timeout` のタイマー（版が同じ）、次の段がある | `notifying`（level + 1） | 1 と同じ処理 |
| 4 | `notifying` | 同上、最後の段、`round < repeat` | `notifying`（level 0、round + 1） | 1 と同じ処理 |
| 5 | `notifying` | 同上、最後の段、`round = repeat` | `exhausted` | `catch_all` へ通知。タスクに作業メモ「当番の応答なし」 |
| 6 | `notifying` | 受け付け（受け手の本人、6.4 節） | `acknowledged` | タイマーを消す。タスクの `assigned_to_id` が空ならその人に割り当てる（グループのメンバーのとき）。他の受け手に「受け付け済み」を知らせる |
| 7 | `notifying` | タスクが解決・完了・取り消し | `resolved` | タイマーを消す |
| 8 | `notifying` | 担当者の取り消し | `cancelled` | タイマーを消す |
| 9 | `acknowledged`・`resolved`・`exhausted`・`cancelled` | どの事象も | 変わらない | 何もしない（2 回目の受け付けは 200 で「すでに受け付け済み（誰が）」を返す） |
| 10 | - | タイマーの `target_version` と `page.version` が違う | 変わらない | タイマーを消すだけ |

- タイマーは `timer` の表（[workflow-engine.md](workflow-engine.md) の 5.1 節）に、新しい種類 `page_escalation` で登録する。優先度は 0（SLA と同じ）にする。夜中の呼び出しの遅れは、SLA の違反の通知の遅れと同じく重いためである（統合で [workflow-engine.md](workflow-engine.md) の 5.1・8.2 節の表に足した）。
- 受け手の解決は、段に入った時刻に行う（当番の引き継ぎをまたいで呼び出しが続くとき、新しい段は新しい当番を呼ぶ）。
- `exhausted` の後も、タスクの担当者は手で呼び直せる（新しい呼び出し）。

### 6.4 受け付けの経路

- **アプリのプッシュ**：通知の「受け付ける」の操作。アプリのログインのセッションで本人を確かめる。
- **メール**：本文のリンクから画面を開き、ログインの後に「受け付ける」を押す。リンクには `page_id` と受け手の `user_id` に結んだ一度だけのトークン（有効 60 分）を入れるが、**トークンだけでは受け付けない。** ログインした利用者が受け手の本人であることを確かめる。メールの転送で他人が受け付けると、当番の記録と割り当てが誤るためである。メールの返信の本文での受け付けは受けない（承認と同じ理由。[ADR-0016](../decisions/0016-approvals.md)）。
- 受け付けは `page` の行を `FOR UPDATE` し、版の条件付きで 1 回だけ反映する。

### 6.5 呼び出しの経路の差し込み口

```
PagerChannel {
  kind: email | push | sms | voice
  send(page_attempt) → { provider_message_id }      ← outbox から Notifier が呼ぶ。冪等のキーは page_attempt の ID
  onDeliveryStatus(provider_message_id, status)     ← 配信の状態（届いた・失敗）を page_attempt に書く
  onInboundAck?(…)                                  ← SMS の返信・音声の番号押しでの受け付け（MVP の後）
}
```

- MVP は `email`・`push` だけを実装する。`sms`・`voice` は、通信の事業者との契約と法令の確認（L8）の後に、別の変更で足す。利用者の電話番号（`user.mobile_phone`）は、MVP では持つだけで使わない。
- `sms`・`voice` の受け付け（返信・番号押し）は、発信の番号と受け手の番号の組で本人を推すことになり、メールと同じく本人性が弱い。足すときに、受け付けの経路としての扱いを別の ADR で決める。

## 7. 障害のときの振る舞い

| 障害 | 振る舞い |
| --- | --- |
| 同じグループへの並行の割り当て | `SKIP LOCKED` で別の人に割り当たる。全員がロック中なら、その保存は担当者を空のまま（グループのキュー）にする |
| 割り当ての規則のグループが無効 | 次の規則へ進む。最後まで一致しなければ既定のグループ（3.2 節の 6 行） |
| 当番の空き | 次の段へ進み、空きを記録する。公開の時の警告と、日次の検査（次の 7 日の空き）で知らせる |
| プッシュ・メールの配信の失敗 | `page_attempt.delivery_status` に残す。受け手が 1 人も届かない段は、`ack_timeout` を待たずに次の段へ進む（配信の失敗の知らせを受けた時点で、タイマーを今に付け替える） |
| タイマーの遅れ | 優先度 0 で取る。遅れの p99 が 60 秒を超えたら SEV2（[workflow-engine.md](workflow-engine.md) と同じ監視） |
| Notifier の停止 | 通知が遅れる。呼び出しの状態は進むので、復旧の後に段の通知がまとめて出る。送る直前に呼び出しの状態を確かめ、`notifying` でなければ送らない |

## 8. セキュリティ

- 割り当ての規則と当番表・方針の変更は `agent_admin`（グループの管理者は自分のグループの当番表と差し替えだけ）。変更はメタデータの変更として監査の履歴に残る。
- 受け付けは本人のログインを要る（6.4 節）。トークンは一度だけ・60 分・受け手に結ぶ。
- 呼び出しの通知の本文は、受け手の主体で ACL を判定して差し込む（[access-control.md](access-control.md) の 6.2 節の 11 行）。プッシュの本文（ロック画面に出る）は、番号と優先度だけにし、件名を入れない（テナントの設定で件名を入れられる）。
- 利用者の電話番号・不在の予定は個人の情報である。読めるのは本人、グループの管理者、`agent_admin`。
- 当番の予定表は、グループのメンバーと `agent` が読める。

## 9. テスト

### 9.1 決定表

- DT-ASG-001（割り当ての規則の評価）、DT-ASG-002（担当者の選び方）、DT-PAGE-001（呼び出しの遷移）と否定の表を、`spec.md` から読む表駆動テストにする。

### 9.2 性質ベーステスト（fast-check）

- **PROP-ASG-001（人の割り当てを上書きしない）**：任意の保存の列で、利用者が入れた `assignment_group_id` は、規則によって変わらない。
- **PROP-ASG-002（順番の公平）**：任意の `round_robin` のグループ（メンバー n 人、全員が候補）への任意の並行度の k 件の割り当てで、各メンバーの件数の差は高々 1（並行の `SKIP LOCKED` を含む。Testcontainers の PostgreSQL で試す）。
- **PROP-ASG-003（規則の決定性）**：同じ規則の集合と同じレコードの値なら、規則の並びの読み込みの順によらず、同じグループになる。
- **PROP-ONC-001（当番の関数の決定性と連続）**：任意の版・差し替え・時刻で、`onCall` は同じ入力に同じ結果を返す。層が制限なしで 1 つでもあれば、どの時刻でも当番がいる（空きがない）。
- **PROP-ONC-002（差し替えの優先）**：任意の版と差し替えで、差し替えの区間の中の時刻の当番は、差し替えの人。区間の外は差し替えがないときと同じ。
- **PROP-ONC-003（引き継ぎの現地の時刻）**：任意の IANA のタイムゾーン（夏時間を含む）と日付で、日ごとのローテーションの引き継ぎは、毎日同じ現地の時刻（空白の日は直後）に起きる。
- **PROP-PAGE-001（受け付けで止まる）**：任意のタイマーの発火・受け付け・タスクの解決の列（重複・並行を含む）で、`acknowledged` の後に新しい `page_attempt` は作られず、受け付けの反映はちょうど 1 回。
- **PROP-PAGE-002（停止）**：任意の方針で、`notifying` の呼び出しは、段の数 ×（repeat + 1）回のタイマーの後に必ず終わりの状態になる。

### 9.3 障害注入

- `ack_timeout` のタイマーの発火のコミットの前後、受け付けの反映の前後でプロセスを落とし、段の通知が重ならず（同じ段・同じ回の `page_attempt` が 2 つない）、受け付けが 1 回だけ。

## 10. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E3 | `group-member-assignability` | `group_member` の列の追加、不在の予定（access-control と一緒に） |
| E5 | `assignment-rules` | 3 節、DT-ASG-001（PROP-ASG-001・003） |
| E5 | `member-selection` | 4 節、DT-ASG-002（PROP-ASG-002） |
| E5 | `skills` | スキルの表と画面 |
| E5 | `on-call-schedules` | 5 節、当番の関数と予定表の展開（PROP-ONC-001〜003） |
| E5 | `on-call-overrides` | 差し替えと、その画面 |
| E5 | `escalation-policies-and-paging` | 6.1〜6.3 節、DT-PAGE-001（PROP-PAGE-001・002） |
| E5 | `paging-ack-channels` | 6.4 節、プッシュとメールの受け付け |
| E5 | `pager-channel-interface` | 6.5 節の差し込み口（email・push） |
| E6 | `major-incident-paging` | メジャーインシデントの昇格からの呼び出し（itsm-processes と一緒に） |
| E7 | `ecab-paging` | 緊急の変更の ECAB の呼び出し |
| E12 | `paging-fault-injection` | 9.3 節 |
| E13 以降 | `pager-sms-voice` | SMS・音声の経路（L8 の後） |

## 11. 未解決の問い

### 決定（2026-09-28、既定案）

- **割り当ての規則は最初に一致した 1 つだけを使い、人が入れた割り当てを上書きしない**（3.2 節、ADR-0026）。
- **データの参照の規則を別に持たず、割り当ての規則の条件で書く**（3.1 節）。
- **順番は `last_assigned_at` の古い順とし、メンバーの行を `SKIP LOCKED` で取る**（4.2 節）。
- **スキルで絞って 0 人なら、スキルを外して選ばない**（4.2 節の 5 行）。
- **当番のローテーションは現地の暦の日・週で数える**（5.2 節、ADR-0027）。
- **当番表の版は過去に効かせない。差し替えも過去に作れない**（5.1 節）。
- **呼び出しのタイマーの優先度を SLA と同じ 0 にする**（6.3 節）。
- **受け付けは本人のログインを要り、メールの返信やトークンだけでは受けない**（6.4 節）。
- **段の既定の待ちは 15 分、繰り返しは 1 回、最後の受け手はグループの管理者**（6.1 節）。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| SMS・音声の経路と、その受け付けの本人性 | L8 の確認の後、MVP の後の Epic と別の ADR で |
| 在席（オンライン）での割り当て | 仮想エージェント・チャットの受け付けと一緒に MVP の後 |
| `least_loaded` の受け持ちの重み（優先度で重みを付けるか） | E5 の利用者の調査で |
| 当番の手当て・勤務時間の集計のレポート | E11 の要望で |
| 本家の当番表の既定の値（段の待ちの時間など） | 本家の公式の本文で確かめられたら 2 節を直す |

## 12. quality.md・runbooks・data-model への項目

### quality.md

- 呼び出しの開始から受け付けまでの時間の p50・p95（段ごと）、`exhausted` の件数。
- 当番の空きの時間（週次、グループ別）。
- 呼び出しの通知の配信の失敗の割合（経路別）。
- 未割り当てのタスクの件数と滞留の時間（規則に一致しなかった件数）。
- 割り当てのやり直し（`reassignment_count ≥ 3`）のタスクの割合（規則の設計の誤りの兆し）。
- `round_robin` の偏り（グループのメンバーごとの件数の差）。

### runbooks

- `on-call-gap.md`：当番の空きの警告が出たときの確かめ方と、差し替えの入れ方。
- `paging-not-delivered.md`：呼び出しが届かないときの確かめ方（プッシュの登録、メールの抑止のリスト、`page_attempt` の状態）。
- `paging-storm.md`：規則の誤りで大量の呼び出しが出たときの止め方（方針の無効化、開いている呼び出しの一括の取り消し）。
- `unassigned-queue-growth.md`：未割り当ての滞留が増えたときの、割り当ての規則の見直しの手順。

### data-model（索引への追加の提案）

| 置き場所 | 中身 |
| --- | --- |
| Aurora `assignment_rule` | 3.1 節。メタデータ |
| Aurora `group_member`（列の追加）、`skill`、`user_skill`、`user_availability` | 4.1 節 |
| Aurora `on_call_schedule`、`on_call_schedule_version`、`on_call_override` | 5.1 節 |
| Aurora `escalation_policy`（版付き） | 6.1 節 |
| Aurora `page`、`page_attempt` | 6.3 節。`(tenant_id, task_id, group_id) WHERE state = 'notifying'` の一意 |
| Aurora `timer`（種類の追加） | `page_escalation`、優先度 0 |
| Aurora `task`（列の追加） | `reassignment_count` |

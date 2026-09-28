# Automation and flows: Salesforce

宣言的な自動化の設計：フロー（保存の前・保存の後・スケジュール・画面）、入力規則、積み上げ集計（主従）、承認のプロセス、再帰の制御、上限との結合。土台は [ADR-0005](../decisions/0005-tenancy-and-governor-limits.md)（上限。フローの要素の実行 2,000、入れ子 16）、[ADR-0008](../decisions/0008-dml-order-of-execution.md)（DML の 13 の手順）、[ADR-0009](../decisions/0009-formula-language-and-evaluator.md)（数式の言語）。この文書は ADR-0008 の手順に**合わせて**書き、手順を変えない。この文書で決めたことは、次の 4 つの ADR にある。

- フローは、版を持つ JSON のグラフで定義し、自前の解釈器で動かす。200 件の塊の全ての実行（インタビュー）を足並みをそろえて進め、問い合わせと DML の要素を塊でまとめて 1 回にする。要素の実行の数は、足並みの 1 歩を 1 と数える（[ADR-0025](../decisions/0025-flow-definition-and-bulk-engine.md)）。
- レコードの変更で動くフローは、ADR-0008 の手順 3a（保存の前）・7b（保存の後）・13（確定の後の非同期の経路）と、予定の経路（時刻で動く）に置く。同じオブジェクトのフローは実行の順の番号で並べ、同じフローは同じトランザクションで同じレコードに 1 回だけ動く（[ADR-0026](../decisions/0026-record-triggered-flow-order-and-recursion.md)）。
- 積み上げ集計は、子の変更から親の値を差分で直し、最小・最大の値が外れた時だけ親の子を集計し直す。値は正本の子から作れる写しとして、整合の検査で差を 0 に保つ。値は、集計する子の項目も読める人にだけ返す（[ADR-0027](../decisions/0027-roll-up-summaries-incremental-with-reconciliation.md)）。
- 承認は、プロセスの版・申請のインスタンス・承認の作業の項目の 3 つの状態で持ち、1 つの応答を 1 つのトランザクションにする。申請中のレコードはロックの表で守り、承認者にアクセスを与えない（[ADR-0028](../decisions/0028-approval-processes-and-record-locks.md)）。

本家の振る舞いは、2026-09-28 に次の資料で確かめた。確かめられなかったものは「未検証」と書く。本家のフローの実行系は使わない（[ADR-0001](../decisions/0001-platform-and-stack.md)）。

## 1. 目的と範囲

| 範囲に含む | 範囲に含まない（担当の領域） |
| --- | --- |
| フローの定義の形、版、有効化、要素の種類 | 数式の言語の文法と評価器（[metadata-and-runtime.md](metadata-and-runtime.md) の 7 節） |
| 保存の前・後のフロー、予定の経路、非同期の経路、スケジュールのフロー、画面のフロー | DML の手順そのもの（[metadata-and-runtime.md](metadata-and-runtime.md) の 6 節、ADR-0008） |
| 入力規則（手順 4） | 重複の規則（手順 5。[sales-objects.md](sales-objects.md) の 6 節） |
| 積み上げ集計（手順 8） | 共有の評価（手順 10。[sharing-and-record-access.md](sharing-and-record-access.md)） |
| 承認のプロセス、ロック | メール・Webhook の送信の仕組み（events-and-integrations の領域） |
| 再帰の規則、フローの上限の数え方 | 上限の値の一覧の正（governor-limits の領域） |
| フローのビルダーの画面の要件 | 利用者のコード（MVP の後。extensibility の領域） |

## 2. 本家の仕組み（確かめたこと）

| 項目 | 本家 | 出典 |
| --- | --- | --- |
| 保存の順序 | 保存の前のフロー → before トリガー → システムの検証と入力規則 → 重複の規則 → 保存（未確定）→ after トリガー → …… → 保存の後のフロー → 親・祖父母の積み上げ集計 → 条件に基づく共有の評価 → 確定 → 確定の後の処理 | [Apex Developer Guide](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_apex_developer_guide.pdf)（Winter '27 版、以下「Apex」）の「Triggers and Order of Execution」 |
| 積み上げ集計の保存 | 積み上げ集計を持つ親は、値を計算し直して親の保存の手順を通る。祖父母も同じ。再帰の保存では手順 9〜17 を飛ばす | Apex |
| フローの起動の種類 | 保存の前（`RecordBeforeSave`）、保存の後（`RecordAfterSave`）、削除の前（`RecordBeforeDelete`）、スケジュール（`Scheduled`）、イベントなど。レコードの変更は作成・更新・作成と更新・削除 | [Metadata API Developer Guide](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/api_meta.pdf)（Winter '27 版、以下「MDAPI」）の Flow |
| 実行の順 | レコードの変更で動くフローに 1〜2,000 の実行の順の番号を付けられる | MDAPI の Flow（`triggerOrder`） |
| 条件の評価 | 「条件を満たすように更新された時だけ」を選べる | MDAPI の Flow（`doesRequireRecordChangedToMeetCriteria`） |
| 予定の経路 | レコードの変更で動くフローに、時刻で動く経路を足せる | MDAPI の Flow（`scheduledPaths`） |
| 実行の文脈 | 起動の仕方で決まる既定、システム（共有を守る）、システム（全てのデータ）、利用者の権限を守る、から選ぶ | MDAPI の Flow（`runInMode`） |
| 保存の前のフロー | 起動したレコードの項目だけを変えられ、2 回目の DML と再帰の保存を避けるので速い。他のレコードの変更と送信は保存の後のフロー | [Record-Triggered Automation](https://architect.salesforce.com/docs/architect/decision-guides/guide/record-triggered.html)（Architect の判断の手引き） |
| 再帰 | 同じフローが自分の更新で再び動くことを、項目の前後の値の比べで防ぐよう勧める。同じトランザクションで何回動くかの規則は公開の資料に書かれていない（未検証。E6 の `record-triggered-flows` で試用の組織で確かめる） | 同上 |
| スケジュールのフロー | 24 時間の実行の数は 25 万か「ライセンスの数 × 200」の大きい方。1 つのフローで 25 万。取得した 1 件が 1 つの実行 | [Schedule-Triggered Flow Limits and Considerations](https://help.salesforce.com/s/articleView?id=platform.flow_considerations_trigger_schedule.htm&type=5)（2026-09-28 に確認） |
| 1 トランザクションの上限 | フローは Apex の上限（問い合わせ 100、取得の行 50,000、DML 150、DML の行 10,000、CPU 10 秒）に従い、超えると `fault` の経路があってもトランザクション全体を巻き戻す。フローの要素の数の上限（2,000）は API の版 57.0 でなくした。1 つのフローの版は 50 まで。有効なフローはフローの種類ごとに 2,000 まで | [Per-Transaction Flow Limits](https://help.salesforce.com/s/articleView?id=platform.flow_considerations_limit_transaction.htm&type=5)、[Flow Limits per Org](https://help.salesforce.com/s/articleView?id=platform.flow_considerations_limit.htm&type=5)（2026-09-28 に確認） |
| 承認 | 1 つのプロセスは 30 段まで、1 段の承認者は 25 まで。複数の承認者は全員一致か最初の応答。却下は申請の却下か前の承認者へ戻す。申請中のレコードはロックし、編集できるのは管理者か、管理者と今の承認者。申請者の取り消しを許すか選べる。承認後もロックを保つか選べる | MDAPI の ApprovalProcess |
| 承認の数の上限 | 有効なプロセスは組織で 1,000、1 オブジェクトで 300。全体で 2,000、1 オブジェクトで 500 | [Classic Approval Processes Limits](https://help.salesforce.com/s/articleView?id=platform.approvals_limits.htm&type=5)（2026-09-28 に確認） |
| 積み上げ集計の数 | 1 オブジェクト 25 が既定で、依頼で 40 まで | [Increase the Maximum Limit of Roll-Up Summary Fields](https://help.salesforce.com/s/articleView?id=000386702&type=1)（2026-09-28 に確認） |
| 入力規則の数 | 1 オブジェクトで有効なもの Enterprise・Developer 100、Unlimited・Performance 500。エディションの変更でだけ増やせる | [Increase the Active Validation Rules Limit](https://help.salesforce.com/s/articleView?id=000383591&type=1)（2026-09-28 に確認） |

## 3. フローの定義と版（ADR-0025）

### 3.1 形

```json
{
  "api_name": "set_region_from_prefecture",
  "type": "record_before_save",
  "object": "account",
  "trigger": { "on": "create_or_update", "order": 100,
               "condition": "ISCHANGED(billing_prefecture)", "only_when_changed_to_meet": false },
  "run_as": "system",
  "variables": [ { "name": "region", "type": "text" } ],
  "start": "e1",
  "elements": {
    "e1": { "kind": "decision",
            "rules": [ { "when": "CASE(billing_prefecture, '東京都', 1, '神奈川県', 1, 0) = 1", "next": "e2" } ],
            "default": "e3" },
    "e2": { "kind": "assignment", "set": [ { "target": "$Record.x_region", "value": "'kanto'" } ], "next": null },
    "e3": { "kind": "assignment", "set": [ { "target": "$Record.x_region", "value": "'other'" } ], "next": null }
  }
}
```

- 式は全て数式の言語（ADR-0009）で書く。項目は保存の時に `field_id` に束縛し、名前の変更で壊れない。
- フローは `md_flows`（`flow_id`、`api_name`、`type`、`active_version_id`）と `md_flow_versions`（`version_id`、`definition`、`status`：`draft`・`active`・`obsolete`）に持つ。
- **有効化は、メタデータの版を 1 つ上げる。** 有効な版は、レコードの変更で動くフローなら `object:<object_id>` の部品の「フローの呼び出しの表」に入る（ADR-0007）。1 つの要求は 1 つの版に固定されるので、1 つの保存の途中で古い版と新しい版のフローが混ざらない。
- 画面のフローと予定の経路は、実行を始めた時の版を最後まで使う（`flow_interviews.version_id`、`flow_scheduled_actions.version_id`）。それらが参照する版は、`obsolete` でも消さない。
- 有効化の時に検査する：式の型、到達できない要素、出口のない輪（`loop` 以外の戻り）、保存の前のフローでの禁止の要素、項目の FLS に関わらない構造の誤り。

### 3.2 要素

| 要素 | 内容 | 保存の前 | 保存の後・非同期・予定・スケジュール | 画面 |
| --- | --- | --- | --- | --- |
| `assignment` | 変数・`$Record` の項目に値を入れる | 可（`$Record` は起動したレコードだけ） | 可（`$Record` への代入は `update_records` が要る） | 可 |
| `decision` | 条件で分かれる | 可 | 可 | 可 |
| `loop` | 集まりを 1 件ずつ回す | 可 | 可 | 可 |
| `get_records` | 問い合わせ（AST） | 可 | 可 | 可 |
| `create_records`、`update_records`、`delete_records` | DML | 不可 | 可 | 可 |
| `subflow` | 自動で動くフローを呼ぶ | 不可 | 可（10 段まで） | 可 |
| `submit_for_approval` | 承認の申請（8 節） | 不可 | 可 | 可 |
| `send_email` | メールの送信（確定の後に送る） | 不可 | 可 | 可 |
| `call_webhook` | 外向きの呼び出し（確定の後に送る。応答を待たない）。宛先は `outbound_endpoints.api_name` で指し、パスと本文だけを式で作る（[events-and-integrations.md](events-and-integrations.md) の 6.1 節） | 不可 | 可 | 不可 |
| `publish_event` | 組織が定義するイベントの発行（events-and-integrations の領域） | 不可 | 可 | 可 |
| `screen` | 入力の画面 | 不可 | 不可 | 可 |
| `pause` | 時刻・イベントまで待つ | 不可 | 不可（予定の経路を使う） | 不可（MVP） |

- 上限（2026-09-28。governor-limits の領域の依頼）：`send_email` は 1 トランザクション 10 回（`tx.emails`、1 回の宛先 100 まで）、`call_webhook` は 100 件（`tx.outbound_calls`）、`publish_event` は 150 回（`tx.events_published`）。超えたら全体を巻き戻す（[governor-limits.md](governor-limits.md) の 4.1 節）。
- 保存の前のフローで DML・送信を禁じるのは、ADR-0008 の手順 3a（「同じレコードの項目だけを変えられる。DML はできない」）に合わせるため。`get_records` は許し、問い合わせの数に数える。本家も保存の前のフローで問い合わせを使えると読める（未検証。E6 の `record-triggered-flows` で試用の組織で確かめる）。
- `send_email`・`call_webhook` は、実行の中では outbox に書くだけにし、確定の後（手順 13）に送る。トランザクションが巻き戻れば送らない。応答を待つ外向きの呼び出しは MVP では持たない（トランザクションが外の相手の遅さに引きずられるため）。
- 要素にはエラーの経路（`fault`）を付けられる。DML の検証のエラー、見つからない、権限のエラーは捕まえられる。**上限の超過（`LIMIT_EXCEEDED`）は捕まえられず、トランザクション全体を巻き戻す**（ADR-0005）。

### 3.3 実行の文脈

| 起動 | 既定 | 選べるもの |
| --- | --- | --- |
| 保存の前・後、非同期の経路、予定の経路 | `system`（全てのデータ、FLS を見ない） | `system_with_sharing` |
| スケジュール | `system` | `system_with_sharing` |
| 画面 | `user`（利用者の権限・FLS・共有） | `system_with_sharing`、`system`（`customize_application` の権限で有効化する時に警告し、監査に残す） |
| 自動で動くフロー（API・サブフロー） | 呼び出した側の文脈を継ぐ | — |

- 本家の実行の文脈（MDAPI の `runInMode`）に寄せる。レコードの変更で動くフローを `system` にするのは、誰が保存しても同じ自動化の結果にするため。
- `system` のフローは、読めない項目の値を読める。フローのエラーの文言と、画面のフローで利用者に見せる値に、利用者が読めない項目の値を差し込まない（入力規則と同じ。ADR-0009）。有効化の時に、`screen` 要素と `send_email` の本文が参照する項目を一覧にして警告する。
- `system` のフローが作ったレコードの所有者は、既定で保存した利用者（予定・スケジュールでは、フローの「実行する利用者」の設定の利用者）にする。

### 3.4 フローの種類と、保存の出どころ（`$Origin`）

| `type` | 起動 | 置き場所 | 実行の文脈の既定 |
| --- | --- | --- | --- |
| `record_before_save` | レコードの作成・更新 | DML の手順 3a | `system` |
| `record_after_save` | レコードの作成・更新・削除。予定の経路・非同期の経路を持てる | 手順 7b、予定の経路、手順 13 | `system` |
| `scheduled` | 予定の時刻（9.1 節） | Worker の非同期のトランザクション | `system` |
| `screen` | 画面の操作（9.2 節） | 画面の 1 送信が 1 トランザクション | `user` |
| `autolaunched` | 他のフローの `subflow`、API | 呼び出した側のトランザクション | 呼び出した側を継ぐ |
| `event_triggered` | 組織が定義するイベント（[events-and-integrations.md](events-and-integrations.md) の 4.2 節）。2026-09-28 に events-and-integrations の領域の依頼で足した | Worker が購読者のカーソル（`event_subscriber_cursors`）で 200 件ずつ読み、1 つの非同期のトランザクションで足並みの実行にする | `system` |

- `event_triggered` のフローは、`$Record` の代わりに `$Event`（イベントの項目）を持つ。確定の後に起動するので、イベントを発行したトランザクションとは別のトランザクションになる。二重の配信は、購読者のカーソルを実行と同じトランザクションで進めて防ぐ。フローの購読は `alloc.events_delivered` に数えない（本家と同じ。[events-and-integrations.md](events-and-integrations.md) の 4.3 節）。
- **`$Origin`**（2026-09-28。bulk-and-import の領域の依頼）：フローの式で、今の保存の出どころを読める。値は `ui`（本システムの画面）、`api`（REST）、`bulk`（一括のジョブ）、`wizard`（インポートのウィザード）、`flow`（フローの DML）、`approval`（承認の動作）、`system`（型の変換・整合の検査など）。入れ子の保存では、最上位の出どころを継ぐ。変更のイベントの `origin`（[events-and-integrations.md](events-and-integrations.md) の 3.1 節）と項目の変更の履歴の `via` と同じ値を使う。
- 一括の取り込みでフローを止めたい組織は、`$Origin = 'bulk' || $Origin = 'wizard'` を条件に書く。取り込みだけ自動化を止める設定は持たない（[bulk-and-import.md](bulk-and-import.md) の 5.4 節）。

## 4. 実行の解釈器（ADR-0025）

### 4.1 足並みをそろえた実行

1 つの塊（200 件。ADR-0008）に対して、同じフローの実行（インタビュー）を 200 個作り、足並みをそろえて進める。

```
while まだ終わっていない実行がある:
    1. 各実行を、次の「まとめる要素」（get_records・create/update/delete_records・submit_for_approval）か終わりまで進める
       （assignment・decision・loop は各実行の中で進める）
    2. まとめる要素で止まった実行を、要素の ID ごとに集める
    3. 要素の ID の小さい順に、1 つの要素について:
         - get_records：各実行の条件をまとめて 1 回の問い合わせにする（条件の値が違えば IN・OR で束ね、結果を実行に配る）
         - create/update/delete_records：各実行のレコードをまとめて 1 回の DML にする（入れ子の保存。ADR-0008）
       実行したら、その要素で止まっていた実行を次へ進める
```

- 実行の順は決定的にする（要素の ID の順、塊の中のレコードの順）。同じ入力なら同じ結果と同じ上限の数になる。上限の試験が再現できる。
- `loop` の中の `get_records` も、同じ要素で止まった実行をまとめる。ただし 1 つの実行の中の繰り返しはまとめられない（繰り返しの数だけ問い合わせになる）。ビルダーで「繰り返しの中の問い合わせ・DML」に警告を出す。
- 入れ子の保存（保存の後のフローの DML）は、ADR-0008 のとおり、その DML の塊について手順 1〜8 を行う。

### 4.2 上限の数え方

| 上限（ADR-0005） | 数え方 |
| --- | --- |
| フローの要素の実行の数（2,000） | **足並みの 1 歩を 1 と数える。** 200 の実行が同じ `assignment` を通っても 1。`loop` は各繰り返しの 1 歩を 1（実行ごとに繰り返しの数が違えば、最も多い実行の数） |
| 問い合わせの数・取得の行 | まとめた問い合わせ 1 回を 1。取得の行は全ての実行の合計 |
| DML の数・行 | まとめた DML 1 回を 1。行は合計 |
| 入れ子の深さ（16） | 保存の後のフローの DML、積み上げ集計の親の保存、`subflow`（10 段まで）を足す |
| CPU 時間 | 解釈器の時間を数える。数式の評価を含む |

- ADR-0005 は「フローの要素の実行の数」をトランザクションごとに 2,000 とした。実行ごとに数えると、200 件の塊で 10 要素のフローが上限に達し、一括の取り込みが動かない。足並みの 1 歩で数えると、塊の大きさに依らず、フローの形だけで決まる。この数え方を governor-limits の領域の一覧に載せる（15 節）。

### 4.3 エラー

- 実行ごとのエラー（`fault` のない要素のエラー）は、その実行のレコードの保存の失敗にする。`all_or_none = false` なら、そのレコードを外してやり直す（ADR-0008 の部分の成功）。
- エラーの応答は `{code: "FLOW_ERROR", flow: "<api_name>", element: "<id>", message}`。`message` に値を入れない（3.3 節）。

## 5. レコードの変更で動くフロー（ADR-0026）

### 5.1 ADR-0008 の手順との対応

| 手順（ADR-0008） | この領域で動くもの |
| --- | --- |
| 2 システムの検証 | 承認のロックの検査（8.4 節） |
| 3a 保存の前のフロー | `record_before_save`（作成・更新）。3b の before トリガー（E13）はこの後 |
| 4 入力規則 | 入力規則（6 節） |
| 7b 保存の後のフロー | `record_after_save`（作成・更新・削除）。7a の after トリガー（E13）の後。予定の経路の行をここで書く（5.4 節） |
| 8 積み上げ集計 | 積み上げ集計（7 節） |
| 11 outbox | 非同期の経路の起動、`send_email`・`call_webhook` の送信の依頼 |
| 13 確定の後 | 非同期の経路の実行、送信 |

- 削除では、手順 3a のフローは動かない（ADR-0008）。E13 のトリガーは削除の前（3b）にも置ける。本家は削除の前のフロー（`RecordBeforeDelete`）を持つ（MDAPI）が、本システムは MVP で持たない。削除を止めたい時は入力規則を使えない（削除では入力規則が動かない）ので、削除の後のフローで `fault` なしの例外を起こす要素（`raise_error`）を使う。15 節の未解決の問いに残す。

### 5.2 順と条件

- 同じオブジェクト・同じ手順のフローは、`trigger.order`（1〜2,000）の小さい順、同じなら `api_name` の順に動く。本家も 1〜2,000 の順の番号を持つ（MDAPI）。
- 保存の前のフローは、前のフローの代入の結果を次のフローが見る（同じレコードの値を順に書き換える）。
- 条件（`trigger.condition`）は数式（2 値）で、`ISCHANGED`・`PRIORVALUE`・`ISNEW` を使える。
- `only_when_changed_to_meet = true`：作成では条件が真の時、更新では「前の値で偽、今の値で真」の時だけ動く。本家の同名の設定に寄せる（MDAPI）。

### 5.3 再帰（DT-FLW-001）

`$Record` は今の値、`$Record__prior` は「そのフローがそのレコードで初めて動く保存の、手順 1 で読んだ値」とする。

**DT-FLW-001：同じトランザクションでの再帰**（上から評価）

| # | 事象 | フローの種類 | このトランザクションで、同じフローが同じレコードに動いたか | 結果 |
| --- | --- | --- | --- | --- |
| 1 | 保存（最上位・入れ子） | 保存の前・後 | 動いた | 動かさない |
| 2 | 保存（最上位・入れ子） | 保存の前・後 | 動いていない | 条件を評価して動かす |
| 3 | 入れ子の保存 | 入力規則・システムの検証・重複の規則 | - | 毎回行う（フローと違い、何度でも） |
| 4 | 入れ子の保存 | 積み上げ集計 | - | 毎回行う（値が変わった時だけ親を保存） |
| 5 | 非同期の経路 | 保存の後の非同期の経路 | 同じ `(版, レコード, 起動したトランザクション)` で動いた | 動かさない（再送での重複を防ぐ。5.5 節） |
| 6 | 入れ子の深さ 17 | - | - | 全体を巻き戻す（ADR-0005） |

- 行 1 は ADR-0008 の「同じフローは、同じトランザクションで同じレコードに対して 1 回しか動かない」をそのまま書いたもの。
- そのため、保存の後のフローが同じレコードを更新すると、入れ子の保存で**保存の前のフローは動かない**（すでに動いたため）。保存の後のフローで書いた値は、保存の前のフローの正規化を通らない。ビルダーで、保存の後のフローが自分のオブジェクトを更新する時に警告する。
- 本家の再帰の回数の規則は未検証（2 節。E6 の `record-triggered-flows` で確かめる）。本システムの規則は、無限の再帰を深さの上限と行 1 で必ず止める。
- E13 のトリガー（[extensibility.md](extensibility.md) の 5 節）は、同じ規則を `DT-EXT-001`（手順 × 種類 × 事象 → 順と呼ぶか）で持つ。`DT-FLW-001` と `DT-EXT-001` は、行 1・2 の「同じもの × 同じレコードで 1 回」を同じ意味に保つ（extensibility の領域の依頼）。

### 5.4 予定の経路

- `scheduled_paths`：`{name, offset: "+3d" | "-1d", relative_to: "trigger_time" | "<date/datetime 項目>", condition?}`。
- 手順 7b で、保存の後のフローの条件が真なら、`flow_scheduled_actions(version_id, path, record_id, due_at, state = pending)` を同じトランザクションで書く。巻き戻れば行も消える。
- 基準の項目が変わる保存では、同じトランザクションで `due_at` を直す。レコードの削除で `cancelled` にする。
- Worker は 1 分ごとに、期限の来た行を `(flow, path)` ごとに 200 件ずつ拾い、1 つの非同期のトランザクションで動かす（非同期の上限）。動かす前に、レコードが残っていること、フローの条件（`only_when_changed_to_meet` は「今も真」だけ）を評価し直し、偽なら `skipped` にする。
- 本家が実行の時に条件を評価し直すかは未検証（E6 の `scheduled-paths-and-async` で確かめる）。本システムは、古い状態で動かないように評価し直す。

### 5.5 非同期の経路

- 保存の後のフローに `async_path` を付けると、確定の後に outbox から Worker が動かす。1 つの塊を 1 つの非同期のトランザクションにする。
- outbox の配信は少なくとも 1 回なので、`flow_async_runs(version_id, record_id, origin_tx_id)` を、その実行の変更と同じトランザクションで書き、同じ鍵の 2 回目は動かさない（DT-FLW-001 の行 5）。

## 6. 入力規則

- 入力規則は、真になったら**エラー**になる数式（2 値）と、エラーの文言、エラーを出す場所（項目か画面の上）、有効かどうかを持つ。
- 手順 4 で、有効な全ての規則を評価し、真になった規則のエラーをまとめて返す（最大 20 件）。1 つ目で止めない。利用者が一度に直せるようにするため。本家が全てを返すかは未検証（E6 の `validation-rules` で確かめる）。
- システムの文脈で評価する（利用者の FLS に関わらず全ての項目を読む）。文言に差し込めるのは項目の名前だけで、値は差し込めない（ADR-0009 の 7.7 節）。
- 入れ子の保存でも毎回評価する（DT-FLW-001 の行 3）。
- 入力規則の数は、1 オブジェクトで有効なもの 100 まで。本家も Enterprise で 100（2 節）。
- 一括の取り込みや連携で規則を外したい時は、条件に `$Permission.<カスタムの権限>` を書けるようにする（MVP の後。15 節）。

## 7. 積み上げ集計（ADR-0027）

### 7.1 形

| 属性 | 値 |
| --- | --- |
| 親 | 主従の親（`master_detail` の関係の親のオブジェクト）。参照の関係には作れない |
| 集計 | `count`、`sum`、`min`、`max`。本家と同じ 4 つで、平均は持たない（[Metadata API Developer Guide](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/api_meta.pdf)、Winter '27 版の CustomField の `summaryOperation`、2026-09-28 に確認） |
| 集計する子の項目 | `number`・`currency`・`percent`・`date`・`datetime`、または分類 A の数式（ADR-0009）。親をたどる数式（分類 B）は使えない |
| 条件 | 子の項目だけの数式（分類 A）。当てはまる子だけを集計する |
| 値の置き場所 | 親の `records.data`（[metadata-and-runtime.md](metadata-and-runtime.md) の 3.3 節の `rollup_summary`）と、索引の指定があればピボット |

- 1 オブジェクトの積み上げ集計は 25 まで（[metadata-and-runtime.md](metadata-and-runtime.md) の 3.4 節。本家の既定の 25 と同じ。依頼での 40 は持たない）。

### 7.2 手順 8 での更新

塊の中で変わった子（作成・更新・削除・戻す・親の付け替え）ごとに、関わる積み上げ集計と親を求め、親ごとに次の表で直す。

**DT-RUS-001：子の変更と親の値**

| # | 集計 | 子の変化（条件を満たすかの前 → 後） | 親の値の直し方 |
| --- | --- | --- | --- |
| 1 | `count` | 外 → 中 | ＋1 |
| 2 | `count` | 中 → 外（削除を含む） | −1 |
| 3 | `sum` | 外 → 中 | ＋新しい値 |
| 4 | `sum` | 中 → 外 | −古い値 |
| 5 | `sum` | 中 → 中 | ＋（新しい値 − 古い値） |
| 6 | `min`・`max` | 外 → 中、中 → 中で新しい値が今の値を越える（`min` なら小さい） | 新しい値にする |
| 7 | `min`・`max` | 古い値が今の値と等しく、中 → 外か、中 → 中で悪くなる | 親の子を集計し直す（7.3 節） |
| 8 | `min`・`max` | それ以外 | 変えない |
| 9 | どれも | 親の付け替え | 古い親で「中 → 外」、新しい親で「外 → 中」として扱う |

- 値は 10 進で計算する（丸めない。ADR-0002）。空の値の子は `sum` で 0 として、`min`・`max` では数えない。
- 直した値が前と違う親だけを、入れ子の保存（親の手順 1〜8）にする（ADR-0008 の手順 8）。親の保存の後のフローも動き、祖父母の積み上げ集計も同じ規則で直す。
- 親を `FOR UPDATE` で読む順を、`(object_id, id)` の順にそろえ、塊どうしのデッドロックを避ける。同じ親に子を並行で足すと、親の行ロックで順番になる。本家も親の行ロックの競合を避けるため、子を親ごとにまとめるよう勧める（[Best Practices for Deployments with Large Data Volumes](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_large_data_volumes_bp.pdf)、以下「LDV」）。

### 7.3 集計し直し

- 行 7 と、定義の作成・変更（7.4 節）と、整合の検査（7.5 節）で、親の子を集計し直す。`record_relationships` の `(org_id, parent_id, child_object_id, field_no)` の索引で子を引き、`records.data` の値を集計する（[data-storage.md](data-storage.md) の 3.2 節）。
- 手順 8 の中の集計し直しは、問い合わせの数に 1 と数え、**取得の行（50,000）には数えない**。そのかわり、子が 5 万件を超える親は同期で集計し直さず、今の値のまま `rollup_stale` に入れ、Worker が非同期で直す。子の数は `stats_owner_counts` と同じく outbox から数える親ごとの子の数で判断する。
- 取得の行に数えないのは、積み上げ集計が利用者の問い合わせではなく保存の一部で、親の子の数は利用者が決めた問い合わせの大きさではないため。数えると、子の多い親の子を 1 件直すだけで上限を超える。この例外を governor-limits の領域の一覧に載せる（15 節）。

### 7.4 定義の作成・変更

- 積み上げ集計の作成・変更（集計、項目、条件）は、メタデータの版を上げ、項目を `building` にする。Worker が親の ID の範囲（1 万件）ごとに集計し直して書く。
- `building` の間、その項目の値は読みで空を返し、記述に `state: building` を返す。条件に使う問い合わせは、ピボットを使わない（型の変換の間と同じ。[metadata-and-runtime.md](metadata-and-runtime.md) の 5.2 節）。
- `building` の間の子の保存は、範囲を済ませた親だけ 7.2 節の差分で直す（共有のルールの版の作成と同じ考え方。[sharing-and-record-access.md](sharing-and-record-access.md) の 7.2 節）。

### 7.5 整合の検査

- 積み上げ集計の値は、正本（子）から作れる写しとして扱う。整合の検査（[data-storage.md](data-storage.md) の 6 節）の一部として、7 日で全ての親を一周し、集計し直した値と比べる。差があれば直し、`rollup_mismatch_total` を数えて警告する（保存の経路の不具合として調べる）。
- `rollup_stale` の親は 1 時間以内に直す。

### 7.6 FLS

- **積み上げ集計の値は、見る人が積み上げ集計の項目と、集計する子の項目と、条件が参照する子の項目を全て読める時にだけ返す。** 1 つでも読めなければ、その項目を読めない項目として扱う。
- 子の金額を読めない人に、親の合計から金額を推し量らせないため。数式の FLS（ADR-0009）と同じ考え方にする。本家の振る舞いは未検証（E6 の `rollup-summaries` で確かめる）。
- 共有：主従の子は親に連動する（`controlled_by_parent`）ので、親を読める人は子も読める。ただし、`view_all` で親を読めずに子だけを読める例外（共有の領域の DT-SHR-001 の行 4）がある。この場合も、積み上げ集計は親の値なので、親を読めなければ出ない。

## 8. 承認のプロセス（ADR-0028）

### 8.1 形

```
approval_process（object、版、order、active）
 ├─ entry_condition：数式
 ├─ allowed_submitters：owner | users | roles | groups
 ├─ record_editability：admin_only | admin_or_current_approver
 ├─ allow_recall、final_approval_lock、final_rejection_unlock
 ├─ actions：on_submit、on_final_approval、on_final_rejection、on_recall（項目の更新、メールの通知）
 └─ steps[]（30 まで）
      ├─ condition：数式（偽なら飛ばす）
      ├─ approvers（25 まで）：user | queue | manager_of_submitter | manager_of_owner | user_field
      ├─ when_multiple：unanimous | first_response
      ├─ reject_behavior：reject_request | back_to_previous（1 段目は reject_request だけ）
      └─ actions：on_approve、on_reject
```

- 本家の承認のプロセスの形（MDAPI の ApprovalProcess）に寄せる。30 段・25 の承認者も同じ。
- 同じオブジェクトに複数の有効なプロセスを持て、`order` の順に入口の条件を評価し、最初に当てはまったものを使う。1 オブジェクトで有効なプロセスは 50 まで、組織で 1,000 まで（本家は 1 オブジェクト 300、組織 1,000。2 節）。
- 定義は版を持ち、申請のインスタンスは申請した時の版を最後まで使う。

### 8.2 状態

**インスタンス（`approval_instances`）**

```
            submit
   (none) ─────────▶ pending ──┬── 最後の段で承認 ─────────▶ approved
                        │      ├── 却下（reject_request）───▶ rejected
                        │      ├── 取り消し ─────────────────▶ recalled
                        │      └── 承認者を決められない ────▶ error ── 管理者が直して再開 ─▶ pending
                        └── 段の承認 → 次の段（飛ばす段は飛ばす）
```

**作業の項目（`approval_work_items`。段 × 承認者）**

```
 pending ──承認──▶ approved
    │   ──却下──▶ rejected
    │   ──付け替え（管理者・キューの引き取り）──▶ reassigned（新しい作業の項目を作る）
    └── 段が終わった（first_response で他の人が応答、却下など）──▶ cancelled
```

**DT-APR-001：段の応答の結果**（上から評価）

| # | `when_multiple` | 応答 | 他の作業の項目 | `reject_behavior` | 結果 |
| --- | --- | --- | --- | --- | --- |
| 1 | - | 却下 | - | `reject_request` | インスタンスを `rejected`。残りの作業の項目を `cancelled`。段の却下と最終の却下の動作 |
| 2 | - | 却下 | - | `back_to_previous` | 前の段の承認者に新しい作業の項目を作る。段の却下の動作 |
| 3 | `first_response` | 承認 | - | - | 段を承認。残りを `cancelled`。次の段へ |
| 4 | `unanimous` | 承認 | まだ `pending` がある | - | 待つ |
| 5 | `unanimous` | 承認 | 全て `approved` | - | 段を承認。次の段へ |
| 6 | - | 段を承認し、次の段がない | - | - | インスタンスを `approved`。最終の承認の動作 |

### 8.3 トランザクション

- **申請・応答・取り消し・付け替えは、それぞれ 1 つのトランザクション**にする。インスタンスを `FOR UPDATE` で読み、作業の項目の `row_version` を比べる。同じ作業の項目への 2 回目の応答は 409 `WORK_ITEM_ALREADY_DECIDED`。
- 動作（項目の更新）は、同じトランザクションの DML として、通常の手順（ADR-0008）を通る。承認の動作の保存の後のフローも動く。メールの通知は outbox から確定の後に送る。
- 申請は、画面の操作、API（`POST /api/v1/approvals/submit`）、フローの `submit_for_approval`（保存の後のフローの中なら、その保存のトランザクションの中）で行う。
- 1 つのレコードで `pending` のインスタンスは 1 つまで（一意の索引で守る）。

### 8.4 ロック

- 申請でロックの行 `approval_locks(record_id, instance_id, editability)` を書く。`approved` で `final_approval_lock` が偽なら、`rejected` で `final_rejection_unlock` が真なら、`recalled` なら、ロックを外す。
- 保存の手順 2（システムの検証）で、ロックされたレコードへの更新・削除を、次の表で判定する。

**DT-APR-002：ロックされたレコードの更新**（上から評価）

| # | 保存の主体 | `modify_all_data`・オブジェクトの `modify_all` | 今の承認者 | `editability` | 結果 |
| --- | --- | --- | --- | --- | --- |
| 1 | 承認のプロセス自身の動作 | - | - | - | 可 |
| 2 | `system` の文脈の自動化（レコードの変更・予定・スケジュールのフロー） | - | - | - | 可（監査に「ロックを越えた更新」を残す） |
| 3 | 利用者（画面・API・`user` の文脈のフロー） | あり | - | - | 可 |
| 4 | 利用者 | なし | はい | `admin_or_current_approver` | 可 |
| 5 | 利用者 | なし | - | - | 400 `RECORD_LOCKED` |

- 本家の `recordEditability`（管理者だけ、管理者と今の承認者）に寄せる（MDAPI）。行 2 の本家の振る舞い（自動化がロックを越えるか）は未検証（E6 の `approval-processes` で確かめる）。
- ロックの確認は、ロックの表の主キーの読み 1 回（塊ごとにまとめる）。

### 8.5 承認者とアクセス

- 承認者は、段に入る時に決める（`manager_of_submitter` は申請者の `manager`、`user_field` はレコードの利用者の参照の項目の値。キューはキューのメンバーの誰かが応答する）。
- **承認者にレコードへのアクセスを与えない。** 段に入る時に、決まった承認者（キューならメンバーのうち 1 人以上）がレコードを `read` 以上で読めるかを確かめる。読めなければ、インスタンスを `error` にし、プロセスの管理者（`approval_admins`）に知らせる。
- 本家が承認者にアクセスを与えるかは未検証（E6 の `approval-processes` で確かめる）。本システムでは、共有の判定を 1 か所（共有の領域）に保ち、承認という別の経路で見える範囲が広がらないようにする。上司が承認者の多くの場合は、ロール階層で読める。
- 作業の項目の一覧（「自分の承認待ち」）は、承認者が読めるレコードの作業の項目だけを返す（段に入った後に共有が変わった場合に備える）。

## 9. スケジュールのフローと画面のフロー

### 9.1 スケジュールのフロー

- `schedule`：`once`・`daily`・`weekly`、開始の日時（組織のタイムゾーン）。対象：オブジェクトと条件（問い合わせの AST）。
- Worker が、予定の時刻に対象を ID の順に 200 件ずつ読み、1 塊を 1 つの非同期のトランザクションで動かす。組織の公平な順番（ADR-0005）に入れる。
- 24 時間の実行（対象の 1 件が 1 つ）は、組織で 25 万か「ライセンスの数 × 200」の大きい方、1 つのフローで 25 万まで。本家の値に合わせる（2 節）。超えた分は次の予定に回さず、`skipped` として記録し知らせる。
- 実行の途中で止まったら、最後に確定した塊の次から再開する（`flow_schedule_runs.last_record_id`）。

### 9.2 画面のフロー

- 実行の状態を `flow_interviews(interview_id, user_id, version_id, state, current_element, expires_at)` に持つ。`state` は変数の値で、KMS のデータキーで暗号化する。
- 画面の 1 回の送信を 1 つのトランザクションにする。次の画面までの要素を実行し、`screen` で止まって状態を保存する。
- 「戻る」は、最後の DML の要素より後の画面にだけ戻れる（DML をやり直さないため）。
- 使われない実行は 7 日で `expired` にし、状態を消す。
- 画面のフローは、レイアウトの操作とリストビューから起動できる（[ui-layouts-and-list-views.md](ui-layouts-and-list-views.md) の 3.1 節）。

### 9.3 デバッグ

- `POST /api/v1/flows/{id}/versions/{v}/debug`：指定した入力で実行し、**必ず巻き戻す**トランザクションで動かし、要素ごとの足跡を返す。`customize_application` が要る。
- 足跡の値は、デバッグする人が読める項目だけを出す（`view_all_data` がなければ、読めない項目の値を伏せる）。

## 10. 上限（S1 の初期値）

| 上限 | 値 | 本家 |
| --- | --- | --- |
| フローの要素の実行（1 トランザクション、足並みの 1 歩で数える） | 2,000（ADR-0005） | 上限なし（API の版 57.0 でなくした。2 節）。本システムは CPU 時間を近似でしか数えないので残す |
| 1 つのフローの版の要素 | 500 | 未検証 |
| 1 つのフローの版の数 | 50（古い `obsolete` から消せる。実行中の参照があれば消さない） | 50（2 節） |
| 1 オブジェクト・1 手順の有効なレコードの変更のフロー | 50 | 未検証 |
| 実行の順の番号 | 1〜2,000 | 1〜2,000（MDAPI） |
| `subflow` の段 | 10 | 未検証 |
| 予定の経路（1 フロー） | 10 | 未検証 |
| 組織の `pending` の予定の行 | 1,000 万 | 未検証 |
| スケジュールのフローの 24 時間の実行 | 25 万か ライセンス × 200 の大きい方。1 フロー 25 万 | 同じ（2 節） |
| 組織の生きている画面のフローの実行 | 5 万 | 未検証 |
| 入力規則（1 オブジェクトの有効なもの） | 100 | Enterprise 100、Unlimited 500（2 節） |
| 入力規則のエラーの返す数 | 20 | 未検証 |
| 積み上げ集計（1 オブジェクト） | 25 | 既定 25、依頼で 40（2 節） |
| 同期で集計し直す子の数 | 5 万 | — |
| 承認の段・1 段の承認者 | 30・25 | 30・25（MDAPI） |
| 有効な承認のプロセス（1 オブジェクト・組織） | 50・1,000 | 300・1,000（2 節） |

本家の列の「未検証」は、本家の値を公開の資料で確かめていないもの。本システムの値は本家に依らず、E12 の `limits-final-values` で決める。

- 値は governor-limits の領域の一覧にも載せ、そちらを正とする。

## 11. 障害のとき

| 事象 | 振る舞い |
| --- | --- |
| フローの版の有効化の検査をすり抜けた誤り | 実行時のエラーはその保存の失敗になる。`flow_runtime_errors_total{flow}` を数え、1 時間に 100 件を超えたら管理者に知らせる。管理者は版を戻す（前の版の有効化も版を上げる） |
| 予定の経路の Worker が止まる | 行は `pending` で残る。再開で期限の古い順に動かす。遅れが 1 時間を超えたら警告 |
| 非同期の経路の二重の配信 | `flow_async_runs` で 2 回目を動かさない |
| 積み上げ集計の差（整合の検査） | 直して数える。保存の経路の不具合として調べる |
| `rollup_stale` がたまる | 1 時間を超えたら警告。子の多い親の組織に、子を親ごとにまとめた取り込みを案内する |
| 同じ親への子の並行の保存でロックの待ちが長い | 親のスキュー（[sharing-and-record-access.md](sharing-and-record-access.md) の 8 節）の警告と同じ扱い。`rollup_parent_lock_wait_seconds` を計測する |
| 承認者を決められない・読めない | インスタンスを `error` にし、プロセスの管理者に知らせる |
| スケジュールのフローが 24 時間の上限を超える | 超えた分を `skipped` にし、管理者に知らせる |
| 画面のフローの状態の復号の失敗（鍵の切り替えの誤り） | その実行を `expired` にし、利用者に最初からやり直してもらう |

## 12. セキュリティ

- `system` の文脈のフローは強い。有効化は `customize_application` の権限を持つ人だけ。画面のフローを `system` にする時は警告と監査。
- フローのエラー・入力規則の文言・画面のフローの表示に、見る人が読めない項目の値を差し込まない（3.3 節、6 節）。
- 積み上げ集計は、集計する子の項目も読める人にだけ返す（7.6 節）。
- 承認は、承認者にアクセスを与えない。承認待ちの一覧は読めるレコードだけ（8.5 節）。
- ロックを越える自動化の更新は、監査に残す（DT-APR-002 の行 2）。
- 画面のフローの状態は暗号化し、7 日で消す。デバッグの足跡は読める値だけ。
- `call_webhook` の宛先は、組織が登録した宛先の一覧だけにする（events-and-integrations の領域）。フローの式で任意の URL を作らせない。
- `security:sensitive` の対象：実行の文脈の判定、DT-APR-002、積み上げ集計の FLS、デバッグの足跡の伏せ方。

## 13. テスト

- 決定表：`DT-FLW-001`（再帰）、`DT-RUS-001`（積み上げ集計の差分）、`DT-APR-001`（段の応答）、`DT-APR-002`（ロック）を spec から読み込む表駆動テストにする。
- 性質ベーステスト（fast-check）：
  - 任意のフロー（生成したグラフ）と任意の塊で、足並みをそろえた実行の結果が、1 件ずつ順に実行した結果と同じ（まとめても意味が変わらない）。上限の数は塊の大きさに依らない。
  - 任意の子の操作の列（作成・更新・削除・戻す・付け替え・条件の出入り）で、差分で直した積み上げ集計の値が、全ての子から集計し直した値と一致する。
  - 任意の DML の列（フローが同じレコードと他のレコードを変える）で、各（フロー、レコード）は 1 トランザクションに 1 回しか動かず、深さ 16 を超えない限り終わる。
  - 任意の承認の操作の列（申請・承認・却下・取り消し・付け替え・並行の応答）で、インスタンスの状態が 8.2 節の状態機械の中にあり、`pending` のインスタンスはレコードごとに 1 つまで。
  - 任意の権限の形で、積み上げ集計の値が、7.6 節の条件を満たす時だけ返る。
- 上限の試験：フローの要素の実行 2,000（足並みで数えて）で通り 2,001 で全体が巻き戻る。上限の超過を `fault` で捕まえても巻き戻る。入れ子の深さ 16・17。`subflow` 10。スケジュールの 24 時間の上限。承認の段 30・承認者 25。同期で集計し直す子 5 万。
- 障害の注入：outbox の二重の配信で非同期の経路が 1 回だけ動く。予定の経路の Worker の停止と再開。積み上げ集計の値をわざとずらし、整合の検査が直して数える。
- 結合テスト：ロックされたレコードの更新が、利用者の API で 400、承認の動作と `system` のフローで通る。承認者がレコードを読めない時に `error` になる。

## 14. この領域の ADR

| ADR | 決定 |
| --- | --- |
| [0025](../decisions/0025-flow-definition-and-bulk-engine.md) | フローは版を持つ JSON のグラフで定義して自前の解釈器で動かす。塊の実行を足並みをそろえて進めて問い合わせと DML をまとめ、要素の実行は足並みの 1 歩で数える。実行の文脈は、レコードの変更は `system`、画面は `user` を既定にする |
| [0026](../decisions/0026-record-triggered-flow-order-and-recursion.md) | レコードの変更で動くフローを ADR-0008 の手順 3a・7b・13 と予定の経路に置き、実行の順の番号で並べる。同じフローは同じレコードに 1 トランザクションで 1 回。予定の経路は同じトランザクションで行を書き、動かす前に条件を評価し直す |
| [0027](../decisions/0027-roll-up-summaries-incremental-with-reconciliation.md) | 積み上げ集計は子の変更から差分で直し、最小・最大が外れた時だけ集計し直す。集計し直しは取得の行に数えず、子 5 万件を超える親は非同期にする。整合の検査で差を 0 に保ち、集計する子の項目も読める人にだけ返す |
| [0028](../decisions/0028-approval-processes-and-record-locks.md) | 承認はプロセスの版・インスタンス・作業の項目の状態で持ち、応答ごとに 1 トランザクションにする。申請中はロックの表で守り、承認者にアクセスを与えない |

他の領域への依頼：

- governor-limits の領域：要素の実行を足並みの 1 歩で数えること（4.2 節）、積み上げ集計の集計し直しを取得の行に数えないこと（7.3 節）を一覧に載せる。
- metadata-and-runtime の領域：`rollup_summary` の項目の `state = building` を、型の変換と同じ扱いに足す。
- data-storage の領域：整合の検査に積み上げ集計を足す。`approval_locks` を足す。

## 15. Story の候補

| Epic | Story の候補 |
| --- | --- |
| E1 | CI：`DT-FLW-001`・`DT-RUS-001`・`DT-APR-*` の表駆動テストの枠。足並みの実行と 1 件ずつの実行の一致の性質ベーステストの枠 |
| E3 | 保存の手順 2 のロックの確認の差し込み口（承認がなくても空の表で動く） |
| E6 | 入力規則（手順 4）：全ての規則の評価、最大 20 件のエラー、文言の差し込みの制限 |
| E6 | フローの定義の形、版、有効化の検査、`object` の部品のフローの呼び出しの表 |
| E6 | 解釈器：足並みの実行、まとめる要素、上限の数え方、`fault` |
| E6 | 保存の前のフロー（手順 3a）と保存の後のフロー（手順 7b）、実行の順、条件、DT-FLW-001。`$Origin` |
| E6 | 予定の経路（行の書き込み、基準の項目の変更、Worker、条件の評価し直し） |
| E6 | 非同期の経路と `flow_async_runs` |
| E6 | 積み上げ集計：差分の直し（DT-RUS-001）、集計し直し、`rollup_stale`、定義の `building` |
| E6 | 積み上げ集計の整合の検査と FLS（7.6 節） |
| E6 | 承認のプロセスの定義、申請・応答・取り消し・付け替え、状態機械 |
| E6 | 承認のロック（DT-APR-002）と、承認待ちの一覧 |
| E6 | スケジュールのフロー（予定、塊、24 時間の上限、再開） |
| E6 | 画面のフロー（状態の保存と暗号化、戻る、期限）と、レイアウトの操作からの起動 |
| E6 | フローのビルダー（画面）とデバッグ（巻き戻す実行、足跡の伏せ方） |
| E8 | `send_email`・`call_webhook`・`publish_event` の要素と outbox の結合。`event_triggered` のフローとカーソル |
| E9 | 一括の取り込みでのフローの足並みの実行の性能（200 件の塊） |
| E11 | フローの有効化、`system` の画面のフロー、ロックを越えた更新の監査 |
| E12 | 上限の試験（2,000、16、5 万）と、子の多い親の積み上げ集計の負荷試験 |

## 16. 未解決の問い

- 削除の前のフロー（本家の `RecordBeforeDelete`）を持つか。削除を止める規則をどう書かせるか。
- 保存の後のフローが同じレコードを更新した時に、保存の前のフローを動かさない規則（DT-FLW-001 の行 1）で、利用者が困らないか。
- 要素の実行を足並みの 1 歩で数えるのは、ADR-0005 の意図に合うか。
- 積み上げ集計の集計し直しを取得の行に数えない例外は妥当か。
- 承認者にアクセスを与えない方針で、承認の業務が回るか（本家の振る舞いは未検証。E6 の `approval-processes` で確かめる）。
- ロックを `system` の自動化が越えることを許すか。
- 入力規則を外すためのカスタムの権限（`$Permission`）を MVP に入れるか。
- 応答を待つ外向きの呼び出しをフローに持つか。

### 決定

2026-09-28 の既定案。

- 削除の前のフローは MVP で持たない。削除の後のフローの `raise_error` 要素で削除を止められるようにする（巻き戻る）。要望を見て、ADR-0008 の削除の手順に削除の前のフローを足す ADR を検討する。
- DT-FLW-001 の行 1 のまま作り、ビルダーで警告する。本家の再帰の回数を E6 で本家の試用の組織で確かめ、違いが業務に響くなら見直す。
- 足並みの 1 歩で数える。governor-limits の領域の ADR で正式に決めてもらう。
- 例外として扱い、代わりに同期で集計し直す子の数（5 万）を上限にする。
- 承認者にアクセスを与えない。E6 で、承認者が読めずに `error` になる率を計測し、高ければ「承認の間だけの読みの付与」を共有の領域の理由として足す ADR を検討する。
- `system` の自動化はロックを越えられる。監査に残す。
- `$Permission` は MVP の後。
- 応答を待つ外向きの呼び出しは持たない。非同期の経路と Webhook で代える。

## 17. quality.md・runbooks・data-model に載せるもの

**quality.md**

- リスク：自動化の無限の再帰・暴走。DT-FLW-001、深さと要素の上限の試験、性質ベーステスト。
- リスク：足並みの実行と 1 件ずつの実行の意味の違い（まとめの誤り）。一致の性質ベーステスト。
- リスク：積み上げ集計の値のずれ。差分と集計し直しの一致の性質ベーステスト、整合の検査。
- リスク：`system` のフロー・積み上げ集計を通した値の漏れ。7.6 節と 3.3 節の否定側のテスト。
- リスク：承認の二重の応答・状態の食い違い。状態機械の性質ベーステスト。
- 上限の試験：10 節の全て。
- 本番での検証：`rollup_mismatch_total` が 0、`flow_runtime_errors_total` の急増、予定の経路の遅れ。

**runbooks**

- `flow-runtime-errors-spike`：あるフローの実行時のエラーが急に増えた。版を特定し、組織の管理者に知らせる。
- `flow-scheduled-actions-lag`：予定の経路の遅れが 1 時間を超えた。
- `rollup-mismatch`：積み上げ集計の差が見つかった。保存の経路の不具合を調べる。
- `rollup-stale-backlog`：`rollup_stale` が 1 時間を超えてたまる。
- `approval-instance-error`：承認者を決められない・読めないインスタンスが多い。
- `scheduled-flow-quota-exceeded`：スケジュールのフローの 24 時間の上限を超えた組織への案内。
- SLI の追加の依頼（Ops へ）：保存の後のフローを含む保存の p95、予定の経路の遅れ、`rollup_mismatch_total`、`rollup_parent_lock_wait_seconds`、承認の応答の p95、画面のフローの 1 送信の p95。

**data-model**

| テーブル | 主な列 | 備考 |
| --- | --- | --- |
| `md_flows`、`md_flow_versions` | `org_id`、`flow_id`、`api_name`、`type`、`object_id`、`trigger_order`、`active_version_id`、`version_id`、`definition`、`status`、`run_as` | メタデータ |
| `flow_interviews` | `org_id`、`interview_id`、`user_id`、`version_id`、`state`（暗号化）、`current_element`、`expires_at` | 画面のフロー |
| `flow_scheduled_actions` | `org_id`、`id`、`version_id`、`path`、`record_id`、`due_at`、`state`（`pending`・`done`・`skipped`・`cancelled`） | 分割、RLS。`(org_id, state, due_at)` の索引 |
| `flow_async_runs` | `org_id`、`version_id`、`record_id`、`origin_tx_id`、`ran_at` | 一意。7 日で消す |
| `flow_schedule_runs` | `org_id`、`flow_id`、`started_at`、`last_record_id`、`count`、`state` | |
| `md_validation_rules` | `org_id`、`rule_id`、`object_id`、`condition`、`message`、`error_field_id`、`active` | メタデータ |
| `md_rollups` | `org_id`、`field_id`、`child_relationship_field_id`、`aggregate`、`child_field_id`、`filter`、`state` | メタデータ（`md_fields.type_params` から分けて引く） |
| `rollup_stale` | `org_id`、`field_id`、`parent_id`、`since` | |
| `md_approval_processes`、`md_approval_steps` | `org_id`、`process_id`、`version`、`object_id`、`order`、`entry_condition`、`record_editability`、`step_no`、`condition`、`approvers`、`when_multiple`、`reject_behavior` | メタデータ |
| `approval_instances` | `org_id`、`instance_id`、`process_version`、`record_id`、`state`、`current_step`、`submitted_by`、`submitted_at` | `(org_id, record_id) WHERE state = 'pending'` に一意 |
| `approval_work_items` | `org_id`、`work_item_id`、`instance_id`、`step_no`、`approver_group_id`、`state`、`acted_by`、`acted_at`、`comment`、`row_version` | |
| `approval_locks` | `org_id`、`record_id`、`instance_id`、`editability` | 分割、RLS |

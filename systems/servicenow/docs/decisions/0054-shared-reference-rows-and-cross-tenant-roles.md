---
status: accepted
date: 2026-09-28
---

# ADR-0054: `tenant_id` が NULL の行は、全テナントに同じで機密でない参照のデータだけに許し、RLS は読み取りだけで通す。テナントをまたいで読む DB のロールは、識別子だけを返す関数に限る

詳細は [security.md](../architecture/security.md) の 10 節。

## Context

[ADR-0002](0002-tenancy-and-isolation.md) は、全テナントテーブルに `tenant_id` と `FORCE ROW LEVEL SECURITY` を持たせ、RLS を外すのはテナントをまたぐ管理の処理だけにし、許可の一覧で例外を管理すると決めた。

一方で、各領域の設計は `tenant_id` が NULL の行を置いている。

- 組み込みの辞書（`dict_table`・`dict_field`。[data-dictionary-and-tables.md](../architecture/data-dictionary-and-tables.md) の 3.2 節は「組み込みは NULL」と書く）
- 組み込みのロール（`role` の「組み込みは NULL」。[access-control.md](../architecture/access-control.md) の 3.3 節）
- 組み込みの ACL の規則
- 国民の祝日（「`tenant_id` が NULL の共通のデータ（RLS の例外として許可の一覧に載せる）」。[sla-and-calendars.md](../architecture/sla-and-calendars.md) の 14 節）

また、タイマーの取得（[workflow-engine.md](../architecture/workflow-engine.md) の 5.3・8.3 節）と outbox の中継は、テナントをまたいで行を読む。

## Options

### NULL の行

1. **NULL の行を、決めた表の参照のデータだけに許す。RLS は読み取りだけ NULL を通し、書き込みは許さない。NULL の行は専用のロールだけが書く**
2. 組み込みのデータをテナントごとに行として写す（テナントの作成の時）
3. 組み込みのデータを DB に置かず、コードの中だけに持つ

### テナントをまたぐ読み取り

- a. **`SECURITY DEFINER` の関数で、識別子（`id`、`tenant_id`）だけを返す。本文はテナントのコンテキストで読む**
- b. `BYPASSRLS` のロールで直接読む

## Decision

1 と a を採用する。

- NULL の行を持つ表：`dict_table`、`dict_field`、`dict_choice_set`、`dict_choice`、`role`、`acl_rule`、`holiday_set`、`holiday_set_version`、`holiday`。候補（関係の型、識別の規則、番号の定義、優先度の表、配置、通知のテンプレート、組み込みのレポート）は、DB の行にするなら統合でこの一覧に足す。
- 許す理由：全テナントで同じで、コードの版と一緒に（祝日は運用者 2 人の承認で）出し、機密でない。テナントの行（`c_` のフィールド、上書き、ロールの付与、カレンダーの版）の参照の先として DB に要る。
- RLS：この表だけ `SELECT` の `USING` に `OR tenant_id IS NULL`。書き込みのポリシーは `tenant_id = current` だけで、アプリのロールは NULL の行を書けない。NULL の行は `catalog_loader` のロール（NULL の行だけを読み書きできる）が書く。
- NULL の行はテナントの行を参照しない。テナントは NULL の行を書き換えず、自分の行（上書き、無効の印）を足す。
- テナントをまたぐロール：`engine_scheduler`（`claim_due_timers` の関数で `(timer_id, tenant_id)` だけ）、`relay`（outbox だけ）、`indexer_scan`（`(tenant_id, id, version)` だけ）、`platform`（`BYPASSRLS`、期限付き、プラットフォームの監査）、`maintenance`（パーティションの操作だけ）、`catalog_loader`。
- マイグレーションの CI の許可の一覧は、この ADR の表の一覧と一致させる。

> 2026-09-28 の注記（統合で候補を決めた）：判断の規則は「テナントの行が外部キーで参照する組み込みのデータ、またはテナントの行と同じ一意の空間で照合する組み込みのデータだけを NULL の行にする」。これで、許可の一覧は次のとおりになる。
> - **NULL の行にする**：`dict_table`、`dict_field`、`dict_choice_set`、`dict_choice`、`role`、`acl_rule`、`holiday_set`、`holiday_set_version`、`holiday`（ここまで元の一覧）、`number_def`（組み込みの辞書の `number_def_id` と、テナントの `number_counter` が参照する）、`ci_relation_type`（テナントの `ci_relation` が参照する）、`ci_attribute`・`ci_identification_rule`（テナントの `ci_precedence`・`ci_identifier` が参照する）、`flow_def`・`flow_version`（組み込みのフロー。テナントの `flow_run` が版を参照する。版は変えず、コードの新しい版は新しい `flow_version` の行にする）。
> - **コードの版だけに持つ（DB に行を作らない）**：`priority_matrix` の既定、`form_layout`・`list_layout`・`view_rule`・`ui_rule` の既定、状態のモデル、組み込みのレコードのルール、`notification_rule`・`notification_template` の既定、`report_def`・`dashboard` の組み込み、組み込みの文言の辞書、`ci_precedence`・`ci_source_rule` の既定。テナントは自分の行で上書き・無効・複製をし、組み込みのものを `stable_key` で指す（外部キーにしない）。
> - **テナントの作成の時にテナントの行として作る（既定の設定）**：既定のカレンダー、組み込みの SLA の定義（インシデントの応答・解決と OLA）、既定のポータルとテーマ、既知のエラーのナレッジベース、組み込みの取り込み元（`manual`・`system_group`）、組み込みの連携の主体（`email_intake`）。テナントが自由に変える設定なので、共通の行にしない。コードの新しい版は、既存のテナントの行を書き換えない。
>
> 一覧の正本は [data-model.md](../architecture/data-model.md) の 3 節と [security.md](../architecture/security.md) の 10.2 節で、マイグレーションの CI の許可の一覧もこれと一致させる。タイマーの取得の SQL は、workflow-engine の 5.3・8.3 節で `claim_due_timers` の関数に置き換えた。

2 を採らない理由：組み込みの定義の変更のたびに、全テナントの行を書き換えるマイグレーションが要る（[ADR-0006](0006-data-dictionary-and-field-types.md) が 2 を採らなかった理由と同じ）。祝日の版の公開も、全テナントへの写しになる。

3 を採らない理由：テナントの行（上書き、ロールの付与、カレンダーの版の祝日の集合）が、組み込みのものを外部キーで参照できない。参照の整合をアプリだけで守ることになる。

b を採らない理由：タイマーの取得のたびに、全テナントの表の本文を読める接続を持つことになる。取得の SQL の誤りが、テナントをまたいだ読み取りになる。識別子だけを返す関数なら、本文はテナントのコンテキスト（RLS の下）でしか読めない。

## Consequences

- 良くなること：
  - NULL の行の置き場所と理由が 1 か所にまとまり、CI で守れる。
  - テナントをまたぐ処理が、本文を読まずに済む。
- 引き受けるコスト：
  - タイマーの取得が、関数の呼び出しとテナントのコンテキストの設定の 2 段になる。workflow-engine の 5.3 節の取得の SQL を、この関数に置き換える（統合での注記）。
  - NULL の行の表では、読み取りの述語に `OR tenant_id IS NULL` が入り、索引の設計に注意が要る。

## Confirmation

- マイグレーションの CI：`tenant_id` が NULL を許す列を持つ表が、この一覧と一致する。
- 拒否の側のテスト：アプリのロールで NULL の行を `INSERT`・`UPDATE`・`DELETE` できない（SEC-090）。`engine_scheduler` でテナントの表の本文を読めない（SEC-093）。
- 性質ベーステスト：任意の 2 テナントで、一方のコンテキストで他方の行が読めない（NULL の行は両方から読める）。

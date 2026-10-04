---
status: accepted
date: 2026-09-28
---

# ADR-0006: facet ごとの 3 つのテーブルを宣言から生成し、同じ日の差分の順序を事象の種類で決める

詳細は [object-model-and-effective-dating.md](../architecture/object-model-and-effective-dating.md) の 3〜5 節。

## Context

[ADR-0002](0002-effective-dated-data-model.md) は、人事のデータを facet ごとの差分・バージョン・現在の 3 つのテーブルで持ち、差分を有効日の順に畳み込むと決めた。細部は次のとおり残っている。

- テーブルと制約を、facet ごとに手で書くか。facet は 10 以上あり、書き漏れ（`WITHOUT OVERLAPS` の付け忘れ、RLS の付け忘れ）が起きやすい。
- PostgreSQL 18 の時間の制約をどう使うか。`WITHOUT OVERLAPS` の列は範囲型で、他の列を GiST に載せるには `btree_gist` が要る。`PERIOD` の外部キーは参照の動作が `NO ACTION` だけ（[CREATE TABLE](https://www.postgresql.org/docs/18/sql-createtable.html)、2026-09-28 に確認）。
- 同じ主体・facet・有効日に複数の差分があるときの順序。本家は、同じ有効の時点の変更は入力の時点で最後のものを取る（[Change Detection](https://doc.workday.com/workday-education/en-us/course-manuals/creating-integrations-using-global-payroll-connect/change-detection.html)、2026-09-28 に確認）。入力の順に依存すると、並行する案件の完了の順で結果が変わる。ADR-0002 の Confirmation は「同じ `seq` なら入れた順序によらず同じ結果」を求めている。
- 現在のテーブルを誰が書くか。

## Options

テーブルの作り方：

1. **`FacetSpec` の宣言から、3 つのテーブル・制約・RLS・トリガーを生成する**
2. facet ごとに手でマイグレーションを書き、CI で形を検査する

同じ日の順序：

- a. **事象の種類ごとの優先度（`seq`）で決め、同じ `seq` で同じ項目に触れる差分は拒む**
- b. 記録の時刻（入力の順）で決める
- c. 同じ日に同じ facet の差分を 1 つに限る

現在のテーブルの書き込み：

- i. **DB の関数（または専用のロール）だけが書く。アプリのロールは直接書けない**
- ii. `packages/temporal` のコードが普通の SQL で書く。lint で他からの書き込みを禁じる

## Decision

1、a、i を採用する。

- `FacetSpec`（項目の Zod のスキーマ、隙間の方針、coverage の親、`seq` の表、依存の規則）から、`<facet>_changes`・`<facet>_versions`・`<facet>` を生成する。現在のテーブルは `PRIMARY KEY (tenant_id, subject_id, valid WITHOUT OVERLAPS)` と、coverage と参照の `PERIOD` の外部キーを持つ。`btree_gist` を入れる。
- バージョンは `known tstzrange`（`recorded_at`〜`superseded_at` の生成列）を持ち、`(tenant_id, subject_id, valid, known)` の GiST の索引で時点の問い合わせを引く。
- 差分は `(effective_on, seq)` の順に畳み込む。`seq` は事象の種類の優先度（入社 100、職務の変更 300、給与の変更 400、休職 500、個人の情報 600、退職 900 など）。同じ `(effective_on, seq)` で触れる項目が重なる差分は `SAME_DAY_CONFLICT` で拒む（DT-TEMP-001）。訂正は元の差分と同じ `seq` にする。
- 隙間の方針（`contiguous`・`gapped`）と終わりの差分の扱いは DT-TEMP-002 で決める。
- 現在のテーブルの行の差し替えと、`superseded_*`・`rescinded_*` の埋め込みは、書き込みの専用の経路（関数か専用のロール。方式は E1 の PoC で決める）だけが行う。アプリのロールは `INSERT`・`SELECT` と、その経路の実行だけを持つ。
- 畳み込みは主体の行ロックで直列にし、書き込みのトランザクションは `transaction_timeout = 5s` にする。
- 2 を採らない理由：facet ごとの手書きは、制約・RLS・トリガーの書き漏れを CI の検査で後から見つけることになる。生成なら漏れが構造上起きない。
- b を採らない理由：並行する案件の完了の順が結果を決め、性質（順序によらない結果）を満たさない。同じ日の入社と職務の変更のように、業務の上で順序が決まっているものまで入力の順に任せることになる。
- c を採らない理由：入社の日に職務・給与・住所をまとめて入れるなど、同じ日の複数の差分は普通にある。
- ii を採らない理由：lint は SQL の文字列や、別の言語の道具（移行のスクリプト）からの書き込みを見逃す。DB の権限で止める。

## Consequences

- 良くなること：
  - 期間の重なりと参照の整合を、全 facet で同じく DB が守る。
  - 同じ日の差分の結果が、並行の順序に依存しない。
- 引き受けるコスト：
  - 生成器を作り、保守する。生成器の変更は全 facet のマイグレーションに波及するので、`security:sensitive` と同じ扱いのレビューにする。
  - `SAME_DAY_CONFLICT` を業務の担当が受け取る。画面で「訂正として出し直す」への導きが要る。
  - `PERIOD` の外部キーが `NO ACTION` だけなので、参照先を閉じる操作（組織の廃止）の前に、参照する側を移す順序を業務プロセスで守る。

## Confirmation

- CI：有効日付の facet が、3 つのテーブル・時間の制約・RLS・追記のみのトリガーを持たないマイグレーションを失敗させる。
- 決定表のテスト：DT-TEMP-001・002。
- 性質ベーステスト：PROP-TEMP-001（重ならない）、PROP-TEMP-002（現在 = 畳み込み）、PROP-TEMP-004（同じ `seq` の順序によらない）、PROP-TEMP-006（coverage）。
- DB の権限の検査：アプリのロールで現在のテーブルへの `INSERT`・`DELETE` と、バージョン・差分への `UPDATE` が失敗する。

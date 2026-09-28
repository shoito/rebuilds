---
status: accepted
date: 2026-09-28
---

# ADR-0018: 問い合わせの言語は SQL に寄せた独自の言語にし、親へのドットと 1 段の子の副問い合わせでたどり、3 値の論理と正規化した文字列の比較にする

詳細は [query-language-and-api.md](../architecture/query-language-and-api.md) の 3 節。

## Context

[ADR-0001](0001-platform-and-stack.md) は、問い合わせの言語を独自のものにし、本家の SOQL との互換を持たないとした。[ADR-0003](0003-metadata-driven-runtime.md) は、問い合わせの文字列をパーサーで AST にし、束縛・型の検査・権限・共有の条件の付加・計画を経て SQL にするとし、構文は SQL と表計算の関数に寄せるとした。決めていなかったこと：

- 関係のたどり方と、その上限。
- 空の値の論理（2 値か 3 値か）。
- 文字列の比べ方。日本語では全角・半角の英数字が混ざる。
- 集計の範囲と、トランザクションの上限との関係。

本家（2026-09-28 に確認）：文は 100,000 文字、`WHERE` の文字列は 4,000 文字、子から親へ 55 の関係・1 本 5 段、親から子へ 20 の関係（API の版 58.0 以降は 5 段）、`OFFSET` は 2,000、`ORDER BY` がなければ順は保証しない（[SOQL and SOSL Reference](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_soql_sosl.pdf)、[Developer Limits and Allocations Quick Reference](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_app_limits_cheatsheet.pdf)）。

## Options

1. **SQL の `SELECT` に寄せた独自の言語。親はドット、子は副問い合わせ（1 段）、半結合は `IN (SELECT ...)`。3 値の論理。文字列は NFKC と小文字で正規化して比べる**
2. JSON の問い合わせの形（フィルターの木）だけを持ち、文字列の言語を持たない
3. PostgreSQL の SQL の部分集合をそのまま受け付ける

## Decision

1 を採用する。

- 文法は `SELECT … FROM … [SCOPE] [WHERE] [GROUP BY [HAVING]] [ORDER BY] [LIMIT] [OFFSET]`。複数選択は `HAS_ANY`・`HAS_ALL`・`HAS_NONE`、日付は `THIS_FISCAL_QUARTER()`・`LAST_DAYS(30)` のような関数で書く。本家の独自の構文（`__c`、`__r`、`LAST_N_DAYS:n`）は使わない。名前は仮称 RQL とし、開発リポジトリの作成時に決める。
- 親へは 5 段・別々の関係 35 まで、子の副問い合わせは 10 まで・1 段・親 1 件 200 件まで、半結合は 2 まで。
- 論理は SQL と同じ 3 値にする。`!=` は空の行を含まない。
- 文字列の比較は、保存のピボットと同じ正規化（NFKC、小文字）で行う。
- `ORDER BY` がなければ `id` の昇順にし、結果を決定的にする。
- 集計の結果は 2,000 グループまでで、集計した行をトランザクションの取得の行に数える。
  > 2026-09-28 の注記：「集計した行を取得の行に数える」は、利用者とフローが書いた問い合わせ（画面・REST・フローの `get_records`）に限る。例外は [ADR-0041](0041-limits-registry-and-counting-rules.md) にある：保存の手順 8 の積み上げ集計の集計し直しは取得の行に数えず、子 5 万件（`rollup.sync_recalc_children`）で抑える。レポート（`report.*`）と一括の問い合わせ（`bulk.query`）はトランザクションの上限の外の予算で抑える。
- `SCOPE` は共有の条件に加えて絞るだけで、広げない。
- 2 は、連携の開発者が手で書きにくく、リストビューの条件の保存の形としても読みにくい。AST の JSON の形は内部に持ち、画面とフローはそれを直接作ってよい。3 は、名前の解決・権限・共有の条件の付加を SQL の任意の構文に対して行うことになり、漏れの危険が高い（ADR-0003 の b と同じ理由）。

## Consequences

- 良くなること：
  - SQL を知る人が読める。構文が小さく、評価器と SQL の生成を 1 対 1 で保てる。
  - 全角・半角・大文字・小文字の違いで検索を外さない。
  - 結果の順が決定的になり、テストとページ送りが安定する。
- 引き受けるコスト：
  - 本家の SOQL から移る組織は、問い合わせを書き直す。`!=` の空の扱いが違いうる（本家の資料は `!=` と空の値の関係を書いていない。未検証。E3 の `query-semantics-sql` で試用の組織で確かめ、移行の文書に書く）。
  - 子を 1 段しかたどれない。孫が要る画面は 2 回の問い合わせになる。
  - 数式の言語（2 値）と問い合わせの言語（3 値）で、空の扱いが違う。

## Confirmation

- 性質ベーステスト：任意の問い合わせで、構文の出力と読み直しが同じ AST になる。
- 性質ベーステスト：任意のスキーマ・レコード・問い合わせで、SQL の結果が参照の評価器の結果と一致する（3 値、空、正規化、日付、会計年度）。
- 上限の試験：文字数、リテラル、段、関係、副問い合わせ、半結合、`IN`、`GROUP BY`、集計のグループ、`OFFSET` で、ちょうどで通り、1 つ超えたら拒否する。

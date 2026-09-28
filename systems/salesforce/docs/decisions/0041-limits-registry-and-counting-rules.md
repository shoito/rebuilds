---
status: accepted
date: 2026-09-28
---

# ADR-0041: 上限の正本を 1 つの登録簿にし、フローは足並みの 1 歩で、積み上げ集計の集計し直しは取得の行の外で数え、レポート・一括の問い合わせ・検索は別の予算で抑える

詳細は [governor-limits.md](../architecture/governor-limits.md) の 3〜6 節。

## Context

[ADR-0005](0005-tenancy-and-governor-limits.md) は、1 トランザクションの上限の初期値を決め、値と数え方の一覧は governor-limits の領域で決めるとした。その後、各領域の文書が自分の上限の表を持ち、次の 3 つの依頼を残した。

- [automation-flows.md](../architecture/automation-flows.md)（[ADR-0025](0025-flow-definition-and-bulk-engine.md)）：フローの要素の実行を、実行（インタビュー）ごとではなく、足並みの 1 歩で数える。
- 同じ文書（[ADR-0027](0027-roll-up-summaries-incremental-with-reconciliation.md)）：積み上げ集計の集計し直しを、取得の行（5 万）に数えない。[ADR-0018](0018-record-query-language.md) は、集計した行を取得の行に数えるとしており、そのままでは子が 5 万件を超える親の子を 1 件直すだけで上限を超える。
- [reports-and-dashboards.md](../architecture/reports-and-dashboards.md)（[ADR-0029](0029-report-execution-on-reader-per-viewer.md)）：レポートをトランザクションの上限ではなく、別の予算で抑える。

加えて、[query-language-and-api.md](../architecture/query-language-and-api.md) の 4.5 節は、一括の問い合わせを「非同期の上限の中で」実行するとした。非同期でも取得の行は 5 万なので、数百万行の取り出しができない。

上限の値が領域ごとの表に散ると、同じ上限に 2 つの値が生まれ、試験と実装がずれる。

本家は、フローが Apex の上限に従うとする（ヘルプの要約。未検証）。要素の数え方と、積み上げ集計の読みの数え方は確かめられなかった（未検証）。本家の上限の一覧は 1 つの資料（[Developer Limits and Allocations Quick Reference](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_app_limits_cheatsheet.pdf)、2026-09-28 に確認）にまとまっている。

## Options

正本：

1. **1 つの登録簿（コード）と governor-limits.md の一覧を正本にし、各領域の表は写しにする。CI で一致を検査する**
2. 各領域の文書を正本にし、governor-limits.md は索引だけにする

フローの要素：

- a. **足並みの 1 歩を 1 と数える**
- b. 実行ごとに数える

積み上げ集計の集計し直し：

- x. **取得の行に数えず、同期で集計し直す子の数（5 万）を別の上限にする**
- y. 取得の行に数える

読みだけの重い処理（レポート、一括の問い合わせ、検索）：

- p. **トランザクションの上限の外に置き、処理ごとの予算（DB の時間、読む行、候補の数）で抑える**
- q. 非同期のトランザクションの上限で抑える

## Decision

1、a、x、p を採用する。

- 上限は `id`・`scope`（`transaction`・`request`・`metadata`・`budget`・`allocation`・`concurrency`）・値・数え方・除くもの・エラー・持ち主の領域・試験の ID を持つ登録簿に置く。計測器・API・Setup の画面・文書の表は登録簿から作る。
- フローの要素の実行は、足並みの 1 歩を 1 と数える。`loop` は最も多い実行の繰り返しの数。
- 手順 8 の積み上げ集計の集計し直しは、問い合わせの数に 1 と数え、取得の行に数えない。子 5 万件（`rollup.sync_recalc_children`）を超える親は `rollup_stale` にする。利用者とフローの集計の問い合わせは、これまでどおり集計した行を数える。
- レポート（`report.sync`・`report.async`）、一括の問い合わせ（`bulk.query`）、検索（`search.request`）、レコードのページ（`ui.record_page`）は、トランザクションの上限の外の予算で抑える。DB の時間は組織ごとに数える。
- ADR-0005 の表に、`tx.outbound_calls`（100）と `tx.emails`（10）を足す。フローの送信の要素が、1 回の保存で無制限に送信を依頼しないようにする。
- 数えないもの（メタデータの読み、共有の評価、ロックの表、outbox、履歴、監査）を登録簿の `excludes` に明記する。
- 2 は、同じ上限の値が文書ごとにずれても気づけない。
- b は、同じフローが 1 件では通り 200 件では落ち、一括の取り込みが動かない。
- y は、子の多い親の子を 1 件直すだけで上限を超え、利用者に避ける方法がない。
- q は、一括の問い合わせとレポートが、5 万行と 10 分で止まる。

## Consequences

- 良くなること：
  - 上限の値と数え方の正本が 1 つになり、試験と実装と文書がずれない。
  - フローの上限の数が塊の大きさに依らず、上限の試験が再現できる。
  - 子の多い親の子の保存が、上限で止まらない。
  - 一括の問い合わせとレポートが、読みの量に見合った予算で動く。
- 引き受けるコスト：
  - 数え方が本家と違いうる（未検証）。移行の文書に書く。
  - 積み上げ集計の例外で、1 回の保存が最大 5 万行を読む。E12 で p99 を測る。
  - 予算は種類ごとに別なので、組織ごとの DB の時間でまとめて見る必要がある（[ADR-0042](0042-org-allocations-fair-queuing-and-limit-info.md)）。

## Confirmation

- CI：governor-limits.md の表と登録簿が一致する。試験の ID のない上限を落とす。
- 上限の試験：全ての上限で、ちょうどで通り、1 つ超えたら巻き戻る・拒否する。
- 上限の試験：同じフローの要素の使用量が、1 件と 200 件で同じ。
- 上限の試験：子 5 万件の親の子の保存が `tx.query_rows` を使わずに通り、5 万 1 件で `rollup_stale` になる。
- 結合テスト：一括の問い合わせで 100 万行を取り出せる。

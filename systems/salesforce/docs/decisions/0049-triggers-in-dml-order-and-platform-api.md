---
status: accepted
date: 2026-09-28
---

# ADR-0049: トリガーは DML の手順 3b・7a・13 にフローと並べて置き、塊ごとに 1 回呼ぶ。ホストの API はデータ層の AST だけにし、既定は実行する利用者の権限で動かす

詳細は [extensibility.md](../architecture/extensibility.md) の 5 節と 6 節。

## Context

[ADR-0008](0008-dml-order-of-execution.md) は、DML を 200 件の塊で 13 の手順に沿って処理するとした。[ADR-0026](0026-record-triggered-flow-order-and-recursion.md) は、レコードの変更で動くフローを手順 3a（保存の前）・7b（保存の後）・13（確定の後の非同期）に置き、同じフローは同じレコードに 1 トランザクションで 1 回だけ動かすとした。

利用者のコード（トリガー）を足す時に決めること：

- 同じ手順のフローとトリガーの順。
- 呼ぶ単位（1 件ずつか、塊か）。
- 再帰の規則。
- ホストの API として何を見せるか。権限・共有・FLS をどう効かせるか。

本家（[Apex Developer Guide](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_apex_developer_guide.pdf)、Winter '27 版の「Triggers and Order of Execution」、2026-09-28 に確認。ADR-0008 に写した内容）：保存の前のフロー → before トリガー → 検証 → 保存（未確定）→ after トリガー → …… → 保存の後のフロー。API の要求は 200 件の塊でトリガーを動かす。API のバージョン 67.0 以降の Apex は、既定で利用者のモード（オブジェクトの権限と FLS を守る）と `with sharing` で動く。トリガー自体は共有を外した文脈で動くが、その中の問い合わせと DML は、明示しなければ利用者のモードで動く。66.0 以前は、宣言のないクラスの共有の扱いが呼び出しの経路で変わる（[Apex Developer Guide](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_apex_developer_guide.pdf)、Winter '27 版（API 68.0）の「Apex Security and Sharing」と「Use the with sharing, without sharing, and inherited sharing Keywords」、2026-09-28 に確認）。

> 2026-09-28 の注記：起票の時は「Apex は既定でシステムの文脈で動く」と書いていた。これは API のバージョン 66.0 以前の振る舞いで、今の本家は既定を利用者の権限に改めた。本システムの既定（実行する利用者の権限）は、今の本家と同じ向きになる。決定は変えない。なお、同じ Winter '27 版の [SOQL and SOSL Reference](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_soql_sosl.pdf) は、まだ「Apex は既定でシステムのモードで動く」と書いており、本家の資料どうしが食い違う。

## Options

順と単位：

1. **手順 3 は「保存の前のフロー → before トリガー」、手順 7 は「after トリガー → 保存の後のフロー」。塊（200 件まで）ごとに 1 回呼び、同じトリガーは同じレコードに 1 トランザクションで 1 回**
2. 1 件ずつ呼ぶ
3. トリガーとフローを 1 つの `trigger.order` の番号で混ぜて並べる

権限：

- a. **既定は実行する利用者の権限（オブジェクトの権限・FLS・共有）。`system` はパッケージの宣言と管理者の承認で選べる**
- b. 既定を `system` にする（本家の既定に近い）

## Decision

1 と a を採用する。

- 置き場所：手順 3b（`before_save`。起動したレコードの項目だけを変えられる。DML・送信の API は使えない）、手順 7a（`after_save`）、手順 13（`after_commit`。非同期。[ADR-0026](0026-record-triggered-flow-order-and-recursion.md) の非同期の経路と同じ `flow_async_runs` の仕組みで二重を防ぐ）。削除の前後も同じ位置に置く。
- 同じ手順の中の複数のトリガーは `order`（1〜2,000）と `api_name` で並べる。フローとは混ぜない。
- 1 回の呼び出しで、塊の `new`・`old` のレコード（200 件まで）を渡す。
- 再帰の規則はフローと同じ：同じトリガーは同じレコードに 1 トランザクションで 1 回。入れ子の深さは `tx.nesting`（16）に数える。
- ホストの API は、問い合わせ（問い合わせの言語の文字列とバインド変数）、DML（作成・更新・削除・upsert）、`addError`、組織が定義するイベントの発行、登録した宛先への外向きの呼び出しの依頼（outbox。応答を待たない）、ログだけにする。全てデータ層の AST を通り、トランザクションの上限に数える。
- 実行の文脈は `user`（既定）と `system`。`user` はオブジェクトの権限・FLS・共有を全てかける。`system` はオブジェクトの権限と FLS を外すが、**共有は外さない**（`system_with_sharing`）。共有も外す `system_without_sharing` は MVP の後の課題とし、この ADR では持たない。
- `system` の選択は、トリガーの定義の宣言と、`customize_application` を持つ管理者の有効化の時の承認を要し、監査に残す。
- エラーの文言に、実行する利用者が読めない項目の値を差し込ませない（[automation-flows.md](../architecture/automation-flows.md) の 12 節と同じ規則）。`addError` の文言はトリガーの書き手が決めるので、有効化の時に警告する。
- 2 は、塊の件数だけ砂場の呼び出しと問い合わせが増え、一括の取り込みで上限を超える。3 は、宣言的な設定と利用者のコードが 1 つの番号の空間を奪い合い、パッケージが入ると順が組織の設定で変わる。
- b は、書き手が意識しないうちに、共有と FLS を越えた読み書きをする。本家から移る組織には慣れの差になるが、漏えいの経路を既定で作らないことを優先する。

## Consequences

- 良くなること：
  - トリガーとフローが同じ再帰の規則で止まる。
  - 塊で呼ぶので、一括の取り込みでも砂場の呼び出しの回数が小さい。
  - ホストの API が全てデータ層を通るので、権限・共有・上限・監査の抜け道がない。
- 引き受けるコスト：
  - 本家の既定（システムの文脈）と違う。移行の文書に書く。
  - 共有を外す文脈がないので、「全てのレコードを見て集計する」処理は、`view_all` の権限を持つ連携の利用者の文脈で動かす運用になる。
  - 手順 7 の中では共有の行がまだない（ADR-0008 の Consequences と同じ）。

## Confirmation

- 決定表：`DT-EXT-001`（手順 × 種類（フロー・トリガー）× 事象 → 順と呼ぶか）を表駆動テストにする。
- 性質ベーステスト：任意の DML の列で、各（トリガー、レコード）が 1 トランザクションに 1 回しか動かない。塊で呼んだ結果と 1 件ずつ呼んだ結果が同じ（トリガーが件数に依らない書き方の時）。
- 否定側のテスト：`user` の文脈で、読めないレコード・項目がホストの API の結果に出ない。`system_with_sharing` で共有の外のレコードが出ない。
- 上限の試験：トリガーの問い合わせ・DML・燃料が、トランザクションの上限に数えられ、超えたら巻き戻る。

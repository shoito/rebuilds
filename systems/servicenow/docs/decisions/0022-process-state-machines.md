---
status: accepted
date: 2026-09-28
---

# ADR-0022: インシデント・問題・変更の状態は、コードの版に含む宣言の遷移の表で持つ。テナントは状態と辺を足せず、条件と保留の理由だけを足せる。既知のエラーは状態ではなく印にする

詳細は [itsm-processes.md](../architecture/itsm-processes.md) の 3・4・7 節。

## Context

[intent.md](../intent.md) は、インシデント・問題・変更が既定の設定のまま動き、状態の遷移がちょうど 1 回、正しく行われることを求める。SLA の条件、承認の方針、メールの処理、レポートは、どれも状態の値を前提にする。

本家は、インシデント（新規・対応中・保留・解決・完了・取り消し）、問題（新規・評価・根本原因の分析・修正中・解決・完了）、変更（種類ごとの状態の進み）を持つ（[State progression for change models](https://www.servicenow.com/docs/r/it-service-management/change-management/normal-standard-emergency-states.html)、2026-09-28 に確認。[Incident Management state model](https://www.servicenow.com/docs/r/it-service-management/incident-management/c_IncidentManagementStateModel.html)、2026-09-28 に確認。問題の「根本原因の分析」「修正中」「解決」「完了」は [Investigate root cause of a problem](https://www.servicenow.com/docs/r/it-service-management/problem-management/investigate-root-cause.html)、「新規」「評価」はコミュニティの記事で確認）。本家は、顧客がスクリプトで状態を足したり遷移を変えたりできる。今の問題の状態のモデルは既知のエラーを状態に持たず、既知のエラーの記事を参照するフィールドを持つ（同上）。London 以前の旧い流れは「既知のエラー」を状態に持っていた（[Problem Management process](https://www.servicenow.com/docs/r/it-service-management/problem-management/c_ProblemManagementProcess.html)、2026-09-28 に確認）。

本システムは、テナントに任意のコードを書かせない（[ADR-0001](0001-platform-and-stack.md)）。状態の遷移は保存の流れ（[data-dictionary-and-tables.md](../architecture/data-dictionary-and-tables.md) の 5 節）の中で、版の条件付きで行う（[ADR-0004](0004-workflow-and-sla-engine.md)）。

## Options

### 遷移の定義

1. **コードの版に含む宣言の遷移の表。保存の流れで照合する**
2. レコードのルール（[ADR-0017](0017-no-code-record-rules.md)）で、テナントが遷移を検査する
3. フローで状態を進め、利用者の直接の変更を禁止する

### テナントの拡張

- a. **状態と辺は足せない。遷移の条件（必須のフィールド、式）と保留の理由の選択肢だけを足せる**
- b. 状態と辺も足せる

### 既知のエラー

- x. **問題の印（`known_error`）にする**
- y. 問題の状態の 1 つにする

## Decision

1、a、x を採用する。

- モデルは `states`（値とカテゴリ：open・hold・resolved・closed・cancelled）と `transitions`（前、後、操作の名前、主体の種類、ロール、`guard`、`requires`、組み込みの効果）を持つ。
- 保存の流れの 3 段の後、4 段の前で、`state` の変更を表と照合する。表にない遷移は 422 `invalid_transition`、ロールの不足は 403、必須のフィールドの不足は 422 `transition_requires`、`guard` の偽は 422 `transition_guard`。
- 効果（解決の時刻、自動の完了のタイマー、承認の依頼、衝突の計算し直し、子への伝播）は、同じトランザクションで行う。子への伝播は `bulk_job` で非同期に行う。
- テナントのクラスは汎用のモデル `generic_task` を使う。
- 既知のエラーは `known_error = true` の印で、`workaround` を条件にする。状態とは独立に立てられる。

2 を採らない理由：ルールは保存の前の値の検査はできるが、状態の集合と遷移の網羅（どの組が許されるか）を 1 か所で示せない。決定表と否定の表のテストが書けない。

3 を採らない理由：「解決」「保留」は担当者の日常の操作で、フローの実行を待たずに即時に反映したい。フローの実行の遅れ（タイマーの取得）で、画面の操作が遅れる。

b を採らない理由：SLA の組み込みの定義、承認の方針、メールの処理（再オープン）、レポートが、組み込みの状態の値を前提にしている。テナントごとに状態が違うと、これらの既定が壊れる。追加の区別は、保留の理由とテナントのフィールドで表せる。

y を採らない理由：回避策が分かった問題も、根本原因の調査や修正は続く。状態にすると「修正中かつ既知のエラー」を表せない。

## Consequences

- 良くなること：
  - 遷移の表が仕様の決定表そのものになり、否定の表のテストで網羅できる。
  - どの経路（画面、API、フロー、メール）からも同じ判定になる。
- 引き受けるコスト：
  - 本家で状態を足していた顧客は、保留の理由・テナントのフィールド・テナントのクラスに置き換える。移行の資料で示す。
  - 状態を足す要望が強ければ、別の ADR で「組み込みのカテゴリに属する追加の状態」を検討する。

## Confirmation

- 決定表 DT-INC-001、DT-PRB-001、DT-CHG-001 と、否定の表の表駆動テスト。
- 性質ベーステスト PROP-INC-001（表にない状態に入らない、終わりから出ない）。
- lint：状態の列への書き込みが、Record Service の遷移の照合を通らない経路（直接の SQL）を禁止する。

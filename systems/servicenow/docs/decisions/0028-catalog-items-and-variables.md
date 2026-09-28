---
status: accepted
date: 2026-09-28
---

# ADR-0028: カタログの品目は公開で不変の版になり、申請の時の版に固定する。変数は 12 種と配置の 2 種に限り、表示の条件は画面とサーバーで同じ評価器を使ってサーバーを正とする

詳細は [service-catalog-and-requests.md](../architecture/service-catalog-and-requests.md) の 3・4 節。

## Context

カタログの品目（PC の申請、アカウントの作成など）は、入力の項目（変数）と、入力に応じて項目を出し入れする条件を持つ。品目の管理者は、進行中の申請がある間も品目を直す。

本家の変数は、HTML・UI ページ・カスタム・マスクなどを含む多くの型を持つ（[Types of service catalog variables](https://www.servicenow.com/docs/bundle/xanadu-servicenow-platform/page/product/service-catalog-management/reference/r_VariableTypes.html)、2026-09-28 に確認）。表示の条件はカタログの UI の方針とクライアントのスクリプトで書く（コミュニティの記事で確認。公式の本文は未検証。本家の振る舞いの細部で、この決定の前提ではない）。

本システムは、テナントに任意のコードを書かせず（[ADR-0001](0001-platform-and-stack.md)）、テナントの HTML を描かない（[intent.md](../intent.md) の Non-goals）。フローは版を固定する（[ADR-0014](0014-flow-dsl-and-versioning.md)）。

## Options

### 品目の変更

1. **公開で不変の版を作り、申請の時の版に固定する**
2. 品目を 1 つの可変の定義として持ち、回答は変数の ID だけで持つ

### 型

- a. **辞書の型に対応する 12 種と、配置の 2 種**
- b. 本家に近い多くの型

### 表示の条件の評価

- x. **式の言語の同じ評価器を画面とサーバーで動かし、サーバーの評価を正にする。見えない変数の値は捨てる**
- y. 画面だけで評価し、サーバーは型だけを検証する

## Decision

1、a、x を採用する。

- `catalog_item_version` は公開で作り、変えない。実行のフローの版と変数のまとまりの中身も、公開の時に版へ固定・写す。
- 変数の型：`single_line`、`multi_line`、`number`、`yes_no`、`checkbox`、`date`、`datetime`、`select`、`reference`、`email`、`url`、`attachment`、配置の `label`・`container`。
- UI の規則（条件と、可視・必須・読み取り専用・値の設定）は式の言語で書く。評価は変数の値と依頼者の属性だけを読む。
- 申請の時にサーバーが UI の規則を適用し、DT-VAR-001 で回答を正規化する（見えない値を捨てる、読み取り専用の値を置き換える、見える必須を確かめる）。
- 回答は要求の品目の `answers` に、品目の版とともに持つ。`reportable` の変数だけを `answer_index` に写す。

2 を採らない理由：品目の選択肢や必須を直すと、進行中の要求の品目の回答の意味が変わる。実行のフローの分岐が、申請の時と違う定義で動く。

b を採らない理由：HTML・UI ページ・カスタムはテナントのコードと XSS に当たる。マスク（秘密の値）は、監査の履歴・通知・エクスポートのすべての出口で守る必要があり、MVP で扱わない。

y を採らない理由：画面を通さない API の申請で、隠れた変数に値を入れ、実行のフローの分岐や承認の条件を操作できる。

## Consequences

- 良くなること：
  - 進行中の要求の品目は、申請の時の定義とフローのまま進む。
  - 画面と API のどちらから申請しても、保存される回答が同じ規則で決まる。
- 引き受けるコスト：
  - 品目の版と変数のまとまりの写しで、定義の行が増える。
  - 本家の多くの型を使う品目は、移行で型を置き換える。

## Confirmation

- 決定表 DT-CAT-001、DT-VAR-001。
- 性質ベーステスト PROP-VAR-001（画面とサーバーの一致）、PROP-VAR-002（見えない値は残らない）、PROP-VAR-003（版の固定）。
- DB のロールの検査：`catalog_item_version` に `UPDATE` を与えない。

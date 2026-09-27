---
status: accepted
date: 2026-09-27
---

# ADR-0033: MVP の後の中身の検索は、Worker がチェックポイントからノードの名前とテキストを取り出し、OpenSearch に索引する。権限は資源の連鎖を文書に持たせて問い合わせの時点で絞り、判定関数で読み直す

## Context

MVP の後に、ファイルの中のノードの名前とテキストを検索する。本家のファイルブラウザの検索も、ファイルの中のテキストを一致させる（[Search for files, folders, and people](https://help.figma.com/hc/en-us/articles/4422774037271-Search-for-files-folders-and-people)、2026-09-27 に確認）。

ファイルの中身は Aurora になく、Document Server のメモリ、ジャーナル、S3 のチェックポイントにある（[ADR-0003](0003-journal-and-checkpoints.md)）。インスタンスの子は保存せず導出する（[ADR-0021](0021-derived-instances-and-override-keys.md)）。

本家は AI の検索のために、非同期の job でサーバーの上の画面のないエディタを動かしてファイルの中を列挙し、索引を最大 4 時間に 1 回に間引いて、処理するデータを 12% にした（[The infrastructure behind AI search in Figma](https://www.figma.com/blog/the-infrastructure-behind-ai-search-in-figma/)、2024-10-15）。権限は、前処理で filter を作り、後処理で確かめる（[The search for speed in Figma](https://www.figma.com/blog/the-search-for-speed-in-figma-opensearch/)、2024-10-10）。いずれも 2026-09-27 に確認。

## Options

取り出し：

1. **Worker がチェックポイントを読み、ネイティブの `doc-model` で導出して取り出す**
2. **Document Server が変更のたびに索引の更新を出す**
3. **クライアントが索引を作って送る**

権限：

- a. **資源の連鎖（`org_id`・`team_id`・`project_id`・`file_id`）を文書に持たせ、問い合わせの時点で読めうる資源の集合で絞り、判定関数で読み直す**
- b. **読める主体のキーを文書に持たせる**（rebuilds の Notion の形）

## Decision

1 と a を採用する。詳細は [search.md](../architecture/search.md) の 4 節。

- チェックポイントの書き込み（`file.checkpointed`）を契機に、同じファイルは 30 分に 1 回まで索引する。ファイルを手放すときに最後の 1 回を行う。
- 文書は `(file_id, page_id)` の単位。ノードの名前とテキストを持ち、ファイルの名前は持たない。
- 解析は rebuilds の Notion の search.md の 4 節（N-gram と Sudachi）を使う。
- 役割の変更では文書を書き換えない。移動と一般アクセスの変更だけ、連鎖のフィールドを書き換える。
- 2 を採らない理由：編集の経路（NFR-001）に索引の仕事を足す。変更のたびの更新は、本家の間引きの結果（12%）から見て無駄が大きい。
- 3 を採らない理由：クライアントは信頼できない。他の人のファイルの索引を、改ざんした内容で書けてしまう。
- b を採らない理由：Figma の役割はチーム・プロジェクト・ファイルの 3 段に広く付き、役割の変更のたびに多くの文書を書き換えることになる。問い合わせの時点の集合（上位集合）で絞れば、役割の変更は即時に効く。

## Consequences

- 良くなること：
  - 編集の経路に手を入れない。
  - インスタンスの中のテキストも、導出の同じコードで検索にかかる。
  - 役割の変更で、索引を書き換えない。
- 引き受けるコスト：
  - 最大 30 分（とチェックポイントの 60 秒）の遅れ。
  - Worker がチェックポイントを読んで導出する費用。大きなファイルほど重い。
  - 抜粋に、既に消した文言が出うる（今読める人にだけ）。

## Confirmation

- 性質ベーステスト：結果のすべてを判定関数で読める。
- 性質ベーステスト：組み立てた要求が、必ず `org_id`・資源の集合・`in_trash` の `filter` を含む。
- 計測：索引の遅れ、1 ファイルの索引の時間、読み直しで落ちた件数。

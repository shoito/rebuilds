---
status: accepted
date: 2026-09-26
---

# ADR-0017: Issue と Pull Request は 1 つの表に置き、リポジトリごとの 1 つの番号の列を、リポジトリの行の計数で採番する

## Context

本家では、Issue と Pull Request が、リポジトリごとの 1 つの番号の列を共有する（`#1` が Issue なら、次の Pull Request は `#2`）。REST API は「すべての Pull Request は Issue だが、すべての Issue が Pull Request ではない」としている（[REST API の Issues](https://docs.github.com/en/rest/issues/issues)）。参照（`#26`）、URL、Webhook、API の利用者は、この番号に依存する。

番号には次の性質が要る。

- リポジトリの中で一意で、再利用しない。
- 並行に作っても重複しない。
- 失敗した作成で欠番を出さない（本家の番号はほぼ連続する。削除と移動の欠番は出る）。
- 100 万のリポジトリ（S1）に対して、採番の仕組みの数が増えない。

## Options

### 表

1. **Issue と Pull Request を 1 つの表 `issues` に置き、Pull Request は `pull_requests` の行（1 対 1）を足す**
2. 別々の表に置き、番号だけを共有する

### 採番

A. **`repositories.next_issue_number` を、作成のトランザクションの中で `UPDATE ... RETURNING` で進める**
B. リポジトリごとに PostgreSQL のシーケンスを作る
C. `MAX(number) + 1` を、一意制約の違反で再試行する
D. 採番の専用のサービス（Valkey の `INCR` など）

## Decision

1 と A を採用する。詳細は [issues.md](../architecture/issues.md) の 1 節にある。

- `issues` に、コメント・ラベル・担当者・マイルストーン・リアクション・タイムライン・通知のスレッドを共有させる。Pull Request に固有の列（head・base、マージの状態）は `pull_requests` に置く。
- 番号は `UPDATE repositories SET next_issue_number = next_issue_number + 1 WHERE id = :repo_id RETURNING next_issue_number - 1` で得て、同じトランザクションで `issues` の行を書く。巻き戻れば番号も戻るので、失敗による欠番は出ない。
- `(repo_id, number)` に一意制約を置く。移動した Issue の元の番号は `issue_redirects` に残し、再利用しない。
- 2 を採らない理由：共有する子の表（コメント、ラベル、リアクション、タイムライン）が二重になるか、多態の外部キーになる。
- B を採らない理由：100 万のシーケンスは、カタログと運用（バックアップ、移行）の負担が大きい。シーケンスはトランザクションで巻き戻らず、失敗で欠番が出る。
- C を採らない理由：同じリポジトリへの並行の作成（bot、一括の作成）で、衝突と再試行が増える。
- D を採らない理由：DB の外の採番は、トランザクションで巻き戻らず、DB と二重の正本になる。

## Consequences

- 良くなること：
  - 本家と同じ番号と API の形になる。
  - 採番は DB の 1 行の更新で、正しさを DB のトランザクションだけで保てる。
- 悪くなること、引き受けるコスト：
  - 同じリポジトリへの作成は、リポジトリの行のロックで直列になる。ロックはコミットまで続くので、作成のトランザクションを短く保つ（参照の抜き出し、通知、検索の索引は outbox の後で行う）。bot が 1 つのリポジトリに大量に作る場合の上限は、作成のレート制限（[issues.md](../architecture/issues.md) の 13 節）で抑える。
  - `repositories` の行の更新が増え、その行の他の更新（設定、統計）とロックを取り合う。統計の列（star の数など）は別の表に分ける。
  - Pull Request にしかない問い合わせでも、`issues` との結合が要る。

## Confirmation

- 性質ベーステスト：同じリポジトリで Issue と Pull Request を並行に作り、一部を失敗させても、成功したものの番号が重複せず、1 から隙間なく並ぶ（削除・移動のない場合）。
- 負荷試験：1 つのリポジトリへの作成を 1 秒に 50 件続けても、作成の p95 が目標の内側に収まる。
- lint：`issues.number` を採番の関数以外で書くことを禁止する。

---
status: accepted
date: 2026-09-26
---

# ADR-0010: 差分とマージは、ストレージの RPC で作業ツリーなしに計算し、SHA の組でキャッシュする

## Context

Pull Request の画面と API は、次を大量に計算する。

- 差分（merge base から head まで）
- マージできるか（衝突の有無）と、テストマージのコミット（`refs/pull/{number}/merge`）
- マージの実行（merge・squash・rebase）

計算の結果は、手元の `git merge` と一致しなければならない。本家は、libgit2 の独自のマージの実装で「手元の Git ではマージできるのに、GitHub ではできない」という食い違いを抱え、`merge-ort` に移った。その結果、マージは平均 71 ms から 7.74 ms に速くなった。rebase は `git replay` で行う（[Scaling merge-ort across GitHub](https://github.blog/engineering/infrastructure/scaling-merge-ort-across-github/)）。

push のたびに、関係する PR のマージ可能かを計算し直す必要もある（[ADR-0005](0005-git-as-source-of-truth.md)）。

## Options

1. **ストレージの RPC で、Git の本体の `merge-tree --write-tree`（merge-ort）と `diff-tree` を使って、作業ツリーなしに計算する。結果は入力の SHA の組でキャッシュする**
2. アプリ層（TypeScript）の Git のライブラリで計算する
3. 一時的な作業ツリー（clone か worktree）を作り、`git merge` を実行する

## Decision

1 を採用する。詳細は [pull-requests.md](../architecture/pull-requests.md) の 3 節と 6 節にある。

- **作業ツリーを作らない。** `git merge-tree --write-tree` は、作業ツリーにも index にも触れずにマージを行い、結果の tree の ID を返す。終了コード 0 が衝突なし、1 が衝突あり（[git-merge-tree](https://git-scm.com/docs/git-merge-tree)）。衝突の判定は、終了コードと「Conflicted file info」だけで行う。
- **マージの方式は、Git の本体の操作の組み合わせで作る。**
  - merge：`merge-tree` → `commit-tree`（親は 2 つ）
  - squash：`merge-tree` → `commit-tree`（親は base の 1 つ）
  - rebase：`git replay`
- **RPC はストレージのサービス（Go）に置く**（[ADR-0001](0001-platform-and-stack.md)）。fork のネットワークはオブジェクトを共有するので（[ADR-0007](0007-fork-network-object-sharing.md)）、fork をまたぐ PR も、コミットを転送せずに計算できる。
- **結果は入力の SHA の組でキャッシュする。**
  - 差分：`(network_id, merge_base_sha, head_sha, 選択肢)`
  - マージ可能か：`(network_id, base_sha, head_sha)`
  - SHA が決まれば結果が決まるので、キャッシュは無効化しない。追い出すだけにする。
- **マージ可能かは非同期に計算する。** 本家の REST API と同じく、未計算なら `mergeable: null` を返し、裏で計算する（[REST API: pulls](https://docs.github.com/en/rest/pulls/pulls)）。画面の表示の経路に入れない（NFR-004）。
- **マージの実行では、DB の写しでなく、Git の現在の SHA で計算し直す。** base の ref の更新は、期待する旧 SHA を指定した比較交換で行う（[ADR-0006](0006-ref-update-consensus.md)）。
- **表示の上限は、ストレージの側で打ち切る。** 本家の差分の上限（PR 全体で 20,000 行か 1 MB、1 ファイルで 20,000 行か 500 KB、300 ファイル）に揃える（[Repository limits](https://docs.github.com/en/repositories/creating-and-managing-repositories/repository-limits#diff-limits)）。
- 2 は、merge-ort と同じ結果（rename の検出、ディレクトリとファイルの衝突）を再実装することになり、本家が libgit2 で抱えた食い違いを繰り返す。大きな blob をアプリ層へ運ぶことにもなる。
- 3 は、作業ツリーの作成が大きなリポジトリで重く、ディスクの管理と後片付け、同時実行の隔離が要る。本家も、作業ツリーを持たない方式を採っている（同上の blog）。

## Consequences

- 良くなること：
  - 手元の `git merge` と結果が一致する。
  - 計算が速く、キャッシュの一貫性の問題（無効化の漏れ）がない。
  - Git の本体の改善（merge-ort、replay）をそのまま取り込める。
- 引き受けるコスト：
  - Git の本体のバージョンがマージの結果に影響する。バージョンの更新で結果が変わりうるので、全ノードのバージョンを揃え、更新時に既知のマージの結果を比べる。
  - `git replay` は比較的新しいコマンドで、挙動が変わりうる。バージョンを固定し、rebase の結果を検証するテストを持つ。
  - base が頻繁に動くリポジトリでは、マージ可能かの再計算が多い。見られている PR を優先し、それ以外を間引く。

## Confirmation

- 差分の検査：無作為に作ったリポジトリの組で、RPC の `MergeTree` の結果（tree の ID と衝突の有無）が、手元の `git merge` の結果と一致する（性質ベーステスト）。
- 性能の試験：`DiffStats` p95 100 ms、`MergeTree` p95 200 ms（中規模のリポジトリ）。
- lint：アプリ層（TypeScript）から、Git のオブジェクトを直接読むライブラリを import していない。
- 監視：マージ可能かの計算の待ちの長さと、キャッシュの命中率。

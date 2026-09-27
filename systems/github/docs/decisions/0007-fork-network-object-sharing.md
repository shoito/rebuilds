---
status: accepted
date: 2026-09-26
---

# ADR-0007: fork はネットワークごとの共有の objects（alternates）で持ち、ネットワークを配置の単位にする

詳細は [git-storage.md](../architecture/git-storage.md) の 7 節。

## Context

fork は、元のリポジトリとほとんど同じ objects を持つ。人気のリポジトリは数万の fork を持つ。fork ごとに objects を複製すると、容量が fork の数に比例して増え、3 つの複製でさらに 3 倍になる。

本家は、fork を objects を持たない浅いコピーとし、ネットワークの全ての objects を持つ `network.git` を Git の alternates で参照させる（[Counting objects](https://github.blog/2015-09-22-counting-objects/)）。その結果、ある fork に push したコミットは、ネットワークの他のリポジトリからも見えうる。本家はこれを仕様として文書にしている（[About forks](https://docs.github.com/en/pull-requests/reference/forks)）。

## Options

1. **ネットワークごとに `network.git` を持ち、各リポジトリが alternates で参照する。ネットワークを 3 つの同じノードに置く**（本家に寄せる）
2. **fork ごとに objects を完全に持つ**（ハードリンクや、ファイルシステムの重複排除に任せる）
3. **objects を S3 などの内容でアドレスする置き場に集め、リポジトリをまたいで重複を除く**

## Decision

> 2026-09-26 の注記：「`upload-pack` は、そのリポジトリの ref から到達できる objects だけを返す設定にする」は、プロトコル v0・v1 にしか効かない。v2 の `fetch` は、広告していない `want` も object store（alternates の先の `network.git` を含む）にあれば返し、Git の本体の設定では制限できない（[gitprotocol-v2](https://git-scm.com/docs/gitprotocol-v2)、[upload-pack.c](https://github.com/git/git/blob/master/upload-pack.c)）。本家も、ネットワークのどのリポジトリに push したコミットも上流を含む他のリポジトリから到達できうると文書にしている（[About permissions and visibility of forks](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/working-with-forks/about-permissions-and-visibility-of-forks)）。そこで、公開のネットワークでは Git の経路も Web・API と同じく仕様として受け入れる。非公開のネットワークで Git の経路を制限するなら、`gitd` が v2 の `want` を到達可能性で検査する処理を自前で持つ。採るかは Web・API と一緒に E3 の `fork-network-reachability-check` で決め、この ADR を改める ADR を起票する（[git-storage.md](../architecture/git-storage.md) の 7.2 節）。下の Confirmation の 2 つ目も、この注記に従って読む。

> 2026-09-28 の注記：非公開のネットワークの扱いを決めた。**非公開のネットワークでは、SHA の参照に到達可能性の検査を既定でかける。** Go のストレージの層（`gitd` と読み取りの RPC）に自前で持ち、Git の v2 の `want` と、Web・API の SHA の参照（`/commit/<sha>` など）の両方がここを通る。要求したリポジトリの ref から到達できない objects は、存在しないものとして扱う（Git は `not our ref`、Web・API は 404）。検査の費用は E1 の `fork-network-want-poc` で測る。公開のネットワークは、本家と同じく仕様として受け入れたまま。非公開のネットワークでの扱いは本家より厳しく、**本家との違い** になる。別の ADR は起票せず、この ADR を直した（[docs/process.md](../../../../docs/process.md) の 9 節の例外）。

1 を採用する。

- ネットワークの全てのリポジトリの objects を、保守で `network.git` に集める。`network.git` は各リポジトリの ref を `refs/networks/<repo_id>/*` に写して持ち、到達可能性の根にする。
- ネットワークを配置の単位にし、同じネットワークのリポジトリは必ず同じ 3 つのノードに置く（alternates は同じファイルシステムを必要とする）。
- 公開と非公開をネットワークで混ぜない。公開の種類を変えたら、本家と同じく、ネットワークを分ける。分け終えるまで、公開の種類の変更を完了にしない。
- 読み取りの認可は、ネットワークではなくリポジトリごとに行う（ADR-0002）。`upload-pack` は、そのリポジトリの ref から到達できる objects だけを返す設定にする（v0・v1）。
- **公開のネットワーク**：同じネットワークの中で、ハッシュを指定すれば他の fork のコミットが見えうることは、本家と同じく仕様として受け入れ、Web で「このリポジトリのブランチに属さないコミット」と表示する。
- **非公開のネットワーク**：ストレージの層で、要求したリポジトリの ref からの到達可能性を検査する（Git の v2 の `want` と、Web・API の SHA の参照）。到達できなければ返さない（本家との違い）。
- clone で他の fork の objects との delta を使わないよう、delta islands を使う（[git-pack-objects](https://git-scm.com/docs/git-pack-objects#_delta_islands)）。
- 2 を採らない理由：容量が fork の数に比例する。ハードリンクは、repack でパックが作り直されると共有が外れる。
- 3 を採らない理由：Git の読み取り（パックの生成）で、毎回 objects を組み立て直す費用がかかる（ADR-0003 で退けた理由と同じ）。

## Consequences

- 良くなること：
  - fork の作成が、ref の写しだけで済み、速い。容量が fork の数にほぼ比例しない。
  - fork の間の PR の差分・マージの計算が、同じリポジトリの中の操作と同じように行える。
- 悪くなること、引き受けるコスト：
  - fork に push した内容（秘密情報を含む）は、ネットワークに残りうる。fork を消しても消えない。完全な消去には運用の手順が要る。
  - 空でないネットワークに属していたリポジトリは、削除の後に復元できない（本家と同じ制約）。
  - 巨大なネットワークは 3 つのノードに収まらなければならない。専用の大きなノードの群が要る。
  - 保守（到達できない objects の削除）が、ネットワークの全てのリポジトリの ref を見なければ判定できず、重い。
  - 公開の種類の変更で、objects のコピーを伴うネットワークの分割が起きる。

## Confirmation

- 結合テスト：非公開のネットワークで、あるリポジトリの読み取りの権限がない利用者は、そのリポジトリの経路（Git、Web、API）から、同じネットワークの他のリポジトリの objects を含め、何も読めない。
- 結合テスト：fork の ref にしかないコミットを、元のリポジトリの Git の経路から `want` したときの振る舞いを固定する。公開のネットワークでは返り、非公開のネットワークでは v0・v1・v2 のいずれでも返らない。Web・API の SHA の参照も、非公開のネットワークでは 404 になる。
- 性質ベーステスト：公開の種類の変更の後、公開のネットワークに、非公開のリポジトリだけから到達できる objects がない。
- レビュー観点：保守の到達可能性の判定が、`refs/networks/*` の全てを根にしていること。

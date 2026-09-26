---
status: accepted
date: 2026-09-26
---

# ADR-0014: コード検索は Zoekt をリポジトリの単位のシャードで独立したクラスタに置き、Issue・PR・リポジトリの検索は OpenSearch に置く

## Context

MVP に、コード検索と、リポジトリ・Issue・Pull Request の検索が入る（[intent.md](../intent.md)）。2 つは性質が違う。

- コード検索は、記号を含む部分一致と正規表現が要る。自然言語の語の分割（トークン化）が合わない。対象は Git の中身で、push のたびに変わる。反映の目標は 5 分（NFR-005）。
- Issue・Pull Request の検索は、属性（状態、ラベル、担当者、日時）での絞り込みと関連度の並べ替えが中心で、本文は自然言語。反映の目標は 10 秒（NFR-005）。

本家のコード検索は、Rust で作った専用のエンジン Blackbird である。可変長の ngram の索引を、Git の blob の ID でシャードに分け、重複する内容を 1 回だけ索引する（[The technology behind GitHub's new code search](https://github.blog/engineering/architecture-optimization/the-technology-behind-githubs-new-code-search/)）。規模は 4,500 万のリポジトリ・115 TB で、S1（100 万のリポジトリ）の数十倍である。

[README.md](../architecture/README.md) の技術スタックは、コード検索を「Rust か既存の検索エンジン」とし、この ADR で決めることにしていた。

## Options

### コード検索

1. **Zoekt**（Go。位置付きの trigram の索引。正規表現、シンボル、リポジトリの単位のシャード。Sourcegraph が保守し、GitLab の完全一致のコード検索も採用）
2. **Rust で専用のエンジンを作る**（本家の Blackbird に倣う）
3. **OpenSearch**（ngram のトークナイザーでコードを索引する）

### Issue・Pull Request・リポジトリの検索

A. **OpenSearch**（S1 から）
B. PostgreSQL の全文検索で始め、規模に応じて OpenSearch へ移る（Slack の ADR-0004）

## Decision

> 2026-09-26 の注記：Zoekt は、差分の索引（`zoekt-git-index` の `-delta`。変わったファイルを古いシャードで墓石にする）と、リポジトリの ID の集合の条件（`query.RepoIDs`。roaring のビットマップ）を持つ（[cmd/zoekt-git-index/main.go](https://github.com/sourcegraph/zoekt/blob/main/cmd/zoekt-git-index/main.go)、[query/query.go](https://github.com/sourcegraph/zoekt/blob/main/query/query.go)）。機能があることは確かめた。専用の文書はなく、本設計の規模で耐えるかは、引き続き E6 の `code-search-zoekt-poc` で確かめる。

コード検索は 1、Issue・Pull Request・リポジトリの検索は A を採用する。詳細は [search.md](../architecture/search.md) にある。

### コード検索：Zoekt

- 位置付きの trigram の索引で、記号を含む部分一致と、リテラルを抜き出して候補を絞る正規表現を扱える。本家が trigram から sparse grams へ進んだ理由（よくある trigram の候補の多さ）は、S1 の規模では Zoekt の位置の情報で十分に抑えられる見込み。
- 索引はリポジトリの単位のシャードにする。push のたびに、そのリポジトリだけを作り直せる。`repo:` の検索は、そのリポジトリのノードだけに送れる。
- シャードは code-indexer（Go、状態なし）が作り、S3 に置く。索引のノード（EC2、ローカルの NVMe）が S3 から取って提供する。索引は Git から作り直せるので、複製は 2 つ（可用性のため）。
- 言語は Git の層と同じ Go になり（[ADR-0001](0001-platform-and-stack.md)）、3 つめの言語を増やさない。
- 2 を採らない理由：本家の規模では、blob の単位の重複の排除と専用の設計が効く。S1 の規模では、エンジンを一から作り、保つ費用に見合わない。S2 で重複の排除が要るほど索引が大きくなったら、改めて検討する。
- 3 を採らない理由：コード向けの ngram の索引は、転置リストが大きく、正規表現を効率よく扱えない。リポジトリの単位の作り直しが、文書の単位の更新の繰り返しになる。

### Issue・Pull Request・リポジトリの検索：OpenSearch（S1 から）

- 公開のリポジトリは、Organization をまたいで全体を検索される。100 万のリポジトリの Issue を 1 つの PostgreSQL で全体の検索にかけると、Slack のように「テナントの中の検索」に閉じないので、S1 から専用のエンジンが要る。
- 属性の絞り込み、関連度、`search_after` のページングが揃う。Slack の S2 の設計（別名の裏のインデックス、二重書き込みでのマッピングの変更）を流用できる。
- B を採らない理由：Slack の ADR-0004 の前提（ワークスペースで閉じた検索、S1 の規模の小ささ）が当てはまらない。

## Consequences

- 良くなること：
  - コードの部分一致・正規表現・シンボルの検索を、既存の実績のあるエンジンで早く出せる。
  - 索引の正本を Git と DB に置いたまま、索引をいつでも作り直せる。
  - 2 つの検索の遅れ（5 分と 10 秒）を、別々の経路で守れる。
- 悪くなること、引き受けるコスト：
  - 運用する検索のクラスタが 2 種類になる。
  - Zoekt は分散の仕組みを持たないので、ノードへの割り当て、クエリの広げ方、合わせ方の router を自分で作る。
  - fork などの同じ内容を、リポジトリごとに索引する。旧コード検索と同じく、親より star の少ない fork を索引しないことで抑える。
  - Zoekt の差分のシャードと、リポジトリの ID の集合の条件が、本設計の使い方に耐えるかは未検証。S1 の前に試作で確かめ、使えなければ、大きなリポジトリの反映の目標を例外にする。

## Confirmation

- 試作：代表的な 1 万のリポジトリで、索引の大きさ（内容の約 3.5 倍の見込み。[Zoekt の設計](https://github.com/sourcegraph/zoekt/blob/main/doc/design.md)）、push から検索できるまでの時間、クエリの p95 を測り、[capacity.md](../architecture/capacity.md) に反映する。
- 合成監視：専用のリポジトリへの push から、コード検索に出るまでの時間が 5 分以内。
- 構文のテスト：[search.md](../architecture/search.md) の 3.5 節と 5.4 節の各行。

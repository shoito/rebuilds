---
status: accepted
date: 2026-09-26
---

# ADR-0008: clone の負荷は、ビットマップ、ノードのパックのキャッシュ、人気の公開リポジトリの bundle-uri と CDN で下げる

詳細は [git-protocols.md](../architecture/git-protocols.md) の 6 節。

## Context

Git の読み取りは書き込みより桁違いに多く、clone のパックの生成は CPU とディスクを大きく使う。CI、ボット、AI の学習のための収集が、同じリポジトリを短い時間に大量に clone する（intent.md の未解決の問い）。1 つのリポジトリへの clone の嵐が、同じノードの他のリポジトリを遅くしてはならない（NFR-003）。

Git と本家には、次の道具がある。

- 到達可能性のビットマップと、multi-pack index のビットマップ（本家が大きなモノレポのために Git に入れた。[Scaling monorepo maintenance](https://github.blog/open-source/git/scaling-monorepo-maintenance/)）
- プロトコル v2 の `bundle-uri`：静的な bundle を CDN から取らせ、差分だけをサーバーから取らせる（[bundle-uri](https://git-scm.com/docs/bundle-uri)）。クライアントの側で `transfer.bundleURI` の有効化が要る
- partial clone（[partial-clone](https://git-scm.com/docs/partial-clone)）
- パックの出力のキャッシュ（GitLab の Gitaly の pack-objects cache）

## Options

1. **ビットマップと commit-graph を全てのリポジトリで保つ。ノードにパックの出力のキャッシュを置く。人気の公開リポジトリだけ bundle-uri と CDN で配る**
2. **ビットマップだけに頼る**（キャッシュも CDN も持たない）
3. **全ての clone を CDN の前段のキャッシュ（HTTP のキャッシュ）で受ける**
4. **packfile-uris で、パックの一部を CDN から取らせる**

## Decision

> 2026-09-26 の注記：本家は github.com で bundle-uri を広告していない（`GIT_TRACE_PACKET=1 git ls-remote` で観測。v2 の capability に `bundle-uri` がない。文書での記述はない）。bundle-uri はこの設計の判断で、本家との違いになる。クライアントの既定（`transfer.bundleURI` は無効）では使われないので、互換には影響しない（[git-protocols.md](../architecture/git-protocols.md) の 6.4 節）。パックのキャッシュの有無は、引き続き公開情報では確かめられない。

1 を採用する。

- 保守で、multi-pack index のビットマップと commit-graph を全てのリポジトリに作る。
- ストレージのノードのローカルの NVMe に、`pack-objects` の出力のキャッシュを置く。キーは、要求の内容（`want`・`have`・`filter`・capability）とリポジトリのチェックサム。同時の同じ要求は 1 つの出力を共有する。既定で 5 分で捨てる。リポジトリをまたいで共有しない。
- clone の多い公開のリポジトリについて、週ごとの全体と日ごとの増分の bundle を S3 に置き、CloudFront で配る。v2 の `bundle-uri` で広告し、`creationToken` の順に取らせる。
- partial clone（`blob:none`、`blob:limit`、`tree:0`）を受け付ける。
- 2 を採らない理由：ビットマップがあっても、同じ内容のパックを何度も作り、送る費用は残る。clone の嵐はノードの CPU を埋める。
- 3 を採らない理由：Git の smart HTTP の応答は、クライアントが持つ objects（`have`）に依存し、HTTP のキャッシュのキーにならない。認可の判定もキャッシュの前で要る。
- 4 を採らない理由：パックの生成と CDN の上のファイルを、サーバーが要求ごとに組み合わせる必要があり、運用が bundle-uri より複雑になる。

## Consequences

- 良くなること：
  - CI やボットの同じ clone が、1 回のパックの生成で済む。
  - 人気の公開リポジトリの clone の大部分を、CDN の帯域に移せる（bundle-uri を有効にしたクライアントの分）。
- 引き受けるコスト：
  - bundle-uri は、クライアントが有効にしないと使われない（Git の既定では無効）。効果は利用者への案内に依る。
  - キャッシュの容量と、bundle の作成・S3・CloudFront のコストがかかる。
  - 非公開のリポジトリには bundle-uri を使えない（CDN の認可が別に要る）。
  - 本家が bundle-uri とパックのキャッシュを使っているかは、公開情報で確かめられない（未検証）。本家に寄せる対象ではなく、この設計の判断とする。

## Confirmation

- 負荷試験：同じリポジトリへの同時 100 の clone で、`pack-objects` の実行が 1 回に近く、NFR-003 を満たす。
- 結合テスト：非公開のリポジトリのキャッシュの項目を、権限のない要求や別のリポジトリの要求が読めない。
- 結合テスト：`transfer.bundleURI=true` の clone が、bundle を取ってから差分だけを fetch し、結果のリポジトリが通常の clone と同じ ref と objects を持つ。
- 監視：キャッシュのヒット率、bundle-uri の配信数、ノードの同時の `pack-objects` の数。

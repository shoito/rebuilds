---
status: accepted
date: 2026-09-26
---

# ADR-0035: Web は React をサーバーでストリーム描画し、画面の単位でハイドレーションする

詳細は [web.md](../architecture/web.md) の 1 節と 7 節。

## Context

Web の画面には、性質の違う 2 種類の利用がある。

- **公開リポジトリの閲覧**：ログインしていない人と検索エンジンが多い。ファイル・README・Issue・PR を、最初の表示で速く読めることが大事。
- **レビューとコードの操作**：ファイルの検索、行の選択、差分の展開、コメント。1 画面の中の操作が多く、大きな差分（1 万行を超える）でも固まらないことが要る。

目標は NFR-004（PR の画面 p95 1.5 秒、差分 1,000 行まで）と、web.md の 7 節の性能の予算（HPC p75 1 秒、INP p75 200 ms、最初の JavaScript 150 KB）。

本家は、差分で見えている行だけをハイドレーションし、大きな PR では仮想化している（[The uphill climb of making diff lines performant](https://github.blog/engineering/architecture-optimization/the-uphill-climb-of-making-diff-lines-performant/)）。Issue の画面では、全体の読み込み・Turbo・React の遷移を併用している（[From latency to instant](https://github.blog/engineering/architecture-optimization/from-latency-to-instant-modernizing-github-issues-navigation-performance/)）。

Web は TypeScript（Hono、React）で作る（[ADR-0001](0001-platform-and-stack.md)）。web.md の起票の時点で ADR の範囲（0010–0013）に入らなかったので、ここで決める。

## Options

1. **SPA**：クライアントだけで描画する（Slack の Web と同じ）
2. **サーバーの描画だけ（MPA）**：操作は小さな JavaScript で補う
3. **SSR をストリームで返し、画面（ルート）の単位でハイドレーションし、同じアプリの中の遷移はクライアントのルーターで行う**
4. React Server Components を使う

## Decision

3 を採用する。

- Hono の上で React の SSR をストリームで返す（`renderToReadableStream`）。画面の骨格と最重要の内容（ファイルの本文、PR の差分の先頭）を先に送り、残りは Suspense の境界ごとに流す。
- ハイドレーションは画面の単位で行う。差分とコードの表示は、見えている範囲の行だけをハイドレーションし、仮想化する（コード 500 行、差分 2,000 行を超えたら）。
- 最初の読み込みの後の遷移は、クライアントのルーター（TanStack Router）でデータだけを取る。
- JavaScript が動かなくても、公開リポジトリのファイル・README・Issue・PR は読める。操作には JavaScript を要する。
- SSR は API の HTTP を呼び直さず、同じサービス関数を呼ぶ。権限の判定（[ADR-0002](0002-repository-permission-model.md)）は HTTP の API と同じ関数を通す。
- HTML は MVP では CDN でキャッシュしない。公開リポジトリの匿名の閲覧をキャッシュするかは、E9 の負荷試験の後に決める。
- 1 を採らない理由：最初の表示が JavaScript の読み込みと API の往復を待ち、匿名の閲覧と検索エンジンに不利。
- 2 を採らない理由：レビューとコードの閲覧の操作が重くなる。
- 4 を採らない理由：Hono との組み合わせの成熟度が確かめられていない。3 の上に後から足せるので、見直しの候補にとどめる。

## Consequences

- 良くなること：
  - 公開リポジトリの最初の表示が速く、JavaScript なしでも読める。
  - 大きな差分でも、ハイドレーションと描画を見える範囲に限るので、INP の予算を守りやすい。
  - 画面と API が同じサービス関数と判定関数を通るので、権限の経路が増えない。
- 引き受けるコスト：
  - SSR のサーバーが要る（Web・API の ECS のタスク。[infrastructure.md](../architecture/infrastructure.md)）。ストリームの途中のエラーの扱い（送り始めた後の 404 など）を設計する必要がある。権限の判定とデータの存在の確認は、ストリームを始める前に済ませる。
  - サーバーとクライアントで同じ描画を保つ必要がある（ハイドレーションの不一致）。
  - 言語（英語・日本語）ごとに HTML が変わるので、`Vary: Accept-Language` を付ける（web.md の 9 節）。

## Confirmation

- 性能の予算の CI：最初の JavaScript のサイズ（共通 150 KB、画面ごと 100 KB）を超えたら失敗させる。
- 負荷試験：PR の画面（差分 1,000 行）で NFR-004 を満たす。差分 20,000 行の PR で INP p75 200 ms 以内。
- E2E：JavaScript を無効にしたブラウザで、公開リポジトリのファイル・README・Issue・PR が読める。
- 結合テスト：ストリームを始める前に権限の判定が済んでいる（非公開のリポジトリで権限がなければ、最初のバイトから 404 の画面になり、部分的な内容が送られない）。
- RUM で HPC・LCP・INP・CLS を画面ごとに計測する（[observability.md](../architecture/observability.md)）。

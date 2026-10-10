---
status: accepted
date: 2026-10-10
---

# ADR-0044: HTML メールは、サーバーの `html-render`（Rust）で許可の一覧による浄化と CSS の閉じ込めをし、`<brand>usercontent.<domain>` の origin の sandbox の iframe（同じ origin を許さない）に置く。画像は代理の URL に書き換え、リンクは書き換えずに iframe の中の固定のスクリプトが押下を親へ渡し、親が先頭のハッシュで確かめてから開く。保存した本文は変えない。迷惑メールの箱では画像とリンクを無効にする

詳細は [web-client.md](../architecture/web-client.md) の 7 節。

## Context

- 受け取った HTML は、外の誰でも書ける。スクリプト、フォーム、CSS による画面の偽装、追跡の画像、悪意のあるリンクを含む。
- 本システムの画面（`app.<brand>.<domain>`）のクッキー・保存・DOM に、メールの HTML が届いてはならない。利用者の中身は `<brand>usercontent.<domain>` からだけ返す（`AGENTS.md`）。
- 本文の URL を書き換えない（DKIM と転送のため）。外部の画像は代理で取得する（[architecture/README.md](../architecture/README.md) の 6 節の決定）。外部の画像の代理の取得は [ADR-0028](0028-external-image-proxy.md)、開くときの URL の確かめは [ADR-0027](0027-url-reputation-and-click-time-checks.md)。
- 浄化の誤り（解析の違いを突くもの）は、1 段の守りでは防ぎきれない。

## Options

1. **サーバーで浄化し、別の origin の sandbox の iframe に置く（2 段）**
2. ブラウザーの中で浄化し、画面の DOM に直接入れる
3. 浄化せず、別の origin の sandbox の iframe に置くだけ

## Decision

1 を採用する。

- `html-render` は、HTML5 の構文解析（WHATWG の手順に従う汎用のライブラリ）で木にし、許可の一覧（要素、属性、URL の種類）で浄化し、CSS を構文解析して `.m-body` の下に閉じ込め、許す性質だけを残す。入力 2 MiB、深さ 256、要素 5 万を超えたら text の表示に落とす。
- 結果はアカウント・メッセージ・パート・規則のバージョンを鍵に 1 時間キャッシュする。
- iframe は `<brand>usercontent.<domain>` の、アカウントとメッセージに結び付いた 5 分の署名つきの URL で開く。`sandbox` は `allow-popups allow-popups-to-escape-sandbox` と、高さを知らせる本システムの固定のスクリプトのための `allow-scripts`（`allow-same-origin` は許さない）。CSP は `default-src 'none'`、`script-src` は固定のスクリプトの hash だけ。
- 外部の画像は `/img/<token>` に書き換える（`token` の形と取得は [ADR-0028](0028-external-image-proxy.md)）。
- リンクの `href` は書き換えない。iframe の中の固定のスクリプトが押下を止め、`href` を親の画面へ `postMessage` で渡す。親は送り元の origin を確かめ、[ADR-0027](0027-url-reputation-and-click-time-checks.md) の先頭 32 ビットの照会で確かめてから `noopener,noreferrer` で開く。サーバーは利用者の開いた URL を知らない。
- 迷惑メールの箱では画像を表示せず、リンクを押せなくする。
- 差出人の確かめの印は、本文の外の本システムの画面として出す。

### 他の案を選ばなかった理由

- **2**：浄化の誤りが 1 つあれば、本システムの画面の origin でスクリプトが動く。
- **3**：CSS による画面の偽装、フォーム、追跡の画像を防げない。

## Consequences

- 良くなること：
  - 浄化をすり抜けても、メールの HTML のスクリプトは別の不透明な origin で、CSP にも止められる。
  - 保存した本文を変えずに、画像とリンクを守れる。
- 引き受けるコスト：
  - 浄化の規則と CSS の閉じ込めを保守する。メールの見た目の崩れを、規則のバージョンで直していく。
  - HTML5 の構文解析のライブラリを、[ADR-0001](0001-platform-and-stack.md) の汎用の部品の一覧に足す必要がある（Dev が ADR-0001 を更新するまで、`thread-view-and-safe-html` の spec を承認しない）。

## Confirmation

- 性質ベーステスト：PROP-WEB-002〜004（スクリプトの経路なし、不動点、CSS の閉じ込め）。
- 試験のベクトル：公開の XSS の試験の集まり（使ってよいと確かめたもの）。
- 外部のペンテスト（E17）で、usercontent の origin と iframe の守りを確かめる。

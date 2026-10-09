# 前提知識の資料の書き方

題材ごとの前提知識の資料（`systems/<name>/docs/primer/index.html`）を書くときの決まり。資料は GitHub Pages で公開する（[ADR-0008](../decisions/0008-primers-on-github-pages.md)）。共通の前提知識は [index.html](index.html) にあり、手本も兼ねる。

## 目的

設計の文書（intent・architecture・ADR・data-model）を読む人が、つまずかずに読めるように、**文書が前提にしている知識を補う**。設計の要約ではない。

- 対象の読み手：Web アプリの開発の経験はあるが、その題材の分野（決済、WebRTC、CRDT、給与計算など）には詳しくない人。
- 共通の前提知識（RLS、outbox、冪等、UUIDv7、ADR、規模の段階、ER 図の記号）は繰り返さず、共通の資料へリンクする。
- 題材の分野の概念・用語・業界の決まり・法令の枠組み・本家の製品の使われ方を、設計の文書の読み方とつなげて説明する。
- 各節の最後に、その知識が「設計の文書のどこで効くか」を 1〜2 行で示し、該当の文書へリンクする。

## ファイルの形

- 1 つの HTML ファイルに書く。CSS と JS は共通のもの（`docs/primer/assets/`）を相対パスで読む。
- `<head>` の直後に、既存のページと同じ Google アナリティクスのタグ（`G-LRH3HT8NDH`）を入れる（ルートの AGENTS.md）。
- 外部から読むのは、このタグと、共通の JS が読む Mermaid（jsdelivr）だけにする。画像は使わず、図は Mermaid かインラインの SVG にする。
- 本文は日本語で書く。短い文で、です・ます調にする。識別子とコードはそのまま。

```html
<!doctype html>
<html lang="ja">
<head>
<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-LRH3HT8NDH"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());

  gtag('config', 'G-LRH3HT8NDH');
</script>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Slack の前提知識</title>
<meta name="description" content="…">
<meta name="primer-home" content="../../../../index.html">
<link rel="stylesheet" href="../../../../docs/primer/assets/primer.css">
</head>
<body>
<main>
  <header class="hero">…資料表示の見出し（h1）…</header>
  <section class="s cover">…スライドの表紙（h2）…</section>
  <section class="s" id="…"><h2>…</h2>…</section>
  …
</main>
<script src="../../../../docs/primer/assets/primer.js"></script>
</body>
</html>
```

## 節（`section.s`）

- 1 つの節が、スライドの 1 枚になる。資料表示では、上から順に読める 1 本の文書になる。
- 節は 12〜20 個。1 節は、スライドの 1 画面に収まる分量を目安にする（文は 3〜8 文、表は 8 行まで）。
- 節には英小文字の `id` を付ける（目次とスライドのリンクに使う）。
- 構成の目安：
  1. 表紙（`section.s cover`）
  2. この題材は何をするサービスか（使う人、使われ方、規模の感覚）
  3. 分野の基本の概念（数節）
  4. 設計の主な論点と、それぞれを理解するのに要る知識（数節）
  5. データモデルの読み方（主な表とその関係。小さな ER 図）
  6. 本家と違うところ、名前の置き換え（`<brand>`）
  7. 用語集（`dl.glossary`、各 `dt` に `id="g-…"`）
  8. 読む順（設計の文書へのリンク）

## 使える部品

| 部品 | 書き方 | 用途 |
| --- | --- | --- |
| 用語のポップアップ | `<a class="t" href="#g-sfu">SFU</a>`（用語集の `dt id="g-sfu"` を指す） | 初出の専門用語 |
| ステップ | `<div class="stepper"><ol><li>…</li></ol></div>` | 処理の流れ・手順を 1 段ずつ |
| タブ | `<div class="tabs"><div data-tab="名前">…</div>…</div>` | 並べて比べる説明 |
| 確認の問い | `<div class="quiz" data-answer="2"><p class="q">…</p><div class="opts"><button>…</button>…</div><p class="why">…</p></div>` | 誤解しやすい点の確認。`data-answer` は 1 から数える |
| スライドで順に出す | 要素に `data-frag` | スライド表示で → を押すたびに出る |
| 図 | `<pre class="mermaid">…</pre>` | 流れ・構成・ER |
| 囲み | `<div class="callout">`、`callout key`（要点）、`callout warn`（注意） | 要点・注意 |
| カード | `<div class="cards"><div class="card"><h3>…</h3><p>…</p></div></div>` | 並列の概念 |
| 比較 | `<div class="compare"><div class="bad">…</div><div class="good">…</div></div>` | 良い例と悪い例 |
| 表示の限定 | `class="doc-only"`・`class="slide-only"` | どちらかの表示だけに出す |

- 確認の問いは、資料全体で 3〜6 個。
- Mermaid の `erDiagram` では、属性名に `pk`・`fk`・`uk` を使わない（パーサーが拒む）。

## リンク

- 設計の文書へのリンクは GitHub の URL にする（Pages では Markdown が描画されないため）：`https://github.com/shoito/rebuilds/blob/main/systems/<name>/docs/…`
- 共通の前提知識へは相対パス：`../../../../docs/primer/index.html#tenancy`

## 守ること

- 事実は、この題材の設計の文書と、公開されている標準・公式の資料に合わせる。設計の文書と食い違うことを書かない。
- 本家の内部の名前や、ブランドを含む識別子を使わない（[ADR-0006](../decisions/0006-brand-neutral-identifiers.md)）。製品の説明として本家の名前を書くのはよい。
- 法令は枠組みの説明にとどめ、断定的な法的判断を書かない。設計の文書で「法務の確認待ち」のものは、そう書く。

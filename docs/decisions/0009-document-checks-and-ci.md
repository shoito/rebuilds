---
status: proposed
date: 2026-10-11
---

# ADR-0009: 文書の検査の道具と CI を rebuilds に置く

## Context

[ADR-0005](0005-design-record-repository.md) で、rebuilds を設計の記録に限り、実装のコードと CI は題材ごとの開発リポジトリに置くと決めた。

一方、rebuilds の文書の規則は、AGENTS.md と process.md の文章と、人とエージェントの注意だけで守られている。題材が 21 になり、文書は 2,000 を超え、Mermaid の図は 800 枚を超えた。2026-10-10 の見直し（全題材への図の追加、README の整理、漏れている観点の追加）では、次のことが分かった。

- 図の構文の誤り、相対リンクの切れ、ADR の番号の重複を、変更のたびにその場の手作業で確かめた。確かめ方が作業ごとに違い、漏れうる。
- ADR の一覧（`decisions/README.md`）は「各 ADR から生成する。生成と差分の検査は rebuilds の CI（これから用意する）で行う」としているが、CI がなく、手で直している。
- 公開する HTML に GA のタグと favicon を入れる規則、ADR の見出しの長さ、「ステートマシン」の表記などは、機械で確かめられるのに確かめていない。

ADR-0005 が禁じたのは、題材の製品の実装を rebuilds に置くことである。文書そのものを検査する道具は、題材の製品の一部ではない。また、[ADR-0008](0008-primers-on-github-pages.md) の資料の CSS・JS（`docs/primer/assets/`）は、すでに rebuilds に置いている。

## Options

1. **文書の検査の道具と、それを動かす CI を rebuilds に置く。** 題材の製品のコードは引き続き置かない。
2. **検査の道具を別のリポジトリに置き、rebuilds の CI から呼ぶ。**
3. **道具を置かず、今のまま文章の規則とレビューで守る。**

## Decision

1 を採用する。

- 置いてよいのは、rebuilds の文書（Markdown と公開する HTML）を検査・生成する道具と、その CI の設定に限る。置き場所は `scripts/`（道具）、`.github/workflows/`（CI）、`package.json`（依存）にする。
- 題材の製品のコード（API、ワーカー、IaC、題材の CI）は、ADR-0005 のとおり開発リポジトリに置く。
- 検査は 1 つのコマンド（`npm run check`）で、ローカルと CI が同じものを動かす。エージェントの作業の終わりと、PR の CI で動かす。
- 初めの検査の対象：
  - Mermaid の図の構文
  - Markdown の相対リンク
  - ADR の番号の重複と、見出しの長さ（[process.md](../process.md) の 9 節。この規則より後の日付の ADR だけ）
  - ADR の一覧と各 ADR の frontmatter・見出しとの一致（`npm run adr-index` で生成し直す）
  - 公開する HTML の GA のタグ・favicon・`og:site_name`
  - 表記の規則のうち機械で判定できるもの（「ステートマシン」と書き、「状態機械」と書かない）
- 2 は、道具と規則が別のリポジトリに分かれ、規則を変えるたびに 2 つのリポジトリを揃える手間が増える。2026-10-11 の時点で、rebuilds 以外のリポジトリはまだない。
- 3 は、Context に書いた手作業と漏れが続く。

## Consequences

- 良くなること：
  - 図・リンク・ADR の一覧の壊れが、マージの前に止まる。
  - エージェントへの指示に、検査の手順を毎回書かなくてよくなる。
- 引き受けるコスト：
  - rebuilds に Node.js の依存（Mermaid、Puppeteer）が入る。Puppeteer は Chromium を取得する。
  - 検査の道具そのものの保守が要る。

## Confirmation

- `scripts/` の道具が、rebuilds の文書以外（題材の製品の振る舞い）を扱っていないかをレビューで確かめる。
- CI の `docs-check` が、`main` への push と PR のたびに動き、失敗が残っていない。

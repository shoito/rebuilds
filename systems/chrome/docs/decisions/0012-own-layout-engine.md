---
status: accepted
date: 2026-09-26
---

# ADR-0012: レイアウトは自作し、不変のフラグメントの木を出力する

## Context

[ADR-0002](0002-engine-build-vs-reuse.md) で、レイアウトは自作する側に置いた。ただし、Rust には使える部品がある。

- Servo のレイアウト（layout 2020）：MPL-2.0。Servo の DOM と描画に強く結びついている。
- Taffy：ブロック・Flexbox・Grid のアルゴリズム。MIT。Servo・Blitz・Bevy などが使う。テキスト（インライン）のレイアウトは持たない（[DioxusLabs/taffy](https://github.com/DioxusLabs/taffy)）。

レイアウトの形は、インクリメンタルな更新と、描画・当たり判定・a11y の設計を決める。本家の LayoutNG は、レイアウトの出力を不変のフラグメントの木にして、再利用と正しさを両立させた（[RenderingNG data structures](https://developer.chrome.com/docs/chromium/renderingng-data-structures)）。

## Options

1. **自作する。出力は不変のフラグメントの木。Grid のアルゴリズムだけ Taffy を下で使う**
2. **すべて自作する（Grid を含む）**
3. **Taffy を中心にし、インラインだけを自作する**
4. **Servo のレイアウトを取り込む**

## Decision

1 を採用する。

- 箱の木の構築、ブロック、インライン、float、位置指定、Flexbox、表、置換要素、縦書き、断片化の土台を自作する。範囲は [rendering.md](../architecture/rendering.md) の 5.2 節。
- 出力は不変のフラグメントの木（`Arc` で共有）。箱ごとに前回の制約と結果を持ち、変わらなければ再利用する。
- 最初から論理的な方向（inline / block）で書き、縦書きを後付けにしない。
- Grid は、Taffy のグリッドのアルゴリズムを、自作の箱の木の下で使う。Taffy の trait（子の大きさを測る関数）を、自作のレイアウトで実装する。Servo も Grid に Taffy を使っている。
- 2 を採らない理由：Grid は仕様が大きく、MVP の範囲で自作すると他の領域の作業を圧迫する。Taffy の外側の境界を 1 つに保てば、後から自作に替えられる。
- 3 を採らない理由：ブラウザのレイアウトの難しさは、インラインとブロックの混在、float、マージンの相殺、断片化にある。Taffy はこれらを持たず、中心に置くと、この部分を Taffy の形に合わせて作ることになる。
- 4 を採らない理由：Servo の DOM・スタイルの持ち方・描画（WebRender の表示リスト）に結びついており、切り出す作業が自作と同程度に大きい。設計の中心（インクリメンタル、フラグメント）を他のエンジンに委ねることにもなる。

## Consequences

> 2026-09-27 の注記：Taffy（0.14.0、2026-08-24）は Block・Flexbox・CSS Grid を実装し、float は機能のフラグの裏にある。WPT の結果は公開していない。テストは、本家の描画から期待値を作る独自の形式である（[DioxusLabs/taffy](https://github.com/DioxusLabs/taffy)、2026-09-27 に確認）。下の「WPT の `css/css-grid` の合格率」は、E2 で自分たちで流して確かめる。

- 良くなること：
  - インクリメンタルなレイアウトと、描画・当たり判定・a11y との境界を、自分たちの設計で決められる。
  - 不変のフラグメントで、再利用と並行の読み取り（合成・a11y）が安全になる。
- 悪くなること、引き受けるコスト：
  - レイアウトの互換性の長い尾（表、float、インライン）を自分たちで追う。最大の作業量の領域になる（[README.md](../architecture/README.md) の 6 節のリスク）。
  - **未検証**：Taffy のグリッドが、WPT の `css/css-grid` の対象でどこまで合格するか。E2 で流し、合格率が 90% に届かず上流で直せない場合は、Grid も自作に替える（この ADR を更新する）。
  - Taffy の版の追従（MIT、改変は上流に送る）。

## Confirmation

- WPT の `css/CSS2`、`css/css-flexbox`、`css/css-grid`、`css/css-writing-modes`、`css/css-tables` の対象の合格率を CI で追う（NFR-007）。
- レイアウトの結果（フラグメントの木）を、インクリメンタルと全体の再計算で比べる差分テストを、ランダムな DOM の変更で回す（性質ベーステスト）。
- `taffy` を import してよいのは Grid のモジュールだけであることを lint で検査する。

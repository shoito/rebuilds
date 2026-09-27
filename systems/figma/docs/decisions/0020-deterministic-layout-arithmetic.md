---
status: accepted
date: 2026-09-27
---

# ADR-0020: レイアウトとテキストの測定は f64 の四則と min・max だけで、順序を固定して計算する。標準の超越関数・FMA・並列を使わない。結果を変える変更は ADR を要する

## Context

[ADR-0019](0019-auto-layout-engine-and-layout-persistence.md) で、レイアウトの結果を全員が手元で計算し、保存された `derived_layout` との食い違いをビットで比べて修復すると決めた。Render Worker は、インスタンスの中身をネイティブで計算する。したがって、同じ入力から、ブラウザ（WASM。Chrome・Edge・Firefox・Safari）とネイティブ（x86-64 の Linux）で、ビットまで同じ結果が要る。

事実：

- IEEE 754 は、四則・平方根・比較の結果を、丸めの方式を決めれば一意に定める。WASM の浮動小数点の命令も、NaN のビットの形を除いて決定的である（WebAssembly の仕様）。
- 三角関数・指数・べき乗は IEEE 754 で丸めが決まっていない。Rust の標準の `f64::sin` などは、ネイティブではプラットフォームの libm（Linux なら glibc）、`wasm32-unknown-unknown` ではコンパイラに含まれる移植版を呼ぶため、結果がずれうる（**未検証**。E2 の `layout-crate-skeleton` の一致の CI で差を確かめる）。
- FMA（`mul_add`）は、丸めが 1 回になり、`a * b + c` と結果が違う。Rust は勝手に FMA へまとめない。WASM の relaxed SIMD は、FMA かどうかを実装に任せる。
- ドキュメントの値は f32 で持つ（[document-model.md](../architecture/document-model.md) の 4.3 節）。整形（HarfRust）は UnitsPerEm の整数を返す（[ADR-0015](0015-text-shaping-and-glyph-rendering.md)）。

## Options

1. **f64 の四則と min・max だけ。順序を固定。超越関数は純 Rust の `libm` を明示して呼ぶ**
2. f32 で計算する（document-model の 9.2 節の「f32 の演算の順を固定する」）
3. 固定小数点（例：1/65536 px の整数）で計算する
4. 決定性を求めず、許容の差で比べる

## Decision

1 を採用する。

- **型**：計算の中は f64。入力の f32 は f64 に広げ（誤差なし）、出力で f32 に丸める。
- **演算**：`+`・`-`・`*`・`/`・`min`・`max`・`abs`・比較だけ。
  - 回転した子の境界の箱は、行列の成分の絶対値で求め、三角関数を使わない。
  - どうしても超越関数が要るときは、`libm` の crate を明示して呼ぶ（どのターゲットでも同じ実装になる）。
- **禁止**（`layout`・`text` の測定・`doc-model` の検証の crate で、lint にする）：`f64::sin` などの標準の超越関数、`mul_add`、relaxed SIMD の機能、`rayon` などの並列、`HashMap`・`HashSet` の走査の順への依存。
- **順序**：子は `OrderKey` の順、和は左から右。ノードの集合は `NodeId` の順に並べてから処理する。増分の計算と一からの計算で、同じ式を同じ順で当てる。
- **テキスト**：HarfRust の整数の結果に、f64 で `大きさ / UnitsPerEm` を掛ける。整形の部品（HarfRust、Skrifa、ICU4X のデータ）の版を固定する。
- **版の変更**：
  - 参照ファイルのレイアウトの結果（全ノードの `derived_layout` のダンプ）を CI で比べ、1 ビットでも変われば落とす。
  - 結果を変える変更（計算の規則、整形の部品の版の上げ）は、ADR を書き、既存のファイルへの影響（修復の件数）を見積もってから出す。新しい振る舞いは、なるべく新しいプロパティの値として足し、既存のファイルの結果を変えない。
  - レイアウトの版を `schema_hash` に含め、クライアントとサーバーの食い違いを接続時に弾く（document-model の 8.4 節）。
- 2 を採らない理由：f32 でも四則なら決定的だが、hug の入れ子の和と fill の配分で誤差が積もり、1 px の数分の 1 のずれが目に見える位置に出る。f64 の計算で f32 に丸める方が、本家の値（未検証）とも比べやすい。保存する値は document-model のとおり f32 のまま。
- 3 を採らない理由：整形の結果の拡大・縮小、比（`scale` の制約、fill の等分）で丸めの規則を自分で決める必要があり、実装と確認の費用が大きい。f64 の四則で決定性は足りる。
- 4 を採らない理由：修復（ADR-0019）が「違えば直す」なので、許容の差を入れると、修復の判定がクライアントごとに揺れる。

## Consequences

- 良くなること：
  - WASM とネイティブ、ブラウザの違いで、レイアウトの結果がビットまで一致する。修復の判定と、Worker の書き出しが画面と合う。
- 引き受けるコスト：
  - 三角関数を避ける書き方と、`libm` の明示の呼び出しを守る必要がある。lint で守る。
  - 整形の部品の版を自由に上げられない。上げるたびに参照ファイルの比較と ADR が要る。
  - レイアウトの計算を並列にできない。

## Confirmation

- 性質ベーステスト：任意の木と入力で、WASM（Chromium・Firefox・WebKit の headless）とネイティブの `derived_layout` の f32 のビットが一致する（PROP-LAYOUT-001）。任意の文字列とフォントで、整形の結果が一致する（ADR-0015 の Confirmation）。
- CI：参照ファイルのレイアウトのダンプの比較。標準の `f64::sin` と `libm` の `sin` の、WASM とネイティブでの差を記録する（事実の確認）。
- lint：禁止の一覧を `clippy` の `disallowed-methods`・`disallowed-types` で検査する。

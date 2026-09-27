---
status: accepted
date: 2026-09-27
---

# ADR-0001: 基盤は他の題材を引き継ぎ、エンジンとマルチプレイヤーのサーバーは Rust で書く

## Context

rebuilds の他の題材（Slack・Stripe・Notion など）は、次の基盤を使う。

- AWS 東京（大阪を DR）、ECS Fargate、Aurora PostgreSQL 18、ElastiCache（Valkey）、SQS、S3、CloudFront
- TypeScript（Hono＋Zod）、Terraform、OpenTelemetry

Figma には、他の題材にない条件が 2 つある。

- **ブラウザの中の描画エンジン**：数万〜数十万のノードを 60fps で描き、ヒットテストとレイアウトを 1 フレームの中で行う。JavaScript の GC による停止を避けたい。
- **ファイルごとのマルチプレイヤーのサーバー**：1 つのファイルをメモリに持ち、大きなファイルの直列化でも他のファイルを止めない。

本家は、エンジンを C++ で書き、Emscripten で asm.js、のちに WASM にした（[Building a professional design tool on the web](https://www.figma.com/blog/building-a-professional-design-tool-on-the-web/)、2015-12-07。[Figma is powered by WebAssembly](https://www.figma.com/blog/webassembly-cut-figmas-load-time-by-3x/)、2017-06-08。WASM で読み込みが 3 倍以上速くなった）。同じ C++ をネイティブにもビルドし、サーバーでの描画とテストに使う（[Figma rendering: Powered by WebGPU](https://www.figma.com/blog/figma-rendering-powered-by-webgpu/)、2025-09-18）。マルチプレイヤーのサーバーは、TypeScript で書いたものの性能の重い部分を Rust に書き直し、ネットワークは Node.js、ファイルごとの処理は Rust の子プロセスにした（[Rust in production at Figma](https://www.figma.com/blog/rust-in-production-at-figma/)、2018-05-02。直列化が 10 倍以上速くなり、遅延の急増がほぼ消えた）。いずれも 2026-09-27 に確認。

## Options

1. **エンジンとマルチプレイヤーは Rust、それ以外は他の題材と同じ TypeScript と AWS**
2. **エンジンは C++（本家と同じ）と Emscripten、マルチプレイヤーは Rust**
3. **エンジンも TypeScript（Canvas・WebGL を直接呼ぶ）**
4. **題材ごとに一から選び直す**

## Decision

1 を採用する。

- **実行基盤・API・Worker・IaC・可観測性は、Slack の ADR-0007・0011・0020・0021 と同じにする。** 題材をまたいで、エージェントと人が同じ道具で検証できる。
- **エンジンは Rust で書き、`wasm32-unknown-unknown` で WASM にする。** ドキュメントのモデル（`doc-model`）・レイアウト・描画を crate に分ける。
- **マルチプレイヤーの Gateway と Document Server も Rust（tokio）で書く。** 本家の「Node.js＋Rust の子プロセス」の 2 層にはしない。Rust の非同期が本家の書き直しの頃（2018 年）より成熟し、プロセスの間の中継が要らなくなるため。
- **`doc-model` の crate を、ブラウザ（WASM）と Document Server（ネイティブ）と Worker の描画（ネイティブ）で共有する。** 変更の適用・検証の規則を 1 つのコードに置き、クライアントとサーバーで結果が食い違わないようにする。
- **UI の殻（パネル、ファイルの一覧、コメント）は TypeScript と React で書く。** キャンバスの描画だけをエンジンに任せる。エンジンとの境界は、型付きのメッセージ（Rust の型から TypeScript の型を生成する）にする。
- 2 を採らない理由：
  - 本家と同じ C++ は、実績と既存のライブラリ（Skia、HarfBuzz）で勝る。
  - ただし、メモリ安全でない言語で、利用者のファイル（信頼できない入力）を解析するコードを持つことになる。rebuilds の Chrome の題材も、同じ理由で Rust を選んだ（[Chrome の ADR-0001](../../../chrome/docs/decisions/0001-languages-and-platform.md)）。
  - Rust は、WASM への出力（`wasm-bindgen`）と、WebGPU・WebGL2 の両方を扱えるライブラリ（wgpu）を持つ。
  - C++ の Emscripten も成熟しているが、ビルドの仕組み（CMake と Emscripten の設定）は、エージェントにとって Cargo より扱いにくい。
- 3 を採らない理由：本家が 2015 年の時点で避けた問題（GC の停止、文字の描画の差、GPU の保証がない）が残る（上の 2015 年の記事）。大きなファイルで NFR-005 を守れない。
- 4 は、題材の比較という rebuilds の目的に反する。

## Consequences

- 良くなること：
  - 変更の適用の規則を、クライアントとサーバーで 1 つのコードにできる。
  - 信頼できない入力（ファイル、SVG、画像、フォント）を解析するコードが、メモリ安全になる。
  - 運用・CI・セキュリティの仕組みは、他の題材のものを使い回せる。
- 引き受けるコスト：
  - 言語が 2 つ（Rust と TypeScript）になる。境界の型は生成し、手で書き写さない。
  - Rust のビルドの時間と、WASM のバイナリの大きさ。バイナリは圧縮後 5 MB 以内を目安にし、CI で計測する（[delivery.md](../architecture/delivery.md) の 3.3 節、[ADR-0054](0054-wasm-native-parity-and-bundle-budgets.md)）。
  - 本家が使う C++ の資産（Skia など）は、そのままでは使えない。テキストの整形・ラスタライズは Rust のライブラリを使う（[ADR-0004](0004-gpu-rendering-in-wasm.md)、[ADR-0015](0015-text-shaping-and-glyph-rendering.md)）。
  - `unsafe` は、WASM と JavaScript の境界、GPU のバッファの扱いなど、要る箇所に限り、1 か所ずつレビューする。

## Confirmation

- CI：`doc-model` の同じテストを、ネイティブと WASM の両方で走らせ、結果が一致することを確かめる。
- 性質ベーステスト：任意の変更の列で、WASM とネイティブの適用の結果（直列化したバイト列）が一致する。
- lint：`unsafe` を含む変更は、コードオーナーのレビューを必須にする。

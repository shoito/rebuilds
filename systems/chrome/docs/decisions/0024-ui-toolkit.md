---
status: accepted
date: 2026-09-26
---

# ADR-0024: 枠の UI は Rust の自前の UI 層で描き、内部ページはエンジンで描く

## Context

ブラウザの UI（ウィンドウ、タブの帯、アドレスバー、ダイアログ、設定などの内部ページ）を、何で作るかを決める。UI は、起動の速さ（NFR-001）、入力の応答、3 OS のアクセシビリティ、日本語の入力、Browser プロセスの安全に直結する。

確かめたこと（2026-09-26）：

- 本家 Chrome は、枠の UI を自前の UI ツールキット（Views）で描き、内部ページ（`chrome://`）を WebUI（エンジンで描く HTML）で作る。macOS も、以前の Cocoa の UI から Views へ移った（[Chromium の glossary](https://chromium.googlesource.com/chromium/src/+/main/docs/ui/learn/glossary.md)、[MacViews Release Plan](https://chromium.googlesource.com/chromium/src/+/0e94f26e8/docs/ui/views/macviews_release.md)）。
- Firefox は、枠の UI を自分のエンジンで描く HTML・CSS・JavaScript で作り、親プロセスで動かす。
- AccessKit（Rust、Apache-2.0/MIT）は、UIA（Windows）・NSAccessibility（macOS）・AT-SPI（Linux）への橋を持つ（[AccessKit](https://github.com/AccessKit/accesskit)）。
- 本家は Windows で UIA を Chrome 126 から段階的に有効にし、MSAA・IA2 も支え続けている（[Introducing UIA support on Windows](https://developer.chrome.com/blog/windows-uia-support)）。

## Options

1. **枠の UI は Rust の自前の UI 層（本家の Views にあたる）で描き、内部ページは自分のエンジンで描く**（本家と同じ 2 層）
2. **OS ごとのネイティブの UI**（Windows は Win32/WinUI、macOS は AppKit、Linux は GTK）
3. **既存の Rust のクロスプラットフォームの UI（Slint、iced、egui など）で枠の UI を作る**
4. **枠の UI も含めて、すべてを自分のエンジンで描く Web の技術で作る**（Firefox の形）

## Decision

1 を採用する。詳細は [browser-ui.md](../architecture/browser-ui.md)。

- 枠の UI（タブの帯、ツールバー、アドレスバー、候補、ダイアログ、吹き出し）は、Browser プロセスの中の Rust のコードだけで描く。描画は、Web のコンテンツと同じく GPU プロセスの合成器に合成フレームとして渡す（[ADR-0013](0013-skia-raster-and-own-compositor.md)）。文字は Web のコンテンツと同じ文字の部品（HarfBuzz など）で描く。
- 内部ページ（設定、履歴、ダウンロード、ブックマーク、拡張機能、新しいタブ）は、自分のエンジンで描き、Web のページと別の専用の Renderer に隔離する。Browser への要求は、ページごとの許可リストで検査する。
- アクセシビリティは、枠の UI と Web のコンテンツの木を Browser プロセスでつなぎ、AccessKit で OS へ出す。Windows は MVP で UIA だけを出す（IA2 は browser-ui.md の 8.1 節の確認の結果で決める）。
- ウィンドウ・IME・メニューバー・ドラッグは、OS ごとの薄い層で書く。
- 2 を採らない理由：同じ UI を 3 回作ることになり、見た目と振る舞いが OS ごとにずれる。枠の独自の描画（タイトルバーのタブ）と、Web のコンテンツとの合成を、OS のツールキットごとに作り込む必要がある。
- 3 を採らない理由：タブのドラッグでのウィンドウの切り離し、タイトルバーへの描き込み、日本語の IME の細かな制御、GPU の合成器との統合、ブラウザの規模の性能の予算を、外部のツールキットの設計に合わせることになる。ブラウザの UI での本番の実績も無い。ウィジェットの設計の参考にはする。
- 4 を採らない理由：最も権限の高い Browser プロセスで JavaScript を動かすことになり、攻撃面が大きい（別のプロセスに出すと、キー入力のたびに IPC を往復する）。起動と枠の UI が、成熟に時間のかかるエンジン（[ADR-0002](0002-engine-build-vs-reuse.md) の自作の部分）の正しさと速さに左右され、E1 の walking skeleton が遅れる。

> 2026-09-27 の注記：上の「文字の部品（HarfBuzz など）」は、[rendering.md](../architecture/rendering.md) の 11 節の HarfRust（シェーピング）と Skrifa（フォントの解析・輪郭）と読む。HarfRust は HarfBuzz の組織が保守する Rust の移植で、最新は 0.13.3（2026-08-25）。HarfBuzz v14.3.1 に揃え、README では「よく使うフォントで HarfBuzz より 25% 未満の遅さ」としている（[harfbuzz/harfrust](https://github.com/harfbuzz/harfrust)、[crates.io](https://crates.io/crates/harfrust)）。制約は 3 つある。フォントの大きさを持たない（UnitsPerEm で返す）。不正なフォントは代わりのシェーパーで処理せず、エラーにする。Graphite に対応しない。本家は HarfRust を試したが、設定したフォントの関数（メトリクス）を呼ばない点が障害になった（[harfbuzz#5994](https://github.com/harfbuzz/harfbuzz/issues/5994)、2026-05 に閉じた）。本家が出荷したことは確かめられなかった。採用は変えず、E1 の PoC で速度とメトリクスの呼び出しを確かめる。合わなければ HarfBuzz（C++）に替える（rendering.md の 11 節）。
>
> 2026-09-27 の注記：AccessKit（0.25.1、2026-09-25）の出力先は、UIA、NSAccessibility、AT-SPI、Android、iOS である。IAccessible2 の実装はない（[AccessKit](https://github.com/AccessKit/accesskit)）。README では、リッチテキストとハイパーテキストに未対応としている。このため、下の「IA2 を出さない」リスクは、AccessKit の上では避けられない。IA2 が要ると E6 で分かったら、IA2 の橋を自前で書く。

## Consequences

- 良くなること：
  - 枠の UI はエンジンの成熟を待たずに作れ、起動の予算（枠の最初の描画 p75 500 ms）を守りやすい。
  - Browser プロセスでスクリプトを動かさない。
  - 内部ページは Web の技術で速く作れ、自分のエンジンを日々使うことで、互換性の不具合を早く見つけられる。
  - 本家と同じ分け方なので、UI の設計（ショートカット、アクセシビリティの木のつなぎ方）に本家の知見を使える。
- 悪くなること、引き受けるコスト：
  - テキストの編集、メニュー、スクロール、ドラッグなどのウィジェットを自作する量が大きい。
  - 枠の UI と内部ページで、見た目の部品（色、間隔、アイコン）を 2 つの形で持つ。共通のデザインの値（トークン）から両方を生成する。
  - Windows で IA2 を出さないと、NVDA・JAWS での Web の閲覧が本家より劣るおそれがある（**未検証**。E6 の初めに主要な支援技術で確かめる）。
  - AccessKit の成熟度（大きな木、頻繁な更新での性能）に依存する（**未検証**。E6 で、タブ 20 枚・大きな DOM で測る）。

## Confirmation

- Browser プロセスが JavaScript の実行環境（V8 の Isolate）を作らないことを、起動時の検査とテストで確かめる。
- 内部ページの Renderer が Web のページと同じプロセスに載らないこと、許可リストにない要求が拒まれることを、セキュリティのテストで確かめる。
- UI の性能の予算（[browser-ui.md](../architecture/browser-ui.md) の 10 節）を、CI の性能のテストで検査する。
- 3 OS の支援技術（ナレーター・NVDA・JAWS、VoiceOver、Orca）での操作の確認を、リリースの前の確認項目に入れる。

---
status: accepted
date: 2026-09-26
---

# ADR-0013: raster は Skia で行い、合成は自作する（Renderer の合成スレッドと GPU プロセスの表示の合成）

## Context

[ADR-0002](0002-engine-build-vs-reuse.md) は、描画の部品を「WebRender か Skia」とした。描画の部品は、合成の形（スレッド、プロセス、層）と、Canvas 2D の実装を決める。

確かめたこと（2026-09-26）：

- 本家は、Renderer の main スレッドで表示リストを作り、合成スレッドで層に分けてスクロール・アニメーションを進め、GPU プロセス（viz）で raster・合わせ・描画を行う（[RenderingNG architecture](https://developer.chrome.com/docs/chromium/renderingng-architecture)）。raster は Skia。Apple Silicon の Mac では Skia Graphite を出荷している（[Introducing Skia Graphite](https://blog.chromium.org/2025/07/introducing-skia-graphite-chromes.html)）。
- `skia-safe`（rust-skia、MIT）は、Ganesh と Graphite、Vulkan・Metal・OpenGL・Direct3D のバックエンドを持ち、3 OS の事前ビルドがある（[rust-skia](https://github.com/rust-skia/rust-skia)）。
- WebRender は MPL-2.0、上流は mozilla-central の `gfx/wr`、GitHub は下流の写しで、crates.io にも出ている（[servo/webrender](https://github.com/servo/webrender)）。シーンの全体（表示リスト）を受け取って GPU で描く方式で、Canvas 2D の即時の描画の API は持たない。

## Options

1. **Skia で raster し、合成（層、タイル、スクロール、表示の合成）は自作する**（本家と同じ形）
2. **WebRender に表示リストを渡し、合成と描画を任せる**（Firefox・Servo の形）。Canvas 2D は別に Skia を使う
3. **Vello（GPU の計算シェーダーによる 2D の描画）**

## Decision

1 を採用する。

- Renderer：main スレッドで自前の表示リストと属性の木を作り、合成スレッドへコミットする。合成スレッドが、層に分け、タイルに分け、スクロールと合成のアニメーションを進める。
- GPU プロセス：表示リストを検証して Skia の命令に変え、タイルを raster する。各 Renderer と Browser の UI の合成フレームを合わせ、描いて画面に出す（詳細は [rendering.md](../architecture/rendering.md) の 7・8 節）。
- バックエンド：macOS は Graphite（Metal）、Windows は Ganesh（ANGLE 経由で D3D11）、Linux は Ganesh（GL / Vulkan）、すべてで CPU の raster を予備に持つ。
- 表示リストは自前の Rust の型にし、Skia の型を含めない。raster の部品を替える余地と、プロセスの境界での検証を保つ。
- 2 を採らない理由：
  - 合成とスクロールの形（どこを層にするか、main スレッドを待たないスクロール、クロスプロセスの iframe の合わせ方）が WebRender の設計に委ねられ、本家の RenderingNG の知見（指標、段の分け方）がそのまま使えない。
  - Canvas 2D のために Skia も持つことになり、2 つの描画の部品と、2 つの文字の描画の経路を保守することになる。
  - 上流は Firefox の中にあり、Firefox 以外の組み込みの要望は優先されにくい。
- 3 を採らない理由：GPU の計算シェーダーの対応が端末によって揺れ、ブラウザの規模での本番の実績がまだない。予備の CPU の描画の経路も別に要る。

## Consequences

- 良くなること：
  - ページの raster、Canvas 2D、表示の合成の描画、文字の描画を、1 つの部品（Skia）で賄う。本家と同じ描画の結果（アンチエイリアス、文字）に近づく。
  - 本家の RenderingNG と段・スレッドの形が揃い、性能の問題の切り分けに本家の知見を使える。
- 悪くなること、引き受けるコスト：
  - 合成（層の分け方、タイル、スクロール、表示の合成、surface）を自作する。大きな作業で、E3 の中心になる。
  - Skia・ANGLE は C++ の大きな攻撃面。GPU プロセスに閉じ込め、Renderer からの表示リストを検証し、デシリアライザをファズにかける。
  - Skia と ANGLE の脆弱性の修正に追従する（[update-and-release.md](../architecture/update-and-release.md)）。
  - **未検証**：`skia-safe` の Graphite のバインディングが本番に足りるか、ANGLE と組み合わせたビルドの手間。E1 で 3 OS の最小の経路（表示リスト → タイル → 画面）を組んで確かめる。

## Confirmation

- Renderer のプロセスが Skia と GPU のドライバをリンクしていないことを、ビルドの依存の検査で確かめる（Canvas 2D の記録は Skia の型を使わない）。
- 表示リストのデシリアライザを常時ファズにかける。
- 画像の比較のテスト（WPT の reftest、自前の描画のテスト）を、GPU と CPU の raster の両方で CI で流す。
- MotionMark 1.3 と、スクロールのチェッカーボードの割合を、リリースごとに測る。

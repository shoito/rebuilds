---
status: accepted
date: 2026-09-27
---

# ADR-0014: 1 つのビルドに WebGPU と WebGL2 を入れ、WebGPU で始めて、失敗したらキャンバスを作り直して WebGL2 に移る。サーバーは lavapipe の上の wgpu で同じコードを動かす

## Context

[ADR-0004](0004-gpu-rendering-in-wasm.md) で、WebGL2 を必須、WebGPU を使えるときに使い、GPU の抽象の下に wgpu を置くと決めた。wgpu の 1 つのビルドで実行時に切り替えられるかは未検証とし、できなければ 2 つのビルドを配ると書いた。この ADR は、その選び方と切り替え方を決める。

事実（2026-09-27 に確認）：

- 本家は WebGPU で始め、互換性のテストはセッションの開始の後に、読み込みを止めない形で走らせる（起動の前のテストは読み込みを数百 ms 遅らせるため）。互換性のテストの失敗や WebGPU のエラーで、セッションの途中でも WebGL に戻る。仕組みは WebGL のコンテキストの喪失の扱いと同じで、作り直す先のバックエンドを替える。Windows で、途中の `requestAdapter`・`requestDevice` の失敗があった。戻る率の平均が高い端末をブロックリストに入れた。ネイティブのアプリは Dawn を使う（[Figma rendering: Powered by WebGPU](https://www.figma.com/blog/figma-rendering-powered-by-webgpu/)、2025-09-18）。
- wgpu の「WebGPU と WebGL の両方を有効にしたとき、WebGL に戻らない」不具合（[gfx-rs/wgpu#6166](https://github.com/gfx-rs/wgpu/issues/6166)）は閉じられた。2024-10-15 に、WebGPU の対応を確かめてから `Instance` を作る `wgpu::util::new_instance_with_webgpu_detection` が入った（[gfx-rs/wgpu#6371](https://github.com/gfx-rs/wgpu/pull/6371)）。文書は、WebGPU を狙い、使えなければ WebGL に戻るときはこの関数を使うよう勧める。WebGPU の対応は `Instance` を作るときに決まる（[docs.rs](https://docs.rs/wgpu/latest/wgpu/util/fn.new_instance_with_webgpu_detection.html)、wgpu 30.0.1）。
- ブラウザの WebGPU の対応：Chrome 113（Linux は 144 から、Intel Gen12 以降）、Safari 26、Firefox 141 は Windows、145〜147 で Apple silicon の macOS。Firefox は Intel の macOS と Linux に未対応（MDN の browser-compat-data の `api/GPU.json`）。
- HTML の規則で、一度 `webgpu` のコンテキストを取ったキャンバスから、`webgl2` のコンテキストは取れない。
- Fargate には GPU がない。

## Options

1. **1 つのビルドに両方を入れ、実行時に選ぶ。途中の切り替えはキャンバスと GPU の資源を作り直す**
2. WebGL2 のビルドと WebGPU のビルドを分けて配り、読み込み時に選ぶ。途中の切り替えは再読み込み
3. WebGL2 だけ（WebGPU は後で）

起動の順：

- a. **WebGPU を試して始め、互換性のテストは起動の後**（本家と同じ）
- b. WebGL2 で始め、WebGPU は起動の後に確かめて移る

サーバー：

- x. **wgpu の Vulkan のバックエンドを、Mesa の lavapipe（CPU の Vulkan）で動かす**
- y. サーバーだけ CPU のラスタライザ（Vello CPU など）を使う

## Decision

1、a、x を採用する。

### 選び方

- `wgpu` を `webgpu` と `webgl` の両方の機能で 1 つのビルドにする。
- 起動時：
  1. サーバーから配るブロックリストに今の端末（`GPUAdapterInfo` の vendor・architecture・description と、ブラウザの版）が載っていれば WebGL2。
  2. 前のセッションで WebGL2 に戻っていれば（`localStorage` の記録、7 日で失効）WebGL2。
  3. それ以外は `new_instance_with_webgpu_detection` で WebGPU を試し、アダプターかデバイスを得られなければ WebGL2。
- 起動の後、アイドルの時間に互換性のテストを走らせる：参照の小さな場面（パスの被覆率、ブレンド、ぼかし、テキスト）を描き、読み戻して、既知の画素と比べる。読み戻しで起動を止めない。
- ADR-0004 の「起動は WebGL2 で速く始め、WebGPU は起動の後に確かめる（本家と同じ）」は、本家の記事と合わない（本家は WebGPU で始め、互換性のテストを後に回す）。この ADR の a で置き換える。

### 切り替え

- 移るきっかけ：`device.lost`、検証のエラー（`uncapturederror`）が 1 分に 3 回、互換性のテストの失敗。
- 移り方：
  1. 新しい `<canvas>` を作り、古いものと差し替える。その間は最後のフレームの画像を見せる。
  2. `Backends::GL` だけの新しい `Instance` を作り、パイプライン、タイル、画像のテクスチャ、グリフのアトラスを作り直す。
  3. 画像は Cache Storage の圧縮したバイト列から、デコードし直して載せる。
- ドキュメントのモデルと未確定の変更は GPU に関係しないので、失われない。
- WebGL2 のコンテキストの喪失は、同じ手順で WebGL2 を作り直す。5 分に 3 回を超えたら、描画を止めて再読み込みを案内する。
- 目標：きっかけから操作の再開まで 2 秒以内。

### ブロックリスト

- 端末の組ごとに「WebGPU で始めたセッションのうち WebGL2 に戻った割合」を集め、7 日で 1% を超え、かつ 100 セッション以上ある組をブロックリストに足す。
- ブロックリストはフィーチャーフラグの仕組み（delivery の領域）で配り、リリースなしで変えられる。

### サーバー

- 同じ crate をネイティブ（`x86_64-unknown-linux-gnu`）にビルドし、wgpu の Vulkan のバックエンドを lavapipe で動かす。シェーダーはブラウザと同じ WGSL。
- 本家はネイティブに Dawn を使うが、wgpu はネイティブの実装を含むので、別の実装は持たない。

### 2 つのビルドへの退路

- E2 の前の PoC で、次のどれかが成り立たなければ 2 を採る（この ADR を改訂する）。
  - キャンバスを作り直しての切り替えが、主要なブラウザで 2 秒以内に終わる。
  - 両方を入れた WASM が、圧縮後 5 MB（ADR-0001）に収まる。
  - WebGL2 の経路の性能が、WebGL2 だけのビルドより 10% 以上遅くならない。

### 採らない理由

- 2 を採らない理由：途中の切り替えが再読み込みになり、編集の途中で画面が止まる。配布とテストの組み合わせが 2 倍になる。ただし、上の退路として残す。
- 3 を採らない理由：WebGPU の compute shader・MSAA・RenderBundle の最適化を後から足す道を閉じる。本家は WebGPU で一部の端末の性能が上がり、後退はなかった。
- b を採らない理由：WebGPU を使える端末で、毎回 WebGL2 から移る手間（作り直しの一瞬の止まり）が生じる。前のセッションの記録とブロックリストで、失敗しやすい端末は始めから WebGL2 にできる。
- y を採らない理由：画面とサーバーで別のラスタライザになり、書き出しが画面と一致しなくなる（ADR-0004 の目的に反する）。

## Consequences

- 良くなること：
  - 1 つのビルドで、WebGPU を使える端末では WebGPU、それ以外では WebGL2 で動く。
  - 途中の失敗でも、再読み込みなしで描画が戻る。
  - 画面・サムネイル・書き出しが、同じシェーダーで描かれる。
- 引き受けるコスト：
  - WASM に両方のバックエンドと、WGSL を GLSL に変える naga が入り、大きくなる。
  - GPU の資源をすべて作り直せるよう、元のデータ（画像の圧縮したバイト列）を CPU の側に残す。
  - lavapipe は遅い。書き出しの時間は E10 の前に計測する。
  - lavapipe の Vulkan の適合の版と、arm64 での動作は未検証。S1 は x86-64 に固定する。

## Confirmation

- PoC（E2 の前）：Chrome・Edge・Safari・Firefox（Windows）で、WebGPU で始め、`device.destroy()` で喪失を起こして、2 秒以内に WebGL2 で描画が戻る。WASM の大きさと WebGL2 の経路の性能を測る。
- E2E：WebGPU の喪失と WebGL2 のコンテキストの喪失（`WEBGL_lose_context`）を起こし、描画が戻り、未確定の変更が失われない。
- 参照画像のテスト：WebGPU・WebGL2・ネイティブ（lavapipe）の 3 つで、同じ判定の値に収まる。
- lint：エンジンの crate で `web-sys` の WebGL・WebGPU の型を使わない（ADR-0004）。

---
status: accepted
date: 2026-09-26
---

# ADR-0010: V8 を rusty_v8 で組み込み、DOM を cppgc のヒープに置いて V8 と一緒に追跡する

## Context

[ADR-0002](0002-engine-build-vs-reuse.md) で、JavaScript エンジンに V8 を使い、DOM は Rust で自作すると決めた。このとき、次の 2 つを決める必要がある。

- V8 を Rust からどう呼ぶか。
- DOM のノード（Rust）と JavaScript のオブジェクト（V8 のヒープ）の間の参照を、どう回収するか。

DOM と JavaScript の間には循環が普通にある（ノード → イベントのリスナー → クロージャ → ノードのラッパー → ノード）。2 つのヒープを別々に回収すると、この循環を回収できず、メモリが漏れる（NFR-004）。Blink は DOM を Oilpan に置き、V8 と 1 つのヒープとして追跡している。Oilpan は cppgc として V8 に移され、V8 を組み込む誰もが使えるようになった（[High-performance garbage collection for C++](https://v8.dev/blog/high-performance-cpp-gc)）。

## Options

1. **rusty_v8 の `v8` クレートを使い、DOM を cppgc のヒープに置く**（Blink と同じ統合したヒープ）
2. **DOM を Rust の所有（`Rc` や arena）で持ち、ラッパーから `Global` のハンドルで指す**。循環は自前の循環回収器（Gecko の cycle collector のようなもの）で回収する
3. **DOM を Rust の所有で持ち、ラッパーとの参照を弱くする**（循環は回収しない。リスナーなどを文書の寿命に結ぶ）
4. **`deno_core` の上に作る**

## Decision

1 を採用する。

- V8 は `v8` クレート（rusty_v8、Deno が保守、MIT）で呼ぶ（[denoland/rusty_v8](https://github.com/denoland/rusty_v8)）。本家 Chrome のメジャーの版に合わせて 4 週ごとに版が上がり、ADR-0004 のリリースの周期と合う。
- ビルドは `V8_FROM_SOURCE=1` で、自分たちの GN の引数から作る。V8 のサンドボックスとポインタの圧縮を有効にし、V8 の修正を自分たちで当てられるようにする。
- DOM のノードは `v8::cppgc` の `GarbageCollected` とし、ノードどうしの参照は `Member` / `WeakMember`、ラッパーとの対応は `Object::wrap` / `unwrap` で持つ（[docs.rs v8::cppgc](https://docs.rs/v8/latest/v8/cppgc/index.html)。v8 152.2.0 で公開を確認）。
- GC のヒープの外（スタイル・レイアウト・描画・a11y）は、ノードを世代つきの `NodeId` で指し、ポインタを持たない（[rendering.md](../architecture/rendering.md) の 3.2 節）。
- Isolate は Renderer の main スレッドに 1 つ、コンテキストはフレーム × world ごと、Worker は Isolate を 1 つずつ（[javascript-and-web-apis.md](../architecture/javascript-and-web-apis.md) の 1.2 節）。
- 2 を採らない理由：2 つの GC（V8 と自前の循環回収器）の協調は、Gecko が長年かけて作ったもので、正しさの検証が難しい。漏れと、回収済みのオブジェクトへのアクセスの両方を生みやすい。
- 3 を採らない理由：仕様の上で生き続けるべきオブジェクト（切り離されたノードへの参照を JavaScript が持つ場合）を正しく扱えず、互換性と漏れの両方で問題になる。
- 4 を採らない理由：deno_core はサーバーのランタイムの形（1 つのコンテキスト、Deno のイベントループと op）に合わせてあり、HTML のイベントループと、1 つの Isolate に複数のコンテキストを持つブラウザの形に合わない。

## Consequences

- 良くなること：
  - JavaScript と DOM の循環を、V8 の GC が 1 回で回収する。Blink で実績のある方式。
  - V8 の並行マーキング・背景の掃除（sweep）を DOM にも使える。
- 悪くなること、引き受けるコスト：
  - DOM の Rust のコードは、所有権ではなく GC の参照（`Member`）で書く。借用の検査で守られる範囲が狭くなり、`GarbageCollected` の実装（`trace`）の漏れは、回収済みのメモリへのアクセスになる。`trace` は手で書かず、derive マクロで生成する。
  - cppgc のバインディングは rusty_v8 の中で比較的新しい。足りない API を上流に送る作業が要る。
  - スタイル（Stylo）の並列の走査と、GC の並行マーキングを両立させる規則（`style_data` に GC の参照を置かない、走査中に sweep を始めない）を守る必要がある。
  - **未検証**：Rust の cppgc で作った DOM の速度とメモリ（ノードの作成・挿入・削除、GC の停止の時間）。E1 でマイクロベンチマークを作り、本家と比べる。本家の 2 倍を超えて遅ければ、ノードの形とバインディングを見直す。

## Confirmation

- `GarbageCollected` を実装する型は、derive マクロでしか `trace` を実装できないことを lint で検査する。
- DOM の型のフィールドに `Rc`・`Arc`・生のポインタで DOM を指すものがないことを lint で検査する（`NodeId` を使う）。
- GC のストレステスト（割り当てごとに GC を強制する V8 のフラグ）で、DOM のテストと WPT の `dom/` を CI で流す。AddressSanitizer のビルドでも流す。
- 循環（ノード ↔ リスナー ↔ クロージャ）を作って捨てるテストで、メモリが回収されることを確かめる。

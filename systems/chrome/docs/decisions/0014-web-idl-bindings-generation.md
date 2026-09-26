---
status: accepted
date: 2026-09-26
---

# ADR-0014: Web API のバインディングは、Web IDL から Rust のコードを生成する

## Context

Web API は数百のインターフェイスと数千のメンバーを持つ。JavaScript からの呼び出しは、Web IDL の変換の規則（数値の丸め、辞書、union、Promise、例外）に従う必要があり、手で書くと、規則の違反と実装の漏れが大量に出る。Blink・Gecko・WebKit・Servo は、いずれも IDL からバインディングを生成している（例：[Firefox の Web IDL bindings](https://firefox-source-docs.mozilla.org/dom/webIdlBindings/index.html)）。

決めることは、IDL の出どころ、生成器、生成するコードの形である。[ADR-0010](0010-v8-embedding-and-dom-gc.md) で、V8 は rusty_v8 で呼び、DOM は cppgc に置くと決めた。

確かめたこと（2026-09-26）：

- w3c/webref は、仕様から IDL を 6 時間ごとに抽出し、検証済みの版を `@webref/idl` として出している。MIT（[w3c/webref](https://github.com/w3c/webref)）。
- weedle2 は、Rust の Web IDL の解析器（weedle のフォーク）で、uniffi が保守している（[weedle2](https://crates.io/crates/weedle2)）。

## Options

1. **`@webref/idl` を取り込み、Rust で書いた生成器（weedle2 で解析）で、V8 のテンプレートと実装の trait を生成する**
2. **バインディングを手で書く**（Rust のマクロで補助する）
3. **Servo の生成器（Python、SpiderMonkey 向け）を V8 向けに改造する**
4. **deno_core の `op2` マクロで、Rust の関数を 1 つずつ JavaScript に見せる**

## Decision

1 を採用する。

- IDL は `@webref/idl` の版を固定して取り込む。仕様の IDL は編集しない。自分たちの拡張属性は別のファイルに `partial` として書く。
- 実装の対応表で、どのインターフェイス・メンバーを実装するかを決める。未実装のメンバーは生成しない。
- 生成するのは、インターフェイスごとのテンプレートの組み立て、引数と戻り値の変換、例外の変換、そして **実装の trait**。DOM の型が trait を実装しないとコンパイルが通らない。
- 生成器は Rust で書き、ビルドの時に動かす。生成したコードは手で編集しない。
- 対応する拡張属性の一覧と型の変換は [javascript-and-web-apis.md](../architecture/javascript-and-web-apis.md) の 3 節。
- 2 を採らない理由：変換の規則の違反が API ごとにばらばらに出て、WPT の `idlharness` で大量に落ちる。エージェントが書く量も最大になる。
- 3 を採らない理由：SpiderMonkey の API と Servo の DOM の前提が深く入っており、V8 と cppgc 向けに書き直す量が、新しく書く量と変わらない。Python の生成器を Rust のビルドに持ち込むことにもなる。
- 4 を採らない理由：`op2` は Rust の関数を速く呼ぶ仕組みで、Web IDL の型の変換、インターフェイスの継承、`[Exposed]` などの意味を持たない。高速な呼び出しの実装の参考にはする。

## Consequences

> 2026-09-27 の注記：weedle2 の最新は 5.0.0（2024-01-24）で、その後は更新されていない。`async iterable<T>`・`async iterable<K, V>` は解析できるが、`ObservableArray` は解析できない（[mozilla/uniffi-rs](https://github.com/mozilla/uniffi-rs) の weedle2、2026-09-27 に確認）。`ObservableArray` は `adoptedStyleSheets` などで使われるので、そのままでは足りない。上流の保守も止まっているため、E1 で weedle2 をフォークして足りない構文を加えるか、解析器を自作する（生成器の中の閉じた部分なので、替えやすい）。どちらにするかは、E1 で `@webref/idl` の全体を解析し、失敗する定義を数えて決める。

- 良くなること：
  - 型の変換と例外が、すべての API で仕様どおりに揃う。変換の誤りは生成器の 1 か所で直る。
  - 仕様の IDL の変更が、`@webref/idl` の更新の PR として見える。
  - エージェントは「対応表に加える → コンパイラのエラーに従って trait を実装する」という決まった手順で API を足せる。
- 悪くなること、引き受けるコスト：
  - 生成器そのものを作り、保守する。E1 の最初の大きな作業になる。
  - **未検証**：weedle2 が、現在の Web IDL の構文（async iterable、`ObservableArray` など）をすべて解析できるか。E1 で `@webref/idl` の全体を解析し、失敗する定義を数える。足りなければ weedle2 に追加を送るか、解析器を自作する（生成器の中の閉じた部分なので、替えやすい）。
  - 性能は生成器の出来に依存する。Speedometer 3（NFR-003）の遅い箇所は、生成器の側で直す。

## Confirmation

> 2026-09-27 の注記：WPT のディレクトリの名前は `webidl/`（小文字）である（[web-platform-tests/wpt](https://github.com/web-platform-tests/wpt/tree/master/webidl)、2026-09-27 に確認）。下の `WebIDL/` は `webidl/` と読む。

- 生成したファイルが、生成器の出力と一致することを CI で検査する（手での編集を検出する）。
- WPT の `WebIDL/` と、各 API の `idlharness` のテストを CI で流す。
- `@webref/idl` の更新の PR で、対応表の差分（新しいメンバー、変わったシグネチャ）を自動でまとめて示す。

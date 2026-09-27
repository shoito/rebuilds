---
status: accepted
date: 2026-09-27
---

# ADR-0016: エンジンと React は同じメインスレッドで動かし、生成した型のコマンドと、フレームに 1 回の話題ごとのスナップショットでやり取りする

## Context

[ADR-0001](0001-platform-and-stack.md) で、UI の殻（パネル、ファイルの一覧、コメント）は TypeScript と React、キャンバスの描画はエンジン（Rust → WASM）に任せ、境界は Rust の型から生成した型付きのメッセージにすると決めた。この ADR は、どのスレッドで動かし、何をどの頻度でやり取りするかを決める。

満たすべきこと：

- 自分の入力は 1 フレーム（16.7ms）で画面に出る（NFR-002）。
- 10 万ノードのファイルで、パン・ズームが 60fps（NFR-005）。レイヤーのパネルも 10 万ノードを扱う。
- キャンバスの上のテキストで、IME の入力を受ける（[ADR-0017](0017-text-input-via-hidden-textarea.md)。`textarea` は DOM にあり、メインスレッドで動く）。

事情：

- WebGPU と WebGL2 は、`OffscreenCanvas` を通して Web Worker でも使える。ただし入力のイベント（pointer、key、IME）はメインスレッドにしか来ない。
- 本家のエンジンがどのスレッドで動くかは、公開されていない（未検証）。
- React の再描画は、選択やプロパティが毎フレーム変わるドラッグの間に重くなりうる。

## Options

スレッド：

1. **エンジンと React を同じメインスレッドで動かす。重い仕事（画像のデコード、見ていないページの復号）だけ Web Worker**
2. エンジンを Web Worker（`OffscreenCanvas`）で動かし、入力をメインスレッドから転送する

やり取り：

- a. **殻 → エンジンは生成した型のコマンドの同期の呼び出し。エンジン → 殻は、フレームに 1 回、変わった話題の版を上げ、殻が必要な分だけ読む**
- b. エンジンが変更のたびにイベントを発行し、殻が自分の状態（Redux など）に写す
- c. 殻もドキュメントのモデル（JS の写し）を持つ

## Decision

1 と a を採用する。

- エンジンは `<canvas>` を持ち、キャンバスの上の pointer・wheel のイベントを直接受ける（React を通さない）。入力は列に積み、`requestAnimationFrame` の最初にまとめて処理する。
- 殻 → エンジン：`Command`（`SetTool`、`SetProps`、`RunAction`、`SelectNodes`、`LayerRowsRequest`、`Undo`、`Paste` など）。型は Rust で定義し、TypeScript の型を生成する。値はコンパクトな二値で渡す。
- エンジン → 殻：描画の後、フレームに 1 回、変わった話題（`selection`、`selection_props`、`layer_rows`、`tool`、`viewport`、`text_edit`、`status`）の版を上げる。殻は `useSyncExternalStore` で話題ごとに購読し、版が上がった部品だけ再描画する。
- レイヤーのパネルは仮想化し、見える範囲の行だけをエンジンに求める。
- 殻はドキュメントのモデルを持たない。
- 予算：React の再描画は 1 フレームで 3 ms 以内。超える部品は、話題を細かく分けるか、次のフレームに回す。
- 見直しの条件：E4 の計測で、React の再描画が 3 ms を超えるフレームが 5% を超え、分割で直らないとき、2 を別の ADR で検討する。
- 2 を採らない理由：
  - 入力の転送で 1 回のスレッドの切り替えが入り、ヒットテストの結果（カーソルの形、ホバーの枠）が非同期になる。
  - IME の `textarea` の位置と、エンジンのテキストのカーソルの位置を、スレッドをまたいで合わせる必要がある。
  - `OffscreenCanvas` の WebGL2 は Chrome 69・Firefox 105・Safari 17 から、WebGPU は Chrome 144（113 から一部の OS）・Safari 26 から、Firefox は 141 から Windows だけ（MDN の browser-compat-data の `api/OffscreenCanvas.json`、2026-09-27 に確認）。古い Safari と Firefox の一部の OS では Worker の中で WebGPU を使えず、バックエンドの選び方（[ADR-0014](0014-gpu-backend-selection-and-fallback.md)）がメインスレッドと Worker で分かれる。
- b を採らない理由：ドラッグの間、変更のたびにイベントが出て、React の状態の更新が 1 フレームに何度も起きる。
- c を採らない理由：10 万ノードのモデルを JS にも持つと、メモリ（NFR-004）が倍になり、2 つのモデルの食い違いが起きる。

## Consequences

- 良くなること：
  - 入力から描画までが 1 つのスレッドの 1 フレームで閉じ、NFR-002 を守りやすい。
  - React はスナップショットを描くだけになり、ドキュメントの規則を持たない。
- 引き受けるコスト：
  - React の再描画とエンジンが、同じフレームの時間を分け合う。重いパネルは予算を守る工夫が要る。
  - エンジンの panic（WASM の trap）は、同じタブの UI も巻き込む。hook で記録して再読み込みする。

## Confirmation

- 性能：入力から描画までの p95 を、10 万ノードの参照ファイルで、CI（GPU 付きの VM）と RUM で測る。React の再描画の時間をフレームごとに記録する。
- lint：殻のコードから、WASM のメモリを直接読むコードを禁止する（生成した境界の関数だけを使う）。
- 型の生成：Rust の型を変えたら、TypeScript の型が生成し直されていないと CI が落ちる。

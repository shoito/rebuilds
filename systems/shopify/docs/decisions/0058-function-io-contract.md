---
status: accepted
date: 2026-10-10
---

# ADR-0058: 関数の入出力は UTF-8 の JSON。入力は関数ごとの入力のクエリ（チェックアウトの入力のスキーマへの GraphQL の部分集合）の結果、出力は種類ごとの JSON スキーマ。モジュールの輸入は `<brand>_io` の 3 つ（`input_read`、`output_write`、`log`）と、標準入出力の道具のための `fd_read(0)`・`fd_write(1, 2)`・`proc_exit` だけ。`checkout` と `function-runner` は UNIX ドメインソケットの上で、長さを先に置いた枠（頭の JSON ＋本体）でやり取りする

## Context

[ADR-0008](0008-extension-sandbox-wasm.md) は、関数の輸入を殻の 3 つの関数（入力を読む、出力を書く、ログを書く）と `fd_read(0)`・`fd_write(1, 2)` だけにし、入出力を JSON とし、入力のクエリ（3,000 バイト・費用 30）を持つと決めた。決めることは次である。

- 入出力の符号化と、金額の表し方。
- 殻の関数の正確な形（引数、返り値、上限の超過の知らせ方）。
- `checkout`（TypeScript）と `function-runner`（Rust）の間の約束。
- 本家は入力 128 kB・出力 20 kB・入力のクエリ 3,000 バイト・費用 30（[Shopify Functions](https://shopify.dev/docs/api/functions)、2026-10-10 に確認）。符号化の細部は確かめていない（未検証）。

## Options

符号化：

1. **UTF-8 の JSON。金額は 10 進の文字列**
2. 二進の形（MessagePack など）
3. WebAssembly のコンポーネントのモデル（WIT の型）

## Decision

1 を採用する。詳細は [functions-sandbox.md](../architecture/functions-sandbox.md) の 4〜7 節。

- 入力は入力のクエリの結果の JSON。保護のデータの未承認の項目は `null`。金額は 10 進の文字列。
- 出力は種類ごとの JSON スキーマで、`checkout` が検証する（`function-runner` は中身を解釈しない）。
- 輸出：`run`、`memory`（160 ページ以下）。輸入：`<brand>_io.input_read(ptr, cap) -> i32`（全長を返す。足りなければ写さない）、`output_write(ptr, len) -> i32`（上限の超過で -1）、`log(ptr, len)`（1 KiB まで）、WASI の `fd_read(0)`・`fd_write(1, 2)`・`proc_exit`。他は公開の時に拒む。
- 使える機能：MVP の命令、bulk memory、multi-value、sign-ext、nontrapping float-to-int、reference types、決定的な SIMD。threads・relaxed SIMD・memory64・例外の処理は拒む。
- 枠：4 バイトの長さ＋頭の JSON（呼び出しの ID、関数、モジュールのハッシュ、上限）＋本体。応答の `status` は `ok`・`fuel_exhausted`・`memory_exceeded`・`trap`・`output_too_large`・`input_too_large`・`module_unavailable`・`host_error`。

### 他の案を選ばなかった理由

- **2（二進）**：速さの利点は、入力 128 KiB の規模では JSON の構文解析の数百 µs ほどと見込む。開発者のデバッグと試験のベクトルの読みやすさを優先する。`wasm-function-poc` で JSON の構文解析が燃料の大半を使うと分かれば、新しい API のバージョンで足す。
- **3（コンポーネントのモデル）**：WASI の実装の一部（リソース、非同期）を持ち込み、輸入を最小にする方針と合わない。言語の道具の対応にばらつきがある。

## Consequences

- 良くなること：開発者が入出力を目で読め、どの言語でも書ける。ホストが出力を解釈しないので、ホストの攻撃面が小さい。
- 引き受けるコスト：JSON の構文解析の燃料を関数が払う（上限の値は PoC で見直す）。

## Confirmation

- 契約の試験：枠の形の試験のベクトル、殻の関数の境界（`cap` の不足、出力の超過、ログの切り）。
- 脱出の試験：殻にない輸入・禁止の機能を持つモジュールが公開の時に拒まれる（[quality.md](../quality.md) の 2.2.1 節 F）。
- 性質ベーステスト PROP-FN-004（入力の範囲）。

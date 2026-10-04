---
status: accepted
date: 2026-09-27
---

# ADR-0024: 共通のコア（Rust）は IO を持たない状態機械と鍵管理にし、TypeScript の状態機械とは同じ試験のベクトルで揃える

## Context

[ADR-0003](0003-client-platform.md) は、共通のコアの範囲をシグナリングの状態機械と E2EE の鍵管理（MLS）にし、Web（TypeScript）とネイティブ（Rust）の 2 つの状態機械を、同じ試験のベクトルで揃えると決めた。コアの形と、ベクトルの形式・作り方・CI での扱いを決める必要がある。

- シグナリングは `(epoch, seq)` 付きのスナップショットと差分で状態を配り、再接続の時に `resume` で差分を求める（[ADR-0008](0008-signaling-protocol.md)）。この規則の実装の違いは、同じ会議でアプリだけ状態がずれる形で現れる。
- OpenMLS は RFC 9420 の Rust の実装で、WebAssembly に対応し、MIT。最新は 0.9.0（2026-08-25）（[openmls](https://github.com/openmls/openmls)、[crates.io](https://crates.io/crates/openmls)、2026-09-27 に確認）。
- UniFFI は、Rust から Swift・Kotlin の束縛を作る（[mozilla/uniffi-rs](https://github.com/mozilla/uniffi-rs)、0.32.2、2026-09-27 に確認）。

## Options

1. **コアは IO を持たない純粋な状態機械と鍵管理。Web は状態機械を TypeScript で持ち、鍵管理は Rust を WASM で使う。2 つの状態機械は、試験のベクトルを CI で両方に通して揃える**
2. **Web も状態機械を Rust（WASM）にし、状態機械を 1 つにする**
3. **ネイティブも状態機械を TypeScript で書き、JavaScript の実行環境を埋め込む**

## Decision

1 を採用する。

- コアの crate：`core-signaling`（状態機械）、`core-e2ee`（OpenMLS と SFrame）、`core-ffi`（UniFFI）、`core-wasm`（`wasm-bindgen`）。
- 状態機械は「状態＋入力 → 新しい状態＋出力」の純粋な関数にする。WebSocket、時計、乱数は外から入れる。
- Web は、状態機械を TypeScript で持つ。鍵管理は `core-wasm` を `e2ee` のワーカーで使い、暗号の実装を Web とネイティブで 1 つにする。
- 試験のベクトル：
  - シグナリングのスキーマ（`@<brand>/signaling-schema`）と同じリポジトリに、JSON で置く。1 本は `initial`・`steps`（入力の列）・`expect`（出力の列と、最後の状態の要約）を持つ。
  - 手で書くもの（再同期と障害の表の各行）と、TypeScript 版を基準に fast-check で生成したものの 2 種類。夜間に生成し、差が出たものを固定のベクトルに加える。
  - スキーマのリポジトリの PR で、TypeScript 版と Rust 版の両方に全ベクトルを通す。1 本でも違えばマージしない。
  - 状態は、決めた項目の要約で比べ、実装の中の補助の状態は比べない。
- E2EE は、RFC 9605 と MLS の公開の試験のベクトルを `core-e2ee` に通す（[e2ee.md](../architecture/e2ee.md)）。
- 2 は、状態機械が 1 つになるが、React の UI との間で WASM の境界を 1 メッセージごとに越え、Web のデバッグがしにくくなる。ベクトルの食い違いが続くなら見直す。
- 3 は、モバイルに JavaScript の実行環境を埋め込み、電池とメモリの費用と、OS の審査の制約を受ける。

## Consequences

- 良くなること：
  - Web の開発の速さを保ちながら、ネイティブとの食い違いを CI で見つけられる。
  - 暗号の実装は 1 つで、監査と試験の対象が 1 か所になる。
- 引き受けるコスト：
  - 状態機械を 2 回書く。仕様の変更ごとに、両方を直す。
  - ベクトルの形式（入力・出力・状態の要約）そのものを保守する。
  - OpenMLS は 1.0 前で、バージョンを上げるときに API が変わりうる。

## Confirmation

- CI：スキーマのリポジトリの PR で、全ベクトルが TypeScript 版と Rust 版で同じ出力になる。
- 性質ベーステスト（夜間）：生成した 1 万本の入力の列で、2 つのバージョンの出力が一致する。一致しない列は固定のベクトルに加える。
- 本番の監視：再同期（スナップショットの取り直し）の回数を、クライアントの種類ごとに比べ、差が 2 倍を超えたら調べる。

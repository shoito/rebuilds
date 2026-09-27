---
status: accepted
date: 2026-09-27
---

# ADR-0008: バンドルは ES モジュール・CommonJS・Wasm・データだけにし、互換の日付とフラグは上流の表をそのまま使う

詳細は [runtime-and-isolates.md](../architecture/runtime-and-isolates.md) の 7 節と 8 節。

## Context

利用者のコードをどの形で受け、ランタイムの版が上がっても振る舞いをどう保つかを決める。

本家（2026-09-27 に確認）：

- 実行時のコードの生成（`eval()`、`new Function`、`WebAssembly.compile`、バッファからの `WebAssembly.instantiate`、`compileStreaming`、`instantiateStreaming`）を許さない（[Web standards](https://developers.cloudflare.com/workers/runtime-apis/web-standards/)）。
- 大きさは圧縮前 64MiB、圧縮後の上限なし。トップレベルは 1 秒以内（[Limits](https://developers.cloudflare.com/workers/platform/limits/)）。2025-09 の時点では、圧縮後が有料 10MB・無料 3MB だった（[Eliminating Cold Starts 2](https://blog.cloudflare.com/eliminating-cold-starts-2-shard-and-conquer/)）。
- 古い互換の日付を永久に支える。API で日付を省くと 2021-11-02 になる（[Compatibility dates](https://developers.cloudflare.com/workers/configuration/compatibility-dates/)）。
- フラグは、既定で有効になる日付を持つ。2026-08-04 以降の日付では Node.js の互換が既定で有効になる（[Compatibility flags](https://developers.cloudflare.com/workers/configuration/compatibility-flags/)）。
- workerd の設定は、モジュールの種類として `esModule`・`wasm` などを持ち、`compatibilityDate` を必須にする（[workerd.capnp](https://github.com/cloudflare/workerd/blob/main/src/workerd/server/workerd.capnp)）。

## Options

1. **上流の互換の表をそのまま使い、バンドルは上流が持つモジュールの種類の一部に絞る**
2. **自前の互換の版（例：`<brand>` の API の版）を別に定義する**
3. **互換の日付を持たず、常に最新の振る舞いにする**

## Decision

1 を採用する。

- 受け付けるモジュールは `esm`・`cjs`・`wasm`・`text`・`data`・`json`。Python とサービスワーカーの形は受け付けない。
- 実行時のコードの生成を禁じる（本家と同じ）。実行されるコードは、すべてアップロード時に内容のハッシュで固定する。
- 上限（既定案。値は limits-and-billing の領域で確定する）：圧縮後 無料 3MiB・有料 10MiB、圧縮前 無料 32MiB・有料 64MiB、モジュール 1,000、トップレベルの CPU 時間 1 秒。
- アップロード時の検証（形・ハッシュ・大きさ・日付・フラグ・構文・`import` の解決・Wasm の検証・トップレベルの実行）は、別のアカウントの検証のフリートで行う。制御プレーンのプロセスで利用者のコードを動かさない。
- 互換の日付とフラグは、上流の表の名前・日付・意味を変えずに使う。自分たちのフラグが要るときだけ `<brand>_` の接頭辞で足す（S1 で 0 個が目標）。
- 日付がないデプロイは拒否する（本家の既定の 2021-11-02 にしない）。2021-11-02 より前と、フリートの最も古いランタイムの版が支える最大の日付より後も拒否する。実験のフラグは本番で拒否する。
- 古い日付を永久に支える。セキュリティのために変えるときは事前に連絡し、ADR に残す。
- 2 を採らない理由：本家の文書と上流のテストを、そのまま使えなくなる。本家からの移行の利用者の負担が増える。
- 3 を採らない理由：ランタイムの版の更新（週 1 回）のたびに、デプロイ済みの関数が壊れうる（intent の守るべき振る舞いに反する）。

## Consequences

- 良くなること：
  - 本家の互換の文書と上流のテストを、そのまま使える。
  - 実行されるコードがすべてハッシュで固定され、検査・再現ができる。
- 引き受けるコスト：
  - 上流が互換の日付の意味を決める。上流の判断に従う。
  - 圧縮後の上限は本家（上限なし）より厳しい。本家からの移行で、大きなバンドルが入らないことがある。
  - 検証のフリートを別のアカウントに持つ費用。

## Confirmation

- アップロードの結合テスト：日付なし・範囲外・実験のフラグ・大きさの超過・`eval` を含むコード（実行時に例外）・トップレベル 1 秒超の各場合。
- 毎週の取り込みで、本番の上位 20 の互換の日付の合成の関数の応答が変わらない。
- 自分たちのフラグの名前が上流と重ならないことを、CI で確かめる。

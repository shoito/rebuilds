---
status: accepted
date: 2026-09-27
---

# ADR-0015: Node.js の互換は上流の組み込みの範囲に従い、TCP と DNS に依る接続は MVP でエラーにする

詳細は [web-apis-and-compat.md](../architecture/web-apis-and-compat.md) の 6 節。

## Context

npm のパッケージの多くは Node.js の API に依る。intent は Node.js の全 API の互換を目標にせず、「上流の workerd が持つ範囲に従う」とした（Non-goals）。一方で、TCP のソケット（`connect()`）は MVP の外である。

本家（[Node.js compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)、[Compatibility flags](https://developers.cloudflare.com/workers/configuration/compatibility-flags/)、[fs](https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/)、[net](https://developers.cloudflare.com/workers/runtime-apis/nodejs/net/)、すべて 2026-09-27 に確認）：

- ランタイムの組み込み（多くは完全、一部は部分的）と、CLI が unenv で足す polyfill（呼ぶと例外か何もしない）の 2 つの形。
- 2026-08-04 以降の互換の日付で、`nodejs_compat`・`nodejs_compat_v2` が既定で有効。
- `node:fs` はメモリの仮想のファイルシステム（`/bundle`・`/tmp`・`/dev`）。
- `node:net` は TCP のソケットの `connect()` を使う。
- `node:child_process`・`node:worker_threads` などは、読み込めるが動かない空の実装。

## Options

1. **上流の組み込みの範囲と日付に従い、polyfill は CLI が足す。MVP の外の経路（TCP、DNS）は理由の分かるエラーにする**
2. **ランタイムに polyfill を同梱する**
3. **Node.js の互換を持たない**（Web API だけ）

## Decision

1 を採用する。

- 上流の組み込みを、互換の日付・フラグの意味を変えずに使う（[ADR-0008](0008-bundle-format-and-compatibility-dates.md)）。
- polyfill は CLI（developer-tooling の領域）がバンドルに足す。ランタイムには足さない。
- `node:net`・`node:tls` の接続と `node:dns` の問い合わせは、理由の分かるエラーにする。網の約束は、外向きのプロキシが TCP のソケットの要求を受け付けないことで守る（モジュールの有無に頼らない）。
- `node:fs` の `/tmp` は isolate のメモリに数える。寿命は要求ごと（上流は `/tmp` の中身を要求の文脈 `IoContext` ごとに持ち、文脈が終わると消す。[worker-fs.h](https://github.com/cloudflare/workerd/blob/main/src/workerd/io/worker-fs.h)、2026-09-27 に確認）。
- `node:http`・`node:https` のクライアントは、`fetch` と同じ外向きのプロキシを通るので使える。
- 2 を採らない理由：ランタイムの差分が増える（[ADR-0006](0006-workerd-fork-and-upstream-tracking.md)）。polyfill の中身は利用者のバンドルに入るので、隔離の面でも CLI で足す方が境界がはっきりする。
- 3 を採らない理由：npm の多くのパッケージが動かず、intent の価値（標準のまま書ける・移行しやすい）を損なう。上流がすでに持つ実装を捨てる理由がない。

## Consequences

- 良くなること：
  - 本家と同じ範囲の npm のパッケージが動く（TCP・DNS を使うものを除く）。
  - 互換の範囲の説明に、本家の文書の構造をそのまま使える。
- 引き受けるコスト：
  - TCP・DNS を使うパッケージ（データベースのドライバーなど）は、MVP では動かない。本家より使えるものが少ない。
  - 上流の Node.js の互換の変更に追従する（毎週の取り込み）。

## Confirmation

- 結合テスト：`node:net` の接続、`node:dns` の問い合わせが理由の分かるエラー。`node:fs` の外が見えない（脱出のテスト）。
- 互換の試験：2026-08-03 と 2026-08-04 の日付で、Node.js の互換の既定が切り替わる。
- 毎週の取り込みで、新しい Node.js のモジュールが網に出られないことを、脱出のテストで確かめる。

---
status: accepted
date: 2026-09-27
---

# ADR-0037: プラグインのコードは QuickJS を WASM にした専用のインスタンスでメインスレッドに動かし、UI と通信は別のオリジンの null origin の iframe に置く

## Context

プラグイン（MVP の後）は、利用者が選んで動かす第三者の JavaScript である。利用者のタブの中で、利用者の権限でファイルを読み書きする。守りたいのは、同じタブの中の利用者のセッション（Cookie、トークン）、アプリのオリジンで呼べる内部の API、開いていない他のファイル、画面の応答である。

一方、プラグインはノードを大量に読み書きする。読み取りのたびに非同期の往復が入ると、遅く、書きにくい。

本家の経緯（いずれも 2026-09-27 に確認）：

- null origin の iframe で動かす案は、非同期の API が難しく、大きな文書の直列化に 14 秒かかった。Duktape を WASM にした解釈器は、遅く ES5 だけだった。Realms の shim でメインスレッドに置き、UI は iframe に分けた（[How to build a plugin system on the web and also sleep well at night](https://www.figma.com/blog/how-we-built-the-figma-plugin-system/)、2019-08-22）。
- Realms の shim に、内と外のオブジェクトを取り違える脆弱性が複数見つかり、QuickJS を WASM にしたものに替えた。表現が違いすぎて取り違えが起きない。一部のプラグインは遅くなった（[An update on plugin security](https://www.figma.com/blog/an-update-on-plugin-security/)、2019-10-02）。
- 今も、メインスレッドのサンドボックスで動き、ブラウザの API はない。UI と通信は iframe（[How Plugins Run](https://developers.figma.com/docs/plugins/how-plugins-run/)）。

`quickjs-emscripten` は、QuickJS の WASM のビルドで、ランタイムのメモリの上限・スタックの上限・割り込みの関数を持つ（[quickjs-emscripten](https://github.com/justjake/quickjs-emscripten)、2026-09-27 に確認）。

エッジのサーバーレス（本家の Cloudflare Workers など）は、多数のテナントのコードをサーバーで動かすため、V8 の isolate に、プロセスのサンドボックスなどの多層の防御を重ねる。プラグインは利用者の端末で、その利用者が選んだコードを動かすので、他のテナントとの分離ではなく、同じタブの中の分離が問題になる。

## Options

1. **QuickJS を WASM にした専用のインスタンスを、メインスレッドで動かす**（本家の今の形）
2. **Realms・ShadowRealm で、ブラウザの JavaScript のエンジンの中に別の realm を作る**
3. **null origin の iframe か Web Worker に全部を置き、文書は非同期のメッセージで読む**
4. **Web Worker の中の QuickJS（か素の Worker）から、`SharedArrayBuffer` と `Atomics.wait` で、メインスレッドの文書を同期で読む**

## Decision

1 を採用する。詳細は [plugins.md](../architecture/plugins.md) の 4 節と 6 節。

- **QuickJS の WASM のインスタンスを、プラグインの実行ごとに 1 つ作る。** エンジンの WASM とは別のモジュール・別のメモリにする。QuickJS の中のグローバルは `<brand>` と `console` だけで、DOM・`fetch`・タイマーを持たない。
- **ホストの関数（membrane）だけが外へ通じる。** ノードはハンドル（整数）で表し、値は写して渡す。ホストの JavaScript のオブジェクトを渡さない。membrane のコードは 1 か所に小さく置き、変更にコードオーナーのレビューと fuzzing を必須にする。
- **上限**：ヒープ 512 MiB、スタック 1 MiB、1 回の同期の実行は 10 秒で打ち切る（割り込みの関数）。
- **UI と通信は、別のオリジン `plugin-ui.<brand>usercontent.<domain>` の iframe**（`sandbox` に `allow-same-origin` を付けない）に置く。null origin なので、アプリのオリジンの Cookie・Storage に届かない。CSP は manifest の `allowedDomains` から作る。サンドボックスの `fetch` も、この iframe から送る。
- 2 を採らない理由：同じ JavaScript のエンジンの同じヒープの中の境界で、本家が実際に破られた種類の欠陥（オブジェクトの取り違え）が起きうる。ShadowRealm は TC39 の Stage 2.7 で、ブラウザの実装はない（[tc39/proposals](https://github.com/tc39/proposals)、MDN の browser-compat-data、2026-09-27 に確認）。
- 3 を採らない理由：本家が失敗した理由（非同期の API の書きにくさ、大きな文書の直列化の時間）がそのまま残る。エンジンが WASM の中に文書を持つので、別の realm へは全部を写すことになる。
- 4 を採らない理由：`SharedArrayBuffer` にはアプリ全体の cross-origin isolation（COOP・COEP）が要り、埋め込み・外部の資源の読み込みへの影響が大きい。読み取りのたびにスレッドをまたぐ往復が入る。画面を止めない利点はあるので、PoC の性能を見て、長い処理のための別の実行の形として再検討する。

## Consequences

- 良くなること：
  - QuickJS の欠陥は、WASM の線形メモリの中に閉じる。逃げるには、membrane の欠陥か、ブラウザの WASM の実装の欠陥が要る。
  - 文書をエンジンから同期で読めるので、API が書きやすく、速い。
  - UI の iframe が別のオリジンなので、プラグインの HTML がアプリのセッションに届かない。
- 引き受けるコスト：
  - 解釈器なので、ブラウザの JIT より遅い（本家も遅くなったと書く。程度は **未検証**。E14 の `quickjs-sandbox-poc` で計測する）。
  - メインスレッドで動くので、同期の実行の間は画面が止まる。10 秒の打ち切りと、`await` で区切る案内で抑える。
  - ブラウザの開発者の道具（デバッガー）が使えない。開発用のコンソールとエラーの位置の表示を自前で用意する。
  - QuickJS の WASM（quickjs-ng の同期の版で約 530 KB。圧縮の前。`@jitl/quickjs-ng-wasmfile-release-sync` 0.32.0 の `emscripten-module.wasm`、jsDelivr の一覧で 2026-09-27 に確認）を、プラグインを初めて動かすときに読む。
  - quickjs-ng は `Intl` を持たない（[quickjs-ng の ECMAScript Features](https://quickjs-ng.github.io/quickjs/es_features)、2026-09-27 に確認）。地域の書式を使うプラグインは、ホストの助けが要る（[plugins.md](../architecture/plugins.md) の 4.4 節）。

## Confirmation

- 脱出のテストの集まり（CI）：QuickJS の中から、`window`・`document`・`fetch`・Cookie・`localStorage`・エンジンのメモリ・ホストの関数の参照に届かない。
- fuzzing：membrane に任意の値（循環、巨大な配列、getter、`Proxy`）を渡しても、ホストが落ちず、上限を超えない。
- 結合テスト：UI の iframe から、アプリのオリジンの Cookie・Storage に届かず、`allowedDomains` の外への通信が CSP で止まる。
- 外部の侵入試験を、プラグインの公開の前に行う。

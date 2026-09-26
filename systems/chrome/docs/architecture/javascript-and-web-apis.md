# JavaScript and Web APIs: Chrome

Renderer に JavaScript エンジン（V8）を組み込み、Web API を JavaScript に見せる設計。V8 の組み込み方、HTML のイベントループ、Web IDL からのバインディングの生成、コンテキストの分離と origin の検査、MVP の Web API の範囲、開発者ツールのプロトコル（CDP）の基本を扱う。DOM・スタイル・描画は [rendering.md](rendering.md) にある。

前提として、次の決定に従う。

| 決定 | この領域への影響 |
| --- | --- |
| [ADR-0001](../decisions/0001-languages-and-platform.md) | V8 は Rust のバインディング（`v8` クレート）で包む。`unsafe` はバインディングの層に閉じる |
| [ADR-0002](../decisions/0002-engine-build-vs-reuse.md) | JavaScript エンジンは V8 を使う。バインディングと Web API は自作 |
| [ADR-0003](../decisions/0003-multi-process-site-isolation.md) | Renderer はサイトごと。Renderer の中の検査は多層防御で、最終の検査は Browser 側で行う |
| [ADR-0010](../decisions/0010-v8-embedding-and-dom-gc.md) | Isolate は Renderer の main スレッドに 1 つ。DOM は cppgc のヒープに置く |
| [ADR-0014](../decisions/0014-web-idl-bindings-generation.md) | バインディングは Web IDL から Rust のコードを生成する |

## 1. V8 の組み込み

### 1.1 部品

- Rust の `v8` クレート（rusty_v8。Deno が保守。MIT）を使う（[denoland/rusty_v8](https://github.com/denoland/rusty_v8)）。V8 の C++ の API を、呼び出しの追加の費用なしに Rust から使える。版は本家 Chrome のメジャーの版に合わせて、4 週ごとに上がる。
- ビルドは、配布されている静的ライブラリを使わず、`V8_FROM_SOURCE=1` で自分たちのビルドの設定（GN の引数）から作る。理由は 2 つ。
  - V8 のセキュリティの設定（V8 のサンドボックス、ポインタの圧縮、Control-flow integrity）を自分たちで決めるため。
  - V8 の脆弱性の修正を、rusty_v8 の版を待たずに当てられるようにするため（[update-and-release.md](update-and-release.md)）。
- **未検証**：rusty_v8 の既定のビルドで、V8 のサンドボックスとポインタの圧縮が有効か。自分たちの GN の引数で有効にしたとき、rusty_v8 と cppgc のバインディングが動くか。確かめ方：E1 で、両方を有効にしたビルドを 3 OS で作り、rusty_v8 のテストと自分たちの DOM のテストを通す。
- `deno_core`（Deno のランタイム）は使わない。モジュールの読み込み・イベントループ・op の仕組みが Deno の実行環境に合わせてあり、ブラウザのイベントループ（HTML の仕様）や、1 つの Isolate に複数のコンテキストを持つ形と合わない。cppgc のラッパーや高速な呼び出しの使い方は、deno_core の実装を参考にする。

### 1.2 Isolate とコンテキスト

V8 の Isolate は「自分のヒープを持つ VM」、コンテキストは「別々のグローバルを持つ実行の環境」（[Getting started with embedding V8](https://v8.dev/docs/embed)）。

| 単位 | 数 | 理由 |
| --- | --- | --- |
| Isolate | Renderer の main スレッドに 1 つ | 同じ Renderer のフレームは同じサイト（ADR-0003）。同じ origin のフレームは互いのオブジェクトを直接触れるので、同じヒープに置く必要がある |
| コンテキスト | フレーム × world ごとに 1 つ | ページの main world と、拡張機能の content script の isolated world（[extensions.md](extensions.md)）を分ける。DOM は共有し、JavaScript のオブジェクトとグローバルは分ける |
| Worker | Worker ごとに Isolate を 1 つ、専用のスレッド | Dedicated Worker・Shared Worker・Service Worker は main スレッドと並行に動く |

- 各コンテキストに、Web IDL のインターフェイスのテンプレート（`FunctionTemplate`）を Isolate ごとに 1 回作ってキャッシュし、コンテキストを作るたびにグローバルに入れる。
- 起動を速くするため、V8 のスナップショット（組み込みのオブジェクトと、自分たちのテンプレート）を使う。スナップショットにラッパーを含めるときの扱いは E3 で決める。

### 1.3 DOM との GC

- DOM のノードは cppgc のヒープに置き、JavaScript のラッパーとは `Object::wrap` で結ぶ。V8 の GC がラッパーとノードを 1 つのヒープとして辿るので、JavaScript → ノード → イベントのリスナー → JavaScript の循環も回収できる（[ADR-0010](../decisions/0010-v8-embedding-and-dom-gc.md)、[rendering.md](rendering.md) の 3 節）。
- ラッパーは遅延して作る。JavaScript がそのノードに初めて触れたときに作り、以後は同じラッパーを返す（`[SameObject]` と同一性）。
- ラッパーを GC に回収させてよいか（ノードは生きているが、ラッパーに独自のプロパティがない）は、V8 の「ラッパーの削除可能性」の仕組みに任せる。**未検証**：rusty_v8 がこの設定を公開しているか。公開していなければ、ラッパーはノードと同じ寿命にする（メモリは増えるが、正しさは保てる）。

### 1.4 マイクロタスク

- V8 のマイクロタスクのキューは、明示的な実行（`MicrotasksPolicy::Explicit`）にする。V8 に自動で実行させない。
- HTML の仕様の「マイクロタスクのチェックポイント」を、自分たちのイベントループが決めた場所で実行する（タスクの終わり、スクリプトの実行後の後始末、コールバックの呼び出しの後）。
- 1 つのエージェント（同じ Isolate の同じ origin のまとまり）で、マイクロタスクのキューは 1 つ。

## 2. イベントループとタスク

- HTML のイベントループを自作する（[HTML Standard: Event loops](https://html.spec.whatwg.org/multipage/webappapis.html#event-loops)）。
- タスクの源（task source）ごとにキューを持ち、優先度で選ぶ。

| 優先度 | タスク |
| --- | --- |
| 最高 | 入力（離散的な入力：クリック、キー） |
| 高 | レンダリングの更新（BeginFrame ごと） |
| 中 | ネットワークの応答、`postMessage`、タイマー |
| 低 | アイドルのコールバック（`requestIdleCallback`）、GC の補助 |

- 長いタスク（50ms 以上）を計測し、開発者ツールと指標に出す（[observability.md](observability.md)）。
- タイマー：入れ子が 5 段を超えた `setTimeout` は 4ms に丸める（仕様どおり）。背景のタブでは 1 秒に 1 回に抑え、長く背景にあるタブはさらに抑える（本家の振る舞いに合わせる）。
- 高精度の時刻（`performance.now()`）は、Spectre への対策として精度を落とす。cross-origin isolated でないページは 100µs、isolated のページは 5µs（本家と同じ値）。

## 3. バインディングの生成（Web IDL → Rust）

### 3.1 流れ

[ADR-0014](../decisions/0014-web-idl-bindings-generation.md) で決める。

```
@webref/idl（仕様から抽出・検証した IDL、MIT）  ─┐
自分たちの IDL（拡張属性、未公開の差分）        ─┼─▶ bindgen（Rust のツール、weedle2 で解析）
実装の対応表（どの Rust の型が実装するか）       ─┘           │
                                                             ▼
                              生成された Rust のコード
                              ├── インターフェイスごとのテンプレートの組み立て
                              ├── 引数の変換（Web IDL の型の変換の規則）
                              ├── 実装の trait（`HTMLElementImpl` など）
                              └── 例外の変換（DOMException、TypeError）
```

- IDL の出どころは w3c/webref の curated の IDL（`@webref/idl`）。仕様から 6 時間ごとに自動で抽出し、構文と参照の妥当性を検査した版（[w3c/webref](https://github.com/w3c/webref)）。版を固定してリポジトリに取り込み、更新は PR で行う。
- 仕様の IDL に手を入れない。実装していないメンバーは、対応表で「未実装」として扱い、生成しない（`in` 演算子で存在を検出するサイトの互換性のため、半端に置かない）。
- 生成するのは「実装の trait」。DOM の Rust の型が trait を実装しないとコンパイルが通らないので、実装の漏れがビルドで分かる。エージェントが Web API を足すときは、IDL を対応表に加え、コンパイラのエラーに従って実装する。

### 3.2 型の変換

- Web IDL の変換の規則（`long` の範囲の丸め、`[EnforceRange]`、`[Clamp]`、`DOMString` と `USVString`、辞書、`sequence<T>`、union、`Promise<T>`、コールバック、`any`）は、生成するコードで仕様どおりに行う（[Web IDL Standard](https://webidl.spec.whatwg.org/)）。
- 辞書のメンバーは辞書順に読む、getter の副作用の順序など、観測できる順序も仕様に合わせる。WPT の `WebIDL/` と各 API の `idlharness` のテストで確かめる。
- 文字列は、V8 の文字列から Rust の文字列への変換を避けられる場所（属性の値の比較など）では、V8 の文字列のまま扱う。

### 3.3 拡張属性

生成の対象にする拡張属性（MVP）：

| 拡張属性 | 扱い |
| --- | --- |
| `[Exposed=(Window,Worker,...)]` | どのグローバルに入れるか |
| `[SecureContext]` | 安全な文脈（HTTPS など）のコンテキストにだけ入れる |
| `[CrossOriginIsolated]` | cross-origin isolated のコンテキストにだけ入れる（`SharedArrayBuffer` など） |
| `[SameObject]`、`[NewObject]` | 返すオブジェクトの同一性 |
| `[CEReactions]` | Custom Elements の反応のキューを、呼び出しの前後で積む・実行する |
| `[LegacyUnforgeable]`、`[Replaceable]`、`[PutForwards]`、`[LegacyLenientThis]` | プロパティの置き方（インスタンスに置く、上書きを許す） |
| `[HTMLConstructor]` | Custom Elements のコンストラクタ |

- 自分たちの拡張属性（例：高速な呼び出しの対象、`[RuntimeEnabled=フラグ名]` で release フラグの裏に置く）は、仕様の IDL とは別のファイルに `partial` として書く。

### 3.4 呼び出しの速さ

- Speedometer 3（NFR-003）は、DOM の呼び出しの多いベンチマーク。呼び出しの費用を小さくする。
  - 属性の getter はアクセサとして置き、引数の変換を省ける場合は省く。
  - よく呼ばれる単純なメソッド（`getAttribute`、`appendChild` など）は、V8 の高速な API の呼び出し（fast API calls）の対象にする。rusty_v8 と deno_core は、この仕組みを Rust から使っている。
- 生成したコードは、ベンチマークで遅い箇所が見つかったら、生成器の側で直す。生成したファイルを手で編集しない。

## 4. 安全：コンテキストの分離と origin の検査

### 4.1 前提

- Renderer は侵害されうる（ADR-0003）。Renderer の中の検査は、正しいページに正しく振る舞うためと、多層防御のためのもの。Cookie・保存領域・権限・他のサイトのデータへのアクセスは、Browser 側で、そのプロセスに割り当てたサイトで必ず検査する。
- 同じ Renderer には、同じサイトで origin の違うフレーム（例：`a.example.com` と `b.example.com`）が同居しうる。origin の検査は Renderer の中でも要る。

### 4.2 コンテキストをまたぐアクセス

- 別のフレームの `WindowProxy` と `Location` に触れたときは、HTML の「cross-origin のオブジェクト」の規則に従う。cross-origin なら、許されたプロパティ（`postMessage`、`location` の書き込み、`close` など）だけを見せる。
  - V8 のアクセス検査のコールバック（`ObjectTemplate` の access check）で実装する。**未検証**：rusty_v8 がアクセス検査のコールバックと、cross-origin 用の interceptor を公開しているか。確かめ方：E1 で `WindowProxy` の最小の実装を作る。公開していなければ、rusty_v8 に追加を送る。
- それ以外の DOM のオブジェクトは、同じ origin のフレームの間でしか受け渡されない前提にし、バインディングの入口で「呼び出したコンテキストの origin」と「オブジェクトが属する文書の origin」を比べる。合わなければ `SecurityError` を投げる。
- `document.domain` の書き込みは、既定で効かない（origin-keyed のエージェントのまとまりを既定にする）。`Origin-Agent-Cluster: ?0` で明示的に外した文書だけ許す（本家と同じ。[process-model.md](process-model.md) の 3.4 節）。互換性の影響は、主要サイトの検査で確かめる。
- isolated world（拡張機能）は、main world の JavaScript のオブジェクトを見られない。DOM は共有する。

### 4.3 Spectre への対策

- `SharedArrayBuffer` と精度の高いタイマーは、cross-origin isolated（COOP と COEP）のページにだけ与える。
- cross-origin isolated のページは、同じサイトの他のページとも別のプロセスに置く（[process-model.md](process-model.md)）。

### 4.4 V8 の脆弱性への備え

- V8 のサンドボックスを有効にし、V8 のヒープの破壊が、プロセスの他のメモリへ広がりにくくする（1.1 節の未検証の項目）。
- JIT は既定で有効。企業の管理者の設定で JIT を切れるようにする（本家の方針に合わせる）。

## 5. MVP の Web API の範囲

intent の「HTML・CSS・JavaScript（V8）の主要な Web プラットフォーム」を、次のように区切る。NFR-007 の WPT の対象の領域と一致させる（[quality.md](../quality.md)）。

| 分野 | MVP に含める | 担当の文書 |
| --- | --- | --- |
| DOM | Node・Element・Document・Range・TreeWalker・MutationObserver・Shadow DOM・Custom Elements・`<template>`・`<slot>` | この文書、[rendering.md](rendering.md) |
| HTML の要素 | フォーム（検証、送信）、`<dialog>`、`popover`、`<details>`、`<iframe>`、`<img>`・`<picture>`、`<video>`・`<audio>`（基本の再生） | [rendering.md](rendering.md) |
| イベント | UI イベント・Pointer Events・キーボード・フォーカス・入力（IME を含む）・ドラッグアンドドロップ | [rendering.md](rendering.md) の 9 節 |
| CSSOM | `getComputedStyle`、`CSSStyleSheet`（構築可能なスタイルシートを含む）、CSSOM View（`getBoundingClientRect`、スクロール） | [rendering.md](rendering.md) |
| 観測 | IntersectionObserver、ResizeObserver、PerformanceObserver、Performance Timeline（LCP・CLS・Event Timing） | [rendering.md](rendering.md) |
| ネットワーク | Fetch、XMLHttpRequest、WebSocket、`AbortController`、Streams、`URL`、`FormData`、`Blob`、`File`、`FileReader`、Beacon | [networking.md](networking.md) |
| タイマー・スケジューリング | `setTimeout`・`setInterval`、`queueMicrotask`、`requestAnimationFrame`、`requestIdleCallback` | この文書の 2 節 |
| 保存 | Cookie（`document.cookie`）、`localStorage`・`sessionStorage`、IndexedDB、Cache Storage、Storage API（`navigator.storage`） | [storage.md](storage.md) |
| Worker | Dedicated Worker、Shared Worker、Service Worker（登録、fetch の横取り、キャッシュ） | この文書、[storage.md](storage.md) |
| メッセージ | `postMessage`、`MessageChannel`、`BroadcastChannel` | この文書 |
| グラフィックス | Canvas 2D、`OffscreenCanvas`（2D）、`createImageBitmap`、SVG（描画と基本の DOM） | [rendering.md](rendering.md) の 15 節 |
| WebAssembly | V8 の WebAssembly（ストリーミングのコンパイル、コードのキャッシュ） | この文書 |
| 暗号 | Web Crypto（`crypto.subtle`、`getRandomValues`、`randomUUID`） | この文書 |
| 文字と国際化 | `Intl`（V8 の ICU）、`TextEncoder`・`TextDecoder` | この文書 |
| 権限の要る API | Permissions API、Geolocation、Notifications（ページが開いている間）、Clipboard（非同期）、`getUserMedia`（カメラ・マイクの取得と `<video>` への表示）、全画面 | [safe-browsing-and-permissions.md](safe-browsing-and-permissions.md) |
| 認証 | WebAuthn（パスキー、セキュリティキー、OS の認証器、条件付きの UI） | [safe-browsing-and-permissions.md](safe-browsing-and-permissions.md) の 7 節 |
| 履歴 | History API、Navigation API | [navigation-and-loading.md](navigation-and-loading.md) |

- `Intl` は V8 に組み込みの ICU（C++）を使う。レイアウトの ICU4X（[rendering.md](rendering.md) の 11 節）とは別。ICU のデータを 2 つ持つことになるが、V8 の `Intl` を ICU4X に替える方法は V8 の側にない（**未検証**：V8 の ICU4X への移行の状況。E3 のメモリの調査で確かめる）。

### 5.1 MVP に含めない

| API | 理由・時期 |
| --- | --- |
| WebGL・WebGL 2 | GPU プロセスに ANGLE を載せる作業が大きい。MVP の後、E2 の Story として最初に足す |
| WebGPU | Dawn（または wgpu）の組み込みと、シェーダーの検証の攻撃面が大きい。MVP の後に ADR で決める |
| WebRTC | 独立した大きな部品（libwebrtc）。MVP の後 |
| Web Audio | MVP の後、E2 の Story として WebGL の次に足す（利用するサイトが多い） |
| Push API、Background Sync | クラウドのプッシュのサービスが要る。intent のサービスの範囲の外 |
| WebXR、Web Bluetooth・USB・Serial・HID、Web MIDI | 利用が限られ、権限と攻撃面が大きい |
| Payment Request、WebAuthn のうち自前のパスキーの提供者と他の端末による認証（hybrid） | MVP の後（[safe-browsing-and-permissions.md](safe-browsing-and-permissions.md) の 7 節）。WebAuthn の基本はアカウントのログインに要るので MVP に含める |
| File System Access、WebTransport、Web Speech | MVP の後 |
| Privacy Sandbox の API（Topics など） | intent の Non-goals |

## 6. 開発者ツール（CDP の部分集合）

### 6.1 方針

- 開発者ツールは Chrome DevTools Protocol（CDP）で話す（[CDP](https://chromedevtools.github.io/devtools-protocol/)）。自動化の道具（Puppeteer、Playwright）と同じプロトコルなので、E2E のテストにも使える（[build-and-test.md](build-and-test.md)）。
- 画面（フロントエンド）は、Chrome DevTools のフロントエンド（chrome-devtools-frontend、BSD-3-Clause）を改変せずに、ブラウザの内部のページとして同梱する。**未検証**：フロントエンドが、下の部分集合だけのバックエンドで破綻しないか（未実装のメソッドへの応答の扱い）。確かめ方：E1 の終わりに、要素の検査・コンソールを部分集合で動かす。

### 6.2 MVP のドメイン

| ドメイン | 実装する場所 | 範囲 |
| --- | --- | --- |
| Runtime、Debugger、Profiler、HeapProfiler | Renderer（V8 の inspector） | V8 の inspector が実装する。rusty_v8 は `V8Inspector`・`V8InspectorSession`・`Channel` を公開している（[docs.rs v8::inspector](https://docs.rs/v8/latest/v8/inspector/index.html)） |
| DOM、CSS、Overlay | Renderer | 要素の木、計算値と適用された規則、要素の強調表示 |
| Page | Browser ＋ Renderer | ナビゲーション、再読み込み、フレームの木、スクリーンショット |
| Network | Browser（Network サービスのイベント） | 要求と応答の一覧、ヘッダー、本文。Renderer は他のサイトの応答を知らないので、Browser が持つ |
| Log | Browser ＋ Renderer | コンソールの外のメッセージ（介入、CSP の違反） |
| Target | Browser | タブ・iframe（別プロセス）・Worker へのセッションの接続。別プロセスの iframe は自動で接続する |
| Input、Emulation（画面の大きさ） | Browser | 自動化のテスト用 |

- CDP の接続は Browser プロセスが受け、対象（Target）ごとに、担当するプロセスへ中継する。Renderer は、自分のサイトの対象へのメッセージしか受けない。
- 外からの接続（`--remote-debugging-port`・`--remote-debugging-pipe`）は既定で無効。有効にするときは、既定のプロファイルでは許さない（本家が 2025 年に採った制限と同じ考え方。**未検証**：本家の現在の制限の正確な条件。E1 で確かめて合わせる）。

## 7. 未解決事項と未検証の項目

| 項目 | 状態 | 確かめ方・決め方 |
| --- | --- | --- |
| V8 のサンドボックス・ポインタの圧縮を有効にした rusty_v8 のビルド | 未検証 | 1.1 節。E1 |
| rusty_v8 の、ラッパーの削除可能性・アクセス検査のコールバックの公開 | 未検証 | 1.3 節・4.2 節。E1。なければ上流に追加を送る |
| weedle2 が、現在の Web IDL の構文（async iterable、`ObservableArray` など）を解析できるか | 未検証 | E1 で `@webref/idl` の全体を解析し、失敗する定義を数える。足りなければ weedle2 に追加を送るか、解析器を自作する（ADR-0014） |
| DevTools のフロントエンドと部分集合のバックエンド | 未検証 | 6.1 節 |
| V8 の `Intl` と ICU4X の二重持ち | 未検証 | 5 節。E3 |
| WebGL・Web Audio の順序と時期 | 未決定 | E2 の計画で PM と決める |

## 参考

- [Getting started with embedding V8](https://v8.dev/docs/embed)、[denoland/rusty_v8](https://github.com/denoland/rusty_v8)、[docs.rs v8](https://docs.rs/v8/latest/v8/)
- [High-performance garbage collection for C++](https://v8.dev/blog/high-performance-cpp-gc)
- [Web IDL Standard](https://webidl.spec.whatwg.org/)、[w3c/webref](https://github.com/w3c/webref)、[weedle2](https://crates.io/crates/weedle2)、[Firefox の Web IDL bindings](https://firefox-source-docs.mozilla.org/dom/webIdlBindings/index.html)
- [HTML Standard: Event loops](https://html.spec.whatwg.org/multipage/webappapis.html#event-loops)
- [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/)

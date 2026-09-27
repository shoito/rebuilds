# Web APIs and Compatibility: Cloudflare Workers

利用者のコードから見える API の設計。WinterTC の最小の共通 API（ECMA-429）への適合、`fetch` とサブリクエスト、WebSocket、Web Crypto、Node.js の互換の範囲、要求の属性 `request.<brand>`、Web Platform Tests（WPT）での適合の確認を決める。

| 関連 | 決定 |
| --- | --- |
| [ADR-0001](../decisions/0001-runtime-build-vs-reuse.md) | Web API は workerd の実装を引き継ぐ。WPT の通過率が上流を下回らない（K7） |
| [ADR-0008](../decisions/0008-bundle-format-and-compatibility-dates.md) | 互換の日付とフラグは上流の表をそのまま使う |
| [ADR-0013](../decisions/0013-spectre-mitigations-and-dynamic-isolation.md) | 時計を止め、スレッド・共有メモリを禁じる |
| [ADR-0014](../decisions/0014-wintertc-conformance-and-wpt.md) | ECMA-429 の全インターフェイスを持ち、セキュリティのための逸脱を一覧にし、WPT の部分集合で毎週の取り込みを止める |
| [ADR-0015](../decisions/0015-nodejs-compat-scope.md) | Node.js の互換は上流の組み込みの範囲に従い、TCP と DNS に依るモジュールは MVP で失敗させる。polyfill は CLI が足す |
| [ADR-0016](../decisions/0016-request-brand-metadata.md) | 要求の属性は `request.<brand>` に置き、S1 で正しく出せる欄だけを埋める。モジュールの名前空間も `<brand>:` にする |

時計・スレッドの禁止の理由は [sandbox-and-security.md](sandbox-and-security.md) の 6 節、実行時のコードの生成の禁止とバンドルの形式は [runtime-and-isolates.md](runtime-and-isolates.md) の 7 節にある。外向きの通信の宛先の制限は [edge-network-and-routing.md](edge-network-and-routing.md) の 10 節、サブリクエストの数などの制限の値は [limits-and-billing.md](limits-and-billing.md) の 3 節にある。

本家の振る舞い・数値は、2026-09-27 に Workers の文書、WinterTC の仕様、workerd の GitHub で確かめた。

## 1. 目的と範囲

| 範囲に含む | 範囲に含まない（担当の領域） |
| --- | --- |
| グローバルの API の一覧と、本家・標準からの逸脱 | バインディング（KV、オブジェクトストレージ、Durable Objects、キュー）の API（各ストレージの領域） |
| `fetch` とサブリクエストの意味（リダイレクト、本文、中止） | 外向きのプロキシの実装、宛先の制限（edge-network-and-routing） |
| WebSocket（サーバーとクライアント） | Durable Objects の WebSocket の休止（durable-objects） |
| Web Crypto と、本家の非標準の拡張 | シークレットの保管と配布（security、deployment-and-config-distribution） |
| Node.js の互換の範囲 | CLI の polyfill の同梱の実装（developer-tooling） |
| `request.<brand>` の欄と値の出どころ | 入口のプロキシのヘッダー（`<Brand>-Connecting-IP` など。edge-network-and-routing） |
| WPT の部分集合と、適合の門 | 型の定義の生成（developer-tooling） |

## 2. 本家と標準（確かめたこと）

| 項目 | 本家・標準 | 出典（すべて 2026-09-27 に確認） |
| --- | --- | --- |
| ECMA-429 | WinterTC（Ecma の TC55）の「最小の共通 Web API」。2025 年のスナップショットの第 1 版を、2025-12-10 の Ecma の総会が承認した。Web サーバーのランタイムが Web プラットフォームと相互運用するための、W3C・WHATWG の API の部分集合 | [ECMA-429](https://ecma-international.org/publications-and-standards/standards/ecma-429/)、[Minimum Common Web API](https://min-common-api.proposal.wintertc.org/) |
| ECMA-429 の中身 | インターフェイス：`AbortController`・`AbortSignal`・`Event`・`EventTarget`・`CustomEvent`・`ErrorEvent`・`MessageChannel`・`MessageEvent`・`MessagePort`・`PromiseRejectionEvent`・`DOMException`、`Headers`・`Request`・`Response`・`FormData`、`Blob`・`File`、Streams の 12 のインターフェイス、`TextEncoder`・`TextDecoder`・`TextEncoderStream`・`TextDecoderStream`、`URL`・`URLSearchParams`・`URLPattern`、`CompressionStream`・`DecompressionStream`、`Crypto`・`CryptoKey`・`SubtleCrypto`、`WebAssembly` の名前空間のすべて、`Performance`。グローバル：`setTimeout` などのタイマー、`fetch`、`atob`・`btoa`、`structuredClone`、`queueMicrotask`、`reportError`、`globalThis`・`self`、`console`、`crypto`、`performance`、`navigator.userAgent`、`onerror`・`onunhandledrejection`・`onrejectionhandled`、`WebAssembly.compile`・`instantiate`・`validate`・`compileStreaming`・`instantiateStreaming`・`JSTag` | Minimum Common Web API |
| ECMA-429 に無いもの | `WebSocket` は含まれない。適合の判定に WPT を使うとは書かれていない | 同上 |
| 本家の禁止 | `eval()`、`new Function`、`WebAssembly.compile`・`compileStreaming`、バッファからの `WebAssembly.instantiate`、`instantiateStreaming`。`Date.now()` は最後の I/O の時刻 | [Web standards](https://developers.cloudflare.com/workers/runtime-apis/web-standards/) |
| 本家のタイマー | 要求の文脈の中でだけ使える | 同上 |
| `navigator.userAgent` | `global_navigator` のフラグで有効。値は本家の名前 | 同上 |
| 時計 | `performance.now()` も止まる。`performance.timeOrigin` は 0 | [Performance and timers](https://developers.cloudflare.com/workers/runtime-apis/performance/) |
| WebSocket | サーバーは `WebSocketPair` と `accept()`。クライアントは `fetch` の `Upgrade: websocket` と `new WebSocket(url)` | [WebSockets](https://developers.cloudflare.com/workers/runtime-apis/websockets/) |
| Web Crypto | 標準の算法（RSA、ECDSA、Ed25519、X25519、HKDF、PBKDF2 など）に加え、非標準の `crypto.DigestStream`、`crypto.subtle.timingSafeEqual`、MD5 の digest | [Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/) |
| 制限 | サブリクエストは無料 50・有料 10,000（1 要求あたり）。同時の外向きの接続は 6。URL 16KB、要求・応答のヘッダーは各 128KB | [Limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Node.js の互換 | 組み込み（多くは完全、一部は部分的）と、CLI が足す polyfill（呼ぶと例外）の 2 つの形。2026-08-04 以降の互換の日付で既定で有効。部分的：`console`・`dns`・`module`・`os`・`perf_hooks`・`test`・`tls`。`node:fs` はメモリの仮想のファイルシステム（`/bundle` は読み込み専用、`/tmp` は書ける、`/dev/null` など）。`node:net` は `connect()` の TCP のソケットを使う。`node:http2`・`node:child_process`・`node:worker_threads` などは、読み込めるが動かない空の実装 | [Node.js compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)、[fs](https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/)、[net](https://developers.cloudflare.com/workers/runtime-apis/nodejs/net/)、[Compatibility flags](https://developers.cloudflare.com/workers/configuration/compatibility-flags/) |
| `request.cf` | 入ってくる要求の属性。`asn`・`asOrganization`・`colo`・`country`・`city`・`continent`・`latitude`・`longitude`・`postalCode`・`region`・`regionCode`・`metroCode`・`timezone`・`isEUCountry`・`httpProtocol`・`tlsVersion`・`tlsCipher`・`tlsClientAuth`・`tlsClientHelloLength`・`tlsClientRandom`・`tlsClientCiphersSha1`・`tlsClientExtensionsSha1`・`clientTcpRtt`・`clientQuicRtt`・`clientAcceptEncoding`・`requestPriority`・`botManagement`・`edgeL4`・`hostMetadata`。外へ出す要求の `cf` の欄（キャッシュなど）は、不正な鍵を黙って無視する | [Request](https://developers.cloudflare.com/workers/runtime-apis/request/) |
| 上流の WPT | workerd は `src/wpt` に、`dom`・`fetch`・streams・URL・URLPattern・encoding・compression・WebCryptoAPI・websockets・eventsource・performance-timeline・webidl・fs の試験の設定を持つ | [workerd の src/wpt](https://github.com/cloudflare/workerd/tree/main/src/wpt) |

## 3. 原則

- **標準に寄せ、逸脱は理由とともに一覧にする。** 逸脱は、セキュリティ（時計、コードの生成）と、MVP で持たない機能（TCP のソケット、キャッシュ）のときだけ許す。
- **上流の実装を使う。** API を自前で書き直さない。欠陥は上流に報告し、直す（[ADR-0006](../decisions/0006-workerd-fork-and-upstream-tracking.md)）。
- **振る舞いは互換の日付で固定する。** API の振る舞いの変更は、上流のフラグの日付に従う（[ADR-0008](../decisions/0008-bundle-format-and-compatibility-dates.md)）。
- **ブランドの名前は `<brand>` にする。** 振る舞いは本家に寄せるが、名前は本家のものを使わない（[リポジトリ共通の ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。

## 4. WinterTC の最小の共通 API

[ADR-0014](../decisions/0014-wintertc-conformance-and-wpt.md)。

### 4.1 対応の表

| ECMA-429 の項目 | 対応 | 逸脱・備考 |
| --- | --- | --- |
| イベント（`Event`・`EventTarget`・`AbortController` など） | 持つ | |
| `MessageChannel`・`MessagePort` | 持つ | 同じ isolate の中だけ。isolate の外へは送れない |
| `Headers`・`Request`・`Response`・`FormData`・`fetch` | 持つ | 4.2 節 |
| `Blob`・`File` | 持つ | 中身は isolate のメモリに数える |
| Streams（12 のインターフェイス） | 持つ | |
| `TextEncoder`・`TextDecoder`・その Stream | 持つ | |
| `URL`・`URLSearchParams`・`URLPattern` | 持つ | |
| `CompressionStream`・`DecompressionStream` | 持つ | |
| `Crypto`・`CryptoKey`・`SubtleCrypto` | 持つ | 4.4 節 |
| `WebAssembly` の名前空間 | 持つ | **逸脱**：`compile`・`compileStreaming`・`instantiateStreaming`・バッファからの `instantiate` は例外を投げる。Wasm はバンドルのモジュールからだけ（[runtime-and-isolates.md](runtime-and-isolates.md) の 7.1 節） |
| `Performance`・`performance` | 持つ | **逸脱**：`now()` は実行中に進まない。`timeOrigin` は 0（[sandbox-and-security.md](sandbox-and-security.md) の 6.1 節） |
| タイマー | 持つ | 要求の文脈の中でだけ使える（本家と同じ）。トップレベルでは例外 |
| `atob`・`btoa`・`structuredClone`・`queueMicrotask`・`reportError` | 持つ | |
| `globalThis`・`self`・`console` | 持つ | `console` の出力は tail とログへ（developer-tooling・observability） |
| `navigator.userAgent` | 持つ | 値は単一の製品の記号 `'<Brand>-Workers'`（ECMA-429 の推奨の形）。上流の `global_navigator` のフラグの日付に従う |
| `onerror`・`onunhandledrejection`・`onrejectionhandled` | 上流の実装に従う | 上流のグローバルは `unhandledrejection`・`rejectionhandled` の事象を `addEventListener` で受ける。`error` の事象と `on*` の属性は持たない（[global-scope.h](https://github.com/cloudflare/workerd/blob/main/src/workerd/api/global-scope.h)、2026-09-27 に確認）。**逸脱**として一覧に載せ、WPT の結果で確かめる |

**ECMA-429 の外で持つもの**（本家と同じく上流が持つ）：`WebSocket`・`WebSocketPair`、`scheduler.wait`、`EventSource`、`crypto.DigestStream` など。

### 4.2 `fetch` とサブリクエスト

- `fetch` は、外向きのプロキシを通る（[sandbox-and-security.md](sandbox-and-security.md) の 7.1 節）。私的なアドレスや IMDS への要求は、ネットワークのエラー（`TypeError`）になる。**エラーの文言で、拒否の理由（内部のアドレスだったこと）を詳しく返さない。**
- リダイレクトは標準どおり（`follow` で最大 20 回）。1 回ごとに宛先を検査する。
- 1 要求あたりのサブリクエストの数と同時の接続の数は、外向きのプロキシが数えて強制する（isolate の中の数を信じない）。既定案は本家と同じ（無料 50・有料 10,000、同時 6）。値は limits-and-billing で決める。
- 利用者が切断したら、その要求の `request.signal` を中止し、サブリクエストも中止する。
- 外へ出す要求の `<brand>` の欄（本家の `cf` に当たる。キャッシュの指示など）は、S1 では持たない。渡されたら、本家と同じく未知の鍵として黙って無視する（キャッシュは MVP の外。intent）。
- 自分たちのドメイン（`*.<brand>.<domain>` と利用者のカスタムドメイン）への `fetch` は、ループを防ぐため、入口のプロキシの内部の経路で扱う（edge-network-and-routing で決める）。

### 4.3 実行時のコードの生成とタイマーの文脈

- `eval`・`new Function`・Wasm の実行時のコンパイルは、呼ぶと例外（`EvalError` など、上流の実装に従う）。
- タイマー・`fetch` は、要求の文脈（ハンドラーの実行中と、`ctx.waitUntil()` に渡した Promise の間）でだけ使える。トップレベル（グローバルのスコープ）では使えない。アップロード時の検証でトップレベルを実行するとき、網に出られない理由でもある（[runtime-and-isolates.md](runtime-and-isolates.md) の 7.3 節）。

### 4.4 Web Crypto

- 標準の算法は上流の実装（BoringSSL）に従う。本家の非標準の拡張（`crypto.DigestStream`、`crypto.subtle.timingSafeEqual`、MD5 の digest）も上流にあるので持つ。
- **PBKDF2 の反復の回数に上限を置く**：公開版の workerd は上限を持たない（`NullIsolateLimitEnforcer` の `checkPbkdfIterations` が「上限なし」を返す。[server.c++](https://github.com/cloudflare/workerd/blob/main/src/workerd/server/server.c%2B%2B)）。差し込み口の既定の実装は 100,000 回で、「歴史的に 100,000 回に制限してきた」とコメントされている（[limit-enforcer.h](https://github.com/cloudflare/workerd/blob/main/src/workerd/io/limit-enforcer.h)、2026-09-27 に確認）。S1 も 100,000 回を上限にし、超えたら `NotSupportedError` にする（[ADR-0009](../decisions/0009-cpu-and-memory-metering.md) の `IsolateLimitEnforcer` の実装で入れる）。CPU 時間の上限とは別に、1 回の呼び出しでスレッドを長く占有させないため。
- **scrypt の費用にも上限を置く**：`node:crypto` の scrypt は、同じ差し込み口の `checkScryptCost` で `N × r × p` を 2^20 までに制限する（上流の既定の実装。公開版の `NullIsolateLimitEnforcer` もこれを受け継ぐ）。S1 も同じ値にする。
- `crypto.getRandomValues`・`randomUUID` は、ランタイムの CSPRNG（`getrandom`）から。

### 4.5 WebSocket

- サーバー：`new WebSocketPair()` で作り、片方を `accept()` して、もう片方を `Response` の `webSocket` で返す（本家と同じ）。
- クライアント：`fetch` に `Upgrade: websocket` を付けるか、`new WebSocket(url)`。外向きのプロキシを通り、宛先の検査も同じ。
- 受け取る 1 つのメッセージの大きさの上限は **32 MiB**（本家と同じ。超えると `1009` で閉じる。[WebSockets](https://developers.cloudflare.com/workers/runtime-apis/websockets/)、2026-09-27 に確認）。上流の workerd の既定も 32 MiB で、実験のフラグ `increase_websocket_message_size`（128 MiB、手元の開発用）は開かない。接続の時間の上限は置かない（本家の HTTP の要求と同じく、利用者が接続している間は続く）。値の表は limits-and-billing の 3.3 節。
- WebSocket を持つ要求は、CPU 時間の上限を要求の全体で数える（メッセージごとに数え直さない）。Durable Objects に相当するものの休止（hibernation）は durable-objects の領域。

## 5. `request.<brand>`

[ADR-0016](../decisions/0016-request-brand-metadata.md)。

### 5.1 名前

- 入ってくる要求の属性を `request.<brand>` に置く。本家の `request.cf` と同じ形の欄を持つ。**`request.cf` の別名は置かない**（リポジトリ共通の ADR-0006）。本家のコードを移すときは、CLI の lint が `request.cf` を見つけて警告する（developer-tooling）。
- 型の名前は `IncomingRequest<Brand>Properties`。
- 上流のモジュールの名前空間（`cloudflare:workers`、`cloudflare:sockets` など）も `<brand>:workers` の形に置き換える。置き換えは `brand` の分類のパッチで行う（[runtime-and-isolates.md](runtime-and-isolates.md) の 4.2 節）。

### 5.2 欄と値の出どころ（S1）

S1 の入口は、Global Accelerator の edge で TCP を受け、エッジのノードで TLS と HTTP を終端する（ADR-0003）。利用者の IP は保たれるが、利用者との TCP の往復はノードから見えない。

| 欄 | S1 | 値の出どころ |
| --- | --- | --- |
| `asn`・`asOrganization` | 持つ | IP から AS への対応の表（ノードの手元。週 1 回更新） |
| `country`・`continent`・`isEUCountry`・`region`・`regionCode`・`city`・`postalCode`・`latitude`・`longitude`・`timezone` | 持つ | IP の位置の表（ノードの手元。週 1 回更新）。分からなければ `null`（`timezone` は `"UTC"`） |
| `metroCode` | `null` | 米国の DMA。S1 の利用者には要らない |
| `colo` | 持つ | 処理したリージョンの 3 文字の記号（東京 `NRT`、大阪 `KIX`、シンガポール `SIN`、オレゴン `PDX`、フランクフルト `FRA`。海外の 3 リージョンは E1 で確定） |
| `httpProtocol` | 持つ | 入口のプロキシ（`HTTP/1.1`・`HTTP/2`。HTTP/3 は edge-network-and-routing で決める） |
| `tlsVersion`・`tlsCipher` | 持つ | 入口のプロキシの TLS |
| `tlsClientHelloLength`・`tlsClientCiphersSha1`・`tlsClientExtensionsSha1`・`tlsClientExtensionsSha1Le`・`tlsClientRandom` | 持つ | 入口のプロキシが ClientHello から計算 |
| `clientAcceptEncoding` | 持つ | 入口のプロキシが書き換える前の `Accept-Encoding` |
| `clientTcpRtt` | `undefined` | TCP は Global Accelerator の edge で終わるので、ノードで測った往復は利用者までの往復ではない。誤った値を出さない |
| `clientQuicRtt` | `undefined` | HTTP/3 を持つまで |
| `edgeL4` | `undefined` | 同じ理由 |
| `tlsClientAuth` | `null` | 相互 TLS は MVP の外 |
| `requestPriority` | `null` | HTTP/2 の優先度の扱いを決めるまで |
| `botManagement` | `null` | ボットの判定の製品を持たない |
| `hostMetadata` | `undefined` | SaaS のカスタムホスト名の機能を持たない |

- 位置の表・AS の表の製品（データの提供元）とライセンスは、E4 の着手前に決める（14 節）。表は設定の写しと同じくノードに配る。要求の処理で外部に問い合わせない（ADR-0004）。
- 同じ値は、入口のプロキシがヘッダー（`<Brand>-IPCountry` など）でも付けうる。ヘッダーの一覧は edge-network-and-routing で決め、`request.<brand>` の値と食い違わないように、1 か所で計算して両方に渡す。
- **利用者が送ったヘッダーから `request.<brand>` の値を作らない。** 入口のプロキシが計算した値だけを、ランタイムへの内部の経路で渡す。利用者が `<Brand>-*` のヘッダーを送っても、上書きされる（edge-network-and-routing）。

## 6. Node.js の互換

[ADR-0015](../decisions/0015-nodejs-compat-scope.md)。

- **範囲は上流の workerd の組み込みに従う。** 上流の Node.js の API の実装を、互換の日付・フラグの意味を変えずに使う（2026-08-04 以降の日付で既定で有効）。本家と同じく、上流の対象の Node.js の版（本家の文書は「Node.js の Current の版に合わせる」とする）に従う。
- **polyfill は CLI が足す。** ランタイムには足さない。本家は CLI（wrangler）が unenv で polyfill を足す。この基盤も CLI（developer-tooling）で同じ考えで足す。
- **MVP で失敗させるもの**：

| モジュール | 本家 | S1 | 理由 |
| --- | --- | --- | --- |
| `node:net`・`node:tls` の接続 | 使える（TCP のソケットの `connect()` を使う） | 読み込めるが、接続は失敗（`ERR_SOCKET_CONNECTION_TIMEOUT` ではなく、理由の分かる `ERR_NOT_SUPPORTED` の形のエラー） | TCP のソケットは MVP の外（intent）。外向きのプロキシが TCP のソケットの要求を受け付けない |
| `node:dns` の問い合わせ | 部分的 | 失敗させる | 名前の解決の経路（外向きのプロキシの DNS）を利用者に開くかを決めていない |
| `node:http`・`node:https` のクライアント | 使える | 使える | `fetch` と同じ外向きのプロキシを通る |
| `node:fs` | 仮想のファイルシステム | 同じ | 下の注意 |
| 空の実装（`node:child_process`・`node:worker_threads` など） | 読み込めるが動かない | 同じ | 上流に従う。ネイティブ・スレッドの禁止と矛盾しない（動かないので） |

- **`node:fs` の注意**：本家の仮想のファイルシステムは、ホストのファイルシステムに届かない（メモリの中）。`/tmp` に書いた量は isolate のメモリ（128MiB）に数える。**`/tmp` の中身は要求ごと**：上流は `/tmp` を要求の文脈（`IoContext`）ごとに持ち、文脈が終わると消す（[worker-fs.h](https://github.com/cloudflare/workerd/blob/main/src/workerd/io/worker-fs.h)、2026-09-27 に確認）。同じ isolate の別の要求からも見えない。脱出のテストで、`/bundle`・`/tmp`・`/dev` の外が見えないことを確かめる（[sandbox-and-security.md](sandbox-and-security.md) の 9.1 節）。
- `process.env` は、上流のフラグに従ってバインディング（環境変数・シークレット）から埋める。
- 互換の状況は、本家の文書の表と同じ形で、この基盤の文書に載せる（developer-tooling）。上流の取り込みで対応が増えたら、文書を更新する。

## 7. WPT での適合の確認

[ADR-0014](../decisions/0014-wintertc-conformance-and-wpt.md)。

- **対象**：上流の workerd の `src/wpt` の設定をそのまま使う（`dom`・`fetch`・streams・URL・URLPattern・encoding・compression・WebCryptoAPI・websockets・eventsource・performance-timeline・webidl・fs）。ECMA-429 の各項目に対応する WPT のディレクトリを、表で対応付けて持つ（開発リポジトリの `wpt/coverage.md`）。
- **期待の一覧**：試験ごとに「通る」「既知の失敗（理由）」を持つ。上流の期待の一覧を土台にし、自分たちの逸脱（下）を足す。
- **自分たちの逸脱として認める失敗**：
  - 時計が進まないことによる失敗（`performance.now()` を使う試験の一部）
  - 実行時の Wasm のコンパイルの禁止による失敗（`compileStreaming`・`instantiateStreaming` など）
  - TCP のソケット・DNS に依る試験（Node.js の互換）
  - それぞれに理由と ADR を付ける。理由のない既知の失敗は認めない。
- **門**（毎週の取り込みと、V8 の緊急の修正の経路）：
  1. 通る試験の数が、同じ版の上流の workerd の通る数から、自分たちの逸脱の分を引いた数を下回らない（intent の K7）。
  2. 前の週に通った試験が、新しく失敗しない（退行）。退行したら、本番へ出さない。上流でも失敗するなら上流に報告し、期待の一覧を理由付きで変える。
- **速さ**：WPT の部分集合は 20 分以内に終わるように分けて並列に回す。V8 の緊急の経路（T+8h の速い試験）では、ECMA-429 の核（fetch・streams・URL・encoding・WebCryptoAPI）だけを回す。
- 通過率を、公開の文書に載せる（利用者が本家・他のランタイムと比べられるように）。載せ方は developer-tooling で決める。

## 8. 障害の型

| 障害 | 検知 | 振る舞い |
| --- | --- | --- |
| 上流の取り込みで API の振る舞いが変わる（互換の日付の意味の変更なしに） | WPT の退行、互換の試験 | 本番に出さない。上流に報告 |
| 外向きのプロキシの拒否で、正当な `fetch` が失敗する（誤った範囲の拒否） | 利用者の報告、拒否の記録 | 拒否の一覧の見直し（edge-network-and-routing）。セキュリティの担当のレビューを要す |
| 位置の表・AS の表が古い、壊れている | 表の版と更新の時刻 | 前の版の表を使い続ける。壊れた表はノードが検証して拒否する。欄は `null` になっても要求は止めない |
| `request.<brand>` の値が入口のプロキシとランタイムで食い違う | 合成の要求での照合 | 1 か所の計算に直す |
| Node.js の互換のモジュールが、MVP で閉じたはずの経路を開く（上流の新しいモジュール） | 取り込みの CI の脱出のテスト（網）、外向きのプロキシの拒否 | 外向きのプロキシが TCP を受け付けないので、網には出ない。モジュールの振る舞いを確かめ、必要なら文書に載せる |
| PBKDF2 などの重い API で、1 回の呼び出しがスレッドを長く占有する | CPU 時間の強制（1ms ごとの監視）は、ネイティブの処理の中では効かない | 反復の上限（4.4 節）。ほかの重い API（大きな RSA の鍵の生成など）は、E2 で一覧にし、上限を検討する |

## 9. セキュリティ

- isolate の中から届く値（`fetch` の宛先、ヘッダー、`<brand>` の欄、バインディングの名前）は、外向きのプロキシとスーパーバイザーで検証する（AGENTS.md）。
- `request.<brand>` の値は、入口のプロキシが計算したものだけを使い、利用者のヘッダーから作らない。
- 拒否のエラーの文言で、内部の構成（どの範囲を拒否したか）を詳しく返さない。
- 時計・コードの生成の逸脱は、セキュリティのための逸脱として固定する。利用者の要望で緩めない（緩めるなら ADR-0013 の改訂）。
- ネイティブの処理（暗号、圧縮）の中では、CPU 時間の監視の `TerminateExecution()` が効かない。1 回の呼び出しの重さに上限を置く（4.4 節、8 節）。
- Node.js の互換のモジュールが増えても、網と時計の約束は外向きのプロキシとランタイムの層で守る。モジュールの有無に頼らない。

## 10. テスト

| 種類 | 対象 | 確かめること |
| --- | --- | --- |
| WPT | 7 節 | 門の 2 つの条件 |
| 結合 | `fetch` の宛先 | 私的なアドレス・IMDS・DNS の再束縛・リダイレクトが `TypeError` になり、文言に内部の情報がない |
| 結合 | サブリクエストの数 | 上限の数ちょうどで通り、1 つ超えで失敗する。数はプロキシの値 |
| 結合 | WebSocket | サーバー（`WebSocketPair`）とクライアント（`new WebSocket`）の往復、切断、上限の大きさ |
| 結合 | `request.<brand>` | 合成の要求で各欄の値。利用者の `<Brand>-*` のヘッダーで上書きできない。`clientTcpRtt` が `undefined` |
| 結合 | Node.js の互換 | `node:net` の接続と `node:dns` の問い合わせが理由の分かるエラーになる。`node:fs` の `/bundle` の読み込み、`/tmp` の書き込み、外が見えない |
| 結合 | Web Crypto | PBKDF2 の反復 100,000 で通り、100,001 で `NotSupportedError` |
| 互換 | 互換の日付 | Node.js の互換の既定が 2026-08-03 と 2026-08-04 で切り替わる |
| 表駆動 | ECMA-429 のグローバル | 4.1 節の表の各項目が存在する（`typeof`）。逸脱の項目が例外・止まった値になる |

テスト名には要件の ID を含める（開発リポジトリの `specs/` で採番する）。

## 11. この領域の ADR

| ADR | 決定 |
| --- | --- |
| [0014](../decisions/0014-wintertc-conformance-and-wpt.md) | ECMA-429 の全インターフェイスを上流の実装で持つ。時計と実行時の Wasm のコンパイルは、理由付きの逸脱の一覧に載せる。WPT の部分集合で、上流を下回らない・退行しないを毎週の取り込みの門にする |
| [0015](../decisions/0015-nodejs-compat-scope.md) | Node.js の互換は上流の組み込みの範囲と日付に従い、polyfill は CLI が足す。TCP のソケットと DNS に依る接続・問い合わせは MVP で理由の分かるエラーにする |
| [0016](../decisions/0016-request-brand-metadata.md) | 要求の属性は `request.<brand>` に置き、`request.cf` の別名を置かない。S1 で正しく出せる欄だけを埋め、TCP の往復などは `undefined` にする。モジュールの名前空間も `<brand>:` にする |

## 12. Story の候補

| Epic | Story の候補 |
| --- | --- |
| E2 | ECMA-429 の対応の表と、WPT のディレクトリの対応付け（`wpt/coverage.md`） |
| E2 | WPT の部分集合の CI（期待の一覧、逸脱の理由、門の 2 つの条件、20 分以内） |
| E2 | `brand` のパッチ：`request.<brand>`、`<brand>:` のモジュールの名前空間、`navigator.userAgent` |
| E2 | PBKDF2 の反復の上限と、重いネイティブの API の一覧 |
| E2 | Node.js の互換の範囲の確認（上流の版ごと）と、`node:net`・`node:tls`・`node:dns` の失敗の形 |
| E2 | `node:fs` の `/tmp` が要求ごとに消えることとメモリの数え方の回帰テスト |
| E4 | 入口のプロキシで `request.<brand>` の値を計算してランタイムへ渡す（TLS の欄、`colo`、ヘッダーとの一致） |
| E4 | 位置の表・AS の表の提供元の選定、ノードへの配布と検証 |
| E4 | 外向きのプロキシの `fetch`・WebSocket・リダイレクトの検査、サブリクエストの数の強制 |
| E6 | CLI の polyfill（unenv に相当）の同梱と、`request.cf` の lint の警告 |
| E6 | 互換の状況の表（Node.js の API、ECMA-429、WPT の通過率）の公開の文書 |
| E11 | サブリクエストの数・WebSocket の上限の値の決定（limits-and-billing） |

## 13. 未解決の問い

- 位置の表・AS の表の提供元をどれにするか。ライセンス（商用の利用、再配布の禁止）と、日本の地域の精度。
- `node:dns` を、外向きのプロキシの名前の解決（DoH など）で開くか。
- TCP のソケット（`connect()`）を、MVP の後のいつ開くか。開くときの宛先の制限（ポート、SMTP の禁止など）。
- WebSocket の 1 つのメッセージの大きさと接続の時間の上限。→ 2026-09-27 に本家の値（受信 32 MiB）を確かめ、同じにした（4.5 節）。
- `navigator.userAgent` の値の実際の名前（`<Brand>` の決定の後）。
- ECMA-429 の次のスナップショット（2026 年）で増えた API への追従を、上流に任せるか。
- `onerror` など、上流の実装の有無が分からなかった項目の実際。→ 上流のソースで確かめた（4.1 節の表）。

### 決定

2026-09-27 の既定案。

- 位置の表・AS の表は、商用の利用と、ノードへの配布（多数の複製）がライセンスで許されるものから、E4 の着手前に選ぶ。法務の確認（L6 に近いライセンスの問い）を経る。
- `node:dns` は S1 で閉じたまま。需要が出たら、外向きのプロキシの名前の解決を使う形で ADR-0015 を改訂する。
- TCP のソケットは MVP の後の Epic で扱う。開くときは、SMTP（25 番）を既定で閉じ、宛先の検査を `fetch` と同じにする。
- ECMA-429 の次のスナップショットへの追従は、上流の workerd に任せ、WPT の門で確かめる。
- 実装の有無が分からなかった項目は、E2 の最初の WPT の実行で確かめ、4.1 節の表を更新する。

## 14. quality.md・runbooks・data-model に載せるもの

**quality.md**

- リスク：標準からの意図しない逸脱と退行（K7）。WPT の部分集合の門を、毎週の取り込みと V8 の緊急の経路に置く。
- リスク：`fetch` の拒否の抜け（SSRF）。外向きのプロキシの結合テストと、本番の探り（[sandbox-and-security.md](sandbox-and-security.md) の 9.1 節）。
- リスク：`request.<brand>` の値の偽装。利用者のヘッダーで上書きできないことの結合テスト。
- 本番での検証：合成の関数で、`request.<brand>` の `country`・`colo` が合成監視の発信の場所と合うことを 5 分ごとに確かめる。

**runbooks**

- `wpt-regression-blocked`：毎週の取り込みが WPT の退行で止まった。上流の失敗かの切り分け、期待の一覧の変更の手順（理由と承認）。
- `geoip-table-update-failed`：位置の表・AS の表の更新の失敗。前の版の継続と、古さの上限（30 日）。
- `egress-false-deny`：正当な宛先が拒否される。一覧の見直しと、セキュリティの担当のレビュー。
- SLI の追加の依頼（Ops へ）：WPT の通過数（上流との差）、`fetch` の拒否の数（理由ごと。セキュリティの担当だけが見る）、位置の表の古さ。

**data-model**

| テーブル・保存 | 主な列 | 備考 |
| --- | --- | --- |
| `wpt_runs`（CI の記録） | `runtime_version`、`upstream_tag`、`suite`、`passed`、`failed`、`known_deviation`、`upstream_passed`、`regressions`、`run_at` | テナントの表ではない。通過率の公開に使う |
| `wpt_expectations`（開発リポジトリのファイル） | `test_path`、`expectation`（`pass`・`fail`）、`reason`、`adr` | 正本はファイル |
| `geo_tables`（配布の記録） | `kind`（`geo`・`asn`）、`version`、`provider`、`sha256`、`published_at` | ノードへは設定の写しと同じ経路で配る |
| `request.<brand>` の値 | 5.2 節の欄 | 保存しない。ログに残すかは observability の領域と法務（L2 の通信の秘密）の確認次第 |

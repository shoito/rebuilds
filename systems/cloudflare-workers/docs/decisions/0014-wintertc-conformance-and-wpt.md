---
status: accepted
date: 2026-09-27
---

# ADR-0014: ECMA-429 の全インターフェイスを持ち、セキュリティのための逸脱を一覧にし、WPT の部分集合を取り込みの門にする

詳細は [web-apis-and-compat.md](../architecture/web-apis-and-compat.md) の 4 節と 7 節。

## Context

intent の価値の 2 は「標準のまま書ける」で、K7 は「WinterTC の最小の共通 API（ECMA-429）の対象の WPT の通過率が、同じ版の上流の workerd を下回らない」である。

- ECMA-429 の第 1 版（2025 年のスナップショット）は、2025-12-10 の Ecma の総会で承認された。W3C・WHATWG の API の部分集合で、`fetch` の系、Streams、URL、Web Crypto、`WebAssembly` の名前空間（`compileStreaming`・`instantiateStreaming` を含む）、`Performance`、タイマーなどを含む。`WebSocket` は含まない。適合の判定に WPT を使うとは書かれていない（[ECMA-429](https://ecma-international.org/publications-and-standards/standards/ecma-429/)、[Minimum Common Web API](https://min-common-api.proposal.wintertc.org/)、2026-09-27 に確認）。
- 本家は、セキュリティのために `eval`・`new Function`・Wasm の実行時のコンパイルを禁じ、時計を止める（[Web standards](https://developers.cloudflare.com/workers/runtime-apis/web-standards/)、[Performance and timers](https://developers.cloudflare.com/workers/runtime-apis/performance/)、2026-09-27 に確認）。これは ECMA-429 の `WebAssembly.compileStreaming` などと、High Resolution Time の `performance.now()` の振る舞いと食い違う。
- 上流の workerd は `src/wpt` に WPT の設定を持つ（[workerd の src/wpt](https://github.com/cloudflare/workerd/tree/main/src/wpt)、2026-09-27 に確認）。

## Options

1. **ECMA-429 の全インターフェイスを持ち、セキュリティ・MVP の範囲による逸脱を理由付きの一覧にする。WPT の部分集合で「上流を下回らない」「退行しない」を門にする**
2. **ECMA-429 に完全に適合する**（時計を進め、実行時の Wasm のコンパイルを許す）
3. **適合を目標にせず、本家の振る舞いだけに合わせる**

## Decision

1 を採用する。

- ECMA-429 の全インターフェイスとグローバルを、上流の実装で持つ。
- 逸脱は次に限り、それぞれ理由と ADR を付けて一覧にする。
  - 時計が実行中に進まない（[ADR-0013](0013-spectre-mitigations-and-dynamic-isolation.md)）
  - `WebAssembly.compile`・`compileStreaming`・`instantiateStreaming`・バッファからの `instantiate` の禁止（[ADR-0008](0008-bundle-format-and-compatibility-dates.md)）
  - Node.js の互換の TCP・DNS（[ADR-0015](0015-nodejs-compat-scope.md)）
- `navigator.userAgent` は単一の製品の記号 `'<Brand>-Workers'`。
- WPT は上流の `src/wpt` の設定を土台にし、試験ごとの期待の一覧を持つ。理由のない既知の失敗を認めない。
- 門（毎週の取り込みと V8 の緊急の経路）：通る数が、同じ版の上流の数から逸脱の分を引いた数を下回らない。前の週に通った試験が新しく失敗しない。
- 20 分以内に終わるよう並列に回す。緊急の経路では核（fetch・streams・URL・encoding・WebCryptoAPI）だけ。
- 通過率を公開の文書に載せる。
- 2 を採らない理由：Spectre の対策（ADR-0002）と、実行するコードをハッシュで固定する方針を崩す。
- 3 を採らない理由：本家の振る舞いの根拠が見えにくく、他のランタイムとの比べ方を利用者に示せない。

## Consequences

- 良くなること：
  - 逸脱が理由付きで見え、利用者が他のランタイムとの差を判断できる。
  - 上流の変更による退行を、毎週の取り込みで止められる。
- 引き受けるコスト：
  - ECMA-429 に「完全に適合」とは言えない。「逸脱の一覧付きで適合」と説明する。
  - WPT の期待の一覧の保守。

## Confirmation

- CI：門の 2 つの条件。`wpt_runs` に記録する。
- 表駆動テスト：ECMA-429 のグローバルが存在し、逸脱の項目が決めた振る舞い（例外、止まった値）になる。
- 期待の一覧の変更（通る→失敗）は、理由と Dev のテックリードの承認を要する。

---
status: accepted
date: 2026-09-26
---

# ADR-0017: ネットワークの状態と保存領域を、トップレベルのサイトで分割する

## Context

同じサイトの埋め込み（iframe、サブリソース）が、どのトップレベルのサイトの下でも同じ状態（キャッシュ、接続、DNS のキャッシュ、保存領域）を共有すると、それを使ってサイトをまたいで利用者を識別できる（キャッシュの有無による閲覧履歴の推測、保存領域による追跡）。

本家は、これを段階的に分割した。

- HTTP キャッシュ：Chrome 86 で（トップレベルのサイト、フレームのサイト）で分割（[Gaining security and privacy by partitioning the cache](https://developer.chrome.com/blog/http-cache-partitioning)）。その後、クロスサイトのビットと、クロスサイトから始まったトップレベルのナビゲーションの区別を加えた（[is-cross-site bit](https://groups.google.com/a/chromium.org/g/blink-dev/c/cG65eYPYf9w)、[top-level navigations](https://groups.google.com/a/chromium.org/g/blink-dev/c/ZpyP6jjCUJE)。既定になった版は 未検証）。
- 接続・DNS・TLS の状態：（トップレベルのサイト、クロスサイトのビット）で分割（Network State Partitioning、[Intent to Ship](https://groups.google.com/a/chromium.org/g/blink-dev/c/Oj9cS6p40Ws)）。
- 保存領域・Service Worker・通信の API：Chrome 115 から段階的に、トップレベルのサイトを加えて分割（[Storage Partitioning](https://privacysandbox.google.com/cookies/storage-partitioning)）。

後から分割のキーを変えると、キャッシュ・保存領域のディスクの形式と、すべての API の呼び出しの経路を作り直すことになる。最初に決める。

## Options

1. **最初から本家の分割（最新の形）に揃える**
2. **オリジンだけで分ける（分割しない）。後から分割する**
3. **トップレベルのサイトだけで分割する**（Firefox の Network Partitioning に近い）

## Decision

1 を採用する。詳細は [networking.md](../architecture/networking.md) の 5 節と [storage.md](../architecture/storage.md) の 3 節にある。

| 状態 | キー |
| --- | --- |
| 接続、DNS のキャッシュ、TLS・QUIC の再開の情報、ALPN の記録、Reporting・NEL | NetworkAnonymizationKey：（トップレベルのサイト、クロスサイトのビット） |
| HTTP キャッシュ | NetworkIsolationKey：（トップレベルのサイト、フレームのサイト）＋クロスサイトのビット＋クロスサイトから始まったナビゲーションの区別＋URL |
| Cookie | 分割しない（ファーストパーティ）か、CHIPS の分割（[ADR-0016](0016-third-party-cookies-blocked-by-default.md)） |
| 保存領域（localStorage、sessionStorage、IndexedDB、Cache Storage、Service Worker、Storage Buckets）、通信（BroadcastChannel、SharedWorker、Web Locks、Blob URL） | StorageKey：（オリジン、トップレベルのサイト、祖先にクロスサイトがあるかのビット） |
| HSTS | 分割しない |

- キーは Browser が決め、Network サービスへはファクトリに焼き込み、Storage サービスへはハンドルに結び付けて渡す。Renderer はキーを指定できない（[ADR-0003](0003-multi-process-site-isolation.md)）。
- 本家の、分割を一時的に解く deprecation trial には対応しない。Storage Access API で許可された埋め込みにだけ、分割されない状態を渡す。
- 2 は、後から分割するときに、ディスクの形式と API の経路を作り直すことになる。
- 3 は、クロスサイトの iframe とファーストパーティの状態が混ざる（A の中の B の iframe と、B の中の B が別になるが、A の中の A と A の中の B の iframe の接続が共有される）。本家がクロスサイトのビットを加えたのと同じ理由で採らない。

## Consequences

- 良くなること：
  - キャッシュ・接続・保存領域による、サイトをまたいだ追跡と情報の漏洩を防げる。
  - 本家と同じ分割なので、Web Platform Tests と本家の振る舞いで試験できる。
- 引き受けるコスト：
  - キャッシュ・接続の再利用が減り、クロスサイトの iframe と CDN のサブリソースの読み込みが遅くなる。本家の報告と同じく、影響はクロスサイトの iframe で最も大きい。
  - 同じ内容が複数の分割に保存され、ディスクを多く使う。
  - 分割のキーを持ち回るため、すべての API の経路にキーが要る。

## Confirmation

- Web Platform Tests の分割の試験（`storage-partitioning` 関連、`fetch/http-cache`、`service-workers/` の分割の試験）を CI で回す。
- 侵害された Renderer を模して、別の StorageKey の保存領域・別の分割のキャッシュを要求し、拒否されることを確かめる（ADR-0003 の Confirmation と同じ仕組み）。
- 分割のキーの組み合わせ（トップレベルのサイト、フレームのサイト、祖先のクロスサイト）の表で、共有される・されないを表駆動テストで確かめる。

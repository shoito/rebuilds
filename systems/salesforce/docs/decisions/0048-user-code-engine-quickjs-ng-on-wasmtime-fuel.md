---
status: accepted
date: 2026-09-28
---

# ADR-0048: 利用者のコードは QuickJS-ng を WASM にしたものを、Runtime の隣の別のプロセスの Wasmtime で燃料とメモリーの上限を付けて動かす

詳細は [extensibility.md](../architecture/extensibility.md) の 3 節と 4 節。

## Context

[ADR-0001](0001-platform-and-stack.md) は、MVP の後の利用者のコードを TypeScript で書き、JS のエンジンを WASM にしたものを、Runtime とは別のプロセスの WASM の実行系で動かすとした。実行の量を「燃料（命令の数）」で数え、上限の判定を決定的にするためである。エンジンと実行系の選定は、この領域の ADR で PoC をして決めるとした。

求めること：

- 上限の判定が決定的である。同じコードと同じ入力なら、同じ所で止まる（[ADR-0005](0005-tenancy-and-governor-limits.md) の上限の試験が再現できる）。
- 1 回の保存の中で、200 件の塊ごとに何度も呼ばれる（[ADR-0008](0008-dml-order-of-execution.md)）。起動が速く、1 回の呼び出しのメモリーが小さい。
- 砂場の中から DB・ネットワーク・ファイルに直接つながない。
- 本家の実装を使わない（[リポジトリ共通の ADR-0007](../../../../docs/decisions/0007-no-reuse-of-original-implementation.md)）。候補はどれも本家と関係のない第三者の汎用の部品である。

調べたこと（2026-09-28 に確認）：

- Wasmtime の燃料は、生成したコードに数を減らす処理を入れ、同じ初期状態なら同じ量で止まる。epoch による中断は速い（測定で 2〜3 倍の差がある）が、決定的ではない（[Wasmtime `Config`](https://docs.wasmtime.dev/api/wasmtime/struct.Config.html)）。決定的な実行には、NaN の正規化、relaxed SIMD の無効化、メモリーの伸長の扱い、時計などの外からの入力の固定が要る（[Deterministic Wasm Execution](https://docs.wasmtime.dev/examples-deterministic-wasm-execution.html)）。メモリーの上限は `StoreLimitsBuilder` で付けられる（[StoreLimitsBuilder](https://docs.wasmtime.dev/api/wasmtime/struct.StoreLimitsBuilder.html)）。
- QuickJS-ng は、小さく組み込める JS のエンジンで、MIT ライセンス。最新の ECMAScript を目指す。WASI の reactor の入口を持つ。最新のバージョンは v0.17.0（2026-09-18）（[quickjs-ng/quickjs](https://github.com/quickjs-ng/quickjs)）。
- StarlingMonkey は SpiderMonkey を元にした WASM のコンポーネント向けの実行系で、Apache-2.0。WASI 0.2 と fetch・Streams を持ち、Fastly と Fermyon が本番で使う（[bytecodealliance/StarlingMonkey](https://github.com/bytecodealliance/StarlingMonkey)）。
- Javy は JS を WASM にする道具で、Apache-2.0。エンジンは rquickjs（QuickJS-ng の束ね）を使う。静的なリンクで 869KB 以上、動的なリンクで 1〜16KB のモジュールを作る（[bytecodealliance/javy](https://github.com/bytecodealliance/javy)、`crates/javy/Cargo.toml` の依存で確認）。最新のバージョンは v9.1.0（2026-07-30）。
- 事前の初期化（Wizer）は Wasmtime に取り込まれ、`wasmtime wizer` になった（[bytecodealliance/wizer](https://github.com/bytecodealliance/wizer)）。

## Options

エンジン：

1. **QuickJS-ng を自前の薄い殻（Rust、rquickjs）と一緒に WASM にする**
2. StarlingMonkey（SpiderMonkey）
3. Javy の道具で作ったモジュールをそのまま使う

実行の場所：

- a. **Runtime のタスクの中の、別のコンテナの別のプロセス（Rust の Wasmtime のホスト）。Runtime とは UNIX ドメインソケットでつなぐ**
- b. 別の ECS のサービス（網を越えて呼ぶ）
- c. Runtime の Node.js の中（V8 の WASM）で動かす

## Decision

1 と a を採用する。

- エンジンは QuickJS-ng。自前の殻は、ホストの API（[ADR-0049](0049-triggers-in-dml-order-and-platform-api.md)）の結び付けと、値の受け渡し（JSON）だけを持つ。組み込みの `std`・`os` のモジュールは入れない。
- 1 つの WASM のモジュール（エンジン＋殻）を全組織で共有し、`wasmtime wizer` で事前に初期化したものを使う。利用者のコードは、デプロイの時に TypeScript から JS にし、QuickJS-ng のバイトコードにして保存する。呼び出しのたびにモジュールを実体化し、バイトコードを読み込む。
- Wasmtime の設定：`consume_fuel` を有効、epoch は使わない、NaN の正規化を有効、relaxed SIMD・threads を無効。WASI は渡さない（時計・乱数・ファイル・ソケットなし）。時刻はトランザクションの開始の時刻、乱数はトランザクションごとの種から作る値をホストの API で渡す。
- 上限：燃料は `tx.code_fuel`、線形メモリーは `tx.code_memory`（値は [extensibility.md](../architecture/extensibility.md) の 7 節。正本は governor-limits の登録簿）。メモリーは実体化の時に最大の大きさで確保し、伸長の成否が揺れないようにする。
- ホストのプロセス（`code-runner`）は Runtime と Worker のタスクに 1 つずつ持つ別のコンテナにする。IAM の権限・DB の資格情報・秘密を持たない。Runtime とは UNIX ドメインソケット（共有のボリューム）だけでつなぐ。ホストの API の呼び出しは、ソケットで Runtime に戻り、Runtime が開いているトランザクションの中でデータ層を通して行う。
- 1 回の呼び出しの燃料の使用量から、`tx.cpu_ms` にも換算して足す（換算の係数は PoC で決める）。
- 2 は、エンジンが大きく（SpiderMonkey）、WASI 0.2 とコンポーネントの前提で、fetch のような外への API を持つ。本システムは外への API を持たせないので、利点が小さい。1 回の実体化のメモリーも大きいと見込む（未検証。E13 の `code-engine-poc` で測る）。
- 3 は、エンジンは 1 と同じだが、Javy の API（`Javy.IO` など）とバージョンの変化（8.x・9.x の間の変更）に合わせ続けることになる。道具としては参考にし、殻は自前で持つ。
- b は、ホストの API の呼び出しのたびに網を越える。200 件の塊で数百回の往復になり、保存の時間が延びる。
- c は、V8 の WASM に燃料の仕組みがない。決定的な上限の判定ができない。

## Consequences

- 良くなること：
  - 上限の判定が燃料で決定的になり、上限の試験を再現できる。
  - エンジンが小さく、実体化とメモリーが軽い。
  - 砂場の中に外への経路がなく、ホストの API だけが出口になる。
  - 砂場のプロセスが落ちても、Runtime のプロセスは落ちない。
- 引き受けるコスト：
  - QuickJS-ng はインタープリタで、JIT がない。WASM の中でさらに遅くなる。重い計算は利用者のコードに向かない。PoC で、200 件の塊で 1 件あたりの処理の時間を測る。
  - 自前の殻と、バイトコードの形の互換を保守する。QuickJS-ng のバージョンを上げると、保存したバイトコードを作り直す必要がある。QuickJS-ng はバイトコードに形のバージョン（`BC_VERSION`）を書き、読み込みの時に今のバージョンと違えば断る（[quickjs.c](https://github.com/quickjs-ng/quickjs/blob/master/quickjs.c)、2026-09-28 に確認）。
  - Runtime のタスクに、もう 1 つのコンテナの資源を割く。

## Confirmation

- 性質ベーステスト：任意のコードと入力で、同じ燃料の上限なら、止まる場所と使った燃料が毎回同じ。
- 上限の試験：燃料・メモリーの上限ちょうどで通り、超えたらトランザクション全体が巻き戻る。利用者のコードの `try`・`catch` で捕まえられない。
- セキュリティのテスト：砂場の中から時計・乱数・ファイル・ソケット・環境変数に触れられない。`code-runner` のコンテナに IAM のロールと DB の資格情報がない（IaC の検査）。
- PoC（E13 の前）：QuickJS-ng・StarlingMonkey の 1 回の実体化の時間とメモリー、200 件の塊の処理の時間を測り、この ADR の見込みを確かめる。

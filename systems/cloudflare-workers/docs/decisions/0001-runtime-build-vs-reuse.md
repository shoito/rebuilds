---
status: proposed
date: 2026-09-27
---

# ADR-0001: エッジのランタイムは workerd を元にし、多数のテナントの層は Rust で作る

## Context

この題材の中心は、利用者の JavaScript・TypeScript・Wasm を、標準の Web API のまま、数ミリ秒で起動して動かすランタイムである。ランタイムには次の条件がある。

- **セキュリティの修正の速さ**：JavaScript エンジンの脆弱性は、信頼できないコードを動かす基盤にとって最大の脅威である。本家は、V8 の修正の公開から本番への配信までを 24 時間未満にしている（[Security model](https://developers.cloudflare.com/workers/reference/security-model/)、2026-09-27 に確認）。
- **互換性**：WinterTC の最小の共通 API（ECMA-429）と、本家の Workers の Web API に近い振る舞い。互換の日付で、古い振る舞いを保つ。本家は「古い互換の日付を永久に支える」としている（[Compatibility dates](https://developers.cloudflare.com/workers/configuration/compatibility-dates/)、2026-09-27 に確認）。
- **密度と起動の速さ**：1 プロセスに数百〜数千の isolate を載せ、isolate の起動を約 5ms にする（[Cloud Computing without Containers](https://blog.cloudflare.com/cloud-computing-without-containers/)、2026-09-27 に確認）。
- **チームの技能**：rebuilds の他の題材は TypeScript を共通にしている。エッジのノードの部品は、遅延とメモリの安全が重い。

本家は 2022-09-27 にランタイムを workerd として公開した（Apache-2.0）。1 プロセスで多数の Worker を isolate ごとに動かし、互換の日付を持つ。ただし、上流は「単体では、実装の欠陥に対する多層の防御を持たない。悪意のあるコードを動かすときは、VM などのサンドボックスの中で動かすこと」と明記している（[Introducing workerd](https://blog.cloudflare.com/workerd-open-source-workers-runtime/)、[workerd の README](https://github.com/cloudflare/workerd)、2026-09-27 に確認）。workerd は C++ で書かれ、設定は Cap'n Proto の形式で、版の番号は対応する互換の日付の最大値である（同 README）。

## Options

1. **workerd を元にする。** 上流との差分を最小に保ち、多数のテナントのための層（テナントの動的な読み込み、スーパーバイザー、サンドボックス、外向きのプロキシ）を周りに作る
2. **自前で V8 を Rust から組み込む。** rusty_v8（`v8` クレート）や deno_core の上に、Web API とランタイムを作る（Deno・Deno Deploy の方式に近い）
3. **Wasm だけのランタイムにする。** Wasmtime で Wasm を動かし、JavaScript は Wasm にコンパイルした JavaScript エンジンで動かす（Fastly Compute の方式に近い。[Getting started with Compute](https://www.fastly.com/documentation/guides/compute/getting-started-with-compute/)、2026-09-27 に確認）

## Decision

1 を採用する。

- **ランタイムは workerd を元にする。** 本家の Web API・互換の日付・isolate の管理を、そのまま引き継げる。本家と振る舞いが近いことは、利用者の移行と、互換の試験の両方で効く。
- **上流との差分は最小にする。** 上流に送れる修正は送る。自分たちのパッチは、一覧に理由とともに記録し、上流の版の更新のたびに自動で当て直す。ブランドに関わる名前（`request.cf` に相当する属性など）は、差分の中で `<brand>` の名前に置き換える（[リポジトリ共通の ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。
- **V8 は自分たちでビルドする。** workerd が固定する V8 の版に、上流の修正を自分たちで当てられるようにする。修正の配信は、通常のリリースと別の緊急の経路で行い、NFR-007（24 時間以内）を守る。
- **多数のテナントの層は、自前の Rust の部品で作る。** 入口のプロキシ、スーパーバイザー（プロセスの起動と cordon）、外向きのプロキシ、設定の写しの受け手。workerd の外側に置き、workerd のプロセスとは Unix ドメインソケットでだけ通信する（[ADR-0002](0002-isolation-model.md)）。
- **テナントのコードの動的な読み込みと、テナントごとの CPU・メモリの制限**：公開版の workerd がこれをどこまで持つかは未検証である。E2 の PoC で確かめ、足りなければ workerd の中に最小の拡張を作る（可能なら上流に送る）。
- **制御プレーンは、rebuilds の共通の技術を使う。** AWS、TypeScript（Hono＋Zod）、Aurora PostgreSQL 18、Terraform、OpenTelemetry。テナントテーブルは `account_id` と RLS で分ける（他の題材と同じ）。
- **CLI は TypeScript で作り、ローカル開発では workerd のバイナリを同梱して動かす。** 本番と同じランタイムで手元を動かす。
- 2 を採らない理由：
  - Web API（`fetch`、Streams、Web Crypto、WebSocket）と互換の日付を一から作ることになり、MVP までの量が大きい。
  - 本家との振る舞いの差が増え、利用者の移行が難しくなる。
  - V8 の修正の追従は、rusty_v8 の版の上がり方にも依存する。Chrome の題材では rusty_v8 を選んだが（[chrome の ADR-0010](../../../chrome/docs/decisions/0010-v8-embedding-and-dom-gc.md)）、ブラウザは DOM を自作するので、Web API の既存の実装を使い回す利点がこの題材ほど大きくない。
- 3 を採らない理由：
  - Wasm にコンパイルした JavaScript エンジンは、V8 の JIT より遅い（程度は未検証）。
  - 利用者が書いた JavaScript・TypeScript を、そのまま Web API で動かすという価値（intent の 2）から遠くなる。
  - 要求ごとに新しいサンドボックスを作る方式は隔離が強いが、Durable Objects のような長く生きるアクターと合わせにくい。
  - Wasm のモジュールは、選択肢 1 でも V8 の Wasm として動かせる。

## Consequences

- 良くなること：
  - Web API と互換の日付を、本家と同じ実装から得る。MVP までの量が小さい。
  - ローカル開発と本番が、同じランタイムで動く。
  - 本家の V8 の追従の作業（workerd の上流の更新）の恩恵を受けられる。
- 引き受けるコスト：
  - ランタイムの中心が C++ になる。自分たちの差分は C++ で書くので、メモリの安全は Rust の部品より弱い。差分は小さく保ち、ASan のビルドとファズで確かめる。
  - 上流の設計の変更（API、設定の形式）に追従し続ける。上流が方針を変えたときの依存の危険がある。上流は本家の Workers のチームが主に開発している（[Introducing workerd](https://blog.cloudflare.com/workerd-open-source-workers-runtime/)）。
  - 多数のテナントの層（本家が公開していない部分）を自前で作る。その量は未検証で、E2・E3 の最大の不確実性である。
  - C++ と V8 のビルド（Bazel）と、Rust と TypeScript の 3 つの言語の道具を持つ。エージェントと人が使う道具の数が増える。

## Confirmation

- CI：上流の workerd の最新の版に、自分たちのパッチの一覧が当たり、テストが通ることを毎日確かめる。当たらなくなったら、その日のうちにチケットにする。
- V8 の修正の訓練：上流の過去の修正を 1 つ選び、取り込みから全ノードへの配信まで 24 時間以内に終わることを、四半期ごとに訓練する（runbooks）。
- 自分たちの C++ の差分に、ASan・UBSan のビルドとファズの対象を必ず付ける（[AGENTS.md](../../AGENTS.md)）。
- WinterTC の最小の共通 API の WPT の通過率が、同じ版の上流の workerd を下回らないことを CI で確かめる（intent の K7）。

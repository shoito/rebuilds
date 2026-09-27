---
status: accepted
date: 2026-09-27
---

# ADR-0007: isolate は関数の版の鍵で再利用し、予備・シャード・先読みで温め、メモリの圧力で段階的に退避する

詳細は [runtime-and-isolates.md](../architecture/runtime-and-isolates.md) の 5 節と 7.2 節。

## Context

NFR-001 は、isolate の起動 p99 5ms 未満（コードがノードにあり、バンドルが 1MiB 以下、トップレベルの実行を除く）を求める。一方で、ノードのメモリは有限で、S1 で 5 万関数を 5 リージョンに載せる。どの isolate を温かく持ち、どれを捨てるかを決める必要がある。

本家の方式（2026-09-27 に確認）：

- TLS の ClientHello の SNI で、その Worker を先に読み込む（[Eliminating cold starts](https://blog.cloudflare.com/eliminating-cold-starts-with-cloudflare-workers/)、2020-07-30）。
- データセンターの中で、スクリプトのハッシュを一貫性ハッシュの環に置き、ホームのサーバーへ寄せる。退避の率が 10 分の 1 になり、温かい要求が 99.99% になった（[Eliminating Cold Starts 2](https://blog.cloudflare.com/eliminating-cold-starts-2-shard-and-conquer/)、2025-09-26）。
- isolate は、機械の資源の不足・怪しいスクリプト・制限の超過で、イベントが解決した後に退避する（[How Workers works](https://developers.cloudflare.com/workers/reference/how-workers-works/)）。
- 上流の workerd には `workerLoader` のバインディングがあり、名前で Worker を読み込み、使われない Worker を自動で降ろす（[workerd.capnp](https://github.com/cloudflare/workerd/blob/main/src/workerd/server/workerd.capnp)）。

## Options

1. **関数の版ごとの isolate を温かく持ち、空の isolate の予備・リージョンの中のシャード・SNI の先読みで冷たい起動を減らし、メモリの圧力で段階的に退避する**
2. **要求ごとに isolate を作って捨てる**（使い捨て）
3. **全関数を全ノードで常に温かく持つ**

## Decision

1 を採用する。

- isolate の鍵は `(account_id, script_id, version_id)`。同じ鍵の中でだけ再利用する。
- テナントのコードは、上流の `workerLoader` を元にしたテナントのローダー（パッチ）で読み込む。バンドルはスーパーバイザーが読み込み専用の memfd で渡し、モジュールの名前はマニフェストの中だけで解決する。
- 各ランタイムのプロセスは、テナントのコードを読む前の空の isolate を既定で 8 個（自動で 4〜32）持つ。テナントのコードを一度読んだ isolate は予備に戻さない。上流の構造のまま作れるかは E2 の PoC で確かめる。
- V8 のコードのキャッシュは、ノードの中だけで `(bundle_sha256, v8_version, v8_flags_hash)` の鍵で持つ。ノードの間で共有しない。
- 入口のプロキシは SNI で先読みを送り、リージョンの中の一貫性ハッシュでホームのノードへ転送する。ホームの CPU が 70% 以上なら断り、元のノードで動かす（実装は edge-network-and-routing の領域）。
- 退避：使われずに 15 分（プロセスのメモリが予算の 50% 超のとき）、soft 70% でスコア順（経過秒 × MiB ÷ cordon の重み）、hard 85% で新しい isolate を受けない。処理中の要求がある isolate は soft の段で捨てない。cgroup の `memory.max` は予算の 110%。
- 版の切り替えでは、古い版の isolate は新しい要求を受けず、最大 30 秒で捨てる。
- 2 を採らない理由：NFR-001 の予算の中で、毎回モジュールの解析とトップレベルの実行を払う。グローバルの状態を使う利用者のコードの前提（本家では再利用が普通）とも合わない。
- 3 を採らない理由：5 万関数 × 数 MiB を全ノードに置くメモリがない。

## Consequences

- 良くなること：
  - 要求の多い関数は、ほぼ常に温かい isolate で動く。
  - 退避が段階的で、プロセスの OOM（全テナントの停止）の前に止まる。
- 引き受けるコスト：
  - スーパーバイザーの isolate の表、予備、シャードの転送の実装。
  - シャードの転送で、ノードの間の 1 往復（リージョンの中）が加わる。NFR-002 の予算に含めて計る。
  - 空の isolate の予備が作れない場合、NFR-001 を V8 のスナップショットとコードのキャッシュだけで満たせるかは未検証。

## Confirmation

- 性質ベーステスト：別の鍵の要求が同じ isolate に渡らない。soft の段で処理中の isolate を捨てない。
- 負荷試験：冷たい起動の p99（NFR-001）、プロセスのメモリが `memory.max` を超えないこと。
- 本番の指標：冷たい起動の率、退避の率（理由ごと）、プロセスの OOM の数（0 を目標）。

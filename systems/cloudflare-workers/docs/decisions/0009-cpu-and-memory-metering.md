---
status: accepted
date: 2026-09-27
---

# ADR-0009: CPU 時間はスレッドの CPU 時計と監視のスレッドで、メモリは isolate ごとの合計で測り、止める

詳細は [runtime-and-isolates.md](../architecture/runtime-and-isolates.md) の 6 節。

## Context

NFR-005 は、CPU 時間の上限を超えた isolate を上限＋10ms 以内に止め、メモリの上限（128MiB）を超えた isolate を、同じプロセスの他の isolate を止めずに退避することを求める。制限による停止が、他のテナントの p99 を 1ms 以上悪くしてはならない。

- 公開版の workerd は制限を強制しない（`NullIsolateLimitEnforcer`、「制限を強制しない」。CPU 時間の報告も 0）。差し込み口（`IsolateLimitEnforcer`）だけがある（[server.c++](https://github.com/cloudflare/workerd/blob/main/src/workerd/server/server.c%2B%2B)、2026-09-27 に確認）。
- 本家：CPU 時間は無料 10ms、有料は既定 30 秒・最大 5 分。ネットワークの待ちは数えない。isolate にはときどきの超過を許す余裕がある。メモリは isolate あたり 128MB で、JavaScript のヒープと Wasm の割り当てを含む（[Limits](https://developers.cloudflare.com/workers/platform/limits/)、2026-09-27 に確認）。
- 上流の V8 のパッチに、ヒープと外のメモリの大きさを分けて取る API がある（0020・0030。[v8.MODULE.bazel](https://github.com/cloudflare/workerd/blob/main/build/deps/v8.MODULE.bazel)）。

## Options

1. **ランタイムの中で測って止める。** CPU 時間はスレッドの CPU 時計を isolate のロックの出入りで測り、監視のスレッドで `TerminateExecution()` を呼ぶ。メモリはヒープと外のメモリの合計
2. **プロセスの外で止める。** cgroup の CPU とメモリの制限だけに頼る
3. **isolate ごとに OS のスレッドを分け、スレッドの CPU 時間の上限（`RLIMIT_CPU` など）で止める**

## Decision

1 を採用する。`IsolateLimitEnforcer` を自前のパッチで実装する（分類 `multitenant`。[ADR-0006](0006-workerd-fork-and-upstream-tracking.md)）。

- CPU 時間：`CLOCK_THREAD_CPUTIME_ID` を isolate のロックの出入りで読み、要求ごとに足す。主スレッドの GC は含める。監視のスレッドが 1ms ごとに検査し、超えたら `TerminateExecution()`。その要求は `exceededCpu`。同じ isolate で 3 回続けたら isolate を捨てる。
- 余裕は S1 で持たない（上限で止める）。
- メモリ：ヒープと外のメモリの合計を isolate ごとに 128MiB で止める。V8 のヒープの上限は 144MiB にし、`NearHeapLimitCallback` で GC を促す。要求の終わりと 1 秒ごとの検査で超えたら、処理中の要求を `exceededMemory` にして isolate を捨てる。上限を超える `memory.grow` と大きな `ArrayBuffer` は、割り当ての時点で失敗させる。
- 起動：トップレベルの CPU 時間を 1 秒で止める。
- 監視のスレッドの心拍が 100ms 途切れたら、スーパーバイザーがプロセスを SIGKILL する。
- 呼び出しごとに `cpu_us`・`wall_ms`・`outcome` などをスーパーバイザーへ送る。課金は `cpu_us` を使い、記録が届かない呼び出しは課金しない。
- 2 を採らない理由：cgroup はプロセスの単位で、1 つのプロセスに多数のテナントがいる。1 つのテナントの超過でプロセスが止まり、他のテナントを巻き込む。cgroup はプロセスの最後の守り（OOM の前の上限）にだけ使う。
- 3 を採らない理由：isolate の数だけスレッドが要り、密度と文脈の切り替えの費用が合わない（ADR-0002）。

## Consequences

- 良くなること：
  - 超過したテナントだけが止まる。課金と同じ値で制限をかけられる。
- 引き受けるコスト：
  - 自前の C++ のパッチ。`TerminateExecution()` の後の isolate の状態の扱いに注意が要る（3 回で捨てる）。
  - 1ms ごとの検査の費用（プロセスあたり 1 スレッド）。
  - 余裕を持たないので、本家より `exceededCpu` が増えうる。

## Confirmation

- 結合テスト：無限ループが無料で 10〜20ms、有料で上限＋10ms 以内に止まる。128MiB を超える配列・`ArrayBuffer`・`memory.grow` が止まる。同じ isolate・同じプロセスの他の要求は続く。
- 負荷試験：超過する isolate を混ぜたとき、他のテナントの p99 の悪化が 1ms 未満（NFR-005）。
- ファズと ASan・UBSan：`IsolateLimitEnforcer` の実装。

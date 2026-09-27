---
status: accepted
date: 2026-09-27
---

# ADR-0013: 時計を止め、スレッドとネイティブのコードを禁じ、性能カウンターで疑わしい関数を隔離し、プロセスを毎日入れ替える

詳細は [sandbox-and-security.md](../architecture/sandbox-and-security.md) の 6 節。

## Context

isolate はプロセスの中の境界で、Spectre のような CPU のサイドチャネルは、V8 の欠陥がなくても、同じプロセス・同じコアの他のテナントのメモリを推測しうる。V8 自身は Spectre を防げないとされる。

本家の対策（[Mitigating Spectre…](https://blog.cloudflare.com/mitigating-spectre-and-other-security-threats-the-cloudflare-workers-security-model/)、2020-07-29、[Security model](https://developers.cloudflare.com/workers/reference/security-model/)、[Performance and timers](https://developers.cloudflare.com/workers/runtime-apis/performance/)、すべて 2026-09-27 に確認）：

- `Date.now()`・`performance.now()` は最後の I/O の時刻を返し、実行中は進まない。`performance.timeOrigin` は 0。ローカル開発では進む。
- マルチスレッドと `SharedArrayBuffer` を許さない。ネイティブのコードを受け付けない。
- CPU の性能カウンターで疑わしい Worker を検知し、分離したプロセスへ移す（TU Graz と協力。検知の指標と閾値は公開されていない）。
- ランタイムを毎日入れ替え、メモリの配置を変え、Worker を配置し直す。

## Options

1. **本家と同じ 4 つの対策**（止めた時計、スレッドとネイティブのコードの禁止、性能カウンターでの検知と隔離、毎日の入れ替え）
2. **止めた時計とスレッドの禁止だけ**（検知と入れ替えを持たない）
3. **全テナントをプロセスで分ける**（サイドチャネルの境界をプロセスにする）

## Decision

1 を採用する。

- 時計：`Date.now()`、`new Date()`、`performance.now()` は最後の I/O の時刻を返す。上流の公開版で止まらなければ、パッチで止める（E3 の最初に確かめる）。
- `SharedArrayBuffer`・`Atomics.wait`・Wasm の共有メモリとスレッド・Web Workers を持たない。同じ isolate で同時に CPU を使うのは 1 つの要求だけ。ネイティブのコードと実行時のコードの生成を禁じる。
- 性能カウンター：スーパーバイザー（`perf_event` を使える唯一のプロセス）が、ワーカーのスレッドごとに LLC のミスと分岐の予測の失敗（使えれば TLB のミス）を計り、isolate のロックの出入りの知らせで isolate に割り当てる。関数の版ごとに CPU 時間あたりの率を 1 分の窓で集計し、cordon ごとの閾値を超えたら `cq-quarantine` の 1 プロセス 1 関数へ移す。24 時間で解き、7 日に 3 回以上ならセキュリティの担当が調べる。関数の持ち主には知らせない。
- 閾値は E3 の実験（既知の Spectre の概念実証と、正当な重い処理の率の分布）で決め、S1 の GA までにこの ADR を改訂して値を書く。誤検知の目標は、有料の cordon の関数の 0.1% 未満。
- ランタイムのノードは、ゲストからハードウェアの性能カウンターを使える EC2 の型・大きさにする。使えない型は本番に入れない。
- 全ランタイムのプロセスを 24 時間以内に 1 回、1 時間にノードのプロセスの 1/24 以下の割合で入れ替え、cordon の中の割り当てのハッシュの種を変える。
- 2 を採らない理由：止めた時計は攻撃を遅くするだけで、外から応答の時間を測る方法が残る。長く続く攻撃を見つけて引き離す手段が要る。
- 3 を採らない理由：密度が合わない（ADR-0002）。専用の段階でだけ使う。

## Consequences

- 良くなること：
  - 同じプロセスでの長い時間をかけた推測を、検知・隔離・入れ替えで断ち切れる。
- 引き受けるコスト：
  - 正確な計時と CPU の並列の処理ができない（利用者の制約）。
  - 性能カウンターを使える型に限ることで、インスタンスの選択肢と費用が制約される（型の条件は Intel の資料だけで、AWS の公式の一覧はない。未検証。E1 の `instance-pmu-pku-check` で確かめる。[ADR-0050](0050-runtime-fleet-instance-types.md)）。
  - 閾値の調整と誤検知の扱いの運用。
  - 毎日の入れ替えで冷たい起動が増える。

## Confirmation

- 脱出のテスト：重い計算の前後の時計の差が 0、`SharedArrayBuffer`・スレッドが存在しない。
- E3 の実験：既知の概念実証の関数が 1 分の窓の中で隔離され、正当な重い処理の関数の誤検知が目標の中に収まる。
- 本番の指標：隔離の数と率、毎日の入れ替えの完了率（24 時間以内に 100%）。

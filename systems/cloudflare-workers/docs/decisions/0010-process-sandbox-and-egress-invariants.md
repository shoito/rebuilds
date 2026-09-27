---
status: accepted
date: 2026-09-27
---

# ADR-0010: ランタイムのプロセスは名前空間・seccomp・cgroup v2 の中で動かし、外への経路は外向きのプロキシだけにする

詳細は [sandbox-and-security.md](../architecture/sandbox-and-security.md) の 4 節と 7 節。

## Context

[ADR-0002](0002-isolation-model.md) は、L1 isolate の下に L2 プロセスのサンドボックス、L4 外向きのプロキシ、L5 ホストとアカウントを重ねると決めた。その具体（名前空間、システムコールの許可、宛先の拒否）を決める。

- 上流は「workerd は単体では十分な多層の防御を持たない。VM などのサンドボックスの中で動かすこと」と明記している（[workerd の README](https://github.com/cloudflare/workerd)、2026-09-27 に確認）。
- 本家は、プロセスの起動の後、isolate を読み込む前に名前空間と seccomp を設定する。ファイルシステムは空で、その系のシステムコールをすべて禁じ、網も禁じて Unix ドメインソケットだけにする（[Mitigating Spectre…](https://blog.cloudflare.com/mitigating-spectre-and-other-security-threats-the-cloudflare-workers-security-model/)、[Security model](https://developers.cloudflare.com/workers/reference/security-model/)、2026-09-27 に確認）。
- workerd の外への通信は、既定で公開のアドレスだけに届く（[workerd.capnp](https://github.com/cloudflare/workerd/blob/main/src/workerd/server/workerd.capnp) の `Network`、2026-09-27 に確認）。
- 本家は V8 のサンドボックスを 2025-08-14 に有効にした（[Changelog](https://developers.cloudflare.com/workers/platform/changelog/)）。V8 のサンドボックスは、典型的な作業で 1% 以下の負担で、まだ強い境界とは見なされない（[The V8 Sandbox](https://v8.dev/blog/sandbox)）。

## Options

1. **名前空間（利用者・マウント・網・PID・IPC・UTS・cgroup）＋ seccomp の許可リスト ＋ cgroup v2。外への経路は、受け継いだソケットでスーパーバイザーの外向きのプロキシへ渡すだけ**
2. **ランタイムのプロセスを gVisor などの利用者空間のカーネルの中で動かす**
3. **ランタイムのプロセスを microVM（Firecracker）の中で動かす**（VM に多数のテナントを載せる）
4. **workerd の `Network` の許可・拒否の一覧だけに頼る**（プロセスの網を残す）

## Decision

1 を採用する。

- スーパーバイザーが、利用者の名前空間の中の cordon ごとの UID で、空の読み込み専用の tmpfs を根にし、網は lo だけ（落としたまま）、capability なし、`PR_SET_NO_NEW_PRIVS` でランタイムのプロセスを起動する。
- 初期化（ICU、V8 のスナップショット、スレッドの作成）を終えてから、テナントのコードを読み込む前に、seccomp の許可リストを全スレッドに適用する。適用の口は workerd へのパッチで作る。
- seccomp は既定で拒否し、違反でプロセスを落とす。許可はメモリ・同期・既存の記述子の I/O・時刻と乱数・シグナルだけ。ファイルシステムの系、`execve`、`socket` の系、`ptrace`、`io_uring_setup`、`bpf`、`userfaultfd`、`perf_event_open`、`clone`（作り切った後）を拒否する。
- cgroup v2：`memory.max` は予算の 110%、スワップなし、`pids.max` はスレッドの数＋4、`cpu.weight` は cordon ごと。
- 外への経路は、外向きのプロキシだけ。プロキシは名前の解決の後に IP を検査し、リンクローカル（IMDS の `169.254.169.254`・`fd00:ec2::254` を含む）、私的なアドレス、VPC、ループバック、予約の範囲、自分たちの anycast の IP を拒否する。止まったら閉じる。
- ホスト：IMDSv2 必須でホップの上限 1、インスタンスロールは最小、エッジのフリート・検証のフリート・security-lab は別の AWS アカウント。
- V8 のサンドボックスを有効にしてビルドし、無効なら CI で失敗させる。上流の既定のビルドでは無効（下の注記）。
- ランタイムのノードは x86-64 にする（PMU の条件と、S2 の前の MPK の再評価のため。MPK は S1 では使わない。下の注記）。
- 2 を採らない理由：システムコールの横取りの負担が、V8 の JIT と大量の I/O に対して大きい（程度は測っていない）。本家も採っていない。seccomp の許可リストで攻撃面を十分に絞れる。
- 3 を採らない理由：VM の中に多数のテナントを載せても、同じ VM の中のテナントの間の境界は 1 と同じで、VM の境界はホストの守りを足すだけ。EC2 の中で入れ子の仮想化（metal でない型）の制約と費用がある。専用の段階の強化と、MVP の後のコンテナで再評価する。
- 4 を採らない理由：workerd の欠陥 1 つで網に出られる。独立した層にならない。

## Consequences

- 良くなること：
  - V8 の欠陥だけでは、ファイル・網・ホストの資格情報に届かない。
  - 外への通信の制限が、ランタイムの外（Rust のプロキシ）に集まり、検査しやすい。
- 引き受けるコスト：
  - 上流の取り込みで、新しいシステムコールの利用が入ると、許可リストの更新が要る。
  - 利用者の名前空間をホストで許す（スーパーバイザーの利用者だけ）。カーネルの攻撃面が増える。
  - x86-64 に限ることで、arm64 の価格の利点を捨てる。

## Confirmation

- 脱出のテスト（ファイル、網、システムコール）を CI・ステージング・本番の探りで回す。
- ステージングで、同じ許可リストを監査のモードで回し、記録が空であることを上流の取り込みのたびに確かめる。
- ノードの起動時とデプロイ時に、名前空間・seccomp・IMDSv2・ホップの上限を検査する。
- 外向きのプロキシの結合テスト：DNS の再束縛、私的な IP へのリダイレクト、IPv6 の IMDS。

## 注記

> 2026-09-27 の注記：上流のソースで、次を確かめた（[sandbox-and-security.md](../architecture/sandbox-and-security.md) の 4.4・6.1 節）。
>
> - **V8 のサンドボックスは、上流の既定のビルドで無効。** workerd の `jsg.c++` は「workerd を `V8_ENABLE_SANDBOX` でビルドしない。この部分は内部のプロジェクトでだけ使う」とし、V8 のパッチ 0039 は「workerd は V8 をサンドボックスなしでビルドする」とする。V8 15.4.80.5 の Bazel のビルドは `v8_enable_sandbox` を「まだ対応していない GN の旗」に置く。したがって「ビルドの設定で有効にする」は取れない。E3 の最初の PoC（`v8-sandbox-build-poc`）で、定義を足すビルドと、要れば V8 の `BUILD.bazel` へのパッチ（[ADR-0006](0006-workerd-fork-and-upstream-tracking.md) の注記）で組めるか、上流のテストと性能の門を通るかを確かめる。組めない、または門を通らないときに、S1 を V8 のサンドボックスなしで出すかは、Dev のテックリードとセキュリティの担当が決める（エージェントは決めない）。
> - **MPK は公開版で使えない。** `MemoryProtectionKeyScope` の口は `V8_ENABLE_SANDBOX` のときだけ入り、内部のプロジェクト用とされる。isolate の間をキーで分ける配置は公開版にない。S1 では使わず、S2 の前に再評価する。
> - **止めた時計は、上流の単体の workerd にない。** 公開版の `TimerChannel` の実装は、システムの精密な時計をそのまま返す。止めた時計は `multitenant` のパッチで作る（E3 の `frozen-clock-timer`）。上流の実験のフラグ `precise_timers`（3ms の刻みで進む時計）は、実験のフラグを受け付けない規則（[ADR-0008](0008-bundle-format-and-compatibility-dates.md)）で利用者に開かない。

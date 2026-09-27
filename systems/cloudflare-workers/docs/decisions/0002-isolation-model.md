---
status: accepted
date: 2026-09-27
---

# ADR-0002: 多数のテナントの V8 isolate を共有のプロセスで動かし、多層の防御を重ねる

## Context

この基盤は、誰でも登録して書ける、信頼できないコードを動かす。隔離が破れると、同じ機械の他のテナントのコード・シークレット・要求の本文、ホストの資格情報、内部のネットワークに届く。

一方で、intent の価値の 1（速い）と採算（K8）のために、次が要る。

- isolate の起動 p99 5ms 未満（NFR-001）
- 1 台の機械に数千のテナントを載せる密度。本家は、1 プロセスで数百〜数千の isolate を動かし、isolate のメモリを約 3MB（Node の Lambda は約 35MB）としている（[Cloud Computing without Containers](https://blog.cloudflare.com/cloud-computing-without-containers/)、2026-09-27 に確認）

本家の隔離は、次の層を重ねている（[Mitigating Spectre and Other Security Threats](https://blog.cloudflare.com/mitigating-spectre-and-other-security-threats-the-cloudflare-workers-security-model/)、2020-07-29、[Security model](https://developers.cloudflare.com/workers/reference/security-model/)、どちらも 2026-09-27 に確認）。

- V8 の isolate（1 層目）
- プロセスのサンドボックス：空のファイルシステム（マウントの名前空間）、seccomp でファイルシステムの系のシステムコールをすべて禁止、通信はローカルの Unix ドメインソケットだけ
- cordon：信頼の段階でプロセスを分ける（無料のプランの利用者と Enterprise の利用者を同じプロセスに載せない）
- Spectre の対策：`Date.now()` は最後の I/O の時刻を返し、実行中は進まない。スレッドと共有メモリを禁止する。ネイティブのコードは受け付けない（JavaScript と Wasm だけ）
- 動的なプロセスの分離：CPU の性能カウンターで怪しい振る舞いを検知し、その Worker を専用のプロセスへ移す
- V8 の修正の配信を 24 時間未満にする

比べる先として、rebuilds の他の題材は、信頼できないコードに別の境界を選んでいる。

- GitHub の Actions のランナーは、1 ジョブ 1 つの Firecracker の microVM（[github の ADR-0023](../../../github/docs/decisions/0023-firecracker-microvm-runners.md)）。ジョブが root と Docker を要し、数十秒の起動が許されるため。
- Chrome の Renderer は、サイトごとのプロセスと OS のサンドボックスと V8 のサンドボックス（[chrome の sandbox-and-security.md](../../../chrome/docs/architecture/sandbox-and-security.md)）。

## Options

1. **共有のプロセスの中の V8 isolate ＋ 多層の防御**（本家の方式）
2. **テナントごとの microVM**（Firecracker など。関数の実行ごと、またはテナントごとに VM を持つ）
3. **テナントごとのプロセス**（isolate を 1 プロセスに 1 テナントだけ載せる）
4. **要求ごとの Wasm のサンドボックス**（Wasmtime。Fastly Compute の方式）

## Decision

1 を採用する。層は次のとおり。詳細は [sandbox-and-security.md](../architecture/sandbox-and-security.md) と ADR-0010〜0013 で決めた。

| 層 | 守り | 破られたときに次で止めるもの |
| --- | --- | --- |
| L1 isolate | V8 の isolate のヒープの分離。V8 のサンドボックス（ヒープの破損をプロセスの他の領域に広げにくくする）を有効にする（上流の既定のビルドでは無効。有効にするビルドを E3 の最初の PoC で作り、無効なビルドを CI で落とす。組めないときの扱いは [ADR-0010](0010-process-sandbox-and-egress-invariants.md) の注記） | L2 |
| L2 プロセスのサンドボックス | 空のマウントの名前空間、ネットワークの名前空間（外への経路なし）、seccomp の許可リスト（ファイルシステムの系を全禁止）、cgroup v2 でメモリと CPU の上限、権限を落とした利用者 | L3 |
| L3 cordon | 信頼の段階でプロセスを分ける。少なくとも「無料・未確認」「有料」「専用（大口・高い信頼の要るテナント）」の 3 段階。専用の段階は、テナントごとのプロセス、希望によりホストも分ける。段階の数と条件は [ADR-0011](0011-cordon-tiers-and-placement.md)（4 段階と、隔離用・内部用） | L4 |
| L4 外向きのプロキシ | 利用者のコードの通信は、すべて Unix ドメインソケットでスーパーバイザーの外向きのプロキシへ渡す。内部のアドレス（VPC、IMDS の `169.254.169.254`・`fd00:ec2::254`）への到達を遮断し、宛先とサブリクエストの数を制限する | L5 |
| L5 ホストとアカウント | エッジのノードのインスタンスロールは最小にし、IMDSv2 を必須にしてホップの上限を 1 にする。エッジのフリートは、制御プレーンと別の AWS アカウントに置く | 監視と対応 |

**Spectre と時間の対策**（本家と同じ方針）：

- `Date.now()` と `performance.now()` は、実行中に進めない。最後の I/O の時刻を返す。
- スレッド（Web Workers）、`SharedArrayBuffer`、Wasm のスレッドを提供しない。1 つの isolate の中で、同時に 1 つの要求の処理だけが CPU を使う。
- ネイティブのコードを受け付けない。JavaScript と Wasm だけ。
- 性能カウンター（キャッシュのミスなど）で怪しい振る舞いを検知した isolate を、専用のプロセスへ移す。検知の条件は [ADR-0013](0013-spectre-mitigations-and-dynamic-isolation.md)（閾値は E3 の実験で決める）。
- ランタイムのプロセスを定期的に（1 日 1 回を目安に）入れ替え、テナントのメモリの配置を変える。

**isolate を受け入れる理由**：

- isolate の境界は、JavaScript エンジンの欠陥 1 つで破れうる。これを、L2〜L5 の独立した層と、V8 の修正の 24 時間以内の配信（NFR-007）で補う。攻撃者は、V8 の欠陥とサンドボックスの脱出（カーネルの欠陥など）を組み合わせる必要がある。
- microVM の起動（Firecracker は `/sbin/init` の開始まで 125ms 以下を仕様にする。github の ADR-0023 より）では、NFR-001（5ms）を満たせない。起動済みの VM を持つと、テナントの数（S1 で 1 万アカウント、5 万関数）に対して密度と費用が合わない。
- 本家は、この方式で少なくとも 2018 年から大規模に運用している（2018-11-09 の上記の記事の時点で 155 のデータセンター）。隔離の破れの公表の有無は調べきれていない（未検証。判断には使わない）。

2 を採らない理由：起動の時間と密度（上のとおり）。ただし、MVP の後のコンテナの製品と、L3 の専用の段階の強化では、microVM を使う。

3 を採らない理由：プロセスの数がテナントの数だけ要り、メモリの密度が一桁以上落ちる（本家の記事の isolate 約 3MB に対し、プロセスごとに V8 と runtime の固定の分が要る。程度は測っていない）。L3 の専用の段階でだけ使う。

4 を採らない理由：JavaScript をそのまま動かせない（[ADR-0001](0001-runtime-build-vs-reuse.md)）。Wasm でも、要求ごとの使い捨ては Durable Objects の長く生きる実体と合わない。

## Consequences

- 良くなること：
  - 起動 5ms と、1 台に数千のテナントを載せる密度を両立できる。
  - 層が独立しているので、1 つの層の欠陥だけでは、他のテナントに届かない。
- 悪くなること、引き受けるコスト：
  - プロセスの中の境界なので、CPU のサイドチャネルへの耐性は VM より弱い。止めた時計は攻撃を遅くするが、完全には防がない。高い信頼の要るテナントには、L3 の専用の段階を用意し、契約で説明する。
  - スレッドと高い精度の時計がないので、一部の用途（CPU を並列に使う処理、正確な計時）は動かせない。
  - 動的なプロセスの分離、cordon、プロセスの定期の入れ替え、テナントごとの制限の強制は、本家が公開していない部分で、自前で作る。上流の workerd はテナントの動的な読み込み（`workerLoader`）を持つが、テナントごとの制限を強制しない（[ADR-0001](0001-runtime-build-vs-reuse.md)、[ADR-0009](0009-cpu-and-memory-metering.md)）。自前の量と、性能カウンターでの検知の精度は未検証（E3 の `spectre-threshold-experiment` で測る）。止めた時計も上流の単体の workerd にはなく、パッチで作る（[ADR-0010](0010-process-sandbox-and-egress-invariants.md) の注記）。
  - V8 の修正の 24 時間の配信の経路を、常に動く状態に保つ運用の費用がかかる。

## Confirmation

- 脱出のテストの集まり（CI と、本番の各 cordon での定期の実行）。次が観測できたら失敗にする（[AGENTS.md](../../AGENTS.md)）。
  - ファイルの読み書き、プロセスの起動、許可していない宛先・内部のアドレス・IMDS への到達
  - 実行中に進む `Date.now()`・`performance.now()`、`SharedArrayBuffer`、スレッド
  - 別のテナントの isolate のグローバルの値・シークレット・要求の本文への到達
- 修正済みの V8 の脆弱性の再現コードを、隔離した CI の環境で回帰用に流す。
- seccomp の許可リストの外のシステムコールを、ランタイムのプロセスが呼ばないことを、ステージングでの監査のモードで確かめる。
- ホストの設定の検査：全ノードで、IMDSv2 の必須、ホップの上限 1、ランタイムのプロセスの名前空間と seccomp が有効なことを、起動時とデプロイ時に検査する。
- 外部の侵入試験を GA の前に行い、脆弱性の報奨の窓口を GA と同時に開く。

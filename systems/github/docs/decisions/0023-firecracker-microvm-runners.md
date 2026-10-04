---
status: accepted
date: 2026-09-26
---

# ADR-0023: ホストされたランナーは、EC2 の metal の上の Firecracker の microVM で、1 ジョブ 1 VM・使い捨てにする

詳細は [actions.md](../architecture/actions.md) の 8 節。

## Context

Actions のジョブは、誰でも出せる Pull Request のコードを含む、信頼できないコードである。ジョブは VM の中で root になり、Docker も動かす（本家と同じ）。隔離が破れると、同じホストの他の利用者のジョブのシークレット、ホストの IAM の資格情報、内部のネットワークに届く（[intent.md](../intent.md) の「CI のジョブは、他のジョブ・他のリポジトリのシークレットに触れられない」）。

一方で、NFR-007（キューに入ってから開始まで p95 60 秒）を満たす速さと、S1 で数千の同時実行を賄う費用も要る。

本家のホストされたランナーは、ジョブごとに新しい VM（Azure）を使う（[GitHub-hosted runners](https://docs.github.com/en/actions/concepts/runners/github-hosted-runners)、[Secure use reference](https://docs.github.com/en/actions/reference/security/secure-use)）。

## Options

1. **EC2 の metal の上で Firecracker の microVM を動かし、1 ジョブ 1 VM で使い捨てる**
2. **ジョブごとに EC2 のインスタンスを 1 台起動して使い捨てる**
3. **コンテナ（gVisor などのサンドボックス付き）でジョブを動かす**
4. **Fargate のタスクでジョブを動かす**

## Decision

> 2026-09-26 の注記：Fargate は特権のコンテナ（`privileged`）に対応しない（[ContainerDefinition](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_ContainerDefinition.html)）ので、選択肢 4 を採らない理由は確かめられた。EC2 の起動の時間は、AWS の FAQ が「RunInstances から起動の開始まで通常 10 分未満」と書くだけで、metal に固有の値は公開されていない（[Amazon EC2 FAQs](https://aws.amazon.com/ec2/faqs/)）。起動の時間は引き続き E8 の `firecracker-host-poc` で測る。入れ子の仮想化は、2026-06 の時点で C8i・M8i・R8i のほか M7i・C7i・R7i などにも広がったが、AWS は性能と遅延に敏感な用途には metal を勧めており、Firecracker も入れ子の仮想化を検証済みの基盤に挙げていない（[Nested virtualization](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/amazon-ec2-nested-virtualization.html)、[Firecracker の README](https://github.com/firecracker-microvm/firecracker/blob/main/README.md)）。決定は変えない。

1 を採用する。

- **隔離の境界は KVM の VM にする。** Firecracker は KVM の上の最小の VMM で、jailer で VM ごとに cgroup・namespace・seccomp を掛けて権限を落とす（[Firecracker](https://github.com/firecracker-microvm/firecracker)）。ホストは、本番のホストの推奨（SMT の無効、KSM の無効、スワップの無効、VM ごとの資源の上限）に従う（[prod-host-setup.md](https://github.com/firecracker-microvm/firecracker/blob/main/docs/prod-host-setup.md)）。
- **1 ジョブ 1 VM、再利用しない。** ジョブが終わったら VM と書き込みのディスクの層を消す。起動済みで待機する VM は、シークレットを持たない。
- **スナップショットからの複製の起動は S1 で使わない。** 1 つのスナップショットから複数の VM を作ると乱数の状態などが複製される（[random-for-clones.md](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/random-for-clones.md)）。起動の速さは、読み取りだけのベースのイメージと待機中の VM で稼ぐ。
- **ホストは EC2 の metal にする。** Firecracker は KVM を要する。2026-02 から C8i・M8i・R8i の仮想のインスタンスでも入れ子の仮想化が使える（[AWS の告知](https://aws.amazon.com/about-aws/whats-new/2026/02/amazon-ec2-nested-virtualization-on-virtual)）が、性能と隔離の性質を確かめていないので、S1 は metal に限り、S2 であふれの受け皿として評価する。
- **ネットワーク**：実行環境は prod と別の AWS アカウント・別の VPC に置き、prod へは PrivateLink だけで届く（[infrastructure.md](../architecture/infrastructure.md) の 2.2 節）。microVM からは、インスタンスメタデータ（`169.254.169.254`）、VPC の内部（PrivateLink と S3 のエンドポイントを除く）、他の VM、SMTP を遮断する。Firecracker の MMDS は使わない。
- **ゲストは Linux だけ。** Windows・macOS・GPU のランナーは MVP の外にする。
- 2 を採らない理由：EC2 のインスタンスの起動と初期化に分の単位の時間がかかり（**未検証**）、ウォームプールを持つと、1 ジョブ 1 台の費用がかさむ。ホストの IMDS とインスタンスロールも、ジョブの VM ごとに管理が要る。
- 3 を採らない理由：カーネルを共有する。gVisor でもジョブの中の Docker（入れ子のコンテナ）と root の要求に合わせにくく、隔離の境界として VM より弱い。
- 4 を採らない理由：Fargate のタスクの中では、特権のコンテナ（Docker の中の Docker）を動かせず、本家のワークフローとの互換を失う（Fargate の特権の制限は **未検証**）。

## Consequences

- 良くなること：
  - 隔離の境界が VM（KVM）になり、ホストのカーネルを共有するコンテナより強い。
  - microVM は小さく速い（仕様で `/sbin/init` の開始まで 125 ms 以下、VMM のメモリ 5 MiB 以下。[SPECIFICATION.md](https://github.com/firecracker-microvm/firecracker/blob/main/SPECIFICATION.md)）ので、metal のホストに多くのジョブを詰められる。
  - ジョブの VM ごとに IAM を持たないので、資格情報の管理の面が小さい。
- 引き受けるコスト：
  - metal のホストのフリート（カーネル、Firecracker のバージョン、イメージ、tap と nftables）を自分で運用する。
  - metal のインスタンスは大きく、増減の単位が粗い。SMT の無効で使える vCPU が半分になり、1 ホストに載る VM は約 40 になる（[actions.md](../architecture/actions.md) の 8.5 節）。
  - Windows・macOS のランナーは別の基盤が要る（MVP の外）。
  - サイドチャネルの攻撃への備えは、ハードウェアとカーネルの更新に追従し続ける必要がある。

## Confirmation

- 隔離のテスト（CI と定期の本番の検査）：ジョブの中から、次に届かないこと。
  - `169.254.169.254`・`fd00:ec2::254` への TCP の接続
  - VPC の内部のアドレス、ホスト、同じホストの他の VM
  - TCP 25 の外向き
- 使い捨ての性質のテスト：ジョブ A がディスク・`/tmp`・Docker のイメージ・環境変数に書いた印が、次のどのジョブからも見えない。
- ホストの設定の検査：全ホストで SMT・KSM・スワップが無効で、jailer と seccomp が有効であることを、起動時とデプロイ時に検査する。
- レビュー観点：VM の再利用、スナップショットの複製の起動、MMDS の有効化を入れる変更は、この ADR の改訂を要する。

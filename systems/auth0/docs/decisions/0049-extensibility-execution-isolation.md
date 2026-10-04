---
status: accepted
date: 2026-09-27
---

# ADR-0049: テナントのコードは Lambda のテナントの隔離のモードの共通の実行器で動かし、実行ロールに権限を持たせない

詳細は [extensibility.md](../architecture/extensibility.md) の 5 節。MVP の後（E13）。

## Context

テナントのコード（Action）は、信頼できないコードである。npm のパッケージを含み、外部の API を呼ぶ。隔離が破れると、他のテナントの秘密・利用者の情報、本システムの内部の網と資格情報に届く。一方で、ログインの途中で動くので、起動が速く、テナントの数（S1 で 1 万）に対して費用が見合う必要がある。

本家の Actions の今の隔離の方式は公開されていない（未検証）。2019 年の本家の記事は、Rules などを Docker のコンテナと EC2 の専用のクラスタで動かすとしている（[A Look at Auth0 Cloud Architecture](https://auth0.com/blog/auth0-architecture-running-in-multiple-cloud-providers-and-regions/)、2026-09-27 に確認）。

rebuilds の他の題材の選択：

- 本家の Cloudflare Workers は、共有のプロセスの V8 isolate と多層の防御を使う。起動 5ms と密度のため。
- GitHub の Actions のランナーは、EC2 の metal の上の Firecracker の microVM で 1 ジョブ 1 VM（[ADR-0023](../../../github/docs/decisions/0023-firecracker-microvm-runners.md)）。

AWS Lambda のテナントの隔離のモードは、呼び出しの `tenant-id` ごとに実行環境を分け、他のテナントに再利用しない。実行環境は Firecracker で隔離される。実行ロールは全テナントで共通。1,000 の同時実行につき 2,500 の実行環境。プロビジョニングされた同時実行は使えない（[Tenant isolation](https://docs.aws.amazon.com/lambda/latest/dg/tenant-isolation.html)、2026-09-27 に確認）。

## Options

1. V8 isolate（`isolated-vm`、workerd）
2. 自前の Firecracker の microVM（EC2 の metal）
3. Lambda のテナント × Action のバージョンごとの関数
4. **Lambda のテナントの隔離のモード。Node のバージョンごとに 1 つの共通の実行器が、テナントのコードを実行時に読み込む**

## Decision

4 を採用する。

- 関数は Node のバージョンごとに 1 つ（`actions-runner-node22` など）。`tenant-id` はテナントの ID。
- **実行ロールに権限を持たせない。** 束は Auth が作る、その束だけの 60 秒の署名付き URL で渡し、実行器が `sha256` を照合する。秘密は呼び出しの本文で渡す。
- 関数は prod と別の AWS アカウントの、内部への経路のない VPC（専用の NAT、公開する送信元の IP）に置く。Auth はアカウントをまたいで `lambda:InvokeFunction` だけを持つ。
- テナントのコードは変更の指示を返し、Auth が検証して適用する。
- 1 を採らない理由：Node の API の互換が足りず、npm の多くが動かない。isolate の境界を補う多層の防御（Cloudflare の ADR-0002 の L2〜L5）を自前で作る費用が、この用途（ログインの途中の数十 ms の処理）の密度の利点に見合わない。
- 2 を採らない理由：metal のフリートの運用が重い。S1 の Action の量で見合わない。E13 の PoC で Lambda のコールドスタートか費用が合わなければ、再評価する。
- 3 を採らない理由：関数の数がテナント × バージョンに比例し、配備の速さ・コードの保管の上限・権限の管理が重い。
- 本家の方式（未検証）には寄せない。

## Consequences

- 良くなること：
  - 隔離の境界が VM（Firecracker）で、テナントの間で実行環境を再利用しない。
  - 基盤の運用（ホスト、カーネル、Firecracker の更新）を AWS に任せられる。
  - 関数の数がテナントの数に比例しない。
- 引き受けるコスト：
  - テナントごとの実行環境なので、コールドスタートが増える。プロビジョニングされた同時実行で温められない（テナントの隔離のモードは、プロビジョニングされた同時実行・SnapStart・関数の URL に対応しない。[Tenant isolation](https://docs.aws.amazon.com/lambda/latest/dg/tenant-isolation.html)、2026-09-27 に確認）。遅延は未検証で、E13 の最初の PoC で計る。
  - テナントの隔離の実行環境を作るたびに、割り当てたメモリーの量とアーキテクチャに応じた料金がかかる（[Tenant isolation](https://docs.aws.amazon.com/lambda/latest/dg/tenant-isolation.html)、[AWS Lambda Pricing](https://aws.amazon.com/lambda/pricing/)、2026-09-27 に確認。単価は料金のページで表示されず、未検証）。
  - Lambda の可用性（SLA は月間 99.95%。[AWS Lambda SLA](https://aws.amazon.com/lambda/sla/)、2026-09-27 に確認）が、Action を使うテナントのログインに効く。
  - 同じテナントの Action は、実行環境を共有する（同じテナントの中なので許す）。

## Confirmation

- 隔離のテスト（CI と本番の定期）：他のテナントの束、AWS の API、内部のアドレス、他のテナントが残した `/tmp` とグローバルの印に届かない。
- IAM：実行ロールのポリシーが空であることを、Terraform の検査と週次の監査で確かめる。
- 結合テスト：署名付き URL を別の束に差し替えると、`sha256` の不一致で実行しない。
- レビュー：実行ロールへの権限の追加、VPC への経路の追加は、この ADR の改訂を要する。

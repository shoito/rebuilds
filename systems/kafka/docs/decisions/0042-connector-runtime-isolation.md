---
status: accepted
date: 2026-09-27
---

# ADR-0042: コネクターは、ブローカーと別の EKS・VPC・アカウントの Fargate の Pod で動かし、外への通信を許可リストの出口に限る

## Context

マネージドのコネクターは、第三者のコード（JDBC のドライバー、選んだコネクター）と、S3 後半では利用者のプラグインを動かす（[ADR-0041](0041-managed-connectors-curated-plugins.md)）。コードは、任意の処理（外への通信、ファイル、プロセス）を行いうる。守るものは、他のテナント、ブローカーと制御面、AWS の資格情報である。

事実（2026-09-27 に確認。[AWS Fargate on EKS](https://docs.aws.amazon.com/eks/latest/userguide/fargate.html)）：

- Fargate の Pod は、それぞれの計算の境界を持ち、カーネル・CPU・メモリー・ネットワークのインターフェースを他の Pod と分け合わない。Pod ごとに VM で隔離する。
- Fargate では、特権のコンテナ、`HostPort`・`HostNetwork`、DaemonSet が使えない。IMDS は使えない。EBS は付けられない。私設のサブネットだけで動く。
- AWS は、最も安全な隔離は別のクラスタで動かすことだとする。

## Options

1. **ブローカーと別の EKS・VPC・AWS アカウントで、EKS Fargate の Pod で動かす。外への通信は FQDN の許可リストの出口のプロキシだけ**
2. EC2 のノードで、gVisor か Kata Containers のサンドボックスのランタイムを使う
3. 普通のコンテナ（runc）で、ノードをテナントごとに分ける

## Decision

1 を採用する。詳細は [connectors-and-schema.md](../architecture/connectors-and-schema.md) の 4.3・4.4 節にある。

- 置き場：コネクター専用の AWS アカウント・VPC・EKS。ブローカーへは、公開のブートストラップ（SNI のプロキシ）経由で、テナントと同じ道でつなぐ。制御面の internal-api には届かない。
- Pod：Fargate。サービスアカウントのトークンを載せない。IAM の役割を付けない（S3 への書き出しは、利用者の役割を外部 ID 付きで引き受ける）。名前空間はテナントごと、NetworkPolicy で Pod の間の通信を禁止する。
- 外への通信：出口のプロキシ（Envoy）の、組織ごとの FQDN の許可リストだけ。私設の IP、リンクローカル、当社のドメインへの接続を拒否し、プロキシで名前を引いた IP を検査する（DNS の再束縛を防ぐ）。
- 資源：コネクターあたり 2 vCPU・4 GiB から。CPU の使用の異常を検知する。
- プラグイン（S3 後半）：250 MB まで、マルウェアと依存の脆弱性の走査、外への通信の記録。

2 を選ばない理由：サンドボックスのランタイムとノードの運用（版の更新、互換の問題）を自前で持つことになる。Fargate は、同じ VM の境界を運用なしで得られる。

3 を選ばない理由：カーネルを他のコネクターと分け合い、コンテナからの脱出で同じノードの他のコネクターに届く。

## Consequences

- 良くなること：
  - コンテナからの脱出があっても、他のテナントとブローカーに届かない。
  - IMDS がなく、SSRF で AWS の資格情報を盗まれない。
- 引き受けるコスト：
  - Fargate の Pod の費用は、EC2 のノードに詰めるより高い（未検証。S3 の capacity で見積もる）。
  - Fargate の OS の更新で Pod が消されることがある。Kafka Connect の再開で受ける。
  - 固定の送信元の IP を、出口のプロキシの NAT で用意するか（Confluent のカスタムのコネクターは持たない）は、需要で決める。

## Confirmation

- 自動の侵入テスト（基盤の変更ごと）：Pod から、IMDS、私設の IP、Kubernetes の API、他の Pod、ブローカーの内部のリスナー、許可リストの外の FQDN、DNS の再束縛の宛先へ接続できない。
- 設定の検査（CI）：コネクターの Pod の定義に、サービスアカウントのトークン、IAM の役割、特権がない。

---
status: accepted
date: 2026-09-27
---

# ADR-0041: マネージドのコネクターは、当社が選んだ Apache 2.0 のコネクターから始め、コネクターごとに専用のワーカーで動かす

## Context

intent.md は、マネージドのコネクター（Kafka Connect に相当）を Later とし、利用者のコードとプラグインを動かすので隔離と責任の範囲が大きいとした。S3 で提供する。

事実（いずれも 2026-09-27 に確認）：

- Confluent の JDBC・S3 のコネクター（`kafka-connect-jdbc`、`kafka-connect-storage-cloud`）は Confluent Community License で、競合する SaaS として提供できない（[FAQ](https://www.confluent.io/confluent-community-license-faq/)、各リポジトリの README）。
- Debezium、Aiven の S3 などのコネクターと JDBC のコネクターは Apache License 2.0（GitHub）。Kafka Connect は本家の一部で Apache License 2.0。
- Confluent Cloud のカスタムのコネクターは、Java のプラグイン（250 MB まで）を受け、外への接続を FQDN で指定させ、上げたものを走査する。組織あたり 30 のコネクター・100 のプラグイン、コネクターのメモリー 2 GB。基盤だけを支え、プラグインの問題は利用者の責任とする（[quick start](https://docs.confluent.io/cloud/current/connectors/bring-your-connector/custom-connector-qs.html)、[limitations](https://docs.confluent.io/cloud/current/connectors/bring-your-connector/custom-connector-fands.html)）。

## Options

範囲：

1. **当社が選んだ Apache 2.0 のコネクターから始め（S3 前半）、利用者のプラグインは隔離の実績の後に足す（S3 後半）**
2. 最初から利用者のプラグインも受ける
3. 当社が選んだコネクターだけにする

ワーカーの単位：

- A. **コネクターごとに専用の Kafka Connect のワーカー（分散モード）**
- B. テナントごとに共有のワーカー
- C. 多数のテナントで共有のワーカー

## Decision

1 と A を採用する。詳細は [connectors-and-schema.md](../architecture/connectors-and-schema.md) の 4 節にある。

- 最初のコネクター：Debezium（MySQL・PostgreSQL）、S3 への書き出し、JDBC（Apache 2.0 のもの）。Confluent Community License のコネクターは使わない。
- ワーカーの内部のトピックはテナントの論理クラスタに置き、コネクター専用の API キー（指定したトピックだけの ACL）で読み書きする。
- 秘密は Secrets Manager に置き、ConfigProvider で読む。設定の API の応答で伏せる。
- 利用者のプラグインは、選んだコネクターの運用で、隔離（[ADR-0042](0042-connector-runtime-isolation.md)）と走査の仕組みが本番で 6 か月問題なく動いてから受ける。

2 を選ばない理由：隔離と走査の仕組みの実績がないまま、任意のコードを動かすことになる。

3 を選ばない理由：独自のシステムへの連携（社内の API など）の需要に応えられない。Confluent も利用者のプラグインを受ける。

B・C を選ばない理由：Kafka Connect のワーカーは、1 つの JVM に複数のプラグインを載せる。テナントの境界（C）も、コネクターの間の障害の広がり（B）も、プロセスの中で守れない。

## Consequences

- 良くなること：
  - ライセンスの問題のないコネクターだけで始められる。
  - 1 つのコネクターの障害・暴走が、他のコネクターに及ばない。
- 引き受けるコスト：
  - コネクターごとのワーカーで、資源の効率が下がる（JVM の固定の費用）。課金（タスク-時）に反映する。
  - 選んだコネクターの版の追従と脆弱性の対応を、当社が持つ。
  - コネクターのライセンスの義務（NOTICE など）は法務の確認待ち（L3）。

## Confirmation

- 結合テスト：選んだコネクターごとの CDC・書き出しの結合テスト。
- CI：コネクターのイメージに入る依存のライセンスを走査し、Confluent Community License のものがあれば失敗にする。
- 障害のテスト：1 つのコネクターのワーカーのメモリーを使い切らせても、他のコネクターの処理が続く。

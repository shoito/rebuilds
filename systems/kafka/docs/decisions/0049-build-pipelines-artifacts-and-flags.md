---
status: accepted
date: 2026-09-27
---

# ADR-0049: ブローカーは本家のタグにパッチの列を当てて Strimzi の基のイメージに載せ、全ての成果物に署名と SBOM を付ける。データ面のフラグは内部のトピックで配る

詳細は [delivery.md](../architecture/delivery.md) の 1〜4 節と 9 節。

## Context

- 成果物は 4 つの言語にまたがる：ブローカーの拡張とパッチ・エージェント・クォータのコーディネーター（Java 21）、制御面とコンソール（TypeScript）、CLI・Terraform のプロバイダー・sni-router（Go）、Envoy の設定（[ADR-0001](0001-upstream-brokers-and-stack.md)、[ADR-0031](0031-control-plane-reconciliation-and-agent.md)、[ADR-0036](0036-cli-and-terraform-provider.md)、[ADR-0044](0044-nlb-sni-proxy-and-zonal-hostnames.md)）。
- パッチは、パッチごとに理由と関連する KIP を付けて 1 つのディレクトリに置き、行数を CI で出す（[ADR-0001](0001-upstream-brokers-and-stack.md)）。パッチの場所は P1〜P7（[multi-tenancy-and-quotas.md](../architecture/multi-tenancy-and-quotas.md) の 4.5 節）。
- Strimzi は、自前のブローカーのイメージを `spec.kafka.image` で受ける（[ADR-0032](0032-strimzi-for-physical-clusters.md)）。Strimzi の起動の仕組み（スクリプト、`kafka-agent` の jar）はイメージの中にあるので、Strimzi の Kafka のイメージを基にするのが前提になる（[docker-images/kafka-based/kafka/Dockerfile](https://github.com/strimzi/strimzi-kafka-operator/blob/main/docker-images/kafka-based/kafka/Dockerfile) が `scripts/` と `kafka-agent` を入れる。Operator はイメージの中身の版を検証しない。[Strimzi の文書](https://strimzi.io/docs/operators/latest/deploying.html)、2026-09-27 に確認）。
- サプライチェーンの脅威（T10）に、イメージの署名と SBOM で備える（[security-and-acls.md](../architecture/security-and-acls.md) の 2 節）。
- データの経路は制御面に依存しない（[ADR-0003](0003-kraft-metadata-and-cluster-placement.md)）。フラグの配り方も同じ原則に従う必要がある。

## Options

ブローカーのソース：

1. **本家の GA のタグに、番号付きのパッチの列（`git am`）を当ててビルドする。差し込み口のプラグインは別のモジュール**
2. 本家の fork のブランチを持ち、本家の変更を取り込む（merge / rebase）
3. プロキシ（名前空間をパッチなしで）に切り替える

フラグ：

- A. **制御面の機能は AppConfig（他の題材と同じ）。データ面の運用のフラグは、望ましい状態 → エージェント → 内部のトピック `__<brand>_ops_flags` で配り、ブローカーとプラグインが読む**
- B. すべて AppConfig を、ブローカーから直接読む

## Decision

1 と A を採用する。

- ブローカー：`broker/upstream.lock` に本家のタグとコミットを固定し、`broker/patches/NNNN-<slug>.patch` を順に当てる。各パッチの先頭に理由・KIP・ADR・P の番号を書く。プラグイン（SASL のコールバック、KafkaPrincipalBuilder、TenantAuthorizer、ClientQuotaCallback、ポリシー、RSM の包む層、監査のプラグイン）は `broker/plugins/` の Gradle のモジュール。
- イメージ：Strimzi の同じ版の Kafka のイメージを基にし、本家の jar をビルドした jar に替え、プラグインを足す。基のイメージは digest で固定する。
- 夜間：本家の `trunk` と最新の RC に、パッチの列が当たるかを確かめる（当たらなければチケット）。
- 全ての成果物（コンテナ、CLI、プロバイダー）に、cosign の署名、SBOM（SPDX）、ビルドの来歴（SLSA の provenance）を付ける。EKS は、署名のないイメージを受け入れない（受け入れの制御の道具は E12 で選ぶ）。
- 1 回ビルドして同じ成果物を昇格させる。環境ごとにビルドし直さない。
- データ面のフラグの例：`tiered.delete.pause`（物理クラスタ・トピック）、`broker.demotion.auto`、`quota.dynamic`、`edge.ip_allowlist.enforce`、`rollout.pause`。フラグは物理クラスタ × 対象の単位で持ち、世代（generation）付きで配る。制御面が止まっているときは、エージェントの break-glass の CLI で内部のトピックに直接書ける（記録を残す）。
- 本家の機能の版（`share.version` など）はフラグにしない。ADR-0024 の条件と runbook で上げる。
- 2 を選ばない理由：パッチと本家の変更が混ざり、「本家との差」が見えなくなる。行数の CI（ADR-0001）が作れない。
- 3 を選ばない理由：ADR-0004 で退けた。パッチの量が PoC で多すぎたときに再評価する。
- B を選ばない理由：データの経路が AppConfig と制御面のアカウントに依存する。

## Consequences

- 良くなること：
  - 本家との差が、パッチの列と行数として常に見える。本家の版を上げる作業が「列を当て直す」に絞られる。
  - 運用のフラグが、制御面の障害の間も効く。
- 引き受けるコスト：
  - Strimzi の基のイメージの Java の版と、本家のビルドの版を合わせる必要がある。今の基のイメージは Java 21（[docker-images/base/Dockerfile](https://github.com/strimzi/strimzi-kafka-operator/blob/main/docker-images/base/Dockerfile) の `JAVA_VERSION=21`、2026-09-27 に確認）で、本システムと同じ。Strimzi が上げたときは CI で止める。
  - フラグの経路が 2 つ（AppConfig と内部のトピック）になる。フラグの一覧に、どちらの経路かを書く。

## Confirmation

- CI：パッチの列が本家のタグにきれいに当たる。パッチの行数と対象のファイルを出力し、増えたら PR に理由を求める。
- CI：成果物の署名と SBOM の検証がないと、昇格の工程に進まない。
- 結合テスト：制御面を止めた状態で、break-glass の CLI で `tiered.delete.pause` を立て、ブローカーが 1 分以内に削除を止める。

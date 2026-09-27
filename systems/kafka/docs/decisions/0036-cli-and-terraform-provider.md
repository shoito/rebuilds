---
status: accepted
date: 2026-09-27
---

# ADR-0036: CLI と Terraform のプロバイダーは Go で作り、OpenAPI から生成した 1 つの SDK を共有する

## Context

運用の担当は、CLI と Terraform で論理クラスタ・トピック・API キー・ACL を管理する（intent.md の MVP）。[architecture/README.md](../architecture/README.md) の 4 節は、両方を Go にするとした。ここでは、名前、SDK、認証、秘密の扱い、配布を決める。

事実（いずれも 2026-09-27 に確認）：

- Confluent の Terraform のプロバイダー（`confluentinc/terraform-provider-confluent`）は Go、Apache License 2.0 で、`confluent_kafka_cluster`・`confluent_kafka_topic`・`confluent_api_key`・`confluent_kafka_acl`・`confluent_role_binding` などの資源を持つ。Confluent の CLI も Go（GitHub）。
- Terraform のプロバイダーの SDK（Terraform Plugin Framework）は Go。

## Options

1. **CLI とプロバイダーは Go。OpenAPI から生成した Go の SDK を共有する**
2. CLI は TypeScript（Node.js）、プロバイダーは Go
3. SDK を手で書く

## Decision

1 を採用する。詳細は [console-and-api.md](../architecture/console-and-api.md) の 6・7 節にある。

- **名前**：CLI のコマンドは `<brand>`、プロバイダーのアドレスは `<brand>/<brand>`、資源は `<brand>_cluster` などにする（リポジトリ共通の [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。
- **SDK**：管理 API の OpenAPI から Go の SDK を生成し、CLI とプロバイダーが使う。手で書く部分は、冪等キーの付与、再試行（429・5xx、指数の待ちと揺らぎ）、操作の待ちだけ。
- **CLI の認証**：人はデバイスの認可のフロー（トークンは OS のキーチェーン）、CI は環境変数の管理のキー。秘密をファイルに書かない。
- **CLI の produce・consume**：franz-go を使う。
- **プロバイダーの資源**：クラスタ、トピック（設定を含む）、サービスアカウント、API キー、ACL、ロールの付与と、データソース。すべてに `import`。トピックのパーティションは増やすだけで、減らす計画はエラーにする（置き換えでデータを消さない）。
- **秘密**：`<brand>_api_key` の秘密は状態に `sensitive` で入る。秘密を状態に残さない ephemeral な資源を別に用意する（ephemeral な資源は Terraform 1.10 から、write-only の引数は 1.11 から。[Terraform 1.10](https://www.hashicorp.com/en/blog/terraform-1-10-improves-handling-secrets-in-state-with-ephemeral-values)、[Terraform 1.11](https://www.hashicorp.com/en/blog/terraform-1-11-ephemeral-values-managed-resources-write-only-arguments)、2026-09-27 に確認）。
- **配布**：CLI は GitHub の Releases・Homebrew・`.deb`・`.rpm` で、cosign の署名と SBOM、macOS の公証。プロバイダーは Terraform Registry に GPG の署名で公開する。

2 を選ばない理由：Node.js の実行環境を利用者に求め、1 つのバイナリで配れない。SDK が 2 つになる。

3 を選ばない理由：API の資源が増えるたびに、SDK の更新が漏れる。OpenAPI を契約にした（[ADR-0034](0034-management-api-shape.md)）ので、生成で追従できる。

## Consequences

- 良くなること：
  - CLI とプロバイダーで、API の呼び方・再試行・冪等が同じになる。
  - 1 つのバイナリで配れ、CI での導入が簡単。
- 引き受けるコスト：
  - Go のコードを保つ（ADR-0001 の言語の範囲の中）。
  - Terraform の状態に秘密が入りうることを、文書で利用者に知らせる。
  - 配る成果物のライセンスの表示（NOTICE）は、法務の確認待ち（intent.md の L2）。

## Confirmation

- 受け入れのテスト：ステージングに対して、プロバイダーの全資源の作成・更新・取り込み・削除を、PR ごと（代表）と日次（全体）で流す。
- E2E：CLI の主なコマンドと、終了コードの表。
- CI：SDK の生成物が、OpenAPI の最新と一致する（生成し直して差がない）。
- 公開の工程：署名の検証と SBOM の添付がないと、公開しない。

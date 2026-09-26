---
status: accepted
date: 2026-09-26
---

# ADR-0001: 実行基盤と技術は Slack の決定を引き継ぎ、金額は最小単位の整数で扱う

## Context

rebuilds の他の題材（Slack）で、次の基盤を決めている。

- AWS（ECS Fargate、Aurora PostgreSQL、SQS、S3、CloudFront）
- TypeScript（Hono＋Zod）
- Terraform、OpenTelemetry、トランクベース開発

決済の基盤には、Slack にない条件が 3 つ加わる。

- お金の計算の正しさ
- PCI DSS
- 決済の API の高い可用性

## Options

1. **Slack の基盤を引き継ぎ、決済に固有の部分だけを変える**
2. **決済の中核（台帳・Payments）を、Go や Java など別の言語で書く**
3. **題材ごとに一から選び直す**

## Decision

1 を採用する。

- 実行基盤・言語・IaC・可観測性は、Slack の ADR-0011・0007・0020・0021 と同じにする。題材をまたいで、エージェントと人が同じ道具で検証できる。
- **金額は、通貨ごとの最小単位の整数（`bigint`）と ISO 4217 の通貨コードの組で扱う。** 浮動小数点と `number` 型は使わない。金額の型は `packages/money` に置き、演算（加算、按分、手数料の丸め）をそこに集める。丸めは、通貨ごとに規則を決め、按分では端数を最後の要素に寄せて合計を保つ。
- 2 は、型の強さと実行の性能で勝る。ただし、題材をまたいだ共通の道具が使えなくなる。台帳の正しさは、言語よりも DB の制約と性質ベーステストで守る（[ADR-0003](0003-double-entry-ledger.md)）。
- 3 は、題材の比較という rebuilds の目的に反する。

## Consequences

- 良くなること：
  - Slack で決めた運用・CI・セキュリティの仕組みを使い回せる。
- 引き受けるコスト：
  - TypeScript の `bigint` は JSON に直接出せない。API では、金額を整数の数値として出す（本家と同じ）。その範囲は `Number.MAX_SAFE_INTEGER` 以内であることを検証する。

## Confirmation

- lint：金額の型（`Money`）以外で、通貨の値を `number` として扱うコードを禁止する。
- 性質ベーステスト：任意の金額と比率で、按分の合計が元の金額と等しい。

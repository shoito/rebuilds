---
status: accepted
date: 2026-09-26
---

# ADR-0001: 基盤は他の題材の決定を引き継ぐ

## Context

rebuilds の他の題材（Slack・Stripe・GitHub）で、AWS・TypeScript・Terraform・OpenTelemetry を基盤にしている。Notion は、リアルタイムの配信（Slack）と、ワークスペースのテナント分離（Slack）に近い要素が多い。

## Options

1. **他の題材の基盤を引き継ぎ、Notion に固有の部分（ブロック、共同編集、データベースの問い合わせ）だけを決める**
2. **題材ごとに一から選び直す**

## Decision

1 を採用する。

- 実行基盤・言語・IaC・可観測性は、Slack の ADR-0007・0011・0020・0021 と同じにする。
- リアルタイムの配信（Gateway、購読、再接続時の差分）は、Slack の ADR-0001〜0003・0013 の考え方を先例にする。
- テナントの分離は、Slack の ADR-0009（共有スキーマと RLS）に倣う。
- 2 は、題材の比較という rebuilds の目的に反する。

## Consequences

- 良くなること：
  - 運用・CI・セキュリティの仕組みを使い回せる。
- 引き受けるコスト：
  - Notion に固有の規模（数千億のブロック）には、Slack にない分割（論理シャード）が要る（[ADR-0003](0003-workspace-sharding.md)）。

## Confirmation

- 領域ごとの設計で、Slack の先例と違う決定をするときは、その理由を ADR に書く。

---
status: accepted
date: 2026-09-27
---

# ADR-0052: 基盤の運用のメトリクスはノード・リージョン・cordon までのラベルで AMP に置き、関数ごとの値は呼び出しの記録から ClickHouse で集計する

詳細は [observability.md](../architecture/observability.md) の 2〜4 節。

## Context

S1 は 5 万関数、1 万アカウント、20 台前後のエッジのノード、プロセスは cordon ごと。関数ごと・isolate ごとの値をラベルに入れると、時系列の数は「関数 × ノード × 指標」になり、数百万を超えうる。

- 呼び出しの記録（`account_id`・`script_id`・`version_id`・`outcome`・`cpu_us`・`wall_ms`・`cold` など）は、すでにスーパーバイザーが作り、使用量（[ADR-0039](0039-usage-metering-pipeline.md)）と保存するログ（[ADR-0037](0037-tail-sessions-and-tenant-logs.md)）へ流している（[runtime-and-isolates.md](../architecture/runtime-and-isolates.md) の 6.3 節）。
- rebuilds の他の題材は、OpenTelemetry → AMP・X-Ray・CloudWatch Logs を共通にしている（[architecture/README.md](../architecture/README.md) の 4 節）。
- 本家は、配信の成否を Prometheus・Thanos の指標で判断して自動で戻す（[Scaling with safety](https://blog.cloudflare.com/safe-change-at-any-scale/)、2025-05-05、2026-09-27 に確認）。

## Options

1. **運用のメトリクスは AMP（ラベルはリージョン・AZ・ノード・cordon・部品・版まで）。関数ごと・アカウントごとの値は、呼び出しの記録を ClickHouse で 1 分ごとに集計する。isolate ごとの値は時系列にしない**
2. すべて AMP に入れ、関数ごとのラベルを付ける
3. すべて ClickHouse に入れる（AMP を使わない）

## Decision

1 を採用する。

- **AMP**（運用、`cp-prod` の運用のワークスペース）：ノードの OTel Collector が Prometheus の形で集め、30 秒ごとに書く。ラベルは `region`・`az`・`node_id`・`cordon`・`component`・`runtime_version`・`ami_version` だけ。`account_id`・`script_id`・`hostname` は禁止（CI で検査）。
- **isolate の値**（起動の時間、メモリ、退避の理由）は、ノードでヒストグラムと数に畳んでから出す。個々の isolate は呼び出しの記録にだけ残る。
- **関数ごとの値**：呼び出しの記録を ClickHouse の `invocation_rollup_1m`（`account_id`・`script_id`・`version_id`・`region`・`outcome` の 1 分ごとの件数・CPU・時間のヒストグラム）に集計する。利用者のメトリクスの画面と API はここを読む（[developer-tooling.md](../architecture/developer-tooling.md) の 8 節）。運用者は、上位の関数（うるさい隣人の調べ）にだけ使う。
- **トレース**：基盤の部品（入口、転送、外向き、ストレージのゲートウェイ）は OTel のトレースを 1% の標本で X-Ray へ。5xx と 1 秒を超える要求は必ず残す（末尾の標本は Collector で）。
- **基盤のログ**：ノードの部品のログは Vector で集め、構造化して S3（Parquet、30 日）と CloudWatch Logs（警報に要る少量、7 日）へ。利用者の要求の本文・`Authorization`・`Cookie` を出さない（[edge-network-and-routing.md](../architecture/edge-network-and-routing.md) の 13 節）。
- **セキュリティの事象**（seccomp の違反、探りの失敗、隔離）は、別の流れで `security` のアカウントへ送り、運用の画面に出さない（[sandbox-and-security.md](../architecture/sandbox-and-security.md) の 11 節）。
- 2 を採らない理由：時系列の数が費用と問い合わせの速さを壊す。AMP の上限（ワークスペースの有効な時系列の数。既定 5,000 万、最大 15 億。[AMP quotas](https://docs.aws.amazon.com/prometheus/latest/userguide/AMP_quotas.html)、2026-09-27 に確認）に、関数ごとのラベル（S1 で 5 万関数 × ノード × 指標）ならすぐ当たる。
- 3 を採らない理由：警報の評価（PromQL、記録の規則、Alertmanager）と、他の題材の運用の道具を捨てることになる。

## Consequences

- 良くなること：
  - 運用の時系列の数が、ノードの数と部品の数で決まり、テナントの数に比例しない。
  - 利用者の画面と、課金と、ログが、同じ呼び出しの記録から来るので、数が食い違わない。
- 引き受けるコスト：
  - うるさい隣人の調べは、AMP でなく ClickHouse への問い合わせになる（1 分の遅れ）。
  - ClickHouse が、利用者の画面の要の依存になる（[developer-tooling.md](../architecture/developer-tooling.md) の 10 節の障害の型）。

## Confirmation

- CI：Collector と部品のメトリクスの定義に、禁止のラベルがない。
- 監視：AMP の有効な時系列の数（ノードあたり 5 万以下を目安）と、取り込みの拒否の数。
- 突き合わせ：`invocation_rollup_1m` の件数と、使用量の `usage_hourly` の要求の数の差が 0.5% 以内（[limits-and-billing.md](../architecture/limits-and-billing.md) の 5.5 節と同じ基準）。

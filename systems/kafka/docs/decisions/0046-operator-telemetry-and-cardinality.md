---
status: accepted
date: 2026-09-27
---

# ADR-0046: 運用のメトリクスはブローカーの JVM の中の OpenTelemetry の JMX で集め、ラベルに論理クラスタは上位だけ、トピックとパーティションは載せない

詳細は [observability.md](../architecture/observability.md) の 2〜5 節。

## Context

- 可観測性の道具は、他の題材と同じ OpenTelemetry（ADOT）→ AMP・X-Ray・CloudWatch Logs。ブローカーの JMX は OpenTelemetry の Java エージェントで集める（[architecture/README.md](../architecture/README.md) の 4 節）。
- OpenTelemetry の Java エージェントの JMX の計装は、`otel.jmx.target.system` に `experimental-kafka-broker` を持ち、`otel.jmx.config` で YAML の規則を足せる（[jmx-metrics の README](https://github.com/open-telemetry/opentelemetry-java-instrumentation/blob/main/instrumentation/jmx-metrics/README.md)、2026-09-27 に確認）。
- 本家のブローカーは、トピック単位の `BrokerTopicMetrics`（`topic=` のタグ）と、要求の種類ごとの `RequestMetrics` を持つ（[Monitoring](https://kafka.apache.org/43/operations/monitoring/)、2026-09-27 に確認）。共有の物理クラスタでは、トピックの名前がテナントの名前空間の接頭辞付きで、数万になる。
- MSK は、JMX の Prometheus の収集の間隔を 60 秒以上にするよう勧める。短いと CPU を使う（[MSK best practices](https://docs.aws.amazon.com/msk/latest/developerguide/bestpractices.html)、2026-09-27 に確認）。
- AMP の既定の上限は、ワークスペースあたりの活動中の系列 5,000 万、ラベル 150 個（[AMP quotas](https://docs.aws.amazon.com/prometheus/latest/userguide/AMP_quotas.html)、2026-09-27 に確認）。
- テナント向けのメトリクスは、専用の AMP のワークスペースに置く（[ADR-0038](0038-usage-metering-and-metrics-api.md)）。耐久性の監査の事象の集め方は、この領域に任された（[replication-and-durability.md](../architecture/replication-and-durability.md) の 7.1 節）。
- 利用者のデータ（レコード、秘密）はログ・ラベルに出さない（[AGENTS.md](../../AGENTS.md)）。

## Options

収集：

1. **ブローカーの JVM の中の OpenTelemetry の Java エージェント（JMX の計装）→ ノードの OTel Collector → AMP**
2. JMX Exporter（Prometheus の形）を Strimzi の既定のとおりに使い、Collector が収集する
3. CloudWatch の Container Insights

ラベル：

- A. **運用の AMP では、`logical_cluster_id` は物理クラスタごとの上位 100 と `other`。トピック・パーティション・グループ・主体は載せない**
- B. トピックの名前をハッシュにして載せる
- C. 全てを載せる

## Decision

1 と A を採用する。

- 収集の間隔：JMX 60 秒。ただし、健康の判定に使う少数（URP、`UnderMinIsrPartitionCount`、`OfflinePartitionsCount`、`ActiveControllerCount`、要求の処理時間）は 15 秒の別の規則にする。CPU の増分を E1 で測る。
- `BrokerTopicMetrics` のトピックのタグ付きの系列は、Collector で捨てる。ブローカー全体の値だけを残す。テナントの内訳は、名前空間のパッチの出口のカウンター（[ADR-0038](0038-usage-metering-and-metrics-api.md)）から作る。
- 論理クラスタの内訳は、要求の数、書き込み・読み取りのバイト、throttle の時間、接続の数の 5 つだけに、上位 100 と `other` で付ける。
- 運用のログに、トピックの名前を生で出さない（自前の部品はハッシュにする）。本家のブローカーのログは内部の名前を含むので、データ面のアカウントの中に閉じ、読める人を限る。レコードの中身を含むログの行は出さない（本家のログの設定で DEBUG の要求のログを禁止する）。
- 監査の事象（耐久性・テナント）は、ブローカーのプラグインが内部のトピック（`__<brand>_durability_audit`、`__<brand>_audit`）に書き、データ面のエージェントが Firehose で log-archive の S3（Object Lock、1 年）へ送る。照合は S3 の上で行う。
- トレースは、制御面・エージェント・sni-router だけ。ブローカーの要求にはトレースを付けない（本家に計装がなく、量が多い）。
- 2 を選ばない理由：Strimzi の既定の JMX Exporter は HTTP の収集で、別の Collector の設定と、2 つ目の形式を抱える。1 は他の題材と同じ OTLP に揃い、YAML の規則でトピックのタグを早い段階で捨てられる。
- 3 を選ばない理由：Kafka のメトリクスの粒度と、PromQL の問い合わせ（Grafana）を他の題材と揃えられない。
- B を選ばない理由：ハッシュでも系列の数は減らず（トピックの数だけ増える）、運用の役に立たない。テナントのトピックの調査は、テナントのメトリクス（専用の AMP）を、期限つきの権限で見る。
- C を選ばない理由：S1 で 20 万のパーティション × ブローカーで、系列が数千万になる。

## Consequences

- 良くなること：
  - 運用の系列の数が、ブローカーの台数とほぼ比例に留まる（[observability.md](../architecture/observability.md) の 4 節の見積もりで約 25 万）。
  - 運用のメトリクスから、テナントのトピックの名前が漏れない。
- 引き受けるコスト：
  - トピックの単位で運用の問題を調べるときは、テナントのメトリクスを期限つきの権限で見る手間がかかる。
  - OpenTelemetry の Kafka の規則は `experimental` で、名前が変わりうる。自前の YAML の規則で名前を固定する。

## Confirmation

- CI：Collector の設定の検査。運用の AMP へ送る系列に、`topic`・`partition`・`group`・`principal` のラベルがない。
- 本番：運用の AMP の活動中の系列の数を、ブローカーあたりで監視する（2,000 を超えたらチケット）。
- ログの走査：API キーの秘密の形（`<brand>_sec_`）とレコードの断片が、ログに出ていない（[security-and-acls.md](../architecture/security-and-acls.md) の 11 節）。

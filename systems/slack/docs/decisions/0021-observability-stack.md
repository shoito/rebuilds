---
status: accepted
date: 2026-09-26
---

# ADR-0021: OpenTelemetry で計装し、メトリクスは Managed Prometheus、トレースは X-Ray、ログは CloudWatch Logs に送る

## Context

SLO（[runbooks/README.md](../runbooks/README.md)）の計測、障害の調査、テナントごとの負荷の把握に、ログ・メトリクス・トレースが必要になる。条件は次のとおり。

- 投稿から配信までが、API → outbox → Relay → Valkey / SQS → Gateway・Workers と、非同期の境界を何度もまたぐ。1 つのトレースで追いたい。
- `workspace_id` のラベルで上位のテナントを見たい（runbooks の 2 節）。系列の数が増えやすい。
- 本番のデータ（ログを含む）を本番のアカウントの外に出さない（[infrastructure.md](../architecture/infrastructure.md) の 7 節）。
- 運用するコンポーネントを増やしたくない（小さなチーム）。

## Options

計装は、どの選択肢でも OpenTelemetry（AWS Distro for OpenTelemetry、ADOT）を使う。ベンダーに依存しない形で計装し、送り先だけを選ぶ。

1. **CloudWatch に集める**：メトリクスは CloudWatch のカスタムメトリクス、トレースは X-Ray、ログは CloudWatch Logs
2. **AWS のマネージドなオープンソース**：メトリクスは Amazon Managed Service for Prometheus（AMP）、ダッシュボードは Amazon Managed Grafana、トレースは X-Ray、ログは CloudWatch Logs
3. **SaaS**（Datadog、Grafana Cloud など）にすべて送る

## Decision

2 を採用する。

- **メトリクスのラベルを多く持てる。** CloudWatch のカスタムメトリクスは、ディメンションの組み合わせごとに課金される。上位 N 件のテナントのラベル（[observability.md](../architecture/observability.md) の 3.2 節）を付けると高くつく。AMP は取り込んだサンプル数で課金され、PromQL でヒストグラムからパーセンタイルやバーンレートを計算しやすい。
- **トレースは X-Ray に送る。** CloudWatch は OTLP を直接受け取れ、X-Ray は OpenTelemetry を主な計装の方式にしている。ECS・SQS・ALB とのつながりを追加の運用なしに見られる。
- **ログは CloudWatch Logs に置く。** 各環境のアカウントの中にとどまり、本番のデータを外に出さない。Logs Insights で調べられ、データ保護ポリシーで個人情報をマスクできる。
- **Grafana で横断して見る。** AMP、CloudWatch、X-Ray をデータソースにし、SLO のダッシュボードを 1 か所に置く。Grafana は shared のアカウントに置き、各環境のロールを引き受けて読む。
- 1 は運用が最も少ないが、テナントのラベルとバーンレートの計算で費用と表現力が足りない。CloudWatch は、2026-06 から OTLP のメトリクスの受け取りと PromQL での問い合わせを一般提供している（東京を含む。料金は取り込み量の GB 単位。[AWS の発表](https://aws.amazon.com/about-aws/whats-new/2026/06/amazon-cloudwatch-otel-metrics/)）。AMP を CloudWatch に寄せられるかを、テナントのラベルの費用とバーンレートの計算で再評価する（S2 の前）。
- 3 は機能が最も豊かだが、本番のログとトレースを社外に出すことになり、テナントのデータの扱いを説明する負担が増える。費用もホスト数・ログ量に比例して読みにくい。

### 構成

| 信号 | 経路 | 保持 |
| --- | --- | --- |
| トレース | SDK → ADOT Collector（サイドカー）→ X-Ray | 30 日 |
| メトリクス | SDK → ADOT Collector → AMP（remote write）。AWS のリソースは CloudWatch のまま Grafana から読む | 150 日 |
| ログ | stdout（JSON）→ FireLens → CloudWatch Logs | prod 30 日 |
| アラート | AMP のルール → Alertmanager → SNS。AWS のリソースは CloudWatch アラーム → SNS | — |

オンコールの通知の道具（SNS の先）は、この ADR では決めない（[runbooks/incident-response.md](../runbooks/incident-response.md)）。

## Consequences

- 良くなること：
  - 計装が OpenTelemetry なので、送り先を後から変えても、アプリのコードは変わらない。
  - PromQL で SLO とバーンレートを素直に書ける。
  - 本番のデータが本番のアカウントにとどまる。
- 引き受けるコスト：
  - 見る場所が AMP・CloudWatch・X-Ray の 3 つに分かれる。Grafana に集めて緩和するが、アラートの定義も AMP と CloudWatch の 2 か所になる。アラートの定義は Terraform で一緒に管理する（[ADR-0020](0020-infrastructure-as-code-with-terraform.md)）。
  - ADOT Collector のサイドカーが、各タスクの CPU とメモリを少し使う。
  - 末尾でのサンプリングは、この構成ではできない。必要になったら、中央のコレクターを足す。

## Confirmation

- 結合テストで、投稿 1 件のトレースが API、Relay、Gateway、Worker のスパンを持つこと（outbox と SQS を越えて伝播すること）を確かめる。
- ログの lint：禁止された項目（本文、メールアドレス、トークンなど）をロガーに渡すコードがあれば、CI で失敗させる。
- 系列の数を監視し、上限の 80% でアラートを出す。
- すべてのアラートに runbook の URL があることを、CI でアラートの定義から検査する。

# Observability: Kafka

運用のためのメトリクス・ログ・トレース、ブローカーの JMX の集め方、テナントのラベルの数の抑え方、監査の事象の集め方、外からの合成監視、層ごとの SLI と SLO、アラートと runbook の対応の設計。道具は他の題材と同じ OpenTelemetry（ADOT）→ AMP・X-Ray・CloudWatch Logs、Grafana で横断する（[README.md](README.md) の 4 節）。決定は [ADR-0046](../decisions/0046-operator-telemetry-and-cardinality.md)（運用のテレメトリー）と [ADR-0047](../decisions/0047-slos-synthetic-probes-and-alerts.md)（SLO・合成監視・アラート）。

テナント向けのメトリクスの API（専用の AMP）は [metrics-and-billing.md](metrics-and-billing.md) の 6 節、耐久性の監査の中身（AUD-1〜7）は [replication-and-durability.md](replication-and-durability.md) の 7 節にある。SLO の値とアラートの一覧の正本は、Ops の [runbooks/README.md](../runbooks/README.md) の 1・5 節に移した（統合の工程）。値を変えるときは runbooks/README.md を先に変え、この文書を合わせる。ここにはそれを計測する仕組みを書く。

本家と AWS の振る舞いは、2026-09-27 に公式の文書で確かめた。確かめられなかったものは「未検証」と書く。

## 1. 全体の流れ

```
データ面（dp-prod）
  ブローカー・コントローラー（JVM）
    ├─ OpenTelemetry の Java エージェント（JMX の計装）── OTLP ──▶ ノードの OTel Collector
    ├─ 名前空間のパッチの出口のカウンター（テナント別）── OTLP ──▶ 同上
    ├─ log4j2（JSON）──▶ Fluent Bit ──▶ CloudWatch Logs（dp-prod）──▶ Firehose ──▶ log-archive の S3
    └─ 監査のプラグイン ──▶ __<brand>_durability_audit・__<brand>_audit ──▶ エージェント ──▶ Firehose ──▶ log-archive の S3（Object Lock）
  Envoy（統計、アクセスログ）、sni-router、エージェント、クォータのコーディネーター
        │
  OTel Collector（EKS ごとの gateway）
    ├─ 運用のメトリクス ──▶ 運用の AMP（cp-prod。環境ごと）      ← ラベルを絞る（4 節）
    ├─ テナントのメトリクス ──▶ テナントの AMP（cp-prod）         ← metrics-and-billing の 6 節
    └─ トレース（エージェント、sni-router）──▶ X-Ray（dp-prod）
制御面（cp-prod）：api・internal-api・relay・usage・billing ── 他の題材と同じ（トレースは X-Ray）
合成監視（probe のアカウント、東京と大阪）── 結果 ──▶ 運用の AMP
Grafana（shared）：運用の AMP・CloudWatch・X-Ray を読む。テナントの AMP は期限つきの権限でだけ読む
アラート：AMP のルール → Alertmanager → SNS → オンコール。AWS のリソースは CloudWatch アラーム → SNS
```

- 運用の AMP とテナントの AMP を分ける（[ADR-0038](../decisions/0038-usage-metering-and-metrics-api.md)）。運用の AMP には、テナントのトピックの名前を入れない（[ADR-0046](../decisions/0046-operator-telemetry-and-cardinality.md)）。
- データ面は、制御面が止まっても、自分の Collector と CloudWatch Logs に書き続ける。運用の AMP が cp-prod にあるので、cp-prod の AMP の障害の間はメトリクスが欠ける。欠けは Collector の送信の待ち行列（最大 1 時間。AMP は 1 時間より古い値を受けない。[AMP quotas](https://docs.aws.amazon.com/prometheus/latest/userguide/AMP_quotas.html)）で吸収する。データ面の健全性の最低限（URP、オフラインのパーティション、カナリア）は、dp-prod の CloudWatch のアラームにも二重に置く。

## 2. 計装

### 2.1 ブローカーとコントローラー

- OpenTelemetry の Java エージェントを、Strimzi の `jvmOptions`（`-javaagent`）で載せる。JMX の計装の対象は `experimental-kafka-broker` と、自前の YAML の規則（`otel.jmx.config`）（[jmx-metrics の README](https://github.com/open-telemetry/opentelemetry-java-instrumentation/blob/main/instrumentation/jmx-metrics/README.md)、2026-09-27 に確認）。`experimental` の規則の名前は変わりうるので、使う全ての系列を自前の規則で名前を固定する。
- 収集の間隔は 60 秒。健康の判定に使う系列だけ 15 秒（下の表の ★）。MSK は、JMX の収集を 60 秒より短くすると CPU を使うとする（[MSK best practices](https://docs.aws.amazon.com/msk/latest/developerguide/bestpractices.html)）。15 秒の分の CPU の増分を E1 で測る。
- 集める主な系列（MBean の名前は [Monitoring](https://kafka.apache.org/43/operations/monitoring/)、2026-09-27 に確認）：

| 分類 | 系列 | 用途 |
| --- | --- | --- |
| 複製 | ★ `ReplicaManager` の `UnderReplicatedPartitions`、`UnderMinIsrPartitionCount`、`IsrShrinksPerSec`・`IsrExpandsPerSec` | ISR の健全性、ロールの関門（[ADR-0050](../decisions/0050-rolling-upgrade-gates-and-upstream-tracking.md)） |
| コントローラー | ★ `KafkaController` の `ActiveControllerCount`、`OfflinePartitionsCount`、`MetadataErrorCount`。`MetadataLoader` の `CurrentMetadataVersion` | クォーラム、オフライン、メタデータの適用の失敗、版の揃い |
| 要求 | ★ `RequestMetrics` の `TotalTimeMs`（`Produce`、`FetchConsumer`、`FetchFollower`）の分位点。`RequestHandlerAvgIdlePercent`、`NetworkProcessorAvgIdlePercent` | 遅延、劣化の検出（5 節）、CPU の余裕 |
| スループット | `BrokerTopicMetrics` の `BytesInPerSec`・`BytesOutPerSec`・`MessagesInPerSec`（ブローカー全体だけ） | 容量（[capacity.md](capacity.md)） |
| 階層型の保存 | `RemoteCopyLagBytes`（ブローカー全体に集約）、リモートの読み取りの待ち行列、S3 の失敗（包む層） | [tiered-and-object-storage.md](tiered-and-object-storage.md) の 15 節 |
| ログ | クリーナーの最終の実行からの時間、回復の時間 | [broker-and-log-storage.md](broker-and-log-storage.md) の 13 節 |
| KRaft | 投票者・観測者の遅れ、スナップショットの大きさ | [metadata-and-control.md](metadata-and-control.md) の 6.4 節 |
| JVM・ノード | ヒープ（GC の後）、GC の停止、ファイル記述子、mmap の数、ディスクの使用率・I/O の待ち、ネットワークの送受信、ENA の上限の超過（`bw_out_allowance_exceeded` など） | 容量、劣化 |
| テナント | 名前空間のパッチの出口のカウンター（要求、書き込み・読み取りのバイト、throttle の時間、接続） | 4 節の規則でだけ運用の AMP へ |

- ENA の上限の超過の数（ネットワークの基準の帯域を超えたときのパケットの破棄）を集めるのは、4xlarge 以下の型がバーストの後に基準の帯域へ戻ることを見るため（[Instance network bandwidth](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-instance-network-bandwidth.html)）。

### 2.2 エッジ

- Envoy：下流と上流の接続の数、新しい接続の頻度、バイト、上流への接続の失敗、RBAC の拒否、AZ をまたいだ接続の数（`edge_cross_az_connections`）、xDS の最後の更新からの時間。
- Envoy のアクセスログ：接続ごとに、下流の送信元（Proxy Protocol の値）、SNI、上流のブローカー、上流への接続の送信元ポート、バイト、時間、終了の理由。ブローカーは送信元 IP を知らないので、監査ログの IP と認証の失敗の IP ごとの集計は、このログと突き合わせて作る（[infrastructure.md](infrastructure.md) の 5.4 節）。SNI はテナントの lc-id を含むが、トピックの名前やレコードは含まない。
- NLB：CloudWatch の `ActiveFlowCount`、`NewFlowCount`、`ProcessedBytes`、`UnHealthyHostCount`、`ZonalHealthStatus`。

### 2.3 制御面とデータ面の部品

- 制御面：他の題材と同じ（RED、outbox の遅れ、ドメインのスパン）。
- データ面のエージェント：責務ごとのメトリクス（[control-plane-and-provisioning.md](control-plane-and-provisioning.md) の 5.3 節）。反映の遅れ（`generation − observed_generation` と時間）、命令の結果、使用量の送信の遅れ、監査の事象の送信の数。
- エージェント・sni-router はトレースを付ける（internal-api の呼び出しまで 1 つのトレース）。ブローカーの要求にはトレースを付けない（[ADR-0046](../decisions/0046-operator-telemetry-and-cardinality.md)）。

## 3. ログ

- 1 行 1 JSON。項目は許可リスト方式（他の題材と同じ）。
- **レコードの中身・キー・ヘッダー、API キーの秘密、SASL の資格情報を出さない**（[AGENTS.md](../../AGENTS.md)）。本家のブローカーの要求のログ（`kafka.request.logger` の DEBUG 以上）は無効に固定し、起動時に検査する。
- **トピックの名前**：自前の部品（エージェント、RSM の包む層、プラグイン）は、トピックの名前をハッシュ（`topic_hash`）とトピックの ID で出す。本家のブローカーのログは内部の名前（`lc-<id>_<名前>`）を含み、変えられない。そこで、ブローカーのログは dp-prod の CloudWatch Logs に閉じ、読める人を期限つきの権限を得た Ops に限る（[tiered-and-object-storage.md](tiered-and-object-storage.md) の 10 節の「運用のログはハッシュ」を、ブローカーの本家のログには当てられない点を補う）。
- 保持：CloudWatch Logs 30 日（ブローカーのログは量が多い）、log-archive の S3 に 1 年。

| データ | すぐに使える場所 | 保管 |
| --- | --- | --- |
| ブローカー・コントローラー・Envoy のログ | CloudWatch Logs（dp-prod）30 日 | S3（log-archive）1 年 |
| 制御面のログ | CloudWatch Logs（cp-prod）90 日 | S3 1 年 |
| 監査ログ（テナント）、耐久性の監査の事象 | 索引（Aurora の `audit_events`）90 日、Athena | S3（Object Lock）1 年（[ADR-0030](../decisions/0030-encryption-and-audit-logs.md)） |
| 運用のメトリクス | AMP 150 日 | 保管しない |
| トレース | X-Ray 30 日 | 保管しない |

## 4. ラベルと系列の数

[ADR-0046](../decisions/0046-operator-telemetry-and-cardinality.md)。

| ラベル | 運用の AMP | テナントの AMP |
| --- | --- | --- |
| `physical_cluster_id`、`broker_id`、`az_id`、`tier` | 常に | 付けない（テナントに見せない） |
| `logical_cluster_id` | 物理クラスタごとの上位 100（要求の数で）と `other`。要求の数、書き込み・読み取りのバイト、throttle の時間、接続の数の 5 つだけ | 常に（必須の条件） |
| `topic` | 付けない | 付ける（論理クラスタあたり 1 万の系列まで。[metrics-and-billing.md](metrics-and-billing.md) の 6.1 節） |
| `partition`、`group`、`principal`、`client_id` | 付けない | `group` だけ付ける |
| `api_key`（要求の種類）、`error_code` | 付ける（値は本家の定義の数だけ） | `request_count` の `type` だけ |

- `BrokerTopicMetrics` のトピックのタグ付きの系列（本家はトピックごとに出す）は、Collector で落とす。落とす前にブローカーの JVM が作る MBean の数も多いので、本家のメトリクスの報告を JMX でだけ行い、ヒープへの影響を T2（[capacity.md](capacity.md) の 11 節）で測る。
- 見積もり：ブローカーあたり、本家の系列 約 1,000（要求の種類 × 分位点を含む）＋ テナントの上位 100 × 5 ＋ JVM・ノード 約 300 ≒ 1,800。S1 の上限の 150 台で約 27 万の系列。AMP の既定の上限（ワークスペースあたり 5,000 万）から遠い（[AMP quotas](https://docs.aws.amazon.com/prometheus/latest/userguide/AMP_quotas.html)）。
- 費用：60 秒の収集で、月に約 120 億のサンプル。AMP の東京の単価（最初の 20 億まで 1,000 万あたり $0.90、次の 2,500 億まで $0.35。Price List API）で約 $600/月。15 秒の系列を足すと増える。
- 系列の数をブローカーあたりで監視し、2,000 を超えたらチケットにする（ラベルの漏れの早期の検知）。

## 5. 劣化したブローカーの検出（降格の引き金）

[metadata-and-control.md](metadata-and-control.md) の 5.3 節は、降格の閾値をこの領域に任せた。Kora は、クラスタの全体との比べで劣化を見つけ、ネットワークを失ったブローカーは降格し、ストレージが進まないブローカーは再起動する（[Kora](https://vldb.org/pvldb/vol16/p3822-povzner.pdf) の 4.5 節、2026-09-27 に確認）。

| 種類 | 条件（初期値） | 動き |
| --- | --- | --- |
| 遅いブローカー | `Produce` の `TotalTimeMs` の p99 か、ディスクの I/O の待ちが、同じ物理クラスタのブローカーの中央値の 3 倍を超え、かつ p99 が 50ms を超える状態が 5 分続く | データ面のエージェントが降格（物理クラスタで同時に 1 台まで）。チケット |
| ネットワークを失ったブローカー | 合成監視とテナントの要求の両方が、そのブローカーに 2 分届かない。ブローカー自体は KRaft に登録されている | 降格。呼び出し（Envoy・NLB の AZ の障害の可能性） |
| ストレージが進まないブローカー | ログのフラッシュ・セグメントの書き込みが 2 分進まない | ブローカーを再起動（KRaft で締め出され、戻るまで ISR に入らない）。呼び出し |
| 2 台以上が同時に条件に当たる | — | 自動の降格をしない。AZ か物理クラスタの障害として呼び出す（誤作動で健全なブローカーを降格しないため） |

- 自動の降格はフラグ `broker.demotion.auto`（[ADR-0049](../decisions/0049-build-pipelines-artifacts-and-flags.md)）で止められる。
- 合成監視のパーティション（6 節）は、降格と再配置の対象から外す（リーダーを固定するため）。降格したブローカーの合成監視は失敗として数えず、「降格中」として別に見せる。

## 6. 合成監視

[ADR-0047](../decisions/0047-slos-synthetic-probes-and-alerts.md)。Kora の HC（ロードバランサーとプロキシを通して、ブローカーごとに毎分 100 回の produce と consume。[Kora](https://vldb.org/pvldb/vol16/p3822-povzner.pdf) の 4.4.1・4.4.2 節）に倣う。

| シナリオ | 場所 | 頻度 | 測るもの |
| --- | --- | --- | --- |
| ブローカーごとの produce（`acks=all`・冪等、1 KB）と consume（`read_committed`） | probe の東京の 3 つの AZ（`client.rack` を設定） | ブローカーごとに毎秒 1 回 | 可用性、produce の遅延、端から端の遅延 |
| ブートストラップの接続（DNS、TLS の検証、SASL、Metadata） | 同上 | 論理クラスタの経路ごとに 1 分 | 入口の健全性、証明書の残りの日数 |
| 隣のテナントの確認（2 つの論理クラスタで、互いのトピック・グループ・ACL が見えない） | 同上 | 1 分 | テナントの分離（[multi-tenancy-and-quotas.md](multi-tenancy-and-quotas.md) の 9 節） |
| 論理クラスタの作成 → トピックの作成 → produce → consume → 削除 | 同上（管理 API と CLI） | 15 分 | SC-3（5 分）、制御面の反映の遅れ |
| 管理 API・メトリクスの API | 同上 | 1 分 | 制御面の可用性、メトリクスの鮮度（3 分） |
| ブローカーごとの produce・consume | probe の大阪 | ブローカーごとに 10 秒に 1 回 | リージョンの到達性（遅延には使わない） |

- 物理クラスタごとに、運用の論理クラスタ（合成監視用。耐久性のカナリア（AUD-7）と同じ論理クラスタでよい）を持つ。ブローカーごとに `probe-b<broker-id>` のトピック（1 パーティション、リーダーをそのブローカーに固定）を置く。
- 合成監視の論理クラスタは、テナントと同じ名前空間・クォータ・経路（NLB と Envoy）を通す。上限に当たったら、それ自体を異常にする。
- 合成のレコードは合成のデータだけで、利用者のデータを含まない。
- probe のアカウントは、データ面・制御面と別のアカウント（[infrastructure.md](infrastructure.md) の 1 節）。内部のネットワークの外から、利用者と同じ公開の経路を通る。

## 7. SLI と SLO

### 7.1 層ごとの SLO（S1）

| SLI | 定義 | Basic | Standard | 計測 |
| --- | --- | --- | --- | --- |
| 可用性（NFR-002） | 合成の produce と consume のうち、5 秒以内に成功した割合（30 日）。throttle は失敗にしない | 99.5% | 99.95%（S2 で 99.99%） | 6 節 |
| produce の遅延（NFR-003） | 分ごとに、ブローカーごとの合成の produce の p99 を出し、物理クラスタの最悪のブローカーの値をその分の値にする。30 日の分の値の p99 | 100ms | 50ms | 6 節 |
| 端から端の遅延（NFR-004） | 同じ方法で、produce の開始から consume までの p99 | 200ms | 100ms | 6 節 |
| 受け付けた書き込みの喪失（NFR-001、SC-2） | カナリア（AUD-7）の抜け、監査（AUD-1〜6）の不一致 | 0 | 0 | [replication-and-durability.md](replication-and-durability.md) の 7 節 |
| テナントの分離（NFR-008 の前半） | 隣のテナントの確認の失敗、`tenant_boundary_violation` | 0 | 0 | 6 節、[ADR-0029](../decisions/0029-tenant-scoped-acls-and-rbac.md) |
| クォータの公平さ（NFR-008 の後半） | クォータの中なのに絞られた時間が週 5 分以内のテナントの割合 | 99.9% | 99.9% | [multi-tenancy-and-quotas.md](multi-tenancy-and-quotas.md) の 7.5 節 |
| 管理 API の可用性 | 管理 API の要求のうち、5xx とタイムアウトでない割合 | 99.9% | 99.9% | ALB、合成監視 |
| 反映の遅れ | 望ましい状態の変更から `observed_generation` まで p99 | 30 秒 | 30 秒 | [control-plane-and-provisioning.md](control-plane-and-provisioning.md) の 5.1 節 |
| 論理クラスタの作成 | `requested` から `running` まで p99 | 60 秒 | 60 秒 | 同上 |
| メトリクスの鮮度 | 発生から問い合わせられるまで p99 | 3 分 | 3 分 | [metrics-and-billing.md](metrics-and-billing.md) の 6.2 節 |

- 補助の指標：テナントの実際の produce・fetch の要求のうち、サービスの失敗を返した割合（`NOT_ENOUGH_REPLICAS`、`REQUEST_TIMED_OUT`、`NOT_LEADER_OR_FOLLOWER` の急増など。クライアントの誤りの `*_AUTHORIZATION_FAILED`、`POLICY_VIOLATION` は除く）。SLO にはせず、合成監視が見落とす部分（特定のテナントのパーティション）を見る。
- SLA（利用者への約束。返金の条件）は、法務の確認（intent.md の L6）の後に、この SLI から作る。
- Kora と同じく、物理クラスタごとの週の値の分布（中央値・p90・p99）を「全体の SLO」としてダッシュボードに出し、改善の優先度に使う（Kora の 4.4.2 節）。

### 7.2 エラーの予算とバーンレート

Standard の 99.95% は、30 日の予算が約 21.6 分。Basic の 99.5% は約 3.6 時間。

| 重さ | 長い窓 | 短い窓 | バーンレート | 意味 |
| --- | --- | --- | --- | --- |
| 呼び出し | 1 時間 | 5 分 | 14.4 | 1 時間で月の予算の 2% を消費 |
| 呼び出し | 6 時間 | 30 分 | 6 | 6 時間で 5% |
| チケット | 3 日 | 6 時間 | 1 | このペースで月の予算を使い切る |

- 物理クラスタごとに計算する（1 つの物理クラスタの障害を、全体の平均で薄めない）。
- 耐久性・テナントの分離・監査の不一致は予算を持たない。1 件で呼び出す。
- エラーの予算を使い切った物理クラスタでは、修正以外の変更（本家の版の更新、パッチ）を止める（[delivery.md](delivery.md) の 6 節）。

## 8. アラートと runbook

手順の列は、今ある runbook と、各 Epic で作る runbook を指す。個別の runbook ができるまでは [incident-response.md](../runbooks/incident-response.md) の該当の節で対応する。すべてのアラートは runbook の URL を注釈に持つ（CI で検査する）。

| アラート | 条件（初期値） | 重さ | 手順 |
| --- | --- | --- | --- |
| 可用性の速いバーンレート | 7.2 節 | 呼び出し | [incident-response.md](../runbooks/incident-response.md) |
| 合成監視の連続失敗（ブローカー） | 1 つのブローカーで 2 分続けて 50% 以上失敗 | 呼び出し | [incident-response.md](../runbooks/incident-response.md) |
| 合成監視の連続失敗（AZ） | 1 つの AZ の全ブローカーで 1 分続けて失敗 | 呼び出し（SEV2） | [incident-response.md](../runbooks/incident-response.md) の「AZ の喪失」 |
| オフラインのパーティション | `OfflinePartitionsCount` > 0 が 1 分 | 呼び出し（SEV1） | [incident-response.md](../runbooks/incident-response.md) の「オフラインのパーティション」 |
| min ISR を下回るパーティション | `UnderMinIsrPartitionCount` > 0 が 2 分 | 呼び出し | 同上 |
| 複製の遅れ | URP > 0 が 10 分（チケット）、30 分（呼び出し） | チケット → 呼び出し | [incident-response.md](../runbooks/incident-response.md) |
| コントローラー | 物理クラスタの `ActiveControllerCount` の和が 1 でない状態が 1 分。投票者が 1 台でも落ちた | 呼び出し | [incident-response.md](../runbooks/incident-response.md)。`controller-replacement.md`・`kraft-quorum-loss.md`（E3） |
| カナリアの抜け（AUD-7） | 成功を返した連番が 5 分読めない | 呼び出し（SEV1） | [incident-response.md](../runbooks/incident-response.md) の「耐久性の監査の不一致」 |
| 耐久性の監査の不一致（AUD-1〜6）、階層型の監査の重大な破れ | 1 件以上 | 呼び出し（SEV1） | 同上 |
| テナントの境界の拒否（`tenant_boundary_violation`）、隣のテナントの確認の失敗 | 1 件以上 | 呼び出し（SEV1） | [incident-response.md](../runbooks/incident-response.md)。`tenant-boundary-violation.md`（E8） |
| 背圧・うるさい隣人 | 1 つのブローカーの背圧が 1 分以上続く。クォータの中で絞られたテナントが 15 分で 1% を超える | 呼び出し | [incident-response.md](../runbooks/incident-response.md) の「うるさい隣人」 |
| ディスクの使用率 | 70%（チケット）、85%（呼び出し）、90%（cordon の確認） | チケット → 呼び出し | `broker-disk-pressure.md`（E3） |
| 劣化したブローカー | 5 節（自動の降格の実行、2 台以上） | チケット（1 台）、呼び出し（2 台以上） | `slow-broker-demotion.md`（E3） |
| ロールの関門で停止 | rolling-update-guard が 30 分進めない（[ADR-0050](../decisions/0050-rolling-upgrade-gates-and-upstream-tracking.md)） | 呼び出し | [deploy-and-rollback.md](../runbooks/deploy-and-rollback.md) |
| 本家の版の遅れ | 最新のマイナー版の x.y.0 から 3 か月 | チケット | [deploy-and-rollback.md](../runbooks/deploy-and-rollback.md) |
| 証明書の期限 | 30 日前（チケット）、7 日前（呼び出し） | チケット → 呼び出し | `tls-certificate-renewal.md`（E12） |
| エッジ | NLB の AZ の健全なターゲットが 0、Envoy の上流への接続の失敗の急増、xDS の更新が 10 分ない | 呼び出し | [incident-response.md](../runbooks/incident-response.md)。`edge-az-outage.md`（E12） |
| 反映の遅れ | `observed_generation` の遅れが 5 分 | 呼び出し | `agent-down.md`（E9） |
| クォータのコーディネーター | 配分が 5 分更新されない | チケット | `quota-coordinator-down.md`（E7） |
| 階層型の上げの遅れ | 閉じたセグメントが 30 分上がらない | チケット（2 時間で呼び出し） | `tiered-copy-stalled.md`（E4） |
| ぶら下がったトランザクション | 最も古い開いたトランザクションが 15 分を超える | チケット | `hanging-transaction.md`（E5） |
| 表にない API | 件数 > 0 | 呼び出し | `unknown-api-alert.md`（E2） |
| KMS のスロットリング | `ThrottlingException` が 1 件以上 | 呼び出し | [incident-response.md](../runbooks/incident-response.md) |
| 使用量の照合の不一致 | 1% を超える | チケット | `usage-reconciliation-mismatch.md`（E11） |
| Global Database の遅れ | `AuroraGlobalDBRPOLag` が 30 秒を 5 分超える（NFR-009 の RPO 1 分） | 呼び出し | [disaster-recovery.md](../runbooks/disaster-recovery.md) |
| 大阪への写しの遅れ | S3 RTC の `ReplicationLatency` が 15 分を超える、`OperationsFailedReplication` > 0 | チケット | [disaster-recovery.md](../runbooks/disaster-recovery.md) |
| KRaft のスナップショットの写し | 2 時間ない | チケット | [disaster-recovery.md](../runbooks/disaster-recovery.md) |
| 大阪からの合成監視の全失敗 | 東京の全ブローカーで 3 分 | 呼び出し（SEV1） | [disaster-recovery.md](../runbooks/disaster-recovery.md) |

- 呼び出しは、SLO と、耐久性・テナントの分離・データの喪失に関わる症状に限る。原因の側の指標（CPU など）はチケットとダッシュボードにとどめる。

## 9. ダッシュボード

| ダッシュボード | 主な中身 | 見る人 |
| --- | --- | --- |
| SLO | 7 節の SLI、予算の残り、バーンレート（層・物理クラスタごと） | 全員 |
| 物理クラスタ | ブローカーごとの遅延、ISR、URP、オフライン、コントローラー、ディスク、送信と EBS の基準に対する使用率、降格・cordon | Ops |
| 耐久性 | カナリア、監査の結果、unclean な選出の記録、階層型の監査 | Ops、Dev のテックリード |
| テナント（運用） | 上位 100 の論理クラスタの要求・バイト・throttle、背圧、NFR-008 の指標 | Ops |
| エッジ | NLB と Envoy の接続・バイト、AZ をまたいだ接続、RBAC の拒否、証明書の残り | Ops |
| ロール | 進行中のロール、関門の結果、本家の版の物理クラスタごとの分布 | Ops |
| DR | Global Database の遅れ、CRR の遅れ、KRaft のスナップショットの写し、大阪の骨組みの健全性 | Ops |
| 原価 | 書き込み 1 GB あたりの原価の内訳（[capacity.md](capacity.md) の 8 節） | Ops、PM |

## 10. アクセス

- 運用の AMP・CloudWatch Logs・X-Ray は、Ops と、Ops が許可した Dev が読む（読み取り専用）。
- テナントの AMP と、ブローカーのログ（トピックの名前を含む）は、期限つきの権限（最長 4 時間、理由の記録）で読む。読んだことは監査ログの「運用者のアクセス」に残る（[security-and-acls.md](security-and-acls.md) の 7 節）。
- AI エージェントは、本番のログ・メトリクス・トレースへの経路を持たない。人が取り出したものを渡すときも、テナントのトピックの名前を伏せる。

## 11. ADR

| ADR | 決定 |
| --- | --- |
| [0046](../decisions/0046-operator-telemetry-and-cardinality.md) | 運用のメトリクスはブローカーの JVM の中の OpenTelemetry の JMX で集め、ラベルに論理クラスタは上位だけ、トピック・パーティションは載せない。監査の事象は内部のトピックからエージェントが S3 へ送る |
| [0047](../decisions/0047-slos-synthetic-probes-and-alerts.md) | 可用性と遅延の SLI は、外からブローカーごとに流す合成の produce・consume で測る。層ごとの SLO とバーンレートで呼び出す |

## 12. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E1 | `broker-otel-jmx` | Java エージェント、自前の YAML の規則、15 秒と 60 秒の系列、CPU の増分の測定 |
| E1 | `telemetry-pipeline` | ノードと gateway の Collector、運用とテナントの AMP への分け方、ラベルの落とし方 |
| E3 | `audit-event-shipping` | `__<brand>_durability_audit` → エージェント → Firehose → S3、送った数の照合 |
| E3 | `degraded-broker-detector` | 5 節の検出と自動の降格 |
| E12 | `synthetic-probes` | 6 節の合成監視（東京と大阪）、合成監視の論理クラスタとリーダーの固定 |
| E12 | `slo-and-burn-rate` | 7 節の SLI の記録の規則、バーンレートのアラート、月次の報告 |
| E12 | `alert-runbook-lint` | アラートの規則に runbook の URL があることの CI の検査 |
| E12 | `ops-dashboards` | 9 節 |
| E12 | `edge-access-log-correlation` | Envoy のアクセスログとブローカーの接続の突き合わせ（監査ログの IP。E8 と一緒に） |
| E12 | `cardinality-guard` | ブローカーあたりの系列の数の監視とチケット |

## 13. 未解決の問い

### 決定（2026-09-27、既定案）

- **収集**：OpenTelemetry の Java エージェントの JMX。60 秒、健康の系列だけ 15 秒。
- **ラベル**：運用の AMP は論理クラスタの上位 100 と 5 つの系列だけ。トピックは載せない。
- **監査の事象の経路**：物理クラスタの内部のトピック → エージェント → Firehose → log-archive の S3。replication-and-durability の 7.1 節の「運用の論理クラスタの内部のトピック」ではなく、他の `__<brand>_` の内部のトピックと同じ置き方にする。
- **降格の閾値**：中央値の 3 倍かつ p99 50ms 超えが 5 分。同時に 1 台まで。
- **SLI**：外からの合成監視。遅延は最悪のブローカーの値。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| 15 秒の JMX の収集の CPU の増分 | E1 |
| ブローカーの本家のログのトピックの名前を伏せるか（log4j2 の置き換えの規則） | E12。性能への影響を見て |
| SLA の文言（「悪い分」の定義を使うか） | 法務の確認（intent.md の L6） |
| 合成監視のリーダーの固定と、再均衡の計画器（Cruise Control）の除外の設定 | E9（[metadata-and-control.md](metadata-and-control.md) の 4.2 節） |
| Basic の遅延の SLO（100ms・200ms）の値 | GA の前の実測 |

## 14. quality.md・runbooks・data-model への項目

### quality.md

- SLO の達成（層・物理クラスタごと）と、予算の消費の主な原因。本番での品質検証の中心の指標にする。
- 合成監視の網羅：全てのブローカーに合成監視のパーティションがあり、リーダーが固定されている割合（目標 100%）。
- アラートの規則のうち runbook の URL を持つ割合（目標 100%。CI）。
- 運用の AMP のブローカーあたりの系列の数（目標 2,000 以下）。

### runbooks/README.md

- SLO の表（7.1 節）と、予算の方針（7.2 節）を正本として移す。
- アラート → 手順の表（8 節）を正本として移す。
- 個別の手順の候補：`degraded-broker.md`（5 節の自動の降格が 2 台以上で止まったとき。統合で `slow-broker-demotion.md` にまとめた）、`synthetic-probe-false-alarm.md`（probe のアカウント側の障害の見分け方）。

### data-model

- `slo_monthly_reports`（制御面、または S3 の報告）：月、層、物理クラスタ、SLI、達成の値、予算の消費。
- 運用の AMP の系列（索引）：[data-model.md](data-model.md) の 6 節。

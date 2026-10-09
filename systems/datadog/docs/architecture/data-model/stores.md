# Data model: Aurora の外（MSK・S3・Valkey・SNS と SQS・AppConfig・自己監視・NVMe）

[data-model.md](../data-model.md) の一部。規約はそちらの 3 節に従う。Aurora の外の置き場所の形の正本。ファイルの形式（`TSB1`・`TSC1`・`LSEG`・`tidx`・`EVR1`）は [tsdb-formats.md](tsdb-formats.md)、[log-segment-format.md](log-segment-format.md)、[traces.md](traces.md)、[monitors-and-notifications.md](monitors-and-notifications.md) にある。

## 1. MSK

[ADR-0002](../../decisions/0002-intake-log-on-msk.md)、[ADR-0011](../../decisions/0011-intake-gateway-pipeline-and-watermark-ticks.md)、[ADR-0017](../../decisions/0017-cardinality-admission-via-control-records.md)、[ADR-0030](../../decisions/0030-log-pipeline-execution-model.md)、[ADR-0060](../../decisions/0060-msk-express-and-ec2-fleets.md)。セルごとに 1 つのクラスタ。複製 3、`min.insync.replicas=2`、保持 24 時間。

### 1.1 トピックと共通の頭

| トピック | パーティション（S1 の仮） | パーティションの決め方 | 書き手 | 読み手 | トランザクション |
| --- | --- | --- | --- | --- | --- |
| `metrics` | 1,024 | 組織の組の中で系列（[tsdb-formats.md](tsdb-formats.md) の 1.2 節）。制御のレコードは組の全部 | `intake-gateway`、`derived-metrics-aggregator`、`limits-coordinator` | `metrics-ingester`（写し A・B）、`usage-aggregator` | 集め直しの段だけ |
| `logs-raw` | 512 | 組織の組の中でばらす | `intake-gateway` | `log-processor`、`usage-aggregator` | なし |
| `logs` | 512 | 組織の組の中でばらす | `log-processor` | `log-indexer`、アーカイブの書き手、`live-tail`、`usage-aggregator`（`read_committed`） | あり |
| `spans` | 512 | 組織の組の中で `trace_id` | `intake-gateway` | `trace-assembler`、`usage-aggregator` | なし |
| `derived-partials` | 64 | 系列の鍵 | `log-processor`（トランザクション）、`trace-assembler` | `derived-metrics-aggregator` | 書き手による |
| `usage` | 64 | 組織 | `intake-gateway` | `usage-aggregator` | なし |
| `audit` | 64 | 組織 | `relay`、`query-frontend` | `log-indexer`（索引 `audit`）、`audit-archiver` | なし |

- 本文は内部の Protobuf を zstd で圧縮する。1 レコード 1 MiB まで。レコードの時刻（CreateTime）は `t_in_ms`。
- **共通の頭**（すべてのメッセージの先頭。`Tick` を除く）：

```
Header {
  tenant_id: bytes(16)       // 認証の文脈から。本文・タグから取らない
  format_version: u16        // 1（ADR-0066。保持の 24 時間の後に古い番号を消してよい）
  t_in_ms: i64               // 取り込みの時刻（書き手の時計。パーティションごとに単調にする）
  writer_id: u32             // ゲートウェイの ID、または集め直しの段・limits-coordinator の ID
  kind: enum                 // 下の表
}
```

| `kind` | トピック | 中身 |
| --- | --- | --- |
| `MetricRecord` | `metrics` | 1.2 節 |
| `Tick` | `metrics`・`logs-raw`・`spans` | 1.3 節。組織を持たない |
| `LimitUpdate`・`TagSelectionUpdate` | `metrics` | 1.3 節 |
| `LogRawBatch` | `logs-raw` | 1.4 節 |
| `ProcessedLogBatch` | `logs` | 1.4 節 |
| `SpanBatch` | `spans` | 1.5 節 |
| `DerivedPartial` | `derived-partials` | 1.6 節 |
| `UsageReport` | `usage` | 1.7 節 |
| `AuditEvent` | `audit` | [security-audit-and-lifecycle.md](security-audit-and-lifecycle.md) の 3 節 |

### 1.2 `MetricRecord`

[intake-and-agent.md](../intake-and-agent.md) の 5.4 節。1 つの要求から、パーティションごとに 1 つ。

```
MetricRecord {
  header: Header
  host_keys: [string]            // 利用量のホストの数え方
  request_id: bytes(16)          // <Brand>-Request-Id（UUIDv7）。なければゲートウェイが作る
  series: [SeriesPoints {
    series_key: bytes(16)        // xxh3_128
    metric: string, tags: [string], type: enum, unit: string?
    points: [(ts_ms: i64, value: f64)] | hist: [(ts_ms: i64, ExpHistogram)]
    start_ts_ms: i64?            // 累積の始まり（OTLP）
  }]
  src: { topic, partition, offset_or_tick }?   // 集め直しの段が書くときだけ
}
```

- 集め直しの段（`derived-metrics-aggregator`）の点も同じ形で書く。同じ系列・同じ時刻の書き直しは、後のオフセットが勝つ。

### 1.3 制御のレコード

| レコード | 形 | 書き手 | 効き方 |
| --- | --- | --- | --- |
| `Tick` | `{writer_id: u32, t_in_ms: i64, draining: bool}`（頭は `format_version` と `kind` だけ） | 各ゲートウェイ（直前 1 秒に書いていないパーティションへ）、集め直しの段 | 水位 `F_p`（[query-and-cache.md](query-and-cache.md) の 5 節） |
| `LimitUpdate` | `{tenant_id, metric?: string, active_share: u64, rate_share: u32, epoch: u64}` | `limits-coordinator` | 組織のパーティションのすべてに書き、そのオフセットから使う。古い `epoch` は無視 |
| `TagSelectionUpdate` | `{tenant_id, metric, keep_keys: [string], effective_hour_ms: i64}` | `limits-coordinator`（`outbox` の `tag-selection-updated` から） | `effective_hour` の時間から効く |

- 制御のレコードは同じオフセットで 2 つの写しと読み直しに届くので、判断が同じになる（[ADR-0017](../../decisions/0017-cardinality-admission-via-control-records.md)）。

### 1.4 ログ

```
LogRawBatch {                     // logs-raw（マスクの前。保持 24 時間。処理の外へ出さない）
  header: Header, request_id: bytes(16), host_key: string?
  logs: [{ log_id: bytes(16),     // 取り込みの時刻の 48 ビット＋乱数 80 ビット
           raw_bytes: u32,        // 展開の後、本システムの JSON の形の大きさ（利用量）
           body: bytes, attributes: map, tags: [string], ts_hint_ns: i64? }]
}
ProcessedLogBatch {               // logs（マスクの後だけ）
  header: Header
  src_partition: u32, src_offset: i64          // logs-raw の出どころ（下流の重複の除去）
  pipeline_config_version: u64, scrub_rules_version: u32
  logs: [{ log_id, timestamp_ns: i64, timestamp_adjusted: bool,
           route: indexed(index_id) | excluded(index_id, rule_id) | over_quota(index_id) | unrouted,
           index_class: string?,  // idx-<N>d（利用量）
           message, service, status, host, source, trace_id?, span_id?,
           attributes: map, pipeline_errors: [(processor_id, code)], raw_bytes: u32 }]
}
```

### 1.5 `SpanBatch`

```
SpanBatch {
  header: Header, request_id: bytes(16), host_key: string?
  raw_bytes: u32                  // OTLP の Protobuf の形の大きさ（資源の属性はスパンの数で割って足す）
  spans: [{ trace_id: bytes(16), span_id: bytes(8), parent_span_id: bytes(8)?,
            name, kind, start_ns, end_ns, status_code,
            resource_attributes, attributes, events, links,
            tracestate_th: u64?, tracestate_rv: u64?, trace_flags: u8 }]
}
```

- パーティションは `trace_id` のハッシュで組織の組の中から選ぶ。セルの移し替えでは、スパンは取り込みの時刻で区切る。

### 1.6 `DerivedPartial`

[logs-pipeline.md](../logs-pipeline.md) の 10.2 節、[traces-and-sampling.md](../traces-and-sampling.md) の 7.3 節。

```
DerivedPartial {
  header: Header
  series_key: bytes(16), metric: string, tags: [string]
  bucket_start_ms: i64            // 10 秒の桶
  value: count(f64) | hist(ExpHistogram)
  src: { topic: logs-raw | spans, partition: u32, tick_ms: i64 }   // 出どころの鍵
  writer_watermark_ms: i64        // 書き手が処理し終えた元のパーティションの水位
}
```

- 集め直しの段は、出どころごとに折り込み済みの刻みを持ち（S3 のチェックポイントと Kafka のトランザクションで確定）、それ以前を飛ばす。

### 1.7 `UsageReport`

```
UsageReport {
  header: Header
  report: HostReport { host_key, os, agent_version }                  // エージェントの 60 秒ごとの報告
        | GatewayCounts { window_start_ms, signal, bytes, events,
                          rejected: map<reason, u64>, rejected_429: u64,
                          key_last_used: [(key_id, hour)] }           // ゲートウェイの 10 秒ごと
}
```

## 2. S3

[ADR-0009](../../decisions/0009-retention-tiers-on-s3.md)、[ADR-0061](../../decisions/0061-dr-stage-up-and-cell-expansion.md)、[infrastructure.md](../infrastructure.md) の 5・6 節。

### 2.1 バケット・区分・タグ

| バケット | 中身 | 鍵 |
| --- | --- | --- |
| `<brand>-telemetry-apne1` | ブロック、チェックポイント、ログの索引・再水和・監査のセグメント、トレース、評価の記録、設定の束、運用の記録 | `kms-telemetry` |
| `<brand>-archive-apne1` | ログのアーカイブ | `kms-archive` |
| `<brand>-audit-archive`（log-archive のアカウント） | 監査の連鎖と写し（Object Lock） | `kms-audit` |
| 大阪の写し（`-apne3`） | 上の 2 つの写し | 大阪の鍵 |

- **組織のデータは `<cell>/<tenant_id>/` の下にだけ置く**（D-39）。キーの形は `<cell>/<tenant_id>/<signal>/<class>/<yyyy>/<mm>/<dd>/<hh>/<file>`。組織を持たない運用のオブジェクトだけを `<cell>/<role>/…` に置く。
- 置くときにオブジェクトのタグ `class=<区分>` と `tier=l0|l1` を付ける。タグのない PUT はバケットの方針で拒む。ライフサイクル（保持＋1 日）と複製（大阪）の規則はタグで絞る。

| `class` | 保持 | `tier` | 大阪の写し |
| --- | --- | --- | --- |
| `h-3d` | 3 日（後ろの守り。合わせで消す） | `l0` | Standard に 2 日 |
| `raw-15d` | 15 日 | `l1`（トレースの 10 秒ごとのものは `l0`） | Glacier Instant Retrieval（`l0` は Standard に 2 日） |
| `r1m-63d` | 63 日 | `l1` | Glacier Instant Retrieval |
| `r1h-15mo` | 15 か月（63 日の後に月のファイルでコールド） | `l1` | Glacier Instant Retrieval |
| `idx-3d`・`idx-7d`・`idx-15d`・`idx-30d` | 索引の保持 | 合わせの前 `l0`、後 `l1` | `l0` は Standard に 2 日、`l1` は Glacier Instant Retrieval |
| `rehyd-<N>d` | 再水和の保持 | `l1` | Glacier Instant Retrieval |
| `audit-<N>d` | 監査の索引の保持（**L6 の確認待ち**） | `l0`・`l1` | 同上 |
| `archive-1y` | 1 年 | `l1` | Glacier Instant Retrieval |
| `eval-30d` | 30 日 | `l1` | Glacier Instant Retrieval |
| `ckpt-24h` | 24 時間 | — | Standard に 24 時間 |
| `config` | 消さない（組織の削除で消す） | `l1` | Standard |

- `config` は設定の束のコンパイルの結果のために、この工程で足した区分（D-40。[ADR-0009](../../decisions/0009-retention-tiers-on-s3.md) の区分の一覧への追加として README の 6 節に記録）。
- 削除マーカーは写らないので、保持の削除・合わせの後の削除・削除の請求・解約の消去は、東京と大阪の両方を明示に消す。

### 2.2 キー

| 中身 | キー | `class` | 書く |
| --- | --- | --- | --- |
| 時間のブロック | `<cell>/<tenant_id>/metrics/h-3d/<yyyy>/<mm>/<dd>/<hh>/p<partition>.blk` | `h-3d` | インジェスター（`If-None-Match`） |
| 食い違いの調べ | `<cell>/<tenant_id>/metrics/h-3d/<yyyy>/<mm>/<dd>/<hh>/quarantine/p<partition>-<replica>.blk` | `h-3d` | インジェスター（D-39） |
| 日の生・1 分・1 時間 | `<cell>/<tenant_id>/metrics/<raw-15d｜r1m-63d｜r1h-15mo>/<yyyy>/<mm>/<dd>/00/r<range>-<hash8>.blk` | 各区分 | `compactor` |
| 月の 1 時間 | `<cell>/<tenant_id>/metrics/r1h-15mo/<yyyy>/<mm>/01/00/m-r<range>-<hash8>.blk` | `r1h-15mo` | `compactor` |
| ヘッドのチェックポイント | `<cell>/<tenant_id>/checkpoints/ckpt-24h/<yyyy>/<mm>/<dd>/<hh>/p<partition>-<seq>.ckpt` | `ckpt-24h` | インジェスター（貸し出しの持ち主） |
| ログのセグメント | `<cell>/<tenant_id>/logs/<class>/<yyyy>/<mm>/<dd>/<hh>/<segment_id 32 桁の 16 進>.lseg` | `idx-<N>d`・`rehyd-<N>d`・`audit-<N>d` | インデクサー、`compactor`、`rehydrator` |
| 墓標 | 上のキー ＋ `.tomb-<gen>` | セグメントと同じ | `deletion-worker` |
| アーカイブ | `<cell>/<tenant_id>/logs/archive-1y/<yyyy>/<mm>/<dd>/<hh>/<file_id>.lseg`（`<brand>-archive-apne1`） | `archive-1y` | アーカイブの書き手 |
| トレースのセグメント | `<cell>/<tenant_id>/traces/raw-15d/<yyyy>/<mm>/<dd>/<hh>/<segment_id>.lseg` | `raw-15d` | `trace-assembler`、`compactor` |
| `tidx`・時のブルームフィルター | `<cell>/<tenant_id>/traces/raw-15d/<yyyy>/<mm>/<dd>/<hh>/tidx-<gen>.bin`・`hbloom-<gen>.bin` | `raw-15d` | `compactor` |
| 評価の入力の写し | `<cell>/<tenant_id>/evals/eval-30d/<yyyy>/<mm>/<dd>/<hh>/<shard>-<minute>.rec` | `eval-30d` | `monitor-evaluator` |
| 評価のスナップショット | `<cell>/<tenant_id>/evals/snapshots/<shard>/<seq>.snap` | `eval-30d` | `monitor-evaluator`（D-39） |
| 集め直しの段のチェックポイント | `<cell>/<tenant_id>/derived-metrics/checkpoints/p<partition>-<seq>.ckpt` | `ckpt-24h` | `derived-metrics-aggregator`（D-39） |
| 設定の束 | `<cell>/<tenant_id>/config/pipelines/v<N>.bin` | `config` | `api` |
| `log-processor` のバッチの記録 | `<cell>/log-processor/batches/p<partition>/<start_offset>.bin` | `ckpt-24h` | `log-processor`（組織の ID とバージョンの番号だけ。D-25） |
| 監査の連鎖 | `<tenant_id>/<yyyy>/<mm>/<dd>/chain.json`・`system/<yyyy>/<mm>/<dd>/chain.json`（`<brand>-audit-archive`） | Object Lock | `audit-archiver` |

## 3. Valkey（ElastiCache）

セルごと（キーの確認と権限はリージョンの管理の面と同じ）。すべて失ってよい。正は Aurora か MSK。鍵の先頭（接頭辞の後）に組織を置く。

| 鍵 | 型 | 中身 | 期限 | 正本 |
| --- | --- | --- | --- | --- |
| `ik:{key_hash}` | ハッシュ | `tenant_id`、`key_id`、`fetched_at` | 60 秒 | [keys-and-intake.md](keys-and-intake.md) |
| チャネル `ik-revoked` | pub/sub | 失効したキーのハッシュ | — | 同上 |
| `quota:{cell}:{tenant_id}:{window}` | ハッシュ | ゲートウェイごとの需要 | 60 秒 | [ADR-0012](../../decisions/0012-intake-quota-coordination.md) |
| `gw:{cell}:{gateway_id}` | 文字列 | 生きているゲートウェイ | 30 秒 | 同上 |
| `idxq:{tenant_id}:{index_id}:{day}` | 数 | 索引の 1 日の件数（前借り 1,000） | 2 日 | [logs-pipeline-and-indexes.md](logs-pipeline-and-indexes.md) の 4 節（D-23） |
| `card:{cell}:{tenant_id}:{partition}` | ハッシュ | 1 分ごとの有効な系列と溢れの数 | 5 分 | [metrics-catalog-and-cardinality.md](metrics-catalog-and-cardinality.md) |
| `wm:{tenant_id}:{signal}` | 文字列 | 水位 `F` | 60 秒 | [query-and-cache.md](query-and-cache.md) の 5 節 |
| `evaluated_through:{tenant_id}:{monitor_id}` | 文字列 | 評価の済んだ時刻 | 1 時間 | [monitors-and-notifications.md](monitors-and-notifications.md) の 4.2 節 |
| `authz:{tenant_id}:{principal}` | ハッシュ | 権限の集合と述語、`authz_version` | 10 分 | [query-and-cache.md](query-and-cache.md) の 4 節 |
| `qc:…`・`qgen:{tenant_id}`・`dash:…`・`open:…` | 文字列 | クエリの結果、世代、ダッシュボード | 4 節 | 同上 |

## 4. SNS・SQS

[notifications-and-integrations.md](../notifications-and-integrations.md) の 4 節。`relay` が `notification_requests` と `outbox` から出す。

| 置き場所 | 中身 | 読み手 |
| --- | --- | --- |
| SNS `notify` | 通知の依頼（属性 `channel_kinds`、`tenant_id`） | 下の SQS へフィルター |
| SQS `notify-email`・`notify-chat`・`notify-webhook`・`notify-oncall` | `(tenant_id, request_id, request_created_at)` | `notifier`（組織ごとの待ち行列、同時 20） |
| SNS `events` | `outbox` の他の `topic`（[security-audit-and-lifecycle.md](security-audit-and-lifecycle.md) の 2.1 節） | 各部品の SQS |

- メッセージは ID だけを持つ（本文は Aurora から読む）。再試行の待ちは SQS の遅延（15 分まで。それより長い待ちは 2 回に分ける）。

## 5. AppConfig

[runbooks/](../../runbooks/README.md) の 2 節、[delivery.md](../delivery.md) の 3.2 節。東京と大阪で同じ構成。

| 名前 | 中身 |
| --- | --- |
| `release.*` | kebab-case。未完成の振る舞い（`release.log-rehydration`、`release.notification-samples` など）。保存の形式・圧縮・ロールアップ・評価の規則には使わない |
| `ops.intake_enabled` | セルごとの取り込みの停止 |
| `ops.compaction_enabled`、`ops.retention_delete_enabled` | 合わせと保持の削除の停止 |
| `ops.notifications_enabled` | チャネルごとの送信の停止（`held`） |
| `ops.query_concurrency_per_tenant` | 組織ごとの並行の上限の上書き |
| `ops.rollout_paused`、`ops.oversubscription_ratio`、`ops.agent_min_version` | 入れ替えの停止、売りすぎの比、エージェントの下限 |
| `pii_defaults` | 既定で有効にするマスクの種類（**L1 の確認待ち**） |

## 6. 自己監視の経路（selfmon のアカウント）

[ADR-0062](../../decisions/0062-independent-self-monitoring-path.md)、[observability.md](../observability.md)。本番の Aurora・MSK・S3 に置かない。利用者のデータを持たない（ID と数と理由のコードだけ）。

| 置き場所 | 中身 |
| --- | --- |
| AMP（大阪） | `svc_*` の指標。`svc_tenant_freshness_seconds{tenant_id, signal}`、`svc_formats_readable{format, version}`、`svc_ingester_head_digest_mismatch_total`、`svc_up` |
| CloudWatch（大阪） | `CanaryHeartbeat`（セル・信号）、本システムのログ（30 日） |
| `canary` | 見張りの組織 `canary-<cell>`（`tenants.is_canary`）。時刻から計算できる値（`canary.sine`・`canary.counter`・`canary.dist`・`canary.flip`）を公開の入口から送る |

## 7. インスタンスの NVMe（失ってよい）

| 部品 | 中身 | 鍵 |
| --- | --- | --- |
| `query-reader` | ブロックの区画（統計・系列の表・チャンク） | `(tenant_id, block_id, 区画の種類)` |
| `log-searcher` | フッター、ブルームフィルター、直近 24 時間のページ、墓標 | `(tenant_id, segment_id, ページの番号)`。`catalog.segment-changed` で捨てる。最長 24 時間 |
| `metrics-ingester` | チェックポイントの一時の置き場 | `(tenant_id, partition, seq)` |

- ハードウェアの暗号化（XTS-AES-256）。追加の暗号化はしない（[security.md](../security.md) の 4.2 節）。

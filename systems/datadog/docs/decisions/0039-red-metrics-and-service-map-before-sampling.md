---
status: accepted
date: 2026-10-09
---

# ADR-0039: RED メトリクスはスパンの到着ごとに、サービスマップの辺はトレースの完成ごとに、サンプリングの前のすべてのスパンから作る。部分の値を `derived-partials` へ書き、出どころの鍵（パーティション、時計の刻み）で読み直しの二重を除く。リソースの名前は正規化し、生の URL と SQL の文を使わない

## Context

- RED メトリクス（要求の数・エラー・所要時間）とサービスマップは、サンプリングで残したトレースから作ると、規則（エラー、遅いもの）に偏る。本家も APM のメトリクスをサンプリングの前のすべてのトレースから計算する（[Ingestion Controls](https://docs.datadoghq.com/tracing/trace_pipeline/ingestion_controls/)、2026-10-09 に確認）。
- スパンは `trace_id` でばらすので、同じ（サービス、リソース）が多くのパーティションに分かれる。TSDB は同じ系列・同じ時刻の点を「後に取り込んだもの」で決める（[ADR-0004](0004-tsdb-storage-engine.md)）。集め直しの段 `derived-partials` を [ADR-0032](0032-index-routing-and-derived-metrics.md) で決めた。
- `trace-assembler` は S3 にもセグメントを書くので、Kafka のトランザクションだけでは出力の 1 回だけを保てない（[ADR-0040](0040-trace-storage-and-id-lookup.md)）。
- リソースの名前に生の URL を使うと、ID を含む道で系列が爆発する（[ADR-0006](0006-cardinality-policy.md)）。SQL の文には値（個人のデータ）が入る。

## Options

1. **組み立ての段で全スパンから部分の値を作り、`derived-partials` で集め直す。出どころの鍵で二重を除く**
2. 残したトレースから作り、重みで推定する
3. `intake-gateway` で数える

## Decision

1 を採用する。詳細は [traces-and-sampling.md](../architecture/traces-and-sampling.md) の 4.2・7 節。

- RED：サービスの入口のスパン（SERVER・CONSUMER・親なし。完成の後に分かるものは完成の時）が届いた時に、`<brand>.apm.requests`・`.errors`（重みの和）、`.duration`（指数のヒストグラム）を数える。タグは `env`、`service`、`resource`、`operation`、`span.kind`、`http.status_class`、`version`。
- 辺：完成の時に、すべてのトレースから `<brand>.apm.edge.*`（`client_service`、`server_service`、`env`）を数える。子のない CLIENT のスパンは `peer.service`・`server.address` から `external:<名前>`。
- 部分の値は 10 秒の桶で、時計の 1 秒の刻みごとに `derived-partials` へ書く。メッセージは出どころの鍵（`spans` のパーティション、刻み）を持ち、集め直しの段は折り込み済みの刻みを飛ばす。
- リソース：`http.route`、RPC の名前、宛先の名前、DB の操作と集まりの名前、正規化した名前の順。サービスあたり 1,000 種類まで、超えたら `resource:other`。
- タグの値はマスクの後の値。

### 他の案を選ばなかった理由

- **2（残したものから推定）**：規則で偏り、重みで直せない（エラーはすべて残るので、エラーの率が過大になる）。
- **3（ゲートウェイで数える）**：サービスの入口の判断と辺に、親子の関係が要る。ゲートウェイは状態を持たない（[ADR-0002](0002-intake-log-on-msk.md)）。

## Consequences

- 良くなること：
  - RED とサービスマップが偏らない。
  - 読み直しで二重に数えない。
  - リソースの爆発と、SQL の文の値の漏れを防ぐ。
- 引き受けるコスト：
  - 辺は完成（30 秒の静止）の後なので、RED より約 40 秒遅い。
  - 集め直しの段の状態（系列ごとの桶）が、RED の系列の分だけ増える。

## Confirmation

- 性質ベーステスト：PROP-TRC-002（読み直しで同じ）、PROP-TRC-003（RED の正しさ、重みの統計の許容）。
- 漏れの経路：制限の外のサービスの辺・名前がサービスマップに出ない（[quality.md](../quality.md) の 2.2.1 節 G）。
- 単体：リソースの正規化の固定のベクトル（ID・UUID・メールアドレスを含む道）。

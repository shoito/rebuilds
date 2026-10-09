---
status: accepted
date: 2026-10-09
---

# ADR-0014: OTLP は標準の応答（HTTP 200 と `partial_success`、429・503 と `Retry-After`、gRPC の `RESOURCE_EXHAUSTED`・`UNAVAILABLE` と `RetryInfo`）に寄せる。資源の属性は、決めた一覧（`service.name` → `service` など 12 個）と組織が足した鍵だけをタグにし、他は落として数える。データポイントの属性はすべてタグにし、同じ鍵では資源の属性より勝つ。指標の名前の `-`・`/` は `_` に直し、時刻はミリ秒に切り捨てる

## Context

本システムは自前の言語ごとの SDK を持たず、OpenTelemetry の SDK と Collector から OTLP で受ける（[architecture/README.md](../architecture/README.md) の 6 節）。

- OTLP の仕様は、一部の成功（`partial_success`）、送り直してよい状態の値、`Retry-After`・`RetryInfo` を決めている（[OTLP Specification](https://opentelemetry.io/docs/specs/otlp/)、2026-10-09 に確認）。合わせないと、Collector が送り直すべきでないものを送り直し、送り直すべきものを捨てる。
- 本システムの API の成功は 202 で、OTLP の仕様の成功は 200 である。
- OTLP の資源の属性には、値の種類の多いもの（`container.id`、`process.pid`、`service.instance.id`）が多い。全部をタグにすると、1 つのプロセスの再起動ごとに新しい系列ができ、カーディナリティの上限（[ADR-0006](0006-cardinality-policy.md)）にすぐ当たる。
- OpenTelemetry の指標の名前は `-` と `/` を含みうる。本システムのクエリの言語では、`/` が式の割り算、`-` が否定と紛れる（[ADR-0007](0007-query-language.md)）。
- OTLP の時刻はナノ秒、本システムの TSDB はミリ秒の時刻を持つ（[tsdb-storage-engine.md](../architecture/tsdb-storage-engine.md)）。
- 本家の資源の属性の対応は、公式の資料で確かめられなかった（**未検証**）。

## Options

応答：

1. **OTLP の受け口は仕様の応答に寄せ、本システムの API は 202 のまま**
2. OTLP の受け口も 202 にそろえる

資源の属性：

- a. **決めた一覧と、組織が足した鍵だけをタグにする**
- b. すべてをタグにする
- c. どれもタグにしない（`service` なども付かない）

## Decision

1 と a を採用する。対応の表は [otlp-and-api-keys.md](../architecture/otlp-and-api-keys.md) の 4〜6 節。

- 応答：すべて受けたら HTTP 200・gRPC `OK`。点の一部を拒んだら `partial_success` に数と理由の数を入れて 200。割り当ての超過は 429・`RESOURCE_EXHAUSTED`＋`RetryInfo`、確定の失敗は 503・`UNAVAILABLE`＋`RetryInfo`。大きすぎる本文は 413・`RESOURCE_EXHAUSTED`（`RetryInfo` なし）。どれも MSK の確定の後だけ成功を返す。
- 資源の属性からタグにするのは、`service.name`・`service.version`・`deployment.environment.name`（古い `deployment.environment`）・`host.name`・`cloud.provider`・`cloud.region`・`cloud.availability_zone`・`k8s.cluster.name`・`k8s.namespace.name`・`k8s.deployment.name`・`k8s.pod.name`・`container.name` の 12 個と、組織が足した鍵（最大 20）。他は落として数える。
- データポイントの属性はすべてタグにする。配列・マップ・バイト列は落として数える。同じ鍵では、データポイントの属性が勝つ。
- ログとスパンには資源の属性をすべて属性として残す（タグの爆発は系列の話のため）。
- 指標の名前は `-`・`/` を `_` に直し、元の名前を指標の情報の `otel_name` に残す。
- 時刻はミリ秒に切り捨てる。同じミリ秒の点は後勝ち。

### 他の案を選ばなかった理由

- **2（202 にそろえる）**：仕様の外の応答で、Collector と SDK の送り直しの判断が仕様どおりにならない。
- **b（すべて）**：プロセス・コンテナの再起動ごとに系列が増え、上限と課金の驚きにすぐつながる。
- **c（なし）**：`service`・`env`・`host` で絞れず、ホストの数え方（usage-and-billing.md）とサービスの結び付けができない。

## Consequences

- 良くなること：
  - OpenTelemetry の送り手が、設定の変更だけで正しく送り直す。
  - 資源の属性による系列の爆発を、既定で防ぐ。
  - クエリの言語の文法と名前が紛れない。
- 引き受けるコスト：
  - 一覧にない資源の属性で絞りたい利用者は、組織の設定で鍵を足す必要がある。
  - `a-b` と `a_b` のような名前は同じ指標になる。
  - ナノ秒の違いしかない点は後勝ちで 1 つになる。

## Confirmation

- 表駆動テスト：DT-OTLP-001（応答）、DT-OTLP-002（型）。
- 性質ベーステスト：PROP-OTLP-001（属性の対応の決定性）、PROP-OTLP-002（送り直しの合図）。
- 結合テスト：OpenTelemetry Collector と言語の SDK から送り、障害を注入しても、読める点の数が送った数と一致する。

---
status: accepted
date: 2026-10-09
---

# ADR-0038: テールサンプリングの規則は、エラー → 組織の規則 → 遅いもの → まれなもの → 予算の中の確率、の順に当て、最初に残すと決めた規則を記録する。確率の採択は `trace_id` から作った 56 ビットの値としきい値の比べで行い、ヘッドサンプリング（OpenTelemetry の `ot=th`）と一貫させる。重みはヘッドの採択の確率の逆数

## Context

- 規則の既定は、エラーをすべて、サービス・リソースごとに遅い上位 1%、まれな組を 1 秒 5 件、残りはテナントの予算の中の確率、と決めている（[architecture/README.md](../architecture/README.md) の 6 節）。
- 1 つのトレースが断片に分かれる（遅れたスパン、打ち切り）。断片ごとに違う確率の結果になると、残すトレースが欠ける。
- 利用者は SDK でヘッドサンプリングをする。OpenTelemetry は `tracestate` の `ot=th` で棄却のしきい値を運び、重み（adjusted count）を求める仕組みを定めている（[TraceState: Probability Sampling](https://opentelemetry.io/docs/specs/otel/trace/tracestate-probability-sampling/)、2026-10-09 に確認。状態は Development）。
- 本家は保持のフィルターと多様性のサンプリングで残すものを決める（[Trace Retention](https://docs.datadoghq.com/tracing/trace_pipeline/trace_retention/)、2026-10-09 に確認）。サーバーのテールサンプリングは確かめなかった（**未検証**）。

## Options

確率の採択：

1. **`trace_id` から作る 56 ビットの値 `R` と、しきい値 `T` の比べ（OpenTelemetry と同じ形）**
2. 乱数
3. `xxh3(trace_id)` の 64 ビットと率の比べ（独自の形）

規則の当て方：

- a. **決まった順に当て、最初に残す規則を記録する**
- b. すべての規則の点数を合わせる

## Decision

1 と a を採用する。詳細は [traces-and-sampling.md](../architecture/traces-and-sampling.md) の 8 節。

- 順：`error` → `tenant_rule`（50 まで、条件と率）→ `latency`（入口のスパンの `duration` が（サービス、リソース）の直近 60 分の p99 以上、標本 100 以上）→ `rare`（組が直近 15 分に残されていない、組織で 1 秒 5 件）→ `probabilistic`。
- `R`：W3C の random のビットか `ot=rv` があれば標準の値、なければ `xxh3_64(trace_id) >> 8`。`R ≥ T` で採る。
- 予算：組織の保持の予算（取り込みのバイトの 10%）から、60 秒ごとに `p` を求め、移動平均で `T_budget` を更新する。`p` の最小は 0.1%。
- 重み：ヘッドの `ot=th` から `w = 2^56 / (2^56 − T)`。ないときは 1 と `weight_unknown`。`probabilistic` で残したものの保存の重みは `w / p`。
- 即時の決定（[ADR-0037](0037-trace-assembly-and-completion.md)）では `error` と `probabilistic` だけを当てる。

### 他の案を選ばなかった理由

- **2（乱数）**：断片ごと・読み直しごとに結果が変わる。
- **3（独自の形）**：ヘッドサンプリングとの一貫（テールで残すものがヘッドで採ったものの部分集合になり、重みが掛け算になる）が保てない。
- **b（点数）**：なぜ残ったかを利用者に説明しにくい。

## Consequences

- 良くなること：
  - 断片・読み直し・パーティションに依らず、確率の結果が同じ。
  - ヘッドとテールの重みが標準の形で合わさる。
  - `sampling.rule` で、なぜ残ったかが分かる。
- 引き受けるコスト：
  - OpenTelemetry の仕様が Development で、変わりうる。
  - 障害の日はエラーの規則だけで予算を超える（超えた分を利用量に数える）。
  - 遅いもの・まれなものの判断はパーティションの中の統計で、全体の厳密な p99 ではない。

## Confirmation

- 性質ベーステスト：PROP-TRC-004（エラーを残す）、PROP-TRC-005（一貫した確率、ヘッドで落ちたものは残らない、採る割合が許容に入る）。
- 表駆動：規則の順と、各規則の当たり・外れの決定表（[quality.md](../quality.md) の 2.2.1 節 I）。

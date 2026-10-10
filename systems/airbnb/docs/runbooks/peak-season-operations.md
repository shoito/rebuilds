# Runbook: 繁忙期と大きな催しの運用

- Owner: Ops（当番）、安全の責任者、財務
- 対応するアラート: 熱い日付の検知（先着の印の取り合いが 1 秒 20 超、1 都市の同じ日付への見積もりが 1 分 1,000 超）、負けの応答の p99 1 秒超、予定した繁忙期（定期作業）
- 最終確認日: 2026-10-10

段取りの枠は [README.md](README.md) の 5 節、容量の作業は [capacity.md](../architecture/capacity.md) の 5 節（[ADR-0081](../decisions/0081-sizing-tiers-and-holiday-prescaling.md)）、熱い日付の受け入れは [booking-and-holds.md](../architecture/booking-and-holds.md) の 8 節（[ADR-0036](../decisions/0036-hot-date-admission-and-hold-limits.md)）。

## 症状

- 予定した繁忙期（年末年始、ゴールデンウィーク、お盆、桜と紅葉）と、海外の繁忙期（旧正月、国慶節、夏の休み）が近い。
- 催しの日程の発表の直後に、同じ都市の同じ日付へ予約と見積もりが集まった（熱い日付）。

## 影響

- 予約の p99、負けの応答の p99、検索の p95 が伸びる。DB の接続とリスティング・届出住宅の行のロックの待ちが伸びる。
- 二重の予約と上限の超過は、排他の制約と CHECK 制約が止める。崩れるのは速さと可用性である。
- チェックインの山の翌営業日に、release と送金の束の山が来る。

## 確認

1. 繁忙期と熱い日付のダッシュボード（[observability.md](../architecture/observability.md) の 5 節）：予約の結果の率、予約と負けの応答の p99、熱いリスティングの枠ごとの取り合い、DB の接続の使用率（70% の線）、行のロックの待ち。
2. 正しさ：`stay_claims`・180 日・予約と台帳の照合の不一致と最後の成功からの時間（繁忙期は 1 分ごと）。
3. 検索：p95、混入の率、Valkey の迂回の率、`ops.search_stage1_limit` の今の値。
4. 外部：iCal の予定どおりの率、PMS のアプリごとの 429。

## 対処

**準備（予定した繁忙期）**

1. 30 日前まで：PM から期間と想定の量を受け取り、[capacity.md](../architecture/capacity.md) の 1 節の最大と比べる。超えるなら段を上げる計画を作る。
2. 7 日前：core の読み出しの写しを 1 つ、OpenSearch のデータのノードを 3 つ、Valkey のシャードを 2 つ足す。決済の提供者に量を知らせる。縮めた規模の負荷試験（[quality.md](../quality.md) の 2.2.1 節 J）。安全の窓口と CS の増員を決める。
3. 前日：凍結（[README.md](README.md) の 3.1 節）。当番の Ops・IC・財務・安全を決める。照合を 1 分ごとにする。

**最中**

1. 熱い日付は拡大を待たない。先着の印と写しで負けの応答を返す。Valkey が止まったら、リスティングごと・タスクごとの同時実行 4 で DB を守る（`booking` のタスクの最大は 12 のまま。増やさない）。
2. 検索の p95 が 600ms を超えたら、`ops.search_stage1_limit` を 300 から下げる（150 まで）。
3. iCal の取り込みが遅れたら、`ops.ical_poll_minutes` を伸ばす（最大 60。PMS の API は止めない）。
4. 仮押さえの連打（同じ端末・カード・ゲスト）は、WAF の規則と T&S の規則で絞る。上限の値（[booking-and-holds.md](../architecture/booking-and-holds.md) の 8.3 節）は `ops.*` で T&S が変える。
5. 照合の不一致が 1 件でも出たら、そのリスティング・届出住宅の予約を止め、[double-booking-or-cap-violation.md](double-booking-or-cap-violation.md) に移る。

**終わりと後**

1. 照合を 5 分ごとに戻す。チェックインの山の翌営業日の `ledger`・`payouts`・`deadline-runner` の最小の数が上がっていることを確かめる。
2. 終わり + 7 日：足したノード・写し・シャードを戻す。
3. 3 営業日の後：3 者の照合。振り返り（予約の最大、熱い日付の数、SLI の消費、混入の率、外部の食い違いの数、安全の事故の数）。

## エスカレーション

- DB の接続の使用率が 85% を 5 分超える：IC を立て、地域・都市ごとの `ops.booking_enabled` で絞るかを判断する。
- 届出住宅のロックの待ちで負けの応答の p99 が 1 秒を超える：テックリード（`hot-dates-booking-poc` の値の見直し）。

## 事後

- `peak_season_plans` と `hot_date_events` に結果を残し、次の繁忙期の既定の値へ反映する。

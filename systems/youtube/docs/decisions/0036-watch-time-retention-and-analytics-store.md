---
status: accepted
date: 2026-10-10
---

# ADR-0036: 総再生時間は再生した区間の和集合の長さ、維持率は最大 200 の桶の覆いで数える。分析は、動画×日の合計とチャンネル×日の切り口を Aurora に置き、動画の切り口の細部と任意の期間は Iceberg を DataFusion で引く

## Context

- [ADR-0007](0007-two-phase-view-counting.md) は、総再生時間を心拍の区間の和（重なりは 1 回、速さで割り戻さない）、維持率を動画の時刻ごとの再生の割合と決めた。桶の大きさと期間のまとめ方は決めていない。
- 創作者の分析は、仮の数で 2 時間、確定で 48 時間以内に出す（NFR-006）。切り口（流入の元、端末、都道府県など）を掛け合わせると行が多くなる。
- 管理の面は Aurora を正本にする（[ADR-0001](0001-platform-and-stack.md)）。出来事は S3 の Iceberg にある。

## Options

置き場：

1. **合計と 1 つの切り口ずつの集計を Aurora、細部と任意の期間は Iceberg を DataFusion で引く**
2. 全部を Aurora に置く（切り口の掛け合わせの行）
3. 分析の専用の列指向の DB を足す

## Decision

1 を採用する。詳細は [view-counting-and-analytics.md](../architecture/view-counting-and-analytics.md) の 6・7 節。

- 総再生時間：セッションごとの再生した区間の和集合の長さ。心拍の欠けは埋めない。
- 維持率：動画を `min(200, ceil(長さ / 1 秒))` の桶に分け、和集合が桶の 50% 以上を覆う有効な視聴の数を数える。期間は覆いと視聴の数を足してから割る。
- Aurora：`video_stats_daily`（動画 × 日）、`channel_stats_daily_dim`（チャンネル × 日 × 1 つの切り口）、`video_stats_hourly`（直近 72 時間）。
- 細部と任意の期間：`analytics-query` が `watch_sessions` を DataFusion で引き、1 時間キャッシュする（p95 3 秒）。
- 1 つの切り口の値の視聴が 50 未満の行は「その他」にまとめる。

### 他の案を選ばなかった理由

- **2（全部を Aurora）**：切り口の掛け合わせで 1 日に数千万行になり、書き込みと保持の費用が重い。
- **3（専用の DB）**：S1 の量では運用の部品が増えるだけ。E7 の負荷試験で Aurora が足りなければ、S2 で ADR を書き直す。

## Consequences

- 良くなること：
  - よく見る画面（日ごとの合計、1 つの切り口）は Aurora の RLS の中で速く返る。
  - 細部は出来事の正本から作るので、規則の作り直しにそのまま追従する。
- 引き受けるコスト：
  - 任意の期間の問い合わせは数秒かかる。
  - 2 つの置き場の値が一致することを確かめ続ける。

## Confirmation

- PROP-VIEW-004・006。DT-VIEW-001。
- 夜間の突き合わせ：`video_stats_daily` の合計と、`watch_sessions` から作った合計が一致する。

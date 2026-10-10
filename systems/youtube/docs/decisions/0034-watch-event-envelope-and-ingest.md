---
status: accepted
date: 2026-10-10
---

# ADR-0034: 視聴の出来事は `(sid, seq)` を重複の鍵にした封筒で送り、`event-collector` が署名を確かめて IP アドレスを粗くしてから MSK に書く。分割の鍵は `video_id` で、熱い動画だけ視聴者の桶を足す

## Context

- [ADR-0007](0007-two-phase-view-counting.md) は、出来事を再生のトークンつきで送り、MSK の `watch-events`（`video_id` で分割）に書くと決めた。[ADR-0023](0023-playback-token-and-qoe-metrics.md) は QoE の出来事も同じ流れに載せると決めた。
- 端末は送れなかった出来事を貯めて送り直す。同じ出来事が 2 回以上届き、順序も入れ替わる。重複を落とす鍵が要る。
- 急な人気の動画は、1 つの分割に出来事が集まる。S1 の 10 万の同時の視聴で約 1 万件/秒、S2 ではその数倍になる。
- 生の IP アドレスは不正の判定（データセンター、同じ回線の集団）に要るが、長く持つと個人の情報の扱いが重くなる（**法務の確認待ち：L5**）。

## Options

1. **封筒に `(sid, seq)` を持たせ、受け口は確かめと粗くしだけを行う。分割は `video_id`、熱い動画は `video_id#bucket`**
2. 受け口で重複を落とし、数も数える
3. 分割を `viewer_key` にする

## Decision

1 を採用する。詳細は [view-counting-and-analytics.md](../architecture/view-counting-and-analytics.md) の 4 節。

- 封筒の欄：`sid`、`seq`、`type`、`t_client`、`pos_ms`、`iv`（再生した区間、最大 8）、`rate`、`vis`・`muted`、`src`（`play_intent` だけ）、`ad`（広告だけ）。束は最大 50 件・64 KB。
- `event-collector` は、トークンの署名と期限と `video_id` の一致を確かめ、IP アドレスを /24・/48 に粗くし、ASN と都道府県を足して書く。失敗したものは理由のコードだけを `watch-events-rejected` に書く。
- 生の IP アドレスは、1 時間ごとに捨てる鍵で暗号化した値として、流れの判定の間だけ持つ。Parquet には粗くした値だけを書く。
- 分割の鍵は `video_id`。仮の数が 1 分に 5 万を超えた動画（S2 から）は `video_id#bucket`（`bucket = hash(viewer_key) mod 16`）にする。同じ視聴者は同じ桶に入る。

### 他の案を選ばなかった理由

- **2（受け口で数える）**：受け口が状態を持ち、横に増やしにくくなる。数える規則が `view-rules` の外に出て、ADR-0007 の「規則は 1 つのクレート」に反する。
- **3（`viewer_key` で分割）**：動画ごとの仮の数を積むために、分割をまたいだ集計が要る。ADR-0007 の分割と違う。

## Consequences

- 良くなること：
  - 受け口は状態を持たず、横に増やせる。
  - 重複と順序の入れ替えを `view-rules` の 1 か所で扱える。
- 引き受けるコスト：
  - 熱い動画の切り替えの間、同じ視聴者の出来事が 2 つの鍵に分かれうる。S04・S05 の状態は Valkey の `vd:` に置き、分割に依らないようにする。
  - 暗号化した生の IP アドレスの鍵の回しを運用する。

## Confirmation

- PROP-VIEW-002：任意の順・重複・遅れで、1 日の確定の数が同じ。
- 結合テスト：期限切れ・改ざん・別の `video_id` のトークンの出来事が `watch-events` に入らない。
- Parquet の列の検査：生の IP アドレスの列がない。

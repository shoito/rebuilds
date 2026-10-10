---
status: accepted
date: 2026-10-10
---

# ADR-0023: 再生の API は Ed25519 の再生のトークン（10 時間）と HMAC のエッジのトークン（6 時間）を返す。QoE は `play_intent` から `first_frame` までを開始の時間とし、再バッファの割合は開始とシークの待ちを除いて数え、出来事は `watch-events` に載せる

## Context

- [ADR-0007](0007-two-phase-view-counting.md) は、再生の API が出した再生のトークン（`video_id`、視聴者、端末の識別子のハッシュ、時刻、署名、10 時間）を出来事に付けると決めた。[ADR-0005](0005-cdn-and-origin-strategy.md) は、セグメントとマニフェストを 6 時間の署名つきの URL で配り、エッジで確かめると決めた。
- 再生のトークンは `event-collector`・`license-proxy`・`api` が確かめる。エッジのトークンは CDN のエッジの関数が確かめる。エッジの関数で使える暗号の種類は限られる（HMAC は使えると見込み、公開鍵の署名は**未検証**）。
- NFR-003・NFR-004 の指標（開始の時間、再バッファの割合）は、定義の細部（広告、シーク、開始の前の離脱）で値が大きく変わる。定義を先に決めないと、計測と目標がずれる。

## Options

トークン：

1. **2 つ（再生のトークンは Ed25519、エッジのトークンは HMAC）**
2. 1 つ（HMAC）を全部で使う
3. 1 つ（Ed25519）を全部で使う

QoE の出来事の流れ：

- a. **`watch-events` に載せ、視聴の計測と同じ流れで集める**
- b. 別の計測の口と流れを持つ

## Decision

1 と a を採用する。詳細は [playback-and-abr.md](../architecture/playback-and-abr.md) の 4・7 節。

- 再生のトークン：`v`・`u`・`d`・`caps`・`rg`・`drm`・`sid`・`iat`・`exp`（10 時間）。Ed25519 の鍵は 2 つを並べて回す。ヘッダーは `<Brand>-Playback-Token`。
- エッジのトークン：`video_id`・`caps`・許す地域・`exp`（6 時間）・鍵の番号。HMAC-SHA256。形は [ADR-0025](0025-edge-token-signing-and-cache-keys.md)。
- エッジのトークンの期限の 10 分前に、プレイヤーは再生の API を呼び直す（`playable()` を再び通る）。
- 出来事：`play_intent`、`first_frame`（ADR-0007 の `play_start` を兼ねる）、`start_failure`、`rebuffer`、心拍の段ごとの秒数を足す。
- 指標の定義：
  - 開始の時間 = `first_frame − play_intent`（再生の前の広告を除く）
  - 開始の失敗 = `start_failure` ÷ `play_intent`（30 秒より前の離脱は別に数える）
  - 再バッファの割合 = Σ 止まった時間 ÷（Σ 再生 ＋ Σ 止まった時間）、開始とシークの待ちを除く
  - 平均の VMAF = 再生した秒ごとの段の VMAF の時間の加重平均（電話はスマートフォンのモデル）

### 他の案を選ばなかった理由

- **2（HMAC だけ）**：エッジ・`event-collector`・`license-proxy` のすべてに同じ秘密の鍵を配る。どこか 1 つの漏れで、全部のトークンを作れる。
- **3（Ed25519 だけ）**：エッジの関数で確かめられる保証がない（**未検証**）。確かめられたら 1 つにまとめる ADR を書く。
- **b（別の流れ）**：同じ再生のトークン・端末の識別子・IP アドレスの粗くし方を、2 つの経路で別に持つことになる。

## Consequences

- 良くなること：
  - 秘密の鍵はエッジの HMAC の鍵だけで、範囲は配信の URL に限られる。
  - QoE と視聴の計測が同じ出来事から作られ、CDN・ISP・端末の切り口がそろう。
- 引き受けるコスト：
  - 2 つのトークンの鍵の回しを運用する。
  - `watch-events` の量が QoE の出来事の分だけ増える（心拍に値を足す形にして、件数は増やさない）。

## Confirmation

- 性質ベーステスト：PROP-QOE-001（出来事の順序によらず集計が同じ）。
- 表駆動テスト：DT-QOE-001（指標の定義）。
- 結合テスト：期限切れ・改ざん・別の `video_id` のトークンが、`event-collector`・`license-proxy`・エッジで拒まれる。

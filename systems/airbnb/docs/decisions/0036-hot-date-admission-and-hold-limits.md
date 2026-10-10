---
status: accepted
date: 2026-10-10
---

# ADR-0036: 熱い日付は、Valkey の空室の写しの確かめ → 先着の印 `claim:{listing_id}:{check_in}` → DB の順に絞る。印は予約の取り消しで比べて消す。Valkey がないときはリスティングごと・タスクごとの同時実行 4 と `lock_timeout` 200ms。1 人の有効な仮押さえは 2、リクエストは 5、同じリスティングで支払いの失敗が 24 時間に 3 回なら 24 時間そのリスティングを予約させない

## Context

- [ADR-0004](0004-booking-state-machine-and-holds.md) は、Valkey の先着の印（15 秒）で DB に届く要求を絞り、Valkey がなければリスティングごとの同時実行の上限（4）を通すと決めた。
- S1 で、人気の 1 リスティング・日付に 50 件/秒（[architecture/README.md](../architecture/README.md) の 2 節）。負けの応答 p99 300ms（NFR-004）。
- 印だけでは、仮押さえが入った後の 10 秒ほど、全員が印を試し続ける。支払いの失敗で日付が空いても、印が 15 秒残ると誰も取れない。
- 仮押さえを繰り返して日付を塞ぐ攻撃がありうる（ADR-0004 の「引き受けるコスト」）。
- Mercari の題材が人気の出品で同じ形を決めた（[ADR-0026](../../../mercari/docs/decisions/0026-hot-listing-purchase-admission.md)）。

## Options

1. **写し → 印 → DB。取り消しで印を比べて消す。Valkey の停止の時はセマフォ 4。仮押さえの数の上限と、支払いの失敗の冷却**
2. 印だけで絞る
3. リスティングごとの待ち行列で直列にする

## Decision

1 を採用する。手順と例は [booking-and-holds.md](../architecture/booking-and-holds.md) の 8 節。

- `avail:{listing_id}` のビット列で泊が埋まっていれば即座に 409 `dates_unavailable`。
- 空いていれば `SET claim:{listing_id}:{check_in} <attempt_id> NX PX 15000`。取れなければ 409 `in_progress`。
- 印の持ち主だけが T&S の検査と DB に進む。予約が `cancelled` になったら、値が自分のときだけ印を消す（Lua）。
- Valkey の停止の時は、`booking` のタスクの中のセマフォ（4、待ち 100ms）。`booking` のタスクの最大を 12 にし、1 リスティングへの同時の DB の接続を 48 までにする。
- 上限：1 ゲストの `pending_payment` 2、`requested` 5、仮押さえの作成 1 時間 10、1 端末 1 時間 20、同じゲスト × リスティングの支払いの失敗・期限切れ 24 時間に 3 回で 24 時間の冷却。値は `ops.*`。

### 他の案を選ばなかった理由

- **2**：仮押さえの後も全員が印を試す。失敗の後の空き時間が長い。
- **3**：平時の遅れが増え、負けの応答が待ち行列の長さだけ遅れる。

## Consequences

- 良くなること：
  - Valkey が生きている間、1 つの日程について DB に届くのは 1 件。
  - 支払いの失敗の後、すぐに次の取り合いに入れる。
- 引き受けるコスト：
  - 写しの古さ（p95 10 秒）の間、埋まった日付を空きと読んで印か DB で負ける。正しさは変わらない。
  - 重なる別の日程（チェックインの日が違う）は別の印で、両方が DB に届く。

## Confirmation

- 負荷試験：50 件/秒の 1 リスティング・日付で、二重の予約 0、負けの応答 p99 300ms（Valkey なし 1 秒）、DB の接続 70% 以下（[quality.md](../quality.md) の 2.2.1 節 J）。
- `hot-dates-booking-poc` で、セマフォの値と `lock_timeout` を測って記録する。

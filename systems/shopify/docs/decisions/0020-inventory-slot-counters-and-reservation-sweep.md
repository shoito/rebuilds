---
status: accepted
date: 2026-10-10
---

# ADR-0020: 在庫の枠の行に `available`・`reserved`・`committed` の 3 つの数を持たせ、拠点の行は `on_hand`・`unavailable` だけを持つ。期限切れの引き当ては、1 分ごとの掃除が `FOR UPDATE SKIP LOCKED` で 500 行ずつ戻す

## Context

- [ADR-0004](0004-inventory-reservation-model.md) は、熱い品目の `available` を枠（slot）の行に分けると決めた。`reserved` と `committed` をどの行に持つかは決めていない。
- `reserved` と `committed` を拠点 × 品目の 1 行（`inventory_levels`）に持つと、引き当てと確定のたびにその行を更新する。1 ショップ 100 件/秒（NFR-002）で、その行が新しい熱い行になる。枠に分けた意味がなくなる。
- 期限切れの引き当ての戻しは、確定と競合する。どちらか一方だけが勝つ必要がある（ADR-0004）。
- 掃除の処理は、ポッドの中でショップをまたぐ X1 の経路で動く（[ADR-0003](0003-tenancy-and-rls.md)）。

## Options

1. **枠の行に `available`・`reserved`・`committed` を持つ。拠点の行は `on_hand`・`unavailable` を持つ。数は和で読む**
2. 拠点の行に `reserved`・`committed` を持ち、枠には `available` だけを持つ
3. `reserved`・`committed` を数として持たず、引き当ての行と注文の行の和から毎回求める

## Decision

1 を採用する。詳細は [inventory-and-reservations.md](../architecture/inventory-and-reservations.md) の 4・5 節。

- 不変条件は `on_hand = Σslot(available + reserved + committed) + unavailable` とする。ADR-0004 の式を、枠の和で読む形にしたもので、意味は変えない。
- 枠の行に `CHECK (reserved >= 0 AND committed >= 0)` を置く。`deny` の品目は加えて `CHECK (available >= 0)`。
- 引き当て・確定・戻しは、1 つの枠の行だけを更新する。拠点の行に触れない。
- 配送（`committed` を減らし `on_hand` を減らす）と入荷・調整は、拠点の行と枠の行を同じトランザクションで書く。これらは熱くない。
- 掃除の処理（`reservation-sweeper`）は 1 分ごとに動く。ショップを 1 つずつ `SET LOCAL` で回し、`state = 'reserved' AND expires_at < now() - interval '30 seconds'` の行を、`ORDER BY expires_at LIMIT 500 FOR UPDATE SKIP LOCKED` で取る。行ごとに `UPDATE reservations SET state = 'released' WHERE id = $1 AND state = 'reserved'` を実行し、1 行が変わったときだけ、その枠の `reserved` を減らし `available` を増やす。
- 30 秒の猶予は、期限の直前に始まった `completeCheckout` が先にロックを取る余地として置く。期限を過ぎても戻していなければ確定してよい（ADR-0004）。

### 他の案を選ばなかった理由

- **2**：拠点の行が熱い行になる。
- **3**：照合と画面の表示のたびに大きな集計が要る。CHECK 制約で数を守れない。

## Consequences

- 良くなること：
  - 引き当て・確定・戻しの更新が、枠の数だけ並ぶ。
  - 状態の条件つきの更新で、確定と戻しの一方だけが勝つ。
- 引き受けるコスト：
  - 数の読み出しは枠の和になる。品目の画面と Admin API は和の見方（ビュー）を読む。
  - 配送は、`committed` を持つ枠を探して減らす（5.4 節）。

## Confirmation

- 性質ベーステスト PROP-INV-001〜003（[quality.md](../quality.md) の 2.2.1 節 A）。
- 結合テスト：確定と掃除を同じ引き当てに同時に流し、`committed` と `released` のどちらか一方だけになる。
- 負荷試験：枠 32 で 1 ショップ 100 件/秒のとき、拠点の行の更新が 0 件/秒（配送・入荷を除く）。

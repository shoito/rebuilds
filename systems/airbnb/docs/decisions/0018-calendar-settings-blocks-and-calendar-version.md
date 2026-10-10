---
status: accepted
date: 2026-10-10
---

# ADR-0018: `calendar_days` は料金と規則の上書きだけを持つ。閉じる操作は `host_block` の行にし、解除は行を外して残りを挿入し直す。空室・設定の変更は同じトランザクションでリスティングの `calendar_version` を上げ、outbox に書く

## Context

- [ADR-0002](0002-availability-representation-and-double-booking.md) は、泊ごとの行（`calendar_days`）を設定にだけ使い、空室の正本を `stay_claims` にすると決めた。ホストが日を「閉じる」操作は `host_block` の行を作る、とした。
- ホストは範囲を閉じ、その一部だけを開ける。行の一部だけを外す方法が要る。
- 検索の索引と Valkey の写しは、`calendar_version` で古い書き込みを捨てる（[ADR-0003](0003-search-for-date-range-availability.md)）。どの書き込みが `calendar_version` を上げるかを 1 か所に決める必要がある。

## Options

1. **解除は行を外し、残りを新しい行で挿入し直す。全部の空室・設定の書き込みで同じトランザクションで `calendar_version` を上げ、outbox に書く**
2. 解除は行の `nights` を縮める `UPDATE`
3. 泊ごとの閉じた印を `calendar_days` に持ち、`stay_claims` に写す

## Decision

1 を採用する。詳細は [availability-and-calendars.md](../architecture/availability-and-calendars.md) の 4.5・5・7 節。

- `blockDates` は区間ごとに `host_block`（PMS は `api_block`、運用は `ops_block`）を挿入し、隣り合う区間を 1 行にまとめる。重なる部分は入れずに理由のコードで返す。
- `unblockDates` は、解除の範囲と重なる同じ主体の種類の行を `released`（`unblocked`）にし、範囲の外に残る部分を新しい行で挿入する。予約・取り込みの行は外さない。
- `stay_claims`・`calendar_days`・`listing_rules` を書く関数は、最後にリスティングの `calendar_version` を 1 つ上げ、outbox に `listing.calendar_changed` を書く。一括の変更でも 1 回だけ上げる。
- `calendar_days` は今日から 2 年先までを持ち、過ぎた日は 90 日後に消す。

### 他の案を選ばなかった理由

- **2**：排他の制約の外の操作として縮めるのは安全だが、行の履歴（いつ何を閉じたか）が消える。行を消さない規則（ADR-0002）と合わない。
- **3**：空室の正本が 2 つになり、写しの遅れで二重に売る窓ができる。

## Consequences

- 良くなること：
  - 閉じる・開ける・予約・取り込みが同じ `stay_claims` の制約に入る。
  - `calendar_version` の上げ方が 1 か所で、検索・写しの鮮度の判定が単純になる。
- 引き受けるコスト：
  - 解除のたびに行が増える。1 リスティングの有効な行の上限（2,000）で抑える。
  - リスティングの行のロックで、同じリスティングの書き込みが直列になる。

## Confirmation

- 性質ベーステスト PROP-AVL-003（閉じた日 − 解除した日 = 有効なホストの行の日）。
- 鮮度の試験：書き込みの事象を重複・順序の入れ替えで流し、索引と写しが最後の `calendar_version` に収束する（[quality.md](../quality.md) の 2.2.1 節 E）。

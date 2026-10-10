---
status: accepted
date: 2026-10-10
---

# ADR-0047: `settlement_seq` は予約の「今開いている決着の番号」。1 つの番号に決着の型（release・settle・refund）は 1 つで、決着の後のお金の動き（変更の差額、release の後の返金）は次の番号を開く。決着のたびに預かりは通貨ごとに 0。release とキャンセルの競合は、予約の行のロックと `payout_released_at` で順序を決める

## Context

- release・settle・refund は `(reservation_id, settlement_seq)` の冪等キーで 1 回。日程の変更は `settlement_seq` を 1 つ上げ差分だけを書く（[ADR-0005](0005-payments-hold-capture-and-ledger.md)）。
- ADR-0005 は、決着の前の変更（番号を上げたが、まだ決着していない）と、決着の後の変更（release の後の延長）・返金（release の後のキャンセル）を区別していない。
- release（チェックイン + 24 時間）とキャンセルが近い時刻に来る。両方が書かれると預かりが負になる。

## Options

1. **開いている番号。番号ごとに決着は 1 つ。決着の前の変更は番号を上げて差分を足し、決着は最後の番号で全部を動かす。決着の後の動きは次の番号を開いてその番号で決着する**
2. 変更ごとに、前の番号を決着してから新しい番号を開く（変更のたびに決着）
3. 予約ごとに決着は 1 回だけ（番号を持たない）

## Decision

1 を採用する。詳細と例は [ledger-and-payouts.md](../architecture/ledger-and-payouts.md) の 5 節。

- `reservations.settlement_seq` は確定の時に 0。番号を上げるのは `booking` の遷移（変更の受諾、release の後のキャンセル）だけで、予約の行のロックの中。`ledger` は事象の番号に従う。
- `escrow_settlements (reservation_id, settlement_seq)` が主キーで、決着は番号ごとに 1 つ。決着の後、`guest_funds_held` は通貨ごとに 0。
- release とキャンセルは予約の行のロックで直列になる。キャンセルが先なら release は出ない。release が先なら、キャンセルは番号を上げて `after_release` で精算する（型 9）。
- キャンセルの精算のホストの取り分は、チェックインを待たずに `host_payable` に入れ、次の送金で送る。
- 事象は FIFO（グループは予約）で `ledger` に届く。遅れた 2 つ目の決着は主キーで拒まれ、`superseded` として記録する。

### 他の案を選ばなかった理由

- **2**：チェックインの前の変更で決着（release）が起き、チェックインの前の release 0（NFR-008）を破るか、決着の型が増える。
- **3**：release の後の延長・返金を表せない。

## Consequences

- 良くなること：
  - 決着の 1 回と、release の後の動きの両方を 1 つの規則で表せる。
- 引き受けるコスト：
  - 決着の行を持たない番号（決着の前の変更）があり、照合は「最後の番号が決着した」で見る。

## Confirmation

- 性質ベーステスト PROP-LED-002（番号ごとの決着は 1 つ、決着の後の預かりは 0）。release とキャンセルの競合を多めに生成する。
- 照合 R2〜R4。

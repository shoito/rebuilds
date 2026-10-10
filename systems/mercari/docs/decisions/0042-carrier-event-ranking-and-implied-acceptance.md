---
status: accepted
date: 2026-10-10
---

# ADR-0042: 運送会社の事象を 5 段の順位と 5 つの例外に写し、配送の行の `max_rank` より高い事象だけで進める。順位 1 以上の事象は引き受けを含むとみなし、取引には `carrier_accepted` を先に渡す。照会は受け付けと引き受けの後 6 時間ごと、自動の完了の 24 時間前にも 1 回。取り消しの後の引き受けは例外として運用へ

## Context

- [ADR-0006](0006-shipping-orchestration-via-carriers.md) は、正規の事象と順位（`label_created` 0 < `accepted` 1 < `in_transit` 2 < `out_for_delivery` 3 < `delivered` 4）、例外（`returned_to_sender`、`lost`、`damaged`、`held_at_office`）、inbox、6 時間ごとの照会、匿名の配送は `accepted` を `shipped` の条件にすることを決めた。
- Webhook は遅れ、順序が入れ替わる。`accepted` の通知が欠け、`in_transit` や `delivered` が先に届くことがある。`accepted` だけを条件にすると、品が届いているのに取引が `paid` のまま止まる。
- 遅れて届いた `accepted` の時刻は、`auto_receive_at`（発送の 9 日後の 13 時）の基準を早めうる。
- 取引の取り消しと、売り手の持ち込み（引き受け）が競合しうる。
- 自動の完了の直前に、配達済みや例外を取りこぼしていると、買い手の受け取りの前に売上金が動く。
- 受け取りの拒否（`refused`）を、例外の一覧が持っていない。

## Options

1. **順位 1 以上の事象は引き受けを含むとみなして補う。期限は前に動かさない。例外は順位の外で運用へ**
2. 本物の `accepted` が届くまで待つ（照会で取りに行く）
3. 売り手の発送の通知で `shipped` にし、運送会社の事象で確かめる

## Decision

1 を採用する。詳細と例は [shipping-integrations.md](../architecture/shipping-integrations.md) の 5・6 節。

- 順位は ADR-0006 のとおり。例外に `refused` を足した（5 つ）。例外は順位の外で、記録して運用の待ち行列に入れ、`shipped`・`delivered` の取引には `carrier_exception` を渡す。`delivered` の後の例外は記録だけにする。
- `max_rank` が 0 のときに順位 2〜4 の事象が来たら、`accepted` を補い（`implied = true`、時刻はもとの事象の時刻）、取引に `carrier_accepted` を先に渡す。ADR-0006 の「`accepted` のない匿名の配送は `shipped` にならない」を「順位 1 以上の運送会社の事象のない配送は `shipped` にならない」と読む。売り手の操作だけでは補わない。
- 後から届いた本物の `accepted` は記録し、画面の発送の日を直してよいが、`auto_receive_at` を前に動かさない（[ADR-0025](0025-transaction-decision-table-and-deadline-pause.md)）。
- 照会：受け付けの後と引き受けの後 6 時間ごと。加えて、取引の `auto_receive_at` の 24 時間前に 1 回。引き受けから 30 日で止め、運用へ。Webhook のある運送会社は 12 時間まで伸ばせる。
- 取り消しの後に順位 1 以上の事象が来たら、取引には渡さず、配送を `exception`（`shipped_after_cancel`）にして運用へ。

### 他の案を選ばなかった理由

- **2**：照会の間隔（6 時間）の分、配達済みの品の取引が `paid` に止まり、NFR-013（p95 60 秒）を守れない。
- **3**：偽の発送（運送会社に渡さずに発送の通知）を許す。ADR-0006 の決定に反する。

## Consequences

- 良くなること：
  - 欠けた `accepted` で取引が止まらない。偽の発送の守りは、運送会社の事象を条件にすることで保つ。
  - 遅れた事象で期限が早まらない。
- 引き受けるコスト：
  - 補った引き受けの時刻は本物より遅いことがあり、自動の完了が少し遅れる（買い手に有利な向き）。
  - 自動の完了の前の照会で、1 取引 1 回の照会が増える。

## Confirmation

- 性質ベーステスト：PROP-SHP-001（前にだけ進む）、PROP-SHP-002（偽の発送なし）、PROP-SHP-003（収束）、PROP-SHP-005（期限を早めない）を `carrier-sim` で。
- 表駆動テスト：運送会社ごとの写しの表、例外の扱い。
- 競合の試験：取り消しと引き受けの同時、自動の完了の期限と `lost` の同時。

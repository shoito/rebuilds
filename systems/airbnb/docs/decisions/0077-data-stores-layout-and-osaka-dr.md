---
status: accepted
date: 2026-10-10
---

# ADR-0077: Aurora の 4 クラスタは書き込み 1 と別の AZ の読み出しで Global Database で大阪へ写し、ledger だけ `rds.global_db_rpo = 60` を置く。Valkey は空室の写しほかの失ってよい部品、OpenSearch は大阪をスナップショットにする。大阪はウォームスタンバイで、止める → 昇格 → 照合 → 検索・予約・PMS・iCal・送金の順に開け、期限は止めた時間だけずらす

## Context

- NFR-011：AZ の障害で RPO 0・RTO 5 分、リージョンの障害で RPO 1 分・RTO 1 時間。確定した予約と仕訳の消失 0。
- 予約と台帳は別のクラスタで、outbox と冪等キーでつなぐ（[ADR-0005](0005-payments-hold-capture-and-ledger.md)）。リージョンの切り替えで、クラスタごとに失う範囲が違いうる。
- 空室の正本は core の `stay_claims` で、Valkey の写しと OpenSearch の索引は正本でない（[ADR-0002](0002-availability-representation-and-double-booking.md)、[ADR-0003](0003-search-for-date-range-availability.md)）。
- 仮押さえ（10 分）、リクエスト（24 時間）、見積もり（15 分）、レビュー（14 日）の期限は、止まった間に切れると利用者の責任でない失敗になる。送金の振り替えの時刻は下限で、遅れてよい（[ADR-0004](0004-booking-state-machine-and-holds.md)）。
- Mercari の題材は、3 クラスタと ledger の `rds.global_db_rpo` と、振込を最後に開ける切り替えを決めた（[Mercari の ADR-0073](../../../mercari/docs/decisions/0073-aurora-layout-osaka-dr-and-ledger-rpo.md)）。

## Options

1. **4 クラスタとも Global Database。ledger だけ commit を止めてでも RPO を守る。大阪はウォームスタンバイ、OpenSearch はスナップショット**
2. 全クラスタに `rds.global_db_rpo` を置く
3. 大阪をパイロットライト（スナップショットだけ）にする

## Decision

1 を採用する。詳細は [infrastructure.md](../architecture/infrastructure.md) の 4・7 節。

- **Aurora**：core（書き込み 1、読み出し 2）、ledger・content・vault（書き込み 1、読み出し 1）。core・ledger・content は I/O-Optimized、vault は標準の保存。PostgreSQL 18、`rds.force_ssl = 1`、自動のバックアップ 35 日、Global Database で大阪へ（二次の読み出し 1）。
- **ledger の RPO**：主のクラスタに `rds.global_db_rpo = 60`。複製が 60 秒を超えて遅れたら commit を止める。止まった間、予約は進み、仕訳は outbox に溜まる。大阪のパラメーターは既定にする。core・content・vault は上限を置かない。
- **Valkey**：クラスタモード 2 シャード（S1）。空室の写し、料金の要約、見積もりの写し、セッション、先着の印、速さの上限。失ってよい。大阪は空のクラスタで、切り替えの後に写しを作り直す。
- **OpenSearch**：1 つのドメイン（データのノード 3、マスター 3）。1 時間ごとのスナップショットを大阪へ。切り替えで戻し、その後の outbox の事象で追いつく。戻す間の検索は「一時的に検索できない」（[search-and-ranking.md](../architecture/search-and-ranking.md) の 9 節）。
- **切り替え**：IC と Ops の責任者が決める。`ops.booking_enabled`・`ops.payouts_enabled`・`ops.ical_import_enabled`・`ops.partner_api_enabled.*` を止める → vault・core・ledger・content を昇格 → ECS と Valkey を広げる → エッジの元を大阪へ → 照合（`stay_claims`、180 日、予約と台帳、直近 15 分の決済の提供者への照会）→ 期限をずらす → 検索 → 予約 → PMS の書き込み → iCal の取り込み → 予約と台帳の照合が 0 になってから送金。
- **期限**：`deadline-runner` を止め、再開の前に仮押さえ・リクエスト・見積もり・レビューの期限を止めた時間だけ後ろへずらす。`payout_release_at` はずらさない。`dr_events` に記録する。
- **戻し**：東京へ戻すのは管理された switchover（RPO 0）。

### 他の案を選ばなかった理由

- **2（全クラスタで commit を止める）**：core の commit が止まると予約そのものが止まり、NFR-010 の 99.95% を守れない。予約の失った範囲は、決済の照会で見つけて直せる。
- **3（パイロットライト）**：スナップショットからの戻しは数時間かかり、RTO 1 時間に届かない。

## Consequences

- 良くなること：
  - 仕訳の失う範囲が 60 秒以内に限られる。
  - 切り替えの後、照合が済むまで送金が出ないので、お金の誤りを広げない。
  - 期限のずらしで、利用者の責任でない期限切れを作らない。
- 引き受けるコスト：
  - ledger の commit の止まりの間、release と送金が遅れ、NFR-008 の p99 5 分を外れうる。
  - 大阪の 4 つの二次と空のクラスタの費用。
  - 切り替えの最中は、OpenSearch を戻すまで検索が止まる（予約とリスティングの閲覧は続く）。

## Confirmation

- 半年ごとの DR の訓練（`dr-failover-drill`）：RPO・RTO、照合の結果、期限のずらし、OpenSearch の戻しの時間を測る。
- 障害の注入（夜間）：DB のフェイルオーバーの最中の予約で、二重の予約 0、予約の重複 0、照合の食い違い 0（[quality.md](../quality.md) の 2.2.1 節 J）。
- plan のポリシー検査：ledger の主のクラスタの `rds.global_db_rpo` の削除を拒む。

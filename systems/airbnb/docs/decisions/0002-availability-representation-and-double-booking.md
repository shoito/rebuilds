---
status: accepted
date: 2026-10-10
---

# ADR-0002: 空室の正本を、予約・仮押さえ・リクエスト・ブロック・取り込みをまとめた `stay_claims` の泊の範囲の行にし、`(listing_id, block_span)` の排他の制約で重なりを DB で 0 にする。準備の日は各予約の後ろの範囲に含める。泊ごとの行はカレンダーの設定にだけ使う。日付は物件の現地の日付で持つ

## Context

宿泊のマーケットプレイスは、1 つのリスティングの 1 つの夜を、1 組のゲストにだけ売る。次を守る（NFR-005、NFR-014）。

- 同じ夜に有効な予約・仮押さえ・リクエスト・ブロック・取り込んだ外部の予定は、どんな並行度でも 1 つ。
- 予約の間の準備の日（清掃のための空き）を守る。
- 最短・最長の泊数、チェックイン・チェックアウトのできる曜日、締め切り（「前日の 18 時まで」）、予約できる期間（「12 か月先まで」）を、物件の現地の日付と時刻で判定する。

難しさは次のとおり。

- **書き込みの経路が多い。** 即時予約、予約のリクエスト、日程の変更、ホストのブロック、PMS の API、iCal の取り込み、運用の代わりの予約が、同じリスティングの同じ日付に同時に来る。
- **範囲で重なる。** 3 泊の予約と 2 泊の予約は、日付の一部だけが重なる。日程の変更は、古い範囲と新しい範囲が重なったまま入れ替わる。
- **準備の日は前後に効く。** 準備が 1 泊なら、予約の後ろの 1 泊と、次の予約の前の 1 泊が空いていなければならない。
- **時刻は物件の場所で決まる。** ゲストは別のタイムゾーンから予約する。「当日の 18 時まで」は物件の現地の 18 時である。夏時間のある国の物件もある（S2 以降）。

本家は泊ごとのカレンダーと、準備の日・締め切り・最短の泊数の設定を持つ（[ヘルプの記事 99](https://www.airbnb.com/help/article/99) に、他のカレンダーのブロックが準備の日・締め切りの設定の違いで効かないことがある、とある。2026-10-10 に確認）。内部の持ち方は公開されていない（**未検証**）。

## Options

空室の持ち方：

1. **泊の範囲の行（`daterange`）と排他の制約。すべての種類（予約、仮押さえ、リクエスト、ブロック、取り込み）を 1 つの表に入れる**
2. 泊ごとの行（リスティング × 日）に状態を持ち、`(listing_id, night)` の一意の制約で守る
3. 予約の表とブロックの表を分け、アプリがロックの中で重なりを確かめる
4. Valkey のビット列を正本にし、DB へは後で書く

日付：

- a. **物件の現地の日付（`date`）。瞬間は物件のタイムゾーンで UTC に直した値**
- b. UTC の瞬間（`timestamptz`）でチェックインとチェックアウトを持つ

## Decision

1 と a を採用する。

### 表の形

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE stay_claims (
  id               uuid PRIMARY KEY,            -- UUIDv7
  listing_id       uuid NOT NULL REFERENCES listings(id),
  kind             text NOT NULL,               -- reservation | hold | request | host_block | ical_block | api_block | ops_block
  status           text NOT NULL,               -- active | released
  nights           daterange NOT NULL,          -- [check_in, check_out)。泊の日だけ
  prep_nights      smallint NOT NULL DEFAULT 0, -- 作成の時のリスティングの準備の日（0〜2）
  block_span       daterange NOT NULL,          -- [check_in, check_out + prep_nights)
  hold_expires_at  timestamptz,                 -- hold・request だけ
  reservation_id   uuid,                        -- reservation・hold・request
  claim_group      uuid NOT NULL,               -- 予約に関わる行は reservation_id、他は id
  source_ref       text,                        -- ical の UID、API のクライアントの ID など
  version          bigint NOT NULL,
  CHECK (NOT isempty(nights) AND lower(nights) < upper(nights)),
  CHECK (block_span = daterange(lower(nights), upper(nights) + prep_nights)),
  EXCLUDE USING gist (listing_id WITH =, claim_group WITH <>, block_span WITH &&)
    WHERE (status = 'active')
);
```

- **1 つの表、1 つの制約。** どの種類の行も同じ排他の制約に入る。書き込みの経路を足しても、重なりは DB が拒む。アプリの事前の確かめ（`checkStayRules`）は、利用者に理由を返すためで、正しさを担わない。
- **同じ組の行どうしだけは重なってよい。** `claim_group` は、予約に関わる行（`hold`・`request`・`reservation`）では `reservation_id`、それ以外（ブロック、取り込み）では行の `id` にする。日程の変更の応答を待つ間、同じ予約の古い日付と新しい日付が重なって有効になれる（[ADR-0004](0004-booking-state-machine-and-holds.md)）。異なる組の重なりは常に拒む。
- **準備の日は後ろにだけ持つ。** `block_span` は泊の範囲に、その予約の後ろの準備の日を足したもの。後ろの予約の前の準備は、前の予約の `block_span` が担う。前の予約が 1 泊の準備を持つなら、次の予約はチェックアウトの翌日から始められる。Google Calendar の題材が予約ページの間の時間で同じ形を取っている（[ADR-0033](../../../google-calendar/docs/decisions/0033-booking-creation-and-exclusion.md)）。
- **ブロックと取り込みは準備の日を持たない**（`prep_nights = 0`）。ただし取り込みの設定で「外部の予約として扱う」を選んだ取り込みは、リスティングの準備の日を持つ（calendar-sync の領域）。
- **準備の日の設定を変えても、既存の行は変えない。** 新しい値は、その後に作る行から効く。既存の予約の間が新しい値より狭くなることを引き受ける（ホストの画面で知らせる）。
- **行は消さない。** キャンセル・期限切れ・ブロックの解除は `status = 'released'` にし、履歴として残す。照合と監査に使う。
- **期限の切れた仮押さえ。** `hold`・`request` は `hold_expires_at` を過ぎても、`released` にするまで制約に残る。新しい挿入の前に、同じトランザクションで同じリスティングの期限の切れた行を `released` にする（`UPDATE ... WHERE listing_id = $1 AND kind IN ('hold','request') AND hold_expires_at < now() AND status = 'active'`）。`deadline-runner` も 1 分ごとに外す。

### 滞在の規則

制約に入れない規則は、`packages/availability` の 1 つの純粋な関数 `checkStayRules(listing_rules, calendar_days, request, now)` で判定する。予約の時は、リスティングの行のロックの中で呼ぶ。検索のステージ 2 も同じ関数を呼ぶ（[ADR-0003](0003-search-for-date-range-availability.md)）。

| 規則 | 持ち方 | 判定 |
| --- | --- | --- |
| 最短・最長の泊数 | リスティングの既定と、チェックインの日ごとの上書き（`calendar_days`） | チェックインの日の値で判定 |
| チェックイン・チェックアウトの曜日 | 曜日の集合（既定は全部） | 物件の現地の日付の曜日 |
| 締め切り | 「当日の HH:MM まで」か「N 日前まで」 | 物件の現地の今の時刻と比べる |
| 予約できる期間 | 3・6・9・12・24 か月先まで | 物件の現地の今日から数える |
| 定員 | リスティングの定員 | 人数 |
| 泊ごとの空き | `calendar_days.closed`（ホストが閉じた日） | 閉じた日はブロックの行に直して `stay_claims` に入れる。規則の関数では見ない |

- **泊ごとの行（`calendar_days`）は設定にだけ使う。** 料金の上書き、最短の泊数の上書き、メモ。空室の正本にしない。ホストが日を「閉じる」操作は、`calendar_days` ではなく `stay_claims` の `host_block` の行を作る。
- 規則の判定の結果は、理由のコード（`min_nights`、`checkin_day`、`cutoff`、`booking_window`、`capacity`）で返す。

### 日付と時刻

- 泊は物件の現地の日付の `daterange` で、タイムゾーンを持たない。2026-12-30 のチェックインは、どこから予約しても 2026-12-30 である。
- 瞬間（チェックインの時刻、締め切り、仮押さえの期限、送金の振り替えの時刻、キャンセルの境、レビューの期限）は、`packages/stay-time` の関数で、物件の現地の日付と時刻と `listings.time_zone`（IANA の名前）から UTC の瞬間に直す。DB には UTC の瞬間と、計算に使った tz データベースのバージョン（`tzdata_version`）を書く。
- 現地の時刻が存在しない（夏時間で飛ぶ）ときは後ろへ、2 つある（戻る）ときは早いほうを取る。Google Calendar の題材の決め方に合わせる（[ADR-0002](../../../google-calendar/docs/decisions/0002-time-representation.md)）。
- tz データベースを更新したら、未来の瞬間の列を計算し直す（Google Calendar の題材の [ADR-0012](../../../google-calendar/docs/decisions/0012-tzdb-update-recompute-and-propagation.md) の考え方）。日本の物件は影響を受けない。
- 物件のタイムゾーンは、位置から決め、ホストが変えられない（運用だけが直せる）。

### 他の案を選ばなかった理由

- **2（泊ごとの行）**：二重の予約は一意の制約で止められるが、準備の日（予約の後ろの空き）を表すには、準備の日の行を別の種類で持ち、次の予約の挿入で前の予約の準備の行との関係を確かめる必要がある。日程の変更は全部の行の更新になり、28 泊の予約は 28 行になる。ブロックの「2 年閉じる」は 730 行になる。S3 で行の数が 10 億を超え、索引と真空の掃除が重い。
- **3（アプリの確かめ）**：ロックの取り忘れ、新しい経路（PMS の API、移行のジョブ）で重なりうる。Google Calendar の題材と同じく、DB の制約で拒む規則にそろえる。
- **4（Valkey を正本）**：フェイルオーバーで書き込みを失うと二重に売る。
- **b（UTC の瞬間）**：泊は日付の概念で、ゲストとホストのタイムゾーンで違って見えてはいけない。UTC の瞬間で持つと、tz データベースの更新で泊の日がずれうる。

## Consequences

- 良くなること：
  - 二重の予約を、経路の数に依らず DB の 1 つの制約で 0 にできる。
  - 準備の日を、追加の表なしで表せる。
  - 日程の変更が、1 行を外して 1 行を入れる操作になる（[ADR-0004](0004-booking-state-machine-and-holds.md)）。
- 引き受けるコスト：
  - 排他の制約の GiST の索引は、B-tree の一意の索引より書き込みが重い。S1 の量（1 秒 10 件の予約）では問題にならない見込みだが、熱い日付の負荷は `hot-dates-booking-poc` で確かめる。
  - 1 リスティングに複数の同じ部屋（ホテルの部屋の種類）を持つと、この制約は使えない（部屋ごとの行にするか、数の在庫にする）。S2 で availability-and-calendars の領域で決める。
  - 検索は「空いている区間」を必要とするので、`stay_claims` から空きの区間を計算し直す処理が要る（[ADR-0003](0003-search-for-date-range-availability.md)）。
  - S3 で core を分けるとき、`stay_claims` はリスティングと同じ分け先に置く（分け方の鍵は `listing_id`）。

## Confirmation

- 性質ベーステスト：任意の数の並行の書き込み（即時予約、リクエスト、承認、断り、日程の変更、キャンセル、ブロック、iCal の取り込み、仮押さえの期限切れ）で、同じリスティングの有効な `block_span` は重ならない。参照の実装（泊ごとの配列に直列に書く）と、成功する書き込みの集合が一致する（[quality.md](../quality.md) の 2.2.1 節 A）。
- 表駆動テスト：滞在の規則の決定表（availability-and-calendars の領域の spec）。
- 時刻の試験ベクトル：日付の境、締め切りの境、夏時間の飛びと重なり、tz データベースの更新（同 D）。
- 本番：`stay_claims` の内部の照合（有効な行の重なり 0。制約があるので 0 のはずで、制約の外し忘れ・移行の誤りを見つける）。

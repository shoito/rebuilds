# Availability and Calendars: Airbnb

空室とカレンダーを決める。`stay_claims` の行の種類と書き方、排他の制約と `claim_group`、`block_span` と準備の日、物件の現地の日付で持つ泊、滞在の規則（`checkStayRules`）の決定表 DT-AVL-001、泊ごとのカレンダーの設定（`calendar_days`）、ホストのブロック、`calendar_version` と検索・写しへの知らせ、物件のタイムゾーンと `packages/stay-time`、tz データベースの更新、1 リスティングの複数の同じ部屋（S2）を扱う。

前提となる決定は次のとおり。

- 空室の正本は `stay_claims` の泊の範囲の行で、`EXCLUDE USING gist (listing_id WITH =, claim_group WITH <>, block_span WITH &&) WHERE (status = 'active')` が異なる組の重なりを拒む。準備の日は各行の後ろに持つ。泊は物件の現地の日付（[ADR-0002](../decisions/0002-availability-representation-and-double-booking.md)）
- 予約・仮押さえ・リクエストの行は `reserveStay`・`alterReservation` だけが作る（[ADR-0004](../decisions/0004-booking-state-machine-and-holds.md)。[booking-and-holds.md](booking-and-holds.md)）
- 検索は `stay_ranges` と Valkey の空室の写しで候補を絞るだけ。予約の判定は DB で行う（[ADR-0003](../decisions/0003-search-for-date-range-availability.md)。search-and-ranking の領域）
- 届出住宅の泊の日の数えは、同じトランザクションで `regulated_nights` に書く（[ADR-0006](../decisions/0006-regulatory-night-cap-enforcement.md)。[regulatory-compliance-japan.md](regulatory-compliance-japan.md)）

この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0017](../decisions/0017-stay-rules-decision-table.md) | 滞在の規則を DT-AVL-001 の 12 行で確定する。最短・最長はチェックインの日の値、締め切りは「N 日前の HH:MM」の 1 つの形、予約できる期間はチェックアウトの日で判定する。泊数の上限は MVP で 27 泊。判定は物件の現地の日付と時刻で、`checkStayRules` の 1 つの純粋な関数が行う |
| [0018](../decisions/0018-calendar-settings-blocks-and-calendar-version.md) | `calendar_days` は料金と規則の上書きだけを持つ。閉じる操作は `host_block` の行にし、解除は行を外して残りを挿入し直す。空室・設定の変更は同じトランザクションでリスティングの `calendar_version` を上げ、outbox に書く |
| [0019](../decisions/0019-tzdb-update-and-time-zone-recompute.md) | tz データベースはバージョンを固定して配り、更新の時と物件のタイムゾーンの訂正の時に、未来の瞬間の列を `tzdata_version` の古い行から計算し直す。泊の日付は変えない |
| [0020](../decisions/0020-multi-unit-listings-per-unit-claims.md) | 1 リスティングの複数の同じ部屋（S2）は、部屋（`listing_units`）ごとの `stay_claims` の行にし、排他の制約の鍵を `unit_id` にする。部屋の割り当ては予約のトランザクションの中で先に空いた部屋から決める |

## 1. 範囲

- 扱う：
  - `stay_claims` の種類、列、排他の制約、`claim_group`、`block_span`、期限の切れた行の外し方
  - 滞在の規則（最短・最長の泊数、チェックイン・チェックアウトの曜日、締め切り、予約できる期間、定員、準備の日）と `checkStayRules`、決定表 DT-AVL-001
  - 泊ごとの設定（`calendar_days`：料金の上書き、最短・最長の上書き、メモ）
  - ホストのブロックと解除、PMS のブロック（`api_block`）、運用のブロック（`ops_block`）
  - `calendar_version`、outbox、検索の索引と空室の写しへの知らせ
  - 物件のタイムゾーン、`packages/stay-time`、tz データベースの更新
  - `stay_claims` の照合
  - 1 リスティングの複数の同じ部屋（S2 の形）
- 扱わない：
  - 予約の作成と状態（[booking-and-holds.md](booking-and-holds.md)）。ここは `stay_claims` に書く関数の契約だけを決める
  - 日程の変更の流れ（[cancellations-and-changes.md](cancellations-and-changes.md)）。ここは同じ組の行の重なりの規則だけを決める
  - iCal の取り込みと書き出し（[calendar-sync.md](calendar-sync.md)）。ここは `ical_block` の行の形だけを決める
  - `stay_ranges` の作り方、ステージ 2、写しの中身（search-and-ranking の領域、[ADR-0003](../decisions/0003-search-for-date-range-availability.md)）
  - 泊の料金の規則と見積もり（pricing-and-fees の領域）
  - 届出住宅の数え（[regulatory-compliance-japan.md](regulatory-compliance-japan.md)）
  - 共同ホストの権限、PMS の API の形（host-tools-and-api の領域）

## 2. 要件

| 要件 | 目標 | NFR |
| --- | --- | --- |
| 二重の予約なし | 1 つのリスティングの異なる組の有効な `block_span` の重なり 0。Valkey の停止、DB のフェイルオーバー、PMS と画面と iCal の同時の書き込みでも 0 | NFR-005、K1 |
| 規則の正しさ | 滞在の規則に合わない予約 0。判定は物件の現地の日付と時刻 | intent の「守るべき振る舞い」 |
| 時刻の正しさ | 締め切り・期限の瞬間を、物件のタイムゾーンと tz データベースのバージョンで計算した値と違える件数 0 | NFR-014 |
| 鮮度 | 空室・設定の変化から、outbox の `listing.calendar_changed` まで p99 1 秒（同じトランザクションで書く）。検索と写しに効くまで p95 10 秒・p99 60 秒 | NFR-002 |
| 書き込みの速さ | ホストのブロック・解除・設定の変更 p99 300ms。1 回の一括の変更（365 日 × 1 リスティング）p99 2 秒 | NFR-004 の考え方 |
| 可用性 | 空室の書き込み 月間 99.95%（予約と同じ） | NFR-010 |

## 3. 本家の形（確かめたこと）

- 本家は泊ごとのカレンダーで、ホストが日を閉じ、最短の泊数・準備の日・締め切りを設定できる。他のカレンダーのブロックが、準備の日・締め切りの設定の違いで効かないことがある（[ヘルプの記事 99](https://www.airbnb.com/help/article/99)、2026-10-10 に確認。[intent.md](../intent.md) の出典）。
- 内部の持ち方、チェックインの日ごとの最短の泊数の上書きの判定、締め切りの細かい形、最長の泊数の上限、1 リスティングの複数の同じ部屋の扱いは、公式の資料で確かめられなかった（**未検証**）。本システムの値を使う。

## 4. `stay_claims`

### 4.1 行の種類

| `kind` | 作る関数 | `claim_group` | `prep_nights` | 期限 | 意味 |
| --- | --- | --- | --- | --- | --- |
| `hold` | `reserveStay`・`alterReservation` | `reservation_id` | 予約の時のリスティングの値 | `hold_expires_at`（10 分。日程の変更の提案は 24 時間） | 支払いの間・変更の応答の間の仮押さえ |
| `request` | `reserveStay` | `reservation_id` | 同上 | `hold_expires_at`（[booking-and-holds.md](booking-and-holds.md) の 6 節） | ホストの応答を待つ予約のリクエスト |
| `reservation` | `transition`（`confirmed` への遷移）・`alterReservation` の受諾 | `reservation_id` | 同上（`hold` の値を引き継ぐ） | なし | 確定した予約 |
| `host_block` | `blockDates`（ホスト・共同ホストの画面） | 行の `id` | 0 | なし | ホストが閉じた日 |
| `api_block` | `blockDates`（PMS の API） | 行の `id` | 0 | なし | PMS が閉じた日。`source_ref` に PMS の ID |
| `ops_block` | `blockDates`（運用の画面） | 行の `id` | 0 | なし | 安全の事故・審査での停止 |
| `ical_block` | `applyIcalSnapshot`（[calendar-sync.md](calendar-sync.md)） | 行の `id` | 0（取り込みの設定が「外部の予約」なら、リスティングの値） | なし | 取り込んだ外部の予定 |

- 種類ごとに作る関数は 1 つ。`stay_claims` への `INSERT`・`UPDATE` の権限は `availability_writer` の役割だけが持ち、`booking` と `ical-sync` は `packages/availability` の関数を通してだけ書く（DB の `GRANT` で縛る）。
- `hold` と `request` を `reservation` に変えるのは、同じ行の `UPDATE`（`kind`、`hold_expires_at = NULL`、`version + 1`）で、行を作り直さない。`block_span` は変わらないので、排他の制約を外れる瞬間はない。

### 4.2 列と制約

[ADR-0002](../decisions/0002-availability-representation-and-double-booking.md) の表に、次の列を足す。

| 列 | 意味 | 足した理由 |
| --- | --- | --- |
| `unit_id` | 部屋（S2）。S1 では NULL | [ADR-0020](../decisions/0020-multi-unit-listings-per-unit-claims.md) |
| `released_reason` | `expired`・`cancelled`・`declined`・`altered`・`unblocked`・`ical_removed`・`superseded` | 照合と監査 |
| `released_at` | 外した時刻 | 同上 |
| `created_by_type`・`created_by_id` | 主体（ゲスト、ホスト、共同ホスト、PMS のアプリ、`ical-sync`、運用者） | 監査 |
| `tzdata_version` | `hold_expires_at` を計算した tz データベースのバージョン（期限のある行だけ） | [ADR-0019](../decisions/0019-tzdb-update-and-time-zone-recompute.md) |

```sql
-- partial index for expiry sweeps and per-listing pre-insert cleanup
CREATE INDEX stay_claims_expiring
  ON stay_claims (listing_id, hold_expires_at)
  WHERE status = 'active' AND kind IN ('hold', 'request');
-- read path for calendar screens and cache rebuild
CREATE INDEX stay_claims_listing_active
  ON stay_claims USING gist (listing_id, block_span) WHERE status = 'active';
CREATE INDEX stay_claims_reservation ON stay_claims (reservation_id) WHERE reservation_id IS NOT NULL;
-- releasing is the only allowed change after insert besides hold -> reservation
CHECK (status IN ('active', 'released'));
CHECK ((status = 'released') = (released_at IS NOT NULL));
CHECK (kind NOT IN ('hold', 'request') OR status = 'released' OR hold_expires_at IS NOT NULL);
CHECK (kind IN ('hold', 'request', 'reservation') = (reservation_id IS NOT NULL));
CHECK (kind IN ('hold', 'request', 'reservation') OR claim_group = id);
```

- 行は消さない。外すときは `status = 'released'`、`released_reason`、`released_at` を書く。外した行を `active` に戻さない（戻すときは新しい行を作る）。
- 排他の制約は `WHERE (status = 'active')` の部分の制約なので、外した行は索引に残らない。
- `released` の行は 400 日を過ぎたら月ごとに `stay_claims_archive` に移す（照合と監査は 400 日で足りる。予約の記録は予約の表に残る）。

### 4.3 `claim_group` と同じ組の重なり

- `claim_group` は、予約に関わる行（`hold`・`request`・`reservation`）では `reservation_id`、それ以外の行では行の `id` にする（CHECK で守る）。
- 同じ組の有効な行が 2 つになるのは、日程の変更の応答を待つ間だけである。古い `reservation` の行と、新しい日付の `hold` の行が並ぶ。2 つは重なってよく、他の組とは重ならない（[cancellations-and-changes.md](cancellations-and-changes.md) の 7 節、[ADR-0041](../decisions/0041-alterations-with-claim-group-and-delta-settlement.md)）。
- 同じ組の有効な行は 2 つまで。`alterReservation` は、同じ組の有効な `hold` がすでにあれば 409 `alteration_pending` を返す。照合（9 節の R3）でも見張る。

### 4.4 泊と `block_span`

- 泊は `nights = [check_in, check_out)`。2026-12-30 にチェックインし 2027-01-02 にチェックアウトする滞在は、12/30・12/31・1/1 の 3 泊。
- `block_span = [check_in, check_out + prep_nights)`。準備の日は後ろにだけ持つ。
- 準備の日は前の予約の `block_span` が担うので、新しい滞在の後ろの準備の日が次の予約の初日に重なることも拒まれる。

**例：準備の日 1 のリスティング**

| 行 | `nights` | `block_span` | 結果 |
| --- | --- | --- | --- |
| R1（確定） | [10/13, 10/15) | [10/13, 10/16) | — |
| 新 A | [10/16, 10/18) | [10/16, 10/19) | 入る（10/15 は R1 の準備の日で、A は 10/16 から） |
| 新 B | [10/15, 10/17) | [10/15, 10/18) | 拒む（10/15 は R1 の準備の日） |
| 新 C | [10/11, 10/13) | [10/11, 10/14) | 拒む（C の準備の日 10/13 が R1 の初日に重なる） |
| 新 D | [10/10, 10/12) | [10/10, 10/13) | 入る（D の準備の日 10/12 の翌日に R1 が始まる） |
| ブロック E | [10/16, 10/20) | [10/16, 10/20) | 入る（ブロックは準備の日を持たない） |

- ホストが準備の日の設定を 1 から 2 に変えても、R1 の `block_span` は変えない。新しい値はその後に作る行から効く（[ADR-0002](../decisions/0002-availability-representation-and-double-booking.md)）。既存の予約の間が新しい値より狭いところは、ホストの画面に「準備の日が足りない間」として出す。

### 4.5 書き込みの関数

`packages/availability` の関数だけが `stay_claims` を書く。どれも呼び出し側のトランザクションの中で動き、自分では `COMMIT` しない。

| 関数 | 呼ぶ所 | ロック | 中身 |
| --- | --- | --- | --- |
| `claimStay(tx, listing, nights, kind, reservation_id, expires_at)` | `reserveStay`・`alterReservation` | 呼び出し側が届出住宅 → リスティングの順に取る | 期限の切れた行を外す → `checkStayRules` → 挿入 |
| `confirmClaim(tx, reservation_id)` | `transition`（`confirmed`） | 予約の行 | `hold`・`request` → `reservation` |
| `releaseClaims(tx, reservation_id, reason)` | `transition`（`cancelled`・`declined`・`expired`）、変更の断り | 予約の行 | 組の有効な行を外す |
| `swapClaims(tx, reservation_id)` | 変更の受諾 | リスティング → 予約 | 古い `reservation` を外し、新しい `hold` を `reservation` に |
| `blockDates(tx, listing, ranges, kind, actor, source_ref?)` | ホストの画面、PMS の API、運用 | リスティング | 区間ごとに挿入。重なった区間は理由のコードで返す |
| `unblockDates(tx, listing, ranges, actor)` | 同上 | リスティング | 5 節 |
| `applyIcalSnapshot(tx, feed, desired)` | `ical-sync` | リスティング | [calendar-sync.md](calendar-sync.md) の 6 節 |

- どの関数も、リスティングの行を `FOR UPDATE` で取ってから書く。同じリスティングの書き込みは、このロックで直列になる。排他の制約は、ロックを通らない書き込み（移行、手の修正）にも効く最後の守りである。
- 挿入は `INSERT ... ON CONFLICT ON CONSTRAINT stay_claims_no_overlap DO NOTHING RETURNING id` で行い、0 行なら重なった行を `SELECT` して理由のコード（`overlap_reservation`、`overlap_block`、`overlap_ical`、`overlap_prep`）を返す。例外で戻すより、どの行と重なったかを 1 回で返せる。
- 書き込みの最後に、同じトランザクションで `listings.calendar_version` を 1 つ上げ、outbox に `listing.calendar_changed`（`listing_id`、`calendar_version`、変わった範囲）を書く（[ADR-0018](../decisions/0018-calendar-settings-blocks-and-calendar-version.md)）。

### 4.6 期限の切れた行

- `claimStay` は挿入の前に、同じトランザクションで、同じリスティングの期限の切れた `hold`・`request` を外す。

```sql
UPDATE stay_claims
   SET status = 'released', released_reason = 'expired', released_at = now(), version = version + 1
 WHERE listing_id = $1 AND status = 'active'
   AND kind IN ('hold', 'request') AND hold_expires_at < now()
RETURNING id, reservation_id;
```

- ここで外した行の予約は、まだ `pending_payment`・`requested` のまま残る。予約の状態は、`deadline-runner` が期限の処理（照会を含む）で決める（[booking-and-holds.md](booking-and-holds.md) の 7 節）。行だけ先に外れても、支払いが後から成功したときは、`confirmed` への遷移が `claimStay` をやり直し、取れなければ `cancelled` にして返金する（DT-BKG-001 の行 9）。
- `deadline-runner` も 1 分ごとに同じ `UPDATE` を、索引 `stay_claims_expiring` で全リスティングに回す（1 回 500 行、`SKIP LOCKED`）。

### 4.7 例：即時予約と iCal の取り込みの競合

前提：リスティング L（`Asia/Tokyo`、準備の日 1、即時予約）。他の掲載先 X の iCal を 15 分ごとに取り込む。X で 12/30〜1/2（3 泊）の予約が入った。同じ頃、本システムのゲスト G が 12/31〜1/3（3 泊）を即時予約する。

| 時刻（日本時間） | `booking`（G の `reserveStay`） | `ical-sync`（X の取り込み） |
| --- | --- | --- |
| 20:00:00.000 | — | X の iCal を取得（新しい VEVENT：`DTSTART;VALUE=DATE:20261230`、`DTEND;VALUE=DATE:20270102`） |
| 20:00:00.120 | `BEGIN`、L の行を `FOR UPDATE` で取る | `BEGIN`、L の行を `FOR UPDATE` で待つ |
| 20:00:00.125 | `checkStayRules` 通過。`hold` の行 `nights [12/31, 1/3)`、`block_span [12/31, 1/4)` を挿入 | 待つ |
| 20:00:00.131 | 予約（`pending_payment`）と outbox を書き、`COMMIT` | ロックを得る |
| 20:00:00.133 | 支払いへ | `ical_block` `[12/30, 1/2)` の挿入が `block_span [12/31, 1/4)` と重なる → 0 行 |
| 20:00:00.135 | — | 6.3 節で切り取る：重ならない `[12/30, 12/31)` だけを `ical_block` で挿入。`[12/31, 1/2)` を `calendar_conflicts` に記録。`COMMIT` |
| 20:00:01 | — | outbox → ホストへの知らせ（NFR-003 の 5 分以内）、運用の待ち行列 |

- 順序が逆（取り込みが先にロックを得た）なら、`ical_block [12/30, 1/2)` が先に入り、G の `hold` の挿入が重なって 409 `dates_unavailable` になる。ゲストは支払いの前に知り、請求は起きない。
- どちらの順でも、L の 12/31・1/1 に有効な行は 1 つだけになる（NFR-005）。どちらが先かは、外部の予約の時刻ではなく、本システムが知った時刻で決まる。外部の予約が先だった場合の二重の予約は、本システムの中では防げないので、検出して知らせる（[calendar-sync.md](calendar-sync.md) の 6 節）。
- 2 つのトランザクションがリスティングのロックを通らずに同時に挿入した場合（移行のジョブなど）も、PostgreSQL の排他の制約は、まだコミットしていない重なる行の結果を待ってから判定する。片方だけが入る（[PostgreSQL のドキュメント：Exclusion Constraints](https://www.postgresql.org/docs/18/ddl-constraints.html#DDL-CONSTRAINTS-EXCLUSION)、**未検証**：本文で待ちの振る舞いの記述は確かめていない。`avail-reference-and-props` の並行の試験で確かめる）。

## 5. ホストのブロックと解除

- ホストが日を閉じると、`blockDates` が区間ごとに `host_block` の行を挿入する。隣り合う区間は 1 行にまとめて挿入する（画面で 10/1〜10/5 と 10/6〜10/9 を選べば `[10/1, 10/10)` の 1 行）。
- 既存の行と重なる区間は、重ならない部分だけを入れ、重なった部分を理由のコードで返す（「12/31〜1/1 はすでに予約があります」）。閉じる操作は失敗にしない。
- 解除（`unblockDates`）は、解除の範囲と重なるホストの行（`host_block`。PMS の解除なら同じ PMS の `api_block`）を外し、範囲の外に残る部分を新しい行で挿入し直す。

| 前 | 解除の範囲 | 後 |
| --- | --- | --- |
| `host_block [10/1, 10/10)` | [10/4, 10/6) | 外す → `[10/1, 10/4)`・`[10/6, 10/10)` を挿入 |
| `host_block [10/1, 10/10)` | [9/25, 10/3) | 外す → `[10/3, 10/10)` を挿入 |
| `reservation [10/1, 10/4)` | [10/1, 10/4) | 何もしない。理由 `not_a_block`（予約はキャンセルで外す） |
| `ical_block [10/1, 10/4)` | [10/1, 10/4) | 何もしない。理由 `imported_block`（取り込みは外部で消す。取り込みの設定から外すことはできる） |

- `ops_block` は運用だけが外せる。ホストの画面では理由のコード `ops_hold` を出す。
- 1 回の操作の上限：区間 50、日数の和 730（2 年）。PMS の一括の操作は 1 リクエストあたりリスティング 100 まで（host-tools-and-api の領域）。

## 6. 滞在の規則

### 6.1 規則の持ち方

| 規則 | 持ち方 | 既定値 | 範囲 |
| --- | --- | --- | --- |
| 最短の泊数 | `listing_rules.min_nights`、`calendar_days.min_nights`（チェックインの日の上書き） | 1 | 1〜27 |
| 最長の泊数 | `listing_rules.max_nights`、`calendar_days.max_nights`（同） | 27 | 1〜27（MVP の上限。[ADR-0017](../decisions/0017-stay-rules-decision-table.md)） |
| チェックインの曜日 | `listing_rules.checkin_weekdays`（ISO の曜日の集合） | 全部 | 空でない集合 |
| チェックアウトの曜日 | `listing_rules.checkout_weekdays` | 全部 | 空でない集合 |
| 締め切り | `listing_rules.cutoff_days_before`（0〜7）と `cutoff_local_time`（HH:MM） | 0 日前の 18:00 | — |
| 予約できる期間 | `listing_rules.booking_window_months` | 12 | 3・6・9・12・24 |
| 準備の日 | `listing_rules.prep_nights` | 0 | 0〜2 |
| 定員 | `listings.max_guests`（listings-and-content の領域） | — | 1〜16 |
| 物件のタイムゾーン | `listings.time_zone`（IANA の名前） | 位置から決める | 運用だけが直す |

- 規則の変更は、その後の判定から効く。既存の予約を規則で外すことはない。
- 規則の表（`listing_rules`）は、リスティングの行とは別の行で、変更ごとに `rules_version` を上げる。見積もりは `rules_version` を写しに持ち、予約の時に違えば 409 `quote_expired`（[booking-and-holds.md](booking-and-holds.md) の 5 節）。

### 6.2 `checkStayRules`

```
checkStayRules(rules, overrides, request, now) -> ok | {reason, detail}
  rules     : listing_rules + listings.max_guests + time_zone
  overrides : calendar_days for the check-in date only
  request   : {check_in, check_out, guests}
  now       : UTC instant (from clock; virtual in tests)
```

- 純粋な関数で、DB にも時計にも触れない（`now` は引数）。予約、日程の変更、検索のステージ 2、ホストの画面の「この日程で泊まれるか」の 4 か所が同じ関数を呼ぶ。
- 泊の空き（`stay_claims`）はこの関数で見ない。排他の制約が決める（[ADR-0002](../decisions/0002-availability-representation-and-double-booking.md)）。
- 今日（`today_local`）と今の現地の時刻は `packages/stay-time` の `localNow(time_zone, now)` で求める。

### 6.3 DT-AVL-001

上から評価し、最初に一致した行の理由を返す（[ADR-0017](../decisions/0017-stay-rules-decision-table.md)）。`n = check_out − check_in`（泊数）。

| # | 条件 | 結果 | 理由のコード |
| --- | --- | --- | --- |
| 1 | `check_out ≤ check_in` | 拒む | `invalid_range` |
| 2 | `check_in < today_local` | 拒む | `in_the_past` |
| 3 | `n > 27`（MVP の上限） | 拒む | `stay_too_long_platform` |
| 4 | `guests.total > max_guests` | 拒む | `capacity` |
| 5 | `check_out > add_months(today_local, booking_window_months)` | 拒む | `booking_window` |
| 6 | `now ≥ toInstant(check_in − cutoff_days_before, cutoff_local_time, time_zone)` | 拒む | `cutoff` |
| 7 | `weekday(check_in) ∉ checkin_weekdays` | 拒む | `checkin_day` |
| 8 | `weekday(check_out) ∉ checkout_weekdays` | 拒む | `checkout_day` |
| 9 | `n < coalesce(overrides.min_nights, rules.min_nights)` | 拒む | `min_nights` |
| 10 | `n > coalesce(overrides.max_nights, rules.max_nights)` | 拒む | `max_nights` |
| 11 | `prep_nights` が `[0, 2]` の外（設定の誤り） | 拒む | `rules_invalid` |
| 12 | 上のどれにも当たらない | 通す | — |

- `add_months` は月末を丸める（1 月 31 日 + 1 か月 = 2 月 28 日か 29 日）。
- 締め切りの瞬間は `toInstant`（`packages/stay-time`）で求める。現地の時刻が存在しない（夏時間で飛ぶ）ときは後ろへ、2 つあるときは早いほう（[ADR-0002](../decisions/0002-availability-representation-and-double-booking.md)）。
- 行 5 は、チェックアウトの日が期間の中にあることを求める（最後の泊が期間の端を越えない）。
- 行 9・10 は、チェックインの日の上書きだけを見る。滞在の途中の日の上書きは見ない（本家の判定は**未検証**。本システムの値）。
- 検索のステージ 2 は、写しの規則の要約（上書きの差分を含む）で同じ表を評価する（[ADR-0003](../decisions/0003-search-for-date-range-availability.md)）。

### 6.4 例：規則の判定

前提：リスティング L（`Asia/Tokyo`、定員 4、最短 2、最長 14、チェックインの曜日は日曜を除く、チェックアウトは全部、締め切り「0 日前の 18:00」、予約できる期間 12 か月、準備の日 1）。10 月の土曜日は `calendar_days.min_nights = 3`。今 = 2026-10-10（土）17:30 日本時間（08:30Z）。

| # | 要求（人数 2） | 評価 | 結果 |
| --- | --- | --- | --- |
| a | 10/10（土）〜10/12（月）、2 泊 | 行 9：土曜の上書き 3 > 2 | `min_nights` |
| b | 10/10（土）〜10/13（火）、3 泊 | 行 6：締め切り 10/10 18:00 の前。行 9：3 ≥ 3 | 通す |
| c | b を 18:00:00 に送る | 行 6：`now` = 締め切り | `cutoff` |
| d | 10/11（日）〜10/13（火） | 行 7：日曜 | `checkin_day` |
| e | 2027-10-09（土）〜2027-10-11（月） | 行 5：期間の端 2027-10-10 < 10/11 | `booking_window` |
| f | 10/14（水）〜11/13（金）、30 泊 | 行 3 | `stay_too_long_platform` |
| g | b と同じ、人数 5 | 行 4 | `capacity` |

- ゲストが UTC の 2026-10-10 08:59:59Z（日本時間 17:59:59）に送れば b は通り、09:00:00Z では行 6 で拒む。ゲストの端末のタイムゾーンには依らない（[quality.md](../quality.md) の 2.2.1 節 D）。

## 7. 泊ごとの設定（`calendar_days`）

| 列 | 意味 |
| --- | --- |
| `listing_id`・`day` | 主キー。`day` は物件の現地の日付 |
| `nightly_price_override` | 泊の料金の上書き（リスティングの通貨の最小単位の整数。pricing-and-fees の領域が読む） |
| `min_nights`・`max_nights` | その日をチェックインの日とする滞在の上書き |
| `note` | ホストのメモ（ゲストに見せない。ログに出さない） |
| `set_by_type` | `host`・`cohost`・`pms`・`pricing_suggestion`（[ADR-0009](../decisions/0009-trust-and-safety-and-ml-boundary.md)） |
| `version` | 行のバージョン |

- 空室は持たない。「閉じる」は `stay_claims` の `host_block`（5 節）。
- 行は今日から 2 年先（予約できる期間の最大）までだけ持ち、過ぎた日は 90 日後に消す（設定であって記録ではない。料金の記録は見積もりの写しにある）。
- 一括の変更（365 日まで）は 1 つのトランザクションで `INSERT ... ON CONFLICT (listing_id, day) DO UPDATE` を 1 回で書き、`calendar_version` を 1 回だけ上げる。

## 8. 時刻（`packages/stay-time`）

| 関数 | 入力 | 出力 |
| --- | --- | --- |
| `localNow(tz, now)` | タイムゾーン、UTC の瞬間 | 現地の日付と時刻 |
| `toInstant(local_date, local_time, tz)` | 現地の日付と時刻 | UTC の瞬間と `tzdata_version`。存在しない時刻は後ろへ、2 つある時刻は早いほう |
| `checkInAt(listing, check_in)`・`checkOutAt(listing, check_out)` | リスティングのチェックイン・チェックアウトの時刻 | 同上 |
| `nightDate(tz, instant)` | 時刻つきの予定（iCal） | 泊の日（[calendar-sync.md](calendar-sync.md) の 5.2 節） |

- tz データベースは、`packages/stay-time` に同じバージョンを固定して入れ、全サービスで同じ値を使う。サービスの起動の時に、DB の `tzdata_releases` の最新と自分のバージョンを比べ、違えば起動しない（2 つのバージョンの混在で同じ入力から違う瞬間を出さない）。
- 瞬間の列（`hold_expires_at`、`check_in_at`、`check_out_at`、`payout_release_at`、`request_expires_at`、`alteration_expires_at`、`claim_window_ends_at`）は、計算に使った `tzdata_version` を同じ行に書く。

### 8.1 tz データベースの更新

[ADR-0019](../decisions/0019-tzdb-update-and-time-zone-recompute.md) で決めた。Google Calendar の題材の [ADR-0012](../../../google-calendar/docs/decisions/0012-tzdb-update-recompute-and-propagation.md) の考え方に合わせる。

1. 新しいバージョンを `packages/stay-time` に入れ、全サービスを出し直す（`delivery` の手順。起動の確かめで混在を防ぐ）。
2. `tz-recompute` のジョブが、新しいバージョンで規則の変わったタイムゾーンの物件について、未来の瞬間の列のうち `tzdata_version` が古い行を 1,000 件ずつ計算し直す。値が変わったら、予約の行のロックを取って書き直し、`next_deadline_at` を計算し直す。泊の日付は変えない。
3. チェックインの時刻が変わった予約は、ゲストとホストに知らせる。

- 日本（`Asia/Tokyo`）は夏時間を持たず、S1 では実際の影響はない。仕組みは S2（アジアの他の国）の前に試験で確かめる。
- 物件のタイムゾーンの訂正（位置の誤り）は運用だけが行い、同じジョブで、その物件の未来の瞬間を計算し直す。泊の日付は変えない。

## 9. 照合（`stay-claims-reconciler`）

5 分ごと（繁忙期は 1 分ごと）。読み出しの写しで、`REPEATABLE READ` の 1 つのスナップショットの中で比べる。

| # | 比べるもの | 外れたとき |
| --- | --- | --- |
| R1 | 同じリスティング（S2 は同じ部屋）の異なる組の有効な `block_span` の重なり（制約があるので 0 のはず） | page（SEV1 の候補）。`ops.booking_enabled` でそのリスティングを止める |
| R2 | `confirmed`・`in_stay` の予約に、有効な `reservation` の行がちょうど 1 つ（変更の応答の間は、加えて `hold` が 1 つ） | page |
| R3 | 同じ組の有効な行が 3 つ以上、または変更の応答の期限を 10 分過ぎた `hold` が残る | ticket |
| R4 | `cancelled`・`declined`・`expired` の予約に有効な行がない | page |
| R5 | 期限を 10 分過ぎた `hold`・`request` が有効なまま | ticket（`deadline-runner` を確かめる） |
| R6 | `listings.calendar_version` と、Valkey の写し・索引の `calendar_version` の差が 60 秒を超えて続く | ticket（search-and-ranking の領域の鮮度） |

- 直しは関数（運用の介入の手順）でだけ行い、行を手で書き換えない。

## 10. 1 リスティングの複数の同じ部屋（S2）

[ADR-0020](../decisions/0020-multi-unit-listings-per-unit-claims.md) で決めた。S1 では作らない（intent の「MVP の後」）。

- `listing_units`（`listing_id`、`unit_id`、`label`、`active`）を持ち、`stay_claims.unit_id` を NOT NULL にする（複数の部屋のリスティングだけ）。排他の制約を `EXCLUDE USING gist (unit_id WITH =, claim_group WITH <>, block_span WITH &&) WHERE (status = 'active')` の索引で足す（1 部屋のリスティングは `unit_id` に既定の部屋を 1 つ持たせ、同じ制約に寄せる）。
- 部屋の割り当ては `claimStay` の中で、リスティングの行のロックの下、部屋を `unit_id` の順に試して最初に入った部屋にする（先に空いた部屋）。日程の変更は、同じ部屋を先に試す。
- ゲストに部屋を選ばせない。ホストは部屋の入れ替え（同じ泊の 2 つの予約の部屋を交換）を `swapUnits` で行える。交換は 1 つのトランザクションで 2 行を外して 2 行を挿入する。
- 検索の写しは、泊ごとの空いた部屋の数（ビット列の代わりに 1 泊 1 バイト）にする。ステージ 2 は「全部の泊で 1 以上」と「同じ部屋で続けて空いている」を分けて判定し、後者を写しに持たない場合は DB で確かめる（search-and-ranking の領域で決める）。
- 届出住宅の数え（[ADR-0006](../decisions/0006-regulatory-night-cap-enforcement.md)）は部屋に依らず、届出住宅 × 日で 1 日である。

## 11. 障害のときの振る舞い

| 障害 | 影響 | 振る舞い |
| --- | --- | --- |
| Valkey の停止 | 写しがない | 正しさは DB。検索はステージ 2 を DB に迂回（[ADR-0003](../decisions/0003-search-for-date-range-availability.md)） |
| outbox の遅れ | 検索・写しが古い | 正しさは変わらない。R6 と鮮度の SLI で見る |
| Aurora の書き込みの交代 | 書き込みのトランザクションが戻る | ホストの画面・PMS は冪等キーで再送（`blockDates` は `(actor, idempotency_key)` の一意）。予約は [booking-and-holds.md](booking-and-holds.md) の 11 節 |
| `deadline-runner` の停止 | 期限の切れた行が残る | 次の `claimStay` が同じリスティングの行を先に外す。R5 で見る |
| リスティングの行のロックの待ち | 書き込みが遅れる | `lock_timeout` 500ms（ホストの画面）、200ms（予約）。超えたら 409 `busy`（`Retry-After: 1`） |
| tz データベースの混在 | 同じ入力から違う瞬間 | 起動の確かめで防ぐ（8 節） |

## 12. 上限

| 対象 | 値 |
| --- | --- |
| 泊数 | 1〜27（MVP。28 泊以上は MVP の後） |
| 予約できる期間 | 最大 24 か月 |
| 準備の日 | 0〜2 |
| 1 回のブロックの操作 | 区間 50、日数の和 730 |
| `calendar_days` の一括の変更 | 1 回 365 日 |
| 1 リスティングの有効な `stay_claims` | 2,000 行（超えたら新しいブロックを 422。取り込みの細かい予定の多い相手を想定） |
| 書き込みの `lock_timeout` | 予約 200ms、ホストの画面・PMS 500ms |
| `released` の行の保持 | 400 日（その後は `stay_claims_archive`） |

## 13. data-model への項目

| 表・置き場 | 中身 | 主キー・索引 | 節 |
| --- | --- | --- | --- |
| `stay_claims`（core、ホストのアカウントと予約の 2 者の RLS） | [ADR-0002](../decisions/0002-availability-representation-and-double-booking.md) の列 ＋ `unit_id`、`released_reason`、`released_at`、`created_by_type`、`created_by_id`、`tzdata_version` | `id`。排他の制約 `stay_claims_no_overlap`、`stay_claims_expiring`、`stay_claims_listing_active`、`stay_claims_reservation` | 4 |
| `stay_claims_archive`（core） | 400 日を過ぎた `released` の行 | `id`、月の分割 | 4.2 |
| `listing_rules`（core、ホストのアカウントの RLS） | 最短・最長、曜日、締め切り、予約できる期間、準備の日、`rules_version` | `listing_id` | 6.1 |
| `calendar_days`（core、同） | 泊の料金の上書き、最短・最長の上書き、メモ、`set_by_type`、`version` | `(listing_id, day)` | 7 |
| `listings` の列（listings-and-content の領域が持つ） | `time_zone`、`calendar_version`、`max_guests`、チェックイン・チェックアウトの時刻 | — | 4.5、6、8 |
| `listing_units`（core。S2） | 部屋 | `(listing_id, unit_id)` | 10 |
| `tzdata_releases`（core） | 配ったバージョンと時刻 | `version` | 8 |
| outbox の事象 | `listing.calendar_changed`（`listing_id`、`calendar_version`、範囲） | — | 4.5 |
| `reconciliation_findings`（core） | 9 節の外れ（種類、`listing_id`、件数。個人のデータを持たない） | `(kind, found_at)` | 9 |

## 14. テスト

- **PROP-AVL-001（重ならない）**：任意の並行の操作（[quality.md](../quality.md) の 2.2.1 節 A の生成器）で、どの時点でも、同じリスティングの異なる組の有効な `block_span` は重ならない。本物の PostgreSQL 18 で並行度 2〜500。
- **PROP-AVL-002（参照との一致）**：`avail-ref`（泊ごとの配列に直列に書く）に同じ操作の列を流したとき、成功する書き込みの集合が一致する。
- **PROP-AVL-003（解除の保存）**：任意のブロックと解除の列で、ホストの有効な行の日の集合 = 閉じた日の集合 − 解除した日の集合。
- **PROP-AVL-004（規則の一致）**：任意の規則・上書き・要求・`now` で、`checkStayRules` と `avail-ref` の素直な規則の実装が同じ理由のコードを返す。
- **PROP-AVL-005（日付はゲストに依らない）**：任意の物件のタイムゾーンとゲストのタイムゾーンで、泊の `daterange` と締め切りの判定は同じ。
- **PROP-AVL-006（tz の計算し直し）**：任意の tz データベースの更新で、計算し直した後の瞬間の列は、新しいバージョンで最初から計算した値と一致し、泊の日付は変わらない。
- **表駆動**：DT-AVL-001 の全 12 行、4.4 節・5 節・6.4 節の例。
- **仮想の時計**（`clock-sim`、同 D）：締め切りの境（17:59:59・18:00:00）、月末と閏日の予約できる期間、夏時間の物件の締め切り、`deadline-runner` の 2 時間の停止。
- **障害の注入**：Valkey の停止、DB のフェイルオーバーの最中のブロックと予約で、R1〜R5 が 0。

## 15. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E5 | `stay-time-package` | 8 節（ADR-0019。PROP-AVL-005・006） |
| E5 | `stay-claims-and-exclusion` | 4 節（ADR-0002。PROP-AVL-001） |
| E5 | `stay-rules` | 6 節（ADR-0017。DT-AVL-001、PROP-AVL-004） |
| E5 | `calendar-settings-and-blocks` | 5・7 節（ADR-0018。PROP-AVL-003） |
| E5 | `avail-reference-and-props` | 14 節（`avail-ref`、PROP-AVL-001・002） |
| E5 | `stay-claims-reconciler` | 9 節 |
| E21 以降 | `multi-unit-listings` | 10 節（ADR-0020） |

## 16. 未解決の問い

### 決定

2026-10-10 の既定案。

- **規則の表**：DT-AVL-001 を 12 行で確定（ADR-0017）。
- **泊数の上限**：MVP は 27 泊。28 泊以上の月ごとの請求と送金は MVP の後で、借地借家法との関係（法務の L7）もそこで扱う（ADR-0017）。
- **締め切り**：「N 日前の HH:MM」の 1 つの形（ADR-0017）。
- **最短・最長の上書き**：チェックインの日の値だけを見る（ADR-0017）。
- **閉じる操作**：`host_block` の行。解除は外して残りを挿入し直す（ADR-0018）。
- **tz データベース**：バージョンを固定し、更新で未来の瞬間だけを計算し直す（ADR-0019）。
- **複数の同じ部屋**：部屋ごとの行と、部屋を鍵にした排他の制約（ADR-0020。S2）。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| 排他の制約の待ちと、熱い日付の書き込みの速さ | E9 の前の `hot-dates-booking-poc` |
| 1 リスティングの有効な行の上限（2,000）の妥当さ | E6 の `ical-import-poc` で、相手の予定の細かさを測ってから |
| 本家の最長の泊数、チェックインの日の上書きの判定、締め切りの形 | 公式の資料で確かめられなかった（**未検証**）。本システムの値を使う。最長 27 泊は本家との違いとして [README.md](README.md) の 1.4 節に書いた（2026-10-10、統合） |
| 複数の同じ部屋の検索の写しの形 | S2 の前に search-and-ranking の領域で |

## 出典

いずれも 2026-10-10 に確認。

- Airbnb, [ヘルプの記事 99（カレンダーの同期）](https://www.airbnb.com/help/article/99)：[intent.md](../intent.md) の出典のとおり
- PostgreSQL, [Constraints（Exclusion Constraints）](https://www.postgresql.org/docs/18/ddl-constraints.html#DDL-CONSTRAINTS-EXCLUSION)：排他の制約の定義。並行の挿入の待ちの記述は**未検証**

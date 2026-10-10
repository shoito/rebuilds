---
status: accepted
date: 2026-09-27
---

# ADR-0021: 乗車の遷移は 1 つの関数で行い、`assignment_epoch` を割り当ての作成と解放で増やし、部分一意索引で有効な割り当てを 1 つに限る

詳細は [trips-lifecycle.md](../architecture/trips-lifecycle.md) の 3〜6 節。

## Context

[ADR-0003](0003-trip-state-and-single-assignment.md) は、乗車の状態を Aurora のステートマシンを正本にし、割り当てをドライバーごとの fencing token（`assignment_epoch`）と部分一意索引で 1 つに限ると決めた。細部（状態の一覧、epoch をいつ増やすか、ロックの順序、タイマーの形）は trips-lifecycle で決めるとした。

決めることは次のとおり。

- 与信の前に配車するか。メーターの額を待つ間、ドライバーを割り当てに残すか。
- epoch を増やす時点。索引は `(assignment_epoch, trip_version)` の辞書順で新しい事象を適用する（[geospatial-index.md](../architecture/geospatial-index.md) の 4.2 節）ので、その順序と合う必要がある。
- 乗車とドライバーの 2 つの行をロックするときの順序。
- 時間で動く事象の持ち方。

## Options

### epoch を増やす時点

1. **割り当ての作成と解放で増やす。受諾などの進みでは増やさない**
2. **割り当ての作成だけで増やす**（[ADR-0003](0003-trip-state-and-single-assignment.md) の文言どおり）
3. **ドライバーの割り当ての状態が変わるたびに増やす**

### 状態の追加

1. **`payment_pending` と `awaiting_fare` を加える**
2. **ADR-0003 の状態のまま。与信とメーターの額の待ちは別の表の印で持つ**

## Decision

epoch は 1、状態は 1 を採用する。

- 遷移は Trips のサービスの `apply` だけが行う。`apply` は、`trip_commands` で冪等を確かめ、乗車の行 → ドライバーの `driver_dispatch_state` の行の順に `FOR UPDATE` でロックし、純粋な関数 `decide` を呼び、乗車・割り当て・タイマー・`trip_events`・outbox を 1 つのトランザクションで書く。逆の順のロックは使わない。
- 状態：`payment_pending`、`requested`、`offered`、`accepted`、`arriving`、`arrived`、`on_trip`、`awaiting_fare`、`completed`、`cancelled_by_rider`、`cancelled_by_driver`、`cancelled_by_system`、`no_driver_found`、`no_show`、`payment_failed`。
- `awaiting_fare` に入るとき、ドライバーの割り当てを完了にし、ドライバーを次のオファーに出す。
- epoch は、割り当ての作成で 1 増やし、解放（辞退・時間切れ・取り消し・無断キャンセル・完了）で 1 増やす。同じ割り当ての中の進みは `trip_version` が順序を決める。ドライバーのアプリの操作は `(assignment_id, assignment_epoch)` を付け、一致しなければ拒否する。
- 部分一意索引：`driver_assignments` の `status IN ('offered','accepted','arriving','arrived','on_trip')` の行を、`driver_id` ごとと `trip_id` ごとに 1 つに限る。乗客ごとの有効な乗車も、`trips` の部分一意索引で 1 つに限る。
- タイマーは `trip_timers`（期限、設定の時の `trip_version`、状態）に遷移と同じトランザクションで入れ、処理のタスクが `FOR UPDATE SKIP LOCKED` で取って `timer_fired` として `apply` に渡す。バージョンが違えば何もしない。時刻は DB の時計を使う。
- epoch の 2 を採らない理由：辞退・時間切れの後、解放の前の epoch を持つ遅れた受諾を、割り当ての状態の検査だけで止めることになる。解放でも増やせば、epoch の一致だけで古い操作を拒否でき、索引の順序とも合う。
- epoch の 3 を採らない理由：受諾のたびに epoch が変わると、ドライバーのアプリが持つ epoch を応答ごとに更新しなければならず、通信が切れたときの journal の送り直しで不一致が増える。
- 状態の 2 を採らない理由：与信の前に配車されない・メーターの待ちでドライバーを解放する、という条件が、状態の表の外に散る。表駆動テストで覆えない。

## Consequences

- 良くなること：
  - 割り当ての一意は、遷移関数・epoch・部分一意索引の 3 段で守られる。
  - 状態と時間の管理のすべての組が、1 つの表と 1 つの関数に集まる。
- 引き受けるコスト：
  - [ADR-0003](0003-trip-state-and-single-assignment.md) の状態の一覧から増えた分、モバイルの状態の解釈とテストのベクターが増える。
  - ロックの順序の規則を、レビューで守らせる必要がある。

## Confirmation

- 決定表：DT-TRIP-001〜003 と、表にない組の否定のテスト。
- 性質ベーステスト：PROP-TRIP-001（割り当ての一意）、PROP-TRIP-002（epoch の単調）、PROP-TRIP-003（終端の不変）、PROP-TRIP-004（冪等）、PROP-TRIP-007（乗客ごとの有効な乗車）。
- DB のロール：`trips.state` と `driver_assignments.status` を更新できるのは Trips のサービスのロールだけ。
- 本番の監視：1 分ごとの一意性の検査（SEV1）、タイマーの遅れ（5 秒で SEV2）。

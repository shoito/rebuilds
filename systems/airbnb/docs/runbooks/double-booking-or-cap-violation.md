# Runbook: 二重の予約・届出住宅の上限の超過

- Owner: Ops（当番）、CS、安全の担当
- 対応するアラート: `stay_claims` の照合の不一致（`recon_stay_claims_mismatches`。page、SEV1 の候補）、予約と行の照合の外れ（B1・B3）、外部の食い違い `double_booking`（確定した予約と取り込みの重なり）、180 日の照合の不一致・上限の超過・禁じた日の泊（`recon_regulated_nights_mismatches`。page、SEV1 の候補）、照合の最後の成功からの時間の超過
- 最終確認日: 2026-10-10

不変条件は [availability-and-calendars.md](../architecture/availability-and-calendars.md) の 9 節、[booking-and-holds.md](../architecture/booking-and-holds.md) の 12 節、[calendar-sync.md](../architecture/calendar-sync.md) の 6 節、[regulatory-compliance-japan.md](../architecture/regulatory-compliance-japan.md) の 11 節。

## 症状

- 同じリスティングの同じ夜に、異なる組の有効な `stay_claims` が 2 つある（制約があるので 0 のはず）。
- 確定した予約に有効な `reservation` の行がない、終わった予約に有効な行が残る。
- 取り込んだ外部の予定が、本システムの確定した予約と重なった（`calendar_conflicts` の `double_booking`）。
- 届出住宅の年度の `nights_used + external_used` が上限を超えた、禁じた日に泊がある、`regulated_nights` と `stay_claims` が食い違う。

## 影響

- ゲストが泊まる所を失う恐れ。代わりの宿の費用と信用の損失。
- 上限の超過は、ホストの業務の停止の命令と本システムの登録に関わる（法務の確認待ち：L1）。

## 確認

1. 照合の種類（`overlap`・`missing_reservation_claim`・`expired_active`・`group_dual`、G1〜G6）と件数。照合が止まっていないか（最後の成功からの時間）。
2. 本システムの中の重なりか、外部との重なりか。外部なら、外部の予定の泊とどちらが先か（本システムは外部の予約の時刻を知れない）。
3. 直近の移行のジョブ、手のデータの修正、排他の制約・CHECK 制約に触れるマイグレーション（守る物。[delivery.md](../architecture/delivery.md) の 5.2 節）がないか。
4. 対象のリスティングの次のチェックインまでの時間（短いものから扱う）。

## 対処

1. **止める**：`ops.booking_enabled` でそのリスティング（上限の超過は届出住宅）の新しい予約を止める。本システムの中の重なりが複数のリスティングにあれば、全体を止めて SEV1（[incident-response.md](incident-response.md)）。
2. **ゲストを守る**：チェックインの近い予約から、CS がホストに確かめる（チェックインの 72 時間前を切った食い違いは電話）。どちらのゲストも泊まれないなら、CS が代わりの宿を手配し、記録する（`rebooking_records`）。
3. **本システムの予約を取り消すとき**は、運用のキャンセル（`ops_double_booking`。全額の返金。外部が先の証拠があればホストの罰を免除）を遷移の関数で行う（[cancellations-and-changes.md](../architecture/cancellations-and-changes.md) の 6.2 節）。行を手で書き換えない。
4. **外部の予約を取り消すとき**は、ホストが外部で取り消す。食い違いは取り込みの次の書き込みで `resolved_external_removed` になる。
5. **上限の超過**：既存の予約を自動で取り消さない。超過を `regulatory_exceptions` に記録し、法務とホストに知らせる。`legal.*` の値の変更による数え直しで超えたなら、`regulated-recount` の結果を確かめる。
6. **原因を除く**：制約の外し忘れ・移行の誤りなら、守る物を戻す PR（テックリードの承認）。照合が 0 に戻るまで予約を止めたままにする。

## エスカレーション

- 本システムの中の重なり（制約が効いていない）：SEV1。テックリード、IC、CS、安全の担当。
- 上限の超過：SEV1 の候補。法務（L1）とホストへの連絡は法務の確認の後の文言で。

## 事後

- 原因の重なりの再現を `avail-ref` と `cap-ref` の回帰のシードに足す（[quality.md](../quality.md) の 2.2.1 節 A・B）。
- 止めたリスティング・届出住宅を開けたこと、照合が 0 に戻ったことを確かめる。

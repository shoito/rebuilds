# Trips lifecycle: Uber

乗車の状態機械の正本。状態と事象、1 つの遷移関数、`assignment_epoch` による割り当ての確定、部分一意索引、取り消しとキャンセル料、Aurora の表で持つタイマー、outbox、通信が切れても乗車を続ける仕組みを決める。

前提となる決定は、乗車の状態は Aurora の状態機械を正本にし、割り当ては fencing token つきのトランザクションで 1 つに限ること（[ADR-0003](../decisions/0003-trip-state-and-single-assignment.md)）、配車はバッチで最適化しオファーは 1 人ずつ送ること（[ADR-0004](../decisions/0004-batched-dispatch-and-offers.md)）。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0021](../decisions/0021-trip-transition-function-and-assignment-fencing.md) | 遷移は 1 つの関数だけが行い、ロックの順序は乗車 → ドライバーに固定する。`assignment_epoch` は割り当ての作成と解放で増やす。有効な割り当ては部分一意索引でドライバーごと・乗車ごとに 1 つ。タイマーは `trip_timers` の表で持つ |
| [0022](../decisions/0022-trip-outbox-and-offline-continuation.md) | 状態の変化は同じトランザクションで outbox に書き、少なくとも 1 回配る。ドライバーのアプリは操作の記録（journal）と署名つきの乗車の要約を持ち、通信が切れても乗車を続け、つながったら順に送り直す |

## 1. 目的と範囲

- 扱う：乗車の状態と事象、遷移の表、割り当ての作成・受諾・解放、配車への戻し、取り消しとキャンセル料の判定、無断キャンセル、タイマー、事象の配信、乗車の区間、運賃の確定の待ち、通信が切れたときの継続、障害の後の復元。
- 扱わない：組み合わせの計算（[dispatch-and-matching.md](dispatch-and-matching.md)）、運賃の額（[pricing-and-fares.md](pricing-and-fares.md)）、与信と売上の確定（[payments-and-payouts.md](payments-and-payouts.md)）、アプリへの届け方（`notifications-and-realtime-push.md`）、緊急の通報（`safety-and-trust.md`）。
- **割り当ての書き込みは、この領域の遷移関数だけが行う**（[AGENTS.md](../../AGENTS.md)）。配車は提案し、索引は写しを持つだけである。

## 2. 本家の形（確かめたこと）

- 本家の Fulfillment の基盤は、last-write-wins の可用性優先の構成で分断のときに状態が壊れたため、Spanner の強い一貫性のトランザクションと、階層的な状態機械へ作り直した（[Uber's Fulfillment Platform: Ground-up Re-architecture](https://www.uber.com/us/en/blog/fulfillment-platform-rearchitecture/)、2021-07、2026-09-27 に確認）。
- 本家は、データセンターの切り替えのとき、ドライバーの端末に送っておいた状態の要約から乗車を戻していた（[How Uber Scales Their Real-time Market Platform](http://highscalability.com/blog/2015/9/14/how-uber-scales-their-real-time-market-platform.html)、2015、2026-09-27 に確認）。
- 本家の日本のヘルプは、ドライバーとのマッチングの前の取り消しは無料で、マッチングの後はキャンセル料がかかることがあると説明している（[Uber の配車をキャンセルする](https://help.uber.com/en/riders/article/uber-%E3%81%AE%E9%85%8D%E8%BB%8A%E3%82%92%E3%82%AD%E3%83%A3%E3%83%B3%E3%82%BB%E3%83%AB%E3%81%99%E3%82%8B?nodeId=56270015-1d1d-4c08-a460-3b94a090de23)、2026-09-27 に確認）。額と時間の条件は、そのページに書かれていない。この設計は本家の値に依らず、事業者の規則で持つ（pricing の 4.3 節）。

## 3. 状態と事象

### 3.1 乗車の状態

```
 (作成) ─▶ payment_pending ──与信の成功──▶ requested ◀────────────────────┐
              │ 与信の失敗・時間切れ          │ 提案（配車）                     │ 辞退・時間切れ・
              ▼                              ▼                               │ ドライバーの取り消し（再配車）
         payment_failed                   offered ────────────────────────────┤
                                             │ 受諾                           │
                                             ▼                               │
                                          accepted ─出発─▶ arriving ─到着─▶ arrived
                                                                              │ 乗車の開始
                                                                              ▼
                                            awaiting_fare ◀──降車（額が未定）── on_trip ─┐ 区間の分割
                                                 │ 額の確定                         │ ◀──┘
                                                 ▼                                 │ 降車（額が確定）
                                             completed ◀────────────────────────────┘

 終端：completed、cancelled_by_rider、cancelled_by_driver、cancelled_by_system、no_driver_found、no_show、payment_failed
```

- [ADR-0003](../decisions/0003-trip-state-and-single-assignment.md) の状態に、`payment_pending`・`awaiting_fare`・`cancelled_by_system`・`payment_failed` を加えた。
  - `payment_pending`：アプリの決済では、与信が通るまで配車しない（[payments-and-payouts.md](payments-and-payouts.md) の 4 節）。車内で払う乗車はこの状態を飛ばす。
  - `awaiting_fare`：降車の後、メーターの額が届かないか保留（[pricing-and-fares.md](pricing-and-fares.md) の DT-FARE-004）のとき。**ドライバーはこの状態で割り当てから外れ、次のオファーを受けられる。**
- 乗車の状態とは別に、ドライバーの側の割り当ての状態を `driver_assignments.status` に持つ（4 節）。

### 3.2 事象

| 事象 | 出し手 | 中身 |
| --- | --- | --- |
| `create` | 乗客 | `client_request_id`、見積もり、乗車地・降車地、決済の方法、日本版ライドシェアの承諾 |
| `authorization_succeeded` / `authorization_failed` | Payments（outbox） | 与信の ID |
| `propose` | 配車 | `driver_id`、`region_gen` と `assignment_epoch`（索引から読んだ値）、`vehicle_id`、`batch_id`、`trip_version`、迎車の ETA |
| `offer_delivered` | ドライバーのアプリ（オファーを受け取った時） | `offer_id`（= `assignment_id`） |
| `accept` / `decline` | ドライバー | `offer_id`（= `assignment_id`）、`assignment_epoch`、辞退の理由（`street_hail` を含む） |
| `depart` | ドライバー（受諾の直後にアプリが自動で送る） | 同上 |
| `arrive` / `start_trip` / `segment_split` / `end_trip` | ドライバー | 同上と、発生の時刻、位置（格子のセルに丸めない正確な値は乗車の記録にだけ置く）、`end_trip` はメーターの額か事前確定の確認 |
| `fare_confirmed` | Pricing（メーターの額の受け取り・保留の確認の後） | 確定の額と `meter_readings` の ID |
| `rider_cancel` | 乗客 | 理由 |
| `driver_cancel` | ドライバー | 理由のコード（安全・乗客の迷惑行為・車の故障・その他） |
| `mark_no_show` | ドライバー | 到着の地点の近くにいること |
| `system_cancel` | 運用・安全の担当 | 理由と担当の ID |
| `timer_fired` | タイマーの処理（6 節） | 種類と、設定した時の `trip_version` |

### 3.3 遷移の表（DT-TRIP-001）

上から評価し、最初に一致した行を使う。表にない（状態、事象）は拒否し、今の状態を返す。

| # | 今の状態 | 事象 | 条件 | 次の状態 | 副作用 |
| --- | --- | --- | --- | --- | --- |
| 1 | （なし） | `create` | 同じ `client_request_id` の乗車がある | 変わらない | 既存の乗車を返す |
| 2 | （なし） | `create` | 乗客に有効な乗車がない、見積もりが有効、決済が `app` | `payment_pending` | 与信の要求（outbox）、タイマー `authorization`（30 秒） |
| 3 | （なし） | `create` | 同上、決済が `in_vehicle`（タクシーだけ） | `requested` | タイマー `dispatch_deadline`（3 分）、配車のキューへ |
| 4 | `payment_pending` | `authorization_succeeded` | | `requested` | タイマー `dispatch_deadline` |
| 5 | `payment_pending` | `authorization_failed`・`timer_fired(authorization)` | | `payment_failed` | 乗客に知らせる |
| 6 | `requested` | `propose` | 4.3 節の検査にすべて通る | `offered` | 割り当て（= オファー。`offer_id` は割り当ての ID）を作る（epoch を増やす）、タイマー `offer_delivery`（5 秒）と `offer_expiry`（16.5 秒） |
| 7 | `requested` | `propose` | 検査に通らない | 変わらない | 拒否の理由を配車に返す |
| 7a | `offered` | `decline`・`timer_fired(offer_expiry)`・`timer_fired(offer_delivery)` | この乗車のオファーが 10 回目 | `no_driver_found` | 割り当てを解放（epoch を増やす）、与信の取り消し（[dispatch-and-matching.md](dispatch-and-matching.md) の 8.1 節） |
| 7b | `offered` | `offer_delivered` | 同じ割り当て | 変わらない | 受信の時刻を記録し、タイマー `offer_delivery` を取り消す |
| 7c | `offered` | `timer_fired(offer_delivery)` | 受信の確認がない | `requested` | 割り当てを `undelivered` で解放（epoch を増やす）。ドライバーの罰則にしない |
| 8 | `offered` | `accept` | 割り当てが `offered`、epoch が一致、期限の前 | `accepted` | 迎車の約束の時刻を記録 |
| 9 | `offered` | `accept` | それ以外 | 変わらない | 「このオファーは無効」を返す |
| 10 | `offered` | `decline`・`timer_fired(offer_expiry)` | 同じ割り当て | `requested` | 割り当てを `declined`・`expired` で解放（epoch を増やす）。時間切れが 2 回続いたドライバーは、供給の側に自動の休憩を求める事象を出す（[dispatch-and-matching.md](dispatch-and-matching.md) の 8.3 節） |
| 11 | `requested`・`offered` | `timer_fired(dispatch_deadline)` | | `no_driver_found` | 割り当てがあれば解放、与信の取り消し |
| 12 | `accepted` | `depart` | | `arriving` | |
| 13 | `accepted`・`arriving` | `arrive` | | `arrived` | タイマー `no_show_eligible`（既定 300 秒） |
| 14 | `accepted`・`arriving`・`arrived` | `start_trip` | | `on_trip` | `arrive` がなければ同時に記録する |
| 15 | `on_trip` | `segment_split` | 事前確定の乗車 | `on_trip` | 区間を閉じ、次の区間をメーターで始める（[pricing-and-fares.md](pricing-and-fares.md) の 7 節） |
| 16 | `on_trip` | `end_trip` | 額が確定している（事前確定、連携のメーター、照合に通った入力） | `completed` | 割り当てを完了（epoch を増やす）、売上の確定の要求 |
| 17 | `on_trip` | `end_trip` | 額が未定か保留 | `awaiting_fare` | 割り当てを完了（epoch を増やす）、タイマー `fare_escalation`（10 分） |
| 18 | `awaiting_fare` | `fare_confirmed` | | `completed` | 売上の確定の要求 |
| 19 | `awaiting_fare` | `timer_fired(fare_escalation)` | | 変わらない | 運用に知らせる（24 時間まで繰り返す） |
| 20 | `payment_pending`〜`arrived` | `rider_cancel` | | `cancelled_by_rider` | 割り当てがあれば解放（`offered` なら `revoked` にし、ドライバーに `OfferRevoked` を配る）、DT-TRIP-002 でキャンセル料 |
| 21 | `accepted`・`arriving`・`arrived` | `driver_cancel` | 理由が「安全」「乗客の迷惑行為」 | `cancelled_by_driver` | 割り当てを解放、乗客への料金なし、安全の担当へ |
| 22 | `accepted`・`arriving`・`arrived` | `driver_cancel` | それ以外で、`dispatch_deadline` の前 | `requested` | 割り当てを `driver_cancelled` で解放し、優先して再配車（流しの客を乗せるための取り消しもこの行。[dispatch-and-matching.md](dispatch-and-matching.md) の 7 節） |
| 23 | `accepted`・`arriving`・`arrived` | `driver_cancel` | それ以外で、期限の後 | `no_driver_found` | 割り当てを解放、与信の取り消し |
| 24 | `arrived` | `mark_no_show` | `no_show_eligible` が過ぎ、ドライバーが乗車地の 200 m 以内 | `no_show` | 割り当てを解放、DT-TRIP-002 で無断キャンセルの料金 |
| 25 | `arrived` | `mark_no_show` | それ以外 | 変わらない | 理由を返す |
| 26 | 終端以外 | `system_cancel` | | `cancelled_by_system` | 割り当てがあれば解放、料金なし、与信の取り消し |
| 27 | 何でも | `timer_fired(k)` | 設定した時の `trip_version` と今の版が違う、または状態が k に関係しない | 変わらない | タイマーを `fired` にするだけ |
| 28 | 終端 | 何でも | | 変わらない | 遅れて届いたドライバーの操作は 8.4 節 |

- `on_trip` の乗車は、乗客の取り消しで終えない。運用が `system_cancel` で終える（事故・トラブル）。
- `completed` は乗車の終わりで、支払いの終わりではない。支払いの状態は Payments が持つ。
- 迎車の間に、ドライバーが動かない・位置が途絶えるときの扱いは、状態を変えずに運用と安全の担当に知らせる（`safety-and-trust.md`）。
- 到着・無断キャンセル（7.1 節）の位置の判定は、索引の `GetDriverLocation`（[geospatial-index.md](geospatial-index.md) の 6.5 節）で最新の位置を読んで行う。位置の Valkey の写しは持たない（geospatial-index の 5.4 節）。
- 行 22 のとおり、流しの客を乗せるためのドライバーの取り消しを含め、理由が安全・迷惑行為でない取り消しは再配車に戻り、終端にならない。

## 4. 割り当てと `assignment_epoch`（[ADR-0021](../decisions/0021-trip-transition-function-and-assignment-fencing.md)）

### 4.1 表

```sql
driver_dispatch_state (driver_id uuid PRIMARY KEY,
                       region_gen bigint NOT NULL,                   -- 最後に epoch を増やした時の世代（ADR-0039）
                       assignment_epoch bigint NOT NULL DEFAULT 0,  -- 単調に増える
                       active_assignment_id uuid,                    -- 有効な割り当て（なければ NULL）
                       updated_at)

driver_assignments (id uuid PRIMARY KEY,           -- = offer_id。オファーの記録を兼ねる（旧案の trip_offers）
                    trip_id uuid NOT NULL, driver_id uuid NOT NULL,
                    vehicle_id uuid NOT NULL, operator_id uuid NOT NULL, driver_session_id uuid NOT NULL,
                    service_kind,                  -- 'taxi' | 'rideshare'
                    region_gen bigint NOT NULL,    -- 作成の時の世代
                    assignment_epoch bigint NOT NULL,   -- 作成の時の epoch（作成で増やした後の値）
                    status,                        -- 'offered' | 'accepted' | 'arriving' | 'arrived' | 'on_trip'
                                                   -- | 'declined' | 'expired' | 'undelivered' | 'revoked' | 'released'
                                                   -- | 'driver_cancelled' | 'completed' | 'no_show'
                    decision_id,                   -- 配車の判断の ID（<zone>/<batch_id>）
                    pickup_eta_s, eta_source,      -- 提案の時の迎車の ETA とその出どころ
                    offer_expires_at,              -- 作成 + 16.5 秒
                    delivered_at,                  -- OfferDelivered を Trips が記録した時刻
                    delivery_channel,              -- 'stream' | 'push' | 'api'（OfferDelivered が届いた経路）
                    shown_elapsed_ms,              -- 端末で受信から表示までの時間（OfferDelivered の値）
                    decline_reason,                -- 'driver' | 'street_hail' | ...
                    pickup_eta_s_at_accept, promised_arrival_at,
                    created_at, accepted_at, ended_at, end_reason)

CREATE UNIQUE INDEX one_active_assignment_per_driver ON driver_assignments (driver_id)
  WHERE status IN ('offered','accepted','arriving','arrived','on_trip');
CREATE UNIQUE INDEX one_active_assignment_per_trip ON driver_assignments (trip_id)
  WHERE status IN ('offered','accepted','arriving','arrived','on_trip');
```

- `driver_assignments` はオファーの記録を兼ね、`offer_id` はこの表の `id` である。dispatch-and-matching が `trip_offers` として提案した表は作らず、その列（`decision_id`、`pickup_eta_s`、`eta_source`、`delivered_at`、結果、`decline_reason`）と、オファーの配信の列（`delivery_channel`、`shown_elapsed_ms`）をこの表に持つ。オファーの結果（受諾・辞退・時間切れ・取り下げ・届かない）は `status` で表す。試したドライバーの一覧も、この表の終わった行から求める（統合の決定。[data-model.md](data-model.md) の 10 節）。
- 2 つの部分一意索引が最後の砦である（NFR-005）。遷移関数に不具合があっても、2 つ目の有効な割り当てのコミットは失敗する。
- `driver_dispatch_state` は Trips が持つ。ドライバーの本体（`drivers`）は供給の領域が持つ（[supply-and-operators.md](supply-and-operators.md)）。行がなければ、提案のトランザクションで `INSERT ... ON CONFLICT DO NOTHING` で作る（epoch 0）。

### 4.2 epoch の増やし方

| 操作 | epoch | 理由 |
| --- | --- | --- |
| 割り当ての作成（`propose` の成功） | +1 | 提案に使った索引の写しが古ければ、ここで拒否できる |
| 受諾・出発・到着・乗車の開始 | 変えない | 同じ割り当ての中の進み。順序は `trip_version` で決まる |
| 解放（辞退・時間切れ・取り消し・無断キャンセル・完了） | +1 | 解放の前の epoch を持つ古い受諾や古い提案を拒否する |

- 索引は、ドライバーごとの `(region_gen, assignment_epoch, trip_version)` の辞書順で新しい事象だけを適用する（[geospatial-index.md](geospatial-index.md) の 4.2 節）。上の増やし方で、この順序が割り当ての実際の順序と一致する。
- ドライバーのアプリの操作は、すべて `(trip_id, assignment_id, region_gen, assignment_epoch)` を付ける。割り当ての `(region_gen, assignment_epoch)` と一致しなければ拒否する。

**世代（`region_gen`）**（[ADR-0039](../decisions/0039-city-cells-and-osaka-warm-standby.md)）：

- `region_gen` は、大阪への切り替え（と戻し）のたびに 1 上がる AppConfig の値である。Trips は、epoch を増やすトランザクションで今の `region_gen` を `driver_dispatch_state` と `driver_assignments` に書く。
- epoch の比較と一致の検査は、つねに `(region_gen, assignment_epoch)` の辞書順で行う。切り替えで複製されなかった epoch の増分と同じ値が新しいリージョンで再び使われても、世代が違うので古い操作・古い提案と取り違えない。
- 切り替えの後、`driver_dispatch_state.region_gen` が今の世代より小さい行は、最初の epoch の操作（作成・解放・復元）のときに今の世代で書き直す。epoch の値はそのまま続けて増やす（0 に戻さない）。比較は `(region_gen, assignment_epoch)` の辞書順なので、戻しても戻さなくても正しさは同じである。戻さないのは、ログ・監査・再生で同じドライバーの epoch の値が世代をまたいで重複せず、読み違えを減らせるため（2026-09-28 に確定）。
- 復元した割り当て（8.5 節）は、今の世代で epoch を 1 増やして結び直し、新しい `(region_gen, assignment_epoch)` をドライバーのアプリに返す。アプリは以後その組を付けて送る。

### 4.3 提案の検査（`propose`）

1 つのトランザクションで、次をこの順に行う。

1. 乗車の行を `FOR UPDATE` で取る。状態が `requested` で、提案の `trip_version` が今の版と一致すること。
2. ドライバーの `driver_dispatch_state` を `FOR UPDATE` で取る。`(region_gen, assignment_epoch)` が提案の値と一致し、`active_assignment_id` が NULL であること。
3. ドライバーが、この乗車で辞退・時間切れ・取り下げになっていないこと（`driver_assignments` の終わった行から求める）。
4. 供給の条件（同じ Aurora の表を読む）：
   - ドライバーのセッションがオンラインで、`driver_session_id` が提案と一致する。
   - ドライバーと車両が有効（書類の期限の内、停止されていない）。
   - 事業者が、乗車の価格の群（[pricing-and-fares.md](pricing-and-fares.md) の 5.3 節）に入っている。
   - 乗車地か降車地が、事業者の営業区域の中にある。降車地のない依頼は乗車地が中にある（乗車の作成の時に [maps-and-geodata.md](maps-and-geodata.md) の 9.3 節で求めた営業区域の ID で判定する）。
   - `service_kind = rideshare` なら、乗客が日本版ライドシェアを承諾し、運賃が事前確定で、決済が `app` で、降車地が決まっていて、オファーの時刻と迎車の到着の見込みがともに事業者の運行枠の中にある（[supply-and-operators.md](supply-and-operators.md) の 6 節、[dispatch-and-matching.md](dispatch-and-matching.md) の 5 節の E1・E5）。
5. 割り当てを `offered` で作り、epoch を 1 増やし、`active_assignment_id` を入れ、乗車を `offered` にし、タイマーを入れ、outbox に書く。

- 配車の側も同じ条件で候補を絞る（[dispatch-and-matching.md](dispatch-and-matching.md) の 5 節）。**Trips は提案の時に、供給・営業区域・運行枠の条件を確かめ直す**（2026-09-27 の決定。[architecture/README.md](README.md) の 7 節）。ここでの検査は、索引の写しの古さに対する最後の確かめである。条件の判定は、配車（Go）と Trips（TypeScript）で同じ版のデータを読み、共通の決定表のテストのベクター（dispatch の 12.2 節の DT-DISP-001。`vectors/eligibility/`）を両方の CI で通して、2 つの実装の食い違いを防ぐ。条件の正本は配車の関数とし（[ADR-0014](../decisions/0014-dispatch-eligibility-and-street-hails.md)）、Trips の確かめ直しは防御である。
- 検査に落ちた提案は、`ProposeOfferResponse.rejected`（`EPOCH_MISMATCH`、`TRIP_STATE_CHANGED`、`DRIVER_NOT_AVAILABLE`、`NOT_ELIGIBLE`、`CONSTRAINT_VIOLATION`）で配車に返す。供給・営業区域・運行枠の条件に落ちたときが `NOT_ELIGIBLE` である。配車はそのドライバーを次のバッチから除くか、索引の更新を待つ。

### 4.4 ロックの順序

- どの遷移も、**乗車の行 → ドライバーの `driver_dispatch_state` の行** の順でロックする。デッドロックを避けるため、逆の順は使わない。
- 受諾の要求はドライバーから来るが、先に割り当てから `trip_id` を読み（ロックなし）、乗車の行からロックする。
- 1 つのトランザクションで 2 つの乗車の行をロックしない。

### 4.5 一意性の検査（本番）

- 1 分ごとに、有効な割り当てがドライバーごと・乗車ごとに 2 つ以上ないかを問い合わせる。部分一意索引があるので 0 件のはずで、1 件でも SEV1 とする（[ADR-0003](../decisions/0003-trip-state-and-single-assignment.md)）。
- `driver_dispatch_state.active_assignment_id` と、有効な割り当ての行の食い違いも同じ検査で探す。食い違いは SEV2 とし、割り当ての行を正として直す手順を runbook に書く。

## 5. 遷移関数

### 5.1 形

```ts
// 純粋な部分：DB を触らない。時刻は引数。
function decide(trip: TripSnapshot, driverState: DriverDispatchSnapshot | null,
                event: TripEvent, ctx: { now: Instant; rules: CancelRules; eligibility: Eligibility })
  : { next: TripState; assignmentOps: AssignmentOp[]; timers: TimerOp[];
      outbox: OutboxEvent[]; reply: Reply } | { reject: RejectReason; reply: Reply };

// 書き込みの部分：1 つのトランザクション。
async function apply(cmd: TripCommand): Promise<Reply> {
  // 1. trip_commands で command_id を確かめ、あれば前の結果を返す
  // 2. 乗車 → ドライバーの順にロック
  // 3. decide を呼ぶ
  // 4. 乗車の行を version の一致を条件に更新、割り当て・タイマー・trip_events・outbox・trip_commands を書く
  // 5. コミット
}
```

- 状態を変える書き込みは、この `apply` だけが行う。他のコードから `trips.state` や `driver_assignments.status` を更新するのは、lint とレビューで禁止し、DB のロールの権限でも止める（Trips のサービスのロールだけが更新できる）。
- `decide` の表は 3.3 節で、表駆動テストが `spec.md` の表を直接読む。モバイルの 2 つのアプリも、同じ表から作ったテストのベクターで状態の解釈を確かめる（[ADR-0001](../decisions/0001-platform-and-stack.md)）。
- 時刻は DB の `clock_timestamp()` を 1 回読んで `ctx.now` に渡す。タスクごとの時計のずれで期限の判定が変わらないようにする。

### 5.2 冪等

```sql
trip_commands (trip_id uuid, command_id uuid, command_type, result jsonb, created_at,
               PRIMARY KEY (trip_id, command_id))
```

- アプリとサービスの要求は、すべて `command_id`（送り手が作る UUID）を持つ。同じ `command_id` の 2 回目は、前の結果を返す。
- 乗車の作成は、`(rider_id, client_request_id)` の一意の制約で冪等にする。
- 保持は 30 日。

### 5.3 乗客ごとの有効な乗車

```sql
CREATE UNIQUE INDEX one_active_trip_per_rider ON trips (rider_id)
  WHERE state IN ('payment_pending','requested','offered','accepted','arriving','arrived','on_trip');
```

- 乗客は、同時に 1 つの乗車だけを依頼できる。`awaiting_fare` は含めない（降りた後に次を呼べる）。

## 6. タイマー

```sql
trip_timers (id bigserial PRIMARY KEY,
             trip_id uuid NOT NULL,
             kind,               -- 'authorization' | 'dispatch_deadline' | 'offer_delivery' | 'offer_expiry' | 'no_show_eligible' | 'fare_escalation'
             due_at timestamptz NOT NULL,
             set_at_version bigint NOT NULL,
             status,             -- 'pending' | 'fired' | 'cancelled'
             fired_at)
CREATE INDEX trip_timers_due ON trip_timers (due_at) WHERE status = 'pending';
```

| 種類 | 期限（既定） | 設定 | 時間切れの遷移 |
| --- | --- | --- | --- |
| `authorization` | 作成から 30 秒 | `payment_pending` | `payment_failed` |
| `dispatch_deadline` | 与信の成功から 3 分（[ADR-0004](../decisions/0004-batched-dispatch-and-offers.md)） | `requested` | `no_driver_found` |
| `offer_delivery` | オファーから 5 秒 | `offered` | 受信の確認がなければ `requested`（`undelivered`） |
| `offer_expiry` | オファーから 16.5 秒（アプリの表示は 15 秒、配信と送信の遅れの猶予 1.5 秒。[dispatch-and-matching.md](dispatch-and-matching.md) の 8.2 節） | `offered` | `requested`（割り当ての解放） |
| `no_show_eligible` | 到着から 300 秒（事業者の規則） | `arrived` | 状態は変えない。ドライバーのアプリの「無断キャンセル」を押せるようにする事象を配る |
| `fare_escalation` | `awaiting_fare` から 10 分、以後 1 時間ごと | `awaiting_fare` | 状態は変えない。運用に知らせる |

- タイマーは、状態の遷移と同じトランザクションで入れる。状態が変わったら、同じトランザクションで古いタイマーを `cancelled` にする。
- 処理のタスク（Trips のサービスの中、2 つ以上）は 200 ms ごとに、期限の来た行を `ORDER BY due_at LIMIT 200 FOR UPDATE SKIP LOCKED` で取り、1 行ずつ `apply(timer_fired)` を呼ぶ。行の処理は冪等（3.3 節の行 27）。
- 遅れの予算：期限から遷移のコミットまで p99 1 秒。監視は「最古の `pending` の期限切れの行の経過時間」。5 秒を超えたら SEV2。
- `fired`・`cancelled` の行は 7 日で消す。
- オファーの時間切れの判定は、タイマーを待たずに `accept` の検査でも行う（`offer_expires_at` を過ぎた受諾は拒否）。タイマーの遅れで古い受諾が通らないようにする。

## 7. 取り消しとキャンセル料

### 7.1 乗客の取り消し（DT-TRIP-002）

規則の値は、乗車の価格の群の `cancellation_fee_rules`（[pricing-and-fares.md](pricing-and-fares.md) の 4.3 節）から取る。

| # | 状態 | 受諾からの経過 | ドライバーが遅れている（今 > 約束の到着 + 閾値） | 結果 |
| --- | --- | --- | --- | --- |
| 1 | `payment_pending`・`requested`・`offered` | - | - | 無料。与信を取り消す |
| 2 | `accepted`・`arriving` | ≦ 猶予（120 秒） | - | 無料 |
| 3 | `accepted`・`arriving` | > 猶予 | はい | 無料 |
| 4 | `accepted`・`arriving` | > 猶予 | いいえ | キャンセル料 |
| 5 | `arrived` | - | - | キャンセル料 |

**無断キャンセル（DT-TRIP-003）**

| # | 到着からの経過 | ドライバーが乗車地の 200 m 以内 | 結果 |
| --- | --- | --- | --- |
| 1 | < 待ち（300 秒） | - | 拒否 |
| 2 | ≧ 待ち | いいえ | 拒否（乗車地へ戻るよう返す） |
| 3 | ≧ 待ち | はい | `no_show`。無断キャンセルの料金 |

- 「約束の到着」は、受諾の時点で乗客に示した迎車の ETA（[eta-and-routing.md](eta-and-routing.md) の 4.2 節の `pickup_at_accept`）から求めた `promised_arrival_at`。
- 200 m の判定は、Trips が索引の `GetDriverLocation(driver_id, trip_id)`（[geospatial-index.md](geospatial-index.md) の 6.5 節）で最新の位置を読んで行う。位置が 15 秒より古いときは、ドライバーのアプリが送った位置で判定し、その旨を記録する。
- キャンセル料の請求は Payments が行う（[payments-and-payouts.md](payments-and-payouts.md) の 5.4 節）。料金の受け手が事業者かドライバーか、料金の法的な名目（運送約款の料金か）は、法務の確認待ち（L2・L8）。
- 取り消しの多い乗客への警告や利用の停止は、`safety-and-trust.md` と `support-and-operations-tools.md` で扱う。

### 7.2 ドライバーの取り消し

- 乗客に料金はかからない。乗車は再配車に戻る（3.3 節の行 22）。
- 取り消しの回数は、ドライバーと事業者ごとに記録し、事業者の管理画面に出す。この基盤からドライバーへの罰則は付けない。ドライバーの管理は事業者の責任で、労働の位置づけ（L5）にも関わるため。

## 8. outbox と、通信が切れたときの継続（[ADR-0022](../decisions/0022-trip-outbox-and-offline-continuation.md)）

### 8.1 outbox

```sql
outbox_events (id bigserial PRIMARY KEY,
               aggregate_type,       -- 'trip' | 'driver_assignment'
               aggregate_id uuid,
               event_type,           -- 'trip.state_changed' | 'driver.assignment_changed' | 'trip.fare_finalized' | ...
               payload bytea,        -- Protocol Buffers
               created_at, published_at)
```

- 状態の変化は、同じトランザクションで outbox に書く。Slack の題材の [ADR-0002](../../../slack/docs/decisions/0002-db-as-source-of-truth-with-outbox.md) と同じ考え方。
- 中継のタスク（2 つ以上）は、未配信の行を `ORDER BY id FOR UPDATE SKIP LOCKED` で取り、SNS の標準のトピック `trips-events` に書き、`published_at` を入れる。コミットの通知（`LISTEN/NOTIFY`）で起き、通知がなくても 50 ms ごとに見る。
- SNS から、購読する側ごとの SQS に配る：索引（[geospatial-index.md](geospatial-index.md)）、配車、Payments、リアルタイムの配信、運賃の水準の集計、分析。
- **届け方は少なくとも 1 回で、順序は保証しない。** 購読する側は、版で古い事象を捨てる。
  - `trip.state_changed`：`(trip_id, trip_version)`
  - `driver.assignment_changed`：`(driver_id, region_gen, assignment_epoch, trip_version)` と、索引が使う `TripAssignState`（`NONE`・`OFFERED`・`ACCEPTED`・`ARRIVING`・`ARRIVED`・`ON_TRIP`）
- 配信済みの行は 3 日で消す。未配信の最古の行の経過時間を監視する（2 秒を超えたら警告。NFR-008 の予算を食うため）。

### 8.2 乗車の要約

- 乗車に関わるすべての応答と、リアルタイムの配信の事象に、署名つきの乗車の要約（`TripSnapshot`）を付ける。中身は `trip_id`、`trip_version`、状態、`assignment_id`・`region_gen`・`assignment_epoch`、乗客と事業者とドライバーの ID、価格の群、見積もりの総額（事前確定なら）、乗車地・降車地（`street` に丸めた値）、発行の時刻。
- 署名は Ed25519。鍵は KMS で作り、Trips のサービスだけが署名できる。鍵の交代は `security.md` で扱う。
- アプリは最新の要約を端末に残す。障害の後の復元（8.5 節）に使う。

### 8.3 ドライバーのアプリの記録（journal）

通信が切れても、乗客を乗せて運び、降ろす操作はその場で進める。操作は端末の記録に残し、つながったら順に送る。

```proto
message TripCommand {
  string command_id = 1;            // UUID
  string trip_id = 2;
  string assignment_id = 3;
  uint64 assignment_epoch = 4;
  uint64 region_gen = 13;           // 割り当ての世代（ADR-0039）
  CommandType type = 5;             // ARRIVE / START_TRIP / SEGMENT_SPLIT / END_TRIP / DRIVER_CANCEL / MARK_NO_SHOW ...
  uint32 journal_seq = 6;           // 乗車の中で単調に増える
  string driver_session_id = 7;
  uint64 occurred_elapsed_ms = 8;   // セッションの単調時計（location-ingestion の 4.3 節）
  sint32 lat_e7 = 9; sint32 lng_e7 = 10;
  MeterReading meter = 11;          // END_TRIP・SEGMENT_SPLIT のとき
  uint32 passenger_count = 12;      // END_TRIP のとき。日本版ライドシェアの輸送人員の報告に使う（supply-and-operators の 6.6 節）
}
```

| 操作 | 通信が切れていてもできるか | 理由 |
| --- | --- | --- |
| 受諾 | いいえ | 割り当ての確定はサーバーでしか決まらない |
| 到着・乗車の開始・区間の分割・降車 | はい | 目の前の乗客を待たせない。運賃は事前確定の額かメーターの額で、端末が知っている |
| 無断キャンセル | いいえ | 待ちの時間と位置をサーバーで確かめ、料金が生じるため |
| ドライバーの取り消し | 記録はできるが、つながるまで確定しない | 再配車はサーバーが行う |

- サーバーは、発生の時刻を `anchor_server_time + (occurred_elapsed_ms − anchor_elapsed_ms)` で求める（出庫の時の基準点。[location-ingestion.md](location-ingestion.md) の 4.3 節と、[supply-and-operators.md](supply-and-operators.md) の `driver_sessions`）。受信の時刻より 2 秒以上未来、または前の遷移より前なら、発生の時刻を受信の時刻に置き換え、その旨を記録する。
- 乗車の記録（`trip_events`）には、発生の時刻と記録の時刻の両方を残す。運賃の時間帯の判定（深夜）と、事業者の日報には発生の時刻を使う。
- 送り直しは `journal_seq` の順に 1 件ずつ行い、前の応答を受けてから次を送る。同じ `command_id` は冪等（5.2 節）。

### 8.4 遅れて届いた操作と、今の状態の食い違い（DT-TRIP-004）

| # | 今の状態 | 届いた操作 | 結果 |
| --- | --- | --- | --- |
| 1 | 操作の前の状態（例：`arrived` に `START_TRIP`） | - | 通常どおり適用し、発生の時刻で記録 |
| 2 | すでに先の状態（例：`on_trip` に `ARRIVE`） | - | 何もしない（成功として返す） |
| 3 | `cancelled_by_rider`・`cancelled_by_system` | `START_TRIP`・`END_TRIP` | 状態は変えない。`trip_conflicts` に記録し、運用の確認に回す。キャンセル料の請求を保留する |
| 4 | `no_driver_found` | 同上 | 同上 |
| 5 | `completed` | `END_TRIP`（同じ額） | 何もしない |
| 6 | `completed` | `END_TRIP`（違う額） | `trip_conflicts` に記録し、運用の確認に回す |
| 7 | 割り当てが解放済み（epoch が違う） | 何でも | 3 と同じ |

- 終端の状態を、遅れて届いた操作で戻さない。戻すかどうかは人が決め、訂正は運賃の訂正と返金の手順（[payments-and-payouts.md](payments-and-payouts.md) の 6 節）で行う。
- 迎車の間と乗車の間に、サーバーの側のタイマーでドライバーの操作に当たる遷移（到着・乗車の開始・降車・無断キャンセル）を自動では起こさない。通信が切れたドライバーの乗車を、サーバーの推測で終えないためである。

### 8.5 障害の後の復元

- リージョンの障害で大阪へ切り替えると、直近（RPO 1 分以内、NFR-007）のコミットが失われうる。
- 復元：ドライバーのアプリは、つながった先のサーバーに最新の `TripSnapshot` と、要約より後の journal を送る。
  - 乗車の行があり、版が要約より古い：journal を 8.3 節のとおりに適用する。足りない遷移（要約にあって DB にない）は、要約の署名を確かめてから、`restored` の印を付けて記録する。
  - 乗車の行がない：要約の署名を確かめ、`restored` の印を付けて乗車と割り当てを作り直す。与信は Payments が PSP に照会して結び直す（[payments-and-payouts.md](payments-and-payouts.md) の 9 節）。
  - どちらの場合も、割り当ては今の `region_gen` で epoch を 1 増やして結び直し（4.2 節）、新しい `(region_gen, assignment_epoch)` を応答で返す。要約の古い世代の epoch を持つ操作は、以後すべて拒否される。
  - 結び直すドライバーに、今の世代で別の有効な割り当てがあれば（切り替えの後に新しいオファーを受けた）、部分一意索引で結び直しが失敗する。その乗車は `trip_conflicts` に記録し、運用が確かめる（二重の割り当てを作らない）。
- 復元した乗車は、すべて運用の確認の一覧に出す。
- 乗客のアプリも要約を持つが、復元には使わない（乗客は乗車を進める操作をしないため）。乗客のアプリは、つながったら今の状態を読み直す。

## 9. 障害のときの振る舞い

| 障害 | 振る舞い |
| --- | --- |
| Aurora の writer のフェイルオーバー（AZ の障害） | 数十秒、遷移が失敗する。アプリは同じ `command_id` で送り直す。タイマーの期限が過ぎたものは、復旧の後に順に処理する。オファーの時間切れは `accept` の検査でも止まる |
| 中継のタスクが止まる | outbox に溜まる。状態は失われない。アプリはポーリング（`GET /trips/{id}`）で今の状態を読める |
| SQS の購読する側が遅れる | 版で古い事象を捨てるので、追いついた後の結果は同じ |
| タイマーの処理が止まる | 監視で SEV2。オファーは `accept` の検査で守られるが、再配車が遅れる |
| 配車が止まる | `requested` の乗車は `dispatch_deadline` で `no_driver_found` になり、与信を取り消す |
| Payments が遅い | `payment_pending` が 30 秒で `payment_failed` になる。乗客のアプリは再試行を促す（同じ見積もりで、新しい `client_request_id`） |

## 10. セキュリティ

- 乗客・ドライバー・事業者・運用は、それぞれの ID と役割でだけ操作できる。ドライバーの操作は、トークンの `driver_id` と割り当ての `driver_id` の一致を確かめる。事業者の管理画面は、自分の事業者の乗車だけを読める（RLS）。
- 乗車地・降車地の正確な位置は、乗車の相手と、その乗車の間だけに見せる（[AGENTS.md](../../AGENTS.md)）。`TripSnapshot` には丸めた値だけを入れる。ログ・トレースには乗車の ID と セルに丸めた値だけを書く。
- `system_cancel` と、復元・食い違いの確認の操作は、理由の入力と監査ログを必須にする。
- `TripSnapshot` の署名の鍵は KMS の外に出さない。復元の経路は、署名の検証に失敗した要約を受けない。

## 11. テスト

### 11.1 決定表

- DT-TRIP-001（遷移の表）、DT-TRIP-002（乗客の取り消し）、DT-TRIP-003（無断キャンセル）、DT-TRIP-004（遅れて届いた操作）を、`spec.md` から読む表駆動テストにする。
- 否定の表：3.3 節にない（状態、事象）の組をすべて作り、すべて拒否され、DB が変わらないことを確かめる。

### 11.2 性質ベーステスト（fast-check、DB は Testcontainers の PostgreSQL）

- **PROP-TRIP-001（割り当ての一意）**：任意の順序・重複・並行の、提案・受諾・辞退・時間切れ・取り消し・配車のプロセスの切り替え（古い epoch の提案）の列の後で、どの時点でもドライバーごと・乗車ごとの有効な割り当ては高々 1 つ（[ADR-0003](../decisions/0003-trip-state-and-single-assignment.md) の Confirmation）。
- **PROP-TRIP-002（epoch の単調）**：任意の列（リージョンの切り替えで直近の epoch の増分を失わせる列を含む）で、ドライバーの `(region_gen, assignment_epoch)` は辞書順で減らず、解放の後・切り替えの前の古い組の操作はすべて拒否される（ADR-0039 の PROP-INFRA-001 と同じ性質を Trips の側で確かめる）。
- **PROP-TRIP-003（終端の不変）**：終端に入った乗車は、どんな事象の列の後も同じ状態のままである。
- **PROP-TRIP-004（冪等）**：任意の事象の列を、任意の要求を 2 回ずつ送り直した列に変えても、最後の状態と `trip_events` の内容は同じ。
- **PROP-TRIP-005（索引の収束）**：outbox の `driver.assignment_changed` を任意の順序・重複で索引の規則（辞書順で新しいものだけ）に適用した結果は、DB の最後の割り当ての状態と一致する。
- **PROP-TRIP-006（通信の切断）**：ドライバーの journal を任意の位置で切り、任意の遅れで送り直しても、乗客の取り消しがない列では、最後の状態と各遷移の発生の時刻は、切らない場合と同じ。
- **PROP-TRIP-007（乗客ごとの有効な乗車）**：任意の並行の作成の要求で、乗客ごとの有効な乗車は高々 1 つ。

### 11.3 障害注入

- 遷移のトランザクションの途中で接続を切り、同じ `command_id` の送り直しで二重の遷移が起きない。
- Aurora のフェイルオーバーの間に、オファーの時間切れと受諾を重ねる。
- 中継のタスクを止めて再開し、索引が追いつくまでの時間を測る。
- 大阪への切り替えの訓練で、直近の遷移を失わせ、journal と要約で復元できることを確かめる。

## 12. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E6 | `trip-state-machine-core` | 3 節の状態と遷移の表、`decide` と `apply`、`trip_events`、冪等（DT-TRIP-001、PROP-TRIP-003・004） |
| E6 | `assignment-fencing` | 4 節の表と部分一意索引、epoch、提案の検査、ロックの順序（PROP-TRIP-001・002） |
| E6 | `trip-timers` | 6 節の表と処理、遅れの監視 |
| E6 | `trip-outbox-relay` | 8.1 節、SNS・SQS、版による捨て方（PROP-TRIP-005）。E3 の索引と一緒に |
| E6 | `rider-cancellation-and-no-show` | 7 節（DT-TRIP-002・003）。料金の請求は E8 |
| E6 | `driver-journal-and-replay` | 8.3・8.4 節（DT-TRIP-004、PROP-TRIP-006）。E9 と一緒に |
| E6 | `trip-snapshot-and-restore` | 8.2・8.5 節の要約の署名と復元。E12 の大阪の訓練（`dr-drill`）で確かめる |
| E6 | `single-assignment-monitor` | 4.5 節の 1 分ごとの検査と SEV1 |
| E6 | `region-gen-assignment-compare` | 4.2 節の `(region_gen, assignment_epoch)` の比較（Trips・索引・アプリのベクター。infrastructure の Story と同じ） |
| E6 | `propose-eligibility-recheck` | 4.3 節の提案の時の条件の確かめ直しと `NOT_ELIGIBLE`、共通の決定表のベクター（dispatch の `dispatch-eligibility` と一緒に） |
| E5 | `dispatch-propose-contract` | 配車からの提案の形と拒否の理由のコード |
| E9 | `trip-app-test-vectors` | 3.3 節の表から作るモバイルのテストのベクター（apps の Story と同じ 1 つ） |
| E11 | `trip-conflict-review` | `trip_conflicts` と復元した乗車の確認の画面 |

## 13. 未解決の問い

### 決定（2026-09-27、既定案）

- **与信の前に配車しない**：`payment_pending` を置く。車内で払う乗車だけ飛ばす。
- **`awaiting_fare` でドライバーを解放する**：メーターの額の確認を待つ間に、ドライバーの稼働を止めない。
- **epoch は作成と解放で増やす**：進みでは増やさない。
- **ドライバーの取り消しは再配車に戻す**：安全・迷惑行為の理由のときだけ終端にする。
- **キャンセル料の猶予と待ち**：受諾から 120 秒、到着から 300 秒。事業者の規則で変えられる。
- **通信が切れたときに進められる操作**：到着・乗車の開始・区間の分割・降車。受諾と無断キャンセルは進めない。
- **配信**：SNS の標準のトピックと購読する側ごとの SQS。順序は版で扱う。リアルタイムの配信も S1 は SNS を経る（[notifications-and-realtime-push.md](notifications-and-realtime-push.md) の 5.1 節）。
- **提案の時の確かめ直し**：Trips は供給・営業区域・運行枠を確かめ直し、落ちたら `NOT_ELIGIBLE`。判定は配車と共通の決定表のベクターで揃える（4.3 節）。
- **世代**：割り当ての比較は `(region_gen, assignment_epoch)`（4.2 節、ADR-0039）。
- **位置の判定**：到着・無断キャンセルの位置は `GetDriverLocation` で読む。

### 決定（2026-09-28、推奨案で確定）

- **`region_gen` を上げても epoch は 0 に戻さない**：比較は組の辞書順なので正しさは同じで、世代をまたいで epoch の値が重ならず、ログと監査を読み違えにくい（4.2 節）。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| キャンセル料の受け手と名目（L2・L8） | E6 の着手の前に法務が確認する |
| 迎車の途中でドライバーが止まったときに、自動で再配車するか | 実績（止まった時間の分布）を見て E6 の後に決める |
| S3 の規模での Trips の DB の分け方（都市ごと） | infrastructure・capacity で決める |
| 予約の配車の状態（`scheduled`） | 予約の Epic で。[ADR-0003](../decisions/0003-trip-state-and-single-assignment.md) のとおり、長い流れは Temporal を検討する |

## 14. quality.md・runbooks・data-model への項目

### quality.md

- 二重の割り当ての件数（常に 0。4.5 節の検査）。
- 提案の拒否の割合と理由の内訳（`EPOCH_MISMATCH` が多ければ索引が遅れている。`CONSTRAINT_VIOLATION` は 0 件が目標）。
- オファーの受諾・辞退・時間切れの割合。
- タイマーの遅れの p99、outbox の配信の遅れの p95。
- journal の送り直しの件数、遅れて届いた操作の件数、`trip_conflicts` の件数と解決までの時間。
- 取り消しの割合（状態ごと）と、キャンセル料がかかった割合。

### runbooks

- `double-assignment.md`：4.5 節の検査が 1 件でも見つけたときの対応（SEV1）。配車の停止、割り当ての確かめ方、乗客とドライバーへの連絡。
- `trip-timer-lag.md`：タイマーの遅れの警告の確かめ方と、処理のタスクの増やし方。
- `outbox-backlog.md`：outbox の滞留の確かめ方（中継のタスク、SNS の制限）と、追いつかせ方。
- `trip-restore-after-failover.md`：大阪への切り替えの後の、復元した乗車と食い違いの確認の手順。
- `stuck-trips.md`：`awaiting_fare` や迎車のまま長く残る乗車の探し方と、`system_cancel` の判断。

### data-model（索引への追加の提案）

| 置き場所 | 中身 |
| --- | --- |
| Aurora `trips` | `id`（UUID v7）、`city_id`、`rider_id`、`client_request_id`、`state`、`version`、`service_request`（`taxi`・`taxi_or_rideshare`・`rideshare`）、`pricing_group_id`、`fare_quote_id`、`fare_type`、乗車地・降車地（乗客が確かめたピンだけ：`pickup_pin`・`dropoff_pin`（`lat_e7`・`lng_e7`、`origin=rider_confirmed_pin`）、`pickup_point_id`、乗降の地点を含む区域の `pickup_area_ids`・`dropoff_area_ids`（`service_areas.area_id` と版）。提供者の内容（`place_ref`、提供者の表示の名前・座標）は `trips` に置かず、提供者ごとの保存の期限を持つ `trip_place_refs`（[maps-and-geodata.md](maps-and-geodata.md) の 7.3 節、[ADR-0034](../decisions/0034-geocoding-provider-and-pickup-points.md)）に置く）、`rideshare_consented_at`、`upfront_notice_version`・`upfront_consented_at`、`payment_mode`、`payment_id`、`current_assignment_id`、各時刻、`terminal_reason`、`final_fare_yen`。一意：`(rider_id, client_request_id)`、5.3 節の部分一意索引 |
| Aurora `driver_dispatch_state`、`driver_assignments` | 4.1 節 |
| Aurora `trip_segments`（`trip_id`、`segment_no`、`fare_type`、開始・終了の時刻と位置） | 3.3 節の行 15 |
| Aurora `trip_events`（`trip_id`、`version`、`from_state`、`to_state`、`event_type`、`actor`、`occurred_at`、`recorded_at`、`command_id`、`restored`） | 追記のみ。月ごとのパーティション |
| Aurora `trip_commands` | 5.2 節（30 日） |
| Aurora `trip_timers` | 6 節 |
| Aurora `outbox_events` | 8.1 節（配信の後 3 日） |
| Aurora `trip_conflicts`（`trip_id`、`command`、`server_state`、`status`、`resolved_by`、`resolution`） | 8.4 節 |
| Protocol Buffers `TripCommand`、`TripSnapshot`、`TripStateChanged`、`DriverAssignmentChanged` | 8 節 |

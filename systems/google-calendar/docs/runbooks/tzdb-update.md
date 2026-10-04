# Runbook: tzdb のバージョンの採用と計算し直し

- Owner: Ops
- 対応するアラート: tzdb の新しいリリースの未採用、AppConfig の `tzdata.active_version` の不一致、古い `tzdata_version` の行が残る、再計算のジョブの遅れ、切り替えの窓が長い（[README.md](README.md) の 4 節）。定期作業：tzdb の更新の訓練
- 最終確認日: 2026-10-04

決定は [ADR-0002](../decisions/0002-time-representation.md)、[ADR-0012](../decisions/0012-tzdb-update-recompute-and-propagation.md)、[ADR-0049](../decisions/0049-tzdata-rollout-and-schema-change-ordering.md)、流れは [time-zones-and-holidays.md](../architecture/time-zones-and-holidays.md) の 6 節と [delivery.md](../architecture/delivery.md) の 6 節にある。

## 症状

- IANA の新しい tzdb のリリースが出た（`tzdata-watch` の PR、または未採用のアラート）。施行まで 7 日未満なら「急ぎ」の印。
- タスクの報告するバージョンが 2 種類以上で 5 分続く、または東京と大阪の `tzdata.active_version` が違う。
- 採用から 24 時間を過ぎて、古い `tzdata_version` の行が残る。
- 切り替えの窓（`tz_room_window_seconds`）が長い。

## 影響

施行の後の予定の時刻の誤り（NFR-009、K2）。会議室の偽の辞退・要確認の増加。差分の同期の量の増加（取り直しにはならない）。

## 確認

1. 差分の報告：変わるゾーンと区間 `[changed_from, changed_to)`、施行までの日数、影響する予定オブジェクトの数、会議室の予約の行の数、外部への `REQUEST` の見積もり。
2. リリースの署名：`tzdata-watch` が `.asc` の GPG の署名を確かめた記録（信頼する鍵の指紋は E3 で固定）。通っていなければ採用しない。
3. 進み具合のダッシュボード（[observability.md](../architecture/observability.md) の 7 節の tzdb）：`active` のバージョン、タスクの報告するバージョン、東京と大阪の一致、`tz_recompute_runs`、古いバージョンの行の数（`stale_tzdata_rows`）、要確認の会議室の数。

## 対処

### 採用

採用の判断は Dev と Ops が行う。エージェントは判断しない。

1. 差分の報告を見て採用を決める。`Asia/Tokyo` が変わるなど影響が大きいときは、施行の日と業務の時間を避けた計算し直しの時刻を決め、`ops.tzdata_recompute_rate` を計画する。
2. PR をマージし、`/tzdata/<version>/` を S3 に置き、新旧のバージョンを含むイメージをデプロイする（`active` は旧のまま。[deploy-and-rollback.md](deploy-and-rollback.md) の順）。全サービスが新しいイメージで健全なことを確かめる。
3. AppConfig の `tzdata.active_version` を新しいバージョンにする。東京と大阪の両方。Ops の承認。検証の関数が、イメージにないバージョンを拒否する。
4. 全タスクが新しいバージョンを 2 分続けて報告したら、`expander` が計算し直しを始める。順序は、会議室の予約の行と予約ページの区間 → 施行の近い順の予定オブジェクト。
5. **切り替えの窓**を見る（[ADR-0012](../decisions/0012-tzdb-update-recompute-and-propagation.md)）：窓の間、排他の制約は新旧のバージョンの区間を比べる。`room_needs_review` の通知の数と、`conflict_tz_pending` の辞退の数を見る。窓の終わりに、`conflict_tz_pending` の判定し直しが走り、残りが 0 になることを確かめる。
6. 外部への `REQUEST` の見積もりが 10 万通を超えるときは、送る前に Ops が承認する。iMIP の送信の上限の中で、施行の近い順に流す。
7. 古いバージョンの行（`stale_tzdata_rows`）が 0 になったら完了。Web のクライアントは API の `tzdata_version` で新しいバージョンのゾーンを取る（資産のデプロイは要らない）。
8. 30 日の後、古いバージョンをイメージから外す PR を出す。

### 急ぎの採用（施行まで 7 日未満）

- 凍結の期間でも、上の流れをそのまま行う。時間帯は平日 10〜15 時を守れなければ、IC を立てて行う。
- 施行まで 24 時間を切っても古いバージョンの行が残れば SEV2（[incident-response.md](incident-response.md)）。施行の後の誤りの数を数え、K2 の外の事象として記録する。

### 遅れたときの再実行

1. `ops.tzdata_recompute_rate` を上げる（1 カレンダーの書き込みの枠 `maintenance` の範囲で。混雑するカレンダーは枠で待つ）。
2. 止まったゾーン・テナントを絞って `tz-recompute` を再実行する（行ごとに `tzdata_version` を持つので、何度流しても結果は同じ）。
3. 会議室の予約の行が残っているなら、窓が続いている。予定オブジェクトより先に流す。

### バージョンの不一致

1. タスクの間で違う：AppConfig のポーリングの失敗か、イメージにバージョンがないタスク。古いイメージのタスクを入れ替える。
2. 東京と大阪で違う：両方に同じ値を当て直す。DR の切り替えの前に必ず合わせる（[disaster-recovery.md](disaster-recovery.md)）。

### 戻し

- `tzdata.active_version` を前のバージョンに戻す。計算し直しが、どちらの方向にも収束する（PROP-TZ-004）。デプロイは要らない。
- 戻した後も、切り替えの窓は同じ扱いになる。外部へ送った `REQUEST` は取り消さない（次の採用でまた送る）。

## エスカレーション

- 施行まで 24 時間を切って残りがある、会議室の要確認が多い（1 組織で 100 件を超える）：テックリードと PM。組織の管理者への連絡は PM が判断する。
- 署名が確かめられないバージョンを急ぎで採用する必要がある：セキュリティの担当と Dev の責任者の承認を得る。

## 事後

- 採用の記録（バージョン、施行の日、窓の長さ、計算し直しの時間、外部への送信の数、要確認の数）を残す。
- `Asia/Tokyo` の最悪の量での窓の長さは、E12 の `tzdata-update-drill` と半年ごとの訓練で測り、[ADR-0012](../decisions/0012-tzdb-update-recompute-and-propagation.md) の見積もりを直す。

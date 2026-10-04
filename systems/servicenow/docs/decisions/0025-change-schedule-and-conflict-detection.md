---
status: accepted
date: 2026-09-28
---

# ADR-0025: 禁止期間と保守の時間帯はカレンダーと同じ区間の表現で CI の条件に結び付けて持ち、衝突は純粋な関数で求める。禁止期間と凍結期間だけを実施の妨げにし、ほかの衝突は警告にする

詳細は [itsm-processes.md](../architecture/itsm-processes.md) の 9 節。

## Context

変更の予定は、禁止期間（凍結期間を含む）、保守の時間帯、同じ CI・関係する CI の他の変更、担当者の他の予定とぶつかりうる。日本の企業は、年末年始・期末・決算の前後に変更を止める。

本家の衝突の検知は、CI がすでに予定済み、親・子の CI が予定済み、保守の時間帯の外、禁止期間の中、担当者が予定済み、を調べ、CI と予定の時刻が入ったとき・変わったとき・状態が変わったときに動く（[Conflict detection](https://www.servicenow.com/docs/r//washingtondc/it-service-management/change-management/c_ConflictDetection.html)、2026-09-28 に確認）。次の空きの探索は 90 日・100 件、衝突の件数の上限は 1,000 が既定である（[Detect change conflicts](https://www.servicenow.com/docs/r/it-service-management/change-management/configure-conflict-properties.html)、2026-09-28 に確認）。禁止期間と保守の時間帯は、CI のクラスや動的な CI の群に結び付けたスケジュールで、上流のサービス・CI に付けたものは下流の CI にも効く（[Create blackout and maintenance schedules](https://www.servicenow.com/docs/r/it-service-management/change-management/t_CreateBlkoutMaintSched.html)、2026-09-28 に確認）。

本システムは、業務時間を半開区間の列で表す純粋な関数を持つ（[ADR-0019](0019-business-calendar-and-pure-time-functions.md)）。

## Options

### 時間帯の表現

1. **カレンダーのバージョンと同じ半開区間の表現を使い、CI の条件（式）に結び付ける**
2. 時間帯ごとに開始と終わりの時刻の行を並べる、専用の表現

### 衝突の強さ

- a. **禁止期間と凍結期間だけを blocking にし、ほかを警告にする。blocking は例外の承認で警告に下げられる**
- b. すべての衝突を blocking にする
- c. すべてを警告にする（本家に近い）

### 並行の予定

- x. **CI の重なりは非同期の計算し直しで後から両方に付ける**
- y. CI ごとの行のロックで、同じ CI の予定の保存を直列にする

## Decision

1、a、x を採用する。

- `change_window(kind: blackout | maintenance, calendar_id, ci_condition, scope: ci | tenant_wide, applies_to_types)`。凍結期間は `tenant_wide` の禁止期間。
- `conflicts(change, ctx)` を純粋な関数にし、呼ぶ側が時間帯の区間・関係の近傍（深さ 1）・予定の重なる他の変更を集める。
- 種類と重さは DT-CONF-001。通常・標準の変更で、禁止期間・凍結期間の重なりは `blocking`。緊急の変更は警告として記録する。
- `blocking` の変更は、`blackout_exception` の承認で警告に下げる。例外は変更のバージョンと衝突のハッシュに結び、予定の変更で無効になる。
- 評価は、予定・CI・担当者の変更の保存と、`assess`・`schedule`・`implement` への遷移の時に同期で行う。他の変更や時間帯の変更による影響は、outbox からの非同期のジョブで計算し直す。
- 区間は半開区間で比べ、連続する変更は重ならない。衝突は 1 つの変更で 1,000 件まで。

2 を採らない理由：繰り返し（毎週の保守の時間帯）、タイムゾーン、祝日（祝日は保守を禁止する、など）を別に作ることになる。カレンダーの関数と性質ベーステストを共有できない。

b を採らない理由：同じ CI の複数の変更を同じ保守の時間帯にまとめる運用（よくある）が、すべて止まる。

c を採らない理由：凍結期間の変更の禁止は、顧客の統制の要件である。警告だけでは、承認者の見落としで実施に進む。

y を採らない理由：大きな CI（共有のストレージなど）の変更の保存が直列になる。CI の重なりは警告なので、後から知らせることで足りる。blocking は時間帯だけで決まり、他の変更の保存に左右されないので、並行でも見落とさない。

## Consequences

- 良くなること：
  - 凍結期間の禁止が遷移の条件として強制される。
  - 衝突の判定が純粋な関数で、性質ベーステストで確かめられる。
- 引き受けるコスト：
  - 同じ CI の予定の重なりの警告は、並行の保存では数秒遅れて付く。
  - 親・子の深さを 1 段に限るので、深い依存の衝突は見えない（影響の範囲の走査は別に行う）。

## Confirmation

- 決定表 DT-CONF-001。
- 性質ベーステスト PROP-CONF-001（対称と単調）、PROP-CONF-002（blocking は時間帯だけで決まる）。
- lint：衝突の関数のモジュールから、DB・時計のモジュールを読み込むことを禁止する。

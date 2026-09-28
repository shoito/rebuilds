---
status: accepted
date: 2026-09-28
---

# ADR-0008: 時点の問い合わせの `known_at` を安定の境界より前に限り、将来日付の副作用は発効の予定の表で行う

詳細は [object-model-and-effective-dating.md](../architecture/object-model-and-effective-dating.md) の 7・8 節。

## Context

[ADR-0002](0002-effective-dated-data-model.md) は、問い合わせに `effective_on` と `known_at` を受け、給与計算は入力の固定の時刻を `known_at` にすると決めた。[ADR-0004](0004-payroll-engine.md) は、後で同じ `known_at` で読めば同じ入力になることを求める。

ところが `recorded_at` はトランザクションの中で決まる。時刻 t1 に書き始めたトランザクションが t3 にコミットすると、t2（t1 < t2 < t3）の `known_at` の問い合わせの答えが、t3 の前と後で変わる。これは「過去の知識は変わらない」を破る。

また、将来日付の変更は、読み取りの日付で見え方が自然に変わる。一方で、発効の日に要る副作用（SSO のアカウントの有効化、権限のキャッシュの無効化、通知）がある。本家は、将来日付の変更を指定したタイムゾーンのその日の 0 時に効かせる（[Concept: Effective Dates](https://doc.workday.com/admin-guide/en-us/manage-workday/business-processes/business-process-framework-concepts/dan1370796344630.html)、2026-09-28 に確認）。

## Options

`known_at` の安定：

1. **書き込みのトランザクションを 5 秒で打ち切り（`transaction_timeout`）、`known_at` を「今 − 10 秒」より前に限る**
2. テナントごとのコミットの連番（1 行のカウンター）を記録の時刻の代わりにする
3. 何もしない（ずれは無視できるとする）

発効の副作用：

- a. **差分と同じトランザクションで発効の予定（`temporal_activations`）を書き、テナントの暦の 0 時に BP Worker が実行する**
- b. 毎日 0 時に、その日が有効日の差分を探して副作用を出す
- c. 副作用を持たず、読む側が毎回判定する

## Decision

1 と a を採用する。

- 有効日付の書き込みのトランザクションは `transaction_timeout = 5s`（[Client Connection Defaults](https://www.postgresql.org/docs/18/runtime-config-client.html)、2026-09-28 に確認）。`recorded_at` はロックを取った後の `clock_timestamp()`。
- `known_at` は安定の境界（今 − 10 秒）以下に限る。より新しい値は境界に丸め、応答に示す。`known_at` を省いたら現在のテーブルを読む。
- 給与の入力の固定は、`known_at` = 開始 − 10 秒にし、読み始める前に 10 秒待つ。
- `known_at` を指定した問い合わせは、facet のドメインの権限に加えて、監査の権限を要する。訂正で退いた誤りの値を普通の利用者に見せないため。
- 将来日付の差分を書くとき、facet に登録した副作用ごとに `temporal_activations` の行を同じトランザクションで作る。取消・訂正では予定を取り消し・作り直す（DT-TEMP-005）。BP Worker が `fire_at`（テナントの暦の有効日の 0 時）を過ぎた予定を `FOR UPDATE SKIP LOCKED` で取り、副作用を outbox に書く。冪等キーは予定の ID。
- 過去日付の変更は予定を作らず、すぐ副作用を出す。
- 2 を採らない理由：テナントのすべての有効日付の書き込みが 1 行を更新し、直列になる。S1 の最大 3 万人のテナントの一括の変更で詰まる。
- 3 を採らない理由：給与の入力のスナップショットの再現（NFR-002）が、まれにだけ崩れる。まれな不一致は最も調べにくい。
- b を採らない理由：取消・訂正の後の「出すべきでない副作用」を、その日の差分の走査だけでは判定しにくい。止まっていた日の追いつきも、予定の表なら `fire_at` の順に処理できる。
- c を採らない理由：外部の連携（SSO）は、読む側の判定では動かない。

## Consequences

- 良くなること：
  - 同じ `known_at` の問い合わせが、いつ読んでも同じ答えになる。
  - 発効の副作用が、取消・訂正と整合し、止まった後も順に追いつく。
- 引き受けるコスト：
  - 最新の 10 秒の知識は、`known_at` の問い合わせでは見えない（現在のテーブルでは見える）。
  - 5 秒を超える書き込み（大きな一括）は、主体ごとのトランザクションに分ける必要がある。
  - 4 月 1 日のような発効の集中に、BP Worker の増強が要る。

## Confirmation

- 性質ベーステスト：PROP-TEMP-003（安定の境界より前の問い合わせは後の操作で変わらない）、PROP-TEMP-005（参照のモデルと一致）、PROP-TEMP-008（予定と生きている将来日付の差分が 1 対 1）。
- 結合テスト：6 秒かかる書き込みのトランザクションが打ち切られる。境界より新しい `known_at` が丸められる。
- 本番：発効の予定の遅れ（5 分で警告）、`fired` でない過去の予定の件数（夜間の検査）。

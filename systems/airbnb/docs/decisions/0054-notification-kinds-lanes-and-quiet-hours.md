---
status: accepted
date: 2026-10-10
---

# ADR-0054: 通知は種類ごとに級（`critical`・`transactional`・`engagement`）とレーン（SQS の別の待ち行列）を持つ。`critical` は静かな時間と上限の外で、プッシュに 15 分の既読がなければ SMS を足す。静かな時間は受け手のタイムゾーンの 22:00〜08:00 で `engagement` にだけ効く。通知の中身に正確な住所・鍵の番号・旅券の番号を入れない

詳細は [messaging.md](../architecture/messaging.md) の 9 節。

## Context

- 予約のリクエストは 24 時間で期限が切れ、ホストが見落とすとゲストが泊まる所を失う（[ADR-0004](0004-booking-state-machine-and-holds.md)）。外部の予定との重なりは 5 分以内に知らせる（NFR-003）。
- 予約の通知は p95 10 秒、メッセージは p95 5 秒（NFR-012）。
- ゲストとホストは国が違い、タイムゾーンが違う。
- 通知はロックの画面・メール・SMS に出る。正確な住所や鍵の番号が出ると、予約の外の人に見える（NFR-016）。
- Mercari の題材は、級とレーン、静かな時間と上限を決めた（[ADR-0063](../../../mercari/docs/decisions/0063-notification-kinds-lanes-and-payload.md)、[ADR-0064](../../../mercari/docs/decisions/0064-fanout-batching-quiet-hours-and-caps.md)）。

## Options

1. **3 つの級とレーン。`critical` は SMS の段の上げ、静かな時間は `engagement` だけ**
2. 1 つの待ち行列と、全部に同じ静かな時間
3. 全部の通知をプッシュとメールにし、SMS を使わない

## Decision

1 を採用する。

- 級は `critical`・`transactional`・`engagement`。レーンごとに別の SQS と Worker。
- `critical`（リクエストの受け取りと期限の前、外部の予定の重なり、チェックインの 72 時間前の後のキャンセル、送金の失敗、安全）は静かな時間と上限の外。対象の種類は、プッシュに 15 分の既読がなければ SMS を足す。SMS は 1 人 1 日 10 通まで。
- 静かな時間は受け手のタイムゾーンの 22:00〜08:00。既定で `engagement` だけに効き、本人が `transactional` に広げられる。
- 重複の鍵 `(kind, subject_id, recipient, subject_seq)`。
- 雛形の変数に正確な住所・建物名・部屋番号・鍵の番号・旅券の番号・口座の番号を持たない（型で禁じる）。

### 他の案を選ばなかった理由

- **2**：おすすめの通知の詰まりが予約の通知を遅らせる。夜のリクエストの通知を止めると、24 時間の期限を逃す。
- **3**：プッシュを切っているホストは、リクエストと重なりの知らせを見落とす。

## Consequences

- 良くなること：
  - 期限のある通知が、他の通知の量と静かな時間に左右されない。
  - 通知の経路から正確な住所が漏れない。
- 引き受けるコスト：
  - SMS の費用（S1 で 1 日数百通の見込み。capacity の領域）。
  - `critical` を夜に受けるホストの負担。種類を絞って保つ。

## Confirmation

- PROP-MSG-005（中身）、PROP-MSG-006（静かな時間と級）、PROP-MSG-007（重複）。
- 負荷：繁忙期の予約の通知で NFR-012。

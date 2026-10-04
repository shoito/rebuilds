---
status: accepted
date: 2026-10-04
---

# ADR-0031: 通知は画面・Web Push・メールの 3 つの経路で、送る時に `redact()` と出欠を確かめ直す。Web Push の本文は通知の ID だけにし、Service Worker が中身を本システムから取る。予定の事象の通知は受け手と予定ごとに 2 分まとめ、毎朝の一覧は利用者のタイムゾーンの 06:00 に計画の表から送る

## Context

[intent.md](../intent.md) は、リマインダー（画面の通知・Web Push・メール）、招待・変更・取り消し・返事の通知、毎朝の予定の一覧を MVP に含める。[architecture/README.md](../architecture/README.md) の 4 節は Web Push を標準（VAPID）にし、配信はブラウザの事業者のサービスとした。

次の論点がある。

- Web Push の配信のサービスはブラウザの事業者が運営し、国外にある。本文に予定のタイトルや場所を入れると、予定のデータを第三者（国外）に渡すことになる（法務の L1・L4）。
- 通知の本文は、見てはいけない中身を含んではならない（NFR-008）。計画した時と送る時で、共有や出欠が変わりうる。
- 主催者が予定を続けて直すと、参加者に通知の洪水が届く。
- 開いている画面と Web Push の両方で同じ通知が出る。

本家の通知の方法はメール・デスクトップの通知・画面の中のアラートで、種類ごとにメールの有無を選べ、毎朝の一覧はメールで受けられる（[Change Google Calendar notifications](https://support.google.com/calendar/answer/37242)、[Tips to manage your time in Calendar](https://support.google.com/a/users/answer/9282964)、2026-10-04 に確認）。毎朝の一覧の時刻は公式の資料にない（未検証）。

## Options

Web Push の本文：

1. **通知の ID だけ。Service Worker が同じオリジンのクッキーで中身を取る**
2. 予定のタイトルと時刻を暗号化して入れる（RFC 8291 で配信のサービスは中身を読めない）
3. 中身なしの固定の文（「予定のリマインダー」）だけ

予定の事象の通知：

- a. **受け手と予定ごとに 2 分まとめる。取り消しは待たない**
- b. 事象ごとにすぐ送る

## Decision

1 と a を採用する。詳細は [reminders-and-notifications.md](../architecture/reminders-and-notifications.md) の 7〜9 節。

- **送る時の確かめ**：notifier は、予定の有無、回の開始が記録と同じか、DT-REM-001、設定、経路の有効を確かめ、外れたら `dropped` と理由のコードにする。中身は送る時の `redact(user, event)` から作る。
- **画面**：`notifications` の行と Realtime の合図。30 日で消す。
- **Web Push**：RFC 8030・8291・8292。本文は `{"v":1,"nid":"…"}`。Service Worker が `GET /v1/notifications/{nid}` で中身を取って表示し、取れなければ固定の文。焦点のある画面があれば OS の通知を出さない。リマインダーは `TTL: 900`・`Urgency: high`。`404`・`410` で登録を消す。
- **メール**：SES（東京）、`List-Unsubscribe` と RFC 8058。説明は入れない。1 利用者 1 時間 60 通まで。
- **予定の事象の通知**：`invited`・`updated`・`cancelled`・`replied`・`pending_invitations`・`room_needs_review`・`booking_created`・`booking_cancelled`。（受け手, 予定オブジェクト）ごとに 2 分まとめ、取り消しは待たない。自分の操作は自分に送らない。`sendUpdates=none` ならメールを送らない。外部の人へは送らない（iMIP が届く）。
- **毎朝の一覧**：利用者が有効にしたときだけ。利用者のタイムゾーンの 06:00 に、`reminder_plans` の `kind = agenda` の行として計画する。その日の回が 0 件なら送らない。中身は送る時に読む。

### 他の案を選ばなかった理由

- **2（暗号化して入れる）**：RFC 8291 で配信のサービスは中身を読めないが、暗号文と送る時刻・端点は渡る。中身を渡さない形のほうが、法務の L1・L4 の論点が小さい。画面の表示を本システムの今の状態（取り消し・共有の変更の後）にできる利点もある。
- **3（固定の文だけ）**：利用者が通知からどの予定かわからず、リマインダーの役目を果たさない。
- **b（すぐ送る）**：主催者が時刻と場所を続けて直すと、参加者に数通が続けて届く。

## Consequences

- 良くなること：
  - 予定の中身が Web Push の配信のサービスに渡らない。
  - 通知の本文が、送る時点の権限と状態で作られる。
  - 予定の編集の洪水が 1 通にまとまる。
- 引き受けるコスト：
  - Web Push の表示に、Service Worker からの 1 往復が増える。オフラインの端末では固定の文になる。
  - iOS で Web Push を受けるには、ホーム画面に置いた Web アプリが要る見込み（未検証）。受けられない利用者はメールに頼る。
  - 予定の変更の通知が最大 2 分遅れる（取り消しを除く）。
  - SES と Web Push の配信のサービスの扱いは法務の L1・L3・L4 の結論を待ち、E9 の該当の spec はそれまで承認しない。

## Confirmation

- 表駆動テスト：DT-NOTIF-001（予定の事象の通知）。
- 性質ベーステスト：PROP-REM-005（通知の本文に `redact()` が隠す項目が現れない。Web Push の本文は通知の ID だけ）。
- 結合テスト：VAPID と RFC 8291 の暗号（既知の答えの組）、`410` での登録の削除、RFC 8058 の 1 回の操作での停止。
- 本番：Web Push の取得の失敗の率、メールの不達の率、まとめた通知の数。

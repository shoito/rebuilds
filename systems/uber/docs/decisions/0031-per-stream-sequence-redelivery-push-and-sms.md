---
status: accepted
date: 2026-09-27
---

# ADR-0031: 配信は受け手ごとの seq と TTL で順序と送り直しを持ち、正しさは API の読み直しが持つ。届かないときは利用者に見えるプッシュ、SMS はワンタイムコードと到着の代わりの知らせだけ

詳細は [notifications-and-realtime-push.md](../architecture/notifications-and-realtime-push.md) の 4〜8 節。

## Context

乗車の事象は outbox から少なくとも 1 回、順序の保証なしに配られる（[ADR-0022](0022-trip-outbox-and-offline-continuation.md)）。アプリには、取りこぼしに気づけて、重複に強い形で届ける必要がある。携帯の網は、トンネルや地下でよく切れる。

事実（2026-09-27 に確認）：

- 本家の RAMEN は、メッセージに高・中・低の優先度と、数秒〜30 分の TTL を持たせ、`seq` で再開できる少なくとも 1 回の配信にした（[Uber's Real-Time Push Platform](https://www.uber.com/gb/en/blog/real-time-push-platform/)）。
- APNs の `apns-expiration`・`apns-collapse-id`・`apns-priority`（[Sending notification requests to APNs](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns)）。FCM の高い優先度は、利用者に見える通知にならない送信が続くと、7 日の振る舞いから普通の優先度に落とされうる（[Set and manage Android message priority](https://firebase.google.com/docs/cloud-messaging/android-message-priority)）。
- Twilio の日本の SMS は、国際の経路なら登録なしで使え、KDDI の網で 5 分割を超える SMS は遅れうる（[Japan: SMS Guidelines](https://www.twilio.com/en-us/guidelines/jp/sms)）。国内の携帯の会社に直接つなぐ提供者がある（[ネクスウェイの解説](https://smslink.nexway.co.jp/column/161)）。

## Options

順序：

1. **受け手ごとのストリームと `seq`。Valkey の Stream に TTL つきで残し、飛びは API で取り直す**
2. **乗車ごとの `seq`**
3. **順序をつけず、事象の版だけで扱う**

届かないとき：

- a. **接続がないか 1.5 秒で確認がなければ、利用者に見えるプッシュ通知も送る**
- b. **背景の通知（silent push）でアプリを起こし、接続を張らせる**

SMS：

- i. **ワンタイムコードと、到着の代わりの知らせだけ**
- ii. **状態の変化ごとに SMS も送る**

## Decision

1、a、i を採用する。

- 受け手（`rider:{id}`・`driver:{id}`）ごとに `seq` を振り、Valkey の Stream に 500 件・30 分残す。Valkey を失ったら `stream_epoch` を替え、アプリは API で全体を読み直す。
- アプリは保存の後に累積の `Ack(seq)` を返す。`rt-gateway` は 2 秒で確認がなければ 1 回送り直す。アプリは重複を `seq` で捨て、飛びを API で取り直す。乗車の状態は `trip_version` の大きいものだけを採る。
- 優先度（HIGH・NORMAL・LOW）と TTL、置き換えの鍵（`dedupe_key`）を事象の型ごとの表で決める。オファーの TTL はオファーの期限。
- オファーの `OfferDelivered` は、表示の後に送る。作成から記録まで p95 1.5 秒・p99 4 秒を目標にする。
- 接続がないか、1.5 秒で確認がない HIGH の事象は、APNs（`alert`、優先度 10、`time-sensitive`、期限と `collapse-id` つき）と FCM（高い優先度、`ttl`）で、必ず利用者に見える通知として送る。
- 車の位置は `seq` のない一時のメッセージにし、有効な割り当ての乗客にだけ送る。
- SMS は、ワンタイムコード（6 桁、5 分、5 回、日本の携帯の番号だけ）と、到着から 60 秒で乗客が確認していないときの知らせ（1 乗車 1 回）だけにする。国内の直接の接続の提供者を主、Twilio を副にする。
- 2 を採らない理由：ドライバーには、オファー・乗車・休憩の知らせが 1 本の順序で要る。乗車ごとだと、乗車をまたぐ順序が決まらない。
- 3 を採らない理由：取りこぼしに気づけず、API の読み直しの契機がない。
- b を採らない理由：背景の通知は OS の判断で遅れ、FCM では普通の優先度に落とされうる。
- ii を採らない理由：料金が大きく、SMS も同じ場所で届きにくい。本文に乗車の情報が残る。

## Consequences

- 良くなること：
  - 取りこぼしと重複を、アプリが自分で検知して直せる。Valkey を失っても正しさは保たれる。
  - オファーが、接続とプッシュの 2 つの経路で届く。
- 引き受けるコスト：
  - Valkey の Stream と登録表の運用が増える（索引とは別のクラスター）。
  - オファーが 2 つの経路で届くことがあり、アプリは `offer_id` で重複を捨てる。
  - SMS の提供者を 2 つ持つ。

## Confirmation

- 性質ベーステスト：PROP-RT-001〜004（[notifications-and-realtime-push.md](../architecture/notifications-and-realtime-push.md) の 12.1 節）。
- 障害注入：Valkey のフェイルオーバーで、アプリが読み直して最後の状態がサーバーと一致すること。
- 監視：オファーの配信の区間ごとの遅れ、取り下げの率、`resync_required` の件数、SMS の届くまでの時間。
- レビュー：プッシュの本体や SMS の本文に位置・住所・電話番号・額を入れる変更を差し戻す。

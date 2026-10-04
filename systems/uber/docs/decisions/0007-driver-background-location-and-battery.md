---
status: accepted
date: 2026-09-27
---

# ADR-0007: ドライバーのアプリは「使用中のみ」の許可で、出庫の間だけ背景で位置を取る。止まったらサーバーが 60 秒で知らせる

詳細は [rider-and-driver-apps.md](../architecture/rider-and-driver-apps.md) の 4 節。

## Context

ドライバーのアプリは、出庫の間、画面を消しても 4 秒ごとに位置を送り続ける必要がある（[ADR-0009](0009-location-upload-and-validation.md)、NFR-002）。OS は背景のアプリを止め、電池を守る。許可が重いほど、利用者とストアの審査の負担が増える。

事実（2026-09-27 に確認）：

- iOS：背景で位置を受けるには、`UIBackgroundModes` に `location` を入れ、`allowsBackgroundLocationUpdates` を `true` にする。前景で更新を始めれば、背景に移っても続き、青い表示が出る（[allowsBackgroundLocationUpdates](https://developer.apple.com/documentation/corelocation/cllocationmanager/allowsbackgroundlocationupdates)）。`CLBackgroundActivitySession` を前景で作ると、背景で更新を受け続けられる。アプリが終了されたら、背景での起動の直後に作り直す（[Handling location updates in the background](https://developer.apple.com/documentation/corelocation/handling-location-updates-in-the-background)）。
- Android：Android 14 以上で、`location` 型のフォアグラウンドサービスは、見えている画面があるときに始める必要があり、背景から始めると `SecurityException` になる。`ACCESS_BACKGROUND_LOCATION` があれば例外がある。通知からの起動などは例外になる（[Restrictions on starting a foreground service from the background](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start)）。背景の位置の権限は、Google Play の申告の審査が要る（[Understanding location in the background permissions](https://support.google.com/googleplay/android-developer/answer/9799150?hl=en)）。

## Options

1. **「使用中のみ」の許可。出庫の操作（前景）で背景の更新を始め、止まったらサーバーが通知で開き直しを促す**
2. **「常に」（iOS）と `ACCESS_BACKGROUND_LOCATION`（Android）を求め、OS の再起動や背景からの再開もアプリが自分で行う**
3. **画面を点けたままにする前提で、背景の実行を使わない**

## Decision

1 を採用する。

- iOS：位置は「使用中のみ」と正確な位置。出庫で `allowsBackgroundLocationUpdates = true` にし、`CLBackgroundActivitySession` を作る。入庫で閉じる。
- Android：`ACCESS_FINE_LOCATION`・`FOREGROUND_SERVICE_LOCATION`・`POST_NOTIFICATIONS`。出庫の操作で `location` 型のフォアグラウンドサービスを始める。`ACCESS_BACKGROUND_LOCATION` は求めない。Play Console で `location` の型を申告する。
- 取り方は状態ごとの表にする：迎車・乗車は最高の精度で 1 秒ごと、空車は 1〜2 秒ごと、止まっているときは 4 秒に 1 点、実車（流し）と休憩は 10 秒ごと。熱の状態が `serious` 以上か、電池 15% 以下で給電がないときは、空車を 4 秒に 1 点に落とす。
- 送れなかった点は暗号化した SQLite に 900 点まで溜め、24 時間で消す。
- サーバーは、出庫中の最新の点が 60 秒より古ければ、利用者に見えるプッシュ通知で開き直しを促し、5 分で休憩にする。
- 「おおよその位置」だけのときは出庫させない。
- 2 を採らない理由：許可と審査が重い割に、得るものが小さい。iOS の標準の位置の更新は、アプリが終了すると届かなくなる（[startUpdatingLocation()](https://developer.apple.com/documentation/corelocation/cllocationmanager/startupdatinglocation%28%29)）。終了の後にアプリを背景で起こせるのは大きな移動の通知（[startMonitoringSignificantLocationChanges()](https://developer.apple.com/documentation/corelocation/cllocationmanager/startmonitoringsignificantlocationchanges%28%29)）だけで、数百 m ごとの粗い点しか来ない（どちらも 2026-09-27 に確認）。利用者が強制で終了したときにこれで起きるかは文書に書かれていない（**未検証**、E9 の `driver-location-recovery` で確かめる）。
- 3 を採らない理由：画面を点け続けると電池と熱の負担が大きく、ナビのアプリに切り替えた間に送信が止まる。

## Consequences

- 良くなること：
  - 許可の説明と審査が軽い。利用者に見える印（iOS の青い表示、Android の通知）で、位置を取っていることが分かる。
  - 出庫の間だけ取るので、勤務の外の位置を集めない。
- 引き受けるコスト：
  - OS がアプリを終了すると、ドライバーが開き直すまで送信が止まる。その間は配車の候補から外れる。
  - Android の機種ごとの電池の最適化で落ちることがある（機種は **未検証**。E9 の `driver-background-location` の端末の試験で確かめる）。
  - 電池の消費の目標（給電なしの空車で 1 時間 10% 以下）は **未検証** の設計の値（E9 の `driver-background-location` で計る）。

## Confirmation

- 端末の試験：基準の端末で 4 時間の合成の走行を回し、送信の間隔・欠けた点・電池の消費を計る。
- 障害の試験：OS の終了、許可の取り消し、機内モードで、回復の手順が働くこと。
- 監視：出庫中で最新の点が 60 秒より古いドライバーの数（バージョン・OS・機種ごと）。
- レビュー：「常に」の許可や `ACCESS_BACKGROUND_LOCATION` を求める変更は、この ADR を置き換える ADR なしに入れない。

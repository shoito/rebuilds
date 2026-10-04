# Rider and driver apps: Uber

乗客のアプリとドライバーのアプリ。画面の流れ、背景での位置の送信と電池、外部のナビへの引き継ぎ、通信が切れたときの乗車の継続、Swift・Kotlin の 2 つのコードベースで共有するもの（Protocol Buffers のモデルと状態機械のテストのベクター）、リリースの列車と強制の更新を決める。

前提となる決定は、モバイルはネイティブで書き、共有は Protocol Buffers から生成するモデルと状態遷移の表のテストのベクターに留めること（[ADR-0001](../decisions/0001-platform-and-stack.md)）、位置は 4 秒ごとに HTTPS で送ること（[ADR-0009](../decisions/0009-location-upload-and-validation.md)）、乗車の状態機械と journal（[ADR-0021](../decisions/0021-trip-transition-function-and-assignment-fencing.md)、[ADR-0022](../decisions/0022-trip-outbox-and-offline-continuation.md)）、オファーの表示 15 秒と受信の確認 5 秒（[ADR-0015](../decisions/0015-offer-protocol-decision-log-and-replay.md)）、事前確定運賃のルートの提示（[ADR-0017](../decisions/0017-fare-distance-for-pre-fixed-fares.md)）、NFR-007（乗車の耐久性）と NFR-010（安全の機能）（[architecture/README.md](README.md) の 3 節）。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0006](../decisions/0006-native-apps-contracts-vectors-and-release-train.md) | 2 つのアプリを Swift と Kotlin で書き、共有するのは buf で生成する Protocol Buffers の型と、Trips の遷移の表から作る状態機械のテストのベクター（JSON）だけにする。アプリの乗車の状態は、純粋な reducer（状態 ＋ 入力 → 状態 ＋ 副作用）で持つ。対応する OS は iOS 17 以上・Android 10（API 29）以上。リリースは週 1 回の列車で、強制の更新はサーバーが返す最低のバージョンで行い、乗車の最中と緊急の入口は塞がない |
| [0007](../decisions/0007-driver-background-location-and-battery.md) | ドライバーのアプリは「使用中のみ」の位置の許可で動かす。iOS は `allowsBackgroundLocationUpdates` と `CLBackgroundActivitySession`、Android は出庫の操作で始める `location` 型のフォアグラウンドサービスで、出庫の間だけ位置を取る。「常に」の許可と Android の `ACCESS_BACKGROUND_LOCATION` は求めない。取り方は状態ごとの表で決め、止まったら 60 秒でサーバーがプッシュ通知で知らせる |
| [0008](../decisions/0008-navigation-handoff-with-waypoints.md) | 外部のナビには、選んだルートの主要経由地点を経由地として渡す（Google マップは Maps URLs の `waypoints`、Apple マップは統合の Maps URL の `waypoint`）。経由地を守らない引き継ぎ先は事前確定運賃の乗車で出さない。アプリの中でルートからの逸脱を知らせる |

## 1. 目的と範囲

- 扱う：乗客とドライバーの画面の流れ、端末の側の位置の取り方・許可・電池、外部のナビへの引き継ぎ、アプリの中の乗車の状態の持ち方、通信が切れたときの振る舞い（端末の側）、2 つのコードベースで共有するもの、配布とリリース、強制の更新、画面の文言の方針。
- 扱わない：位置の受信と検証（[location-ingestion.md](location-ingestion.md)）、乗車の状態機械の正本と journal の受け取り（[trips-lifecycle.md](trips-lifecycle.md)）、常時の接続とプッシュ通知（[notifications-and-realtime-push.md](notifications-and-realtime-push.md)）、緊急の通報・共有・通話の中身（[safety-and-trust.md](safety-and-trust.md)）、運賃の計算（[pricing-and-fares.md](pricing-and-fares.md)）、住所の検索と乗降の地点（[maps-and-geodata.md](maps-and-geodata.md)）、CI/CD とフラグの基盤（`delivery.md`）、端末の認証とトークン（`security.md`）。
- 事業者の管理画面とサポートのツールは Web で、[support-and-operations-tools.md](support-and-operations-tools.md) が扱う。

## 2. 事実（確かめたこと）

いずれも 2026-09-27 に確認。

| 項目 | 事実 | この設計 |
| --- | --- | --- |
| iOS の背景の位置 | 背景で位置を受けるアプリは、`Info.plist` の `UIBackgroundModes` に `location` を入れ、`allowsBackgroundLocationUpdates` を `true` にする。前景で更新を始めると、背景に移っても更新が続き、必要なら青い表示（バーかピル）が出る。`UIBackgroundModes` なしに `true` にすると、アプリが落ちる（[allowsBackgroundLocationUpdates](https://developer.apple.com/documentation/corelocation/cllocationmanager/allowsbackgroundlocationupdates)） | 出庫の間だけ `true` にする（4 節） |
| iOS の背景の活動の印 | `CLBackgroundActivitySession` を前景で作ると、背景で位置の更新を受け続けられる。アプリが終了されたら、背景で起動された直後に作り直す（[Handling location updates in the background](https://developer.apple.com/documentation/corelocation/handling-location-updates-in-the-background)） | 出庫で作り、入庫で閉じる |
| iOS の模擬の位置 | `CLLocationSourceInformation.isSimulatedBySoftware` は、端末の上のソフトウェアの模擬（Xcode の GPX など）で作った位置のとき `true`（[isSimulatedBySoftware](https://developer.apple.com/documentation/corelocation/cllocationsourceinformation/issimulatedbysoftware)、iOS 15 以上）。他社の偽装の道具を検出できないという報告がある（[Apple Developer Forums](https://developer.apple.com/forums/thread/803179)） | 印として送るが、頼らない（9 節） |
| Android の模擬の位置 | `Location.isMock()` は API 31 で加わった。`isFromMockProvider()` は API 31 で非推奨（[Location](https://developer.android.com/reference/android/location/Location)） | API 31 以上は `isMock()`、それより前は `isFromMockProvider()` |
| Android のフォアグラウンドサービス | Android 14 以上で、`location` などの型のフォアグラウンドサービスは、使用中のみの許可が要るため、見えている画面があるときに始める必要がある。背景から始めると `SecurityException`。`ACCESS_BACKGROUND_LOCATION` があれば例外がある。高い優先度の FCM を受けたときは背景から始められるが、利用者に見える内容を出さない高い優先度の通知は、普通の優先度に落とされうる（[Restrictions on starting a foreground service from the background](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start)） | 出庫の操作で始める。落ちたら通知から開き直してもらう（4.4 節） |
| Google Play の申告 | Android 14 以上を対象にするアプリは、使うフォアグラウンドサービスの型を Play Console で申告する。背景の位置を使うアプリは、権限の申告の審査を通る必要がある（[Understanding foreground service and full-screen intent requirements](https://support.google.com/googleplay/android-developer/answer/13392821?hl=en)、[Understanding location in the background permissions](https://support.google.com/googleplay/android-developer/answer/9799150?hl=en)） | `location` の型を申告する。背景の位置の権限は求めない |
| Google マップへの引き継ぎ | Maps URLs の経路の操作は `origin`・`destination`・`travelmode`・`dir_action`・`waypoints`・`avoid` を持つ。経由地は、モバイルのブラウザーで開くと 3 つまで、それ以外は 9 つまで。経由地に対応しない製品では無視される（[Maps URLs](https://developers.google.com/maps/documentation/urls/get-started)）。Android の `google.navigation:` の intent は `q`・`mode`・`avoid` だけで、経由地を持たない（[Google Maps Intents](https://developer.android.com/guide/components/google-maps-intents)） | Maps URLs を使い、intent は使わない（6 節） |
| Apple マップへの引き継ぎ | iOS 18.4 以降の統合の Maps URL は `/directions` で `source`・`destination`・`waypoint`（繰り返して複数）・`mode`・`avoid`（`tolls`・`highways` など）を持つ（[Adopting unified Maps URLs](https://developer.apple.com/documentation/mapkit/unified-map-urls)） | iOS 18.4 以上でだけ Apple マップを引き継ぎ先に出す |
| App Store の段階的な公開 | 7 日で 1%・2%・5%・10%・20%・50%・100% と固定で広がり、止められる。対象は自動の更新をする利用者で、手で更新する人と新しく入れる人は最新を受け取る（[Release a version update in phases](https://developer.apple.com/help/app-store-connect/update-your-app/release-a-version-update-in-phases)） | 10 節 |
| Google Play の即時の更新 | アプリ内の更新の `IMMEDIATE` は、更新が終わるまで画面を塞ぐ（[Support in-app updates](https://developer.android.com/guide/playcore/in-app-updates/kotlin-java)） | 強制の更新に使う（10.3 節） |
| 本家のリリース | 本家の 4 つのアプリ（乗客・ドライバー × iOS・Android）は、トランクベースで開発し、週 1 回の列車で出していたと説明されている（本家の技術ブログ [The Uber Engineering Tech Stack, Part II](https://www.uber.com/us/en/blog/uber-tech-stack-part-two/)、2016-07-21、2026-09-27 に確認） | 週 1 回の列車（10 節） |

## 3. 画面の流れ

### 3.1 乗客のアプリ

```
起動 ─▶ 電話番号の確認（SMS のワンタイムコード）─▶ 初回だけ：規約・位置の許可の説明
  ─▶ ホーム（地図、近くの車の丸めた表示、「どこまで？」）
  ─▶ 行き先の検索（住所・施設・よく使う場所・最近の場所）
  ─▶ 乗車地の確認（ピン、乗降の地点の提案 最大 3 つ）
  ─▶ 商品と見積もり（価格の群ごと、事前確定かメーターか、ルート 2 案、有料道路の有無、
       日本版ライドシェアの承諾、注意事項の同意、支払いの方法）
  ─▶ 依頼（payment_pending → requested：「車を探しています」、取り消し）
  ─▶ 迎車中（車両の番号・車種・色・ドライバーの写真と名、迎車の ETA、通話・メッセージ、共有、緊急）
  ─▶ 到着（待ちの時間の表示、無断キャンセルの時刻の予告）
  ─▶ 乗車中（ルート、降車の ETA、共有、緊急、「乗車中の報告」）
  ─▶ 降車（運賃の確定を待つ／確定）─▶ 領収書 ─▶ 評価（任意、7 日まで）
```

| 画面 | 読む API・事象 | 決まり |
| --- | --- | --- |
| ホーム | `SupplyPreview`（[geospatial-index.md](geospatial-index.md) の 6.3 節） | 車は `street` のセルの中心で出す。地図の車を動かすアニメーションで、正確な位置のように見せない |
| 行き先の検索 | `/v1/places/*`（[ADR-0034](../decisions/0034-geocoding-provider-and-pickup-points.md)） | 入力の文字列を端末のログに書かない |
| 乗車地の確認 | 乗降の地点の提案 | 乗客が確かめたピンを `rider_confirmed_pin` として送る |
| 見積もり | `fare_quotes`（[pricing-and-fares.md](pricing-and-fares.md) の 5.6 節） | 事前確定運賃は「確定の額」、メーターは「目安の範囲」と文言を分ける。目安の ETA（「約 N 分」）と受諾の時点の ETA も文言を分ける（[eta-and-routing.md](eta-and-routing.md) の 4.4 節）。文言は法務の確認待ち（L8） |
| 依頼 | `POST /v1/trips`（`client_request_id`） | 送り直しは同じ `client_request_id`。二重の依頼を作らない |
| 迎車中・乗車中 | 常時の接続の `TripStateChanged`・車の位置 | 状態は `trip_version` の大きいものだけ採る（5 節） |
| 評価 | `POST /v1/trips/{id}/rating` | [safety-and-trust.md](safety-and-trust.md) の 7 節 |

- **緊急の入口**は、ログインの後のどの画面にも同じ場所（右上の盾）に置き、1 回の操作で開く（[intent.md](../intent.md) の「守るべき振る舞い」）。通信とサーバーに依らずに 110・119 の発信の案内を出す（[safety-and-trust.md](safety-and-trust.md) の 4 節）。
- よく使う場所（自宅・職場）は、乗客のアカウントに保存する。保存するのは乗客が確かめたピンと、乗客が付けた名前だけで、提供者の内容は持たない（[maps-and-geodata.md](maps-and-geodata.md) の 7.3 節の規則）。

### 3.2 ドライバーのアプリ

```
起動 ─▶ ログイン（電話番号の確認 ＋ 事業者が発行した招待）
  ─▶ 出庫の前（車両の選択、端末の完全性の確認、本人の確認（顔。その日の最初の出庫だけ、L4 の後）、位置の許可の確かめ）
  ─▶ 出庫＝オンライン（空車）── 休憩 ⇄ 空車 ⇄ 実車（流し。タクシーだけ）
  ─▶ オファー（15 秒の残り、乗車地、迎車の ETA、運賃の種類、乗客の評価の要約）
       ├─ 辞退 / 時間切れ ─▶ 空車
       └─ 受諾 ─▶ 迎車（外部のナビへ、通話・メッセージ）─▶ 到着 ─▶ 乗車の開始
             ─▶ 乗車中（事前確定ならルートと主要経由地点、区間の分割）
             ─▶ 降車（メーターの額の入力か連携の額、事前確定の確認）─▶ 空車
  ─▶ 入庫＝オフライン
```

| 画面 | 決まり |
| --- | --- |
| 出庫の前 | 点呼や酒気帯びの確認などの運行管理は事業者の仕事で、アプリは行わない。アプリは、車両・本人・端末・許可を確かめてセッションを始める（`POST /v1/driver/sessions`。応答で時刻の基準点を受け取る。[location-ingestion.md](location-ingestion.md) の 4.3 節） |
| オファー | 画面の全体に出し、音と振動で知らせる。残り時間は受け取ってからの経過で数える（ADR-0015）。降車地は受諾の後に出す（既定。[dispatch-and-matching.md](dispatch-and-matching.md) の 8.4 節） |
| 迎車 | 「ナビを開く」を大きく置く（6 節）。乗客への通話は番号を隠す（[safety-and-trust.md](safety-and-trust.md) の 6 節） |
| 到着 | 乗車地の 200 m 以内でだけ押せる。無断キャンセルの操作は、待ちの時間が過ぎてから出す（[trips-lifecycle.md](trips-lifecycle.md) の 3.3 節の行 24） |
| 乗車中 | 事前確定の乗車は、選んだルートの線と主要経由地点を出し、逸脱を知らせる（6.4 節）。経路の変更を乗客が頼んだら「区間を分ける」（[pricing-and-fares.md](pricing-and-fares.md) の 7 節） |
| 降車 | 連携のメーターがなければ額を入れる。照合の保留のときは写真を求める（[pricing-and-fares.md](pricing-and-fares.md) の 5.4 節） |
| 流しの実車 | タクシーのドライバーだけに出す。日本版ライドシェアのドライバーには出さない（[ADR-0014](../decisions/0014-dispatch-eligibility-and-street-hails.md)） |

- **運転中の操作を減らす。** 走行中（速度 10 km/h 以上）は、受諾・辞退・到着・ナビを開く・緊急以外のボタンを隠す。オファーの受諾は 1 回のタップで済ませる。メッセージは定型文だけにする。道路交通法の運転中の携帯電話の使用との関係は、事業者の車載の器具（ホルダー）と運用に依る（法務と事業者の確認待ち。E9 の `driving-mode-ui` の spec の承認の前に確かめる）。
- 文字の大きさは OS の設定に従い、最小でも 17 pt 相当にする。オファーの画面は、色だけでなく形と文字で受諾・辞退を分ける。

## 4. 背景での位置の送信と電池（[ADR-0007](../decisions/0007-driver-background-location-and-battery.md)）

### 4.1 許可

| OS | 求める許可 | 求めない許可 | 理由 |
| --- | --- | --- | --- |
| iOS | 位置の「使用中のみ」、正確な位置 | 「常に」 | 出庫の操作（前景）で更新を始め、`allowsBackgroundLocationUpdates` と `CLBackgroundActivitySession` で背景でも続ける。「常に」は不要で、許可の説明が重くなる |
| Android | `ACCESS_FINE_LOCATION`、`FOREGROUND_SERVICE`、`FOREGROUND_SERVICE_LOCATION`、`POST_NOTIFICATIONS` | `ACCESS_BACKGROUND_LOCATION` | 出庫の操作（見えている画面）で `location` 型のフォアグラウンドサービスを始めれば、背景でも位置を取れる。背景の位置の権限は Play の審査が要り、利用者にも重い |

- 「おおよその位置」だけが許可されたときは、出庫できない。理由と設定を開くボタンを出す。
- 乗客のアプリは、依頼の画面を開いている間だけ「使用中のみ」の位置を使う。背景の位置は使わない。乗客の位置を定期的に送らない（[location-ingestion.md](location-ingestion.md) の 1 節）。

### 4.2 状態ごとの取り方

端末は 1 秒に 1 回まで位置を取り、4 秒ごとにまとめて送る（ADR-0009）。取り方は状態で変える。

| 状態 | 精度の設定 | 送信の間隔 | 備考 |
| --- | --- | --- | --- |
| 迎車中・乗車中 | iOS：`kCLLocationAccuracyBestForNavigation`。Android：`PRIORITY_HIGH_ACCURACY`、1 秒 | 4 秒（サーバーの `next_interval_ms` に従う） | ETA と軌跡の質に直結する |
| 空車（動いている） | iOS：`kCLLocationAccuracyBest`。Android：`PRIORITY_HIGH_ACCURACY`、2 秒 | 4 秒 | 配車の候補の鮮度（NFR-002） |
| 空車（止まっている：30 秒の間 10 m 以内） | 同上。取るのは 4 秒に 1 点 | 4 秒 | 1 件だけ送る |
| 実車（流し）・休憩 | iOS：`kCLLocationAccuracyNearestTenMeters`。Android：`PRIORITY_BALANCED_POWER_ACCURACY`、10 秒 | 10 秒（`next_interval_ms` の上限） | 配車の候補ではない。軌跡と、状態の戻し忘れの検知のため |
| 入庫 | 止める | 送らない | `CLBackgroundActivitySession` を閉じ、フォアグラウンドサービスを止める |

- **熱と電池**：端末の熱の状態が `serious` 以上（iOS の `ProcessInfo.thermalState`、Android の `PowerManager` の熱の状態）か、電池が 15% 以下で給電がないときは、空車の取り方を 4 秒に 1 点に落とし、画面に「充電してください」を出す。迎車中・乗車中は落とさない。
- **目標**：基準の端末（各 OS で 2 機種、E9 で決める）で、給電なしの空車の 1 時間の電池の消費を計り、10% 以下を目標にする（**未検証**の設計の値。E9 の `driver-background-location` で計る）。タクシーの車内では給電を前提にし、事業者にホルダーと給電を求める（[supply-and-operators.md](supply-and-operators.md) への申し送り）。
- 端末は `LocationSample` に、OS が出す精度・速度・向き・出どころ（GNSS・FUSED・NETWORK）と、模擬の印（2 節の API）を載せる（[location-ingestion.md](location-ingestion.md) の 4.1 節）。

### 4.3 溜めと送り直し

- 送れなかったバッチは端末の SQLite に溜める。上限は 900 点（約 15 分）で、超えたら古い点から捨てる（[location-ingestion.md](location-ingestion.md) の 4.4 節と同じ値）。
- 再接続では、平常の送信を先に送り、溜めた分は `backlog=true` で 60 点ずつ、応答を待ってから次を送る。429・5xx は指数的に待つ（1 秒から 30 秒、揺らぎつき）。
- 溜めた点は、端末の鍵（iOS の Keychain・Android の Keystore の鍵）で暗号化したファイルに置き、送れたら消す。入庫から 24 時間で、送れていない点も消す。

### 4.4 止まったときの回復

| 起きること | 検知 | 回復 |
| --- | --- | --- |
| OS がアプリを終了した（メモリ不足） | サーバー：出庫中のドライバーの最新の点が 60 秒より古い | サーバーが利用者に見えるプッシュ通知（「位置の送信が止まっています。アプリを開いてください」）を送る。通知から開けば、出庫の状態を読み直して取り直す。Android は通知からの起動でフォアグラウンドサービスを始め直せる（2 節の例外） |
| 利用者がアプリを強制で終了した | 同上 | 同上。iOS の標準の位置の更新は、アプリが終了すると届かなくなる（[startUpdatingLocation()](https://developer.apple.com/documentation/corelocation/cllocationmanager/startupdatinglocation%28%29)、2026-09-27 に確認）。この設計は大きな移動の通知を使わないので、開き直すまで止まる |
| 位置の許可を取り消した | 端末：許可の変化の通知 | 出庫を止め（サーバーに `session_paused` を送る）、許可の画面を出す |
| 位置の機能を切った・機内モード | 端末 | 同上。機内モードは 4.3 節で溜める |
| 5 分の間、点が来ない | サーバー | ドライバーを休憩（`paused_by_system`）にする。迎車中・乗車中の乗車は、状態を変えずに運用に知らせる（[trips-lifecycle.md](trips-lifecycle.md) の 3.3 節の注） |

- Android のメーカー独自の電池の最適化（アプリを止める機能）で落ちることがある。初回の出庫で、電池の最適化から外す設定の案内を出す（任意）。どのメーカーで起きるかは **未検証**（E9 の `driver-background-location` の端末の試験で確かめる）。

## 5. アプリの中の乗車の状態（[ADR-0006](../decisions/0006-native-apps-contracts-vectors-and-release-train.md)）

### 5.1 reducer

```
reduce(state: AppTripState, input: Input) -> (AppTripState, [Effect])

Input  = ServerEvent(TripStateChanged | DriverAssignmentChanged | OfferCreated | OfferRevoked, TripSnapshot)
       | ApiResponse(command_id, result)
       | UserAction(Accept | Decline | Arrive | StartTrip | SplitSegment | EndTrip | Cancel | MarkNoShow)
       | Timer(OfferCountdown | Retry)
       | Connectivity(online | offline)
Effect = SendCommand(TripCommand) | Persist(journal, snapshot) | Render(screen) | Notify | StartTimer | OpenNavigation
```

- 時計・乱数・通信は `Input` と `Effect` で外から入れる。reducer は同じ入力の列から必ず同じ出力を出す。
- アプリは、サーバーの状態（最後に受けた `TripSnapshot`、`trip_version`）と、端末の journal（まだ確定していない操作）を分けて持ち、画面は「サーバーの状態に journal を重ねた見込みの状態」で描く。見込みの状態には「送信待ち」の印を出す。
- `trip_version` が今より小さい事象は捨てる。同じバージョンは冪等に扱う。バージョンの飛びは、`GET /v1/trips/{id}` で読み直す。
- 乗車の状態は ADR-0003・0021 の名前をそのまま使い、アプリで独自の状態を作らない。画面の状態（どの画面か）は、乗車の状態からの純粋な関数で決める。

### 5.2 テストのベクター

- Trips の遷移の表（DT-TRIP-001）と、遅れて届いた操作の表（DT-TRIP-004）、オファーの事象の表（ADR-0015）から、Trips のリポジトリで JSON のベクターを生成する。置き場所は Protocol Buffers のスキーマと同じリポジトリの `vectors/trip-app/`。

```jsonc
{
  "id": "offer-accept-after-revoke-003",
  "schema_version": "trip.v1",
  "role": "driver",
  "initial": { "snapshot": null, "journal": [] },
  "steps": [
    { "in": { "server": { "type": "OfferCreated", "offer_id": "o1", "trip_version": 3, "assignment_epoch": 7 } } },
    { "in": { "server": { "type": "OfferRevoked", "offer_id": "o1", "reason": "rider_cancel", "trip_version": 4 } } },
    { "in": { "user": "Accept", "offer_id": "o1" } }
  ],
  "expect": {
    "effects": [ { "Render": "offer" }, { "Render": "idle", "toast": "offer_revoked" } ],
    "state": { "screen": "idle", "pending_commands": 0 }
  }
}
```

- 手で書くベクター：表の各行と、通信の切断（ADR-0022 の PROP-TRIP-006 の場面）。生成するベクター：Trips の TypeScript の遷移関数を基準に、fast-check で事象の列を作って期待値を記録する（夜間に 1 万本、差の出たものを固定のベクターに加える）。Zoom の題材のクライアントの試験のベクトルと同じ考え方（[clients.md](../../../zoom/docs/architecture/clients.md) の 9.2 節）。
- CI：スキーマのリポジトリの PR で、Swift（XCTest）と Kotlin（JUnit）の reducer に全ベクターを通す。1 つでも違えばマージしない。テストの名前に対応する ID（`DT-TRIP-001-row-10` など）を含める。

### 5.3 Protocol Buffers の共有

- 型は buf で Swift（swift-protobuf）と Kotlin（protobuf-kotlin lite）に生成する。生成したコードは各アプリのリポジトリにバージョンつきのパッケージとして取り込み、手で直さない。
- 互換の規則：`buf breaking` の `WIRE_JSON` を CI で守る。項目の番号を再利用しない。列挙には `*_UNSPECIFIED = 0` を置き、知らない値は「更新してください」の画面ではなく、既定の振る舞い（無視か読み直し）にする。
- サーバーは、サポートする最も古いアプリのバージョン（10.2 節）が送る・受ける形を、すべて受け付ける。

## 6. 外部のナビへの引き継ぎ（[ADR-0008](../decisions/0008-navigation-handoff-with-waypoints.md)）

### 6.1 なぜ経由地を渡すか

事前確定運賃では、乗客と運転者に同じ走行予定ルート（または主要経由地点）を示し、運転者は原則として逸脱しない（[ADR-0017](../decisions/0017-fare-distance-for-pre-fixed-fares.md)、[eta-and-routing.md](eta-and-routing.md) の 7.1 節）。外部のナビに行き先だけを渡すと、ナビが別のルートを選ぶ。そこで、乗客が選んだルートの `major_waypoints` を経由地として渡す。

### 6.2 引き継ぎ先と URL

| 引き継ぎ先 | 形 | 条件 |
| --- | --- | --- |
| Google マップ（iOS・Android） | `https://www.google.com/maps/dir/?api=1&destination=<lat,lng>&waypoints=<lat,lng>|<lat,lng>…&travelmode=driving&dir_action=navigate[&avoid=tolls]` | 経由地は最大 8 つ（上限の 9 に 1 つの余裕）。`origin` を省き、今の位置から案内させる。URL は 2,048 文字以内 |
| Apple マップ（iOS 18.4 以上） | `https://maps.apple.com/directions?destination=<lat,lng>&waypoint=<lat,lng>&waypoint=…&mode=driving[&avoid=tolls]` | `waypoint` を複数並べられ、数の上限は文書にない（[Unified Map URLs](https://developer.apple.com/documentation/mapkit/unified-map-urls)、2026-09-27 に確認）。Google と同じく最大 8 つにする |
| 事業者の車載のナビ | 引き継げない | アプリの中のルートの線と主要経由地点を見ながら走る |

- 迎車の区間（今の位置 → 乗車地）は、行き先だけを渡す（事前確定運賃の要件の外）。乗車の区間だけ経由地を渡す。
- `avoid=tolls` は、見積もりで乗客が有料道路を使わないと選んだとき（`toll=AVOID_TOLLS`）だけ付ける。
- **経由地の間引き**：`major_waypoints` が 8 を超えたら、有料道路の出入口を先に残し、残りは道のりで等間隔になるように選ぶ。`fare-distance` には、`major_waypoints` を 8 以下で返すよう申し送る（[eta-and-routing.md](eta-and-routing.md) の 7.1 節）。
- **経由地を守るかの確認**：引き継ぎ先ごとに、E9 の試験で「経由地を渡した URL で、その順にルートが引かれ、案内が始まるか」を確かめる。Maps URLs は「経由地に対応しない製品では無視される」ため、確かめるまで **未検証** とする（E9 の `nav-handoff-waypoints` の 20 のルートの試験）。確かめられなかった引き継ぎ先は、事前確定運賃の乗車では出さない（アプリの中のルートの表示で走る）。
- 引き継ぎ先の一覧は、アプリに埋めず、サーバーの設定（`nav_handoff_targets`：アプリ、OS、最低のバージョン、事前確定で使えるか）で配る。ナビのアプリの更新で振る舞いが変わったら、アプリの配布なしに外せる。

### 6.3 引き継ぎの記録

- ドライバーがナビを開いたら、`NavigationHandedOff`（`trip_id`、引き継ぎ先、渡した経由地の数、区間）を送る。問い合わせのとき、「示したルートを渡したか」を確かめるため。
- 引き継ぎの URL に、乗客の名前や電話番号を入れない。行き先と経由地の座標だけにする。

### 6.4 逸脱の知らせ

- 事前確定運賃の乗車中、アプリは端末の上で、今の位置と選んだルートの表示用の線との距離を毎秒求める。200 m を超える状態が 30 秒続いたら、「示したルートから離れています」と音と画面で知らせ、`RouteDeviationObserved`（最大の距離、続いた時間）を送る。
- 知らせるだけで、運賃は変えない。乗客の頼みで経路を変えたときは、「区間を分ける」で扱う（[pricing-and-fares.md](pricing-and-fares.md) の 7 節）。
- サーバーでの逸脱の記録は、乗車の軌跡の当てはめで行う（[ADR-0017](../decisions/0017-fare-distance-for-pre-fixed-fares.md)）。端末の知らせは、その場でドライバーに気づかせるためのもの。
- 表示用の線は、提供者の条件の期間だけ持つ（[eta-and-routing.md](eta-and-routing.md) の 7.3 節）。端末は乗車の終わりで消す。

## 7. 通信が切れたとき

### 7.1 ドライバーのアプリ

journal の中身と、サーバーでの受け取りは [trips-lifecycle.md](trips-lifecycle.md) の 8.3〜8.5 節（ADR-0022）。端末の側の決まりは次のとおり。

| 操作 | 通信がないとき |
| --- | --- |
| 受諾 | 押せない。「通信がありません」を出す。15 秒の残りはそのまま数え、切れたらオファーを閉じる |
| 到着・乗車の開始・区間の分割・降車 | その場で進め、journal に残す。画面に「送信待ち N 件」を出す |
| 無断キャンセル | 押せない |
| ドライバーの取り消し | journal に残せるが、「つながるまで確定しません」と出す |
| 出庫・入庫 | 出庫はできない。入庫は journal に残し、つながったら送る |

- journal は SQLite（iOS は GRDB、Android は Room）に置き、1 件ごとに fsync する。アプリの終了でも失わない。
- つながったら、`journal_seq` の順に 1 件ずつ送り、応答を受けてから次を送る。サーバーが拒否した操作（DT-TRIP-004 の行 3・4・6・7）は、画面に「運用が確認します」と出し、ドライバーに操作を求めない。
- 事前確定の乗車は、額を端末が知っているので、降車の画面で額を示せる。メーターの乗車は、降車でメーターの額を入れる（連携のメーターの額は、中継の機器が別の経路で送る）。
- 乗車の要約（`TripSnapshot`）は、受けたたびに最新だけを残す。リージョンの切り替えの後の復元に使う（[trips-lifecycle.md](trips-lifecycle.md) の 8.5 節）。

### 7.2 乗客のアプリ

- 乗客は乗車を進める操作をしない。通信が切れたら、最後の `TripSnapshot` と、車両の番号・車種・色・ドライバーの名を出し続け、「通信が切れています。車を確かめてから乗ってください」を出す。
- 通信がなくても、緊急の入口と 110・119 の発信の案内は動く（[safety-and-trust.md](safety-and-trust.md) の 4 節）。
- つながったら `GET /v1/trips/{id}` で今の状態を読み直す。
- 依頼（`POST /v1/trips`）は、応答が失われたら同じ `client_request_id` で送り直す。通信がないまま依頼の画面を開いたままにしない（3 分で「通信を確かめてください」）。

## 8. 失敗のしかた

| 失敗 | 起きること | 抑え方 |
| --- | --- | --- |
| 常時の接続が切れる（トンネル・地下） | 状態の変化とオファーが届かない | 再接続と差分の取り直し（[notifications-and-realtime-push.md](notifications-and-realtime-push.md) の 6 節）。オファーは 5 秒で取り下げられ、罰則にならない |
| 位置の送信が止まる | 15 秒で配車の候補から外れる | 4.4 節 |
| 外部のナビが経由地を無視する | 示したルートから外れる | 6.2 節の確認と、6.4 節の逸脱の知らせ |
| アプリの不具合で状態を誤って表示 | ドライバーが誤った操作をする | 操作は Trips が検査して拒否する（ADR-0021）。状態の表示は `TripSnapshot` のバージョンで常に読み直せる |
| 新しいバージョンで重大な不具合 | 多くの端末で同じ失敗 | 段階的な公開を止め、フラグで機能を切り、必要なら最低のバージョンを上げる（10 節） |
| 時計のずれ | オファーの残り・待ち時間の表示がずれる | 端末の時刻を使わず、受け取ってからの経過で数える |
| 端末の記憶域の不足 | journal を書けない | 出庫の前に 200 MB の空きを確かめる。書けなければ出庫させない |

## 9. セキュリティとプライバシー

- **トークン**：アクセストークンは短い期限（発行と更新は `security.md`）。更新のトークンは Keychain（`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`）と Android Keystore で暗号化して置く。
- **端末の完全性**：ドライバーの出庫のときに、iOS は App Attest、Android は Play Integrity API の判定をサーバーに送り、サーバーが確かめる（判定の扱いは `security.md`）。失敗したら出庫させず、事業者に知らせる。乗客のアプリは、依頼の多すぎる端末でだけ確かめる。
- **模擬の位置**：2 節の API の印を `integrity` に載せる（[location-ingestion.md](location-ingestion.md) の 13 節の V7）。iOS の印は他社の道具を検出できないとされるので、端末の完全性と、サーバーの側の兆し（跳び・ETA の系統的なずれ）と合わせて使う。
- **端末に残すもの**：乗車の要約（位置は `street` に丸めた値）、journal（正確な位置を含む。暗号化し、確定したら消す）、よく使う場所（乗客が保存したもの）。相手の電話番号は持たない（番号を隠した通話を使う）。
- **ログ・クラッシュの報告**：緯度経度、住所の入力、相手の名前、電話番号を書かない。クラッシュの報告の SDK の自動の収集（パンくず、画面の文字）を切る。lint でログの呼び出しの引数に位置の型を渡すことを禁じる。
- **スクリーンショット**：乗客の名前と乗車地が出るオファーと迎車の画面は、Android で `FLAG_SECURE` を付けない（ドライバーが問い合わせのために撮ることがある）。代わりに、乗車の終わりで乗客の名前を画面の履歴から消す。
- **外部送信**：アプリに入れる外部の SDK（分析・クラッシュの報告）は一覧にし、電気通信事業法の外部送信規律の公表の対象にする（法務の確認待ち、L4）。

## 10. リリースの列車と強制の更新（[ADR-0006](../decisions/0006-native-apps-contracts-vectors-and-release-train.md)）

### 10.1 列車

| 曜日 | 作業 |
| --- | --- |
| 月 | 11 時に main から切る（`release/<app>/<yy.ww>`）。未完成の機能は release フラグの裏にある前提で、切った後の修正は重大な不具合だけ |
| 月〜水 | 社内の配布（TestFlight・Play の内部テスト）で、QA の回帰とエージェントの自動の画面の試験。事業者の試験の端末にも配る |
| 木 | 審査に出す |
| 金〜 | 公開。iOS は段階的な公開（7 日）、Android は段階的な公開（1% → 5% → 20% → 50% → 100%、各 1 日以上） |

- 4 つのアプリ（乗客・ドライバー × iOS・Android）を同じ列車で出す。ドライバーのアプリは、週末の夜（金・土の 18 時〜翌 6 時）に広げない（段階を進めない）。乗務の最中の更新の失敗を避けるため。
- 段階を進める基準：クラッシュのない利用者の率 99.8% 以上、ANR の率が前のバージョンより悪くない、オファーの受信の確認までの時間の p95 が前のバージョンより悪くない、出庫の失敗の率が前のバージョンより悪くない。満たさなければ止める（runbook）。
- 乗車の状態機械、位置の送信、オファー、緊急の機能を変えるバージョンは、変更単位の `quality.md` に端末の試験の結果を付ける（区分「安全」の変更は必須。[AGENTS.md](../../AGENTS.md)）。

### 10.2 サポートするバージョン

- サポートするのは、公開した最新のバージョンから 8 つ前の列車のバージョンまで（約 2 か月）。サーバーはその範囲のアプリの形を受け付ける（5.3 節）。
- バージョンは、すべての要求のヘッダー `<Brand>-Client` に `<app>/<platform>/<version>/<build>` で載せる。

### 10.3 強制の更新

サーバーは、アプリと OS ごとに 2 つの値を配る（AppConfig の設定。`GET /v1/client-config` と、すべての応答のヘッダー `<Brand>-Client-Policy`）。

| 値 | 意味 | アプリの振る舞い |
| --- | --- | --- |
| `recommended_min` | これより古いバージョンに更新を勧める | 起動のたびに閉じられる案内を出す |
| `required_min` | これより古いバージョンを止める | 下の表 |

| 場面 | `required_min` より古いとき |
| --- | --- |
| 乗客：依頼の前 | 依頼の画面を塞ぎ、更新を求める（Android は `IMMEDIATE` の更新、iOS は App Store を開く） |
| 乗客：依頼・迎車・乗車の最中 | 塞がない。乗車が終わってから求める |
| ドライバー：入庫・休憩 | 出庫を塞ぎ、更新を求める |
| ドライバー：出庫中（空車） | 新しいオファーを止め（サーバーが候補から外す）、画面で更新を求める |
| ドライバー：迎車・乗車の最中 | 塞がない。降車の後に求める |
| どの場面でも | 緊急の入口と 110・119 の案内は塞がない |

- `required_min` を上げるのは、セキュリティの欠陥、支払いと運賃の誤り、サーバーの互換を保てない変更のときだけ。上げる操作は Dev と Ops の 2 人の承認にする（`delivery.md`）。
- サーバーは、`required_min` より古いアプリの受諾と出庫を 426 で拒否する（アプリの判定をすり抜けた場合の守り）。乗車中の操作（journal）は拒否しない。

## 11. テスト

### 11.1 状態機械

- 5.2 節のベクターを両方のアプリで通す（ADR-0001 の Confirmation）。
- **PROP-APP-001（reducer の決定性）**：同じ入力の列から同じ状態と副作用が出る（Swift は swift-testing と独自の生成器、Kotlin は Kotest の property）。
- **PROP-APP-002（バージョンの単調性）**：任意の順序・重複で届く `TripStateChanged` の列で、画面の元になるサーバーの状態の `trip_version` は減らない。
- **PROP-APP-003（journal）**：通信の断と再接続を任意に挟んでも、journal の操作は `journal_seq` の順に 1 回ずつ送られ、確定したものだけが消える。

### 11.2 位置と電池

- 基準の端末（各 OS で 2 機種）で、4 時間の合成の走行（端末の位置の模擬で動かす）を回し、送信の間隔の分布、欠けた点の割合、電池の消費を計る（4.2 節の目標）。
- OS の終了（Android の `am kill`、iOS のメモリの圧迫）と、許可の取り消しの試験で、4.4 節の回復を確かめる。
- Android の機種ごとの電池の最適化で落ちるかを、端末のクラウド（機種は E9 で選ぶ）で確かめる。

### 11.3 ナビの引き継ぎ

- 引き継ぎ先ごとに、東京の 20 のルート（経由地 2〜8、有料道路の有無）で URL を開き、ナビの案内の線が経由地を順に通るかを、画面の記録で確かめる。結果を `nav_handoff_targets` の「事前確定で使えるか」に反映する。
- URL の組み立ては、経由地の間引き（6.2 節）と文字数の上限を、表駆動のテストで確かめる。

### 11.4 画面

- エージェントが UI の試験（XCUITest・Espresso）を、画面の流れ（3 節）の各行で書く。スクリーンショットの比較は、日本語の文言の折り返しと大きな文字の設定でも行う。
- 緊急の入口が、ログインの後のすべての画面で 1 回のタップで開くことを、画面の一覧から生成した試験で確かめる。

## 12. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E1 | `mobile-proto-codegen` | buf での Swift・Kotlin の生成、`buf breaking`、パッケージの配布（5.3 節） |
| E1 | `mobile-release-train` | 10.1 節の列車の自動化（切る、配る、審査、段階の公開の監視） |
| E1 | `client-version-policy` | 10.2・10.3 節のバージョンのヘッダー、`client-config`、426 の拒否 |
| E9 | `trip-app-test-vectors` | 5.2 節のベクターの生成と両方のアプリの CI（trips の Story と同じ 1 つ） |
| E9 | `rider-request-flow` | 3.1 節の依頼までの画面（検索、ピン、見積もり、同意、依頼） |
| E9 | `rider-trip-tracking` | 迎車中・乗車中の画面、車の位置、バージョンによる表示 |
| E9 | `driver-session-and-onboarding` | 出庫の前の確認と出庫・入庫 |
| E9 | `driver-background-location` | 4 節の許可、状態ごとの取り方、熱と電池、溜めと送り直し（location の Story と同じ 1 つ） |
| E9 | `driver-location-recovery` | 4.4 節の検知と回復のプッシュ |
| E9 | `driver-offer-screen` | オファーの画面、残り時間、受信の確認（notifications と一緒に） |
| E9 | `nav-handoff-waypoints` | 6.2 節の URL、間引き、`nav_handoff_targets`、11.3 節の試験 |
| E9 | `route-deviation-alert` | 6.4 節の端末での逸脱の知らせ |
| E9 | `driver-trip-journal` | 7.1 節の journal と送り直し（trips の `driver-journal-and-replay` と一緒に） |
| E9 | `rider-offline-mode` | 7.2 節 |
| E9 | `driving-mode-ui` | 走行中の操作の制限 |
| E10 | `emergency-dial-on-device` | どの画面にも緊急の入口（safety の Story と同じ 1 つ） |
| E3 | `driver-session-integrity` | App Attest・Play Integrity の判定を出庫で送る（security の Story と同じ 1 つ） |

## 13. 未解決の問い

### 決定

2026-09-27、既定案。

- **OS**：iOS 17 以上（`CLBackgroundActivitySession` のため）、Android 10（API 29）以上。Apple マップへの経由地の引き継ぎは iOS 18.4 以上だけ。
- **位置の許可**：使用中のみ。「常に」と `ACCESS_BACKGROUND_LOCATION` は求めない。
- **取り方**：4.2 節の表。休憩と流しの実車は 10 秒ごと。
- **止まったとき**：60 秒でプッシュ通知、5 分で休憩。
- **ナビ**：Google マップは Maps URLs、Apple マップは統合の Maps URL。経由地は最大 8 つ。守ることを確かめた引き継ぎ先だけを事前確定運賃で出す。
- **逸脱の知らせ**：200 m・30 秒。
- **journal の置き場所**：SQLite（GRDB・Room）。
- **列車**：週 1 回、月曜に切る。サポートは 8 つ前のバージョンまで。
- **強制の更新**：乗車の最中と緊急の入口は塞がない。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| 外部のナビが経由地を守るか（引き継ぎ先ごと） | E9 の試験（11.3 節）。守らない先ばかりなら、アプリの中の案内の表示を厚くするか、ナビの SDK の組み込みを ADR で検討する（ADR-0005 の「アプリ内のナビをしない」を見直すことになる） |
| 車載のナビしか使わない事業者の扱い | 最初の提携先の事業者と、E9 の前に決める |
| 運転中の端末の操作と道路交通法の関係、事業者の器具の条件 | 法務と事業者に確かめる（E9 の前） |
| 事業者が貸す端末（会社の端末）を前提にするか、個人の端末も許すか | 提携先と決める。会社の端末なら、MDM と電池の最適化の設定を事業者が行える |
| 見積もりと目安の文言（L8） | 画面の案を法務が確かめる（E9） |
| Live Activities・Android の進行中の通知で、乗客に迎車の状況を出すか | S1 の後。APNs の `liveactivity` の型の条件を確かめてから |
| アプリの外部送信の SDK の一覧と公表（L4） | 法務の確認待ち |
| 給電なしの電池の目標（10%／時）の妥当性 | E9 の計測で見直す |

## 14. quality.md・runbooks・data-model への項目

### quality.md

- 状態機械のベクターの本数と、両方のアプリでの通過の率（100% であること）。
- 位置の送信の間隔の分布（端末のバージョン・OS・機種ごと）、欠けた点の割合、止まったときの回復の件数と回復までの時間。
- 給電なしの空車の 1 時間の電池の消費（基準の端末）。
- オファーの受信から表示までの時間（端末の中）の p95。
- ナビの引き継ぎの件数、経由地を渡した割合、逸脱の知らせの件数（事前確定の乗車 1,000 件あたり）。
- journal の送信待ちの件数の分布、送信待ちの最長の時間。
- クラッシュのない利用者の率、ANR の率（バージョンごと）、`required_min` より古いバージョンの利用者の割合。

### runbooks

- `mobile-release-halt.md`：段階的な公開を止める基準、止め方（App Store Connect・Play Console）、フラグで機能を切る手順、`required_min` を上げる判断と 2 人の承認。
- `driver-location-stalls.md`：位置の送信が止まるドライバーが急に増えたとき（OS の更新、アプリのバージョン、機種）の切り分けと、事業者への案内。
- `nav-handoff-regression.md`：外部のナビの更新で経由地が守られなくなったときに、`nav_handoff_targets` から外す手順と、ドライバーへの案内。
- `client-min-version-bump.md`：`required_min` を上げる前後の確かめ（乗車中の端末の数、426 の件数）。

### data-model（索引への追加の提案）

| 置き場所 | 中身 |
| --- | --- |
| Protocol Buffers `NavigationHandedOff`（`trip_id`、`target`、`waypoint_count`、`leg`、`at_elapsed_ms`）、`RouteDeviationObserved`（`trip_id`、`max_distance_m`、`duration_s`） | 6.3・6.4 節 |
| AppConfig `client_policy`（アプリ × OS ごとの `recommended_min`・`required_min`） | 10.3 節 |
| AppConfig `nav_handoff_targets`（引き継ぎ先、OS、最低のバージョン、`upfront_allowed`） | 6.2 節 |
| Aurora `trip_nav_events`（`trip_id`、種類、引き継ぎ先、経由地の数、逸脱の距離と時間、`created_at`） | 乗車の記録と同じ保持 |
| リポジトリ `vectors/trip-app/`（JSON） | 5.2 節のテストのベクター |
| 端末の SQLite：`location_backlog`（暗号化、24 時間）、`trip_journal`（確定まで）、`trip_snapshot`（最新 1 件） | 4.3・7.1 節 |
| Aurora `rider_saved_places`（`rider_id`、名前、`rider_confirmed_pin`、`created_at`） | 3.1 節。アカウントの削除で消す |

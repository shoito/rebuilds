# Notifications and realtime push: Uber

乗客とドライバーのアプリへの配信。アプリとの常時の接続、ストリームごとの順序と送り直し、オファーの配信の速さ、車の位置の配信、APNs・FCM のプッシュ通知、SMS（ワンタイムコードと代わりの知らせ）を決める。

前提となる決定は、乗車の事象は outbox から少なくとも 1 回配り、購読する側が版で古い事象を捨てること（[ADR-0022](../decisions/0022-trip-outbox-and-offline-continuation.md)）、オファーは受け取ってから 5 秒で受信の確認がなければ取り下げること（[ADR-0015](../decisions/0015-offer-protocol-decision-log-and-replay.md)）、位置の上りは HTTPS で常時の接続と分けること（[ADR-0009](../decisions/0009-location-upload-and-validation.md)）、Go のサービスを増やすには ADR が要ること（[ADR-0001](../decisions/0001-platform-and-stack.md)）、NFR-008（状態の配信 p95 2 秒、車の位置の表示の遅れ p95 6 秒）。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0030](../decisions/0030-realtime-grpc-bidirectional-stream-gateway.md) | アプリとの常時の接続は、gRPC の双方向ストリーム 1 本（HTTP/2、TLS）にする。受け手は Go の `rt-gateway`（ADR-0001 の Go のサービスに加える）。接続の持ち主は Valkey の登録表で引き、ノード宛ての Valkey の Pub/Sub で渡す。WebSocket と MQTT は採らない |
| [0031](../decisions/0031-per-stream-sequence-redelivery-push-and-sms.md) | 配信は受け手のストリームごとの `seq` で順序をつけ、Valkey の Stream に TTL つきで残し、アプリの受信の確認（`Ack`）まで送り直す。取りこぼしは `seq` の飛びで検知して取り直し、正しさは API の読み直しが持つ。接続がないか 1.5 秒で確認がないオファー・状態の変化は、APNs・FCM の利用者に見える通知で送る。SMS はワンタイムコードと、到着の代わりの知らせ（1 乗車 1 回）だけにし、国内の携帯の会社に直接つなぐ提供者を主にする |

## 1. 目的と範囲

- 扱う：常時の接続の方式と手順、認証、心拍、再接続、配信の単位と順序と送り直し、優先度と TTL、オファーの配信の速さの予算、乗車の相手への車の位置の配信、プッシュ通知（APNs・FCM）、SMS、通知の文言と個人の情報の扱い。
- 扱わない：事象の中身と outbox（[trips-lifecycle.md](trips-lifecycle.md)）、オファーの期限と取り下げの判定（[dispatch-and-matching.md](dispatch-and-matching.md) の 8 節）、アプリの画面と reducer（[rider-and-driver-apps.md](rider-and-driver-apps.md)）、位置の上り（[location-ingestion.md](location-ingestion.md)）、乗車の共有のページ（[safety-and-trust.md](safety-and-trust.md)）、端末のトークンの発行（`security.md`）。
- 事業者の管理画面とサポートのツール（Web）の即時の更新は、Server-Sent Events で足りるとし、[support-and-operations-tools.md](support-and-operations-tools.md) で扱う。

## 2. 本家の形（確かめたこと）

| 項目 | 本家（公開情報） | この設計 |
| --- | --- | --- |
| 配信の基盤 | RAMEN（Real-time Asynchronous MEssaging Network）。何を・いつ送るかを決める Fireball、中身を作る API の層、接続を持つストリーミングのサーバーに分ける。メッセージは高・中・低の優先度と、数秒〜30 分の TTL を持ち、高い優先度は送り直しとリージョンの間の複製を受ける。`seq` で再開でき、少なくとも 1 回。心拍は 4 秒ごと、7 秒で再接続。受信の確認は 30 秒ごと（[Uber's Real-Time Push Platform](https://www.uber.com/gb/en/blog/real-time-push-platform/)、2020-12） | 優先度・TTL・`seq` の考え方を採る（4・5 節） |
| SSE から gRPC へ | SSE では、書いたメッセージが届いたかが最大 30 秒分からず、期限の短いドライバーのオファーを送り直せなかった。gRPC の双方向ストリームで、受信の確認を同じ接続の逆向きですぐ返すようにした。心拍は 5 秒。QUIC で遅延の裾が 10〜30% 良くなった。接続の遅れの p95 は 45% 以上良くなり、配信の成功率は 1〜2% 上がった。gRPC が使えないときは SSE に戻る仕組みを持つ（[Uber's Next Gen Push Platform on gRPC](https://www.uber.com/us/en/blog/ubers-next-gen-push-platform-on-grpc/)、2022-08） | gRPC の双方向ストリームを S1 から使う（ADR-0030）。QUIC は S1 では使わない（9 節） |

いずれも 2026-09-27 に確認。

## 3. 常時の接続（[ADR-0030](../decisions/0030-realtime-grpc-bidirectional-stream-gateway.md)）

### 3.1 構成

```
Trips ── outbox ──▶ 中継 ──▶ SNS trips-events ──▶ SQS rt-fanout ──▶ rt-router（TypeScript）
                                                                     │ 1. 受け手のストリームに XADD（seq を振る）
                                                                     │ 2. 接続の登録表を引く
                                                                     ▼
                                                          Valkey  PUBLISH gw:{node}
                                                                     ▼
アプリ ◀── gRPC 双方向ストリーム ── ALB（rt.<domain>、gRPC） ── rt-gateway（Go、ECS、タスクあたり最大 2 万接続）
   │                                                                  │ Ack(seq)・OfferDelivered
   └──────────────────────────────────────────────────────────────────┘──▶ Trips（受信の確認）

Kinesis loc-<city> ──▶ trip-location-fanout（Go、rt-gateway と同じバイナリの別の役）──▶ Valkey PUBLISH gw:{node}（位置は一時のメッセージ）

rt-router ── 接続がない・確認がない ──▶ push-sender（TypeScript）──▶ APNs・FCM
```

- `rt-gateway` は、接続と、受け手ごとの未確認のメッセージの窓だけを持つ。DB に書かない。すべて再接続で作り直せる（Slack の題材の [realtime.md](../../../slack/docs/architecture/realtime.md) と同じ原則）。
- `rt-router` は、どの受け手に何を送るかを決める。事象の型ごとの規則（6 節の表）で、乗客・ドライバーのどちらに、どの優先度と TTL で送るかを決める。
- 正しさは API の読み直しが持つ。常時の接続とプッシュ通知は、速く知らせるための経路で、落ちてもアプリは `GET /v1/me/active` と `GET /v1/trips/{id}` で追いつける。

### 3.2 方式の比べ方

| 観点 | gRPC の双方向ストリーム | WebSocket | MQTT |
| --- | --- | --- | --- |
| 型 | Protocol Buffers をそのまま使える（ADR-0001） | 独自の枠組みと型の対応が要る | 中身は自由。トピックと ACL の設計が要る |
| 受信の確認 | 逆向きのストリームで即時 | 独自に作る | QoS 1 で持つ |
| 複数の流れ | HTTP/2 の流れで、心拍と中身を分けられる | 1 本の流れ | 1 本 |
| 基盤 | ALB が gRPC を HTTP/2 のまま転送する（[ALB の gRPC 対応](https://aws.amazon.com/about-aws/whats-new/2020/10/application-load-balancers-enable-grpc-workloads-end-to-end-http-2-support/)、2020-10、2026-09-27 に確認） | ALB で使える | ブローカーが要る（AWS IoT Core か自前） |
| 端末のライブラリ | grpc-swift、grpc-kotlin（OkHttp） | OS の標準 | 追加のライブラリ |
| 本家 | SSE から gRPC へ移った（2 節） | — | — |

- gRPC を選ぶ。本家が SSE で困った点（受信の確認の遅れ）を最初から避け、型の生成を 1 つにできる。
- WebSocket は、Web のクライアントがない（アプリだけ）ので利点が小さい。MQTT は、トピックの権限を乗車ごとに付け外しする仕組みが要り、IoT Core の料金と接続の上限の検討が増える。

### 3.3 接続の手順

```proto
service Realtime {
  rpc Connect(stream ClientFrame) returns (stream ServerFrame);
}

message ClientFrame {
  oneof kind {
    Hello hello = 1;       // 最初の 1 件
    Ack ack = 2;           // 受け取った seq（累積）
    OfferDelivered offer_delivered = 3;
    Heartbeat heartbeat = 4;
    AppState app_state = 5; // foreground / background（プッシュの判断に使う）
  }
}

message Hello {
  string protocol = 1;          // "<brand>.realtime.v1"
  string device_id = 2;         // 端末ごとに固定
  uint64 resume_after_seq = 3;  // 最後に適用した seq（初回は 0）
  string stream_epoch = 4;      // 前回の ready で受けた値
  string client = 5;            // <app>/<platform>/<version>/<build>
}

message ServerFrame {
  oneof kind {
    Ready ready = 1;            // stream_epoch、head_seq、resync_required
    Envelope envelope = 2;
    Ephemeral ephemeral = 3;    // 車の位置など、seq を持たない
    Heartbeat heartbeat = 4;
    Goaway goaway = 5;          // 配備の切り替え。再接続の待ちの時間つき
  }
}
```

- **認証**：gRPC のメタデータにアクセストークンを付ける。`rt-gateway` はトークンの署名と期限を確かめ、受け手の鍵（`rider:{rider_id}` か `driver:{driver_id}`）を決める。トークンの期限の 60 秒前に、アプリが新しいトークンで張り直す。
- **1 つの受け手の接続は 1 本。** 同じ受け手の新しい接続が来たら、古い接続に `Goaway(reason=replaced)` を送って閉じる。同じアカウントで 2 台の端末に同時にログインしない（ドライバーは出庫のセッションが 1 つ。乗客は後の端末を優先する）。
- **心拍**：両方向とも 20 秒ごとに `Heartbeat` を送る。40 秒受けなければ切る。ALB の待ちの時間切れ（既定 60 秒）より短くする。ALB は HTTP/2 の PING に対応せず、PING は待ちの時間切れを延ばさないので、アプリの層の心拍にする（[Edit attributes for your Application Load Balancer](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-load-balancer-attributes.html)、2026-09-27 に確認）。
- **ALB の接続の寿命**：ALB は接続の開始から HTTP client keepalive duration（既定 1 時間）が過ぎると `GOAWAY` を送る（同じ文書）。`rt.<domain>` の ALB は 86,400 秒（24 時間）にする。`GOAWAY` を受けたアプリは、下の再接続の手順で張り直す（乗車中の `resume_after_seq` で抜けはない）。
- **再接続**：切れたら 0.5 秒・1 秒・2 秒…最大 30 秒の指数的な待ち（揺らぎつき）で張り直す。ドライバーのアプリがオファーを待つ空車のときは、最初の 3 回を 0.5 秒間隔にする。
- **配備**：`rt-gateway` を入れ替えるときは、`Goaway` に 0〜30 秒のばらつかせた待ちを付け、再接続を分散させる。

### 3.4 接続の登録表

- Valkey `conn:{recipient}` に `(node_id, connection_id, stream_epoch, connected_at)` を TTL 90 秒で置き、心拍ごとに延ばす。
- `rt-router` は登録表を引き、`gw:{node_id}` に PUBLISH する。ノードは自分の宛ての 1 つのチャンネルだけを購読する。
- 登録表が古い（ノードが落ちた）ときは、PUBLISH が誰にも届かない。受信の確認が来ないので、1.5 秒でプッシュの経路に回る（5.3 節）。

## 4. 配信の単位（[ADR-0031](../decisions/0031-per-stream-sequence-redelivery-push-and-sms.md)）

### 4.1 ストリームと seq

- **受け手ごとに 1 本のストリーム**（`rider:{id}`・`driver:{id}`）を持ち、`seq` は受け手ごとに 1 から単調に増える。乗車ごとではなく受け手ごとにするのは、ドライバーにはオファー・乗車・休憩の知らせが 1 本の順序で届く必要があるため。
- ストリームは Valkey の Stream（`XADD rs:{recipient}`）に置く。`seq` は `INCR seq:{recipient}` で振り、Stream の項目に入れる。長さは 500 件、最も古い項目が 30 分を超えたら消す（本家の TTL の上限に合わせた）。
- Valkey のフェイルオーバーで `seq` が戻ったり、Stream が消えたりしうる。そのとき `stream_epoch`（Valkey の新しい鍵ごとの乱数）が変わり、アプリは `Ready.resync_required=true` を受けて、API で全体を読み直す。**Valkey は正本ではない。**

```proto
message Envelope {
  uint64 seq = 1;
  string stream_epoch = 2;
  Priority priority = 3;          // HIGH / NORMAL / LOW
  int64 expires_at_ms = 4;        // サーバーの時刻。過ぎたら送らない・アプリは適用しない
  string dedupe_key = 5;          // 同じ鍵の古いものを置き換える（例：trip:{id}:eta）
  oneof payload {
    OfferCreated offer_created = 10;
    OfferRevoked offer_revoked = 11;
    TripStateChanged trip_state_changed = 12;   // TripSnapshot を含む
    TripEtaUpdated trip_eta_updated = 13;
    DriverSystemNotice driver_system_notice = 14; // 自動の休憩、更新の要求など
    SafetyNotice safety_notice = 15;            // 「大丈夫ですか」など
    ChatMessage chat_message = 16;
  }
}
```

### 4.2 受信の確認と送り直し

- アプリは、`Envelope` を reducer に渡して保存した後、`Ack(seq)` を返す。確認は累積（`seq` 以下をすべて受け取った）。
- `rt-gateway` は、接続ごとに未確認の窓（最大 64 件）を持ち、2 秒で確認がなければ同じ接続で 1 回送り直す。再接続では、`resume_after_seq` の次から Stream を読み直して送る。
- アプリは、`seq` が今までの最大以下なら捨てる（重複）。`seq` が飛んだら（`最大 + 1` でない）、`Ready` の後に `GET /v1/me/stream?after_seq=N` で取り直す。Stream に残っていなければ、API で全体を読み直す。
- **事象の版**：`TripStateChanged` は `trip_version` を持つ。`seq` の順と `trip_version` の順が入れ替わることがある（outbox の配信は順序を保証しない）。アプリは `trip_version` の大きいものだけを採る（[rider-and-driver-apps.md](rider-and-driver-apps.md) の 5.1 節）。

### 4.3 優先度と TTL

| 事象 | 受け手 | 優先度 | TTL | `dedupe_key` | 接続がないとき |
| --- | --- | --- | --- | --- | --- |
| `OfferCreated` | ドライバー | HIGH | オファーのサーバーの期限（作成 ＋ 16.5 秒。表示は受け取ってから 15 秒） | なし | 即時にプッシュ（5.3 節） |
| `OfferRevoked` | ドライバー | HIGH | 60 秒 | `offer:{id}` | プッシュ（前の通知を置き換える） |
| `TripStateChanged`（受諾・到着・取り消し・完了） | 両方 | HIGH | 30 分 | なし | プッシュ |
| `TripStateChanged`（上以外） | 両方 | NORMAL | 30 分 | なし | 送らない（開いたときに読み直す） |
| `TripEtaUpdated` | 乗客 | LOW | 2 分 | `trip:{id}:eta` | 送らない |
| `DriverSystemNotice` | ドライバー | NORMAL | 10 分 | 種類ごと | プッシュ |
| `SafetyNotice` | 両方 | HIGH | 10 分 | `safety:{incident}` | プッシュ |
| `ChatMessage` | 両方 | NORMAL | 乗車の終わりまで | なし | プッシュ |

- 同じ接続の送り順は、HIGH を先にし、同じ優先度の中は `seq` の順にする。
- TTL を過ぎた項目は送らない。アプリも `expires_at_ms`（サーバーの時刻と、`Ready` で受けた時刻の差で直す）を過ぎたものは適用しない。

## 5. オファーの配信（ADR-0015 との合わせ方）

### 5.1 速さの予算

ADR-0015：Trips がオファーを作ってから 5 秒で `OfferDelivered` がなければ取り下げる。この 5 秒に、配信と表示のすべてを入れる。

| 区間 | 予算（p95） | 予算（p99） |
| --- | --- | --- |
| コミット → outbox の中継が読む（`LISTEN/NOTIFY`、最長 50 ms の見回り） | 60 ms | 120 ms |
| 中継 → SNS → SQS → `rt-router` | 200 ms | 500 ms |
| `rt-router`：XADD・登録表・PUBLISH | 20 ms | 50 ms |
| `rt-gateway` → 端末（携帯の網） | 400 ms | 1,500 ms |
| 端末：reducer・保存・表示 | 150 ms | 300 ms |
| `OfferDelivered` → `rt-gateway` → Trips | 400 ms | 1,500 ms |
| **合計** | **約 1.2 秒** | **約 4 秒** |

- **目標**：オファーの作成から `OfferDelivered` を Trips が記録するまで、p95 1.5 秒、p99 4 秒。これで NFR-008 の p95 2 秒に収まり、ADR-0015 の 5 秒の取り下げは p99 の外の失敗だけになる。
- SNS と SQS の区間の遅れは **未検証**。E6 の `offer-delivery-path` で計り、p95 が 300 ms を超えたら、中継から `rt-router` へ直接渡す経路（Valkey の Stream への直接の書き込み）を加える ADR を書く（[trips-lifecycle.md](trips-lifecycle.md) の持ち越しの問いへの答えは「S1 は SNS を経る。計測で足りなければ直接の経路を足す」）。

### 5.2 `OfferDelivered` の意味

- アプリは、オファーの画面を表示した後（描画の完了の通知の後）に `OfferDelivered(offer_id, shown_elapsed_ms)` を送る。受け取っただけでは送らない。ドライバーが見られない状態で「届いた」としないため。
- 常時の接続がつながっていれば、`ClientFrame.offer_delivered` で送り、`rt-gateway` が Trips の `MarkOfferDelivered` を呼ぶ。つながっていなければ、アプリは `POST /v1/driver/offers/{id}/delivered` で送る。
- 画面が消えている（端末が眠っている）ときは、フォアグラウンドサービスか背景の位置の実行で、アプリは動いている（ADR-0007）。アプリはオファーを受けたら、優先度の高い通知（Android は heads-up の通知、iOS は時間に敏感な通知）で知らせ、表示できたら送る。
- **Android の全画面の通知は既定にしない。** Android 14 を対象にするアプリで `USE_FULL_SCREEN_INTENT` を使えるのは通話と目覚ましのアプリだけで、Google Play はそれ以外のアプリの既定の許可を取り消す（[Android 14 の動作の変更](https://developer.android.com/about/versions/14/behavior-changes-14)、2026-09-27 に確認）。配車のオファーはこれに当たらないので、全画面の通知は `NotificationManager.canUseFullScreenIntent()` が真のとき（利用者が設定で許可したとき）だけ使い、既定は heads-up の通知にする。オファーの 15 秒の表示の時間と 5 秒の受信の確認（ADR-0015）は、この既定で計る（2026-09-28 に確定。QA が E9 で確かめる）。

### 5.3 プッシュに回す条件

| 条件 | 振る舞い |
| --- | --- |
| 登録表に接続がない | オファーは即時にプッシュ（HIGH）。他の HIGH も即時 |
| 接続はあるが、1.5 秒で `Ack` がない | プッシュも送る（両方で届いてよい。アプリは `offer_id` で重複を捨てる） |
| アプリが `AppState=background` を知らせている乗客 | 状態の変化（HIGH）は、常時の接続とプッシュの両方で送る |

## 6. 車の位置の配信

- 乗客は、受諾から降車まで、割り当てのドライバーの位置を地図で見る（NFR-008：表示の遅れ p95 6 秒）。
- `trip-location-fanout` は、Kinesis の `loc-<city>` を拡張ファンアウトの読み手として読む（読み手は S1 で 5 つ目。上限は 20。[location-ingestion.md](location-ingestion.md) の 6 節）。
- 有効な割り当ての表（`driver_id → (trip_id, rider_id, assignment_epoch, 状態)`）を、`driver.assignment_changed` の事象（SQS）でメモリに持つ。`ACCEPTED`〜`ON_TRIP` のドライバーの点だけを、その乗客に `Ephemeral(DriverLocation)` として送る。
- 送る点は、索引に使った点（`USE_FOR_INDEX`）の最新の 1 点だけ。4 秒に 1 回。`seq` を持たず、送り直さず、Stream にも残さない。アプリは `sample_t` の古い点を捨てる。
- 乗車の終わり（`completed`・取り消し）の事象を受けたら、その場で送るのを止める。事象が遅れても、`assignment_epoch` が変われば止まる。
- **乗車の相手でない人に位置を送らない**（[AGENTS.md](../../AGENTS.md)）。送り先は、表の `rider_id` の接続だけ。乗車の共有のページは別の経路（[safety-and-trust.md](safety-and-trust.md) の 3 節）。
- ドライバーのアプリには、乗客の位置を送らない（乗車地のピンだけ）。

| 区間 | 予算（p95） |
| --- | --- |
| 端末の測位 → 送信（4 秒ごとのまとめ） | 最大 4 秒（平均 2 秒） |
| 取り込み → Kinesis → `trip-location-fanout` | 500 ms |
| → `rt-gateway` → 乗客の端末 | 500 ms |
| 描画 | 100 ms |
| **合計** | **約 5.1 秒**（NFR-008 の 6 秒に収まる） |

## 7. プッシュ通知

### 7.1 APNs

事実（2026-09-27 に確認。[Sending notification requests to APNs](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns)）：`apns-priority` は 10（すぐ）・5（電力を考えて）・1。`apns-expiration` が 0 なら、届かなければ保存しない。`apns-collapse-id` は同じ値の通知を最新の 1 つにまとめる。`apns-push-type` は `alert`・`background`・`voip`・`liveactivity` など。本体は 4 KB まで。

| 事象 | `apns-push-type` | `apns-priority` | `apns-expiration` | `apns-collapse-id` | `interruption-level` |
| --- | --- | --- | --- | --- | --- |
| オファー | `alert` | 10 | オファーの期限 | `offer-{offer_id}` | `time-sensitive` |
| 受諾・到着・取り消し・完了 | `alert` | 10 | ＋30 分 | `trip-{trip_id}` | `time-sensitive` |
| 位置の送信が止まった（ADR-0007） | `alert` | 10 | ＋10 分 | `loc-stall` | `time-sensitive` |
| メッセージ | `alert` | 10 | 乗車の終わり | なし | `active` |

- 背景の通知（`content-available`）には頼らない。優先度 5 で、OS の判断で遅れうる。
- 時間に敏感な通知（`time-sensitive`）の権利（entitlement）を、ドライバーのアプリと乗客のアプリで申請する。

### 7.2 FCM

事実（2026-09-27 に確認。[Set and manage Android message priority](https://firebase.google.com/docs/cloud-messaging/android-message-priority)）：高い優先度は、眠っている端末を起こしてすぐ届けようとする。利用者に見える通知にならない高い優先度の送信が続くと、7 日の振る舞いから普通の優先度に落とされうる。

- オファー・状態の変化・位置の停止は、`android.priority=high`、`ttl` は APNs の期限と同じ。受けたアプリは必ず利用者に見える通知を出す（落とされないため）。
- データのメッセージで受け、通知の見た目はアプリが作る（オファーは優先度の高い通知。全画面は許可のあるときだけ。5.2 節）。通知の本体は 4 KB まで。
- 普通の優先度は使わない（S1 で送る通知は、どれも時間に敏感なため）。

### 7.3 中身と個人の情報

- 通知の本体には、`event_type`、`trip_id`・`offer_id`、表示の文言（短い）だけを入れる。緯度経度、住所、相手の電話番号、運賃の額を入れない（ロック画面に出るため）。
- 表示の文言の例：「配車のリクエストがあります（迎車 約 4 分）」「車が到着しました（品川 500 あ 12-34）」。車両の番号は、乗客が車を見分けるために出す。
- 端末のプッシュのトークンは `device_push_tokens` に持つ。APNs の 410、FCM の `UNREGISTERED` で消す。ログアウトで消す。

### 7.4 送る仕組み

- `push-sender`（TypeScript、ECS）は、SQS `push-requests` から取り、APNs（HTTP/2、トークンの認証）と FCM（HTTP v1）に送る。
- 同じ `(recipient, dedupe_key)` の送信は 10 秒の間 1 回にする（Valkey の `SET NX`）。
- 提供者の 429・5xx は、TTL の中で指数的に待って送り直す。TTL を過ぎたら捨てる。

## 8. SMS

### 8.1 使う場面

| 場面 | 受け手 | 上限 |
| --- | --- | --- |
| ワンタイムコード（ログイン、電話番号の変更） | 乗客・ドライバー | 1 番号 1 時間に 5 回、1 日に 10 回。1 つの IP から 1 時間に 20 回 |
| 到着の代わりの知らせ：`arrived` から 60 秒たっても、乗客の端末が到着の事象を確認していない（接続もプッシュの確認もない） | 乗客 | 1 乗車 1 回 |
| 緊急の後の連絡の依頼（運用が送る） | 乗客・ドライバー | 運用の操作ごと。監査ログ |

- 乗車の共有のリンクは、この基盤から SMS で送らない。乗客の端末の共有の機能（OS の共有のシート）で、乗客が送る（[safety-and-trust.md](safety-and-trust.md) の 3 節）。第三者の番号に、この基盤が SMS を送る経路を作らない。
- 宣伝の SMS は送らない。

### 8.2 ワンタイムコード

- 6 桁、期限 5 分、試せるのは 5 回。コードは HMAC で保存し、平文で持たない。
- 送信の前に、番号が日本の携帯の番号（`+81 70/80/90`）であることを確かめる。国際の番号への送信は S1 で行わない（SMS の料金を悪用する攻撃を避ける）。
- 同じ端末・IP・番号の帯からの急な増加は、端末の完全性の確認（App Attest・Play Integrity）を求める。

### 8.3 提供者

- 主：国内の携帯の 4 社に直接つなぐ提供者（候補は NTT コム オンラインの空電プッシュ、メディア4u のメディア SMS など。届く率を公表している提供者がある。[ネクスウェイの解説](https://smslink.nexway.co.jp/column/161)、2026-09-27 に確認。各社の SLA と料金は **未検証**。E1 の `sms-otp` の選定で確かめる）。
- 副：国際の経路の提供者（Twilio）。Twilio の日本の SMS は、国際の経路なら登録なしで英数字の送信者 ID を使え、KDDI の網で 5 分割を超える SMS は遅れうる（[Twilio の日本の SMS の指針](https://www.twilio.com/en-us/guidelines/jp/sms)、2026-09-27 に確認）。ワンタイムコードは 1 通に収める。
- 主の提供者が 30 秒で受け付けないか、5 分の失敗の率が 20% を超えたら、副に切り替える。
- 提供者の選定は E1 で、届くまでの時間の p95（目標 10 秒）、4 社への直接の接続、料金、データの所在で行う。

## 9. 規模と上限（S1）

| 項目 | 値 |
| --- | --- |
| 接続の数 | ドライバー 1 万（出庫中は常時）＋ 乗客（依頼から降車まで、ピークで 2 万を見込む）＝ 約 3 万 |
| `rt-gateway` | 1 タスク 2 万接続を見込み、3 AZ に 2 つずつ（**未検証**。E6 の負荷試験で決める） |
| メッセージ | オファー 30〜100 件/秒、状態の変化 数百件/秒、車の位置 2 万件/4 秒 ＝ 5,000 件/秒（ピーク） |
| Valkey | Stream と登録表とノードのチャンネル。専用のクラスター（索引と分ける） |
| QUIC | S1 は使わない。ALB が HTTP/3 を gRPC のまま通せるかと、端末の Cronet の導入の手間を確かめてから（本家は 10〜30% 裾が良くなったとする。2 節） |

## 10. 失敗のしかた

| 失敗 | 起きること | 抑え方 |
| --- | --- | --- |
| `rt-gateway` の 1 タスクが落ちる | その接続が切れる | アプリが再接続。未確認の項目は Stream から送り直す。オファーは 1.5 秒でプッシュにも回る |
| Valkey のフェイルオーバー | `seq` と Stream が失われうる | `stream_epoch` が変わり、アプリは API で読み直す。オファーはプッシュと API の読み直しで拾う |
| SNS・SQS が遅い | 配信が遅れる | オファーの取り下げ（5 秒）が増える。`OfferDelivered` の遅れと取り下げの率で気づく（runbook） |
| APNs・FCM の障害 | 接続のない端末に届かない | アプリを開けば API で追いつく。ドライバーは出庫中は接続があるので影響は小さい |
| SMS の提供者の障害 | ワンタイムコードが届かない | 副の提供者に切り替え。ログイン中の利用者には影響しない |
| 再接続の殺到（網の障害の復旧、配備） | `rt-gateway` と Valkey の負荷 | 待ちの揺らぎ、`Goaway` の待ちの分散、`Hello` の受け付けの流量の制限（ノードあたり 1 秒に 500） |
| ALB の待ちの時間切れ | 静かな接続が切れる | 20 秒ごとのアプリの層の心拍 |

## 11. セキュリティとプライバシー

- 受け手の鍵は、トークンから `rt-gateway` が決める。アプリが受け手を名乗る値を送っても使わない。
- 車の位置は、有効な割り当ての乗客の接続にだけ送る（6 節）。`trip-location-fanout` のメモリの表は、事象の `assignment_epoch` が今より古ければ更新しない。
- Stream の中身（`TripSnapshot`）の乗車地・降車地は、`street` に丸めた値（[trips-lifecycle.md](trips-lifecycle.md) の 8.2 節）。オファーの乗車地は正確な値（受諾すれば迎車するため。ADR-0015）で、TTL はオファーの期限まで。
- メッセージ（`ChatMessage`）は、定型文と自由な文の両方を、乗車の終わりから 30 日保持する（安全の調べのため。期間は法務の確認待ち、L4・L7）。サポートが読むときは理由と監査ログを必須にする。
- プッシュの本体と SMS の本文に、位置・住所・電話番号・額を入れない（7.3 節）。
- ログには受け手の ID と `seq` だけを書き、本体を書かない。

## 12. テスト

### 12.1 性質ベーステスト

- **PROP-RT-001（順序と重複）**：任意の送り直し・重複・再接続・`rt-gateway` の入れ替えの列で、アプリが適用する `Envelope` は `seq` の昇順で、各 `seq` は高々 1 回。
- **PROP-RT-002（取りこぼしの回復）**：Stream の項目を任意に失わせても、アプリの最後の状態は、API の読み直しの後、サーバーの状態と一致する。
- **PROP-RT-003（位置の宛先）**：任意の割り当ての事象の列（遅れ・重複・入れ替わりを含む）で、`DriverLocation` は、その時点で有効な割り当ての乗客にだけ送られる。
- **PROP-RT-004（TTL）**：`expires_at_ms` を過ぎた `Envelope` は、送られず、適用されない。

### 12.2 結合・負荷・障害注入

- 3 万接続と S1 のピークの 2 倍のメッセージで、オファーの作成から `OfferDelivered` までの p95・p99 を計る（5.1 節の目標）。区間ごとに計る。
- 携帯の網の模擬（遅延 300 ms、損失 5%、30 秒の切断）で、取り下げの率と再接続の時間を計る。
- `rt-gateway` の強制終了、Valkey のフェイルオーバー、SNS・SQS の遅延の注入で、PROP-RT-001・002 と、オファーがプッシュの経路で届くことを確かめる。
- APNs・FCM は、提供者の試験の環境と模擬のサーバーで、`apns-expiration`・`collapse-id`・FCM の `ttl` の設定を確かめる。

## 13. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E6 | `rt-proto-contract` | 3.3・4.1 節のメッセージの定義と生成 |
| E6 | `rt-gateway` | 接続・認証・心拍・未確認の窓・`Goaway`（Go） |
| E6 | `rt-router-and-streams` | 事象の規則（4.3 節）、Valkey の Stream と `seq`、登録表、ノード宛ての PUBLISH |
| E6 | `offer-delivery-path` | `OfferDelivered` の経路と Trips への連携、5.1 節の計測（dispatch・trips と一緒に） |
| E6 | `trip-location-fanout` | 6 節の位置の配信（PROP-RT-003） |
| E6 | `push-sender` | APNs・FCM、トークンの管理、重複の抑制（7 節） |
| E6 | `realtime-load-test` | 12.2 節 |
| E1 | `sms-otp` | ワンタイムコード、流量の制限、提供者の切り替え（8 節） |
| E9 | `app-realtime-client` | 両方のアプリの接続・再接続・`seq` の扱い・取り直し（apps と一緒に） |
| E9 | `offer-full-screen-notification` | 優先度の高い通知（全画面は許可のあるときだけ。5.2 節）と表示の後の `OfferDelivered` |
| E10 | `arrival-sms-fallback` | 到着の代わりの SMS（1 乗車 1 回） |

## 14. 未解決の問い

### 決定

2026-09-27、既定案。

- **方式**：gRPC の双方向ストリーム 1 本。Go の `rt-gateway`（ADR-0001 の Go のサービスに加える）。
- **順序**：受け手ごとのストリームと `seq`。Valkey の Stream に 500 件・30 分。
- **送り直し**：接続の中で 2 秒で 1 回、再接続で Stream から、なければ API で読み直す。
- **オファー**：作成から `OfferDelivered` まで p95 1.5 秒・p99 4 秒。表示の後に送る。1.5 秒で確認がなければプッシュも送る。
- **outbox からの経路**：S1 は SNS → SQS を経る。計測で足りなければ直接の経路を足す。
- **車の位置**：Kinesis の拡張ファンアウトから、有効な割り当ての乗客にだけ、`seq` なしで送る。
- **プッシュ**：すべて利用者に見える通知で、高い優先度。背景の通知に頼らない。
- **SMS**：ワンタイムコードと到着の代わりの知らせだけ。国内の直接の接続の提供者を主に、Twilio を副に。国際の番号へは送らない。

### 決定（2026-09-28、推奨案で確定）

- **Android のオファーの通知**：既定は優先度の高い heads-up の通知で、全画面の通知は使わない。全画面は、利用者が設定で許可したときだけ（5.2 節）。QA は、E9 でこの既定のまま、表示 15 秒と受信の確認 5 秒（ADR-0015）が守られることを確かめる。
- **事業者の管理画面への即時の更新**：`rt-gateway` と分けた SSE にする（[support-and-operations-tools.md](support-and-operations-tools.md) の 13 節）。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| SNS・SQS の区間の遅れが予算に収まるか | E6 の計測 |
| 位置の上り（ADR-0009）を常時の接続にまとめるか | E3・E6 の電池と通信の量の計測の後。まとめるなら ADR-0009 を置き換える |
| QUIC（HTTP/3）を使うか | S2。ALB の対応と端末のライブラリを確かめてから |
| メッセージの保持の期間（L4・L7） | 法務の確認待ち |
| SMS の提供者 | E1 の選定 |

## 15. quality.md・runbooks・data-model への項目

### quality.md

- オファーの作成から `OfferDelivered` までの p50・p95・p99（区間ごと。5.1 節）、取り下げ（`undelivered`）の率。
- 状態の変化の配信の p95（NFR-008）、車の位置の表示の遅れの p95（端末で計る）。
- 接続の数、再接続の率、`resync_required` の件数、`seq` の飛びの件数。
- プッシュの送信の成功の率（APNs・FCM ごと）、プッシュ経由のオファーの割合。
- SMS の届くまでの時間の p95、失敗の率、提供者の切り替えの回数、ワンタイムコードの流量の制限にかかった件数。
- PROP-RT-001〜004 の実行の数。

### runbooks

- `offer-delivery-degraded.md`：取り下げの率が上がったときの切り分け（中継、SNS・SQS、`rt-router`、`rt-gateway`、携帯の網、アプリの版）と、プッシュの経路への切り替えの確かめ。
- `realtime-reconnect-storm.md`：再接続の殺到のときの `Hello` の流量の制限と、`rt-gateway` の増やし方。
- `valkey-realtime-failover.md`：Stream を失ったときの確かめ方（`resync_required` の急増は正常な振る舞い）。
- `push-provider-outage.md`：APNs・FCM の障害のときの確かめ方と、ドライバーへの案内。
- `sms-provider-failover.md`：SMS の提供者の切り替えと戻し方。
- `sms-pumping.md`：ワンタイムコードの送信の急な増加のときの止め方（番号の帯、IP の遮断、端末の完全性の要求）。

### data-model（索引への追加の提案）

| 置き場所 | 中身 |
| --- | --- |
| Protocol Buffers `ClientFrame`・`ServerFrame`・`Hello`・`Ready`・`Envelope`・`Ephemeral`・`DriverLocation`・`OfferDelivered` | 3.3・4.1 節 |
| Valkey `rs:{recipient}`（Stream、500 件・30 分）、`seq:{recipient}`、`conn:{recipient}`（TTL 90 秒）、`gw:{node}`（Pub/Sub） | 正本ではない |
| Aurora `device_push_tokens`（`user_kind`、`user_id`、`device_id`、`platform`、`token`、`app_version`、`updated_at`） | ログアウト・410 で消す |
| Aurora `otp_challenges`（`phone_hash`、`code_hmac`、`attempts`、`expires_at`、`purpose`） | 24 時間で消す |
| Aurora `sms_messages`（`id`、`purpose`、`recipient_hash`、`provider`、`status`、`sent_at`、`delivered_at`） | 本文を持たない。90 日 |
| Aurora `trip_messages`（`trip_id`、`sender_kind`、`template_id`、`body`、`created_at`） | 乗車の終わりから 30 日（L4・L7 の結論で置き換える） |
| SQS `rt-fanout`、`push-requests` | 事象と送信の要求 |

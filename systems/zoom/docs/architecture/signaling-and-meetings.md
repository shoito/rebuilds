# Signaling and Meetings: Zoom

会議を作って入るまでの流れと、会議の中の状態を動かす仕組み。会議の ID と URL、参加のトークン、Meeting Actor の状態機械とリース・`epoch` によるフェンシング、シグナリングのプロトコル、主催者の操作、再同期、Actor の障害からの 10 秒以内の回復を決める。

前提となる決定は、会議ごとに 1 つの Meeting Actor が状態の正本になる形（[ADR-0005](../decisions/0005-meeting-state-and-signaling.md)）、SFU での中継（[ADR-0002](../decisions/0002-media-topology.md)）、ブラウザの WebRTC と mediasoup-client（[ADR-0003](../decisions/0003-client-platform.md)）、E2EE の会議での MLS の順序付け（[ADR-0004](../decisions/0004-encryption-and-e2ee.md)）。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0006](../decisions/0006-meeting-id-and-join-url.md) | 会議の ID は CSPRNG で作る 11 桁の数字で、秘密として扱わない。URL は `https://<brand>.<domain>/j/<meeting-id>#k=<join-key>` とし、128 ビットの参加の鍵をフラグメントに置く。参加の鍵はパスコードの入力を省くだけで、待合室は省かない |
| [0007](../decisions/0007-meeting-actor-lease-and-epoch.md) | Meeting Actor の持ち主は Valkey のリース（TTL 6 秒、2 秒ごとに更新）で決め、取るたびに `epoch` を 1 つ上げる。持ち主は 4.5 秒更新できなければ自分で止まる。退出させた記録・ロック・役割の変更は、配る前に Aurora に書く |
| [0008](../decisions/0008-signaling-protocol.md) | シグナリングは WebSocket の上の JSON で、Zod のスキーマから型を作る。バージョンは WebSocket のサブプロトコル（`<brand>.sig.v1`）で決め、1 つ前のバージョンまで受ける。状態は `(epoch, seq)` 付きのスナップショットと差分で配り、`epoch` が変わったら必ずスナップショットを送り直す。話者の音量などの一時的なイベントは `seq` を付けずに配る |
| [0009](../decisions/0009-host-controls-enforcement.md) | 主催者の操作は Meeting Actor が決定表で判定し、メディアに関わる操作（ミュート、ビデオの停止、共有の停止）は Media Node で producer を止めて強制する。ミュートの解除とビデオの開始は、本人の同意なしにはしない |

## 1. 目的と範囲

- 扱う：会議の作成（すぐの会議）、会議の ID と URL、参加のトークン、Signaling Gateway と Meeting Actor の接続、Meeting Actor の状態機械、リースとフェンシング、スナップショットと差分、再接続と再同期、主催者の操作の判定と強制、Actor の障害からの回復、メディアの交渉のメッセージ（Media Node へ中継するもの）。
- 扱わない：待合室・パスコード・ロックの規則の中身と、ID の推測への流量の制限（[meeting-security.md](meeting-security.md)）、予定の会議と個人の会議の ID（[scheduling-and-calendar.md](scheduling-and-calendar.md)）、チャットの本文と保持（[chat-and-reactions.md](chat-and-reactions.md)）、MLS のメッセージの中身（[e2ee.md](e2ee.md)）、Media Node の中の転送（[media-server-sfu.md](media-server-sfu.md)）、ICE と TURN（[network-traversal.md](network-traversal.md)）。

## 2. 本家の形（確かめたこと）

| 項目 | 本家（公開情報） | この設計 |
| --- | --- | --- |
| 会議の ID | すぐの会議・予定の会議・繰り返しの会議は 11 桁、個人の会議の ID は 10 桁（[Frequently asked questions about meeting and webinar IDs](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0065196)） | 11 桁は同じ。個人の会議の ID は scheduling-and-calendar.md で決める（ADR-0006） |
| 待合室とパスコード | 2020-09-27 から、どちらかを必ず有効にする（[intent.md](../intent.md) の MVP の出典） | 同じ（meeting-security.md） |
| URL にパスコードを埋める | 設定でパスコードを暗号化して招待のリンクに入れ、1 回のクリックで入れる（[Embedding meeting passcode in invite link](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0065979)）。リンクのどの部分に入るか（クエリか）は書かれていない | 参加の鍵を URL のフラグメント（`#k=`）に置く。サーバーのアクセスログと `Referer` に残らない（ADR-0006） |
| シグナリングの形式 | 公開の一次の資料に書かれていない | JSON＋Zod（ADR-0008） |
| 主催者によるミュートの解除 | 既定は「Ask to Unmute」で、参加者に解除を求め、本人が応じる。参加者が前もって同意していれば、主催者はすぐに解除できる（同意は同じ主催者の会議に続けて効く）（[Muting or unmuting participants in a meeting](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0066716)） | 求めて本人が応じる形だけにする。前もっての同意による解除は MVP では作らない（ADR-0009） |

いずれも 2026-09-27 に確認。

## 3. 構成

```
Browser
  │ HTTPS  POST /v1/meetings, POST /v1/meetings/{id}/join
  ▼
API（Hono）──── Aurora（meetings, meeting_instances, participations, removals）
  │ 参加のトークン（EdDSA、120 秒、1 回限り）
  ▼
Browser ── WSS（サブプロトコル <brand>.sig.v1）── Signaling Gateway（ECS、状態なし）
                                                     │ 会議の ID で持ち主を引く（Valkey）
                                                     │ Actor Host ごとに 1 本の多重化した内部の接続
                                                     ▼
                                               Actor Host（ECS、多数の会議の Actor）
                                                 ├─ Meeting Actor（会議ごとに 1 つ）
                                                 │    検証 → 判定 → seq → 適用 → 配信
                                                 ├─ Valkey：リース、epoch、スナップショット
                                                 ├─ Aurora：失ってはならない変更、outbox
                                                 └─ Media Node の制御の API（mTLS、epoch 付き）
```

- Gateway と Actor Host は別の ECS のサービスにする。Gateway は接続の数で、Actor Host は会議の数と操作の量で増やす。
- Gateway は、Actor Host ごとに 1 本の内部の接続（HTTP/2 の上の双方向のストリーム）を持ち、その上で会議ごとのメッセージを多重化する。
- Actor が配る差分は、Actor Host から Gateway ごとに 1 回だけ送る。Gateway が自分の接続へ分ける（Figma の multiplayer と同じ形）。

## 4. 会議の作成と参加

### 4.1 会議の ID と URL

ADR-0006。

- **会議の ID**：11 桁の 10 進の数字。先頭は 1〜9。CSPRNG から一様に選ぶ。連番にしない。空間は 9×10^10。
- Aurora の `meetings.meeting_number` に一意の索引を置く。衝突したら選び直す。終わった会議の ID は、最後の開催から 2 年は再び使わない（古い招待の URL で別の会議に入るのを防ぐ）。
- **ID は秘密ではない。** 画面に出し、電話からの参加（MVP の後）でも読み上げる。推測で有効な ID に当たる確率は、S3 の見込み（予定を含めて有効な ID が 1,000 万）で 1 回あたり約 1/9,000 である。したがって、ID だけでは会議に入れない形にする（待合室かパスコードを必ず使う。meeting-security.md）。
- **参加の鍵（join key）**：会議ごとに 128 ビットの乱数を作り、base64url（22 文字）で URL に入れる。Aurora には SHA-256 だけを置く。
- **URL**：`https://<brand>.<domain>/j/<meeting-id>#k=<join-key>`
  - フラグメントは HTTP の要求に含まれないので、CDN・ALB のアクセスログと `Referer` に残らない。Web クライアントが読み、参加の要求の本文で送る。
  - 鍵があれば、パスコードの入力を省ける。待合室は省けない。
  - 主催者は「URL を作り直す」で鍵を替えられる。古い鍵は、その時点から使えない。
  - 鍵のない URL（`/j/<meeting-id>`）も有効で、パスコードの入力を求める。

### 4.2 すぐの会議の作成

```
POST /v1/meetings
{ "type": "instant", "topic": "定例", "settings": { "waiting_room": true, "e2ee": false } }

201
{ "meeting_id": "mtg_01J9...",              // 内部の ID（ULID）
  "meeting_number": "84512093376",
  "join_url": "https://<brand>.<domain>/j/84512093376#k=Zk3...",
  "passcode": "482913",                     // 規則は meeting-security.md
  "host_join": { "token": "..." } }         // 作った人がそのまま主催者として入るため
```

- 待合室もパスコードもない設定は、ここで 422 にする（`waiting_room_or_passcode_required`）。組織の強制の設定は accounts-and-admin.md。
- 会議の行を作った時点では、Actor は動かない。最初の参加で起きる（5 節）。

### 4.3 参加のトークン

```
POST /v1/meetings/84512093376/join
{ "join_key": "Zk3...", "passcode": null, "display_name": "山田", "client": { "kind": "web", "protocols": [1] } }

200
{ "join_token": "eyJ...",                 // 120 秒、1 回限り
  "signaling_url": "wss://sig.<brand>.<domain>/v1/ws",
  "ice_servers": [ ... ] }                // network-traversal.md の 5.3 節
```

- 参加のトークンは EdDSA（Ed25519）の署名付き。中身は `meeting_id`、`instance_id`（その回の開催）、`participant_id`（新しく作る）、`user_id`（ゲストは空）、`org_id`、`role_hint`（`host`・`cohost`・`attendee`。アカウントと会議の設定から決まる）、`passcode_ok`、`exp`、`jti`。
- `role_hint` は「その人が主催者として入る資格がある」ことだけを示す。会議の中の役割は Actor が決める（主催者が既にいれば、2 人目は共同主催者にする。9.3 節）。
- トークンは URL に入れない。WebSocket の最初のメッセージ（`hello`）で送る。
- `jti` は Actor が使った記録を Valkey に 10 分置き、2 回目を拒否する。
- パスコードの誤りの回数の制限と、ID の総当たりへの対処は meeting-security.md で決める。API は、存在しない ID とパスコードの誤りを、同じ応答（`404 meeting_not_found_or_passcode_invalid`）と同じ時間で返す。

### 4.4 接続の確立

```
Client                Gateway                 Valkey             Actor Host（持ち主）       Media Node
  │ WSS（<brand>.sig.v1）│                        │                        │                        │
  │ hello{token,resume?}▶│ Origin・トークンの署名と期限を検査                │                        │
  │                      │ GET mtg:{m}:lease ─────▶│                        │                        │
  │                      │   なし → 選んだ Host に acquire を頼む（5.2 節）  │                        │
  │                      │ join(participant, token) ───────────────────────▶│ jti、ban、ロック、待合室 │
  │                      │                        │                        │ （9 節の決定表）         │
  │◀──── welcome{participant_id, epoch, seq, snapshot, status} ────────────│                        │
  │ status=waiting なら待合室の画面。admitted を待つ                          │                        │
  │ media.capabilities ─▶│───────────────────────────────────────────────────▶│ routerRtpCapabilities ─▶│
  │ media.transport.create{direction:send} ...（8.4 節）                                              │
```

- 待合室にいる間は、会議の参加者の一覧もメディアも受け取らない。受け取るのは `waiting.*` の差分だけ（meeting-security.md）。
- `welcome` から最初の音声の送受信までを、NFR-002（p95 3 秒）の予算で見る（11 節）。

## 5. Meeting Actor

### 5.1 会議の状態機械

```
             最初の join             主催者が入る・または「主催者の前に入れる」設定
 Scheduled ───────────▶ Open ─────────────────────────────────────────▶ Live
 （Aurora の行だけ）    （Actor あり。参加者は待合室か                     │
                          「主催者を待っています」）                        │ end_for_all ／ 全員の退出の後 60 秒
                                                                         ▼
                                                                       Ending ──▶ Ended
                                                                   （Media Node の router を閉じ、
                                                                     Aurora に終了を書き、リースを返す）
 どの状態でも：Actor の持ち主が替わる → Recovering（5.4 節）→ 元の状態
```

| 状態 | Actor | メディア | Aurora |
| --- | --- | --- | --- |
| Scheduled | なし | なし | `meetings` の行 |
| Open | あり | 主催者の前に入れる設定なら流れる。そうでなければ流れない | `meeting_instances` を `open` で作る |
| Live | あり | 流れる | `status = live`、`started_at` |
| Ending | あり | 止める | — |
| Ended | なし（リースを返す） | なし | `ended_at`、参加の記録を閉じる |

- 同じ `meetings` の行に対して、同時に動く開催（`meeting_instances`）は 1 つだけにする（部分一意の索引 `WHERE ended_at IS NULL`）。
- 参加者が 0 人になっても、60 秒は Live のまま待つ（主催者の再接続のため）。その後 Ending にする。

### 5.2 参加者の状態機械

```
 Joining ──▶ Waiting ──admit──▶ Admitted ──media 接続──▶ InMeeting
    │           │ deny                                     │ ├─ WS 切断 ──▶ Reconnecting ──60 秒──▶ Left(dropped)
    │           ▼                                          │ │                 └─ resume ──▶ InMeeting
    │         Denied                                       │ ├─ leave ──▶ Left
    └─ 拒否（ban・ロック・定員・E2EE 非対応）─▶ Rejected       │ └─ remove ──▶ Removed（ban に入る）
```

- `Reconnecting` の間、その人は一覧に「再接続中」と出す。Media Node の transport は閉じない（メディアが続いていれば、WS だけが切れている）。
- `Removed` は終わりの状態。同じ `user_id`（ゲストは端末の鍵。meeting-security.md）の再参加は、主催者が許すまで `Rejected(removed)` になる（intent.md の「守るべき振る舞い」）。

### 5.3 リースと epoch

ADR-0007。

| Valkey の鍵 | 値 | 使い方 |
| --- | --- | --- |
| `mtg:{m}:epoch` | 整数 | 取るたびに `INCR`。減らない |
| `mtg:{m}:lease` | `{host_id, epoch}`、TTL 6,000ms | 取る・更新する・返す |
| `mtg:{m}:snap` | スナップショット（10.1 節）、TTL 24 時間 | 間引いて書く |
| `mtg:{m}:jti:{jti}` | 1、TTL 10 分 | 参加のトークンの使い回しの検知 |

`{m}` は Valkey のハッシュタグで、1 つの会議の鍵を同じスロットに置く（1 つの Lua のスクリプトで扱うため）。

- **取る**：Lua のスクリプトで、`lease` がなければ `epoch = INCR epoch` とし、`SET lease {host, epoch} PX 6000` を行い、`epoch` を返す。あれば今の持ち主を返す。
  - Valkey を失うと `epoch` が 1 から数え直しになる。そこで、取るときに下限（Aurora の `meeting_instances.actor_epoch` と、取得を頼む Gateway が見た最大の `epoch` の大きい方＋ 1）を渡し、`epoch = max(INCR, 下限)` にする。Media Node が `stale_epoch` を返したら、応答の `max_epoch` ＋ 1 を下限にして取り直す（[data-model.md](data-model.md) の 11.2 節の 16）。
- **更新する**：2 秒ごとに、`lease` の `{host, epoch}` が自分のものなら `PEXPIRE 6000`。違えば、その時点で自分の Actor を止める。
- **自分で止まる**：最後に更新できた時刻から 4.5 秒たったら、Actor は新しい操作を受けず、Media Node に指示を出さない。TTL（6 秒）との差 1.5 秒は、時計の進みの差と GC の止まりのための余裕である。
- **返す**：Ending の後、または計画した引き渡し（10.3 節）で、自分の `{host, epoch}` のときだけ `DEL`。
- **フェンシング**：Actor が外へ出すすべての指示に `epoch` を付ける。
  - Media Node は、会議ごとに見た最大の `epoch` を覚え、それより小さい指示を `stale_epoch` で拒否する（[media-server-sfu.md](media-server-sfu.md) の 4.3 節）。
  - Gateway は、会議ごとに最後に見た `epoch` を覚え、それより小さい Actor からの差分を捨てる。
  - Aurora への書き込みは、`meeting_instances.actor_epoch <= :epoch` を条件に付けた更新にし、古い持ち主の書き込みを失敗させる。
- Actor Host の選び方：Gateway は、健全な Actor Host の一覧から、会議の ID で rendezvous hashing して選ぶ。偏りは、Host の会議の数の上限（既定 2,000）で抑える。上限に達した Host は、次の候補に回す。

### 5.4 Actor の処理の順序

1. 受け取り口は会議ごとに 1 つの待ち行列。1 件ずつ処理する。ロックは要らない。
2. Zod で形を検査する（失敗は `error{code: invalid_message}`）。
3. 9 節の決定表で判定する。
4. 失ってはならない変更（退出させる、ロック、役割の変更、待合室の設定）は、Aurora に書いてから次へ進む（ADR-0007）。書けなければ `error{code: unavailable}` を返し、状態を変えない。
5. `seq` を 1 つ進め、メモリの状態に当てる。
6. 差分を Gateway に送る。命令を送った人には `ack{id, seq}` を返す。
7. Media Node への指示が要る操作は、差分を送った後に非同期で出す。Node の失敗は、改めて差分（`participant.updated` の `media_error`）で知らせる。

## 6. シグナリングのプロトコル

ADR-0008。

### 6.1 フレームと封筒

- WebSocket のテキストのフレーム。1 フレームに 1 メッセージ。UTF-8 の JSON。
- サブプロトコル：`Sec-WebSocket-Protocol: <brand>.sig.v1`（バージョンごとに 1 つ）。クライアントは対応するバージョンをすべて並べ、Gateway は受ける最新のバージョンを選ぶ。
- WebSocket の圧縮（permessage-deflate）は使わない。メッセージは小さく、接続ごとの圧縮の辞書のメモリに見合わない。

```jsonc
// クライアント → サーバー：命令
{ "t": "cmd", "id": "c-42", "name": "host.mute", "body": { "target": "p_7Q..." } }
// サーバー → クライアント：命令への応答
{ "t": "ack", "id": "c-42", "seq": 1234 }
{ "t": "err", "id": "c-42", "code": "forbidden", "retryable": false }
// サーバー → クライアント：状態の差分（順序あり）
{ "t": "evt", "epoch": 7, "seq": 1235, "name": "participant.muted", "body": { "participant": "p_7Q...", "by": "host" } }
// サーバー → クライアント：スナップショット
{ "t": "snap", "epoch": 7, "seq": 1235, "body": { /* 10.1 節 */ } }
// サーバー → クライアント：一時的なイベント（seq なし、落としてよい）
{ "t": "eph", "name": "audio.levels", "body": { "levels": [["p_7Q", -32], ["p_2M", -45]] } }
// 両方向：生存の確認
{ "t": "ping", "ts": 1790000000123 }   { "t": "pong", "ts": 1790000000123 }
```

- `seq` は、会議の開催（`instance_id`）と `epoch` の中で 1 から増える。`epoch` が変わったら、新しい持ち主はスナップショットから数え直さず、スナップショットの `seq` の続きを使う。クライアントは `(epoch, seq)` の組で順序を比べる。
- 型は Zod のスキーマ（`@<brand>/signaling-schema`）で定義し、Web クライアントとサーバーで共有する。ネイティブのアプリ（Rust）の型は、同じスキーマから生成した JSON Schema から作る（[ADR-0003](../decisions/0003-client-platform.md)）。

### 6.2 主なメッセージ

クライアント → サーバー（`cmd`）：

| name | body | 誰が |
| --- | --- | --- |
| `hello` | `token`、`resume?: {participant_id, epoch, seq}`、`client: {kind, version, protocols, capabilities, features}`。`kind` は `web`・`desktop`・`ios`・`android`・`phone`（`phone` は Phone Bridge。[telephony.md](telephony.md) の 3 節）。`capabilities` は符号器・SVC・Encoded Transform の対応の申告（[clients.md](clients.md) の 2.3 節）。`features` はクライアントが持つ画面の機能の申告（例：`capture_indicator.v1`。[recording-and-transcription.md](recording-and-transcription.md) の 7.1 節） | 全員（最初の 1 通） |
| `self.update` | `muted?`、`video?`、`hand_raised?`、`display_name?` | 本人 |
| `self.leave` | — | 本人 |
| `state.report` | 10.2 節 | 本人（再同期のとき） |
| `state.sync` | `epoch`、`seq`（手元の最後）。`seq` の飛びを見つけたときの差分の求め直し（7 節） | 本人 |
| `media.capabilities` ・ `media.transport.create` ・ `media.transport.connect` ・ `media.produce` ・ `media.consume.resume` ・ `media.producer.close` | 8 節 | 本人 |
| `media.transport.restart` ・ `media.ice_servers.refresh` | ICE restart と TURN の資格情報の更新（[network-traversal.md](network-traversal.md) の 6 節） | 本人 |
| `media.stall` | `transport_id`。受信の途絶の報告（[media-server-sfu.md](media-server-sfu.md) の 9.1 節） | 本人 |
| `view.update` | `visible: [participant_id]`（25 まで）、`tile_px: {participant_id: [w, h]}`、`pinned?` | 本人 |
| `host.mute` ・ `host.mute_all` ・ `host.ask_unmute` ・ `host.stop_video` ・ `host.stop_share` ・ `host.remove` ・ `host.lock` ・ `host.admit` ・ `host.deny` ・ `host.set_role` ・ `host.rename` ・ `host.settings` ・ `host.end` | 9 節 | 主催者・共同主催者 |
| `host.admit_all` ・ `host.to_waiting` ・ `host.suspend` ・ `host.readmit` ・ `host.invite` ・ `host.lower_hands` | 全員を入れる、待合室へ戻す、活動の一時停止、ban の解除、会議の中からの招待（[meeting-security.md](meeting-security.md) の 3.3・5・6 節）、全員の手を下げる（[chat-and-reactions.md](chat-and-reactions.md) の 5.2 節）。9.2 節の表 | 主催者・共同主催者 |
| `share.request` ・ `share.stop` | — | 本人 |
| `chat.send` ・ `chat.fetch` ・ `chat.delete` | 会議の中のチャット（[chat-and-reactions.md](chat-and-reactions.md) の 3 節）。`ack` は `chat_seq` を返す | 本人（削除は主催者・共同主催者も） |
| `reaction.send` | 絵文字のリアクション（[chat-and-reactions.md](chat-and-reactions.md) の 5.1 節） | 本人 |
| `consent.give` | `kind`（`recording`・`transcription`）。録画・文字起こしへの同意（[recording-and-transcription.md](recording-and-transcription.md) の 7.2 節） | 本人 |
| `recording.start` ・ `recording.pause` ・ `recording.stop` ・ `captions.start` ・ `captions.stop` ・ `request.recording` ・ `request.captions` | 録画と字幕の操作と依頼（[recording-and-transcription.md](recording-and-transcription.md) の 4.2・5.1 節） | 主催者・共同主催者（依頼は参加者） |
| `e2ee.commit` ・ `e2ee.app` ・ `e2ee.resync` | E2EE の会議の MLS のメッセージ（[e2ee.md](e2ee.md) の 6.2 節） | 本人 |
| `qos.report` | 10 秒ごとの品質の要約。`seq` なし。Gateway が受けて Actor を通さない（[observability.md](observability.md) の 2.2 節） | 本人 |

サーバー → クライアント（`evt`）：

| name | 中身 |
| --- | --- |
| `meeting.status` | `open`・`live`・`ending`、`locked`、`recording`・`transcribing`（録画の表示。recording-and-transcription.md） |
| `participant.joined` ・ `participant.left` ・ `participant.updated` | `participant_id`、`display_name`、`role`、`muted`、`video`、`sharing`、`hand_raised`、`connection`（`ok`・`reconnecting`）、`by?`（`host` のとき主催者の操作）、`media_error?`（Media Node への指示の失敗。5.4 節の 7） |
| `participant.role` | `participant_id`、`role` |
| `waiting.joined` ・ `waiting.left` | 主催者・共同主催者だけに送る |
| `speaker.active` | `participant_id`（主な話者。[media-server-sfu.md](media-server-sfu.md) の 6 節） |
| `share.started` ・ `share.stopped` | `participant_id`、`producer_id` |
| `media.producer.new` ・ `media.producer.closed` | 受け手の端末で consumer を作るための通知（8 節） |
| `media.reattach` | Media Node の付け替え（[media-server-sfu.md](media-server-sfu.md) の 9 節） |
| `media.layers.hint` | 送り手に、使われている層の上限を知らせる（[media-server-sfu.md](media-server-sfu.md) の 5.5 節） |
| `request.unmute` ・ `request.video` | 主催者からの依頼。本人が応じるか選ぶ |
| `you.removed` ・ `meeting.ended` | 終わりの通知。この後サーバーが接続を閉じる |
| `meeting.suspended` | 活動の一時停止（[meeting-security.md](meeting-security.md) の 6.2 節） |
| `e2ee.create` ・ `e2ee.group_info` ・ `e2ee.commit` ・ `e2ee.proposal` ・ `e2ee.app` | E2EE の会議の MLS のメッセージ（[e2ee.md](e2ee.md) の 6.2 節） |

サーバー → クライアント（`eph`。`seq` なし、落としてよい）：`audio.levels`、`control.degraded`、`chat.message`・`chat.deleted`（`chat_seq`・`ch_seq` 付き。[chat-and-reactions.md](chat-and-reactions.md)）、`reaction`・`reaction.batch`、`caption.partial`・`caption.final`（[recording-and-transcription.md](recording-and-transcription.md) の 5.2 節）、`audio.slots`（100 人を超える会議の音声の枠の中の話者。[ADR-0057](../decisions/0057-audio-slots-for-large-meetings.md)）。

- 他の領域が足したメッセージ（`chat.*`、`reaction.*`、`consent.give`、`host.suspend` など）は、2026-09-27 の統合の工程でこの表に集めた。スキーマ（`@<brand>/signaling-schema`）の定義は、それぞれの Epic の Story（E3・E5・E8・E9）で足す。

### 6.3 上限と流量

| 項目 | 上限 | 超えたら |
| --- | --- | --- |
| 1 メッセージ（クライアント → サーバー） | 64 KiB | Gateway が接続を閉じる（WebSocket のコード 1009） |
| 1 メッセージ（サーバー → クライアント） | 1 MiB（スナップショット。100 人で約 100 KiB の見込み） | 超える会議（S3 の 1,000 人）では、一覧をページに分けて送る（S3 の前に決める） |
| 1 接続の `cmd` | 毎秒 20、瞬間 50 | `err{code: rate_limited}`。10 秒続けば閉じる |
| `view.update` | 毎秒 4 | 最後の値だけを使う |
| 1 接続の送信の待ち（Gateway） | 2 MiB か 5 秒 | 接続を閉じる。クライアントは `resume` で入り直し、スナップショットを受ける |
| `ping` | クライアントが 5 秒ごと | 15 秒 `pong` がなければ、クライアントは接続を張り直す。Gateway は 15 秒何も受けなければ閉じる |
| 1 会議の参加者 | S1 100 人（NFR-006） | 101 人目は `Rejected(full)` |

### 6.4 バージョンの扱い

- サーバーは、Web には今と 1 つ前のバージョン（N−1）を、ネイティブのアプリ（MVP の後）には 2 つ前のバージョン（N−2）までを受ける（[ADR-0005](../decisions/0005-meeting-state-and-signaling.md)、[ADR-0008](../decisions/0008-signaling-protocol.md) の注記）。バージョンを上げる PR では、受けるバージョンのクライアントの契約の試験を通す。
- バージョンの中での変更は、項目を足すことだけにする。クライアントは知らない `name` の `evt` と知らない項目を無視する。
- 受けるバージョンより古いか、最低のバージョン（`min_client_version`。Web は `client-config`、アプリは `client_releases`）より古いクライアントの `hello` には、`err{code: upgrade_required}` を返して閉じる（強制の更新）。Web クライアントは読み込み直し、アプリは更新の画面を出す。

## 7. 状態の配信と再同期

- Actor は、直近の差分を会議ごとにメモリに持つ。1,000 件か 120 秒の多い方。
- `hello.resume = {participant_id, epoch, seq}` のとき：
  - `epoch` が今と同じで、`seq` の次から手元にある：足りない差分を送る。
  - それ以外（`epoch` が違う、範囲の外）：スナップショットを送る。
- クライアントは、`seq` の飛びを見つけたら、`hello.resume` と同じ規則で求め直す（`state.sync` の `cmd`）。
- `resume` の `participant_id` は、トークンの中の `participant_id` と同じときだけ受ける。再接続のトークンは、Actor が `welcome` で渡す再接続用の秘密（32 バイト、会議の間だけ有効）で代える。API に戻らずに入り直せる。

## 8. メディアの交渉

mediasoup-client の手順を、シグナリングの `cmd` に写す。Actor が権限を判定し、Media Node の制御の API へ `epoch` 付きで中継する。

| 手順 | cmd | Actor の判定 | Media Node で起きること |
| --- | --- | --- | --- |
| 1 | `media.capabilities` | 参加者が Admitted | router の `rtpCapabilities` を返す（会議の中で同じ） |
| 2 | `media.transport.create {direction}` | 1 人に send 1 本・recv 1 本まで | WebRtcTransport を作り、`iceParameters`・`iceCandidates`・`dtlsParameters` を返す |
| 3 | `media.transport.connect {transport_id, dtlsParameters}` | 本人の transport か | DTLS を始める |
| 4 | `media.produce {kind, source, rtpParameters}` | `source` ごとの規則（9 節）。`screen` は共有の許可 | producer を作る。ミュートの状態なら `paused` で作る |
| 5 | （サーバーから）`media.producer.new` | 受け手の見える範囲（`view.update`） | 受け手ごとに consumer を `paused` で作り、パラメーターを送る |
| 6 | `media.consume.resume {consumer_id}` | 本人の consumer か | consumer を再開し、キーフレームを求める |

- 受け手の consumer を作る範囲と層は、Actor が `view.update` と話者から決める。層の上限の計算は [media-server-sfu.md](media-server-sfu.md) の 5 節。
- 音声は、受け手ごとに consumer を作る（100 人を超える会議は、受け手ごとに 3 つの音声の枠の consumer だけ。[ADR-0057](../decisions/0057-audio-slots-for-large-meetings.md)）。映像は、受け手の見える範囲（25 本まで。NFR-006）だけ作る。

## 9. 主催者の操作

ADR-0009。

### 9.1 役割

| 役割 | 付き方 |
| --- | --- |
| `host` | 会議を作った人、または主催者から引き継いだ人。会議に 1 人 |
| `cohost` | 主催者が指名した人。上限 50 人 |
| `attendee` | その他 |

### 9.2 決定表

| 操作 | host | cohost | attendee | 対象の制約 | 強制の場所 |
| --- | --- | --- | --- | --- | --- |
| 参加者をミュートする（`host.mute`） | ○ | ○ | × | 誰でも | Media Node で音声の producer を止める |
| 全員をミュート（`host.mute_all {allow_self_unmute}`） | ○ | ○ | × | 自分と host・cohost を除く | 同上。`allow_self_unmute = false` なら、本人の `self.update{muted:false}` を拒否する |
| ミュートの解除を頼む（`host.ask_unmute`） | ○ | ○ | × | — | 本人の画面に確認を出す。本人が応じたときだけ解除 |
| ビデオを止める（`host.stop_video`） | ○ | ○ | × | host を除く | Media Node で映像の producer を止める |
| ビデオの開始を頼む | ○ | ○ | × | — | 本人が応じたときだけ |
| 共有を止める（`host.stop_share`） | ○ | ○ | × | — | Media Node で共有の producer を閉じる |
| 退出させる（`host.remove`） | ○ | ○ | × | host は対象にできない。cohost は cohost を対象にできない | Aurora の `meeting_removals` に書いてから、Media Node の transport を閉じ、接続を閉じる |
| 会議をロック（`host.lock`） | ○ | ○ | × | — | Actor が新しい `join` を `Rejected(locked)` にする |
| 待合室から入れる・断る | ○ | ○ | × | — | Actor |
| 役割を変える（`host.set_role`） | ○ | × | × | host の引き継ぎは相手が Admitted で、アカウントのある人に限る | Aurora に書いてから配る |
| 名前を変える（`host.rename`） | ○ | ○ | × | — | Actor。`settings.allow_rename = false` なら本人の名前の変更を拒否する |
| 共有の許可（`host.settings{share: host_only｜all}`） | ○ | ○ | × | — | Actor が `media.produce{source: screen}` を判定する |
| 会議を終える（`host.end`） | ○ | × | × | — | Ending へ |
| 挙手を下げる（`host.lower_hands` は全員） | ○ | ○ | 自分 | — | Actor |
| 全員を入れる（`host.admit_all`）・待合室へ戻す（`host.to_waiting`） | ○ | ○ | × | host を戻せない。cohost は cohost を戻せない | Actor（[meeting-security.md](meeting-security.md) の 5 節） |
| 活動の一時停止（`host.suspend`） | ○ | ○ | × | host・cohost を除く全員 | Actor と Media Node（[meeting-security.md](meeting-security.md) の 6.2 節） |
| ban の解除（`host.readmit`） | ○ | ○ | × | — | Aurora に書いてから配る |
| 会議の中からの招待（`host.invite`） | ○ | ○ | × | — | Actor が 1 回限りの招待のトークンを出す |

- 判定はすべて Actor で行う。クライアントは、ボタンを出すかどうかだけに同じ表を使う。
- 画面共有は、同時に 1 人（S1）。共有中に別の人が `share.request` したら、`share: all` のときは後の人に替わり、前の人の producer を閉じる。`host_only` では host・cohost だけが替われる。

### 9.3 主催者の引き継ぎ

- 主催者が `self.leave` するときは、引き継ぐ相手を選ぶ画面を出す。
- 主催者の接続が切れて `Reconnecting` が 60 秒続いたら、次の順で自動で引き継ぐ：最も早く入った cohost → 主催者と同じ組織のアカウントで最も早く入った人 → アカウントのある人で最も早く入った人。ゲストには自動で渡さない。該当者がいなければ「主催者不在」になる。待合室の人は、主催者か cohost が入るまで待つ。
- 元の主催者が戻ったら、主催者の役割を戻す（`role_hint = host` のトークンで入ったとき）。

### 9.4 強制の仕組み

- ミュート：Actor は差分 `participant.updated{muted: true, by: host}` を配った後、Media Node に `producer.pause{producer_id, epoch}` を送る。クライアントが従わず音声を送り続けても、Media Node が転送しない。本人の端末は、差分を受けてマイクのトラックを止める（送る帯域を減らす）。
- 本人のミュートの解除は `self.update{muted:false}` を Actor が許したときだけ、Media Node の `producer.resume` になる。
- 退出させた人の接続は、`you.removed` を送った後、Gateway が閉じる。Media Node の transport も閉じる。再び入ろうとしたら、`join` で `Rejected(removed)` にする。

## 10. スナップショットと Actor の回復

### 10.1 スナップショット

```jsonc
{ "instance_id": "mi_01J9...", "epoch": 7, "seq": 1235, "status": "live", "locked": false,
  "settings": { "share": "all", "allow_rename": true, "allow_self_unmute": true },
  "participants": [ { "id": "p_7Q", "user_id": "u_..", "display_name": "山田", "role": "host",
                      "muted": false, "video": true, "sharing": false, "hand_raised": false,
                      "joined_at": "...", "reconnect_secret_hash": "..." } ],
  "waiting": [ ... ], "active_speaker": "p_7Q",
  "video_mode": "simulcast", "video_mode_locked": false,   // codecs-and-bandwidth-adaptation.md の 5 節
  "media": { "generation": 3, "nodes": [ { "node_id": "mn-tyo-a-017", "role": "primary" } ], "standby": "mn-tyo-c-004" },
  "e2ee": { "enabled": false } }
```

- Valkey の `mtg:{m}:snap` に、変化があれば 500ms ごとに書く。失ってはならない変更は、Aurora にも書いてある（5.4 節）。
- チャットの本文は入れない（chat-and-reactions.md）。

### 10.2 回復の手順

```
t=0      Actor Host が落ちる（プロセスの終了、タスクの停止、分断）
t≈0〜3s  Gateway は内部の接続の切断（または 3 秒の ping の失敗）で気づく。
         会議の参加者に eph{name: "control.degraded"} を送る（画面に「一部の操作が遅れています」）
t=6s     リースの TTL が切れる（最後の更新が t=0 の直前の場合の最悪は t≈6s）
t≈6.1s   Gateway が次の Host に acquire を頼む。新しい Host は epoch+1 で取る
t≈6.2s   スナップショットを Valkey から、失ってはならない変更を Aurora から読む
         Media Node に inventory{meeting, epoch} を求める（今の transport・producer・consumer の一覧）
t≈6.4s   全員に snap{epoch+1} を送り、state.report を求める
t≈7.5s   state.report を 1 秒待って突き合わせる（下の表）。status を戻す
t≈8s     主催者の操作が効く（目標：10 秒以内。NFR-004）
```

- 流れているメディアは止まらない。Media Node は、最後の指示のまま転送を続ける（ADR-0005）。
- 突き合わせの優先の順：

| 項目 | 正とするもの |
| --- | --- |
| 退出させた人、ロック、役割 | Aurora |
| transport・producer・consumer の有無 | Media Node の inventory |
| 誰が会議にいるか | Media Node の inventory と、`state.report` を送ってきた接続の和。スナップショットにいて両方にいない人は `Reconnecting` にする |
| ミュート・ビデオ・挙手 | スナップショット。ただし Media Node で producer が止まっていれば、ミュートとみなす |
| 待合室 | スナップショット。なければ、待合室の人はクライアントの `state.report` で戻す |

- `state.report` の中の役割は信じない。役割は Aurora とスナップショットから決める。スナップショットがなく Aurora にも記録がなければ、トークンの `role_hint` で決め直す。

### 10.3 計画した引き渡し（デプロイ）

- Actor Host を止める前に、その Host の会議を 1 つずつ引き渡す：受け取りを止める → スナップショットを書く → リースを返す → Gateway に「移った」と知らせる → Gateway が次の Host に acquire を頼む。1 会議あたり 1 秒未満の見込み（**未検証**。E7 の `actor-planned-handover` で計測する）。
- ECS のタスクの停止の猶予（`stopTimeout`）は 120 秒にする。2,000 会議を 16 並列で引き渡して、約 2 分の見積もり。

## 11. 遅延の予算

参加（NFR-002：参加のボタンから音声の送受信まで p95 3 秒、東京、2 回目以降の参加）。

| 区間 | 予算（p95） |
| --- | --- |
| `POST /join`（パスコードの検査、トークンの署名） | 250ms |
| WSS の接続（TLS）と `hello` → `welcome` | 350ms |
| `media.capabilities` と mediasoup-client の `Device.load` | 150ms |
| send と recv の transport の作成（2 往復） | 200ms |
| ICE と DTLS（UDP、Media Node に直接） | 400ms |
| `media.produce`（音声）と、相手の consume・resume | 300ms |
| 最初の音声のパケットと、ジッタバッファ | 250ms |
| マイクの許可の画面（利用者の操作は含めない） | — |
| 余裕 | 1,100ms |

主催者の操作（`host.mute` から、対象の音声が止まるまで）：p95 500ms。Gateway → Actor → Aurora（ミュートは書かない）→ Media Node の `producer.pause`。

## 12. 障害のときの振る舞い

| 障害 | 起きること | 回復 |
| --- | --- | --- |
| クライアントの WS が切れた | 一覧で「再接続中」。メディアは続く | 指数の待ち（0.5s、1s、2s … 最大 10s、±20%）で `resume` |
| Gateway のタスクが落ちた | そのタスクの接続がすべて切れる | 別のタスクへ再接続（ALB）。`resume` で差分を受ける |
| Actor Host が落ちた | 最大 10 秒、操作が効かない。メディアは続く | 10.2 節 |
| Actor Host と Valkey の分断 | 更新ができない | 4.5 秒で自分で止まる。他の Host が取る |
| Valkey の primary の切り替え | リースの更新が数秒止まる | 切り替えが 4.5 秒を超えると、全会議の Actor が止まり、切り替えの後に取り直す（`epoch` が上がる）。スナップショットの書き込みが失われていれば 10.2 節の突き合わせで戻す |
| 2 つの Actor が同時に動いた（時計の大きなずれなど） | 古い方の指示 | Media Node・Gateway・Aurora が `epoch` で拒否する |
| Aurora が書けない | 失ってはならない変更だけが失敗する | `err{code: unavailable, retryable: true}`。ミュート・入室などは続く |
| API が止まった | 新しい参加ができない | 会議の中の操作と再接続（再接続用の秘密）は続く |

## 13. セキュリティ

- 参加のトークンは 120 秒、1 回限り、Ed25519。署名の鍵は KMS で守り、公開鍵を Gateway・Actor に配る。
- WebSocket の `Origin` を検査する。許したオリジン（`https://<brand>.<domain>`）以外は拒否する。
- 参加の鍵・パスコード・参加のトークン・再接続用の秘密は、ログ・トレースの属性・メトリクスのラベルに書かない（本題材の AGENTS.md）。ログに書くのは `meeting_id`・`instance_id`・`participant_id`・`epoch`・`seq`・操作の名前・理由のコードだけ。
- `display_name` は、長さ（64 文字）と制御文字を検査する。表示のときにエスケープする。
- 主催者の操作は、Actor が役割を判定し、Media Node で強制する。クライアントの申告の役割は使わない。
- 監査：主催者の操作（退出させる、ロック、役割の変更、会議の終了）を、Aurora の `meeting_audit_events` に outbox と同じトランザクションで書く（security.md で保持の期間を決める）。
- E2EE の会議：Actor は MLS のメッセージを中身を見ずに順序付けて配る（e2ee.md）。
- 存在しない会議とパスコードの誤りは、同じ応答・同じ時間で返す（4.3 節）。

## 14. テスト

### 14.1 性質ベーステスト

Actor、Gateway、クライアント N 個、偽の Media Node を 1 つのプロセスで動かし、メッセージの遅れ・並べ替え（接続の中の順は保つ）・切断・再送・持ち主の交代・時計のずれを乱数で起こす。

- **PROP-SIG-001（収束）**：任意の操作と障害の列の後、全クライアントが見る状態は、最後の持ち主の `(epoch, seq)` の順の状態と一致する。
- **PROP-SIG-002（ロック）**：ロックが確定した `seq` より後に許された `join` は 0 件。
- **PROP-SIG-003（退出させた人）**：`host.remove` に `ack` を返した後、同じ人が Admitted になることはない（主催者が許すまで）。持ち主の交代をはさんでも同じ。
- **PROP-SIG-004（フェンシング）**：古い `epoch` の指示で Media Node の状態が変わることはない。
- **PROP-SIG-005（主催者）**：どの時点でも host は 0 人か 1 人。
- **PROP-SIG-006（トークン）**：同じ `jti` の `hello` が Admitted になるのは 1 回だけ。

### 14.2 決定表

- 9.2 節の各行を、役割 3 種 × 対象の役割 3 種で表駆動テストにする（`REQ-SIG-HOST-*`）。
- 10.2 節の突き合わせの表の各行。

### 14.3 障害の注入

| 注入 | 期待 |
| --- | --- |
| Actor Host を `SIGKILL` | メディアは止まらない（受けた音声のパケットの途切れ 0）。10 秒以内に `host.mute` が効く |
| Actor Host と Valkey の間を `iptables` で落とす | 4.5 秒で古い Actor が止まり、新しい Actor が `epoch+1` で動く。古い Actor の指示は Media Node で `stale_epoch` |
| 同じ会議に 2 つの Actor を強制的に立てる | Media Node・Aurora が古い方を拒否する |
| Valkey の primary の切り替え（ElastiCache の failover の API） | 会議は終わらない。メディアは止まらない |
| Gateway のタスクを半分止める | 再接続の成功率 99% 以上、`resume` で差分を受けた割合を記録する |
| クライアントの回線の断（10 秒、40 秒、70 秒） | 10 秒・40 秒は同じ `participant_id` で戻る。70 秒は `Left(dropped)` の後に新しい参加 |

### 14.4 回線の劣化

- 本題材の AGENTS.md の条件（損失 5%・20%、揺らぎ 30・100ms、帯域の低下、RTT 200ms）で、シグナリングの操作の遅れ（`cmd` → `ack` の p95）と、WS の切断の率を測る。シグナリングは TCP なので、損失 20% で遅れが大きく伸びる。p95 2 秒を超えないことを目安にする（**未検証**。E2 の `network-path-matrix-tests` で測り、[quality.md](../quality.md) の 2.2.1 節の行列に閾値を足す）。

## 15. Story の候補

Epic の番号と名前は [roadmap.md](../roadmap.md) に従う。

| Epic | Story | 中身 |
| --- | --- | --- |
| E2 | `meeting-create-instant` | 4.2 節。会議の番号、参加の鍵、URL |
| E2 | `join-token-issue` | 4.3 節。Ed25519 のトークン、`jti` |
| E2 | `signaling-gateway-connect` | 4.4 節、6.1 節。サブプロトコル、`Origin`、`hello`・`welcome` |
| E2 | `meeting-actor-core` | 5.1・5.2・5.4 節。待ち行列、`seq`、差分の配信 |
| E2 | `actor-lease-epoch` | 5.3 節。Lua のスクリプト、自分で止まる、フェンシング |
| E2 | `signaling-schema-package` | 6.2 節の Zod のスキーマと、JSON Schema の生成 |
| E2 | `media-negotiation-relay` | 8 節 |
| E2 | `reconnect-resume` | 7 節。再接続用の秘密、差分とスナップショット |
| E3 | `host-controls-table` | 9.2 節の決定表と、Media Node での強制 |
| E3 | `host-handover` | 9.3 節 |
| E3 | `removal-ban-durable` | 退出させた記録を Aurora に書いてから配る |
| E5 | `screen-share-arbitration` | 9.2 節の共有の許可と、1 人だけの共有 |
| E7 | `actor-failover-drill` | 10.2 節と 14.3 節の障害の注入 |
| E7 | `actor-planned-handover` | 10.3 節 |
| E7 | `signaling-load-test` | 100 人の会議 × 同時の会議の数で、Actor Host の CPU と `cmd` の遅れ |

## 16. 未解決の問い

### 決定

2026-09-27 に推奨案で確定した（[README.md](README.md) の 6 節の「決定（2026-09-27、推奨案で確定）」）。

- **会議の番号**：11 桁、CSPRNG、2 年は再び使わない。
- **参加の鍵**：128 ビット、URL のフラグメント。パスコードの入力だけを省く。
- **リース**：TTL 6 秒、更新 2 秒、自分で止まるのは 4.5 秒。
- **差分の保持**：1,000 件か 120 秒。
- **切断の猶予**：WS の切断から 60 秒で `Left(dropped)`。
- **主催者の自動の引き継ぎ**：ゲストには渡さない。
- **共有**：同時に 1 人。
- **cohost の上限**：50 人。
- **参加の鍵と待合室**：参加の鍵を持つ人にも、待合室を省かせる設定は作らない（[ADR-0031](../decisions/0031-waiting-room-and-passcode-rules.md)）。
- **複数の画面共有**：MVP では許さない。MVP の後に利用者の声で見直す（[roadmap.md](../roadmap.md) の延期の一覧）。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| S3（1,000 人）のスナップショットの大きさと、一覧のページ分け | S3 の前。1,000 人の Actor の負荷試験で決める |
| 計画した引き渡しの 1 会議あたりの時間 | E7 の `actor-planned-handover` で計測する |
| Gateway と Actor Host を 1 つのサービスにまとめるか | E2 の負荷試験で、1 ホップの遅れと運用の手間を比べる |
| 本家のシグナリングの形式 | 公開の一次の資料に書かれていない。調べない |

## 17. quality.md・runbooks・data-model への項目

### quality.md

- 参加の遅れ（11 節の区間ごと）の p50・p95。TURN を通るときを分けて測る。
- `cmd` → `ack` の p95（操作の種類ごと）。`host.mute` から音声が止まるまでの p95。
- Actor の回復の時間（持ち主を失ってから、最初の `ack` まで）の分布。障害の注入の訓練で測る。
- `epoch` が上がった回数（会議・日あたり）と、`stale_epoch` で拒否された指示の数。
- `resume` の成功率と、スナップショットになった割合。
- 性質ベーステストの列の数（PR ごとに 1 万、夜間に 100 万）。

### runbooks

- `actor-host-failover.md`：Actor Host が落ちたときの確かめ方（リースの切れ、`epoch` の増え方、回復の時間）と、会議を別の Host へ寄せる手順。
- `valkey-failover-meetings.md`：Valkey の切り替えで全会議の Actor が止まったときの確かめ方と、取り直しの集中を散らす手順。
- `signaling-reconnect-storm.md`：Gateway の入れ替えで再接続が集中したときの確かめ方と、再接続の待ちの引き上げ。
- `host-lost-meeting.md`：主催者不在の会議で、待合室の人が入れないという問い合わせへの対処（主催者の鍵での取り戻し。meeting-security.md）。

### data-model（索引への追加の提案）

確定した形は [data-model/scheduling.md](data-model/scheduling.md)、[data-model/meeting-runtime.md](data-model/meeting-runtime.md)、[data-model/safety.md](data-model/safety.md)、[data-model/stores.md](data-model/stores.md) にある。

| 置き場所 | 中身 |
| --- | --- |
| Aurora `meetings` | `meeting_id`（ULID）、`org_id`、`meeting_number`（11 桁、一意）、`host_user_id`、`join_key_hash`、`settings`、`type`、`created_at` |
| Aurora `meeting_instances` | `instance_id`、`meeting_id`、`status`、`actor_epoch`、`started_at`、`ended_at`、`media_region`（部分一意：`meeting_id WHERE ended_at IS NULL`） |
| Aurora `meeting_participations` | `instance_id`、`participant_id`、`user_id`（ゲストは空）、`role`、`joined_at`、`left_at`、`leave_reason` |
| Aurora `meeting_removals` | `meeting_id`、`user_id` か端末の鍵のハッシュ、`removed_by`、`removed_at`、`readmitted_at` |
| Aurora `meeting_audit_events` | 主催者の操作の監査（outbox と同じトランザクション） |
| Aurora `meeting_number_history` | 使った番号と最後の開催の日（2 年の再使用の禁止） |
| Valkey `mtg:{m}:lease`・`:epoch`・`:snap`・`:jti:*` | 5.3 節 |

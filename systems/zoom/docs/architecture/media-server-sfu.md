# Media Server (SFU): Zoom

Media Node の中の作りと振る舞い。mediasoup v3 の worker・router・WebRtcServer の配置、`pipeToRouter` による worker と台をまたぐ会議、転送の規則と層の選択、話者の検出、キーフレームの要求の制御、会議の割り当てとカスケード、Media Node の障害の時の付け替え（音声を 5 秒以内に戻す）を決める。

前提となる決定は、EC2 の上の mediasoup（[ADR-0001](../decisions/0001-platform-and-stack.md)）、SFU・simulcast・SVC・カスケード（[ADR-0002](../decisions/0002-media-topology.md)）、ホップごとの暗号化と E2EE（[ADR-0004](../decisions/0004-encryption-and-e2ee.md)）、Meeting Actor と Media Assignment Service（[ADR-0005](../decisions/0005-meeting-state-and-signaling.md)）、Actor の `epoch`（[ADR-0007](../decisions/0007-meeting-actor-lease-and-epoch.md)）。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0010](../decisions/0010-media-node-process-layout.md) | Media Node は 1 台に 1 つの制御のプロセス（Node Agent、TypeScript）と、vCPU−2 個の mediasoup の worker を持つ。worker ごとに WebRtcServer を 1 つ置き、UDP と TCP の固定のポート（20000＋worker の番号）で待つ。会議は worker ごとに router を持ち、参加者の transport を置いた worker の間を `pipeToRouter` で必要な分だけつなぐ |
| [0011](../decisions/0011-forwarding-and-layer-selection.md) | 何を誰に送るか（購読の集合、層の上限、優先度）は Meeting Actor が決め、帯域の中で実際の層を選ぶのは Media Node（mediasoup の帯域の推定と `setPreferredLayers`・`setPriority`）に任せる。音声は受け手ごとに最大 3 本（声の大きい人＋主な話者＋直近の話者）にする。キーフレームの要求は、カメラで 1 秒、画面共有で 2 秒に 1 回にまとめる |
| [0012](../decisions/0012-media-assignment-and-cascading.md) | Media Assignment Service は、Node の負荷の報告（1 秒ごと）から、4 つの資源の使用率の最大で点を付け、無作為の 2 台のうち低い方を選ぶ。S1 は 1 会議を 1 台に置く。S2 から、1 台に収まらない会議を PipeTransport（SRTP あり）で別の台へ広げる。送り手の Node から受け手の Node へ直接つなぎ、中継は 1 ホップに限る |
| [0013](../decisions/0013-media-node-failover-and-reattach.md) | Media Node の障害は、Node の心拍（500ms ごと、3 回の欠落）と、クライアントの受信の途絶の報告で判定する。Actor は会議の開始時に予備の Node を決めておき、障害のときは新しい transport を作り直させ、音声を映像より先につなぐ。目標は音声が 5 秒以内に戻ること |
| [0057](../decisions/0057-audio-slots-for-large-meetings.md)（統合の工程） | 100 人を超える会議では、受け手ごとに 3 つの音声の枠を持たせ、枠の切り替えの転送器（`DirectTransport` か `PipeTransport`）で話者の音声を枠へ付け替えて送る。音声の consumer を人数の 2 乗で増やさない |

## 1. 目的と範囲

- 扱う：Media Node の中のプロセスと worker の配置、router と transport の置き方、転送の規則、層の選択、話者の検出、キーフレームの制御、Node の制御の API、Media Assignment Service、カスケード、Node と worker の障害と付け替え、計画した入れ替え（drain）。
- 扱わない：符号化の設定、帯域の推定、層の上限と優先度の表（[codecs-and-bandwidth-adaptation.md](codecs-and-bandwidth-adaptation.md)）、ICE・TURN・網の設定（[network-traversal.md](network-traversal.md)）、シグナリングのメッセージ（[signaling-and-meetings.md](signaling-and-meetings.md)）、E2EE の鍵（[e2ee.md](e2ee.md)）、インスタンスの種類と AMI（[infrastructure.md](infrastructure.md)）、1 台の上限の数値（[capacity.md](capacity.md)）。

## 2. mediasoup で確かめたこと

| 項目 | mediasoup v3（公開の資料） | この設計 |
| --- | --- | --- |
| worker | C++ の子プロセス。1 つの CPU のコアで動く。worker の数は CPU のコアの数を超えない。1 つで 500 程度の consumer を扱う（[Scalability](https://mediasoup.org/documentation/v3/scalability/)） | vCPU−2 個（ADR-0010）。500 は目安で、E7 の負荷試験で置き換える |
| `pipeToRouter` | worker の間や別の台の router をつなぐ。同じ worker の中では `keepId: true` で失敗する（[API](https://mediasoup.org/documentation/v3/mediasoup/api/)） | 会議の中の worker の間、S2 から台の間（ADR-0010、0012） |
| WebRtcServer | worker ごとに作り、1 つのポートを多数の WebRtcTransport で共有する。`enableUdp`・`enableTcp`・`preferUdp` で候補を絞る（同上） | worker ごとに 1 つ。ポートは 20000＋worker の番号（ADR-0010） |
| ICE | WebRtcTransport は ICE Lite で、役は常に controlled（[mediasoup の WebRtcTransport](https://docs.rs/mediasoup/latest/mediasoup/webrtc_transport/struct.WebRtcTransport.html)） | [network-traversal.md](network-traversal.md) の 3 節 |
| ICE の同意 | `iceConsentTimeout` の既定は 30 秒。0 で無効 | 既定のまま（9 節で別の検知を足す） |
| 層 | Consumer の `setPreferredLayers({spatialLayer, temporalLayer})`、`setPriority`、`requestKeyFrame`、`layerschange` のイベント | 5 節 |
| キーフレーム | Producer の `keyFrameRequestDelay`（前の要求からの待ち、既定 0）。1 つの producer への PLI・FIR は 1 秒に 1 回に絞られ、それでも多くの受け手の要求で送り手の送出が 2〜3 倍になりうる（Scalability） | 7 節 |
| 話者 | `ActiveSpeakerObserver`（`interval` の既定 300ms、`dominantspeaker` のイベント）、`AudioLevelObserver`（`maxEntries` 既定 1、`threshold` 既定 −80 dBov、`interval` 既定 1,000ms。音量は RFC 6464 のヘッダー拡張から読み、復号しない） | 6 節 |
| 符号 | simulcast は VP8・H.264、SVC は VP9（full SVC と K-SVC）。AV1 と Dependency Descriptor の拡張も対応の一覧にある（[RTP Parameters and Capabilities](https://mediasoup.org/documentation/v3/mediasoup/rtp-parameters-and-capabilities/)、[supportedRtpCapabilities.ts](https://github.com/versatica/mediasoup/blob/v3/node/src/supportedRtpCapabilities.ts)） | 層の作り方は codecs-and-bandwidth-adaptation.md |
| 暗号化したヘッダー拡張 | 対応しない（RTP Parameters and Capabilities） | E2EE でも拡張は平文で送る（[ADR-0004](../decisions/0004-encryption-and-e2ee.md) と合う） |
| worker の異常終了 | `worker.on("died")`。「起きてはならない。起きたら不具合」（API） | 9.2 節 |
| 版 | 3.27.x（[CHANGELOG](https://github.com/versatica/mediasoup/blob/v3/CHANGELOG.md)） | 開発の開始時の最新の 3.x に固定し、上げるときは回線の劣化の試験を通す |

いずれも 2026-09-27 に確認。

## 3. Media Node の中の作り

ADR-0010。

```
EC2（c7gn・c8gn の系列、パブリック IPv4＋IPv6。network-traversal.md の 7 節）
 └─ Node Agent（Node.js、TypeScript。1 プロセス）
     ├─ 制御の API（mTLS、Actor Host からだけ。4 節）
     ├─ 心拍と負荷の報告 → Media Assignment Service（500ms・1 秒ごと）
     ├─ worker 0 ── WebRtcServer（UDP 20000、TCP 20000）
     │    ├─ router（会議 A）── WebRtcTransport（参加者 1 の send・recv）…
     │    └─ router（会議 B）…
     ├─ worker 1 ── WebRtcServer（UDP 20001、TCP 20001）
     │    └─ router（会議 A）── pipe ◀── 会議 A の worker 0 の producer
     └─ …  worker N−1（N = vCPU − 2）
```

- **worker の数**：vCPU−2。残りの 2 は Node Agent（Node.js のイベントループ）と、カーネルの網の処理（ENA の割り込み）に残す。値は**未検証**で、E7 の `load-l0-l2` で見直す。worker は CPU のコアに固定する（`taskset`）。
- **ポート**：worker ごとに UDP と TCP を 1 つずつ。台の中で 20000〜20255 を使う。1 つの WebRtcServer を多数の transport が共有するので、ポートの数は参加者の数に比例しない。
- **router**：会議ごと・worker ごとに 1 つ。最初にその worker に参加者を置くときに作る。router の `mediaCodecs` は、全 Node・全会議で同じにする（付け替えのときにクライアントが `Device.load` をやり直さずに済む。9 節）。
- **参加者の置き場所**：参加者の send と recv の transport は、同じ worker（その人の「家の worker」）に置く。家の worker は、会議が既に使っている worker のうち consumer の数の最も少ないものにする。どれも上限（既定 400 consumer）に近ければ、新しい worker を会議に足す。
- **worker の間のつなぎ**：受け手の家の worker に、送り手の producer がなければ、`pipeToRouter` で送り手の router からつなぐ。受け手がいなくなって 30 秒たったら、その pipe を閉じる。
- 1 会議の例（100 人、全員がカメラあり、1 人 25 本を受ける）：映像の consumer は 2,500、音声の consumer は最大 9,900（ミュートの人の consumer は止まっている）。家の worker を 7 つ程度に広げる見込み（**未検証**。E7 の `worker-spread-pipe` で測る）。
- 100 人を超える会議（S2 から）は、音声の consumer を送り手ごとに作らない。受け手ごとの 3 つの音声の枠の consumer だけにする（5.3 節、[ADR-0057](../decisions/0057-audio-slots-for-large-meetings.md)）。

## 4. Node の制御の API

### 4.1 形

- Actor Host → Node Agent の、mTLS の HTTP/2 の上の JSON の RPC。Zod のスキーマを Actor と共有する（`@<brand>/media-node-api`）。
- Node Agent は、制御の側（Actor、API、Valkey、Aurora）へ同期で問い合わせない（本題材の AGENTS.md）。Node から出すのは、心拍・負荷の報告と、イベントの通知（話者、transport の状態、worker の異常）だけ。

| 呼び出し | 中身 | 返り値 |
| --- | --- | --- |
| `router.ensure` | `meeting_id`、`epoch`、`e2ee` | `rtpCapabilities` |
| `transport.create` | `meeting_id`、`epoch`、`participant_id`、`direction`、`home_worker?` | `transport_id`、`iceParameters`、`iceCandidates`、`dtlsParameters` |
| `transport.connect` | `transport_id`、`dtlsParameters` | — |
| `transport.restartIce` | `transport_id` | 新しい `iceParameters` |
| `producer.create` | `transport_id`、`kind`、`source`（`mic`・`cam`・`screen`）、`rtpParameters`、`paused` | `producer_id` |
| `producer.pause`・`resume`・`close` | `producer_id` | — |
| `subscriptions.apply` | 受け手ごとの購読の集合（5.1 節）の全体か差分 | 作った consumer のパラメーター |
| `consumer.resume` | `consumer_id` | — |
| `inventory` | `meeting_id` | 会議の transport・producer・consumer の一覧と状態 |
| `meeting.close` | `meeting_id`、`epoch` | — |
| `node.drain` | — | 新しい会議を受けない（10 節） |

Node Agent → Actor Host（通知。Actor Host は会議の持ち主へ回す）：

| 通知 | 中身 |
| --- | --- |
| `speaker.dominant` | `meeting_id`、`producer_id` |
| `audio.levels` | `meeting_id`、`[producer_id, dBov]`（250ms ごと、5 件まで） |
| `transport.state` | `transport_id`、`ice`（`connected`・`disconnected`・`closed`）、`dtls` |
| `producer.score` | `producer_id`、`score`（0〜10） |
| `worker.died` | `worker_index`、影響を受けた会議と参加者 |

### 4.2 冪等

- `transport.create` などの作る呼び出しは、`(meeting_id, participant_id, direction, media_generation)` を鍵に冪等にする。Actor の再試行で 2 つ作らない。

### 4.3 epoch の検査

- Node Agent は、会議ごとに受けた最大の `epoch` を持つ。それより小さい `epoch` の呼び出しは `409 stale_epoch` で拒否する。大きい `epoch` を受けたら、それを記録して処理する。
- `epoch` の表は、会議を閉じるまで持つ。Node Agent が再起動したら表は消えるが、その Node の router も消えているので問題ない。

## 5. 転送の規則と層の選択

ADR-0011。

### 5.1 何を誰に送るか（Meeting Actor が決める）

Actor は、受け手ごとに購読の集合を作り、`subscriptions.apply` で Node に送る。

```jsonc
{ "meeting_id": "mtg_01J9...", "epoch": 7, "receiver": "p_2M",
  "video": [ { "producer": "pr_cam_7Q", "max_spatial": 2, "max_temporal": 2, "priority": 200 },
             { "producer": "pr_scr_5K", "max_spatial": 0, "max_temporal": 2, "priority": 255 },
             { "producer": "pr_cam_9A", "max_spatial": 0, "max_temporal": 1, "priority": 50 } ],   // 値の決め方は codecs-and-bandwidth-adaptation.md の 6.3 節
  "audio": { "mode": "top_n", "n": 3 } }   // 5.3 節
```

| 決める項目 | 規則 |
| --- | --- |
| 映像の購読 | 受け手の `view.update` の `visible`（25 本まで。NFR-006）。見えない映像の consumer は止める（`pause`） |
| 空間・時間の層の上限 | 受け手の表示の高さ（`tile_px`）と、ギャラリーの本数で決める。表の値は [codecs-and-bandwidth-adaptation.md](codecs-and-bandwidth-adaptation.md) の 6.3 節（ADR-0019）に従う。SVC も同じ番号で扱う |
| 優先度（`setPriority`、1〜255） | 同じく 6.3 節に従う（画面共有 255、ピン留め・主な話者 200、ギャラリー 100・50） |
| 自分の映像 | 送らない（クライアントが手元で表示する） |

### 5.2 帯域の中で選ぶ（Media Node が決める）

- mediasoup は、受け手の transport ごとに下りの帯域を推定し、consumer の優先度の順に、上限（`preferredLayers`）までの層を割り当てる（[mediasoup の設計](https://mediasoup.org/documentation/v3/mediasoup/design/)、「Sender and receiver bandwidth estimation with spatial/temporal layers distribution」、2026-09-27 に確認）。
- 下りが足りないときは、優先度の低い映像から層が下がり、最後は止まる。音声は映像より先に守る（音声の consumer は層を持たず、帯域の割り当ての対象にしない。mediasoup も音声の consumer を割り当てに入れない（`Consumer::GetBitratePriority` が 0 を返す。[Consumer.cpp](https://github.com/versatica/mediasoup/blob/v3/worker/src/RTC/Consumer.cpp)、2026-09-27 に確認）。そのため映像が推定の全部を使いうる。音声の分を推定から引く方法は E4 の `downlink-allocation` で決める。[codecs-and-bandwidth-adaptation.md](codecs-and-bandwidth-adaptation.md) の 6.4 節）。
- Node Agent は `layerschange` を集計し、受け手ごとの「受けている層」を 1 秒ごとに Actor へ送らない（量が多い）。品質の指標として、observability.md の経路で送る。
- NFR-009（下りが半分になったら 5 秒以内に層を落とし、1 秒以上の停止を起こさない）は、mediasoup の推定の速さに頼る。E4 の回線の劣化の試験で確かめる。

### 5.3 音声

- 受け手に送る音声は、最大 3 本：`AudioLevelObserver` の上位＋主な話者＋直近 1.5 秒に上位にいた人から、自分を除いて選ぶ（`top_n`、N=3）。ミュートでない人が 3 人以下なら、全員の音声が届く。
- 受け手の下りが 150 kbps を下回ったら、その受け手だけ N=2 にする（[codecs-and-bandwidth-adaptation.md](codecs-and-bandwidth-adaptation.md) の 6.4 節）。
- 選ばれなかった音声の consumer は止める（`pause`）。切り替えには 1.5 秒の保持を入れ、話し始めと話し終わりで何度も切り替えない。
- 新しく話し始めた人の最初の 250〜500ms が落ちうる（観測の間隔 250ms と consumer の再開の分）。3 人を超えて同時に話す場面（笑い、相づち）で、4 人目以降の声が届かない。どちらも受け入れる（**未検証**。E4 の `audio-top-n` と E7 の `audio-slot-forwarder-poc` で、聞いた人の評価と、落ちた話し始めの長さを計測する）。
- Opus の DTX で、黙っている人の producer からはパケットがほとんど出ない。
- [ADR-0002](../decisions/0002-media-topology.md) の「声の大きい数人（既定 3 人）」をそのまま使う。
- **100 人を超える会議（音声の枠）**：受け手ごとに全員の音声の consumer を作る上の形は、consumer が人数の 2 乗で増える（300 人で約 9 万、1,000 人で約 100 万。[capacity.md](capacity.md) の 4 節）。開催の上限が 100 人を超える会議では、Actor が `audio_mode = slots` にする。Node Agent は会議の主な worker に 3 つの「枠の producer」を作り、枠の切り替えの転送器が、上と同じ選び方で選んだ話者の RTP を枠へ付け替えて流す（SSRC・連番・時刻を書き換える）。受け手は枠の producer の consumer を 3 つ（下り 150 kbps 未満なら 2 つ）だけ持つ。枠の中の話者は `eph` の `audio.slots` で知らせる。転送器を Node Agent の `DirectTransport` に置くか、`PipeTransport` でつないだ別のプロセスに置くかは、E7 の `audio-slot-forwarder-poc` で決める（[ADR-0057](../decisions/0057-audio-slots-for-large-meetings.md)）。Recorder・Transcriber・Phone Bridge は、今と同じく送り手ごとの producer を受ける。

### 5.4 画面共有

- 画面共有は別の producer（`source: screen`）で、優先度 255。受け手の表示の大きさに関わらず、空間の層は最大にし、時間の層で落とす（ADR-0002 の方針）。符号化の設定は [codecs-and-bandwidth-adaptation.md](codecs-and-bandwidth-adaptation.md)。

### 5.5 送り手の側の上限

- 送り手の transport に `setMaxIncomingBitrate` を置く。値（3,000 kbps）は [codecs-and-bandwidth-adaptation.md](codecs-and-bandwidth-adaptation.md) の 6.1 節に従う。改造したクライアントが帯域を使い切ることを防ぐ役も兼ねる。
- 誰も見ていない層は、送り手に送らせない。Node Agent は、ある層を受ける consumer が 0 の状態が 5 秒続いたら Actor に知らせる。Actor は送り手の端末に `media.layers.hint` を送り、送り手はその層の符号化を止める（`RTCRtpSender.setParameters` の `active: false`）。受け手が現れたら戻す（[codecs-and-bandwidth-adaptation.md](codecs-and-bandwidth-adaptation.md) の 5.2 節）。

## 6. 話者の検出

- 会議の router ごとに `ActiveSpeakerObserver`（`interval` 300ms）と `AudioLevelObserver`（`maxEntries` 5、`threshold` −60 dBov、`interval` 250ms）を置く。すべての音声の producer を加える。
- 会議が複数の worker に広がっているときは、観測は「主な worker」（会議の最初の worker）の router だけで行う。他の worker の音声の producer は、主な worker へ pipe でつなぐ（観測のため。受け手がいなくてもつなぐ）。
- `dominantspeaker` は、Node Agent → Actor の `speaker.dominant` になり、Actor が `evt: speaker.active` として `seq` 付きで配る。話者の表示（大きな表示に誰を出すか）の元になる。
- 音量（`volumes`）は、Actor を通して `eph: audio.levels` で配る（`seq` なし。[signaling-and-meetings.md](signaling-and-meetings.md) の 6.1 節）。画面の音量の輪の表示に使う。
- E2EE の会議でも、音量のヘッダー拡張（RFC 6464）は平文なので、話者の検出は動く。これは、誰がいつ話しているかがサーバーに見えることを意味する（[ADR-0004](../decisions/0004-encryption-and-e2ee.md) の「メタデータはサーバーに見える」に含める）。

## 7. キーフレームの制御

- 映像の producer に `keyFrameRequestDelay` を置く：カメラ 1,000ms、画面共有 2,000ms。受け手の PLI・FIR は、この間隔でまとめて 1 回だけ送り手へ送る。
- Node Agent から明示的に `requestKeyFrame` を呼ぶのは、次のときだけにする。
  - 受け手の consumer を再開したとき（mediasoup が自動で求める。simulcast・SVC でない consumer は再開ですぐに要求し、simulcast・SVC の consumer は同期をやり直して層を選び直し、その層のキーフレームを求める。`SimpleProducerStreamManager::OnResumed` などの worker の実装、2026-09-27 に確認）
  - 付け替えの後に、新しい Node で最初の consumer を作ったとき
- 新しい参加者が 25 本の映像を同時に受け始めると、25 人の送り手にキーフレームの要求が集まる。Actor は、新しい参加者の `consume.resume` を、話者と共有を先にして、残りを 100ms ずつずらして返す。
- 大きな会議（受け手 300 人以上。S2）で、1 人の送り手へのキーフレームの要求が多すぎるときは、層の切り替えに時間の層の境目を使う形（SVC）を優先する。mediasoup の資料が勧める「再符号化の中継」は、ウェビナーの Epic で検討する（Scalability の「Broadcasting」）。

## 8. 会議の割り当てとカスケード

ADR-0012。

### 8.1 Media Assignment Service

- ECS の上の TypeScript のサービス。状態は、各 Node の最新の負荷の報告（メモリと Valkey）だけ。失っても、Node の次の報告（1 秒）で戻る。
- Node の報告（1 秒ごと）：worker ごとの CPU、consumer の数、送出の bps と pps、ENA の `bw_out_allowance_exceeded`・`pps_allowance_exceeded`・`conntrack_allowance_exceeded` の増分、状態（`active`・`draining`）。
- 点：`score = max(cpu / cpu_limit, egress_bps / egress_limit, pps / pps_limit, consumers / consumer_limit)`。各 `*_limit` は、E7 の負荷試験で決めるインスタンスの種類ごとの値。ENA の `*_allowance_exceeded` が直近 1 分に増えた Node は、点を 1.0 にする（新しい会議を置かない）。
- 選び方：`score < 0.7` の Node から無作為に 2 台を選び、低い方にする（power of two choices。報告の 1 秒の遅れの間に、同じ Node へ会議が集まるのを防ぐ）。
- 予約：会議の予定の人数（予定の会議なら招待の数、すぐの会議は 10 人）の分を、選んだ Node に仮に足しておく。実際の参加が報告に現れたら外す。
- 予備の Node：会議を置くときに、別の AZ の Node を 1 台、予備として返す（9 節）。予備は資源を取らない（点の計算にも足さない）。

### 8.2 S1：1 会議は 1 台

- S1 の上限（100 人）では、1 会議を 1 台の Node に収める。1 台の中で worker に広げる（3 節）。
- Node の点が 0.85 を超えても、既にある会議の参加者は同じ Node に入れる（会議を割らない）。0.95 を超えたら、新しい参加を断る前に、Actor に「移すべき会議」を知らせる（10 節の drain と同じ手順で、大きな会議から別の Node へ移す）。

### 8.3 S2：リージョンの中のカスケード

```
            Node X（送り手の Node）                        Node Y（受け手の Node）
 送り手 ─▶ router(A, w0) ─▶ PipeTransport ═══ SRTP/UDP（VPC の中、プライベート IP）═══▶ PipeTransport ─▶ router(A, w0) ─▶ 受け手
```

- 1 台に収まらない会議（Node の点が 0.85 を超える、または予定の人数が 1 台の上限を超える）は、Actor が Assignment Service に 2 台目を求め、参加者を新しい Node に置く。
- 台の間は、mediasoup の `createPipeTransport` を両方の Node で作り、互いの IP とポートで `connect` する（`pipeToRouter` は同じ台の中でしか使えないため、台の間は手で組む）。`enableSrtp: true`、`enableRtx: true`（VPC の中でも損失はありうる）。
- つなぎ方：送り手の producer がある Node から、受け手のいる Node へ直接つなぐ（必要な組だけのメッシュ）。別の Node を経由して中継しない。どの受け手から見ても、Node の間の中継は 1 ホップだけ（[ADR-0002](../decisions/0002-media-topology.md) の「1 ホップだけ」に合わせる）。S2 の 300 人の会議は 2〜4 台の見込みで、組の数は小さい。
- Node の役割：会議の最初の Node を「主」とし、話者の検出を置く（6 節と同じ考え方）。主の Node が落ちたら、Actor は残る Node の 1 つを主にし直す。
- 台の間で送るのは、相手の Node に受け手がいる producer だけ。pipe の consumer は、producer のすべての simulcast の流れを運ぶ（mediasoup の pipe の consumer の振る舞い。[API](https://mediasoup.org/documentation/v3/mediasoup/api/) の `ConsumerOptions.pipe`、2026-09-27 に確認）。「受け手が要る層だけを送る」（[ADR-0002](../decisions/0002-media-topology.md)）は、mediasoup の pipe では実現できない。リージョンの中の帯域は安いので S2 では受け入れ、S3 のリージョンの間で見直す（13 節）。

### 8.4 S3：リージョンの間

- 参加者を近いリージョンの Node に置き、リージョンの間も送り手の Node から受け手の Node へ直接つなぐ（1 ホップ）。中継の経路は、リージョンの間の専用の経路（Transit Gateway のピアリングなど）かインターネットか、infrastructure.md で決める。
- 「受け手が要る層だけ」を運ぶには、pipe の代わりに、普通の consumer（層を選ぶもの）を台の間でつなぐ形が要る。S3 の前に試作して ADR にする。

## 9. 障害と付け替え

ADR-0013。

### 9.1 Media Node の障害

検知：

| 信号 | 条件 | 早さ |
| --- | --- | --- |
| Node の心拍 | Assignment Service に 500ms ごと。3 回（1.5 秒）欠けたら「疑い」 | 1.5 秒 |
| クライアントの報告 | recv の transport で、RTP も RTCP も 1.5 秒受けていない（`getStats` の `packetsReceived` と RTCP の SR が増えない）とき、`media.stall{transport_id}` を送る | 約 1.5〜2 秒 |
| Node の `transport.state` | 同じ Node の多数の transport が `disconnected` | Node が生きているときの網の障害 |

- Actor は、「心拍の疑い」か「同じ Node の参加者の 2 人以上（2 人以下の会議では全員）の `media.stall`」で、その Node を障害とみなす。1 人だけの `media.stall` は、その人の回線の問題として扱い、その人にだけ ICE restart を指示する（[network-traversal.md](network-traversal.md) の 6 節）。
- Assignment Service は、障害とみなした Node を `dead` にし、他の会議の Actor にも知らせる（同じ Node の会議の Actor が一斉に付け替えを始める）。

付け替え（`media_generation` を 1 つ上げる）：

```
t=0      Node X が落ちる
t≈1.5s   障害と判定（心拍の欠落か、クライアントの報告）
t≈1.6s   Actor：予備の Node Y で router.ensure（epoch 付き）。media_generation = g+1
         全員に evt: media.reattach{generation: g+1, reason: node_failed}
t≈1.7s   クライアント：古い transport を閉じる。Device はそのまま（router の mediaCodecs が同じ）
         send の transport を作る → connect（ICE・DTLS）→ 音声の produce
         recv の transport を作る → connect → 音声の consume・resume
t≈2.8s   音声が戻る（ICE と DTLS で 400〜600ms、produce と consume で 300ms、ジッタバッファ 200ms）
t≈3.5s   映像の produce と consume（話者と共有を先に）
```

| 区間 | 予算（p95） |
| --- | --- |
| 検知 | 2,000ms |
| Actor の判断と `router.ensure` | 200ms |
| `media.reattach` の配信 | 100ms |
| transport の作成と ICE・DTLS（直接の UDP） | 800ms |
| 音声の produce・consume・resume | 400ms |
| ジッタバッファ | 200ms |
| 余裕 | 1,300ms |
| 合計（NFR-004） | 5,000ms |

- TURN を通る参加者は、TURN の割り当てが残っていれば、同じ TURN から新しい Node の IP へ許可を足すだけで済む（ICE の中でブラウザが行う）。割り当てを作り直すときは、上の予算を 1 秒超えうる（**未検証**。E7 の `media-node-failover` で TURN の経路も測る）。
- 予備の Node Y も落ちている、または点が 0.95 を超えているときは、Assignment Service に新しく選ばせる（+100ms）。
- 付け替えの後、Actor は新しい予備を求める。

### 9.2 worker の異常終了

- Node Agent は `worker.on("died")` を受けたら、同じ番号の worker を作り直し（同じポートで WebRtcServer を作り直す）、Actor に `worker.died` を知らせる。
- Actor は、その worker を家にしていた参加者にだけ、`media.reattach{generation, reason: worker_failed}` を送る。新しい家の worker は同じ Node の別の worker にする。他の参加者は続く。
- その worker にあった pipe の先（他の worker の受け手へ流していた producer）は閉じるので、受け手には `media.producer.closed` と、付け替えの後の `media.producer.new` が届く。

### 9.3 ICE restart との違い

- **同じ Node のまま、参加者の網が変わった**（Wi-Fi からモバイルへ、NAT の対応付けが切れた）：その参加者だけ、`transport.restartIce` で ICE restart する。DTLS と producer・consumer はそのまま残る。
- **Node が替わる**：新しい transport を作る（ICE と DTLS をやり直す）。ICE restart では、別の Node にはつなげない。[ADR-0005](../decisions/0005-meeting-state-and-signaling.md) の「ICE restart と新しい Node への接続」は、この 2 つを合わせた表現として読む。

## 10. 計画した入れ替え（drain）

- Node を止める前に `node.drain`：Assignment Service は新しい会議を置かない。
- 既にある会議は、終わるのを待つ（最大 4 時間）。待てないときは、Actor に「make-before-break」の移動を頼む：
  1. Actor が別の Node に router を作り、`media.reattach{reason: planned, make_before_break: true}` を送る。
  2. クライアントは、古い transport を残したまま新しい transport を作り、音声の produce と consume ができたら、古い consumer を止め、古い transport を閉じる。
  3. 聞こえ方の途切れは、ジッタバッファの切り替えの分（数百 ms）に収まる見込み（**未検証**。E10 の `make-before-break-migration` で計測する）。
- AMI の入れ替えは、delivery.md で決める段階的な手順（台の割合を少しずつ増やす）に従う。

## 11. セキュリティ

- Media Node の制御の API は、プライベートのサブネットのポートで待ち、Actor Host のセキュリティグループからだけ受ける。mTLS のクライアント証明書で Actor Host を確かめる。
- メディアのポート（UDP・TCP 20000〜20255）は全開の規則にして接続の追跡を外す（[ADR-0001](../decisions/0001-platform-and-stack.md)、[network-traversal.md](network-traversal.md) の 7 節）。不正なパケットは、ICE の認証（transport ごとの乱数の `usernameFragment` と `password`）と DTLS で捨てる。
- DTLS の証明書は Node ごとに作り直す。クライアントは、シグナリングで受けた指紋（`dtlsParameters.fingerprints`）で確かめる。
- Node の上では、通常の会議のメディアは平文になる（[ADR-0004](../decisions/0004-encryption-and-e2ee.md)）。Node Agent と worker は、メディアのペイロードを保存・ログ・ダンプしない。コアダンプを無効にする（worker の異常の調査は、ペイロードを含まない `trace` のイベントで行う）。これは通信の秘密（intent.md の L2）の整理の前提である。
- 品質の診断に使うのは、RTCP と mediasoup の `getStats` の数値だけ（本題材の AGENTS.md）。
- 1 つの送り手の入りを `setMaxIncomingBitrate` で絞る（5.5 節）。1 人の受け手の consumer の数を、25 本の映像と音声に限る。
- E2EE の会議では、Node が扱えるのは RTP のヘッダーと拡張だけ。Recorder・Transcriber を consumer として足す `subscriptions.apply` を、Node Agent の側でも拒否する（`e2ee: true` の router）。

## 12. テスト

### 12.1 回線の劣化（本題材の AGENTS.md の条件）

`tc netem` を、送り手と受け手の端末（Playwright で動かす Chrome・Firefox・Safari）の側に置く。

| 条件 | 期待 |
| --- | --- |
| 受け手の損失 5%・20%（ランダムとバースト（Gilbert-Elliott）） | 音声の MOS の推定が NFR-003 を満たす。映像は層が下がっても、1 秒以上の停止が 1 分に 1 回以下（[quality.md](../quality.md) の 2.2.1 節で決めた） |
| 揺らぎ 30ms・100ms | 音声の遅れ（mouth-to-ear）が NFR-001 を満たす |
| 受け手の下り 3 Mbps → 500 kbps → 150 kbps → 3 Mbps | 5 秒以内に層が下がる。150 kbps で音声だけが続く。回復で 10 秒以内に元の層（NFR-009） |
| 送り手の上り 500 kbps | 他の受け手は低い層を受け、止まらない。`media.layers.hint` で使わない層が止まる |
| RTT 200ms | 遅れが NFR-001 の予算の中で RTT の分だけ伸びる |
| 3 人の会議で 1 人の下りだけを 500 kbps | その人だけ低い層。他の 2 人は変わらない（ADR-0002 の Confirmation） |

### 12.2 障害の注入

| 注入 | 期待 |
| --- | --- |
| Media Node のインスタンスを止める（EC2 の `StopInstances` の強制、または `iptables` で全部落とす） | 全参加者の音声が 5 秒以内に戻る（NFR-004）。受けた音声の途切れの長さの分布を記録する |
| worker を `SIGKILL` | その worker の参加者だけが付け替わり、5 秒以内に戻る。他の参加者の途切れは 0 |
| Node Agent を `SIGKILL`（worker は子プロセスなので一緒に止まる） | Node の障害と同じ |
| Actor Host を止める | メディアは止まらない（受けた RTP の途切れ 0） |
| 古い `epoch` の Actor から `producer.pause` | `stale_epoch` で拒否され、音声は止まらない |
| Node と Assignment Service の間の分断（心拍だけが止まる） | クライアントの `media.stall` がないので、付け替えない（誤判定を起こさない） |
| 1 人の参加者の回線を 10 秒切る | その人だけ ICE restart。他の人の付け替えはない |
| drain（make-before-break） | 音声の途切れが 500ms 以下（**未検証**。E10 の `make-before-break-migration` で測る） |

### 12.3 負荷

- 1 台の Node で、会議の大きさ（2、10、25、100 人）の組み合わせを増やし、ENA の `*_allowance_exceeded` が増えず、転送の遅れ（受信から送出まで）が p99 10ms 以内に収まる参加者の数を、インスタンスの種類ごとに求める（ADR-0001 の Confirmation。E7）。
- 2 台の Node にまたがる会議で、Node をまたぐ遅れの増加が p95 30ms 以内（ADR-0002 の Confirmation。E10）。

### 12.4 性質ベーステスト

- **PROP-SFU-001（購読）**：任意の `view.update`・話者・共有の列で、受け手ごとの映像の consumer の数は 25 以下で、画面共有があれば必ず含まれる。
- **PROP-SFU-002（層の上限）**：任意の表示の大きさで、consumer の `preferredLayers` は codecs-and-bandwidth-adaptation.md の 6.3 節の上限を超えない。
- **PROP-SFU-003（冪等）**：`transport.create` を任意の回数再試行しても、`(meeting, participant, direction, generation)` ごとに 1 つ。
- **PROP-SFU-004（epoch）**：任意の順で届いた呼び出しで、状態を変えるのは最大の `epoch` 以上のものだけ。
- **PROP-SFU-005（枠の連続）**：任意の話者の列と切り替えで、枠の出力の RTP の連番は抜けも重なりもなく増え、時刻は減らない。枠の中の送り手の切り替えは、保持の 1.5 秒より短い間隔で起きない（[ADR-0057](../decisions/0057-audio-slots-for-large-meetings.md)）。
- **PROP-SFU-006（枠の数）**：`audio_mode = slots` の会議で、受け手 1 人の音声の consumer は 3 以下（下り 150 kbps 未満なら 2 以下）。

## 13. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E2 | `media-node-agent-skeleton` | 3 節。worker の起動、コアへの固定、WebRtcServer、router の作成 |
| E2 | `media-node-control-api` | 4 節。mTLS、Zod のスキーマ、`epoch` の検査、冪等 |
| E2 | `assignment-service-basic` | 8.1 節。負荷の報告、点、2 台からの選択、予備の Node |
| E2 | `subscriptions-and-layers` | 5.1・5.2 節。購読の集合、層の上限、優先度 |
| E4 | `audio-top-n` | 5.3 節 |
| E4 | `sender-layer-hint` | 5.5 節。使われない層を送り手に止めさせる |
| E4 | `keyframe-control` | 7 節 |
| E4 | `active-speaker` | 6 節 |
| E4 | `sfu-netem-suite` | 12.1 節の試験を CI で回す |
| E7 | `worker-spread-pipe` | 3 節。家の worker、`pipeToRouter`、pipe の片付け |
| E7 | `media-node-failover` | 9.1 節。検知、`media.reattach`、音声を先に |
| E7 | `worker-died-recovery` | 9.2 節 |
| E7 | `media-node-load-test` | 12.3 節。1 台の上限の値を capacity.md に渡す |
| E7 | `audio-slot-forwarder-poc` | 5.3 節の音声の枠の PoC（[ADR-0057](../decisions/0057-audio-slots-for-large-meetings.md) の Decision の確かめること）。E10 の `audio-slot-forwarder` の前 |
| E10 | `node-drain-mbb` | 10 節 |
| E10 | `intra-region-cascade` | 8.3 節。台の間の PipeTransport、1 ホップのつなぎ |
| E10 | `audio-slot-forwarder` | 5.3 節。100 人を超える会議の音声の枠（capacity.md の `audio-slot-consumers` と 1 つ） |

## 14. 未解決の問い

### 決定

2026-09-27 に推奨案で確定した（[README.md](README.md) の 6 節の「決定（2026-09-27、推奨案で確定）」）。

- **worker の数**：vCPU−2。コアに固定する。
- **ポート**：worker ごとに UDP・TCP の 20000＋番号。
- **worker あたりの consumer の上限**：400（mediasoup の目安 500 に余裕を置く）。
- **音声の絞り込み**：受け手ごとに最大 3 本（上位＋主な話者＋直近 1.5 秒）。下り 150 kbps 未満で 2 本。
- **キーフレームの間隔**：カメラ 1,000ms、共有 2,000ms。
- **Node の障害の判定**：心拍 1.5 秒の欠落、またはクライアント 2 人以上の途絶の報告。
- **予備の Node**：会議ごとに別の AZ の 1 台を決めておく。資源は取らない。
- **S2 のカスケード**：送り手の Node から受け手の Node へ直接の 1 ホップ。pipe は全部の層を運ぶ。
- **大きな会議の音声**：100 人を超える会議は、受け手ごとに 3 つの音声の枠（[ADR-0057](../decisions/0057-audio-slots-for-large-meetings.md)。統合の工程で決めた）。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| 1 台の Node の上限（consumer、pps、送出） | E7 の負荷試験（capacity.md） |
| mediasoup は音声を割り当てに入れない（確かめた）。音声の分を推定から残す方法 | E4 の `downlink-allocation` |
| consumer の再開で、mediasoup が自動でキーフレームを求めるか | 決着：求める（worker の実装で確かめた。7 節） |
| リージョンの間で「要る層だけ」を運ぶ方法（pipe の代わりの consumer の連結） | S3 の前に試作して ADR にする |
| `top_n` で話し始めが落ちる長さと、4 人目以降の声が届かないことが許せるか | E4・E7 で、聞いた人の評価で決める。許せなければ、少人数の会議で N を増やす |
| 1:1 の会議の P2P | S2 で、別の ADR（ADR-0002） |
| TURN を通る参加者の付け替えの時間 | E7 の `media-node-failover` の障害の注入で測る |

## 15. quality.md・runbooks・data-model への項目

### quality.md

- 転送の遅れ（Node の受信から送出まで）の p50・p99。worker ごと。
- Node の障害から音声が戻るまでの時間の分布（障害の注入の訓練で、参加者ごと）。
- 受け手ごとの受けた層の分布と、層の切り替えの回数（1 分あたり）。
- 映像の停止（1 秒以上）の回数と長さ（クライアントの `getStats` の `freezeCount`・`totalFreezesDuration`）。
- キーフレームの要求の数（producer・分あたり）と、キーフレームによる送り手の送出の増え方。
- `top_n` の切り替えの回数と、話し始めの欠けの長さの推定。
- ENA の `*_allowance_exceeded` の増分（0 であること）。

### runbooks

- `media-node-failure.md`：Node が落ちたときの確かめ方（心拍、`media.reattach` の数、戻るまでの時間）と、同じ種類の Node が続けて落ちるとき（AMI、mediasoup の版）の切り戻し。
- `media-node-allowance-exceeded.md`：ENA の `pps_allowance_exceeded` などが増えたときの確かめ方と、その Node の drain、`*_limit` の見直し。
- `mediasoup-worker-died.md`：worker の異常終了の調べ方（`trace` のイベント、コアダンプを取らない前提での再現）と、上流への報告。
- `keyframe-storm.md`：1 人の送り手の送出がキーフレームで膨らむときの確かめ方と、`keyFrameRequestDelay` の引き上げ。
- `node-drain.md`：Node を計画して止める手順（drain、待つ、make-before-break での移動）。

### data-model（索引への追加の提案）

| 置き場所 | 中身 |
| --- | --- |
| Valkey `mnode:{node_id}:load` | Node の最新の負荷の報告（TTL 5 秒） |
| Valkey `mnode:{node_id}:state` | `active`・`draining`・`dead` |
| Aurora `meeting_media_assignments` | `instance_id`、`media_generation`、`node_id`、`role`（`primary`・`secondary`・`standby`）、`assigned_at`、`released_at`、`reason`（診断と費用の集計に使う） |
| Media Node のメモリ | 会議ごとの最大の `epoch`、router・transport・producer・consumer の表（再起動で消える） |

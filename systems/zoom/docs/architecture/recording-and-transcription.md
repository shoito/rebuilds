# Recording and Transcription: Zoom

クラウド録画と、日本語のライブ字幕・文字起こしの設計。録画の取り方（SFU からの購読と、会議の後の合成）、保存と共有と保持、音声認識のエンジン、録画と字幕の表示と同意、E2EE の会議で動かさない仕組みを決める。

前提となる決定は、SFU での中継と「録画だけはサーバーで合成する」方針（[ADR-0002](../decisions/0002-media-topology.md)）、既定はホップごとの暗号化で、E2EE の会議ではサーバーで内容を扱う機能を動かさないこと（[ADR-0004](../decisions/0004-encryption-and-e2ee.md)）、会議の状態は Meeting Actor が持つこと（[ADR-0005](../decisions/0005-meeting-state-and-signaling.md)）、Actor の `epoch`（[ADR-0007](../decisions/0007-meeting-actor-lease-and-epoch.md)）、Media Node の購読の API（[ADR-0011](../decisions/0011-forwarding-and-layer-selection.md)）。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0025](../decisions/0025-recording-per-track-capture-and-offline-compose.md) | 録画は、見えない参加者として画面に入るボット（ヘッドレスのブラウザ）では取らない。Recorder が Media Node から PlainTransport（SRTP）で RTP を受け、producer ごとの生の RTP を 10 秒の区切りで S3 に書く。1 本の動画への合成は、会議の後に Composer がまとめて行う |
| [0026](../decisions/0026-asr-engine-amazon-transcribe-with-adapter.md) | 日本語の音声認識は、S1 では Amazon Transcribe のストリーミング（ja-JP、東京）を使う。参加者ごとの音声を別の流れで送り、話者の判定をエンジンに頼らない。エンジンは ASR Adapter の裏に置き、E8 の前に評価用の音声のセットで自前でホストする Whisper 系と比べる |
| [0027](../decisions/0027-capture-consent-and-indicators.md) | 録画・文字起こしの状態は Actor が持ち、全員に表示する。動いている間は、本人が「同意して続ける」を押すまで、その人のマイク・カメラ・共有を Actor と Media Node で止める。表示の機能を持たない版のクライアントは入れない。E2EE の会議では、API・Actor・Media Node の 3 か所で開始を拒否する |

## 1. 目的と範囲

- 扱う：クラウド録画の開始と停止、Recorder と Composer、録画の形式とレイアウト、保存・共有・保持・削除、日本語のライブ字幕、会議の後の文字起こし、音声認識のエンジンの選び方、録画と字幕の表示と同意、E2EE の会議での禁止。
- 扱わない：Media Node の中の転送（[media-server-sfu.md](media-server-sfu.md)）、シグナリングの封筒（[signaling-and-meetings.md](signaling-and-meetings.md)）、E2EE の鍵（[e2ee.md](e2ee.md)）、録画のファイルの暗号の鍵の階層（[security.md](security.md)）、Recorder を置くインスタンスの種類（[infrastructure.md](infrastructure.md)）、録画の費用の見積もり（[capacity.md](capacity.md)）、端末の上での録画（MVP の後）、AI の要約（MVP の後。[intent.md](../intent.md)）。

## 2. 本家の形（確かめたこと）

| 項目 | 本家（公開情報） | この設計 |
| --- | --- | --- |
| 録画の種類 | 話者と共有の画面を 1 本に、ギャラリーと共有の画面を 1 本に、話者・ギャラリー・共有の画面を別々の動画に、音声だけ（全員で 1 つ、参加者ごと、その両方）を選べる。参加者ごとの音声は最大 200 人。会議のチャットを TXT で残す設定もある（[Changing basic and advanced cloud recording settings](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0064676)） | 話者＋共有、ギャラリー、音声だけ（m4a）を作る。参加者ごとの音声は、組織の設定で選べる（4.4 節） |
| 録画の表示と同意 | 録画が始まると同意の表示が出て、OK で同意し、Leave で退出する。管理者は、同意の表示を社外の参加者だけに出すか全員に出すかを選べる（[Providing consent to be recorded](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0059819)）。応答しないまま残る人の扱いは書かれていない | 残ることを同意とみなさない。本人が押すまで、その人の音声と映像を送らせない（ADR-0027） |
| 保持と削除 | 削除した録画は、ふつう 30 日の間ごみ箱から戻せる。設定によって期間は変わる（[Recovering a deleted local or cloud recording](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0060380)） | 組織の設定で保持の日数を決め、ごみ箱は 30 日（6 節） |
| E2EE の会議 | クラウド録画、ライブの文字起こしなどが使えない（[End-to-end encryption for meetings](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0065408)） | 同じ（[ADR-0004](../decisions/0004-encryption-and-e2ee.md)、ADR-0027） |
| 録画の作り方 | 公開の一次の資料に書かれていない | 会議の後に合成する（ADR-0025） |

いずれも 2026-09-27 に確認。

### 2.1 Amazon Transcribe で確かめたこと

| 項目 | 内容 | 出典 |
| --- | --- | --- |
| 日本語 | ja-JP は batch と streaming の両方に対応。数の書き方の変換あり、カスタム言語モデル（batch・streaming）あり、個人情報の伏せ字はなし | [Supported languages](https://docs.aws.amazon.com/transcribe/latest/dg/supported-languages.html) |
| 東京のストリーミング | `transcribestreaming.ap-northeast-1.amazonaws.com` がある。ja-JP は「東京で streaming が使えない言語」の印（*）が付いていない | [endpoints and quotas](https://docs.aws.amazon.com/general/latest/gr/transcribe.html)、同上 |
| 音声の形式 | FLAC、Ogg に入れた Opus、PCM（符号付き 16 ビット、リトルエンディアン）。16,000 Hz を勧める。1 つの塊は 50〜200ms | [Transcribing streaming audio](https://docs.aws.amazon.com/transcribe/latest/dg/streaming.html) |
| 同時の流れ | 既定で 1 リージョンに 25（引き上げの申請ができる）。開始の要求は毎秒 25 | [endpoints and quotas](https://docs.aws.amazon.com/general/latest/gr/transcribe.html) |
| 1 つの流れの長さ | 上限がある（引き上げられない）。4 時間 | 上限があることは [Transcribing streaming audio](https://docs.aws.amazon.com/transcribe/latest/dg/streaming.html)。4 時間は [Transcribe の FAQ](https://aws.amazon.com/transcribe/faqs/)（「The streaming service can accommodate open connections up to four hours long」） |
| 途中の結果 | `IsPartial` で確定前を示す。安定化（low・medium・high）を有効にすると、`Stable` の語は変わらない | [Streaming and partial results](https://docs.aws.amazon.com/transcribe/latest/dg/streaming-partial-results.html) |
| 話者の区別 | 最大 30 人。streaming でも使える | [Partitioning speakers](https://docs.aws.amazon.com/transcribe/latest/dg/diarization.html) |
| batch の上限 | クォータの表では 1 ファイル 28,800 秒（8 時間）、2 GB。FAQ は batch を 1 回 4 時間（または 2 GB）と書く。設計は短い方の 4 時間に合わせる | [endpoints and quotas](https://docs.aws.amazon.com/general/latest/gr/transcribe.html)、[Transcribe の FAQ](https://aws.amazon.com/transcribe/faqs/) |
| 提供のリージョン | 東京に batch と streaming の受け口がある。大阪にはどちらもない | [endpoints and quotas](https://docs.aws.amazon.com/general/latest/gr/transcribe.html) |
| カスタム語彙 | すべての対応言語で使える（ja-JP を含む）。リストの形は廃止に向かっており、表の形を使う。語彙のファイルは 50 KB まで、1 アカウントに 100 まで | [Custom vocabularies](https://docs.aws.amazon.com/transcribe/latest/dg/custom-vocabulary.html) |
| 料金 | 東京の streaming は 1 秒 0.0001667 USD（1 分 0.01 USD、段階なし）。カスタム言語モデルの streaming は最初の 25 万分まで 1 秒 0.0001 USD | [AWS Price List API](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/transcribe/current/ap-northeast-1/index.json)（`APN1-StreamingAudio`・`APN1-TranscribeStreamingClm`） |
| AI サービスのオプトアウト | Transcribe は AWS Organizations の AI サービスのオプトアウトのポリシーの対象。オプトアウトしないと、内容をサービスの改善に使い、別のリージョンに置くことがある | [AI services opt-out policies](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_ai-opt-out.html)、[対象のサービスの一覧](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_ai-opt-out_all.html) |
| 日本語の誤り率と遅れ | — | **未検証**。E8 の `asr-evaluation-set` で評価する（8 節） |

いずれも 2026-09-27 に確認。

## 3. 構成

```
Meeting Actor ── recording.start（決定表）── Aurora（recordings の行、outbox）
   │ subscriptions.apply{receiver: "rec_…"}（epoch 付き）
   ▼
Media Node（Node Agent）
   │ PlainTransport（SRTP、VPC の中の UDP）。consumer は producer ごと
   ▼
Recorder（ECS のタスク。会議 1 つにつき 1 つ）
   │ producer ごとの生の RTP を 10 秒の区切りで書く（rtpseg）
   │ マニフェスト（誰が・いつ・どの producer・話者・共有）を追記
   ▼
S3 raw/（東京、SSE-KMS）───── 会議の終了 ──▶ SQS ──▶ Composer（ECS、CPU の多いタスク）
                                                        │ 復号・合成・H.264/AAC に符号化
                                                        ▼
                                                  S3 final/（mp4・m4a・vtt・txt）
                                                        │ outbox
                                                        ▼
                                             Worker：通知、Webhook（recording.completed）

Meeting Actor ── captions.start ── subscriptions.apply{receiver: "asr_…", audio only}
   ▼
Media Node ── PlainTransport（SRTP）──▶ Transcriber（ECS のタスク）
                                          │ Opus を復号 → 16 kHz の PCM → 話者の枠（5.3 節）
                                          ▼
                                     ASR Adapter ──▶ Amazon Transcribe streaming（ja-JP、東京）
                                          │ 途中の結果・確定した結果
                                          ▼
                                     Actor Host（mTLS）──▶ Gateway ──▶ クライアント（eph caption.*）
                                          │ 確定した結果
                                          ▼
                                     S3 transcripts/（会議の間は区切りごとに追記）
```

- Recorder と Transcriber は、SFU から見ると受け手の 1 人である（[architecture/README.md](README.md) の 1 節）。ただし WebRTC のクライアントではなく、Node の PlainTransport で RTP を直接受ける。参加者の一覧には出さない。そのかわり、録画・文字起こしの状態を全員に表示する（7 節）。
- Recorder・Transcriber・Composer は、制御の側へ同期で問い合わせない形にしない。Actor の指示を受けて動き、結果は S3 と通知で返す。メディアの転送は止めない（本題材の AGENTS.md）。

## 4. クラウド録画

ADR-0025。

### 4.1 録画の状態

| 状態 | 意味 | 次の状態 |
| --- | --- | --- |
| `off` | 録画していない | `starting` |
| `starting` | Actor が全員に表示を配った。Recorder を割り当て中 | `on`、`failed` |
| `on` | Recorder が RTP を受けて書いている | `paused`、`stopping` |
| `paused` | 一時停止。Recorder は RTP を捨てる。表示は「一時停止中」 | `on`、`stopping` |
| `stopping` | 書き終わりを待つ | `off` |
| `failed` | Recorder を 3 回割り当て直しても動かない | `off`（主催者に知らせる） |

- 1 回の開催（`instance_id`）で、録画を何度止めて始め直しても、1 つの `recording_id` にまとめる。区間（`segments`）を分けて持つ。本家の扱いは公開の一次の資料に書かれていない（この設計はそれに依らない）。
- 状態は Actor の状態（スナップショットの `recording`）に入れ、`meeting.status` の差分で配る（[signaling-and-meetings.md](signaling-and-meetings.md) の 6.2 節）。

### 4.2 開始の判定（決定表の草案）

上から順に評価し、最初に一致した行を採る。ID は E8 の `spec.md` に移すときに振る（`DT-REC-*`）。

| # | 会議が E2EE | 組織の設定 `cloud_recording` | 操作した人の役割 | 組織の保存の容量 | 結果 |
| --- | --- | --- | --- | --- | --- |
| 1 | はい | - | - | - | 拒否 `e2ee_incompatible` |
| 2 | いいえ | `disabled` | - | - | 拒否 `recording_disabled` |
| 3 | いいえ | `enabled` | `attendee` | - | 拒否 `forbidden`。主催者に「録画の依頼」を送れる（`request.recording`） |
| 4 | いいえ | `enabled` | `host`・`cohost` | 超えている | 拒否 `storage_quota_exceeded` |
| 5 | いいえ | `enabled` | `host`・`cohost` | 余裕あり | 受ける。`starting` へ |

- 自動の録画（予定の会議の設定 `auto_recording: cloud`）は、会議が Live になったとき、Actor が主催者として 5 行目を評価する。
- 同じ判定を、API（予定の会議の作成と更新、[api-and-webhooks.md](api-and-webhooks.md)）でも行う。E2EE の会議に `auto_recording: cloud` は付けられない（422）。

### 4.3 Recorder

```
Actor                          Recorder Pool（ECS）             Media Node（Node Agent）
  │ recorder.assign{meeting, epoch} ─▶│ 空いたタスクを 1 つ取る        │
  │◀──── {recorder_id, rtp_ip, rtp_port, srtp_key_ref} ───────────│    │
  │ subscriptions.apply{receiver: rec_…, plain: {ip, port, srtp}, epoch} ───────────────────▶│
  │                                                                 │  PlainTransport を作り、
  │                                                                 │  会議のすべての producer の consumer を作る
  │◀──────────────────── consumer の一覧（ssrc、payload type、producer_id）───────────────────│
  │ recorder.start{consumers, manifest_seed} ─▶│ 書き始める                                    │
  │ evt meeting.status{recording: on} を全員へ
```

- **受ける層**：カメラは空間の層 1（360p 相当）までにする。ただし、合成で大きく出す見込みの人（主な話者、ピン留め）の分は層 2 まで。画面共有は最大の層。音声はすべての producer（話者の絞り込み（[ADR-0011](../decisions/0011-forwarding-and-layer-selection.md)）の対象にしない）。Recorder・Transcriber は RED に対応しない受け手として扱い、RED を剥がした Opus を受ける（[codecs-and-bandwidth-adaptation.md](codecs-and-bandwidth-adaptation.md)）。
- **producer の出入り**：Actor は、producer が増えたり閉じたりするたびに、Recorder の受け手の購読（`subscriptions.apply` の差分）を更新する。同意していない人の producer は購読に入れない（7 節）。
- **書き方（rtpseg）**：producer ごとに、受けた RTP のパケットをそのまま、受けた時刻（単調な時計の ns）と一緒に書く。10 秒ごとにファイルを閉じ、S3 の `raw/{org}/{recording_id}/{producer_id}/{seq}.rtpseg` に上げる。上げ終わったら、マニフェストに区切りを追記する。
  - SRTP は Recorder の入口で外す。書くのは、SRTP を外した RTP である。S3 の上では SSE-KMS で暗号化する（9 節）。
  - 生の RTP で書くので、Recorder は符号を解かない。CPU をほぼ使わない。1 タスクで多数の会議を受け持てるが、障害の影響を小さくするため、1 タスクで 1 会議とする（Fargate の最小の大きさで足りる見込み。**未検証**で、E8 の `recorder-rtp-capture` で 100 人の会議の CPU とメモリを測る）。
- **マニフェスト**（`raw/{org}/{recording_id}/manifest.jsonl`、1 行 1 イベント）：

```jsonc
{ "t": 1790000000123456789, "type": "segment", "producer": "pr_cam_7Q", "seq": 17, "key": "raw/.../17.rtpseg", "bytes": 1893920, "sha256": "..." }
{ "t": 1790000000200000000, "type": "producer", "op": "open", "producer": "pr_mic_7Q", "participant": "p_7Q", "kind": "audio", "source": "mic", "codec": "opus/48000/2", "pt": 100, "ssrc": 1234 }
{ "t": 1790000001000000000, "type": "speaker", "participant": "p_7Q" }
{ "t": 1790000002000000000, "type": "share", "op": "start", "participant": "p_2M", "producer": "pr_scr_2M" }
{ "t": 1790000003000000000, "type": "pause" }
{ "t": 1790000004000000000, "type": "participant", "participant": "p_7Q", "display_name": "山田", "consented_at": "..." }
```

- 話者と共有の出来事は、Actor が Recorder に送る（Recorder は音量で話者を決めない。会議の画面の話者と、録画の話者を合わせるため）。
- **Recorder の障害**：Actor は Recorder の心拍（2 秒ごと、3 回の欠落）で気づき、新しいタスクを割り当てて購読を付け替える。失うのは、最後に閉じた区切りから後の最大 10 秒と、付け替えの数秒。マニフェストに `gap` を書く。3 回失敗したら `failed` にし、主催者に知らせる。
- **Media Node の付け替え**（[ADR-0013](../decisions/0013-media-node-failover-and-reattach.md)）：新しい Node に購読を作り直す。producer の ID は変わる。マニフェストの `producer` の `open` で、同じ `participant` と `source` に結び付け直す。

### 4.4 Composer と成果物

- 会議の終了（`stopping` → `off`）で、Actor が outbox に `recording.compose` を書く。Worker が SQS に入れ、Composer が取る。
- Composer は、区切りを並べ、RTP のタイムスタンプと受けた時刻から、producer ごとに時刻を合わせる。欠けたパケットは、音声は無音、映像は直前のフレームで埋める。
- 成果物：

| 種類 | 形式 | 既定 | 中身 |
| --- | --- | --- | --- |
| `speaker_share` | MP4（H.264 High、AAC-LC 48 kHz）、1280×720、最大 30fps | 作る | 共有がある間は、共有を大きく、話者を右上に小さく。ない間は話者を全面に |
| `gallery` | MP4、1280×720 | 組織の設定 | 最大 25 人の格子。映像のない人は名前の枠 |
| `audio` | M4A（AAC-LC） | 作る | 全員の音声を混ぜたもの |
| `audio_per_participant` | M4A を参加者ごと | 組織の設定（既定は作らない） | 本人の音声だけ |
| `chat` | テキスト（UTF-8） | 作る（チャットが録画に残る設定のとき。[chat-and-reactions.md](chat-and-reactions.md)） | 録画の区間の全員へのメッセージ。個別のメッセージは入れない |
| `transcript` | WebVTT と JSON | 文字起こしを残す設定のとき（5.5 節） | 話者つき |

- 名前は、マニフェストの `display_name`（参加した時点のもの）を合成の画面に焼き込む。後から名前を直せないので、利用者向けの説明に書く。
- 合成の速さの目標：NFR-010（会議の終了から、録画の長さの半分以内に見られる）。1 時間の会議で 30 分。Composer は録画の長さの 2 倍より速く合成する必要がある。1280×720 の合成と H.264 の符号化が、16 vCPU の Fargate で何倍の速さで動くかは**未検証**（E8 の `recording-compose` で計測する。足りなければ区間ごとに並列で合成し、最後につなぐ）。
- 成果物を書き終えたら、`recordings.status = completed` にし、outbox に `recording.completed` を書く（通知と Webhook）。Composer は `media-prod` にあり Aurora に触れないので、結果を SQS `recording-events` で Worker に渡し、Worker がこの更新を行う（[data-model.md](data-model.md) の 2.1 節）。この時点で「成功を知らせた録画」になる。以後、保持の期間の中で失わない（S3 の耐久性と、バージョニング）。
- 生の区切り（`raw/`）は、合成の成功から 7 日後に消す。合成をやり直せる余地として残す。

## 5. ライブ字幕と文字起こし

ADR-0026。

### 5.1 字幕の状態と開始の判定

- 状態：`off`・`on`。Actor が持ち、`meeting.status.transcribing` で全員に配る。
- 開始の判定は 4.2 節と同じ表を使う（組織の設定は `live_captions`）。3 行目の依頼は `request.captions`。
- 字幕を始めると、文字起こし（サーバーが音声を文字にすること）が動く。そのため、録画と同じ同意（7 節）を求める。字幕を「表示するだけ」の人も、話す人の同意は要る。

### 5.2 Transcriber の流れ

1. Actor が `transcriber.assign` で Transcriber のタスクを取り、`subscriptions.apply{receiver: "asr_…", audio: all, plain: …}` を Node に送る。映像は受けない。
2. Transcriber は producer ごとに Opus を復号し、48 kHz から 16 kHz のモノラルの PCM に落とす。
3. 話者の枠（5.3 節）を持つ人の PCM を、100ms の塊で ASR Adapter に渡す（AWS の勧める 50〜200ms の範囲）。
4. ASR Adapter は、枠ごとに Transcribe の流れを 1 本開く。`language-code=ja-JP`、`media-encoding=pcm`、`sample-rate=16000`、途中の結果の安定化を `high`。話者の区別は使わない（流れが話者ごとなので要らない）。
5. 結果を Actor Host へ送り、Actor が全員へ配る。

```jsonc
// Actor → クライアント。一時的なイベント（seq なし）
{ "t": "eph", "name": "caption.partial", "body": { "seg": "s_7Q_0042", "participant": "p_7Q", "text": "来週の定例は", "stable_len": 3 } }
{ "t": "eph", "name": "caption.final",   "body": { "seg": "s_7Q_0042", "participant": "p_7Q", "text": "来週の定例は木曜にします。", "start_ms": 81230, "end_ms": 83410 } }
```

- 字幕は `eph`（落としてよい）で送る。落ちても、次の `caption.*` で上書きされる。後から入った人に、過去の字幕は送らない。後から読むのは文字起こし（5.5 節）である。
- クライアントは `seg` ごとに表示を置き換える。`stable_len` の文字までは確定の書体、残りは薄く出す（[Streaming and partial results](https://docs.aws.amazon.com/transcribe/latest/dg/streaming-partial-results.html) の勧めに合わせる）。

### 5.3 話者の枠

参加者ごとに流れを開くと、話す人が少なくても流れの数が参加者の数に比例する。そこで、会議ごとに「話者の枠」を持つ。

| 項目 | 既定 | 理由 |
| --- | --- | --- |
| 1 会議の枠の数 | 4 | 同時に話す人は多くても数人。会議の実測はない（**未検証**。E8 の `transcriber-live-captions` で、枠の取り上げの回数を測って見直す） |
| 枠を渡す条件 | Transcriber の声の検出（VAD）で、ミュートでない人の発話を 200ms 検出した | 咳や物音で枠を使わない |
| 前の音声 | 枠を渡す前の 1 秒を貯めておき、流れの最初に送る | 流れを開く遅れで、話し始めの語を失わない |
| 枠を返す条件 | 20 秒続けて発話がない | 流れを開き直す回数を抑える |
| 枠が埋まっている | 最も長く話していない人の枠を取り上げる | 今話す人を優先する |
| 流れの長さ | 3 時間 50 分で、新しい流れに切り替える（前の音声 1 秒を重ねて送る） | 1 つの流れの上限（4 時間。2.1 節）の手前で替える |

- 流れを話者ごとに分けるので、字幕と文字起こしの話者は、会議の参加者の名前と必ず合う。会議室の 1 本のマイクを複数の人で使う場合は、1 人として扱う（MVP）。
- 無音の間は、枠を返すまで、同じ長さの無音を送る（AWS の勧め）。料金は streaming の音声の秒で数える（2.1 節の料金は 1 秒ごと）ので、枠を返すまでの 20 秒の無音も費用に入る。1 つの枠の 1 回の発話の後ろに、最大 20 秒分（約 0.0033 USD）が足される。

### 5.4 遅延の予算

NFR-010：発話から字幕の表示まで p95 2 秒。

| 区間 | 予算（p95） |
| --- | --- |
| 端末 → Media Node（ジッタを含む） | 150ms |
| Media Node → Transcriber（VPC の中） | 10ms |
| 復号・リサンプル・100ms の塊にためる | 120ms |
| Transcribe の最初の途中の結果 | 1,000ms（**未検証**。E8 の `asr-evaluation-set` で測る） |
| Transcriber → Actor Host → Gateway → 端末 | 200ms |
| 描画 | 50ms |
| 余裕 | 470ms |

### 5.5 文字起こし（会議の後）

- 組織の設定 `save_transcript`（既定：録画があるときだけ残す）で、確定した結果を残すか決める。
  - 字幕だけで録画がない会議で、主催者が「文字起こしを残す」を選んだときも残す。その場合も同意（7 節）は同じ。
- 確定した結果は、Transcriber が 30 秒ごとに S3 の `transcripts/{org}/{instance_id}/part-{n}.jsonl` に追記する。会議の終了で、Composer がつなぎ、WebVTT と JSON にする。
- 字幕を動かしていない会議で録画だけがあり、組織が「録画から文字起こしを作る」を有効にしているときは、会議の後に、参加者ごとの音声（`audio_per_participant` を内部で作る）を Transcribe の batch に渡す（1 ファイル 4 時間・2 GB まで）。話者は参加者ごとのファイルで決まる。
- 文字起こしの JSON：

```jsonc
{ "instance_id": "mi_01J9...", "language": "ja-JP", "engine": "transcribe-streaming", "engine_version": "2026-09",
  "segments": [ { "participant": "p_7Q", "display_name": "山田", "start_ms": 81230, "end_ms": 83410,
                  "text": "来週の定例は木曜にします。", "confidence": 0.93 } ] }
```

### 5.6 語彙

- 組織ごとに、固有名詞（社名、製品名、人名）の語彙を登録できる。ASR Adapter が、エンジンのカスタム語彙に写す。カスタム語彙はすべての対応言語で使える（2.1 節）。ja-JP で no なのは、表の形の語彙で頭字語を扱う機能（「Acronyms」の列）だけである。語彙で足りなければ、カスタム言語モデル（ja-JP は streaming でも対応）を検討する。効果は E8 の `custom-vocabulary` で測る。
- 利用者の会議の内容で、モデルを学習しない（intent.md の Non-goals）。AWS の AI サービスのオプトアウトのポリシーを、AWS Organizations で設定する（Transcribe は対象。2.1 節）。オプトアウトしないと内容が別のリージョンに置かれうるので、E8 の着手前に必ず設定する。

## 6. 保存・共有・保持

### 6.1 置き場所

| 接頭辞 | 中身 | 保持 |
| --- | --- | --- |
| `raw/{org}/{recording_id}/` | 生の RTP の区切り、マニフェスト | 合成の成功から 7 日。失敗したら 30 日（調べるため） |
| `final/{org}/{recording_id}/` | 成果物 | 組織の保持の設定（6.3 節） |
| `transcripts/{org}/{instance_id}/` | 字幕の確定した結果、文字起こし | 録画と同じ。録画がなければ組織の設定 |

- バケットは東京に 1 つ（環境ごと）。大阪へはレプリケーションしない（S1）。録画の置き場所を国内に限ることを約束するかは、L6 の結論に従う。
- 暗号化は SSE-KMS。組織ごとにデータの鍵を分けるか、顧客が持つ鍵（BYOK）を許すかは security.md で決める。
- 公開のアクセスを禁じる。読むのは API が発行する短命な署名付きの URL（CloudFront、10 分）だけ。

### 6.2 共有

| 共有の範囲 | 既定 | 見る人の条件 |
| --- | --- | --- |
| 主催者だけ | ○ | 主催者と、組織の管理者（録画の管理の権限） |
| 組織の中 | 主催者が選ぶ | 同じ組織のアカウントでログインした人 |
| 組織の外（リンク） | 組織の設定で許したときだけ。既定は許さない | リンクとパスコード（必須）。有効期限（既定 7 日、最長 90 日）。ダウンロードは既定で不可 |

- 外への共有のリンクは、`https://<brand>.<domain>/rec/share/<share-token>` とし、トークンは 128 ビットの乱数。Aurora には SHA-256 だけを置く。パスコードの誤りの回数の制限は meeting-security.md の 6 節と同じ形。
- 再生の記録（誰が、いつ）を `recording_access_events` に残す。主催者と管理者が見られる。

### 6.3 保持と削除

- 組織の設定 `recording_retention_days`（既定 365 日。1〜3,650 日、または無期限）。期限を過ぎたら、ごみ箱に移す。
- ごみ箱は 30 日。この間は主催者と管理者が戻せる。30 日を過ぎたら、S3 から消す（バージョンも消す）。本家と同じ 30 日にする（2 節）。
- 組織の管理者は、録画に「保全」（legal hold）を付けられる。付いている間は、期限を過ぎても消さない。利用者も消せない。
- 利用者が消した録画も、ごみ箱に 30 日残る。すぐに消す操作（完全な削除）は、管理者だけに許す。
- 消したことを `recording_deletions` に記録する（誰が、いつ、理由）。中身は残さない。
- 保持の期間の既定と、社外の参加者の開示・削除の請求の扱いは、L6・L8 の結論に従って見直す。

## 7. 表示と同意

ADR-0027。

### 7.1 表示

- 録画か文字起こしが `off` 以外のとき、クライアントは会議の画面の上端に、常に消せない表示を出す（「録画中」「一時停止中」「文字起こし中」）。
- 待合室にいる人にも、会議が録画中であることを示す（`waiting` の画面に `meeting.status` の録画の項目だけを送る。参加者の一覧は送らない）。
- 途中から入った人は、`welcome` のスナップショットで状態を受け、入ってすぐに表示する。
- クライアントは、`hello` の `client.features` に `capture_indicator.v1` を入れる。入れていない版のクライアントは、録画か文字起こしが動いている会議に入れない（`err{code: upgrade_required}`）。動いていない会議に入っていて、後から録画が始まったら、その接続を閉じる（`you.removed{reason: client_unsupported}`。ban には入れない）。
- 電話からの参加（MVP の後）では、音声の案内で知らせる（[telephony.md](telephony.md)）。

### 7.2 同意

- 録画か文字起こしが動いている間、本人の同意の記録がない参加者は、次のようにする。
  - 画面に「この会議は録画（文字起こし）されています。同意して続けますか」を出す。「同意して続ける」と「退出」の 2 つだけ。
  - 同意するまで、Actor はその人の `self.update{muted:false}`・`video:true`・`share.request` を `consent_required` で拒否する。Media Node の producer は `paused` のまま。見る・聞くことはできる。
  - Recorder・Transcriber の購読に、その人の producer を入れない。
- 同意の単位は `(instance_id, participant_id, kind)`。`kind` は `recording`・`transcription`。録画の後から字幕が始まったら、改めて字幕の同意を求める。
- 同意は、Aurora の `capture_consents` に書いてから配る（失ってはならない変更。[ADR-0007](../decisions/0007-meeting-actor-lease-and-epoch.md)）。表示した文言の版（`notice_version`）も残す。
- 主催者・共同主催者が録画を始めた場合、始めた本人の同意は、始めた操作で記録する。
- 同意しない人の扱い（退出するしかないか）、通知の文言、社外の参加者への個人情報の利用目的の通知は、L3 の結論に従う。この設計は「同意するまで話せない」を既定にし、文言は差し替えられるようにする。

### 7.3 同意の判定（決定表の草案）

| # | 録画か文字起こしが動いている | 本人の同意の記録 | 操作 | 結果 |
| --- | --- | --- | --- | --- |
| 1 | いいえ | - | マイク・カメラ・共有を始める | ほかの規則（[signaling-and-meetings.md](signaling-and-meetings.md) の 9.2 節）へ |
| 2 | はい | 動いている種類すべてにある | 同上 | ほかの規則へ |
| 3 | はい | 足りない | 同上 | 拒否 `consent_required`。同意の画面を出させる |
| 4 | はい | - | 見る・聞く | 許す |
| 5 | はい | 足りない | `consent.give{kind}` | 記録してから、購読に足す |

## 8. エンジンの評価（E8 の前）

ADR-0026。

- 評価用の音声のセット：会議の音声 20 時間以上。合成した会話と、利用の条件が明らかな公開のデータセットだけを使う（本題材の AGENTS.md）。専門用語、固有名詞、重なった発話、損失 5%・20% の回線を通した音声を含める。
- 指標：文字の誤り率（CER、K7 の 15% 以下）、最初の途中の結果までの遅れと確定までの遅れ（p50・p95）、話者ごとの流れを 1 時間動かす費用、東京の中で完結するか。
- 候補：Amazon Transcribe streaming（既定）、自前でホストする Whisper 系（faster-whisper、kotoba-whisper などを GPU の EC2 で動かし、区切って流す）、その他のクラウドの API（東京に置けるもの）。自前でホストするものは、区切って処理するので遅れが大きくなりうる（**未検証**。`asr-evaluation-set` で測る）。
- 結果は、ADR-0026 の Confirmation にある比較表として、E8 の変更の `quality.md` に残す。基準を満たさなければ、新しい ADR でエンジンを替える。ASR Adapter の境界は替えない。

## 9. 障害のときの振る舞い

| 障害 | 起きること | 回復 |
| --- | --- | --- |
| Recorder のタスクが落ちた | 最大 10 秒＋付け替えの数秒を失う | 4.3 節。マニフェストに `gap`。3 回で `failed` |
| S3 への書き込みが失敗する | Recorder の手元の区切りがたまる | 指数の待ちで再試行。手元に 5 分（約 1 GB の見込み。**未検証**で、E8 の `recorder-rtp-capture` で 100 人の会議の書き込みの量を測る）までためる。超えたら `failed` |
| Media Node の付け替え | 付け替えの数秒を失う | 4.3 節 |
| Actor の持ち主の交代 | 録画は続く（Recorder は最後の購読のまま受ける） | 新しい Actor がスナップショットと Aurora の `recordings` から状態を戻す。`inventory` の `rec_…` の受け手と突き合わせる |
| Composer が失敗する | 録画が `processing` のまま | 3 回まで再試行。だめなら `compose_failed` にし、Ops に知らせる。生の区切りは 30 日残す |
| Transcribe の流れの上限（`LimitExceededException`） | 新しい枠が開けない | 指数の待ちで再試行。字幕に「一部の話者の字幕が遅れています」を出す。上限の引き上げを申請する（runbook） |
| Transcribe が東京で止まった | 字幕が止まる | 字幕を `degraded` にし、全員に示す。会議は続く。文字起こしは、録画から batch で作り直せる（5.5 節） |
| Transcriber のタスクが落ちた | 字幕が数秒止まる | Actor が別のタスクに付け替える |

- どの障害でも、会議のメディアは止めない。録画と字幕は、会議の本体から見て「失敗してよい付属物」である。ただし、表示は実際の状態と合わせる（録画が `failed` なのに「録画中」と出し続けない）。

## 10. セキュリティとプライバシー

- **通信の秘密（L2）**：Recorder・Transcriber・Composer は、会議の内容を扱う。扱ってよい範囲は L2 の結論に従う。結論が出るまで、E8 の録画・字幕の Story の `spec.md` は承認しない（intent.md の表）。
- **ログ**：RTP のペイロード、PCM、字幕と文字起こしの文字、表示の名前をログ・トレース・メトリクスに出さない。出すのは `recording_id`・`instance_id`・`producer_id`・区切りの番号・バイト数・遅れの数値だけ（本題材の AGENTS.md）。
- **ASR の外部の事業者**：Transcribe へ送るのは音声だけで、参加者の名前や会議の題名は送らない。外部の事業者へ委ねることの整理（委託、外国にある第三者）は L6 に従う。
- **E2EE**：3 か所で止める（ADR-0027）。
  - API：E2EE の会議に `auto_recording`・`auto_captions` を付けられない。
  - Actor：`recording.start`・`captions.start` を `e2ee_incompatible` で拒否する。
  - Media Node：`e2ee: true` の router に `rec_…`・`asr_…` の受け手を足す `subscriptions.apply` を拒否する（[media-server-sfu.md](media-server-sfu.md) の 11 節）。
  - E2EE の入り・切りは開催の前だけで、会議の途中では変えられない（[ADR-0030](../decisions/0030-security-code-and-e2ee-feature-limits.md)、[e2ee.md](e2ee.md) の 12 節）。
- **Recorder と Node の間**：PlainTransport は SRTP を有効にする。鍵は会議ごとに作り、Actor が Node と Recorder にだけ渡す。VPC の中でも平文で流さない。
- **再生**：署名付きの URL は 10 分。ダウンロードを許さない共有では、ダウンロードのボタンを出さない。MP4 の範囲の要求だけでは保存を防げないので、そのことを共有を作る画面で示す。HLS などの分割の配信は MVP の後（13 節）。
- **削除**：6.3 節。保全の付いたものは消さない。

## 11. テスト

### 11.1 性質ベーステスト

- **PROP-REC-001（表示）**：任意の操作の列（参加、録画の開始・一時停止・停止、再接続、持ち主の交代）の後、録画が `off` でない間に Admitted の参加者のクライアントは、`recording != off` の状態を持つ。
- **PROP-REC-002（同意）**：Recorder・Transcriber の購読の集合に入る producer は、すべて、その種類の同意の記録を持つ参加者のものである。
- **PROP-REC-003（E2EE）**：E2EE の会議で、`rec_…`・`asr_…` の受け手の consumer が作られることはない。
- **PROP-REC-004（マニフェスト）**：マニフェストの区切りの列は、producer ごとに `seq` が 1 ずつ増える。欠けた番号は、必ず `gap` の行で説明される。

### 11.2 決定表

- 4.2 節と 7.3 節の各行（`DT-REC-*`）。

### 11.3 結合と障害の注入

| 試験 | 期待 |
| --- | --- |
| 3 人の会議を 10 分録画し、合成する | `speaker_share` と `audio` ができる。話者の切り替わりが、Actor の `speaker.active` と 500ms 以内で合う |
| 録画中に Recorder のタスクを止める | 失うのは 15 秒以内。マニフェストに `gap`。合成は成功する |
| 録画中に Media Node を止める | 付け替えの後も録画が続く。producer の結び付け直しが正しい |
| 同意しない参加者が、改造したクライアントで音声を送り続ける | Media Node で producer が `paused` のまま。録画の音声に現れない |
| E2EE の会議で `recording.start`・`captions.start` と、Node への直接の `subscriptions.apply` | すべて拒否 |
| ログ・トレースの検索 | 試験の字幕の文字列と表示の名前が現れない |
| 回線の劣化（損失 5%・20%）の音声で字幕 | CER と遅れを記録する（閾値は quality.md） |

### 11.4 音声認識の評価

- 8 節のセットで、エンジンの版を上げるたびに CER と遅れを測る。K7（CER 15% 以下、p95 2 秒）を下回ったら、版を上げない。

## 12. Story の候補

Epic の番号は [architecture/README.md](README.md) の 7 節の割り当てに従う。

| Epic | Story | 中身 |
| --- | --- | --- |
| E8 | `recording-state-and-consent` | 4.1 節、7 節。Actor の状態、同意の記録、`consent_required` |
| E8 | `recorder-rtp-capture` | 4.3 節。PlainTransport、rtpseg、マニフェスト、S3 |
| E8 | `recording-compose` | 4.4 節。`speaker_share`・`audio`。合成の速さの計測 |
| E8 | `recording-gallery-and-per-participant` | 4.4 節の残りの形式 |
| E8 | `recording-share-and-playback` | 6.2 節。署名付きの URL、外への共有のリンク |
| E8 | `recording-retention-trash-hold` | 6.3 節 |
| E8 | `asr-evaluation-set` | 8 節。評価用の音声のセットと比較 |
| E8 | `transcriber-live-captions` | 5.2〜5.4 節。話者の枠、`caption.*` |
| E8 | `transcript-after-meeting` | 5.5 節。確定した結果の結合、batch による作り直し |
| E8 | `custom-vocabulary` | 5.6 節 |
| E8 | `recorder-failover-drill` | 9 節と 11.3 節の障害の注入 |
| E9 | `capture-blocked-in-e2ee` | 10 節の 3 か所の拒否（e2ee.md と一緒に） |
| E11 | `recording-webhooks` | `recording.completed`・`transcript.completed`（[api-and-webhooks.md](api-and-webhooks.md)） |

## 13. 未解決の問い

### 決定

2026-09-27 に推奨案で確定した（[README.md](README.md) の 6 節の「決定（2026-09-27、推奨案で確定）」）。法務に関わるものは L2・L3・L6 の結論で見直す。

- **録画の取り方**：SFU から生の RTP を受け、会議の後に合成する。ヘッドレスのブラウザのボットは使わない。
- **区切り**：10 秒。失ってよい上限は、障害 1 回あたり約 15 秒。
- **成果物の既定**：`speaker_share`（720p）、`audio`、`chat`。`gallery` と参加者ごとの音声は組織の設定。
- **保持**：既定 365 日、ごみ箱 30 日、保全あり。生の区切りは合成から 7 日。
- **外への共有**：組織が許したときだけ。パスコード必須、既定 7 日。
- **エンジン**：S1 は Amazon Transcribe streaming（ja-JP、東京）。話者ごとの流れ、1 会議 4 枠。
- **同意**：同意するまで話せない・映せない・共有できない。見る・聞くことはできる。
- **E2EE**：API・Actor・Media Node の 3 か所で拒否。
- **ダウンロードを許さない共有**：MVP は MP4 を署名付きの URL で再生し、ダウンロードのボタンを出さない。保存を完全には防げないことを、共有を作る画面で示す。HLS の配信は MVP の後（[roadmap.md](../roadmap.md) の延期の一覧）。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| 同意しない人を退出させるしかないか、同意の文言、社外の参加者への通知（L3） | 法務の確認の後、PM が決める。E8 の録画の開始の Story の承認の前 |
| 録画・字幕でサーバーが内容に触れる範囲（L2） | 法務の確認の後。E8 の承認の前 |
| 外部の音声認識の事業者への委託と、国内に置くことの約束（L6） | 法務の確認の後。E8 のエンジンの選定の前 |
| 日本語の CER、最初の途中の結果の遅れ（料金は 1 分 0.01 USD と確かめた） | E8 の前に `asr-evaluation-set` で測る |
| 1 会議の話者の枠の数（4） | E8 の `transcriber-live-captions` の実測で見直す |
| 合成の速さ（Fargate 16 vCPU で 2 倍より速いか） | E8 の `recording-compose` で計測する。足りなければ区間ごとの並列の合成 |
| 大阪への切り替えの間の字幕（大阪に Transcribe がない） | 止める。別のリージョンへ送るかは法務（L6）の後 |
| 組織ごとの鍵（BYOK） | security.md |
| 端末の上での録画、AI の要約 | MVP の後の Epic |

## 14. quality.md・runbooks・data-model への項目

### quality.md

- 録画の成功率（`completed` ／ 開始した録画）。目標は 99.9% 以上（案）。`failed`・`compose_failed` の原因の内訳。
- 会議の終了から `completed` までの時間 ÷ 録画の長さ（NFR-010 の 0.5 以下）。p50・p95。
- 障害 1 回あたりに失った録画の長さ（`gap` の合計）。
- 字幕の遅れ（発話から表示まで）の p95（NFR-010 の 2 秒）。本番は、Transcriber に入った時刻から、クライアントが表示した時刻までで測る。
- CER（K7 の 15% 以下）。評価用の音声のセットで、エンジンの版ごとに測る。
- 同意の画面から「同意して続ける」までの時間と、「退出」を選んだ割合。
- E2EE の会議での録画・字幕の開始の試みの拒否の数（0 以外は正常。受けた数が 0 であること）。

### runbooks

- `recording-compose-backlog.md`：合成の待ち行列がたまったときの確かめ方（SQS の古さ、Composer のタスクの数）と、タスクを増やす手順。
- `recorder-failures.md`：`failed` が増えたときの確かめ方（S3 の書き込み、PlainTransport、心拍）。
- `transcribe-quota.md`：`LimitExceededException` が出たときの、同時の流れの数の確かめ方と、上限の引き上げの申請。
- `transcribe-outage.md`：東京の Transcribe が止まったときの、字幕の `degraded` の案内と、会議の後の batch での作り直し。
- `recording-legal-hold.md`：保全の付け外しと、開示の請求への対応（L4・L8 の結論の後に中身を書く）。
- `recording-purge.md`：ごみ箱の 30 日の削除が止まったときの確かめ方。

### data-model（索引への追加の提案）

確定した形は [data-model/recording.md](data-model/recording.md) にある。

| 置き場所 | 中身 |
| --- | --- |
| Aurora `recordings` | `recording_id`、`org_id`、`meeting_id`、`instance_id`、`status`（`recording`・`processing`・`completed`・`failed`・`compose_failed`・`trashed`）、`started_by`、`started_at`、`ended_at`、`duration_ms`、`bytes`、`legal_hold`、`retention_until`、`trashed_at` |
| Aurora `recording_segments` | `recording_id`、`seq`、`started_at`、`ended_at`、`reason`（`start`・`resume`・`gap`） |
| Aurora `recording_files` | `recording_id`、`kind`（`speaker_share`・`gallery`・`audio`・`audio_per_participant`・`chat`・`transcript`）、`s3_key`、`bytes`、`sha256`、`participant_id?` |
| Aurora `recording_shares` | `recording_id`、`scope`（`org`・`link`。主催者だけの状態は行を作らない）、`token_hash`、`passcode_hmac`、`expires_at`、`allow_download`、`created_by` |
| Aurora `recording_access_events` | `recording_id`、`viewer_user_id?`、`share_id?`、`at`、`ip_hash` |
| Aurora `recording_deletions` | `recording_id`、`deleted_by`、`deleted_at`、`reason`、`purged_at` |
| Aurora `capture_consents` | `instance_id`、`participant_id`、`kind`（`recording`・`transcription`）、`notice_version`、`consented_at` |
| Aurora `transcripts` | `transcript_id`、`org_id`、`instance_id`、`recording_id?`、`engine`、`engine_version`、`status`、`s3_key` |
| Aurora `asr_vocabularies` | `org_id`、`terms_ciphertext`、`engine_ref`、`updated_at` |
| S3 `raw/`・`final/`・`transcripts/` | 6.1 節 |

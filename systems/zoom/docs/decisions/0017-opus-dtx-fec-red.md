---
status: accepted
date: 2026-09-27
---

# ADR-0017: 音声は Opus の DTX とインバンド FEC を常に使い、RED は mediasoup に転送と剥がしを足して使う

## Context

NFR-003 は、ランダムな損失 20%・揺らぎ 30ms で、音声の客観評価が MOS 3.0 以上であることを求める。[ADR-0002](0002-media-topology.md) は、Opus の DTX、インバンド FEC、RED（RFC 2198）を有効にすると決めた。

調べて分かったこと（いずれも 2026-09-27 に確認）。

- Opus のインバンド FEC（LBRR）は、前のフレームを低い品質で次のパケットに重ねる（[RFC 6716](https://www.rfc-editor.org/rfc/rfc6716)）。単発の損失しか直せない。独立な損失 20% では、2 連続の損失が約 4% 残る。
- RED は、過去の符号を同じパケットに並べる（[RFC 2198](https://www.rfc-editor.org/rfc/rfc2198)）。distance 2 なら 3 連続までの損失を直せる。独立な損失 20% で残るのは約 0.8%。
- webrtcHacks の計測では、損失 60% で隠した割合が、RED なし 60%、distance 1 で 32%、distance 2 で 18%。distance 1 で音声のビットレートは約 2 倍（[RED: Improving Audio Quality with Redundancy](https://webrtchacks.com/red-improving-audio-quality-with-redundancy/)）。
- Chrome は M96 から、`setCodecPreferences` で RED を Opus より先にすると RED を送る（[discuss-webrtc の告知](https://groups.google.com/g/discuss-webrtc/c/5761etCrSuA)）。Firefox・Safari の対応は**未検証**（E2 の `browser-capability-probe` で `RTCRtpSender.getCapabilities('audio')` を見て確かめる）。
- libwebrtc の RED の符号器は、前のフレームの Opus の符号をそのまま写し、冗長の数の既定は 1 つ（distance 1）である。数を変えるのはフィールドトライアル `WebRTC-Audio-Red-For-Opus` だけで、Web のページからは変えられない（[audio_encoder_copy_red.cc](https://webrtc.googlesource.com/src/+/refs/heads/main/modules/audio_coding/codecs/red/audio_encoder_copy_red.cc)、2026-09-27 に確認）。
- **mediasoup v3.27.1 は `audio/red` に対応しない**（[supportedRtpCapabilities.ts](https://github.com/versatica/mediasoup/blob/v3/node/src/supportedRtpCapabilities.ts)）。RED の実装の issue（[#481](https://github.com/versatica/mediasoup/issues/481)）は 2020-11 から開いたまま。router に無い符号器では producer を作れない。

## Options

1. **Opus の DTX と FEC を常に使う。RED は mediasoup に転送と剥がしを足して使う**
2. **Opus の DTX と FEC だけにし、RED は使わない**
3. **Opus のフレームを大きくして（40〜60ms）、パケットの数を減らし、冗長は使わない**
4. **SFU を RED に対応する実装（LiveKit など）に替える**

## Decision

1 を採用する。

- Opus は 20ms、モノラル、目標 32 kbps、VBR。`usedtx=1`、`useinbandfec=1` を常に付ける。音声の NACK は使わない。
- RED は distance 2 で送る。Media Node（mediasoup の worker）に次を足す。
  - > 2026-09-27 の注記：**distance 2 を取り消し、ブラウザが送る distance 1 にする。** libwebrtc は冗長を 1 つしか作らず、Web のページから増やせない（Context）。写すのは FEC を有効にした Opus の符号そのものなので、中の LBRR も運ばれ、フレームは主・次のパケットの写し・次の次のパケットの写しの中の LBRR の 3 か所に載る。独立な損失 20% で失うのは約 0.8% の見込みで、distance 2 と同じ程度になる（2 つ目以降は低い品質）。受け手ごとの選択は「残す（distance 1）か剥がす（0）か」だけにし、話している間の上りは最大で約 2 倍になる。見込みは E4 の `red-forwarding` で確かめる。distance 2 はアプリ（E13。libwebrtc を自分でビルドするのでフィールドトライアルを設定できる）で評価する。
  - router の符号器に `audio/red` を足し、RED の producer をそのまま転送する。
  - 受け手が RED に対応しないとき、または受け手の下りの推定が小さいときは、RED を剥がして Opus だけを送る。
  - 受け手ごとに RED を残すか剥がすか（注記により 1・0）と、送る話者の数を、下りの推定で決める（[codecs-and-bandwidth-adaptation.md](../architecture/codecs-and-bandwidth-adaptation.md) の 6.4 節）。
- 変更は mediasoup の上流に提案する。取り込まれるまでは、フォークを持ち、上流のバージョンに追従する。
- RED はフラグ（`media.red`）の裏に置き、止めれば 2 の形に戻る。
- E2EE の会議では、Encoded Transform と RED の組み合わせを確かめるまで、RED を使わない。
- 2 は、20% の損失で 2 連続の損失が約 4% 残り、NFR-003 に届くか分からない。RED を足せないと分かったときの退路にする。
- 3 は、1 パケットの損失で失う音声が長くなり、遅れも増える（NFR-001）。
- 4 は、[ADR-0001](0001-platform-and-stack.md) の選定を覆す。RED のためだけに SFU を替える理由にならない。

## Consequences

- 良くなること：
  - 損失 20% の回線でも、音声の損失を 1% 前後まで直せる見込み。
  - 受け手ごとに冗長を変えるので、下りの細い受け手に余計な帯域を送らない。
- 引き受けるコスト：
  - mediasoup の C++ の worker に手を入れ、フォークを保つ。上流のバージョンを上げるたびに、RED の試験を回す。
  - 話している間の音声の上りが、最大で約 2 倍になる（注記の後。distance 1）。
  - RED の剥がしの誤りは、音声の途切れとして現れる。試験のベクトルで守る。

## Confirmation

- ネットワークの劣化の試験：ランダムな損失 20%・揺らぎ 30ms で、ViSQOL の MOS 3.0 以上。損失 5% で 3.8 以上（NFR-003）。FEC だけ・RED distance 1 ＋ FEC の結果を並べて記録する（注記により distance 2 は Web では作れない）。
- 試験のベクトル：RED のパケットの列を剥がした結果が、主の Opus の符号と同じバイト列で、RTP の時刻と連番が変わらない（PROP-RED-001）。
- ブラウザの組み合わせの試験：RED に対応しない受け手が、剥がされた Opus を受けて音声を再生できる。

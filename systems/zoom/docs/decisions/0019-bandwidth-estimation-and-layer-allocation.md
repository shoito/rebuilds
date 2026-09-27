---
status: accepted
date: 2026-09-27
---

# ADR-0019: 上りの推定はブラウザの GCC に任せ、下りは Media Node が受け手ごとに推定して優先度の順に層を配る。映像の FEC は使わない

## Context

NFR-009 は、下りの帯域が半分に下がったら 5 秒以内に映像の層を落として収まり、1 秒以上の映像の停止を起こさないこと、下り 150 kbps でも音声が続くことを求める。

[ADR-0002](0002-media-topology.md) は、送り手の側の推定（transport-cc と GCC）を使い、SFU が受け手ごとに下りを推定して層を選ぶと決めた。層の選び方の規則と、損失への備えを決める必要がある。

調べて分かったこと（いずれも 2026-09-27 に確認）。

- GCC は、遅れに基づく推定と損失に基づく推定の小さい方で送る。増やすのは毎秒 8% まで、減らすのは 0.85 倍。損失が 10% を超えると `(1 − 0.5p)` 倍に下げる（[draft-ietf-rmcat-gcc-02](https://datatracker.ietf.org/doc/html/draft-ietf-rmcat-gcc-02)、失効した草案）。
- mediasoup は、受け手の transport ごとに送信側の推定を持ち、consumer の `priority`（1〜255）と `preferredLayers` を見て層を配る。`setMaxOutgoingBitrate`・`setMaxIncomingBitrate` で上限を設けられる（[mediasoup の API](https://mediasoup.org/documentation/v3/mediasoup/api/)）。
- mediasoup は ULPFEC・FlexFEC（[RFC 8627](https://www.rfc-editor.org/rfc/rfc8627)）に対応しない（[supportedRtpCapabilities.ts](https://github.com/versatica/mediasoup/blob/v3/node/src/supportedRtpCapabilities.ts)）。映像の NACK・PLI・FIR には対応する。

## Options

1. **上りはブラウザの GCC。下りは Media Node の推定。Actor は consumer ごとの上限の層と優先度だけを決め、Media Node が推定の中で配る**
2. **Actor が受け手ごとの推定を集め、層を中央で決めて Media Node に指示する**
3. **受け手のブラウザが自分で層を選び、Media Node に求める（受け手主導）**

## Decision

1 を採用する。

- **上り**：送り手のブラウザの GCC に任せる。Media Node は transport-cc の帰還を返し、送り手の transport に上限（3,000 kbps）を設ける。画面共有の sender の `priority` を `high`、カメラを `low` にする。
- **下り**：Media Node が受け手ごとに推定する。受け手の transport の上限の既定は 4,000 kbps。
- **Actor の役割**：受け手の見える範囲（`view.update`）と表示の大きさから、consumer ごとの上限の層と `priority` を決める。優先度は、画面共有 255、ピン留め・主な話者 200、ギャラリー（2〜9 本）100、ギャラリー（10〜25 本）50。表示の高さ（物理の画素）が 200 未満なら 180p、400 未満なら 360p、それ以上で 720p を上限にする。
- **Media Node の役割**：推定の中で、音声を先に引き、`priority` の高い順に上限の層まで配る。
  - 下げは、推定が割り当ての合計を下回ったらすぐ。時間の層から下げ、次に空間の層を下げる。
  - 上げは、1 つ上の層に要る速さの 1.2 倍を 3 秒続けて超えたら 1 段。上げた後 10 秒は同じ consumer を上げない。
  - 最も低い層も載らない consumer は止め、受け手にはアバターを出させる。
- **損失への備え**：映像は NACK と RTX で直す。映像の FEC は使わない。音声は [ADR-0017](0017-opus-dtx-fec-red.md)。
- 推定の値そのものを Actor に送らない。制御の経路が止まっても、Media Node は最後の指示のまま層を選び続ける（[ADR-0005](0005-meeting-state-and-signaling.md)）。
- 2 は、推定の変化（数百 ms 単位）に制御の経路の往復が加わり、NFR-009 の 5 秒に余裕がなくなる。Actor が止まると層の選択も止まる。
- 3 は、受け手が他の受け手の事情を知らずに求め、Media Node で結局調停が要る。

## Consequences

- 良くなること：
  - 層の選択は、推定を持つ Media Node の中で閉じ、速い。
  - Actor は、表示の意図（誰をどの大きさで見たいか）だけを持ち、状態が小さい。
- 引き受けるコスト：
  - 層の選択の細部は mediasoup の実装に依る。規則を変えたいときは、mediasoup の worker に手を入れることになる。
  - 映像の FEC を使わないので、RTT の大きい回線（200ms）で損失を直すのに時間がかかる。最も低い層で途切れがちになるのを許す。

## Confirmation

- ネットワークの劣化の試験（`bw-half`、`bw-step-down`）：5 秒以内に収まり、1 秒以上のフリーズが 0。150 kbps で音声が続く（NFR-009）。
- 性質ベーステスト：任意の推定の時系列で、割り当ての合計が推定を超えない（PROP-BWE-001）。同じ consumer を上げる間隔が 10 秒を下回らない（PROP-BWE-002）。音声が映像より先に止まらない（PROP-BWE-003）。
- 障害の注入の試験：Actor を止めても、帯域の変化に合わせた層の上げ下げが続く。

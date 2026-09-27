---
status: accepted
date: 2026-09-27
---

# ADR-0018: カメラの映像は VP8 の simulcast を既定にし、全員が Chromium の会議だけ VP9 の SVC にする。AV1 は S1 ではフラグの裏に置く

## Context

[ADR-0002](0002-media-topology.md) は、カメラの既定を simulcast 3 本（VP8 を基準）にし、SVC は送り手と受け手のブラウザがすべて対応する会議で使うと決めた。どの条件でどの符号器・層にするかを決める必要がある。

調べて分かったこと（いずれも 2026-09-27 に確認）。

- VP8 と H.264（Constrained Baseline）は、Chrome・Edge・Firefox・Safari のすべてが対応する必須の符号器（[MDN の WebRTC の符号器](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/WebRTC_codecs)）。
- VP9 は Chrome 48・Firefox、AV1 は Chrome 113・Firefox 136 から。Safari の VP9・AV1 の WebRTC での対応は MDN に記載がなく**未検証**（E2 の `browser-capability-probe` で確かめる）。
- `scalabilityMode` は Chrome 111 から。Firefox は未対応。Safari は未確定（[browser-compat-data の PR #30319](https://github.com/mdn/browser-compat-data/pull/30319)、未マージ）。
- Firefox 155 以降の受け手は、AV1 の SVC の上の空間の層を復号できず、映像が黒くなるか止まると報告されている（[livekit/client-sdk-js#2116](https://github.com/livekit/client-sdk-js/issues/2116)）。
- mediasoup は VP9 の full SVC と K-SVC に対応する。AV1 では、空間の層が複数のとき DD の転送で映像が止まる問題を調べている途中（[#1625](https://github.com/versatica/mediasoup/issues/1625)、開いたまま）。
- WebRTC-SVC の `_KEY` のモードは、空間の層がキーフレームでだけ下の層に依存する（[WebRTC-SVC](https://www.w3.org/TR/webrtc-svc/)）。受け手ごとに上の層を剥がしても、受け手の復号は単一の層と同じ費用になる。

## Options

1. **既定は VP8 の simulcast（iOS・iPadOS の Safari は H.264）。全員が Chromium の会議だけ VP9 `L3T3_KEY`。AV1 はフラグの裏**
2. **常に VP8 の simulcast**
3. **対応する端末は常に SVC（VP9 か AV1）にし、対応しない端末だけ simulcast にする（1 つの会議で混ぜる）**
4. **AV1 の SVC を既定にする**

## Decision

1 を採用する。

- Meeting Actor が、参加者の端末の申告から会議の「映像のモード」（`simulcast`・`svc`・`av1-svc`）を決め、会議の状態として配る。
- `simulcast`（既定）：
  - VP8 の 3 本（180p・15 fps・150 kbps、360p・30 fps・500 kbps、720p・30 fps・1,500 kbps）。各本は `L1T3`。
  - iOS・iPadOS の Safari の送り手は、ハードウェアの符号器を使うため H.264 の 3 本（`L1T1`）にする。
  - 受け手のいない本は、送り手に止めさせる（`active: false`）。
- `svc`：参加者が全員 Chromium（最新 2 版）で VP9 の `L3T3_KEY` を申告し、参加者が 5 人以上の会議で使う。1 本の中に 180p・360p・720p の空間の層と、3 つの時間の層を持つ。
  - 条件を満たさない人が入ったら `simulcast` に戻し、その開催の間は `svc` に戻さない。
- `av1-svc`：フラグ（`media.av1`）の裏。社内の会議だけで試す。mediasoup の #1625 の解決と、Firefox の SVC の復号の対応を待って、S2 の前に既定にするかを判断する。
- 2 は、最も単純だが、Chromium だけの会議で上りの帯域と CPU を減らす機会を捨てる。
- 3 は、1 つの会議に 2 つの層の形が混ざり、受け手ごとの層の選択と試験の組み合わせが倍になる。Firefox の受け手が SVC を復号できない問題にも当たる。
- 4 は、上の mediasoup と Firefox の問題があり、S1 では危うい。

## Consequences

- 良くなること：
  - どのブラウザの組み合わせでも映像が届く。受け手は VP8 と H.264 を必ず復号できる。
  - 社内の Chromium だけの会議では、上りと CPU を減らせる。
- 引き受けるコスト：
  - モードの切り替えで、送り手の符号器を替える間（キーフレームまで）映像が一瞬止まる。
  - VP8 の simulcast は、SVC より上りが多い（ADR-0002 の「3〜4 割」。**未検証**。E4 の `svc-vp9-mode` で測る）。
  - AV1 の圧縮の利点は S1 では得られない。

## Confirmation

- ブラウザの組み合わせの試験：送り手 × 受け手の 4 × 4（Chrome、Edge、Firefox、Safari）で、`simulcast` の会議の映像が全員に届く。
- 試験：`svc` の会議に Firefox の参加者が入ると、10 秒以内に全員の映像が `simulcast` で届き、その後 `svc` に戻らない。
- ネットワークの劣化の試験：3 人の会議で 1 人の下りを 500 kbps に絞ると、その人だけが低い層を受ける（ADR-0002 の Confirmation と同じ）。
- 計測（E4）：同じ映像で、VP8 の simulcast と VP9 の `L3T3_KEY` の上りのビットレートと送り手の CPU を比べ、記録する。

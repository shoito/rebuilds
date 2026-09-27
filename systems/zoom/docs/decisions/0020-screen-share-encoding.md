---
status: accepted
date: 2026-09-27
---

# ADR-0020: 画面共有は解像度を保ち、`contentHint: "detail"` と低いフレームの数で送る。層は時間の層だけにする

## Context

会議の画面共有の多くは、資料・コード・表計算で、文字が読めることが最も大事である。動画を共有する場面もある。[ADR-0002](0002-media-topology.md) は、画面共有は解像度を保ち、フレームの数を落とす方針で、時間の層だけを使うと決めた。

調べて分かったこと（いずれも 2026-09-27 に確認）。

- 映像の `contentHint` は `motion`・`detail`・`text`。`detail`・`text` は、既定の `degradationPreference` が `maintain-resolution`（帯域や CPU が足りないとき、解像度を保ちフレームの数を落とす）になる。`motion` は `maintain-framerate`（[MediaStreamTrack Content Hints](https://www.w3.org/TR/mst-content-hint/)、2025-09-19 の Working Draft）。
- `L1T3` は、1 つの空間の層に 3 つの時間の層を持つ。受け手ごとに時間の層を剥がすと、解像度を保ったままフレームの数だけが減る（[WebRTC-SVC](https://www.w3.org/TR/webrtc-svc/)）。

## Options

1. **`detail` と `maintain-resolution`、最大 1920×1080・5 fps。動画の共有は `motion`・15 fps。層は `L1T3` の時間の層だけ**
2. **カメラと同じ simulcast 3 本で送る**
3. **`text` を既定にする**

## Decision

1 を採用する。

- 既定は `contentHint: "detail"`、`degradationPreference: "maintain-resolution"`、最大 5 fps、`maxBitrate` 1,500 kbps。
- 利用者が「動画を共有」を選んだら `motion`、`balanced`、最大 15 fps、2,500 kbps。
- 解像度は取り込みのまま、上限 1920×1080。
- 符号器は、`svc` の会議で VP9、それ以外で VP8。どちらも `L1T3`。iOS・iPadOS の Safari は H.264 の `L1T1`。
- 帯域の足りない受け手には、時間の層を剥がしてフレームの数を落とす。T0 も載らない受け手には共有を止め、理由を画面に示す。
- Media Node は画面共有の consumer を `priority: 255` で作る（[ADR-0019](0019-bandwidth-estimation-and-layer-allocation.md)）。
- タブの音声は Opus のステレオ 64 kbps、FEC あり、DTX なし。
- 2 は、細い受け手に低い解像度の共有を送ることになり、文字が読めなくなる。上りも増える。
- 3 は、`text` の符号器の最適化がブラウザごとに違い（未検証）、図や写真を含む資料で `detail` より悪くなる恐れがある。E5 で比べ、良ければ切り替える。

## Consequences

- 良くなること：
  - 細い受け手でも、共有の文字が読める。
  - 上りは 1 本で済む。
- 引き受けるコスト：
  - 細い受け手では、共有の画面の更新が遅くなる（1〜2 fps）。スライドの切り替えが遅れて見える。
  - 空間の層がないので、共有を小さく表示する受け手にも大きな解像度を送る。

## Confirmation

- ネットワークの劣化の試験：下り 500 kbps の受け手で、共有の解像度が送り手と同じまま保たれる（`frameHeight` が下がらない）。
- 見た目の試験：試験用の文字の画面（10pt 相当の文字）を共有し、受け手の画面を撮って文字を読み取れる（OCR の一致率の閾値は quality.md で決める）。
- 計測（E5）：`detail` と `text` で、同じ資料の共有のビットレートと文字の読み取りの結果を比べる。

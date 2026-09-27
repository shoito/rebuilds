---
status: accepted
date: 2026-09-27
---

# ADR-0022: 仮想背景は MediaPipe の Selfie Segmenter を WebGPU でワーカーの中で動かし、強い雑音の抑制は RNNoise を AudioWorklet で動かす

## Context

intent.md の MVP は、仮想背景とぼかしを端末の上で処理し、映像をサーバーへ送る前に処理を終えることを求める。雑音の抑制は、ブラウザの `noiseSuppression` がある。家庭の騒音（キーボード、犬、工事）をさらに消したい要望がある。

[ADR-0003](0003-client-platform.md) は、端末の処理をブラウザの標準の API で足し、分割のモデルは WebGPU・WebGL で動かすと決めた。

調べて分かったこと（いずれも 2026-09-27 に確認）。

- MediaPipe の Selfie Segmenter は、正方形（256×256）と横長（144×256）の 2 つのモデルを持つ。Pixel 6 で約 33〜35ms。Web は `tasks-vision` のパッケージで動き、GPU の実行に対応する（[Image segmenter](https://developers.google.com/edge/mediapipe/solutions/vision/image_segmenter)）。モデルのファイルの利用の条件は未検証。
- RNNoise は、48 kHz・モノラルの PCM を扱う RNN の雑音の抑制。BSD-3-Clause。小さいモデル（`little`）もある（[xiph/rnnoise](https://github.com/xiph/rnnoise)）。
- WebGPU は Chromium と Safari 26 以降にあり、Firefox は既定で無効（[caniuse](https://caniuse.com/webgpu)）。
- `MediaStreamTrackProcessor` の公開の場所はブラウザによって違う（[MDN](https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamTrackProcessor)）。

## Options

1. **Selfie Segmenter（WebGPU、なければ WebGL2）をワーカーで動かす。雑音の抑制は既定でブラウザ、強い抑制で RNNoise（WASM、AudioWorklet）。負荷を見て自動で下げる**
2. **分割も雑音の抑制も、サーバーで行う**
3. **自前で分割・雑音の抑制のモデルを学習する**
4. **雑音の抑制を常に RNNoise にする**

## Decision

1 を採用する。

- 仮想背景とぼかし：
  - カメラの映像を worker で取り出し（`MediaStreamTrackProcessor`）、縮小して横長の Selfie Segmenter で人物のマスクを作り、元の解像度で合成して `VideoTrackGenerator` で送る。
  - 実行は WebGPU、なければ WebGL2。worker で映像を取り出せないブラウザは、`OffscreenCanvas` と `captureStream` の経路にする。
  - 処理が止まったら、処理しない映像を送らず、カメラを止める。
  - 予算：1 フレームの処理 p95 12ms、遅れの増加 1 フレーム以内。
- 雑音の抑制：
  - 既定はブラウザの `noiseSuppression`。
  - 「強い雑音の抑制」を選んだら、ブラウザの抑制を切り、RNNoise（`little` のモデル）を WASM にして AudioWorklet で動かす。2 つの抑制を重ねない。
- 負荷の制御：処理時間の p95 が 25ms を 5 秒超えたら、15 fps → 360p → 仮想背景を切る、の順に下げ、利用者に知らせる。
- モデルのファイルの利用の条件は、E5 の着手前に法務と確かめる。条件が合わなければ、別のモデルを選び、この ADR を見直す。
- 2 は、映像を処理しない形でサーバーへ送ることになり、intent.md の要件（送る前に処理を終える）に反する。E2EE の会議でも使えない。
- 3 は、学習のデータ（人の映像・声）の集め方と費用が重く、小さなチームに見合わない。
- 4 は、RNNoise の処理が全員の CPU を使い、ブラウザの抑制より良いとは限らない（未検証）。

## Consequences

- 良くなること：
  - 映像と音声は、端末の上で処理を終えてから送る。E2EE の会議でも同じに動く。
  - サーバーの費用がかからない。
- 引き受けるコスト：
  - 端末の CPU・GPU と電池を使う。低い性能の端末では、自動で下げる。
  - ブラウザと GPU のドライバの組み合わせごとの不具合に当たる。除外の一覧を持つ。
  - 強い雑音の抑制で、音声の遅れが約 10ms 増える。

## Confirmation

- 性能の試験：基準の端末で、仮想背景の 1 フレームの処理が p95 12ms 以内。glass-to-glass の増加が 33ms 以内。
- 試験：合成の人物の映像の正解のマスクと比べ、IoU が quality.md の閾値以上。
- 試験：処理を止めた（モデルの読み込みの失敗を注入した）とき、処理しない映像のフレームが 1 枚も送られない（受け手の映像と、送り手の `framesSent` で確かめる）。
- ネットワークの劣化の試験：強い雑音の抑制を有効にしても、NFR-003 の MOS を下回らない。

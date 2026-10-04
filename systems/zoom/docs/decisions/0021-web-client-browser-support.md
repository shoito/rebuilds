---
status: accepted
date: 2026-09-27
---

# ADR-0021: 対応ブラウザは主要な 4 つの最新 2 メジャーにし、機能の差は参加の前に端末で調べて Meeting Actor に申告する

## Context

MVP の主なクライアントは Web で、社外の参加者がインストールなしで入れることを重視する（[intent.md](../intent.md)）。[ADR-0003](0003-client-platform.md) は、Chrome・Edge・Firefox・Safari の最新 2 バージョンで E2E の試験を回すと決めた。

ブラウザの間で、会議に要る機能の対応が違う（いずれも 2026-09-27 に確認）。

- `scalabilityMode`（SVC）は Chrome 111 から。Firefox は未対応。Safari は未確定（[browser-compat-data の PR #30319](https://github.com/mdn/browser-compat-data/pull/30319)）。
- `RTCRtpScriptTransform`（E2EE に要る）は Chrome・Edge 141、Firefox 117、Safari 15.4、Android の Chrome 152 から。Baseline 2025（[caniuse](https://caniuse.com/mdn-api_rtcrtpscripttransform)、[MDN](https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpScriptTransform)）。
- WebGPU は Chrome・Edge 113 から。Firefox は既定で無効。Safari は 26 から（macOS は部分的）（[caniuse](https://caniuse.com/webgpu)）。
- `MediaStreamTrackProcessor` は、ブラウザによって公開する場所（window か worker）が違い、互換でない（[MDN](https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamTrackProcessor)）。
- mediasoup-client は、`Chrome111`・`Chrome74`・`Firefox120`・`Safari12` のハンドラーでブラウザの違いを吸収する（[mediasoup-client の handlers](https://github.com/versatica/mediasoup-client/tree/v3/src/handlers)）。

## Options

1. **主要な 4 つ（Chrome、Edge、Firefox、Safari）と Android の Chrome の最新 2 メジャー＋Firefox の ESR。機能の差は端末で調べて申告し、使えない機能を画面で示す**
2. **Chromium だけを正式に対応し、他は「動くかもしれない」扱いにする**
3. **最新 2 メジャーより広く（例：直近 2 年）対応する**

## Decision

1 を採用する。

- 対応：Chrome・Edge（デスクトップ）、Firefox（デスクトップ、最新 2 メジャーと現行の ESR）、Safari（macOS・iOS・iPadOS）、Android の Chrome。いずれも最新 2 メジャー。
- 参加の前に、端末で API の有無と `RTCRtpSender.getCapabilities` を調べ、`hello.client.capabilities` で Meeting Actor に申告する。Actor は申告から映像のモード（[ADR-0018](0018-video-codec-and-layering-selection.md)）と E2EE の可否を決める。
- 使えない機能は、画面で理由とともに示す。E2EE の会議だけは、`RTCRtpScriptTransform` がなければ入れない（[ADR-0004](0004-encryption-and-e2ee.md)）。それ以外の機能の欠けでは、参加を止めない。
- 対応の外のブラウザでも参加は止めず、「試験していない」と示す。
- 対応表は [clients.md](../architecture/clients.md) の 2.2 節に持ち、ブラウザの新しいメジャーごとに見直す。
- 2 は、社外の参加者の多くが Safari（iPhone）で入る場面で使えない。
- 3 は、試験の組み合わせが増え、E2EE の API を持たないバージョンも含んでしまう。

## Consequences

- 良くなること：
  - 社外の参加者の端末の大半で、インストールなしで入れる。
  - 最新 2 メジャーなら、E2EE に要る `RTCRtpScriptTransform` はすべてのブラウザにある。
- 引き受けるコスト：
  - Safari の実機（macOS・iOS）での試験が要る。Playwright の WebKit では代えられない。
  - ブラウザの更新ごとに、対応表と機能の判定を見直す。

## Confirmation

- E2E の試験：対応するブラウザの最新 2 メジャーで、参加、音声・映像・共有、帯域の低下を CI で回す。Safari は実機で夜間に回す。
- 試験：E2EE の会議に `RTCRtpScriptTransform` のない環境（偽装した環境）で入ろうとすると、参加の前の画面で止まり、理由が出る。
- 試験：Firefox の参加者がいる会議のモードが `simulcast` になる。

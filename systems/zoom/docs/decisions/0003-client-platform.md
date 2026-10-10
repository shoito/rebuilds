---
status: accepted
date: 2026-09-27
---

# ADR-0003: Web クライアントはブラウザの WebRTC を使い、ネイティブのアプリは共通のコア（Rust）と libwebrtc で作る

## Context

MVP の主なクライアントは Web である。社外の参加者が、インストールなしで URL から入れることを重視する（[intent.md](../intent.md)）。

ブラウザで会議のメディアを扱う方法は、主に 2 つある。

- **ブラウザの WebRTC**：`RTCPeerConnection` を使う。符号化・復号（ハードウェアを含む）、エコーの除去・雑音の抑制・音量の自動の調整、ジッタバッファ、帯域の推定、DTLS-SRTP、ICE をブラウザが持つ。仕様は W3C の Recommendation（[WebRTC 1.0](https://www.w3.org/TR/webrtc/)、2025-03-13）と IETF の RFC 8825〜8835、[RFC 9429](https://www.rfc-editor.org/rfc/rfc9429)（JSEP）。
- **独自の伝送と符号化**：WebCodecs や WebAssembly の符号器で符号化し、WebTransport・WebSocket・DataChannel で送る。本家 Zoom の Web クライアントは、WebAssembly の符号器と WebSocket（後に DataChannel）で、ブラウザの WebRTC のメディアの経路を避けてきたと報告されている（[webrtcHacks](https://webrtchacks.com/zoom-avoids-using-webrtc/)、[Simon Willison](https://simonwillison.net/2019/Apr/18/zoom-wasm/)、2026-09-27 に確認）。その後 WebCodecs・WebTransport の採用を進めているとの報告もあるが、現在の構成は未検証。

独自の方式は、ネイティブのアプリと同じ符号器・同じ帯域の制御をブラウザでも使える。一方で、CPU の使用量が増え、エコーの除去などを自分で持つ必要がある（[Daily の解説](https://www.daily.co/blog/zoom-web-sdk-technical-notes/)、2026-09-27 に確認）。

ネイティブのアプリ（デスクトップ・モバイル）は MVP の後に作る。そのときに、Web と振る舞いが食い違わないようにしたい。

## Options

1. **Web はブラウザの WebRTC。ネイティブは libwebrtc と、共通のコア（Rust）**
2. **Web は WebCodecs＋WebTransport（または DataChannel）＋WebAssembly の独自の方式。ネイティブも同じ独自の方式**
3. **Web はブラウザの WebRTC。ネイティブはすべて Electron などで Web を包む**

## Decision

1 を採用する。

- **Web クライアントは、ブラウザの WebRTC を使う。** 送受信の対応付けは mediasoup-client に任せる。
  - ハードウェアの符号化、エコーの除去、ジッタバッファ、帯域の推定を、ブラウザの実装に任せられる。CPU の使用量が小さく、ノート PC の電池とファンの音に効く。
  - 標準の API は学習データが多く、エージェントの出力が安定する。
- **端末の上の処理は、ブラウザの標準の API で足す。**
  - 仮想背景とぼかし：カメラの映像を `MediaStreamTrackProcessor` などで取り出し、端末の上の分割のモデル（WebGPU・WebGL）で処理してから送る。映像はサーバーへ送る前に処理を終える。
  - E2EE：Encoded Transform（[WebRTC Encoded Transform](https://www.w3.org/TR/webrtc-encoded-transform/)、2026-09-27 に確認した時点で Working Draft）の `RTCRtpScriptTransform` で、符号化した後のフレームを SFrame で暗号化する（[ADR-0004](0004-encryption-and-e2ee.md)、[ADR-0028](0028-sframe-encoded-transform-and-dependency-descriptor.md)）。対応ブラウザの最新 2 メジャーは、すべて `RTCRtpScriptTransform` を持つ（[ADR-0021](0021-web-client-browser-support.md)）。
- **ネイティブのアプリは、libwebrtc と、Rust の共通のコアで作る。**
  - 共通のコアの範囲は、シグナリングのクライアントのステートマシンと、E2EE の鍵管理（MLS）である。UI とメディアの経路は、プラットフォームごとに書く。
  - E2EE の鍵管理の実装（OpenMLS）は、Web でも WebAssembly にして同じものを使う。暗号の実装を 1 つにする。
  - シグナリングのステートマシンは、Web（TypeScript）とネイティブ（Rust）で 2 つになる。プロトコルのスキーマを 1 か所で定義して両方の型を生成し、同じ試験のベクトル（メッセージの列と、期待する状態）を両方に通す。
  - デスクトップは Electron で Web を包み、モバイルはネイティブにする（[ADR-0023](0023-desktop-electron-mobile-native.md)）。共通のコアと試験のベクトルの形は [ADR-0024](0024-shared-rust-core-and-test-vectors.md)。
- 2 は、帯域の制御と符号器を自由にできる。ただし、エコーの除去・ジッタバッファ・帯域の推定を自分で作り、CPU の使用量が増え、E2E の試験の量も増える。標準の WebRTC の上で目標（NFR-001〜003）を満たせないと分かったときに、別の ADR で見直す。
- 3 は、デスクトップでは有力だが、モバイルでは電池と OS のバックグラウンドの制約（通話の扱い）に合わない。

## Consequences

- 良くなること：
  - Web クライアントの実装の量が小さく、ブラウザの改善（新しい符号器、帯域の推定）をそのまま受け取れる。
  - 標準の上で作るので、SIP・録画・字幕などのサーバーの側の部品も、同じ RTP の扱いで作れる。
- 引き受けるコスト：
  - 帯域の推定と符号器の細かな制御は、ブラウザが許す範囲に限られる。
  - ブラウザごとの違い（simulcast、SVC、Encoded Transform の対応）を吸収する層が要る。対応ブラウザの表を clients.md に持つ。
  - ネイティブのアプリでは、libwebrtc のビルドと更新を自分で追う。

## Confirmation

- E2E の試験：Chrome・Edge・Firefox・Safari の最新 2 バージョンで、参加、音声・映像・画面共有、帯域の低下の試験を、CI で回す（Playwright と、偽のカメラ・マイクの入力）。
- ネットワークの劣化の試験：`tc netem` で損失・揺らぎ・帯域を変え、NFR-001〜003・NFR-009 を満たすことを確かめる。
- 共通の試験のベクトル：シグナリングのステートマシンの TypeScript 版と Rust 版が、同じベクトルで同じ状態になる（ネイティブのアプリを作る Epic から）。

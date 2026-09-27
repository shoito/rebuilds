---
status: accepted
date: 2026-09-27
---

# ADR-0023: デスクトップアプリは Electron で Web クライアントを包み、モバイルアプリはネイティブと自前の libwebrtc で作る

## Context

デスクトップ・モバイルのアプリは MVP の後に作る（[intent.md](../intent.md)）。[ADR-0003](0003-client-platform.md) は、ネイティブのアプリを libwebrtc と Rust の共通のコアで作ると決め、デスクトップを Electron などで包むかネイティブにするかは clients.md で比べるとした。モバイルは、電池と OS のバックグラウンドの制約から、Web を包む形に合わないとした。

調べて分かったこと（いずれも 2026-09-27 に確認）。

- Electron は Chromium の WebRTC を持つ。画面共有は `setDisplayMediaRequestHandler` と `desktopCapturer` で扱い、システムの音声（`loopback`）は Windows で取れる。macOS 14.2 以降は `NSAudioCaptureUsageDescription` が要り、12.7.6 以前は取れない（[desktopCapturer](https://www.electronjs.org/docs/latest/api/desktop-capturer)）。
- Google は M80 から、モバイルの libwebrtc のビルド済みの公式の配布をやめた。自分でビルドするか、コミュニティのビルドを使う（[BlogGeek.me の解説](https://bloggeek.me/how-to-pick-the-right-webrtc-mobile-sdk-build-for-your-application/)）。Google Play は、古い WebRTC を含むアプリに更新を勧める通知を出す（[Google Play のヘルプ](https://support.google.com/faqs/answer/12577537?hl=en)）。
- libmediasoupclient は、libwebrtc の上の mediasoup のクライアント（C++、ISC）。2026-06 に `webrtc-m140` のタグがある（[versatica/libmediasoupclient](https://github.com/versatica/libmediasoupclient)）。
- 他の題材（Notion）も、デスクトップを Electron で包んでいる（Notion の ADR-0009）。

## Options

1. **デスクトップは Electron。モバイルは Swift・Kotlin のネイティブ＋自前でビルドした libwebrtc＋libmediasoupclient＋Rust の共通のコア**
2. **デスクトップもネイティブ（libwebrtc＋Rust の共通のコア）**
3. **モバイルもクロスプラットフォームの枠組み（React Native など）で作る**
4. **モバイルの libwebrtc はコミュニティのビルドを使う**

## Decision

1 を採用する。

- デスクトップ：
  - Electron で Web クライアントを包む。メディアの経路、E2EE（WASM）、仮想背景は Web と同じコードで動く。
  - Web に無いものだけを足す：OS の画面の選択とシステムの音声、会議の URL をアプリで開く、自動更新、コード署名。
  - 安全の設定：`contextIsolation`、`sandbox`、`nodeIntegration: false`。preload の API は最小にする。
  - Electron の安定版に 1 か月以内に追いつく。
- モバイル：
  - UI は Swift（iOS）と Kotlin（Android）。CallKit・`ConnectionService`、バックグラウンドの音声、ピクチャー・イン・ピクチャー。
  - libwebrtc は自分でビルドし、Chrome の安定版の milestone に 2 か月以内に追いつく。mediasoup との対応付けは libmediasoupclient。
  - シグナリングの状態機械と E2EE の鍵管理は、Rust の共通のコアを UniFFI で呼ぶ（[ADR-0024](0024-shared-rust-core-and-test-vectors.md)）。
- 2 は、デスクトップで UI とメディアの経路をもう 1 つ書くことになる。Web と振る舞いを揃える試験の量が増える。デスクトップの CPU とメモリの使用量が Electron で目標に届かないと分かったら見直す。
- 3 は、メディアの経路と OS の通話の統合で、結局ネイティブのコードが要る。枠組みの WebRTC の束縛の追従も別に要る。
- 4 は、ビルドの手間を省けるが、更新の時期と中身を自分で決められず、脆弱性の修正が遅れる恐れがある。

## Consequences

- 良くなること：
  - デスクトップは、Web の改善がそのまま届き、振る舞いが食い違わない。
  - モバイルは、OS の通話の統合と電池の扱いを、OS の作法で作れる。
- 引き受けるコスト：
  - Electron のアプリは大きく、メモリを多く使う。
  - libwebrtc のビルドの基盤（iOS・Android の両方）と、2 か月ごとの追従を運用する。
  - libmediasoupclient の対応する libwebrtc の版に縛られる。

## Confirmation

- E2E の試験：デスクトップのアプリで、Web と同じ E2E の試験の組を回す（画面共有とシステムの音声を足す）。
- 検査：Electron の `webPreferences` が決めた安全の設定になっていることを、ビルドの検査で確かめる。
- 定期の確認：モバイルの libwebrtc の milestone と Chrome の安定版の差が 2 か月を超えたら、警告を出す。

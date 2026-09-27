# Clients: Zoom

利用者の端末で動くクライアントの設計。Web クライアント（mediasoup-client の上の構成と対応ブラウザ）、端末の上の処理（仮想背景、ぼかし、雑音の抑制）、アクセシビリティ、MVP の後のデスクトップ・モバイルのアプリ、Web とネイティブで共有する Rust の共通のコアと、その試験のベクトルを扱う。

前提として、次の決定に従う。

| 決定 | クライアントへの影響 |
| --- | --- |
| [ADR-0003](../decisions/0003-client-platform.md) | Web はブラウザの WebRTC と mediasoup-client。ネイティブは libwebrtc と Rust の共通のコア。Electron とネイティブのどちらにするかはこの文書で決める |
| [ADR-0004](../decisions/0004-encryption-and-e2ee.md) | E2EE は Encoded Transform と SFrame、鍵管理は OpenMLS。対応しないブラウザは E2EE の会議に入れない |
| [ADR-0005](../decisions/0005-meeting-state-and-signaling.md) | 会議の状態の正本は Meeting Actor。クライアントは `(epoch, seq)` の差分で状態を追う |
| [ADR-0008](../decisions/0008-signaling-protocol.md) | シグナリングは WebSocket の上の JSON。型は Zod のスキーマから作り、ネイティブは JSON Schema から作る |
| [ADR-0018](../decisions/0018-video-codec-and-layering-selection.md) | 送り手の符号器と層は、会議の映像のモードで決まる |

この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0021](../decisions/0021-web-client-browser-support.md) | 対応ブラウザは、Chrome・Edge・Firefox（と現行の ESR）・Safari（macOS・iOS・iPadOS）・Android の Chrome の最新 2 メジャー。機能の差は、参加の前に端末で調べて Actor に申告し、使えない機能を画面で示す |
| [0022](../decisions/0022-on-device-media-processing.md) | 仮想背景とぼかしは MediaPipe の Selfie Segmenter を WebGPU（なければ WebGL）でワーカーの中で動かす。雑音の抑制はブラウザの既定を使い、「強い雑音の抑制」を選んだときだけ RNNoise（WASM）を AudioWorklet で動かす。端末の負荷を見て自動で下げる |
| [0023](../decisions/0023-desktop-electron-mobile-native.md) | デスクトップは Electron で Web クライアントを包む。モバイルは Swift・Kotlin のネイティブで、自前でビルドした libwebrtc と libmediasoupclient、Rust の共通のコア（UniFFI）で作る |
| [0024](../decisions/0024-shared-rust-core-and-test-vectors.md) | 共通のコア（Rust）は、IO を持たないシグナリングの状態機械と、MLS・SFrame の鍵管理。Web は状態機械を TypeScript で持ち、鍵管理は同じ Rust を WASM で使う。2 つの状態機械は、同じ試験のベクトルを CI で通して揃える |

## 1. 目的と範囲

- 扱う：Web クライアントの構成、対応ブラウザと機能の対応表、参加の前の確認、端末の上の映像と音声の処理、アクセシビリティ、デスクトップ・モバイルのアプリの方式、共通のコアと試験のベクトル。
- 扱わない：
  - シグナリングのメッセージの中身（[signaling-and-meetings.md](signaling-and-meetings.md)）
  - 符号器の設定と帯域の適応（[codecs-and-bandwidth-adaptation.md](codecs-and-bandwidth-adaptation.md)）
  - SFrame・MLS の手順（[e2ee.md](e2ee.md)）
  - ICE・TURN（[network-traversal.md](network-traversal.md)）
  - 字幕の中身と録画の表示（[recording-and-transcription.md](recording-and-transcription.md)）
  - 端末の情報の外部送信の公表（intent.md の L5。observability.md と法務）
- 関係する NFR：NFR-001（遅れ）、NFR-002（参加の速さ）、NFR-006（25 本まで表示）、NFR-008（E2EE）。

## 2. 対応環境（ADR-0021）

### 2.1 対応するブラウザと OS

| 環境 | 対応 |
| --- | --- |
| Chrome・Edge（Windows、macOS、Linux、ChromeOS） | 最新 2 メジャー |
| Firefox（Windows、macOS、Linux） | 最新 2 メジャーと、現行の ESR |
| Safari（macOS） | 最新 2 メジャー（2026-09-27 の時点で 26 と 27。27 は 2026-09-14 に公開。[browser-compat-data](https://github.com/mdn/browser-compat-data) の版の記録（v8.1.3）、2026-09-27 に確認） |
| Safari（iOS・iPadOS） | 同上。iOS の他のブラウザも WebKit なので、同じ扱いにする |
| Chrome（Android） | 最新 2 メジャー |

- ADR-0003 の Confirmation（最新 2 版で E2E の試験を回す）と揃える。
- 対応の外のブラウザでも、参加は止めない。「このブラウザは試験していません」と出し、問題があればアプリか対応ブラウザを勧める。E2EE の会議だけは、必要な API がなければ入れない（2.3 節）。

### 2.2 機能の対応表

いずれも 2026-09-27 に確認した（MDN の browser-compat-data は v8.1.3）。確かめられないものは**未検証**で、E2 の `browser-capability-probe` で実機で確かめて埋める。符号器の対応は [codecs-and-bandwidth-adaptation.md](codecs-and-bandwidth-adaptation.md) の 3 節。

| 機能 | Chrome・Edge | Firefox | Safari | 出典 |
| --- | --- | --- | --- | --- |
| mediasoup-client のハンドラー | `Chrome111`（古い版は `Chrome74`） | `Firefox120` | `Safari12` | [mediasoup-client の handlers](https://github.com/versatica/mediasoup-client/tree/v3/src/handlers)（v3.24.1） |
| simulcast（VP8） | 対応 | 134 から（VP8）、136 から（H.264・AV1） | 対応（H.264 で使う。VP8 の simulcast は MDN に記載がなく**未検証**） | [MDN の WebRTC の符号器](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/WebRTC_codecs) |
| `scalabilityMode`（SVC） | 111 から | 未対応 | 未対応 | [browser-compat-data の PR #30319](https://github.com/mdn/browser-compat-data/pull/30319)（未マージ） |
| `RTCRtpScriptTransform`（E2EE） | 141 から | 117 から | 15.4 から | [caniuse](https://caniuse.com/mdn-api_rtcrtpscripttransform)。Baseline 2025 |
| Dependency Descriptor | 対応 | 136 から | MDN に記載がなく**未検証** | [MDN の WebRTC の符号器](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/WebRTC_codecs) |
| WebGPU | 113 から | 既定で無効（159 まで） | 26 から（macOS は部分的、iOS は対応） | [caniuse](https://caniuse.com/webgpu) |
| `MediaStreamTrackProcessor` | 94 から（互換の表は、仕様の worker ではなく window に公開と注記。worker での動作は**未検証**で、E5 の `virtual-background` で確かめる） | 未対応 | 18 から（出す側の `VideoTrackGenerator` も 18 から） | [MDN](https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamTrackProcessor)、browser-compat-data |
| `AudioWorklet`・WASM の SIMD | 対応（SIMD は 91 から） | 対応（SIMD は 89 から） | 対応（SIMD は 16.4 から） | browser-compat-data（`webassembly.fixed-width-SIMD`） |

- MDN は、`MediaStreamTrackProcessor` を「ブラウザによって window だけ、worker だけで公開され、互換でない」とする。Firefox は持たない。映像の処理は worker で動かす形を基本にし、使えなければ（Firefox は常に）5.1 節の代わりの経路を使う。

### 2.3 対応しないときの扱い

| 足りないもの | 扱い |
| --- | --- |
| `RTCRtpScriptTransform` | E2EE の会議に入れない。理由と対応ブラウザを示す（ADR-0004） |
| `scalabilityMode` | その人がいる会議は `simulcast` のモード（ADR-0018） |
| WebGPU | 仮想背景を WebGL2 で動かす。WebGL2 もなければ仮想背景を選べない |
| 映像の処理の API（`MediaStreamTrackProcessor` など） | 5.1 節の代わりの経路。どちらも使えなければ仮想背景を選べない |
| マイク・カメラの許可がない | 音声なし・映像なしで参加できる。チャットとリアクションは使える |

- 参加の前に、端末で API の有無と `RTCRtpSender.getCapabilities` を調べ、`hello.client.capabilities` として Actor に申告する（[signaling-and-meetings.md](signaling-and-meetings.md) の 6.2 節）。Actor は申告から、映像のモード、E2EE の可否を決める。申告は信用の根拠にしない（E2EE の可否は、鍵管理の手順が通るかで決まる）。

## 3. Web クライアントの構成

### 3.1 構成

```
main スレッド（React）
├─ UI：ギャラリー、話者、共有、チャット、参加者の一覧、主催者の操作
├─ Signaling Client（TypeScript の状態機械。9 節）── WebSocket ──▶ Signaling Gateway
├─ Media Layer（mediasoup-client の Device・Transport・Producer・Consumer）
│    └─ RTCPeerConnection（ブラウザ）── UDP ──▶ Media Node
├─ Device Manager（マイク・カメラ・スピーカーの選択、切り替え、抜き差し）
└─ Stats Collector（getStats を 10 秒ごとに要約して送る。中身は数値だけ）

Dedicated Worker「video-fx」：カメラ → 分割（WebGPU/WebGL）→ 合成 → 送る映像
AudioWorklet「denoise」：マイク → RNNoise（WASM）→ 送る音声
Dedicated Worker「e2ee」：OpenMLS（WASM）＋ SFrame（WASM）。RTCRtpScriptTransform の変換もここ
```

- 画面の表示と、重い処理を分ける。仮想背景・雑音の抑制・E2EE は main スレッドで動かさない。
- `e2ee` のワーカーは、MLS の秘密と SFrame の鍵をワーカーの外（main スレッド）に出さない（[e2ee.md](e2ee.md) の 7 節）。

### 3.2 mediasoup-client の使い方

- `Device.load({ routerRtpCapabilities })` で、ブラウザに合うハンドラーを自動で選ぶ。ハンドラーの手動の指定はしない。
- send の transport 1 本、recv の transport 1 本（[signaling-and-meetings.md](signaling-and-meetings.md) の 8 節）。
- `produce` の `encodings` と `codec` は、会議の映像のモードから決める（[codecs-and-bandwidth-adaptation.md](codecs-and-bandwidth-adaptation.md) の 5・7 節）。
- consumer は `paused` で作られ、映像の要素が画面に入ってから `media.consume.resume` を送る。画面の外に出た映像は、`view.update` から外して止める。
- mediasoup-client の版は、Media Node の mediasoup の版と組み合わせて試験したものだけを使う。版を上げる PR は、ブラウザの組み合わせの試験を通す。

### 3.3 描画

- 映像は `<video>` の要素で表示する。ギャラリーは最大 25 本（NFR-006）。
- 表示の大きさ（CSS の画素 × `devicePixelRatio`）を `view.update.tile_px` で送る。Actor はそれで受ける層の上限を決める（[codecs-and-bandwidth-adaptation.md](codecs-and-bandwidth-adaptation.md) の 6.3 節）。大きさの変化は 250ms 待ってまとめて送る（毎秒 4 回まで）。
- タブが隠れたら（`visibilitychange`）、映像の consumer をすべて `view.update` から外す。音声は続ける。

## 4. 参加の前後

### 4.1 参加の前の確認

1. URL を開く。会議の番号と参加の鍵を読む（[signaling-and-meetings.md](signaling-and-meetings.md) の 4.1 節）。
2. 名前を入れる画面で、並行してマイク・カメラの許可を求め、プレビューを出す。
3. 端末の機能を調べる（2.3 節）。E2EE の会議で `RTCRtpScriptTransform` がなければ、ここで止める。
4. 「参加」で API に参加を求め、WebSocket をつなぐ。

- 2 回目以降の参加では、前回のマイク・カメラ・スピーカーと、仮想背景の設定を `localStorage` から戻す（端末の ID と背景の画像だけ。画像は IndexedDB）。
- 参加の速さの予算（NFR-002）は [signaling-and-meetings.md](signaling-and-meetings.md) の 11 節。クライアントの分（`Device.load`、transport の作成）はそこに含む。仮想背景のモデルの読み込みは参加と並行にし、予算に含めない。読み込みが終わるまでは、背景を処理しない映像を送らない（背景を見せたくない人のため。代わりにカメラを止めたまま入る）。

### 4.2 端末の切り替え

- `devicechange` で一覧を更新する。使っている端末が抜けたら、既定の端末に切り替えて知らせる。
- 切り替えは `producer.replaceTrack` で行い、producer を作り直さない（他の参加者の consumer を作り直させない）。

## 5. 端末の上の処理（ADR-0022）

### 5.1 仮想背景とぼかし

処理の流れ：

```
カメラ（1280×720・30fps）
  → MediaStreamTrackProcessor（worker）→ VideoFrame
  → 縮小（256×144）→ Selfie Segmenter（横長のモデル、入力 144×256）→ 人物のマスク
  → マスクの平滑化（前のフレームとの指数移動平均 α=0.6、縁のぼかし）
  → 合成（元の解像度で、背景の画像かぼかしと合わせる。WebGPU のシェーダー）
  → VideoTrackGenerator（Safari）・MediaStreamTrackGenerator（Chrome・Edge）→ 送る映像のトラック
```

- 出す側の API はブラウザで名前が違う。Chrome・Edge は `MediaStreamTrackGenerator`（94 から）で、仕様の `VideoTrackGenerator` を持たない。Safari は `VideoTrackGenerator`（18 から）を持つ（browser-compat-data、2026-09-27 に確認）。

- 分割のモデルは MediaPipe の Selfie Segmenter（正方形 256×256 と横長 144×256 の 2 つ。Pixel 6 での遅れは約 33〜35ms。[Image segmenter](https://developers.google.com/edge/mediapipe/solutions/vision/image_segmenter)、2026-09-27 に確認）。モデルの利用の条件は、Image segmenter の文書から張られたモデルカード（[Model Card MediaPipe Selfie Segmentation](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20MediaPipe%20Selfie%20Segmentation.pdf)、2021-05-06、2026-09-27 に確認）に Apache License 2.0 とある。E5 の着手前に、配るモデルのファイルとモデルカードの対応を法務と確かめる。
- 実行は WebGPU を第一にし、なければ WebGL2 にする。
- 代わりの経路：`MediaStreamTrackProcessor` が worker で使えないブラウザでは、`<video>` → `OffscreenCanvas` → `canvas.captureStream()` の経路で同じ処理をする。遅れとフレームの落ちは大きくなる見込み（**未検証**。E5 の `virtual-background` で、上の性能の予算に対して測る）。
- ぼかしの強さは 2 段（弱・強）。背景の画像は、組み込みの数枚と、利用者が選んだ画像（端末の中だけに置き、サーバーへ送らない）。
- 映像はサーバーへ送る前に処理を終える（intent.md の MVP）。処理しない映像を一瞬でも送らない。処理が止まったら、カメラを止める。

性能の予算（基準の端末は 4 年前の中位のノート PC。E5 の着手で、この条件に合う機種を QA が 1 台選んで固定する。[quality.md](../quality.md) の 2.2.1 節）：

| 項目 | 予算 |
| --- | --- |
| 1 フレームの処理（分割＋合成） | p95 12ms |
| 処理による遅れの増加（glass-to-glass） | 1 フレーム（33ms）以内 |
| 追加の CPU | 1 コアの 30% 以内（WebGPU のとき） |

### 5.2 雑音の抑制

- 既定は、ブラウザの `noiseSuppression: true`（と `echoCancellation`、`autoGainControl`）。追加の処理はしない。
- 「強い雑音の抑制」を選んだら、ブラウザの `noiseSuppression` を切り、RNNoise を AudioWorklet で動かす。
  - RNNoise は 48 kHz のモノラルの 16 ビットの PCM を扱い、BSD-3-Clause（[xiph/rnnoise](https://github.com/xiph/rnnoise)、2026-09-27 に確認）。WASM にしてワークレットに載せる。
  - RNNoise は 480 サンプル（48 kHz で 10ms）ごとに処理する（RNNoise の `src/denoise.h` の `FRAME_SIZE 480`、2026-09-27 に確認）。AudioWorklet は 128 サンプルごとに呼ばれるので、リングバッファで 480 に揃える。遅れは約 10ms 増える。NFR-001 の mouth-to-ear 200ms の予算から引く。
  - 小さいモデル（`little`）を既定にし、CPU の余裕があれば通常のモデルにする。
- 2 つの抑制を重ねない（二重にかけると声がこもる）。

### 5.3 負荷の制御

- 5 秒ごとに、仮想背景の 1 フレームの処理時間の p95 と、送り手の `qualityLimitationReason` を見る。
- 処理時間の p95 が 25ms を 5 秒続けて超えたら：15 fps に落とす → 次に 360p に落とす → 次に仮想背景を切ってカメラを止め、「端末の負荷が高いため、仮想背景を止めました」と出す。利用者が再開を選べる。
- `qualityLimitationReason` が `cpu` のときは、仮想背景より先に送る映像の上の層を止める（[codecs-and-bandwidth-adaptation.md](codecs-and-bandwidth-adaptation.md) の 9 節）。
- 電池の残りをブラウザから取れる環境では、節電の状態で仮想背景を既定で切る。`navigator.getBattery()` は Chrome・Edge だけが持つ（Firefox は 52 で外し、Safari は持たない。browser-compat-data、2026-09-27 に確認）。他のブラウザでは、この規則を使わない。

## 6. アクセシビリティ

目標は WCAG 2.2 AA。

| 項目 | 方針 |
| --- | --- |
| キーボード | すべての操作をキーボードでできる。主な操作にショートカット（ミュート、カメラ、共有、挙手、チャット）。ショートカットは設定で変えられ、入力欄の中では効かない |
| スクリーンリーダー | 参加・退出、挙手、録画・字幕の開始と停止、主催者によるミュートを `aria-live="polite"` で知らせる。ミュートの状態は、ボタンの名前と状態（`aria-pressed`）で伝える |
| 話している人 | 色の枠だけでなく、アイコンと、参加者の一覧の「話し中」の文字で示す |
| 字幕 | 文字の大きさ・背景の濃さを選べる。字幕の領域は映像に重ねず、別の領域にもできる（字幕の中身は [recording-and-transcription.md](recording-and-transcription.md)。E2EE の会議では出ない） |
| 手話の通訳 | 通訳者の映像をピン留めでき、ピン留めした映像は話者の切り替えで動かない |
| 動き | `prefers-reduced-motion` で、話者の切り替えのアニメーションとリアクションの動きを止める |
| 色 | 文字とボタンのコントラスト 4.5:1 以上。`prefers-contrast: more` に対応する |
| フォーカス | ダイアログ（待合室の許可、退出の確認）を開いたら、フォーカスを移し、閉じたら戻す |
| 言語 | 日本語と英語。画面の文言は ICU のメッセージ形式 |

- 試験：`@axe-core/playwright` を主な画面（参加の前、会議の中、待合室）で回す。スクリーンリーダー（VoiceOver、NVDA）での手動の確認を、Epic の完了時に行う。

## 7. デスクトップアプリ（ADR-0023）

- Electron で Web クライアントを包む。メディアの経路は Electron の Chromium の WebRTC で、Web と同じコード（mediasoup-client、ワーカー、WASM）が動く。
- Web と違うところだけを足す。
  - 画面共有：`session.setDisplayMediaRequestHandler` と `desktopCapturer` で、OS の画面の選択を出す。システムの音声（`audio: 'loopback'`）は Windows で使える。macOS 14.2 以降は `NSAudioCaptureUsageDescription` が要り、Electron v39 から Chromium が CoreAudio Tap を既定で使う。macOS 12.7.6 以前は音声を取れない（[desktopCapturer](https://www.electronjs.org/docs/latest/api/desktop-capturer)、2026-09-27 に確認）。
  - 会議の URL（`https://<brand>.<domain>/j/...`）を開くと、アプリで開く（ユニバーサルリンク・アプリのリンク）。
  - 自動更新、コード署名（Windows・macOS の公証）。
- 安全の設定：`contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`。preload で公開する API は、画面の選択、通知、自動更新だけにする。読み込むのは自分のオリジンだけ。
- 対応 OS：Windows 10・11（x64、arm64）、macOS の直近 3 版。Linux は MVP の後に回す。

## 8. モバイルアプリ（ADR-0023）

- iOS は Swift、Android は Kotlin で UI を書く。メディアは libwebrtc。mediasoup との対応付けは libmediasoupclient（C++、ISC、[versatica/libmediasoupclient](https://github.com/versatica/libmediasoupclient)。2026-06 に `webrtc-m140` のタグ）。
- libwebrtc は自分でビルドする。Google は M80 から、モバイルの公式のビルド済みの配布をやめた（[discuss-webrtc](https://groups.google.com/g/discuss-webrtc/c/oa13f4Tgb8U)、[BlogGeek.me の解説](https://bloggeek.me/how-to-pick-the-right-webrtc-mobile-sdk-build-for-your-application/)、2026-09-27 に確認）。Google Play は、脆弱性のある古い WebRTC を含むアプリに通知を出す（[Google Play のヘルプ](https://support.google.com/faqs/answer/12577537?hl=en)）。
  - Chrome の安定版の milestone に、2 か月以内に追いつく。libmediasoupclient が対応する milestone に合わせる。
- OS との統合：iOS は CallKit と、バックグラウンドの音声。Android は `ConnectionService` と前面のサービス。両方でピクチャー・イン・ピクチャー。
- E2EE：libwebrtc の `FrameTransformerInterface`（Encoded Transform のネイティブの形）で、Rust の共通のコアの SFrame を呼ぶ（[e2ee.md](e2ee.md) の 7 節）。
- 仮想背景：iOS は Vision の人物の分割、Android は MediaPipe の Selfie Segmenter（OS の API と MediaPipe の品質の差は**未検証**。E13 の `mobile-ios-app`・`mobile-android-app` で比べる）。

## 9. 共通のコア（ADR-0024）

### 9.1 範囲

| crate | 中身 | Web | ネイティブ |
| --- | --- | --- | --- |
| `core-signaling` | シグナリングの状態機械（接続、`hello`・`resume`、`(epoch, seq)` の差分の適用、スナップショット、再接続の待ち）。IO を持たない | 使わない（TypeScript 版を使う） | 使う |
| `core-e2ee` | OpenMLS（MLS のグループ、資格情報）と SFrame（[e2ee.md](e2ee.md)） | WASM にして `e2ee` のワーカーで使う | 使う |
| `core-ffi` | UniFFI（[mozilla/uniffi-rs](https://github.com/mozilla/uniffi-rs)、0.32.2）で Swift・Kotlin の束縛を作る | — | 使う |
| `core-wasm` | `wasm-bindgen` で `core-e2ee` を公開する | 使う | — |

- 状態機械は「状態＋入力 → 新しい状態＋出力（送るメッセージ、タイマーの設定、UI への通知）」の純粋な関数にする。WebSocket、時計、乱数は外から入れる。同じ入力の列で、必ず同じ出力になる。
- Web で状態機械を Rust にしないのは、UI（React）との結び付きが強く、WASM の境界を 1 メッセージごとに越える費用と、デバッグのしにくさに見合わないため。鍵管理は、暗号の実装を 1 つにするために Rust を使う（ADR-0003）。

### 9.2 試験のベクトル

- 置き場所：シグナリングのスキーマのパッケージ（`@<brand>/signaling-schema`）と同じリポジトリの `vectors/signaling/`。
- 1 つのベクトルは JSON で、次を持つ。

```jsonc
{
  "id": "resume-after-epoch-change-001",
  "schema_version": "v1",
  "initial": { /* 状態機械の初期の状態（接続前） */ },
  "steps": [
    { "in": { "ws": "open" } },
    { "in": { "recv": { "t": "snap", "epoch": 7, "seq": 100, "body": { } } } },
    { "in": { "ws": "close", "code": 1006 } },
    { "in": { "timer": "reconnect" } },
    { "in": { "recv": { "t": "snap", "epoch": 8, "seq": 101, "body": { } } } }
  ],
  "expect": {
    "outputs": [ /* 送ったメッセージ、設定したタイマー、UI への通知の列 */ ],
    "state": { /* 最後の状態の要約（参加者の一覧、epoch、seq、接続の状態） */ }
  }
}
```

- ベクトルの作り方：
  - 手で書くもの：[signaling-and-meetings.md](signaling-and-meetings.md) の 7 節（再同期）と 12 節（障害）の各行。
  - 生成するもの：TypeScript 版の状態機械を基準にし、fast-check で入力の列を作って期待値を記録する。夜間に 1 万本を作り、差が出たものを固定のベクトルに加える。
- CI：スキーマのリポジトリの PR で、TypeScript 版と Rust 版の両方に全ベクトルを通す。どちらかが違う出力を出したら、マージしない。スキーマの版を上げる PR は、1 つ前の版のベクトルも通す。
- 状態の比べ方は、要約（決めた項目だけ）で行う。実装の中の補助の状態は比べない。
- E2EE のベクトル（RFC 9605 の試験のベクトル、MLS の試験のベクトル）は [e2ee.md](e2ee.md) の 14 節。

## 10. 失敗のしかた

| 失敗 | 起きること | 対処 |
| --- | --- | --- |
| ブラウザの新しい版で API の振る舞いが変わる | 参加できない、映像が出ない | Beta・Dev の版での夜間の試験。runbooks の `browser-release-regression.md` |
| WebGPU のドライバの不具合 | 仮想背景が黒くなる、タブが落ちる | 出力の検査（マスクがすべて 0 か 1 のフレームが 30 続く）で WebGL2 に落とす。端末とドライバの組み合わせを除外の一覧に足す |
| 仮想背景のモデルの読み込みの失敗 | 仮想背景を選べない | カメラを止めたまま参加させ、理由を示す。処理しない映像は送らない |
| AudioWorklet の処理の遅れ（CPU の不足） | 音声が途切れる | 処理の遅れを数え、続いたら RNNoise を切ってブラウザの抑制に戻す |
| mediasoup-client と Media Node の版の組み合わせの不一致 | 交渉に失敗する | 版の組み合わせを CI で固定する。Web は読み込み直しで新しい版になる |
| Electron の Chromium が古い | Web より機能が遅れる | Electron の安定版に 1 か月以内に追いつく |
| libwebrtc の更新が遅れる（モバイル） | 脆弱性、ストアからの通知 | Chrome の milestone から 2 か月以内（8 節） |
| TypeScript 版と Rust 版の状態機械の食い違い | 同じ会議でアプリだけ状態がずれる | 9.2 節のベクトル。本番では、再同期の回数をクライアントの種類ごとに監視する |

## 11. セキュリティ

- CSP：`script-src 'self' 'wasm-unsafe-eval'`（WASM のため）。外部のスクリプトは読まない。`connect-src` は API、Signaling Gateway のオリジンだけ。
- 仮想背景の画像、端末の ID、表示の名前は、端末の中だけに置く。サーバーへ送るのは、会議に要る表示の名前だけ。
- E2EE の鍵と MLS の秘密は、`e2ee` のワーカーとネイティブの共通のコアの外に出さない。ログ・クラッシュの報告に含めない（本題材の AGENTS.md）。
- 品質の計測（`getStats` の要約）は数値だけ。IP アドレスの候補（ICE の candidate）の文字列は送らない。外部送信の公表は、intent.md の L5 の結論に従う（Web クライアントの公開は L5 の確認を待つ）。
- Electron：7 節の安全の設定。任意の URL を開く `shell.openExternal` は、`https:` だけを許す。
- モバイル：資格情報と鍵は、iOS の Keychain、Android の Keystore に置く。

## 12. テスト

| レベル | 対象 | 道具 |
| --- | --- | --- |
| 単体 | 状態機械、端末の機能の判定、表示の大きさから層の上限、負荷の制御の規則 | Vitest、Rust の `cargo test` |
| 実装をまたぐ試験 | 9.2 節の試験のベクトル（TypeScript と Rust） | Vitest、`cargo test` |
| 性質ベース | 任意の入力の列で、状態機械がスナップショットの後に `seq` を戻さない。どの列でも、最後の状態は Actor の `(epoch, seq)` の順の状態と一致する（signaling-and-meetings.md の PROP-SIG-001 のクライアントの側） | fast-check、`proptest` |
| E2E | 参加、音声・映像・共有、端末の切り替え、仮想背景、雑音の抑制、再接続 | Playwright（Chromium、Firefox、WebKit）と、実機の Safari（macOS の safaridriver、iOS の実機） |
| ネットワークの劣化 | [codecs-and-bandwidth-adaptation.md](codecs-and-bandwidth-adaptation.md) の 11.1 節 | `tc netem`、Playwright |
| a11y | 6 節 | `@axe-core/playwright`、手動 |
| 性能 | 5.1 節の予算、参加の速さ | 基準の端末での計測。PR ごとにはヘッドレスの Chromium の値、週に 1 回実機 |

- 偽のカメラ・マイク：Chromium は `--use-fake-device-for-media-stream` と `--use-file-for-fake-video-capture`・`--use-file-for-fake-audio-capture` で、試験の映像（Y4M）と音声（WAV）を入れる。試験の素材は、利用の条件が明らかな公開のデータセットか合成したものだけ（本題材の AGENTS.md）。仮想背景の試験の人物の映像は、合成（3D のアバター）を使う。
- 仮想背景の品質：合成の映像の正解のマスクと比べ、IoU を測る（閾値は [quality.md](../quality.md) の 2.2.1 節。既定 0.90 以上）。
- Playwright の WebKit は Safari そのものではない。Safari の試験は実機（macOS・iOS）で、夜間に回す。

## 13. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E1 | `client-e2e-harness` | 12 節の E2E の基盤。偽の端末、ブラウザの組み合わせ、実機の Safari |
| E2 | `web-client-shell` | 3.1 節の構成、React の画面の骨格 |
| E2 | `browser-capability-probe` | 2.2・2.3 節。機能の判定と申告、使えない機能の表示 |
| E2 | `prejoin-preview` | 4.1 節。プレビュー、端末の選択、前回の設定 |
| E2 | `device-switching` | 4.2 節 |
| E2 | `gallery-view-hints` | 3.3 節。表示の大きさの送信、タブが隠れたときの停止 |
| E5 | `virtual-background` | 5.1 節。Selfie Segmenter、WebGPU・WebGL2、代わりの経路 |
| E5 | `background-blur` | 5.1 節のぼかし |
| E5 | `noise-suppression-rnnoise` | 5.2 節 |
| E5 | `device-load-governor` | 5.3 節 |
| E5 | `a11y-meeting-ui` | 6 節 |
| E13 | `desktop-electron-shell` | 7 節 |
| E13 | `desktop-screen-share-audio` | 7 節のシステムの音声 |
| E13 | `core-signaling-rust` | 9.1 節の状態機械の Rust 版 |
| E13 | `signaling-test-vectors` | 9.2 節。ベクトルの形式、生成、CI |
| E13 | `libwebrtc-build-pipeline` | 8 節。libwebrtc と libmediasoupclient のビルドと追従 |
| E13 | `mobile-ios-app` ・ `mobile-android-app` | 8 節 |
| E9 | `e2ee-worker-wasm` | 3.1 節の `e2ee` のワーカーと `core-wasm`（[e2ee.md](e2ee.md)） |

Epic の番号は [architecture/README.md](README.md) の 7 節の割り当てに従う。Epic の名前は [roadmap.md](../roadmap.md) で決まる。

## 14. 未解決の問い

### 決定

2026-09-27 に推奨案で確定した（[README.md](README.md) の 6 節の「決定（2026-09-27、推奨案で確定）」）。

- **対応ブラウザ**：主要な 4 つの最新 2 メジャーと Firefox の ESR（ADR-0021）。
- **仮想背景**：MediaPipe の Selfie Segmenter、WebGPU、なければ WebGL2（ADR-0022）。
- **雑音の抑制**：既定はブラウザ。強い抑制で RNNoise（ADR-0022）。
- **デスクトップ**：Electron（ADR-0023）。
- **モバイル**：ネイティブ＋自前の libwebrtc＋libmediasoupclient＋Rust の共通のコア（ADR-0023）。
- **Web の状態機械**：TypeScript のまま。Rust 版と試験のベクトルで揃える（ADR-0024）。
- **処理しない映像**：仮想背景が止まったら、処理しない映像を送らず、カメラを止める。
- **仮想背景の基準の端末**：4 年前の中位のノート PC とする。E5 の着手で、この条件に合う機種を QA が 1 台選んで固定する。IoU の閾値 0.90 は QA が承認した値（[quality.md](../quality.md)）。
- **デスクトップの Linux 版**：MVP では作らない（[roadmap.md](../roadmap.md) の延期の一覧）。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| Selfie Segmenter のモデルのファイルの利用の条件 | モデルカードは Apache License 2.0（5.1 節）。配るファイルとの対応を E5 の `virtual-background` の着手前に法務と確かめる |
| Chrome の worker での `MediaStreamTrackProcessor` の動作と、代わりの経路（Firefox は常に）の性能 | E5 の `virtual-background` で計測する。Firefox は持たず、Safari は 18 から持つ（2.2 節） |
| RNNoise より新しい雑音の抑制のモデル（より大きい DNN）を使うか | E5 で、CPU と MOS の推定で比べる |
| モバイルの仮想背景を OS の API にするか MediaPipe にするか | E13 の着手時 |
| Web の状態機械も Rust（WASM）にするか | ベクトルの食い違いが続くなら見直す。E13 の後に判断する |

## 15. quality.md・runbooks・data-model への項目

### quality.md

- ブラウザの組み合わせの範囲（2.1 節）と、実機の Safari の試験の頻度。
- 仮想背景の性能の予算（5.1 節）と、基準の端末。IoU の閾値。
- 状態機械の試験のベクトルの数と、夜間の生成の本数（9.2 節）。
- a11y の自動の検査の範囲と、手動の確認の時期。
- 参加の速さのクライアントの区間（`Device.load`、モデルの読み込み）。

### runbooks

- `browser-release-regression.md`：ブラウザの Beta・安定版の更新で参加や映像が壊れたときの確かめ方と、影響するブラウザへの案内の出し方。[codecs-and-bandwidth-adaptation.md](codecs-and-bandwidth-adaptation.md) と共有する。
- `virtual-background-failures.md`：仮想背景の失敗（GPU のドライバ）の報告が増えたときの、除外の一覧の更新。
- `desktop-app-update-rollback.md`：Electron のアプリの更新を止め、前の版に戻す手順。

### data-model（索引への追加の提案）

| 置き場所 | 中身 |
| --- | --- |
| Aurora `meeting_participations`（signaling-and-meetings.md の提案に列を足す。codecs の提案と 1 つにまとめた。[data-model.md](data-model.md) の 5.3 節） | `client_kind`（`web`・`desktop`・`ios`・`android`・`phone`）、`client_version`、`browser`、`browser_version`、`os` |
| Aurora `client_releases` | デスクトップ・モバイルの版、配布の状態、最低の版（古すぎる版を止める） |
| 端末の中（`localStorage`・IndexedDB） | 前回の端末の ID、仮想背景の設定と画像、ショートカットの設定。サーバーには置かない |

## 参考

- [mediasoup-client](https://github.com/versatica/mediasoup-client)、[libmediasoupclient](https://github.com/versatica/libmediasoupclient)
- [MDN の WebRTC の符号器](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/WebRTC_codecs)、[MDN の MediaStreamTrackProcessor](https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamTrackProcessor)、[caniuse の RTCRtpScriptTransform](https://caniuse.com/mdn-api_rtcrtpscripttransform)、[caniuse の WebGPU](https://caniuse.com/webgpu)
- [MediaPipe の Image segmenter](https://developers.google.com/edge/mediapipe/solutions/vision/image_segmenter)、[xiph/rnnoise](https://github.com/xiph/rnnoise)
- [Electron の desktopCapturer](https://www.electronjs.org/docs/latest/api/desktop-capturer)
- [mozilla/uniffi-rs](https://github.com/mozilla/uniffi-rs)

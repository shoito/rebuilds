# Codecs and Bandwidth Adaptation: Zoom

音声と映像を、どの符号器で、どの設定で符号化し、回線の帯域と損失に合わせてどう変えるかの設計。Opus（DTX、インバンド FEC、RED）、映像の符号器（VP8・H.264・VP9・AV1）の選び方、simulcast と SVC の使い分け、帯域の推定（GCC と transport-cc）、Media Node での層の選び方の方針、画面共有の符号化、損失 20% の回線での振る舞いを決める。

前提として、次の決定に従う。

| 決定 | この領域への影響 |
| --- | --- |
| [ADR-0001](../decisions/0001-platform-and-stack.md) | SFU は mediasoup v3。Media Node が扱える符号器とヘッダー拡張は、mediasoup の対応の範囲に縛られる |
| [ADR-0002](../decisions/0002-media-topology.md) | 映像は simulcast と SVC。音声は Opus の DTX・FEC・RED。帯域の推定は transport-cc と GCC |
| [ADR-0003](../decisions/0003-client-platform.md) | Web はブラウザの WebRTC。符号器と帯域の推定の細かい制御は、ブラウザが許す範囲に限る |
| [ADR-0004](../decisions/0004-encryption-and-e2ee.md) | E2EE の会議では、SFU はペイロードを読めない。層の選択はヘッダー拡張で行う（[e2ee.md](e2ee.md)） |

この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0017](../decisions/0017-opus-dtx-fec-red.md) | 音声は Opus（20ms、モノラル、目標 32 kbps）で、DTX とインバンド FEC を常に有効にする。RED（RFC 2198、ブラウザが送る distance 1）を使うため、mediasoup に RED の転送と、受け手ごとの RED の剥がしを足す |
| [0018](../decisions/0018-video-codec-and-layering-selection.md) | カメラの既定は VP8 の simulcast 3 本（各 L1T3）。iOS・iPadOS の Safari の送り手は H.264 の simulcast。参加者が全員 Chromium の会議だけ VP9 `L3T3_KEY` の SVC にする。AV1 は S1 ではフラグの裏に置く |
| [0019](../decisions/0019-bandwidth-estimation-and-layer-allocation.md) | 上りはブラウザの GCC に任せ、Media Node は transport-cc の帰還を返す。下りは Media Node が受け手ごとに推定し、優先度（音声 > 画面共有 > 話者 > ギャラリー）の順に配る。下げは速く、上げは遅く。映像の FEC は使わず、NACK と RTX で直す |
| [0020](../decisions/0020-screen-share-encoding.md) | 画面共有は `contentHint: "detail"` と `maintain-resolution` で、最大 1920×1080・5 fps（動きの多い共有は 15 fps）。時間の層だけ（`L1T3`）を使い、空間の層は作らない |

## 1. 目的と範囲

- 扱う：
  - 送り手の符号器の設定：符号器、解像度、フレームの数、ビットレート、層の構成
  - 帯域の推定：上り（送り手のブラウザ）と下り（Media Node）
  - 受け手ごとの層の選び方の方針：優先度、表示の大きさ、上げ下げの規則
  - 損失・揺らぎへの備え：FEC、RED、NACK・RTX、キーフレームの要求
  - 画面共有の符号化
- 扱わない：
  - Media Node の中の転送の実装、キーフレームの要求の集約、話者の検出、カスケード（[media-server-sfu.md](media-server-sfu.md)）
  - ICE・TURN（[network-traversal.md](network-traversal.md)）
  - 端末の上の仮想背景と雑音の抑制（[clients.md](clients.md)）
  - SFrame の暗号化と、E2EE での層の選択の細部（[e2ee.md](e2ee.md)）
  - 品質の指標の集め方と SLO（observability.md）
- 関係する NFR：NFR-001（遅れ）、NFR-003（損失 20% での音声）、NFR-006（25 本まで受ける）、NFR-009（帯域の適応）。

## 2. 本家の形（確かめたこと）

- 本家の帯域の目安は、グループの 720p で上り 2.6 Mbps・下り 1.8 Mbps、音声だけで 60〜80 kbps（[Zoom の帯域の要件](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0060748)、2026-09-27 に確認）。
- 本家の符号器、層の構成、帯域の推定の方式は、公開の一次の資料に書かれていない（2026-09-27 に探した範囲）。本家の Web クライアントは、ブラウザの WebRTC のメディアの経路を避けてきたと報告されている（[ADR-0003](../decisions/0003-client-platform.md) の Context）。本設計は、標準の WebRTC の上で同じ目標（NFR）を満たすことを狙う。

## 3. 標準と実装の前提

いずれも 2026-09-27 に確認した。

| 項目 | 事実 | 出典 |
| --- | --- | --- |
| Opus | フレームは 2.5〜60ms。6〜510 kbps。SILK・CELT・その混成のモードを持つ。インバンド FEC（LBRR）は SILK の層で、前のフレームを低い品質で重ねて送る | [RFC 6716](https://www.rfc-editor.org/rfc/rfc6716) |
| Opus の RTP | クロックは常に 48,000 Hz。SDP の `useinbandfec`・`usedtx`・`cbr`・`stereo` の既定は 0。`ptime` の既定は 20ms、`maxptime` は 120ms。音声の目安のビットレート（20ms）：広帯域 16〜20 kbps、全帯域 28〜40 kbps | [RFC 7587](https://www.rfc-editor.org/rfc/rfc7587) |
| RED | 1 つの RTP パケットに、主の符号と過去の符号（冗長）を並べる。ブロックのヘッダーは F（1 ビット）、PT（7 ビット）、時刻の差（14 ビット、最大 16,383）、長さ（10 ビット、最大 1,023 バイト） | [RFC 2198](https://www.rfc-editor.org/rfc/rfc2198) |
| FlexFEC | 行・列・2 次元の XOR の修復パケット。`flexfec` のメディア型 | [RFC 8627](https://www.rfc-editor.org/rfc/rfc8627) |
| WebRTC-SVC | `scalabilityMode`（`L1T3`、`L3T3_KEY` など）で層を指定する。`_KEY` は「空間の層がキーフレームでだけ下の層に依存する」形。既定のモードは実装に任され、時間の層だけのモードであるべき（SHOULD）とされる。2026-09-14 の Working Draft | [WebRTC-SVC](https://www.w3.org/TR/webrtc-svc/) |
| Content Hints | 映像の `contentHint` は `motion`・`detail`・`text`。`detail`・`text` は既定で `maintain-resolution`、`motion` は `maintain-framerate` になる。`degradationPreference` もこの仕様が定める。2025-09-19 の Working Draft | [MediaStreamTrack Content Hints](https://www.w3.org/TR/mst-content-hint/) |
| GCC | 遅れに基づく制御（到着の間隔の差をカルマンフィルタで推定し、適応する閾値で過負荷を判定。初期の閾値 12.5ms、範囲 6〜600ms）と、損失に基づく制御の 2 つ。増やすときは毎秒 8% まで、減らすときは受けた速さの 0.85 倍。損失が 2% 未満なら 5% 増やし、10% を超えたら `(1 − 0.5p)` 倍にする。送る速さは 2 つの推定の小さい方。草案は失効している | [draft-ietf-rmcat-gcc-02](https://datatracker.ietf.org/doc/html/draft-ietf-rmcat-gcc-02) |
| transport-cc | 送り手がパケットに連番を付け、受け手が到着の時刻をまとめて返す。GCC を送り手の側で動かすための帰還。草案は失効している | [draft-holmer-rmcat-transport-wide-cc-extensions-01](https://datatracker.ietf.org/doc/html/draft-holmer-rmcat-transport-wide-cc-extensions-01) |

ブラウザの対応（[MDN の WebRTC の符号器](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/WebRTC_codecs)、2026-09-07 更新、2026-09-27 に確認。ほかは各行の出典）。

| 項目 | Chrome・Edge | Firefox | Safari |
| --- | --- | --- | --- |
| VP8・H.264（Constrained Baseline） | 対応（必須の符号器） | 対応 | 対応（VP8 は 12.1 から） |
| VP9 | 48 から | 対応 | WebRTC での対応は MDN に記載がない（**未検証**） |
| AV1 | 113 から | 136 から（156 で既定で有効と報告） | MDN に記載がない（**未検証**） |
| `scalabilityMode`（SVC） | 111 から（[browser-compat-data の PR #30319](https://github.com/mdn/browser-compat-data/pull/30319)、2026-09-27 の時点で未マージ） | 未対応（同じ PR の記録） | 未対応（同じ PR の記録） |
| Dependency Descriptor（DD） | 対応 | 136 から（VP8・VP9・AV1。H.264 は 137 からでデスクトップだけ） | MDN に記載がない（**未検証**） |
| Opus の RED（`audio/red`） | M96 から、`setCodecPreferences` で RED を先にすると使える（[discuss-webrtc の告知](https://groups.google.com/g/discuss-webrtc/c/5761etCrSuA)）。冗長は 1 つ（distance 1）で、前のフレームの符号をそのまま写す（libwebrtc の [audio_encoder_copy_red.cc](https://webrtc.googlesource.com/src/+/refs/heads/main/modules/audio_coding/codecs/red/audio_encoder_copy_red.cc) の `kRedNumberOfRedundantEncodings = 1`。数を変えるのはフィールドトライアル `WebRTC-Audio-Red-For-Opus` だけで、Web のページからは変えられない） | **未検証** | **未検証** |

- 表の**未検証**の欄は、E2 の `browser-capability-probe` で `RTCRtpSender.getCapabilities()` と実際の送受信を確かめて埋める。Safari の最新 2 メジャーは 26 と 27（27 は 2026-09-14 に公開。[browser-compat-data](https://github.com/mdn/browser-compat-data) の版の記録、2026-09-27 に確認）。

- Firefox 155 以降は、AV1 の SVC の上の空間の層を正しく復号できず、黒い画面や止まった映像になると報告されている（[livekit/client-sdk-js#2116](https://github.com/livekit/client-sdk-js/issues/2116)、2026-09-23 起票）。

mediasoup の対応（v3.27.1。[supportedRtpCapabilities.ts](https://github.com/versatica/mediasoup/blob/v3/node/src/supportedRtpCapabilities.ts)、[RTP Parameters and Capabilities](https://mediasoup.org/documentation/v3/mediasoup/rtp-parameters-and-capabilities/)、[CHANGELOG](https://github.com/versatica/mediasoup/blob/v3/CHANGELOG.md)、2026-09-27 に確認）。

| 項目 | 対応 |
| --- | --- |
| 音声の符号器 | Opus（`nack`・`transport-cc` の帰還）、multiopus、G.711 など。**`audio/red` は無い**。RED の実装の issue（[#481](https://github.com/versatica/mediasoup/issues/481)、2020-11 起票）は開いたまま |
| 映像の符号器 | VP8、VP9、H.264、AV1。ULPFEC・FlexFEC は無い |
| SVC | VP9 の full SVC と K-SVC。3.21.1 で VP8・H.264 の時間の層の SVC |
| AV1 と DD | 3.16.0 で AV1、3.19.4 で DD の転送。DD の拡張は `recvonly`（受けて読むが、受け手へは付けない）。空間の層が複数の AV1 で、DD を転送すると映像が止まる問題を調査中（[#1625](https://github.com/versatica/mediasoup/issues/1625)、開いたまま） |
| 帯域 | 受け手ごとの送信側の推定、consumer の `priority`・`preferredLayers`、`setMaxOutgoingBitrate`・`setMaxIncomingBitrate` |

ここから、**ADR-0002 の「Opus の RED を有効にする」は、mediasoup をそのまま使うと実現できない**と分かった。ADR-0017 で扱う。

## 4. 音声（ADR-0017）

### 4.1 設定

| 項目 | 値 | 理由 |
| --- | --- | --- |
| 符号器 | Opus、モノラル、48 kHz | 必須の符号器。会話にステレオは要らない |
| フレーム | 20ms（`ptime=20`） | RFC 7587 の既定。10ms にするとパケットが倍になり、PPS（ADR-0001）とヘッダーの費用が増える |
| 目標のビットレート | 32 kbps（`maxaveragebitrate=32000`） | 全帯域の音声の目安 28〜40 kbps の中。VBR（`cbr=0`） |
| DTX | 有効（`usedtx=1`） | 黙っている間の送出を減らす。100 人の会議で大半は黙っている |
| インバンド FEC | 有効（`useinbandfec=1`） | 単発の損失を、次のパケットの LBRR で直す |
| RED | 有効（distance 1。ブラウザの送る形）。4.3 節 | 連続した損失に備える |
| 音声の NACK | 使わない | 20ms ごとの音声は、再送を待つとジッタバッファが伸び、NFR-001 の mouth-to-ear 200ms を食う |
| ブラウザの音声の処理 | `echoCancellation`・`autoGainControl` は有効。`noiseSuppression` は既定で有効、強い雑音の抑制を選んだときは無効（[clients.md](clients.md) の 5.2 節） | — |
| 音量のヘッダー拡張 | `urn:ietf:params:rtp-hdrext:ssrc-audio-level` | Media Node が話者を決める（[media-server-sfu.md](media-server-sfu.md)） |

- ブラウザの Opus の既定のビットレートと、損失の率から FEC を強める閾値は、ブラウザの実装に任せる。値は**未検証**。E2 の `audio-opus-baseline` で `getStats` の `targetBitrate` を記録して確かめる。

### 4.2 損失への備えの組み合わせ

| 損失の形 | インバンド FEC | RED distance 1 ＋ FEC | 残る損失（独立な損失 p の見積もり） |
| --- | --- | --- | --- |
| なし（p = 0） | 費用は小さい | 送出が約 2 倍（下の注） | 0 |
| ランダム 5% | 単発を直す | 2 連続までを直す（2 つ目は LBRR の品質） | FEC だけ：約 p² = 0.25%。RED ＋ FEC：約 p³ = 0.0125% |
| ランダム 20% | 単発を直す | 2 連続までを直す（同上） | FEC だけ：約 4%。RED ＋ FEC：約 0.8% |
| バースト（平均 3 パケット） | ほぼ効かない | 一部を直す | 見積もれない。netem の Gilbert-Elliott で測る |

- 見積もりは、損失が独立で、FEC・RED のパケットも同じ率で落ちる、とした単純な計算。MOS との関係は**未検証**。E4 の `loss-20-audio` で ViSQOL の値に置き換える。
- **ブラウザの RED は distance 1 である。** libwebrtc の RED の符号器は、前のフレームの Opus の符号をそのまま（完全な符号として）写し、冗長の数の既定は 1 つである（3 節の表の出典）。Web のページから distance 2 にする手段はない。写した符号は FEC を有効にした Opus のパケットなので、その中の LBRR も一緒に運ばれる。そのため、フレーム n は、パケット n（主）、n+1（RED の写しと、主の中の LBRR）、n+2（RED の写しの中の LBRR）の 3 か所に載り、独立な損失 p で失うのは約 p³ になる見込み（2 つ目以降は LBRR の低い品質）。この見込みは E4 の `red-forwarding` で確かめる。
- RED は、主の符号の前に前の符号を 1 つ並べるので、送出は最大で約 2 倍になる。webrtcHacks の計測では、distance 1 で音声のビットレートが約 30 kbps から約 60 kbps に倍増した。損失 60% のとき、隠した（concealed）割合は RED なしで 60%、distance 1 で 32%、distance 2 で 18% だった（[RED: Improving Audio Quality with Redundancy](https://webrtchacks.com/red-improving-audio-quality-with-redundancy/)、2020-08、2026-09-27 に確認。distance 2 はフィールドトライアルでの計測）。
- DTX と組むので、RED の費用は話している間だけかかる。

### 4.3 Media Node での RED

mediasoup に RED が無いので、Media Node（mediasoup の worker）に次を足す。上流に提案し、取り込まれるまではフォークで持つ（ADR-0001 の「C++ の worker の不具合は、自分で直すか、上流に報告して待つ」の範囲）。

1. **RED の転送**：router の符号器に `audio/red`（`a=fmtp:<pt> <opus-pt>/<opus-pt>`）を足す。producer が RED で送ったら、RED のまま受け手へ転送する。
2. **受け手ごとの剥がし**：受け手が RED に対応しないか、受け手の下りの推定が小さいときは、Media Node が RED のブロックを外し、主の Opus の符号だけを Opus のペイロード型で送る。
3. **受け手の帯域に合わせた冗長の数**：下りの推定から、受け手ごとに RED を残す（distance 1）か剥がす（0）かを決める（6.4 節）。送り手より大きい distance は作れない。

- Recorder・Transcriber（[recording-and-transcription.md](recording-and-transcription.md)）は RED に対応しない受け手として扱い、剥がした Opus を渡す。録画と音声認識の側に RED の処理を持たせない。
- 剥がすときは、RTP の時刻・連番は主の符号のものをそのまま使う。RED のブロックの長さの検査（10 ビット、1,023 バイト）に通らないパケットは捨てる。
- E2EE の会議で RED と Encoded Transform を組んだときの振る舞いは**未検証**（E9 の `e2ee-poc-transform` で確かめる。[e2ee.md](e2ee.md) の 7 節）。確かめるまでは、E2EE の会議では RED を使わず、インバンド FEC だけにする。

### 4.4 大きな会議の音声

- ADR-0002 のとおり、Media Node は声の大きい数人（既定 3 人）の音声だけを受け手に送る。受け手の下りに載る音声は、最大で 3 本 ×（32 kbps × RED の倍率 ＋ ヘッダー）。
- ヘッダーの費用：IPv4・UDP・RTP・SRTP の認証タグ・ヘッダー拡張で、1 パケット約 60 バイト（見込み）。50 パケット/秒で約 24 kbps。1 本あたり、RED なしで約 56 kbps、RED distance 1 で約 90 kbps の見込み（**未検証**。E4 の `red-forwarding` で計測する）。
- 下りが 150 kbps まで落ちたとき（NFR-009）の音声の扱いは 6.4 節。

## 5. 映像の符号器と層（ADR-0018）

### 5.1 送り手ごとの符号器の選び方

Meeting Actor が、会議の参加者の端末の申告（`hello.client` と `media.capabilities`。[signaling-and-meetings.md](signaling-and-meetings.md) の 6.2 節）から、会議の「映像のモード」を決める。モードは会議の状態の一部で、`seq` 付きで全員に配る。

| モード | 条件 | カメラの送り方 |
| --- | --- | --- |
| `simulcast`（既定） | 常に使える | VP8 の simulcast 3 本。iOS・iPadOS の Safari の送り手だけ H.264 の simulcast 3 本 |
| `svc` | 参加者が全員 Chromium（Chrome・Edge、最新 2 版）で、VP9 の `L3T3_KEY` を `RTCRtpSender.getCapabilities` で申告した。かつ会議の参加者が 5 人以上 | VP9 `L3T3_KEY` 1 本 |
| `av1-svc` | S1 ではフラグ（`media.av1`）の裏。社内の会議だけで試す | AV1 `L3T3_KEY` 1 本 |

- 受け手は、VP8 と H.264 をどのブラウザでも復号できる（必須の符号器）。送り手ごとに符号器が違っても、受け手の側に追加の条件は要らない。
- VP9 の SVC を選ぶのは、上りの帯域（simulcast より 1 本分少ない）と CPU を減らすため。受け手ごとに層を剥がすだけで済む。
- `svc` の会議に条件を満たさない人（Firefox、Safari、古い版）が入ったら、Actor はモードを `simulcast` に変え、送り手に符号器の切り替えを指示する。その会議の開催の間は `svc` に戻さない（行き来を防ぐ）。
- AV1 を S1 の既定にしないのは、次の理由による。
  - mediasoup で、空間の層が複数の AV1 に DD の転送を組むと、映像が止まる問題が開いたまま（[#1625](https://github.com/versatica/mediasoup/issues/1625)）。
  - Firefox の受け手は AV1 の SVC の上の層を復号できないと報告されている（[#2116](https://github.com/livekit/client-sdk-js/issues/2116)）。
  - AV1 のソフトウェアの符号化は、VP8 より CPU を多く使う（**未検証**。E4 の `av1-evaluation` で測る）。

### 5.2 simulcast の層

| rid | 解像度（16:9） | 最大 fps | `maxBitrate` | `scaleResolutionDownBy` | `scalabilityMode` |
| --- | --- | --- | --- | --- | --- |
| `q` | 320×180 | 15 | 150 kbps | 4 | `L1T3` |
| `h` | 640×360 | 30 | 500 kbps | 2 | `L1T3` |
| `f` | 1280×720 | 30 | 1,500 kbps | 1 | `L1T3` |

- 3 本の上りの合計は最大 2.15 Mbps。本家の 720p の上りの目安 2.6 Mbps より小さい。
- H.264 の送り手は、時間の層を使わず `L1T1` にする。mediasoup は 3.21.1 で、1 本の流れに時間の層を持つ VP8・H.264 を SVC の consumer で扱うようにした（[CHANGELOG](https://github.com/versatica/mediasoup/blob/v3/CHANGELOG.md) の PR #1851、2026-09-27 に確認）が、Safari の H.264 の時間の層での動作は**未検証**（E2 の `video-simulcast-vp8` で確かめ、動けば `L1T3` に変える）。
- **使われない層を止める**：Media Node が、ある層を受ける consumer が 0 の状態を 5 秒続けて見たら、Actor に知らせる。Actor は送り手に `media.layers.hint` で、その層の `active: false` を指示する（`RTCRtpSender.setParameters`。[media-server-sfu.md](media-server-sfu.md) の 5.5 節）。受け手が現れたら `active: true` に戻し、キーフレームを求める。上りの帯域と送り手の CPU を減らす。
- カメラの入力は 1280×720・30 fps を求める。端末が出せない場合は、出せる最大から層を作る。

### 5.3 SVC の層（VP9 `L3T3_KEY`）

| 空間の層 | 解像度 | 時間の層ごとの fps（T0 / T1 / T2） |
| --- | --- | --- |
| S0 | 320×180 | 7.5 / 15 / 30 |
| S1 | 640×360 | 7.5 / 15 / 30 |
| S2 | 1280×720 | 7.5 / 15 / 30 |

- `maxBitrate` は全体で 1,200 kbps（simulcast の合計より小さくてよい見込み。**未検証**。E4 の `svc-vp9-mode` で上りの差と一緒に測る）。
- `_KEY` を選ぶのは、上の空間の層がキーフレームでだけ下の層に依存するので、受け手ごとに空間の層を剥がしても、受け手の復号の費用が単一の層と同じになるため。mediasoup は VP9 の K-SVC に対応している。

### 5.4 キーフレーム

- 受け手が層を上げる（simulcast の本数を替える、SVC の空間の層を上げる）には、キーフレームが要る。Media Node が送り手に PLI を送る。送り手ごとの PLI の集約は [media-server-sfu.md](media-server-sfu.md) の 7 節（[ADR-0011](../decisions/0011-forwarding-and-layer-selection.md)。`keyFrameRequestDelay` をカメラ 1,000ms、画面共有 2,000ms）に従う。
- 定期的なキーフレームは送らない（ブラウザの既定に任せる）。

## 6. 帯域の推定と層の選択（ADR-0019）

### 6.1 上り（送り手 → Media Node）

- 送り手のブラウザが GCC で推定し、符号器のビットレートと、simulcast のどの本を送るかを決める。Media Node は transport-cc の帰還を返すだけにする（mediasoup の `transport-cc` の拡張）。
- Media Node は、送り手の transport に `setMaxIncomingBitrate(3,000 kbps)` を設ける。カメラ 2.15 Mbps ＋ 画面共有 1.5 Mbps の同時は、帯域が足りれば許す。足りなければ、ブラウザの割り当てで画面共有が優先されるよう、画面共有の sender の `priority` を `high`、カメラを `low` にする（`RTCRtpEncodingParameters.priority`）。
- 送り手の推定が下がると、ブラウザは上の本から止める（simulcast）。Media Node は、止まった本を受けていた consumer を、残っている本へ移す。

### 6.2 下り（Media Node → 受け手）

- Media Node が受け手ごとに、受け手のブラウザから返る transport-cc の帰還で推定する（mediasoup の送信側の推定）。推定は、受け手の transport の全 consumer で分け合う。
- 受け手の transport に `setMaxOutgoingBitrate` を設ける。既定は 4,000 kbps。受け手の端末が申告した上限（モバイルのデータの節約など）があれば、小さい方にする。
- 推定の値は、1 秒ごとに Actor へ要約して送らない（Media Node の中で完結する）。Actor は、受け手の見える範囲（`view.update`）と表示の大きさから、consumer ごとの「上限の層」と「優先度」だけを決める（[signaling-and-meetings.md](signaling-and-meetings.md) の 8 節）。

### 6.3 受け手ごとの割り当て

Actor が決めるもの（consumer ごと）：

| 対象 | mediasoup の `priority` | 上限の層（`preferredLayers`） |
| --- | --- | --- |
| 音声 | 別枠（6.4 節） | — |
| 画面共有 | 255 | 空間は 1 つ。時間は T2（15 fps のとき） |
| ピン留め・主な話者の大きな表示 | 200 | 表示の高さで決める（下の表） |
| ギャラリーの表示（2〜9 本） | 100 | 同上。時間は T1（15 fps）まで |
| ギャラリーの表示（10〜25 本） | 50 | 空間は S0 まで。時間は T1 まで |

表示の高さ（CSS の画素 × `devicePixelRatio`）から空間の層を決める。

| 表示の高さ | 空間の層 |
| --- | --- |
| 200 未満 | S0（180p） |
| 200〜400 | S1（360p） |
| 400 以上 | S2（720p） |

Media Node が決めるもの：

- 下りの推定の中で、`priority` の高い順に、上限の層までを割り当てる。足りなければ、低い優先度の consumer から層を下げる。最も低い層も載らなければ、その consumer を止める（`paused` と同じ扱いで、受け手にはアバターを出させる）。
- 層の上げ下げの規則：
  - **下げ**：推定が今の割り当ての合計を下回ったら、すぐに下げる。まず時間の層を下げ、次に空間の層を下げる（時間の層の変更はキーフレームが要らない）。
  - **上げ**：推定が、1 つ上の層に要るビットレートの 1.2 倍を 3 秒続けて超えたら、1 段だけ上げる。上げた後 10 秒は、同じ consumer をもう一度上げない。
  - 上げる前に、mediasoup の probation のパケットで帯域を試す。
- 目標（NFR-009）：下りが半分になったら、5 秒以内に層を落として収まり、1 秒以上の映像の停止を起こさない。
- mediasoup の `priority` は 1〜255 で、推定が足りないときだけ効き、映像の consumer の間で配分を決める（[mediasoup の API](https://mediasoup.org/documentation/v3/mediasoup/api/)、2026-09-27 に確認）。配分は worker の `Transport::DistributeAvailableOutgoingBitrate` で、最初の周回は優先度の高い順に 1 層ずつ、次の周回からは 1 周に consumer ごとに `priority` の数まで層を上げる、重み付きの周回である（[Transport.cpp](https://github.com/versatica/mediasoup/blob/v3/worker/src/RTC/Transport.cpp)、2026-09-27 に確認）。「高い順に満たす」ではない。そこで、上の上げ下げの規則（1.2 倍、3 秒、10 秒）と優先度の順は、Media Node の制御（TypeScript）から `preferredLayers` と `priority` を動かして近づける。足りなければ worker に手を入れる。E4 の `downlink-allocation` で決める。

### 6.4 音声の枠

- 音声は映像より先に割り当てる。音声の枠は、送っている音声の本数 ×（1 本の実際のビットレート）で、推定から先に引く。
  - mediasoup は音声の consumer を割り当てに入れない（`Consumer::GetBitratePriority` が音声で 0 を返す。[Consumer.cpp](https://github.com/versatica/mediasoup/blob/v3/worker/src/RTC/Consumer.cpp)、2026-09-27 に確認）。そのままでは映像が推定の全部を使いうる。音声の分を残す方法（`transport.setMaxOutgoingBitrate` を推定から音声の分を引いた値に動かすか、worker に手を入れるか）は**未検証**で、E4 の `downlink-allocation` で決める。
- RED の冗長の数は、受け手ごとに次で決める。

| 受け手の下りの推定 | RED | 送る音声の本数（話者） |
| --- | --- | --- |
| 250 kbps 以上 | 残す（distance 1） | 3 |
| 150〜250 kbps | 剥がす（Opus だけ） | 3 |
| 150 kbps 未満 | 剥がす | 2 |

- 150 kbps の下りで、音声 2 本（約 56 kbps × 2）と RTCP を載せ、残りで最も低い映像の層（S0・T0、約 50 kbps）を 1 本だけ送る。載らなければ映像を止める。これで NFR-009 の「下り 150 kbps でも音声は続く」を満たす見込み（**未検証**。E4 の `downlink-allocation` で、帯域の低下の条件 `bw-step-down` で確かめる）。

### 6.5 映像の損失への備え

- 映像は NACK と RTX で直す。Media Node は、受けたパケットを再送の貯め（mediasoup の既定）に持ち、受け手の NACK に自分で応える。
- 映像の FEC（ULPFEC、FlexFEC）は使わない。mediasoup が対応せず、損失の率の高い回線では、FEC の追加の帯域が GCC の推定をさらに下げるため。
- 直せない損失は、受け手のブラウザが PLI を送り、Media Node が送り手へ中継する（頻度の制限は [media-server-sfu.md](media-server-sfu.md)）。

## 7. 画面共有（ADR-0020）

### 7.1 設定

| 項目 | 値 |
| --- | --- |
| 取り込み | `getDisplayMedia`。画面・ウィンドウ・タブ。タブの共有では音声も選べる |
| `contentHint` | `detail`（既定）。利用者が「動画を共有」を選んだら `motion` |
| `degradationPreference` | `detail` のとき `maintain-resolution`。`motion` のとき `balanced` |
| 解像度 | 取り込みの解像度のまま。上限 1920×1080（超えたら縦横の比を保って縮める） |
| fps | `detail`：最大 5 fps。`motion`：最大 15 fps |
| 符号器 | `svc` の会議は VP9 `L1T3`。それ以外は VP8 `L1T3`。iOS・iPadOS の Safari は H.264 `L1T1` |
| `maxBitrate` | `detail`：1,500 kbps。`motion`：2,500 kbps |
| 層 | 時間の層だけ。simulcast と空間の層は使わない（ADR-0002） |

- 画面共有の文字を読めることを優先する。帯域が足りない受け手には、解像度を落とさず、フレームの数を落とす（時間の層を剥がす）。
- 時間の層を T0 まで剥がしても載らない受け手（下り 300 kbps 未満の見込み）には、画面共有を止め、「回線が細いため共有を一時的に止めています」と出す。止まっている間も、最後の画面は受け手の端末に残す。
- 共有の音声（タブの音声）は、Opus のステレオ 64 kbps、DTX なし、FEC あり、RED なし。

### 7.2 送り手の順序

1. 共有の許可（[signaling-and-meetings.md](signaling-and-meetings.md) の 9 節）を Actor から得る。
2. `getDisplayMedia` の後、トラックに `contentHint` を設定してから、`produce` する（Content Hints の仕様では、`contentHint` が空のときの既定の劣化のさせ方は実装に任されている。設定の前に符号化を始めると、最初のフレームが粗くなる恐れがある。**未検証**で、E5 の `screen-share-detail` で確かめる）。
3. Media Node は、画面共有の consumer を受け手ごとに `priority: 255` で作る。

## 8. 損失 20% の回線での振る舞い（NFR-003）

| 起きていること | 音声 | 映像 |
| --- | --- | --- |
| 送り手の上りで 20% の損失 | FEC と RED で、Media Node に届く前の損失を直す。Media Node は RED のまま受け手へ転送する | 送り手の GCC の損失に基づく推定が、損失 10% 超で下がり続ける。ブラウザは上の本を止め、`q`（180p）だけになる見込み。NACK と RTX で直す。直せないフレームは受け手が PLI を送る |
| 受け手の下りで 20% の損失 | 送り手の RED・FEC がそのまま効く。Media Node は下りの推定に合わせて RED を残すか剥がすかを決める（6.4 節）。受け手の NetEQ が残りを隠す | Media Node の推定が下がり、その受け手への層を下げる。止まった consumer はアバターを出す |
| 他の参加者 | 影響しない（受け手ごとに層を選ぶ） | 影響しない |

- 目標：損失 20%・揺らぎ 30ms で、音声の ViSQOL の MOS 3.0 以上（NFR-003）。損失 5% で MOS 3.8 以上。
- GCC の損失に基づく制御は、損失が 10% を超える間、推定を下げ続ける（3 節）。ブラウザの実装（libwebrtc の損失に基づく推定の新しい版）が草案と違う振る舞いをするかは**未検証**。損失 20% の間、映像が最も低い層にも載らなくなるかを E4 の `loss-20-audio` で測る。
- 映像は、損失 20% の間は「最も低い層で途切れがち」か「止めてアバター」になる。どちらも許し、音声を守ることを優先する。

## 9. 失敗のしかた

| 失敗 | 起きること | 対処 |
| --- | --- | --- |
| 受け手のブラウザが RED に対応しない | RED を受けられない | Media Node が剥がして Opus で送る（4.3 節） |
| Media Node の RED の剥がしの不具合 | 受け手の音声が途切れる、雑音が出る | フラグ `media.red` で RED を止め、FEC だけに戻す。runbooks の `audio-quality-degradation.md` |
| `svc` の会議に非対応の人が入った | 映像を受けられない人が出る | Actor がモードを `simulcast` に変え、送り手が符号器を切り替える。切り替えの間（キーフレームまで）映像が一瞬止まる |
| 送り手の端末が符号化に追いつかない（CPU） | ブラウザが解像度か fps を落とす（`qualityLimitationReason: "cpu"`） | 送り手は `f` の本を止める。10 秒続けば `h` も止める。仮想背景を切るよう勧める（[clients.md](clients.md)） |
| 推定の誤り（上げすぎ） | 遅れが伸び、損失が出る | GCC の遅れに基づく制御で下がる。上げの規則（6.3 節）の 10 秒の待ちで行き来を抑える |
| キーフレームの要求が集中する | 送り手の送出が一時的に 2〜3 倍になる | PLI の集約と頻度の制限（[media-server-sfu.md](media-server-sfu.md)） |
| 新しいブラウザの版で符号器の振る舞いが変わる | 品質の回帰 | Beta・Dev の版での夜間の試験（10 節）。runbooks の `browser-release-regression.md` |

## 10. セキュリティ

- 品質の診断に使うのは、`getStats` と RTCP の数値だけにする。音声・映像のフレームを試験の外で保存しない（本題材の AGENTS.md）。
- RED の剥がしと DD の読み取りは、ペイロードの中身を読まない。RED のブロックの境界（ヘッダー）だけを読む。
- ヘッダー拡張の URI は標準のものだけを使う。独自の拡張が要るときは `urn:<brand>:...` の形にする（リポジトリ共通の [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。
- 音量のヘッダー拡張は、ホップごとの暗号化（SRTP）の中にあるが、Media Node には見える。E2EE の会議でも平文になり、誰が話しているかはサーバーに分かる（[e2ee.md](e2ee.md) の 11 節）。
- 送り手の申告（`maxBitrate`、層の数）は信用しない。Media Node は `setMaxIncomingBitrate` で上りを制限し、超えた分は捨てる。

## 11. テスト

### 11.1 ネットワークの劣化の試験

本題材の AGENTS.md の条件を、送り手の上りと受け手の下りの両方に掛ける。Linux の `tc netem` と `tbf`、Playwright で実際のブラウザを動かす。

| 名前 | 条件 | 合格の目安 |
| --- | --- | --- |
| `loss-5-random` | ランダム 5%、揺らぎ 30ms | 音声 MOS 3.8 以上 |
| `loss-20-random` | ランダム 20%、揺らぎ 30ms | 音声 MOS 3.0 以上（NFR-003） |
| `loss-20-burst` | Gilbert-Elliott（平均のバースト 3 パケット、平均 20%） | 音声 MOS 2.6 以上（[quality.md](../quality.md) の 2.2.1 節の既定。E4 で見直す） |
| `jitter-100` | 揺らぎ 100ms | mouth-to-ear の p95 を記録する |
| `bw-step-down` | 下り 3 Mbps → 500 kbps → 150 kbps → 3 Mbps（各 30 秒） | 5 秒以内に収まる。1 秒以上のフリーズ 0。150 kbps で音声が続く（NFR-009） |
| `bw-half` | 下り 2 Mbps → 1 Mbps | 5 秒以内に収まる。1 秒以上のフリーズ 0 |
| `rtt-200` | RTT 200ms | glass-to-glass を記録する |
| `uplink-20` | 送り手の上りだけ 20% | 他の参加者の受ける層が変わらない（送り手の層だけが下がる） |
| `mixed-3` | 3 人の会議で 1 人の下りだけ 500 kbps | その人だけ低い層。他の 2 人の層は変わらない（ADR-0002 の Confirmation） |

### 11.2 品質の指標

| 指標 | 測り方 |
| --- | --- |
| 音声の MOS の推定 | 送り手に基準の音声（利用の条件が明らかな公開のデータセット。例：LibriSpeech、CC BY 4.0）を偽のマイクで入れ、受け手の出力を録って ViSQOL v3 の speech モードで比べる（[google/visqol](https://github.com/google/visqol)、Apache 2.0）。基準の音声に実在の人の会議の声は使わない |
| 音声の隠し | `getStats` の `inbound-rtp`（音声）の `concealedSamples / totalSamplesReceived`、`concealmentEvents` |
| 映像のフリーズ | `inbound-rtp`（映像）の `freezeCount`、`totalFreezesDuration`。フリーズの率＝1 分あたりの `freezeCount`。1 秒以上のフリーズは、フレームの時刻の記録から数える（[webrtc-stats](https://www.w3.org/TR/webrtc-stats/)） |
| 受けた解像度と fps | `inbound-rtp` の `frameHeight`、`framesPerSecond`、`framesDecoded` |
| 帯域の追従の時間 | 帯域を変えた時刻から、`bytesReceived` の 1 秒ごとの率が新しい帯域の 90% 以内に収まるまで |
| glass-to-glass | 時刻を埋め込んだ映像を送り、受け手の画面を撮って読み取る。E2EE の会議でも同じ方法で測れる |
| 送り手の品質の制限 | `outbound-rtp` の `qualityLimitationReason`、`qualityLimitationDurations` |

### 11.3 実装をまたぐ試験

- **RED**：RFC 2198 の形の RED のパケットの列（主＋冗長 2、長さ・時刻の差の境界の値、壊れたヘッダー）を固定の試験のベクトルにし、Media Node の剥がしの出力（Opus のパケットの列）と突き合わせる。Chrome が送る実際の RED のパケットを録ったものも加える。
- **層の選択**：推定の時系列と consumer の集合を入力にし、6.3 節の規則の期待する層を出力にした表駆動の試験。Media Node の制御（TypeScript）と、mediasoup の worker の実際の選択を比べる。
- **ブラウザの組み合わせ**：送り手 × 受け手の 4 × 4（Chrome、Edge、Firefox、Safari）で、`simulcast` と `svc` の各モード、モードの切り替え。Beta の版は夜間に回す。

### 11.4 性質ベーステスト

- **PROP-BWE-001**：任意の推定の時系列で、割り当てた層の合計のビットレートが推定を超えない（音声の枠を除く）。
- **PROP-BWE-002**：任意の時系列で、同じ consumer の層を上げる間隔が 10 秒を下回らない。
- **PROP-BWE-003**：任意の時系列で、音声の consumer が映像の consumer より先に止まることはない。
- **PROP-RED-001**：任意の RED のパケットを剥がした結果は、主の符号と同じバイト列で、RTP の時刻と連番を変えない。

## 12. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E1 | `netem-harness` | 11.1 節の条件を CI で回す基盤（Playwright、偽のカメラ・マイク、netem） |
| E1 | `media-quality-metrics` | 11.2 節の指標を試験の結果として PR に載せる |
| E2 | `audio-opus-baseline` | 4.1 節の設定。DTX、FEC、20ms、32 kbps |
| E2 | `video-simulcast-vp8` | 5.2 節の 3 本。H.264 の送り手 |
| E4 | `red-forwarding` | 4.3 節。mediasoup の RED の転送と剥がし。上流への提案 |
| E4 | `downlink-allocation` | 6.3・6.4 節。優先度、上限の層、上げ下げの規則 |
| E4 | `unused-layer-pause` | 5.2 節の使われない層を止める |
| E4 | `loss-20-audio` | 8 節。損失 20% で NFR-003 を満たすことの確認と調整 |
| E4 | `svc-vp9-mode` | 5.1・5.3 節。モードの決定と切り替え |
| E4 | `av1-evaluation` | AV1 の CPU、品質、mediasoup の DD の問題の確認。S2 で既定にするかを決める材料 |
| E5 | `screen-share-detail` | 7 節。`contentHint`、5 fps、時間の層 |
| E5 | `screen-share-motion` | 7 節の `motion` と、タブの音声 |
| E7 | `bwe-load-test` | 100 人の会議で、Media Node の推定と割り当ての CPU |

Epic の番号は [architecture/README.md](README.md) の 7 節の割り当てに従う。Epic の名前は [roadmap.md](../roadmap.md) で決まる。

## 13. 未解決の問い

### 決定

2026-09-27 に推奨案で確定した（[README.md](README.md) の 6 節の「決定（2026-09-27、推奨案で確定）」）。

- **RED**：mediasoup に RED の転送と剥がしを足す（ADR-0017）。上流に取り込まれなければフォークで持つ。ブラウザは distance 1 で送るので、Media Node は受け手ごとに残すか剥がすかだけを決める（2026-09-27 に libwebrtc の実装で確かめて直した）。
- **カメラの既定**：VP8 の simulcast 3 本。SVC は全員 Chromium の会議だけ（ADR-0018）。
- **AV1**：S1 はフラグの裏（ADR-0018）。
- **映像の FEC**：使わない（ADR-0019）。
- **層を上げる規則**：1.2 倍を 3 秒、上げた後 10 秒待つ（ADR-0019）。
- **画面共有**：最大 1920×1080、`detail` は 5 fps、`motion` は 15 fps（ADR-0020）。
- **E2EE の会議の RED**：確かめるまで使わない（4.3 節）。
- **1:1 の会議の解像度**：MVP では 720p までにする。1080p は帯域の費用（intent.md の K8）が重いので、MVP の後に回す（[roadmap.md](../roadmap.md) の延期の一覧）。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| RED distance 1 の実際の費用と、FEC と組んだときの MOS への効果（冗長に何が入るかは libwebrtc の実装で確かめた） | E4 の `red-forwarding` で、FEC だけ・RED distance 1 ＋ FEC を ViSQOL で比べる |
| Firefox・Safari の RED、DD、SVC、Safari の VP9・AV1 の対応 | E2 の `browser-capability-probe` と、各ブラウザの新しい版ごとに確かめて、3 節と [clients.md](clients.md) の表を更新する |
| 損失 20% での GCC の損失に基づく制御の実際の振る舞い | E4 の `loss-20-audio` で、推定の時系列を記録する |
| VP9 の SVC と simulcast の上りの差（ADR-0002 の「3〜4 割」） | E4 の `svc-vp9-mode` で計測する |
| AV1 を既定にする時期 | mediasoup の #1625 の解決と、Firefox の SVC の復号の対応を待つ。S2 の前に判断する |

## 14. quality.md・runbooks・data-model への項目

### quality.md

- 11.1 節の試験の条件と合格の目安。`loss-20-burst` の閾値は ViSQOL の MOS 2.6 以上（QA が承認した値）。
- 11.2 節の指標の定義（MOS の推定の道具、フリーズの定義、追従の時間の測り方）と、PR に載せる形。
- ブラウザの組み合わせ（送り手 × 受け手）の試験の範囲と、Beta の版の夜間の試験。
- RED の剥がしの試験のベクトル（11.3 節）。
- 性質ベーステスト PROP-BWE-001〜003、PROP-RED-001。

### runbooks

- `audio-quality-degradation.md`：音声の MOS の推定や隠しの率が落ちたときの切り分け（送り手の上り、Media Node、受け手の下り）と、`media.red` のフラグで RED を止める手順。
- `video-freeze-spike.md`：フリーズの率が上がったときの切り分け（PLI の集中、推定の誤り、送り手の CPU）。
- `browser-release-regression.md`：ブラウザの新しい版で符号器や推定の振る舞いが変わったときの確かめ方と、モード（`svc` を止める、AV1 を止める）の切り替え。

### data-model（索引への追加の提案）

確定した形は [data-model/meeting-runtime.md](data-model/meeting-runtime.md) と [data-model/stores.md](data-model/stores.md) の 4・7 節 にある。

| 置き場所 | 中身 |
| --- | --- |
| Meeting Actor の状態（スナップショット） | `video_mode`（`simulcast`・`svc`・`av1-svc`）、`video_mode_locked`（その開催で `svc` に戻さない） |
| Aurora `meeting_participations`（signaling-and-meetings.md の提案に列を足す。clients の提案と重なる列は 1 つにまとめた。[data-model/meeting-runtime.md](data-model/meeting-runtime.md)） | `video_codec`（送った符号器）。`client_kind`・`browser`・`browser_version` は clients の提案と同じ列 |
| 品質の時系列（observability.md で決める置き場所） | 参加者ごと 10 秒ごとの `getStats` の要約：損失、揺らぎ、RTT、受けた層、フリーズ、隠しの率、推定のビットレート。会議の内容は含めない |
| 設定（フラグ） | `media.red`、`media.av1`、`media.svc` |

## 参考

- [RFC 6716](https://www.rfc-editor.org/rfc/rfc6716)、[RFC 7587](https://www.rfc-editor.org/rfc/rfc7587)、[RFC 2198](https://www.rfc-editor.org/rfc/rfc2198)、[RFC 8627](https://www.rfc-editor.org/rfc/rfc8627)
- [WebRTC-SVC](https://www.w3.org/TR/webrtc-svc/)、[MediaStreamTrack Content Hints](https://www.w3.org/TR/mst-content-hint/)、[webrtc-stats](https://www.w3.org/TR/webrtc-stats/)
- [draft-ietf-rmcat-gcc-02](https://datatracker.ietf.org/doc/html/draft-ietf-rmcat-gcc-02)、[draft-holmer-rmcat-transport-wide-cc-extensions-01](https://datatracker.ietf.org/doc/html/draft-holmer-rmcat-transport-wide-cc-extensions-01)
- [mediasoup の RTP Parameters and Capabilities](https://mediasoup.org/documentation/v3/mediasoup/rtp-parameters-and-capabilities/)、[mediasoup の CHANGELOG](https://github.com/versatica/mediasoup/blob/v3/CHANGELOG.md)
- [MDN の WebRTC の符号器](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/WebRTC_codecs)
- [RED: Improving Audio Quality with Redundancy](https://webrtchacks.com/red-improving-audio-quality-with-redundancy/)

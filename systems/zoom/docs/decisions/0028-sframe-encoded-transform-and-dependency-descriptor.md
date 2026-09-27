---
status: accepted
date: 2026-09-27
---

# ADR-0028: SFrame はフレームごとに AES-128-GCM で暗号化し、Web では RTCRtpScriptTransform の中で動かす。Media Node は Dependency Descriptor で層を選ぶ

## Context

[ADR-0004](0004-encryption-and-e2ee.md) は、E2EE の会議のメディアを SFrame で暗号化し、鍵を MLS から導くと決めた。そのとき、SFU が SVC の層を判断するヘッダー拡張（Dependency Descriptor など）を平文で送る必要があり、mediasoup の対応はそのとき確かめていなかった。SFrame の形、ブラウザでの暗号化の場所、Media Node の層の選び方を決める必要がある。

調べて分かったこと（いずれも 2026-09-27 に確認）。

- SFrame は 5 つの暗号の組を持つ。`AES_128_GCM_SHA256_128`（`0x0004`）はタグ 16 バイト（[RFC 9605](https://www.rfc-editor.org/rfc/rfc9605)）。
- MLS と組むときは、`base_key = MLS-Exporter("SFrame 1.0 Base Key", "", AEAD.Nk)`、`KID = (context << (S + E)) + (sender_index << E) + (epoch % (1 << E))`（RFC 9605 の 5.2 節）。
- simulcast の層は別々に暗号化し、一意の CTR を使う。SVC は層ごとに別の暗号文にしなければならない。新しい鍵の後にキーフレームを送ると、新しい参加者の表示が早い（RFC 9605 の 6.1〜6.2 節）。
- `RTCRtpScriptTransform` は Chrome・Edge 141、Firefox 117、Safari 15.4 から（[caniuse](https://caniuse.com/mdn-api_rtcrtpscripttransform)）。組み込みの `SFrameTransform` は仕様にあるが、browser-compat-data（v8.1.3）はどのブラウザの対応も「不明」と記録している（[WebRTC Encoded Transform](https://www.w3.org/TR/webrtc-encoded-transform/)、[Mozilla の bug 1715625](https://bugzilla.mozilla.org/show_bug.cgi?id=1715625)）。
- mediasoup は、DD を `recvonly` で扱い、AV1 でだけ使う。VP8 のキーフレームはペイロードの先頭で判定する（[supportedRtpCapabilities.ts](https://github.com/versatica/mediasoup/blob/v3/node/src/supportedRtpCapabilities.ts)、[CHANGELOG](https://github.com/versatica/mediasoup/blob/v3/CHANGELOG.md)）。SFrame はフレーム全体を暗号化するので、E2EE の会議ではこの判定ができない。
- Chrome と Firefox 136 以降は DD を送る（[MDN の WebRTC の符号器](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/WebRTC_codecs)）。Safari は MDN に記載がなく**未検証**（E9 の `e2ee-poc-transform` で確かめる）。
- RFC 9605 は、SFU が層を落とせるように、送り手は SVC の層ごとに別の SFrame の暗号文にしなければならない（MUST）とする（6.1.3 節）。

## Options

1. **フレームごと、`0x0004`、`RTCRtpScriptTransform` の中で Rust の SFrame（WASM）。Media Node は DD とヘッダーで層を選び、mediasoup に VP8・VP9 の DD の判断を足す**
2. **パケットごとの SFrame**
3. **ブラウザの組み込みの `SFrameTransform` を使う**
4. **VP8 のフレームのヘッダーを平文で残し、mediasoup を変えない**

## Decision

1 を採用する。

- SFrame はフレームごと。暗号の組は `AES_128_GCM_SHA256_128`（`0x0004`）。基の鍵は `MLS-Exporter("SFrame 1.0 Base Key", "", 16)`。
- KID は RFC 9605 の MLS の形で、E=4（16 エポックの窓）、S=10（leaf の番号 1,024 まで）。context は送り方（音声 0、カメラ 1、画面共有 2、共有の音声 3）× 4 ＋ simulcast の層の番号。CTR は KID ごとに 0 から。
- 鍵の切り替えは、MLS のコミットをマージした次のフレームから。受け手は直近 2 エポックの鍵を持つ。参加の後は、新しい鍵でキーフレームを 1 回作る。
- Web は、`e2ee` のワーカーで `RTCRtpScriptTransform` を使い、Rust の共通のコアの SFrame（WASM）で暗号化・復号する。鍵はワーカーの外に出さない。ネイティブは libwebrtc の `FrameTransformerInterface` から同じコアを呼ぶ。
- Media Node はペイロードを読まない。`mid`・`rid`・SSRC・DD・音量のヘッダー拡張・transport-cc で転送を判断する。
  - E2EE の会議では、全員に DD を送らせる（2 バイトのヘッダー拡張の交渉を含む）。
  - mediasoup の worker に、VP8・VP9 でも DD からキーフレームと層を判断する処理を足す。上流に提案し、取り込まれるまではフォークで持つ。
  - DD を送れない送り手は、simulcast をやめて 1 本だけ送る。
  - DD と他の転送に要るヘッダー拡張は、ヘッダー拡張の暗号化（cryptex など）に含めない。
- E2EE の会議の映像のモードは、E9 の PoC で SVC の層ごとのフレームの扱いを確かめるまで `simulcast` だけにする。
- 2 は、パケットごとの費用（MTU 1,200 バイトで映像に約 1.8%、RFC 9605）が大きく、ブラウザの Encoded Transform の単位（フレーム）とも合わない。
- 3 は、Chrome が出荷しておらず、ブラウザごとに鍵の渡し方が変わる。
- 4 は、mediasoup を変えずに済むが、RFC 9605 の外の扱いになり、ヘッダーの情報が漏れる。受け手の depacketizer が暗号文を読んで失敗すると PoC で分かったときの退路にし、そのときはこの ADR を改める。

## Consequences

- 良くなること：
  - 標準の SFrame の形で、Web とネイティブの暗号の実装が 1 つになる。
  - E2EE の会議でも、Media Node が受け手ごとに層を選べる。
- 引き受けるコスト：
  - mediasoup の worker に、RED（[ADR-0017](0017-opus-dtx-fec-red.md)）に加えて DD の判断を足し、フォークを保つ。
  - DD を送れないブラウザの参加者は、E2EE の会議で 1 本（360p）しか送れない。
  - 誰が話しているか（音量）と、層の構成は、サーバーに見える。

## Confirmation

- 試験のベクトル：RFC 9605 の付録 C のベクトルを、`core-e2ee` の SFrame が通す。KID の計算を Web とネイティブで同じ結果にする。
- 性質ベーステスト：任意の送り方と層の組み合わせで、同じ鍵と CTR の組が 2 回使われない（PROP-E2EE-005）。
- 結合試験：E2EE の会議で Media Node が受けたペイロードを保存し、サーバーのどの鍵でも復号できないことを確かめる。
- ブラウザの組み合わせの試験：E2EE の会議で、下りを 500 kbps に絞った受け手が低い層を受け、他の人の層は変わらない。

---
status: accepted
date: 2026-09-27
---

# ADR-0013: Media Node の障害は心拍とクライアントの途絶の報告で判定し、予備の Node へ新しい transport でつなぎ直し、音声を先に戻す

## Context

1 台のメディアサーバーが落ちても会議は終わらず、数秒で音声が戻ることが求められる（[intent.md](../intent.md) の守るべき振る舞い、NFR-004：5 秒以内）。[ADR-0005](0005-meeting-state-and-signaling.md) は、Actor が別の Node を求め、参加者に ICE restart と新しい Node への接続を指示すると決めた。

- ICE の同意の確認（consent freshness）は、30 秒で同意が切れる（[RFC 7675](https://www.rfc-editor.org/rfc/rfc7675)、2026-09-27 に確認）。mediasoup の `iceConsentTimeout` の既定も 30 秒（[API](https://mediasoup.org/documentation/v3/mediasoup/api/)、2026-09-27 に確認）。これを待つと 5 秒に入らない。
- ICE restart は、同じ相手（同じ Node の同じ transport）との経路を選び直す仕組みである（[RFC 8445](https://www.rfc-editor.org/rfc/rfc8445)、2026-09-27 に確認）。別の Node には、新しい transport（ICE と DTLS）が要る。
- ICE Lite の Node は、公開の IP を持つので、クライアントから直接の UDP なら ICE と DTLS は数往復で終わる。
- Node の心拍だけで判定すると、Node と制御の側の間の分断を、Node の障害と取り違える。

## Options

検知：

1. **Node の心拍（500ms、3 回の欠落）と、クライアントの受信の途絶の報告（1.5 秒）の組み合わせ**
2. **Node の心拍だけ**
3. **ICE の同意の切れ（30 秒）を待つ**

付け替え：

- a. **会議の開始時に予備の Node を決めておき、新しい transport を作り直させる。音声を先に**
- b. **障害のときに Assignment Service に選ばせる**
- c. **会議ごとに 2 台の Node へ常に二重に送る（ホットスタンバイ）**

## Decision

1 と a を採用する。詳細は [media-server-sfu.md](../architecture/media-server-sfu.md) の 9 節。

- 検知：心拍の 3 回の欠落（1.5 秒）か、同じ Node の参加者 2 人以上（2 人以下の会議では全員）の `media.stall`（recv の transport で RTP も RTCP も 1.5 秒受けていない）で、Node の障害とみなす。1 人だけの途絶は、その人の回線の問題として ICE restart にする。
- 付け替え：Actor は `media_generation` を上げ、予備の Node に router を作り、`media.reattach` を配る。クライアントは古い transport を閉じ、新しい transport を作り、音声の produce と consume を先に、映像を後に行う。
- router の `mediaCodecs` を全 Node で同じにし、クライアントの `Device.load` をやり直さない。
- worker だけの異常終了は、その worker の参加者だけを同じ Node の別の worker へ付け替える。
- 計画した入れ替えは、古い transport を残したまま新しい transport を作る（make-before-break）。
- 予算は、検知 2 秒、判断 0.2 秒、配信 0.1 秒、transport と ICE・DTLS 0.8 秒、音声の produce・consume 0.4 秒、ジッタバッファ 0.2 秒、余裕 1.3 秒。
- 2 を採らない理由：Node と制御の側の分断を、Node の障害と取り違え、不要な付け替えで全員の音声を途切れさせる。
- 3 を採らない理由：5 秒に入らない。
- b を採らない理由：障害の時に、多くの会議の Actor が一斉に Assignment Service を呼び、選ぶ処理と同じ台への集中が起きる。予備は、Assignment Service が落ちていても使える。
- c を採らない理由：転送の費用と Node の負荷が 2 倍になる。

## Consequences

- 良くなること：
  - Node の障害から、音声が約 3 秒で戻る見込み。
  - Assignment Service の障害と、Node の障害が重なっても付け替えられる。
- 引き受けるコスト：
  - クライアントの途絶の報告は、改造したクライアントに悪用されうる。1 人の報告では付け替えない。
  - 同じ Node の会議がすべて同じ予備の Node へ移ると、予備が溢れる。予備は会議ごとに無作為に選び、偏りを抑える。予備の点が 0.95 を超えていれば選び直す。
  - TURN を通る参加者は、TURN の割り当ての作り直しで 5 秒を超えうる（**未検証**）。

## Confirmation

- 障害の注入の試験：Media Node のインスタンスを止め、全参加者の音声が 5 秒以内に戻る（p95）。
- 障害の注入の試験：Node と Assignment Service の間だけを分断しても、付け替えが起きない。
- 障害の注入の試験：worker の `SIGKILL` で、その worker の参加者だけが付け替わり、他の参加者の途切れが 0。

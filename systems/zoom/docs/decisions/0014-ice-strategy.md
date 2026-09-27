---
status: accepted
date: 2026-09-27
---

# ADR-0014: Media Node は ICE Lite で公開の host の候補（UDP と ICE-TCP）だけを出し、単独の STUN のサーバーを置かない

## Context

参加者の端末から Media Node までの経路を、家庭・モバイル・社内の網のどこからでも通す必要がある（intent.md の Problem）。参加の速さの目標は、直接の経路で p95 3 秒、TURN を通るときで p95 5 秒（NFR-002）。

確かめたこと（いずれも 2026-09-27 に確認）：

- ICE Lite は、常に公開のインターネットにつながり公開の IP を持つ実装のための簡単な形である（[RFC 8445](https://www.rfc-editor.org/rfc/rfc8445)）。mediasoup の WebRtcTransport は ICE Lite で、役は常に controlled（[mediasoup の Rust の文書](https://docs.rs/mediasoup/latest/mediasoup/webrtc_transport/struct.WebRtcTransport.html)）。
- mediasoup は UDP と TCP の ICE、IPv6 に対応し、`announcedAddress` で NAT の外側のアドレスを候補に出す。`exposeInternalIp` の既定は false（[API](https://mediasoup.org/documentation/v3/mediasoup/api/)、[設計](https://mediasoup.org/documentation/v3/mediasoup/design/)）。
- 相手が公開の IP を持つ ICE Lite なら、クライアントの NAT の外側のアドレスは、相手が受けた確認から peer-reflexive の候補として分かる。server-reflexive の候補（STUN）がなくても、直接の経路はつながる（RFC 8445 の候補の種類の定義による）。
- ブラウザの `iceTransportPolicy` は `"all"` と `"relay"`（[WebRTC 1.0](https://www.w3.org/TR/webrtc/)）。

## Options

1. **Media Node は ICE Lite で公開の host の候補だけ。STUN は TURN のサーバーが兼ね、単独では置かない**
2. **公開の STUN のサーバー（自前）を置き、クライアントに server-reflexive の候補を集めさせる**
3. **第三者の公開の STUN のサーバーを使う**
4. **Media Node をプライベート IP にし、すべて TURN を通す**

## Decision

1 を採用する。詳細は [network-traversal.md](../architecture/network-traversal.md) の 3〜6 節。

- Media Node の候補は、公開の IPv4（Elastic IP を `announcedAddress` に）と IPv6、それぞれ UDP と TCP（ICE-TCP、同じポート）。プライベート IP は出さない。
- クライアントには TURN の 2 台（別の AZ）を渡す。TURN のサーバーが STUN の要求にも答える。`stun:` の URL は渡さない。第三者の STUN は使わない。
- クライアントは既定で `iceTransportPolicy: "all"`。同じ網から前回 TURN の TLS でしかつながらなかった端末は、最初から `"relay"` にし、10 秒つながらなければ `"all"` に戻す。
- 網が変わったとき、または ICE の状態が `disconnected` で 2 秒戻らないときは、同じ Node のまま ICE restart する。Node が替わるときは、新しい transport を作る。
- 2 を採らない理由：ICE Lite の Node に対しては、server-reflexive の候補は peer-reflexive と同じ経路になり、得るものがない。STUN の台を別に運用することになる。
- 3 を採らない理由：利用者の IP を第三者に送ることになる。
- 4 を採らない理由：全員の経路が TURN の分だけ遅れ、TURN の台と転送の費用が大きくなる。

## Consequences

- 良くなること：
  - 大半の参加者が、直接の UDP で最短の経路を使う。
  - 運用する部品が、Media Node と TURN の 2 種類で済む。
- 引き受けるコスト：
  - Media Node が公開の IP を持つ。攻撃の面は、ICE の認証と DTLS で守る（[ADR-0001](0001-platform-and-stack.md)）。
  - 直接の経路の確認がすべて失敗するまでの待ちは、ブラウザの実装で決まり、こちらで短くできない見込み（待ちの長さは**未検証**。E2 の `network-path-matrix-tests` でブラウザごとに測る）。前回の経路の記憶で補う。
  - 前回の経路の記憶は、端末に網の指紋を保存する。

## Confirmation

- 結合テスト：網の条件ごと（制限なし、UDP を落とす、443 だけ、IPv6 だけ）に、期待する経路でつながり、参加から音声までが NFR-002 に入る。
- 結合テスト：Media Node の ICE の候補に、プライベート IP が含まれない。
- 結合テスト：クライアントの `RTCPeerConnection` の設定に、第三者の STUN の URL が含まれない。

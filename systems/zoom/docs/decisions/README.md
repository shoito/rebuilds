# Decisions: Zoom

Zoom の再構築に関する決定。リポジトリ共通の決定は [docs/decisions/](../../../../docs/decisions/README.md) にある。

<!-- adr-index:start -->
| ADR | 決定 | 状態 |
| --- | --- | --- |
| [0001](0001-platform-and-stack.md) | 制御の側は他の題材の基盤を引き継ぎ、メディアは EC2 の上の mediasoup で中継する | proposed |
| [0002](0002-media-topology.md) | 多人数は SFU で中継し、1:1 も SFU を通す。大きな会議は SFU をカスケードし、映像は simulcast と SVC で送る | proposed |
| [0003](0003-client-platform.md) | Web クライアントはブラウザの WebRTC を使い、ネイティブのアプリは共通のコア（Rust）と libwebrtc で作る | proposed |
| [0004](0004-encryption-and-e2ee.md) | 既定は DTLS-SRTP のホップごとの暗号化にし、選べる E2EE は SFrame と MLS で作る | proposed |
| [0005](0005-meeting-state-and-signaling.md) | 会議の状態は会議ごとに 1 つの Meeting Actor が持ち、WebSocket のシグナリングと、会議を Media Node に割り当てるサービスで動かす | proposed |
<!-- adr-index:end -->

この一覧は、各 ADR の frontmatter と見出しから生成したもの。ADR を追加・更新したら生成し直す。

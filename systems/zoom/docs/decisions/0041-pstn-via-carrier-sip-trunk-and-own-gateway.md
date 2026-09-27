---
status: accepted
date: 2026-09-27
---

# ADR-0041: 電話の網とは国内の事業者の SIP トランクでつなぎ、SIP の入口・IVR・会議の音声との橋を自前で持つ

## Context

電話からの参加（ダイヤルイン・ダイヤルアウト）は MVP の後の Epic で作る（[intent.md](../intent.md)）。電話番号の取得の条件、通信事業者との接続、緊急通報の扱いは、法務の確認待ち（L7）である。

確かめたこと（いずれも 2026-09-27 に確認）：

- 電気通信番号を使う事業者は、番号の種別ごとに電気通信番号使用計画の認定を受ける。自ら指定を受ける場合と、他の事業者から卸を受ける場合で手続きが分かれる（[電気通信番号を使用するための手続](https://www.soumu.go.jp/main_sosiki/joho_tsusin/top/tel_number/new_framework.html)）。
- Twilio は日本で 050 と Toll-Free の番号を扱い、規制の書類の審査が要る。日本の番号の再販者は番号使用計画の書類が要る（Twilio のヘルプの検索結果。本文は取得できず**未検証**。E14 の `carrier-selection-and-legal` で確かめる）。
- Amazon Chime SDK で日本の番号を取れるかは確かめていない（**未検証**。E14 の `carrier-selection-and-legal` で `ListSupportedPhoneNumberCountries` を呼んで確かめる）。
- 050 の IP 電話の総合品質は、R 値 50 超・平均の遅延 400ms 未満（[通信品質等の現行規定について](https://www.soumu.go.jp/main_content/000690836.pdf)、総務省）。

会議の側は、SFU（mediasoup）で、Opus の音声を扱う。Media Node は PlainTransport で WebRTC ではない RTP を受けられる。Recorder・Transcriber も同じ方式で会議の音声を受ける（[ADR-0025](0025-recording-per-track-capture-and-offline-compose.md)、[ADR-0026](0026-asr-engine-amazon-transcribe-with-adapter.md)）。

## Options

1. **国内の事業者の SIP トランク（番号は卸を受ける）＋自前の SIP の入口（Kamailio）・呼の制御と IVR（FreeSWITCH）・会議の音声との橋（Phone Bridge）**
2. **CPaaS の音声の流れ（電話の音声を WebSocket で受け渡す）に、会議の音声を渡す**
3. **自ら番号の指定を受け、事業者と相互接続する**
4. **Amazon Chime SDK の Voice Connector・SIP の機能を使う**

## Decision

1 を採用する。詳細は [telephony.md](../architecture/telephony.md) の 3 節。

- 事業者との間は TLS と SRTP か、閉じた網でつなぐ。SIP Edge（Kamailio）は事業者の IP だけを受け、呼の数を制限する。
- Call Controller（FreeSWITCH）が IVR、DTMF、G.711 の終端を行う。会議の状態は持たない。
- Phone Bridge が、電話の参加者 1 人を会議の参加者 1 人として動かす。制御は Web のクライアントと同じシグナリング（`client.kind = "phone"`）、メディアは Media Node の PlainTransport（SRTP、Opus）。下りは話者の絞り込みの最大 4 本を混ぜて 1 本にする。
- 会議の中の状態（ミュート、待合室、同意、ban）は Actor が決める。電話だけの特別な経路を作らない。
- 事業者の選定（国内の事業者か、CPaaS の SIP トランクか）は、電話の Epic の着手の前に、費用・TLS と SRTP の対応・番号の卸の条件で決める。この ADR は「SIP トランクで受け、ゲートウェイは自前」という形だけを決める。
- 2 を採らない理由：電話の音声が CPaaS の WebSocket を通って本システムに来る形になり、遅れが増える。会議の音声を CPaaS に渡す経路が増え、通信の秘密（L2）と委託の整理（L6）が重くなる。
- 3 を採らない理由：番号の指定と相互接続は、事業の規模と手続きが大きい。MVP の後の最初の段階には重すぎる。
- 4 を今は採らない理由：日本の番号を取れるか確かめられていない。確かめられれば、SIP トランクの相手の候補として比べる。

## Consequences

- 良くなること：
  - 電話の参加者が、Web の参加者と同じ会議の規則（待合室、同意、E2EE の禁止、ban）に従う。
  - 事業者を替えても、SIP Edge の設定だけで済む。
  - 会議の音声が、本システムと事業者の外に出ない。
- 引き受けるコスト：
  - SIP・IVR・音声の混ぜ方と符号の変換を、自分たちで運用する。
  - E14 は 1 つの事業者で始める（2026-09-27 に推奨案で決めた）。事業者の障害の間は、電話からの参加が止まる。2 つ目の接続は、電話の参加者の量を見て足す。
  - Phone Bridge の実装（混ぜ方、ジッタバッファ）を新しく作る必要がある。
  - 事業の手続き（登録・届出、番号使用計画）の結論によっては、事業者の選び方が変わる。

## Confirmation

- 結合試験：SIPp で着信し、DTMF で入室し、Web の参加者と音声が往復する。
- 性質ベーステスト：E2EE の会議に電話の参加者が入らない（PROP-TEL-001）。同意のない電話の参加者の音声が届かない（PROP-TEL-002）。
- レビュー：電話の参加者のために、Actor を通らない会議の状態の変更の経路を作っていない。
- 法務：電話の Epic の `spec.md` の承認の前に、L1・L7 の結論が記録されている。

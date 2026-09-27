# E2EE: Zoom

主催者が選べるエンドツーエンドの暗号化（E2EE）の設計。メディアは SFrame（RFC 9605）で、鍵は MLS（RFC 9420）で管理する。サーバー（Meeting Actor）は MLS の Delivery Service（DS）と Authentication Service（AS）を務めるが、鍵は持たない。ブラウザでの Encoded Transform、Media Node が復号せずに層を選ぶための Dependency Descriptor、会議のセキュリティのコード、退出から 2 秒以内の鍵の更新、E2EE で動かない機能と参加者の上限を決める。

前提として、次の決定に従う。

| 決定 | この領域への影響 |
| --- | --- |
| [ADR-0002](../decisions/0002-media-topology.md) | SFU は復号しないので、SFrame と両立する |
| [ADR-0003](../decisions/0003-client-platform.md) | Web は Encoded Transform。鍵管理は OpenMLS を WASM にして Web とネイティブで共有する |
| [ADR-0004](../decisions/0004-encryption-and-e2ee.md) | 既定は DTLS-SRTP。E2EE は会議ごとに選ぶ。SFrame と MLS。サーバーは DS、AS は本システム。退出から 2 秒以内に鍵を替える。E2EE の会議で録画・字幕・電話を動かさない。S1 の上限は 100 人 |
| [ADR-0005](../decisions/0005-meeting-state-and-signaling.md) | MLS のメッセージの順序は Meeting Actor が決める |
| [ADR-0008](../decisions/0008-signaling-protocol.md) | MLS のメッセージは、シグナリングの `cmd`・`evt` として運ぶ |
| [ADR-0017](../decisions/0017-opus-dtx-fec-red.md) | E2EE の会議では、確かめるまで RED を使わない |
| [ADR-0024](../decisions/0024-shared-rust-core-and-test-vectors.md) | 鍵管理は Rust の共通のコア（`core-e2ee`） |

この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0028](../decisions/0028-sframe-encoded-transform-and-dependency-descriptor.md) | SFrame はフレームごとに、`AES_128_GCM_SHA256_128` で暗号化する。Web は `RTCRtpScriptTransform` の中で Rust の SFrame（WASM）を使う。KID は RFC 9605 の MLS の形で E=4・S=10、送り方ごとに context を分ける。Media Node はペイロードを読まず、Dependency Descriptor とヘッダーで層とキーフレームを判断する |
| [0029](../decisions/0029-mls-delivery-and-authentication-service.md) | MLS の暗号の組は `0x0001`。Meeting Actor が DS としてエポックごとに最初のコミットだけを受ける。AS は参加のたびに会議の間だけ有効な X.509 の資格情報を発行する。参加は外部コミット、退出は Actor が外部の送り手として Remove を提案し、担当の参加者がコミットする。退出から新しい鍵での送信まで p95 1 秒、上限 2 秒 |
| [0030](../decisions/0030-security-code-and-e2ee-feature-limits.md) | 会議のセキュリティのコードは、MLS の `epoch_authenticator` から 40 桁の数字を作る。参加者の一覧は MLS の名簿から作り、シグナリングの一覧と食い違えば警告する。E2EE の会議で動かない機能を API・Actor・Media Node の 3 か所で拒む。参加者の上限は S1 で 100 人 |

## 1. 目的と範囲

- 扱う：E2EE の会議の鍵の流れ、SFrame の形、ブラウザとネイティブでの暗号化の場所、MLS のグループの作成・参加・退出・更新、DS と AS の役、会議のセキュリティのコード、Media Node が暗号文のまま層を選ぶ方法、E2EE で動かない機能、参加者の上限。
- 扱わない：既定の会議の DTLS-SRTP（[network-traversal.md](network-traversal.md) と security.md）、待合室・パスコード（[meeting-security.md](meeting-security.md)）、シグナリングの封筒の形（[signaling-and-meetings.md](signaling-and-meetings.md)）、Media Node の転送の実装（[media-server-sfu.md](media-server-sfu.md)）、捜査機関への対応（intent.md の L4。法務）。
- 関係する NFR：NFR-008（E2EE の保証）、NFR-001・NFR-002（E2EE でも遅れと参加の速さを保つ）。

## 2. 本家の形（確かめたこと）

いずれも 2026-09-27 に確認した。

- 本家の E2EE は、会議の参加者のうち 1 人（リーダー）が 32 バイトの会議の鍵を作り、他の参加者の公開鍵で暗号化して配る。参加者は鍵の種類ごとに HKDF で下位の鍵を導く。鍵の更新の合図を受けても、約 2 秒待ってから新しい鍵で暗号化する。退出の時の鍵の更新は、最大 10 秒遅れうる（[Zoom Cryptography Whitepaper](https://github.com/zoom/zoom-e2e-whitepaper) v4.7、2025-06-24、7.6.6 節）。
- 本家の「meeting leader security code」は、リーダーの公開鍵の SHA-256 から 39 桁の数字（約 129 ビット）を作る。リーダーが読み上げ、全員が自分の画面と比べる。リーダーが替わると、確かめ直しを促す（同 7.7 節）。
- 本家の E2EE の会議では、AI の機能、クラウド録画、会議の前後のチャット、ライブ配信、ライブの文字起こし、投票、アプリ、ホワイトボードなどが使えない。参加者は 1,000 人まで（[End-to-end encryption for meetings](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0065408)）。
- 本設計は、鍵の配布を標準の MLS に替える（ADR-0004）。リーダーが 1 人で鍵を配る形より、鍵の更新が速く（待ちの 2 秒と、退出の最大 10 秒の遅れを持たない）、前方秘匿性と侵害後の安全性を MLS の分析に頼れる。

## 3. 標準と実装の前提

いずれも 2026-09-27 に確認した。

| 項目 | 事実 | 出典 |
| --- | --- | --- |
| SFrame | フレームごと（またはパケットごと）に AEAD で暗号化する。ヘッダーは KID と CTR を可変長で持つ。暗号の組は 5 つ（`0x0001`〜`0x0005`）。`AES_128_GCM_SHA256_128`（`0x0004`）はタグ 16 バイト、鍵 16 バイト | [RFC 9605](https://www.rfc-editor.org/rfc/rfc9605) |
| SFrame と MLS | `base_key = MLS-Exporter("SFrame 1.0 Base Key", "", AEAD.Nk)`。`KID = (context << (S + E)) + (sender_index << E) + (epoch % (1 << E))`。E は並べ替えの窓（2^E エポック） | RFC 9605 の 5.2 節 |
| SFrame と SFU | simulcast の各層は別々に暗号化し、それぞれ一意の CTR を使う。SVC は層ごとに別の暗号文にしなければならない（MUST）。新しい鍵を使い始めた後にキーフレームを送ると、新しい参加者の表示が早い。SFrame は、悪意のある参加者のなりすましを防がない | RFC 9605 の 6.1〜6.2 節 |
| SFrame のメタデータ | フレームのメタデータは、SFU が見える場所（RTP のヘッダー拡張など）に出す。受け手は、復号で認証する前にメタデータを使ってはならない（復号の準備を除く） | RFC 9605 |
| MLS | DS はほぼ信頼しない、AS は信頼する前提。外部コミットで、KeyPackage なしに GroupInfo から参加できる。`MLS-Exporter(Label, Context, Length)`。必須の暗号の組は `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`（`0x0001`）。`epoch_authenticator` は帯域外の確認に使える。コミットの送り手は、自分のコミットが次に適用されると分かれば、戻りを待たずに進めてよい | [RFC 9420](https://www.rfc-editor.org/rfc/rfc9420.html) |
| OpenMLS | 0.9.0（2026-08-25）、MIT。`0x0001` などの 3 つの暗号の組。`js` の機能で WASM に対応。`MlsGroup` に `export_secret`、`epoch_authenticator`、`join_by_external_commit`、`remove_members`、`leave_group_via_self_remove`、`recover_fork_by_readding` がある。1.0 の前 | [openmls](https://github.com/openmls/openmls)、[docs.rs の MlsGroup](https://docs.rs/openmls/latest/openmls/group/struct.MlsGroup.html) |
| SFrame の Rust の実装 | `sframe` の crate 2.0.0（2026-09-13）。RFC 9605 の純粋な Rust の実装。成熟度と監査の有無は**未検証**（E9 の `core-e2ee-sframe` で、RFC 9605 の付録 C のベクトルを通し、依存の監査の記録を確かめる） | [crates.io の sframe](https://crates.io/crates/sframe)、[TobTheRock/sframe-rs](https://github.com/TobTheRock/sframe-rs) |
| Encoded Transform | `RTCRtpScriptTransform`（worker で符号化の後のフレームを変換する）、`SFrameTransform`、`generateKeyFrame(rid)`・`sendKeyFrameRequest()` を定める。2026-06-25 の Working Draft | [WebRTC Encoded Transform](https://www.w3.org/TR/webrtc-encoded-transform/) |
| `RTCRtpScriptTransform` の対応 | Chrome・Edge 141、Firefox 117、Safari 15.4、iOS の Safari 15.4、Android の Chrome 152 から。Baseline 2025 | [caniuse](https://caniuse.com/mdn-api_rtcrtpscripttransform)、[MDN](https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpScriptTransform) |
| `SFrameTransform` の対応 | browser-compat-data は、Chrome・Firefox・Safari のどれも対応を「不明」（null）と記録している。Firefox は `RTCRtpScriptTransform` を優先し、`SFrameTransform` は低い優先度とする。この設計は `SFrameTransform` を使わない（ADR-0028）ので、対応の有無に依らない | [Mozilla の bug 1715625](https://bugzilla.mozilla.org/show_bug.cgi?id=1715625)、browser-compat-data v8.1.3（2026-09-27 に確認） |
| Dependency Descriptor | Chrome と Firefox 136 以降が送る（Firefox は VP8・VP9・AV1。H.264 は 137 からでデスクトップだけ）。Safari は MDN に記載がなく**未検証**。VP8 の simulcast で DD を送るには、2 バイトのヘッダー拡張が要る（1 バイトの形の上限 16 バイトを超えるため）という二次の情報がある（**未検証**）。どちらも E9 の `e2ee-poc-transform` で確かめる | [MDN の WebRTC の符号器](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/WebRTC_codecs) |
| mediasoup と DD | DD の拡張は `recvonly`。AV1 でだけ DD を使う。VP8・VP9 はペイロードの記述子とペイロードの先頭から判断する | [supportedRtpCapabilities.ts](https://github.com/versatica/mediasoup/blob/v3/node/src/supportedRtpCapabilities.ts)、[CHANGELOG](https://github.com/versatica/mediasoup/blob/v3/CHANGELOG.md)、[#1625](https://github.com/versatica/mediasoup/issues/1625) |

## 4. 構成

```
参加者の端末
┌───────────────────────────────────────────────────────────────┐
│ main スレッド：UI、シグナリング（TypeScript）                  │
│   │ MLS のメッセージ（暗号文・公開の情報）だけを中継            │
│   ▼                                                           │
│ e2ee ワーカー：core-e2ee（WASM）                               │
│   OpenMLS（グループ、資格情報、鍵のスケジュール）             │
│   SFrame（送り方ごとの暗号化・復号）                          │
│   RTCRtpScriptTransform の変換（送る側・受ける側）            │
└───────────────────────────────────────────────────────────────┘
      │ WebSocket（MLS のメッセージ）          │ UDP（SRTP の中に SFrame）
      ▼                                        ▼
Signaling Gateway → Meeting Actor（DS）     Media Node
                    ・エポックごとに最初のコミットだけ受ける   ・ペイロード（SFrame）は読まない
                    ・GroupInfo を持つ（公開の情報）           ・RTP のヘッダーと拡張（mid、rid、
                    ・外部の送り手として Remove を提案           DD、音量、transport-cc）で転送
API（AS）
  ・参加のたびに、端末の公開鍵に会議の間だけ有効な証明書を出す
```

- MLS の秘密と SFrame の鍵は、`e2ee` のワーカー（ネイティブは共通のコア）の外に出さない。main スレッドは、暗号文と公開の情報だけを扱う。
- サーバーが持つのは、MLS の公開の情報（GroupInfo、ratchet tree、資格情報）と、暗号文だけ。

## 5. 資格情報と AS（ADR-0029）

- 参加のたびに、端末で Ed25519 の鍵の組を作る。会議の開催（`instance_id`）の間だけ使い、終われば捨てる。
- API の `POST /meetings/{id}/join` で、公開鍵を一緒に送る。API（AS）は、参加の許可（[signaling-and-meetings.md](signaling-and-meetings.md) の 4.3 節）と同時に、X.509 の証明書を出す。
  - 主体：`participant_id`、`instance_id`、`user_id`（ゲストは空と `guest` の印）、`org_id`、表示の名前の SHA-256。
  - 有効期限：会議の予定の終わり＋ 1 時間、最大 24 時間。
  - 発行者：AS の中間 CA。中間 CA の鍵は KMS で守る。根の証明書は、クライアントに同梱し、ずらして入れ替える（2 つを並べて持つ）。
- MLS の資格情報の型は `x509`。クライアントは、名簿の全員の証明書の連鎖を、同梱の根まで検証する。OpenMLS は資格情報を中を見ずに渡すだけで、組み込みの実装は `BasicCredential` だけである。`CredentialType::X509` の型はあり、`Credential::new(CredentialType::X509, …)` で証明書の連鎖を載せられる（[openmls の credentials](https://github.com/openmls/openmls/blob/main/openmls/src/credentials/mod.rs)、v0.9.0、2026-09-27 に確認）。証明書の連鎖の符号化と検証は `core-e2ee` に実装する（E9 の `e2ee-credentials-as`）。
- 同じ人が長く同じ鍵を使う形（端末に残る鍵と、その履歴の公開）は、S1 では作らない。AS のなりすましは、セキュリティのコードと名簿の表示で見つける前提にする（10 節、11 節）。

## 6. MLS のグループと DS（ADR-0029）

### 6.1 グループの設定

| 項目 | 値 |
| --- | --- |
| 暗号の組 | `0x0001`（X25519、AES-128-GCM、SHA-256、Ed25519） |
| `group_id` | 開催ごとに 16 バイトの乱数。会議の番号から作らない |
| 外部の送り手（`external_senders`） | Meeting Actor の Ed25519 の公開鍵（6.4 節） |
| 必須の能力 | `x509` の資格情報、外部の送り手 |
| ratchet tree | GroupInfo の拡張で配る |
| 過去のエポックの鍵 | 復号のために、直近 2 エポックまで持つ |

### 6.2 メッセージ

シグナリング（[signaling-and-meetings.md](signaling-and-meetings.md) の 6 節）に、次の `cmd`・`evt` を足す。中身は MLS の TLS 表現を base64url にしたもの。Actor は中身を解釈しない（エポックの番号と送り手だけを読む。公開の情報）。

| 名前 | 向き | 中身 |
| --- | --- | --- |
| `e2ee.create` | サーバー → 最初の参加者 | グループを作る指示。外部の送り手の公開鍵 |
| `e2ee.group_info` | サーバー → 参加する人 | 最新の GroupInfo |
| `e2ee.commit`（`cmd`） | 参加者 → サーバー | `{epoch, commit, group_info}`。`epoch` は、このコミットを適用する前のエポック |
| `e2ee.commit`（`evt`） | サーバー → 全員 | 順序を決めたコミット。`seq` 付き |
| `e2ee.proposal`（`evt`） | サーバー → 全員 | Actor が外部の送り手として署名した Remove の提案と、コミットの担当者 |
| `e2ee.app`（`cmd`・`evt`） | 両方向 | MLS のアプリケーションのメッセージ（会議の中のチャットとリアクション）。Actor は中身を見ずに、チャットには `chat_seq`・`ch_seq` を付けて配る（[chat-and-reactions.md](chat-and-reactions.md) の 6 節） |
| `e2ee.resync`（`cmd`） | 参加者 → サーバー | 状態を失った人が、外部コミットで入り直す |

### 6.3 コミットの順序（DS）

- Actor は、会議ごとに「今のエポック」を持つ。`e2ee.commit` の `epoch` が今のエポックと同じなら受け、`seq` を付けて全員に配り、今のエポックを 1 つ進め、添えられた GroupInfo を保存する。
- 違えば `err{code: mls_stale_epoch}` で返す。返された人は、配られたコミットを処理してから、必要なら作り直す。
- コミットの送り手は、自分のコミットが `ack` されたら、戻りの `evt` を待たずにマージしてよい（RFC 9420 の「次に適用されると分かれば進めてよい」）。
- Actor は GroupInfo と今のエポックを、会議の状態のスナップショットに含める（Valkey）。Actor が替わっても、DS の順序は続く（[signaling-and-meetings.md](signaling-and-meetings.md) の 10 節）。

### 6.4 手順

**作成**

1. E2EE の会議で、最初に Admitted になった人に、Actor が `e2ee.create` を送る。
2. その人がグループを作り、エポック 0 の GroupInfo を `e2ee.commit`（コミットは空）で Actor に送る。
3. Actor が GroupInfo を保存する。以後の参加者は外部コミットで入る。

**参加（外部コミット）**

1. 待合室・パスコードの判定の後、Admitted になった人に、Actor が `e2ee.group_info` を送る。
2. 参加者は、GroupInfo の署名と、名簿の全員の証明書を検証し、`join_by_external_commit` でコミットを作って送る。
3. Actor は、コミットの送り手の証明書の `participant_id` が、その接続の参加者と同じときだけ受ける。
4. 全員がコミットを処理する。各自、新しい参加者の証明書の `participant_id` が、シグナリングの `participant.joined` と一致するかを確かめる（11 節）。
5. 各送り手は、新しいエポックの鍵で送り始め、カメラ・共有の映像でキーフレームを 1 回作る（`generateKeyFrame`。RFC 9605 の 6.2 節）。

**退出・退出させる**

1. Actor が退出を確定する（`self.leave`、`host.remove`、切断の猶予の終わり。[signaling-and-meetings.md](signaling-and-meetings.md) の 5.2 節）。同時に Media Node に、その人の transport を閉じさせる。
2. Actor が、外部の送り手として Remove の提案に署名し、`e2ee.proposal` で配る。コミットの担当者（在席で接続が `ok` の人のうち、leaf の番号が最も小さい人）を指名する。
3. 担当者がコミットを作り（更新の経路を含む）、`e2ee.commit` で送る。
4. 400ms 以内に担当者のコミットが来なければ、Actor は次の担当者を指名する。
5. 全員がコミットを処理し、新しい鍵で送る。

**入り直し（状態を失った人）**

- コミットの処理に失敗した人、ワーカーが落ちた人は、`e2ee.resync` で最新の GroupInfo を受け、外部コミットで入り直す。外部コミットには、自分の古い leaf の Remove を含める（RFC 9420 の外部コミットでの resync）。

**定期の更新**

- 各参加者は、自分の leaf を 30 分更新していなければ、自分の更新のコミットを送る（侵害後の安全性）。同時に多数が送らないよう、±5 分の乱数でずらす。

### 6.5 外部の送り手の制限

- クライアントは、外部の送り手からの提案のうち Remove だけを受ける。Add、PSK、グループの拡張の変更の提案は拒む（サーバーが勝手に人を足せないようにする）。
- 外部の送り手の鍵は、リージョンごとの KMS の Ed25519 の鍵（`<brand>-e2ee-external-sender`。[ADR-0047](../decisions/0047-keys-and-operator-access-to-media.md)）。Actor Host は `Sign` だけを持ち、秘密鍵を読めない。KMS は Ed25519 の鍵（`ECC_NIST_EDWARDS25519`）と、メッセージをそのまま渡す `ED25519_SHA_512` の署名に対応する（[AWS KMS now supports EdDSA](https://aws.amazon.com/about-aws/whats-new/2025/11/aws-kms-edwards-curve-digital-signature-algorithm/)、2026-09-27 に確認）。月に 1 回、新しい鍵を作って別名を替える。グループは作った時の鍵を使い続けるので、古い鍵は 24 時間残す。KMS の署名の呼び出しは Remove の提案ごとに 1 回で、9 節の「退出の確定 → Remove の提案を全員へ」の 150ms に入れる。

## 7. SFrame とメディア（ADR-0028）

### 7.1 SFrame の形

| 項目 | 値 |
| --- | --- |
| 単位 | フレームごと（per-frame） |
| 暗号の組 | `AES_128_GCM_SHA256_128`（`0x0004`）。MLS の暗号の組と同じ AES-128-GCM と SHA-256 |
| 基の鍵 | `MLS-Exporter("SFrame 1.0 Base Key", "", 16)`。エポックごと |
| KID | `(context << 14) + (leaf_index << 4) + (epoch % 16)`。E=4、S=10 |
| context | 送り方ごと：音声 0、カメラ 1、画面共有 2、共有の音声 3。simulcast は層ごとに ×4 して足す（例：カメラの `h` は `1 * 4 + 1 = 5`） |
| CTR | KID ごとに 0 から数える。同じ鍵と nonce で 2 回暗号化しない |

- S=10 は、leaf の番号 1,024 までを表せる（S3 の 1,000 人）。E=4 は、16 エポックの並べ替えの窓。
- context を送り方と層で分けるのは、同じ参加者の複数の送り方（と simulcast の層）が、同じ鍵で CTR を重ねないようにするため（RFC 9605 の 6.1.2 節）。
- SVC の会議（ADR-0018 の `svc`）では、ブラウザが層ごとに別のフレームとして変換に渡すことを前提にする（RFC 9605 の 6.1.3 節の MUST）。Chrome の実際の振る舞いは**未検証**。E9 の `e2ee-poc-transform` で確かめ、満たさなければ E2EE の会議は `simulcast` だけにする。

### 7.2 ブラウザでの暗号化の場所

1. `e2ee` のワーカーで、送る側・受ける側の各 `RTCRtpSender`・`RTCRtpReceiver` に `RTCRtpScriptTransform` を付ける（mediasoup-client の `produce`・`consume` の後）。
2. 送る側：符号化の後のフレーム → SFrame で暗号化 → 返す。受ける側：SFrame のヘッダーの KID から送り手とエポックを知る → 復号 → 返す。
3. 鍵の切り替え：MLS のコミットをマージしたら、送る側は次のフレームから新しいエポックの鍵を使う（本家のように 2 秒待たない）。受ける側は、KID のエポックの下位 4 ビットで鍵を選ぶので、古いエポックのフレームも 2 エポック分は復号できる。
4. 復号に失敗したフレームは捨て、送り手ごとに数える（11 節の監視）。
5. ネイティブ（モバイル）は、libwebrtc の `FrameTransformerInterface` から共通のコアの SFrame を呼ぶ。Electron は Web と同じ。

- `SFrameTransform`（ブラウザに組み込みの SFrame）は使わない。Chrome が出荷しておらず、ブラウザごとに鍵の渡し方が変わるため。
- ワーカーの中の SFrame は、`core-e2ee` の SFrame（Rust、WASM）を使う。WebCrypto の AES-GCM は非同期で、フレームごとの呼び出しの費用が大きい見込み（**未検証**。E9 の `e2ee-poc-transform` で両方を測る）。

### 7.3 RED と FEC

- Opus のインバンド FEC は、符号化したフレームの中にあるので、そのまま暗号化される。
- RED（[ADR-0017](../decisions/0017-opus-dtx-fec-red.md)）と Encoded Transform を組んだとき、変換が RED で包む前に呼ばれるか後に呼ばれるかは**未検証**（E9 の `e2ee-poc-transform`）。確かめるまで、E2EE の会議では RED を使わない。

## 8. 層の選択と Dependency Descriptor（ADR-0028）

Media Node は、ペイロード（SFrame の暗号文）を読まずに、次だけで転送を判断する。

| 判断 | 使うもの |
| --- | --- |
| どの送り手・どの送り方か | `mid`、SSRC |
| simulcast のどの層か | `rid`（`rtp-stream-id`）、SSRC |
| キーフレームか・どの層のフレームか | Dependency Descriptor（平文のヘッダー拡張） |
| 話しているか | 音量のヘッダー拡張（`ssrc-audio-level`） |
| 帯域の推定 | transport-cc |

- 現在の mediasoup は、VP8 のキーフレームをペイロードの先頭（VP8 のフレームのヘッダー）で判定する。SFrame はフレーム全体を暗号化するので、E2EE の会議ではこれが読めない。simulcast の層を上げる（別の本に切り替える）ときに、キーフレームを待てなくなる。
- そこで次のとおりにする。
  1. E2EE の会議では、全員の送り手に DD を送らせる（2 バイトのヘッダー拡張の交渉を含む）。
  2. Media Node（mediasoup の worker）に、VP8・VP9 でも DD からキーフレームと層を判断する処理を足す。mediasoup は AV1 の DD の読み取りを持つので、それを広げる。RED と同じく上流に提案し、取り込まれるまではフォークで持つ（[ADR-0017](../decisions/0017-opus-dtx-fec-red.md)）。
  3. DD を送れない送り手（Safari の対応は**未検証**。E9 の `e2ee-poc-transform`）は、simulcast をやめ、1 本（360p、`L1T1`）だけを送る。層の切り替えが要らないので、キーフレームの判定も要らない。受け手の参加時のキーフレームは、送り手に PLI を送って得る。
- DD は、ヘッダー拡張の暗号化（RFC 9335 の cryptex など）に含めない。Media Node が読めなくなるため。
- 受け手のブラウザの復号の前の処理（depacketizer）が、暗号化したペイロードの中を読むかどうかは**未検証**（E9 の `e2ee-poc-transform`）。読んで失敗する場合は、VP8 のフレームのヘッダー（キーフレームで 10 バイト、それ以外で 3 バイト。RFC 6386 の frame tag）を暗号化せず、SFrame の認証の対象（メタデータ）として残す。Insertable Streams で、先頭の数バイトを暗号化しないことで復号器と中継を通した例がある（[webrtcHacks](https://webrtchacks.com/true-end-to-end-encryption-with-webrtc-insertable-streams/)、2020-04、2026-09-27 に確認）。これは RFC 9605 の外の扱いなので、使うなら ADR-0028 を改める。

## 9. 退出からの鍵の更新（NFR-008）

退出の確定（Actor）から、残る全員が新しいエポックの鍵で送り始めるまでを、p95 1 秒、上限 2 秒にする。

| 区間 | 予算（p95） |
| --- | --- |
| 退出の確定 → Remove の提案を全員へ | 150ms |
| 担当者がコミットを作る（100 人、WASM） | 150ms（**未検証**。E9 の `e2ee-rekey-on-leave` で測る） |
| コミット → Actor の順序付け → 全員へ | 200ms |
| 各自がコミットを処理し、SFrame に新しい鍵を入れる | 150ms（**未検証**。同上） |
| 送り手の次のフレーム | 20ms（音声）〜33ms（映像） |
| 余裕（担当者の交代 1 回の 400ms を含む） | 約 1,300ms |

- 退出の確定と同時に、Media Node はその人の transport を閉じる。鍵の更新の前でも、退出した人へのメディアの転送は止まる。鍵の更新は、Media Node が侵害されていた場合の守り。
- 2 秒を超えたら、Actor は `e2ee.rekey_slow` の指標を数え、会議の全員に「暗号化の鍵の更新が遅れています」と出す。4 秒を超えたら、Actor は会議の全員に `e2ee.resync` を求めず、担当者の交代を続ける（全員の入り直しは嵐になるため）。
- 切断の猶予（60 秒）の間は、その人は MLS のグループに残る。猶予の間に戻れば、鍵を替えずに続ける。猶予が終わって `Left(dropped)` になった時が、退出の確定。
- 複数の退出が 100ms の中で起きたら、Actor は Remove の提案をまとめ、1 つのコミットで替える。

## 10. 会議のセキュリティのコード（ADR-0030）

- コード：`Digits(SHA-256("<brand>-e2ee-security-code-v1" || group_id || epoch_authenticator))` から 40 桁の 10 進数を作り、5 桁ずつ 8 組で表示する（約 132 ビット）。`Digits` は、SHA-256 の出力を 5 バイトずつ区切って 10^5 の剰余を取る形などにする（細部は E9 の Story で決め、試験のベクトルに入れる）。
- `epoch_authenticator` は MLS の鍵のスケジュールから導かれ、グループの全員だけが知る。サーバーは同じコードを作れない。同じエポックで全員のコードが一致すれば、全員が同じグループの状態（同じ名簿、同じ鍵）にいる。サーバーが参加者を 2 つのグループに分ける攻撃（中間者）は、コードの食い違いで見つかる。
- コードは、エポックが変わるたびに変わる。画面には「エポック N のコード」と、確かめた後に入った・出た人の数を出す。人が入ったら、確かめ直しを促す通知を出す（強制はしない）。
- 読み上げの手順は本家に寄せる：主催者が読み上げ、他の人が自分の画面と比べる。合わなければ、その人が声を上げ、主催者が会議を終えて作り直す。
- ネイティブと Web で同じコードになることを、試験のベクトルで確かめる。

## 11. セキュリティ

### 11.1 守るもの・守らないもの

| 脅威 | 守れるか | どう守るか |
| --- | --- | --- |
| Media Node の侵害（メディアの盗み見） | 守る | SFrame。Media Node は鍵を持たない |
| サーバー（Actor・API）の運営者による盗み見 | 守る | 鍵はクライアントの中だけ。DS は暗号文だけを配る |
| 退出した人による、退出の後のメディアの復号 | 守る | 退出のたびに MLS のエポックを進める（9 節） |
| サーバーによる参加者の分断（中間者） | 見つける | セキュリティのコード（10 節） |
| AS による幽霊の参加者（偽の証明書で名簿に入る） | 見つける | 名簿の表示（下）。本家と同じく、完全には防げない |
| 参加者どうしのなりすまし（ある参加者が別の人の KID で送る） | 守らない | SFrame は防がない（RFC 9605 の 6.1.1 節）。送り手ごとの署名は S1 では足さない |
| メタデータ（誰が、いつ、どのくらい話したか、参加者の一覧、IP） | 守らない | サーバーに見える。音量のヘッダー拡張は平文 |

### 11.2 名簿の表示

- E2EE の会議の参加者の一覧は、MLS の名簿（証明書の `participant_id` と表示の名前の SHA-256）から作り、シグナリングの一覧と突き合わせる。
  - MLS にいて、シグナリングにいない人：赤い警告「暗号化の鍵を持つ、会議にいない参加者がいます」。
  - シグナリングにいて、MLS にいない人：「暗号化の準備中」。その人のメディアは復号できない。
  - 表示の名前の SHA-256 が、シグナリングの名前と合わない人：警告。
- 参加の途中の一時的な食い違いを警告しないよう、食い違いが 5 秒続いたときだけ警告する。
- 各参加者の詳細に、証明書の公開鍵の指紋（先頭 8 桁）を出す。

### 11.3 鍵と秘密の扱い

- MLS の秘密、SFrame の鍵、復号したメディアを、ログ・トレース・メトリクス・クラッシュの報告に出さない（本題材の AGENTS.md）。`e2ee` のワーカーは、エラーのとき、理由のコードだけを main スレッドに返す。
- 端末の鍵の組（Ed25519）は、会議の間だけメモリに持つ。保存しない。
- クライアントの E2EE のコードは、CSP で外部のスクリプトを禁じた同じオリジンから読む（[clients.md](clients.md) の 11 節）。Web の E2EE は、サーバーが配るコードを信じる前提になる。これは Web の E2EE の限界として、E2EE を選ぶ画面に書く。

## 12. E2EE で動かない機能と上限（ADR-0030）

| 機能 | 扱い | 拒む場所 |
| --- | --- | --- |
| クラウド録画 | 使えない | API（設定の組み合わせ）、Actor（開始の命令）、Media Node（Recorder の transport を作らない） |
| ライブ字幕・文字起こし | 使えない | 同上（Transcriber） |
| 電話からの参加（MVP の後） | 使えない | API、Actor |
| AI の機能（MVP の後） | 使えない | API、Actor |
| 会議の中のチャット（全員へ） | 使える。MLS のアプリケーションのメッセージとして暗号化し、`e2ee.app` で送る。Actor は暗号文を中身を見ずに `chat_seq`・`ch_seq` で順序付けて配る。取りこぼしを `chat.fetch` で埋めるため、Valkey の Stream には暗号文だけを置く（会議の終了から 24 時間）。サーバーは平文を持たない | Actor（平文を持たない。[ADR-0036](../decisions/0036-in-meeting-chat-ordering-and-retention.md)） |
| 会議の中の個別のメッセージ | 使えない。MLS のアプリケーションのメッセージはグループの全員が復号できるので、2 人に閉じられない（`private_chat = off` を強制） | Actor、クライアント |
| 会議の中のチャットの保存（`save_chat`、録画への書き出し） | 保存しない。設定にかかわらず会議の後に残さない | API、Actor |
| チャットのファイル | 使えない | API、Actor |
| RED | 確かめるまで使わない（7.3 節） | クライアント |
| AV1・SVC の映像のモード | E9 の PoC まで `simulcast` だけ（7.1 節） | Actor |
| ブラウザの `RTCRtpScriptTransform` がない参加者 | 入れない | クライアント（参加の前）、Actor（申告） |
| 待合室・パスコード・主催者の操作 | 使える（メタデータで動く） | — |
| 仮想背景・雑音の抑制 | 使える（端末の上） | — |

- 録画・字幕の拒否の細部（エラーの `e2ee_incompatible`、3 か所の判定）は [recording-and-transcription.md](recording-and-transcription.md) と [ADR-0027](../decisions/0027-capture-consent-and-indicators.md) に従う。
- 主催者が E2EE を選ぶ画面で、使えなくなる機能を示す（ADR-0004）。
- 会議の途中で E2EE を入れる・外すことはできない。開催の前に決める（本家と同じ。ホワイトペーパーの会議の設定の説明）。
- 参加者の上限は、S1 で 100 人（ADR-0004）。E9 の `e2ee-scale-300` で、100 人・300 人のグループでのコミットの作成と処理の時間を基準の端末で測る。300 人で 9 節の予算に収まれば、S2 で 300 人に上げる（そのときは音声の枠（[ADR-0057](../decisions/0057-audio-slots-for-large-meetings.md)）との組み合わせも確かめる）。

## 13. 失敗のしかた

| 失敗 | 起きること | 対処 |
| --- | --- | --- |
| 担当者がコミットを送らない（切断、端末の遅さ） | 鍵の更新が遅れる | 400ms で次の担当者（6.4 節）。`e2ee.rekey_slow` を数える |
| 2 人が同じエポックにコミットを送る | 1 つだけが通る | Actor がエポックごとに最初の 1 つだけを受ける（6.3 節） |
| 参加者がコミットの処理に失敗する | その人だけ復号できなくなる | `e2ee.resync` で入り直す |
| Actor の交代 | 数秒、コミットが受けられない | スナップショットの GroupInfo とエポックから続ける。クライアントは `mls_stale_epoch` のとき処理し直す |
| 復号の失敗が続く（鍵のずれ） | 映像・音声が出ない | 送り手ごとの失敗の数が 5 秒で 50 を超えたら、`e2ee.resync` |
| ブラウザが DD を送らない | 層の切り替えができない | 1 本だけ送る（8 節） |
| AS の中間 CA の鍵の漏えい | 偽の証明書 | 中間 CA を失効させ、クライアントの同梱の根で新しい中間 CA だけを受ける。runbooks の `e2ee-as-key-compromise.md` |
| 新しい参加者の映像が出るのが遅い | 古い鍵のキーフレームを復号できない | 新しい鍵を使い始めた後にキーフレームを作る（6.4 節） |

## 14. テスト

### 14.1 性質ベーステスト

Actor、偽の Media Node、クライアント N 個（`core-e2ee` を直接呼ぶ）を 1 つのプロセスで動かし、参加・退出・退出させる・切断・担当者の無応答・Actor の交代・メッセージの遅れを乱数で起こす。

- **PROP-E2EE-001（退出の後）**：任意の列で、退出が確定した後のエポックで暗号化したフレームを、退出した人の鍵の状態では復号できない。
- **PROP-E2EE-002（収束）**：任意の列の後、在席の全員の MLS のエポックと `epoch_authenticator` が同じ。
- **PROP-E2EE-003（順序）**：Actor が受けるコミットは、エポックごとに 1 つだけ。
- **PROP-E2EE-004（外部の送り手）**：外部の送り手の Add の提案を、クライアントは常に拒む。
- **PROP-E2EE-005（CTR）**：任意の送り方と層の組み合わせで、同じ鍵と CTR の組が 2 回使われない。
- **PROP-E2EE-006（鍵をサーバーに出さない）**：Actor・Media Node・ログに渡ったバイト列に、そのエポックの SFrame の鍵と `epoch_authenticator` が現れない。

### 14.2 実装をまたぐ試験のベクトル

| 対象 | ベクトル |
| --- | --- |
| SFrame | RFC 9605 の付録 C の試験のベクトル（[sframe-wg/sframe の test-vectors.json](https://github.com/sframe-wg/sframe/blob/025d568/test-vectors/test-vectors.json)）を `core-e2ee` の SFrame に通す |
| MLS | MLS の作業部会の公開の試験のベクトル（[mlswg/mls-implementations](https://github.com/mlswg/mls-implementations)）を OpenMLS の版を上げるたびに通す |
| MLS の相互運用 | 別の実装（例：AWS の mls-rs）で作ったグループに、OpenMLS の参加者が外部コミットで入り、同じ `epoch_authenticator` になる |
| KID とセキュリティのコード | 7.1 節の KID と 10 節のコードの計算を、固定の入力と出力のベクトルにして、Web（WASM）とネイティブで同じ結果になる |

### 14.3 結合試験とネットワークの劣化の試験

- **暗号文の確認**：E2EE の会議で Media Node が受けた RTP のペイロードを保存し、SFrame の形であること、どのサーバーの鍵でも復号できないことを確かめる（ADR-0004 の Confirmation）。
- **鍵の更新の時間**：100 人（ボットを含む）の会議で、退出の確定から全員の送り手が新しい KID で送り始めるまでの p95 1 秒、最大 2 秒（NFR-008）。Media Node で KID のエポックの切り替わりを見て測る。
- **ブラウザの組み合わせ**：Chrome、Edge、Firefox、Safari の 4 × 4 で、E2EE の会議の音声・映像・共有、層の切り替え。
- **劣化**：[codecs-and-bandwidth-adaptation.md](codecs-and-bandwidth-adaptation.md) の 11.1 節の条件を E2EE の会議にも掛ける。E2EE でない会議と比べて、MOS の推定とフリーズの率の差を記録する。
- **拒否**：E2EE の会議で録画・字幕の開始の命令が、API・Actor・Media Node で拒まれる。

## 15. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E9 | `e2ee-poc-transform` | 7.2 節と 8 節の PoC。ブラウザごとの Encoded Transform、DD、depacketizer、SVC の層ごとのフレーム、RED の組み合わせ |
| E9 | `core-e2ee-mls` | 6 節。OpenMLS のグループ、外部コミット、Remove、resync |
| E9 | `core-e2ee-sframe` | 7.1 節。KID、context、CTR |
| E9 | `e2ee-worker-wasm` | 3 節・4 節の `e2ee` のワーカー（[clients.md](clients.md)） |
| E9 | `mls-delivery-service` | 6.3 節。Actor のエポックの順序、GroupInfo の保存 |
| E9 | `e2ee-credentials-as` | 5 節。X.509 の証明書、中間 CA、根の同梱 |
| E9 | `e2ee-rekey-on-leave` | 9 節。担当者の指名と交代、2 秒の計測 |
| E9 | `media-node-dd-selection` | 8 節。mediasoup に VP8・VP9 の DD の判断を足す |
| E9 | `security-code-ui` | 10 節と 11.2 節 |
| E9 | `e2ee-feature-gates` | 12 節。3 か所での拒否 |
| E9 | `e2ee-chat-mls` | MLS のアプリケーションのメッセージでのチャット（chat-and-reactions.md と合わせる） |
| E9 | `e2ee-scale-300` | 12 節の 300 人の計測 |
| E13 | `e2ee-native-transformer` | 7.2 節のネイティブの `FrameTransformerInterface`（アプリ。MVP の後） |

Epic の番号は [architecture/README.md](README.md) の 7 節の割り当てに従う。Epic の名前は [roadmap.md](../roadmap.md) で決まる。

## 16. 未解決の問い

### 決定

2026-09-27 の既定案。承認は Dev（テックリード）が行う。

- **SFrame の暗号の組**：`AES_128_GCM_SHA256_128`（ADR-0028）。
- **KID**：E=4、S=10、context は送り方と層（ADR-0028）。
- **鍵の切り替え**：コミットをマージしたら次のフレームから。待ちの時間は置かない（ADR-0028）。
- **層の判断**：DD。mediasoup に VP8・VP9 の DD の判断を足す（ADR-0028）。
- **資格情報**：参加のたびの Ed25519 の鍵と、会議の間だけの X.509 の証明書（ADR-0029）。
- **参加**：外部コミット。**退出**：外部の送り手の Remove と担当者のコミット（ADR-0029）。
- **セキュリティのコード**：`epoch_authenticator` から 40 桁（ADR-0030）。
- **上限**：S1 は 100 人（ADR-0030）。
- **E2EE の会議の RED**：使わない（確かめるまで）。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| Chrome・Firefox・Safari の depacketizer が暗号文を読むか。VP8 のヘッダーを平文で残す必要があるか | E9 の `e2ee-poc-transform`。要るなら ADR-0028 を改める |
| Safari の DD の対応 | 同上。対応しなければ 1 本だけ送る形のまま |
| SVC の層ごとに別のフレームとして変換に渡るか | 同上 |
| SFrame を WASM と WebCrypto のどちらで動かすか | 同上。1 フレームの処理時間で決める |
| `sframe` の crate の成熟度と監査 | E9 の `core-e2ee-sframe` の着手時。足りなければ `core-e2ee` の中に RFC 9605 を実装し、試験のベクトルで確かめる |
| 端末に残る長期の鍵（本家の sigchain に相当）を作るか | S2 の前。AS のなりすましへの守りを強めたい組織の要望を見て決める |
| 参加者どうしのなりすましを防ぐ送り手ごとの署名 | S2 の前。費用（フレームごとの署名）を測る |
| 捜査機関への対応で、E2EE の会議について何を示せるか | 法務（intent.md の L4）。E9 の一般への提供の前 |
| 本家の会議の途中での E2EE の切り替えの可否 | 本家のホワイトペーパーは「開始の後は変えられない」とする。本設計も同じにした。変える要望があれば PM と決める |

## 17. quality.md・runbooks・data-model への項目

### quality.md

- NFR-008 の測り方（9 節の区間、Media Node での KID の切り替わりの観測）と、100 人・300 人の条件。
- 性質ベーステスト PROP-E2EE-001〜006 と、列の数。
- 14.2 節の試験のベクトルと、OpenMLS の版を上げるときの必須の試験。
- E2EE と非 E2EE の会議の品質の差（MOS の推定、フリーズの率、参加の時間）の許容の範囲。
- 暗号文の確認の試験（14.3 節）を、E2EE に触れる PR で必須にする。

### runbooks

- `e2ee-rekey-slow.md`：`e2ee.rekey_slow` が増えたときの切り分け（担当者の無応答、Actor の遅れ、端末の遅さ）。
- `e2ee-decrypt-failures.md`：復号の失敗の報告が増えたときの切り分け（ブラウザの版、KID のずれ、resync の嵐）。
- `e2ee-as-key-compromise.md`：AS の中間 CA の鍵が漏れたときの失効と入れ替えの手順。
- `e2ee-external-sender-key-rotation.md`：外部の送り手の鍵の月ごとの入れ替え。

### data-model（索引への追加の提案）

| 置き場所 | 中身 |
| --- | --- |
| Aurora `meetings.settings`（signaling-and-meetings.md の提案） | `e2ee: {enabled}`。開催の前だけ変えられる |
| Aurora `e2ee_credentials` | `instance_id`、`participant_id`、証明書のシリアル、公開鍵の指紋、発行と失効の時刻。証明書の失効の確認と監査に使う。秘密鍵は持たない |
| Aurora `e2ee_ca_keys` | 中間 CA の ID、KMS の鍵の ARN、有効期間、状態 |
| Meeting Actor の状態（スナップショット、Valkey） | `mls_epoch`、最新の GroupInfo（公開の情報）、外部の送り手の鍵の ID、コミットの担当者の状態。会議が終われば消す |
| 指標 | `e2ee.rekey_duration`、`e2ee.rekey_slow`、`e2ee.resync`、`e2ee.decrypt_failures`（数だけ。中身は含めない） |

## 参考

- [RFC 9605（SFrame）](https://www.rfc-editor.org/rfc/rfc9605)、[RFC 9420（MLS）](https://www.rfc-editor.org/rfc/rfc9420.html)
- [WebRTC Encoded Transform](https://www.w3.org/TR/webrtc-encoded-transform/)、[caniuse の RTCRtpScriptTransform](https://caniuse.com/mdn-api_rtcrtpscripttransform)
- [openmls](https://github.com/openmls/openmls)、[OpenMLS の book](https://book.openmls.tech/)
- [Zoom Cryptography Whitepaper](https://github.com/zoom/zoom-e2e-whitepaper)、[End-to-end encryption for meetings](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0065408)
- [mediasoup の CHANGELOG](https://github.com/versatica/mediasoup/blob/v3/CHANGELOG.md)、[mediasoup#1625](https://github.com/versatica/mediasoup/issues/1625)

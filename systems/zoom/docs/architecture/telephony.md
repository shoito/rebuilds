# Telephony: Zoom

電話から会議に参加する仕組み（ダイヤルイン・ダイヤルアウト）の設計。通信事業者との SIP トランク、電話の網と会議をつなぐゲートウェイ、日本の電話番号（050・0120・0800・0ABJ）、音声の案内（IVR）、不正な発信への対策を決める。MVP の後の Epic で作る（intent.md の「MVP の後の Epic で扱う」）。番号の取得と事業の手続きは法務の確認待ち（intent.md の L1・L7）で、この文書はどの結論にも対応できる形を示す。

前提となる決定は、既定はホップごとの暗号化で E2EE の会議では電話からの参加を動かさないこと（[ADR-0004](../decisions/0004-encryption-and-e2ee.md)）、会議の状態は Meeting Actor が持つこと（[ADR-0005](../decisions/0005-meeting-state-and-signaling.md)）、会議の番号は人が読み上げられる 11 桁（[ADR-0006](../decisions/0006-meeting-id-and-join-url.md)）、パスコードは既定で数字（[ADR-0031](../decisions/0031-waiting-room-and-passcode-rules.md)）、録画の同意（[ADR-0027](../decisions/0027-capture-consent-and-indicators.md)）。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0041](../decisions/0041-pstn-via-carrier-sip-trunk-and-own-gateway.md) | 電話の網とは、国内の通信事業者の SIP トランクでつなぎ、番号は事業者から卸を受ける。SIP の入口（Kamailio）、呼の制御と IVR（FreeSWITCH）、会議の音声との橋（Phone Bridge）を自前で持つ。電話の参加者は、Phone Bridge が SFU の PlainTransport で会議に入る「サーバーの側の参加者」として扱う。CPaaS の音声の流れ（WebSocket）に会議の音声を渡す形は採らない |
| [0042](../decisions/0042-dial-in-numbers-ivr-and-dial-out-limits.md) | ダイヤルインの番号は全会議で共用し、IVR で会議の番号とパスコードを押してもらう。番号は 050 を基本にし、0120・0800 は組織の選択にする。発信者の番号は下 4 桁だけを見せる。ダイヤルアウトは組織の設定で既定は無効、国内だけ、特番（0990・0570 など）と国際を拒否し、組織ごとに 1 日の分数の上限を持つ |

## 1. 目的と範囲

- 扱う：ダイヤルイン（電話から会議へ）、ダイヤルアウト（会議から電話を呼ぶ「電話をかけてもらう」と、主催者による電話での招待）、SIP トランク、番号の種類、IVR、電話の参加者の会議の中での扱い（ミュート、待合室、同意、表示）、電話の音声と会議の音声の変換、不正な発信への対策、E2EE の会議での禁止。
- 扱わない：会議室の機器（SIP・H.323 の端末）の接続（MVP の後の別の Epic）、クラウド PBX（Phone に相当。intent.md の Non-goals の近く）、通信事業者との契約の条件、料金の請求（MVP の外）。
- 前提：法務の確認（L1・L7）が済むまで、この領域の Story の `spec.md` を承認しない。

## 2. 確かめたこと

| 項目 | 内容 | 出典 |
| --- | --- | --- |
| 番号の使用の手続き | 電気通信番号を使う電気通信事業者は、番号の種別ごとに「電気通信番号使用計画」を作り、総務大臣の認定を受ける（2019 年の制度）。自ら番号の指定を受ける場合と、他の事業者から卸を受ける場合で、手続きが分かれる | [電気通信番号を使用するための手続](https://www.soumu.go.jp/main_sosiki/joho_tsusin/top/tel_number/new_framework.html)、[電気通信番号関係の制度改正について](https://www.soumu.go.jp/main_content/000614856.pdf) |
| 050 の品質 | 050 の IP 電話の総合品質（端末の間）は、R 値 50 超・平均の遅延 400ms 未満。0AB-J の IP 電話は平均の遅延 150ms 未満など、より厳しい | [通信品質等の現行規定について](https://www.soumu.go.jp/main_content/000690836.pdf)（総務省、IP ネットワーク設備委員会の参考資料 58-2、2020-06-04） |
| 転送の区間の品質と番号の表示 | 固定電話の番号を使う転送電話で、転送の区間が固定電話の網の品質に満たないときは、発信者の番号を通知しないか、050 などの固定電話以外の番号を使う、という整理がある（0AB-J の転送の話で、050 の条件ではない） | [固定電話番号を利用する転送電話サービスの在り方（答申）](https://www.soumu.go.jp/main_content/000583229.pdf)（総務省、2018-11-02） |
| 050 の本人確認 | いわゆる 050 のアプリ電話の契約のときの本人確認を、携帯電話不正利用防止法の施行規則の改正で義務にした。2023-08 に公布、2024-04-01 に施行 | [意見募集の結果](https://www.soumu.go.jp/main_content/000897635.pdf)（「令和６年４月１日に施行する」）、[総務省の Q&A](https://www.soumu.go.jp/main_sosiki/joho_tsusin/d_syohi/050526_1.files/Page444.html) |
| 番号の指定の状況 | 0120・0800（着信課金）、0570、050 などの種別ごとに、指定を受けた事業者の一覧が公表されている | [電気通信番号指定状況](https://www.soumu.go.jp/main_sosiki/joho_tsusin/top/tel_number/number_shitei.html) |
| CPaaS の日本の番号 | Twilio は日本で National（050）と Toll-Free の番号を扱い、購入の前に規制の書類の束の審査が要る。日本の番号を再販する者は、番号使用計画の書類の提出が要る | [Japanese Phone Number Regulatory Changes](https://help.twilio.com/articles/4405840066715-Japanese-Phone-Number-Regulatory-Changes)、[Resellers of Japanese Phone Numbers](https://help.twilio.com/articles/9956319880859)（検索の結果の要約で確かめた。本文は取得できず**未検証**。E14 の `carrier-selection-and-legal` で確かめる） |
| Amazon Chime SDK の番号 | 番号を取れる国は API（`ListSupportedPhoneNumberCountries`）で確かめる。身元の書類が要る国の一覧に日本はない | [ListSupportedPhoneNumberCountries](https://docs.aws.amazon.com/chime-sdk/latest/APIReference/API_voice-chime_ListSupportedPhoneNumberCountries.html)、[Country requirements for phone numbers](https://docs.aws.amazon.com/chime-sdk/latest/ag/phone-country-reqs.html)（日本の番号を取れるかは**未検証**。E14 の `carrier-selection-and-legal` で API を呼んで確かめる） |
| 本家の電話の操作 | 参加者は `*6` でミュートの切り替え、`*9` で挙手の切り替え。主催者は `*4` で会議の終了、`*5` でロック、`*7` で録画、`99` で全員のミュート、`**` で一覧 | [Joining a Zoom meeting or webinar by phone](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0060564) |

いずれも 2026-09-27 に確認。

## 3. 構成

ADR-0041。

```
一般の電話 ── PSTN ── 通信事業者（050・0120 の番号を卸す）
                          │ SIP トランク（TLS＋SRTP か、閉じた網。事業者の対応による）
                          ▼
                     SIP Edge（Kamailio。事業者の IP だけを受ける、呼の数の制限、振り分け）
                          │
                          ▼
                     Call Controller（FreeSWITCH。IVR、DTMF、G.711 の終端、ジッタバッファ）
                          │ 内部の RTP（1 通話 1 本、L16 か Opus）
                          ▼
                     Phone Bridge（1 通話を受け持つ。下りの音声を混ぜ、上りを 1 つの producer にする）
                          │ 制御：API（phone-join）と Signaling Gateway（hello・cmd）
                          │ メディア：Media Node の PlainTransport（SRTP、Opus）
                          ▼
                     Meeting Actor ／ Media Node（他の参加者と同じ会議）
```

- **SIP Edge**：事業者の IP の一覧からだけ受ける。1 つの事業者の同時の呼の上限と、1 秒あたりの新しい呼の上限を持つ。SIP の中身（`From`、`P-Asserted-Identity`）をそのまま信じない（事業者が付けた発信者の番号だけを使う）。
- **Call Controller**：IVR の音声（日本語、合成の音声を前もって作った音のファイル）、DTMF（RFC 4733）の受け取り、G.711（μ-law）の終端。呼の状態は通話ごとに持つが、会議の状態は持たない。
- **Phone Bridge**：電話の参加者 1 人を、会議の参加者 1 人として動かす。
  - 制御：API の内部の口（`POST /internal/phone/join`）で参加のトークンを受け、Signaling Gateway に `hello` する。クライアントと同じシグナリングを話す（`client.kind = "phone"`）。
  - 上り：電話の音声を Opus に符号化し、Media Node の PlainTransport に 1 つの音声の producer として送る。
  - 下り：会議の音声の consumer（話者の絞り込み（[ADR-0011](../decisions/0011-forwarding-and-layer-selection.md)）で多くても 4 本）を受け、復号して混ぜ、1 本にして Call Controller に返す。
  - 映像と共有は受けない。
- 電話の参加者は、SFU から見ると受け手の 1 人である。Recorder・Transcriber と同じく PlainTransport を使う（[recording-and-transcription.md](recording-and-transcription.md) の 3 節）。Web のクライアントではないので、ICE と DTLS は使わない。
- 会議の中の状態（ミュート、待合室、同意、主催者の操作）は、Web の参加者と同じく Actor が決める。

## 4. ダイヤルイン

ADR-0042。

### 4.1 番号

| 種類 | 用途 | 既定 | 備考 |
| --- | --- | --- | --- |
| 050 | 共用のダイヤルインの番号 | 使う | 事業者から卸を受ける。品質の条件（R 値 50 超、平均の遅延 400ms 未満）は 2 節。卸の事業者の網と本システムの区間を合わせて満たすかは、E14 の `carrier-selection-and-legal` で事業者と確かめる |
| 0120・0800 | 通話料を着信の側（組織）が払う番号 | 組織の選択（別の契約） | 事業者から卸を受ける |
| 0ABJ（03・06 など） | 信頼感のある番号 | 使わない（持ち越し） | 取得の条件（地域、品質）を法務と確かめる |

- 番号は全会議で共用する。会議ごとに番号を割り当てない（番号の数と費用を抑える。会議の番号は IVR で押す）。
- 番号の一覧は、招待と会議の画面に出す（[scheduling-and-calendar.md](scheduling-and-calendar.md) の 6.4 節）。
- ワンタップの参加（`tel:0501234567,,84512093376#,,,,*482913#`）を招待に書く。パスコードを招待に書くことになるので、参加の鍵と同じく、漏れたときの防御は待合室に頼る。

### 4.2 IVR の流れ

```
着信
 │「<Brand> です。会議の番号を入力し、最後にシャープを押してください」
 ▼ 11 桁の会議の番号（10 桁の PMI も受ける）＋ #
 │ 番号が E2EE の会議 → 「この会議には電話から参加できません」→ 切る
 │「パスコードを入力し、最後にシャープを押してください」（パスコードのない会議は飛ばす）
 ▼ 数字のパスコード（英数字の会議は電話用の数字のパスコード）＋ #
 │ 誤り → もう一度（1 通話で 3 回まで）→ 3 回目で切る
 │ POST /internal/phone/join（caller_id_hash を含む）→ 参加のトークン
 ▼ Phone Bridge が hello
 │ status = waiting → 「主催者の許可をお待ちください」（保留の音）
 │ 録画・文字起こし中 → 「この会議は録画されています。同意して参加する場合は 1 を押してください」
 │     1 → consent.give{recording}（と transcription）  それ以外・10 秒の無応答 → もう一度 → 切る
 ▼ 入室（音声はミュートで入る。組織の設定で「ミュートで入る」を外せる）
```

- 存在しない番号とパスコードの誤りは、同じ案内（「番号かパスコードが違います」）にする（[ADR-0033](../decisions/0033-join-rate-limits-and-enumeration-defense.md)）。
- 同意の案内の文言は、Web の同意の画面と同じ版（`notice_version`）の音声を使う。同意は DTMF の `1` で記録する（ADR-0027）。
- 案内は日本語。英語の案内は持ち越し。

### 4.3 会議の中の操作（DTMF）

| 押す | 動作 | シグナリング |
| --- | --- | --- |
| `*6` | ミュートの切り替え | `self.update{muted}`（主催者が解除を禁じていれば「主催者がミュートにしています」） |
| `*9` | 挙手の切り替え | `self.update{hand_raised}` |
| `*1` | 同意（録画・文字起こしが途中で始まったとき） | `consent.give` |
| `*0` | 操作の案内を聞く | — |

- 番号の割り当ては本家（`*6`・`*9`。2 節）に合わせる。`*1`（同意）と `*0`（案内）は本システムの割り当て。
- 途中で録画が始まったら、電話の参加者に音声で知らせ、同意するまでミュートの解除を拒否する（ADR-0027 と同じ）。

### 4.4 表示

- 電話の参加者の表示の名前は「電話の参加者（****1234）」。発信者の番号の下 4 桁だけを出す。非通知の着信は「電話の参加者（非通知）」。
- 主催者は名前を変えられる（`host.rename`）。本人は DTMF で名前を変えられない。
- 発信者の番号は、`caller_id_hash`（HMAC）と下 4 桁だけを持つ。番号そのものは持たない（ban と流量の制限に使うのはハッシュ）。
- 電話の参加者は、ゲストとして扱う。退出させたら、`caller_id_hash` で ban する（[meeting-security.md](meeting-security.md) の 6.1 節の端末の鍵の代わり）。非通知の着信は ban できないので、組織の設定で「非通知の着信を断る」を選べる（既定：受ける）。

## 5. ダイヤルアウト

ADR-0042。

- 種類：「電話をかけてもらう」（Web の参加者が自分の電話を指定し、音声だけ電話でつなぐ）と、主催者による電話での招待。
- 組織の設定 `dial_out`（既定：無効）。有効にしても、次の規則を当てる。

| 規則 | 値 |
| --- | --- |
| 宛先 | 国内の固定・携帯・050 だけ。国際（`010`）、`0990`・`0570`・`0180`・`00XY`（事業者の選択の番号）・`1XY`（特番）を拒否する |
| 1 ユーザー | 1 時間に 10 回 |
| 1 組織 | 1 日の分数の上限（組織の設定。既定 3,000 分） |
| 1 会議 | 同時に 10 本 |
| 発信者の番号 | 共用のダイヤルインの 050 の番号を通知する（事業者と法務の確認による） |
| 相手の応答 | 相手が出たら「<Brand> の会議に招待されています。参加する場合は 1 を押してください」。1 を押したときだけ会議に入れる（留守番電話が会議に入るのを防ぐ） |

- 不正な発信（盗んだアカウントでの大量の発信、料金の高い番号への発信）への対策として、組織ごとの 1 時間の分数が過去の平均の 5 倍を超えたら、その組織のダイヤルアウトを止めて管理者と運営に知らせる。

## 6. 音声の品質

- 電話の網の音声は G.711（8 kHz）。会議の側は Opus（48 kHz）。変換は Phone Bridge で行う。
- 遅れの予算（電話の人の声が Web の参加者に届くまで、p95）：事業者の網 100ms、SIP Edge・Call Controller 20ms、Phone Bridge の符号化 40ms、Media Node と受け手のジッタバッファ 200ms。合計で約 360ms の見込み（**未検証**。E14 の `phone-bridge` で事業者の網の実測と合わせて測る）。050 の総合品質の平均の遅延 400ms 未満（2 節）にも、この予算の中で収める。NFR-001 の音声（p95 200ms）は、Web の参加者どうしの目標であり、電話の参加者には当てない（[architecture/README.md](README.md) の 3 節）。電話の参加者の目標は、[quality.md](../quality.md) の 2.2.1 節の既定（電話の参加者の声が Web の参加者に届くまで p95 400ms）とし、E14 の着手のときに事業者の網の実測で QA が確かめる。
- 下りの混ぜ方：話者の絞り込みで受けた最大 4 本を混ぜ、ピークを抑える（リミッター）。自分の声は混ぜない（Media Node は自分の producer の consumer を作らない）。
- 電話の網の損失は Phone Bridge では補わない。会議の側の損失は Opus の FEC と PLC で補う。

## 7. 障害のときの振る舞い

| 障害 | 起きること | 対処 |
| --- | --- | --- |
| 事業者の SIP トランクが落ちた | 新しい着信と発信ができない | 2 つ目の事業者（または同じ事業者の別の接続点）へ切り替える（2 社にするかは E14 の着手の前に決める）。会議の中の Web の参加者は影響なし |
| Call Controller のタスクが落ちた | その通話が切れる | 電話の参加者はかけ直す。SIP の呼を別のタスクへ引き継がない（引き継ぎは複雑で、電話の利用者はかけ直しに慣れている） |
| Phone Bridge が落ちた | その通話の会議の音声が止まる | Call Controller が「接続し直しています」を流し、新しい Phone Bridge で同じ参加者として入り直す（再接続用の秘密。[signaling-and-meetings.md](signaling-and-meetings.md) の 7 節） |
| Media Node の付け替え | 数秒止まる | Web の参加者と同じ（[ADR-0013](../decisions/0013-media-node-failover-and-reattach.md)）。PlainTransport を作り直す |
| Actor の持ち主の交代 | DTMF の操作が最大 10 秒効かない | Web の参加者と同じ |
| 不正な発信の急増 | 費用が急に増える | 5 節の自動の停止 |

## 8. セキュリティとプライバシー

- 事業者との間は、TLS（SIP）と SRTP を使う。事業者が対応しなければ、閉じた網（専用線・IPsec）でつなぐ。インターネットに平文の SIP・RTP を流さない。
- SIP Edge は事業者の IP だけを受ける。SIP のスキャン（総当たりの REGISTER・INVITE）は Edge で捨てる。
- 発信者の番号をそのまま、ログ・トレース・メトリクスに出さない。出すのは `caller_id_hash` と下 4 桁だけ。
- DTMF の数字（会議の番号、パスコード）をログに出さない。
- E2EE の会議では、IVR で会議の番号を受けた時点で断る。API の `phone/join` も `e2ee_incompatible` で拒否する（二重の検査）。
- 電話の参加者の音声は、SIP トランクと電話の網ではホップごとの暗号化（または閉じた網）であり、端から端までの暗号化ではない。電話から参加できる会議で、そのことを会議の画面に示す（「電話の参加者がいます」）。
- 通信の秘密（L2）、番号と事業の手続き（L1・L7）、緊急通報の扱い（L7）は、法務の確認の後に設計を見直す。本システムは会議への参加の番号だけを持ち、一般の発信（任意の番号への通話の提供）はしない。そのため緊急通報の義務がかからないかを、法務に確認する。

## 9. テスト

### 9.1 性質ベーステスト

- **PROP-TEL-001（E2EE）**：E2EE の会議に、電話の参加者が入ることはない。
- **PROP-TEL-002（同意）**：録画・文字起こしが動いている間、DTMF の同意の記録のない電話の参加者の音声が、Recorder・Transcriber と他の参加者に届くことはない。
- **PROP-TEL-003（ダイヤルアウト）**：任意の宛先の文字列で、拒否の一覧（国際、特番）に当たる番号への発信が起きることはない。

### 9.2 決定表

- ダイヤルアウトの宛先の規則（`DT-TEL-*`）。IVR の分岐（E2EE、パスコードの有無、待合室、録画）。

### 9.3 結合

| 試験 | 期待 |
| --- | --- |
| SIP の試験の端末（SIPp）で着信し、DTMF で番号とパスコードを押す | 会議に入り、Web の参加者と音声が往復する |
| 電話の参加者を回線の劣化（損失 5%・20%）の下で測る | 音声の MOS の推定を記録する（閾値は quality.md） |
| パスコードを 3 回誤る | 切れる。流量の制限の数に入る |
| ダイヤルアウトで `0990`・国際の番号を指定 | 拒否 |
| 相手が 1 を押さない（留守番電話） | 会議に入らない |

## 10. Story の候補

電話の Epic は E14（MVP の後。[roadmap.md](../roadmap.md)）。

| Epic | Story | 中身 |
| --- | --- | --- |
| E14 | `carrier-selection-and-legal` | 事業者の選定、番号の卸、番号使用計画の要否の確認（L1・L7） |
| E14 | `sip-edge-and-call-controller` | 3 節。Kamailio、FreeSWITCH、事業者との接続 |
| E14 | `phone-bridge` | 3 節。PlainTransport、下りの混ぜ方、シグナリングの `client.kind = phone` |
| E14 | `dial-in-ivr` | 4.2 節。番号、パスコード、待合室、同意 |
| E14 | `phone-in-meeting-controls` | 4.3・4.4 節。DTMF、表示、ban |
| E14 | `dial-out-with-guards` | 5 節 |
| E14 | `toll-free-numbers` | 0120・0800 の組織の選択 |
| E14 | `phone-join-rate-limits` | [ADR-0033](../decisions/0033-join-rate-limits-and-enumeration-defense.md) の軸に `caller_id_hash` を足す（電話がない間は要らないので、E3 から E14 へ移した） |

## 11. 未解決の問い

### 決定

2026-09-27 の既定案。承認は Dev（テックリード）が行う。事業と番号に関わるものは、法務の確認（L1・L7）が済むまで効かない。

- **接続**：国内の事業者の SIP トランク。番号は事業者から卸を受ける。
- **ゲートウェイ**：Kamailio＋FreeSWITCH＋自前の Phone Bridge。
- **番号**：050 を共用。0120・0800 は組織の選択。0ABJ は持ち越し。
- **IVR**：会議の番号＋パスコード。録画中は DTMF の 1 で同意。
- **表示**：発信者の番号の下 4 桁だけ。
- **ダイヤルアウト**：既定は無効。国内だけ、特番・国際を拒否、組織の 1 日の上限、相手が 1 を押したときだけ入れる。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| 電気通信事業の登録・届出の区分と、番号使用計画の認定の要否（卸を受ける場合を含む）（L1・L7） | 法務の確認。電話の Epic の着手の前 |
| 050 の品質の条件（R 値 50 超、平均の遅延 400ms 未満。2 節で確かめた）を卸の網と本システムの区間を合わせて満たすか。満たせない場合の扱い（L7） | E14 の `carrier-selection-and-legal` で法務と事業者に確認 |
| 緊急通報の扱い（会議への参加の番号だけの提供で義務がかかるか）（L7） | 法務の確認 |
| 事業者の選定（国内の事業者か CPaaS か）、2 社にするか | 電話の Epic の着手の前に、費用と SIP の TLS・SRTP の対応を比べる |
| Phone Bridge の実装（Rust か、既存の部品か） | 電話の Epic の着手のときに試作して決める |
| 0ABJ の番号 | 利用者の声と取得の条件を見て決める |
| 英語の案内 | 利用者の声を見て決める |
| 電話の参加者の遅れと音質の目標 | [quality.md](../quality.md) の既定（p95 400ms）を、E14 の着手で事業者の網の実測と合わせて QA が確かめる |
| Amazon Chime SDK で日本の番号を取れるか | E14 の `carrier-selection-and-legal` で API を呼んで確かめる |

## 12. quality.md・runbooks・data-model への項目

### quality.md

- ダイヤルインの成功率（着信から入室まで）と、IVR の各段での離脱の割合。
- 電話の参加者の音声の MOS の推定（上りと下り）と、遅れ。
- ダイヤルアウトの拒否の件数（宛先の規則、上限）と、自動の停止の件数。
- SIP の新しい呼の拒否（Edge の制限）の件数。

### runbooks

- `sip-trunk-outage.md`：事業者の SIP トランクが落ちたときの確かめ方（OPTIONS の死活、呼の失敗の率）と、別の接続点への切り替え。
- `toll-fraud-response.md`：ダイヤルアウトの急増で組織を止めたときの確かめ方と、管理者への連絡、解除の手順。
- `ivr-prompt-update.md`：同意の文言の版を変えたときの、IVR の音声の作り直しと配布。
- `phone-bridge-capacity.md`：同時の通話の数と、Phone Bridge・Call Controller のタスクの増やし方。

### data-model（索引への追加の提案）

| 置き場所 | 中身 |
| --- | --- |
| Aurora `phone_numbers` | `number`（E.164）、`type`（`050`・`0120`・`0800`）、`carrier`、`scope`（`shared`・`org`）、`org_id?`、`active` |
| Aurora `phone_calls` | `call_id`、`direction`（`in`・`out`）、`number_id`、`caller_id_hash`、`caller_last4`、`instance_id?`、`participant_id?`、`started_at`、`ended_at`、`end_reason`、`duration_s` |
| Aurora `dial_out_usage_daily` | `org_id`、`day`、`minutes`、`calls`、`blocked` |
| Aurora `meeting_removals`（列の追加） | `caller_id_hash` |
| Aurora `meetings`（列の追加） | `phone_passcode_*`（[meeting-security.md](meeting-security.md) の 14 節と同じ） |

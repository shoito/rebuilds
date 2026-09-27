# Intent: Zoom を AI エージェント主体で再構築する

- Author: shoito
- Status: accepted
- Date: 2026-09-27

## Problem

離れた場所の人と会議をするには、音声と映像を、遅れず、途切れずに届ける必要がある。これを自前で作るのは難しい。

- 人は、音声の遅れに敏感である。片道の遅れが 150ms を超えると会話のしやすさが落ち、400ms を超えると計画の上で許容できない（[ITU-T G.114](https://www.itu.int/rec/T-REC-G.114)、2026-09-27 に確認）。
- 利用者の回線は、家庭の Wi-Fi、モバイル、社内のプロキシと様々である。パケットの損失、揺らぎ、帯域の急な低下があっても、会話を続けられなければならない。
- 参加者が増えるほど、送る映像の数が増える。100 人、1,000 人の会議を、サーバーと回線の費用を抑えて支える必要がある。
- 会議の URL が漏れると、知らない人が入り込み、会議を荒らす（2020 年に「Zoombombing」と呼ばれた）。
- 録画・文字起こし・エンドツーエンドの暗号化（E2EE）は、互いに両立しない部分がある。利用者に選ばせ、その結果を正しく伝える必要がある。

本家 Zoom Meetings は、これを「クリック 1 回で参加でき、悪い回線でも途切れにくい会議」として提供している。その中身を、小さなチームと AI エージェントでどこまで作り直せるかを確かめる。

## Proposed outcome

日本の企業の会議を対象に、次の 3 つの価値を満たすビデオ会議を作り直す。

1. **すぐに集まれる**：URL を開くだけで、ブラウザから 3 秒程度で会議に入れる。予定の会議とすぐの会議の両方を、カレンダーから使える。
2. **遅れず、途切れない**：日本の中では、話してから相手に届くまでの遅れを p95 300ms 以内に保つ。損失 20% の回線でも、音声で会話を続けられる。回線の帯域に合わせて、映像の品質を自動で変える。
3. **安全**：待合室とパスコードを既定にし、主催者が参加者を管理できる。通信は常に暗号化し、望めば E2EE（サーバーも内容を見られない形）を選べる。

### MVP（S1）に含める

- **会議**：予定の会議とすぐに始める会議。会議の ID、URL、パスコード。1 会議の参加者は 100 人まで（S2 で 300 人、S3 で 1,000 人）
- **Web クライアント**：ブラウザの WebRTC で参加する（[ADR-0003](decisions/0003-client-platform.md)）。インストールは要らない
- **音声・映像・画面共有**：ギャラリー表示と話者の表示。ミュート、カメラのオンとオフ。画面・ウィンドウ・タブの共有
- **会議の中のチャットとリアクション**：全員へのメッセージ、個別のメッセージ、絵文字のリアクション、挙手
- **待合室とパスコード**：どちらか一方を必ず有効にする（本家も 2020-09-27 から同じ規則。[May 2020: Passcode and security settings](https://support.zoom.us/hc/en-us/articles/360042647952-May-2020-Passcode-and-security-settings)、2026-09-27 に確認）
- **主催者の操作**：参加者のミュート、ビデオの停止、退出させる、会議のロック、共同主催者の指名、画面共有の許可、参加者の名前の変更の制限
- **クラウド録画**：音声・映像・画面共有を 1 つの動画に合成して保存し、アカウントの中で共有する
- **日本語のライブ字幕と文字起こし**：会議中の字幕と、会議後の文字起こし（話者つき）
- **仮想背景とぼかし**：クライアントの端末の上で処理する。映像をサーバーへ送る前に処理を終える
- **E2EE のオプション**：主催者が会議ごとに選ぶ。E2EE の会議では、録画・字幕などのサーバーで内容を扱う機能を使えない（[ADR-0004](decisions/0004-encryption-and-e2ee.md)）
- **カレンダー連携**：Google カレンダーと Microsoft 365 の予定に、会議の URL を付ける
- **アカウントと管理**：組織のアカウント、ユーザーとロール、会議の既定の設定と強制、利用状況のレポート

### MVP の後の Epic で扱う

| 機能 | 理由 |
| --- | --- |
| デスクトップ・モバイルのアプリ | MVP は Web で価値を確かめる。アプリは共通のコアを持つ形で後から作る（[ADR-0003](decisions/0003-client-platform.md)） |
| 電話からの参加（ダイヤルイン・ダイヤルアウト） | 電話番号の取得、通信事業者との接続、番号に関わる法令の確認（L7）が要る |
| ウェビナー・大規模なイベント（視聴者 1 万人以上） | 双方向の会議とは別の配信の経路（視聴専用の配信）が要る |
| ブレイクアウトルーム | 会議の状態の設計（[ADR-0005](decisions/0005-meeting-state-and-signaling.md)）の上に足せる。100 人の会議が安定してから |
| ホワイトボード | 共同編集の別の製品。Notion の題材の設計が参考になる |
| Team Chat（会議の外のチャット） | Slack の題材と重なる。会議の中のチャットに限る |
| Phone（クラウド PBX） | 電話の事業の免許と番号が要る別の製品 |
| AI による要約・議事録・質問への応答 | 文字起こしの品質が固まってから。通信の秘密（L2）の整理も要る |
| 会議室のシステム（Zoom Rooms に相当）、SIP・H.323 の機器の接続 | 機器ごとの対応と相互接続の試験が要る |

- Epic の番号は [roadmap.md](roadmap.md) にある。アプリは E13、電話からの参加は E14、ウェビナーは E15、ブレイクアウトルームは E16。残りは roadmap.md の延期の一覧。

### 守るべき振る舞い

- 待合室もパスコードもない会議は作れない。
- 主催者が退出させた参加者は、同じ会議に再び入れない（主催者が許すまで）。
- 録画・文字起こしが動いている間は、すべての参加者にそれが見える。途中から入った人にも見える。
- E2EE の会議では、サーバーはメディアとチャットの鍵を一度も持たない。E2EE の会議で、録画・字幕・電話からの参加は動かない。
- 退出した参加者は、退出の後に送られたメディアを復号できない（E2EE の会議）。
- 1 台のメディアサーバーが落ちても、会議は終わらない。参加者は自動で別のサーバーへ移り、数秒で音声が戻る。
- 他の組織の会議・録画・文字起こし・参加者の情報は、一切見えない。

### 成功の基準

| # | 基準 | 目標 | 測り方 |
| --- | --- | --- | --- |
| K1 | 遅れ | 日本の中の参加者どうしで、映像の撮影から相手の画面の表示まで（glass-to-glass）p95 300ms 以内（NFR-001） | 試験の環境で、時刻を埋め込んだ映像を撮って測る。本番は RTT とジッタバッファの遅れから推定する |
| K2 | 参加の速さと成功率 | 参加のボタンから音声の送受信の開始まで p95 3 秒以内（NFR-002）。参加の試行の 99.5% 以上が成功する | クライアントの計測（RUM） |
| K3 | 音声の途切れにくさ | ランダムな損失 20% の回線で、音声の品質の推定（ViSQOL などの客観評価）が MOS 3.0 以上（NFR-003） | ネットワークの劣化を模した試験（CI と定期の試験） |
| K4 | 会議が切れない | 参加者が意図せず会議から落ちた割合が、参加者・時間あたり 0.5% 以下。メディアサーバーの障害から 5 秒以内に音声が戻る（NFR-004） | クライアントとサーバーの計測。障害の注入の訓練 |
| K5 | 体感の品質 | 会議の後の評価（5 段階）で、4 以上の割合が 90% 以上 | 会議の後の任意の評価 |
| K6 | 荒らしの防止 | 待合室またはパスコードのない会議 0 件。第三者の入り込みの報告に、主催者が 1 回の操作で対処できる | 設定の監査、報告の集計 |
| K7 | 日本語の字幕 | 会議の音声で、文字の誤り率（CER）15% 以下。発話から字幕の表示まで p95 2 秒以内（NFR-010） | 評価用の会議の音声のセット。本番は遅れだけを測る |
| K8 | 費用 | 参加者・分あたりのメディアの配信の費用を、S1 で 0.20 円以下、S2 で 0.07 円以下に保つ（[capacity.md](architecture/capacity.md) の 6 節、[ADR-0053](decisions/0053-capacity-model-cost-target-and-load-bots.md)。既定案、PM の承認を要する） | 請求の集計と、送ったバイト数（毎月） |

## Affected users and systems

- **主催者**（主な利用者）：日本の企業で、社内外の会議を開く人。予定の会議をカレンダーから作り、待合室で参加者を確かめる。
- **参加者**：社内の人と、社外の人（取引先、候補者など）。社外の人はアカウントなしでブラウザから入る。
- **組織の管理者**：ユーザー、会議の既定の設定と強制、録画の保持、利用状況を管理する。
- **外部のシステム**：カレンダー（Google、Microsoft 365）、ID の連携（SAML・OIDC の IdP）、音声認識のエンジン（S1 は Amazon Transcribe を ASR Adapter の裏で使う。[ADR-0026](decisions/0026-asr-engine-amazon-transcribe-with-adapter.md)）、メールの送信事業者、後の段階で電話の通信事業者。
- **社内の運用**：メディアサーバーの運用、品質の監視、濫用の対応、サポート。

## Constraints

- **ブラウザの標準の上で作る。** Web クライアントは、ブラウザの WebRTC（W3C の Recommendation、[WebRTC 1.0](https://www.w3.org/TR/webrtc/)、2026-09-27 に確認）と IETF の RTCWEB の RFC（RFC 8825〜8835、JSEP は [RFC 9429](https://www.rfc-editor.org/rfc/rfc9429)）に従う。本家の Web クライアントのような、独自の符号化と独自の伝送（WebAssembly、WebSocket、DataChannel）は採らない（[ADR-0003](decisions/0003-client-platform.md)）。
- **メディアは SFU で中継する。** サーバーで映像を合成しない（[ADR-0002](decisions/0002-media-topology.md)）。
- 制御の側（API、シグナリング、管理）の実行基盤と技術は、rebuilds の他の題材の決定（AWS 東京・大阪、TypeScript、Aurora PostgreSQL、Terraform、OpenTelemetry）を引き継ぐ。メディアサーバーだけは、ネットワークの性能のために EC2 で動かす（[ADR-0001](decisions/0001-platform-and-stack.md)）。
- 本家の名前は識別子に使わない。会議の URL は `https://<brand>.<domain>/j/<meeting-id>`、ヘッダーは `X-<Brand>-...`、SDK は `@<brand>/...`、RTP のヘッダー拡張の URI は `urn:<brand>:...` の形で書く（[リポジトリ共通の ADR-0006](../../../docs/decisions/0006-brand-neutral-identifiers.md)）。本家のクライアントや SDK との互換は目標にしない。
- 日本の法令への対応は、法務の確認を前提に設計する（下の「法務の確認待ち」）。
- 規模は段階的に広げる（[architecture/](architecture/README.md) の「規模の段階」）。

## Non-goals

| 機能 | 理由 |
| --- | --- |
| 本家のクライアント・SDK・API との互換 | リポジトリ共通の ADR-0006。標準のプロトコル（WebRTC、後で SIP）で互換にする |
| サーバーでの映像の合成（MCU）による配信 | サーバーの CPU の費用が大きく、遅れも増える。録画だけはサーバーで合成する（[ADR-0002](decisions/0002-media-topology.md)） |
| 視聴者 1 万人以上の配信（ライブ配信・ウェビナー） | 別の配信の経路が要る。MVP の後に扱う |
| 海外のリージョン（S1・S2） | 日本の市場を先にする。S3 で検討する |
| 中国本土での提供 | 法令と網の条件が別に大きい |
| 自前の音声認識のモデルの学習 | 既存のエンジン（自前でホストするものか外部のもの）を選ぶ。利用者の会議の内容で学習しない |

## Open questions

### 法務の確認待ち

設計はどの結論にも対応できる形にするが、結論は出さない。**下の表の「承認を止める spec」は、確認が済むまで PM・QA が承認しない。**

| # | 問い | 関係する設計 | 承認を止める spec |
| --- | --- | --- | --- |
| L1 | 電気通信事業法の届出：Web 会議は「他人の通信を媒介する」事業として、登録または届出が要るとされる（[電気通信事業参入マニュアル［追補版］](https://www.soumu.go.jp/main_content/000477428.pdf)、2026-09-27 に確認）。登録と届出のどちらか、届出の時期、特定利用者情報の規律（大規模な事業者の規律）が将来かかるか | [infrastructure](architecture/infrastructure.md)、[security](architecture/security.md) | E2 の社外への公開（ベータを含む） |
| L2 | 通信の秘密：SFU は DTLS-SRTP を終端するので、サーバーの上で平文のメディアを扱う。録画・字幕・品質の診断・濫用の調査で、内容に触れてよい範囲と、そのための同意の取り方。AI の要約に使うときの扱い | [media-server-sfu](architecture/media-server-sfu.md)、[recording-and-transcription](architecture/recording-and-transcription.md)、[meeting-security](architecture/meeting-security.md)、[observability](architecture/observability.md)、[ADR-0004](decisions/0004-encryption-and-e2ee.md)、[ADR-0047](decisions/0047-keys-and-operator-access-to-media.md) | E8 の録画・字幕、E1 の品質の計測で内容を含むもの |
| L3 | 録画・文字起こしの同意：参加者への通知の方法、同意の記録、同意しない人の扱い（退出するしかないか）。社外の参加者の個人情報の扱い（個人情報保護法の利用目的の通知） | [recording-and-transcription](architecture/recording-and-transcription.md)、[ADR-0027](decisions/0027-capture-consent-and-indicators.md) | E8 の録画の開始の Story |
| L4 | 捜査機関への対応：通信の傍受の要請（通信傍受法）、記録の差し押さえ・照会（会議の記録、参加者の IP）にどう応じるか。E2EE の会議で応じられないことの扱い | [security](architecture/security.md)、[e2ee](architecture/e2ee.md) | E9 の E2EE の一般への提供、E12 の GA の判定 |
| L5 | 外部送信規律（電気通信事業法）：Web クライアントが、端末の情報を外部（分析、エラーの収集）へ送るときの公表の方法 | [clients](architecture/clients.md)、[observability](architecture/observability.md)、[ADR-0051](decisions/0051-qos-telemetry-pipeline.md) | E2 の Web クライアントの公開 |
| L6 | 個人情報保護法：録画・文字起こし・チャットの保持の期間と削除。音声認識を外部の事業者に委ねるときの委託と外国にある第三者への提供。データを国内に置くことをどこまで約束するか | [recording-and-transcription](architecture/recording-and-transcription.md)、[infrastructure](architecture/infrastructure.md)、[ADR-0026](decisions/0026-asr-engine-amazon-transcribe-with-adapter.md) | E8 の音声認識のエンジンの選定、E12 の契約の文書 |
| L7 | 電話からの参加：電話番号（0ABJ・050・0120 など）の取得の条件、通信事業者との接続、緊急通報の扱い | [telephony](architecture/telephony.md) | E14（MVP の後の電話の Epic） |
| L8 | 組織との契約：委託の契約（DPA）の雛形、サブプロセッサーの一覧、録画の開示・削除の請求の窓口 | [accounts-and-admin](architecture/accounts-and-admin.md)、[api-and-webhooks](architecture/api-and-webhooks.md) | E12 の GA の判定 |

### 選定・計測で決めるもの（法務以外）

- 日本語の音声認識のエンジン：S1 は Amazon Transcribe streaming を既定にし、E8 の着手前に、評価用の音声のセットで自前でホストする Whisper 系などと遅れ・誤り率・費用を比べる（[ADR-0026](decisions/0026-asr-engine-amazon-transcribe-with-adapter.md)）。値は未検証。
- メディアサーバーの 1 台あたりの参加者の数・パケット数の上限：c8gn.16xlarge を既定にし（[ADR-0049](decisions/0049-media-node-fleet.md)）、E7 の負荷試験で c8g.16xlarge と比べて決める。EC2 はインスタンスごとの PPS の上限を公表していない（[ENA の性能の指標](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/monitoring-network-performance-ena.html)、2026-09-27 に確認）。未検証。
- AWS のインターネットへの転送の費用が K8 に収まるか：下りの平均 1.5 Mbps なら収まり、2.5 Mbps なら収まらない見込み（[infrastructure.md](architecture/infrastructure.md) の 12 節）。E2 のベータで下りの平均を測る。ベアメタル・コロケーション（Edge）の構築は、ピークの送出が 4 週続けて 10 Gbps を超えたら始める（[ADR-0050](decisions/0050-disaster-recovery-and-edge-migration.md)）。
- E2EE でのブラウザの対応：`RTCRtpScriptTransform` は対応ブラウザの最新 2 メジャーのすべてにある（[ADR-0021](decisions/0021-web-client-browser-support.md)）。Dependency Descriptor・depacketizer・SVC の層ごとのフレームの扱いは、E9 の `e2ee-poc-transform` で確かめる（[ADR-0028](decisions/0028-sframe-encoded-transform-and-dependency-descriptor.md)）。未検証。
- 1:1 の会議を P2P にするか：S2 で、費用と品質を計測して決める（[ADR-0002](decisions/0002-media-topology.md)）。

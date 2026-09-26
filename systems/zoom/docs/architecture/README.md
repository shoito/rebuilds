# Architecture: Zoom

全体像と横断的な方針。領域ごとの設計は、同じディレクトリに領域ごとのファイルとして置く。まだ書いていない。書く予定の文書と、領域ごとに割り当てた ADR の番号の範囲は 7 節にある。

## 1. 全体構成

```
ブラウザ（Web クライアント：WebRTC、仮想背景、E2EE の鍵管理）
   │ HTTPS（API）      │ WebSocket（シグナリング）        │ UDP（SRTP・RTCP、ICE）
   ▼                   ▼                                  │  └ 通らなければ TURN（UDP・TCP・TLS 443）
 API ───────────▶ Signaling Gateway ──▶ Meeting Actor      ▼
   │  会議・予定・      （接続を保持）     （会議ごとに 1 つ。  Media Node（SFU）
   │  アカウント・                          状態の正本）──────▶ 転送・帯域の推定・層の選択
   │  録画の参照                                │ 割り当て         │  ▲ 別の Media Node・別のリージョンへ
   ▼                                            ▼                  │  │ カスケード（中継）
 Aurora PostgreSQL ◀──────────────── Media Assignment Service       │
   │ outbox                                                          ▼
   ▼                                                    Recorder・Transcriber
 Worker（通知、カレンダー、Webhook、録画の後処理）        （SFU から購読する参加者として動く）
                                                                     │
                                                                     ▼ S3（録画・文字起こし）
```

| コンポーネント | 責務 |
| --- | --- |
| API | 認証、会議の作成と予定、参加の許可（参加のトークンの発行）、録画の参照、管理。状態を持たない |
| Signaling Gateway | クライアントの WebSocket を保持し、会議の ID で Meeting Actor へ中継する。会議の状態は持たない |
| Meeting Actor | 会議 1 つにつき、ある時点で 1 つだけ動く。参加者の一覧、主催者の操作、待合室、誰の映像をどの層で誰に送るかの決定、チャットの順序を決める。会議の状態の正本（[ADR-0005](../decisions/0005-meeting-state-and-signaling.md)） |
| Media Assignment Service | 会議を、どのリージョンのどの Media Node に置くかを決める。負荷と参加者の位置を見る |
| Media Node | SFU。クライアントから受けた RTP を、他の参加者へ選んで転送する。映像は復号しない（[ADR-0002](../decisions/0002-media-topology.md)） |
| TURN | UDP が通らない参加者のための中継。TCP・TLS の 443 番を含む |
| Recorder・Transcriber | SFU から見ると 1 人の参加者として、音声と映像を受け取る。録画を合成し、音声を文字にする。E2EE の会議には入れない |
| Aurora PostgreSQL | 会議・予定・アカウント・録画の索引の正本。会議の中の一時的な状態は持たない |
| Valkey | Meeting Actor の持ち主の記録（リース）と、状態のスナップショット。失われても会議は続く |
| Worker | outbox から、通知、カレンダーの更新、Webhook、録画の後処理を行う |

原則は 4 つ。

- **メディアの経路と、制御の経路を分ける。** Meeting Actor や API が止まっても、流れているメディアは止めない。Media Node は、最後に受けた転送の指示のまま転送を続ける（[ADR-0005](../decisions/0005-meeting-state-and-signaling.md)）。
- **サーバーは選んで転送するだけ。** 映像の符号化と復号はクライアントが行う。サーバーは、帯域に合わせて simulcast の層や SVC の層を選ぶ（[ADR-0002](../decisions/0002-media-topology.md)）。
- **会議の状態の正本は、会議ごとに 1 か所。** 状態の変化は Meeting Actor が順番を決め、連番を付けて全員に配る（[ADR-0005](../decisions/0005-meeting-state-and-signaling.md)）。
- **暗号化は既定、E2EE は選べる。** 通常の会議は DTLS-SRTP でホップごとに暗号化し、サーバーはメディアを扱える。E2EE の会議は SFrame と MLS で暗号化し、サーバーは鍵を持たない（[ADR-0004](../decisions/0004-encryption-and-e2ee.md)）。

## 2. 規模の段階

帯域は、映像を受ける参加者 1 人あたり平均 1.5 Mbps（下り）、0.8 Mbps（上り）で見積もる。本家のグループ通話の目安は、720p で上り 2.6 Mbps・下り 1.8 Mbps、音声だけで 60〜80 kbps（[Zoom の帯域の要件](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0060748)、2026-09-27 に確認）。平均の値は、カメラを止めた参加者と、小さく表示される映像を含めた見込みで、未検証。capacity.md で計測に置き換える。

| 段階 | 同時の会議 | 同時の参加者 | 1 会議の上限 | SFU の送出（ピーク） | 構成 |
| --- | --- | --- | --- | --- | --- |
| S1（MVP） | 5,000 | 3 万 | 100 人 | 約 45 Gbps | 東京の 1 リージョン・3 AZ。1 会議を 1 台の Media Node に置き、台の中の複数の worker（CPU のコアごと）に広げる。災害復旧は大阪（制御の側だけ。メディアは大阪で新しく会議を始め直す） |
| S2 | 5 万 | 30 万 | 300 人 | 約 450 Gbps | 東京と大阪の両方で会議を受ける。1 会議を複数の Media Node に広げる（リージョンの中のカスケード）。1:1 の P2P を評価する |
| S3 | 30 万 | 200 万 | 1,000 人 | 約 3 Tbps | リージョンをまたぐカスケード。国内の Edge（コロケーション・ベアメタル）で Media Node を動かすかを判断する。セル構成 |

パケットの数は、映像 1 本（1.5 Mbps、平均 1,200 バイト）で約 160 パケット/秒、音声 1 本（Opus、20ms ごと）で 50 パケット/秒になる。S1 のピークで、SFU の全体で約 1,000 万パケット/秒の見込み（未検証）。EC2 はインスタンスごとの PPS の上限を公表していないため、`pps_allowance_exceeded` の指標を見ながら負荷試験で 1 台の上限を決める（[ENA の性能の指標](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/monitoring-network-performance-ena.html)、2026-09-27 に確認）。

段階を上げる判断の基準は、infrastructure.md と capacity.md（まだない）に書く。

## 3. 非機能要件

| ID | 項目 | S1 の目標 | 備考 |
| --- | --- | --- | --- |
| NFR-001 | 遅れ（glass-to-glass） | 日本の中の参加者どうしで、映像の撮影から相手の画面の表示まで p95 300ms 以内。音声（mouth-to-ear）は p95 200ms 以内 | ITU-T G.114 は、片道 150ms 以下で会話がほぼ自然、400ms 以上は許容できないとする。試験の環境で測る |
| NFR-002 | 参加の速さ | 参加のボタン（待合室がない場合）から、音声の送受信の開始まで p95 3 秒以内。TURN を経由する場合は p95 5 秒以内 | 2 回目以降の参加（ブラウザのキャッシュあり）で測る |
| NFR-003 | 音声の途切れにくさ | ランダムな損失 20%、揺らぎ 30ms の回線で、音声の客観評価（ViSQOL など）が MOS 3.0 以上。損失 5% で MOS 3.8 以上 | Opus のインバンド FEC、RED（RFC 2198）、NACK で備える。評価の道具は quality.md で決める |
| NFR-004 | 進行中の会議の可用性 | Media Node 1 台の障害で、参加者の音声が 5 秒以内に戻る。Meeting Actor の障害で、メディアは止まらない（制御は 10 秒以内に戻る）。意図しない会議からの脱落は、参加者・時間あたり 0.5% 以下 | ICE restart と Media Node の付け替え（[ADR-0005](../decisions/0005-meeting-state-and-signaling.md)） |
| NFR-005 | 参加・予定の API の可用性 | 月間 99.95% | 本家の Meetings の SLA は月間 99.9%（再販事業者の配布した [Zoom Availability SLA の写し](https://www.mitel.com/sites/default/files/2025-08/Zoom%20Availability%20SLA_TMP%20%2812Aug25%29%20FINAL%20v1.pdf)、2026-09-27 に確認。一次の文書は未確認） |
| NFR-006 | 1 会議の参加者 | S1 100 人、S2 300 人、S3 1,000 人。全員が音声・映像・画面共有を使える。映像を同時に受けて表示するのは 1 人あたり最大 25 本 | 本家は 100 人から、追加の契約で 500・1,000 人（[Large Meetings](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0065116)、2026-09-27 に確認） |
| NFR-007 | リージョンの同時の参加者 | S1 3 万人、S2 30 万人（東京・大阪の合計）、S3 200 万人 | 2 節 |
| NFR-008 | E2EE の保証 | E2EE の会議では、サーバーはメディアとチャットの鍵を持たない。参加者の退出から 2 秒以内に鍵を更新し、以後のメディアは退出した人に復号できない。参加者は、全員で同じ「会議のセキュリティのコード」を確かめられる | MLS（RFC 9420）の前方秘匿性と侵害後の安全性に頼る（[ADR-0004](../decisions/0004-encryption-and-e2ee.md)） |
| NFR-009 | 帯域の適応 | 下りの帯域が半分に下がったら、5 秒以内に映像の層を落として収まり、映像の停止（1 秒以上）を起こさない。下り 150 kbps まで下がっても、音声は続く | GCC（送信側の推定）、SFU での層の選択（[ADR-0002](../decisions/0002-media-topology.md)） |
| NFR-010 | 字幕と録画 | 日本語の字幕を、発話から p95 2 秒以内に表示する。録画は、会議の終了から録画の長さの半分以内に見られるようになり、成功を知らせた録画は失わない | 字幕の正確さは intent.md の K7 |

## 4. 技術スタック

| 層 | 選定 | 理由 |
| --- | --- | --- |
| 制御の側の言語 | TypeScript（API、Signaling Gateway、Meeting Actor、Media Node の制御、Web） | 他の題材と同じ。シグナリングのメッセージの型を、サーバーと Web クライアントで共有できる（[ADR-0001](../decisions/0001-platform-and-stack.md)） |
| API | Hono＋Zod | 他の題材と同じ |
| SFU | mediasoup v3（C++ の worker を、Node.js の API から制御する） | 転送の中核は枯れた実装を使い、制御は TypeScript で書ける（[ADR-0001](../decisions/0001-platform-and-stack.md)） |
| Web クライアント | React＋ブラウザの WebRTC＋mediasoup-client | [ADR-0003](../decisions/0003-client-platform.md) |
| E2EE | SFrame（RFC 9605）と MLS（RFC 9420）。MLS は OpenMLS（Rust）を WebAssembly にして使う | [ADR-0004](../decisions/0004-encryption-and-e2ee.md) |
| ネイティブのアプリの共通のコア | Rust（シグナリングの状態機械と E2EE の鍵管理）。メディアは libwebrtc | MVP の後。[ADR-0003](../decisions/0003-client-platform.md) |
| DB | Aurora PostgreSQL 18 | 他の題材と同じ |
| 会議の状態の補助 | Valkey（Meeting Actor のリース、状態のスナップショット） | [ADR-0005](../decisions/0005-meeting-state-and-signaling.md) |
| 実行基盤（制御） | AWS（ECS Fargate、Aurora、ElastiCache、SQS、S3、CloudFront）。東京、災害復旧は大阪 | 他の題材と同じ |
| 実行基盤（メディア） | EC2（ネットワークの性能の高いインスタンス、パブリック IP を直接持つ）。S3 でベアメタル・コロケーションを判断する | [ADR-0001](../decisions/0001-platform-and-stack.md) |
| IaC | Terraform | 他の題材と同じ |
| 可観測性 | OpenTelemetry（ADOT）→ AMP、X-Ray、CloudWatch Logs。メディアの品質の指標（getStats、RTCP）は別の経路で集める | observability.md で詳しく決める |
| ネットワークの劣化の試験 | Linux の `tc netem` で損失・揺らぎ・帯域を模す。Playwright で実際のブラウザを動かす | quality.md で詳しく決める |

## 5. 主な決定

| ADR | 決定 |
| --- | --- |
| [0001](../decisions/0001-platform-and-stack.md) | 制御の側は他の題材の基盤を引き継ぐ。メディアは EC2 の上の mediasoup で中継する |
| [0002](../decisions/0002-media-topology.md) | 多人数は SFU。1:1 も SFU を通す。大きな会議は SFU をカスケードする。映像は simulcast と SVC |
| [0003](../decisions/0003-client-platform.md) | Web クライアントはブラウザの WebRTC を使う。ネイティブのアプリは、共通のコア（Rust）と libwebrtc で作る |
| [0004](../decisions/0004-encryption-and-e2ee.md) | 既定は DTLS-SRTP のホップごとの暗号化。選べる E2EE は SFrame と MLS |
| [0005](../decisions/0005-meeting-state-and-signaling.md) | 会議の状態は、会議ごとに 1 つの Meeting Actor が持つ。WebSocket のシグナリングと、会議を Media Node に割り当てるサービス |

リポジトリ共通の決定（開発プロセス、トランクベース開発、本家の名前を識別子に使わない規則）は、ルートの [docs/decisions/](../../../../docs/decisions/README.md) にある。

## 6. リスクと未解決事項

- **転送の費用**：会議の費用の大半は、SFU からインターネットへの転送になる。S1 のピークで約 45 Gbps を送る。AWS のインターネットへの転送の料金で、参加者・分あたりの費用の目標（intent.md の K8）に収まるかは未検証。収まらなければ、S2 から国内のコロケーションやベアメタルに Media Node を移す。制御の側は AWS に残す。
- **EC2 のネットワークの上限**：PPS の上限は公表されていない。インターネットゲートウェイを通る通信は、32 vCPU 未満のインスタンスで 5 Gbps、それ以上でインスタンスの帯域の 50% に制限される。1 本のフロー（5 タプル）は、クラスタのプレイスメントグループの外では 5 Gbps に制限される（[EC2 のネットワークの帯域](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-instance-network-bandwidth.html)、2026-09-27 に確認）。Media Node 1 台あたりの参加者の数は、この上限と CPU のどちらかで決まる。負荷試験で決める。
- **セキュリティグループの接続の追跡**：UDP のフローも追跡され、インスタンスごとの上限を超えるとパケットが捨てられる。送信元と宛先を全開（0.0.0.0/0）にした規則は追跡されない（[接続の追跡](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/security-group-connection-tracking.html)、2026-09-27 に確認）。Media Node のメディアのポートは追跡しない規則にし、防御は SFU の側の検査（ICE の認証、DTLS）で行う。NLB は通さない（NLB を通る接続は必ず追跡される）。
- **ブラウザの違い**：Safari・Firefox・Chrome で、simulcast、SVC（[WebRTC-SVC](https://www.w3.org/TR/webrtc-svc/)、2026-09-27 に確認した時点で Working Draft）、Encoded Transform（[WebRTC Encoded Transform](https://www.w3.org/TR/webrtc-encoded-transform/)、同じく Working Draft）の対応が異なる。ブラウザと版ごとの対応表を clients.md で持ち、E2E の試験を各ブラウザで回す。
- **大きな会議のキーフレームの要求**：受け手が多い会議では、受け手のキーフレームの要求（PLI・FIR）が送り手に集まり、送り手の送出が 2〜3 倍に増えうる（[mediasoup の Scalability](https://mediasoup.org/documentation/v3/scalability/)、2026-09-27 に確認）。SFU で要求をまとめ、頻度を抑える。
- **Meeting Actor の二重化**：ネットワークの分断で、同じ会議の Actor が 2 つ動くと、状態が分かれる。リースにフェンシングの番号（epoch）を付け、古い epoch の指示を Media Node と Gateway が拒否する（[ADR-0005](../decisions/0005-meeting-state-and-signaling.md)）。
- **日本語の字幕の品質**：音声認識のエンジンの選定は未定。専門用語、固有名詞、話者の重なりで誤りが増える。
- **法令**：電気通信事業法の届出、通信の秘密、録画の同意は、法務の確認待ち（[intent.md](../intent.md) の L1〜L8）。

## 7. 領域の文書（予定）と ADR の番号の範囲

領域の文書で ADR を起票するときは、その領域に割り当てた範囲の中で採番する。範囲を使い切ったら、0060 以降を使い、この表を更新する。Epic の番号は、roadmap.md（まだない）の草案の番号である。

| ファイル（まだない） | 領域 | ADR の範囲 | 主な Epic |
| --- | --- | --- | --- |
| signaling-and-meetings.md | 会議の作成と参加、会議の ID と URL、Meeting Actor、シグナリングのプロトコル、主催者の操作、状態の再同期 | 0006〜0009 | E2、E3、E7 |
| media-server-sfu.md | Media Node、転送の規則、層の選択、話者の検出、キーフレームの制御、Media Node の割り当てとカスケード、障害の時の付け替え | 0010〜0013 | E2、E4、E7、E10 |
| network-traversal.md | ICE、STUN、TURN（UDP・TCP・TLS 443）、社内のプロキシとファイアウォール、IPv6 | 0014〜0016 | E2 |
| codecs-and-bandwidth-adaptation.md | Opus（DTX、FEC、RED）、VP8・H.264・VP9・AV1、simulcast と SVC、帯域の推定（GCC、transport-cc）、画面共有の符号化 | 0017〜0020 | E4、E5 |
| clients.md | Web クライアント、対応ブラウザ、端末の処理（仮想背景、雑音の抑制）、アクセシビリティ、後のデスクトップ・モバイルと共通のコア | 0021〜0024 | E2、E5、E11 |
| recording-and-transcription.md | クラウド録画（合成、保存、共有、保持）、日本語のライブ字幕と文字起こし、同意の表示 | 0025〜0027 | E8 |
| e2ee.md | SFrame、MLS、Delivery Service と Authentication Service、会議のセキュリティのコード、E2EE で動かない機能 | 0028〜0030 | E9 |
| meeting-security.md | 待合室、パスコード、ロック、退出させた人の再入室の禁止、荒らしの報告と対処、会議の ID の推測への対策 | 0031〜0033 | E3 |
| scheduling-and-calendar.md | 予定の会議、繰り返し、個人の会議の ID、Google カレンダーと Microsoft 365 の連携 | 0034〜0035 | E6 |
| chat-and-reactions.md | 会議の中のチャット、個別のメッセージ、ファイル、リアクション、挙手 | 0036〜0037 | E5 |
| accounts-and-admin.md | 組織のアカウント、ユーザーとロール、SSO、会議の既定の設定と強制、利用状況のレポート | 0038〜0040 | E6 |
| telephony.md | 電話からの参加（ダイヤルイン・ダイヤルアウト）、SIP の接続（MVP の後） | 0041〜0042 | 後回し |
| api-and-webhooks.md | 公開 API、Webhook、会議のイベント | 0043〜0044 | E12 |
| security.md | 脅威モデル、暗号化と鍵、監査ログ、濫用の対策、データのライフサイクル | 0045〜0047 | E1、E3、E12 |
| infrastructure.md | AWS の構成、メディアのリージョンと Edge、Media Node のインスタンスと網、冗長化、災害復旧 | 0048〜0050 | E1、E10 |
| observability.md | メディアの品質の指標（損失、揺らぎ、RTT、フリーズ、MOS の推定）、ログ、トレース、SLO | 0051〜0052 | E1、E4 |
| capacity.md | 負荷のモデル、Media Node 1 台の上限、帯域と PPS、費用 | 0053 | E7、E10、E12 |
| delivery.md | CI/CD、ネットワークの劣化の試験の基盤、Media Node の無停止の入れ替え、フィーチャーフラグ | 0054〜0056 | E1 |
| data-model.md | データモデルの索引 | なし | — |

0057〜0059 は、領域をまたぐ決定のために空けておく。

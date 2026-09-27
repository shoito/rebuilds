# Architecture: Zoom

全体像と横断的な方針。領域ごとの設計は、同じディレクトリに領域ごとのファイルとして置く（7 節）。品質の戦略は [quality.md](../quality.md)、Epic と Story の計画は [roadmap.md](../roadmap.md)、SLO とアラートと手順は [runbooks/](../runbooks/README.md) にある。

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
| Media Assignment Service | 会議を、どのリージョンのどの Media Node に置くかを決める。負荷と参加者の位置を見る（[ADR-0012](../decisions/0012-media-assignment-and-cascading.md)） |
| Media Node | SFU。クライアントから受けた RTP を、他の参加者へ選んで転送する。映像は復号しない（[ADR-0002](../decisions/0002-media-topology.md)） |
| TURN | UDP が通らない参加者のための中継。TCP・TLS の 443 番を含む。coturn（[ADR-0015](../decisions/0015-turn-coturn-and-ephemeral-credentials.md)） |
| Recorder・Transcriber・Composer | SFU から見ると受け手の 1 人として、PlainTransport で音声と映像を受け取る。Recorder は生の RTP を書き、Composer が会議の後に合成する。Transcriber は音声を文字にする。参加者の一覧には出ないが、動いていることを全員に表示する。E2EE の会議には入れない（[ADR-0025](../decisions/0025-recording-per-track-capture-and-offline-compose.md)〜[ADR-0027](../decisions/0027-capture-consent-and-indicators.md)） |
| Aurora PostgreSQL | 会議・予定・アカウント・録画の索引の正本。会議の中の一時的な状態は持たない。組織に属する表は FORCE RLS（[ADR-0058](../decisions/0058-tenant-tables-with-force-rls.md)） |
| Valkey | Meeting Actor の持ち主の記録（リース）と、状態のスナップショット、会議の間のチャット、流量の制限。失われても会議は続く（[ADR-0007](../decisions/0007-meeting-actor-lease-and-epoch.md)） |
| Worker | outbox から、通知、カレンダーの更新、Webhook、録画の後処理を行う |

原則は 4 つ。

- **メディアの経路と、制御の経路を分ける。** Meeting Actor や API が止まっても、流れているメディアは止めない。Media Node は、最後に受けた転送の指示のまま転送を続ける（[ADR-0005](../decisions/0005-meeting-state-and-signaling.md)）。
- **サーバーは選んで転送するだけ。** 映像の符号化と復号はクライアントが行う。サーバーは、帯域に合わせて simulcast の層や SVC の層を選ぶ（[ADR-0002](../decisions/0002-media-topology.md)）。
- **会議の状態の正本は、会議ごとに 1 か所。** 状態の変化は Meeting Actor が順番を決め、連番を付けて全員に配る（[ADR-0005](../decisions/0005-meeting-state-and-signaling.md)）。
- **暗号化は既定、E2EE は選べる。** 通常の会議は DTLS-SRTP でホップごとに暗号化し、サーバーはメディアを扱える。E2EE の会議は SFrame と MLS で暗号化し、サーバーは鍵を持たない（[ADR-0004](../decisions/0004-encryption-and-e2ee.md)）。

## 2. 規模の段階

帯域は、参加者 1 人あたり **下り 2.5 Mbps（容量の前提）**、上り 0.8 Mbps で見積もる。下りの **期待の平均は 1.5 Mbps** で、費用の見込みには両方を並べる。本家のグループ通話の目安は、720p で上り 2.6 Mbps・下り 1.8 Mbps、音声だけで 60〜80 kbps（[Zoom の帯域の要件](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0060748)、2026-09-27 に確認）。

- 1.5 Mbps は、カメラを止めた参加者と、小さく表示される映像を含めた見込みである。全員がカメラをつけてギャラリーで見る会議が中心なら、2.5〜3.5 Mbps になる（[capacity.md](capacity.md) の 2 節）。1.5 Mbps は楽観の可能性があるので、容量（台数、送出、IP transit、クォータ）は 2.5 Mbps で見積もる。
- どちらも**未検証**。E2 のベータで、`qos-report-pipeline` の要約から表示のしかたとカメラの割合を測り、[capacity.md](capacity.md) と [infrastructure.md](infrastructure.md) の 12 節を置き換える。

| 段階 | 同時の会議 | 同時の参加者 | 1 会議の上限 | SFU の送出（ピーク。容量の前提） | 構成 |
| --- | --- | --- | --- | --- | --- |
| S1（MVP） | 5,000 | 3 万 | 100 人 | 約 75 Gbps（期待の平均で約 45 Gbps） | AWS で始める。東京の 1 リージョン・3 AZ。1 会議を 1 台の Media Node に置き、台の中の複数の worker（CPU のコアごと）に広げる。災害復旧は大阪（制御の側と最小の Media Node。メディアは大阪で新しく会議を始め直す）。ピークの送出が 4 週続けて 10 Gbps を超えたら、Edge（コロケーション・ベアメタル）の構築を始める（[ADR-0050](../decisions/0050-disaster-recovery-and-edge-migration.md)） |
| S2 | 5 万 | 30 万 | 300 人 | 約 750 Gbps（同 約 450 Gbps） | 東京と大阪の両方で会議を受ける（大阪は c6gn）。1 会議を複数の Media Node に広げる（リージョンの中のカスケード。pipe は全部の層を運ぶ）。100 人を超える会議の音声は枠の形（[ADR-0057](../decisions/0057-audio-slots-for-large-meetings.md)）。1:1 の P2P を評価する |
| S3 | 30 万 | 200 万 | 1,000 人 | 約 5 Tbps（同 約 3 Tbps） | リージョンをまたぐカスケード（受け手が要る層だけを運ぶ形を S3 の前に ADR にする）。国内の Edge と海外のリージョン。セル構成 |

パケットの数は、映像 1 本（1.5 Mbps、平均 1,200 バイト）で約 160 パケット/秒、音声 1 本（Opus、20ms ごと）で 50 パケット/秒になる。S1 のピークで、SFU の全体で約 1,200 万パケット/秒（送出 約 940 万、受信 約 300 万。平均 1,000 バイトで計算。容量の前提）の見込み（**未検証**。E7 の `load-l0-l2` で 1 台の pps を測って直す）。EC2 はインスタンスごとの PPS の上限を公表していないため、`pps_allowance_exceeded` の指標を見ながら負荷試験で 1 台の上限を決める（[ENA の性能の指標](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/monitoring-network-performance-ena.html)、2026-09-27 に確認）。初期見積もりでは、1 台の上限は帯域より先に consumer と CPU で決まる（[capacity.md](capacity.md) の 3 節）。

段階を上げる判断の基準は [infrastructure.md](infrastructure.md) の 11 節、台数と上限は [capacity.md](capacity.md) の 3〜5 節にある。

## 3. 非機能要件

| ID | 項目 | S1 の目標 | 備考 |
| --- | --- | --- | --- |
| NFR-001 | 遅れ（glass-to-glass） | 日本の中の参加者どうしで、映像の撮影から相手の画面の表示まで p95 300ms 以内。音声（mouth-to-ear）は p95 200ms 以内。**電話からの参加者（MVP の後）は対象の外** | ITU-T G.114 は、片道 150ms 以下で会話がほぼ自然、400ms 以上は許容できないとする。試験の環境で測る（[quality.md](../quality.md) の 2.2.1 節）。電話の参加者には別の目標（p95 400ms）を quality.md で置く（[telephony.md](telephony.md) の 6 節） |
| NFR-002 | 参加の速さ | 参加のボタン（待合室がない場合）から、音声の送受信の開始まで p95 3 秒以内。TURN を経由する場合は p95 5 秒以内 | 2 回目以降の参加（ブラウザのキャッシュあり）で測る |
| NFR-003 | 音声の途切れにくさ | ランダムな損失 20%、揺らぎ 30ms の回線で、音声の客観評価（ViSQOL v3）が MOS 3.0 以上。損失 5% で MOS 3.8 以上 | Opus のインバンド FEC、RED（RFC 2198。[ADR-0017](../decisions/0017-opus-dtx-fec-red.md)）で備える。音声の NACK は使わない。評価の道具と条件は [quality.md](../quality.md) の 2.2.1 節 |
| NFR-004 | 進行中の会議の可用性 | Media Node 1 台の障害で、参加者の音声が 5 秒以内に戻る。Meeting Actor の障害で、メディアは止まらない（制御は 10 秒以内に戻る）。意図しない会議からの脱落は、参加者・時間あたり 0.5% 以下 | 予備の Node への新しい transport での付け替え（ICE restart ではない。[ADR-0013](../decisions/0013-media-node-failover-and-reattach.md)）、Actor のリースと `epoch`（[ADR-0007](../decisions/0007-meeting-actor-lease-and-epoch.md)） |
| NFR-005 | 参加・予定の API の可用性 | 月間 99.95% | 本家の Meetings の SLA は月間 99.9%（再販事業者の配布した [Zoom Availability SLA の写し](https://www.mitel.com/sites/default/files/2025-08/Zoom%20Availability%20SLA_TMP%20%2812Aug25%29%20FINAL%20v1.pdf)、2026-09-27 に確認。一次の文書は未確認） |
| NFR-006 | 1 会議の参加者 | S1 100 人、S2 300 人、S3 1,000 人。全員が音声・映像・画面共有を使える。映像を同時に受けて表示するのは 1 人あたり最大 25 本 | 本家は 100 人から、追加の契約で 500・1,000 人（[Large Meetings](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0065116)、2026-09-27 に確認）。E2EE の会議は S1 で 100 人（[ADR-0030](../decisions/0030-security-code-and-e2ee-feature-limits.md)） |
| NFR-007 | リージョンの同時の参加者 | S1 3 万人、S2 30 万人（東京・大阪の合計）、S3 200 万人 | 2 節 |
| NFR-008 | E2EE の保証 | E2EE の会議では、サーバーはメディアとチャットの鍵を持たない。参加者の退出から 2 秒以内に鍵を更新し、以後のメディアは退出した人に復号できない。参加者は、全員で同じ「会議のセキュリティのコード」を確かめられる | 「退出」は、Meeting Actor が `Left`（切断の猶予 60 秒の後の `Left(dropped)` を含む）か `Removed` を確定した時とする（**PM の確認の項目**）。MLS（RFC 9420）の前方秘匿性と侵害後の安全性に頼る（[ADR-0004](../decisions/0004-encryption-and-e2ee.md)、[ADR-0029](../decisions/0029-mls-delivery-and-authentication-service.md)） |
| NFR-009 | 帯域の適応 | 下りの帯域が半分に下がったら、5 秒以内に映像の層を落として収まり、映像の停止（1 秒以上）を起こさない。下り 150 kbps まで下がっても、音声は続く | GCC（送信側の推定）、Media Node での層の選択（[ADR-0019](../decisions/0019-bandwidth-estimation-and-layer-allocation.md)） |
| NFR-010 | 字幕と録画 | 日本語の字幕を、発話から p95 2 秒以内に表示する。録画は、会議の終了から録画の長さの半分以内に見られるようになり、成功を知らせた録画は失わない | 字幕の正確さは [intent.md](../intent.md) の K7 |

## 4. 技術スタック

| 層 | 選定 | 理由 |
| --- | --- | --- |
| 制御の側の言語 | TypeScript（API、Signaling Gateway、Meeting Actor、Media Node の制御、Web） | 他の題材と同じ。シグナリングのメッセージの型を、サーバーと Web クライアントで共有できる（[ADR-0001](../decisions/0001-platform-and-stack.md)） |
| API | Hono＋Zod | 他の題材と同じ |
| SFU | mediasoup v3（C++ の worker を、Node.js の API から制御する）。RED と、E2EE の VP8・VP9 の Dependency Descriptor の判断を足したフォークを持つ | [ADR-0001](../decisions/0001-platform-and-stack.md)、[ADR-0017](../decisions/0017-opus-dtx-fec-red.md)、[ADR-0028](../decisions/0028-sframe-encoded-transform-and-dependency-descriptor.md) |
| TURN | coturn（UDP・TCP 3478、TLS 443） | [ADR-0015](../decisions/0015-turn-coturn-and-ephemeral-credentials.md) |
| Web クライアント | React＋ブラウザの WebRTC＋mediasoup-client | [ADR-0003](../decisions/0003-client-platform.md)、[ADR-0021](../decisions/0021-web-client-browser-support.md) |
| E2EE | SFrame（RFC 9605）と MLS（RFC 9420）。MLS は OpenMLS（Rust）を WebAssembly にして使う | [ADR-0004](../decisions/0004-encryption-and-e2ee.md)、[ADR-0028](../decisions/0028-sframe-encoded-transform-and-dependency-descriptor.md)〜[ADR-0030](../decisions/0030-security-code-and-e2ee-feature-limits.md) |
| アプリ（MVP の後） | デスクトップは Electron、モバイルはネイティブ。共通のコアは Rust（シグナリングの状態機械と E2EE の鍵管理） | [ADR-0023](../decisions/0023-desktop-electron-mobile-native.md)、[ADR-0024](../decisions/0024-shared-rust-core-and-test-vectors.md) |
| 音声認識 | Amazon Transcribe streaming（ja-JP、東京）を ASR Adapter の裏で | [ADR-0026](../decisions/0026-asr-engine-amazon-transcribe-with-adapter.md) |
| 認証 | Better Auth を自前でホスト（Slack の題材と同じ） | [ADR-0038](../decisions/0038-organizations-users-roles-and-sso.md) |
| DB | Aurora PostgreSQL 18。組織に属する表は FORCE RLS | 他の題材と同じ（[ADR-0058](../decisions/0058-tenant-tables-with-force-rls.md)） |
| 会議の状態の補助 | Valkey（Meeting Actor のリース、状態のスナップショット、チャット、流量の制限） | [ADR-0005](../decisions/0005-meeting-state-and-signaling.md)、[ADR-0007](../decisions/0007-meeting-actor-lease-and-epoch.md) |
| 実行基盤（制御） | AWS（ECS Fargate、Aurora、ElastiCache、SQS、S3、CloudFront）。東京、災害復旧は大阪 | 他の題材と同じ |
| 実行基盤（メディア） | EC2 の `media-prod` のアカウント（東京は c8gn.16xlarge、大阪は c6gn.16xlarge）。パブリック IP（BYOIP）を直接持つ。閾値を超えたら Edge（コロケーション・ベアメタル） | [ADR-0001](../decisions/0001-platform-and-stack.md)、[ADR-0048](../decisions/0048-accounts-network-and-media-regions.md)〜[ADR-0050](../decisions/0050-disaster-recovery-and-edge-migration.md) |
| IaC | Terraform | 他の題材と同じ |
| 可観測性 | OpenTelemetry（ADOT）→ AMP、X-Ray、CloudWatch Logs。メディアの品質の数値（`getStats`、RTCP）は `qos.report` → Firehose → S3・Athena | [observability.md](observability.md)、[ADR-0051](../decisions/0051-qos-telemetry-pipeline.md)、[ADR-0052](../decisions/0052-media-slis-and-mos-estimation.md) |
| ネットワークの劣化の試験 | `media-lab` の EC2 の上の名前空間と `tc netem`。Playwright で実際のブラウザを動かす。Safari は macOS の dummynet | [ADR-0054](../decisions/0054-network-impairment-lab.md)、[quality.md](../quality.md) |

## 5. 主な決定

| ADR | 決定 |
| --- | --- |
| [0001](../decisions/0001-platform-and-stack.md) | 制御の側は他の題材の基盤を引き継ぎ、メディアは EC2 の上の mediasoup で中継する |
| [0002](../decisions/0002-media-topology.md) | 多人数は SFU で中継し、1:1 も SFU を通す。大きな会議は SFU をカスケードし、映像は simulcast と SVC で送る |
| [0003](../decisions/0003-client-platform.md) | Web クライアントはブラウザの WebRTC を使い、ネイティブのアプリは共通のコア（Rust）と libwebrtc で作る |
| [0004](../decisions/0004-encryption-and-e2ee.md) | 既定は DTLS-SRTP のホップごとの暗号化にし、選べる E2EE は SFrame と MLS で作る |
| [0005](../decisions/0005-meeting-state-and-signaling.md) | 会議の状態は会議ごとに 1 つの Meeting Actor が持ち、WebSocket のシグナリングと、会議を Media Node に割り当てるサービスで動かす |
| [0006](../decisions/0006-meeting-id-and-join-url.md) | 会議の ID は秘密にしない 11 桁の乱数にし、URL のフラグメントに 128 ビットの参加の鍵を置く |
| [0007](../decisions/0007-meeting-actor-lease-and-epoch.md) | Meeting Actor の持ち主は Valkey のリース（TTL 6 秒）で決め、取るたびに epoch を上げる。失ってはならない変更は配る前に Aurora に書く |
| [0008](../decisions/0008-signaling-protocol.md) | シグナリングは WebSocket の上の JSON で、版はサブプロトコルで決め、状態は (epoch, seq) 付きのスナップショットと差分で配る |
| [0009](../decisions/0009-host-controls-enforcement.md) | 主催者の操作は Meeting Actor が決定表で判定し、メディアの操作は Media Node で強制する。ミュートの解除とビデオの開始は本人の同意なしにしない |
| [0010](../decisions/0010-media-node-process-layout.md) | Media Node は vCPU−2 個の mediasoup の worker を持ち、worker ごとの WebRtcServer で固定のポートを共有し、会議を worker の間で pipeToRouter でつなぐ |
| [0011](../decisions/0011-forwarding-and-layer-selection.md) | 何を誰に送るかは Meeting Actor が決め、帯域の中での層は Media Node が選ぶ。音声は受け手ごとに最大 3 本にし、キーフレームの要求はまとめる |
| [0012](../decisions/0012-media-assignment-and-cascading.md) | Media Assignment Service は資源の使用率の最大で点を付けて無作為の 2 台から選び、1 台に収まらない会議は PipeTransport で 1 ホップにつなぐ |
| [0013](../decisions/0013-media-node-failover-and-reattach.md) | Media Node の障害は心拍とクライアントの途絶の報告で判定し、予備の Node へ新しい transport でつなぎ直し、音声を先に戻す |
| [0014](../decisions/0014-ice-strategy.md) | Media Node は ICE Lite で公開の host の候補（UDP と ICE-TCP）だけを出し、単独の STUN のサーバーを置かない |
| [0015](../decisions/0015-turn-coturn-and-ephemeral-credentials.md) | TURN は coturn を自前で動かし、UDP・TCP 3478 と TLS 443 で待ち、一時的な資格情報を使い、中継の相手を Media Node に限る |
| [0016](../decisions/0016-media-edge-addressing-and-security-groups.md) | Media Node と TURN は公開する範囲の Elastic IP と IPv6 を持ち、メディアのポートだけを全開の規則にして接続の追跡を外す |
| [0017](../decisions/0017-opus-dtx-fec-red.md) | 音声は Opus の DTX とインバンド FEC を常に使い、RED は mediasoup に転送と剥がしを足して使う |
| [0018](../decisions/0018-video-codec-and-layering-selection.md) | カメラの映像は VP8 の simulcast を既定にし、全員が Chromium の会議だけ VP9 の SVC にする。AV1 は S1 ではフラグの裏に置く |
| [0019](../decisions/0019-bandwidth-estimation-and-layer-allocation.md) | 上りの推定はブラウザの GCC に任せ、下りは Media Node が受け手ごとに推定して優先度の順に層を配る。映像の FEC は使わない |
| [0020](../decisions/0020-screen-share-encoding.md) | 画面共有は解像度を保ち、`contentHint: "detail"` と低いフレームの数で送る。層は時間の層だけにする |
| [0021](../decisions/0021-web-client-browser-support.md) | 対応ブラウザは主要な 4 つの最新 2 メジャーにし、機能の差は参加の前に端末で調べて Meeting Actor に申告する |
| [0022](../decisions/0022-on-device-media-processing.md) | 仮想背景は MediaPipe の Selfie Segmenter を WebGPU でワーカーの中で動かし、強い雑音の抑制は RNNoise を AudioWorklet で動かす |
| [0023](../decisions/0023-desktop-electron-mobile-native.md) | デスクトップアプリは Electron で Web クライアントを包み、モバイルアプリはネイティブと自前の libwebrtc で作る |
| [0024](../decisions/0024-shared-rust-core-and-test-vectors.md) | 共通のコア（Rust）は IO を持たない状態機械と鍵管理にし、TypeScript の状態機械とは同じ試験のベクトルで揃える |
| [0025](../decisions/0025-recording-per-track-capture-and-offline-compose.md) | 録画は SFU から producer ごとの生の RTP を受けて書き、1 本の動画への合成は会議の後に行う |
| [0026](../decisions/0026-asr-engine-amazon-transcribe-with-adapter.md) | 日本語の音声認識は、S1 では Amazon Transcribe の ja-JP のストリーミングを話者ごとの流れで使い、エンジンは ASR Adapter の裏に置く |
| [0027](../decisions/0027-capture-consent-and-indicators.md) | 録画・文字起こしの間は、本人が同意するまで話させない。表示できないクライアントは入れず、E2EE の会議では 3 か所で開始を拒否する |
| [0028](../decisions/0028-sframe-encoded-transform-and-dependency-descriptor.md) | SFrame はフレームごとに AES-128-GCM で暗号化し、Web では RTCRtpScriptTransform の中で動かす。Media Node は Dependency Descriptor で層を選ぶ |
| [0029](../decisions/0029-mls-delivery-and-authentication-service.md) | Meeting Actor が MLS の DS としてエポックごとの順序を決め、AS は会議の間だけ有効な証明書を出す。参加は外部コミット、退出は Actor の Remove の提案で 2 秒以内に鍵を替える |
| [0030](../decisions/0030-security-code-and-e2ee-feature-limits.md) | 会議のセキュリティのコードは MLS の epoch_authenticator から作り、E2EE で動かない機能は 3 か所で拒む。参加者の上限は S1 で 100 人 |
| [0031](../decisions/0031-waiting-room-and-passcode-rules.md) | すべての会議に待合室かパスコードを必ず付け、待合室は身元でしか省けない。パスコードは既定 6 桁の数字で、暗号化と HMAC で持つ |
| [0032](../decisions/0032-removal-ban-suspend-and-reports.md) | 退出させたゲストは端末の鍵で ban し、同じ回線は待合室に回す。活動の一時停止は 1 回の操作で行い、報告は会議の中から送る |
| [0033](../decisions/0033-join-rate-limits-and-enumeration-defense.md) | 参加の要求を IP・会議・パスコードの誤りの軸で制限し、応答と時間をそろえ、番号を多く試す IP には CAPTCHA を求める |
| [0034](../decisions/0034-scheduled-recurring-meetings-and-pmi.md) | 予定は現地の時刻と IANA のタイムゾーンで持ち、繰り返しは RRULE の一部で表す。PMI は 10 桁を CSPRNG で割り当て、待合室を強める |
| [0035](../decisions/0035-calendar-integration-add-ons-and-oauth.md) | カレンダーの連携は、カレンダーの画面のアドオン・アドインと、OAuth で予定を書く入口の両方で行い、変更は通知と毎日の差分で取り込む |
| [0036](../decisions/0036-in-meeting-chat-ordering-and-retention.md) | 会議の中のチャットは状態の seq と別の番号で順序を決めて eph で配り、会議の後は既定で消す |
| [0037](../decisions/0037-chat-files-reactions-and-raise-hand.md) | チャットのファイルは検査を通したものだけを別のドメインから配り、リアクションは一時的なイベント、挙手は参加者の状態にする |
| [0038](../decisions/0038-organizations-users-roles-and-sso.md) | ユーザーは 1 つの組織に属し、ロールは 3 つに固定する。ログインと SSO は Better Auth を自前でホストし、ID の基盤を替えられる境界を保つ |
| [0039](../decisions/0039-settings-hierarchy-and-locks.md) | 設定は組織・グループ・ユーザー・会議の順に 1 つの関数で解決し、上の鍵は下で変えられない。安全の項目は開催の開始で解決し直す |
| [0040](../decisions/0040-usage-reports.md) | 利用状況のレポートは Aurora の参加の記録と毎日の集計の表から作り、S1 ではデータの倉庫を持たない |
| [0041](../decisions/0041-pstn-via-carrier-sip-trunk-and-own-gateway.md) | 電話の網とは国内の事業者の SIP トランクでつなぎ、SIP の入口・IVR・会議の音声との橋を自前で持つ |
| [0042](../decisions/0042-dial-in-numbers-ivr-and-dial-out-limits.md) | ダイヤルインは共用の 050 の番号と IVR で受け、発信者の番号は下 4 桁だけを見せる。ダイヤルアウトは既定で無効にし、宛先と量を絞る |
| [0043](../decisions/0043-public-api-oauth-apps-and-rate-limits.md) | 公開 API は別のサービスにし、アプリは OAuth（PKCE 必須）とサーバー間の 2 種類、レート制限は重さで分けた 4 つの分類にする |
| [0044](../decisions/0044-signed-webhooks-standard-webhooks.md) | Webhook は Standard Webhooks の形で署名し、URL を確かめてから送り、会議の内容を載せずに少なくとも 1 回届ける |
| [0045](../decisions/0045-ddos-defense-for-media-edge.md) | Shield Advanced は入口（CloudFront・ALB・Route 53）を常に守り、Media Node と TURN の EIP は攻撃のときだけ守る。Media Node には送信元を絞る防御のモードを持たせる |
| [0046](../decisions/0046-audit-logs-and-data-lifecycle.md) | 監査ログは 3 系統に分けて DB に 1 年、log-archive に 7 年置く。会議の内容は既定で残さず、IP と品質の記録は短く持つ |
| [0047](../decisions/0047-keys-and-operator-access-to-media.md) | 鍵は用途ごとに KMS の鍵を分け、録画は組織を暗号化の文脈で分ける。運用者は会議に見えない形で入れず、メディアに触れるアカウントは別にする |
| [0048](../decisions/0048-accounts-network-and-media-regions.md) | メディアに触れる部品は media-prod のアカウントに置き、制御の側とは VPC のピアリングでつなぐ。S1 のメディアは東京の 3 AZ、大阪は災害の備え、海外は S3 から |
| [0049](../decisions/0049-media-node-fleet.md) | Media Node は c8gn.16xlarge を AZ ごとの Auto Scaling グループで動かし、BYOIP の範囲の EIP をライフサイクルフックで付ける。縮めるのは drain の後だけ |
| [0050](../decisions/0050-disaster-recovery-and-edge-migration.md) | リージョンの障害では進行中の会議を守らず、大阪で新しい会議を受ける。Media Node をコロケーションへ移す判断は、転送の量の閾値で S1 の間に始める |
| [0051](../decisions/0051-qos-telemetry-pipeline.md) | メディアの品質の数値は、クライアントの getStats の 10 秒ごとの要約をシグナリングで送り、SFU の数値と合わせて S3 に置く。Prometheus には参加者の単位のラベルを入れない |
| [0052](../decisions/0052-media-slis-and-mos-estimation.md) | 音声の品質は E-model（G.107）の式で MOS を推定し、試験の ViSQOL で係数を合わせる。SLO は「良い参加者・分」の割合と、参加の成功率・脱落率・付け替えの時間で持つ |
| [0053](../decisions/0053-capacity-model-cost-target-and-load-bots.md) | 容量は consumer と pps と送出の 3 つで見積もり、1 台の上限は負荷試験で決める。K8 は参加者・分あたり S1 で 0.20 円、S2 で 0.07 円を目標にする。負荷試験は Pion の軽いボットと少数の実ブラウザで行う |
| [0054](../decisions/0054-network-impairment-lab.md) | 回線の劣化の試験は、media-lab の EC2 の上で、参加者ごとのネットワークの名前空間と tc netem で作る。Safari は macOS の dummynet で夜間に回す |
| [0055](../decisions/0055-media-node-rolling-replacement.md) | Media Node と TURN はその場で更新せず、新しい AMI の台を足して古い台を drain する。カナリアの台の会議の品質を比べてから、日ごとの波で入れ替える |
| [0056](../decisions/0056-client-release-trains-and-meeting-scoped-flags.md) | Web クライアントは毎日出せるが段階的に広げ、アプリは 2 週ごとの列車で出す。メディアに関わるフラグは開催の開始で決めて会議の中で揃える |
| [0057](../decisions/0057-audio-slots-for-large-meetings.md) | 100 人を超える会議の音声は、受け手ごとに 3 つの「音声の枠」を持たせ、話者の音声を枠へ付け替えて送る |
| [0058](../decisions/0058-tenant-tables-with-force-rls.md) | 組織に属する Aurora の表は org_id を持ち、FORCE RLS で組織を分ける。API の認可はその上に重ねる |

リポジトリ共通の決定（開発プロセス、トランクベース開発、本家の名前を識別子に使わない [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）は、ルートの [docs/decisions/](../../../../docs/decisions/README.md) にある。

## 6. リスクと未解決事項

品質の面のリスクの順位と対策は [quality.md](../quality.md) の 1 節にある。ここは設計の面のリスクを書く。

- **転送の費用**：会議の費用の約 8 割は、SFU からインターネットへの転送である。S1 のピークの送出は、容量の前提で約 75 Gbps、期待の平均で約 45 Gbps。AWS の表の料金の K8（参加者・分あたりのメディアの配信の費用）は、下り 1.5 Mbps で約 0.18 円、2.5 Mbps で約 0.28 円である（[infrastructure.md](infrastructure.md) の 12 節）。**S1 を AWS で容量の前提（2.5 Mbps）のまま動かすと、S1 の目標（0.20 円）に届かない。** 届くかは、下りの実測と Edge の判断に掛かる。目標の値は残し、PM と Ops の確認の項目にする。AWS と Edge の損益の分かれ目はピークの送出で約 8〜10 Gbps で、S1 の途中で越えうる。S1 は AWS で始め、4 週続けて 10 Gbps を超えたら Edge の構築を始める（[ADR-0001](../decisions/0001-platform-and-stack.md)、[ADR-0050](../decisions/0050-disaster-recovery-and-edge-migration.md)）。Edge の費用の仮定の多くは**未検証**（E12 の `edge-evaluation` で確かめる）。
- **Edge の運用の体制**：Edge には、24 時間の当番、自社の AS と BGP の運用、機器と回線の障害の対応、transit の事業者との DDoS の緩和の契約が要る（[infrastructure.md](infrastructure.md) の 12.3 節の「運用の人」3 人）。今の体制にはなく、採用か委託で用意するには、構築の 2 四半期より長くかかりうる。そこで、Edge の構築の閾値（4 週続けて 10 Gbps）の手前に判断の点を置く。ピークの送出が 2 週続けて 5 Gbps を超えたら、PM と Ops が体制を持つかを決める。持たないと決めたら、閾値を超えても Edge を作らず、AWS との料金の合意か国内のベアメタルのクラウドを選ぶ。その場合、S1 の K8 の目標は見直しが要る（[ADR-0050](../decisions/0050-disaster-recovery-and-edge-migration.md) の注記、[infrastructure.md](infrastructure.md) の 11 節）。
- **下りの平均の見込み**：1.5 Mbps は楽観の可能性がある。容量は 2.5 Mbps で見積もり、E2 のベータで測って置き換える（2 節）。
- **EC2 のネットワークの上限**：PPS の上限は公表されていない。インターネットゲートウェイを通る通信は、32 vCPU 未満のインスタンスで 5 Gbps、それ以上でインスタンスの帯域の 50% に制限される。1 本のフロー（5 タプル）は、クラスタのプレイスメントグループの外では 5 Gbps に制限される（[EC2 のネットワークの帯域](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-instance-network-bandwidth.html)、2026-09-27 に確認）。1 台の上限は E7 の負荷試験で決める（[ADR-0053](../decisions/0053-capacity-model-cost-target-and-load-bots.md)）。
- **セキュリティグループの接続の追跡**：UDP のフローも追跡され、インスタンスごとの上限を超えるとパケットが捨てられる。送信元と宛先を全開（0.0.0.0/0）にした規則は追跡されない（[接続の追跡](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/security-group-connection-tracking.html)、2026-09-27 に確認）。Media Node のメディアのポートは追跡しない規則にし、防御は SFU の側の検査（ICE の認証、DTLS）で行う。NLB は通さない（[ADR-0016](../decisions/0016-media-edge-addressing-and-security-groups.md)）。
- **mediasoup のフォーク**：RED の転送と剥がし（[ADR-0017](../decisions/0017-opus-dtx-fec-red.md)）と、E2EE の会議の VP8・VP9 の Dependency Descriptor の判断（[ADR-0028](../decisions/0028-sframe-encoded-transform-and-dependency-descriptor.md)）を、C++ の worker に足す。上流に取り込まれるまで、版を上げるたびに差分の試験を回す。C++ を読める人が要る。
- **大きな会議の音声**：受け手ごとに全員の音声の consumer を作る形は、人数の 2 乗で増える（300 人で約 9 万、1,000 人で約 100 万）。100 人を超える会議は音声の枠の形にする（[ADR-0057](../decisions/0057-audio-slots-for-large-meetings.md)）。転送器の性能と切り替えの聞こえ方は、E7 の PoC で確かめる。
- **ブラウザの違い**：Safari・Firefox・Chrome で、simulcast、SVC（[WebRTC-SVC](https://www.w3.org/TR/webrtc-svc/)、2026-09-27 に確認した時点で Working Draft）、Encoded Transform（[WebRTC Encoded Transform](https://www.w3.org/TR/webrtc-encoded-transform/)、同じく Working Draft）、RED、Dependency Descriptor の対応が異なる。対応表は [clients.md](clients.md) の 2.2 節に持ち、E2E の試験を各ブラウザで回す。
- **大きな会議のキーフレームの要求**：受け手が多い会議では、受け手のキーフレームの要求（PLI・FIR）が送り手に集まり、送り手の送出が 2〜3 倍に増えうる（[mediasoup の Scalability](https://mediasoup.org/documentation/v3/scalability/)、2026-09-27 に確認）。SFU で要求をまとめ、頻度を抑える（[ADR-0011](../decisions/0011-forwarding-and-layer-selection.md)）。
- **Meeting Actor の二重化と Valkey の切り替え**：ネットワークの分断で、同じ会議の Actor が 2 つ動くと、状態が分かれる。リースにフェンシングの番号（epoch）を付け、古い epoch の指示を Media Node・Gateway・Aurora が拒否する（[ADR-0007](../decisions/0007-meeting-actor-lease-and-epoch.md)）。Valkey の primary の切り替えが 4.5 秒を超えると全会議の Actor が止まり、取り直しが集中する。メディアは止まらない。
- **メディアの IP への DDoS**：Media Node と TURN は公開の範囲の IP を持つ。Shield Advanced は入口を常に守り、メディアの EIP は攻撃のときだけ守る。Shield Advanced は IPv6 を守れないので、防御のモードの Node は IPv6 の候補を出さない（[ADR-0045](../decisions/0045-ddos-defense-for-media-edge.md) とその注記）。
- **日本語の字幕の品質**：S1 は Amazon Transcribe を使うが、日本語の CER と遅れは**未検証**で、E8 の `asr-evaluation-set` で測る（東京の streaming の料金は 1 分 0.01 USD と確かめた）。Transcribe は大阪に無く、大阪への切り替えの間は字幕が止まる。専門用語、固有名詞、話者の重なりで誤りが増える。E8 の前に評価用の音声のセットで比べる（[ADR-0026](../decisions/0026-asr-engine-amazon-transcribe-with-adapter.md)）。
- **法令**：電気通信事業法の届出、通信の秘密、録画の同意、捜査機関への対応、外部送信規律、個人情報、電話番号、契約は、法務の確認待ち（[intent.md](../intent.md) の L1〜L8）。結論が出るまで、該当する Story の spec を承認しない。

### 決定（2026-09-27、既定案）

PM の方針（既定案で進め、問いにしない）により、統合の工程で次のとおり決めた。法務の判断が要るものは決めず、[intent.md](../intent.md) の「法務の確認待ち」（L1〜L8）に残した。

- **ADR と intent の状態**：基盤の ADR（0001〜0005）と intent.md を、他の題材と同じく `accepted` にした。先に次を直した。
  - ADR-0001：S1 は AWS で始める。Edge（コロケーション・ベアメタル）の構築は、ピークの送出が 4 週続けて 10 Gbps を超えたら始める（ADR-0050）。損益の分かれ目は約 8〜10 Gbps で、S1 の途中で越えうる。大阪には c7gn・c8gn がないので c6gn を使う（ADR-0049）。S1 の送出を容量の前提の 75 Gbps に直した。
  - ADR-0002：Node の間の pipe は producer のすべての層を運ぶ。Node をまたいで受け手ごとに層を絞ることは S3 の課題にした。RED は mediasoup のフォークが要る（ADR-0017）。100 人を超える会議の音声は ADR-0057。
  - ADR-0003：デスクトップとモバイルの方式を ADR-0023・0024 に揃え、`RTCRtpScriptTransform` の対応を ADR-0021 に揃えた。
  - ADR-0004：E2EE はペイロードからの VP8 のキーフレームと層の判定を壊すので、mediasoup に VP8・VP9 の Dependency Descriptor の判断を足す（ADR-0028）。「退出」の定義と、E2EE のチャット（`e2ee.app`、`chat_seq`、Valkey には暗号文だけ、個別のメッセージは使えない）を書いた。
  - ADR-0005：別の Media Node へ移るには新しい transport が要り、ICE restart ではない（[media-server-sfu.md](media-server-sfu.md) の 9.3 節）。シグナリングの版の受け方を N−1（Web）・N−2（アプリ）にした。
- **新しい ADR**：
  - [ADR-0057](../decisions/0057-audio-slots-for-large-meetings.md)：100 人を超える会議は、受け手ごとに 3 つの音声の枠。`DirectTransport`・`PipeTransport` の上の枠の切り替えの転送器。E7 の `audio-slot-forwarder-poc` の後に E10 で作る。
  - [ADR-0058](../decisions/0058-tenant-tables-with-force-rls.md)：組織に属する表は `org_id` と FORCE RLS（他の題材と同じ）。API の認可はその上に重ねる（[data-model.md](data-model.md) の持ち越しだった）。
- **容量の前提**：下り 2.5 Mbps で容量を見積もり、1.5 Mbps は期待の平均として残す。E2 のベータで測る。2 節、[capacity.md](capacity.md)、[infrastructure.md](infrastructure.md) の 12 節（費用は両方を並べた）を直し、ADR-0053 に注記した。
- **NFR**：
  - NFR-001 は電話からの参加者を対象の外にした。電話の参加者の目標は [quality.md](../quality.md) に別に置く（p95 400ms、E14 で確かめる）。
  - NFR-008 の「退出」は、Actor が `Left`（切断の猶予の後の `Left(dropped)` を含む）か `Removed` を確定した時とした。**PM の確認の項目**。
- **`ip_prefix_hash` の pepper**：30 日ごとに替えるが、前の pepper を 30 日残して両方で照合する。`meeting_removals` に pepper の版を持つ（[meeting-security.md](meeting-security.md) の 10 節、ADR-0032 の注記）。
- **IPv6 と DDoS**：防御のモード（`under_attack`）の Node は IPv6 の候補を出さない（[network-traversal.md](network-traversal.md) の 9 節、[security.md](security.md) の 8.3 節、ADR-0045 の注記）。
- **シグナリングの版**：Web は N−1、アプリは N−2 まで受け、`min_client_version` より古いものは強制の更新（ADR-0008・0056 の注記、[delivery.md](delivery.md) の 5.3 節）。
- **シグナリングのスキーマ**：他の領域が足した `chat.*`、`reaction.*`、`consent.give`、`host.suspend`・`host.readmit`・`host.admit_all`・`host.to_waiting`・`host.invite`・`host.lower_hands`、`hello.client.features`、`client.kind = "phone"`、録画・字幕・E2EE・品質のメッセージを、[signaling-and-meetings.md](signaling-and-meetings.md) の 6.2 節に集めた。主催者の操作の決定表（9.2 節）にも行を足した。
- **E2EE のチャット**：[e2ee.md](e2ee.md) と [chat-and-reactions.md](chat-and-reactions.md) を揃えた。`e2ee.app` に `chat_seq`・`ch_seq` を付けて配る。Valkey には取りこぼしを埋めるための暗号文だけを置く。個別のメッセージとファイルは使えない。e2ee.md の 12 節に行を足した。
- **データモデル**：`meeting_participations` に codecs と clients が別々に提案した列を 1 つにまとめた。監査ログ 3 系統のハッシュの連鎖の列、outbox を 1 つの表にすること、保持の削除のジョブを 1 つにすることを決めた（[data-model.md](data-model.md) の 11 節）。
- **Epic**：E1〜E12 が MVP（S1）。公開 API と Webhook を E11（旧 E12）、運用と GA の準備を E12 にした。アプリは E13（旧 E11）、電話からの参加は E14、ウェビナーは E15、ブレイクアウトルームは E16（いずれも MVP の後）。`org-user-model`・`identity-better-auth` を E2 へ（E2 のベータの主催者のログインに要る）、`phone-join-rate-limits` を E14 へ移した（[roadmap.md](../roadmap.md)）。
- **数値の正本**：SLO とアラートは [runbooks/README.md](../runbooks/README.md) の 1・4 節。品質の閾値は [quality.md](../quality.md)。シグナリングの上限は [signaling-and-meetings.md](signaling-and-meetings.md) の 6.3 節、参加の流量は [meeting-security.md](meeting-security.md) の 8.2 節、1 台の上限と台数は [capacity.md](capacity.md) の 3・5 節、費用は [infrastructure.md](infrastructure.md) の 12 節、K8 の目標は capacity.md の 6 節、保持の期間は [security.md](security.md) の 9 節。
- 本家の名前は識別子に使わない（`<brand>`・`<Brand>`。リポジトリ共通の ADR-0006）。
- 領域ごとの決定は、各文書の「未解決の問い」の「決定」の節にある。

### 確認の工程（2026-09-27）

「未検証」の項目を一次の資料で確かめ、決着したものは出典と確認日を付けた。PoC や計測が要るものは「未検証」のまま、確かめる Story を書いた。設計を変えたものは次のとおり（ADR は注記を付けた）。

- **RED は distance 1**：libwebrtc は冗長を 1 つしか作らず、Web のページから増やせない。ADR-0017 の distance 2 を取り消し、受け手ごとに残すか剥がすかだけにした。上りは最大約 2 倍、1 本は約 90 kbps（[codecs-and-bandwidth-adaptation.md](codecs-and-bandwidth-adaptation.md) の 4 節、[capacity.md](capacity.md) の 2 節）。
- **mediasoup は音声を下りの割り当てに入れない**：映像が推定の全部を使いうるので、音声の分を残す方法を E4 の `downlink-allocation` で決める。`priority` は重みの周回で、「高い順に満たす」ではない（codecs の 6.3・6.4 節）。
- **Transcribe は大阪に無い**：大阪への切り替えの間は字幕と文字起こしを止める（ADR-0026・0050、[infrastructure.md](infrastructure.md) の 8.3 節、[disaster-recovery.md](../runbooks/disaster-recovery.md)）。
- **大阪の TURN は c6gn.8xlarge**：大阪に c8gn がない（infrastructure の 5・12 節）。
- **Firehose の既定の上限**：東京は 1 ストリーム 1 MiB/秒で、品質の記録（約 6 MB/秒）に足りない。まとめて送り、上限を引き上げる（[capacity.md](capacity.md) の 5.4 節）。
- **KMS の Ed25519**：参加のトークンの署名を Ed25519 に決め、E2EE の外部の送り手の鍵を KMS へ移した（ADR-0047、鍵は 6 つ）。
- **TURN の TLS の証明書**：ACM の書き出せる公開の証明書を使う。ワイルドカードの制約から名前を `<region>-<az>-<nn>.turn.<brand>.<domain>` に改めた（[security.md](security.md) の 5 節、[network-traversal.md](network-traversal.md)）。
- **Shield Advanced の EIP の保護**：事象の報告は保護から 15 分以上たってから。攻撃のときに加える決定は保ち、最初の 15 分以上は Shield Standard と防御のモードで耐える（ADR-0045 の注記）。
- **SLO の窓**：28 日から 30 日に改めた（他の題材と同じ。[runbooks/README.md](../runbooks/README.md) の 1 節、ADR-0052 の注記）。
- **公開 API**：E11 を MVP に残し、intent.md の MVP に足した（PM の確認の項目）。
- **K8**：S1 を AWS で容量の前提のまま動かすと届かないこと、達成が Edge の判断に掛かることを明記した。目標の値は残し、PM と Ops の確認の項目にした（ADR-0053 の注記）。
- **Edge の運用の体制**：リスクに足し、Edge の閾値の手前に判断の点（2 週続けて 5 Gbps）を置いた（ADR-0050 の注記）。

持ち越し（計測・PoC・他者の確認で決めるもの）：

| 項目 | いつ・どう決めるか |
| --- | --- |
| 下りの平均（1.5 Mbps か 2.5 Mbps か）、表示のしかたとカメラの割合、TURN を通る参加者の割合 | E2 のベータで `qos-report-pipeline` の要約から測る |
| 1 台の Media Node の上限（consumer、pps、送出、CPU）、c8gn と c8g の比較 | E7 の `load-l0-l2` |
| 音声の枠の転送器の性能と聞こえ方（`DirectTransport` か別のプロセスか） | E7 の `audio-slot-forwarder-poc` |
| RED の効果（FEC だけ・distance 1 ＋ FEC）、mediasoup の帯域の割り当てで音声の分を残す方法（mediasoup は音声を割り当てに入れない） | E4 の `red-forwarding`・`downlink-allocation` |
| `mos_est` の係数（`Ie`・`Bpl`）と ViSQOL の差 | E4 の `mos-est-calibration` |
| E2EE の depacketizer・Safari の DD・SVC の層ごとのフレーム | E9 の `e2ee-poc-transform` |
| Transcribe の日本語の CER・遅れ | E8 の前の `asr-evaluation-set` |
| BYOIP の範囲の入手の時間と費用 | E1 の `byoip-onboarding` の前（Ops） |
| Shield Advanced の EIP の保護を攻撃のときに加えた直後の緩和の振る舞い | E7 の `shield-advanced-onboarding`（SRT への問い合わせ） |
| CloudFront の WebSocket の長い接続 | E2 の `signaling-via-cloudfront` |
| Safari の VP9・AV1・DD・VP8 の simulcast、Firefox・Safari の RED | E2 の `browser-capability-probe` |
| mediasoup で音声の分を下りの推定から残す方法 | E4 の `downlink-allocation` |
| NFR-008 の「退出」の定義 | PM の確認 |
| 公開 API と Webhook（E11）を MVP に含めるか | PM の確認（intent.md の MVP に入れた） |
| SLO（30 日の窓）の値 | PM と Ops の承認 |
| K8 の目標の値（S1 は AWS の 2.5 Mbps では届かない） | PM と Ops の確認。E2 のベータの実測と、Edge の運用の体制の判断の後 |
| Edge の運用の体制（24 時間の当番、自社の AS と BGP）を持つか | PM と Ops。ピークの送出が 2 週続けて 5 Gbps を超えたとき（Edge の閾値の手前） |
| 法務の確認（L1〜L8） | [intent.md](../intent.md) の表の「承認を止める spec」の前 |

## 7. 領域の文書と ADR の番号の範囲

領域の文書で ADR を起票するときは、その領域に割り当てた範囲の中で採番する。範囲を使い切ったら、0060 以降を使い、この表を更新する。0057〜0059 は領域をまたぐ決定に使う（0057・0058 は統合の工程で使った）。持ち主は、どれも Dev が書き、Epic の番号は [roadmap.md](../roadmap.md) に従う。

| ファイル | 領域 | ADR の範囲 | 主な Epic |
| --- | --- | --- | --- |
| [signaling-and-meetings.md](signaling-and-meetings.md) | 会議の作成と参加、会議の ID と URL、Meeting Actor、シグナリングのプロトコル、主催者の操作、状態の再同期 | 0006〜0009 | E2、E3、E7 |
| [media-server-sfu.md](media-server-sfu.md) | Media Node、転送の規則、層の選択、話者の検出、キーフレームの制御、Media Node の割り当てとカスケード、障害の時の付け替え、音声の枠 | 0010〜0013 | E2、E4、E7、E10 |
| [network-traversal.md](network-traversal.md) | ICE、STUN、TURN（UDP・TCP・TLS 443）、社内のプロキシとファイアウォール、IPv6 | 0014〜0016 | E1、E2、E4 |
| [codecs-and-bandwidth-adaptation.md](codecs-and-bandwidth-adaptation.md) | Opus（DTX、FEC、RED）、VP8・H.264・VP9・AV1、simulcast と SVC、帯域の推定（GCC、transport-cc）、画面共有の符号化 | 0017〜0020 | E2、E4、E5 |
| [clients.md](clients.md) | Web クライアント、対応ブラウザ、端末の処理（仮想背景、雑音の抑制）、アクセシビリティ、デスクトップ・モバイルと共通のコア | 0021〜0024 | E1、E2、E5、E13 |
| [recording-and-transcription.md](recording-and-transcription.md) | クラウド録画（合成、保存、共有、保持）、日本語のライブ字幕と文字起こし、同意の表示 | 0025〜0027 | E8 |
| [e2ee.md](e2ee.md) | SFrame、MLS、Delivery Service と Authentication Service、会議のセキュリティのコード、E2EE で動かない機能 | 0028〜0030 | E9、E13 |
| [meeting-security.md](meeting-security.md) | 待合室、パスコード、ロック、退出させた人の再入室の禁止、荒らしの報告と対処、会議の ID の推測への対策 | 0031〜0033 | E3 |
| [scheduling-and-calendar.md](scheduling-and-calendar.md) | 予定の会議、繰り返し、個人の会議の ID、Google カレンダーと Microsoft 365 の連携 | 0034〜0035 | E6、E12 |
| [chat-and-reactions.md](chat-and-reactions.md) | 会議の中のチャット、個別のメッセージ、ファイル、リアクション、挙手 | 0036〜0037 | E5、E8、E9 |
| [accounts-and-admin.md](accounts-and-admin.md) | 組織のアカウント、ユーザーとロール、SSO、会議の既定の設定と強制、利用状況のレポート | 0038〜0040 | E2、E6、E12 |
| [telephony.md](telephony.md) | 電話からの参加（ダイヤルイン・ダイヤルアウト）、SIP の接続 | 0041〜0042 | E14（MVP の後） |
| [api-and-webhooks.md](api-and-webhooks.md) | 公開 API、Webhook、会議のイベント | 0043〜0044 | E11 |
| [security.md](security.md) | 脅威モデル、暗号化と鍵、監査ログ、濫用の対策、データのライフサイクル | 0045〜0047 | E1、E2、E3、E7、E10、E12 |
| [infrastructure.md](infrastructure.md) | AWS の構成、メディアのリージョンと Edge、Media Node のインスタンスと網、冗長化、災害復旧、費用 | 0048〜0050 | E1、E2、E7、E10、E12 |
| [observability.md](observability.md) | メディアの品質の指標（損失、揺らぎ、RTT、フリーズ、MOS の推定）、ログ、トレース、SLI | 0051〜0052 | E1、E4、E7、E12 |
| [capacity.md](capacity.md) | 負荷のモデル、Media Node 1 台の上限、帯域と PPS、費用と K8、負荷試験 | 0053 | E7、E10、E12 |
| [delivery.md](delivery.md) | CI/CD、ネットワークの劣化の試験の基盤、Media Node の無停止の入れ替え、クライアントのリリース、フラグ | 0054〜0056 | E1、E2、E10 |
| [data-model.md](data-model.md) | データの置き場所の索引と統合した定義 | なし（各領域の ADR と 0058 を参照する） | 全 Epic |

## 8. Epic

Epic と Story の計画は [roadmap.md](../roadmap.md) にある（PM が持つ）。各 Epic の品質の重点と合否基準は [quality.md](../quality.md) の 5 節にある。

| Epic | 中身 |
| --- | --- |
| E1 基盤と品質の計測 | AWS のアカウントと網（`media-prod`、BYOIP）、制御の側の基盤、RLS、鍵、監査ログ、CI とメディアのパス、回線の劣化のラボ、品質の報告の経路、フラグ |
| E2 会議の骨格と Web クライアント（ベータ） | 会議の作成と参加、Meeting Actor、シグナリング、Media Node と割り当て、ICE と TURN、音声と映像の基本、Web クライアント、主催者のログイン |
| E3 会議の安全と主催者の操作 | 待合室とパスコードの不変条件、主催者の操作、ban、一時停止、報告、流量の制限と推測の防御 |
| E4 メディアの品質と帯域の適応 | RED、下りの割り当て、音声の絞り込み、キーフレーム、話者、SVC、`mos_est` の係数、フリーズの SLI |
| E5 画面共有・チャット・端末の処理 | 画面共有、チャットとファイル、リアクションと挙手、仮想背景と雑音の抑制、アクセシビリティ |
| E6 予定・カレンダー・組織と管理 | 予定と繰り返し、PMI、カレンダーの連携、招待とドメイン、SSO、設定の階層、レポート |
| E7 規模と耐障害 | 負荷のボットと L0〜L2、1 台の上限、付け替え、Actor の障害の注入、DDoS の防御のモード、合成の監視、音声の枠の PoC |
| E8 録画と字幕 | 録画の状態と同意、Recorder と Composer、共有と保持、音声認識の評価、ライブ字幕と文字起こし |
| E9 E2EE | SFrame と MLS、DS と AS、鍵の更新、DD の判断、セキュリティのコード、3 か所の拒否、E2EE のチャット |
| E10 大きな会議と Media Node の運用 | drain と make-before-break、カナリアと波、リージョンの中のカスケード、音声の枠、大阪の待機、DR の訓練、保持の削除 |
| E11 公開 API と Webhook | 公開 API、OAuth のアプリ、レート制限、Webhook |
| E12 運用と GA の準備 | 負荷試験 L3〜L5、クォータ、ペンテストと机上訓練、Trust & Safety の画面、Marketplace、組織の削除、Edge の評価、GA の判定 |
| E13 デスクトップ・モバイルのアプリ（MVP の後） | Electron、ネイティブのモバイル、共通のコアと試験のベクトル、libwebrtc |
| E14 電話からの参加（MVP の後） | SIP トランク、IVR、Phone Bridge、ダイヤルアウト |
| E15 ウェビナー・大規模なイベント（MVP の後） | 視聴専用の配信の経路 |
| E16 ブレイクアウトルーム（MVP の後） | 会議の中の小部屋 |

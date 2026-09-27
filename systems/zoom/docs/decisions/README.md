# Decisions: Zoom

Zoom の再構築に関する決定。リポジトリ共通の決定は [docs/decisions/](../../../../docs/decisions/README.md) にある（本家の名前・接頭辞を使わない規則は、その ADR-0006）。領域ごとの設計と、領域ごとの ADR の番号の範囲は [architecture/](../architecture/README.md) の 7 節を見る。accepted の ADR を後から補うときは、本文を書き換えず、日付つきの注記を足す。

<!-- adr-index:start -->
| ADR | 決定 | 状態 |
| --- | --- | --- |
| [0001](0001-platform-and-stack.md) | 制御の側は他の題材の基盤を引き継ぎ、メディアは EC2 の上の mediasoup で中継する | accepted |
| [0002](0002-media-topology.md) | 多人数は SFU で中継し、1:1 も SFU を通す。大きな会議は SFU をカスケードし、映像は simulcast と SVC で送る | accepted |
| [0003](0003-client-platform.md) | Web クライアントはブラウザの WebRTC を使い、ネイティブのアプリは共通のコア（Rust）と libwebrtc で作る | accepted |
| [0004](0004-encryption-and-e2ee.md) | 既定は DTLS-SRTP のホップごとの暗号化にし、選べる E2EE は SFrame と MLS で作る | accepted |
| [0005](0005-meeting-state-and-signaling.md) | 会議の状態は会議ごとに 1 つの Meeting Actor が持ち、WebSocket のシグナリングと、会議を Media Node に割り当てるサービスで動かす | accepted |
| [0006](0006-meeting-id-and-join-url.md) | 会議の ID は秘密にしない 11 桁の乱数にし、URL のフラグメントに 128 ビットの参加の鍵を置く | accepted |
| [0007](0007-meeting-actor-lease-and-epoch.md) | Meeting Actor の持ち主は Valkey のリース（TTL 6 秒）で決め、取るたびに epoch を上げる。失ってはならない変更は配る前に Aurora に書く | accepted |
| [0008](0008-signaling-protocol.md) | シグナリングは WebSocket の上の JSON で、版はサブプロトコルで決め、状態は (epoch, seq) 付きのスナップショットと差分で配る | accepted |
| [0009](0009-host-controls-enforcement.md) | 主催者の操作は Meeting Actor が決定表で判定し、メディアの操作は Media Node で強制する。ミュートの解除とビデオの開始は本人の同意なしにしない | accepted |
| [0010](0010-media-node-process-layout.md) | Media Node は vCPU−2 個の mediasoup の worker を持ち、worker ごとの WebRtcServer で固定のポートを共有し、会議を worker の間で pipeToRouter でつなぐ | accepted |
| [0011](0011-forwarding-and-layer-selection.md) | 何を誰に送るかは Meeting Actor が決め、帯域の中での層は Media Node が選ぶ。音声は受け手ごとに最大 3 本にし、キーフレームの要求はまとめる | accepted |
| [0012](0012-media-assignment-and-cascading.md) | Media Assignment Service は資源の使用率の最大で点を付けて無作為の 2 台から選び、1 台に収まらない会議は PipeTransport で 1 ホップにつなぐ | accepted |
| [0013](0013-media-node-failover-and-reattach.md) | Media Node の障害は心拍とクライアントの途絶の報告で判定し、予備の Node へ新しい transport でつなぎ直し、音声を先に戻す | accepted |
| [0014](0014-ice-strategy.md) | Media Node は ICE Lite で公開の host の候補（UDP と ICE-TCP）だけを出し、単独の STUN のサーバーを置かない | accepted |
| [0015](0015-turn-coturn-and-ephemeral-credentials.md) | TURN は coturn を自前で動かし、UDP・TCP 3478 と TLS 443 で待ち、一時的な資格情報を使い、中継の相手を Media Node に限る | accepted |
| [0016](0016-media-edge-addressing-and-security-groups.md) | Media Node と TURN は公開する範囲の Elastic IP と IPv6 を持ち、メディアのポートだけを全開の規則にして接続の追跡を外す | accepted |
| [0017](0017-opus-dtx-fec-red.md) | 音声は Opus の DTX とインバンド FEC を常に使い、RED は mediasoup に転送と剥がしを足して使う | accepted |
| [0018](0018-video-codec-and-layering-selection.md) | カメラの映像は VP8 の simulcast を既定にし、全員が Chromium の会議だけ VP9 の SVC にする。AV1 は S1 ではフラグの裏に置く | accepted |
| [0019](0019-bandwidth-estimation-and-layer-allocation.md) | 上りの推定はブラウザの GCC に任せ、下りは Media Node が受け手ごとに推定して優先度の順に層を配る。映像の FEC は使わない | accepted |
| [0020](0020-screen-share-encoding.md) | 画面共有は解像度を保ち、`contentHint: "detail"` と低いフレームの数で送る。層は時間の層だけにする | accepted |
| [0021](0021-web-client-browser-support.md) | 対応ブラウザは主要な 4 つの最新 2 メジャーにし、機能の差は参加の前に端末で調べて Meeting Actor に申告する | accepted |
| [0022](0022-on-device-media-processing.md) | 仮想背景は MediaPipe の Selfie Segmenter を WebGPU でワーカーの中で動かし、強い雑音の抑制は RNNoise を AudioWorklet で動かす | accepted |
| [0023](0023-desktop-electron-mobile-native.md) | デスクトップアプリは Electron で Web クライアントを包み、モバイルアプリはネイティブと自前の libwebrtc で作る | accepted |
| [0024](0024-shared-rust-core-and-test-vectors.md) | 共通のコア（Rust）は IO を持たない状態機械と鍵管理にし、TypeScript の状態機械とは同じ試験のベクトルで揃える | accepted |
| [0025](0025-recording-per-track-capture-and-offline-compose.md) | 録画は SFU から producer ごとの生の RTP を受けて書き、1 本の動画への合成は会議の後に行う | accepted |
| [0026](0026-asr-engine-amazon-transcribe-with-adapter.md) | 日本語の音声認識は、S1 では Amazon Transcribe の ja-JP のストリーミングを話者ごとの流れで使い、エンジンは ASR Adapter の裏に置く | accepted |
| [0027](0027-capture-consent-and-indicators.md) | 録画・文字起こしの間は、本人が同意するまで話させない。表示できないクライアントは入れず、E2EE の会議では 3 か所で開始を拒否する | accepted |
| [0028](0028-sframe-encoded-transform-and-dependency-descriptor.md) | SFrame はフレームごとに AES-128-GCM で暗号化し、Web では RTCRtpScriptTransform の中で動かす。Media Node は Dependency Descriptor で層を選ぶ | accepted |
| [0029](0029-mls-delivery-and-authentication-service.md) | Meeting Actor が MLS の DS としてエポックごとの順序を決め、AS は会議の間だけ有効な証明書を出す。参加は外部コミット、退出は Actor の Remove の提案で 2 秒以内に鍵を替える | accepted |
| [0030](0030-security-code-and-e2ee-feature-limits.md) | 会議のセキュリティのコードは MLS の epoch_authenticator から作り、E2EE で動かない機能は 3 か所で拒む。参加者の上限は S1 で 100 人 | accepted |
| [0031](0031-waiting-room-and-passcode-rules.md) | すべての会議に待合室かパスコードを必ず付け、待合室は身元でしか省けない。パスコードは既定 6 桁の数字で、暗号化と HMAC で持つ | accepted |
| [0032](0032-removal-ban-suspend-and-reports.md) | 退出させたゲストは端末の鍵で ban し、同じ回線は待合室に回す。活動の一時停止は 1 回の操作で行い、報告は会議の中から送る | accepted |
| [0033](0033-join-rate-limits-and-enumeration-defense.md) | 参加の要求を IP・会議・パスコードの誤りの軸で制限し、応答と時間をそろえ、番号を多く試す IP には CAPTCHA を求める | accepted |
| [0034](0034-scheduled-recurring-meetings-and-pmi.md) | 予定は現地の時刻と IANA のタイムゾーンで持ち、繰り返しは RRULE の一部で表す。PMI は 10 桁を CSPRNG で割り当て、待合室を強める | accepted |
| [0035](0035-calendar-integration-add-ons-and-oauth.md) | カレンダーの連携は、カレンダーの画面のアドオン・アドインと、OAuth で予定を書く入口の両方で行い、変更は通知と毎日の差分で取り込む | accepted |
| [0036](0036-in-meeting-chat-ordering-and-retention.md) | 会議の中のチャットは状態の seq と別の番号で順序を決めて eph で配り、会議の後は既定で消す | accepted |
| [0037](0037-chat-files-reactions-and-raise-hand.md) | チャットのファイルは検査を通したものだけを別のドメインから配り、リアクションは一時的なイベント、挙手は参加者の状態にする | accepted |
| [0038](0038-organizations-users-roles-and-sso.md) | ユーザーは 1 つの組織に属し、ロールは 3 つに固定する。ログインと SSO は Better Auth を自前でホストし、ID の基盤を替えられる境界を保つ | accepted |
| [0039](0039-settings-hierarchy-and-locks.md) | 設定は組織・グループ・ユーザー・会議の順に 1 つの関数で解決し、上の鍵は下で変えられない。安全の項目は開催の開始で解決し直す | accepted |
| [0040](0040-usage-reports.md) | 利用状況のレポートは Aurora の参加の記録と毎日の集計の表から作り、S1 ではデータの倉庫を持たない | accepted |
| [0041](0041-pstn-via-carrier-sip-trunk-and-own-gateway.md) | 電話の網とは国内の事業者の SIP トランクでつなぎ、SIP の入口・IVR・会議の音声との橋を自前で持つ | accepted |
| [0042](0042-dial-in-numbers-ivr-and-dial-out-limits.md) | ダイヤルインは共用の 050 の番号と IVR で受け、発信者の番号は下 4 桁だけを見せる。ダイヤルアウトは既定で無効にし、宛先と量を絞る | accepted |
| [0043](0043-public-api-oauth-apps-and-rate-limits.md) | 公開 API は別のサービスにし、アプリは OAuth（PKCE 必須）とサーバー間の 2 種類、レート制限は重さで分けた 4 つの分類にする | accepted |
| [0044](0044-signed-webhooks-standard-webhooks.md) | Webhook は Standard Webhooks の形で署名し、URL を確かめてから送り、会議の内容を載せずに少なくとも 1 回届ける | accepted |
| [0045](0045-ddos-defense-for-media-edge.md) | Shield Advanced は入口（CloudFront・ALB・Route 53）を常に守り、Media Node と TURN の EIP は攻撃のときだけ守る。Media Node には送信元を絞る防御のモードを持たせる | accepted |
| [0046](0046-audit-logs-and-data-lifecycle.md) | 監査ログは 3 系統に分けて DB に 1 年、log-archive に 7 年置く。会議の内容は既定で残さず、IP と品質の記録は短く持つ | accepted |
| [0047](0047-keys-and-operator-access-to-media.md) | 鍵は用途ごとに KMS の鍵を分け、録画は組織を暗号化の文脈で分ける。運用者は会議に見えない形で入れず、メディアに触れるアカウントは別にする | accepted |
| [0048](0048-accounts-network-and-media-regions.md) | メディアに触れる部品は media-prod のアカウントに置き、制御の側とは VPC のピアリングでつなぐ。S1 のメディアは東京の 3 AZ、大阪は災害の備え、海外は S3 から | accepted |
| [0049](0049-media-node-fleet.md) | Media Node は c8gn.16xlarge を AZ ごとの Auto Scaling グループで動かし、BYOIP の範囲の EIP をライフサイクルフックで付ける。縮めるのは drain の後だけ | accepted |
| [0050](0050-disaster-recovery-and-edge-migration.md) | リージョンの障害では進行中の会議を守らず、大阪で新しい会議を受ける。Media Node をコロケーションへ移す判断は、転送の量の閾値で S1 の間に始める | accepted |
| [0051](0051-qos-telemetry-pipeline.md) | メディアの品質の数値は、クライアントの getStats の 10 秒ごとの要約をシグナリングで送り、SFU の数値と合わせて S3 に置く。Prometheus には参加者の単位のラベルを入れない | accepted |
| [0052](0052-media-slis-and-mos-estimation.md) | 音声の品質は E-model（G.107）の式で MOS を推定し、試験の ViSQOL で係数を合わせる。SLO は「良い参加者・分」の割合と、参加の成功率・脱落率・付け替えの時間で持つ | accepted |
| [0053](0053-capacity-model-cost-target-and-load-bots.md) | 容量は consumer と pps と送出の 3 つで見積もり、1 台の上限は負荷試験で決める。K8 は参加者・分あたり S1 で 0.20 円、S2 で 0.07 円を目標にする。負荷試験は Pion の軽いボットと少数の実ブラウザで行う | accepted |
| [0054](0054-network-impairment-lab.md) | 回線の劣化の試験は、media-lab の EC2 の上で、参加者ごとのネットワークの名前空間と tc netem で作る。Safari は macOS の dummynet で夜間に回す | accepted |
| [0055](0055-media-node-rolling-replacement.md) | Media Node と TURN はその場で更新せず、新しい AMI の台を足して古い台を drain する。カナリアの台の会議の品質を比べてから、日ごとの波で入れ替える | accepted |
| [0056](0056-client-release-trains-and-meeting-scoped-flags.md) | Web クライアントは毎日出せるが段階的に広げ、アプリは 2 週ごとの列車で出す。メディアに関わるフラグは開催の開始で決めて会議の中で揃える | accepted |
| [0057](0057-audio-slots-for-large-meetings.md) | 100 人を超える会議の音声は、受け手ごとに 3 つの「音声の枠」を持たせ、話者の音声を枠へ付け替えて送る | accepted |
| [0058](0058-tenant-tables-with-force-rls.md) | 組織に属する Aurora の表は org_id を持ち、FORCE RLS で組織を分ける。API の認可はその上に重ねる | accepted |
<!-- adr-index:end -->

この一覧は、各 ADR の frontmatter と見出しから生成したもの。ADR を追加・更新したら生成し直す。

# Roadmap: Zoom

## 進め方の原則

- **最初に walking skeleton を通す。** E1〜E2 で、AWS の `media-prod`・BYOIP・netem のラボ・品質の報告の経路・Signaling Gateway・Meeting Actor（リースと `epoch`）・Media Node（mediasoup）・TURN・Web クライアントを端から端まで貫き、2 つのブラウザで音声と映像が往復するところまで作ってから、機能を広げる。回線の劣化のラボと PR の品質の報告、`epoch` のフェンス、RLS、内容を出さない計装は、E1 から本物の形で作る。後から足すと直せないため。
- **品質は数値で出す。** メディアに触れる Story は、[quality.md](quality.md) の 2.2.1 節の行列の必須の条件を PR で通し、数値を載せる（本題材の [AGENTS.md](../AGENTS.md)）。
- **社外への公開の前に守りをそろえる。** E2 のベータを社外に出すのは、E3 の `join-guard-invariant`・`passcode-format-storage`・`waiting-room-core`・`join-rate-limits` と、法務の L1・L5 の後にする（待合室もパスコードもない会議を作れない状態で出さない）。
- **PoC を先に済ませる。** 次の PoC は、それぞれの Epic の Story の spec を承認する前に結果を記録する：E2EE のブラウザの振る舞い（E9 の `e2ee-poc-transform`。[ADR-0028](decisions/0028-sframe-encoded-transform-and-dependency-descriptor.md)）、音声の枠の転送器（E7 の `audio-slot-forwarder-poc`。E10 の前。[ADR-0057](decisions/0057-audio-slots-for-large-meetings.md)）、音声認識の評価（E8 の `asr-evaluation-set`。[ADR-0026](decisions/0026-asr-engine-amazon-transcribe-with-adapter.md)）、WAF の CAPTCHA の SPA への組み込み（E3）、CloudFront の WebSocket の長い接続（E2）。
- **mediasoup のフォークは小さく保つ。** RED（[ADR-0017](decisions/0017-opus-dtx-fec-red.md)）と VP8・VP9 の DD の判断（[ADR-0028](decisions/0028-sframe-encoded-transform-and-dependency-descriptor.md)）だけ。上流への提案を Story に含める。
- **契約を先に固定する。** シグナリングのスキーマ、Media Node の制御の API、`qos.report` の項目、公開 API の形は、人間がレビューして確定する。エージェントは勝手に変えない。
- **法務の確認待ちの Story は、spec を承認しない。** 設計と、法務に依らない Story は進めてよい（[intent.md](intent.md) の「法務の確認待ち」L1〜L8）。下の表で「法務：L*」と書いた Story が当たる。
- **1 変更 1 PR を目安に、差分を小さくする。** Media Node の変更は AMI の入れ替えのカナリアと波で出す（[ADR-0055](decisions/0055-media-node-rolling-replacement.md)）。

## Epic

PM が持つ。変更の一覧はここに書かず、各変更の `spec.md` の frontmatter（`epic`）から集計する（[process.md](../../../docs/process.md) の「粒度」）。各 Epic の品質の重点と合否基準は [quality.md](quality.md) の 5 節にある。

| Epic | 目的 | 状態 |
| --- | --- | --- |
| E1 基盤と品質の計測 | AWS のアカウントと網（`media-prod`、BYOIP、追跡しないセキュリティグループ）、制御の側の基盤、RLS、KMS、監査ログ、CI とメディアのパス、netem のラボと PR の品質の報告、品質の報告の経路、フラグと Web の段階的な配信 | 設計中 |
| E2 会議の骨格と Web クライアント（ベータ） | 会議の作成と参加、Meeting Actor、シグナリング、Media Node と割り当て、ICE・TURN、音声と映像の基本、Web クライアント、主催者のログイン、AMI と ASG | 未着手（社外の公開は E3 の守りと法務：L1・L5 の後） |
| E3 会議の安全と主催者の操作 | 待合室とパスコードの不変条件、主催者の操作、ban、一時停止、報告、流量の制限と推測の防御 | 未着手（報告の添付は法務：L2） |
| E4 メディアの品質と帯域の適応 | RED、下りの割り当て、音声の絞り込み、キーフレーム、話者、SVC、`mos_est` の係数、フリーズの SLI | 未着手 |
| E5 画面共有・チャット・端末の処理 | 画面共有、チャットとファイル、リアクションと挙手、仮想背景と雑音の抑制、アクセシビリティ | 未着手（モデルの利用の条件は法務の確認） |
| E6 予定・カレンダー・組織と管理 | 予定と繰り返し、PMI、カレンダーの連携、招待とドメイン、SSO、設定の階層、レポート | 未着手 |
| E7 規模と耐障害 | 負荷のボットと L0〜L2・L6、1 台の上限、付け替え、Actor の障害の注入、DDoS の防御のモード、合成の監視、音声の枠の PoC | 未着手 |
| E8 録画と字幕 | 録画の状態と同意、Recorder と Composer、共有と保持、音声認識の評価、ライブ字幕と文字起こし | 未着手（法務：L2・L3・L6） |
| E9 E2EE | SFrame と MLS、DS と AS、鍵の更新、DD の判断、セキュリティのコード、3 か所の拒否、E2EE のチャット | 未着手（前に `e2ee-poc-transform`。一般への提供は法務：L4） |
| E10 大きな会議と Media Node の運用 | drain と make-before-break、カナリアと波、リージョンの中のカスケード、音声の枠、大阪の待機、DR の訓練、保持の削除 | 未着手（前に `audio-slot-forwarder-poc`） |
| E11 公開 API と Webhook | 公開 API、OAuth のアプリ、レート制限、Webhook | 未着手（受け手の持ち出しは法務：L8） |
| E12 運用と GA の準備 | 負荷試験 L3〜L5、クォータ、ペンテストと机上訓練、Trust & Safety の画面、Marketplace、組織の削除、Edge の評価、GA の判定 | 未着手（GA の判定は法務：L1・L2・L4・L6・L8） |
| E13 デスクトップ・モバイルのアプリ（MVP の後） | Electron、ネイティブのモバイル、Rust の共通のコアと試験のベクトル、libwebrtc の追従 | 未着手（MVP の後） |
| E14 電話からの参加（MVP の後） | SIP トランク、SIP Edge と Call Controller、Phone Bridge、IVR、ダイヤルアウト | 未着手（MVP の後。法務：L1・L7） |
| E15 ウェビナー・大規模なイベント（MVP の後） | 視聴者 1 万人以上の視聴専用の配信の経路 | 未着手（MVP の後。設計はこれから） |
| E16 ブレイクアウトルーム（MVP の後） | 会議の中の小部屋と、主催者の割り振り | 未着手（MVP の後。設計はこれから） |

E1〜E12 が MVP（S1）。領域の文書の「Story の候補」は、この番号で書く。

## Story

各 Story は、着手するときに `changes/YYMMDD-<slug>/` として起票する。ここは計画で、進み具合は各変更の `spec.md` の frontmatter で見る。順序は Epic の中での目安で、依存があるものを先に置いた。各領域の文書の「Story の候補」から集めた。同じ中身の Story が 2 つの文書にあるものは 1 つにした（「1 つにした」と書いた）。

### E1 基盤と品質の計測

設計：[infrastructure.md](architecture/infrastructure.md)、[delivery.md](architecture/delivery.md)、[observability.md](architecture/observability.md)、[security.md](architecture/security.md)、[data-model.md](architecture/data-model.md)、[ADR-0054](decisions/0054-network-impairment-lab.md)、[ADR-0058](decisions/0058-tenant-tables-with-force-rls.md)

| Story | 内容 |
| --- | --- |
| `dev-repo-bootstrap` | Zoom の再構築の開発リポジトリを作り、`changes/`・`specs/`・開発向けの `AGENTS.md`、CODEOWNERS（`third_party/mediasoup/`・シグナリングのスキーマはテックリード）を置く（リポジトリ共通の ADR-0005） |
| `accounts-and-scp-media` | `media-prod`・`media-staging`・`media-lab` のアカウント、SCP（infrastructure の 1 節。security の `accounts-media-prod` と 1 つにした） |
| `aws-control-plane-baseline` | `prod` の VPC、ECS、Aurora、Valkey、SQS、Firehose（他の題材の Terraform のモジュールを流用。infrastructure の 2.1・6 節） |
| `media-vpc-and-peering` | media-prod の VPC、ピアリングと 3 つの通信（infrastructure の 2.2・2.3 節） |
| `byoip-onboarding` | BYOIP の範囲、ROA、IPAM のプール、Elastic IP と IPv6、`ip-ranges.json`（infrastructure の 3.3 節。network-traversal の `media-edge-addressing` と 1 つにした） |
| `media-sg-untracked` | 追跡しないセキュリティグループと Terraform の検査（network-traversal の 7.2 節） |
| `terraform-policy-checks-media` | plan のポリシー検査（infrastructure の 9.2 節） |
| `kms-key-hierarchy` | KMS の鍵 6 つと、`org_id` の文脈の条件（[ADR-0047](decisions/0047-keys-and-operator-access-to-media.md)） |
| `aurora-tenancy-rls` | `app`・`global` のスキーマ、FORCE RLS、`SET LOCAL app.org_id`、`meeting_number_index`、RLS の試験（[ADR-0058](decisions/0058-tenant-tables-with-force-rls.md)） |
| `audit-log-three-streams` | 監査ログ 3 系統、`global.outbox`、log-archive への転送、ハッシュの連鎖の検証（security の 6 節、data-model の 5.5 節） |
| `content-leak-scanner` | 内容・秘密の出力の走査（CI と本番） |
| `operator-access-media-prod` | 期限つきのシェル、パケットの取得の制限、監査 |
| `telemetry-package-and-allowlist` | 計装のパッケージ、属性の許可リスト（observability の 2.1・2.4 節） |
| `qos-report-pipeline` | `qos.report` → Gateway → Firehose → S3・Athena、SQS → `participant_quality_summaries`、Firehose の書き込みのまとめと上限の引き上げの申請（capacity の 5.4 節。[ADR-0051](decisions/0051-qos-telemetry-pipeline.md)） |
| `ena-metrics-collection` | ENA の `*_allowance_exceeded` の収集 |
| `alerts-with-runbooks` | アラートと runbook の URL の CI の検査 |
| `media-paths-and-required-checks` | メディアのパスの一覧と必須の段（delivery の 2.1・2.2 節） |
| `netem-lab-namespaces` | ラボ（名前空間、netem・tbf・ifb、条件の宣言、測り方）（delivery の 3 節。codecs の `netem-harness` と 1 つにした） |
| `pr-media-report-bot` | PR の品質の報告と `main` の基準（delivery の 2.2 節。codecs の `media-quality-metrics` と 1 つにした） |
| `client-e2e-harness` | E2E の基盤。偽の端末、ブラウザの組み合わせ、実機の Safari（clients の 12 節） |
| `web-release-percentage` | 版の資産、`client-config`、割合、版ごとの SLI（delivery の 5.1 節） |
| `meeting-scoped-flags` | フラグの種類、`effective_flags`、ops のフラグの配り直し（delivery の 6 節） |
| `cost-dashboard-k8` | K8 を請求と送ったバイトから毎月計算する（infrastructure の 12 節） |

### E2 会議の骨格と Web クライアント（ベータ）

設計：[signaling-and-meetings.md](architecture/signaling-and-meetings.md)、[media-server-sfu.md](architecture/media-server-sfu.md)、[network-traversal.md](architecture/network-traversal.md)、[codecs-and-bandwidth-adaptation.md](architecture/codecs-and-bandwidth-adaptation.md)、[clients.md](architecture/clients.md)、[ADR-0005](decisions/0005-meeting-state-and-signaling.md)〜[ADR-0016](decisions/0016-media-edge-addressing-and-security-groups.md)

| Story | 内容 |
| --- | --- |
| `org-user-model` | 組織、ユーザー、ロール、`authorize`（accounts-and-admin の 3 節。E2 のベータの主催者のログインに要るので E6 から前に出した） |
| `identity-better-auth` | OTP、Google、Microsoft、パスキー、セッション（accounts-and-admin の 4.1 節。同上） |
| `signaling-schema-package` | 6.2 節の Zod のスキーマと JSON Schema の生成。受ける版（N−1・N−2）と `min_client_version` |
| `meeting-create-instant` | 会議の番号、参加の鍵、URL（signaling の 4.2 節） |
| `join-token-issue` | Ed25519 のトークン、`jti`（4.3 節） |
| `signaling-gateway-connect` | サブプロトコル、`Origin`、`hello`・`welcome` |
| `meeting-actor-core` | 待ち行列、`seq`、差分の配信 |
| `actor-lease-epoch` | Lua のスクリプト、自分で止まる、フェンシング |
| `reconnect-resume` | 再接続用の秘密、差分とスナップショット |
| `media-node-ami-pipeline` | Image Builder、arm64 の mediasoup（infrastructure の 3.2 節） |
| `media-node-agent-skeleton` | worker の起動、コアへの固定、WebRtcServer、router |
| `media-node-control-api` | mTLS、Zod のスキーマ、`epoch` の検査、冪等 |
| `media-node-ice-lite-candidates` | `listenInfos`、`announcedAddress` の起動時の確認 |
| `media-fleet-asg` | AZ ごとの ASG、縮める保護、ライフサイクルフックの EIP、ウォームプール |
| `assignment-service-basic` | 負荷の報告、点、2 台からの選択、予備の Node |
| `media-negotiation-relay` | メディアの交渉の中継（signaling の 8 節） |
| `subscriptions-and-layers` | 購読の集合、層の上限、優先度 |
| `audio-opus-baseline` | DTX、FEC、20ms、32 kbps |
| `video-simulcast-vp8` | 3 本、H.264 の送り手 |
| `turn-coturn-deploy` | coturn の AMI、UDP・TCP 3478、TLS 443、中継の相手の制限、証明書（ACM の書き出せる公開の証明書、`*.turn.<brand>.<domain>`。infrastructure の `turn-fleet` と 1 つにした） |
| `turn-rest-credentials` | API での発行、秘密の入れ替え |
| `turn-relay-restriction-tests` | TURN の踏み台の試験と本番の毎日の合成の試験（security の 10 節） |
| `client-ice-config` | `iceServers`、前回の経路の記憶 |
| `ice-restart-flow` | ICE restart と資格情報の更新 |
| `signaling-via-cloudfront` | WebSocket を CloudFront に通し、8 時間の接続を試す（PoC） |
| `web-client-shell` | Web クライアントの構成、React の画面の骨格 |
| `browser-capability-probe` | 機能の判定と申告（`capabilities`・`features`）、使えない機能の表示 |
| `prejoin-preview` | プレビュー、端末の選択、前回の設定 |
| `device-switching` | 端末の切り替え |
| `gallery-view-hints` | 表示の大きさの送信、タブが隠れたときの停止 |
| `network-path-matrix-tests` | 網の条件ごとの経路の試験を CI で |
| `preflight-network-check` | 「回線を確かめる」 |
| `customer-firewall-doc` | 規則の公開と `ip-ranges.json` |
| `cross-org-read-denial-suite` | 組織をまたぐ読み取りの拒否の試験 |
| `gateway-gradual-drain` | Gateway の少しずつ閉じる入れ替え |
| `safari-dummynet-nightly` | Safari の夜間の回線の劣化の試験 |

### E3 会議の安全と主催者の操作

設計：[meeting-security.md](architecture/meeting-security.md)、[signaling-and-meetings.md](architecture/signaling-and-meetings.md) の 9 節、[ADR-0009](decisions/0009-host-controls-enforcement.md)、[ADR-0031](decisions/0031-waiting-room-and-passcode-rules.md)〜[ADR-0033](decisions/0033-join-rate-limits-and-enumeration-defense.md)

| Story | 内容 |
| --- | --- |
| `join-guard-invariant` | 不変条件と `assertJoinGuard` をすべての経路へ。DB の `CHECK` と毎日の監査 |
| `passcode-format-storage` | 暗号化と HMAC、禁止の規則 |
| `waiting-room-core` | 待合室、`admit`・`admit_all`・`deny`・`to_waiting`、上限 |
| `waiting-room-bypass` | 組織・ドメイン・招待・`host.invite` |
| `host-controls-table` | 主催者の操作の決定表と、Media Node での強制 |
| `host-handover` | 主催者の引き継ぎ |
| `removal-ban-durable` | 退出させた記録を Aurora に書いてから配る |
| `removal-ban-guest-device` | 端末の鍵、同じ回線の印（pepper の今と前の照合）、`host.readmit` |
| `suspend-activities` | `host.suspend` |
| `participant-report` | 報告の API、Trust & Safety の待ち行列（添付は法務：L2） |
| `join-rate-limits` | Valkey のトークンバケット、HyperLogLog |
| `enumeration-uniform-response` | 応答と時間を揃える（p99 10ms）、Web の画面 |
| `waf-captcha-challenge` | WAF の CAPTCHA の試作と組み込み（PoC を含む） |
| `abuse-quotas` | 会議の数・人数・ゲストの上限（security の 8.1 節。値は PM） |

### E4 メディアの品質と帯域の適応

設計：[codecs-and-bandwidth-adaptation.md](architecture/codecs-and-bandwidth-adaptation.md)、[media-server-sfu.md](architecture/media-server-sfu.md) の 5〜7 節、[observability.md](architecture/observability.md) の 4 節、[ADR-0017](decisions/0017-opus-dtx-fec-red.md)〜[ADR-0019](decisions/0019-bandwidth-estimation-and-layer-allocation.md)、[ADR-0052](decisions/0052-media-slis-and-mos-estimation.md)

| Story | 内容 |
| --- | --- |
| `sfu-netem-suite` | sfu の回線の劣化の試験を CI で（行列の全部を夜間に） |
| `red-forwarding` | mediasoup の RED の転送と剥がし、試験のベクトル、上流への提案 |
| `downlink-allocation` | 優先度、上限の層、上げ下げの規則、音声の枠 |
| `sender-layer-hint` | 使われない層を送り手に止めさせる（codecs の `unused-layer-pause` と 1 つにした） |
| `audio-top-n` | 受け手ごとに最大 3 本の音声 |
| `keyframe-control` | キーフレームの要求の間隔 |
| `active-speaker` | 話者の検出 |
| `loss-20-audio` | 損失 20% で NFR-003 を満たすことの確認と調整 |
| `svc-vp9-mode` | モードの決定と切り替え、上りの差の計測 |
| `av1-evaluation` | AV1 の CPU、品質、mediasoup の DD の問題の確認 |
| `path-quality-netem` | 経路ごとの回線の劣化 |
| `mos-est-calibration` | `media-lab` の格子の試験で係数を合わせる |
| `freeze-sli` | 止めた consumer とフリーズの区別の確認 |

### E5 画面共有・チャット・端末の処理

設計：[chat-and-reactions.md](architecture/chat-and-reactions.md)、[clients.md](architecture/clients.md) の 5・6 節、[codecs-and-bandwidth-adaptation.md](architecture/codecs-and-bandwidth-adaptation.md) の 7 節、[ADR-0020](decisions/0020-screen-share-encoding.md)、[ADR-0022](decisions/0022-on-device-media-processing.md)、[ADR-0036](decisions/0036-in-meeting-chat-ordering-and-retention.md)、[ADR-0037](decisions/0037-chat-files-reactions-and-raise-hand.md)

| Story | 内容 |
| --- | --- |
| `screen-share-arbitration` | 共有の許可と 1 人だけの共有（signaling の 9.2 節） |
| `screen-share-detail` | `contentHint`、5 fps、時間の層 |
| `screen-share-motion` | `motion` と、タブの音声 |
| `chat-send-and-deliver` | `chat_seq`・`ch_seq`、`chat.fetch`、`client_msg_id` |
| `chat-permissions` | 許可の決定表 |
| `chat-moderation-delete` | 削除 |
| `chat-late-joiner-history` | 途中から入った人の履歴 |
| `chat-retention` | 24 時間の消去、`save_chat`、端末への保存 |
| `chat-file-transfer` | 署名付きの PUT、マルウェアの検査、別のドメインからの配信 |
| `reactions` | リアクション |
| `raise-hand-and-feedback` | 挙手と反応の表示、`host.lower_hands` |
| `virtual-background` | Selfie Segmenter、WebGPU・WebGL2、代わりの経路（モデルの利用の条件は法務の確認の後） |
| `background-blur` | ぼかし |
| `noise-suppression-rnnoise` | 強い雑音の抑制 |
| `device-load-governor` | 端末の負荷の制御 |
| `a11y-meeting-ui` | アクセシビリティ |

### E6 予定・カレンダー・組織と管理

設計：[scheduling-and-calendar.md](architecture/scheduling-and-calendar.md)、[accounts-and-admin.md](architecture/accounts-and-admin.md)、[ADR-0034](decisions/0034-scheduled-recurring-meetings-and-pmi.md)〜[ADR-0035](decisions/0035-calendar-integration-add-ons-and-oauth.md)、[ADR-0038](decisions/0038-organizations-users-roles-and-sso.md)〜[ADR-0040](decisions/0040-usage-reports.md)

| Story | 内容 |
| --- | --- |
| `settings-registry-and-resolver` | 解決の関数、性質ベーステスト |
| `settings-admin-ui-and-api` | 設定の画面と API |
| `groups` | グループと、グループの設定 |
| `invitations-and-domain-capture` | 招待、ドメインの確認、`domain_capture` |
| `org-sso-oidc` | OIDC、JIT、`required`、例外 |
| `org-sso-saml` | SAML、`InResponseTo`、証明書の期限の通知 |
| `scheduled-meeting-crud` | 作成・更新・取り消し、`idempotency_key` |
| `recurrence-rrule-subset` | 回の計算、例外 |
| `timezone-handling` | 現地の時刻、tzdata の版の固定と洗い出し |
| `invite-email-ics` | 招待のメールと iCalendar |
| `pmi` | 割り当て、作り直し、待合室の強化 |
| `google-calendar-oauth-write` | 本システムの画面から Google に書く |
| `microsoft-graph-oauth-write` | Graph、`transactionId` |
| `calendar-change-sync` | push・変更の通知、毎日の差分 |
| `google-workspace-addon` | 会議の方式、`onCreateFunction` |
| `outlook-online-meeting-addin` | 管理者が配るアドイン |
| `usage-reports` | 集計、画面、CSV の書き出し |

### E7 規模と耐障害

設計：[capacity.md](architecture/capacity.md)、[media-server-sfu.md](architecture/media-server-sfu.md) の 9 節、[signaling-and-meetings.md](architecture/signaling-and-meetings.md) の 10 節、[security.md](architecture/security.md) の 8.3 節、[ADR-0013](decisions/0013-media-node-failover-and-reattach.md)、[ADR-0045](decisions/0045-ddos-defense-for-media-edge.md)、[ADR-0053](decisions/0053-capacity-model-cost-target-and-load-bots.md)、[ADR-0057](decisions/0057-audio-slots-for-large-meetings.md)

| Story | 内容 |
| --- | --- |
| `loadbot-pion` | 送り手・受け手のボットと、シナリオの記述 |
| `load-l0-l2` | L0〜L2。capacity の 3 節の表を実測で埋める（sfu の `media-node-load-test` と 1 つにした） |
| `node-limits-in-assignment` | 実測の値を Assignment Service の `*_limit` に入れる |
| `worker-spread-pipe` | 家の worker、`pipeToRouter`、pipe の片付け |
| `media-node-failover` | 検知、`media.reattach`、音声を先に |
| `worker-died-recovery` | worker の異常終了 |
| `actor-failover-drill` | Actor の回復と障害の注入 |
| `actor-planned-handover` | 計画した引き渡し |
| `signaling-load-test` | 100 人の会議 × 同時の会議の数で、Actor Host の CPU と `cmd` の遅れ |
| `bwe-load-test` | 100 人の会議で、Media Node の推定と割り当ての CPU |
| `audio-slot-forwarder-poc` | 音声の枠の PoC（300 人のボット、転送器の CPU と遅れ、切り替えの聞こえ方、`DirectTransport` と別のプロセス）。**E10 の `audio-slot-forwarder` の spec の前に結果を記録する** |
| `media-node-under-attack-mode` | 防御のモード（`nftables` の集合、STUN の上限、IPv6 の候補を出さない） |
| `ddos-under-attack-load` | L6 |
| `shield-advanced-onboarding` | 入口の保護、EIP の一時的な保護の自動化、SRT の連絡の準備 |
| `media-fuzzing` | メディアのファジング |
| `predictive-scaling` | 予定の会議からの予測とスケジュールのアクション |
| `synthetic-meetings` | 合成の監視の会議 |
| `media-slo-dashboards` | メディアの SLO のダッシュボード |

### E8 録画と字幕

設計：[recording-and-transcription.md](architecture/recording-and-transcription.md)、[ADR-0025](decisions/0025-recording-per-track-capture-and-offline-compose.md)〜[ADR-0027](decisions/0027-capture-consent-and-indicators.md)

| Story | 内容 |
| --- | --- |
| `asr-evaluation-set` | 評価用の音声のセットとエンジンの比較（ASR の eval。最初に行う） |
| `recording-state-and-consent` | Actor の状態、同意の記録、`consent_required`、`capture_indicator.v1`（法務：L3） |
| `recorder-rtp-capture` | PlainTransport、rtpseg、マニフェスト、S3（法務：L2） |
| `recording-compose` | `speaker_share`・`audio`、合成の速さの計測 |
| `recording-gallery-and-per-participant` | 残りの形式 |
| `chat-into-recording` | 録画の区間のチャットのファイル（chat の 3.7 節） |
| `recording-share-and-playback` | 署名付きの URL、外への共有のリンク |
| `recording-retention-trash-hold` | 保持、ごみ箱、保全（法務：L6） |
| `transcriber-live-captions` | 話者の枠、`caption.*`（法務：L2・L6） |
| `transcript-after-meeting` | 確定した結果の結合、batch による作り直し |
| `custom-vocabulary` | 組織の語彙 |
| `recorder-failover-drill` | Recorder の障害の注入 |

### E9 E2EE

設計：[e2ee.md](architecture/e2ee.md)、[ADR-0004](decisions/0004-encryption-and-e2ee.md)、[ADR-0028](decisions/0028-sframe-encoded-transform-and-dependency-descriptor.md)〜[ADR-0030](decisions/0030-security-code-and-e2ee-feature-limits.md)

| Story | 内容 |
| --- | --- |
| `e2ee-poc-transform` | PoC：ブラウザごとの Encoded Transform、DD、depacketizer、SVC の層ごとのフレーム、RED の組み合わせ、WASM と WebCrypto |
| `core-e2ee-mls` | OpenMLS のグループ、外部コミット、Remove、resync、MLS のベクトル |
| `core-e2ee-sframe` | KID、context、CTR、RFC 9605 の付録 C のベクトル |
| `e2ee-worker-wasm` | `e2ee` のワーカーと `core-wasm`（clients と 1 つ） |
| `mls-delivery-service` | Actor のエポックの順序、GroupInfo の保存 |
| `e2ee-credentials-as` | X.509 の証明書、中間 CA、根の同梱 |
| `e2ee-rekey-on-leave` | 担当者の指名と交代、2 秒の計測 |
| `media-node-dd-selection` | mediasoup に VP8・VP9 の DD の判断を足す |
| `security-code-ui` | セキュリティのコードと名簿の表示 |
| `e2ee-feature-gates` | 3 か所での拒否（recording の `capture-blocked-in-e2ee` と 1 つにした） |
| `e2ee-chat-and-reactions` | `e2ee.app` のチャットとリアクション、個別のメッセージの無効化（e2ee の `e2ee-chat-mls` と chat の同名の Story を 1 つにした） |
| `e2ee-scale-300` | 300 人のグループの計測 |

### E10 大きな会議と Media Node の運用

設計：[media-server-sfu.md](architecture/media-server-sfu.md) の 5.3・8・10 節、[delivery.md](architecture/delivery.md) の 4 節、[infrastructure.md](architecture/infrastructure.md) の 8 節、[ADR-0012](decisions/0012-media-assignment-and-cascading.md)、[ADR-0050](decisions/0050-disaster-recovery-and-edge-migration.md)、[ADR-0055](decisions/0055-media-node-rolling-replacement.md)、[ADR-0057](decisions/0057-audio-slots-for-large-meetings.md)

| Story | 内容 |
| --- | --- |
| `make-before-break-migration` | drain と make-before-break（sfu の `node-drain-mbb` と 1 つにした） |
| `media-node-canary-and-waves` | 世代の重み、SLI の比較、波の自動化 |
| `turn-rolling-replacement` | TURN の入れ替え |
| `audio-slot-forwarder` | 100 人を超える会議の音声の枠（capacity の `audio-slot-consumers` と 1 つにした。前に E7 の PoC） |
| `intra-region-cascade` | 台の間の PipeTransport、1 ホップのつなぎ（S2 の準備） |
| `osaka-media-standby` | 大阪の最小の構成と、月次の確認 |
| `dr-drill-region` | DR の訓練 |
| `retention-jobs` | 保持の期限の削除のジョブ（1 つのジョブ）と毎日の監査 |

### E11 公開 API と Webhook

設計：[api-and-webhooks.md](architecture/api-and-webhooks.md)、[ADR-0043](decisions/0043-public-api-oauth-apps-and-rate-limits.md)、[ADR-0044](decisions/0044-signed-webhooks-standard-webhooks.md)

| Story | 内容 |
| --- | --- |
| `public-api-service` | 別のサービス、トークンの検証、OpenAPI |
| `oauth-authorization-server` | 認可コード＋PKCE、クライアントクレデンシャル、取り消し、RFC 9700 の確認の表 |
| `oauth-app-registry-and-consent` | アプリの状態、`admin` の承認 |
| `api-meetings-and-users` | 会議とユーザー |
| `api-recordings-and-transcripts` | 録画と文字起こし、署名付きの URL |
| `api-reports` | レポート |
| `api-rate-limits` | レート制限 |
| `webhook-registration-and-validation` | URL の確認、SSRF の対策 |
| `webhook-delivery` | 署名、再送、止める、再送の要求 |
| `webhook-events` | イベント |
| `recording-webhooks` | `recording.completed`・`transcript.completed`（recording から） |
| `sdk-webhook-verifier` | `@<brand>/webhooks` |
| `token-secret-scanning-registration` | 接頭辞の登録 |

### E12 運用と GA の準備

設計：[capacity.md](architecture/capacity.md) の 7 節、[security.md](architecture/security.md) の 10 節、[infrastructure.md](architecture/infrastructure.md) の 12 節、[runbooks/](runbooks/README.md)

| Story | 内容 |
| --- | --- |
| `quota-requests` | クォータの確認と申請 |
| `load-l3-l5` | L3〜L5（GA の判定の材料） |
| `pentest-and-tabletop` | 外部のペンテスト、DDoS と録画の漏えいの机上訓練、`security.txt` |
| `trust-safety-console` | 報告の対処の画面、全体の端末の ban、アカウントの停止 |
| `meeting-inspector` | 会議の調べの画面（運用者用） |
| `outlook-addin-marketplace` | Marketplace での公開と Join のボタン |
| `org-deletion-and-user-offboarding` | 組織とユーザーの削除（法務：L6・L8） |
| `edge-evaluation` | Edge の比較を見積もりと PoC で確かめる |
| `scim-provisioning` | SCIM（S2。GA の判定に要るなら） |
| `law-enforcement-request-handling` | 捜査機関からの照会の受付、記録の保全と開示の手順、`law-enforcement-request.md`（security の 16 節。中身は法務：L4 の後） |

### E13 デスクトップ・モバイルのアプリ（MVP の後）

設計：[clients.md](architecture/clients.md) の 7〜9 節、[ADR-0023](decisions/0023-desktop-electron-mobile-native.md)、[ADR-0024](decisions/0024-shared-rust-core-and-test-vectors.md)、[ADR-0008](decisions/0008-signaling-protocol.md) の注記（N−2）

| Story | 内容 |
| --- | --- |
| `signaling-test-vectors` | ベクトルの形式、生成、CI（最初に行う） |
| `core-signaling-rust` | 状態機械の Rust 版 |
| `desktop-electron-shell` | Electron、安全の設定、自動更新 |
| `desktop-screen-share-audio` | システムの音声 |
| `libwebrtc-build-pipeline` | libwebrtc と libmediasoupclient のビルドと追従 |
| `mobile-ios-app` ・ `mobile-android-app` | モバイルのアプリ |
| `e2ee-native-transformer` | ネイティブの `FrameTransformerInterface` |

### E14 電話からの参加（MVP の後）

設計：[telephony.md](architecture/telephony.md)、[ADR-0041](decisions/0041-pstn-via-carrier-sip-trunk-and-own-gateway.md)、[ADR-0042](decisions/0042-dial-in-numbers-ivr-and-dial-out-limits.md)。すべて法務：L1・L7。

| Story | 内容 |
| --- | --- |
| `carrier-selection-and-legal` | 事業者の選定、番号の卸、番号使用計画の要否の確認 |
| `sip-edge-and-call-controller` | Kamailio、FreeSWITCH、事業者との接続 |
| `phone-bridge` | PlainTransport、下りの混ぜ方、`client.kind = "phone"` |
| `dial-in-ivr` | 番号、パスコード、待合室、同意 |
| `phone-in-meeting-controls` | DTMF、表示、ban |
| `phone-join-rate-limits` | 参加の流量の制限に `caller_id_hash` の軸を足す（E3 から移した） |
| `dial-out-with-guards` | ダイヤルアウトと不正な発信の対策 |
| `toll-free-numbers` | 0120・0800 |

### E15 ウェビナー・大規模なイベント（MVP の後）

設計はこれから。手がかり：視聴専用の配信は、SFU と MCU の組み合わせ（[ADR-0002](decisions/0002-media-topology.md) の選択肢 4）、再符号化の中継（[media-server-sfu.md](architecture/media-server-sfu.md) の 7 節）、会議の間の合成（[ADR-0025](decisions/0025-recording-per-track-capture-and-offline-compose.md) の選択肢 2）。

| Story | 内容 |
| --- | --- |
| `webinar-intent` | 視聴者・パネリストの役割、規模（1 万人以上）、遅れの目標を intent にする |
| `webinar-delivery-adr` | 視聴専用の配信の経路（再符号化の中継か、HLS 系か）の ADR |

### E16 ブレイクアウトルーム（MVP の後）

設計はこれから。手がかり：会議の状態（[ADR-0005](decisions/0005-meeting-state-and-signaling.md)）の上に、部屋ごとの Actor と Media Node の router を足す。E2EE の会議では部屋ごとに MLS のグループが要る。

| Story | 内容 |
| --- | --- |
| `breakout-intent` | 割り振り、主催者の巡回、録画と同意の扱いを intent にする |
| `breakout-state-adr` | 部屋の状態と Media Node の置き方の ADR |

## エージェントに任せないこと

- **契約（シグナリングのスキーマ、Media Node の制御の API、`qos.report` の項目、公開 API の形）の確定**：配った後に変えるコストが最も高い。
- **品質の閾値・回線の条件・試行の回数・`mos_est` の係数の変更**：QA が決める。
- **mediasoup のフォークの差分の採否と、上流への提案**：Dev のテックリードが判断する。
- **Edge の構築の開始、大阪への切り替えの判断、Media Node の急ぎの入れ替え**：Ops の責任者と PM（[runbooks/](runbooks/README.md)）。
- **SLO と K8 の目標の値**：PM と Ops。
- **法務の判断**（L1〜L8）。
- **負荷試験・PoC の結果の解釈**：数字は出せるが、上限・台数・退路（c8g への切り替え、転送器の置き場所）の採否は Dev と PM の判断。

## 延期の一覧

MVP の後に検討する。E13〜E16 に入れなかったもの。着手するときに `intent.md` から起票する（[intent.md](intent.md) の「MVP の後に扱う」と、各領域の文書の持ち越し）。

- **ホワイトボード**、**Team Chat**（会議の外のチャット）、**Phone（クラウド PBX）**、**会議室のシステムと SIP・H.323 の機器**（intent.md の表）。
- **AI による要約・議事録・質問への応答**：文字起こしの品質と、通信の秘密（L2）の整理の後。
- **端末の上での録画**（ローカル録画）、**ダウンロードを許さない共有の HLS の配信**（[recording-and-transcription.md](architecture/recording-and-transcription.md) の 13 節）。
- **BYOK と組織ごとの KMS の鍵**（[ADR-0047](decisions/0047-keys-and-operator-access-to-media.md)）。
- **1:1 の会議の P2P**（S2 で計測してから ADR。[ADR-0002](decisions/0002-media-topology.md)）、**AV1 の既定化**（S2 の前。[ADR-0018](decisions/0018-video-codec-and-layering-selection.md)）、**1:1 の 1080p**。
- **S2 の構成**（大阪でも会議を受ける、リージョンの中のカスケードの本番の運用）と **S3 のリージョンの間のカスケード**（受け手が要る層だけを運ぶ形の ADR。[media-server-sfu.md](architecture/media-server-sfu.md) の 8.4 節）、海外のリージョン。
- **E2EE の拡張**：端末に残る長期の鍵、送り手ごとの署名、E2EE の会議の個別のメッセージ、300 人を超える E2EE の会議（[e2ee.md](architecture/e2ee.md) の 16 節）。
- **組織と管理**：1 人が複数の組織に属すること、複数のグループと優先度、分けた管理のロール、鍵の最小・最大の形、SCIM（GA に要らなければ）（[accounts-and-admin.md](architecture/accounts-and-admin.md) の 11 節）。
- **予定**：「この回以降を変える」（[scheduling-and-calendar.md](architecture/scheduling-and-calendar.md) の 11 節）。
- **公開 API の会議の中の操作**、組織の契約で上げるレート制限（[api-and-webhooks.md](architecture/api-and-webhooks.md) の 12 節）。
- **個別のメッセージの記録（eDiscovery）**（法務：L8）。
- **同時に複数の画面共有**、チャットの装飾（Markdown、メンション）。
- **電話の拡張**：0ABJ の番号、英語の案内（[telephony.md](architecture/telephony.md) の 11 節）。
- **デスクトップの Linux 版**。

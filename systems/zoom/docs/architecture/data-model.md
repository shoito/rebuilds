# Data model: Zoom

データモデルの索引。すべての置き場所（Aurora・Valkey・S3・SQS・Firehose・AMP・KMS・Secrets Manager・AppConfig・Media Node と Actor のメモリ・端末）と、横断の規則、複数の領域が列を足す表の統合した定義を書く。**各表・各キーの列の定義の正本は、索引の「定義の場所」にある文書** で、ここには置き場所と、統合した定義（5 節）だけを書く。実装の変更（`changes/`）でマイグレーションを書くときに、ここと各文書を合わせて更新する。

会議の状態の置き場所は [ADR-0005](../decisions/0005-meeting-state-and-signaling.md)・[ADR-0007](../decisions/0007-meeting-actor-lease-and-epoch.md)、組織の分け方は [ADR-0058](../decisions/0058-tenant-tables-with-force-rls.md)、鍵は [ADR-0047](../decisions/0047-keys-and-operator-access-to-media.md)、監査と保持は [ADR-0046](../decisions/0046-audit-logs-and-data-lifecycle.md) に従う。

2026-09-27 の統合の工程で、全領域の文書の「data-model への項目」と照合した。統合で決めたこと（重なりの解消、名前の規則）は 11 節にまとめた。

## 1. 置き場所

| 置き場所 | 何を置くか | 失ってよいか | 正本の決定 |
| --- | --- | --- | --- |
| Aurora PostgreSQL 18（`prod`、東京。大阪へ Global Database）の `app` スキーマ（FORCE RLS） | 会議・予定・開催と参加の記録・録画の索引・同意・チャットの保存・設定・利用の集計・監査・Webhook | 失ってはならない（RPO 1 分） | [ADR-0001](../decisions/0001-platform-and-stack.md)、[ADR-0050](../decisions/0050-disaster-recovery-and-edge-migration.md)、[ADR-0058](../decisions/0058-tenant-tables-with-force-rls.md) |
| Aurora の `global` スキーマ（RLS の外） | 組織、ドメイン、認証（Better Auth）、OAuth のアプリとトークン、電話番号、全体の ban、番号の索引と履歴、プラットフォームの監査、outbox | 失ってはならない | 同上（3.13 節に理由） |
| Meeting Actor のメモリ | 会議の状態の正本（参加者、待合室、ミュート、購読、`seq`、MLS のエポック） | 失ってよい（スナップショットと Aurora とクライアントの申告から戻す） | [ADR-0005](../decisions/0005-meeting-state-and-signaling.md) |
| Valkey（ElastiCache、`prod`） | Actor のリースと `epoch`、状態のスナップショット、会議の間のチャット、流量の制限、Node・TURN の負荷 | 失ってよい（大阪へ複製しない） | [ADR-0007](../decisions/0007-meeting-actor-lease-and-epoch.md) |
| Media Node のメモリ | router・transport・producer・consumer、会議ごとの最大の `epoch`、音声の枠の転送器 | 失ってよい（付け替える） | [ADR-0013](../decisions/0013-media-node-failover-and-reattach.md)、[ADR-0057](../decisions/0057-audio-slots-for-large-meetings.md) |
| S3（`media-prod`、録画のバケット） | 録画の生の区切りと成果物、文字起こし | 失ってはならない（成功を知らせた録画） | [ADR-0025](../decisions/0025-recording-per-track-capture-and-offline-compose.md) |
| S3（`prod`、ファイルのバケット） | チャットのファイル、報告の添付、レポートの書き出し | 期限まで失ってはならない | 6 節 |
| S3（`prod`、観測のバケット）＋ Athena | 品質の生の記録（参加者ごと 10 秒）、日次の集計 | 失ってよい（30 日・13 か月） | [ADR-0051](../decisions/0051-qos-telemetry-pipeline.md) |
| S3（log-archive、Object Lock） | 監査ログ 3 系統、CloudTrail、Media Node・TURN・ALB・WAF のログ（IP は 30 日） | 失ってはならない（7 年） | [ADR-0046](../decisions/0046-audit-logs-and-data-lifecycle.md) |
| S3（shared） | Web の版ごとの資産（`/app/<version>/`）、Terraform の状態、AMI の配布 | 作り直せる | [ADR-0056](../decisions/0056-client-release-trains-and-meeting-scoped-flags.md)、[infrastructure.md](infrastructure.md) |
| SQS | Worker のジョブ（7 節） | 失ってよい（outbox と表から作り直せる） | — |
| Kinesis Data Firehose | `qos.report` と Media Node の要約の流れ | 失ってよい | [ADR-0051](../decisions/0051-qos-telemetry-pipeline.md) |
| AMP、CloudWatch Logs、X-Ray | メトリクス、アプリのログ、トレース（内容と IP を含めない） | 失ってよい | [observability.md](observability.md) |
| KMS、Secrets Manager、AWS Private CA | 鍵と秘密（8 節） | 失ってはならない | [ADR-0047](../decisions/0047-keys-and-operator-access-to-media.md) |
| IPAM（`media-prod`） | BYOIP の範囲、EIP のプール、隔離した EIP のタグ | 失ってはならない（顧客に公開した範囲） | [ADR-0049](../decisions/0049-media-node-fleet.md) |
| AWS AppConfig | release・meeting・ops・experiment のフラグ、`client-config` の版の割合と最低の版 | 失ってよい（既定の値で動く） | [ADR-0056](../decisions/0056-client-release-trains-and-meeting-scoped-flags.md)（AppConfig を使うこと自体は他の題材の決定の引き継ぎ。**未検証**） |
| 公開の `ip-ranges.json` | Media Node と TURN の範囲、更新の日付 | 作り直せる | [ADR-0016](../decisions/0016-media-edge-addressing-and-security-groups.md) |
| 利用者の端末（`localStorage`・IndexedDB・メモリ） | 端末の鍵、前回の経路、端末の選択、仮想背景、ショートカット。E2EE の鍵はワーカーのメモリだけ | — | [clients.md](clients.md)、[network-traversal.md](network-traversal.md)、[e2ee.md](e2ee.md) |
| 開発リポジトリ | シグナリングのスキーマ（`@<brand>/signaling-schema`）、試験のベクトル、`settingsRegistry`、`ci/media-paths.yml`、ラボの条件（YAML） | 定義の正本 | [ADR-0008](../decisions/0008-signaling-protocol.md)、[ADR-0024](../decisions/0024-shared-rust-core-and-test-vectors.md)、[ADR-0039](../decisions/0039-settings-hierarchy-and-locks.md) |

## 2. 横断の規則

- **ID**：内部の ID は ULID に種類の接頭辞を付ける（`org_`、`u_`、`mtg_`、`mi_`、`p_`、`rec_`、`tr_`、`rpt_`、`evt_`、`msg_` など。[signaling-and-meetings.md](signaling-and-meetings.md) の例に合わせる）。人が読み上げる番号（11 桁の会議の番号、10 桁の PMI）は別の列に持つ。
- **組織の分離**：組織に属する表（`app` スキーマ）は `org_id` を持ち、主キーか索引の先頭に置き、`FORCE ROW LEVEL SECURITY` を付ける。トランザクションごとに `SET LOCAL app.org_id`。1 つのトランザクションで複数の `org_id` の行を書かない。API の認可（`authorize`）はその上に重ねる（[ADR-0058](../decisions/0058-tenant-tables-with-force-rls.md)）。参加の API の最初の引き（番号 → 組織）は `global.meeting_number_index` を読む関数だけで行う。
- **会議の内容**：チャットの本文、パスコード、カレンダーのトークン、Webhook の秘密は、`<brand>-meeting-secrets` の鍵でエンベロープ暗号化し、暗号化の文脈に `org_id` を入れる。録画・文字起こし・チャットのファイルは `<brand>-content`（[ADR-0047](../decisions/0047-keys-and-operator-access-to-media.md)）。
- **秘密はハッシュで持つ**：参加の鍵、共有のトークン、招待のトークン、OAuth のトークン、端末の鍵（HMAC）、発信者の番号（HMAC）、パスコードの照合（HMAC）。
- **IP をそのまま持たない**：Aurora に置くのは `ip_prefix_hash`（pepper の版つき）、`ip_hash`、報告に添えた暗号文（90 日）だけ（[ADR-0046](../decisions/0046-audit-logs-and-data-lifecycle.md)）。
- **フェンシング**：Actor が書く行（`meeting_instances`、`meeting_participations`、`meeting_removals`、`capture_consents` など）は、`meeting_instances.actor_epoch <= :epoch` を条件にした更新にする（[ADR-0007](../decisions/0007-meeting-actor-lease-and-epoch.md)）。
- **失ってはならない変更**（退出させる、ロック、役割、待合室の設定、同意）は、Aurora に書けてから配る（ADR-0007）。
- **outbox**：外へ知らせる変更は、業務の変更と同じトランザクションで `global.outbox` に書く。Worker が通知・Webhook・監査の転送・カレンダーの書き戻し・録画の合成の依頼を行う（11 節）。
- **会議の内容をログ・メトリクスに出さない**：表の列を足すときも、ログ・トレース・メトリクスのラベルに本文・名前・パスコード・IP を出さない（本題材の [AGENTS.md](../../AGENTS.md)）。
- **保持**：表ごとの保持の期間は [security.md](security.md) の 9 節の表が正本。表を足す PR は、その表に行を足す。
- 本家の名前を、表・キー・バケット・ドメインの名前に使わない。`<brand>` で書く（リポジトリ共通の [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。

## 3. Aurora の表

### 3.1 会議と参加（[signaling-and-meetings.md](signaling-and-meetings.md)）

| 表 | 中身 | 定義の場所 |
| --- | --- | --- |
| `meetings` | 会議の行。統合した定義は 5.1 節 | signaling の 17 節、meeting-security の 14 節、scheduling の 12 節 |
| `meeting_instances` | 開催。統合した定義は 5.2 節 | signaling の 17 節 |
| `meeting_participations` | 1 人 1 回の参加。統合した定義は 5.3 節 | signaling の 17 節、network-traversal の 15 節、codecs の 14 節、clients の 15 節 |
| `meeting_removals` | 退出させた人の ban。統合した定義は 5.4 節 | signaling の 17 節、meeting-security の 14 節、telephony の 12 節 |
| `meeting_audit_events` | 主催者の操作の監査（outbox と同じトランザクション） | [security.md](security.md) の 6 節 |
| `meeting_media_assignments` | `instance_id`、`media_generation`、`node_id`、`role`（`primary`・`secondary`・`standby`）、`assigned_at`、`released_at`、`reason` | [media-server-sfu.md](media-server-sfu.md) の 15 節 |

### 3.2 会議の安全（[meeting-security.md](meeting-security.md)）

| 表 | 中身 |
| --- | --- |
| `abuse_reports` | `report_id`、`instance_id`、`reporter`・`reported`（`user_id` か `device_key_hash`）、`category`、`detail`（暗号化）、`attachments`、`ip_ciphertext`（90 日）、`status`、`action`、時刻 |

### 3.3 予定とカレンダー（[scheduling-and-calendar.md](scheduling-and-calendar.md)）

| 表 | 中身 |
| --- | --- |
| `meeting_occurrences` | 繰り返しの回ごとの例外（`modified`・`canceled`） |
| `meeting_invitees`、`meeting_alternative_hosts` | 招待の一覧、代わりの主催者 |
| `personal_meeting_ids` | PMI（10 桁、一意）、作り直しの履歴 |
| `calendar_connections`、`calendar_links` | OAuth の接続（リフレッシュトークンは暗号化）、予定と会議の対応（`(provider, calendar_event_id)` 一意） |

### 3.4 録画と文字起こし（[recording-and-transcription.md](recording-and-transcription.md)）

| 表 | 中身 |
| --- | --- |
| `recordings` | 録画の索引と状態、`legal_hold`、`retention_until`、`trashed_at` |
| `recording_segments`・`recording_files`・`recording_shares`・`recording_access_events`・`recording_deletions` | 区間、成果物（`sha256`）、共有（トークンのハッシュ）、再生の記録（`ip_hash`）、削除の記録 |
| `capture_consents` | `(instance_id, participant_id, kind)`、`notice_version`、`consented_at` |
| `transcripts`・`asr_vocabularies` | 文字起こしの索引、組織の語彙（暗号化） |

### 3.5 E2EE（[e2ee.md](e2ee.md)）

| 表 | 中身 |
| --- | --- |
| `e2ee_credentials` | `instance_id`、`participant_id`、証明書のシリアル、公開鍵の指紋、発行と失効。秘密鍵は持たない |
| `e2ee_ca_keys` | 中間 CA の ID、KMS の鍵の ARN、有効期間、状態（`global` スキーマ） |

### 3.6 チャット（[chat-and-reactions.md](chat-and-reactions.md)）

| 表 | 中身 |
| --- | --- |
| `meeting_chat_messages` | `save_chat` のときだけ。全員へのメッセージの暗号文、`retention_until` |
| `chat_files` | ファイルの索引とマルウェアの検査の状態、`expires_at` |

### 3.7 組織と管理（[accounts-and-admin.md](accounts-and-admin.md)）

| 表 | 中身 |
| --- | --- |
| `users`、`invitations`、`groups` | ユーザー（1 つの組織に属する）、招待、グループ |
| `sso_connections` | SSO の接続 |
| `org_settings`・`group_settings`・`user_settings` | 設定の階層と鍵（`(owner_id, key)`、`value`、`locked`） |
| `usage_daily`・`usage_user_daily`、`report_exports` | 利用の集計（36 か月）、CSV の書き出し |
| `admin_audit_events` | 組織の監査 |

### 3.8 品質（[observability.md](observability.md)）

| 表 | 中身 |
| --- | --- |
| `participant_quality_summaries` | 参加ごとの品質の要約（`mos_est` の分布、フリーズ、RTT、経路、付け替え）。12 か月 |

### 3.9 公開 API と Webhook（[api-and-webhooks.md](api-and-webhooks.md)）

| 表 | 中身 |
| --- | --- |
| `oauth_app_org_approvals`、`oauth_grants` | 組織の承認、許可 |
| `webhook_endpoints`、`webhook_deliveries` | 受け口（秘密は暗号化）、配送の記録（7 日） |

### 3.10 電話（[telephony.md](telephony.md)。E14、MVP の後）

| 表 | 中身 |
| --- | --- |
| `phone_calls` | 通話の記録（発信者の番号はハッシュと下 4 桁） |
| `dial_out_usage_daily` | 組織ごとのダイヤルアウトの分数と拒否 |

### 3.11 クライアント（[clients.md](clients.md)）

| 表 | 中身 |
| --- | --- |
| `client_releases` | デスクトップ・モバイルの版、配布の状態、最低の版（`min_client_version`）（`global` スキーマ） |

### 3.12 横断（[security.md](security.md)）

| 表 | 中身 |
| --- | --- |
| `platform_audit_events` | 運用者のアクセス、`media-prod` の操作、防御のモードと EIP の保護、Trust & Safety の措置、捜査機関への対応、リーガルホールド、`BYPASSRLS` のロールの使用（`global` スキーマ） |

### 3.13 `global` スキーマ（RLS の外）とその理由

| 表 | 理由 |
| --- | --- |
| `organizations`、`org_domains` | 組織そのもの。ドメインは組織をまたいで一意の判定が要る |
| Better Auth の表（`auth_identities`、`sessions`、`verifications`、`passkeys`、`sso_providers`） | ログインの前は組織が分からない。`identity` のモジュールの中だけで読む（[ADR-0038](../decisions/0038-organizations-users-roles-and-sso.md)） |
| `oauth_apps`、`oauth_tokens` | アプリは組織をまたいで公開される。トークンはハッシュで引く |
| `meeting_number_index`、`meeting_number_history` | 参加の API は番号から組織を知る。番号の 2 年の再使用の禁止は全体で判定する |
| `global_device_bans`、`phone_numbers` | 全体の ban、共用の番号 |
| `client_releases`、`e2ee_ca_keys` | 全体の設定 |
| `platform_audit_events` | 運用者の操作は組織をまたぐ |
| `outbox` | 行ごとに `org_id` を持つが、Worker が組織をまたいで読む |

## 4. Valkey のキー

| キー | 中身 | TTL | 定義の場所 |
| --- | --- | --- | --- |
| `mtg:{m}:lease`・`:epoch` | Actor のリース `{host_id, epoch}` と `epoch` | リース 6 秒 | [signaling-and-meetings.md](signaling-and-meetings.md) の 5.3 節 |
| `mtg:{m}:snap` | 状態のスナップショット（`video_mode`、`audio_mode`、`media`、`effective_flags`、MLS のエポックと GroupInfo を含む） | 24 時間 | 同 10.1 節、[e2ee.md](e2ee.md) の 17 節 |
| `mtg:{m}:jti:{jti}` | 参加のトークンの使い回しの検知 | 10 分 | 同 5.3 節 |
| `mtg:{m}:chat`（Stream）、`mtg:{m}:chat:cmid:{from}:{client_msg_id}` | 会議の間のチャット（会議の鍵で暗号化。E2EE の会議は MLS の暗号文だけ）、重複の検出 | 会議の終了から 24 時間、10 分 | [chat-and-reactions.md](chat-and-reactions.md) の 3.6 節 |
| `mnode:{node_id}:load`・`:state` | Node の負荷、状態（`booting`・`active`・`draining`・`under_attack`・`dead`） | 5 秒 | [media-server-sfu.md](media-server-sfu.md)、[infrastructure.md](infrastructure.md) の 3.5 節 |
| `turn:{node_id}:load` | TURN の心拍と割り当ての数 | 5 秒 | [network-traversal.md](network-traversal.md) |
| `rl:{axis}:{value}`、`rl:nums:{ip_prefix}`（HyperLogLog） | 参加の流量の制限、試した番号の種類 | 窓による | [meeting-security.md](meeting-security.md) の 8.2 節 |
| `sec:{m}:pwfail` | 会議のパスコードの誤りの数 | 1 時間 | 同上 |
| `rl:api:{app}:{org}:{category}`・`rl:api:mw:{user}:{day}` | 公開 API のレート制限 | 窓による | [api-and-webhooks.md](api-and-webhooks.md) の 5.2 節 |

- `{m}` は Valkey のハッシュタグで、1 つの会議のキーを同じスロットに置く。Valkey は大阪へ複製しない。

## 5. 統合した定義

複数の領域が列を足す表。列の意味の正本は「定義の場所」の文書にある。

### 5.1 `meetings`

| 列 | 提案した領域 |
| --- | --- |
| `meeting_id`、`org_id`、`meeting_number`（11 桁、一意）、`host_user_id`、`join_key_hash`、`settings`（JSON。`e2ee: {enabled}` を含む）、`created_at` | signaling、e2ee |
| `type`（`instant`・`scheduled`・`recurring`・`recurring_no_fixed_time`・`pmi`）、`topic`、`start_local`、`timezone`、`duration_min`、`recurrence`、`expires_at`、`canceled_at`、`ics_sequence` | scheduling |
| `waiting_room`、`passcode_ciphertext`、`passcode_hmac`、`phone_passcode_ciphertext`、`phone_passcode_hmac`、`join_before_host`、`bypass`（`org`・`domains`・`invitees`）、`show_topic_in_waiting_room` | meeting-security、telephony |

- `CHECK (waiting_room OR passcode_hmac IS NOT NULL)` を置き、書き込みは `assertJoinGuard` を通す 1 つの関数に集める（[ADR-0031](../decisions/0031-waiting-room-and-passcode-rules.md)）。

### 5.2 `meeting_instances`

| 列 | 提案した領域 |
| --- | --- |
| `instance_id`、`meeting_id`、`org_id`、`status`、`actor_epoch`、`started_at`、`ended_at`、`media_region`（部分一意：`meeting_id WHERE ended_at IS NULL`） | signaling |
| `effective_settings`（開催の開始で解決した値） | accounts-and-admin |
| `effective_flags`（開催の開始で評価した meeting のフラグ）、`audio_mode`（`per_sender`・`slots`） | delivery、media-server-sfu（[ADR-0057](../decisions/0057-audio-slots-for-large-meetings.md)） |

### 5.3 `meeting_participations`（codecs と clients の提案を 1 つにまとめた）

| 列 | 中身 | 提案した領域 |
| --- | --- | --- |
| `instance_id`、`participant_id`、`org_id`、`user_id?`、`role`、`joined_at`、`left_at`、`leave_reason` | 参加の記録 | signaling |
| `client_kind` | `web`・`desktop`・`ios`・`android`・`phone`（`hello.client.kind` と同じ） | clients・codecs（同じ列を 1 つにした） |
| `client_version`、`os` | クライアントの版、OS | clients |
| `browser`、`browser_version` | ブラウザの系統と版（`phone` と アプリでは空） | clients・codecs（同じ列を 1 つにした） |
| `video_codec` | 送った映像の符号器 | codecs |
| `ice_path`、`ip_family` | `udp_direct`・`tcp_direct`・`turn_udp`・`turn_tcp`・`turn_tls`、`ipv4`・`ipv6`。IP そのものは持たない | network-traversal |

- 月ごとのパーティション（12 か月の保持。[ADR-0040](../decisions/0040-usage-reports.md)）。

### 5.4 `meeting_removals`

| 列 | 提案した領域 |
| --- | --- |
| `meeting_id`、`org_id`、`user_id?`、`removed_by`、`removed_at`、`readmitted_at`、`expires_at`（最後の開催から 30 日） | signaling、meeting-security |
| `device_key_hash?`、`ip_prefix_hash?`、`ip_pepper_version` | meeting-security（pepper は 30 日ごとに替え、前の版も 30 日照合する） |
| `caller_id_hash?` | telephony |

### 5.5 監査ログ 3 系統（`meeting_audit_events`・`admin_audit_events`・`platform_audit_events`）

| 列 | 中身 |
| --- | --- |
| `event_id`、`stream_seq`（系統ごとの連番）、`org_id`（プラットフォームの監査では空もある）、`actor`、`action`、`target`、`reason_code`、`detail`（内容を含めない）、`occurred_at` | 共通 |
| `prev_hash`、`hash` | `hash = SHA-256(prev_hash || 正準化した行)`。3 系統で同じ形にし、日次のジョブで連鎖を検証する（[ADR-0046](../decisions/0046-audit-logs-and-data-lifecycle.md)） |

## 6. S3 のバケットとキー

バケットの名前は既定案（`<brand>` は ADR-0006 の置き換え）。

| バケット（アカウント） | キー | 中身 | 保持 |
| --- | --- | --- | --- |
| `<brand>-recordings-{env}`（`media-prod`、東京） | `raw/{org}/{recording_id}/…`、`final/{org}/{recording_id}/…`、`transcripts/{org}/{instance_id}/…` | 生の区切りとマニフェスト、成果物、字幕の確定した結果 | 7 日（失敗は 30 日）、組織の設定（既定 365 日＋ごみ箱 30 日） |
| `<brand>-files-{env}`（`prod`） | `chat-files/{org}/{instance_id}/{file_id}`、`reports/{org}/{report_id}/…`、`exports/{org}/{export_id}` | チャットのファイル、報告の添付、レポートの書き出し | チャットと同じ、1 年、7 日 |
| `<brand>-observability-{env}`（`prod`） | `qos/raw/dt=…/hour=…/`、`qos/daily/` | 品質の生の記録（Parquet）、日次の集計 | 30 日、13 か月 |
| log-archive のバケット | 監査ログ、CloudTrail、ネットワークの部品のログ | Object Lock | 7 年（IP を含むログは 30 日） |
| shared のバケット | `/app/<version>/`、Terraform の状態 | Web の資産、状態 | 版ごと、90 日 |

- 録画のバケットは大阪へ複製しない（S1。[recording-and-transcription.md](recording-and-transcription.md) の 6.1 節）。
- チャットのファイルは別のドメイン（`<brand>files.<domain>`）の CloudFront から配る。

## 7. SQS・Firehose・AMP

| 置き場所 | 中身 |
| --- | --- |
| SQS `webhook-delivery` | Webhook の配送（[ADR-0044](../decisions/0044-signed-webhooks-standard-webhooks.md)） |
| SQS `recording-compose` | 録画の合成の依頼 |
| SQS `qos-summary` | 接続ごとの品質の要約 → `participant_quality_summaries` |
| SQS `calendar-sync`、`notifications`、`audit-forward`、`retention` | カレンダーの取り込みと書き戻し、メール、監査ログの log-archive への転送、保持の期限の削除 |
| Firehose `qos` | `qos.report` と Media Node の transport・consumer の要約 → S3 |
| AMP | SLI の分子と分母、Node・TURN・制御の側の数。ラベルに会議・参加者・組織・IP を入れない（[ADR-0051](../decisions/0051-qos-telemetry-pipeline.md)） |

## 8. 鍵と秘密

| 置き場所 | 中身 |
| --- | --- |
| KMS の鍵 5 つ | `<brand>-join-signing`、`-meeting-secrets`、`-content`、`-e2ee-as`、`-data`（[ADR-0047](../decisions/0047-keys-and-operator-access-to-media.md)） |
| Secrets Manager | `turn/static-auth-secret`（今と次）、パスコードの HMAC の pepper（版つき）、`ip_prefix_hash` の pepper（今と前）、E2EE の外部の送り手の鍵、カレンダーの OAuth のクライアント、TURN の TLS の証明書、DB の認証情報 |
| AWS Private CA | Actor Host と Node Agent の相互 TLS の証明書（7 日） |
| 保存しない | Media Node の DTLS の証明書、PlainTransport の SRTP の鍵、E2EE の端末の鍵と MLS の秘密 |

## 9. Actor と Media Node の状態（メモリ）

| 置き場所 | 中身 | 定義の場所 |
| --- | --- | --- |
| Actor の状態 | 参加者、待合室、ロック、`video_mode`・`video_mode_locked`、`audio_mode`、`media.generation`・`nodes`・`standby`、`effective_flags`、録画・字幕の状態、同意、MLS のエポックと GroupInfo、コミットの担当者、`chat_seq`・`ch_seq` | [signaling-and-meetings.md](signaling-and-meetings.md) の 10.1 節、[codecs-and-bandwidth-adaptation.md](codecs-and-bandwidth-adaptation.md) の 14 節、[e2ee.md](e2ee.md) の 17 節 |
| Media Node | 会議ごとの最大の `epoch`、router・transport・producer・consumer、音声の枠の producer と転送器の状態 | [media-server-sfu.md](media-server-sfu.md) の 4.3・5.3 節 |

## 10. 保持

- 正本は [security.md](security.md) の 9 節（[ADR-0046](../decisions/0046-audit-logs-and-data-lifecycle.md)）。期間はすべて既定案で、法務の確認（L2・L4・L6・L8）で確定する。
- 保持の期限の削除は、1 つのジョブ（E10 の `retention-jobs`）が表ごとの規則で行う。`meeting_participations` と `participant_quality_summaries`（どちらも 12 か月）は同じ実行で消す。リーガルホールドの付いたものは消さない。

## 11. 統合で決めたこと（2026-09-27）

| # | 内容 | 決めたこと |
| --- | --- | --- |
| 1 | `meeting_participations` に codecs と clients が同じ列（`client_kind`、`browser`、`browser_version`）を別々に提案していた | 1 つにまとめた（5.3 節）。`client_kind` に `phone` を足した |
| 2 | `ip_prefix_hash` の pepper を 30 日ごとに替えると、ban の途中で同じ回線の判定が切れる | 前の pepper を 30 日残し、今と前の両方で照合する。`ip_pepper_version` を持つ（5.4 節、[meeting-security.md](meeting-security.md) の 10 節） |
| 3 | 組織の分離に RLS を使うか | FORCE RLS を使う（[ADR-0058](../decisions/0058-tenant-tables-with-force-rls.md)、2 節、3.13 節） |
| 4 | 大きな会議の音声の consumer が人数の 2 乗で増える | 100 人を超える会議は音声の枠（[ADR-0057](../decisions/0057-audio-slots-for-large-meetings.md)）。`meeting_instances.audio_mode` を足した |
| 5 | 監査ログ 3 系統のハッシュの連鎖の列 | 同じ形にした（5.5 節） |
| 6 | Webhook のもとの outbox と、監査ログの転送の outbox | 1 つの `global.outbox` にし、`topic`（`webhook`・`audit_forward`・`notification`・`calendar`・`recording_compose`）で分ける。SQS は topic ごと（7 節） |
| 7 | `participant_quality_summaries` と `meeting_participations` の削除 | 同じ保持のジョブで行う（10 節） |

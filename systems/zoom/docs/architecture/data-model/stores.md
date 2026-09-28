# Data model: DB の外の置き場所とメッセージ

[data-model.md](../data-model.md) の一部。Valkey のキー、S3 の置き場所、品質の記録、シグナリングのメッセージ、outbox・SQS・Webhook の封筒、Meeting Actor と Media Node のメモリ、鍵と秘密、端末をまとめる。

## 1. 共通の規則

- **会議か組織で区切る。** Valkey のキーは会議（`{m}`）か軸の値を含める。S3 のキーは `{org}` を含める（I-26）。含めないのは、組織が決まる前に数える流量の制限（IP の軸）と、Node・TURN・Actor Host の心拍だけ。
- 名前の中の `{...}` は置き換える部分（`{m}` は `meeting_id` の外の形、`{org}` は `org_id`）。**`{m}` だけは実際のキーでも波かっこを残し、Valkey のハッシュタグにする**（例：`mtg:{mtg_01J9...}:lease`）。1 つの会議のキーを同じスロットに置き、1 つの Lua のスクリプトで扱うため。その他は波かっこを残さない（例：`mnode:mn-tyo-a-017:load`）。
- 会議の内容を平文で置かない。チャットの本文は会議ごとのデータの鍵で暗号化してから置く（E2EE の会議は MLS の暗号文だけ）。
- Valkey は失ってよい（大阪へ複製しない。[ADR-0007](../../decisions/0007-meeting-actor-lease-and-epoch.md)）。失ったときの振る舞いは各行の「失ったとき」。

## 2. Valkey

ElastiCache（クラスタモード、3 シャード）。

### 2.1 会議（Meeting Actor）

| キー | 型 | TTL | 中身 | 書く / 読む | 失ったとき | 定めた場所 |
| --- | --- | --- | --- | --- | --- | --- |
| `mtg:{m}:epoch` | string（整数） | なし（会議の終了で消す） | `epoch`。取るたびに `INCR`。減らない | Actor Host（Lua） | 取るときに下限（`meeting_instances.actor_epoch` と、取得を頼む Gateway が見た最大の `epoch` の大きい方＋ 1）を渡し、`epoch = max(INCR, 下限)` にする。Media Node が `stale_epoch` と見た最大の `epoch` を返したら、その値＋ 1 を下限にして取り直す（[data-model.md](../data-model.md) の 11.2 節の 16） | [signaling-and-meetings.md](../signaling-and-meetings.md) の 5.3 節 |
| `mtg:{m}:lease` | string（JSON） | 6,000ms | `{host_id, epoch}`。2 秒ごとに `PEXPIRE` | Actor Host / Gateway | 持ち主が 4.5 秒で止まり、取り直す | 同上、ADR-0007 |
| `mtg:{m}:snap` | string（JSON、圧縮） | 24 時間 | スナップショット（7 節）。変化があれば 500ms ごと | Actor Host | 回復は Aurora・Node の一覧・クライアントの申告から | 同 10.1 節 |
| `mtg:{m}:jti:{jti}` | string | 10 分 | `1`。参加のトークンの使い回しの検知 | Actor Host | 10 分の間、同じトークンを 2 回使える（トークンは 120 秒で失効するので影響は小さい） | 同 5.3 節 |
| `mtg:{m}:invite:{token_hash}` | string（JSON） | 10 分 | `{issued_by, issued_at}`。`host.invite` の 1 回限りの招待のトークン（`GETDEL`） | Actor Host / API | 招待をやり直す | この文書（2026-09-28）、[meeting-security.md](../meeting-security.md) の 3.3 節 |
| `mtg:{m}:chat` | Stream | 会議の終了から 24 時間 | 項目 `chat_seq`・`channel`・`ch_seq`・`from`・`from_name`・`text`（暗号文）・`file_id`・`reply_to`・`sent_at`・`deleted`。1 会議 20,000 件まで | Actor Host / Worker（`save_chat` と録画の `chat`） | 会議の間の履歴を失う。送受信は新しい Stream で続く | [chat-and-reactions.md](../chat-and-reactions.md) の 3.6 節 |
| `mtg:{m}:chat:cmid:{from}:{client_msg_id}` | string | 10 分 | `chat_seq`。重複の検出 | Actor Host | 10 分の間の再送が 2 件になりうる | 同 3.2 節 |
| `sec:{m}:pwfail` | string（整数） | 1 時間 | 会議のパスコードの誤りの合計（50 回で鍵のない参加を止める） | API | 数え直し | [meeting-security.md](../meeting-security.md) の 8.2 節 |

- `mtg:{m}:snap` にはチャットの本文、パスコード、参加の鍵、再接続用の秘密の平文を入れない（再接続用の秘密はハッシュ）。
- 会議の終了（Ending → Ended）で、Actor は `lease` を返し、`epoch` と `snap` を消す。`chat` は TTL に任せる。

### 2.2 流量の制限

トークンバケット（スライドする窓）。Valkey が止まったら、各タスクの手元の数で数える（上限をタスクの数で割る）。止まっても参加を止めない。

| キー | 型 | TTL | 軸と上限 | 定めた場所 |
| --- | --- | --- | --- | --- |
| `rl:{axis}:{value}` | string（GCRA の `TAT`） | 窓＋バースト | `axis` は `ip`（参加の要求、毎分 30）、`ip404`（存在しない会議、1 時間 50）、`mip`（`meeting_id × ip_prefix` のパスコードの誤り、10 分 10）、`user`（毎分 60）、`caller`（電話の `caller_id_hash`。E14）、`wrip`（1 つの回線から同じ会議の待合室、3 人）。`value` は HMAC にした値 | [meeting-security.md](../meeting-security.md) の 8.2 節、[ADR-0033](../../decisions/0033-join-rate-limits-and-enumeration-defense.md) |
| `rl:nums:{ip_prefix_hash}` | HyperLogLog | 10 分 | 試した会議の番号の種類（20 で CAPTCHA） | 同上 |
| `rl:captcha:{ip_prefix_hash}` | string | 1 時間 | CAPTCHA を解いた印（制限を 1 時間ゆるめる） | 同 8.3 節 |
| `rl:api:{app}:{org}:{category}` | string | 窓 | 公開 API の分類ごと（light 30/秒、medium 20/秒、heavy 10/秒、resource-intensive 10/分） | [api-and-webhooks.md](../api-and-webhooks.md) の 5.2 節 |
| `rl:api:daily:{org}:{yyyymmdd}` | string（整数） | 25 時間 | heavy と resource-intensive の合計（1 日 60,000。UTC） | 同上。キーはこの文書で決めた |
| `rl:api:mw:{user}:{yyyymmdd}` | string（整数） | 25 時間 | 利用者ごとの会議の作成・更新（1 日 100 回。UTC） | 同上 |
| `rl:share:{share_id}:{ip_prefix_hash}` | string | 15 分 | 録画の共有のパスコードの誤り（会議のパスコードと同じ形：10 分 10 回） | [recording-and-transcription.md](../recording-and-transcription.md) の 6.2 節。キーはこの文書で決めた |
| `rl:report:{instance_id}:{participant_id}` | string（整数） | 会議の終了から 24 時間 | 報告（1 人 1 会議 5 件） | [meeting-security.md](../meeting-security.md) の 6.3 節。同上 |
| `rl:dialout:{user_id}` | string | 1 時間 | ダイヤルアウト（1 ユーザー 1 時間 10 回）。組織の 1 日の分数は Aurora の `dial_out_usage_daily` | [telephony.md](../telephony.md) の 5 節。同上 |
| `rl:wh:{org}` | string | 1 秒 | Webhook の組織ごとの配送（毎秒 50。超えた分は遅らせる） | [api-and-webhooks.md](../api-and-webhooks.md) の 7.4 節。同上 |

- シグナリングの接続ごとの制限（`cmd` 毎秒 20、`view.update` 毎秒 4、チャット毎秒 3、リアクション毎秒 1）は、Gateway と Actor のメモリで数える。Valkey に置かない。

### 2.3 Node・TURN・Actor Host の心拍

| キー | 型 | TTL | 中身 | 書く / 読む | 定めた場所 |
| --- | --- | --- | --- | --- | --- |
| `mnode:{node_id}:load` | hash | 5 秒 | 1 秒ごとの負荷の報告：worker ごとの CPU、consumer の数、送出の bps・pps、ENA の `*_allowance_exceeded` の増分、点（`score`）、`site`、`generation`、AZ | Node Agent（Assignment Service 経由）/ Assignment Service | [media-server-sfu.md](../media-server-sfu.md) の 8.1 節 |
| `mnode:{node_id}:state` | string | 5 秒 | `booting` / `active` / `draining` / `under_attack` / `dead` | 同上 | [infrastructure.md](../infrastructure.md) の 3.5 節 |
| `mnode:index` | sorted set | なし | 要素は `node_id`、スコアは最後の報告の時刻。Assignment Service が 5 秒より古い要素を外す | Assignment Service | この文書（2026-09-28） |
| `turn:{node_id}:load` | hash | 5 秒 | TURN の台の心拍と割り当ての数、中継の帯域 | TURN の台のエージェント / 参加の API（ICE のサーバーの一覧の重み） | [network-traversal.md](../network-traversal.md) |
| `turn:index` | sorted set | なし | `mnode:index` と同じ形 | 同上 | この文書 |
| `ahost:{host_id}` | hash | 5 秒 | Actor Host の心拍（2 秒ごと）と会議の数（上限 2,000） | Actor Host / Gateway（rendezvous hashing の候補） | この文書。[signaling-and-meetings.md](../signaling-and-meetings.md) の 5.3 節 |
| `ahost:index` | sorted set | なし | 同上 | 同上 | この文書 |

- Assignment Service は Valkey を失っても、Node の次の報告（1 秒）で戻る（[media-server-sfu.md](../media-server-sfu.md) の 8.1 節）。Media Node は Valkey に直接つながない（`media-prod` から `prod` の Valkey へは届かない。報告は Assignment Service の口へ送る）。

## 3. S3

バケットの名前は論理名。`<brand>` は ADR-0006 の置き換え。暗号化の鍵は [ADR-0047](../../decisions/0047-keys-and-operator-access-to-media.md)。

| バケット（アカウント） | キー | 中身 | 鍵 | 保持 |
| --- | --- | --- | --- | --- |
| `<brand>-recordings-{env}`（`media-prod`、東京） | `raw/{org}/{recording_id}/{producer_id}/{seq}.rtpseg` | producer ごとの生の RTP（SRTP を外したもの）と受けた時刻（単調な時計の ns）。10 秒ごとに 1 ファイル | `<brand>-content`（文脈に `org_id`・`recording_id`） | 合成の成功から 7 日。失敗は 30 日 |
| 同上 | `raw/{org}/{recording_id}/manifest.jsonl` | 1 行 1 イベント（`segment`・`producer`・`speaker`・`share`・`pause`・`gap`・`participant`）。形は [recording-and-transcription.md](../recording-and-transcription.md) の 4.3 節 | 同上 | 同上 |
| 同上 | `final/{org}/{recording_id}/speaker_share.mp4`、`gallery.mp4`、`audio.m4a`、`audio/{participant_id}.m4a`、`chat.txt`、`transcript.vtt`、`transcript.json` | 成果物（`recording_files.s3_key`） | 同上 | 組織の設定（既定 365 日）＋ごみ箱 30 日。版も消す |
| 同上 | `transcripts/{org}/{instance_id}/part-{n}.jsonl` | 字幕の確定した結果（Transcriber が 30 秒ごとに追記） | 同上 | 会議の後に Composer がつないだら 7 日 |
| 同上 | `transcripts/{org}/{instance_id}/transcript.json`、`transcript.vtt` | 録画のない会議の文字起こし（`transcripts.s3_key`） | 同上 | 組織の設定 |
| `<brand>-files-{env}`（`prod`） | `chat-files/{org}/{instance_id}/{file_id}` | チャットのファイル。GuardDuty の検査のタグ | `<brand>-content` | `chat_files.expires_at` |
| 同上 | `reports/{org}/{report_id}/{attachment_id}` | 報告の添付 | 同上 | 報告と同じ（1 年） |
| 同上 | `exports/{org}/{export_id}.csv.gz` | レポートの書き出し | `<brand>-data` | 7 日 |
| `<brand>-observability-{env}`（`prod`） | `qos/raw/source={client｜node}/dt={yyyy-mm-dd}/hour={hh}/…parquet` | 品質の生の記録（4 節） | `<brand>-data` | 30 日 |
| 同上 | `qos/daily/dt={yyyy-mm-dd}/…parquet` | 日次の集計（参加者の ID なし） | 同上 | 13 か月 |
| log-archive のバケット | `audit/{stream}/{chain_key}/{yyyy}/{mm}/{dd}/{batch_id}.jsonl.gz` | 監査ログ 3 系統のバッチ（行の `hash` を含む） | log-archive の鍵 | Object Lock で 7 年 |
| 同上 | CloudTrail、Media Node・TURN・CloudFront・ALB・WAF のログ | IP を含むログ | 同上 | IP を含むものは 30 日、その他は 7 年 |
| shared のバケット | `app/{version}/`、Terraform の状態、AMI の配布 | Web の資産、状態 | — | 版ごと、90 日 |

- 録画のバケットは大阪へ複製しない（S1。[recording-and-transcription.md](../recording-and-transcription.md) の 6.1 節）。バージョニングを有効にする（成功を知らせた録画を失わない）。
- 公開のアクセスを禁じる。読むのは API が出す短命の署名付きの URL（録画は CloudFront で 10 分、チャットのファイルは 5 分、書き出しは 24 時間）だけ。
- チャットのファイルは別のドメイン（`<brand>files.<domain>`）の CloudFront から配る。
- 組織の削除は、各バケットの `{org}/` の接頭辞を一括で消す。log-archive は期限まで残る。

## 4. 品質の記録

[ADR-0051](../../decisions/0051-qos-telemetry-pipeline.md)、[observability.md](../observability.md) の 2〜3 節。

```
クライアント ── qos.report（10 秒ごと、WSS）──▶ Gateway ──▶ Firehose qos ──▶ S3 qos/raw/source=client
            └ 退出の時の残り ── sendBeacon ──▶ API /v1/qos ──▶ 同じ Firehose
Node Agent ── transport・consumer の要約（10 秒ごと）──▶ Firehose qos ──▶ S3 qos/raw/source=node
Gateway ── 接続ごとの要約（退出の時）──▶ SQS qos-summary ──▶ Worker ──▶ Aurora participant_quality_summaries
Gateway ── SLI の分子・分母（低い種類のラベル）──▶ AMP
毎日のジョブ（Athena CTAS）── qos/raw ──▶ qos/daily
```

### 4.1 `qos.report`（クライアント → Gateway）

| 群 | 項目 |
| --- | --- |
| 共通 | `participant_id`、`instance_id`、`window_start`、`client_kind`、`browser`・`browser_version`、`ice_path`、`ip_family`、`media_generation` |
| 経路 | `rtt_ms`（`currentRoundTripTime`）、`available_out_bps`、`available_in_bps` |
| 受けた音声（最大 3） | `lost`・`received` の増分、`jitter_ms`、`concealed`・`silent_concealed`・`total_samples`・`concealment_events` の増分、`jb_delay`・`jb_emitted` の増分、`mos_est` |
| 受けた映像（最大 25。上位 5 本を詳しく、残りは合計） | `frames_decoded`・`frames_dropped` の増分、`frame_height`、`fps`、`freeze_count`・`freeze_duration` の増分、`pli`・`nack` の増分 |
| 送った流れ | `target_bps`、`quality_limitation_reason`・時間の増分、送っている `rid`、`remote_rtt_ms`、`remote_fraction_lost` |
| 端末 | CPU の圧迫の時間、端末の処理の自動の低下の段階 |

- 送らない：ICE の候補の文字列、IP、表示の名前、会議の題名、チャット、字幕、端末の識別子。項目を足す PR は、外部送信の公表（L5）の文面を更新する。
- Firehose の 1 件は、Gateway のタスクごとに 1 秒分をまとめた改行区切りの JSON。

### 4.2 Parquet の列（`qos/raw`）

| 列 | 型 | 説明 |
| --- | --- | --- |
| `source` | string | `client` / `node`（分割のキー） |
| `dt`、`hour` | string | 分割のキー |
| `instance_id`、`participant_id` | string | 外の形。`node` は `participant_id` の代わりに `transport_id`・`consumer_id` も持つ |
| `org_id` | string | Athena で組織を絞るため（組織の許可を前提に運用者だけが読む） |
| `window_start` | timestamp | |
| `node_id`、`node_generation`、`az` | string | `node` の記録と、クライアントの `media_generation` から引いた値 |
| 4.1 節の数値 | bigint・double | 群ごとの構造体（`audio`・`video`・`send`）の配列 |

- Athena のワークグループは運用者だけ。組織の管理者に見せるのは Aurora の要約だけ（[observability.md](../observability.md) の 3 節）。

### 4.3 SQS `qos-summary`

```jsonc
{ "v": 1, "org_id": "org_...", "instance_id": "mi_...", "participant_id": "p_...",
  "gateway_task": "…", "window": { "from": "…", "to": "…" },
  "audio_minutes": 42, "audio_good_minutes": 40, "mos_est": { "p50": 4.1, "p10": 3.7 },
  "video_minutes": 42, "freeze_free_minutes": 41, "freeze_count": 2, "freeze_seconds": 3.1,
  "rtt_ms": { "p50": 18, "p95": 40 }, "loss_pct_p95": 1.2,
  "ice_path": "udp_direct", "ip_family": "ipv4", "browser": "chrome", "client_kind": "web",
  "reattach_count": 0, "reconnect_count": 1, "leave_reason": "left", "quality_limitation": "none" }
```

- Worker は `participant_quality_summaries` に加算する（再接続で Gateway が替わると、同じ参加に 2 通来る）。

## 5. シグナリングのメッセージ

型の正本は `@<brand>/signaling-schema`（Zod）。一覧は [signaling-and-meetings.md](../signaling-and-meetings.md) の 6.2 節。ここは、封筒と、何がどこに残るかだけを書く。

### 5.1 封筒

| `t` | 向き | 項目 | 順序 |
| --- | --- | --- | --- |
| `cmd` | クライアント → サーバー | `id`、`name`、`body` | 接続の中で順 |
| `ack` | サーバー → クライアント | `id`、`seq`（か `chat_seq`） | — |
| `err` | サーバー → クライアント | `id`、`code`、`retryable` | — |
| `evt` | サーバー → クライアント | `epoch`、`seq`、`name`、`body` | `(epoch, seq)` で全順序 |
| `snap` | サーバー → クライアント | `epoch`、`seq`、`body`（7 節の形から秘密を除いたもの） | — |
| `eph` | サーバー → クライアント | `name`、`body` | なし（落としてよい） |
| `ping`・`pong` | 両方向 | `ts` | — |

- 1 メッセージは、クライアント → サーバーで 64 KiB、サーバー → クライアントで 1 MiB まで。

### 5.2 何がどこに残るか

| メッセージ | Actor のメモリ | Valkey | Aurora | outbox・Webhook |
| --- | --- | --- | --- | --- |
| `hello` → `welcome` | 参加者 | `jti` | `meeting_participations`（2.10 節の形）、初回は `meeting_instances` | `participant.joined`・`participant.waiting`、初回は `meeting.started` |
| `self.update`（ミュート、ビデオ、挙手、名前） | 状態 | スナップショット | 名前だけ（`display_name`） | — |
| `host.mute`・`mute_all`・`stop_video`・`stop_share`・`ask_unmute` | 状態 | スナップショット | — | — |
| `host.remove`・`host.readmit` | 状態 | スナップショット | `meeting_removals`、`meeting_audit_events`（書けてから配る） | 監査の転送 |
| `host.lock`・待合室の設定・`host.suspend` | 状態 | スナップショット | `meeting_instances.locked`・`waiting_room`、`meeting_audit_events` | 監査の転送 |
| `host.set_role` | 状態 | スナップショット | `meeting_participations.role`、`meeting_audit_events` | 監査の転送 |
| `host.admit`・`deny`・`admit_all`・`to_waiting` | 状態 | スナップショット | `meeting_participations.admitted_at`・`leave_reason` | `participant.joined` |
| `host.end` | Ending | 消す | `meeting_instances.ended_at`、参加の行を閉じる、`meeting_audit_events` | `meeting.ended`、`participant.left` |
| `consent.give` | 状態 | スナップショット | `capture_consents`（書けてから購読に足す） | — |
| `recording.*`・`captions.*` | 状態 | スナップショット | `recordings`・`recording_segments`・`transcripts`、`meeting_audit_events` | `recording.started`・`recording.stopped`、終了で `recording.compose` |
| `chat.send`・`chat.delete` | `chat_seq` | `mtg:{m}:chat` | 会議の後に `meeting_chat_messages`（`save_chat` のとき） | 会議の終了で `chat_save` |
| `reaction.send` | — | — | — | — |
| `e2ee.commit`・`e2ee.app` | MLS のエポックと GroupInfo | スナップショット | 退出で `e2ee_credentials.revoked_at` | — |
| `media.*` | 購読と割り当て | スナップショット | 付け替えで `meeting_media_assignments` | — |
| `qos.report` | 通らない | — | 退出で `participant_quality_summaries` | — |
| `caption.partial`・`caption.final`（`eph`） | — | — | — | — |

## 6. outbox・SQS・Webhook

### 6.1 outbox の topic と SQS

`global.outbox`（[governance.md](governance.md) の 4 節）の行を、Worker が topic ごとの SQS に入れる。SQS のメッセージは「きっかけ」で、Worker は中身を Aurora から読み直す（Webhook は outbox の `payload` を使う）。

| topic | SQS | 受ける Worker | 中身 |
| --- | --- | --- | --- |
| `webhook` | `webhook-delivery` | Webhook Worker | 許可した組織とスコープで宛先を決め、`webhook_deliveries` を作って送る |
| `audit_forward` | `audit-forward` | 監査の転送 | 監査の行の範囲を log-archive へ |
| `notification` | `notifications` | 通知 | 招待のメール（iCalendar）、録画の完成、Webhook の停止、SAML の証明書の期限 |
| `calendar` | `calendar-sync` | Calendar Sync | 予定の書き戻し、通知の後の差分の取り込み |
| `recording_compose` | `recording-compose` | Composer（`media-prod`） | `{org_id, recording_id, instance_id, manifest_key}` |
| `chat_save` | `chat-save` | チャットの保存 | Valkey の Stream から `meeting_chat_messages` と録画の `chat.txt` の元へ |

`outbox` を通らない SQS：

| SQS | 送る側 → 受ける側 | 中身 |
| --- | --- | --- |
| `recording-events` | Composer・Recorder（`media-prod`）→ Worker（`prod`） | `{recording_id, org_id, event: compose_succeeded｜compose_failed｜recorder_failed, files?: [{kind, participant_id?, s3_key, bytes, sha256, duration_ms}]}`。Worker が `recordings`・`recording_files` を更新し、`recording.completed` を outbox に書く（2026-09-28 に決定） |
| `qos-summary` | Gateway → Worker | 4.3 節 |
| `retention` | 定期の起動（EventBridge Scheduler）→ 保持のジョブ | `{kind, org_id}`。`scheduler_due_orgs` の結果を組織ごとに入れる |
| `malware-scan-result` | GuardDuty（EventBridge）→ Worker | チャットのファイルと報告の添付の検査の結果 |

- どの SQS も、失ったら outbox か表から作り直せる。Worker は冪等にする（`event_id`、`instance_id`、`recording_id` で重複を捨てる）。

### 6.2 outbox の行と封筒

| 封筒の項目 | outbox の列 |
| --- | --- |
| `id` | `event_id`（`evt_`） |
| `type` | `event_type` |
| `org_id` | `org_id` |
| `occurred_at` | `created_at` |
| `api_version` | 固定（`v1`） |
| `data` | `payload` |

### 6.3 Webhook のイベント

封筒は上と同じ（[api-and-webhooks.md](../api-and-webhooks.md) の 7.4 節）。ヘッダーは `webhook-id`（`webhook_deliveries.delivery_id`）・`webhook-timestamp`・`webhook-signature`（[ADR-0044](../../decisions/0044-signed-webhooks-standard-webhooks.md)）。

| `type` | `data` | 読むスコープ |
| --- | --- | --- |
| `meeting.created`・`meeting.updated`・`meeting.deleted` | `meeting_id`、`meeting_number`、`topic`、`type`、`start`、`timezone`、`host_user_id`、`version` | `meeting:read` |
| `meeting.started`・`meeting.ended` | `meeting_id`、`instance_id`、`started_at`・`ended_at`、`host_user_id` | `meeting:read` |
| `participant.joined`・`participant.left` | `instance_id`、`participant_id`、`user_id?`、`display_name`、`kind`、`at`、`leave_reason?` | `meeting:read` |
| `participant.waiting` | `instance_id`、`participant_id`、`display_name`、`at` | `meeting:read` |
| `recording.started`・`recording.stopped` | `recording_id`、`instance_id`、`at` | `recording:read` |
| `recording.completed` | `recording_id`、`instance_id`、`files`（`kind`・`bytes`） | `recording:read` |
| `recording.trashed`・`recording.deleted` | `recording_id` | `recording:read` |
| `transcript.completed` | `transcript_id`、`instance_id` | `recording:read` |
| `user.created`・`user.updated`・`user.deactivated` | `user_id`、`email`（`user:read:admin` のアプリだけ）、`role`、`status` | `user:read:admin` |
| `endpoint.url_validation` | `plain_token` | —（受け口の確認） |

- 入れないもの：チャットの本文、字幕と文字起こしの文字、録画の URL、パスコード、参加の鍵、IP、電話番号（I-9）。封筒の型（Zod）にこれらの項目を持たせない。

## 7. Meeting Actor のメモリとスナップショット

会議の中の状態の正本（[ADR-0005](../../decisions/0005-meeting-state-and-signaling.md)）。スナップショット（`mtg:{m}:snap`）の形：

| 項目 | 中身 | 定めた場所 |
| --- | --- | --- |
| `instance_id`、`epoch`、`seq`、`status`、`locked` | 開催の状態 | [signaling-and-meetings.md](../signaling-and-meetings.md) の 10.1 節 |
| `settings` | `share`、`allow_rename`、`allow_self_unmute`、チャットの許可など、開催の中で変わる値 | 同上、[chat-and-reactions.md](../chat-and-reactions.md) の 3.3 節 |
| `participants[]` | `id`、`user_id`、`display_name`、`role`、`muted`、`video`、`sharing`、`hand_raised`、`joined_at`、`reconnect_secret_hash`、同意（`consents`）、`suspended` の対象か | 同上 |
| `waiting[]` | 待合室の人（表示の名前、ログインの有無、メールのドメイン、同じ回線の印） | [meeting-security.md](../meeting-security.md) の 5 節 |
| `active_speaker` | | [media-server-sfu.md](../media-server-sfu.md) の 6 節 |
| `video_mode`、`video_mode_locked` | `simulcast` / `svc` / `av1-svc` | [codecs-and-bandwidth-adaptation.md](../codecs-and-bandwidth-adaptation.md) の 5 節 |
| `audio_mode` | `per_sender` / `slots` | [ADR-0057](../../decisions/0057-audio-slots-for-large-meetings.md) |
| `media` | `generation`、`nodes[]`（`node_id`・`role`）、`standby` | [media-server-sfu.md](../media-server-sfu.md) の 9 節 |
| `effective_flags` | 開催の開始で評価した meeting のフラグ | [ADR-0056](../../decisions/0056-client-release-trains-and-meeting-scoped-flags.md) |
| `recording`、`transcribing` | 録画（`off`〜`failed`）と字幕の状態、Recorder・Transcriber の割り当て | [recording-and-transcription.md](../recording-and-transcription.md) の 4.1・5.1 節 |
| `e2ee` | `enabled`、`mls_epoch`、最新の GroupInfo（公開の情報）、外部の送り手の鍵の ID、コミットの担当者 | [e2ee.md](../e2ee.md) の 6 節 |
| `chat` | `chat_seq`、チャンネルごとの `ch_seq`（Stream の最後から戻せる） | [chat-and-reactions.md](../chat-and-reactions.md) の 3.6 節 |

- 直近の差分（1,000 件か 120 秒）はメモリだけに持ち、スナップショットに入れない。
- 回復の突き合わせの優先の順は [signaling-and-meetings.md](../signaling-and-meetings.md) の 10.2 節（ban・ロック・役割は Aurora、transport などは Media Node の一覧）。

## 8. Media Node のメモリ

| 項目 | 中身 | 定めた場所 |
| --- | --- | --- |
| 会議ごとの最大の `epoch` | それより小さい指示を `409 stale_epoch` で拒否する。会議を閉じるまで持つ | [media-server-sfu.md](../media-server-sfu.md) の 4.3 節 |
| router・transport・producer・consumer の表 | `inventory` で Actor に返す。作る呼び出しは `(meeting_id, participant_id, direction, media_generation)` で冪等 | 同 4 節 |
| 音声の枠の転送器 | 100 人を超える会議の枠の状態 | 同 5.3 節、ADR-0057 |
| Recorder・Transcriber の PlainTransport の SRTP の鍵 | Actor が渡す。保存しない | [ADR-0047](../../decisions/0047-keys-and-operator-access-to-media.md) |

- Signaling Gateway も、会議ごとに最後に見た `epoch` をメモリに持ち、小さい `epoch` の差分を捨てる。
- Node Agent が再起動したら消える。その Node の router も消えているので問題ない（付け替え）。

## 9. 鍵と秘密

| 置き場所 | 中身 |
| --- | --- |
| KMS の鍵 6 つ | `<brand>-join-signing`、`-meeting-secrets`、`-content`、`-e2ee-as`、`-e2ee-external-sender`、`-data`（[ADR-0047](../../decisions/0047-keys-and-operator-access-to-media.md)） |
| Secrets Manager | `turn/static-auth-secret`（今と次）、パスコードの HMAC の pepper（版つき）、`ip_prefix_hash`・`device_key_hash`・`caller_id_hash`・`ip_hash` の pepper（今と前）、カレンダーの OAuth のクライアント、メールの送信の資格情報、TURN の TLS の証明書（ACM から書き出したもの）、DB の認証情報 |
| AWS Private CA | Actor Host と Node Agent の相互 TLS の証明書（7 日） |
| 保存しない | Media Node の DTLS の証明書、PlainTransport の SRTP の鍵、E2EE の端末の鍵と MLS の秘密、会議ごとのチャットのデータの鍵の平文（暗号文をスナップショットと同じく Valkey に置き、Actor がメモリで使う） |

## 10. 端末とフラグ

| 置き場所 | 中身 | 定めた場所 |
| --- | --- | --- |
| IndexedDB | 端末の鍵（128 ビットの乱数。ゲストの ban に使う。サーバーは HMAC だけ） | [meeting-security.md](../meeting-security.md) の 6.1 節 |
| `localStorage` | 網の指紋ごとの前回の経路（30 日）、前回の端末（マイク・カメラ）の ID、仮想背景の設定と画像、ショートカット | [network-traversal.md](../network-traversal.md)、[clients.md](../clients.md) |
| ワーカーのメモリ | E2EE の端末の鍵、MLS の状態、SFrame の鍵 | [e2ee.md](../e2ee.md) |
| AppConfig | release・meeting・ops・experiment のフラグ、`client-config`（Web の版の割合と最低の版） | [ADR-0056](../../decisions/0056-client-release-trains-and-meeting-scoped-flags.md) |

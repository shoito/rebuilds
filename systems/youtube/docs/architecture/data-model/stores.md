# Data model: Aurora の外の置き場所

[data-model.md](../data-model.md) の一部。Aurora の表の外に置くデータ（Valkey、CloudFront KeyValueStore、S3、MSK・SNS・SQS・Kinesis、Iceberg、OpenSearch、AppConfig）の名前と形をまとめる。バイナリの形式・トークン・マニフェスト・QoE の出来事の形は [formats.md](formats.md) にある。

- **正本は Aurora か S3**。Valkey・KeyValueStore・OpenSearch・`match-engine` のメモリーは写しで、失っても正本から作り直せる（作り直しの間は閉じる側に倒す。措置は拒否を続け、照合は公開しない）。
- **鍵・キー・メッセージに利用者の中身を入れない**。入れるのは ID・ハッシュ・数・理由のコード・バージョンだけ。動画の題・説明・字幕・コメント・チャットの本文・検索の語・IP アドレス・ストリームキーを入れない（[AGENTS.md](../../../AGENTS.md)）。例外は本文そのものを運ぶ置き場（MSK `chat-in`・`chat-log`、Valkey `chat:{stream_id}` の Stream、`search-events` の正規化した語、S3 の字幕とリプレイ、OpenSearch の索引）で、どれも保持を `retention_policies` で決めている。
- 鍵の中の ID は「経路の形」（UUID の 32 文字の小文字の 16 進、ハイフンなし）で書く（[data-model.md](../data-model.md) の 3.2 節）。下の表では `{video_id}` のように書く。
- ER 図は持たない（表でないため）。表との結び付きは各行の「書く・読む」に書く。名前のうち領域の文書で決まっていなかったものは、この文書で決めた（D-24〜D-26）。

## 1. Valkey

ElastiCache Valkey（クラスタのモード）。S1 は「一般」と「チャット」の 2 つのクラスタ（[capacity.md](../capacity.md) の 4 節）。チャットの鍵は `chat:` で始まり、チャットのクラスタにだけ置く。

| 鍵 | 種類 | TTL | 中身 | 書く → 読む | 決めた場所 |
| --- | --- | --- | --- | --- | --- |
| `pv:{video_id}` | HASH | なし（正本から作り直す） | `playable()` の入力：`state`、`visibility`、`channel_id`、`publish_at`、`age_restricted`、`made_for_kids`、`mod_flags`、`blocked_regions`、`claim_block`（地域の一覧）、`claim_monetize`、`drm_required`、`deleting`、`channel_state`、`state_version` | `playable-replica` の消費者（outbox）→ `api`・`license-proxy`・`manifest-service`・`recommender`・`search` | この文書（D-16。[ADR-0009](../../decisions/0009-single-tenant-and-playable.md) の「写し」） |
| `blocked:{video_id}` | 文字列（`{kind}:{regions}`） | 7 日 | 配信の止めの印（`pv:` より先に効く） | `delivery-blocker` → `api`・`manifest-service`・`license-proxy` | [cdn-and-delivery.md](../cdn-and-delivery.md) の 16 節 |
| `rend:{video_id}` | 文字列（JSON：`active_gen`、`drm_required`、段の一覧） | なし | マニフェストの段の写し | outbox → `manifest-service`・`api` | [packaging-and-drm.md](../packaging-and-drm.md) の 11 節 |
| `mem:{user_id}:{channel_id}` | 文字列（`valid_until` の UNIX 秒） | `valid_until` まで | 会員の写し | outbox（`membership_changed`、60 秒以内）→ `playable()`・`license-proxy` | [ADR-0056](../../decisions/0056-channel-memberships-via-payment-provider.md) |
| `sess:{session_id}` | HASH（`account_id`、`at_hash`、`exp`、`step_up_at`、`client_kind`） | 15 分 | アクセストークンの写し | `identity` → `api` | [accounts-and-safety.md](../accounts-and-safety.md) の 13 節 |
| `chm:{account_id}` | 文字列（`channel_id` の一覧） | 60 秒 | 役割を持つチャンネル（`app.channel_ids` の元） | `api` | 同上 |
| `vc:p:{video_id}:{yyyymmddhh}` | 文字列（INCR） | 48 時間 | 仮の視聴の数（時間ごと） | `view-validator` → `api` | [view-counting-and-analytics.md](../view-counting-and-analytics.md) の 5.2 節 |
| `vc:pub:{video_id}` | 文字列（整数） | 1 時間 | 表示の公開の数（30 秒ごとに作り直す） | `api` → 動画のページ | 同 5.3 節 |
| `vd:{video_id}:{viewer_key}` | HASH（24 時間の窓の回数、前の `first_frame` の時刻） | 24 時間 | S04・S05 の状態 | `view-validator` | 同 4.3 節 |
| `vh:{video_id}` | 文字列 | 1 時間 | 熱い動画の印（分割の鍵を `video_id#bucket` にする） | `view-validator` → `event-collector` | 同 4.3 節 |
| `uh:{user_id}` | LIST（`video_id`） | 30 日 | 直近 200 本の視聴 | `history-writer` → `recommender` | [recommendations.md](../recommendations.md) の 11.1 節 |
| `ua:{user_id}` | HASH（`channel_id` → 関係の特徴） | 7 日 | チャンネルとの関係 | 毎日の作業 → `recommender` | 同 6.2 節 |
| `hs:{user_id}` | 文字列（`paused`・`search_paused`） | 1 日 | 履歴の設定の写し | outbox（`history_paused`）→ `history-writer`・`recommender` | この文書 |
| `rf:{user_id}` | SET（`kind:target_id`） | 7 日 | 「興味なし」の写し | `api` → `recommender` | この文書 |
| `sq:{user_id}` | LIST（正規化した語、3 つ） | 7 日 | `search_rel` の源の直近の検索の語 | `search` → `recommender` | [recommendations.md](../recommendations.md) の 15 節 |
| `cv:{video_id}` | ZSET（`video_id` → 共起の値） | 2 日 | 共起の上位 100 | 毎日 JST 7:00 の作業 | 同 5.1 節 |
| `vf:{video_id}` | HASH | 2 日 | 動画の特徴（1 日の確定から） | 毎日の作業 | 同 6.2 節 |
| `chf:{channel_id}` | HASH | 2 日 | チャンネルの特徴 | 毎日の作業 | 同 6.2 節 |
| `pop:jp`、`pop:cat:{category_code}` | ZSET | 2 日 | 人気（1 日の確定） | 毎日の作業 | 同 5 節 |
| `ct:{video_id}` | ZSET（`comment_id` → 評価順の点） | 7 日（見られなければ消える） | 評価順の候補の上位 2,000 | `api` | [comments-and-moderation.md](../comments-and-moderation.md) の 5.1 節 |
| `cc:{comment_id}` | HASH（`likes`、`replies`） | 1 日 | 数の積み上げ（1 分ごとに書き戻す） | `api` | 同 4.3 節 |
| `cs:{simhash}` | SET（`channel_id`） | 1 時間 | 同じ本文の広がり | `api` | 同 6.3 節 |
| `cset:{channel_id}` | HASH | 10 分 | コメントの設定と一覧の数の写し | `api` | この文書 |
| `subc:{channel_id}` | 文字列（INCRBY） | なし | 登録者の数の増減（1 分ごとに書き戻す） | `api` | [ADR-0053](../../decisions/0053-handles-and-subscription-tables.md) |
| `ch_last:{channel_id}` | 文字列（UNIX ミリ秒） | なし | 最後の公開の時刻 | outbox（`video_state_changed`） | [channels-subscriptions-and-notifications.md](../channels-subscriptions-and-notifications.md) の 5 節 |
| `ch_recent:{channel_id}` | ZSET（`video_id` → 公開の時刻） | なし（30 本に切る） | 直近 30 本 | 同上 | 同上 |
| `ch_notif:{channel_id}` | LIST（出来事の ID と動画） | 30 日（50 件に切る） | 大きなチャンネルのお知らせ | `notify-planner` | 同 6.6 節 |
| `ulc:{user_id}` | SET（`channel_id`） | なし | 登録している大きなチャンネル（10 万超） | outbox（`subscription_changed`） | 同 6.6 節 |
| `naff:{channel_id}` | SET（`user_id`） | 2 日 | 親しさの集合 | 毎日の作業 → `notify-worker` | [ADR-0054](../../decisions/0054-notification-fanout-pacing-and-coalescing.md) |
| `npw:{user_id}` | 文字列 | 10 分 | プッシュの窓の印 | `notify-worker` | 同 6.4 節 |
| `npq:{user_id}` | LIST（`video_id`） | 10 分 | 窓の中で貯めたプッシュ | `notify-worker` | 同 6.4 節 |
| `adcap:{viewer_key}` | HASH（前の広告の時刻、再生の数） | 1 日 | 広告の頻度の上限 | `ad-decision` | [monetization-and-payouts.md](../monetization-and-payouts.md) の 12 節 |
| `chat:{stream_id}` | STREAM | 配信の終わりから 1 時間（1,000 件に切る） | 番号つきのメッセージ（取り直し用） | `chat-sequencer` → Gateway | [ADR-0032](../../decisions/0032-chat-sequencer-and-batched-fanout.md) |
| `chat:{stream_id}:all`・`:top`・`:mod` | sharded pub/sub のチャネル | — | まとめの送信 | `chat-sequencer` → Gateway | 同上 |
| `chat:{stream_id}:cfg` | HASH | 配信の終わりまで | `chat_settings` の写し | `api` → Gateway | この文書 |
| `chat:{stream_id}:ban:{user_id}` | 文字列 | 止めの期限まで | タイムアウト・締め出しの写し | `api` → Gateway | この文書 |
| `chat:rl:{user_id}` | トークンの桶 | 1 分 | 送信の速さ（1 秒 1 件、3 件まで） | Gateway | [live-chat.md](../live-chat.md) の 6.1 節（`rl:` を `chat:rl:` にした。D-24） |
| `chat:slow:{stream_id}:{user_id}` | 文字列 | 低速モードの秒 | 低速モード | Gateway | 同上（`slow:` を `chat:slow:` に） |
| `chat:dup:{stream_id}:{user_id}:{hash}` | 文字列 | 30 秒 | 同じ文の重複 | Gateway | 同上（`dup:` を `chat:dup:` に） |

- Valkey の喪失（[view-counting-and-analytics.md](../view-counting-and-analytics.md) の 9 節ほか）：`pv:`・`rend:`・`mem:`・`blocked:` は Aurora から作り直す。作り直しの間、`playable()` は Aurora の読み出しの写しを読む（遅くなるが閉じない）。`blocked:` がない間も KeyValueStore の `b:` と `origin-cache` の拒否が配信を止める。
- `chat:` の鍵をチャットのクラスタに分けるため、チャットの速さの鍵を `chat:rl:` などに改めた（D-24。[live-chat.md](../live-chat.md) の 11 節を直した）。

## 2. CloudFront KeyValueStore `edge-kv`

1 つの保存は 5 MB、関数に 1 つ。鍵は 512 バイト、値は 1 KB まで（[README.md](../README.md) の 6 節の確認）。

| 鍵 | 値 | 寿命 | 書く | 決めた場所 |
| --- | --- | --- | --- | --- |
| `k:{kid}` | エッジのトークンの HMAC の鍵（base64url、32 バイト）と `not_after`（`{"k":"…","na":<epoch>}`） | 今と次の 2 つ。30 日で回す | 鍵の回しの作業 | [ADR-0025](../../decisions/0025-edge-token-signing-and-cache-keys.md) |
| `b:{video_id}` | `{"a":"<kind>","t":<epoch>}`（`kind` は `delivery_blocks.kind`） | 7 日（置き場の 80% で 24 時間） | `delivery-blocker` | [ADR-0027](../../decisions/0027-takedown-deny-list-within-60s.md) |
| `t:{sig16}` | `{"exp":<epoch>}` | トークンの期限まで（同時に 2,000 件まで） | トークンの悪用の検出 | [ADR-0062](../../decisions/0062-threat-mitigations-and-key-layout.md) |

- `b:` の鍵は `b:` ＋ 32 文字で 34 バイト、1 件 約 100 バイト、5 MB で約 5 万件（[cdn-and-delivery.md](../cdn-and-delivery.md) の 10.2 節）。
- エッジの関数の順：期限 → `k:` で署名 → `b:` → `t:` → 地域 → `/m/` の `caps`（[formats.md](formats.md) の 5.2 節）。

## 3. S3

すべて非公開、SSE-KMS（バケットキー）、`aws:SecureTransport` を必須。大阪の写しは大阪の鍵で暗号化し直す（[ADR-0062](../../decisions/0062-threat-mitigations-and-key-layout.md)）。保全の対象はタグ `hold=1` を付け、ライフサイクルの消去から外す。

| バケット | キー | 中身 | 鍵 | 層・保持 | 決めた場所 |
| --- | --- | --- | --- | --- | --- |
| `<media-bucket>` | `orig/{video_id}/source` | 元のファイル（タグ `published_at`、`dr`） | `kms-media` | 30 日 Glacier IR、90 日で Deep Archive。消すのは `original-deleter` だけ | [ADR-0013](../../decisions/0013-original-retention-and-deletion-paths.md)、[ADR-0065](../../decisions/0065-media-fleets-msk-and-storage-tiers.md) |
| 同上 | `orig/{video_id}/probe.json`、`orig/{video_id}/scene_cuts.bin` | 検査の結果、場面の切り替えの点 | 同上 | Standard、動画と同じ | [upload-and-ingest.md](../upload-and-ingest.md) の 7.1 節（`scene_cuts.bin` はこの文書） |
| 同上 | `p/{video_id}/{gen}/{name}.cmfv`・`.cmfa`・`.six` | レンディションのファイルと索引 `SIX1` | 同上 | Intelligent-Tiering（Deep Archive の層なし） | [ADR-0019](../../decisions/0019-cmaf-files-segment-index-and-url-layout.md) |
| 同上 | `p/{video_id}/cap/{lang}-{kind}-{rev}.vtt`、`p/{video_id}/cap/{lang}-{kind}-{rev}/{n}.vtt` | 字幕の全体と、60 秒ごとの配りの断片 | 同上 | 同上 | この文書 |
| 同上 | `p/{video_id}/thumb/{slot}-{rev}/{width}.{jpg,webp}` | サムネイル | 同上 | 同上 | この文書 |
| 同上 | `p/{video_id}/sb/{rev}/{n}.jpg`、`p/{video_id}/sb/{rev}/index.vtt` | シークの縮小の画像 | 同上 | 同上 | [packaging-and-drm.md](../packaging-and-drm.md) の 4.4 節 |
| 同上 | `p/{video_id}/chat/{n}.json.gz` | チャットのリプレイ（30 秒ごと） | 同上 | 同上、アーカイブと同じ | [live-chat.md](../live-chat.md) の 8 節 |
| 同上 | `r/{video_id}/{stage}/{cfg}/{inp}/{chunk:05}.{ext}` | 段の中間の出力（`If-None-Match: *`） | 同上 | Standard、7 日で消す | [ADR-0014](../../decisions/0014-pipeline-task-leases-and-idempotent-outputs.md) |
| 同上 | `ladder/{video_id}/trial/{codec}-{ladder_version}.json` | 試しの全点 | 同上 | Standard、動画と同じ | [transcoding-pipeline.md](../transcoding-pipeline.md) の 15 節 |
| 同上 | `l/{h2}/{stream_id}/{rendition}/{chunk}.cmfv` | DVR（10 秒＝5 セグメントのまとめ） | 同上 | Standard。アーカイブなしは窓を出て 24 時間、作り直したアーカイブは世代 2 の 24 時間の後 | [ADR-0031](../../decisions/0031-dvr-storage-and-live-to-vod.md) |
| 同上 | `l/{h2}/{stream_id}/{rendition}.six` | DVR の索引（ライブの印、60 秒ごとに書き直す。終わりに閉じる） | 同上 | 同上 | この文書 |
| 同上 | `live-src/{h2}/{stream_id}/{n:06}.ts` | ライブの元の流れ（10 秒ごと） | 同上 | 最後の 12 時間。作り直さないアーカイブは 30 日で `original-deleter` が消す | [ADR-0028](../../decisions/0028-live-ingest-keys-backup-and-source-recording.md) |
| `<quarantine-bucket>`（media-quarantine のアカウント） | `orig/{video_id}/source` | 既知の違法なメディアに一致した元のファイル | `kms-quarantine` | Standard、保全の期限まで | [ADR-0063](../../decisions/0063-operator-access-audit-retention-and-legal-hold.md) |
| `<fp-bucket>` | `fp/video/{video_id}/v{fp_version}.fpa`・`.fpv` | アップロードの指紋 | `kms-fp` | Intelligent-Tiering、動画と同じ | [copyright-matching.md](../copyright-matching.md) の 7.3 節 |
| 同上 | `fp/ref/{reference_id}/v{fp_version}.fpa`・`.fpv`、`refsrc/{reference_id}/source` | 参照の指紋と参照のファイル | 同上 | Standard、参照と同じ。大阪へ CRR | 同上（`refsrc/` はこの文書） |
| 同上 | `fp/live/{stream_id}/{window_no:06}.fpa`・`.fpv` | ライブの窓の指紋 | 同上 | アーカイブと同じ（なしは 90 日） | この文書 |
| 同上 | `index/v{fp_version}/{shard}/{generation}/…` | 参照の索引の世代（[formats.md](formats.md) の 4 節） | 同上 | 直前の 2 世代を残し 7 日で消す。大阪へ CRR | [ADR-0044](../../decisions/0044-reference-index-shards-and-generations.md) |
| `<events-bucket>` | `iceberg/{namespace}/{table}/…` | Iceberg の表（5 節） | `kms-events` | 5 節 | [ADR-0036](../../decisions/0036-watch-time-retention-and-analytics-store.md) |
| 同上 | `recs/covisit/{yyyymmdd}/`、`recs/features/{yyyymmdd}/` | 共起と特徴の写しの元 | 同上 | 14 日 | [recommendations.md](../recommendations.md) の 15 節 |
| 同上 | `analytics/channel_dim/{yyyymmdd}/` | 90 日を過ぎた `channel_stats_daily_dim` | 同上 | 13 か月 | この文書 |
| `<logs-bucket>`（log-archive） | `cdn/{distribution}/{yyyy}/{mm}/{dd}/…`、`alb/…`、`nlb/…` | CDN・ALB・NLB の標準のログ | `kms-audit` | 7 日で IP を落とした形に書き換え、13 か月 | [ADR-0068](../../decisions/0068-qoe-privacy-limits-cdn-logs-and-selfmon.md) |
| 同上 | `audit/{yyyy}/{mm}/{dd}/{hh}/{batch}.jsonl.zst` | 監査の記録の正本 | 同上 | Object Lock（コンプライアンス）3 年 | [ADR-0063](../../decisions/0063-operator-access-audit-retention-and-legal-hold.md) |
| `<records-bucket>` | `statements/{party}/{yyyymm}.pdf`・`.csv` | 月の明細 | `kms-pii` | 7 年（L7） | この文書（D-25） |
| 同上 | `ledger/{yyyymm}/part-{n}.parquet` | 25 か月を過ぎた台帳 | 同上 | Object Lock、法令の保存の期間（L7） | 同上 |
| 同上 | `applications/{application_id}/…` | 権利者の申し込みの資料 | 同上 | 却下から 3 年 | 同上 |
| 同上 | `evidence/{report_id}/…` | 通報の時の証拠の写し（動画の区間、コメントの本文） | 同上 | 90 日 | 同上 |
| 同上 | `legal/{request_id}/…` | 開示・照会への応答の書き出し | 同上 | L10 | 同上 |

- `h2` は `stream_id` の SHA-256 の先頭 2 文字（16 進）。接頭辞を散らす。
- 大阪へ写すもの：`orig/`（CRR と RTC）、熱い集まりの H.264 の `p/`（タグ `dr=hot`）、`<fp-bucket>` の参照と索引、監査（[infrastructure.md](../infrastructure.md) の 7.2 節）。
- `<records-bucket>` は明細・台帳の写し・申し込みの資料・証拠・法的な書き出しの置き場として足した（D-25。[infrastructure.md](../infrastructure.md) の 6.1 節に行を足した）。

## 4. 出来事の流れ

### 4.1 outbox の話題

`ops.outbox`（[security-audit-and-lifecycle.md](security-audit-and-lifecycle.md) の 4.1 節）の `topic` の一覧。`relay` は SNS の `domain-events` に `topic` の属性つきで送り、各 SQS が属性で絞って受ける。

| 話題 | 書く領域（同じトランザクションの変更） | 主な受け手 | `payload` の欄 |
| --- | --- | --- | --- |
| `video_upload_completed` | upload（セッションの `completed`） | `pipeline-orchestrator` | `video_id`、`upload_id`、`size_bytes`、`crc64nvme` |
| `video_state_changed` | upload・pipeline（状態の遷移） | `playable-replica`、`search-indexer`、`notify-planner`、`ch_last:` | `video_id`、`channel_id`、`from`、`to`、`visibility`、`state_version` |
| `video_metadata_updated` | upload（題・説明・タグ） | `search-indexer` | `video_id`、`search_version` |
| `renditions_changed` | packaging（世代の切り替え・段の追加） | `rend:`、CDN の cache tag の無効化 | `video_id`、`active_gen`、`state_version` |
| `captions_ready`・`captions_updated` | transcoding | `search-indexer` | `video_id`、`lang`、`kind`、`rev` |
| `live_state_changed`（`live_started` を含む） | live | `notify-planner`、Gateway、`playable-replica` | `stream_id`、`video_id`、`from`、`to` |
| `delivery_block`・`delivery_unblock` | moderation・claims・accounts（措置・ブロック・終了） | `delivery-blocker` | `video_id`、`kind`、`regions`、`source_kind`、`source_id` |
| `moderation_action_applied` | moderation | `playable-replica`、`search-indexer`、`recommender`、通知 | `action_id`、`target_kind`、`target_id`、`kind`、`state_version` |
| `guideline_violation` | moderation | `strikes`（accounts） | `channel_id`、`policy`、`action_id` |
| `copyright_strike_requested`・`copyright_strike_retracted` | claims | `strikes`（accounts） | `video_id`、`channel_id`、`case_id`、`scheduled_removal` |
| `channel_standing_changed`・`channel_terminated` | accounts | `playable-replica`、`delivery-blocker`、`can()` の写し | `channel_id`、`state`、`version` |
| `account_locked`・`stream_keys_revoked`・`role_changed` | accounts | `live-ingest`、`chm:`、通知 | `account_id`、`channel_id` |
| `channel_updated` | accounts・channels | `search-indexer` | `channel_id` |
| `reference_activated`・`reference_deactivated` | matching | `match-engine` の分片（差分の索引）、遡りの作業 | `reference_id`、`ref_seq`、`fp_version`、`live_match` |
| `match_completed` | matching | `pipeline-orchestrator`、`claims` | `video_id`、`match_run_id`、`state` |
| `claim_created`・`claim_policy_changed`・`claim_resolved` | claims | `playable-replica`、`delivery-blocker`（ブロック）、通知、`search-indexer` | `video_id`、`claim_id`、`claims_version` |
| `comment_created`・`comment_state_changed` | comments | 通知、後からの判定 | `video_id`、`comment_id`、`state` |
| `blocked_terms_changed` | comments | `api`、Gateway | `channel_id` |
| `subscription_changed` | channels | `subc:`、`ulc:`、分析 | `user_id`、`channel_id`、`level`、`op` |
| `history_deleted`・`history_paused` | recommendations | 履歴の消去の作業、`hs:` | `deletion_id`、`user_id`、`scope` |
| `suggest_blocked` | search | `suggest-builder` | `term_hash` |
| `membership_changed` | monetization | `mem:`、`playable-replica` | `membership_id`、`user_id`、`channel_id`、`state`、`valid_until` |
| `payout_state_changed`・`month_closed` | monetization | 通知、明細の作業 | `payout_id`・`yyyymm` |
| `audit_appended` | 全領域 | 監査の写し（log-archive） | `event_id`（`audit_events` の ID） |
| `legal_hold_changed` | security | 消去の作業、S3 のタグ | `hold_id`、`target_kind`、`target_id` |
| `pipeline_task_ready` | pipeline（確定と依存の解放） | SQS `pipe-*`（合図） | `task_id`、`priority` |

- 消費者は `inbox_events` で重複を除く（少なくとも 1 回の配りを、1 回の処理にする）。
- 封筒：SNS の本文は `{"v":1,"event_id":"…","topic":"…","created_at":"…","aggregate":{"kind":"video","id":"…"},"payload":{…}}`。欄は足すだけで、意味を変えるときは `v` を上げ、読む側を先に出す（[delivery.md](../delivery.md) の 7 節）。

### 4.2 MSK

Express の `express.m7g.large` × 3（ADR-0065）。メッセージは Protobuf（[formats.md](formats.md) の 7 節）。

| トピック | 鍵 | 分割の数（S1） | 保持 | 書く → 読む | 決めた場所 |
| --- | --- | --- | --- | --- | --- |
| `watch-events` | `video_id`（熱い動画は `video_id#bucket`） | 64 | 3 日（正本は Iceberg） | `event-collector` → `view-validator`、`qoe-aggregator`、`history-writer`、Iceberg の書き出し | [ADR-0034](../../decisions/0034-watch-event-envelope-and-ingest.md)（数と保持はこの文書） |
| `watch-events-rejected` | なし | 6 | 3 日 | `event-collector` → 監視 | 同上 |
| `chat-in` | `stream_id` | 32 | 1 日 | Gateway → `chat-sequencer` | [ADR-0032](../../decisions/0032-chat-sequencer-and-batched-fanout.md) |
| `chat-log` | `stream_id` | 32 | 3 日（正本は Iceberg） | `chat-sequencer` → Iceberg、`chat-replay-builder` | 同上 |
| `rec-events` | `viewer_key` | 12 | 3 日 | `recommender`・`api` → Iceberg `rec_impressions` | [recommendations.md](../recommendations.md) の 10 節 |
| `search-events` | `viewer_key` | 6 | 3 日 | `search` → `suggest-builder`、Iceberg `search_events` | [search.md](../search.md) の 8 節 |

- 分割の数を増やすと `video_id` の写像が変わる。`vd:` の作り直しの手順を先に出す（[delivery.md](../delivery.md) の 7 節）。

### 4.3 SNS・SQS

| 名前 | 種類 | 中身 | 決めた場所 |
| --- | --- | --- | --- |
| `domain-events` | SNS | outbox の全部の話題（属性 `topic`） | この文書 |
| `origin-deny` | SNS | `origin-cache` の拒否の集まりの更新（`video_id`、`op`） | [cdn-and-delivery.md](../cdn-and-delivery.md) の 16 節 |
| `pipe-urgent`・`pipe-normal`・`pipe-back` | SQS | 作業の合図（`task_id`） | [ADR-0014](../../decisions/0014-pipeline-task-leases-and-idempotent-outputs.md) |
| `notify-small`・`notify-large`・`push-send`（と DLQ） | SQS | 通知のページの作業、送信 | [ADR-0054](../../decisions/0054-notification-fanout-pacing-and-coalescing.md) |
| `search-index` | SQS | 索引の作業 | [search.md](../search.md) の 9.1 節 |
| `delivery-block` | SQS（FIFO、`video_id` でグループ） | `delivery_block`・`delivery_unblock` | この文書 |
| `playable-replica` | SQS（FIFO、`video_id` でグループ） | `pv:` の更新の元の話題 | この文書 |
| `strikes-in` | SQS | `guideline_violation`・`copyright_strike_*` | この文書 |
| `match-index` | SQS | `reference_activated`・`reference_deactivated` | この文書 |
| `ledger-in` | SQS | 事業者の webhook の受け取りの後の処理、`month_closed` | この文書 |

- 名前のなかった待ち行列（`delivery-block` から下）はこの文書で決めた（D-26）。措置の `delivery-block` と `playable-replica` は FIFO にし、同じ動画の止めと取り消しの順を守る。

### 4.4 Kinesis

| ストリーム | 中身 | 保持 | 決めた場所 |
| --- | --- | --- | --- |
| `cdn-rt-vod`・`cdn-rt-live` | CloudFront のリアルタイムのログ（`vod` 1%、`live` 0.1% の抜き取り。IP・cookie・見出しの欄を選ばず、パスのトークンは `sig16` と `kid` だけ） | 24 時間 | [ADR-0067](../../decisions/0067-sli-sources-and-computation.md)、[ADR-0068](../../decisions/0068-qoe-privacy-limits-cdn-logs-and-selfmon.md) |

## 5. Iceberg の表

`<events-bucket>` の `iceberg/` に置き、Glue のカタログで引く。列は足すだけ、分割は分割の進化で変える（[delivery.md](../delivery.md) の 7 節）。

| 表 | 分割 | 主な列 | 書く | 保持 |
| --- | --- | --- | --- | --- |
| `watch.watch_events` | `event_date`（JST）、`hour` | 封筒の欄（[formats.md](formats.md) の 7 節）、`viewer_key`、`ip_prefix`、`asn`、`pref`、`ua_class`、`device_model`、`device_class`、`player_version`、`cdn`、`recv_at`、`late`、`canary` | MSK から 5 分ごと | 13 か月（L5） |
| `watch.watch_sessions` | `event_date` | `sid`、`video_id`、`channel_id`、`viewer_key`、`valid`、`engaged`、`watched_ms`、`intervals`（和集合）、`reasons`（規則の ID の配列）、`ruleset_version`、`src`、`device_class`、`pref`、`has_captions`、`subscribed`、`canary` | `view-verifier`（1 日の確定） | 13 か月（L5） |
| `watch.qoe_minute` | `event_date`、`hour` | `minute`、`device_class`、`player_version`、`cdn`、`asn_bucket`（上位 30 と `other`）、`pref`、`mode`、`codec`、`intents`、`first_frames`、`start_ms_hist`（決まった桶の数の配列）、`failures`、`play_ms`、`stall_ms`、`stalls`、`vmaf_weighted` | `qoe-aggregator` | 13 か月 |
| `ops.cdn_rt_sample` | `event_date` | `ts`、`distribution`、`edge_location`、`status`、`bytes`、`time_taken_ms`、`cache_status`、`uri_stem_redacted`、`sig16`、`kid` | Kinesis から | 30 日 |
| `chat.chat_log` | `event_date`、`stream_id` のバケット 32 | `stream_id`、`video_id`、`seq`、`kind`（`message`・`delete`・`timeout`・`ban`・`hold`・`release`）、`user_id`、`author_channel_id`、`text`、`video_offset_ms`、`held`、`client_msg_id` | `chat-log` から | 90 日（アーカイブのある配信はリプレイの間。L10・L6） |
| `discovery.rec_impressions` | `event_date` | `request_id`、`viewer_key`、`video_id`、`position`、`source`、`reason_code`、`model_version`、`mode`、`impressed` | `rec-events` から | 13 か月（L5・L8） |
| `discovery.search_events` | `event_date` | `request_id`、`viewer_key`、`query_norm`、`result_count`、`ts` | `search-events` から | 90 日（L5） |

- `viewer_key` は、ログインなら利用者の ID のハッシュ、なければ端末の識別子を日の塩でハッシュし直した値（[view-counting-and-analytics.md](../view-counting-and-analytics.md) の 4.2 節）。生の IP は Iceberg に書かない。
- `rec_impressions`・`search_events` の表の名前はこの文書で決めた（D-26）。

## 6. 秘密と鍵の置き場所

| 鍵 | 置き場所 | 名前 | 回し方 |
| --- | --- | --- | --- |
| 再生のトークン（Ed25519） | Secrets Manager（`kms-secrets` で包む） | `playback-token/{kid}` | 2 つを並べ 30 日 |
| エッジのトークン（HMAC） | KeyValueStore `k:{kid}`（元は Secrets Manager `edge-token/{kid}`） | 同 | 2 つを並べ 30 日 |
| 外への通知の署名（HMAC） | Secrets Manager | `outbound-signing/{kid}` | 2 つ |
| HMAC の索引の鍵（メール・電話・ブロックの語） | Secrets Manager（`kms-pii`） | `hmac-email-v1`・`hmac-phone-v1`・`hmac-term-v1` | 回さない（回すときは列を作り直す） |
| DRM の内容の鍵 | Aurora `drm_keys`（`drm-content`） | — | 回さない（漏れたら新しい KID） |
| 列の暗号のデータの鍵 | KMS（`kms-pii`・`kms-secrets`）から作り、行の暗号文の頭に鍵の ID | — | KMS の自動の回し |

## 7. OpenSearch

別名（`videos`・`captions`・`channels`・`suggest`）で引き、`*-v{n}` を作り直して切り替える（[ADR-0041](../../decisions/0041-search-index-layout-and-caption-chunks.md)）。正規化は `normalizeForSearch`（`norm_version` を文書に持つ）。

**`videos-v{n}`**（公開の範囲が「公開」の動画だけ。文書の ID は `video_id`、外部のバージョンは `search_version`）：

```json
{
  "settings": {
    "analysis": {
      "tokenizer": { "gram12": { "type": "ngram", "min_gram": 1, "max_gram": 2 } },
      "analyzer": {
        "gram": { "tokenizer": "gram12", "filter": ["lowercase"] },
        "ja": { "tokenizer": "kuromoji_tokenizer",
                "filter": ["kuromoji_baseform", "kuromoji_part_of_speech", "ja_stop", "lowercase"] }
      }
    },
    "index": { "max_ngram_diff": 1 }
  },
  "mappings": {
    "dynamic": "strict",
    "properties": {
      "video_id":       { "type": "keyword" },
      "channel_id":     { "type": "keyword" },
      "title":          { "type": "text", "analyzer": "ja",
                          "fields": { "gram": { "type": "text", "analyzer": "gram" },
                                      "word": { "type": "text", "analyzer": "standard" } } },
      "description":    { "type": "text", "analyzer": "ja",
                          "fields": { "gram": { "type": "text", "analyzer": "gram" },
                                      "word": { "type": "text", "analyzer": "standard" } } },
      "chapters":       { "type": "text", "analyzer": "ja",
                          "fields": { "gram": { "type": "text", "analyzer": "gram" } } },
      "tags":           { "type": "text", "analyzer": "ja", "fields": { "kw": { "type": "keyword" } } },
      "channel_name":   { "type": "text", "analyzer": "ja",
                          "fields": { "gram": { "type": "text", "analyzer": "gram" } } },
      "state":          { "type": "keyword" },
      "visibility":     { "type": "keyword" },
      "age_restricted": { "type": "boolean" },
      "made_for_kids":  { "type": "boolean" },
      "mod_flags":      { "type": "keyword" },
      "blocked_regions":{ "type": "keyword" },
      "members_only":   { "type": "boolean" },
      "published_at":   { "type": "date" },
      "duration_s":     { "type": "integer" },
      "engaged_30d":    { "type": "long" },
      "has_captions":   { "type": "boolean" },
      "is_live":        { "type": "boolean" },
      "category":       { "type": "keyword" },
      "search_version": { "type": "long" },
      "norm_version":   { "type": "short" }
    }
  }
}
```

- `blocked_regions` は `mod_blocked_regions` と照合のブロックの地域の和。説明は先頭 5,000 文字だけ。

**`captions-v{n}`**（1 区切り 1 文書。文書の ID は `{video_id}:{lang}:{kind}:{start_ms}`、ルーティングは `video_id`）：`video_id`・`lang`・`kind`（keyword）、`start_ms`・`end_ms`（integer）、`text`（`ja`、`fields.gram` は 2 文字の N-gram）、`weight`（`manual` 0.5・`auto` 0.3）、絞り込みの印（`videos` と同じ）、`search_version`。

**`channels-v{n}`**：`channel_id`、`handle`（keyword と `edge_ngram`）、`name`（`ja` と `gram`）、`description`（`ja`）、`subscriber_count_rounded`（long）、`mod_restrictions`（keyword）。

**`suggest-v{n}`**：`term_norm`（keyword）、`term`（`edge_ngram` 1〜20）、`reading`（カタカナの読みの `edge_ngram`）、`viewers_7d`（integer）、`updated_at`（date）。20 人以上の語だけ（[ADR-0042](../../decisions/0042-search-query-builder-ranking-and-suggest.md)）。

## 8. AppConfig

| 名前 | 中身 | 規則 |
| --- | --- | --- |
| `release.*` | 未完成の振る舞いのフラグ（kebab-case。例 `release.live-dvr`） | 100% の後 30 日で消す |
| `ops.*` | 運用の止め（snake_case）：`ops.upload_enabled`（リージョンごと）、`ops.live_ingest_enabled`、`ops.recs.fallback`、`ops.recs.mixer.*` | — |
| `experiment.*` | A/B の重み：`experiment.recs.weights.*` | — |
| `legal.copyright.*` | `review_days`、`counter.enabled`（既定 `false`）、`counter.wait_business_days`、通知の文のバージョンの ID | 法務の承認で変える（ADR-0049） |
| `player_cfg` | Web のプレイヤーのバージョンの割合（1%・10%・50%・100%） | [ADR-0070](../../decisions/0070-ci-cd-golden-media-gates-and-player-rollout.md) |

- `ladder_version`・`enc_build`・`fp_version`・`ruleset_version`・`mf`・`SIX1` のバージョンは AppConfig に置かない（コードのバージョン。[data-model.md](../data-model.md) の 3.7 節）。

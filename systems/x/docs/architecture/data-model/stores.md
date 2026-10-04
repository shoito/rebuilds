# Data model: DB の外（Valkey・Kinesis・Firehose・SQS・S3・OpenSearch・プッシュ・API の形）

[data-model.md](../data-model.md) の一部。Aurora の表の外に置くデータの形をまとめる。どれも正本は Aurora で、失っても Aurora と出来事から作り直せる（[ADR-0003](../../decisions/0003-timeline-fanout-hybrid.md)、[ADR-0005](../../decisions/0005-event-log-and-outbox.md)）。例外は 2 つ：閲覧の数（`views` の流れとデータレイクが参照の値。Aurora に正本がない。[ADR-0024](../../decisions/0024-view-counts-ingest-and-approximation.md)）と、端末の送信の待ち行列（未送信の投稿。端末だけの正本。[clients.md](../clients.md) の 4.3 節）。

- 鍵・パス・チャンネルの名前は本家の名前を入れない（リポジトリ共通の [ADR-0006](../../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。トークン・セッション・コードの平文を鍵にも値にも入れない（SHA-256 だけ）。
- 「決めた場所」が「この文書」のものは、領域の文書で名前や形を決めていなかったもの。

## 1. Valkey（ElastiCache）

4 つのクラスタ（[ADR-0055](../../decisions/0055-kinesis-consumers-and-valkey-clusters.md)、[infrastructure.md](../infrastructure.md) の 5 節）。`vk-timeline`・`vk-cache` は `volatile-lru`（必ず TTL を付ける）、`vk-counters`・`vk-edge` は `noeviction`。同じ主体の鍵は `{...}` のハッシュタグで同じスロットに置き、1 回の Function で読み書きする。

### 1.1 `vk-timeline`

| 鍵 | 型 | TTL | 中身 | 書く・読む | 決めた場所 |
| --- | --- | --- | --- | --- | --- |
| `tl:{viewer_id}` | 文字列 | 最後の読み出しから 30 日 | 頭 16 バイト ＋ 項目 32 バイト × 最大 800（ID の降順） | `fanout-worker`・`timeline` | [ADR-0014](../../decisions/0014-home-timeline-replica-format.md) |
| `ar:{author_id}` | 文字列 | 最後の投稿から 7 日 | 同じ項目の形。直近 7 日・最大 200 件（返信・リポストを含む） | `author-recent`・`timeline` | [ADR-0015](../../decisions/0015-fanout-pipeline-and-burst-control.md) |
| `pl:{viewer_id}` | Set | 10 分 | フォロー先のうちフォロワー 1,000 人以上の作者 | `timeline` | [timeline-fanout.md](../timeline-fanout.md) の 4 節 |
| `fanout:pull_any` | Sorted Set | なし | 作者の ID → いつまで（ミリ秒。今プルの作者は `+inf`） | `fanout-router` → `timeline`（手元に 1 秒ごとに読み直す） | 同上 |
| `fanout:pull_any:v` | 文字列 | なし | `fanout:pull_any` のバージョン（変えるたびに `INCR`） | 同上 | この文書 |
| `tlb:{viewer_id}` | 文字列 | 5 秒 | 作り直しの single flight（`SET NX`） | `timeline` | [ADR-0016](../../decisions/0016-timeline-rebuild-single-flight.md) |
| `cv:{post_id}` | Sorted Set | 10 分（30 秒ごとに作り直す） | 直接の返信が 1,000 件を超えた会話の上位 200 件の返信の ID → 点 | `timeline` | [ADR-0017](../../decisions/0017-profile-and-conversation-reads.md)（TTL はこの文書） |

**項目の形**（32 バイト、4 つの 64 ビットの符号なし整数、ビッグエンディアン。[ADR-0014](../../decisions/0014-home-timeline-replica-format.md)）：

| バイト | 欄 | 中身 |
| --- | --- | --- |
| 0〜7 | `post_id` | 投稿（リポストならリポストの行）の `tid` |
| 8〜15 | `author_id` | 投稿した人（リポストした人） |
| 16〜23 | `ref_id` | リポストなら元の投稿の ID、返信なら返信先の利用者の ID、それ以外は 0 |
| 24〜31 | `flags` | ビット 0 `REPOST`、1 `REPLY`、2 `QUOTE`、3 `HAS_MEDIA`、4 `SELF_THREAD`、5〜63 予備 |

**頭**（16 バイト）：形のバージョン（1 バイト、今は `1`）、状態（1 バイト：`0 ready`・`1 building`・`2 partial`）、項目の数（2 バイト）、作った時刻（6 バイト、ミリ秒）、予備（6 バイト）。

Functions：`tl_insert`・`tl_begin`・`tl_merge`・`tl_remove`・`tl_remove_author`・`tl_read`（[timeline-fanout.md](../timeline-fanout.md) の 4.1 節）。

### 1.2 `vk-cache`

| 鍵 | 型 | TTL | 中身 | 書く・読む | 決めた場所 |
| --- | --- | --- | --- | --- | --- |
| `ps:{post_id}` | ハッシュ | 45 秒 | `PostState`：`v`（`state_version`）、`a`（作者）、`k`（`kind`）、`s`（`state`）、`m`（`mod_flags`）、`g`（`mod_geo`）、`sn`（センシティブ）、`rp`（`reply_policy`）、`ro`（`repost_of_id`）、`qo`（`quoted_post_id`） | `ps_put(key, version, value, ttl)` だけ。全部の読み出しの経路 | [ADR-0009](../../decisions/0009-post-state-tombstones-and-state-cache.md) |
| `as:{user_id}` | ハッシュ | 45 秒 | 作者の状態：`v`（`users.state_version`）、`s`（`state`）、`p`（`protected`）、`m`（`account_mod`）、`r`（危険の点の帯） | `as_put`。同上 | 同上 |
| `pb:{post_id}` | 文字列（JSON） | 1 時間 | 表示の本体（本文、抜き出し、メディアの参照、作成の時刻）。状態の判定に使わない | `post`・読み出しの経路 | [posts-and-ids.md](../posts-and-ids.md) の 6 節 |
| `vb:{viewer_id}` | Set | 1 時間 | ブロックした人とされた人の和 | `vs_apply`・`vs_load` | [ADR-0012](../../decisions/0012-viewer-sets-cache.md) |
| `vm:{viewer_id}` | Sorted Set | 1 時間 | ミュートの相手 → 期限（ミリ秒。なしは `+inf`） | 同上 | 同上（型はこの文書） |
| `vp:{viewer_id}` | Set | 1 時間 | `active` でフォローしている鍵アカウント | 同上 | 同上 |
| `vw:{viewer_id}` | 文字列 | 1 時間 | 組み立てたミュートの語の照合器（直列化。範囲ごと） | 同上 | 同上 |
| `vv:{viewer_id}` | 文字列 | 1 時間 | 上の 4 つのバージョン（`users.graph_version`） | 同上 | 同上 |
| `vl:{viewer_id}` | 文字列 | 5 秒 | 読み込みの single flight（`SET NX`） | 同上 | 同上 |
| `pf:{post_id}` | ハッシュ | 48 時間 | 投稿の特徴（数、率、速さ、メディア、言語） | ランキングの特徴の集計 | [ranking-and-recommendation.md](../ranking-and-recommendation.md) の 7.1 節 |
| `af:{author_id}` | ハッシュ | 7 日 | 作者の特徴（フォロワーの対数、経過日数、平均の率、スパムの点） | 同上 | 同上 |
| `va:{viewer_id}` | Sorted Set | 30 日 | 関係の強さ（上位 500） | 同上 | 同 7.3 節 |
| `vf:{viewer_id}` | ハッシュ | 30 日 | 閲覧者の特徴と関心の話題 | 同上 | 同 7.1・7.4 節 |
| `ae:{user_id}` | List | 24 時間 | 最近のいいね・リポスト（100 件） | 同上 | 同 5 節 |
| `th:{viewer_id}` | List | 26 時間 | 2 歩先の作者（300） | 同上 | 同上 |
| `tp:{topic_id}`・`pop:jp` | Sorted Set | 26 時間 | 話題と全体の人気の投稿 | 同上 | 同上（TTL はこの文書） |
| `seen:{viewer_id}` | Bloom フィルター | 48 時間 | 既読の印 | `ranking` | 同 6 節。ElastiCache の Valkey で Bloom の型を使えるかは**未検証**（E1）。使えなければ同じ働きのビット列を文字列で持つ |
| `rk:{viewer_id}:{request_id}` | 文字列（JSON） | 30 分 | 並べた結果（最大 200 件の `post_id`・源・理由） | `ranking` | 同 4.2 節 |
| `rr:{request_id}` | 文字列（JSON） | 1 時間 | 理由の記録の写し（「なぜ表示されるか」） | `ranking` | [observability.md](../observability.md) の 8 節 |
| `gs:{user_id}:{signal}:{minute}` | 数 | 25 時間 | 大量のフォロー・解除の信号の 1 分の桶 | `graph` の流れの消費者 | [follow-graph.md](../follow-graph.md) の 8 節 |
| `ts:rl:{rule_id}:{user_id}` | Sorted Set | 窓の長さ | 行動の規則の滑る窓 | `ts-stream` | [trust-and-safety.md](../trust-and-safety.md) の 8.2 節 |
| `tc:{region}:{bucket}` | Sorted Set | 2 時間 | 語 → 重み付きの一意の投稿者の数 | `trends` | [search-and-trends.md](../search-and-trends.md) の 9.3 節 |
| `td:{bucket}:{author_id}:{term}` | 文字列 | 10 分 | 重複の印 | `trends` | 同上 |
| `tb:{region}` | ハッシュ | なし（毎時 Aurora へ写す） | 語 → 指数移動平均と更新の時刻 | `trends` | 同 9.4 節 |
| `trends:{region}` | 文字列（JSON） | 15 分 | 表示用の最新の結果 | `trends` → `search-api` | 同 9.6 節 |

- `ps:`・`as:` はバージョンの新しいものだけを書く（Function が今の `v` と比べる）。消さずに `deleted` の状態を書く。
- `vb:`・`vm:`・`vp:`・`vw:`・`vv:` は `{viewer_id}` のハッシュタグで同じスロット。1 回の Function で読む。

### 1.3 `vk-counters`

| 鍵 | 型 | TTL | 中身 | 書く・読む | 決めた場所 |
| --- | --- | --- | --- | --- | --- |
| `pc:{post_id}` | ハッシュ | 最後の更新から 30 日 | `like`・`repost`・`reply`・`quote`・`bookmark`・`view`、`l0`〜`l7`（`sub` ごとの最後の連番）、`s0`〜`s7`（シャードの ID）、`t`（最後の更新、ミリ秒） | `cnt_apply`・`cnt_set`・`HINCRBY`（閲覧だけ） | [ADR-0023](../../decisions/0023-counter-aggregation-and-reconciliation.md)（TTL はこの文書） |
| `uc:{user_id}` | ハッシュ | 同上 | `followers`・`following`・`posts`、`l0`〜`l7`・`s0`〜`s7`・`t` | 同上 | 同上 |
| `pcd:{aggregator_id}` | Set | なし | 書き戻しの対象（変わった投稿・利用者の ID。`p:` か `u:` の前置き） | `counter-aggregator` | [engagement-and-counters.md](../engagement-and-counters.md) の 4.3 節 |

- `vk-counters` は数と連番だけを持つ。シャードの読み終わりの位置は Aurora の `stream_checkpoints`（[README.md](../README.md) の 6 節の統合の決定）。
- `pc:` がない投稿の読み出しは `post_counters` から入れる（連番を含む）。

### 1.4 `vk-edge`

| 鍵・チャンネル | 型 | TTL | 中身 | 書く・読む | 決めた場所 |
| --- | --- | --- | --- | --- | --- |
| `sess:{sha256(token)}` | 文字列（JSON） | 10 分 | `{user_id, session_id, state, age_band, flags, rate_multiplier}` | `auth` → 入口のサービス | [accounts-and-auth.md](../accounts-and-auth.md) の 6.2 節 |
| `sess:revoked` | sharded pub/sub | — | 取り消した `session_id` | `auth` → `gateway`・入口 | 同 6.3 節 |
| `tok:{sha256(token)}` | 文字列（JSON） | 5 分 | `{user_id?, app_id, scopes, kind, expires_at}` | `public-api` | [api-and-rate-limits.md](../api-and-rate-limits.md) の 4.2 節 |
| `oac:{sha256(code)}` | 文字列（JSON） | 60 秒 | 認可コード → `{app_id, user_id, scopes, redirect_uri, code_challenge}`。`GETDEL` で 1 回だけ | `app-api`（認可の画面）→ `public-api` | この文書 |
| `rl:{u:<id>}:<action>:<window>` | ハッシュ | 満杯に戻るまで | トークンバケット `(tokens, updated_at_ms)`。利用者の行動 | `rl_take` | [ADR-0047](../../decisions/0047-rate-limit-token-buckets.md)（鍵の形はこの文書） |
| `rl:{u:<id>}:app:<app_id>:<group>`・`rl:{a:<app_id>}:<group>`・`rl:ip:<prefix>:<group>`・`rl:global:<group>` | ハッシュ | 同上 | 利用者×アプリ、アプリ、IP、全体の桶 | 同上 | 同上 |
| `usage:{app_id}:{yyyymm}:{unit}` | 数 | 62 日 | 月の計量 | `public-api` | [ADR-0048](../../decisions/0048-usage-plans-and-metering.md) |
| `vbatch:{batch_id}` | 文字列 | 10 分 | 閲覧の束の重複の印（`SET NX`） | `ingest` | [ADR-0024](../../decisions/0024-view-counts-ingest-and-approximation.md) |
| `nu:{owner_id}` | 数 | 30 日 | 未読の数の写し | `notification-builder` | [ADR-0031](../../decisions/0031-read-state-and-visibility-rechecks.md) |
| `nc:{owner_id}` | pub/sub | — | 未読の数の変化 | `notification-builder` → `gateway` | この文書 |
| `nh:{owner_id}` | 文字列 | 30 分（超え続ける間は延ばす） | 殺到の状態の印 | `notification-builder` | [ADR-0029](../../decisions/0029-notification-rows-and-grouping.md) |
| `nha:{owner_id}:{notification_id}` | HyperLogLog | 48 時間 | 殺到の状態の行為者の数 | 同上 | 同上 |
| `nhr:{owner_id}:{notification_id}` | List | 48 時間 | 最近の行為者 50 人 | 同上 | 同上 |
| `npc:{owner_id}` | Sorted Set | 1 時間 | 送ったプッシュの時刻（1 時間 30 件の上限） | `push-sender` | この文書 |
| `dm:{user_id}` | pub/sub | — | `{conversation_id, seq}`（本文なし） | `dm` → `gateway` | [ADR-0035](../../decisions/0035-dm-conversation-model-and-storage.md) |
| `dmrq:{sender_id}` | ハッシュ | 7 日 | 申請の反応の数（`sent`・`declined`・`reported`・`blocked`） | `ts-stream` → `dm` | [direct-messages.md](../direct-messages.md) の 9 節 |
| `relay:lease:{n}` | 文字列 | 10 秒（更新） | Relay の区画（0〜63）の担当のタスク | `relay` | [infrastructure.md](../infrastructure.md) の 3.1 節（鍵の形はこの文書） |

## 2. Kinesis Data Streams

8 つの流れ、保持 7 日、オンデマンド（[ADR-0005](../../decisions/0005-event-log-and-outbox.md)、[infrastructure.md](../infrastructure.md) の 6 節）。`views` 以外は outbox から Relay が書く。

### 2.1 流れと鍵

| 流れ | 鍵（`partition_key`） | 出来事 | 書く | Firehose で湖へ |
| --- | --- | --- | --- | --- |
| `posts` | 作者の ID | `post.created`・`post.deleted`・`post.state_changed` | `post`・`engagement`（リポスト）・`ts` | 写す |
| `graph` | フォローする側の ID（`src_id`） | `follow.created`・`follow.requested`・`follow.approved`・`follow.deleted`・`block.created`・`block.deleted`・`mute.created`・`mute.deleted`・`author.fanout_mode_changed` | `graph`・数の消費者 | 写す（ミュートは本人だけの出来事として仮名にする） |
| `engagement` | `"{post_id}:{sub}"`、`sub = user_id mod 8` | `like.created`・`like.deleted`・`repost.created`・`repost.deleted`・`reply.added`・`reply.removed`・`quote.added`・`quote.removed`・`bookmark.created`・`bookmark.deleted` | `engagement`・`post` | 写す（`bookmark.*` は数だけ） |
| `moderation` | 対象の ID | `moderation.action_applied`・`moderation.action_reversed`・`moderation.action_expired`・`moderation.action_superseded`・`moderation.appeal_decided` | `ts` | 写す（`ts_*_daily` の元） |
| `accounts` | 利用者の ID | `accounts.registered`・`accounts.protected_changed`・`accounts.state_changed`・`accounts.profile_changed`・`accounts.age_band_changed`・`accounts.risk_changed` | `accounts`・`ts` | 写す |
| `views` | 閲覧者のセッションのハッシュ | 閲覧の束（2.3 節） | `ingest`（outbox を通らない） | 写す |
| `dm` | 会話の ID | `dm.message_created`・`dm.request_created`・`dm.request_accepted` | `dm` | **写さない** |
| `audit` | 対象の ID | `audit.recorded` | 全部の書き込みのサービス | `audit-sink` が log-archive へ |

- 投稿の措置は、`moderation.action_applied`（`moderation`）と `post.state_changed`（`posts`、状態の写しの更新役と検索の索引のため）を同じトランザクションで書く。
- 鍵の切り替え（`accounts.protected_changed`）は Accounts が `accounts` の流れに書く。[follow-graph.md](../follow-graph.md) の 11 節にあった `graph` の流れの `account.protected_changed` は、これに揃えた。

### 2.2 出来事の形

**レコード**：Relay は同じ `partition_key` の出来事を 1 つのレコードに最大 50 件束ねる（[engagement-and-counters.md](../engagement-and-counters.md) の 4.6 節）。

```json
{ "rv": 1, "events": [ <出来事>, … ] }
```

**出来事**（共通の頭。[delivery.md](../delivery.md) の 7.2 節）：

```json
{ "type": "post.created", "version": 1,
  "event_id": "<UUIDv7>", "committed_at": "2026-10-04T01:02:03.456Z",
  "traceparent": "00-…", "partition_key": "1844…",
  "payload": { … } }
```

- 64 ビットの ID は全部 10 進の文字列。`payload` の型は `contracts/events` の Zod（`type` と `version` ごと）。
- outbox の列との対応：`event_id`・`type`・`version`・`partition_key`・`payload`・`traceparent` はそのまま、`committed_at` は `outbox.created_at`。

主な `payload`（`version` 1）：

| 出来事 | `payload` |
| --- | --- |
| `post.created` | `id`、`author_id`、`kind`、`in_reply_to_post_id`、`in_reply_to_user_id`、`conversation_id`、`quoted_post_id`、`repost_of_id`、`mention_user_ids[]`、`hashtags[]`、`lang`、`has_media`、`region_code`、`state_version`。**本文を含まない**（[posts-and-ids.md](../posts-and-ids.md) の 5.1 節） |
| `post.deleted` | `id`、`author_id`、`kind`、`in_reply_to_post_id`、`quoted_post_id`、`repost_of_id`、`state_version` |
| `post.state_changed` | `id`、`author_id`、`state`、`mod_flags`、`mod_geo[]`、`state_version`、`action_id` |
| `follow.*`・`block.*` | `src_id`、`dst_id`、`state`（`follow.*`）、`reason`（`follow.deleted`：`unfollow`・`reject`・`cancel`・`remove_follower`・`block`・`account_deleted`）、`src_graph_version`・`dst_graph_version` |
| `mute.*` | `owner_id`、`target_id`、`expires_at` |
| `author.fanout_mode_changed` | `author_id`、`from`、`to`、`reason`、`until` |
| `like.*`・`repost.*` | `post_id`、`user_id`、`sub`、`post_author_id`（通知の受け手）、`repost_id`（`repost.*`） |
| `reply.*`・`quote.*` | `post_id`（返信先・引用先）、`sub`、`by_post_id`、`by_user_id` |
| `bookmark.*` | `post_id`、`sub` だけ |
| `moderation.*` | `action_id`、`target_kind`、`target_id`、`kind`、`policy_code`、`state`、`expires_at`、`params` のうち地域だけ |
| `accounts.*` | `user_id`、変わった列（`state`・`protected`・`age_band`・`risk_band`）、`state_version` |
| `dm.*` | `conversation_id`、`message_id`、`seq`、`sender_id`、`recipient_ids[]`、`kind`。本文・題名を含まない |
| `audit.recorded` | `audit_events` の行と同じ列 |

### 2.3 閲覧の束（`views`）

Ingest が 1 束を 1 レコードで書く（outbox を通らないので 2.2 節の頭を持たない）。

```json
{ "bv": 1, "batch_id": "<UUIDv7>", "session_hash": "<base64url>", "viewer_id": "1844…",
  "received_at": "2026-10-04T01:02:03Z", "client": "ios",
  "items": [ { "post_id": "1844…", "surface": "home", "shown_at": "2026-10-04T01:02:01.123Z" } ] }
```

- 1 束 50 件まで、平均 25 件・2 KB（[capacity.md](../capacity.md) の 5.3 節）。

## 3. Firehose（データレイクへの直接の記録）

確定した変更でない、失ってよい記録（[ADR-0005](../../decisions/0005-event-log-and-outbox.md) の注記）。行き先は S3 の Iceberg の表（4 節）。利用者の ID は `lake-pseudonym` の鍵の HMAC の仮名で入れる（[security.md](../security.md) の 13 節）。

| 配信 | 書く | 1 レコードの中身 | 決めた場所 |
| --- | --- | --- | --- |
| `ranking-served` | `ranking` | `request_id`、`viewer`（仮名）、`post_id`、`position`、`source`、`reason_code`、`light_score`、`heavy_score`、`model_version`、`weights_version`、`ranking_mode`、`experiment_arms`、`features`（S2） | [ranking-and-recommendation.md](../ranking-and-recommendation.md) の 12.1 節 |
| `api-usage` | `public-api` | `app_id`、`user`（仮名、なければ NULL）、`endpoint`、`units`、`status`、`ts` | [api-and-rate-limits.md](../api-and-rate-limits.md) の 6.1 節 |
| `visibility-audit` | 漏れの経路の各サービス（0.1%） | `path`、`viewer`（仮名）、`post_ids[]`、`responded_at` | [observability.md](../observability.md) の 7 節 |
| `rum` | `ingest` | 画面、端末の種類、指標（描画、落ちたフレーム）、アプリのバージョン。利用者の ID を含めない | [observability.md](../observability.md) の 3 節 |
| `lake-<stream>` | Kinesis の流れ（`posts`・`graph`・`engagement`・`moderation`・`accounts`・`views`）を読む Firehose | 出来事そのもの（利用者の ID は変換の Lambda で仮名にする） | この文書（変換の仕組みは E1） |

## 4. S3

バケットの名前は `<brand>-<env>-<用途>`。全部が SSE-KMS（鍵は [data-model.md](../data-model.md) の 3.9 節）、公開のアクセスを止める。

| バケット | パス | 中身 | 鍵 | 保持 | 決めた場所 |
| --- | --- | --- | --- | --- | --- |
| `media-uploads` | `u/{media_id}/orig` | クライアントが上げた元（バージョンの管理 30 日） | `media` | 処理の後は `public` か `private` へ。元は保持（[media.md](../media.md) の 10 節） | [media.md](../media.md) の 4・8 節（パスはこの文書） |
| `media-public` | `m/{media_key}/{variant}.{ext}`、`m/{media_key}/hls/…` | 公開のバージョン | `media` | メディアと同じ | [media.md](../media.md) の 8.1 節 |
| `media-private` | `p/{media_key}/{variant}.{ext}` | 鍵アカウントと DM のバージョン | `media` | 同上 | 同上 |
| `media-quarantine` | `q/{media_id}/{元のキー}` | 隔離（措置・照合の一致）。T&S と法務のロールだけ | `ts-evidence` | 法務の L7・L8 | [media.md](../media.md) の 8.4 節 |
| `lake` | `iceberg/{table}/…` | データレイクの表（`events_posts`・`events_graph`・`events_engagement`・`events_moderation`・`events_accounts`・`views_raw`・`ranking_served`・`ranking_training_sets`・`ranking_eval_reports`・`api_usage`・`visibility_audit`・`rum`・`ts_actions_daily`・`ts_reports_daily`・`ts_legal_daily`） | `lake` | 法務の L4・L8 | 各領域 |
| `exports` | `x/{owner_id}/{request_id}.zip` | 本人のデータの書き出し | `pii` | 7 日 | この文書 |
| `disclosures` | `d/{case_id}/{export_id}.enc` | 開示の取り出し（暗号化した束） | `ts-evidence` | 法務の L2 | この文書 |
| log-archive の `audit` | `audit/yyyy=YYYY/mm=MM/dd=DD/` | 監査の写し（Object Lock のコンプライアンス） | `audit` | 法務の L8（決まるまで 1 年） | [security.md](../security.md) の 6.1 節 |
| log-archive の `edge-logs` | `edge-logs/{cloudfront\|waf\|alb}/…` | IP を含むエッジのログ | `audit` | 法務の L2・L8（仮に 90 日） | [security.md](../security.md) の 7.1 節 |
| `ota` | `bundles/{runtime_version}/{update_id}/…` | アプリの JS の束（署名つき） | `media` | 12 週 | [delivery.md](../delivery.md) |

- CloudFront KeyValueStore `media-deny`：鍵 `m:{media_key}`、値 `{"kind":"removed"|"legal","regions":["JP",…]}`（`regions` が空なら全部）。5 MB の上限を監視する（[media.md](../media.md) の 8.4 節）。

## 5. SQS

| 待ち行列 | 仕事の形 | 書く → 読む | DLQ |
| --- | --- | --- | --- |
| `fanout-small`・`fanout-large` | `{post_id, item: <32 バイトの base64>, after_src_id}`。冪等の鍵は `(post_id, after_src_id)` | `fanout-router`・`fanout-worker` → `fanout-worker` | あり（5 回） |
| `push-send` | `{owner_id, kind: notification\|dm\|dm_request, notification_id?, conversation_id?, collapse_key}` | `notification-builder` → `push-sender` | あり |
| `notification-retry` | 元の出来事（遅延 5 秒、3 回） | `notification-builder` | なし（捨てる） |
| `email-digest` | `{owner_id, day}` | `scheduler` → `mailer` | あり |
| `media-jobs` | `{media_id, step: scan\|image\|video\|takedown\|rekey}` | `media` → `media-worker` | あり |
| `graph-cache-repair` | `{viewer_id, version}` | `graph` → `timeline-maint` | あり |
| `search-retry` | `{post_id, state_version}` | `search-indexer` | あり（5 回でアラート） |
| `ts-signals` | `{user_id, signal, value, window_end}`（大量のフォローなど） | `graph` の流れの消費者 → `ts-stream` | あり |

`notification-retry`・`search-retry`・`ts-signals` の名前はこの文書で決めた。

## 6. OpenSearch

[ADR-0025](../../decisions/0025-search-engine-and-japanese-analysis.md)・[ADR-0026](../../decisions/0026-search-index-layout-and-visibility.md)。外部のバージョン（`version_type = external_gte`）に `state_version` を使う。

### 6.1 `posts-YYYYMM`（別名 `posts-read`）

| フィールド | 型 | 元 |
| --- | --- | --- |
| `post_id`・`author_id`・`conversation_id`・`reply_to_user_id`・`quote_of_id` | `keyword` | `posts`（文字列で持つ） |
| `created_at` | `date` | `tid` の時刻 |
| `text` | `text`（`text.gram`：1〜2 文字の N-gram、`text.word`：kuromoji） | `posts.text`（`normalizeForSearch` の後） |
| `alt_text` | `text`（同上） | `media.alt_text` |
| `hashtags`・`mentions`・`urls_domain`・`lang` | `keyword` | 抜き出しの表 |
| `has_media`・`has_video`・`has_link`・`is_reply`・`is_quote` | `boolean` | |
| `deleted`・`mod_hidden`・`search_excluded`・`sensitive` | `boolean` | `state`、`mod_flags`（`REMOVED` → `mod_hidden`、`REDUCE`・`UNDER_REVIEW` → `search_excluded`） |
| `mod_regions` | `keyword` | `mod_geo` |
| `author_protected`・`author_suspended` | `boolean` | `users` |
| `likes`・`reposts`・`replies` | `integer` | `post_counters`（概算、10 分ごと） |
| `state_version`・`norm_version` | `long`・`integer` | |

- リポストは文書にしない。墓石（`deleted` か `mod_hidden`、本文を空）は 7 日後に消す。

### 6.2 `users-v1`

`user_id`（`keyword`）、`handle`（`keyword` と `edge_ngram` 1〜15）、`display_name`（`text.gram` と kuromoji）、`bio`（kuromoji）、`followers_log`（`byte`）、`protected`・`suspended`（`boolean`）、`state_version`（`long`）。凍結・削除のアカウントは消す。

### 6.3 `hashtags-v1`

`tag_norm`（`keyword` と `edge_ngram`）、`display`（`keyword`）、`count_7d`（`integer`）、`updated_at`（`date`）。

## 7. プッシュの中身

本文を載せない形を既定にする（[ADR-0030](../../decisions/0030-push-and-email-delivery.md)）。本文を載せる形は `release.push.rich_payload` の後ろ（L4 の確認待ち）。

APNs（`apns-collapse-id` にまとめの鍵、`apns-push-type: alert`）：

```json
{ "aps": { "alert": { "loc-key": "push.generic.like" }, "badge": 12,
           "mutable-content": 1, "thread-id": "like:1844…" },
  "t": "like", "nid": "<notification_id>", "gk": "like:1844…" }
```

FCM（HTTP v1 のデータのメッセージ、`collapse_key` にまとめの鍵）：

```json
{ "message": { "token": "…", "android": { "collapse_key": "like:1844…", "priority": "high" },
  "data": { "t": "like", "nid": "<notification_id>", "gk": "like:1844…", "badge": "12" } } }
```

- DM：`"t": "dm"`、`"cid": "<conversation_id>"`、`"seq": "<seq>"` だけ。表示は「メッセージが届きました」（[direct-messages.md](../direct-messages.md) の 6.3 節）。
- 端末は `nid` で `GET /api/notifications/{nid}` を呼び、本人の権限で中身を取って表示を作る。取れなければ一般の文のまま出す。
- `loc-key` の一覧は `packages/i18n` に持つ。

## 8. API の形（要約）

正本は [api-and-rate-limits.md](../api-and-rate-limits.md) の 3 節と OpenAPI。ここでは DB の列との対応だけを書く。

| 資源 | 主なフィールド | 元 |
| --- | --- | --- |
| Post | `id`、`author_id`、`text`、`created_at`、`lang`、`conversation_id`、`in_reply_to_user_id`、`referenced_posts[{type: replied_to\|quoted\|reposted, id}]`、`entities{mentions, hashtags, urls}`、`attachments.media_keys`、`reply_settings`、`possibly_sensitive`、`public_metrics{like_count, repost_count, reply_count, quote_count}`、`withheld{country_codes}` | `posts`、抜き出しの表、`post_media`、`post_counters`（`pc:`）。`bookmark_count`・`impression_count` は作者だけ |
| User | `id`、`username`（`handle`）、`name`、`description`、`location`、`url`、`profile_image_url`、`protected`、`created_at`、`public_metrics{followers_count, following_count, post_count}`、`pinned_post_id` | `users`、`profiles`、`user_counters`（`uc:`） |
| Media | `media_key`（API の ID は `media_id` の文字列）、`type`、`url`（`/m/` か署名つきの `/p/`）、`width`、`height`、`duration_ms`、`alt_text`、`variants` | `media`、`media_variants` |
| DM Message | `id`（`message_id`）、`conversation_id`、`seq`、`sender_id`、`text`（復号した本文）、`created_at`、`attachments`、`referenced_post` | `dm_messages` |
| Notification（画面の API） | `id`、`type`、`actors[]`（最近 3 人）、`actor_count`、`target_post`、`source_post`、`latest_at`、`unread` | `notifications`、`notification_cursors` |

- 64 ビットの ID は全部 10 進の文字列。時刻は RFC 3339 の UTC。一覧は `{data, includes, meta: {result_count, newest_id, oldest_id, next_token}}`。
- 見えない資源は `not_found` と同じ形（`errors`）で返す。応答の型は `Visible<Post>`（[ADR-0004](../../decisions/0004-single-tenant-and-visibility.md)）。

## 9. 端末の手元の保存

サーバーの data-model の外。形は [clients.md](../clients.md) の 4.1 節（`expo-sqlite`・IndexedDB の `posts`・`users`・`timeline_items`・`drafts`・`send_queue`・`meta`）。`meta` に手元の形のバージョンを持ち、上がったら作り直す。DM の中身は手元に置かない。

# Design log: X

設計の工程ごとに決めたことの記録。今の結論は [README.md](README.md) と各領域の文書と ADR にあり、ここはその経緯を残す。新しい記録は末尾に足す。

記録は README.md から本文のまま移したもので、本文の中の「1.4 節」「6 節」などの節の番号は、[README.md](README.md) の節を指す。

## 2026-10-04：既定案

PM の方針（本家に寄せ、判断が要るところは推奨の既定案で進める）により、最初の設計で次のとおり決めた。その後の領域の工程と統合の工程での変更は、下の「統合」の節にある。法務の判断が要るものは決めず、[intent.md](../intent.md) の「法務の確認待ち」に残した。どれも E1〜E14 の PoC・試験で覆りうる。

- **テナント**：1 つ。RLS は本人だけの表に限る（[ADR-0004](../decisions/0004-single-tenant-and-visibility.md)）。
- **ID**：投稿・利用者・DM のメッセージは 64 ビットの `tid`。共通の UUIDv7 から外れる（[ADR-0002](../decisions/0002-post-ids-and-ordering.md)）。
- **fan-out**：プッシュとプルの組み合わせ。閾値の既定は 1 万フォロワー。写しは 800 件、アクティブ（30 日以内に読んだ）なフォロワーだけに配る（[ADR-0003](../decisions/0003-timeline-fanout-hybrid.md)）。
- **出来事のログ**：Kinesis Data Streams（オンデマンド）。仕事の待ち行列は SQS（[ADR-0005](../decisions/0005-event-log-and-outbox.md)）。
- **ランキング**：S1 は規則と軽いスコア。学習済みのモデルは S2（[ADR-0006](../decisions/0006-ranking-boundary.md)）。
- **アプリ**：React Native（Expo）で iOS・Android を MVP に含める。日本の利用者の大半がスマートフォンで使うため（[ADR-0001](../decisions/0001-platform-and-stack.md)）。
- **文字数**：本家と同じ重み付きの 280。数え方は公開の仕様から自前で実装し、`twitter-text` を使わない（[ADR-0001](../decisions/0001-platform-and-stack.md)）。
- **DM の暗号化**：MVP はサーバーの側の保存の暗号化（KMS）だけ。エンドツーエンドの暗号化は MVP の後（法務の L3 とあわせて決める）。
- **レート制限のヘッダー**：本家の `x-rate-limit-*` の形でなく、IETF の `RateLimit`・`RateLimit-Policy` の形にする（領域の工程で確定した。[ADR-0047](../decisions/0047-rate-limit-token-buckets.md)）。

## 2026-10-04：統合

領域の文書の間の食い違いを、統合の工程で次のとおり解いた。法務の判断が要るものは決めず、[intent.md](../intent.md) の「法務の確認待ち」に残した。

- **出来事のログの流れ**：8 つにした（`posts`・`graph`・`engagement`・`moderation`・`accounts`・`views`・`dm`・`audit`）。`engagement` の鍵は `"{post_id}:{user_id mod 8}"`（[ADR-0023](../decisions/0023-counter-aggregation-and-reconciliation.md)）、`views` の鍵は閲覧者のセッションのハッシュ（[ADR-0024](../decisions/0024-view-counts-ingest-and-approximation.md)）。`dm` は ID だけを運び、データレイクへ写さない（[ADR-0035](../decisions/0035-dm-conversation-model-and-storage.md)）。ADR-0005 の表を直し、注記を残した。
- **Firehose へ直接書く記録**：ランキングの配信の記録（`ranking-served`）、API の計量（`api-usage`）、見える範囲の抜き取り（`visibility-audit`）、RUM（`rum`）は、確定した変更でないので Kinesis Data Streams を通さない（ADR-0005 の注記）。名前は `ranking-served` に揃えた（observability の `ranking-reasons` を直した）。
- **outbox の保持**：送った行を 1 時間残し、DR で大阪の Relay が直近 15 分を送り直す（[ADR-0056](../decisions/0056-disaster-recovery-osaka.md)）。ADR-0005 の「送れたら消す」を直した。
- **カウンターの位置**：ADR-0005 の「結果とシャードの位置を同じ `MULTI`」は Valkey のクラスタでは書けないので取り消した。数の写しは投稿ごとのハッシュに部分ごとの最後の連番を持って冪等に足し（ADR-0023）、シャードの位置は全消費者とも Aurora の `stream_checkpoints` に持つ（[ADR-0055](../decisions/0055-kinesis-consumers-and-valkey-clusters.md) の注記）。`vk-counters` は数と連番だけを持つ。
- **「Valkey の桁ごとの数」**：[README.md](README.md) の 7 節の engagement-and-counters の行と intent の旧い書き方。閲覧の数を確率で概算する方式（桁ごとに確率で足す数え方。HyperLogLog と並ぶ案）を指していたが、数の小さい投稿で誤差が 2% に収まらないので採らなかった（[ADR-0024](../decisions/0024-view-counts-ingest-and-approximation.md) の案 c）。今の形は「投稿ごとのハッシュ `pc:{post_id}` に、数の欄と、`engagement` の鍵の部分（`sub` = 利用者の ID の下 3 ビット、8 つ）ごとの最後の連番を持つ」（ADR-0023）。閲覧の数も同じハッシュの `view` の欄で、HyperLogLog は使わない（ADR-0024）。intent の同じ書き方も直した。
- **ミュートの向き**：ミュートは逆向きの表を持たない（[ADR-0012](../decisions/0012-viewer-sets-cache.md)）。2 つの向きはブロック（`blocks`・`blocked_by`）だけ。ADR-0007 を直した。
- **`ar:` の範囲**：全作者に持つ（直近 7 日・200 件。[ADR-0015](../decisions/0015-fanout-pipeline-and-burst-control.md)）。ADR-0003 を直した。作者の方式は別の `authors` の表を作らず `users.fanout_mode` に置く。
- **DR の `ar:`**：大阪では東京の Kinesis を読み直せないので、入口を開く前に、合わせに要る作者の `ar:` を Aurora から作る（ADR-0016 の注記、[infrastructure.md](infrastructure.md) の 7.5 節）。
- **`visible()` の面**：`ViewerContext.surface` を足した。面で変わるのはミュートの当て方と `interstitial` の扱いだけで、ブロック・鍵・削除・措置は面に関わらず同じ（ADR-0004 の注記、AGENTS.md）。
- **本人だけの表**：領域の文書が足した表（`ranking_feedback`、`dm_message_hidden`、`dm_requests`、`dm_settings`、`user_settings`、通知の表、`oauth_grants`、`data_export_requests` ほか）を ADR-0004 の一覧に足した。正本の一覧は [data-model.md](data-model.md) の 3 節。予約の投稿は MVP に含めない。
- **列の持ち主**：他の領域が求めた列を、持ち主の文書の表に足した。`users.account_mod`・`graph_version`・`fanout_mode`・`pinned_post_id`・`flags` と、新しい `user_settings`（`region`・`personalized_ranking`・`home_default_tab` ほか）は [accounts-and-auth.md](accounts-and-auth.md) の 12 節。`posts.region_code`・`has_media` と `drafts` は [posts-and-ids.md](posts-and-ids.md) の 12 節。DM の設定は `user_settings` の列にせず `dm_settings` に分けた。
- **フラグと設定の名前空間**：フラグは `release.*`・`ops.*`・`experiment.*`、決めた値は `policy.*`・`retention.*`・`legal.*`・`ts.*`（[delivery.md](delivery.md) の 3 節、AGENTS.md）。ランキングの A/B は `experiment.ranking.*` に揃えた（AGENTS.md の `release.ranking.*` を直した）。法務の確認待ちの振る舞いの門は `release.*` にし、`legal.l3.*` を `release.dm_report_evidence`・`release.dm_media_matching` に、`release.ranking.reasons` を `release.ranking_reasons` に、`policy.phone.max_accounts` を `ts.registration.max_accounts_per_phone` に改めた。`ops.timeline.rebuild_window` は `ops.timeline.rebuild_rate` に揃えた。
- **鍵**：通報の証拠の写しとメディアの隔離の置き場に、KMS の鍵 `ts-evidence` を足した（[ADR-0051](../decisions/0051-encryption-and-key-layout.md) の注記）。
- **Valkey の置き場所**：`pl:` は `vk-timeline` に置く（`vk-cache` から外した）。読み出しの命令の数（[capacity.md](capacity.md) の 3 節）を直した。閲覧者の集合は 1 回の Function で読む。
- **閲覧の流れの量**：1 レコード（25 件の束）を 2 KB に揃えた（engagement-and-counters の値）。S1 のピーク 1.6 MB/秒・瞬間 4.8 MB/秒で、`views` も温めた量を 20 MB/秒にする。S3 は約 170 MB/秒で東京の上限の 8 割を超えるので、S2 の間に上限の引き上げを申請する（[capacity.md](capacity.md) の 5.3 節）。Ingest の口は `/i/views` に揃えた。
- **おすすめの負荷**：候補は S1 で 800 件、特徴の付加は軽いランクの後の 200 件だけ（[ranking-and-recommendation.md](ranking-and-recommendation.md)）。capacity の見積もりを合わせた。
- **検索とミュート**：ミュートした作者は投稿の検索から除くが、`from:` で指定したときは出す（[search-and-trends.md](search-and-trends.md) の 6.3 節、[follow-graph.md](follow-graph.md) の 4.5 節）。
- **アプリの段階の配布**：iOS は App Store の 7 日の段階的リリース（1% → 2% → 5% → 10% → 20% → 50% → 100%）、Android は 1% → 10% → 50% → 100%（[runbooks/README.md](../runbooks/README.md) の 3 節を直した。[ADR-0062](../decisions/0062-mobile-release-and-min-version.md)）。
- **品質と運用**：各領域の文書の「quality.md・runbooks への項目」を反映した。漏れの経路の表に、おすすめの続きのページ（`rk:`）、クライアントの手元の写し、運用者・T&S のコンソール、アカウントの状態の変更の直後、閲覧者の集合の更新の失敗、作った後のブロック（通知）を足した。DR の訓練の合格基準を足した。runbooks の手順を、作ったもの（3 つ）と計画のものに分けて一覧にした。
- **法務の確認待ちの追加**：通知の要約のメールと特定電子メール法を L11 として足した。
- **数値の正本**：SLO とアラートは [runbooks/README.md](../runbooks/README.md) の 1・4 節。利用者の行動の上限は [api-and-rate-limits.md](api-and-rate-limits.md) の 5.3 節。保持の期間は [security.md](security.md) の 7.1 節。負荷のモデルは [capacity.md](capacity.md) の 1 節。表と置き場所は [data-model.md](data-model.md)。
- **検証の工程での直し（2026-10-04）**：公式の資料を取得し直して、次を確かめ・直した。おすすめの今の構成（SimClusters、作者の減衰の下限、新しい作者の押し上げ。[README.md](README.md) の 1.3 節）、Chat の鍵の預け方（Juicebox。公式の文書で確かめ、未検証を外した）、情報流通プラットフォーム対処法の指定（2025-04-30 の 5 社の後、5 月に 4 社を追加）、申出から 7 日の期限（第三者の解説で確認、省令の条文は未検証）、CloudFront KeyValueStore の上限と、CloudFront Functions で国の見出しを読めること（[media.md](media.md)）、App Store の段階的リリースの割合、Kinesis の上限、IETF の `RateLimit` の草案（draft-11、まだ RFC でない）、公開 API の課金と上限、メディアの上限。help.x.com と blog.x.com は再び 403 で、そこにしかない値は未検証のまま残した。
- 領域ごとの決定は、各文書の「未解決の問い」の「決定」の節にある。

## 2026-10-04：データモデル

データモデルの完全版（[data-model.md](data-model.md) と [data-model/](data-model/)）を作る工程で、領域の文書と ADR の間の名前と列の食い違いを次のとおり解いた。ADR の決定は変えていない。

- **正本の移動**：列・鍵・索引の正本を [data-model.md](data-model.md) と [data-model/](data-model/) に移した。領域の文書の「data-model への項目」は要点で、食い違ったらデータモデルに合わせて直す。
- **措置の要約の形**：`posts.mod_flags` をビット（`LABEL`・`REDUCE`・`REMOVED`・`AGE_GATED`・`GEO_WITHHELD`・`UNDER_REVIEW`・`NO_ENGAGE`・`MEDIA_REMOVED`）と地域の列 `posts.mod_geo` にし、`users.account_mod` もビットと `account_mod_detail` にした（[data-model.md](data-model.md) の 3.5 節）。[posts-and-ids.md](posts-and-ids.md) の `restricted`・`age_gated`・`geo_withheld` と [trust-and-safety.md](trust-and-safety.md) の `label`・`reduce`・`removed`・`geo` の食い違いを、この名前に揃えた。
- **作者の状態のバージョン**：`as:` のバージョンとして `users.state_version` を足した（[posts-and-ids.md](posts-and-ids.md) の 6 節が求めていたが、`users` の表になかった）。
- **本人だけの表の列**：`owner_id` に揃えた（`user_contacts`・`user_birthdates`・`dm_message_hidden`・`oauth_grants` の `user_id` を直した）。`user_contacts` に変更の保留の `slot`（`current`・`pending`）と HMAC の鍵のバージョンを足した。
- **`auth` スキーマ**：`auth.user.email`・`phone_number` に平文でなく HMAC の値を入れ、`auth.session` に IP を残さない（[security.md](security.md) の 5.3 節の「平文の列を持たない」を Better Auth の表にも当てる）。Better Auth のバージョンで動くかは E2 の `auth-signup-login` で確かめる。
- **通知のまとめ**：日ごとに分けた `notifications` には、領域の文書の部分の一意の索引 `(owner_id, group_key) WHERE is_open` を張れない（分ける鍵を含まないため）。開いている行を `notification_open_groups` の主キーで 1 つにし、まとめない種類の冪等は分ける鍵 `bucket_on`（元の投稿の `tid` の日）を含めた一意にした。
- **出来事の名前**：鍵の切り替えは `accounts` の流れの `accounts.protected_changed` に揃えた（[follow-graph.md](follow-graph.md) の `graph` の流れの `account.protected_changed` を直した）。投稿の措置は `moderation.action_applied` と `post.state_changed` を同じトランザクションで書く。
- **Relay の区画**：`relay_partitions` は表にせず、Valkey の `relay:lease:{n}`（なければ勧告的ロック）にした（[infrastructure.md](infrastructure.md) の 14 節を直した）。
- **足した表**：`notification_open_groups`、`processed_events`（DB に書く消費者の重複の記録）、`post_shard_map`・`engagement_shard_map`（S2。`graph_shard_map` と同じ形）。`legal_holds` の `from`・`to` は SQL の予約語を避けて `period_from`・`period_to` にした。
- **DB のロールと S2 のクラスタ**：サービスごとの DB のロールと列の単位の書き込みの権限（[data-model.md](data-model.md) の 3.3 節）、S2 のクラスタへの表の割り当て（S1 の `main` を `core` として残す。3.12 節）を決めた。
- **S2 で同じトランザクションを保てない書き込み（推奨。S2 の着手の時に ADR で確定する）**：
  - フォローと `users.graph_version`：バージョンを関係のクラスタの表（`graph_versions(user_id, version)`、`user_id` の分割）に移す。
  - 措置と要約：`moderation_actions`・`moderation_action_events` を対象と同じクラスタ・分割に置き（投稿・メディアは `posts`、アカウントは `accounts`）、案件・通報・法令の表は `core` に残す。ADR-0038 の「同じトランザクション」を保つ。
  - 投稿と `media` の `attached`：付け先の正本を `post_media`・`dm_messages.media_id` にし、`media.state` の `attached` は出来事から冪等に書く。付ける前の確かめ（`ready` で同じ作者）は書き込みの時に読む。

持ち越し（法務、計測・PoC・選定で決めるもの）：

| 項目 | いつ・どう決めるか |
| --- | --- |
| 法務の確認待ち（L1〜L11） | [intent.md](../intent.md) の「法務の確認待ち」。結論まで、そこに挙げた Story の spec を承認しない |
| fan-out の閾値、アクティブの定義、写しの形と件数、新着の窓、Worker と Valkey の 1 シャードの速さ | E5 の前の `fanout-poc` |
| 閲覧の数の取り込みの費用と誤差 | E6 の前の `view-count-poc` |
| 日本語の検索の索引の大きさ、Sudachi との比較 | E9 の前の `search-poc` |
| おすすめの候補の数と `ranking` のタスクの数（S1 の CPU が足りない見込み） | E10 の負荷試験 |
| Kinesis のシャードの分割の後、同じ鍵の連番が増え続けるか | E6 の `counter-aggregator` |
| 有害なメディアのハッシュの照合の提供者 | E11 の `media-hash-matching`（法務の L4・L7 とあわせる） |
| 「見えなくなった」の知らせ（`hidden`）を誰に送るか | E5（[clients.md](clients.md) の 4.4 節） |
| MediaConvert で 1 分の動画 p95 60 秒を守れるか、CloudFront の無効化の時間 | E7 の `video-transcode`・`media-delivery-and-takedown` |
| ElastiCache の Valkey のバージョンとノードの記憶、Global Datastore、KMS の要求のクォータ、サーバーの時計のずれ | E1 の着手の時 |
| S2 で同じトランザクションを保てない書き込み（[data-model.md](data-model.md) の 7 節。推奨は上の「データモデル」の決定） | S2 の着手の時に ADR を書く |
| 本家の振る舞いで未確認のもの（ヘルプセンターの値、6,800 万人、2012 年の講演の数値） | 公式の資料で確かめられなかった。未検証のまま、本システムの値を使う |

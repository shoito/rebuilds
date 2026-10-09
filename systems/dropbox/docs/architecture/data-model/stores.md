# Data model: DB の外（S3・Valkey・SQS・合図・トークン・Webhook・OpenSearch・AppConfig）

[data-model.md](../data-model.md) の一部。DB の表の外に置くデータと、外へ出す形をまとめる。中身（ブロック）の正本は S3、メタデータの正本は Aurora で、ほかはどれも失っても作り直せるか、失ってよい。

- 鍵・接頭辞・メッセージには、ID・ハッシュ・数・理由のコードだけを入れる。ファイルの名前・パス・中身、メールアドレス、トークンの平文を入れない。例外は S3 の `exports` の目録（組み立てに名前が要る）と、OpenSearch の名前の索引（[data-model.md](../data-model.md) の 3.5 節）。
- 本家の名前を入れない。ブランドの部分は `<brand>`・`<Brand>` で書く（[リポジトリ共通の ADR-0006](../../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。
- 名前のうち、領域の文書で決めていなかったものは、この文書で決めた（表の「決めた場所」が「この文書」のもの）。

ER 図は持たない（表ではないため）。表との結び付きは各節の「書く・読む」に書く。

## 1. S3

すべて非公開、SSE-KMS とバケットキー、`aws:SecureTransport` を必須（[ADR-0044](../../decisions/0044-encryption-keys-and-secrets.md)）。`<h4>` はハッシュの先頭 4 文字（16 進）、`<sc>` は `s`（128 KiB 未満）か `l`。キーにテナントを含め、重複排除をテナントの中に閉じる（[ADR-0003](../../decisions/0003-dedupe-scope-and-privacy.md)）。

| バケット（東京） | キー | 中身 | 鍵 | 保持・複製 | 決めた場所 |
| --- | --- | --- | --- | --- | --- |
| `<brand>-incoming-apne1` | `u/<upload_id>/<n>` | 送られたばかりのブロック（`upload_id` は 128 ビットの乱数）。クライアントが書けるのはここだけ | `kms-blocks` | 2 日で消す。写さない（大阪は大阪の `incoming`） | [ADR-0007](../../decisions/0007-block-storage-layout-on-s3.md) |
| `<brand>-blocks-apne1` | `b/<sc>/<h4>/<tenant_id>/<hash>` | 確かめたブロック（`hash` は 64 文字の 16 進） | `kms-blocks` | バージョニング（古いバージョンは 30 日）。`l` は Intelligent-Tiering。大阪へ CRR（RTC） | 同上 |
| `<brand>-blocks-apne1` | `pk/<h4>/<tenant_id>/<pack_id>` | S2：小さなブロックのパック（64 MiB まで、不変） | `kms-blocks` | 同上 | [ADR-0020](../../decisions/0020-small-block-packing-for-s2.md) |
| `<brand>-blocklists-apne1` | `bl/<h4>/<tenant_id>/<blocklist_hash>` | 1,024 を超えるブロックの一覧（36 バイトの組の並び。`revisions.blocklist` と同じ形） | `kms-blocks` | `blocks` と同じ（Standard） | [ADR-0002](../../decisions/0002-chunking-and-block-addressing.md)、[ADR-0007](../../decisions/0007-block-storage-layout-on-s3.md) |
| `<brand>-previews-apne1` | `p/<tenant_id>/<rev_id>/<kind>.r<renderer_version>.webp` | プレビュー・サムネイル（WebP） | `kms-previews` | 90 日。写さない（作り直せる） | [ADR-0033](../../decisions/0033-preview-cache-and-delivery.md) |
| 同上 | `p/<tenant_id>/<rev_id>/text.e<extractor_version>.txt` | 抽出したテキスト（UTF-8、先頭 1 MiB の文字まで） | `kms-previews` | 90 日 | [previews-and-thumbnails.md](../previews-and-thumbnails.md) の 12 節 |
| `<brand>-exports-apne1` | `x/<tenant_id>/<export_id>/manifest` | 組み立ての目録（リビジョン、ブロックの番地、ZIP の中の相対の名前）。JSON | `kms-blocks` | 1 日。写さない | [ADR-0054](../../decisions/0054-server-assembled-downloads.md) |
| 同上 | `x/<tenant_id>/<export_id>/data` | 組み立てた ZIP（無圧縮、ZIP64）か 1 つのファイル | `kms-blocks` | 1 日 | 同上 |
| `<brand>-audit-apne1` | `tenant/<tenant_id>/<yyyy>/<mm>/<dd>/<hh>.ndjson.gz` | `tenant_audit_events` の写し | `kms-audit` | Object Lock（コンプライアンス、期間は L3・L6。既定 1 年）。大阪へ CRR | この文書（[ADR-0045](../../decisions/0045-audit-log-and-data-lifecycle.md)） |
| 同上 | `chain/<tenant_id>/<yyyy-mm-dd>.json` | 日の終わりの連鎖の値（`audit_chain_heads`） | `kms-audit` | 同上 | 同上 |
| 同上 | `platform/<yyyy>/<mm>/<dd>/<hh>.ndjson.gz` | `platform_audit_events` の写し | `kms-audit` | 同上 | 同上 |
| 同上 | `activity/tenant_id=<tenant_id>/day=<yyyy-mm-dd>/<part>.parquet` | ファイルの活動の事象（Firehose、Glue のテーブル `activity_events`、Athena）。チームのプランだけ | `kms-audit` | 同上 | [security.md](../security.md) の 7 節 |
| release のアカウント | `manifest/<platform>/<arch>/<channel>.json`、`artifacts/<version>/…` | クライアントの更新の目録（Ed25519 の署名つき）と成果物 | 別のアカウントの鍵 | バージョンごと | [delivery.md](../delivery.md) の 5 節 |

- **活動の事象の列**（Parquet）：`id`、`tenant_id`、`at`、`ns_id`、`node_id`、`rev_id`、`op`（`create`・`update`・`move`・`delete`・`restore`・`download`・`preview`・`link_view`・`link_download`）、`actor_kind`、`actor_id`、`device_id`、`link_id`、`seq`（ジャーナルの番号。欠けの照合）。名前を持たない。画面で `can()` の範囲の名前をその時に引く。
- 署名つき URL：
  - PUT：S3 の事前署名（15 分、`x-amz-checksum-sha256` と `Content-Length` を署名に含める）。
  - 配信：CloudFront の署名つき URL（`content.<brand>usercontent.<domain>`）。ブロック `/b/<sc>/<h4>/<tenant_id>/<hash>`（1 時間、1 ブロックずつ署名。ワイルドカードを使わない）、パック `/b/pk/…?r=<offset>-<length>`（S2、範囲を署名に含める）、プレビュー `/p/…`（10 分）、書き出し `/x/<tenant_id>/<export_id>/data`（1 時間）、共有リンクからの配信は `/l/…` の別の接頭辞（プレビュー 5 分、ブロック・書き出し 15 分）。
  - sandbox のジョブ：ブロックの GET とプレビューの PUT の事前署名（10 分）。
- テナントの消去：`p/<tenant_id>/`・`x/<tenant_id>/` を消し、`blocks` は索引を `orphaned` にして GC の経路で消す。

## 2. Valkey（ElastiCache）

失ってよい。落ちたときは DB を読む（取り消しの確かめを含む）か、手元のメモリーの近似で続ける。名前空間をまたぐ合図は、シャードの pub/sub（`SSUBSCRIBE`・`SPUBLISH`）を使うかを E3 の `notify-gateway` で確かめる。

| 鍵・チャンネル | 種類 | TTL | 中身 | 書く・読む | 決めた場所 |
| --- | --- | --- | --- | --- | --- |
| `ns:<ns_id>` | pub/sub | — | `{"s":<seq>}`（「`ns_seq` が S になった」だけ） | Relay → Notify | [ADR-0005](../../decisions/0005-namespace-journal-and-cursors.md)、[api-and-webhooks.md](../api-and-webhooks.md) の 6 節 |
| `ns_head:<ns_id>` | 文字列 | 1 日 | 名前空間の最新の `ns_seq`（`list/continue` の速い道） | Relay → `api` | [capacity.md](../capacity.md) の 3.1 節 |
| `ns_tail:<ns_id>` | リスト | 1 時間（触れるたびに延ばす） | 購読が 1,000 を超える名前空間のジャーナルの末尾（最大 1 万行、`ns_journal` の行の形。名前を含む） | `api` | 同上 |
| `path:<ns_id>:<parent_id>:<name_key_hash>` | 文字列 | 60 秒 | `node_id`（パスの解決の前半 4 段。最後の段は DB で確かめる） | `api` | [metadata-and-journal.md](../metadata-and-journal.md) の 7.3 節（`name_key` はハッシュにして鍵に入れる。この文書） |
| `acc:<account_id>:<access_version>` | 文字列（MessagePack） | 10 分 | 読める名前空間の集合 `{ns_id → role}` | `packages/access` | [namespaces-and-sharing.md](../namespaces-and-sharing.md) の 5.2 節 |
| `dlurl:<tenant_id>:<hash>` | 文字列 | 30 分 | ブロックの配信の署名つき URL（期限の残りが 30 分以上なら使い回す） | `api` | [block-storage.md](../block-storage.md) の 7.1 節 |
| `pvurl:<rev_id>:<kind>` | 文字列 | 5 分 | プレビューの署名つき URL | `api` | [previews-and-thumbnails.md](../previews-and-thumbnails.md) の 9 節（名前はこの文書） |
| `upload_bucket:global`・`upload_bucket:<tenant_id>` | トークンバケット | — | アップロードの受け入れ（2.5 GB/秒、個人 100 MB/秒、チーム 1 GB/秒） | `api` | [capacity.md](../capacity.md) の 4.3 節 |
| `rl:app_acct:<app_id>:<account_id>`、`rl:app_acct_content:<app_id>:<account_id>`、`rl:app:<app_id>`、`rl:acct:<account_id>` | トークンバケット | — | 公開 API のレート制限（1 分 1,200・瞬間 200、中身の計画 120、アプリ 100,000、アカウント 3,000） | `api` | [ADR-0039](../../decisions/0039-oauth-apps-scopes-and-rate-limits.md)（名前はこの文書） |
| `lp:<app_id>:<account_id>` | 数 | 10 分 | long-poll の同時の本数（4 まで） | Notify | 同上 |
| `rl:link_ip:<ip>`、`rl:link_miss:<ip>`、`rl:link:<link_id>`、`rl:link_pw:<link_id>:<ip>`、`rl:link_pw:<link_id>`、`rl:link_create:<account_id>` | 時刻の窓つきの数 | 1 分〜1 日 | 共有リンクの悪用の対策（[shared-links.md](../shared-links.md) の 9 節の値） | `link`・`api` | [ADR-0028](../../decisions/0028-shared-link-abuse-controls.md)（名前はこの文書） |
| `lbw:<link_id>:<yyyymmdd>` | 数 | 2 日 | リンクの 1 日の帯域（バイト） | `link` → 日次で `link_bandwidth_daily` | 同上 |
| `pol:<tenant_id>` | 文字列 | 60 秒 | `team_policies` の写し（Link の解決のたびの評価） | `link`・`api` | [shared-links.md](../shared-links.md) の 6 節（名前はこの文書） |
| `appok:<tenant_id>:<app_id>` | 文字列 | 60 秒 | `team_app_policies` と認可の写し（Webhook の送る前の確かめ） | `webhook-sender` | [ADR-0040](../../decisions/0040-signed-webhooks-delivery.md)（名前はこの文書） |
| `wh:pending:<app_id>` | 集合 | — | Webhook の未送のアカウントの ID | `webhook-fanout` → `webhook-sender` | [api-and-webhooks.md](../api-and-webhooks.md) の 9 節 |
| `tok:<token_hash>` | 文字列 | 30 秒 | トークンの検証の結果 `{account_id, device_id?, app_id?, scopes, root_ns?, auth_epoch}` | `auth` → 全サービス | [accounts-and-teams.md](../accounts-and-teams.md) の 5.4 節（名前はこの文書） |
| `revoked:token:<token_hash>`、`revoked:device:<device_id>`、`revoked:account:<account_id>:<auth_epoch>` | 文字列 | 30 日 | 取り消しの一覧（DB にもある） | `auth` → 全サービス | 同上 |
| `revoked` | pub/sub | — | `{"k":"token"\|"device"\|"account","id":"…"}`（Notify は 5 秒以内に切る） | `auth` → 全サービス | 同上 |
| `authfail:code:<account_id>`、`authfail:ip:<ip>` | 時刻の窓つきの数 | 10 分〜1 時間 | ログインの失敗（メールのコード 10 分 5 回、IP 10 分 100 回） | `auth` | 同 5.1 節（名前はこの文書） |

- 秘密・トークンの平文を、鍵にも値にも入れない。
- `ns_tail:` は名前を含むので、暗号化（`kms-cache`）と、`api` のロールだけの ACL（Valkey のユーザー）で守る。

## 3. SNS・SQS と outbox の話題

Relay が `outbox` の行を読み、`topic` ごとに送る（[journal-and-cursors.md](journal-and-cursors.md) の 2.4 節）。メッセージの属性に `tenant_id`・`outbox_id`・`traceparent` を付ける。どの消費者も重複と順序の入れ替わりを前提にする（冪等は各表の鍵か外部のバージョンで守る）。

| `topic` | 本文（`payload`） | 行き先 | 消費者 | 冪等の鍵 |
| --- | --- | --- | --- | --- |
| `ns_committed` | `{ns_id, from_seq, to_seq}` | Valkey `ns:<ns_id>`・`ns_head:`、SQS `index-names`（FIFO、グループ `ns_id`）、`webhook-fanout`、`activity-export` | Notify、`indexer`、`webhook-fanout`、`activity-exporter` | `seq` の範囲、OpenSearch の外部のバージョン |
| `revision_created` | `{ns_id, rev_id, node_id, size, mime_hint, fulltext}` | SQS `preview-jobs`（先に作る対象だけ）、`text-extract-jobs`（`fulltext` が真）、`scan-jobs`（`content_scan_policy` が `all_uploads`） | `preview-orchestrator`、`content-scanner` の orchestrator | `preview_entries`・`extracted_texts` の主キー |
| `commit_summary` | `{ns_id, device_id, actor_id, committed_at, counts: {update, delete, rename, rename_ext_changed}, new_ext: {ext: n}}` | SQS `mass-change` | `mass-change-detector` | `outbox_id` |
| `access_changed` | `{kind: grant\|revoke\|policy\|app_block, account_ids?, tenant_id?, ns_id?}` | Valkey `revoked`、SQS `access-changes` | Notify（購読の外し）、`auth`（アプリのトークンの無効化） | `outbox_id` |
| `link_access` | `{ns_id, link_id, at, kind, result, actor_id?, client_ip?, ua_class, reason_code?}` | SQS `link-access` | `activity` の Worker（`link_access_events`、Firehose） | `link_access_events.id` |
| `content_access` | `{ns_id, rev_id, node_id, op: download\|preview, actor_id, device_id?, via}` | Firehose（`activity_events`） | — | `outbox_id` |
| `notification` | `{recipient_account_id, recipient_tenant_id, type, ref_kind, ref_id, ref_tenant_id, params}` | SQS `notify-events` | `notifier`（`notification_events`、プッシュ） | `outbox_id` |
| `mail` | `{template, recipient_account_id \| recipient_email_ref, params}` | SQS `mailer` | `mailer` | `outbox_id` |
| `scan_requested` | `{ns_id, rev_id, reason: link_public}` | SQS `scan-jobs` | `content-scanner` の orchestrator | `revisions.scan_state` |
| `export_requested` | `{tenant_id, export_id}` | SQS `export-jobs` | `export-builder` | `export_jobs.state` |
| `membership_copy` | `{tenant_id, job_id}` | SQS `membership-copy` | `batch-runner` | `membership_copy_jobs.state` |

Relay を通らないキュー：

| キュー | 送り手 | 本文 | 消費者 | 決めた場所 |
| --- | --- | --- | --- | --- |
| `block-verify` | S3 `incoming` の ObjectCreated | S3 のイベント（キー `u/<upload_id>/<n>`）。遅れの戻しは 60 秒 | `block-verifier` | [block-storage.md](../block-storage.md) の 4.2 節 |
| `preview-jobs-interactive`・`preview-jobs` | `api`（見たとき）、`preview-orchestrator` | `{job_id, tenant_id, rev_id, kind, renderer_version, input: [{url, sha256, size, offset}], output_url, limits}`。見えない時間 2 分 | `preview-renderer`（sandbox） | [previews-and-thumbnails.md](../previews-and-thumbnails.md) の 6.2 節 |
| `text-extract-jobs` | `preview-orchestrator`、`indexer` | 同上の形（出力はテキスト） | `text-extractor`（sandbox） | 同上 |
| `scan-jobs` | orchestrator | 同上の形（出力は判定と `verified_sha256`） | `content-scanner`（sandbox） | [ADR-0046](../../decisions/0046-content-scanning-framework.md) |
| `sandbox-results` | sandbox のタスク | `{job_id, state, reason_code?, output: {size, sha256}?, verified_sha256?, verdict?}` | `preview-orchestrator`、scan の orchestrator | [ADR-0032](../../decisions/0032-sandboxed-preview-pipeline.md) |
| `export-results` | `export-builder` | `{tenant_id, export_id, state, reason?, size?}` | `api`（`export_jobs`） | [ADR-0054](../../decisions/0054-server-assembled-downloads.md) |

- ジョブの本文に名前・パスを入れない。形式の判定は `mime_hint` と先頭のバイトで行う。
- 新しいキューの名前（`mass-change`、`access-changes`、`link-access`、`notify-events`、`mailer`、`membership-copy`、`webhook-fanout`、`activity-export`）はこの文書で決めた。

## 4. 合図とプッシュ

### 4.1 WebSocket（`wss://notify.<brand>.<domain>/v1/stream`）

自社のクライアントだけ（[api-and-webhooks.md](../api-and-webhooks.md) の 6 節）。本文は JSON の 1 行。中身を送らない。

| 向き | メッセージ | 中身 |
| --- | --- | --- |
| 端末 → | `{"t":"auth","token":"<brand>_at_…"}` | 接続の後の最初のメッセージ（URL に入れない） |
| 端末 → | `{"t":"watch","cursor":"c1.…"}` | Notify はカーソルの署名・`access_version`・名前空間の集合（1,000 まで）を確かめて購読する |
| → 端末 | `{"t":"ns","ns":"<ns_id>","s":<seq>}` | カーソルの位置より進んだ名前空間だけ。窓（1〜3 秒）でまとめる |
| → 端末 | `{"t":"ping"}` | 25 秒ごと |
| → 端末 | `{"t":"reconnect","after_ms":<0〜30000>}` | デプロイ・24 時間の切断の前 |
| → 端末 | `{"t":"device_revoked"}` | 取り消しの合図の後、切る前 |
| → 端末 | `{"t":"error","code":"invalid_cursor"\|"too_many_namespaces"\|"unauthorized"}` | |

- long-poll（`files/list_folder/longpoll`）の応答は `{"changes":true|false,"backoff":<秒>?}`。

### 4.2 モバイルのプッシュ（APNs・FCM）

**`release.mobile-push` の裏（法務の L4）**（[ADR-0037](../../decisions/0037-mobile-offline-files-and-content-free-push.md)）。

- APNs：`{"aps":{"alert":{"title-loc-key":"generic_title"},"mutable-content":1},"type":"<type>","event_id":"<uuid>"}`。通知の拡張が `notifications/get { event_id }` で文を取る。取れなければ決まった文。
- FCM：データのメッセージ `{"type":"<type>","event_id":"<uuid>"}`。
- 名前・メールアドレス・ファイルの名前を入れない。

## 5. カーソル・トークン・ID の形

### 5.1 カーソル

| 種類 | 形 | 期限 | 中身 | 決めた場所 |
| --- | --- | --- | --- | --- |
| 差分のカーソル | `c1.<base64url(payload)>.<base64url(mac)>` | 最後の利用から 90 日（`issued_at`） | `payload` = zstd(CBOR `{v:1, kid, account_id, scope: "tree"\|"folder", root_ns, folder_node_id?, positions: [[ns_id, seq], …], mount_hash, epoch, issued_at}`)。`mac` = HMAC-SHA256（鍵は `kid` で選ぶ。1 年ごとに入れ替え、古い鍵での確かめを 100 日残す） | [ADR-0005](../../decisions/0005-namespace-journal-and-cursors.md)（形はこの文書） |
| 木の一覧のページ | `lt1.<base64url>.<mac>` | 24 時間 | `{ns_id, root_node_id?, after_node_id, snapshot_seq, issued_at}` | [ADR-0023](../../decisions/0023-tree-listing-snapshot-and-journal-retention.md)（形はこの文書） |
| フォルダーの子の一覧のページ | `lc1.<base64url>.<mac>` | 24 時間 | `{ns_id, parent_id, after_name_key, issued_at}` | 同上 |
| 検索の続き | `sr1.<base64url>.<mac>` | 15 分 | `{search_after, query_hash, account_id, access_version, issued_at}` | [search.md](../search.md) の 5.2 節（形はこの文書） |

- カーソルは要求の本文で送り、URL に入れない。利用者が他人の名前空間の位置を作れない（署名）。
- `mount_hash` = SHA-256（載せた名前空間と役割の組を `ns_id` の順に並べたもの）の先頭 16 バイト。
- 形（`v`）を変えるときは、新旧を受けるコードを出してから新しい形を発行する（[delivery.md](../delivery.md) の 6.4 節）。

### 5.2 トークンと秘密

形はすべて `<接頭辞>` ＋ 32 文字の base62 の乱数（約 190 ビット）＋ 6 文字の base62 の CRC32。CRC32 で、打ち間違いとシークレットの走査の誤検知を DB を引かずに弾く。DB には SHA-256 だけを持つ（`shared_links.token_ciphertext` と Webhook の秘密を除く）。

| 接頭辞 | 用途 | 期限 | 保存 |
| --- | --- | --- | --- |
| `<brand>_at_` | アクセストークン（端末・アプリ） | 端末 1 時間、アプリ 4 時間 | `device_credentials.access_token_hash`、`oauth_tokens.token_hash` |
| `<brand>_rt_` | 更新トークン | 使うたびに替える。使わないまま 90 日 | `device_credentials.refresh_token_hash`、`oauth_tokens.token_hash` |
| `<brand>_sl_` | 共有リンク | リンクの期限 | `link_tokens.token_hash`、`shared_links.token_ciphertext` |
| `<brand>_whsec_` | Webhook の署名の秘密 | アプリが作り直すまで | `oauth_apps.webhook_secret_ciphertext` |
| `<brand>_inv_` | チームの招待（7 日）、共有フォルダーの招待（30 日。D-18） | 1 回限り | `team_invitations.token_hash`、`ns_invites.token_hash` |
| `<brand>_scim_` | SCIM の Bearer | 作り直すまで | `scim_tokens.token_hash` |

- ドメインの確認：TXT `_<brand>-challenge.<ドメイン>` に `<brand>-domain-verification=<32 文字の base62>`（`team_domains.verify_token_hash`）。
- 共有リンクのパスワードの印：Cookie `lk_<link_id>`（12 時間、`HttpOnly`・`Secure`・`SameSite=Lax`、`www` のドメイン）に `{link_id, password_version, exp}` を HMAC で署名したもの。
- 端末の状態の確かめ（`POST /device/status`）：端末の鍵（Ed25519）で `{device_id, ts, nonce}` に署名する。
- 接頭辞と形は、シークレットの走査に独自の形式として登録する。

### 5.3 公開の ID の表し方

- ノード・名前空間・リビジョンは UUID の文字列（`id:<node_id>`、`ns:<ns_id>/…`、`rev:<rev_id>`）。
- Webhook の本文のアカウントの ID は `acc_` ＋ UUID の 16 バイトの Crockford base32（26 文字、小文字）。API の `users/get_current_account` も同じ形で返す（この文書で決めた）。

## 6. Webhook

[ADR-0040](../../decisions/0040-signed-webhooks-delivery.md)、[api-and-webhooks.md](../api-and-webhooks.md) の 9 節。

- 登録の確かめ：`GET <url>?challenge=<32 バイトの乱数の hex>`。10 秒以内に本文でその値を返したら有効。
- 送り：

```http
POST <url> HTTP/1.1
Content-Type: application/json
User-Agent: <Brand>-Webhook/1
<Brand>-Signature: t=1791504000,v1=5f2b…,v1=9a1c…
<Brand>-Delivery-Id: 0192a8f0-…

{"notification":{"accounts":["acc_01j…","acc_01k…"]},"delivery_id":"0192a8f0-…","sent_at":"2026-10-09T03:20:00Z"}
```

- 署名：`v1 = hex(HMAC-SHA256(<brand>_whsec_…, t + "." + 本文のバイト))`。受け手は `t` が 5 分以内かを確かめる。入れ替えの 24 時間は `v1` が 2 つ並ぶ。
- 本文のアカウントは 1,000 まで。名前・パス・名前空間の ID を入れない。受け手はカーソルで取りに来る。
- 成功は 10 秒以内の 2xx。再試行と止め方は `webhook_deliveries`（[api-apps-and-webhooks.md](api-apps-and-webhooks.md) の 2.6 節）。

## 7. OpenSearch

[ADR-0034](../../decisions/0034-search-index-and-permission-filter.md)、[search.md](../search.md) の 4・6 節。文書の ID は `node_id`、`routing` は `tenant_id`、文書のバージョンは `ns_seq`（`version_type=external`）。別名 `names`・`content` を切り替えて作り直す。

### 7.1 `names-v<N>`

```json
{
  "settings": {
    "analysis": {
      "analyzer": {
        "ja_name_ngram":  { "tokenizer": "ngram_1_2", "char_filter": ["icu_nfkc_cf", "kana_unify"], "filter": ["lowercase"] },
        "ja_name_prefix": { "tokenizer": "edge_1_20", "char_filter": ["icu_nfkc_cf", "kana_unify"], "filter": ["lowercase"] }
      }
    }
  },
  "mappings": {
    "dynamic": "strict",
    "_routing": { "required": true },
    "properties": {
      "tenant_id":    { "type": "keyword" },
      "ns_id":        { "type": "keyword" },
      "node_id":      { "type": "keyword" },
      "parent_id":    { "type": "keyword" },
      "ancestor_ids": { "type": "keyword" },
      "name": {
        "type": "text", "analyzer": "ja_name_ngram",
        "fields": {
          "exact":  { "type": "keyword" },
          "prefix": { "type": "text", "analyzer": "ja_name_prefix", "search_analyzer": "ja_name_ngram" }
        }
      },
      "ext":          { "type": "keyword" },
      "is_folder":    { "type": "boolean" },
      "size":         { "type": "long" },
      "modified_at":  { "type": "date" }
    }
  }
}
```

- `name.exact` には `name_key` を入れる。表示のパスは入れない（返す時に Aurora で作る）。
- マウントのノードは入れない（載せた名前空間の最上位のノードを、その名前空間の文書として入れる）。
- `kana_unify`（ひらがなとカタカナ、長音と中黒の揺れ）と Kuromoji・ICU の使い方は `search-sizing-poc` で確かめる（**未検証**）。

### 7.2 `content-v<N>`

```json
{
  "mappings": {
    "dynamic": "strict",
    "_routing": { "required": true },
    "_source": { "excludes": ["body", "body_ocr"] },
    "properties": {
      "tenant_id":         { "type": "keyword" },
      "ns_id":             { "type": "keyword" },
      "node_id":           { "type": "keyword" },
      "rev_id":            { "type": "keyword" },
      "ancestor_ids":      { "type": "keyword" },
      "body": {
        "type": "text", "analyzer": "ja_body_morph", "store": false,
        "fields": { "ngram": { "type": "text", "analyzer": "ja_body_bigram" } }
      },
      "body_ocr":          { "type": "text", "analyzer": "ja_body_morph", "store": false },
      "extractor_version": { "type": "keyword" }
    }
  }
}
```

- チームのプランの名前空間の今のリビジョンだけ。本文は `_source` に持たない（抜粋は確かめ直しの後に S3 の抽出のテキストから作る）。
- `body_ocr` は E15 まで空（[ADR-0035](../../decisions/0035-ocr-deferred-to-e15.md)）。
- 照会は必ず `terms: {ns_id: [読める名前空間]}` で絞り、返す前に Aurora で確かめ直す。

## 8. AppConfig と端末の鍵の保管庫

### 8.1 AppConfig

フラグと決めた値。名前の規則は `release.*` が kebab-case、`ops.*` が snake_case（[delivery.md](../delivery.md) の 3 節）。同期・名前・権限の規則をフラグにしない。

| 名前空間 | 鍵 | 中身 |
| --- | --- | --- |
| `release.*` | `release.admin-member-access`、`release.eager-thumbnails`、`release.fulltext-extraction`、`release.mobile-push`、`release.shared-links-public`、`release.small-block-packing` | 未完成・法務の確認待ちの振る舞い |
| `ops.*` | `ops.writes_enabled`、`ops.uploads_enabled`、`ops.block_gc_enabled`、`ops.block_gc_rate`、`ops.client_upload_concurrency`、`ops.upload_admission_global_bps`、`ops.upload_admission_tenant_bps`、`ops.ns_commit_rate_limit`、`ops.preview_formats_enabled`、`ops.search_enabled` | 運用の止め・絞り |
| `client.*` | `client.min_supported_version`、`client.blocked_versions`、`client.rollout` | クライアントの配布 |
| 構成 | `content_scan_policy`（検査ごとに `none`・`link_public`・`all_uploads`。法務の L1・L2 まで `none`） | 中身の検査の範囲。変更は `platform_audit_events` |

- `GET /v1/config` は、受ける `chunker_version` の一覧、今の `names_version`、最低のバージョンを返す（サーバーのコードのバージョンで決まり、フラグではない）。

### 8.2 端末の OS の鍵の保管庫

| 項目 | デスクトップ | モバイル |
| --- | --- | --- |
| 端末の鍵（Ed25519 の秘密鍵） | macOS のキーチェーン（書き出せない設定）、Windows の DPAPI | iOS のキーチェーン、Android Keystore |
| 更新トークン | 同上 | 同上 |
| プロキシの資格 | 同上 | — |
| オフラインのファイルの鍵 | — | 同上（切り離しで消すと読めなくなる） |

- アクセストークンはメモリーだけに持つ。ローカルの状態の DB にトークン・鍵を書かない（[client-local-db.md](client-local-db.md)）。

# Data model: Figma

データモデルの索引。すべての置き場所（Aurora・DynamoDB・S3・Valkey・SQS・AppConfig・ブラウザ）と、横断の規則、複数の領域が列を足す表の統合した定義を書く。**各表・各キーの定義の正本は、索引の「定義の場所」にある文書** で、ここには置き場所と、統合した定義（5 節）だけを書く。実装の変更（`changes/`）でマイグレーションを書くときに、ここと各文書を合わせて更新する。

テナントの分け方は [ADR-0005](../decisions/0005-tenancy-and-document-routing.md)、ファイルの中身の置き場所は [ADR-0003](../decisions/0003-journal-and-checkpoints.md)・[ADR-0024](../decisions/0024-journal-items-and-fencing.md)・[ADR-0025](../decisions/0025-content-addressed-checkpoints-and-loading.md)、大阪への切り替えの世代は [ADR-0048](../decisions/0048-osaka-dr-with-journal-generations.md)、ファイルの中身の形は [document-model.md](document-model.md) に従う。

2026-09-27 の統合の工程で、全領域の文書の「data-model への項目」と照合した。統合で決めたこと（重なりの解消、名前の規則、キーの形）は 11 節にまとめた。

## 1. 置き場所

| 置き場所 | 中身 | 正本か |
| --- | --- | --- |
| Aurora PostgreSQL 18（`app` スキーマ、FORCE RLS） | メタデータ：組織、チーム、プロジェクト、ファイルの一覧、権限、共有、コメント、通知、版の一覧、画像・フォントの台帳、ジョブ、監査ログ | メタデータの正本 |
| Aurora（`global` スキーマ、RLS の外） | アカウント、セッション、利用者の設定、プラグイン、OAuth のアプリ、運用者の監査 | 同上 |
| Aurora（`realtime` スキーマ、RLS の例外） | 無効化の outbox | 一時的（1 分） |
| DynamoDB | ジャーナル（とフェンス）、ファイルの割り当て、タスクの生存 | ファイルの中身（チェックポイントより後）と持ち主の正本 |
| S3（files） | チェックポイント（マニフェストとチャンク）、大きな変更、取り戻した版 | ファイルの中身の正本 |
| S3（assets） | 画像、フォント、書き出し、サムネイル、コメントの添付 | バイト列の正本 |
| S3（その他） | プラグインのコード（E14）、ライブラリの資産（E13）、監査のアーカイブ、WASM の名前の表 | — |
| Document Server のメモリ | 開いたファイルの今の状態、セッションの表、直近の確定した変更 | 正本ではない（落ちたら上から戻す） |
| Valkey | チケットの `jti`、持ち主のキャッシュ、レート制限、Realtime の問い合わせのキャッシュと pub/sub | 正本ではない |
| SQS | Worker のジョブ | 正本ではない（outbox と表から作り直せる） |
| OpenSearch（延期） | ファイルの中身の検索の索引 | 正本ではない |
| ブラウザ | IndexedDB（チャンクのキャッシュ、プラグインの保存）、Cache Storage（フォント・画像）、`localStorage`（UI の設定） | 正本ではない |
| AppConfig | フラグ、書き込みを受けるリージョンと世代、`min_client_build`、GPU のブロックリスト | 設定の正本 |
| 開発リポジトリ | `schema/properties.toml`（プロパティの表）、`schema/history.json`（`schema_hash` の履歴）、`fonts/catalog.toml` | 定義の正本 |

## 2. 横断の規則

- **テナントの表**は、すべて `org_id` を持ち、主キーと索引の先頭に置き、`FORCE ROW LEVEL SECURITY` を付ける。トランザクションごとに `SET LOCAL app.org_id`（ADR-0005）。組織の外の人（ゲスト、リンクを知っている人）は、ファイルを持つ組織の文脈で読む。
- **1 つのトランザクションで、複数の `org_id` の行を書かない**（S3 で横に分けるための規則。ADR-0005）。
- **`global` スキーマ**：組織をまたぐもの。アプリの `app` ロールからは、`account_id` で絞る専用の関数を通して読む（3.2 節）。
- **ID**：内部の ID は UUIDv7。ファイルは内部の ID と別に、128 ビットの乱数の `file_key`（base62、22 文字）を持ち、URL・共有のリンク・公開 API・チケットの外側では内部の ID を出さない（[permissions-and-sharing.md](permissions-and-sharing.md) の 8 節）。ノードの ID は `(session_id, local_id)`、文字列では `"{session_id}:{local_id}"`（[ADR-0007](../decisions/0007-node-ids-and-tree-invariants.md)）。
- **S3 のキー**：ファイルの中身（`files/{file_id}/…`）は `org_id` をキーに入れない（ファイルを別の組織へ移してもオブジェクトを動かさない。[file-storage-and-history.md](file-storage-and-history.md) の 3 節）。組織ごとに重複を除く資産は `{種類}/{org_id}/…` の形にする（6.2 節）。
- **CDN の署名**：チャンク・画像・フォント・サムネイルの署名付き URL の署名は、キャッシュの鍵に含めない。キャッシュのオブジェクトは中身のハッシュで名付けた不変のもので、パスに組織かファイルを含む（[permissions-and-sharing.md](permissions-and-sharing.md) の 11 節）。
- **中身の分離**：ファイルの名前・ノードの名前・テキスト・コメントの本文を、ログ・メトリクス・監査ログ・通知の行・ジョブのエラーに入れない。ID と大きさだけ（[AGENTS.md](../../AGENTS.md)）。
- **削除は両方のリージョンで**：S3 の版を指定した削除とライフサイクルの動作は大阪へ複製されない。削除のジョブ・掃除・mark-and-sweep・ライフサイクルは、東京と大阪の両方のバケットで行う。DynamoDB の削除はグローバルテーブルが伝える（[ADR-0045](../decisions/0045-audit-log-and-data-lifecycle.md)）。
- **世代**：大阪への切り替えのたびに世代を上げ、世代 2 以降のジャーナルのパーティションキーとマニフェスト・大きな変更のキーに `g{n}` を入れる。チャンクは世代で分けない（ADR-0048）。
- 本家の名前を、表・キー・バケット・ドメインの名前に使わない。`<brand>` で書く（リポジトリ共通の [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。

## 3. Aurora の表

### 3.1 テナントの表（`app`、`org_id`、FORCE RLS）

| 表 | 中身 | Epic | 定義の場所 |
| --- | --- | --- | --- |
| `orgs` | プラン、確認済みのドメイン、方針（公開の禁止、シートの承認、`client_cache`、`session_max_age`、メールのプレビュー）、`acl_version` | E1・E9 | [permissions-and-sharing.md](permissions-and-sharing.md) の 16 節、[security.md](security.md) の 14 節 |
| `org_members` | 役割（`admin`・`member`・`guest`）、シート（`full`・`view`）、無効化、`display_name_norm`・`email_norm` | E1・E9・E11 | permissions-and-sharing.md の 16 節、[search.md](search.md) の 3.1 節 |
| `teams`、`team_members` | チーム、可視性（`open`・`closed`・`secret`）、参加。`teams.name_norm` | E1・E9 | permissions-and-sharing.md、search.md |
| `projects` | プロジェクト（本家の「フォルダー」に当たる。呼び名は intent.md の Open questions）、`name_norm` | E1・E9 | 同上 |
| `files` | ファイルの一覧。5.1 節の統合した定義 | E1・E7・E11 | 5.1 節 |
| `resource_roles`、`general_access` | 役割、一般アクセス、期限、`previous_*`、`viewers_can_copy_share_export` | E9 | permissions-and-sharing.md の 4.3 節 |
| `invitations`、`access_requests`、`seat_requests` | 招待（トークンのハッシュ）、申請 | E9 | permissions-and-sharing.md の 16 節 |
| `file_versions` | 版の一覧。5.2 節 | E7 | 5.2 節 |
| `file_storage_jobs` | 掃除・完全な削除・複製・復元・回復・取り戻しのジョブ。5.3 節 | E7・E12 | 5.3 節 |
| `file_visits` | 最近のファイル（1 人 500 件） | E11 | search.md の 3.1 節 |
| `comment_threads`、`comments`、`comment_attachments`、`comment_reactions`、`comment_mentions`、`comment_read_states`、`file_comment_subscriptions` | コメント | E8 | [comments-and-notifications.md](comments-and-notifications.md) の 3.1 節 |
| `notifications`、`email_digest_queue`、`org_notification_policies` | 通知（90 日）、メールのまとめ | E8 | comments-and-notifications.md の 4 節・11 節 |
| `images` | 画像の台帳（主キー `(org_id, sha256)`、`status`） | E10 | [export-and-assets.md](export-and-assets.md) の 16 節 |
| `org_fonts` | 組織・チームのフォント（`fs_type`、権利の確認の記録） | E10 | 同上 |
| `export_jobs`、`file_thumbnails` | 書き出し（公開 API の `/images` も `source = api`）とサムネイル | E10・E15 | 同上 |
| `audit_events` | 監査ログ（月のパーティション、1 年） | E9 | [security.md](security.md) の 6 節 |
| `legal_holds` | リーガルホールド | E12 | security.md の 7 節 |
| `org_sso_configs` | 組織の SSO（E12。MVP の範囲の外） | E12 | security.md の 14 節 |
| `libraries`、`library_versions`、`library_assets`、`file_library_links` | ライブラリ | E13 | [components-and-libraries.md](components-and-libraries.md) の 12 節 |
| `org_plugin_policies`、`org_plugin_allowlist` | プラグインの組織の方針 | E14 | [plugins.md](plugins.md) の 9 節 |
| `oauth_grants`、`api_tokens`、`webhooks`、`webhook_deliveries`（7 日）、`idempotency_keys`（24 時間） | 公開 API と Webhook | E15 | [api-and-webhooks.md](api-and-webhooks.md) の 14 節 |

### 3.2 グローバルの表（`global`、RLS の外）

| 表 | 中身 | 読み方 | 定義の場所 |
| --- | --- | --- | --- |
| `accounts`、`sessions`、`passkeys`、`verification_codes` | 認証（Better Auth。Slack と同じ形） | 認証の部品だけ | [security.md](security.md) の 4 節 |
| `user_preferences` | 利用者の編集の設定（組織をまたぐ）：`account_id`、`nudge_small`、`nudge_large`、`snap_to_pixel_grid`、`snapping_enabled`、`updated_at` | `account_id` で絞る関数 | [editor-and-tools.md](editor-and-tools.md) の 20 節 |
| `operator_audit_events` | 運用者の操作（サポートの復元・複製、取り下げ、break-glass） | 運用者の画面 | security.md の 6 節 |
| `plugins`、`plugin_versions`、`plugin_reviews`、`plugin_blocklist` | プラグイン（E14） | API | [plugins.md](plugins.md) の 9 節 |
| `oauth_apps` | OAuth のアプリ（E15） | API | [api-and-webhooks.md](api-and-webhooks.md) の 14 節 |

### 3.3 RLS の例外

ここと 3.2 節にない表は、すべて `org_id` と FORCE RLS を持つ。足すときは、この表と security.md を合わせて更新し、Dev のテックリードの承認を得る。

| 表 | 理由 | 読み書きする主体 | 定義の場所 |
| --- | --- | --- | --- |
| `realtime.realtime_invalidations` | invalidator が組織をまたいで読む。中身は ID のキーだけで、テナントのデータを持たない。1 分で消す | トリガーの関数（`SECURITY DEFINER`）と invalidator の専用のロールだけ。`app` ロールには権限を与えない | [comments-and-notifications.md](comments-and-notifications.md) の 11 節（Slack の ADR-0027 と同じ形） |

## 4. DynamoDB

| 表 | キー | 中身 | 複製 | 定義の場所 |
| --- | --- | --- | --- | --- |
| `journal` | PK `pk`（世代 1 は `{file_id}`、世代 `g ≥ 2` は `{file_id}#g{g}`）、SK `seq` | `seq = 0` はフェンス（`epoch`、`owner`、`fenced_at`。世代 2 以降は `base_gen`・`base_end_seq`）。`seq ≥ 1` はまとまり（`end_seq`、`epoch`、`fmt`、`body` か `blob_key`、`body_sha256`、`bytes`、`written_at`、`ttl` = 書いた時点＋30 日）。本体の `JournalBatch` は各変更の `seq`・`session_id`・`client_seq`・`origin`・`ops`・`server_ops` と `session_opens` | グローバル（MREC、大阪） | [file-storage-and-history.md](file-storage-and-history.md) の 4.1 節、[ADR-0024](../decisions/0024-journal-items-and-fencing.md)、[ADR-0048](../decisions/0048-osaka-dr-with-journal-generations.md) |
| `file_leases` | PK `file_id`。疎な GSI `by_owner`（`gsi_owner`） | 割り当て：`state`（`owned`・`handoff`・`released`・`deleted`）、`owner_task`、`owner_incarnation`、`epoch`、`region_gen`、`assigned_at`、`released_at`、`released_seq`、`recover_only`。`deleted` だけ TTL 400 日 | グローバル（MREC） | [infrastructure.md](infrastructure.md) の 5.1 節、[ADR-0047](../decisions/0047-router-task-liveness-and-file-assignment.md) |
| `ds_liveness` | PK `task_id` | タスクの生存（`incarnation`、`pool`、`az`、`addr`、`state` = `active`・`draining`・`full`、`expires_at_ms`）と負荷（ファイルの数、メモリの使用と予算、接続の数）。TTL は期限＋1 日 | リージョンごと（複製しない） | infrastructure.md の 5.1 節、ADR-0047、[ADR-0051](../decisions/0051-document-server-memory-admission.md) |

- 3 つともオンデマンド。`journal` は warm throughput で書き込み毎秒 5 万単位に温め、PITR 35 日（[ADR-0052](../decisions/0052-journal-throughput-and-hot-file-budget.md)、[capacity.md](capacity.md) の 4 節）。
- ファイルごとのリースを延ばす形（ADR-0005 の最初の案）は採らない。延ばすのはタスクの生存だけ（ADR-0047）。

## 5. 統合した定義

### 5.1 `files`

複数の領域が列を足していた（統合の前は permissions-and-sharing・file-storage-and-history・search に分かれていた）。1 つの定義にまとめ、列ごとに持ち主の領域を書く。持ち主の領域の文書は、この節を指す。

| 列 | 型 | 持ち主 | 中身 |
| --- | --- | --- | --- |
| `org_id` | uuid | permissions | ファイルを持つ組織。RLS の鍵 |
| `id` | uuid（v7） | permissions | 内部の ID。外に出さない |
| `file_key` | text（22） | permissions | URL・公開 API の鍵。128 ビットの乱数の base62。一意 |
| `name` | text | permissions | ファイルの名前（ログに書かない） |
| `name_norm` | text | search | `normalizeForSearch(name)`（[search.md](search.md) の 3.1 節） |
| `project_id` | uuid、null 可 | permissions | 下書きは null |
| `team_id` | uuid、null 可 | search | プロジェクトのチーム（非正規化。移動で書き換える）。名前の検索の候補の段に使う（search.md の 3.2 節）。下書きは null |
| `owner_account_id` | uuid | permissions | 所有者（`owner` の水準）。移譲で変わる |
| `state` | enum | file-storage | `creating`・`active`・`maintenance`・`trashed`・`purging`・`purged`（下の遷移） |
| `maintenance_reason`、`maintenance_since` | enum、timestamptz | file-storage・security | `operator`・`journal_gap`・`invariant_violation`（`maintenance` のときだけ） |
| `trashed_at`、`trashed_by`、`purged_at` | timestamptz、uuid | file-storage | ゴミ箱と完全な削除（[file-storage-and-history.md](file-storage-and-history.md) の 11 節） |
| `checkpoint_seq`、`checkpoint_key` | bigint、text | file-storage | 最新のチェックポイントの `seq` とマニフェストのキー（世代を含む） |
| `node_count`、`size_bytes` | int、bigint | file-storage | 最新のチェックポイントのノードの数と、圧縮の前の大きさ。Router のメモリの見積もり（ADR-0051）と、ファイルの大きさの区分に使う |
| `source_file_id`、`source_version_id` | uuid、null 可 | file-storage | 複製の元 |
| `created_by`、`created_at`、`last_edited_at` | uuid、timestamptz | file-storage | 一覧の並び。`last_edited_at` はチェックポイントのときに進める |

- 索引：`(org_id, file_key)` 一意、`(org_id, last_edited_at DESC)`、`(org_id, project_id)`、`(org_id, owner_account_id) WHERE project_id IS NULL`。
- `purged` の行は `id`・`org_id`・`purged_at` だけを残し、他の列を消す（監査のため）。
- `state` の遷移：`creating → active`（作成・複製の完了）、`active ⇄ maintenance`（運用者、ジャーナルの飛び、不変条件の破れ）、`active ⇄ trashed`（`owner`）、`trashed → purging → purged`（完全な削除のジョブ）。`maintenance` の間、API は閲覧のチケットだけを出し（判定の上限）、`acl.changed` で開いている接続を読み取りに下げる。`journal_gap` のときは、Document Server も読み込まない（[runbooks/incident-response.md](../runbooks/incident-response.md) の「ファイルの編集を止める」）。

### 5.2 `file_versions`

| 列 | 中身 |
| --- | --- |
| `org_id`、`file_id`、`id` | |
| `kind` | `auto`・`named`・`restore_before`・`restore_after`・`dr_salvaged`（[file-storage-and-history.md](file-storage-and-history.md) の 8.1 節、ADR-0048） |
| `seq`、`region_gen` | 版の `seq` と、その `seq` の世代 |
| `manifest_key` | マニフェストのキー（`dr_salvaged` は 6.1 節の `salvage/` の下） |
| `name`、`description` | 名前付きの版（ログに書かない） |
| `created_by`、`created_at`、`delete_after` | `delete_after` は無料のプランの保持（30 日。PM の決定待ちの既定案） |

### 5.3 `file_storage_jobs`

| 列 | 中身 |
| --- | --- |
| `org_id`、`id`、`file_id` | |
| `kind` | `gc`・`purge`・`duplicate`・`restore`・`orphan_recovery`・`dr_salvage` |
| `step`、`region` | 手順と、その手順を行うリージョン（`purge` と `gc` は東京と大阪を別の手順として記録し、大阪が止まっていれば後から流す） |
| `state`、`attempts`、`next_run_at`、`last_error` | `last_error` に中身を含めない |

## 6. S3 のキー

### 6.1 files バケット（`<brand>-files-{env}-{region}`）

| キー | 中身 | 定義の場所 |
| --- | --- | --- |
| `files/{file_id}/checkpoints/{seq:020}` | マニフェスト（世代 1） | [document-model.md](document-model.md) の 8.2 節、[file-storage-and-history.md](file-storage-and-history.md) の 5 節 |
| `files/{file_id}/checkpoints/g{g}/{seq:020}` | マニフェスト（世代 `g ≥ 2`） | [ADR-0048](../decisions/0048-osaka-dr-with-journal-generations.md) |
| `files/{file_id}/chunks/{sha256}` | ページ・セッション・参照の一覧のチャンク（zstd。世代で分けない。ファイルの外と共有しない） | document-model.md の 8.2 節、[ADR-0025](../decisions/0025-content-addressed-checkpoints-and-loading.md) |
| `files/{file_id}/journal-blobs/{start_seq}-{epoch}`、`…/journal-blobs/g{g}/{start_seq}-{epoch}` | 350 KiB を超える大きな変更の本体（世代 1・世代 2 以降） | file-storage-and-history.md の 4.3 節、ADR-0048 |
| `files/{file_id}/salvage/g{g}/{seq:020}` | `dr-salvage` が取り戻した版のマニフェスト（`g` は元の世代）。今の世代の `seq` と重ならないよう、別の接頭辞に置く（11 節） | ADR-0048、infrastructure.md の 7.2 節 |

- バージョニング（古い版は 30 日）、SSE-KMS（`files` の鍵）、東京 → 大阪のレプリケーション（RTC）。ライフサイクルは両方のバケットに置く。
- 配信は `files.<brand>usercontent.<domain>` の CloudFront（署名付き URL、5 分）。

### 6.2 assets バケット（`<brand>-assets-{env}-{region}`）

| キー | 中身 | 定義の場所 |
| --- | --- | --- |
| `images/{org_id}/{sha256}`、`images/{org_id}/{sha256}/w{2048,512,128}.webp` | 画像と縮小版 | [export-and-assets.md](export-and-assets.md) の 16 節、[ADR-0035](../decisions/0035-content-addressed-images.md) |
| `fonts/catalog/{sha256}`、`fonts/{org_id}/{sha256}` | 同梱のフォント（署名なし、`immutable`）、組織のフォント | 同上、[ADR-0036](../decisions/0036-font-sources-and-licensing.md) |
| `exports/{org_id}/{job_id}/…` | サーバーの書き出しの結果（14 日） | 同上 |
| `thumbnails/{org_id}/{file_id}/{seq}-{960,320}.webp` | サムネイル | 同上 |
| `comment-attachments/{org_id}/{file_id}/{asset_id}` | コメントの添付（1 つ 10 MB、PNG・JPEG・GIF） | [comments-and-notifications.md](comments-and-notifications.md) の 11 節 |

- 配信は `assets.<brand>usercontent.<domain>` の CloudFront（署名付き URL は 15 分、書き出しの結果は 24 時間）。応答のヘッダーは `nosniff`・`CSP: sandbox`。

### 6.3 その他

| キー | 中身 | 定義の場所 |
| --- | --- | --- |
| `plugins/{plugin_id}/{version_id}/{sha256}` | プラグインのコード（不変。E14） | [plugins.md](plugins.md) の 9 節 |
| `libraries/{org_id}/{library_id}/assets/{asset_key}/{content_hash}` | ライブラリの資産の blob（E13） | [components-and-libraries.md](components-and-libraries.md) の 12 節 |
| log-archive `audit/{org_id}/{yyyy}/{mm}/…` | 監査のアーカイブ（Object Lock、7 年の既定案） | [security.md](security.md) の 14 節 |
| shared `wasm-symbols/{build_id}/…` | ビルドごとの関数の名前の表 | [observability.md](observability.md) の 10 節 |

## 7. SQS・Valkey・OpenSearch・AppConfig

| 置き場所 | 名前 | 中身 | 定義の場所 |
| --- | --- | --- | --- |
| SQS | `image-ingest`、`font-ingest`、`render-export`、`render-thumbnail` | 取り込みと描画のジョブ | [export-and-assets.md](export-and-assets.md) の 16 節 |
| SQS | `notify`、メール、`search-index`（延期）、`file_storage_jobs` のキュー | Worker のジョブ | comments-and-notifications.md、search.md、file-storage-and-history.md |
| SQS | `webhook-delivery` | Webhook の配送（E15） | [api-and-webhooks.md](api-and-webhooks.md) の 14 節 |
| Valkey（チケットとレート制限） | 使ったチケットの `jti`、レート制限の数え | 能力のチケットの使い回しの拒否、利用者・組織・トークンの制限 | [permissions-and-sharing.md](permissions-and-sharing.md) の 5.4 節、api-and-webhooks.md の 5 節 |
| Valkey（キャッシュ） | `owner:{file_id}` | 持ち主のキャッシュ（30 秒） | [infrastructure.md](infrastructure.md) の 5.2 節 |
| Valkey（pub/sub。クラスタモードを使わない） | Realtime の問い合わせのキャッシュ、無効化の pub/sub | | comments-and-notifications.md の 5.2 節 |
| OpenSearch（延期） | `file_pages`（`routing = org_id`） | 中身の検索 | [search.md](search.md) の 4 節 |
| AppConfig | フラグ（`release.ui.*`・`release.doc.*`・`schema.<prop>.write`・`ops.*`）、`region.writable`・`region.gen`、`min_client_build`、`client_build_channels`、GPU のブロックリスト | | [delivery.md](delivery.md) の 6 節、infrastructure.md の 10 節、[rendering-engine.md](rendering-engine.md) の 19 節 |

## 8. ブラウザ

| 置き場所 | 中身 | 定義の場所 |
| --- | --- | --- |
| IndexedDB `chunks` | ハッシュ → 圧縮したチャンク（利用者ごと、500 MB、読むときにハッシュを確かめる、ログアウト・権限の喪失で消す。組織の方針 `client_cache`） | [file-storage-and-history.md](file-storage-and-history.md) の 6.3 節、[security.md](security.md) の 5.3 節 |
| IndexedDB `plugin_client_storage` | `(user_id, plugin_id)` ごと 5 MiB（E14） | [plugins.md](plugins.md) の 7 節 |
| Cache Storage | フォントと画像の圧縮したバイト列（鍵はハッシュ。GPU の資源の作り直しに使う） | [rendering-engine.md](rendering-engine.md) の 19 節 |
| `localStorage` | 前のセッションの GPU のバックエンドと切り替えの理由（7 日）、最後に使ったツール、パネルの設定 | rendering-engine.md、[editor-and-tools.md](editor-and-tools.md) の 20 節 |

- 未確定の変更は、端末に保存しない（MVP。[multiplayer.md](multiplayer.md) の 17 節）。

## 9. ファイルの中身（ドキュメントのモデル）

ファイルの中身の形は、表ではなくプロパティの表（開発リポジトリの `schema/properties.toml`）で定義する。

| 項目 | 定義の場所 |
| --- | --- |
| ノードの種類、プロパティの表、値の型、表の列（`public_api`・`api_name`・`api_since`・`public_plugin` を含む） | [document-model.md](document-model.md) の 3・4 節 |
| 変更の操作と `ChangeSet`（`origin` を含む） | document-model.md の 7 節 |
| チェックポイントのマニフェスト（`features` を含む）とチャンク | document-model.md の 8.2 節 |
| セッションの表（`sessions_chunk`） | [multiplayer.md](multiplayer.md) の 4.4 節 |
| ジャーナルのまとまり（`JournalBatch`） | [file-storage-and-history.md](file-storage-and-history.md) の 4.1 節 |
| レイアウトの結果（`derived_layout`）と書き手の規則 | [layout.md](layout.md) の 4 節、document-model.md の 9.2 節 |
| コンポーネント・インスタンス・上書き | [components-and-libraries.md](components-and-libraries.md) の 3 節 |
| 画像・フォントの参照（`blob_refs_chunk`） | document-model.md の 9.5 節 |
| スキーマの履歴（`schema/history.json`） | [delivery.md](delivery.md) の 4.2 節 |

統合の工程で表に登録した、各領域の提案（番号は document-model.md の 4.2 節）：

| 番号 | プロパティ | 持ち主 |
| --- | --- | --- |
| 18〜39 | `layout_wrap`・`counter_axis_spacing`・`counter_axis_align_content`・`strokes_included_in_layout`・`item_reverse_z_index`・`min_width`・`max_width`・`min_height`・`max_height` を足した | layout |
| 64〜68 | `component_prop_values`・`component_prop_refs`・`publish_key`・`publish_hidden`・`removed_at` | components |
| 90 | `plugin_data`（予約。E14） | plugins |
| 91 | `thumbnail_node` | export-and-assets |
| 92 | `cjk_fallback_font` | rendering-engine |

## 10. 保持

保持と削除の期間は [security.md](security.md) の 7 節に表で持つ（法務の確認待ち、[intent.md](../intent.md) の L4）。ジャーナルは書いた時点から 30 日（TTL）、チェックポイントは 48 時間はすべて・30 日までは 1 日 1 つ、版は無料のプランで 30 日・有料ですべて、書き出しの結果は 14 日、通知は 90 日、監査ログは Aurora に 1 年・アーカイブに 7 年、バックアップ（PITR）は 35 日。

## 11. 統合で決めたこと（2026-09-27）

| 論点 | 決定 |
| --- | --- |
| `files` の列が 3 つの領域に分かれていた | 5.1 節の 1 つの定義にまとめ、列ごとに持ち主を書いた。各領域の文書の data-model の節は、この節を指す |
| Router の表：file-storage-and-history.md は `file_leases` を「ADR-0005 のリース」とし、ADR-0005 はファイルごとのリースの延長の例を示していた | ADR-0047 の「タスクの生存（`ds_liveness`）＋ファイルの割り当て（`file_leases`）」に揃え、ADR-0005・README・file-storage-and-history.md・multiplayer.md を書き換えた |
| ジャーナルとマニフェストのキーに、世代 2 以降の形がなかった | 4 節と 6.1 節に `{file_id}#g{g}`・`checkpoints/g{g}/` を足し、file-storage-and-history.md の 4.1・5 節も揃えた |
| file-storage-and-history.md の 11.2 節の「大阪の複製は削除が伝わる」は S3 では成り立たない | 完全な削除・掃除・mark-and-sweep（export-and-assets.md の 6.5 節）・ライフサイクルを両方のバケットで行う（ADR-0045）。`file_storage_jobs.region` で手順を分けて記録する |
| `user_preferences` の RLS の扱い | `global` スキーマに置き、`account_id` で絞る関数を通す（3.2 節） |
| コメントの添付のキーの形（`orgs/{org_id}/files/{file_id}/…`）が他の資産と違った | `comment-attachments/{org_id}/{file_id}/{asset_id}` に揃えた（6.2 節） |
| 大阪への切り替えで取り戻した編集の版の種類 | `file_versions.kind` に `dr_salvaged` を足した（ADR-0048 の提案） |
| 取り戻した版のマニフェストの置き場所が決まっていなかった | `files/{file_id}/salvage/g{g}/{seq:020}`。取り戻した `seq` は今の世代の `seq`（`base_end_seq + 1` から続く）と重なりうるので、`checkpoints/` と分けた |
| ジャーナルの飛び・不変条件の破れ・運用者の停止で使うファイルの状態 | `files.state = maintenance` と `maintenance_reason` を足した（5.1 節）。runbook の「ファイルの編集を止める」を揃えた |
| ChangeSet の `origin`（plugins の提案）、マニフェストの `features`（delivery の提案）、表の列 `public_api`・`api_name`・`api_since`・`public_plugin`（api-and-webhooks・plugins の提案） | すべて document-model.md に取り込んだ（9 節） |
| CDN の署名とキャッシュの鍵（permissions-and-sharing.md は「含める」、export-and-assets.md は「含めない」） | 含めない。署名付き URL は取得を許すもので、キャッシュのオブジェクトは中身のハッシュで名付け、パスに組織かファイルを含むので、組織をまたいで共有されない（2 節） |

残り（マイグレーションを書く Story で確かめる）：

- すべてのテナントの表に RLS があり、3.2・3.3 節の例外が網羅されていることを、マイグレーションの CI の許可リストと照合する（E1）。
- `files.team_id` の非正規化を、プロジェクトの移動とチームの削除で書き換える手順（E9・E11）。
- `file_versions.delete_after` の既定（無料のプラン 30 日）は PM の決定待ち（intent.md の Open questions）。

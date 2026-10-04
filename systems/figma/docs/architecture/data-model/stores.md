# Data model: DB の外のストアとペイロード

[data-model.md](../data-model.md) の一部。Valkey のキー、S3 のキー、SQS のジョブ、outbox の出来事、Webhook の封筒、OpenSearch の文書、AppConfig、ブラウザの保存の形をまとめる。DynamoDB の項目は [file-storage.md](file-storage.md) の 3 節、チェックポイントとジャーナルの本体の形は [document.md](document.md) の 5 節にある。

## 1. 共通の規則

- **組織の外に出る名前には `org_id` か `file_id` を含める**（data-model.md の I-10）。含めないのは、組織が決まる前に引くもの（チケットの `jti`、再開のトークンの `rid`、セッションの印）と、組織に属さないもの（同梱のフォント、プラグインのコード）だけ。その場合も、値の中に `org_id`・`file_id` を持たせ、使う側で照らす。
- **ファイルの中身（ノードの名前、テキスト、画像、ファイルの名前、コメントの本文）を、キー・チャンネルの名前・ペイロードに入れない。** 入れてよいのは ID・ハッシュ・大きさ・数。例外は S3 の中身そのもの（チェックポイント、画像、書き出しの結果）。
- この文書では、名前の中の可変の部分を `{org_id}` のように書く。ID は UUID の小文字の文字列、ハッシュは 16 進の小文字。
- Valkey は用途ごとに 3 つのクラスタ（どれもクラスタモードを使わない。[infrastructure.md](../infrastructure.md) の 6 節）：`vk-auth`（チケットとレート制限）、`vk-cache`（キャッシュ）、`vk-pubsub`（pub/sub）。

## 2. Valkey

### 2.1 キー

| クラスタ | キー | 型 | TTL | 中身 | 書く / 読む | 定めた場所 |
| --- | --- | --- | --- | --- | --- | --- |
| `vk-auth` | `jti:{jti}` | string | 90 秒（チケットの 60 秒＋時計のずれ） | `1`。`SET NX` で使い回しを拒む | Gateway | [permissions-and-sharing.md](../permissions-and-sharing.md) の 5.4 節 |
| `vk-auth` | `rid:{rid}` | string | 60 秒 | `1`。再開のトークンの使い回しの拒否 | Gateway | 同 5.5 節 |
| `vk-auth` | `acl_version:{org_id}` | string | 1 日 | 組織の最新の `acl_version`。`acl.changed` を受けた Gateway が大きいときだけ書く（Lua で比べる） | Gateway / Gateway | 同 5.5 節 |
| `vk-auth` | `revoked_session:{session_id}` | string | 2 分 | `1`。取り消したログインのセッションの印 | Gateway / Gateway | 同 5.5 節、ADR-0043 |
| `vk-auth` | `rl:{scope}:{subject}:{limit}` | string | 窓＋バースト | トークンバケットの状態（GCRA の `TAT`）。`scope` は `acct`・`org`・`token`・`app`・`ip` | API・Worker | [api-and-webhooks.md](../api-and-webhooks.md) の 5 節、Slack の rate-limiting |
| `vk-auth` | `px:{token_id}` | string | 1 分 | `/v1/images` の画素の予算（利用者×アプリで 1 分 200 メガピクセル） | API | 同 5 節 |
| `vk-auth` | `wh_inflight:{webhook_id}` | sorted set | 要素ごとの期限 | 同時に送る配送（上限 10。スコアは期限） | webhook Worker | 同 6.4 節 |
| `vk-auth` | `fetch:{acct\|org}:{id}` | string | 1 分 | `asset-fetch` の回数（利用者 30・組織 300） | API | [export-and-assets.md](../export-and-assets.md) の 9 節 |
| `vk-auth` | `opened:{org_id}:{account_id}:{file_id}` | string | 1 時間 | 監査ログの `file.opened` の間引きの印 | API | [security.md](../security.md) の 6 節 |
| `vk-cache` | `owner:{file_id}` | hash | 30 秒 | `{task_id, addr, epoch}`。持ち主のキャッシュ | Router / Gateway | [infrastructure.md](../infrastructure.md) の 5.2 節 |
| `vk-cache` | `rtq:{sha256(正規形)}` | string | 60 秒（無効化で消す） | Realtime の単純な問い合わせの結果（行の ID とバージョン）。正規形は表・`org_id`・等価の条件 | Realtime edge | [comments-and-notifications.md](../comments-and-notifications.md) の 5.2 節 |

- 正本ではない。失っても DB と DynamoDB から作り直せる（data-model.md の I-12）。`vk-auth` が止まったら、新しい接続を拒み、再開のトークンを使わない（安全側。[permissions-and-sharing.md](../permissions-and-sharing.md) の 10 節）。
- `rtq:` の値に行の中身を持つか ID だけにするかは、Realtime の edge の実装で決める。中身を持つときも、同じ組織の購読にだけ返す（キーの正規形に `org_id` を含む）。

### 2.2 pub/sub のチャンネル（`vk-pubsub`）

| チャンネル | 流すもの | 出す側 | 購読する側 | 定めた場所 |
| --- | --- | --- | --- | --- |
| `inv:{key}` | 無効化（`realtime_invalidations.key`。例 `inv:comments:{org_id}:file_id={file_id}`） | Realtime invalidator | Realtime edge（購読中の問い合わせのキーだけ） | ADR-0028 |
| `ctl:org:{org_id}` | `acl.changed`・`file.trashed`・`file.maintenance` | Relay | Gateway・Realtime edge | data-model.md の 9.1 節の D-10 |
| `ctl:acct:{account_id}` | `session.revoked` | Relay | Gateway・Realtime edge | ADR-0043 |
| `ctl:global` | `plugin.blocklisted` | Relay | Realtime edge（全クライアントへ） | ADR-0039 |

- Gateway と Realtime edge は、接続のある組織・アカウントのチャンネルだけを購読する。取りこぼしは 5 分ごとの再検証（Gateway）と 60 秒の期限切れ（Realtime）で拾う。
- 在席・カーソルは pub/sub を使わない。Document Server から Gateway のタスクごとに 1 回送る（ADR-0011）。

## 3. S3

バケットの名前は `<brand>-{種類}-{env}-{region}`。東京 → 大阪のレプリケーション（RTC）。**削除とライフサイクルは大阪へ複製されないので、掃除・完全な削除・mark-and-sweep・ライフサイクルは両方のバケットで行う**（ADR-0045）。

| バケット | キー | 中身 | 鍵（KMS） | 保持 | 定めた場所 |
| --- | --- | --- | --- | --- | --- |
| files | `files/{file_id}/…` | チェックポイント・チャンク・大きな変更・取り戻したバージョン | `files` | [file-storage.md](file-storage.md) の 5・6 節 | ADR-0003、ADR-0025、ADR-0048 |
| assets | `images/{org_id}/{sha256}` | 画像（正規化の後）。`Content-Type` は登録の値 | `assets` | mark-and-sweep で消す | ADR-0035 |
| assets | `images/{org_id}/{sha256}/w{2048,512,128}.webp` | 縮小版 | `assets` | 元と同時 | 同上 |
| assets | `fonts/catalog/{sha256}` | 同梱のフォント（署名なし、`immutable`） | `assets` | バージョンを外すまで | ADR-0036 |
| assets | `fonts/{org_id}/{sha256}` | 組織のフォント | `assets` | 削除から 7 日 | 同上 |
| assets | `exports/{org_id}/{job_id}/{node_id}.{ext}`、`exports/{org_id}/{job_id}/bundle.zip` | サーバーの書き出しの結果（`Content-Disposition: attachment`） | `assets` | 14 日（ライフサイクル） | ADR-0034 |
| assets | `thumbnails/{org_id}/{file_id}/{seq}-{960,320}.webp` | サムネイル | `assets` | 置き換えから 7 日。バージョンのものはバージョンと同じ | [export-and-assets.md](../export-and-assets.md) の 8 節 |
| assets | `comment-attachments/{org_id}/{file_id}/{asset_id}` | コメントの添付 | `assets` | コメントの削除・ファイルの完全な削除。行のないものは 24 時間 | [comments-and-notifications.md](../comments-and-notifications.md) の 11 節 |
| assets | `libraries/{org_id}/{library_id}/assets/{asset_key}/{content_hash}` | ライブラリの資産の blob（E13） | `assets` | バージョンを参照するファイルがある間 | [components-and-libraries.md](../components-and-libraries.md) の 12 節 |
| assets | `plugins/{plugin_id}/{version_id}/{sha256}` | プラグインのコード（不変。E14） | `assets` | バージョンがある間 | [plugins.md](../plugins.md) の 9 節 |
| log-archive（別のアカウント） | `audit/{org_id}/{yyyy}/{mm}/{dd}/{batch_id}.jsonl.gz` | 監査ログのバッチ（前のバッチのハッシュを含む） | `logs` | Object Lock（コンプライアンスモード）7 年（既定案。L4） | [security.md](../security.md) の 6 節 |
| log-archive | `operator/{yyyy}/{mm}/{dd}/{batch_id}.jsonl.gz` | 運用者の操作のバッチ | `logs` | 同上 | 同上 |
| shared | `wasm-symbols/{build_id}/…` | ビルドごとの関数の名前の表 | `logs` | ビルドを配っている間＋90 日 | [observability.md](../observability.md) の 10 節 |

- ライブラリの blob とプラグインのコードは、assets バケットに置く（data-model.md の 9.1 節の D-17）。配信の経路（`assets.<brand>usercontent`・`plugin-ui.<brand>usercontent` の `plugin-code`）を CloudFront の振る舞いで分ける。
- 配信：files は `files.<brand>usercontent.<domain>`（署名付き URL 5 分）、assets は `assets.<brand>usercontent.<domain>`（15 分、書き出しの結果は 24 時間）。署名はキャッシュの鍵に含めない。許すメソッドは `GET`・`HEAD` だけ。応答は `nosniff`・`CSP: sandbox`。
- 組織の解約とファイルの完全な削除は、`{種類}/{org_id}/` と `files/{file_id}/` の接頭辞で消す。

## 4. SQS のジョブ

すべて標準キュー＋ DLQ。本文は JSON で、ID と数だけを持つ。Worker は、本文の `org_id` で組織の文脈を設定してから、行を RLS の下で読み直す。

| キュー | 出す側 | 本文 | 受ける側 |
| --- | --- | --- | --- |
| `image-ingest` | S3 のイベント（`images/` の PUT） | S3 のイベントの形（キーから `org_id`・`sha256`） | Worker（`asset-inspect`） |
| `font-ingest` | S3 のイベント（`fonts/{org_id}/` の PUT） | 同上（`org_fonts.id` はオブジェクトのタグ） | Worker |
| `render-export` | API | `{org_id, job_id, file_id, seq}`（設定は `export_jobs.params` を読む） | Render Worker |
| `render-thumbnail` | Document Server、API（バージョン）、通知の Worker（プレビュー） | `{org_id, file_id, seq, kind: current\|version\|comment_preview, version_id?, comment_id?}` | Render Worker |
| `notify` | Relay（`comment.created`・`access_request.created`・`seat_request.created`・`invitation.created`・`library.version_published`） | outbox の出来事（5 節） | 通知の Worker |
| `email` | 通知の Worker（`email_digest_queue` のまとめ） | `{org_id, account_id, file_id, comment_ids[]}` | メールの Worker（SES） |
| `search-index`（延期） | Relay（`file.checkpointed`・`file.moved`・`acl.changed`） | outbox の出来事。`file_id` で 30 分に 1 回へ間引く | 索引の Worker |
| `file-storage-jobs` | スケジューラー、API | `{org_id, job_id}` | 保存の Worker（`file_storage_jobs` の手順を進める） |
| `webhook-delivery` | Relay（`file.edit_idle`・`file.version_created`・`file.deleted`・`comment.created`・`library.version_published`） | `{org_id, event_id, event_type, file_id, …}` | webhook Worker（判定・封筒・署名 → `webhook-egress`） |

## 5. outbox の出来事

`outbox.payload`・`global_outbox.payload` の形。`v` は形のバージョン（追加だけ）。

| `event_type` | 表 | 中身 | 書く場所 | 送り先 |
| --- | --- | --- | --- | --- |
| `acl.changed` | outbox | `{v, org_id, acl_version, file_ids?}`（`file_ids` は分かる範囲） | 権限の変更（[sharing.md](sharing.md)）、移動、ゴミ箱、方針 | `ctl:org`、`search-index` |
| `file.moved` | outbox | `{v, org_id, file_ids? , project_id?}` | 移動 | `search-index` |
| `file.trashed` | outbox | `{v, org_id, file_id}` | ゴミ箱へ | `ctl:org`（Gateway が `Kick(file_deleted)`） |
| `file.deleted` | outbox | `{v, org_id, file_id}` | 完全な削除の開始 | `webhook-delivery` |
| `file.maintenance` | outbox | `{v, org_id, file_id, reason}` | `maintenance` の出入り | `ctl:org` |
| `file.checkpointed` | outbox | `{v, org_id, file_id, seq}` | Document Server のチェックポイントの `files` の更新 | `search-index`（延期） |
| `file.edit_idle` | outbox | `{v, org_id, file_id, seq}` | Document Server（編集が 5 分止まった。1 ファイル 30 分に 1 回） | `webhook-delivery`（`file.updated`） |
| `file.version_created` | outbox | `{v, org_id, file_id, version_id}` | 名前付きのバージョン | `webhook-delivery` |
| `comment.created` | outbox | `{v, org_id, file_id, thread_id, comment_id}` | コメントの書き込み | `notify`、`webhook-delivery` |
| `invitation.created`・`access_request.created`・`seat_request.created` | outbox | `{v, org_id, id}` | 招待・申請 | `notify` |
| `library.version_published` | outbox | `{v, org_id, library_id, version}` | ライブラリの公開（E13） | `notify`、`webhook-delivery` |
| `session.revoked` | global_outbox | `{v, account_id, session_id}` | セッションの取り消し | `ctl:acct` |
| `plugin.blocklisted` | global_outbox | `{v, plugin_id, version_id?}` | 停止のスイッチ（E14） | `ctl:global` |
| `account.anonymized` | global_outbox | `{v, account_id}` | アカウントの匿名化 | 各組織の `org_members` の正規化の列の書き直しのジョブ |

## 6. Webhook の封筒

本文は ID だけ（ADR-0041）。ファイル名・コメントの本文を入れない。

```jsonc
{
  "id": "0192…",                 // event_id（UUIDv7）。受け手は重複の除去に使う
  "type": "file.comment_created",
  "created_at": "2026-09-28T01:23:45Z",
  "webhook_id": "…",
  "context": "file", "context_id": "…",
  "file_key": "3xYk…",           // 内部の file_id は出さない
  "version_id": null,
  "comment_id": "…",
  "triggered_by": "…",           // accounts.id
  "attempt": 1
}
```

- ヘッダー：`<Brand>-Signature: t=<unix 秒>,v1=<HMAC-SHA256(secret, "{t}.{本文}")>`（入れ替えの 24 時間は `v1=` を 2 つ）。
- `webhook_deliveries.envelope` に同じものを保存する。

## 7. OpenSearch（MVP の後）

索引 `file_pages`（`routing = org_id`）。文書の ID は `{file_id}:{page_id}`、外部のバージョンは `seq`。フィールドは [search.md](../search.md) の 4.2 節（`org_id`・`team_id`・`project_id`・`file_id`・`page_id`・`drafts_owner_id`・`general_access_org`・`in_trash`・`node_names`・`texts`・`seq`・`indexed_at`）。ファイルの名前・ページの名前は持たない。

## 8. AppConfig

| 名前 | 中身 | 定めた場所 |
| --- | --- | --- |
| `release.ui.*`・`release.doc.*` | UI のフラグ、文書のフラグ（ファイルごとに Document Server が決める） | [delivery.md](../delivery.md) の 6 節、ADR-0055 |
| `schema.<prop>.write` | プロパティの書き込みの解禁 | ADR-0055 |
| `ops.*` | 運用のスイッチ（`ops.multiplayer_read_only`、公開 API の停止、CDN の迂回など） | [runbooks/README.md](../../runbooks/README.md) |
| `region.writable`・`region.gen` | 書き込みを受けるリージョンと世代 | ADR-0048 |
| `min_client_build`・`client_build_channels` | クライアントのバージョンの照合と段階のリリース | ADR-0053 |
| `gpu.blocklist` | アダプターとブラウザのバージョンの組 → 使うバックエンド | [rendering-engine.md](../rendering-engine.md) の 19 節 |

## 9. ブラウザ

正本ではない。未確定の変更は端末に保存しない（MVP。[multiplayer.md](../multiplayer.md) の 17 節）。

### 9.1 IndexedDB

データベースは利用者ごとに分ける：`<brand>-{account_id}`。ログアウトで削除する。バージョンは `1`。

| object store | 鍵 | 値 | 索引 | 規則 |
| --- | --- | --- | --- | --- |
| `chunks` | `sha256`（16 進） | `{bytes: ArrayBuffer（zstd のまま）, file_id, org_id, size, last_used_at}` | `by_last_used`（`last_used_at`）、`by_file`（`file_id`）、`by_org`（`org_id`） | 合計 500 MB、古い順に外す。読むときにハッシュを確かめ、合わなければ捨てる。権限を失ったファイルは `by_file` で消す。組織の方針 `client_cache` が `session_only` ならタブを閉じたときに、`disabled` なら使わない（[security.md](../security.md) の 5.3 節） |
| `plugin_client_storage` | `[plugin_id, key]` | `{value: 構造化複製できる値, bytes}` | `by_plugin`（`plugin_id`） | プラグインごと 5 MiB（E14。[plugins.md](../plugins.md) の 7 節）。データベースが利用者ごとなので、鍵に `account_id` を入れない |
| `meta` | 名前 | `{total_chunk_bytes, org_policies: {org_id: client_cache}, schema_version}` | — | 追い出しと方針の記録 |

- ファイルの中身（チャンク）は暗号化しない（ADR-0044）。

### 9.2 Cache Storage

| キャッシュ | 鍵 | 中身 |
| --- | --- | --- |
| `fonts-v1` | `fonts/catalog/{sha256}`・`fonts/{org_id}/{sha256}` のパス（署名の引数を除く） | フォントのバイト列 |
| `images-v1` | `images/{org_id}/{sha256}/w{…}.webp` のパス（署名の引数を除く） | 画像の縮小版 |

- 権限を失った後も、端末に残ったキャッシュは消せない（[export-and-assets.md](../export-and-assets.md) の 6.4 節）。ログアウトで両方を消す。

### 9.3 localStorage

| 鍵 | 中身 | 期限 |
| --- | --- | --- |
| `<brand>.gpu` | `{backend: webgpu\|webgl2, reason, at}` | 7 日 |
| `<brand>.editor.last_tool` | ツールの名前 | なし |
| `<brand>.editor.panels` | パネルの幅と開閉 | なし |

## 10. 開発リポジトリの定義のファイル

| ファイル | 中身 | 定めた場所 |
| --- | --- | --- |
| `schema/properties.toml` | プロパティの表（[document.md](document.md) の 3 節と一致させる） | ADR-0006 |
| `schema/history.json` | `schema_hash` の履歴と差分の種類 | [delivery.md](../delivery.md) の 4.2 節 |
| `fonts/catalog.toml` | 同梱のフォントの一覧・バージョン・ライセンス・出典 | [export-and-assets.md](../export-and-assets.md) の 7.2 節 |

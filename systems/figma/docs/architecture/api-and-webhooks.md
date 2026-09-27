# API and webhooks: Figma

公開の REST API、OAuth のアプリと個人のアクセストークン、レート制限、Webhook、版と廃止。**MVP の後に作る**（[intent.md](../intent.md) の「MVP の後に扱う」。内部の API とドキュメントのモデルが安定してから公開する）。

本家の API の形（リソース、スコープ、tier の制限、Webhook の文脈と種類）に寄せる。名前・ヘッダー・接頭辞・ドメインは本家のものを使わない（リポジトリ共通の [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。本家の SDK との互換は目的にしない。

この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0040](../decisions/0040-public-rest-api-surface.md) | 公開 API は `api.<domain>` の別のサービスにし、利用者の権限とスコープの積で動く。ファイルの中身は Rust の読み取り専用のサービスが返し、中身の書き込みは API に出さない。トークンは OAuth 2.1（PKCE 必須、短い期限）と期限必須の個人のアクセストークン |
| [0041](../decisions/0041-webhook-delivery.md) | Webhook は中身を含まない、HMAC で署名したイベントを、配送の時点の権限で判定し、隔離した egress から少なくとも 1 回送る |
| [0042](../decisions/0042-api-versioning-and-rate-limits.md) | 版は URL の大きな版（`/v1`）。ノードの JSON はプロパティの表から生成し、表の列で公開を決める。レート制限は操作の重さで tier に分けた利用者×アプリのトークンバケット |

## 1. 位置づけ

| 項目 | 方針 |
| --- | --- |
| 何のためか | デザインの中身と画像を、開発の道具・CI・社内のスクリプト・他社の製品が読む。コメントの読み書き、変化の通知 |
| 内部の API との関係 | 内部の API（Web クライアント用）は互換を約束しない。公開 API は別の面として持ち、同じサービス関数と判定関数を通る（Slack の [ADR-0030](../../../slack/docs/decisions/0030-versioned-public-api.md) と同じ形） |
| 誰の権限で動くか | **トークンの利用者の権限と、トークンのスコープの積。** 利用者が読めないファイルは読めない（本家と同じ。[Scopes](https://developers.figma.com/docs/rest-api/scopes/)） |
| ファイルの中身の書き込み | 出さない。中身の変更は、Document Server とマルチプレイヤーの経路（[ADR-0002](../decisions/0002-central-authoritative-multiplayer.md)）を通るプラグイン（[plugins.md](plugins.md)）で行う。本家の REST API も、中身の書き込みを持たない（変数・Dev の資源・コメントを除く） |
| 提供の時期 | MVP の後の E15（[roadmap.md](../roadmap.md)） |

## 2. 構成

```
開発の道具・CI・他社の製品
   │ HTTPS  Authorization: Bearer <token>
   ▼
CloudFront + WAF ─▶ ALB ─▶ public-api（TypeScript・Hono。ECS Fargate）
   │ 1. トークンの検証 → 利用者・アプリ・スコープ
   │ 2. レート制限（利用者×アプリ、tier。ADR-0042）
   │ 3. ハンドラー → サービス関数 → can(user, action, file)
   │
   ├─▶ Aurora（メタデータ・コメント・版の一覧。RLS）
   ├─▶ file-read（Rust。ファイルの中身を JSON にする。読むだけ）
   │      └─ S3 のチェックポイント＋Journal（DynamoDB）
   └─▶ SQS render-export ─▶ Render Worker（/images。export-and-assets.md の 5 節）

Webhook：outbox ─▶ SQS webhook-delivery ─▶ webhook Worker（署名）─▶ webhook-egress（Lambda、VPC の外）─▶ 受け手
```

- `api.<domain>` の独立したサービス。Cookie を受け付けず、CORS を許さない（Slack・Notion と同じ）。外部の呼び出しの急増が、エディタ（NFR-001）に響かない。障害時は ops フラグで公開 API だけを止める。
- **file-read**：Rust のサービス。`doc-model` の crate で、チェックポイントとジャーナルから `seq` までの状態を作り（Render Worker と同じ読み方。[export-and-assets.md](export-and-assets.md) の 5.2 節）、JSON に変換する。Document Server に問い合わせない。`(file_id, seq, page)` の読み込みの結果を、メモリに LRU で持つ。
- 読み取りの `seq` は、要求の時点のジャーナルの最新。「今」の中身は、確定済みの変更まで入る。

## 3. アプリとトークン

ADR-0040。

### 3.1 種類

本家の種類（[Authentication](https://developers.figma.com/docs/rest-api/authentication/)、[OAuth apps](https://developers.figma.com/docs/rest-api/oauth-apps/)）に合わせ、期限を短くする。

| 種類 | 本家 | 本システム | 時期 |
| --- | --- | --- | --- |
| OAuth のアプリ | 認可コードだけ。PKCE（S256）は任意で推奨。認可コードは 30 秒で切れる。アクセストークンは既定で 90 日。リフレッシュトークンは何度でも使える。下書き・private（チームか組織の中。審査なし）・public（審査あり） | OAuth 2.1：認可コード＋PKCE（S256）を必須。認可コード 30 秒。アクセストークン 1 時間。リフレッシュトークン 90 日（使うたびに入れ替える。前のものを使ったら、その系列を全部失効）。下書き・private・public の 3 つの状態は同じ | E15 |
| 個人のアクセストークン | 利用者が設定画面で作る。期限とスコープを選ぶ。作ったときだけ表示 | 同じ。期限は必須で最大 1 年（既定 90 日）。スコープは必須 | E15 |
| 組織のトークン | Organization・Enterprise。利用者に結び付かない。期限は最大 1 年。資源の許可リストで絞れる | 同じ形で、後の Story にする。主体は組織のボットで、許可リストのプロジェクト・ファイルだけ | E15 の後半 |

- 本家の個人のアクセストークンは、作るときに期限とスコープを決める（[Personal access tokens](https://developers.figma.com/docs/rest-api/personal-access-tokens/)）。組織のトークン（plan access token）の期限は最大 1 年（[Authentication](https://developers.figma.com/docs/rest-api/authentication/)）。いずれも 2026-09-27 に確認。個人のトークンの期限の選択肢と上限は資料にない（**未検証**。設計の判断には影響しない）。
- 認可コードと PKCE の値は、2026-09-27 に確認。
- 接頭辞は `<brand>pat_`（個人）、`<brand>oat_`（OAuth のアクセス）、`<brand>ort_`（OAuth のリフレッシュ）、`<brand>ogt_`（組織）。本体はランダム 32 バイト、末尾に CRC32 のチェックサム（base62）。他のサービスの接頭辞と重ならないことを確かめ、シークレットスキャンのパートナープログラムに登録する（リポジトリ共通の ADR-0006）。
- トークンは SHA-256 のハッシュで持ち、定数時間で比べる。
- ヘッダーは `Authorization: Bearer <token>` だけ（本家は個人のトークンに独自のヘッダーも使う）。

### 3.2 スコープ

本家の細かいスコープ（[Scopes](https://developers.figma.com/docs/rest-api/scopes/)、2026-09-27 に確認）に寄せる。本家が非推奨にした広い `files:read` は持たない。

| スコープ | 操作 |
| --- | --- |
| `current_user:read` | 名前、メールアドレス、アイコン |
| `file_content:read` | ファイルの中身（ノード）、`/images`、画像の塗り |
| `file_metadata:read` | ファイルのメタデータ |
| `file_versions:read` | 版の一覧 |
| `file_comments:read` / `file_comments:write` | コメントの読み取り / 投稿・削除・リアクション |
| `projects:read` | チームのプロジェクトと、プロジェクトの中のファイルの一覧 |
| `webhooks:read` / `webhooks:write` | Webhook の読み取り / 作成・変更・削除 |
| `org:audit_log_read` | 組織の監査ログ（組織の管理者だけ。後） |

- スコープは権限を広げない。ファイルは、利用者が読めるものだけ（本家と同じ）。

### 3.3 認可の流れ（OAuth）

1. アプリは `https://www.<domain>/oauth/authorize?client_id&redirect_uri&scope&state&code_challenge&code_challenge_method=S256&response_type=code` へ利用者を送る。
2. 利用者はログインし、スコープとアプリの名前・作者を見て同意する。組織の管理者が OAuth のアプリを許可リストにしていれば、リストにないアプリは同意の画面で止まる。
3. `redirect_uri` は、登録した値と完全一致だけを許す。
4. アプリは 30 秒以内に `POST https://api.<domain>/v1/oauth/token`（`client_secret` は HTTP Basic）でコードを交換する。
5. OAuth の認可サーバーは、認証の基盤（security.md）の部品を使う。

### 3.4 失効

- 利用者が組織から外れたら、その組織のファイルに対する API の呼び出しは、判定関数で読めなくなる。トークン自体は失効させない（他の組織のファイルに使える）。
- 利用者がアカウントを消したら、その人のトークンとグラントをすべて失効させる。
- 組織の管理者は、組織のメンバーの個人のアクセストークンの利用を禁止でき、OAuth のアプリを許可リストにできる。
- シークレットスキャンの通報を受けたら、該当のトークンを即時に失効させ、持ち主にメールで知らせる。

## 4. リソース

ADR-0040・0042。ID の形：ファイルは `file_key`（128 ビットの乱数の base62、22 文字。内部の ID の UUIDv7 は出さない。[permissions-and-sharing.md](permissions-and-sharing.md) の 8 節）、ノードは `"{session_id}:{local_id}"`（[document-model.md](document-model.md) の 6 節。本家の `"1:2"` と同じ見た目）。

| リソース | 内容 | スコープ | tier |
| --- | --- | --- | --- |
| `GET /v1/files/{file_key}` | ドキュメントの木。`ids`（ノードとその祖先・子孫だけ）、`depth`、`version`（版の ID）、`geometry=paths` | `file_content:read` | 1 |
| `GET /v1/files/{file_key}/nodes?ids=` | 指定のノードとその子孫。見つからないノードは `null` | `file_content:read` | 1 |
| `GET /v1/files/{file_key}/meta` | 名前、最終の更新、サムネイルの URL、持ち主の組織、リンクの共有の水準 | `file_metadata:read` | 3 |
| `GET /v1/images/{file_key}?ids=&scale=&format=` | ノードを描いた画像の URL。`format` は `png`・`jpg`・`svg`・`pdf`、`scale` は 0.01〜4。SVG の選択肢（`svg_outline_text` など）と `contents_only`・`use_absolute_bounds`・`version` | `file_content:read` | 1 |
| `GET /v1/files/{file_key}/images` | 画像の塗りの `image_hash` と URL（24 時間） | `file_content:read` | 2 |
| `GET /v1/files/{file_key}/versions` | 版の一覧（ページング） | `file_versions:read` | 2 |
| `GET` / `POST /v1/files/{file_key}/comments`、`DELETE .../comments/{id}`、`POST` / `DELETE .../comments/{id}/reactions` | コメント（comments-and-notifications.md のモデルを使う） | `file_comments:*` | 2 |
| `GET /v1/me` | トークンの利用者 | `current_user:read` | 3 |
| `GET /v1/teams/{team_id}/projects`、`GET /v1/projects/{project_id}/files` | 一覧（読めるものだけ） | `projects:read` | 2 |
| `POST` / `GET` / `PATCH` / `DELETE /v1/webhooks`、`GET /v1/webhooks/{id}/requests` | Webhook（6 節） | `webhooks:*` | 2 |

- `/v1/images` の描画は Render Worker（[export-and-assets.md](export-and-assets.md) の ADR-0034）。本家は同期で返す。本システムは 30 秒まで待って返し、終わらなければ `202` と `job_id` を返す（`GET /v1/image_jobs/{job_id}` で取る）。これは本システムの独自の拡張である。描けなかったノードは `null`（本家と同じ）。32 メガピクセルを超える画像は縮める（本家と同じ）。
- 結果の URL は 24 時間、結果は 14 日（[export-and-assets.md](export-and-assets.md) の 4.4 節）。本家は 30 日で切れる（[File endpoints](https://developers.figma.com/docs/rest-api/file-endpoints/)、2026-09-27 に確認）。
- ファイルの JSON の大きさ：1 応答 100 MiB（圧縮の前）を超えるときは `413` を返し、`ids` か `depth` で絞るよう案内する。本家の上限は **未検証**。
- エラーは RFC 9457（`application/problem+json`）。ページングは不透明なカーソル（`cursor`・`page_size` 最大 100）。書き込み（コメント、Webhook の作成）は `Idempotency-Key` を受け、24 時間同じ応答を返す（Slack と同じ）。

### 4.1 ノードの JSON

- ノードの JSON の形は、プロパティの表（[document-model.md](document-model.md) の 4 節、ADR-0006）の新しい列から生成する（ADR-0042）。

| 表の列（[document-model.md](document-model.md) の 4.1 節に登録済み） | 意味 |
| --- | --- |
| `public_api: bool` | 公開 API に出すか。既定は偽。真にするのは、形が固まったプロパティだけ |
| `api_name: String` | JSON の鍵（`camelCase`。本家の JSON の見た目に寄せる） |
| `api_since: String` | 出した API の版（`v1` など） |

- `derived_layout` は、`absoluteBoundingBox`・`size` として読むだけで出す。`plugin_data` は出さない（本家の `pluginData` の出し方は後で決める）。
- 表の中の値の型から JSON の型への対応（`f32` → 数、`NodeId` → 文字列、`Paint` → オブジェクト）は 1 か所の変換関数に置く。
- 画像は `imageHash`（16 進の文字列）で出す。URL は `/v1/files/{file_key}/images` で取る。

## 5. レート制限

ADR-0042。本家の tier の形に合わせる（[Rate limits](https://developers.figma.com/docs/rest-api/rate-limits/)、2026-09-27 に確認）。

本家の値（1 分あたり。Starter は席の種類を問わない。Professional・Organization・Enterprise の列は Dev・Full の席の値で、View・Collab の席はどのプランでも右端の値）：

| tier | 本家の対象 | Starter | Professional | Organization | Enterprise | View・Collab の席 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | ファイル、ノード、画像 | 月に最大 20 | 10 | 15 | 20 | 月に最大 20 |
| 2 | コメント、画像の塗り、プロジェクト、版、Webhook など | 5 | 25 | 50 | 100 | 5 |
| 3 | ファイルのメタデータ、コンポーネント、利用者など | 10 | 50 | 100 | 150 | 10 |

- 本家は、OAuth のアプリは「利用者×プラン×アプリ」、個人のトークンは「利用者×プラン」で数える。429 に `Retry-After`（秒）と、プランと制限の種類を示すヘッダーを付ける。

本システムの値（初期値。capacity.md で負荷のモデルから見直す）：

| tier | 無料のプラン | 有料のプラン（編集の席） | 組織のプラン | 閲覧だけの席 |
| --- | --- | --- | --- | --- |
| 1 | 1 分 2 | 1 分 15 | 1 分 30 | 1 分 2 |
| 2 | 1 分 10 | 1 分 50 | 1 分 100 | 1 分 10 |
| 3 | 1 分 20 | 1 分 100 | 1 分 150 | 1 分 20 |

- 数える単位は本家と同じ（OAuth は利用者×アプリ、個人のトークンは利用者、組織のトークンはトークン）。プランは、読むファイルを持つ組織のもの。
- 無料のプランの tier 1 は、本家の「月に 20」より緩くする。本家の値は需要の高いときの調整を含む（本家の説明）ので、まず 1 分 2 から始め、Render Worker の費用を見て決める（PM）。
- 1 分の窓のトークンバケット。Slack の rate-limiting（[Slack の ADR-0029](../../../slack/docs/decisions/0029-rate-limiting.md)）と同じ部品（Valkey）。
- `/v1/images` は、回数に加えて画素の予算（利用者×アプリで 1 分 200 メガピクセル）で数える。重い描画が回数の制限をすり抜けないため。
- 超えたら `429`、`Retry-After`、`RateLimit-Policy`・`RateLimit`（IETF の draft。Slack と同じ）、`X-<Brand>-Rate-Limit-Tier`。
- 組織ごとの合計の上限（全アプリ・全利用者）も持ち、1 つの組織の自動化が Render Worker を占めないようにする。値は負荷試験で決める。

## 6. Webhook

ADR-0041。本家の Webhook の V2 に寄せる（[Webhooks](https://developers.figma.com/docs/rest-api/webhooks/)、[Webhooks Events](https://developers.figma.com/docs/rest-api/webhooks-events/)、[Webhooks Endpoints](https://developers.figma.com/docs/rest-api/webhooks-endpoints/)、[Webhooks Security](https://developers.figma.com/docs/rest-api/webhooks-security/)、2026-09-27 に確認）。

### 6.1 文脈と上限

| 文脈 | 作れる人 | 上限（本家と同じ） |
| --- | --- | --- |
| チーム | チームの管理者 | 20 |
| プロジェクト | プロジェクトの編集の権限 | 5 |
| ファイル | ファイルの編集の権限 | 3 |

- 本家は、ファイルの Webhook の合計にプランごとの上限（150・300・600）を持つ。本システムも組織ごとに 300 を初期値にする。
- チームの Webhook は、チームの全員に見えるファイルと、閲覧だけのプロジェクトのファイルで発火し、招待だけのプロジェクトでは発火しない（本家と同じ）。本システムでは、これを「作った人が配送の時点で読めるファイル」の判定（6.4 節）で表す。

### 6.2 イベント

| 種類 | いつ | 本家 |
| --- | --- | --- |
| `ping` | 作ったとき（`status` を `paused` で作ると送らない） | `PING` |
| `file.updated` | ファイルの編集が 5 分止まったとき | `FILE_UPDATE`（30 分止まったとき） |
| `file.version_created` | 名前付きの版を作ったとき | `FILE_VERSION_UPDATE` |
| `file.deleted` | ファイルを消したとき | `FILE_DELETE` |
| `file.comment_created` | コメントが付いたとき | `FILE_COMMENT` |
| `library.published` | ライブラリの公開（ライブラリが MVP の後のため、その後） | `LIBRARY_PUBLISH` |

- `file.updated` の 5 分は、本家の 30 分より短くする。CI の連携での待ち時間を減らすため。1 ファイルで 30 分に 1 回までに間引く。
- **本文は ID だけにする。** 封筒：`id`（イベントの ID）、`type`、`created_at`、`webhook_id`、`context`・`context_id`、`file_key`、`version_id`・`comment_id`（該当のとき）、`triggered_by`（利用者の ID）、`attempt`。**ファイル名・コメントの本文は入れない。** 本家はファイル名とコメントの本文を入れる。受け手は API で最新の内容を取りに来る。配送の時点の API の判定で、共有を外した後の内容の漏れを防ぐ（rebuilds の Notion の [ADR-0025](../../../notion/docs/decisions/0025-webhook-delivery.md) と同じ考え方）。

### 6.3 署名

- 本家は、作るときに利用者が決めた `passcode` を、本文に入れて返す。受け手は比べて、違えば 400 を返す（400 で Webhook は止まる）。
- 本システムは、**作ったときにサーバーが秘密（32 バイト）を作り、一度だけ見せる。** 配送には `<Brand>-Signature: t=<unix 秒>,v1=<HMAC-SHA256(secret, "{t}.{本文}") の 16 進>` を付ける（リポジトリ共通の ADR-0006 の形）。受け手は、時刻の差 5 分以内と署名を定数時間で確かめる。
  - 秘密を本文に入れない。受け手や途中の記録に残った本文から、秘密が漏れないため。本文の改ざんとリプレイも検出できる。
- 秘密の入れ替え：新しい秘密を作ると、24 時間、古い秘密と新しい秘密の 2 つの `v1=` を付ける。
- 秘密は KMS で暗号化して持つ（署名に使うのでハッシュにできない）。署名は VPC の中の Worker で行い、egress の Lambda に秘密を渡さない。

### 6.4 配送

| 項目 | 設計 | 本家 |
| --- | --- | --- |
| 保証 | 少なくとも 1 回。順序は保証しない。受け手はイベントの `id` で重複を除く | 資料に記述なし。再試行があるので重複はありうる（**未検証**。設計の判断には影響しない） |
| 成功 | 10 秒以内の 2xx | 200 だけ |
| 再試行 | 1 分・5 分・30 分・3 時間・12 時間の後（最大 6 回） | 5 分・30 分・3 時間（最大 4 回） |
| 止める | 3 日続けて失敗したら `paused` にし、作った人にメールで知らせる。受け手が 410 を返したら即時に `paused` | 失敗が続いても止めない。誤った passcode への 400 で止まる |
| 記録 | 7 日の配送の記録（要求と応答の状態・時間。本文は封筒だけ） | 7 日 |
| 権限 | 送る直前に、作った人が対象のファイルを読めるかを判定関数で確かめる。読めなければ送らず、記録に `skipped_forbidden` を残す。作った人が組織から外れたら、その組織の Webhook を `paused` にする | 記載なし |

- 流れ：変化はメタデータの outbox（または Document Server からのイベント）→ SQS `webhook-delivery` → webhook Worker（判定・封筒・署名）→ `webhook-egress`（VPC の外の権限のない Lambda）→ 受け手。
- `webhook-egress` の宛先の検査は Slack の [ADR-0016](../../../slack/docs/decisions/0016-isolated-link-unfurling.md) と同じ（https・443 だけ、名前解決の後の IP の検査、リダイレクトを追わない、自分たちのドメインへ送らない）。URL は最大 2,048 文字（本家と同じ）。
- 送信元の IP は固定しない。署名での検証を求める（Slack と同じ判断）。
- Webhook ごとの同時に送る数の上限（10）を Valkey で数え、遅い受け手が他の配送を待たせない。

## 7. 版と廃止

ADR-0042。

- **URL の大きな版（`/v1`）。** `/v1` の中では追加だけを行う（エンドポイント、任意の引数、応答の鍵、列挙の値の追加）。本家も URL の版を使う（`/v1`・Webhook の `/v2`）。
- 互換性を壊す変更は `/v2` として出し、古い版を最低 12 か月動かす。廃止は `Deprecation`（RFC 9745）・`Sunset`（RFC 8594）のヘッダー、開発者のメール、変更の記録で告知する（Slack の ADR-0030 と同じ）。
- 応答の列挙に知らない値が来ても壊れないよう、SDK と文書で求める（追加は互換の範囲）。
- ノードの JSON は表から生成するので、表の変更が API を壊さないよう、CI で「`public_api` のプロパティの JSON の形のスナップショット」を比べる。消す・型を変えるには `/v2` が要る。
- 契約は OpenAPI 3.1 で出す（Hono の zod-openapi）。公式の SDK は TypeScript だけ。

## 8. 障害のときの振る舞い

| 障害 | 起きること | 対応 |
| --- | --- | --- |
| file-read の負荷の急増（大きなファイルの全体の取得が続く） | 遅延の増加 | tier 1 の制限、100 MiB の上限、組織ごとの合計の上限。file-read は Document Server と別なので、編集には響かない |
| Render Worker の滞留 | `/v1/images` が `202` を多く返す | `render-export` の優先の順を「画面からの一括の書き出し」を先にする。API の画素の予算を一時的に下げる ops フラグ |
| 受け手の障害 | 再試行が溜まる | 6.4 節の再試行と停止。Webhook ごとの同時の上限 |
| egress の Lambda の障害 | 配送が止まる | SQS に残り、回復後に送る。滞留が 1 時間を超えたら警告 |
| トークンの漏れ | 第三者が読む | シークレットスキャンの通報で即時に失効（3.4 節）。アクセストークンは 1 時間で切れる |
| OAuth の認可サーバーの障害 | 新しい認可とリフレッシュができない | 既存のアクセストークンは期限まで使える |

## 9. セキュリティ

| 脅威 | 守り |
| --- | --- |
| トークンの漏れ（リポジトリ、ログ） | 接頭辞とチェックサムでシークレットスキャンに載せる。個人のトークンは期限必須。OAuth のアクセストークンは 1 時間。リフレッシュトークンの入れ替えと再利用の検出。トークンをログ・トレースに書かない（ハッシュの先頭 8 文字だけ） |
| 認可コードの横取り | PKCE（S256）必須、`redirect_uri` の完全一致、コード 30 秒、1 回だけ |
| スコープを越える読み取り | スコープの検査をルートの定義に書き、表駆動のテストで全ルートを確かめる |
| 利用者の権限を越える読み取り | すべてのハンドラーがサービス関数の判定関数を通る。file-read は、API が判定した後の `org_id`・`file_id` だけを受け取る |
| Webhook の宛先での SSRF | VPC の外の権限のない Lambda と宛先の検査（6.4 節） |
| Webhook の本文からの漏れ | 本文は ID だけ。配送の時点の判定（6.2・6.4 節） |
| Webhook の偽装 | HMAC の署名と時刻（6.3 節） |
| API を使った大量の取得（組織の中身の持ち出し） | tier の制限、組織ごとの合計、監査ログ（組織の管理者が見られる。後） |
| 悪意のある OAuth のアプリ | public のアプリは審査。同意の画面にスコープと作者。組織の許可リスト |

## 10. 観測

- エンドポイント・tier・アプリごとの呼び出し数、エラー率、遅延、429 の数。アプリのラベルは上位 N 件＋「その他」に丸める。
- file-read：読み込みの時間、LRU のヒット率、応答の大きさの分布、`413` の件数。
- `/v1/images`：同期で返せた割合、`202` の割合、画素の予算の消費。
- Webhook：配送の遅れ（発生から送るまで）p95・p99、失敗率、`paused` の数、`skipped_forbidden` の数、egress での拒否の数（SSRF の試み）。
- トークン：発行・失効の数、シークレットスキャンの通報の数、リフレッシュトークンの再利用の検出の数。

## 11. テスト

- 権限のテスト：
  - **PROP-API-001**：任意の利用者・ファイル・共有の設定で、API で読めるファイルの集合が、`can(user, read, file)` が真の集合と一致する。
  - **PROP-API-002**：任意のトークンとルートで、スコープにない操作は 403。
  - 共有を外した直後のファイルを、`/files`・`/nodes`・`/images`・`/comments` で返さない。
- スコープの表駆動のテスト：全ルート × 全スコープ。
- OAuth：PKCE なし・違う `code_verifier`・30 秒を過ぎたコード・2 回目の交換・一致しない `redirect_uri` を拒否する。リフレッシュトークンの再利用で系列が失効する。
- ノードの JSON：参照ファイルの JSON のスナップショット（`public_api` の形が変わらない）。`public_api` が偽のプロパティが出ない。
- Webhook：署名の検証（公開するテスト用のベクター）、時刻の差の拒否、秘密の入れ替えの 24 時間の 2 つの署名、共有を外した後の再試行が送られない、SSRF の宛先（Slack の ADR-0016 と同じ一覧）に送らない。
- レート制限：tier の境界、画素の予算、組織の合計。
- 障害注入：受け手の遅延・5xx・タイムアウトで、再試行の予定どおりに試行され、他の Webhook の配送の遅延が目標を超えない。

## 12. Story の候補

公開 API と Webhook は MVP の後の E15。MVP の中で準備しておくものを E1〜E12 の番号で書く。

| Epic | Story | 中身 |
| --- | --- | --- |
| E2 | `property-table-api-columns` | 表に `public_api`・`api_name`・`api_since` の列を足す（document-model と合わせる） |
| E7 | `file-change-events` | ファイルの編集が止まったこと・版の作成・削除を outbox に出す（Webhook と通知で使う。file-storage-and-history と合わせる） |
| E15 | `public-api-service` | `api.<domain>` のサービス、RFC 9457、ページング、`Idempotency-Key`、OpenAPI |
| E15 | `file-read-service` | file-read（Rust）、JSON の生成、LRU、100 MiB の上限 |
| E15 | `personal-access-tokens` | 個人のアクセストークン、スコープ、期限、シークレットスキャンの登録 |
| E15 | `oauth-apps` | OAuth のアプリの登録、下書き・private・public、PKCE、入れ替え、同意の画面 |
| E15 | `oauth-app-review` | public のアプリの審査の道具（プラグインの審査と同じ担当） |
| E15 | `api-files-and-nodes` | `/files`・`/nodes`・`/meta` |
| E15 | `api-images` | `/images`（Render Worker、`202` と `image_jobs`、画素の予算）、`/files/{id}/images` |
| E15 | `api-comments-versions-projects` | コメント・版・プロジェクトの一覧 |
| E15 | `api-rate-limits` | tier のトークンバケット、組織の合計、429 のヘッダー |
| E15 | `webhooks-v1` | Webhook の作成・一覧・変更・削除、`ping`、署名、配送、記録 |
| E15 | `webhook-egress` | `webhook-egress` の Lambda と宛先の検査 |
| E15 | `org-api-controls` | 組織の管理者の統制（個人のトークンの禁止、OAuth のアプリの許可リスト） |
| E15 | `org-access-tokens` | 組織のトークン（許可リスト付き） |

## 13. 未解決の問い

### 決定（2026-09-27、既定案）

- **中身の書き込みは API に出さない**（1 節、ADR-0040）。本家と同じ。書き込みはプラグインで行う。
- **OAuth のアクセストークンは 1 時間、PKCE 必須**（3.1 節、ADR-0040）。本家（90 日、PKCE は任意）より厳しくする。漏れの影響を小さくするため。
- **個人のアクセストークンは期限必須で最大 1 年**（3.1 節）。
- **Webhook の本文は ID だけ、署名は HMAC**（6.2・6.3 節、ADR-0041）。本家の passcode とファイル名・コメントの本文は採らない。
- **`file.updated` は編集が 5 分止まったとき**（6.2 節）。本家は 30 分。
- **失敗が続いた Webhook は 3 日で止める**（6.4 節）。本家は止めない。
- **無料のプランの tier 1 は 1 分 2 から始める**（5 節）。本家の「月に 20」は採らない。費用を見て見直す。
- **MCP のサーバーは出さない**。本家は MCP のサーバーを別に持つ（[Scopes](https://developers.figma.com/docs/rest-api/scopes/) の注記）が、intent は AI の生成を範囲の外にする。出すときは別の ADR にする（推奨案で確定）。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| 組織のトークンの許可リストの粒度（チーム・プロジェクト・ファイル） | `org-access-tokens` の着手時 |
| `plugin_data` を API に出すか | プラグインの後。利用者の声で |
| 本家の個人のトークンの期限の選択肢、Webhook の配送の保証 | 公開の資料で確かめられなかった（**未検証**）。この設計の判断には影響しない |
| 変数・ライブラリの API | ライブラリと変数（MVP の後）の設計の後 |
| 1 応答 100 MiB の上限が足りるか | file-read の計測で見直す |

## 14. quality.md・runbooks・data-model への項目

### quality.md

- 権限のテスト（PROP-API-001・002）を、公開 API のリリースの基準にする。
- スコープの表駆動のテストの網羅（全ルート）。
- Webhook の配送の遅れ p95 1 分、p99 5 分（`file.updated` の 5 分の待ちを除く）。
- file-read の `/files` の遅延 p95（10 万ノードの参照ファイルで 10 秒以内）。
- 公開 API の月間の可用性 99.9%（メタデータの API と同じ。NFR-008）。

### runbooks

- `api-token-leak.md`：シークレットスキャンの通報を受けてトークンを失効させ、持ち主に知らせ、監査ログで使われた範囲を調べる手順。
- `public-api-kill-switch.md`：公開 API だけを止める ops フラグの手順（障害や濫用のとき）。
- `webhook-backlog.md`：配送の滞留の切り分け（egress、受け手、SQS）と、止めた Webhook の再開。
- `oauth-app-suspend.md`：悪意のある OAuth のアプリを止め、グラントを失効させる手順。

### data-model（索引への追加の提案）

| 置き場所 | 中身 |
| --- | --- |
| Aurora `global.oauth_apps` | `id`、`owner_user_id`、`owner_org_id`、`name`、`redirect_uris`、`client_secret_hash`、`state`（`draft`・`private`・`public`）、`review_status`、`scopes`、`created_at` |
| Aurora `oauth_grants`（RLS。利用者の所属の組織） | `org_id`、`id`、`app_id`、`user_id`、`scopes`、`granted_at`、`revoked_at` |
| Aurora `api_tokens`（RLS） | `org_id`、`id`、`kind`（`pat`・`oauth_access`・`oauth_refresh`・`org`）、`user_id`、`app_id`、`grant_id`、`scopes`、`resource_allowlist`（組織のトークン）、`secret_hash`、`expires_at`、`last_used_at`、`revoked_at`、`replaced_by`、`family_id`（リフレッシュの系列） |
| Aurora `webhooks`（RLS） | `org_id`、`id`、`context`（`team`・`project`・`file`）、`context_id`、`event_type`、`endpoint`、`secret_ciphertext`、`secret_next_ciphertext`、`secret_rotated_at`、`status`（`active`・`paused`）、`created_by`、`failing_since`、`created_at` |
| Aurora `webhook_deliveries`（RLS。時間でパーティション、7 日） | `org_id`、`id`（イベントの ID）、`webhook_id`、`event_type`、`envelope`、`attempt`、`next_attempt_at`、`status`（`pending`・`delivered`・`failed`・`skipped_forbidden`）、`last_status_code`、`last_latency_ms`、`created_at` |
| Aurora `idempotency_keys`（RLS） | `org_id`、`token_id`、`key`、`request_hash`、`response_status`、`response_body`、`expires_at`（24 時間） |
| `/v1/image_jobs` の記録 | 別の表を持たない。Aurora の `export_jobs`（`source = api`。[export-and-assets.md](export-and-assets.md)、[data-model.md](data-model.md)）を使う |
| SQS `webhook-delivery` | 配送のジョブ |
| 開発リポジトリ `schema/properties.toml` の列 | `public_api`・`api_name`・`api_since`（4.1 節）、`public_plugin`（[plugins.md](plugins.md) の 5.5 節） |

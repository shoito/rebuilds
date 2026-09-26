# Public API: Slack

外部の開発者（アプリ、社内のスクリプト、連携サービス）が使う、版を持つ公開 API。方針は [ADR-0030](../decisions/0030-versioned-public-api.md) にある。アプリの仕組み（インストール、ボット、Events API、インタラクティブ機能）は [apps.md](apps.md) と [ADR-0031](../decisions/0031-app-platform.md) に書く。

公開 API とアプリの基盤は、MVP の後の Epic（E12）で出す。この文書は、それまでに内部の設計が公開の妨げにならないよう、先に形を決めておくためのものである。

## 1. 位置づけ

| 項目 | 方針 |
| --- | --- |
| 何のためか | ワークスペースのデータを、アプリや外部のシステムから、互換性の約束のもとで読み書きできるようにする |
| 内部の API との関係 | 内部の API（`/api/workspaces/{ws}/...`、Hono RPC。[ADR-0008](../decisions/0008-hono-rpc-for-api-contract.md)）は Web クライアントのためのもので、外部への互換性を約束しない。公開 API は別の面として持ち、同じドメイン層（サービス関数）を呼ぶ |
| MCP との関係 | MCP（[mcp.md](mcp.md)）は、AI エージェント向けに絞った面のまま残す。MCP のツールと公開 API のハンドラーは、同じサービス関数の上に作る（7 節） |
| 誰の権限で動くか | ボットのトークンはボットのメンバーの権限、ユーザーのトークンは同意したメンバーの権限。どちらも、その上にスコープを上限として重ねる（[identity-and-access.md](identity-and-access.md) の 6.5 節） |
| 互換性 | `/v1` の中では、追加だけを行う。互換性を壊す変更は `/v2` として出す（8 節） |

## 2. 構成

```
外部のクライアント（アプリ、スクリプト）
   │ HTTPS  Authorization: Bearer <token>
   ▼
CloudFront + WAF ─▶ ALB（public-api 専用のターゲットグループ）
   ▼
public-api サービス（ECS Fargate、OpenAPIHono）
   │ 1. トークンの種類を判別して検証（4 節）
   │ 2. メンバーを解決 → BEGIN; SET LOCAL app.workspace_id, app.member_id
   │ 3. レート制限（rate-limiting.md の tier）
   │ 4. ハンドラー → ドメイン層のサービス関数 → authorization.ts（ADR-0005）
   ▼
PostgreSQL（RLS。ADR-0009）
```

- **`api.<domain>` で、独立した ECS サービスとして公開する。** 内部の API（`app.<domain>/api`）とはオリジンを分け、Cookie を受け付けず、Bearer トークンだけを受け付ける。CORS は許可しない（ブラウザから第三者のオリジンで直接呼ばせない）。
- 別のサービスにする理由は 2 つある。外部の呼び出しの急増が、Web の投稿の遅延（NFR-003）に響かないようにするため。障害時に、公開 API だけを止められるようにするため（ops フラグ `ops.public_api_enabled`）。
- コードは同じモノレポの `apps/public-api` に置き、`packages/domain`（サービス関数）、`packages/contract`、`authorization.ts` を共有する。内部の API のルートを呼び直さない。
- 読み取りは Aurora の reader を使う。書いた直後に読む処理だけ writer を使う（[capacity.md](capacity.md) の 2.1 節と同じ規則）。

## 3. URL とリソース

### 3.1 形式

```
https://api.<domain>/v1/workspaces/{workspace_id}/<リソース>
```

リソースを名詞で表し、HTTP のメソッドで操作を表す（REST）。本家 Slack の `chat.postMessage` のような、メソッド名を URL にする RPC の形は採らない。

| 観点 | リソース指向（採用） | RPC 形式（本家に近い） |
| --- | --- | --- |
| 内部の API との一致 | 内部の API も `/workspaces/{ws}/channels/{ch}/messages` の形。ルートの設計とサービス関数の対応がそのまま使える | 公開のためだけに別の命名体系を持つ |
| 冪等性 | `PUT`・`DELETE` が冪等であることを HTTP の意味で示せる（リアクションはすでにこの形。[messaging.md](messaging.md)） | すべて `POST` になり、冪等かどうかを文書でしか示せない |
| エラー | HTTP のステータスで示せる。汎用の HTTP クライアント・監視・WAF がそのまま解釈できる | 200 と `ok: false` になりやすく、監視しにくい |
| OpenAPI | そのまま対応する | 書けるが、利点が薄い |
| セルへの振り分け（S3） | パスの `workspace_id` から、ルーターがセルを決められる（[identity-and-access.md](identity-and-access.md) の 13 節） | 本文やトークンを読むまでセルが決まらない |
| 本家の SDK の流用 | できない | 形が近ければ、部分的にできる |

本家の SDK との互換は目的にしない（intent.md の「本家の内部実装の再現は目的にしない」）。

- パスに `workspace_id` を含める。トークンはすでに 1 つのワークスペースに結び付いているので冗長だが、テナントを明示でき、セルへの振り分けにも使える。トークンのワークスペースとパスが違えば 404 を返す（[identity-and-access.md](identity-and-access.md) の 6.2 節の 2 行目）。
- 状態を変えるが CRUD に収まらない操作は、サブリソースへの `POST` にする（例：`POST .../channels/{id}/archive`）。
- ID は UUIDv7 の文字列（ADR-0009）。メッセージは `seq` も返す（ADR-0001）。

### 3.2 リソースの一覧（v1 の初版）

| リソース | 操作 | スコープ | tier |
| --- | --- | --- | --- |
| `GET /v1/auth/token` | トークンの情報（種類、ワークスペース、メンバー、スコープ、期限） | なし | `tier-read` |
| `POST /v1/auth/token/rotate` | ボットのトークンの入れ替え（[apps.md](apps.md) の 5.3 節） | なし | `tier-admin` |
| `DELETE /v1/auth/installation` | アプリ自身によるアンインストール（[apps.md](apps.md) の 15 節） | なし | `tier-admin` |
| `GET .../channels` | 一覧（種別、参加しているものだけか） | `channels:read` | `tier-read-heavy` |
| `GET .../channels/{id}` | 取得 | `channels:read` | `tier-read` |
| `POST .../channels` | 作成 | `channels:manage` | `tier-write` |
| `PATCH .../channels/{id}` | 名前・説明の変更 | `channels:manage` | `tier-write` |
| `POST .../channels/{id}/archive`、`.../unarchive` | アーカイブ | `channels:manage` | `tier-write` |
| `GET .../channels/{id}/members` | チャンネルのメンバー | `channels:read` | `tier-read-heavy` |
| `PUT` / `DELETE .../channels/{id}/members/{member_id}` | 参加・招待・退出 | 自分の参加は `channels:join`、他人は `channels:manage` | `tier-write` |
| `GET .../channels/{id}/messages` | 履歴（`before_seq` / `after_seq` / カーソル） | `messages:read` | `tier-read-heavy` |
| `POST .../channels/{id}/messages` | 投稿、スレッドの返信 | `messages:write` | `tier-write` ＋ `limit-post-per-channel` |
| `GET` / `PATCH` / `DELETE .../channels/{id}/messages/{mid}` | 取得・自分の投稿の編集・削除 | `messages:read` / `messages:write` | `tier-read` / `tier-write` |
| `GET .../channels/{id}/messages/{mid}/replies` | スレッド | `messages:read` | `tier-read-heavy` |
| `POST .../channels/{id}/ephemeral-messages` | 特定のメンバーだけに見える一時的なメッセージ（アプリだけ。[apps.md](apps.md) の 9 節） | `messages:write` | `tier-write` |
| `GET .../channels/{id}/messages/{mid}/reactions` | リアクションの一覧 | `reactions:read` | `tier-read` |
| `PUT` / `DELETE .../channels/{id}/messages/{mid}/reactions/{emoji}` | 付ける・外す（冪等） | `reactions:write` | `tier-write` |
| `GET .../members`、`GET .../members/{id}` | メンバーの一覧・取得 | `members:read`（メールアドレスは `members:read.email`） | `tier-read-heavy` / `tier-read` |
| `GET .../search/messages` | 検索（構文は [search.md](search.md)） | `search:read` | `tier-read-heavy` |
| `POST .../files`、`GET .../files/{id}`、`GET .../files/{id}/content` | アップロードの開始（署名付き URL を返す）、情報、本体（署名付き URL への 302） | `files:write` / `files:read` | `tier-write` / `tier-read` |
| `POST .../views`、`PUT .../views/{view_id}` | モーダルを開く・更新する（アプリだけ） | なし（インストールの `trigger_id` で認可） | `tier-write` |
| `PUT .../app-home/{member_id}` | アプリのホームの表示を置く（アプリだけ） | なし | `tier-write` |
| `GET .../audit-events` | 監査ログの読み出し。Enterprise だけ。後の版で追加する（15 節の決定） | `auditlogs:read` | `tier-admin` |

- 表の `...` は `/v1/workspaces/{workspace_id}` を表す。
- 大量のデータの取り出し（エクスポート）は、公開 API では提供しない。[ADR-0019](../decisions/0019-data-retention-and-deletion.md) のエクスポートの仕組みを使う。提供するときは `concurrency-bulk` を掛ける。
- **公開 API でも使えないもの**（v1）：@everyone、ワークスペースの設定・ロール・SSO の変更、メンバーの招待と無効化、他人のメッセージの編集。メンバーの作成・無効化は SCIM（[identity-and-access.md](identity-and-access.md) の 5.4 節）で行い、`admin:*` の管理の API は出さない（15 節の決定）。
- 差分取得（`GET .../events?after_seq`）は公開しない。イベントの封筒（[realtime.md](realtime.md) の 4 節）は内部の形であり、アプリには Events API（[apps.md](apps.md) の 7 節）の形で届ける。

### 3.3 レート制限

- 各エンドポイントに、[rate-limiting.md](rate-limiting.md) の tier を 1 つ割り当てる。値はそちらが正本で、この文書は数値を持たない。
- OpenAPI の各操作に拡張の属性 `x-rate-limit-tier` を付け、文書と SDK に出す。
- すべての応答に `RateLimit-Policy`・`RateLimit` を付け、超えたら 429 と `Retry-After` を返す（[rate-limiting.md](rate-limiting.md) の方針）。`RateLimit` と `RateLimit-Policy` は IETF の Internet-Draft（draft-ietf-httpapi-ratelimit-headers-11、2026 年 5 月）で、まだ RFC ではない。書式が変わりうるので、文書では「draft-11 の書式」と明記し、`Retry-After` を正とするようクライアントに勧める。
- 制限の単位は、トークン（ボットならインストール）ごとと、ワークスペースごとの両方。1 つのアプリが、ワークスペースの投稿の枠を使い切らないようにする。

## 4. 認証とトークン

| 種類 | 形式 | 誰の権限か | 発行 | 有効期間 | 使う場面 |
| --- | --- | --- | --- | --- | --- |
| ボットのトークン | `slk_bot_{token_id}_{secret}`（[identity-and-access.md](identity-and-access.md) の 9 節の形式） | インストールのボットのメンバー（`account_id IS NULL`） | インストールの完了時（[apps.md](apps.md) の 5 節） | 既定は無期限。入れ替えの API を持つ。アプリが有効にすれば、12 時間のアクセストークンとリフレッシュトークンの組にできる（15 節の決定） | アプリの大半の処理 |
| ユーザーのトークン | OAuth 2.1 のアクセストークン（Better Auth の oauth-provider が発行する JWT。`aud` は `https://api.<domain>/v1`）＋リフレッシュトークン | 同意したメンバー | 認可コードのフロー（PKCE、機密クライアント） | アクセストークン 1 時間、リフレッシュトークン 30 日で、使うたびに入れ替える | 「メンバーとして」検索・投稿するアプリ |
| Incoming Webhook の URL | `https://hooks.<domain>/v1/{webhook_id}/{secret}` | インストールのボット | インストール時、または管理画面 | 取り消すまで | 1 つのチャンネルへの投稿だけ（[apps.md](apps.md) の 11 節） |

- **アプリ単位のトークン（本家の app-level token）は、E12 の初版では持たない。** 本家では主に Socket Mode の接続に使う。Socket Mode は E12 の後半で提供すると決めた（[apps.md](apps.md) の 21 節）ので、そのときに Socket Mode の接続の用途に限って加える。
- **ユーザーのトークンは、ボットのトークンより危険が大きい。** メンバーが読めるもの（DM を含む）すべてに届くため。そのため、ユーザーのスコープはワークスペースの管理者の承認の対象にし（[apps.md](apps.md) の 6 節）、entitlement（`feature.api_user_tokens`）で提供の可否を分ける。
- 個人が自分用に使う「個人のアクセストークン」は提供しない。スクリプトも、単一のワークスペースのアプリ（[apps.md](apps.md) の 4 節）を作って使う。
- トークンの判別は接頭辞で行う。`slk_bot_` は `auth_resolve_api_token`（[identity-and-access.md](identity-and-access.md) の 9 節）、それ以外の Bearer は Better Auth の JWT の検証に回す。どちらでもなければ 401。

### 4.1 ユーザーのトークンの検証

MCP のトークン（[mcp.md](mcp.md) の 3.4 節）と同じ手順にする。

1. 署名、期限、`aud` が公開 API であることを確かめる。`aud` が MCP のトークンは受け付けない（逆も同じ）。
2. 同意（アカウント、アプリ、ワークスペース）が取り消されていないか、インストールが有効か、メンバーが無効になっていないかを確かめる。結果は 30 秒だけキャッシュする。JWT のアクセストークンはサーバー側で個別に取り消せない（Better Auth の文書で確認）ので、この検査で取り消しを反映する。
3. `workspace_id` と `member_id` でテナントのコンテキストを設定する。

Better Auth の oauth-provider プラグインについて、2026-09-26 に文書（`better-auth/better-auth` の `docs/content/docs/plugins/oauth-provider.mdx`）で確かめたこと：

| 必要なもの | 結果 |
| --- | --- |
| 機密クライアント（`client_secret_basic` / `client_secret_post` / `private_key_jwt`） | 対応。管理者が登録するクライアントを作れる。DCR は無効のままにする |
| `client_secret` の入れ替え | 対応（`/oauth2/client/rotate-secret`）。**旧い秘密は即座に無効になる**。重なりの期間を持てないので、アプリの側の切り替えと同時に行う必要がある（[apps.md](apps.md) の 14.3 節） |
| リフレッシュトークンの入れ替え | 対応。更新のたびに新しいリフレッシュトークンを出す。`refreshTokenReuseInterval` で、再試行のための短い猶予を設定できる |
| ワークスペースへの結び付け | `postLogin`（ログイン後・同意前の選択の画面）と `consentReferenceId` で、同意に参照 ID を結び付けられる。文書の例は organization プラグインの `activeOrganizationId` を使うが、`consentReferenceId` は `{ user, session, scopes }` を受け取って参照 ID を返す非同期の関数で、organization プラグインには依らない（[`types/index.ts`](https://github.com/better-auth/better-auth/blob/main/packages/oauth-provider/src/types/index.ts)、2026-09-26 に確認）。本システムは、postLogin の画面で選んだワークスペースを、セッション ID をキーにした短命の行（10 分）に置き、`consentReferenceId` でそれを引いて `workspace_id` を返す。選ばれていなければ例外を投げる（mcp.md も同じ） |
| アクセストークンに `workspace_id`・`member_id` を載せる | `customAccessTokenClaims` が `referenceId` を受け取り、戻り値は `Awaitable`（非同期でよい）なので、ここで DB を引いて `member_id` を解決できる。メンバーでなくなっていれば例外を投げて発行を止められる（[oauth-provider の文書](https://www.better-auth.com/docs/plugins/oauth-provider)、型定義、2026-09-26 に確認） |
| 取り消しとイントロスペクション | RFC 7009 の取り消し、RFC 7662 のイントロスペクションに対応。JWT のアクセストークンは取り消せず、リフレッシュトークンは取り消せる |
| `resource` ごとのスコープの上限とアクセストークンの期間 | `resources` の設定で指定できる |

## 5. リクエストとレスポンス

- 本文は JSON（`Content-Type: application/json`）だけ。未知のフィールドは 400 にする（[security.md](security.md) の 3.3 節）。レスポンスの未知のフィールドは、クライアントが無視しなければならない（8.1 節）。
- 時刻は RFC 3339 の UTC、ミリ秒まで。
- すべての応答に `X-Request-Id` を付ける。問い合わせのときに使ってもらう。
- `ETag` は付けない（v1）。条件付きの更新は、必要になったら追加する。

### 5.1 ページング

- 一覧はカーソル方式にする。応答は `{ "data": [...], "next_cursor": "..." }` で、`next_cursor` がなければ終わり。
- カーソルは不透明な文字列で、形を約束しない。中身は、並びのキー（`seq` など）と、クエリの条件のハッシュ。サーバーの鍵で署名し、改ざんされたカーソルや別の条件で使われたカーソルは 400（`invalid_cursor`）にする。
- `limit` の既定は 50、最大は 200（メッセージとスレッドは 100。[messaging.md](messaging.md) と同じ）。
- メッセージの履歴は、カーソルに加えて `before_seq` / `after_seq` も受け付ける。`seq` は公開の概念として扱う（欠損の検知と並び替えに使ってもらう）。
- オフセット方式は提供しない。書き込みが続く一覧で、重複と取りこぼしが起きるため。

### 5.2 エラー

RFC 9457（Problem Details）の形で返す。`Content-Type: application/problem+json`。

```json
{
  "type": "https://api.<domain>/errors/missing_scope",
  "title": "The token does not have the required scope",
  "status": 403,
  "code": "missing_scope",
  "detail": "messages:write is required",
  "request_id": "0192f7c4-...",
  "errors": [{ "pointer": "/body/blocks/0", "code": "invalid_node" }]
}
```

- `code` は安定した識別子で、クライアントはこれで分岐する。`title`・`detail` の文面は変わりうる。
- `code` の一覧は `packages/contract/public/v1` に列挙型として置き、OpenAPI に出す。追加は互換性のある変更、削除と意味の変更は互換性を壊す変更とみなす。
- ステータスの使い分けは内部と同じ（[identity-and-access.md](identity-and-access.md) の 6 節）。存在を知らせてはいけない相手には 404、知ってよい相手の権限不足には 403。

| ステータス | 主な `code` |
| --- | --- |
| 400 | `invalid_request`、`invalid_cursor`、`invalid_body` |
| 401 | `invalid_token`、`token_expired`、`token_revoked` |
| 403 | `missing_scope`、`not_in_channel`、`channel_archived`、`app_suspended`、`restricted_action` |
| 404 | `not_found` |
| 409 | `idempotency_key_in_use`、`conflict` |
| 413 | `payload_too_large` |
| 422 | `idempotency_key_reused` |
| 429 | `rate_limited` |
| 503 | `service_unavailable`（ops フラグで止めているときを含む。`Retry-After` を付ける） |

### 5.3 冪等性

- `POST` の書き込みは、`Idempotency-Key` ヘッダー（任意の文字列、最大 255 文字）を受け付ける。ヘッダーの名前と意味は IETF の draft-ietf-httpapi-idempotency-key-header に合わせる。最新は -07（2025-10-15）で、RFC にならないまま失効している（[IETF Datatracker](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/)、2026-09-26 に確認）。-07 の書式で固定し、後に RFC になって違いが出たら、公開 API の変更として扱う。
- メッセージの投稿では、キーを `client_msg_id` に変換して使う（キーから UUIDv5 を作る）。既存の一意制約（`messages` の `(workspace_id, channel_id, member_id, client_msg_id)`）がそのまま効き、同じ投稿を 2 回作らない（REQ-MSG-002 と同じ性質）。
- それ以外の `POST` は、テナントテーブル `api_idempotency_keys (workspace_id, principal_id, key, request_hash, status, response_status, response_body, created_at, PRIMARY KEY (workspace_id, principal_id, key))` で扱う。`principal_id` はボットならインストール、ユーザーのトークンならメンバー。24 時間で消す。

| # | 同じキーの記録 | 要求の中身（ハッシュ） | 結果 |
| --- | --- | --- | --- |
| 1 | なし | - | 処理し、結果を記録する |
| 2 | 処理中 | - | 409（`idempotency_key_in_use`） |
| 3 | 完了 | 同じ | 記録した応答をそのまま返す |
| 4 | 完了 | 違う | 422（`idempotency_key_reused`） |

- `PUT`・`DELETE` はもともと冪等なので、キーを要求しない。
- SDK は、書き込みの再試行のときにキーを自動で付ける。

### 5.4 本文の形式

- **メッセージの本文は、公開の「リッチテキスト v1」として JSON で受け渡す。** 中身は本文の AST（[ADR-0006](../decisions/0006-message-body-ast.md)、[messaging.md](messaging.md) の「本文（AST）」）の v1 と同じ形から始める。
- ただし、**公開の形と内部の AST を分ける。** `packages/contract/public/v1` に公開用の Zod スキーマを別に置き、内部の AST との変換関数を持つ。内部の AST の版を上げても、公開の v1 の形は変換で保つ。表せない新しいノードは、公開の v1 では `text` として返す。
- 書き込みでは、リッチテキストの代わりに `text`（プレーンテキスト）も受け付ける。メンションは `<@member_id>`、チャンネルへのリンクは `<#channel_id>` の形にする（MCP の `post_message` と同じ。[mcp.md](mcp.md) の 4 節）。サーバーは Markdown を解釈しない（ADR-0006 の方針）。
- アプリは、本文に加えて `ui_blocks`（宣言的な UI。[apps.md](apps.md) の 10 節）を付けられる。`ui_blocks` を付けるときも、通知・検索・読み上げに使う本文は必ず付ける。
- 上限（長さ、JSON の大きさ、入れ子の深さ）は内部と同じ（[messaging.md](messaging.md) の「上限」）。超えたら 413 か 400。

## 6. 契約と OpenAPI

- ルートは `@hono/zod-openapi` の `OpenAPIHono` と `createRoute` で定義する。ADR-0008 が「外部公開 API が必要になったときに移る」とした形である。スキーマは `packages/contract/public/v1` の Zod スキーマ（`.openapi()` でメタデータを付ける）を使う。
- OpenAPI の文書（3.1）を生成し、`packages/contract/public/v1/openapi.json` としてコミットする。CI で再生成し、差分があるのに契約の変更の承認がなければ失敗させる（ADR-0008 の Confirmation と同じ考え方）。`@hono/zod-openapi` は `getOpenAPI31Document`（エンドポイントなら `doc31`）で 3.1 の文書を出せる（[README](https://github.com/honojs/middleware/blob/main/packages/zod-openapi/README.md)）。Events API は `app.openAPIRegistry.registerWebhook`（`@asteasolutions/zod-to-openapi` の `OpenAPIRegistry`。[README](https://github.com/asteasolutions/zod-to-openapi#defining-routes--webhooks)）で登録すれば、3.1 の生成器が `webhooks` の節に出す（2026-09-26 にソースで確認）。
- 互換性を壊す変更の検知に、OpenAPI の差分の検査の道具（例：oasdiff）を CI に入れる。フィールドの削除・型の変更・必須化・列挙値の削除・ステータスの削除を、`/v1` の中では失敗させる。
- 公開用のスキーマは、内部のスキーマを直接 import しない。内部の項目（`body_format`、`content_seq` など）が、うっかり公開の契約に入らないようにするため。lint で `packages/contract/public` から内部のスキーマへの import を禁止する。
- `public-api` のハンドラーも、`c.json()` にステータスを明示する規則を守る（AGENTS.md）。

## 7. MCP・内部 API との関係

```
                 ┌───────────── packages/domain（サービス関数）──────────────┐
Web ─▶ api（Hono RPC, /api/...）─┤ postMessage, listHistory, search, addReaction ... │─▶ authorization.ts ─▶ DB（RLS）
アプリ ─▶ public-api（/v1/...）──┤                                                  │
AI ─▶ mcp（MCP ツール）─────────┘                                                  │
```

- **3 つの面は、同じサービス関数を呼ぶ。** 権限の判定（ADR-0005）、テナントのコンテキスト（ADR-0009）、冪等性、監査はサービス関数の側にあり、面ごとに書き直さない。
- 面が持つのは、認証、入出力の形の変換、スコープの確認、レート制限だけにする。
- **面どうしで HTTP を呼び合わない。** MCP が公開 API を呼ぶと、トークンの横流し（MCP の仕様で禁止）になり、レート制限も二重になる。
- スコープの語彙は MCP と共通にする（[apps.md](apps.md) の 6 節）。MCP のトークンと公開 API のトークンは `aud` で分け、互いに使えない。
- MCP のツールの入出力は、今後、公開 API のリソースの形に寄せる（例：`read_channel_history` の結果のメッセージを、公開のメッセージの形の部分集合にする）。MCP 側の変更は mcp.md の方針（新しいツール名で出す）に従う。

## 8. 版と廃止

### 8.1 互換性の規則

`/v1` の中で行ってよい変更（互換性のある変更）：

- 新しいエンドポイント、任意の入力項目、応答の項目、エラーの `code`、イベントの種類の追加
- 列挙値の追加（すべての列挙は「開いた列挙」と文書に書き、クライアントに未知の値の扱いを求める）
- レート制限の値の変更（tier の割り当ての変更は、事前の告知を要する）

互換性を壊す変更（`/v1` の中では行わない）：

- 項目・エンドポイントの削除、名前・型・意味の変更、任意の入力の必須化
- エラーのステータスの変更、ページングの並びの変更
- スコープの意味を狭める・広げる変更

### 8.2 版の上げ方

- **大きな版は URL に持つ（`/v1`、`/v2`）。** 日付の版をヘッダーで選ぶ方式（Stripe 型）は、1 つのコードで多くの版を保つ変換の層が要り、今の規模に合わない。
- 新しい版を出したら、古い版は **最低 12 か月** 動かし続ける。
- 版の中で個別のエンドポイント・項目を廃止するときは、代わりを先に出し、**最低 6 か月** の告知の後に止める。止めるのは次の大きな版を出すときに限る（`/v1` の中では止めない。告知だけ行う）。
- 例外：セキュリティ上の理由で、すぐに止める必要があるもの。告知と同時に止めてよい。判断は Dev（テックリード）と PM が行い、記録を残す。

### 8.3 告知の手段

| 手段 | 内容 |
| --- | --- |
| `Deprecation` ヘッダー（RFC 9745） | 廃止が決まった操作の応答に付ける。値は廃止を決めた時刻 |
| `Sunset` ヘッダー（RFC 8594） | 止める予定の日時 |
| `Link: <...>; rel="deprecation"` | 移行の手引きの URL |
| 開発者向けの変更履歴 | すべての変更（互換性のある変更を含む） |
| 開発者へのメール | 廃止する操作を直近 30 日に呼んだアプリの所有者へ、告知時・3 か月前・1 か月前に送る |
| 開発者コンソール | アプリごとに、廃止予定の操作の呼び出し数を出す |

- 廃止予定の操作の呼び出しを、アプリごとのメトリクスで数える（9 節）。止める前に、呼び出しが残っているアプリへ個別に連絡する。
- Events API のペイロードの版（[apps.md](apps.md) の 7.2 節）も、同じ期間と手段で扱う。

## 9. 観測

- メトリクスに `app_id` と `endpoint`（ルートの型）のラベルを付ける。`app_id` のカーディナリティは、上位 N 件＋「その他」に丸める（[observability.md](observability.md) の 3 節と同じ規則）。`workspace_id` も同じ。
- アプリの所有者は、開発者コンソールで、自分のアプリの呼び出し数、エラー率（`code` ごと）、429 の件数、遅延、廃止予定の操作の呼び出し数を見られる。値はワークスペースをまたいだ集計だけにし、メッセージの中身や他のアプリの情報を含めない。
- リクエストのログには、パス（ID のみ）、`code`、トークンの `token_id`、`app_id`、`installation_id` を残す。本文、検索語、トークンの秘密は残さない。Incoming Webhook の URL は秘密を含むので、パスを伏せて記録する。
- 監査ログ（[ADR-0018](../decisions/0018-audit-log.md)）：管理に関わる操作（チャンネルの作成・アーカイブ、他人のチャンネルへの招待）と、トークンの発行・入れ替え・取り消しを、行為者の種類 `bot` として残す。通常の投稿と読み取りは残さない（ADR-0018 の方針）。
- 合成監視（[observability.md](observability.md)）に、公開 API での「投稿 → 履歴で取得」を加える。

## 10. SDK と文書

- **公式の SDK は TypeScript の 1 つだけ** を作る。OpenAPI から型と薄いクライアントを生成し、手で書く部分は次に限る：ページングの反復、429 と `Retry-After` に従う再試行、`Idempotency-Key` の自動付与、Events API とインタラクティブ機能の署名の検証（[apps.md](apps.md) の 8 節）。
- 他の言語は、OpenAPI からの生成に任せる。署名の検証の手順は、言語に依らない形で文書に書き、テスト用のベクター（入力と期待する署名）を公開する。
- 本家の Bolt のような、アプリを作るためのフレームワークは作らない（需要を見て判断する）。
- 文書は OpenAPI から生成した参照と、手で書く手引き（認証、ページング、エラー、版と廃止、アプリの作り方）からなる。

## 11. 開発用のワークスペース

- 開発者は、無料の **開発用のワークスペース**（`workspaces.kind = 'developer'`）を作れる。本番と同じ環境の中の、通常のワークスペースである。専用のサンドボックスの環境（別の URL）は持たない。環境を分けると、本番との挙動の差が問題の源になるため。
- 開発用のワークスペースの制限（メンバー数、保存容量、保持期間）は、開発用の区分の entitlement（[ADR-0032](../decisions/0032-plans-and-entitlements.md) の `limit.*`）で持つ。値は 15 節の決定のとおり、本家の開発用のサンドボックスに合わせる。
- 開発用のワークスペースでは、審査の前の配布型のアプリ（[apps.md](apps.md) の 4 節）をインストールできる。通常のワークスペースではできない。
- レート制限の tier は、本番と同じにする。開発中に上限に当たる経験を、本番の前にしてもらうため。
- テストデータは、開発用のワークスペースを作るときに選べるひな形（ダミーのメンバー 7 人、チャンネル、スレッド、リアクション）で入れる。ダミーのメンバーはボットと同じく `account_id IS NULL` で、ログインできず、上限の人数に数えない。作るための公開の API は持たない（15 節の決定）。

## 12. プランとエンタイトルメント

プランの仕組みは枠組みだけで、値は仮である。課金は範囲外。ワークスペースの entitlement（[ADR-0032](../decisions/0032-plans-and-entitlements.md)。`limit.*` と `feature.*`）で持つ。

| entitlement | 内容 | 値 |
| --- | --- | --- |
| `limit.api.*` | 各 tier の値（[rate-limiting.md](rate-limiting.md)） | ADR-0032 の表 |
| `limit.apps.installed` | インストールできるアプリの数 | ADR-0032 の表 |
| `feature.api_user_tokens` | ユーザーのトークンを使うアプリを許すか | 全プランで有効。ユーザーの機微なスコープ（`messages:read` など）は、ワークスペースの方針にかかわらず管理者の承認を要する（[apps.md](apps.md) の 6.1 節） |
| `feature.apps_admin_policy` | 管理者の承認・許可リストの設定（[apps.md](apps.md) の 6.3 節） | 全プランで有効。本家もアプリの承認を全プランで提供する（[Manage app approval for your workspace](https://slack.com/help/articles/222386767-Manage-app-approval-for-your-workspace)）。既定の方針は 6.3 節のとおり |

- entitlement は権限の判定を置き換えない。entitlement で許されていても、ADR-0005 の判定とスコープは必ず通す。

## 13. 段階ごとの変化

| 段階 | 内容 |
| --- | --- |
| S1 | 公開 API は E12 で、release フラグ（`release.public_api_v1`）の裏から段階的に出す。社内のアプリ → 開発用のワークスペース → 一般 |
| S2 | 呼び出しが増えたら `public-api` のタスクを増やす。読み取りは reader を増やして受ける。重い一覧（`tier-read-heavy`）の比率を見て、キャッシュを検討する |
| S3 | `public-api` はセルごとに置き、パスの `workspace_id` でセルへ振り分ける。ユーザーのトークンの認可サーバー（Better Auth）はセルの外（アイデンティティ面）に置く。ボットのトークンの検証はセルの中で行う（`api_tokens` はテナントテーブル） |

## 14. テスト

- 契約：OpenAPI のスナップショットと、互換性を壊す変更の検査。
- 性質ベーステスト：任意のトークンと操作について、公開 API が返すデータは、同じメンバーが内部の API で読めるデータの部分集合であり、スコープが許す範囲に収まる（MCP の性質と同じ形）。
- 表駆動テスト：4 節のトークンの判別と、[identity-and-access.md](identity-and-access.md) の 6.5 節のスコープの表。
- 冪等性：5.3 節の決定表。同じ `Idempotency-Key` での並行の要求で、作られる行が 1 つだけ。
- 別のワークスペースのトークン、`aud` が MCP のトークン、取り消し済みのトークンを拒否する。

## 15. 未解決の問い

- 管理の API（`admin:*`）をどこまで、いつ出すか。SCIM（[identity-and-access.md](identity-and-access.md) の 5.4 節）との重なりの整理。
- 差分取得に相当する公開のイベントの読み出し（Events API の取りこぼしを、アプリが自分で埋める手段）を出すか。
- ボットのトークンを、短命のアクセストークンと入れ替えのためのトークンの組（本家のトークンのローテーション）にするか。今は無期限＋入れ替えの API。
- 公開 API の `ETag` と条件付きの更新。
- 開発用のワークスペースの制限の値と、ダミーのメンバーの作成。

### 決定（2026-09-26、既定案）

- **`admin:*` の管理の API は出さない。** 本家の `admin.*` の API は Enterprise の組織向けで、Enterprise Grid は範囲外（[intent.md](../intent.md) の Non-goals）。メンバーの作成・更新・無効化は SCIM（Business+ 以上、E8）に一本化する。監査ログの読み出しは、本家の Audit Logs API（Enterprise だけ、`auditlogs:read`、組織の owner がインストールする）に倣い、Enterprise だけの `auditlogs:read` として後の版で出す（roadmap の E12 `audit-logs-api`）（[Audit Logs API](https://docs.slack.dev/admins/audit-logs-api/)、2026-09-26 に確認）。
- **公開のイベントの読み出し（取りこぼしの再取得）は出さない。** 本家の Events API も、再送（3 回まで、すぐ・1 分後・5 分後）はするが、取りこぼしたイベントを読み直す API は持たない。アプリは履歴の API（`GET .../channels/{id}/messages` の `after_seq`）で埋める。本システムの再試行の予定は [apps.md](apps.md) の 7.4 節のまま（[The Events API](https://docs.slack.dev/apis/events-api/)、2026-09-26 に確認）。
- **ボットのトークンのローテーションは、アプリごとに選べるようにする。** 本家と同じく、アプリの設定で有効にすると、アクセストークンは 12 時間で失効し、リフレッシュトークンで更新する。一度有効にしたら戻せない。既定は今のとおり無期限＋入れ替えの API（[Using token rotation](https://docs.slack.dev/authentication/using-token-rotation/)、2026-09-26 に確認）。roadmap の E12 に `bot-token-rotation` を加えた。
- **`ETag` と条件付きの更新は、v1 では出さない。** 本家の Web API にもない。後から加えても互換性を壊さない（8.1 節）ので、需要が出たら加える。
- **開発用のワークスペースは、本家の開発用のサンドボックスに合わせる。** メンバーは 8 人まで（owner・admin を含み、ボットとダミーのメンバーを除く）、ゲストは 2 人まで。1 人が同時に持てるのは 2 つまで、30 日で 10 個まで作れる。有効期間は 6 か月で、延長できる。保存容量・履歴などは Free と同じ（ADR-0033）。作るときに、ダミーのメンバー 7 人とチャンネル・スレッドを含むひな形を選べる。本家のサンドボックスは 1 つに 5 つのワークスペースを持てるが、Enterprise Grid は範囲外なので、1 つの開発用のワークスペースを単位にする（[Developer sandboxes](https://docs.slack.dev/tools/developer-sandboxes/)、2026-09-26 に確認）。

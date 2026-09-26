# API and integrations: Notion

公開 API、連携（インテグレーション）の権限、レート制限、Webhook、インポートとエクスポート、リモートの MCP サーバー。方針は [ADR-0024](../decisions/0024-integration-access-model.md)（公開 API と連携の権限）、[ADR-0025](../decisions/0025-webhook-delivery.md)（Webhook）、[ADR-0026](../decisions/0026-remote-mcp-server.md)（MCP）にある。

本家の API の形（リソース、版のヘッダー、連携の種類、能力、上限、Webhook）に寄せる。名前・ヘッダー・接頭辞・ドメインは本家のものを使わない（[リポジトリの ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。本家の SDK との互換は目的にしない。

## 1. 位置づけ

| 項目 | 方針 |
| --- | --- |
| 何のためか | 連携・社内のスクリプト・AI エージェントが、共有されたページとデータベースを読み書きする |
| 内部の API との関係 | 内部の API（Web クライアント用）は互換性を約束しない。公開 API は別の面として持ち、同じドメイン層（サービス関数）と判定関数（ADR-0004）を通る |
| 誰の権限で動くか | **連携そのもの（ボット）が主体。** 連携は、明示的に共有されたページとその子孫だけを読める。その上に、能力（capabilities）を上限として重ねる（3 節） |
| 変更の経路 | 書き込みは、エディタと同じトランザクション（ADR-0005）に変換して送る。同時に開いている利用者の画面に、そのまま反映される |
| 提供の時期 | E7（MVP に含む。intent.md） |

## 2. 構成

```
連携・スクリプト・AI エージェント
   │ HTTPS  Authorization: Bearer <token>、<Brand>-Version: 2026-09-26
   ▼
CloudFront + WAF ─▶ ALB ─▶ public-api（ECS Fargate）
   │ 1. トークンの検証 → 連携とワークスペースを解決
   │ 2. 版の変換（リクエストを最新の形へ）
   │ 3. レート制限（連携ごと・ワークスペースごと）
   │ 4. ハンドラー → サービス関数 → can(bot, action, block)
   │ 5. 版の変換（応答を要求された版の形へ）
   ▼
Aurora（RLS、論理シャード）
```

- `api.<domain>` で独立したサービスにする。Cookie を受け付けず、CORS を許さない（Slack の public-api.md と同じ）。外部の呼び出しの急増が、エディタの反映（NFR-001）に響かないようにする。障害時は ops フラグで公開 API だけを止める。
- 読み取りは Aurora の reader。書いた直後の読み取りは writer。
- パスにワークスペースを含めない（本家と同じ）。トークンが 1 つのワークスペースに結び付き、セルへの振り分け（S3）はトークンの `workspace_id` から行う。

## 3. 連携とトークン

### 3.1 連携の種類

本家の種類に合わせる（[Authorization](https://developers.notion.com/docs/authorization)、2026-09-26 に確認）。

| 種類 | 本家 | 本システム | 時期 |
| --- | --- | --- | --- |
| 内部の連携 | ワークスペースの所有者が作る。静的なトークン | 同じ。トークン `<brand>_int_{id}_{secret}`（チェックサム付き） | E7 |
| 公開の連携 | OAuth 2.0。複数のワークスペースに入れる。認可のときにページを選ぶ | OAuth 2.1（認可コード、PKCE、機密クライアント）。アクセストークン 1 時間、リフレッシュトークン 90 日（使うたびに入れ替える） | E7 の後半 |
| 個人のアクセストークン | 利用者の権限で動く静的なトークン（2026-05 に追加。期限 7 日〜1 年） | MVP では持たない。AI エージェントは MCP（8 節）を使う | 後 |

- トークンの `{id}` は、`workspace_id` とトークンの ID から作る。API はトークンの形から `workspace_id` を得て論理シャードへ振り分け、`api_tokens` の行を主キーで引き、ハッシュを定数時間で比べる（12 節）。`global` にトークンの索引を持たない。
- トークンは DB にハッシュで持つ（Slack と同じ）。接頭辞は他のサービスと重ならないことを確かめ、シークレットスキャンのパートナープログラムに登録する（リポジトリ共通の ADR-0006）。
- 内部の連携を作れるのは、ワークスペースの所有者だけ（本家と同じ）。管理者は、公開の連携の導入を許可制にできる。

### 3.2 ページへのアクセス

**連携は、明示的に共有されたページと、その子孫だけを読める**（本家と同じ）。ワークスペースのメンバーの権限は引き継がない。

| 付与の方法 | 内容 |
| --- | --- |
| ページの「接続を追加」 | 全権限を持つ人が、ページの共有の設定に連携を加える（ACL に `bot:{integration_id}` の項目が入る） |
| 公開の連携の認可 | 認可の画面のページの選択で、選んだページに連携を加える。選べるのは、認可する人が全権限を持つページだけ（本家と同じ） |
| API での作成 | 連携が作ったページは、作った連携に共有された状態で作る |

- 連携は ACL の主体の 1 つ（`bot`）として判定関数に入る（ADR-0004、[permissions-and-sharing.md](permissions-and-sharing.md)）。継承も人と同じ規則。
- 連携の権限の水準は、共有したときの水準（全権限・編集・コメント・閲覧）と、連携の能力（3.3 節）の小さい方。
- 共有を外すと、次の呼び出しから読めない（判定の結果のキャッシュの無効化は ADR-0004 と同じ）。
- ページのメンション・リレーション・ロールアップ・同期ブロックで、共有されていないページの中身を返さない。読めないページへの参照は ID だけ返す（本家と同じく、参照先を読めないことを示す）。

### 3.3 能力（capabilities）

本家と同じ区分にする（[Capabilities](https://developers.notion.com/reference/capabilities)）。

| 能力 | 使える操作 |
| --- | --- |
| 内容の読み取り | ページ・ブロック・データベース・データソースの取得、問い合わせ、検索 |
| 内容の更新 | 既存のページ・ブロックの更新、ゴミ箱への移動 |
| 内容の挿入 | ページ・ブロック・データベースの作成 |
| コメントの読み取り / 挿入 | コメントの取得 / 作成 |
| 利用者の情報 | なし / メールアドレスなし / メールアドレスあり |

- 能力にない操作は 403（`restricted_resource`）。
- 公開の連携の能力は、認可の画面に示す。

## 4. リソースと版

### 4.1 版のヘッダー

- **`<Brand>-Version: YYYY-MM-DD` を必須にする**（本家の `Notion-Version` と同じ形。[Versioning](https://developers.notion.com/reference/versioning)）。初版は `2026-09-26`。
- 互換性を壊す変更だけで新しい版を出す。エンドポイントや任意の引数の追加は、すべての版に同時に入る（本家と同じ）。
- 版の違いは、ハンドラーの外側の変換層（リクエストを最新の形へ、応答を要求された版の形へ）で吸収する。ハンドラーは最新の版だけを知る。
- 古い版は、本家と同じく期限を決めずに保つ。変換の数が保守の負担になったら、利用の実績を見て、告知の後に外す（告知から 12 か月以上）。
- ヘッダーがない・知らない版は 400。

### 4.2 リソース

本家のリソースの分け方に合わせる。本家の 2025-09-03 版は、データベース（入れ物）とデータソース（表）を分けた（[Changelog](https://developers.notion.com/page/changelog)）。本システムも同じ形で出す。データベースが複数のデータソースを持つかは [databases.md](databases.md) の決定に従い、持たないうちは 1 対 1 にする。

| リソース | 操作 | 能力 |
| --- | --- | --- |
| `POST /v1/pages`、`GET` / `PATCH /v1/pages/{id}` | 作成、取得、プロパティ・アイコン・カバー・`in_trash` の更新 | 挿入 / 読み取り / 更新 |
| `GET /v1/pages/{id}/properties/{property_id}` | プロパティの値（件数の多いリレーションなどをページングで） | 読み取り |
| `POST /v1/pages/{id}/move` | 移動 | 更新 |
| `GET /v1/pages/{id}/markdown`、`PATCH` | ページの本文を Markdown で取得・更新（本家は 2026-02 に追加） | 読み取り / 更新 |
| `GET` / `PATCH` / `DELETE /v1/blocks/{id}` | 取得、更新、ゴミ箱へ | 読み取り / 更新 |
| `GET` / `PATCH /v1/blocks/{id}/children` | 子の一覧、子の追加（`position` で位置を指定） | 読み取り / 挿入 |
| `POST /v1/databases`、`GET` / `PATCH /v1/databases/{id}` | データベース（入れ物） | 挿入 / 読み取り / 更新 |
| `POST /v1/data_sources`、`GET` / `PATCH /v1/data_sources/{id}` | データソース（スキーマ） | 挿入 / 読み取り / 更新 |
| `POST /v1/data_sources/{id}/query` | 行の問い合わせ（フィルタ・並べ替え。[databases.md](databases.md) の問い合わせの経路） | 読み取り |
| `GET /v1/users`、`GET /v1/users/{id}`、`GET /v1/users/me` | 利用者、連携自身 | 利用者の情報 |
| `GET` / `POST /v1/comments`、`PATCH` / `DELETE /v1/comments/{id}` | コメント（[comments-and-notifications.md](comments-and-notifications.md) の 7 節） | コメント |
| `POST /v1/search` | タイトルの検索（ページ・データソース）。並べ替えは関連度か最終編集 | 読み取り |
| `POST /v1/file_uploads`、`POST .../{id}/send` | ファイルのアップロード | 挿入 |

- ビューの API（本家は 2026-03 に追加）は、E5 のビューの形が固まってから加える。
- 検索は本家と同じく**タイトルだけ**を対象にする（[Search](https://developers.notion.com/reference/post-search)）。連携の検索は、`bot:{integration_id}` を主体のキーにして同じ索引を使う（[search.md](search.md)）。全文検索は MCP の `search` で提供する（8 節）。
- 本家と同じ JSON の約束に合わせる：`object` の属性、`snake_case`、ISO 8601、空文字列を使わず `null`。ID は UUIDv7（ADR-0002）。本家の ID は UUIDv4 で、形は同じ。
- 書き込みは、1 リクエストを 1 トランザクション（ADR-0005）にする。1 つのリクエストの中の変更は、全部が反映されるか、何も反映されないか。
- 冪等性：`POST` は `Idempotency-Key` ヘッダーを受け付け、24 時間同じ応答を返す。本家には冪等性のキーがなく、書き込みの 503 は `additional_data.retry_guidance` を見て再試行を判断させる（[Request limits](https://developers.notion.com/reference/request-limits)、2026-09-27 に確認）。`Idempotency-Key` は本システムの独自の拡張である。

### 4.3 ページングと上限

| 項目 | 値 | 本家 |
| --- | --- | --- |
| ページング | `start_cursor`・`page_size`（既定 100、最大 100）、応答に `has_more`・`next_cursor` | 同じ（[Pagination](https://developers.notion.com/reference/pagination)） |
| リクエストの大きさ | 500 KB | 同じ（[Request limits](https://developers.notion.com/reference/request-limits)） |
| 1 リクエストのブロック | 1,000 | 同じ |
| 配列（子のブロック、リッチテキスト） | 100 要素 | 同じ |
| リッチテキストの 1 要素・URL | 2,000 文字 | 同じ |
| メール・電話番号 | 200 文字 | 同じ |
| リレーション・人・複数選択 | 100 | 同じ |
| 子の追加の入れ子 | 2 段まで | 同じ（[Append block children](https://developers.notion.com/reference/patch-block-children)、2026-09-27 に確認） |

## 5. レート制限

本家に合わせる（[Request limits](https://developers.notion.com/reference/request-limits)）。

| 単位 | 上限 |
| --- | --- |
| 連携（トークン）ごと | 1 分に 180 回（平均で毎秒 3 回）。Business・Enterprise の相当は 1 分に 600 回 |
| ワークスペースごと | 全連携の合計に上限を持つ（値は負荷試験で決める） |
| エンドポイントごと | 重い操作（問い合わせ、検索、Markdown の更新）に別の上限 |

- 1 分の窓の中では、どの速さで使ってもよい（本家と同じ。トークンバケット）。
- 超えたら 429、エラーコード `rate_limited`、`Retry-After`（連携ごとの上限なら最大 60 秒）。どの上限に当たったかを `additional_data.rate_limit_reason` で返す（本家と同じ形）。
- 実装は Slack の rate-limiting.md と同じ部品（ElastiCache のトークンバケット）を使う。

## 6. Webhook

方針は [ADR-0025](../decisions/0025-webhook-delivery.md)。本家に合わせる（[Webhooks](https://developers.notion.com/reference/webhooks)、[Event types & delivery](https://developers.notion.com/reference/webhooks-events-delivery)）。

### 6.1 購読と確認

1. 連携の設定で、HTTPS の URL と、受け取るイベントの種類を登録する。
2. 登録した URL に、一度だけ `verification_token` を含む POST を送る。開発者がそのトークンを設定画面に入れると、購読が有効になる（本家と同じ）。
3. 以後の配送には、`X-<Brand>-Signature: sha256=<HMAC-SHA256(verification_token, 本文)>` を付ける（本家は `X-Notion-Signature`）。

### 6.2 イベント

| 種類 | イベント | まとめ |
| --- | --- | --- |
| ページ | `page.created`、`page.content_updated`、`page.properties_updated`、`page.moved`、`page.deleted`、`page.undeleted`、`page.locked`、`page.unlocked` | ロック以外はまとめる |
| データベース | `database.created`、`database.moved`、`database.deleted`、`database.undeleted` | まとめる |
| データソース | `data_source.created`、`data_source.content_updated`、`data_source.schema_updated`、`data_source.moved`、`data_source.deleted`、`data_source.undeleted` | まとめる |
| コメント | `comment.created`、`comment.updated`、`comment.deleted` | まとめない |

- **本文は送らない。** 封筒は `id`、`timestamp`、`workspace_id`、`subscription_id`、`integration_id`、`type`、`authors`、`entity`（ID と種類）、`data`（親、更新したブロック・プロパティの ID）、`attempt_number`（本家と同じ）。受け手は API で最新の内容を取りに来る。そのため、配送の時点の権限で API が判定する。
- **権限**：イベントの対象を、その連携が配送の時点で読めるときだけ送る。コメントのイベントは、コメントの読み取りの能力を要する（本家と同じ）。
- **まとめ**：ページ単位で 30 秒の窓でまとめる（本家は「通常 1 分未満」）。ロックとコメントは数秒以内に送る。
- 本家の `accessible_by` は、連携の bot と、その連携に接続した利用者のうち、対象にアクセスできる者の一覧で、公開の連携にだけ付く（[Event types & delivery](https://developers.notion.com/reference/webhooks-events-delivery)、2026-09-27 に確認）。受け手が API で権限を確かめれば足りるので、本システムは持たない。

### 6.3 配送

| 項目 | 設計 |
| --- | --- |
| 保証 | 少なくとも 1 回。順序は保証しない（本家と同じ）。受け手は `id` で重複を除く |
| 目標 | 発生から 1 分以内（p95）、5 分以内（p99）。本家は「5 分以内、多くは 1 分以内」 |
| 再試行 | 最大 8 回、指数バックオフで、最後は約 24 時間後（本家と同じ） |
| タイムアウト | 5 秒 |
| 無効化 | 3 日続けて失敗した購読を停止し、連携の所有者にメールで知らせる |
| 送信元 | 隔離した egress（6.4 節） |

### 6.4 外向きの通信の隔離

開発者が指定した任意の URL へ送るので、SSRF の踏み台になりうる。Slack の app-egress（Slack の apps.md の 13 節）と同じ形にする。

- 配送の Worker は、SQS の `webhook-delivery` のキューから配送を受け取り、署名した本文を、VPC に接続しない Lambda（`webhook-egress`）に渡す。Lambda の権限はログの書き込みだけ。署名の秘密は Lambda に渡さない。
- 名前解決の後の IP を検査し、プライベート・リンクローカル・ループバック・メタデータのアドレスを拒否する。リダイレクトは追わない。
- 送信元の IP の一覧を公開する（受け手の許可リストのため）。
- 連携ごとの同時実行の上限で、遅い受け手が他の配送を待たせないようにする。

## 7. インポートとエクスポート

### 7.1 インポート

本家は、テキスト、Markdown、Word、CSV、HTML、PDF、ZIP と、他の道具（Evernote、Trello、Google Docs など）からの取り込みを持つ（[Import data into Notion](https://www.notion.com/help/import-data-into-notion)）。

| 形式 | 変換 | 時期 |
| --- | --- | --- |
| Markdown（`.md`、ZIP の中の複数） | 見出し・リスト・ToDo・コード・引用・表・画像のリンクをブロックへ。ZIP のフォルダの構造を子ページへ | E7 |
| CSV | 1 行を 1 ページ（行）、列をプロパティにしたデータベース。型は値から推定（数値・日付・チェック・選択）し、推定できなければテキスト | E7 |
| HTML | 見出し・段落・リスト・表・画像をブロックへ。スクリプトとスタイルは捨てる | E7 |
| テキスト | 段落へ | E7 |
| Word、PDF、他の道具（Confluence、Evernote、Trello など） | — | 後 |

- 流れ：ファイルを S3 に署名付き URL で上げる → Worker が解析し、ブロックの木を組み立てる → 1,000 ブロックずつのトランザクションで書く → 完了を通知する。途中で失敗したら、作ったページをゴミ箱へ移す。
- 上限：1 ファイル 50 MB、ZIP は 5 GB・1 万ファイル（本家の値に合わせる）。
- 解析は隔離した Worker で行う（HTML・ZIP の解析は信頼できない入力。ZIP の展開後の大きさと、パスの `..` を検査する）。
- インポートしたページは、インポートした人の権限で、指定した親の下に作る。

### 7.2 エクスポート

本家に合わせる（[Export your content](https://www.notion.com/help/export-your-content)）。

| 形式 | 内容 | 時期 |
| --- | --- | --- |
| Markdown と CSV | ページは Markdown、データベースは CSV と各行の Markdown。子ページはフォルダに | E7 |
| HTML | 各ページを HTML に。任意でコメントを含める | E7 |
| PDF | ページを PDF に。用紙と倍率を選ぶ | E7 の後半 |
| ワークスペースのエクスポート | 所有者だけ。全体を Markdown と CSV、または HTML で ZIP に。完了をメールで知らせ、リンクは 7 日で切れる | E7 |

- **エクスポートは、実行した人の権限で行う。** 読めないページは含めない（本家と同じ）。ワークスペースのエクスポートも、所有者が読めるページだけ。読めないページへのメンションは「アクセス権のないページ」として書く。
- 流れ：API がジョブを作る → Worker が reader から木をたどって書き出す → S3（KMS で暗号化）に ZIP → 署名付き URL（7 日）を通知する。
- PDF は、隔離した Worker のヘッドレスブラウザで HTML から作る。外部への通信を持たせない（画像は事前に取り込む）。
- 大きなワークスペースは時間がかかる（本家は最大 30 時間）。論理シャードごとの同時実行を 2 に絞り、DB への負荷を抑える。
- Enterprise では、管理者がエクスポートを無効にできる（本家と同じ。MVP の後）。
- エクスポートの実行を監査ログに残す（[security.md](security.md)）。

## 8. リモートの MCP サーバー

方針は [ADR-0026](../decisions/0026-remote-mcp-server.md)。Slack の ADR-0028（Slack の mcp.md）の形をそのまま使う。

| 項目 | 設計 |
| --- | --- |
| 場所 | `mcp.<domain>/mcp`。独立したステートレスのサービス（ECS Fargate） |
| プロトコル | MCP の 2026-07-28 版（Streamable HTTP、セッションなし）。古い版にもステートレスに応える |
| 認可 | OAuth 2.1、PKCE、RFC 9728、CIMD。DCR は提供しない。本家の MCP も OAuth だけ（[Get started with Notion MCP](https://developers.notion.com/docs/get-started-with-mcp)） |
| 誰の権限か | **同意した利用者の権限。** 連携（ボット）ではない。利用者が読めるページすべてが対象になる（本家と同じ） |
| トークン | `aud` は mcp。受け取ったトークンを他のサービスへ横流ししない。ドメイン層を直接呼び、判定関数を通す |

### 8.1 ツール

本家の MCP のツール（[Supported tools](https://developers.notion.com/docs/mcp-supported-tools)）のうち、Notion AI とエージェントに関わらないものに合わせる。

| ツール | 内容 | スコープ |
| --- | --- | --- |
| `search` | 全文検索（[search.md](search.md) と同じ。場所・作成者・日付で絞る） | `content:read` |
| `fetch` | ページ・データベース・データソースを Markdown で取得 | `content:read` |
| `query_data_source` | データソースの行の問い合わせ（フィルタ・並べ替え） | `content:read` |
| `get_comments` | ページのディスカッションとコメント | `comments:read` |
| `get_users`、`get_teams` | 利用者（メールアドレスは返さない）、チームスペース | `users:read` |
| `create_pages`、`update_page`、`move_pages`、`duplicate_page` | ページの作成・更新（Markdown）・移動・複製 | `content:write` |
| `create_database`、`update_data_source` | データベースの作成、スキーマの変更 | `content:write` |
| `create_comment` | コメント | `comments:write` |

- 本家の AI の検索、スキル、カスタムエージェント、会議のメモのツールは持たない（intent.md の対象外）。
- 書き込みのスコープは既定で無効。ワークスペースの管理者と利用者の両方が許可したときだけ使える。
- 上限：`search` は利用者ごとに 1 分 30 回（本家と同じ）。それ以外は 5 節の値を利用者ごとに適用する。
- ページの本文は第三者の書いたデータとしてツールの結果の `content` に入れ、指示として扱わないよう説明文に書く（Slack と同じ）。ツールの結果は 1 回 100 KB まで。
- MCP 経由の変更は、トランザクションに「〇〇（AI エージェント）経由」の属性を残し、ページの更新の欄に出す。
- すべての呼び出しを監査ログに残す（ID だけ。本文と検索語は残さない）。

### 8.2 AI エージェントを API の利用者として扱う

| 使い方 | 経路 | 権限 |
| --- | --- | --- |
| 利用者が自分のエージェントから使う | MCP | 利用者の権限（委任） |
| 自動化のエージェントが、決まったページだけを扱う | 内部の連携のトークンで公開 API | 共有されたページだけ（3.2 節） |
| 他社の AI 製品が、多くのワークスペースで使う | 公開の連携（OAuth）か MCP | 同上 |

- エージェントのための特別な権限は作らない。人・連携と同じ判定関数と上限を通る。
- 本家の MCP は、対話のない自動化の認可に未対応（同上の文書）。本システムも、自動化には内部の連携のトークンを使う。

## 9. 観測

- エンドポイント・版・連携ごとの呼び出し数、エラー率、遅延、429 の数。連携のラベルは上位 N 件＋「その他」に丸める。
- 版ごとの利用の割合（古い版を外す判断に使う）。
- Webhook：配送の遅れ、失敗率、停止した購読の数、egress での拒否の数（SSRF の試み）。
- インポート・エクスポート：ジョブの待ち時間、所要時間、失敗率。

## 10. テスト

- 権限のテスト（公開 API）：
  - 共有されていないページ、共有を外した直後のページ、共有された親から外へ移したページを、取得・子の一覧・問い合わせ・検索・プロパティ（リレーション・ロールアップ）で返さない。
  - 能力のない操作が 403。別のワークスペースのトークンで 404。
  - 性質ベーステスト：任意の木・共有の設定・移動の列で、連携が API で読めるページの集合が、`can(bot, read, page)` が真の集合と一致する。
- 版の変換：各版の固定の入出力（スナップショット）が変わらない。
- Webhook：署名の検証、読めない対象のイベントを送らない、再試行の回数と間隔、SSRF の宛先（Slack の ADR-0016 と同じ一覧）に送らない。
- インポート・エクスポートの往復：Markdown・CSV で書き出して取り込むと、対応する要素のブロックの木とプロパティが一致する。
- MCP：Slack の ADR-0028 と同じ適合の検査。MCP が返すデータは、同じ利用者が画面で読めるデータの部分集合。

## 11. 決定と持ち越し

2026-09-26 に、本家に寄せる既定案で次のとおり決めた（[README.md](README.md) の「決定」）。

- 個人のアクセストークンは MVP に入れない。AI エージェントは MCP（8 節）か内部の連携を使う（[roadmap.md](../roadmap.md) の「後回しにしたもの」）。
- 公開の連携のリフレッシュトークンは 90 日で、使うたびに入れ替える（3.1 節）。本家も更新のたびに新しいリフレッシュトークンを返す（[Authorization](https://developers.notion.com/guides/get-started/authorization)、2026-09-27 に確認）。本家の有効期間は公開されていない（未検証）。90 日は本システムの値である。
- ビューの API と `view.*` の Webhook は、E5 のビューの形が固まった後に、E7 の後半の Story として入れる。
- Webhook の署名の秘密は、本家と同じく `verification_token` を使う。別に入れ替える仕組みは MVP に入れない。

## 12. 表

連携・API・MCP・ジョブの表の最小の定義。列の型・制約の細部は、E7 の各 Story の `spec.md` で決める。どの表も論理シャード（`shardNNN`）に置き、`workspace_id` を持ち、主キーは `(workspace_id, id)`、索引は `workspace_id` を先頭にし、RLS を付ける（[data-model.md](data-model.md) の 1 節）。公開の連携の定義だけは `global.public_integrations` にある。

| 表 | 主な列 | 索引・一意 |
| --- | --- | --- |
| `integrations` | `id`、`name`、`bot_member_id`（`members` の `kind = bot` の行）、`capabilities`（3.3 節）、`created_by`、`created_at`、`disabled_at` | 一意 `(workspace_id, bot_member_id)` |
| `integration_installations` | `id`、`public_integration_id`（`global.public_integrations` の ID。外部キーは張らない）、`bot_member_id`、`capabilities`、`installed_by`、`installed_at`、`revoked_at` | 一意 `(workspace_id, public_integration_id)`（`revoked_at IS NULL` のもの） |
| `api_tokens` | `id`、`kind`（`internal` / `oauth_access` / `oauth_refresh`）、`integration_id` か `installation_id`、`bot_member_id`、`secret_hash`（SHA-256）、`expires_at`、`last_used_at`、`revoked_at`、`replaced_by`（リフレッシュトークンの入れ替え） | `(workspace_id, integration_id)`、`(workspace_id, installation_id)` |
| `webhook_subscriptions` | `id`、`integration_id` か `installation_id`、`url`、`event_types`、`verification_token`（署名に使うので、ハッシュではなく KMS で暗号化して持つ）、`status`（`pending` / `active` / `suspended`）、`failing_since`、`created_at` | `(workspace_id, status)`、`(workspace_id, integration_id)` |
| `webhook_deliveries` | `id`（イベントの `id`）、`subscription_id`、`event_type`、`entity_id`、`envelope`（本文を含まない封筒。6.2 節）、`attempt_number`、`next_attempt_at`、`status`（`pending` / `delivered` / `failed`）、`last_status_code`、`created_at`。時間でパーティションを切る | `(workspace_id, subscription_id, created_at)`、`(workspace_id, status, next_attempt_at)` |
| `idempotency_keys` | `bot_member_id`、`key`、`request_hash`、`response_status`、`response_body`、`created_at`、`expires_at`（24 時間） | 主キー `(workspace_id, bot_member_id, key)`、`(workspace_id, expires_at)` |
| `mcp_grants` | `id`、`kind`（`member`：利用者の同意 / `workspace`：管理者の許可）、`member_id`（`member` のとき）、`client_id`（CIMD の URL）、`scopes`、`granted_by`、`granted_at`、`revoked_at` | 一意 `(workspace_id, member_id, client_id)`（`kind = member` で `revoked_at IS NULL` のもの）、`(workspace_id, client_id)` |
| `import_jobs` | `id`、`requested_by`、`format`、`parent_page_id`、`upload_s3_key`、`status`（`queued` / `running` / `succeeded` / `failed`）、`progress`、`error`、`created_at`、`finished_at` | `(workspace_id, requested_by, created_at)` |
| `export_jobs` | `id`、`requested_by`、`scope`（`page` / `workspace`）、`root_page_id`、`format`、`include_comments`、`status`（同上）、`result_s3_key`、`expires_at`（7 日）、`error`、`created_at`、`finished_at` | `(workspace_id, requested_by, created_at)`、`(workspace_id, status)` |

- MCP のアクセストークンとリフレッシュトークンは、Slack の ADR-0028 と同じく、`global` の認可サーバーが発行して持つ。`api_tokens` には入れない。シャードの `mcp_grants` は、同意と管理者の許可だけを持ち、MCP サーバーは呼び出しのたびにこれを確かめる。
- ジョブの実行は SQS の `import-export` のキューで渡す（[capacity.md](capacity.md) の 2.6 節）。表は状態と再実行のために持ち、Worker が表を走査して拾わない。


# API and Rate Limits: X

公開 API の形（REST、バージョン、`tid` でのページング、エラー）、OAuth 2.0 とアプリ、トークンの形、レート制限（利用者・アプリ・エンドポイント・IP、画面と API の共通の桶、IETF の `RateLimit` のヘッダー）、使った量の計量とプラン、後の Webhook を決める。画面向けの App API も、利用者の上限（投稿・フォロー・DM の 1 日の数）は同じ桶を使う。

| ADR | 決定 |
| --- | --- |
| [0046](../decisions/0046-public-api-shape-and-oauth.md) | 公開 API は `https://api.<brand>.<domain>/v1/` の REST（JSON）。ID は 10 進の文字列。一覧は `tid` の範囲（`since_id`・`until_id`）と、署名した不透明な `next_token` で送る。認証は OAuth 2.0 の認可コード＋PKCE（S256 必須）と、公開の読み出しだけのアプリのトークン。トークンは `<brand>_` の接頭辞とチェックサムを持ち、SHA-256 で保存する。バージョンはパスの主の番号で、壊す変更は新しいバージョンにし、古いバージョンは 12 か月の告知の後に止める |
| [0047](../decisions/0047-rate-limit-token-buckets.md) | レート制限は、Valkey の上のトークンバケットを Valkey Functions で原子的に引く。桶は利用者・アプリ・利用者×アプリ・エンドポイント・IP の組で、1 つの要求が複数の桶を同時に引く（全部に余りがあるときだけ通す）。利用者の行動の上限（投稿・フォロー・DM・いいね）は画面と API で共通の桶にする。応答は IETF の `RateLimit-Policy`・`RateLimit`（draft-11）と `Retry-After`。Valkey が落ちたら、読み出しはタスクの中の近似の桶で続け、SMS の送信は止める |
| [0048](../decisions/0048-usage-plans-and-metering.md) | 公開 API は使った量で数える。数える単位は「返した投稿・利用者の件数」と「書き込みの回数」。計量は要求の処理の後に出来事として Firehose へ流し、日ごとに集計する。プランの月の上限は Valkey の数で強制する。MVP は計量と上限まで行い、請求の連携は MVP の後。Webhook（活動の API）も MVP の後 |

前提は、ID の形（[ADR-0002](../decisions/0002-post-ids-and-ordering.md)）、見える範囲の 1 つの関数（[ADR-0004](../decisions/0004-single-tenant-and-visibility.md)）、ブランドの名前を識別子に使わない規則（[リポジトリ共通の ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。

## 1. 目的と範囲

- 扱う：
  - 公開 API の形、資源、ページング、エラー、バージョンと廃止
  - 開発者のアカウント、アプリ、OAuth 2.0（PKCE）、アプリのトークン、トークンの形
  - レート制限：公開 API と、画面（App API）の利用者の行動の上限、認証の入口の上限
  - 使った量の計量、プランの上限
  - 活動の Webhook（MVP の後。形だけ）
- 扱わない：
  - 認可の画面（[accounts-and-auth.md](accounts-and-auth.md) の 10 節）
  - WAF の規則とボットの判定（[infrastructure.md](infrastructure.md) の 3 節、[trust-and-safety.md](trust-and-safety.md)）
  - 各資源の振る舞い（投稿は [posts-and-ids.md](posts-and-ids.md)、タイムラインは [timeline-fanout.md](timeline-fanout.md)、検索は [search-and-trends.md](search-and-trends.md)、DM は [direct-messages.md](direct-messages.md)）

### 1.1 関わる非機能要件

| NFR | この領域での意味 |
| --- | --- |
| NFR-004 | 公開 API の可用性 月間 99.9%。`429` は良いイベントに数える（[runbooks/README.md](../runbooks/README.md) の 1 節） |
| NFR-009 | 公開 API は画面と同じ `visible()` を通る。アプリの権限で見える範囲を広げない（[quality.md](../quality.md) の 2.2.1 節の「公開 API」の行） |
| NFR-012 | 1 件の読み出し p99 500ms。レート制限の判定の後で、上限を超えて受け付けた要求 1% 以内 |
| NFR-011 | 利用者の行動の上限と、電話の確認がないアカウントの低い上限で、スパムを抑える |

## 2. 本家の形（確かめたこと）

| 項目 | 内容 | 出典 |
| --- | --- | --- |
| ページング | 応答の `meta.next_token` を次の要求の `pagination_token` に入れる。1 ページの件数は `max_results`。新しいものを取るときは `since_id` を使う | [Pagination](https://docs.x.com/x-api/fundamentals/pagination)（2026-10-04 に確認） |
| レート制限 | 15 分か 24 時間の窓。アプリのトークンはアプリごと、利用者のトークンは利用者ごと。ヘッダーは `x-rate-limit-limit`・`x-rate-limit-remaining`・`x-rate-limit-reset`。例：投稿の作成はアプリごとに 24 時間 10,000、利用者ごとに 15 分 100 | [Rate limits](https://docs.x.com/x-api/fundamentals/rate-limits)（2026-10-04 に確認） |
| 課金 | 使った量に応じた課金、月 300 万件の投稿の読み出しの上限 | [intent.md](../intent.md) の出典 |
| バージョン | パスに `/2/` を持つ | 同上（Pagination の例の URL） |

- 本家の `x-rate-limit-*` の形は採らない。IETF の `RateLimit` の形を使う（[architecture/README.md](README.md) の 6 節の決定、5.4 節）。本家の SDK とそのまま互換にすることは目標にしない（[intent.md](../intent.md) の Non-goals）。

## 3. API の形

ADR-0046。

### 3.1 入口

- ベース：`https://api.<brand>.<domain>/v1/`。CloudFront → ALB（`alb-api`）→ `public-api`（[infrastructure.md](infrastructure.md) の 3 節）。
- 形：REST、JSON（UTF-8）。HTTP/2。要求の本体は Zod で検証し、OpenAPI 3.1 の文書をコードから生成して `https://api.<brand>.<domain>/v1/openapi.json` で公開する。
- 公式の SDK は TypeScript を 1 つ持ち、OpenAPI から生成する（リポジトリ共通の ADR-0006 の「題材ごとに公式の SDK を用意する」）。

### 3.2 資源（v1、MVP）

| 資源 | 操作 | 範囲 |
| --- | --- | --- |
| `/v1/posts` | 作成、削除、1 件、複数（ID で 100 件まで） | `posts.read`・`posts.write` |
| `/v1/users` | 自分（`/me`）、ID・ハンドルで引く、複数 | `users.read` |
| `/v1/users/{id}/posts` | 利用者の投稿の一覧 | `posts.read` |
| `/v1/users/{id}/mentions` | メンションの一覧 | `posts.read` |
| `/v1/timelines/following` | 本人のホーム（フォロー中）。時刻の順だけ（おすすめは出さない） | `timeline.read` |
| `/v1/users/{id}/following`・`/followers` | 一覧、フォロー・解除 | `follows.read`・`follows.write` |
| `/v1/posts/{id}/likes`・`/reposts`、`/v1/users/{id}/likes` | いいね・リポストの作成・取り消し・一覧 | `likes.*`・`reposts.*` |
| `/v1/users/{id}/bookmarks` | 本人のブックマーク | `bookmarks.*` |
| `/v1/blocks`・`/v1/mutes` | 本人のブロック・ミュート | `blocks.*`・`mutes.*` |
| `/v1/search/posts` | 投稿の検索（直近 7 日） | `posts.read` |
| `/v1/search/users` | 利用者の検索 | `users.read` |
| `/v1/dm/conversations`・`/messages` | DM の会話の一覧、送信、読み出し | `dm.read`・`dm.write` |
| `/v1/media/upload` | 分割のアップロード（[media.md](media.md)） | `media.write` |

- おすすめ（ランキング）は公開 API に出さない。理由の記録とガードレール（[ADR-0006](../decisions/0006-ranking-boundary.md)）の外で使われると、評価の前提が崩れるため。
- 全件の検索（7 日より前）とストリーミング（投稿の流れ）は MVP の後。

### 3.3 ID と JSON

- ID は 10 進の文字列（`"id": "1844…"`）。数で返さない（ADR-0002）。
- 時刻は RFC 3339 の UTC（`"created_at": "2026-10-04T01:02:03.456Z"`）。
- 応答の形：`{ "data": …, "includes": { "users": […], "media": […], "posts": […] }, "meta": { … }, "errors": […] }`。関係する資源は `expansions` の引数で `includes` に入れる（N＋1 の往復を減らす）。フィールドは `fields[posts]=…` で選ぶ。
- `errors` は、要求の全体が失敗でなく、一部の資源が見えないときに使う（見えない理由は `not_found` に寄せる。下の 3.7 節）。

### 3.4 ページング

| 引数 | 意味 |
| --- | --- |
| `max_results` | 1 ページの件数。既定 20、最大 100（検索は 100、DM は 50、フォロー中・フォロワーの一覧は 1,000。[follow-graph.md](follow-graph.md)） |
| `next_token` | 続きのページ。不透明な文字列（下） |
| `since_id` | この `tid` より新しいもの |
| `until_id` | この `tid` より古いもの |

- `next_token` は、`(資源の種類, 位置の tid, 絞り込みの条件のハッシュ, 発行の時刻)` を、サーバーの鍵で HMAC を付けて base64url にしたもの。改ざんと、別の資源・別の条件への流用を拒む。期限は 24 時間。
- **`since_id` は重なりを持つ**。`tid` は生成器の間でおおむね時刻の順で、確定の順とも一致しない（ADR-0002）。そこで、`since_id` の要求には、`since_id` から 10 秒ぶん戻した位置より新しいものを返す（窓の値は [timeline-fanout.md](timeline-fanout.md) で決める値に合わせる）。前の応答で返した投稿がまた出うる。**クライアントは ID で重複を落とす**ことを文書に書く。応答の `meta.newest_id`・`meta.oldest_id` を返す。
- 一覧の並びは ID の降順。フォローの一覧のように `tid` で並ばないもの（作った時刻の順）は、`next_token` だけで送る。

### 3.5 エラー

- 形は RFC 9457（Problem Details）：`{ "type": "https://api.<brand>.<domain>/problems/<code>", "title": …, "status": …, "detail": …, "code": "<code>" }`。
- 主な `code`：`invalid_request`（400）、`unauthorized`（401）、`insufficient_scope`（403）、`not_found`（404）、`conflict`（409。重複の投稿など）、`payload_too_large`（413）、`rate_limited`（429）、`usage_cap_reached`（429。6 節）、`client_too_old`（426。画面の API だけ。[delivery.md](delivery.md) の 6 節）、`internal`（500）、`unavailable`（503）。
- 書き込みは `Idempotency-Key`（UUID）を受ける。同じアプリ・同じ利用者・同じキーの 24 時間の中の再送は、前の結果を返す（投稿の二重の作成を防ぐ。[posts-and-ids.md](posts-and-ids.md)）。

### 3.6 バージョンと廃止

- パスの主の番号（`/v1/`）。同じバージョンの中では、足す変更（新しい資源、新しいフィールド、新しい引数）だけを行う。クライアントは知らないフィールドを無視することを文書に書く。
- 壊す変更（フィールドの削除・意味の変更、既定の変更）は `/v2/` にする。古いバージョンは **12 か月** の告知の後に止める。告知の間は、応答に `Deprecation`（RFC 9745）と `Sunset`（RFC 8594）のヘッダーを付け、開発者のメールで知らせる。
- 個別のエンドポイントの廃止も同じ 12 か月の告知にする。
- 契約の検査は CI で OpenAPI の差分を比べて行う（[delivery.md](delivery.md) の 7 節）。

### 3.7 見える範囲

- Public API の処理は、投稿・利用者・メディアを返す前に必ず `visible(viewer, post)` を通す（ADR-0004）。`viewer` は、利用者のトークンならその利用者、アプリのトークンなら **ログインしていない人**。
- 範囲（スコープ）は「何の操作ができるか」を決めるだけで、見える範囲を広げない。鍵アカウントの投稿は、承認されたフォロワーの利用者のトークンでだけ返る。
- 見えない投稿は `not_found` と同じ形で返す（存在を明かさない）。ブロックした・された関係も同じ。
- 応答の型は `Visible<Post>` にし、`visible()` を通らない投稿を応答に入れられないようにする（ADR-0004 の lint）。

## 4. 開発者とアプリ

ADR-0046。

### 4.1 開発者のアカウントとアプリ

- 開発者のアカウントは、`active` で電話の確認済みの利用者が、利用の目的を書いて申し込む。MVP は自動で承認し、T&S の規則で事後に審査する（[trust-and-safety.md](trust-and-safety.md)）。
- 1 つの開発者のアカウントが持てるアプリは 10 まで。アプリは名前、説明、戻りの URL（完全一致。`https`、開発用に `http://127.0.0.1` と `http://localhost` のポートを問わない形）、種類（`confidential`・`public`）、求める範囲を持つ。
- アプリにプラン（6 節）を結ぶ。

### 4.2 トークンの形

| 種類 | 形 | 保存 | 期限 |
| --- | --- | --- | --- |
| 利用者のアクセストークン | `<brand>_oat_` ＋ base62 の乱数 32 文字 ＋ チェックサム 6 文字（CRC32 の base62） | SHA-256 | 2 時間 |
| リフレッシュトークン | `<brand>_ort_` ＋ 同じ形 | SHA-256、一式の ID | 使わないまま 90 日 |
| アプリのトークン（公開の読み出し） | `<brand>_app_` ＋ 同じ形 | SHA-256 | 取り消すまで |
| クライアントの秘密 | `<brand>_ocs_` ＋ 同じ形 | SHA-256 | 作り直すまで |
| 画面のセッション（アプリ） | `<brand>_ses_` ＋ 同じ形（[accounts-and-auth.md](accounts-and-auth.md) の 6.1 節） | SHA-256 | 90 日 |

- 接頭辞とチェックサムで、シークレットスキャン（GitHub のパートナープログラムなど）が見つけられるようにする。接頭辞は他の既知のサービスと重ならないことを確かめてから登録する（リポジトリ共通の ADR-0006）。通報の口（`POST /internal/secret-scanning`）で見つかったトークンを取り消し、開発者に知らせる。
- 照合は SHA-256 の等しさ。Valkey（`vk-edge`）に 5 分の写し（キーはハッシュ）。取り消しは写しを消し、`sess:revoked` と同じ仕組みで 5 秒以内に効かせる。

### 4.3 流れ

| 流れ | 決定 |
| --- | --- |
| 認可 | `GET https://<brand>.<domain>/i/oauth/authorize`（画面。[accounts-and-auth.md](accounts-and-auth.md) の 10 節）。`response_type=code`、`state`、`code_challenge`（S256）を必須にする。`plain` は拒む。コードは 60 秒・1 回限り |
| トークン | `POST https://api.<brand>.<domain>/v1/oauth/token`。`authorization_code`（`code_verifier` 必須）、`refresh_token`、`client_credentials`（アプリのトークン） |
| 入れ替え | リフレッシュのたびに新しいリフレッシュトークンを出す。古いものの再使用を見たら、一式を取り消す |
| 取り消し | `POST /v1/oauth/revoke`（RFC 7009）。利用者は設定から、開発者はアプリの全トークンを取り消せる |
| `public` のクライアント | クライアントの秘密を持たない（ネイティブのアプリ、SPA）。PKCE だけで守る |

- OAuth 1.0a は持たない。

### 4.4 範囲

`posts.read`、`posts.write`、`users.read`、`timeline.read`、`follows.read`、`follows.write`、`likes.read`、`likes.write`、`reposts.write`、`bookmarks.read`、`bookmarks.write`、`blocks.read`、`blocks.write`、`mutes.read`、`mutes.write`、`dm.read`、`dm.write`、`media.write`、`offline.access`（リフレッシュトークンを出す）。

- アプリのトークンで使えるのは、`posts.read`・`users.read` の公開の読み出し（ログインしていない人として判定）だけ。
- `dm.*` は認可の画面で別に示し、重い操作の確かめを求める（[accounts-and-auth.md](accounts-and-auth.md) の 10 節）。DM の中身を第三者のアプリに渡すことは、当事者の同意による。DM の機械の解析の扱い（法務の L3）とは別の論点だが、L3 の結論で `dm.read` の出し方を見直しうる。

## 5. レート制限

ADR-0047。

### 5.1 考え方

- 1 つの要求が、複数の **桶** を同時に引く。全部の桶に余りがあるときだけ通し、どれかが空なら `429` を返す（どの桶も引かない）。
- 桶の種類：

| 桶 | 鍵 | 目的 |
| --- | --- | --- |
| 利用者の行動 | `user:{id}:{action}` | 投稿・フォロー・DM・いいねの 1 日の上限。**画面と公開 API で共通** |
| 利用者×アプリ | `ua:{user}:{app}:{endpoint_group}` | 1 つのアプリが 1 人の利用者の枠を使い切らない |
| アプリ | `app:{app}:{endpoint_group}` | アプリ全体の量 |
| IP | `ip:{/24 か /64}:{endpoint_group}` | ログインしていない要求、認証の入口 |
| 全体 | `global:{endpoint_group}` | 守るための天井（Ops が `ops.ratelimit.*` で絞る） |

- 画面（App API）は、利用者の行動の桶と全体の桶だけを引く。画面の読み出し（タイムラインのスクロール）は、IP と利用者の緩い読み出しの桶（攻撃の形だけを止める値）を引く。

### 5.2 仕組み

- **トークンバケット**：桶は `(tokens, updated_at_ms)` の 2 つの値。引くときに、経過時間 × 補充の速さを足し（容量で頭打ち）、要るだけ引く。
- Valkey（`vk-edge`）の Valkey Functions に `rl_take(keys[], costs[], capacities[], rates[], now)` を置き、**複数の桶を 1 回の呼び出しで原子的に** 判定して引く。クラスタで 1 回に引く鍵は同じスロットでなければならないので、鍵にハッシュタグ（`{u:<id>}` か `{a:<app>}`）を付け、同じ主体の桶を同じスロットに置く。主体の違う桶（利用者とアプリ）は 2 回の呼び出しに分け、先に引いた側を後の失敗で戻す（戻しの失敗は許す。1% の目標の中に収める）。
- 時刻は呼び出し側の時刻（`now`）ではなく、Valkey の `TIME` を使う（タスクの時計のずれで桶が増えない）。
- 桶の鍵は、満杯に戻るまでの時間で期限を付ける（`PEXPIRE`）。
- 1 日の上限は「容量 = 1 日の上限、補充 = 上限 / 86,400 秒」の桶と、短い窓の桶（30 分）の 2 つで表す。短い窓の桶が連投の束を止め、1 日の桶が総量を止める。

### 5.3 値（S1 の既定）

利用者の行動（画面と API で共通）：

| 行動 | `standard`（電話の確認済み） | `unverified`（電話なし） | `new`（登録から 72 時間） |
| --- | --- | --- | --- |
| 投稿（返信・引用を含む） | 1 日 1,000、30 分 100 | 1 日 50（返信は別に 1 日 200） | `standard` の半分 |
| フォロー | 1 日 400 | 1 日 50 | 1 日 100 |
| DM の送信 | 1 日 500 | 1 日 50 | 1 日 100 |
| いいね | 1 日 1,000 | 1 日 200 | 1 日 500 |
| リポスト | 1 日 500 | 1 日 100 | 1 日 250 |
| 検索（画面と API の共通） | 15 分 180 | 15 分 60 | 15 分 180 |
| メディアのアップロード | 1 日 200 件・10 GB | 1 日 20 件・1 GB | 1 日 50 件・2 GB |

- 段は、セッションの写しの `flags`（[accounts-and-auth.md](accounts-and-auth.md) の 6.2 節）から決める。`new` と `unverified` が重なれば低いほう。
- T&S は利用者ごとの係数 `rate_multiplier`（0〜1）で、その人の行動の桶の容量と補充を縮められる（[trust-and-safety.md](trust-and-safety.md)、[ADR-0040](../decisions/0040-spam-and-bot-defense.md)）。係数はセッションの写しに入れ、桶を引く時に掛ける。
- DM の申請の数・会話ごとの送信の速さは [direct-messages.md](direct-messages.md) の上限で、この表の DM の送信の桶と別に数える。検索の値は [search-and-trends.md](search-and-trends.md) の案と同じにした。
- 本家の文書は投稿 1 日 2,400 件などとしている（[intent.md](../intent.md)）。本システムは、日本の利用の大部分に足りる値として 1,000 を既定にし、本家より低くした。E11 のスパムの計測と、利用者の上限への到達の率（9 節の指標）で見直す。
- 値は AppConfig の `policy.ratelimit.*` に持つ。スパムの攻撃のときは `ops.ratelimit.*` で一時に下げてよい（[runbooks/README.md](../runbooks/README.md) の 2 節）。

公開 API（アプリの桶。15 分の窓の目安で書く）：

| エンドポイントの組 | 利用者×アプリ | アプリ |
| --- | --- | --- |
| 投稿の読み出し（1 件・複数・一覧） | 900 / 15 分 | 1 万 / 15 分 |
| 検索 | 180 / 15 分 | 450 / 15 分 |
| ホーム（フォロー中） | 180 / 15 分 | 1,500 / 15 分 |
| 書き込み（投稿・いいね・フォロー） | 100 / 15 分 | 1 万 / 24 時間（投稿） |
| DM | 100 / 15 分 | 1,500 / 15 分 |

- アプリの桶の値はプラン（6 節）で倍率を変える。

認証の入口（IP と連絡先。[accounts-and-auth.md](accounts-and-auth.md) の 4.4 節）：`auth.otp_send`、`auth.otp_verify`、`auth.login`、`oauth.token`。

### 5.4 応答のヘッダー

IETF の draft-ietf-httpapi-ratelimit-headers の draft-11（2026-05-23）に従う。まだ RFC ではない（[datatracker](https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/)、2026-10-04 に確認）。

```
RateLimit-Policy: "app-read";q=10000;w=900, "user-app-read";q=900;w=900
RateLimit: "user-app-read";r=812;t=640
```

- `RateLimit-Policy` は、その要求に当たった桶の方針を全部並べる。`RateLimit` は、**最も余りの少ない桶** だけを返す（`r` は残り、`t` は満杯までの秒）。
- `pk`（分ける鍵）は付けない。利用者・アプリの ID をヘッダーに出さないため。
- `429` には `Retry-After`（秒）を付ける。
- 草案のバージョンが進んで形が変わったら、`/v2/` を待たずに追う（足す変更として扱う。古い形は 6 か月並べて出す）。草案の名前のヘッダーを使う危うさは 12 節の持ち越し。
- 画面（App API）にもヘッダーを付ける。クライアントは、残りが 0 の行動のボタンを、`t` の秒まで押せなくする（[clients.md](clients.md)）。

### 5.5 障害と精度

- **Valkey が落ちたら**：
  - 読み出しの桶：タスクの中の近似の桶（タスクの数で割った値）で続ける（開いたまま）。
  - 書き込みの行動の桶：同じく近似で続ける。投稿の 1 日の上限は、復旧の後に超えた分を数えるだけで、取り消さない。
  - 認証の入口（`auth.otp_send`）：止める（[accounts-and-auth.md](accounts-and-auth.md) の 4.4 節）。
- **精度の目標（NFR-012）**：上限を超えて受け付けた要求 1% 以内。超過は「桶の戻しの失敗」「近似で続けた間」で起きる。計量の記録（6 節）から、桶ごとの受け付けの数と上限の比を日ごとに出し、1% を超えた桶をチケットにする。
- 桶の判定の遅延は p99 3ms（Valkey の往復 1 回か 2 回）を目標にする。

## 6. 計量とプラン

ADR-0048。

### 6.1 数えるもの

| 単位 | 数え方 |
| --- | --- |
| `post_read` | 応答で返した投稿の件数（`includes` の投稿を含む）。`visible()` で落としたものは数えない |
| `user_read` | 返した利用者の件数 |
| `write` | 書き込みの成功の回数（投稿、いいね、フォロー、DM の送信） |
| `dm_read` | 返した DM のメッセージの件数 |

- Public API の処理は、応答を返した後、`(app_id, user_id?, endpoint, units, status, ts)` の計量の出来事を Firehose の `api-usage` へ送る（Aurora を通さない。閲覧と同じく、失ってもよい側に倒す。失う割合は Firehose の失敗の数で測る）。
- 日ごとの集計を Athena で作り、`api_usage_daily(app_id, day, unit, count)` に書く。開発者の画面は、この表と、当日の Valkey の数を合わせて出す。

### 6.2 プラン

| プラン | 月の上限 | アプリの桶の倍率 | 備考 |
| --- | --- | --- | --- |
| `free` | `post_read` 1 万、`write` 1,500 | 0.1 | 試しと小さなボット |
| `payg`（使った量） | 申し込みの時に開発者が決める上限（既定 `post_read` 100 万） | 1 | 単価は MVP の後に請求の連携で決める |
| `partner` | 契約ごと | 契約ごと | 研究・報道機関。審査あり |

- 月の上限は、Valkey の `usage:{app}:{yyyymm}:{unit}` の数で強制する。要求の処理の前に、前の要求までの数が上限を超えていれば `429`（`usage_cap_reached`）を返す。1 要求ぶんの超過は許す。
- 上限の 80% と 100% で開発者にメールを送る。
- **請求の連携（決済の事業者、単価、税）は MVP の後**（[intent.md](../intent.md) の MVP の後の「長文の投稿、有料の購読、収益の分配」と同じく、決済と税の扱いが要る）。MVP は計量と上限の強制まで。

## 7. 活動の Webhook（MVP の後）

ADR-0048 で MVP の後にした。形だけを決めておく。

- 対象：利用者が認可したアプリへの、その利用者の活動（メンション、返信、フォローされた、DM の受信は `dm.read` があるときだけ）。
- 登録：アプリごとに 1 つの URL（`https`）。登録の時に挑戦の応答（CRC の形）で持ち主を確かめる。
- 送信：Notification の出来事の消費者から、egress の専用の経路（[infrastructure.md](infrastructure.md) の 2.3 節）で送る。署名は `<Brand>-Signature: t=<秒>,v1=<HMAC-SHA256>`。秘密は `<brand>_whsec_` の形。
- 送る直前に、受け手（認可した利用者）として `visible()` を判定し直す。
- 再送は指数の待ちで 24 時間まで。失敗が続くアプリは止める。
- 着手は E13 の後の Epic として PM が決める。

## 8. 障害のときの振る舞い

| 障害 | 振る舞い |
| --- | --- |
| Valkey（`vk-edge`）の喪失 | 5.5 節。トークンの写しがなくなるので、照合を Aurora の reader に回す（`public-api` を広げる） |
| 内部のサービス（Timeline、Search）の遅れ | Public API の時間の予算（既定 2 秒）を超えたら `503`（`Retry-After`）。画面の可用性とは別に数える |
| Firehose の失敗 | 計量の出来事を失う。月の上限の強制は Valkey の数で続く |
| アプリの暴走（1 つのアプリが全体の天井に迫る） | アプリの桶で止まる。全体の桶は Ops が `ops.ratelimit.global.*` で絞る。アプリを止める（`apps.state = suspended`）のは T&S の措置 |

## 9. 指標

| 指標 | 用途 |
| --- | --- |
| `ratelimit.rejected{bucket_kind, endpoint_group, tier}` | `429` の数。急な増えは攻撃か、値の誤り |
| `ratelimit.overadmit_ratio{bucket}` | 上限を超えて受け付けた割合（日ごと。NFR-012 の 1%） |
| `ratelimit.fallback_active` | 近似の桶で続けている時間 |
| `user_action_cap_reached{action, tier}` | 利用者の行動の上限に達した人の割合。値の見直しに使う |
| `api.latency{endpoint_group}` | NFR-012 の p99 500ms |
| `api.usage{unit, plan}` | 計量の合計 |

- `user_id`・`app_id` をメトリクスの次元にしない（[observability.md](observability.md) の 2.3 節）。アプリごとの値はログの集計で見る。

## 10. data-model への項目

列・鍵・索引の正本は [data-model/api-and-apps.md](data-model/api-and-apps.md)にある。下の表は、この領域が求めた項目の要点である。

| 表・置き場所 | 中身 | 種類 |
| --- | --- | --- |
| `developer_accounts` | `(id, user_id, purpose, state, created_at)` | 運用の表 |
| `apps` | `(id, developer_id, name, kind, redirect_uris, scopes, plan, state, created_at)` | 運用の表 |
| `app_credentials` | クライアントの秘密・アプリのトークンのハッシュ、末尾 4 文字 | 運用の表 |
| `oauth_grants` | `(owner_id, id, app_id, scopes, family_id, created_at, revoked_at)` | 本人だけの表（RLS。本人は自分の認可を見る） |
| `oauth_tokens` | `(token_hash, grant_id, kind, expires_at, revoked_at)` | `public-api` のロールだけ |
| `api_usage_daily` | 6.1 節 | 運用の表 |
| Valkey `rl:{…}` | 桶（5.2 節） | 写し（失ってよい） |
| Valkey `usage:{app}:{yyyymm}:{unit}` | 月の数 | 写し（集計から戻せる） |
| Valkey `tok:{sha256}` | トークンの写し（5 分） | 写し |
| Firehose `api-usage` → S3 | 計量の出来事 | データレイク（保持は [security.md](security.md) の 7 節） |

- `apps`・`developer_accounts` の ID は UUIDv7。公開の ID として出すアプリの ID も UUIDv7 の文字列。

## 11. テスト

| 種類 | 対象 |
| --- | --- |
| 表駆動 | DT-API-001（範囲 × 資源 × 操作の可否）、DT-RL-001（段 × 行動 × 上限）。どちらも spec の表から読む |
| 性質 | PROP-RL-001：任意の要求の列・時刻の進み・並行の呼び出しで、桶の受け付けの合計が「容量 ＋ 補充の速さ × 経過時間」を超えない（Valkey の正常時）。PROP-RL-002：複数の桶を引く要求は、どれかが空なら、どの桶も減らさない（同じスロットの組）。PROP-API-001：任意の `next_token` の改ざん・別の資源への流用を拒む。PROP-API-002：`since_id` で読んだ結果を ID で重複を落として合わせると、窓の中に確定した投稿を抜かさない |
| 結合 | 漏れの経路の表の「公開 API」の行（5 つの主体）。アプリのトークンで鍵アカウントの投稿が `not_found`。範囲のないトークンで `403` |
| 負荷 | NFR-012：上限の付近の負荷で受け付けの超過が 1% 以内。Valkey の喪失の間の近似 |
| 契約 | OpenAPI の差分の検査（v1 の中で壊す変更を拒む）。SDK の生成と、SDK での E2E |

## 12. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E13 | `oauth-apps` | 4 節。開発者のアカウント、アプリ、PKCE、トークンの形、シークレットスキャンの通報の口 |
| E13 | `public-api-v1` | 3 節。資源、ページング、エラー、`visible()` |
| E13 | `rate-limits` | 5 節。Valkey Functions、桶、ヘッダー、近似 |
| E13 | `usage-metering` | 6 節。計量、日ごとの集計、月の上限 |
| E2 | `user-action-limits` | 5.3 節の利用者の行動の桶を App API に先に入れる（E3・E4 の書き込みの前） |
| E13 | `openapi-and-sdk` | 3.1 節の OpenAPI の生成と TypeScript の SDK |

## 13. 未解決の問い

### 決定

2026-10-04 の既定案。E13 で覆りうる。

- **REST、`/v1/`、文字列の ID、`since_id` は重なりあり**（ADR-0046）。
- **OAuth 2.0 の認可コード＋PKCE（S256 必須）、アプリのトークンは公開の読み出しだけ**、OAuth 1.0a なし。
- **トークンバケットを Valkey Functions で複数同時に引く。利用者の行動は画面と API で共通**（ADR-0047）。
- **ヘッダーは IETF の `RateLimit`（draft-11）**。本家の `x-rate-limit-*` は出さない。
- **投稿 1 日 1,000（電話なし 50）**。
- **計量と上限は MVP、請求の連携と Webhook は MVP の後**（ADR-0048）。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| `RateLimit` のヘッダーが RFC になるまでの形の変化 | 草案の改訂のたびに追う。RFC になったら固定する |
| `payg` の単価と請求の連携 | MVP の後。PM が決済の事業者と合わせて決める |
| 利用者の行動の上限の値 | E11 のスパムの計測と `user_action_cap_reached` で見直す |
| 研究者向けの全件の検索・投稿の流れ | MVP の後。T&S と法務（L4）を含めて決める |
| `dm.read` を第三者のアプリに出すか | 法務の L3 の結論で見直す |

## 14. quality.md・runbooks への項目

### quality.md

- E13 の合否基準に、DT-API-001・DT-RL-001・PROP-RL-001・002・PROP-API-001・002 を足す。
- 漏れの経路の表の「公開 API」の行に、アプリのトークン（ログインしていない人として判定）の主体を明記する。

### runbooks

- `api-abuse.md`：1 つのアプリの暴走、全体の天井の絞り（`ops.ratelimit.global.*`）、アプリの停止の依頼（T&S）。
- 2 節の「利用者の上限」の行の正本を、この文書の 5.3 節にする。

## 出典

いずれも 2026-10-04 に確認。

- X Developer Platform, [Pagination](https://docs.x.com/x-api/fundamentals/pagination)、[Rate limits](https://docs.x.com/x-api/fundamentals/rate-limits)
- IETF, [draft-ietf-httpapi-ratelimit-headers](https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/)（draft-11、2026-05-23）
- RFC 9457（Problem Details for HTTP APIs）、RFC 8594（Sunset）、RFC 9745（Deprecation）、RFC 7009（Token Revocation）、RFC 7636（PKCE）

# API and Webhooks: Zoom

公開の REST API、OAuth のアプリ、レート制限、署名付きの Webhook の設計。組織の社内のシステム（人事、CRM、LMS）と他社の製品が、会議の予定、参加者のレポート、録画の取得を自動にするために使う。

本家の API の形（リソース、アプリの種類、重さで分けたレート制限、Webhook の URL の確認と署名）に寄せる。名前・ヘッダー・接頭辞・ドメインは本家のものを使わない（リポジトリ共通の [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。本家の SDK との互換は目標にしない（intent.md の Non-goals）。

前提となる決定は、組織とユーザーと認証（[ADR-0038](../decisions/0038-organizations-users-roles-and-sso.md)）、設定の解決（[ADR-0039](../decisions/0039-settings-hierarchy-and-locks.md)）、待合室かパスコードの不変条件（[ADR-0031](../decisions/0031-waiting-room-and-passcode-rules.md)）。rebuilds の他の題材の決定として、Slack の Webhook の署名（Standard Webhooks の形。Slack の [apps.md](../../../slack/docs/architecture/apps.md) の 8 節）と、レート制限のヘッダー（Slack の [rate-limiting.md](../../../slack/docs/architecture/rate-limiting.md)）に合わせる。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0043](../decisions/0043-public-api-oauth-apps-and-rate-limits.md) | 公開 API は `api.<brand>.<domain>/v1` の別のサービスにし、内部の API と同じサービス関数を通る。アプリは、利用者が入れる OAuth のアプリ（認可コード＋PKCE 必須）と、組織の管理者が作るサーバー間のアプリ（クライアントクレデンシャル）の 2 種類。アクセストークンは 1 時間。レート制限は操作の重さで 4 つに分け、(アプリ, 組織) ごとのトークンバケットにし、会議の作成・更新は利用者ごとに 1 日 100 回 |
| [0044](../decisions/0044-signed-webhooks-standard-webhooks.md) | Webhook は Standard Webhooks の形（`webhook-id`・`webhook-timestamp`・`webhook-signature`、HMAC-SHA256）で署名する。登録のときに URL の確認の要求を送る。outbox から少なくとも 1 回送り、7 回まで約 1.9 日かけて再送する。3 日続けて失敗したら止める。中身に会議の内容（チャット、字幕、パスコード、参加の鍵）を入れない |

## 1. 位置づけ

| 項目 | 方針 |
| --- | --- |
| 何のためか | 会議の予定の自動化（LMS、採用の面接の予定）、参加者のレポートの取得、録画と文字起こしの取得と社内の保管、ユーザーの管理 |
| 内部の API との関係 | 内部の API（Web クライアント用）は互換を約束しない。公開 API は別の面として持ち、同じサービス関数と `authorize`・`resolveSettings`・`assertJoinGuard` を通る |
| 誰の権限で動くか | OAuth のアプリ：トークンの利用者の権限とスコープの積。サーバー間のアプリ：組織と、アプリに与えたスコープ（組織の管理者が作る） |
| 会議の中の操作 | 出さない（ミュート、退出させる、など）。会議の中の状態は Actor だけが変える（本題材の AGENTS.md）。会議を終える操作だけは、Actor への命令として出す（6 節） |
| 提供の時期 | E11（[architecture/README.md](README.md) の 7 節） |

## 2. 本家の形（確かめたこと）

| 項目 | 本家（公開情報） | この設計 |
| --- | --- | --- |
| レート制限 | 操作を Light・Medium・Heavy・Resource-intensive に分ける。Free は Light 4/秒・6,000/日、Medium 2/秒・2,000/日、Heavy 1/秒・1,000/日、Resource-intensive 10/分・30,000/日。Pro は 30・20・10/秒、10/分。Business 以上は 80・60・40/秒、20/分。Heavy と Resource-intensive の合計の 1 日の上限が Pro 30,000、Business 以上 60,000。会議・ウェビナーの作成と更新は、利用者ごとに 1 日 100 回（UTC の 0 時に戻る）。超えたら `429` （[Rate limits](https://developers.zoom.us/docs/api/rate-limits/)） | 同じ 4 つの分け方。値は 5.2 節（ADR-0043） |
| アプリの種類 | Server-to-Server OAuth（アクセストークン 1 時間）と、利用者の OAuth。JWT のアプリは 2023-09-01 に止めた（[JWT App type deprecation](https://developers.zoom.us/changelog/platform/jwt-app-type-deprecation/)、1 時間は開発者の掲示板と本家の GitHub の説明で確かめた） | 同じ 2 種類。共有の秘密だけで署名するトークン（JWT のアプリ）は作らない（ADR-0043） |
| Webhook の署名 | `x-zm-signature`・`x-zm-request-timestamp`。`v0:{timestamp}:{body}` の HMAC-SHA256 を 16 進にし、`v0=` を前に付ける | Standard Webhooks の形。ヘッダーの名前は本家のものを使わない（ADR-0044） |
| URL の確認 | `endpoint.url_validation` のイベントで `plainToken` を送り、受け手は秘密で HMAC-SHA256 した `encryptedToken` と一緒に 3 秒以内に返す | 同じ考え方（ADR-0044） |
| 再送 | 受け手が `5xx` か接続の失敗のとき、5 分後・その 20 分後・その 60 分後の 3 回。応答は 3 秒以内に `200` か `204` （[Webhooks](https://developers.zoom.us/docs/api/webhooks/)） | 7 回、約 1.9 日。時間切れは 5 秒（ADR-0044） |

いずれも 2026-09-27 に確認。

## 3. 構成

```
組織の社内のシステム・他社の製品
   │ HTTPS  Authorization: Bearer <brand>_at_...
   ▼
CloudFront + WAF ─▶ ALB ─▶ public-api（TypeScript・Hono。ECS Fargate）
   │ 1. トークンの検証 → 主体（user か org のアプリ）・スコープ
   │ 2. レート制限（(app, org) の分類ごと、利用者ごとの会議の作成）
   │ 3. ハンドラー → サービス関数 → authorize → resolveSettings → assertJoinGuard
   ▼
Aurora（リーダーは一覧とレポート）、S3（録画の署名付きの URL）

認可サーバー（identity のモジュールの中）：/oauth/authorize、/oauth/token、/oauth/revoke

Webhook：outbox ─▶ SQS webhook-delivery ─▶ Webhook Worker（署名）─▶ egress proxy（VPC の外への出口を 1 つに）─▶ 受け手
```

- `api.<brand>.<domain>` の独立したサービス。Cookie を受けず、CORS を許さない。外部の呼び出しの急増が、参加の API（NFR-002）と会議の中に響かない。障害のときは、公開 API だけを止められる（ops のフラグ）。
- 一覧・レポートの読み取りは Aurora のリーダーに向ける（[ADR-0040](../decisions/0040-usage-reports.md)）。

## 4. アプリとトークン

ADR-0043。

### 4.1 種類

| 種類 | 誰が作る | 流れ | 主体 | トークン |
| --- | --- | --- | --- | --- |
| OAuth のアプリ | 開発者（どの組織の利用者でも） | 認可コード＋PKCE（S256）必須。`redirect_uri` は完全一致 | 同意した利用者 | アクセストークン 1 時間。リフレッシュトークン 90 日（使うたびに入れ替え、古いものの再使用で系列ごと失効） |
| サーバー間のアプリ | 組織の `admin` | クライアントクレデンシャル（`client_secret_basic` か `private_key_jwt`） | 組織 | アクセストークン 1 時間。リフレッシュトークンなし |

- 組織の全体に効くスコープ（`:admin` の付くもの）を OAuth のアプリで使うには、組織の `admin` の承認が要る（利用者が同意しても、`admin` が承認するまで発行しない）。
- アプリの公開の状態：`draft`（作った人の組織だけ）・`private`（許した組織だけ）・`public`（本システムの審査の後、誰でも）。
- 認可サーバーは `identity` のモジュールの中に置く（[ADR-0038](../decisions/0038-organizations-users-roles-and-sso.md)）。OAuth の安全の確認の表は、Auth0 の題材の [ADR-0053](../../../auth0/docs/decisions/0053-rfc9700-checklist-and-negative-tests.md)（RFC 9700 の確認の表と否定の試験）を写して使う。Better Auth は OAuth 2.1 の認可サーバーのプラグイン（`@better-auth/oauth-provider`）を持ち、認可コード（公開のクライアントは PKCE が既定で必須）、リフレッシュトークン、クライアントクレデンシャル、RFC 9207 の `iss` を扱う（[OAuth 2.1 Provider](https://better-auth.com/docs/plugins/oauth-provider)、2026-09-27 に確認）。4.2 節のトークンの形（接頭辞とチェックサム）、リフレッシュトークンの入れ替えと再使用の検知、`private_key_jwt` をこのプラグインで満たせるかは**未検証**で、E11 の `oauth-authorization-server` で確かめる。満たせなければ、その部分を自前で足す。

### 4.2 トークンの形

| トークン | 形 |
| --- | --- |
| アクセストークン | `<brand>_at_` ＋ 32 バイトの乱数の base62 ＋ CRC32 の 6 文字 |
| リフレッシュトークン | `<brand>_rt_` ＋ 同じ |
| クライアントの秘密 | `<brand>_cs_` ＋ 同じ |
| Webhook の秘密 | `whsec_` ＋ 32 バイトの base64（Standard Webhooks の形。ADR-0044） |

- 不透明なトークン（JWT にしない）。DB には SHA-256 だけを置く。取り消しがすぐに効く。
- 接頭辞は、他の既知のサービスと重ならないことを確かめ、シークレットスキャンのパートナープログラムに登録する（リポジトリ共通の ADR-0006）。

### 4.3 スコープ

| スコープ | 中身 |
| --- | --- |
| `meeting:read` ・ `meeting:write` | 自分の会議の読み書き |
| `meeting:read:admin` ・ `meeting:write:admin` | 組織のすべての会議 |
| `recording:read` ・ `recording:write` | 自分の録画と文字起こしの読み取り・削除 |
| `recording:read:admin` ・ `recording:write:admin` | 組織のすべての録画 |
| `report:read:admin` | 利用状況のレポート、会議の参加者の一覧 |
| `user:read` ・ `user:read:admin` ・ `user:write:admin` | 自分・組織のユーザー |
| `settings:read:admin` ・ `settings:write:admin` | 組織・グループの設定 |
| `webhook:write` | アプリの Webhook の登録（自分のアプリだけ） |

## 5. リソースと規則

### 5.1 主なリソース

| メソッドとパス | 分類 | スコープ |
| --- | --- | --- |
| `GET /v1/users/me` | light | `user:read` |
| `GET /v1/users` ・ `POST /v1/users` ・ `PATCH /v1/users/{id}` | medium | `user:*:admin` |
| `GET /v1/users/{id}/meetings` | medium | `meeting:read`（自分）・`:admin` |
| `POST /v1/users/{id}/meetings` | medium＋利用者ごと 100/日 | `meeting:write` |
| `GET /v1/meetings/{id}` ・ `PATCH` ・ `DELETE` | light ／ medium＋利用者ごと 100/日 | `meeting:*` |
| `POST /v1/meetings/{id}/end` | medium | `meeting:write` |
| `GET /v1/meetings/{id}/instances` | medium | `meeting:read` |
| `GET /v1/meeting-instances/{id}/participants` | heavy | `report:read:admin` か主催者の `meeting:read` |
| `GET /v1/users/{id}/recordings`（期間は 1 か月まで） | medium | `recording:read` |
| `GET /v1/recordings/{id}` | light | `recording:read` |
| `POST /v1/recordings/{id}/files/{kind}/download-url` | heavy | `recording:read` |
| `DELETE /v1/recordings/{id}`（ごみ箱へ） | medium | `recording:write` |
| `GET /v1/meeting-instances/{id}/transcript` | heavy | `recording:read` |
| `GET /v1/reports/usage`（日ごと） | heavy | `report:read:admin` |
| `POST /v1/reports/exports` | resource-intensive | `report:read:admin` |
| `GET /v1/orgs/me/settings` ・ `PATCH` | medium | `settings:*:admin` |

- 会議の作成と更新は、Web の画面と同じく `resolveSettings` と `assertJoinGuard` を通す。待合室もパスコードもない会議は 422 `waiting_room_or_passcode_required`。E2EE と `auto_recording` の組み合わせも 422（[ADR-0027](../decisions/0027-capture-consent-and-indicators.md)）。
- 会議の応答に、パスコードを含めるのは `meeting:read` を持つ主催者（か `:admin`）の要求だけ。参加の URL（参加の鍵つき）も同じ。
- 録画のファイルは、API の本文で返さない。10 分の署名付きの URL を返す。

### 5.2 レート制限

ADR-0043。S1 は料金のプランを持たないので、1 つの値の組にする。

| 分類 | (アプリ, 組織) ごと | 1 日の上限 |
| --- | --- | --- |
| light | 毎秒 30 | — |
| medium | 毎秒 20 | — |
| heavy | 毎秒 10 | heavy と resource-intensive の合計で、組織ごとに 1 日 60,000 |
| resource-intensive | 毎分 10 | 同上 |
| 会議の作成・更新 | 利用者ごとに 1 日 100 回（UTC の 0 時に戻す） | — |

- 数は Valkey のトークンバケットで数える（[meeting-security.md](meeting-security.md) の 8.2 節と同じ仕組み）。
- すべての応答に `RateLimit-Policy` と `RateLimit` を付ける（IETF の draft-ietf-httpapi-ratelimit-headers-11 の書式。RFC になるまで変わりうる。Slack の題材と同じ）。分類を `X-<Brand>-RateLimit-Category` で返す。
- 超えたら `429`、`Retry-After`（秒）、本文は RFC 9457 の問題の詳細（`type`・`title`・`detail`、`limit: "per_second" | "daily" | "user_meeting_writes"`）。
- 値は本家の Business 以上の値より小さい。S1 の規模で足りるかを E11 で見て、組織の契約で上げられる形にする（持ち越し）。

### 5.3 共通の規則

| 項目 | 規則 |
| --- | --- |
| 版 | URL の `/v1`。版の中では項目を足すだけ。消す・意味を変えるときは `/v2`。古い版を止めるときは `Deprecation` と `Sunset`（RFC 8594）のヘッダーを 6 か月前から付ける |
| ページ | カーソル（`next_page_token`）、`page_size` は 300 まで。トークンは 15 分で失効 |
| 冪等 | `POST` は `Idempotency-Key` を受ける。24 時間、同じ鍵と同じ本文なら同じ応答 |
| エラー | RFC 9457（`application/problem+json`）。`code` に機械向けの理由 |
| 時刻 | ISO 8601、UTC。予定の会議は `start_local` と `timezone` も返す（[scheduling-and-calendar.md](scheduling-and-calendar.md) の 4.4 節） |
| ID | 内部の ID（`mtg_…`、`mi_…`、`rec_…`）。会議の番号は `meeting_number` として別に返す |

## 6. 会議を終える操作

- `POST /v1/meetings/{id}/end` は、API が会議の持ち主の Actor へ `host.end` と同じ命令を、主催者の代理として送る（Signaling Gateway の内部の口、`epoch` の検査あり）。
- Actor が止まっている間は `503`（`Retry-After: 10`）。API が会議の状態を直接書き換えない（本題材の AGENTS.md）。

## 7. Webhook

ADR-0044。

### 7.1 登録

```
アプリの設定（OAuth のアプリは開発者、サーバー間のアプリは組織の admin）
{ "url": "https://hooks.example.co.jp/<brand>", "events": ["meeting.ended", "recording.completed"] }

→ 本システムが URL の確認の要求を送る
POST https://hooks.example.co.jp/<brand>
webhook-id: msg_01J9...    webhook-timestamp: 1790000000    webhook-signature: v1,K5o...
{ "type": "endpoint.url_validation", "data": { "plain_token": "qgg8vlvZRS6UYooatFL8Aw" } }

← 3 秒以内に
200 { "plain_token": "qgg8vlvZRS6UYooatFL8Aw",
      "encrypted_token": "<HMAC-SHA256(secret, plain_token) の 16 進>" }
```

- 確認に通るまで、イベントを送らない。確認は 72 時間ごとにやり直す（受け手の持ち主が替わっていないかを確かめる）。
- URL は `https` だけ。登録のときと送るたびに名前を引き、私的な IP（RFC 1918、ループバック、リンクローカル、メタデータの 169.254.169.254、IPv6 の ULA）に向く URL を拒否する。送るのは egress proxy を通してだけ（SSRF の対策）。
- 1 つのアプリ・1 つの組織で、受け口は 5 つまで。

### 7.2 署名

- ヘッダー：`webhook-id`（配送の ID。同じイベントの再送でも同じ）、`webhook-timestamp`（Unix 秒）、`webhook-signature`（`v1,` ＋ `HMAC-SHA256(secret, "{id}.{timestamp}.{body}")` の base64）。Standard Webhooks の仕様の形（Slack の題材と同じ）。
- 秘密の入れ替え：新しい秘密を作ってから 24 時間は、古い秘密と新しい秘密の 2 つの署名を空白で区切って付ける。
- 受け手への勧め：時刻の差 5 分以内と署名を定数時間で確かめ、`webhook-id` を 5 分以上覚えて同じものを 2 回処理しない。公式の SDK（`@<brand>/webhooks`）に検証の関数を入れる。

### 7.3 配送

| 項目 | 値 |
| --- | --- |
| 保証 | 少なくとも 1 回。順序は保証しない。本文の `occurred_at` と、資源の `version` で順を決めてもらう |
| もと | 業務の変更と同じトランザクションで outbox に書く（例：`recording.completed` は録画の状態の更新と同じ） |
| 時間切れ | 接続 2 秒、応答 5 秒 |
| 成功 | `2xx` |
| 再送 | `5xx`・`429`・時間切れ・接続の失敗。1 分・5 分・30 分・2 時間・6 時間・12 時間・24 時間の 7 回（±20% の揺らぎ。合計で約 1.9 日） |
| 再送しない | `2xx` 以外の `4xx`（`429` を除く）。受け手の設定の誤りとみなし、配送の記録に残す |
| 止める | 3 日続けて全配送が失敗したら、受け口を `disabled` にし、アプリの持ち主（と組織の admin）にメールで知らせる |
| 再送の要求 | 7 日以内の失敗した配送を、API（`POST /v1/webhooks/deliveries/{id}/redeliver`）か画面で送り直せる |

### 7.4 イベント

| イベント | いつ | 中身（`data`） |
| --- | --- | --- |
| `meeting.created` ・ `meeting.updated` ・ `meeting.deleted` | 予定の会議の変更 | `meeting_id`、`meeting_number`、`topic`、`type`、`start`、`timezone`、`host_user_id`、`version` |
| `meeting.started` ・ `meeting.ended` | 開催の開始・終了 | `meeting_id`、`instance_id`、`started_at`・`ended_at`、`host_user_id` |
| `participant.joined` ・ `participant.left` | 会議への出入り | `instance_id`、`participant_id`、`user_id?`（アカウントのある人）、`display_name`、`kind`（`web`・`phone`）、`at`、`leave_reason?` |
| `participant.waiting` | 待合室に入った | `instance_id`、`participant_id`、`display_name`、`at` |
| `recording.started` ・ `recording.stopped` | 録画の区間 | `recording_id`、`instance_id`、`at` |
| `recording.completed` | 合成が終わった | `recording_id`、`instance_id`、`files`（`kind`・`bytes`。URL は含めない） |
| `recording.trashed` ・ `recording.deleted` | ごみ箱・完全な削除 | `recording_id` |
| `transcript.completed` | 文字起こしができた | `transcript_id`、`instance_id` |
| `user.created` ・ `user.updated` ・ `user.deactivated` | ユーザーの変更 | `user_id`、`email`（`user:read:admin` を持つアプリだけ）、`role`、`status` |

```jsonc
// 封筒
{ "id": "evt_01J9...", "type": "recording.completed", "org_id": "org_01J9...",
  "occurred_at": "2026-10-06T02:04:11Z", "api_version": "v1",
  "data": { "recording_id": "rec_01J9...", "instance_id": "mi_01J9...",
            "files": [ { "kind": "speaker_share", "bytes": 181234567 }, { "kind": "audio", "bytes": 21234567 } ] } }
```

- **中身に入れないもの**：チャットの本文、字幕と文字起こしの文字、録画の URL、パスコード、参加の鍵、参加者の IP、電話の参加者の番号。受け手は、イベントを受けてから API で必要なものを取りに行く（スコープの検査が API で効く）。
- イベントを受けるには、そのイベントの資源を読むスコープが要る（例：`recording.*` は `recording:read`）。スコープを取り消したら、そのイベントの配送も止まる。
- `participant.*` は、100 人の会議で数百のイベントになる。組織ごとの配送の流量（毎秒 50）を超えた分は、待ち行列で遅らせる（捨てない）。

## 8. 障害のときの振る舞い

| 障害 | 起きること | 対処 |
| --- | --- | --- |
| public-api のタスクの過負荷 | `429`・`503` が増える | 自動で増やす。参加の API とは別のサービスなので、会議には響かない |
| Valkey が止まった | レート制限が各タスクの手元の数になる | 上限をタスクの数で割って続ける |
| 受け手が長く落ちている | 再送がたまる | 7.3 節。3 日で止め、知らせる |
| Webhook Worker の遅れ | 配送が遅れる | SQS の古さで監視し、Worker を増やす |
| egress proxy が止まった | 配送ができない | outbox と SQS にたまる。再送の時計は、proxy が戻ってから進める（受け手の失敗として数えない） |
| Actor が止まっている | `POST /end` が効かない | `503`、`Retry-After: 10` |

## 9. セキュリティとプライバシー

- トークンは不透明で、DB にはハッシュだけ。ログに出すのは接頭辞と末尾 4 文字だけ。
- 公開 API は CORS を許さない。ブラウザから直接呼ぶアプリは、OAuth のアプリの PKCE で、自分のサーバーを経由させる。
- サーバー間のアプリの作成・秘密の入れ替え・削除は、`admin_audit_events` に書く。
- OAuth の同意の画面で、アプリの持ち主、要求するスコープ、組織の `admin` の承認の要否を示す。
- Webhook の SSRF：7.1 節。egress proxy は許可した送り先の名前の解決の結果を検査し、リダイレクトを追わない。
- 会議の内容（チャット、字幕、録画の中身）は、API ではスコープと権限の検査の後にだけ返し、Webhook には載せない（通信の秘密。L2）。
- 公開 API の利用の条件（受け手が録画を外部に持ち出すことの扱い）は、L8 の契約の雛形に入れる。

## 10. テスト

### 10.1 性質ベーステスト

- **PROP-API-001（守り）**：公開 API のどの操作の列でも、待合室もパスコードもない会議ができない（PROP-SEC-001 と同じ検査を公開 API の経路で）。
- **PROP-API-002（権限）**：任意のトークン（スコープ、主体、組織）と資源の組で、公開 API の結果は、内部の `authorize` とスコープの積と一致する。
- **PROP-API-003（Webhook の署名）**：任意の本文と秘密で、署名の生成と SDK の検証が往復で一致する。本文を 1 バイト変えると検証が失敗する。
- **PROP-API-004（配送）**：任意の失敗・成功の列で、1 つのイベントの配送は、成功の後に再送されない。`webhook-id` は再送で変わらない。

### 10.2 契約と攻撃の試験

| 試験 | 期待 |
| --- | --- |
| OpenAPI の定義と実装の差分（CI） | 差分なし。版の中で項目を消していない |
| 私的な IP に向く Webhook の URL（DNS の付け替えを含む） | 登録も配送も拒否 |
| 古いリフレッシュトークンの再使用 | 系列ごと失効 |
| 利用者ごとの会議の作成 101 回目 | `429`、`limit: user_meeting_writes` |
| Webhook の本文の全イベントの検索 | チャットの本文、字幕、パスコード、参加の鍵、URL が現れない |
| RFC 9700 の確認の表の否定の試験（Auth0 の題材の ADR-0053 を写したもの） | すべて通る |

## 11. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E11 | `public-api-service` | 3 節。別のサービス、トークンの検証、OpenAPI |
| E11 | `oauth-authorization-server` | 4 節。認可コード＋PKCE、クライアントクレデンシャル、取り消し、RFC 9700 の確認の表 |
| E11 | `oauth-app-registry-and-consent` | 4.1 節。アプリの状態、`admin` の承認 |
| E11 | `api-meetings-and-users` | 5.1 節の会議とユーザー |
| E11 | `api-recordings-and-transcripts` | 5.1 節の録画と文字起こし、署名付きの URL |
| E11 | `api-reports` | 5.1 節のレポート（[accounts-and-admin.md](accounts-and-admin.md) の 6 節と一緒に） |
| E11 | `api-rate-limits` | 5.2 節 |
| E11 | `webhook-registration-and-validation` | 7.1 節。URL の確認、SSRF の対策 |
| E11 | `webhook-delivery` | 7.2〜7.3 節。署名、再送、止める、再送の要求 |
| E11 | `webhook-events` | 7.4 節 |
| E11 | `sdk-webhook-verifier` | `@<brand>/webhooks` |
| E11 | `token-secret-scanning-registration` | 4.2 節の接頭辞の登録 |

## 12. 未解決の問い

### 決定

2026-09-27 の既定案。承認は Dev（テックリード）が行う。

- **アプリ**：OAuth のアプリ（PKCE 必須）とサーバー間のアプリの 2 種類。共有の秘密だけで署名するトークンは作らない。
- **トークン**：不透明、1 時間。リフレッシュトークンは入れ替え式で 90 日。
- **レート制限**：4 つの分類。light 30/秒、medium 20/秒、heavy 10/秒、resource-intensive 10/分、heavy 以上の 1 日 60,000。会議の作成・更新は利用者ごとに 1 日 100 回。
- **Webhook**：Standard Webhooks の署名、URL の確認、7 回の再送（約 1.9 日）、3 日で止める。中身に会議の内容を入れない。
- **会議の中の操作**：出さない。会議を終えることだけ。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| 組織の契約でレート制限を上げる形 | 料金のプランを作るとき（MVP の外） |
| Better Auth の OAuth 2.1 の提供者のプラグインで、トークンの形・リフレッシュトークンの入れ替え・`private_key_jwt` を満たせるか | E11 の `oauth-authorization-server` |
| 会議の中の操作（ミュート、退出させる）を API に出すか | 利用者の声を見て PM が決める。出すなら Actor への命令として |
| 公開のアプリの審査の基準 | E11 |
| `participant.*` のイベントの量が多い組織への、まとめた配送 | E11 の負荷試験で決める |
| 受け手が録画を外部に持ち出すことの契約上の扱い（L8） | 法務の確認の後 |

## 13. quality.md・runbooks・data-model への項目

### quality.md

- 公開 API の可用性と遅れ（分類ごとの p95）。
- `429` の割合（分類ごと、アプリごと）。
- Webhook の配送の成功率（初回・再送の後）、outbox から最初の配送の試みまでの遅れ（p95、目標 10 秒、案）。
- `disabled` になった受け口の数。
- OpenAPI の定義と実装の差分（CI で 0）。

### runbooks

- `public-api-overload.md`：公開 API の過負荷のときの、アプリごとの流量の確かめ方と、特定のアプリを一時的に止める手順。
- `webhook-backlog.md`：配送の待ち行列がたまったときの確かめ方（SQS の古さ、受け手ごとの失敗）。
- `webhook-endpoint-disabled.md`：止めた受け口の持ち主からの問い合わせへの対応と、再開の手順。
- `oauth-token-leak.md`：トークンの漏えいの通報（シークレットスキャンを含む）を受けたときの失効と、アプリの持ち主への連絡。

### data-model（索引への追加の提案）

| 置き場所 | 中身 |
| --- | --- |
| Aurora `oauth_apps` | `app_id`、`owner_org_id`、`owner_user_id`、`kind`（`oauth`・`server`）、`status`（`draft`・`private`・`public`）、`redirect_uris`、`scopes`、`client_secret_hash` か `jwks_uri` |
| Aurora `oauth_app_org_approvals` | `app_id`、`org_id`、`approved_scopes`、`approved_by`、`approved_at`、`revoked_at` |
| Aurora `oauth_grants` | `grant_id`、`app_id`、`user_id?`、`org_id`、`scopes`、`created_at`、`revoked_at` |
| Aurora `oauth_tokens` | `token_hash`、`kind`（`access`・`refresh`）、`grant_id`、`family_id`、`expires_at`、`revoked_at`、`last4` |
| Aurora `webhook_endpoints` | `endpoint_id`、`app_id`、`org_id`、`url`、`events`、`secret_ciphertext`（入れ替え中は 2 つ）、`status`（`pending`・`active`・`disabled`）、`validated_at`、`failing_since` |
| Aurora `webhook_deliveries` | `delivery_id`（`webhook-id`）、`endpoint_id`、`event_id`、`attempt`、`status`、`response_code`、`next_attempt_at`、`created_at`（7 日で消す） |
| Aurora `outbox`（既存） | Webhook のイベントのもと |
| Valkey `rl:api:{app}:{org}:{category}`・`rl:api:mw:{user}:{day}` | 5.2 節 |

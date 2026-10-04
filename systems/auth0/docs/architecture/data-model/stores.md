# Data model: DB の外のストアと事象の形

[data-model.md](../data-model.md) の一部。Valkey のキー、S3 のキー、認証のイベントのログの形、ログストリームの本文、outbox の事象、SQS のキューを書く。**Valkey・SQS・S3 の JWKS は正本ではない。** 失っても DB から作り直せる（ADR-0005）。

## 1. Valkey

ElastiCache（Valkey）。クラスタモード。VPC の中だけ、TLS と AUTH（[security.md](../security.md) の 3.7 節）。

### 1.1 キーの規則

- 形は `<用途>:{<ハッシュタグ>}:<中身>`。テナントに属するキーは、ハッシュタグを `{t:<tenant_id>}` にする。S2 のクラスタで、テナントのキーを同じシャードに置く（[management-api-and-rate-limiting.md](../management-api-and-rate-limiting.md) の 7.1 節）。
- **キーに個人データと秘密の平文を入れない。** IP・メールアドレス・識別子は HMAC にする。セッションは Cookie の値ではなく、その SHA-256 を使う。
  - レート制限の IP・メールの HMAC は、日ごとに替える鍵で作る（TTL が 1 日以下なので替えてよい）。
  - 攻撃の防御の識別子・IP の HMAC は、テナントの鍵で作る（TTL が 30 日なので、日ごとには替えない）。
- すべてのキーに TTL を付ける。TTL のないキーを書かない（lint で確かめる）。
- 増やす・判定する・TTL を延ばすは、1 つの Lua のスクリプトで原子的に行う。

### 1.2 キーの一覧

| キー | 値 | TTL | 書く・読む | 失ったとき | 決めた場所 |
| --- | --- | --- | --- | --- | --- |
| `sess:{t:<tenant_id>}:<secret_hash_hex>` | セッションの行の写し（期限、`amr`、`acr`、`user_pk`、`sid`、`ended_at`） | 60 秒 | Auth | DB（reader → writer）から読む | [sessions-and-sso.md](../sessions-and-sso.md) の 3.5 節 |
| `rl:{t:<tenant_id>}:<limit>:<subject>` | GCRA の TAT | 制限の期間 | Auth、Management API | タスクの中の近似の制限（上限 ÷ タスク数） | [management-api-and-rate-limiting.md](../management-api-and-rate-limiting.md) の 7 節 |
| `rl:{ip:<ip_hmac>}:<limit>` | 同上（テナントに属さない制限） | 同上 | Auth | 同上 | 同上 |
| `ap:{t:<tenant_id>}:bf:<identifier_hmac>:<ip_hmac>` | 失敗の数、最後の失敗の時刻 | 30 日 | Auth | タスクの近似。ブロックの正本は `brute_force_blocks` | [attack-protection.md](../attack-protection.md) の 4.3 節 |
| `ap:{t:<tenant_id>}:bfd:<identifier_hmac>:<device_id>` | 既知の端末ごとの失敗の数 | 30 日 | Auth | 同上 | 同上 |
| `ap:{t:<tenant_id>}:ip:<bucket>:<ip_hmac>` | バケツの残りと最後の補充の時刻 | 2 日 | Auth | 同上 | 同上 |
| `ap:{p}:ip:login:<ip_hmac>` | プラットフォームのバケツ | 2 日 | Auth | 同上 | 同上 |
| `ap:{t:<tenant_id>}:ch:<challenge_id>` | PoW のチャレンジの使用済みの印 | 10 分 | Auth | タスクのメモリーで代える | 同上の 6.3 節 |
| `jti:{t:<tenant_id>}:<kind>:<client_id>:<jti_sha256>` | `1`（`SET NX`） | アサーションの `exp` まで | Auth | `client_assertion_jtis` に書く。両方だめなら 503 | [authentication-flows.md](../authentication-flows.md) の 6.1 節 |
| `pwned:{p}:<prefix5>` | 範囲の応答（接尾辞と件数の一覧） | 24 時間 | Auth | 公式の range API をもう一度呼ぶ | [attack-protection.md](../attack-protection.md) の 5.2 節（予備の案の間） |
| `cfg:changed`（pub/sub のチャンネル） | `{tenant_id, version}` | — | Relay が出し、全タスクが受ける | 5 秒のポーリングで追いつく | [tenants-and-applications.md](../tenants-and-applications.md) の 7.3 節 |

- `<kind>` は `client_assertion`・`dpop`。`jti` は秘密ではないが、長さをそろえるため SHA-256 にする。
- ログインのトランザクション、OTP、認可コード、ログストリームのリースは Valkey に置かない（ADR-0011、[mfa-and-passkeys.md](../mfa-and-passkeys.md) の 3.2 節、2026-09-28 の決定）。1 回限りの保証とリースは DB で持つ。

> 2026-09-28 の統合：sessions-and-sso の 3.5 節の `sess:{tenant_id}:{secret_hash}` と、attack-protection の 4.3 節の `ap:...:<ip_prefix>` を、上の形にそろえた（ハッシュタグ `{t:<tenant_id>}`、IP は HMAC）。

## 2. S3

すべてのバケットでバージョニングを有効にし、保存の暗号化は `<brand>-data`（log-archive は log-archive のアカウントの鍵）。

| バケット（論理名） | キーの形 | 中身 | 書く | 保持 |
| --- | --- | --- | --- | --- |
| `edge-origin`（prod、東京 → 大阪へ複製） | `discovery/<hostname>/openid-configuration`、`jwks/<hostname>/jwks.json` | ホスト名ごとの discovery と JWKS。メタデータに `state_version` と SHA-256 | Worker だけ | 最新。古いバージョンはバージョニングで 30 日 |
| 同上 | `assets/<tenant_id>/<sha256>.<ext>` | Universal Login のロゴ・ファビコン・背景画像（SVG は無害化の後） | Management API | テナントの削除まで。参照のなくなった資産は 30 日で消す |
| 同上 | `static/<release>/...` | Universal Login の CSS・JavaScript・書体 | CI | 直近 10 リリース |
| `breached-passwords`（prod） | `pwned/v<version>/<prefix5>.txt` | 漏えいしたパスワードの範囲。**法務の確認の後だけ** | Worker | `current` と `previous` のバージョン |
| `user-transfer`（prod、MVP の後） | `imports/<tenant_id>/<job_id>/input.jsonl.gz`、`imports/<tenant_id>/<job_id>/result.jsonl`、`exports/<tenant_id>/<job_id>/output.<jsonl|csv>.gz` | インポート・エクスポートのファイル | Management API（署名付き URL）、Worker | 7 日 |
| `auth-events-analytics`（prod） | `events/dt=<YYYY-MM-DD>/hour=<HH>/part-*.parquet` | 認証のイベントの調査用（Firehose）。テナントには見せない | Firehose | 90 日 |
| `log-archive`（log-archive のアカウント、Object Lock） | `audit/tenant/<YYYY>/<MM>/<DD>/<batch>.jsonl.gz`、`audit/platform/...` | 監査ログ（ハッシュの連鎖） | Relay | 7 年 |
| 同上 | `auth-events/<YYYY>/<MM>/<DD>/<shard>/<batch>.jsonl.gz` | 認証のイベントの保管（DR のやり直しの材料） | log-ingester | 90 日（既定案。期間は security.md の 9 節に行がないので、法務の L5 と一緒に決める。[data-model.md](../data-model.md) の 8 節の持ち越し） |
| 同上 | `pepper/v<version>.ciphertext` | pepper の暗号文の予備 | 運用の手順 | 消さない |
| 同上 | CloudTrail、CloudFront・WAF のログ | AWS の標準の形 | AWS | 13 か月〜7 年（infrastructure の領域） |
| `actions-bundles`（actions のアカウント、MVP の後） | `bundles/<tenant_id>/<action_id>/<version_id>/<sha256>.zip` | Action の束 | CodeBuild | バージョンが参照されなくなって 30 日 |

- カスタムドメインの discovery と JWKS は、`issuer` がそのホスト名になるので、テナントの ID ではなくホスト名でキーを分ける（CloudFront Functions でパスを書き換える。[infrastructure.md](../infrastructure.md) の 4.2 節）。
- テナントの削除で、`assets/<tenant_id>/` と、テナントのホスト名の `discovery/`・`jwks/` を消す。
- 各バケットの物理名とライフサイクルの設定は Terraform に置く（infrastructure の領域）。

## 3. 認証のイベントのログの形

`logs` の行と、Management API の `/logs` の応答と、ログストリームの 1 件は、同じ形にする（ADR-0042）。フィールドの名前は本家の公開のスキーマに寄せる。

```json
{
  "log_id": "01JQ3Z8K2M0C7F4X9A1B2C3D4E",
  "date": "2026-09-27T03:12:45.123Z",
  "type": "s",
  "description": "Successful login",
  "tenant_name": "example",
  "hostname": "example.jp.<brand>.<domain>",
  "client_id": "Xy12...",
  "client_name": "Example Web",
  "connection": "Username-Password",
  "connection_id": "con_...",
  "strategy": "database",
  "strategy_type": "database",
  "user_id": "usr_4Qz8kP2mX7vN1bR6tY3wLc",
  "user_name": "taro@example.com",
  "ip": "203.0.113.10",
  "user_agent": "Chrome 140.0.0 / Mac OS X 15.6",
  "organization_id": null,
  "details": { "prompts": [], "session_id": null, "amr": ["pwd", "otp"] },
  "references": { "request_id": "...", "correlation_id": null, "transaction_id": "..." },
  "$event_schema": { "version": "1.0.0" }
}
```

| フィールド | 型 | 規則 |
| --- | --- | --- |
| `log_id` | 26 文字 | テナントの中で単調。重複を捨てる鍵 |
| `date` | ISO 8601（ミリ秒、UTC） | 発生の時刻。`log_id` の順と一致しないことがある |
| `type` | 文字列 | 種類のコード（[logs-and-streams.md](../logs-and-streams.md) の 3.2 節） |
| `tenant_name` | 文字列 | DB の列には持たず、出力のときに足す |
| `user_name` | 文字列 | ログインに使った識別子。ストリームでは `mask`・`hash`（ストリームごとの鍵の HMAC-SHA-256）を選べる |
| `details` | オブジェクト | 種類ごとの許可リスト。秘密（パスワード、コード、トークン、クライアントの秘密、TOTP の種、セッションの ID、確認コード）のフィールドは存在しない。`session_id` は `sid` の値 |
| `$event_schema.version` | semver | 足す変更だけをする |

- 取り込みの検証で落ちた行は dead letter に入れる。秘密の形（`<brand>_rt_`、JWT の形など）を含む疑いの行は、dead letter にも残さず捨てる（ADR-0061）。

## 4. ログストリームの本文

### 4.1 Webhook（`http`）

```
POST <url>
Content-Type: application/x-ndjson
Authorization: <テナントが登録した値>
<Brand>-Signature: t=1790400000,v1=<hex(HMAC-SHA256(key, t + "." + body))>
<Brand>-Stream-Id: <stream_id>
<Brand>-Delivery-Attempt: 1
User-Agent: <Brand>-LogStreams/1.0
```

| 形式 | 本文 |
| --- | --- |
| `JSONLINES`（既定） | 1 行に 3 節の 1 件。最大 100 件か 1 MiB |
| `JSONARRAY` | 3 節の配列 |
| `JSONOBJECT` | 3 節の 1 件だけ（1 件ずつ送る） |

- 鍵のローテーションの 24 時間は `v1=` を 2 つ並べる。
- 伏せ字（`pii_config`）は送る直前にかける。`logs` の行は変えない。

### 4.2 EventBridge

`PutPartnerEvents` の 1 件の `Detail` に、3 節の 1 件を入れる。

| 項目 | 値 |
| --- | --- |
| `Source` | `aws.partner/<brand>.<domain>/<tenant>/<stream_id>` |
| `DetailType` | 種類のカテゴリー（例：`auth.login.success`） |
| `Detail` | 3 節の 1 件（JSON の文字列）。1 MB の上限を超えるときは `details` を切り詰め、`details_truncated: true` を足す |
| `Time` | `date` |

## 5. outbox の事象

`outbox.payload` は、ID と種類だけを持つ。秘密と個人データの値（メールアドレス、名前）を入れない。Relay は `topic` で SQS のキューを選ぶ。

| `topic` | `payload` の形 | 受け手 |
| --- | --- | --- |
| `log_event` | `{ log: <3 節の形。log_id と tenant_name を除く> }` | log-ingester（`auth-events`） |
| `tenant.config_changed` | `{ tenant_id, version }` | Valkey の `cfg:changed` |
| `tenant_hostname.changed` | `{ hostname, tenant_id, version, op: "upsert" | "delete" }` | 全タスク（ホスト名の表の差分） |
| `jwks.changed` | `{ tenant_id, state_version }` | Worker（`jwks-publish`） |
| `session.ended` | `{ tenant_id, session_id, sid, reason }` | Worker（Back-Channel Logout、系列の失効） |
| `backchannel_logout.requested` | `{ tenant_id, delivery_id }` | Worker（`backchannel-logout`） |
| `user.created`・`user.updated` | `{ tenant_id, user_id }` | Worker（`last_login_at` などの遅れた書き込み、ログストリーム） |
| `user.blocked`・`user.deleted` | `{ tenant_id, user_id }` | Worker（セッション・系列の失効、ログの仮名化） |
| `user.identity_linked`・`user.identity_unlinked` | `{ tenant_id, user_id, secondary_user_id?, connection_id }` | Worker |
| `user.link_ambiguous` | `{ tenant_id, connection_id }` | 指標だけ |
| `organization.member_removed` | `{ tenant_id, organization_id, user_pk }` | Worker（系列の失効。E14） |
| `apple.notification` | `{ tenant_id, connection_id, event_type, identity_id }` | Worker（Apple のサーバー間の通知） |
| `custom_domain.transition` | `{ tenant_id, custom_domain_id, to }` | Worker（`custom-domain`） |

- `user.*` の `user_id` は外に出す値。ログストリームと Back-Channel Logout がそのまま使う。
- 事象の本文の型は、開発リポジトリの共通の型（Zod）に置く。

## 6. SQS のキュー

| キュー | 流す事象 | 受け手 | DLQ |
| --- | --- | --- | --- |
| `auth-events` | `log_event` | log-ingester | あり（秘密の疑いは捨てる） |
| `email-auth`・`email-notify` | `email_outbox` の行 | 送信の Worker | あり |
| `backchannel-logout` | `session.ended`、`backchannel_logout.requested` | Worker（`worker-egress`） | あり |
| `log-stream-delivery` | `log_stream_notify` の変化の通知 | log-streamer（`worker-egress`） | なし（カーソルで回復） |
| `jwks-publish` | `jwks.changed` | Worker | あり |
| `custom-domain` | `custom_domain.transition`、定期の確認 | Worker | あり |
| `user-events` | `user.*`、`organization.*`、`apple.notification` | Worker | あり |

- 本文は outbox の行の ID と `topic` と `payload`。受け手は冪等に作る（同じ事象を 2 回受けてよい）。
- キューの流量とタスク数は [capacity.md](../capacity.md) の 2.8 節。

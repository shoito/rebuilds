# Dashboard and API: Cloudflare Workers

管理 API（版、冪等、ページング、エラー、レート制限）、ダッシュボードの SPA、アカウントとメンバーとロール、ログイン、API トークン（スコープ、接頭辞、チェックサム、シークレットスキャン）、監査ログを決める。

| 関連 | 決定 |
| --- | --- |
| [ADR-0001](../decisions/0001-runtime-build-vs-reuse.md) | 制御プレーンは TypeScript（Hono＋Zod）、Aurora PostgreSQL、テナントの表は `account_id` と RLS |
| [ADR-0021](../decisions/0021-versions-deployments-and-gradual-rollout.md) | 版とデプロイのモデル |
| [ADR-0041](../decisions/0041-management-api-shape.md) | 管理 API は `/v1` のパスの版で足す変更だけを入れる。POST は冪等キー、一覧は不透明なカーソル、エラーは RFC 9457、レート制限はトークンごとに 5 分 1,200 |
| [ADR-0042](../decisions/0042-api-tokens-roles-and-audit-log.md) | API トークンは `<brand>_` の接頭辞・種類・40 文字の乱数・CRC32 のチェックサムの形で、シークレットスキャンに登録する。ロールは 5 つの固定のロールと権限の一覧。監査ログは変更と同じトランザクションで書き、18 か月持つ |

版とデプロイの意味は [deployment-and-config-distribution.md](deployment-and-config-distribution.md)、ドメインとホスト名は [edge-network-and-routing.md](edge-network-and-routing.md)、CLI とログは [developer-tooling.md](developer-tooling.md)、請求と使用量は [limits-and-billing.md](limits-and-billing.md) にある。制御プレーンの脅威モデル、監査ログの改ざんの検知と長期の保存、鍵の管理は [security.md](security.md)、メトリクスの経路は [observability.md](observability.md) にある。

本家の振る舞いと数値は、2026-09-27 に本家の文書（API、API トークン、ロール、監査ログ）と GitHub のシークレットスキャンのパートナープログラムの文書で確かめた。

## 1. 目的と範囲

- 目的：CLI・ダッシュボード・利用者の自動化が、同じ 1 つの公開の API を使う。誰が何をしたかを、利用者が後から確かめられる。トークンが漏れたら、公開のリポジトリに載った時点で失効できる。

| 範囲に含む | 範囲に含まない（担当の領域） |
| --- | --- |
| 管理 API の URL、認証、版、冪等、ページング、同時の更新、エラー、レート制限 | 各資源の意味（各領域） |
| アカウント、メンバー、招待、ロール、権限 | 基盤の運用者の権限と、本番への立ち入り（security） |
| ログイン、MFA、セッション | ログインの基盤の実装の詳細（他の題材の決定を引き継ぐ） |
| API トークンの形、スコープ、保存、シークレットスキャン | 鍵の保管（KMS）の全体（security） |
| 利用者向けの監査ログ | 監査ログの改ざんの検知、WORM の保存（security） |
| ダッシュボードの SPA の作り、画面、言語、アクセシビリティ | メトリクスの集計の経路（observability） |

## 2. 本家の仕組み（確かめたこと）

| 項目 | 本家 | 出典（すべて 2026-09-27 に確認） |
| --- | --- | --- |
| API の入口 | `https://api.cloudflare.com/client/v4/`。`Authorization: Bearer <API_TOKEN>`。応答は `success`・`errors`・`messages`・`result`・`result_info`。一覧は `page`・`per_page`・`order`・`direction` | [Make API calls](https://developers.cloudflare.com/fundamentals/api/how-to/make-api-calls/) |
| レート制限 | 利用者ごとに 5 分に 1,200 要求（ダッシュボード・API キー・API トークンの合計）。超えると次の 5 分は全て 429。`Ratelimit`・`Ratelimit-Policy`・`retry-after` のヘッダー | [Rate limits](https://developers.cloudflare.com/fundamentals/api/reference/limits/) |
| API トークンの権限 | 権限の群（アカウント・利用者・ゾーン）と、読み込み・編集の段。資源（特定のゾーンなど）で絞れる。送り元の IP の絞り込みと有効期間を持つ。秘密は 1 回だけ表示。利用者のトークンと、利用者に結び付かないアカウントのトークンがある | [Create API token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/) |
| トークンの形 | 種類ごとの接頭辞（`cfk_`・`cfut_`・`cfat_`）＋40 文字＋チェックサム。接頭辞とチェックサムで、スキャンの道具が高い確度で見つけられる。GitHub のシークレットスキャンに参加し、公開のリポジトリで見つかったら自動で失効し、メールで知らせる。古い形のトークンも使える | [Token formats](https://developers.cloudflare.com/fundamentals/api/get-started/token-formats/)（2026-04-20 更新） |
| ロール | Super Administrator（全て、メンバー・請求・アカウントのトークン）、Administrator（メンバーと請求の情報は扱えない）、Administrator Read Only、Billing、Workers Platform Admin・Read-only など 100 以上 | [Roles](https://developers.cloudflare.com/fundamentals/manage-members/roles/) |
| 監査ログ | ログイン、設定の変更などを記録。18 か月で消す。ダッシュボードと API で見られ、CSV で落とせる。Enterprise は Logpush で長く置ける。ベータの機能の多くは載らない。版 2 がある | [Audit logs](https://developers.cloudflare.com/fundamentals/account/account-security/review-audit-logs/) |
| シークレットスキャンのパートナー | パートナーは正規表現（固有の接頭辞、高いエントロピー、32 ビットのチェックサムを勧める）と、知らせの受け口の URL を出す。知らせは `token`・`type`・`url`・`source` を持ち、`Github-Public-Key-Identifier`・`Github-Public-Key-Signature` のヘッダーで ECDSA（NIST P-256、SHA-256）の署名を付ける。パートナーは `true_positive`・`false_positive` の印を返せる。対象は公開のリポジトリと公開の npm のパッケージ | [Secret scanning partner program](https://docs.github.com/en/code-security/secret-scanning/secret-scanning-partnership-program/secret-scanning-partner-program) |

**本家との違いを先に書く。**

- 一覧は `page`・`per_page` ではなく、不透明なカーソルにする（4.5 節）。書き込みの多い一覧で、頁の番号はずれるため。
- ロールは 100 以上ではなく、5 つの固定のロールにする（5.3 節）。製品の数が少なく、S1 の利用者の多くは小さなチーム。
- 接頭辞は `<brand>_` で始める（[リポジトリ共通の ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。形（接頭辞＋40 文字＋チェックサム）は本家に寄せる。

## 3. 原則

- **公開の API は 1 つ。** CLI とダッシュボードは、公開の API と同じハンドラーを使う。ダッシュボード専用の口は、公開の API にない画面の都合（集計の表示、ブートストラップ）だけにする。
- **変更には必ず監査の記録がある。** 監査ログの行は、変更と同じトランザクションで書く。
- **秘密は 1 回だけ見せ、保存しない。** API トークンの秘密、シークレットの値は、ハッシュか暗号文だけを持つ。
- **管理のドメインを、既定のサブドメインと分ける。** API とダッシュボードは `<console-domain>`（例：`api.<console-domain>`、`dash.<console-domain>`）に置き、利用者の関数の `*.<brand>.<domain>` と別の登録ドメインにする（[edge-network-and-routing.md](edge-network-and-routing.md) の 6.1 節）。

## 4. 管理 API

[ADR-0041](../decisions/0041-management-api-shape.md)。

### 4.1 URL と資源

```
https://api.<console-domain>/v1
  /user                                             ログインしている利用者
  /accounts                                         GET（属するアカウント）、POST
  /accounts/{account_id}
    /members, /invitations                          5 節
    /tokens                                         6 節（アカウントのトークン）
    /audit-events                                   7 節
    /scripts                                        関数
      /{script_name}
        /versions            POST（202）、GET
        /versions/{id}
        /deployments         POST、GET
        /deployments/{id}/propagation               伝搬の状態（CLI の deploy の待ち）
        /secrets/{name}      PUT、DELETE（値は返さない）
        /secrets             GET（名前と作成の時刻だけ）
        /tails               POST（developer-tooling の 7 節）
        /settings            GET、PATCH（subdomain、observability など版に入らない設定）
        /triggers/crons      PUT
    /domains, /hostnames, /routes                   edge-network-and-routing
    /kv/namespaces[/{id}/values/{key}]               kv-store
    /buckets                                        object-storage
    /durable-objects/namespaces, /queues            各領域
    /logs/query                                     developer-tooling の 8.2 節
    /usage, /invoices, /budget-alerts, /billing     limits-and-billing
/user/tokens                                        利用者のトークン
```

- 関数は、URL で名前（アカウントの中で一意）を使う。応答には ID も返す。他の資源は ID（`kvn_…` のような種類の接頭辞＋UUIDv7 の base62）を使う。この ID は秘密でないので、`<brand>` の接頭辞を付けない。
- 本文は JSON。版の作成だけ `multipart/form-data`（マニフェスト、モジュール、ソースマップ）。本文の上限は 100MB（有料の圧縮後 10MiB のバンドルとソースマップを収める）。
- 応答の形：資源は資源そのものの JSON。一覧は `{"data": [...], "next_cursor": "..." | null}`。本家の `success`・`result` の包みは使わない（HTTP の状態コードで成否が分かる）。

### 4.2 認証

| 主体 | 方式 |
| --- | --- |
| API トークン（利用者・アカウント） | `Authorization: Bearer <brand>_ut_…` / `<brand>_at_…`（6 節） |
| CLI | OAuth のアクセストークン `Authorization: Bearer <brand>_oa_…`（1 時間。[developer-tooling.md](developer-tooling.md) の 4.3 節） |
| ダッシュボード | 同じオリジンの `/api/...` にセッションの Cookie（5.4 節）。サーバーが公開の API と同じハンドラーに渡す |

- どの主体でも、権限の判定は「主体の持つ権限 ∩ 資源の範囲」で同じ関数を通す（6.2 節）。

### 4.3 版

- パスの主版（`/v1`）だけを持つ。`/v1` の中では、足す変更だけを入れる（任意の欄、新しい資源、新しい列挙の値）。
- クライアント（CLI、SDK）は、知らない列挙の値を `unknown` として扱う。これを文書に書く。
- 壊す変更は `/v2` にし、`/v1` を少なくとも 12 か月動かす。告知は、応答の `Deprecation`・`Sunset` のヘッダー、メール、変更の記録で行う。
- 日付の版（rebuilds の Stripe の題材の方式）は採らない。資源が少なく、主な利用者は CLI で、CLI の版が API の使い方を固定するため（ADR-0041）。

### 4.4 冪等

- すべての `POST` が `Idempotency-Key`（255 文字まで）を受ける。CLI は常に付ける。
- 範囲は「アカウント × キー」。最初の応答（状態コードと本文）を 24 時間保存し、同じキー・同じ要求には同じ応答を返し、`Idempotent-Replayed: true` を付ける。
- 同じキーで本文が違えば 422（`idempotency_key_reused`）。処理中なら 409（`idempotency_key_in_use`）。検証の失敗、401、403、429 は保存しない。
- 版の作成は 202 を返す長い操作なので、再送には同じ版の ID と状態を返す（版を 2 つ作らない）。
- `PUT` と `DELETE` はもともと冪等。`DELETE` の 2 回目は 404。

### 4.5 ページング

- `limit`（既定 50、最大 200。ログの問い合わせは 1,000）と `cursor`（不透明）。
- `cursor` は、並びの鍵（作成の時刻と ID）と絞り込みの条件のハッシュを、サーバーの鍵で暗号化したもの（AES-GCM）。条件を変えて使うと 400（`invalid_cursor`）。有効期限 24 時間。
- 総件数は返さない。

### 4.6 同時の更新

- 変えられる資源（`settings`、ルート、ロールの割り当てなど）は `etag` を持つ。`PATCH`・`PUT` は `If-Match` を任意で受け、合わなければ 412（`etag_mismatch`）。CLI とダッシュボードは常に付ける。
- 版は変えられないので対象外。デプロイは「最新の行がいまのデプロイ」なので、`POST .../deployments` は `If-Match: <いまのデプロイの ID>` を任意で受け、段階的なデプロイの割合の変更がぶつからないようにする。

### 4.7 エラー

- `application/problem+json`（RFC 9457）。

```json
{
  "type": "https://docs.<console-domain>/errors/bundle_too_large",
  "title": "Bundle too large",
  "status": 400,
  "code": "bundle_too_large",
  "detail": "Compressed bundle is 12.4 MiB; the limit for the paid plan is 10 MiB.",
  "request_id": "req_01J…",
  "errors": [ { "pointer": "/modules/3", "code": "too_large" } ]
}
```

| 状態 | `code` の例 |
| --- | --- |
| 400 | `validation_failed`、`bundle_too_large`、`compat_date_out_of_range`、`invalid_cursor` |
| 401 | `invalid_token`、`token_expired`、`token_revoked` |
| 403 | `permission_denied`、`ip_not_allowed`、`mfa_required`、`account_suspended` |
| 404 | `not_found`（他のアカウントの資源も 404。存在を漏らさない） |
| 409 | `conflict`、`idempotency_key_in_use`、`too_many_tail_sessions` |
| 412 | `etag_mismatch` |
| 422 | `idempotency_key_reused`、`rollback_not_possible` |
| 429 | `rate_limited` |

### 4.8 レート制限

| 単位 | 上限 | 備考 |
| --- | --- | --- |
| トークン・利用者（セッション）ごと | 5 分に 1,200 | 本家と同じ値 |
| アカウントごと | 5 分に 6,000 | 1 つのアカウントの多数のトークンでの大量の呼び出しを抑える |
| 版の作成 | 関数ごとに 1 分 10 | 検証のフリートを守る |
| ログの問い合わせ | アカウントで同時 5 | [developer-tooling.md](developer-tooling.md) の 8.2 節 |

- 窓は滑る窓（1 分ごとの 5 つの桶）。本家の「超えたら次の 5 分は全部 429」はとらず、窓の中の数が下がれば通す。
- ヘッダー：`RateLimit-Policy: "token";q=1200;w=300`、`RateLimit: "token";r=<残り>;t=<秒>`（IETF の草案の形。本家と同じ系統）。429 には `Retry-After`。
- 数はリージョンの Valkey で持つ（制御プレーンは東京だけなので、1 か所で足りる）。Valkey が落ちたら、制限をかけずに通す（管理 API の可用性を先にする）。

### 4.9 長い操作

- 版の作成は 202 と `Location: /v1/accounts/{a}/scripts/{s}/versions/{id}`。版の `status`（`validating`・`distributing`・`ready`・`failed`）を追う。
- ドメインの確認、証明書の発行も同じく資源の `status` で追う（edge-network-and-routing）。
- 汎用の `operations` の資源は持たない（長い操作が資源の状態で表せるため）。

### 4.10 契約

- API は `@hono/zod-openapi` で書き、OpenAPI 3.1 を `https://api.<console-domain>/v1/openapi.json` に公開する。
- 公式の SDK は TypeScript の `@<brand>/api`（OpenAPI から生成）。CLI も同じ SDK を使う。
- Terraform のプロバイダーは S2。

## 5. アカウント、メンバー、ロール、ログイン

[ADR-0042](../decisions/0042-api-tokens-roles-and-audit-log.md)。

### 5.1 アカウント

- アカウントは、課金・テナントの分離・資源の持ち主の単位。全てのテナントの表の `account_id`。
- 1 人の利用者が複数のアカウントに属せる。1 人が作れるアカウントは 3 つまで（無料の枠の使い回しを抑える。[abuse-and-trust-safety.md](abuse-and-trust-safety.md) の 8 節）。
- アカウントのサブドメインの名前（`<account>`）は作るときに選ぶ（[edge-network-and-routing.md](edge-network-and-routing.md) の 6.1 節）。変えられるのは 1 年に 1 回（古い名前は 90 日他に渡さない）。
- アカウントの削除は、`owner` がステップアップの MFA の後に行う。削除の予約から 30 日は取り消せる。その間、関数は止め（1203）、データは保持する。

### 5.2 メンバーと招待

- 招待はメールで送り、7 日で切れる。招待を受けるには、招待されたメールアドレスでログインする。
- `owner` は常に 1 人以上。最後の `owner` は外せない。持ち主の移しは、移す人と受ける人の両方のステップアップの MFA を求める。
- メンバーを外したら、その人のセッションとそのアカウントへの利用者のトークンの権限は、次の要求から効かない（6.2 節の「現在の権限との積」）。

### 5.3 ロールと権限

| 権限 | `owner` | `admin` | `developer` | `viewer` | `billing` |
| --- | --- | --- | --- | --- | --- |
| `account:read` | ○ | ○ | ○ | ○ | ○ |
| `scripts:read` | ○ | ○ | ○ | ○ | |
| `scripts:write`（版、デプロイ、ロールバック、設定、cron） | ○ | ○ | ○ | | |
| `secrets:write`（値は誰も読めない） | ○ | ○ | ○ | | |
| `routes:write`（ドメイン、ホスト名、ルート） | ○ | ○ | ○ | | |
| `storage:read`（KV・バケット・Durable Objects・キューの一覧と中身） | ○ | ○ | ○ | | |
| `storage:write` | ○ | ○ | ○ | | |
| `logs:read`（保存したログの検索） | ○ | ○ | ○ | | |
| `logs:tail` | ○ | ○ | ○ | | |
| `metrics:read`（件数・遅延の集計。要求の中身を含まない） | ○ | ○ | ○ | ○ | |
| `billing:read` | ○ | ○ | | | ○ |
| `billing:write`（支払い手段、計画、費用の上限、予算） | ○ | | | | ○ |
| `members:write` | ○ | ○（`owner` の付け外しを除く） | | | |
| `tokens:write`（アカウントのトークン） | ○ | ○ | | | |
| `audit:read` | ○ | ○ | | ○ | |
| アカウントの削除、持ち主の移し | ○ | | | | |

- `viewer` には、ログと、ストレージの中身を見せない。どちらも関数の利用者（エンドユーザー）のデータを含むため。
- 利用者が作るロール（任意の権限の組み合わせ）は S2 にする。S1 は API トークンのスコープで細かく絞る（6.2 節）。

### 5.4 ログインと MFA

- rebuilds の他の題材の方式（Better Auth を自前でホストし、パスワードを持たない。Slack の題材の [ADR-0012](../../../slack/docs/decisions/0012-self-hosted-auth-with-better-auth.md)）を引き継ぐ。手段は、メールの OTP、GitHub（OIDC に相当する OAuth）、Google（OIDC）、パスキー。
- **重要な操作の前は、ステップアップの MFA**（直近 10 分以内のパスキーか TOTP）を求める：

| 操作 |
| --- |
| API トークンの作成・入れ替え |
| ロールの付与・変更、招待、メンバーの削除、持ち主の移し |
| 支払い手段・計画・費用の上限の変更 |
| アカウント・関数・バケット・名前空間の削除 |
| アカウントの設定の「全員に MFA を必須」の変更 |

- アカウントの設定で「全員に MFA を必須」を有効にすると、MFA を登録していないメンバーは、そのアカウントの画面と API に入れない（登録の画面だけ見える）。`owner`・`admin` には、登録から 14 日以内に MFA の登録を求める（S1 の既定）。
- セッション：HttpOnly・Secure・SameSite=Lax の Cookie。アイドル 24 時間、絶対 14 日。
- SAML・OIDC のシングルサインオン、SCIM は S2。

## 6. API トークン

[ADR-0042](../decisions/0042-api-tokens-roles-and-audit-log.md)。

### 6.1 形

```
<brand>_<kind>_<random40><checksum6>

kind      ut = user API token, at = account API token,
          oa = OAuth access token (CLI), or = OAuth refresh token (CLI)
random40  40 characters of base62 from a CSPRNG (≈238 bits)
checksum6 CRC32 over "<brand>_<kind>_<random40>", encoded as 6 base62 characters (zero-padded)

regex     \b<brand>_(ut|at|oa|or)_[0-9A-Za-z]{46}\b
```

- 接頭辞は本家の形（接頭辞＋40 文字＋チェックサム）に寄せ、名前は `<brand>` にする。`<brand>` の実際の値を決めるとき、他の既知のサービスの接頭辞と重ならないことを確かめる（リポジトリ共通の ADR-0006）。
- チェックサムは、スキャンの道具が、偽の一致（文書の例、乱数でない文字列）を捨てるためのもの。秘密の強さには関わらない。
- 画面と一覧には、`<brand>_<kind>_` と最後の 4 文字だけを見せる。

### 6.2 スコープ

```jsonc
{
  "name": "ci-deploy-api-gateway",
  "permissions": ["scripts:write", "secrets:write"],
  "resources": [ { "type": "script", "id": "api-gateway" } ],   // or [{"type":"account"}]
  "allowed_cidrs": ["203.0.113.0/24"],                            // optional
  "expires_at": "2027-03-31T00:00:00Z"                            // optional
}
```

- 権限は 5.3 節の一覧から選ぶ。資源は、アカウント全体か、関数・名前空間・バケット・キュー・ホスト名の個別の ID。
- **実際に効く権限** = トークンの権限 ∩ トークンの資源の範囲 ∩（利用者のトークンなら）その利用者のいまのロールの権限。利用者のロールが下がれば、その利用者のトークンも次の要求から下がる。アカウントのトークンは利用者に結び付かない（本家と同じ）。
- 作るときに、作る人が持たない権限は付けられない。アカウントのトークンは `tokens:write` を持つ人だけが作れる。
- `allowed_cidrs` に合わない送り元は 403（`ip_not_allowed`）。
- 有効期限は任意。画面の既定は 90 日を提案する。90 日使われていないトークンは、作った人と `owner` に知らせる。

### 6.3 保存と検証

```sql
CREATE TABLE api_tokens (
  account_id      uuid,                 -- NULL for user tokens not bound to one account
  user_id         uuid,                 -- NULL for account tokens
  id              uuid        PRIMARY KEY,
  kind            text        NOT NULL, -- ut | at | oa | or
  name            text        NOT NULL,
  token_sha256    bytea       NOT NULL UNIQUE,
  last4           text        NOT NULL,
  permissions     text[]      NOT NULL,
  resources       jsonb       NOT NULL,
  allowed_cidrs   cidr[],
  expires_at      timestamptz,
  created_by      uuid        NOT NULL,
  created_at      timestamptz NOT NULL,
  last_used_at    timestamptz,          -- updated at most once per minute
  last_used_ip    inet,
  revoked_at      timestamptz,
  revoked_reason  text                  -- user | secret_scanning | member_removed | abuse | rotation
);
-- RLS on account_id for account tokens; user tokens are visible only to their user.
```

- 検証：チェックサムを先に確かめ（合わなければ DB を引かずに 401）、SHA-256 で引く。秘密は 238 ビットの乱数なので、ソルトや遅いハッシュは要らない（総当たりが成り立たない）。
- 引いた結果は API のタスクのメモリに 30 秒持つ。失効は、失効の印を Valkey に書き、全タスクが 1 秒ごとに読むことで 2 秒以内に効かせる。

### 6.4 シークレットスキャン

- `<brand>` の実際の値を決めたら、GitHub のシークレットスキャンのパートナープログラムに、6.1 節の正規表現と受け口の URL を登録する（E1。リポジトリ共通の ADR-0006）。

```
GitHub ──POST https://api.<console-domain>/internal/secret-scanning/github──▶ 受け口
  1. Github-Public-Key-Identifier の鍵を GitHub の公開の鍵の一覧から引き（1 時間持つ）、
     Github-Public-Key-Signature を ECDSA P-256 / SHA-256 で検証する。合わなければ 401
  2. 各 {token, type, url, source} について：
       チェックサムを確かめる → SHA-256 で引く → 有効なら即時に失効（revoked_reason = secret_scanning）
  3. 持ち主（利用者のトークンは本人、アカウントのトークンは作った人と owner）にメール。見つかった URL を示す
  4. 監査ログ：token.revoked（actor = system:secret_scanning）
  5. 応答：[{token_hash, token_type, label: true_positive | false_positive}]
```

- 公開のリポジトリで見つかったものは、知らせを待たずに自動で失効する（本家と同じ）。誤りの失効は、利用者が新しいトークンを作って置き換える（元に戻す機能は持たない）。
- 知らせの受け口は、1 回に多数の一致を受けても時間切れにならないよう、失効を非同期の処理（SQS）に回し、受け付けを先に返す。
- GitHub の公開の鍵の一覧の URL と形は、登録の時点で確かめる（未検証）。

### 6.5 CLI の OAuth のトークン

- アクセストークン（`oa`、1 時間）とリフレッシュトークン（`or`、30 日、使うたびに入れ替え）。同じリフレッシュトークンの 2 回目の使用を見つけたら、その系列を全て失効する（盗用の検知）。
- 権限はログインした利用者のロールと同じ。`/user/tokens` の一覧に「CLI のログイン」として出し、利用者が失効できる。

## 7. 監査ログ

[ADR-0042](../decisions/0042-api-tokens-roles-and-audit-log.md)。**利用者の監査ログ（`audit_events`）の持ち主はこの領域**で、何を記録するか、形、画面と API、18 か月の保持を決める。改ざんの検知（ハッシュの鎖、WORM の写し、日次の突き合わせ）と長期の保存、基盤の監査（運用者の操作、break-glass、CloudTrail）は [security.md](security.md) の 6 節と [ADR-0048](../decisions/0048-audit-log-integrity-and-data-lifecycle.md) が持つ。

### 7.1 記録するもの

| 分類 | 例（`action`） |
| --- | --- |
| 資源の変更（全ての POST・PUT・PATCH・DELETE） | `script.version.create`、`script.deployment.create`、`script.rollback`、`script.secret.put`、`route.create`、`hostname.delete`、`kv.namespace.delete`、`bucket.update` |
| アクセスの管理 | `member.invite`、`member.role.update`、`token.create`、`token.revoke`、`account.mfa_policy.update` |
| ログイン | `user.login`、`user.login_failed`、`user.mfa.enroll`、`user.stepup` |
| データの閲覧のうち機微なもの | `logs.query`、`tail.start`、`kv.value.read`（管理 API から中身を読んだとき） |
| 請求 | `billing.plan.update`、`billing.spend_cap.update`、`billing.payment_method.update` |
| 基盤の側の操作 | `platform.abuse.suspend`、`platform.abuse.restore`、`platform.support.log_access`、`platform.quota_block`、`system.secret_scanning.revoke` |

- 読み込み（GET）は、上の「機微なもの」を除いて記録しない。
- 本家は、ベータの機能の多くを監査ログに載せない。この基盤は、機能のフラグの裏の機能も載せる（載せないと、利用者がベータを使う判断をしにくい）。

### 7.2 形

```sql
CREATE TABLE audit_events (
  account_id    uuid        NOT NULL,
  id            uuid        NOT NULL,     -- UUIDv7
  occurred_at   timestamptz NOT NULL,
  actor_type    text        NOT NULL,     -- user | user_token | account_token | oauth | platform_support | platform_abuse | system
  actor_id      text        NOT NULL,
  actor_email   text,                     -- snapshot at the time
  auth_method   text,                     -- session | token | oauth
  token_id      uuid,
  mfa_at        timestamptz,              -- last step-up time, if any
  client        text        NOT NULL,     -- dashboard | cli | cli_dev | api | system
  ip            inet,
  user_agent    text,
  action        text        NOT NULL,
  resource_type text,
  resource_id   text,
  resource_name text,
  outcome       text        NOT NULL,     -- success | failure
  status        smallint,
  changes       jsonb,                    -- {field: {from, to}}; secrets and token values never included
  request_id    text        NOT NULL,
  prev_hash     bytea       NOT NULL,     -- per-account hash chain (ADR-0048)
  row_hash      bytea       NOT NULL,     -- SHA-256 over this row and prev_hash
  PRIMARY KEY (account_id, occurred_at, id)
) PARTITION BY RANGE (occurred_at);        -- monthly partitions; drop after 18 months
-- RLS on account_id.
```

- **変更と同じトランザクションで書く。** 変更のハンドラーは、正本の表・`config_outbox`・`audit_events` を 1 つのトランザクションで書く。監査の行のない変更は起きない。
- 失敗した操作（403、検証の失敗）は、アクセスの管理とログインだけ記録する（全ての 400 を記録すると量が増え、役に立たない）。
- `changes` にシークレットの値・トークンの秘密・支払い手段の番号を入れない。シークレットは `{"name": "API_KEY", "value": "[changed]"}` の形。

### 7.3 見る、持ち出す

- `GET /v1/accounts/{a}/audit-events?since=&until=&actor=&action=&resource_id=&cursor=`。ダッシュボードで絞り込み、CSV で落とせる。
- 保持は 18 か月（本家と同じ）。S2 で、利用者のオブジェクトストレージのバケットへの定期の書き出しを足す（長く置きたい利用者のため）。
- 基盤の側の操作（不正な利用での停止、サポートのログの閲覧）も、利用者の監査ログに載せる。ただし、捜査機関の照会の対応で利用者に知らせないよう求められた操作は、法務の判断で載せ方を決める（[abuse-and-trust-safety.md](abuse-and-trust-safety.md) の 10 節）。

## 8. ダッシュボード

### 8.1 作り

| 項目 | 選択 |
| --- | --- |
| 骨格 | React、TanStack Router、TanStack Query（rebuilds の Stripe の題材の dashboard.md の 9.1 節と同じ） |
| API の呼び出し | 同じオリジンの `/api/accounts/{a}/v1/...` にセッションで送り、サーバーが公開の API と同じハンドラーに渡す。公開の API にないもの（ホームの集計、ブートストラップ）は同じ接頭辞のダッシュボード専用のハンドラー（公開の契約にしない） |
| 型 | OpenAPI から生成した `@<brand>/api` |
| 配置 | `dash.<console-domain>`。静的なファイルは CloudFront、API は東京の制御プレーン |
| 言語 | ja・en（FormatJS）。日時の既定は JST |

### 8.2 画面

| 画面 | 中身 |
| --- | --- |
| ホーム | 関数の数、今日の要求・エラーの率、今月の見込みの額、最初のデプロイの案内（CLI の `npm create`） |
| 関数の一覧・詳細 | 概要（URL、いまのデプロイ、要求・エラー・CPU 時間の p50・p99 のグラフ）、版の一覧、デプロイ（2 つの版の割合をつまみで変える。変更の前に差を示す）、ロールバック（シークレットの値も戻る・ストレージは戻らないを示す）、設定（変数・シークレット・バインディング・cron・`limits`・ログの設定）、ログ（リアルタイムの tail と検索） |
| ストレージ | KV の名前空間とキーの閲覧、バケット、Durable Objects の名前空間、キューと滞留 |
| ドメインとルート | ドメインの確認の案内（TXT の値）、ホスト名の状態、ルート |
| 使用量と請求 | 行ごとの使用量と今月の見込み、請求書の一覧と PDF、支払い手段、予算の警告、費用の上限（止まるものを明示） |
| メンバー | 招待、ロール、MFA の状態 |
| API トークン | 作成（権限と資源の選択、秘密の 1 回の表示）、一覧、失効 |
| 監査ログ | 絞り込みと CSV |
| アカウントの設定 | 名前、サブドメインの名前、MFA の方針、削除 |

- ダッシュボードで版の設定（変数、バインディング）を変えると、新しい版（`source = dashboard`）を作ってデプロイする。CLI の設定ファイルとずれることを、画面で示す（[developer-tooling.md](developer-tooling.md) の 4.4 節）。
- ブラウザの中のコードの編集器は S1 で持たない。最初のデプロイは CLI（K4）に案内する。
- メトリクスのグラフの元は、呼び出しの記録の分ごとの集計（標本にしない）。経路は observability の領域で決める。

### 8.3 セキュリティ、アクセシビリティ、性能

- CSP：`default-src 'self'`、インラインのスクリプトなし、`connect-src 'self'` と tail の `wss://tail.<console-domain>`、`frame-ancestors 'none'`、`require-trusted-types-for 'script'`。
- 利用者が入力した文字列（関数の名前、ログの本文、KV の値）は、テキストとして描く。`dangerouslySetInnerHTML` を lint で禁止する。ログの本文には攻撃者の文字列が入りうる（関数の利用者が送った URL など）。
- 第三者の計測・エラー収集のスクリプトは読み込まない。
- WCAG 2.2 AA。`@axe-core/playwright` で違反 0 件を PR の条件にする。
- 性能の予算：初回の JS 250KB 以内（gzip）、LCP p75 2.5 秒以内、関数の一覧 p75 1 秒以内。

## 9. 障害の型

| 障害 | 検知 | 振る舞い |
| --- | --- | --- |
| 制御プレーンの API の停止 | 合成監視 | 管理の操作が止まる。デプロイ済みの関数は動く（ADR-0004）。状態の頁に出す |
| Aurora の停止・DR の切り替え | Aurora の指標 | 書き込みの操作が止まる。切り替えの後の変更のログの扱いは [deployment-and-config-distribution.md](deployment-and-config-distribution.md) の 5.3 節 |
| レート制限の Valkey の停止 | 接続の失敗 | 制限をかけずに通し、警報を出す |
| シークレットスキャンの受け口の停止 | 受け口の 5xx | GitHub の再送に任せる（再送の方式は未検証）。回復後、SQS の未処理を流す |
| 失効の印が届かない（Valkey の停止） | 印の読み込みの失敗 | 30 秒のメモリの持ちの後は DB を直接引く（失効が 30 秒遅れうる） |
| ログインの基盤の停止 | 合成監視 | ダッシュボードに入れない。既存のセッションと API トークンは動く |
| 監査ログの書き込みの失敗 | トランザクションの失敗 | 変更も失敗する（監査の行のない変更を作らない） |

## 10. セキュリティ

| 脅威 | 対策 |
| --- | --- |
| トークンの漏れ | 接頭辞とチェックサムでシークレットスキャンに載せ、自動で失効。有効期限、送り元の IP、資源の範囲で被害を絞る |
| トークンの総当たり | 238 ビットの乱数。チェックサムの誤りは DB を引かない。401 の多い送り元を 5 分止める |
| 他のアカウントの資源への到達（IDOR） | 全ての表に RLS。ハンドラーはトランザクションの初めに `set_config('app.account_id', …)` を置く。他のアカウントの資源は 404 |
| 権限の昇格（ロールの付け替え、トークンの作成） | 作る人の権限を超える権限を付けられない。ステップアップの MFA。監査ログ |
| CSRF | Cookie は SameSite=Lax。状態を変える要求は `X-Requested-With` と Origin の検査 |
| ダッシュボードの XSS（ログ・KV の値からの注入） | テキストとして描く、CSP、Trusted Types |
| メンバーを外した後の残る権限 | 利用者のトークンの権限をいまのロールとの積で決める。セッションは外した時点で消す |
| 基盤の運用者の立ち入り | 利用者のデータの閲覧は期限付き・2 人の承認・利用者の監査ログに載せる（[developer-tooling.md](developer-tooling.md) の 8.4 節）。運用者の本番の権限の全体は security の領域 |

- 認証・権限・トークン・監査ログの変更は `security:sensitive` にする（[AGENTS.md](../../AGENTS.md)）。

## 11. テスト

| 種類 | 対象 | 確かめること |
| --- | --- | --- |
| 性質ベース | 権限 | 任意のロール・トークンの権限・資源の範囲・要求の組で、許可の判定が「権限の積」の定義と同じ。他のアカウントの資源は常に 404 |
| 性質ベース | トークンの形 | 任意の生成したトークンが正規表現に合い、チェックサムが合う。1 文字変えるとチェックサムが合わない（CRC32 の 1 文字の誤りの検出） |
| 表駆動 | 5.3 節の表 | 全てのロール × 全ての権限 × 代表の API |
| 表駆動 | 冪等 | 同じキー同じ本文、同じキー違う本文、処理中、保存しない状態コード |
| 表駆動 | カーソル | 条件を変えた再利用、期限切れ、他のアカウントのカーソル |
| 結合 | シークレットスキャン | 正しい署名・誤った署名、有効・失効済み・存在しないトークン、1 回に 1,000 件の知らせ。失効が 2 秒以内に効く |
| 結合 | 監査ログ | 全ての変更の API が監査の行を作る（OpenAPI の全ての POST・PUT・PATCH・DELETE を列挙して確かめる）。監査の書き込みを失敗させると変更も失敗する |
| 結合 | レート制限 | 1,200 件目まで通り、1,201 件目が 429 と `Retry-After` |
| E2E（Playwright） | ダッシュボード | 権限のないロールでボタンが出ず、API も 403。トークンの秘密が 1 回だけ出る。ロールバックの確認の表示 |
| 契約 | OpenAPI | 生成したクライアントと実装の応答の形が合う |

テスト名には要件 ID（開発リポジトリの `REQ-API-*`・`PROP-API-*`）を含める。

## 12. この領域の ADR

| ADR | 決定 |
| --- | --- |
| [0041](../decisions/0041-management-api-shape.md) | `/v1` のパスの版で足す変更だけ。POST の冪等キー（24 時間）、不透明なカーソル、`If-Match`、RFC 9457 のエラー、トークン・アカウントごとの滑る窓のレート制限。ダッシュボードと CLI は同じハンドラーを使う |
| [0042](../decisions/0042-api-tokens-roles-and-audit-log.md) | API トークンは `<brand>_<kind>_` ＋40 文字＋CRC32 の 6 文字。SHA-256 で持ち、シークレットスキャンで自動で失効する。効く権限はトークン・資源・いまのロールの積。ロールは 5 つの固定。監査ログは変更と同じトランザクションで書き、18 か月持つ |

## 13. Story の候補

| Epic | Story の候補 |
| --- | --- |
| E1 | 管理 API の骨格（Hono、Zod、OpenAPI、RLS の文脈、エラーの形、冪等の表） |
| E1 | アカウント・メンバー・招待・ロールの表と API |
| E1 | ログイン（Better Auth、メールの OTP、GitHub、Google、パスキー）とステップアップの MFA |
| E1 | API トークン（形、作成、検証、失効の印、スコープ、IP の絞り込み） |
| E1 | 監査ログの表と、変更のハンドラーの共通の書き込み |
| E1 | `<brand>` の接頭辞の衝突の確認と、GitHub のシークレットスキャンの登録、受け口 |
| E1 | レート制限（Valkey、滑る窓、ヘッダー） |
| E6 | CLI の OAuth（PKCE、デバイス、`oa`・`or` のトークン、系列の失効）（developer-tooling と合わせて） |
| E6 | ダッシュボードの骨格（ルーター、生成したクライアント、i18n、a11y の検査、CSP） |
| E6 | 関数の画面（概要、版、段階的なデプロイ、ロールバック、設定、ログ） |
| E6 | ストレージ・ドメイン・メンバー・トークン・監査ログの画面 |
| E11 | 使用量と請求の画面（limits-and-billing と合わせて） |
| E12 | 基盤の側の操作（停止、サポートの閲覧）を利用者の監査ログに載せる（abuse-and-trust-safety と合わせて） |
| E12 | 監査ログの CSV の書き出し、18 か月の区画の削除 |

## 14. 未解決の問い

- 利用者が作るロールを S1 で持つか。
- `viewer` にログを見せないことで、運用の体制（ログを見るだけの人）が困らないか。
- アカウントのトークンの有効期限を必須にするか。
- 監査ログの改ざんの検知（ハッシュの鎖、WORM の写し）をどこまで持つか（security の領域）。
- 捜査機関の照会の対応の操作を、利用者の監査ログにどう載せるか（L4）。
- 利用者の監査ログの書き出し（バケットへ）を S1 で持つか。
- GitHub 以外のシークレットスキャン（GitLab など）への登録。

### 決定

2026-09-27 の既定案。

- 利用者が作るロールは S2。S1 はトークンのスコープで細かく絞る。
- ログだけを見るロールの要望が出たら、S2 の利用者が作るロールで応える。S1 は `developer` を使ってもらう。
- 有効期限は任意。90 日使わないトークンの知らせで補う。
- 改ざんの検知は security の領域に預ける。この領域は、変更と同じトランザクションで書くことと、RLS での分離を約束する。
- 照会の対応の操作の載せ方は、法務の判断に従う（L4）。既定は載せる。
- バケットへの書き出しは S2。
- GitHub のパートナープログラムを先にし、他は利用者の要望を見て S2 で決める。

## 15. quality.md・runbooks・data-model に載せるもの

**quality.md**

- リスク：他のアカウントの資源への到達。権限の性質ベーステスト、RLS の CI の検査（全てのテナントの表に RLS があること）。
- リスク：トークンの漏れ。シークレットスキャンの結合テストと、失効までの時間（受け口の受信から 2 秒以内）の SLI。
- リスク：監査の漏れ。OpenAPI の全ての変更の API に監査の行があることの CI の検査。
- 本番での検証：管理 API の可用性（NFR-004 の 99.9%）と p99 の遅延、シークレットスキャンの受け口の成功率。

**runbooks**

- `leaked-token`：シークレットスキャンの知らせ、または利用者からの漏れの申し出。失効の確認、使われた記録（`last_used_ip`、監査ログ）の確認、利用者への連絡。
- `secret-scanning-endpoint-down`：受け口の停止と、未処理の知らせの流し直し。
- `rate-limit-store-down`：Valkey の停止での制限なしの運転と回復。
- `account-takeover-suspected`：ログインの異常（知らない国・端末）の申し出。セッションの全消去、トークンの失効、MFA の再登録。
- `audit-export-request`：利用者からの 18 か月を超える監査ログの依頼の断り方と、CSV の案内。
- SLI の追加の依頼（Ops へ）：管理 API の可用性と遅延（資源ごと）、429 の率、シークレットスキャンの失効までの時間、ログインの成功率。

**data-model**

| テーブル・保存 | 主な列 | 備考 |
| --- | --- | --- |
| `accounts`（制御プレーン） | `id`、`name`、`subdomain`、`plan`、`status`（`active`・`suspended`・`deletion_scheduled`）、`mfa_required`、`created_at`、`created_by` | RLS |
| `users`（制御プレーン） | `id`、`email`、`display_name`、`locale`、`mfa_enrolled_at`、`created_at` | テナントの表ではない（本人だけ） |
| `account_members`（制御プレーン） | `account_id`、`user_id`、`role`、`invited_by`、`joined_at` | RLS |
| `invitations`（制御プレーン） | `account_id`、`id`、`email`、`role`、`token_sha256`、`expires_at`、`accepted_at` | RLS |
| `api_tokens`（制御プレーン） | 6.3 節 | RLS（アカウントのトークン）、本人だけ（利用者のトークン） |
| `oauth_refresh_families`（制御プレーン） | `id`、`user_id`、`current_token_id`、`revoked_at` | 系列の失効 |
| `idempotency_keys`（制御プレーン） | `account_id`、`key`、`request_hash`、`status`、`response_status`、`response_body`、`created_at` | RLS。24 時間で消す |
| `audit_events`（制御プレーン） | 7.2 節 | RLS。月の区画、18 か月 |
| `secret_scanning_reports`（制御プレーン） | `id`、`received_at`、`token_hash`、`type`、`url`、`source`、`label`、`token_id` | テナントの表ではない。監査ログに写す |
| レート制限（Valkey） | `rl:{token_or_user}:{bucket}`、`rl:acct:{account_id}:{bucket}` | 1 分の桶 × 5 |
| 失効の印（Valkey） | `revoked:{token_id}` | 有効期限まで |

# Management API and Rate Limiting: Auth0

Management API の形（リソース、ページング、エラー、版）、認可（スコープ）、レート制限（認証の経路と管理の経路の両方）の設計。決定は [ADR-0033](../decisions/0033-management-api-shape.md)（API の形）、[ADR-0034](../decisions/0034-management-api-authorization.md)（認可）、[ADR-0035](../decisions/0035-rate-limiting.md)（レート制限）にある。

レート制限の仕組み（層、Valkey の GCRA、障害時の振る舞い）は、Slack の [rate-limiting.md](../../../slack/docs/architecture/rate-limiting.md) と Stripe の [rate-limiting.md](../../../stripe/docs/architecture/rate-limiting.md) を引き継ぐ。単位と値を本家 Auth0 に寄せる。各領域の文書にある上限は、この文書の枠組みに従い、数値は 6 節を正とする。

本家の振る舞いは、2026-09-27 に auth0.com/docs と、Management API の OpenAPI（[management-api-oas.json](https://auth0.com/docs/oas/management/v2/management-api-oas.json)）で確かめた。

## 1. 目的と範囲

| 範囲に含む | 範囲に含まない（担当の領域） |
| --- | --- |
| Management API のリソース、URL、ページング、エラー、版、相関 ID | 各リソースの中身（アプリは [tenants-and-applications.md](tenants-and-applications.md)、ユーザーは [users-and-profiles.md](users-and-profiles.md)、ログは [logs-and-streams.md](logs-and-streams.md)） |
| Management API のトークン（M2M とダッシュボード）とスコープ | ダッシュボードのログイン（[dashboard.md](dashboard.md)） |
| 認証の経路・管理の経路のレート制限、429 の応答、見出し | ブルートフォースの防御・不審な IP の抑制の判定（attack-protection の領域）。この文書はその数え方の基盤だけを持つ |
| テナントごとの上書き | WAF の IP の制限の値（infrastructure の領域の 4.3 節） |

## 2. 本家の仕組み（確かめたこと）

| 項目 | 本家 | 出典 |
| --- | --- | --- |
| 場所と認証 | `https://<tenant>/api/v2/`。M2M のアクセストークン（JWT）の `scope` で操作を許す。足りなければ 403 | [Management API](https://auth0.com/docs/api/management/v2) |
| トークンの有効期間 | 既定 86,400 秒。発行したら失効できない | [Management API Access Tokens](https://auth0.com/docs/secure/tokens/access-tokens/management-api-access-tokens) |
| 本文 | `application/json`、最大 1 MB | Management API |
| 相関 ID | `X-Correlation-ID`（64 文字まで）を書き込みの要求で受け、ログの `references.correlation_id` に残す | 同上 |
| オフセットのページング | `page`（0 始まり）、`per_page`。`include_totals` で総数を含む形にする。取り出せるのは約 1,000 件まで | 同上、[Retrieve Logs](https://auth0.com/docs/deploy-monitor/logs/retrieve-log-events-using-mgmt-api) |
| チェックポイントのページング | `from`（前の応答の `next`、不透明）と `take`。前へだけ進む。`next` は 24 時間有効。ログでは件数の上限がなく、`from` と `take` 以外の引数を無視する。ログは生成の時刻ではなく `log_id` の順 | 同上 |
| 1 ページの上限 | 概要の頁は「公開クラウドは最大 50」、OpenAPI とログの頁は「最大 100」。**本家の資料の間で食い違う** | 同上 |
| 検索 | ログ・ユーザーは Lucene の部分集合（`q`） | [Log Search Query Syntax](https://auth0.com/docs/deploy-monitor/logs/log-search-query-syntax) |
| レート制限の方式 | トークンバケット（バケットの大きさ ＝ バースト、補充の速さ ＝ 持続の速さ）。単位は API とエンドポイント、テナントの種類（本番・本番以外）、場合により IP・ユーザー | [Rate Limit Policy](https://auth0.com/docs/troubleshoot/customer-support/operational-policies/rate-limit-policy) |
| 見出し | `x-ratelimit-limit`、`x-ratelimit-remaining`、`x-ratelimit-reset`（UNIX 秒）。超えると 429。テナントのログに `api_limit` が出る | [Rate Limit Use Cases](https://auth0.com/docs/troubleshoot/customer-support/operational-policies/rate-limit-policy/rate-limit-use-cases) |
| 認証 API（Enterprise） | テナント：本番 1 秒 100（バーストも 100）、本番以外も 1 秒 100。userinfo はユーザーごとにバースト 10・1 分 5。パスワードの変更は IP × メールでバースト 10・1 分 1。デバイスコードは IP ごとに 1 秒 5 | [Enterprise](https://auth0.com/docs/troubleshoot/customer-support/operational-policies/rate-limit-policy/rate-limit-configurations/enterprise-public) |
| Management API（Enterprise） | テナント：本番 バースト 50・1 秒 16、本番以外 バースト 10・1 秒 2 | 同上 |
| Management API（Essentials・Professional） | ユーザーの読み取り バースト 40・1 分 500、書き込み バースト 20・1 分 200、ログの読み取り バースト 10・1 分 100、アプリの読み取り バースト 5・1 分 100、署名鍵の書き込み 1 日 5 | [Essentials and Professional](https://auth0.com/docs/troubleshoot/customer-support/operational-policies/rate-limit-policy/rate-limit-configurations/essentials-professional-b2b) |
| 無料 | 認証 API：1 分 300、`/oauth/token` 1 秒 30。Management API 1 秒 2 | [Free](https://auth0.com/docs/troubleshoot/customer-support/operational-policies/rate-limit-policy/rate-limit-configurations/free-public) |
| Universal Login の画面 | IP ごとに 1 分 500（全体）、画面ごと・IP × `state` で GET 1 分 10 | Enterprise の頁 |
| プラン | プランで値が変わる | 上の各頁 |
| エラーの本文 | 公開の資料で形を確かめられなかった。`{statusCode, error, message, errorCode}` の形が広く観察されている（**未検証**） | — |

## 3. Management API の形

### 3.1 リソースと URL

- `https://<tenant host>/api/v2/<resource>`。カスタムドメインでも受ける。CloudFront のビヘイビアで管理の経路の ALB に送る（[ADR-0057](../decisions/0057-accounts-network-and-path-separation.md)）。
- リソースの名前と形は本家に寄せる（振る舞いを寄せ、名前の `<Brand>` の部分だけ変える。リポジトリ共通の ADR-0006）。本家の SDK との完全な互換は目標にしない（intent の Non-goals）。

MVP のリソース：

| リソース | 操作 | 担当の領域 |
| --- | --- | --- |
| `/clients`、`/clients/{id}/credentials` | CRUD、秘密のローテーション | tenants-and-applications |
| `/resource-servers` | CRUD | tenants-and-applications |
| `/client-grants` | CRUD | tenants-and-applications |
| `/connections` | CRUD、アプリへの有効化 | connections |
| `/users`、`/users/{id}/identities`、`/users-by-email` | CRUD、検索、ブロック、MFA のリセット | users-and-profiles |
| `/logs`、`/logs/{id}`、`/users/{id}/logs` | 読み取り、検索 | logs-and-streams |
| `/log-streams` | CRUD、再開 | logs-and-streams |
| `/keys/signing` | 一覧、ローテーション、失効 | keys-and-secrets |
| `/custom-domains` | CRUD、検証 | custom-domains |
| `/branding`、`/prompts` | 読み取り、更新 | universal-login |
| `/attack-protection/*` | 読み取り、更新 | attack-protection |
| `/tenants/settings` | 読み取り、更新 | tenants-and-applications |
| `/members`、`/members/invitations`（本システム独自） | テナントのメンバー | tenants-and-applications、dashboard |
| `/audit-events`（本システム独自） | 読み取り | security（[ADR-0054](../decisions/0054-audit-log.md)） |
| `/jobs`（MVP の後） | ユーザーのインポート・エクスポート | users-and-profiles |

### 3.2 要求と応答

- 本文は JSON だけ、最大 1 MiB（本家と同じ）。未知のフィールドは 400（Zod の `strict`）。本家の SDK の余分なフィールドを黙って捨てない。
- 部分の更新は `PATCH`（JSON Merge Patch の意味。配列は置き換え）。
- 作成は 201 と作成したオブジェクト。名前の重複は 409。
- `fields` と `include_fields` で返すフィールドを絞る（本家と同じ）。
- すべての応答に `<Brand>-Request-Id`。書き込みの要求は `X-Correlation-ID`（64 文字まで）を受け、監査とログに残す。本家の見出しの名前は本家の名前を含まないので、そのまま使う。
- 冪等キーは MVP で持たない（本家も持たない）。重複の作成は名前の一意の制約で 409 になる。Terraform などの再試行は、409 を「既にある」と扱う。

### 3.3 ページング

| 方式 | 引数 | 上限 | 対象 |
| --- | --- | --- | --- |
| オフセット | `page`（0 始まり）、`per_page`、`include_totals` | `per_page` 最大 100、既定 50。`page × per_page + per_page` が 1,000 を超えると 400 | 全一覧 |
| チェックポイント | `from`、`take` | `take` 最大 100、既定 50 | ログ、ユーザー、アプリ、接続、client grant、メンバー |

- **1 ページの最大は 100 にする。** 本家の資料の食い違い（2 節）は、OpenAPI とログの頁の値に合わせる。
- `include_totals=true` の応答は `{ "<resource>": [...], "start", "limit", "total" }`。総数は 1,000 で打ち切り、`total_capped: true` を付ける（本家の総数の上限の扱いは未検証）。
- **チェックポイント**：
  - `next` は不透明な文字列。中身は `{v:1, tenant_id, resource, sort_key, filter_hash, issued_at}` を、Management API の専用の鍵（KMS のデータキー）で AES-256-GCM で暗号化したもの。改ざん・他テナントへの流用・別のフィルターでの流用を拒否する（400 `invalid_checkpoint`）。
  - 並びは各リソースの単調な鍵（ログは `log_id`、他は `id` の UUIDv7）。削除・追加があっても、同じ項目を 2 回返さず、既に過ぎた位置に後から入った項目は返さない（前へだけ進む）。
  - 有効 24 時間（本家と同じ）。過ぎたら 400 `checkpoint_expired`。
  - 次がないときは `next` を返さない。
  - ログのチェックポイントは件数の上限がない（本家と同じ）。ログの `from` には `log_id` そのものも受ける（本家と同じ。[logs-and-streams.md](logs-and-streams.md) の 5 節）。
- 応答に `Link: <...>; rel="next"` を付ける（本家のログの取り出しと同じ）。

### 3.4 エラー

```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": "Payload validation error: 'Invalid URL' on property callbacks[0].",
  "errorCode": "invalid_body",
  "request_id": "..."
}
```

| 状態 | `errorCode` の例 | 使う場面 |
| --- | --- | --- |
| 400 | `invalid_body`、`invalid_query_string`、`invalid_checkpoint`、`checkpoint_expired`、`page_limit_exceeded` | 検証の失敗 |
| 401 | `invalid_token` | 署名・`exp`・`aud`・`iss` の不一致 |
| 403 | `insufficient_scope`、`grant_revoked`、`tenant_suspended` | 権限なし |
| 404 | `inexistent_<resource>` | 対象がない。他テナントの ID も 404（存在を漏らさない） |
| 409 | `already_exists`、`last_admin`、`conflict` | 一意の制約、状態の衝突 |
| 413 | `payload_too_large` | 1 MiB 超 |
| 429 | `too_many_requests` | 6 節 |
| 503 | `temporarily_unavailable` | DB の切り替え中など。`Retry-After` を付ける |

- 形は本家で広く観察される形（2 節、未検証）に寄せる。`request_id` は本システムで足す。
- `message` に、秘密・トークン・パスワード・内部のスタックを入れない（[ADR-0061](../decisions/0061-secret-free-telemetry.md)）。

### 3.5 版

- 版は URL の `/api/v2` だけにする。本家も同じ（版 2.0）。日付の版（Stripe の ADR-0007）は持たない。
- v2 の中では、足す変更（新しいリソース、任意のフィールド、新しい `errorCode`、列挙の値の追加）だけをする。利用者は未知のフィールドと列挙の値を無視するよう、文書に書く。
- 壊す変更は、次の版（`/api/v3`）で行う。v2 は、v3 の公開から最低 12 か月保つ。
- 廃止の予定の機能を呼ぶと、1 時間に 1 回（アプリ × エンドポイントごと）、テナントのログに `depnote` を出す（本家と同じ仕組み。[Migrate to Paginated Queries](https://auth0.com/docs/troubleshoot/product-lifecycle/past-migrations/migrate-to-paginated-queries)）。応答に `Deprecation`・`Sunset` の見出し（RFC 9745、RFC 8594）を付ける。
- OpenAPI 3.1 を `@hono/zod-openapi` で出し（architecture README の 4 節）、公開する。CI で、前の版の OpenAPI と比べて壊す変更がないことを検査する（oasdiff などで。選定は delivery の領域）。

## 4. 認可

### 4.1 トークンの出どころ

Management API は、2 種類のトークンを受ける（[ADR-0034](../decisions/0034-management-api-authorization.md)）。

| 出どころ | `iss` | `aud` | 主体 | 使う場面 |
| --- | --- | --- | --- | --- |
| テナント自身の M2M | そのテナントの `issuer` | `https://<tenant host>/api/v2/` | `sub` ＝ `<client_id>@clients` | テナントのバックエンド、CLI、Terraform |
| 管理用のテナント | 管理用のテナントの `issuer` | `https://manage.<brand>.<domain>/api/` | `sub` ＝ メンバーの ID。対象のテナントは要求のパス（`/api/tenants/{tenant}/v2/*`） | ダッシュボード（[dashboard.md](dashboard.md) の 3 節） |
| 非常用のトークン | 本システムの非常用の発行者 | 同上 | 運用者。対象のテナントと操作を限る | break-glass（[ADR-0037](../decisions/0037-break-glass-and-admin-roles.md)） |

- 署名の検証は、テナント自身のトークンはテナントの JWKS（メモリー）、管理用のテナントのトークンはその JWKS、非常用のトークンは KMS の公開鍵で行う。`alg` は鍵に結び付けた値だけを受ける。
- テナント自身のトークンは、要求のホスト名のテナントの `issuer` と一致しなければ 401。他のテナントのトークンで呼べない。
- **許可の今の状態を確かめる。** M2M のトークンは、要求ごとに `client_grants` に `(client_id, audience)` の許可が今もあり、要求の操作のスコープが今の許可に含まれることを確かめる（DB を読む。管理の経路なので ADR-0005 の縮退の対象外）。許可を消したり狭めたりすると、発行済みのトークンでも次の要求から 403 `grant_revoked` になる。本家は発行済みのトークンを失効できない（2 節）。本システムは管理の経路でだけ、これを補う。
- ダッシュボードのトークンは、要求ごとに `tenant_members` のロールを読み、ロールから得たスコープで判定する（トークンにテナントごとの権限を入れない）。

### 4.2 スコープ

- 形は本家と同じ `<action>:<resource>`（`read:users`、`create:clients`、`update:client_keys` など）。
- 秘密に触れる操作は、別のスコープにする：`read:client_keys`（秘密の最終の使用の時刻など。秘密そのものは返さない）、`create:client_credentials`、`update:signing_keys`、`read:logs_users`（ユーザーの個人データを含むログ）。
- Management API を呼べる client grant の作成・変更（`create:client_grants` で `audience` が Management API のもの）は、`admin` のロールだけに許す。M2M のトークンで、自分より広い Management API の許可を作れない（作成しようとする許可のスコープは、呼び出し元のトークンのスコープの部分集合でなければならない）。権限の昇格を防ぐため。
- スコープとエンドポイントの対応は、OpenAPI の `security` に書き、ルーターがそこから判定する。対応のないエンドポイントは起動時に失敗させる（既定で拒否）。

## 5. レート制限の層

| 層 | 場所 | 単位 | 目的 |
| --- | --- | --- | --- |
| L1 エッジ | AWS WAF | IP | 洪水・総当たりの粗い遮断（infrastructure の領域） |
| L2 認証のエンドポイント | Auth | IP、ユーザー、IP × メール、`state` | userinfo、パスワードの変更、デバイスコード、画面の送信など |
| L3 認証のテナント | Auth | テナント | 認証 API の全体 |
| L4 攻撃の防御の数 | Auth | IP × ユーザー、IP | ブルートフォース・不審な IP（判定は attack-protection の領域。数えるのはこの基盤） |
| L5 管理のテナント | Management API | テナント | Management API の全体 |
| L6 管理のエンドポイント | Management API | テナント × 操作 | ユーザー・ログ・アプリの一覧など |
| L7 同時実行 | Management API | テナント × 操作 | 検索、ログの検索、ジョブ |
| L8 非同期 | Worker | テナント、送信先 | ログストリーム、メール、Back-Channel Logout（各領域） |

- 判定は、テナントの解決とトークンの検証の直後に、L2 → L3（認証）または L5 → L6 → L7（管理）の順で行い、最初に超えたものを返す。
- L3 は ADR-0005 の過負荷の優先の順（トークンの更新と JWKS ＞ ログイン ＞ サインアップ ＞ 管理）と別に働く。L3 はテナントの公平さのため、優先の順は全体の過負荷のため。JWKS と discovery はエッジから配るので L3 に数えない。

## 6. 上限の一覧（S1）

数値は初期値で、負荷試験（E12）と運用で見直す。本家の Enterprise の公開値を初期値にする。

### 6.1 プランで変えず、環境で変える

- **値はテナントの環境で変える（本番・本番以外）。プランでは変えない。** 本家はプランで変える（2 節）。本システムは、Slack（ADR-0033）・Stripe（ADR-0009）と同じく、緩和をテナントごとの上書き（7 節）だけで行う。プランの設計（まだない）で変えるなら、新しい ADR で扱う。
- 本番以外の値は、本家の Enterprise の本番以外に寄せつつ、開発のテナントでの負荷試験を想定しない（本家と同じく、自分の側で模擬するよう文書で案内する）。

### 6.2 認証の経路（L2・L3）

| 対象 | 単位 | 本番 | 本番以外 | 本家（Enterprise） |
| --- | --- | --- | --- | --- |
| 認証 API の全体 | テナント | 1 秒 100、バースト 100 | 1 秒 25、バースト 50 | 本番・本番以外とも 1 秒 100 |
| `/oauth/token`（`client_credentials`） | テナント | 全体の枠に数える | 同左 | — |
| `/userinfo` | ユーザー | バースト 10、1 分 5 | 同左 | 同じ |
| パスワードの変更・再設定の要求 | IP × メール | バースト 10、1 分 1 | 同左 | 同じ |
| デバイスコードの発行 | IP | 1 秒 5 | 同左 | 同じ |
| デバイスコードのポーリング | デバイスコード | RFC 8628 の `interval`（5 秒）より速いと `slow_down` | 同左 | — |
| Universal Login の画面の全体 | IP | 1 分 500 | 同左 | 同じ |
| Universal Login の画面ごと（GET） | IP × `state` | バースト 20、1 分 10 | 同左 | 同じ |
| Universal Login の画面ごと（POST） | IP | バースト 10、1 分 5 | 同左 | 同じ |
| ログインの失敗 | IP × ユーザー | attack-protection の領域（本家は 1 分 20 の後 1 分 10） | 同左 | [Rate Limit Policy](https://auth0.com/docs/troubleshoot/customer-support/operational-policies/rate-limit-policy) |

- **1 秒 100 は、S1 の規模の見積もり（本番 3,000 テナントで、ピーク 1 秒 3,000 件）に対して、1 つのテナントがピークの 3% を使える量である。** 大きな M2M の利用者と大規模な B2C のテナントは、7 節の上書きで事前に上げる。
- 本家の Enterprise の本番以外は本番と同じ 1 秒 100 だが、本システムは本番以外を 1 秒 25 にする。本番以外のテナントは SLO の対象外で、共有の資源を負荷試験で占有させないため。
- リフレッシュトークンの交換も L3 に数える。上書きのないテナントで、リフレッシュが 429 になりうる。ADR-0005 は更新を最優先にしているので、L3 を超えたときも **`grant_type=refresh_token` だけは、全体の枠の 120% まで通す**（本システムの決定。ログインを断っても、既にログインしている利用者のセッションは切らない）。

### 6.3 管理の経路（L5〜L7）

| 対象 | 単位 | 本番 | 本番以外 | 本家 |
| --- | --- | --- | --- | --- |
| Management API の全体 | テナント | バースト 50、1 秒 16 | バースト 10、1 秒 2 | Enterprise と同じ |
| ユーザーの読み取り（一覧・検索・取得） | テナント | バースト 40、1 分 500 | バースト 10、1 分 100 | Essentials・Professional と同じ（Enterprise の値は未検証） |
| ユーザーの書き込み | テナント | バースト 20、1 分 200 | バースト 10、1 分 60 | 同上 |
| ログの読み取り | テナント | バースト 10、1 分 100 | バースト 5、1 分 30 | 同上 |
| アプリの読み取り | テナント | バースト 5、1 分 100 | 同左 | 同上 |
| 署名鍵のローテーション | テナント | 1 日 5 | 1 日 5 | 同じ |
| カスタムドメインの検証 | テナント | 1 分 5 | 同左 | 同じ |
| 同時実行：ユーザーの検索、ログの検索 | テナント | 同時に 5 | 同時に 2 | 本家は非公開。本システムの決定 |
| 同時実行：一覧のチェックポイントの読み出し | テナント | 同時に 10 | 同時に 3 | 同上 |

- 1 秒 16 は、1 つの本番のテナントの Management API の呼び出しとして十分と見込む（ダッシュボードの操作は 1 画面で数回）。ダッシュボードの呼び出しも同じ枠に数える（本家の振る舞いは未検証）。ダッシュボードが使えなくならないよう、ダッシュボードの呼び出しには、全体の枠の外に 1 秒 5 の小さな予約の枠を別に置く（本システムの決定）。

## 7. 計数と応答

### 7.1 GCRA

- **GCRA を Valkey の Lua スクリプトで実行する**（Slack・Stripe と同じ）。本家のトークンバケット（バケット＝バースト、補充＝持続の速さ）と同じ振る舞いを、1 つの対象につきキー 1 つ（`TAT`）で表す。
- キーは `rl:{t:<tenant_id>}:<limit>:<subject>`。`{t:<tenant_id>}` をハッシュタグにし、S2 の Valkey のクラスタでテナントの計数を同じシャードに置く。テナントに属さない制限（IP だけ）は `rl:{ip:<hash>}:...`。IP とメールアドレスはキーに平文で入れず、日ごとに替える鍵の HMAC にする（Valkey の中に個人データを持たないため）。
- 同時実行（L7）は、ソート済み集合に処理中の要求を期限付き（30 秒。管理の経路の要求のタイムアウトと同じ）で入れて数える。

### 7.2 応答

| 経路 | 超えたとき |
| --- | --- |
| Management API | 429、`errorCode: too_many_requests`。見出し `X-RateLimit-Limit`・`X-RateLimit-Remaining`・`X-RateLimit-Reset`（UNIX 秒）と `Retry-After`（秒） |
| `/oauth/token`、`/oauth/device/code`、`/oauth/revoke` | 429、`{"error": "too_many_requests", "error_description": "..."}`（本家と同じ形。本家の形の確認は未検証）。同じ見出し |
| `/userinfo` | 429、`WWW-Authenticate` は付けない。同じ見出し |
| Universal Login の画面 | 429 の画面（HTML）。やり直しまでの時間を示す。見出しは付ける |
| `/authorize` | 429 の画面。`redirect_uri` へエラーを返さない（未検証の要求を戻さない） |

- 見出しの名前は本家と同じ（本家の名前を含まない一般の名前なので、そのまま使う）。**全応答に付ける**（本家と同じ。Slack で付けた IETF の `RateLimit` の見出しは付けない）。値は、最初に判定した層（テナントの全体）の値を出す。
- 429 のたびに、テナントのログに `api_limit` を出す。ただし、テナント × 制限の名前ごとに 1 分 1 件に間引く（ログの洪水を避ける）。枠の 80% を 5 分続けて超えたら `api_limit_warning` を出す（本家にもある種類。[Rate Limit Use Cases](https://auth0.com/docs/troubleshoot/customer-support/operational-policies/rate-limit-policy/rate-limit-use-cases)）。

### 7.3 Valkey が使えないとき

ADR-0005 の縮退の表のとおり、全部を通す（fail-open）にはしない。

| 対象 | 振る舞い |
| --- | --- |
| L3・L5・L6（テナントの枠） | 各タスクの中で、上限をタスク数で割った近似の制限を続ける。**認証の経路を、Valkey の障害で止めない** |
| L2・L4（ユーザー・IP・メールごとの制限、攻撃の防御の数） | タスクの中の近似で続ける。ログインの失敗の数は Aurora の失敗の回数（attack-protection の領域）を正とし、Valkey は速い判定の写しにする |
| L7（同時実行） | タスクの中の数で近似する（上限をタスク数で割る） |

`ratelimit_backend_errors_total` を数え、アラートを出す。

## 8. 上書きと運用

- `rate_limit_overrides`（`tenant_id`、制限の名前、バースト、速さ、理由、期限、承認者）。Ops が変える。変更はプラットフォームの監査に残す（ADR-0054）。コードに特定のテナントを書かない。
- テナントからの申請はダッシュボードかサポートで受ける。全体を 2 倍以上にする緩和は、容量（capacity の領域）を確かめてから承認する。本家の「Performance Burst」（1 か月に 48 時間だけ 2〜4 倍）に相当するものは、期限つきの上書きで表す。
- 障害時には、特定のテナントの上限を一時的に下げられる（runbook の `rate-limit-override`）。
- 合成監視のテナントも上限の対象から外さない。

## 9. 障害のとき

| 事象 | 振る舞い |
| --- | --- |
| Valkey の障害 | 7.3 節 |
| Aurora の writer の切り替え | Management API の書き込みは 503 と `Retry-After`。読み取りは reader で続く |
| Aurora の reader の遅延 | 書いた直後の読み取りで古い値が見えうる。作成・更新の応答は writer の値を返す。一覧の遅れは文書に書く |
| 管理の経路の過負荷 | 認証の経路に及ばない（別のサービスと接続プール。ADR-0005、ADR-0057）。L5〜L7 で断る |
| チェックポイントの鍵（KMS のデータキー）が読めない | 起動時に復号してメモリーに持つ。KMS の障害中も動く。新しいタスクはチェックポイントの一覧を 503 にする |

## 10. セキュリティ

- 他のテナントの ID を指定しても 404（存在を漏らさない）。RLS の上に、ルーターでの `tenant_id` の一致の確認を重ねる（ADR-0002）。
- 許可の今の状態の確認（4.1 節）で、M2M のトークンの漏えいのとき、許可の削除ですぐ止められる。
- M2M のトークンで、自分より広い Management API の許可を作れない（4.2 節）。
- チェックポイントは暗号化し、テナント・リソース・フィルターに結び付ける（3.3 節）。
- 読み取りの応答に秘密を含めない。秘密は作成とローテーションの応答だけで 1 回返す（ADR-0004）。
- 管理の経路の WAF は、`Authorization` のない要求を落とす（ADR-0057）。
- すべての書き込みの操作を `audit_events` に残す（ADR-0054）。認証のイベントのログにも `sapi`・`fapi` を出す（[logs-and-streams.md](logs-and-streams.md)）。
- IP とメールアドレスは、Valkey のキーに HMAC で入れる（7.1 節）。

## 11. テスト

- 性質ベーステスト：任意の要求の列について、GCRA が許した件数が、持続の速さ × 時間 ＋ バーストを超えない。同時実行の数が上限を超えない。
- 性質ベーステスト：任意の追加・削除の列とチェックポイントの読み出しについて、同じ項目を 2 回返さず、読み出しの開始の時点にあって最後まで消されなかった項目をすべて返す。
- 表駆動テスト：7.2 節の応答の表（状態、本文、見出し）。3.4 節のエラーの表。
- 表駆動テスト：スコープ × エンドポイント。OpenAPI の `security` から生成する。スコープのないトークンで、全エンドポイントが 403 になる。
- 結合テスト：client grant を消すと、発行済みの M2M のトークンで 403 `grant_revoked`。
- 結合テスト：他テナントのトークン、他テナントの ID、他テナントのチェックポイントがすべて拒否される。
- 結合テスト：Valkey の停止中、認証 API は通り、タスクの中の近似の制限が働く。
- 結合テスト：L3 を超えても、`refresh_token` の交換は 120% まで通る。
- 契約テスト：OpenAPI の前の版と比べて壊す変更がない。
- 負荷試験（E12）：上限の付近で、判定が Valkey の 1 往復で済み、DB の負荷を増やさない。

## 12. この領域の ADR

| ADR | 決定 |
| --- | --- |
| [0033](../decisions/0033-management-api-shape.md) | Management API は本家に寄せた `/api/v2` のリソースにし、オフセットとチェックポイントのページング（1 ページ最大 100、チェックポイントは暗号化して 24 時間）を持ち、v2 の中では足す変更だけをする |
| [0034](../decisions/0034-management-api-authorization.md) | Management API はテナントの M2M・管理用のテナント・非常用の 3 種のトークンを受け、M2M は要求ごとに今の許可を確かめ、自分より広い許可を作らせない |
| [0035](../decisions/0035-rate-limiting.md) | レート制限は本家の単位と Enterprise の値に寄せ、環境で変えてプランで変えず、Valkey の GCRA で数え、リフレッシュを優先する |

## 13. Story の候補

| Epic | Story の候補 |
| --- | --- |
| E2 | Management API の骨格：ルーター、OpenAPI、エラーの形、相関 ID、`fields` |
| E2 | M2M のトークンの検証と、要求ごとの許可の確認、スコープの判定（既定で拒否） |
| E2 | オフセットのページングと、チェックポイントのページング（暗号化、24 時間） |
| E2 | 管理の経路のレート制限（L5・L6）と見出し |
| E3 | 認証の経路のレート制限（L2・L3）、`/oauth/token` の 429 の形、リフレッシュの優先 |
| E4 | Universal Login の画面の IP・`state` の制限 |
| E8 | 攻撃の防御の数の基盤（L4）と、Valkey の障害時の近似 |
| E9 | ダッシュボードのトークン（管理用のテナント）と、メンバーのロールからのスコープ、予約の枠 |
| E10 | `api_limit`・`api_limit_warning`・`depnote` のログ |
| E12 | 上書きの表と運用、負荷試験での値の見直し、OpenAPI の壊す変更の検査 |

## 14. 未解決の問い

- 本家の 1 ページの上限（50 か 100）の食い違いを、試用のテナントで確かめるか。
- 本家の Management API のエラーの本文の形（未検証）と、`/oauth/token` の 429 の本文の形を、試用のテナントで確かめる。
- ダッシュボードの呼び出しを、Management API の全体の枠に数えるか（本家は未検証）。
- 本家の Enterprise の Management API のエンドポイントごとの値（ユーザーの読み取りなど）が Essentials と同じか。
- レート制限の値をプランで変えるか（プランの設計はまだない）。
- 冪等キーを Management API に足すか（Terraform やエージェントの再試行で、作成の重複を 409 に頼る形でよいか）。

### 決定

2026-09-27 の既定案。

- 1 ページの上限は 100 にする。本家の確認はしない（大きいほうに合わせれば、本家から移る利用者のコードは動く）。
- 本家の未検証の形（エラーの本文、429 の本文）は、観察されている形に寄せて決め、試用のテナントでの確認は E2 の Story の中で行う。確認の結果で形は変えない（標準の OAuth のエラーの形に反しない限り）。
- ダッシュボードの呼び出しは全体の枠に数え、別に 1 秒 5 の予約の枠を置く。
- 値は環境で変え、プランで変えない。
- 冪等キーは MVP で持たない。E12 で、Terraform のプロバイダーの試験で問題が出たら足す。

## 15. quality.md・runbooks・data-model に載せるもの

**quality.md**

- リスク：管理の経路からの権限の昇格（M2M で広い許可を作る）、他テナントの参照。スコープ × エンドポイントの表駆動テストと、テナントの分離の性質ベーステストで見る。
- 性質ベーステスト：GCRA の上限、チェックポイントの完全さと重複のなさ。
- 契約テスト：OpenAPI の壊す変更の検査を、Management API を変える PR の必須のチェックにする。
- 本番での検証：合成監視で、Management API の一覧（チェックポイント）と、429 の見出しの形を毎時確かめる。

**runbooks**

- `rate-limit-override`：テナントの上限の引き上げ・引き下げ。承認、期限、監査。
- `rate-limit-spike`：特定のテナントの 429 が急増した。攻撃か、テナントの不具合か、上書きの要否を判断する。
- `ratelimit-backend-down`：Valkey の計数の失敗。近似の制限が働いているかを確かめる。
- SLI の追加の依頼（Ops へ）：`ratelimit_limited_total{limit, env}`、`ratelimit_backend_errors_total`、Management API の p99（NFR-004）、`grant_revoked` の件数、リフレッシュの 429 の率（0 に近いこと）。

**data-model**

| テーブル | 主な列 | 備考 |
| --- | --- | --- |
| `rate_limit_overrides` | `tenant_id`、`limit_name`、`burst`、`rate_per_sec`、`reason`、`expires_at`、`approved_by` | RLS の外（Ops が扱う）。変更はプラットフォームの監査 |
| `mgmt_api_deprecations` | `feature`、`announced_at`、`sunset_at` | 本システムの設定。`depnote` の判定に使う |

チェックポイントは DB に保存しない（暗号化した文字列に状態を持たせる）。

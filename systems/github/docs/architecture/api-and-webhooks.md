# API and webhooks: GitHub

REST・GraphQL の API、トークンとスコープ、App（本家の GitHub App に相当）と OAuth アプリ、Webhook、レート制限の設計。API の形と版は [ADR-0021](../decisions/0021-api-shape-and-versioning.md)、トークンは [ADR-0019](../decisions/0019-authentication-and-token-model.md)、App は [ADR-0020](../decisions/0020-github-app-model.md)、Webhook は [ADR-0022](../decisions/0022-webhook-signing-and-delivery.md) に従う。権限の判定は [identity-and-permissions.md](identity-and-permissions.md) にある。

方針は「本家 GitHub に寄せる」。本家の振る舞いは docs.github.com で 2026-09-26 に確かめ、確かめられなかったものは **未検証** と書く。本家から外すところは「本家との違い」として理由を書く。

## 1. 位置づけ

| 面 | 利用者 | 契約 | 互換性の約束 |
| --- | --- | --- | --- |
| 内部の API（Hono RPC） | 自分たちの Web | Web と同時にデプロイ | 約束しない |
| REST API（`api.<domain>`） | 外部のツール、CLI、CI、App、AI エージェント | OpenAPI 3.1 | 日付の版の中で約束する（4 節） |
| GraphQL API（`api.<domain>/graphql`） | 同上 | GraphQL のスキーマ | スキーマの変更の予告で約束する（5 節） |
| Webhook（外向き） | App、外部のサービス | 事象ごとのペイロードのスキーマ | REST の版と同じ扱い（9 節） |
| Git（HTTPS・SSH） | Git のクライアント | Git のプロトコル | [git-protocols.md](git-protocols.md) |

- **3 つの面（内部・REST・GraphQL）は、同じドメインのサービス関数を呼ぶ。** 権限の判定（`can()`）、冪等性、監査はサービス関数の側に置く。面どうしは HTTP で呼び合わない（Slack の ADR-0030 と同じ考え方）。
- REST と GraphQL は、1 つの ECS サービス（`apps/public-api`）で受ける。外部の急増が Web に響かず、障害時に単独で絞れるようにする。
- **形は本家に寄せる。** パス（`/repos/{owner}/{repo}/issues` など）、項目の名前、ページングのヘッダー、エラーの本文、ヘッダーの構造を本家に合わせ、本家の API を知る利用者と、学習済みの AI エージェントが、少ない手直しで使えるようにする。**ヘッダーの名前・トークンの接頭辞・メディアタイプの本家の名前の部分は、リポジトリ共通の [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md) に従い `<Brand>`・`<brand>` に置き換える**（例：本家の `X-GitHub-Api-Version` は `X-<Brand>-Api-Version`）。本家の SDK（Octokit）や `gh` をそのまま使えることは目標にせず、公式の SDK と CLI を用意する。ただし **完全な互換は約束しない**。実装した操作の一覧を公開し、未実装の操作は 404 ではなく `501` と文書の URL を返す（[ADR-0021](../decisions/0021-api-shape-and-versioning.md)）。

## 2. 構成

```
client ─▶ CloudFront ─▶ ALB ─▶ public-api（Hono）
                                 1. 主体の解決（トークン → actor。identity-and-permissions.md の 3.4 節）
                                 2. レート制限（11 節）
                                 3. 版の解決（REST）/ 費用の計算（GraphQL）
                                 4. サービス関数（can() を含む）
                                 5. 版の変換（REST の応答）
                                        │
                                        ├─ Aurora（メタデータ）
                                        └─ Git ストレージの RPC（中身）
```

## 3. REST

### 3.1 形式

| 項目 | 規則 | 本家 |
| --- | --- | --- |
| メディアタイプ | `application/vnd.<brand>+json`（`application/json` も受ける） | 同じ |
| 認証 | `Authorization: Bearer <token>`（`token <token>` も受ける） | 同じ |
| ページング | `per_page`（最大 100、既定 30）・`page`。次のページは `Link` ヘッダーの `rel="next"`。一部の一覧（監査ログ、Webhook の配信）はカーソル（`after`・`before`） | 同じ |
| エラー | `{"message": ..., "documentation_url": ..., "errors": [...]}`、`status` | 同じ。Slack の公開 API（RFC 9457）とは違う |
| 条件付きの要求 | `ETag`・`Last-Modified`。`304` は主のレート制限に数えない | 同じ（304 を数えないのは、認証済みの要求のとき） |
| 時刻 | ISO 8601、UTC | 同じ |
| ID | 数値の `id` と、GraphQL と共通の `node_id` | 同じ |

### 3.2 権限の不足の知らせ方

- 読めない資源は `404`（[identity-and-permissions.md](identity-and-permissions.md) の 5.2 節）。
- 読めるが権限が足りないときは `403` に、足りないものをヘッダーで返す（本家と同じ名前）。
  - クラシックの PAT・OAuth：`X-OAuth-Scopes`（持っているスコープ）、`X-Accepted-OAuth-Scopes`（その操作が受け付けるスコープ）
  - 細粒度の PAT・App：`X-Accepted-<Brand>-Permissions`（例：`contents=write`）
- AI エージェントが「何を付け足せばよいか」を機械的に読めるようにするため、エラーの `errors[]` にも `{"code": "missing_permission", "permission": "contents", "level": "write"}` を入れる（本家にない追加。追加の項目なので互換を壊さない）。

### 3.3 冪等性（本家にない追加）

- 作成の操作（`POST`）は、任意で `Idempotency-Key` を受ける。同じキー・同じ主体・同じ本文なら、24 時間は最初の応答を返す。本文が違えば `422`。
- 本家は持たない。AI エージェントは失敗時に再試行しやすく、Issue やコメントの二重の作成が起きやすいので加える。キーを付けない要求は本家と同じ振る舞いになる。

### 3.4 初版に含める資源（E7）

リポジトリ、ブランチ・タグ・ref、コミット・ツリー・ファイルの中身（`contents`）、Issue・コメント・ラベル・マイルストーン、Pull Request・レビュー・レビューのコメント、コラボレーター・チーム・Organization のメンバー、Webhook と配信、App とインストール、チェック（check run・check suite）とステータス、検索、レート制限（`GET /rate_limit`）、利用者（`GET /user`）。Actions の API は E8 で加える。

## 4. REST の版

本家の方式に合わせる（[API versions](https://docs.github.com/en/rest/about-the-rest-api/api-versions)、2026-09-26 に確認）。

- **版はヘッダー `X-<Brand>-Api-Version: YYYY-MM-DD` で選ぶ。** URL に版を入れない。
- **ヘッダーがなければ、最初の版を使う。** 本家も、ヘッダーがなければ最初の版（`2022-11-28`）を使う。本システムの最初の版の日付は、公開の日に決める。
- **新しい版を出したら、前の版を少なくとも 24 か月動かす**（本家と同じ）。
- 対応しない版を指定されたら `400`。
- **互換を壊す変更は、新しい版でだけ行う。** 本家の分類に合わせる：操作の削除、パラメーター・応答の項目の名前の変更・削除、必須のパラメーターの追加、型の変更、列挙値の削除、認証・認可の要件の変更、など。
- **追加は、すべての版に同時に入れる**：操作、任意のパラメーター、応答の項目、ヘッダー、列挙値の追加。クライアントは知らない項目・列挙値を無視する前提にする（文書に明記する）。
- 実装：内部の形は常に最新の版にし、版ごとの差分を「変換のモジュール」（要求を新しい形へ、応答を古い形へ）として新しい順に並べ、指定の版まで順にかける。Stripe の日付の版と同じ仕組みで、版の数に比例してコードが増えないようにする。
- 応答には、使った版を `X-<Brand>-Api-Version-Selected` で返す（本家の文書にはない。2026-09-26 に確認。本システムの追加の項目）。
- 廃止の予告は、`Deprecation`・`Sunset` のヘッダー、変更履歴（changelog）、呼び出しの残る App の持ち主へのメールで行う。

## 5. GraphQL

### 5.1 スキーマ

- **1 つの端点**（`POST /graphql`）。版は持たず、スキーマを育てる（本家と同じ）。
- Relay の規約に従う：`node(id:)`・`nodes(ids:)`、グローバルな ID（型と数値の ID を符号化した不透明な文字列。REST の `node_id` と同じ値）、接続（connection）は `edges`・`nodes`・`pageInfo`・`totalCount`。
- 接続には `first` か `last` を必須にし、値は 1〜100（本家と同じ）。
- 実装は TypeScript のコード優先のスキーマ（Pothos ＋ GraphQL Yoga。2026-09-28 の決定）。型はサービス関数の戻り値から作り、REST と同じサービス関数を呼ぶ。
- **権限は節点（node）ごとに `can()` を通す。** 読めない節点は `null` にし、`errors` に `NOT_FOUND` を入れる（存在を漏らさない）。一覧は `accessPredicate` で前段から絞る。DataLoader で `canMany` にまとめ、1 つの問い合わせでの判定を 1 回の往復に寄せる。
- 変更は `@deprecated` で予告し、削除は予告から 3 か月以上たってから、四半期ごとの決まった日にまとめて行う。本家の GraphQL も、破壊的な変更を 3 か月以上前に予告し、四半期の初日（1/1・4/1・7/1・10/1）に行う（[Breaking changes](https://docs.github.com/en/graphql/overview/breaking-changes)、2026-09-26 に確認）。本システムも同じ周期にする。
- スキーマ（SDL）と変更の履歴を公開する。イントロスペクションは許す。

### 5.2 費用と制限

本家の方式に合わせる（[Rate limits and query limits for the GraphQL API](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api)、2026-09-26 に確認）。

| 項目 | 値 | 本家 |
| --- | --- | --- |
| 費用の計算 | 実行の前に、各接続の `first`/`last` の最大値から、必要な要求の数を合計し、100 で割って丸める。最小 1 点 | 同じ |
| 主の制限 | ユーザー 5,000 点/時、App のインストール 5,000 点/時、Actions のジョブ 1,000 点/時・リポジトリ | 同じ（Enterprise Cloud の上乗せは持たない） |
| 節点の上限 | 1 つの問い合わせで 500,000 | 同じ |
| 副の制限 | 2,000 点/分。変更（mutation）を含む要求は 5 点、含まないものは 1 点 | 同じ |
| 実行時間 | 10 秒で打ち切る | 同じ |
| 深さ | 15 段（本システムの値） | 本家は深さの上限を公開していない（深さを減らす助言だけ。[Rate limits and query limits](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api)、2026-09-26 に確認。**未検証**） |

- 費用は静的に計算するので、実行の前に断れる。応答の `rateLimit { cost remaining resetAt }` で知らせる。

## 6. トークンとスコープ

### 6.1 形式

本家の形式（接頭辞 ＋ 乱数 ＋ CRC32 のチェックサムを Base62 で 6 文字）に倣う（[Behind GitHub's new authentication token formats](https://github.blog/engineering/platform-security/behind-githubs-new-authentication-token-formats/)、2026-09-26 に確認）。接頭辞は本家と衝突させない（ADR-0006）。実際の名前は開発リポジトリの作成時に決め、GitHub の secret scanning partner program などに独自の形式として登録する。

| 種類 | 本家の接頭辞（出典） | 本システムの接頭辞（ADR-0006 の置き換え用の名前） |
| --- | --- | --- |
| クラシックの PAT | `ghp_` | `<brand>p_` |
| 細粒度の PAT | `github_pat_` | `<brand>_pat_` |
| OAuth アプリのトークン | `gho_` | `<brand>o_` |
| App のユーザーのトークン | `ghu_` | `<brand>u_` |
| App のインストールのトークン | `ghs_` | `<brand>s_` |
| リフレッシュトークン | `ghr_` | `<brand>r_` |

- チェックサムで、DB を引かずに形の誤りと、秘密の走査での誤検出を減らす。
- DB には SHA-256 のハッシュだけを置き、表示用に接頭辞と末尾 4 文字を持つ。平文は発行時に 1 回だけ見せる。
- 公開のリポジトリへの push に、本システムのトークンが含まれていたら、自動で失効させて持ち主に知らせる（push protection の候補。intent.md の Non-goals の注記）。本家の secret scanning partner program にも接頭辞を登録する（Slack の apps.md の 5.3 節と同じ手順）。

### 6.2 クラシックのスコープ

本家のスコープの名前を使う：`repo`（`repo:status`・`repo_deployment`・`public_repo`・`repo:invite` を含む）、`workflow`、`read:org`・`write:org`・`admin:org`、`admin:repo_hook`・`write:repo_hook`・`read:repo_hook`、`admin:org_hook`、`read:user`・`user:email`、`delete_repo`、`admin:public_key`、`admin:gpg_key`、`admin:ssh_signing_key`。権限の名前への写し方は、`packages/authz` の 1 つの表に置く。

### 6.3 細粒度の権限

- 本家の権限の名前と水準を使う（[Permissions required for fine-grained PATs](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)、2026-09-26 に確認）。例：リポジトリの `contents`・`issues`・`pull_requests`・`metadata`（読み取りだけ）・`administration`・`workflows`・`checks`・`statuses`・`repository_hooks`、Organization の `members`・`organization_hooks`、アカウントの `email_addresses` など。
- **細粒度の PAT と App は、同じ権限の語彙を使う。** 操作ごとに要る権限を OpenAPI の拡張（`x-required-permissions`）で持ち、文書・`X-Accepted-<Brand>-Permissions`・`can()` の表を同じ正本から作る。

### 6.4 Organization の方針

本家の 3 つの方針に合わせる（[Setting a PAT policy](https://docs.github.com/en/organizations/managing-programmatic-access-to-your-organization/setting-a-personal-access-token-policy-for-your-organization)、2026-09-26 に確認）。

| 方針 | 選択肢 | 既定 |
| --- | --- | --- |
| クラシックの PAT で Organization の資源に入れるか | 許す / 拒否 | 許す（本家と同じ） |
| 細粒度の PAT の承認 | 要る / 要らない | 要る（owner が作ったものは除く。本家と同じ） |
| 最長の有効期間 | 日数 | 細粒度は 366 日（本家と同じ）。クラシックも 366 日（本家は既定で制限なし。**本家との違い**） |
| OAuth アプリの利用の制限 | 承認したアプリだけ / 制限なし | 承認したアプリだけ（本家も新しい Organization では既定で有効。[About OAuth app access restrictions](https://docs.github.com/en/organizations/managing-oauth-access-to-your-organizations-data/about-oauth-app-access-restrictions)、2026-09-26 に確認） |

- 方針に合わないトークンは、失効させずに、その Organization の資源に対してだけ拒否する（本家と同じ）。

## 7. App（本家の GitHub App に相当）

### 7.1 モデル

| 概念 | 内容 |
| --- | --- |
| App | 持ち主（ユーザーか Organization）が登録する。名前、slug、権限（リポジトリ・Organization・アカウントの各権限と水準）、購読する事象、Webhook の URL と秘密、コールバックの URL、公開か非公開（非公開は持ち主のアカウントにだけ入れられる） |
| インストール | App × アカウント（ユーザーか Organization）。リポジトリの選択（すべて / 選んだもの）、承認済みの権限、停止の状態 |
| bot | App ごとに 1 つ（`<slug>[bot]`）。インストールのトークンの主体 |
| 秘密鍵 | App の持ち主がコンソールで作る。本システムは **公開鍵だけを保存** し、秘密鍵は作成時に 1 回だけ渡す。1 つの App に複数（入れ替え用） |
| クライアントの秘密 | ユーザーのトークンの取得（OAuth のフロー）に使う |

- 購読する事象は、その事象に要る権限を App が持つときだけ選べる（例：`issues` の事象には `issues:read`）。
- **App が権限を増やしたら、インストールの持ち主の承認が要る。** 承認までは、旧い権限のまま動く。権限を減らすのは即時に効く。
- Organization のメンバーがリポジトリの admin でない場合は、インストールの「依頼」を owner に送る。

### 7.2 トークンの取得

本家と同じ手順にする（[Generating an installation access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)、2026-09-26 に確認）。

1. App は秘密鍵で JWT（RS256、`iss` は App の ID、有効期間は最長 10 分）を作る。
2. `POST /app/installations/{installation_id}/access_tokens` に JWT を付けて呼ぶ。本文で `repositories`・`repository_ids`（最大 500）と `permissions` を渡すと、インストールの範囲の部分集合に絞れる。
3. 1 時間有効のインストールのトークン（`<brand>s_`）を返す。

- 時計のずれを考えて、JWT の `iat` は 60 秒前まで受け付ける。
- インストールのトークンは DB に保存する（ハッシュ）。1 時間で消えるので、保存の量はインストールの数 × 呼び出しの頻度で決まる。TTL の削除を Aurora のパーティション（時間ごと）で行う。

### 7.3 ユーザーのトークン

- App は OAuth のフロー（Web のコールバック、またはデバイスのフロー）で、ユーザーのトークン（`<brand>u_`、8 時間）とリフレッシュトークン（`<brand>r_`、6 か月）を得る。期限は本家の既定と同じで、本家では外せるが、本システムでは外せない（[Refreshing user access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens)、2026-09-26 に確認。**本家との違い**）。
- 権限はユーザーと App の積（[identity-and-permissions.md](identity-and-permissions.md) の 5.4 節の行 5）。
- リフレッシュトークンは 1 回限りで入れ替える。使い済みのものが再び使われたら、その系列をすべて失効させる（漏洩の検知）。

### 7.4 マニフェストでの作成

本家の 3 段の流れに合わせる（[Creating a GitHub App from a manifest](https://docs.github.com/en/apps/creating-github-apps/setting-up-a-github-app/creating-a-github-app-from-a-manifest)、2026-09-26 に確認）。

1. 利用者を、マニフェスト（JSON：名前、URL、権限、事象、Webhook）付きで App の登録の画面へ送る。
2. 利用者が確かめて作ると、一時的な `code` を付けて戻す。
3. `POST /app-manifests/{code}/conversions` で、App の ID・秘密鍵（PEM）・Webhook の秘密・クライアントの秘密を 1 回だけ返す。3 段を 1 時間以内に終える。

- AI エージェントや CI の道具が、自分の App を人の確認 1 回で作れるので、エージェントの主体を作る標準の経路にする（10 節）。

## 8. OAuth アプリ

- 本家と同じく残す。GitHub App を推奨とし、OAuth アプリは既存の道具との互換のために持つ。
- フロー：認可コード（PKCE を受け付ける）と、デバイスのフロー（CLI・エージェント向け）。
- トークン（`<brand>o_`）は、利用者かアプリが取り消すまで有効（本家と同じ）。スコープはクラシックの PAT と同じ。
- ユーザー × アプリ × スコープの組ごとに、トークンは 10 まで、新しい発行は 1 時間に 10 までにする。超えたら古いものから失効する（本家と同じ。[Authorizing OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)、2026-09-26 に確認）。
- OAuth アプリには Webhook の仕組みがない（Webhook はリポジトリか Organization に別に作る。本家と同じ）。

## 9. Webhook

### 9.1 種類

| 種類 | 作れる人 | 範囲 | S1 |
| --- | --- | --- | --- |
| リポジトリの Webhook | リポジトリの admin | 1 つのリポジトリの事象 | ○ |
| Organization の Webhook | Organization の owner | Organization の全リポジトリと Organization の事象 | ○ |
| App の Webhook | App の持ち主 | App の全インストールの事象（1 つの URL） | ○ |
| Enterprise の Webhook | Enterprise の owner | | E10 |

- 1 つのリポジトリ・Organization に置ける Webhook の数は、事象の種類ごとに 20 までにする（本家と同じ。[Troubleshooting webhooks](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/troubleshooting-webhooks)、2026-09-26 に確認）。
- 初版の事象（E7）：`ping`、`push`、`create`、`delete`、`pull_request`、`pull_request_review`、`pull_request_review_comment`、`issues`、`issue_comment`、`label`、`milestone`、`repository`、`member`、`membership`、`team`、`organization`、`fork`、`release`、`star`、`status`、`check_run`、`check_suite`、`installation`、`installation_repositories`、`github_app_authorization`。Actions の事象（`workflow_run`、`workflow_job`）は E8。
- ペイロードの形は、本家の事象ごとの形に寄せる。ペイロードは REST の版の変換を受ける（Webhook ごとに版を固定して保存し、作成時の最新の版を既定にする）。本家の Webhook は版を持たない（配信のヘッダーと文書に版の記述がない。[Webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads)、2026-09-26 に確認）。版の固定は本システムの追加（**本家との違い**）。

### 9.2 送る要求

本家の形に合わせる（[Webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads)、[Validating webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)、2026-09-26 に確認）。

| ヘッダー | 値 |
| --- | --- |
| `X-<Brand>-Event` | 事象の名前 |
| `X-<Brand>-Delivery` | 配信の GUID。自動の再試行と手動の再配信で **変えない**（受け手の重複の排除のため） |
| `X-<Brand>-Hook-ID` | Webhook の ID |
| `X-<Brand>-Hook-Installation-Target-Type`・`-ID` | Webhook を作った資源の種類と ID |
| `X-<Brand>-Signature-256` | `sha256=` ＋ HMAC-SHA256（秘密、本文の生のバイト列）の 16 進 |
| `User-Agent` | `<brand>-Hookshot/<ver>` |
| `Content-Type` | `application/json`（`application/x-www-form-urlencoded` も選べる） |

- **署名の方式は本家と同じにする。** 値の形（`sha256=` ＋ 16 進）が本家と同じなので、本家の受け手の検証のコードは、読むヘッダーの名前を変えるだけで使える。ヘッダーの名前は ADR-0006 で本家と違える（本家の `X-Hub-Signature-256` は `X-<Brand>-Signature-256`、`X-GitHub-Delivery` は `X-<Brand>-Delivery`）。署名の秘密は UTF-8 の文字列として扱う。
- **本家の SHA-1 の `X-Hub-Signature` に相当するものは送らない**（本家は互換のためだけに送る。**本家との違い**。新しい実装に旧い方式を増やさない）。
- **秘密を必須にする**（本家では任意。**本家との違い**。非公開のリポジトリの中身を、署名なしで外へ出さない）。
- **宛先は `https` だけ、TLS の検証を外せない**（本家は `http` と検証の無効化を選べる。**本家との違い**）。
- ペイロードの上限は 25 MB。超えたら送らず、配信の記録に理由を残す（本家と同じ）。
- 時刻を署名に含めないので、リプレイの防止は受け手の `X-<Brand>-Delivery` の重複の排除に頼る（本家と同じ）。Slack で採った Standard Webhooks の形式は、本家との互換を優先して採らない（[ADR-0022](../decisions/0022-webhook-signing-and-delivery.md)）。
- 秘密は KMS で暗号化して DB に置き、署名する Worker だけが復号できる。入れ替えは、新しい秘密の保存で即時に切り替わる（受け手は切り替えの間、新旧の両方で検証する。本家と同じ運用）。

### 9.3 配信の流れ

```
outbox（ref の更新、Issue の作成など）──▶ SQS ──▶ hook-dispatch（Worker）
   1. 事象に合う Webhook を探す（リポジトリ・Organization・App のインストール）
   2. 宛先ごとに、ペイロードを作って保存する（配信の記録、S3 に圧縮した本文）
   3. 配信のジョブを SQS に入れる（宛先ごとの FIFO のグループ）
                                            │
                                            ▼
                                  hook-delivery（Worker、VPC の中）
   4. 送る直前に can() でもう一度確かめる（9.4）
   5. 署名する
   6. hook-egress（Lambda、専用の隔離された VPC、権限なし）を同期で呼ぶ ──▶ 宛先の URL
   7. 応答のステータス・ヘッダー・本文の先頭（配信の記録用）と所要時間を記録する
```

- **外向きの送信は、隔離された egress から出す。** Slack の ADR-0016・apps.md の 13 節と同じ考え方：本体の VPC に接続しない、権限を持たない Lambda が、署名済みの要求を受け取って送るだけ。宛先の検査（私的な IP・メタデータのアドレスの拒否、検査したアドレスへの直接の接続、リダイレクトを追わない、自分たちのドメインへの送信の禁止、ポートは 443 など許可したものだけ）を行う。秘密は Lambda に渡さない。
- 送信元の IP の一覧を公開する（本家は `/meta` で Webhook の送信元の IP の範囲を公開している）。そのため hook-egress は、本体の VPC とつながらない専用の VPC（ほかの資源を置かず、ピアリングも持たない）に置き、固定の Elastic IP を持つ NAT から出す。Slack は IP を固定しなかった（Slack の ADR-0016 の選択肢 3 にあたる）が、本家に寄せる。本家の `/meta` は `hooks` の項目に Webhook の送信元の範囲を返す（[Meta の REST API](https://docs.github.com/en/rest/meta/meta)、2026-09-26 に確認）。
- ペイロードは **事象の時点の写し** にする（本家と同じ）。送る時点の最新にはしない。
- 事象の順序は保証しない（本家と同じ）。同じ宛先への配信は、宛先ごとの同時実行の上限（初期値 20）の中で並行に送る。
- 応答の待ち時間は 10 秒。2xx を成功とする（本家と同じ。[Handling failed webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries)、2026-09-26 に確認）。

### 9.4 送る直前の権限の確認

事象から配信までの間に権限が変わると、写しのペイロードが見てはいけない人へ届きうる。送る直前（再試行・再配信のたびにも）に次を確かめ、満たさなければ送らずに `skipped` と記録する。

| Webhook の種類 | 確かめること |
| --- | --- |
| リポジトリ | Webhook がまだ存在し、有効である |
| Organization | 同上。リポジトリがまだその Organization にある（移管されていない） |
| App | インストールがあり、停止されていない。リポジトリがまだインストールの範囲にある。App が事象に要る権限をまだ持つ |

- 1 つのリポジトリの事象を、多数の App のインストールが購読しているときは、インストールの bot の集合を `filterActorsCanRead`（[identity-and-permissions.md](identity-and-permissions.md) の 5.1 節）で一括に確かめる。
- リポジトリを別の持ち主へ移管したら、移管の前の事象の配信は、移管の後の Organization の Webhook に送らない（事象は発生時の持ち主の Webhook に結び付ける）。

### 9.5 失敗と再配信

| 結果 | 扱い |
| --- | --- |
| 2xx | 成功 |
| 接続の失敗、10 秒のタイムアウト、5xx、429 | 自動で再試行する |
| その他の 4xx | 失敗。自動の再試行はしない |
| 宛先の検査で拒否（SSRF の疑い） | 失敗。再試行しない |

- **自動の再試行を行う（本家との違い）。** 本家は失敗した配信を自動では送り直さず、利用者が UI か API で再配信する（同上の文書）。本システムは、一時的な失敗で事象を失わないよう、1 分・10 分・1 時間の後に計 3 回まで自動で送り直す（±20% のジッター）。受け手は `X-<Brand>-Delivery` で重複を捨てる前提で、本家の受け手の多くもそうしている。
- **手動の再配信は 3 日以内**（本家と同じ。[Redelivering webhooks](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks)、2026-09-26 に確認）。UI と API（`POST /repos/{o}/{r}/hooks/{id}/deliveries/{delivery_id}/attempts` など）で行う。再配信できるのは、リポジトリの admin、Organization の owner、App の持ち主（本家と同じ）。
- 配信の記録（要求と応答のヘッダー・本文）は 3 日間保持し、その後は件数と結果だけを 30 日保持する。
- 失敗が続く宛先：直近 1 時間の失敗の割合が 90% を超えたら、宛先ごとに送る速さを落とし（回路遮断）、持ち主にメールで知らせる。Webhook を自動では無効にしない。本家も、失敗した配信を自動で送り直さないとだけ書き、失敗による自動の無効化は文書にない（[Handling failed webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries)、2026-09-26 に確認）。
- 配信の滞留は runbook `webhook-backlog.md` で扱う（13 節）。

## 10. AI エージェントを第一の利用者として扱う

intent.md の「エージェントが使いやすいこと」を、次の形で満たす。

| 論点 | 設計 |
| --- | --- |
| 主体 | **推奨は App。** 組織の自動化は App の bot（インストールのトークン）、人の代わりに動くエージェントは App のユーザーのトークン（人とエージェントの両方が表示・監査に残る）。手元の単発の作業は細粒度の PAT |
| 作り方 | マニフェストの流れ（7.4）で、人の確認 1 回でエージェント用の App を作れる |
| 最小の権限 | 細粒度の権限、リポジトリの選択、インストールのトークンの部分集合への絞り込み。トークンは既定で短命 |
| 分かる失敗 | `X-Accepted-<Brand>-Permissions` と `errors[].code`（3.2）、`documentation_url`、レート制限の残りと回復の時刻（11.3） |
| 安全な再試行 | `Idempotency-Key`（3.3）。Webhook の `X-<Brand>-Delivery` の重複の排除 |
| 機械が読める契約 | OpenAPI 3.1（操作ごとの要る権限を含む）と GraphQL の SDL を公開する。本家の API の形に寄せ、既存の知識と道具を使えるようにする |
| 暴走の抑止 | 副の制限（書き込みの速さ、同時実行）を、人とエージェントに同じくかける。エージェントを特別扱いしない |
| 帰属 | エージェントの書き込みは、App の bot か「ユーザー via App」として表示し、監査ログで区別する |

- MCP のサーバー（本家は公式の MCP サーバーを出している）は、公開 API の上に作る薄い層として、E7 の後の候補にする。公開 API と別の権限の経路を作らない。

## 11. レート制限

Slack の [ADR-0029](../../../slack/docs/decisions/0029-rate-limiting.md) と [rate-limiting.md](../../../slack/docs/architecture/rate-limiting.md) の枠組み（層、GCRA を Valkey の Lua で 1 往復、非同期は遅らせ同期は断る、Valkey の障害時は一般の制限を通して認証の制限を止める）をそのまま使う。値と応答の形を本家に合わせる。

### 11.1 主の制限（1 時間あたりの割り当て）

本家の値に合わせる（[Rate limits for the REST API](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)、2026-09-26 に確認）。Enterprise Cloud の上乗せは持たない。

| 主体 | REST | GraphQL | 数える単位 |
| --- | --- | --- | --- |
| 匿名 | 60 回/時 | 使えない | IP |
| ユーザー（PAT、OAuth、App のユーザーのトークン、Web 以外） | 5,000 回/時 | 5,000 点/時 | ユーザー（同じユーザーのトークンで合算） |
| App のインストール | 5,000 回/時から、20 を超えるリポジトリ・ユーザー 1 つごとに 50 増え、最大 12,500 回/時 | 5,000 点/時 | インストール |
| OAuth アプリのクライアントの資格情報 | 5,000 回/時 | - | アプリ |
| Actions のジョブのトークン | 1,000 回/時 | 1,000 点/時 | リポジトリ |

- ユーザーのトークンは、本家と同じく、そのユーザーの全トークンで割り当てを分け合う。本家は、App のユーザーのトークンの割り当ても、他の App・OAuth アプリがそのユーザーの代わりに行う要求と、そのユーザーの PAT と合算すると明記している（[Rate limits for the REST API](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)、2026-09-26 に確認）。以前の案（App × ユーザーで別に数える）は採らず、本家に合わせてユーザーで合算する。
- 計数は GCRA で行い、時間あたりの割り当てを「1 時間に N 回、バースト N」として表す。応答の `x-ratelimit-reset` は、GCRA の `TAT` から、割り当てが満杯に戻る時刻を計算して返す。

### 11.2 副の制限（濫用の防止）

本家の値に合わせる（同上）。

| 対象 | 上限 |
| --- | --- |
| 同時の要求（REST と GraphQL の合計） | 100 |
| REST の点数 | 900 点/分（`GET`・`HEAD`・`OPTIONS` は 1 点、`POST`・`PATCH`・`PUT`・`DELETE` は 5 点。本家と同じ。同上、2026-09-26 に確認） |
| GraphQL の点数 | 2,000 点/分（5.2） |
| CPU 時間 | 実時間 60 秒あたり 90 秒 |
| 内容を作る要求（Issue、コメント、PR など） | 80 回/分、500 回/時 |
| OAuth のトークンの発行 | 2,000 回/時 |

- 同時の要求は、Slack の L5 と同じく Valkey のソート済み集合で数える。

### 11.3 応答

| 場合 | 状態 | ヘッダー |
| --- | --- | --- |
| すべての応答 | - | `x-ratelimit-limit`・`x-ratelimit-remaining`・`x-ratelimit-used`・`x-ratelimit-reset`（UNIX 秒）・`x-ratelimit-resource`（`core`・`graphql`・`search` など） |
| 主の制限を超えた | `429` | `x-ratelimit-remaining: 0` と `x-ratelimit-reset` |
| 副の制限を超えた | `429` | `retry-after`（秒） |

- 本家の REST は `403` か `429` を返す。GraphQL は、主の制限で `200` とエラーの本文、副の制限で `200` か `403` を返す（[GraphQL の制限](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api)、2026-09-26 に確認）。本システムは REST も GraphQL も `429` にそろえる（**本家との違い**）。Octokit など主なクライアントが `429` を扱うかは、クライアントの実装に依存し文書では確かめられない（**未検証**）ので、E7 の公式の SDK の Story で確かめる。
- 本家の IETF の `RateLimit` ヘッダー（Slack が付けたもの）は付けない。本家の `x-ratelimit-*` と重ねると、クライアントがどちらを信じるか迷うため。
- 検索は別の資源（`search`：30 回/分）として数える（[search.md](search.md)）。Git の操作の制限は [git-protocols.md](git-protocols.md) にある。

## 12. データモデル（[data-model.md](data-model.md) への追加の提案）

| テーブル | 中身 |
| --- | --- |
| `apps` | 持ち主、slug、名前、公開か、権限、購読する事象、Webhook の URL・秘密（KMS で暗号化）、コールバックの URL |
| `app_keys` | App の公開鍵、作成日時、削除日時 |
| `app_client_secrets` | ハッシュ、最終使用 |
| `app_installations` | App × アカウント、リポジトリの選択、承認済みの権限、停止の日時 |
| `app_installation_repositories` | インストール × リポジトリ |
| `app_permission_requests` | 権限を増やす要求、承認の状態 |
| `installation_tokens` | ハッシュ、インストール、絞った権限とリポジトリ、期限（時間でパーティション） |
| `app_user_tokens` | ハッシュ、ユーザー、App、期限、リフレッシュの系列 |
| `oauth_apps` | 持ち主、クライアントの ID、コールバック |
| `oauth_tokens` | ハッシュ、ユーザー、アプリ、スコープ、最終使用 |
| `org_oauth_app_approvals` | Organization × OAuth アプリ、承認の状態 |
| `webhooks` | 種類（リポジトリ / Organization / App）、対象、URL、秘密（暗号化）、事象、形式、版、有効か |
| `webhook_deliveries` | GUID、Webhook、事象、ペイロードの場所（S3）、試行の回数、結果、次の試行の時刻（日ごとのパーティション、3 日で本文を消す） |
| `webhook_delivery_attempts` | 試行ごとのステータス、所要時間、応答の先頭 |
| `idempotency_keys` | 主体、キー、本文のハッシュ、応答（24 時間） |

## 13. 観測と運用

- メトリクス：
  - API：面・版・操作ごとの要求数と遅延、`4xx`/`5xx`、版ごとの呼び出し（廃止の判断）、GraphQL の費用の分布
  - レート制限：`ratelimit_limited_total{kind=primary|secondary, resource}`
  - Webhook：最初の配信までの遅延（NFR-006：p95 10 秒）、滞留の件数と最古の年齢、宛先ごとの失敗の割合、`skipped` の件数、egress の拒否（SSRF の試み）
  - トークン：発行・失効・拒否の件数、公開のリポジトリで見つかったトークンの件数
- runbook の候補（Ops、`runbooks/`）：
  - `token-leak.md`：トークンの漏洩（1 件・大量・署名の鍵や App の秘密鍵）。失効、影響の範囲（監査ログのトークンの ID から）、持ち主への連絡
  - `webhook-backlog.md`：配信の滞留。宛先ごとの回路遮断、hook-delivery の増設、egress の同時実行、特定の宛先の一時停止
  - `api-abuse.md`：副の制限の急増、特定の主体の一時的な締め付け

## 14. テスト

- 契約：OpenAPI の差分を CI で検査し、版の中で互換を壊す変更（削除、型の変更、必須化、列挙値の削除）を失敗させる。版の変換のモジュールは、版ごとの応答のスナップショットで検査する。
- 表駆動テスト：各操作の要る権限（`x-required-permissions`）と `can()` の表が一致する。
- 性質ベーステスト：
  - 任意の権限の変更と事象の列で、送る直前の確認（9.4）を満たさない Webhook には、何も送られない。
  - 同じ配信の自動の再試行と手動の再配信で、`X-<Brand>-Delivery` と本文は変わらず、署名は検証に通る。
  - GraphQL：任意の問い合わせで、実行前の費用 ≥ 実行時に読んだ節点の数から求めた費用。読めない節点は `null` で、存在の手がかり（名前、数）が応答に出ない。
  - レート制限：許可された件数が上限を超えない（Slack と同じ）。
- 結合テスト：Webhook の署名を、本家と同じ方式の検証の実装（`@octokit/webhooks` の `verify` など）に値を渡して確かめる。宛先の検査（私的な IP、リダイレクト、DNS の再束縛）。インストールのトークンの 1 時間の失効と、部分集合への絞り込み。
- 互換の確認：公式の SDK と CLI の代表の操作（リポジトリ・Issue・PR の作成と一覧、Webhook の作成）を通す。

## 15. 段階ごとの変化

| 段階 | 変化 |
| --- | --- |
| S1 | REST・GraphQL・Webhook・App・OAuth アプリ（E7） |
| S2 | Enterprise の Webhook と API（E10）。hook-delivery を宛先のハッシュでシャードに分け、遅い宛先を隔てる |
| S3 | リポジトリのリージョンで事象を作り、そのリージョンの egress から送る。レート制限の割り当ては、主体のホームのリージョンで数え、他のリージョンは近似で数える（E11） |

## 16. 未解決の問い

設計の中で出た問いと、その決定。計測・PoC で決めるものは「持ち越し」に置く。

### 決定（2026-09-26、既定案）

- **ヘッダーの名前・トークンの接頭辞・メディアタイプ**：リポジトリ共通の [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md) で決着した。本家の名前を使わず、`<Brand>`・`<brand>` の置き換え用の名前で書き、実際の名前は開発リポジトリの作成時に決める。パスの形（`/repos/{owner}/{repo}/...`）は本家に寄せたままにする（名前を含まないため）。
- **Webhook の自動の再試行**：[ADR-0022](../decisions/0022-webhook-signing-and-delivery.md) のとおり行う。受け手は `X-<Brand>-Delivery` で重複を捨てる前提を文書に書く。
- **MCP のサーバー**：MVP の後の候補（[roadmap.md](../roadmap.md) の「後回しにしたもの」）。公開 API の上の薄い層にする（10 節）。
- **ユーザーのトークンのレート制限**（2026-09-26 の本家の確認による改訂）：App のユーザーのトークンも、PAT・OAuth アプリと合わせてユーザーで合算する（11.1 節）。以前の案の「App × ユーザーで別に数える」は採らない。
- **Webhook の版**：本家の Webhook は版を持たないが、本システムは Webhook ごとに REST の版を固定する（9.1 節。本家との違い）。

### 決定（2026-09-28、推奨案で確定）

- **GraphQL の実装**：Pothos ＋ GraphQL Yoga にする（5.1 節）。どちらも本家と関係のない第三者の部品で、TypeScript のコード優先のスキーマとして REST と同じサービス関数を呼べる。E7 の `graphql-foundation` の試作で問題が出たら、そのときに ADR を起票して見直す。

持ち越し：

| 項目 | いつ・どう決めるか |
| --- | --- |
| `429` にそろえたことで困るクライアントがないか（11.3 節） | E7 の `public-sdk-and-cli` で、主なクライアントの再試行の振る舞いを確かめる |

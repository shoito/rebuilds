# Tenants and Applications: Auth0

テナント、アカウント、メンバー、アプリケーション（クライアント）、API（リソースサーバー）、M2M の許可、設定のキャッシュと反映の設計。決定は [ADR-0030](../decisions/0030-accounts-tenants-and-members.md)（アカウント・テナント・メンバー）、[ADR-0031](../decisions/0031-application-and-api-registration.md)（アプリと API の登録）、[ADR-0032](../decisions/0032-tenant-config-cache.md)（設定のキャッシュ）にある。

テナントを分離の単位にすること、環境ごとに別のテナントにすること、リージョンに固定することは、[ADR-0002](../decisions/0002-tenancy-and-isolation.md) で決めた。この文書はその上に、テナントの中の設定の形と、その設定を認証の経路へ届ける方法を決める。

本家の振る舞いは、2026-09-27 に auth0.com/docs で確かめた。確かめられなかったものは「未検証」と書く。

## 1. 目的と範囲

| 範囲に含む | 範囲に含まない（担当の領域） |
| --- | --- |
| アカウント（請求と管理者のまとまり）、テナントの作成・名前・環境・削除 | テナントのデータの分離の方式（ADR-0002） |
| テナントのメンバー（ダッシュボードの管理者）と、ロールの割り当て | 管理者のログインと break-glass（[dashboard.md](dashboard.md)） |
| アプリケーションの種類、許可するグラント、コールバック・ログアウト・Web オリジンの URL | `redirect_uri` の照合の手順（[authentication-flows.md](authentication-flows.md)、ADR-0006） |
| クライアントの資格情報（秘密、公開鍵）の登録とローテーション | クライアントの認証の方式の検証（ADR-0007） |
| API（識別子、スコープ、トークンの有効期間の設定） | トークンのクレームと有効期間の範囲（ADR-0008） |
| M2M の許可（client grant） | Management API のスコープの一覧（[management-api-and-rate-limiting.md](management-api-and-rate-limiting.md)） |
| テナントの設定のキャッシュと反映、許す古さ | カスタムドメイン（custom-domains の領域） |

## 2. 本家の仕組み（確かめたこと）

| 項目 | 本家 | 出典 |
| --- | --- | --- |
| テナントの名前 | 小文字の英数字とハイフン。先頭と末尾にハイフン不可。3〜63 文字。作成後に変えられず、削除しても再利用できない。ドメイン `<name>.<locality>.auth0.com` の一部になる | [Create Tenants](https://auth0.com/docs/get-started/auth0-overview/create-tenants) |
| リージョン | AU・CA・EU・JP・UK・US。作成時に選ぶ | 同上 |
| 環境 | 環境ごとに別のテナントを作ることを勧める。環境のタグ（Development・Staging・Production）を付ける。本番のレート制限は Production のタグのテナントだけにかかる | [Set Up Multiple Environments](https://auth0.com/docs/get-started/auth0-overview/create-tenants/set-up-multiple-environments) |
| アプリの種類と公開・機密 | Native・SPA は公開（`token_endpoint_auth_method: none`）。Regular Web・M2M は機密。公開のアプリはクライアントクレデンシャルを使えない | [Application Grant Types](https://auth0.com/docs/get-started/applications/application-grant-types) |
| グラント | 標準（`authorization_code`、`client_credentials`、`refresh_token`、device code、`implicit`、`password`）、本家の拡張（MFA、password-realm など）、旧来のグラント | 同上 |
| コールバックの URL | 複数を登録できる。サブドメインのワイルドカード（`*`）を許すが、本番では勧めない。`{organization_name}` の置き換えもある | [Application Settings](https://auth0.com/docs/get-started/applications/application-settings)、[Subdomain URL Placeholders](https://auth0.com/docs/get-started/applications/wildcards-for-subdomains) |
| Web オリジン | 最大 100 件 | Application Settings |
| API | 識別子は作成後に変えられない。アクセストークンの有効期間の既定は 86,400 秒、最大 2,592,000 秒。RBAC、権限をトークンに入れる設定、オフラインアクセス（リフレッシュトークン）の許可、ファーストパーティの同意の省略 | [API Settings](https://auth0.com/docs/get-started/apis/api-settings) |
| M2M の許可 | client grant（アプリ × API × スコープ）。組織ごとの使い方の設定もある | Management API の OpenAPI（`POST /client-grants` の本文） |
| 件数の上限 | Enterprise：アプリ 100,000、API 100,000、client grant 100,000。セルフサービス：アプリ 100、API 100、client grant 10,000、接続 100。API あたりのスコープ 1,000、テナントあたりのロール 1,000 | [Entity Limit Policy](https://auth0.com/docs/troubleshoot/customer-support/operational-policies/entity-limit-policy) |
| メンバーのロール | Admin、Editor（Connections・Key Management・Organizations・Specific Apps・Users）、Viewer（Users・Config Settings）など | [Dashboard Access by Role](https://auth0.com/docs/get-started/manage-dashboard-access/feature-access-by-role) |
| 設定の反映の遅れ | 公開の資料に記述がない。**未検証** | — |

## 3. アカウントとテナント

### 3.1 形

```
account（請求・契約の単位。1 つの顧客の会社）
  ├── account_members（アカウントの管理者。請求とテナントの作成）
  └── tenants（環境ごと。region と environment は作成時に決め、変えない）
        ├── tenant_members（ダッシュボードの管理者。ロール付き）
        ├── clients（アプリケーション）── client_credentials（秘密・公開鍵）
        ├── resource_servers（API。スコープは列の配列）
        ├── client_grants（M2M の許可）
        └── 接続・ユーザー・鍵・ブランドなど（各領域）
```

- **アカウントは本家の「サブスクリプション」に近い。** 本家の資料でアカウントとテナントの関係（子のテナント、Teams）は確かめたが、内部のモデルは公開されていない。本システムは、請求とテナントの作成の権限をアカウントに置く（[ADR-0030](../decisions/0030-accounts-tenants-and-members.md)）。
- アカウントはテナントの外の表（RLS の外）に置く。テナントの作成・削除・一覧は、テナントをまたぐ処理として別の DB のロールで行う（ADR-0002）。

### 3.2 テナントの名前とホスト名

| 項目 | 規則 |
| --- | --- |
| 名前 | `^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$`（3〜63 文字）。リージョンの中で一意。作成後に変えない |
| 予約 | `admin`、`manage`、`www`、`api`、`auth`、`login`、`static`、`status`、`support`、`mail`、`<brand>` を含む名前、本システムが持つ監視用の名前。一覧は設定で持つ |
| 削除後 | 名前を再利用しない（本家と同じ）。`tenant_name_tombstones` に残す。他の顧客が同じ名前を取ると、古いアプリの設定（`issuer` が同じ）のまま別のテナントのトークンを信じてしまうため |
| ホスト名 | `<name>.jp.<brand>.<domain>`。`issuer` は `https://<name>.jp.<brand>.<domain>/`（カスタムドメインは custom-domains の領域） |

### 3.3 環境

- `environment` は `development`・`staging`・`production`。作成時に決める。**後から変えられるのは `development` → `staging` → `production` の昇格だけ** にする。本家はタグをいつでも変えられる。本システムでは、レート制限と SLO の対象が環境で決まるので、本番から下げて制限を逃れる使い方を防ぐ。
- 本番への昇格の前に、ダッシュボードで点検の一覧を示す（本番の URL に `localhost` がないか、ワイルドカードのコールバックがないか、カスタムドメインがあるか）。昇格そのものは止めない。
- 本番のテナントだけが NFR-001 の対象で、レート制限の値も本番の値になる（[management-api-and-rate-limiting.md](management-api-and-rate-limiting.md) の 6 節）。

### 3.4 テナントの状態

| 状態 | 意味 | 認証の経路 | 管理の経路 |
| --- | --- | --- | --- |
| `active` | 通常 | 動く | 動く |
| `suspended` | 未払い・濫用・法的な要請で止めた | 403 のエラーの画面。トークンの発行を止める。JWKS は配り続ける（発行済みのトークンの検証は、テナントの API の側で続く） | 読み取りだけ |
| `deleting` | 削除の猶予（30 日。[ADR-0055](../decisions/0055-data-retention-and-deletion.md)） | 404 | 復元の操作だけ |

状態の遷移は、プラットフォームの監査に残す（[ADR-0054](../decisions/0054-audit-log.md)）。

### 3.5 メンバー

- メンバーは、ダッシュボードの管理用のテナント（[dashboard.md](dashboard.md)）のユーザーである。テナントのエンドユーザーとは別の人の集まりで、テナントをまたいで属しうる（ADR-0002）。
- `tenant_members`（`tenant_id`、`member_user_id`、`roles`、`app_ids`（アプリを限るロールのとき）、`invited_by`、`created_at`）。
- 招待はメールで送る。招待のトークンは 256 ビットの乱数で、SHA-256 だけを持つ（ADR-0004）。有効 7 日。受ける人は、招待のメールアドレスと同じ確認済みのメールアドレスで、管理用のテナントにログインしている必要がある。
- ロールの一覧と権限は [dashboard.md](dashboard.md) の 5 節にある。**最後の `admin` は外せない。** 本家は管理者を 2 人以上置くことを勧めている（[Manage Dashboard Access](https://auth0.com/docs/get-started/manage-dashboard-access)）。本システムは、本番のテナントで `admin` が 1 人のとき、ダッシュボードに警告を出す。

## 4. アプリケーション

### 4.1 種類とグラント

アプリの種類（`app_type`）は、クライアントの認証の方式と、許すグラントの上限を決める。

| `app_type` | 公開・機密 | `token_endpoint_auth_method` | 許すグラント（上限） | 既定で有効 |
| --- | --- | --- | --- | --- |
| `spa` | 公開 | `none` | `authorization_code`、`refresh_token` | 両方 |
| `native` | 公開 | `none` | `authorization_code`、`refresh_token`、device code | `authorization_code`、`refresh_token` |
| `regular_web` | 機密 | `client_secret_basic`・`client_secret_post`・`private_key_jwt` | `authorization_code`、`refresh_token`、`client_credentials` | `authorization_code`、`refresh_token` |
| `m2m` | 機密 | 同上 | `client_credentials` | `client_credentials` |

- `implicit`、`password`、本家の拡張のグラント、旧来のグラントは持たない（intent の Non-goals、RFC 9700）。
- device code は `native` だけ（本家と同じ）。入力の限られた端末のアプリは `native` として登録する。
- 本家は機密のアプリの既定で `implicit` と `client_credentials` を有効にする。本システムは、使わないグラントを既定で無効にする。
- 種類は作成後に変えられない。公開と機密を行き来させると、秘密の有無とグラントの整合が崩れるため。変えたいときは作り直す。

### 4.2 URL の登録

| 項目 | 上限 | 規則 |
| --- | --- | --- |
| `callbacks`（`redirect_uri`） | 100 件 | 完全一致だけで照合する（ADR-0006）。スキームは `https`。`http` は `localhost`・`127.0.0.1`・`[::1]` だけ。ネイティブのアプリのカスタムスキーム（`com.example.app:/cb`）は、逆ドメインの形だけを許す（RFC 8252 の 7.1 節）。フラグメント（`#`）不可 |
| `allowed_logout_urls` | 100 件 | 同上 |
| `web_origins` | 100 件（本家と同じ） | オリジンだけ（パス・クエリなし） |
| `allowed_origins`（CORS） | 100 件 | 同上 |
| `initiate_login_uri` | 1 件 | `https` だけ |

- **ワイルドカードを持たない。** 本家はサブドメインの `*` を許し、本番では勧めていない。本システムは、`redirect_uri` の完全一致（ADR-0006）と矛盾するので、どの環境でも受け付けない。本家から移るテナントには、移行の文書で具体的な URL を並べるよう案内する。
- `{organization_name}` の置き換えは、Organizations の Epic（E14）で足す（[organizations.md](organizations.md) の 5 節）。
- 本番のテナントでは、`localhost` とループバックの URL を登録すると警告を出す。拒否はしない（本番のテナントを開発に使うことがあるため。本家も警告に留める）。

### 4.3 資格情報

- 秘密（`client_secret_*`）は 2 つまで同時に有効にする（ADR-0007）。作成とローテーションの時に 1 回だけ表示し、SHA-256 だけを持つ（ADR-0004）。
- 秘密の形は `<brand>_cs_` ＋ 256 ビットの乱数（base62）＋ CRC32 のチェックサム。シークレットスキャンに登録する（リポジトリ共通の ADR-0006）。
- 公開鍵（`private_key_jwt`）は 2 つまで。PEM か JWK で受け、`kid` を付ける。
- ローテーションの流れ：新しい秘密を足す → アプリを切り替える → 古い秘密を失効させる。古い秘密の最終の使用の時刻を記録し、ダッシュボードで見せる（使われなくなったことを確かめてから消せるように）。
- シークレットスキャンの通報を受けたら、その秘密を自動で失効させ、テナントの管理者に知らせる（手順は runbook の `leaked-client-secret`）。

### 4.4 その他の属性

| 属性 | 既定 | 備考 |
| --- | --- | --- |
| `is_first_party` | 真 | 偽（サードパーティ）のアプリは同意の画面を必ず出す（universal-login の領域）。サードパーティのアプリは、本家と同じく PKCE を必須にし、`client_credentials` は機密のアプリだけ |
| `require_pkce` | 真 | ADR-0006 |
| `refresh_token` | ローテーションあり | 有効期間と猶予は ADR-0003・ADR-0008 |
| `oidc_backchannel_logout` | なし | sessions-and-sso の領域 |
| `client_metadata` | 空 | 文字列の値だけ。キー 10 件、値 255 文字（本家と同じ。Management API の OpenAPI の `ClientMetadata`、2026-09-27 に確認） |
| `organization_usage` | `deny` | E14 で有効（[organizations.md](organizations.md)） |

## 5. API（リソースサーバー）

| 項目 | 規則 |
| --- | --- |
| `identifier` | `aud` に入る値。URI（`https://...` か `urn:...`）。テナントの中で一意。作成後に変えない（本家と同じ）。本システムの予約の URL（`https://<tenant host>/api/v2/`、userinfo の URL）は登録できない |
| `scopes` | `^[a-zA-Z0-9:_.\-]{1,280}$`。1 つの API に 1,000 まで（本家と同じ） |
| `token_lifetime` | ADR-0008 の範囲 |
| `signing_alg` | テナントの鍵のアルゴリズム（ADR-0003）。API ごとに HS256 は選べない |
| `allow_offline_access` | 偽。真のとき、この API への要求で `offline_access` のスコープがあればリフレッシュトークンを出す |
| `skip_consent_for_first_party` | 真 |
| `enforce_rbac`、`token_dialect` | RBAC は MVP の後（本システムの MVP の範囲にない）。`permissions` のクレームは RBAC とともに足す |

**Management API も、各テナントの API の 1 つとして持つ。** 識別子は `https://<tenant host>/api/v2/` で、テナントの作成時に作る。削除・変更はできない。スコープは [management-api-and-rate-limiting.md](management-api-and-rate-limiting.md) の 4 節にある。

## 6. M2M の許可（client grant）

```
client_grants(tenant_id, id, client_id, audience, scope[], subject_type, created_at)
UNIQUE (tenant_id, client_id, audience, subject_type)
```

- `client_credentials` の要求は、`client_id` と `audience` の組の許可があるときだけ通る。要求の `scope` は許可の `scope` の部分集合に切り詰める。`scope` を省いた要求には、許可のすべてを出す（本家と同じ振る舞い。本家の資料で確かめたのは Management API の OpenAPI の本文の形まで。切り詰めの振る舞いは**未検証**）。
- `subject_type` は `client`（MVP）。`user`（利用者の委任のアクセスの許可、本家の最近の拡張）は持たない。
- 許可のスコープは、API に登録されたスコープの部分集合でなければならない。API からスコープを消したら、そのスコープを含む許可から自動で外し、監査に残す。
- 許可の削除は、次のトークンの発行から効く。発行済みの JWT は期限まで有効（ADR-0003）。Management API は、受けたトークンの許可が今もあるかを要求ごとに確かめる（[ADR-0034](../decisions/0034-management-api-authorization.md)）。
- 許可を作る・変える・消すと、`audit_events` に残す（ADR-0054）。

## 7. 設定のキャッシュと反映

認証の経路は、テナントの設定（アプリ、API、許可、接続、ブランド、鍵の公開部分）を要求のたびに DB から読まない。各タスクのメモリーに版付きで持ち、DB が読めない間は最後の版で動く（ADR-0005）。その仕組みと、許す古さを決める（[ADR-0032](../decisions/0032-tenant-config-cache.md)）。

### 7.1 版

- テナントごとに `tenant_config_versions(tenant_id, version bigint, updated_at)` を持つ。設定の表を変えるトランザクションは、同じトランザクションで `version` を 1 増やす（トリガーではなく、リポジトリの層で必ず呼ぶ。CI で、設定の表への書き込みが版を上げていることを検査する）。
- 同じトランザクションで outbox に `tenant.config_changed {tenant_id, version}` を入れる。

### 7.2 読み込み

```
要求 → ホスト名 → tenant_id（ホスト名の表。全件をメモリーに持つ。ADR-0002）
     → config_cache.get(tenant_id)
          ├─ あり、かつ version が既知の最新と同じ → そのまま使う
          ├─ あり、古い → 裏で読み直す（single-flight）。読み直しの間は古い版を使う
          └─ なし → DB（reader）から組み立てて入れる。読めなければ 503
```

- スナップショットは、テナントの設定を 1 つの不変のオブジェクトに組み立てたもの（Zod で検証した型）。部分の更新はしない。組み立てたスナップショットは、そのテナントの設定の版と対にする。
- **全テナントを常に持たない。** S1 のテナント 1 万のうち、よく使われる本番のテナントは少数と見込む。タスクごとに LRU（既定 5,000 テナント、または 1 GiB）で持つ。本番のテナントのうち、直近 24 時間に要求のあったものは、タスクの起動時に先に読み込む。
- 1 つのテナントのスナップショットの大きさの上限は 2 MiB。アプリ・接続の件数の上限（本家に合わせた 100 件など）の中では超えない見込み。超えるテナントは、個別に扱う（大口のテナントの専用の構成。S2）。

### 7.3 反映の通知

| 経路 | 遅れ | 働き |
| --- | --- | --- |
| Valkey の pub/sub（`cfg:changed`）。Relay が outbox から流す | 通常 1 秒未満 | 主な経路 |
| 版の表のポーリング（5 秒ごとに `updated_at > 前回` を読む） | 5 秒以内 | pub/sub の取りこぼし、Valkey の障害 |

- Valkey の pub/sub は届く保証がない。ポーリングで補う。ポーリングは reader に 1 秒 1 回以下（タスク数 × 0.2 回/秒。S1 の auth のタスク 60 で 12 回/秒）の軽い問い合わせで、インデックス `(updated_at)` を使う。
- **許す古さ**：通常、変更のコミットから全タスクへの反映まで p99 5 秒、最大 15 秒（ポーリングの間隔 ＋ 組み立ての時間 ＋ reader の遅れ）。ダッシュボードと API の文書に「反映まで最大 15 秒」と書く。
- **DB が読めない間**：新しい変更もコミットできない（正本が同じ DB）ので、手持ちの版は古くならない。期限を切らずに最後の版で動き続ける。reader の遅れ（Aurora のレプリカの遅延）が 15 秒を超えたら、ポーリングを writer に切り替える。
- **安全に関わる変更**（クライアントの秘密の失効、アプリの削除、許可の削除、コールバックの削除）も、同じ経路で反映する。15 秒の間は古い設定で通りうる。これを受け入れる理由と、受け入れない場合の案は ADR-0032 にある。Management API（管理の経路）は、キャッシュではなく要求ごとに DB を読む。

### 7.4 鍵とホスト名

- 署名鍵の公開部分（JWKS）は、discovery・JWKS の書き出し（ADR-0005）と同じ版で更新する。
- ホスト名 → `tenant_id` の表は、全件（S1 で 1 万＋カスタムドメイン）をメモリーに持つ。同じ通知で更新する。**表にないホスト名は、DB に問い合わせずに 404 にする**（ADR-0002、AGENTS.md の「テナントの解決の前に DB を読まない」）。
- このため、作成したテナントのホスト名は、表への反映（最大 15 秒）まで 404 になる。テナントの作成の API は、応答に `hostname_ready_by`（コミットの時刻 ＋ 15 秒）を入れる。ダッシュボードのクイックスタートは、その時刻まで待ってから最初のログインを案内する。

## 8. 障害のとき

| 事象 | 振る舞い |
| --- | --- |
| Aurora の reader が落ちた | writer から読む（ADR-0005）。キャッシュにあるテナントは影響なし |
| Aurora 全体が読めない | キャッシュにあるテナントは最後の版で動く。キャッシュにないテナントは 503。タスクの再起動を避ける（スケールインを止める） |
| Valkey が落ちた | 通知がポーリングだけになる（最大 15 秒） |
| 組み立てに失敗した（設定の不整合、Zod の検証の失敗） | 古い版を使い続け、`config_build_failures_total` を上げてアラート。新しいテナントなら 503。不整合を作った変更は、Management API の検証の漏れとして直す |
| 反映の遅れ | ダッシュボードの「反映まで最大 15 秒」の表示。15 秒を超える遅れを SLI として計る |

## 9. セキュリティ

- テナントをまたぐ参照を作らない。`clients`・`resource_servers`・`client_grants` はすべて `tenant_id` を先頭に持ち、RLS をかける（ADR-0002）。`client_id` は全体で一意の乱数（`<brand>` の接頭辞なし、32 文字の base62）にするが、照合は必ず `(tenant_id, client_id)` で行う。
- キャッシュのスナップショットに、秘密（クライアントの秘密のハッシュを除く）と、接続の秘密の平文を入れない。接続の秘密は、使う瞬間に復号する（ADR-0004）。
- テナントの名前の再利用の禁止（3.2 節）で、古い `issuer` を信じるアプリへのなりすましを防ぐ。
- コールバックのワイルドカードを持たない（4.2 節）。
- 本番のテナントの `localhost` のコールバック、`is_first_party: false` で同意を省く設定、`client_credentials` で Management API の全スコープを持つ許可は、ダッシュボードの「セキュリティの点検」に出す。

## 10. テスト

- 性質ベーステスト：任意の設定の変更の列について、最後の変更のコミットから 15 秒後に、すべてのタスクのスナップショットの版が DB の版と一致する（Valkey の通知を落とす障害を含めて）。
- 性質ベーステスト：任意の 2 テナントについて、一方のホスト名の要求が、他方のスナップショットを返さない。
- 表駆動テスト：4.1 節の種類 × グラント × 認証の方式の表。登録できる組とできない組。
- 表駆動テスト：4.2 節の URL の規則（ワイルドカード、`http` の非ループバック、フラグメント、カスタムスキーム）。
- 結合テスト：client grant を消すと、次の `client_credentials` の要求が `unauthorized_client` になり、Management API の呼び出しが 403 になる。
- 結合テスト：Aurora を止めても、キャッシュにある本番のテナントのクライアントクレデンシャルが通る（ADR-0005 の障害の注入と共通）。
- 結合テスト：削除したテナントの名前で新しいテナントを作れない。
- CI：設定の表に書く関数が、版を上げる関数を呼んでいるかを静的に検査する。

## 11. この領域の ADR

| ADR | 決定 |
| --- | --- |
| [0030](../decisions/0030-accounts-tenants-and-members.md) | テナントの上にアカウントを置き、請求とテナントの作成をまとめる。テナントの名前は再利用せず、環境は昇格だけを許す |
| [0031](../decisions/0031-application-and-api-registration.md) | アプリの種類でクライアントの認証とグラントの上限を決め、コールバックはワイルドカードなしの完全一致にする。M2M はアプリ × API の許可で守る |
| [0032](../decisions/0032-tenant-config-cache.md) | テナントの設定は版付きの不変のスナップショットでタスクに持ち、pub/sub とポーリングで最大 15 秒で反映する |

## 12. Story の候補

| Epic | Story の候補 |
| --- | --- |
| E1 | アカウント・テナント・メンバーの表と RLS、テナントの名前の規則と予約の一覧 |
| E2 | テナントの作成（アカウントから）、環境、状態（`active`・`suspended`・`deleting`） |
| E2 | アプリの登録（種類・グラント・URL の規則）、資格情報（秘密 2 つ、公開鍵 2 つ）のローテーション |
| E2 | API の登録とスコープ、Management API の API をテナントの作成時に作る |
| E2 | client grant と `client_credentials` の許可の判定 |
| E2 | 設定のスナップショット、版、pub/sub とポーリングの反映、LRU と起動時の先読み |
| E3 | 認証の経路での設定のキャッシュの利用（`/authorize`・`/oauth/token` が DB を読まずに動く） |
| E9 | メンバーの招待とロールの割り当て、本番の点検の一覧、秘密の最終の使用の表示 |
| E12 | 反映の遅れの SLI、Aurora 停止時のキャッシュの振る舞いの障害の注入 |
| E14 | `organization_usage`、`{organization_name}` の置き換え（[organizations.md](organizations.md)） |

## 13. 未解決の問い

- 安全に関わる設定の変更（秘密の失効、アプリの削除）で、15 秒の反映の遅れを受け入れてよいか。受け入れないなら、`/oauth/token` で秘密の照合だけ DB を読む案がある（ADR-0005 の同期の依存が増える）。
- 作成の直後のテナントのホスト名が最大 15 秒 404 になることを、K3（最初のログインまで中央値 15 分）の体験として許すか。
- アカウントとテナントの関係を、本家の「子のテナント」のように請求の単位で強く結ぶか。請求の設計（まだない）で決める。
- 本家のワイルドカードのコールバックを使うテナントの移行を、どこまで支えるか。
- 本家の `scope` の切り詰めの振る舞い（6 節）を試用のテナントで確かめる。

### 決定

2026-09-27 の既定案。

- 安全に関わる変更も、最大 15 秒の反映で受け入れる。DB を同期で読む経路は足さない。秘密の漏えいのときは、秘密の失効とアプリの一時的な無効化を runbook で案内する。どちらも反映は最大 15 秒である。
- 表にないホスト名は、作成の直後でも DB に問い合わせずに 404 にする。作成の応答に `hostname_ready_by` を入れ、ダッシュボードが待つ。15 秒は K3 の 15 分に比べて小さい。
- コールバックのワイルドカードは、どの環境でも持たない。

### 決定（2026-09-27、推奨案で確定）

- **アカウントと請求**：アカウントを請求・契約の単位にし、テナントはその下に置く（[ADR-0030](../decisions/0030-accounts-tenants-and-members.md) の形のまま）。本家の「子のテナント」のような別の結び付けは足さない。請求の細部は、請求の設計で扱う。
- **ワイルドカードのコールバックを使うテナントの移行**：URL を 1 つずつ登録してもらう（100 件まで）。移行の文書で案内し、それ以上の支えは作らない（[authentication-flows.md](authentication-flows.md) の 14 節）。

## 14. quality.md・runbooks・data-model に載せるもの

**quality.md**

- リスク：設定の反映の遅れと取りこぼし（古い設定で認証が通る）。性質ベーステストと、本番の反映の遅れの SLI で見る。
- 表駆動テストの対象：アプリの種類 × グラント × 認証の方式、URL の規則。
- 本番での検証：合成監視のテナントで、設定を変えてから反映までの時間を 5 分ごとに測る。

**runbooks**

- `config-propagation-lag`：反映の遅れが 15 秒を超えた。pub/sub・ポーリング・reader の遅れを順に確かめる。
- `leaked-client-secret`：シークレットスキャンの通報、または漏えいの疑い。秘密の失効、アプリの一時的な無効化、テナントへの連絡。
- `tenant-suspend-and-restore`：テナントの停止と復元の手順と承認。
- SLI の追加の依頼（Ops へ）：`config_propagation_seconds`（p99）、`config_build_failures_total`、キャッシュのヒット率。

**data-model**

| テーブル | 主な列 | 備考 |
| --- | --- | --- |
| `accounts` | `id`、`name`、`billing_ref`、`created_at` | RLS の外 |
| `account_members` | `account_id`、`member_user_id`、`role`（`owner`・`billing`） | RLS の外 |
| `tenants` | `id`、`account_id`、`name`、`region`、`environment`、`status`、`created_at`、`deleted_at` | RLS の外（テナントの解決に使う） |
| `tenant_name_tombstones` | `region`、`name`、`deleted_at` | 再利用の禁止 |
| `tenant_members` | `tenant_id`、`member_user_id`、`roles`、`app_ids`、`invited_by` | RLS |
| `tenant_member_invitations` | `tenant_id`、`id`、`email`、`roles`、`token_hash`、`expires_at` | RLS |
| `clients` | `tenant_id`、`client_id`、`app_type`、`name`、`grant_types`、`token_endpoint_auth_method`、`callbacks`、`allowed_logout_urls`、`web_origins`、`allowed_origins`、`is_first_party`、`require_pkce`、`refresh_token`、`client_metadata`、`legacy_token_endpoint_aud`（`private_key_jwt` の `aud` の互換のフラグ。既定は偽、GA から 12 か月で廃止。[authentication-flows.md](authentication-flows.md) の 6.1 節）、`status` | RLS |
| `client_credentials` | `tenant_id`、`id`、`client_id`、`kind`（`secret`・`public_key`）、`secret_hash`、`jwk`、`kid`、`created_at`、`expires_at`、`last_used_at`、`revoked_at` | RLS。クライアントの秘密と `private_key_jwt` の公開鍵の唯一の表（authentication-flows の提案した `client_secrets`・`client_public_keys` はこの表にまとめた）。有効なものは種類ごとに 2 つまで |
| `resource_servers` | `tenant_id`、`id`、`identifier`、`name`、`scopes`、`token_lifetime`、`allow_offline_access`、`skip_consent_for_first_party`、`is_system` | RLS。`is_system` は Management API |
| `client_grants` | `tenant_id`、`id`、`client_id`、`audience`、`scope`、`subject_type` | RLS |
| `tenant_config_versions` | `tenant_id`、`version`、`updated_at` | RLS の外（ポーリングは全テナントを読む）。値は版だけで、設定の中身を持たない |

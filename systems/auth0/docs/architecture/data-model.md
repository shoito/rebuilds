# Data model: Auth0

データモデルの索引。テナントの分け方は [ADR-0002](../decisions/0002-tenancy-and-isolation.md)、トークンと署名鍵は [ADR-0003](../decisions/0003-token-formats-and-signing-keys.md)、資格情報の保存は [ADR-0004](../decisions/0004-credential-storage.md)、認証の経路の縮退は [ADR-0005](../decisions/0005-authentication-path-availability.md) に従う。**各テーブルの定義の正本は、下の索引の「定義の場所」にある文書** で、ここは置き場所・横断の規則・テナントの外の表・索引と、複数の領域が列を足す表の統合した定義を書く。実装の変更（`changes/`）でマイグレーションを書くときに、ここと各文書を合わせて更新する。

2026-09-27 の統合の工程で、全領域の文書の「data-model への項目」と照合した。統合で決めたこと（重なりの解消、名前の規則）は 8 節にまとめた。

## 1. 置き場所

| 置き場所 | 中身 |
| --- | --- |
| Aurora PostgreSQL（主。prod。東京が主、大阪は Global Database の二次） | 唯一の正本。テナントの設定、ユーザー、資格情報、セッション、トークン、署名鍵の暗号文、監査ログ（1 年）、outbox |
| Aurora PostgreSQL（ログ。prod。大阪は headless の二次） | 認証のイベントのログ（`logs`）と、Action の実行の記録（MVP の後）。取り込みの日ごとのパーティション、31 日（[ADR-0043](../decisions/0043-log-storage-and-search.md)）。主のクラスタと接続プールもロールも分ける |
| Valkey | キャッシュと数（セッションのキャッシュ、レート制限、攻撃の防御の数、`client_assertion` の `jti`、設定の変更の pub/sub）。失ってよい（ADR-0005） |
| 各タスクのメモリー | テナントの設定のスナップショット（版つき。[ADR-0032](../decisions/0032-tenant-config-cache.md)）、ホスト名 → テナントの対応表（[ADR-0039](../decisions/0039-hostname-resolution-and-issuer.md)）、Signer の復号した鍵（[ADR-0063](../decisions/0063-cpu-bound-work-sizing.md)）、pepper、漏えいしたパスワードの範囲の LRU |
| S3（prod） | テナントのホスト名ごとの discovery・JWKS、Universal Login の静的な資産とロゴ、漏えいしたパスワードのデータ（自前のホストは法務の確認の後。[ADR-0025](../decisions/0025-breached-password-detection.md)）、ユーザーのインポート・エクスポートのファイル（MVP の後）、認証のイベントの調査用の Parquet（90 日） |
| S3（log-archive、Object Lock） | 監査ログのアーカイブ（ハッシュの連鎖、7 年）、認証のイベントの保管（DR のやり直しの材料）、CloudTrail、CloudFront・WAF のログ、pepper の暗号文の予備 |
| S3（actions のアカウント。MVP の後） | Action の束（`sha256` 付き。[ADR-0049](../decisions/0049-extensibility-execution-isolation.md)） |
| Secrets Manager | pepper の暗号文、基盤の秘密（DB の資格情報、外部の提供者の鍵、合成監視の資格情報） |

- 開発・ステージング・本番のテナントは、同じクラスタに `tenants.environment` の違いで入る（ADR-0002。Stripe のように環境でクラスタを分けない）。

## 2. 横断の規則

- **テナントテーブルは `tenant_id` を持ち、主キーとインデックスの先頭に置く。** ID は UUIDv7。`FORCE ROW LEVEL SECURITY` と、トランザクションごとの `SET LOCAL app.tenant_id`（ADR-0002）。ログのクラスタも同じ規則。
- **外部キーは `tenant_id` を含む複合キーにする。** 別のテナントの行を参照するデータは DB が拒否する。
- **テナントの解決の前に、テナントテーブルを読まない。** 解決に使う表（`tenants`、`tenant_hostnames`）は RLS の外に置き、読み取り専用の関数だけで読む（3 節）。
- **ユーザーを指す列の名前を揃える**（統合で決めた）。ユーザーを参照する列は、内部の主キー `users.id`（UUIDv7）を持ち、名前は `user_pk` にする。`user_id` は外に出す値（`sub`。`usr_...` かインポートで指定した値）の列の名前で、`users` と、外へ出す記録（認証のイベントの `logs`）だけが持つ。規約への同意の `consent_records` も `user_pk` で参照する（2026-09-27 に揃えた。ADR-0013）。各領域の文書で参照の列を `user_id` と書いた箇所は、統合で `user_pk` に揃えた（authentication-flows、sessions-and-sso、organizations）。
- **秘密の列の型を決める**（ADR-0004）。

  | 種類 | 列 | 例 |
  | --- | --- | --- |
  | 人の選ぶ秘密・低エントロピーの秘密 | `*_hash`（PHC 形式の文字列。Argon2id＋pepper の版） | `password_credentials.password_hash`、`recovery_codes.code_hash`、`credential_tickets.secret_hash`（6 桁のコード） |
  | 短いコードの鍵付きハッシュ | `*_hmac`（HMAC-SHA-256、pepper） | `otp_challenges.code_hmac` |
  | 高エントロピーの秘密 | `*_hash`（SHA-256、`bytea`） | `authorization_codes.code_hash`、`refresh_tokens.token_hash`、`client_credentials.secret_hash`、`sessions.secret_hash`、`login_transactions.handle_hash`、`credential_tickets.secret_hash`（リンク） |
  | 戻す必要のある秘密 | `*_ciphertext`（AES-256-GCM、AAD 付き）と DEK の版 | `totp_secrets.secret_ciphertext`、`connections.secrets_ct`、`idp_tokens.ciphertext`、`log_streams.sink_ciphertext`、`email_providers.secret_ct`、`action_secrets.ciphertext` |
  | 署名の秘密鍵 | `*_ciphertext`（Signer だけが復号できる。`<brand>-signing-keys`） | `signing_keys.private_key_ciphertext`、`external_idp_keys.private_key_ciphertext` |

  マイグレーションの CI で、`password`・`secret`・`token`・`code`・`seed`・`private_key` を含む名前の列が、上のどれかの型であることを確かめる（[delivery.md](delivery.md) の 2.1 節）。既存の名前の `secrets_ct`・`secret_ct` は `*_ciphertext` と同じ扱いにする（新しい列は `*_ciphertext` にする）。
- **個人データの列に、分類と保持の区分の注記を付ける**（マイグレーションの lint。[ADR-0055](../decisions/0055-data-retention-and-deletion.md)）。
- **時間で消える表は、時間のパーティションで持ち、`DROP` で消す**（認可コード、ログインのトランザクション、デバイスコード、outbox、`email_outbox`、認証のイベント、監査ログ）。
- **DB のロール**：

  | ロール | 使うサービス | 権限 |
  | --- | --- | --- |
  | `migrator` | マイグレーション | 所有者 |
  | `auth_app` | Auth | RLS の対象。`BYPASSRLS` なし。解決の関数の実行 |
  | `mgmt_app` | Management API | RLS の対象。テナントの外の表のうち、書き込みの関数（テナントの作成、`tenant_hostnames` の遷移）だけを実行できる |
  | `worker` | Worker | RLS の対象。ジョブごとにテナントのコンテキストを設定する |
  | `signer` | Signer | `signing_keys`・`signing_key_state_versions`・`signing_key_issuers`・`external_idp_keys` の SELECT と、`signing_keys.last_used_at` の UPDATE だけ（[ADR-0059](../decisions/0059-signer-isolation.md)） |
  | `relay` | Relay | `outbox`・`email_outbox` の読み取りと送信済みの印だけ（3 節） |
  | `platform` | テナントをまたぐ管理の処理（テナントの作成・削除、保持のジョブ、課金の集計） | RLS を迂回できる。操作はプラットフォームの監査へ |
  | `log_ingest`・`log_reader`（ログのクラスタ） | 取り込み・検索・ストリームの送り手 | RLS の対象。書き手は行ごとの `tenant_id` を `WITH CHECK` で確かめる |

## 3. RLS の例外（テナントの外の表）

RLS を掛けない表の全部。**ここにない表は、すべて `tenant_id` と RLS を持つ。** マイグレーションの CI の許可リスト（ADR-0002 の Confirmation）は、この表と一致させる。追加するときは、この表と [security.md](security.md) を合わせて更新し、Dev のテックリードとセキュリティの担当の承認を得る（`security:sensitive`）。

| テーブル | RLS の外に置く理由 | 読める主体 | 書ける主体 | 定義の場所 |
| --- | --- | --- | --- | --- |
| `accounts`、`account_members` | テナントの上の単位（請求・契約）。1 つのアカウントが複数のテナントを持つ | `mgmt_app`（関数経由、自分のアカウントだけ）、`platform` | `platform` | [tenants-and-applications.md](tenants-and-applications.md) の 14 節、[ADR-0030](../decisions/0030-accounts-tenants-and-members.md) |
| `tenants` | テナントの解決と、テナントのコンテキストを決める前の読み取りに使う（名前・環境・状態・リージョン）。秘密を持たない | 解決の関数、`platform` | `platform` | 同上 |
| `tenant_name_tombstones` | 名前の再利用の禁止を、テナントをまたいで確かめる。行は名前と削除の日時だけ | 作成の関数 | `platform` | 同上 |
| `tenant_hostnames` | **ホスト名 → テナントの解決はテナントの決定の前に行う**（DB を読む前のメモリーの対応表の正本）。ホスト名の一意はテナントをまたぐ | 解決の関数（起動時の全件の読み込みと差分） | `mgmt_app` の遷移の関数だけ | 5.3 節、[custom-domains.md](custom-domains.md) の 3.1 節、[ADR-0039](../decisions/0039-hostname-resolution-and-issuer.md) |
| `tenant_config_versions` | 全タスクが全テナントの版を 5 秒ごとにポーリングで読む。値は版と時刻だけで、設定の中身を持たない | 全タスク | 設定を書くトランザクション（関数） | [tenants-and-applications.md](tenants-and-applications.md) の 7.1 節、[ADR-0032](../decisions/0032-tenant-config-cache.md) |
| `outbox`、`email_outbox` | Relay が全テナントの行を順に読んで SQS へ移す。行は `tenant_id` を持つが、Relay にテナントのコンテキストはない。`outbox` の本文に秘密を入れない。`email_outbox` の秘密（コード、リンク）は暗号文で、送信の後に消す | `relay` | 各サービス（業務のトランザクションの中で。`WITH CHECK` で自分のテナント） | 4.13 節、[email-delivery.md](email-delivery.md) の 4 節 |
| `pepper_versions` | pepper はテナントに属さない | `auth_app`、`mgmt_app` | `platform` | [keys-and-secrets.md](keys-and-secrets.md) の 14 節 |
| `breached_password_versions` | プラットフォームのデータセットの版 | `auth_app`、`worker` | `worker`（取り込みのジョブ） | [attack-protection.md](attack-protection.md) の 5.2 節 |
| `rate_limit_overrides` | Ops が扱う上書き。全タスクが読む | 全タスク（読み取り） | `platform`（Ops の承認） | [management-api-and-rate-limiting.md](management-api-and-rate-limiting.md) の 8 節 |
| `mgmt_api_deprecations` | 本システムの設定（テナントに属さない） | `mgmt_app` | `migrator` | 同上の 15 節 |
| `platform_audit_events` | プラットフォームの判断と運用者の操作。テナントをまたぐ操作と、`tenant_id` のない操作を含む | `platform`、監査のロール | 各サービス（追記だけ） | 5.4 節、[ADR-0054](../decisions/0054-audit-log.md) |
| `break_glass_tokens` | 運用者の非常用のトークンの発行の記録（トークンは保存しない） | `platform` | 非常用の CLI | [dashboard.md](dashboard.md) の 13 節 |
| `dashboard_preferences` | 管理者（管理用のテナントのユーザー）は複数のテナントに属する | `mgmt_app`（本人の行だけ。関数経由） | 同左 | 同上 |
| `legal_holds` | テナント単位の削除の停止。保持のジョブがテナントをまたいで読む | `platform`、保持のジョブ | `platform`（法務の指示） | 5.4 節、[ADR-0055](../decisions/0055-data-retention-and-deletion.md) |
| `dr_replay_runs` | DR の後のやり直しの記録。範囲は全テナント | `platform` | DR のジョブ | 5.4 節、[ADR-0060](../decisions/0060-disaster-recovery-and-stages.md) |
| `log_shard_state`（ログのクラスタ） | ログの書き手の採番の状態。シャードは複数のテナントを含む | `log_ingest` | `log_ingest` | [logs-and-streams.md](logs-and-streams.md) の 13 節 |
| `log_stream_notify`（ログのクラスタ） | 送り手に「どのテナントに新しいログがあるか」を知らせる。行はシャード・`tenant_id`・最大の `log_id` だけで、ログの中身を持たない。送り手はこれを見てから、そのテナントのコンテキストで `logs` を読む | `log_reader`（送り手） | `log_ingest` | 同上 |

- `custom_domains` はテナントテーブル（RLS）だが、ホスト名の一意の部分索引（`status` が有効なもの）はテナントをまたいで効く。索引は RLS の外にあり、書き込みは `mgmt_app` の遷移の関数だけ（[custom-domains.md](custom-domains.md) の 3.1 節）。
- 運用者の期限つきの権限（JIT）の割り当ての正本は IAM Identity Center で、DB に持たない（[ADR-0056](../decisions/0056-operator-access.md)）。

## 4. 領域ごとの索引

「段階」の列：MVP ＝ S1 の MVP で作る。後 ＝ MVP の後（Epic は [roadmap.md](../roadmap.md)）。

### 4.1 テナント・アプリケーション・API

| テーブル | 中身 | 段階 | 定義の場所 |
| --- | --- | --- | --- |
| `accounts`、`account_members` | 請求と管理者の権限をまとめるテナントの上の単位（RLS の外） | MVP | [tenants-and-applications.md](tenants-and-applications.md) の 14 節、[ADR-0030](../decisions/0030-accounts-tenants-and-members.md) |
| `tenants` | `region`、`environment`、`status`、名前。他の領域が足す列：`session_idle_minutes`・`session_absolute_minutes`・`session_persistent`（[sessions-and-sso.md](sessions-and-sso.md) の 14 節）、`log_retention_days`（[logs-and-streams.md](logs-and-streams.md) の 13 節）、`webauthn_rp_id`（[mfa-and-passkeys.md](mfa-and-passkeys.md) の 5.2.1 節）。テナントの設定（`mfa_policy`、`attack_protection`、`account_linking`、`org_name_in_tokens` など）は `settings`（jsonb、Zod で検証）に持つ（RLS の外） | MVP | 同上 |
| `tenant_members`、`tenant_member_invitations` | ダッシュボードの管理者とロール、招待（トークンは SHA-256） | MVP | 同上、[dashboard.md](dashboard.md) の 5 節 |
| `tenant_name_tombstones` | 名前の再利用の禁止（RLS の外） | MVP | 同上 |
| `tenant_config_versions` | 設定の版（RLS の外） | MVP | 同上、[ADR-0032](../decisions/0032-tenant-config-cache.md) |
| `clients` | アプリケーション（種類、グラント、コールバック、ログアウトの URL、Web オリジン、`require_pkce`、`refresh_token` の設定（`binding` を含む）、`oidc_backchannel_logout`、`is_first_party`、`client_metadata`、`legacy_token_endpoint_aud`（`private_key_jwt` の `aud` の互換のフラグ。GA から 12 か月で廃止））。後の列：`organization_usage`・`organization_require_behavior`（E14）、`require_pushed_authorization_requests`（PAR） | MVP | [tenants-and-applications.md](tenants-and-applications.md) の 14 節、[ADR-0031](../decisions/0031-application-and-api-registration.md) |
| `client_credentials` | **クライアントの秘密（SHA-256）と `private_key_jwt` の公開鍵の唯一の表**（`kind`）。有効なものは種類ごとに 2 つまで | MVP | 5.2 節、同上 |
| `resource_servers` | API（識別子、スコープ、有効期間、`allow_offline_access`、`is_system`、`scope_acr`（[mfa-and-passkeys.md](mfa-and-passkeys.md) の 6.4 節））。スコープは列（配列）で持ち、別の表を持たない | MVP | 同上 |
| `client_grants` | M2M の許可（アプリ × API × スコープ）。後の列：`organization_usage`（E14 の後） | MVP | 同上 |
| `tenant_hostnames` | ホスト名 → テナントの解決、`issuer` の元（RLS の外） | MVP | 5.3 節 |

### 4.2 ユーザーと接続

| テーブル | 中身 | 段階 | 定義の場所 |
| --- | --- | --- | --- |
| `users` | プロフィール、メタデータ（各 16 KiB）、状態、`user_id`（外に出す値）、`webauthn_user_handle` | MVP | [users-and-profiles.md](users-and-profiles.md) の 3.2 節、[ADR-0018](../decisions/0018-user-identifier-and-profile-store.md) |
| `user_identities` | 接続ごとの外部の ID。`(tenant_id, connection_id, provider_user_id)` で一意。持ち主は users-and-profiles、connections と共有 | MVP | 同上、[ADR-0014](../decisions/0014-connection-abstraction.md) |
| `user_tombstones` | 削除した `user_id` の HMAC（消さない） | MVP | 同上、[ADR-0020](../decisions/0020-user-search-and-lifecycle.md) |
| `connections`、`connection_clients` | 接続（`strategy`、`options`。データベース接続の `options.authentication_methods` を含む）とアプリごとの有効化 | MVP | [connections.md](connections.md) の 3.1・4.1.1 節 |
| `password_credentials` | パスワードのハッシュ（Argon2id＋pepper の版、取り込んだ bcrypt）。列 `breach_detected_at`（[attack-protection.md](attack-protection.md) の 5.4 節） | MVP | 同上の 3.1 節 |
| `password_history` | 再利用の禁止（Argon2id） | MVP | 同上 |
| `database_identifiers` | データベース接続の中の識別子の一意 | MVP | 同上 |
| `credential_tickets` | メールの確認・再設定のリンク（SHA-256）、サインアップのコード（Argon2id） | MVP | 同上 |
| `idp_tokens` | ソーシャル IdP のトークン（保存を選んだ接続だけ。暗号文） | MVP | 同上、[ADR-0016](../decisions/0016-social-connections-and-idp-tokens.md) |
| `user_import_jobs`、`user_export_jobs` | 一括のインポート・エクスポート | 後 | [users-and-profiles.md](users-and-profiles.md) の 8 節 |
| `scim_tokens` | SCIM の Bearer トークン（SHA-256） | 後（E14 の後） | 同上の 9 節 |
| `ldap_connectors`、`connection_domains`、`saml_assertion_replay` | LDAP のコネクタ、振り分けのドメイン（TXT で確認）、SAML のアサーションの再利用の防止 | 後（E14） | [connections.md](connections.md) の 6 節、[ADR-0017](../decisions/0017-enterprise-connections.md) |

### 4.3 MFA とパスキー

| テーブル | 中身 | 段階 | 定義の場所 |
| --- | --- | --- | --- |
| `authenticators` | ユーザーの認証器の共通の行（状態、失敗の数、ロック） | MVP | [mfa-and-passkeys.md](mfa-and-passkeys.md) の 3.2 節、[ADR-0021](../decisions/0021-authenticator-model-and-assurance-levels.md) |
| `totp_secrets` | TOTP の種（暗号文）、`last_used_step` | MVP | 同上、[ADR-0023](../decisions/0023-otp-and-recovery-codes.md) |
| `webauthn_credentials` | 公開鍵、AAGUID、署名の回数、BE・BS | MVP | 同上、[ADR-0022](../decisions/0022-webauthn-and-passkeys.md) |
| `recovery_codes` | リカバリーコード（Argon2id） | MVP | 同上 |
| `otp_challenges` | メールの OTP（HMAC、試行の回数） | MVP | 同上 |
| `authenticator_enrollment_tickets` | 登録のチケット（SHA-256、24 時間） | MVP | 同上の 4.3・14 節 |

### 4.4 ログイン・トークン・セッション

| テーブル | 中身 | 段階 | 定義の場所 |
| --- | --- | --- | --- |
| `login_transactions` | Universal Login のトランザクション（`handle_hash`、`step`、認可の要求を `authz_request` に）。時間のパーティション | MVP | [universal-login.md](universal-login.md) の 4 節、[ADR-0011](../decisions/0011-universal-login-rendering-and-transaction.md)。`authz_request` の欄は [authentication-flows.md](authentication-flows.md) の 17 節 |
| `authorization_codes` | 認可コード（SHA-256、1 回限り、60 秒）。時間のパーティション | MVP | [authentication-flows.md](authentication-flows.md) の 17 節 |
| `refresh_token_families` | リフレッシュトークンの系列。**複数の領域の列を 5.1 節の 1 つの定義にまとめた** | MVP | 5.1 節 |
| `refresh_tokens` | 系列の中のトークン（SHA-256、`seq`、使用済み） | MVP | 5.1 節 |
| `device_authorizations` | デバイス認可グラント（`device_code`・`user_code` の SHA-256） | MVP | [authentication-flows.md](authentication-flows.md) の 17 節、[ADR-0009](../decisions/0009-device-authorization-grant.md) |
| `client_assertion_jtis` | `private_key_jwt` の `jti`（Valkey が使えないときの置き場所） | MVP | 同上の 6.1 節 |
| `grants` | **OAuth の同意**（ユーザー × アプリ × API → 許したスコープ）。規約への同意（`consent_records`）とは別 | MVP | 同上の 5.6 節 |
| `pushed_authorization_requests` | PAR（`request_uri` の SHA-256、60 秒） | 後 | 同上の 10 節、[ADR-0010](../decisions/0010-staged-protocol-extensions.md) |
| `sessions`、`session_clients` | サーバー側のセッション（`secret_hash`、`sid`、`amr`・`acr`）と、セッションでトークンを出したアプリ | MVP | [sessions-and-sso.md](sessions-and-sso.md) の 3 節、[ADR-0027](../decisions/0027-server-side-sessions.md) |
| `backchannel_logout_deliveries` | Back-Channel Logout の送信の状態（秘密を含めない） | MVP | 同上の 14 節、[ADR-0028](../decisions/0028-logout-rp-initiated-and-back-channel.md) |

### 4.5 Universal Login

| テーブル | 中身 | 段階 | 定義の場所 |
| --- | --- | --- | --- |
| `branding_themes`、`branding_texts` | テーマ（テナントに 1 つ、アプリごとの上書き）と文言の上書き（500 文字） | MVP | [universal-login.md](universal-login.md) の 6 節、[ADR-0012](../decisions/0012-branding-and-templates.md) |
| `legal_documents`、`consent_records` | 規約の版と、**規約への同意の記録**（追記だけ。法務の L8） | MVP（承認は L8 の後） | 同上の 16 節、[ADR-0013](../decisions/0013-consent-records.md) |

### 4.6 攻撃の防御

| テーブル | 中身 | 段階 | 定義の場所 |
| --- | --- | --- | --- |
| `brute_force_blocks` | ブロックの正本（数は Valkey）。識別子の HMAC | MVP | [attack-protection.md](attack-protection.md) の 4.3 節、[ADR-0024](../decisions/0024-attack-protection-counters-and-enforcement.md) |
| `breached_password_versions` | 漏えいしたパスワードのデータの版（RLS の外。自前のホストは法務の確認の後） | MVP（表）、自前のホストは確認の後 | 同上の 5.2 節、[ADR-0025](../decisions/0025-breached-password-detection.md) |
| 漏えいしたパスワードの範囲のデータ | SHA-1 の先頭 5 文字 → 接尾辞の一覧。**DB に置かない。** 公式の range API の間は Valkey とメモリーに 24 時間、自前のホストでは S3（`pwned/v<版>/<接頭辞>.txt`）とメモリーの LRU | — | 同上の 5.2 節 |

### 4.7 鍵と秘密

| テーブル | 中身 | 段階 | 定義の場所 |
| --- | --- | --- | --- |
| `signing_keys` | 署名鍵（状態、公開鍵、秘密鍵と DEK の暗号文、`last_used_at`）。失効で暗号文を消す | MVP | [keys-and-secrets.md](keys-and-secrets.md) の 14 節、[ADR-0046](../decisions/0046-signing-key-lifecycle.md) |
| `signing_key_state_versions` | Signer のポーリングの版 | MVP | 同上 |
| `signing_key_issuers` | Signer の `iss` の検査（テナントのホストとカスタムドメイン） | MVP | 同上 |
| `signing_key_operations` | ローテーション・失効の操作の状態（`pending`→`published`→`completed`。DR の複製の確認を含む。[ADR-0060](../decisions/0060-disaster-recovery-and-stages.md)） | MVP | 同上 |
| `jwks_publications` | JWKS の書き出しと確かめの記録 | MVP | 同上、[ADR-0047](../decisions/0047-signer-api-and-jwks-publishing.md) |
| `external_idp_keys` | **外部 IdP のアサーションの鍵**（Apple の `.p8`、OIDC の `private_key_jwt`・SAML の SP の鍵）。接続ごと。Signer だけが復号できる | E6（Apple）、E14（OIDC・SAML） | 同上の 6.3・14 節、ADR-0047 |
| `tenant_data_keys` | テナントごとの DEK（版） | MVP | 同上、[ADR-0045](../decisions/0045-kms-key-hierarchy.md) |
| `pepper_versions` | pepper の版（RLS の外） | MVP | 同上 |

### 4.8 管理の経路とダッシュボード

| テーブル | 中身 | 段階 | 定義の場所 |
| --- | --- | --- | --- |
| `rate_limit_overrides` | レート制限の上書き（RLS の外） | MVP | [management-api-and-rate-limiting.md](management-api-and-rate-limiting.md) の 15 節、[ADR-0035](../decisions/0035-rate-limiting.md) |
| `mgmt_api_deprecations` | Management API の廃止の予定（RLS の外） | MVP | 同上 |
| `break_glass_tokens`、`dashboard_preferences` | 非常用の経路の記録、管理者の設定（RLS の外） | MVP | [dashboard.md](dashboard.md) の 13 節 |

チェックポイントのページングは DB に保存しない（暗号化した文字列に状態を持たせる）。

### 4.9 認証のイベントのログとログストリーム

| テーブル | 中身 | 段階 | 定義の場所 |
| --- | --- | --- | --- |
| `logs`（ログのクラスタ） | 認証のイベント。取り込みの日ごとのパーティション、31 日で `DROP`。テナントの検索は `tenants.log_retention_days` で切る | MVP | [logs-and-streams.md](logs-and-streams.md) の 4・13 節、[ADR-0042](../decisions/0042-log-event-model-and-type-codes.md)、[ADR-0043](../decisions/0043-log-storage-and-search.md) |
| `log_shard_state`、`log_stream_notify`（ログのクラスタ） | 書き手の採番の状態、送り手への通知（RLS の外） | MVP | 同上 |
| `log_streams`（主のクラスタ） | ログストリームの設定とカーソル（送信先の資格情報と署名の鍵は暗号文） | MVP | 同上、[ADR-0044](../decisions/0044-log-stream-delivery.md) |

### 4.10 カスタムドメインとメール

| テーブル | 中身 | 段階 | 定義の場所 |
| --- | --- | --- | --- |
| `custom_domains` | カスタムドメインの状態（TXT の SHA-256、配信のテナント、証明書） | MVP | [custom-domains.md](custom-domains.md) の 3.1 節、[ADR-0038](../decisions/0038-custom-domain-verification-and-certificates.md) |
| `tenant_hostnames` | 4.1 節と同じ表（持ち主は custom-domains） | MVP | 5.3 節 |
| `email_templates`、`email_providers` | テンプレート（`ja`・`en`）、テナントの送信事業者（SMTP のパスワードは暗号文） | MVP | [email-delivery.md](email-delivery.md) の 6・7 節、[ADR-0041](../decisions/0041-email-templates-and-tenant-providers.md) |
| `email_messages`、`email_suppressions` | 送信の記録（本文なし、30 日）、抑止（宛先の HMAC） | MVP | 同上の 8 節 |
| `email_outbox` | メールの送信の待ち。**共通の `outbox` と別の表**にする（秘密の変数を暗号文で持ち、期限切れで捨て、送信の後に秘密を消すため）。Relay が 2 つの列（`auth`・`notify`）の SQS へ移す（RLS の外） | MVP | 同上の 4 節、[ADR-0040](../decisions/0040-email-sending-platform.md) |
| `sending_domains` | テナントの独自の送信ドメインの状態（`registered`→`pending_dns`→`verified`・`degraded`・`failed`） | E11 | 同上の 5.2 節 |

### 4.11 Organizations（E14）

| テーブル | 中身 | 段階 | 定義の場所 |
| --- | --- | --- | --- |
| `organizations` | 組織（名前は変えない、表示名、ブランド） | 後（E14） | [organizations.md](organizations.md) の 14 節、[ADR-0051](../decisions/0051-organization-model-and-login-flow.md) |
| `organization_members`、`organization_roles`、`organization_member_roles` | メンバーシップ（`user_pk`）と組織のロール | 後（E14） | 同上 |
| `organization_connections` | 組織ごとの接続の有効化、自動の付与、サインアップ | 後（E14） | 同上 |
| `organization_invitations` | 招待（ticket の SHA-256、既定 7 日） | 後（E14） | 同上、[ADR-0052](../decisions/0052-organization-tokens-sessions-and-membership.md) |
| `organization_client_grants` | 組織に結ぶ M2M の許可 | 後（E14 の後） | 同上の 5.2 節 |

### 4.12 拡張（Actions。E13）

| テーブル | 中身 | 段階 | 定義の場所 |
| --- | --- | --- | --- |
| `actions`、`action_versions` | Action と版（解決した依存、束の S3 のキーと `sha256`） | 後（E13） | [extensibility.md](extensibility.md) の 14 節、[ADR-0050](../decisions/0050-extensibility-build-secrets-and-limits.md) |
| `action_secrets` | Action の秘密（暗号文。読めない） | 後（E13） | 同上 |
| `trigger_bindings` | トリガーの並びと版、`on_platform_error`。配備でテナントの設定の版を上げる | 後（E13） | 同上、[ADR-0048](../decisions/0048-extensibility-triggers-and-failure-policy.md) |
| `action_executions`（ログのクラスタ） | 実行の記録（時間、エラー、256 文字のログ）。10 日 | 後（E13） | 同上 |

### 4.13 監査・運用

| テーブル | 中身 | 段階 | 定義の場所 |
| --- | --- | --- | --- |
| `audit_events` | テナントの監査。操作と同じトランザクションで追記。差分に秘密を入れない。log-archive へハッシュの連鎖で送る | MVP | 5.4 節、[ADR-0054](../decisions/0054-audit-log.md) |
| `platform_audit_events` | プラットフォームの監査（RLS の外） | MVP | 5.4 節 |
| `support_access_grants` | テナントの管理者が許したサポートの参照（期限つき） | MVP | 5.4 節、[ADR-0056](../decisions/0056-operator-access.md) |
| `legal_holds` | テナント単位の削除の停止（RLS の外） | MVP | 5.4 節、[ADR-0055](../decisions/0055-data-retention-and-deletion.md) |
| `outbox` | 非同期の連携（ログ、Back-Channel Logout、JWKS の書き出し、設定の変更の通知、ユーザーのイベント）。`trace_context` 列。時間のパーティション（RLS の外） | MVP | 5.5 節、ADR-0005 |
| `dr_replay_runs` | DR の後の失った範囲のやり直しの記録（RLS の外） | MVP | 5.4 節、[ADR-0060](../decisions/0060-disaster-recovery-and-stages.md) |

## 5. 統合した定義

複数の領域が列を足す表と、この文書が持ち主の表の定義。

### 5.1 リフレッシュトークン（`refresh_token_families`、`refresh_tokens`）

authentication-flows（17 節）、sessions-and-sso（7・14 節、[ADR-0029](../decisions/0029-refresh-token-session-binding.md)）、organizations（5.1・14 節、[ADR-0052](../decisions/0052-organization-tokens-sessions-and-membership.md)）、[ADR-0010](../decisions/0010-staged-protocol-extensions.md)（DPoP）がそれぞれ列を足していたものを、1 つの定義にまとめた。**振る舞いの正本は各文書のまま**で、列の正本はここにする。

```sql
-- One row per refresh token family (ADR-0003). Tenant table, RLS.
CREATE TABLE refresh_token_families (
  tenant_id            uuid        NOT NULL,
  id                   uuid        NOT NULL,          -- UUIDv7
  user_pk              uuid        NOT NULL,          -- users.id
  client_id            text        NOT NULL,
  audience             text        NOT NULL,          -- one API per family (ADR-0008)
  scope                text[]      NOT NULL,          -- granted scopes; refresh may narrow, never widen
  origin_grant         text        NOT NULL,          -- 'authorization_code' | 'device_code'
  session_id           uuid,                          -- sessions.id; null for device flow (ADR-0029)
  binding              text        NOT NULL,          -- 'session' | 'independent' (ADR-0029)
  organization_id      uuid,                          -- organizations.id; null outside org context (ADR-0052, E14)
  dpop_jkt             text,                          -- JWK thumbprint; null until DPoP (ADR-0010)
  rotation             boolean     NOT NULL,          -- false only for confidential clients that opt out
  created_at           timestamptz NOT NULL,
  absolute_expires_at  timestamptz NOT NULL,          -- <= session absolute expiry when binding = 'session'
  idle_expires_at      timestamptz NOT NULL,          -- pushed forward on each successful refresh
  last_used_at         timestamptz,
  revoked_at           timestamptz,
  revoke_reason        text,                          -- 'reuse_detected' | 'code_reuse' | 'logout' | 'session_ended'
                                                     -- | 'revoked_by_client' | 'grant_revoked' | 'password_changed'
                                                     -- | 'user_blocked' | 'user_deleted' | 'membership_removed'
                                                     -- | 'family_limit' | 'admin'
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX ON refresh_token_families (tenant_id, user_pk, client_id) WHERE revoked_at IS NULL; -- 200 per user x app
CREATE INDEX ON refresh_token_families (tenant_id, session_id) WHERE revoked_at IS NULL;
CREATE INDEX ON refresh_token_families (tenant_id, organization_id, user_pk) WHERE organization_id IS NOT NULL;

-- One row per issued refresh token. Tenant table, RLS.
CREATE TABLE refresh_tokens (
  tenant_id     uuid        NOT NULL,
  token_hash    bytea       NOT NULL,                 -- SHA-256 of the opaque <brand>_rt_ token (ADR-0004)
  family_id     uuid        NOT NULL,
  seq           integer     NOT NULL,                 -- 1, 2, 3 ... within the family
  issued_at     timestamptz NOT NULL,
  used_at       timestamptz,                          -- set on rotation; reuse after grace => revoke family
  PRIMARY KEY (tenant_id, token_hash),
  UNIQUE (tenant_id, family_id, seq)
);
```

- `authorization_codes.refresh_family_id` から系列を引き、コードの再利用で系列を失効させる（`revoke_reason = 'code_reuse'`）。
- 猶予（leeway、0〜60 秒）と有効期間はアプリの設定（`clients.refresh_token`）で持ち、系列の行に写さない（`absolute_expires_at`・`idle_expires_at` は作成・更新の時に計算した結果）。
- 系列の失効は、行の `revoked_at` の条件付きの更新で行う。ログアウト・再設定・ブロック・メンバーの削除など、失効させる各領域の操作は、この列だけを書く。
- 保持：最終の期限＋30 日で物理削除（[security.md](security.md) の 9 節）。

### 5.2 クライアントの資格情報（`client_credentials`）

tenants-and-applications の `client_credentials` と、authentication-flows が提案した `client_secrets`・`client_public_keys` が重なっていた。**`client_credentials` の 1 つの表に揃えた**（種類を `kind` で分ける）。理由：ローテーション・最終の使用の時刻・失効・監査・「種類ごとに 2 つまで」の規則が秘密と公開鍵で同じで、アプリの認証の方式（`token_endpoint_auth_method`）を変えるときも 1 つの表で済むため。

```sql
CREATE TABLE client_credentials (
  tenant_id     uuid        NOT NULL,
  id            uuid        NOT NULL,
  client_id     text        NOT NULL,
  kind          text        NOT NULL,                 -- 'secret' | 'public_key'
  secret_hash   bytea,                                -- kind = 'secret': SHA-256 of <brand>_cs_... (shown once)
  jwk           jsonb,                                -- kind = 'public_key': RSA >= 2048 or P-256
  kid           text,                                 -- kind = 'public_key'
  created_at    timestamptz NOT NULL,
  expires_at    timestamptz,                          -- optional; set on the old one during rotation
  last_used_at  timestamptz,                          -- written at most once per minute
  revoked_at    timestamptz,
  PRIMARY KEY (tenant_id, id),
  CHECK ((kind = 'secret' AND secret_hash IS NOT NULL AND jwk IS NULL)
      OR (kind = 'public_key' AND jwk IS NOT NULL AND kid IS NOT NULL AND secret_hash IS NULL))
);
CREATE UNIQUE INDEX ON client_credentials (tenant_id, client_id, kid) WHERE kind = 'public_key' AND revoked_at IS NULL;
```

- 「種類ごとに有効なものは 2 つまで」は、作成の関数で確かめる（[ADR-0007](../decisions/0007-client-authentication-methods.md)）。
- 認証の経路は、設定のスナップショットに秘密のハッシュと公開鍵を載せて照合する（[tenants-and-applications.md](tenants-and-applications.md) の 9 節）。

### 5.3 ホスト名の解決（`tenant_hostnames`）

[ADR-0039](../decisions/0039-hostname-resolution-and-issuer.md) の表。custom-domains の領域が持ち、`custom_domains` の遷移（`ready` で足し、`suspended`・`deleting` で外す）と、テナントの作成（標準のホスト名）で書く。

```sql
-- Outside RLS: resolution happens before the tenant is known (ADR-0002, ADR-0039).
CREATE TABLE tenant_hostnames (
  hostname             text        PRIMARY KEY,      -- lower-case, Punycode, no trailing dot, no port
  tenant_id            uuid        NOT NULL,
  kind                 text        NOT NULL,         -- 'canonical' | 'custom'
  custom_domain_id     uuid,                          -- custom_domains.id when kind = 'custom'
  status               text        NOT NULL,         -- 'active' only; removed rows are deleted
  is_default_for_email boolean     NOT NULL DEFAULT false,
  version              bigint      NOT NULL,         -- change feed for the in-memory map
  updated_at           timestamptz NOT NULL
);
```

- 読むのは解決の関数だけ（起動時の全件と、変更の通知の差分）。書くのは `mgmt_app` の遷移の関数だけ。
- 中身はホスト名とテナントの ID で、秘密を持たない。
- S3 のセル構成では、ホスト名 → テナント → セルの対応表をセルの外（Global）に置く（7 節）。

### 5.4 監査・運用の表（security・observability・infrastructure の領域）

```sql
-- tenant audit (ADR-0054). Tenant table, RLS.
CREATE TABLE audit_events (
  tenant_id     uuid        NOT NULL,
  id            uuid        NOT NULL,            -- UUIDv7
  occurred_at   timestamptz NOT NULL,
  actor_type    text        NOT NULL,            -- 'member' | 'client' | 'operator' | 'system'
  actor_id      text        NOT NULL,
  action        text        NOT NULL,            -- e.g. 'signing_key.revoke'
  target_type   text        NOT NULL,
  target_id     text,
  outcome       text        NOT NULL,            -- 'success' | 'failure'
  ip            inet,
  user_agent    text,
  request_id    text,
  diff          jsonb,                           -- never contains secret values
  prev_hash     bytea,                           -- hash chain, filled by relay
  PRIMARY KEY (tenant_id, id)
) PARTITION BY RANGE (occurred_at);

-- platform audit (ADR-0054). Outside RLS.
CREATE TABLE platform_audit_events (
  id            uuid        PRIMARY KEY,
  occurred_at   timestamptz NOT NULL,
  operator_id   text        NOT NULL,
  tenant_id     uuid,                            -- null for platform-wide actions
  action        text        NOT NULL,            -- e.g. 'jit.grant', 'support.view', 'break_glass.use'
  reason        text        NOT NULL,
  incident_id   text,
  approved_by   text,
  diff          jsonb,
  prev_hash     bytea
);

-- tenant-approved support access (ADR-0056). Tenant table, RLS.
CREATE TABLE support_access_grants (
  tenant_id     uuid        NOT NULL,
  id            uuid        NOT NULL,
  granted_by    uuid        NOT NULL,            -- tenant member
  scope         text        NOT NULL,            -- 'config' | 'users' | 'logs'
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  PRIMARY KEY (tenant_id, id)
);

-- legal hold (ADR-0055). Outside RLS.
CREATE TABLE legal_holds (
  id            uuid        PRIMARY KEY,
  tenant_id     uuid        NOT NULL,
  reason        text        NOT NULL,
  placed_by     text        NOT NULL,
  placed_at     timestamptz NOT NULL,
  released_at   timestamptz
);

-- DR replay of security-strengthening operations (ADR-0060). Outside RLS.
CREATE TABLE dr_replay_runs (
  id              uuid        PRIMARY KEY,
  window_start    timestamptz NOT NULL,
  window_end      timestamptz NOT NULL,
  source          text        NOT NULL,          -- 'audit_archive' | 'auth_event_archive' | 'snapshot'
  extracted_count integer     NOT NULL,
  replayed_count  integer     NOT NULL,
  approved_by     text        NOT NULL,
  started_at      timestamptz NOT NULL,
  finished_at     timestamptz
);
```

- `audit_events` は月ごとのパーティション。1 年より古いものは log-archive にあることを確かめてから `DROP` する（保持は [security.md](security.md) の 9 節。法務の L5 で確定）。テナントの管理者が見られるのは 90 日（[ADR-0054](../decisions/0054-audit-log.md)）。

### 5.5 outbox

他の題材と同じ形。事象の種類：`log_event`、`session.ended`、`jwks.changed`、`tenant.config_changed`、`tenant_hostname.changed`、`user.*`、`apple.notification`、`backchannel_logout.requested` など。

```sql
-- Outside RLS: the relay reads all tenants' rows (section 3).
CREATE TABLE outbox (
  id             uuid        NOT NULL,           -- UUIDv7
  tenant_id      uuid,                           -- null for platform events
  topic          text        NOT NULL,
  payload        jsonb       NOT NULL,           -- ids and types only; never secrets
  trace_context  text,                           -- W3C traceparent (observability.md 2.2)
  created_at     timestamptz NOT NULL,
  relayed_at     timestamptz,
  PRIMARY KEY (created_at, id)
) PARTITION BY RANGE (created_at);
```

- 各サービスは、業務のトランザクションの中で自分のテナントの行だけを入れる（`WITH CHECK` の関数経由）。
- 最古の未送の行が 30 秒を超えたら呼び出す（`relay-backlog.md`。[runbooks/README.md](../runbooks/README.md)）。

## 6. 保持

テーブルごとの保持の期間の正本は [security.md](security.md) の 9 節（[ADR-0055](../decisions/0055-data-retention-and-deletion.md)）。**期間はすべて既定案で、法務の確認（L1・L5・L7・L8）で確定する。** パーティションで消すものは、各領域の文書に `DROP` の周期を書く。

## 7. 段階ごとの変化

| 段階 | 変化 |
| --- | --- |
| S2 | ユーザー・資格情報・セッション・リフレッシュトークン・認可コードを、`tenant_id` のハッシュで複数の Aurora のクラスタに分ける（同じテナントの行は同じクラスタ）。大口のテナントを専用のクラスタへ。認証のイベントのログを専用の基盤へ（[architecture/README.md](README.md) の 2 節） |
| S3 | テナントをセルに固定し、テナントのデータはセルの中に閉じる。ホスト名 → テナント → セルの対応表をセルの外（Global）に置く（[ADR-0060](../decisions/0060-disaster-recovery-and-stages.md)、[infrastructure.md](infrastructure.md) の 11 節） |

## 8. 統合で決めたこと（2026-09-27）

| 論点 | 決定 |
| --- | --- |
| `client_credentials` と `client_secrets`・`client_public_keys` の重なり | `client_credentials` の 1 つの表にした（5.2 節）。authentication-flows の 6.1・17 節を揃えた |
| `refresh_token_families` の列が複数の領域に散っていた | 5.1 節の 1 つの定義にまとめた（`session_id`・`binding`、`organization_id`、`dpop_jkt` を含む）。各文書の data-model の節は、この節を指す |
| ユーザーを指す列の名前（`user_id` と `user_pk` の混在） | 参照の列は `user_pk` に揃えた（2 節）。`sessions`、`authorization_codes`、`grants`、`device_authorizations`、`organization_members`、`organization_member_roles` を直した |
| `grants` と `consent_records` | `grants` は OAuth の同意（authentication-flows）、`consent_records` は規約への同意（universal-login、ADR-0013）。名前はそのままで、索引で区別を明記した |
| `tenant_hostnames` と `custom_domains` の分担 | `custom_domains` はテナントテーブルでドメインの状態を持つ。`tenant_hostnames` は解決用の RLS の外の表で、`ready` のドメインと標準のホスト名だけを持つ（5.3 節） |
| `email_outbox` と共通の `outbox` | 別の表にした（秘密の暗号文、期限切れの破棄、送信の後の消去があるため）。どちらも RLS の外で、Relay が読む |
| テナントの外の表の一覧 | 3 節にすべて挙げ、理由と読める主体・書ける主体を書いた（`outbox`・`email_outbox`・`log_stream_notify` を足した） |
| Signer の DB のロール | `signing_keys` に、`signing_key_state_versions`・`signing_key_issuers`・`external_idp_keys` を足した（[ADR-0059](../decisions/0059-signer-isolation.md) を揃えた） |
| 外部 IdP の秘密鍵（Apple の `.p8` など）の置き場所 | `connections.secrets_ct` ではなく、Signer だけが復号できる `external_idp_keys` に置く（[ADR-0047](../decisions/0047-signer-api-and-jwks-publishing.md)） |

残り（マイグレーションを書く Story で確かめる）：

- すべてのテナントテーブルに RLS があり、3 節の例外が網羅されていることを、マイグレーションの CI の許可リストと照合する（ADR-0002 の Confirmation）。E1 の `ci-pipeline` の Story で行う。
- ADR-0013 の `consent_records` は `user_pk` で参照する（2026-09-27 に決めた）。ユーザーの削除の後に同意の証跡をどう残すか（`user_pk` の行を残すか、墓標の `user_id` の HMAC と結ぶか）は、L7・L8 の結論と一緒に決める。
- `tenants.settings`（jsonb）に載せる設定と、列にする設定の境目は、E2 の `tenant-config-snapshot` の Story で決める。

# Roadmap: Auth0

## 進め方の原則

- **最初に walking skeleton を通す。** E1〜E3 で、テナント・アプリの登録・`/authorize`・認可コード＋PKCE・Signer での署名・JWKS のエッジ配信・適合試験の CI を端から端まで貫いてから、機能を広げる。テナントの分離（RLS）、Signer の境界、秘密を出さない計装は、E1 から本物の形で作る。後から足すと直せないため。
- **標準で確かめる。** プロトコルの振る舞いを変える Story は、OpenID Foundation の適合試験（[ADR-0064](decisions/0064-conformance-suite-in-ci.md)）と、`SEC-NNN` の拒否の側のテスト（[security.md](architecture/security.md) の 4 節）を通してからマージする。
- **契約を先に固定する。** discovery の値、トークンのクレーム、エラーの形、Management API の形（[ADR-0033](decisions/0033-management-api-shape.md)）、Signer の API（[ADR-0047](decisions/0047-signer-api-and-jwks-publishing.md)）は、人間がレビューして確定する。エージェントは勝手に変えない。
- **`security:sensitive` の変更は 2 人の人が承認する**（[ADR-0065](decisions/0065-security-sensitive-change-flow.md)）。振る舞いの変更はテナントのカナリアで広げる（[ADR-0066](decisions/0066-tenant-canary-release.md)）。
- **法務の確認待ちの Story は、spec を承認しない。** 設計と、法務に依らない Story は進めてよい（[intent.md](intent.md) の「法務の確認待ち」）。下の表で「法務：L*」と書いた Story が当たる。
- **認証の経路に同期の依存を足す Story は、先に [ADR-0005](decisions/0005-authentication-path-availability.md) の縮退の表を更新してレビューを受ける**（AGENTS.md）。
- **1 変更 1 PR を目安に、差分を小さくする。** Signer の変更は他のサービスと別の PR、別の日の本番のデプロイにする（[delivery.md](architecture/delivery.md) の 3 節）。

## Epic

PM が持つ。変更の一覧はここに書かず、各変更の `spec.md` の frontmatter（`epic`）から集計する（[process.md](../../../docs/process.md) の「粒度」）。

| Epic | 目的 | 状態 |
| --- | --- | --- |
| E1 基盤 | AWS・Terraform・CI（適合試験の枠を含む）、主とログの Aurora と RLS、Signer と KMS の鍵の階層、フラグとテナントのカナリア、秘密を出さない可観測性、outbox、画面の骨格 | 設計中 |
| E2 テナント・アプリ・Management API | アカウント・テナント・メンバー、アプリ・API・M2M の許可、設定のキャッシュ、ホスト名の解決、Management API の骨格と認可、接続・ユーザーの CRUD | 未着手 |
| E3 OIDC・OAuth の中核 | discovery・JWKS（エッジ）、`/authorize`、認可コード＋PKCE、クライアントの認証、トークン、userinfo、クライアントクレデンシャル、Form Post、同意、署名鍵のライフサイクル、否定側のテスト、差分テスト | 未着手 |
| E4 Universal Login とデータベース接続 | 識別子・パスワードの画面、サインアップ（verify-first）・再設定・確認、パスワードのポリシー、ブランディングと `ja`・`en`、規約の同意、メールの送信、攻撃の防御の基本の組み込み | 未着手（メールの送信は法務：L1・L3。規約の同意は L8。ログインの画面の公開は L2） |
| E5 セッション・SSO・ログアウト | サーバー側のセッション、SSO、RP-Initiated・Back-Channel Logout、リフレッシュトークンのローテーションと再利用の検知、失効、デバイス認可 | 未着手 |
| E6 ソーシャル接続と ID のリンク | Google・Apple・LINE・GitHub、IdP のトークン、Apple の通知、本人のリンクの画面と API、外部 IdP のアサーション（Apple） | 未着手（法務：L1） |
| E7 MFA とパスキー | 認証器のモデル、TOTP、WebAuthn・パスキー（パスキー優先のログイン）、メールの OTP、リカバリーコード、step-up、ロック、K8 | 未着手 |
| E8 攻撃の防御 | ブルートフォース、不審な IP、漏えいしたパスワード、ボットの検知（PoW）、監視のモード、K5 の模擬の試験 | 未着手（外部のボットの部品は法務：L2。自前のホストは法務の確認。ATP は L1） |
| E9 ダッシュボード | SPA、管理用のテナントでのログインと step-up、各領域の画面、メンバーとロール | 未着手 |
| E10 ログとログストリーム | 取り込みと `log_id`、`/logs` の検索、保持と仮名化、Webhook・EventBridge のストリーム、各領域のイベント | 未着手（保持は法務：L5。ストリームは L1・L3） |
| E11 カスタムドメインと送信ドメイン | カスタムドメインの検証・証明書・状態、テナントの送信ドメインと送信事業者 | 未着手 |
| E12 本番の準備 | OpenID Certification、負荷試験、DR の訓練、外部のペンテスト、非常用の経路、SLO の確定、GA の判定 | 未着手（GA の判定は法務：L1・L6・L7 と契約の論点） |
| E13 Actions（MVP の後） | テナントのコードでの拡張：トリガー、Lambda のテナントの隔離のモードでの実行、ビルドと秘密、`actions` のアカウント | 未着手（MVP の後） |
| E14 Organizations とエンタープライズ接続（MVP の後） | 組織・メンバー・招待・組織のログインの流れ（`DT-ORG-001`）と、SAML・OIDC・Entra ID・Google Workspace・LDAP のコネクタ、ドメインの振り分け | 未着手（MVP の後） |

## Story

各 Story は、着手するときに `changes/YYMMDD-<slug>/` として起票する。ここは計画で、進み具合は各変更の `spec.md` の frontmatter で見る。順序は Epic の中での目安で、依存があるものを先に置いた。各領域の文書の「Story の候補」「Epic との対応」から集めた。各 Epic の品質の重点と合否基準は [quality.md](quality.md) の 5 節にある。

### E1 基盤

設計：[infrastructure.md](architecture/infrastructure.md)、[delivery.md](architecture/delivery.md)、[observability.md](architecture/observability.md)、[keys-and-secrets.md](architecture/keys-and-secrets.md)、[security.md](architecture/security.md)、[data-model.md](architecture/data-model.md)

| Story | 内容 |
| --- | --- |
| `dev-repo-bootstrap` | Auth0 の再構築の開発リポジトリを作り、`changes/`・`specs/`・開発向けの `AGENTS.md`、`.github/security-sensitive-paths.yml` と CODEOWNERS を置く（リポジトリ共通の ADR-0005、[ADR-0065](decisions/0065-security-sensitive-change-flow.md)） |
| `terraform-foundation` | Organizations、management・security・log-archive・shared・edge・dev・staging・prod のアカウント、SCP、Terraform のルートモジュールと plan のポリシー検査（[ADR-0057](decisions/0057-accounts-network-and-path-separation.md)、[infrastructure.md](architecture/infrastructure.md) の 7.2 節） |
| `network-and-signer-subnet` | prod の VPC（public・private・signer・egress・isolated）、VPC エンドポイント、Network Firewall、`alb-auth`・`alb-mgmt`、Private CA と相互 TLS（[ADR-0059](decisions/0059-signer-isolation.md)） |
| `ecs-services-skeleton` | `auth`・`signer`・`mgmt`・`relay`・`worker`・`worker-egress` の ECS の骨格とタスクのロール |
| `aurora-and-rls` | 主の Aurora、RLS と `SET LOCAL app.tenant_id`、DB のロール、テナントの外の表の許可リスト（[data-model.md](architecture/data-model.md) の 2・3 節、[ADR-0002](decisions/0002-tenancy-and-isolation.md)） |
| `log-aurora-cluster` | ログの専用の Aurora のクラスタ、日ごとのパーティション、RLS（[ADR-0043](decisions/0043-log-storage-and-search.md)） |
| `kms-key-hierarchy` | 4 つの KMS の鍵、キーポリシー、SCP、CloudTrail の通知、IAM の静的検査（[ADR-0045](decisions/0045-kms-key-hierarchy.md)） |
| `pepper-bootstrap` | pepper の生成、Secrets Manager とアーカイブ、起動時の読み込み、バージョン |
| `tenant-data-keys` | テナントの DEK の作成・キャッシュ・ローテーション、AAD |
| `signer-sign-api` | Signer の署名の API（`/v1/sign`、`sign-batch`）と検査（[keys-and-secrets.md](architecture/keys-and-secrets.md) の 6.1 節） |
| `outbox-and-relay` | `outbox`（RLS の外）、Relay、SQS、`trace_context`（[data-model/operations.md](architecture/data-model/operations.md) の 3 節） |
| `ci-pipeline` | PR の CI の段（差分テスト、`SEC-` の追跡、テナントの分離の性質、秘密の出力の走査、暗号の API の lint、マイグレーションの規則、テストの資格情報の検査）と merge queue（[delivery.md](architecture/delivery.md) の 2 節） |
| `conformance-suite-ci` | 適合試験のスイートを CI の中で動かす枠（digest の固定、`plans.yaml`、`allowed-warnings.yaml`）と、試験用のクライアントの設定（[ADR-0064](decisions/0064-conformance-suite-in-ci.md)、[authentication-flows.md](architecture/authentication-flows.md) の 13.3 節） |
| `telemetry-package` | `packages/telemetry`（型付きのイベント、`Secret<T>`）、Collector の許可リスト、ALB・CloudFront・WAF のログの設定、秘密の走査の Lambda と合成の秘密、アラートと runbook の注釈の CI（[ADR-0061](decisions/0061-secret-free-telemetry.md)） |
| `feature-flags-tenant-canary` | `packages/flags`、テナント単位の判定、許可・除外リスト、ガードのアラーム（[ADR-0066](decisions/0066-tenant-canary-release.md)） |
| `attack-protection-skeleton` | `packages/attack-protection` の骨格（段の順序、Valkey の Lua、タスクのメモリーの縮退） |
| `universal-login-skeleton` | Hono の JSX、nonce の CSP のミドルウェア、ヘッダーの一式、ルートの一覧からのヘッダーのテスト（SEC-017・021） |
| `accounts-tenants-tables` | アカウント・テナント・メンバーの表、テナントの名前の規則と予約の一覧 |
| `admin-tenant-iac` | 管理用のテナント `admin` を IaC で作る（[ADR-0036](decisions/0036-dashboard-login-via-admin-tenant.md)） |
| `audit-log-core` | `audit_events`・`platform_audit_events`、log-archive へのハッシュの連鎖と日次の検証（[ADR-0054](decisions/0054-audit-log.md)） |
| `ses-accounts-and-shared-domain` | SES のアカウント（東京・大阪・予備）、本番の利用の申請、共有の送信ドメインの DKIM・MAIL FROM・DMARC（[ADR-0040](decisions/0040-email-sending-platform.md)） |
| `edge-and-multitenant-distribution` | edge のアカウント、通常の配信、マルチテナントの配信の雛形、Worker のロールの引き受け（[ADR-0058](decisions/0058-edge-and-custom-domains.md)） |
| `otp-hmac-helper` | pepper の鍵で HMAC を計算する共通の部品（メールの OTP 用）と、ログの許可リストへの追加 |
| `osaka-warm-standby-skeleton` | 大阪の Global Database の二次、KMS のレプリカ、最小のタスク、大阪からの合成監視の骨格（[ADR-0060](decisions/0060-disaster-recovery-and-stages.md)） |

### E2 テナント・アプリ・Management API

設計：[tenants-and-applications.md](architecture/tenants-and-applications.md)、[management-api-and-rate-limiting.md](architecture/management-api-and-rate-limiting.md)、[custom-domains.md](architecture/custom-domains.md) の 4.4 節、[connections.md](architecture/connections.md)、[users-and-profiles.md](architecture/users-and-profiles.md)

| Story | 内容 |
| --- | --- |
| `tenant-lifecycle` | テナントの作成（アカウントから）、環境と昇格、状態（`active`・`suspended`・`deleting`）（[ADR-0030](decisions/0030-accounts-tenants-and-members.md)） |
| `tenant-hostnames-resolution` | `tenant_hostnames`、プロセスの中の対応表、変更の通知、DB を読まない 404（[ADR-0039](decisions/0039-hostname-resolution-and-issuer.md)） |
| `tenant-config-snapshot` | 設定のスナップショット、バージョン、pub/sub とポーリング、LRU と起動時の先読み、`hostname_ready_by`（[ADR-0032](decisions/0032-tenant-config-cache.md)） |
| `mgmt-api-skeleton` | Management API のルーター、OpenAPI、エラーの形、相関 ID、`fields` |
| `mgmt-api-authz` | M2M のトークンの検証、要求ごとの許可の確認、スコープの判定（既定で拒否）、権限の昇格の防止（[ADR-0034](decisions/0034-management-api-authorization.md)） |
| `mgmt-pagination` | オフセットと、暗号化したチェックポイント（24 時間） |
| `mgmt-rate-limits` | 管理の経路の L5・L6 と見出し |
| `app-registration-and-credentials` | アプリの種類・グラント・URL の規則、`client_credentials`（秘密 2 つ、公開鍵 2 つ）とローテーション（[ADR-0031](decisions/0031-application-and-api-registration.md)） |
| `apis-and-client-grants` | API とスコープ、Management API の API をテナントの作成時に作る、client grant と `client_credentials` の許可の判定 |
| `connections-crud` | `connections`・`connection_clients` と RLS、接続の CRUD（`strategy` ごとの Zod の型、秘密の暗号化、秘密を応答に含めない） |
| `users-crud` | `users`・`user_identities`・`user_tombstones`、ユーザーの作成・取得・更新・削除（`user_id` の指定を含む） |
| `user-metadata` | メタデータの検証（大きさ、名前、予約の名前、秘密の形の拒否）、最上位の併合の `PATCH`、`If-Match` |
| `dashboard-api-route` | `manage.<brand>.<domain>/api/tenants/{tenant}/v2/*` を Management API のハンドラーに渡す経路と、管理用のテナントのトークンの検証 |

### E3 OIDC・OAuth の中核

設計：[authentication-flows.md](architecture/authentication-flows.md)、[keys-and-secrets.md](architecture/keys-and-secrets.md)、[universal-login.md](architecture/universal-login.md) の 4 節

| Story | 内容 |
| --- | --- |
| `config-cache-on-auth-path` | 認証の経路での設定のキャッシュの利用（`/authorize`・`/oauth/token` が DB を読まずに動く） |
| `signer-key-management-api` | `keys:generate`、`keys:invalidate`、ポーリング |
| `signing-key-lifecycle` | 署名鍵の操作（[keys-and-secrets.md](architecture/keys-and-secrets.md) の 5.2 節）、Management API、監査の事象（[ADR-0046](decisions/0046-signing-key-lifecycle.md)） |
| `jwks-and-discovery-publishing` | Worker の書き出し、ホスト名ごとの `issuer`、S3 とオリジングループ、CloudFront の無効化、確かめ |
| `discovery-and-metadata` | discovery と RFC 8414 のメタデータの生成 |
| `login-transactions` | `login_transactions` の表、`/authorize` からの作成、handle と `__Host-<brand>_tx` の結び付け、ステートマシンの骨格 |
| `authorize-endpoint` | `/authorize` のパラメーターの検証、`redirect_uri` の照合、エラーの画面 |
| `authorization-code-grant` | コードの発行・消費・再利用の検知、PKCE、`iss` の応答 |
| `client-authentication` | 4 つの方式、秘密の 2 つまでの並行、`private_key_jwt` の `jti` と `aud`（`issuer` だけ。互換のフラグ `legacy_token_endpoint_aud`） |
| `token-claims-and-lifetimes` | ID トークン・アクセストークンのクレーム（`amr`・`acr`・`auth_time`、`gty`）、有効期間、大きさの上限、`acr_values_supported` |
| `client-credentials-grant` | M2M、DB に書かない経路 |
| `userinfo-endpoint` | userinfo と Bearer のエラー |
| `form-post-response-mode` | `form_post` の HTML と CSP（適合試験の Form Post のプロファイル） |
| `consent-grants` | `grants`、第一者の印、`prompt=consent`、取り消し、OAuth の同意の画面 |
| `auth-path-rate-limits` | 認証の経路の L2・L3、`/oauth/token` の 429 の形、リフレッシュの 120% の優先 |
| `negative-tests-rfc9700` | SEC-001〜009・011・013・016・018・020 の拒否の側のテスト一式 |
| `differential-tests-node-oidc-provider` | 差分テストの枠と、違いの一覧 |
| `emergency-key-rotation` | テナントと全部の緊急のローテーション、キルスイッチ |
| `scheduled-key-rotation` | 定期の自動のローテーション（テナントの設定） |
| `edge-sli-and-synthetics` | エッジの SLI の集計（リアルタイムのログ）、合成監視（ログイン・リフレッシュ・クライアントクレデンシャル・JWKS）（[ADR-0062](decisions/0062-sli-and-synthetic-monitoring.md)） |
| `token-exchange-log-events` | `seacft`・`seccft`・`sertft`・`ferrt` などのログのイベント |

### E4 Universal Login とデータベース接続

設計：[universal-login.md](architecture/universal-login.md)、[connections.md](architecture/connections.md)、[email-delivery.md](architecture/email-delivery.md)、[attack-protection.md](architecture/attack-protection.md) の 3 節

| Story | 内容 |
| --- | --- |
| `identifier-and-password-screens` | Identifier First の画面、CSRF の 3 つの検査、画面の `POST` の決定表（universal-login の 13.1 節）、SEC-015 |
| `password-credentials-and-login` | `password_credentials`・`database_identifiers`、パスワードのログイン（ダミーのハッシュ、作り直し）、`authentication_methods` の `password` |
| `password-policy` | 判定の順、NFC、パスワードのポリシーの決定表（connections の 9.1 節） |
| `email-outbox-and-sender` | `email_outbox`、2 つの列、送信の Worker、期限切れの破棄、冪等（法務：L1・L3） |
| `default-email-templates` | 既定のテンプレート（`ja`・`en`）と描画（LiquidJS の制限） |
| `ses-tenant-per-tenant` | SES のテナントの作成と送信の上限 |
| `ses-results-and-suppression` | 送信の結果（EventBridge）、`email_messages`、抑止 |
| `signup-verify-first` | verify-first のサインアップ（`signup_code`、「登録済み」のメール）と即時のサインアップの切り替え、ユーザーの作成 |
| `password-reset` | 再設定（チケット、URL からの除去、セッションとリフレッシュトークンの失効） |
| `email-verification-link` | 確認のリンク（`GET` の確認の画面と `POST` の確定） |
| `password-change` | ログイン中のパスワードの変更、メールアドレスの変更と古いアドレスへの通知 |
| `attack-protection-login-basics` | ログイン・サインアップ・再設定の要求の段 1・3（`enforce` の既定）、ブロックの画面の文言（列挙の防止） |
| `breached-password-on-signup` | サインアップ・変更・再設定での漏えいしたパスワードの拒否（公式の range API。[ADR-0025](decisions/0025-breached-password-detection.md)） |
| `branding-and-locales` | テーマと文言の上書き、`ja`・`en`、言語の選び方（universal-login の 13.2 節） |
| `terms-consent-records` | 規約の文書の登録と同意の記録（法務：L8） |
| `error-pages` | エラーの画面、テナントのエラーの URL への転送 |
| `ul-rate-limits` | Universal Login の画面の IP・`state` の制限 |
| `hostname-in-email-links` | メール・再設定のリンクのホスト名を表から作る（ホストのヘッダーの注入の否定側のテスト） |
| `passkey-enrollment-prompt` | パスワードの後のパスキーの促し |
| `login-log-events` | ログイン・サインアップ・再設定・メールの確認のログ |
| `email-deliverability-monitoring` | 合成監視（受信箱への到着）、バウンス率・苦情率の警報 |
| `accessibility-checks` | axe の自動検査とスクリーンリーダーでの手動の確認（WCAG 2.2 AA） |

### E5 セッション・SSO・ログアウト

設計：[sessions-and-sso.md](architecture/sessions-and-sso.md)、[authentication-flows.md](architecture/authentication-flows.md) の 7.2・7.4・8.5 節

| Story | 内容 |
| --- | --- |
| `session-store-and-cookie` | `sessions`、`__Host-<brand>_session`、Valkey のキャッシュ、秘密の作り直し |
| `session-lifetimes` | 使われない期間・最終の期限・永続の設定と、`last_active_at` の間引き |
| `sso-decision` | SSO の判定と `session_clients`、`acr`・要素ごとの認証の時刻の記録 |
| `refresh-token-grant` | ローテーション、猶予、再利用の検知、200 個の上限、スコープの縮小（[data-model/login-and-sessions.md](architecture/data-model/login-and-sessions.md) の 2 節） |
| `refresh-session-binding` | 系列の `binding`、ログアウトでの失効、再利用の検知でのセッションの終了 |
| `revocation-endpoint` | RFC 7009 |
| `rp-initiated-logout` | `/oidc/logout`、`/u/logout` の確認の画面、`allowed_logout_urls` の照合（SEC-014） |
| `backchannel-logout-delivery` | outbox、Worker、Auth の内部の API、再試行、SSRF の検査 |
| `session-management-api` | セッションの一覧・取り消し・すべての端末からのログアウト |
| `block-delete-revocation` | ブロック・削除に伴うセッションとリフレッシュトークンの失効、Back-Channel Logout |
| `device-authorization-grant` | `/oauth/device/code`、`/activate`、ポーリング、`slow_down` |

### E6 ソーシャル接続と ID のリンク

設計：[connections.md](architecture/connections.md) の 5 節、[users-and-profiles.md](architecture/users-and-profiles.md) の 5 節、[keys-and-secrets.md](architecture/keys-and-secrets.md) の 6.3 節

| Story | 内容 |
| --- | --- |
| `social-common-client` | 共通のクライアント（PKCE、`state`、`nonce`、JWKS のキャッシュ、コールバック、`__Host-<brand>_idp`）（法務：L1） |
| `social-buttons-and-callback` | ソーシャルのボタンと `/login/callback` の画面 |
| `google-connection` | Google（`hd` の許可リスト） |
| `signer-external-idp-assertions` | Signer の外部 IdP のアサーションの API、`external_idp_keys`、`external-keys:import`、`apple_client_secret` |
| `apple-connection` | Apple（Signer でのクライアントシークレット、名前の保存、サーバー間の通知、`email-disabled` での抑止） |
| `line-connection` | LINE（HS256 の検証、メールの申請の有無、`bot_prompt`、メールの入力と確認の画面） |
| `github-connection` | GitHub（`/user/emails`） |
| `idp-token-storage` | `store_idp_tokens` と `read:user_idp_tokens` |
| `social-user-creation` | ソーシャルのログインでのユーザーの作成と `profile_data` の同期（`sync_user_profile`） |
| `account-linking-prompt` | 本人のリンクの画面（リンクの提案の決定表） |
| `account-linking-api` | アプリのリンク・管理者のリンク・解除の Management API |

### E7 MFA とパスキー

設計：[mfa-and-passkeys.md](architecture/mfa-and-passkeys.md)

| Story | 内容 |
| --- | --- |
| `authenticators-and-policy` | 認証器の表とステートマシン、テナントの MFA の方針、MFA の画面の差し込み |
| `totp` | TOTP の登録と照合（再利用の拒否、±1 区間） |
| `webauthn-second-factor` | WebAuthn の 2 つ目の要素（セキュリティキー、プラットフォーム） |
| `passkeys-login` | パスキーの登録とパスキー優先のログイン（条件付きの UI、ボタン、パスワードなしのサインアップ、`authentication_methods` の `passkey`） |
| `rp-id-and-related-origins` | RP ID の固定と Related Origin Requests、Signal API、カスタムドメインの登録の画面での影響の表示 |
| `email-otp` | メールの OTP（補助の制約、再送の制限、送信） |
| `recovery-codes` | リカバリーコード（10 個の組、作り直し、通知） |
| `step-up` | step-up の決定表、`resource_servers.scope_acr`、RFC 9470 のサンプル |
| `attempt-limits-and-lock` | 試行の上限とロック、MFA の失敗を段 3 に数える |
| `webauthn-e2e-and-devices` | 仮想の認証器の E2E と、実機の確認（K8） |

### E8 攻撃の防御

設計：[attack-protection.md](architecture/attack-protection.md)、[infrastructure.md](architecture/infrastructure.md) の 4.3 節

| Story | 内容 |
| --- | --- |
| `brute-force-protection` | ブルートフォースの防御の全体（既知の端末の Cookie、アカウントのロック、解除のリンク、再設定での解除、管理者の API） |
| `suspicious-ip-throttling` | 不審な IP の抑制（テナントとプラットフォームのバケツ、許可リスト、管理者への通知） |
| `attack-counter-base` | 攻撃の防御の数の基盤（L4）と、Valkey の障害時の近似 |
| `breached-password-on-login` | ログインでの照合と動作（`block`・`notify_*`・`monitor`） |
| `breached-password-self-hosting` | データの取り込みと自前の範囲の配信（法務の確認の後。[ADR-0025](decisions/0025-breached-password-detection.md)） |
| `bot-detection-pow` | リスクの点数、WAF のラベルの受け渡し、PoW のチャレンジ、JavaScript なしの経路、ボットの検知の部品の差し込み位置 |
| `monitor-mode-and-notifications` | 監視のモード、通知、指標とアラート、攻撃のダッシュボード |
| `blocked-email-signup-stop` | ブロック中のユーザーと同じメールアドレスでのサインアップの停止、同じ宛先・サインアップのメールの速度の上限 |
| `waf-tuning` | WAF のレート制限の調整、Bot Control、ATP の判断（ATP は法務：L1） |
| `attack-log-events` | 攻撃の防御のイベント（`limit_wc`、`limit_mu`、`pwd_leak` 系、`ap_*`）と失敗のまとめ |
| `k5-simulation` | K5 の模擬のクレデンシャルスタッフィング（[quality.md](quality.md) の 2.2.1 節） |

### E9 ダッシュボード

設計：[dashboard.md](architecture/dashboard.md)、各領域の画面の節

| Story | 内容 |
| --- | --- |
| `dashboard-spa-skeleton` | SPA の骨格（ルーター、生成したクライアント、ja/en、CSP、Trusted Types）とログイン（メモリーのトークン、`prompt=none` の再取得） |
| `dashboard-token-and-roles` | ダッシュボードのトークン、メンバーのロールからのスコープ（`role-scopes.ts`）、予約の枠、画面の出し分け、最小の権限の警告 |
| `dashboard-step-up` | step-up（`auth_time` と `amr` の確認、SPA の再認証） |
| `dashboard-apps-and-quickstart` | テナントの切り替え、クイックスタート（K3）、アプリ・API・許可の画面、本番の点検、秘密の最終の使用 |
| `dashboard-members` | メンバーの招待とロールの割り当て |
| `dashboard-connections-and-mfa` | 接続の設定の画面（IdP ごとの登録の案内）、MFA の方針、ユーザーの認証器の一覧・削除・再設定、登録のチケット |
| `user-search-language` | 検索の問い合わせの言語と索引、検索のレート制限の枠 |
| `dashboard-users-and-sessions` | ユーザーの一覧・検索・詳細・ブロック・削除・リンク、セッションの一覧と取り消し、Back-Channel Logout の失敗の数 |
| `dashboard-branding-and-email` | テーマ・文言の編集とプレビュー、メールのテンプレートの編集・試験の送信、送信の記録と抑止 |
| `dashboard-attack-and-keys` | 攻撃の防御の設定とブロックの一覧、署名鍵の一覧・ローテーション・失効の状態 |
| `dashboard-logs-and-streams` | ログの検索とストリームの Health |
| `dashboard-custom-domains` | カスタムドメインの画面（TXT・CNAME の案内、状態、再確認） |
| `dashboard-audit-and-support` | テナントの監査ログの画面、サポートの参照の許可 |

### E10 ログとログストリーム

設計：[logs-and-streams.md](architecture/logs-and-streams.md)

| Story | 内容 |
| --- | --- |
| `log-ingest` | 取り込み（outbox → SQS → シャードの書き手、`log_id` の採番、スキーマの検証） |
| `logs-api` | `/logs` の検索の文法、オフセット、チェックポイント、`q` との組み合わせ、`/users/{id}/logs` |
| `log-retention-and-pseudonymization` | 保持（テナントの日数、パーティションの `DROP`）、ユーザーの削除時の仮名化、S3 の調査用の保管（法務：L5） |
| `log-stream-webhook` | Webhook のストリーム（カーソル、まとめ、再試行、署名、宛先の検査、Health、停止・再開・開始の位置）（法務：L1・L3） |
| `log-stream-eventbridge` | EventBridge（パートナーのイベントソース、または `PutEvents`） |
| `log-stream-filters-and-masking` | フィルターと伏せ字（HMAC）、作成の step-up と管理者への通知 |
| `domain-log-events` | ユーザー・MFA・セッション・鍵・カスタムドメイン・メールの各イベントと、`api_limit`・`api_limit_warning`・`depnote` |
| `retention-jobs` | 保持と仮名化のジョブ、監査ログのハッシュの連鎖の検証 |
| `log-sli` | ログの反映の SLI（NFR-010） |

### E11 カスタムドメインと送信ドメイン

設計：[custom-domains.md](architecture/custom-domains.md)、[email-delivery.md](architecture/email-delivery.md) の 5.2・7 節

| Story | 内容 |
| --- | --- |
| `custom-domain-core` | `custom_domains` の表とステートマシン、TXT の確認（複数のリゾルバー）、配信のテナントと証明書、`/.well-known` の確認、`ready` の反映の待ち（[ADR-0038](decisions/0038-custom-domain-verification-and-certificates.md)） |
| `custom-domain-monitoring` | 定期の確認（TXT・CNAME・証明書の期限）、警告、`suspended`、削除と 30 日の復活 |
| `custom-domain-constraints` | ドメインの制約と、IDN の混在の拒否 |
| `custom-domain-login-and-links` | カスタムドメインでの画面の表示（ホスト名ごとのトランザクションと Cookie）、確認・再設定のリンク |
| `tenant-sending-domains` | テナントの独自の送信ドメイン（状態、DNS の案内、日次の確認、`degraded`） |
| `tenant-email-providers` | テナントの送信事業者（SMTP、SES のクロスアカウント、接続の試験、SSRF の検査） |

### E12 本番の準備

設計：[capacity.md](architecture/capacity.md)、[infrastructure.md](architecture/infrastructure.md)、[security.md](architecture/security.md) の 10・13 節、[runbooks/](runbooks/README.md)

| Story | 内容 |
| --- | --- |
| `load-tests` | k6 の L1〜L9（[capacity.md](architecture/capacity.md) の 5 節）、Argon2id のパラメーターの決定、台数の確定 |
| `dr-drills` | 計画外のフェイルオーバーと失った範囲のやり直しの訓練、本番の switchover、クォータの引き上げ |
| `key-emergency-drills` | 緊急のローテーションと Signer の侵害の訓練、pepper の復旧の訓練 |
| `break-glass-cli` | 非常用のトークンの CLI と検証、訓練の runbook（[ADR-0037](decisions/0037-break-glass-and-admin-roles.md)） |
| `external-pentest` | 外部のペンテスト（認可サーバー、Universal Login、Management API、Signer の境界）、`security.txt` |
| `openid-certification` | OpenID Foundation の会員の手続き（E12 の前）、公開の staging でのホストされた試験、認証の申請、結果の公開 |
| `rate-limit-overrides-and-review` | 上書きの表と運用、値の見直し、OpenAPI の壊す変更の検査 |
| `slo-and-alert-tuning` | SLO の確定、アラートの調整、DR のダッシュボード、反映の遅れの SLI、Aurora 停止時のキャッシュの障害の注入 |
| `disclosure-api-and-l7` | 開示の API、法務の L7 の結論の反映（法務：L7） |
| `secret-scanning-partner` | 本システムのトークン・秘密の接頭辞を、GitHub のシークレットスキャンのパートナーなどに登録し、通知の受け口と失効の手順を作る（[リポジトリ共通の ADR-0006](../../../docs/decisions/0006-brand-neutral-identifiers.md)、runbook の `secret-leak.md`） |
| `operator-access-jit` | 運用者の期限つきの権限（JIT）の申請・承認・失効と、テナントの許可の確認（[ADR-0056](decisions/0056-operator-access.md)、runbook の `operator-access.md`） |
| `performance-and-csp-monitoring` | 画面の LCP・HTML の大きさの計測、CSP の違反の監視、検索の負荷試験、列挙の時間の差の測定 |
| `edge-and-email-readiness` | カスタムドメインの合成監視と配信のテナントの上限の見直し、大阪の SES への切り替えの訓練 |
| `ga-review` | GA の判定（[quality.md](quality.md) の 5 節の E12 の基準、法務の論点の確定） |

### E13 Actions（MVP の後）

設計：[extensibility.md](architecture/extensibility.md)、[ADR-0048](decisions/0048-extensibility-triggers-and-failure-policy.md)〜[ADR-0050](decisions/0050-extensibility-build-secrets-and-limits.md)

| Story | 内容 |
| --- | --- |
| `actions-poc` | Lambda のテナントの隔離のモードで、コールドスタート・温まった実行の遅延と、費用を計る（着手の最初） |
| `actions-degradation-review` | ADR-0005 の縮退の表の「Actions の実行の基盤」の行のレビュー（PoC の結果で。spec の承認の前提） |
| `actions-account` | `actions` のアカウント、`actions-egress` の VPC と NAT、Lambda の同時実行の引き上げ、実行ロールの SCP |
| `actions-build` | Action とバージョンの Management API、ビルド（CodeBuild、npm のプロキシ、照合、esbuild） |
| `actions-runner` | 実行器（束の取得と照合、`commands` の記録、ログの収集と伏せ字） |
| `actions-invoker` | 秘密の復号、署名付き URL、テナントの同時実行、時限、`on_platform_error` |
| `actions-post-login-and-m2m` | `post-login` と `credentials-exchange` の `api`（クレーム、`deny`、MFA の有効化、メタデータ） |
| `actions-registration-and-async` | `pre-user-registration` と、非同期のトリガー（Worker） |
| `actions-isolation-and-safety` | 隔離のテスト、配備の step-up と管理者への通知、`actions_execution_failed` のログ |
| `dashboard-actions` | Action の編集・試験・配備の画面 |

### E14 Organizations とエンタープライズ接続（MVP の後）

設計：[organizations.md](architecture/organizations.md)、[connections.md](architecture/connections.md) の 6 節、[ADR-0017](decisions/0017-enterprise-connections.md)、[ADR-0051](decisions/0051-organization-model-and-login-flow.md)、[ADR-0052](decisions/0052-organization-tokens-sessions-and-membership.md)

| Story | 内容 |
| --- | --- |
| `organizations-core` | 組織・メンバー・組織のロールの表と Management API（`/organizations`、`/organizations/{id}/members`、`/roles`） |
| `organization-connections` | 組織ごとの接続の有効化、メンバーシップの自動の付与、組織のサインアップ |
| `organization-login-flow` | `organization_usage`・`organization_require_behavior` と、ログインの流れ（`DT-ORG-001`） |
| `organization-selection-screens` | 組織の選択の画面（名前・メール）と、ログインの後の組織の選択、組織のブランド |
| `organization-tokens` | トークンの `org_id`・`org_name`・組織のロール、リフレッシュでのメンバーシップの確認 |
| `organization-invitations` | 招待（ticket、メール、URL、メールアドレスの一致、確認済みの扱い） |
| `organization-callback-placeholder` | `{organization_name}` のコールバックの置き換え |
| `dashboard-organizations` | ダッシュボードの組織の画面と `editor_organizations` のロール |
| `saml-sp` | SAML の SP（ライブラリの選定、検証の規則、XSW の否定側のテスト、`saml_authn_request`） |
| `enterprise-oidc-and-entra` | 汎用の OIDC、Entra ID（`tid` の許可リスト）、Google Workspace（`hd`）、`oidc_client_assertion` |
| `home-realm-discovery` | 振り分けのドメイン（TXT で確認）と Identifier First での振り分け |
| `ldap-connector` | LDAP のコネクタ（配布、相互 TLS、10 秒の打ち切り）。ADR-0005 の LDAP の行のレビュー |
| `admin-tenant-enterprise-sso` | 管理用のテナントに、アカウントごとの企業の IdP での SSO を足す |

## エージェントに任せないこと

- **契約（discovery の値、トークンのクレーム、エラーの形、Management API の形、Signer の API）の確定**：公開した後に変えるコストが最も高い。
- **`security:sensitive` の承認**：Dev のテックリードとセキュリティの担当の 2 人が行う（[ADR-0065](decisions/0065-security-sensitive-change-flow.md)）。
- **署名鍵の緊急のローテーションの判断、本番のテナントへの告知**：セキュリティの担当と Ops（[runbooks/emergency-key-rotation.md](runbooks/emergency-key-rotation.md)）。
- **法務の判断**（L1〜L8、Pwned Passwords、契約の論点）。
- **負荷試験・K5 の模擬の試験の結果の解釈**：数字は出せるが、誤ブロックとの交換の判断と、パラメーターの採否はプロダクトとセキュリティの判断。

## 後回しにしたもの

MVP の後に検討する。着手するときに `intent.md` から起票する（[intent.md](intent.md) の「MVP の後の Epic で扱う」と Non-goals）。E13・E14 に入れなかったもの。

- **ユーザーの一括のインポート・エクスポート**（移行の Epic）：非同期のジョブ、PBKDF2 などのハッシュの取り込み、`user_id` の指定（[users-and-profiles.md](architecture/users-and-profiles.md) の 8 節）。本家の `auth0|...` の `user_id` は顧客のデータとしてそのまま受ける。
- **SCIM 2.0 の受け入れ**：E14 の後（[users-and-profiles.md](architecture/users-and-profiles.md) の 9 節）。最初のバージョンは `Users` だけで、`Groups` は組織のロールの後。
- **PAR・DPoP・トークン交換・mTLS**、FAPI 2.0 の適合（[ADR-0010](decisions/0010-staged-protocol-extensions.md)、[authentication-flows.md](architecture/authentication-flows.md) の 10 節）。`resource`（RFC 8707）はトークン交換と一緒に受け、`audience` と同じ意味に扱う（[authentication-flows.md](architecture/authentication-flows.md) の 14 節）。
- **イントロスペクション（RFC 7662）**：持たないと決めた（[authentication-flows.md](architecture/authentication-flows.md) の 14 節）。需要が出たら新しい ADR で足す。
- **MFA の API**（`/mfa/challenge` など、埋め込み・ネイティブ向け）：[mfa-and-passkeys.md](architecture/mfa-and-passkeys.md) の 8.1 節。
- **SMS・音声の OTP**：法務の L4 の後。SMS pumping の対策とあわせて。
- **パスワードなしのログイン（メールのリンク・コード）**。
- **AAL3**（アテステーションと AAGUID の許可リスト）、**リスクに応じた MFA**（S2）。
- **第三者の CAPTCHA の持ち込み**：法務の L2 の後（[ADR-0026](decisions/0026-bot-detection-and-challenge.md)）。
- **複数のカスタムドメイン**（S2）、**自分で管理する証明書・持ち込みの証明書**（[ADR-0038](decisions/0038-custom-domain-verification-and-certificates.md)）。
- **テナントの限った HTML（ヘッダー・フッター）**（[ADR-0012](decisions/0012-branding-and-templates.md) の 2。入れるときは別の ADR）、サインアップの追加の項目（テキスト・選択・チェックボックス。値は `user_metadata`。[universal-login.md](architecture/universal-login.md) の 17 節）。
- **アカウントの画面（本人の要素・メタデータの管理、My Account の API に相当）**、主の ID の付け替え。仮名の `sub`（pairwise）は持たないと決めた（需要が出たら ADR）。
- **Actions の `api.redirect` とキャッシュ**、送信事業者を Actions で持つ形。
- **組織に結ぶ M2M の許可、組織ごとのアプリの明示の許可**（E14 の後）。
- **トークン交換による AI エージェントの委任、FGA、外部の API のトークンの保管**：需要を見て。
- **S2 の構成**（ユーザー・セッション・リフレッシュトークンのシャード、ログの専用の基盤、RTO 15 分）と **S3 のセル構成**（[infrastructure.md](architecture/infrastructure.md) の 9・11 節）、Nitro Enclaves の再評価、海外のリージョン。

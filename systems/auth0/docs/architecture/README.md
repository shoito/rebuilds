# Architecture: Auth0

全体像と横断的な方針。領域ごとの設計は、同じディレクトリに領域ごとのファイルとして置く。ファイルの一覧、持ち主、ADR の番号の範囲は 7 節にある。品質は [quality.md](../quality.md)、Epic と Story は [roadmap.md](../roadmap.md)、SLO と運用は [runbooks/](../runbooks/README.md) にある。

## 1. 全体構成

### 1.1 コンテキスト

```
 エンドユーザー（ブラウザ・モバイルアプリ・テレビなどの入力の限られた端末）
      │ ログイン・同意・MFA
      ▼
┌──────────── 本システム（テナントごとのホスト名 <tenant>.jp.<brand>.<domain>、またはカスタムドメイン）──┐
│  認可サーバー・Universal Login・Management API・ダッシュボード                                          │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
      ▲ OIDC・OAuth（リダイレクト、/oauth/token）      ▲ Management API          │ 外向き
      │                                                  │                          ▼
 テナントのアプリ（SPA・Web・ネイティブ）            テナントの管理者       ソーシャル IdP（Google・Apple・LINE・GitHub）
 テナントの API（JWKS でアクセストークンを検証）      （ダッシュボード）     メールの送信事業者、ログの送信先（Webhook・EventBridge）
 テナントのバックエンド（M2M、クライアントクレデンシャル）                   Back-Channel Logout の受け手（テナントのアプリ）
```

### 1.2 コンテナ

```
            ┌───────────────── CloudFront＋WAF（IP のレート制限、明らかな攻撃の遮断）─────────────────┐
            │  discovery・JWKS（S3 に書き出したもの。大阪の S3 を予備のオリジンに）、静的な資産           │
            └──────┬──────────────────────────────┬───────────────────────────────┬───────────────┘
                   │ 認証の経路                     │                               │ 管理の経路
                   ▼                                ▼                               ▼
           ┌──────────────┐               ┌────────────────┐              ┌─────────────────┐
           │ Auth（認可    │──相互 TLS───▶│ Signer          │              │ Management API   │◀── Dashboard（SPA）
           │ サーバー）    │  クレーム     │ 秘密鍵はここだけ │              └────────┬────────┘
           │ Universal     │◀─── JWT ─────│ （KMS で復号）   │                       │
           │ Login の画面  │               └────────────────┘                       │
           └──┬───────┬───┘                                                         │
              │       │ セッションのキャッシュ・攻撃の防御の数・レート制限            │
              │       ▼                                                               │
              │   Valkey                                                              │
              ▼                                                                       ▼
        Aurora PostgreSQL（テナントの設定、ユーザー、資格情報、セッション、リフレッシュトークン、RLS）
              │ outbox
              ▼
          Relay ─▶ SQS ─▶ Worker（ログの書き込みとログストリーム、メール、Back-Channel Logout の送信、
                          │       JWKS の書き出し、漏えいしたパスワードのデータの取り込み）
                          ▼
                  Aurora PostgreSQL（ログの専用のクラスタ。認証のイベント、31 日）
```

| コンテナ | 責務 |
| --- | --- |
| Auth | OIDC・OAuth のエンドポイント、Universal Login の画面、接続（データベース・ソーシャル）、MFA、セッション、攻撃の防御の判定。秘密鍵を持たない |
| Signer | テナントの署名鍵の生成・保管・署名と、型を分けた外部 IdP のアサーション（Apple のクライアントシークレットなど）の署名。外からの要求を受けない（[ADR-0003](../decisions/0003-token-formats-and-signing-keys.md)、[ADR-0047](../decisions/0047-signer-api-and-jwks-publishing.md)） |
| Management API | テナント・アプリケーション・API・接続・ユーザー・ログの操作。M2M のアクセストークンで守る |
| Dashboard | テナントの管理者向けの SPA。Management API だけを呼ぶ。管理者は、このシステム自身の管理用のテナントでログインする |
| Worker | 遅れてよい処理。ログインを止めない（[ADR-0005](../decisions/0005-authentication-path-availability.md)） |
| Aurora（主） | 唯一の正本。テナントを RLS で分ける（[ADR-0002](../decisions/0002-tenancy-and-isolation.md)） |
| Aurora（ログ） | 認証のイベントのログの専用のクラスタ。主のクラスタと分け、ログの書き込みと検索がログインに及ばないようにする（[ADR-0043](../decisions/0043-log-storage-and-search.md)） |
| Valkey | キャッシュと数の置き場所。失われてもよい（DB が正本） |

原則は 4 つ。

- **標準に従い、適合試験で確かめる。** 認可サーバーは自前で実装し、暗号の部品は検証済みのライブラリを使う（[ADR-0001](../decisions/0001-platform-and-stack.md)）。
- **テナントで分け、テナントで閉じる。** データも鍵もドメインもテナントに属する（[ADR-0002](../decisions/0002-tenancy-and-isolation.md)）。
- **秘密は平文で持たず、出さない。** 署名の秘密鍵は Signer の外に出ない。資格情報はハッシュか暗号化で持つ（[ADR-0003](../decisions/0003-token-formats-and-signing-keys.md)、[ADR-0004](../decisions/0004-credential-storage.md)）。
- **認証の経路は止めない。** 管理の経路と分け、依存先ごとの縮退を決めておく（[ADR-0005](../decisions/0005-authentication-path-availability.md)）。

## 2. 規模の段階

| 段階 | テナント（うち本番） | エンドユーザー（合計） | 対話のログインのピーク | トークンの発行のピーク | 構成 |
| --- | --- | --- | --- | --- | --- |
| S1（MVP） | 1 万（3,000） | 2,000 万 | 500 件/秒 | 3,000 件/秒（クライアントクレデンシャル・リフレッシュを含む） | 東京の 1 リージョン・3 AZ。主の Aurora の writer 1 台＋reader 2 台。**ログの専用の Aurora のクラスタ**（writer 1 台＋reader 1 台。認証のイベント、1 日 約 1 億件、31 日。[ADR-0043](../decisions/0043-log-storage-and-search.md)）。大阪にウォームスタンバイ（主は Aurora Global Database の二次、ログは headless の二次、マルチリージョンの KMS の鍵） |
| S2 | 10 万（3 万） | 2 億 | 5,000 件/秒 | 30,000 件/秒 | ユーザー・セッション・リフレッシュトークンを、テナントのハッシュで複数の Aurora のクラスタに分ける。大口のテナントを専用のクラスタへ。ログの保存と検索を専用の基盤へ。RTO を 15 分に縮める |
| S3 | 100 万（30 万） | 10 億 | 50,000 件/秒（大型のイベントの集中を含む） | 300,000 件/秒 | セル構成。テナントをセルに固定し、東京・大阪の両方で受ける。大口のテナントに専用のセル。Signer の隔離（Nitro Enclaves など）を再評価。海外のリージョン |

- 数値は本システムの想定。本家の実数は公開の資料で確かめられなかった（未検証）。
- 対話のログインは、パスワードの照合（Argon2id）を伴うものを数える。S1 のピークで Argon2id の計算は 1 秒 500 回で、CPU の必要量は E12 の負荷試験で決める。
- トークンの発行 1 件で、最大 2 回（ID トークンとアクセストークン）署名する。
- 段階を上げる判断の基準は [infrastructure.md](infrastructure.md) の 9 節、台数は同じく 5 節、負荷のモデルは [capacity.md](capacity.md)。

## 3. 非機能要件

| ID | 項目 | S1 の目標 | 備考 |
| --- | --- | --- | --- |
| NFR-001 | 認証の経路の可用性（[ADR-0005](../decisions/0005-authentication-path-availability.md) の定義のエンドポイント） | 月間 99.99%（本番のテナント） | 本家の Enterprise の SLA と同じ（[Auth0 Pricing](https://auth0.com/pricing)、2026-09-27 に確認）。開発・ステージングのテナントは対象外 |
| NFR-002 | ログインの処理時間 | パスワードの送信から応答まで p99 500ms 以内。`/authorize` からログインの画面の表示まで p99 300ms 以内 | Argon2id を含む。外部の IdP とメールの待ちを除く |
| NFR-003 | トークンの発行 | `/oauth/token` の p99 150ms 以内（Signer を含む）。1 秒 3,000 件を捌く | S2 は 30,000 件/秒 |
| NFR-004 | 管理の経路 | Management API の可用性 月間 99.9%、p99 500ms 以内（一覧・検索・ログを除く） | 認証の経路とは別に測る |
| NFR-005 | 耐久性と AZ の障害 | 成功を返したユーザーの作成、資格情報と設定の変更を失わない。RPO 0、RTO 5 分以内 | 切り替えの間も、ADR-0005 の縮退で一部が続く |
| NFR-006 | リージョンの障害 | RPO 1 分以内、RTO 1 時間以内 | S2 で RTO 15 分以内（本家の Private Cloud の値に寄せる） |
| NFR-007 | 秘密の保護 | パスワード・クライアントシークレット・トークン・TOTP の種を平文で保存しない。ログ・トレースに出た件数 0 件。署名の秘密鍵は Signer の外に平文で出ない | [ADR-0003](../decisions/0003-token-formats-and-signing-keys.md)、[ADR-0004](../decisions/0004-credential-storage.md) |
| NFR-008 | テナントの分離 | 他のテナントのデータが見える事象、他のテナントの鍵で署名される事象が 0 件 | [ADR-0002](../decisions/0002-tenancy-and-isolation.md) |
| NFR-009 | 標準への準拠 | 対象のプロファイルの適合試験が、`main` の CI で常に通る。GA の前に OpenID Certification | [ADR-0001](../decisions/0001-platform-and-stack.md) |
| NFR-010 | ログの反映と配信 | イベントから Management API のログの検索に出るまで p95 30 秒以内。ログストリームの最初の送信 p95 60 秒以内。少なくとも 1 回届ける | 本家も少なくとも 1 回で、順序は保証しない（[Log Streams](https://auth0.com/docs/customize/log-streams)、2026-09-27 に確認） |

## 4. 技術スタック

| 層 | 選定 | 理由 |
| --- | --- | --- |
| 言語 | TypeScript（サービス・Web） | 他の題材と同じ。型でプロトコルのパラメーターとクレームを守る（[ADR-0001](../decisions/0001-platform-and-stack.md)） |
| HTTP・検証 | Hono＋Zod。Management API は `@hono/zod-openapi` で OpenAPI を出す | 他の題材と同じ |
| Universal Login | サーバーで HTML を組み立てる（Hono の JSX）。JavaScript は最小 | 速さと厳しい CSP（[ADR-0011](../decisions/0011-universal-login-rendering-and-transaction.md)） |
| JOSE | `jose` | [ADR-0001](../decisions/0001-platform-and-stack.md) |
| WebAuthn | `@simplewebauthn/server` | 保守されている。E7 の着手時に基準を確かめ、満たさないときだけ見直す（[ADR-0022](../decisions/0022-webauthn-and-passkeys.md)） |
| パスワード | Argon2id のネイティブのバインディング、bcrypt の照合 | [ADR-0004](../decisions/0004-credential-storage.md) |
| DB | Aurora PostgreSQL 18（主とログの 2 つのクラスタ）、RLS、ID は UUIDv7 | [ADR-0002](../decisions/0002-tenancy-and-isolation.md)、[ADR-0043](../decisions/0043-log-storage-and-search.md) |
| キャッシュ・数 | ElastiCache（Valkey） | 失われてもよい（[ADR-0005](../decisions/0005-authentication-path-availability.md)） |
| 非同期 | transactional outbox → SQS | 他の題材と同じ |
| 鍵 | KMS（署名鍵の専用の鍵、資格情報の鍵、pepper の鍵、保存の鍵。マルチリージョン）、Signer | [ADR-0003](../decisions/0003-token-formats-and-signing-keys.md)、[ADR-0045](../decisions/0045-kms-key-hierarchy.md) |
| エッジ | CloudFront、AWS WAF、ACM | discovery・JWKS の配布、カスタムドメイン |
| 実行基盤 | AWS（東京、DR は大阪）、ECS Fargate | 他の題材と同じ |
| IaC | Terraform | 他の題材と同じ |
| 可観測性 | OpenTelemetry（ADOT）→ AMP、X-Ray、CloudWatch Logs | 他の題材と同じ。秘密を出さない計装は [ADR-0061](../decisions/0061-secret-free-telemetry.md) |
| フラグ | AWS AppConfig | 他の題材と同じ |
| 適合試験 | OpenID Foundation の conformance suite（CI の中で動かす）、node-oidc-provider との差分テスト | [ADR-0001](../decisions/0001-platform-and-stack.md) |
| テスト | Vitest、fast-check、Testcontainers、Playwright（仮想の WebAuthn の認証器） | 他の題材と同じ |

## 5. 主な決定

どれも `accepted`（0001〜0005 は 2026-09-27 に `proposed` から改めた）。状態の一覧は [decisions/README.md](../decisions/README.md)。

| ADR | 決定 |
| --- | --- |
| [0001](../decisions/0001-platform-and-stack.md) | 共通の基盤の上に、検証済みの部品で認可サーバーを自前で実装する |
| [0002](../decisions/0002-tenancy-and-isolation.md) | テナントを分離と設定の単位にし、共有スキーマと RLS で分ける |
| [0003](../decisions/0003-token-formats-and-signing-keys.md) | アクセストークンと ID トークンはテナントの鍵で署名した JWT にし、秘密鍵は Signer の中だけで使う |
| [0004](../decisions/0004-credential-storage.md) | パスワードは Argon2id、高エントロピーの秘密はハッシュ、戻す必要のある秘密はエンベロープ暗号化で持つ |
| [0005](../decisions/0005-authentication-path-availability.md) | 認証の経路を管理の経路から分け、依存先が落ちても縮退して動かし続ける |
| [0006](../decisions/0006-authorization-code-pkce-and-exact-redirect.md) | 認可の要求は認可コード＋PKCE（S256）だけにし、`redirect_uri` は完全一致で照合する |
| [0007](../decisions/0007-client-authentication-methods.md) | クライアントの認証は `client_secret_basic`・`client_secret_post`・`private_key_jwt`・`none` にし、秘密で署名する方式は持たない |
| [0008](../decisions/0008-token-lifetimes-and-claims.md) | トークンの有効期間の既定と上限を決め、アクセストークンは 1 つの API に宛てる |
| [0009](../decisions/0009-device-authorization-grant.md) | デバイスの認可は RFC 8628 に従い、BASE20 の 8 文字のユーザーコードと、明示の確認の画面で行う |
| [0010](../decisions/0010-staged-protocol-extensions.md) | PAR・DPoP・トークン交換・mTLS は、MVP の後に、認可コードの経路の上にフラグで足す |
| [0011](../decisions/0011-universal-login-rendering-and-transaction.md) | Universal Login はサーバーで描く HTML にし、ログインの途中の状態はサーバーのトランザクションに持って、ブラウザの Cookie に結び付ける |
| [0012](../decisions/0012-branding-and-templates.md) | ブランディングはテーマの変数と文言の上書きに限り、テナントの任意の HTML・JavaScript は画面に入れない |
| [0013](../decisions/0013-consent-records.md) | 規約への同意は、文書のバージョンごとに追記だけの表に記録し、記録の成功をサインアップの完了の条件にする |
| [0014](../decisions/0014-connection-abstraction.md) | 接続を「資格情報を確かめて外部の ID を返す部品」として抽象化し、ユーザーとは ID で結ぶ |
| [0015](../decisions/0015-database-connection-password-and-enumeration.md) | データベース接続は NIST SP 800-63B-4 のパスワードの規則に従い、サインアップ・ログイン・再設定でアカウントの有無を明かさない |
| [0016](../decisions/0016-social-connections-and-idp-tokens.md) | ソーシャル接続は共通の OAuth・OIDC のクライアントと IdP ごとの差分で作り、IdP のトークンは既定で保存しない |
| [0017](../decisions/0017-enterprise-connections.md) | エンタープライズ接続（MVP の後）は、SAML の SP を保守されたライブラリで作り、LDAP は外向きにだけつなぐコネクタで受ける |
| [0018](../decisions/0018-user-identifier-and-profile-store.md) | ユーザーの ID は接続から独立した不透明な値にし、再利用しない。メタデータに固い上限を置く |
| [0019](../decisions/0019-account-linking.md) | ID のリンクは両方の ID での本人の認証を必須にし、メールアドレスの一致だけでは自動にリンクしない |
| [0020](../decisions/0020-user-search-and-lifecycle.md) | ユーザーの検索は Aurora の reader の上の限られた言語で行う。ブロックと削除は状態機械で扱い、削除した ID を墓標で守る |
| [0021](../decisions/0021-authenticator-model-and-assurance-levels.md) | MFA の要素を認証器の共通の型で持ち、達成した AAL を `acr` で返す。メールの OTP は AAL2 に数えない |
| [0022](../decisions/0022-webauthn-and-passkeys.md) | WebAuthn は保守されたライブラリで検証し、RP ID をテナントで固定する。UV 付きのパスキーは単独で MFA を満たす |
| [0023](../decisions/0023-otp-and-recovery-codes.md) | TOTP は RFC 6238 の既定で再利用を拒む。リカバリーコードは Argon2id、メールの OTP は鍵付きハッシュで保存し、どちらも試行の上限で守る |
| [0024](../decisions/0024-attack-protection-counters-and-enforcement.md) | 攻撃の防御の判定をハッシュの前の 1 つの段にまとめ、数は Valkey、ブロックは DB に持つ。識別子の HMAC と既知の端末の Cookie で数える |
| [0025](../decisions/0025-breached-password-detection.md) | 漏えいしたパスワードは k-匿名性で照合する。データの自前のホストは利用条件の確認を条件にし、確認までは公式の range API を使う |
| [0026](../decisions/0026-bot-detection-and-challenge.md) | ボットの検知は自前のリスクの点数と自前の proof-of-work のチャレンジで行う。WAF はエッジの後ろ盾、第三者の CAPTCHA は法務の L2 の後 |
| [0027](../decisions/0027-server-side-sessions.md) | セッションはサーバーの側に持ち、`__Host-` の Cookie には不透明な秘密だけを入れる |
| [0028](../decisions/0028-logout-rp-initiated-and-back-channel.md) | ログアウトは RP-Initiated と Back-Channel を出し、Back-Channel は Worker が再試行ごとにトークンを作り直して送る |
| [0029](../decisions/0029-refresh-token-session-binding.md) | リフレッシュトークンの系列は、アプリの設定でセッションに結び付けるか独立にするかを決める |
| [0030](../decisions/0030-accounts-tenants-and-members.md) | テナントの上にアカウントを置き、テナントの名前は再利用せず、環境は昇格だけを許す |
| [0031](../decisions/0031-application-and-api-registration.md) | アプリの種類でクライアントの認証とグラントの上限を決め、コールバックはワイルドカードなしにし、M2M はアプリ × API の許可で守る |
| [0032](../decisions/0032-tenant-config-cache.md) | テナントの設定はバージョン付きの不変のスナップショットでタスクに持ち、pub/sub とポーリングで最大 15 秒で反映する |
| [0033](../decisions/0033-management-api-shape.md) | Management API は本家に寄せた `/api/v2` のリソースにし、2 種のページングを持ち、v2 の中では足す変更だけをする |
| [0034](../decisions/0034-management-api-authorization.md) | Management API は 3 種のトークンを受け、M2M は要求ごとに今の許可を確かめ、自分より広い許可を作らせない |
| [0035](../decisions/0035-rate-limiting.md) | レート制限は本家の単位と Enterprise の値に寄せ、環境で変えてプランで変えず、Valkey の GCRA で数え、リフレッシュを優先する |
| [0036](../decisions/0036-dashboard-login-via-admin-tenant.md) | ダッシュボードは静的な SPA にし、管理者は本システムの管理用のテナントでログインする |
| [0037](../decisions/0037-break-glass-and-admin-roles.md) | 非常用の経路はテナントの M2M と KMS で署名した運用者の短いトークンにし、ロールは本家に寄せる |
| [0038](../decisions/0038-custom-domain-verification-and-certificates.md) | カスタムドメインは TXT で所有を確かめてから配信のテナントを作り、証明書は CloudFront の管理に任せる |
| [0039](../decisions/0039-hostname-resolution-and-issuer.md) | ホスト名からテナントを、DB を読まずにプロセスの中の対応表で解決し、リンクとリダイレクトは要求のヘッダーではなく登録したホスト名から作る |
| [0040](../decisions/0040-email-sending-platform.md) | メールは Amazon SES（東京）から、テナントごとの SES のテナントと送信ドメインの認証を付けて送り、認証のメールを優先の列で送る |
| [0041](../decisions/0041-email-templates-and-tenant-providers.md) | メールのテンプレートは自動でエスケープする制限した Liquid で書かせ、リンクは本システムが作る。テナントの送信事業者は SMTP と SES（クロスアカウント）に限る |
| [0042](../decisions/0042-log-event-model-and-type-codes.md) | 認証のイベントは本家の公開のスキーマと種類のコードに寄せ、`log_id` はテナントの中でコミットの順に単調にする |
| [0043](../decisions/0043-log-storage-and-search.md) | S1 のログはログの専用の Aurora のクラスタに置き、本家の検索の部分集合を索引で返し、保持はテナントの属性で切る |
| [0044](../decisions/0044-log-stream-delivery.md) | ログストリームはストリームごとのカーソルで少なくとも 1 回送り、Webhook に本文の署名を足す |
| [0045](../decisions/0045-kms-key-hierarchy.md) | KMS の鍵を用途ごとに 4 つに分け、暗号化の文脈とキーポリシーで使える主体を限る |
| [0046](../decisions/0046-signing-key-lifecycle.md) | 署名鍵は `next`・`current`・`previous`・`revoked` で持ち、`next` を先に配ってから切り替える |
| [0047](../decisions/0047-signer-api-and-jwks-publishing.md) | Signer はテナントの 3 つの種類のトークンと、型を分けた外部 IdP のアサーションだけに署名し、JWKS は Worker が S3 に書き出してエッジで配る |
| [0048](../decisions/0048-extensibility-triggers-and-failure-policy.md) | 拡張のトリガーは同期 3 つと非同期 2 つから始め、同期は全体 10 秒、基盤の障害はテナントが拒否か飛ばすかを選ぶ |
| [0049](../decisions/0049-extensibility-execution-isolation.md) | テナントのコードは Lambda のテナントの隔離のモードの共通の実行器で動かし、実行ロールに権限を持たせない |
| [0050](../decisions/0050-extensibility-build-secrets-and-limits.md) | npm の依存は隔離したビルドで束ね、秘密は呼び出しの本文でだけ渡し、上限は本家に寄せる |
| [0051](../decisions/0051-organization-model-and-login-flow.md) | 組織はテナントの中のメンバーシップの単位にし、ログインの流れは本家の設定を決定表で持つ |
| [0052](../decisions/0052-organization-tokens-sessions-and-membership.md) | 組織の文脈のトークンに `org_id` を入れ、リフレッシュの系列を組織に結んでメンバーシップを毎回確かめる |
| [0053](../decisions/0053-rfc9700-checklist-and-negative-tests.md) | RFC 9700 の要件と脅威モデルを要件 ID の表にし、要件ごとに拒否の側のテストを持つ |
| [0054](../decisions/0054-audit-log.md) | 管理と運用の操作の監査ログは、認証のイベントのログと分け、操作と同じトランザクションで書いて改ざんできない保管庫へ送る |
| [0055](../decisions/0055-data-retention-and-deletion.md) | データの保持の既定案を持ち、エンドユーザーの削除は資格情報を先に即時に消し、バックアップの期限を削除の最終の期限にする |
| [0056](../decisions/0056-operator-access.md) | 社内の運用者は本番に常設の権限を持たず、テナントのデータの参照はテナントの許可と期限つきの権限で行う |
| [0057](../decisions/0057-accounts-network-and-path-separation.md) | AWS のアカウントを用途で分け、認証の経路と管理の経路を入口・ALB・DB の接続まで分ける |
| [0058](../decisions/0058-edge-and-custom-domains.md) | エッジは CloudFront＋WAF にし、カスタムドメインは CloudFront のマルチテナントの配信のテナントとして受ける |
| [0059](../decisions/0059-signer-isolation.md) | Signer を外への経路のない専用のサブネットに置き、呼べるのは Auth のタスクだけにする |
| [0060](../decisions/0060-disaster-recovery-and-stages.md) | 大阪のウォームスタンバイへ人の判断で切り替え、失った範囲のセキュリティを強める操作をやり直す。S3 でテナントをセルに固定する |
| [0061](../decisions/0061-secret-free-telemetry.md) | 計装は許可リストの型を通したものだけを出し、秘密の形をログ・トレース・アクセスログの 4 か所で防ぐ |
| [0062](../decisions/0062-sli-and-synthetic-monitoring.md) | 認証の経路の SLI は本番のテナントの要求をエッジとサーバーの両方で数え、4xx と方針の 429 を成功、過負荷の 503 を失敗にする |
| [0063](../decisions/0063-cpu-bound-work-sizing.md) | Argon2id は Auth のタスクの中の固定の数のスレッドで計算し、Signer は鍵を遅延で読み込んで上限つきで持つ |
| [0064](../decisions/0064-conformance-suite-in-ci.md) | OpenID Foundation の適合試験を CI の中で自前で動かし、認証の経路の PR の必須のチェックにする |
| [0065](../decisions/0065-security-sensitive-change-flow.md) | `security:sensitive` の変更は、パスで自動にラベルを付け、作成者と別の 2 人の人の承認と、追加の CI の段を必須にする |
| [0066](../decisions/0066-tenant-canary-release.md) | 認証の経路の振る舞いの変更は、テナントを単位に、社内・開発の環境・本番の順で広げ、認証の成功率のガードで自動で止める |

領域ごとの ADR は、7 節の番号の範囲で起票する。リポジトリ共通の決定（開発プロセス、ブランチモデル、本家の名前・接頭辞を使わない規則の [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）は、ルートの [docs/decisions/](../../../../docs/decisions/README.md) にある。

## 6. リスクと未解決事項

品質の面のリスクの順位と対策は [quality.md](../quality.md) の 1 節にある。ここは設計の面のリスクを書く。

- **認可サーバーの実装の誤り**：`redirect_uri` の照合、`state`・`nonce`・PKCE の検証、mix-up 攻撃、コードの再利用、オープンリダイレクトの誤りは、そのまま脆弱性になる。適合試験（[ADR-0064](../decisions/0064-conformance-suite-in-ci.md)）、RFC 9700 のチェックリストと否定側のテスト（[security.md](security.md) の 4 節、[ADR-0053](../decisions/0053-rfc9700-checklist-and-negative-tests.md)）、差分テスト、E12 の外部のペンテストで抑える。
- **署名鍵の漏えい**：1 テナントの鍵が漏れると、そのテナントの全ユーザーになりすませる。Signer への集約（[ADR-0003](../decisions/0003-token-formats-and-signing-keys.md)、[ADR-0059](../decisions/0059-signer-isolation.md)）と、緊急のローテーションの手順（[runbooks/emergency-key-rotation.md](../runbooks/emergency-key-rotation.md)）で備える。Signer のメモリーに鍵が平文で載ることは残る。外部 IdP のアサーションの用途（[ADR-0047](../decisions/0047-signer-api-and-jwks-publishing.md)）で、Signer の中の鍵の種類が増えた。
- **テナントの分離の破れ**：共有スキーマの RLS のコンテキストの漏れ、ホスト名の解決の取り違え、組織（E14）の境界。RLS の性質ベーステスト、テナントの外の表の一覧（[data-model.md](data-model.md) の 3 節）、`DT-ORG-001` で抑える。
- **クレデンシャルスタッフィングとボット**：攻撃の防御（E8、[attack-protection.md](attack-protection.md)）で抑える。日本の携帯の回線の CGNAT での誤ブロック（K5 の 0.1%）が最も読めない。既知の端末の Cookie と監視のモードで調整する。
- **漏えいしたパスワードの照合の外部の依存**：法務の確認まで、公式の range API（国外）への同期の依存が認証の経路に残る（[ADR-0025](../decisions/0025-breached-password-detection.md)）。止まるとサインアップ・変更・再設定が 503 になる（ADR-0005 の表）。
- **ログインの CPU の費用**：Argon2id は、攻撃の時に計算の量で DoS になりうる。防御の判定をハッシュの前に置き、同時実行に上限を置く（[ADR-0004](../decisions/0004-credential-storage.md)、[ADR-0063](../decisions/0063-cpu-bound-work-sizing.md)）。Node.js での実測は E12 で行う。
- **大口のテナントの偏り**：数百万のユーザーを持つテナントや、M2M のトークンを大量に求めるテナントが、共有の DB を占有しうる。テナント単位のレート制限（[ADR-0035](../decisions/0035-rate-limiting.md)）と、S2 のシャードで抑える。
- **設定の反映の遅れ**：失効させたクライアントの秘密・消したコールバックが最大 15 秒通る（[ADR-0032](../decisions/0032-tenant-config-cache.md)）。受け入れた。反映の遅れを SLI で見る。
- **メールの到達性**：確認・再設定・OTP のメールが迷惑メールになると、サインアップと再設定が止まる。送信ドメインの認証、SES のテナントでの分離、到達性の合成監視で備える（[email-delivery.md](email-delivery.md)）。
- **外部の IdP の変化**：Apple の非公開のメールの中継、LINE のメールアドレスの取得の申請（審査の期間は未検証）と、LINE の ID トークンに確認済みのクレームがないこと、各社の仕様の変更に追従が要る。
- **自分で自分を使う**：ダッシュボードの管理者のログインが、このシステムの障害で止まる。非常用の経路（[ADR-0037](../decisions/0037-break-glass-and-admin-roles.md)）と年 2 回の訓練で備える。
- **テナントのコードの隔離（E13）**：Actions の隔離の破れは、他のテナントの秘密と利用者に届く。Lambda のテナントの隔離のモード、権限のない実行ロール、別のアカウント（[ADR-0049](../decisions/0049-extensibility-execution-isolation.md)、[ADR-0057](../decisions/0057-accounts-network-and-path-separation.md)）で抑え、隔離のテストを定期に回す。Lambda の可用性（SLA は月間 99.95%。[AWS Lambda SLA](https://aws.amazon.com/lambda/sla/)、2026-09-27 に確認）が、Action を使うテナントの NFR-001 に効く。
- **リージョンの障害で失う書き込み**：失効した鍵・変えたパスワードが大阪で有効に戻りうる。失った範囲のやり直し（[ADR-0060](../decisions/0060-disaster-recovery-and-stages.md)）と四半期の訓練で抑える。
- **法令**：法務の確認待ちの事項がある（[intent.md](../intent.md) の「法務の確認待ち」の L1〜L8 と、Pwned Passwords・契約の論点）。結論が出るまで、そこに挙げた Epic の spec を承認しない。

### 決定（2026-09-27、既定案）

PM の方針（本家 Auth0 に寄せる、既定案で進める）により、統合の工程で次のとおり決めた。法務の判断が要るものは決めず、[intent.md](../intent.md) の「法務の確認待ち」に集めた。計測・PoC・選定で決めるものは、下の「持ち越し」に置いた。

- **ADR の状態**：基盤の ADR（0001〜0005）を、他の題材と同じく `accepted` にした（2026-09-27）。先に、ADR-0005 の NFR の番号（リージョンの障害は NFR-006）と縮退の表（漏えいしたパスワードの照合、Actions の実行の基盤、LDAP のコネクタ、エンタープライズの IdP）を直し、ADR-0004 を ADR-0025 に揃えた。intent.md も `accepted` にした。
- **本家の名前・接頭辞を使わない**（リポジトリ共通の ADR-0006）。ヘッダー・Cookie・ドメイン・接頭辞・クレームの名前空間は `<Brand>`・`<brand>`。本家から移るテナントの `auth0|...` の `user_id` は、テナントの顧客のデータとして受け取り、そのまま `sub` にする（本システムが作る識別子ではない。[users-and-profiles.md](users-and-profiles.md) の 3.1 節）。ログの種類のコード（`s`、`fp` など）と `/mfa/challenge`・`org_` のような一般の名前は、本家の名前を含まないので使う。
- **適合試験の対象**：OP の Basic・Config・Form Post・RP-Initiated Logout・Back-Channel Logout。Form Post を加え（intent の K2 の「未定」を埋めた）、Dynamic は持たない。GA の判定は `main` の夜間で 7 日続けて通ること（[quality.md](../quality.md)）。
- **漏えいしたパスワード**：法務の確認までは公式の range API を使い、自前のホストは確認の後（ADR-0025 を正とし、ADR-0004・connections.md・attack-protection.md を揃えた）。
- **Signer の範囲**：テナントのトークン（ID・アクセス・ログアウト）に加え、**型を分けた外部 IdP のアサーション**（`apple_client_secret`、`oidc_client_assertion`、`saml_authn_request`）に署名する。接続ごとの鍵（`external_idp_keys`）を使い、宛先と有効期間は Signer が登録の値から決める（ADR-0047、[keys-and-secrets.md](keys-and-secrets.md) の 6.3 節、security.md）。Signer の DB のロールは 4 つの表（ADR-0059 を揃えた）。
- **HSTS**：本システムのドメインは `includeSubDomains` 付き。カスタムドメインには HSTS を付けるが `includeSubDomains`・`preload` は付けない（custom-domains.md を正とし、security.md の SEC-024 を直した）。
- **AWS のアカウント**：Actions のための `actions` のアカウントを足した（ADR-0057、infrastructure.md）。作るのは E13 の着手時。
- **MFA の API**（`/mfa/challenge` など、埋め込み・ネイティブ向け）：MVP では持たず、MVP の後に扱う形を [mfa-and-passkeys.md](mfa-and-passkeys.md) の 8.1 節に書いた。
- **データベース接続の `authentication_methods`**（`password`・`passkey`）：connections.md の 4.1.1 節に足した（パスキーだけのユーザーを作るための設定）。
- **組織ごとのカスタムドメイン**：持たない（organizations.md、ADR-0051 を正とし、custom-domains.md の E14 の Story を外した）。
- **ログインのトランザクションの用語**：`login_transactions` の行を「トランザクション」、その参照の乱数を「handle」と呼び、画面の URL の `state` で運ぶ。アプリの OAuth の `state` とは別物（authentication-flows.md の 5.4 節、universal-login.md の 4 節）。
- **データモデル**：クライアントの資格情報は `client_credentials` の 1 つの表、`refresh_token_families` は 1 つの定義にまとめ、ユーザーを指す列は `user_pk` に揃え、テナントの外の表を理由とともに列挙した（[data-model.md](data-model.md) の 3・9 節）。
- **ログの種類のコード**：本家に同じ意味のコードがあればそれを使い（`limit_wc`、`limit_mu`、`pwd_leak` など）、ないものは `ap_*` などの独自のコードにする（ADR-0042。attack-protection.md の 8 節を揃えた）。Back-Channel Logout の失敗は `oidc_backchannel_logout_failed`。
- **Epic**：E13 は Actions、E14 は Organizations とエンタープライズ接続。インポート・エクスポート、SCIM、PAR・DPoP・トークン交換・mTLS、SMS、MFA の API は「後回し」（[roadmap.md](../roadmap.md)）。
- **数値の正本**：レート制限は [management-api-and-rate-limiting.md](management-api-and-rate-limiting.md) の 6 節。トークンの有効期間は [ADR-0008](../decisions/0008-token-lifetimes-and-claims.md)。セッションは使われない期間 3 日・最終の期限 7 日（[ADR-0027](../decisions/0027-server-side-sessions.md)）。JWKS のキャッシュは RP 300 秒・CloudFront 60 秒・オリジンの障害中 24 時間（[ADR-0047](../decisions/0047-signer-api-and-jwks-publishing.md)）。設定の反映は最大 15 秒（ADR-0032）。保持の期間は [security.md](security.md) の 9 節。SLO とアラートは [runbooks/README.md](../runbooks/README.md) の 1・4 節。
- **検証の工程の後の既定案**（2026-09-27）：
  - 認証のイベントのログの `user_name` には、本家と同じくメールアドレスを載せる。保持は `log_retention_days`、ストリームでは伏せ字を選べる（[logs-and-streams.md](logs-and-streams.md) の 3.1 節、[users-and-profiles.md](users-and-profiles.md)）。
  - 429 は方針の制限だけに使い、理由を `<Brand>-RateLimit-Reason`（`tenant`・`endpoint`・`user`・`concurrency`・`attack_protection`）で示す。過負荷・依存先の都合は 503 にする（[management-api-and-rate-limiting.md](management-api-and-rate-limiting.md) の 7.2 節、ADR-0062・ADR-0005 の注記）。
  - Cookie はすべて `__Host-` の接頭辞にする（`__Host-<brand>_did`・`__Host-<brand>_mfa_rd` を含む。一覧は [sessions-and-sso.md](sessions-and-sso.md) の 3.1 節）。
  - `consent_records` は `user_pk` で参照する（ADR-0013、[data-model.md](data-model.md) の 2 節）。
  - 署名鍵のローテーションの API の制限は、本家と同じバースト 5・1 日 5 にする（ADR-0046 の注記）。
- **訓練の頻度**：1 テナントの緊急のローテーションは四半期（ADR-0046 と keys-and-secrets.md に揃え、runbook を直した）。DR の計画外のフェイルオーバーは四半期、本番の switchover は年 1 回（ADR-0060）。
- 領域ごとの決定は、各文書の「決定」の節にある：[authentication-flows.md](authentication-flows.md) の 14 節、[universal-login.md](universal-login.md) の 17 節、[connections.md](connections.md) の 13 節、[users-and-profiles.md](users-and-profiles.md) の 16 節、[mfa-and-passkeys.md](mfa-and-passkeys.md) の 15 節、[attack-protection.md](attack-protection.md) の 17 節、[sessions-and-sso.md](sessions-and-sso.md) の 13 節、[tenants-and-applications.md](tenants-and-applications.md) の 13 節、[management-api-and-rate-limiting.md](management-api-and-rate-limiting.md) の 14 節、[dashboard.md](dashboard.md) の 12 節、[custom-domains.md](custom-domains.md) の 12 節、[email-delivery.md](email-delivery.md) の 16 節、[logs-and-streams.md](logs-and-streams.md) の 12 節、[keys-and-secrets.md](keys-and-secrets.md) の 13 節、[extensibility.md](extensibility.md) の 13 節、[organizations.md](organizations.md) の 13 節。

### 決定（2026-09-27、推奨案で確定）

PM の方針（判断が要るところは推奨案で進める）により、法務以外の確認待ち・持ち越しを、次のとおり決めた。法務の確認待ちと、法務の結論に依るもの、計測・PoC が要るものは、下の「持ち越し」に残した。

- **`private_key_jwt` の `aud`**：`issuer` だけを受ける。`draft-ietf-oauth-rfc7523bis` に合わせる。移るクライアントのために、アプリごとの互換のフラグ `legacy_token_endpoint_aud`（既定は無効、GA から 12 か月で廃止）を置く（[authentication-flows.md](authentication-flows.md) の 6.1・14 節、[ADR-0007](../decisions/0007-client-authentication-methods.md) の注記、[tenants-and-applications.md](tenants-and-applications.md) の `clients`）。
- **外向きの `oidc_client_assertion` の `aud`**：同じ規則で、IdP の `issuer` にする。主要な IdP が受けるかは E14 で確かめる（[keys-and-secrets.md](keys-and-secrets.md) の 6.3・13 節）。
- **429 と 503 の分け方**：ADR-0005 の注記（429 は方針の制限、503 は過負荷・依存先の都合）を承認した。SLI を状態コードだけで分けられる（[ADR-0005](../decisions/0005-authentication-path-availability.md)、[ADR-0062](../decisions/0062-sli-and-synthetic-monitoring.md)）。
- **OpenID Foundation の会員**：E12 の前に会員になる。認証の費用は会員 700 USD・非会員 3,500 USD で、プロファイルが 5 つある（[intent.md](../intent.md)、[ADR-0064](../decisions/0064-conformance-suite-in-ci.md)、[roadmap.md](../roadmap.md) の E12）。
- **適合試験の Form Post**：対象に含める。PM の決定として確定した（[authentication-flows.md](authentication-flows.md) の 13.3・14 節、intent の K2）。
- **統合で足した値**：列挙の時間の差の p90 10%（QA。[quality.md](../quality.md) の 2.2.1 節、[ADR-0015](../decisions/0015-database-connection-password-and-enumeration.md)）、`refresh_token_families.rotation` の列（Dev。[data-model/login-and-sessions.md](data-model/login-and-sessions.md) の 2 節）、Story の名前（PM。[roadmap.md](../roadmap.md)）、runbook の名前（Ops。[runbooks/](../runbooks/README.md)）を、そのまま受け入れた。
- **漏えいしたパスワードの予備の案**：公式の range API を使う間の ADR-0005 の縮退の表の行を、Dev のテックリードの確認として確定した（[attack-protection.md](attack-protection.md) の 17 節）。
- **イントロスペクション**：持たない。JWT を JWKS で確かめる形で足りる（[authentication-flows.md](authentication-flows.md) の 14 節）。
- **`resource`（RFC 8707）**：MVP では受けない。トークン交換で受けるときは `audience` と同じ意味に扱う（同上）。
- **同意の画面の一部の許可**：持たない。まとめて許すか断るかにし、形を単純に保つ（同上）。
- **JWKS の `x5c`**：載せない。OIDC の検証に要らない（[keys-and-secrets.md](keys-and-secrets.md) の 13 節）。
- **耐量子の署名**：S1 では持たない。標準化を待つ（同上）。
- **セッション**：アプリごとの有効期間の上書きは持たない。`federated` のログアウトは E14 で扱う。パスワードの変更・再設定で他のセッションを既定で終える。端末の記憶は別の Cookie。Back-Channel Logout の出口は `worker-egress`（[sessions-and-sso.md](sessions-and-sso.md) の 13 節、[connections.md](connections.md) の 13 節）。
- **K3 の測り方**：データベース接続だけで測る。開発者キーを持たないため（[connections.md](connections.md) の 13 節）。
- **よく使われるパスワードの一覧**：本家と同じ SecLists の 1 万件（同上）。
- **ライブラリ**：WebAuthn は `@simplewebauthn/server`、SAML は第一候補を `@node-saml/node-saml` にする。どちらも着手時に基準を確かめ、満たさないときだけ見直す（4 節、[mfa-and-passkeys.md](mfa-and-passkeys.md) の 15 節、[connections.md](connections.md) の 13 節）。
- **MFA**：BE=1 を拒む設定は AAL3 と一緒に S2 以降。アカウントの画面は MVP の後。IdP の `amr`・`acr` は既定で引き継がない（[mfa-and-passkeys.md](mfa-and-passkeys.md) の 15 節）。
- **Public Suffix List**：`jp.<brand>.<domain>` を登録し、テナントのホスト名を互いに別の site にする。防御は登録に頼らない（[universal-login.md](universal-login.md) の 17 節、[custom-domains.md](custom-domains.md) の 12 節）。
- **ブランディング**：テナントの任意の HTML は MVP で入れない。サインアップの追加の項目は MVP の後に 3 つの型で足し、`user_metadata` に保存する（[universal-login.md](universal-login.md) の 17 節）。
- **カスタムドメイン**：アプリごとにドメインを縛らない。配信のテナントの上限は、先に引き上げを申請する。DNS の確認は Google Public DNS と Cloudflare の DoH の 2 つで行う（[custom-domains.md](custom-domains.md) の 12 節）。
- **メール**：SES の上限は S2 の前に引き上げを申請する。予備の SES のアカウントは、合成監視のメールで毎日暖める（[email-delivery.md](email-delivery.md) の 16 節）。
- **ユーザー**：仮名の `sub` は持たない。本人のメタデータの更新は MVP の後。SCIM の最初のバージョンは `Users` だけ（[users-and-profiles.md](users-and-profiles.md) の 16 節）。
- **テナント**：アカウントを請求・契約の単位にする。ワイルドカードのコールバックの移行は、URL の個別の登録で支える（[tenants-and-applications.md](tenants-and-applications.md) の 13 節）。
- **Actions**：同期のトリガーの時限は既定 10 秒、テナントの上書きで 20 秒まで（[extensibility.md](extensibility.md) の 13 節、[ADR-0048](../decisions/0048-extensibility-triggers-and-failure-policy.md)）。
- **EventBridge の SaaS パートナーの登録**：E10 の着手前に申請する（[logs-and-streams.md](logs-and-streams.md) の 12 節）。

持ち越し（法務、計測・PoC で決めるもの）：

| 項目 | 理由 | いつ・どう決めるか |
| --- | --- | --- |
| 法務の確認待ち（L1〜L8、Pwned Passwords のデータセットの利用の条件、署名鍵の失効の権限と運用者の参照の契約） | 法務 | [intent.md](../intent.md) の「法務の確認待ち」、[security.md](security.md) の 13 節。結論まで、そこに挙げた spec を承認しない |
| 法務の結論に依るもの（第三者の CAPTCHA、WAF の ATP、ログの保持の日数の上限、同意の記録の削除の後の扱い、ログストリームの国外への送信、SMS の送信事業者） | 法務に依る | 各領域の文書の「未解決の問い」。L1・L2・L4・L5・L7・L8 の結論の後 |
| Argon2id のパラメーター、ハッシュのタスクの数、Signer のタスクの数 | 計測 | E12 の負荷試験（k6。[capacity.md](capacity.md) の 5 節） |
| RSA を 3072 ビットにするか | 計測 | 署名の CPU を E12 で測って決める（[keys-and-secrets.md](keys-and-secrets.md) の 13 節） |
| pepper の鍵の置き場所を、S3 で専用の隔離（HSM など）へ移すか | PoC | S3 の前。NIST SP 800-63B-4 は、鍵をハードウェアで守ることを勧めている |
| Nitro Enclaves を Fargate で使えるか | PoC | 使えない（EC2 の親インスタンスが要件。[What is Nitro Enclaves?](https://docs.aws.amazon.com/enclaves/latest/user/nitro-enclave.html)、2026-09-27 に確認）。S3 で Signer を EC2 に移すかを、S3 の前に評価する |
| Lambda のテナントの隔離のモードのコールドスタートと費用 | PoC | E13 の最初の PoC（[extensibility.md](extensibility.md) の 13 節） |
| 列挙の時間の差の 5% の妥当性、画面の LCP の目標、証明書の発行の時間、共有の送信の 1 日の上限、検索を専用の基盤へ移すか、攻撃の防御の閾値と PoW の難しさ、M2M の発行のログを失う件数 | 計測 | 各領域の文書の「持ち越し」（E3・E8・E11・E12、S2 の前） |
| 本家の振る舞いで未確認のもの（不審な IP の抑制のサインアップの補う速度の既定、認可コードの有効期間、ログインのトランザクションの有効期間、ブロックしたユーザーのリフレッシュトークン、リフレッシュでの組織のメンバーシップの確認など。セッションの既定値・リフレッシュトークンの猶予・ログのコードの意味は 2026-09-27 に確かめた） | 確かめるだけ（決定は済み） | 各領域の文書の「持ち越し」に書いた Epic で、本家の資料か試用のテナントで確かめる |

### 決定（2026-09-28、データモデル）

ユーザーの依頼（各題材のデータモデルを十分に設計し、ER 図を付ける）により、[data-model.md](data-model.md) を索引から形の正本に変え、`data-model/` に領域ごとの定義（92 テーブル、ER 図 14 個）を置いた。ADR の決定は変えていない。判断が要ったところは推奨案で決めた（詳細は [data-model.md](data-model.md) の 9.2 節）。

- **分割の鍵**：時間で切る表は UUIDv7 の `id` の範囲で切る。旧い `audit_events` の `RANGE (occurred_at)` は主キーと合わず作れなかったので直した。分割した表のハッシュの引き当ては普通の索引にし、1 回限りは条件付きの更新で守る。
- **テナントの外の表**：`signing_key_state_versions` を足した（Signer が全テナントのバージョンを読むため。値はバージョンと時刻だけ）。
- **列の名前と型**：管理者を指す列は `member_user_id`（管理用のテナントの `sub`）、`credential_tickets` はリンクの `secret_hash` とコードの `code_hash` に分けた、`clients` の主キーは `(tenant_id, client_id)`。
- **Valkey とリース**：Valkey のキーは `<用途>:{t:<tenant_id>}:...` で IP を HMAC にする。ログストリームのリースは DB の行で持つ。
- **持ち越し**：`refresh_tokens` の行の数（再利用の検知のため使用済みの行を残すと S1 で十数億行になりうる）を E12 で測り、多ければ ADR-0003 の改訂を Dev のテックリードに諮る（[data-model.md](data-model.md) の 9.4 節）。

## 7. 領域の文書

領域の担当は、下の表の番号の範囲の中で ADR を採番する（範囲の外に出るときは、この表を先に更新する）。持ち主は、どれも Dev が書き、下の「レビュー」の列のロールが確認する。

| ファイル | 範囲 | ADR | レビュー | 関わる Epic |
| --- | --- | --- | --- | --- |
| [authentication-flows.md](authentication-flows.md) | OIDC・OAuth のエンドポイント（`/authorize`、`/oauth/token`、`/userinfo`、`/oauth/revoke`、`/oauth/device/code`、discovery、JWKS）、グラント（認可コード＋PKCE、クライアントクレデンシャル、リフレッシュ、デバイス）、クライアントの認証、`redirect_uri` の検証、トークンのクレームと有効期間、エラー、適合試験の対象。後の PAR・DPoP・トークン交換 | 0006–0010 | QA（適合試験） | E3、E5 |
| [universal-login.md](universal-login.md) | ホスト型の画面と画面の遷移、ブランディングとテーマ、文言と多言語（日本語・英語）、CSP、同意の記録、エラーの画面 | 0011–0013 | QA | E4、E11 |
| [connections.md](connections.md) | 接続の抽象、データベース接続（サインアップ、ログイン、再設定、メールの確認、パスワードのポリシー）、ソーシャル接続（Google、Apple、LINE、GitHub）。後のエンタープライズ接続（SAML、OIDC、Microsoft Entra ID、コネクタ経由の LDAP） | 0014–0017 | QA | E4、E6 |
| [users-and-profiles.md](users-and-profiles.md) | ユーザーの保存、ID のリンク、メタデータ（利用者が変えられるものと、アプリだけが変えられるもの）、ユーザーの検索、削除。後のインポート・エクスポートと SCIM | 0018–0020 | QA | E4、E6、E9 |
| [mfa-and-passkeys.md](mfa-and-passkeys.md) | MFA の要素（TOTP、WebAuthn・パスキー、メールの OTP、リカバリーコード。後の SMS）、登録と step-up、パスワードなしのパスキーのログイン、`amr`・`acr`、NIST の AAL との対応 | 0021–0023 | QA、セキュリティ | E7 |
| [attack-protection.md](attack-protection.md) | ブルートフォースの防御、不審な IP の抑制、漏えいしたパスワードの検知、ボットの検知、利用者と管理者への通知、監視のモード | 0024–0026 | セキュリティ | E8 |
| [sessions-and-sso.md](sessions-and-sso.md) | セッション（Cookie、有効期間、端末）、テナントの中の SSO、ログアウト（RP-Initiated、Back-Channel）、セッションとリフレッシュトークンの系列の関係 | 0027–0029 | QA、セキュリティ | E5 |
| [tenants-and-applications.md](tenants-and-applications.md) | テナント（作成、環境、アカウント、メンバーとロール）、アプリケーション（種類、グラント、コールバック）、API（スコープ、M2M の許可）、設定のキャッシュと反映 | 0030–0032 | QA | E2 |
| [management-api-and-rate-limiting.md](management-api-and-rate-limiting.md) | Management API の形（リソース、ページング、エラー、バージョン）、認可（スコープ）、レート制限（認証・管理の両方、テナントの環境ごとの上限）、ヘッダー（`<Brand>-` の形） | 0033–0035 | QA、Ops | E2、E9、E12 |
| [dashboard.md](dashboard.md) | ダッシュボードの SPA、管理者のログイン（管理用のテナント）、非常用の経路、管理者のロール | 0036–0037 | QA、セキュリティ | E9 |
| [custom-domains.md](custom-domains.md) | カスタムドメインの検証、証明書の発行と更新、ホスト名からテナントの解決、エッジの構成。後の複数のカスタムドメイン | 0038–0039 | Ops | E11 |
| [email-delivery.md](email-delivery.md) | メールの送信（確認、再設定、OTP、通知）、テンプレート、送信ドメインの認証（SPF・DKIM・DMARC）、テナントの独自の送信事業者、到達性の監視 | 0040–0041 | Ops | E4、E11 |
| [logs-and-streams.md](logs-and-streams.md) | 認証のイベントのログ（イベントの種類とコード）、保存と検索、保持、ログストリーム（Webhook、EventBridge）、少なくとも 1 回の配信と停止の条件 | 0042–0044 | Ops | E10 |
| [keys-and-secrets.md](keys-and-secrets.md) | Signer、署名鍵の生成・ローテーション・失効、KMS の鍵の階層、pepper、エンベロープ暗号化、JWKS の書き出し、緊急のローテーション | 0045–0047 | セキュリティ | E1、E3 |
| [extensibility.md](extensibility.md)（MVP の後） | Actions に相当する拡張：トリガー、実行の隔離、時間とメモリーの上限、秘密、失敗の扱い、認証の経路への影響 | 0048–0050 | セキュリティ、Ops | E13 |
| [organizations.md](organizations.md)（MVP の後） | B2B の組織、招待、組織ごとの接続とブランド、トークンの組織のクレーム | 0051–0052 | QA | E14 |
| [security.md](security.md) | 脅威モデル、RFC 9700 のチェックリスト、暗号化、監査ログ、データのライフサイクル、脆弱性の対応、法務の論点の整理 | 0053–0056 | セキュリティ | E1、E12 |
| [data-model.md](data-model.md)（と `data-model/`） | データモデルの正本（規約、テナントの外の表、ER 図、テーブルの定義、DB の外のストアの形、横断的な不変条件） | なし（各領域の ADR を参照する） | QA | 全 Epic |
| [infrastructure.md](infrastructure.md) | AWS のアカウントとネットワーク、サービスの分け方、エッジ、冗長化、DR、段階を上げる基準、S3 のセル構成 | 0057–0060 | Ops | E1、E12 |
| [observability.md](observability.md) | ログ・メトリクス・トレース、SLI の計測、秘密を出さない計装 | 0061–0062 | Ops | E1、E10 |
| [capacity.md](capacity.md) | 負荷のモデル、Argon2id と署名の CPU、部品ごとの必要量、パラメーター | 0063 | Ops | E12 |
| [delivery.md](delivery.md) | CI/CD、適合試験の CI、リリースとフラグ、`security:sensitive` の変更の流れ | 0064–0066 | QA、Ops | E1、E12 |

## 8. Epic

Epic と Story の計画は [roadmap.md](../roadmap.md) にある（PM が持つ）。E1〜E12 が MVP（S1）、E13 は Actions、E14 は Organizations とエンタープライズ接続。その他の MVP の後の機能は、roadmap.md の「後回し」にある。

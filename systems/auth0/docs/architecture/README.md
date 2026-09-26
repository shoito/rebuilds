# Architecture: Auth0

全体像と横断的な方針。領域ごとの設計は、同じディレクトリに領域ごとのファイルとして置く。ファイルの一覧、持ち主、ADR の番号の範囲は 7 節にある（まだ作っていない）。

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
                                  JWKS の書き出し、漏えいしたパスワードのデータの取り込み）
```

| コンテナ | 責務 |
| --- | --- |
| Auth | OIDC・OAuth のエンドポイント、Universal Login の画面、接続（データベース・ソーシャル）、MFA、セッション、攻撃の防御の判定。秘密鍵を持たない |
| Signer | テナントの署名鍵の生成・保管・署名。外からの要求を受けない（[ADR-0003](../decisions/0003-token-formats-and-signing-keys.md)） |
| Management API | テナント・アプリケーション・API・接続・ユーザー・ログの操作。M2M のアクセストークンで守る |
| Dashboard | テナントの管理者向けの SPA。Management API だけを呼ぶ。管理者は、このシステム自身の管理用のテナントでログインする |
| Worker | 遅れてよい処理。ログインを止めない（[ADR-0005](../decisions/0005-authentication-path-availability.md)） |
| Aurora | 唯一の正本。テナントを RLS で分ける（[ADR-0002](../decisions/0002-tenancy-and-isolation.md)） |
| Valkey | キャッシュと数の置き場所。失われてもよい（DB が正本） |

原則は 4 つ。

- **標準に従い、適合試験で確かめる。** 認可サーバーは自前で実装し、暗号の部品は検証済みのライブラリを使う（[ADR-0001](../decisions/0001-platform-and-stack.md)）。
- **テナントで分け、テナントで閉じる。** データも鍵もドメインもテナントに属する（[ADR-0002](../decisions/0002-tenancy-and-isolation.md)）。
- **秘密は平文で持たず、出さない。** 署名の秘密鍵は Signer の外に出ない。資格情報はハッシュか暗号化で持つ（[ADR-0003](../decisions/0003-token-formats-and-signing-keys.md)、[ADR-0004](../decisions/0004-credential-storage.md)）。
- **認証の経路は止めない。** 管理の経路と分け、依存先ごとの縮退を決めておく（[ADR-0005](../decisions/0005-authentication-path-availability.md)）。

## 2. 規模の段階

| 段階 | テナント（うち本番） | エンドユーザー（合計） | 対話のログインのピーク | トークンの発行のピーク | 構成 |
| --- | --- | --- | --- | --- | --- |
| S1（MVP） | 1 万（3,000） | 2,000 万 | 500 件/秒 | 3,000 件/秒（クライアントクレデンシャル・リフレッシュを含む） | 東京の 1 リージョン・3 AZ。Aurora の writer 1 台＋reader 2 台。大阪にウォームスタンバイ（Aurora Global Database、マルチリージョンの KMS の鍵） |
| S2 | 10 万（3 万） | 2 億 | 5,000 件/秒 | 30,000 件/秒 | ユーザー・セッション・リフレッシュトークンを、テナントのハッシュで複数の Aurora のクラスタに分ける。大口のテナントを専用のクラスタへ。ログの保存と検索を専用の基盤へ。RTO を 15 分に縮める |
| S3 | 100 万（30 万） | 10 億 | 50,000 件/秒（大型のイベントの集中を含む） | 300,000 件/秒 | セル構成。テナントをセルに固定し、東京・大阪の両方で受ける。大口のテナントに専用のセル。Signer の隔離（Nitro Enclaves など）を再評価。海外のリージョン |

- 数値は本システムの想定。本家の実数は公開の資料で確かめられなかった（未検証）。
- 対話のログインは、パスワードの照合（Argon2id）を伴うものを数える。S1 のピークで Argon2id の計算は 1 秒 500 回で、CPU の必要量は E12 の負荷試験で決める。
- トークンの発行 1 件で、最大 2 回（ID トークンとアクセストークン）署名する。
- 段階を上げる判断の基準は、infrastructure の領域で決める。

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
| Universal Login | サーバーで HTML を組み立てる（Hono の JSX）。JavaScript は最小 | 速さと厳しい CSP。詳細は universal-login の領域 |
| JOSE | `jose` | [ADR-0001](../decisions/0001-platform-and-stack.md) |
| WebAuthn | 保守されているサーバーのライブラリ（候補は `@simplewebauthn/server`） | mfa-and-passkeys の領域で選ぶ |
| パスワード | Argon2id のネイティブのバインディング、bcrypt の照合 | [ADR-0004](../decisions/0004-credential-storage.md) |
| DB | Aurora PostgreSQL 18、RLS、ID は UUIDv7 | [ADR-0002](../decisions/0002-tenancy-and-isolation.md) |
| キャッシュ・数 | ElastiCache（Valkey） | 失われてもよい（[ADR-0005](../decisions/0005-authentication-path-availability.md)） |
| 非同期 | transactional outbox → SQS | 他の題材と同じ |
| 鍵 | KMS（署名鍵の専用の鍵、資格情報の鍵、pepper の鍵。マルチリージョン）、Signer | [ADR-0003](../decisions/0003-token-formats-and-signing-keys.md) |
| エッジ | CloudFront、AWS WAF、ACM | discovery・JWKS の配布、カスタムドメイン |
| 実行基盤 | AWS（東京、DR は大阪）、ECS Fargate | 他の題材と同じ |
| IaC | Terraform | 他の題材と同じ |
| 可観測性 | OpenTelemetry（ADOT）→ AMP、X-Ray、CloudWatch Logs | 他の題材と同じ。秘密を出さない計装は observability の領域 |
| フラグ | AWS AppConfig | 他の題材と同じ |
| 適合試験 | OpenID Foundation の conformance suite（CI の中で動かす）、node-oidc-provider との差分テスト | [ADR-0001](../decisions/0001-platform-and-stack.md) |
| テスト | Vitest、fast-check、Testcontainers、Playwright（仮想の WebAuthn の認証器） | 他の題材と同じ |

## 5. 主な決定

| ADR | 決定 |
| --- | --- |
| [0001](../decisions/0001-platform-and-stack.md) | 共通の基盤の上に、検証済みの部品で認可サーバーを自前で実装する。node-oidc-provider は差分テストの相手にする |
| [0002](../decisions/0002-tenancy-and-isolation.md) | テナントを分離と設定の単位にし、共有スキーマと RLS で分ける。環境ごとに別のテナント。テナントはリージョンに固定 |
| [0003](../decisions/0003-token-formats-and-signing-keys.md) | アクセストークン（RFC 9068）と ID トークンはテナントの鍵で署名した JWT。既定は RS256。秘密鍵は KMS でエンベロープ暗号化し、Signer の中だけで使う。リフレッシュトークンは不透明でローテーションと再利用の検知 |
| [0004](../decisions/0004-credential-storage.md) | パスワードは Argon2id と pepper、bcrypt を取り込める。高エントロピーの秘密は SHA-256、戻す必要のある秘密は KMS のエンベロープ暗号化。漏えいしたパスワードの range API を自前でホストする |
| [0005](../decisions/0005-authentication-path-availability.md) | 認証の経路を管理の経路から分け、依存先ごとの縮退を決める。JWKS・discovery はエッジから。セルは S3 |

領域ごとの ADR は、7 節の番号の範囲で起票する。リポジトリ共通の決定（開発プロセス、ブランチモデル、本家の名前・接頭辞を使わない規則の [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）は、ルートの [docs/decisions/](../../../../docs/decisions/README.md) にある。

## 6. リスクと未解決事項

- **認可サーバーの実装の誤り**：`redirect_uri` の照合、`state`・`nonce`・PKCE の検証、mix-up 攻撃、コードの再利用、オープンリダイレクトの誤りは、そのまま脆弱性になる。適合試験、RFC 9700 のチェックリストと否定側のテスト、差分テスト、E12 の外部のペンテストで抑える。
- **署名鍵の漏えい**：1 テナントの鍵が漏れると、そのテナントの全ユーザーになりすませる。Signer への集約（[ADR-0003](../decisions/0003-token-formats-and-signing-keys.md)）と、緊急のローテーション・失効の手順（runbooks で作る）で備える。Signer のメモリーに鍵が平文で載ることは残る。
- **クレデンシャルスタッフィングとボット**：攻撃の防御（E8）で抑える。ボットの検知の方式は未定で、外部の部品を使うなら法務の L2 に関わる。
- **ログインの CPU の費用**：Argon2id は、攻撃の時に計算の量で DoS になりうる。防御の判定をハッシュの前に置き、同時実行に上限を置く（[ADR-0004](../decisions/0004-credential-storage.md)）。Node.js での実測は E12 で行う。
- **大口のテナントの偏り**：数百万のユーザーを持つテナントや、M2M のトークンを大量に求めるテナントが、共有の DB を占有しうる。テナント単位のレート制限と、S2 のシャードで抑える。
- **メールの到達性**：確認・再設定・OTP のメールが迷惑メールになると、サインアップと再設定が止まる。送信ドメインの認証と、テナントの独自の送信ドメインで備える（email-delivery の領域）。
- **外部の IdP の変化**：Apple の非公開のメールの中継、LINE のメールアドレスの取得の条件（未検証）、各社の仕様の変更に追従が要る。
- **自分で自分を使う**：ダッシュボードの管理者のログインが、このシステムの障害で止まる。非常用の経路が要る（dashboard の領域）。
- **法令**：法務の確認待ちの事項がある（[intent.md](../intent.md) の「法務の確認待ち」）。結論が出るまで、そこに挙げた Epic の spec を承認しない。

持ち越し（計測・PoC・選定で決めるもの）：

| 項目 | いつ・どう決めるか |
| --- | --- |
| Argon2id のパラメーター、ハッシュのタスクの数、Signer のタスクの数 | E12 の負荷試験（k6） |
| JWKS・discovery のキャッシュの期間と、オリジンの障害中に古い版を返す期間 | E3。鍵のローテーションの手順と合わせて決める |
| テナントの設定のキャッシュで許す古さ | E2。ADR-0005 の縮退の試験と合わせて決める |
| pepper の鍵の置き場所を、S3 で専用の隔離（HSM など）へ移すか | S3 の前。NIST SP 800-63B-4 は、鍵をハードウェアで守ることを勧めている |
| メールの送信事業者、ボットの検知の方式 | E4、E8 の着手前（[intent.md](../intent.md)） |
| Nitro Enclaves を Fargate で使えるか | 未検証。S3 の前に確かめる |
| 本家の振る舞いで未確認のもの（不審な IP の抑制の既定値、リフレッシュトークンの猶予の上限、セッションの有効期間の既定値、Management API のレート制限の値） | 各領域の文書で、本家の資料か試用のテナントで確かめる |

## 7. 領域の文書（計画）

各領域の文書は、まだない。領域の担当は、下の表の番号の範囲の中で ADR を採番する（範囲の外に出るときは、この表を先に更新する）。持ち主は、どれも Dev が書き、下の「レビュー」の列のロールが確認する。

| ファイル | 範囲 | ADR | レビュー | 関わる Epic |
| --- | --- | --- | --- | --- |
| `authentication-flows.md` | OIDC・OAuth のエンドポイント（`/authorize`、`/oauth/token`、`/userinfo`、`/oauth/revoke`、`/oauth/device/code`、discovery、JWKS）、グラント（認可コード＋PKCE、クライアントクレデンシャル、リフレッシュ、デバイス）、クライアントの認証、`redirect_uri` の検証、トークンのクレームと有効期間、エラー、適合試験の対象。後の PAR・DPoP・トークン交換 | 0006–0010 | QA（適合試験） | E3、E5 |
| `universal-login.md` | ホスト型の画面と画面の遷移、ブランディングとテーマ、文言と多言語（日本語・英語）、CSP、同意の記録、エラーの画面 | 0011–0013 | QA | E4、E11 |
| `connections.md` | 接続の抽象、データベース接続（サインアップ、ログイン、再設定、メールの確認、パスワードのポリシー）、ソーシャル接続（Google、Apple、LINE、GitHub）。後のエンタープライズ接続（SAML、OIDC、Microsoft Entra ID、コネクタ経由の LDAP） | 0014–0017 | QA | E4、E6 |
| `users-and-profiles.md` | ユーザーの保存、ID のリンク、メタデータ（利用者が変えられるものと、アプリだけが変えられるもの）、ユーザーの検索、削除。後のインポート・エクスポートと SCIM | 0018–0020 | QA | E4、E6、E9 |
| `mfa-and-passkeys.md` | MFA の要素（TOTP、WebAuthn・パスキー、メールの OTP、リカバリーコード。後の SMS）、登録と step-up、パスワードなしのパスキーのログイン、`amr`・`acr`、NIST の AAL との対応 | 0021–0023 | QA、セキュリティ | E7 |
| `attack-protection.md` | ブルートフォースの防御、不審な IP の抑制、漏えいしたパスワードの検知、ボットの検知、利用者と管理者への通知、監視のモード | 0024–0026 | セキュリティ | E8 |
| `sessions-and-sso.md` | セッション（Cookie、有効期間、端末）、テナントの中の SSO、ログアウト（RP-Initiated、Back-Channel）、セッションとリフレッシュトークンの系列の関係 | 0027–0029 | QA、セキュリティ | E5 |
| `tenants-and-applications.md` | テナント（作成、環境、アカウント、メンバーとロール）、アプリケーション（種類、グラント、コールバック）、API（スコープ、M2M の許可）、設定のキャッシュと反映 | 0030–0032 | QA | E2 |
| `management-api-and-rate-limiting.md` | Management API の形（リソース、ページング、エラー、版）、認可（スコープ）、レート制限（認証・管理の両方、テナントの環境ごとの上限）、ヘッダー（`<Brand>-` の形） | 0033–0035 | QA、Ops | E2、E9、E12 |
| `dashboard.md` | ダッシュボードの SPA、管理者のログイン（管理用のテナント）、非常用の経路、管理者のロール | 0036–0037 | QA、セキュリティ | E9 |
| `custom-domains.md` | カスタムドメインの検証、証明書の発行と更新、ホスト名からテナントの解決、エッジの構成。後の複数のカスタムドメイン | 0038–0039 | Ops | E11 |
| `email-delivery.md` | メールの送信（確認、再設定、OTP、通知）、テンプレート、送信ドメインの認証（SPF・DKIM・DMARC）、テナントの独自の送信事業者、到達性の監視 | 0040–0041 | Ops | E4、E11 |
| `logs-and-streams.md` | 認証のイベントのログ（イベントの種類とコード）、保存と検索、保持、ログストリーム（Webhook、EventBridge）、少なくとも 1 回の配信と停止の条件 | 0042–0044 | Ops | E10 |
| `keys-and-secrets.md` | Signer、署名鍵の生成・ローテーション・失効、KMS の鍵の階層、pepper、エンベロープ暗号化、JWKS の書き出し、緊急のローテーション | 0045–0047 | セキュリティ | E1、E3 |
| `extensibility.md`（MVP の後） | Actions に相当する拡張：トリガー、実行の隔離、時間とメモリーの上限、秘密、失敗の扱い、認証の経路への影響 | 0048–0050 | セキュリティ、Ops | E13 |
| `organizations.md`（MVP の後） | B2B の組織、招待、組織ごとの接続とブランド、トークンの組織のクレーム | 0051–0052 | QA | E14 |
| `security.md` | 脅威モデル、RFC 9700 のチェックリスト、暗号化、監査ログ、データのライフサイクル、脆弱性の対応、法務の論点の整理 | 0053–0056 | セキュリティ | E1、E12 |
| `data-model.md` | データモデルの索引 | なし（各領域の ADR を参照する） | QA | 全 Epic |
| `infrastructure.md` | AWS のアカウントとネットワーク、サービスの分け方、エッジ、冗長化、DR、段階を上げる基準、S3 のセル構成 | 0057–0060 | Ops | E1、E12 |
| `observability.md` | ログ・メトリクス・トレース、SLI の計測、秘密を出さない計装 | 0061–0062 | Ops | E1、E10 |
| `capacity.md` | 負荷のモデル、Argon2id と署名の CPU、部品ごとの必要量、パラメーター | 0063 | Ops | E12 |
| `delivery.md` | CI/CD、適合試験の CI、リリースとフラグ、`security:sensitive` の変更の流れ | 0064–0066 | QA、Ops | E1、E12 |

## 8. Epic（草案）

`roadmap.md` を作るときに移す。PM が持つ。

| Epic | 目的 |
| --- | --- |
| E1 | 基盤：AWS・Terraform・CI（適合試験の枠を含む）、Aurora と RLS、Signer と KMS の鍵の階層、フラグ、可観測性 |
| E2 | テナント・アプリケーション・API と、Management API の骨格（M2M のトークンで守る） |
| E3 | OIDC・OAuth の中核：discovery・JWKS（エッジ）、認可コード＋PKCE、トークン、userinfo、クライアントクレデンシャル、署名鍵のローテーション |
| E4 | Universal Login とデータベース接続：サインアップ、ログイン、再設定、メールの確認、ブランディング、メールの送信 |
| E5 | セッション・SSO・ログアウト：リフレッシュトークンのローテーションと再利用の検知、デバイス認可、RP-Initiated・Back-Channel Logout |
| E6 | ソーシャル接続（Google、Apple、LINE、GitHub）と ID のリンク |
| E7 | MFA とパスキー：TOTP、WebAuthn・パスキー、メールの OTP、リカバリーコード |
| E8 | 攻撃の防御：ブルートフォース、不審な IP、漏えいしたパスワード、ボットの検知 |
| E9 | ダッシュボード |
| E10 | ログとログストリーム |
| E11 | カスタムドメインと、テナントの送信ドメイン |
| E12 | 本番の準備：OpenID Certification、負荷試験、障害の注入と DR の訓練、外部のペンテスト、レート制限の仕上げ、GA の判定 |
| E13 以降（MVP の後） | Actions、Organizations とエンタープライズ接続、SCIM とインポート・エクスポート、PAR・DPoP・SMS |

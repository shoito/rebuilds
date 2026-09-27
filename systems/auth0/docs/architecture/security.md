# Security: Auth0

信頼境界、脅威モデル（部品ごとの STRIDE）、RFC 9700 のチェックリスト、暗号化、監査ログ、秘密情報、運用者のアクセス、データのライフサイクル、セキュリティの試験、脆弱性の管理、インシデント、法務の論点。鍵の階層と Signer の中身は [keys-and-secrets.md](keys-and-secrets.md)、攻撃の防御（ブルートフォース、不審な IP、漏えいしたパスワード、ボット）は [attack-protection.md](attack-protection.md)、プロトコルの詳細は [authentication-flows.md](authentication-flows.md) にある。

| 関連 | 決定 |
| --- | --- |
| [ADR-0002](../decisions/0002-tenancy-and-isolation.md) | テナントを共有スキーマと RLS で分ける |
| [ADR-0003](../decisions/0003-token-formats-and-signing-keys.md) | トークンの形式。秘密鍵は Signer の中だけで使う |
| [ADR-0004](../decisions/0004-credential-storage.md) | 資格情報の保存（Argon2id と pepper、ハッシュ、エンベロープ暗号化） |
| [ADR-0053](../decisions/0053-rfc9700-checklist-and-negative-tests.md) | RFC 9700 と脅威をチェックリストにし、拒否の側のテストを持つ |
| [ADR-0054](../decisions/0054-audit-log.md) | 監査ログ |
| [ADR-0055](../decisions/0055-data-retention-and-deletion.md) | データの保持と削除 |
| [ADR-0056](../decisions/0056-operator-access.md) | 社内の運用者のアクセス |
| [ADR-0059](../decisions/0059-signer-isolation.md) | Signer の隔離 |
| [ADR-0061](../decisions/0061-secret-free-telemetry.md) | 秘密を出さない計装 |
| [ADR-0065](../decisions/0065-security-sensitive-change-flow.md) | `security:sensitive` の変更の流れ |

## 1. 目標と前提

- **OWASP ASVS 5.0 の Level 2 を全体の目標にし、認証・セッション・トークンの章（V6 認証、V7 セッション、V9 自己完結のトークン、V10 OAuth と OIDC）は Level 3 を目標にする。** 章の番号は ASVS 5.0 の原文のリポジトリで確かめた（[OWASP/ASVS 5.0](https://github.com/OWASP/ASVS/tree/master/5.0/en)、2026-09-27 に確認）。要件の番号との照合は E1 で行う。他の題材（Slack、Stripe）は Level 2 を目標にしている。本システムは IdP で、認証の誤りが全テナントの誤りになるので、認証の章を一段上げる。
- 標準の要件は、RFC 9700、OpenID Connect Core 1.0、RFC 7636、NIST SP 800-63B-4 に従う（[intent.md](../intent.md) の Constraints）。
- 最も重い障害は 4 つ。
  1. **署名鍵の漏えい**：そのテナントのどのユーザーにもなりすませる（[architecture/README.md](README.md) の 6 節）。
  2. **テナントをまたいだデータの漏えい、他のテナントの鍵での署名**（NFR-008）。
  3. **資格情報の大量の漏えい**：パスワードのハッシュ、TOTP の種、クライアントシークレット、リフレッシュトークン（NFR-007）。
  4. **認可サーバーの実装の誤り**：`redirect_uri`、PKCE、コードの再利用、mix-up による、コードやトークンの横取り。
- 実行基盤・CI/CD・監視の統制は、他の題材の決定を引き継ぎ（[ADR-0001](../decisions/0001-platform-and-stack.md)）、IdP に固有の部分だけをここに書く。
- **AI エージェント（コーディング・運用）は、本番に一切の経路を持たない**（[ADR-0056](../decisions/0056-operator-access.md)）。

## 2. 信頼境界

```
  ┌──────────────────────── インターネット（信頼しない）───────────────────────────┐
  │ エンドユーザーのブラウザ・アプリ  テナントのアプリ・API・バックエンド  テナントの管理者  攻撃者 │
  └────┬───────────────────────────────┬──────────────────────────────┬────────────┘
       │ <tenant>.jp.<brand>.<domain>    │ /api/v2/*                     │ manage.<brand>.<domain>
       │ カスタムドメイン                 │                               │
  ═════╪══ B1: エッジ（CloudFront＋WAF、edge アカウント）═══════════════╪══════════════
       │                                 │                               │
  ┌────▼──── prod アカウント（東京・大阪）──▼───────────────────────────────▼──────────┐
  │  alb-auth ─▶ Auth（認可サーバー・Universal Login）     alb-mgmt ─▶ Management API │
  │                 │ B3: 相互 TLS（署名のポート）                  │ 相互 TLS（鍵の管理）│
  │                 ▼                                               ▼                 │
  │            ┌─ signer サブネット（外への経路なし）─────────────────────┐            │
  │            │ Signer（秘密鍵はここだけ。KMS の Decrypt はこのロールだけ）│            │
  │            └──────────────────────────────────────────────────────────┘            │
  │  ══ B2: テナントのコンテキスト（ホスト名 → tenant_id、SET LOCAL、FORCE RLS）══     │
  │  Aurora  Valkey  SQS  S3（JWKS・discovery）                                       │
  │  Worker ─── 外向き（B5）──▶ テナントの Back-Channel Logout・Webhook の URL、メール、  │
  │                             ソーシャル IdP のトークンのエンドポイント              │
  └───────────────────────────────────────────────────────────────────────────────────┘
  ═══ B4: 管理プレーン ═══ CI/CD（OIDC）、運用者（SSO＋MFA、JIT）、log-archive（Object Lock）
  ─ ─ ─ B6: 開発環境（AI コーディングエージェント）… 本番への経路なし ─ ─ ─
```

| 境界 | 越えるもの | 主な統制 |
| --- | --- | --- |
| B1 エッジ | すべての外部の要求 | TLS 1.2 以上、HSTS、WAF（[infrastructure.md](infrastructure.md) の 4.3 節）、Shield Standard。オリジンは CloudFront からの要求だけを受ける |
| B2 テナント | サービスから DB | ホスト名からテナントを決めてから DB を読む。`SET LOCAL app.tenant_id`、FORCE RLS（ADR-0002） |
| B3 Signer | Auth・mgmt から Signer | 外への経路のないサブネット、相互 TLS、署名と鍵の管理のポートを分ける（ADR-0059） |
| B4 管理プレーン | デプロイ、鍵、運用者の操作 | OIDC の短命な認証情報、JIT（ADR-0056）、2 人の承認（ADR-0065）、監査 |
| B5 外向きの送信 | テナントの URL、外部の IdP、メール | 専用の egress（[infrastructure.md](infrastructure.md) の 2.3 節）、名前解決の後の IP の検査、署名 |
| B6 開発環境 | コード（PR としてのみ） | 本番の資格情報を置かない。テストに本物の資格情報を使わない（[AGENTS.md](../../AGENTS.md)） |

## 3. 脅威モデル（STRIDE）

S＝なりすまし、T＝改ざん、R＝否認、I＝情報漏洩、D＝サービス妨害、E＝権限昇格。主要な脅威と対策だけを書く。`SEC-` は 4 節の行を指す。

### 3.1 エッジ（CloudFront＋WAF）

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| S | オリジンを直接叩き、WAF を迂回する | ALB のセキュリティグループを CloudFront のマネージドプレフィックスリストに限り、秘密のカスタムヘッダーを検査する（[ADR-0058](../decisions/0058-edge-and-custom-domains.md)） |
| T | 攻撃者が `X-Forwarded-*`・`Host` を偽り、テナントの解決や `iss` を誤らせる（RFC 9700 の 4.13） | Auth は CloudFront が付けた元のホスト名のヘッダーだけを信じ、クライアントが送った同じ名前のヘッダーは CloudFront で上書きする。`iss` はテナントの設定から作り、要求のヘッダーから作らない（SEC-019） |
| T | 他人のカスタムドメインを登録して、そのドメインの要求を奪う | ドメインの所有の確認（custom-domains の領域）。確認の済まないドメインは配信のテナントを有効にしない |
| D | L7 の大量の要求、クレデンシャルスタッフィングの波 | WAF の IP のレート制限、Bot Control、攻撃の防御（[attack-protection.md](attack-protection.md)）。runbook は [incident-response.md](../runbooks/incident-response.md) |
| I | アクセスログにクエリ文字列（`code`、`login_hint`）が残る | ログの項目から外す（ADR-0061） |

### 3.2 認可サーバー（`/authorize`、`/oauth/token`、`/userinfo`、`/oauth/revoke`、`/oauth/device/code`）

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| S | 認可コードの横取りと交換（悪意のアプリ、Referer、ブラウザの履歴） | 公開クライアントは PKCE（S256）を必須。機密のクライアントにも PKCE を既定で求める。コードは 1 回限り・60 秒（ADR-0003）（SEC-002〜005） |
| S | 登録と違う `redirect_uri` へコードを送らせる（オープンリダイレクト） | 完全一致の照合。ワイルドカードを許さない。不一致ならエラーも送らず、本システムの画面でエラーを出す（SEC-001、SEC-014） |
| S | mix-up 攻撃（別の IdP のコードを本システムに送らせる） | 認可の応答に `iss`（RFC 9207）を付ける。テナントごとに `iss` を分ける（SEC-008） |
| S | クライアントのなりすまし（シークレットの漏えい） | シークレットはハッシュで保存し、1 回だけ表示（ADR-0004）。機密のクライアントに `private_key_jwt` を勧める（SEC-013） |
| S | M2M のトークンの `sub` がユーザーの `sub` と衝突し、テナントの API がユーザーと取り違える（RFC 9700 の 4.15） | クライアントクレデンシャルのトークンの `sub` を、ユーザーの `sub` と重ならない形（`<client_id>@clients`）にし、`gty` のクレームで区別する（SEC-018） |
| T | `alg: none`、鍵の取り違え（RS256 の公開鍵を HS256 の秘密として使わせる） | 受け取る JWT（`private_key_jwt`、`id_token_hint`）のアルゴリズムを許可リストで限る。HS256 を提供しない（ADR-0003）（SEC-016） |
| T | PKCE の格下げ（`code_challenge` なしの要求に `code_verifier` を付けて交換） | 認可の要求に `code_challenge` がないコードの交換で `code_verifier` が来たら拒否する（SEC-005） |
| R | テナントが、トークンの発行を否認する | 認証のイベントのログ（logs-and-streams の領域）に、クライアント、グラント、`kid`、要求の ID を残す |
| I | 別のテナントのクライアントでトークンを得る | ホスト名でテナントを決め、クライアントはそのテナントの中でだけ探す（ADR-0002）（SEC-020） |
| I | エラーの本文に入力の値が出る | エラーは定型の文だけ（ADR-0061） |
| D | Argon2id・署名の CPU を攻撃で使い切らせる | 防御の判定をハッシュの前に置き、同時実行の上限で 503（[ADR-0063](../decisions/0063-cpu-bound-work-sizing.md)） |
| E | リフレッシュトークンの盗用 | 公開クライアントはローテーションと再利用の検知（ADR-0003）。系列の失効（SEC-010） |
| E | スコープ・`audience` の越権 | API ごとの許可、`aud` を 1 つの API に限る（SEC-011） |

### 3.3 Universal Login（`/u/*`）

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| S | フィッシングの画面、本物の画面の枠への埋め込み（クリックジャッキング） | `frame-ancestors 'none'`（SEC-017）。パスキーを勧める（フィッシングに強い）。埋め込み型のログインは提供しない（[intent.md](../intent.md) の Non-goals） |
| T | XSS（テナントの文言・ロゴ・テーマに仕込む） | サーバーで HTML を組み立て、値は既定でエスケープする。厳しい CSP（nonce、`script-src` に外部を許さない）。テナントの独自の HTML・スクリプトは MVP で許さない（universal-login の領域） |
| T | CSRF（ログインの CSRF で、攻撃者のアカウントにログインさせる） | ログインのトランザクションの状態を Cookie と結び、フォームごとの CSRF のトークンを持つ。`SameSite=Lax` 以上 |
| I | ユーザーの存在の列挙（サインアップ、再設定、ログインの応答の違い） | 応答の文言と時間をそろえる（存在しないユーザーでもハッシュを計算する）。詳細は connections の領域 |
| D | サインアップの大量の自動化、メールの送信の濫用 | ボットの検知、サインアップのレート制限、メールの送信の上限（attack-protection、email-delivery の領域） |
| E | セッションの固定 | ログインの成功でセッションの ID を作り直す（sessions-and-sso の領域） |

### 3.4 Signer

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| S | Auth 以外が Signer を呼んで任意のトークンを作る | 相互 TLS でサービスを確かめ、ネットワークでも限る（ADR-0059） |
| E | Auth の乗っ取りから、外部の IdP 向けのアサーション（Apple のクライアントシークレット、`private_key_jwt`、SAML の AuthnRequest）を任意の宛先に作らせる | 外部 IdP のアサーションはトークンの署名と別の API・別の型・接続ごとの別の鍵にし、用途を 3 つに限る。`aud`・宛先・有効期間は Signer が接続の登録の値から決め、呼び出し側に渡させない（[ADR-0047](../decisions/0047-signer-api-and-jwks-publishing.md)、[keys-and-secrets.md](keys-and-secrets.md) の 6.3 節） |
| E | Auth の脆弱性（SSRF・任意のコードの実行）から、別のテナントの `kid` で署名させる | Signer の中で、`iss` と `kid` のテナントの一致を確かめる（ADR-0002・0003）。任意のバイト列に署名しない |
| I | Signer のメモリー・ダンプ・ログからの秘密鍵の読み出し | 外への経路なし、ECS Exec なし、コアダンプなし、読み取り専用のファイルシステム（ADR-0059）。秘密鍵の型は `Secret<T>`（ADR-0061） |
| I | DB の `signing_keys` の暗号文の持ち出し | KMS の `Decrypt` は Signer のロールだけ（ADR-0003）。暗号文だけでは使えない |
| T | 鍵の行の入れ替え（別のテナントの暗号文を差し込む） | AAD に `tenant_id` と `kid` を含める（ADR-0003） |
| D | Signer の全停止 | 3 AZ に複数のタスク。止まったら 503（代わりに署名する経路は作らない。ADR-0005） |
| R | 誰が鍵をローテーション・失効したか追えない | 監査ログ（ADR-0054）。KMS の操作は CloudTrail |

### 3.5 Management API とダッシュボード

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| S | 管理者のアカウントの乗っ取り（フィッシング） | 管理者のログインにパスキーか TOTP の MFA を必須にする（dashboard の領域）。新しい端末からのログインを通知する |
| S | Management API の M2M のトークンの漏えい | 有効期間を短くし、スコープを最小にする。ソースコードへの漏えいを、シークレットスキャンのパートナーへの接頭辞の登録で検知する（リポジトリ共通の ADR-0006） |
| E | 権限の低いメンバーが、鍵の失効・シークレットの表示・ユーザーの一括の削除をする | ロールの決定表（tenants-and-applications の領域）。危険な操作は再認証 |
| I | ユーザーの一覧・ログの大量の持ち出し | 一覧の上限、エクスポートを監査ログに残す（ADR-0054） |
| T | 設定の変更で攻撃の防御を切る（乗っ取った管理者が） | 防御の設定の変更を監査ログに残し、テナントの全管理者に通知する |
| D | 管理の経路の重い要求が、ログインを遅くする | 経路を ALB・DB の接続まで分ける（[ADR-0057](../decisions/0057-accounts-network-and-path-separation.md)） |

### 3.6 Worker と外向きの送信

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| I | SSRF（Back-Channel Logout・ログストリームの URL に内部のアドレスを指定する） | 専用の egress のサブネットから送り、名前解決の後の IP を検査する（プライベート、リンクローカル、ループバック、メタデータのアドレスを拒否）。リダイレクトを追わない。本番は HTTPS だけ（[infrastructure.md](infrastructure.md) の 2.3 節） |
| S | 第三者が偽の Back-Channel Logout・ログのイベントをテナントへ送る | Back-Channel Logout はテナントの鍵で署名した Logout Token（OIDC の仕様）。ログストリームの Webhook は署名を付ける（logs-and-streams の領域） |
| I | ソーシャル IdP のトークン・シークレットの漏えい | 接続の秘密はエンベロープ暗号化（ADR-0004）。IdP のトークンを保存するかは connections の領域で決める |
| D | 遅い送信先が Worker を詰まらせる | 送信先ごとの同時実行の上限と時限、失敗が続く送信先の停止 |

### 3.7 データの置き場所

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| I | DB・バックアップ・スナップショットの漏えい | 資格情報はハッシュか暗号文（ADR-0004）。pepper の鍵がない限り、パスワードの総当たりもできない。保存時の暗号化は KMS の CMK（5 節） |
| I | RLS のコンテキストの設定漏れ | 性質ベーステスト、マイグレーションの CI（ADR-0002） |
| T | Valkey の値の改ざん（攻撃の防御の数を消す） | Valkey は VPC の中だけ、TLS と AUTH。失われてよい値だけを置く（ADR-0005） |

### 3.8 CI/CD と AI エージェント

他の題材の security.md（Slack の 3.10・3.11・7.3 節）と同じ。加えて次のとおり。

- `security:sensitive` のパスの変更は、作成者と別の 2 人の人の承認を必須にし、事後の確認の例外を使わない（ADR-0065）。
- Signer のイメージと、KMS・IAM・WAF の Terraform は、同じ規則の対象にする。
- テストのデータに本物の資格情報がないことを CI で検査する（[AGENTS.md](../../AGENTS.md)）。

## 4. RFC 9700 のチェックリスト

[ADR-0053](../decisions/0053-rfc9700-checklist-and-negative-tests.md) の正本。各行の拒否の側のテストは、名前に `SEC-NNN` を含める。節の番号は RFC 9700 の原文の目次で照合した（[RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html)、2026-09-27 に確認）。「強さ」は RFC の要件の強さで、「追加」は本システムが RFC より厳しくするもの。

| ID | RFC 9700 | 強さ | 本システムの対応 | 決める領域 | 拒否の側のテストの例 |
| --- | --- | --- | --- | --- | --- |
| SEC-001 | 2.1、4.1 リダイレクト URI の検証 | MUST | 完全な文字列の一致（RFC は `localhost` のリダイレクト URI のポートだけを例外にする）。ネイティブのループバック（`http://127.0.0.1`・`[::1]`）だけ、ポートの違いを許す。ワイルドカードは許さない（**追加**：本家はサブドメインのワイルドカードを許す） | authentication-flows | 1 文字違い、末尾の `/`、大文字、クエリの追加、`%2F` の符号化、ユーザー情報（`@`）の付いた URI |
| SEC-002 | 2.1.1 CSRF の防止 | MUST | PKCE を必須にし、`state` をそのまま返す。OIDC の `nonce` を ID トークンに入れる | authentication-flows | `state` の書き換え、`nonce` の再利用 |
| SEC-003 | 2.1.1 PKCE | MUST（公開クライアント）、SHOULD（機密） | 公開クライアントは必須。機密のクライアントも既定で必須（テナントの設定で外せる。外すと監査ログ） | authentication-flows | `code_challenge` のない公開クライアントの要求 |
| SEC-004 | 2.1.1 `code_challenge_method` | SHOULD（S256） | S256 だけを受け、`plain` を拒否する（**追加**）。discovery に `code_challenge_methods_supported: ["S256"]` | authentication-flows | `plain` の要求 |
| SEC-005 | 4.8 PKCE の格下げ | MUST | 認可の要求に `code_challenge` がないのに、交換で `code_verifier` が来たら拒否 | authentication-flows | 格下げの交換 |
| SEC-006 | 4.5 認可コードの注入 | MUST | コードは発行したクライアントと `redirect_uri` に結ぶ。PKCE で検証 | authentication-flows | 別のクライアントのコード、別の `redirect_uri` での交換 |
| SEC-007 | 4.5、RFC 6749 の 4.1.2 コードの再利用 | MUST | 1 回限り・60 秒。2 回目で、そのコードから出したトークンを失効（ADR-0003） | authentication-flows、sessions-and-sso | 2 回目の交換と、その後の先のトークンの使用 |
| SEC-008 | 4.4 mix-up | SHOULD | 認可の応答に `iss`（RFC 9207）。discovery に `authorization_response_iss_parameter_supported: true` | authentication-flows | 応答に `iss` がない・違う |
| SEC-009 | 2.1.2 暗黙フロー | SHOULD NOT | 提供しない。`response_type=token`・`id_token token` を拒否（[intent.md](../intent.md)） | authentication-flows | `response_type=token` |
| SEC-010 | 2.2.2、4.14 リフレッシュトークンの保護 | MUST（公開クライアントは送信者の制約かローテーション） | 公開クライアントはローテーションと再利用の検知を必須。機密のクライアントはクライアント認証。DPoP（送信者の制約）は MVP の後 | sessions-and-sso | 使用済みのトークン、別のクライアントのトークン |
| SEC-011 | 2.3 アクセストークンの権限の制限 | SHOULD | `aud` を 1 つの API に限り、スコープはその API の許可の範囲だけ | authentication-flows | 許可のない API の `audience`、許可のないスコープ |
| SEC-012 | 2.4 リソースオーナーのパスワードのグラント | MUST NOT | 提供しない | authentication-flows | `grant_type=password` |
| SEC-013 | 2.5 クライアント認証 | SHOULD（非対称の方式） | `private_key_jwt` を勧める。`client_secret_basic`・`client_secret_post` も受ける。`client_secret_jwt` は提供しない（ADR-0004） | authentication-flows | 期限切れ・`aud` 違い（`issuer` 以外。互換のフラグ `legacy_token_endpoint_aud` が無効なアプリでのトークンのエンドポイントの URL を含む）・再利用の `client_assertion`（`jti` の記録） |
| SEC-014 | 4.11 オープンリダイレクト | MUST | 検証していない URI へは、エラーでもリダイレクトしない。`post_logout_redirect_uri` も登録との完全一致 | authentication-flows、sessions-and-sso | 未登録の `post_logout_redirect_uri` |
| SEC-015 | 4.12 307 のリダイレクト | MUST | 資格情報を含む `POST` の後のリダイレクトは 303 にする | universal-login | ログインの送信の応答が 307 でない |
| SEC-016 | 2.6、RFC 8725 JWT の扱い | — | 受け取る JWT のアルゴリズムを許可リストで限る。`alg: none` を拒否 | authentication-flows | `alg: none`、HS256 の `client_assertion` |
| SEC-017 | 4.16 クリックジャッキング | MUST | 認可と Universal Login の画面に `frame-ancestors 'none'` と `X-Frame-Options: DENY` | universal-login | 応答のヘッダーの検査 |
| SEC-018 | 4.15 クライアントがリソースオーナーになりすます | MUST | M2M のトークンの `sub` をユーザーの `sub` と重ならない形にする（3.2 節） | authentication-flows | クライアントの ID をユーザーの `sub` と同じ値にして登録できない |
| SEC-019 | 4.13 TLS を終端する逆プロキシ | MUST | 転送のヘッダーを CloudFront で上書きし、クライアントの値を信じない（3.1 節） | infrastructure | 偽の `X-Forwarded-Host` |
| SEC-020 | 本システムの追加：テナントの分離 | 追加 | ホスト名のテナントと、クライアント・`kid`・ユーザーのテナントが一致しないものを拒否（ADR-0002） | tenants-and-applications | 別のテナントの `client_id` |
| SEC-021 | 4.2 Referer での漏えい、4.3 ブラウザの履歴 | SHOULD | 認可と Universal Login の画面に `Referrer-Policy: no-referrer`。コードの入った URL の画面を表示しない（コードはテナントのアプリへすぐリダイレクト） | universal-login | 応答のヘッダーの検査 |
| SEC-022 | 2.2.1 アクセストークンの送信者の制約 | SHOULD | MVP では提供しない（DPoP は MVP の後。[intent.md](../intent.md)）。**逸脱として記録する。** 有効期間を短くする設定と、リフレッシュトークンで補う | authentication-flows | —（MVP の後に行を更新する） |
| SEC-023 | 本システムの追加：未検証のクライアントへの自動のリダイレクト | 追加 | 登録していない・検証していないクライアントへの自動のリダイレクトをしない（Dynamic Registration は MVP で提供しない） | authentication-flows | — |
| SEC-024 | 2.6 TLS | MUST | TLS 1.2 以上。HSTS は本システムのドメイン（`*.jp.<brand>.<domain>` など）で `includeSubDomains` 付き。カスタムドメインにも HSTS を付けるが、`includeSubDomains` と `preload` は付けない（テナントの他のサブドメインに影響するため。[custom-domains.md](custom-domains.md) の 4.2 節） | infrastructure、custom-domains | TLS 1.1 の接続が拒否される。カスタムドメインの応答の HSTS に `includeSubDomains` がない |

- 各行の「決める領域」の文書は、振る舞いの詳細と、対応する要件 ID（`REQ-*`）を持つ。この表は、それらへの索引と、テストの追跡の起点である。
- 逸脱（SEC-022）は、GA の前にセキュリティの担当と PM が受け入れを判断する。

## 5. 暗号化

### 5.1 転送中

| 区間 | 方式 |
| --- | --- |
| 利用者 → CloudFront | TLS 1.2 以上（CloudFront のセキュリティポリシーで古い暗号を外す）、HSTS |
| CloudFront → ALB | TLS。オリジンの証明書は ACM |
| ALB → タスク | TLS（タスクの自己署名ではなく、Private CA の証明書） |
| Auth・mgmt → Signer | 相互 TLS（Private CA、7 日の証明書。ADR-0059） |
| タスク → Aurora・Valkey | TLS。Aurora は `rds.force_ssl`、Valkey は転送中の暗号化と AUTH |
| Worker → 外部 | TLS。証明書の検証を外さない |

### 5.2 保存時

鍵の階層の正本は [keys-and-secrets.md](keys-and-secrets.md) の 3 節（[ADR-0045](../decisions/0045-kms-key-hierarchy.md)）。KMS の鍵は用途ごとに 4 つで、どれもマルチリージョン（主は東京、レプリカは大阪）。

| KMS の鍵 | 守るもの | 使える主体 |
| --- | --- | --- |
| `<brand>-signing-keys` | 署名の秘密鍵（署名鍵ごとの DEK）、外部 IdP の鍵（接続ごとの DEK。ADR-0047） | Signer のタスクのロールだけ（ADR-0003） |
| `<brand>-credentials` | テナントごとの DEK → TOTP の種、接続のシークレット、ログストリーム・メールの資格情報 | Auth・Management API・Worker（ADR-0004） |
| `<brand>-pepper` | pepper | Auth・Management API（`Decrypt` だけ） |
| `<brand>-data` | Aurora・S3・SQS・Secrets Manager・バックアップの保存の暗号化 | 各 AWS のサービス（`kms:ViaService`） |

- log-archive のアカウントのバケット（監査ログ、CloudTrail）は、log-archive のアカウントの鍵で暗号化する（prod のアカウントの主体が消せない・読めないようにする）。
- 削除の保護（SCP と 2 人の承認）、暗号化の文脈、ローテーションは keys-and-secrets の領域で決める。

## 6. 監査ログ

方針は [ADR-0054](../decisions/0054-audit-log.md)。

| 系統 | 記録するもの | 置き場所 |
| --- | --- | --- |
| テナントの監査（`audit_events`） | 設定、アプリ・API・接続、シークレットの発行、署名鍵のローテーション・失効、カスタムドメイン、メンバーとロール、攻撃の防御の設定、ログストリーム、ユーザーの削除・ブロック・MFA のリセット・一括の操作 | Aurora（テナントテーブル）→ log-archive |
| プラットフォームの監査（`platform_audit_events`） | 運用者の本番へのアクセス、サポートの参照、本システムの判断での鍵の失効、テナントの停止、break-glass、リーガルホールド | 同上 |
| AWS の操作 | CloudTrail（組織の証跡）。KMS の `Decrypt`・キーポリシーの変更を含む | log-archive |
| 認証のイベント | ログイン、トークン、MFA、ブロック | logs-and-streams の領域 |

- テナントの管理者は、自分のテナントの監査ログを 90 日見られる（既定案）。
- 保持の期間は 9 節。法務の L5 の結論で確定する。

## 7. 秘密情報の管理

| 秘密情報 | 保存 | ローテーション |
| --- | --- | --- |
| 署名の秘密鍵 | Signer の中で生成し、`signing` の鍵でエンベロープ暗号化（ADR-0003） | テナントの操作、緊急の操作（[runbooks/emergency-key-rotation.md](../runbooks/emergency-key-rotation.md)）。定期の自動は keys-and-secrets の領域 |
| 外部 IdP の秘密鍵（Apple の `.p8`、OIDC の `private_key_jwt`・SAML の SP の鍵） | Signer の中で暗号化（`signing` の鍵。`external_idp_keys`）。Auth・Management API は平文を持たない（ADR-0047） | テナントの操作（接続の鍵の入れ替え） |
| pepper の鍵 | `pepper` の鍵で暗号化し、Secrets Manager に暗号文 | 版を付け、ログインの成功時に作り直す（ADR-0004）。漏えいの疑いで入れ替える |
| クライアントシークレット、リフレッシュトークン、認可コード | SHA-256 だけ（ADR-0004） | テナント・利用者の操作 |
| 接続のシークレット（ソーシャル IdP）、ログストリームの資格情報、TOTP の種 | `credentials` のエンベロープ暗号化 | テナントの操作 |
| DB の認証情報、内部の API キー、外部の提供者（メール、ボットの検知）の鍵 | Secrets Manager | 自動のローテーション（他の題材と同じ）。外部は 90 日か提供者の上限 |
| 相互 TLS の証明書 | AWS Private CA | 7 日で自動（Signer）、90 日（その他） |
| CloudFront → ALB の秘密のヘッダー | Secrets Manager | 90 日。新旧の 2 つを受ける期間を置く |

- 本システムのトークン・キーの接頭辞（`<brand>_rt_` など）は、GitHub のシークレットスキャンのパートナープログラムに登録する（リポジトリ共通の ADR-0006）。漏えいの通知を受けたら、該当のトークンを失効させる（`secret-leak` の runbook は E12 で作る）。

## 8. 社内の運用者のアクセス

方針は [ADR-0056](../decisions/0056-operator-access.md)。

- 常設の権限はダッシュボード・メトリクス・秘密を含まないログだけ。DB・シェル・KMS の管理は期限つき（最長 4 時間）。
- テナントのデータの参照は、テナントの管理者の許可を前提にする。
- なりすましの機能（運用者がテナントのユーザーとしてトークンを作る）を作らない。
- 署名鍵の `Decrypt` は、人のロールに与えない（break-glass も含む）。
- AI エージェントは本番に経路を持たない。
- 四半期ごとにアクセスをレビューする。

## 9. データのライフサイクル

方針は [ADR-0055](../decisions/0055-data-retention-and-deletion.md)。**期間はすべて既定案で、法務の確認（L1・L5・L7）で確定する。**

| データ | 保持（既定案） | 期限後 |
| --- | --- | --- |
| ユーザーのプロフィール | テナントが消すまで | 墓石 30 日 → 物理削除 |
| 資格情報（パスワードのハッシュ、TOTP の種、WebAuthn の資格情報、リカバリーコード） | ユーザーが消すまで。ユーザーの削除で即時 | 物理削除（同じトランザクション） |
| セッション | 終わってから（`ended_at`・期限から）30 日（[sessions-and-sso.md](sessions-and-sso.md) の 5 節） | 物理削除 |
| リフレッシュトークンの系列 | 最終の期限（既定 30 日、最大 1 年）＋ 30 日（再利用の検知の記録） | 物理削除 |
| 認可コード、デバイスコード、ログインのトランザクション | 有効期間 ＋ 1 日 | 時間のパーティションを `DROP` |
| 認証のイベントのログ | テナントの検索：テナントの属性 `log_retention_days`（1・5・10・30 日。本番の既定 30 日、本番以外 5 日。ログの Aurora は 31 日でパーティションを `DROP`）。本システムの調査用の保管（S3）：90 日（[logs-and-streams.md](logs-and-streams.md) の 4.2 節）。`user_name` はメールアドレスを含む（本家と同じ。同じ文書の 3.1 節） | 削除。ユーザーの削除時はメール・名前を仮名化 |
| 監査ログ（テナント・プラットフォーム） | DB に 1 年、log-archive に 7 年 | 削除 |
| アプリのログ | CloudWatch Logs 30 日、log-archive 13 か月（秘密と個人データを含めない） | 自動 |
| メールの送信の記録（`email_messages`。本文なし） | 30 日（[email-delivery.md](email-delivery.md) の 8 節） | 削除 |
| 規約への同意の記録（`consent_records`） | 法務の L5・L8 の結論まで消さない（[ADR-0013](../decisions/0013-consent-records.md)） | 結論で決める |
| Action の実行の記録（MVP の後） | 10 日（[extensibility.md](extensibility.md) の 8 節） | パーティションを `DROP` |
| 漏えいしたパスワードのデータ（Pwned Passwords の取り込み。自前のホストは法務の確認の後。[ADR-0025](../decisions/0025-breached-password-detection.md)） | 最新の版と 1 つ前の版 | 古い版を削除 |
| テナント | 削除の操作の後 30 日（復元できる） | 全行と鍵の暗号文を物理削除 |
| バックアップ | 35 日 | 期限で消える（削除の最終の期限） |

- リーガルホールドは保持の期限に優先する（ADR-0055）。

## 10. セキュリティの試験

| 種類 | 対象 | 頻度 | 合否 |
| --- | --- | --- | --- |
| SAST、シークレットスキャン、依存・イメージ・IaC の検査 | 全体 | PR、毎日 | 他の題材と同じ（High 以上 0 件） |
| 拒否の側のテスト（`SEC-NNN`） | 4 節の全行 | PR | 全件の成功（ADR-0053） |
| 適合試験 | 対象のプロファイル | PR、`main`、夜間 | 全件の成功（[ADR-0064](../decisions/0064-conformance-suite-in-ci.md)） |
| 差分テスト（node-oidc-provider） | 主要なフロー | PR | 違いがすべて説明されている（ADR-0001） |
| ファジング | `/authorize`・`/oauth/token` のパーサー、JWT の検証 | PR（短）、夜間（長） | 500 と秘密の出力が 0 件（ADR-0065） |
| テナントの分離 | 性質ベーステスト、結合テスト | PR | ADR-0002 のとおり |
| 秘密の出力の走査 | テストのログ・スナップショット、本番のログ | CI、本番は常時 | 0 件（ADR-0061） |
| DAST | staging の認証の経路と管理の経路 | 夜間とリリース前 | High 以上 0 件 |
| 外部のペンテスト | 認可サーバー、Universal Login、Management API、Signer の境界 | E12 と、その後は年 1 回と大きな変更の後 | Critical・High がすべて修正済み |
| 模擬のクレデンシャルスタッフィング | staging | E8、四半期 | ブロック 99% 以上、誤ブロック 0.1% 以下（K5） |
| IAM・ネットワークの静的検査 | Terraform | PR | ADR-0056・0059 の条件 |

- 脆弱性の報告窓口（`security.txt`）を公開の時点で置く。バグバウンティは GA の後に招待制で始める（ADR-0053）。

## 11. 脆弱性の管理

他の題材の期限（Critical：緩和 24 時間・修正 7 日、High：30 日）を使う。加えて次のとおり。

- **署名鍵・資格情報の漏えい、テナントの分離の破れ、認証の迂回（他人としてログインできる）につながる脆弱性は、CVSS にかかわらず Critical** とする。
- `jose`・WebAuthn のライブラリ・Argon2id のバインディングの脆弱性は、公開から 24 時間以内に影響を判定する。
- 本システムの利用者（テナント）の側の SDK・サンプルの脆弱性も、同じ期限で扱う。

## 12. インシデントへの対応

- 手順は [runbooks/incident-response.md](../runbooks/incident-response.md)。署名鍵の漏えいの疑いは同じ runbook の場面と [runbooks/emergency-key-rotation.md](../runbooks/emergency-key-rotation.md)、クレデンシャルスタッフィングの波も同じ runbook にある。
- **個人データの漏えい等のおそれ**のとき、個人情報保護委員会への報告と本人への通知の要否、報告の主体（テナントか本システムか）は法務が判断する（13 節の L1）。他の題材で確かめた期限の目安は、速報が概ね 3〜5 日以内、確報が 30 日以内（不正の目的によるものは 60 日以内）（Stripe の [security.md](../../../stripe/docs/architecture/security.md) の 12 節）。
- 検知の源：GuardDuty、Security Hub、秘密の出力の走査、KMS の操作のアラート（CloudTrail）、攻撃の防御のメトリクス、シークレットスキャンのパートナーからの通知、外部からの報告。
- インシデントの対応の訓練は年 1 回（署名鍵の漏えいの机上訓練を含む）。

## 13. 法務の論点（法務の確認待ち）

**結論は出さない。** 設計は、どの結論にも対応できる形にする。下の表の「止まるもの」は、確認が済むまで PM・QA が承認しない。全体の一覧は [intent.md](../intent.md) の「法務の確認待ち」にある。

| # | 論点 | security の領域の設計への影響 | 止まるもの |
| --- | --- | --- | --- |
| L1 | 個人データの扱い（委託か自ら取得か）、漏えい等の報告の義務を負う者と手順、外国にある第三者 | 12 節の報告の手順。インシデントの runbook の連絡先 | E12 の GA の判定（インシデントの手順の確定） |
| L1 | AWS WAF の ATP（パスワードとユーザー名を AWS の盗まれた資格情報のデータと照合する）を使うとき、それが外国にある第三者への提供に当たるか（CloudFront・WAF はグローバルなサービス） | ATP を使うかどうか（[infrastructure.md](infrastructure.md) の 4.3 節） | E8 で ATP を有効にする Story |
| L5 | 認証のイベントのログと、監査ログの保持の期間 | 9 節の期間 | E10 のログの保持とアーカイブ |
| L6 | データの所在：バックアップ（大阪は国内）、CloudFront・WAF のログ（グローバルなサービスで、ログの保存先は選べるが処理の場所は選べない。未検証）、サポートでの参照 | 5 節、9 節、[infrastructure.md](infrastructure.md) の 1 節 | E1 のリージョンの構成 |
| L7 | DPA、サブプロセッサーの一覧、削除の請求の窓口、バックアップからの削除の期限（35 日）の説明 | 9 節、ADR-0055 | E12 の GA の判定 |
| 新 | 運用者によるテナントのデータの参照（インシデントの対応の例外）を、契約でどう約束するか | 8 節、ADR-0056 | E12 の GA の判定 |
| 新 | 署名鍵の漏えいを本システムの判断で失効させる権限（テナントの同意なしに、テナントのアプリのログインを一時的に止めうる）を、契約にどう書くか | [runbooks/emergency-key-rotation.md](../runbooks/emergency-key-rotation.md) | E12 の GA の判定 |

## 14. Epic との対応

| Epic | Story の候補 |
| --- | --- |
| E1 | アカウントと境界（edge、log-archive）、Signer のサブネットと相互 TLS、KMS の鍵とキーポリシー、`SEC-` の追跡の CI、秘密の出力の走査（CI と本番）、監査ログの表とアーカイブ |
| E3 | SEC-001〜009・011・013・016・018・020 の拒否の側のテスト |
| E4 | SEC-015・017・021 のヘッダー、ユーザーの存在の列挙の対策、CSRF |
| E5 | SEC-010・014 |
| E9 | 管理者の MFA、危険な操作の再認証、テナントの監査ログの画面、サポートの参照の許可 |
| E10 | 保持と仮名化のジョブ、ハッシュの連鎖の検証 |
| E12 | 外部のペンテスト、模擬のクレデンシャルスタッフィング、インシデントの机上訓練（署名鍵の漏えい）、`security.txt`、法務の論点の確定 |

## 15. 持ち越し

- ASVS 5.0 の要件の番号の照合（E1）。
- ATP を使うか（L1 と費用。E8 の着手前）。
- 本家のサポートの参照の許可の仕組み（未検証。資料にあるのはテナントのメンバーの「Support Access」のロールだけ。[ADR-0056](../decisions/0056-operator-access.md) の Context）。試用のテナントか本家への問い合わせで確かめる。

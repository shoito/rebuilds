# Intent: Auth0 を AI エージェント主体で再構築する

- Author: shoito
- Status: accepted
- Date: 2026-09-27

## Problem

Web やモバイルのアプリを作るたびに、ログイン、サインアップ、パスワードの再設定、ソーシャルログイン、MFA、API の認可を作ることになる。これを安全に作るのは難しい。

- 標準（OAuth 2.0・OpenID Connect）の解釈を誤ると、トークンの盗用やなりすましにつながる。
- パスワードの保存、ブルートフォース、漏えいしたパスワードの使い回し（クレデンシャルスタッフィング）への備えが要る。
- パスキー・MFA・ソーシャルログインは、仕様と各社の実装の差を追い続ける必要がある。
- ログインが止まると、そのアプリの全機能が止まる。

本家 Auth0 は、これを「ホスト型のログイン画面」「標準に準拠した認可サーバー」「ユーザーの保存」「攻撃の防御」「管理 API」として提供している。その中身を、小さなチームと AI エージェントでどこまで作り直せるかを確かめる。

## Proposed outcome

アプリの開発者が、テナントを作り、アプリケーションと API を登録するだけで、安全なログインと API の認可を使える認証基盤を作り直す。次の 3 つの価値を満たす。

1. **すぐに組み込める**：ホスト型のログイン画面（Universal Login）と、標準の OIDC・OAuth のフローで、どの言語の標準的なライブラリからも使える。ダッシュボードと Management API で設定できる。
2. **安全**：標準と最新のセキュリティの指針（RFC 9700、NIST SP 800-63B-4）に従う。秘密を平文で持たず、攻撃を既定で防ぐ。
3. **止まらない**：ログインとトークンの発行は、依存先の一部が落ちても続く。月間 99.99% を目標にする（本家の Enterprise の SLA と同じ）。

### MVP（S1）に含める

- **テナント**：環境（開発・ステージング・本番）ごとに別のテナント。リージョンは日本だけ
- **アプリケーション（クライアント）と API（リソースサーバー）**：種類（SPA、Web、ネイティブ、M2M）、許可するグラント、コールバックの URL、スコープ、M2M の許可
- **Universal Login**：ホスト型のログイン・サインアップ・再設定・MFA の画面。ロゴ・色・文言（日本語と英語）をテナントごとに変えられる
- **データベース接続**：ユーザー名またはメールアドレスとパスワード、サインアップ、パスワードの再設定、メールアドレスの確認、パスワードのポリシー
- **ソーシャル接続**：Google、Apple、LINE、GitHub。同じ人の複数の ID のリンク
- **OIDC・OAuth のフロー**：
  - 認可コード＋PKCE（RFC 7636）
  - クライアントクレデンシャル
  - リフレッシュトークンのローテーションと再利用の検知
  - デバイス認可グラント（RFC 8628）
  - discovery、JWKS、userinfo、トークンの失効
- **セッションと SSO**：テナントの中のアプリの間の SSO、RP-Initiated Logout、Back-Channel Logout
- **MFA**：TOTP、WebAuthn・パスキー（MFA とパスワードなしのログインの両方）、メールの OTP、リカバリーコード
  - メールの OTP は、他の独立した要素を登録した利用者の補助に限る。本家も同じ扱いで（[MFA Factors](https://auth0.com/docs/secure/multi-factor-authentication/multi-factor-authentication-factors)）、NIST SP 800-63B-4 はメールを out-of-band の認証に使うことを禁じている（[SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b.html)）。どちらも 2026-09-27 に確認
- **攻撃の防御**：ブルートフォースの防御、不審な IP の抑制、漏えいしたパスワードの検知、ボットの検知
- **Management API**：テナントの設定、アプリケーション、API、接続、ユーザー、ログの操作。M2M のアクセストークンで守る
- **ダッシュボード**：テナントの管理者向けの Web 画面
- **ログとログストリーム**：認証のイベントのログ、検索、外部への送信（Webhook と Amazon EventBridge）
- **カスタムドメイン**：テナントごとに 1 つ。証明書は本システムが管理する

### MVP の後の Epic で扱う

| 機能 | 理由 |
| --- | --- |
| PAR（RFC 9126）、DPoP（RFC 9449） | 金融・高保証の用途で要る。MVP の認可コード＋PKCE の上に足せる |
| SMS・音声の OTP | 送信の費用、SIM スワップの危険、国内の送信事業者との契約と法令の確認（L4）が要る |
| エンタープライズ接続（SAML 2.0、OIDC、Microsoft Entra ID、コネクタのエージェント経由の LDAP） | B2B の要件。MVP のフローと接続の抽象の上に足す |
| Organizations（B2B のテナントの中の組織、招待、組織ごとの接続） | B2B の要件。エンタープライズ接続と一緒に扱う |
| Actions（テナントが書くコードでの拡張） | 任意のコードを認証の経路で動かすため、隔離の設計が重い（ADR-0005 の依存の制約とも関わる） |
| SCIM 2.0 の受け入れ（RFC 7643・7644） | エンタープライズ接続と Organizations の後 |
| ユーザーのインポート・エクスポート（一括） | 他の IdP からの移行の要件。ハッシュの取り込み（ADR-0004）は MVP から備える |
| パスワードなしのログイン（メールのリンク・コード） | MVP はパスキーを優先する |
| トークン交換（RFC 8693）、FGA（細かな認可）、外部の API のトークンの保管（Token Vault に相当）、AI エージェントの認証 | MVP の後に、需要を見て扱う |
| 複数のカスタムドメイン、リスクに応じた MFA、海外のリージョン | S2 以降 |

### 守るべき振る舞い

- テナントは、他のテナントのユーザー・設定・ログを一切見られない。あるテナントの鍵で、他のテナントのトークンは作れない。
- パスワード、クライアントシークレット、リフレッシュトークン、認可コードは、平文で保存されず、ログにも出ない。
- 署名の秘密鍵は、署名の専用のサービス（Signer）の外に平文で出ない。
- 使用済みのリフレッシュトークンが再び使われたら、その系列のトークンをすべて失効させる。
- 認可コードは 1 回しか使えず、PKCE の検証なしにはトークンと交換できない。
- 登録されていない `redirect_uri` には、コードもエラーも送らない。
- ログアウトしたセッションでは、SSO でログインできない。Back-Channel Logout を登録したアプリには、ログアウトを通知する。

### 成功の基準

| # | 基準 | 目標 | 測り方 |
| --- | --- | --- | --- |
| K1 | 認証の経路の可用性 | 月間 99.99%（NFR-001） | 合成監視と、エンドポイントの 5xx・タイムアウトの割合 |
| K2 | 標準への準拠 | GA の前に、OpenID Certification の OP の Basic・Config・Form Post・RP-Initiated Logout・Back-Channel Logout のプロファイルに合格する（Form Post は 2026-09-27 に対象に加えた。[authentication-flows.md](architecture/authentication-flows.md) の 14 節） | OpenID Foundation の適合試験。CI でも毎回回す。GA の判定は `main` の夜間で 7 日続けて通ること（[quality.md](quality.md)） |
| K3 | 組み込みの速さ | 新しいテナントを作ってから、サンプルアプリで最初のログインが通るまで、中央値 15 分以内 | オンボーディングのイベントの計測 |
| K4 | ログインの速さ | Universal Login の送信から応答まで p99 500ms 以内（NFR-002） | サーバーの計測 |
| K5 | 攻撃の防御 | 模擬のクレデンシャルスタッフィングで、攻撃の試行の 99% 以上をブロックし、正規のログインの誤ブロックは 0.1% 以下 | E8 の模擬試験。本番では日次の集計 |
| K6 | 秘密の漏れ | ログ・トレース・エラーの本文に、トークン・パスワードの形が出た件数 0 件 | CI とログの走査 |
| K7 | テナントの分離 | 他のテナントのデータが見える事象 0 件（NFR-008） | 性質ベーステストと本番の監査 |
| K8 | パスキー | 対応するブラウザ（Chrome、Safari、Edge、Firefox の最新 2 版）と iOS・Android で、登録とログインの E2E が通る | E7 の E2E（仮想の認証器と実機） |

## Affected users and systems

- **テナントの開発者**（主な利用者）：日本の B2C・B2B のアプリを作る開発者。スタートアップから中堅の事業者を最初の対象にする。LINE ログインと日本語の画面が必須になる B2C を重視する。
- **テナントの管理者**：ダッシュボードで、設定、ユーザーの管理、ログの確認をする人。
- **エンドユーザー**：テナントのアプリにログインする人。日本語の画面と、パスキー・ソーシャルログインで使う。
- **外部のシステム**：ソーシャル IdP（Google、Apple、LINE、GitHub）、メールの送信事業者、ログの送信先、漏えいしたパスワードのデータセット、第三者の CAPTCHA の提供者（持つかどうかは法務の L2 の後）。
- **社内の運用**：サポート、セキュリティの監視、障害の対応。

## Constraints

- **このシステム自体が IdP である。** アプリ向けの認証ライブラリ（Better Auth など）は使わず、OAuth・OIDC の認可サーバーを自前で実装する。暗号の部品は検証済みのライブラリを使い、OpenID Certification を目標にする（[ADR-0001](decisions/0001-platform-and-stack.md)）。
- **標準**：OpenID Connect Core 1.0、OAuth 2.0（RFC 6749）と OAuth 2.1 の草案の方針、RFC 9700（OAuth 2.0 のセキュリティの BCP）、RFC 7636、RFC 8628、RFC 9068、OpenID Connect の RP-Initiated Logout・Back-Channel Logout、WebAuthn Level 3、NIST SP 800-63B-4 に従う。暗黙フロー（implicit）とリソースオーナーのパスワードのグラントは提供しない（RFC 9700 が非推奨にしている）。
- 実行基盤と技術は、rebuilds の他の題材の決定（AWS 東京・大阪、TypeScript、Terraform、OpenTelemetry）を引き継ぐ（[ADR-0001](decisions/0001-platform-and-stack.md)）。
- 本家の名前は識別子に使わない。ドメインは `<tenant>.jp.<brand>.<domain>` の形、ヘッダーは `<Brand>-Client` の形で書く（[リポジトリ共通の ADR-0006](../../../docs/decisions/0006-brand-neutral-identifiers.md)）。本家の SDK とそのまま互換にすることは目標にしない。標準のプロトコルで互換にする。
- 日本の法令（個人情報保護法、電気通信事業法）への対応は、法務の確認を前提に設計する。
- 規模は段階的に広げる（[architecture/](architecture/README.md) の「規模の段階」）。

## Non-goals

| 機能 | 理由 |
| --- | --- |
| Private Cloud（専用の環境での提供） | 運用の形が別になる。S3 のセル構成の大口向けの専用セルで一部を代替する |
| HIPAA の BAA、FedRAMP などの海外の認定 | 日本の市場を先にする。本家でも Enterprise の追加の契約（[Auth0 Pricing](https://auth0.com/pricing)、2026-09-27 に確認） |
| 暗黙フロー、パスワードのグラント（ROPG） | RFC 9700 が非推奨にしている。移行の需要が出たら、別の ADR で扱う |
| 埋め込み型のログインの部品（Lock に相当）、ログインの画面の独自のホスト | フィッシングへの耐性と CSP の管理のため、ホスト型の Universal Login に限る |
| 独自のプッシュ通知の認証アプリ（Guardian に相当） | モバイルアプリの配布と保守が要る。パスキーと TOTP で代替する |
| WS-Federation、旧来の拡張（Rules、Hooks に相当） | 旧来の仕組み。拡張は Actions に相当する仕組みに一本化する |
| 闇市場の情報による早い漏えいの検知（Credential Guard に相当） | 専門のデータの調達が要る。公開のデータセットで検知する |
| 本家の SDK・Management API との完全な互換 | 標準のプロトコルで互換にする（リポジトリ共通の ADR-0006） |

## Open questions

### 法務の確認待ち

設計はどの結論にも対応できる形にするが、結論は出さない。**下の表の「承認を止める spec」は、確認が済むまで PM・QA が承認しない。**

| # | 問い | 関係する設計 | 承認を止める spec |
| --- | --- | --- | --- |
| L1 | 個人情報保護法：テナントのエンドユーザーの個人データを、委託として扱うか、本システムが自ら取得するか（いわゆるクラウドの例外に当たるか）。外国にある第三者への提供（海外のソーシャル IdP、メール・ボット検知の提供者、ログストリームの送信先）の扱いと、本人への情報の提供。漏えい等の報告の義務を負う者と手順 | [users-and-profiles.md](architecture/users-and-profiles.md)、[connections.md](architecture/connections.md)、[logs-and-streams.md](architecture/logs-and-streams.md)、[security.md](architecture/security.md) の 13 節 | E4 のメールの送信事業者の連携、E6 のソーシャル接続、E8 のボット検知の提供者の連携、E10 のログストリーム |
| L2 | 電気通信事業法の外部送信規律：本システムがホストする Universal Login のページが、ボット検知や分析のために端末の情報を外部へ送るとき、公表の義務を負うのはテナントか本システムか。公表の方法 | [universal-login.md](architecture/universal-login.md)、[attack-protection.md](architecture/attack-protection.md)、[ADR-0026](decisions/0026-bot-detection-and-challenge.md) | E4 のログイン画面の公開、E8 のボット検知 |
| L3 | 電気通信事業法：メールの送信の代行やログストリームが「他人の通信の媒介」に当たり、届出が要るか | [email-delivery.md](architecture/email-delivery.md)、[logs-and-streams.md](architecture/logs-and-streams.md) | E4 のメールの送信、E10 のログストリーム |
| L4 | SMS・音声の OTP：国内の SMS 配信事業者との契約、送信元の表示、関係する法令（特定電子メール法の対象外と見込むが未確認） | [mfa-and-passkeys.md](architecture/mfa-and-passkeys.md) の 5.5 節 | MVP の後の SMS の Epic |
| L5 | ログの保持の期間：認証のログ（IP、端末、ユーザーの ID）を何日持つか。本家はプランで 1〜30 日（[Auth0 Pricing](https://auth0.com/pricing)、2026-09-27 に確認）。本システムの監査ログ（管理者の操作）の保持の期間 | [logs-and-streams.md](architecture/logs-and-streams.md) の 4.2 節、[security.md](architecture/security.md) の 9 節、[ADR-0055](decisions/0055-data-retention-and-deletion.md) | E10 のログの保持とアーカイブ（Object Lock のバケットを作る前） |
| L6 | データの所在：「日本のリージョンのデータを国外に出さない」をどこまで約束するか。バックアップ、DR（大阪は国内）、サポートでの参照、サブプロセッサー、ログストリームの送信先の扱い | [infrastructure.md](architecture/infrastructure.md)、[ADR-0002](decisions/0002-tenancy-and-isolation.md) | E1 のリージョンの構成、E12 の契約の文書 |
| L7 | テナントとの契約：委託の契約（DPA）の雛形、サブプロセッサーの一覧と変更の通知、エンドユーザーからの開示・削除の請求の窓口 | [users-and-profiles.md](architecture/users-and-profiles.md) の 7 節、[ADR-0055](decisions/0055-data-retention-and-deletion.md) | E12 の GA の判定 |
| L8 | 同意の記録：サインアップでの利用規約・プライバシーポリシーへの同意、未成年の扱いを、誰の責任で、どう記録するか | [universal-login.md](architecture/universal-login.md)、[ADR-0013](decisions/0013-consent-records.md) | E4 のサインアップの Story |

表の L1〜L8 のほかに、次も法務の確認待ちである（結論は出さない）。

- Pwned Passwords のデータセットを自前で保存して商用のサービスの中で使ってよいか（[ADR-0025](decisions/0025-breached-password-detection.md)）。承認を止める spec：E8 の自前のホストの Story。確認までは公式の range API を使う。
- 署名鍵の漏えいのとき、本システムの判断でテナントの鍵を失効させる権限と、運用者によるテナントのデータの参照（インシデントの例外）を、契約にどう書くか（[security.md](architecture/security.md) の 13 節）。承認を止める spec：E12 の GA の判定。

### 選定・計測で決めるもの（法務以外）

- メールの送信事業者：Amazon SES（東京、DR は大阪）に決めた。テナントの独自の SMTP と SES（クロスアカウント）も許す（[ADR-0040](decisions/0040-email-sending-platform.md)、[ADR-0041](decisions/0041-email-templates-and-tenant-providers.md)）。送信の代行の扱い（L3）は法務の確認待ちのまま。
- ボットの検知の方式：自前のリスクの点数と proof-of-work のチャレンジに決めた。WAF の Challenge はエッジの後ろ盾、第三者の CAPTCHA は L2 の結論の後（[ADR-0026](decisions/0026-bot-detection-and-challenge.md)）。
- Argon2id のパラメーターと、ログインの CPU の費用：E12 の負荷試験で決める（[ADR-0004](decisions/0004-credential-storage.md)）。
- LINE ログインでメールアドレスを得るための申請：要る。LINE Developers Console で、規約に同意し、取得の目的を説明する画面のスクリーンショットを出す（[Integrating LINE Login with your web app](https://developers.line.biz/en/docs/line-login/integrate-line-login/)、2026-09-27 に確認）。審査の期間は未検証で、E6 の着手前に申請して確かめる。
- OpenID Certification の対象のプロファイル：Form Post を含め、Dynamic は含めない（動的な登録を持たない）と決めた（2026-09-27。[authentication-flows.md](architecture/authentication-flows.md) の 13.3・14 節）。認証の費用は、OpenID Connect の 1 つのデプロイメントに、会員 700 USD・非会員 3,500 USD で、同じ暦年の中ならプロファイルを足しても追加の費用はない（[OpenID Certification Fees](https://openid.net/certification/fees/)、2026-09-27 に確認）。E12 の前に OpenID Foundation の会員になる（2026-09-27 に推奨案で確定。プロファイルが複数あり、会員の費用のほうが小さい）。

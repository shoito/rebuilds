# Dashboard: Auth0

テナントの管理者向けの Web 画面（ダッシュボード）の設計。管理者のログイン（管理用のテナント）、非常用の経路（break-glass）、管理者のロールを決める。決定は [ADR-0036](../decisions/0036-dashboard-login-via-admin-tenant.md)（管理用のテナントでのログインと SPA）、[ADR-0037](../decisions/0037-break-glass-and-admin-roles.md)（非常用の経路とロール）にある。

本家の振る舞いは、2026-09-27 に auth0.com/docs で確かめた。

## 1. 目的と範囲

| 範囲に含む | 範囲に含まない（担当の領域） |
| --- | --- |
| ダッシュボードの SPA の作り、配信、CSP | 各画面の業務の中身（各領域の Management API） |
| 管理者のログイン（管理用のテナント）、MFA、step-up、セッション | エンドユーザーのログイン（universal-login・sessions-and-sso の領域） |
| 非常用の経路（管理用のテナントが使えないとき） | 社内の運用者の本番へのアクセス（[ADR-0056](../decisions/0056-operator-access.md)） |
| テナントのメンバーのロールと、ロールからスコープへの対応 | メンバーの表と招待（[tenants-and-applications.md](tenants-and-applications.md) の 3.5 節） |

## 2. 本家の仕組み（確かめたこと）

| 項目 | 本家 | 出典 |
| --- | --- | --- |
| 役割 | ダッシュボードでできることは、概ね Management API でもできる | [Management API](https://auth0.com/docs/api/management/v2) |
| メンバーのロール | Admin（すべて）、Editor - Connections、Editor - Key Management、Editor - Organizations、Editor - Specific Apps（指定のアプリの更新だけ。作成不可）、Editor - Users（ユーザーの操作とログ）、Viewer - Users、Viewer - Config Settings（秘密・請求・ユーザー・ログを除く設定の読み取り）、サポートのロール | [Dashboard Access by Role](https://auth0.com/docs/get-started/manage-dashboard-access/feature-access-by-role) |
| 推奨 | メンバーを定期的に見直す、会社のアカウントで登録する、退職者を外す、管理者を 2 人以上置く | [Manage Dashboard Access](https://auth0.com/docs/get-started/manage-dashboard-access) |
| ログインの方法 | ユーザー名・パスワード、ソーシャル（LinkedIn・Microsoft・GitHub・Google）。MFA を足せる。企業の IdP での SSO も設定できる | [Create Tenants](https://auth0.com/docs/get-started/auth0-overview/create-tenants)、Manage Dashboard Access |
| ダッシュボード自身の基盤 | 本家のダッシュボードが本家のどのテナントで認証しているか、非常用の経路があるかは公開されていない。**未検証** | — |

## 3. 構成

```
管理者のブラウザ
  │  https://manage.<brand>.<domain>/          SPA（静的。CloudFront ＋ S3）
  │  https://manage.<brand>.<domain>/api/*      管理の経路（mgmt のサービス。ADR-0057）
  │     ├─ /api/me、/api/accounts/*、/api/tenants          アカウント・テナントの一覧（ダッシュボード専用）
  │     └─ /api/tenants/{tenant}/v2/*                     テナントの Management API と同じハンドラー
  │
  │  ログイン：https://admin.jp.<brand>.<domain>/authorize   管理用のテナント（本システム自身）
  ▼
管理用のテナント（tenant name = admin、environment = production）
```

- **SPA は静的に配る。** ダッシュボードのためのサーバーのプロセスを持たない（[ADR-0057](../decisions/0057-accounts-network-and-path-separation.md) の「dashboard は静的な配信」）。
- **API は同じオリジンの `/api/*` に置く。** mgmt のサービスが、CloudFront のビヘイビアで受ける。テナントの操作は `/api/tenants/{tenant}/v2/*` として、テナントの Management API（`https://<tenant host>/api/v2/*`）と **同じハンドラー** に渡す。検証・スコープ・監査・レート制限を共有し、認証の段だけが違う（Stripe の dashboard.md の 9.2 節と同じ考え方）。同じオリジンなので CORS が要らない。
- ダッシュボード専用の API（アカウント、テナントの一覧、メンバーの自分の情報、ブートストラップ）は、公開の契約にしない。

### 3.1 技術

Stripe の dashboard.md の 9.1 節を引き継ぐ。

| 項目 | 選択 |
| --- | --- |
| 骨格 | React、TanStack Router |
| データ | TanStack Query |
| API の呼び出し | Management API の OpenAPI から生成した型付きのクライアント |
| デザインシステム | `packages/ui`（CSS Modules、React Aria） |
| 言語 | FormatJS、ja / en |
| OIDC のクライアント | 本システムの公式の SPA 向けの SDK（本家の SDK は使わない。リポジトリ共通の ADR-0006）。ダッシュボードを最初の利用者にする |

## 4. 管理者のログイン

### 4.1 管理用のテナント

- **ダッシュボードの管理者は、本システムの管理用のテナント `admin` のユーザーである**（[ADR-0036](../decisions/0036-dashboard-login-via-admin-tenant.md)）。テナントのエンドユーザーの仕組み（Universal Login、データベース接続、ソーシャル接続、MFA、パスキー、攻撃の防御、ログ）をそのまま使う。本システムを自分で使う（dogfooding）ことで、テナントと同じ品質の保証を管理者のログインにも得る。
- `admin` は予約の名前で、テナントのメンバーの操作では作れない。設定は IaC（Terraform のプロバイダー、本システムの Management API を使う）で持ち、ダッシュボードからの変更を受けない。変更は 2 人のレビューを要する（[ADR-0065](../decisions/0065-security-sensitive-change-flow.md) と同じ扱い）。
- 認証の経路の振る舞いの変更は、管理用のテナントに最初に届く（[ADR-0066](../decisions/0066-tenant-canary-release.md) の社内のテナント）。壊れたときの影響は、4.4 節の非常用の経路で逃がす。
- 接続：データベース接続（パスワード）とパスキー。ソーシャル接続は Google と GitHub。企業の IdP での SSO（アカウントごと）は、エンタープライズ接続の Epic で足す。
- 管理用のテナントに Actions（[extensibility.md](extensibility.md)）を使わない。認証の経路の依存を増やさないため。

### 4.2 MFA とセッション

| 項目 | 値 | 理由 |
| --- | --- | --- |
| MFA | 必須。パスキー・TOTP。メールの OTP は使えない | テナントのすべての設定と利用者を変えられる権限を守る。本家は MFA を任意にしている（上の出典） |
| 管理用のテナントのセッション | アイドル 30 分、絶対 12 時間 | 他の題材の管理画面より短くする |
| アクセストークン | 10 分、`aud` は `https://manage.<brand>.<domain>/api/` | 漏れたときの窓を小さくする |
| リフレッシュトークン | ローテーションあり、再利用の検知、絶対 12 時間、アイドル 30 分 | [ADR-0003](../decisions/0003-token-formats-and-signing-keys.md) の仕組み |
| トークンの置き場所 | SPA のメモリーだけ。`localStorage`・`sessionStorage` に置かない | XSS で盗まれたトークンを、タブを閉じた後に使わせない |
| 再読み込み | 管理用のテナントのセッション（Cookie）への `prompt=none` の上位のリダイレクトで取り直す | 同じサイト（`<brand>.<domain>`）なので Cookie が送られる |

### 4.3 step-up

- 次の操作は、直近 5 分以内の MFA を要する。トークンの `auth_time` と `amr` を Management API のハンドラーが確かめ、足りなければ 403 `step_up_required` を返す。SPA は `max_age=0` と MFA を求めて再認証し、操作をやり直す。
  - 署名鍵のローテーション・失効
  - Management API への client grant の作成・拡大
  - クライアントの秘密の作成・ローテーション
  - メンバーの招待・ロールの変更
  - テナントの削除、環境の昇格
  - ログストリームの作成・宛先の変更
  - カスタムドメインの削除
- 本家の step-up の有無は未検証。

### 4.4 非常用の経路（break-glass）

ログインが止まる理由ごとに、逃げ道を決める（[ADR-0037](../decisions/0037-break-glass-and-admin-roles.md)）。

| 止まる理由 | テナントの管理者の逃げ道 | 本システムの運用者の逃げ道 |
| --- | --- | --- |
| 管理用のテナントの設定の誤り、その接続・メール・MFA の障害 | テナント自身の M2M の資格情報で Management API を使う（CLI・Terraform）。管理用のテナントに依存しない | 非常用のトークンで、管理用のテナントの設定を直す |
| 管理用のテナントの利用者（管理者）がロックされた | 同じテナントの別の `admin` が解く。いなければ、アカウントの `owner` がサポートに依頼する | 本人確認の後、非常用のトークンでメンバーを足す |
| 認証の経路の全体の障害 | 全テナントが止まっている。Management API は管理の経路なので、発行済みの M2M のトークンで続く（トークンの発行は止まる） | 非常用のトークン（KMS で署名。認証の経路と Signer に依存しない）で、障害の対応に要る設定の操作をする |
| ダッシュボードの配信の障害 | CLI・Terraform | — |

**非常用のトークン**：

- 発行は、AWS IAM Identity Center の break-glass のロール（2 人の承認、[ADR-0056](../decisions/0056-operator-access.md)）を引き受けた運用者だけが、専用の CLI で行う。
- CLI は、KMS の非対称鍵（RSA 3072 か ECDSA P-256、非常用の専用の鍵）の `Sign` で JWT を作る。署名鍵（Signer）と、どのテナントの鍵も使わない。KMS の `Sign` の上限（1 秒 1,000 回）は、この用途では問題にならない。
- クレーム：`iss` ＝ `https://break-glass.<brand>.<domain>/`、`aud` ＝ `https://manage.<brand>.<domain>/api/`、`sub` ＝ 運用者の ID、`tenant` ＝ 対象のテナント（1 つ）、`scope`（対象の操作に限る）、`incident` ＝ インシデントの ID、有効 1 時間以内。
- Management API は、非常用の発行者の公開鍵を起動時に KMS から取り、メモリーに持つ。非常用のトークンの要求は、すべてプラットフォームの監査に残し（[ADR-0054](../decisions/0054-audit-log.md)）、対象のテナントの管理者に事後に知らせる。
- **非常用のトークンで、エンドユーザーのトークン・セッションは作れない**（ADR-0056 の「なりすましの機能を作らない」）。できるのは Management API の操作だけ。ユーザーのデータの読み取りのスコープは、テナントの許可（ADR-0056）がない限り付けない。
- 年に 2 回、staging で非常用の経路の訓練をする（runbook の `dashboard-break-glass`）。

## 5. ロール

本家のロールに寄せ、名前は本システムのものにする（[ADR-0037](../decisions/0037-break-glass-and-admin-roles.md)）。

| ロール | 本家の対応 | できること |
| --- | --- | --- |
| `admin` | Admin | すべて。メンバーとロールの管理、Management API への client grant の作成、テナントの削除 |
| `editor_connections` | Editor - Connections | 接続の作成・変更・削除 |
| `editor_keys` | Editor - Key Management | 署名鍵のローテーション・失効 |
| `editor_apps` | Editor - Specific Apps | 指定のアプリ（`app_ids`）の更新と秘密のローテーション。作成は不可 |
| `editor_users` | Editor - Users | ユーザーの作成・削除・ブロック・MFA のリセット・パスワードの再設定の送信、ログの閲覧 |
| `viewer_users` | Viewer - Users | ユーザーと、ユーザーのログの閲覧 |
| `viewer_config` | Viewer - Config Settings | 設定の閲覧（秘密・ユーザー・ログを除く） |
| `editor_organizations` | Editor - Organizations | E14 で足す（[organizations.md](organizations.md)） |

- ロールからスコープへの対応は、コードの表（`role-scopes.ts`）に持ち、表駆動テストで確かめる。例：`viewer_config` は `read:clients`・`read:resource_servers`・`read:connections`（秘密を除く）・`read:tenant_settings`。`read:client_keys`・`read:users`・`read:logs` を含まない。
- メンバーは複数のロールを持てる。スコープは和集合。
- アカウントの `owner`・`billing` は、テナントのロールとは別（[ADR-0030](../decisions/0030-accounts-tenants-and-members.md)）。`owner` はテナントを作れるが、テナントの中の操作には、そのテナントのロールが要る。
- 本家の「サポートのロール」は持たない。サポートの依頼は、アカウントの `owner` と `admin` ができる。

## 6. 画面

| 区分 | 画面 | 担当の領域 |
| --- | --- | --- |
| はじめに | テナントの切り替え、クイックスタート（K3：最初のログインまで中央値 15 分）、反映の遅れの表示（最大 15 秒） | tenants-and-applications |
| アプリ | アプリ、API、M2M の許可、本番の点検 | tenants-and-applications |
| 認証 | データベース接続、ソーシャル接続、MFA、パスキー、攻撃の防御 | connections、mfa-and-passkeys、attack-protection |
| ブランド | Universal Login の見た目と文言、カスタムドメイン、メール | universal-login、custom-domains、email-delivery |
| ユーザー | 検索、詳細、ブロック、削除、MFA のリセット | users-and-profiles |
| 監視 | ログの検索と詳細、ログストリームと Health | [logs-and-streams.md](logs-and-streams.md) |
| 設定 | テナントの設定、署名鍵、メンバーとロール、監査ログ、サポートの参照の許可 | keys-and-secrets、security |

- 画面は、ロールのスコープで出し分ける。出し分けは使いやすさのためで、判定は Management API で行う（画面を隠しても、API が拒否する）。

## 7. セキュリティ

| 項目 | 方針 |
| --- | --- |
| CSP | `default-src 'self'`、`script-src 'self'`、`style-src 'self'`、`connect-src 'self'`、`img-src 'self'` とテナントのロゴの配信のドメイン、`frame-ancestors 'none'`、`object-src 'none'`、`base-uri 'none'`、`form-action 'self' https://admin.jp.<brand>.<domain>`、`require-trusted-types-for 'script'` |
| 描画 | `dangerouslySetInnerHTML` を lint で禁止する。テナントの入力（アプリの名前、メタデータ、ログの `description`、ユーザーのプロフィール）は、テキストとして描く |
| トークン | メモリーだけ（4.2 節） |
| 第三者のスクリプト | 読み込まない。計測とエラーの収集は自前（Stripe の dashboard.md の 9.3 節と同じ） |
| 秘密の表示 | 秘密は作成・ローテーションの直後に 1 回だけ表示する。表示の画面は、クリップボードへの複写の後に消す |
| クリックジャッキング | `frame-ancestors 'none'` |
| 監査 | ダッシュボードの操作は、Management API の監査（`audit_events`）に「ソース：ダッシュボード」とメンバーの ID で残す |
| 最小の権限 | 本番のテナントで `admin` が 1 人のとき、30 日ログインのないメンバーがいるときに警告を出す |

## 8. 障害のとき

| 事象 | 振る舞い |
| --- | --- |
| 認証の経路の障害 | 新しいログインができない。ログイン済みの管理者は、アクセストークンの期限（10 分）とリフレッシュの失敗までは操作できる。4.4 節 |
| 管理の経路の障害 | 画面は出るが、操作は失敗する。ステータスの画面へ案内する |
| Aurora の writer の切り替え | 書き込みが 503。SPA は `Retry-After` に従って 1 回だけ再試行し、失敗を表示する |
| 管理用のテナントのログインの失敗が急増 | アラート（合成監視の管理者のログイン）。4.4 節の手順へ |

## 9. テスト

- E2E（Playwright、仮想の WebAuthn の認証器）：管理用のテナントでのログイン、MFA、テナントの切り替え、アプリの作成、step-up を要する操作。
- 表駆動テスト：ロール × スコープ（`role-scopes.ts`）、ロール × 画面の出し分け。
- 結合テスト：`viewer_config` のメンバーのトークンで、秘密・ユーザー・ログの API が 403。
- 結合テスト：`auth_time` が 5 分より古いトークンで、署名鍵のローテーションが 403 `step_up_required`。
- 結合テスト：非常用のトークンで、対象でないテナント・スコープにない操作が 403。期限切れが 401。使用がプラットフォームの監査に残る。
- セキュリティ：CSP の違反の報告が 0 件であることを E2E の間に確かめる。`dangerouslySetInnerHTML` の lint。
- 訓練：非常用の経路を staging で年 2 回（runbook）。

## 10. この領域の ADR

| ADR | 決定 |
| --- | --- |
| [0036](../decisions/0036-dashboard-login-via-admin-tenant.md) | ダッシュボードは静的な SPA にし、管理者は本システムの管理用のテナントでログインする。MFA を必須にし、トークンはメモリーだけに置き、同じオリジンの `/api` から Management API と同じハンドラーを呼ぶ |
| [0037](../decisions/0037-break-glass-and-admin-roles.md) | 非常用の経路は、テナントの M2M と、KMS で署名した運用者の短いトークンにする。ロールは本家に寄せた 7 つ（E14 で 8 つ）にする |

## 11. Story の候補

| Epic | Story の候補 |
| --- | --- |
| E1 | 管理用のテナントを IaC で作る（予約の名前、Terraform のプロバイダーの最初の利用） |
| E2 | `manage.<brand>.<domain>/api/tenants/{tenant}/v2/*` を Management API のハンドラーに渡す経路と、管理用のテナントのトークンの検証 |
| E9 | SPA の骨格（ルーター、生成したクライアント、ja/en、CSP）とログイン（メモリーのトークン、`prompt=none` の再取得） |
| E9 | テナントの切り替え、クイックスタート、アプリ・API・許可の画面 |
| E9 | ユーザー・ログ・ログストリームの画面 |
| E9 | メンバーとロール、`role-scopes.ts`、画面の出し分け、最小の権限の警告 |
| E9 | step-up（`auth_time` と `amr` の確認、SPA の再認証） |
| E12 | 非常用のトークンの CLI と検証、訓練の runbook |
| E14 | `editor_organizations` と組織の画面 |

## 12. 未解決の問い

- 管理用のテナントに、アカウントごとの企業の IdP での SSO をいつ足すか（エンタープライズ接続の Epic の中か）。
- 本家のダッシュボードの非常用の経路の有無（未検証）。
- ダッシュボードの管理者のセッションの長さ（アイドル 30 分）が、日常の運用に短すぎないか。
- ダッシュボードの呼び出しのレート制限を、Management API の全体の枠に数えるか（[management-api-and-rate-limiting.md](management-api-and-rate-limiting.md) の 14 節）。

### 決定

2026-09-27 の既定案。

- 企業の IdP での SSO は、エンタープライズ接続の Epic（E14）で足す。MVP はパスワード・パスキー・Google・GitHub と MFA の必須。
- 管理者のセッションは、アイドル 30 分・絶対 12 時間で始め、E9 の利用の計測で見直す。
- ダッシュボードの呼び出しは全体の枠に数え、1 秒 5 の予約の枠を別に置く。

## 13. quality.md・runbooks・data-model に載せるもの

**quality.md**

- リスク：管理者のアカウントの乗っ取り、ロールの対応の誤り（`viewer_config` に秘密が見える）。ロール × スコープの表駆動テストと、E2E の step-up。
- 本番での検証：合成監視で、管理用のテナントでの管理者のログイン（仮想の認証器）を 5 分ごとに試す。
- 訓練の合否：非常用のトークンの発行から、管理用のテナントの設定の修正までを 30 分以内にできる。

**runbooks**

- `dashboard-break-glass`：管理用のテナントのログインが止まった。原因の切り分け、非常用のトークンの発行（2 人の承認）、修正、事後のテナントへの連絡。
- `admin-tenant-change`：管理用のテナントの設定の変更（IaC と 2 人のレビュー）。
- SLI の追加の依頼（Ops へ）：管理者のログインの成功率、ダッシュボードの API の p99、CSP の違反の報告の件数。

**data-model**

| テーブル | 主な列 | 備考 |
| --- | --- | --- |
| `break_glass_tokens` | `jti`、`operator_id`、`tenant_id`、`scope`、`incident_id`、`issued_at`、`expires_at` | RLS の外。発行の記録。トークンは保存しない。プラットフォームの監査と対にする |
| `dashboard_preferences` | `member_user_id`、`locale`、`last_tenant_id`、`saved_filters` | RLS の外（メンバーはテナントをまたぐ） |

メンバーとロールの表は [tenants-and-applications.md](tenants-and-applications.md) の 14 節にある。

# Accounts and Auth: Linear

アカウント（1 人が複数のワークスペース）、ログイン（メールのリンクとコード、Google、パスキー）、セッション、同期のチケット、招待、ワークスペースのログインの制限を決める。後の SAML・SCIM の置き場所も決める。認証の部品には、第三者のライブラリ Better Auth を評価して使う。

前提となる決定は、基盤（[ADR-0001](../decisions/0001-platform-and-stack.md)）、テナントとアカウントの置き場所（[ADR-0004](../decisions/0004-tenancy-and-permissions.md)）、手元の DB をアカウント×ワークスペースで分けること（[ADR-0005](../decisions/0005-client-persistence-and-offline.md)、[ADR-0014](../decisions/0014-indexeddb-layout-durability-and-migrations.md)）、Gateway のチケット（[ADR-0009](../decisions/0009-sync-gateway-protocol.md)）、端末の ID のクッキー（[ADR-0016](../decisions/0016-memory-tiers-quota-and-offline-ux.md)）、権限の関数（[ADR-0032](../decisions/0032-single-policy-module-and-group-mapping.md)）。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0034](../decisions/0034-accounts-with-better-auth.md) | 認証のサービスに Better Auth（MIT、1.7 系）を使い、`packages/auth` で包む。使う部品は、メールの OTP（コードとリンク）、Google、パスキー、セッション、複数のセッション。組織（organization）の部品は使わず、ワークスペース・メンバー・招待は自前のモデルにして Writer を通す。アカウントの表は RLS の外の `auth` スキーマに置き、ワークスペースの中の人（`User`）とは `account_id` で結ぶ。後の SAML・SCIM は同じライブラリの部品で足す |
| [0035](../decisions/0035-sessions-and-sync-ticket.md) | セッションは HttpOnly のクッキーで、使わないまま 30 日で切れる。ワークスペースへの入り口は同期のチケット（60 秒・1 回限り）で、発行の時にメンバーシップ・状態・ワークスペースのログインの制限を確かめる。セッションの取り消しと停止は Valkey で Gateway に知らせ、5 秒以内に接続を切る。Electron は、ログインをシステムのブラウザで行い、1 回限りのコードを PKCE の形で交換してセッションを得る |

## 1. 目的と範囲

- 扱う：
  - アカウント（ログインの主体）と、ワークスペースの中の人（`User`）の分け方
  - ログインの手段：メールのリンクとコード、Google、パスキー
  - セッション、複数のアカウント、ログアウト、セッションの一覧と取り消し
  - 同期のチケットの発行（[sync-engine.md](sync-engine.md) の 9.3 節の `POST /sync/ticket`）と、Gateway への取り消しの知らせ
  - Electron のログイン
  - 招待（メール、招待のリンク、許可したドメイン）、参加の手順
  - ワークスペースのログインの手段の制限
  - Better Auth の評価と使い方
  - 後の SAML・SCIM の置き場所
- 扱わない：
  - ロール、チーム、`can()`（[permissions-and-teams.md](permissions-and-teams.md)）
  - 公開 API のキー、OAuth 2.0 のアプリ（[api-and-webhooks.md](api-and-webhooks.md)）
  - 連携（GitHub・Slack）の資格情報（[integrations.md](integrations.md)）
  - 請求、プラン
  - 手元の DB の暗号化、共有の端末（[security.md](security.md)）

## 2. 本家の形と、使う部品（確かめたこと）

いずれも 2026-09-28 に確認。

### 2.1 本家（公式）

| 項目 | 内容 | 出典 |
| --- | --- | --- |
| ログインの手段 | Google、メール（リンクか、メールのコードを入力）、パスキー、SAML（Enterprise） | [Login methods](https://linear.app/docs/login-methods) |
| 手段の制限 | 管理者がワークスペースの全員のログインの手段を制限できる（Business 以上）。オーナー・管理者は締め出されないよう、どの手段でも入れる。IP の制限と SAML は Enterprise | 同上 |
| 複数のアカウント | 「アカウントを足す」で、再ログインなしにワークスペースを切り替える | 同上 |
| ログアウト | ある場所でログアウトすると、他の全部のセッションもログアウトする | 同上 |
| セッション | 今のセッションと他のセッションの一覧（場所、最後に見た日、IP、最初のログインの日）。個別と「全部」の取り消し。使わないセッションは 30 日で切れる | [Security & Access](https://linear.app/docs/security-and-access) |
| パスキー | デスクトップのアプリでは使えない | 同上 |
| 招待 | メールで招く（カンマで複数）。許可したドメインのメールの人は招待なしで参加できる。招待のリンクは誰でも参加でき、使い回せ、作り直せる。有料のプランでは管理者だけが招く（設定で全員に許せる） | [Invite members](https://linear.app/docs/invite-members) |
| IdP | SAML の IdP から、招待なしでログインできる | 同上 |
| アカウントとリージョン | 利用者のアカウントは米国の認証のサービスに置き、ワークスペースのデータはリージョンに置く | [How we built multi-region support for Linear](https://linear.app/now/how-we-built-multi-region-support-for-linear)（2024-05-23） |

- メールのコードの有効期間、招待の有効期間、メールアドレスの変更の手順は、文書に書かれていない（**未検証**）。

### 2.2 Better Auth

| 項目 | 内容 | 出典 |
| --- | --- | --- |
| 版とライセンス | `better-auth` 1.7.6、MIT。`@better-auth/passkey`・`@better-auth/sso`・`@better-auth/scim` も 1.7.6 | npm のレジストリ（`registry.npmjs.org`） |
| Hono | `app.all("/api/auth/*", c => auth.handler(c.req.raw))` で載る。Web 標準の API で、アダプターが要らない | [Hono integration](https://www.better-auth.com/docs/integrations/hono) |
| PostgreSQL | `pg` の Pool と Kysely。`database.schemaName` で `public` 以外のスキーマに置ける。CLI でマイグレーションを生成できる | [PostgreSQL](https://www.better-auth.com/docs/adapters/postgresql) |
| セッション | 既定 7 日。`updateAge`（既定 1 日）ごとに期限を延ばす。`freshAge`（既定 1 日）で、重い操作に最近のログインを求める。一覧、個別・他の全部・全部の取り消し。二次の保存（Redis など）に置ける | [Session management](https://www.better-auth.com/docs/concepts/session-management) |
| メールの OTP | 6 桁、既定 300 秒、3 回まで。保存を平文・暗号化・ハッシュから選ぶ（既定は平文） | [Email OTP](https://www.better-auth.com/docs/plugins/email-otp) |
| マジックリンク | 既定 300 秒。トークンの保存を平文かハッシュから選ぶ。1 回限りで、原子的に消費する | [Magic link](https://www.better-auth.com/docs/plugins/magic-link) |
| パスキー | `@better-auth/passkey`。内部で SimpleWebAuthn を使う。`rpID` の設定、条件付きの UI（自動入力） | [Passkey](https://www.better-auth.com/docs/plugins/passkey) |
| 複数のセッション | 1 つの端末に既定 5 つ。アカウントごとにクッキーを足し、`setActive` で切り替える | [Multi session](https://www.better-auth.com/docs/plugins/multi-session) |
| SSO | OIDC・OAuth2・SAML 2.0。SAML は samlify を使う。ドメインの確認、組織への自動の加入 | [SSO](https://www.better-auth.com/docs/plugins/sso) |
| SCIM | SCIM 2.0 の Users と Groups。`/scim/v2`、Bearer のトークン。配ることとログインは別 | [SCIM](https://www.better-auth.com/docs/plugins/scim) |
| 組織 | 組織・メンバー・ロール・招待（既定 48 時間）・チーム | [Organization](https://www.better-auth.com/docs/plugins/organization) |

- 本体の表（`user`・`session`・`account`・`verification`）の名前と列の名前は、設定の `modelName` と `fields` で変えられる。部品の表は部品の `schema` で変える。コードの型は元の名前のまま（[Database](https://www.better-auth.com/docs/concepts/database)、2026-09-28 に確認）。
- 公開された脆弱性の告知（GitHub Security Advisories）は 32 件（2024-12〜2026-08。Critical 2 件は SSO と SCIM の部品、High は本体・パスキー・OAuth の提供者の部品にもある）（[better-auth の Security Advisories](https://github.com/better-auth/better-auth/security/advisories)、2026-09-28 に確認）。告知から修正の版までの速さは、この確認では測っていない（3.4 節の手順で見る）。

## 3. Better Auth の評価と使い方

ADR-0034。

### 3.1 評価

| 観点 | Better Auth | 自前（SimpleWebAuthn、OIDC のクライアントなどの部品から組む） | 管理された IdP（Cognito など） |
| --- | --- | --- | --- |
| 必要な手段（メールのコード、Google、パスキー） | 部品がそろう | 全部書く | 多くはそろう。メールのコードとリンクの両方を 1 通で送る形は作り込みが要る（未検証。管理された IdP を採らないので確かめない） |
| 技術の合い方 | TypeScript、Hono、PostgreSQL（Kysely）。同じ Aurora の別スキーマに置ける | 同じ | 別のサービス。ユーザーの表が外にある |
| 後の SAML・SCIM | 部品がある（samlify、SCIM 2.0） | 大きな作業 | ある |
| データの所在（法務の L4） | 自分の Aurora（東京） | 同じ | リージョンを選べる |
| 危うさ | 若いライブラリ。認証の核を外に頼る。版の上げで挙動が変わりうる | 自分で書いた誤り | 製品の制約。移行が難しい |
| 本家の実装との関係 | 本家と無関係の第三者の汎用の部品（[リポジトリ共通の ADR-0007](../../../../docs/decisions/0007-no-reuse-of-original-implementation.md) で使ってよい） | — | — |

- 採用：Better Auth。ただし、`packages/auth` で包み、画面と他のサービスは包みの API だけを使う。Better Auth の型・関数を他のパッケージから直接使わない（lint）。置き換えるときの範囲を包みの中に閉じるため。

### 3.2 使う部品と使わない部品

| 部品 | 使うか | 理由 |
| --- | --- | --- |
| 核（アカウント、セッション） | 使う | — |
| `email-otp` | 使う | 1 通のメールに、6 桁のコードと、同じコードを埋めたリンクを入れる（5.1 節）。本家の「リンクかコード」と同じ体験 |
| `magic-link` | 使わない | コードと別のトークンを持つことになる。メールの OTP の 1 つにまとめる |
| Google（ソーシャル） | 使う | — |
| `@better-auth/passkey` | 使う | — |
| `multi-session` | 使う | 1 つのブラウザで複数のアカウント（本家の「アカウントを足す」） |
| `organization` | **使わない** | ワークスペース・メンバー・招待・チームは、同期するモデルで、Writer を通して購読を変える必要がある（[ADR-0013](../decisions/0013-sync-group-changes-retention-and-reset.md)）。Better Auth の表に持つと、正本が 2 つになる |
| パスワード | 使わない | 本家もパスワードを持たない（2.1 節の手段にない） |
| `@better-auth/sso`・`@better-auth/scim` | MVP の後に使う | 9 節 |

### 3.3 置き場所

- 認証のサービス（`auth` のタスク）は、Hono の上に Better Auth を載せ、`https://<brand>.<domain>/api/auth/*` で受ける。同期の Sync API と同じオリジンにし、クッキーをそのまま使えるようにする。
- 表は Aurora の `auth` スキーマ（`database.schemaName`）。RLS の外で、認証のサービスの DB のロールだけが読み書きする（ADR-0004）。他のサービスは `auth` スキーマを読まない。セッションの確かめは、認証のサービスの内部の API（`POST /internal/session/verify`）か、共有の Valkey の写し（6.2 節）で行う。
- Better Auth の表と、この題材の言葉の対応：

| Better Auth | この題材 | 中身 |
| --- | --- | --- |
| `user` | アカウント | 人。メールアドレス、名前 |
| `account` | ログインの手段（識別子） | Google の `sub` など |
| `session` | セッション | 端末ごと |
| `verification` | 確認のコード | メールの OTP |
| `passkey` | パスキー | 公開鍵、カウンター |

- 表の名前は Better Auth の既定のままにする。`modelName` で変えられるが、コードの型は元の名前のままなので、名前が 2 つになり、読み違いを招くため。この文書では「アカウント」と書く。

### 3.4 版と脆弱性

- 版は固定し（`1.7.x` の範囲で、自動の更新は patch だけ）、minor 以上の上げは、6 節の結合テストとログインの E2E を通してから行う。
- GitHub の Security Advisories と、npm の監査を CI で見る。認証の部品の High 以上の告知は、7 日以内に上げるか、回避を入れる（security の領域の脆弱性の対応に入れる）。
- 告知は多い（2.2 節。2026-09-28 までに 32 件）。部品は使うまで依存に入れない（組織・OAuth の提供者・stripe は使わない。SSO・SCIM は Enterprise の Epic で入れる）。告知の対象を、依存に入れた部品だけに絞る。

## 4. アカウントとワークスペース

ADR-0034。

### 4.1 分け方

```
 auth スキーマ（RLS の外。全体で 1 つ）       ワークスペースのスキーマ（RLS。ワークスペースごと）
 ┌──────────────────────────┐              ┌───────────────────────────────┐
 │ user（アカウント）          │ account_id   │ users（User。ワークスペースの中の人） │
 │  id, email, email_verified │◀─────────────│  account_id, role, status, name   │
 │ account（Google の sub…）   │              └───────────────────────────────┘
 │ session, passkey, …        │
 │ workspace_directory        │  アカウント → ワークスペースの一覧（入り口の表）
 └──────────────────────────┘
```

- アカウントは全体で 1 つ。ワークスペースの中の人（`User`）は、ワークスペースごとに 1 行で、`account_id` を持つ（[permissions-and-teams.md](permissions-and-teams.md) の 3.2 節）。名前・表示名は `User` の側に持ち、ワークスペースごとに違ってよい。
- `auth.workspace_directory`：`(account_id, workspace_id, user_id, status)`。ログインの後に「どのワークスペースに入れるか」を出すための表。正本は各ワークスペースの `users` で、Writer がメンバーシップを変えるトランザクションの後、Relay の流れで写す（遅れは数秒）。入り口の表示に使うだけで、権限の判定には使わない（判定は 6.3 節のチケットの発行で `users` を読む）。
- S3 で海外のリージョンを足すときも、`auth` スキーマは 1 つのリージョンに置き、ワークスペースのデータはリージョンに置く（本家と同じ。ADR-0004）。

### 4.2 メールアドレス

- アカウントのメールアドレスは、小文字にした形で一意。`email_verified` は、メールの OTP か、Google の `email_verified` の主張で真になる。
- `User.email`（ワークスペースの側）は、アカウントのメールアドレスの写し。アカウントのメールアドレスを変えたら、Worker が各ワークスペースの `User.email` をシステムのトランザクションで変える。
- メールアドレスの変更：新しいアドレスへの OTP と、`freshAge`（1 日）の中のログインを求める。古いアドレスへ知らせのメールを送る。

### 4.3 アカウントの削除

- 本人の削除の求め：全ワークスペースの `User` を停止にし（履歴の名前は残す）、アカウントの表の行を消し、セッションを全部取り消す。ワークスペースの唯一のオーナーなら、先にオーナーを移すよう求める。
- 個人情報の削除の求め（法務の L7）で、履歴の名前を「削除された利用者」に置き換えるかは、security の領域と法務で決める。

## 5. ログイン

### 5.1 メール（コードとリンク）

```
 1. メールアドレスを入れる → POST /api/auth/email-otp/send-verification-otp
    （アカウントの有無にかかわらず、同じ応答と同じ時間で返す）
 2. メール：6 桁のコードと、リンク https://<brand>.<domain>/login/verify#e=<email>&c=<code>
 3a. コードを入力 → POST /api/auth/sign-in/email-otp
 3b. リンクを開く → 画面が「ログイン」のボタンを出す → 押すと 3a と同じ POST
 4. セッションのクッキーを受ける → ワークスペースの選択へ
```

- リンクの中身を URL のフラグメント（`#`）に置き、開いただけではサーバーに送らない。メールの安全のための自動の読み込み（リンクの先読み）が、1 回限りのコードを消費したり、ログを残したりしないようにするため。押すボタンを挟むのも同じ理由。
- コードは 6 桁、10 分、試行 3 回（Better Auth の既定の 5 分を 10 分に延ばす。メールの届きの遅れに備える）。保存は `hashed`。
- 新しいメールアドレスなら、この手順でアカウントを作る（招待や許可したドメインがなければ、入れるワークスペースはない。新しいワークスペースを作る画面を出す）。

### 5.2 Google

- OIDC。`email_verified` が真のときだけ、同じメールアドレスのアカウントに結ぶ（DT-AUTH-001）。
- 取得する範囲は `openid email profile` だけ。

### 5.3 パスキー

- ログインの後に、設定から登録する。登録には `freshAge` の中のログインを求める。
- `rpID` は `<brand>.<domain>`。ログインの画面で条件付きの UI（自動入力）を出す。
- デスクトップ（Electron）は、6.5 節のシステムのブラウザの経路で使える（本家のデスクトップはパスキーを使えない）。
- 1 アカウント 10 個まで。

### 5.4 アカウントの結び付け

DT-AUTH-001。ログインの手段の識別子が、どのアカウントになるか。上から評価し、最初に当たった行。

| # | 条件 | 結果 |
| --- | --- | --- |
| 1 | その識別子（Google の `sub`、パスキーの ID）が既にアカウントに結ばれている | そのアカウント |
| 2 | Google で、`email_verified` が偽 | 拒否。「メールでログインしてください」 |
| 3 | 同じメールアドレスのアカウントがある（メールの OTP、または `email_verified` の Google） | そのアカウントに、識別子を結ぶ。結んだことをメールで知らせる |
| 4 | それ以外 | 新しいアカウント |

- 行 3 は、メールアドレスを持つ人が同じ人だとみなす。Google のアカウントのメールアドレスが別の人に再利用される危うさは、Google の `email_verified` と、結んだ時の知らせのメールで抑える。

### 5.5 流量の制限

| 対象 | 上限 |
| --- | --- |
| OTP の送信（メールアドレスごと） | 1 時間に 5 回 |
| OTP の送信（IP ごと） | 1 時間に 30 回 |
| OTP の検証（コードごと） | 3 回（超えたら新しいコードが要る） |
| ログインの試み（IP ごと） | 1 分に 30 回 |

- WAF のレートの規則と、認証のサービスの中の数え（Valkey）の両方で行う。上限を超えても、送信の応答は同じ形で返す（メールアドレスの有無を明かさない）。

## 6. セッションと同期のチケット

ADR-0035。

### 6.1 クッキー

- セッションのクッキーは、`<brand>.<domain>` の HttpOnly・Secure・`SameSite=Lax`・`Path=/`。名前の接頭辞は `<brand>`（Better Auth の設定で変える。設定の名前は E4 で確かめる）。
- 状態を変える API（`POST`・`PUT`・`DELETE`）は、`Origin` がワークスペースのオリジンであることを確かめる（CSRF）。Better Auth の信頼するオリジン（`trustedOrigins`）も同じ一覧にする。
- 複数のアカウント：`multi-session` で、1 つのブラウザに 5 つまで。手元の DB はアカウント×ワークスペースで分かれている（ADR-0014）ので、切り替えても混ざらない。

### 6.2 期限と確かめ

| 項目 | 値 |
| --- | --- |
| 使わないままの期限 | 30 日（本家と同じ）。`expiresIn` 30 日、`updateAge` 1 日 |
| 重い操作の最近のログイン（`freshAge`） | 1 日。パスキーの登録、メールアドレスの変更、アカウントの削除、オーナーの操作 |
| 確かめの写し | 認証のサービスがセッションの有効を Valkey に写す（キーはトークンの SHA-256、TTL 5 分）。他のサービスは写しを読み、なければ内部の API に聞く |

- 絶対の期限（使っていても切れる時間）は MVP では置かない。オフラインで長く使う端末が、つながった時に切れていると、送れない outbox が溜まるため。Enterprise の設定（MVP の後）で足す。
- セッションが切れても、手元の DB と outbox は消さない。ログインし直したら、同じアカウント×ワークスペースの DB から続ける（ADR-0005）。

### 6.3 チケットの発行

DT-AUTH-002。`POST /sync/ticket {workspace_id, client_id}`。上から評価し、最初に当たった行。

| # | 条件 | 応答 | クライアント |
| --- | --- | --- | --- |
| 1 | セッションに `wipe_requested` がある（遠隔の消去。[security.md](security.md) の 4.3 節） | `401 wipe_required` | そのアカウントの手元の DB を、未送信を確かめずに全部消し、ログインの画面へ |
| 2 | セッションがない・切れた・取り消された | `401` | ログインの画面。手元の DB は残す |
| 3 | アカウントがそのワークスペースの `User` を持たない | `404`（ワークスペースの有無を明かさない） | 手元の DB を outbox ごと消す（件数を示してから。[bootstrap-and-partial-sync.md](bootstrap-and-partial-sync.md) の 7.6 節） |
| 4 | `User.status = suspended`、またはワークスペースが `pending_deletion` | `403 forbidden` | 同上 |
| 5 | ワークスペースのログインの制限（8 節）を、セッションのログインの手段が満たさない | `403 login_method_required`、`methods` | その手段でログインし直す画面。手元の DB は残す |
| 6 | それ以外 | `200 {ticket, url}` | WebSocket で `hello` |

- 行 1 は security の領域の依頼で統合の工程で足した。取り消したセッションの行は、`wipe_requested` がある間は消さない（端末が次にチケットを求めるまで）。`wipe_requested` はセッションの追加の列（`amr` と同じく Better Auth のセッションの追加の列）。

- チケットは 60 秒・1 回限り（[sync-engine.md](sync-engine.md) の 9.3 節）。Valkey に SHA-256 だけを、`{account_id, user_id, workspace_id, session_id, client_id}` と一緒に置く。
- Gateway は、`hello` でチケットを消費し、接続に `session_id` と `user_id` を結ぶ。
- 行 5 のために、セッションに「どの手段でログインしたか」（`amr`：`email_otp`・`google`・`passkey`、後に `saml`）を持つ（Better Auth のセッションの追加の列。data-model への項目）。

### 6.4 取り消しの知らせ

| 契機 | 知らせ | Gateway |
| --- | --- | --- |
| セッションの取り消し（本人、「全部の端末からログアウト」） | Valkey の `auth:revoked` に `session_id` | その `session_id` の接続に `kick: session_revoked` |
| 停止（`User.status = suspended`） | Writer の購読の削除（[permissions-and-teams.md](permissions-and-teams.md) の 7.4 節）と、Valkey の `auth:member_removed` に `(workspace_id, user_id)` | その人の接続に `kick: forbidden` |
| アカウントの削除 | 全セッションの取り消しと、全ワークスペースの停止 | 上の 2 つ |

- 目標：取り消し・停止から接続の切断まで p99 5 秒。
- Valkey の知らせは落ちうるので、Gateway は 5 分ごとに、自分の接続の `session_id` の有効を、写し（6.2 節）でまとめて確かめ、無効なものを切る。
- 切られたクライアントは、再接続でチケットを求め、DT-AUTH-002 の行 1〜4 に当たる。

### 6.5 Electron

```
 Electron（main）                         システムのブラウザ                 認証のサービス
  │ verifier を作り、challenge = SHA-256(verifier)
  │ open https://<brand>.<domain>/login?desktop=<challenge> ─▶│
  │                                        │ 5 節のどれかでログイン（パスキーも可）
  │                                        │ POST /api/desktop/code {challenge} ─▶│ 60 秒・1 回限りの code
  │◀── <brand>://auth/callback?code=… ──────│
  │ POST /api/desktop/exchange {code, verifier} ───────────────────────────────▶│
  │◀────────────────────────────── Set-Cookie（Electron のセッションの区画） ─────│
```

- Electron の中でログインの画面（Google の OAuth、パスキー）を開かない。Google は埋め込みの WebView からの OAuth の要求を `disallowed_useragent` で拒む（[Upcoming security changes to Google's OAuth 2.0 authorization endpoint in embedded webviews](https://developers.googleblog.com/upcoming-security-changes-to-googles-oauth-20-authorization-endpoint-in-embedded-webviews/)、2026-09-28 に確認）。Electron の窓がそれに当たるかは**未検証**だが、システムのブラウザを使えば問題にならない。パスキーの扱いも OS のブラウザの方が確か。
- `code` は `challenge` に結ぶ。他のアプリがディープリンクを横取りしても、`verifier` がなければ交換できない（RFC 7636 の PKCE の考え方）。
- ディープリンクの形は [client-app.md](client-app.md) の 11 節の規則（スキームは開発リポジトリの作成の時に決める）。

### 6.6 ログアウト

- 既定は「この端末からログアウト」：この端末のセッションを取り消し、そのアカウントの手元の DB を全部消す。未送信の outbox があれば、先に件数を示して確かめる（ADR-0005）。
- 「全部の端末からログアウト」：全セッションを取り消す（6.4 節）。他の端末の手元の DB は、次にチケットを求めて `401` になった時点では消さない（その端末でログインし直せば続けられる）。
- 本家は、ログアウトで全部のセッションを切る。本システムは、この端末だけを既定にする。1 つの端末のログアウトで、他の端末のオフラインの作業（outbox）が送れなくなるのを避けるため。

## 7. 招待と参加

### 7.1 モデル

```ts
model("Invitation", {
  groups: { rule: "admin" }, load: { strategy: "instant" }, delete: { mode: "hard" },
  fields: {
    email:      { type: "string", conflict: "server_only", max: 320, pii: "identity" },
    role:       { type: "enum<admin,member,guest>", conflict: "server_only" },
    team_ids:   { type: "set<ref:Team>", conflict: "set", max: 50, on_delete: "remove" },
    invited_by: { type: "ref:User", conflict: "server_only", nullable: true, on_delete: "nullify" },
    expires_at: { type: "timestamp", conflict: "server_only" },
    status:     { type: "enum<pending,accepted,revoked,expired>", conflict: "server_only" },
  },
});
```

- トークンは同期する行に入れない。サーバーだけの表 `invitation_tokens(workspace_id, invitation_id, token_hash)` に SHA-256 だけを置く。
- 期限は 7 日（本システムの値。本家は**未検証**）。作り直すと前のトークンは無効。
- `role = guest` は、フラグの裏（[permissions-and-teams.md](permissions-and-teams.md) の 6.4 節）。
- グループは `role:admin`。`members_can_invite` を真にしたワークスペース（既定は偽）では、メンバーが招待を作れるが、招待の一覧は管理者にだけ届く（メンバーには自分が作った招待の結果だけを通知で知らせる）。

### 7.2 参加の経路

DT-AUTH-003。ログインしたアカウントが、ワークスペースに入る経路。上から評価し、最初に当たった行。

| # | 条件 | 結果 |
| --- | --- | --- |
| 1 | 既に `User` がある（`active`） | 入る |
| 2 | 既に `User` がある（`suspended`） | 入れない（`403`） |
| 3 | 招待のトークンがあり、期限の中で、`pending` で、招待のメールアドレスがアカウントの確認済みのメールアドレスと同じ（大文字・小文字を区別しない） | 参加（7.3 節）。`role` と `team_ids` は招待のとおり |
| 4 | 招待のトークンがあるが、メールアドレスが違う | 入れない。「招待は別のメールアドレス宛てです」と示す |
| 5 | 招待のリンク（7.4 節）が有効 | `member` で参加 |
| 6 | アカウントの確認済みのメールアドレスのドメインが、ワークスペースの許可したドメインにある | `member` で参加（本家と同じく招待なし） |
| 7 | それ以外 | 入れない（`404`。ワークスペースの有無を明かさない） |

### 7.3 参加の書き込み

- 参加は、認証のサービスが Writer にシステムのトランザクション（`origin = api`、`actor = system`）を送る：`User` を作り、`team_ids`（なければワークスペースの既定のチーム）の `TeamMembership` を作り、招待を `accepted` にする。Writer は同じトランザクションで `SyncSubscription` を作る（[permissions-and-teams.md](permissions-and-teams.md) の 7 節）。
- 冪等：`client_tx_id` を `join:<workspace_id>:<account_id>` から作る。二重に押しても 1 回だけ効く（[ADR-0006](../decisions/0006-transactions-writer-and-idempotency.md)）。
- 参加の後、`auth.workspace_directory` に写る（4.1 節）。

### 7.4 招待のリンクと許可したドメイン

- 招待のリンク：ワークスペースに 1 つ。`workspace_invite_links(token_hash, created_by, created_at, disabled_at)`。管理者が作り直すと前のリンクは無効。有効・無効は管理者の設定（既定は無効）。
- 許可したドメイン：ワークスペースの設定 `allowed_email_domains`（10 個まで）。ドメインの持ち主の確認（DNS の TXT）を必須にする（確認の値と状態はサーバーだけの表 `workspace_domain_verifications`）。確かめていないドメインを許すと、誰かが同じドメインの公開のメールサービスのアドレスを作って入れるため。本家の文書は、許可したドメインを足す手順だけを書き、持ち主の確認に触れない（[Invite members](https://linear.app/docs/invite-members)、2026-09-28 に確認。確認を求めるかは**未検証**）。
- よく使われる公開のメールのドメイン（`gmail.com` など）は、許可したドメインに入れられない。

## 8. ワークスペースのログインの制限

- ワークスペースの設定 `login_methods`：`email_otp`・`google`・`passkey`（後に `saml`）の部分集合。既定は全部。`owner` だけが変えられる（DT-PERM-002 の行 1）。
- 判定はチケットの発行（DT-AUTH-002 の行 5）で行う。アカウントのログインは全体で 1 つなので、ログインの画面ではワークスペースの制限を知らない。
- オーナー・管理者は、制限にかかわらず入れる（本家と同じく、締め出しを防ぐ）。
- 制限を変えたら、満たさないセッションの接続を切る（Writer の設定の変更の後、Worker が該当の接続を Gateway に知らせる）。

## 9. 後の SAML・SCIM

- SAML：`@better-auth/sso` の SAML（samlify）で、ワークスペースごとの IdP の設定を持つ。ワークスペースの許可したドメイン（確認済み）と結び、そのドメインのメールアドレスのログインを IdP へ送る。`amr = saml`。IdP の属性でロールを決める機能は使わず、ロールはワークスペースの側で管理する（Writer を通すため）。
- SCIM：`@better-auth/scim` の SCIM 2.0 の受け口で受け、Users の作成・停止・削除を、Writer のシステムのトランザクション（参加、`status = suspended`）に変える。Groups はチームのメンバーシップに写すかを、そのときに決める。
- どちらも Enterprise の Epic（E13 以降）で、ADR を書いて足す。

## 10. 障害のときの振る舞い

| 事象 | 起きること | 備え |
| --- | --- | --- |
| 認証のサービスが落ちた | 新しいログイン、チケットの発行ができない | 既に接続しているクライアントは続ける。切れたクライアントは手元で読み書きを続け（outbox に溜まる）、再接続を待つ（NFR-006 の考え方） |
| メールの送信事業者が遅れる・落ちる | OTP が届かない | Google とパスキーで入れる。送信の失敗は画面に「メールが届かない場合は…」を出す。送信の事業者を 2 つにするかは notifications-and-inbox と決める |
| Valkey の写しが落ちた | セッションの確かめが内部の API に集まる | 内部の API を横に増やす。写しは失われてよい |
| 取り消しの知らせが落ちた | 取り消したセッションの接続が残る | 5 分ごとの確かめ（6.4 節） |
| Better Auth の版の上げで挙動が変わる | ログインが壊れる | 6 節の結合テストとログインの E2E を上げる前の必須にする。段階的なリリース |
| Google の障害 | Google でログインできない | メールの OTP とパスキー |

## 11. セキュリティ

- **アカウントの有無を明かさない**：OTP の送信、招待の受け入れ、ワークスペースの URL は、有無で応答と時間を変えない。
- **1 回限りのコードの扱い**：OTP と Electron の `code` はハッシュで保存する。リンクの中身はフラグメントに置き、アクセスのログに残さない（5.1 節）。
- **セッションのクッキー**：HttpOnly・Secure・`SameSite=Lax`。`Origin` の確認。セッションのトークンはログ・トレースに出さない。
- **チケット**：60 秒・1 回限り、URL に入れない（[sync-engine.md](sync-engine.md) の 11 節）。
- **取り消しの即時性**：停止・取り消しから切断まで p99 5 秒。
- **アカウントの乗っ取り**：メールアドレスの変更とパスキーの登録に、最近のログインを求め、古いアドレスへ知らせる。新しい端末でのログインを、メールで知らせる（設定で止められる）。
- **許可したドメイン**：DNS での確認を必須にし、公開のメールのドメインを許さない（7.4 節）。
- **ワークスペースの手段の制限**：チケットの発行で強制する。ログインの画面だけの制限にしない。
- **第三者の部品**：Better Auth の版の固定と、告知への対応の期限（3.4 節）。認証の核を外の部品に頼る危うさを、包み（`packages/auth`）と結合テストで抑える。
- **データの所在（法務の L4）**：アカウントの表は東京の Aurora。メールの送信事業者に渡るのは、メールアドレスと OTP だけ。
- **テストのデータ**：実在の人のメールアドレスを使わない（AGENTS.md）。`example.com` などの予約のドメインを使う。

## 12. テスト

- **表駆動テスト**：DT-AUTH-001（結び付け）、DT-AUTH-002（チケット）、DT-AUTH-003（参加の経路）。
- **結合テスト**（Testcontainers の PostgreSQL と Valkey、メールの送信の模擬）：
  - OTP の送信・検証・試行の上限・期限、リンクの経路（フラグメントとボタン）。
  - Google の OIDC の模擬（`email_verified` の真偽）。
  - パスキーの登録とログイン（仮想の認証器。Playwright の WebAuthn の仮想の認証器を使う）。
  - 取り消し・停止から Gateway の切断まで 5 秒以内（Valkey の知らせを落とした場合は 5 分の確かめで切れる）。
  - 招待の期限、作り直し、メールアドレスの不一致。参加の二重押しで 1 回だけ効く。
- **性質ベーステスト**：
  - **PROP-AUTH-001（チケットの 1 回限り）**：任意の並列の `hello` で、同じチケットで確立する接続は 1 つだけ。
  - **PROP-AUTH-002（入り口の一致）**：任意のメンバーシップ・停止・招待の列の後、チケットの発行の可否が、`users` の `status` と DT-AUTH-002 の結果と一致する（`workspace_directory` の遅れに左右されない）。
- **E2E**：Electron のログインの経路（システムのブラウザ → ディープリンク → 交換）。
- **ペンテスト**（E12）：アカウントの列挙、OTP の総当たり、招待の乗っ取り、ディープリンクの横取り。

## 13. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E4 | `auth-service-skeleton` | 3.3 節の認証のサービス、Better Auth、`auth` スキーマ、`packages/auth` の包み |
| E4 | `login-email-otp` | 5.1 節のコードとリンク、流量の制限（5.5 節） |
| E4 | `login-google` | 5.2 節と DT-AUTH-001 |
| E4 | `login-passkey` | 5.3 節 |
| E4 | `sessions-and-multi-account` | 6.1・6.2・6.6 節、セッションの一覧と取り消し |
| E4 | `sync-ticket` | 6.3 節と DT-AUTH-002（sync-engine の `sync-ticket` と同じ Story） |
| E4 | `revocation-propagation` | 6.4 節の Gateway への知らせと 5 分の確かめ |
| E4 | `electron-login` | 6.5 節（client-app と共同） |
| E4 | `invitations` | 7.1〜7.3 節と DT-AUTH-003 |
| E4 | `invite-link-and-domains` | 7.4 節、DNS の確認 |
| E4 | `workspace-login-methods` | 8 節 |
| E4 | `account-email-change-and-delete` | 4.2・4.3 節 |
| E4 | `workspace-directory` | 4.1 節の入り口の表と、ワークスペースの選択の画面 |
| E12 | `auth-pentest-scope` | 12 節のペンテストの範囲 |
| E13 以降 | `saml-sso`・`scim` | 9 節 |

## 14. 未解決の問い

- 認証の部品を Better Auth にするか、自前にするか、管理された IdP にするか。
- Better Auth の組織の部品を使うか。
- ログアウトで全部の端末を切るか（本家）、この端末だけにするか。
- セッションに絶対の期限を置くか。
- 招待の期限。
- 許可したドメインに DNS の確認を求めるか。
- メールのログインを、リンクとコードの 2 つの部品で作るか、コードの 1 つにするか。

### 決定

2026-09-28 の既定案。E4 の実装とセキュリティのレビューで覆りうる。

- **部品**：Better Auth を `packages/auth` で包んで使う（ADR-0034）。
- **組織の部品**：使わない。ワークスペース・メンバー・招待は自前のモデルで、Writer を通す（ADR-0034）。
- **ログアウト**：既定はこの端末だけ。「全部の端末から」を別に置く（ADR-0035）。
- **絶対の期限**：MVP では置かない。使わないまま 30 日で切れる（ADR-0035）。
- **招待の期限**：7 日。
- **許可したドメイン**：DNS の確認を必須にする。
- **メールのログイン**：OTP の 1 つの部品で、コードとリンクの両方を作る。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| クッキーの接頭辞の設定の名前 | E4 の `auth-service-skeleton` |
| Better Auth の告知への対応の速さ（告知から修正の版まで） | E4 の着手の前に、セキュリティのレビューで調べる |
| メールの送信事業者（SES か、別の事業者か）と、2 つ持つか | notifications-and-inbox と法務の L1 の後 |
| SAML の IdP の属性でロールを決めるか、SCIM の Groups をチームに写すか | Enterprise の Epic（E13 以降） |
| 本家のコード・招待の期限、ドメインの確認 | 公式の資料では確かめられなかった（**未検証**のまま） |

## 15. quality.md・runbooks・data-model への項目

### quality.md

- DT-AUTH-001〜003 の表駆動テスト、12 節の結合テスト、PROP-AUTH-001・002 を E4 のリリースの基準にする。
- Better Auth の版を上げる PR には、ログインの E2E（メール、Google の模擬、パスキー、Electron）を必須にする。
- 本番：ログインの成功率（手段ごと）、OTP の送信から検証までの時間の p95、流量の制限に当たった数。
- 本番：取り消し・停止から切断までの p99 5 秒、5 分の確かめで切った数（知らせの取りこぼしの目安）。
- E12 の外部のペンテストに、12 節の項目を入れる。

### runbooks

- `auth-outage.md`：認証のサービス・メールの送信の障害の間の案内と、回復の確かめ方。
- `account-takeover-response.md`：乗っ取りの疑いのときの全セッションの取り消し、ログインの手段の外し方、本人への連絡。
- `better-auth-advisory.md`：部品の脆弱性の告知を受けたときの影響の判断と、上げの手順。
- `invite-abuse.md`：招待のリンクや許可したドメインの悪用のときの止め方。

### data-model（索引への追加の提案）

| 表・モデル | 中身 | 節 |
| --- | --- | --- |
| `auth.user`・`auth.account`・`auth.session`・`auth.verification`・`auth.passkey` | Better Auth の表（アカウント、ログインの手段、セッション、確認のコード、パスキー）。`session` に `amr`・`wipe_requested` の列を足す | 3.3、6.3 |
| `auth.workspace_directory` | アカウント → ワークスペースの入り口の写し | 4.1 |
| `invitations`（`Invitation`）・`invitation_tokens` | 招待と、トークンのハッシュ | 7.1 |
| `workspace_invite_links` | 招待のリンク | 7.4 |
| `WorkspaceSettings`（[permissions-and-teams.md](permissions-and-teams.md) の 3.3 節） | `members_can_invite`、`allowed_email_domains`（確認の状態はサーバーだけの表 `workspace_domain_verifications`）、`login_methods`、`default_team_id` | 7.4、8 |
| Valkey | チケット、セッションの写し、`auth:revoked`・`auth:member_removed` の知らせ、流量の数え | 5.5、6 |

## 出典

いずれも 2026-09-28 に確認。

- Linear Docs, [Login methods](https://linear.app/docs/login-methods)、[Security & Access](https://linear.app/docs/security-and-access)、[Invite members](https://linear.app/docs/invite-members)
- Linear, [How we built multi-region support for Linear](https://linear.app/now/how-we-built-multi-region-support-for-linear)（2024-05-23）
- Better Auth Docs, [Hono integration](https://www.better-auth.com/docs/integrations/hono)、[PostgreSQL](https://www.better-auth.com/docs/adapters/postgresql)、[Session management](https://www.better-auth.com/docs/concepts/session-management)、[Email OTP](https://www.better-auth.com/docs/plugins/email-otp)、[Magic link](https://www.better-auth.com/docs/plugins/magic-link)、[Passkey](https://www.better-auth.com/docs/plugins/passkey)、[Multi session](https://www.better-auth.com/docs/plugins/multi-session)、[SSO](https://www.better-auth.com/docs/plugins/sso)、[SCIM](https://www.better-auth.com/docs/plugins/scim)、[Organization](https://www.better-auth.com/docs/plugins/organization)
- npm, `better-auth`・`@better-auth/passkey`・`@better-auth/sso`・`@better-auth/scim` のレジストリの情報（1.7.6、MIT）
- IETF, [RFC 7636: Proof Key for Code Exchange](https://www.rfc-editor.org/rfc/rfc7636)

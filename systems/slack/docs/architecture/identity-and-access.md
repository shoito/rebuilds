# Identity and access: Slack

認証（だれか）、セッション、SSO、招待、ロールと権限（何をしてよいか）の設計。認証の実装は [ADR-0012](../decisions/0012-self-hosted-auth-with-better-auth.md)（Better Auth）、アカウントとメンバーの関係は [ADR-0010](../decisions/0010-accounts-and-workspace-members.md)、テナントの分離は [ADR-0009](../decisions/0009-pooled-tenancy-with-rls.md)、権限判定の集約は [ADR-0005](../decisions/0005-single-authorization-check.md) に従う。

この文書の決定表は設計の草案である。ID（`DT-...`）は、E2 の各変更の `spec.md` に移すときに振る。

## 1. 全体像

```
          ┌────────────── テナントの外（グローバル） ───────────────┐
Browser ─▶│ /api/auth/*  Better Auth                              │
          │   accounts, auth_identities, sessions, passkeys,      │
          │   two_factors, verifications, sso_providers           │
          └──────────────────────┬────────────────────────────────┘
                                 │ session → account_id
          ┌──────────────────────▼────────────────────────────────┐
Browser ─▶│ /api/workspaces/{ws}/*  Hono RPC                       │
Bot     ─▶│   1. 主体の解決（セッション or API トークン）           │
          │   2. メンバーの解決 → SET LOCAL（テナントのコンテキスト）│
          │   3. authorization.ts（ワークスペース → チャンネル → 操作）│
          └──────────────────────┬────────────────────────────────┘
                                 │ WebSocket チケット（30 秒・1 回限り）
                                 ▼
                              Gateway
```

- **認証はテナントの外、認可はテナントの中** で行う。認証の結果は `account_id`（人間）か `member_id`（ボット・エージェント）だけで、ロールや権限を持たない。
- 認証の経路は `/api/auth/*` に集め、Better Auth のハンドラーに渡す。ワークスペースの API（`/api/workspaces/{ws}/*`）は Hono RPC の契約に載せる（[ADR-0008](../decisions/0008-hono-rpc-for-api-contract.md)）。
- Web と API は同じオリジン（例：`app.example.com`。CloudFront でパスにより S3 と ALB に振り分ける）に置く。Cookie を第三者のオリジンに送らずに済み、CORS と CSRF の設計が単純になる。

### 1.1 テーブル（テナントの外）

[data-model.md](data-model.md) の `accounts` を、Better Auth の `user` モデルとして使う。Better Auth のモデル名は設定で変える。

| テーブル | Better Auth のモデル | 中身 |
| --- | --- | --- |
| `accounts` | `user` | メールアドレス、メール確認済みか、作成日時、削除日時 |
| `auth_identities` | `account` | 認証手段ごとの行（Google、Microsoft、SSO の接続）。Better Auth の `account` は本システムの `accounts` と名前が衝突するため改名する |
| `sessions` | `session` | セッション。IP、User-Agent、作成日時、最終更新日時、認証の方法（後述の `auth_context`） |
| `verifications` | `verification` | メールの OTP など、一時的な検証値（ハッシュ） |
| `passkeys` | `passkey` | WebAuthn の公開鍵 |
| `two_factors` | `twoFactor` | TOTP の秘密（暗号化）、バックアップコード（暗号化） |
| `sso_providers` | `ssoProvider` | OIDC / SAML の接続設定 |

- ID は UUIDv7 にする（Better Auth の `advanced.database.generateId` に生成関数を渡す）。
- これらのテーブルは RLS の対象外である。アクセスしてよいのは `apps/api/src/auth/` のモジュールだけとし、それ以外からの import を lint で禁止する。
- テナントの中のデータは、これらのテーブルを参照しない（ADR-0010）。

### 1.2 テーブル（テナントの中）

すべて `workspace_id` を持ち、RLS を有効にする（ADR-0009）。[data-model.md](data-model.md) への追加の提案である。

| テーブル | 中身 |
| --- | --- |
| `workspace_auth_policies` | SSO の強制（`off` / `optional` / `required`）、MFA の必須、セッションの最大有効期間、ドメインでの参加の許可 |
| `workspace_domains` | ドメイン、確認の状態（DNS TXT）、用途（SSO の振り分け / ドメインでの参加） |
| `workspace_sso_connections` | `sso_providers.provider_id` との対応。1 ワークスペースに複数の接続を持てる |
| `invitations` | 招待先のメールアドレス、ロール、参加させるチャンネル、招待者の `member_id`、トークンのハッシュ、期限、受諾・取り消しの日時 |
| `api_tokens` | ボット・エージェントの `member_id`、シークレットのハッシュ、スコープ、期限、最終使用日時、取り消し日時 |

- `members.role` を `owner / admin / member / guest_multi / guest_single` に広げる（今の `guest` を 2 つに分ける）。ボット・エージェントは `account_id IS NULL` のメンバーで、ロールは `member` に固定する。
- ワークスペースに主たる所有者を 1 人置く（`workspaces.primary_owner_member_id`）。削除・所有権の移転・ワークスペースの削除は主たる所有者だけができる。

## 2. サインアップとログイン

### 2.1 手段

| 手段 | S1 | 備考 |
| --- | --- | --- |
| メールの OTP（6 桁） | ○ | 既定の手段。サインアップとログインを兼ねる |
| Google（OIDC） | ○ | |
| Microsoft（Entra ID、`common` テナント） | ○ | |
| パスキー（WebAuthn） | ○ | 登録はログイン後。以後はパスキーだけでログインできる |
| ワークスペースの SSO（OIDC / SAML） | ○（OIDC）、S1 後半（SAML） | 4 節 |
| パスワード | × | 保存しない。漏洩・使い回し・総当たりの攻撃面をなくす |
| マジックリンク | × | 採らない。PWA では、メールのリンクが別のブラウザで開き、ログインが PWA に戻らないことが多い。OTP は同じ画面で入力できる |

- OTP は 10 分で失効し、1 回だけ使え、5 回間違えたら無効にする。DB にはハッシュだけを置く。
- 応答は、アカウントが存在するかどうかで変えない（「コードを送りました」を常に返す）。メールアドレスの列挙を防ぐ。
- サインアップ時は、メールアドレスの確認（OTP の成功）をもってアカウントを作る。OAuth で作る場合は、プロバイダーがメールを確認済みと返したときだけ作る。

### 2.2 同じメールアドレスでの紐付け

別の手段で同じメールアドレスのアカウントにログインしたときの扱い。

| # | 新しい手段 | プロバイダーがメール確認済みと返す | 既存アカウント | 結果 |
| --- | --- | --- | --- | --- |
| 1 | - | いいえ | - | 拒否する。メールの OTP でのログインを案内する |
| 2 | Google / Microsoft | はい | なし | アカウントを作る |
| 3 | Google / Microsoft | はい | あり | 既存アカウントに紐付ける |
| 4 | ワークスペースの SSO | はい | なし | アカウントを作る |
| 5 | ワークスペースの SSO | はい | あり、かつメールのドメインをそのワークスペースが確認済み | 既存アカウントに紐付ける |
| 6 | ワークスペースの SSO | はい | あり、かつドメインが未確認 | 拒否する。既存の手段でログインしてから、設定画面で紐付けるよう案内する |

- 6 行目は、他人のメールアドレスを名乗る IdP を登録したワークスペースに、既存アカウントを乗っ取らせないための規則である。

### 2.3 ログイン後の流れ

1. ログインが成功すると、Better Auth がセッションを作り、Cookie を返す。
2. クライアントは `GET /api/me/workspaces` で、自分が属するワークスペースの一覧を得る。この読み取りは、`account_id` で絞る `SECURITY DEFINER` 関数で行う（ADR-0009 の「テナントをまたぐ正当な読み取り」）。
3. ワークスペースを選ぶと、以降の API は `/api/workspaces/{ws}/...` になり、6 節のメンバーの解決を通る。

## 3. セッション

### 3.1 Cookie

| 属性 | 値 | 理由 |
| --- | --- | --- |
| 名前 | `__Secure-session`（`advanced.cookies.session_token.name` に `session` を指定する） | Better Auth は `Secure` のとき、Cookie の名前の前に必ず `__Secure-` を付ける（指定した名前にも付く）ため、`__Host-` の名前にはできない（[`cookies/index.ts` の `createCookieGetter`](https://github.com/better-auth/better-auth/blob/main/packages/better-auth/src/cookies/index.ts)、[Cookies の文書](https://www.better-auth.com/docs/concepts/cookies)）。`__Host-` の代わりに、`Domain` を付けない（`crossSubDomainCookies` を使わない）・`Path=/` にすることで同じ属性にそろえる。`__Secure-` ではサブドメインからの上書きを防げないので、`app.<domain>` の兄弟のサブドメインに、他者が内容を置けるホストを作らない |
| `HttpOnly` | あり | スクリプトから読めないようにする |
| `Secure` | あり | |
| `SameSite` | `Lax` | 他サイトからの状態変更の要求に Cookie を付けない。OAuth・SAML のコールバック（トップレベルの遷移）は通す |
| 値 | 不透明なランダムなトークン（署名付き） | JWT にしない。取り消しを DB で即時に効かせるため |

### 3.2 有効期間と更新

| 項目 | S1 の値 | 実現方法 |
| --- | --- | --- |
| アイドルタイムアウト | 14 日 | Better Auth の `expiresIn`（14 日）と `updateAge`（1 日）。使うたびに延びる |
| 絶対タイムアウト | 90 日 | Better Auth に該当する設定がないため、セッションの `created_at` を認証ミドルウェアで検査する |
| ワークスペースごとの最大有効期間 | 既定なし。管理者が 1 時間〜90 日で設定できる | 6 節の表で、`sessions.created_at`（または最後にそのワークスペースの SSO で認証した時刻）と比べる |
| 重要な操作の再認証 | 直近 10 分以内の認証を要求する | Better Auth の `freshAge`。対象はアカウントの削除、MFA の変更、パスキーの削除、セッションの一覧と取り消し |

- **セッションの ID はログイン、MFA の完了、権限の昇格（SSO での再認証）のたびに作り直す**（セッション固定攻撃を防ぐ）。Better Auth がログインの都度セッションを新しく作ることは確認した。MFA も、2 要素目の検証（TOTP・OTP・バックアップコード）に通ったときに新しいセッションを作って Cookie に入れ、パスワードの段階のセッションは捨てる。TOTP の登録の完了時も、セッションを作り直して旧いものを消す（[2FA の文書](https://www.better-auth.com/docs/plugins/2fa)、[`verify-two-factor.ts`](https://github.com/better-auth/better-auth/blob/main/packages/better-auth/src/plugins/two-factor/verify-two-factor.ts)、2026-09-26 に確認）。ただし 2FA の要求は既定でメールとパスワードなどの資格情報によるサインインだけにかかり、OTP・ソーシャル・パスキーのサインインにはかからない（同じ文書）。
- セッションの正本は Aurora の `sessions` に置く。Valkey（ElastiCache）には、Better Auth の Cookie キャッシュ（`cookieCache`、最大 60 秒）だけを使う。Valkey は失われてもよい（[ADR-0003](../decisions/0003-redis-pubsub-for-fanout.md)）ので、セッションの正本を置かない。Better Auth は `secondaryStorage` を設定するとセッションをそちらに置く。`secondaryStorage` を使いながらセッションを Valkey に置かない設定はない。`session.storeSessionInDatabase: true` にすると DB にも書き、読み取りは Valkey を先に見て、なければ DB から読む（[Session Management の文書](https://www.better-auth.com/docs/concepts/session-management)、[`internal-adapter.ts` の `findSession`](https://github.com/better-auth/better-auth/blob/main/packages/better-auth/src/db/internal-adapter.ts)、2026-09-26 に確認）。そこで次のようにする。
  - `secondaryStorage`（Valkey）を使うなら、必ず `storeSessionInDatabase: true` にする。`preserveSessionInDatabase` は使わない（有効にすると DB からの読み直しをしなくなり、Valkey を失うと全員がログアウトされる）。
  - Valkey の値が先に読まれるので、セッションの取り消しと変更は Better Auth の API（`revokeSession` など）だけで行い、`sessions` の行を直接書き換えない（Valkey の写しが残るため）。
  - この制約を持ちたくなければ、`secondaryStorage` を使わない（レート制限と検証の値も DB に置く）。
  - **決定（2026-09-28）：`secondaryStorage` は使わない。** セッション、検証の値、Better Auth のレート制限の値は DB に置き、Valkey は `cookieCache` だけに使う。正本が DB の 1 か所になり、取り消しの反映が単純になる。Valkey を失ってもログアウトは起きない（ADR-0003）。DB の読み取りは `cookieCache`（最大 60 秒）で抑える。E7 の負荷試験で DB の負荷が問題になったら見直す。

### 3.3 端末の一覧と取り消し

- 設定画面に、自分のセッションの一覧（端末の種類、おおよその場所、最終使用日時、現在の端末か）を出す。Better Auth の `listSessions`・`revokeSession`・`revokeOtherSessions` を使う。
- 取り消しは次の順に効く。

  | 経路 | 反映までの時間 |
  | --- | --- |
  | HTTP API | Cookie キャッシュの最大 60 秒 |
  | WebSocket | 即時。取り消し時に Valkey の `acct:{account_id}` に `session.revoked` を publish し、Gateway が該当の接続を閉じる。publish が失われても、7 節の接続の再検証（15 分）で閉じる |

- 取り消しの操作は監査ログに残す（[security.md](security.md)）。

### 3.4 ログアウト

- ログアウトは、今のセッションを DB から消し、Cookie を消し、3.3 と同じ経路で WebSocket を閉じる。
- SSO でログインしたセッションのログアウトは、IdP のセッションを終わらせない（SAML の Single Logout は S2 で扱う）。

## 4. 多要素認証（MFA）

| 要素 | S1 | 備考 |
| --- | --- | --- |
| TOTP（認証アプリ） | ○ | Better Auth の `twoFactor` プラグイン。パスワードを持たないアカウントでも登録できる設定（`allowPasswordless`）にする |
| バックアップコード | ○ | 10 個、1 回限り。暗号化して保存する |
| パスキー | ○ | それ自体でフィッシングに強い 2 要素（所持＋生体または PIN）とみなす |
| SMS | × | SIM スワップに弱い。コストもかかる |

- メールの OTP の直後に、登録済みの 2 つ目の要素を求める。パスキーでログインした場合は求めない。
- 「この端末を信頼する」は S1 では提供しない（端末を盗まれたときの影響を減らす）。
- ワークスペースが MFA を必須にしている場合、MFA を満たさないセッションはそのワークスペースに入れない（6 節の表）。SSO でログインしたセッションは、IdP が MFA を行ったとみなし、IdP の `amr`・`acr` は確かめない（15 節の決定）。
- MFA の要素をすべて失ったときの回復は、サポートによる本人確認とし、手順は runbooks に置く（E7）。自動の回復経路は作らない。

## 5. ワークスペースの SSO

### 5.1 構成

- `@better-auth/sso` プラグインで、OIDC と SAML 2.0 の両方を扱う。
- **Better Auth の organization プラグインは使わない。** ワークスペースとメンバーの正本は、RLS の下にある `workspaces`・`members` であり、組織とメンバーシップをテナントの外に二重に持つと、どちらが正しいかがずれる。
- そのため SSO の接続は `organizationId` なしで登録し、ワークスペースとの対応は `workspace_sso_connections` で持つ。SSO でログインしたあとのメンバーの作成（JIT プロビジョニング）は、SSO プラグインの `provisionUser` フックから、本システムのコードで行う。
- **SSO の接続の登録・変更は、本システムの管理 API（`/api/workspaces/{ws}/admin/sso`）からだけ行う。** 管理 API は `authorization.ts` で `owner` か `admin` であることを確かめてから、サーバー側で Better Auth の `registerSSOProvider` を呼ぶ。`/api/auth/sso/register` などの管理系のパスは、Hono の段で Better Auth に渡さない（許可したパスだけを渡す）。
  - Better Auth 1.2.10〜1.6.10 の SSO プラグインには、組織の一般メンバーが SSO の接続を登録できる脆弱性（CVE-2026-53515、1.6.11 で修正）があった。上の方式なら、ライブラリの権限判定に頼らずに済む。

### 5.2 ドメインの確認

- 管理者がドメインを登録すると、DNS TXT レコードに置く値を発行する。確認は定期的なジョブで行い、確認できたら `workspace_domains.verified_at` を設定する。Better Auth の SSO プラグインにもドメイン確認（`domainVerification`）があるが、確認の状態をワークスペースの側で持ちたいので、使うかどうかは E2 で決める。
- **1 つのドメインを SSO の振り分けに使えるのは、1 つのワークスペースだけ** にする（ログイン画面でメールアドレスから IdP を選ぶため）。ドメインでの参加（8 節）は、複数のワークスペースが同じドメインを使ってよい。
- 確認済みのドメインを、別のワークスペースが SSO の振り分け用に申請したら、運用の判断に回す（自動では奪わない）。

### 5.3 SSO の強制

| 設定 | 意味 |
| --- | --- |
| `off` | SSO を使わない |
| `optional` | SSO でも、それ以外の手段でも入れる |
| `required` | そのワークスペースに入るには、そのワークスペースの SSO で認証したセッションが必要。ゲストは既定で除外する（管理者が含めることもできる） |

- セッションには、どのワークスペースの SSO で、いつ認証したかを `auth_context` として持たせる（例：`{"sso": {"<workspace_id>": "<認証時刻>"}}`）。1 つのセッションで、SSO を強制する複数のワークスペースを行き来できる。
- SSO を強制しているワークスペースで、IdP 側でユーザーを無効にしても、こちらのセッションは残る。S1 では、ワークスペースごとの最大有効期間（3.2）を短くして抑える。S2 で SCIM による無効化（5.4）を加える。

### 5.4 SCIM（S2）

- IdP からのメンバーの作成・更新・無効化を、SCIM 2.0（Users、S2 後半で Groups）で受ける。
- Better Auth の `@better-auth/scim` プラグインは、組織（organization プラグイン）に紐付かないトークンで `DELETE /Users` を受けると、グローバルなユーザーを削除しうる。5.1 のとおり organization プラグインを使わないので、**SCIM は自前で実装する**。
  - エンドポイント：`/scim/v2/workspaces/{ws}/Users`
  - 認証：ワークスペースごとの SCIM トークン（`api_tokens` と同じ形で、種類を `scim` にする）
  - 対応：SCIM の `Users` の `active=false` と `DELETE` は、どちらも **メンバーの無効化** にする。アカウントは消さない。
- S2 の着手時に、Better Auth の SCIM プラグインの組織なしでの振る舞いを再確認し、使えるなら自前の実装と比べる。

## 6. 認可：判定の順序

すべてのワークスペースの API は、次の順で判定する。先の段で拒否したら、後の段は評価しない。

```
0. 主体の解決    セッション or API トークン → account_id / member_id     (401)
1. テナント      パスの workspace_id のワークスペースが存在し、有効か      (404)
2. メンバー      account_id → member を解決。無効化・ポリシーの検査      (404 / 403)
   → BEGIN; SET LOCAL app.workspace_id, app.member_id
3. ワークスペース ロール × 操作                                          (403)
4. チャンネル    ロール × チャンネルの種別 × チャンネルのメンバーか        (404)
5. 操作          チャンネルの状態、対象の所有者、トークンのスコープ        (403)
```

- 3〜5 段は `domain/authorization.ts` の判定関数にまとめる（ADR-0005）。0〜2 段は認証ミドルウェアが行う。
- 存在を漏らさないため、「ワークスペースのメンバーでない」「プライベートチャンネルのメンバーでない」は 404 にする。存在を知っていてよい相手（自分が属するワークスペースでの権限不足）には 403 を返す。
- 同じ要求が複数の段で拒否されうるとき、返すのは最初の段の結果である。例：別のワークスペースの、存在しないチャンネルへの投稿は、2 段の 404 になる。

### 6.1 主体の解決（0 段）

| # | `Authorization: Bearer` | セッションの Cookie | 結果 |
| --- | --- | --- | --- |
| 1 | あり、形式が不正・未知・取り消し済み・期限切れ | - | 401 |
| 2 | あり、有効 | - | 主体はトークンのメンバー（`member_id`、`workspace_id`）。Cookie は無視する |
| 3 | なし | なし、または無効・期限切れ | 401 |
| 4 | なし | 有効、かつ `created_at` から 90 日を超える | 401（`reauth_required`） |
| 5 | なし | 有効 | 主体はセッションのアカウント（`account_id`） |

### 6.2 メンバーの解決とテナントのコンテキスト（1〜2 段）

`account_id`（またはトークンの `member_id`）とパスの `workspace_id` から、メンバーを解決する。メンバーはまだテナントのコンテキストがない状態で引くため、`account_id` と `workspace_id` の両方で絞る `SECURITY DEFINER` 関数 `auth_resolve_member(workspace_id, account_id)` で行う（ADR-0009）。関数は、メンバーの ID・ロール・無効化の状態と、ワークスペースの認証ポリシーだけを返す。

| # | ワークスペース | 主体 | メンバー | ポリシーの違反 | 結果 |
| --- | --- | --- | --- | --- | --- |
| 1 | 存在しない、または削除済み | - | - | - | 404 |
| 2 | 存在する | トークン | トークンの `workspace_id` がパスと違う | - | 404 |
| 3 | 存在する | セッション | なし | - | 404 |
| 4 | 存在する | - | 無効化済み | - | 403（`member_deactivated`） |
| 5 | 存在する | セッション | 有効 | SSO が `required` で、対象のロールに当たり、セッションがこのワークスペースの SSO で認証していない | 403（`sso_required`）。クライアントは SSO へ誘導する |
| 6 | 存在する | セッション | 有効 | MFA が必須で、セッションが MFA を満たさない | 403（`mfa_required`） |
| 7 | 存在する | セッション | 有効 | ワークスペースの最大有効期間を超えている | 401（`reauth_required`） |
| 8 | 存在する | - | 有効 | なし | 通す。`SET LOCAL app.workspace_id` と `app.member_id` を設定する |

- 8 行目のあと、ハンドラーは `members` を RLS の下で読み直さない。ミドルウェアが解決した `member` をコンテキストとして渡す。
- 解決の結果は、Cookie キャッシュと同じ 60 秒まで API のプロセス内にキャッシュしてよい。無効化とロールの変更は、この遅れの範囲で反映する。
- ワークスペースの操作ではない経路（`/api/me/*`、`/api/auth/*`）は、1〜2 段を通らない。

### 6.3 ワークスペースの操作（3 段）

「○」は許可、「—」は拒否（403）。ボット・エージェントは `member` の列に従い、さらに 6.5 のスコープで絞る。

| 操作 | owner | admin | member | guest_multi | guest_single |
| --- | --- | --- | --- | --- | --- |
| メンバーの一覧・プロフィールを見る | ○ | ○ | ○ | 同じチャンネルのメンバーだけ | 同じチャンネルのメンバーだけ |
| パブリックチャンネルを作る | ○ | ○ | ○ | — | — |
| プライベートチャンネルを作る | ○ | ○ | ○ | — | — |
| メンバーを招待する | ○ | ○ | ポリシーで許可されていれば | — | — |
| ゲストを招待する | ○ | ○ | — | — | — |
| メンバーを無効化する | ○ | ○（owner 以外） | — | — | — |
| ロールを変える | ○ | ○（owner と admin への変更、owner の変更を除く） | — | — | — |
| 認証ポリシー・SSO・ドメインを変える | ○ | ○ | — | — | — |
| ボット・エージェントのメンバーを作る、トークンを発行する | ○ | ○ | — | — | — |
| 所有権を移す、ワークスペースを削除する | 主たる所有者だけ | — | — | — | — |

- 最後の owner を降格・無効化することはできない（409）。
- ロールの変更と無効化は、変更する側のロールが、変更される側のロールと変更後のロールの両方より上であるときだけ許す（owner > admin > member > guest_multi > guest_single）。

### 6.4 チャンネルの操作（4〜5 段）

表は上から評価し、最初に一致した行を採る。「メンバー」はチャンネルのメンバー（`channel_members` に行がある）を指す。

| # | ロール | チャンネルの種別 | チャンネルのメンバー | 操作 | 結果 |
| --- | --- | --- | --- | --- | --- |
| 1 | - | プライベート / DM / グループ DM | いいえ | - | 404 |
| 2 | guest_multi / guest_single | パブリック | いいえ | - | 404 |
| 3 | owner / admin / member | パブリック | いいえ | 読む（履歴・検索） | 許可 |
| 4 | owner / admin / member | パブリック | いいえ | 参加する | 許可 |
| 5 | - | - | いいえ | 上記以外（投稿・リアクション・編集・削除・メンバーの追加など） | 403（`not_in_channel`） |
| 6 | - | アーカイブ済み | はい | 投稿・リアクション・編集 | 403（`channel_archived`） |
| 7 | - | - | はい | 読む、投稿する、リアクションする | 許可 |
| 8 | - | - | はい | 自分のメッセージを編集・削除する | 許可 |
| 9 | owner / admin | パブリック / プライベート | はい | 他人のメッセージを削除する | 許可 |
| 10 | - | - | はい | 他人のメッセージを編集する | 403 |
| 11 | - | - | はい | 他人のメッセージを削除する | 403 |
| 12 | owner / admin / member | パブリック / プライベート | はい | 他のメンバーを追加する | 許可 |
| 13 | guest_multi / guest_single | - | はい | 他のメンバーを追加する | 403 |

- owner と admin でも、自分が入っていないプライベートチャンネルと DM は読めない（1 行目）。管理者の特権での閲覧（コンプライアンスのエクスポート）は、MVP の範囲外とし、別の経路と監査ログで設計する。
- `guest_single` は、参加できるチャンネルが 1 つだけである。この上限は、チャンネルへの追加の操作（12 行目）で、追加される側について検査する（409 `guest_channel_limit`）。
- この表は、API・WebSocket の購読・検索・通知のすべての経路で同じ関数から使う（ADR-0005）。

### 6.5 ボット・エージェントのトークンのスコープ（5 段）

ボット・エージェントは人間と同じ表（6.3、6.4）で判定し、そのうえで、トークンのスコープを上限として重ねる。スコープは権限を広げない。

| スコープ | 許す操作 |
| --- | --- |
| `channels:read` | チャンネルの一覧と情報 |
| `messages:read` | 履歴と差分取得 |
| `channels:join` | パブリックチャンネルに参加する |
| `messages:write` | 投稿・自分の投稿の編集と削除 |
| `reactions:write` | リアクション |
| `members:read` | メンバーの一覧とプロフィール |
| `files:read` / `files:write` | ファイルの取得 / アップロード |
| `search:read` | 検索 |
| `realtime:connect` | WebSocket のチケットの発行（内部のボット用。アプリには出さない） |

| # | 6.3・6.4 の結果 | 操作に必要なスコープをトークンが持つ | 結果 |
| --- | --- | --- | --- |
| 1 | 拒否 | - | 6.3・6.4 の結果（404 / 403） |
| 2 | 許可 | いいえ | 403（`missing_scope`） |
| 3 | 許可 | はい | 許可 |

## 7. WebSocket の認証

Gateway は DB に触れない（[realtime.md](realtime.md)）。そこで、API が発行する短命のチケットで接続を認証する。

1. クライアントが `POST /api/workspaces/{ws}/realtime/tickets` を呼ぶ。6 節の 0〜2 段を通る（ボットは `realtime:connect` が必要）。
2. API は 32 バイトのランダムな値をチケットとして返す。Valkey に `ticket:{sha256(ticket)}` をキーとし、`{account_id, session_id, workspace_id, member_id, 発行時刻}` を値として、TTL 30 秒で置く。
3. クライアントは `wss://app.example.com/ws` に接続し、最初のメッセージでチケットを送る。URL のクエリにチケットを載せない（アクセスログに残さないため）。
4. Gateway は Valkey から `GETDEL` で取り出す（1 回限り）。取り出せなければ、接続を閉じる（close code 4401）。最初のメッセージが 5 秒以内に来なければ、閉じる。
5. Gateway は接続に `workspace_id`・`member_id`・`session_id` を結び付ける。チャンネルの購読は、この `member_id` で 6.4 の判定を通したものに限る（判定の方法は realtime.md で決める）。

- **接続は 1 ワークスペースにつき 1 本** にする。S3 でワークスペースごとにセルが分かれても、接続の張り先が決まる。
- Gateway の `Origin` ヘッダーを、許可したオリジンと比べる（Cross-Site WebSocket Hijacking を防ぐ）。
- **取り消しの反映**：セッションの取り消し・ログアウト・メンバーの無効化・ロールの変更・チャンネルからの削除は、Valkey の `acct:{account_id}` または `ws:{workspace_id}:member:{member_id}` にイベントを publish し、Gateway が接続を閉じるか購読を外す。publish は失われうる（ADR-0003）ので、Gateway は接続ごとに 15 分おきに API の検査用エンドポイントでセッションとメンバーを再検証し、無効なら閉じる。
- Valkey が失われると、発行済みのチケットが使えなくなる。クライアントはチケットを取り直して再接続する。

## 8. 招待とドメインでの参加

### 8.1 メールでの招待（S1）

- owner・admin（とポリシーで許可された member）が、メールアドレス・ロール・参加させるチャンネルを指定して招待する。メールは SES で送る。
- 招待のトークンは 32 バイトのランダムな値で、`invitations` にはハッシュだけを置く。有効期限は 7 日、1 回だけ使える。
- 受諾の前には、テナントのコンテキストがない。そのため受諾は `SECURITY DEFINER` 関数 `auth_accept_invitation(token_hash, account_id)` で行い、関数の中で 1 つのトランザクションとして検査・メンバーの作成・チャンネルへの追加を行う。

| # | トークン | 状態 | ログイン中のアカウントのメール（確認済み） | そのアカウントのメンバー | 結果 |
| --- | --- | --- | --- | --- | --- |
| 1 | 見つからない | - | - | - | 404 |
| 2 | 見つかる | 取り消し済み、受諾済み、期限切れ | - | - | 410（`invitation_expired`） |
| 3 | 見つかる | 有効 | 招待先と違う | - | 403（`invitation_email_mismatch`）。招待先のメールでログインし直すよう案内する |
| 4 | 見つかる | 有効 | 招待先と同じ | 既にある（有効） | 受諾済みにする。既存のメンバーのまま、ワークスペースへ移る |
| 5 | 見つかる | 有効 | 招待先と同じ | 既にある（無効化済み） | 403（`member_deactivated`）。再有効化は管理者が行う |
| 6 | 見つかる | 有効 | 招待先と同じ | ない、かつメンバー数が上限（5,000） | 409（`workspace_full`） |
| 7 | 見つかる | 有効 | 招待先と同じ | ない | メンバーを作り、招待のロールとチャンネルを付ける |

- ログインしていない人が招待のリンクを開いたら、招待先のメールアドレスを入力済みにした OTP のログインへ送る。
- ワークスペースが SSO を `required` にしていて、招待されたロールが対象なら、受諾の前に SSO で認証させる。

### 8.2 招待リンク（S2）

- 招待先を決めない共有リンク。期限（最大 30 日）と使用回数の上限を持つ。発行・取り消しは owner・admin だけ。
- 受諾の規則は 8.1 から 3 行目を除いたものになる。

### 8.3 ドメインでの参加（S1 後半）

- 管理者が「このドメインのメールアドレスなら、招待なしで参加してよい」と設定できる。対象のドメインは `workspace_domains` で確認済みのものに限る。
- ログイン後のワークスペースの一覧に、「参加できるワークスペース」として出す。参加すると `member` ロールのメンバーになる。

| # | アカウントのメールは確認済み | メールのドメインを、ワークスペースが参加用に確認済み | ワークスペースの設定 | 結果 |
| --- | --- | --- | --- | --- |
| 1 | いいえ | - | - | 候補に出さない |
| 2 | はい | いいえ | - | 候補に出さない |
| 3 | はい | はい | ドメインでの参加が無効 | 候補に出さない |
| 4 | はい | はい | 有効、かつメンバー数が上限 | 候補に出すが、参加は 409（`workspace_full`） |
| 5 | はい | はい | 有効 | 参加できる |

- 候補の検索は、ドメインから `workspace_id` を引く、テナントの外の索引（`workspace_domains` の確認済みの行を、`SECURITY DEFINER` 関数で引く）で行う。

## 9. ボット・エージェントの API トークン

> E12 でアプリのプラットフォームを入れたら、ボットのトークンはアプリのインストールに属するものに一本化する（`api_tokens.installation_id`）。管理者が手でボットを作る経路は、単一ワークスペースのアプリに置き換える（[apps.md](apps.md)、ADR-0031）。それまでは、この節の方式で内部のボットを扱う。

- ボット・エージェントは `account_id IS NULL` のメンバーで、ログインしない。API トークンだけで認証する（ADR-0010）。
- トークンの形式は `slk_{kind}_{token_id}_{secret}`（`kind` は `bot` / `scim`、`token_id` は UUIDv7、`secret` は 32 バイトのランダムな値を base62 にしたもの）。接頭辞を付けるのは、GitHub などのシークレットスキャンで漏洩を検知できるようにするため。
- `api_tokens` にはシークレットの SHA-256 だけを置く。発行時に 1 回だけ表示する。
- 検証は `token_id` から `SECURITY DEFINER` 関数 `auth_resolve_api_token(token_id)` で行を引き、ハッシュを定数時間で比べる。関数は `workspace_id`・`member_id`・スコープ・期限・取り消しの状態だけを返す。
- 期限は既定で無期限、管理者が設定できる。最終使用日時を記録する（書き込みは 1 分に 1 回までにまとめる）。
- Better Auth の API キーのプラグインは使わない。API キーをユーザー（アカウント）に結び付ける設計で、アカウントを持たないメンバーに合わないため。
- トークンでの要求には Cookie を使わない。CSRF の対象外になる（10 節）。
- 人間の代わりに動くエージェント（人間の権限を借りる OAuth の委任）は、この節のトークンでは扱わない。委任は、MCP（[mcp.md](mcp.md)、E9）と公開 API のユーザーのトークン（[public-api.md](public-api.md)、E12）で扱う（15 節の決定）。

## 10. CSRF とオリジン

- Cookie で認証する状態変更の要求（`POST`・`PUT`・`PATCH`・`DELETE`）は、次の 3 つで守る。
  1. Cookie の `SameSite=Lax`
  2. `Origin` ヘッダーを、許可したオリジンの一覧と比べる。`/api/auth/*` は Better Auth のオリジン検査（`trustedOrigins`）、それ以外は Hono の `csrf()` ミドルウェアで行う
  3. 本文を持つ要求は `Content-Type: application/json` だけを受ける（単純なフォームの送信で届かないようにする）
- `GET` で状態を変えない。
- `Authorization: Bearer` の要求は、ブラウザが自動で付ける資格情報を使わないので、オリジンの検査をしない。
- OAuth と OIDC のフローでは、`state` と PKCE を使う。SAML では `InResponseTo` を検査し、IdP 起点のログインは受け付けない（`allowIdpInitiated: false`）。AuthnRequest の記録は Better Auth の検証の値（verification）として、`secondaryStorage` があればそこ、なければ DB の検証のテーブルに置かれるので、複数の API タスクの間で共有される（[`@better-auth/sso` の `types.ts`](https://github.com/better-auth/better-auth/blob/main/packages/sso/src/types.ts) の `enableInResponseToValidation` の説明、[`response-validation.ts`](https://github.com/better-auth/better-auth/blob/main/packages/sso/src/saml/response-validation.ts)、2026-09-26 に確認）。Valkey に置く場合、Valkey を失うとログインの途中の SAML の応答が拒否されるが、やり直せばよい。

## 11. レート制限とロックアウト

| 対象 | 上限 | 超えたとき |
| --- | --- | --- |
| OTP の送信 | 1 メールアドレスあたり 1 時間に 5 回、1 IP あたり 1 時間に 20 回 | 429。応答の文面は成功時と同じにする |
| OTP の検証 | 1 つのコードにつき 5 回 | コードを無効にする |
| 2 つ目の要素（TOTP・バックアップコード）の検証 | 1 つのログインの途中につき 5 回 | そのログインをやり直させる。15 分以内に 3 回やり直したら、その IP とアカウントの組を 15 分止める |
| ログインの開始（全手段） | 1 IP あたり 1 分に 30 回 | 429 |
| WebSocket のチケットの発行 | 1 セッションあたり 1 分に 10 回 | 429 |
| API トークンの検証の失敗 | 1 IP あたり 1 分に 20 回 | 429 |

- **アカウント単位のロックアウトはしない。** 攻撃者が他人をロックアウトできてしまうため。止めるのは IP とアカウントの組にする。
- Better Auth のレート制限は、`storage: "secondary-storage"` で Valkey に置く。Valkey が失われると計数がリセットされるが、外側の AWS WAF のレートベースのルールで最低限を保つ。
- ログインの失敗・ロックの発生は、監査ログとメトリクスに出す（runbooks でアラートを定める）。

## 12. アカウントの削除とメンバーの無効化

| 操作 | 誰が | 対象 | 何が起きる |
| --- | --- | --- | --- |
| メンバーの無効化 | owner・admin、SCIM | 1 つのワークスペースのメンバー | `members.deactivated_at` を設定する。そのワークスペースの API は 403、WebSocket は閉じる、そのメンバーの API トークンは取り消す。メッセージとメンバーの行は残る。他のワークスペースとセッションには影響しない |
| ワークスペースからの退出 | 本人 | 自分のメンバー | 無効化と同じ。主たる所有者は、所有権を移すまで退出できない |
| アカウントの削除 | 本人（直近 10 分以内の再認証と、メールの OTP での確認のあと） | アカウント | 下記 |

アカウントの削除の手順：

1. 本人が主たる所有者であるワークスペースに、他の有効なメンバーがいれば、拒否する（409 `transfer_ownership_first`）。
2. `accounts.deleted_at` を設定し、全セッションを取り消す。以後そのメールアドレスでログインすると、新しいアカウントになる。
3. ワークスペースごとに、メンバーの無効化と匿名化のジョブを SQS に積む。Worker はジョブの `workspace_id` でテナントのコンテキストを設定してから、`members` を無効化し、表示名・本名・アイコンを消して「削除されたユーザー」にし、`account_id` を NULL にする（[ADR-0019](../decisions/0019-data-retention-and-deletion.md) のアカウントの削除）。
4. すべてのジョブが終わったら、`auth_identities`・`passkeys`・`two_factors`・`sessions` と `accounts` の行を消す。

- Better Auth の `deleteUser` は、ワークスペースごとのジョブを待たずにユーザーの行を消すため、使わない。上の手順を本システムの API として実装する。
- `account_id IS NULL` は「ボット・エージェント」の印でもある（ADR-0010）。削除されたユーザーと区別するため、`members` に種別の列 `kind`（`human` / `bot` / `agent`）を加える（[apps.md](apps.md) で確定）。
- メッセージとファイルはワークスペースのデータとして残る（ADR-0019）。

## 13. 規模の段階ごとの変化

| 項目 | S1 | S2 | S3（セル） |
| --- | --- | --- | --- |
| 認証の実行 | API のサービスに同居 | 認証の経路を別の ECS サービスに分ける（同じコード）。ログインの集中が投稿 API の遅延に響かないようにする | グローバルな「アイデンティティ面」として、セルの外に置く |
| アカウント・セッションの置き場所 | 共有の Aurora | 同じ | アイデンティティ面の専用の Aurora（全セル共通）。大阪へのレプリカを持つ |
| セルでのセッションの検証 | DB のセッションを直接見る | 同じ | アイデンティティ面が発行する短命（5 分）の署名付きトークン（`account_id`・`session_id`・`auth_context`）をセルが検証する。署名鍵は KMS。取り消しはトークンの短さと、取り消しイベントで反映する |
| ワークスペースの一覧 | `SECURITY DEFINER` 関数 | 同じ | アイデンティティ面の索引（`account_id` → `workspace_id`・`cell_id`）。セルの outbox から更新する。一覧の表示だけに使い、認可の正本はセルの `members` のまま |
| 振り分け | - | - | CloudFront の後ろのルーターが、パスの `workspace_id` からセルを決める。オリジンは 1 つのままなので、Cookie と CSRF の設計は変わらない |
| SSO | OIDC、SAML | SAML の Single Logout | 同じ。SSO の接続とドメインはアイデンティティ面に置く |
| SCIM | なし | Users、後半で Groups | 同じ。SCIM の要求はセルに振り分ける |
| 招待 | メール | ＋招待リンク | 同じ |
| レート制限 | Valkey 1 シャード | Valkey クラスター | アイデンティティ面とセルでそれぞれ持つ |

- S1 の認証ミドルウェアは、「主体の解決（0 段）」と「メンバーの解決（1〜2 段）」を別の関数に分けておく。S3 では 0 段を「署名付きトークンの検証」に差し替え、1〜2 段はそのまま使う。

## 14. 監査と観測

- 次の事象を監査ログに残す：ログインの成功・失敗、MFA の登録・削除、パスキーの登録・削除、セッションの取り消し、ロールの変更、メンバーの無効化、SSO とポリシーの変更、ドメインの確認、API トークンの発行・取り消し、アカウントの削除。形式と保存先は [ADR-0018](../decisions/0018-audit-log.md) に従う。
- メトリクス：ログインの成功率（手段ごと）、OTP の送信数と到達率、`sso_required`・`mfa_required` の発生数、チケットの発行数と失敗率、レート制限の発動数。

## 15. 未解決の問い

- SSO でログインしたセッションを「MFA 済み」とみなしてよいか。IdP の `amr`・`acr` を検査するか。
- 人間の代わりに動く AI エージェント（人間の権限を借りる委任）を、いつ、どう扱うか。今はエージェントを独立したメンバーとしてだけ扱う。
- 管理者によるプライベートチャンネル・DM の閲覧（コンプライアンスのエクスポート）を、いつ扱うか。
- メールの OTP が届かない（迷惑メール、企業のフィルタ）ときの代替手段。

### 決定（2026-09-26、既定案）

- **SSO のセッションは MFA 済みとみなし、`amr`・`acr` を検査しない。** 本家も、SSO を使うワークスペースでは 2 要素認証を IdP の側で設定させ、SSO のアカウントを結び付けたメンバーの Slack 側の 2 要素認証を外す（[Mandatory workspace two-factor authentication](https://slack.com/help/articles/212221668-Mandatory-workspace-two-factor-authentication)、[Set up two-factor authentication](https://slack.com/help/articles/204509068-Set-up-two-factor-authentication)、2026-09-26 に確認）。MFA は IdP の責任とする。ただし、SSO を回避して入れる owner・admin（SSO の強制が `optional` のとき、または緊急用）には、本システムの MFA を求める。
- **人間の権限を借りる委任は、新しい仕組みを作らず、既存の 2 つで扱う。** MCP（E9）はメンバーが同意した AI エージェントの代理、公開 API のユーザーのトークン（E12）はメンバーが同意したアプリの代理である。どちらも OAuth の同意（アカウント、クライアント、ワークスペース）を単位とし、メンバーの権限を超えない。9 節のボット・エージェントのメンバーは、独立した主体のままにする。
- **管理者による、プライベートチャンネル・DM の画面での閲覧は作らない。** 本家も、管理者に画面で読ませる機能は持たず、エクスポート（Business+ 以上）と、Enterprise 向けの API（Discovery API）で扱う。本システムでは、E8 の `workspace-export` の全データのエクスポート（[security.md](security.md) の 15 節）で扱う。持ち越し：Discovery API に相当する API は、E8 の後に企業顧客の要求が出たら、別の Epic として intent から起票する。
- **メールの OTP が届かないときの代替は、パスキー、Google・Microsoft のログイン、ワークスペースの SSO にする。** 本家もコードが届かないときに、パスキー・SSO・（設定済みなら）パスワードを案内し、IT 部門に送信元ドメインの許可を求めるよう案内する（[Sign in to Slack](https://slack.com/help/articles/212681477-Sign-in-to-Slack)、2026-09-26 に確認）。パスワードは 2.1 節のとおり導入しない。ログイン画面とヘルプに、送信元のドメインの許可を IT 部門に依頼する案内を置く。いずれも使えない場合は、`mfa-recovery.md` と同じ本人確認の手順でサポートが対応する。

## プロフィールとステータス

E2 の `member-profile-and-status` で作る。E1 では、投稿者を ID の先頭で表示している。

- プロフィールは `members` に持つ：表示名、本名、アイコン（[files.md](files.md) の経路でアップロード）、役職、タイムゾーン、言語。メールアドレスは `accounts` にあり、ワークスペースの設定で許可されたときだけ、同じワークスペースのメンバーに見せる。
- ステータスは `member_statuses (workspace_id, member_id, emoji, text, expires_at)`。期限が来たら消す（読み取り時に期限を見て、無いものとして扱う）。
- プロフィールとステータスの変更は、ワークスペースのメンバーに、在席と同じく必要な分だけ配る（[realtime.md](realtime.md)）。
- 表示名の一意性は求めない（本家 Slack と同じ）。メンションは `member_id` で保存するので、表示名の変更で壊れない。

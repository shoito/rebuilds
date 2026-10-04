# Identity and permissions: GitHub

だれか（アカウントと認証）と、何をしてよいか（権限の判定）の設計。権限の判定を 1 つの関数に集めることは [ADR-0002](../decisions/0002-repository-permission-model.md)、ロールの合成は [ADR-0018](../decisions/0018-repository-roles-and-permission-composition.md)、認証とトークンは [ADR-0019](../decisions/0019-authentication-and-token-model.md)、GitHub App は [ADR-0020](../decisions/0020-github-app-model.md) に従う。API とトークンの使われ方は [api-and-webhooks.md](api-and-webhooks.md) にある。

方針は「本家 GitHub に寄せる」。本家の振る舞いは docs.github.com で確かめ、確かめた日付を書く。確かめられなかったものは **未検証** と書く。本家から外すところは「本家との違い」として理由を書く。

この文書の決定表は設計の草案である。ID（`DT-...`・`PROP-...`）は、E2 の各変更の `spec.md` に移すときに振る。

## 1. 全体像

```
Browser ──▶ /session/* Better Auth（パスワード・パスキー・2FA・セッション）──┐
                                                                         │ user_id
Git(HTTPS) ─ Basic（ユーザー名＋トークン）─┐                               │
Git(SSH) ─── 公開鍵 ─────────────────────┤                               │
REST・GraphQL ─ Bearer トークン ─────────┴─▶ 主体の解決（actor）◀─────────┘
                                              │
                                              ▼
                                  can(actor, action, resource)  ← packages/authz（1 か所）
                                              │ allow / not_found / forbidden
               Web・REST・GraphQL・Git フロントエンド・検索・通知・Webhook・Actions
```

- **認証は「主体（actor）」を作るだけにする。** 主体はロールを持たない。何ができるかは、毎回 `can()` が DB の関係（持ち主、コラボレーター、チーム、Organization）と、資格情報の上限（スコープ・権限）から決める。
- **`can()` の実装は TypeScript の 1 つだけにする。** Go の Git フロントエンド（[ADR-0004](../decisions/0004-stateless-git-frontend.md)）は、内部の RPC（`authz.Check`）で呼ぶ。Go に判定を書き写さない。判定の食い違いは、漏洩の原因になるため。

## 2. アカウント

### 2.1 種類

| 種類 | S1 | 内容 |
| --- | --- | --- |
| ユーザー | ○ | 人間。ログインを持つ。個人のリポジトリを持てる |
| Organization | ○ | 共有のアカウント。ログインできない。メンバー・チーム・リポジトリを持つ |
| Bot（App の bot） | ○ | App ごとに 1 つ。`<app-slug>[bot]` の名前で、コメントやコミットの作者として表示される。ログインできない |
| Enterprise | E10（S2） | 複数の Organization を束ねる。`internal` のリポジトリ、SAML SSO の一括の強制、SCIM の土台 |

- ユーザーと Organization は **同じ名前空間** を共有する（`/{owner}/{repo}` の `owner` がどちらでもよいため）。名前は大文字小文字を区別せずに一意にする。
- 名前の変更は許す。変更前の名前からのリポジトリの URL は、転送（リダイレクト）で当面つなぐ。転送に期限はなく、旧い名前を他のアカウントが取って同じ名前のリポジトリを作ったら止まる（本家と同じ。[Username changes](https://docs.github.com/en/account-and-profile/concepts/username-changes)、2026-09-26 に確認）。細部は 14 節の決定。
- メールアドレスは、ユーザーに複数を持たせ、確認済みのものだけをコミットの作者の照合に使う。主のメールアドレスは Better Auth の `user.email`、それ以外は自前の `user_emails` に置く。
- 「コミット用の非公開のメールアドレス」（`<id>+<login>@users.noreply.<domain>`）を持たせる（本家と同じ考え方）。

### 2.2 Organization の中のロール

| ロール | S1 | できること |
| --- | --- | --- |
| owner | ○ | Organization のすべて。全リポジトリに admin |
| member | ○ | 基本の権限（4 節）と、チームを通じた権限 |
| 外部のコラボレーター（outside collaborator） | ○ | メンバーではない。リポジトリごとに直接付けたロールだけを持つ。基本の権限は効かない |
| billing manager、security manager、moderator | E10 以降 | 本家にある補助のロール。MVP では持たない |

- Organization には owner を 1 人以上置く。最後の owner は抜けられない。
- メンバーの追加は招待で行う（受諾で成立）。招待の送信は owner だけ（本家の既定）。外部のコラボレーターの招待は、既定でリポジトリの admin ができ、Organization の設定で owner だけに絞れる。

## 3. 認証

### 3.1 Web のログイン（Better Auth）

Slack の [ADR-0012](../../../slack/docs/decisions/0012-self-hosted-auth-with-better-auth.md) と同じく、Better Auth を自前でホストする。使い方の規則（Better Auth は「だれか」だけを持つ、`organization` プラグインは使わない、公開するエンドポイントを絞る、バージョンを固定する）も同じにする（[ADR-0019](../decisions/0019-authentication-and-token-model.md)）。

| 手段 | S1 | 備考 |
| --- | --- | --- |
| パスワード | ○ | 本家に寄せる（本家はパスワードでログインできる）。漏洩済みのパスワードは拒否する（k-匿名の照合）。Slack はパスワードを持たないので、ここは Slack と違う |
| パスキー | ○ | パスキーだけでログインでき、そのときは 2FA を満たしたとみなす |
| 2FA：TOTP | ○ | Better Auth の `twoFactor` |
| 2FA：セキュリティキー（WebAuthn） | ○ | パスキーと同じ仕組み |
| 2FA：リカバリーコード | ○ | 16 個、1 回限り（本家は 1 回限りのコードのファイルとだけ書き、個数を公開していない。**未検証**。本システムの値とする） |
| 2FA：SMS | × | 本家は提供するが、SIM スワップに弱く、費用もかかる（本家も「security risks」と書いている）。**本家との違い** |
| ソーシャルログイン | × | MVP では持たない |

- **2FA の必須化は、本家の条件に寄せる。** 本家は、コードを貢献する利用者のうち、次に当たる人に 2FA を求め、45 日の登録期間と 7 日の猶予の後にロックする（[About mandatory 2FA](https://docs.github.com/en/authentication/securing-your-account-with-two-factor-authentication-2fa/about-mandatory-two-factor-authentication)、2026-09-26 に確認）。
  - App や Action を公開する、リリースを作る、Organization の owner、パッケージを公開したリポジトリの admin など
  - 本システムでは次のどれかに当たったら求める：Organization の owner、リポジトリの admin、App・OAuth アプリの持ち主、リリースの作成者。期間は本家と同じ 45 日＋7 日。
  - Organization は「メンバーに 2FA を必須にする」を設定できる。本家と同じく、設定すると、2FA のない外部のコラボレーター（bot の外部のコラボレーターを含む）は Organization のリポジトリから外れ、非公開のリポジトリの fork も失う（3 か月以内なら復帰できる）。2FA のないメンバーと支払いの管理者は外さず、席も保つが、2FA を有効にするまで Organization の資源に入れない。後から 2FA を無効にした外部のコラボレーターは自動で外す（[Requiring two-factor authentication in your organization](https://docs.github.com/en/organizations/keeping-your-organization-secure/managing-two-factor-authentication-for-your-organization/requiring-two-factor-authentication-in-your-organization)、2026-09-26 に確認。以前の案の「メンバーも外す」を改めた）。
- **重要な操作は再認証を求める（sudo モード）。** 対象はトークンの作成、SSH の鍵の追加、2FA の変更、メールアドレスの変更、リポジトリの削除・移管・公開の種類の変更、Organization の削除。Better Auth の `freshAge` で実現する。有効時間は本家と同じ 2 時間で、重要な操作のたびに延びる（[Sudo mode](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/sudo-mode)、2026-09-26 に確認）。本家の対象（一覧は例示）には、Webhook の作成・編集・再配信、Organization の招待・メンバー・2FA の強制、ruleset、リカバリーコードの表示も含まれるので、本システムの対象にも加える。
- セッションの Cookie、有効期間、端末の一覧と取り消しは、Slack の identity-and-access.md の 3 節と同じ方式にする（正本は Aurora、`__Secure-` の Cookie、`SameSite=Lax`、アイドル 14 日・絶対 90 日）。
- 2FA の要素をすべて失ったときの回復は、サポートの本人確認とする（runbook）。自動の回復経路は作らない。

### 3.2 Git の認証

| 経路 | 資格情報 | 備考 |
| --- | --- | --- |
| HTTPS | Basic 認証のパスワード欄にトークン（PAT、OAuth、App のトークン、Actions のジョブのトークン） | **アカウントのパスワードは受け付けない**（本家と同じ）。ユーザー名の欄は照合しない（トークンから主体が決まる） |
| SSH | 認証用の公開鍵、またはデプロイキー | `git@<host>` の 1 つのユーザー名で受け、鍵の指紋から主体を引く |
| 匿名 | なし | 公開リポジトリの読み取り（HTTPS と、SSH は鍵があれば） |

### 3.3 SSH の鍵と署名の鍵

| 種類 | 持ち主 | 用途 | 規則 |
| --- | --- | --- | --- |
| 認証の鍵 | ユーザー | Git over SSH | 指紋（SHA-256）は、全体で 1 つの持ち主にだけ登録できる（認証の鍵とデプロイキーをまたいで一意） |
| デプロイキー | リポジトリ | そのリポジトリだけの Git over SSH | 読み取り専用か、読み書き。admin が登録する |
| 署名の鍵（SSH） | ユーザー | コミット・タグの署名の検証 | 認証の鍵と同じ公開鍵を、署名用に別に登録してよい（本家と同じ） |
| GPG の鍵 | ユーザー | 同上 | S1 の後半。S/MIME は持たない |

- 受け付ける鍵の種類：Ed25519、ECDSA（NIST P-256/384/521）、RSA（3072 ビット以上）、FIDO の `sk-` 鍵。DSA は拒否する。
- 署名の検証は、本家と同じく **検証の記録を、検証した時点で固定して残す**（後で鍵を消しても「検証済み」の表示が変わらない。[About commit signature verification](https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification)、2026-09-26 に確認）。記録は `commit_verifications`（リポジトリのネットワーク × コミット）に置く。
- 検証の結果は「Verified / Partially verified / Unverified」の 3 つ。vigilant mode（署名のないコミットを Unverified と表示する利用者の設定）は E4 で扱う。

### 3.4 トークン

トークンの種類・形式・保存の方式は [ADR-0019](../decisions/0019-authentication-and-token-model.md)、API での使われ方は [api-and-webhooks.md](api-and-webhooks.md) の 5 節にある。ここでは権限の判定に関わることだけを書く。

| 種類 | 主体 | 上限（ceiling） | 期限 |
| --- | --- | --- | --- |
| 細粒度の PAT（既定） | ユーザー | 1 つの持ち主（ユーザーか Organization）× 選んだリポジトリ × 権限ごとの read / write | 必須。最長 366 日 |
| クラシックの PAT | ユーザー | スコープ（`repo`・`public_repo`・`workflow` など）。ユーザーが入れる全リポジトリ | 必須。最長 366 日（本家では無期限も選べる。**本家との違い**） |
| OAuth アプリのトークン | ユーザー（アプリ経由） | スコープ | アプリが取り消すまで |
| App のインストールのトークン | App の bot | インストールの権限 × インストールのリポジトリ | 1 時間 |
| App のユーザーのトークン | ユーザー（App 経由） | ユーザーの権限 ∩ App の権限 ∩ インストールのリポジトリ | 8 時間（リフレッシュ 6 か月） |
| Actions のジョブのトークン | ジョブ（`<brand>-actions[bot]`） | そのリポジトリだけ × ワークフローで宣言した権限。組み込みの App のインストールのトークンとして発行する（[ADR-0025](../decisions/0025-secrets-and-fork-pr-policy.md)） | ジョブの完了まで |
| デプロイキー | リポジトリの鍵 | 1 つのリポジトリの Git の読み取り（か読み書き） | なし |

## 4. リポジトリの権限の元

### 4.1 公開の種類

| 種類 | S1 | だれが読めるか |
| --- | --- | --- |
| `public` | ○ | だれでも（ログインしていない人も） |
| `private` | ○ | 権限を明示的に持つ人だけ |
| `internal` | E10 | 同じ Enterprise のメンバー全員（読み取り）。Enterprise を持つ Organization のリポジトリだけ |

本家の `internal` は Enterprise のメンバーに読み取りを与える（[Setting repository visibility](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility)、2026-09-26 に確認）。`can()` と索引は S1 から `internal` を値として持ち、Enterprise が作れるようになる E10 で有効にする。

### 4.2 リポジトリのロール

本家と同じ 5 つの固定のロールにする（[Repository roles for an organization](https://docs.github.com/en/organizations/managing-user-access-to-your-organizations-repositories/managing-repository-roles/repository-roles-for-an-organization)、2026-09-26 に確認）。カスタムのロールは E10 の後の候補とする。

`read < triage < write < maintain < admin`

### 4.3 実効のロール（合成）

実効のロールは、次の元のうち **最も強いもの** にする（和集合。明示の「拒否」は持たない）。[ADR-0018](../decisions/0018-repository-roles-and-permission-composition.md)。

| # | 元 | 与えるロール | 条件 |
| --- | --- | --- | --- |
| 1 | 個人のリポジトリの持ち主 | admin | |
| 2 | Organization の owner | admin | その Organization のすべてのリポジトリ |
| 3 | 直接のコラボレーター | 付けたロール | メンバーでも外部のコラボレーターでもよい |
| 4 | チーム | チームに付けたロール | 親チームに付いたロールは、子チームに引き継がれる |
| 5 | 基本の権限 | `none` / `read` / `write` / `admin` | Organization の **メンバーだけ**。外部のコラボレーターには効かない。既定は `read` |
| 6 | 公開の種類 `public` | read | だれでも |
| 7 | 公開の種類 `internal` | read | Enterprise のメンバー（E10） |
| 8 | 非公開の fork の上流のチーム | 上流でのチームのロール | 6 節 |

- 基本の権限が外部のコラボレーターに効かないこと、既定が `read` であることは本家のとおり（[Setting base permissions](https://docs.github.com/en/organizations/managing-user-access-to-your-organizations-repositories/managing-repository-roles/setting-base-permissions-for-an-organization)、2026-09-26 に確認）。選べる値（`read`・`write`・`admin`・`none`）は本家の REST API の `default_repository_permission` の値と同じ（[Organizations の REST API](https://docs.github.com/en/rest/orgs/orgs)、2026-09-26 に確認）。
- 子チームが親チームのロールを引き継ぐこと、秘密のチーム（secret）は入れ子にできないことは本家のとおり（[About teams](https://docs.github.com/en/organizations/organizing-members-into-teams/about-teams)、2026-09-26 に確認）。
- 実効のロールの計算は、`team_closure`（祖先と子孫の組）を使った 1 回の SQL で行う。入れ子の深さに上限を置く（初期値 10）。

### 4.4 チーム

| 項目 | 内容 |
| --- | --- |
| 表示 | `visible`（Organization の全メンバーに見える）、`secret`（メンバーと owner にだけ見える。入れ子にできない） |
| チームの中のロール | `maintainer`（メンバーの追加・削除、チームの設定）、`member` |
| 入れ子 | 親は 1 つ。循環を拒否する。親を変えたら `team_closure` を作り直す |
| メンション | `@org/team` で、子チームのメンバーにも届く（通知は [notifications.md](notifications.md)） |
| IdP との同期 | SSO の後（8 節） |

## 5. 判定：`can(actor, action, resource)`

### 5.1 形

```ts
type Decision =
  | { allow: true }
  | { allow: false; as: "not_found" | "forbidden"; reason: DenyReason };

can(actor: Actor, action: Action, resource: Resource): Promise<Decision>
canMany(actor, action, resources[]): Promise<Decision[]>   // 1 人 × 多数の資源。一覧・GraphQL 用
filterActorsCanRead(actors[], action, resource): Promise<ActorId[]>
                                                            // 多数の主体 × 1 つの資源。通知・Webhook の送る直前の確認用
accessPredicate(actor): RepoPredicate                       // 検索・一覧の前段の絞り込み用
```

- `action` は、資源の種類ごとの **権限の名前 × 水準**（`contents:read`、`issues:write`、`administration:write` など）で表す。これは細粒度の PAT と App の権限の名前と同じ語彙にする（[api-and-webhooks.md](api-and-webhooks.md) の 5.3 節）。ロールの表（5.3）も、トークンの上限（5.4）も、この語彙で書く。
- `accessPredicate` は「読めるリポジトリ」を SQL と検索の索引で表せる条件にしたもの：`public OR repo_id ∈ 直接 OR team_id ∈ 所属（祖先を含む） OR (owner_id ∈ 基本の権限が read 以上の Organization) OR owner_id = 自分 OR (internal AND enterprise_id ∈ 所属)`。検索の索引の文書には `visibility`・`repo_id`・`owner_id`・`enterprise_id` を持たせ、前段で絞る（ADR-0002）。チームで入れるリポジトリは、クエリの時にリポジトリの ID の集合に展開する。
- `filterActorsCanRead` は `canMany` の逆向き（1 つのリポジトリ × 多数の主体）の一括の判定である。通知の受け手（数千人。[notifications.md](notifications.md) の 3 節）と、1 つのリポジトリの事象を購読する多数の App のインストール（[api-and-webhooks.md](api-and-webhooks.md) の 9.4 節）を、1 人ずつ `can()` で判定しないために使う。
  - 実装：リポジトリ `R` を読める主体の条件（持ち主、Organization の owner、直接のコラボレーター、`team_closure` で展開したチームのメンバー、基本の権限が read 以上のメンバー、公開なら全員）を 1 回の SQL で作り、渡された主体の集合との積を取る。そのうえで、ブロック（5.2 の段 5）、Organization の方針（段 4）、App のインストールの範囲と権限（5.4 の行 4）を主体ごとに引く。
  - 返すのは「読める主体の ID」だけにし、拒否の理由は返さない（配信の側で理由を使わないため）。1 回に渡せる主体は 10,000 までにし、それを超える受け手は呼び出し側が分割する（notifications.md の 1,000 人ごとの分割に合わせる）。
  - `can()` と同じ規則の表から作り、規則を書き写さない。**任意の主体の集合・リポジトリ・操作で、`filterActorsCanRead(actors, a, R)` ＝ `{ x ∈ actors | can(x, a, R).allow }` になる** ことを性質ベーステストで確かめる（12 節）。
- 判定の関数は、`packages/authz` だけに置き、他のパッケージが権限の表（`repository_collaborators` など）を直接読むことを lint で禁止する。

### 5.2 判定の順序

先の段で拒否したら、後の段は評価しない。

| 段 | 確かめること | 拒否の形 |
| --- | --- | --- |
| 1 | 資格情報が有効（期限、取り消し、形式のチェックサム） | 401 |
| 2 | 資源が存在し、無効にされていない（法的な理由の停止など） | 404 か 451 |
| 3 | 実効のロール（4.3）を求める。**読み取りもできなければ、ここで `not_found`** | 404 |
| 4 | 資格情報に対する Organization の方針（SSO の承認、PAT の方針と承認、2FA の必須） | 403 |
| 5 | ブロック（Organization が利用者をブロック、持ち主が利用者をブロック） | 403 |
| 6 | ロールが操作を許すか（5.3） | 403 |
| 7 | 資格情報の上限（5.4）。**上限の外でも、読めない資源なら `not_found`** | 403 か 404 |
| 8 | リポジトリの状態（archived は書き込みを拒否、ロックされた会話はコメントを拒否） | 403 |

- **読めない資源の存在を漏らさない。** 非公開のリポジトリに読み取りの権限がないときは、403 ではなく 404 を返す（本家と同じ振る舞い）。書き込みを拒否するときに 403 を返してよいのは、読み取りが許される場合だけ。
- ブランチの保護（ruleset）は `can()` の外で、ref の更新の時に評価する（[pull-requests.md](pull-requests.md)）。`can()` は「push してよい人か」まで、ruleset は「この ref の更新を許すか」を決める。
- 段 4 は、Organization の持つリポジトリだけにかかる。公開のリポジトリの読み取りには、段 4 をかけない（本家も、PAT の方針は公開の資源の読み取りを止めない。[Setting a PAT policy](https://docs.github.com/en/organizations/managing-programmatic-access-to-your-organization/setting-a-personal-access-token-policy-for-your-organization)、2026-09-26 に確認）。

### 5.3 決定表：ロール × 操作

最小のロール。本家の表（4.2 の出典、2026-09-26 に確認）に合わせた。`-` は、そのロールの範囲ではできない。

| 操作 | 権限の名前 | read | triage | write | maintain | admin |
| --- | --- | --- | --- | --- | --- | --- |
| コードの閲覧・clone・fetch | `contents:read` | ○ | ○ | ○ | ○ | ○ |
| Issue・PR を開く、コメント | `issues:write`・`pull_requests:write`（作成とコメントに限る） | ○ | ○ | ○ | ○ | ○ |
| fork（非公開のものを含む） | `contents:read` | ○ | ○ | ○ | ○ | ○ |
| ラベルを付ける、Issue・PR を閉じる・開き直す、担当者を付ける | `issues:write`・`pull_requests:write` | - | ○ | ○ | ○ | ○ |
| push、ブランチの作成 | `contents:write` | - | - | ○ | ○ | ○ |
| PR のマージ（ruleset を満たすとき） | `contents:write` | - | - | ○ | ○ | ○ |
| 承認のレビューが必須の数に数えられる | `pull_requests:write` | - | - | ○ | ○ | ○ |
| リリースの作成・編集 | `contents:write` | - | - | ○ | ○ | ○ |
| ワークフローのファイル（`.<brand>/workflows/`）の変更 | `contents:write` ＋ `workflows:write` | - | - | ○ | ○ | ○ |
| トピック、説明、機能（Wiki など）の設定 | `administration:write`（一部） | - | - | - | ○ | ○ |
| Webhook、デプロイキー | `repository_hooks:write`・`administration:write` | - | - | - | - | ○ |
| ruleset・ブランチの保護 | `administration:write` | - | - | - | - | ○ |
| コラボレーター・チームの付与 | `administration:write` | - | - | - | - | ○ |
| 公開の種類の変更、archive、移管、削除、既定のブランチの名前の変更 | `administration:write` | - | - | - | - | ○ |
| Issue の削除 | `issues:write`（admin に限る） | - | - | - | - | ○ |

- 公開のリポジトリでは、ログインしていれば読み取りの権限（6 行目の「だれでも read」）で Issue・PR を開き、コメントできる。ログインしていない主体は、読み取りだけ。
- 会話のロックの最小のロールは write にする（本家の [Locking conversations](https://docs.github.com/en/communities/moderating-comments-and-conversations/locking-conversations) の記述に合わせる。[issues.md](issues.md) の 8 節と同じ。2026-09-26 の決定）。
- `workflows:write` を別に求めるのは、本家と同じく、ワークフローの変更がシークレットへの到達につながるため（クラシックの PAT では `workflow` スコープ）。

### 5.4 決定表：資格情報の上限

実効の許可 ＝ 5.3 でロールが許す操作 ∩ 資格情報の上限。

| # | 資格情報 | 上限 | リポジトリの範囲 | 備考 |
| --- | --- | --- | --- | --- |
| 1 | Web のセッション | なし（ロールのとおり） | すべて | 重要な操作は sudo |
| 2 | 細粒度の PAT | 付けた権限と水準 | 1 つの持ち主の、選んだリポジトリ（か全部）＋ 公開のリポジトリの読み取り | 持ち主が Organization なら、承認が済むまで段 4 で拒否 |
| 3 | クラシックの PAT・OAuth のトークン | スコープを権限に写した集合（`repo` → 非公開を含む全権、`public_repo` → 公開のリポジトリへの書き込み、`workflow`、`admin:repo_hook`、`delete_repo` など） | ユーザーが入れるすべて | Organization は、クラシックの PAT を拒否できる |
| 4 | App のインストールのトークン | インストールの権限（要求があれば、さらに絞った部分集合） | インストールのリポジトリ（要求があれば、最大 500 の部分集合）＋ 公開のリポジトリの読み取り | ロールは使わない。bot の主体として、権限だけで決まる |
| 5 | App のユーザーのトークン | App の権限 | ユーザーの実効のロール ∩ インストールのリポジトリ | 本家の説明どおり、App とユーザーの両方が入れる資源だけ（[Authenticating on behalf of a user](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-with-a-github-app-on-behalf-of-a-user)、2026-09-26 に確認） |
| 6 | Actions のジョブのトークン | ワークフローの `permissions` と、リポジトリ・Organization の既定の上限（新規は `contents:read` だけ）の小さい方 | 実行中のリポジトリだけ | fork からの PR で動くジョブは、読み取りだけ・シークレットなし（[ADR-0025](../decisions/0025-secrets-and-fork-pr-policy.md)、[actions.md](actions.md)） |
| 7 | デプロイキー | `contents:read`（か `contents:write`） | 1 つのリポジトリ | Git の経路だけ。API に使えない |
| 8 | 匿名 | `contents:read` などの読み取り | 公開のリポジトリだけ | |

- 行 4 の App は「ロールを持たない主体」である。Organization の owner が App を入れても、App が owner の権限を得るわけではない。
- 行 2 の細粒度の PAT には、本家と同じ制約がある：1 つの持ち主だけ、自分がメンバーでない公開のリポジトリへの書き込み（fork 先への PR の作成など）はできない（[Managing your personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)、2026-09-26 に確認）。この制約が、クラシックを残す理由である（ADR-0019）。

### 5.5 決定表：代表の組み合わせ

`can()` の表駆動テストの核にする行。`R` は Organization `acme` のリポジトリ。

| # | 主体 | R の公開の種類 | 関係 | 操作 | 結果 |
| --- | --- | --- | --- | --- | --- |
| 1 | 匿名 | public | - | `contents:read` | 許可 |
| 2 | 匿名 | private | - | `contents:read` | 404 |
| 3 | 匿名 | public | - | Issue を開く | 401（ログインを求める） |
| 4 | ログイン済み・無関係 | public | - | Issue を開く | 許可 |
| 5 | ログイン済み・無関係 | public | - | `contents:write` | 403 |
| 6 | ログイン済み・無関係 | private | - | 何でも | 404 |
| 7 | メンバー | private | 基本の権限 `none`、チームなし | `contents:read` | 404 |
| 8 | メンバー | private | 基本の権限 `read` | `contents:write` | 403 |
| 9 | メンバー | private | 基本 `read`、親チームに `write` | `contents:write` | 許可（子チームにも引き継ぐ） |
| 10 | 外部のコラボレーター | private | 直接 `triage`、基本 `write` | `contents:write` | 403（基本の権限は効かない） |
| 11 | owner | private | - | `administration:write` | 許可 |
| 12 | owner | private（archived） | - | `contents:write` | 403 |
| 13 | メンバー | internal | Enterprise のメンバー | `contents:read` | 許可（E10） |
| 14 | 外部のコラボレーター | internal | Enterprise のメンバーでない、直接の権限なし | `contents:read` | 404 |
| 15 | 細粒度の PAT（持ち主 `acme`、リポジトリ R だけ、`contents:read`） | private | 利用者は `admin` | `contents:write` | 403（上限の外、読めるので 403） |
| 16 | 細粒度の PAT（持ち主 `acme`、リポジトリ S だけ） | private | 利用者は R に `admin` | R の `contents:read` | 404（選ばれていない非公開の資源） |
| 17 | 細粒度の PAT（承認待ち） | private | 利用者は `write` | `contents:read` | 403 |
| 18 | クラシックの PAT（`public_repo`） | private | 利用者は `write` | `contents:read` | 404 |
| 19 | インストールのトークン（R を含む、`issues:write`） | private | - | `contents:read` | 403（読めないが、インストールの対象なので存在は漏れない。`metadata:read` は常に付く） |
| 20 | インストールのトークン（R を含まない） | private | - | 何でも | 404 |
| 21 | App のユーザーのトークン | private | 利用者は `read`、App は `contents:write` | `contents:write` | 403 |
| 22 | ログイン済み | public | `acme` がこの利用者をブロック | コメント | 403 |
| 23 | Organization の SSO が必須で、PAT が SSO の未承認 | private | 利用者は `write` | `contents:read` | 403（E10） |

- 行 19：本家の文書は「App は既定では権限を持たない」とし、metadata を読み取り専用の権限として挙げるだけで、自動で与えるとは書いていない（[Choosing permissions for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)、2026-09-26 に確認。**未検証**。E7 の着手前に本家で App を登録して観測する）。本システムでは、インストールの範囲のリポジトリの存在と基本の情報は常に読めることにする。

## 6. fork

| 項目 | 規則 | 出典 |
| --- | --- | --- |
| 公開のリポジトリの fork | 読める人はだれでも。fork は fork した人（か Organization）の持ち物で、権限は独立 | |
| 非公開のリポジトリの fork | 読み取り以上 ＋ Organization の方針で非公開の fork を許すこと。fork は非公開のまま | [About permissions and visibility of forks](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/working-with-forks/about-permissions-and-visibility-of-forks)、2026-09-26 に確認 |
| 非公開の fork の権限 | 上流の **チーム** の権限を引き継ぐ。個人の権限は引き継がない | 同上 |
| 上流への権限を失った | その人の非公開の fork を削除する | 同上 |
| `internal` の fork | 1 段まで。非公開の fork をさらに fork できない | 同上 |
| 上流を private → public | 非公開の fork は、独立した非公開のリポジトリとして切り離す | [Setting repository visibility](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility)、2026-09-26 に確認 |
| 上流を public → private | 公開の fork は公開のまま、切り離して別のネットワークにする | 同上 |
| 「メンテナーによる編集を許可」 | 上流で write 以上の人が、PR の head のブランチ（fork 側）に push できる。**ユーザーが持つ fork だけ**（Organization の fork では不可） | fork の出典と同じ |

- **fork のネットワークの中で、公開と非公開を混ぜない。** 上の 2 つの切り離しの規則で、ネットワークの公開の種類は常に 1 つになる。ネットワークはオブジェクトを共有する（[git-storage.md](git-storage.md)）ので、混ぜると非公開のオブジェクトが公開の側から SHA で引けてしまう。
- **SHA での直接の参照（`/commit/<sha>`、API の `GET /repos/{o}/{r}/commits/{sha}`、Git の `want <sha>`）** は、[ADR-0007](../decisions/0007-fork-network-object-sharing.md) に従う：Git のプロトコル v2 の `fetch` は、広告していない `want` もネットワークの object store にあれば返す（2026-09-26 に確認。[git-storage.md](git-storage.md) の 7.2 節）。**公開のネットワーク**では、Git・Web・API のいずれでも、本家と同じく、同じネットワークの他の fork のコミットが SHA で見えうることを仕様として受け入れ、「このリポジトリのブランチに属さないコミット」と表示する。**非公開のネットワーク**では、ストレージの層で、要求したリポジトリの ref からの到達可能性を既定で検査し、到達できなければ 404（Git は `not our ref`）にする（2026-09-28 の決定。本家との違い）。
  - `can()` の判定は、要求の URL のリポジトリに対して行う。ネットワークの他のリポジトリへの権限は見ない。
  - 残る危険：非公開のネットワークで、上流を読めるが、ある非公開の fork を読めない人（例：上流の外部のコラボレーター。非公開の fork は上流の **チーム** の権限だけを引き継ぐ）が、その fork のコミットを SHA で見うる（Git の v2 の経路を含む）。本家の文書は「ネットワークのどのリポジトリの Git のデータも、同じネットワークのどのリポジトリからも取得されうる」とだけ書き、この場合を個別には述べていない（本家の非公開のネットワークは観測の手段がない）。この危険は、上の到達可能性の検査で防ぐ（14 節の決定）。
- 「メンテナーによる編集」は、`can()` の特別な規則として持つ：`contents:write` on fork の branch B ⇔ B を head とする開いた PR があり、`maintainer_can_modify` が真で、主体が base に write 以上。

## 7. bot と App の主体

| 主体 | 名前の表示 | 監査ログの `actor` | 権限 |
| --- | --- | --- | --- |
| App（インストールのトークン） | `<slug>[bot]` | App の bot ＋ インストールの ID | 5.4 の行 4 |
| App（ユーザーのトークン） | ユーザー ＋ App の印 | ユーザー（`via` に App） | 5.4 の行 5 |
| Actions のジョブ | `<brand>-actions[bot]` に相当する組み込みの bot | ジョブ ＋ ワークフローの実行の ID | 5.4 の行 6 |
| AI エージェント | App の bot か、App 経由のユーザー（推奨）。細粒度の PAT でもよい | 同上 | 同上 |

- bot は Organization の席（seat）を消費しない（本家と同じ。[Differences between GitHub Apps and OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps)、2026-09-26 に確認）。
- 「マシンユーザー」（人間のアカウントを自動化に使うこと）は禁じないが、推奨しない。AI エージェントの主体の選び方は [api-and-webhooks.md](api-and-webhooks.md) の 10 節にある。

## 8. SSO と SCIM（E10）

MVP の後。S1 の段階では、`can()` の段 4 と資格情報の表に置き場所だけを用意する。

- **Organization の SAML SSO**：有効にすると、メンバーは Web で IdP の認証を済ませたセッション（既定 24 時間、IdP が長さを決める）がないと Organization の資源に入れない。**PAT と SSH の鍵は、Organization ごとに SSO の承認が要る**（[About authentication with SSO](https://docs.github.com/en/enterprise-cloud@latest/authentication/authenticating-with-single-sign-on/about-authentication-with-single-sign-on)、2026-09-26 に確認）。承認は `credential_sso_authorizations`（資格情報 × Organization）に置く。
- **Enterprise の SAML SSO**：配下の全 Organization に一括でかける。
- **SCIM**：本家では、Enterprise Managed Users か、Organization の SAML SSO と組み合わせて使う（[About SAML for enterprise IAM](https://docs.github.com/en/enterprise-cloud@latest/admin/managing-iam/understanding-iam-for-enterprises/about-saml-for-enterprise-iam)、2026-09-26 に確認）。本システムは Organization の SCIM から始め、`active=false` と `DELETE` はメンバーシップの解除にする（アカウントは消さない。Slack の identity-and-access.md の 5.4 節と同じ理由で、Better Auth の SCIM プラグインは使わず自前で実装する）。
- Enterprise Managed Users（IdP が持つ閉じたアカウント）は、E10 の後の候補とする。
- IdP のグループとチームの同期は、SCIM の Groups で行う（E10 の後半）。

## 9. キャッシュと取り消し

| 対象 | キャッシュ | 無効化 |
| --- | --- | --- |
| 実効のロール | Valkey、キーは `perm:{user}:{repo}:{epoch}`、TTL 5 分 | `epoch` は、ユーザー・リポジトリ・Organization ごとの世代の番号を連ねたもの。権限の変更（コラボレーター、チーム、基本の権限、所属、公開の種類）で該当の世代を上げると、旧いキーは参照されなくなる |
| トークンの検証 | タスク内のメモリ、TTL 30 秒 | 取り消しは Valkey の pub/sub で各タスクへ知らせる。知らせが失われても 30 秒で効く |
| Web のセッション | Better Auth の Cookie キャッシュ（60 秒） | Slack と同じ |

- **取り消しの反映の上限**：トークンの取り消しは 30 秒、権限の剥奪は世代の更新の直後（Valkey が使えないときは DB を直接読む）。
- Valkey が使えないときは、キャッシュなしで DB を読む（fail-open にしない。判定は必ず行う）。
- 進行中の長い Git の転送（clone）は、開始時の判定で最後まで続ける。push は ref の更新の直前にもう一度判定する。

## 10. 監査

監査ログの書き方・保存・検索は [ADR-0029](../decisions/0029-audit-log.md) と [security.md](security.md) にある。この領域が出す事象：

- 認証：ログイン（成功・失敗）、2FA の登録・削除、パスキーの登録・削除、sudo、セッションの取り消し
- 資格情報：PAT・SSH の鍵・デプロイキー・署名の鍵の作成・削除・使用（最終使用日時の更新は間引く）、SSO の承認
- 権限：コラボレーター・チーム・基本の権限・Organization のロールの変更、公開の種類の変更、移管
- App：インストール、権限の変更の承認、インストールのトークンの発行（件数だけ）
- 各事象に、主体の種類（`programmatic_access_type` に相当：Web、PAT、OAuth、App のインストール、App のユーザー）と、トークンの ID（トークンそのものではない）を持たせる。本家も App のユーザーのトークンを、監査ログで区別して記録する（5.4 の行 5 の出典）。
- 監査ログを読める人：Organization の owner（Organization の事象）、本人（自分のセキュリティのログ）。

## 11. データモデル（列の定義は [data-model/identity.md](data-model/identity.md)）

| テーブル | 中身 |
| --- | --- |
| `users` | Better Auth の `user`。`login`（一意、大文字小文字を区別しない）、2FA が必須になった日時 |
| `user_emails` | 追加のメールアドレス、確認済みか |
| `accounts`・`sessions`・`passkeys`・`two_factors`・`verifications` | Better Auth（`accounts` はパスワードの Argon2id のハッシュ） |
| `owners` | ユーザーと Organization の共通の名前空間（`login` の一意性）。名前の変更の転送は `owner_redirects` |
| `organizations` | 基本の権限、メンバーの権限の方針（リポジトリの作成、非公開の fork、外部のコラボレーターの招待）、2FA の必須 |
| `org_memberships` | ユーザー × Organization、ロール（`owner` / `member`） |
| `org_invitations` | 招待、期限 |
| `teams` | Organization、親、表示（`visible` / `secret`） |
| `team_memberships` | チーム × ユーザー、ロール（`maintainer` / `member`） |
| `team_closure` | 祖先 × 子孫 × 深さ |
| `repositories` | 持ち主、公開の種類、fork の親、ネットワーク、archived、無効化 |
| `repository_collaborators` | リポジトリ × ユーザー、ロール |
| `repository_invitations` | コラボレーターの招待 |
| `team_repository_roles` | チーム × リポジトリ、ロール |
| `user_blocks`・`org_blocks` | ブロック |
| `ssh_keys` | ユーザー、指紋、種類（`auth` / `signing`）、最終使用日時 |
| `ssh_auth_fingerprints` | 認証に使う指紋の登録簿。認証の鍵とデプロイキーをまたいで指紋を一意にする |
| `deploy_keys` | リポジトリ、指紋、読み書きか |
| `gpg_keys` | ユーザー、鍵の ID（S1 の後半） |
| `commit_verifications` | ネットワーク × コミット、結果、鍵、検証日時 |
| `personal_access_tokens` | 種類（`classic` / `fine_grained`）、ハッシュ、接頭辞＋末尾 4 文字（表示用）、スコープか権限、持ち主、期限、最終使用、承認の状態 |
| `pat_repositories` | 細粒度の PAT × リポジトリ |
| `credential_sso_authorizations` | 資格情報 × Organization（E10） |
| `permission_epochs` | ユーザー・リポジトリ・Organization ごとの世代の番号 |

App と OAuth アプリのテーブルは [api-and-webhooks.md](api-and-webhooks.md) の 12 節にある。

## 12. テスト

- **表駆動テスト**：5.3・5.4・5.5 の各行を `can()` のテストにする。6 節の fork の規則も表にする。
- **性質ベーステスト**（ADR-0002 の漏洩の性質を具体にしたもの）：
  - 任意の権限の設定・操作の列の後で、`can(actor, contents:read, R)` が not_found の非公開の R について、Web・REST・GraphQL・Git・検索・通知・Webhook のどの経路からも R の名前・中身・メタデータが返らない。
  - 任意の主体・リポジトリで、`can()` の結果と `accessPredicate` の結果が一致する（一覧・検索の絞り込みと、個別の判定が食い違わない）。
  - 任意の主体の集合・リポジトリ・操作で、`filterActorsCanRead` の結果が、主体ごとの `can()` で許可されるものの集合と一致する（通知・Webhook の一括の判定と、個別の判定が食い違わない）。
  - 任意の資格情報で、許可 ⊆ ロールが許す操作 かつ 許可 ⊆ 資格情報の上限。
  - 読み取りが not_found なら、どの操作も 403 ではなく 404 を返す（存在を漏らさない）。
  - 権限の剥奪の後、世代の更新が済んだ時点から、キャッシュを経ても許可が返らない。
  - 任意の fork・公開の種類の変更の列の後で、1 つのネットワークの公開の種類は 1 つである。
- **結合テスト**：Git の HTTPS でアカウントのパスワードを拒否する。取り消したトークンが 30 秒以内に拒否される。非公開の fork の持ち主が上流の権限を失うと、fork が消える。
- 判定の関数の変更は、Dev と QA のレビューを必須にする（ADR-0002）。

## 13. 段階ごとの変化

| 段階 | 変化 |
| --- | --- |
| S1 | ユーザー・Organization・チーム・5 つのロール・PAT・SSH の鍵・App。`internal` は値だけ |
| S2（E10） | Enterprise、`internal`、SAML SSO、SCIM、IP の許可リスト。実効のロールの計算を、Organization の大きさ（数万人・数万のリポジトリ）に合わせて、事前計算の表（`effective_repo_roles`）に置き換えるかを測って決める |
| S3（E11） | アカウントと資格情報は、リージョンの外のアイデンティティ面に置き、各リージョンへ読み取りの複製を置く。取り消しは全リージョンへ知らせる |

## 14. 未解決の問い

設計の中で出た問いと、その決定。計測・PoC で決めるものは「持ち越し」に置く。

### 決定（2026-09-26、既定案）

PM の方針（本家に寄せる、既定案）で次のとおり決めた。一覧は [README.md](README.md) の 6 節にもある。

- **名前の変更の後の転送**：本家に寄せる。旧い名前は、変更の直後から他のアカウントが取れる。旧い URL の転送は、旧い名前を他のアカウントが取るか、旧い名前の下に同じ名前のリポジトリが作られるまで続ける。人気のある公開のリポジトリの `OWNER/REPOSITORY` の組は、アカウントの削除と同じ条件で永久に予約する（repojacking の対策。[ADR-0030](../decisions/0030-data-retention-and-deletion.md)）。
- **クラシックの PAT の期限の必須**：[ADR-0019](../decisions/0019-authentication-and-token-model.md) のとおり、本家との違い（最長 366 日）を受け入れる。
- **カスタムのリポジトリのロール**：MVP の後（E10 の後）の候補にする。本家でも企業向けの機能である。
- **会話のロックの最小のロール**：write（5.3 節）。
- **Organization の 2FA の必須化で外す対象**（2026-09-26 の本家の確認による改訂）：外部のコラボレーターだけを外し、メンバーと支払いの管理者は外さずに Organization の資源への立ち入りを止める（3.1 節）。
- **sudo モードの対象**（同）：本家の例示に合わせ、Webhook の作成・編集・再配信、Organization の招待・メンバー・2FA の強制、ruleset、リカバリーコードの表示を加える（3.1 節）。

### 決定（2026-09-28、推奨案で確定）

- **非公開のネットワークでの SHA の参照**（6 節）：Git の v2 の `want` と Web・API の SHA の参照に、到達可能性の検査を既定でかける。Go のストレージの層に自前で持つ。検査の費用は E1 の `fork-network-want-poc` で測り、実装は E3 の `fork-network-reachability-check` で行う。本家より厳しく、本家との違いとして記録する（[ADR-0007](../decisions/0007-fork-network-object-sharing.md) の 2026-09-28 の注記、[git-storage.md](git-storage.md) の 7.2 節）。

持ち越し（計測で決めるもの）：

| 項目 | いつ・どう決めるか |
| --- | --- |
| 到達可能性の検査の費用（CPU・遅延、ref の多いリポジトリ） | E1 の `fork-network-want-poc` で測る。重ければ、キャッシュと commit-graph の使い方を直す（検査をやめる選択はしない） |

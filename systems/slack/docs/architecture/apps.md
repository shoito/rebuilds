# Apps: Slack

本家の Slack App に相当する、アプリの基盤。マニフェスト、ワークスペースへのインストール、ボットのメンバー、スコープ、Events API、インタラクティブ機能（スラッシュコマンド、ショートカット、ボタン、モーダル）、宣言的な UI、アプリのホーム、Incoming Webhook、管理者の承認、配布。方針は [ADR-0031](../decisions/0031-app-platform.md)、アプリが呼ぶ API は [public-api.md](public-api.md)（[ADR-0030](../decisions/0030-versioned-public-api.md)）にある。

E12 で、MVP の後に出す。公開のアプリの一覧（ディレクトリ）は範囲外とする。

## 1. 位置づけと用語

| 用語 | 意味 |
| --- | --- |
| アプリ | 開発者が作る連携の単位。マニフェスト（3.1 節）で定義する。**テナントの外**（グローバル）にある |
| 所有するワークスペース | アプリを作ったワークスペース。開発者はそのワークスペースのメンバーとして、アプリを編集する |
| インストール | アプリを 1 つのワークスペースに入れたもの。**テナントの中** にある。トークン・ボット・Webhook はインストールに属する |
| ボットのメンバー | インストールごとに 1 人作る、`account_id IS NULL` のメンバー（[ADR-0010](../decisions/0010-accounts-and-workspace-members.md)） |
| 単一ワークスペースのアプリ | 所有するワークスペースにだけインストールできるアプリ。審査なし |
| 配布型のアプリ | 他のワークスペースにもインストールできるアプリ。審査を受けなくても配布できる。審査は任意（4 節、[ADR-0033](../decisions/0033-slack-aligned-platform-and-plan-decisions.md) の 4） |

- **ボットは特別扱いしない。** 人間と同じ判定関数（[ADR-0005](../decisions/0005-single-authorization-check.md)）、同じ RLS（[ADR-0009](../decisions/0009-pooled-tenancy-with-rls.md)）を通る。ボットが読めるのは、自分が参加しているチャンネルと、`member` ロールで読めるパブリックチャンネルだけ（[identity-and-access.md](identity-and-access.md) の 6.4 節）。そのうえでスコープを上限として重ねる。
- [identity-and-access.md](identity-and-access.md) の 9 節の「ボット・エージェントのメンバー」は、アプリのインストールとして作るものに一本化する。管理者が手でボットを作る経路は、単一ワークスペースのアプリを作る経路に置き換える（同節に反映済み。20 節）。
- MCP（[mcp.md](mcp.md)）は、人間のメンバーの代理であり、アプリではない。スコープの語彙は共有する（6 節）。

## 2. 全体構成

```
開発者 ──▶ 開発者コンソール（Web）── アプリとマニフェストの管理（グローバル）
                                        │
メンバー ─▶ インストールの画面 ─▶ Better Auth（oauth-provider）─ 同意 ─▶ インストールの作成（テナント）
                                        │ 認可コード → アプリのサーバーがトークンを取得
アプリのサーバー ─ Bearer ─▶ public-api（/v1）─▶ ドメイン層 ─▶ Aurora（RLS）
                                                              │ outbox
                                                              ▼
                                                   Relay ─▶ SQS app-events
                                                              ▼
                                            app-event-router（Worker、VPC 内）
                                              │ インストールごとに配送を作る
                                              ▼
                                            app-delivery（Worker、VPC 内。署名する）
                                              │ 同期で呼ぶ
                                              ▼
                                            app-egress（Lambda、VPC の外、権限なし）─▶ アプリの URL
Web クライアント ─ スラッシュコマンド・ボタン ─▶ api ─▶ app-egress-interactive（Lambda）─▶ アプリの URL
```

- 外部の URL へ出す通信は、すべて VPC の外の、権限を持たない Lambda から出す（13 節）。署名は VPC の中の Worker・api が行い、Lambda は秘密を持たない。
- Events API の配送は、通知（[ADR-0014](../decisions/0014-sqs-worker-queues-and-notification-delivery.md)）と同じく、「きっかけ」を SQS で受け、中身を DB から読み直す。

## 3. マニフェストとデータモデル

### 3.1 マニフェスト

アプリの定義を 1 つの JSON（YAML でも書ける）で持つ。開発者コンソールで編集し、公開すると版が 1 つ増える。スキーマは `packages/contract/public/v1` の Zod で定義し、公開 API と同じく OpenAPI（JSON Schema）として公開する。

```yaml
manifest_version: 1
display:
  name: Deploy Bot
  description: デプロイの状態を知らせる
  icon_file_id: 0192...           # 開発者コンソールでアップロードした画像
  background_color: "#1d4ed8"
bot:
  display_name: deploybot
oauth:
  redirect_uris: ["https://deploy.example.com/oauth/callback"]
  scopes:
    bot: [channels:read, messages:write, commands]
    user: []                        # ユーザーのトークンが要るときだけ
events:
  request_url: https://deploy.example.com/events
  bot_events: [app.mention, message.created]
interactivity:
  request_url: https://deploy.example.com/interactions
slash_commands:
  - command: /deploy
    description: デプロイを始める
    usage_hint: "[service] [env]"
shortcuts:
  - type: message               # global / message
    callback_id: create_ticket
    name: チケットを作る
app_home:
  enabled: true
incoming_webhooks:
  enabled: false
distribution: single_workspace  # single_workspace / distributed
privacy_policy_url: https://deploy.example.com/privacy
```

- スラッシュコマンドとショートカットは、`interactivity.request_url` を必須にする。コマンドごとに URL を分けない（検証と署名の対象を 1 つにする）。
- マニフェストの版を上げても、既存のインストールは、インストールしたときの版のスコープのままにする。スコープの追加には、ワークスペースでの再同意が要る（5.3 節）。スコープ以外（名前、URL、コマンド、購読するイベント）は、公開と同時に全インストールに反映する。ただし、購読するイベントは、インストールで許されたスコープで絞る（7.1 節）。
- 配布型のアプリで URL（`redirect_uris`、`request_url`）を変えると、ドメインの確認（14.2 節）をやり直す。

### 3.2 テーブル（テナントの外）

アプリはワークスペースをまたぐので、定義はグローバルに置く。テナントのデータを持たない。

| テーブル | 中身 |
| --- | --- |
| `apps` | ID、所有するワークスペース、配布の種類、審査の状態（`none` / `pending` / `approved` / `rejected` / `blocked`）、公開中のマニフェストの版、作成日時、削除日時 |
| `app_manifest_versions` | アプリ、版、マニフェストの JSON、公開日時 |
| `app_credentials` | アプリ、署名の秘密（KMS の `apps` キーで暗号化。HMAC に使うので復号できる必要がある）、旧い署名の秘密と失効の予定時刻（14.3 節）。`client_secret` は Better Auth の OAuth クライアントに置く |
| `app_collaborators` | アプリ、所有するワークスペースの `member_id`、役割（`owner` / `editor`）。所有するワークスペースの中の ID なので、コンソールの読み取りは `SECURITY DEFINER` 関数で行う |
| `app_verified_domains` | アプリ、ドメイン、DNS TXT の確認日時 |
| `app_endpoint_states` | アプリ、宛先の種類（`events` / `interactivity`）、状態（`enabled` / `disabled`）、無効にした理由と日時（7.5 節） |
| Better Auth の OAuth クライアント | アプリ 1 つにつき 1 つ。`client_id`、`client_secret`、`redirect_uris`、`token_endpoint_auth_method`（`client_secret_basic`） |

- アプリの ID と OAuth の `client_id` は 1 対 1。
- 開発者コンソールでの操作（作成、公開、秘密の入れ替え、削除）は、所有するワークスペースの監査ログ（[ADR-0018](../decisions/0018-audit-log.md)）に残す。

### 3.3 テーブル（テナントの中）

すべて `workspace_id` を持ち、RLS を有効にする（ADR-0009）。[data-model.md](data-model.md) に反映済み。

| テーブル | 中身 |
| --- | --- |
| `app_installations` | ID、`app_id`、インストールしたマニフェストの版、許したボットのスコープ、許したユーザーのスコープ、ボットの `member_id`、インストールしたメンバー、状態（`pending_approval` / `active` / `suspended` / `uninstalled`）、作成・停止・アンインストールの日時。`UNIQUE (workspace_id, app_id)` |
| `api_tokens`（既存を拡張） | `installation_id` を加える。種類 `bot` のトークンはインストールに属する（[identity-and-access.md](identity-and-access.md) の 9 節）。入れ替え中の旧いトークンの失効の予定時刻を持つ |
| `app_user_authorizations` | インストール、`member_id`、許したユーザーのスコープ、日時、取り消しの日時。Better Auth の同意（グローバル）と対応させ、管理者の一覧と取り消しに使う |
| `workspace_app_policies` | インストールの方針（`open` / `approval_required`）、メンバーのインストールを許すか、配布型のアプリを許すか |
| `workspace_app_rules` | アプリごとの許可・拒否と、許可するスコープの上限 |
| `app_approval_requests` | アプリ、依頼したメンバー、求めるスコープ、理由、状態、判断した管理者、日時 |
| `workspace_slash_commands` | コマンド名、インストール。`UNIQUE (workspace_id, command)` |
| `incoming_webhooks` | インストール、チャンネル、秘密のハッシュ、作成したメンバー、取り消しの日時 |
| `app_views` | インストール、メンバー、種類（`modal` / `home`）、UI ブロック、`private_metadata`（最大 3,000 文字）、`hash`（楽観ロック）、親のビュー、期限 |
| `app_event_deliveries` | 配送の ID（`event_id` と同じ）、インストール、イベントの種類、`channel_id`・`seq`・対象の ID、状態（`pending` / `delivered` / `failed` / `skipped` / `dropped`）、試行の回数、次の試行の時刻、最後の応答のステータスと遅延。日ごとのパーティションで 3 日保持 |

- `members` に種類の列 `kind`（`human` / `bot` / `agent`）を加える（[identity-and-access.md](identity-and-access.md) の 15 節の未解決の問いを、この設計で必要とする）。削除されたアカウントのメンバー（`account_id` が NULL になる）とボットを区別するため。
- `messages` に、アプリの UI ブロックを置く列 `ui_blocks JSONB NULL` と、送ったインストールの `installation_id NULL` を加える（10 節）。

## 4. アプリの種類と配布

| 項目 | 単一ワークスペースのアプリ | 配布型のアプリ |
| --- | --- | --- |
| インストールできる先 | 所有するワークスペースだけ | すべてのワークスペース（本家 Slack と同じく、審査は要らない。ADR-0033） |
| 審査 | なし | 任意（14.2 節）。未審査の間は、履歴・スレッドの取得に厳しい上限がかかる |
| URL のドメインの確認 | 不要（HTTPS で公開の名前であればよい） | 必須 |
| インストールの方法 | コンソールの「このワークスペースにインストール」（OAuth のリダイレクトなし。トークンをコンソールに 1 回だけ表示する）、または OAuth | OAuth だけ（インストールのリンクを、開発者が自分のサイトで配る） |
| プライバシーポリシーの URL | 任意 | 必須 |

- 配布型にするのは、単一ワークスペースのアプリからの切り替えだけ。逆には戻せない（インストール済みの他のワークスペースがありうるため）。
- 公開のディレクトリ（検索できるアプリの一覧）は作らない。審査の運用が回ってから、別の Epic で検討する。

## 5. インストール

### 5.1 流れ（OAuth）

認可サーバーは Better Auth の oauth-provider プラグインを使う（[ADR-0012](../decisions/0012-self-hosted-auth-with-better-auth.md)、[ADR-0028](../decisions/0028-remote-mcp-server.md) と同じもの）。

```
1. アプリ → ブラウザ：https://app.<domain>/oauth/v1/authorize?client_id&redirect_uri&scope（ユーザーのスコープ）&state&code_challenge
2. ログイン（SSO を強制するワークスペースなら SSO）
3. postLogin の画面：インストール先のワークスペースを選ぶ（所属するワークスペースのうち、6.4 節で拒否されないもの）
4. 同意の画面：アプリの名前・所有者・確認済みのドメイン・審査の状態、ボットのスコープ（マニフェストから）、
   ユーザーのスコープ、参加するチャンネル（ある場合）を示す
5. 承諾 → api が 1 つのトランザクションで：6.4 節の判定、app_installations の作成（または更新）、
   ボットのメンバーの作成、ボットのトークンの発行、監査ログ
   → 承認が要るなら pending_approval にして止める（管理者の判断の後、メンバーにインストールをやり直してもらう）
6. Better Auth が認可コードを発行（consentReferenceId = workspace_id）→ redirect_uri へ
7. アプリのサーバー → POST https://app.<domain>/oauth/v1/token（client_secret_basic、code、code_verifier）
   → 応答：ユーザーのトークン（ユーザーのスコープがあれば）、ボットのトークン、workspace_id、installation_id、bot_member_id
```

- **ボットのスコープは、マニフェストから決める。** OAuth の `scope` パラメーターには、ユーザーのスコープだけを載せる。ボットのスコープをリクエストの度に変えられると、同意の画面と実際の権限がずれる余地が増えるため。
- **ボットのトークンは本システムが発行する**（`slk_bot_...`、[identity-and-access.md](identity-and-access.md) の 9 節）。Better Auth の発行するトークンはアカウント（人）に結び付くもので、アカウントを持たないボットに合わないため。ボットのトークンの平文は、5 で作って短時間（10 分）だけ暗号化して置き、7 の応答で 1 回だけ渡して消す。
  - 7 の応答に項目を加える方法は、Better Auth の `customTokenResponseFields` を候補にする（トークンの作成の前に呼ばれ、例外を投げれば何も発行されないと文書にある）。このコールバックは非同期でよく（`Awaitable`）、認可コードの交換では同意の `referenceId` を含む検証の値を受け取る（[oauth-provider の文書](https://www.better-auth.com/docs/plugins/oauth-provider)、2026-09-26 に確認）。ただし、ここで一時的な値を読み出して消してよいか（呼ばれた後にトークンの作成が失敗したら、値だけが消える）は、文書に書かれておらず **未検証**。E12 の着手前に PoC で、失敗の経路（コードの二重使用、DB の失敗）での動きを確かめる。消してよいと言えなければ、`/oauth/v1/token` を本システムのハンドラーで包み、Better Auth の応答が成功したときだけ項目を足して値を消す。
- 5 の選択したワークスペースは、セッション ID をキーにした短命の行に置き、`consentReferenceId`（`{ user, session, scopes }` を受け取る非同期の関数。organization プラグインには依らない）で引いて返す（[public-api.md](public-api.md) の 4.1 節、2026-09-26 に確認）。
- **再インストール**（同じワークスペースに既にあるアプリ）は、同じインストールとボットのメンバーを使い続け、ボットのトークンを新しく発行する。旧いトークンは 5.3 節の重なりの期間の後に失効させる。
- ユーザーのスコープだけの追加の認可（既にインストールされたアプリに、別のメンバーが自分のトークンを与える）も同じ流れで、5 ではインストールを作らず `app_user_authorizations` だけを作る。

### 5.2 ボットのメンバーのライフサイクル

| 出来事 | ボットのメンバー | トークン | チャンネル |
| --- | --- | --- | --- |
| インストール | 作る。`kind = 'bot'`、`role = 'member'`（固定。[security.md](security.md) の 7.2 節）、表示名とアイコンはマニフェストから | ボットのトークンを発行 | 参加しない。招待されるか、`channels:join` で自分で参加する（パブリックだけ） |
| マニフェストの公開（表示名などの変更） | プロフィールを更新する | 変わらない | 変わらない |
| スコープの追加（再同意） | 変わらない | 新しいトークンを発行し、旧いものを重なりの期間の後に失効 | 変わらない |
| 管理者による停止 | 変わらない | 403（`app_suspended`）を返す | 変わらない。イベントは配送せず捨てる |
| 再開 | 変わらない | 使えるようになる | 変わらない |
| アンインストール | 無効化する（`deactivated_at`）。行は消さない（過去の投稿者として残す。ADR-0010） | すべて取り消す | すべてのチャンネルから外す（`channel.member_left` を出し、`seq` を消費する） |
| 再インストール | 同じメンバーを有効に戻す | 新しく発行 | 参加し直さない。招待し直す |

- ボットは `owner` / `admin` にできない。ボットに管理の操作をさせる需要が出たら、`admin:*` のスコープとして別に設計する（[public-api.md](public-api.md) の 15 節）。
- ボットのメンバーは、ワークスペースのメンバー数の上限（プランによらない、規模の段階による技術的な上限。[ADR-0033](../decisions/0033-slack-aligned-platform-and-plan-decisions.md) の 1）に数えない。インストール数の上限（`limit.apps.installed`。ADR-0033 の表）で抑える。

### 5.3 トークンの入れ替え

- `POST /v1/auth/token/rotate`（ボットのトークンで呼ぶ）で、新しいボットのトークンを発行する。旧いトークンは 24 時間の後に失効する。開発者コンソールからも実行できる。
- 漏洩が疑われるときは、開発者または管理者が即時に失効させる（重なりなし）。
- トークンの接頭辞（`slk_bot_`）を、GitHub などのシークレットスキャンに登録し、公開のリポジトリで見つかったら自動で失効させることを目指す。登録は GitHub の secret scanning partner program で行う。`secret-scanning@github.com` に申し込み、秘密の種類ごとの名前と正規表現（一意な接頭辞、高いエントロピー、チェックサムが推奨）を渡し、検出を受ける公開の HTTP エンドポイントを用意する。エンドポイントは `Github-Public-Key-Identifier`・`Github-Public-Key-Signature` の署名（ECDSA P-256、SHA-256）を検証し、見つかったトークンを失効させて持ち主に知らせる。公開のリポジトリと公開の npm パッケージが既定で走査される（[GitHub Docs](https://docs.github.com/en/code-security/secret-scanning/secret-scanning-partnership-program/secret-scanning-partner-program)、2026-09-26 に確認）。このため、トークンの形式にチェックサムを含めることを検討する。

## 6. スコープと管理者の統制

### 6.1 スコープの一覧

MCP（[mcp.md](mcp.md) の 3.2 節）の語彙をそのまま使い、足りないものを同じ形（`<対象>:<動作>`）で加える。[identity-and-access.md](identity-and-access.md) の 6.5 節の `channels:history`・`chat:write` は、この表の `messages:read`・`messages:write` に改めた（反映済み。20 節）。

| スコープ | 許す操作 | ボット | ユーザー | 機微 |
| --- | --- | --- | --- | --- |
| `channels:read` | チャンネルの一覧と情報、チャンネルのメンバー | ○ | ○ | |
| `channels:join` | パブリックチャンネルに自分で参加する | ○ | — | |
| `channels:manage` | チャンネルの作成・名前の変更・アーカイブ、他のメンバーの招待 | ○ | ○ | ○ |
| `messages:read` | 履歴、スレッド、メッセージの取得 | ○ | ○（DM を含む） | ユーザーのとき ○ |
| `messages:write` | 投稿、自分の投稿の編集・削除、一時的なメッセージ | ○ | ○ | |
| `reactions:read` | リアクションの一覧 | ○ | ○ | |
| `reactions:write` | リアクションを付ける・外す | ○ | ○ | |
| `members:read` | メンバーの一覧とプロフィール（メールアドレスを除く） | ○ | ○ | |
| `members:read.email` | メンバーのメールアドレス | ○ | ○ | ○ |
| `files:read` | ファイルの情報と本体 | ○ | ○ | |
| `files:write` | ファイルのアップロード | ○ | ○ | |
| `search:read` | 検索 | ○（ボットが読めるチャンネルだけ） | ○ | ユーザーのとき ○ |
| `commands` | スラッシュコマンドとショートカットを登録する | ○ | — | |
| `incoming-webhook` | Incoming Webhook の URL を作る | ○ | — | |

- 「機微」のスコープは、ワークスペースの方針が `open` でも、owner・admin の承認を要する（6.4 節）。
- ボットの `messages:read` は、ボットが読めるチャンネル（参加しているチャンネルと、パブリックチャンネル）に限られる。ユーザーの `messages:read` は、そのメンバーが読めるもの全部（DM を含む）に届く。
- `realtime:connect`（WebSocket のチケット）は、アプリには出さない。アプリへのイベントは Events API で届ける。
- スコープは権限を広げない（[identity-and-access.md](identity-and-access.md) の 6.5 節の表のとおり）。

### 6.2 イベントに要るスコープ

| イベント | 要るスコープ |
| --- | --- |
| `message.created` / `message.edited` / `message.deleted` | `messages:read` |
| `app.mention` | なし（メンションされたメッセージだけを届ける） |
| `reaction.added` / `reaction.removed` | `reactions:read` |
| `channel.created` / `channel.renamed` / `channel.archived` / `channel.member_joined` / `channel.member_left` | `channels:read` |
| `member.joined` / `member.updated` | `members:read` |
| `app.uninstalled`、`tokens.revoked`、`app_home.opened` | なし |

### 6.3 ワークスペースの方針

| 設定 | 値 | 既定 |
| --- | --- | --- |
| インストールの方針 | `open`（メンバーが機微でないスコープのアプリを入れてよい）/ `approval_required`（すべて管理者の承認を経る） | Enterprise は `approval_required`、それ以外は `open`（[ADR-0032](../decisions/0032-plans-and-entitlements.md) の entitlement `feature.apps_admin_policy` で決める。値は仮） |
| メンバーによるインストール | 許す / 許さない（owner・admin だけ） | 許す |
| 配布型のアプリ | 許す / 審査済みだけ許す / 許さない（単一ワークスペースのアプリだけ） | 許す |
| アプリごとの規則 | 許可（スコープの上限付き）/ 拒否 | なし |

- 変更は監査ログに残す。
- 方針を厳しくしても、既存のインストールは止めない。一覧で、方針に合わないインストールを示し、管理者が止めるか消すかを選ぶ。

### 6.4 インストールの判定

上から評価し、最初に一致した行を採る。スコープの追加（再同意）では、「求めるスコープ」を追加分として評価する。

| # | 入れる人のロール | アプリの規則 | 求めるスコープ | ワークスペースの方針 | 結果 |
| --- | --- | --- | --- | --- | --- |
| 1 | guest | - | - | - | 403（`restricted_action`） |
| 2 | - | 拒否 | - | - | 403（`app_blocked`） |
| 3 | - | - | - | 配布型を許さない、かつアプリが配布型。または審査済みだけ許す、かつアプリが未審査の配布型 | 403（`app_not_allowed`） |
| 4 | owner / admin | - | - | - | インストールする |
| 5 | member | - | - | メンバーのインストールを許さない | 承認の依頼を作る |
| 6 | member | 許可で、上限に収まる | - | - | インストールする |
| 7 | member | - | 機微なスコープを含む | - | 承認の依頼を作る |
| 8 | member | - | - | `open` | インストールする |
| 9 | member | - | - | `approval_required` | 承認の依頼を作る |

- 審査を受けていない配布型のアプリも、この表でインストールできる（[ADR-0033](../decisions/0033-slack-aligned-platform-and-plan-decisions.md) の 4）。未審査のアプリには、履歴・スレッドの取得に読み取りの厳しい上限（[rate-limiting.md](rate-limiting.md) の 4.3 節）をかけ、同意の画面と管理画面に「未審査」と示す。「審査済みのアプリだけを許可する」方針は、6.3 節の「配布型のアプリ」の設定で選ぶ（3 行目）。

- 承認の依頼は、owner・admin にアプリ内の通知で知らせる。承認すると、そのアプリの許可の規則（依頼されたスコープを上限にする）ができ、依頼したメンバーに知らせる。メンバーは OAuth をやり直してインストールする（6 行目に当たる）。
- 同じアプリへの未処理の依頼は、ワークスペースに 1 つにまとめる。
- ユーザーのスコープの認可（5.1 節の最後）も、この表で評価する。インストールそのものは既にあるので、2〜3 行目で拒否されることはない。

## 7. Events API

### 7.1 何が届くか

- アプリは、マニフェストの `bot_events` で購読するイベントを選ぶ。実際に届くのは、インストールで許されたスコープ（6.2 節）で絞ったもの。
- **チャンネルのイベントは、ボットがそのチャンネルを読めるときだけ届く。** 判定は配送の直前に ADR-0005 の判定関数で行う。ボットが参加していないパブリックチャンネルのイベントは、ボットが読める（6.4 節の 3 行目）が、既定では届けない。購読の単位を「ボットが参加しているチャンネル」に限り、配送の量をチャンネルの数に比例させないため。
- `app.mention` は、ボットのメンバーへのメンションを含むメッセージが投稿されたとき、ボットがそのチャンネルを読めれば届く（参加していなくても、パブリックなら届く）。
- ユーザーのトークンに結び付いたイベント（同意したメンバーが見るもの）は、E12 の後半で提供する（21 節の決定）。E12 の初版では提供しない。
- DM・グループ DM は、ボットが参加者のときだけ届く。

### 7.2 封筒とペイロード

HTTPS の `POST` で、次の JSON を送る。

```json
{
  "v": 1,
  "type": "event_callback",
  "event_id": "0192f7c4-...",
  "event_time": "2026-09-26T09:00:00.000Z",
  "app_id": "0191...",
  "installation_id": "0193...",
  "workspace_id": "0192...",
  "event": {
    "type": "message.created",
    "payload_v": 1,
    "channel_id": "0193...",
    "seq": 1234,
    "message": { "id": "...", "member_id": "...", "body": { "v": 1, "blocks": [] }, "ui_blocks": null, "thread_root_id": null }
  }
}
```

- `event` の中身は、公開 API のリソースと同じ形（[public-api.md](public-api.md) の 5.4 節）にする。内部のイベント（[realtime.md](realtime.md) の 4 節）をそのまま出さない。
- `payload_v` は公開のペイロードの版。版を上げるときは、[public-api.md](public-api.md) の 8 節と同じ期間と手段で告知する。移行の間は、アプリがマニフェストで版を選ぶ。
- **中身は送る時点の DB から作る。** 投稿の後に編集されていれば編集後の本文を送る。削除済みのメッセージの `message.created` は送らない（`skipped`）。削除の事実は `message.deleted` で届く。再試行の間に消されたデータを外へ出さないため。
- **順序は保証しない。** チャンネルのイベントには `channel_id` と `seq` を付けるので、アプリは `seq` で並べ直し、重複を捨てられる。`event_id` は再試行でも変わらない。
- 1 回の配送の本文は 64 KB まで。超える本文のメッセージは、`truncated: true` を付けて本文を省き、アプリに公開 API で取り直させる（[realtime.md](realtime.md) の 16 KB の規則と同じ考え方）。

### 7.3 配送の流れ

```
Relay ─▶ SQS app-events（event_type の対応表で、アプリの対象になるものだけ送る）
          ▼
app-event-router：テナントのコンテキストを設定し、対象のインストールを引く
          │  チャンネルのイベント：そのチャンネルに参加しているボット（members.kind = 'bot'）のインストール
          │  app.mention：メンションされたボット
          │  ワークスペースのイベント：購読しているインストール
          │ app_event_deliveries に INSERT ... ON CONFLICT DO NOTHING（冪等キーは (installation_id, event_id)）
          ▼
SQS app-delivery ─▶ app-delivery Worker
          │ 1. インストールが active か、宛先が enabled か、スコープとチャンネルを読めるかを確かめる（外れたら skipped）
          │ 2. DB から中身を作る → 署名する（8 節）
          │ 3. app-egress（Lambda）を同期で呼ぶ → 応答のステータスと遅延だけを受け取る
          │ 4. 結果を app_event_deliveries に書く。失敗なら次の試行の時刻を決める
          ▼
app-delivery-scheduler（advisory lock で 1 台）：next_attempt_at を過ぎた行を 10 秒ごとに app-delivery へ戻す
```

- 再試行の予定を DB に置くのは、SQS の遅延が最大 15 分で、長い間隔を表せないため（通知のメールと同じ。[read-state-and-notifications.md](read-state-and-notifications.md) の 4 節）。
- 1 回目の試行は、投稿から p95 5 秒以内を目標にする（アプリ側の応答時間を除く。初期値）。

### 7.4 成功・失敗と再試行

| アプリの応答 | 扱い |
| --- | --- |
| 2xx（5 秒以内） | 成功 |
| タイムアウト（5 秒）、接続の失敗、5xx | 再試行する |
| 429 | `Retry-After`（最大 1 時間）に従って再試行する |
| 410 | 宛先を即座に無効にする（7.5 節） |
| その他の 4xx | そのイベントは再試行しない（`failed`）。7.5 節の失敗には数える |
| 3xx | 失敗として扱う。リダイレクトを追わない |

- 再試行の間隔（初期値）：直後、10 秒、1 分、5 分、30 分、2 時間、6 時間の計 7 回。約 9 時間で諦める（`failed`）。間隔には ±20% のジッターを入れる。
- 配送は「少なくとも 1 回」。アプリは `event_id` で重複を捨てる。

### 7.5 宛先の無効化

- 次のどちらかで、アプリのイベントの宛先を `disabled` にする。
  - 直近 24 時間、成功が 1 件もなく、失敗が 100 件以上ある
  - 410 を返した
- 無効の間のイベントは、配送を作らずに捨てる（`dropped` として数える）。
- 無効にしたら、開発者（コラボレーター全員）にメールと開発者コンソールで知らせる。インストール先の管理者にも、アプリの一覧で「イベントが止まっている」と示す。
- 開発者がコンソールで有効に戻すと、URL の確認（7.7 節）をやり直してから再開する。無効の間に捨てたイベントは再送しない。
- インストールごとの未配送の件数に上限（初期値 10,000 件）を置き、超えたら古いものから捨てる。1 つのワークスペースの大量のイベントが、アプリ全体の配送を詰まらせないため。

### 7.6 Socket Mode（WebSocket での受け取り）

**E12 の初版では提供しない。** 本家に寄せて、E12 の後半で提供すると決めた（21 節の決定）。下の理由から、Gateway とは別のサービスにし、着手時に ADR を起票する。

- 利点は、公開の URL を持てない環境（社内のネットワークの中、開発者の手元）でアプリを動かせること。
- 一方で、アプリごとに長く続く接続を受ける、状態を持つ新しいサービスが要る。Gateway（[realtime.md](realtime.md)）は「ブラウザへのベストエフォートの配信」のためのもので、確実な配送（再試行、未配送の保持）の責務を持たせると、Gateway の設計の前提が崩れる。
- 開発の手元では、トンネル（公開の URL を手元に中継する道具）を案内する。
- 次のどれかが起きたら、別の ADR で検討する：単一ワークスペースのアプリの開発者から、公開の URL を持てないことを理由とする要望が続く／企業顧客の要件として求められる。

### 7.7 URL の確認

- `request_url` を設定・変更したとき、`{"type": "url_verification", "challenge": "<乱数>"}` を署名付きで送り、3 秒以内に `challenge` の値をそのまま返したときだけ保存する。
- 配布型のアプリは、URL のホストが確認済みのドメイン（`app_verified_domains`）の下にあることも求める。
- どちらのアプリも、`https`、ポート 443、公開の DNS 名（IP アドレスの直書きは不可）に限る。解決先の検査は 13 節。

## 8. 署名とリプレイの防止

Events API、インタラクティブ機能、スラッシュコマンド、URL の確認の、アプリへ送るすべての要求に署名する。形式は Standard Webhooks の仕様に合わせる。検証の実装が多くの言語に既にあるため。ヘッダーは `webhook-id`・`webhook-timestamp`・`webhook-signature`、署名は `v1,` に続けて `{id}.{timestamp}.{本文}` の HMAC-SHA256 の base64、入れ替え中は複数の署名を空白で区切る。秘密は `whsec_` に続く base64 で、24〜64 バイトとする（[Standard Webhooks の仕様](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md)、2026-09-26 に確認）。時刻の許容幅は仕様では定めていないので、本システムは 5 分とする。

| ヘッダー | 値 |
| --- | --- |
| `webhook-id` | 配送の ID（Events API は `event_id`） |
| `webhook-timestamp` | 送った時刻（UNIX 秒） |
| `webhook-signature` | `v1,<base64(HMAC-SHA256(署名の秘密, "{id}.{timestamp}.{本文}"))>`。秘密の入れ替え中は、新旧の 2 つを空白で区切って並べる |

- アプリには、次の検証を求める（文書と SDK で示す）。
  - 署名を定数時間で比べる。
  - `webhook-timestamp` が現在から 5 分以上ずれていれば拒否する。
  - `webhook-id` を 5 分以上覚えておき、同じものを 2 回処理しない。
- 署名はアプリごとの署名の秘密で行う。秘密は `app_credentials` に KMS で暗号化して置き、app-delivery Worker と api だけが復号できる（タスクロールで限定する）。egress の Lambda には秘密を渡さない。
- アプリから本システムへの呼び出し（公開 API、`response_url`）は、Bearer トークンか URL の秘密で認証する。こちらには署名を求めない。

## 9. インタラクティブ機能

### 9.1 共通

```
Web クライアント ─▶ POST /api/workspaces/{ws}/interactions（内部の API）
   │ 1. 判定：メンバーがチャンネルを読めるか（ADR-0005）、インストールが active か、宛先が enabled か
   │ 2. trigger_id を発行（Valkey、TTL 10 秒、1 回限り。インストール・メンバー・接続に結び付ける）
   │ 3. ペイロードを作り、署名し、app-egress-interactive（Lambda）を同期で呼ぶ（タイムアウト 2.5 秒）
   │ 4. アプリの応答（最大 64 KB）を VPC の中で Zod で検証し、結果を適用する
   ▼
クライアントへ結果（成功、アプリの応答による更新、「アプリが応答しませんでした」）
```

- **アプリは 3 秒以内に応答する（ack）。** 本システムの側の処理を含めた予算で、アプリの応答を待つのは 2.5 秒まで。時間のかかる処理は、ack の後に `response_url` か公開 API で結果を返してもらう。
- api のタスクが外部の応答を待つので、タスクごとに同時に待つ数の上限（初期値 50）を置き、超えたら 503 を返す。投稿などの他の要求の遅延（NFR-003）に響かないようにするため。
- `response_url`：`https://hooks.<domain>/v1/responses/{token}`。30 分有効、5 回まで使える。一時的なメッセージ、チャンネルへの投稿（ボットとして）、元のメッセージの置き換え（ボット自身のメッセージに限る）ができる。
- インタラクションのペイロードには、操作したメンバーの ID、チャンネル、`trigger_id`、`response_url`、`action` の中身を入れる。操作したメンバーのメールアドレスは入れない。

### 9.2 種類

| 種類 | きっかけ | ペイロードの要点 | ack で返せるもの |
| --- | --- | --- | --- |
| スラッシュコマンド | 入力欄の `/command text` | コマンド、テキスト、チャンネル | 空（受け付けたことだけ）、一時的なメッセージ、チャンネルへの投稿 |
| グローバルショートカット | ショートカットのメニュー | `callback_id` | 空（多くはモーダルを開く） |
| メッセージのショートカット | メッセージのメニュー | `callback_id`、対象のメッセージ（公開の形） | 空 |
| ブロックの操作 | ボタン、選択などの要素（10 節） | `action_id`、`value`、選んだ値、要素のあるメッセージ・ビュー | 空、元のメッセージの置き換え |
| ビューの送信 | モーダルの送信ボタン | 入力の値（`state`）、`private_metadata` | 空（閉じる）、入力の誤り（`errors`）、置き換え（`update`）、重ねる（`push`）、全部閉じる（`clear`） |
| ビューを閉じた | モーダルの取り消し（マニフェストで希望したときだけ） | ビューの ID | 空 |

- **スラッシュコマンドの名前** は、ワークスペースで一意にする（`workspace_slash_commands`）。組み込みのコマンド（`/remind` などを作るなら）は予約する。後から入れたアプリが同じ名前を持つときは、管理者がどちらに割り当てるかを選ぶ。既定は先に入れたアプリ。
- メッセージのショートカットは、ボットが参加していないチャンネルのメッセージもアプリへ送る。操作したメンバーが、自分で共有を選んだものとみなす。同意の画面で `commands` のスコープの説明に明記する。
- スラッシュコマンドとショートカットは、ゲストには既定で出さない（ワークスペースの方針で許せる）。

### 9.3 モーダル

- アプリは、`trigger_id` を使って `POST /v1/workspaces/{ws}/views` でモーダルを開く。`trigger_id` を使えるのは、それを発行したインストールだけで、1 回限り。
- モーダルは、`trigger_id` の結び付いた接続（端末）にだけ、メンバーのストリーム（`ws:{w}:m:{m}`）の `view.opened` で届ける。Gateway は宛先の接続 ID が一致するものだけに送る。
- 重ねられるのは 3 枚まで。更新は `PUT .../views/{view_id}` で、`hash` が一致するときだけ受け付ける（楽観ロック。違えば 409）。
- 開いたモーダルの期限は 1 時間。過ぎたら送信を受け付けない。

### 9.4 一時的なメッセージ

- 特定のメンバーだけに見える、保存しないメッセージ。スラッシュコマンドの応答などに使う。
- DB に保存せず、`seq` も消費しない。メンバーのストリームで `ephemeral.message` として届け、クライアントはそのチャンネルに「あなたにだけ表示」として出す。接続していない端末には届かず、再読み込みで消える。
- 送れるのは、そのメンバーが読めるチャンネルに限る（ADR-0005）。

## 10. UI ブロック

アプリがメッセージ・モーダル・アプリのホームに置く、宣言的な UI。クライアントは、検証済みの JSON を React の要素に変換して描画する。**HTML・CSS・スクリプト・iframe を受け付けない**（[ADR-0006](../decisions/0006-message-body-ast.md) と同じ考え方）。

### 10.1 スキーマ（v1）

```ts
type UiBlocks = { v: 1; blocks: UiBlock[] };

type UiBlock =
  | { type: "header"; text: PlainText }
  | { type: "section"; block_id?: string; text?: Text; fields?: Text[]; accessory?: Element }
  | { type: "divider" }
  | { type: "context"; elements: (Text | ImageRef)[] }
  | { type: "actions"; block_id?: string; elements: Element[] }
  | { type: "image"; file_id: string; alt_text: string }
  | { type: "input"; block_id: string; label: PlainText; element: InputElement; optional?: boolean }; // モーダルだけ

type Text = PlainText | RichText;
type PlainText = { type: "plain_text"; text: string };
type RichText  = { type: "rich_text"; body: PublicRichTextV1 };      // 本文と同じ公開の形（public-api.md の 5.4 節）
type ImageRef  = { type: "image"; file_id: string; alt_text: string };

type Element =
  | { type: "button"; action_id: string; text: PlainText; value?: string; url?: string;
      style?: "primary" | "danger"; confirm?: Confirm }
  | { type: "static_select" | "multi_static_select"; action_id: string; options: Option[]; placeholder?: PlainText }
  | { type: "members_select" | "channels_select"; action_id: string; placeholder?: PlainText }
  | { type: "overflow"; action_id: string; options: Option[] }
  | { type: "datepicker"; action_id: string; initial_date?: string };

type InputElement = Element | { type: "plain_text_input"; action_id: string; multiline?: boolean; max_length?: number }
                  | { type: "checkboxes" | "radio_buttons"; action_id: string; options: Option[] };
```

- スキーマは `packages/contract/public/v1` の Zod で定義し、公開 API と Events API の文書に出す。版を上げる規則は、本文の AST と同じ（変換関数、未知の型は描画しない）。
- **画像は、本システムに置いたファイル（`file_id`）だけ。** 外部の画像の URL は受け付けない。CSP の `img-src` を広げず（[security.md](security.md) の 5 節）、閲覧者の IP を外部に渡さないため。アプリは `files:write` で画像を上げてから参照する。
- ボタンの `url` は `https` だけ。押すと、遷移先のドメインを示す確認を挟んでから、新しいタブで開く（`noopener`）。
- `members_select`・`channels_select` の選択肢は、操作するメンバーの権限でクライアントが引く。アプリは選択肢の中身を知らない。
- アプリの出したものには、クライアントが必ず「アプリ」の印とアプリの名前を付ける。システムの画面やほかのメンバーを装えないようにするため。`header` の文字の大きさなど、見た目の強さにも上限を設ける。

### 10.2 上限

| 対象 | 上限 |
| --- | --- |
| 1 メッセージのブロック | 50 |
| 1 つのモーダル・アプリのホームのブロック | 100 |
| JSON の大きさ | 64 KB |
| `action_id`・`block_id` | 255 文字 |
| ボタンの `value` | 2,000 文字 |
| 選択肢 | 100 |
| テキストの長さ | 3,000 文字（`header` は 150） |

### 10.3 メッセージでの扱い

- `ui_blocks` を付けたメッセージにも、本文（リッチテキスト、またはテキスト）を必須にする。通知・検索・読み上げ・MCP には本文だけを使う。
- `ui_blocks` を付けられるのは、アプリのトークン（ボット）と `response_url`・Incoming Webhook だけ。人間のメンバーのセッションと、ユーザーのトークンからは付けられない（人間を装った UI を作らせないため）。
- 検索は本文だけを索引にする（[search.md](search.md)）。`ui_blocks` のテキストは索引にしない。

## 11. Incoming Webhook

- `incoming-webhook` のスコープを持つアプリが、インストール時に、投稿するチャンネルを 1 つ選んで URL を作る。インストールしたメンバーが読めるチャンネルに限る。ボットはそのチャンネルに参加する。
- URL：`https://hooks.<domain>/v1/{webhook_id}/{secret}`。秘密は 32 バイトの乱数で、`incoming_webhooks` にはハッシュだけを置く。作成時に 1 回だけ渡す。
- `POST` で `{ "text": "..." }`、またはリッチテキストと `ui_blocks` を受ける。ボットとして投稿する。操作を伴う要素（`url` のないボタンなど）は受け付けない（受け取り先のインタラクションがないため）。
- 応答は 204。誤りは公開 API と同じ Problem Details。
- レート制限は `tier-write` と `limit-post-per-channel`（[rate-limiting.md](rate-limiting.md)）。
- ボットがチャンネルから外されたら 403（`not_in_channel`）。アンインストール、管理者の取り消し、アプリからの取り消しで、URL は使えなくなる。秘密を入れ替える API を持つ。
- `hooks.<domain>` は `public-api` のサービスで受け、WAF のルールを分ける。アクセスログではパスの秘密を伏せる（[public-api.md](public-api.md) の 9 節）。

## 12. アプリのホーム

- マニフェストで `app_home.enabled` のアプリは、メンバーごとに「ホーム」のタブを持つ。ボットとの DM が「メッセージ」のタブになる。
- メンバーがホームを開くと、`app_home.opened` のイベントを送る（1 メンバー・1 アプリにつき 1 分に 1 回まで）。
- アプリは `PUT /v1/workspaces/{ws}/app-home/{member_id}` で、そのメンバーのホームの UI ブロックを置く。`app_views`（種類 `home`）に保存し、メンバーのストリームの `view.updated` で届ける。
- ホームの中身はそのメンバーにだけ見える。アプリは、そのメンバーが読めないチャンネルの内容をホームに出さないよう求められるが、本システムでは中身を検査できない。審査（14.2 節）の観点に入れる。

## 13. 外向きの通信（egress）

アプリの URL への送信は、利用者（開発者）が指定した任意の URL に届く。リンクのプレビュー（[ADR-0016](../decisions/0016-isolated-link-unfurling.md)）と同じ SSRF の危険がある。

- **ADR-0016 の方式（VPC に接続しない、権限を持たない Lambda）を使い、関数は分ける。**

  | 関数 | 用途 | 同時実行 |
  | --- | --- | --- |
  | `app-egress` | Events API、URL の確認 | 予約済みの同時実行数（初期値 300） |
  | `app-egress-interactive` | インタラクティブ機能、スラッシュコマンド | プロビジョニング済みの同時実行（初期値 20）。コールドスタートで 3 秒の予算を使い切らないため |
  | 既存の unfurler | リンクのプレビュー | 変えない |

- 関数を分ける理由：アプリの宛先の障害（遅い応答で同時実行を使い切る）が、リンクのプレビューとインタラクティブ機能に波及しないようにするため。
- 宛先の検査は ADR-0016 の「アプリの検査」をそのまま使う（IP の拒否リスト、検査したアドレスへの直接の接続、リダイレクトを追わない、自分たちのドメインへの送信の禁止）。加えて、ポートは 443 だけ、`http` は不可。
- Lambda は、署名済みの要求（ヘッダーと本文）を受け取って送り、ステータス・応答ヘッダーの一部・応答の本文（インタラクティブだけ、64 KB まで）を返す。応答の解釈は VPC の中で Zod で行う。
- **送信元の IP は固定しない。** Lambda の送信元は決まらないので、アプリに IP の許可リストを案内できない。署名の検証を求める。固定の IP の需要が強ければ、ADR-0016 の選択肢 3（専用の VPC と固定の NAT）を、別の ADR で検討する。
- アプリごとの同時に送る数の上限（初期値 50）を、Worker 側で Valkey で数える。1 つの遅いアプリが、関数の同時実行を使い切らないため。

## 14. セキュリティ

### 14.1 脅威

[security.md](security.md) の 3 節に加える案。

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| I | 悪意あるアプリが、会話を外へ持ち出す | 最小のスコープ、ボットは参加したチャンネルだけ、機微なスコープの管理者承認、未審査のアプリの読み取りの厳しい上限、管理者の停止と削除、監査 |
| I | アプリの宛先への配送が、別のワークスペースのデータを含む | 配送はインストール単位で作り、`workspace_id` でテナントのコンテキストを設定してから中身を作る。宛先の URL はアプリ単位なので、複数のワークスペースのデータが同じ URL に届くのは仕様どおり（アプリが受け手） |
| S | 第三者が、本システムを装ってアプリに偽のイベントを送る | 署名、時刻の検査、`webhook-id` での重複排除（8 節） |
| S | アプリがシステムや他のメンバーを装う UI を出す | 「アプリ」の印の強制、見た目の上限、人間からの `ui_blocks` の禁止（10 節） |
| S | 偽のアプリが、有名なサービスの名前で同意を得る | 同意の画面に、所有者・確認済みのドメイン・審査の状態（「未審査」「審査済み」）を示す。審査は任意なので（ADR-0033 の 4）、未審査のアプリには読み取りの厳しい上限をかけ、管理者は審査済みのアプリだけを許す方針を選べる |
| T | `trigger_id`・`response_url` の使い回し | `trigger_id` は 10 秒・1 回限り・インストールに結び付ける。`response_url` は 30 分・5 回まで |
| E | ボットのトークンの漏洩 | 接頭辞とシークレットスキャン、入れ替え、即時の失効、最終使用日時の表示 |
| E | スコープの追加を黙って行う | スコープはインストールの版に固定し、追加は再同意（5.1 節） |
| E | 混乱した代理：アプリが、操作したメンバーの権限を借りて読めないものを読む | インタラクションはアプリにメンバーの権限を与えない。アプリはボットの権限（またはそのメンバーのユーザーのトークン）でしか読めない |
| D | アプリの遅い応答・大量のイベントによる資源の枯渇 | 関数の分離と同時実行の上限、配送の上限、宛先の無効化（7.5 節、13 節） |
| D | SSRF | 13 節 |

### 14.2 配布型のアプリの審査

- 審査は任意で、本家の Marketplace の審査に相当する。審査済みになると、読み取りの厳しい上限が外れ、「審査済み」の表示が付く（ADR-0033）。
- 審査は、Ops の配下の「プラットフォームの審査」の担当が行う。エージェントは審査しない。
- 観点：所有者とドメインの確認、プライバシーポリシー、求めるスコープの理由（開発者が記入する）、署名の検証を実装しているか（テストの配送で確かめる）、UI ブロックが紛らわしくないか、データの扱い（保存・第三者への提供・削除の依頼への対応）。
- スコープを加える版の公開、配布の種類の変更、ドメインの変更は、再審査にする。それ以外の変更は、審査なしで公開できる。
- 審査で拒否・後から問題が見つかったアプリは `blocked` にでき、全インストールを停止する（`app_suspended`）。停止は監査ログに残し、各ワークスペースの管理者に知らせる。

### 14.3 秘密の入れ替え

| 秘密 | 入れ替え | 重なり |
| --- | --- | --- |
| ボットのトークン | 公開 API とコンソール（5.3 節） | 24 時間。漏洩時は即時 |
| 署名の秘密 | コンソール | 24 時間（新旧の 2 つで署名する。8 節） |
| `client_secret` | コンソール | 24 時間（本家と同じ。21 節の決定）。Better Auth の `/oauth2/client/rotate-secret` は旧い秘密を即座に無効にする（[public-api.md](public-api.md) の 4.1 節）ので、トークンのエンドポイントを本システムのハンドラーで包み、旧い秘密のハッシュを 24 時間だけ別に持って照合する。漏洩時は即時に失効させる |
| Incoming Webhook の秘密 | 公開 API とコンソール | 1 時間 |
| KMS の `apps` キー | KMS の自動ローテーション（[ADR-0017](../decisions/0017-encryption-and-key-management.md)） | — |

- 秘密の平文は発行時に 1 回だけ表示する。署名の秘密も、発行後はコンソールで再表示しない（入れ替えで出し直す）。
- 入れ替えと失効は、所有するワークスペース（アプリの秘密）またはインストール先（トークン）の監査ログに残す。

## 15. アンインストールとデータの保持

アンインストール（管理者・入れた人・アプリ自身の `DELETE /v1/auth/installation`）は、同じトランザクションで次を行う。

| 対象 | 扱い |
| --- | --- |
| ボットのトークン、ユーザーのトークン（そのアプリのもの） | すべて失効。Better Auth の同意も取り消す |
| ボットのメンバー | 無効化。全チャンネルから外す（5.2 節） |
| ボットの過去の投稿・ファイル | ワークスペースのデータとして残す（[ADR-0019](../decisions/0019-data-retention-and-deletion.md)）。削除は保持ポリシーと管理者の削除に従う |
| `ui_blocks` を持つ過去の投稿 | 残す。ボタンなどの操作は「アプリが入っていません」と表示して無効にする |
| スラッシュコマンド、Incoming Webhook、`app_views`、承認の依頼 | 消す |
| 未配送のイベント（`app_event_deliveries`） | `dropped` にする。パーティションの期限で消える |
| `app_installations` の行 | 残す（`uninstalled`）。監査と再インストールのため。ワークスペースの削除で消える |
| アプリへの通知 | `app.uninstalled` を 1 回だけ送る（中身はワークスペースとインストールの ID だけ） |

- アプリの側に保存されたデータは、本システムでは消せない。開発者の利用規約で、アンインストールから 30 日以内の削除を求め、審査の観点に入れる。
- ワークスペースの削除は、全インストールのアンインストールとして扱う。
- アプリの削除（開発者）は、全インストールのアンインストールとして扱い、その後、グローバルの定義を論理削除する。
- アカウントの削除（[identity-and-access.md](identity-and-access.md) の 12 節）では、そのアカウントのユーザーのトークンと同意を消す。インストールは、入れた人がいなくなっても残す。

## 16. レート制限

値は [rate-limiting.md](rate-limiting.md) が正本で、ここでは割り当てだけを書く。

| 対象 | tier・制限 | 単位 |
| --- | --- | --- |
| 公開 API の各操作 | [public-api.md](public-api.md) の 3.2 節の表 | インストール（トークン）ごと、ワークスペースごと |
| 投稿（公開 API、`response_url`、Incoming Webhook） | `tier-write` ＋ `limit-post-per-channel` | 同上。チャンネルごと |
| モーダルを開く・更新する、ホームを置く | `tier-write` | インストールごと |
| アプリの管理（コンソール、トークンの入れ替え） | `tier-admin` | アプリごと |
| 一括の処理（将来のエクスポートなど） | `concurrency-bulk` | ワークスペースごと |

- アプリの送信先ごとの配送の速さの上限は [rate-limiting.md](rate-limiting.md) の 4.5 節にある。超えた分は遅らせる。
- それ以外の配送の側の制限（アプリごとの同時に送る数、インストールごとの未配送の上限、関数の同時実行）は、この文書の 7.5 節と 13 節に初期値を置く。rate-limiting.md へ移すかは、そちらの持ち主（Dev）が決める。

## 17. 観測

- メトリクス（`app_id` は上位 N 件＋「その他」）：
  - 配送：作成数、成功率、試行の回数の分布、アプリの応答の遅延、`skipped`・`dropped` の件数、無効な宛先の数、スケジューラーの遅れ
  - インタラクティブ：ack の成功率、タイムアウトの割合、egress の遅延（コールドスタートを含む）
  - egress の Lambda：同時実行、スロットリング、宛先の検査での拒否の件数（SSRF の試み）
- 開発者コンソールでは、自分のアプリについて、直近 7 日の配送の記録（イベントの種類、ステータス、遅延、試行の回数。**ペイロードは出さない**）と、インタラクションの失敗を見られる。コンソールは、テナントの外の `app_delivery_attempts`（中身を持たないメタデータ、アプリ単位、7 日保持）だけを読む。テナントの中の `app_event_deliveries`（3 日保持）は読まないので、ADR-0009 の例外は設けない（[ADR-0033](../decisions/0033-slack-aligned-platform-and-plan-decisions.md) の 5）。
- 監査ログ（ADR-0018）：インストール、アンインストール、停止・再開、スコープの追加、承認の依頼と判断、方針の変更、トークン・秘密の発行・入れ替え・失効、アプリの `blocked`。
- runbooks への追加（Ops への依頼）：
  - `app-event-delivery.md`：配送の滞留、スケジューラーの停止、無効な宛先の急増、egress のスロットリング
  - `app-abuse.md`：アプリの停止（`blocked`）、トークンの一括失効、審査の取り消し

## 18. 段階ごとの変化と容量

### 18.1 配送の量（S1、初期見積もり）

| 項目 | 値 | 前提 |
| --- | --- | --- |
| チャンネルのイベント（ピーク） | 約 450 件/秒 | 投稿 300 件/秒＋リアクション・編集・削除（[capacity.md](capacity.md) の 1 節） |
| そのうちボットが参加しているチャンネルのもの | 20% | 仮定。E12 の社内運用で測る |
| 1 イベントあたりの配送 | 平均 1.5 インストール | 仮定 |
| **配送（ピーク）** | **約 150 件/秒**（余裕を見て 500 件/秒で設計） | |
| egress の同時実行 | 平均の応答 300ms で約 50。全宛先が 5 秒のタイムアウトになると約 750 | 予約済みの同時実行 300 と、アプリごとの上限 50 で抑える |
| `app_event_deliveries` の行 | 1 日約 500 万行 | 日ごとのパーティション、3 日保持 |

- 配送の行の INSERT・UPDATE が writer に加わる（ピークで約 500 行/秒）。[capacity.md](capacity.md) の 2.1 節の合計（約 4,000 行/秒）に対して小さいが、E12 の負荷試験に含める。
- app-event-router の「チャンネルに参加しているボット」の引き当ては、`channel_members` と `members.kind` で行う。reader から読み、`(workspace_id, channel_id)` の索引を使う。ボットのいないチャンネルが大半なので、チャンネルごとの「ボットがいるか」を Valkey に短時間キャッシュする。

### 18.2 段階

| 段階 | 内容 |
| --- | --- |
| S1 | E12 で、release フラグ（`release.apps_platform`）の裏から出す。社内のアプリ → 単一ワークスペースのアプリ → 配布型。ops フラグ `ops.app_event_delivery_enabled`、`ops.app_interactivity_enabled`、`ops.incoming_webhooks_enabled` で個別に止められるようにする |
| S2 | 配送の Worker を増やす。大規模チャンネル（[realtime.md](realtime.md) の 5.3 節）のイベントは、アプリへの配送も専用のキューに分ける |
| S3 | アプリの定義（3.2 節）はセルの外（アイデンティティ面）に置き、各セルへ読み取り専用で複製する（署名の秘密は暗号化したまま）。インストールと配送はセルの中。開発者コンソールと認可サーバーはセルの外。egress の Lambda はセルごとに置く |

## 19. テスト

quality.md への追加の提案。

- 性質ベーステスト：任意のメンバー・チャンネル・イベントの列について、アプリに配送されるイベントは、配送の時点でボットが読めて、スコープが許すものの部分集合である。別のワークスペースのインストールに配送されない。
- 表駆動テスト：6.4 節（インストールの判定）、7.4 節（応答ごとの扱い）、5.2 節（ライフサイクル）。
- 署名：公開するテスト用のベクターで、SDK と本システムの署名が一致する。時刻のずれと再送を拒否する例。
- SSRF：ADR-0016 の Confirmation と同じ宛先の一覧で、`app-egress`・`app-egress-interactive` が送信しない。
- UI ブロック：任意の `ui_blocks` について、描画結果に実行可能な要素と外部の画像が含まれない（ADR-0006 の性質の拡張）。
- 障害注入：宛先の遅延・5xx・タイムアウトで、再試行の予定どおりに試行され、他のアプリの配送の遅延が目標を超えない。
- アンインストールの結合テスト：15 節の表のすべての対象が、期待どおりの状態になる。

## 20. 他の文書への反映

下の表の変更は、すべて各文書に反映済み。

| 文書 | 変更 |
| --- | --- |
| [intent.md](../intent.md) の Non-goals | 「アプリ / Bot プラットフォーム、汎用の公開 API」を、「MVP の後（E12）で提供する。公開のディレクトリ、Socket Mode、Enterprise 向けの組織単位のインストールは対象外」に改める（PM）。Socket Mode は、21 節の決定で E12 の後半に提供することにした |
| [identity-and-access.md](identity-and-access.md) の 9 節 | ボットのトークンをインストールに属するものにする。管理者が手でボットを作る経路を、単一ワークスペースのアプリに置き換える。`api_tokens` に `installation_id` を加える |
| 同 6.5 節 | スコープの表を 6.1 節の語彙に改める（`channels:history` → `messages:read`、`chat:write` → `messages:write`、`realtime:connect` はアプリに出さない） |
| 同 15 節 | `members.kind` を加えることに決める |
| [mcp.md](mcp.md) の 1 節 | 「汎用の REST API とボットのプラットフォームは提供しない」を、「公開 API とアプリの基盤は E12 で別に提供する。MCP は AI エージェント向けの面として残し、同じサービス関数の上に作る」に改める |
| [data-model.md](data-model.md) | 3.2 節・3.3 節のテーブルと、`members.kind`、`messages.ui_blocks`・`installation_id` |
| [security.md](security.md) | 14.1 節の脅威、信頼境界の図に egress の Lambda、7.2 節とアプリの関係 |
| [capacity.md](capacity.md) | 18.1 節の配送の量、SQS のキュー（`app-events`、`app-delivery`）、Lambda の同時実行 |
| [infrastructure.md](infrastructure.md) | `public-api` サービス、`hooks.<domain>`、egress の Lambda |
| roadmap.md | E12 の追加 |

## 21. 未解決の問い

次の 4 つは、[ADR-0033](../decisions/0033-slack-aligned-platform-and-plan-decisions.md) で本家 Slack に寄せて決めた。

- ボットの投稿は、人間の投稿と別の枠にする。
- 配布型のアプリは審査なしで配布でき、審査は任意とする。審査の担当は、Ops の配下の「プラットフォームの審査」。
- 開発者コンソールは、中身を持たない配送のメタデータ（`app_delivery_attempts`、テナントの外）だけを読む。ADR-0009 の例外は設けない。
- レート制限はプランで変えない。

残る問い：


- ユーザーのトークンに結び付いたイベント（メンバーが見るもの全部）を出すか。出すなら、配送の量と、DM の中身が外へ出ることへの管理者の統制。
- Socket Mode（7.6 節）と、送信元の固定の IP（13 節）の需要。
- `client_secret` の入れ替えに重なりを持たせる方法（Better Auth の拡張か、`private_key_jwt` を勧めるか）。
- Enterprise 向けに、複数のワークスペースへ一括でインストールする仕組み（Enterprise Grid は範囲外だが、需要は出うる）。

### 決定（2026-09-26、既定案）

残る問いは、本家 Slack に寄せて次のとおり決めた。

- **ユーザーのトークンに結び付いたイベントを提供する（E12 の後半）。** 本家の Events API は、ユーザーのスコープで同意したメンバーが「見える」イベントを届ける。同じイベントが複数の同意したメンバーに見えるときは、1 件だけ送り、見えるメンバーを 1 人 `authorizations` に入れる（[The Events API](https://docs.slack.dev/apis/events-api/)、2026-09-26 に確認）。本システムも同じ形にし、配送の量をメンバーの数に比例させない。統制：
  - ユーザーの `messages:read`・`search:read` は機微のスコープなので、ワークスペースの方針にかかわらず owner・admin の承認を要する（6.1 節、6.4 節）。プランで提供を分けない（`feature.api_user_tokens` は全プランで有効）。
  - 同意の画面と承認の依頼に、DM・グループ DM の内容がアプリに届くことを明示する。
  - 配送の直前に、同意したメンバーが読めるかを ADR-0005 の判定関数で確かめる（7.1 節と同じ）。
  - roadmap の E12 に `user-token-events` を加えた。配送の量は、着手時に 18.1 節の見積もりに加える。
- **Socket Mode を提供する（E12 の後半）。** 本家は Socket Mode を提供し、アプリ単位のトークンで接続させる。Socket Mode のアプリは公開の Marketplace に載せられない（[Using Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/)、2026-09-26 に確認）。本システムも、Socket Mode を使えるのを単一ワークスペースのアプリと、審査を受けていない配布型のアプリに限る（審査済みのアプリは HTTPS の配送だけ）。確実な配送の責務を持つので、Gateway（ADR-0013）と別のサービスにする。ADR-0031 の「B」を改める ADR を、`socket-mode` の着手時に起票する（持ち越し：サービスの構成は ADR で決める）。roadmap の E12 に `socket-mode` を加えた。
- **送信元の IP は固定しない（13 節のまま）。** 本家もアプリへの要求の送信元の IP を案内せず、署名の検証で本物かを確かめるよう求める（[Verifying requests from Slack](https://docs.slack.dev/authentication/verifying-requests-from-slack/)、2026-09-26 に確認）。公開の URL を持てない環境には、Socket Mode を案内する。
- **`client_secret` の入れ替えに、24 時間の重なりを持たせる。** 本家では、入れ替えの後も旧い秘密が 24 時間有効で、手で取り消せば即座に無効になる（同上）。Better Auth は拡張せず、トークンのエンドポイントを本システムのハンドラーで包む方式にする（5.1 節で、一時的な値の扱いのために包む場合と同じハンドラー）。`private_key_jwt` は本家にないので、勧めない。14.3 節の表を改めた。
- **Enterprise 向けの、複数のワークスペースへの一括のインストールは提供しない。** 本家では Enterprise Grid の組織単位のインストールにあたり、Enterprise Grid は範囲外（[intent.md](../intent.md) の Non-goals）。

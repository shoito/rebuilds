# Integrations: Linear

外部のサービスとの連携を決める。GitHub・GitLab（PR・MR とイシューの結び付け、PR の状態によるイシューの状態の自動化）、Slack（メッセージからイシューを作る、チャンネルへの通知、リンクの展開、個人への通知の口）、連携のインストールと資格情報の保管を扱う。

前提となる決定は、Writer を通す書き込み（[ADR-0006](../decisions/0006-transactions-writer-and-idempotency.md)）、テナントと非公開のチーム（[ADR-0004](../decisions/0004-tenancy-and-permissions.md)）、識別子と別名（[ADR-0020](../decisions/0020-ids-and-human-identifiers.md)）、ワークフローの状態（[ADR-0023](../decisions/0023-workflow-states-and-lifecycle-automation.md)）、Triage の入り口（[ADR-0024](../decisions/0024-hierarchy-relations-duplicates-and-triage.md)）、派生の変更（[ADR-0025](../decisions/0025-derived-changes-in-writer.md)）、権限の関数（[ADR-0032](../decisions/0032-single-policy-module-and-group-mapping.md)）、通知の配り（[ADR-0037](../decisions/0037-notification-delivery-channels.md)）。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0038](../decisions/0038-git-hosting-linking-and-state-automation.md) | GitHub は GitHub App、GitLab は顧客のトークンと署名付きの Webhook で受ける。受けたイベントは署名を確かめて保存し、PR（MR）ごとに順序を保つ FIFO のキューで Worker が照合する。結び付けはブランチ名・タイトル（閉じる扱い）と、本文の「閉じる語」「閉じない語」で決める。状態の自動化はチームの設定で、前へ進めるだけにし、複数の PR は全部がそろってから進める。書き込みは Writer を通し、非公開のチームのイシューは、PR の作者が結び付いた利用者でそのイシューを書ける時だけ動かす |
| [0039](../decisions/0039-slack-app-issue-creation-and-channel-notifications.md) | Slack はワークスペースごとに 1 つのインストール（ボットのトークン、トークンの入れ替えを有効）。メッセージからの作成は、結び付けた利用者だけが、書けるチームにだけ行え、Triage に入る。チャンネルへの通知とリンクの展開は、公開のチーム（とその中だけのプロジェクト）に限る。スレッドの双方向の同期は MVP の後にする |
| [0040](../decisions/0040-integration-installations-and-credential-storage.md) | 連携のインストールは `role:admin` のグループのモデルに持ち、秘密は持たない。秘密（トークン、Webhook の署名の鍵）はサーバーだけの表に、KMS の専用の鍵で包んだ暗号文で置き、連携の Worker のロールだけが復号する。GitHub のインストールのトークン（1 時間）はメモリーだけに持つ。外部への送信は宛先で経路を分け、顧客の指定するホスト（GitLab の自前のホスト）は egress の経路から送る |

## 1. 目的と範囲

- 扱う：
  - GitHub（github.com）と GitLab（gitlab.com、公開された自前のホスト）のインストール、Webhook の受信、PR・MR とイシューの結び付け、状態の自動化、PR への返しのコメント
  - 利用者の外部のアカウント（GitHub・GitLab・Slack）の結び付け
  - Slack のインストール、メッセージからイシューを作る、チャンネルへの通知、リンクの展開、個人への通知の送り口
  - 連携の資格情報の保管、外部への送信の経路、流量の制御
- 扱わない：
  - 個人への Slack の通知を「いつ・何を」送るか（[notifications-and-inbox.md](notifications-and-inbox.md) の 8.3 節）
  - 公開 API・OAuth のアプリ・Webhook の送信（[api-and-webhooks.md](api-and-webhooks.md)）
  - インポート（Jira・GitHub Issues など。[import-export.md](import-export.md)）
  - コミットの結び付け（push のイベント）、ブランチごとの自動化の規則、Slack のスレッドの双方向の同期、Slack の複数のワークスペース、Linear Asks に当たる外部の受付（MVP の後。12 節）

## 2. 本家の形と、外部の仕様（確かめたこと）

いずれも 2026-09-28 に確認。

### 2.1 本家（公式）

| 項目 | 内容 | 出典 |
| --- | --- | --- |
| GitHub の結び付け | ブランチ名にイシューの ID を入れる（コピーの操作がある）。PR のタイトルに ID、または本文に「閉じる語」と ID | [GitHub](https://linear.app/docs/github) |
| 閉じる語 | close・fix・resolve・complete・implement とその活用、`linear issue`。閉じない語は ref・refs・references・part of・contributes to・toward・towards。関連の語は relates to・related to。`skip`・`ignore` と ID で結び付けを止める | 同上 |
| 状態の自動化 | PR の下書き・作成・レビューの依頼・マージできる・マージで、チームの設定した状態へ移す。既定は作成で In Progress、マージで Done。「マージできる」はブランチの保護の設定が要る | 同上 |
| 複数の PR | 1 つのイシューに複数の PR があれば、最後の PR が条件に届いてから状態を変える | 同上 |
| インストール | GitHub の組織のオーナーが GitHub App を入れ、リポジトリを選ぶ。各メンバーは個人の GitHub のアカウントを結び付ける（作者の表示のため） | 同上 |
| GitLab | 個人のアクセストークン（`api` か `read_api`）。自前のホストは 15.6 以上で公開されたもの。Webhook の URL を GitLab のグループかプロジェクトに登録する（push・コメント・MR・パイプライン）。閉じる語と閉じない語は GitHub と同じ考え方。対象のブランチごとの規則を正規表現で書ける | [GitLab](https://linear.app/docs/gitlab) |
| Slack | メッセージからイシューを作る、スレッドの同期、チーム・プロジェクト・イニシアチブのチャンネルへの通知、個人の DM、リンクの展開。最初の接続は管理者が行う。複数の Slack のワークスペースは Enterprise | [Slack](https://linear.app/docs/slack) |
| 本文の語と非公開のチーム | PR のコメントの中の語では結ばない。非公開のチームのイシューは、PR に識別子とリンクだけを返す | [GitHub](https://linear.app/docs/github)、[Private teams](https://linear.app/docs/private-teams) |
| Triage | 連携から作られたイシューは Triage に入る | [Configuring workflows](https://linear.app/docs/configuring-workflows)（[issues-and-workflow.md](issues-and-workflow.md) の 2 節で確認済み） |

- 本家が閉じる語を大文字・小文字を区別せずに扱うか、本文のどこまでを見るかは**未検証**。この文書の規則（4.2 節）は本システムの決定である。
- 本家の Slack の連携が求めるスコープの一覧は、公式の文書で確かめられなかった（**未検証**）。本システムのスコープは、使う Slack の API の文書から決める（5.1 節）。

### 2.2 GitHub

| 項目 | 内容 | 出典 |
| --- | --- | --- |
| インストールのトークン | アプリの JWT で `POST /app/installations/{id}/access_tokens` を呼んで得る。1 時間で切れる。リポジトリ（500 まで）と権限を絞れる | [Generating an installation access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app) |
| 流量の上限 | インストールのトークンは 1 時間 5,000 回。リポジトリ・利用者が 20 を超えると 1 つにつき 50 回増え、12,500 回まで。Enterprise Cloud の組織は 15,000 回。同時の要求は 100 まで、REST は 1 分 900 点（読み 1 点、書き 5 点） | [Rate limits for the REST API](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) |
| Webhook の署名 | `X-Hub-Signature-256` に `sha256=` と HMAC-SHA256 の 16 進。比べは定数時間で | [Validating webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries) |
| Webhook の扱い | 10 秒以内に 2XX を返す。再送は自動でなく、手で求める。`X-GitHub-Delivery` で重複を見分ける（再送でも同じ値）。処理は背景のキューで | [Best practices for using webhooks](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks) |

### 2.3 GitLab

| 項目 | 内容 | 出典 |
| --- | --- | --- |
| 秘密 | 旧来の秘密のトークンは `X-Gitlab-Token` に平文で載る。署名の鍵を設定すると `webhook-signature` に `v1,<base64>` の HMAC-SHA256 が載る | [Webhooks](https://docs.gitlab.com/user/project/integrations/webhooks/) |
| 重複 | `webhook-id`（再送で同じ）、旧来の `Idempotency-Key`、`X-Gitlab-Event-UUID` | 同上 |
| 自動の停止 | 4 回続けて失敗すると一時停止（1 分から 24 時間まで伸びる）。40 回続けて失敗すると恒久に停止 | 同上 |

- GitLab.com の Webhook の時間切れは 10 秒（[GitLab.com settings](https://docs.gitlab.com/user/gitlab_com/)、2026-09-28 に確認。自前のホストは管理者が変えられる）。GitHub と同じく、受けたらすぐに返す。

### 2.4 Slack

| 項目 | 内容 | 出典 |
| --- | --- | --- |
| 要求の確かめ | `X-Slack-Signature` に `v0=` と、`v0:<時刻>:<本文>` の HMAC-SHA256。時刻が 5 分より離れたら捨てる | [Verifying requests from Slack](https://docs.slack.dev/authentication/verifying-requests-from-slack) |
| 操作への応答 | 3 秒以内に 200 を返す。`trigger_id` は 3 秒で切れ、1 回だけ使える。`response_url` は 30 分に 5 回まで | [Handling user interaction](https://docs.slack.dev/interactivity/handling-user-interaction) |
| トークンの入れ替え | 有効にするとアクセストークンは 12 時間で切れる。リフレッシュトークンは 1 回限りで、使うと少しの猶予の後に無効になる。一度有効にすると戻せない | [Using token rotation](https://docs.slack.dev/authentication/using-token-rotation) |
| 流量 | Web API は段（Tier 1〜4：1 分に 1・20・50・100 回以上）。`chat.postMessage` はチャンネルごとに 1 秒 1 回。超えると 429 と `Retry-After`。Events API は 1 ワークスペース・1 アプリで 1 時間 3 万件 | [Rate limits](https://docs.slack.dev/apis/web-api/rate-limits) |

## 3. 構成

```
 GitHub・GitLab・Slack
   │ Webhook・イベント・操作（HTTPS）
   ▼
 CloudFront＋WAF ─▶ Public API のタスクの受け口 `/hooks/*`（integrations-ingress）
   │ 1. 署名・時刻を確かめる（失敗は 401、記録は数だけ）
   │ 2. integration_events に保存（外部の配送 ID で一意。重複は 200 で捨てる）
   │ 3. SQS FIFO `integrations`（MessageGroupId = 対象の単位）へ。すぐに 2XX
   │    ただし Slack の操作（メッセージのショートカット）は、この場でモーダルを開く（3 秒）
   ▼
 連携の Worker（integrations-worker）
   │ 照合（4 節・7 節）→ Writer へトランザクション（origin = worker）
   │ 外部への返し（PR へのコメント、Slack への投稿）は送信の待ち行列から、流量の制御つきで
   ▼
 Writer ─▶ sync_actions ─▶ Relay ─▶ 差分（クライアント）
                              └─▶ SQS `integrations-out`（チャンネルへの通知、展開の更新）
```

- 受け口は Public API のタスクに置く（[infrastructure.md](infrastructure.md) の 3 節）。受け口の仕事は確かめと保存と投入だけにし、外部の API を呼ばない。例外は Slack のモーダルを開く 1 回の呼び出しである（`trigger_id` が 3 秒で切れるため）。
- `integration_events` を先に保存するので、Worker が落ちても、キューが失っても、保存から作り直せる。GitHub は自動で再送しない（2.2 節）ので、この保存が取りこぼしの唯一の備えである。
- 順序：同じ PR（MR）の事象は、FIFO の同じメッセージグループ（`gh:<installation>:<repo_id>:<number>`）で順に処理する。Slack の事象はチャンネルごと。
- 連携の Worker は、ワークスペースを 1 つずつのシステムのトランザクションで書く。Writer の流量の割り当て（[capacity.md](capacity.md) の 3 節、[ADR-0054](../decisions/0054-per-workspace-write-admission.md)）の `worker` の枠を使う。

## 4. GitHub・GitLab の結び付け

ADR-0038。

### 4.1 インストール

| 手段 | 手順 | 保存するもの |
| --- | --- | --- |
| GitHub | 管理者が設定の画面で「GitHub を接続」→ GitHub の App のインストールの画面（組織のオーナーが承認し、リポジトリを選ぶ）→ 戻りの URL に `installation_id` と `state`。`state` はワークスペースと管理者のセッションに結んだ 10 分・1 回限りの値。本システムはアプリの JWT で `GET /app/installations/{id}` を呼び、存在と組織を確かめる | `IntegrationInstallation`（`provider = github`、組織の ID と名前、選んだリポジトリの数）。秘密は持たない（アプリの秘密鍵はプラットフォームの 1 つ） |
| GitLab | 管理者がホスト（`https://gitlab.com` か自前のホスト）とトークン（グループかプロジェクトのトークン。`api` の範囲、Reporter 以上）を入れる。本システムは egress の経路からトークンで `GET /api/v4/user`（か `/groups/:id`）を呼んで確かめ、Webhook の URL（インストールごと）と署名の鍵を画面に 1 回だけ示す。管理者が GitLab に登録する | `IntegrationInstallation`（`provider = gitlab`、ホスト）。トークンと署名の鍵は `integration_secrets`（6 節） |

- 1 つのワークスペースに、GitHub の組織・GitLab のグループを複数つなげる。1 つの GitHub の組織を複数のワークスペースにつなぐことは許す（イベントを各ワークスペースへ配る）。
- インストールの作成・削除は `can(actor, "manage_integration", workspace)`（`owner`・`admin`。[permissions-and-teams.md](permissions-and-teams.md) の 4.4 節の DT-PERM-002 の行 13）。

### 4.2 結び付けの規則

DT-INT-001。PR（MR）の作成・タイトルの変更・本文の変更・ブランチ名のたびに、全部の源をもう一度読んで、結び付けの集合を作り直す（差分で足し引きしない）。

| # | 源 | 見つけ方 | 結び付けの種類 |
| --- | --- | --- | --- |
| 1 | 本文・タイトルの `skip`・`ignore` と識別子 | 語の直後の識別子 | その識別子を結ばない（他の行より強い） |
| 2 | ブランチ名 | 区切り（`/`・`-`・`_`）の間の識別子。`eng-123-fix-login` も `feature/ENG-123` も可 | 閉じる |
| 3 | タイトル | 語の境界の識別子 | 閉じる |
| 4 | 本文の閉じる語 | 閉じる語の後の、`,`・`and`・空白で並んだ識別子の列 | 閉じる |
| 5 | 本文の閉じない語・関連の語 | 同上 | 閉じない（状態を動かさない） |
| 6 | 本文の識別子だけ（語なし） | — | 結ばない（誤りの結び付けを避ける） |

- 識別子の形は `([A-Za-z][A-Za-z0-9]{0,6})-([0-9]{1,9})`。大文字・小文字を区別しない。チームの識別子の規則（[data-model-and-schema.md](data-model-and-schema.md) の 5.2 節）と同じ長さにする。
- 語の一覧は本家と同じ語（2.1 節）にする。ただし本家の `linear issue` は本家の名前を含むので、`<brand> issue` に替える（[リポジトリ共通の ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。日本語の書き方は足さない（開発者が英語で書く前提。足すかは E10 の試用で決める）。コードの塊（`` ` `` の中、```` ``` ```` の中）と引用（`>`）の中は見ない。
- 識別子は、そのワークスペースの `resolve(key, number)` で引く（今の識別子、チームの古い識別子、イシューの別名。[data-model-and-schema.md](data-model-and-schema.md) の 5.4 節）。引けないものは捨てる（存在を明かさないので、PR に「見つからない」とも書かない）。
- 1 つの PR が結ぶイシューは 50 まで。超えた分は捨て、PR に返しのコメントで知らせる。
- 同じ組織が複数のワークスペースにつながるとき、識別子は各ワークスペースで別々に引く。同じ `ENG-123` が 2 つのワークスペースで引ければ、両方に結ぶ（チームの識別子はワークスペースの中でだけ一意）。

### 4.3 結び付けのモデル

```ts
model("GitLink", {
  groups: { rule: "via", from: "issue_id" },          // イシューと同じグループ
  load: { strategy: "lazy" }, delete: { mode: "hard" },
  fields: {
    issue_id:        { type: "ref:Issue", conflict: "server_only", on_delete: "cascade", index: true },
    installation_id: { type: "ref:IntegrationInstallation", conflict: "server_only", on_delete: "cascade", api: "internal" },
    provider:        { type: "enum<github,gitlab>", conflict: "server_only" },
    kind:            { type: "enum<pull_request,merge_request>", conflict: "server_only" },
    repo:            { type: "string", conflict: "server_only", max: 256 },          // owner/name
    number:          { type: "int", conflict: "server_only" },
    url:             { type: "string", conflict: "server_only", max: 1024 },
    title:           { type: "string", conflict: "server_only", max: 512, pii: "content" },
    branch:          { type: "string", conflict: "server_only", max: 256, pii: "content" },
    pr_state:        { type: "enum<draft,open,review_requested,merged,closed>", conflict: "server_only" },
    closes:          { type: "bool", conflict: "server_only" },
    author_user_id:  { type: "ref:User", conflict: "server_only", nullable: true, on_delete: "nullify" },
    author_login:    { type: "string", conflict: "server_only", max: 128, pii: "identity" },
  },
});
```

- 行はイシューと同じグループに入る。非公開のチームのイシューの PR の行は、そのチームのメンバーにだけ届く。
- `(issue_id, provider, repo, number)` で一意。PR の事象を受けるたびに、Worker が `set` で最新の値に揃える。
- イシューに `include` として `GitLink:issue_id` を足す（被覆の鍵。[data-model-and-schema.md](data-model-and-schema.md) の 3.1 節に反映済み）。

### 4.4 状態の自動化

チームの設定（`Team` に足すフィールド）：

| 設定 | 既定 | 意味 |
| --- | --- | --- |
| `git_on_draft` | なし | 下書きの PR が結ばれたとき |
| `git_on_open` | 最初の `started` の状態 | PR が開いたとき |
| `git_on_review` | なし | レビューを依頼したとき |
| `git_on_merge` | 最初の `completed` の状態 | 閉じる PR がマージされたとき |
| `git_link_comment` | 真 | PR に返しのコメントを書くか |

DT-INT-002。1 つのイシューについて、閉じる結び付け（`closes = true`）の PR の状態の集合から、行き先を決める。上から評価し、最初に当たった行。

| # | 条件 | 行き先 |
| --- | --- | --- |
| 1 | イシューがゴミ箱・`duplicate` の種類 | 動かさない |
| 2 | 閉じる PR が 1 つもない | 動かさない |
| 3 | 閉じる PR がすべて `merged` か `closed` で、`merged` が 1 つ以上 | `git_on_merge` |
| 4 | 閉じる PR に `review_requested` が 1 つ以上 | `git_on_review`（なければ `git_on_open`） |
| 5 | 閉じる PR に `open` が 1 つ以上 | `git_on_open` |
| 6 | 閉じる PR がすべて `draft` | `git_on_draft` |
| 7 | それ以外（すべて `closed` でマージなし） | 動かさない |

- **前へだけ進める。** 行き先の種類が、今の状態の種類より前（`triage` < `backlog` < `unstarted` < `started` < `completed`）なら動かさない。`canceled` のイシューは動かさない。人が Done から戻したイシューを、PR の次の事象で Done へ戻すことはある（行 3 は前へ進む）。これは本家の「PR の状態で進める」振る舞いに合わせた本システムの決定。
- 設定が「なし」の行き先は、動かさない。
- 複数の PR：行 3 は「閉じる PR が全部終わってから」を表す（本家と同じ）。
- 閉じない結び付けは、行を残すだけで状態を動かさない。

**書き込みの主体**（DT-INT-003）：

| # | イシューのチーム | PR の作者 | `actor` | 状態を動かすか |
| --- | --- | --- | --- | --- |
| 1 | 公開 | 結び付けた `User` があり `active` | その `User` | 動かす |
| 2 | 公開 | 結び付けた `User` がない | `system` | 動かす |
| 3 | 非公開 | 結び付けた `User` があり、`can(user, "update", issue)` が真 | その `User` | 動かす |
| 4 | 非公開 | それ以外 | `system` | **結び付けの行だけを書き、状態を動かさない** |

- 行 4 の理由：GitHub の組織の誰でも、PR のタイトルに識別子を書ける。非公開のチームのメンバーでない人が、そのチームのイシューの状態を動かせるのは、ADR-0004 の分離に反する。行を書くのは、チームのメンバーが結び付きを見られるようにするため（行はチームのグループにしか届かない）。
- トランザクションは `origin = worker`。`IssueHistory` に `{k: "auto", rule: "git", url}` を残す（[issues-and-workflow.md](issues-and-workflow.md) の 11 節）。状態の時刻・自動のアーカイブの解除などの派生は、普通の状態の変更と同じ（ADR-0025）。
- 同じイシューへの人の変更と競合したら、確定の順の LWW（ADR-0002）。上書きの記録は人の変更と同じに残る。

### 4.5 PR への返しのコメント

- PR に結んだイシューがあるとき、1 つのコメントを書き、結び付けが変わるたびに同じコメントを書き換える。
- 中身は識別子と URL だけにする。**タイトル・状態・担当を書かない。** GitHub のリポジトリを読める人と、ワークスペースの中でそのイシューを読める人は一致しない。
- `git_link_comment` が偽のチームのイシューは載せない。載せるイシューが 0 件ならコメントを消す。

### 4.6 利用者の外部のアカウント

- 利用者は設定から GitHub・GitLab・Slack のアカウントを結ぶ。GitHub は GitHub App の利用者の認可（OAuth）で、GitLab は gitlab.com の OAuth で、本人の外部の ID とログイン名を得る。得た利用者のトークンは、ID を読んだらすぐに捨てる（保存しない）。
- `ExternalAccountLink`（`user:<id>` のグループ）に `(provider, host, external_id, login)` を持つ。1 つの外部の ID は、1 つのワークスペースで 1 人の `User` にだけ結ぶ。
- 自前の GitLab のホストの OAuth は MVP では持たない。自前のホストの作者は `author_login` だけを表示する。

## 5. Slack

ADR-0039。

### 5.1 インストール

- 管理者が「Slack を接続」→ Slack の OAuth v2（ボットのスコープ）→ 戻りで `state` を確かめ、`oauth.v2.access` でボットのトークンとリフレッシュトークンを得る。
- ボットのスコープ：`commands`（メッセージのショートカット）、`chat:write`（投稿）、`im:write`（`conversations.open` で DM を開く）、`links:read`（`link_shared` のイベント）、`links:write`（`chat.unfurl`）、`channels:read`・`groups:read`（`conversations.info` でチャンネルの `is_ext_shared` を読む。非公開のチャンネルには `groups:read` が要る）、`users:read`。メソッドごとの要るスコープは Slack の文書で確かめた（[conversations.open](https://docs.slack.dev/reference/methods/conversations.open)、[chat.unfurl](https://docs.slack.dev/reference/methods/chat.unfurl)、[conversations.info](https://docs.slack.dev/reference/methods/conversations.info)、2026-09-28 に確認）。`channels:history` などメッセージの履歴を読むスコープは求めない（ショートカットの操作の中身だけを使う）。
- トークンの入れ替えを有効にする（2.4 節）。有効にすると戻せないので、E10 の着手の時に dev のアプリで確かめてから本番のアプリで有効にする。
- 1 つのワークスペースに 1 つの Slack のワークスペース（MVP）。複数は MVP の後。
- アンインストール・トークンの取り消しのイベント（`app_uninstalled`、`tokens_revoked`）で、インストールを `revoked` にし、秘密を消す。

### 5.2 メッセージからイシューを作る

```
Slack の利用者：メッセージのショートカット「イシューを作る」
  ▼ 受け口（3 秒）
  署名を確かめる → Slack の利用者 → ExternalAccountLink → User
  ├─ 結び付けがない：「先にアカウントを結んでください」の案内（結ぶリンク）をモーダルで返す
  └─ ある：views.open（trigger_id）で入力のモーダル。チームの候補は、その User が書けるチームだけ
  ▼ 送信（view_submission、3 秒で 200）
  integration_events に保存 → SQS
  ▼ Worker
  Writer：create Issue（actor = その User、origin = worker）＋ create Attachment 相当の外部リンク（メッセージの permalink）
  ▼
  スレッドへ返信：識別子と URL だけ。チームが非公開なら、本人だけに見える ephemeral の返信
```

- 状態は Triage の入り口の決定表（DT-ISSUE-002 の行 4）で決まる。Triage が有効なチームは Triage に入る（本家と同じ）。
- 本文の既定は、元のメッセージの文字列（Slack の mrkdwn を平文にしたもの）と permalink。利用者はモーダルで直せる。添付のファイルは取り込まない（Slack のファイルを読むスコープを求めない）。
- 結び付けのない Slack の利用者（Slack のゲスト、ワークスペースにいない人）は作れない。外部からの受付は MVP の後（Asks に相当）。
- モーダルを開く呼び出しに、ボットのトークンの復号が要る。受け口はトークンを 5 分だけメモリーに持つ（6.3 節）。

### 5.3 チャンネルへの通知

- `SlackChannelSubscription`（`role:admin` のグループ）：チームかプロジェクト、チャンネルの ID、事象の種類（作成、状態の変更、コメント、プロジェクトの更新）。作れるのは `owner`・`admin` とそのチームのメンバー（ゲストを除く）。
- **対象は公開のチームと、公開のチームだけにつながるプロジェクトに限る**（MVP）。非公開のチームは作れない。プロジェクトに非公開のチームがつながったら、その購読を止め、作った人に知らせる。
  - 理由：Slack のチャンネルのメンバーは、ワークスペースのメンバーと一致しない。非公開のチームの中身を、チームのメンバーでない人が読める場所へ出すことになる。本家は非公開のチームにも通知を置けるが（**未検証**）、ADR-0004 の分離を優先する。
- 送り：Relay が `integrations-out` に、対象の事象（`sync_actions` の種類と `changed`）を流す。Worker は送る直前に、行を Aurora から読み直し、チームがまだ公開かを確かめる（通知の送る時の確かめと同じ考え方。ADR-0037）。
- 中身：識別子、タイトル、状態、担当、行為者の名前、URL。コメントは 200 字の抜粋。本文は載せない。
- 流量：チャンネルごとに 1 秒 1 件（2.4 節）。同じチャンネルへの 10 秒の中の事象は 1 つのメッセージにまとめる。429 は `Retry-After` に従う。

### 5.4 リンクの展開

- `link_shared` のイベントで、URL が本システムのイシュー・プロジェクトなら、`chat.unfurl` で展開する。
- **公開のチームのイシュー（と公開のチームだけのプロジェクト）だけを展開する。** それ以外は何もしない（「非公開」とも書かない。存在を明かさない）。
- 展開の中身：識別子、タイトル、状態、優先度、担当。本文を載せない。
- ワークスペースの設定で展開を止められる（既定は有効）。Slack Connect の共有のチャンネルでは展開しない（`conversations.info` のチャンネルの `is_ext_shared` を見る。「別の組織と共有したチャンネル」を表す。[The conversation object](https://docs.slack.dev/reference/objects/conversation-object)、2026-09-28 に確認）。

### 5.5 個人への通知の口

- 送る条件・まとめ方・中身は [notifications-and-inbox.md](notifications-and-inbox.md) の 8.3 節。この領域は、`ExternalAccountLink` から Slack の利用者の ID を引き、`conversations.open`（`im:write`）と `chat.postMessage` で送る口を持つ。
- 送る直前に、結び付けとインストールが有効かを確かめる。無効なら送りを落とし、送りの記録に理由を残す。

### 5.6 スレッドの同期（MVP の後）

- 本家のスレッドの双方向の同期（Slack のスレッドの返信をコメントにし、コメントを Slack に返す）は、MVP の後にする。
- 理由：Slack のメッセージの履歴を読むスコープが要り、Slack の側の人（ワークスペースにいない人）の書いた中身をイシューに取り込む扱いが、法務の L1・L2 に関わる。MVP は作成の時の permalink と返信だけにする。
- [architecture/README.md](README.md) の 1.1・7 節も、統合の工程で「スレッドの同期は MVP の後」に揃えた。

## 6. 資格情報の保管

ADR-0040。

### 6.1 置き場所

| 秘密 | 置き場所 | 復号できる主体 |
| --- | --- | --- |
| GitHub App の秘密鍵（JWT の署名）、Webhook の秘密 | Secrets Manager（プラットフォームで 1 つ） | 連携の Worker、受け口（Webhook の秘密だけ） |
| Slack の署名の秘密、クライアントの秘密 | Secrets Manager | 受け口、連携の Worker |
| Slack のボットのトークン・リフレッシュトークン | `integration_secrets`（暗号文） | 連携の Worker、受け口（ボットのトークンだけ） |
| GitLab のトークン、GitLab の Webhook の署名の鍵 | `integration_secrets`（暗号文） | 連携の Worker、受け口（署名の鍵だけ） |
| GitHub のインストールのトークン（1 時間） | 連携の Worker のメモリーだけ | — |

```sql
CREATE TABLE integration_secrets (          -- サーバーだけ。モデルにしない（差分に載らない）
  workspace_id     uuid   NOT NULL,
  installation_id  uuid   NOT NULL,
  kind             text   NOT NULL,         -- 'slack_bot'、'slack_refresh'、'gitlab_token'、'gitlab_hook_key'
  ciphertext       bytea  NOT NULL,         -- AES-256-GCM。AAD = workspace_id‖installation_id‖kind
  dek_ciphertext   bytea  NOT NULL,         -- KMS `<brand>-integration-secrets` で包んだ DEK
  expires_at       timestamptz,
  rotated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, installation_id, kind)
);
```

- RLS の対象（ワークスペースの表）。読めるのは DB のロール `integrations` だけ。Writer・Sync API・Public API のロールには `SELECT` を与えない。
- KMS の鍵のポリシーで、`kms:Decrypt` を連携の Worker と受け口のタスクのロールに限る（[security.md](security.md) の 5 節）。
- 秘密をログ・トレース・エラーの報告に出さない。`kind` と `installation_id` だけを書く。

### 6.2 秘密を画面に出さない

- GitLab のトークンは、入れた後に画面に出さない（末尾 4 文字だけ）。Webhook の署名の鍵は作った時に 1 回だけ示し、後は作り直しだけができる。
- `IntegrationInstallation` のモデル（差分で管理者に届く）には、秘密も、秘密のハッシュも入れない。

### 6.3 トークンの更新

- GitHub：インストールのトークンを、リポジトリの権限を絞らずに（アプリの権限の全部で）求め、50 分使う。
- Slack：アクセストークンの期限の 1 時間前に更新する。リフレッシュトークンは 1 回限りなので、インストールの行の DB のロック（`SELECT … FOR UPDATE`）の中で 1 つの Worker だけが更新する。更新に失敗したら 3 回まで再試行し、だめならインストールを `needs_reauth` にして管理者に知らせる。
- 受け口のボットのトークンの写しは 5 分で捨てる。更新の後の古いトークンで失敗したら、読み直して 1 回だけやり直す。

### 6.4 外部への送信の経路

| 宛先 | 経路 |
| --- | --- |
| `api.github.com`、`gitlab.com`、`slack.com` | private のサブネット → NAT → Network Firewall（宛先の許可リスト） |
| 自前の GitLab のホスト（顧客の指定） | egress のサブネットの `worker-egress` → 専用の NAT。本体の DB・VPC エンドポイントへの経路を持たない（[infrastructure.md](infrastructure.md) の 2 節） |

- 自前のホストは、名前解決の後の IP が私的・予約の範囲なら送らない。リダイレクトを追わない。`https` だけ。Webhook の送信（[api-and-webhooks.md](api-and-webhooks.md) の 5 節）と同じ検査の部品を使う。

## 7. 流量の制御と取りこぼし

| 相手 | 制御 |
| --- | --- |
| GitHub（インストールごと） | 1 時間の残りを応答のヘッダーで見て、20% を切ったら読み直しの仕事（7.2 節）を止める。同時の要求は 1 インストールで 10 まで |
| Slack（インストールごと） | チャンネルごとに 1 秒 1 件、Web API の段ごとのトークンバケット。429 は `Retry-After` |
| GitLab（インストールごと） | 同時 5 まで。429 は `Retry-After` |
| Writer | ワークスペースの `worker` の枠（ADR-0054） |

### 7.1 取りこぼしへの備え

- GitHub は自動で再送しない（2.2 節）。本システムの受け口が落ちていた間の事象は、次の 2 つで取り戻す。
  - GitHub の「アプリの配送の一覧」から、失敗した配送を再送させる（受け口の復旧の後に Worker が行う）。`GET /app/hook/deliveries` で一覧を読み、`POST /app/hook/deliveries/{delivery_id}/attempts` で再送させる（[REST API endpoints for GitHub App webhooks](https://docs.github.com/en/rest/apps/webhooks)、2026-09-28 に確認）。
  - 7.2 節の読み直し。

### 7.2 読み直し

- 1 時間に 1 回、結び付けのある開いた PR（`GitLink.pr_state` が `draft`・`open`・`review_requested`）を、インストールごとに API で読み直し、状態が違えば事象として処理する。
- DR の切り替えの後（[runbooks/disaster-recovery.md](../runbooks/disaster-recovery.md)）は、失った範囲の時刻から後に更新された PR を読み直す。

## 8. 障害のときの振る舞い

| 事象 | 起きること | 備え |
| --- | --- | --- |
| 受け口が落ちた | GitHub の事象を失う。Slack の操作が失敗と表示される | 7.1 節の再送と読み直し。Slack は利用者がやり直す |
| Worker が遅れる・落ちる | 状態の自動化が遅れる | `integration_events` と SQS に残る。戻れば続きから |
| GitHub の障害 | 返しのコメントが書けない | 指数の待ちで 24 時間まで再試行。その後は捨てる（次の事象で書き直す） |
| Slack のトークンの更新に失敗 | 通知・展開が止まる | `needs_reauth` と管理者への知らせ |
| 同じ PR の事象の順が乱れた | 古い状態で上書き | FIFO のグループ。加えて、事象の中の `updated_at` が保存済みより古ければ捨てる |
| 誤った結び付けで大量のイシューが動いた | 意図しない Done | `IssueHistory` の `{k: "auto", rule: "git"}` から逆の操作を当てる（issues-and-workflow の runbook `mass-auto-close-rollback.md` と同じ手順） |

## 9. セキュリティ

- **受けたものを信じない。** 署名（GitHub・GitLab・Slack）を定数時間で比べ、時刻（Slack は 5 分）と重複（配送の ID）を確かめる。確かめに失敗した要求は本文を保存しない。
- **非公開のチームへの経路**：状態の自動化（DT-INT-003 の行 4）、チャンネルへの通知と展開（公開だけ）、PR への返しのコメント（識別子と URL だけ）。どれも `packages/policy` の `can()` で判定し、`visibility ===` を連携のコードに書かない（[permissions-and-teams.md](permissions-and-teams.md) の 9 節）。
- **外部へ出す中身を最小にする**：PR には識別子と URL、Slack には公開のチームのタイトル・状態・担当・短い抜粋。本文は出さない。
- **秘密**：6 節。インストールのトークンは保存しない。利用者の OAuth のトークンは ID を読んだら捨てる。
- **SSRF**：自前の GitLab のホストへの送信は egress の経路（6.4 節）。
- **テストのデータ**：本物の GitHub・GitLab・Slack のトークンと、実在の会社のリポジトリの名前を使わない（AGENTS.md）。署名の検査は、テストの鍵で作った事象で行う。
- **法務**：GitHub・GitLab・Slack へイシューの識別子・タイトル・抜粋を渡すことは、法務の L1（外国にある第三者への提供）の対象になりうる。**E10 の GitHub・GitLab・Slack の連携の spec は、L1 の結論まで承認しない**（[intent.md](../intent.md)）。

## 10. テスト

- 表駆動テスト：DT-INT-001（結び付けの源と語。語の活用、`skip`、コードの塊の中、別名での引き当て）、DT-INT-002（行き先）、DT-INT-003（主体と非公開のチーム）の全行。
- 性質ベーステスト：
  - **PROP-INT-001（順序によらない）**：同じ PR の事象の任意の並び替え・重複の後、`GitLink` とイシューの状態は、事象を時刻の順に 1 回ずつ当てた結果と同じ。
  - **PROP-INT-002（非公開を動かさない）**：任意の PR・作者・チームの組で、非公開のチームのイシューの状態が動くのは、作者が結び付いた利用者でそのイシューを書ける時だけ。
  - **PROP-INT-003（外へ出さない）**：任意の事象の列で、PR のコメントの本文にタイトルが入らず、Slack へ送る中身が、送る時点で公開のチームの行だけから作られる。
  - **PROP-INT-004（前へだけ）**：任意の PR の事象の列で、自動化の書き込みが状態の種類を前へしか動かさない（DT-INT-002 の行 3 を除く人の戻しの後）。
- 結合テスト：署名の検査（正しい・誤り・古い時刻・重複）、受け口から Writer までの流れ（Testcontainers、SQS の模擬）、Slack の 3 秒の応答（受け口の p99）。
- 契約のテスト：GitHub・GitLab・Slack の事象の本文の例（公開の文書の例から合成したもの）を固定し、解析の結果を比べる。本物の相手を CI で呼ばない。
- E2E（staging）：テスト用の GitHub の組織・GitLab のグループ・Slack のワークスペース（本物のデータを置かない）で、PR の作成からマージまでと、メッセージからの作成を流す。

## 11. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E10 | `integrations-ingress` | 3 節の受け口、署名の検査、`integration_events`、FIFO への投入 |
| E10 | `integration-credentials` | 6 節の `integration_secrets`、KMS の鍵、トークンの更新 |
| E10 | `github-app-install` | 4.1 節の GitHub のインストールと確かめ |
| E10 | `gitlab-install` | 4.1 節の GitLab のトークンと Webhook の署名の鍵、egress の経路 |
| E10 | `git-link-parser` | 4.2 節の DT-INT-001 と `resolve` |
| E10 | `git-link-model` | 4.3 節の `GitLink` と被覆の鍵 |
| E10 | `git-state-automation` | 4.4 節の設定、DT-INT-002・003、履歴 |
| E10 | `git-link-comment` | 4.5 節の返しのコメント |
| E10 | `external-account-link` | 4.6 節の外部のアカウントの結び付け |
| E10 | `git-resync` | 7 節の再送と読み直し |
| E10 | `slack-install` | 5.1 節のインストールとトークンの入れ替え |
| E10 | `slack-create-issue` | 5.2 節のショートカット、モーダル、作成、返信。**法務の L1 の後に承認** |
| E10 | `slack-channel-notifications` | 5.3 節。**法務の L1 の後に承認** |
| E10 | `slack-unfurl` | 5.4 節。**法務の L1 の後に承認** |
| E10 | `slack-personal-notifications` | 5.5 節（notifications-and-inbox の同名の Story と 1 つ）。**法務の L1 の後に承認** |

## 12. 未解決の問い

- GitHub の受け方を GitHub App にするか、OAuth のアプリと利用者のトークンにするか。
- GitLab の受け方（顧客のトークン、自前のホスト）。
- 結び付けの源（本文の識別子だけを結ぶか）。
- 状態の自動化で、人が戻した状態を PR が進め直すか。複数の PR の扱い。
- 非公開のチームのイシューを、PR の作者が誰でも動かせるか。
- Slack の通知を非公開のチームに許すか。スレッドの同期を MVP に入れるか。
- 資格情報の置き場所。

### 決定

2026-09-28 の既定案。E10 の着手と試用で覆りうる。

- **GitHub**：GitHub App（ADR-0038）。組織の単位で入れ、リポジトリを選べ、トークンが 1 時間で切れる。OAuth のアプリの利用者のトークンは、利用者が抜けると使えなくなる。
- **GitLab**：顧客のグループ・プロジェクトのトークンと、インストールごとの Webhook の署名の鍵（ADR-0038）。本家と同じ形。
- **結び付けの源**：ブランチ名・タイトル・本文の語。語のない本文の識別子は結ばない（ADR-0038）。
- **自動化**：前へだけ。複数の PR は全部が終わってから（ADR-0038）。
- **非公開のチーム**：結び付いた利用者で書ける時だけ動かす（ADR-0038）。
- **Slack**：公開のチームだけ。スレッドの同期は MVP の後（ADR-0039）。
- **資格情報**：Aurora の暗号文と KMS の専用の鍵、インストールのトークンはメモリーだけ（ADR-0040）。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| コミットの結び付け（push） | MVP の後。本家は組織の Webhook の追加の設定で行う（2.1 節） |
| 対象のブランチごとの規則、「マージできる」の状態 | MVP の後。ブランチの保護の API の読みが要る |
| Slack のスコープの最終の一覧、Slack Connect の判定のフィールド | E10 の着手の時に Slack の文書で確かめる |
| GitHub の失敗した配送の再送の API の形 | E10 |
| 閉じる語に日本語を足すか | E10 の試用 |
| Slack の複数のワークスペース、非公開のチームのチャンネルへの通知 | MVP の後。チャンネルのメンバーとチームのメンバーを照らす仕組みが要る |

## 13. quality.md・runbooks・data-model への項目

### quality.md

- DT-INT-001〜003 の表駆動テストと PROP-INT-001〜004 を E10 のリリースの基準にする。PROP-INT-002・003 は NFR-008 の試験の一部にする。
- 本番：受け口の署名の失敗の数（連携ごと）、受けてから Writer の確定までの p95（目標 10 秒）、`integration_events` の未処理の最古の年齢。
- 本番：結び付けの作り直しで、閉じる結び付けが外れた数（誤りの結び付けの目安）。
- 本番：Slack の 3 秒の応答の失敗の数、トークンの更新の失敗、`needs_reauth` のインストールの数。
- 本番：PR の読み直し（7.2 節）で見つかった取りこぼしの数。0 でなければ受け口の取りこぼしを疑う。

### runbooks

- `integration-ingress-outage.md`：受け口の障害の後の、GitHub の配送の再送と読み直しの手順。
- `integration-token-failure.md`：Slack のトークンの更新の失敗、GitLab のトークンの失効が続くときの確かめ方と、管理者への連絡。
- `git-automation-misfire.md`：誤った結び付けで大量のイシューが動いたときの止め方（チームの `git_on_*` の一時の無効、ワークスペースの連携の停止のフラグ）と戻し方。
- `integration-secret-leak.md`：連携の秘密の漏えいの疑い（GitHub App の秘密鍵の作り直し、Slack の秘密の入れ替え、顧客への GitLab のトークンの作り直しの依頼）。

### data-model（索引への追加の提案）

| 表・モデル | 中身 | 節 |
| --- | --- | --- |
| `integration_installations`（`IntegrationInstallation`） | 連携のインストール（`role:admin`）。秘密を持たない | 4.1、5.1 |
| `integration_secrets`（サーバーだけ） | 暗号文のトークンと署名の鍵 | 6.1 |
| `integration_events`（サーバーだけ） | 受けた事象（配送の ID で一意、30 日） | 3 |
| `git_links`（`GitLink`） | PR・MR とイシューの結び付け | 4.3 |
| `external_account_links`（`ExternalAccountLink`） | 利用者の外部のアカウント | 4.6 |
| `slack_channel_subscriptions`（`SlackChannelSubscription`） | チャンネルへの通知の購読 | 5.3 |
| `teams` に足す列 | `git_on_draft`・`git_on_open`・`git_on_review`・`git_on_merge`・`git_link_comment` | 4.4 |
| data-model-and-schema への依頼（反映済み。[data-model.md](data-model.md) の 9 節） | `Issue.include` に `GitLink:issue_id` を足す | 4.3 |
| permissions-and-teams への依頼（反映済み。[data-model.md](data-model.md) の 9 節） | DT-PERM-002 に「連携の作成・削除（`owner`・`admin`）」、DT-PERM-003 に `SlackChannelSubscription` の規則 | 4.1、5.3 |

## 出典

いずれも 2026-09-28 に確認。

- Linear Docs, [GitHub](https://linear.app/docs/github)、[GitLab](https://linear.app/docs/gitlab)、[Slack](https://linear.app/docs/slack)
- GitHub Docs, [Generating an installation access token for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)、[Rate limits for the REST API](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)、[Validating webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)、[Best practices for using webhooks](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks)
- GitLab Docs, [Webhooks](https://docs.gitlab.com/user/project/integrations/webhooks/)
- Slack Developer Docs, [Verifying requests from Slack](https://docs.slack.dev/authentication/verifying-requests-from-slack)、[Handling user interaction](https://docs.slack.dev/interactivity/handling-user-interaction)、[Using token rotation](https://docs.slack.dev/authentication/using-token-rotation)、[Rate limits](https://docs.slack.dev/apis/web-api/rate-limits)

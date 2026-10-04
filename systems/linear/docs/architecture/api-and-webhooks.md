# API and Webhooks: Linear

公開の GraphQL の API、API キーと OAuth 2.0 のアプリ、Webhook の送信を決める。スキーマの生成、ページング、アーカイブを含める読み方、フィルター、読み出しの権限、書き込みを Writer に通す方法、複雑さとレート制限、トークンの形と保存、Webhook の対象・中身・署名（`<Brand>-Signature`）・再試行・停止を扱う。

前提となる決定は、Writer と冪等性（[ADR-0006](../decisions/0006-transactions-writer-and-idempotency.md)）、差分の形（[ADR-0007](../decisions/0007-sync-actions-and-range-proof-deltas.md)）、定義の言語と生成（[ADR-0019](../decisions/0019-schema-definition-and-codegen.md)）、本文の CRDT（[ADR-0021](../decisions/0021-description-crdt-yjs-in-sync-log.md)）、フィルターの言語（[ADR-0028](../decisions/0028-filter-language-and-shared-evaluation.md)）、サーバーの問い合わせ（[ADR-0029](../decisions/0029-view-coverage-planner-and-server-query.md)）、検索の権限（[ADR-0031](../decisions/0031-search-permission-by-sync-groups.md)）、権限の関数（[ADR-0032](../decisions/0032-single-policy-module-and-group-mapping.md)）、1 ワークスペースの書き込みの割り当て（[ADR-0054](../decisions/0054-per-workspace-write-admission.md)）。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0041](../decisions/0041-public-graphql-generated-schema-and-writer-mutations.md) | 公開の GraphQL のスキーマは、モデルの定義の `api: public` から型を生成し、問い合わせの入口と mutation は手で書く。読み出しは reader で RLS と同期グループの重なり（`sync_groups && 主体の groups`）で絞り、mutation は 1 つずつ Writer のトランザクション（`origin = api`）にする。複雑さは実行の前に静かに数え（属性 0.1、オブジェクト 1、接続は `first` 倍）、1 回 10,000 点まで。要求の数と点の数を主体ごとに 1 時間の枠で数え、超えたら 429 |
| [0042](../decisions/0042-api-keys-oauth-apps-and-token-format.md) | API キーはワークスペースの 1 人の `User` に結び、範囲（scope）とチームで絞り、期限は 1 年まで。OAuth のアプリは認可コードと PKCE（S256 を必須）で、アクセストークン 24 時間、リフレッシュトークンは使うたびに入れ替え、再利用で一式を取り消す。トークンは `<brand>_` の接頭辞とチェックサムの形で、SHA-256 だけを保存する。権限は `can()` と範囲の積 |
| [0043](../decisions/0043-signed-webhooks-from-sync-log.md) | Webhook は `sync_actions` から Relay 経由で作り、作った管理者の権限で送る時に絞る。本文は変更後の公開のフィールドと `updatedFrom`、`syncId`。署名は `<Brand>-Signature: t=<ミリ秒>,v1=<HMAC-SHA256(秘密, t.本文)>`。5 秒で時間切れ、1 分・1 時間・6 時間で再試行、24 時間失敗し続けたら止めて管理者に知らせる。送信は egress の経路から |

## 1. 目的と範囲

- 扱う：
  - 公開の GraphQL（`https://api.<brand>.<domain>/graphql`）のスキーマ、読み出し、mutation、ページング、エラー、廃止の進め方
  - 複雑さとレート制限
  - API キー、OAuth 2.0 のアプリ、トークンの形と保存、取り消し
  - Webhook の対象、中身、署名、送信、再試行、停止、送信の記録
- 扱わない：
  - `can()` の決定表の本体（[permissions-and-teams.md](permissions-and-teams.md)）。この文書は、API キー・OAuth の範囲を重ねる規則だけを足す
  - フィルターの文法（[views-and-filters.md](views-and-filters.md)）。この文書は GraphQL の入力の型への写し方だけを書く
  - 検索の関数（[search.md](search.md)）
  - 連携の Webhook の受信（[integrations.md](integrations.md)）
  - 公式の SDK（開発リポジトリで生成する。E11 の Story）
  - OAuth のアプリの `actor=app`（アプリ自身を主体にする）と client credentials、公開のアプリの一覧（MVP の後）

## 2. 本家の形（確かめたこと）

いずれも 2026-09-28 に確認。

| 項目 | 内容 | 出典 |
| --- | --- | --- |
| 入口 | `https://api.linear.app/graphql`。API キーは `Authorization: <API_KEY>`、OAuth は `Authorization: Bearer <token>`。introspection を許す。エラーは `errors` の配列で、一部だけ成功しても HTTP 200。`includeArchived: true` でアーカイブしたものを含める | [GraphQL](https://linear.app/developers/graphql) |
| 要求の数の上限 | API キー 1 時間 2,500（利用者ごと）、OAuth のアプリ 5,000（利用者かアプリの利用者ごと）、認証なし 600（IP ごと） | [Rate limiting](https://linear.app/developers/rate-limiting) |
| 複雑さの上限 | API キー 1 時間 300 万点、OAuth 200 万点、認証なし 10 万点。1 回の問い合わせは 10,000 点まで | 同上 |
| 複雑さの数え方 | 属性 0.1 点、オブジェクト 1 点、接続はページングの引数（既定 50）で掛ける。最後に切り上げ | 同上 |
| 応答のヘッダー | `X-RateLimit-Requests-Limit`・`-Remaining`・`-Reset`、`X-Complexity`、`X-RateLimit-Complexity-Limit`・`-Remaining`・`-Reset`、入口ごとの `X-RateLimit-Endpoint-*` | 同上 |
| 超えたとき | HTTP 400 と、エラーのコード `RATELIMITED` | 同上 |
| OAuth | 認可 `https://linear.app/oauth/authorize`、トークン `https://api.linear.app/oauth/token`。範囲は `read`・`write`・`issues:create`・`comments:create`・`timeSchedule:write`・`admin`。`actor=user`（既定）か `app`。アクセストークン 24 時間とリフレッシュトークン。PKCE。取り消し `…/oauth/revoke`。client credentials で 30 日のアプリのトークン | [OAuth 2.0 authentication](https://linear.app/developers/oauth-2-0-authentication) |
| Webhook の対象 | イシュー、添付、コメント、ラベル、リアクション、プロジェクト、プロジェクトの更新、文書、イニシアチブ、その更新、サイクル、顧客、顧客の要望、利用者。ほかに SLA、OAuth のアプリの取り消し | [Webhooks](https://linear.app/developers/webhooks) |
| Webhook の中身 | `action`（create・update・remove）、`type`、`actor`、`createdAt`、`data`、`url`、`updatedFrom`、`webhookTimestamp` | 同上 |
| Webhook の署名 | 本家の名前の付いたヘッダーに、生の本文の HMAC-SHA256。`webhookTimestamp`（ミリ秒）が受けた時刻から 1 分以内かを確かめることを勧める | 同上 |
| Webhook の送信 | 5 秒で時間切れ。200 以外で再試行、1 分・1 時間・6 時間（最大 3 回）。応答しない Webhook は止めることがある | 同上 |
| Webhook の作成 | ワークスペースの管理者か、`admin` の範囲の OAuth のアプリだけ。対象は全部の公開のチームか、1 つのチーム | 同上 |
| API キー | 管理者は、メンバーが自分の API キーを作れるかを設定で決める（管理者は常に作れる）。キーごとに、利用者の読める全部か、範囲（Read・Write・Admin・Create issues・Create comments）に絞れる。特定のチームにも絞れる。管理者はワークスペースのキーの一覧を見て取り消せる | [API and Webhooks](https://linear.app/docs/api-and-webhooks) |
| ページング | Relay の形の cursor。引数なしで最初の 50 件。既定の並びは `createdAt`、`orderBy: updatedAt` で最近の変更の順 | [Pagination](https://linear.app/developers/pagination) |

- 本家の API キーの期限は、上の文書では確かめられなかった（**未検証**）。
- 本家のページングの上限と cursor の中身の形は、上の文書の本文では確かめられなかった（**未検証**）。
- 本家の Webhook の署名のヘッダーの名前は、本家の名前を含むので、この設計では `<Brand>-Signature` と書く（[リポジトリ共通の ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。

## 3. GraphQL の API

ADR-0041。

### 3.1 スキーマの作り方

| 部分 | 作り方 |
| --- | --- |
| モデルの object の型、列挙 | 生成（`api: public` のモデルとフィールド。[data-model-and-schema.md](data-model-and-schema.md) の 4 節） |
| 接続の型（`IssueConnection` など）、フィルターの入力の型 | 生成（モデルの定義と `packages/filter` のフィールドの登録から） |
| 問い合わせの入口（`issue`、`issues`、`teams`、`viewer`、`search` …） | 手で書く |
| mutation（`issueCreate`、`issueUpdate` …）と入力の型 | 手で書く。入力の型の中のフィールドは生成した型を参照する |
| リゾルバー | 手で書く。行の読み出しは共有の関数（3.3 節） |

- 実行は `graphql-js`（参照の実装）を Hono の上で使う。GraphQL のサーバーの枠組み（Apollo Server など）は使わない。要る機能（複雑さの計算、主体の文脈、エラーの形）が少なく、自前で持つ方が読みやすい。
- 名前は GraphQL の慣例で camelCase（`teamId`、`createdAt`）。モデルの定義の snake_case から生成で変える。
- `api: internal` のフィールド（`account_id`、`upload_ref`、`installation_id` など）は型に出ない。生成の検査で、`pii: identity` の `email` を出すかは明示を求める（`User.email` は出す。本家と同じく、ワークスペースの中で見えるため）。
- SDL を開発リポジトリに保存し、PR で差分を見る。破壊の変更（フィールドの削除・型の変更・必須の引数の追加）は CI で失敗させ、3.7 節の手順を求める。

### 3.2 問い合わせの形

```graphql
query {
  issues(
    first: 50, after: "…",
    filter: { state: { type: { in: ["started"] } }, assignee: { isMe: { eq: true } } },
    orderBy: updatedAt, includeArchived: false
  ) {
    nodes { id identifier title priority state { name type } assignee { name } updatedAt }
    pageInfo { hasNextPage endCursor }
  }
}
```

| 項目 | 決定 |
| --- | --- |
| ページング | Relay の接続（`first`・`after`、`last`・`before`）。`nodes` と `edges` の両方。既定 50、最大 250 |
| cursor | 不透明な base64url。中身は `(並べ方の値, id)` と、主体とフィルターのハッシュ。別の主体・別のフィルターで使うと `INVALID_CURSOR` |
| 並べ方 | `createdAt`・`updatedAt`（既定）。同じ値は `id` で決める |
| アーカイブ | 既定で含めない。`includeArchived: true` で含める（本家と同じ）。ゴミ箱のイシューは `includeTrashed` を別に持たず、アーカイブとして返す（`trashedAt` のフィールドで見分ける） |
| フィルター | `packages/filter` の木（[views-and-filters.md](views-and-filters.md) の 3 節）を入力の型に写す。評価はサーバーの SQL の生成（同 6.3 節）と同じコード |
| 本文 | `description`（Markdown。`doc_states.text_plain` ではなく、Yjs の状態から `packages/doc` で作る）。重いので、1 つの問い合わせで本文を読むイシューは 50 まで（超えたら複雑さを 10 倍に数える） |
| 検索 | `searchIssues(term, first, after)` は検索の関数（[search.md](search.md) の 7 節）をそのまま呼ぶ |
| 整合 | 応答の `extensions.lastSyncId` に、読んだ reader の `workspace_sync.last_sync_id` を入れる |

### 3.3 読み出しと権限

- Public API のタスクは、主体（3.5 節）を決めた後、Aurora の reader で `SET LOCAL app.workspace_id` を置き（RLS）、すべての行の読み出しに `sync_groups && $groups`（`groupsFor(主体)` の配列との重なり）を付ける。これは読む権限の定義（[permissions-and-teams.md](permissions-and-teams.md) の 4.2 節：`can(p, "read", row) ⇔ groupsOf(row) ∩ groupsFor(p) ≠ ∅`）の SQL の形である。
- 行の読み出しは、Sync API・ビューの問い合わせと同じ `packages/query` の関数を通す。GraphQL のリゾルバーは SQL を直接書かない（lint）。
- N+1 は DataLoader でまとめる。まとめる鍵に主体の `groups` のハッシュを含め、別の主体の結果を混ぜない（1 つの要求の中でだけ持つ）。
- 見てよくない行・存在しない行は、どちらも `null`（単数）か、結果に含めない（接続）。`FORBIDDEN` を返さない（存在を明かさない。ADR-0004）。
- reader の遅れ：mutation の応答の中の読み出しは writer から行う（自分の書いた結果を必ず返す）。続く問い合わせは reader で、遅れを受け入れる。`extensions.lastSyncId` で利用者が判断できる。

### 3.4 mutation と Writer

```
 mutation { issueUpdate(id: "…", input: { priority: 1, stateId: "…" }) { success lastSyncId issue { id priority } } }
   │ Public API：入力の検証（Zod、生成した型）→ 範囲の確かめ（3.5 節）
   │ トランザクションを作る：{ id: client_tx_id, fv: 今のバージョン, base: reader の last_sync_id, ops: [set priority, set state_id] }
   ▼
 Writer（origin = api、actor = 主体の User）── 5.3 節の決定表で検証、derive、sync_actions
   ▼
 ack ok(s) → writer から結果の行を読む → { success: true, lastSyncId: s, issue }
 ack reject(code) → { success: false } と errors[].extensions.code
```

| 項目 | 決定 |
| --- | --- |
| 1 つの mutation | 1 つのトランザクション。原子的 |
| 1 つの要求に複数の mutation | 上から順に、別々のトランザクションとして 1 回の `submit` で送る。1 つが拒否されても他は確定しうる（GraphQL の mutation の直列の実行と同じ見え方） |
| 冪等性 | 要求の `Idempotency-Key`（UUID）を `client_tx_id` にする。複数の mutation があれば、キーと添字から UUIDv5 で作る。キーがなければ UUIDv7 を振る（再送で 2 回効きうる）。`tx_results` の 90 日で、同じキーには同じ結果を返す（ADR-0006） |
| 作る行の ID | 入力の `id` を受ける（UUIDv7 の検査。[data-model-and-schema.md](data-model-and-schema.md) の 5.1 節）。なければサーバーが振る |
| 本文の変更 | `description`（Markdown）を受けたら、`packages/doc` で今の状態との差を Yjs の更新にし、`append` の操作にする。同時の人の編集とは CRDT で合わさる（全体の置き換えにしない） |
| 並べ替え | `sortOrder` の数値ではなく、`beforeId`・`afterId` を受け、Writer の分数インデックスの鍵を振る（ADR-0008） |
| 拒否のコード | Writer のコードを GraphQL の `extensions.code` に写す：`not_found`・`deleted` → `NOT_FOUND`、`forbidden` → `NOT_FOUND`（参照先を明かさない場合）か `FORBIDDEN`（自分の権限の不足が明らかな場合。例：ゲストがチームを作る）、`invalid`・`invalid_reference`・`cycle`・`workflow_violation`・`duplicate_id` → `INVALID_INPUT`（`extensions.reason` に元のコード）、`too_large` → `INVALID_INPUT` |
| 再試行できる失敗 | Writer の `retry` は、Public API が同じ `client_tx_id` で 2 回まで送り直す。だめなら `503` と `Retry-After` |
| 流量 | Writer の `api` の枠（ADR-0054）を超えたら `RATELIMITED`（4 節）と `Retry-After` |

- 一括の mutation（`issueBatchUpdate(ids, input)`）は、500 操作ずつのトランザクションに分ける（[sync-engine.md](sync-engine.md) の 4.2 節と同じ）。応答に確定と拒否の数を返す。
- Webhook の発火の条件（5 節）は `origin` を見ない。API の書き込みも Webhook に載る。

### 3.5 主体

| 認証 | `Authorization` | 主体（`Principal`） |
| --- | --- | --- |
| API キー | `Authorization: <brand>_api_…`（`Bearer` を付けても受ける） | `kind = api_key`、キーの持ち主の `User`、範囲、チームの絞り |
| OAuth のアクセストークン | `Authorization: Bearer <brand>_oat_…` | `kind = oauth_app`、認可した `User`、範囲 |
| セッションのクッキー | 受けない | — |

- セッションのクッキーでは公開 API を使えない。本システムの画面は同期（Sync API・Gateway）を使い、公開 API に頼らない。CSRF の面を持たないため。
- 主体の `role`・`status`・`teams` は、要求ごとに DB（reader）から読む（5 秒の写し）。停止された利用者のキーとトークンは、5 秒以内に効かなくなる。
- 範囲と `can()` の重ね方（ADR-0042）：`allowed = can(user, action, target) ∧ scopeAllows(scopes, action, target) ∧ teamAllows(key.teams, target)`。
  | 範囲 | 許す `action` |
  | --- | --- |
  | `read` | `read` |
  | `write` | `read` と、管理の操作（DT-PERM-002）を除く全部 |
  | `issues:create` | `read` と `create Issue`（と同じトランザクションの派生） |
  | `comments:create` | `read` と `create Comment`・`create Reaction` |
  | `admin` | 全部（管理の操作を含む）。持ち主が `owner`・`admin` の時だけ発行できる |

### 3.6 エラーの形

- GraphQL の慣例どおり `errors[]` に `message`、`path`、`extensions.code` を入れる。一部が成功した要求は HTTP 200。
- 要求全体の失敗は HTTP の状態で返す：認証なし・無効 `401`、流量 `429`（4 節）、構文・検証・複雑さの超過 `400`、サーバーの失敗 `500`、Writer の一時の停止 `503`。
- `message` に値（タイトルなど）を入れない。モデルとフィールドの名前だけ（[sync-engine.md](sync-engine.md) の 5.3 節と同じ）。

### 3.7 バージョンと廃止

- URL にも ヘッダーにもバージョンを持たない。足すだけの変更を続け、壊す変更は次の順で行う。
  1. 新しいフィールドを足し、古いものに `@deprecated(reason: "…")` を付ける。変更の記録（changelog）に書く。
  2. 古いフィールドの利用を、主体（アプリ・キー）ごとに数える（メトリクス。値は数だけ）。
  3. 告知から 6 か月後、利用が 0 か、利用している主体の管理者に 2 回知らせた後に消す。
- モデルの定義の破壊の変更（[data-model-and-schema.md](data-model-and-schema.md) の 6.3 節）とは別に進む。公開 API の古いフィールドは、DB から古い列が消えた後も、新しい列から作って返す間は残す。

## 4. 複雑さとレート制限

ADR-0041。

### 4.1 複雑さ

- 実行の前に、構文の木を静かに歩いて数える。数え方は本家と同じ（属性 0.1 点、オブジェクト 1 点、接続は `first`（なければ既定の 50）で掛ける。最後に切り上げ）。本文（`description`）は 1 点ではなく 10 点に数える（3.2 節）。
- 1 回の問い合わせの上限は 10,000 点。超えたら実行せず `400`、`extensions.code = QUERY_TOO_COMPLEX`、`extensions.complexity`。
- 深さは 12 まで、別名（alias）は 1 つの問い合わせで 50 まで、フラグメントの展開は 500 まで。
- 数えた点を応答の `X-Complexity` に入れる。

### 4.2 枠

| 主体 | 要求の数（1 時間） | 複雑さ（1 時間） | 数える単位 |
| --- | --- | --- | --- |
| API キー | 2,500 | 300 万点 | キーの持ち主の `User`（複数のキーで分けても増えない） |
| OAuth のアプリ | 5,000 | 200 万点 | `(アプリ, User)` |
| ワークスペースの合計 | 5 万 | 3,000 万点 | ワークスペース（1 つのワークスペースが Public API を占めないように） |
| 認証なし | なし（受けない） | — | — |

- 数値は本家の値（2 節）に合わせた本システムの初期値である。S1 の負荷の見込み（[capacity.md](capacity.md) の 1 節）で見直す。
- 数え方は Valkey のトークンバケット（キーは主体、1 時間で満ちる速さ）。Valkey が落ちたら、タスクのメモリーの近似の数で続ける（厳しめに、タスクの数で割った値）。
- 書き込みは、上の枠に加えて Writer の `api` の枠（1 ワークスペース 1 秒 60 変更。ADR-0054）を受ける。

### 4.3 応答

- ヘッダーは本家と同じ一般的な名前にする（本家の名前を含まないので、[リポジトリ共通の ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md) に当たらない）：`X-RateLimit-Requests-Limit`・`-Remaining`・`-Reset`、`X-Complexity`、`X-RateLimit-Complexity-Limit`・`-Remaining`・`-Reset`。`-Reset` は UNIX 時刻のミリ秒。
- 超えたら **HTTP 429** と `Retry-After`（秒）、`errors[0].extensions.code = RATELIMITED`。本家は 400 を返すが、HTTP の意味（RFC 6585）に合わせ、利用者の汎用の再試行の部品が効くようにする。
- 枠に当たった主体の数と、上位の主体（ID だけ）を運用の画面に出す。

## 5. Webhook

ADR-0043。

### 5.1 モデル

```ts
model("Webhook", {
  groups: { rule: "admin" }, load: { strategy: "instant" }, delete: { mode: "hard" },
  fields: {
    url:            { type: "string", conflict: "lww", max: 2048 },
    label:          { type: "string", conflict: "lww", max: 128 },
    resource_types: { type: "set<string>", conflict: "set", max: 20 },
    team_id:        { type: "ref:Team", conflict: "lww", nullable: true, on_delete: "cascade" }, // null = 全部の公開のチーム
    enabled:        { type: "bool", conflict: "lww" },
    include_import: { type: "bool", conflict: "lww", default: false },
    creator_id:     { type: "ref:User", conflict: "server_only", on_delete: "nullify", nullable: true },
    oauth_app_id:   { type: "uuid", conflict: "server_only", nullable: true },
    state:          { type: "enum<active,paused_failing,paused_permission>", conflict: "server_only" },
    secret_hint:    { type: "string", conflict: "server_only", max: 8 },     // 末尾 4 文字
  },
});
```

- 秘密は `webhook_secrets`（サーバーだけの表。暗号文。[integrations.md](integrations.md) の 6.1 節と同じ包み）。作った時に 1 回だけ示す。
- `role:admin` のグループなので、管理者の手元に届く。`url` は管理者に見えてよい。`url` に秘密（基本認証、トークンの問い合わせ）が入りうるので、画面では問い合わせの部分を伏せる。

### 5.2 作成の規則

DT-HOOK-001。上から評価し、最初に当たった行。

| # | 作る主体 | `team_id` | 可否 |
| --- | --- | --- | --- |
| 1 | `owner`・`admin` でない（`admin` の範囲のない OAuth のアプリを含む） | — | 否 |
| 2 | `owner`・`admin` | `null`（全部の公開のチーム） | 可 |
| 3 | `owner`・`admin` | 公開のチーム | 可 |
| 4 | `owner`・`admin` で、そのチームのメンバー | 非公開のチーム | 可 |
| 5 | `owner`・`admin` で、メンバーでない | 非公開のチーム | 否（`FORBIDDEN`） |

- 行 4 は ADR-0004 の「非公開のチームを対象にできるのは、そのチームのメンバーの管理者だけ」。
- `admin` の範囲の OAuth のアプリは、認可した利用者を `creator_id` にし、その利用者で上の表を当てる。
- `url` は `https` だけ。作る時に 5.6 節の宛先の検査をする（名前解決の結果が私的な IP なら拒否）。

### 5.3 どの変更を送るか

```
 Writer ─▶ sync_actions ─▶ Relay ──▶ SQS `webhook-fanout`（範囲 {workspace_id, from, to}）
                                        │ ワークスペースに有効な Webhook がある時だけ流す（Relay は 60 秒の写しを持つ）
                                        ▼
                           振り分けの Worker（webhook-fanout）
                             範囲の sync_actions を読む → Webhook ごとに当てはめる（5.4 節）
                             → webhook_deliveries に予定を書く → SQS `webhook-send`
                                        ▼
                           送り係（worker-egress）→ 相手の URL
```

- 対象の `resource_types`（MVP）：`Issue`、`Comment`、`IssueLabel`、`Reaction`、`Attachment`、`Project`、`ProjectUpdate`、`Cycle`、`Initiative`、`User`。
- `sync_actions` の種類と `action` の写し：`insert` → `create`、`update`・`archive`・`unarchive` → `update`（`archivedAt` が変わる）、`delete` → `remove`。`append`（本文の CRDT）はそのままは送らない。本文のまとめ（[editor-and-descriptions.md](editor-and-descriptions.md) の 4.2 節）の後に、`Issue` の `update`（`updatedFrom` に `description` を入れない）を 1 回送る。
- 同じトランザクションの派生の変更（履歴、購読）は送らない。`IssueHistory`・`SyncSubscription` は対象の型にない。
- `origin = import` の変更は、`include_import` が真の Webhook にだけ送る（インポートの 1 万件で相手を溢れさせない）。

### 5.4 権限での絞り込み

- 当てはめ：`resource_types` に型が入り、行のチームが `team_id`（`null` なら公開のチーム）に合い、**`can(creator, "read", row)` が真**のときだけ送る。`creator` は作った管理者の今の主体。
- 行のグループの判定は、`sync_actions.groups`（変更の後の同期グループ）で行う（ADR-0032 の読む権限の定義）。移動（`groups_before` あり）で対象の外へ出た行は、`remove` として 1 回送り、以後は送らない（同期の `evict` と同じ考え方）。
- `creator` が停止・降格・非公開のチームから脱退したら、`can()` が偽になり送らない。その Webhook を `paused_permission` にし、他の管理者に知らせる（5 分ごとの確かめ）。作り直すまで戻らない。
- 送る直前（送り係）にもう一度 `can()` を確かめる。予定から送信までの間に非公開のチームへ移った行を送らない（通知の送る時の確かめと同じ。ADR-0037）。

### 5.5 本文と署名

```http
POST /hooks/receiver HTTP/1.1
Content-Type: application/json; charset=utf-8
User-Agent: <Brand>-Webhook/1
<Brand>-Delivery: 01926f3a-…                  （送りの ID。再試行でも同じ）
<Brand>-Event: Issue
<Brand>-Signature: t=1790000000123,v1=5d2c…

{ "action": "update", "type": "Issue", "webhookId": "…", "deliveryId": "…",
  "workspaceId": "…", "syncId": 18240, "createdAt": "2026-09-28T01:02:03.456Z",
  "actor": { "id": "…", "type": "user", "name": "…" },
  "data": { "id": "…", "identifier": "ENG-123", "title": "…", "stateId": "…", "priority": 2, … },
  "updatedFrom": { "priority": 3, "updatedAt": "…" },
  "url": "https://<brand>.<domain>/<slug>/issue/ENG-123",
  "webhookTimestamp": 1790000000123 }
```

| 項目 | 決定 |
| --- | --- |
| `data` | 変更の後の行（`sync_actions.data`）を、公開 API の型の形（camelCase、`api: public` のフィールドだけ）に写したもの。本文は含めない（`description` は別の `update`） |
| `updatedFrom` | 変わったフィールド（`changed`）の前の値。同じ `model_id` の 1 つ前の `sync_actions` の行の全体から取る。保持（30 日）の外なら `updatedFrom` を省く |
| `actor.type` | `user`・`api_key`・`oauth_app`・`system`（`origin` と主体から） |
| `syncId` | 変更の `sync_id`。受け手は同じ行について、大きい方を新しいとみなせる。送りの順は保証しない |
| 署名 | `v1 = hex(HMAC-SHA256(秘密, t + "." + 生の本文))`。`t` は送る時刻のミリ秒（再試行のたびに新しい）。受け手は `t` が 5 分以内か、`v1` が合うかを定数時間で比べる |
| 秘密の入れ替え | 新しい秘密を作ると、24 時間は `v1=<新>,v1=<旧>` の 2 つを付ける |

- 本家は本文の中の `webhookTimestamp` だけで時刻を示し、署名は本文だけにかかる（2 節）。本システムは、時刻を署名に含め、本文を読む前に古い要求を捨てられるようにする。`webhookTimestamp` も互換のために本文に残す。
- ヘッダーの名前の `<Brand>` は、開発リポジトリの作成の時に決める（リポジトリ共通の ADR-0006）。

### 5.6 送信

| 項目 | 値 |
| --- | --- |
| 経路 | egress のサブネットの `worker-egress` → 専用の NAT（Elastic IP を公開する）。本体の DB・VPC エンドポイントへの経路を持たない |
| 宛先の検査 | `https` だけ。名前解決の後の IP が私的・予約・リンクローカル・メタデータ（`169.254.169.254` など）なら送らない。解決した IP に接続する（DNS の再束縛を避ける）。リダイレクトを追わない |
| 時間切れ | 接続 2 秒、全体 5 秒（本家と同じ） |
| 成功 | 2XX。本家は 200 だけだが、本システムは 2XX を成功にする |
| 応答の本文 | 1 KiB まで読み、捨てる（記録にも残さない） |
| 同時 | 1 つの Webhook に 10 まで。1 つのワークスペースに 50 まで |
| 再試行 | 1 分・1 時間・6 時間の 3 回（本家と同じ）。±10% の揺らぎ。`429`・`503` の `Retry-After` は 1 時間まで従う |
| 停止 | 24 時間、全部の送りが失敗し続けた Webhook を `paused_failing` にし、管理者にメールで知らせる。管理者が戻すまで送らない（その間の変更は捨てる） |

- **少なくとも 1 回**（NFR-009）。送りの ID（`<Brand>-Delivery`）で、受け手が重複を捨てられる。
- 最初の送信の目標は、確定から p95 30 秒（NFR-009）。区間の予算は Relay 1 秒、振り分け 5 秒、送り係の待ち 10 秒、相手 5 秒、余裕 9 秒。

### 5.7 送りの記録

```sql
CREATE TABLE webhook_deliveries (            -- サーバーだけ
  workspace_id  uuid        NOT NULL,
  id            uuid        NOT NULL,        -- <Brand>-Delivery
  webhook_id    uuid        NOT NULL,
  sync_id       bigint      NOT NULL,
  resource_type text        NOT NULL,
  action        text        NOT NULL,
  attempt       smallint    NOT NULL,
  status        smallint    NOT NULL,        -- 0 予定、1 成功、2 失敗（再試行あり）、3 あきらめた、4 権限で落とした
  http_status   smallint,
  latency_ms    integer,
  payload_ct    bytea,                       -- 本文の暗号文。72 時間で消す（手の再送のため）
  created_on    date        NOT NULL,
  PRIMARY KEY (workspace_id, id, created_on)
) PARTITION BY RANGE (created_on);
```

- 14 日持つ（日ごとのパーティションを落とす）。本文（`payload_ct`）は 72 時間で消す。
- 管理者は画面で、Webhook ごとの直近の送り（状態、応答の番号、時間）を見て、72 時間以内のものを手で再送できる（再送は新しい署名の時刻で、同じ送りの ID）。

## 6. API キーと OAuth のアプリ

ADR-0042。

### 6.1 トークンの形

| 種類 | 形 | 保存 |
| --- | --- | --- |
| API キー | `<brand>_api_` ＋ base62 の乱数 32 文字 ＋ チェックサム 6 文字（CRC32 の base62） | SHA-256 と、末尾 4 文字 |
| OAuth のアクセストークン | `<brand>_oat_` ＋ 同じ形 | SHA-256 |
| OAuth のリフレッシュトークン | `<brand>_ort_` ＋ 同じ形 | SHA-256、一式の ID |
| OAuth のクライアントの秘密 | `<brand>_ocs_` ＋ 同じ形 | SHA-256 |
| Webhook の秘密 | `<brand>_whsec_` ＋ base62 の乱数 32 文字 | 暗号文（送る時に要るので戻せる形。5.1 節） |

- 接頭辞とチェックサムで、シークレットスキャン（GitHub のパートナープログラムなど）が見つけられるようにする。接頭辞は他の既知のサービスと重ならないことを確かめてから登録する（[リポジトリ共通の ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。
- シークレットスキャンの通報を受ける口（`POST /internal/secret-scanning`）で、見つかったトークンを取り消し、持ち主と管理者に知らせる。
- トークンの照合は SHA-256 の等しさ（高いエントロピーの秘密。遅いハッシュは要らない）。Valkey に 5 分の写し（キーはハッシュ）。

### 6.2 API キー

- ワークスペースの設定（`api_keys_allowed`：`all`・`admins`・`none`。既定 `all`）で作れる人を決める。
- 作る時に決めるもの：名前、範囲（3.5 節の表）、チームの絞り（任意。選んだチームだけ）、期限（既定 1 年、最大 1 年。期限なしは許さない）。
- 期限の 7 日前に持ち主にメールで知らせる。持ち主が停止・削除されたら、キーは使えない（主体の `status` で判定）。持ち主がワークスペースから外れたら、キーを消す。
- 管理者は、ワークスペースの全部のキーの一覧（名前、持ち主、範囲、最後の利用）を見て、取り消せる。
- 最後の利用の時刻は 1 時間に 1 回だけ書く。

### 6.3 OAuth のアプリ

| 項目 | 決定 |
| --- | --- |
| 登録 | ワークスペースの管理者が登録する（アプリはワークスペースに属する）。名前、戻りの URL（完全一致。`https`、開発用に `http://localhost` を許す）、範囲 |
| 認可 | `GET https://<brand>.<domain>/oauth/authorize`（画面。セッションのクッキーで本人を確かめる）。`response_type=code`、`state`、`code_challenge`（S256）を必須にする。コードは 60 秒・1 回限り |
| トークン | `POST https://api.<brand>.<domain>/oauth/token`。`authorization_code`（`code_verifier` が必須）と `refresh_token` |
| 期限 | アクセストークン 24 時間（本家と同じ）。リフレッシュトークンは 90 日使わなければ切れる |
| 入れ替え | リフレッシュのたびに新しいリフレッシュトークンを出し、古いものを使えなくする。使えなくしたものが再び出されたら、その一式（同じ認可から出た全部）を取り消す |
| 取り消し | `POST …/oauth/revoke`（RFC 7009）。利用者は設定で自分の認可したアプリを取り消せる。管理者はアプリの全部のトークンを取り消せる |
| 範囲 | 3.5 節。`admin` は認可する人が `owner`・`admin` の時だけ出せる。他の範囲は、ワークスペースの設定（`oauth_apps_allowed`）が許せばメンバーが自分のために認可できる |
| ワークスペースの選択 | 認可の画面で、1 つのワークスペースを選ぶ。トークンはそのワークスペースだけで使える |

- `oauth_apps` の表はワークスペースの表（RLS）に置く。認可の画面で、ワークスペースのコンテキストを決める前にアプリの名前・戻りの URL・範囲を読むときは、`SECURITY DEFINER` の関数 `oauth_app_public(client_id)` だけを使い、`(workspace_id, name, redirect_uris, scopes)` だけを返す（[data-model.md](data-model.md) の 5 節）。

- 実装は、認証の部品（Better Auth）の OAuth の提供者の機能を使わず、Public API の中に小さく持つ。トークンをワークスペースの `User` に結び、上の形と保存の規則にするため。Better Auth の OAuth 2.1 の提供者の部品は、PKCE（公開のクライアントで必須）、リフレッシュトークンの入れ替えと再利用の検出を持つ（[OAuth 2.1 Provider](https://better-auth.com/docs/plugins/oauth-provider)、2026-09-28 に確認）。ただし、その部品には 2026 年に High の告知が複数ある（[accounts-and-auth.md](accounts-and-auth.md) の 2.2 節）。E11 の着手の時に比べ直してよい。
- `actor=app`（アプリの利用者を主体にする）と client credentials は MVP の後。エージェントの連携（AI の Epic）の時に決める。

## 7. 障害のときの振る舞い

| 事象 | 起きること | 備え |
| --- | --- | --- |
| reader が遅れる | 問い合わせが古い結果を返す | `extensions.lastSyncId`。mutation の結果は writer から |
| Writer が一時に止まる（フェイルオーバー） | mutation が `503` | `Retry-After`。`Idempotency-Key` で安全に再送できる |
| Valkey が落ちる | レート制限が近似になる | タスクのメモリーの厳しめの数（4.2 節） |
| 相手の Webhook の受け手が遅い・落ちている | 送りが溜まる | 同時の上限、再試行、24 時間で停止。他の Webhook の送りを待たせない（Webhook ごとの同時の上限） |
| 振り分けの Worker が遅れる | 送りが遅れる | SQS に残る。`webhook_first_attempt_lag` を監視 |
| 保持（30 日）の外の `updatedFrom` | 前の値がない | `updatedFrom` を省く |
| 大量の変更（一括の編集） | Webhook が溢れる | ワークスペースの同時 50。予定の数が 1 Webhook で 10 万を超えたら、古い予定から捨てて管理者に知らせる |

## 8. セキュリティ

- **読み出しは同期グループの重なりで絞る**（3.3 節）。GraphQL のリゾルバーに権限の条件を書かない。公開 API は NFR-008 の経路の 1 つで、PROP-API-001 で同期と同じ結果を確かめる。
- **存在を明かさない**：見てよくない行は `null`。エラーの文言に値を入れない。
- **トークン**：ハッシュだけを保存、接頭辞とシークレットスキャン、期限、入れ替えと再利用の検出。ログ・トレースに `Authorization` を出さない（[observability.md](observability.md) の 2 節）。
- **OAuth**：PKCE（S256）を必須、戻りの URL の完全一致、`state`、コードの 1 回限り。認可の画面は `frame-ancestors 'none'`（クリックジャッキング）。
- **Webhook**：作成の規則（DT-HOOK-001）、送る時の `can()`、egress の経路と宛先の検査（SSRF）、署名と時刻、秘密の入れ替え。本文は 72 時間で消す。
- **複雑さとレート制限**：実行の前に数える。introspection は認証した主体にだけ許す。
- **CORS**：公開 API は `Access-Control-Allow-Origin` を返さない（ブラウザから第三者のページで使わせない。トークンをブラウザに置く使い方を勧めない）。本家の方針は**未検証**。
- **法務**：Webhook と API の先は、顧客が決める宛先である。本システムから第三者への提供ではなく、顧客の指示による送信として扱う想定だが、法務の L1・L7 で確かめる。

## 9. テスト

- 表駆動テスト：DT-HOOK-001、3.5 節の範囲の表（DT-API-001）、3.4 節の拒否のコードの写し（DT-API-002）。
- 性質ベーステスト：
  - **PROP-API-001（同期と同じ読み）**：任意のワークスペース・主体・フィルターで、公開 API の `issues` の結果の ID の集合は、同じ主体の同期（ブートストラップと差分）で届く行に同じフィルターを当てた集合と等しい（[views-and-filters.md](views-and-filters.md) の PROP-VIEW-001 と同じ例の集まりを使う）。
  - **PROP-API-002（mutation の冪等）**：同じ `Idempotency-Key` の要求を何回送っても、効くのは 1 回で、応答は同じ。
  - **PROP-API-003（複雑さの上界）**：任意の問い合わせで、実行の時に読んだ行の数は、数えた複雑さの点を超えない。
  - **PROP-HOOK-001（見てよい行だけ）**：任意の変更と権限の変化の列で、送った `data` の行は、送った時点で `can(creator, "read", row)` が真。
  - **PROP-HOOK-002（署名）**：任意の本文・秘密・時刻で、受け手の検査の関数が、送り手の署名だけを受け入れる（本文 1 バイトの違い、時刻の違い、古い秘密の 24 時間の後を拒否する）。
- 結合テスト：SSRF の宛先（私的な IP、DNS の再束縛、リダイレクト）、再試行の時刻（仮想の時計）、停止と戻し。
- 契約のテスト：SDL の差分の検査（壊す変更で失敗）、公式の SDK の生成。
- 負荷（E12）：API キー 1 つで上限まで、ワークスペースの合計の上限、Webhook の送り 1 秒 1,000 件。

## 10. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E11 | `codegen-graphql-types` | 生成の型（data-model-and-schema と共同） |
| E11 | `graphql-endpoint` | 3.1〜3.3 節の入口、`packages/query` の読み出し、DataLoader |
| E11 | `api-filter-input` | 3.2 節のフィルターの入力（views-and-filters と共同） |
| E11 | `graphql-mutations-writer` | 3.4 節の mutation、冪等、本文の `append`、拒否の写し |
| E11 | `api-complexity-rate-limit` | 4 節の複雑さ、枠、ヘッダー |
| E11 | `api-keys` | 6.1・6.2 節、シークレットスキャンの口 |
| E11 | `oauth-apps` | 6.3 節 |
| E11 | `webhook-model-and-rules` | 5.1・5.2 節、DT-HOOK-001 |
| E11 | `webhook-fanout-and-send` | 5.3〜5.6 節、egress の経路、再試行、停止 |
| E11 | `webhook-delivery-log` | 5.7 節、手の再送 |
| E11 | `api-deprecation-tracking` | 3.7 節の利用の数え |
| E11 | `public-sdk` | SDL から公式の SDK を生成（TypeScript） |

## 11. 未解決の問い

- GraphQL の枠組みを使うか。
- 読み出しの権限を、リゾルバーで `can()` を呼ぶか、SQL で絞るか。
- mutation を Writer にどう写すか。1 つの要求の複数の mutation の原子性。
- 流量の超過を 400 にするか 429 にするか。
- API キーに期限を付けるか。
- OAuth の提供者を認証の部品で行うか、自前か。
- Webhook の署名に時刻を含めるか。`updatedFrom` の作り方。

### 決定

2026-09-28 の既定案。E11 の着手で覆りうる。

- **枠組み**：`graphql-js` と自前の受け口（ADR-0041）。
- **読み出し**：SQL の同期グループの重なり（ADR-0041。読む権限の定義と同じ）。
- **mutation**：1 つずつのトランザクション、`Idempotency-Key`（ADR-0041）。
- **流量**：429（ADR-0041）。
- **API キー**：期限 1 年まで、範囲とチーム（ADR-0042）。
- **OAuth**：自前、PKCE 必須、入れ替え（ADR-0042）。
- **Webhook**：時刻を含む署名、1 つ前の `sync_actions` から `updatedFrom`（ADR-0043）。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| 本家の API キーの期限、ページングの上限 | 公式の資料で確かめられない（**未検証**）。本システムの値のまま |
| `actor=app` と client credentials | AI の Epic の着手の時 |
| 公開のアプリの一覧（他のワークスペースへの配布） | MVP の後 |
| Webhook の送りの順序の保証（同じ行の順） | 試用の声。要れば Webhook ごとの FIFO |
| 複雑さの枠の値 | E12 の負荷試験と試用 |
| `updatedFrom` のための `sync_actions` の索引の大きさ | E2 で行の大きさを測る時に一緒に見る |

## 12. quality.md・runbooks・data-model への項目

### quality.md

- DT-HOOK-001、DT-API-001・002 の表駆動テストと、PROP-API-001〜003、PROP-HOOK-001・002 を E11 のリリースの基準にする。PROP-API-001・PROP-HOOK-001 は NFR-008 の試験の一部にする。
- 本番：1 件の読み出しの p99（NFR-009 の 500ms）、mutation の送信から応答の p99、`RATELIMITED` の数（主体の種類ごと）。
- 本番：Webhook の確定から最初の送信の p95（NFR-009 の 30 秒）、成功の率、`paused_failing` の数、権限で落とした数（`status = 4`）。
- 本番：廃止したフィールドの利用の数。

### runbooks

- `api-abuse.md`：1 つの主体・ワークスペースが Public API を占めるときの確かめ方と、枠の一時の引き下げ、キーの取り消し。
- `webhook-backlog.md`：送りが溜まるときの切り分け（振り分けの遅れ、相手の遅さ、egress の NAT）と、Worker を増やす手順。
- `leaked-token-response.md`：API キー・OAuth のトークン・Webhook の秘密の漏えい（シークレットスキャンの通報を含む）の取り消しと連絡。

### data-model（索引への追加の提案）

| 表・モデル | 中身 | 節 |
| --- | --- | --- |
| `api_keys`（サーバーだけ。管理の一覧は API で） | 持ち主、ハッシュ、範囲、チーム、期限、最後の利用 | 6.2 |
| `oauth_apps`・`oauth_grants`・`oauth_tokens`（サーバーだけ） | アプリ、認可、トークンのハッシュと一式 | 6.3 |
| `webhooks`（`Webhook`） | Webhook（`role:admin`） | 5.1 |
| `webhook_secrets`（サーバーだけ） | 秘密の暗号文（入れ替えの間は 2 つ） | 5.1、5.5 |
| `webhook_deliveries`（サーバーだけ） | 送りの記録（14 日、本文は 72 時間） | 5.7 |
| `sync_actions` の索引 `(workspace_id, model, model_id, sync_id)` | `updatedFrom` の前の値の読み出し（[observability.md](observability.md) の収束の監査と共有） | 5.5 |
| `WorkspaceSettings`（[permissions-and-teams.md](permissions-and-teams.md) の 3.3 節） | `api_keys_allowed`、`oauth_apps_allowed` | 6.2、6.3 |
| permissions-and-teams への依頼（反映済み） | `Principal.scopes`・`teams` の重ね方（3.5 節）を `packages/policy` に入れる（[permissions-and-teams.md](permissions-and-teams.md) の 4.1 節） | 3.5 |

## 出典

いずれも 2026-09-28 に確認。

- Linear Developers, [GraphQL](https://linear.app/developers/graphql)、[Rate limiting](https://linear.app/developers/rate-limiting)、[Webhooks](https://linear.app/developers/webhooks)、[OAuth 2.0 authentication](https://linear.app/developers/oauth-2-0-authentication)

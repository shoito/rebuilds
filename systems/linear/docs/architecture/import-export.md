# Import and Export: Linear

他のツールからの取り込み（Jira、GitHub Issues、Asana、Shortcut、CSV）と、書き出し（CSV・JSON）を決める。取り込みの流れ（接続、取り出し、対応付け、試しの実行、書き込み）、利用者・状態・ラベルなどの対応付け、Writer を通す一括の書き込みと流量の制御、やり直しの冪等性、取り消し、書き出しの権限と配り方を扱う。

前提となる決定は、Writer と冪等性（[ADR-0006](../decisions/0006-transactions-writer-and-idempotency.md)）、ID（[ADR-0020](../decisions/0020-ids-and-human-identifiers.md)）、本文の CRDT（[ADR-0021](../decisions/0021-description-crdt-yjs-in-sync-log.md)）、添付（[ADR-0022](../decisions/0022-comments-anchors-mentions-attachments.md)）、Triage の入り口（[ADR-0024](../decisions/0024-hierarchy-relations-duplicates-and-triage.md)）、検索の索引の流れ（[ADR-0030](../decisions/0030-search-engine-opensearch.md)）、通知の生成（[ADR-0036](../decisions/0036-notifications-derived-by-notifier.md)）、1 ワークスペースの書き込みの割り当て（[ADR-0054](../decisions/0054-per-workspace-write-admission.md)）。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0044](../decisions/0044-import-pipeline-staging-and-throttled-writer-commits.md) | 取り込みは Worker のジョブで、取り出した記録を S3 の段置きに正規化して置き、管理者が対応付けと試しの結果を確かめてから書く。書き込みは Writer（`origin = import`）に 1 回 200 変更の束で、ワークスペースの `import` の枠（既定 1 秒 100 変更、ロックの待ちで半分に下げる）で流す。モデルの ID と `client_tx_id` は元の記録から決まる形で作り、やり直しは同じ ID で冪等になる。取り消しは 7 日以内、取り込みの後に人が触れていない行だけ |
| [0045](../decisions/0045-export-by-permission-to-private-download.md) | 書き出しは Worker のジョブで、頼んだ人の主体の同期グループで絞って読み、S3 の非公開の場所に暗号化して置く。取り出しはセッションで確かめてから 5 分の署名付きの URL に転送し、ファイルは 24 時間で消す。CSV は式の注入を防ぐ。ゲストは書き出せない |

## 1. 目的と範囲

- 扱う：
  - 取り込みの元（Jira Cloud、GitHub Issues、Asana、Shortcut、CSV）の接続と取り出し
  - 利用者・状態・優先度・ラベル・種類・親子・エピック・コメント・添付の対応付け
  - 段置き、試しの実行、書き込み、流量の制御、進みの表示、やり直し、取り消し
  - 取り込みの間の通知・Webhook・検索の扱い
  - 書き出し（ビュー・チームの CSV、ワークスペースの JSON）
- 扱わない：
  - Jira Server・Data Center、他のツール（ClickUp、Trello など）、本システムのワークスペースの間の移動（MVP の後）
  - 双方向の同期（取り込んだ後も元のツールと同期し続けること。Non-goal）
  - 公開 API の一括の mutation（[api-and-webhooks.md](api-and-webhooks.md) の 3.4 節）

## 2. 本家の形と、元のツールの仕様（確かめたこと）

いずれも 2026-09-28 に確認。

### 2.1 本家（公式）

| 項目 | 内容 | 出典 |
| --- | --- | --- |
| 取り込みの元 | Jira、GitHub Issues、Asana、Shortcut、本家のワークスペースの間。CLI もある | [Import issues](https://linear.app/docs/import-issues) |
| 認証 | 元のツールにサインインするか、API のトークンを入れる | 同上 |
| 利用者の対応付け | 飛ばす、メールアドレスから新しく作る、既存の利用者に結ぶ、から選ぶ | 同上 |
| やり直し | 最初の取り込みを消さずに取り込み直すと、取り込み済みのイシューを飛ばす | 同上 |
| 取り消し | 設定から取り込みを消せる。作ってから限られた期間だけ | 同上 |
| 制約 | 元の考え方が合わないものは取り込まないことがある | 同上 |
| 書き出し | ビュー・プロジェクト・ワークスペースの設定から CSV。メンバーは 250 件まで、管理者は 2,000 件まで。ゲストは書き出せない。準備ができたらメールでリンクを送り、リンクは 12 時間で切れる。管理者はワークスペースの全部を書き出せ、非公開のチームを含める選択がある。Markdown のコピー、PDF の印刷もある | [Exporting data](https://linear.app/docs/exporting-data) |

- 本家の取り込みの時間、添付とコメントの扱い、取り消しの期間の長さは、上の文書では確かめられなかった（**未検証**）。
- 本家の「非公開のチームを含める」は、管理者がメンバーでない非公開のチームにも及ぶ（「どの非公開のチームのイシューも含められる」。[Private teams](https://linear.app/docs/private-teams)、2026-09-28 に確認）。本システムはこれに寄せない（ADR-0045。7 節）。

### 2.2 元のツールの API

| 元 | 認証（本システムが使うもの） | 流量 | 出典 |
| --- | --- | --- | --- |
| Jira Cloud | 利用者のメールアドレスと API のトークン（Basic） | 点による 1 時間の枠（2026-03-02 から）。API のトークンの利用は点の枠の変更を受けず、入口ごとの毎秒の上限（GET・POST 100、PUT・DELETE 50）を受ける。429 と `Retry-After`、`RateLimit-Reason` | [Rate limiting](https://developer.atlassian.com/cloud/jira/platform/rate-limiting/) |
| GitHub Issues | 連携の GitHub App（入っていれば、Issues の読みの権限を足す）か、利用者の細かな権限のトークン | インストールで 1 時間 5,000〜12,500 回（[integrations.md](integrations.md) の 2.2 節） | [Rate limits for the REST API](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) |
| Asana | 個人のアクセストークン | 無料 1 分 150 回、有料 1,500 回。同時は読み 50・書き 15。429 と `Retry-After` | [Rate limits](https://developers.asana.com/docs/rate-limits) |
| Shortcut | `Shortcut-Token` のヘッダーの API のトークン | 1 分 200 回、超えると 429 | [REST API v3](https://developer.shortcut.com/api/rest/v3) |
| CSV | ファイルの上げ | — | — |

## 3. 取り込みの流れ

ADR-0044。

```
 管理者（画面）                   Public API                 import-worker（egress の経路）         S3（ws/<id>/imports/<job>/）
  │ 1. 元と認証を入れる ─────────▶│ import_jobs を作る（state = fetching）
  │                               │ 認証を import_secrets に暗号で ─────▶│
  │                               │                                        │ 2. 取り出し：元の API を読み、
  │                               │                                        │    正規化した記録を NDJSON で ──▶ records/*.ndjson.gz
  │◀── 進み（件数）────────────── │◀──────── 数と候補（利用者・状態・ラベル）│    添付の一覧（中身はまだ）
  │ 3. 対応付け（4 節）を決める ───▶│ import_mappings                        │
  │ 4. 試しの実行 ────────────────▶│                                        │ 計画を作る：作る行の数、足りない対応付け、
  │◀── 計画と誤り ──────────────── │◀───────────────────────────────────────│   上限の超過 ──────────────▶ plan.json
  │ 5. 書き込みを始める ───────────▶│ state = committing                      │
  │                               │                                        │ 6. Writer へ 200 変更の束（5 節）
  │◀── 進み（sync の差分でも届く）│                                        │ 7. 添付の中身を取り出して S3 へ、`ready` に
  │                               │ state = done。認証を消す               │
```

| 状態 | 意味 | 次 |
| --- | --- | --- |
| `fetching` | 元から読んでいる | `mapping`、`failed` |
| `mapping` | 対応付けを待つ | `planned` |
| `planned` | 試しの結果がある | `committing`、`mapping`（直す） |
| `committing` | 書いている | `done`、`paused`、`failed` |
| `paused` | 管理者か流量の制御が止めた | `committing` |
| `done` | 書き終えた | `undoing`（7 日以内） |
| `undoing`・`undone` | 取り消し | — |
| `failed` | 続けられない誤り | `mapping`（直してやり直す） |

- ジョブを作れるのは `owner`・`admin`（`can(actor, "import", workspace)`。[permissions-and-teams.md](permissions-and-teams.md) の DT-PERM-002 に行を足す依頼）。1 つのワークスペースで同時に `committing` にできるジョブは 1 つ。
- 取り込みはオフラインでは使えない（[client-store-and-offline.md](client-store-and-offline.md) の 9.4 節）。画面は Public API の内部の入口と、同期で届く `ImportJob`（`role:admin` のグループ）の進みで作る。
- 元の認証は `import_secrets`（[integrations.md](integrations.md) の 6.1 節と同じ包み）に置き、`done`・`failed`・作ってから 7 日のどれかで消す。
- 段置きの S3 は KMS で暗号化し、ライフサイクルで 30 日で消す。取り消しの期間（7 日）より長く持ち、調査に使う。

### 3.1 取り出し

- 元ごとに取り出しの部品（アダプター）を持ち、共通の正規化した記録を出す。

```json
{ "kind": "issue", "source_id": "JIRA-10042", "source_key": "PROJ-42", "url": "https://….atlassian.net/browse/PROJ-42",
  "title": "…", "body": { "format": "adf", "value": … }, "status": { "id": "10001", "name": "In Progress", "category": "indeterminate" },
  "priority": "High", "type": "Bug", "labels": ["backend"], "assignee": "acc-123", "reporter": "acc-456",
  "parent": "JIRA-10040", "epic": "JIRA-10001", "sprint": ["Sprint 12"], "estimate": 3, "due": "2026-10-01",
  "created_at": "2025-04-01T00:00:00Z", "updated_at": "…", "completed_at": null, "attachments": [{ "source_id": "…", "name": "…", "size": 1234 }] }
```

- 記録の種類：`user`、`issue`、`comment`、`label`、`status`、`epic`・`project`、`attachment`。
- 本文の形（Jira の ADF、GitHub・Shortcut の Markdown、Asana の HTML の一部）は、段置きの時に Markdown に揃え、書き込みの時に `packages/doc` で本文の CRDT の状態にする。変換できない要素（Jira のマクロなど）は、元の URL への注記に置き換える。
- 取り出しは元の流量（2.2 節）を守る。429 は `Retry-After` に従い、同時の要求はアダプターごとの上限（Jira 10、Asana 読み 20、Shortcut 3、GitHub 10）にする。途中で落ちたら、段置きの最後のページの cursor から続ける。
- CSV：本システムの雛形の列（タイトル、本文、状態、優先度、ラベル、担当のメールアドレス、見積もり、期日、親、作成の時刻）と、Jira の CSV の書き出しの列の 2 つの形を受ける。1 ファイル 50 MiB・5 万行まで。文字コードは UTF-8（BOM 可）と Shift_JIS を判定する。

## 4. 対応付け

DT-IMPORT-001。記録ごとの写し方。

| 元 | 行き先 | 規則 |
| --- | --- | --- |
| 利用者 | `User` | メールアドレスが一致する既存の `User` を既定にする。管理者は、別の `User` に結ぶ、招待する（メールを送る。確かめの画面を挟む）、結ばない、から選ぶ。結ばない人の担当は空に、作者・コメントの書き手は取り込みを行う管理者にし、本文の先頭に「元の作者：<名前>」を付ける |
| 状態 | 行き先のチームの `WorkflowState` | 元の状態の種類（Jira の status category、Asana の完了、Shortcut の workflow state の type、GitHub の open・closed）から種類を決め、同じ種類の最初の状態を既定にする。管理者が状態ごとに選べる。種類が決まらないものは `backlog` |
| 優先度 | `priority` | 元の名前の表（Highest・High → Urgent・High、など）。管理者が直せる |
| ラベル | `IssueLabel`（チーム） | 同じ名前（大文字・小文字を区別しない）があれば使い、なければ作る。1 イシュー 100 まで（[data-model-and-schema.md](data-model-and-schema.md) の 3.1 節） |
| 種類（Jira の issue type など） | ラベル | 「種類」のラベルのグループに入れる（排他。[issues-and-workflow.md](issues-and-workflow.md) の 6.1 節） |
| エピック | `Project` か親のイシュー | 管理者が選ぶ。既定は `Project` |
| スプリント | ラベル（`sprint:<名前>`） | MVP ではサイクルに写さない。元のスプリントの期間は、チームのサイクルの規則（固定の長さ）と合わないことが多いため |
| 親子・サブタスク | `parent_id` | 親が同じ取り込みにあれば結ぶ。なければ本文に元の URL を残す |
| 関連（blocks など） | `IssueRelation` | 両方が同じ取り込みにあれば結ぶ |
| コメント | `Comment` | 書き手は利用者の対応付けに従う。時刻は元の時刻（5.2 節） |
| 添付 | `Attachment` | 中身を取り出して S3 に置く（1 ファイル 100 MiB、1 つの取り込みで合計 20 GiB まで）。超えたものは元の URL のリンクだけにする |
| 見積もり | `estimate` | 行き先のチームの尺度に最も近い値（[issues-and-workflow.md](issues-and-workflow.md) の 6.2 節）。尺度が無効なら捨てる |
| 元の識別子・URL | 本文の末尾の注記と、`import_items` | 元の `PROJ-42` を、取り込んだイシューの本文の末尾に「取り込み元」として残す。番号は行き先のチームで新しく振る |

- 行き先のチームは、元のプロジェクト（Jira のプロジェクト、GitHub のリポジトリ、Asana のプロジェクト、Shortcut のチーム）ごとに管理者が選ぶ。
- Triage の入り口の表（DT-ISSUE-002）の `import` の行は、「対応付けの状態を使う」にする（Triage に入れない）。[issues-and-workflow.md](issues-and-workflow.md) の 10.1 節の注記と同じ。
- 対応付けの誤り 0 件（K8）を確かめるため、試しの実行は、元の状態・優先度・担当・ラベル・親の組ごとの件数の表を出し、管理者が確かめる。

## 5. 書き込み

ADR-0044。

### 5.1 束と流量

| 項目 | 値 |
| --- | --- |
| 1 つのトランザクション | 1 つのイシューと、その本文・コメント・ラベルの付け・関連（依存の順）。200 変更を超えるイシュー（コメントが多い）は、イシューの作成と残りを分ける |
| 1 回の Writer の呼び出し（DB のトランザクション） | 200 変更まで（[sync-engine.md](sync-engine.md) の 5.2 節） |
| ワークスペースの `import` の枠 | 既定 1 秒 100 変更（1 ワークスペースの上限 300 の 3 分の 1。ADR-0054） |
| 自動の調整 | 直近 30 秒の、そのワークスペースの Writer のロックの待ちの p99 が 50ms を超えるか、`client` の送信から ack の p99 が 300ms を超えたら、枠を半分にする（下限 1 秒 10）。1 分落ち着いたら 1 秒 10 ずつ戻す |
| クラスタの同時 | 1 つの Aurora のクラスタで、同時に書くジョブは 3 まで（待ち行列） |
| 依存の順 | ラベル・プロジェクト → 親のイシュー → 子のイシュー → 関連 → 添付 |

- 見積もり（K8：イシュー 1 万件を 30 分以内）：1 イシューあたり、イシュー・本文・コメント 3・ラベルの付け 2 で約 6 変更、1 万件で 6 万変更。1 秒 100 変更で 10 分。取り出し（Jira の検索 100 件ずつで約 100 回、コメントを含めて数百回）と添付の取り出しを合わせて 30 分に収まる見込み。E11 の受け入れ試験で測る。
- 添付の中身は、イシューの書き込みの後に別のキューで取り出す。`Attachment` は `pending` で作り、中身を置いたら `ready` にする（[editor-and-descriptions.md](editor-and-descriptions.md) の 8.2 節と同じ状態）。

### 5.2 Writer での扱い（`origin = import`）

DT-IMPORT-002。`origin = import` のトランザクションだけに許すこと。

| # | 項目 | 普通 | `import` |
| --- | --- | --- | --- |
| 1 | `created_at` | Writer の確定の時刻（`server_only`） | 操作の値を受ける（今より 1 日先まで。過去の制限なし） |
| 2 | 作者（`creator_id`、コメントの `author_id`） | `actor` | 操作の値を受ける（そのワークスペースの `User`） |
| 3 | `completed_at`・`canceled_at` | 派生（ADR-0025） | 操作の値を受ける。なければ派生 |
| 4 | Triage の入り口 | DT-ISSUE-002 | 操作の `state_id` のまま |
| 5 | 通知 | 通知係が作る | 作らない（通知係が `origin = import` を飛ばす） |
| 6 | Webhook | 送る | `include_import` の Webhook だけ（[api-and-webhooks.md](api-and-webhooks.md) の 5.3 節） |
| 7 | 検索の索引 | `search-index` | `search-bulk`（[search.md](search.md) の 10 節） |
| 8 | Slack のチャンネルへの通知、連携の自動化 | 送る | 送らない |
| 9 | `IssueHistory` | 変更ごと | 作成の 1 行だけ（`{k: "import", job}`） |

- `can(actor, …)` は `actor`（取り込みを行う管理者）で判定する。行 2 で作者に別の人を書けるのは、管理者が対応付けで決めたためで、`actor` の権限を広げるものではない。管理者が書けないチーム（メンバーでない非公開のチーム）には取り込めない。
- 番号（`ENG-123`）は普通どおり Writer が振る。

### 5.3 ID と冪等

- **モデルの ID**：`uuidv7_from(元の created_at, SHA-256(workspace_id ‖ source_key ‖ 記録の種類 ‖ source_id))`。上位 48 ビットに元の作成の時刻（ミリ秒）、版の 4 ビットに 7、残りにハッシュを入れる。RFC 9562 の UUIDv7 の形を満たし（[data-model-and-schema.md](data-model-and-schema.md) の 5.1 節の検証を通る）、同じ記録からは同じ ID ができる。
- **`client_tx_id`**：同じ作り方で、`(job の source_key, 束の最初の記録)` から作る。時刻の部分は取り込みを始めた時刻にする（`tx_results` の 90 日の保持に入れるため。元の古い時刻にすると保持の計算から外れる）。
- **やり直し**（本家と同じく、取り込み済みを飛ばす）：同じ `source_key` の 2 回目のジョブは、`import_items` にある記録を飛ばす。落ちたジョブの続きは、同じ `client_tx_id` で送り直し、`tx_results` の結果を受ける（ADR-0006）。`import_items` にないのに `duplicate_id` で拒否された記録は、前の実行で作られたものとして `import_items` に書き足す。
- `import_items(workspace_id, source_key, kind, source_id) → model_id, job_id, content_hash`。取り込みの後に元が変わったかを、次のジョブで数えて示す（上書きはしない。MVP）。

### 5.4 同期への影響

- 取り込みの変更は、普通の差分としてオンラインのクライアントに届く。1 秒 100 変更なら、差分の配信の負荷は小さい。
- オフラインのクライアントが戻った時に、`head − L > 50,000`（[sync-engine.md](sync-engine.md) の 9.4 節の行 5）でやり直しになりうる。受け入れる（取り込みはワークスペースの始めに多く、利用者が少ない）。
- 取り込みの前に、ワークスペースの全体・部分の切り替え（[bootstrap-and-partial-sync.md](bootstrap-and-partial-sync.md) の 4.1 節）の数の見積もり（`workspace_stats`）を、取り込みの後の数で更新する。

## 6. 取り消し

- `done` から 7 日以内に、管理者が取り消せる。
- Worker は、ジョブの `import_items` の行を、依存の逆の順に消す（`origin = import` のシステムのトランザクション、同じ流量の枠）。
- **取り込みの後に人が触れた行は消さない**：行の `updated_sync_id` が、ジョブの最後の書き込みの `sync_id` より大きく、その変更の `origin` が `import` でなければ、その行（とその子）を残し、一覧で示す。
- 消し方はモデルの `delete` の方式に従う（イシューはゴミ箱に入れ、30 日後に消える。[issues-and-workflow.md](issues-and-workflow.md) の 4.5 節）。取り込みで作ったラベル・プロジェクトは、使われていなければ消す。
- 7 日を過ぎたら取り消せない（本家も期間を限る。期間の長さは**未検証**）。

## 7. 書き出し

ADR-0045。

| 種類 | 誰が | 範囲 | 形 |
| --- | --- | --- | --- |
| ビュー・チーム・プロジェクトの CSV | `owner`・`admin`・`member`（ゲストは否） | そのビューの条件の結果のうち、頼んだ人が読める行。5,000 件まで | CSV（UTF-8、BOM 付き。Excel での文字化けを避ける） |
| ワークスペースの JSON | `owner`・`admin` | 頼んだ人が読める全部のモデル（公開のチーム、参加している非公開のチーム、ワークスペースの行）。本文は Markdown、添付は一覧（URL は含めない） | NDJSON（モデルごとのファイル）を zip |

- **権限**：Worker は、頼んだ人の主体の `groupsFor` で絞って reader から読む（[api-and-webhooks.md](api-and-webhooks.md) の 3.3 節と同じ `packages/query`）。管理者も、メンバーでない非公開のチームの中身は書き出せない（DT-PERM-001 の行 4 と同じ）。本家の「非公開のチームを含める」と違いうる（2.1 節）。
- **CSV の式の注入**：値の先頭が `=`・`+`・`-`・`@`・タブ・改行なら、先頭に `'` を付ける。全部の値を `"` で囲み、中の `"` は 2 つにする（OWASP の CSV Injection の対策）。OWASP は、Excel で保存し直すと `'` が外れうると書く。その対策（先頭にタブを入れる）は値を変えるので採らない。
- **置き場所**：S3 の `ws/<workspace_id>/exports/<job_id>/…`（KMS で暗号化、非公開のバケット）。24 時間で消す（ライフサイクル）。
- **取り出し**：画面の通知（アプリの中）と、メール（リンクはアプリの URL `https://<brand>.<domain>/exports/<job_id>` だけ。署名付きの URL をメールに入れない）。取り出しの時にセッションで頼んだ本人かを確かめ、5 分の署名付きの URL へ 302 で転送する（添付の配りと同じ。[editor-and-descriptions.md](editor-and-descriptions.md) の 8.3 節）。
- 書き出しは監査ログに残す（[security.md](security.md) の 6 節）。
- 手元の書き出し（選んだイシューを Markdown でコピー）は、クライアントの手元のモデルから作る（[client-app.md](client-app.md) の 14 節のクリップボードの規則）。サーバーのジョブにしない。

## 8. 障害のときの振る舞い

| 事象 | 起きること | 備え |
| --- | --- | --- |
| 元の API の 429・障害 | 取り出しが遅れる | `Retry-After`、指数の待ち、cursor からの再開 |
| 元の認証が途中で切れた | 取り出しが止まる | `failed`。管理者が認証を入れ直して続ける |
| Worker が書き込みの途中で落ちた | 束の途中 | 同じ `client_tx_id` で送り直す。`tx_results` で前の結果 |
| Writer のロックの待ちが伸びる | 利用者の操作が遅くなる | 5.1 節の自動の調整、`paused` |
| 取り込みの誤り（対応付けの誤り） | 大量の誤ったイシュー | 7 日以内の取り消し。試しの実行の件数の表で事前に見る |
| 書き出しの途中の権限の変化 | 途中から見てよくなくなった行 | 読む時の `groupsFor` は、ジョブの始めに決め、ジョブの間に停止・脱退があればジョブを失敗にする（5 分ごとに主体を確かめる） |
| 書き出しのファイルの取り出しの URL の漏れ | 5 分の間に読まれる | 期限 5 分、メールに URL を入れない |

## 9. セキュリティ

- **認証**：元のツールのトークンは暗号で持ち、ジョブの後に消す。ログに出さない。
- **SSRF**：Jira のサイトの URL（`https://<名前>.atlassian.net` の形だけ）、GitHub・Asana・Shortcut は決まった宛先。egress の経路から送る（[infrastructure.md](infrastructure.md) の 2 節）。添付の取り出しの URL は元の API が返したものだけを、同じ宛先の検査で読む。
- **CSV の上げ**：大きさの上限、文字コードの判定、式の注入の考慮（取り込みの側では、値を文字として扱い、評価しない）。
- **権限**：取り込みは管理者だけ、管理者が書けるチームだけ。書き出しは頼んだ人が読める行だけ。
- **個人データ**：元のツールの利用者（本システムのワークスペースにいない人を含む）の名前・メールアドレスを取り込む。結ばない人の名前は本文の注記に残る。**法務の L3（他社のツールの規約と、取り込んだ個人データの扱い）の結論まで、E11 のインポートの spec を承認しない**（[intent.md](../intent.md)）。
- **テストのデータ**：取り込みの試験のデータは合成する。実在の会社の Jira・GitHub のデータを使わない（AGENTS.md）。

## 10. テスト

- 表駆動テスト：DT-IMPORT-001（対応付け）、DT-IMPORT-002（`origin = import` の扱い）の全行。
- 性質ベーステスト：
  - **PROP-IMPORT-001（冪等）**：任意の記録の集まりと、任意の時点での落ち・やり直しの列で、取り込みの後のモデルの集合は、1 回で通した結果と同じ。重複の行がない。
  - **PROP-IMPORT-002（取り消しの安全）**：任意の取り込みと、その後の人の変更の列で、取り消しは人が触れた行とその子を消さず、それ以外の取り込んだ行をすべて消す。
  - **PROP-IMPORT-003（対応付けの保存）**：任意の記録と対応付けで、取り込んだイシューの状態・優先度・担当・ラベル・親は、対応付けの表の写しと一致する（K8 の「対応付けの誤り 0 件」）。
  - **PROP-EXPORT-001（見てよい行だけ）**：任意の主体・ビューで、書き出しの行の集合は、同じ主体の公開 API の結果と等しい。
- 契約のテスト：各元の API の応答の例（公開の文書の例から合成したもの）を固定して、アダプターの正規化を比べる。本物の相手を CI で呼ばない。
- 負荷（E11 の受け入れ試験、E12）：合成した Jira の模擬のサーバー（イシュー 1 万件、コメント 3 万件、添付 2,000 件）から 30 分以内。同時に、同じワークスペースで利用者の操作の送信から ack の p99 が 300ms 以内（NFR-002）。

## 11. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E11 | `import-job-model` | 3 節の `ImportJob`、状態、`import_secrets`、段置き |
| E11 | `import-adapter-jira` | Jira Cloud の取り出しと正規化（ADF → Markdown）。**法務の L3 の後に承認** |
| E11 | `import-adapter-github` | GitHub Issues。**法務の L3 の後に承認** |
| E11 | `import-adapter-asana` | Asana。**法務の L3 の後に承認** |
| E11 | `import-adapter-shortcut` | Shortcut。**法務の L3 の後に承認** |
| E11 | `import-csv` | CSV の 2 つの形、文字コードの判定 |
| E11 | `import-mapping-ui` | 4 節の対応付けと試しの実行の件数の表 |
| E11 | `import-commit-throttled` | 5 節の束、枠、自動の調整、ID の作り方、DT-IMPORT-002 |
| E11 | `import-attachments` | 添付の取り出しと `ready` |
| E11 | `import-undo` | 6 節 |
| E11 | `export-csv` | 7 節の CSV、式の注入の対策 |
| E11 | `export-workspace-json` | 7 節の JSON |

## 12. 未解決の問い

- 取り込みを Writer に通すか、別の一括の経路（DB への直接の書き込みと、`sync_actions` の一括の生成）にするか。
- 書き込みの束の大きさと流量。
- やり直しの冪等をどう作るか。
- スプリントをサイクルに写すか。
- 取り消しの範囲。
- 管理者の書き出しに、メンバーでない非公開のチームを含めるか。

### 決定

2026-09-28 の既定案。E11 の受け入れ試験で覆りうる。

- **経路**：Writer を通す（ADR-0044）。検証・派生・`sync_actions`・差分を普通の書き込みと同じにし、別の経路の正しさの試験を持たない。
- **束と流量**：200 変更、1 秒 100 変更、ロックの待ちで半分（ADR-0044）。
- **冪等**：元の記録から決まる UUIDv7 と `import_items`（ADR-0044）。
- **スプリント**：ラベル（4 節）。
- **取り消し**：7 日、人が触れていない行だけ（ADR-0044）。
- **書き出し**：読める行だけ（ADR-0045）。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| スプリントをサイクルに写すか | 試用の声。サイクルの規則（固定の長さ）を崩さずに写す方法が要る |
| 取り込みの後の元の変更の反映（差分の取り込み） | MVP の後 |
| Jira の点の枠（アプリのトラフィック）に当たるか | 本システムは API のトークンで読むので当たらない想定。E11 で確かめる |
| 本家の取り消しの期間、取り込みの時間 | **未検証**のまま、本システムの値 |
| 書き出しの件数の上限（5,000）の妥当さ | E11 の試用 |

## 13. quality.md・runbooks・data-model への項目

### quality.md

- DT-IMPORT-001・002 の表駆動テストと PROP-IMPORT-001〜003、PROP-EXPORT-001 を E11 のリリースの基準にする。PROP-EXPORT-001 は NFR-008 の試験の一部にする。
- K8 の受け入れ試験（Jira の模擬のイシュー 1 万件を 30 分以内、対応付けの誤り 0 件）を E11 のリリースの基準にする。
- 本番：取り込みの件数・時間・失敗の率（元ごと）、自動の調整で枠を下げた回数、取り込みの間の同じワークスペースの送信から ack の p99。
- 本番：取り消しの回数と、人が触れて残した行の数。

### runbooks

- `import-stuck.md`：取り込みが進まないときの確かめ方（元の 429、認証の切れ、Writer の枠）と、止め方・続け方。
- `import-degrades-workspace.md`：取り込みで同じワークスペースの操作が遅いときの、枠の手動の引き下げと `paused`。
- `import-undo-request.md`：7 日を過ぎた取り消しの依頼への対応（`import_items` からの手動の取り消しの判断）。

### data-model（索引への追加の提案）

| 表・モデル | 中身 | 節 |
| --- | --- | --- |
| `import_jobs`（`ImportJob`） | 取り込みのジョブと進み（`role:admin`） | 3 |
| `import_mappings`（サーバーだけ） | 対応付け | 4 |
| `import_items`（サーバーだけ） | 元の記録 → モデルの ID | 5.3 |
| `import_secrets`（サーバーだけ） | 元の認証の暗号文（ジョブの後に消す） | 3 |
| `export_jobs`（`ExportJob`） | 書き出しのジョブ（`user:<id>`） | 7 |
| S3 `ws/<workspace_id>/imports/…`・`exports/…` | 段置き（30 日）、書き出し（24 時間） | 3、7 |
| data-model-and-schema・sync-engine への依頼（反映済み。[data-model.md](data-model.md) の 9 節） | `origin = import` の Writer の扱い（DT-IMPORT-002）：`created_at`・作者・`completed_at` を操作の値で受ける | 5.2 |
| issues-and-workflow への依頼（反映済み。[data-model.md](data-model.md) の 9 節） | `Issue.creator_id` が `server_only` なら、`import` で受ける例外を DT-ISSUE の表に足す | 5.2 |

## 出典

いずれも 2026-09-28 に確認。

- Linear Docs, [Import issues](https://linear.app/docs/import-issues)、[Exporting data](https://linear.app/docs/exporting-data)
- Atlassian Developer, [Jira Cloud platform: Rate limiting](https://developer.atlassian.com/cloud/jira/platform/rate-limiting/)
- GitHub Docs, [Rate limits for the REST API](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
- Asana Developers, [Rate limits](https://developers.asana.com/docs/rate-limits)
- Shortcut, [REST API v3](https://developer.shortcut.com/api/rest/v3)
- OWASP, [CSV Injection](https://community.owasp.org/attacks/CSV_Injection)

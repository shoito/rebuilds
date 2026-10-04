# Data model: Aurora の外（Git・Valkey・S3・検索の索引・Event）

[data-model.md](../data-model.md) の一部。Aurora のテーブルの外に置くデータの形を定める。どれも、正本か、正本から作り直せるかを [data-model.md](../data-model.md) の 1 節に書いた。

- 名前の `<brand>` はリポジトリ共通の [ADR-0006](../../../../../docs/decisions/0006-brand-neutral-identifiers.md) の置き換え用の名前。バケット名などの実際の名前は、開発リポジトリの作成時に決める。
- キー・パスは名前ではなく ID から作る。名前の変更・移管でキーが変わらない。
- S3 のキーは、消去のジョブが前方一致で消せるよう、リポジトリかネットワークの ID を先頭の近くに置く（[ADR-0027](../../decisions/0027-artifact-and-cache-storage.md)）。

## 1. Git のストレージ

正本。3 つのノードに同じ形で置く。出典：[git-storage.md](../git-storage.md) の 3.3・7・8 節、[ADR-0007](../../decisions/0007-fork-network-object-sharing.md)。

### 1.1 ディスク上の配置

```
/data/networks/<network_id の下 2 桁>/<network_id>/
  network.git/                      # 共有の objects。bare
    objects/pack/                   # 保守で集めたパック、multi-pack index、ビットマップ、commit-graph
    refs/networks/<repo_id>/...     # 各リポジトリの ref の写し（到達可能性の根。広告しない）
  <repo_id>.git/                    # 各リポジトリ（fork を含む）。bare
    objects/info/alternates         # ../network.git/objects
    objects/                        # まだ network.git へ移していない objects
    refs/ packed-refs HEAD          # このリポジトリの ref
    gitd/checksum                   # ref のチェックサム（32 バイト、16 進で 64 文字）
  tmp/                              # 修復・repack の作業領域、push の検疫
/data/pack-cache/<hash>             # pack-objects の出力のキャッシュ（5 分）
```

- `<network_id>`・`<repo_id>` は `repository_networks.id`・`repositories.id`（[git-storage-metadata.md](git-storage-metadata.md)）。
- `gitd/checksum` は、全 ref の `SHA-256(refname || 0x00 || value)` の XOR。DB の `repository_checksums.checksum` と比べる。定期の照合では、ファイルではなく ref の一覧から計算し直した値を使う。
- push の objects は、ref の更新の前に `tmp/` の検疫の領域に入り、`prepare` の中で本体へ移す（[git-protocols.md](../git-protocols.md) の 5 節）。

### 1.2 ref の名前空間

| 名前空間 | 中身 | 利用者の push | 広告 |
| --- | --- | --- | --- |
| `refs/heads/*`、`refs/tags/*` | ブランチとタグ | できる（ruleset を通す） | する |
| `HEAD` | 既定のブランチの指し先。チェックサムに含める | 設定の API で変える | する |
| `refs/pull/{number}/head` | PR の head の写し | できない | する（本家と同じ） |
| `refs/pull/{number}/merge` | テストマージのコミット | できない | しない（`uploadpack.hideRefs`） |
| `refs/heads/<brand>-readonly-queue/{base}/pr-{number}-{head_sha}` | merge queue のグループ | できない | する（CI が取るため） |
| `refs/networks/<repo_id>/*`（`network.git` だけ） | ネットワークの到達可能性の根 | — | しない |

- `refs/pull/` と `<brand>-readonly-queue/` への利用者の push は、ruleset の評価の前に Git フロントエンドが拒否する（[pull-requests.md](../pull-requests.md) の 1.1・8.1 節）。

## 2. Valkey

正本ではない。失っても DB から作り直せる。権限の判定は、Valkey が使えないとき DB を直接読む（fail-open にしない）。出典：[identity-and-permissions.md](../identity-and-permissions.md) の 9 節、[api-and-webhooks.md](../api-and-webhooks.md) の 11 節、[actions.md](../actions.md) の 5.2・6.2・10.1 節、[notifications.md](../notifications.md) の 8 節、[pull-requests.md](../pull-requests.md) の 14 節。

| キー | 型 | 中身 | TTL | 書く・読む |
| --- | --- | --- | --- | --- |
| `perm:{user_id}:{repo_id}:{epoch}` | string | 実効のロールと、ブロック・方針の結果 | 5 分 | `packages/authz`。`epoch` は `permission_epochs` の世代を連ねた値 |
| `authz:revocations`（チャネル） | pub/sub | 失効したトークンのハッシュ | — | 失効の API が送り、各タスクのメモリのキャッシュ（30 秒）を消す |
| `route:{repo_id}` | hash | `network_id`、`healthy` の複製のノード、`checksum`、`version` | 5 秒 | Git フロントエンド・Web・API。ノードの喪失は `route:invalidate` のチャネルで即時に消す |
| `rl:{resource}:{subject}` | string | GCRA の TAT | 割り当ての周期 | レート制限。`resource` は `core`・`graphql`・`search`・`git` など |
| `rlc:{subject}` | sorted set | 進行中の要求（同時の要求の上限 100） | 60 秒 | レート制限 |
| `notify:email:{user_id}`、`notify:email:{user_id}:{thread_id}` | string | メールのトークンバケット | 1 時間 | 通知の送信。使えなければ制限なしで送る |
| `hook:inflight:{hook_id}` | string | 宛先ごとの同時の配信の数（20） | 60 秒 | hook-delivery |
| `hook:health:{hook_id}` | hash | 直近 1 時間の成功・失敗の数（回路遮断） | 1 時間 | hook-delivery |
| `diffstats:{network_id}:{merge_base_sha}:{head_sha}:{opts_hash}` | string（圧縮） | 差分のファイルの一覧と行数 | 7 日（追い出しだけ） | PR の画面。本文は S3（3 節） |
| `mergeability:lock:{network_id}:{base_sha}:{head_sha}` | string | 計算中の Worker | 15 秒 | 同じキーの計算を 1 つにまとめる |
| `codeowners:{repo_id}:{blob_sha}` | string | 解析した CODEOWNERS | 1 日 | PR の Worker |
| `aq:{label}:owners` | sorted set | 待ちのある持ち主（Deficit Round Robin の順） | なし | Scheduler。失ったら `workflow_jobs` から作り直す |
| `aq:{label}:{owner_id}` | list | 持ち主の `queued` のジョブの ID（FIFO） | なし | Scheduler・Broker |
| `aq:deficit:{label}` | hash | 持ち主ごとの deficit | なし | Scheduler |
| `alog:{job_id}` | stream | ライブのログ（直近 10,000 行） | 1 時間 | Log service が `XADD`、画面が SSE で読む（`can()` の後） |
| `amask:{job_id}` | set | シークレットの値の部分文字列の HMAC | ジョブの上限（6 時間） | Log service のマスクの二重の確認 |

- キーに利用者の名前・リポジトリの名前を入れない（ID だけ）。
- 非公開のリポジトリの中身の断片（ログ、差分の統計）を持つキーは、読み取りの前に必ず `can()` を通す。

## 3. S3

バケットの名前は仮。どれも SSE-KMS（CMK は [ADR-0028](../../decisions/0028-encryption-and-key-management.md) の種類ごと）、パブリックアクセスを遮断する。

| バケット（仮） | キーの形 | 中身 | 保持・削除 | 正本か |
| --- | --- | --- | --- | --- |
| `<brand>-lfs`（東京、大阪へ複製） | `lfs/{network_id}/{oid の先頭 2 文字}/{oid}` | LFS の objects | ネットワークの全リポジトリの消去の後 | 正本 |
| `<brand>-git-backup`（大阪、Object Lock 35 日） | `git/{hash2(network_id)}/{network_id}/full/{created_at}.bundle`・`.refs.json`、`git/{hash2(network_id)}/{network_id}/repos/{repo_id}/incr/{version}.bundle`・`.refs.json` | Git のバックアップ（全体はネットワーク、増分はリポジトリ） | 35 日。最新の完全な復元点は残す（消去したリポジトリを除く） | 復元の元 |
| `<brand>-actions`（東京） | `logs/{repo_id}/{run_id}/{job_id}/{attempt}/{step}.log.zst`、`artifacts/{repo_id}/{run_id}/{artifact_id}`、`caches/{repo_id}/{cache_id}`、`actions/{repo_id}/{sha}.tar.gz` | ログ・成果物・キャッシュ・解決したアクションのアーカイブ | DB の期限で削除のジョブ。ライフサイクルは 401 日の上限。キャッシュは 7 日 | 成果物・ログは正本 |
| `<brand>-objects`（東京、大阪へ複製） | `releases/{repo_id}/{release_id}/{asset_id}`、`attachments/{repo_id}/{uuid}`、`avatars/{owner_id}/{sha256}` | リリースの成果物、Issue・PR の添付、アバター | リポジトリの消去で前方一致で消す | 正本 |
| `<brand>-diff-cache`（東京） | `diffs/{network_id}/{merge_base_sha}/{head_sha}/{opts_hash}/{path_sha256}` | ファイルごとの差分の本文 | 30 日 | キャッシュ |
| `<brand>-bundles`（東京、CloudFront） | `bundles/{repo_id}/{creation_token}.bundle` | bundle-uri の bundle（公開のリポジトリだけ） | `repository_bundles` に従う | キャッシュ |
| `<brand>-code-index`（東京） | `code-index/{repo_id}/{commit_sha}/{shard_no}.zoekt` | Zoekt のシャード | 置き換えで消す | キャッシュ |
| `<brand>-hook-payloads`（東京） | `payloads/{yyyy-mm-dd}/{guid}.json.zst` | Webhook のペイロード（事象の時点の写し） | 3 日 | 再配信の元 |
| `<brand>-events`（東京） | `events/{repo_id}/{version}.json.zst` | `updates` が 1,000 件を超えた `repository.refs_updated` の本体 | 7 日 | Event の一部 |
| `<brand>-inbound-email`（東京） | `inbound/{message_id}` | SES が受けたメールの原本 | 7 日 | 再処理の元 |
| log-archive のアカウント（Object Lock のコンプライアンスモード） | `audit/{organization_id か platform}/{yyyy}/{mm}/{dd}/{hh}.jsonl.zst`、`audit-digests/{yyyy}/{mm}/{dd}/{hh}.sig` | 監査ログのアーカイブと 1 時間ごとの署名したダイジェスト | 400 日 | 正本（アーカイブ） |
| 同上 | `access/dt={yyyy-mm-dd}/hour={hh}/part-*.parquet` | 内部のアクセスログ（Firehose） | 90 日 | 正本 |

- `hash2(network_id)` は ID のハッシュの先頭 2 桁で、大阪のバケットへの PUT を接頭辞に散らす（[capacity.md](../capacity.md) の 3.7 節）。
- 添付・アバターはテーブルを持たない。キーの `repo_id` で `can()` を行い、`media.<brand>usercontent.<domain>` の署名付き URL で配る（[web.md](../web.md) の 5 節）。
- アクセスログの列：`ts`、`service`、`token_id`、`actor_type`、`actor_id`、`org_id`、`repo_id`、`operation`（`git.clone`・`git.fetch`・REST の操作）、`ip`、`user_agent`、`status`、`bytes_sent`、`bytes_received`、`request_id`。本文・トークンの値を入れない（[ADR-0029](../../decisions/0029-audit-log.md)）。

## 4. 検索の索引

正本ではない。権限の条件の項目（`repo_id`、`owner_id`、`visibility`、`enterprise_id`）を必ず持つ（[ADR-0015](../../decisions/0015-search-permission-filtering.md)）。出典：[search.md](../search.md) の 3・5 節。

### 4.1 OpenSearch の `issues`（別名。実体は `issues-v1`）

Issue と PR を 1 つのインデックスに置く。ルーティングのキーは `repo_id`。書き込みは `search_version` を外部のバージョンにする。

| 項目 | 型 | 備考 |
| --- | --- | --- |
| `repo_id`、`owner_id`、`enterprise_id` | long | 権限の条件 |
| `visibility` | keyword | `public`・`private`・`internal` |
| `issue_id`、`number` | long | |
| `kind` | keyword | `issue`・`pr` |
| `title`、`body` | text（`english`）＋ `.cjk`（ICU の分割と CJK の bigram） | |
| `comments_text` | text（同上） | コメントを連結し 1 MiB で切る |
| `state`、`state_reason`、`review_state` | keyword | |
| `is_merged`、`is_draft`、`locked` | boolean | |
| `author_id`、`assignee_ids`、`commenter_ids`、`mentioned_ids`、`involves_ids`、`review_requested_ids`、`reviewed_by_ids` | long | |
| `label_ids`、`milestone_id`、`type_id`、`parent_issue_id` | long | |
| `label_names`、`milestone_title`、`type_name` | keyword（小文字の正規化） | |
| `language` | keyword | リポジトリの主な言語 |
| `created_at`、`updated_at`、`closed_at`、`merged_at` | date | |
| `comments_count`、`reactions_count` | integer | |
| `search_version` | long | |
| `deleted` | boolean | tombstone。7 日後に消す |

### 4.2 OpenSearch の `repos`（別名。実体は `repos-v1`）

| 項目 | 型 | 備考 |
| --- | --- | --- |
| `repo_id`、`owner_id`、`enterprise_id` | long | 権限の条件 |
| `visibility` | keyword | |
| `full_name`、`name` | text ＋ keyword | |
| `description`、`readme` | text（`english`）＋ `.cjk` | `readme` は先頭 64 KiB |
| `topics`、`language`、`license` | keyword | |
| `stars`、`forks`、`size` | integer | |
| `archived`、`is_fork`、`is_template` | boolean | |
| `created_at`、`pushed_at` | date | |
| `search_version` | long | リポジトリの行の更新ごと |

### 4.3 Zoekt のシャード

- 1 つのリポジトリのデフォルトブランチの内容を、1 つ以上のシャード（1 つ 4 GB 未満）にする。
- シャードのリポジトリの属性に、`repo_id`、`owner_id`、`visibility`、`enterprise_id`、`archived`、`fork`、`stars`、`full_name`、`commit_sha` を持たせる。router は権限の条件を、これらと `RepoIDs`（roaring のビットマップ）の条件の木に変える。
- ファイルの属性に `language`、`vendored`、`generated` を持たせる（`is:vendored`・`is:generated`）。

## 5. Event

outbox の行（[platform.md](platform.md)）が Relay で SQS のメッセージになる。メッセージには ID と最小の値だけを入れ、Worker は本体を DB から読む。Webhook のペイロードは、hook-dispatch が事象の時点の DB から作って S3 に置く。

### 5.1 SQS のメッセージの形

```json
{
  "event_id": 987654321,
  "type": "issue_comment.created",
  "repo_id": 42,
  "occurred_at": "2026-09-28T09:00:00.000Z",
  "payload": { "issue_id": 1001, "comment_id": 5555, "actor_id": 7 }
}
```

- メッセージ属性に `traceparent` を入れる（[observability.md](../observability.md) の 2 節）。
- `event_id` は `outbox.id`。受信箱の `last_event_id`、メールの冪等の記録の `event_id` に使う。

### 5.2 主な Event の `payload`

| `type` | `payload` | 順序 | 受け手 |
| --- | --- | --- | --- |
| `repository.refs_updated` | `repository_id`、`network_id`、`version`、`pusher {type, id}`、`via`、`updates [{ref, before, after, forced}]`（1,000 件を超えたら `updates_key`）、`occurred_at` | リポジトリごとの `version` | ref の写し、PR、コード検索、Webhook の `push`、Actions、バックアップ、bundle |
| `repository.created`・`renamed`・`transferred`・`visibility_changed`・`archived`・`deleted`・`restored` | `repository_id`、変更の前後の値 | — | 検索（除外の片付け）、Webhook の `repository`、権限のキャッシュ |
| `membership.changed` | `scope`（`org`・`team`・`repo`）、`scope_id`、`user_id`、前後のロール | — | 権限のキャッシュ、Webhook の `member`・`membership`、非公開の fork の削除 |
| `issue.opened`・`edited`・`closed`・`reopened`・`deleted`・`transferred`・`labeled`・`assigned` など | `issue_id`、`number`、`actor_id`、`changes` | — | 通知、検索、Webhook |
| `issue_comment.created`・`edited`・`deleted` | `issue_id`、`comment_id`、`actor_id` | — | 通知、検索、Webhook |
| `pull_request.<action>` | `pull_request_id`、`number`、`seq`、`actor_id`。`synchronize` は `before`・`after` | PR ごとの `seq` | 通知、検索、Webhook、Actions |
| `pull_request_review.<action>`・`pull_request_review_comment.<action>`・`pull_request_review_thread.<action>` | `pull_request_id`、`review_id`・`comment_id`・`thread_id`、`seq` | PR ごとの `seq` | 通知、Webhook |
| `merge_group.checks_requested`・`destroyed` | `group_id`、`base_ref`、`head_sha`、`base_sha` | — | Actions、Webhook |
| `check_run.<action>`・`check_suite.<action>`・`status.created` | `check_run_id` など、`head_sha` | — | PR の判定、自動マージ、merge queue、Webhook |
| `workflow_run.<action>`・`workflow_job.<action>` | `run_id`・`job_id`、`status`、`conclusion` | — | チェック、通知（`ci_activity`）、Webhook |
| `ruleset.changed` | `ruleset_id`、`source_type`、`source_id`、`version` | — | Git フロントエンドのキャッシュ |
| `release.<action>` | `release_id`、`tag_name` | — | 通知、Webhook |

### 5.3 Webhook の要求

- ヘッダー：`X-<Brand>-Event`、`X-<Brand>-Delivery`（`webhook_deliveries.guid`）、`X-<Brand>-Hook-ID`、`X-<Brand>-Hook-Installation-Target-Type`・`-ID`、`X-<Brand>-Signature-256`（`sha256=` ＋ HMAC-SHA256 の 16 進）、`User-Agent`、`Content-Type`（[api-and-webhooks.md](../api-and-webhooks.md) の 9.2 節）。
- 本文：事象ごとの形は本家に寄せる。共通の最上位の項目は `action`、`sender`、`repository`、`organization`、`installation`。Webhook に固定した REST のバージョン（`webhooks.api_version`）の変換を受ける。
- 本文は事象の時点の写し。送る直前の権限の確認（[api-and-webhooks.md](../api-and-webhooks.md) の 9.4 節）で満たさなければ送らず、`skipped` と記録する。

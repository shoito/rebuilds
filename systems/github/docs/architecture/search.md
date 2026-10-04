# Search: GitHub

コード検索と、リポジトリ・Issue・Pull Request の検索。コード検索は Zoekt（位置付きの trigram の索引）をリポジトリの単位のシャードで独立したクラスタに置き、Issue・Pull Request・リポジトリの検索は OpenSearch に置く（[ADR-0014](../decisions/0014-code-search-engine.md)）。権限は、公開の種類とリポジトリの ID の集合でクエリの前段に入れ、結果を後から除く方式を取らない（[ADR-0002](../decisions/0002-repository-permission-model.md)、[ADR-0015](../decisions/0015-search-permission-filtering.md)）。

本家の振る舞いに寄せる。本家の文書で確かめられなかった点は「未検証」と書く。

## 1. 範囲

| 対象 | エンジン | 索引の正本 |
| --- | --- | --- |
| コード（デフォルトブランチのファイルの中身とパス、シンボル） | Zoekt | Git（ADR-0005） |
| Issue・Pull Request（タイトル、本文、コメント、属性） | OpenSearch | DB |
| リポジトリ（名前、説明、トピック、README の冒頭、属性） | OpenSearch | DB と Git |

- 利用者・Organization・コミット・Discussions・Wiki の検索は MVP の範囲外。
- 検索できるのは、検索した人がその時点で読めるリポジトリの中身だけ（4 節）。

## 2. 本家のコード検索

本家は、Rust で作った専用のエンジン Blackbird を使う（[The technology behind GitHub's new code search](https://github.blog/engineering/architecture-optimization/the-technology-behind-githubs-new-code-search/)）。

- 固定の trigram ではなく、可変長の ngram（sparse grams）の索引。
- シャードは Git の blob のオブジェクト ID で分ける。同じ内容（fork など）を 1 回だけ索引し、ホットなシャードを避ける。
- 公表の時点で、4,500 万のリポジトリ、115 TB のコード、155 億の文書。重複を除いて 28 TB、索引は内容の写しを含めて 25 TB。取り込みは 1 秒に約 12 万文書。シャード 1 つの p99 は約 100 ms、64 コアのホスト 1 台で約 640 クエリ/秒。
- Kafka で索引の作業を調整し、Redis で割り当てとアクセス制御のキャッシュを持つ。クエリはすべてのシャードに広げ、集めてから並べ直し、**権限で絞る**。

本設計は、これを小さなチームで作れる形に置き換える（ADR-0014）。権限の絞り込みは、本家と違い、シャードへの問い合わせの前に行う（ADR-0015）。

## 3. コード検索

### 3.1 索引の対象

本家の規則（[About GitHub code search](https://docs.github.com/en/search-github/github-code-search/about-github-code-search)）に合わせる。

| 規則 | 値 |
| --- | --- |
| ブランチ | デフォルトブランチだけ |
| ファイルの大きさ | 350 KiB を超えるものは除く |
| 行の長さ | 1,024 文字を超える行は切り詰める。4,096 バイトを超える行を 2 行以上持つファイルは除く |
| 種類 | 空のファイル、バイナリ、UTF-8 でないファイル、vendored と生成されたコードは除く |
| fork | 親より star の多い fork だけ索引する（旧コード検索の規則。[Searching in forks](https://docs.github.com/en/enterprise-server@3.5/search-github/searching-on-github/searching-in-forks)。新しいコード検索の文書は「一定の条件を満たす fork は含めうる」とだけ書き、条件を公開していない。[Searching in forks](https://docs.github.com/en/search-github/searching-on-github/searching-in-forks)、2026-09-26 に確認。**未検証**） |
| アーカイブされたリポジトリ | 索引する（`is:archived` で絞れる） |

- vendored と生成の判定は、Linguist に相当する規則（go-enry）と、`.gitattributes` の `linguist-vendored`・`linguist-generated` で行う。言語の判定も同じ。
- 1 つのリポジトリで索引する内容は 2 GiB まで（本設計の値）。超えたら、パスの順に 2 GiB まで索引し、画面に「一部だけ索引されています」と出す。
- 空のリポジトリ、デフォルトブランチのないリポジトリは索引しない。

### 3.2 構成

```
push（デフォルトブランチ）─▶ Git ストレージ ─▶ outbox（ref の更新、ADR-0005）─▶ Relay ─▶ SQS code-index
                                                                                     │
                                                           ┌─────────────────────────┘
                                                           ▼
                                               code-indexer（Go、ECS）
                                                 │ ツリーと blob を RPC で読む（読み取りの複製）
                                                 │ Zoekt のシャードを作る
                                                 ▼
                                               S3（シャードの置き場、正本は Git）
                                                 │
                                                 ▼
                                       索引のノード（EC2、ローカルの NVMe）× N ◀── code-search router（Go、ECS）◀── API
```

- **code-indexer**：リポジトリの単位でシャードを作り、S3 に書き、割り当ての表を更新する。状態を持たない。
- **索引のノード**：割り当てられたシャードを S3 から取り、ローカルの NVMe に置いて mmap で読み、Zoekt の検索を提供する。1 つのリポジトリのシャードを、異なる AZ の 2 つのノードに置く（索引は Git から作り直せるので、複製は可用性のためで、耐久性のためではない）。
- **code-search router**：クエリを解析し、権限の条件（4 節）を付け、対象のノードに広げ、結果を合わせて並べ直す。
- 割り当て：`code_index_shards (repo_id, shard_no, commit_sha, s3_key, size_bytes, built_at)` と `code_index_placements (repo_id, search_node_id)`（ノードは `code_index_nodes`。列の定義は [data-model/search.md](data-model/search.md)）。リポジトリの ID の一貫性ハッシュでノードを選び、ノードの追加・故障では S3 から別のノードに置き直す。

### 3.3 増分の索引

- 対象のイベントは、デフォルトブランチの ref の更新、デフォルトブランチの変更、公開の種類の変更、リポジトリの移動・名前の変更・アーカイブ・削除。
- `code_index_state (repo_id, indexed_commit, target_commit, status, lease_until, updated_at)` を持つ。イベントは `target_commit` を進めるだけにし、リポジトリごとに 60 秒の間に来た push をまとめる（本設計の値）。
- 作業は `lease_until` で 1 台だけが取る。`target_commit` が作り終えた `indexed_commit` と違えば、作り直す。古いイベントが来ても、Git の現在の ref を読んで作るので、後退しない。
- 作り方：
  - 小さなリポジトリ（索引する内容が 100 MiB 未満）は、毎回すべてを作り直す。
  - 大きなリポジトリは、前の `indexed_commit` との差分から変わったファイルだけを作り直す（Zoekt の差分の索引（`zoekt-git-index -delta`。変わったファイルを古いシャードで墓石にする）を使う。機能があることは [cmd/zoekt-git-index](https://github.com/sourcegraph/zoekt/blob/main/cmd/zoekt-git-index/main.go) で 2026-09-26 に確かめたが、専用の文書がなく、成熟度は **未検証**。E6 の `code-search-zoekt-poc` で確かめる。使えなければ、大きなリポジトリも全体を作り直し、5 分の目標を例外として扱う）。
- 同じ blob の内容を、リポジトリをまたいで 1 回にする最適化（本家の blob の単位のシャード）は、S2 で検討する。
- 失敗したジョブは SQS の再試行に任せ、5 回でデッドレターキューへ送る。

### 3.4 反映の遅れ（NFR-005：push から 5 分以内）

| 区間 | 目安 |
| --- | --- |
| push の成功 → outbox → SQS | 数秒 |
| まとめの待ち | 最大 60 秒 |
| シャードの作成（中規模のリポジトリ） | 60 秒以内 |
| S3 への書き込み → ノードへの読み込み | 30 秒以内 |

- 指標 `code_index_lag`（ref の更新の時刻 → 両方のノードで検索できるようになった時刻）を計測する。p95 が 5 分を超える状態が 15 分続いたら、アラートを出す（runbooks の「コード索引の遅れ」）。
- 合成監視：専用のリポジトリに定期的に push し、ランダムな文字列がコード検索に出るまでの時間を測る。

### 3.5 クエリの構文

本家（[Understanding GitHub Code Search syntax](https://docs.github.com/en/search-github/github-code-search/understanding-github-code-search-syntax)）に合わせる。

| 構文 | 意味 |
| --- | --- |
| `語` | 部分一致。大文字・小文字を区別しない。空白で区切った語は AND |
| `"語 語"` | 空白を含む連続した文字列 |
| `/正規表現/` | 正規表現。`(?-i)` で大文字・小文字を区別する |
| `AND` / `OR` / `NOT`、`( )` | 論理演算とまとまり |
| `repo:owner/name`、`org:`、`user:` | リポジトリ、持ち主 |
| `language:`、`path:`（glob と正規表現） | 言語、パス |
| `symbol:` | 関数・クラスなどの定義（ctags で抜き出す） |
| `content:` | パスを除き、中身だけに一致 |
| `is:archived`、`is:fork`、`is:vendored`、`is:generated` | リポジトリ・ファイルの属性 |

- 検索文字列は 1,000 文字まで。結果は 100 件（5 ページ）まで（本家の文書と同じ）。
- 正規表現は、Zoekt の方式（リテラルを抜き出して trigram で候補を絞り、候補にだけ正規表現をかける）で評価する。リテラルを抜き出せない正規表現（`/.*/` など）は、`repo:` か `org:` で範囲を絞らない限り 422 で拒否する。
- `enterprise:`、`license:` は MVP では持たない。
- コード検索は、ログインを要する（本家の REST API はコード検索に認証を要する。[REST API の検索](https://docs.github.com/en/rest/search/search)。Web でも、公開のリポジトリを含めてコード検索にはログインが要る。[About GitHub code search](https://docs.github.com/en/search-github/github-code-search/about-github-code-search)、2026-09-26 に確認）。

### 3.6 クエリの実行

1. router がクエリを解析し、権限の条件（4.2 節）を付けた Zoekt のクエリを作る。
2. `repo:` があれば、そのリポジトリのノードだけに送る。`org:` / `user:` なら、持ち主のリポジトリの集合からノードを選ぶ。どちらもなければ、全ノードに送る。
3. 各ノードは 1 秒で打ち切る。全体は 3 秒で打ち切り、間に合ったノードの結果を返し、`incomplete_results: true` を付ける（本家の REST API と同じ形）。
4. 結果を合わせて並べ直す。並べ方は Zoekt の得点（一致の数、語の境界、シンボルの定義）に、リポジトリの star と、パスの一致を足す。重みは本設計で調整する。
5. **API は、返す前にリポジトリの ID ごとに判定関数で確かめ直す**（4.4 節）。

- ハイライトは、索引のノードが返す一致の位置で付ける。本文の抜粋は、索引に写した内容から返す。4.3 節の除外があるので、写しから権限外の内容は返らない。

### 3.7 規模の見積もり（S1）

| 項目 | 値 | 根拠 |
| --- | --- | --- |
| 索引するリポジトリ | 100 万（fork の多くを除く） | README の規模の段階 |
| 1 リポジトリの索引する内容 | 平均 2 MB | 仮定（**未検証**。文書では確かめられない。E6 の前に実データの分布で測る） |
| 内容の合計 | 約 2 TB | |
| 索引の大きさ | 約 7 TB（内容の約 3.5 倍） | Zoekt の設計文書（[design.md](https://github.com/sourcegraph/zoekt/blob/main/doc/design.md)）の「コーパスの約 3 倍、実際のシャードは約 3.5 倍」 |
| 2 つの複製 | 約 14 TB | |

- ノードの台数・メモリは、負荷試験で決める（[capacity.md](capacity.md)）。Zoekt のシャードは 1 つ 4 GB 未満（内容は約 1 GB まで）なので、大きなリポジトリは複数のシャードになる。

## 4. 権限の絞り込み

### 4.1 原則

- **読めるリポジトリの条件を、検索のクエリの中に入れる。** 後から除くと、件数・ページング・ハイライト・応答時間から、権限外の存在が漏れうる（ADR-0002、Slack の ADR-0005 と同じ）。
- 読めるリポジトリの条件は、判定関数の `accessPredicate(actor)`（[identity-and-permissions.md](identity-and-permissions.md) の 5.1 節）から作る。**`can` と同じ集合を表すことを、性質ベーステストで確かめる**（任意の主体・リポジトリ・ロール・公開の種類について、`can(actor, contents:read, repo)` と「条件に当たるか」が一致する。identity-and-permissions.md のテストと同じもの）。
- 条件は、リクエストごとに DB から作る。権限の変更（コラボレーターから外す、チームから外す、Organization から外す）は、次の検索からすぐに効く。

### 4.2 条件の形

検索する人 `u` について、読めるリポジトリを次の和で表す。

```
readable(u) = { 公開のリポジトリ }
            ∪ { internal のリポジトリ で enterprise_id ∈ E(u) }       -- u が属する enterprise
            ∪ { 非公開のリポジトリ で owner_id ∈ O(u) }                 -- u が基本の権限 read 以上を持つ Organization、u 本人
            ∪ { repo_id ∈ R(u) }                                        -- コラボレーター・チームで個別に読めるリポジトリ
            − { repo_id ∈ X }                                           -- 除外の表（4.3 節）
```

- `E(u)`・`O(u)`・`R(u)` は、`accessPredicate(u)` が返す条件そのもの。チームで入れるリポジトリは `R(u)` に展開する。持ち主の単位（`O(u)`）にまとめることで、大きな Organization の全リポジトリを ID で列挙しなくて済む。`internal` は E10 で有効になる（それまで `E(u)` は空）。
- トークン（個人用アクセストークン、App）の場合は、トークンのスコープ・対象のリポジトリで、さらに積（AND）を取る（[identity-and-permissions.md](identity-and-permissions.md)）。
- ログインしていない人は、公開のリポジトリだけ（コード検索はログインを要する）。
- **Zoekt**：各シャードに、リポジトリの属性（`repo_id`、`owner_id`、`visibility`、`enterprise_id`）を持たせる。router は上の条件を Zoekt のクエリの木（リポジトリの属性と、リポジトリの ID の集合の条件）に変換する。Zoekt は、リポジトリの ID の集合の条件（`query.RepoIDs`。roaring のビットマップ）を持つ（[query/query.go](https://github.com/sourcegraph/zoekt/blob/main/query/query.go)、2026-09-26 に確認）。大きな集合での性能は E6 の `code-search-zoekt-poc` で測る（**未検証**）。使えなければ、`R(u)` をリポジトリ名の集合の条件に置き換える。
- **OpenSearch**：文書に `repo_id`、`owner_id`、`visibility`、`enterprise_id` を持たせ、`bool.filter` の `should`（いずれか）で表す。`R(u)` の `terms` は既定の上限 65,536 件の内側に収める。超える人（個別に 6 万件以上のリポジトリを読める人）は、`org:` か `repo:` で範囲を絞るよう 422 を返す（本設計の制限）。

### 4.3 除外の表（権限の属性の変更）

索引の文書は、公開の種類と持ち主の写しを持つ。写しを更新する前に検索されると、次が漏れうる。

- 公開 → 非公開にしたリポジトリが、まだ「公開」として当たる。
- 非公開のリポジトリを別の Organization へ移したとき、元の Organization のメンバーに、まだ `owner_id` で当たる。
- internal から非公開への変更、enterprise の変更、リポジトリの削除も同じ。
- Issue を公開のリポジトリから非公開のリポジトリへ移したとき（[issues.md](issues.md) の 9 節）、元の文書がまだ公開のリポジトリの文書として当たる。

これを防ぐため：

- **権限の属性を変えるトランザクションの中で、`search_exclusions (repo_id, issue_id NULL, reason, created_at, cleared_at)` に行を書く。** リポジトリの公開の種類・持ち主・enterprise の変更と削除は `repo_id` の行、Issue の移動は `issue_id` の行にする。
- すべての検索は、`cleared_at IS NULL` の `repo_id` と `issue_id` を、条件の `must_not` に入れる（4.2 節の `X`）。この表は小さい（索引の作り直しが済むまでの行だけ）ので、リクエストごとに DB から読む。
- 除外の対象のリポジトリで、変更の後の権限で読める人も、作り直しが済むまで検索に出ない。安全の側に倒す。
- 索引の作り直し（OpenSearch はそのリポジトリの文書の更新、Zoekt はシャードの作り直し）が両方で済んだら、`cleared_at` を書く。15 分を超えて残る行があれば、アラートを出す。
- 非公開 → 公開の変更は、除外の表を使わない（遅れは「まだ出ない」だけで、漏洩ではない）。

### 4.4 読み直し（多層防御）

- API は、検索の結果の ID を、通常の経路（判定関数）で読み直して返す。Issue・Pull Request はタイトルなどを DB から、コードは判定の後に索引の抜粋を返す。
- 読み直しで権限が理由で落ちた件数を `search_hydration_permission_drop` として計測する。**0 件でなければバグとして扱う**（条件が漏れている）。削除との競合で落ちたものは、別の指標にする。
- ページの件数が要求より少なくなることは許容する。

## 5. Issue・Pull Request・リポジトリの検索（OpenSearch）

### 5.1 構成

- Amazon OpenSearch Service。VPC の中に置き、IAM で認証する。書き込みは indexer のロール、読み出しは API のロールだけに許す。
- インデックスは別名の裏に置く（`issues` → `issues-v1`、`repos` → `repos-v1`）。マッピングの変更は、新しいインデックスへの二重書き込み・バックフィル・別名の付け替えで行う（Slack の [search.md](../../../slack/docs/architecture/search.md) の 5.4 節と同じ手順）。
- `issues` は `repo_id` をルーティングのキーにする。`repo:` の検索が 1 つのシャードで済む。大きなリポジトリでシャードが偏らないよう、`index.routing_partition_size` を設定する。値は負荷試験で決める。

### 5.2 文書

**issues**（Issue と Pull Request を 1 つのインデックスに。[issues.md](issues.md) の 1 節）

| 項目 | 中身 |
| --- | --- |
| `repo_id`、`owner_id`、`visibility`、`enterprise_id` | 権限の条件（4 節） |
| `issue_id`、`number`、`kind`（issue / pr） | ID |
| `title`、`body`、`comments_text` | 本文。`comments_text` はコメントを連結し、1 MiB で切る（既知の制限） |
| `state`、`state_reason`、`is_merged`、`is_draft`、`locked` | 状態 |
| `author_id`、`assignee_ids`、`commenter_ids`、`mentioned_ids`、`involves_ids` | 人 |
| `label_ids`・`label_names`、`milestone_id`・`milestone_title`、`type_id`・`type_name` | 属性 |
| `parent_issue_id`、`review_state`、`review_requested_ids`、`reviewed_by_ids` | sub-issue、レビュー |
| `created_at`、`updated_at`、`closed_at`、`merged_at` | 日時 |
| `comments_count`、`reactions_count` | 並べ替え |
| `search_version` | バージョン。`issues` の行の更新ごとに増える値 |

**repos**

| 項目 | 中身 |
| --- | --- |
| `repo_id`、`owner_id`、`visibility`、`enterprise_id` | 権限の条件 |
| `full_name`、`name`、`description`、`topics`、`readme`（先頭 64 KiB） | 本文 |
| `language`、`license`、`stars`、`forks`、`size`、`archived`、`is_fork`、`is_template` | 属性 |
| `created_at`、`pushed_at` | 日時 |

- 解析：英語の語幹化（`english`）のフィールドを関連度に、ICU の分割と CJK の bigram のフィールドを一致の判定に使う。日本語の Issue も部分的に当たるようにする（Slack の Sudachi の方式は、MVP では採らない。検索の品質の指摘が続いたら見直す）。Amazon OpenSearch Service は ICU Analysis のプラグインを全てのドメインに含む（[Supported plugins](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/supported-plugins.html)、2026-09-26 に確認）。

### 5.3 索引の更新（NFR-005：Issue・Pull Request は 10 秒以内）

```
API ─tx─▶ outbox ─▶ Relay ─▶ SQS search-index ─▶ search-indexer（TypeScript）─▶ OpenSearch
```

- indexer はイベントを「きっかけ」として扱い、Issue の現在の状態を DB（reader）から読んで文書を作る。コメントのイベントも、Issue の文書全体を作り直す。
- 書き込みは `search_version` を外部のバージョンとして書き、古いバージョンで新しいバージョンを上書きしない。
- 削除は tombstone にし、7 日後に消す（Slack と同じ理由）。
- 同じ Issue へのイベントを 1 秒の間まとめ、数件をまとめて書く（最大 100 件、または 500 ms）。
- `refresh_interval` は 1 秒。
- 指標 `search_index_lag`（イベントの作成 → 書き込みの完了）の p99 が 10 秒を超える状態が 5 分続いたら、アラートを出す。
- リポジトリの権限の属性の変更（4.3 節）では、そのリポジトリの全文書を `update_by_query` で書き換え、済んだら除外の表を片付ける。

### 5.4 クエリの構文

本家の Issue・Pull Request の検索（[Searching issues and pull requests](https://docs.github.com/en/search-github/searching-on-github/searching-issues-and-pull-requests)）に合わせる。

| 構文 | 意味 |
| --- | --- |
| `is:issue` / `is:pr`、`type:` | 種類（本家も `type:` を両方に使う。`type:pr`・`type:issue` は種類、`type:"Bug"` は Issue の種類。[Searching issues and pull requests](https://docs.github.com/en/search-github/searching-on-github/searching-issues-and-pull-requests)、[Filtering and searching issues](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/filtering-and-searching-issues-and-pull-requests)、2026-09-26 に確認） |
| `is:open` / `is:closed` / `is:merged` / `is:unmerged`、`is:draft`、`is:locked` | 状態 |
| `reason:completed` / `reason:"not planned"` | 閉じた理由 |
| `author:`、`assignee:`、`mentions:`、`commenter:`、`involves:`、`reviewed-by:`、`review-requested:` | 人 |
| `label:`、`milestone:`、`no:label` / `no:assignee` / `no:milestone` | 属性 |
| `in:title` / `in:body` / `in:comments` | 検索する部分 |
| `repo:`、`org:`、`user:`、`language:` | 範囲 |
| `created:`、`updated:`、`closed:`、`merged:`（`>`、`<`、`..`） | 日時 |
| `review:none` / `required` / `approved` / `changes_requested` | レビューの状態 |
| `parent-issue:`（本家の Projects の絞り込みにある。[Filtering projects](https://docs.github.com/en/issues/planning-and-tracking-with-projects/customizing-views-in-your-project/filtering-projects)、2026-09-26 に確認）、`has:sub-issues`（本家の構文の名前は文書にない。**未検証**） | sub-issue |
| `-修飾子` | 除外 |
| `AND` / `OR`、`( )` | 論理演算（本家は Issue の画面で入れ子を許す） |

- 並べ替え：関連度、作成・更新の新しい順、コメントの数、リアクションの数。
- 利用者が OpenSearch のクエリ DSL を渡す経路は作らない。クエリは 1 つの組み立て関数だけで作り、必ず 4.2 節の条件を含める。**任意の検索の構造について、組み立てた要求が権限の条件と除外を含む** ことを性質ベーステストで確かめる。OpenSearch のクライアントを他の場所から使うことは lint で禁止する。

### 5.5 ページングと上限

- 1 ページ 30 件（最大 100 件）。結果は 1,000 件まで（本家の REST API と同じ。[REST API の検索](https://docs.github.com/en/rest/search/search)）。深いページは `search_after` で行う。
- 合計の件数は 1,000 件まで正確に数え、それを超えたら「1,000 件以上」とする（本家の API も 1 回の検索で 1,000 件までしか返さない。[REST API の検索](https://docs.github.com/en/rest/search/search)、2026-09-26 に確認。Web の件数の表示の細部は文書にない。**未検証**）。
- 1 回の検索は 3 秒で打ち切り、`incomplete_results: true` を付けて返す。

## 6. レート制限

本家の REST API の値（[REST API の検索](https://docs.github.com/en/rest/search/search)）に合わせる。

| 対象 | 上限 |
| --- | --- |
| API のコード検索（認証あり） | 1 分に 10 回 |
| API のその他の検索（認証あり） | 1 分に 30 回 |
| API の検索（認証なし） | 1 分に 10 回（コード検索は不可） |
| API の検索文字列 | 修飾子を除き 256 文字まで、`AND` / `OR` / `NOT` は 5 個まで |
| Web のコード検索 | 1 分に 60 回（本設計の値。本家は Web のコード検索の頻度の上限を公開していない。2026-09-26 に確認。**未検証**） |
| Web のその他の検索 | 1 分に 60 回（本設計の値） |

- 計数は API のレート制限の仕組み（[api-and-webhooks.md](api-and-webhooks.md)）で行う。
- 検索文字列はログに平文で残さない（非公開のコードの断片を含みうる）。

## 7. データの削除

- リポジトリの削除：除外の表に書き（4.3 節）、Zoekt のシャードを割り当てから外して S3 から消し、OpenSearch はルーティングを付けた `delete_by_query` で消す。
- Issue の削除：tombstone（5.3 節）。
- 利用者の削除：`author_id` などの ID は残し、表示の時に「ghost」に置き換える（[security.md](security.md) のデータのライフサイクル）。

## 8. テスト

- 漏洩テスト（経路ごと）：非公開のリポジトリ、コラボレーターから外した直後、公開 → 非公開の直後、別の Organization へ移した直後、削除の直後に、コード検索・Issue の検索・リポジトリの検索の結果・件数・ハイライトのどれにも出ない。
- 性質ベーステスト：`accessPredicate` と `can` の一致（4.1 節）、組み立てた要求が常に権限の条件を含む（5.4 節）、除外の表の行がある間はそのリポジトリが出ない。
- バージョンの比較：任意の順序・重複のイベントを indexer に与えても、最終的な文書が DB の最新の状態と一致する。コードの索引は、任意の push の列の後で、`indexed_commit` がデフォルトブランチの ref と一致する（処理が追いついた後）。
- 索引の対象の規則（3.1 節）：350 KiB、長い行、バイナリ、UTF-8 以外、vendored。
- 構文：3.5 節と 5.4 節の各行。リテラルのない正規表現の拒否。

## 9. 未解決の問い

設計の中で出た問いと、その決定。計測・PoC で決めるものは「持ち越し」に置く。

### 決定（2026-09-26、既定案）

- fork の索引の規則は、3.1 節の「親より star の多い fork だけ」で始める。本家の新しいコード検索での扱いを観測できたら合わせる。
- 利用者・コミットの検索は、MVP の後の候補にする。持つときは OpenSearch に置く（Zoekt は使わない）。

持ち越し：

| 項目 | いつ・どう決めるか |
| --- | --- |
| Zoekt の差分のシャードと、リポジトリの ID の集合の条件が、本設計の使い方に耐えるか（3.3、4.2 節） | E6 の `code-search-zoekt-poc`（1 万のリポジトリの試作）で確かめる。耐えなければ、大きなリポジトリの全体の作り直しと、リポジトリ名の集合の条件に切り替える |
| blob の単位の重複の排除（本家の方式）へ移るか | E10。索引の大きさと取り込みの量を測って決める。移るなら、権限の条件の付け方を設計し直し ADR を起票する |
| AWS の OpenSearch Service での ICU の利用可否（5.2 節） | E6 の着手前に確かめる |

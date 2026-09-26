# Search: Slack

全文検索、インデックス、権限の適用。S1 は PostgreSQL＋pg_bigm、S2 で OpenSearch へ移る（[ADR-0004](../decisions/0004-postgres-fulltext-search-first.md)）。権限は検索クエリの中で適用し、結果を後から除く方式を取らない（[ADR-0005](../decisions/0005-single-authorization-check.md)）。

## 1. 範囲

- 対象は、メッセージ（スレッド返信を含む）の本文と、添付ファイルのファイル名。
- ファイルの中身、チャンネル名、メンバーの検索は、この文書の範囲外。
- 検索できるのは、検索した人がその時点で読めるチャンネルのメッセージだけ。DM とプライベートチャンネルも、メンバーなら対象になる。

## 2. 共通の設計

S1 と S2 で、次の 3 つを共有する。バックエンドを替えても、検索の意味が変わらないようにするため。

| 部品 | 場所 | 役割 |
| --- | --- | --- |
| クエリのパーサー | `packages/contract` | 検索文字列を構造（`SearchQuery`）に変換する |
| 正規化 `normalizeForSearch` | `packages/contract` | NFKC と小文字化。インデックスする本文とクエリの両方にかける |
| 読めるチャンネルの判定 | 判定関数（ADR-0005）と、その SQL 版 | クエリの権限条件に使う |

### 2.1 クエリの構文

| 構文 | 意味 |
| --- | --- |
| `語` | 部分一致。空白で区切った語はすべて含む（AND） |
| `"語 語"` | 空白を含めて、連続する文字列として一致 |
| `-語` | その語を含まない |
| `from:@名前` / `from:<@member_id>` | 投稿者 |
| `in:#名前` / `in:<#channel_id>` | チャンネル。`in:@名前` は、その人との DM |
| `before:2026-09-01` / `after:` / `on:` | 日付。検索した人のタイムゾーンで解釈する |
| `has:file` / `has:link` | 添付ファイル、リンクがある |
| `is:thread` | スレッド返信 |

- クライアントは補完で ID を埋め込む（`from:<@...>`）。名前で書かれたら、サーバーが表示名の完全一致で解決する。複数に当たったら、すべてを対象にする（OR）。
- 肯定の語もフィルタもないクエリ（`-語` だけなど）は 400 を返す。
- ひらがなとカタカナは同一視しない。同一視するかは未解決の問い（9 節）。

### 2.2 インデックスする内容

`message.created` / `message.edited` / `message.deleted` から、次の文書を作る。

| 項目 | 中身 |
| --- | --- |
| `workspace_id`、`message_id`、`channel_id`、`member_id`、`thread_root_id` | ID |
| `created_at` | 投稿時刻 |
| `content_seq` | 本文を最後に変えたイベントの `seq`（[messaging.md](messaging.md)）。版番号として使う |
| `deleted` | 削除済みなら true。本文は空にする |
| `has_file`、`has_link` | フィルタ用 |
| `text` | `normalizeForSearch(toPlainText(body))` とファイル名。@メンバーはインデックス時点の表示名にする |

- 表示名が変わっても、過去の文書は更新しない（既知の制限）。`from:` は ID で絞るので影響しない。
- チャンネルの権限の情報（メンバー一覧、公開・非公開）は文書に入れない。権限はクエリ時に DB から得る（3 節）。メンバーの出入りで再インデックスが不要になり、権限の変更がすぐに効く。

### 2.3 インデックスの更新

```
API ─(tx)─▶ outbox ─▶ Relay ─▶ SQS: search-index ─▶ search indexer ─▶ S1: search.message_docs
                                                                    └▶ S2: OpenSearch
```

- indexer はイベントを「きっかけ」として扱い、メッセージの現在の状態を DB から読む（テナントのコンテキストを設定してから）。
- 書き込みは `content_seq` で版を比べ、古い版で新しい版を上書きしない。SQS の順序の入れ替わりと重複に耐える。
- **削除は tombstone として書く**（`deleted = true`、本文は空）。物理的に消すと、遅れて届いた古い版の書き込みで復活しうるため。tombstone は 7 日後に定期ジョブで消す。
- 数件をまとめて書く（最大 100 件、または 500ms）。
- 失敗したジョブは SQS の再試行に任せ、5 回失敗したら DLQ に送り、アラートを出す。

### 2.4 結果の返し方

1. 検索で `message_id` の一覧を得る。
2. API が、その ID のメッセージを通常の経路（RLS と判定関数）で読み直し、本文を返す。
3. ハイライトは、読み直した本文に対して API で付ける。

- 読み直しで行が落ちるのは、削除とインデックスの間の遅れ（10 秒以内）だけのはず。権限が理由で落ちた件数は、`search_hydration_permission_drop` として計測する。**0 件でなければバグとして扱う**（権限の条件がクエリから漏れている）。
- ページの件数が要求より少なくなることは許容する。

### 2.5 並べ替えとページング

| 段階 | 並べ替え | ページング |
| --- | --- | --- |
| S1 | 新しい順だけ | カーソル（`created_at`、`message_id`）によるキーセット |
| S2 | 新しい順、関連度順 | `search_after`（新しい順は `created_at`・`message_id`、関連度順は `_score`・`message_id`） |

- カーソルはクライアントに不透明な文字列として渡す。
- 1 ページ 20 件（最大 50）。合計件数は数えない（「20 件以上」と表示する）。
- 深いページは 1,000 件目までに限る。

### 2.6 レートと時間の上限

- 1 メンバーあたり 1 分に 30 回。超えたら 429。
- 1 回の検索は 3 秒で打ち切る（S1 は `statement_timeout`、S2 は `timeout`）。打ち切ったら、条件を足すよう促すエラーを返す。
- 検索文字列はログに平文で残さない。

## 3. 権限の適用

- **読めるチャンネルの集合を、検索クエリの条件に入れる。** 結果を後から除くと、件数・ページング・ハイライトから権限外の存在が漏れうる。
- 読めるチャンネルの判定は、TypeScript の判定関数（ADR-0005）と同じ規則を、SQL の関数 `readable_channel_ids()` としても持つ。**2 つが同じ集合を返すことを、性質ベーステストで検証する**（任意のメンバー・チャンネル・参加状態について、両者の結果が一致する）。
- 集合はリクエストのたびに DB から得る。キャッシュしない。チャンネルからの退出・削除は、次の検索からすぐに効く。
- ゲストは、参加しているチャンネルだけが対象になる。
- パブリックチャンネルを非メンバーも読めるようにするか（E1 spec の未解決の問い）で、集合の大きさが変わる。読めるようにする場合、S2 の条件は 5.3 節の形にする。

## 4. S1：PostgreSQL＋pg_bigm

### 4.1 RLS の下では pg_bigm のインデックスが使われない

PostgreSQL は、RLS のあるテーブルでは、leakproof でない演算子を含む条件にインデックスを使わない。`LIKE`（`~~`）は leakproof ではない。したがって、RLS を有効にした表に `LIKE` で検索すると、pg_bigm の GIN インデックスは使われず、ワークスペースの全行を走査する（[PostgreSQL のメーリングリスト](https://www.postgresql.org/message-id/14241.1565725716%40sss.pgh.pa.us)）。演算子を leakproof にするには superuser が必要で、Aurora では行えない見込み（未検証）。

そこで、検索用のテーブルだけを次の形にする。

- **検索用のテーブル `search.message_docs` は RLS を有効にしない。** 代わりに、`app` ロールからは直接読めなくする（権限を与えない）。
- 読み出しは、`SECURITY DEFINER` の関数 `search.find_messages(...)` だけで行う。関数は専用のロール `search_owner`（`BYPASSRLS` なし）が所有する。
- 関数の中で、`workspace_id = current_setting('app.workspace_id')::uuid` と、権限の条件を必ず付ける。クエリの形は固定で、引数は値だけを受け取る。アプリが SQL を渡す経路はない。
- 関数が返すのは `message_id` の一覧だけ。本文は 2.4 節のとおり RLS の下で読み直すので、関数に誤りがあっても別テナントの本文は返らない（多層防御）。
- 書き込みも関数 `search.upsert_docs(...)` だけで行う。
- `search_owner` は `channel_members` などの RLS の対象のまま。権限の条件は、テナントのコンテキストの下で評価される。

**これは ADR-0009 の「全テナントテーブルで RLS を有効にする」の例外になる。** 例外の範囲と代わりの守りは [ADR-0027](../decisions/0027-search-table-rls-exception.md) で定めた。マイグレーションの lint には、`search` スキーマを例外として明示し、`app` ロールへの権限の付与を禁止する規則を足す。

### 4.2 テーブルとインデックス

```sql
CREATE TABLE search.message_docs (
  workspace_id uuid, message_id uuid, channel_id uuid, member_id uuid,
  thread_root_id uuid, created_at timestamptz, content_seq bigint,
  deleted boolean, has_file boolean, has_link boolean, text text,
  PRIMARY KEY (workspace_id, message_id)
) PARTITION BY HASH (workspace_id);          -- 32 分割

CREATE INDEX ON search.message_docs USING gin (text gin_bigm_ops);
CREATE INDEX ON search.message_docs (workspace_id, created_at DESC, message_id DESC);
CREATE INDEX ON search.message_docs (workspace_id, channel_id, created_at DESC);
CREATE INDEX ON search.message_docs (workspace_id, member_id, created_at DESC);
```

- `messages` とは別のテーブルにする。本文は AST（JSON）なので、テキスト化した列が要る。更新を indexer に任せ、S2 と同じ経路（2.3 節）にする。
- ハッシュ分割で、GIN の転置リストに載る他テナントの行を減らす。`current_setting` は stable なので、実行時の分割の刈り込みが効く（未検証：Aurora の実行計画で確かめる）。
- 検索の条件で絞り込みが強いとき（`in:`、`from:`、日付）は B-tree、語が珍しいときは GIN が選ばれる想定。

### 4.3 クエリ

`search.find_messages` の中身の骨格。

```sql
SELECT d.message_id
FROM search.message_docs d
WHERE d.workspace_id = current_setting('app.workspace_id')::uuid
  AND d.channel_id IN (SELECT channel_id FROM readable_channel_ids())
  AND NOT d.deleted
  AND d.text LIKE likequery(:term_1)          -- 語ごとに AND
  AND d.text NOT LIKE likequery(:exclude_1)   -- 除外（インデックスは使わない）
  AND (:from_ids IS NULL OR d.member_id = ANY(:from_ids))
  AND (:in_ids   IS NULL OR d.channel_id = ANY(:in_ids))
  AND (:after    IS NULL OR d.created_at >= :after)
  AND (:before   IS NULL OR d.created_at <  :before)
  AND (d.created_at, d.message_id) < (:cursor_created_at, :cursor_message_id)
ORDER BY d.created_at DESC, d.message_id DESC
LIMIT :limit + 1;                              -- 1 件多く取り、次のページの有無を判定する
```

- `likequery()` は pg_bigm の関数で、特殊文字をエスケープし、前後に `%` を付ける。
- pg_bigm は 1 文字の語でもインデックスを使える。ただし 1 文字の語は候補が多く遅くなりやすい。3 秒の打ち切りで守る。
- 関連度順は S1 では提供しない（pg_bigm の類似度は並べ替えに向かない）。

### 4.4 S2 へ移る判断の基準

次のいずれかを満たしたら、OpenSearch への移行に着手する。

- 検索の p95 が 1 秒を超える状態が 1 週間続く
- 3 秒の打ち切りが、検索の 1% を超える
- `search.message_docs` の GIN インデックスが、DB のストレージの 30% を超える
- 関連度順の要求が、プロダクトとして確定する

## 5. S2：OpenSearch

### 5.1 構成

- Amazon OpenSearch Service。VPC の中に置き、IAM で認証する。書き込みは indexer のロール、読み出しは API のロールだけに許す。
- インデックスは別名 `messages` の裏に置く（`messages-v1` など）。マッピングを変えるときは、新しいインデックスを作って別名を付け替える。
- **ルーティングは `workspace_id`。** 1 つのワークスペースの文書が限られたシャードに集まり、検索が全シャードに広がらない。大きなワークスペースでシャードが偏らないよう、`index.routing_partition_size` を設定する（例：主シャード 24、分割 4）。値は負荷試験で決める。
- S3（セル構成）では、セルごとにドメインを持つ。ワークスペースを別のセルへ移すときは、そのワークスペースの文書を新しいセルへ再インデックスする。専用セルの大口ワークスペースは、専用のインデックスになる。

### 5.2 マッピングと日本語の解析

```json
{
  "workspace_id": "keyword", "message_id": "keyword", "channel_id": "keyword",
  "member_id": "keyword", "thread_root_id": "keyword",
  "created_at": "date", "content_seq": "long", "deleted": "boolean",
  "has_file": "boolean", "has_link": "boolean",
  "text": { "type": "text", "analyzer": "ja_sudachi",
            "fields": { "gram": { "type": "text", "analyzer": "ja_1_2gram" } } }
}
```

| フィールド | 解析 | 役割 |
| --- | --- | --- |
| `text.gram` | 1〜2 文字の N-gram | **一致の判定**。語ごとに `match_phrase` で連続を要求し、S1 の部分一致と同じ結果にする |
| `text` | Sudachi（形態素解析） | **関連度のスコア**。`should` にだけ使う |

- 一致の判定を N-gram にするのは、S1 から移ったときに「前は見つかったものが見つからない」を起こさないため。形態素解析だけでは、未知語や語の途中での検索を取りこぼす。
- 形態素解析には Sudachi を使う。表記の揺れの正規化（例：「附属」と「付属」）を持ち、辞書の更新が続いている。Amazon OpenSearch Service は、Sudachi と Kuromoji を任意のプラグインとして提供している（[AWS の発表、2023-10](https://aws.amazon.com/about-aws/whats-new/2023/10/amazon-opensearch-four-language-analyzers/)）。対応する OpenSearch のバージョンと、プラグインが版の更新を妨げないかは未検証。
- 正規化（NFKC・小文字化）は、アナライザーではなくアプリの `normalizeForSearch` で行う。S1 と同じ関数を使い、結果を揃える。
- 1 文字の N-gram を含めると、インデックスが大きくなる。増え方は未検証なので、バックフィルの前に代表的なワークスペースで測る。
- 関連度順のスコアは、Sudachi のフィールドの BM25 に、投稿時刻の減衰（ガウス、30 日）を掛ける。

### 5.3 文書単位の権限の条件

クエリは 1 つの組み立て関数（`buildSearchRequest`）だけで作り、必ず次を含める。OpenSearch のクライアントを他の場所から直接使うことは、lint で禁止する。

```json
{
  "routing": "<workspace_id>",
  "query": { "bool": {
    "filter": [
      { "term":  { "workspace_id": "<workspace_id>" } },
      { "terms": { "channel_id": ["<読めるチャンネルの ID>", "..."] } },
      { "term":  { "deleted": false } }
    ],
    "must":   [ { "match_phrase": { "text.gram": "<語>" } } ],
    "should": [ { "match": { "text": "<語>" } } ]
  } }
}
```

- 読めるチャンネルの ID は、同じリクエストの中で `readable_channel_ids()` から得る。
- `terms` の上限は既定で 65,536 件。1 人が読めるチャンネルがこれを超えることは想定しない。
- パブリックチャンネルを非メンバーも読めるようにした場合は、`is_private` を文書に持ち、「`is_private = false` または 参加しているプライベートチャンネル」を条件にする。このとき、チャンネルの公開・非公開の切り替えで、そのチャンネルの文書の再インデックスが要る。
- 利用者が OpenSearch のクエリ DSL を直接渡す経路は作らない。
- 性質ベーステスト：任意の `SearchQuery` について、組み立てた要求が必ず `routing` と上の 3 つの `filter` を含む。

### 5.4 S1 からの移行（バックフィルと二重書き込み）

1. OpenSearch のドメイン、インデックスのテンプレート、別名を作る。
2. indexer が、PostgreSQL と OpenSearch の両方に書く（フィーチャーフラグ）。
3. バックフィル：ワークスペースごとに、`messages` を `message_id`（UUIDv7）の順に読み、チェックポイントを残しながら一括で書く。版は `content_seq` の外部バージョンで書くので、二重書き込みの新しい内容を上書きしない。読み出しは DB の reader を使い、速度を絞る。
4. 検証：
   - ワークスペースごとの件数（削除済みを除く）を突き合わせる。
   - シャドーリード：実際の検索を両方に投げ、上位 20 件の一致率を記録する。利用者には PostgreSQL の結果を返す。
5. 読み出しの切り替え：ワークスペース単位のフラグで、社内 → 5% → 25% → 100% と広げる（[runbooks/README.md](../runbooks/README.md) の 3 節）。
6. 戻し：二重書き込みを続けている間は、フラグで PostgreSQL に戻せる。
7. 100% にして 4 週間、問題がなければ PostgreSQL への書き込みをやめ、`search.message_docs` を消す。

マッピングの変更による再インデックスも、同じ手順（新しいインデックスへの二重書き込み、バックフィル、別名の付け替え）で行う。

## 6. 反映の遅れ（NFR-006）

投稿から検索に出るまでを、10 秒以内にする。

| 区間 | 目安 |
| --- | --- |
| コミット → Relay が SQS に送る | 1 秒以内 |
| SQS → indexer が受け取る | 1 秒以内（ロングポーリング） |
| indexer のまとめ書き | 0.5 秒以内 |
| 検索に見えるまで | S1：コミットで即時。S2：`refresh_interval` 1 秒 |

- 指標 `search_index_lag`（イベントの作成時刻 → インデックスへの書き込み完了）を計測する。p99 が 10 秒を超える状態が 5 分続いたら、アラートを出す（[runbooks/README.md](../runbooks/README.md) への追加を Ops に依頼する）。
- 合成監視の「投稿 → 検索でヒット」（[quality.md](../quality.md) の 4.2 節）で、端から端まで確かめる。
- 権限の変更は、遅れなく反映される（3 節）。遅れるのは本文の変更だけ。

## 7. データの削除

- メッセージの削除：tombstone にし、7 日後に消す（2.3 節）。
- ワークスペースの削除：S1 は `workspace_id` で削除、S2 は `routing` を付けた `delete_by_query`。ワークスペースの削除手順の一部として行う（[security.md](security.md)）。

## 8. テスト

- 日本語の部分一致、ひらがな・カタカナの混在、全角・半角、1 文字の語（ADR-0004 の確認方法）。
- 経路ごとの漏洩テスト：別のワークスペース、参加していないプライベートチャンネル、退出した直後のチャンネルのメッセージが、検索に出ない。
- S1 と S2 で、同じクエリが同じ集合を返す（並べ替えを除く）。移行の前に、テスト用データで確かめる。
- 版の比較：同じメッセージのイベントを任意の順序・重複で indexer に与えても、最終的な文書が DB の最新の状態と一致する。

## 9. 未解決の問い

- ひらがなとカタカナを同一視するか。同一視すると再現率は上がるが、S1 と S2 の両方の正規化に入れる必要がある。
- ADR-0009 の例外（4.1 節）を ADR として認めるか。認めない場合、S1 の検索はワークスペースの全行の走査になり、S2 への移行を早める必要がある。
- パブリックチャンネルを非メンバーが検索できるか（E2 の決定しだい）。

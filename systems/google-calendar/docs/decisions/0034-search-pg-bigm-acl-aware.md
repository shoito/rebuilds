---
status: accepted
date: 2026-10-04
---

# ADR-0034: S1 の検索は Aurora の `pg_bigm` で行い、予定オブジェクトのマスターと上書きごとの検索の表に正規化した文字列と `is_private` を持つ。権限は `searchScope(actor)` のカレンダーの 2 つの集合で絞って `redact()` で確かめ直す。索引は outbox から非同期に更新し、件数の合計を返さない

## Context

[intent.md](../intent.md) は、予定のタイトル・場所・説明・参加者の検索（日本語を含む）を MVP に含める。NFR-012 は、変更から検索に出るまで p95 30 秒、応答 p99 1 秒、日本語の部分一致で取りこぼさないことを求める。[architecture/README.md](../architecture/README.md) の 6 節は、S1 は Aurora の `pg_bigm` で、`redact()` を通した検索の表を引き、新しい部品を足さないと決めた。[ADR-0004](0004-tenancy-and-rls.md) は、検索の表に `redact()` の結果ごとの文字列を入れると決めた。

`pg_bigm` は Aurora PostgreSQL 18 で使え（[Extension versions for Aurora PostgreSQL](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraPostgreSQLReleaseNotes/AuroraPostgreSQL.Extensions.html)）、2-gram の GIN の索引で `LIKE` の部分一致を速くし、1〜2 文字の語も扱える（[pg_bigm 1.X Document](https://pgbigm.github.io/pg_bigm/pg_bigm_en.html)）。いずれも 2026-10-04 に確認。他の題材（Linear の ADR-0030）は、関連度の並べ替えと Writer のクラスタの負荷を理由に OpenSearch を選んだ。本家の検索の対象・並べ方・遅れは公式の資料にない（未検証）。

決めることは次である。

- 権限をどう効かせるか。行ごとの ACL を索引に持つと、共有の変更のたびに書き直しになる。
- 索引をいつ更新するか。予定の書き込みの p99 300 ms（NFR-001）に GIN の更新を足すか。
- 件数と抜粋で、見てはいけない予定の存在が漏れないか。

## Options

権限：

1. **検索の表は全体の文字列と `is_private` だけを持ち、問い合わせの時に `searchScope(actor)` が返すカレンダーの集合（`full`・`public_only`）で絞り、結果を `redact()` で確かめ直す**
2. 行ごとに見られる主体の一覧を持つ
3. 見る人ごとに検索の表を分ける

更新：

- a. **outbox から `indexer` が非同期に更新する**
- b. 予定の書き込みと同じトランザクションで更新する

## Decision

1 と a を採用する。詳細は [search.md](../architecture/search.md) の 4〜8 節。

- 検索の表 `event_search_docs`：`(tenant_id, event_object_id, recurrence_id)` を主キーに、`calendar_id`、`is_private`、`start_utc`、`series_end_utc`、`doc`（正規化した、タイトル・場所・説明の先頭 2 KiB・参加者と主催者の名前とメールアドレス）、`object_version`。テナントのハッシュで 16 に分割し、`doc` に `gin_bigm_ops` の GIN。RLS を付ける。取り消した予定、`cancelled`・`hidden` の写し、保留の招待は行を消す。
- 正規化（索引と検索語で同じ）：NFKC、小文字、ひらがなをカタカナに、長音の揺れ、空白、制御文字。
- `searchScope(actor)`（`packages/policy`）：`owner`・`writer` のカレンダーは `full`、`reader` は `public_only`（`is_private = false` だけ）、`free_busy_reader` と見られないカレンダーは含めない。参加者は自分の写しで当たる。対象は利用者のカレンダーの一覧の中だけ。
- 問い合わせ：テナントごとに並行（10 まで、1 テナント 400 ms）、`doc LIKE likequery(語)` の AND（5 語まで）、範囲の条件。結果を `redact()` で確かめ直し、全体でないものを落として数える。
- 並べ方：次の回の近さ（未来を先に、過去は新しい順）。抜粋と件数の合計を返さない。
- 更新：`packages/writer` が outbox に `search.upsert`・`search.delete` を書き、`indexer` が `object_version` で古い書き込みを捨てて更新する。ACL の変更は索引を書き直さない。
- S2 の基準（応答 p99 1 秒の超過、索引 1 TB、`indexer` の書き込みが writer の 20%、鮮度の超過、関連度・形態素の要求）のどれかを満たしたら、専用の基盤を決める ADR を起票する。

### 他の案を選ばなかった理由

- **2（行ごとの主体の一覧）**：共有の変更・グループのメンバーの変化・組織の方針の変更のたびに、多くの行の書き直しになる。カレンダーの権限はカレンダーの単位で粗いので、集合で絞れる。
- **3（見る人ごとの表）**：共有のカレンダーの予定を見る人の数だけ複製する。
- **b（同じトランザクション）**：GIN の更新が予定の書き込みの経路に入り、繰り返しの系列の大きな変更で NFR-001 を守りにくい。鮮度は 30 秒で足りる。

## Consequences

- 良くなること：
  - 新しい部品を足さず、Aurora の RLS とテナントの分割の中で検索できる。S2 のテナントのクラスタの分割にもそのまま付いていく。
  - 共有の変更が、索引の書き直しなしに次の検索から効く。
  - 件数と抜粋を返さないので、存在の推測の経路が小さい。
- 引き受けるコスト：
  - 関連度での並べ替えと、形態素の解析（送り仮名の揺れ、同義語）を持たない。
  - GIN の索引が大きい（S1 で 160〜240 GB の見込み）。E11 の前の `search-bigm-poc` で確かめる。
  - よくある語では当たる行が多く、読み出しの上限で切って `partial` を返す。

## Confirmation

- 表駆動テスト：DT-SRCH-001（検索の範囲。sharing-and-acl の `redact()` の決定表と同じ表から読む）、DT-SRCH-002（正規化）。
- 性質ベーステスト：PROP-SRCH-001（見てはいけない中身で当たらない）、PROP-SRCH-002（取りこぼさない）、PROP-SRCH-003（バージョン）、PROP-SRCH-004（件数で推測できない）。
- lint：検索の SQL の権限の条件を `packages/policy` の外で書くことを禁止する。
- 本番：応答の p99、更新の遅れの p95、確かめ直しで落とした数。

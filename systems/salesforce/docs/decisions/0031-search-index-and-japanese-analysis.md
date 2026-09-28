---
status: accepted
date: 2026-09-28
---

# ADR-0031: 検索の索引は共有の 16 個の索引に組織で振り分け、日本語は形態素と 2-gram の 2 つで持ち、outbox から row_version を外部の版にして作る

詳細は [search.md](../architecture/search.md) の 4 節と 5 節。

## Context

[ADR-0001](0001-platform-and-stack.md) は、OpenSearch を全文検索の索引にだけ使い、正本の写しとして作り直せるものにした。intent は、全文検索の部品（OpenSearch の既定の日本語の解析器で足りるか）を E5 の着手前に PoC で決めるとした。

決めること：

- 索引を組織ごとに持つか、共有にするか。S1 で 5,000、S3 で 50 万の組織がある。
- 日本語の区切り方。営業の組織では、会社名・人名・製品名に辞書にない語が多い。
- 索引の遅れと、順の入れ替わり（古い書き込みが後から届く）の扱い。
- 保存の直後のレコードを参照の項目の候補に出すこと。

本家（2026-09-28 に確認）：全文検索は別の検索の基盤で非同期に索引を作る（[Platform Multitenant Architecture](https://architect.salesforce.com/docs/architect/fundamentals/guide/platform-multitenant-architecture.html)）。空白で区切らない東アジアの言語は形態素で区切り、「東京都」は「東京」「都」になり、「京都」の検索に当たらない（[SOQL and SOSL Reference](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_soql_sosl.pdf)、Winter '27 版）。索引の遅れの目安は確かめられなかった（未検証）。

Amazon OpenSearch Service は `analysis-kuromoji`・`analysis-icu` を持ち、Sudachi を任意のプラグインとして辞書と共に足せる（[Plugins by engine version](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/supported-plugins.html)、[Importing and managing packages](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/custom-packages.html)、2026-09-28 に確認）。

## Options

索引の分け方：

1. **共有の索引（16 個）に `shard_no` で振り分け、`org_id` を routing にする。全ての問い合わせに組織の条件を必ず付ける**
2. 組織ごとの索引
3. オブジェクトの種類ごとの共有の索引

日本語：

- a. **kuromoji（形態素）と CJK の 2-gram の 2 つの部分の項目を持ち、両方で引いて形態素を高く点数付けする**
- b. kuromoji だけ
- c. n-gram だけ

作り方：

- x. **outbox → SQS → indexer。`row_version` を外部の版にする。参照の候補は名前のピボットの前方一致を先に使う**
- y. 保存の同じトランザクションの中で OpenSearch に書く

## Decision

1、a、x を採用する。

- 索引は `rec-v{版}-{00..15}` の 16 個で、別名で指す。文書の ID は `{org_id}:{record_id}`。`texts` は nested 型で `field_no` ごとに持ち、`_source` には ID と版だけを残す（本文は DB から読む）。
- 解析は `icu_normalizer`（NFKC、小文字）→ kuromoji（search モード、原形、助詞を落とす）→ ひらがなをカタカナに。別に `cjk_bigram` の部分の項目を持つ。名前には前方一致用の `edge_ngram` と、カナの読みの項目を持つ。
- 既定は kuromoji。E5 の PoC で、Sudachi が生成したコーパスでの再現率で 5 ポイント以上良ければ Sudachi に替える。
- 索引に入れる項目は `searchable` の印のある項目（1 オブジェクト 20 まで）と名前。数式・数・日付は入れない。
- indexer は 100 件か 1 秒ごとにまとめて `_bulk` で書き、`version_type=external`・`version=row_version` にする。遅れの目標は p95 5 秒・p99 30 秒。ごみ箱のレコードは消す。
- 組織ごとに 7 日で整合の検査を一周し、`(id, row_version)` の差を直す。マッピングの変更は新しい版の索引を作って切り替える。
- 参照の項目の候補は、名前のピボット（`record_index_values`）の前方一致を先に引き、足りなければ OpenSearch で足す。OpenSearch の障害の時は、全体の検索も名前の前方一致で答え、`degraded` を返す。
- 2 は、組織の数だけ索引とシャードを持つことになり、S3 でクラスタの状態が大きくなりすぎる。
- 3 は、カスタムオブジェクトの項目が組織ごとに違うので、マッピングが膨らむ。
- b は、辞書にない会社名・造語を取りこぼす。c は、「京都」で「東京都」に当たるような誤った一致が多い。
- y は、OpenSearch の遅れと障害が保存を止め、2 つの置き場所のトランザクションをそろえられない。

## Consequences

- 良くなること：
  - 組織の数に依らず、索引の数が一定になる。
  - 辞書にない語も 2-gram で拾い、辞書にある語は形態素で正しく当てる。
  - 順が入れ替わっても、索引が古い値に戻らない。
  - 参照の候補に、保存の直後のレコードが出る。
- 引き受けるコスト：
  - 共有の索引なので、組織の条件の付け漏れが漏えいになる。1 つの関数で付け、後の確かめの RLS で 2 重に守る（[ADR-0032](0032-search-permission-post-filter.md)）。
  - 組織ごとの辞書を持てない。
  - nested の問い合わせと 2 つの部分の項目で、索引と問い合わせの費用が増える。
  - 大口の組織が 1 つのシャードに集まる。S2 で専用の索引に分ける。

## Confirmation

- 性質ベーステスト：任意の保存の列（順の入れ替え、二重の配信を含む）の後で、索引の `row_version` が DB の最後の値と一致する。
- 性質ベーステスト：他の組織の文書が結果に出ない。
- lint：問い合わせを組み立てる関数の外での OpenSearch の問い合わせを禁止する。
- 評価：生成した日本語のコーパスで再現率・適合率を測り、設定の変更で 2 ポイント以上悪化したら CI を落とす。
- 結合テスト：OpenSearch の停止で名前の前方一致に切り替わる。
- 性能テスト：索引の遅れ p95 5 秒、組織の全体の検索 p95 800ms。

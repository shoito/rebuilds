---
status: accepted
date: 2026-09-28
---

# ADR-0010: records とピボットを shard_no で LIST 分割し、ピボットの索引は指定のある項目に空の値も含めて書く

詳細は [data-storage.md](../architecture/data-storage.md) の 3 節と 4 節。

## Context

[ADR-0002](0002-custom-object-storage.md) は、全組織のレコードを `records`（システムの列＋JSONB）に入れ、索引・一意・関係を型付きのピボットの表で引くとした。[ADR-0005](0005-tenancy-and-governor-limits.md) は、`org_id` のハッシュで 256 の論理シャードを決め、論理シャードを物理のクラスタに割り当てるとした。決まっていなかったこと：

- 表を PostgreSQL の中でどう分けるか。S1 で 5 億件、S2 で 50 億件の表を 1 つの分割しない表に入れると、VACUUM・索引の作り直し・論理シャードの移動が重い。
- 大口の組織を、他の組織と分けて置けるか。ハッシュだけで決めると、置き場所を選べない。
- ピボットの索引を全項目に張るか、指定のある項目だけにするか（ADR-0002 の持ち越し。E3 の PoC）。
- 空の値を索引に含めるか。本家は既定で含めず、空で絞る条件が索引を使えない（[Best Practices for Deployments with Large Data Volumes](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_large_data_volumes_bp.pdf)、2026-09-28 に確認）。
- 文字列の比べ方。日本語では全角・半角の英数字が混ざる。

本家は、全てのデータとメタデータを OrgID で物理的に分割している（[Platform Multitenant Architecture](https://architect.salesforce.com/docs/architect/fundamentals/guide/platform-multitenant-architecture.html)、2026-09-28 に確認）。

## Options

分け方：

1. **`shard_no` の列を持ち、LIST で 256 に分割する。組織の `shard_no` は作成時にハッシュで決めて `orgs` に持つ**
2. `org_id` の HASH 分割（PostgreSQL の分割の関数に任せる）
3. 分割しない

ピボット：

- a. **索引の指定のある項目・名前・外部 ID だけに書き、空の値も印の行として書く**
- b. 全ての項目に書く
- c. 指定のある項目だけに書き、空の値は書かない（本家と同じ）

## Decision

1 と a を採用する。文字列は NFKC で正規化し、小文字にして比べる。

- `records`、ピボットの 4 つの表、共有の表、閉包の表、outbox を `shard_no` で LIST 分割する。主キーの末尾に `shard_no` を置く。SQL には必ず `shard_no` の定数を入れ、分割の刈り込みを効かせる。
- 組織の `shard_no` は、作成時に `org_id` の SHA-256 の先頭 2 バイトから 0〜239 に決める。240〜255 は大口の組織のための予約にする。以後は `orgs.shard_no` を正とし、変えるのは組織の移動の手順だけにする。
- 空の項目は `is_null` の行を 1 行書き、空で絞る条件にも索引を使えるようにする。
- 正規化は TypeScript の 1 つの関数で行い、保存・問い合わせ・評価器で共有する。
- 2 は、アプリが DB に問い合わせる前に論理シャードを知るには、PostgreSQL のハッシュの関数をアプリで再現する必要がある。大口の組織を選んで置くこともできない。3 は、S2 で表の運用が重い。
- b は書き込みの増幅が大きい（項目の数だけ行を書く）。E3 の PoC で、増幅が小さいと分かれば改める。c は、「担当が未設定」のような空で絞るリストビューが、大きなオブジェクトで選択的でなくなる。

## Consequences

- 良くなること：
  - 論理シャードの単位で、VACUUM・移動・切り離しができる。
  - 大口の組織を予約の番号へ置き、専用のクラスタに割り当てられる。
  - 空の値で絞る条件にも索引が効く。
  - 全角・半角・大文字・小文字の違いで検索を外さない。
- 引き受けるコスト：
  - 分割の数が約 2,300 になる。計画の時間を E1 で測る。
    > 2026-09-28 の注記：統合の工程で、`shard_no` で分割する表に `record_match_keys`・`activity_relations`・`flow_scheduled_actions`・`approval_locks` が加わり、13 表・約 3,300 になった（[data-storage.md](../architecture/data-storage.md) の 4 節）。
  - 空の項目にもピボットの行を書く。索引の項目 1 つにつき、レコードあたり 1 行は必ず書く。
  - 文字列の並べ替えは、正規化した値のコードポイントの順になり、日本語の辞書の順ではない。

## Confirmation

- 性質ベーステスト：任意の操作の列で、ピボットの行が `records` から求めた行と一致し、ピボットを使った問い合わせの結果が参照の評価器の結果と一致する（空の条件を含む）。
- 性質ベーステスト：正規化は冪等で、全角・半角・大文字・小文字だけの違いの文字列は同じ値になる。
- lint：`shard_no` の定数のない、分割の表への SQL を禁止する。
- 性能テスト（E1・E3）：分割の表の計画の時間の p99 と、空の値の条件の問い合わせの p95。

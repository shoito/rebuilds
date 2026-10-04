---
status: accepted
date: 2026-09-28
---

# ADR-0043: 日本語の解析器は Sudachi を既定にし、2 文字の n-gram を併せて持つ。索引はセルのドメインに種類ごとの共有の索引を置いて `tenant_id` で経路を決め、テナントのフィールドは入れ子の枠に入れる

詳細は [search.md](../architecture/search.md) の 4・5 節。

## Context

[intent.md](../intent.md) は、日本語の全文検索の解析器（kuromoji か Sudachi か）を search の領域で、ナレッジの検索の評価のデータで決めるとした。[ADR-0002](0002-tenancy-and-isolation.md) は、OpenSearch の索引をセルごとに持ち、文書に `tenant_id` を入れると決めた。テナントはフィールドを足す（1 テーブルに 300 まで。[ADR-0007](0007-physical-layout-and-extension-index.md)）。

事実（2026-09-28 に確認）：

- Amazon OpenSearch Service は kuromoji と ICU をすべてのドメインに入れている。Sudachi は任意のプラグインで、日本語に勧められている。Sudachi の辞書の関連付けの変更は次の blue/green まで効かず、新しい索引への入れ直しと別名の切り替えでも効かせられる（[Plugins by engine version](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/supported-plugins.html)）。
- Sudachi は 3 つの分割の単位と、表記の揺れを揃える正規化の形のフィルターを持つ（[elasticsearch-sudachi](https://github.com/WorksApplications/elasticsearch-sudachi)）。
- 検索の遅れが大事な用途のシャードは 10〜30 GiB、ヒープ 1 GiB あたり 25 シャードまでが目安（[Choosing the number of shards](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/bp-sharding.html)）。

## Options

### 解析器

1. **Sudachi（分割 C と A、正規化の形）＋ 2 文字の n-gram の副フィールド**
2. kuromoji（`search` の方式）＋ 2 文字の n-gram
3. 2 文字の n-gram だけ

### 索引の配置

- a. **種類ごとの共有の索引、`_routing = tenant_id`、必須の `tenant_id` の絞り込み**
- b. テナント × 種類ごとの索引
- c. 大きなテナントだけ専用の索引、ほかは共有

### テナントのフィールド

- x. **入れ子の枠 `fields[{fid, kind, text, kw}]`**
- y. フィールドごとに索引のフィールドを作る（動的なマッピング）

## Decision

1、a、x を採用する。

- 解析：ICU の NFKC の正規化 → Sudachi（C と A の 2 つの副フィールド、正規化の形、助詞・助動詞を落とす）、CJK の 2 文字の n-gram（重みを下げる）、英語。番号と識別の値は keyword の完全一致を最も重くする。テナントの同義語は問い合わせの時に展開する。
- 辞書の更新は、新しいパッケージで新しい索引を作り、DB から入れ直して別名を切り替える。
- 索引はセルのドメインに `task`・`ci`・`kb`・`catalog`・`record` を置く。専用のセルは専用のドメイン。
- テナントのフィールドと、組み込みの本文、作業メモ、コメントを入れ子の枠に入れる。「検索に入れる」を選んだ `string`・`text` のフィールドだけ（1 テーブル 20 まで）。
- **確認の条件**：E9 の評価で Sudachi が kuromoji に nDCG@10 で負けたら、この ADR を置き換える。

2 を選ばなかった理由：kuromoji は `kuromoji_stemmer` で 4 文字以上のカタカナの語の末尾の長音を消し、「サーバー／サーバ」は揃えられる（[kuromoji_stemmer](https://www.elastic.co/docs/reference/elasticsearch/plugins/analysis-kuromoji-stemmer)、2026-09-28 に確認）。しかし送り仮名や漢字の表記の揺れ（「問い合わせ／問合せ」）を揃える仕組みはない。Sudachi は正規化の形のフィルター（`sudachi_normalizedform`）でこれを揃える。ITSM の文章はこの種の揺れが多い。ただし kuromoji は同梱で運用が軽いので、評価の対照として残す。

3 を選ばなかった理由：再現率は高いが、2 文字の断片の一致で順位の質が落ち、索引も大きくなる。辞書にない語の補いとしてだけ使う。

b を選ばなかった理由：S3 の 3 万テナント × 5 種類で、シャードの数が 1 ドメインの目安を大きく超える。

c を選ばなかった理由：大きなテナントの隔離は、専用のセル（専用のドメイン）で行う。共有のセルの中で 2 つの形を持つと、索引の作り直しと問い合わせの組み立てが 2 通りになる。

y を選ばなかった理由：索引のフィールドの数の既定の上限（1,000）を、少ないテナントで超える。マッピングの肥大はクラスタの状態を重くする。

## Consequences

- 良くなること：
  - 表記の揺れを吸収し、辞書にない語も拾える。
  - シャードの数がテナントの数に比例しない。
  - 読めるフィールドだけに一致させる問い合わせ（[ADR-0044](0044-acl-aware-search-and-index-freshness.md)）を、1 つの入れ子の形で書ける。
- 引き受けるコスト：
  - Sudachi のパッケージの関連付けと、エンジンのバージョンの更新のときの同じバージョンのパッケージの用意が要る。
  - 入れ子の問い合わせは、平らなフィールドより遅い。E9 で測る。
  - テナントごとの索引の時の同義語・利用者の辞書を持てない。

## Confirmation

- 評価（E9）：評価のデータで Sudachi と kuromoji を比べ、結果を quality に残す。
- CI：解析器の設定を変える PR で、評価の値が下がらないこと。
- lint：OpenSearch への問い合わせを組み立てる関数の外で、問い合わせの本文を作らないこと。その関数は `tenant_id` を必須の引数にする。

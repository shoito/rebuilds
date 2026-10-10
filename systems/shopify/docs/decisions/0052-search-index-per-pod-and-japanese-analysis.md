---
status: accepted
date: 2026-10-10
---

# ADR-0052: OpenSearch のドメインをポッドごとに 1 つ持ち、ポッドのショップの商品を 1 つの索引（別名つき）に入れ、`shop_id` で振り分ける。検索は `packages/search` の 1 つの関数だけが組み立て、必ず `shop_id` の絞り込みと振り分けを付け、結果の各件の `shop_id` を返す前に確かめる。日本語は Sudachi の形態素の解析と ICU の正規化、2-gram の欄、読みの欄を持つ。順序の入れ替えは `catalog_version` を外部のバージョンにして防ぐ

## Context

- 検索は OpenSearch を汎用の部品として使う（[ADR-0001](0001-platform-and-stack.md)）。検索は RLS で守れないので、鍵の先頭のショップと試験で守る（[ADR-0003](0003-tenancy-and-rls.md)）。
- ポッドあたり商品 125 万、ショップ 1.25 万（S1）。ショップごとの索引は数が多すぎる。
- Amazon OpenSearch Service は kuromoji と ICU を全ドメインに含み、Sudachi を任意の追加として日本語に推す。Sudachi の辞書の差し替えは blue/green の展開か索引の作り直しで効く（[Plugins by engine version](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/supported-plugins.html)、2026-10-10 に確認）。
- 商品の変更の事象は順序が入れ替わる（[ADR-0016](0016-collection-membership-and-catalog-events.md)）。

## Options

置き場所：

1. **ポッドごとのドメイン、ポッドに 1 つの索引、`shop_id` で振り分け**
2. 全体で 1 つのドメイン
3. ショップごとの索引

解析：

- a. **Sudachi ＋ ICU ＋ 2-gram ＋ 読み**
- b. kuromoji ＋ 2-gram
- c. 2-gram だけ

## Decision

1 と a を採用する。詳細は [search-and-recommendations.md](../architecture/search-and-recommendations.md) の 4・5 節。

- ドメインはポッドごと（障害の範囲をポッドに揃える）。索引 `products_v<n>` と別名 `products`、主のシャード 12、`routing = shop_id`、`routing_partition_size = 4`。
- 欄の数はショップに依らず固定（オプションとメタフィールドは `名前=値` の keyword の配列）。
- 解析：ICU の NFKC → Sudachi（C の分割、正規化した形、品詞と止め語の除去）。子の欄に 2-gram と読み（カタカナ、前方一致の edge_ngram）。検索の時はひらがなをカタカナにして読みの欄に当てる。
- 問い合わせは `searchProducts(ctx, query)` だけが作る。`shop_id` の term と `routing` は `ctx` からだけ。`query_string` を使わない。返す前に各件の `shop_id` を確かめ、違う件は捨てて数える。
- `search-indexer` は事象を受けたら正本を読み直し、`version_type=external`・`version=catalog_version` で書く。

### 他の案を選ばなかった理由

- **2（全体で 1 つ）**：1 つのドメインの障害が全ショップの検索を止める。ポッドの外にショップのデータの写しを置くことになる（[ADR-0002](0002-pods-and-shop-placement.md)）。
- **3（ショップごと）**：ポッドに 1.25 万の索引で、シャードの数とクラスタの状態が大きくなりすぎる。
- **b（kuromoji）**：表記の揺れの正規化が弱い。AWS は日本語に Sudachi を推す。b は Sudachi が使えないときの代わりにする。
- **c（2-gram だけ）**：「京都」で「東京都」が当たるような誤りが多く、順位が悪い。

## Consequences

- 良くなること：検索が 1 シャード（大きなショップは 4）だけを読み、速い。分離が 1 つの関数と返す前の確かめの 2 重になる。
- 引き受けるコスト：ポッドごとのドメインの最小の費用。辞書の更新に索引の作り直しが要る（四半期に 1 回まで）。

## Confirmation

- 性質ベーステスト PROP-SRCH-001（分離）、PROP-SRCH-002（反映の順序）、PROP-SRCH-003（公開）。
- lint：`packages/search` の外で OpenSearch の問い合わせを作るコードを禁止する。
- 本番：返す前に捨てた件の数（0 が目標、SEV1 の候補）。

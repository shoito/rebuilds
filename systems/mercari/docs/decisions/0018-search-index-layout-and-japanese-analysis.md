---
status: accepted
date: 2026-10-10
---

# ADR-0018: 索引 `listings_v<n>` は S1 で主シャード 8・写し 1。題名は Sudachi の C の単位・B の単位・2-gram の欄を持ち、かなの揃えは 2-gram の欄だけ。ブランドは別名を展開して持つ。書き込みは `external_gte` と出品の `version`。売れた品は 365 日で消す。一致の定義 `match_v1` を検索と保存した検索で共有する

詳細は [search-and-discovery.md](../architecture/search-and-discovery.md) の 4・5 節。

## Context

- [ADR-0008](0008-search-engine-and-index.md) は、OpenSearch に販売中と売れた品を 1 つの論理の索引で入れ、Sudachi の B と C の単位、ICU の正規化、かな・カナの揃え、題名の 2-gram で引き、出品のバージョンを外部のバージョンにする、と決めた。売れた品の保持の期間と、欄・解析器の形は、この領域に任せた。
- いいねの数は速く変わる。外部のバージョン（`external`）は同じバージョンの書き直しを拒むので、いいねの数だけを直せない。
- 保存した検索の照合（[saved-searches-and-alerts.md](../architecture/saved-searches-and-alerts.md)）は、検索と同じ一致の意味を持たないと、検索では出るのに通知が来ない・その逆が起きる。
- Sudachi のトークナイザーは `split_mode` A・B・C を持つ（[elasticsearch-sudachi](https://github.com/WorksApplications/elasticsearch-sudachi)、2026-10-10 に確認）。

## Options

かなの揃え：

1. **2-gram の欄だけでひらがなをカタカナにする**
2. すべての欄の前でひらがなをカタカナにする

書き込みのバージョン：

- a. **`external_gte` と出品の `version`**
- b. `external` と出品の `version`、いいねの数は別の索引
- c. 内部のバージョンと、読んでから書く

一致：

- x. **語は欄をまたいで全部を含む（`cross_fields` と `and`）、または題名の 2-gram の 75%。保存した検索は語だけ**
- y. 語は 1 つの欄の中で全部（`best_fields`）

## Decision

1、a、x を採用する。

- 欄：`title`（`ja_c`）、`title.b`（`ja_b`）、`title.bigram`、`description`（`ja_c`、`_source` に持たない）、`brand_text`（正規化した keyword と `ja_c`）、`category_path`、`category_names`、`price`、`condition`、配送の欄、`published_at`、`sold_at`、`like_count`、`seller_tier`、`photo_quality`、`vis`、`mod_flags`、`version`。
- S1 は主シャード 8・写し 1。`_routing` なし。S2 で販売中と売れた品の索引に分ける（ADR-0008）。
- `search-indexer` は事象を受けたら出品を読み直して書く。措置・売り切れ・停止・削除・取引中は優先の待ち行列で流し、`vis` の写しを先に書く。
- 売れた品は `sold_at` から 365 日で消す（`search.sold_retention_days`）。
- 辞書の更新は新しい索引への作り直しと別名の付け替えで行い、四半期に 1 回まで。
- `match_v1`：問い合わせの C の単位の語のどれも、出品の全欄の C の単位の語にあるか、その語の B の単位の語がすべて題名・ブランドの B の単位の語にある（語の一致）。検索は語の一致か 2-gram の一致、保存した検索は語の一致だけ。

### 他の案を選ばなかった理由

- **2（全欄でカタカナ）**：Sudachi はひらがなの助詞や和語をカタカナにすると分け方を誤る。2-gram の欄だけで十分にかなの揺れを拾える。
- **b（別の索引）**：順位の式の計算で 2 つの索引を合わせる費用が大きい。
- **c（内部のバージョン）**：古い事象の上書きを防げない。
- **y（`best_fields`）**：「ブランドの名前＋品の種類」の問い合わせ（ブランドは `brand_text`、種類は題名）が引けない。

## Consequences

- 良くなること：保存した検索の結果が、必ず検索の結果の部分集合になる。いいねの数を出品のバージョンを上げずに直せる。
- 引き受けるコスト：`external_gte` では同じバージョンの文書を何度も書ける。書き込みは必ず出品を読み直した内容にする（事象の中身を書かない）。題名を 3 つの欄で持つので索引が大きくなる（`search-index-poc` で測る）。

## Confirmation

- PROP-SRCH-001（事象の重複・入れ替えで索引が core と一致）、PROP-SRCH-004（`match_v1` の語の一致を満たす出品は検索に出る）、PROP-SS-001（保存した検索の照合と参照の実装の一致）。
- 日本語の試験のベクトル。
- 日次の照合（core と索引の `(listing_id, version, status)`）。

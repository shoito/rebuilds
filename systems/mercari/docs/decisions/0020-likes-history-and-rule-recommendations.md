---
status: accepted
date: 2026-10-10
---

# ADR-0020: いいねは content の本人の表と、出品のいいねの数の 10 秒ごとのまとめた加算で持つ。閲覧の履歴は 1 人 200 件・90 日で、使わない設定を持つ。おすすめは好みの新着・保存した検索の新着・カテゴリの人気の 3 つの候補を決めた式で並べ、1 売り手 3 件までにする

詳細は [search-and-discovery.md](../architecture/search-and-discovery.md) の 7 節。

## Context

- いいね・閲覧の履歴は本人だけのデータ（[ADR-0007](0007-single-tenant-and-party-visibility.md)）。いいねの数は公開で、順位の式に使う。
- 人気の出品には 1 分に数百のいいねが来る。出品の行を毎回更新すると、購入の条件つきの更新と同じ行を取り合う。
- MVP のおすすめは規則と決めた式（[ADR-0010](0010-ml-boundary-for-pricing-and-recommendations.md)）。閲覧の履歴の利用の範囲は法務の確認待ち（L5）。

## Options

いいねの数：

1. **事象を 10 秒ごとに出品ごとにまとめ、加算で直す。日次で数え直す**
2. いいねのたびに出品の行を更新する
3. 数を持たず、要求の時に数える

おすすめ：

- a. **3 つの候補（好みの新着、保存した検索の新着、カテゴリの人気）と決めた式、多様さの上限**
- b. 人気だけ

## Decision

1 と a を採用する。

- `likes`（`user_id`、`listing_id`、`created_at`）は content の FORCE RLS の表。1 人 5,000 件。
- `like-counter` が 10 秒ごとに出品ごとの増減を `listings.like_count` に加算する。索引は 10% か 5 以上動いた出品だけ 15 分ごとに読み直す（`external_gte`。[ADR-0018](0018-search-index-layout-and-japanese-analysis.md)）。
- `view_history` は 1 人 200 件・90 日。`use_history = false` の利用者には好みの新着を作らない。
- おすすめ：`rec_score = 0.5 × affinity + 0.3 × fresh + 0.2 × pop24`。1 売り手 3 件、1 つの組 40% まで。見た出品と自分の出品を除き、`listingVisible()` を通す。利用者ごとに 10 分キャッシュ。

### 他の案を選ばなかった理由

- **2**：人気の出品の行のロックを、購入と取り合う（[ADR-0002](0002-transaction-state-machine-and-single-purchase.md)）。
- **3**：一覧と検索のたびに数えると重い。
- **b**：閲覧と保存した検索の好みを使わず、出品の速さに比べて見つかりにくい。

## Consequences

- 良くなること：いいねの急増が出品の行と購入に響かない。おすすめが説明のつく規則で出る。
- 引き受けるコスト：いいねの数は最大 10 秒（索引は 15 分）遅れる。日次の照合が要る。

## Confirmation

- 結合：いいねの事象の重複・欠けの後、日次の照合で数が `likes` と一致する。
- PROP-SRCH-003（おすすめにも `hidden` の出品が出ない）、PROP-SRCH-006（並べ替えで集合が変わらない）。
- `use_history = false` の利用者に閲覧の履歴の候補が出ない表駆動テスト。

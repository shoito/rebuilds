---
status: accepted
date: 2026-10-10
---

# ADR-0056: 表示の点は、公開して削除していないレビューの単純な平均を小数 2 桁で、3 件以上で出す（順位の式はベイズの平均を別に持つ）。集計は `review.revealed`・`review.removed` の事象で core の `listing_review_stats` をレビューの ID の冪等で直し、日次に数え直す。削除は決めた基準の表のどれかに当たり、`moderation_actions` に根拠を書いたときだけで、文を隠して集計から外し、行は残す

詳細は [reviews.md](../architecture/reviews.md) の 5・7 節。

## Context

- レビューは content、リスティングは core にある（[ADR-0001](0001-platform-and-stack.md)）。集計を検索と画面で使うには core に要る。
- 1〜2 件の平均は、1 件の点で大きく動き、ゲストを誤らせる。順位の式は事前の値で平滑したベイズの平均を使う（[ADR-0026](0026-ranking-formula-v1.md)）。
- レビューの削除はホストの評判と表現に関わる。削除の手続きと基準は法務の確認待ち（L13）。措置は根拠を書いてから効かせる（[ADR-0009](0009-trust-and-safety-and-ml-boundary.md)）。

## Options

1. **事象で core の集計を冪等に直し、日次に数え直す。表示は 3 件以上の単純な平均。削除は基準と根拠で、行を残す**
2. 表示のたびに content から集計する
3. 削除で行を消す

## Decision

1 を採用する。

- `listing_review_stats`・`host_review_stats` は、`review.revealed` で足し、`review.removed`（と異議の認容の戻し）で引く。`review_stat_applications` の `(review_id, op)` の一意で重複を除く。日次に content から数え直して照合する。
- 表示の総合の点は小数 2 桁の四捨五入、項目は 1 桁。3 件以上で出し、2 件以下は「新着」と件数。
- ゲストのプロフィールには本文と件数を出し、点の平均は出さない。
- 削除は基準のコード（`not_about_stay`・`personal_info`・`hate_discrimination`・`threat_harassment`・`extortion`・`incentivized`・`conflict_of_interest`・`legal_request`）と根拠を `moderation_actions` に書いた後に `removeReview()` だけが行う。本文と点を公開のビューから外し、集計から引き、行は残す。

### 他の案を選ばなかった理由

- **2**：検索の 1 件ごとに content を読むことになり、クラスタをまたぐ。
- **3**：異議の認容で戻せず、監査もできない。

## Consequences

- 良くなること：
  - 画面と検索が core の値だけで済み、集計は照合で直る。
  - 削除が基準と根拠に縛られ、戻せる。
- 引き受けるコスト：
  - 事象の遅れの間、表示の点が数秒古い。
  - 削除の基準は法務の結論で変わりうる（表の行の変更）。

## Confirmation

- PROP-REV-007（集計の収束）。
- 表駆動テスト：削除の基準の表と、措置の記録のない削除の拒否。

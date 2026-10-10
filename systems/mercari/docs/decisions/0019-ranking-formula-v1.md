---
status: accepted
date: 2026-10-10
---

# ADR-0019: 「おすすめ順」は `ranking_v1`：BM25 × 新しさ（半減 72 時間、下限 0.5）× いいね（1 + 0.15·ln(1+いいね)、1,000 で頭打ち）× 売り手の段（0.8〜1.05）× 写真の質（0.9〜1.0）。上位 1,000 件だけを式で並べ直し、同じ点は出品の ID の降順。式はバージョンで出す

詳細は [search-and-discovery.md](../architecture/search-and-discovery.md) の 5.5 節。

## Context

- [ADR-0008](0008-search-engine-and-index.md) は、おすすめ順を、欄ごとの重みの BM25 に、新しさの減衰、いいねの数（`log1p`）、売り手の評価の段、写真の質を掛ける決めた式にし、式と重みはこの領域で決めて、バージョンで出すとした。
- ML の順位は MVP の後（[ADR-0010](0010-ml-boundary-for-pricing-and-recommendations.md)）。
- 検索の結果の全件に式を当てると、広い問い合わせ（数百万件）で遅い（NFR-010 の p95 200ms）。

## Options

1. **積の式を Painless のスクリプトにし、`rescore`（上位 1,000 件）で当てる**
2. `function_score` の組み込みの関数（`exp` の減衰、`field_value_factor`）だけで組む
3. 全件に `script_score` を当てる

## Decision

1 を採用する。

```
score = text × fresh × pop × seller × photo
fresh  = 0.5 + 0.5 × exp(−ln 2 × age_hours / 72)
pop    = 1 + 0.15 × ln(1 + min(like_count, 1000))
seller = { new: 0.95, standard: 1.0, trusted: 1.05, low: 0.8 }
photo  = 0.9 + 0.1 × photo_quality
同じ点は listing_id の降順
```

- `age_hours` は要求の時刻から計算する。
- `rescore` の `window_size` は 1,000。おすすめ順の深さは 1,000 件まで。
- 式は保存したスクリプト `ranking_v1` として出す。重みを変えるときは `ranking_v2` を作り、本番の問い合わせで両方を計算して上位 30 件の重なりとクリック・いいねの率を 7 日比べてから切り替える。フラグで経路ごとに切り替えない。
- 既定の並べ替えは新しい順（ADR-0008）。

### 他の案を選ばなかった理由

- **2（組み込みの関数）**：新しさの下限（0.5）と、段の係数の表を素直に書けない。式の読みやすさと試験のしやすさで劣る。
- **3（全件）**：広い問い合わせで遅い。

## Consequences

- 良くなること：式が 1 か所に書かれ、例の点を試験のベクトルで確かめられる。ML を入れるときも、この式の後の並べ替えとして足せる（ADR-0010）。
- 引き受けるコスト：1,000 件の外は BM25 の順のまま。新しさの下限があるため、古いが人気の出品が上に残りやすい（新しさだけで見たい人は新しい順を使う）。

## Confirmation

- PROP-SRCH-005（単調性と同じ点の並び）、PROP-SRCH-006（並べ替えで集合が変わらない）。
- 試験のベクトル：[search-and-discovery.md](../architecture/search-and-discovery.md) の 5.5 節の例（13.81 と 14.90）。

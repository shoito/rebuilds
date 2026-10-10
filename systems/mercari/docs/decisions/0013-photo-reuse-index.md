---
status: accepted
date: 2026-10-10
---

# ADR-0013: 他の売り手の写真の使い回しは、OpenSearch の別の索引 `photo_hashes` に pHash を 16 ビットずつ 4 つに分けた帯を入れ、帯の一致で候補を引いて Hamming 距離で確かめる。距離 3 以下は必ず見つけ、結果は T&S の信号だけにする

詳細は [listings-and-photos.md](../architecture/listings-and-photos.md) の 5.4 節。

## Context

- 偽ブランドの業者と詐欺は、他の売り手の写真をそのまま使う。新しい写真を、販売中・取引中・最近売れた出品の写真（S1 で約 2 億枚）と比べたい。
- 近さは 64 ビットの pHash の Hamming 距離で見る（[ADR-0012](0012-photo-pipeline-and-perceptual-hashes.md)）。2 億枚と全部比べることはできない。
- 新しい写真は平均 17 枚/秒、山 70 枚/秒。結果は非同期の段の信号で、p95 60 秒の中に入ればよい（NFR-009）。
- 検索のエンジンとして OpenSearch をすでに持つ（[ADR-0008](0008-search-engine-and-index.md)）。

## Options

1. **OpenSearch の別の索引に 4 つの帯（16 ビット）を keyword で入れ、帯の一致で候補を引き、スクリプトの絞り込みで距離を確かめる**
2. Aurora content の表に帯の行を置き、索引で引いて SQL で距離を数える
3. OpenSearch の k-NN（2 値のベクトル、Hamming の空間）の近似の探し
4. Valkey に帯ごとの集合を置く

## Decision

1 を採用する。

- 文書は写真ごと：`photo_id`、`listing_id`、`seller_id`、`phash`、`dhash`、`b0`〜`b3`、`listing_status`、`created_at`。範囲は `on_sale`・`trading`・売れてから 90 日の `sold`。
- 引き方：`b0`〜`b3` のどれかが同じで、`seller_id` が違う文書を、`Long.bitCount(phash ^ q) <= 6` の絞り込みで最大 50 件。
- 4 つの帯の鳩の巣で、距離 3 以下は必ず見つける。距離 4 は約 90%、5 は約 74%、6 は約 58% で見つかる（違いのビットが一様に散るとした計算）。
- 文書の多い帯の値（5 万件超）は「よくある値」として引かない。
- 一致は信号 `photo_reuse` にし、措置は規則と人が決める（[ADR-0009](0009-trust-and-safety-pipeline-boundary.md)）。自分の再出品は除く。

### 他の案を選ばなかった理由

- **2（Aurora）**：帯の行が 8 億になり、content のクラスタの書き込みと容量を大きく使う。
- **3（k-NN）**：近似で、取りこぼしの保証を言えない。距離 3 以下を必ず見つける性質を試験で確かめられない。
- **4（Valkey）**：2 億枚 × 4 帯をメモリーに置く費用が大きく、正本にもならない。

## Consequences

- 良くなること：既存の OpenSearch で、決まった保証つきの近さの探しができる。索引は core の写真の列から作り直せる。
- 引き受けるコスト：1 回 1.2 万件前後をスクリプトで比べる（20〜40ms の見込み）。距離 4〜6 の一部を取りこぼす。帯の値の偏りの扱いが要る。

## Confirmation

- PROP-LST-005（距離 3 以下の組を必ず見つける。帯の分け方の参照の実装との比べ）。
- `search-index-poc` で、引き方の時間と、生成した歪みの写真での見つかる率を測る。
- T&S の評価の集まりで、`photo_reuse` の信号の寄与を見る。

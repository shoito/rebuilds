---
status: accepted
date: 2026-10-10
---

# ADR-0015: 地名の辞書は core の PostGIS の `places` を正にし、OpenSearch の `places` の索引に写す。名前は日本語・かな・ローマ字・英語・中国語（簡体・繁体）・韓国語を持ち、ローマ字は長音・撥音・訓令式の揺れを畳んだ正規の鍵で引く。行政の区域は多角形、駅と観光地は点と半径

詳細は [location-and-geo.md](../architecture/location-and-geo.md) の 6 節。

## Context

- 海外のゲストは、日本の地名を英語・中国語・韓国語で入れる。ローマ字は長音（Tōkyō、Toukyou、Tokyo）、撥音（Shimbashi、Shinbashi）、訓令式（Sibuya）で揺れる（[intent.md](../intent.md)）。
- 地名は検索の範囲（多角形か点と半径）になる（[ADR-0003](0003-search-for-date-range-availability.md)）。行政の区域の多角形は、税と条例の判定にも使う（[taxes.md](../architecture/taxes.md)）。
- 入力の補完は p95 100ms（NFR-001）。
- 住所の検索の提供者は地名の補完を持つが、検索の範囲の多角形と多言語の別名を本システムで決められない。

## Options

1. **自前の辞書（PostGIS を正、OpenSearch に写す）と正規の鍵**
2. 住所の検索の提供者の地名の補完をそのまま使う
3. OpenSearch だけに辞書を持つ

## Decision

1 を採用する。

- 正本は core の `places`（種類 `prefecture`・`municipality`・`ward_area`・`station`・`poi`、`geom`、半径）と `place_names`（言語、名前、読み、正規の鍵）。
- `normPlaceKey`：NFKC と小文字、ダイアクリティカルマークの除去、区切りの除去、かなのヘボン式への変換、訓令式からヘボン式、`m`＋`b/m/p` を `n`、`ou`・`oo`・`oh`（子音か終わりの前）を `o`、`uu` を `u`、`tch` を `cch`。接尾の語（市、区、駅、station など）を除いた鍵も作る。
- 漢字の字体の揺れ、簡体と繁体、ハングル、英語の通称は別名の表で引く。
- OpenSearch の `places` に写し、正規の鍵の前方一致と日本語の名前の前方一致で補完する。点は文字の一致 × (1 + log10(1 + リスティングの数)) × 種類の重み。
- 多角形は 50 m で単純化して 100 m 広げてから `geo_shape` に入れる。
- データの出どころとライセンスは `place-dictionary-poc` で確かめる。

### 他の案を選ばなかった理由

- **2**：範囲の多角形と、税・条例の区域との整合を持てない。提供者を替えると検索の結果が変わる。入力の語を提供者に毎回送る。
- **3**：多角形の正確な判定（税・条例）を PostGIS で行いたい。正本を検索のエンジンに置かない（[ADR-0001](0001-platform-and-stack.md)）。

## Consequences

- 良くなること：
  - 地名の揺れを、1 つの関数と試験のベクトルで確かめられる。
  - 検索の範囲と税・条例の区域が同じ多角形から来る。
- 引き受けるコスト：
  - 辞書の作成と更新（市町村の合併、新しい駅）の運用。
  - 畳み込みで別の地名が同じ鍵になる組（`oo` を含む地名）を、人気の順と親の地名で分ける必要がある。

## Confirmation

- PROP-GEO-005（冪等と揺れの表）、PROP-GEO-006（多角形の包含）。
- 試験のベクトル：[quality.md](../quality.md) の 2.2.1 節 E の地名の表と、[location-and-geo.md](../architecture/location-and-geo.md) の 6.2 節の表。

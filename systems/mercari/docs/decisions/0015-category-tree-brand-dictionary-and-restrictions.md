---
status: accepted
date: 2026-10-10
---

# ADR-0015: カテゴリの木・状態の段・サイズの方式・ブランドの辞書・カテゴリごとの制限を 1 つのバージョンの付いたカタログの設定として出す。カテゴリの ID は変えず、廃止は後継の ID で写す。ブランドは ID と別名の表で持ち、正規化の関数を索引・検索・保存した検索・価格の提案で共有する

詳細は [categories-brands-and-pricing-suggestions.md](../architecture/categories-brands-and-pricing-suggestions.md) の 4・5 節。

## Context

- 出品は 3 階層のカテゴリ、6 段の状態、ブランド、サイズを持つ（[intent.md](../intent.md)）。同じ値を、出品の画面、検索の索引と絞り込み、保存した検索の照合の鍵、価格の提案の鍵、T&S の制限と危険の段、手数料の表の鍵が使う。
- どれか 1 つが別のバージョンの木・辞書を見ると、保存した検索の取りこぼしや、価格の提案の鍵のずれが起きる。
- ブランドは英字・カナ・略称・誤記の揺れが多い。Sudachi の辞書の付け直しは次の blue/green のデプロイまで反映しない（[Plugins by engine version](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/supported-plugins.html)、2026-10-10 に確認）。
- どのカテゴリを制限するかは法務の確認待ち（L10）。
- 本家のカテゴリ・ブランドの一覧を取り出して使わない（[リポジトリ共通の ADR-0007](../../../../docs/decisions/0007-no-reuse-of-original-implementation.md)）。

## Options

1. **木・属性・状態の段の文言・ブランドの辞書・制限を 1 つのカタログの設定（`catalog_version`）にまとめ、承認して公開し、全サービスが写しを読む**
2. それぞれを別の表・別の設定で持ち、各サービスが DB を直接読む
3. ブランドの別名を Sudachi の利用者の辞書に入れ、解析器で揃える

## Decision

1 を採用する。3 は採らない。

- カテゴリの ID は整数で、変えない・使い回さない。移動は親を変えるだけ。廃止は `retired` と `successor_id`。
- 出品は `category_tree_version` を持ち、読み出しで後継に写す。
- 属性：`size_scheme`、`brand_mode`、`condition_scheme`、`fee_class`、`default_shipping_tiers`、`restriction`、`min_seller_age`・`min_buyer_age`、`keywords`。
- 状態の段は英語のコード（`new_unused` など 6 つ）で持ち、文言は設定に置く。
- ブランドは `brands` と `brand_aliases`。正規化の関数 `normalizeBrandText`（NFKC、小文字、かなをカタカナ、空白・中黒・ハイフン類の除き、長音・ヴの揃え）を 1 か所に置く。索引の時に正式な名前と全別名を `brand_text` に展開する。
- 制限の種類（`prohibited`・`requires_review`・`requires_kyc`・`seller_cap`・`notice`）の枠を持ち、値は法務の L10 の後に入れる。本番の制限が空なら GA の判定を通さない。
- 公開は作成者と別の承認者の 2 人。公開で S3 に写しを書き、`catalog.published` を出す。

### 他の案を選ばなかった理由

- **2（別々）**：バージョンの揃わない時間ができ、照合・提案の鍵がずれる。
- **3（Sudachi の辞書）**：ブランドを足すたびに索引の作り直しか blue/green を待つ。英字とカナの別名を結ぶ表がどのみち要る。

## Consequences

- 良くなること：全サービスが同じバージョンの木と辞書で動く。ブランドの追加が索引の作り直しを待たない（影響する出品の読み直しだけ）。
- 引き受けるコスト：カタログの設定の公開の手続きと、バージョンの配りの仕組みが要る。移動・廃止のたびに影響する出品の索引を直す。

## Confirmation

- PROP-CAT-001（ID の使い回しがない、後継の連なりが循環しない）、PROP-CAT-002（正規化の冪等と、3 つの口で同じ関数）。
- 試験のベクトル：ブランドの表記の揺れ。
- 制限の種類ごとの同期の検査の表駆動テスト。

---
status: accepted
date: 2026-10-10
---

# ADR-0050: キャッシュの鍵は 1 つの関数（`packages/edge-keys`）で（ショップ、世代、テーマのバージョン、マーケット、言語、正規化したパスとクエリ）から作る。世代の番号はホスト名の KeyValueStore の値に入れて配り、`cache-invalidator` がショップごとに 2 秒の窓でまとめて上げる。表示に関わる変更だけが世代を上げる。大きなショップ（`fine` の型）は、商品のページをハンドルのハッシュで 64 の桶に分け、桶ごとの世代を持つ

## Context

[architecture/README.md](../architecture/README.md) の 6 節は、ショップ（大きなショップは商品・コレクションの単位）の世代の番号をキャッシュの鍵に入れて KeyValueStore で配り、CloudFront の無効化の API を主にしないと決めた。決めることは次である。

- 鍵の材料と正規化。鍵からショップが抜けると、他のショップのページが出る（NFR-008）。
- 何が世代を上げるか。上げすぎると当たりの割合（90% の見込み）が落ちる。
- 大きなショップの単位。KeyValueStore は鍵 512 バイト、値 1 KB、1 つの保存 5 MB、1 つの関数に 1 つの保存（[CloudFront quotas](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html)、2026-10-10 に確認）。商品ごとの世代は置けない。
- CloudFront は、パスとタグでの無効化を 1 秒 150 まで受ける（同上）。タグでの無効化は、元の応答のヘッダーのタグ（1 オブジェクト 50 まで）で無効にする（[Invalidating content by cache tags](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/invalidation-by-tags.html)、同日に確認）。完了の時間は文書にない（未検証）。

## Options

大きなショップの単位：

1. **ショップの世代＋商品のページの 64 の桶の世代（KeyValueStore の値）**
2. ショップの世代だけ
3. 商品ごとのタグでの無効化（CloudFront）

## Decision

1 を採用する。詳細は [storefront-api-and-caching.md](../architecture/storefront-api-and-caching.md) の 4・5・7 節。

- 鍵の材料：`<shop_short>.<gen>.<market>.<lang>`（`fine` の商品のページは `<shop_short>.p<pgen>.<bucket_gen>.<market>.<lang>`）と、正規化したパスとクエリ（許可の一覧の引数だけ、名前の順）。テーマのバージョンは世代に含める。IP・Cookie の全体・`User-Agent`・`Accept-Language` は入れない。
- CloudFront Functions と元の TypeScript は、同じ試験のベクトルで同じ鍵を出す。元は鍵の材料を計算し直して比べ、違えば `no-store`。
- 世代を上げる事象：`display`・`price`・`publication` の変更、テーマの公開、メニュー・ページ・ショップの設定、為替の更新。在庫の数と `internal` は上げない。
- `cache-invalidator` はショップごとに 2 秒でまとめる。公開の取り消しと価格の誤りの直しは同期の経路で上げる。
- `fine` の型（商品 1 万超かつ 1 時間の上げ 60 回超）：商品のページは `pgen` と `fnv1a32(handle) mod 64` の桶の世代で、商品の変更は桶と `gen`（10 秒に 1 回まで）を上げる。
- `s-maxage=300, stale-while-revalidate=60, stale-if-error=86400`。Origin Shield を使う。

### 他の案を選ばなかった理由

- **2（ショップだけ）**：商品の多いショップで、商品の更新のたびに全ページが外れ、当たりの割合が落ちる。
- **3（タグ）**：無効化の完了の時間が文書になく、NFR-011 を約束できない。1 秒 150 はアカウントの全体の上限で、S1 の Admin API の書き込み（最大 5,000 件/秒）のまとめの後でも足りない場合がある。`edge-cache-generation-poc` で比べる候補として残す。

## Consequences

- 良くなること：
  - 無効化が鍵の変更で、エッジの全部に同時に効き、外部の無効化の API の上限に依らない。
  - 鍵の組み立てが 1 つの関数で、ショップの抜けを試験で止められる。
- 引き受けるコスト：
  - KeyValueStore の 5 MB に、ホストの表と世代を収める必要がある（S1 の登録 10 万ショップで足りない見込み。保存の分け方は shops-and-pods の領域）。
  - 世代を上げた直後に外れが集中する。Origin Shield と要求のまとめで抑える。

## Confirmation

- 性質ベーステスト PROP-EDGE-001（鍵の単射）、PROP-EDGE-002（正規化の冪等）、PROP-EDGE-003（世代の単調）。
- 合成の見張り：価格の変更から表示までの時間（NFR-011）。
- PoC：`edge-cache-generation-poc` で KeyValueStore の伝わりとタグでの無効化の時間を比べる。

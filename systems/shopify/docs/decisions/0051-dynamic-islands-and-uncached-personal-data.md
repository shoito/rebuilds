---
status: accepted
date: 2026-10-10
---

# ADR-0051: キャッシュする HTML に、カート・ログインした買い手・在庫の数を焼き込まない。それらは「島」（`/_<brand>/islands/…`）の小さな応答でブラウザが取る。在庫と価格の島はエッジで 5 秒キャッシュし、カートと買い手の島はキャッシュしない。キャッシュする経路では Cookie を元に渡さず、`Set-Cookie` のある応答はキャッシュしない

## Context

- ストアフロントはキャッシュが先（[architecture/README.md](../architecture/README.md) の 1.2 節）。在庫の数や価格のような速く変わる値は、キャッシュしたページに焼き込まない、と決めている。
- ログインした買い手の名前やカートの中身が、キャッシュに入って他の買い手に出る事故は、漏えいである（NFR-008）。
- フラッシュセールの間、在庫の表示の要求が増える（[architecture/README.md](../architecture/README.md) の 2 節）。

## Options

1. **キャッシュする HTML は共通の値だけ。個人と速く変わる値は島で取る**
2. ログインした買い手のページはキャッシュしない（ページ全体を元で描く）
3. エッジで HTML を組み立てる（Edge Side Includes の形）

## Decision

1 を採用する。詳細は [storefront-api-and-caching.md](../architecture/storefront-api-and-caching.md) の 6 節。

- 島は 3 つ：在庫と価格（エッジ 5 秒、フラッシュセールは Valkey の目安の値で 1 秒）、カート（キャッシュなし）、買い手（キャッシュなし）。
- HTML は島の場所だけを持ち、既定のテーマの小さなスクリプトが埋める。JavaScript のない端末では目安の値のまま、フォームで動く。
- キャッシュする経路は Cookie を元に渡さず、元は `Set-Cookie` を返さない。返した応答は CloudFront の設定でキャッシュしない。
- テンプレートの側は [ADR-0047](0047-loom-data-access-and-prefetch.md) で、キャッシュするページの個人の drop を翻訳のエラーにする。
- 「残りわずか」の表示の既定は法務の確認待ち（L2）。

### 他の案を選ばなかった理由

- **2（ログインのページをキャッシュしない）**：ログインした買い手が増えると元の負荷が増え、TTFB の目標を外す。キャッシュする・しないの判定の誤りで漏れる経路が残る。
- **3（ESI）**：CloudFront は ESI を持たず、エッジでの組み立てに Lambda@Edge が要る。東京の元で描く決定（[architecture/README.md](../architecture/README.md) の 6 節）と合わない。

## Consequences

- 良くなること：HTML のキャッシュが買い手に依らず、当たりの割合が高い。個人の値の漏れの経路が島の 2 つに絞られる。
- 引き受けるコスト：島の要求が 1 ページに 1〜3 件増える。在庫の島は短いキャッシュで抑える。

## Confirmation

- 性質ベーステスト PROP-EDGE-004（キャッシュする経路の応答に個人の値と `Set-Cookie` がない）。
- 負荷：フラッシュセールの場面で在庫の島が DB を読まない（[quality.md](../quality.md) の 2.2.1 節 H）。

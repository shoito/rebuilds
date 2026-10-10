---
status: accepted
date: 2026-10-10
---

# ADR-0049: Storefront API は `https://<shop-host>/api/<version>/graphql.json` に出し、公開のトークン（`<brand>_sf_`、ブラウザ向け、販売のチャネルに結び付く）と秘密のトークン（`<brand>_sfp_`、サーバー向け、`<Brand>-Buyer-Ip` を必須）を持つ。1 つのクエリの費用は 1,000 まで。買い手の通信に決まった量の上限は置かず、（ショップ、買い手の IP）の費用のバケット、カートとチェックアウトの作成の速さの上限、WAF の Bot Control で絞る。永続化したクエリの `GET` はエッジでキャッシュする

## Context

- ヘッドレスのフロントエンドは、ブラウザからも、事業者のサーバー（SSR）からも Storefront API を呼ぶ。
- 本家は公開と秘密のトークンを持ち、買い手の IP をヘッダーで渡させて IP の単位でボットを絞る。買い手の通信に決まった上限を置かず、チェックアウトの作成を絞る（[Storefront API](https://shopify.dev/docs/api/storefront)、[API usage limits](https://shopify.dev/docs/api/usage/limits)、2026-10-10 に確認）。
- フラッシュセールの抜け道（Storefront API のカートから直接チェックアウトへ）を塞ぐ必要がある（[architecture/README.md](../architecture/README.md) の 6 節）。
- Storefront API p95 150ms（NFR-003）。

## Options

1. **公開と秘密のトークン、全体の量の上限なし、（ショップ、IP）の費用と作成の速さの上限、WAF**
2. トークンごとの費用のバケット（Admin API と同じ）
3. 上限なし（WAF だけ）

## Decision

1 を採用する。詳細は [storefront-api-and-caching.md](../architecture/storefront-api-and-caching.md) の 8 節。

- 公開のトークンは `X-<Brand>-Storefront-Access-Token`、秘密のトークンは `<Brand>-Storefront-Private-Token` と `<Brand>-Buyer-Ip`（なければ 400）。トークンのショップとホストのショップが違えば 401。
- 費用は Admin API と同じ計算。1 クエリ 1,000 まで。
- （ショップ、IP）の費用のバケット：容量 2,000、回復 1 秒 200。カートの作成 1 分 30、チェックアウトへの送り 1 分 10（フラッシュセールは許可証）。秘密のトークンごとの合計の回復 1 秒 2,000。超えたら `THROTTLED`（HTTP 200）。
- IP はバケットの鍵のハッシュにだけ使い、ログに書かない。
- 公開のトークンで、`cart`・`customer` を使わない永続化したクエリの `GET` は、エッジで 60 秒キャッシュする。

### 他の案を選ばなかった理由

- **2（トークンごと）**：公開のトークンは全買い手で共有されるので、トークンの上限は 1 人のボットで全買い手が止まる。
- **3（WAF だけ）**：重いクエリを速く連打するボットを、件数の上限では止めにくい。チェックアウトの作成の抜け道を塞げない。

## Consequences

- 良くなること：買い手 1 人の重さで絞り、正しい買い手を巻き込まない。キャッシュで元の負荷が減る。
- 引き受けるコスト：秘密のトークンを持つサーバーが IP を偽ると、IP の上限を回避できる。秘密のトークンごとの合計の上限で抑える。

## Confirmation

- 性質ベーステスト PROP-SFAPI-001（見積もり ≥ 実際）。
- 結合テスト：他のショップのホストでのトークンの拒否、`<Brand>-Buyer-Ip` なしの 400、作成の速さの上限、許可証なしのチェックアウトへの送りの拒否。

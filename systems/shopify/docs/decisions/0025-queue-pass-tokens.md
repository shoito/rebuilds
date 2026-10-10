---
status: accepted
date: 2026-10-10
---

# ADR-0025: 許可証は HMAC-SHA256 で署名した短い値にし、ショップ・セール・セッションのハッシュ・期限 15 分・一意の ID を持つ。エッジは署名と期限とセッションを確かめ、`checkout` はチェックアウトの作成で一意の ID を DB に記録して 1 回だけ使わせる。鍵は KeyValueStore の鍵の ID で回す

## Context

- 許可証は「期限 15 分、1 回だけ」（[runbooks/](../runbooks/README.md) の 2 節）。待合室を通らない経路（Storefront API、古いチェックアウトの URL）を塞ぐ（[architecture/README.md](../architecture/README.md) の 6 節のリスク）。
- エッジ（CloudFront Functions）は、外への通信を持たず、短い時間で動く。確かめは署名と KeyValueStore の値だけで行う必要がある。
- 1 回だけ使わせるには、どこかで使った印を持つ。エッジには書き込める状態がない。

## Options

1. **HMAC の署名。エッジは状態なしで確かめ、1 回だけの判定はチェックアウトの作成で DB に記録する**
2. 公開鍵の署名（Ed25519）
3. 許可証を Valkey に置き、毎回問う

## Decision

1 を採用する。詳細は [flash-sales-and-queueing.md](../architecture/flash-sales-and-queueing.md) の 6 節。

- 形：`<kid>.<base64url(本体)>.<base64url(HMAC-SHA256(鍵, 本体))>`。本体は `shop_id`、`sale_id`、`sid_hash`（セッションの cookie の値の SHA-256 の先頭 16 バイト）、`iat`、`exp`（`iat` ＋ 15 分）、`jti`（UUIDv7）。
- 鍵：セールの面ごとに 2 つ（今と次）。KeyValueStore に `kid` → 鍵を置き、7 日ごとに回す。鍵は `waiting-room` が Secrets Manager から配る。
- エッジ：対象のショップのチェックアウトの経路とカートへの追加の経路で、cookie の許可証の署名・`exp`・`sid_hash` を確かめる。外れたら待合室のページへ送る。
- `checkout`：チェックアウトの作成で、もう一度確かめ、`queue_pass_redemptions`（`shop_id`, `jti` の一意）に行を入れる。重複なら、同じセッションの既存のチェックアウトへ戻す。別のセッションなら 403。送信（支払いの開始）でも、そのチェックアウトに結び付いた `jti` を確かめる。
- 許可証の期限が切れても、作成済みのチェックアウトの送信は、作成から 15 分まで受ける。

### 他の案を選ばなかった理由

- **2**：CloudFront Functions の暗号の関数で確かめる手段が限られ（未検証）、確かめの時間の予算に余裕がない。鍵は本システムの中だけで使うので、共有の鍵で足りる。
- **3**：エッジから Valkey に問えない。元へ毎回送ると、待合室の意味がなくなる。

## Consequences

- 良くなること：エッジの確かめが状態なしで速い。1 回だけの判定は DB の一意の制約で正しい。
- 引き受けるコスト：同じ許可証で、作成の前に複数のカートへの追加はできる（カートは在庫を引き当てないので害がない）。

## Confirmation

- 試験のベクトル：署名、期限、`sid_hash` の不一致、鍵の回しの前後。
- 性質ベーステスト：任意の並行の作成で、1 つの `jti` から作られるチェックアウトは 1 つ（PROP-FLS-003）。

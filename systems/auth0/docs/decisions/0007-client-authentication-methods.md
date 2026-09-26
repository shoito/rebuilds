---
status: accepted
date: 2026-09-27
---

# ADR-0007: クライアントの認証は `client_secret_basic`・`client_secret_post`・`private_key_jwt`・`none` にし、秘密で署名する方式は持たない

詳細は [authentication-flows.md](../architecture/authentication-flows.md) の 6 節。

## Context

トークンのエンドポイントで、機密のクライアント（サーバーで動く Web アプリ、M2M）を認証する方式を決める。

- 本家 Auth0 は `client_secret_basic`・`client_secret_post`・`private_key_jwt`・`none` を出す。`private_key_jwt` のアサーションの署名は `RS256`・`RS384`・`PS256`（`samples.auth0.com` の discovery、2026-09-27 に確認）。
- 本システムは、クライアントの秘密を SHA-256 のハッシュでしか持たない（[ADR-0004](0004-credential-storage.md)）。秘密そのものを鍵にする `client_secret_jwt`（HMAC）は検証できない。
- `private_key_jwt` は、秘密を送らずに済み、RFC 9700 と FAPI 2.0 が勧める方式に近い。
- mTLS（RFC 8705）は、TLS の終端の場所（CloudFront、ALB、カスタムドメイン）と関わる。

## Options

1. **`client_secret_basic`・`client_secret_post`・`private_key_jwt`・`none`。mTLS は MVP の後**
2. 1 に `client_secret_jwt` を足す（秘密を KMS で暗号化して持つ）
3. `private_key_jwt` と `none` だけにする

## Decision

1 を採用する。

- アプリは方式を 1 つだけ登録する。登録と違う方式、2 つの方式を同時に使った要求は `invalid_client`。
- 秘密は 2 つまで同時に有効にし、ローテーションの猶予を作る。
- `private_key_jwt`：
  - 公開鍵は 2 つまで。`alg` は `RS256`・`PS256`・`ES256`。`none`・`HS*` は拒否する。
  - `aud` はトークンのエンドポイントの URL か `issuer`。`exp − iat` は 300 秒以下。時計のずれは 30 秒まで。
  - `jti` を `exp` まで覚えて再利用を拒否する。置き場所は Valkey、使えないときは Aurora。両方だめなら 503（fail-open にしない）。
- ダッシュボードで、新しい機密のアプリに `private_key_jwt` を勧める。
- 2 は、秘密を元に戻せる形で持つことになり、[ADR-0004](0004-credential-storage.md) の「DB が漏れてもシークレットが漏れない」を崩す。
- 3 は、秘密を使う多数の既存のライブラリと、本家から移るアプリを締め出す。

## Consequences

- 良くなること：
  - DB が漏れても、クライアントの秘密で認証を通せない。
  - 本家と同じ 4 つの方式で、多くのライブラリがそのまま動く。
- 引き受けるコスト：
  - `client_secret_jwt` を使う本家の利用者（少ないと見込む。未検証）は、方式を変える必要がある。
  - `jti` の保存が、M2M の経路に Valkey への書き込みを 1 回足す。

## Confirmation

- 表駆動テスト：方式 × アプリの登録 × 要求の形の組ごとの結果。
- 否定のテスト：`alg: none`、`HS256`、期限の長すぎるアサーション、同じ `jti` の 2 回目、他のアプリの `kid`。
- 結合テスト：Valkey を止めても `jti` の再利用が拒否される。
- 適合試験：OIDC Basic の OP のプロファイルが、`client_secret_basic` と `client_secret_post` の両方で通る。

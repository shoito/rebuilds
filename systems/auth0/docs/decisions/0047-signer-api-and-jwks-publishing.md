---
status: accepted
date: 2026-09-27
---

# ADR-0047: Signer はテナントの 3 つの種類のトークンと、型を分けた外部 IdP のアサーションだけに署名し、JWKS は Worker が S3 に書き出してエッジで配る

詳細は [keys-and-secrets.md](../architecture/keys-and-secrets.md) の 6 節・7 節。

## Context

[ADR-0003](0003-token-formats-and-signing-keys.md) は、Signer がテナント・`kid`・クレームを受けて署名した JWT を返し、任意のバイト列には署名しないと決めた。[ADR-0059](0059-signer-isolation.md) は、Signer のネットワークを隔離し、署名のポート（Auth からだけ）と鍵の管理のポート（Management API からだけ）を分けた。[ADR-0005](0005-authentication-path-availability.md) は、JWKS・discovery を S3 に書き出して CloudFront から配り、オリジンの障害中は古い版を返すと決めた。[ADR-0058](0058-edge-and-custom-domains.md) は、キャッシュの期間をこの領域に任せた。

決めること：

- Signer が「何に」署名してよいか。Auth が乗っ取られたとき、Signer で止められる範囲。
- 外部の IdP へのクライアントの認証（Apple のクライアントシークレットの JWT、エンタープライズの OIDC 接続の `private_key_jwt`、SAML の AuthnRequest の署名）を、どこで署名するか。connections の領域（[ADR-0016](0016-social-connections-and-idp-tokens.md)、[ADR-0017](0017-enterprise-connections.md)）は、これを Signer で行うことを求めている（秘密鍵を Signer の外で扱わない。[ADR-0003](0003-token-formats-and-signing-keys.md)）。
- 鍵の生成と状態の遷移を、どのサービスが書くか。
- JWKS の書き出しの流れとキャッシュの期間。

## Options

Signer の API：

1. **トークンの種類（`id_token`・`access_token`・`logout_token`）を受け、種類ごとに `typ`・必須のクレーム・有効期間の上限を Signer の中で検査する。鍵は `current` に限り、呼び出し側に選ばせない**
2. クレームと `kid` を受けて、そのまま署名する

鍵の生成：

- a. **Signer の中で鍵の対を作って暗号化し、暗号文と公開鍵だけを返す。行と状態の遷移は Management API が書く**
- b. Signer が DB に直接書く

JWKS のキャッシュ：

- x. **RP 300 秒、CloudFront 60 秒、オリジンの障害中は 24 時間の古い版**
- y. 長いキャッシュ（1 日）と、変更のたびの無効化

## Decision

1、a、x を採用する。

- 署名の API：`POST /v1/sign`、`POST /v1/sign-batch`（最大 2 件）。種類ごとに `typ`（`JWT`・`at+jwt`・`logout+jwt`）、必須のクレーム、禁止のクレーム（ログアウトトークンの `nonce`）、`exp − iat` の上限（2,592,000 秒・86,400 秒・120 秒）、`iat` のずれ（±60 秒）、`iss` が `signing_key_issuers` にあること、大きさ 8 KiB を検査する。違反は 400 でアラート。
- 鍵の管理の API：`keys:generate`（暗号文と公開鍵を返す）、`keys:invalidate`（キャッシュを捨てて読み直す）。状態の遷移は Management API が 1 つのトランザクションで書き、outbox に `jwks.changed` を入れる。Signer は 2 秒ごとに `signing_key_state_versions` を見て追いつく。
- **外部 IdP のアサーション**（2026-09-27 の統合で追加）：トークンの署名の API とは別のエンドポイント `POST /v1/sign-external-assertion` にし、型も分ける。
  - `purpose` は `apple_client_secret`（E6）、`oidc_client_assertion`（E14）、`saml_authn_request`（E14）の 3 つだけ。
  - 署名に使うのは、テナントの署名鍵ではなく、接続ごとの鍵（`external_idp_keys`）。Apple の `.p8` はテナントが登録し、Management API が Signer の `POST /v1/external-keys:import` に渡して暗号文を得る（Management API は平文を保存もログもしない）。OIDC・SAML の鍵の対は `POST /v1/external-keys:generate` で Signer の中で作り、公開鍵（JWK、SAML の証明書）だけを返す。どちらも鍵の管理のポート（Management API からだけ）で受ける。
  - 呼び出し側（Auth）が渡すのは `tenant_id`・`connection_id`・`purpose` と、`saml_authn_request` の AuthnRequest の ID・`AssertionConsumerServiceURL` だけ。`iss`・`sub`・`aud`（宛先）・有効期間は、Signer が `external_idp_keys` の登録の値から決める（Apple：`aud` は `https://appleid.apple.com`、有効 1 時間。OIDC：`aud` は登録した IdP のトークンのエンドポイント、`jti` は Signer が作る、有効 300 秒。SAML：`Destination` は登録した IdP の SSO の URL）。任意のクレーム・任意の宛先には署名しない。
  - 鍵は `<brand>-signing-keys` の KMS の鍵の DEK で暗号化し、暗号化の文脈は `purpose=external-idp-key`、`tenant_id`、`connection_id`（[ADR-0045](0045-kms-key-hierarchy.md)）。
- Signer の DB のロールは、`signing_keys`・`signing_key_state_versions`・`signing_key_issuers`・`external_idp_keys` の SELECT と、`signing_keys.last_used_at` の UPDATE だけ（[ADR-0059](0059-signer-isolation.md) のロールの表と同じ）。
- Back-Channel Logout のトークンは、Worker が Auth の内部の API を通して求める（[ADR-0028](0028-logout-rp-initiated-and-back-channel.md)）。Signer は Worker から受けない。
- JWKS：Worker が outbox の事象から、ホスト名ごとに `jwks.json` と `openid-configuration` を作って S3 に書き、失効・緊急のときは CloudFront を無効化し、60 秒後に CloudFront 経由で取り直して SHA-256 を確かめる。`Cache-Control: public, max-age=300, s-maxage=60, stale-while-revalidate=60, stale-if-error=86400`。
- 2 は、Auth が乗っ取られると、任意の `typ`・任意の期限のトークン（10 年の ID トークンなど）を作れる。
- b は、Signer の DB の権限が広がり、outbox との一貫性を Signer が持つことになる。
- y は、変更のたびの無効化に頼り、無効化の失敗が長い食い違いになる。

## Consequences

- 良くなること：
  - Auth の乗っ取りでも、作れるトークンの形と期限が限られる。
  - 平文の秘密鍵は Signer の外に出ない。鍵の生成を含めて、秘密鍵に触れるのは Signer だけ。
  - JWKS がオリジンの障害に強い。
- 引き受けるコスト：
  - トークンの種類と外部 IdP の用途を足すたびに、Signer の変更（`security:sensitive`）が要る。
  - 外部 IdP の用途で、Signer に届く要求の種類と、Signer の中の鍵の種類が増える。用途を 3 つに限り、宛先を登録の値に固定するので、Auth が乗っ取られても、任意の IdP・任意の宛先のアサーションは作れない。
  - 状態の遷移から Signer の反映まで、最大 2 秒の窓がある。
  - RP は JWKS を最大 5 分古く持つ。`next` の ready を 15 分にして吸収する（[ADR-0046](0046-signing-key-lifecycle.md)）。

## Confirmation

- 表駆動テスト：署名の要求の種類 × `typ` × クレーム × 期限 × テナントの組ごとの結果。
- 性質ベーステスト：任意の要求で、Signer が返す JWT の `kid` は、その時点のテナントの `current`。他のテナントの鍵で署名されない。
- 表駆動テスト（外部 IdP のアサーション）：`purpose` × 接続 × テナントの組ごとの結果。他のテナントの `connection_id`、登録にない `purpose`、トークンの署名の API での `purpose` の指定を拒否する。返したアサーションの `aud`・宛先が登録の値で、接続の鍵で署名されている（テナントの署名鍵ではない）。
- 結合テスト：遷移の後、`keys:invalidate` が届かないタスクも 2 秒以内に新しい `current` で署名する。
- 監視：JWKS の確かめの失敗、Signer の検査で拒否した要求の数。

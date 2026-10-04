---
status: accepted
date: 2026-09-27
---

# ADR-0001: 共通の基盤の上に、検証済みの部品で認可サーバーを自前で実装する

## Context

rebuilds の他の題材（Slack、Stripe など）で、次の基盤を決めている。

- AWS（東京、DR は大阪。ECS Fargate、Aurora PostgreSQL 18、ElastiCache Valkey、SQS、S3・CloudFront、KMS）
- TypeScript（Hono＋Zod）
- Terraform、OpenTelemetry、AWS AppConfig のフィーチャーフラグ、トランクベース開発

他の題材は、自分のアプリのログインに Better Auth を使った（Slack の ADR-0012、Stripe の ADR-0008）。Better Auth は、1 つのアプリが自分の利用者を認証するためのライブラリである。

この題材は、それ自体が IdP であり、多数のテナントのために OAuth 2.0・OpenID Connect の認可サーバーとして振る舞う。次の条件がある。

- 標準への厳密な準拠（OpenID Certification を目標にする）
- テナントごとの署名鍵と、その鍵を限られた境界の中に閉じ込めること（[ADR-0003](0003-token-formats-and-signing-keys.md)）
- 依存先が落ちても続く認証の経路（[ADR-0005](0005-authentication-path-availability.md)）
- 1 万（S1）〜100 万（S3）のテナントを、共有の基盤で動かすこと（[ADR-0002](0002-tenancy-and-isolation.md)）

## Options

1. **共通の基盤を引き継ぎ、認可サーバーを自前で実装する。** 暗号・JOSE・WebAuthn・パスワードのハッシュは検証済みのライブラリを使う
2. **既存の OSS の IdP を土台にする**
   - 2a. Keycloak（Java。realm をテナントにする）
   - 2b. Ory Hydra（認可サーバー、Go）＋ Ory Kratos（ユーザーの管理）
   - 2c. node-oidc-provider（TypeScript から使える認可サーバーのライブラリ）
3. **アプリ向けの認証ライブラリ（Better Auth と、その OIDC Provider の機能）を使う**

## Decision

1 を採用する。

### 実行基盤と技術

- 実行基盤・言語・IaC・可観測性・フラグは、他の題材と同じにする。題材をまたいで、エージェントと人が同じ道具で検証できる。
- 認証の経路（認可サーバーと Universal Login）、管理の経路（Management API とダッシュボード）、Signer、Worker を別の ECS のサービスにする（[ADR-0005](0005-authentication-path-availability.md)）。
- Universal Login の画面は、サーバーで HTML を組み立てて返す（Hono の JSX）。JavaScript は最小にする。速さと、CSP を厳しくするため。詳細は universal-login の領域で決める。

### 使う部品

| 用途 | 部品 | 理由 |
| --- | --- | --- |
| JWS・JWE・JWK | `jose`（panva） | 依存がなく、Node.js と Web Crypto の両方で動く。node-oidc-provider でも使われている |
| WebAuthn・パスキー | 保守されているサーバーのライブラリ（候補は `@simplewebauthn/server`） | 構成証明（attestation）と CBOR の解析を自前で書かない。選定は mfa-and-passkeys の領域で行う |
| パスワードのハッシュ | Argon2id のネイティブのバインディング（`argon2` か `@node-rs/argon2`）、取り込み用の bcrypt | [ADR-0004](0004-credential-storage.md) |
| TOTP | `node:crypto` の HMAC と、RFC 6238 の試験ベクトル | 仕様が小さい。ライブラリを使うかは実装の Story で決める |
| SAML（MVP の後） | 保守されているライブラリを、エンタープライズ接続の Epic で選ぶ | XML 署名を自前で書かない |

- **署名は Signer のサービスだけで行う。** 認可サーバーは秘密鍵を持たない（[ADR-0003](0003-token-formats-and-signing-keys.md)）。
- **node-oidc-provider を、参照の実装として使う。** 本番のコードには組み込まない。同じ要求を両方に送って応答を比べる差分テストの相手にする。

### 適合の確かめ方

- OpenID Foundation の適合試験（conformance suite）を CI で回す。対象は OP の Basic・Config・Form Post・RP-Initiated Logout・Back-Channel Logout のプロファイル（Form Post は [authentication-flows.md](../architecture/authentication-flows.md) の 14 節の決定で加えた）。GA の前に OpenID Certification を受ける。
- RFC 9700 の要件を、チェックリストとして security の領域の文書に写し、要件ごとにテストを持つ。

### 2・3 を選ばなかった理由

- **2a（Keycloak）**：機能は最も揃っている。ただし、Java で、他の題材の道具と揃わない。realm の数が数千を超えると管理の性能が落ちるという報告がある（未検証）。テナントの RLS、署名鍵の境界、縮退の振る舞いを、外から変えるのが難しい。
- **2b（Ory Hydra＋Kratos）**：Hydra は OpenID Certified である（[ory/hydra](https://github.com/ory/hydra)、2026-09-27 に確認）。ただし、Go で道具が揃わない。OSS のバージョンを多数のテナントで使う形は、公開の資料では確かめられなかった（未検証）。ログインの画面と同意の画面を別に作る前提で、2 つのシステムの状態を合わせる運用が要る。
- **2c（node-oidc-provider）**：TypeScript から使え、Basic・Config・RP-Initiated Logout・Back-Channel Logout・FAPI 2.0 などで OpenID Certified、MIT ライセンス、PAR・DPoP・デバイスフローにも対応する（[panva/node-oidc-provider](https://github.com/panva/node-oidc-provider)、2026-09-27 に確認）。最も近い候補だった。採らない理由は次のとおり（本システムの評価）。
  - 鍵を JWKS としてプロセスの中に持つ前提で、Signer に署名を任せる形に合わない。
  - テナントごとに Provider のインスタンスを持つ形になり、1 万のテナントでメモリーと設定の反映の扱いが重い。
  - 状態の保存（adapter）の単位が、RLS と縮退（[ADR-0005](0005-authentication-path-availability.md)）の設計と合わない。
  - 保守者が 1 人である（リポジトリの記載）。
  - このため、実装の手本と差分テストの相手として使う。
- **3（Better Auth）**：1 つのアプリの利用者を認証するためのもので、多数のテナントの認可サーバーとしての設計ではない。Better Auth は、OpenID Foundation の認証済みの実装の一覧にない（[Certified OpenID Connect Implementations](https://openid.net/developers/certified-openid-connect-implementations/)、2026-09-27 に確認）。

## Consequences

- 良くなること：
  - 認証の経路の性能・縮退・鍵の境界を、自分で決められる。
  - 他の題材と同じ道具・CI・運用を使える。
- 引き受けるコスト：
  - 認可サーバーの実装の誤りが、そのまま脆弱性になる。適合試験、否定側のテスト、外部のペンテスト（E12）、`security:sensitive` のレビュー（[AGENTS.md](../../AGENTS.md)）で抑える。
  - Node.js で、署名とパスワードのハッシュは CPU を使う。Signer と、ハッシュの worker threads の数を、E12 の負荷試験で決める。
  - ダッシュボードの管理者のログインには、このシステム自身の管理用のテナントを使う（自分で自分を使う）。このテナントが落ちても入れる非常用の経路（break-glass）が要る。dashboard の領域で扱う。

## Confirmation

- CI：適合試験の対象のプロファイルがすべて通ることを、認証の経路のパッケージを変える PR の必須のチェックにする。
- lint：`jsonwebtoken` など、`jose` 以外の JWT のライブラリの import を禁止する。Signer のパッケージの外での `node:crypto` の `sign`・`createPrivateKey` を禁止する。
- 差分テスト：主要なフロー（認可コード＋PKCE、リフレッシュ、クライアントクレデンシャル、ログアウト）で、node-oidc-provider との応答の違いがすべて説明されている。

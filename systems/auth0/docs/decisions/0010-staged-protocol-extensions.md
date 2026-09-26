---
status: accepted
date: 2026-09-27
---

# ADR-0010: PAR・DPoP・トークン交換・mTLS は、MVP の後に、認可コードの経路の上にフラグで足す

詳細は [authentication-flows.md](../architecture/authentication-flows.md) の 10 節。

## Context

金融などの高保証の用途では、PAR（RFC 9126）と送信者の制約（DPoP、RFC 9449。mTLS、RFC 8705）が求められる。FAPI 2.0 の Security Profile はこれらを前提にする。トークン交換（RFC 8693）は、サービスの間の委任や AI エージェントの認可に使われ始めている。[intent.md](../intent.md) は、これらを MVP の後の Epic に置いた。

本家 Auth0（2026-09-27 に確認）：

- PAR は Enterprise のプランの追加の契約で使え、アプリごとに必須にできる（[Configure PAR](https://auth0.com/docs/get-started/applications/configure-par)）。
- DPoP は ES256 の鍵で使い、公開のクライアントには `nonce` を求める。API ごとに送信者の制約を必須にできる（[Demonstrating Proof-of-Possession](https://auth0.com/docs/secure/sender-constraining/demonstrating-proof-of-possession-dpop)、[Configure Resource Server for Sender Constraining](https://auth0.com/docs/secure/sender-constraining/configure-sender-constraining/configure-resource-server-for-sender-constraining)）。
- discovery にトークン交換のグラントが載っている（`samples.auth0.com`）。

後から足すときに、MVP の検証の経路を書き換えると、適合試験と否定側のテストをやり直すことになる。

## Options

1. **MVP の経路（`/authorize` の検証の部品、コードの消費、クライアントの認証、`jti` の置き場所）を、拡張が差し込める形で作り、拡張はアプリ・API ごとのフラグで有効にする**
2. MVP から PAR と DPoP を入れる
3. 拡張の時に、経路を作り直す

## Decision

1 を採用する。

- PAR：`/oauth/par` は、クライアントを認証してから `/authorize` と同じ検証の部品を通し、`pushed_authorization_requests` に保存して `request_uri`（有効 60 秒、1 回限り）を返す。`/authorize` は `request_uri` から要求を読む。アプリごとに `require_pushed_authorization_requests`。
- DPoP：証明の検証（`typ`、`jti`、`htm`、`htu`、`iat`、`ath`、`nonce`）を 1 つの部品にし、トークンのエンドポイントと userinfo で使う。`jti` は `private_key_jwt` と同じ置き場所（Valkey、使えないとき Aurora）。アクセストークンに `cnf.jkt`、公開のクライアントのリフレッシュトークンの系列に鍵の指紋を持たせる。API ごとに必須にできる。アルゴリズムは ES256 と PS256。
- トークン交換：テナントが許した組（受け取るトークンの種類 × 出す API × 許すアプリ）だけを通す。委任は `act` クレーム。形は需要を見て、別の ADR で詳細を決める。
- mTLS：TLS の終端とクライアントの証明書の受け渡し（custom-domains.md、infrastructure.md）を決めてから。
- 有効にするフラグは AppConfig の release フラグと、アプリ・API の属性の 2 段にする。
- MVP の `refresh_token_families` に、鍵の指紋の列（`dpop_jkt`、空を許す）を初めから置く。
- 2 は、MVP の範囲と適合試験の対象が増え、E3・E5 が遅れる。3 は、否定側のテストをやり直すことになる。

## Consequences

- 良くなること：
  - 高保証の要求に、MVP の設計を崩さずに応えられる。
  - 拡張を使わないテナントの振る舞いは変わらない。
- 引き受けるコスト：
  - MVP の段階で、使わない列と差し込みの口を持つ。

## Confirmation

- 拡張を入れる各 Story で、MVP の適合試験のプロファイルが変わらず通ること。
- FAPI 2.0 の Security Profile の適合試験を、PAR と DPoP を入れた後の CI に足す。
- 否定のテスト：期限切れ・使用済みの `request_uri`、他のアプリの `request_uri`、`htu` の違う DPoP の証明、同じ `jti` の 2 回目、`cnf.jkt` と違う鍵の証明。

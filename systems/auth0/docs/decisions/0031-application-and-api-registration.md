---
status: accepted
date: 2026-09-27
---

# ADR-0031: アプリの種類でクライアントの認証とグラントの上限を決め、コールバックはワイルドカードなしにし、M2M はアプリ × API の許可で守る

詳細は [tenants-and-applications.md](../architecture/tenants-and-applications.md) の 4〜6 節。

## Context

アプリの登録の設定は、認可サーバーの攻撃面そのものである。誤ったグラント、広すぎるコールバック、広すぎる M2M の許可は、そのままトークンの盗用や権限の昇格につながる。

本家の振る舞い（2026-09-27 に確認）：

- Native・SPA は公開、Regular Web・M2M は機密。機密のアプリの既定のグラントは `implicit`・`authorization_code`・`refresh_token`・`client_credentials`（[Application Grant Types](https://auth0.com/docs/get-started/applications/application-grant-types)）。
- コールバックにサブドメインのワイルドカードを許すが、本番では勧めない。サードパーティのアプリでは使えない（[Subdomain URL Placeholders](https://auth0.com/docs/get-started/applications/wildcards-for-subdomains)）。
- M2M のトークンは、アプリ × API の client grant とスコープで許す（Management API の OpenAPI の `POST /client-grants`）。

[ADR-0006](0006-authorization-code-pkce-and-exact-redirect.md) で `redirect_uri` の完全一致、[ADR-0007](0007-client-authentication-methods.md) でクライアントの認証の方式を決めた。

## Options

1. **種類（`spa`・`native`・`regular_web`・`m2m`）で認証の方式と許すグラントの上限を固定し、既定では使うグラントだけを有効にする。コールバックはワイルドカードなし。M2M はアプリ × API の許可**
2. 本家と同じく、種類は目安にし、グラントとワイルドカードを自由に設定させる
3. 種類を持たず、グラントと認証の方式を直接設定させる

## Decision

1 を採用する。

- 種類ごとの上限は [tenants-and-applications.md](../architecture/tenants-and-applications.md) の 4.1 節の表のとおり。`implicit`、`password`、本家の拡張と旧来のグラントは持たない。
- 種類は作成後に変えない。
- コールバック・ログアウト・Web オリジン・CORS のオリジンは各 100 件まで。ワイルドカードは受け付けない。`{organization_name}` の置き換えだけを E14 で足す。
- 秘密は 2 つ、公開鍵は 2 つまで同時に有効（ADR-0007）。秘密は `<brand>_cs_` の接頭辞とチェックサムを持ち、1 回だけ表示する（[ADR-0004](0004-credential-storage.md)）。
- `client_credentials` は、`(client_id, audience)` の client grant があるときだけ通す。要求のスコープは許可のスコープに切り詰める。API から消したスコープは、許可からも自動で外す。
- API の識別子は変えない。Management API はテナントの作成時に作る、消せない API として持つ。
- 2 は、完全一致の照合（ADR-0006）と矛盾し、使わないグラントが既定で開いたままになる。
- 3 は、公開のアプリに秘密を登録するなど、矛盾した組み合わせを作れてしまう。

## Consequences

- 良くなること：
  - 登録の時点で、RFC 9700 が勧めない組み合わせを作れない。
  - M2M の権限が、アプリ × API × スコープの表で監査できる。
- 引き受けるコスト：
  - 本家からの移行で、ワイルドカードのコールバックと `implicit` を使うアプリは、書き換えが要る。移行の文書で案内する。
  - 種類の変更ができず、作り直しになる。

## Confirmation

- 表駆動テスト：種類 × グラント × 認証の方式の登録の可否。
- 表駆動テスト：URL の規則（ワイルドカード、非ループバックの `http`、フラグメント、カスタムスキーム）。
- 性質ベーステスト：任意の許可と要求のスコープについて、発行したトークンの `scope` は、許可と要求の積集合を超えない。
- 結合テスト：API からスコープを消すと、そのスコープを含む許可から外れ、監査に残る。

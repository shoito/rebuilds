---
status: accepted
date: 2026-09-27
---

# ADR-0006: 認可の要求は認可コード＋PKCE（S256）だけにし、`redirect_uri` は完全一致で照合する

詳細は [authentication-flows.md](../architecture/authentication-flows.md) の 5 節。

## Context

認可のエンドポイントの誤りは、そのままトークンの盗用になる（[architecture/README.md](../architecture/README.md) の 6 節）。RFC 9700（OAuth 2.0 のセキュリティの BCP）と OAuth 2.1 の草案は、次を求めている。

- `redirect_uri` は、登録した値と文字列として完全に一致させる。ネイティブアプリのループバックの IP のポートだけは例外（RFC 9700 の 2.1 節・4.1.3 節、RFC 8252 の 7.3 節）。
- 公開のクライアントは PKCE を使う（MUST）。機密のクライアントにも勧める。`S256` を使う（RFC 9700 の 2.1.1 節）。
- 暗黙フローとパスワードのグラントを使わない（RFC 9700 の 2.1.2 節・2.4 節）。
- mix-up 攻撃への備えとして、認可の応答に `iss` を付ける（RFC 9207）。

本家 Auth0 は、暗黙フロー・ハイブリッド、`plain` の PKCE を出している。コールバックの URL にはサブドメインのワイルドカードを許す（[Log Users Out of Auth0](https://auth0.com/docs/authenticate/login/logout/log-users-out-of-auth0) のログアウトの URL の記述と、本家の `samples.auth0.com` の discovery。2026-09-27 に確認）。

## Options

1. **`response_type=code` だけ。PKCE は `S256` だけで、既定で全クライアントに必須（機密のクライアントは外せる）。`redirect_uri` は完全一致、ワイルドカードなし。応答に `iss`**
2. 本家と同じ（暗黙・ハイブリッド、`plain`、ワイルドカードを許す）
3. 1 に加え、機密のクライアントも PKCE を外せないようにする

## Decision

1 を採用する。

- `response_type` は `code` だけ。`response_mode` は `query` と `form_post`。
- `code_challenge_method` は `S256` だけ。`plain` と省略は拒否する。
- `require_pkce` はアプリの属性で、既定は真。偽にできるのは機密のアプリだけで、そのときは `state` と（OIDC の要求では）`nonce` を必須にする。
- `code_challenge` のないコードに `code_verifier` が来たら拒否する（ダウングレードの防御）。
- `redirect_uri` は必須。登録の値と完全に一致させる。正規化しない。Native のアプリのループバックの IP（`127.0.0.1`、`[::1]`）だけ、ポートを無視する。
- 照合できない `redirect_uri`・`client_id` には何も送らず、本システムのエラーの画面を出す。
- 認可の応答（成功・エラー）に `iss` を付け、discovery に `authorization_response_iss_parameter_supported: true` を載せる。
- 3 は、PKCE を使わない既存のサーバー側のライブラリと、適合試験のクライアント（OIDC の OP の試験は PKCE を送らない。スイートの `AbstractOIDCCServerTest` に PKCE の処理がない。2026-09-27 に master で確認）を締め出す恐れがある。外した場合の警告と監査ログで補う。
- 2 は、RFC 9700 が勧めない選択肢を残す。

## Consequences

- 良くなること：
  - コードの注入・漏えい、オープンリダイレクト、mix-up の主な経路を、既定の設定で塞げる。
  - 検証の分岐が減り、否定側のテストを書き切れる。
- 引き受けるコスト：
  - 本家から移るテナントのうち、暗黙フロー・ワイルドカード・`plain` を使うものは、アプリの変更が要る。移行の文書に書く。
  - プレビュー環境などの動的な URL は、1 つずつ登録する必要がある（1 アプリ 100 件まで）。

## Confirmation

- 表駆動テスト：[authentication-flows.md](../architecture/authentication-flows.md) の 5.2 節・5.3 節の各行。
- 性質ベーステスト：任意の文字列の `redirect_uri` が、登録と完全一致（とループバックの規則）のときだけ通る。
- 適合試験：OIDC Basic・Config・Form Post の OP のプロファイルが通る。
- lint：`response_type` の値の許可リストを 1 か所に置き、他の場所で `token`・`id_token` を扱うコードを禁止する。

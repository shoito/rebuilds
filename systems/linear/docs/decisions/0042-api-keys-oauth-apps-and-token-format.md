---
status: accepted
date: 2026-09-28
---

# ADR-0042: API キーは 1 人の利用者に結び、範囲とチームで絞り、期限を 1 年までにする。OAuth のアプリは PKCE（S256）を必須にし、アクセストークン 24 時間、リフレッシュトークンは入れ替えと再利用の検出。トークンは `<brand>_` の接頭辞とチェックサムの形で、ハッシュだけを保存する

## Context

公開 API の主体は、API キーと OAuth のアプリである（[ADR-0004](0004-tenancy-and-permissions.md)：発行した人の権限を超えない）。`Principal` の型はすでに `kind: "api_key" | "oauth_app"` と `scopes` を持つ（[permissions-and-teams.md](../architecture/permissions-and-teams.md) の 4.1 節）。

本家の OAuth は、範囲 `read`・`write`・`issues:create`・`comments:create`・`admin` など、アクセストークン 24 時間とリフレッシュトークン、PKCE、取り消し、`actor=app`、client credentials を持つ（[OAuth 2.0 authentication](https://linear.app/developers/oauth-2-0-authentication)、2026-09-28 に確認）。本家の API キーは、範囲（Read・Write・Admin・Create issues・Create comments）と特定のチームに絞れる（[API and Webhooks](https://linear.app/docs/api-and-webhooks)、2026-09-28 に確認）。期限は公式の文書で確かめられなかった（未検証）。

トークンの接頭辞には、本家の名前を使わない（[リポジトリ共通の ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。

## Options

API キーの期限：

1. **必須で 1 年まで**
2. 任意（期限なしを許す）

OAuth の実装：

- a. **Public API の中に小さく自前で持つ（認可コード＋PKCE、リフレッシュ、取り消し）**
- b. 認証の部品（Better Auth）の OAuth の提供者の機能を使う

リフレッシュトークン：

- x. **使うたびに入れ替え、古いものの再利用で一式を取り消す**
- y. 入れ替えない

## Decision

1・a・x を採用する。詳細は [api-and-webhooks.md](../architecture/api-and-webhooks.md) の 3.5・6 節。

- 形：`<brand>_api_`・`<brand>_oat_`・`<brand>_ort_`・`<brand>_ocs_` ＋ base62 の乱数 32 文字 ＋ CRC32 の base62 のチェックサム 6 文字。SHA-256 だけを保存し、照合は等しさで行う。シークレットスキャンに独自の形として登録し、通報の口で取り消す。
- 権限：`can(user, action, target) ∧ 範囲 ∧ チームの絞り`。`admin` の範囲は `owner`・`admin` だけが出せる。
- API キー：ワークスペースの 1 人の `User` に結ぶ。作れる人はワークスペースの設定（既定は全員）。期限は既定・最大 1 年、7 日前に知らせる。持ち主の停止で効かず、除外で消える。
- OAuth のアプリ：ワークスペースに属し、管理者が登録する。戻りの URL は完全一致。`code_challenge`（S256）と `state` を必須。コード 60 秒・1 回限り、アクセストークン 24 時間、リフレッシュトークン 90 日（使わなければ）。取り消しは RFC 7009。
- セッションのクッキーでは公開 API を使えない。
- `actor=app` と client credentials は MVP の後。
- 2 を採らない理由：辞めた人の手元や CI の設定に、期限のないキーが残り続ける。
- b を採らない理由：トークンをワークスペースの `User` に結び、上の形と保存にするには、部品の外で多くを足す必要がある（部品は PKCE とリフレッシュトークンの入れ替えを持つ。[OAuth 2.1 Provider](https://better-auth.com/docs/plugins/oauth-provider)、2026-09-28 に確認）。認可の流れは小さく、自前で持つ費用が低い。
- y を採らない理由：盗まれたリフレッシュトークンが 90 日使える。

## Consequences

- 良くなること：
  - 漏れたトークンをシークレットスキャンで見つけられる。DB が漏れてもトークンは使えない。
  - API キーの権限が持ち主の権限と範囲とチームの積に収まる。
- 引き受けるコスト：
  - 利用者は年に 1 回キーを作り直す。
  - OAuth のサーバーの実装とセキュリティの試験を自前で持つ。

## Confirmation

- 表駆動テスト：DT-API-001（範囲の表）。
- 結合テスト：PKCE なし・誤った `code_verifier`・戻りの URL の不一致・コードの再利用・リフレッシュトークンの再利用の拒否と一式の取り消し。
- E12 の外部のペンテストに OAuth の流れを入れる。

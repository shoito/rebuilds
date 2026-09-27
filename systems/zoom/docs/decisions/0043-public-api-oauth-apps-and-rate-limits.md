---
status: accepted
date: 2026-09-27
---

# ADR-0043: 公開 API は別のサービスにし、アプリは OAuth（PKCE 必須）とサーバー間の 2 種類、レート制限は重さで分けた 4 つの分類にする

## Context

組織の社内のシステムと他社の製品が、会議の予定、参加者のレポート、録画の取得を自動にするために、公開 API を使う（E12。2026-09-27 の注記：Epic の番号を E11 に改めた）。

本家の形（いずれも 2026-09-27 に確認）：

- 操作を Light・Medium・Heavy・Resource-intensive に分け、プランごとに毎秒と 1 日の上限を持つ。会議の作成と更新は、利用者ごとに 1 日 100 回。超えたら `429`（[Rate limits](https://developers.zoom.us/docs/api/rate-limits/)）。
- アプリは Server-to-Server OAuth（アクセストークン 1 時間）と利用者の OAuth。共有の秘密で署名する JWT のアプリは 2023 年に止めた（[JWT App type deprecation](https://developers.zoom.us/changelog/platform/jwt-app-type-deprecation/)）。

rebuilds の他の題材は、公開 API を内部の API と別の面にし、同じサービス関数と判定関数を通す（Slack の [ADR-0030](../../../slack/docs/decisions/0030-versioned-public-api.md)）。レート制限のヘッダーは IETF の草案の書式を使う（Slack の [rate-limiting.md](../../../slack/docs/architecture/rate-limiting.md)）。OAuth の安全の確認は、Auth0 の題材の RFC 9700 の確認の表がある（[ADR-0053](../../../auth0/docs/decisions/0053-rfc9700-checklist-and-negative-tests.md)）。

公開 API から作った会議も、待合室かパスコードの不変条件（[ADR-0031](0031-waiting-room-and-passcode-rules.md)）と、設定の解決（[ADR-0039](0039-settings-hierarchy-and-locks.md)）に従わなければならない。

## Options

アプリ：

1. **OAuth のアプリ（認可コード＋PKCE 必須）と、組織の管理者が作るサーバー間のアプリ（クライアントクレデンシャル）**
2. **1 に加えて、個人のアクセストークン（利用者が画面で作る長期のトークン）**
3. **API キー（共有の秘密）だけ**

レート制限：

4. **重さで 4 つの分類に分け、(アプリ, 組織) ごとのトークンバケット。会議の作成・更新は利用者ごとに 1 日の上限**
5. **すべての操作に同じ上限**

## Decision

1 と 4 を採用する。詳細は [api-and-webhooks.md](../architecture/api-and-webhooks.md) の 3〜6 節。

- 公開 API は `api.<brand>.<domain>/v1` の別のサービス（ECS）。Cookie と CORS を受けない。同じサービス関数と `authorize`・`resolveSettings`・`assertJoinGuard` を通る。
- OAuth のアプリ：認可コード＋PKCE（S256）必須、`redirect_uri` の完全一致。組織の全体に効くスコープは、組織の `admin` の承認まで発行しない。
- サーバー間のアプリ：組織の `admin` が作る。`client_secret_basic` か `private_key_jwt`。
- トークンは不透明（`<brand>_at_`・`<brand>_rt_`・`<brand>_cs_` ＋乱数＋CRC32）。アクセストークン 1 時間、リフレッシュトークン 90 日で使うたびに入れ替え、再使用で系列ごと失効。DB にはハッシュだけ。
- 認可サーバーは `identity` のモジュールの中に置き、Auth0 の題材の RFC 9700 の確認の表を写して否定の試験を回す。
- レート制限：light 30/秒、medium 20/秒、heavy 10/秒、resource-intensive 10/分を (アプリ, 組織) ごとに。heavy と resource-intensive の合計で組織ごとに 1 日 60,000。会議の作成・更新は利用者ごとに 1 日 100 回（UTC の 0 時に戻す）。
- 応答に `RateLimit-Policy`・`RateLimit`（draft-11 の書式）と `X-<Brand>-RateLimit-Category`、超えたら `429`・`Retry-After`・RFC 9457 の本文。
- 会議の中の操作（ミュートなど）は出さない。会議を終える操作だけを、Actor への命令として出す。
- 2 を今は採らない理由：長期のトークンが個人の端末やスクリプトに残り、漏れたときの影響が長い。サーバー間のアプリで組織の自動化は足りる。要望があれば、期限必須で後から足す。
- 3 を採らない理由：利用者の同意とスコープを表せない。取り消しと入れ替えの仕組みがない。
- 5 を採らない理由：録画の URL の発行やレポートのような重い操作と、軽い読み取りを同じに扱うと、重い操作で基盤が詰まるか、軽い操作が不必要に絞られる。

## Consequences

- 良くなること：
  - 公開 API の急増が、参加の API と会議に響かない。
  - 公開 API から作った会議も、画面から作った会議と同じ規則に従う。
  - 本家に慣れた開発者に、分類とアプリの種類がなじむ。
- 引き受けるコスト：
  - 認可サーバーを自分たちで持ち、OAuth の安全の確認を続ける必要がある。
  - 料金のプランがない S1 では、上限を組織ごとに上げる仕組みがない（持ち越し）。
  - 本家の SDK は使えない（リポジトリ共通の ADR-0006）。公式の SDK を用意する。

## Confirmation

- 性質ベーステスト：公開 API の経路で待合室もパスコードもない会議ができない（PROP-API-001）。公開 API の結果が `authorize` とスコープの積と一致する（PROP-API-002）。
- 否定の試験：RFC 9700 の確認の表（PKCE なし、`redirect_uri` の不一致、リフレッシュトークンの再使用）がすべて拒否される。
- 契約の試験：OpenAPI の定義と実装に差分がない。版の中で項目を消していない。
- 負荷試験：公開 API に上限まで負荷をかけても、`POST /join` の p95 が変わらない。

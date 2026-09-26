---
status: accepted
date: 2026-09-26
---

# ADR-0028: ダッシュボードは公開 API を呼ぶ SPA にし、第三者のスクリプトを読み込まない

## Context

加盟店のダッシュボードは、返金・Dispute の提出・入金先の変更・API キーの発行など、お金と秘密を動かす操作を持つ。決めることは 3 つある。

- **サーバーとの境界**：ダッシュボード専用の API を作るか、公開 API を使うか。本家は、ダッシュボードでの変更も API の要求としてログに残し、ソース（API / ダッシュボード）で区別できる（[API リクエストログ](https://docs.stripe.com/development/dashboard/request-logs)、2026-09-26 に確認）。
- **クライアントの作り**：Slack の Web クライアント（[client.md](../../../slack/docs/architecture/client.md)、Slack の ADR-0024）は、React・TanStack Router・TanStack Query に、SharedWorker・IndexedDB の同期エンジンを重ねた。ダッシュボードには、リアルタイムの会話やオフラインの要件がない。
- **利用状況の計測**：Slack は GA4 を、条件を絞って使う（Slack の ADR-0025）。ダッシュボードで同じにするか。

## Options

境界：

1. **公開 API を使い、公開 API にないものだけダッシュボード専用の API に置く**
2. **ダッシュボード専用の BFF を作り、ドメイン層を直接呼ぶ**

計測：

A. **GA4（Slack の ADR-0025 と同じ条件）**
B. **自前の計測（型付きのイベントを自前の API へ送り、S3 と Athena で集計する）**

## Decision

1 と B を採用する。クライアントは React・TanStack Router・TanStack Query の SPA にし、Slack の同期エンジンは持ち込まない。

- **境界**：ダッシュボードの API は `/api/accounts/{acct}/{live|test}/*`（[auth-and-keys.md](../architecture/auth-and-keys.md) の 1 節）で、セッションと必須の MFA で認証する（[ADR-0008](0008-api-keys-and-dashboard-access.md)）。そのうち、決済・返金・Dispute・Payout・顧客・Webhook のエンドポイントなど公開 API にある操作は、`.../v1/...` として公開 API と同じハンドラーに渡す。認証の段だけがキーの代わりにセッションになり、検証・冪等・版の変換・監査は共有する。API の版はダッシュボードのビルドが固定する。公開 API にないもの（チーム、ログの検索、レポート、ホームの集計）は、同じ接頭辞の下の、公開の契約にしないハンドラーに置く。要求はリクエストのログに「ソース：ダッシュボード」と操作した人の ID で残す。
  - 2 は、画面に合わせた応答を作りやすい。ただし、検証・冪等・版・監査の経路が 2 つになり、ダッシュボードだけの抜け道が生まれうる。公開 API の不足にも気づきにくい。
- **クライアント**：型付きのクライアントは、公開 API の OpenAPI から生成した `packages/api-client` を使う（Slack は Hono RPC だが、本システムの公開 API は OpenAPI が契約）。一覧はフォーカスの復帰と 60 秒ごとの取り直しで新しくし、WebSocket を使わない。
- **計測**：第三者のスクリプトを読み込まない。`packages/analytics` の型付きのイベント（Slack の ADR-0025 の許可リストの考え方を引き継ぐ）を自前の API へ送り、S3 と Athena で集計する。
  - A は、PM がすぐに使える点で勝る。ただし、返金や入金先の変更ができる画面に第三者のスクリプトを入れると、その配信の侵害が XSS と同じ影響を持つ。決済の画面（ADR-0027）と方針をそろえる。

## Consequences

- 良くなること：
  - ダッシュボードの操作は、公開 API と同じ検証・冪等・監査を必ず通る。加盟店は、ダッシュボードでの操作もリクエストのログで追える。
  - ダッシュボードを作ることで、公開 API の不足が早く見つかる。
  - CSP を `script-src 'self'` に保てる。
- 引き受けるコスト：
  - 一覧・集計の画面は、公開 API の形に縛られる。足りないものは `/dashboard/...` の API に足す。
  - 計測の集計と画面（Athena のクエリ、ダッシュボード）を自分で作る。PM が GA の画面を使えない。
  - Slack のクライアントの同期エンジンの資産は使わない（TanStack Query・デザインシステム・i18n・a11y の方針は使う）。

## Confirmation

- 結合テスト：ダッシュボードからの返金が、公開 API のハンドラーを通り、冪等キー・監査ログ・リクエストのログ（ソース：ダッシュボード）に残る。
- lint：ダッシュボードのコードから、ドメイン層・DB のパッケージを import しない。`packages/analytics` の外から計測の送信を呼ばない。
- CI：ビルドの成果物の HTML と CSP のヘッダーに、`self` 以外のスクリプトの読み込み先がない。

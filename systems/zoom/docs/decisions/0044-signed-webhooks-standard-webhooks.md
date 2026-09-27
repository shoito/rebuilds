---
status: accepted
date: 2026-09-27
---

# ADR-0044: Webhook は Standard Webhooks の形で署名し、URL を確かめてから送り、会議の内容を載せずに少なくとも 1 回届ける

## Context

組織のシステムは、会議の終了、参加者の出入り、録画の完成を知りたい（E12。2026-09-27 の注記：Epic の番号を E11 に改めた）。

本家の形（[Webhooks](https://developers.zoom.us/docs/api/webhooks/)、2026-09-27 に確認）：

- 署名は `x-zm-signature`・`x-zm-request-timestamp` で、`v0:{timestamp}:{body}` の HMAC-SHA256 を 16 進にし `v0=` を前に付ける。
- 登録の URL を、`endpoint.url_validation` のイベントの `plainToken` を秘密で HMAC した `encryptedToken` を 3 秒以内に返させて確かめる。
- 再送は 5 分後・その 20 分後・その 60 分後の 3 回。応答は 3 秒以内。

ヘッダーの名前は本家のものを使えない（リポジトリ共通の [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。Slack の題材は、Standard Webhooks の仕様の形（`webhook-id`・`webhook-timestamp`・`webhook-signature`、`v1,` ＋ `{id}.{timestamp}.{body}` の HMAC-SHA256 の base64、秘密は `whsec_`）に合わせている（Slack の [apps.md](../../../slack/docs/architecture/apps.md) の 8 節）。多くの言語に検証の実装がある。

会議の内容（チャット、字幕、録画）は通信の秘密に当たる（intent.md の L2）。受け手の URL は組織が決めるので、本システムから私的な網へ要求を出させる攻撃（SSRF）の経路になりうる。

## Options

1. **Standard Webhooks の形で署名し、本家と同じ考え方の URL の確認を加える。中身は ID とメタデータだけ。outbox から少なくとも 1 回、7 回まで再送**
2. **本家と同じ形の署名（`v0:` の 16 進）を、独自の名前のヘッダーで送る**
3. **中身に会議の内容（チャット、文字起こし、録画の URL）も載せる**

## Decision

1 を採用する。詳細は [api-and-webhooks.md](../architecture/api-and-webhooks.md) の 7 節。

- **署名**：`webhook-id`・`webhook-timestamp`・`webhook-signature`（`v1,` ＋ base64 の HMAC-SHA256）。秘密は `whsec_` ＋ 32 バイト。入れ替えの 24 時間は 2 つの署名を付ける。
- **URL の確認**：登録のときと 72 時間ごとに `endpoint.url_validation` を送り、`plain_token` の HMAC を 3 秒以内に返させる。通るまでイベントを送らない。
- **SSRF**：`https` だけ。登録のときと送るたびに名前を引き、私的な IP を拒否する。egress proxy を通してだけ送り、リダイレクトを追わない。
- **配送**：業務の変更と同じトランザクションで outbox に書き、SQS から Worker が送る。少なくとも 1 回、順序は保証しない。接続 2 秒・応答 5 秒。`5xx`・`429`・時間切れで、1 分・5 分・30 分・2 時間・6 時間・12 時間・24 時間の 7 回（約 1.9 日）。3 日続けて全配送が失敗したら受け口を止め、持ち主に知らせる。7 日以内の失敗は送り直せる。
- **中身**：ID とメタデータだけ。チャットの本文、字幕と文字起こしの文字、録画の URL、パスコード、参加の鍵、IP、電話番号を載せない。受け手は API で取りに行く。イベントを受けるには、その資源を読むスコープが要る。
- 2 を採らない理由：検証の実装を受け手がそれぞれ書く必要がある。Standard Webhooks の形なら既存の実装が使え、rebuilds の他の題材とも揃う。
- 3 を採らない理由：スコープの検査を通らずに、会議の内容が組織の外の受け口へ流れる。受け口の設定の誤りが、そのまま内容の漏えいになる。

## Consequences

- 良くなること：
  - 受け手は既存の Standard Webhooks の検証の実装を使える。
  - 会議の内容は、API のスコープの検査を通ったときだけ外に出る。
  - 受け手の長い障害にも、約 1.9 日の再送と、7 日以内の送り直しで耐える。
- 引き受けるコスト：
  - 受け手は、イベントを受けてから API を呼ぶ往復が要る（録画の取得など）。
  - 本家の署名の形に合わせたコードは、そのままでは使えない。
  - 順序を保証しないので、受け手は `occurred_at` と `version` で順を決める必要がある。
  - egress proxy と、送り先の名前の解決の検査を運用する。

## Confirmation

- 性質ベーステスト：署名の生成と SDK の検証が往復で一致し、本文を変えると失敗する（PROP-API-003）。成功の後に再送されず、`webhook-id` が再送で変わらない（PROP-API-004）。
- 攻撃の試験：私的な IP に向く URL（DNS の付け替え、リダイレクトを含む）が、登録でも配送でも拒否される。
- 試験：全イベントの本文に、チャットの本文、字幕、パスコード、参加の鍵、URL が現れない。
- 障害の注入：egress proxy を止めても、イベントが失われず、戻った後に届く。

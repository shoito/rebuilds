---
status: accepted
date: 2026-10-10
---

# ADR-0061: Webhook は少なくとも 1 回の配信で、順序を保証しない。本文は資源の JSON で、資源ごとに単調に増える `<brand>_version` を持つ。ヘッダーに話題、ショップ、配信の ID（購読 × 事象で一意、送り直しで同じ）、事象の ID、発生の時刻、API のバージョン、`X-<Brand>-Hmac-Sha256`（アプリの Webhook の署名の秘密で、生の本文の HMAC-SHA256 を base64）を付ける。接続 1 秒・全体 5 秒で切り、2xx を成功とする。失敗は 4 時間の中で 8 回まで送り直し、48 時間続けて全部の配信が失敗した購読は `disabled` にする（消さない）

## Context

- NFR-010：事象から最初の配信まで p95 10 秒、少なくとも 1 回、失敗は 4 時間に 8 回まで送り直す。
- 本家は、生の本文と client secret の HMAC-SHA256 を base64 でヘッダーに入れ、接続 1 秒・全体 5 秒で切り、200 以外を失敗とする。配信の ID と事象の ID を持つ（[Deliver webhooks through HTTPS](https://shopify.dev/docs/apps/build/webhooks/subscribe/https)、2026-10-10 に確認）。順序を保証せず、4 時間に 8 回送り直し、失敗が続くと Admin API で作った購読を消す（[Webhooks](https://shopify.dev/docs/apps/build/webhooks)、[Troubleshoot webhooks](https://shopify.dev/docs/apps/build/webhooks/troubleshooting-webhooks)、同日）。送り直しの間隔は確かめられなかった（未検証）。
- 受け手（アプリ）は、在庫と注文を同期する。順序の入れ替えで古い状態に戻る事故が起きる。

## Options

順序：

1. **順序を保証せず、資源ごとの単調なバージョンを本文に入れる**
2. 資源ごとに順に送る（前の配信が成功するまで次を待つ）

失敗が続く購読：

- a. **止める（`disabled`）。消さない。開発者が再開する**
- b. 消す（本家と同じ）
- c. 止めずに送り続ける

署名の鍵：

- x. **アプリの Webhook の専用の秘密（client secret と分ける）**
- y. client secret

## Decision

1、a、x を採用する。詳細は [webhooks.md](../architecture/webhooks.md) の 5・6 節。

- ヘッダー：`X-<Brand>-Topic`、`X-<Brand>-Shop-Domain`、`X-<Brand>-Api-Version`、`X-<Brand>-Webhook-Id`、`X-<Brand>-Event-Id`、`X-<Brand>-Triggered-At`、`X-<Brand>-Attempt`、`X-<Brand>-Hmac-Sha256`、入れ替えの 24 時間だけ `X-<Brand>-Hmac-Sha256-Previous`。
- 本文は事象の時点の資源の写し、スコープと保護のデータで項目を除く。256 KiB を超えたら薄い本文（`<brand>_truncated: true`）。
- 成功は 2xx。3xx・他の状態・時間切れ・TLS の誤りは失敗。
- 送り直しの間隔：1・4・10・20・30・45・60・70 分（±10%、累計 4 時間以内）。`Retry-After` は 4 時間の中で従う。
- 48 時間続けて成功がなく、`failed` が 10 件以上の購読は `disabled`。開発者と事業者に知らせる。再開で `active`（止まった間の事象は照合の一覧で取る）。
- 事象の一覧（`events`、7 日）を Admin API で出す。

### 他の案を選ばなかった理由

- **2（順に）**：1 つの配信の失敗が、同じ資源の後の配信を 4 時間止める。受け手がバージョンの比べをすれば順序は要らない。
- **b（消す）**：宣言の購読との整合が崩れ、受け口を直した開発者が全ショップの購読を作り直す必要がある。本家と違う振る舞いとして [architecture/README.md](../architecture/README.md) の 1.4 節に足す（統合の工程）。
- **c（送り続ける）**：落ちた受け口へ送り続け、送りの容量を使う。
- **y（client secret）**：秘密の入れ替えが OAuth の秘密の入れ替えと結び付き、片方だけを替えられない。

## Consequences

- 良くなること：受け手は配信の ID で重複を、`<brand>_version` で順序を扱える。止まった購読を開発者が直して戻せる。
- 引き受けるコスト：受け手に、生の本文での署名の確かめ、重複の除き、バージョンの比べを求める（開発者の文書と試験のベクトルを用意する）。

## Confirmation

- 性質ベーステスト PROP-HOOK-001（少なくとも 1 回）、PROP-HOOK-002（バージョンの単調）、PROP-HOOK-003（署名）、PROP-HOOK-005（送り直しの時刻）。
- 表駆動テスト DT-HOOK-001（応答 → 扱い）。
- 試験のベクトル：署名（[quality.md](../quality.md) の 2.2.1 節 L）。

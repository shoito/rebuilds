---
status: accepted
date: 2026-10-04
---

# ADR-0048: 公開 API は返した件数と書き込みの回数で計量し、プランの月の上限を Valkey で強制する。請求の連携と活動の Webhook は MVP の後

## Context

- MVP の公開 API は「使った量の計量」を含む（[intent.md](../intent.md)）。
- 本家は使った量に応じた課金（投稿の読み出し 1 件あたりの単価）と、月 300 万件の投稿の読み出しの上限を持つ（[intent.md](../intent.md) の出典、[Pricing](https://docs.x.com/x-api/getting-started/pricing)）。
- 請求には決済の事業者と税の扱いが要る。決済が絡む機能は MVP の後に回している（[intent.md](../intent.md) の MVP の後）。
- [architecture/README.md](../architecture/README.md) の 7 節は、api-and-rate-limits の範囲に Webhook を含めている。

## Options

計量：

1. **応答の後に計量の出来事を Firehose へ流し、日ごとに集計する。月の上限は Valkey の数で強制する**
2. 要求ごとに Aurora に計量の行を書く
3. 計量しない（レート制限だけ）

範囲：

- a. **MVP は計量と上限まで。請求の連携と Webhook は MVP の後**
- b. MVP で請求まで

## Decision

1 と a を採用する。詳細は [api-and-rate-limits.md](../architecture/api-and-rate-limits.md) の 6・7 節。

- 単位：`post_read`（返した投稿の件数。`visible()` で落としたものは数えない）、`user_read`、`dm_read`、`write`。
- プラン：`free`、`payg`（開発者が決める上限）、`partner`（審査）。月の上限は `usage:{app}:{yyyymm}:{unit}` で強制し、超えたら `429`（`usage_cap_reached`）。
- 計量の出来事は失ってよい側に倒す（Aurora を通さない。[ADR-0005](0005-event-log-and-outbox.md) の閲覧と同じ考え方）。失う割合は Firehose の失敗の数で測る。
- 活動の Webhook は、形（登録の確かめ、`<Brand>-Signature`、egress、送る前の `visible()`）だけを決め、着手は MVP の後。
- 2 を採らない理由：要求ごとの行が、正本の DB を圧迫する。
- 3 を採らない理由：MVP の範囲に反し、後の課金の根拠がなくなる。
- b を採らない理由：決済と税の扱いが MVP に入る。

## Consequences

- 良くなること：
  - 計量が正本の DB に触れない。上限の強制は要求の前の 1 回の読み出しで済む。
- 引き受けるコスト：
  - 計量の出来事を失うと、日ごとの集計が少なめに出る（請求を始める前に、失う割合を確かめる）。
  - MVP の間、`payg` は上限だけで課金しない。
  - Webhook がない間、開発者はポーリングする（レート制限の量が増える）。

## Confirmation

- 結合テスト：`visible()` で落とした投稿を数えない。上限の到達で `429`。
- 本番：計量の合計と、`public-api` の応答の件数のメトリクスの差を日ごとに見る。

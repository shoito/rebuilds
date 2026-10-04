---
status: accepted
date: 2026-10-04
---

# ADR-0047: レート制限は Valkey の上のトークンバケットを Valkey Functions で複数同時に引く。利用者の行動の上限は画面と API で共通にし、応答は IETF の `RateLimit` のヘッダーで返す

## Context

- 公開 API はアプリごと・利用者ごとのレート制限を持つ（[intent.md](../intent.md)）。NFR-012 は、上限を超えて受け付けた要求を 1% 以内にする。
- スパムとボットへの備えとして、投稿・フォロー・DM の 1 日の上限が要る（NFR-011）。本家の文書は、投稿 1 日 2,400 件、DM 500 件、フォロー 400 件としている（[intent.md](../intent.md) の出典。検索結果の抜粋）。
- 本家の API は `x-rate-limit-limit`・`x-rate-limit-remaining`・`x-rate-limit-reset` を返す（[Rate limits](https://docs.x.com/x-api/fundamentals/rate-limits)、2026-10-04 に確認）。
- IETF の draft-ietf-httpapi-ratelimit-headers は draft-11（2026-05-23）で、`RateLimit-Policy`（`q`、`w`）と `RateLimit`（`r`、`t`）を定める。まだ RFC ではない（[datatracker](https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/)、2026-10-04 に確認）。
- [architecture/README.md](../architecture/README.md) の 6 節で、IETF の形を第一の候補にした。

## Options

数え方：

1. **トークンバケット（Valkey Functions で原子的に、複数の桶を同時に）**
2. 固定の窓の数（`INCR` と期限）
3. 各タスクのメモリーの中だけ

ヘッダー：

- a. **IETF の `RateLimit-Policy`・`RateLimit`（draft-11）と `Retry-After`**
- b. 本家と同じ形の独自のヘッダー（`X-<Brand>-RateLimit-*`）

## Decision

1 と a を採用する。詳細は [api-and-rate-limits.md](../architecture/api-and-rate-limits.md) の 5 節。

- 桶の種類：利用者の行動（画面と API で共通）、利用者×アプリ、アプリ、IP、全体。1 つの要求が当たる桶を全部同時に引き、どれかが空なら `429` で、どの桶も減らさない。
- `rl_take` の関数を `vk-edge` に置き、同じ主体の桶をハッシュタグで同じスロットにまとめる。時刻は Valkey の `TIME`。1 日の上限は、1 日の桶と 30 分の桶の 2 つで表す。
- 利用者の行動の上限の既定（S1）：投稿 1 日 1,000（電話の確認がない人 50）、フォロー 400、DM 500。値は `policy.ratelimit.*`、攻撃の時は `ops.ratelimit.*` で下げる。
- `RateLimit` は最も余りの少ない桶だけを返す。`pk` は付けない。
- Valkey が落ちたら、読み出しと書き込みの桶はタスクの中の近似で続け、SMS の送信の桶は止める。
- 2 を採らない理由：窓の境で 2 倍の量が通る。連投の束を止めにくい。
- 3 を採らない理由：タスクの数で上限が変わり、NFR-012 の 1% を守れない。
- b を採らない理由：標準の形があり、名前の規則（リポジトリ共通の ADR-0006）とも合う。草案の変化を追う手間は受け入れる。

## Consequences

- 良くなること：
  - 画面と API の両方から同じ上限を守れる（API で上限を迂回できない）。
  - 連投の束と総量を両方止められる。
- 引き受けるコスト：
  - 主体の違う桶を引くときの 2 回の呼び出しと、戻しの失敗による超過。
  - 草案のヘッダーが RFC になるまでに形が変わりうる。
  - 本家より投稿の上限が低い。到達の率を見て見直す。

## Confirmation

- 性質ベーステスト：PROP-RL-001（受け付けの合計が容量と補充を超えない）、PROP-RL-002（どれかが空なら減らさない）。
- 表駆動テスト：DT-RL-001（段 × 行動 × 上限）。
- 負荷試験：NFR-012 の超過 1% 以内（[capacity.md](../architecture/capacity.md) の 8 節の L9）。
- 本番：`ratelimit.overadmit_ratio` を日ごとに見る。

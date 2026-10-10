---
status: accepted
date: 2026-10-10
---

# ADR-0065: 年度は `night_date` が 4 月 1 日以後ならその年。数えは 1 泊 1 日を既定にし、境の扱いは `legal.minpaku_day_boundary_rule`。外部の泊は `legal.minpaku_count_external_nights` が数える値のときだけ `regulated_nights` に入れ、上限を超える分は `external_overflow` に数えて CHECK を破らない。値を変えたら年度ごとに数え直す

## Context

- 泊の日を `regulated_nights`（届出住宅 × 日）に予約と同じトランザクションで挿入し、年度の数を CHECK で守る。外部の泊は `legal.minpaku_count_external_nights` で扱い、上限を超えても既存の予約を取り消さない（[ADR-0006](0006-regulatory-night-cap-enforcement.md)）。
- 数え方は 4 月 1 日の正午から翌年の 4 月 1 日の正午までの期間で、正午から翌日の正午を 1 日（埼玉県の説明、2026-10-10 に確認。施行規則の条文は未取得）。
- 外部の泊を CHECK のある数に足すと、上限を超えたとき取り込みと申告が失敗する。数えない値（`none`）のときに外部の泊が `regulated_nights` の主キーを占めると、本システムの泊が数えられなくなる。
- 同じ夜の 2 室を 1 日と数え、片方を外しても日を残す必要がある。

## Options

1. **`claim_count` で 1 日を数え、外部の泊は値に従って入れ、超えた分は `external_overflow`。値の変更で数え直す**
2. 外部の泊を常に `regulated_nights` に入れ、数えるかは集計で決める
3. 外部の泊は数えず、画面に出すだけ

## Decision

1 を採用する。詳細は [regulatory-compliance-japan.md](../architecture/regulatory-compliance-japan.md) の 5・6 節。

- 年度：`fiscal_year(d) = d ≥ 4/1 ? year(d) : year(d) − 1`。
- `regulated_nights.claim_count` を持ち、新しい日のときだけ `nights_used` を増やす。外すときは未来の日（正午が今より後）だけ減らし、0 で行を消す。
- 境：`legal.minpaku_day_boundary_rule`（`one_per_night` 既定・`noon_to_noon_strict`）。本番の値は L1 の後。
- 外部の泊は `regulated_external_nights` に常に記録する。数える値のときだけ `regulated_nights` に入れ、上限を超える分は `external_overflow` に数えて `regulatory_exceptions` に記録する。
- 値を変えたら `regulated-recount` が届出住宅 × 年度ごとにロックの中で作り直す。
- 上限の残りが 5 日以下の届出住宅はリクエストを受けない（即時予約だけ）。

### 他の案を選ばなかった理由

- **2**：`none` のときに外部の泊が本システムの日を隠す。CHECK を破る。
- **3**：L1 の結論が「数える」なら作り直しになる（ADR-0006 の理由）。

## Consequences

- 良くなること：
  - 外部の泊が上限を超えても、取り込みと申告は失敗せず、新しい予約は止まる。
  - 法務の結論で値を変えても、数え直しで整う。
- 引き受けるコスト：
  - `claim_count` と外部の記録の照合が増える。

## Confirmation

- 性質ベーステスト PROP-REG-001〜006（上限、日の数、過ぎた日、禁じた日、`cap-ref` との一致、数え直し）。
- 表駆動テスト：[regulatory-compliance-japan.md](../architecture/regulatory-compliance-japan.md) の 5.4 節の例。年度の境と閏日。

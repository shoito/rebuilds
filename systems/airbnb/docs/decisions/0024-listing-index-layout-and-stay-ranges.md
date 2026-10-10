---
status: accepted
date: 2026-10-10
---

# ADR-0024: 索引 `listings_v<n>`（別名 `listings`）は S1 で主シャード 2・写し 2、`refresh_interval` 1 秒。文書は DB から毎回全体を作り直し、`search_version` を `external_gte` の外部のバージョンにする。`stay_ranges` は空きの区間 `[a, b)` を `{gte: a, lte: b − p}`（次の予約がない区間の終わりは縮めない）の閉じた範囲で入れ、問い合わせ `{gte: check_in, lte: check_out}` の `contains` で引く。日付を決めない検索のために月ごとの最長の空きの泊数 `month_runs` を持つ

詳細は [search-and-ranking.md](../architecture/search-and-ranking.md) の 4 節。

## Context

- [ADR-0003](0003-search-for-date-range-availability.md) は `stay_ranges` を `[a, b − p)` とし、滞在が収まる条件を `a ≤ check_in` かつ `check_out ≤ b − p` とした。索引の範囲の型にどう入れるか（端を含むか）で 1 日ずれる。
- [ADR-0003](0003-search-for-date-range-availability.md) は `calendar_version` を外部のバージョンにするとした。文書はカレンダーの外の変化（改訂、状態、料金、順位の材料）でも変わり、`calendar_version` だけでは内容の変化の順を表せない。
- 予約できる期間の終わりに接する空きの区間には次の行がないので、準備の日で縮める必要がない。
- 日付を決めない検索は「その月の中に N 泊の空きがある」で絞りたい（[ADR-0003](0003-search-for-date-range-availability.md)）。範囲の長さは `date_range` で問えない。

## Options

1. **閉じた範囲 `{gte: a, lte: e}`（`e` はチェックアウトの日の最大）、全体の作り直しと `search_version`、`month_runs`**
2. 開いた範囲 `{gte: a, lt: b − p}` で入れ、問い合わせを `{gte: ci, lt: co}` にする
3. 事象ごとに部分の更新（`stay_ranges` だけ）を `calendar_version` で書く

## Decision

1 を採用する。

- `stay_ranges` の各値は `{gte: a, lte: e}`。`e = b − p`（`b` が行の始まり）か `e = b`（`b` が窓の終わり）。`e − a < min_nights_floor` は捨てる。1 件 200 区間まで。
- 問い合わせは `{gte: check_in, lte: check_out, relation: contains}`。
- `search_version` を core の `listings` に置き、リスティング・改訂・状態・`stay_claims`・カレンダーの設定・料金・順位の材料の変化と同じトランザクションで上げる。`search-indexer` は DB から文書の全体を作り、`version_type=external_gte` で書く。
- `month_runs`（nested `{month, max_run}`）を持ち、日付を決めない検索のステージ 1 で使う。
- 主シャード 2・写し 2、`refresh_interval` 1 秒。状態・措置・届出の事象は優先の待ち行列で流す。

### 他の案を選ばなかった理由

- **2**：開いた端の扱いは、問い合わせと文書の両方で揃えないと 1 日ずれる。閉じた範囲のほうが「チェックアウトの日を含む」という意味を読み取りやすく、性質ベーステストで確かめやすい。範囲の型の開いた端の内部の扱いを確かめる手間も省ける。
- **3**：部分の更新は事象の中身を信じることになり、重複と順序の入れ替えで食い違う。カレンダーの外の変化との順も表せない。

## Consequences

- 良くなること：
  - 文書はいつも DB の 1 時点の全体で、古い書き込みはバージョンで捨てられる。
  - `stay_ranges` の境の正しさを、1 つの関数と性質で確かめられる。
- 引き受けるコスト：
  - 小さな変化でも文書の全体（12 KB）を書く。S3 の更新の量は capacity の領域で見る。同じ件の事象は 500ms まとめる。
  - 窓の終わりをまたぐ滞在はステージ 1 で落ちる。
  - 200 区間を超える件（細かいブロックの多い件）は遠い日付の空きを失う。

## Confirmation

- PROP-SRCH-002（`stay_ranges` の同値）、PROP-SRCH-004（収束）。
- 試験のベクトル：[search-and-ranking.md](../architecture/search-and-ranking.md) の 4.3 節の例。

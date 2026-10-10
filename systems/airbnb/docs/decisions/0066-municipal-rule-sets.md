---
status: accepted
date: 2026-10-10
---

# ADR-0066: 自治体の規則は、区域（自治体のコードか条例の区域の多角形）と、禁じる泊の規則（泊の始まりの日の曜日、日付の範囲、祝日の扱い）、上限の値、特区の最短の泊数を、施行の日の付いたバージョンで持つ。届出住宅の区域は正確な位置から登録の時に決めて規則の集まりの ID を持たせる。規則の変更は既存の予約を取り消さず、反する予約の一覧を作る

## Context

- 条例で、区域や期間（曜日など）をさらに制限できる（観光庁の資料、2026-10-10 に確認）。規則はバージョンの付いた `municipal_rule_sets` で持ち、コードに自治体の名前を書かない（[ADR-0006](0006-regulatory-night-cap-enforcement.md)）。
- 条例の多くは「正午から正午」の日で期間を書く。泊の日（`night_date`）は正午から翌日の正午の始まりの日なので、泊の始まりの日の曜日で表せる。
- 区域の判定には正確な位置が要るが、正確な位置は vault にだけ置く。
- 条例の読み取りの責任は法務の L1。

## Options

1. **泊の始まりの日の曜日・日付の範囲・祝日の扱いの規則を、施行の日のあるバージョンで持つ。区域は登録の時に判定して ID を持たせる**
2. 規則を自由な式（スクリプト）で持つ
3. 予約のたびに正確な位置で区域を判定する

## Decision

1 を採用する。詳細は [regulatory-compliance-japan.md](../architecture/regulatory-compliance-japan.md) の 7 節。

- 列：`municipality_code`、`zone`（`whole` か `MULTIPOLYGON`）、`applies_to`、`effective_from`・`effective_to`、`prohibited_night_weekdays`、`prohibited_periods`、`holiday_rule`（`none`・`allow_night_before_holiday`・`prohibit_holidays`）、`annual_cap`、`min_nights`、`source_ref`、`approved_by`。
- `checkMunicipalRules` は泊の日ごとに、その日に効くバージョンで判定する。
- 区域は届出住宅の登録と住所の変更の時に `compliance-jp` が vault の位置で判定し、`rule_set_id` を書く。
- 祝日は `jp_holidays`（出どころは**未検証**）。
- 新しいバージョンを入れたら、反する既存の予約を `regulatory_exceptions` に一覧にし、運用とホストに知らせる。取り消さない。表の変更は QA と法務の承認。

### 他の案を選ばなかった理由

- **2**：表駆動テストで全部を試せず、法務と運用が読めない。
- **3**：予約の経路が vault を読むことになり、正確な位置の読み手が増える。

## Consequences

- 良くなること：
  - 規則が表で、法務と運用が入れて確かめられる。
- 引き受けるコスト：
  - 表で表せない条例の規則が出たら、列を足す（この ADR の更新）。

## Confirmation

- 表駆動テスト：曜日、祝日、期間、区域、施行の日をまたぐ滞在。[regulatory-compliance-japan.md](../architecture/regulatory-compliance-japan.md) の 7.3 節の例。

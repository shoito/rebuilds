---
status: accepted
date: 2026-10-10
---

# ADR-0006: 届出住宅を `regulated_properties` として持ち、泊の日を `regulated_nights`（届出住宅 × 日）に予約と同じトランザクションで挿入し、年度の数を CHECK 制約で守る。自治体の規則はバージョンの付いた表で持つ。数え方の解釈と他の掲載先の泊の扱いは `legal.*` に置く

## Context

住宅宿泊事業法の届出住宅は、1 年に人を泊める日数が 180 日を超えてはならない。条例で、区域や期間（曜日など）をさらに制限できる（観光庁の [住宅宿泊事業法の概要](https://www.mlit.go.jp/kankocho/minpaku/overview/minpaku/index.html)、2026-10-10 に確認）。数え方は、毎年 4 月 1 日の正午から翌年 4 月 1 日の正午までの期間で、正午から翌日の正午までを 1 日とする（法第 2 条第 3 項、施行規則第 3 条。[埼玉県の説明](https://www.pref.saitama.lg.jp/a0806/minpaku/jutaku-shukuhaku01.html) で確かめた。条文は e-Gov で取得できなかった）。

本システムは住宅宿泊仲介業者として、届出番号を表示し、違法な物件を仲介しない立場になる見込みである（法務の L1）。次を守る（NFR-006）。

- 届出住宅の年度の泊の日数が、上限（既定 180、条例でより少なければその値）を超えない。
- 条例で禁じた日（例：住居専用地域の平日）に泊めない。
- 予約の確定の後に、上限を理由に取り消さない（ゲストが泊まる所を失う）。

難しさは次のとおり。

- **上限は届出住宅ごと。** 1 つの届出住宅に複数のリスティング（部屋）がありうる。同じ夜に 2 室が埋まっても、泊めた日は 1 日である。
- **他の掲載先と直接の予約。** 同じ届出住宅は他の掲載先にも出る。本システムは他の掲載先の泊を、取り込んだ iCal（予約かブロックか区別できない）とホストの申告でしか知れない。
- **法令の解釈が未決。** 本システムが他の掲載先の泊まで数える義務があるか、条例の読み取りの責任は誰か、が法務の L1 の論点である。
- **並行。** 同じ届出住宅の別の部屋への予約、日程の変更、キャンセルが同時に来る。

本家は日本のリスティングに届出番号・許可番号の表示を求め、確かめの書類を上げさせる（[ヘルプの記事 2177](https://www.airbnb.com/help/article/2177)）。180 日の数えを本家がどう行うかは公開されていない（**未検証**）。

## Options

数え方：

1. **泊の日の行（届出住宅 × 日）を予約と同じトランザクションで挿入し、年度の数の行を CHECK 制約で守る**
2. 年度の数の列だけを持ち、予約の泊数を足し引きする
3. 予約の後に非同期で数え、上限を超えそうなら新しい予約を止める

他の掲載先の泊：

- a. **ホストの申告と取り込んだ予定を数えに足す規則を持ち、本番での有効化は `legal.*` の値で法務の後に決める**
- b. 本システムの予約だけを数える
- c. 取り込んだ予定をすべて泊として数える

## Decision

1 と a を採用する。

### 表の形

```sql
CREATE TABLE regulated_properties (
  id                  uuid PRIMARY KEY,
  regime              text NOT NULL,     -- minpaku | ryokan | tokku
  registration_number text NOT NULL,     -- 届出番号・許可番号・特定認定の番号（vault でなく core。公開する値）
  municipality_code   text NOT NULL,     -- 全国地方公共団体コード
  rule_set_id         uuid,              -- municipal_rule_sets
  annual_cap          smallint,          -- minpaku は 180 か条例の値。他は NULL
  verification_status text NOT NULL,     -- pending | verified | rejected | suspended
  host_account_id     uuid NOT NULL,
  version             bigint NOT NULL
);

CREATE TABLE regulated_years (
  property_id   uuid NOT NULL REFERENCES regulated_properties(id),
  fiscal_year   smallint NOT NULL,       -- 4 月 1 日の正午から始まる年度
  nights_used   smallint NOT NULL DEFAULT 0,
  external_used smallint NOT NULL DEFAULT 0,   -- 他の掲載先・直接の予約（legal.* の規則で数える分）
  cap           smallint NOT NULL,
  PRIMARY KEY (property_id, fiscal_year),
  CHECK (nights_used + external_used <= cap)
);

CREATE TABLE regulated_nights (
  property_id   uuid NOT NULL,
  night_date    date NOT NULL,           -- 正午から翌日の正午までの 1 日の、始まりの日
  source        text NOT NULL,           -- platform | external_declared | external_ical
  first_claim   uuid,                    -- この日を最初に埋めた stay_claims
  PRIMARY KEY (property_id, night_date)
);
```

- **泊の日**：チェックインの日 `d` からチェックアウトの日 `e` の滞在は、`d, d+1, …, e−1` の各日を `night_date` とする（チェックインは正午の後、チェックアウトは翌日の正午の前という通常の時刻の前提）。正午の前のチェックイン・正午の後のチェックアウトの扱い（2 日と数えるか）は `legal.minpaku_day_boundary_rule` で持ち、法務の L1 の後に決める。既定は上の 1 泊 1 日。
- **年度**：`night_date` が 4 月 1 日以後なら、その年の年度。年度をまたぐ滞在は、日ごとに年度を分けて数える。
- **重ならない日だけを数える**：`regulated_nights` の主キーで、同じ日は 1 行。挿入が新しい行を作ったときだけ `regulated_years.nights_used` を 1 つ増やす（`INSERT ... ON CONFLICT DO NOTHING RETURNING`）。2 室目の同じ夜は数えない。
- **外すとき**：キャンセル・期限切れ・日程の変更で `stay_claims` の行を外したら、その日を埋める他の有効な行が同じ届出住宅に残っていなければ、`regulated_nights` の行を消し、数を 1 つ減らす。過ぎた日（物件の現地の今日の正午より前）は、キャンセルでも消さない（泊めた日は戻らない）。

### 予約での確かめ

`reserveStay`・`alterReservation` と、ホストが「予約」として入れる操作（PMS の API の予約の作成）は、同じトランザクションで次を行う（[ADR-0004](0004-booking-state-machine-and-holds.md)）。

1. `regulated_properties` の行を `FOR UPDATE` で取る（届出住宅 → リスティングの順）。`verification_status` が `verified` でなければ 409 `registration_not_verified`。
2. 自治体の規則の表で、各泊の日が許されているかを確かめる。禁じた日があれば 409 `regulatory_day_blocked`。
3. 各泊の日を `regulated_nights` に挿入し、新しい日の数だけ `regulated_years` を増やす。CHECK に当たれば、トランザクションを戻して 409 `regulatory_cap_reached`。
4. 仮押さえ（`hold`）・リクエスト（`request`）の泊も数える。確定の時に上限で失敗させないため。期限切れで外す。

検索では、上限に達した届出住宅のリスティングの `stay_ranges` を年度の残りで空にし、残りの日数が少ないリスティングは残りの日数より長い滞在を候補から外す（[ADR-0003](0003-search-for-date-range-availability.md)）。

### 自治体の規則の表

- `municipal_rule_sets`（バージョンつき）：区域（自治体のコードと、条例の区域の多角形）、禁じる期間（曜日の集合、日付の範囲、祝日の扱い）、上限の値、特区民泊の最短の泊数、施行の日。
- 規則の内容（どの条例がどの区域に何を定めるか）は、法務と運用が条例を読んで入れる。コードに自治体の名前を書かない。
- 規則の変更は、施行の日の前に入れ、施行の日より後の既存の予約で規則に反するものを一覧にする。既存の予約を自動で取り消さない。扱いは運用とホストで決める（regulatory-compliance-japan の領域）。

### 他の掲載先の泊

- ホストの申告（`external_declared`）：ホストが他の掲載先・直接の予約で泊めた日を、カレンダーで印を付ける。PMS の API でも送れる。
- 取り込んだ予定（`external_ical`）：取り込みの設定で「外部の予約として扱う」を選んだ予定の日。
- これらを `regulated_nights` に `source` 付きで入れ、`external_used` に数えるかを `legal.minpaku_count_external_nights`（`none`・`declared`・`declared_and_ical`）で決める。法務の L1 の結論まで、本番は `none` のまま、数えた値をホストの画面に参考として出す。
- 外部の日が加わって上限を超えたとき（他の掲載先の予約が後から取り込まれたとき）、本システムの既存の予約は取り消さない。超過を `regulatory_exceptions` に記録し、ホストと運用に知らせる。

### 他の案を選ばなかった理由

- **2（数の列だけ）**：同じ夜の 2 室を 2 日と数えてしまう。日程の変更・キャンセルの戻しで、どの日を外すかがわからない。
- **3（非同期）**：数えるまでの間に上限を超える予約が入りうる。超えた後の取り消しは、ゲストが泊まる所を失う。
- **b（本システムの予約だけ）**：法務の結論が「他の掲載先も数える」なら作り直しになる。数える仕組みは先に作り、有効化を設定にする。
- **c（取り込みをすべて数える）**：ホストのブロック（泊めていない日）まで数え、ホストの営業の日を不当に減らす。

> 2026-10-10 の注記：
> - 書き込みは `INSERT ... ON CONFLICT DO NOTHING` ではなく、`claim_count` を増やす `ON CONFLICT DO UPDATE` に改めた。同じ夜の 2 室の 1 室を取り消しても、残りの室の日が消えないようにするため（[ADR-0065](0065-regulated-nights-fiscal-year-and-external-overflow.md)、[regulatory-compliance-japan.md](../architecture/regulatory-compliance-japan.md) の 5.3 節）。
> - 「同じ届出住宅の同じ夜の 2 室は 1 日と数える」は本システムの既定の解釈で、当てはめは法務の確認待ち（[intent.md](../intent.md) の L1）。L1 の結論が「室ごとに数える」なら、上限の CHECK を「`regulated_nights` の行の数」から「`claim_count` の和」に替える。表の形はどちらの数え方も持てるので、移行は CHECK と数えの関数の差し替えで済む。

## Consequences

- 良くなること：
  - 上限と自治体の規則を、予約の時点で、DB の制約で守れる。後からの取り消しがない。
  - 同じ届出住宅の複数の部屋を、正しく 1 日と数えられる。
  - 法務の結論が出ても、`legal.*` の値と規則の表の更新で切り替えられる。
- 引き受けるコスト：
  - 同じ届出住宅の予約が、届出住宅の行のロックで直列になる。部屋の多い届出住宅で待ちが伸びうる（`hot-dates-booking-poc` で確かめる）。
  - 仮押さえとリクエストも日を使うので、上限の近い届出住宅では、期限切れまで他の予約が入らない。
  - 定期報告の数（宿泊日数）は、他の掲載先の分をホストが足す必要がある。本システムの書き出しは本システムの分と申告の分を分けて出す。

## Confirmation

- 性質ベーステスト：任意の届出住宅（部屋 1〜5）、予約・リクエスト・仮押さえ・期限切れ・キャンセル・日程の変更・年度をまたぐ滞在・外部の申告の列で、どの時点でも各年度の `nights_used + external_used ≤ cap`、`nights_used` は有効な行のある日の数に一致する。参照の実装（日の集合を素直に数える）と一致する（[quality.md](../quality.md) の 2.2.1 節 B）。
- 表駆動テスト：自治体の規則の表の判定（曜日、祝日、期間、区域）。
- 時刻の試験：年度の境（3 月 31 日のチェックイン、4 月 1 日の正午）、閏日。
- 本番：`regulated_nights` と `stay_claims` の照合（日次）、上限の 90% に達した届出住宅の一覧（ホストへの知らせ）。

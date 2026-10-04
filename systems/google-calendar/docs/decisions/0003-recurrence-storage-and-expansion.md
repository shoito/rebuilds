---
status: accepted
date: 2026-10-04
---

# ADR-0003: 予定オブジェクト（マスター＋`RECURRENCE-ID` の上書き）を保存の単位にし、範囲（過去 31 日から未来 548 日）の回を展開の索引に写す。「これ以降」は系列を `UNTIL` で切って新しい UID に分ける

## Context

繰り返しの予定は、RFC 5545 の規則（RRULE・RDATE・EXDATE）と、回ごとの上書き（`RECURRENCE-ID` を持つ VEVENT）で表す。終わりのない規則（`COUNT`・`UNTIL` なし）は、無限の回を持つ。

回を使う処理が多い。

- 画面と API の範囲の表示（今週、今月）
- 空き時間の照会と、複数の人の候補の計算（50 人の 2 週間）
- 会議室の二重予約の防止（重なりの判定）
- リマインダーの時計（次の数分に来る回）
- 検索（未来の回を日付で絞る）
- CalDAV の `calendar-query` の時間の範囲の条件

本家の API は、系列を `recurrence` の行で持ち、回を `recurringEventId` と `originalStartTime` で特定する。回を 1 つずつ変えて、系列の全体や「これ以降」を表さないよう勧めている（[Recurring events](https://developers.google.com/workspace/calendar/api/guides/recurringevents)、2026-10-04 に確認）。「これ以降」の内部の表し方、回の上限は、公開の資料で確かめられなかった（未検証）。

CalDAV は、同じ UID の VEVENT（マスターと上書き）を 1 つのリソースに入れることを求める（RFC 4791 の 4.1 節）。iTIP も UID と `RECURRENCE-ID` で回を特定する。

## Options

保存と展開：

1. **予定オブジェクトを正本にし、範囲の中の回を展開の索引（`occurrences`）に写す。範囲の外はその場で展開する**
2. 予定オブジェクトだけを持ち、読むたびに展開する
3. すべての回を行として保存し、規則は作成の時の入力としてだけ持つ

「これ以降」：

- a. **元の系列を `UNTIL` で切り、新しい UID の系列を作る。2 つを関連（`RELATED-TO`）でつなぐ**
- b. 1 つの系列の中に、`RANGE=THISANDFUTURE` の上書きを持つ
- c. 回ごとの上書きを、その回から先にすべて作る

## Decision

1 と a を採用する。

### 予定オブジェクト

- 1 つの UID を 1 つの予定オブジェクト（`event_objects`）にする。マスター（規則つき、または単発）と、`RECURRENCE-ID`（回の元の開始の壁時計の時刻＋TZID、終日なら日付）ごとの上書き（`event_overrides`）を持つ。
- 版（`version`）は予定オブジェクトに 1 つ。マスターか上書きのどれかが変われば上がる。CalDAV の ETag、API の `etag`、iTIP の `SEQUENCE` の元になる（[ADR-0005](0005-change-log-and-sync-tokens.md)、[ADR-0006](0006-organizer-and-attendee-copies.md)）。
- 上書きは、変えた項目だけを持つ差分ではなく、その回の VEVENT の全体を持つ。iCalendar の意味と同じにし、マスターの変更で上書きの意味が変わらないようにする。系列の全体の変更で、上書きの中のマスターと同じ値だった項目を追従させるかは、events-and-recurrence の領域で決める。
- 消した回は EXDATE に入れる。上書きを持つ回を消すときは、上書きも消して EXDATE に入れる。

### 受け付ける規則と上限

- `FREQ` は `DAILY`・`WEEKLY`・`MONTHLY`・`YEARLY`。`SECONDLY`・`MINUTELY`・`HOURLY` は受けない。取り込み（ICS、CalDAV、iMIP）では、範囲の中で展開した単発の予定に変えるか、拒否する（events-and-recurrence の領域）。
- EXRULE（RFC 5545 で非推奨）は受け付けて、EXDATE に展開して保存する。書き出しでは EXRULE を出さない。
- 1 つの予定オブジェクトの上限：上書き 1,000 件、RDATE 1,000 件、EXDATE 5,000 件。1 つの規則の展開は、範囲の中で 5,000 回まで。超える規則は拒否する。
- `RSCALE`（RFC 7529）は受けない（[ADR-0007](0007-interop-standards-scope.md)）。

### 展開

- `packages/recurrence` の `expand(object, window, tzdata)` を唯一の展開の関数にする。規則の回を壁時計の時刻で求め、[ADR-0002](0002-time-representation.md) の `resolve` で UTC にし、RDATE を足し、EXDATE を引き、上書きで置き換える。
- 回の識別子は、`(event_object_id, recurrence_id)`。`recurrence_id` は回の元の開始の壁時計の時刻＋TZID（終日なら日付）で、UTC ではない。tzdb が変わっても回の識別子は変わらない。
- 上書きで時刻を動かした回は、動いた後の時刻で範囲に入るかを判定する（元の時刻が範囲の外でも、動いた先が範囲の中なら出す）。

### 展開の索引

- 範囲は、今日から過去 31 日と未来 548 日（約 18 か月）。毎日 `expander` が範囲の端を進め、新しく入った日の回を足し、外れた日の回を消す。
- 行：`(tenant_id, calendar_id, event_object_id, recurrence_id, start_utc, end_utc, transparency, status, tzdata_version, object_version)`。月で分割する（`pg_partman`）。
- 索引は写しである。予定オブジェクトの書き込みと同じトランザクションで、その予定オブジェクトの範囲の中の行を作り直す。捨ててもその場の展開から作り直せる。
- 空き時間・会議室・リマインダー・範囲の表示は、範囲の中は索引を読み、範囲の外（未来 548 日より先、過去 31 日より前）は、その場で `expand` を呼ぶ。会議室の予約は範囲の中に限る（[architecture/README.md](../architecture/README.md) の 6 節）。
- 範囲と行の数は、E2 の前の `occurrence-index-poc` で確かめる。

### 「これ以降」

- 回 R から先を変えるとき、元の系列の規則に R の直前の回までの `UNTIL`（`COUNT` なら数え直し）を付け、R から始まる新しい UID の予定オブジェクトを作る。新しい系列は `RELATED-TO`（`RELTYPE=SIBLING` を予定）で元の系列を指し、本システムの中では `split_from` で結ぶ。
- 元の系列の、R 以降の上書きと EXDATE は、新しい系列へ移す。新しい規則で同じ回が生まれないものは捨て、捨てたことを主催者に示す（events-and-recurrence の領域）。
- 参加者の写しには、元の系列の更新（`REQUEST`）と、新しい系列の招待（`REQUEST`）の 2 つを送る（[ADR-0006](0006-organizer-and-attendee-copies.md)）。参加者の出欠は、新しい系列へ引き継ぐ。
- R が最初の回なら、分けずに系列の全体の変更にする。

### 他の案を選ばなかった理由

- **2（読むたびに展開）**：空き時間・会議室の排他の制約・リマインダーに、UTC の区間の索引がない。50 人の 2 週間の探索（NFR-004）で、全員の全系列を展開する。会議室の二重予約を DB の制約で防げない。
- **3（すべての回を行にする）**：終わりのない規則を表せない。系列の全体の変更が、数百の行の書き換えになる。iCalendar・CalDAV との往復で、規則を作り直す必要がある。
- **b（`RANGE=THISANDFUTURE`）**：RFC 5545 にあるが、対応しないクライアントが多い（本システムの評価。相互運用の試験で確かめる）。CalDAV と iMIP の相手が誤って解釈すると、回が食い違う。
- **c（回ごとの上書き）**：本家も勧めていない形で、上書きの上限にすぐ届き、終わりのない規則で表せない。

## Consequences

- 良くなること：
  - 保存の単位が iCalendar・CalDAV・iTIP と同じで、往復で形が変わらない。
  - 空き時間・会議室・リマインダーが、UTC の区間の索引を使える。会議室の二重予約を DB の制約で防げる。
  - 回の識別子が壁時計の時刻なので、tzdb の更新で変わらない。
- 引き受けるコスト：
  - 展開の索引の行が多い（S1 で 4 億行の見込み）。分割と、範囲の端の毎日の維持が要る。
  - 予定オブジェクトの書き込みのたびに、範囲の中の索引を作り直す。毎日の予定の系列の変更は、約 580 行の書き換えになる。
  - 範囲の外の会議室の予約を受けられない。
  - 「これ以降」で UID が変わるので、外部のカレンダーでは別の予定に見える。出欠の引き継ぎは本システムの中でだけ保証する。

## Confirmation

- 性質ベーステスト（参照との比べ）：任意の規則・RDATE・EXDATE・TZID・範囲で、`expand` の回の集合が参照の実装と一致する（[quality.md](../quality.md) の 2.2.1 節）。
- 性質ベーステスト：任意の予定オブジェクトと書き込みの列の後、展開の索引の行の集合が、その場の `expand` の結果と一致する。
- 性質ベーステスト：任意の系列と回 R で、「これ以降」の分割の前後で、R より前の回の集合は変わらず、R 以降の回の集合は新しい系列の展開と一致する。
- 本番：展開の索引の抜き取りの照合（その場の `expand` と比べる）で、不一致 0 件。
- CI：`packages/recurrence` の外で RRULE を解釈するコードを禁止する（[ADR-0001](0001-platform-and-stack.md)）。

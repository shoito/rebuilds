---
status: accepted
date: 2026-10-04
---

# ADR-0011: 対応しない繰り返しの入力は経路で扱いを分ける。API と CalDAV の `PUT` は拒否し、ICS の取り込み・購読と iMIP の受信は `HOURLY` 以下の規則を範囲の中の RDATE に変えて UID を保つ。`RANGE=THISANDFUTURE` は 1 回分の上書きとして当てて利用者に示す

## Context

[ADR-0003](0003-recurrence-storage-and-expansion.md) と [ADR-0007](0007-interop-standards-scope.md) は、`FREQ` を `DAILY` 以上に限り、`RSCALE` を持たず、`RANGE=THISANDFUTURE` を受け付けないと決めた。取り込みで「範囲の中で展開した単発の予定に変えるか、拒否する」の選び方は、この領域に残した。

外から来る入力の経路は 4 つで、性質が違う。

- **API・画面**：利用者がその場で直せる。
- **CalDAV の `PUT`**：クライアントが自分の形を保とうとする。サーバーが形を変えると、クライアントは書き直しを繰り返すことがある。
- **ICS の取り込み・購読**：一方向で、元を直せない。
- **iMIP の受信**：外部の主催者が正で、後から `REQUEST`・`CANCEL`・`REPLY` が UID と `RECURRENCE-ID` で届く。

単発の予定に変える案は、1 つの UID を多くの予定オブジェクトに分けるので、後から届く iTIP のメッセージを当てられない。

## Options

1. **経路で分ける。API と CalDAV は拒否、取り込みと iMIP は UID を保ったまま RDATE に変える**
2. すべての経路で拒否する
3. 取り込みと iMIP は、範囲の中の回を単発の予定（別の UID）に変える

`RANGE=THISANDFUTURE`：

- a. **1 回分の上書きとして当て、印を付けて利用者に示す**
- b. 拒否する
- c. 系列を分ける（本システムの中で別の UID を作る）

## Decision

1 と a を採用する。表は [events-and-recurrence.md](../architecture/events-and-recurrence.md) の 8 節。

- `FREQ=HOURLY` 以下：API は 400、CalDAV の `PUT` は `CALDAV:valid-calendar-data` で拒否。ICS と iMIP は、DTSTART から範囲の未来の端までの回を RDATE（1,000 件まで）に変え、`rdate_materialized` の印を付ける。元の RRULE は `X-<BRAND>-ORIGINAL-RRULE` に残す。
- RRULE が 2 本：API・CalDAV は拒否。取り込みと iMIP は 2 本目を RDATE に変える。
- EXRULE：すべての経路で EXDATE に展開する（[ADR-0003](0003-recurrence-storage-and-expansion.md)）。
- `RANGE=THISANDFUTURE`：CalDAV の `PUT` は拒否。取り込みと iMIP は、`RANGE` を無視して 1 回分の上書きとして当て、`range_ignored` の印を付け、画面で「主催者の変更の一部が反映されていない可能性」を示す。
- `RSCALE`：すべての経路で拒否し、取り込みは件数を示す。
- 空の規則：API・CalDAV は拒否、取り込みと iMIP は DTSTART だけの単発にする。
- 印の件数を監視し、`RANGE` の対応（MVP の後）の判断に使う。

### 他の案を選ばなかった理由

- **2（すべて拒否）**：外部の主催者からの招待を受けられず、購読の ICS の一部が黙って欠ける。
- **3（単発の予定に変える）**：1 つの UID が多くの予定オブジェクトになり、後から届く `CANCEL`・`REQUEST` を当てられない。CalDAV で同じ UID のリソースが 1 つという前提（RFC 4791 の 4.1 節）にも合わない。
- **b（`RANGE` を拒否）**：外部の主催者の変更のすべてを失う。1 回分だけでも当てるほうが、利用者に近い情報になる。
- **c（系列を分ける）**：外部の主催者の UID と、本システムの中の UID がずれ、以後の `REQUEST` を当てる先が 2 つになる。

## Consequences

- 良くなること：
  - 取り込みと iMIP で、UID と iTIP の照合を保てる。
  - API・CalDAV では、対応しない形を明示して拒否し、黙って形を変えない（[ADR-0007](0007-interop-standards-scope.md) の方針）。
- 引き受けるコスト：
  - RDATE に変えた予定は、範囲の端より先の回を持たない。iMIP の招待は作り直せないので、画面で示す。
  - `RANGE` を無視した回より後は、外部の主催者の意図と違う。利用者に示すだけで、直せない。

## Confirmation

- 表駆動テスト：DT-REC-003（経路 × 入力）。
- 結合テスト：`HOURLY` の iMIP の招待を受け、同じ UID の `CANCEL`（`RECURRENCE-ID` つき）が RDATE の回に当たる。
- 本番：`rdate_materialized`・`range_ignored` の件数を監視する。

---
status: accepted
date: 2026-10-04
---

# ADR-0007: iCalendar・iTIP・iMIP・CalDAV・WebDAV の同期の対応の範囲を決める。`free-busy-query`・`MKCALENDAR`・VTODO・`RSCALE`・`COUNTER` は MVP で持たない

## Context

カレンダーの相互運用の標準は多く、対応しないクライアントの多い拡張もある。範囲を決めずに作ると、エージェントは RFC の全部を実装しようとするか、目の前のクライアントに合わせた独自の振る舞いを足しがちである。

本家の CalDAV は、OAuth 2.0 だけで認証し、`free-busy-query` の REPORT、`MKCALENDAR`、VTODO・VJOURNAL を持たない。RFC 6578 の同期を使い、RFC 6638 のスケジュールは一部だけ（招待は予定のコレクションに自動で届く）（[CalDAV API developer's guide](https://developers.google.com/workspace/calendar/caldav/v2/guide)、2026-10-04 に確認）。本家の iMIP の対応の細部（`COUNTER` などの方法）は、公開の資料で確かめられなかった（未検証）。

MVP の対象のクライアントは、iOS・macOS のカレンダー、Thunderbird、Android の DAVx5（CalDAV）、本家・Outlook・Apple のカレンダー（iMIP）とする（[intent.md](../intent.md) の K9）。

## Options

1. **対象のクライアントで使われる部分に絞り、範囲を表で決める。** 表の外は、明示して拒否するか、決まった形に変えて受ける
2. RFC の全部を実装する
3. 対象のクライアントの振る舞いに合わせて、その都度足す

## Decision

1 を採用する。

### 範囲

| 標準 | 対応 | 持たないもの・注記 |
| --- | --- | --- |
| iCalendar（RFC 5545） | VEVENT、VTIMEZONE、VALARM、RRULE・RDATE・EXDATE、`RECURRENCE-ID`、ATTENDEE・ORGANIZER とその引数、`TRANSP`、`CLASS`、`STATUS`、`SEQUENCE`、`RELATED-TO` | VTODO・VJOURNAL は受けない（MVP の後）。VFREEBUSY は空き時間の書き出しにだけ使う。EXRULE は受けて EXDATE に展開する。`FREQ` の制限は [ADR-0003](0003-recurrence-storage-and-expansion.md) |
| iCalendar の新しいプロパティ（RFC 7986） | `COLOR`、`CONFERENCE`、`NAME`・`DESCRIPTION`（カレンダー）、`REFRESH-INTERVAL`（ICS の公開） | `IMAGE` は持たない |
| iTIP（RFC 5546） | `REQUEST`・`REPLY`・`CANCEL` の送受信。`PUBLISH` の受信（取り込み）。外部の参加者からの `REFRESH` の受信（最新の `REQUEST` を送り直す） | `ADD` は受けて、最新の系列の `REQUEST` を求め直す扱いにする。`COUNTER`・`DECLINECOUNTER` は MVP で持たない（受けたら主催者に「時刻の提案を受けた」と知らせるだけで、写しを変えない）。日程の提案は MVP の後 |
| iMIP（RFC 6047） | `text/calendar` を付けたメールの送受信。送信は SES、受信は SES の受信 → S3 | 返事の照合の鍵、送信元の認証（DKIM・DMARC の整合）は invitations-and-itip の領域 |
| CalDAV（RFC 4791） | `PROPFIND`・`PROPPATCH`（表示名・色だけ）・`REPORT`（`calendar-query`・`calendar-multiget`）・`GET`・`PUT`（`If-Match`・`If-None-Match`）・`DELETE`・`OPTIONS` | `free-busy-query` の REPORT、`MKCALENDAR`、`LOCK`・`UNLOCK`・`COPY`・`MOVE`、利用者の定義したプロパティを持たない（本家と同じ）。カレンダーの作成は画面と API で行う |
| WebDAV の同期（RFC 6578） | `sync-collection` の REPORT。トークンは [ADR-0005](0005-change-log-and-sync-tokens.md) と同じもの | 深さ 1 だけ |
| CalDAV のスケジュール（RFC 6638） | サーバーの暗黙のスケジュール（CalDAV で主催者の予定を `PUT` したら、サーバーが招待を送る）。招待は予定のコレクションに自動で届ける | スケジュールの受信箱・送信箱は最小限（空の受信箱を見せる）。送信箱への `POST` の空き時間の照会は持たない |
| 発見（RFC 6764） | `/.well-known/caldav` のリダイレクト、DNS の SRV・TXT | — |
| WebDAV の ACL（RFC 3744） | `current-user-privilege-set` の読み出し（クライアントが書けるかを知るため） | ACL の書き換えは持たない（共有は画面と API で行う） |
| CTag（calendarserver.org の拡張） | `getctag`。値はカレンダーの `change_seq` | 代理（proxy）の拡張は MVP の後 |
| タイムゾーンの参照（RFC 7809） | 持たない | 送る予定には、使う VTIMEZONE を必ず付ける |
| 暦の拡張（RFC 7529 `RSCALE`） | 持たない | 受けたら拒否する |
| 空き時間の公開（RFC 7953 VAVAILABILITY） | 持たない | 勤務の時間は本システムの設定で持つ |
| JSCalendar（RFC 8984） | 公開 API の形にしない | 公開 API は本家の API の振る舞いに寄せた JSON にする（api-and-push の領域） |

### RFC との意図した違い

本システムが RFC の文言と違う振る舞いを選んだものを、ここに 1 つにまとめる。新しい違いを足すときは、この表に行を足し、根拠の ADR を書く。相互運用の試験（[quality.md](../quality.md) の 2.2.1 節 H）で、相手の振る舞いを記録する。

> 2026-10-04 の注記：統合の工程で、各 ADR に散っていた RFC との違いをこの表にまとめた。

| # | RFC と節 | RFC の要求 | 本システム | 根拠 |
| --- | --- | --- | --- | --- |
| D1 | RFC 5545 の 3.3.10 | 規則が存在しない現地の時刻を生んだら、その回を捨て、数えない | 捨てずに、3.3.5 節の解き方（切り替えの前のオフセット）でずらして残す。毎週の会議が夏時間の始まりの週だけ黙って消えないようにする | [ADR-0008](0008-recurrence-expansion-semantics.md) |
| D2 | RFC 6047 の 2.2.2 | iMIP の認証は S/MIME で行う（MUST） | S/MIME を必須にしない。From と ATTENDEE・ORGANIZER の一致と、DKIM か SPF の From のドメインへの揃いで確かめる。S/MIME の署名が付いて正しければ、それも通る | [ADR-0015](0015-imip-addressing-and-trust.md) |
| D3 | RFC 5545 の 3.8.4.4（`RANGE=THISANDFUTURE`） | その回と以降の回への変更 | 取り込みと iMIP では 1 回分の上書きとして当て、`range_ignored` の印で利用者に示す。CalDAV の `PUT` は拒否する | [ADR-0011](0011-inbound-recurrence-normalization.md) |
| D4 | RFC 6638 の 7.1（`SCHEDULE-AGENT=CLIENT`・`NONE`） | サーバーはその参加者へスケジュールのメッセージを送らない | 外部の参加者にだけ従う。本システムの中の参加者には常に写しを作り、`SCHEDULE-STATUS:2.3` を付ける | [ADR-0024](0024-caldav-implicit-scheduling.md) |
| D5 | RFC 5545 の 3.8.5.3（DTSTART が規則に合わない） | 回の集合は未定義 | DTSTART を最初の回として含め、`COUNT` に数える。新しい作成では 422 | [ADR-0008](0008-recurrence-expansion-semantics.md) |
| D6 | RFC 6638 の 3.2.2.1（参加者の EXDATE） | 参加者は EXDATE を足してよい | 足した EXDATE を、その回の辞退の `REPLY` に変える（写しに EXDATE を残さない） | [ADR-0024](0024-caldav-implicit-scheduling.md) |

- RFC が求める以上のことをするもの（`SEQUENCE` を場所の変更と参加者の削除でも上げる。[ADR-0014](0014-itip-state-transfer-and-sequence.md)。DR の後に `SEQUENCE` を 1 つ余分に上げる。[ADR-0044](0044-disaster-recovery-and-calendar-side-effects.md)）は、RFC の範囲の中なので、この表に入れない。

### 表の外の入力

- CalDAV の `PUT`、ICS の取り込み、iMIP の受信で、表の外の構成要素（VTODO など）は、CalDAV では `CALDAV:supported-calendar-component` の前提の違反で拒否する。取り込みでは、その構成要素を飛ばし、飛ばした件数を利用者に示す。
- 知らないプロパティ（`X-` で始まるものを含む）は、予定オブジェクトに原文で残し、書き出しで返す（往復で失わない）。ただし 1 つの予定オブジェクトで 32 KiB まで。
- 本システムの独自のプロパティは `X-<BRAND>-` で始める（リポジトリ共通の ADR-0006）。

### 他の案を選ばなかった理由

- **2（全部を実装）**：対応するクライアントのない拡張に時間を使い、主な論点の検証が遅れる。使われない機能は試験もされず、壊れたまま残る。
- **3（その都度足す）**：クライアントごとの例外の処理が増え、標準の意味と食い違う振る舞いが入る。

## Consequences

- 良くなること：
  - 実装と試験の範囲が決まり、エージェントが RFC の全部や独自の拡張に流れない。
  - 表の外を明示して拒否するので、クライアントが黙って情報を失わない。
- 引き受けるコスト：
  - `COUNTER`（時刻の提案）を使う外部の参加者は、提案を主催者に知らせる以上のことができない。
  - タスク（VTODO）を CalDAV で同期するクライアントの利用者は、MVP ではタスクを本システムに置けない。
  - 範囲を広げるたびに、この ADR を置き換える ADR が要る。

## Confirmation

- 相互運用の試験：対象のクライアントごとに、発見、一覧、作成、変更、例外、「これ以降」、削除、同期のトークン、招待と返事の場面を、CI（記録した要求の再生）と、リリースの前の手動の確認で通す（[quality.md](../quality.md)）。
- 表駆動テスト：上の表の「持たないもの」を受けたときの応答（拒否のエラー、飛ばした件数）を確かめる。
- 性質ベーステスト：任意の予定オブジェクトを iCalendar に書き出して読み戻すと、同じ予定オブジェクトになる（知らないプロパティを含む）。

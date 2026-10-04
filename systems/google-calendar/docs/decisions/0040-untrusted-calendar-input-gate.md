---
status: accepted
date: 2026-10-04
---

# ADR-0040: 外から来る iCalendar・メール・URL は、経路ごとの上限の表を解析の前に当て、時間とメモリーを切った隔離の worker thread で `packages/ical` を動かし、正規化した形だけを `packages/writer` に渡す。外へ出す iCalendar とメールのヘッダーは、利用者の文字を必ずエスケープして作る

## Context

本システムは、外から多くの iCalendar を受ける。

| 経路 | 入力 | 同期か |
| --- | --- | --- |
| CalDAV の `PUT` | 予定オブジェクト 1 つの VCALENDAR | 同期（クライアントが待つ） |
| ICS の取り込み | 利用者が上げたファイル | 非同期 |
| ICS の購読 | 外部の URL から取った VCALENDAR | 非同期（`ics-fetcher`） |
| iMIP の受信 | SES で受けた MIME のメール | 非同期（`imip-inbound`） |
| 公開 API | JSON（予定の項目、RRULE の行） | 同期 |

iCalendar の解析は、壊れやすい入力の典型である。行の折り返しの繰り返し、巨大な値、深い入れ子、不正な文字コード、展開の爆発（大量の RDATE、終わりのない規則）、VTIMEZONE の大量の遷移が、CPU とメモリーを使い切りうる（[quality.md](../quality.md) のリスク 8）。Node.js のイベントループで重い解析を走らせると、同じタスクの他の要求が止まる。

外へ出す側にも危険がある。利用者の書いたタイトル・場所・名前に改行が入ると、iCalendar のプロパティや、メールのヘッダーを差し込めてしまう（`SUMMARY:x\r\nATTENDEE:mailto:...`、`CN` の改行）。

各領域は、それぞれの上限を決めている（[events-and-recurrence.md](../architecture/events-and-recurrence.md) の 3.5・4.6 節、[invitations-and-itip.md](../architecture/invitations-and-itip.md) の 11.3 節、[time-zones-and-holidays.md](../architecture/time-zones-and-holidays.md) の 12 節、[ADR-0007](0007-interop-standards-scope.md)）。ばらばらに確かめると、経路ごとに抜けが出る。

## Options

1. **経路ごとの上限の表を 1 つ持ち、解析の前に当てる。解析は時間とメモリーを切った隔離の worker thread で行い、正規化した形だけを `packages/writer` へ渡す**
2. 解析の中で上限を確かめる（メインのスレッド）
3. 外からの解析を、別のサービス（DB の権限を持たない）に分ける

## Decision

1 を採用する。非同期の経路（ICS の購読・iMIP の受信）は、もともと DB に直接書かないサービス（`ics-fetcher`、`imip-inbound`）で解析し、SQS で `packages/writer` を使う Worker に渡す形にして、3 の利点も取る。

### 上限の表（`packages/ingress-limits`）

| 項目 | CalDAV の `PUT` | ICS の取り込み | ICS の購読 | iMIP の受信 |
| --- | --- | --- | --- | --- |
| 本文の大きさ | 1 MiB（`CALDAV:max-resource-size`。`PROPFIND`・`REPORT` の XML の本文は 2 MiB） | 10 MiB | 10 MiB（[architecture/README.md](../architecture/README.md) の 6 節） | メール 10 MiB、`text/calendar` 1 MiB（[invitations-and-itip.md](../architecture/invitations-and-itip.md) の 11.3 節） |
| VEVENT の数 | 1,001（マスター＋上書き 1,000） | 50,000 | 50,000 | 1,000 |
| 折り返しを戻した 1 行 | 128 KiB | 同じ | 同じ | 同じ |
| 1 つの構成要素のプロパティ | 500 | 同じ | 同じ | 同じ |
| 1 つのプロパティの引数 | 32 | 同じ | 同じ | 同じ |
| 入れ子の深さ | 3（VCALENDAR > VEVENT > VALARM、VTIMEZONE > STANDARD） | 同じ | 同じ | 同じ |
| VTIMEZONE | 1 つ 64 KiB、下位 200 個、RDATE 1,000（[time-zones-and-holidays.md](../architecture/time-zones-and-holidays.md) の 12 節） | 同じ | 同じ | 同じ |
| 知らないプロパティ | 1 つの予定オブジェクトで 32 KiB（[ADR-0007](0007-interop-standards-scope.md)） | 同じ | 同じ | 同じ |
| 展開の量 | [events-and-recurrence.md](../architecture/events-and-recurrence.md) の 4.6 節の計算の上限 | 同じ | 同じ | 同じ |
| 解析の時間 | 1 つ 200ms | ファイル 10 秒 | 取得 1 回 10 秒 | メール 2 秒 |
| 解析のメモリー | worker 1 つ 64 MiB | 256 MiB | 256 MiB | 128 MiB |
| 文字コード | UTF-8 だけ（BOM は外す）。不正な列は拒否 | UTF-8。不正な列は置き換えて件数を示す | 同左 | MIME の `charset` を UTF-8 に直す。直せなければ拒否 |

- 値は本システムの既定で、変えるときはこの表と各領域の文書を同じ PR で直す。

> 2026-10-04 の注記：起票の時は CalDAV の `PUT` の本文を 2 MiB としたが、[sync-and-caldav.md](../architecture/sync-and-caldav.md) が出す `CALDAV:max-resource-size` は 1 MiB である。統合の工程で 1 MiB に揃え、2 MiB は XML の要求の本文（と ALB の WAF の本文の上限）にした。
- 大きさは、本文を読みながら数える（全部を読んでから比べない）。HTTP の `Content-Length` だけを信じない。

### 隔離の解析

- 各サービスは、`packages/ical` を Node.js の worker thread のプールで動かす。worker は `resourceLimits`（ヒープの上限）と、親のタイマーでの打ち切り（上の表の時間）を持つ。打ち切った worker は捨てて作り直す。
- worker は DB・ネットワーク・ファイルに触れない。入力は本文のバイト列、出力は正規化した JSON（予定オブジェクトの形、捨てたものの件数、理由のコード）である。
- 正規化の後に、[ADR-0011](0011-inbound-recurrence-normalization.md)（対応しない繰り返し）と [ADR-0013](0013-external-timezone-definitions.md)（外から来た TZID）を当て、`packages/writer` の検証を通して書く。
- CalDAV の `PUT` の拒否は、RFC 4791 の前提の違反（`CALDAV:max-resource-size`、`CALDAV:valid-calendar-data`）で返す。

### 外へ出すもの

- iCalendar の書き出しは `packages/ical` の書き出しだけで行い、文字の値は RFC 5545 の 3.3.11 節のエスケープ（`\\`・`\;`・`\,`・`\n`）を必ず当てる。引数の値は、`"` と制御文字を落としてから引用する（RFC 6868 の `^n` などは使わない）。
- メールのヘッダー（From の表示名、件名）は、RFC 2047 の形にしてから組み立て、CR・LF を落とす。表示名・件名を文字列の連結で作らない。
- メールの本文の HTML は、テンプレートの自動のエスケープだけで作り、利用者の文字を HTML として差し込まない。

### URL を取りに行く入力

- ICS の購読の URL、Webhook の宛先、Web Push の `endpoint` は、どれも利用者が決める宛先である。名前解決の後の IP を確かめ（私的なアドレス、リンクローカル、メタデータのアドレスを拒否）、リダイレクトは 3 回まで・毎回同じ検査をし、egress の専用の経路だけから出す（[infrastructure.md](../architecture/infrastructure.md) の 2.3 節）。
- Web Push の `endpoint` は、加えて、ブラウザの配信のサービスのホスト名の許可リストに限る（reminders-and-notifications の領域）。

### 他の案を選ばなかった理由

- **2（メインのスレッド）**：1 つの重い入力で、同じタスクの CalDAV の要求がすべて止まる。上限の抜けが、そのまま停止になる。
- **3（別のサービス）**：CalDAV の `PUT` は同期で、応答に解析の結果（ETag、拒否の理由）が要る。往復を足すと書き込みの p99（NFR-001）を使う。非同期の経路は、すでにこの形である。

## Consequences

- 良くなること：
  - 上限が 1 つの表にあり、経路ごとの抜けを表駆動テストで見つけられる。
  - 重い入力が、解析の worker を 1 つ止めるだけで、サービスを止めない。
  - 外へ出す iCalendar とメールに、差し込みの余地がない。
- 引き受けるコスト：
  - worker thread の受け渡しの分、CalDAV の `PUT` が 1〜2ms 遅くなる見込み（**未検証**。E8 で測る）。
  - 上限を超える正当な入力（巨大な ICS の書き出し）は、分けて取り込んでもらう必要がある。

## Confirmation

- 表駆動テスト（DT-SEC-001）：上の表の各行・各経路で、上限ちょうどは通り、1 つ超えると決まった応答（CalDAV の前提の違反、取り込みの拒否、捨てて数える）になる。
- ファジング（[quality.md](../quality.md) の 2.2.1 節 I）：`packages/ical` に壊れた入力を与え、worker の打ち切り以外で親のプロセスが止まらない。夜間に 100 万件。
- 性質ベーステスト（PROP-SEC-001）：任意の文字列（改行・`;`・`,`・`:`・制御文字を含む）をタイトル・場所・名前に入れて書き出した iCalendar を読み戻すと、プロパティの数と名前が変わらず、値が元に戻る。
- 性質ベーステスト（PROP-SEC-002）：任意の表示名・件名で作ったメールのヘッダーに、CR・LF が入らない。
- lint：`packages/ical` の外で iCalendar の文字列を連結して作るコード、メールのヘッダーを文字列の連結で作るコードを禁止する。

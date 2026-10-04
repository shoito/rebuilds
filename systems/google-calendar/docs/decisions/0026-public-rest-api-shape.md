---
status: accepted
date: 2026-10-04
---

# ADR-0026: 公開の REST API は本家の API の振る舞いに寄せた JSON で `/v1` に出し、自社の画面も同じものを使う。予定オブジェクトを単位に、繰り返しは RFC 5545 の行、回は壁時計の `recurrence_id` の ID で表す。`syncToken` は予定オブジェクトの単位で絞りと一緒に使えない。書き込みは `If-Match` と `Idempotency-Key` を受ける

## Context

[architecture/README.md](../architecture/README.md) の 4 節は、公開 API を REST と JSON にし、形を本家の API の振る舞いに寄せ、名前を独自にすると決めた。[ADR-0007](0007-interop-standards-scope.md) は JSCalendar（RFC 8984）を公開 API の形にしないと決めた。[ADR-0005](0005-change-log-and-sync-tokens.md) は、トークンが予定オブジェクトの単位で差分を返し、回の一覧はトークンを持たない範囲の問い合わせにすると決めた。

決めることは次である。

- 予定の JSON の形、時刻の 4 つの種類（[ADR-0002](0002-time-representation.md)）の表し方。
- 回の識別子。UTC で作ると tzdb の更新で変わる。
- 差分の同期と、回の展開・範囲の絞りの組み合わせ。
- 書き込みの衝突と再送。社内のシステム（勤怠、予約）が API を自動で呼ぶ。
- 参加者の写しの共有の項目への書き込み（[ADR-0006](0006-organizer-and-attendee-copies.md)）。

本家の API は、`recurrence` に RRULE などの行を持ち、繰り返しでは `start.timeZone` を必須にし、回を `recurringEventId` と `originalStartTime` で特定する。差分の同期は `syncToken` で、条件は最初と同じにし（違えば 400）、410 で全件を取り直させる（[Events resource](https://developers.google.com/workspace/calendar/api/v3/reference/events)、[Synchronize resources efficiently](https://developers.google.com/workspace/calendar/api/guides/sync)、2026-10-04 に確認）。本家の回の ID の作り方、`maxResults` と `sendUpdates` の既定は、確かめていない（未検証）。

## Options

API の形：

1. **本家の API の振る舞いに寄せた REST と JSON。自社の画面も同じ API を使う**
2. JSCalendar（RFC 8984）の形
3. GraphQL

回の ID：

- a. **`<eventId>_<recurrence_id の壁時計の時刻>`**
- b. `<eventId>_<UTC の開始>`
- c. 回ごとに乱数の ID を振って表に持つ

## Decision

1 と a を採用する。詳細は [api-and-push.md](../architecture/api-and-push.md) の 4 節。

- 入口は `https://api.<brand>.<domain>/v1`。JSON、camelCase、RFC 3339。版は URL で、壊す変更は `/v2`。古い項目は告知から 12 か月で消す。
- 予定は予定オブジェクトを単位にする。時刻は `zoned`（`dateTime`＋`timeZone`）、`utc`（`Z`）、`floating`（オフセットなしと `floating: true`）、`date`（`date`）。`timeZone` があれば入力のオフセットを捨てて壁時計の時刻を使う。繰り返しは `timeZone` を必須にする。応答に `tzdataVersion` を付ける。
- `recurrence` は RFC 5545 の行の配列（DTSTART・DTEND を含めない）。
- `redact()` が `BUSY` にした予定（[ADR-0021](0021-effective-role-and-redact-table.md)）は、見る人ごとの不透明な ID と時刻と状態だけを返し、`redacted: true` を付ける。
- 回の ID は `<eventId>_<YYYYMMDDTHHMMSS>`（終日は `<YYYYMMDD>`）。回の応答は `recurringEventId` と `originalStartTime` を持つ。「これ以降」は `scope=thisAndFollowing`。
- 一覧：`singleEvents=true` は回に展開し、`timeMin`・`timeMax` を必須（差は 366 日まで）にする。`maxResults` は既定 250・最大 2,500。
- 差分：`syncToken` は予定オブジェクトの単位。`singleEvents=true`・`timeMin`・`timeMax`・`orderBy`・`q` と一緒に使えば 400。410 で取り直し。1 ページ 1,000 件。画面のために、50 のカレンダーのトークンを束ねる `POST /v1/sync` を持つ。
- 書き込み：`If-Match`（412）、`POST` の `Idempotency-Key`（24 時間）、`sendUpdates`（`all` が既定・`externalOnly`・`none`。本システムの中の写しはどれでも作る）。`PATCH` は JSON Merge Patch。
- 参加者の写しの共有の項目は、`guestsCanModify` が偽なら 403、真なら主催者への依頼（`X-MODIFY`）にして 202。
- 書き込みの直後の読み出しのため、`X-Read-After` を返して受ける。
- エラーは `{error: {code, status, reason, message}}`。404 は見てはいけないものと存在しないものを区別しない。

### 他の案を選ばなかった理由

- **2（JSCalendar）**：[ADR-0007](0007-interop-standards-scope.md) で採らなかった。社内のシステムの多くは本家の API の形の連携の経験を持つ。
- **3（GraphQL）**：カレンダーの問い合わせは範囲と差分が中心で、入れ子の問い合わせの利点が小さい。Webhook と差分の同期の形が REST に合う。
- **b（UTC の開始）**：tzdb の更新で回の ID が変わり、外部のシステムが持つ回の参照が切れる。
- **c（乱数の ID）**：終わりのない系列の回に ID を振れない。展開の索引の範囲の外の回を表せない。

## Consequences

- 良くなること：
  - 本家の API に慣れた連携の作り手が、形を読み替えるだけで使える。
  - 回の ID が tzdb の更新で変わらない。
  - 差分の同期が、CalDAV・Webhook と同じ単位と同じ規則になる。
  - 自動の連携が、衝突と再送を安全に扱える。
- 引き受けるコスト：
  - 本家の SDK をそのまま使えない（[リポジトリ共通の ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。公式の SDK を OpenAPI から生成する。
  - 回の差分を求める利用者は、予定オブジェクトの差分を受けて自分で展開するか、範囲の問い合わせを使う。
  - `sendUpdates` の既定を `all` にしたので、試験の連携が外部へ招待を送りうる。文書で注意を出す。

## Confirmation

- 表駆動テスト：DT-API-002（差分の引数）、DT-API-003（参加者の写しへの書き込み）。
- 性質ベーステスト：PROP-API-001（API・CalDAV・画面の回の一致）、PROP-API-002（冪等）、PROP-API-003（見え方）、PROP-SYNC-001（差分と全件）。
- 契約のテスト：OpenAPI の差分の検査で、壊す変更を CI で失敗させる。

---
status: accepted
date: 2026-10-04
---

# ADR-0024: CalDAV の `PUT` は、主催者の写しなら暗黙のスケジュールで配り、参加者の写しなら旧と新の差を取って自分の項目だけを受ける。`SCHEDULE-AGENT=CLIENT` は外部の参加者にだけ従う。参加者の写しに `Schedule-Tag` を出し、受信箱・送信箱は空にする

## Context

[ADR-0006](0006-organizer-and-attendee-copies.md) は、主催者の写しを正にし、参加者の写しの共有の項目は主催者からのメッセージでだけ変え、参加者の写しへの共有の項目の書き込みを 403（CalDAV では `CALDAV:allowed-attendee-scheduling-object-change`）で拒むと決めた。[ADR-0007](0007-interop-standards-scope.md) は、RFC 6638 のサーバーの暗黙のスケジュールを持ち、受信箱・送信箱を最小限にすると決めた。

CalDAV のクライアントは、予定を 1 つの iCalendar の本文として `PUT` する。次が問題になる。

- 参加者の写しへの `PUT` は、出欠やアラームの変更でも本文の全体を送る。どこが変わったかをサーバーが求める必要がある。
- クライアントが `SEQUENCE` を自分で上げたり上げなかったりする。
- RFC 6638 の `SCHEDULE-AGENT=CLIENT` は「この参加者への配送はクライアントが行う」を意味する。本システムの中の参加者の写しを作らないと、ADR-0006 の写しの整合が崩れる。
- 主催者の変更が届いた直後に、参加者のクライアントが古い本文で出欠を `PUT` すると、ETag の不一致で 412 になり、出欠の変更が通りにくい。RFC 6638 の 3.2.10 節の `Schedule-Tag` はこれを避けるためにある。

本家は、招待を受信箱を通さず予定のコレクションへ直接入れる（[CalDAV API developer's guide](https://developers.google.com/workspace/calendar/caldav/v2/guide)、2026-10-04 に確認）。`Schedule-Tag` と `SCHEDULE-AGENT` の扱いは公開の資料にない（未検証）。

## Options

参加者の写しへの `PUT`：

1. **旧と新の VEVENT の差を取り、自分の項目（自分の `PARTSTAT`、VALARM、`TRANSP`、色、自分の出欠の上書き、EXDATE の追加）だけなら受け、他が変われば全体を拒む**
2. 自分の項目だけを取り出して当て、他の変更は黙って捨てる
3. `guestsCanModify` なら共有の項目も受けて主催者へ依頼する

`SCHEDULE-AGENT=CLIENT`：

- a. **外部の参加者にだけ従う。本システムの中の参加者には常にサーバーが配る**
- b. すべての参加者に従う
- c. すべて無視する

## Decision

1 と a を採用する。詳細は [sync-and-caldav.md](../architecture/sync-and-caldav.md) の 7 節。

- **主催者の写しへの `PUT`**：ORGANIZER が要求した人のアドレスなら主催者の写しとして書き、[invitations-and-itip.md](../architecture/invitations-and-itip.md) の規則で `SEQUENCE` を決め、内部の iTIP と iMIP を outbox に書く。クライアントの `SEQUENCE` は使わない。各 ATTENDEE に `SCHEDULE-STATUS` を付けて保存し、保存した形が変わるので ETag を返さない（[ADR-0023](0023-caldav-resource-model-and-conditional-writes.md)）。
- **参加者の写しへの `PUT`**：差の表（DT-DAV-002）で判定する。EXDATE の追加はその回の辞退の `REPLY` にする（RFC 6638 の 3.2.2.1 節）。それ以外の変更があれば全体を 403 で拒む。`guestsCanModify` でも CalDAV からは共有の項目を受けない。
- **`Schedule-Tag`**：参加者の写しに `"<organizer_version>"` を出す。自分の項目の変更では変わらない。`If-Schedule-Tag-Match` を受ける。
- **`SCHEDULE-AGENT`**：本システムの中の参加者には `CLIENT`・`NONE` を無視して写しを作り、`SCHEDULE-STATUS:2.3` を付ける。外部の参加者には従い、iMIP を送らない（`delivery_status = client_managed`）。
- **`Schedule-Reply: F`**：参加者の写しの `DELETE` と出欠の変更で `REPLY` を送らない指示として受ける。
- **受信箱・送信箱**：常に空。送信箱への `POST` は 403。

### 他の案を選ばなかった理由

- **2（黙って捨てる）**：利用者が OS のカレンダーで時刻を変えたつもりでも、何も起きず、エラーも出ない。次の同期で元に戻り、利用者は理由がわからない。
- **3（CalDAV から依頼）**：依頼は主催者のバージョンと衝突しうる（[invitations-and-itip.md](../architecture/invitations-and-itip.md) の 8.2 節）。衝突を示す画面が OS のカレンダーにない。
- **b（すべてに従う）**：本システムの中の参加者の写しができず、照合のジョブが送り直し、主催者のクライアントの送ったメールと 2 重になる。
- **c（すべて無視）**：主催者のクライアントが自分で外部へメールを送る設定のとき、外部の参加者に招待が 2 通届く。

## Consequences

- 良くなること：
  - OS のカレンダーで、参加者は出欠とアラームを変えられ、共有の項目を壊せない。
  - 本システムの中の参加者の写しは、クライアントの設定に関係なく作られる。
  - 主催者の更新の直後でも、出欠の変更が `Schedule-Tag` で通る。
- 引き受けるコスト：
  - 差を取る処理を CalDAV のサービスに持つ。VEVENT の項目の比べの規則を `packages/ical` に置き、試験する。
  - `SCHEDULE-AGENT=CLIENT` を本システムの中の参加者に当てないことと、EXDATE を辞退に変えることは、RFC 6638 と違う（[ADR-0007](0007-interop-standards-scope.md) の「RFC との意図した違い」の D4・D6）。
  - `guestsCanModify` の参加者も、OS のカレンダーからは共有の項目を変えられない（画面か API で変える）。
  - `Schedule-Tag` を使わないクライアントは、主催者の更新の直後の出欠の変更で 412 になり、取り直してから送る。

## Confirmation

- 表駆動テスト：DT-DAV-002（参加者の写しへの `PUT`）、DT-DAV-003（`SCHEDULE-AGENT`）。
- 性質ベーステスト：PROP-DAV-003（参加者の写しへの任意の `PUT` で共有の項目が変わらない）。[invitations-and-itip.md](../architecture/invitations-and-itip.md) の PROP-ITIP-001 の枠に、CalDAV からの書き込みを混ぜる。
- 相互運用の試験：対象のクライアントで、主催者としての招待・変更・取り消し、参加者としての出欠・1 回分の辞退・アラームの変更、`Schedule-Tag` の振る舞い。

---
status: accepted
date: 2026-09-27
---

# ADR-0035: カレンダーの連携は、カレンダーの画面のアドオン・アドインと、OAuth で予定を書く入口の両方で行い、変更は通知と毎日の差分で取り込む

## Context

intent.md の MVP は「Google カレンダーと Microsoft 365 の予定に、会議の URL を付ける」を求める。利用者は、カレンダーの画面で予定を作ることも、本システムの画面で会議を作ることもある。

確かめたこと（いずれも 2026-09-27 に確認）：

- Google：Workspace のアドオンで会議の方式を宣言すると、利用者が予定を作るときに選べ、`onCreateFunction` が会議の情報（`ConferenceData`）を返す。予定の変更と削除を検知して、会議の側を合わせられる（[Calendar conferencing overview](https://developers.google.com/workspace/add-ons/calendar/conferencing/overview)）。Calendar API の `events.watch` で変更の通知を受けられる（[Push notifications](https://developers.google.com/workspace/calendar/api/guides/push)）。API から第三者が `conferenceData` の入口を直接書けるかは文書に書かれていない（**未検証**。E6 の `google-calendar-oauth-write` で確かめる）。
- Microsoft：Outlook の online-meeting のアドインは、web・Windows・Mac・モバイルで、予定の本文に会議の情報を足す。管理者が配ったものだけが作成の画面に出る。1 分以内に本文を更新する。Join のボタンは Marketplace での公開と登録が要る（[online-meeting add-in](https://learn.microsoft.com/en-us/office/dev/add-ins/outlook/online-meeting)）。Graph の予定の `onlineMeetingProvider` は Microsoft の方式だけで、第三者は使えない。`transactionId` で作成の重複を防げる（[event](https://learn.microsoft.com/en-us/graph/api/resources/event?view=graph-rest-1.0)）。予定の変更の通知の購読は最長 10,080 分（[subscription](https://learn.microsoft.com/en-us/graph/api/resources/subscription?view=graph-rest-1.0)）。

## Options

1. **カレンダーの画面のアドオン・アドインと、本システムの画面から OAuth で予定を書く入口の両方。変更は通知と毎日の差分で取り込む**
2. **アドオン・アドインだけ**
3. **OAuth で書く入口だけ**
4. **iCalendar のファイルとメールだけ（カレンダーの API を使わない）**

## Decision

1 を採用する。詳細は [scheduling-and-calendar.md](../architecture/scheduling-and-calendar.md) の 6 節。

- **カレンダーの画面の入口**：Google Workspace のアドオン（会議の方式）と、Outlook の online-meeting のアドイン（組織の管理者が配る）。どちらも本システムの OAuth の同意で API を呼び、会議を作る。予定の ID から作った `idempotency_key` で冪等にする。
- **本システムの画面の入口**：利用者の同意（Google は `calendar.events`、Microsoft は `Calendars.ReadWrite` と `offline_access`）で予定を書く。会議の情報は、本文と場所に、決まった区切りの中に書く。Microsoft は `transactionId` を使う。
- **取り込み**：Google の push の通知と Graph の変更の通知を受け、中身は差分（`syncToken`・`delta`）で取りに行く。通知は「変わった」ことだけを信じる。毎日 1 回、全接続の差分を取り込んで取りこぼしを直す。Graph の購読は 3 日ごとに延ばす。
- **取り込む範囲**：本システムが作った予定だけ。他の予定の中身を保存しない。
- **衝突**：カレンダーの側を正とする。本システムの側の変更は書き戻し、戻ってきた通知は `etag`・`changeKey` で無視する。
- **守り**：どちらの入口から作った会議にも、組織の既定の設定と `assertJoinGuard`（[ADR-0031](0031-waiting-room-and-passcode-rules.md)）を当てる。
- 2 を採らない理由：本システムの画面から作った会議を、利用者のカレンダーに載せられない。Outlook のアドインは管理者が配る必要があり、個人の利用者は使えない。
- 3 を採らない理由：カレンダーの画面で予定を作る、最も多い使い方に合わない。
- 4 を採らない理由：カレンダーでの時刻の変更が、本システムに伝わらない。予定の時刻が本システムで古いままになる。

## Consequences

- 良くなること：
  - どちらの画面から作っても、カレンダーと本システムの会議が合う。
  - 通知が落ちても、毎日の差分で 24 時間以内に合う。
- 引き受けるコスト：
  - Google のアドオン、Outlook のアドイン、2 つの API、2 つの通知の方式を持つ。相手の仕様の変更に追従する必要がある。
  - 利用者のリフレッシュトークンを預かる。暗号化と取り消しの扱いが要る。
  - Google の確認の審査（利用者のデータに触れる範囲を使う公開のアプリに要る。[Calendar API の認可](https://developers.google.com/workspace/calendar/api/auth)）と、Outlook の Join のボタンのための Microsoft Marketplace の公開と登録が要る（[online-meeting add-in](https://learn.microsoft.com/en-us/office/dev/add-ins/outlook/online-meeting)、いずれも 2026-09-27 に確認）。審査の期間は E6 の `google-calendar-oauth-write` と E12 の `outlook-addin-marketplace` で見込む。
  - Graph の予定では、Teams のような「会議の予定」としては表示されない（本文の区切りで示す）。

## Confirmation

- 性質ベーステスト：任意の順序・重複・取りこぼしの通知の後、毎日の差分を 1 回取り込めば、会議の時刻がカレンダーと一致する（PROP-SCH-003）。
- 性質ベーステスト：カレンダーの入口から作った会議も、待合室かパスコードを持つ（PROP-SCH-004）。
- 結合試験：Google と Microsoft の試験のテナントで、作成・時刻の変更・取り消し・トークンの取り消しを確かめる。
- レビュー：取り込みの処理が、本システムが作った予定以外の中身を保存していない。

# Scheduling and Calendar: Zoom

予定の会議、繰り返しの会議、個人の会議の ID（PMI）、時刻とタイムゾーン、Google カレンダーと Microsoft 365 との連携の設計。

前提となる決定は、会議の番号と URL（[ADR-0006](../decisions/0006-meeting-id-and-join-url.md)）、会議の行（`meetings`）と開催（`meeting_instances`）の分け方（[signaling-and-meetings.md](signaling-and-meetings.md) の 5.1 節）、待合室かパスコードの不変条件（[ADR-0031](../decisions/0031-waiting-room-and-passcode-rules.md)）。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0034](../decisions/0034-scheduled-recurring-meetings-and-pmi.md) | 予定の会議は、現地の時刻と IANA のタイムゾーンで持ち、繰り返しは RFC 5545 の RRULE の一部で表す。回ごとの行は、例外（変更・取り消し）のときだけ作る。繰り返しのすべての回は同じ会議の番号を使う。PMI は 10 桁で、CSPRNG で割り当て、利用者に選ばせない。PMI の会議では、組織の外の人は待合室を省けない |
| [0035](../decisions/0035-calendar-integration-add-ons-and-oauth.md) | カレンダーの連携は 2 つの入口を持つ。カレンダーの画面から作る入口は、Google Workspace のアドオン（会議の方式）と Outlook の online-meeting のアドイン。本システムの画面から作る入口は、利用者の OAuth の同意で Google Calendar API と Microsoft Graph に予定を書く。予定の変更は、Google の push の通知と Graph の変更の通知で受け、毎日の差分の取り込みで補う |

## 1. 目的と範囲

- 扱う：予定の会議の作成・更新・取り消し、繰り返しの規則、回ごとの例外、時刻の決まっていない繰り返し、PMI、代わりの主催者、招待の一覧、招待のメールと iCalendar、タイムゾーン、Google カレンダーと Microsoft 365 の連携（OAuth、アドオン、変更の通知）。
- 扱わない：すぐの会議の作成と参加（[signaling-and-meetings.md](signaling-and-meetings.md)）、待合室とパスコードの規則（[meeting-security.md](meeting-security.md)）、組織の既定の設定と強制（[accounts-and-admin.md](accounts-and-admin.md)）、公開 API の形（[api-and-webhooks.md](api-and-webhooks.md)）、メールの送信事業者（[infrastructure.md](infrastructure.md)）。

## 2. 本家の形と外部の仕様（確かめたこと）

| 項目 | 内容 | この設計 |
| --- | --- | --- |
| 会議の ID の桁 | すぐの会議・予定の会議・繰り返しの会議は 11 桁、PMI は 10 桁（[FAQ about meeting and webinar IDs](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0065196)） | 同じ（ADR-0006、ADR-0034） |
| PMI | 個人に割り当てられ、繰り返し使える 10 桁の番号（[Using Personal Meeting ID (PMI)](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0066271)）。推測されやすいので、待合室とパスコードの両方を勧める大学の解説がある | 待合室を強める（ADR-0034） |
| 繰り返しの回数・期限、時刻の決まっていない繰り返しの有効期限 | 繰り返しは 60 回まで。それを超えるときは時刻の決まっていない繰り返しにする。繰り返しの会議の ID は、最後に開いてから 365 日で失効する（[Scheduling a recurring meeting](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0064248)） | 回数は 100 まで、期限は 2 年まで（本家より多く許す。業務の定例を 2 年分入れられるように）。時刻の決まっていない繰り返しは最後の開催から 365 日（本家と同じ） |
| Google のアドオン | Workspace のアドオンのマニフェストで会議の方式（conference solution）を宣言し、利用者が予定を作るときに選べる。`onCreateFunction` が会議の ID と参加の入口（video・phone など。1 つ以上）を持つ `ConferenceData` を返す。予定の変更と削除を検知して、会議の側を合わせられる（[Calendar conferencing overview](https://developers.google.com/workspace/add-ons/calendar/conferencing/overview)） | カレンダーの画面から作る入口（ADR-0035） |
| Google Calendar API の会議の情報 | `conferenceDataVersion=1` で会議の情報を作り・変えられる。API の説明の `conferenceSolution.key.type` には Google Meet などが並ぶ（[Create events](https://developers.google.com/workspace/calendar/api/guides/create-events)）。`conferenceSolution.key.type` には第三者の提供者の `addOn` もあるが、アドオンの外から API で `entryPoints` を直接書けるかは文書に書かれていない（[Events](https://developers.google.com/workspace/calendar/api/v3/reference/events)。**未検証**。E6 の `google-calendar-oauth-write` で確かめる） | API から書くときは、場所と説明に URL を入れる（ADR-0035） |
| Google の push の通知 | `events.watch` で HTTPS の受け口に通知を送る。`X-Goog-Channel-Token`（任意の文字列）、`X-Goog-Resource-State`（`sync`・`exists`・`not_exists`）。通知の中身は変わったことだけで、差分は取りに行く。チャンネルには期限があり、自動で延ばす方法はなく、期限の前に新しいチャンネルを張る（[Push notifications](https://developers.google.com/workspace/calendar/api/guides/push)）。期限の既定と最大の値は文書に書かれていない（**未検証**。E6 の `calendar-change-sync` で応答の `expiration` を記録する） | 6.3 節 |
| Outlook の online-meeting のアドイン | Outlook on the web・Windows（new と classic）・Mac・Android・iOS で動く（Microsoft 365 の契約）。予定の本文に会議の情報を足す。管理者が配ったアドインだけが、予定の作成の画面で Teams の切り替えの代わりに出る。1 分以内に本文を更新する。Join のボタンは、Microsoft Marketplace で公開し（業務用の内部のアドインは不可）、GitHub の issue で登録したアドインだけで、classic Outlook on Windows には出ない（[Create an Outlook add-in for an online-meeting provider](https://learn.microsoft.com/en-us/office/dev/add-ins/outlook/online-meeting)） | カレンダーの画面から作る入口（ADR-0035） |
| Graph の予定 | `onlineMeetingProvider` は `unknown`・`teamsForBusiness`・`skypeForBusiness`・`skypeForConsumer` だけ。`transactionId` で作成の再試行の重複を防げる。`originalStartTimeZone` を持つ（[event resource type](https://learn.microsoft.com/en-us/graph/api/resources/event?view=graph-rest-1.0)） | 第三者は `onlineMeeting` を使えないので、本文と場所に書く（ADR-0035） |
| Graph の変更の通知 | Outlook の予定の購読は最長 10,080 分（7 日弱）。中身付きの通知は 1,440 分。`clientState`（128 文字まで）で通知を確かめる（[subscription resource type](https://learn.microsoft.com/en-us/graph/api/resources/subscription?view=graph-rest-1.0)） | 6.3 節 |

いずれも 2026-09-27 に確認。

## 3. 会議の種類

ADR-0034。

| `type` | 会議の番号 | 開始の時刻 | 開催（`meeting_instances`） |
| --- | --- | --- | --- |
| `instant` | 11 桁 | 作ったとき | 1 回 |
| `scheduled` | 11 桁 | `start_local`＋`timezone` | 1 回（予定より前・後にも始められる） |
| `recurring` | 11 桁（全回で同じ） | RRULE の各回 | 回ごとに 1 回 |
| `recurring_no_fixed_time` | 11 桁 | なし | 何度でも（同時に 1 つ） |
| `pmi` | 10 桁（利用者ごと） | なし | 何度でも（同時に 1 つ） |

- どの種類でも、主催者は予定の時刻にかかわらず会議を始められる。予定の時刻は、カレンダーと招待のための情報である。
- 同じ会議の番号で、同時に動く開催は 1 つだけ（[signaling-and-meetings.md](signaling-and-meetings.md) の 5.1 節の部分一意の索引）。
- 取り消した会議の番号も、最後の開催（または予定の日）から 2 年は再び使わない（ADR-0006）。

## 4. 予定と繰り返し

### 4.1 作成の要求

```
POST /v1/meetings
{ "type": "recurring",
  "topic": "週次の定例",
  "start_local": "2026-10-06T10:00:00",
  "timezone": "Asia/Tokyo",
  "duration_min": 30,
  "recurrence": "FREQ=WEEKLY;BYDAY=TU;COUNT=20",
  "invitees": [ { "email": "sato@example.co.jp" }, { "email": "lee@partner.example" } ],
  "alternative_hosts": [ "u_01J9..." ],
  "settings": { "waiting_room": true, "passcode": "auto", "auto_recording": "none", "e2ee": false },
  "idempotency_key": "b3c9..." }

201
{ "meeting_id": "mtg_01J9...", "meeting_number": "84512093376",
  "join_url": "https://<brand>.<domain>/j/84512093376#k=Zk3...",
  "passcode": "482913",
  "next_occurrences": [ { "occurrence_id": "20261006T010000Z", "start": "2026-10-06T01:00:00Z" }, ... ],
  "ics_url": "https://<brand>.<domain>/v1/meetings/mtg_01J9.../ics" }
```

- 設定は、組織の強制の設定（[accounts-and-admin.md](accounts-and-admin.md) の 5 節）で解決してから、`assertJoinGuard` を通す（ADR-0031）。E2EE と `auto_recording: cloud` の組み合わせは 422（[ADR-0027](../decisions/0027-capture-consent-and-indicators.md)）。
- `idempotency_key` は 24 時間有効。同じ鍵と同じ本文なら同じ応答を返す。

### 4.2 繰り返しの規則

RFC 5545 の RRULE のうち、次だけを受ける。受けない項目は 422 `unsupported_recurrence`。

| 項目 | 受ける値 |
| --- | --- |
| `FREQ` | `DAILY`・`WEEKLY`・`MONTHLY` |
| `INTERVAL` | 1〜12 |
| `BYDAY` | `WEEKLY` で曜日の一覧。`MONTHLY` で `2TU`（第 2 火曜）・`-1FR`（最後の金曜） |
| `BYMONTHDAY` | `MONTHLY` で 1〜31。その月にない日（31 日など）の回は作らない（RFC 5545 の振る舞い） |
| `COUNT` | 1〜100 |
| `UNTIL` | 開始から 2 年以内。UTC の時刻で持つ |

- `COUNT` と `UNTIL` のどちらかは必須。無期限の繰り返しは `recurring_no_fixed_time` か PMI を使う。
- 回の ID（`occurrence_id`）は、その回の元の開始の時刻（UTC、`YYYYMMDDTHHMMSSZ`）。iCalendar の `RECURRENCE-ID` と同じ考え方で、回の時刻を変えても ID は変えない。

### 4.3 例外

- 回ごとの行（`meeting_occurrences`）は、例外のときだけ作る。
  - 変更：その回の開始・長さ・題名を変える（`status = modified`）。
  - 取り消し：その回をなくす（`status = canceled`）。
- 「この回以降を変える」は、元の会議の `UNTIL` を縮め、新しい繰り返しの会議を作る。会議の番号は引き継ぐ（同じ番号の 2 つの `meetings` の行が、期間を分けて持つ。部分一意の索引は `meetings` の番号ではなく「有効な期間」で見る）。これが複雑になるので、S1 では「この回だけ」と「すべての回」の 2 つに限る。「この回以降」は MVP の後（11 節）。

### 4.4 時刻とタイムゾーン

- 予定の時刻は、現地の時刻（`start_local`、秒まで、タイムゾーンなし）と IANA のタイムゾーン名（`timezone`）で持つ。UTC の時刻は、回ごとに計算して出す。
  - 理由：繰り返しの会議は「毎週火曜の 10 時（東京）」であり、UTC で持つと、夏時間のある地域の主催者の会議が 1 時間ずれる。日本には夏時間はないが、海外の拠点の主催者と、tzdata の変更に備える。
- 計算には、IANA の tzdata を持つライブラリ（Temporal の API。Node.js は 26 で Temporal を既定で有効にした（[Node.js 26.0.0](https://nodejs.org/en/blog/release/v26.0.0)、2026-05、2026-09-27 に確認）。Node.js 26 より前のバージョンで動かす間は polyfill を使う）を使う。tzdata のバージョンをサーバーで固定し、上げるときは次の 30 日の回の UTC の時刻が変わる会議を洗い出して、主催者に知らせる。
- 夏時間の切り替えで存在しない時刻（例：2:30）は、後ろへずらす（Temporal の `disambiguation: "compatible"`）。2 回ある時刻は、前の方を採る。
- 表示は、見る人の端末のタイムゾーンで行う。招待のメールには、主催者のタイムゾーンと、受け手のタイムゾーン（分かれば）を両方書く。
- 時刻の決まっていない会議（`recurring_no_fixed_time`・`pmi`）は時刻を持たない。

### 4.5 招待

- 招待のメールは Worker が送る。iCalendar（RFC 5545）を添える。`UID` は `meeting_id@<brand>.<domain>` で固定し、`SEQUENCE` を変更のたびに 1 つ上げる。取り消しは `METHOD:CANCEL`。
- 本文と `LOCATION` に参加の URL（参加の鍵つき）を、`DESCRIPTION` に会議の番号とパスコードを書く。参加の鍵はメールに残るので、漏れたときの防御は待合室に頼る（ADR-0006 の Consequences）。
- 招待の一覧（`meeting_invitees`）は、待合室を省く条件（「招待したアカウント」。[meeting-security.md](meeting-security.md) の 3.3 節）にも使う。

## 5. 個人の会議の ID（PMI）

ADR-0034。

- 利用者 1 人に 1 つ。初めて使うときに割り当てる。10 桁の数字で、先頭は 1〜9。CSPRNG から一様に選ぶ。11 桁の会議の番号とは桁が違うので重ならない。
- 利用者が番号を選ぶこと（電話番号や誕生日のような番号）は許さない。推測されやすくなるため。
- 利用者は PMI を作り直せる（新しい番号を割り当てる）。古い番号は 2 年は再び使わない。
- PMI の会議は、組織の設定にかかわらず、次を強める。
  - 待合室は常に有効（無効にできない）。
  - 待合室を省けるのは、主催者と同じ組織のログインした人と、共同主催者だけ。許可したドメインと招待では省かない（招待の一覧を持たない会議なので）。
  - パスコードは組織の規則のとおり。
- 組織の設定で、PMI の利用そのものを禁止できる（既定は許す）。
- PMI の ban は、PMI のすべての開催に効く（[meeting-security.md](meeting-security.md) の 6.1 節、30 日）。

## 6. カレンダーの連携

ADR-0035。

### 6.1 入口

| 入口 | Google | Microsoft 365 | 本システムが作るもの |
| --- | --- | --- | --- |
| カレンダーの画面で予定を作る | Workspace のアドオン（会議の方式）。利用者が「<Brand> の会議」を選ぶと、`onCreateFunction` が本システムの API を呼ぶ | Outlook の online-meeting のアドイン。管理者が配る。予定の作成の画面のボタンで、本文に会議の情報を足す | `scheduled` か `recurring` の会議 |
| 本システムの画面で予定を作る | 利用者の同意（OAuth）で、Calendar API に予定を書く | 利用者の同意（OAuth）で、Graph に予定を書く | 同上 |
| どちらも使わない | 招待のメールの iCalendar（4.5 節） | 同じ | 同上 |

- アドオンとアドインは、どちらも本システムの OAuth の同意（利用者のログイン）を要る。組織の SSO があれば、その SSO でログインする（[accounts-and-admin.md](accounts-and-admin.md)）。
- アドオン・アドインから作った会議にも、組織の既定の設定と `assertJoinGuard` を当てる（本題材の AGENTS.md）。

### 6.2 OAuth の範囲

| 相手 | 範囲 | 使い道 |
| --- | --- | --- |
| Google | `https://www.googleapis.com/auth/calendar.events`（予定の読み書き） | 予定を書く、`events.watch`、差分の取り込み |
| Microsoft | `Calendars.ReadWrite`（委任）、`offline_access` | 予定を書く、変更の通知の購読、差分の取り込み |

- 取り込むのは、本システムが作った予定（Google は `extendedProperties.private.<brand>_meeting_id`、Microsoft は拡張のプロパティか `transactionId`）だけにする。他の予定の中身を保存しない。
- リフレッシュトークンは KMS で守るデータの鍵で暗号化して、`calendar_connections` に置く。取り消されたら（`invalid_grant`）、接続を `revoked` にし、利用者に再接続を案内する。会議そのものは消さない。
- 利用者のデータに触れる範囲を使う公開のアプリには、Google の確認の審査が要る（[Calendar API の認可](https://developers.google.com/workspace/calendar/api/auth)、2026-09-27 に確認）。`calendar.events` が「機微な範囲」に分類されるかは文書のこの頁に書かれておらず**未検証**で、E6 の `google-calendar-oauth-write` の前に Google Cloud の同意の画面の設定で確かめる。

### 6.3 変更の取り込み

```
カレンダーで予定の時刻を変える
   │
   ├─ Google：events.watch の通知（X-Goog-Resource-State: exists）─▶ Calendar Sync（Worker）
   │                                                                    │ syncToken で差分を取る
   └─ Microsoft：Graph の変更の通知（clientState を確かめる）─────────▶ │ delta で差分を取る
                                                                        ▼
                                     本システムの予定の会議を更新（時刻・題名・取り消し）
                                     outbox → 招待の一覧の更新、Webhook（meeting.updated）
```

- 通知は「変わった」ことだけを信じ、中身は必ず API で取りに行く（通知を偽っても、中身は変えられない）。
- Google のチャンネルは期限の前に張り直す。期限の値は受けた応答の `expiration` を使う。Graph の購読は 3 日ごとに延ばす（最長 7 日弱の半分より短く）。
- 通知を取りこぼしても合うように、毎日 1 回、接続ごとに差分（`syncToken`・`delta`）を取り込む。
- 本システムの側の変更（本システムの画面で時刻を変えた）は、カレンダーの予定に書き戻す。同じ変更が通知で戻ってきたら、`etag`・`changeKey` を比べて無視する（往復の繰り返しを防ぐ）。
- 衝突（両方で同時に変えた）：カレンダーの側を正とする。予定の時刻は、カレンダーが利用者にとっての正本であるため。
- カレンダーで予定を消したら、本システムの会議を `canceled` にする（行は残す。番号は 2 年は再び使わない）。会議が開催中なら、会議は終わらせない。

### 6.4 本文に書く形

```
───────── <Brand> の会議 ─────────
参加：https://<brand>.<domain>/j/84512093376#k=Zk3...
会議の番号：845 1209 3376
パスコード：482913
（この部分は <Brand> が管理しています。消すと会議の情報が失われます）
────────────────────────────
```

- Outlook のアドインは、本文の既存の内容の後ろに足す。Microsoft の文書のとおり、会議の情報の部分を消すと online-meeting の機能が失われる。Graph で本文を書き換えるときも、この部分を保つ。
- 電話からの参加の番号（MVP の後。[telephony.md](telephony.md)）は、この部分に足す。

## 7. 障害のときの振る舞い

| 障害 | 起きること | 対処 |
| --- | --- | --- |
| リフレッシュトークンの取り消し | 予定を書けない・取り込めない | 接続を `revoked`。利用者に知らせる。会議は残る |
| push・変更の通知の取りこぼし | 時刻の変更が遅れる | 毎日の差分の取り込みで追いつく。最大 24 時間の遅れ |
| Google・Microsoft の API の `429`・`5xx` | 書き込みが遅れる | 指数の待ちで再試行（最大 24 時間）。本システムの会議は先に作る |
| アドオン・アドインの呼び出しの時間切れ（Outlook は 1 分） | 予定に会議の情報が入らない | 会議の作成は `idempotency_key`（予定の ID から作る）で冪等にし、利用者の再試行で同じ会議を返す |
| tzdata の更新で回の時刻が変わる | 招待の時刻とずれる | 4.4 節。影響を受ける会議を洗い出して知らせる |
| 同じ予定から会議が 2 つできる | 番号が 2 つになる | `calendar_links` に `(provider, calendar_event_id)` の一意の索引 |

## 8. セキュリティとプライバシー

- カレンダーの予定の中身（他の予定、参加者の一覧）を保存しない。本システムが作った予定の、時刻・題名・招待の一覧だけを取り込む。
- 通知の受け口は、Google は `X-Goog-Channel-Token`、Microsoft は `clientState` に、接続ごとの 32 バイトの乱数を入れて確かめる。確かめられない通知は捨てる。
- リフレッシュトークンをログに出さない。
- アドオン・アドインから本システムの API を呼ぶときは、利用者の OAuth のアクセストークン（本システムが発行する。[api-and-webhooks.md](api-and-webhooks.md) の 4 節）を使う。アドオンの側に長期の秘密を置かない。
- 招待のメールに参加の鍵とパスコードが入ることを、主催者の画面で示す。

## 9. テスト

### 9.1 性質ベーステスト

- **PROP-SCH-001（回の計算）**：任意の受ける RRULE・開始・タイムゾーンで、計算した回の数は `COUNT` 以下で、すべて `UNTIL` 以前で、`occurrence_id` は重ならない。
- **PROP-SCH-002（現地の時刻）**：夏時間のあるタイムゾーンで、繰り返しの回の現地の時刻は（存在しない時刻を除き）すべて `start_local` の時刻と同じ。
- **PROP-SCH-003（同期の収束）**：任意の順序で届く通知・重複した通知・取りこぼしの後、毎日の差分の取り込みを 1 回行えば、本システムの予定の会議の時刻はカレンダーの予定と一致する。
- **PROP-SCH-004（守り）**：カレンダーの入口から作った会議も、待合室かパスコードを持つ（PROP-SEC-001 と同じ検査）。

### 9.2 結合と契約

- Google と Microsoft の試験のテナントで、作成・時刻の変更・1 回の取り消し・全体の取り消し・トークンの取り消しを確かめる。
- Outlook のアドインを、web・new Windows・Mac で動かし、1 分以内に本文が更新されることを確かめる。
- tzdata のバージョンを上げる PR で、影響を受ける会議の洗い出しの試験を回す。

## 10. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E6 | `scheduled-meeting-crud` | 4.1 節。作成・更新・取り消し、`idempotency_key` |
| E6 | `recurrence-rrule-subset` | 4.2〜4.3 節。回の計算、例外 |
| E6 | `timezone-handling` | 4.4 節。現地の時刻、tzdata のバージョンの固定と洗い出し |
| E6 | `invite-email-ics` | 4.5 節 |
| E6 | `pmi` | 5 節。割り当て、作り直し、待合室の強化 |
| E6 | `google-calendar-oauth-write` | 6.1・6.2 節。本システムの画面から Google に書く |
| E6 | `microsoft-graph-oauth-write` | 同上。Graph、`transactionId` |
| E6 | `calendar-change-sync` | 6.3 節。push・変更の通知、毎日の差分 |
| E6 | `google-workspace-addon` | 6.1 節。会議の方式、`onCreateFunction` |
| E6 | `outlook-online-meeting-addin` | 6.1・6.4 節。管理者が配るアドイン |
| E12 | `outlook-addin-marketplace` | Marketplace での公開と、Join のボタンの登録 |

## 11. 未解決の問い

### 決定

2026-09-27 に推奨案で確定した（[README.md](README.md) の 6 節の「決定（2026-09-27、推奨案で確定）」）。

- **時刻**：現地の時刻＋IANA のタイムゾーン。UTC は回ごとに計算する。
- **繰り返し**：RRULE の一部。`COUNT` 100 まで、`UNTIL` 2 年まで。例外は「この回だけ」と「すべて」。
- **時刻の決まっていない繰り返し**：最後の開催から 365 日で期限切れ。
- **PMI**：10 桁、CSPRNG、利用者に選ばせない。待合室は常に有効で、組織の外の人は省けない。
- **カレンダー**：アドオン・アドインと、OAuth で書く入口の両方。取り込みは通知＋毎日の差分。衝突はカレンダーを正とする。
- **「この回以降を変える」**：S1 では作らない。「この回だけ」と「すべて」の 2 つに限る（[roadmap.md](../roadmap.md) の延期の一覧）。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| Calendar API から第三者が `conferenceData` の `entryPoints` を直接書けるか | E6 の `google-calendar-oauth-write` で試験のテナントで確かめる |
| Google の確認の審査の期間（審査が要ることは確かめた。範囲の分類は同意の画面で確かめる） | E6 の `google-calendar-oauth-write` の前 |
| Outlook の Join のボタンのための Microsoft Marketplace の公開と、GitHub の issue での登録 | E12 の `outlook-addin-marketplace` |
| Google の push のチャンネルの期限の既定と最大 | E6 の `calendar-change-sync` で応答の `expiration` を実測する |
| Node.js での Temporal の対応 | 決着：Node.js 26 で既定で有効（4.4 節）。それより前のバージョンの間は polyfill |
| 繰り返しの回数・期限の本家の値 | 決着：60 回、ID は最後の開催から 365 日で失効（2 節）。合わせることは目標にしない |

## 12. quality.md・runbooks・data-model への項目

### quality.md

- カレンダーの予定と本システムの会議の時刻の不一致の数（毎日の差分の取り込みで見つけて直した件数）。
- 通知から本システムの更新までの遅れ（p50・p95）。
- カレンダーへの書き込みの失敗率（相手ごと、エラーの種類ごと）。
- `revoked` の接続の数の推移。
- Outlook のアドインの、ボタンから本文の更新までの時間（1 分の時間切れに対して）。

### runbooks

- `calendar-sync-lag.md`：通知が止まったときの確かめ方（チャンネル・購読の期限、受け口のエラー）と、差分の取り込みを手で回す手順。
- `calendar-provider-outage.md`：Google・Microsoft の API が止まったときの、書き込みの待ち行列の扱い。
- `tzdata-update.md`：tzdata のバージョンを上げる手順と、影響を受ける会議の主催者への連絡。
- `oauth-app-credentials-rotation.md`：Google・Microsoft の OAuth のクライアントの秘密の入れ替え。

### data-model（索引への追加の提案）

確定した形は [data-model/scheduling.md](data-model/scheduling.md) にある。

| 置き場所 | 中身 |
| --- | --- |
| Aurora `meetings`（列の追加） | `type`、`topic`、`start_local`、`timezone`、`duration_min`、`recurrence`（RRULE の文字列）、`expires_at`（時刻の決まっていない会議）、`canceled_at`、`ics_sequence` |
| Aurora `meeting_occurrences` | `meeting_id`、`occurrence_id`（元の開始の UTC）、`status`（`modified`・`canceled`）、`start_local`、`duration_min`、`topic` |
| Aurora `meeting_invitees` | `meeting_id`、`email`（正規化）、`user_id?`、`source`（`manual`・`calendar`） |
| Aurora `meeting_alternative_hosts` | `meeting_id`、`user_id` |
| Aurora `personal_meeting_ids` | `user_id`、`pmi`（10 桁、一意）、`meeting_id`、`created_at`、`retired_at` |
| Aurora `calendar_connections` | `connection_id`、`user_id`、`provider`（`google`・`microsoft`）、`scopes`、`refresh_token_ciphertext`、`status`、`sync_token`、`channel_id`・`subscription_id`、`channel_expires_at`、`verify_secret_hash` |
| Aurora `calendar_links` | `(provider, calendar_event_id)` 一意、`meeting_id`、`etag`・`change_key`、`last_synced_at` |

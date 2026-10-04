# Architecture: Google Calendar

全体像と横断的な方針。領域ごとの設計は、同じディレクトリに領域ごとのファイルとして置く（まだない。計画は 7 節）。品質の戦略は [quality.md](../quality.md)、Epic と Story は [roadmap.md](../roadmap.md)、SLO と運用は [runbooks/](../runbooks/README.md) にある。

## 1. 全体構成

### 1.1 コンテキスト

```
 個人・組織の利用者（Web のブラウザ。モバイルは OS の標準のカレンダーを CalDAV で）
      │ HTTPS（REST）、WebSocket（変更の合図）、CalDAV
      ▼
┌──────────── 本システム（calendar.<brand>.<domain>、api.<brand>.<domain>、dav.<brand>.<domain>）────────────┐
│  予定・繰り返し・タイムゾーン、招待と出欠、空き時間と会議室、共有、差分の同期、リマインダー、予約ページ、検索    │
└─────────────────────────────────────────────────────────────────────────────────────┘
   ▲ REST・OAuth 2.0        ▲ iMIP（メールの返事・招待）    │ 外向き
   │ Webhook の登録          │                               ▼
 公開 API の利用者            外部のカレンダー（本家、        iMIP の送信（招待・取り消し・返事）
 （社内のツール、予約・        Outlook・Exchange、Apple の     Webhook の通知（利用者のサーバー）
 勤怠のシステム）             カレンダーなど）                 Web Push の配信のサービス、メール
 予約する外部の人             IdP（SAML・OIDC・SCIM）          ICS の購読の取得（外部の URL）
 （book.<brand>.<domain>）
```

### 1.2 コンテナ

```
 ┌── Web クライアント（TypeScript の SPA。最近の範囲を IndexedDB に持ち、オフラインで読む）──┐
 └──────┬───────────────────────────────┬──────────────────────────────────────┘
        │ HTTPS（REST、差分の同期）        │ WebSocket（「このカレンダーが変わった」の合図だけ）
        ▼                                 ▼
 ┌─────────────── CloudFront＋WAF（静的な資産、予約ページ、API、CalDAV）───────────────┐
 └──┬──────────────┬───────────────┬──────────────┬──────────────┬───────────────┘
    ▼              ▼               ▼              ▼              ▼
 ┌────────┐  ┌──────────┐  ┌────────────┐  ┌──────────┐  ┌──────────────┐
 │ API     │  │ CalDAV    │  │ Realtime    │  │ Booking   │  │ Auth          │
 │ 予定・   │  │ WebDAV・  │  │ WebSocket の│  │ 予約ページ │  │ ログイン・SSO・│
 │ 空き時間・│  │ 同期の    │  │ 終端と合図  │  │（匿名）    │  │ SCIM・OAuth   │
 │ 管理     │  │ REPORT    │  └─────▲──────┘  └────┬─────┘  └──────────────┘
 └───┬────┘  └────┬─────┘        │                │
     │ packages/writer（検証・展開・change_seq・outbox を 1 つの DB のトランザクションで）
     ▼            ▼                │                ▼
  Aurora PostgreSQL（予定オブジェクト、展開の索引、会議室の予約の排他の制約、calendar_changes、outbox、RLS）
     │ outbox                       │
     ▼                              │
  Relay ──▶ Valkey（変更の合図の pub/sub、空き時間のキャッシュ、レート制限）
     │
     ▼
  SNS・SQS ──▶ Worker
               ├ itip-delivery：主催者の変更を参加者の写しへ、iMIP の送信（SES）
               ├ imip-inbound：SES の受信 → S3 → 返事・招待の取り込み
               ├ expander：展開の索引の範囲の維持、tzdb の更新の再計算
               ├ reminder-scheduler：分の桶とタイマーホイール → notifier（Web Push・メール・画面）
               ├ push-sender：Webhook の通知
               ├ ics-fetcher：ICS の購読の取得（egress の専用の経路）
               └ indexer・auditor・lifecycle：検索の表、監査ログの写し、削除の期限
```

| コンテナ | 責務 |
| --- | --- |
| Web クライアント | 日・週・月・予定リストの表示、作成と移動、空き時間の探索。表示の範囲の予定を差分の同期で取り、最近の範囲（前後 4 週）を IndexedDB に持つ。書き込みはオンラインのときだけ（6 節の決定） |
| API | 公開の REST API と、自社の画面が使う API を同じものにする。予定・カレンダー・ACL・出欠・空き時間・会議室・管理・差分の同期 |
| CalDAV | RFC 4791 の CalDAV と RFC 6578 の同期。1 つの予定オブジェクト（UID）を 1 つのリソースにする（[ADR-0003](../decisions/0003-recurrence-storage-and-expansion.md)、[ADR-0007](../decisions/0007-interop-standards-scope.md)） |
| Realtime | Web クライアントの WebSocket を終端し、購読するカレンダーの「変わった」の合図だけを送る。中身は送らない。クライアントは合図を受けて差分を取る（[ADR-0005](../decisions/0005-change-log-and-sync-tokens.md)） |
| Booking | 予約ページ（匿名）。空いている枠の計算と予約の作成。WAF とボットの対策を別にする |
| Auth | 個人のログイン、組織の SSO（SAML・OIDC）と SCIM、OAuth 2.0 の認可サーバー、CalDAV のアプリ用のパスワード |
| `packages/writer` | すべての書き込みの入口のライブラリ。検証、ACL、展開の索引の更新、会議室の予約の行、`change_seq`、`calendar_changes`、outbox を 1 つの DB のトランザクションで書く。API・CalDAV・Booking・Worker が使う |
| Relay | outbox を読み、変更の合図を Valkey へ、遅れてよい処理を SNS・SQS へ流す |
| Worker | 招待の配送、iMIP の送受信、展開の索引の維持、リマインダー、Webhook、ICS の購読、検索の表、監査、削除の期限 |
| Aurora | 唯一の正本。テナントを RLS で分ける（[ADR-0004](../decisions/0004-tenancy-and-rls.md)） |
| Valkey | 合図の配信、空き時間のキャッシュ、レート制限。失われてもよい（クライアントはトークンで取り戻す） |
| S3 | iMIP の受信の生のメール、ICS の書き出し、監査ログの写し（Object Lock） |

原則は 6 つ。

- **保存の単位は予定オブジェクトである。** 1 つの UID の系列のマスターと、`RECURRENCE-ID` ごとの上書きを 1 つのまとまりとして版を持つ。iCalendar・CalDAV の単位と同じにする（[ADR-0003](../decisions/0003-recurrence-storage-and-expansion.md)）。
- **壁時計の時刻＋TZID が正、UTC は派生である。** UTC の瞬間は `tzdata_version` つきの派生の値で、tzdb が変われば作り直す（[ADR-0002](../decisions/0002-time-representation.md)）。
- **展開は 1 つの関数、索引は捨てて作り直せる写しである。** 範囲の中の回を展開の索引（`occurrences`）に写し、空き時間・会議室・リマインダー・範囲の表示が読む。範囲の外は、その場で同じ関数で展開する（[ADR-0003](../decisions/0003-recurrence-storage-and-expansion.md)）。
- **主催者の写しが正である。** 参加者ごとに写しを持ち、共有の項目は主催者の写しから iTIP の意味のメッセージで配る。本システムの中の参加者と外部の参加者を、同じ意味で扱う（[ADR-0006](../decisions/0006-organizer-and-attendee-copies.md)）。
- **書き込みは変更のログを通る。配信はベストエフォート、取り戻しは確実に。** カレンダーごとの `change_seq` と `calendar_changes` が、Web・API・CalDAV・Webhook の差分の同期の共通の背骨である。合図や Webhook が落ちても、トークンで取り戻す（[ADR-0005](../decisions/0005-change-log-and-sync-tokens.md)）。
- **権限は、返す前に 1 つの関数で削る。** `can()` で許すかを決め、`redact()` で空き時間だけ・`private` の予定の中身を削ってから返す（[ADR-0004](../decisions/0004-tenancy-and-rls.md)）。

### 1.3 主要な流れ

**A. 参加者のいる繰り返しの予定を作る**

1. API が要求を受け、`packages/writer` が検証する（RRULE の形と上限、TZID が tzdb にあるか、ACL）。
2. 1 つの DB のトランザクションで、主催者のカレンダーの行をロックして `change_seq` を振り、予定オブジェクト（マスター）、参加者の一覧、展開の索引（範囲の中の回）、会議室の予約の行（会議室が参加者のとき）、`calendar_changes`、outbox を書く。会議室の予約が排他の制約に当たれば、会議室の出欠を「辞退」にして書く（rooms-and-resources の領域）。
3. Relay が outbox を読み、主催者のカレンダーの合図を Valkey へ、配送の依頼を SQS へ流す。
4. `itip-delivery` が、本システムの中の参加者ごとに、相手のテナントのコンテキストで参加者の写しを書く（それぞれのカレンダーの `change_seq` を振る）。外部の参加者には、iMIP の `REQUEST` を SES で送る（[ADR-0006](../decisions/0006-organizer-and-attendee-copies.md)）。
5. 参加者の写しの `reminders` から、リマインダーの予定が分の桶に入る。

**B. tzdb の版を上げる**

1. 新しい tzdb のリリースから、`packages/tzdata` の版を上げる PR を作る。CI が、未来の遷移が変わるゾーンと区間の差分の報告を作る。
2. 採用（デプロイ）の後、`expander` が、影響するゾーンの TZID を持つ予定オブジェクトを探し、壁時計の時刻を保ったまま UTC の瞬間を計算し直す。展開の索引、会議室の予約の行、リマインダーの桶を直し、変わった予定を `calendar_changes` に載せる（[ADR-0002](../decisions/0002-time-representation.md)）。
3. 会議室の予約が、計算し直した結果で重なったときは、後から確定した予約を「要確認」にして主催者に知らせる（自動で辞退しない。time-zones-and-holidays と rooms-and-resources の領域）。

**C. リマインダーを送る**

1. `reminder-scheduler` が、分の桶から次の数分の予定を読み、メモリーのタイマーホイールに載せる。
2. 時刻が来たら、`(reminder_id, occurrence_start, method, version)` の鍵を送信の記録に書いてから、notifier へ渡す。同じ鍵の 2 回目は捨てる。
3. 予定が動いたり消えたりすれば版が上がり、古い版の項目は送らずに捨てる（reminders-and-notifications の領域）。

### 1.4 本家の形（確かめたこと）

| 項目 | 本家 | 出典 |
| --- | --- | --- |
| 繰り返し | RFC 5545 の RRULE・EXRULE・RDATE・EXDATE の行を `recurrence` に持つ。DTSTART・DTEND は含めず、開始・終了の欄に持つ。繰り返しの予定では開始のタイムゾーンが必須で、展開に使う | [Events resource](https://developers.google.com/workspace/calendar/api/v3/reference/events) |
| 例外 | 回は `recurringEventId` と `originalStartTime` で特定する。回を 1 つずつ変えて系列の全体や「これ以降」を表さないよう勧めている | [Recurring events](https://developers.google.com/workspace/calendar/api/guides/recurringevents) |
| 「これ以降」の変更 | 公式の API の文書は、どう表すかを明記していない（**未検証**） | — |
| 差分の同期 | `nextSyncToken` で差分を取る。トークンの失効・ACL の変更で 410 を返し、全件の取り直しを求める。削除も差分に含む | [Synchronize resources efficiently](https://developers.google.com/workspace/calendar/api/guides/sync) |
| Push の通知 | 本文のない通知を Webhook に送る。最初に `sync` を送る。期限で切れ、自動の更新はない。一部は落ちうる | [Push notifications](https://developers.google.com/workspace/calendar/api/guides/push) |
| 空き時間の照会 | 1 回の照会で、カレンダーは最大 50、グループの展開は最大 100 | [Freebusy: query](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query) |
| 会議室 | 「重ならない招待だけを自動で承諾する」設定。繰り返しで一部の回だけ重なれば、その回だけ辞退し、重なりが多ければ系列の全体を辞退する | [Approve or deny Calendar room & resource bookings](https://knowledge.workspace.google.com/admin/calendar/approve-or-deny-calendar-room-and-resource-bookings) |
| CalDAV | OAuth 2.0 だけで認証。`free-busy-query`・`MKCALENDAR`・VTODO を持たない。RFC 6578 の同期を使う | [CalDAV API developer's guide](https://developers.google.com/workspace/calendar/caldav/v2/guide) |
| 公開範囲 | `default`・`public`・`private`・`confidential`。繰り返しの 1 回の公開範囲を狭めると、系列の全体に効く | [Events resource](https://developers.google.com/workspace/calendar/api/v3/reference/events) |
| 内部の保存の形、展開の方式、リマインダーの仕組み | 公開の資料にない（**未検証**） | — |

いずれも 2026-10-04 に確認。この設計は振る舞いを参考にするが、本家の実装は公開されておらず、使わない（[リポジトリ共通の ADR-0007](../../../../docs/decisions/0007-no-reuse-of-original-implementation.md)）。

## 2. 規模の段階

| 段階 | テナント（組織／個人） | 月間の利用者 | 予定オブジェクト | 展開の索引の行 | 書き込みのピーク | 読み出しのピーク | リマインダーのピーク | 最大の組織 | 構成 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S1（MVP） | 3,000／30 万 | 60 万 | 3 億 | 4 億 | 1,500 件/秒 | 15,000 件/秒（うち CalDAV 2,000） | 3,000 件/秒（毎時 0 分・30 分の直前） | 利用者 3 万、会議室 2,000 | 東京の 1 リージョン・3 AZ。Aurora の writer 1 台＋reader 2 台。大阪にウォームスタンバイ（Aurora Global Database） |
| S2 | 3 万／300 万 | 600 万 | 30 億 | 40 億 | 15,000 件/秒 | 150,000 件/秒 | 30,000 件/秒 | 利用者 20 万、会議室 1 万 | テナントを単位に、複数の Aurora のクラスタへ分ける。テナントをまたぐ招待はメッセージで渡す（[ADR-0006](../decisions/0006-organizer-and-attendee-copies.md)）。検索を専用の基盤へ移すかを決める |
| S3 | 20 万／1,500 万 | 3,000 万 | 150 億 | 200 億 | 75,000 件/秒 | 750,000 件/秒 | 150,000 件/秒 | 利用者 50 万 | セル構成。テナントをセルに固定する。海外のリージョン（テナントをリージョンに固定し、アカウントとメールアドレスの解決だけを全体で持つ） |

- 数値は本システムの想定。本家の利用者の数、予定の数、要求の数は、公開の資料で確かめられなかった（**未検証**）。
- 書き込みの 1 件は、予定オブジェクト 1 つの作成・変更・削除、または出欠の返事 1 件を数える。参加者の写しへの配送は数えない（配送は S1 で平均の 4 倍と見込み、別に容量を見る）。
- 予定オブジェクトの数は、利用者 1 人あたり 500（過去を含む）と見込んだ。展開の索引は、範囲（過去 31 日から未来 548 日）の中の回で、1 人あたり 700 と見込んだ。E2 の PoC で確かめる（[ADR-0003](../decisions/0003-recurrence-storage-and-expansion.md)）。
- リマインダーは、会議の開始の 10 分前・5 分前・0 分に集中する。S1 で利用者の 30% が毎時 0 分の会議を持つ時間帯を最悪として見込んだ。分の桶ごとの数の偏りを reminders-and-notifications の領域で測る。
- CalDAV の読み出しは、利用者の 30% が OS の標準のカレンダーで 5 つのカレンダーを 15 分ごとに確かめる、として見込んだ。OS の確かめる間隔は本システムの想定（**未検証**）。
- 1 つのカレンダーの書き込みは、`change_seq` を振る行のロックで直列になる。会議室と大きな共有のカレンダーで、1 カレンダー 1 秒 50 件を上限と見込み、E2 の PoC で確かめる（[ADR-0005](../decisions/0005-change-log-and-sync-tokens.md)）。
- 段階を上げる基準は infrastructure の領域、負荷のモデルは capacity の領域で決める。

## 3. 非機能要件

| ID | 項目 | S1 の目標 | 備考 |
| --- | --- | --- | --- |
| NFR-001 | 応答の速さ | 予定の作成・変更の API p99 300ms。週の表示（カレンダー 10 個）の範囲の読み出し p95 300ms。Web の画面のドラッグでの移動は、楽観的に描いて入力から描画まで p95 100ms | 日本の中の回線 |
| NFR-002 | 変更の伝播 | 確定から同じ利用者の他の Web クライアントの表示まで p99 3 秒。主催者の変更から本システムの中の参加者の写しの確定まで p99 5 秒（参加者 200 人まで。それを超える分は p99 60 秒） | [ADR-0006](../decisions/0006-organizer-and-attendee-copies.md) |
| NFR-003 | リマインダー | 通知の時刻から送信の開始まで p99 30 秒（画面・Web Push）、メールの送信事業者への引き渡し p95 2 分。重複の送信 0.01% 未満、送り漏れ 0 件（予定の回からの照合で数える） | reminders-and-notifications の領域 |
| NFR-004 | 空き時間の探索 | 50 人＋会議室 20、2 週間、30 分刻みの候補の計算 p95 1 秒。1 回の空き時間の照会（カレンダー 50）p95 300ms | free-busy-and-scheduling の領域 |
| NFR-005 | 会議室の二重予約 | 自動で承諾する会議室で、承諾した予約の重なり 0 件 | DB の排他の制約（6 節の決定） |
| NFR-006 | 可用性 | 予定の読み書き（Web・API・CalDAV）月間 99.9%。リマインダーの時刻どおりの送信 月間 99.9%。予約ページ 月間 99.9% | 本家の Workspace の SLA は Calendar を含め月間 99.9%（[Google Workspace SLA](https://workspace.google.com/terms/sla/)、2026-10-04 に確認） |
| NFR-007 | 耐久性と障害 | 確定を返した変更を失わない。AZ の障害で RPO 0・RTO 5 分以内。リージョンの障害で RPO 1 分以内・RTO 1 時間以内 | リージョンの切り替えでは `sync_epoch` を上げ、全クライアントに差分の取り直しを求める（[ADR-0005](../decisions/0005-change-log-and-sync-tokens.md)） |
| NFR-008 | テナントと権限の分離 | 他のテナントの予定、空き時間だけの共有の予定の中身、`private` の予定の中身が、画面・API・CalDAV・ICS・検索・通知・Webhook に届いた事象 0 件 | [ADR-0004](../decisions/0004-tenancy-and-rls.md) |
| NFR-009 | 時刻の正しさ | 繰り返しの展開で、参照の実装との説明のつかない食い違い 0 件。tzdb の版の採用から 24 時間以内に、影響する未来の回を計算し直す。施行の 7 日以上前に公表された変更で、施行の後の時刻の誤り 0 件 | [ADR-0002](../decisions/0002-time-representation.md)、[ADR-0003](../decisions/0003-recurrence-storage-and-expansion.md)、[quality.md](../quality.md) |
| NFR-010 | 差分の同期 | 変更 1,000 件以下の差分の応答 p99 1 秒。同期のトークンは最後の利用から 30 日は使える。取り直しの要求（410）は、トークンの期限切れ・ACL の変更・`sync_epoch` の更新のときだけ | [ADR-0005](../decisions/0005-change-log-and-sync-tokens.md)。本家のトークンの有効の期間は未検証 |
| NFR-011 | iMIP | 外部への招待のメールの送信事業者への引き渡し p95 60 秒。外部からの返事の取り込み p95 2 分 | invitations-and-itip の領域 |
| NFR-012 | Webhook と検索 | Webhook の通知の最初の送信 p95 30 秒、少なくとも 1 回届ける。変更から検索に出るまで p95 30 秒、検索の応答 p99 1 秒。日本語の部分一致で取りこぼさない | api-and-push、search の領域 |

## 4. 技術スタック

| 層 | 選定 | 理由 |
| --- | --- | --- |
| 言語 | TypeScript（サーバー・Web クライアント・共有のパッケージ） | 他の題材と同じ。展開とタイムゾーンの計算を、サーバーとクライアントで同じコードにする（[ADR-0001](../decisions/0001-platform-and-stack.md)） |
| HTTP・検証 | Hono＋Zod | 他の題材と同じ |
| 公開 API | REST と JSON。形は本家の API の振る舞いに寄せ、名前は独自にする | api-and-push の領域 |
| CalDAV | Hono の上に WebDAV のメソッド（`PROPFIND`・`REPORT`・`PUT`・`DELETE` など）を自前で書く。XML は第三者の汎用のパーサー | [ADR-0007](../decisions/0007-interop-standards-scope.md) |
| iCalendar | 自前のパーサーと書き出し（`packages/ical`）。行の折り返し、エスケープ、VTIMEZONE を含む | [ADR-0001](../decisions/0001-platform-and-stack.md)、[ADR-0007](../decisions/0007-interop-standards-scope.md) |
| 繰り返しの展開 | 自前（`packages/recurrence`）。参照の実装（libical を第一の候補）はテストにだけ使う | [ADR-0003](../decisions/0003-recurrence-storage-and-expansion.md) |
| タイムゾーン | 自前の変換（`packages/tz`）と、版を固定した tzdb のデータ（`packages/tzdata`。IANA の tzdb を zic で遷移の表にしたもの）。サーバーとクライアントで同じ版 | [ADR-0002](../decisions/0002-time-representation.md) |
| Web クライアント | React、TanStack Router・Query、IndexedDB（最近の範囲のキャッシュ） | clients の領域 |
| DB | Aurora PostgreSQL 18、FORCE RLS と `SET LOCAL`、ID は UUIDv7。拡張は `btree_gist`（会議室の排他の制約）、`pg_bigm`（日本語の検索）、`pg_partman`（展開の索引と変更のログの分割） | [ADR-0004](../decisions/0004-tenancy-and-rls.md)。拡張が Aurora PostgreSQL 18 で使えることは確かめた（[Extension versions](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraPostgreSQLReleaseNotes/AuroraPostgreSQL.Extensions.html)、2026-10-04） |
| キャッシュ・合図 | ElastiCache Valkey（pub/sub、空き時間のキャッシュ、レート制限） | 他の題材と同じ |
| 非同期 | transactional outbox → SNS・SQS | 他の題材と同じ |
| メール | Amazon SES（送信と受信。東京リージョンで受信を使える。[SES endpoints and quotas](https://docs.aws.amazon.com/general/latest/gr/ses.html)、2026-10-04 に確認） | invitations-and-itip の領域 |
| Web Push | 標準の Web Push（VAPID）。配信はブラウザの事業者のサービス | reminders-and-notifications の領域。法務の L1・L4 |
| 実行基盤 | AWS（東京、DR は大阪）、ECS Fargate | 他の題材と同じ |
| IaC | Terraform | 他の題材と同じ |
| 可観測性 | OpenTelemetry（ADOT）→ AMP、X-Ray、CloudWatch Logs、Managed Grafana | 他の題材と同じ |
| フラグ | AWS AppConfig | 他の題材と同じ |
| テスト | Vitest、fast-check（展開・タイムゾーン・同期の性質）、参照の実装との差分テスト、Testcontainers、Playwright、CalDAV のクライアントの相互運用の試験 | [quality.md](../quality.md) |

## 5. 主な決定

どれも `accepted`。0001〜0007 は最初の設計の起票。状態の一覧は [decisions/README.md](../decisions/README.md)。

| ADR | 決定 |
| --- | --- |
| [0001](../decisions/0001-platform-and-stack.md) | 共通の基盤の上に、繰り返しの展開・タイムゾーン・iCalendar・CalDAV・招待の整合を自前で作る。クライアントは Web の SPA で、モバイルは MVP では CalDAV で覆う |
| [0002](../decisions/0002-time-representation.md) | 時刻つきの予定は壁時計の時刻＋TZID を正にし、UTC の瞬間は `tzdata_version` つきの派生の値にする。終日は日付、浮動は浮動のまま持つ。tzdb は版を固定してサーバーとクライアントに配る |
| [0003](../decisions/0003-recurrence-storage-and-expansion.md) | 予定オブジェクト（マスター＋`RECURRENCE-ID` の上書き）を保存の単位にし、範囲（過去 31 日から未来 548 日）の回を展開の索引に写す。「これ以降」は系列を `UNTIL` で切って新しい UID に分ける |
| [0004](../decisions/0004-tenancy-and-rls.md) | 組織と個人をテナントにし、FORCE RLS で分ける。カレンダーの ACL と予定の公開範囲を `can()`・`redact()` の 1 つのモジュールで判定する |
| [0005](../decisions/0005-change-log-and-sync-tokens.md) | カレンダーごとに単調な `change_seq` と変更のログを持ち、Web・公開 API・CalDAV・Webhook の差分の同期の背骨にする。トークンは署名つきで、30 日を過ぎたら取り直しを求める |
| [0006](../decisions/0006-organizer-and-attendee-copies.md) | 参加者ごとに写しを持ち、主催者の写しを正にする。本システムの中の参加者にも内部の iTIP のメッセージで配り、外部の参加者には同じ意味を iMIP で送る |
| [0007](../decisions/0007-interop-standards-scope.md) | iCalendar・iTIP・iMIP・CalDAV・WebDAV の同期の対応の範囲を決める。`free-busy-query`・`MKCALENDAR`・VTODO・`RSCALE`・`COUNTER` は MVP で持たない |

領域ごとの ADR は、7 節の番号の範囲で起票する。リポジトリ共通の決定（開発プロセス、ブランチモデル、本家の名前・接頭辞を使わない規則の [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)、本家の実装を核に使わない規則の [ADR-0007](../../../../docs/decisions/0007-no-reuse-of-original-implementation.md)）は、ルートの [docs/decisions/](../../../../docs/decisions/README.md) にある。

## 6. リスクと未解決事項

品質の面のリスクの順位と対策は [quality.md](../quality.md) の 1 節にある。ここは設計の面のリスクを書く。

- **展開の誤り**：RRULE の組み合わせ（`BYSETPOS`、`BYWEEKNO`、月末の `BYMONTHDAY=-1`、`WKST`、閏年の 2 月 29 日）、例外との重なり、夏時間の切り替えの存在しない時刻・2 回ある時刻で、回が増える・欠ける・ずれる。参照の実装との性質ベーステストと、展開の索引とその場の展開の本番の照合で抑える（[ADR-0003](../decisions/0003-recurrence-storage-and-expansion.md)、[quality.md](../quality.md)）。
- **tzdb の更新の取り違え**：版の違う tzdb でサーバー・クライアント・CalDAV のクライアント・外部のカレンダーが別の UTC を計算する。本システムの中は版を固定してそろえる。外部（CalDAV のクライアント、iMIP の相手）は自分の tzdb を使うので、ずれは残る。予定に VTIMEZONE を付けて送り、ずれを受け入れる範囲を time-zones-and-holidays の領域で決める（[ADR-0002](../decisions/0002-time-representation.md)）。
- **招待の写しの食い違い**：配送の遅れ・順序の入れ替わり・重複で、参加者の写しが古い版のまま残る。iTIP の `SEQUENCE` と `DTSTAMP` で古いメッセージを捨て、写しの版を主催者の写しの版と照合する定期のジョブで直す（[ADR-0006](../decisions/0006-organizer-and-attendee-copies.md)）。
- **大きな招待の配送**：グループの招待で参加者が数千人になると、1 回の変更で数千の写しを書く。配送をバッチにして書き込みの枠を分け、NFR-002 の 200 人を超える分は p99 60 秒にした。グループの展開の上限は MVP で 10,000 人（本家は 100,000 人。[Invite groups to calendar events](https://support.google.com/calendar/answer/172013)、2026-10-04 に確認）。
- **会議室の二重予約と繰り返し**：排他の制約は、展開の索引の範囲の中の回にしか効かない。範囲の外の会議室の予約を受けない（会議室の予約は未来 548 日まで）ことで、制約の外を作らない。範囲を延ばすときは、会議室の予約の行を先に作る。
- **リマインダーの集中**：毎時 0 分・30 分の直前に、送信が分の桶 1 つに集中する。桶を秒に分けて読み、notifier を前もって増やす。送信の記録の一意の鍵で重複を消す（reminders-and-notifications の領域）。
- **差分の同期の欠け**：ログに載らない書き込み（一括の修正、tzdb の再計算）があると、クライアントは変化に気づかない。すべての書き込みを `packages/writer` に通し、再計算も変更のログに載せる。ログの保持を超えたら 410 で取り直させる（[ADR-0005](../decisions/0005-change-log-and-sync-tokens.md)）。
- **権限の漏れ**：空き時間だけの共有、`private` の予定、組織の外への共有の方針が、経路（CalDAV の `calendar-data`、ICS の公開、検索の抜粋、通知のメール、Webhook）ごとに漏れうる。`redact()` を 1 つにし、経路の一覧と性質ベーステストで確かめる（[ADR-0004](../decisions/0004-tenancy-and-rls.md)）。
- **外からの入力**：iMIP の偽の返事（他人の出欠を書き換える）、迷惑な招待、巨大な ICS、展開の爆発（`FREQ=DAILY` の無限の系列に大量の RDATE）、ICS の購読の URL での SSRF。返事の照合の鍵、送信元の認証（DKIM・DMARC の整合）、上限、egress の専用の経路で抑える（invitations-and-itip、security の領域）。
- **CalDAV のクライアントの差**：OS ごとに、繰り返しの例外の送り方、VTIMEZONE の有無、`If-Match` の扱いが違う。対象のクライアントの相互運用の試験を CI と手動で持つ（[ADR-0007](../decisions/0007-interop-standards-scope.md)、[quality.md](../quality.md)）。
- **法令**：法務の確認待ちの事項がある（[intent.md](../intent.md) の「法務の確認待ち」の L1〜L10）。結論が出るまで、そこに挙げた Epic の spec を承認しない。

### 決定（2026-10-04、既定案）

PM の方針（本家に寄せ、判断が要るところは推奨の既定案で進める）により、最初の設計で次のとおり決めた。法務の判断が要るものは決めず、[intent.md](../intent.md) の「法務の確認待ち」に残した。どれも領域の文書の工程と E1〜E12 の PoC・試験で覆りうる。領域の文書で ADR にするものは、その領域を書いておく。

- **モバイル**：MVP はネイティブのアプリを作らず、Web の画面（スマートフォンの幅に対応）と、OS の標準のカレンダー（CalDAV）で覆う（[ADR-0001](../decisions/0001-platform-and-stack.md)）。
- **Web の画面のオフライン**：最近の範囲（前後 4 週）の読み出しだけ。オフラインでの書き込みは MVP で持たない（clients の領域）。
- **リアルタイム**：WebSocket は「変わった」の合図だけを送り、中身は差分の同期で取る。経路を 1 つにして、合図の落ちを取り戻しで埋める（[ADR-0005](../decisions/0005-change-log-and-sync-tokens.md)）。
- **会議室の二重予約**：会議室の予約の行（`resource_bookings`）に、会議室と時刻の区間の `btree_gist` の排他の制約を付ける。自動で承諾する会議室は、制約に当たった回を辞退にする（rooms-and-resources の領域で ADR にする）。
- **検索**：S1 は Aurora の `pg_bigm` で、`redact()` を通した検索の表を引く。新しい部品を足さない（search の領域で ADR にする）。
- **リマインダーの時計**：Aurora の分の桶の表と、シャードごとのメモリーのタイマーホイールの組み合わせ。送信の記録の一意の鍵で重複を消す（reminders-and-notifications の領域で ADR にする）。EventBridge Scheduler の 1 回ごとのスケジュールは、予定の変更のたびに作り直す量が多いので第一の候補にしない。
- **CalDAV の認証**：OAuth 2.0 の Bearer と、CalDAV 専用のアプリ用のパスワード（利用者が作り、スコープと期限を持ち、組織の管理者が禁止できる）の Basic 認証。ログインのパスワードは CalDAV に使わない。OS の標準のカレンダーが OAuth 2.0 の任意のサーバーに対応しないため（accounts-and-orgs、sync-and-caldav の領域）。
- **Webhook の通知の期限**：既定 7 日、最大 30 日。自動の更新はせず、利用者が作り直す（本家と同じ考え方）。通知に中身を入れず、`<Brand>-Channel-Id`・`<Brand>-Resource-State`・`<Brand>-Message-Number` と署名の `<Brand>-Signature` を付ける（api-and-push の領域）。
- **ICS の購読**：既定 6 時間ごとに取得し、`ETag`・`Last-Modified` で条件つきで取る。1 回 10 MiB・予定 5 万件まで。本家の間隔は未検証（sync-and-caldav の領域）。
- **上限**：タイトル 1,024 文字、説明 64 KiB、直接の参加者 1,000 人、グループの展開 10,000 人、1 つの予定オブジェクトの上書き 1,000 件・RDATE 1,000 件・EXDATE 5,000 件、リマインダーは参加者ごとに 5 件・0〜40,320 分（本家の API と同じ。[Events resource](https://developers.google.com/workspace/calendar/api/v3/reference/events)、2026-10-04 に確認）。
- **祝日**：「日本の祝日」をシステムの公開のカレンダーとして配る。祝日の法の規則（振替休日、国民の休日を含む）からの生成を正にし、内閣府の CSV を照合に使う（time-zones-and-holidays の領域。CSV の利用の条件は法務の L7）。
- **本家の名前**：識別子は `<Brand>`・`<brand>`（リポジトリ共通の ADR-0006）。iCalendar の `PRODID` は `-//<Brand>//Calendar//JA`。

持ち越し（法務、計測・PoC・選定で決めるもの）：

| 項目 | いつ・どう決めるか |
| --- | --- |
| 法務の確認待ち（L1〜L10） | [intent.md](../intent.md) の「法務の確認待ち」。結論まで、そこに挙げた Story の spec を承認しない |
| 展開の索引の範囲（過去 31 日から未来 548 日）と行の数 | E2 の前の `occurrence-index-poc` |
| 繰り返しの展開の参照の実装（libical か、他の実装との多数決か） | E2 の着手前の `recurrence-reference-survey` |
| 1 カレンダーの書き込みの上限（1 秒 50 件）、会議室の予約の排他の制約の書き込みの速さ | E2 の前の `calendar-write-throughput-poc`、E6 の前の `room-exclusion-poc` |
| tzdb の更新で外部の参加者へ更新を送るか | time-zones-and-holidays の領域 |
| 空き時間のキャッシュの形（区間の一覧か、ビットの列か） | E6 の前の `freebusy-poc` |
| S2 で検索を専用の基盤へ移すか | search の領域と E11 の計測 |
| 本家の振る舞いで未確認のもの（「これ以降」の表し方、同期のトークンの有効の期間、ICS の購読の間隔、繰り返しの回の上限） | 各領域の文書で、公式の資料で確かめる。確かめられなければ未検証のまま、本システムの値を使う |

## 7. 領域の文書（計画）

各領域の文書は、まだない。領域の担当は、下の表の番号の範囲の中で ADR を採番する（範囲の外に出るときは、この表を先に更新する）。持ち主は、どれも Dev が書き、下の「レビュー」の列のロールが確認する。

| ファイル | 範囲 | ADR | レビュー | 関わる Epic |
| --- | --- | --- | --- | --- |
| [events-and-recurrence.md](events-and-recurrence.md) | 予定オブジェクトの形、予定の種類、RRULE・RDATE・EXDATE の受け付けと上限、`expand()` の仕様、1 回分の例外、「これ以降」の分割、系列の全体の変更での例外の扱い、展開の索引の範囲の維持、その場の展開との照合 | [0008](../decisions/0008-recurrence-expansion-semantics.md)、[0009](../decisions/0009-series-edit-and-override-rebasing.md)、[0010](../decisions/0010-occurrence-index-maintenance.md)、[0011](../decisions/0011-inbound-recurrence-normalization.md) | QA（展開の性質） | E2 |
| [time-zones-and-holidays.md](time-zones-and-holidays.md) | `packages/tz`・`packages/tzdata`、壁時計＋TZID の解決（存在しない時刻、2 回ある時刻）、浮動の時刻、終日、tzdb の更新の採用と再計算、Windows のゾーン名などの別名、VTIMEZONE の書き出し、日本の祝日のカレンダー、和暦の表示 | [0012](../decisions/0012-tzdb-update-recompute-and-propagation.md)、[0013](../decisions/0013-external-timezone-definitions.md) | QA | E3 |
| [invitations-and-itip.md](invitations-and-itip.md) | 主催者の写しと参加者の写し、内部の iTIP の配送、出欠と `SEQUENCE`、参加者の権限、グループの招待と展開、主催者の変更、iMIP の送信（SES）と受信（返事の照合、送信元の認証）、迷惑な招待の対策 | [0014](../decisions/0014-itip-state-transfer-and-sequence.md)、[0015](../decisions/0015-imip-addressing-and-trust.md)、[0016](../decisions/0016-group-invitation-expansion.md) | QA、セキュリティ | E5 |
| [free-busy-and-scheduling.md](free-busy-and-scheduling.md) | 空き時間の照会（人・グループ・会議室）、テナントをまたぐ照会の方針、空き時間のキャッシュ、複数の人の候補の計算、勤務の時間の考慮 | [0017](../decisions/0017-freebusy-source-and-cache.md)、[0018](../decisions/0018-find-a-time-algorithm.md) | QA、Ops | E6 |
| [rooms-and-resources.md](rooms-and-resources.md) | 建物・階・定員・設備の属性、会議室のカレンダー、自動の承諾と管理者の承認、排他の制約、繰り返しの予約の一部の辞退、会議室の検索と提案 | [0019](../decisions/0019-room-booking-rows-and-recurring-acceptance.md)、[0020](../decisions/0020-room-approval-and-needs-review.md) | QA | E6 |
| [sharing-and-acl.md](sharing-and-acl.md) | カレンダーの ACL のロール、予定の公開範囲、`can()`・`redact()` の決定表、組織の外への共有の方針、委任（代理の人） | [0021](../decisions/0021-effective-role-and-redact-table.md)、[0022](../decisions/0022-delegation-and-acting-on-behalf.md) | セキュリティ | E4 |
| [sync-and-caldav.md](sync-and-caldav.md) | 変更のログの形と保持、同期のトークンの形と失効、Web クライアントの差分の取り方、CalDAV（リソースの形、ETag・CTag、`sync-collection`、`calendar-query`・`calendar-multiget`、スケジュールの受信箱）、ICS の購読と公開、ICS の取り込みと書き出し | [0023](../decisions/0023-caldav-resource-model-and-conditional-writes.md)、[0024](../decisions/0024-caldav-implicit-scheduling.md)、[0025](../decisions/0025-ics-subscriptions-both-directions.md) | QA | E8 |
| [api-and-push.md](api-and-push.md) | 公開の REST API（リソース、ページング、条件つきの更新、エラー）、OAuth 2.0 のアプリとスコープ、レート制限、Webhook の通知（`watch`、期限、署名、再試行） | [0026](../decisions/0026-public-rest-api-shape.md)、[0027](../decisions/0027-oauth-apps-scopes-and-rate-limits.md)、[0028](../decisions/0028-push-channels-signed-webhooks.md) | QA、Ops | E8 |
| [reminders-and-notifications.md](reminders-and-notifications.md) | リマインダーの時計（分の桶とタイマーホイール）、送信の記録と重複の除去、予定の変更での付け替え、画面の通知・Web Push・メール、招待・変更・返事の通知、毎朝の予定の一覧 | [0029](../decisions/0029-reminder-clock-buckets-and-timer-wheel.md)、[0030](../decisions/0030-reminder-planning-horizon-and-replan.md)、[0031](../decisions/0031-notification-channels-and-content.md) | QA、Ops | E9 |
| [booking-pages.md](booking-pages.md) | 予約ページの設定（長さ、間の時間、1 日の上限、予約の受け付けの期間）、枠の計算、予約の作成と取り消し、予約者の確認、ボットの対策 | [0032](../decisions/0032-booking-slot-computation.md)、[0033](../decisions/0033-booking-creation-and-exclusion.md) | QA、セキュリティ | E10 |
| [search.md](search.md) | 検索の表、`pg_bigm` の索引、`redact()` の後の文字列、更新の遅れ、S2 の検索の基盤 | [0034](../decisions/0034-search-pg-bigm-acl-aware.md) | QA、Ops | E11 |
| [accounts-and-orgs.md](accounts-and-orgs.md) | 個人のアカウント、組織とドメインの確認、SSO（SAML・OIDC）、SCIM、セッション、CalDAV のアプリ用のパスワード、組織のディレクトリ（利用者・グループ・会議室）、管理の画面 | [0035](../decisions/0035-accounts-auth-library-and-credentials.md)、[0036](../decisions/0036-org-domains-sso-and-scim.md)、[0037](../decisions/0037-admin-roles-delegation-and-event-access.md) | セキュリティ | E4、E11 |
| [clients.md](clients.md) | Web の画面（日・週・月・予定リスト）、ドラッグの操作、タイムゾーンの表示、IME、キーボードの操作、最近の範囲のキャッシュとオフラインの閲覧、PWA と Web Push の登録 | [0038](../decisions/0038-web-calendar-rendering-and-local-expansion.md)、[0039](../decisions/0039-offline-read-cache-and-local-data.md) | QA | E7 |
| [security.md](security.md) | 脅威モデル、iMIP・ICS・CalDAV の入力の検査、監査ログ、データのライフサイクル（削除、解約）、暗号化、管理者の閲覧の記録、法務の論点の整理 | [0040](../decisions/0040-untrusted-calendar-input-gate.md)、[0041](../decisions/0041-encryption-keys-and-secret-storage.md)、[0042](../decisions/0042-audit-log-and-data-lifecycle.md) | セキュリティ | E1、E11、E12 |
| `data-model.md` | データモデルの索引 | なし（各領域の ADR を参照する） | QA | 全 Epic |
| [infrastructure.md](infrastructure.md) | AWS のアカウントとネットワーク、サービスの分け方、egress の経路、冗長化、DR（`sync_epoch`）、段階を上げる基準、S2 のテナントのシャード、S3 のセルとリージョン、コスト | [0043](../decisions/0043-accounts-network-ingress-and-service-placement.md)、[0044](../decisions/0044-disaster-recovery-and-calendar-side-effects.md)、[0045](../decisions/0045-stage-up-criteria-tenant-sharding-and-cells.md) | Ops | E1、E12 |
| [observability.md](observability.md) | ログ・メトリクス・トレース、伝播とリマインダーの遅れの計測、展開の照合、権限の応答の監査、SLI | [0046](../decisions/0046-sli-from-ledgers-and-delivery-tracing.md) | Ops | E1、E12 |
| [capacity.md](capacity.md) | 負荷のモデル（読み書き、配送、リマインダーの集中、CalDAV）、1 カレンダーの書き込みの上限、部品ごとの必要量、負荷試験 | [0047](../decisions/0047-time-shaped-capacity-and-calendar-write-admission.md) | Ops | E12 |
| [delivery.md](delivery.md) | CI/CD、展開の性質ベーステストと相互運用の試験を CI に入れる、tzdb の版の更新の流れ、フラグ、Web のクライアントの配布、スキーマの変更の順序 | [0048](../decisions/0048-ci-gates-and-caldav-client-compatibility.md)、[0049](../decisions/0049-tzdata-rollout-and-schema-change-ordering.md) | QA、Ops | E1、E3、E12 |

- 次に採番する ADR は 0050。

## 8. Epic

Epic と Story の計画は [roadmap.md](../roadmap.md) にある（PM が持つ）。E1〜E12 が MVP（S1）。各 Epic の品質の重点と合否基準は [quality.md](../quality.md) の 5 節にある。

| Epic | 目的 |
| --- | --- |
| E1 | 基盤：AWS・Terraform・CI、Aurora と RLS、`packages/writer` の骨格、フラグ、可観測性、監査ログ、大阪の骨格 |
| E2 | 予定と繰り返しの核：予定オブジェクト、`packages/ical`、`packages/recurrence`、例外と「これ以降」、展開の索引、参照との性質ベーステスト |
| E3 | タイムゾーンと祝日：`packages/tz`・`packages/tzdata`、tzdb の更新の流れと再計算、浮動・終日、日本の祝日のカレンダー |
| E4 | アカウント・組織・共有：ログイン、組織、SSO・SCIM、ディレクトリ、カレンダー、ACL と公開範囲、`can()`・`redact()` |
| E5 | 招待と出欠：参加者の写し、内部の iTIP、グループの招待、iMIP の送受信 |
| E6 | 空き時間と会議室：空き時間の照会、候補の計算、会議室と自動の承諾、二重予約の防止 |
| E7 | Web の画面：日・週・月・予定リスト、ドラッグ、IME、オフラインの閲覧 |
| E8 | 同期と API：変更のログと同期のトークン、公開 API、OAuth、Webhook、CalDAV、ICS の購読・公開・取り込み・書き出し |
| E9 | リマインダーと通知：時計、送信の記録、Web Push・メール・画面、毎朝の一覧 |
| E10 | 予約ページ |
| E11 | 検索、組織の管理、監査 |
| E12 | 本番の準備と GA の判定：負荷試験、リマインダーの集中の試験、tzdb の更新の訓練、DR の訓練、相互運用の受け入れ試験、外部のペンテスト |
| E13 以降（MVP の後） | ネイティブのモバイルのアプリ、タスク、有料の予約、ビデオ会議の発行、AI の日程の提案、他社のカレンダーとの相互の照会と移行、海外のリージョン |

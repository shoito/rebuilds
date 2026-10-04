# Architecture: Google Calendar

全体像と横断的な方針。領域ごとの設計は、同じディレクトリに領域ごとのファイルとして置く（一覧は 7 節、表と置き場所の索引は [data-model.md](data-model.md)）。品質の戦略は [quality.md](../quality.md)、Epic と Story は [roadmap.md](../roadmap.md)、SLO と運用は [runbooks/](../runbooks/README.md) にある。

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
 ┌── Web クライアント（TypeScript の SPA。最近の範囲を IndexedDB に持ち、オフラインで読む）──┐   OS の標準のカレンダー
 └──────┬───────────────────────────────┬──────────────────────────────────────┘   （CalDAV のクライアント）
        │ HTTPS（REST、差分の同期）        │ WebSocket（「このカレンダーが変わった」の合図だけ）              │ CalDAV（WebDAV）
        ▼                                 ▼                                                                 ▼
 ┌──── CloudFront＋WAF（calendar・api・auth・book・ics。静的な資産、tzdata、API、予約ページ、ICS の公開）────┐   ┌ ALB（alb-dav）＋WAF ┐
 └──┬──────────────┬───────────────┬──────────────┬──────────────┬───────────────┘   └──────────┬─────────┘
    ▼              ▼               ▼              ▼              ▼                                    ▼
 ┌────────┐  ┌──────────┐  ┌────────────┐  ┌──────────┐  ┌──────────────┐                   ┌──────────┐
 │ API     │  │ Realtime  │  │ Booking     │  │ Auth      │  │ （ICS の公開は │                   │ CalDAV    │
 │ 予定・   │  │ WebSocket │  │ 予約ページ  │  │ ログイン・ │  │  API が返す） │                   │ WebDAV・  │
 │ 空き時間・│  │ の終端と  │  │（匿名）     │  │ SSO・SCIM・│  └──────────────┘                   │ 同期の    │
 │ 管理     │  │ 合図      │  └────┬───────┘  │ OAuth     │                                     │ REPORT    │
 └───┬────┘  └─────▲────┘       │           └──────────┘                                     └────┬─────┘
     │ packages/writer（検証・展開・change_seq・outbox を 1 つの DB のトランザクションで）                  │
     ▼              │                ▼                                                                     ▼
  Aurora PostgreSQL（予定オブジェクト、展開の索引、会議室の予約の排他の制約、calendar_changes、outbox、RLS）◀──────┘
     │ outbox       │
     ▼              │
  Relay ──▶ Valkey（変更の合図の pub/sub、空き時間のキャッシュ、レート制限、書き込みの枠）
     │
     ▼
  SNS・SQS ──▶ Worker
               ├ itip-delivery：主催者の変更を参加者の写しへ、iMIP の送信（SES）
               ├ imip-inbound：SES の受信（東京が主、大阪が副の MX）→ S3 → 解析 → itip-apply が返事・招待を当てる
               ├ expander：展開の索引の範囲の維持、tzdb の更新の再計算
               ├ reminder-scheduler：計画の表（256 のシャード）とタイマーホイール → notifier（Web Push・メール・画面）
               ├ push-sender（egress）：Webhook の通知
               ├ ics-fetcher（egress）：ICS の購読の取得 → ics-apply
               └ indexer・auditor・lifecycle・slo-aggregator ほか：検索の表、監査ログの写し、削除の期限、SLI
```

| コンテナ | 責務 |
| --- | --- |
| Web クライアント | 日・週・月・予定リストの表示、作成と移動、空き時間の探索。表示の範囲の予定を差分の同期で取り、最近の範囲（前後 4 週）を IndexedDB に持つ。書き込みはオンラインのときだけ（[ADR-0038](../decisions/0038-web-calendar-rendering-and-local-expansion.md)、[ADR-0039](../decisions/0039-offline-read-cache-and-local-data.md)） |
| API | 公開の REST API と、自社の画面が使う API を同じものにする。予定・カレンダー・ACL・出欠・空き時間・会議室・管理・差分の同期 |
| CalDAV | RFC 4791 の CalDAV と RFC 6578 の同期。1 つの予定オブジェクト（UID）を 1 つのリソースにする（[ADR-0003](../decisions/0003-recurrence-storage-and-expansion.md)、[ADR-0007](../decisions/0007-interop-standards-scope.md)、[ADR-0023](../decisions/0023-caldav-resource-model-and-conditional-writes.md)）。CloudFront は `PROPFIND`・`REPORT` を通せないので、`dav.<brand>.<domain>` を WAF つきの ALB で受ける（[ADR-0043](../decisions/0043-accounts-network-ingress-and-service-placement.md)） |
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
5. 参加者の写しの `reminders` から、`reminder.replan` でリマインダーの計画の行が作られる（[ADR-0030](../decisions/0030-reminder-planning-horizon-and-replan.md)）。

**B. tzdb の版を上げる**

1. `tzdata-watch` が新しい tzdb のリリースを見つけ、署名を確かめて、`packages/tzdata` に版を足す PR を作る。CI が、未来の遷移が変わるゾーンと区間の差分の報告を作る。
2. Dev と Ops が採用を決め、新旧の版を含むイメージをデプロイする（`active` は旧のまま）。AppConfig の `tzdata.active_version` を新しい版に切り替え、全サービスが同時に新しい版で計算する（[ADR-0049](../decisions/0049-tzdata-rollout-and-schema-change-ordering.md)）。
3. 全タスクが新しい版を報告したら、`expander` が会議室の予約の行を先に、次に施行の近い順に予定オブジェクトを計算し直す。壁時計の時刻を保ち、展開の索引、リマインダーの計画を直し、変わった予定を `calendar_changes` に載せる（[ADR-0002](../decisions/0002-time-representation.md)、[ADR-0012](../decisions/0012-tzdb-update-recompute-and-propagation.md)）。
4. 会議室の予約が重なったら、後から承諾した予約を「要確認」にして知らせる（自動で辞退しない。[ADR-0020](../decisions/0020-room-approval-and-needs-review.md)）。切り替えの窓の扱いは ADR-0012。手順は [runbooks/tzdb-update.md](../runbooks/tzdb-update.md)。

**C. リマインダーを送る**

1. `reminder-scheduler` が、計画の表（7 日先まで、256 のシャード）から次の 5 分の行を読み、メモリーのタイマーホイールに載せる（[ADR-0029](../decisions/0029-reminder-clock-buckets-and-timer-wheel.md)）。
2. 時刻が来たら、計画の行を claim し、（利用者, 予定オブジェクト, `recurrence_id`, 方法, 分, 回の開始）の鍵を送信の記録に挿入して、挿入できたものだけを notifier へ渡す。同じ鍵の 2 回目は捨てる。版は鍵に入れない（[ADR-0030](../decisions/0030-reminder-planning-horizon-and-replan.md)）。
3. 予定が動いたり消えたりすれば、`reminder.replan` で計画の行を作り直す。notifier は送る時に回の開始が今と同じかを確かめ、古い時刻の項目を捨てる。

### 1.4 本家の形（確かめたこと）

| 項目 | 本家 | 出典 |
| --- | --- | --- |
| 繰り返し | RFC 5545 の RRULE・EXRULE・RDATE・EXDATE の行を `recurrence` に持つ。DTSTART・DTEND は含めず、開始・終了の欄に持つ。繰り返しの予定では開始のタイムゾーンが必須で、展開に使う | [Events resource](https://developers.google.com/workspace/calendar/api/v3/reference/events) |
| 例外 | 回は `recurringEventId` と `originalStartTime` で特定する。回を 1 つずつ変えて系列の全体や「これ以降」を表さないよう勧めている | [Recurring events](https://developers.google.com/workspace/calendar/api/guides/recurringevents) |
| 「これ以降」の変更 | 公式の API の文書は、どう表すかを明記していない（**未検証**） | — |
| 差分の同期 | `nextSyncToken` で差分を取る。トークンの失効・ACL の変更で 410 を返し、全件の取り直しを求める。削除も差分に含む | [Synchronize resources efficiently](https://developers.google.com/workspace/calendar/api/guides/sync) |
| Push の通知 | 本文のない通知を Webhook に送る。最初に `sync` を送る。期限で切れ、自動の更新はない。一部は落ちうる | [Push notifications](https://developers.google.com/workspace/calendar/api/guides/push) |
| 空き時間の照会 | 1 回の照会で、カレンダーは最大 50、グループの展開は最大 100 | [Freebusy: query](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query) |
| 会議室 | 「重ならない招待だけを自動で承諾する」設定と管理者の承認。繰り返しは、少なくとも回の半分で空いていて、空いていない回が 8 回以下なら受ける | [Approve or deny Calendar room & resource bookings](https://knowledge.workspace.google.com/admin/calendar/approve-or-deny-calendar-room-and-resource-bookings)、[Learn why a Google Calendar meeting room declines an event](https://support.google.com/calendar/answer/16107253) |
| CalDAV | OAuth 2.0 だけで認証し、Basic 認証は 401。`free-busy-query`・`MKCALENDAR`・VTODO・VJOURNAL を持たない。RFC 6578 の同期を使う。受信箱は空で、招待は予定のコレクションへ直接入る | [CalDAV API developer's guide](https://developers.google.com/workspace/calendar/caldav/v2/guide) |
| 公開範囲 | `default`・`public`・`private`・`confidential`。繰り返しの 1 回の公開範囲を狭めると、系列の全体に効く | [Events resource](https://developers.google.com/workspace/calendar/api/v3/reference/events) |
| 内部の保存の形、展開の方式、リマインダーの仕組み | 公開の資料にない（**未検証**） | — |

いずれも 2026-10-04 に確認。この設計は振る舞いを参考にするが、本家の実装は公開されておらず、使わない（[リポジトリ共通の ADR-0007](../../../../docs/decisions/0007-no-reuse-of-original-implementation.md)）。

**本家との意図した違い**（RFC との違いは [ADR-0007](../decisions/0007-interop-standards-scope.md) の「RFC との意図した違い」の表）：

| 項目 | 本家 | 本システム | 理由・根拠 |
| --- | --- | --- | --- |
| CalDAV の認証 | OAuth 2.0 だけ。Basic 認証は 401（[CalDAV API developer's guide](https://developers.google.com/workspace/calendar/caldav/v2/guide)） | OAuth 2.0 の Bearer と、CalDAV だけのアプリ用のパスワードの Basic 認証。ログインのパスワードは受けない | OS の標準のカレンダーが任意のサーバーの OAuth 2.0 に対応しないため（[ADR-0035](../decisions/0035-accounts-auth-library-and-credentials.md)） |
| CalDAV の入口 | カレンダーごとの主体とコレクション | 利用者ごとの主体とホームに、共有されたカレンダーも並べる | 1 回の設定で全カレンダーを出すため（[ADR-0023](../decisions/0023-caldav-resource-model-and-conditional-writes.md)） |
| 空き時間の照会の上限 | 1 回 50 カレンダー | 1 回 100 項目 | 50 人＋会議室 20 を 1 回で照会するため（[free-busy-and-scheduling.md](free-busy-and-scheduling.md)） |
| グループの招待 | 100,000 人 | 10,000 人 | MVP の配送の量の上限（[ADR-0016](../decisions/0016-group-invitation-expansion.md)） |
| 管理者の予定の閲覧 | 特権の管理者とカレンダーの管理者は全員の予定の詳細を見られる | 役割に含めない。閲覧の許可の仕組みだけを `release.admin-event-access` の裏に作る | 法務の L8 の前に最も広い形を既定にしない（[ADR-0037](../decisions/0037-admin-roles-delegation-and-event-access.md)） |
| レート制限の超過 | 403 か 429 | 429 だけ | 再試行の扱いを 1 つにする（[ADR-0027](../decisions/0027-oauth-apps-scopes-and-rate-limits.md)） |
| Webhook の通知 | 署名の有無は資料にない（**未検証**） | 経路ごとの秘密で HMAC の署名を付ける | 偽の通知を防ぐ（[ADR-0028](../decisions/0028-push-channels-signed-webhooks.md)） |
| Web のオフライン | 過去 4 週と未来のすべて（Chrome） | 前後 4 週の読み出しだけ | 手元の量と消すきっかけを決めやすくする（[ADR-0039](../decisions/0039-offline-read-cache-and-local-data.md)） |
| 未回答の招待の空き時間 | 資料にない（**未検証**） | 仮の予定ありにする | 招待の時点で時間を仮に塞ぐ（[ADR-0017](../decisions/0017-freebusy-source-and-cache.md)） |

## 2. 規模の段階

| 段階 | テナント（組織／個人） | 月間の利用者 | 予定オブジェクト | 展開の索引の行 | 書き込みのピーク | 読み出しのピーク | リマインダーのピーク | 最大の組織 | 構成 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S1（MVP） | 3,000／30 万 | 60 万 | 3 億 | 4 億 | 1,500 件/秒 | 15,000 件/秒（うち CalDAV 2,000） | 3,000 件/秒（毎時 0 分・30 分の直前） | 利用者 3 万、会議室 2,000 | 東京の 1 リージョン・3 AZ。Aurora の writer 1 台＋reader 2 台。大阪にウォームスタンバイ（Aurora Global Database） |
| S2 | 3 万／300 万 | 600 万 | 30 億 | 40 億 | 15,000 件/秒 | 150,000 件/秒 | 30,000 件/秒 | 利用者 20 万、会議室 1 万 | テナントを単位に、複数の Aurora のクラスタへ分ける。テナントをまたぐ招待はメッセージで渡す（[ADR-0006](../decisions/0006-organizer-and-attendee-copies.md)）。検索を専用の基盤へ移すかを決める |
| S3 | 20 万／1,500 万 | 3,000 万 | 150 億 | 200 億 | 75,000 件/秒 | 750,000 件/秒 | 150,000 件/秒 | 利用者 50 万 | セル構成。テナントをセルに固定する。海外のリージョン（テナントをリージョンに固定し、アカウントとメールアドレスの解決だけを全体で持つ） |

- 数値は本システムの想定。本家の利用者の数、予定の数、要求の数は、公開の資料で確かめられなかった（**未検証**）。
- 書き込みの 1 件は、予定オブジェクト 1 つの作成・変更・削除、または出欠の返事 1 件を数える。参加者の写しへの配送は数えない（配送は S1 で平均の 4 倍と見込み、別に容量を見る）。
- 予定オブジェクトの数は、利用者 1 人あたり 500（過去を含む）と見込んだ。展開の索引は、範囲（過去 31 日から未来 548 日）の中の回で、1 人あたり 700 と見込んだ。E2 の PoC で確かめる（[ADR-0003](../decisions/0003-recurrence-storage-and-expansion.md)）。
- リマインダーは、会議の開始の 10 分前・5 分前・0 分に集中する。S1 で利用者の 30% が毎時 0 分の会議を持つ時間帯を最悪として見込んだ。表の 3,000 件/秒は 1 分の平均で、瞬間は毎時 50 分 00 秒の 1 秒に約 12 万件になる（[capacity.md](capacity.md) の 3 節。設計は瞬間の量で行う）。
- CalDAV の読み出しは、利用者の 30% が OS の標準のカレンダーで 5 つのカレンダーを 15 分ごとに確かめる、として見込んだ。OS の確かめる間隔は本システムの想定（**未検証**）。
- 1 つのカレンダーの書き込みは、`change_seq` を振る行のロックで直列になる。会議室と大きな共有のカレンダーで、1 カレンダー 1 秒 50 件を上限と見込み、E2 の PoC で確かめる（[ADR-0005](../decisions/0005-change-log-and-sync-tokens.md)）。
- 段階を上げる基準は [ADR-0045](../decisions/0045-stage-up-criteria-tenant-sharding-and-cells.md)、負荷のモデルは [capacity.md](capacity.md) にある。

## 3. 非機能要件

| ID | 項目 | S1 の目標 | 備考 |
| --- | --- | --- | --- |
| NFR-001 | 応答の速さ | 予定の作成・変更の API p99 300ms。週の表示（カレンダー 10 個）の範囲の読み出し p95 300ms。Web の画面のドラッグでの移動は、楽観的に描いて入力から描画まで p95 100ms | 日本の中の回線 |
| NFR-002 | 変更の伝播 | 確定から同じ利用者の他の Web クライアントの表示まで p99 3 秒。主催者の変更から本システムの中の参加者の写しの確定まで p99 5 秒（参加者 200 人まで。それを超える分は p99 60 秒） | [ADR-0006](../decisions/0006-organizer-and-attendee-copies.md) |
| NFR-003 | リマインダー | 通知の時刻から送信の開始まで p99 30 秒（画面・Web Push）、メールの送信事業者への引き渡し p95 2 分。重複の送信 0.01% 未満、送り漏れ 0 件（予定の回からの照合で数える） | [reminders-and-notifications.md](reminders-and-notifications.md) |
| NFR-004 | 空き時間の探索 | 50 人＋会議室 20、2 週間、30 分刻みの候補の計算 p95 1 秒。1 回の空き時間の照会（カレンダー 50）p95 300ms | [free-busy-and-scheduling.md](free-busy-and-scheduling.md) |
| NFR-005 | 会議室の二重予約 | 自動で承諾する会議室で、承諾した予約の重なり 0 件 | DB の排他の制約（[ADR-0019](../decisions/0019-room-booking-rows-and-recurring-acceptance.md)） |
| NFR-006 | 可用性 | 予定の読み書き（Web・API・CalDAV）月間 99.9%。リマインダーの時刻どおりの送信 月間 99.9%。予約ページ 月間 99.9% | 本家の Workspace の SLA は Calendar を含め月間 99.9%（[Google Workspace SLA](https://workspace.google.com/terms/sla/)、2026-10-04 に確認） |
| NFR-007 | 耐久性と障害 | 確定を返した変更を失わない。AZ の障害で RPO 0・RTO 5 分以内。リージョンの障害で RPO 1 分以内・RTO 1 時間以内 | リージョンの切り替えでは `sync_epoch` を上げ、全クライアントに差分の取り直しを求める（[ADR-0005](../decisions/0005-change-log-and-sync-tokens.md)） |
| NFR-008 | テナントと権限の分離 | 他のテナントの予定、空き時間だけの共有の予定の中身、`private` の予定の中身が、画面・API・CalDAV・ICS・検索・通知・Webhook に届いた事象 0 件 | [ADR-0004](../decisions/0004-tenancy-and-rls.md) |
| NFR-009 | 時刻の正しさ | 繰り返しの展開で、参照の実装との説明のつかない食い違い 0 件。tzdb の版の採用から 24 時間以内に、影響する未来の回を計算し直す。施行の 7 日以上前に公表された変更で、施行の後の時刻の誤り 0 件 | [ADR-0002](../decisions/0002-time-representation.md)、[ADR-0003](../decisions/0003-recurrence-storage-and-expansion.md)、[quality.md](../quality.md) |
| NFR-010 | 差分の同期 | 変更 1,000 件以下の差分の応答 p99 1 秒。同期のトークンは最後の利用から 30 日は使える。取り直しの要求（410）は、トークンの期限切れ・ACL の変更・`sync_epoch` の更新のときだけ | [ADR-0005](../decisions/0005-change-log-and-sync-tokens.md)。本家のトークンの有効の期間は未検証 |
| NFR-011 | iMIP | 外部への招待のメールの送信事業者への引き渡し p95 60 秒。外部からの返事の取り込み p95 2 分 | [invitations-and-itip.md](invitations-and-itip.md) |
| NFR-012 | Webhook と検索 | Webhook の通知の最初の送信 p95 30 秒、少なくとも 1 回届ける。変更から検索に出るまで p95 30 秒、検索の応答 p99 1 秒。日本語の部分一致で取りこぼさない | [api-and-push.md](api-and-push.md)、[search.md](search.md) |

## 4. 技術スタック

| 層 | 選定 | 理由 |
| --- | --- | --- |
| 言語 | TypeScript（サーバー・Web クライアント・共有のパッケージ） | 他の題材と同じ。展開とタイムゾーンの計算を、サーバーとクライアントで同じコードにする（[ADR-0001](../decisions/0001-platform-and-stack.md)） |
| HTTP・検証 | Hono＋Zod | 他の題材と同じ |
| 公開 API | REST と JSON。形は本家の API の振る舞いに寄せ、名前は独自にする | [ADR-0026](../decisions/0026-public-rest-api-shape.md) |
| CalDAV | Hono の上に WebDAV のメソッド（`PROPFIND`・`REPORT`・`PUT`・`DELETE` など）を自前で書く。XML は第三者の汎用のパーサー | [ADR-0007](../decisions/0007-interop-standards-scope.md) |
| iCalendar | 自前のパーサーと書き出し（`packages/ical`）。行の折り返し、エスケープ、VTIMEZONE を含む | [ADR-0001](../decisions/0001-platform-and-stack.md)、[ADR-0007](../decisions/0007-interop-standards-scope.md) |
| 繰り返しの展開 | 自前（`packages/recurrence`）。参照の実装（libical を第一の候補）はテストにだけ使う | [ADR-0003](../decisions/0003-recurrence-storage-and-expansion.md) |
| タイムゾーン | 自前の変換（`packages/tz`）と、版を固定した tzdb のデータ（`packages/tzdata`。IANA の tzdb を zic で遷移の表にしたもの）。サーバーとクライアントで同じ版 | [ADR-0002](../decisions/0002-time-representation.md) |
| Web クライアント | React、TanStack Router・Query、IndexedDB（最近の範囲のキャッシュ） | [ADR-0038](../decisions/0038-web-calendar-rendering-and-local-expansion.md) |
| DB | Aurora PostgreSQL 18、FORCE RLS と `SET LOCAL`、ID は UUIDv7。拡張は `btree_gist`（会議室の排他の制約）、`pg_bigm`（日本語の検索）、`pg_partman`（展開の索引と変更のログの分割） | [ADR-0004](../decisions/0004-tenancy-and-rls.md)。拡張が Aurora PostgreSQL 18 で使えることは確かめた（[Extension versions](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraPostgreSQLReleaseNotes/AuroraPostgreSQL.Extensions.html)、2026-10-04） |
| キャッシュ・合図 | ElastiCache Valkey（pub/sub、空き時間のキャッシュ、レート制限、1 カレンダーの書き込みの枠） | 他の題材と同じ。失ってよい部品 |
| 非同期 | transactional outbox → SNS・SQS | 他の題材と同じ |
| メール | Amazon SES（送信と受信。受信は東京を主、大阪を副の MX にする。どちらも受信を使える。[SES endpoints and quotas](https://docs.aws.amazon.com/general/latest/gr/ses.html)、2026-10-04 に確認） | [ADR-0015](../decisions/0015-imip-addressing-and-trust.md)、[ADR-0043](../decisions/0043-accounts-network-ingress-and-service-placement.md) |
| Web Push | 標準の Web Push（VAPID）。配信はブラウザの事業者のサービス | [ADR-0031](../decisions/0031-notification-channels-and-content.md)。法務の L1・L4 |
| 実行基盤 | AWS（東京、DR は大阪）、ECS Fargate | 他の題材と同じ |
| IaC | Terraform | 他の題材と同じ |
| 可観測性 | OpenTelemetry（ADOT）→ AMP、X-Ray、CloudWatch Logs、Managed Grafana | 他の題材と同じ |
| フラグ | AWS AppConfig | 他の題材と同じ |
| テスト | Vitest、fast-check（展開・タイムゾーン・同期の性質）、参照の実装との差分テスト、Testcontainers、Playwright、CalDAV のクライアントの相互運用の試験 | [quality.md](../quality.md) |

## 5. 主な決定

どれも `accepted`。0001〜0007 は最初の設計の起票、0008〜0049 は領域の文書の工程で起票した。統合の工程で 0002・0003・0004・0006・0007・0008・0011・0012・0014・0015・0021・0024・0026・0027・0029・0030・0035・0036・0037・0038・0040・0043・0045・0046・0047・0049 を直した。決定を覆した直しには、日付付きの注記を残した（[process.md](../../../../docs/process.md) の 9 節の例外）。状態の一覧は [decisions/README.md](../decisions/README.md)。番号の欠けはない。

| ADR | 決定 |
| --- | --- |
| [0001](../decisions/0001-platform-and-stack.md) | 共通の基盤の上に、繰り返しの展開・タイムゾーン・iCalendar・CalDAV・招待の整合を自前で作る。クライアントは Web の SPA で、モバイルは MVP では CalDAV で覆う |
| [0002](../decisions/0002-time-representation.md) | 時刻つきの予定は壁時計の時刻＋TZID を正にし、UTC の瞬間は `tzdata_version` つきの派生の値にする。終日は日付、浮動は浮動のまま持つ。tzdb は版を固定してサーバーとクライアントに配る |
| [0003](../decisions/0003-recurrence-storage-and-expansion.md) | 予定オブジェクト（マスター＋`RECURRENCE-ID` の上書き）を保存の単位にし、範囲（過去 31 日から未来 548 日）の回を展開の索引に写す。「これ以降」は系列を `UNTIL` で切って新しい UID に分ける |
| [0004](../decisions/0004-tenancy-and-rls.md) | 組織と個人をテナントにし、FORCE RLS で分ける。カレンダーの ACL と予定の公開範囲を `can()`・`redact()` の 1 つのモジュールで判定する |
| [0005](../decisions/0005-change-log-and-sync-tokens.md) | カレンダーごとに単調な `change_seq` と変更のログを持ち、Web・公開 API・CalDAV・Webhook の差分の同期の背骨にする。トークンは署名つきで、30 日を過ぎたら取り直しを求める |
| [0006](../decisions/0006-organizer-and-attendee-copies.md) | 参加者ごとに写しを持ち、主催者の写しを正にする。本システムの中の参加者にも内部の iTIP のメッセージで配り、外部の参加者には同じ意味を iMIP で送る |
| [0007](../decisions/0007-interop-standards-scope.md) | iCalendar・iTIP・iMIP・CalDAV・WebDAV の同期の対応の範囲を決める。`free-busy-query`・`MKCALENDAR`・VTODO・`RSCALE`・`COUNTER` は MVP で持たない |
| [0008](../decisions/0008-recurrence-expansion-semantics.md) | `expand()` は規則を壁時計の時刻で求め、無効な日付は捨てる。存在しない時刻は捨てずに RFC 5545 の 3.3.5 節でずらす。DTSTART は最初の回として `COUNT` に数え、長さは DTEND なら正確な長さ、DURATION なら名目の長さで当てる |
| [0009](../decisions/0009-series-edit-and-override-rebasing.md) | 上書きは「マスターから切り離した項目」の印を持ち、系列の全体の変更では印のない項目だけを追従させる。開始・規則が変わったら、上書きと EXDATE を同じ日付の回へ付け替え、行き先のないものは捨てて示す |
| [0010](../decisions/0010-occurrence-index-maintenance.md) | 展開の索引は予定オブジェクトごとに `indexed_through` を持ち、`expander` が毎日、端を進めた分だけ足す。書き込みでは回の集合の差分だけを書き、行の `object_version` は行が最後に変わった版にする。照合は毎時の抜き取りで、不一致は索引だけを作り直す |
| [0011](../decisions/0011-inbound-recurrence-normalization.md) | 対応しない繰り返しの入力は経路で扱いを分ける。API と CalDAV の `PUT` は拒否し、ICS の取り込み・購読と iMIP の受信は `HOURLY` 以下の規則を範囲の中の RDATE に変えて UID を保つ。`RANGE=THISANDFUTURE` は 1 回分の上書きとして当てて利用者に示す |
| [0012](../decisions/0012-tzdb-update-recompute-and-propagation.md) | tzdb の版の採用の後、会議室の予約の行を先に、次に施行の近い順に予定を計算し直す。版を上げて変更のログに載せるが `SEQUENCE` は上げない。外部の参加者には施行の後に回がある予定だけ同じ `SEQUENCE` の `REQUEST` を送り、会議室の重なりは「要確認」にする |
| [0013](../decisions/0013-external-timezone-definitions.md) | 外から来た TZID は、正規の名前、別名、製品の接頭辞、Windows のゾーン名、VTIMEZONE の遷移の照合の順で IANA のゾーンに解き、解けなければ近いものに寄せて印を付ける。知っている TZID の VTIMEZONE は使わず、書き出す VTIMEZONE は本システムの tzdb から作る |
| [0014](../decisions/0014-itip-state-transfer-and-sequence.md) | 内部の iTIP のメッセージは受け手に見せてよい形の予定オブジェクトの全体を運び、新旧を `(SEQUENCE, 主催者の版)` で決める。`SEQUENCE` は RFC 5546 の 2.1.4 節の項目に場所と参加者の削除を足して上げ、日時が変わったら出欠を `needs_action` に戻し、戻す前の `SEQUENCE` への返事は捨てる |
| [0015](../decisions/0015-imip-addressing-and-trust.md) | 外部への招待の ORGANIZER は予定ごとの受け口のアドレスにして返事を本システムで受け、人の返事は Reply-To で主催者へ向ける。受信は From と ATTENDEE・ORGANIZER の一致と DKIM か SPF の揃いで確かめ、満たさないものは当てない。外部からの招待は転送の受け口で受け、知らない送信元は保留にする |
| [0016](../decisions/0016-group-invitation-expansion.md) | グループの招待は、主催者の写しにグループの項目と展開したメンバーを持ち、メンバーの変化は今より後に回がある予定にだけ 15 分ごとのジョブで当てる。入れ子は 10 段、展開は 1 予定 10,000 人まで。200 人を超える予定の配送はバッチにして p99 60 秒にする |
| [0017](../decisions/0017-freebusy-source-and-cache.md) | 空き時間は、人は展開の索引から、会議室は予約の行から求める。キャッシュは Valkey にカレンダーと UTC の週ごとの区間の一覧を、計算した時の `change_seq`（会議室は `booking_seq`）と一緒に置き、読む時に番号を比べて確かめる。テナントをまたぐ照会は相手のテナントの関数 `freebusy_for` を区間だけ返す形で呼ぶ |
| [0018](../decisions/0018-find-a-time-algorithm.md) | 候補の計算は区間の一覧を 5 分刻みのビットの列と累積の和に直し、刻みごとの開始を、必須の人の重なり、勤務の時間の外、仮の予定、任意の人の空き、会議室の合い方、早さの辞書の順で並べ、全員が空いた候補 10 件と 1 人だけ重なる候補 3 件までを返す |
| [0019](../decisions/0019-room-booking-rows-and-recurring-acceptance.md) | 会議室の予約は範囲の中の回ごとの行にし、`btree_gist` の排他の制約で承諾どうしの重なりを拒む。予約は主催者の書き込みのトランザクションで会議室の行をロックしてから行い、繰り返しは重なる回が半分以下かつ 8 回以下なら系列を承諾してその回だけ辞退し、超えれば全体を辞退する |
| [0020](../decisions/0020-room-approval-and-needs-review.md) | 承認の要る会議室の予約は「承認の待ち」の行にして制約の外に置き、管理者の承認で承諾の行に変える。tzdb の計算し直しで承諾どうしが重なったら、後から承諾したほうを「要確認」にして制約の外に出し、主催者と管理者に知らせて自動では辞退しない |
| [0021](../decisions/0021-effective-role-and-redact-table.md) | 実際のロールは持ち主、ACL の行と暗黙の行の最大、組織の外への上限の最小の順で求める。`redact()` は「全体・参加者を除く全体・区間だけ・返さない」の 4 段で返し、区間だけの形は時刻の構造と見る人ごとの不透明な ID だけを持つ。公開範囲はマスターだけが持ち、テナントをまたぐ共有のカレンダーへの書き込みはカレンダーのテナントで `packages/writer` を通す |
| [0022](../decisions/0022-delegation-and-acting-on-behalf.md) | 代理の人は主のカレンダーに `writer` 以上を持つ人とし、持ち主の名前で予定を作り出欠を返せる。iTIP では `SENT-BY` に代理の人を入れ、監査ログに操作した人と代わりに操作した相手を残す。代理の人は持ち主の `private` の予定の中身も見られる |
| [0023](../decisions/0023-caldav-resource-model-and-conditional-writes.md) | CalDAV は主体・ホーム・コレクション・リソースの 4 層で出し、共有のカレンダーは見る人のホームに同じ ID で出す。ETag は版と見え方の記号、正規化したら `PUT` に ETag を返さない。`sync-collection` は 1,000 件で切って 507 で続ける。空き時間だけのカレンダーは出さない |
| [0024](../decisions/0024-caldav-implicit-scheduling.md) | CalDAV の `PUT` は、主催者の写しなら暗黙のスケジュールで配り、参加者の写しなら旧と新の差を取って自分の項目だけを受ける。`SCHEDULE-AGENT=CLIENT` は外部の参加者にだけ従う。参加者の写しに `Schedule-Tag` を出し、受信箱・送信箱は空にする |
| [0025](../decisions/0025-ics-subscriptions-both-directions.md) | 取り込む ICS の購読は購読ごとの読み出し専用のカレンダーに写し、egress の経路で条件つきに取り、内容のハッシュで差分だけを書く。公開する ICS は持ち主が出す秘密のアドレスで、見え方は全体か空き時間だけ、組織の方針で止められ、作り直すと古いアドレスは 404 になる |
| [0026](../decisions/0026-public-rest-api-shape.md) | 公開の REST API は本家の API の振る舞いに寄せた JSON で `/v1` に出し、自社の画面も同じものを使う。予定オブジェクトを単位に、繰り返しは RFC 5545 の行、回は壁時計の `recurrence_id` の ID で表す。`syncToken` は予定オブジェクトの単位で絞りと一緒に使えない。書き込みは `If-Match` と `Idempotency-Key` を受ける |
| [0027](../decisions/0027-oauth-apps-scopes-and-rate-limits.md) | OAuth 2.0 は認可コードと PKCE（S256 を必須）で、アクセストークン 1 時間、リフレッシュトークンは使うたびに入れ替えて再利用で一式を取り消す。範囲は 4 つ。組織はアプリの認可を絞れる。レート制限は（アプリ, 利用者）1 分 600・（アプリ, テナント）1 分 10,000・利用者の書き込み 1 分 120 で、超えたら 429 |
| [0028](../decisions/0028-push-channels-signed-webhooks.md) | Webhook は `watch` で作る通知の経路で、期限は既定 7 日・最大 30 日、自動の更新はしない。本文のない `POST` に `<Brand>-*` のヘッダーと経路ごとの秘密の HMAC の署名を付け、経路ごとに 1 秒 1 回にまとめ、24 時間失敗し続けたら止める。送る前に権限を確かめ、見られなくなったら `not_exists` を送って止める |
| [0029](../decisions/0029-reminder-clock-buckets-and-timer-wheel.md) | リマインダーの時計は、Aurora の分の桶の表（256 のシャード）と、シャードを借りたタスクのメモリーのタイマーホイールの組み合わせにする。発火は計画の行の claim と送信の記録への一意の鍵の挿入で行い、挿入できたものだけを送る。15 分を超えて遅れたものは送らずに数える |
| [0030](../decisions/0030-reminder-planning-horizon-and-replan.md) | リマインダーは 7 日先までの回だけを計画し、毎時に端を進める。予定・出欠・設定・タイムゾーン・tzdb の変更は `reminder.replan` で（利用者, 予定オブジェクト）の待ちの行を作り直す。終日と浮動の予定は壁時計で分を引く。送信の記録の鍵は（利用者, 予定オブジェクト, `recurrence_id`, 方法, 分, 回の開始）で、版は鍵に入れない |
| [0031](../decisions/0031-notification-channels-and-content.md) | 通知は画面・Web Push・メールの 3 つの経路で、送る時に `redact()` と出欠を確かめ直す。Web Push の本文は通知の ID だけにし、Service Worker が中身を本システムから取る。予定の事象の通知は受け手と予定ごとに 2 分まとめ、毎朝の一覧は利用者のタイムゾーンの 06:00 に計画の表から送る |
| [0032](../decisions/0032-booking-slot-computation.md) | 予約ページの枠は、持ち主のタイムゾーンの壁時計の受け付けの時間から、受け付けの期間・最短の予告・1 日の上限で絞り、空き時間の部品の予定あり（仮の予定を含む）と既存の予約の区間を引いて求める。間の時間は 1 つの値で前後に要る。応答は枠の UTC だけ |
| [0033](../decisions/0033-booking-creation-and-exclusion.md) | 予約は持ち主の主のカレンダーの行をロックする 1 つのトランザクションで確かめ直して作り、`booking_reservations` の持ち主と区間の排他の制約で予約どうしの重なりを DB で 0 にする。メールの確認は 10 分の仮押さえで塞ぐ。予約者は外部の参加者として ICS つきのメールを受ける。ボットの対策は AWS WAF |
| [0034](../decisions/0034-search-pg-bigm-acl-aware.md) | S1 の検索は Aurora の `pg_bigm` で行い、予定オブジェクトのマスターと上書きごとの検索の表に正規化した文字列と `is_private` を持つ。権限は `searchScope(actor)` のカレンダーの 2 つの集合で絞って `redact()` で確かめ直す。索引は outbox から非同期に更新し、件数の合計を返さない |
| [0035](../decisions/0035-accounts-auth-library-and-credentials.md) | 認証の部品に Better Auth を使い `packages/auth` で包む。アカウントは RLS の外に置き、1 つのアカウントを 1 つのテナントの利用者に結ぶ。ログインはメールのコードとリンク・パスキー・Google・組織の SSO で、パスワードを持たない。CalDAV は `<brand>_ap_` のアプリ用のパスワードで、CalDAV だけの範囲・最長 1 年 |
| [0036](../decisions/0036-org-domains-sso-and-scim.md) | 組織のドメインは DNS の TXT で確かめて毎日確かめ直す。SSO はドメインごとに SAML 2.0 か OIDC の IdP を 1 つ持ち、SP 起点だけ・署名を必須にし、必須にしても特権の管理者はパスキーで入れる。確認したドメインの個人のアカウントは本人の同意で組織へ移す。SCIM 2.0 は SSO の後に足す |
| [0037](../decisions/0037-admin-roles-delegation-and-event-access.md) | 管理の役割を 6 つにし、`super_admin` 以外はグループの範囲に委任できる。役割は予定の中身を見る権限を含まない。管理者による従業員の予定の閲覧は、法務の L8 の結論までフラグの裏に置き、理由と期間を書いた閲覧の許可・`can()` の入力・監査ログの記録の仕組みだけを作る |
| [0038](../decisions/0038-web-calendar-rendering-and-local-expansion.md) | Web の画面は、予定オブジェクトを窓つきの差分の同期で持ち、回は手元の `expand()` で作る。tzdb はサーバーの版のゾーンのデータを版つきの URL から取る。重なる予定は、日ごとの重なりの塊に貪欲に列を割り当てて右へ広げる決定的な配置で描く |
| [0039](../decisions/0039-offline-read-cache-and-local-data.md) | Web の画面のオフラインは読み出しだけにし、アカウントごとの IndexedDB に前後 4 週の予定オブジェクトとトークンとゾーンのデータを持つ。手元の DB は捨ててよい写しとし、版が変われば作り直す。ログアウト・セッションの取り消し・30 日の不使用で消し、共有の端末では保存しない |
| [0040](../decisions/0040-untrusted-calendar-input-gate.md) | 外から来る iCalendar・メール・URL は、経路ごとの上限の表を解析の前に当て、時間とメモリーを切った隔離の worker thread で `packages/ical` を動かし、正規化した形だけを `packages/writer` に渡す。外へ出す iCalendar とメールのヘッダーは、利用者の文字を必ずエスケープして作る |
| [0041](../decisions/0041-encryption-keys-and-secret-storage.md) | 保存時の暗号化は、データの種類ごとの KMS の鍵（マルチリージョン）で行い、テナントごとの鍵と予定の項目の暗号化は持たない。本システムの秘密は、受け取って照らすだけのもの（アプリ用のパスワード、トークン、ICS の秘密のアドレス）を SHA-256 の照合の値で、平文が要るもの（Webhook の署名の秘密、同期のトークンの鍵、VAPID の鍵）を封筒の暗号化で持ち、平文で DB に置かない |
| [0042](../decisions/0042-audit-log-and-data-lifecycle.md) | 監査ログは、テナントの監査（Aurora、既定 1 年）とプラットフォームの監査に分け、どちらも log-archive へハッシュの連鎖つきで写す。変更のログを監査ログの代わりにしない。保持の期間を 1 つの表（`retention_policies`）で持ち、時間で消えるものは分割を落とし、テナントの解約は 30 日の猶予の後に `tenant_id` で消す。値は法務の L5 の後に確定する |
| [0043](../decisions/0043-accounts-network-ingress-and-service-placement.md) | AWS のアカウントとネットワークは他の題材の形を引き継ぐ。画面・API・予約ページは CloudFront を通し、CalDAV は WebDAV のメソッドを通すため CloudFront を通さず WAF つきの ALB で受ける。iMIP は東京の SES の受信を主、大阪を副の MX にする。利用者の決める宛先（ICS の購読、Webhook）は egress の経路から、Web Push は配信のサービスの許可リストだけへ出す |
| [0044](../decisions/0044-disaster-recovery-and-calendar-side-effects.md) | リージョンの障害は大阪のウォームスタンバイへ人の判断で切り替え、書き込みを止めてから昇格し、`sync_epoch` を上げる。失った範囲の外への副作用は、外部への iMIP の次の送信で `SEQUENCE` を 1 つ余分に上げること、リマインダーの送信の重複を数えて SLO から分けること、で扱う |
| [0045](../decisions/0045-stage-up-criteria-tenant-sharding-and-cells.md) | 段階を上げる判断は、ピークの書き込みと読み出し、Aurora の writer の CPU、配送の遅れ、リマインダーの集中の指標で行う。S2 はテナントを単位に Aurora のクラスタへ分け、テナントの外のディレクトリ（テナント → クラスタ、メールアドレス → アカウント）を小さなクラスタに置く。テナントをまたぐ処理は、内部の iTIP を SQS、空き時間を内部の RPC にする。S3 はスタックをセルにし、テナントをセルとリージョンに固定する |
| [0046](../decisions/0046-sli-from-ledgers-and-delivery-tracing.md) | 正しさと遅れの SLI は、トレースの抜き取りではなく、業務の記録（リマインダーの送信の記録、配送の記録、iMIP の送信の記録、トークンの使用の記録）から全件で数える。リマインダーの遅れは「回の通知の時刻」から「送信の開始」までにし、送らなかったものと遅れすぎたものを悪いイベントに数える。招待は `msg_id` を主催者のコミットから参加者の写し・iMIP・SES の事象まで運んで結ぶ |
| [0047](../decisions/0047-time-shaped-capacity-and-calendar-write-admission.md) | 負荷のモデルは時刻の形（月曜の朝、毎時 0 分・30 分の前後、年度の始め）を持ち、反応のオートスケールに頼らず、時刻で先に広げる。リマインダーは数分前に送る準備を済ませて時刻に放つ。1 カレンダーの書き込みは `origin` ごとの枠で割り当て、利用者の書き込みを最優先にし、tzdb の再計算・配送・取り込みを後にする |
| [0048](../decisions/0048-ci-gates-and-caldav-client-compatibility.md) | CI の関門は変更のパスで足し、外すラベルを持たない。展開と参照の性質ベーステスト、tzdb の版の差分、`redact()` の経路の性質、記録した CalDAV・iMIP の通信の再生を PR の必須にする。CalDAV のクライアントとの互換は、PR の再生、夜間の実物のクライアントの試験場（macOS・iOS のシミュレーター・Android のエミュレーター）、リリースの前の手動の表の 3 段で確かめる |
| [0049](../decisions/0049-tzdata-rollout-and-schema-change-ordering.md) | tzdb の新しい版は、前の版と一緒にイメージに入れて先にデプロイし、AppConfig の `tzdata.active_version` を全サービスで一度に切り替えて採用する。Web のクライアントは版つきの URL からゾーンのデータを取るので、資産のデプロイを待たない。スキーマの変更は、広げる・移る・縮める・消すの順にし、展開の索引のような作り直せる表は、影の表を作って入れ替える |

領域ごとの ADR は、7 節の番号の範囲で起票した。リポジトリ共通の決定（開発プロセス、ブランチモデル、本家の名前・接頭辞を使わない規則の [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)、本家の実装を核に使わない規則の [ADR-0007](../../../../docs/decisions/0007-no-reuse-of-original-implementation.md)）は、ルートの [docs/decisions/](../../../../docs/decisions/README.md) にある。

## 6. リスクと未解決事項

品質の面のリスクの順位と対策は [quality.md](../quality.md) の 1 節にある。ここは設計の面のリスクを書く。

- **展開の誤り**：RRULE の組み合わせ（`BYSETPOS`、`BYWEEKNO`、月末の `BYMONTHDAY=-1`、`WKST`、閏年の 2 月 29 日）、例外との重なり、夏時間の切り替えの存在しない時刻・2 回ある時刻で、回が増える・欠ける・ずれる。展開の意味を決め（[ADR-0008](../decisions/0008-recurrence-expansion-semantics.md)）、参照の実装との性質ベーステストと、展開の索引とその場の展開の本番の照合で抑える（[ADR-0010](../decisions/0010-occurrence-index-maintenance.md)、[quality.md](../quality.md)）。誤りは前のイメージへ戻して直す（フラグにしない）。
- **tzdb の更新の取り違え**：本システムの中は AppConfig の 1 つの値で版を揃える（[ADR-0049](../decisions/0049-tzdata-rollout-and-schema-change-ordering.md)）。外部（CalDAV のクライアント、iMIP の相手）は自分の tzdb を使うので、ずれは残る。VTIMEZONE を本システムの tzdb から作って付け（[ADR-0013](../decisions/0013-external-timezone-definitions.md)）、施行の後に回がある予定の外部の参加者へ同じ `SEQUENCE` の `REQUEST` を送る（[ADR-0012](../decisions/0012-tzdb-update-recompute-and-propagation.md)）。切り替えの窓では、会議室の排他の制約が新旧の版の区間を比べる（ADR-0012 の「切り替えの窓」）。
- **招待の写しの食い違い**：配送の遅れ・順序の入れ替わり・重複で、参加者の写しが古い版のまま残る。状態の転送と `(SEQUENCE, 主催者の版)` で古いメッセージを捨て（[ADR-0014](../decisions/0014-itip-state-transfer-and-sequence.md)）、毎日の照合のジョブで直す（[ADR-0006](../decisions/0006-organizer-and-attendee-copies.md)）。
- **大きな招待の配送**：グループの招待で参加者が数千人になると、1 回の変更で数千の写しを書く。200 人を超える予定は `itip-bulk` のバッチにし、p99 60 秒にした。グループの展開の上限は MVP で 10,000 人（本家は 100,000 人。[ADR-0016](../decisions/0016-group-invitation-expansion.md)）。
- **会議室の二重予約と繰り返し**：排他の制約は、展開の索引の範囲の中の回にしか効かない。範囲の外の会議室の予約を受けない（未来 548 日まで）。範囲の端のジョブが止まったら `indexed_through` より先の予約を受けない（[ADR-0019](../decisions/0019-room-booking-rows-and-recurring-acceptance.md)）。
- **リマインダーの集中**：毎時 50 分 00 秒の 1 秒に約 12 万件が来る（[capacity.md](capacity.md) の 3 節）。時刻で先に広げ（[ADR-0047](../decisions/0047-time-shaped-capacity-and-calendar-write-admission.md)）、送信の記録の一意の鍵で重複を消す（[ADR-0029](../decisions/0029-reminder-clock-buckets-and-timer-wheel.md)、[ADR-0030](../decisions/0030-reminder-planning-horizon-and-replan.md)）。
- **差分の同期の欠け**：ログに載らない書き込みがあると、クライアントは変化に気づかない。すべての書き込みを `packages/writer` に通し、DB のロールで直接の `UPDATE` を拒む（[ADR-0005](../decisions/0005-change-log-and-sync-tokens.md)）。番号の欠けを監視する（[runbooks/README.md](../runbooks/README.md) の 4 節）。
- **権限の漏れ**：経路（CalDAV の `calendar-data`・`text-match`、ICS の公開、検索、通知、Webhook、Web の手元の DB）ごとに漏れうる。`redact()` を 4 段の 1 つの決定表にし（[ADR-0021](../decisions/0021-effective-role-and-redact-table.md)）、漏れの経路の表と応答の監査で確かめる。
- **テナントをまたぐ経路の増加**：領域の工程で経路が増えた。[ADR-0004](../decisions/0004-tenancy-and-rls.md) の許可リスト（X1〜X11）と RLS の外の表の一覧に限り、CI で照らす。
- **外からの入力**：iMIP の偽の返事、迷惑な招待、巨大な ICS、展開の爆発、SSRF。上限の表と隔離の解析（[ADR-0040](../decisions/0040-untrusted-calendar-input-gate.md)）、送信元の確かめ（[ADR-0015](../decisions/0015-imip-addressing-and-trust.md)）、egress の専用の経路（[ADR-0043](../decisions/0043-accounts-network-ingress-and-service-placement.md)）で抑える。
- **CalDAV のクライアントの差**：OS ごとに、繰り返しの例外の送り方、VTIMEZONE の有無、`If-Match` の扱いが違う。再生・試験場・手動の 3 段で確かめる（[ADR-0048](../decisions/0048-ci-gates-and-caldav-client-compatibility.md)）。
- **法令**：法務の確認待ちの事項がある（[intent.md](../intent.md) の「法務の確認待ち」の L1〜L10）。結論が出るまで、そこに挙げた Epic の spec を承認しない。

### 決定（2026-10-04、既定案）

PM の方針（本家に寄せ、判断が要るところは推奨の既定案で進める）により、最初の設計で次のとおり決めた。その後の領域の工程と統合の工程での変更は、下の「統合」の節にある。法務の判断が要るものは決めず、[intent.md](../intent.md) の「法務の確認待ち」に残した。どれも E1〜E12 の PoC・試験で覆りうる。

- **モバイル**：MVP はネイティブのアプリを作らず、Web の画面（スマートフォンの幅に対応）と、OS の標準のカレンダー（CalDAV）で覆う（[ADR-0001](../decisions/0001-platform-and-stack.md)）。
- **Web の画面のオフライン**：最近の範囲（前後 4 週）の読み出しだけ。オフラインでの書き込みは MVP で持たない（[ADR-0039](../decisions/0039-offline-read-cache-and-local-data.md)）。
- **リアルタイム**：WebSocket は「変わった」の合図だけを送り、中身は差分の同期で取る（[ADR-0005](../decisions/0005-change-log-and-sync-tokens.md)）。
- **会議室の二重予約**：会議室の予約の行（`resource_bookings`）に、会議室と時刻の区間の `btree_gist` の排他の制約を付ける（[ADR-0019](../decisions/0019-room-booking-rows-and-recurring-acceptance.md)）。
- **検索**：S1 は Aurora の `pg_bigm` で、新しい部品を足さない（[ADR-0034](../decisions/0034-search-pg-bigm-acl-aware.md)）。
- **リマインダーの時計**：Aurora の計画の表と、シャードごとのメモリーのタイマーホイール（[ADR-0029](../decisions/0029-reminder-clock-buckets-and-timer-wheel.md)）。EventBridge Scheduler の 1 回ごとのスケジュールは採らない。
- **CalDAV の認証**：OAuth 2.0 の Bearer と、CalDAV 専用のアプリ用のパスワードの Basic 認証。ログインのパスワードは CalDAV に使わない（[ADR-0035](../decisions/0035-accounts-auth-library-and-credentials.md)。本家との意図した違い。1.4 節）。
- **Webhook の通知の期限**：既定 7 日、最大 30 日。自動の更新はしない。中身を入れず、`<Brand>-*` のヘッダーと署名を付ける（[ADR-0028](../decisions/0028-push-channels-signed-webhooks.md)）。
- **ICS の購読**：既定 6 時間ごと、条件つきで取る。1 回 10 MiB・予定 5 万件まで（[ADR-0025](../decisions/0025-ics-subscriptions-both-directions.md)）。
- **上限**：タイトル 1,024 文字、説明 64 KiB、直接の参加者 1,000 人、グループの展開 10,000 人、1 つの予定オブジェクトの上書き 1,000 件・RDATE 1,000 件・EXDATE 5,000 件、リマインダーは参加者ごとに 5 件・0〜40,320 分（本家の API と同じ。[Events resource](https://developers.google.com/workspace/calendar/api/v3/reference/events)、2026-10-04 に確認）。
- **祝日**：「日本の祝日」をシステムの公開のカレンダーとして配る。法の規則からの生成を正にし、内閣府の CSV を照合に使う（[time-zones-and-holidays.md](time-zones-and-holidays.md) の 9 節。CSV の利用の条件は法務の L7）。
- **本家の名前**：識別子は `<Brand>`・`<brand>`（リポジトリ共通の ADR-0006）。iCalendar の `PRODID` は `-//<Brand>//Calendar//JA`。

### 決定（2026-10-04、統合）

領域の文書の間の食い違いを、統合の工程で次のとおり解いた。法務の判断が要るものは決めず、[intent.md](../intent.md) の「法務の確認待ち」に残した。

- **テナントをまたぐ経路**：[ADR-0004](../decisions/0004-tenancy-and-rls.md) に、経路の許可リスト（X1 iTIP の配送、X2 空き時間、X3 共有のカレンダーの読み出し、X4 共有のカレンダーへの書き込み、X5 リマインダーの時計、X6 入口の解決、X7 tzdb の影響の探し、X8 個人から組織への移り、X9 SLI の集計、X10 Relay の outbox の読み出し、X11 ICS の購読の取得の予定）と、RLS の外の表の一覧を置いた。題材の `AGENTS.md` も同じ一覧を指す。CI は、`tenant_id` と FORCE RLS のない表、`BYPASSRLS` のロール、`SECURITY DEFINER` の関数を、この一覧と照らす。X4 は `release.cross-tenant-shared-writes` の裏で、有効にするのはテックリードの確認の後。
- **`SEQUENCE` を上げる変更**：RFC 5546 の 2.1.4 節の項目（DTSTART・DTEND・DURATION・RRULE・RDATE・EXDATE・STATUS）と TZID に、場所と参加者の削除を足したもの。[ADR-0006](../decisions/0006-organizer-and-attendee-copies.md) の一覧を [ADR-0014](../decisions/0014-itip-state-transfer-and-sequence.md) に揃え、内部の新旧の鍵を `(SEQUENCE, 主催者の版)` と書き直した。
- **RFC との意図した違い**：[ADR-0007](../decisions/0007-interop-standards-scope.md) の 1 つの表（D1〜D6）にまとめた。存在しない時刻をずらす（RFC 5545 の 3.3.10 節と違う）、S/MIME を必須にしない（RFC 6047 の 2.2.2 節と違う）、`RANGE=THISANDFUTURE` を 1 回分にする、`SCHEDULE-AGENT=CLIENT` を中の参加者に当てない、DTSTART を最初の回にする、参加者の EXDATE を辞退にする。本家との意図した違いは 1.4 節の表。
- **tzdb の切り替えと会議室**：採用は AppConfig の `tzdata.active_version` の一度の切り替え（[ADR-0049](../decisions/0049-tzdata-rollout-and-schema-change-ordering.md)）。切り替えの完了から、影響するゾーンの会議室の予約の行と予約ページの区間の計算し直しの完了までを「切り替えの窓」とし、窓の中で排他の制約が新旧の版の区間を比べることを [ADR-0002](../decisions/0002-time-representation.md) の原則の唯一の例外にした。重なりは後から承諾したほうを「要確認」、旧の版の区間とだけ重なった辞退は窓の終わりに判定し直す（[ADR-0012](../decisions/0012-tzdb-update-recompute-and-propagation.md) の注記）。runbooks の採用の手順の 2・5 を書き直し、[tzdb-update.md](../runbooks/tzdb-update.md) にした。
- **`object_version` の意味**：展開の索引の行の `object_version` は「その行が最後に変わった予定オブジェクトの版」で、照合は版でなくその場の展開との比べで行う（[ADR-0010](../decisions/0010-occurrence-index-maintenance.md)）。[ADR-0003](../decisions/0003-recurrence-storage-and-expansion.md) に反映し、索引の書き込みを「差分だけ」に直した。予定オブジェクトの版は `SEQUENCE` の元ではない。
- **1.2 節の絵**：CalDAV を CloudFront の後ろから外し、WAF つきの ALB（`alb-dav`）にした（[ADR-0043](../decisions/0043-accounts-network-ingress-and-service-placement.md)）。
- **展開・権限の不具合の戻し**：`release.recurrence-*`（events-and-recurrence の 10 節）と `release.policy-*`（sharing-and-acl の 11 節）の案をやめ、前のイメージへのロールバックにした。展開・時刻・権限の規則はフラグにしない（[runbooks/README.md](../runbooks/README.md) の 3 節、`AGENTS.md`）。
- **トークンだけを取る口**：`POST /v1/sync` に `tokensOnly` を足した。Web の画面はトークンを先に取り、次に窓の範囲の問い合わせをする（[api-and-push.md](api-and-push.md) の 4.6 節、[ADR-0026](../decisions/0026-public-rest-api-shape.md)・[ADR-0038](../decisions/0038-web-calendar-rendering-and-local-expansion.md) の注記）。
- **CalDAV の認証の失敗**：アカウントの全体を止めない。形の合わないものは数えず、取り消した・期限切れのアプリ用のパスワードはパスワードごと、合わないものは（IP, アカウント）の組ごと、全体は IP ごとに数え、超えた単位だけを止める（[sync-and-caldav.md](sync-and-caldav.md) の 6.7 節、[security.md](security.md) の CD2、[ADR-0043](../decisions/0043-accounts-network-ingress-and-service-placement.md) の注記）。
- **アラート**：tzdb の未採用、AppConfig の版の不一致（タスクの間と東京・大阪）、変更のログの欠け、SLI の集計の欠け、シークレットスキャンの通知を [runbooks/README.md](../runbooks/README.md) の 4 節に足した。
- **リマインダーの送信の記録の鍵**：（利用者, 予定オブジェクト, `recurrence_id`, 方法, 分, 回の開始）。版は鍵に入れない（[ADR-0030](../decisions/0030-reminder-planning-horizon-and-replan.md)）。1.3 節 C、`AGENTS.md`、[ADR-0046](../decisions/0046-sli-from-ledgers-and-delivery-tracing.md) を揃えた。保持は 35 日（[ADR-0042](../decisions/0042-audit-log-and-data-lifecycle.md)）に揃えた。発火は `reminder-scheduler` が行い、notifier は送るだけ（[capacity.md](capacity.md) の 3.3 節と [ADR-0047](../decisions/0047-time-shaped-capacity-and-calendar-write-admission.md) を [ADR-0029](../decisions/0029-reminder-clock-buckets-and-timer-wheel.md) に揃えた）。
- **SCIM**：MVP に含め、E4 の最後の Story として SSO の後に `release.scim` の裏で出し、GA の前に消す（[intent.md](../intent.md)、[roadmap.md](../roadmap.md)、[accounts-and-orgs.md](accounts-and-orgs.md) の 12 節、[ADR-0036](../decisions/0036-org-domains-sso-and-scim.md)）。
- **CalDAV の Basic 認証**：本家は受けない。本システムは CalDAV だけのアプリ用のパスワードで受ける。本家との意図した違いとして 1.4 節と [ADR-0035](../decisions/0035-accounts-auth-library-and-credentials.md) に書いた。
- **長く残すフラグ**：`release.*` は 100% の後 30 日で消す規則の例外を、[runbooks/README.md](../runbooks/README.md) の 3 節の一覧にした（`release.admin-event-access` は法務の L8 の結論まで、`release.cross-tenant-shared-writes` はテックリードの確認まで）。フラグの名前は `release.*` を kebab-case、`ops.*` を snake_case にした。
- **数値の揃え**：CalDAV の `PUT` の本文は 1 MiB（`max-resource-size`。XML の要求は 2 MiB。[ADR-0040](../decisions/0040-untrusted-calendar-input-gate.md) を直した）。ICS の購読の取得は約 17 万の URL・8 件/秒（capacity を直した）、取得は全体 30 秒・解析は 10 秒（security の SS4 を直した）。アプリ用のパスワードの照合の写しは 60 秒（capacity を直した）。会議室の `booking_seq` は `resources` の列（free-busy の `rooms` を直した）。
- **名前の揃え**：監査の表は `tenant_audit_events`・`platform_audit_events`、管理者の閲覧の許可は `admin_access_grants`（sharing-and-acl の `org_admin_audit` を直し、sharing-and-acl の 10 節を [ADR-0037](../decisions/0037-admin-roles-delegation-and-event-access.md) の「フラグの裏に仕組みを作る」に揃えた）。runbook の名前は [runbooks/README.md](../runbooks/README.md) の 4 節の一覧に揃えた（`tzdata-update.md` → `tzdb-update.md`、提案の別名をまとめた）。
- **品質と運用**：各領域の文書の「quality.md・runbooks・data-model への項目」を反映した。[quality.md](../quality.md) に Epic ごとの決定表と性質の一覧、漏れの経路の表の行、DR の訓練の合格基準を足した。runbooks の手順を、作ったもの（4 つ）と計画のものに分けて一覧にした。表と置き場所の索引は [data-model.md](data-model.md)。
- **数値の正本**：SLO とアラートは [runbooks/README.md](../runbooks/README.md) の 1・4 節。上限は各 ADR と runbooks の 2 節。保持の期間は [ADR-0042](../decisions/0042-audit-log-and-data-lifecycle.md) の表。負荷のモデルは [capacity.md](capacity.md) の 1 節。表と置き場所は [data-model.md](data-model.md)。
- **検証の工程での直し（2026-10-04）**：公式の資料を取得し直して、次を確かめ・直した。SES の受信は東京（`ap-northeast-1`）と大阪（`ap-northeast-3`）の両方にある。CloudFront の許すメソッドは 3 つの組から選び、`PROPFIND`・`REPORT` を含まない。ALB の規則は独自の HTTP のメソッドを条件に書ける。Aurora PostgreSQL 18（18.3・18.4・18.6）に `btree_gist` 1.6・`pg_bigm` 1.2・`pg_partman` 5.x がある。SES の受信の S3 への保存は 40 MB まで、Object Lock の既定の保持のあるバケットに書けない。本家の CalDAV は Basic 認証を 401 にする。本家の API の割り当て（1 分 10,000・600）は 2026-05-01 から新しいプロジェクトに当たる。本家の外部への約 2,000 件は「参加者にメール」の機能の数で、外部への招待は短い期間に 10,000 件（ADR-0015 の書き方を直した）。会議室の繰り返しの「半分以上・8 回以下」、グループの招待の 100,000 人と 200 人で 24 時間、予約ページの最短の予告 4 時間、Workspace の SLA の 99.9%、空き時間の照会の 50・100、RFC 5546 の 2.1.4・2.1.5 節、RFC 6047 の 2.2.2 節（S/MIME が MUST）を確かめた。tzdb のリリースには GPG の署名（`.asc`）がある（未検証を外した）。内閣府の CSV は 1955〜2027 年で、ページに利用の条件の記載はない（法務の L7 のまま）。`@better-auth/scim` の告知（1.7.0 で修正）を足した。リマインダーの終日の例（夏時間をまたがない例になっていた）を直した。
- 領域ごとの決定は、各文書の「未解決の問い」の「決定」の節にある。

### 決定（2026-10-04、データモデル）

データモデルの完全版を [data-model.md](data-model.md) と [data-model/](data-model/) に作り、形（表・列・キー・索引・分割・保持）の正本をそこへ移した。領域の文書の「data-model への項目」は提案の記録として残す。名前と列の食い違いの解き方は [data-model.md](data-model.md) の 7 節（D-1〜D-32）にある。ADR の決定は変えていない。主なものは次のとおり。

- **回の識別子と系列**：`recurrence_id` は壁時計の時刻の文字列で、系列の全体は `''`（主キーに入れるため NULL にしない）。
- **展開の索引**：`(event_object_id, recurrence_id)` の一意は、月の分割の表なので DB で強制せず、カレンダーのロックの中の差分の書き込みと照合で守る。`hidden`・`cancelled` の写しと取り消した予定は行を持たない。
- **排他の制約の表は分割しない**：`resource_bookings`・`booking_reservations` は、時刻の区間の排他の制約を分割した表に作れないので、過去の行を毎日のジョブで消す。
- **リマインダーの送信の記録**：回の開始の日（`occurrence_on`）で分割し、日をまたぐ重複も一意の鍵で捨てる。受け手は利用者か予約（`recipient_id`）。
- **`sync_epoch`**：全体の 1 つの値（`platform_state`）だけ。テナントの移りは、カレンダーの `floor_seq` を上げて古いトークンを 410 にする。
- **アカウント**：Better Auth の既定の名前（`auth.user` ほか）。`auth.user` にテナントと利用者の ID を足す。確認したドメインは `principal_directory` に `@<domain>` で入れ、ログインの入口で SSO の組織を決める。

### 決定（2026-10-04、データモデルの工程で見つけたテナントをまたぐ経路）

[ADR-0004](../decisions/0004-tenancy-and-rls.md) の許可リスト（当時 X1〜X9）にない、テナントをまたぐ処理が 4 つ見つかった。PM の方針（法務の判断が要らないものは推奨の案で進める）により、推奨の案で決め、ADR-0004 に注記つきで反映した。題材の `AGENTS.md`、[security.md](security.md)、[data-model.md](data-model.md) の 5 節も揃えた。

| # | 処理 | 決定 | 採らなかった案 |
| --- | --- | --- | --- |
| 1 | Relay が全テナントの `outbox` を読む | 経路 X10。`relay` のロールにだけ、`outbox` の `SELECT`・`DELETE` を全テナントで許す専用の RLS のポリシーを付ける。`outbox` は iTIP の本文（予定の中身）を持つので RLS の外の表にしない | `outbox` を `ops` に置き、本文を S3 に出して行を ID だけにする（書き込みが S3 を待つ） |
| 2 | OAuth のトークン（API・CalDAV の Bearer）と予約の管理のリンク（`/m/<token>`）からテナントを決める | X6 の入口に足し、解決の表 `ops.oauth_token_directory`（`token_hash` → `tenant_id`、期限）と `ops.booking_manage_directory`（`manage_token_hash` → `tenant_id`・`booking_id`）を足す | トークンの形にテナントを埋める、管理のリンクを `/p/<slug>/m/<token>` にする |
| 3 | ICS の購読の取得の予定（`next_fetch_at`）を全テナントから探す | 経路 X11。X5 と同じ形の `ops.ics_fetch_schedule`（購読の ID・テナント・次の取得の時刻・状態だけ）を足し、`ics_scheduler` のロールで読む | 全テナントを順に回す保守のジョブで 5 分ごとに回す（30 万テナントで重い） |
| 4 | テナントをまたぐ共有のカレンダーの既定のリマインダーの購読者（`calendar_list_reminder_subscribers`）を、カレンダーのテナントに書く | 経路を足さず、X4（`shared_calendar_access`）で書く。`release.cross-tenant-shared-writes` が無効の間は、テナントをまたぐ共有のカレンダーの既定のリマインダーを計画しない | 購読者を見る人のテナントに置き、計画のジョブが毎時に X3 で読みに行く |

- あわせて、S2 のディレクトリのクラスタの表（`tenant_directory`、`account_directory`）を ADR-0004 の RLS の外の表の一覧に載せた（S1 では作らない）。
- 予約者の個人情報の暗号文の鍵は、[ADR-0041](../decisions/0041-encryption-keys-and-secret-storage.md) の秘密の持ち方の表に足した（`app-secrets`、暗号化のコンテキスト `booking-pii`）。

持ち越し（法務、計測・PoC・選定・確認で決めるもの）：

| 項目 | いつ・どう決めるか |
| --- | --- |
| 法務の確認待ち（L1〜L10） | [intent.md](../intent.md) の「法務の確認待ち」。結論まで、そこに挙げた Story の spec を承認しない |
| 展開の索引の行の数と書き込みの量、1 カレンダーの書き込みの上限（50 件/秒）、Aurora の writer の大きさ | E2 の前の `occurrence-index-poc`・`calendar-write-throughput-poc`、E12 の負荷試験 |
| 繰り返しの展開の参照の実装（libical か、多数決か）と、存在しない時刻・DTSTART の扱いの違い | E2 の着手前の `recurrence-reference-survey` |
| 会議室の排他の制約の書き込みの速さ、空き時間のキャッシュの冷たいときの速さ | E6 の前の `room-exclusion-poc`・`freebusy-poc` |
| 毎時 0 分の集中での scheduler と notifier の数、Web Push の送信の時間 | E9 の前の `reminder-burst-poc` |
| 検索の索引の大きさ（160〜240 GB の見込み）と更新の量、S2 で専用の基盤へ移すか | E11 の前の `search-bigm-poc`、[search.md](search.md) の 8 節の基準 |
| 共有のカレンダーへのテナントをまたぐ書き込み（X4）を有効にするか | テックリードの確認。認めなければ組織の外・個人どうしの上限を `reader` にする |
| tzdb の切り替えの窓の長さ（`Asia/Tokyo` の最悪の量）、計算し直しの 5,000 件/秒が同期に耐えるか | E12 の `tzdata-update-drill` |
| 信頼する tzdb の署名の鍵の指紋 | E3 の `tzdata-package` |
| CalDAV のクライアントの振る舞い（507 の続き、`Schedule-Tag`、`limit-recurrence-set`、届いた VTIMEZONE を使うか、ポーリングの間隔）、Thunderbird の自動化 | E8 の相互運用の試験と `caldav-client-lab`（**未検証**） |
| 外部のカレンダーが受け口の ORGANIZER へ返事を送るか、`SENT-BY` の表示、転送で DKIM が壊れる割合と ARC | E5 の相互運用の試験と、その後の計測（**未検証**） |
| Web Push の配信のサービスのホスト名の許可リスト、iOS の PWA での Web Push の条件 | E9 の `web-push`（**未検証**） |
| ブラウザごとの `compositionend` と `keydown` の順序 | E7 の `ime-guard` の手動の確認の表（**未検証**） |
| CloudFront の標準のログで URI の経路を外せるか | E8 の `ics-publish`（**未検証**） |
| `BUSY` で RRULE を返すことの是非 | E4 のセキュリティのレビュー |
| SES の送信で TLS を必須にするか、送信の率の引き上げの上限（S2 の 1 万通/秒） | E5 の `imip-outbound`、S2 の前に AWS に確かめる（**未検証**） |
| 予約ページで空きを確かめる他のカレンダーとの同時の書き込み、WAF だけでボットを止められるか | E10 の後の計測 |
| `RANGE=THISANDFUTURE` を受け付けるか | `range_ignored` の件数を見て、MVP の後に決める |
| S2 のテナントの移動の方式、S3 で CalDAV のクライアントがリダイレクトを覚えるか | S2・S3 の着手の前に別の ADR（**未検証**） |
| データモデルの持ち越し（[data-model.md](data-model.md) の 8 節） | テックリードとセキュリティの担当。E1・E4・E10 の spec の前 |
| 本家の振る舞いで未確認のもの（「これ以降」の表し方、同期のトークンの有効の期間、ICS の購読の間隔、繰り返しの回の上限、存在しない時刻の扱い、チャネルの期限、内部の保存の形） | 公式の資料で確かめられなかった。未検証のまま、本システムの値を使う |

## 7. 領域の文書

領域の担当は、下の表の番号の範囲の中で ADR を採番した（範囲の外に出るときは、この表を先に更新する）。持ち主は、どれも Dev が書き、下の「レビュー」の列のロールが確認する。「ADR」の列は起票した番号である。

| ファイル | 範囲 | ADR | レビュー | 関わる Epic |
| --- | --- | --- | --- | --- |
| [events-and-recurrence.md](events-and-recurrence.md) | 予定オブジェクトの形、予定の種類、RRULE・RDATE・EXDATE の受け付けと上限、`expand()` の仕様、1 回分の例外、「これ以降」の分割、系列の全体の変更での上書きの付け替え、対応しない繰り返しの入力、展開の索引の書き込み・範囲の端・照合 | [0008](../decisions/0008-recurrence-expansion-semantics.md)、[0009](../decisions/0009-series-edit-and-override-rebasing.md)、[0010](../decisions/0010-occurrence-index-maintenance.md)、[0011](../decisions/0011-inbound-recurrence-normalization.md) | QA（展開の性質） | E2 |
| [time-zones-and-holidays.md](time-zones-and-holidays.md) | `packages/tz`・`packages/tzdata`、`resolve`（存在しない時刻、2 回ある時刻）、浮動の時刻、終日、tzdb の更新の採用と再計算と切り替えの窓、外への知らせ、外から来る TZID、VTIMEZONE の書き出し、日本の祝日のカレンダー、和暦の表示 | [0012](../decisions/0012-tzdb-update-recompute-and-propagation.md)、[0013](../decisions/0013-external-timezone-definitions.md) | QA | E3 |
| [invitations-and-itip.md](invitations-and-itip.md) | 主催者の写しと参加者の写し、内部の iTIP の配送と当て方、出欠と `SEQUENCE`、参加者の権限、グループの招待と展開、主催者の変更、iMIP の送信と受信（受け口のアドレス、送信元の確かめ）、取り込みの方針、送信の上限 | [0014](../decisions/0014-itip-state-transfer-and-sequence.md)、[0015](../decisions/0015-imip-addressing-and-trust.md)、[0016](../decisions/0016-group-invitation-expansion.md) | QA、セキュリティ | E5 |
| [free-busy-and-scheduling.md](free-busy-and-scheduling.md) | 空き時間の照会（人・グループ・会議室）、予定ありの判定、テナントをまたぐ照会、空き時間のキャッシュ、候補の計算、勤務の時間と祝日 | [0017](../decisions/0017-freebusy-source-and-cache.md)、[0018](../decisions/0018-find-a-time-algorithm.md) | QA、Ops | E6 |
| [rooms-and-resources.md](rooms-and-resources.md) | 建物・階・定員・設備の属性、会議室のカレンダー、予約の行と排他の制約、自動の承諾と繰り返しの一部の辞退、管理者の承認、要確認、会議室の検索と提案 | [0019](../decisions/0019-room-booking-rows-and-recurring-acceptance.md)、[0020](../decisions/0020-room-approval-and-needs-review.md) | QA | E6 |
| [sharing-and-acl.md](sharing-and-acl.md) | カレンダーの種類と ACL、実際のロールの求め方、組織の共有の方針、予定の公開範囲、`can()`・`redact()` の決定表、変化の効き方、委任（代理の人）、管理者による閲覧の枠 | [0021](../decisions/0021-effective-role-and-redact-table.md)、[0022](../decisions/0022-delegation-and-acting-on-behalf.md) | セキュリティ | E4 |
| [sync-and-caldav.md](sync-and-caldav.md) | 変更のログの保持と墓標、差分の組み立て、Web のクライアントの差分の取り方、CalDAV（発見、リソースの形、ETag・CTag、`PUT` の判定、REPORT、`sync-collection`、認証と失敗の上限）、暗黙のスケジュール、ICS の購読と公開、ICS の取り込みと書き出し | [0023](../decisions/0023-caldav-resource-model-and-conditional-writes.md)、[0024](../decisions/0024-caldav-implicit-scheduling.md)、[0025](../decisions/0025-ics-subscriptions-both-directions.md) | QA | E8 |
| [api-and-push.md](api-and-push.md) | 公開の REST API（リソース、予定の形、回の識別子、ページング、差分の同期と `POST /v1/sync`、条件つきの更新、冪等、エラー、版）、OAuth 2.0 のアプリと範囲、レート制限、Webhook の通知 | [0026](../decisions/0026-public-rest-api-shape.md)、[0027](../decisions/0027-oauth-apps-scopes-and-rate-limits.md)、[0028](../decisions/0028-push-channels-signed-webhooks.md) | QA、Ops | E8 |
| [reminders-and-notifications.md](reminders-and-notifications.md) | リマインダーの設定と対象、計画（7 日、付け替え）、時計（シャード、タイマーホイール）、送信の記録と重複の除去、送る時の確かめ、画面の通知・Web Push・メール、予定の事象の通知、毎朝の一覧、送り漏れの照合 | [0029](../decisions/0029-reminder-clock-buckets-and-timer-wheel.md)、[0030](../decisions/0030-reminder-planning-horizon-and-replan.md)、[0031](../decisions/0031-notification-channels-and-content.md) | QA、Ops | E9 |
| [booking-pages.md](booking-pages.md) | 予約ページの設定と組織の方針、枠の計算、予約の作成と排他の制約、仮押さえとメールの確認、取り消しと変更、予約者へのメール、ボットの対策、予約者の個人情報の枠（法務の L6） | [0032](../decisions/0032-booking-slot-computation.md)、[0033](../decisions/0033-booking-creation-and-exclusion.md) | QA、セキュリティ | E10 |
| [search.md](search.md) | 検索の表と `pg_bigm` の索引、正規化、権限の写し方（`searchScope`）、問い合わせと並べ方、更新、S2 の基準 | [0034](../decisions/0034-search-pg-bigm-acl-aware.md) | QA、Ops | E11 |
| [accounts-and-orgs.md](accounts-and-orgs.md) | アカウントとテナント、ログインとセッション、組織とドメインの確認、個人から組織への移り、SSO、アプリ用のパスワードとトークンの形、組織の認証の方針、ディレクトリとメールアドレスの解決、SCIM、管理の役割と委任、管理者による閲覧の枠、停止・削除と引き継ぎ | [0035](../decisions/0035-accounts-auth-library-and-credentials.md)、[0036](../decisions/0036-org-domains-sso-and-scim.md)、[0037](../decisions/0037-admin-roles-delegation-and-event-access.md) | セキュリティ | E4、E11 |
| [clients.md](clients.md) | Web の SPA の骨格、データの流れ（窓、差分、手元の展開、tzdata）、日・週・月・予定リストの表示と重なりの配置、タイムゾーンと夏時間の表示、操作、キーボードと IME、速さの予算、オフラインと手元のデータ、PWA と Web Push の登録 | [0038](../decisions/0038-web-calendar-rendering-and-local-expansion.md)、[0039](../decisions/0039-offline-read-cache-and-local-data.md) | QA | E7 |
| [security.md](security.md) | 信頼境界、脅威モデル（迷惑な招待、解析の攻撃、CalDAV の資格情報、漏れ、SSRF）、入力の検査、暗号化と鍵、秘密、監査ログ、運用者のアクセス、データのライフサイクル、試験、法務の論点の整理 | [0040](../decisions/0040-untrusted-calendar-input-gate.md)、[0041](../decisions/0041-encryption-keys-and-secret-storage.md)、[0042](../decisions/0042-audit-log-and-data-lifecycle.md) | セキュリティ | E1、E11、E12 |
| [data-model.md](data-model.md)、[data-model/](data-model/) | データモデルの正本：規約（ID、テナンシー、時刻の列、iCalendar の往復、版、分割、保持、命名、秘密）、ER 図、表の目録（列・キー・索引・CHECK・RLS・保持・量）、RLS の外の表と DB のロール、DB の外のストアの形、横断の不変条件 | なし（各領域の ADR を参照する） | QA | 全 Epic |
| [infrastructure.md](infrastructure.md) | AWS のアカウントとネットワーク、入口とホスト名、外への送信、サービスと配置、データの置き場所、台数、バックアップと DR（`sync_epoch`）、tzdb の版の配り方、段階を上げる基準、S2・S3、Terraform、コスト | [0043](../decisions/0043-accounts-network-ingress-and-service-placement.md)、[0044](../decisions/0044-disaster-recovery-and-calendar-side-effects.md)、[0045](../decisions/0045-stage-up-criteria-tenant-sharding-and-cells.md) | Ops | E1、E12 |
| [observability.md](observability.md) | 中身を出さない計装、トレース、RUM、正しさの照合と応答の監査、SLI の計測（業務の記録から）、アラートの条件、合成監視、ダッシュボード | [0046](../decisions/0046-sli-from-ledgers-and-delivery-tracing.md) | Ops | E1、E12 |
| [capacity.md](capacity.md) | 負荷のモデル（時刻の形）、1 カレンダーの書き込みの上限と割り当て、リマインダーの集中、大きな会議の空き時間、部品ごとの必要量、取り直しの殺到、台数、負荷試験 L1〜L10 | [0047](../decisions/0047-time-shaped-capacity-and-calendar-write-admission.md) | Ops | E12 |
| [delivery.md](delivery.md) | CI の関門、CalDAV のクライアントとの互換の 3 段、フラグ、サーバーのデプロイ、Web のクライアントの配布、tzdb の版の採用、スキーマの変更の順序 | [0048](../decisions/0048-ci-gates-and-caldav-client-compatibility.md)、[0049](../decisions/0049-tzdata-rollout-and-schema-change-ordering.md) | QA、Ops | E1、E3、E12 |

- 次に採番する ADR は 0050。統合の後に足す ADR は、関わる領域の行に番号を書き足す。

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

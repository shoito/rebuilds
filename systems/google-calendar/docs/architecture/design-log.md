# Design log: Google Calendar

設計の工程ごとに決めたことの記録。今の結論は [README.md](README.md) と各領域の文書と ADR にあり、ここはその経緯を残す。新しい記録は末尾に足す。

記録は README.md から本文のまま移したもので、本文の中の「1.4 節」「6 節」などの節の番号は、[README.md](README.md) の節を指す。

## 2026-10-04：既定案

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

## 2026-10-04：統合

領域の文書の間の食い違いを、統合の工程で次のとおり解いた。法務の判断が要るものは決めず、[intent.md](../intent.md) の「法務の確認待ち」に残した。

- **テナントをまたぐ経路**：[ADR-0004](../decisions/0004-tenancy-and-rls.md) に、経路の許可リスト（X1 iTIP の配送、X2 空き時間、X3 共有のカレンダーの読み出し、X4 共有のカレンダーへの書き込み、X5 リマインダーの時計、X6 入口の解決、X7 tzdb の影響の探し、X8 個人から組織への移り、X9 SLI の集計、X10 Relay の outbox の読み出し、X11 ICS の購読の取得の予定）と、RLS の外の表の一覧を置いた。題材の `AGENTS.md` も同じ一覧を指す。CI は、`tenant_id` と FORCE RLS のない表、`BYPASSRLS` のロール、`SECURITY DEFINER` の関数を、この一覧と照らす。X4 は `release.cross-tenant-shared-writes` の裏で、有効にするのはテックリードの確認の後。
- **`SEQUENCE` を上げる変更**：RFC 5546 の 2.1.4 節の項目（DTSTART・DTEND・DURATION・RRULE・RDATE・EXDATE・STATUS）と TZID に、場所と参加者の削除を足したもの。[ADR-0006](../decisions/0006-organizer-and-attendee-copies.md) の一覧を [ADR-0014](../decisions/0014-itip-state-transfer-and-sequence.md) に揃え、内部の新旧の鍵を `(SEQUENCE, 主催者のバージョン)` と書き直した。
- **RFC との意図した違い**：[ADR-0007](../decisions/0007-interop-standards-scope.md) の 1 つの表（D1〜D6）にまとめた。存在しない時刻をずらす（RFC 5545 の 3.3.10 節と違う）、S/MIME を必須にしない（RFC 6047 の 2.2.2 節と違う）、`RANGE=THISANDFUTURE` を 1 回分にする、`SCHEDULE-AGENT=CLIENT` を中の参加者に当てない、DTSTART を最初の回にする、参加者の EXDATE を辞退にする。本家との意図した違いは 1.4 節の表。
- **tzdb の切り替えと会議室**：採用は AppConfig の `tzdata.active_version` の一度の切り替え（[ADR-0049](../decisions/0049-tzdata-rollout-and-schema-change-ordering.md)）。切り替えの完了から、影響するゾーンの会議室の予約の行と予約ページの区間の計算し直しの完了までを「切り替えの窓」とし、窓の中で排他の制約が新旧のバージョンの区間を比べることを [ADR-0002](../decisions/0002-time-representation.md) の原則の唯一の例外にした。重なりは後から承諾したほうを「要確認」、旧のバージョンの区間とだけ重なった辞退は窓の終わりに判定し直す（[ADR-0012](../decisions/0012-tzdb-update-recompute-and-propagation.md) の注記）。runbooks の採用の手順の 2・5 を書き直し、[tzdb-update.md](../runbooks/tzdb-update.md) にした。
- **`object_version` の意味**：展開の索引の行の `object_version` は「その行が最後に変わった予定オブジェクトのバージョン」で、照合はバージョンでなくその場の展開との比べで行う（[ADR-0010](../decisions/0010-occurrence-index-maintenance.md)）。[ADR-0003](../decisions/0003-recurrence-storage-and-expansion.md) に反映し、索引の書き込みを「差分だけ」に直した。予定オブジェクトのバージョンは `SEQUENCE` の元ではない。
- **1.2 節の絵**：CalDAV を CloudFront の後ろから外し、WAF つきの ALB（`alb-dav`）にした（[ADR-0043](../decisions/0043-accounts-network-ingress-and-service-placement.md)）。
- **展開・権限の不具合の戻し**：`release.recurrence-*`（events-and-recurrence の 10 節）と `release.policy-*`（sharing-and-acl の 11 節）の案をやめ、前のイメージへのロールバックにした。展開・時刻・権限の規則はフラグにしない（[runbooks/README.md](../runbooks/README.md) の 3 節、`AGENTS.md`）。
- **トークンだけを取る口**：`POST /v1/sync` に `tokensOnly` を足した。Web の画面はトークンを先に取り、次に窓の範囲の問い合わせをする（[api-and-push.md](api-and-push.md) の 4.6 節、[ADR-0026](../decisions/0026-public-rest-api-shape.md)・[ADR-0038](../decisions/0038-web-calendar-rendering-and-local-expansion.md) の注記）。
- **CalDAV の認証の失敗**：アカウントの全体を止めない。形の合わないものは数えず、取り消した・期限切れのアプリ用のパスワードはパスワードごと、合わないものは（IP, アカウント）の組ごと、全体は IP ごとに数え、超えた単位だけを止める（[sync-and-caldav.md](sync-and-caldav.md) の 6.7 節、[security.md](security.md) の CD2、[ADR-0043](../decisions/0043-accounts-network-ingress-and-service-placement.md) の注記）。
- **アラート**：tzdb の未採用、AppConfig のバージョンの不一致（タスクの間と東京・大阪）、変更のログの欠け、SLI の集計の欠け、シークレットスキャンの通知を [runbooks/README.md](../runbooks/README.md) の 4 節に足した。
- **リマインダーの送信の記録の鍵**：（利用者, 予定オブジェクト, `recurrence_id`, 方法, 分, 回の開始）。バージョンは鍵に入れない（[ADR-0030](../decisions/0030-reminder-planning-horizon-and-replan.md)）。1.3 節 C、`AGENTS.md`、[ADR-0046](../decisions/0046-sli-from-ledgers-and-delivery-tracing.md) を揃えた。保持は 35 日（[ADR-0042](../decisions/0042-audit-log-and-data-lifecycle.md)）に揃えた。発火は `reminder-scheduler` が行い、notifier は送るだけ（[capacity.md](capacity.md) の 3.3 節と [ADR-0047](../decisions/0047-time-shaped-capacity-and-calendar-write-admission.md) を [ADR-0029](../decisions/0029-reminder-clock-buckets-and-timer-wheel.md) に揃えた）。
- **SCIM**：MVP に含め、E4 の最後の Story として SSO の後に `release.scim` の裏で出し、GA の前に消す（[intent.md](../intent.md)、[roadmap.md](../roadmap.md)、[accounts-and-orgs.md](accounts-and-orgs.md) の 12 節、[ADR-0036](../decisions/0036-org-domains-sso-and-scim.md)）。
- **CalDAV の Basic 認証**：本家は受けない。本システムは CalDAV だけのアプリ用のパスワードで受ける。本家との意図した違いとして 1.4 節と [ADR-0035](../decisions/0035-accounts-auth-library-and-credentials.md) に書いた。
- **長く残すフラグ**：`release.*` は 100% の後 30 日で消す規則の例外を、[runbooks/README.md](../runbooks/README.md) の 3 節の一覧にした（`release.admin-event-access` は法務の L8 の結論まで、`release.cross-tenant-shared-writes` はテックリードの確認まで）。フラグの名前は `release.*` を kebab-case、`ops.*` を snake_case にした。
- **数値の揃え**：CalDAV の `PUT` の本文は 1 MiB（`max-resource-size`。XML の要求は 2 MiB。[ADR-0040](../decisions/0040-untrusted-calendar-input-gate.md) を直した）。ICS の購読の取得は約 17 万の URL・8 件/秒（capacity を直した）、取得は全体 30 秒・解析は 10 秒（security の SS4 を直した）。アプリ用のパスワードの照合の写しは 60 秒（capacity を直した）。会議室の `booking_seq` は `resources` の列（free-busy の `rooms` を直した）。
- **名前の揃え**：監査の表は `tenant_audit_events`・`platform_audit_events`、管理者の閲覧の許可は `admin_access_grants`（sharing-and-acl の `org_admin_audit` を直し、sharing-and-acl の 10 節を [ADR-0037](../decisions/0037-admin-roles-delegation-and-event-access.md) の「フラグの裏に仕組みを作る」に揃えた）。runbook の名前は [runbooks/README.md](../runbooks/README.md) の 4 節の一覧に揃えた（`tzdata-update.md` → `tzdb-update.md`、提案の別名をまとめた）。
- **品質と運用**：各領域の文書の「quality.md・runbooks・data-model への項目」を反映した。[quality.md](../quality.md) に Epic ごとの決定表と性質の一覧、漏れの経路の表の行、DR の訓練の合格基準を足した。runbooks の手順を、作ったもの（4 つ）と計画のものに分けて一覧にした。表と置き場所の索引は [data-model.md](data-model.md)。
- **数値の正本**：SLO とアラートは [runbooks/README.md](../runbooks/README.md) の 1・4 節。上限は各 ADR と runbooks の 2 節。保持の期間は [ADR-0042](../decisions/0042-audit-log-and-data-lifecycle.md) の表。負荷のモデルは [capacity.md](capacity.md) の 1 節。表と置き場所は [data-model.md](data-model.md)。
- **検証の工程での直し（2026-10-04）**：公式の資料を取得し直して、次を確かめ・直した。SES の受信は東京（`ap-northeast-1`）と大阪（`ap-northeast-3`）の両方にある。CloudFront の許すメソッドは 3 つの組から選び、`PROPFIND`・`REPORT` を含まない。ALB の規則は独自の HTTP のメソッドを条件に書ける。Aurora PostgreSQL 18（18.3・18.4・18.6）に `btree_gist` 1.6・`pg_bigm` 1.2・`pg_partman` 5.x がある。SES の受信の S3 への保存は 40 MB まで、Object Lock の既定の保持のあるバケットに書けない。本家の CalDAV は Basic 認証を 401 にする。本家の API の割り当て（1 分 10,000・600）は 2026-05-01 から新しいプロジェクトに当たる。本家の外部への約 2,000 件は「参加者にメール」の機能の数で、外部への招待は短い期間に 10,000 件（ADR-0015 の書き方を直した）。会議室の繰り返しの「半分以上・8 回以下」、グループの招待の 100,000 人と 200 人で 24 時間、予約ページの最短の予告 4 時間、Workspace の SLA の 99.9%、空き時間の照会の 50・100、RFC 5546 の 2.1.4・2.1.5 節、RFC 6047 の 2.2.2 節（S/MIME が MUST）を確かめた。tzdb のリリースには GPG の署名（`.asc`）がある（未検証を外した）。内閣府の CSV は 1955〜2027 年で、ページに利用の条件の記載はない（法務の L7 のまま）。`@better-auth/scim` の告知（1.7.0 で修正）を足した。リマインダーの終日の例（夏時間をまたがない例になっていた）を直した。
- 領域ごとの決定は、各文書の「未解決の問い」の「決定」の節にある。

## 2026-10-04：データモデル

データモデルの完全版を [data-model.md](data-model.md) と [data-model/](data-model/) に作り、形（表・列・キー・索引・分割・保持）の正本をそこへ移した。領域の文書の「data-model への項目」は提案の記録として残す。名前と列の食い違いの解き方は [data-model.md](data-model.md) の 7 節（D-1〜D-32）にある。ADR の決定は変えていない。主なものは次のとおり。

- **回の識別子と系列**：`recurrence_id` は壁時計の時刻の文字列で、系列の全体は `''`（主キーに入れるため NULL にしない）。
- **展開の索引**：`(event_object_id, recurrence_id)` の一意は、月の分割の表なので DB で強制せず、カレンダーのロックの中の差分の書き込みと照合で守る。`hidden`・`cancelled` の写しと取り消した予定は行を持たない。
- **排他の制約の表は分割しない**：`resource_bookings`・`booking_reservations` は、時刻の区間の排他の制約を分割した表に作れないので、過去の行を毎日のジョブで消す。
- **リマインダーの送信の記録**：回の開始の日（`occurrence_on`）で分割し、日をまたぐ重複も一意の鍵で捨てる。受け手は利用者か予約（`recipient_id`）。
- **`sync_epoch`**：全体の 1 つの値（`platform_state`）だけ。テナントの移りは、カレンダーの `floor_seq` を上げて古いトークンを 410 にする。
- **アカウント**：Better Auth の既定の名前（`auth.user` ほか）。`auth.user` にテナントと利用者の ID を足す。確認したドメインは `principal_directory` に `@<domain>` で入れ、ログインの入口で SSO の組織を決める。

## 2026-10-04：データモデルの工程で見つけたテナントをまたぐ経路

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

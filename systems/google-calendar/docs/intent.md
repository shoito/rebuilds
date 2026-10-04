# Intent: Google Calendar を AI エージェント主体で再構築する

- Author: shoito
- Status: draft
- Date: 2026-10-04

## Problem

人と組織は、会議・面談・休暇・会議室を、カレンダーで調整する。カレンダーは単純に見えるが、次のところで壊れやすい。

- **繰り返しの予定が壊れる。** 「毎週火曜、ただし 3 回目だけ水曜」「来月からは時刻を変える」を重ねると、端末やサービスごとに違う回が出る。
- **時刻がずれる。** 海外の参加者がいる会議、夏時間の切り替え、タイムゾーンの規則の変更（IANA の tzdb の更新）で、1 時間ずれた予定や、終日の予定が前日に出る不具合が起きる。
- **招待の状態が食い違う。** 主催者が時刻を変えても参加者の手元が古いまま、出欠の返事が主催者に届かない、外部のカレンダー（メールで届く招待）と行き来すると重複する。
- **空きを探すのに時間がかかる。** 10 人と会議室の空きを、1 人ずつのカレンダーを開いて探す。会議室は二重に予約される。
- **端末の間で同期しない。** OS の標準のカレンダー、他のアプリ、社内のツールとの同期が遅い、漏れる、全件を取り直す。

本家 Google Calendar は、これらを大きな規模で解いている。RFC 5545 の繰り返しの規則を持つ予定、主催者と参加者の出欠、空き時間の照会、会議室の自動の承諾、差分の同期のトークン、Push の通知、CalDAV を提供する（出典は末尾）。この題材では、これを日本の市場を最初の対象に、小さなチームと AI エージェントでどこまで作り直せるかを確かめる。核（繰り返しの展開、タイムゾーンの計算、招待の写しの整合、空き時間と会議室、差分の同期）は自分で設計する（[リポジトリ共通の ADR-0007](../../../docs/decisions/0007-no-reuse-of-original-implementation.md)）。

## Proposed outcome

個人と組織が、繰り返し・タイムゾーン・招待で食い違わないカレンダーを使えるようにする。次の 4 つの価値を満たす。

1. **時刻を間違えない**：どの画面・API・CalDAV・通知でも、同じ予定の同じ回が、同じ瞬間に出る。tzdb の更新の後も、未来の予定が主催者の意図した現地の時刻に保たれる（NFR-009）。
2. **招待が食い違わない**：主催者の変更は、本システムの中の参加者の写しへ p99 5 秒で届き（NFR-002）、出欠の返事は主催者の写しに 1 回だけ反映される。
3. **空きをすぐ見つけ、二重に取らない**：50 人と会議室 20 の 2 週間の空きを p95 1 秒で探す（NFR-004）。自動で承諾する会議室の二重予約は 0 件（NFR-005）。
4. **どこからでも、差分で同期する**：Web の画面、公開 API、CalDAV のクライアントが、変更の差分だけを取り、取りこぼさない（NFR-010）。

### MVP（S1）に含める

- **アカウントと組織**：個人のアカウントと、組織（ドメインを持つテナント）。組織の利用者・グループ・会議室のディレクトリ、SSO（SAML・OIDC）と SCIM での利用者の同期（SCIM は E4 の最後に、SSO の後で出す。[roadmap.md](roadmap.md)）
- **カレンダー**：主のカレンダー（1 人に 1 つ）、追加のカレンダー、組織の共有のカレンダー、会議室・設備のカレンダー、日本の祝日のカレンダー
- **予定**：
  - 時刻つき（TZID つき）、終日（複数日を含む）、浮動の時刻（ICS・CalDAV からの取り込みで往復させる）
  - 繰り返し（RRULE・RDATE・EXDATE。`FREQ` は `DAILY` 以上）、1 回分の変更、「これ以降」の変更、系列の全体の変更
  - タイトル、場所、説明、色、予定の種類（通常、不在、作業の時間）、空き・予定ありの表示（`transparency`）、添付の URL、会議の URL
- **タイムゾーン**：予定ごとの開始と終了のタイムゾーン、利用者とカレンダーの既定のタイムゾーン、tzdb の更新への追従
- **招待と出欠**：参加者（任意の参加を含む）、出欠（承諾・仮承諾・辞退・未回答）とコメント、参加者の権限（他の参加者を見る・招待する・変更する）、グループの招待、主催者の変更
- **外部との招待**：iMIP（メールでの招待・返事・取り消し）。外部の参加者への送信と、外部からの返事・招待の受信
- **空き時間と日程の調整**：空き時間の照会（人・グループ・会議室）、複数の人と会議室の空きを並べて探す、候補の提示
- **会議室と設備**：建物・階・定員・設備の属性、自動の承諾（重ならないときだけ）、管理者の承認、二重予約の防止
- **共有と権限**：カレンダーの ACL（空き時間だけ・閲覧・編集・管理）、予定の公開範囲、組織の外への共有の方針
- **リマインダーと通知**：予定ごとのリマインダー（画面の通知・Web Push・メール）、招待・変更・取り消し・返事の通知、毎朝の予定の一覧のメール
- **同期と API**：REST の公開 API（OAuth 2.0）、差分の同期のトークン、Webhook での変更の通知、CalDAV（OS の標準のカレンダーと他のアプリ）、ICS の購読（外部の URL を取り込む）と公開（秘密のアドレス）、ICS の取り込みと書き出し
- **予約ページ**：空いている枠を外部の人に示し、予約を受ける（無料の予約だけ）
- **検索**：予定のタイトル・場所・説明・参加者の検索（日本語を含む）
- **Web の画面**：日・週・月・予定リストの表示、ドラッグでの作成と移動、複数のカレンダーの重ね表示、キーボードの操作、日本語の入力（IME）、最近の範囲のオフラインの閲覧
- **組織の管理と監査**：管理の画面（利用者、グループ、会議室、共有の方針）、監査ログ

### MVP の後の Epic で扱う

| 機能 | 理由 |
| --- | --- |
| ネイティブのモバイルのアプリ（iOS・Android） | MVP は Web と、OS の標準のカレンダー（CalDAV）でモバイルを覆う。ネイティブのアプリは、オフラインの書き込みと Push の通知の別の設計が要る |
| タスク（ToDo）と、カレンダーへのタスクの表示 | 予定と別のモデル（期限、完了、並び）。CalDAV の VTODO も含めて後で扱う |
| 有料の予約（決済）、予約ページの複数の主催者の順番の割り当て | 決済の事業者との連携と、特定商取引法の表示が要る（法務） |
| ビデオ会議の自動の発行 | 会議のサービスは別の題材（Zoom）。MVP は会議の URL を手で入れる欄だけ |
| AI での日程の提案、予定の要約 | データを外部のモデルへ送る扱いと、評価の仕組みが要る |
| Exchange・Microsoft 365 との空き時間の相互の照会、本家・他社からの一括の移行 | 他社の API と規約の確認が要る（法務の L3） |
| 勤務の場所、勤務の時間の詳細な設定、「集中の時間」の自動の辞退 | MVP は予定の種類としてだけ持つ |
| 海外のリージョン | S3。組織をリージョンに固定する形で足す |

### 守るべき振る舞い

- ある組織・個人のテナントの利用者は、共有されていない他のテナントの予定を見られない。
- 空き時間だけを共有された人には、予定の時刻の区間（予定あり）だけを返し、タイトル・場所・参加者・説明を、画面・API・CalDAV・ICS・検索・通知のどの経路でも返さない。`private` の予定も同じ。
- 時刻つきの予定は、主催者が決めた現地の時刻と TZID を保つ。tzdb が変わっても、現地の時刻を変えずに UTC の瞬間を計算し直す。終日の予定は、見る人のタイムゾーンに関係なく同じ日付に出る。
- 同じ予定の同じ回は、画面・API・CalDAV・空き時間・会議室・リマインダーで、同じ瞬間に出る。
- 主催者の写しが正である。参加者の写しの共有の項目は、主催者の写しに追いつく。出欠の返事は主催者の写しに 1 回だけ反映される。
- 自動で承諾する会議室では、承諾した予約どうしが重ならない。
- 差分の同期のトークンで取った変更を順に当てれば、全件を取り直した結果と同じになる。トークンが使えないときは、黙って欠けた差分を返さず、取り直しを求める。
- リマインダーは、予定の回ごと・方法ごとに 1 回だけ届けることを目指し、届かなかったものを計測する。予定が動いた後に、古い時刻のリマインダーを送らない。

### 成功の基準

| # | 基準 | 目標 | 測り方 |
| --- | --- | --- | --- |
| K1 | 繰り返しの展開の正しさ | 参照の実装との性質ベーステストで、説明のつかない食い違い 0 件（NFR-009）。本番の照合（展開の索引と、その場の展開）の不一致 0 件 | CI（PR ごとと夜間）、本番の抜き取りの照合 |
| K2 | tzdb の更新への追従 | tzdb の版を採用してから 24 時間以内に、影響する未来の回の再計算を終える。施行の 7 日以上前に公表された変更で、施行の後の予定の時刻の誤り 0 件（NFR-009） | 再計算のジョブの記録、tzdb の更新の試験 |
| K3 | 招待の伝播 | 主催者の変更から本システムの中の参加者の写しまで p99 5 秒（NFR-002）。外部への iMIP の送信 p95 60 秒（NFR-011） | 合成監視、伝播の計測 |
| K4 | 空き時間の探索 | 50 人＋会議室 20、2 週間で p95 1 秒（NFR-004） | 合成監視、負荷試験 |
| K5 | 会議室の二重予約 | 自動で承諾する会議室で 0 件（NFR-005） | DB の制約、本番の照合 |
| K6 | リマインダー | 予定の通知の時刻から送信の開始まで p99 30 秒。重複の送信 0.01% 未満、送り漏れ 0 件（NFR-003） | 送信の記録と、予定の回からの照合 |
| K7 | 可用性 | 予定の読み書き（Web・API・CalDAV）月間 99.9%（NFR-006） | 合成監視と 5xx の割合 |
| K8 | 権限の分離 | 見てはいけない予定の中身が届いた事象 0 件（NFR-008） | 性質ベーステスト、本番の応答の監査 |
| K9 | 相互運用 | 対象のクライアント（iOS・macOS のカレンダー、Thunderbird、DAVx5、Outlook のメールの招待）で、受け入れ試験の場面の 100% が通る | E8・E5 の受け入れ試験 |

## Affected users and systems

- **個人の利用者**：家族・友人・副業の予定。日本語の画面、日本の祝日、和暦の表示を求める。
- **組織の利用者**（主な利用者）：日本の中堅・大企業の社員。社内の会議、会議室、来客の対応。部署やグループでの招待が多い。
- **組織の管理者**：利用者・グループ・会議室・共有の方針・SSO を設定し、監査ログを見る。
- **予約する外部の人**：予約ページから面談を予約する顧客・応募者。アカウントを持たない。
- **外部のシステム**：
  - メールで招待を受ける外部のカレンダー（本家、Microsoft Outlook・Exchange、Apple のカレンダーなど）
  - CalDAV のクライアント（iOS・macOS のカレンダー、Thunderbird、DAVx5）
  - 公開 API と Webhook の利用者（社内のツール、予約・勤怠のシステム）
  - ICS の配信元（祝日、スポーツ、社内のシステムの予定）
  - IdP（Microsoft Entra ID、Okta など）、メールの送信、Web Push の配信のサービス
- **社内の運用**：サポート、障害の対応、tzdb の更新の採用、データの復元の依頼への対応。

## Constraints

- **核を自前で設計する。** 繰り返しの展開、タイムゾーンの計算、招待の写しの整合、空き時間の計算、会議室の予約、差分の同期、リマインダーの時計は、自分で作る。本家の実装は公開されておらず、使えない。第三者の iCalendar のライブラリは、テストの参照にだけ使う（[リポジトリ共通の ADR-0007](../../../docs/decisions/0007-no-reuse-of-original-implementation.md)、[ADR-0001](decisions/0001-platform-and-stack.md)）。
- 実行基盤と技術は、rebuilds の他の題材の決定（AWS 東京・大阪、TypeScript・Hono、Aurora PostgreSQL、Valkey、S3、SQS・SNS、ECS Fargate、Terraform、OpenTelemetry、AppConfig のフラグ）を引き継ぐ（[ADR-0001](decisions/0001-platform-and-stack.md)）。
- 標準に従う：iCalendar（RFC 5545）、iTIP（RFC 5546）、iMIP（RFC 6047）、CalDAV（RFC 4791）、WebDAV の同期（RFC 6578）。範囲は [ADR-0007](decisions/0007-interop-standards-scope.md)。
- 本家の名前は識別子に使わない。ドメインは `calendar.<brand>.<domain>`、Webhook のヘッダーは `<Brand>-Channel-Id` の形で書く（[リポジトリ共通の ADR-0006](../../../docs/decisions/0006-brand-neutral-identifiers.md)）。本家の API・SDK とそのまま互換にすることは目標にしない。
- データは日本（東京、DR は大阪）に置く。
- 日本の法令（個人情報保護法、電気通信事業法、特定電子メール法など）への対応は、法務の確認を前提に設計する。結論は出さない（下の「法務の確認待ち」）。
- 規模は段階的に広げる（[architecture/](architecture/README.md) の 2 節）。

## Non-goals

| 機能 | 理由 |
| --- | --- |
| 自前のホスト（オンプレミス）での提供 | 運用の形が別になる |
| 本家の REST API・SDK・Push の通知との完全な互換 | 形は寄せるが、名前と識別子は独自にする（リポジトリ共通の ADR-0006） |
| `FREQ=SECONDLY`・`MINUTELY`・`HOURLY` の繰り返し、`RSCALE`（RFC 7529、旧暦などの暦） | 予定の用途に要らず、展開の量が読めない。取り込みでは拒否か、展開した単発の予定に変える（[ADR-0003](decisions/0003-recurrence-storage-and-expansion.md)） |
| CalDAV の VTODO・VJOURNAL、`MKCALENDAR` | タスクは MVP の後。カレンダーの作成は画面と API で行う（[ADR-0007](decisions/0007-interop-standards-scope.md)） |
| 六曜などの暦注の表示 | 日本の祝日と和暦の表示に絞る。暦注は ICS の購読で足せる |
| 汎用のメールのサービス | 招待・通知のメールの送受信だけを持つ |
| 勤怠・給与の管理 | 不在の予定を外部へ配るところまで |

## Open questions

### 法務の確認待ち

設計はどの結論にも対応できる形にするが、結論は出さない。**下の表の「承認を止める spec」は、確認が済むまで PM・QA が承認しない。**

| # | 問い | 関係する設計 | 承認を止める spec |
| --- | --- | --- | --- |
| L1 | 個人情報保護法：予定のデータ（参加者の名前・メールアドレス、場所、説明）を、組織からの委託として扱うか、本システムが取得するものとして扱うか。個人のアカウントの場合の扱い。外国にある第三者への提供（メールの送信、Web Push の配信のサービス、外部の参加者への iMIP）の扱いと、本人への情報の提供。漏えい等の報告の義務を負う者と手順 | invitations-and-itip、reminders-and-notifications、security の各領域 | E5 の外部への iMIP、E9 の Web Push とメール |
| L2 | 電気通信事業法：招待・出欠のコメント・予約の連絡で、利用者の間の意思の伝達を媒介することが、届出の要る電気通信事業に当たるか。当たる場合の通信の秘密の扱い（招待の本文の取り扱い、迷惑な招待の検査）。Web の画面で端末の情報を外部へ送る場合の外部送信規律の公表 | invitations-and-itip、clients、security の各領域 | E5 の招待の公開、E7 の分析の計測 |
| L3 | 特定電子メール法・迷惑な招待：招待・リマインダー・予約の確認のメールが、広告宣伝のメールに当たらないことの整理。第三者が本システムを使って迷惑な招待を大量に送ったときの、本システムの責任と止め方。他社の API（Exchange、本家）からの取り込みの規約 | invitations-and-itip、booking-pages の各領域 | E5 の外部への招待の送信、E10 の予約の確認のメール |
| L4 | データの所在：「日本のデータを国外に出さない」をどこまで約束するか。バックアップ、DR（大阪は国内）、サポートでの参照、サブプロセッサー、Web Push の配信のサービス（ブラウザの事業者が運営し、国外にある）、外部の参加者への iMIP の扱い | infrastructure、reminders-and-notifications の各領域 | E1 のリージョンの構成、E12 の契約の文書 |
| L5 | 保持の期間：変更のログ、削除した予定、iMIP の受信の生のメール、監査ログ、解約したテナントのデータ、Web の画面の手元のキャッシュを、何日持つか | sync-and-caldav、security の各領域、[ADR-0005](decisions/0005-change-log-and-sync-tokens.md) | E8 の変更のログの保持、E12 の GA の判定 |
| L6 | 予約ページ：アカウントを持たない予約者の個人情報（名前、メールアドレス、回答）の取得の通知・公表、プライバシーポリシーの表示、予約者の本人確認の要否。有料の予約（MVP の後）での特定商取引法の表示 | booking-pages の領域 | E10 の予約ページの公開 |
| L7 | 祝日のデータ：内閣府が公開する「国民の祝日」の CSV を、取り込んで配信する祝日のカレンダーに使うときの利用の条件（出典の表示など）。法の改正で祝日が変わったときの責任の範囲 | time-zones-and-holidays の領域 | E3 の祝日のカレンダーの公開 |
| L8 | 管理者による閲覧：組織の管理者・監査の担当が、従業員の予定（`private` を含む）を見られる範囲。労働者のプライバシーと、就業規則・社内規程での周知の要否。監査ログでの閲覧の記録 | sharing-and-acl、accounts-and-orgs、security の各領域 | E11 の管理者の閲覧の機能 |
| L9 | 顧客との契約：委託の契約（DPA）の雛形、サブプロセッサーの一覧と変更の通知、SLA の文言、利用者からの開示・削除の請求の窓口 | security の領域 | E12 の GA の判定 |
| L10 | 画面の見た目とキーボードの操作を本家に寄せる範囲：不正競争防止法（商品等表示、商品の形態の模倣）と著作権の観点で、どこまで似せてよいか | clients の領域 | E7 の画面の Story |

### 選定・計測で決めるもの（法務以外）

- 展開の索引の範囲（過去 31 日から未来 548 日）：E2 の PoC で、行の数と書き込みの量を測って確かめる（[ADR-0003](decisions/0003-recurrence-storage-and-expansion.md)）。
- 繰り返しの展開の参照の実装（libical を第一の候補にする）：E2 の着手前に、参照の候補どうしの食い違いを調べて決める（[ADR-0001](decisions/0001-platform-and-stack.md)）。
- 日本語の検索の方式：S1 は Aurora の `pg_bigm`（Aurora PostgreSQL 18 で使える。[Extension versions for Aurora PostgreSQL](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraPostgreSQLReleaseNotes/AuroraPostgreSQL.Extensions.html)、2026-10-04 に確認）にした（[ADR-0034](decisions/0034-search-pg-bigm-acl-aware.md)）。索引の大きさは E11 の前の `search-bigm-poc` で、S2 で専用の基盤へ移すかは search.md の 8 節の基準で決める。
- 会議室の二重予約の防止：`btree_gist` の排他の制約にした（Aurora PostgreSQL 18 で使える。同上。[ADR-0019](decisions/0019-room-booking-rows-and-recurring-acceptance.md)）。E6 の前の `room-exclusion-poc` で、繰り返しの予約の書き込みの速さを確かめる。
- 本家の差分の同期のトークンの有効の期間、ICS の購読の更新の間隔：公式の資料に値がない（**未検証**）。本システムの値は [ADR-0005](decisions/0005-change-log-and-sync-tokens.md)（30 日）と [ADR-0025](decisions/0025-ics-subscriptions-both-directions.md)（6 時間）。本家の CalDAV の上限は Calendar API と同じ割り当てとされる（[CalDAV API developer's guide](https://developers.google.com/workspace/calendar/caldav/v2/guide)、2026-10-04 に確認）。
- 本家の繰り返しの予定の 1 系列あたりの回の上限：公式の資料で確かめられなかった（**未検証**）。本システムの上限は [ADR-0003](decisions/0003-recurrence-storage-and-expansion.md)。

## 出典

いずれも 2026-10-04 に確認。

- Google for Developers, [Synchronize resources efficiently](https://developers.google.com/workspace/calendar/api/guides/sync)：`nextSyncToken`・`syncToken` での差分の同期。トークンが失効したり ACL が変わったりすると 410 を返し、全件の同期を求める。差分には削除した予定が必ず含まれる。差分の同期で使える問い合わせの条件は限られ、最初の要求と同じにする
- Google for Developers, [Push notifications](https://developers.google.com/workspace/calendar/api/guides/push)：`watch` で通知の経路を作る。通知に本文はなく、変更の中身は別に読む。最初に `sync` の通知を送る。自動の更新はなく、期限で切れる。通知の一部は落ちうる
- Google for Developers, [Events resource](https://developers.google.com/workspace/calendar/api/v3/reference/events)：`recurrence` は RFC 5545 の RRULE・EXRULE・RDATE・EXDATE の行で、DTSTART・DTEND を含めない。繰り返しの予定では `start.timeZone` が必須で、展開に使う。公開範囲（`default`・`public`・`private`・`confidential`）、出欠（`needsAction`・`declined`・`tentative`・`accepted`）、`transparency`（`opaque`・`transparent`）、予定の種類、リマインダーの上書きは最大 5 件・0〜40,320 分
- Google for Developers, [Recurring events](https://developers.google.com/workspace/calendar/api/guides/recurringevents)：回は `recurringEventId` と `originalStartTime` で特定する。系列の全体や「これ以降」を変えるために回を 1 つずつ変えないよう勧めている
- Google for Developers, [Freebusy: query](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query)：`calendarExpansionMax` は最大 50、`groupExpansionMax` は最大 100
- Google for Developers, [CalDAV API developer's guide](https://developers.google.com/workspace/calendar/caldav/v2/guide)：OAuth 2.0 だけで認証する。RFC 4791 の `free-busy-query` の REPORT、`MKCALENDAR` を持たない。VTODO・VJOURNAL を持たない。RFC 6578 の同期を使う。RFC 6638 は一部
- Google Workspace Admin Help, [Avoid Calendar use limits](https://knowledge.workspace.google.com/admin/calendar/avoid-calendar-use-limits)：組織の外への招待は短い期間に 10,000 件、予定の作成は 100,000 件、「参加者にメール」の機能での外部の参加者へのメールは約 2,000 件（24 時間で回復）、カレンダーの作成は 60 件、共有は 750 件
- Google Calendar Help, [Invite groups to calendar events](https://support.google.com/calendar/answer/172013)：グループの招待で参加者は最大 100,000 人。参加者の一覧はグループの変更に合わせて未来の予定で更新され、200 人を超える予定では 24 時間以内に反映される
- Google Workspace Admin Help, [Approve or deny Calendar room & resource bookings](https://knowledge.workspace.google.com/admin/calendar/approve-or-deny-calendar-room-and-resource-bookings)：会議室の「重ならない招待だけを自動で承諾する」と「すべてを追加する」、繰り返しの予約で一部の回だけ重なるときの扱い、会議室の管理者
- Google Calendar Help, [Learn about appointment schedules](https://support.google.com/calendar/answer/11608416)、[Create an appointment schedule](https://support.google.com/calendar/answer/10729749)：予約ページ、間の時間、1 日の上限。一部の機能は有料のプラン
- Google Workspace, [Google Workspace Service Level Agreement](https://workspace.google.com/terms/sla/)：Google Calendar を含む対象のサービスで、月間の稼働率 99.9% 以上
- IANA, [Time zone and daylight saving time data](https://data.iana.org/time-zones/tz-link.html)：tzdb のリリースに決まった予定はなく、ふつう数か月ごと。規則は短い予告で変わることがある
- 内閣府, [「国民の祝日」について](https://www8.cao.go.jp/chosei/shukujitsu/gaiyou.html)：祝日と休日の一覧（1955 年から 2027 年）の CSV、振替休日と国民の休日の規定
- AWS, [Amazon Simple Email Service endpoints and quotas](https://docs.aws.amazon.com/general/latest/gr/ses.html)：東京（`ap-northeast-1`）と大阪（`ap-northeast-3`）でメールの受信を使える
- AWS, [Extension versions for Aurora PostgreSQL](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraPostgreSQLReleaseNotes/AuroraPostgreSQL.Extensions.html)：Aurora PostgreSQL 18（18.3・18.4・18.6）に `btree_gist` 1.6、`pg_bigm` 1.2、`pg_partman` 5.x がある
- Google for Developers, [Manage quotas](https://developers.google.com/workspace/calendar/api/guides/quota)：プロジェクトごと 1 分 10,000、利用者ごと 1 分 600（2026-05-01 から新しいプロジェクトに適用）

---
status: accepted
date: 2026-10-04
---

# ADR-0001: 共通の基盤の上に、繰り返しの展開・タイムゾーン・iCalendar・CalDAV・招待の整合を自前で作る。クライアントは Web の SPA で、モバイルは MVP では CalDAV で覆う

## Context

rebuilds の他の題材（Slack、Linear、Notion など）で、次の基盤を決めている。

- AWS（東京、DR は大阪。ECS Fargate、Aurora PostgreSQL 18、ElastiCache Valkey、SQS・SNS、S3・CloudFront）
- TypeScript（Hono＋Zod）
- Terraform、OpenTelemetry、AWS AppConfig のフィーチャーフラグ、トランクベース開発
- FORCE RLS と `SET LOCAL`、UUIDv7、transactional outbox

この題材の主な論点は、繰り返しとタイムゾーンを持つ予定のモデル、主催者と参加者の写しの整合（iTIP）、空き時間と会議室、差分の同期（CalDAV と公開 API）、リマインダーの時計である（[intent.md](../intent.md)）。次の条件がある。

- 同じ予定の同じ回が、画面・API・CalDAV・空き時間・会議室・リマインダーで同じ瞬間に出る（NFR-009）。
- 本家の実装を核に使わない（[リポジトリ共通の ADR-0007](../../../../docs/decisions/0007-no-reuse-of-original-implementation.md)）。本家の実装は公開されていないが、規則は、第三者の部品に核を任せることも防ぐ。
- 日本の利用者の多くは、スマートフォンで予定を見る。

部品の候補として、成熟した第三者の実装がある。

- iCalendar と繰り返しの展開：libical（C）、ical.js（JavaScript）、rrule.js（JavaScript）、python-dateutil の rrule など
- タイムゾーン：ブラウザと Node.js の `Intl`（ICU の tzdata）、Temporal、date-fns-tz、Luxon など
- CalDAV のサーバー：Radicale、Baïkal（sabre/dav）、DAViCal など

## Options

1. **共通の基盤を引き継ぎ、展開・タイムゾーン・iCalendar・CalDAV・招待の整合を自前で作る。** 第三者の実装は、テストの参照（答え合わせの相手）として使う
2. **共通の基盤の上で、展開とタイムゾーンを第三者のライブラリに任せる**（rrule.js・ical.js と `Intl`）
3. **CalDAV のサーバーの OSS を土台にし、その上に API と画面を足す**

クライアントの形として、次も比べた。

- a. **Web の SPA（スマートフォンの幅にも対応）と、OS の標準のカレンダー（CalDAV）。ネイティブのアプリは MVP の後**
- b. Web の SPA と、ネイティブのモバイルのアプリを MVP から作る
- c. クロスプラットフォームのモバイルのアプリ（React Native など）を MVP から作る

## Decision

1 と a を採用する。

### サーバー

- 実行基盤・言語・IaC・可観測性・フラグは、他の題材と同じにする。題材をまたいで、エージェントと人が同じ道具で検証できる。
- API、CalDAV、Realtime、Booking、Auth、Relay、Worker（`itip-delivery`・`imip-inbound`・`expander`・`reminder-scheduler`・notifier・`push-sender`・`ics-fetcher` など）を別の ECS のサービスにする（[architecture/README.md](../architecture/README.md) の 1.2 節）。
- 書き込みは、サービスではなくライブラリ `packages/writer` に集める。API・CalDAV・Booking・Worker のどこから来た書き込みも、ここで検証・展開の索引の更新・変更のログ・outbox を 1 つの DB のトランザクションで書く（[ADR-0005](0005-change-log-and-sync-tokens.md)）。Linear の題材の Writer のような別のサービスにしないのは、順序をカレンダーの行のロックで決め、サービスをまたぐ往復を書き込みの経路に足さないため。

### 自前で作るもの（核）

| 用途 | パッケージ | 理由 |
| --- | --- | --- |
| 繰り返しの展開 | `packages/recurrence` | 題材の核。展開の規則（存在しない時刻、例外、上限）を本システムで決め、すべての経路で同じ関数を使う（[ADR-0003](0003-recurrence-storage-and-expansion.md)） |
| タイムゾーンの変換 | `packages/tz`、`packages/tzdata` | 題材の核。tzdb の版をサーバーとクライアントで固定し、更新を自分で制御する（[ADR-0002](0002-time-representation.md)） |
| iCalendar の読み書き | `packages/ical` | iTIP・iMIP・CalDAV・ICS の入口。上限の検査と、壊れた入力の扱いを本システムで決める |
| CalDAV | CalDAV のサービス | 題材の核。予定オブジェクトと変更のログに直接つなぐ（[ADR-0007](0007-interop-standards-scope.md)） |
| 招待の整合 | `itip-delivery`、`packages/itip` | 題材の核（[ADR-0006](0006-organizer-and-attendee-copies.md)） |
| 空き時間、会議室、リマインダーの時計 | 各領域 | 題材の核 |

### 第三者のものを使うもの

| 用途 | 部品 | 扱い |
| --- | --- | --- |
| tzdb のデータ | IANA の tzdb（公開の標準のデータ） | データとして取り込み、zic で遷移の表にして版を固定する。実装ではない |
| 展開の参照 | libical（第一の候補。E2 の前に他の実装との比べで決める） | テストにだけ使う。本番のコードから import しない |
| XML のパーサー | 第三者の汎用の XML のパーサー | 汎用の部品。WebDAV の意味は持たない |
| 日付の表示の書式 | `Intl.DateTimeFormat`（月・曜日の名前、和暦の表示） | 表示の書式だけに使い、オフセットの計算に使わない（[ADR-0002](0002-time-representation.md)） |
| 認証のライブラリ、Web Push の暗号 | accounts-and-orgs、reminders-and-notifications の領域で選ぶ | 汎用の部品 |

### クライアント

- Web の SPA（TypeScript、React）。スマートフォンの幅に対応し、PWA としてホーム画面に置けるようにする。
- モバイルの予定の閲覧・編集・通知は、MVP では OS の標準のカレンダー（iOS・macOS のカレンダー、Android の DAVx5 など）を CalDAV でつないで覆う。CalDAV は題材の主な論点でもあり、相互運用の試験の負荷を、ネイティブのアプリの開発に先に回す。
- `packages/recurrence`・`packages/tz`・`packages/tzdata` は、サーバーと Web のクライアントで同じコードと同じ版を使う。

### 他の案を選ばなかった理由

- **2（展開とタイムゾーンを第三者に任せる）**：題材の核を設計しないことになる。加えて、`Intl` の tzdata の版はブラウザと Node.js の版に従い、サーバーとクライアントで揃わない。ライブラリごとに、存在しない時刻・`BYSETPOS`・例外の扱いが違い、どれかに合わせると、その実装の誤りも引き継ぐ。
- **3（CalDAV のサーバーの OSS を土台にする）**：保存の形・同期・招待の処理を OSS が決める。題材の核を設計しないことになり、空き時間・会議室・リマインダーの規模の要件に合わせにくい。
- **b・c（MVP からネイティブのアプリ）**：オフラインの書き込み、ネイティブの Push、ストアの審査の設計が加わる。MVP の主な論点（繰り返し、タイムゾーン、招待、同期）の検証が遅れる。

## Consequences

- 良くなること：
  - 展開とタイムゾーンの規則を、本システムで 1 つに決めて検証できる。
  - サーバーとクライアントで、同じ版の tzdb と同じ展開のコードを使える。
  - CalDAV を MVP で作ることで、OS の標準のカレンダーがそのまま使え、相互運用を早く確かめられる。
- 引き受けるコスト：
  - 展開とタイムゾーンを自前で書く分、誤りの余地がある。参照の実装との性質ベーステスト（[quality.md](../quality.md)）と、展開の索引の本番の照合に投資する。
  - tzdb の版の更新を、自分で追う運用が要る（delivery の領域）。
  - OS の標準のカレンダーの振る舞いの違い（例外の送り方、通知）を引き受ける。ネイティブのアプリほど体験を制御できない。

## Confirmation

- 依存の検査（CI）：`ical.js`・`rrule`・`luxon`・`date-fns-tz` などの展開・タイムゾーンのライブラリを、本番のパッケージの依存で禁止する。参照の実装は、テストのパッケージの依存にだけ許す。
- lint：本番のコードで、`Intl.DateTimeFormat` の `timeZone` の指定、`Date` の現地時刻のメソッド（`getHours` など）、SQL の `AT TIME ZONE` を禁止する（表示の書式のモジュールだけ許可リストに入れる）。
- lint：`packages/recurrence` の外で RRULE を解釈するコード（`RRULE:` の文字列の分解）を禁止する。
- 設計の工程の最後の検証で、依存の一覧に本家の実装と、核を担う第三者の実装が入っていないことを確かめる。

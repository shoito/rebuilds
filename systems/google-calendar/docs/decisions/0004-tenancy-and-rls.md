---
status: accepted
date: 2026-10-04
---

# ADR-0004: 組織と個人をテナントにし、FORCE RLS で分ける。カレンダーの ACL と予定の公開範囲を `can()`・`redact()` の 1 つのモジュールで判定する

## Context

利用者は 2 種類いる。

- **組織**：ドメインを持つ会社・団体。利用者・グループ・会議室・共有の方針を管理者が持つ。
- **個人**：組織に属さないアカウント。家族や友人とカレンダーを共有する。

カレンダーには、テナントをまたぐ関わりが多い。

- 他の組織の人、個人のアカウントの人を招待する。
- 他の組織の人と、カレンダーや空き時間を共有する。
- 組織の外への共有を、管理者が方針で絞る（空き時間だけ、など）。

本家の権限は 2 段である。カレンダーの ACL のロール（空き時間だけ・閲覧・編集・管理）と、予定の公開範囲（`default`・`public`・`private`・`confidential`）。`private` の予定は、参加者だけが中身を見られる。繰り返しの 1 回の公開範囲を狭めると、系列の全体に効く（[Events resource](https://developers.google.com/workspace/calendar/api/v3/reference/events)、2026-10-04 に確認）。

空き時間だけを共有された人に、予定の中身（タイトル・場所・参加者）が 1 つの経路でも届けば漏えいである。経路は多い：画面、API、CalDAV の `calendar-data`、ICS の公開、検索の抜粋、通知のメール、Webhook、空き時間の照会。

## Options

分離の方式：

1. **共有スキーマ＋RLS。** テナントのテーブルに `tenant_id` を持たせる
2. テナントごとのスキーマ
3. テナントごとの DB（silo）

権限の判定：

- a. **`can()`（許すか）と `redact()`（何を返すか）を 1 つのモジュール（`packages/policy`）にし、すべての経路が使う**
- b. 経路ごとに判定を書く
- c. DB の RLS のポリシーで、ACL と公開範囲まで判定する

## Decision

1 と a を採用する。

### テナントの分離

- **組織を 1 つのテナント、個人のアカウントを 1 人 1 つのテナントにする。** 個人が後で組織に入るときは、テナントを移す手続き（accounts-and-orgs の領域）を通す。
- 分け方は他の題材（Slack の ADR-0009、Linear の ADR-0004）に倣う。
  - テナントのテーブルに `tenant_id` を持たせ、主キーとインデックスの先頭に置く。ID は UUIDv7。
  - `FORCE ROW LEVEL SECURITY` を設定し、トランザクションごとに `SET LOCAL app.tenant_id` を設定する。
- **テナントをまたぐ処理は、下の許可リストの経路に限り、専用の DB のロールと関数を通す。**
- **アカウントとメールアドレスの解決はテナントの外に置く。** メールアドレスから、本システムのアカウント（とそのテナント）か、外部の人かを決める。RLS の外の別のスキーマに置き、認証と配送のロールだけが読む。

> 2026-10-04 の注記：最初の設計では、テナントをまたぐ処理を 3 つ（内部の iTIP の配送、空き時間の照会、共有されたカレンダーの読み出し）とした。領域の工程で、共有のカレンダーへの書き込み（[ADR-0021](0021-effective-role-and-redact-table.md)）、リマインダーの時計の表（[ADR-0029](0029-reminder-clock-buckets-and-timer-wheel.md)）、予約ページ・ICS の公開・iMIP の受け口の解決の表、tzdb の影響の見積もりの表、個人から組織への移り（[ADR-0036](0036-org-domains-sso-and-scim.md)）が足された。統合の工程で、これらを 1 つの許可リストにまとめ、題材の `AGENTS.md` と同じ一覧にした。許可リストにない経路を作るときは、この ADR を直す（最初の設計の後は新しい ADR）。

### テナントをまたぐ経路の許可リスト

| # | 経路 | DB のロール・関数 | 読み書き | 根拠 |
| --- | --- | --- | --- | --- |
| X1 | 内部の iTIP の配送（`REQUEST`・`CANCEL`・`REPLY`・`REFRESH`・`X-MODIFY`）。受け手のテナントのコンテキストで、受け手の写しを書く | `itip_delivery` | 受け手のテナントへ書く | [ADR-0006](0006-organizer-and-attendee-copies.md)、[ADR-0014](0014-itip-state-transfer-and-sequence.md) |
| X2 | 空き時間の照会。相手のテナントの方針で絞った区間と種類だけを返す | `freebusy`、関数 `freebusy_for(requester, calendar_ids[], window)` | 読む（区間だけ） | [ADR-0017](0017-freebusy-source-and-cache.md) |
| X3 | 共有されたカレンダーの読み出し。カレンダーのテナントのコンテキストで読み、`redact()` を通す | `shared_calendar_access` | 読む | この ADR、[ADR-0021](0021-effective-role-and-redact-table.md) |
| X4 | 共有されたカレンダーへの書き込み（外の主体が `writer` 以上）。カレンダーのテナントのコンテキストで `packages/writer` を通す。`release.cross-tenant-shared-writes` の裏 | `shared_calendar_access` | カレンダーのテナントへ書く | [ADR-0021](0021-effective-role-and-redact-table.md) |
| X5 | リマインダーの時計。全テナントの計画の行（ID と時刻だけ）を読み、中身は notifier がテナントのコンテキストで読む | `reminder_clock` | 保守用の表を読み書き | [ADR-0029](0029-reminder-clock-buckets-and-timer-wheel.md)、[ADR-0030](0030-reminder-planning-horizon-and-replan.md) |
| X6 | 匿名・外からの入口の解決（予約ページの `slug`、予約の管理のリンク、ICS の秘密のアドレス、iMIP の受け口、OAuth の `client_id`、OAuth のトークン、メールアドレス）。解決の後はテナントのコンテキストで処理する | `resolver`（入口ごとに関数を分ける） | 解決の表を読む | [ADR-0015](0015-imip-addressing-and-trust.md)、[ADR-0025](0025-ics-subscriptions-both-directions.md)、[ADR-0033](0033-booking-creation-and-exclusion.md)、[ADR-0035](0035-accounts-auth-library-and-credentials.md) |
| X7 | tzdb の影響の見積もりと再計算の対象の探し（`tenant_tz_usage`）。再計算はテナントごとのコンテキストで行う | `tz_maintenance` | 保守用の表を読む | [ADR-0012](0012-tzdb-update-recompute-and-propagation.md) |
| X8 | 個人から組織への移り（`tenant-move`）。カレンダーごとのトランザクションで `tenant_id` を変える | `tenant_move` | 2 つのテナントを書く | [ADR-0036](0036-org-domains-sso-and-scim.md) |
| X9 | SLI の集計。業務の記録（ID・時刻・結果だけ）を全テナントで数える | `slo_aggregator` | 保守用の表を読む | [ADR-0046](0046-sli-from-ledgers-and-delivery-tracing.md) |
| X10 | Relay の `outbox` の読み出し。確定した変更のメッセージを全テナントにまたがって `id` の順に読み、送った行を消す。他の表は読まない | `relay`（`outbox` だけの専用の RLS のポリシー。`SELECT`・`DELETE` だけ） | `outbox` を読む・消す | [ADR-0005](0005-change-log-and-sync-tokens.md) |
| X11 | ICS の購読の取得の予定。全テナントの `ics_fetch_schedule`（購読の ID・テナント・次の取得の時刻だけ）を読み、取得の依頼を出す。取得の結果はテナントのコンテキストで書く | `ics_scheduler`（`worker-ics-apply` の予定のジョブ） | 保守用の表を読み書き | [ADR-0025](0025-ics-subscriptions-both-directions.md) |

- 全テナントを順に回す保守のジョブ（範囲の端の維持、照合、削除の期限など）は、許可リストに入れない。`tenants` からテナントの ID を読み、テナントごとに `SET LOCAL` して処理する。
- 運用者の JIT のアクセスと break-glass は、プラットフォームの監査に残す別の経路で、アプリの DB のロールを使わない（security の領域）。

> 2026-10-04 の注記：データモデルの工程で、許可リストにないテナントをまたぐ処理が 4 つ見つかった（[architecture/README.md](../architecture/README.md) の 6 節）。推奨の案で決め、この ADR を直した。(1) Relay の `outbox` の読み出しを X10 にした。`outbox` は iTIP の本文（予定の中身）を持つので RLS の外の表にせず、`relay` のロールにだけ `outbox` の `SELECT`・`DELETE` を全テナントで許すポリシーを付ける。(2) X6 の入口に OAuth のトークン（API・CalDAV の Bearer）と予約の管理のリンク（`/m/<token>`）を足し、解決の表 `oauth_token_directory`・`booking_manage_directory` を足した。(3) ICS の購読の取得の予定を探す表 `ics_fetch_schedule` を足し、X11 にした（X5 と同じ形。ID と時刻だけ）。(4) テナントをまたぐ共有のカレンダーの既定のリマインダーの購読者は X4 の経路で書き、X4 が無効の間は計画しない（経路は足さない）。あわせて、S2 のディレクトリのクラスタの表（`tenant_directory`、`account_directory`）を一覧に載せた。

### RLS の外の表の許可リスト

| スキーマ | 表 | 中身の制限 |
| --- | --- | --- |
| `auth` | Better Auth の表（アカウント、セッション、パスキー、外部のアカウント、検証の値）、`app_passwords` | ログインの主体だけ。予定の中身を持たない |
| 保守用（`ops`） | `tenants`、`principal_directory`、`platform_state`、`platform_audit_events`、`retention_policies`、`legal_holds` | テナントの属性・解決・監査。予定の中身を持たない |
| 保守用（`ops`） | 解決の表：`booking_slug_directory`、`booking_manage_directory`、`ics_publish_token_directory`、`imip_address_directory`、`oauth_client_directory`、`oauth_token_directory`、`moved_event_objects` | 鍵（ハッシュ）→ `tenant_id` と ID だけ |
| 保守用（`ops`） | リマインダー：`reminder_plans`、`reminder_plan_heads`、`reminder_deliveries`、`reminder_shard_leases` | ID・時刻・方法・状態だけ |
| 保守用（`ops`） | tzdb：`tenant_tz_usage`、`tz_recompute_runs` | TZID と数だけ |
| 保守用（`ops`） | ICS の購読の取得の予定：`ics_fetch_schedule` | 購読の ID・テナント・時刻・状態だけ（URL を持たない） |
| 保守用（`ops`） | SLI の記録：`itip_deliveries`、`itip_fanout_progress`、`imip_outbound_log`、`imip_inbound_log`、`sync_token_uses`、`reconciliation_findings` | ID・時刻・結果・理由のコードだけ |
| ディレクトリのクラスタ（S2 から） | `tenant_directory`、`account_directory`（S2 で `imip_address_directory` もここへ移す） | テナント → クラスタ、メールアドレスのハッシュ → アカウント・テナント。S1 では作らない（[ADR-0045](0045-stage-up-criteria-tenant-sharding-and-cells.md)） |

- **CI の規則**：マイグレーションの検査は、`tenant_id` と FORCE RLS のない表を、上の一覧の表だけに許す。一覧の表に、予定の中身の列（タイトル、場所、説明、参加者の名前、コメント）を足すマイグレーションを失敗させる（メールアドレスを持てるのは `auth` と `principal_directory` だけ）。`BYPASSRLS` のロール、`SECURITY DEFINER` の関数、テナントをまたぐロールへの `GRANT` は、経路の一覧（X1〜X11）の名前と照らし、一覧にないものを失敗させる。一覧の正本はこの ADR で、開発リポジトリの許可リストのファイルと CI が比べる。
- 2 は、S3 で 1,500 万の個人のテナントに対して、スキーマの数とマイグレーションが重い。3 は、S1 でも運用が重い。大きな組織は、S2 でテナントを単位に専用のクラスタへ移す（infrastructure の領域）。

### 権限の判定

- **ACL のロール**：`none`・`free_busy_reader`・`reader`・`writer`・`owner`。主体は、利用者、グループ、ドメイン（組織の全員）、公開（だれでも）。
- **予定の公開範囲**：`default`（カレンダーの既定に従う）・`public`・`private`・`confidential`（`private` と同じに扱う。互換のため）。
- **`can(actor, action, target)`**：読む・書く・共有を変える・出欠を返す・空き時間を見る、を判定する。ACL、公開範囲、参加者かどうか、組織の共有の方針、委任を入力にする。
- **`redact(actor, event)`**：返してよい形に削る。決定表の骨格は次のとおりで、行と条件の全体は sharing-and-acl の領域で決定表にする。

| # | 主体のカレンダーへのロール | 予定の公開範囲 | 主体が参加者か | → 返すもの |
| --- | --- | --- | --- | --- |
| 1 | - | - | はい | 全体（参加者の写しとして） |
| 2 | `owner`・`writer` | - | - | 全体 |
| 3 | `reader` | `public`・`default`（既定が公開） | - | 全体 |
| 4 | `reader` | `private`・`confidential` | いいえ | 区間と「予定あり」だけ |
| 5 | `free_busy_reader` | - | いいえ | 区間と「予定あり」だけ。`transparent` の予定は返さない |
| 6 | `none` | - | いいえ | 返さない（存在も示さない） |

- **経路は、`redact()` の結果だけを使う。** 画面・API・CalDAV・ICS の公開・検索の表・通知・Webhook・空き時間の照会で、予定の行を直接返さない。検索の表には、`redact()` の結果ごとの文字列を入れる（search の領域）。
- **組織の共有の方針**：組織の外への共有の上限（空き時間だけ・閲覧まで・すべて）、外部の人への既定の公開範囲を、管理者が決める。方針は `can()` の入力で、ACL の行より強い。方針を狭めたら、方針を超える ACL の行を無効にして変更のログに載せる（[ADR-0005](0005-change-log-and-sync-tokens.md)）。
- c を採らない理由：公開範囲と参加者の判定、`redact()` の削り方は、行を返すか否かでは表せない。RLS はテナントの分離にだけ使う。
- b を採らない理由：経路が多く、1 つの経路の漏れが漏えいになる。

## Consequences

- 良くなること：
  - テナントの分離を、アプリのコードだけに頼らない。
  - 予定の中身を返すかの判定が、すべての経路で同じ関数・同じ決定表になる。
  - テナントをまたぐ処理が許可リストの経路に限られ、監査しやすい。
- 引き受けるコスト：
  - 個人のテナントの数が多い（S1 で 30 万）。テナントごとの設定の行と、テナントの作成の処理を軽くする必要がある。
  - 共有されたカレンダーの読み出しは、カレンダーのテナントのコンテキストに切り替える。1 つの画面で複数のテナントのカレンダーを重ねると、テナントの数だけ問い合わせる。
  - 方針の変更が、ACL の行の無効化と、多くのクライアントの取り直しを起こしうる。
  - RLS のコンテキストの設定漏れは「予定がない」に見え、同期では「消えた」に見える。結合テストで全経路のコンテキストの設定を確かめる。

## Confirmation

- 性質ベーステスト：任意の 2 テナントで、一方のコンテキストで他方の行が読めない。
- 表駆動テスト：`redact()` の決定表（sharing-and-acl の領域で spec に書く）を spec から読み込み、全行を確かめる。
- 性質ベーステスト：任意の ACL・公開範囲・参加者・方針の組み合わせで、`free_busy_reader` と `private` の非参加者の応答に、タイトル・場所・説明・参加者・添付・会議の URL が含まれない。経路（API、CalDAV、ICS、検索、通知のメール、Webhook）ごとに同じ性質を確かめる。
- CI：新しいテーブルに `tenant_id` と RLS のポリシーがないマイグレーションを失敗させる（例外は上の「RLS の外の表の許可リスト」だけ）。テナントをまたぐロールと関数を、経路の許可リストと照らす。
- lint：`packages/policy` の外で、`role ===`・`visibility ===` などの権限の条件を書くことを禁止する。
- 本番：応答の監査（抜き取りの応答を `redact()` に通し直して比べる）で、不一致 0 件（NFR-008）。

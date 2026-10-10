---
status: accepted
date: 2026-10-10
---

# ADR-0007: テナントは 1 つ。本人の表は本人、ホストの表はホストのアカウント（共同ホストの役割）、予約の表はゲストとホストのアカウントの 2 者の FORCE RLS にする。PMS は OAuth のアプリとしてホストのアカウントの範囲で動く。リスティングの見える範囲は `listingVisible()` の 1 つの関数で決める

> 2026-10-10 の注記：データモデルの工程で、RLS の種類の表の例の名前を、領域の文書と [data-model.md](../architecture/data-model.md) の名前で読むことにした（`payment_method_refs` → `payment_methods`、`check_in_instructions` → vault の `arrival_instructions`、`saved_searches` は content に最小の形で足した）。`guest_registry_entries` の見える範囲は、後の [ADR-0067](0067-guest-registry-in-vault.md) のとおり、ホストのアカウントの `owner`・`full`・名簿の権限の成員（と、入力するゲストの関数）である（data-model.md の D-20）。3 種類の RLS の決定は変えていない。

## Context

マーケットプレイスは 1 つの場で、事業者ごとのテナントはない。ただし、データの持ち主は分かれる。

- **ゲスト本人**：プロフィール、支払いの方法の参照、本人確認、名簿の項目、検索の履歴。
- **ホストのアカウント**：リスティング、カレンダー、料金、届出住宅、送金の口座、明細。1 人のホストが複数の物件を持ち、共同ホスト（家族、清掃の担当、住宅宿泊管理業者）に一部の操作を任せる。
- **予約の 2 者**：予約、メッセージ、チェックインの案内、正確な住所。ゲストとホストのアカウントだけが見る。
- **公開**：公開したリスティング（ずらした位置）、公開したレビュー、ホストの公開のプロフィール。

PMS は、多くのホストのリスティングをまとめて動かす。ホストが許した範囲でだけ動かなければならない（NFR-016）。

Google Calendar・Shopify の題材は、テナントの ID の FORCE RLS と `SET LOCAL` を決めた（[Google Calendar の ADR-0004](../../../google-calendar/docs/decisions/0004-tenancy-and-rls.md)、[Shopify の ADR-0003](../../../shopify/docs/decisions/0003-tenancy-and-rls.md)）。Mercari の題材は、1 つのテナントで本人と取引の 2 者の RLS を決めた（[ADR-0007](../../../mercari/docs/decisions/0007-single-tenant-and-party-visibility.md)）。

## Options

1. **テナントは 1 つ。本人・ホストのアカウント・予約の 2 者の 3 種類の RLS**
2. ホストのアカウントをテナントにし、ゲストは全テナントをまたぐ利用者にする
3. RLS を使わず、アプリの権限の検査だけにする

## Decision

1 を採用する。

### 主体と `SET LOCAL`

- 要求ごとのトランザクションの初めに、`SET LOCAL app.actor_id = '<user_id>'` と、ホストの操作なら `SET LOCAL app.host_account_id = '<id>'`、`SET LOCAL app.host_role = '<role>'` を設定する。どちらも `app-api`・`partner-api` が、セッションか OAuth のトークンから決める。
- サービスの役割（Worker）は、`SET LOCAL app.service = '<name>'` で、役割ごとの許可リストの表だけを読める。

### RLS の種類

| 種類 | 表の例 | 方針 |
| --- | --- | --- |
| 本人 | `users`、`guest_profiles`、`payment_method_refs`、`saved_searches`、`guest_registry_entries`（vault） | `user_id = current_setting('app.actor_id')` |
| ホストのアカウント | `listings`（書き込み）、`calendar_days`、`stay_claims`（書き込み）、`pricing_rules`、`regulated_properties`、`payout_accounts`（vault）、`host_statements` | `host_account_id = current_setting('app.host_account_id')` かつ、役割が操作を許す |
| 予約の 2 者 | `reservations`、`reservation_events`、`message_threads`、`messages`、`check_in_instructions`、`exact_locations`（予約の経由） | ゲスト本人か、予約のリスティングのホストのアカウントの成員 |
| 公開 | `listings`（`listed` の行の公開の列）、公開したレビュー | `listingVisible()` を通した読み出しの関数だけ |

- すべての表で `FORCE ROW LEVEL SECURITY` を有効にする。表の持ち主の役割でも RLS を越えない。
- 公開の読み出しは、公開の列だけを返すビューか関数を通す。`listings` の表を直接 `SELECT *` で公開しない。

### ホストのアカウントと共同ホスト

- `host_accounts` と `host_members`（`user_id`、`role`）。役割は `owner`、`full`（送金の口座と共同ホストの管理を除く全部）、`calendar_and_reservations`、`messages_only`。リスティングごとに役割を絞れる。
- 送金の口座の変更、共同ホストの追加、届出住宅の登録は `owner` だけ。重要な操作の後は、`owner` に知らせ、送金の口座の変更から 72 時間は送金を保留する（乗っ取りの対策。trust-and-safety の領域）。

### PMS

- PMS は OAuth のアプリとして登録し、ホストのアカウントの `owner` が範囲（`listings:write`、`calendar:write`、`reservations:read`、`messages:write` など）を許す。トークンは `app.host_account_id` と範囲を決める。
- PMS の書き込みも、`stay_claims` の排他の制約と `reserveStay` を通る。PMS の専用の近道はない。
- トークンの接頭辞は `<brand>_pms_`（[リポジトリ共通の ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。

### リスティングの見える範囲

- `packages/visibility` の `listingVisible(viewer, listing)` が、公開の状態、措置、ホストの状態、ブロックした相手、届出の確かめ（日本の物件）、地域の制限を決める。検索・地図・共有のページ・おすすめ・通知はこれを通す。
- 正確な位置・住所は、`exactLocationVisible(viewer, listing)` が、ホストのアカウントの成員か、そのリスティングの `confirmed`・`in_stay` の予約のゲスト（と、チェックアウトの後 7 日まで）に限って許す。

### 運用者

- 運用者は `ops-api` から、JIT の権限（理由、期限、承認）で読む。vault の列（住所、名簿、旅券、口座）の表示は、別の権限と、監査の行を同じトランザクションで書く関数を通す（security の領域）。

### 他の案を選ばなかった理由

- **2（ホストのアカウントをテナント）**：ゲストは多くのホストをまたいで検索・予約し、メッセージ・レビューは 2 者をまたぐ。テナントの境界が利用の形に合わない。
- **3（アプリの検査だけ）**：検査の漏れが、正確な住所・名簿の漏れに直結する。DB で二重に守る。

## Consequences

- 良くなること：
  - 正確な住所・名簿・口座の漏れを、アプリと DB の両方で防げる。
  - 共同ホストと PMS に、必要な範囲だけを任せられる。
- 引き受けるコスト：
  - 予約の 2 者の RLS は、ホストのアカウントの成員の表を参照し、問い合わせが重くなる。成員の一覧を `SET LOCAL` で渡す形を infrastructure の領域で比べる。
  - 公開の読み出しの関数とビューを保ち続ける必要がある。

## Confirmation

- RLS の性質ベーステスト：任意の主体（ゲスト、他のゲスト、ホストの各役割、他のホスト、PMS の範囲、匿名、運用者の権限）と表で、許された行だけが読める・書ける（[quality.md](../quality.md) の 2.2.1 節 H）。
- 漏れの経路の表（同 H）で、正確な住所・名簿・口座の経路を確かめる。
- lint：`FORCE ROW LEVEL SECURITY` のない表を CI で拒む。

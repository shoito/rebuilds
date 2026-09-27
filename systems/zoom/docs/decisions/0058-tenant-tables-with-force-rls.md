---
status: accepted
date: 2026-09-27
---

# ADR-0058: 組織に属する Aurora の表は org_id を持ち、FORCE RLS で組織を分ける。API の認可はその上に重ねる

## Context

intent.md の守るべき振る舞いは「他の組織の会議・録画・文字起こし・参加者の情報は、一切見えない」である。[security.md](../architecture/security.md) は、組織をまたいだ漏えいを最も重い障害の 1 つに挙げる。

各領域の文書は、API の認可（`authorize`）で `org_id` を絞る前提で書かれている。一方で、DB の行の単位の保護（RLS）を使うかは決まっていなかった（security.md の 3.2 節は accounts-and-admin の領域に委ね、accounts-and-admin.md は決めていない。[data-model.md](../architecture/data-model.md) の持ち越し）。

- rebuilds の他の題材（Auth0、Figma）は、テナントの表に `org_id` と `FORCE ROW LEVEL SECURITY` を付け、トランザクションごとに `SET LOCAL app.org_id` を行う（Figma の [ADR-0005](../../../figma/docs/decisions/0005-tenancy-and-document-routing.md)）。
- この題材には、組織の文脈を持たない処理がある：参加の API（会議の番号から会議を引く。まだ組織が分からない）、Meeting Actor の書き込み（1 つの会議の中で閉じる）、Worker の集計と保持の期限の削除（組織をまたいで回る）、Trust & Safety の対処。

## Options

1. **組織に属する表は `org_id` を持ち、FORCE RLS を付ける。組織の文脈のない処理は、決めた関数とロールだけで行う。API の認可はその上に重ねる**
2. RLS を使わず、API の認可と試験だけで分ける
3. 組織ごとに DB（スキーマ）を分ける

## Decision

1 を採用する。詳細は [data-model.md](../architecture/data-model.md) の 2 節。

- **テナントの表**（`meetings`、`meeting_instances`、`meeting_participations`、`recordings` とその子、`capture_consents`、`meeting_chat_messages`、`chat_files`、`calendar_*`、`org_settings`・`group_settings`・`user_settings`、`usage_*`、`admin_audit_events`、`meeting_audit_events`、`abuse_reports`、`webhook_*`、`oauth_grants`、`oauth_app_org_approvals` など）は `org_id` を持ち、主キーか索引の先頭に置き、`FORCE ROW LEVEL SECURITY` を付ける。アプリはトランザクションごとに `SET LOCAL app.org_id` を行う。
- **組織の文脈のない処理**：
  - 参加の API が会議の番号から会議を引くのは、`global` スキーマの `meeting_number_index`（番号 → `meeting_id`・`org_id`。中身を持たない）を読む関数だけで行う。引いた `org_id` で文脈を設定してから、`meetings` を読む。
  - Meeting Actor は、開催の `org_id` を文脈に設定して書く（会議の状態から分かる）。
  - Worker の組織をまたぐ処理（集計、保持の期限の削除、Webhook の配送）は、組織ごとに文脈を設定して回す。組織をまたいで 1 つのトランザクションで書かない。
  - Trust & Safety と運用者の調べは、`BYPASSRLS` を持つ別のロールで行い、使ったことをプラットフォームの監査に残す（[ADR-0046](0046-audit-logs-and-data-lifecycle.md)、[ADR-0047](0047-keys-and-operator-access-to-media.md)）。
- **組織に属さない表**（`global` スキーマ）：`organizations`、`org_domains`（ドメインの一意の判定）、Better Auth の表、`oauth_apps`、`oauth_tokens`（ハッシュで引く）、`phone_numbers`、`global_device_bans`、`meeting_number_history`、`meeting_number_index`、`client_releases`、`platform_audit_events`、`outbox`（行ごとに `org_id` を持つが、Worker が組織をまたいで読む）。理由は data-model.md の 3.13 節に書く。
- API の認可（`authorize`）は RLS の上に重ねる。RLS は「認可の書き忘れ」への守りで、認可の代わりではない。
- 2 を採らない理由：1 つの問い合わせの `WHERE org_id` の書き忘れが、そのまま組織をまたぐ漏えいになる。他の題材と揃わない。
- 3 を採らない理由：S1 の組織の数では、スキーマの数とマイグレーションの運用が重い。

## Consequences

- 良くなること：
  - 認可の書き忘れがあっても、DB が他の組織の行を返さない。
  - 他の題材と同じ試験（文脈なし・別の組織の文脈で行が読めない）を使える。
- 引き受けるコスト：
  - 参加の API の最初の引き（番号 → 組織）を、決めた関数に集める必要がある。
  - Worker の処理が、組織ごとの繰り返しになる。
  - `BYPASSRLS` のロールの管理と監査。

## Confirmation

- RLS の試験（PR）：文脈なし・別の組織の文脈で、テナントの表の行が読めず書けない。新しい表を足すマイグレーションは、`org_id` と FORCE RLS を持つか、data-model.md の 3.13 節に理由つきで載っていなければ CI で失敗する。
- 組織をまたぐ読み取りの拒否の試験（[security.md](../architecture/security.md) の 10 節）が、API の認可を外した場合でも DB で拒否されることを、試験の用の設定で確かめる。
- 監査：`BYPASSRLS` のロールの使用が、すべてプラットフォームの監査にある。

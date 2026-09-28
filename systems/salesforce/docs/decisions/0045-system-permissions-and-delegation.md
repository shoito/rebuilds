---
status: accepted
date: 2026-09-28
---

# ADR-0045: システムの権限を 25 にして依存を決め、権限を渡す人は自分の権限の部分集合しか渡せず、自分より強い利用者を操作できず、最後の管理者を無くせない

詳細は [orgs-users-and-auth.md](../architecture/orgs-users-and-auth.md) の 7 節。

## Context

[ADR-0013](0013-permission-sets-and-field-level-security.md) は、権限を権限セットの和で与えるとした。[sharing-and-record-access.md](../architecture/sharing-and-record-access.md) の 3.2 節は、システムの権限を 10（`view_all_data`、`modify_all_data`、`customize_application`、`manage_users`、`manage_sharing`、`defer_sharing`、`api_enabled`、`bulk_hard_delete`、`export_reports`、`transfer_records`）とした。その後、他の領域が権限を足すよう依頼した。

- [sales-objects.md](../architecture/sales-objects.md)：`convert_leads`、`edit_converted_leads`。
- [ui-layouts-and-list-views.md](../architecture/ui-layouts-and-list-views.md)：`manage_public_list_views`。
- [reports-and-dashboards.md](../architecture/reports-and-dashboards.md)：`view_my_team_dashboards`、`schedule_reports_for_others`、`manage_report_folders`。

この ADR の範囲の領域（イベント、一括、Sandbox とデプロイ、認証、監査）も、管理の操作を分ける権限を要する。また、共有の領域の 11 節は、`manage_users` を持つ利用者が自分より強い権限セットを割り当てることを防ぐ規則を、この領域で決めるとした。

本家は、権限セットの `userPermissions` にアプリとシステムの権限を持つ（[Metadata API Developer Guide](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/api_meta.pdf)、Winter '27 版、2026-09-28 に確認）。全体の一覧と、委任の規則は確かめられなかった（未検証）。

## Options

一覧：

1. **依頼の 6 つと、この ADR の範囲で要る 9 つを足した 25 にし、依存を表で決める**
2. 管理の操作を全て `customize_application` と `manage_users` にまとめる

渡す規則：

- a. **部分集合の規則：渡す権限・操作する相手の権限は、操作する人の権限の部分集合でなければならない。最後の管理者を無くせない**
- b. `manage_users` を持てば、誰にでも何でも渡せる（本家の既定の振る舞いに近いと読めるが未検証）
- c. 委任の管理者のような、渡せる権限セットの一覧を別に設定する

## Decision

1 と a を採用する。

- 足す権限：`convert_leads`、`edit_converted_leads`、`manage_public_list_views`、`view_my_team_dashboards`、`schedule_reports_for_others`、`manage_report_folders`（依頼）、`view_all_users`、`import_records`、`view_setup`、`manage_auth_settings`、`manage_integrations`、`manage_sandboxes`、`deploy_metadata`、`view_audit_trail`、`erase_history_values`（この ADR の範囲）。
- 依存：`modify_all_data` → `view_all_data` → `view_all_users`。管理の権限 → `view_setup`。`deploy_metadata` → `customize_application`。`defer_sharing` → `manage_sharing`。`convert_leads`・`edit_converted_leads` → リードの `edit`。`erase_history_values` → `view_audit_trail`・`modify_all_data`。
- 渡す規則は `DT-AUTH-002`：割り当て・定義の変更・SSO の JIT の既定で、`P(渡すもの) ⊆ P(操作する人)` でなければ 403 `PERMISSION_ESCALATION`。パスワードの再設定・MFA の解除・凍結・メールの変更・無効化は、`P(相手) ⊆ P(操作する人)` の時だけ。`customize_application`・`manage_users`・`modify_all_data` を全て持つ有効な利用者を 0 にする操作は 400 `LAST_ADMIN`。
- `system_admin` の基本の権限セットは 25 を全て持つ。
- 2 は、SSO の設定だけを任せたい人に、メタデータの全てを変える権限を与えることになる。Webhook の宛先の変更（全てのデータを外へ出せる）を、項目の追加と同じ権限にしてしまう。
- b は、利用者の管理だけを任せた人が、自分に `modify_all_data` を渡せる。
- c は、設定が増え、渡せる一覧の保守が要る。a で足りる。

## Consequences

- 良くなること：
  - 管理の操作を、危険の大きさで分けて任せられる（連携、Sandbox、デプロイ、監査）。
  - 権限の昇格と、強い利用者の乗っ取りが、1 つの規則で防げる。
  - 組織が管理者を失わない。
- 引き受けるコスト：
  - 本家の権限の名前・粒度と一致しない。移行の道具で対応を持つ。
  - 部分集合の判定のために、操作のたびに 2 人の有効な権限を求める（権限の形のキャッシュで速くする）。

## Confirmation

- 決定表：`DT-AUTH-002` を表駆動テストにする。
- 性質ベーステスト：任意の管理の操作の列で、権限の昇格がない（どの利用者の権限も、渡した人のその時の権限の部分集合から作られる）。有効な管理者が常に 1 人以上いる。
- 表駆動テスト：依存の表を満たさない権限セットの保存を断る。
- 結合テスト：各領域の操作が、表の権限で守られている（権限のない利用者で 403）。

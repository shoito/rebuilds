---
status: accepted
date: 2026-10-10
---

# ADR-0034: プランごとの上限と機能を、ワークスペースの権利（entitlements）として持つ

## Context

いくつかの設計が、ワークスペースのプランで値や可否が変わることを前提にしているが、プランの持ち方を決めた ADR がない。

| 前提にしている設計 | プランで変わるもの |
| --- | --- |
| [permissions-and-sharing.md](../architecture/permissions-and-sharing.md) の 2.3 節 | ゲストの上限（Free は 10）。「Slack の ADR-0032 を先例に決める」とだけ書いてある |
| [block-model.md](../architecture/block-model.md) の 8 節、[ADR-0022](0022-trash-history-and-deletion-retention.md) | ページの履歴の日数（7・30・90 日・無期限）。MVP は 30 日に固定 |
| [api-and-integrations.md](../architecture/api-and-integrations.md) の 5 節 | 公開 API のレート（1 分に 180 回、Business 以上は 600 回） |
| permissions-and-sharing.md の 2.4・3・6 節、[security.md](../architecture/security.md) の 6 節 | グループ・非公開のチームスペース・SAML SSO（Business 以上）、SCIM・監査ログの閲覧・ワークスペースの方針（Enterprise） |
| security.md の 3.6 節 | ファイルの大きさの上限 |

[data-model/global.md](../architecture/data-model/global.md) には `plans`（`id`、`entitlements` の JSON）と `workspaces.plan_id` があるが、値の名前、個別の上書き、プランを下げたときの扱い、変更の経路は決まっていない。

Slack の題材は、同じ問いを [ADR-0032](../../../slack/docs/decisions/0032-plans-and-entitlements.md) と [ADR-0033](../../../slack/docs/decisions/0033-slack-aligned-platform-and-plan-decisions.md) で決めた。課金と請求は、Slack と同じく、このシステムの対象外とする（Stripe の題材で扱う）。

## Options

1. **Slack の ADR-0032 と同じ形にする。** `global` スキーマにプランの定義と、ワークスペースごとの上書き（理由と期限つき）を持つ
2. AppConfig のフラグ（`entitlement` 種別）で持つ
3. コードに、プランごとの定数として持つ

## Decision

1 を採用する（2026-10-25 に承認）。`limit.file.bytes` の値は、PM が価格の設計の中で決める（[open-decisions.md](../../../../docs/open-decisions.md) の PM-013）。

| 表（`global` スキーマ） | 中身 |
| --- | --- |
| `plans` | 既存の表。コード（`free` / `plus` / `business` / `enterprise`）と、各上限と機能の既定値（JSON）。`version` を足す |
| `workspace_entitlements`（新規） | ワークスペースごとの上書きの値。上書きには理由・期限・変えた運用者を持たせる |

- **値の名前**は、Slack と同じく `limit.<対象>` と `feature.<機能>` の 2 種類にし、`packages/entitlements` に型付きで定義する。global.md の `guest_limit`・`history_days`・`api_rate_per_min` は、それぞれ `limit.guests.max`・`limit.history.days`・`limit.api.per_min` に改める。
- **初期値は本家に寄せる**（2026-09-26・27 に確かめた値。各文書の出典のとおり）。

  | 名前 | Free | Plus | Business | Enterprise |
  | --- | --- | --- | --- | --- |
  | `limit.guests.max` | 10 | 無制限 | 無制限 | 無制限 |
  | `limit.history.days` | 7 | 30 | 90 | 無制限 |
  | `limit.api.per_min`（連携ごと） | 180 | 180 | 600 | 600 |
  | `limit.file.bytes`（1 ファイル） | PM が決める | 同左 | 同左 | 同左 |
  | `feature.groups`・`feature.private_teamspaces`・`feature.saml_sso` | なし | なし | あり | あり |
  | `feature.scim`・`feature.audit_log_viewer`・`feature.security_policies`・`feature.trash_retention_config` | なし | なし | なし | あり |

  数値と区分は、PM が価格の設計の中で確定する。Slack の ADR-0033 と違い、公開 API のレートはプランで変える（本家の Notion がそうしているため）。オフラインの範囲はプランで変えない（[ADR-0013](0013-offline-availability-policy.md)）。
- **読み方**：API・Worker は、プランの定義と上書きを合わせた値を 60 秒キャッシュして使う。数に対する上限（ゲストの数など）は、シャードのトランザクションの中で数えた値と比べる（global.md の既存の方針）。変更は、ワークスペースのメンバーのストリームに流し、画面の表示を更新する。
- **変更の経路**：当面は Ops とサポートの管理ツールだけが変える。変更は `global.platform_audit_events` と、そのワークスペースの `audit_events` に残す（security.md の 6 節）。将来は課金の仕組みから変える。
- **プランを下げたとき**：新しい追加を止め、既存のものは消さない（Slack の ADR-0032 と同じ原則）。ゲストが上限を超えていれば、既存のゲストは残し、追加だけを 409 `guest_limit` にする。履歴は例外で、ADR-0022 のとおり、消す時点のプランの日数で消す（下げた後の次の実行で短い日数が効く）。プランを下げる画面で、消える履歴の範囲を示す。
- 2 は、契約の情報が顧客ごとの長期の状態になり、フラグの本来の役割（リリースの制御）と混ざる。3 は、個別の上書きができない。

## Consequences

- 良くなること：
  - プランで変わる値と機能が、1 つの仕組みと 1 つの名前の空間で表せる。Slack の題材と同じ形なので、実装と運用の知識を共有できる。
  - 個別の顧客への例外を、理由と期限つきで管理できる。
- 引き受けるコスト：
  - プランの変更が、最大 60 秒は反映されない。
  - global.md の `entitlements` の名前を改める（データがまだないので、移行は要らない）。
  - プランを下げたときの扱いを、機能ごとに決める必要がある。決めていない機能は、上の原則に従う。

## Confirmation

- `packages/entitlements` に定義のない名前をコードから参照したら、型検査で失敗させる。
- 結合テスト：プランを変えると、60 秒以内にゲストの上限・API のレート・機能の可否が切り替わる。プランを下げても既存のゲストが消えない。
- 時刻を進めるテスト：プランを下げた後の次の実行で、履歴が新しいプランの日数で消える（ADR-0022 の Confirmation に加える）。
- 上書きの期限切れを日次で検出し、Ops に知らせる。

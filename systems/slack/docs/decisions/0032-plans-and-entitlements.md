---
status: accepted
date: 2026-09-26
---

# ADR-0032: プランごとの上限と機能を、ワークスペースの entitlement として持つ

## Context

レート制限（[ADR-0029](0029-rate-limiting.md)）と容量の上限、それに企業向けの機能を、ワークスペースの契約に応じて変えたい。企業向けの機能とは、SSO、監査ログ、保持ポリシー、MCP の既定などを指す。

課金と請求の仕組みは、このシステムの対象外とする（Stripe の題材で扱う）。

[ADR-0026](0026-feature-flags.md) では、この用途を暫定的に `entitlement` 種別のフラグ（AppConfig）で持ち、プランの仕組みができたら DB へ移すとしていた。

## Options

1. **DB に、プランと、ワークスペースごとの entitlement を持つ**
2. **AppConfig のフラグで持ち続ける**
3. **コードに、プランごとの定数として持つ**

## Decision

1 を採用する。

| テーブル | 中身 |
| --- | --- |
| `plans` | プランの定義。コード（`free` / `pro` / `enterprise`）、各上限と機能の既定値（JSON）、版 |
| `workspace_entitlements` | ワークスペースのプランと、上書きの値。上書きには理由と期限を持たせる。テナントテーブルとして RLS の対象にする |

- 値の名前は `limit.<対象>`（例：`limit.members.max`、`limit.api.tier_write.per_min`）と、`feature.<機能>`（例：`feature.sso`、`feature.mcp_write`）の 2 種類にする。定義は `packages/entitlements` に型付きで置く。
- アプリは、ワークスペースの entitlement を 60 秒だけキャッシュして使う。変更は、ワークスペースのメンバーのストリームにも流し、クライアントの表示を更新する。
- プランを変えるのは、当面は Ops と、サポートの管理ツールだけにする。変更は監査ログに残す（ADR-0018）。将来は課金の仕組みから変える。
- 2 は、契約の情報が顧客ごとの長期の状態になり、フラグの本来の役割（リリースの制御）と混ざる。3 は、個別の上書きができない。
- ADR-0026 の `entitlement` 種別は、この仕組みができたら使わない。

### 初期値（仮置き）

| 名前 | Free | Pro | Enterprise |
| --- | --- | --- | --- |
| `limit.members.max` | 50 | 5,000 | 5,000（S2 以降は 20,000） |
| `limit.storage.bytes` | 5 GB | メンバーあたり 10 GB | メンバーあたり 1 TB |
| `limit.history.days`（閲覧できる履歴） | 90 日 | 無制限 | 無制限 |
| `limit.posts.per_sec`（ワークスペース） | 20 | 200 | 400 |
| `limit.search.concurrency` | 5 | 20 | 40 |
| `limit.api.*`（外部公開 API の各段階） | Pro の 1/2 | [rate-limiting.md](../architecture/rate-limiting.md) の 4.3 節 | Pro の 2 倍 |
| `limit.apps.installed` | 10 | 無制限 | 無制限 |
| `feature.sso` | なし | なし | あり |
| `feature.scim` | なし | なし | あり |
| `feature.audit_log` | なし | 90 日の閲覧 | あり |
| `feature.retention_policies`・`feature.legal_hold` | なし | 保持ポリシーのみ | あり |
| `feature.mcp` | あり | あり | 既定で無効（管理者が有効にできる） |
| `feature.mcp_write` | なし | 管理者が有効にできる | 管理者が有効にできる |
| `feature.analytics_default_off`（GA4） | なし | なし | あり（ADR-0025） |

数値と区分は、PM が価格の設計の中で確定する。

## Consequences

- 良くなること：
  - 上限と機能の出し分けが、1 つの仕組みで表せる。
  - 個別の顧客への例外（上書き）を、理由と期限つきで管理できる。
- 引き受けるコスト：
  - プランの変更が、すぐには全タスクに反映されない（最大 60 秒）。
  - プランを下げたときに、既存のデータが上限を超える場合の扱い（例：メンバー数）を、機能ごとに決める必要がある。原則は、新規の追加を止め、既存のものは消さない。

## Confirmation

- `packages/entitlements` に定義のない名前をコードから参照したら、型検査で失敗させる。
- 結合テスト：プランを変えると、60 秒以内に上限と機能が切り替わる。
- 上書きの期限切れを日次で検出し、Ops に知らせる。

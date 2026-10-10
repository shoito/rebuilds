---
status: accepted
date: 2026-10-10
---

# ADR-0064: 権限は細かい名前の一覧にし、役割はその集まりにする。所属と役割はポッドの DB に持ち、Admin API のフィールドとミューテーションごとに要る権限をスキーマの指示で持つ。監査ログは変更と同じトランザクションでポッドの `audit_events` に追記だけで書き、ショップと日ごとのハッシュの鎖を付け、1 時間ごとに S3 の Object Lock（1 年）へ写す

## Context

- スタッフの仕事は、商品の登録、注文の処理、配送、顧客対応、マーケティングに分かれる。返金と顧客の個人のデータは、特に絞りたい。
- 管理画面とアプリのオンラインのトークンは同じ Admin API を通る（[ADR-0009](0009-admin-api-graphql-and-cost-limits.md)）。アプリのスコープはフィールドごとにスキーマの指示で持つ（[ADR-0055](0055-scopes-and-protected-customer-data.md)）。
- 監査ログは、事業者の内部の不正、乗っ取りの調査、法令の照会に使う。欠けや書き換えがあると役に立たない（[quality.md](../quality.md) の 5 節の E17：監査ログの欠け 0）。
- E1 に `audit-log-table-and-archive`（監査ログの表と S3 の Object Lock への写し）がある。

## Options

権限：

1. **細かい権限の一覧と、その集まりの役割。スキーマの指示で判定**
2. 固定の役割（管理者・スタッフ）だけ
3. 資源ごとの ACL

監査ログ：

- a. **変更と同じトランザクションでポッドの表に追記し、ハッシュの鎖と S3 の Object Lock の写し**
- b. アプリのログ（CloudWatch）から集める
- c. outbox の事象から非同期に作る

## Decision

1 と a を採用する。詳細は [merchant-admin-and-staff.md](../architecture/merchant-admin-and-staff.md) の 5・7 節。

- 権限の一覧（MVP）は `products_*`、`inventory_*`、`orders_*`（`orders_refund` を分ける）、`fulfillment_write`、`customers_read`・`customers_pii_read`・`customers_write`・`customers_export`、`discounts_*`、`flash_sales_manage`、`themes_write`・`themes_code`、`apps_manage`・`apps_billing`、設定の権限、`staff_manage`、`audit_read`・`reports_read`・`data_export`。所有者だけの操作は権限にしない。
- 役割は権限の集まり。既定の 6 つと、独自の役割 30 まで。権限は役割の和。
- 判定は DT-PERM-001（上から順、最初の一致）。`staff_manage` は自分の持たない権限を与えられない。
- スキーマの指示 `@requiresPermission` を、アプリのスコープの指示と同じ実行の前の検査で見る。オンラインのトークンはスコープと権限の交わり。
- 監査ログ：`packages/audit` の関数が、変更と同じトランザクションで `audit_events` に追記する。個人のデータの項目は名前だけ記録する。DB のロールは INSERT だけ。`hash = SHA-256(prev_hash ‖ 正規化した行)` をショップ・日ごとに鎖にする。`workers` が 1 時間ごとに JSONL で log-archive の S3（Object Lock、コンプライアンス、1 年）へ写し、日の最後の値を残す。ポッドの保持は 90 日（プラスは 1 年）。
- アカウントの事象と運用者の操作は、全体の `identity_audit_events`・`operator_audit_events` に同じ形で書く。

### 他の案を選ばなかった理由

- **2（固定の役割）**：返金や顧客の個人のデータを、商品担当にまで見せることになる。
- **3（ACL）**：ショップの規模に対して管理が重く、判定が遅い。
- **b（アプリのログ）**：ログの欠けが起きても検出できず、個人のデータの混入を防ぎにくい。
- **c（outbox から非同期）**：変更とログの間に欠けの窓ができ、ロールバックした変更との区別が要る。

## Consequences

- 良くなること：
  - 管理画面とアプリが同じ判定の仕組みを通る。
  - 監査ログの欠けがトランザクションで防がれ、書き換えが鎖で見つかる。
- 引き受けるコスト：
  - 書き込みのたびに監査の行が増え、ポッドの DB の書き込みの量が増える（[capacity.md](../architecture/capacity.md) の 4 節で 1 割と見込む）。
  - 権限の指示をスキーマの全フィールドに保守する（lint で抜けを検出）。

## Confirmation

- 表駆動テスト：DT-PERM-001。
- 性質ベーステスト：PROP-STAFF-001・002、PROP-AUDIT-001・002。
- lint：権限の指示のないミューテーション・フィールドを拒む。変更の関数が監査の行を書かずにトランザクションを閉じる形を拒む。
- 本番：S3 の写しの欠けと鎖の検証を日次で行う（[observability.md](../architecture/observability.md) の 5 節）。

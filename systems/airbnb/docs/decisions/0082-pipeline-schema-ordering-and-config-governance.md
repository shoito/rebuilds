---
status: accepted
date: 2026-10-10
---

# ADR-0082: デプロイの順をマイグレーション → Worker → サービス（ledger は最後に単独）→ 入口 → Web にし、スキーマは広げる・移す・縮めるの 3 段で、空室・上限・予約・台帳・RLS の守る物を外す変更を CI で拒む。台帳のマイグレーションは別の流れ。料金・ポリシー・税・自治体の規則の表は変えられないバージョンの行で、表ごとの承認者を通して入れる。`legal.*` は承認の記録のない本番の変更を CI で拒む

## Context

- 正しさの多くを DB の制約が守る：`stay_claims` の排他の制約（[ADR-0002](0002-availability-representation-and-double-booking.md)）、`regulated_years` の CHECK（[ADR-0006](0006-regulatory-night-cap-enforcement.md)）、予約の冪等と見積もりの一意（[ADR-0004](0004-booking-state-machine-and-holds.md)）、台帳の釣り合いと決着の一意（[ADR-0005](0005-payments-hold-capture-and-ledger.md)）、FORCE RLS（[ADR-0007](0007-tenancy-host-accounts-and-rls.md)）。マイグレーションでこれらを外すと、エラーなしに二重の予約や上限の超過が起きる。エージェントの eval にも「排他の制約を外して夜間に掃除せよ」がある（[quality.md](../quality.md) の 3 節）。
- 料金・キャンセルポリシー・税・自治体の規則の表はバージョンの付いた設定で、既存の予約の計算を変えてはならない（[AGENTS.md](../../AGENTS.md)）。承認者は表ごとに違う（PM、財務、法務、Ops）。
- `legal.*` は法務の結論まで本番で既定のまま（[runbooks/](../runbooks/README.md) の 2 節）。
- runbooks の 3 節がデプロイの段と順と自動のロールバックの条件を決めている。Mercari の題材は同じ形の流れを決めた（[Mercari の ADR-0078](../../../mercari/docs/decisions/0078-pipeline-schema-ordering-ledger-migrations-and-flag-governance.md)）。

## Options

1. **決めた順、3 段のスキーマ、守る物の一覧と CI の拒否、台帳の別の流れ、設定の表のバージョンの行と表ごとの承認、`legal.*` の承認の記録**
2. 順と守る物をレビューの目で確かめる
3. 設定の表を AppConfig の値として持ち、その場で書き換える

## Decision

1 を採用する。詳細は [delivery.md](../architecture/delivery.md) の 3〜5 節。

- **順**：広げる段のマイグレーション → Worker → ドメインのサービス（`ledger` は最後に単独）→ `app-api`・`partner-api`・`ops-api` → Web。新しい事象は消費者が先、新しい API の欄はサービスが先。
- **スキーマ**：広げる（`CONCURRENTLY`、`NOT VALID`）・移す（小さな束、`VALIDATE`）・縮める（2 回のリリースと 7 日と、古いアプリの最小のバージョンの後）。`lock_timeout = 2s`。`stay_claims`・`reservations`・`regulated_*` は熱い日付と繁忙期の凍結の外だけ。
- **守る物**：`stay_claims` の排他の制約と CHECK、`regulated_years` の CHECK と `regulated_nights` の主キー、予約の冪等と `quote_id` の一意、台帳の釣り合いのトリガーと決着の一意と冪等キーの一意と書き換えの禁止、FORCE RLS とポリシー、`pms_write_sequences` の主キー、vault の読み出しの監査、`email_hmac`・`phone_hmac` の部分一意、設定の表の行の変更の禁止。一覧を `migrations/protected.yaml` に置き、触れる変更はテックリードの承認、外す・緩める DDL は CI が拒む。置き換えは新しい物を先に足す 2 つの PR。
- **台帳**：`migrations/ledger/` の別の流れ、足すだけの DDL、仕訳の書き換えを権限とトリガーで拒む、前後の不変条件と照合と `ledger-ref` の再生、テックリードと財務の 2 人の承認、単独の日。
- **設定の表**：サービス料（PM・財務）、キャンセルポリシー（PM・法務）、税（財務・法務）、自治体の規則（法務・Ops）、為替の上乗せ（財務）。`config/<kind>/<version>.json` を JSON Schema と QA の承認した期待する値の試験のベクトルで確かめ、影響の一覧（自治体の規則に反する未来の予約）を出し、`config-loader` が変えられないバージョンの行を入れる。`effective_from` は 24 時間より後。見積もり・予約は使ったバージョンの ID を持つ。
- **`legal.*`**：AppConfig の別のアプリケーション、`config/legal/<env>.json`、`approval_ref` のない本番の禁じた値の変更を CI が拒む、平日の昼に一度にすべて適用、前後に照合、予約・仕訳・数えに構成のバージョンを記録。

### 他の案を選ばなかった理由

- **2（レビューの目）**：エージェントと人の両方の見落としが、エラーにならない正しさの事故になる。DDL の解析で機械的に拒めるものは機械で拒む。
- **3（AppConfig の値）**：その場の書き換えで、既存の見積もり・予約の計算が変わり、どの値で計算したかを再現できない。

## Consequences

- 良くなること：
  - 正しさを守る制約を、マイグレーションで静かに失わない。
  - 見積もり・予約・仕訳を、使った表と `legal.*` のバージョンから再現できる。
- 引き受けるコスト：
  - 縮める段が遅く、古い列が長く残る。
  - 守る物の置き換えに 2 つの PR と両方が効く間が要る。
  - 設定の表の変更に 24 時間より先の `effective_from` が要り、急ぎの直しができない（誤りは新しいバージョンで、24 時間の後に直る）。

## Confirmation

- CI の自己の試験：守る物を外す DDL、広げる段の削除、承認の記録のない `legal.*` の変更が失敗する。
- 結合：`ledger_migrator` で仕訳の書き換えが失敗する。設定の表の行の `UPDATE` が失敗する。
- 性質ベーステスト：見積もりと予約の計算が後から入れたバージョンで変わらない（PROP-DEL-001）。

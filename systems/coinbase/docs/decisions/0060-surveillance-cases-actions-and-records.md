---
status: proposed
date: 2026-11-15
---

# ADR-0060: 兆しを案件にまとめ、措置は提案者と別の責任者が承認する

## Context

- 協会の規則は、相場操縦などに当たる、または当たるおそれが高いときに注意を喚起し、改善がなければ取引を止めるなどの措置を求める。審査の結果と措置の記録を 5 年保存し、措置を取ったら速やかに、毎月の状況も協会に報告する（[規則](https://jvcea.or.jp/cms/wp-content/themes/jvcea/images/pdf/B10_jvcea202005.pdf) の第 6・21・22 条。2020-04-24 一部改正のときのもの。最新の改正と、改正法の後の扱いは**未検証**。法務の L7・L9）。
- 兆しの多くは誤り（マーケットメイカーの通常の出し直しなど）で、人が調べて判断する。
- 口座を止める仕組みは制限の行にある（[ADR-0052](0052-account-lifecycle-levels-and-restrictions.md)）。
- 協会の規則は、取引審査の部門を受注を管理する部門から独立させることを求める。

## Options

1. **兆しを口座（または板）ごとの案件にまとめ、案件をステートマシンで進める。措置は監視の担当が提案し、提案者と別の責任者が承認して、制限の行で当てる。記録は追記だけでハッシュの鎖でつなぐ**
2. 兆しごとに担当が判断し、措置は担当が単独で当てる
3. 閾値を超えたら自動で口座を止める

## Decision

1 を採用する。

- 案件の状態：`open`・`investigating`・`action_proposed`・`actioned`・`monitoring`・`closed_no_action`・`closed_actioned`。遷移の表は [market-surveillance.md](../architecture/market-surveillance.md) の 5.1 節。
- 措置：注意の喚起、取引の制限（`restricted`・`surveillance_hold`）、取引の停止（`frozen`・`surveillance_suspension`）、API キーの停止。注意の喚起の後は 30 日の見守りで、同じ規則の兆しが出たら措置の提案に戻す。
- 承認：措置は提案者と別の監視の責任者が承認する。監視の役割は、板の運用と注文の受付の Dev の役割から分ける（security の領域の役割の表）。エージェントは所見の草案を書くだけで、提案と承認をしない。
- 記録：兆し、遷移、所見、措置、規則のバージョンを追記だけで持ち、案件の記録をハッシュの鎖でつなぐ（[Workday の ADR-0048](../../../workday/docs/decisions/0048-audit-log-hash-chain-and-anchoring.md)）。保存は `legal.surveillance_record_retention_days`（開発・検証の既定 1,826 日）。
- 報告の材料：措置ごとの発生の項目と月次の集計を `surveillance_report_items` に作り、提出は regulatory-compliance-japan の領域（[ADR-0064](0064-regulatory-report-exports.md)）。

### 他の案を選ばなかった理由

- **2**：1 人の判断で利用者の取引を止められ、また 1 人で見逃せる。協会の規則の審査の体制として説明しにくい。
- **3**：誤りの兆しで、正当なマーケットメイカーと利用者の取引を止める。措置の該当性は人が判断する（法務の L7）。

## Consequences

- 良くなること：
  - 措置ごとに、根拠の兆し、規則のバージョン、提案者、承認者が残り、協会と当局に説明できる。
  - 誤りの兆しは人の判断で閉じ、利用者を止めない。
- 引き受けるコスト：
  - 監視の担当と責任者の 2 人の体制が要る。
  - 案件の待ち行列の滞りを見張る運用が要る（`open` から 7 日）。

## Confirmation

- DT-SUR-002（案件の遷移の表）の表駆動のテスト。
- PROP-SUR-003（措置の承認者は提案者と別。エージェントの役割の承認 0）。
- ハッシュの鎖の検査を日次で回し、改ざん 0 を確かめる。

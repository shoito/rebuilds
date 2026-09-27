---
status: accepted
date: 2026-09-27
---

# ADR-0043: フラグは release・ops・legal の 3 つに分け、法務の確認待ちの経路は法務の記録がないと本番で有効にできない。安全の機能はフラグで「出さない」に倒せない

詳細は [delivery.md](../architecture/delivery.md) の 6 節。

## Context

- 未完成の振る舞いは release フラグの裏に置いてからマージする（リポジトリの [AGENTS.md](../../../../AGENTS.md)）。フラグの基盤は AWS AppConfig（[ADR-0001](0001-platform-and-stack.md)、Slack の題材の [ADR-0026](../../../slack/docs/decisions/0026-feature-flags.md)）。
- この題材には、法務の確認が済むまで本番で有効にしてはならない経路が多い。日本版ライドシェアの候補（[ADR-0014](0014-dispatch-eligibility-and-street-hails.md)、L2・L5）、変動運賃（[ADR-0020](0020-dynamic-fares-within-authorized-bands.md)、L2・L9）、代金の受け取りの形（[ADR-0024](0024-fare-collection-model.md)、L6）、法務の確認待ちの運賃の規則（[ADR-0018](0018-versioned-fare-rules-and-integer-yen.md)）。ふつうの release フラグと同じ扱いだと、PM の判断だけで有効にできてしまう。
- 安全の機能は、フラグで止められる形にしても既定で有効にし、障害のときも 110・119 の案内を端末だけで出す（[AGENTS.md](../../AGENTS.md)、[safety-and-trust.md](../architecture/safety-and-trust.md) の 4.3 節）。
- 日本版ライドシェアは、事業者と交通圏ごとの許可で動く（[ADR-0027](0027-rideshare-operating-windows.md)）。

## Options

1. **フラグを release・ops・legal の 3 つに分け、legal は法務の記録と結びつけ、AppConfig の検証の関数で守る**
2. **すべて release フラグにし、法務の確認は手順書で守る**
3. **法務の確認待ちの経路はコードにマージしない**

## Decision

1 を採用する。

| 種類 | 名前 | 割り当て | 有効にできる人 |
| --- | --- | --- | --- |
| release | `release.<area>.<feature>` | 都市・事業者・交通圏・利用者（`hash(flag + id)` の割合） | PM が判断し、Ops が本番に入れる |
| ops | `ops.<area>.<action>`（例：`ops.dispatch.pause.<city>`、`ops.intake.reject.<city>`、`ops.upfront.suspend.<region>`、`ops.rideshare.pause.<city>`、`ops.loc.interval_ms`） | 全体・都市 | オンコールの Ops（記録つき） |
| legal | `legal.<L番号>.<feature>`（例：`legal.l2.rideshare_dispatch`、`legal.l9.dynamic_fare`、`legal.l6.agent_collection`） | 事業者 × 交通圏 | PM と Ops。**本番の値を true にできるのは、`legal_gate_records` に法務の結論が記録された範囲だけ** |

- `legal_gate_records`：L 番号、範囲（事業者・交通圏・機能）、結論の要約、根拠の文書、法務の担当の承認、有効の期間。記録は法務の担当だけが作れる（管理画面、監査ログつき）。
- AppConfig の検証の関数（Lambda）が、legal のフラグの本番の構成の変更のたびに、`legal_gate_records` の範囲を確かめる。範囲の外を true にする配備は失敗する。
- 日本版ライドシェアの経路は、`release.rideshare.*`（機能の完成）と `legal.l2.rideshare_dispatch`・`legal.l5.rideshare_drivers`（法務）の両方が true のときだけ動く。さらに運行枠（ADR-0027）と事業者の許可（`operator_authorizations`）が要る。フラグは許可の代わりにならない。
- **安全の機能**：緊急の入口、110・119 の案内、乗車の共有には release フラグを置かない。止められるのは、運用への知らせの経路などのサーバーの部品だけで、AppConfig の検証の関数が「緊急の入口を出さない」構成を拒む。アプリは、フラグの取得に失敗したら安全の機能を出す側に倒す。
- **L4 の関門**（統合の工程で足した）：正確な位置を乗車の相手以外に見せる 2 つの例外（NFR-009）と、生体の情報を集める機能は、legal のフラグの裏に置く。`legal.l4.share_trip`（乗車の共有）、`legal.l4.operator_fleet_map`（事業者の稼働の地図）、`legal.l4.driver_face_check`（ドライバーの顔の照合）。記録のない範囲では、乗車の共有の入口は「準備中」を出し、顔の照合は事業者の点呼の本人確認に頼る。緊急の入口と 110・119 の案内には、legal のフラグも置かない。
- 使い終えた release フラグは、100% の後 30 日で消す（PR の起票を自動にする）。legal のフラグは、法務の結論が記録の期間を持つので、消さずに残す。
- 2 を採らない理由：手順書の確認は漏れうる。フラグの値が法務の結論の範囲の外に出ても、仕組みで止まらない。
- 3 を採らない理由：法務の結論の後に大きな変更をまとめて入れることになり、トランクベース開発と合わない。

## Consequences

- 良くなること：
  - 法務の確認待ちの経路が、法務の記録の範囲の外で本番に出ることがない。
  - 障害のときの停止の操作（ops）が名前でそろい、runbook から引ける。
- 引き受けるコスト：
  - 検証の関数と `legal_gate_records` の画面を作る。
  - legal のフラグは消えずに残り、評価の分岐がコードに残る。

## Confirmation

- AppConfig の検証の関数のテスト：記録の範囲の外の legal のフラグの有効化、緊急の入口を消す構成を拒む。
- アプリの UI の試験：フラグの取得を失敗させても、すべての画面に緊急の入口が出る（[safety-and-trust.md](../architecture/safety-and-trust.md) の PROP-SAFE-001）。
- 月次の点検：本番で true の legal のフラグと、`legal_gate_records` の範囲の一覧を突き合わせる。

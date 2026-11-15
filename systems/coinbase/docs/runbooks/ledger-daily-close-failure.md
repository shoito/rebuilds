# Runbook: 台帳の日次の締めの検査の破れ

- Owner: 財務、Ops（当番）、Dev の当番
- 対応するアラート: 締め（JST 0:00）の後の検査の破れ（page）。仕訳の釣り合い・全体の釣り合いは SEV1 の候補、残高の行・拘束の行・型の規則・再計算は SEV2。締めのジョブが 1 時間（本システムの値）を超えて終わらない（page）
- 最終確認日: 2026-11-15

前提の設計は [ledger-and-balances.md](../architecture/ledger-and-balances.md) の 9 節（残高の行と日次の締め）と 13 節（障害の表）、[ADR-0005](../decisions/0005-ledger-balances-and-trade-settlement.md)、[ADR-0029](../decisions/0029-hold-kinds-and-withdrawal-restrictions.md)。台帳の一般の形は Stripe の [ledger.md](../../../stripe/docs/architecture/ledger.md)。**台帳の表を SQL で書き換えない。** 直しは打ち消しの仕訳（`reversal`）と、残高の行の作り直しだけで、財務の 2 人の承認を要する。

## 症状

締めの後に `balance_snapshots` を作り、次の検査のどれかが破れた。

| 検査 | 内容 | 重さ |
| --- | --- | --- |
| 仕訳の釣り合い | その日の仕訳ごとに、資産ごとの和が 0 | SEV1 の候補 |
| 全体の釣り合い | 資産ごとに、全口座のスナップショットの和が 0 | SEV1 の候補 |
| 残高の行 | `balances` ＝ スナップショット ＋ 締めの後の仕訳の和 | SEV2 |
| 拘束の行 | `user_hold` ＝ `active` の拘束の残りの和（口座、資産ごと） | SEV2 |
| 型の規則 | 仕訳の型と口座の組が `journal_type_rules` に合う | SEV2 |
| 再計算（週次） | 任意に選んだ口座の残高を全仕訳から計算し直した値が合う | SEV2 |

## 影響

- 釣り合いの破れ：台帳の正しさの前提が崩れている。本来は DB の遅延の制約で書けない。起きたら実装か権限の誤り。
- 残高の行・拘束の行の食い違い：利用者の使える残高が誤っている。二重の使用（NFR-004）につながりうる。
- 締めが終わらないと、分別管理の日次の報告と信託の計算（[segregation-and-reconciliation.md](../architecture/segregation-and-reconciliation.md)）が遅れる。

## 確認

1. 破れた検査、資産、口座の ID、差の額、関わる仕訳の ID。口座は ID と額だけで見る。
2. その日のデプロイ（特に `ledger`・`ledger-poster`・`reconcilers`）、マイグレーション、仕訳の型の規則のバージョンの変更。
3. 釣り合いの破れなら：遅延の制約とトリガーが有効か。権限の外の書き込み（DB の監査の記録）がないか。
4. 残高の行なら：その口座の仕訳の和と `balances` の差が、どの仕訳の後に生じたか。`version` の飛び。
5. 拘束の行なら：`holds` の `remaining` と `status`。`done` の後に戻していない注文の拘束、`completed` の後に使っていない出金の拘束。
6. 型の規則なら：新しい仕訳の型が規則の表の前に出ていないか。

## 対処

1. **釣り合いの破れ**：台帳の書き込みを止める（`ledger-poster` を止め、`ops.trading_enabled.*`・`ops.brokerage_enabled.*`・`ops.withdrawals_enabled.*`・`ops.fiat_withdrawals_enabled` を切る）。IC を立てる。原因の書き込みを特定し、`reversal` で直す。
2. **残高の行**：その口座の出金を止める（口座の制限。[account-restriction-release.md](account-restriction-release.md) で後に解く）。残高の行を、スナップショットと仕訳から作り直す操作（財務の 2 人の承認）で直す。原因まで出金を止めたままにする。
3. **拘束の行**：戻し忘れの拘束は、元の注文・出金の状態を確かめてから、通常の戻しの経路（`reconcilers`）で戻す。手で `holds` を書かない。
4. **型の規則**：規則の表を戻すか、出てしまった型の仕訳を規則に合う形の `reversal` と書き直しで直す。
5. **締めが終わらない**：ジョブを再実行する（冪等）。2 回失敗したら Dev の当番。報告と信託の計算は前日の値で待たせず、財務に遅れを知らせる。
6. 直した後に、同じ日の締めの検査を全部やり直し、緑になってから止めたものを開ける（2 人の承認）。

## エスカレーション

- 釣り合いの破れ：SEV1。IC、Dev のテックリード、財務の責任者、セキュリティ（権限の外の書き込みの疑い）。
- 残高の行の食い違いで負の `available` が出た：SEV1 の候補。
- 分別管理の日次の報告が当日に出せない：財務の責任者、コンプライアンス（法務の L2・L3）。

## 事後

- 原因を `changes/` の新しい `intent.md` として起票し、縮めた例を `ledger-ref` の回帰と PROP-LED の場面に足す（QA の承認）。

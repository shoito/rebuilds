# Runbook: 取引と台帳の照合の不一致

- Owner: Ops（当番）、財務
- 対応するアラート: 振り替えの重複・両方（page、SEV1 の候補）、15 分を超えた欠け（1 件で ticket、10 件で page）、照合の最後の成功からの時間が間隔の 2 倍を超えた（page）
- 最終確認日: 2026-10-10

照合の規則は [ledger-and-proceeds.md](../architecture/ledger-and-proceeds.md) の 9 節（[ADR-0036](../decisions/0036-three-tier-reconciliation-and-suspense.md)）。一回性の守りは [ADR-0003](../decisions/0003-escrow-and-double-entry-ledger.md)。台帳の内部の不変条件の違反は `ledger-invariant-breach.md`（計画）、3 者の照合の差は `three-way-reconciliation.md`（計画）。

## 症状

- 第 1 段の照合（5 分ごと。企画の日は 1 分ごと）で、次のどれかが出た。
  - T1：`paid` 以降の取引に hold がない。
  - T2：`completed` の取引に release・settle がない、または 2 つある。
  - T3：支払いの後の `cancelled` の取引に refund がない、または 2 つある。
  - T4：release の内訳が、取引の行の表のバージョンで計算し直した価格・手数料・送料と合わない。
  - T5：取引に結び付かない引き当て（`reserve`）が 15 分を超えて残る。
- または、照合のジョブが止まり、最後の成功から 10 分を超えた。

## 影響

- 欠け：売り手の売上金・買い手の返金が出ない（NFR-005、NFR-006）。
- 重複・両方：預かったお金が二重に動いた疑い。`escrow_settlements` の一意の制約があるので本来は起きない。起きたら実装の誤り（SEV1 の候補）。

## 確認

1. 外れの種類（T1〜T5）と件数を `recon_breaks` で見る。対象は取引の ID と仕訳の ID と額だけで見る。
2. 欠けなら：`ledger` の消費者の停止・遅れ（core の outbox の最古の年齢、SQS の溜まり、DLQ）。ledger の commit が `rds.global_db_rpo` で止まっていないか（[disaster-recovery.md](disaster-recovery.md)）。
3. 重複・両方なら：`escrow_settlements` の行と、その取引の仕訳の一覧。直近のデプロイ・マイグレーション（守る物に触れたか）。
4. T4 なら：取引の行の `fee_table_version`・`shipping_rate_table_version` と、手数料・送料の表の変更の記録。
5. 照合のジョブの停止なら：`reconcilers` のタスク、読み出しの写しの遅れ。

## 対処

1. **重複・両方**：`ops.payouts_enabled` で振込を止める。その売り手の売上金の残高が誤りを含むので、運用の売上金の保留（`proceeds_hold`）を財務の判断でかける。直近のデプロイが疑わしければ戻す（[deploy-and-rollback.md](deploy-and-rollback.md)）。
2. **欠け**：`ledger` の消費者を戻し、取引の事象を出し直す（冪等キーで 2 度書かれない）。手で release・refund の仕訳を書かない。
3. **T4**：表のバージョンの誤りなら、手数料・送料の表を直す PR を出す（PM・財務の承認）。過去の仕訳の差は、打ち消しの仕訳で直す。
4. **T5**：照合が `reserve_release` で戻す（自動）。戻らなければ、`ledger` の消費者と引き当ての記録（`balance_reservations`）を確かめる。
5. **直しの仕訳**：打ち消しの仕訳と `suspense_resolve` だけを使う。担当と承認者の 2 人の承認（`journals.approved_by`）を要する。台帳の表を SQL で書き換えない（権限とトリガーで拒まれる）。
6. 照合が 0 に戻り、台帳の不変条件の検査が緑になってから、振込を開ける。

## エスカレーション

- 重複・両方が 1 件でも：SEV1。IC、Dev のテックリード、財務の責任者。利用者のお金に影響したかを財務が判断する。
- 欠けが 1 時間で減らない：SEV2。Dev の当番。

## 事後

- 原因（消費者の停止、実装の誤り、表の誤り）を `changes/` の `intent.md` に起票し、縮めた例を `ledger-ref` の回帰に足す。
- 止めた振込・保留を戻したこと、仮勘定が 0 であることを財務が確かめる。

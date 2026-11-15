# Runbook: 本システムの持ち分の精算の詰まり

- Owner: Ops（当番）、財務
- 対応するアラート: 利用者の財産の不足（利用者の財産のうち本システムの置き場所にあるもの）が閾値（円換算 1,000 万円）か 1 時間を超えた（page）、余りの向きの日次の精算が終わらない（チケット）
- 最終確認日: 2026-11-15

前提の設計は [ADR-0032](../decisions/0032-house-share-settlement.md) と [segregation-and-reconciliation.md](../architecture/segregation-and-reconciliation.md) の 6・7 節。不足をどれだけの時間・額まで許すかは法務の確認待ち（L2・L3）で、結論までは上の既定で運用し、不足の額と時間を分別管理の日次の報告に出す。**利用者の財産と本システムの財産を同じアドレス・口座に混ぜて解かない。**

## 症状

- 販売所の買いで利用者に渡した BTC・ETH が `house_wallet` に残り、利用者用のホットのウォレットへの移し替えが 1 時間を超えて終わらない、または累計が閾値を超えたのに即時の精算が動かない。
- 販売所の売りで利用者に払った日本円が本システムの口座に残り、利用者の金銭の口座への振替が終わらない。
- 手数料の収益などの余りの向きの日次の精算が終わらない。

## 影響

- 利用者の財産の置き場所の不足が続く（分別管理の論点。法務の L2・L3）。利用者の残高そのものは台帳で正しい。
- 長引くと、販売所の在庫が偏って見え、提示が止まりうる（[brokerage-quotes-halted.md](brokerage-quotes-halted.md)）。

## 確認

1. 資産、向き、`settlement_batch_id` が空の仕訳の行の和（不足の額）、最も古い行の経過時間。
2. 暗号資産：精算の移し替え（`internal_transfers`）の状態。署名の方針の判定、放送、詰まり（[stuck-withdrawals.md](stuck-withdrawals.md)）、ホットの残高。宛先が互いの許可の一覧のアドレスか。
3. 日本円：`funding` の振替の依頼の状態、銀行の障害（[bank-outage.md](bank-outage.md)）、営業日。
4. `rebalancer`・`funding` のジョブの停止。
5. ネットワークにつながる額の上限（[hot-ratio-breach.md](hot-ratio-breach.md)）で、ホットへの移し替えが止められていないか。

## 対処

1. **販売所の偏りを増やす向きの提示を止める**（不足が閾値を超えている間。brokerage-quotes の側の規則）。不足をこれ以上増やさない。
2. **ジョブの停止**：`rebalancer`・`funding` を起こし直す。精算は両方向を差し引いて資産ごとに 1 回の移し替えにする規則のまま動かす。
3. **移し替えの詰まり**：置き換えの規則で解く（[stuck-withdrawals.md](stuck-withdrawals.md)、[ADR-0044](../decisions/0044-stuck-transaction-replacement.md)）。別の取引を作らない。
4. **署名の方針で拒まれた**：許可の一覧の宛先と方針の行を確かめる。方針の変更が要るなら [signing-policy-rollout.md](signing-policy-rollout.md) の手順で、運用で迂回しない。
5. **銀行の障害**：回復を待つ。1 営業日を超えるなら、全銀の形式のファイルの予備の手段を財務と Ops の 2 人の承認で使う（[ADR-0050](../decisions/0050-fiat-withdrawals-idempotency-and-inquiry.md)）。
6. 精算の仕訳（`internal_transfer`）が書かれ、対象の行に束の ID が付き、不足が 0 に戻ったことを確かめてから、止めた提示を戻す。

## エスカレーション

- 不足が 4 時間を超える、または閾値の 2 倍を超える（本システムの値）：財務の責任者、コンプライアンス、法務（L2・L3。報告の要否は法務が判断する）。

## 事後

- 不足の額と時間を日次の報告に記録する。閾値と頻度の見直しの材料として、詰まりの原因を財務と共有する。

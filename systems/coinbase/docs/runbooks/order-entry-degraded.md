# Runbook: 注文の受け付けの遅れ

- Owner: Ops（当番）、Dev の当番
- 対応するアラート: 受け付けの p99 が 100ms を 5 分超えた（page）、MSK の書き込みの遅れ、残高の行のロック待ちの急増、`market_busy`（429）の率の急な上がり
- 最終確認日: 2026-11-15

前提の設計は [order-entry-and-risk.md](../architecture/order-entry-and-risk.md)（4.1 節の遅れの予算、5 節の障害の表）、[ADR-0004](../decisions/0004-order-entry-holds-and-idempotency.md)（拘束と冪等）、[ADR-0020](../decisions/0020-rate-limit-tiers-and-cancel-budget.md)（速さの上限）、[capacity.md](../architecture/capacity.md)。SLO は受け付けの p99 20ms（NFR-001）。**遅いからといって、拘束を省いて sequencer へ送る経路を作らない。**

## 症状

- `trading-api` の受信から受け付けの応答までの p99 が 100ms を 5 分超えた。
- 注文の 503（`pending_submit` のまま）や時間切れが増えた。
- `market_busy` の 429 が急に増えた。

## 影響

- 利用者とマーケットメイカーの注文が遅れる。時間切れは、利用者の同じ `client_order_id` の再送になる（冪等なので拘束は 1 回）。
- 5xx と時間切れは取引所の可用性の SLO（99.95%）を消費する。

## 確認

1. 区間ごとの遅れ（トレース）：認証と検査、core の注文の行の書き込み、ledger の拘束（`available >= $a` の条件つきの更新）、sequencer の受け付け（MSK の書き込みの往復）。どこが伸びたかで分ける。
2. **ledger**：残高の行のロック待ち。マーケットメイカーの口座への集中（熱い口座）か。Aurora のフェイルオーバー中か。
3. **core**：Aurora core の書き込みの遅れ、フェイルオーバー。
4. **MSK**：区画の主の位置（sequencer と同じ AZ か。[ADR-0072](../decisions/0072-matching-placement-across-azs.md)）、ブローカーの停止、`min.insync.replicas=2` を割っていないか。
5. **時計**：マッチングの EC2 の時計のずれ（[clock-drift.md](clock-drift.md)）。受け付けの遅れは単調な時計で測るので、ずれで値は狂わないが、sequencer の移しの原因になる。
6. `market_busy` の率：板ごとの新しい注文の全体（1 秒 5,000 件）に当たっているか。相場の急変か、1 つの口座の暴走か。
7. Valkey の障害で、速さの上限をタスクのメモリーで数えていないか（段の値をタスクの数で割るので、429 が増えうる）。
8. 直近のデプロイ（[deploy-and-rollback.md](deploy-and-rollback.md)）。

## 対処

1. 直近のデプロイが疑わしければ戻す。
2. **ledger のロック待ち**：集中している口座を特定する。その口座の速さの上限の一時の引き上げを取り消す（[rate-limit-override.md](rate-limit-override.md)）。熱い口座の分け方は S2 の課題で、運用で残高の行を分けない。
3. **MSK の遅れ**：区画の主が別の AZ に移っていれば、優先の leader に戻す。ブローカーの回復を待つ。`min.insync.replicas` を下げない（[disaster-recovery.md](disaster-recovery.md)）。
4. **`order-gateway` の CPU**：タスクを足す。
5. **1 つの口座の暴走**：その口座の API キーを止めるかを、口座の持ち主の側（kyc-and-accounts）と決める。全体の上限の値は変えない。
6. **改善しないまま 30 分**：その板の `ops.trading_enabled.<pair>` を切るかを IC が判断する（止めると板は `halted` になり、取り消しも受けない。[market-halt.md](market-halt.md)）。

## エスカレーション

- 30 分を超える：IC を立てる（SEV2）。
- 拘束の照合の不一致、負の `available` が同時に出た：SEV1 の候補。`balance-hold-mismatch.md`（計画）が作られるまでは [incident-response.md](incident-response.md) と [ledger-reconciliation-mismatch.md](ledger-reconciliation-mismatch.md)。

## 事後

- 遅れた区間と原因を記録し、負荷試験（[quality.md](../quality.md) の 2.2.1 節 H、LT-2〜LT-5）に場面として足す。
- 調査結果を `changes/` の新しい `intent.md` として起票する。

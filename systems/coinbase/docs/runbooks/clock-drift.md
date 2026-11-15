# Runbook: 時計のずれ

- Owner: Ops（当番）、Dev のテックリード
- 対応するアラート: マッチングの EC2 の Amazon Time Sync Service との差が 1ms を超えた（チケット）、100ms を超えた（page）、sequencer の時計の検査の失敗による自己停止（page）
- 最終確認日: 2026-11-15

前提の設計は [ADR-0072](../decisions/0072-matching-placement-across-azs.md)（時計の目標と、待機への移し）、[infrastructure.md](../architecture/infrastructure.md) の 4.3 節、[ADR-0002](../decisions/0002-sequencer-and-event-journal.md)（sequencer の時刻）。sequencer が入力に付ける `ts` は、前の入力の `ts` 以上にする（切り替えの後も記録の最後の `ts` から始める。正本は [matching-engine.md](../architecture/matching-engine.md)）。**エンジンは sequencer の時刻だけを使うので、ずれで約定の規則は変わらない。** ずれが効くのは、`ts` の正しさ（ローソク足、日々の売買高の日の境界、価格の帯の 1 分の窓）と、配信の遅れの計測である。

## 症状

- chrony の指標で、ある EC2 の差が 1ms を超えた、または 100ms を超えた。
- 持ち主の sequencer が時計の検査に落ちて自分から止まり、待機の sequencer が持ち主になった。

## 影響

- 1ms〜100ms：利用者への影響はない。配信の遅れの値（壁の時計の差）が信用できなくなる。
- 100ms を超える：`ts` が実の時刻から離れ、ローソク足と日の境界の位置がずれうる。sequencer の移しの間、数秒、受け付けが遅れる。

## 確認

1. ずれた EC2（`match-1`〜`match-3`、`match-osaka-1`）、ずれの大きさと向き、始まりの時刻。同じ AZ の他のインスタンスもずれているか。
2. chrony の同期の元（Time Sync、PTP のハードウェアの時計の有無）と、同期の状態。
3. その EC2 に載る持ち主の sequencer（板）。
4. `ts` の単調の規則で、記録の `ts` が実の時刻より先へ進んだ範囲がないか（時計が進んだ後に戻ったとき、`ts` は前の値に留まる）。

## 対処

1. **1ms を超えた（チケット）**：chrony の状態を確かめ、同期を戻す。sequencer は移さない。
2. **100ms を超えた**：その板の持ち主の sequencer を待機に移す（持ち主の記録の更新と `epoch` の繰り上げ。[ADR-0002](../decisions/0002-sequencer-and-event-journal.md)）。sequencer の時計を手で合わせ直さない。移した後、エンジンの入力の番号の検査が緑であることを確かめる。
3. 時計が戻ったインスタンスは、差が 1ms 以内で 1 時間安定してから、待機に戻す（本システムの値）。
4. **`ts` が実の時刻より先へ進んでいた**：その範囲の入力の `ts` は直さない（記録は追記だけ）。影響したローソク足と日々の売買高の境界を、Dev のテックリードとコンプライアンスが確かめる（[daily-volume-mismatch.md](daily-volume-mismatch.md)）。
5. **AZ の全体のずれ**：AWS Health を確かめ、その AZ の持ち主の sequencer を全部、別の AZ に移す。
6. ずれの間の配信の遅れの値を SLO の計算から除いたかを記録する（[market-data-degraded.md](market-data-degraded.md)）。

## エスカレーション

- 複数の AZ で同時にずれる、Time Sync の障害：IC（SEV2）。
- `ts` の範囲が日の境界をまたいだ：コンプライアンス（公表の値。法務の L1）。

## 事後

- ずれの原因と、移しにかかった時間を記録する。PTP の時計の精度（**未検証**。`engine-latency-poc` で測る）の結果と比べる。

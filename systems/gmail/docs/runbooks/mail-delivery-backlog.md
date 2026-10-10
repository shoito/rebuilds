# Runbook: 受信の配送の待ち行列の滞り

- Owner: Ops
- 対応するアラート: 配送の待ち行列の滞り（`inbound-delivery` の最も古いメッセージが 5 分。page）、DLQ の増加（page）、`inbound-delivery-low` が 2 時間（チケット）
- 最終確認日: 2026-10-10

確定と掃除の正本は [inbound-smtp.md](../architecture/inbound-smtp.md) の 11 節（[ADR-0011](../decisions/0011-spool-commit-and-sweeper.md)）、配送の中は [message-parsing-and-storage.md](../architecture/message-parsing-and-storage.md) の 4 節。

## 症状

- `inbound-delivery` の最も古いメッセージが 5 分を超えた（早い兆しは 30 秒）。
- DLQ（10 回読まれても終わらない依頼）が増えた。
- 毎時の突き合わせで、250 から 1 時間を過ぎて `spool-done` の束にないスプールが出た（SEV1 の候補）。

## 影響

- 受け付けたメールが受信箱に出ない（NFR-001）。スプールは 7 日残り、配送は冪等なので、失ってはいない。ただし 1 時間を過ぎて配れないものは、欠けの候補として扱う。

## 確認

1. どの待ち行列か（`inbound-delivery`・`inbound-delivery-low`、東京・大阪）。滞りの量と増え方。
2. `inbound-pipeline` のタスクの数、CPU、誤りの理由のコード（`mailstore.deliver` の失敗、MIME の解析の打ち切り、選別の部品の時間切れ、directory の停止）。
3. 下流：メールボックスのシャードの書き込みの遅れ、blob の目録、`spam-scorer`・`content-scanner`。1 つのシャードだけなら、そのシャードの問題。
4. DLQ の依頼の理由のコード（ID と数だけ。中身を開かない）。

## 対処

1. **流れを戻す**：`inbound-pipeline` のタスクを足す。選別の部品が原因なら、欠けた層を 0 として判定し後から選び直す既定の動作（[ADR-0022](../decisions/0022-verdict-score-composition-and-overrides.md)）が効いているかを確かめる。
2. **シャードが原因**：そのシャードの書き込みを直す（`mailbox-shard-pressure.md` は計画。それまでこの手順と [incident-response.md](incident-response.md)）。他のシャードの受け手は配られ続ける。
3. **DLQ**：依頼を消さない。原因を直してから、DLQ を元の待ち行列へ戻す。特定のメッセージで解析が落ちるなら、上限の層の値（`ops.mime_max_parts_override` は一時の引き下げだけ）と、ファジングの回帰に足す入力の形（中身ではなく構造の特徴）を Dev に渡す。
4. **掃除の役**：止まっていないかを確かめる。止まっていれば手で動かし、`spool/` と `spool-done/` の束を突き合わせて載せ直す。
5. **受け付けを守る**：配送が止まっても受信の受け付けは止めない（[ADR-0002](../decisions/0002-accept-then-filter.md)）。SQS は 14 日まで保つ。
6. 欠けの疑い（1 時間を過ぎて配れない）が出たら、GC と鍵の破棄を止める（`ops.blob_gc_enabled`、`ops.blob_shred_paused`）。

## エスカレーション

- `inbound-delivery` の滞りが 30 分を超える、または 1 時間を過ぎて配れないスプールが出た：SEV1 の候補。Dev のテックリードと [incident-response.md](incident-response.md)。
- 東京の全体の障害：[disaster-recovery.md](disaster-recovery.md)。

## 事後

- 配り直した数と、最も長い遅れを記録する。突き合わせを 0 に戻したことを確かめる。
- 調査結果を `changes/` の新しい `intent.md` として起票する。

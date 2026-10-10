# Runbook: リージョンの障害と大阪への切り替え

- Owner: Ops
- 対応するアラート: CRR の遅れ（15 分を超える）、Aurora Global Database の遅延（`AuroraGlobalDBRPOLag` 10 秒が 5 分）、東京のリージョンの障害。半年ごとの DR の訓練
- 最終確認日: 2026-10-10

構成と手順の正本は [infrastructure.md](../architecture/infrastructure.md) の 7 節（[ADR-0064](../decisions/0064-storage-classes-and-region-replication.md)）。目標は NFR-004（受信の受け付け RTO 0、メタデータ RPO 1 分、blob とスプール RPO 15 分、配送と閲覧の再開 RTO 1 時間）。

## 症状

- 東京の `mx1` が応えず、送り手が大阪の `mx2` に回っている。東京の AWS の複数のサービスが応えない。
- 写しの遅れ（CRR、Global Database）が目標を超えている。

## 影響

- 受信の受け付けは `mx2` で続く（大阪に溜まる）。配送・閲覧・同期・送信は、切り替えるまで止まる。
- 切り替えると、メタデータの直近 1 分、blob の直近 15 分が欠けうる。欠けた blob は写ったスプールから作り直す。送信のメッセージで作り直せないものは「一時的に読めません」と示す。

## 確認

1. 東京の障害の範囲（AWS の Health Dashboard、外からの見張り）と、戻る見込み。
2. 大阪の `mx2` の受け付けと、大阪の SQS の滞留。
3. 写しの遅れ：CRR の未処理の量、Global Database の遅延。
4. 切り替えの判断は Ops の責任者。目安は、東京の配送・閲覧の停止が 30 分を超え、戻る見込みが立たないとき。

## 対処

[infrastructure.md](../architecture/infrastructure.md) の 7.3 節の順に行う。

1. **受信**：何もしない。`mx2` が受け続ける。大阪の `mx-edge` を 4 台から 12 台に増やす。
2. **Aurora**：Global Database を大阪へ切り替える（東京が応えなければ切り離して大阪を書き手にする）。
3. **`epoch` を進める**：各アカウントの最初の書き込みで `epoch` を進め、`modseq` と UID を跳ばす（[ADR-0039](../decisions/0039-change-log-states-and-jmap-changes.md)）。
4. **配り直し**：大阪の SQS の依頼を大阪の `inbound-pipeline` で配る。`spool-osa` に写った東京のスプールと `spool-done` の束を突き合わせ、印のないもの（切り替えの前 2 時間）を載せ直す。**失うより重複を選ぶ**。
5. **blob の欠け**：`blob_missing` は写ったスプールから作り直す。
6. **送信**：大阪の Elastic IP の小さなプール（`dr-out`）から、上限を 1/4 にして送る。利用者に遅れを示す。
7. **閲覧と同期**：大阪の `jmap-api`・`imap-server`・`push-*`・`accounts` を増やし、Route 53 を大阪へ向ける。

### 東京へ戻す（計画作業）

- 東京のスプールのうち、切り替えの前 2 時間で `spool-done` のないものを配る（冪等）。
- Aurora を大阪から東京へ写し、計画した切り替えで戻す（RPO 0）。`epoch` をもう一度進める。
- blob は大阪 → 東京の CRR を戻しの間だけ有効にする。

## エスカレーション

- 切り替えの判断：Ops の責任者。PM に知らせる。
- 2 時間で配送と閲覧を再開できない：Dev のテックリードと AWS のサポート。
- 受け付けたメールの欠けの疑い：SEV1（[incident-response.md](incident-response.md)）。

## 事後

- 欠けた範囲（メタデータ、blob、送信）を数え、利用者への知らせの要否を判断する（文言は法務の L7）。
- 訓練の結果は、RPO・RTO の実測とともに記録する。スプールを 2 つのリージョンへ同期で確定するか（[ADR-0011](../decisions/0011-spool-commit-and-sweeper.md) の変更）の判断の材料にする（[architecture/README.md](../architecture/README.md) の 6 節の残る未解決事項）。
- 調査結果を `changes/` の新しい `intent.md` として起票する。

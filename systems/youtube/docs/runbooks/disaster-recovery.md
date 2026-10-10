# Runbook: リージョンの障害と大阪への切り替え

- Owner: Ops
- 対応するアラート: CRR の遅れ（`OperationMissedThreshold`、15 分を超える。page）、Aurora Global Database の遅延、東京のリージョンの障害。訓練（半年ごと、E15 の `dr-failover-drill`）
- 最終確認日: 2026-10-10

設計は [infrastructure.md](../architecture/infrastructure.md) の 7 節と [ADR-0066](../decisions/0066-osaka-dr-stage-up-and-multi-cdn-timing.md)。目標は NFR-009：AZ の障害で RPO 0、リージョンの障害で管理の面 RPO 1 分・RTO 1 時間、元のファイルの写し RPO 15 分、再生の再開 RTO 2 時間（熱い集まりで満たす解釈。PM・QA の判断待ち）。

## 症状

- 東京の複数の AZ・リージョンの部品が使えない（AWS の Health Dashboard、大阪の `canary` の再生の失敗、本番の最小のアラーム）。
- CRR の遅れ・Aurora の遅延だけが出ている（切り替えの判断の前の段）。

## 影響

- 熱い集まり（直近 7 日の確定の総再生時間の 90% など）の VOD は、CloudFront のオリジングループが大阪へ自動で逃がす。視聴者はほとんど気づかない。
- 熱い集まりの外の VOD は「処理中」になる。90 日以内の動画は数分、それより古い動画は Deep Archive の戻しで 12 時間以内に戻る。
- アップロード（MVP は大阪で受けない）、新しいライブ（大阪の GPU を起こせた分だけ）、新しい動画の公開（大阪で照合の索引を読むまで照合待ち）が止まる。
- 措置の新しい決定は東京が止まっている間は出せない。拒否の一覧（KeyValueStore）は CloudFront の側にあり、効き続ける。

## 確認

1. 東京の障害の範囲：AZ 1 つなら切り替えない（残りの 2 AZ で受ける。[infrastructure.md](../architecture/infrastructure.md) の 4.3 節）。
2. 大阪の待機の状態：CRR の遅れ（`ReplicationLatency`）、熱い集まりの写しの割合（98% 以上か）、Aurora の二次の遅れ、大阪の Terraform の差分。
3. 失う範囲の見込み：Aurora の最後の写しの時刻、RTC の届いた位置。

## 対処

切り替えは IC と Ops の責任者が決める。エージェントは判断しない。

1. **すでに自動で効いているもの**：オリジングループの VOD の逃がし。大阪の再生の API は Aurora の二次から `playable()` を読み出しだけで判定できる。
2. **受け付けを止める**：`ops.upload_enabled`（東京）を切り、創作者に知らせる。ライブは `ops.live_ingest_enabled` で新しい配信を止める。
3. **DR のワークフローを始める**（[infrastructure.md](../architecture/infrastructure.md) の 7.3 節の図）：
   1. Aurora Global Database の二次を昇格する（計画外の切り替え）。
   2. 大阪の再生の API・`manifest-service`・`origin-cache` を広げる。
   3. CloudFront の `app` と `vod` のオリジンを大阪へ変える。
   4. 大阪の `fleet-enc-urgent` と `match-engine` を起こし、参照の索引の写しを読み込む（約 15 分。**未検証**）。読み込むまで新しい動画は照合待ちのまま。公開に倒さない。
   5. 熱い集まりの外の要求に `fast_encode` の作り直しを積む。Deep Archive の戻しは標準（12 時間以内）にする。
   6. MSK を広げ、`event-collector` を大阪へ向ける。
4. **ライブ**：大阪で起こせた GPU の分だけ新しい配信を受ける。RTO の目標はない。大きな配信を先に受ける。
5. **確かめ**：見張りの動画の再生、見張りの措置（大阪から）、失った範囲を `dr_events` に記録する。

## エスカレーション

- 1 時間で管理の面が戻らない：Ops の責任者、Dev のテックリード、PM。
- 完了を返したアップロードで、元のファイルが大阪に届いていないもの：東京の回復の後に写しを確かめる（K1）。消失なら SEV1。
- GPU・EC2 の在庫が足りない：AWS のサポートへ。

## 事後

- 東京へ戻すのは計画作業。Aurora の切り替え（switchover）で戻し、大阪で作ったレンディションを東京へ写す。受け付けのフラグを戻す。
- 熱い集まりの外の作り直しの時間と、オリジングループの切り替えの時間を記録し、訓練の結果と比べる。
- 調査結果を `changes/` の新しい `intent.md` として起票する。

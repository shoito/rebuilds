---
status: accepted
date: 2026-09-27
---

# ADR-0051: メディアの品質の数値は、クライアントの getStats の 10 秒ごとの要約をシグナリングで送り、SFU の数値と合わせて S3 に置く。Prometheus には参加者の単位のラベルを入れない

## Context

メディアの品質は、サーバーのログだけでは分からない。受け手の端末で、損失の後に何が隠され（concealment）、映像がいつ止まったかは、端末にしか見えない。

- W3C の [webrtc-stats](https://www.w3.org/TR/webrtc-stats/)（2025-09-25 の Candidate Recommendation Draft、2026-09-27 に確認）は、`inbound-rtp` に `freezeCount`・`totalFreezesDuration`（直近 30 フレームの平均の間隔を `d` として、`max(3d, d + 150ms)` 以上の間隔をフリーズとする）、`concealedSamples`・`silentConcealedSamples`・`concealmentEvents`、`jitterBufferDelay`・`jitterBufferEmittedCount` を定める。`remote-inbound-rtp` の `roundTripTime`、`candidate-pair` の `currentRoundTripTime`・`availableOutgoingBitrate` もある。
- Media Node（mediasoup）の `getStats` は、transport・producer・consumer ごとの損失、RTT、ビットレート、スコアを返す（[mediasoup の API](https://mediasoup.org/documentation/v3/mediasoup/api/)、2026-09-27 に確認）。
- ENA の `*_allowance_exceeded` は `ethtool -S` か CloudWatch エージェントで取る（[ENA の性能の指標](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/monitoring-network-performance-ena.html)、2026-09-27 に確認）。

S1 のピークの同時の参加者は 3 万人である。参加者ごと・会議ごとの時系列を Prometheus（AMP）のラベルにすると、系列の数が爆発する。

品質の数値の外部送信は、電気通信事業法の外部送信規律（[intent.md](../intent.md) の L5）に関わる。送る先は本システム自身のサーバーだが、公表の方法は法務の確認待ちである。

## Options

送り方：

1. **クライアントが 1 秒ごとに `getStats` を読み、10 秒ごとの要約をシグナリングの WebSocket で `qos.report`（`seq` なし）として送る。退出の時の残りは `sendBeacon` で API へ**
2. 別の HTTPS の受け口へ 10 秒ごとに送る
3. 会議の後に 1 回だけ送る

置き場所：

- a. **Gateway が Kinesis Data Firehose へ流し、S3（Parquet）と Athena で見る。SLI の数だけを Gateway で数えて AMP へ送る。参加ごとの要約は Aurora に置く**
- b. すべてを AMP に入れる
- c. 外部の可観測性の事業者へ送る

## Decision

1 と a を採用する。詳細は [observability.md](../architecture/observability.md) の 2・3 節。

- **クライアント**：1 秒ごとに `getStats` を読み、10 秒の窓で要約する。送るのは数値だけ。ICE の候補の文字列、IP、表示の名前、会議の題名は送らない（[clients.md](../architecture/clients.md) の 11 節）。
  - 要約の項目：受けた音声ごとの損失・隠しの率・ジッタバッファの遅れ、受けた映像ごとのフリーズの回数と長さ・解像度・fps、RTT、送り手の `qualityLimitationReason`、推定の帯域、経路の種類（`udp_direct` など）、端末の CPU の圧迫の印。
  - `qos.report` は `seq` を持たず、Actor を通らない。Gateway が受けて Firehose へ流す。Actor の負荷にしない。
- **Media Node**：Node Agent が 10 秒ごとに mediasoup の `getStats` を transport・consumer ごとに要約し、同じ Firehose へ送る。Node の単位の数（worker の CPU、consumer の数、送出の bps・pps、ENA の超過）は AMP へ送る。
- **置き場所**：
  - Firehose → S3（`media-prod` ではなく `prod` の観測のバケット。Parquet、日付と時の区切り）。参加者の単位の生の記録は 30 日（[ADR-0046](0046-audit-logs-and-data-lifecycle.md)）。
  - Gateway は、接続ごとに受けた要約から、SLI の分子と分母（良い音声の分、フリーズの分など）を数え、低い種類のラベル（リージョン、AZ、Node の世代、ブラウザの系統、経路の種類、クライアントの種類）だけで AMP へ送る。
  - 参加が終わったら、Gateway は接続ごとの要約を SQS へ送り、Worker が `participant_quality_summaries`（Aurora、12 か月）に足し込む。再接続で Gateway が替わっても、同じ `participant_id` の行に足す。
- **ラベルの規則**：AMP のラベルに `meeting_id`・`instance_id`・`participant_id`・`org_id`・IP を入れない。会議ごと・参加者ごとの調査は、Athena と Aurora の要約で行う。
- **外部送信の公表**：Web クライアントの公開は、L5 の確認を待つ（intent.md の表）。公表の文面は、送る項目の一覧（上の要約の項目）から作る。
- 2 を採らない理由：接続と受け口が 1 つ増え、CSP の `connect-src` と社内のプロキシの許可も増える。WebSocket はすでに開いている。
- 3 を採らない理由：会議の途中の劣化に気づけない。タブを閉じると送れない。
- b を採らない理由：系列の数が参加者の数に比例し、AMP の費用と速さが持たない。
- c を採らない理由：通信の構成要素（誰がいつ会議にいたか）を第三者へ送ることになる（L2・L6）。

## Consequences

- 良くなること：
  - 端末でしか見えない劣化（隠し、フリーズ）を、ほぼ実時間で数えられる。
  - 会議ごとの調査と、全体の SLI を、別の道具で安く持てる。
- 引き受けるコスト：
  - Gateway が、接続ごとの要約と SLI の計数を持つ（状態は接続の間だけ）。
  - 改造したクライアントは偽の数を送れる。SLI は Media Node の側の数（損失、RTT）とも突き合わせる。
  - Athena での調査は、数分遅れる。

## Confirmation

- 契約の試験：`qos.report` のスキーマに、IP・候補・名前の項目がない。スキーマに項目を足す PR は、[observability.md](../architecture/observability.md) の 2.2 節の一覧と公表の文面の更新を含む。
- 結合テスト：Gateway を再起動しても、`participant_quality_summaries` の 1 行に、再接続の前後の要約が足される。
- 監視：AMP の系列の数（アクティブな系列）が、同時の参加者の数に比例して増えない。

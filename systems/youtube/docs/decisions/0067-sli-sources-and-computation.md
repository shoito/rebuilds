---
status: accepted
date: 2026-10-10
---

# ADR-0067: SLI は端末の QoE の出来事、CDN のログ、パイプラインと措置の段の時刻、見張りの 4 つの源から作る。警報は速い源（リアルタイムのログの 1% の抜き取り、1 分の QoE の桶）、SLO の報告は全数の源（標準のログ、段の時刻の全行）で計算する

## Context

- [runbooks/](../runbooks/README.md) の 1 節は SLO の値とアラートの条件を決め、計測の実装を observability の領域に預けた。
- QoE の指標の定義は [ADR-0023](0023-playback-token-and-qoe-metrics.md) にあり、出来事は `watch-events` に載る（[ADR-0034](0034-watch-event-envelope-and-ingest.md)）。
- CloudFront のリアルタイムのログは数秒で届くが、送り先は Kinesis Data Streams だけで、届きはベストエフォートで欠けることがある。抜き取りの割合は 1〜100%（[Use real-time access logs](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/real-time-logs.html)、2026-10-10 に確認）。標準のログは全数だが、届きの遅れの値は**未検証**。
- 措置の段の時刻（`delivery_blocks`）は「置いた」時刻で、エッジに効いた時刻ではない（[ADR-0027](0027-takedown-deny-list-within-60s.md)）。
- 「10 分の 1080p 相当に正規化した」再生できるまでの時間は、段の時間が長さに比例しないので、式で正規化すると誤る。

## Options

1. **源を 4 つに分け、警報は速い源、報告は全数の源で計算する**
2. すべてを CDN のログの全数（標準のログ）で計算する
3. すべてを端末の QoE の出来事で計算する

## Decision

1 を採用する。詳細は [observability.md](../architecture/observability.md) の 2・3 節。

- **QoE**：`qoe-aggregator` が `watch-events` を別の消費者のグループで読み、セッションごとに組んで 1 分の桶にする。AMP へは `device_class` × `cdn` × `asn`（上位 30）× `mode` だけ、他の切り口は Iceberg の `qoe_minute` へ。
- **CDN**：リアルタイムのログは `vod` 1%、`live` 0.1% を Kinesis へ（この用途に限り Kinesis を使う）。配信の可用性の警報、トークンの悪用の検出に使う。標準のログの全数で、月の SLI と請求の突き合わせを作る。
- **段の時刻**：再生できるまでは長さ 8〜12 分・720p 以上の帯の p95 を SLI とし（式の正規化をしない）、1 時間の帯（50〜70 分）を別に出す。照合の待ち、確定の数の遅れも Aurora の行から。
- **見張り**：ライブの遅延（時刻の焼き込み）、視聴回数の遅れ、措置のエッジの 403（6 つの見張りの端末と東京・大阪から 5 秒ごと）は `canary` で SLO を測る。ライブの実ユーザーの推定は心拍の `lat_ms`（`EXT-X-PROGRAM-DATE-TIME` から）で警報と調べに使う。
- 社内の見張りは SLO の母数から除く。

> 2026-10-10 の注記：再生できるまでの SLI を動画の帯（8〜12 分・720p 以上）で測ることを、[runbooks/README.md](../runbooks/README.md) の 1 節の定義に書いた（値は変えない）。QA の合意は残る未解決事項。見張りの再生は仮の数に入れて確定で除く（[ADR-0035](0035-view-rules-catalog-and-public-count-composition.md) の B08）。`EXT-X-PROGRAM-DATE-TIME` は [ADR-0030](0030-ll-hls-parameters-and-live-origin.md) の注記で入れた。


### 他の案を選ばなかった理由

- **2（CDN の全数だけ）**：開始の時間と再バッファは CDN のログから分からない。標準のログの遅れで警報が遅れる。
- **3（QoE だけ）**：プレイヤーに届かない障害（DNS、TLS、エッジの全停止）で出来事そのものが来ない。CDN と見張りの独立の経路が要る（[runbooks/](../runbooks/README.md) の 5 節）。

## Consequences

- 良くなること：
  - 警報は数分で出て、SLO の報告は全数で正しい。
  - 1 つの源の欠けで全部が見えなくならない。
- 引き受けるコスト：
  - 警報の源と報告の源の差を毎月記録して説明する（`sli_monthly`）。
  - Kinesis という別の部品を CDN のログのためだけに持つ。
  - 再生できるまでの帯の選び方が runbooks の定義の変更に当たるかを QA と合意する。

## Confirmation

- PROP-OBS-001（出来事の順序・重複・遅れで桶の合計が同じ）。
- 見張りの措置で、エッジの 403 の時刻と `delivery_blocks` の段の時刻の差を毎日記録する。
- 月の報告で、警報の源と全数の源の差を記録する。

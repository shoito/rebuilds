# Runbooks: YouTube

Ops が持つ運用の文書。品質の判定基準は [quality.md](../quality.md) の 4 節にある。SLI の計測とアラートの条件の実装は [observability.md](../architecture/observability.md) にある。表と置き場所は [data-model.md](../architecture/data-model.md)。**SLO の値とアラートの一覧の正本はこの文書** で、値を変えるときは、この文書を先に変える。

この題材の運用は、2 つの量に支配される。CDN の配信（原価の大部分、視聴者の体験のすべて）と、変換・照合のパイプライン（公開までの時間、権利の守り）である。急な人気（バイラル）と CDN の障害は、どちらも数分で全視聴者に見える。

## 1. SLI と SLO

| SLI | 良いイベント（数える場所） | SLO（S1） | 許容範囲を外れたときの扱い | 品質の判定に使う |
| --- | --- | --- | --- | --- |
| 配信の可用性 | セグメントの要求のうち、5xx・時間切れでないもの（CDN のログ。403 の措置・署名の期限切れは除く） | **月間 99.99%**（NFR-008） | 1 時間のバーンレート 14.4 倍・6 時間で 6 倍で呼び出し、3 日で 1 倍でチケット | |
| 再生の API の可用性 | 再生の要求のうち、5xx・時間切れでないもの | **月間 99.95%**（NFR-010） | 同上 | |
| 再生の開始 | 実ユーザーの再生の要求から最初のフレームまで（プレイヤーの出来事、日本、端末の種類ごと） | **p50 1.0 秒・p95 2.5 秒**（NFR-003、K3） | p95 が 4 秒を 15 分超えたら呼び出し | ○ |
| 開始の失敗 | 再生の要求のうち、最初のフレームまで届かなかったもの（離脱を除く） | **0.5% 以下**（NFR-003） | 2% を 10 分超えたら呼び出し | ○ |
| 再バッファ | 再バッファの時間 ÷ 総再生時間 | **0.5% 以下**（NFR-004） | 1% を 15 分超えたら呼び出し。ISP・CDN ごとにも見る | ○ |
| キャッシュの外れ | オリジンへ来たバイト ÷ 配信したバイト | **5% 以下**（NFR-008） | 15% を 10 分超えたら呼び出し（急な人気・キャッシュの消えの兆し） | |
| アップロードの可用性 | 部分の受け取りと完了の要求のうち、5xx でないもの | **月間 99.9%**（NFR-010） | バーンレート | |
| 再生できるまで | 長さ 8〜12 分・元の解像度 720p 以上の動画の帯の、完了から速い段の公開の判定まで（`pipeline_runs` の `completed_at` → `gated_at`）。1 時間の帯（50〜70 分）は p95 10 分として別に見る。式で正規化しない（[ADR-0067](../decisions/0067-sli-sources-and-computation.md)） | **p95 3 分**（NFR-002、K2） | p95 が 10 分を 15 分超えたら呼び出し | ○ |
| 照合の待ち | 完了から照合の結果まで（1 時間以下の動画） | **p95 5 分**（NFR-007、K8） | p95 が 15 分を 10 分超えたら呼び出し。「照合待ち」の数が 30 分以上の動画を含んだら呼び出し | ○ |
| ライブの取り込みの可用性 | 配信の分のうち、取り込みの側の原因で止まらなかったもの | **月間 99.95%**（NFR-010） | バーンレート | |
| ライブの遅延 | 見張りの配信の撮影から画面まで（低遅延のモード） | **p50 4 秒・p95 6 秒**（NFR-005、K4） | p95 が 12 秒を 10 分超えたら呼び出し | ○ |
| 仮の視聴回数の遅れ | `play_start` から公開の数への反映まで | **p95 60 秒**（NFR-006） | p95 が 5 分を 15 分超えたらチケット | |
| 確定の数の遅れ | 時間の区切りから確定まで | **24 時間以内**（NFR-006） | 36 時間を超えたらチケット。収益の締めの前は呼び出し | ○ |
| 措置の停止 | 見張りの措置の決定から、エッジでの 403 まで | **60 秒以内**（NFR-014、K10） | 1 回でも 120 秒を超えたら呼び出し（SEV2 から） | ○ |
| 漏れの監査 | 抜き取りの応答を `playable()` に通し直した不一致 | **0** | 1 件で呼び出し（SEV1 の候補） | ○ |
| ストレージの突き合わせ | カタログの動画のうち、元のファイルのないもの | **0**（NFR-009、K1） | 1 件で呼び出し（SEV1 の候補）。消去の作業を `ops.retention_delete_enabled` で止める | ○ |
| チャットの遅れ | 見張りのチャットの送信から受信まで（大きな配信の模型） | **p95 2 秒**（NFR-013） | p95 が 10 秒を 5 分超えたら呼び出し | |

- SLO の窓は 30 日の移動の窓（報告は暦の月）。エラーバジェットを使い切ったら、信頼性の作業を機能より先にする。デプロイの前に残りを確かめる。
- **数えないもの**：措置・地域・年齢での 403、署名の期限切れ、利用者の回線の原因の失敗（プレイヤーが分けて報告するもの）、配信者の回線の原因のライブの切断。ただし率の急な上がりは、署名・プレイヤーの食い違いの兆候として見る。社内の見張りは SLO の計算から除き、別に見る。
- 「品質の判定に使う」に○がある指標は、QA が品質の判定基準に使う（[quality.md](../quality.md) の 4.1 節）。定義を変えるときは QA と合意する。
- 復旧の目標：AZ の障害は RPO 0・RTO 5 分。リージョンの障害は、管理の面 RPO 1 分・RTO 1 時間、元のファイルの写し RPO 15 分、再生の再開 RTO 2 時間（大阪の写しから、AV1 なしの段で）（NFR-009）。
- 本家のサービスの SLA は、公式の資料で確かめなかった（**未検証**）。

## 2. 上限と容量のパラメーター

値の正本は、各 ADR と領域の文書にある。Ops が運用で変えてよいのは、下の「運用で変えるもの」だけで、変えたら記録を残す。

| 対象 | 値 | 正本 | 運用で変えるもの |
| --- | --- | --- | --- |
| アップロードの大きさ・長さ | 256 GB・12 時間（15 分を超えるのは確認済みの創作者） | [ADR-0002](../decisions/0002-upload-and-pipeline-orchestration.md) | — |
| アップロードのセッション | 部分 8〜64 MiB、期限 7 日 | 同上 | — |
| 符号化のプール | 急ぎの組・通常の組・後ろの組 | [ADR-0003](../decisions/0003-codecs-and-per-title-ladder.md) | 組ごとの台数の上限、`ops.av1_encode_enabled`（止めるだけ） |
| AV1 のしきい値 | 7 日で 1,000 回の確定の視聴 ほか。1 時間を超える動画は総再生時間の条件も | [ADR-0003](../decisions/0003-codecs-and-per-title-ladder.md)、[ADR-0016](../decisions/0016-av1-promotion-rule-and-cost.md) | — |
| ライブのアーカイブの作り直し | 7 日で確定の視聴 100 回など。作り直さないものは 30 日の後に間引く（仮） | [ADR-0031](../decisions/0031-dvr-storage-and-live-to-vod.md) | — |
| CloudFront の上限 | `vod` 0.6 Tbps・50 万件/秒、`live` 1.2 Tbps・250 万件/秒（申請の値） | [ADR-0064](../decisions/0064-accounts-network-and-edge-distributions.md) | 使用の割合の警報（60% でチケット、80% で呼び出し）。大きな配信の通常のモードへの切り替え |
| 措置の拒否の鍵 | 7 日（置き場の 80% で 24 時間） | [ADR-0027](../decisions/0027-takedown-deny-list-within-60s.md) | 寿命の短縮 |
| VOD のセグメント | 4 秒、GOP 2 秒 | [ADR-0004](../decisions/0004-cmaf-packaging-and-drm-scope.md) | — |
| 署名の期限 | 6 時間（ライブは配信の間） | [ADR-0005](../decisions/0005-cdn-and-origin-strategy.md) | — |
| ライブの部分セグメント | 0.5 秒、セグメント 2 秒、DVR 12 時間 | [ADR-0006](../decisions/0006-live-ingest-and-latency.md) | 配信ごとの通常のモードへの切り替え |
| 視聴の数の上限 | 同じ視聴者と動画の組で 24 時間に 4 回、エンゲージ ビュー 30 秒 | [ADR-0007](../decisions/0007-two-phase-view-counting.md) | — |
| 照合 | 最短の一致 10 秒、ライブの窓 30 秒 | [ADR-0008](../decisions/0008-fingerprinting-and-match-engine.md) | — |
| チャット | 1 利用者 1 秒 1 件（3 件まで貯まる）、自動の低速モード 5 秒、配信あたり 1 秒 5,000 件 | [ADR-0033](../decisions/0033-chat-rate-limits-slow-mode-and-moderation.md) | 配信ごとの低速モードの強制 |
| 受け付けの停止 | — | — | `ops.upload_enabled`（リージョンごと）、`ops.live_ingest_enabled`（止めるだけ） |
| おすすめ | — | — | `ops.recs.fallback`（代わりの並びに切り替える）、`ops.recs.mixer.*` |
| 公開の判定 | — | — | `ops.publish_gate_enabled`（止めるだけ。止めると全動画が「照合待ち」のまま。公開に倒すスイッチは持たない） |
| 消去の作業 | — | — | `ops.retention_delete_enabled`（止めるだけ） |
| CDN の振り分け（S2） | 計測から 5 分ごと | [ADR-0005](../decisions/0005-cdn-and-origin-strategy.md) | CDN ごとの重みの手動の上書き（障害の間） |

## 3. リリースとロールバック

- **デプロイとリリースを分ける。** デプロイは Ops が承認し、リリース（フラグを広げる）は PM が判断する。未完成の振る舞いは `release.*` のフラグの裏に置く。`release.*` は 100% の後 30 日で消す。
- **形式とラダーと規則をフラグにしない。** `ladder_version`、セグメントの形式、`fp_version`、`view-rules` のバージョン、`playable()` の決定表はコードのバージョンとして出し、本番の指標（VMAF、QoE、確定と仮の差、異議の率、漏れの監査）で見る。
- **バージョンの更新の順序**：読む側（マニフェストの生成、プレイヤー、照合の索引の読み込み）を先に出し、全体に行き渡ってから書く側（新しい `ladder_version` の符号化、新しい `fp_version` の索引）を出す。新しい `ladder_version` は、新しいアップロードから使い、既存の動画の作り直しは後ろの組で少しずつ行う。
- **メディアの面のデプロイ**：作業者のプールは、新しいイメージの作業者を足し、古い作業者に新しい作業を渡さず、手持ちの作業が終わってから止める。`match-engine` は AZ ごとに写しを入れ替え、索引の読み込みと照合の一致を確かめてから次へ進む。`live-transcoder` は配信中の作業者を止めない（新しい配信だけを新しい作業者へ）。
- **プレイヤーとアプリ**：Web のプレイヤーは 1% → 10% → 50% → 100%、各段 24 時間以上。止める条件：開始の時間・開始の失敗・再バッファが前の 1.2 倍。アプリは OS のストアの段階の配布に合わせる。
- **自動のロールバックの条件**：再生の API の 5xx、開始の失敗、再バッファ、再生できるまでの p95、照合の待ち、措置の停止の時間、漏れの監査の不一致。
- **ロールバック**：まずフラグで戻す。次に 1 つ前のイメージ（マイグレーションは広げる段だけ）。新しい `ladder_version` で作ったレンディションは、前のマニフェストの生成でも読めるようにしておく。
- 本番へのデプロイは Ops が承認する（作成者と別の人）。

### 3.1 デプロイの時間帯と凍結

| 対象 | 時間帯 | 凍結（修正だけ） |
| --- | --- | --- |
| 管理の面、Web の資産 | 平日 10〜17 時 | 金曜 15 時以降、日本の祝日の前日、年末年始、エラーバジェットを使い切っている間 |
| メディアの面（作業者、パッケージ、オリジン） | 平日 10〜16 時 | 同上。大きなライブの催し（年末の歌の番組の模型、スポーツの大会、大きなゲームの発表）の当日 |
| ライブ（取り込み、変換、チャット） | 平日 10〜15 時。1 日 1 AZ | 同上。予定された大きな配信の前後 24 時間 |
| CDN の設定（キャッシュの規則、エッジの関数） | 平日 10〜15 時。Ops の承認 | 同上 |
| Terraform（ネットワーク、MSK、S3 の方針） | 平日 10〜16 時。Ops の承認 | 同上 |

- 上の時間帯と凍結は本システムの既定である。大きな催しの凍結は、視聴の急増に備える本システムの想定で、本家の運用の値ではない。

## 4. アラートと手順

手順は [templates/runbook.md](../../../../docs/templates/runbook.md) の形で書く。「状態」が「作成済み」の手順はこのディレクトリにある。「計画」の手順は、「作る Story」の完了の条件に含め、E15 の `runbooks-e15` でまとめて確かめる。計画の手順ができるまでは [incident-response.md](incident-response.md) の一般の手順で対応する。

| アラート（重さ） | 手順 | 状態 | 作る Story |
| --- | --- | --- | --- |
| 個別の手順のないアラート、SEV の判断と連絡 | [incident-response.md](incident-response.md) | 作成済み | `slo-dashboards-alerts` |
| デプロイ中の自動ロールバック | [deploy-and-rollback.md](deploy-and-rollback.md) | 作成済み | `ci-pipeline-baseline`、`deploy-and-rollback` |
| CRR の遅れ（15 分を超える）、Aurora Global Database の遅延、リージョンの障害（page） | [disaster-recovery.md](disaster-recovery.md) | 作成済み | `osaka-warm-standby`、`dr-failover-drill` |
| 配信の可用性のバーンレート、CDN のエッジの 5xx の急増（page） | [cdn-incident.md](cdn-incident.md) | 作成済み | `cloudfront-and-shield`、`slo-dashboards-alerts` |
| 急な人気（1 つの動画の同時の視聴の急な上がり、仮の数の急増） | [viral-spike.md](viral-spike.md) | 作成済み | `viral-prewarm`、`viral-spike-tests` |
| 措置の停止の遅れ（page、SEV2 から） | [takedown-propagation.md](takedown-propagation.md) | 作成済み | `delivery-block-list` |
| ライブの取り込みの失敗の急増、GPU のプールの不足、ライブの遅延（page） | [live-incident.md](live-incident.md) | 作成済み | `live-ingest`、`live-transcoder` |
| キャッシュの外れの急増、オリジンの負荷（page） | `origin-overload.md` | 計画 | `origin-cache` |
| 再生の開始・再バッファの悪化（ISP・CDN・端末ごと。page） | `playback-qoe-degraded.md` | 計画 | `qoe-telemetry` |
| 再生の API の 5xx（page） | `playback-api-degraded.md` | 計画 | `playback-api-and-token` |
| 再生できるまでの遅れ、符号化のプールの待ち行列の溜まり、Spot の大量の中断（page） | `pipeline-backlog.md` | 計画 | `pipeline-state-machine`、`segment-parallel-encode` |
| 照合の待ち、`match-engine` の停止・索引の読み込みの失敗（page） | `matching-backlog.md`（公開に倒さない） | 計画 | `match-engine`、`publish-gate` |
| 漏れの監査の不一致（page、SEV1 の候補） | `visibility-leak-response.md` | 計画 | `playback-api-and-token`、`search-ranking-and-filter` |
| ストレージの突き合わせの不一致（page、SEV1 の候補） | `media-integrity-incident.md` | 計画 | `original-retention` |
| チャットの遅れ、Gateway の接続の急減（page） | `live-chat-degraded.md` | 計画 | `chat-gateway` |
| 仮の数の遅れ、MSK の消費の遅れ | `view-counting-lag.md` | 計画 | `provisional-view-counts` |
| 確定と仮の差の急な変化、確定の遅れ | `view-verification-anomaly.md`（収益の締めの保留を含む） | 計画 | `verified-view-counts` |
| 異議の取り消しの率の急増、権利者ごとの一致の急増 | `claims-anomaly.md` | 計画 | `claims-and-disputes`、`rights-abuse-monitoring` |
| 削除の申出の期限の接近 | `takedown-request-sla.md`（法務の L1 の後に確定） | 計画 | `takedown-requests` |
| CloudFront の上限の使用の割合（60% でチケット、80% で呼び出し） | `cdn-quota.md` | 計画 | `edge-and-domains`、`live-distribution-quota` |
| GPU のキャパシティの予約の不足、AZ の停止のときの戻しの順 | `gpu-capacity.md` | 計画 | `ecs-fargate-and-ec2-pools` |
| 大きな催しの 2 週間前の確認 | `event-capacity-plan.md` | 計画 | `event-capacity-plan` |
| 作り直しの始め方、Deep Archive の戻しの量 | `reencode-campaign.md` | 計画 | `reencode-campaigns` |
| ストリームキーの漏えい | `stream-key-compromise.md` | 計画 | `stream-key-protection` |
| チャンネルの乗っ取り | `channel-takeover.md` | 計画 | `account-recovery-and-takeover` |
| エッジのトークンの悪用 | `token-abuse.md` | 計画 | `token-abuse-detection` |
| 開示の請求・捜査機関からの照会・ライブでの緊急の事態 | `legal-request.md`（法務の L10 の後に確定） | 計画 | `legal-request-workflow` |
| 費用の急増（配信 1 GB・変換 1 時間の原価が予算の 1.5 倍） | `cost-anomaly.md` | 計画 | `cost-metering` |

- すべてのアラートは、対応する手順の URL を注釈に持つ（CI で検査する）。

## 5. 自己監視

- 本番のサービスの自己の計測（OpenTelemetry）は、大阪の `selfmon` のアカウントの AMP と CloudWatch に送る（[ADR-0068](../decisions/0068-qoe-privacy-limits-cdn-logs-and-selfmon.md)）。東京のリージョンの障害の間も警報が動く。アラートは CloudWatch のアラームから、オンコールのサービスへ直接送る。
- 外からの見張り（別のアカウントの `canary`）が、見張りの動画の再生（AZ と ISP の代表）、見張りのアップロード（アップロードから公開まで）、見張りのライブ（時刻の焼き込み）、見張りの措置（毎日）、見張りのチャットを続ける。決まった時間を超えたら、CloudWatch のアラームで呼び出す（デッドマンスイッチ）。
- CDN の事業者の状態のページと、CDN のログの届きの遅れも見る（CDN のログが遅れると、配信の SLI が見えなくなる）。プレイヤーの出来事の QoE は、CDN のログと独立の経路として使う。

## 6. 定期作業

| 作業 | 頻度 | 持ち主 |
| --- | --- | --- |
| S3 Inventory とカタログの突き合わせの結果の確認 | 毎週 | Ops |
| 見張りの措置の結果の確認 | 毎日（自動）、毎週の確認 | QA、Ops |
| 確定の数の抜き取りの監査 | 毎週 | QA |
| 照合の異議・取り消しの率、権利者ごとの一致の確認 | 毎日（自動）、毎週の確認 | QA、PM |
| 費用の見直し（配信 1 GB、保存 1 時間、変換 1 時間、AV1 のしきい値の損益、Spot の中断の率） | 毎月 | Ops、PM |
| CDN の約定の量と使用の確認 | 毎月 | Ops |
| DR の訓練（大阪への切り替え） | 半年ごと | Ops |
| 熱い集まりの大阪の写しの割合（98% 以上） | 毎日（自動）、毎週の確認 | Ops |
| CloudFront の上限の申請と承認の記録（`cdn_quota_log`） | 申請のたび、毎月の確認 | Ops |
| 大きな催しの前の準備（GPU のプールの確保、凍結、低速モードの方針） | 催しの 2 週間前 | Ops、PM |

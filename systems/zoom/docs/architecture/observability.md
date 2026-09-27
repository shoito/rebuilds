# Observability: Zoom

メディアの品質の数値の集め方（クライアントの `getStats`、SFU の数値、ENA の指標）、音声の MOS の推定とフリーズの率、SLI と SLO、アラートと runbook の対応、合成の監視の会議、会議ごとの調べ方。ログ・トレース・メトリクスの道具は他の題材を引き継ぐ：OpenTelemetry（ADOT）→ AMP・X-Ray・CloudWatch Logs、Grafana で横断（[ADR-0001](../decisions/0001-platform-and-stack.md)）。

前提となる決定は、品質の診断に使うのは RTCP と `getStats` の数値だけにすること（本題材の [AGENTS.md](../../AGENTS.md)）、品質の指標の定義（[codecs-and-bandwidth-adaptation.md](codecs-and-bandwidth-adaptation.md) の 11.2 節）、ENA の `*_allowance_exceeded` を監視から外さないこと（[ADR-0001](../decisions/0001-platform-and-stack.md)）。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0051](../decisions/0051-qos-telemetry-pipeline.md) | クライアントは 1 秒ごとに `getStats` を読み、10 秒ごとの要約を `qos.report`（`seq` なし）でシグナリングの WebSocket に送る。Gateway が Firehose → S3（Athena）へ流し、SLI の分子と分母だけを低い種類のラベルで AMP へ送る。参加ごとの要約は Aurora の `participant_quality_summaries`。AMP のラベルに会議・参加者・組織・IP を入れない |
| [0052](../decisions/0052-media-slis-and-mos-estimation.md) | 音声は E-model（G.107）の式で MOS を推定し（`mos_est`）、係数を試験の ViSQOL に合わせる。映像はフリーズと解像度・fps で見て、MOS を推定しない。SLO は、参加の成功、参加の速さ、良い音声の分、フリーズのない分、意図しない脱落、付け替えの時間、API、制御の回復 |

## 1. 全体の流れ

```
 ブラウザ ── getStats（1 秒ごと）→ 10 秒の要約 ── qos.report（WSS）──▶ Signaling Gateway
                                   └ 退出の時の残り ── sendBeacon ──▶ API（/v1/qos）
 Signaling Gateway ──▶ Firehose ──▶ S3（prod の観測のバケット、Parquet）──▶ Athena（会議ごとの調べ）
         │ 接続ごとの要約（退出の時）──▶ SQS ──▶ Worker ──▶ Aurora participant_quality_summaries
         └ SLI の分子・分母（低い種類のラベル）──▶ AMP

 Media Node（media-prod）
   Node Agent ── mediasoup の getStats（10 秒ごと、transport・consumer）──▶ Firehose（同じ S3）
             ── Node の数（worker の CPU、consumer、bps・pps、転送の遅れ）──▶ ADOT ──▶ AMP
   CloudWatch エージェント ── ENA の *_allowance_exceeded（ethtool）──▶ CloudWatch ──▶ AMP へも
 TURN ── coturn の数（割り当て、帯域、拒否した CreatePermission）──▶ AMP

 制御の側（API、Gateway、Actor Host、Assignment、Worker）── OTLP ──▶ X-Ray・AMP・CloudWatch Logs
 CloudFront・WAF・ALB のログ（IP を含む。30 日）──▶ log-archive

 Grafana（shared）：AMP・CloudWatch・X-Ray・Athena を読む
 アラート：AMP のルール → Alertmanager → SNS → オンコール。AWS の資源は CloudWatch アラーム → SNS
```

## 2. 計装

### 2.1 共通

- 計装は開発リポジトリの `packages/telemetry` に集め、ログのイベントの型とスパンの属性の名前を定数で定義する（他の題材と同じ）。
- 共通の属性：`service.name`、`service.version`、`deployment.environment`、`cloud.region`、`cloud.availability_zone`。Media Node は加えて `media.node_generation`（AMI の世代。[ADR-0055](../decisions/0055-media-node-rolling-replacement.md) のカナリアの比較に使う）、`media.site`。
- トレース：参加（`POST /join` → WSS → Actor → Node Agent の `transport.create`）を 1 つのトレースにする。メディアのパケットはトレースしない。サンプリングは参加の 10%、失敗した参加は全部。

### 2.2 クライアントの品質の報告（`qos.report`）

[ADR-0051](../decisions/0051-qos-telemetry-pipeline.md)。10 秒ごと。数値だけ。

| 群 | 項目（`getStats` の出所） |
| --- | --- |
| 共通 | `participant_id`、`instance_id`、窓の開始、`client_kind`、ブラウザの系統と版、`ice_path`（`udp_direct`・`tcp_direct`・`turn_udp`・`turn_tcp`・`turn_tls`）、`ip_family`、`media_generation` |
| 経路 | `candidate-pair` の `currentRoundTripTime`、`availableOutgoingBitrate`、`availableIncomingBitrate`（あれば） |
| 受けた音声（流れごと、最大 3） | `inbound-rtp`：`packetsLost`・`packetsReceived` の増分、`jitter`、`concealedSamples`・`silentConcealedSamples`・`totalSamplesReceived`・`concealmentEvents` の増分、`jitterBufferDelay`・`jitterBufferEmittedCount` の増分。算出した `mos_est`（4 節） |
| 受けた映像（流れごと、最大 25。上位 5 本を詳しく、残りは合計） | `inbound-rtp`：`framesDecoded`・`framesDropped` の増分、`frameHeight`、`framesPerSecond`、`freezeCount`・`totalFreezesDuration` の増分、`pliCount`・`nackCount` の増分 |
| 送った流れ | `outbound-rtp`：`targetBitrate`、`qualityLimitationReason`・`qualityLimitationDurations` の増分、送っている本（rid）、`remote-inbound-rtp` の `roundTripTime`・`fractionLost` |
| 端末 | CPU の圧迫の印（`qualityLimitationReason: "cpu"` の時間、端末の処理の自動の低下の段階。[clients.md](clients.md) の 5.3 節） |

- 送らない：ICE の候補の文字列、IP、表示の名前、会議の題名、チャット、字幕、端末の識別子（[clients.md](clients.md) の 11 節）。
- この一覧が、外部送信の公表（intent.md の L5）の文面の元になる。項目を足す PR は、この表と公表の文面を更新する。
- 1 件は約 1〜3 KB（25 本の映像を受けるとき）。S1 のピークで 1 秒に約 3,000 件。

### 2.3 Media Node と TURN

| 出所 | 数 | 置き場所 |
| --- | --- | --- |
| Node Agent（Node の単位） | worker ごとの CPU、consumer の数（動いている・止めた）、送受の bps・pps、`producer.score` の分布、キーフレームの要求の数、`worker.died`、点（[ADR-0012](../decisions/0012-media-assignment-and-cascading.md)） | AMP（ラベル：Node、AZ、世代） |
| Node Agent（transport・consumer の単位） | mediasoup の `getStats` の要約：受けた損失、RTT、送ったビットレート、層、NACK・PLI | Firehose（S3） |
| 転送の遅れ | 合成の監視の会議（7 節）と負荷試験で測る。本番の全パケットでは測らない | AMP |
| CloudWatch エージェント | ENA の `bw_in_allowance_exceeded`・`bw_out_allowance_exceeded`・`pps_allowance_exceeded`・`conntrack_allowance_exceeded`・`linklocal_allowance_exceeded`・`conntrack_allowance_available`（[ENA の性能の指標](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/monitoring-network-performance-ena.html)、2026-09-27 に確認） | CloudWatch → AMP |
| 防御のモード | ICE を通らない送信元からの受信の数、捨てた数（[ADR-0045](../decisions/0045-ddos-defense-for-media-edge.md)） | AMP |
| coturn | 割り当ての数、中継の帯域、拒否した `CreatePermission`、TLS の接続の数 | AMP（ラベル：台、AZ） |

### 2.4 内容を出さない

- 会議の内容（音声・映像のフレーム、チャットの本文、字幕の文字）、パスコード、参加の鍵、参加のトークン、再接続用の秘密を、ログ・エラーの本文・トレースの属性・メトリクスのラベルに書かない（本題材の AGENTS.md）。
- ログに書くのは、ID（`meeting_id`・`instance_id`・`participant_id`・`producer_id`）、`epoch`・`seq`、操作の名前、理由のコード、数値だけ。
- ADOT Collector で、属性の許可リストの外を落とす。CloudWatch Logs に、パスコード・参加の鍵・トークンの形の文字列を探す走査を置き、検出は呼び出しのアラート（6 節）。
- IP は、CloudFront・WAF・ALB・Media Node・TURN のログにだけ残り、30 日で消す（[ADR-0046](../decisions/0046-audit-logs-and-data-lifecycle.md)）。アプリのログに IP を書かない（濫用の判定は `ip_prefix_hash`）。

## 3. 置き場所と保持

| 置き場所 | 中身 | ラベル・鍵 | 保持 |
| --- | --- | --- | --- |
| AMP | SLI の分子・分母、Node・TURN・制御の側の数 | リージョン、AZ、Node、世代、ブラウザの系統、`ice_path`、`client_kind`。**会議・参加者・組織・IP は入れない** | 150 日（AMP の既定。**未検証**） |
| S3（Firehose、Parquet）＋ Athena | `qos.report` と Media Node の transport・consumer の要約 | `dt`・`hour` の区切り。`instance_id`・`participant_id` の列 | 30 日（参加者の単位の生の記録） |
| S3（日次の集計） | 組織・ブラウザ・経路ごとの日次の品質の集計（参加者の ID なし） | — | 13 か月 |
| Aurora `participant_quality_summaries` | 参加ごとの要約（下の表） | `(instance_id, participant_id)` | 12 か月（[accounts-and-admin.md](accounts-and-admin.md) の 6.3 節と同じ） |
| CloudWatch Logs | アプリのログ（内容と IP を含めない） | — | 30 日、log-archive に 13 か月 |

`participant_quality_summaries`（組織の管理者の会議の詳細の画面で「品質の要約」として見せる）：

| 列 | 中身 |
| --- | --- |
| `instance_id`、`participant_id`、`org_id` | 鍵と組織 |
| `audio_minutes`、`audio_good_minutes` | 音声を受けた分と、良い音声の分（5 節） |
| `mos_est_p50`・`mos_est_p10` | 受けた音声の `mos_est` の分布 |
| `video_minutes`、`freeze_free_minutes`、`freeze_count`、`freeze_seconds` | 映像を受けた分、フリーズのない分、回数と長さ |
| `rtt_p50_ms`・`rtt_p95_ms`、`loss_pct_p95` | 経路の要約 |
| `ice_path`、`ip_family`、`browser`、`client_kind` | 条件 |
| `reattach_count`、`reconnect_count`、`leave_reason` | 付け替え、再接続、退出の理由 |
| `quality_limitation`（`none`・`cpu`・`bandwidth` の主なもの） | 送り手の側の制限 |

- 組織の管理者に見せるのは、この要約だけ。生の記録（Athena）は、本システムの運用者がインシデントとサポートの調べ（組織の許可を前提）にだけ使う。

## 4. 音声の MOS の推定とフリーズの率

### 4.1 `mos_est`

[ADR-0052](../decisions/0052-media-slis-and-mos-estimation.md)。ITU-T G.107（06/2015）の E-model の形を使う（[G.107](https://www.itu.int/rec/T-REC-G.107)、2026-09-27 に確認）。受けた音声の流れごと、10 秒の窓ごと。

```
Ppl  = 100 × Δ(concealedSamples − silentConcealedSamples) / ΔtotalSamplesReceived   // 直した後に残った損失（%）
Ta   = RTT/2 + ΔjitterBufferDelay / ΔjitterBufferEmittedCount + T_fixed           // 片道の遅れ（ms）。T_fixed は既定 60ms
Idd  = 0                                                  (Ta ≤ 100)
       25 × {(1 + X⁶)^(1/6) − 3 × (1 + (X/3)⁶)^(1/6) + 2},  X = log2(Ta / 100)   (Ta > 100)
Ie,eff = Ie + (95 − Ie) × Ppl / (Ppl / BurstR + Bpl)      // BurstR = 1
R    = R0 − Idd − Ie,eff                                   // R0 = 93.2（既定の値の組）
MOS  = 1 + 0.035 R + R (R − 60)(100 − R) × 7 × 10⁻⁶         (0 < R < 100)
```

- 上の式は、E-model の既知の形の転記である。G.107 の本文との照合は E1 で行う（**未検証**）。
- `Ie`・`Bpl`（Opus ＋ FEC ＋ RED の組の符号器の劣化）は、ITU-T の付録の値を確かめていない（**未検証**）。`media-lab` の回線の劣化の試験（損失 0〜30%、揺らぎ 0〜100ms、RTT 20〜300ms の格子）で、同じ条件の ViSQOL v3 の値との二乗誤差が最小になるように決める。初期値は `Ie = 0`、`Bpl = 20`（仮）。
- 係数はブラウザの系統ごとに持てる形にする（NetEQ の振る舞いの違い）。係数を変える PR は QA の承認を要する。
- 狭帯域の尺度（上限 約 4.4）で出す。G.107.1（06/2019、[G.107.1](https://www.itu.int/rec/T-REC-G.107.1)、2026-09-27 に確認）の広帯域の尺度には、係数を確かめてから移る。
- **推定は ViSQOL と同じではない。** 本番の値は、傾向の把握、比較（Node の世代、ブラウザ、経路）、SLI に使う。NFR-003 の判定は、試験の環境の ViSQOL で行う。
- ITU-T P.1203 は、信頼できる伝送の上のストリーミングのモデルで（[P.1203](https://www.itu.int/rec/T-REC-P.1203)、2026-09-27 に確認）、会議の実時間のメディアには使わない。

### 4.2 フリーズ

- webrtc-stats の定義（直近 30 フレームの平均の間隔 `d` に対し、`max(3d, d + 150ms)` 以上の間隔。[webrtc-stats](https://www.w3.org/TR/webrtc-stats/)、2026-09-27 に確認）の `freezeCount`・`totalFreezesDuration` を使う。
- **フリーズのない分**：1 分の中で、受けた映像のどれにも「1 秒以上のフリーズ」がなかった分。1 秒以上かどうかは、10 秒の窓の中の `totalFreezesDuration` の増分 ÷ `freezeCount` の増分が 1 秒以上か、増分が 1 秒以上で回数が 1 のときで判定する（近似）。
- 受け手が自分で止めた映像（見えないタイル、帯域で止めた consumer でアバターを出したもの）は、フリーズに数えない。Media Node が止めた consumer は `inbound-rtp` が止まるだけで、フリーズの定義（描画の間隔）には当たらない見込み（**未検証**。E4 で確かめる）。

## 5. SLI と SLO

[ADR-0052](../decisions/0052-media-slis-and-mos-estimation.md)。SLO の値と表の正本は、Ops の [runbooks/README.md](../runbooks/README.md) の 1 節にある。ここは計測の仕組みを書く。値を変えるときは runbooks を先に変え、ここを合わせる。**値は既定案。**

| SLI | 分子 ／ 分母 | 出所 | SLO（28 日） |
| --- | --- | --- | --- |
| 参加の成功 | 10 秒以内に音声の送受信が始まった参加の試行 ／ 参加の試行（待合室の時間を除く） | クライアントの `join.result`（`qos.report` の最初の件と、失敗の報告）と API の `POST /join` | 99.5%（K2） |
| 参加の速さ | 参加のボタンから最初の音声の送受信まで | 同上 | p95 3 秒（NFR-002）。TURN の経路は 5 秒 |
| 良い音声の分 | `mos_est ≥ 3.6` かつ 隠しの率 < 5% の参加者・分 ／ 音声を受けた参加者・分 | `qos.report` | 97% |
| フリーズのない分 | 1 秒以上のフリーズがない参加者・分 ／ 映像を受けた参加者・分 | `qos.report` | 95% |
| 意図しない脱落 | `leave_reason = dropped` の数 ／ 参加者・時間 | Actor の参加の記録 | 0.5% 以下（K4） |
| 付け替えの時間 | `media.reattach` から 5 秒以内に音声の最初のパケットを受けた参加者 ／ 付け替えを受けた参加者 | クライアントの報告と Actor | 95%（NFR-004） |
| 制御の回復 | 持ち主を失ってから 10 秒以内に最初の `ack` を返した会議 ／ 持ち主を失った会議 | Actor Host | 99%（NFR-004） |
| API | 5xx でない応答 ／ 参加・予定の API の要求 | ALB・CloudFront | 99.95%（NFR-005） |
| 転送の健全さ（サーバーの側） | ENA の超過が 0 で、合成の会議の転送の遅れ p99 が 10ms 以内だった Node・分 ／ Node・分 | Node Agent、ENA | 99.9% |

- **良い音声の分とフリーズのない分は、利用者の回線の悪さでも減る。** SLO の違反をそのままサーバーの障害とみなさない。同じ窓の、Media Node の側の数（送り手の上りの損失、受け手の下りの損失、ENA の超過）、`ice_path`、ブラウザで分けて見る。
- 分ける切り口：リージョン、AZ、Node の世代、ブラウザ、`ice_path`、`client_kind`。組織ごとには AMP で分けない（Athena の日次の集計で見る）。

### 5.1 バーンレート

他の題材と同じマルチウィンドウのバーンレートを使う。

| 重さ | 長い窓 | 短い窓 | バーンレート |
| --- | --- | --- | --- |
| 呼び出し | 1 時間 | 5 分 | 14.4 |
| 呼び出し | 6 時間 | 30 分 | 6 |
| チケット | 3 日 | 6 時間 | 1 |

- 良い音声の分・フリーズのない分のバーンレートで呼び出すのは、**サーバーの側の数（Node の点、ENA の超過、Node の世代・AZ の偏り）が同時に悪化しているときだけ**にする。そうでなければチケットにする（利用者の回線の悪い日に夜中に起こさない）。
- すべてのアラートは、対応する runbook の URL を注釈に持つ（CI で検査する。他の題材と同じ）。

## 6. アラートと runbook の対応

アラートと手順の一覧の正本は [runbooks/README.md](../runbooks/README.md) の 4 節にある（どの Epic で個別の手順を作るかもそこにある）。ここは条件の実装の側の記述である。手順の列の個別の runbook（`*.md` の名前だけのもの）ができるまでは、[incident-response.md](../runbooks/incident-response.md) の該当の節で対応する。

| アラート | 条件 | 重さ | 手順 |
| --- | --- | --- | --- |
| 参加の成功の速いバーンレート | 5.1 節 | 呼び出し | [incident-response.md](../runbooks/incident-response.md) |
| 参加の失敗の急増 | 5 分間で参加の失敗が 2% を超える | 呼び出し | [incident-response.md](../runbooks/incident-response.md) |
| 合成の監視の会議の連続失敗 | 同じ AZ で 2 回続けて失敗（7 節） | 呼び出し | [incident-response.md](../runbooks/incident-response.md) |
| **Media Node の障害の波** | `dead` の Node が 10 分に 2 台以上、または `media.reattach` を受けた参加者が 5 分に 2,000 人を超える | 呼び出し | [incident-response.md](../runbooks/incident-response.md) の「Media Node の障害の波」 |
| 付け替えの時間の SLO | 1 時間の窓で 5 秒以内の割合が 90% を下回る | 呼び出し | `media-node-failure.md`（sfu の領域の提案） |
| 良い音声の分の悪化（サーバーの側の悪化と同時） | 5.1 節 ＋ Node の世代・AZ に偏る | 呼び出し | `audio-quality-degradation.md`（codecs の領域の提案） |
| 良い音声の分の悪化（偏りなし） | 5.1 節 | チケット | 同上 |
| フリーズの率の急増 | フリーズのない分が 1 時間で平常より 3 ポイント下がる | チケット（Node の世代に偏れば呼び出し） | `video-freeze-spike.md`（codecs の領域の提案） |
| ENA の上限の超過 | Media Node・TURN の `pps_allowance_exceeded`・`bw_*_allowance_exceeded` が 1 分に 1 以上 | 呼び出し（1 台ならチケット） | `media-node-allowance-exceeded.md`（sfu の領域の提案） |
| 接続の追跡の上限の超過 | `conntrack_allowance_exceeded` が 1 以上 | 呼び出し | `conntrack-allowance-exceeded.md`（network の領域の提案） |
| **メディアの IP への DDoS の兆候** | Node の受信の pps が平常の 5 倍、または ICE を通らない送信元からの受信が全受信の 30% を超える | 呼び出し（SEV2 から） | [incident-response.md](../runbooks/incident-response.md) の「メディアの IP への DDoS」 |
| **TURN の過負荷** | TURN の台の CPU 70%、中継の帯域が 1 台 2 Gbps、割り当ての数が平常の 3 倍、のどれかが 5 分続く | 呼び出し | [incident-response.md](../runbooks/incident-response.md) の「TURN の過負荷」 |
| TURN の拒否の急増 | 拒否した `CreatePermission` が 1 分に 100 を超える | チケット（10 倍なら呼び出し） | [incident-response.md](../runbooks/incident-response.md) の「TURN の過負荷」の悪用の節 |
| **シグナリングの再接続の嵐** | Gateway の新しい接続が 1 分に平常の 5 倍、または `resume` の失敗が 5% を超える | 呼び出し | [incident-response.md](../runbooks/incident-response.md) の「シグナリングの再接続の嵐」 |
| 制御の回復の遅れ | 持ち主を失った会議の 5% 以上が 10 秒で戻らない | 呼び出し | `actor-host-failover.md`（signaling の領域の提案） |
| Valkey の切り替え | ElastiCache のフェイルオーバーのイベント、または `epoch` が全会議で上がる | 呼び出し | `valkey-failover-meetings.md`（signaling の領域の提案） |
| worker の異常終了 | `worker.died` が 1 時間に 3 以上（全体） | 呼び出し | `mediasoup-worker-died.md`（sfu の領域の提案） |
| キーフレームの嵐 | 1 つの producer へのキーフレームの要求の送出が 1 分に 60 を超える会議が 10 を超える | チケット | `keyframe-storm.md`（sfu の領域の提案） |
| 空きの不足 | `fleet_headroom{az}` が目標の 50% を 10 分下回る、または Media Node の起動の失敗 | 呼び出し | `media-capacity-shortage.md`（capacity の提案）、`ec2-capacity-shortage.md`（infrastructure の提案） |
| EIP のプールの枯渇 | プールの空きが 10 未満 | チケット（0 なら呼び出し） | `eip-pool-exhausted.md`（infrastructure の提案） |
| E2EE の鍵の更新の遅れ | `e2ee.rekey_slow` の率が 1% を超える | チケット | `e2ee-rekey-slow.md`（e2ee の領域の提案） |
| 録画の失敗 | `failed` の率が 1 時間で 1% を超える | 呼び出し | `recorder-failures.md`（recording の領域の提案） |
| 字幕の遅れ・停止 | 字幕の遅れの p95 が 5 秒を 10 分超える | チケット（全体の停止なら呼び出し） | `transcribe-outage.md`（recording の領域の提案） |
| 内容・秘密の出力の検出 | 2.4 節の走査で 1 件以上 | 呼び出し（SEV2） | [incident-response.md](../runbooks/incident-response.md) の「内容・秘密の出力」 |
| 監査ログのハッシュの連鎖の検証の失敗 | 日次のジョブ | 呼び出し（SEV2） | [incident-response.md](../runbooks/incident-response.md) |
| DR の複製の遅延 | `AuroraGlobalDBRPOLag` が 60 秒を 5 分超える | 呼び出し | [disaster-recovery.md](../runbooks/disaster-recovery.md) |
| 大阪の待機の構成の異常 | 大阪の合成の監視の会議の失敗 | チケット（30 分で呼び出し） | [disaster-recovery.md](../runbooks/disaster-recovery.md) |
| デプロイ中の自動の戻し、カナリアの不合格、Web の版の悪化 | [delivery.md](delivery.md) の 4・5 節 | 呼び出し | [deploy-and-rollback.md](../runbooks/deploy-and-rollback.md) |
| K8 の超過 | 月の K8 が目標を超える | チケット（月次） | [capacity.md](capacity.md) の 6 節 |

呼び出しのアラートは、SLO か、サーバーの側の原因を示す症状か、セキュリティ（DDoS、内容の出力、監査）に限る。

## 7. 合成の監視の会議

- 本番の監視用の組織に、合成の監視の会議を置く。5 分ごとに、各 AZ の Media Node のうち 1 台を順に選び（Assignment Service の監視用の `pin_node`）、ヘッドレスの Chrome 2 つで参加する。
- 測るもの：参加の時間、`mos_est`、フリーズ、glass-to-glass（時刻を埋めた合成の映像）、Media Node の転送の遅れ（合成の会議に負荷試験のボットの組を 1 つ入れ、[capacity.md](capacity.md) の 7.3 節の方法で測る）。
- 経路の種類ごとに回す：直接の UDP、TURN の UDP、TURN の TLS 443（`iceTransportPolicy: "relay"`）。
- 実行の場所：大阪のリージョンから東京へ、東京から大阪の待機の構成へ。リージョンの間の転送（0.09 USD/GB）は、1 回数 MB で小さい。
- 合成の会議は SLI の分母から外し、別の SLI（合成の成功率）で見る。

## 8. ダッシュボードと会議の調べ方

| ダッシュボード | 中身 |
| --- | --- |
| メディアの SLO | 5 節の SLI、バーンレート、切り口（AZ、世代、ブラウザ、経路） |
| Media Node の群れ | 台ごとの点、worker の CPU、consumer、bps・pps、ENA の超過、状態（`active`・`draining`・`under_attack`・`dead`）、`fleet_headroom` |
| TURN | 台ごとの割り当て、帯域、拒否、TLS の接続 |
| 制御の側 | 参加の区間ごとの遅れ（[signaling-and-meetings.md](signaling-and-meetings.md) の 11 節）、Actor の数と回復、Gateway の接続と再接続、Valkey |
| 費用 | 送ったバイト、参加者・分、K8（[capacity.md](capacity.md) の 6 節） |

- **会議の調べ（サポート）**：`instance_id` を入れると、Athena から参加者ごとの 10 秒ごとの時系列（`mos_est`、損失、RTT、フリーズ、受けた層、`ice_path`）と、Media Node の transport の要約、`meeting_audit_events`（主催者の操作）、付け替えの記録を並べて出す。会議の内容は出さない。調べは、組織の許可か、インシデントの対応のときだけ（[security.md](security.md) の 7 節）。

## 9. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E1 | `telemetry-package-and-allowlist` | 2.1・2.4 節。属性の許可リスト、内容・秘密の走査 |
| E1 | `qos-report-pipeline` | 2.2 節と 1 節の流れ。Gateway → Firehose → S3・Athena、SQS → `participant_quality_summaries` |
| E1 | `ena-metrics-collection` | 2.3 節。CloudWatch エージェントと AMP への取り込み |
| E1 | `alerts-with-runbooks` | 6 節。アラートと runbook の URL の CI の検査 |
| E4 | `mos-est-calibration` | 4.1 節。`media-lab` の格子の試験で係数を合わせる |
| E4 | `freeze-sli` | 4.2 節。止めた consumer とフリーズの区別の確認 |
| E7 | `synthetic-meetings` | 7 節 |
| E7 | `media-slo-dashboards` | 5・8 節 |
| E12 | `meeting-inspector` | 8 節の会議の調べの画面（運用者用） |

## 10. 未解決の問い

### 決定

2026-09-27 の既定案。承認は Dev（テックリード）と Ops が行う。SLO の値は PM と Ops が承認する。

- 品質の報告はシグナリングの WebSocket で 10 秒ごと（ADR-0051）。
- AMP のラベルに会議・参加者・組織・IP を入れない（ADR-0051）。
- 音声は `mos_est`（E-model の形、係数は ViSQOL に合わせる）、映像は MOS を推定しない（ADR-0052）。
- 良い音声の分・フリーズのない分での呼び出しは、サーバーの側の悪化と同時のときだけ。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| E-model の式の G.107 の本文との照合と、Opus の `Ie`・`Bpl` | E1（照合）、E4（係数の合わせ込み） |
| 止めた consumer・帯域で止めた映像が、webrtc-stats のフリーズに数えられるか | E4 |
| 外部送信の公表の文面（L5） | 法務の確認の後。2.2 節の一覧から作る |
| AMP の保持の期間 | E1 で確かめる |
| 組織ごとの品質の SLA を約束するか | GA の前に PM が決める（組織の回線の悪さを含むため、難しい） |

## 11. quality.md・runbooks への項目

### quality.md

- `mos_est` と ViSQOL の差（条件ごと）と、係数の版。
- 5 節の SLI の定義と、試験の環境での測り方（同じ定義を試験と本番で使う）。
- 合成の監視の会議の成功率と、経路ごとの参加の時間。

### runbooks

- [incident-response.md](../runbooks/incident-response.md)：6 節の太字の 4 つの場面（この文書と一緒に書いた）。
- [runbooks/README.md](../runbooks/README.md)：5 節の SLO の表と、6 節のアラートの一覧を正本として移した（統合の工程）。
- `qos-pipeline-lag.md`：Firehose・Athena の遅れ、`participant_quality_summaries` の足し込みの詰まりの確かめ方。

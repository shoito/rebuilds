# Capacity: Zoom

負荷のモデル、参加者 1 人あたりの帯域、1 台の Media Node の上限（帯域、PPS、worker、consumer）、会議ごとの fan-out の計算、S1〜S3 の台数、費用と K8 の目標、負荷試験の計画（合成のメディアを流すボット）。

前提となる決定は、Media Node の中の配置（[ADR-0010](../decisions/0010-media-node-process-layout.md)：vCPU−2 の worker、worker あたり 400 consumer）、転送の規則（[ADR-0011](../decisions/0011-forwarding-and-layer-selection.md)：映像は最大 25 本、音声は最大 3 本）、割り当ての点（[ADR-0012](../decisions/0012-media-assignment-and-cascading.md)：点 0.7 未満に置く）、符号化の設定（[ADR-0017](../decisions/0017-opus-dtx-fec-red.md)〜[ADR-0020](../decisions/0020-screen-share-encoding.md)）、インスタンス（[ADR-0049](../decisions/0049-media-node-fleet.md)）。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0053](../decisions/0053-capacity-model-cost-target-and-load-bots.md) | 1 台の上限は consumer、pps、送出の bps、CPU の 4 つで持ち、負荷試験で決める。それまでは consumer（worker あたり 400）で見積もる。K8 は、メディアの配信の費用 ÷ 参加者・分で、S1 で 0.20 円、S2 で 0.07 円以下を目標にする。負荷試験は Go の Pion で作る軽いボットを主にし、実ブラウザを 2% 混ぜる |
| [0057](../decisions/0057-audio-slots-for-large-meetings.md)（統合の工程） | 100 人を超える会議の音声は、受け手ごとに 3 つの音声の枠にする。音声の consumer は受け手 1 人あたり 3 で、人数の 2 乗で増えない |

数値のうち「初期見積もり」と書いたものは、E7・E12 の負荷試験の前の仮の値である。

## 1. 負荷のモデル（S1）

[architecture/README.md](README.md) の 2 節と NFR から。

| 項目 | S1 の値 | 出典・仮定 |
| --- | --- | --- |
| 同時の会議（ピーク） | 5,000 | README の 2 節 |
| 同時の参加者（ピーク） | 30,000（平均の会議 6 人） | 同上 |
| 1 会議の上限 | 100 人（NFR-006） | 同上 |
| 受けて表示する映像 | 1 人あたり最大 25 本 | NFR-006 |
| 下り（1 人の平均） | **容量の前提 2.5 Mbps**。期待の平均 1.5 Mbps | README の 2 節。2 節の吟味から、容量（台数、送出、transit、クォータ）は 2.5 Mbps で見積もり、1.5 Mbps は期待の平均として費用の見込みに使う（**未検証**。E2 のベータで `qos-report-pipeline` の要約から測って置き換える） |
| 上り（1 人の平均） | 0.8 Mbps | 同上 |
| SFU の送出（ピーク） | 約 75 Gbps（容量の前提）。期待の平均では約 45 Gbps | 30,000 × 2.5 Mbps（1.5 Mbps） |
| 平均とピークの比 | 0.25 | 平日の日中に集中すると仮定。**未検証**（E1 の `cost-dashboard-k8` で参加者・分の実績から直す） |
| 朝の立ち上がり | 平日 9 時の前後 30 分で、同時の参加者が 0.2 → 0.8 × ピーク | **未検証**。予定の会議の開始時刻から E2 のベータで測り、E7 の `predictive-scaling` に入れる |
| TURN を通る参加者 | 10% | **未検証**（E2 のベータで `ice_path` から測る。[network-traversal.md](network-traversal.md) の持ち越し） |
| 1 人の参加の操作 | 参加で約 15 の往復（transport × 2、produce × 2〜3、consume × 数本） | [signaling-and-meetings.md](signaling-and-meetings.md) の 11 節 |

## 2. 参加者 1 人あたりの帯域

符号化の設定（[codecs-and-bandwidth-adaptation.md](codecs-and-bandwidth-adaptation.md) の 4〜7 節）から下から積む。

| 流れ | ビットレート | パケット/秒 |
| --- | --- | --- |
| 音声（Opus 32 kbps、20ms） | ヘッダーを含め約 56 kbps（RED なし）〜約 90 kbps（RED distance 1。ブラウザが送る形。[codecs-and-bandwidth-adaptation.md](codecs-and-bandwidth-adaptation.md) の 4.2 節） | 50（話している間。DTX で黙っている間はほぼ 0） |
| 映像 `f`（720p、30 fps） | 1,500 kbps（T1 の 15 fps で約 1,100 kbps と仮定） | 約 130〜170 |
| 映像 `h`（360p、30 fps） | 500 kbps（T1 で約 375 kbps） | 約 50〜60 |
| 映像 `q`（180p、15 fps） | 150 kbps（T1 で約 110 kbps） | 約 15〜20 |
| 画面共有（`detail`、5 fps） | 最大 1,500 kbps | 約 50〜150（変化の量による） |

- 時間の層 T1 のビットレートを T2 の約 75% と置いたのは仮定（**未検証**。E4 の `downlink-allocation` で層ごとのビットレートを測る）。パケットの大きさは映像で平均 1,000〜1,200 バイトと仮定した。

表示のしかたごとの、受け手 1 人の下り（全員がカメラをつけた場合）：

| 表示 | 受ける映像 | 下り（概算） |
| --- | --- | --- |
| 1:1（相手を大きく） | `f` × 1 ＋ 音声 1 本 | 約 1.6 Mbps |
| 6 人のギャラリー（1 画面の大きなタイル） | `f`（T1）× 5。受け手の上限 4 Mbps（`setMaxOutgoingBitrate`）で頭打ち | 約 4.0 Mbps |
| 25 人のギャラリー | `q`（T1）× 24 ＋ 音声 3 本 | 約 3.0 Mbps |
| 100 人（5 × 5 のギャラリー） | `q`（T1）× 25 ＋ 音声 3 本 | 約 3.1 Mbps |
| 話者の表示（大 1 ＋ 小 4） | `f` × 1 ＋ `q`（T1）× 4 ＋ 音声 3 本 | 約 2.2 Mbps |
| カメラなし（音声だけ） | 音声 3 本 | 約 0.2〜0.4 Mbps |

- **平均 1.5 Mbps は楽観の可能性がある。** 全員がカメラをつけてギャラリーで見る会議が中心なら、平均は 2.5〜3.5 Mbps になる。平均 1.5 Mbps には、参加者・分の半分近くがカメラなしか話者の表示であることが要る。そこで、**容量は 2.5 Mbps を前提にし、1.5 Mbps は期待の平均として残す**（統合の工程で決めた。[architecture/README.md](README.md) の 2 節）。E2 のベータで、表示のしかたとカメラの割合を測り、この文書と費用を直す（費用への影響は [infrastructure.md](infrastructure.md) の 12.2 節）。
- 上り：カメラの送り手は、使われない層を止める（[media-server-sfu.md](media-server-sfu.md) の 5.5 節）ので、多くの会議で `f` だけか `f`＋`q` の 1.5〜1.7 Mbps ＋ 音声。カメラなしの人は音声だけ。平均 0.8 Mbps は、カメラの割合が約半分の仮定に当たる。

## 3. 1 台の Media Node の上限

[ADR-0053](../decisions/0053-capacity-model-cost-target-and-load-bots.md)。c8gn.16xlarge（64 vCPU、200 Gbps。[infrastructure.md](infrastructure.md) の 3.1 節）。

| 資源 | 上限（初期見積もり） | 根拠 | 決め方 |
| --- | --- | --- | --- |
| worker | 62（vCPU − 2） | [ADR-0010](../decisions/0010-media-node-process-layout.md) | E7 で、Node Agent とカーネルの網の処理に 2 で足りるかを確かめる |
| consumer | 24,800（62 × 400） | mediasoup の 1 つの worker は「おおむね 500 を超える consumer」（[Scalability](https://mediasoup.org/documentation/v3/scalability/)、2026-09-27 に確認）に余裕を置く | E7。止めた consumer（`paused`）の費用が小さければ、動いている consumer と分けて数える |
| CPU | worker ごとに 70% | 転送の遅れ p99 10ms（ADR-0001 の Confirmation）を守る余白 | E7 |
| 送出の bps | 20 Gbps（仮） | インターネットへの上限は 100 Gbps（帯域の 50%。[EC2 のネットワークの帯域](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-instance-network-bandwidth.html)、2026-09-27 に確認） | E7。`bw_out_allowance_exceeded` が出ない最大の 70% |
| pps（送受の合計） | 未定 | EC2 は PPS の上限を公表していない（[ENA の性能の指標](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/monitoring-network-performance-ena.html)、2026-09-27 に確認） | E7。`pps_allowance_exceeded` が出始める値の 70% |
| 接続の追跡 | 使わない（メディアのポートは追跡しない） | [ADR-0016](../decisions/0016-media-edge-addressing-and-security-groups.md) | `conntrack_allowance_exceeded` が 0 のまま |

S1 の会議の組み合わせ（平均 6 人）で、どの資源が先に尽きるか：

- 1 人あたりの consumer：映像 5（見える全員）＋ 音声 5（作るが上位 3 人以外は止める）＝ 10。止めた consumer も数える（安全の側）。
- consumer で決まる参加者の数：24,800 ÷ 10 ＝ **約 2,480 人／台**。
- そのときの送出：2,480 × 1.5 Mbps ＝ 約 3.7 Gbps（平均）、2,480 × 4.0 Mbps ＝ 約 9.9 Gbps（全員がギャラリー）。
- そのときの pps：送出 3.7〜9.9 Gbps を平均 1,000 バイトで割ると、約 0.5〜1.2 Mpps（送出）。受信を足して約 0.8〜1.8 Mpps。
- **初期見積もりでは、帯域より先に consumer（と CPU）が上限に来る。** c8gn.16xlarge の網の性能（インターネットへ 100 Gbps）は使い切らない見込み。c8g.16xlarge（インターネットへ 15 Gbps）でも足りる可能性があり、E7 で比べる（[ADR-0049](../decisions/0049-media-node-fleet.md)）。

## 4. 会議ごとの fan-out

記号：N ＝ 参加者、C ＝ カメラをつけた人、V ＝ 受け手 1 人が見る映像の本数（≦ min(C, 25)）、A ＝ 受け手 1 人が受ける音声の本数（≦ 3）、b_v ＝ 見る映像 1 本の平均のビットレート、b_a ＝ 音声 1 本、u ＝ 送り手 1 人の映像の上り。

- 入り（SFU の受信）＝ C × u ＋（話している人）× b_a ＋ 共有
- 出（SFU の送出）＝ N × (V × b_v ＋ A × b_a) ＋ 共有 × (N − 1)
- 映像の consumer ＝ N × min(C, 25)（見えない映像の consumer は止める）
- 音声の consumer ＝ N × (N − 1)（作る数。動くのは受け手ごとに 3）
- worker の間の pipe：受け手の家の worker に送り手の producer がないとき 1 つ（[ADR-0010](../decisions/0010-media-node-process-layout.md)）

| 会議 | 入り | 出 | 映像の consumer | 音声の consumer（作る／動く） | 1 台に占める割合（consumer） |
| --- | --- | --- | --- | --- | --- |
| 2 人（1:1） | 約 3.2 Mbps | 約 3.2 Mbps | 2 | 2 ／ 2 | 0.02% |
| 6 人（ギャラリー） | 約 9.5 Mbps | 約 24 Mbps | 30 | 30 ／ 18 | 0.24% |
| 25 人（ギャラリー） | 約 38 Mbps | 約 75 Mbps | 600 | 600 ／ 75 | 4.8% |
| 100 人（5 × 5） | 約 150 Mbps | 約 310 Mbps | 2,500 | 9,900 ／ 300 | 50% |
| 300 人（S2） | 約 450 Mbps | 約 930 Mbps | 7,500 | 89,700 ／ 900（音声の枠の形では 900 ／ 900） | 送り手ごとの形では 1 台に収まらない。枠の形で約 34% |
| 1,000 人（S3） | 約 1.5 Gbps | 約 3.1 Gbps | 25,000 | 999,000 ／ 3,000（同 3,000 ／ 3,000） | 1 台に収まらない（映像の consumer だけで 1 台を超える） |

- 入りは、全員がカメラをつけて `f`＋`q` の 1.6 Mbps を送る場合。
- **音声の consumer を参加者の組ごとに作る形は、大きな会議で持たない。** 100 人の会議で 9,900、300 人で約 9 万、1,000 人で約 100 万の consumer になる。止めた consumer の費用が小さくても、作る・止める・再開の操作と、メモリが人数の 2 乗で増える。そこで、100 人を超える会議は、受け手ごとの 3 つの「音声の枠」に話者を付け替えて送る（[ADR-0057](../decisions/0057-audio-slots-for-large-meetings.md)。統合の工程で決めた）。音声の consumer は受け手 1 人あたり 3 になる。E7 の `audio-slot-forwarder-poc` で転送器の性能を確かめてから、E10 で作る。
- 100 人の会議は 1 台の consumer の約半分を使う。S1 で 100 人の会議が同時に多いと、1 台に置ける会議の数が大きく減る。Media Assignment Service は予定の人数の分を予約する（[media-server-sfu.md](media-server-sfu.md) の 8.1 節）。
- キーフレーム：新しい参加者が 25 本の映像を受け始めると、送り手 25 人にキーフレームの要求が行く。キーフレームは平常のフレームの数倍の大きさで、多くの受け手の要求で送り手の送出が 2〜3 倍になりうる（Scalability）。間隔の制御は [ADR-0011](../decisions/0011-forwarding-and-layer-selection.md)。

## 5. S1〜S3 の台数

### 5.1 S1（東京）

| 手順 | 値 |
| --- | --- |
| 1 台の上限（consumer で決まる） | 約 2,480 人 |
| ピークに要る台数（点 1.0） | 30,000 ÷ 2,480 ≈ 12.1 |
| 点の上限 0.7 で割る | ≈ 17.3 |
| 1 つの AZ を失っても残りの 2 つで受ける（AZ ごとにピークの半分） | 17.3 ÷ 2 ≈ 8.7 → **AZ ごとに 9 台、計 27 台** |
| 夜間の最小 | AZ ごとに 2 台、計 6 台 |
| 入れ替えの間（[ADR-0055](../decisions/0055-media-node-rolling-replacement.md)） | 最大で ＋27 台（古い台の drain の間） |
| ウォームプール | AZ ごとに 2 台（停止） |

- 止めた consumer を数えない場合（E7 で安いと分かった場合）、1 人あたりの consumer は約 8 になり、1 台 3,100 人、計 21 台に減る。
- 送出はピークで 1 台あたり 75 Gbps ÷ 18 台（1 つの AZ を失った後）≈ 4.2 Gbps（容量の前提の 2.5 Mbps の場合。期待の平均 1.5 Mbps では約 2.5 Gbps）。c8g.16xlarge のインターネットへの上限（15 Gbps）にも収まる。

### 5.2 S2・S3（初期見積もり）

| 段階 | 同時の参加者 | 1 台の上限（仮） | 要る台数（点 0.7、AZ の余白を含む） | 送出（ピーク） |
| --- | --- | --- | --- | --- |
| S2 | 30 万（東京 6：大阪 4） | 約 1,800 人（平均の会議が大きくなり、1 人の consumer が約 14。100 人を超える会議の音声は枠で 3） | 東京 約 215 台、大阪 約 145 台 | 約 750 Gbps（期待の平均では約 450 Gbps） |
| S3 | 200 万 | 未定（音声は枠の形。映像の consumer と E7・E10 の実測で決まる） | 2,000 台を超える見込み。Edge とリージョンの間のカスケード | 約 5 Tbps（同 約 3 Tbps） |

- S2 以降の台数は、音声の枠の実測（E7 の PoC、E10）と、E7 の実測で大きく変わる。

### 5.3 TURN

- TURN を通る参加者が 10% なら、S1 のピークで 3,000 人。中継する帯域は、下り 3,000 × 2.5 Mbps ＋ 上り 3,000 × 0.8 Mbps ≈ 約 10 Gbps（容量の前提。期待の平均では約 7 Gbps。それぞれの向きで、TURN の入りと出の両方に載る）。
- coturn の 1 台の処理の上限は**未検証**（E7 の `load-l0-l2` で TURN の台も測る）。東京は c8gn.8xlarge（32 vCPU）で AZ ごとに 2 台（計 6 台）、大阪は c6gn.8xlarge で 2 台から始め、1 台の中継の帯域が 2 Gbps を超えたら足す（初期見積もり）。

### 5.4 その他の部品

| 部品 | S1 のピークの負荷 | 見積もり |
| --- | --- | --- |
| Signaling Gateway | 30,000 の WebSocket、`qos.report` 3,000 件/秒、`ping` 6,000 件/秒 | 1 タスク 5,000 接続で 6 タスク＋余白（[infrastructure.md](infrastructure.md) の 6 節）。**未検証**（E7 の `signaling-load-test`） |
| Actor Host | 5,000 会議。朝の立ち上がりで参加 1 秒に約 50 人 × 15 往復 | 1 タスク 2,000 会議の上限。6 タスク |
| Media Node の付け替えの集中 | 1 台の障害で約 2,500 人が 2 秒以内に transport を作り直す（約 2 万の往復） | Actor Host は会議ごとに処理するので、1 台の障害の会議（約 400）が 6 タスクに分かれる。E7 の L2 で測る |
| Valkey | リースの更新（会議ごと 2 秒に 1 回）＝ 2,500 回/秒、スナップショット（500ms ごと、変化があるとき）、チャットの Stream、流量の制限 | 3 シャードで足りる見込み |
| Aurora | 参加・退出の行（朝の立ち上がりで約 50 件/秒）、監査、outbox | writer の r8g.2xlarge で足りる見込み |
| Firehose | 品質の記録 3,000 件/秒（1 件 約 2 KB）＝ 約 6 MB/秒 | **1 つのストリームの既定の上限を超える。** Direct PUT の既定は、東京では 1 ストリームあたり 1 MiB/秒・1,000 要求/秒・10 万件/秒（5 MiB/秒は米国東部・米国西部（オレゴン）・アイルランドだけ）。料金は 1 件ごとに 5 KB に切り上げて数える（[Amazon Data Firehose Quota](https://docs.aws.amazon.com/firehose/latest/dev/limits.html)、2026-09-27 に確認）。そこで、Gateway のタスクごとに 1 秒分の要約を改行区切りで 1 件にまとめて `PutRecordBatch` で送り（件数と切り上げの費用を減らす）、ストリームの上限の引き上げ（8 MiB/秒）を E12 の `quota-requests` より前、E2 の `qos-report-pipeline` の着手時に申請する。引き上げが間に合わなければ、ストリームを 8 つに分けて Gateway のタスクで振り分ける |

### 5.5 クォータ（着手前に確かめ、必要なら引き上げを申請する）

| クォータ | 要る量（S1、東京） | 備考 |
| --- | --- | --- |
| EC2 のオンデマンドの vCPU（C 系列など） | Media Node 最大 60 台 × 64 ＋ TURN 12 台 × 32 ＋ ウォームプール ≈ 4,400 | 入れ替えの間は倍近くになる |
| Elastic IP | 約 80 | BYOIP のプールから取った EIP は、EIP の数の上限（既定でリージョンに 5）に数えない（[Elastic IP addresses](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/elastic-ip-addresses-eip.html)、2026-09-27 に確認）。BYOIP が間に合わず AWS の連続したブロックで始めるときは、上限の引き上げを申請する |
| Shield Advanced の保護の数 | 数十（入口と、攻撃のときの EIP） | 1 アカウントで種類ごとに 1,000 |
| Fargate の vCPU | 約 100 | — |
| Kinesis Data Firehose の書き込み | 約 6 MB/秒 | 東京の既定は 1 ストリーム 1 MiB/秒。8 MiB/秒へ引き上げる（5.4 節） |
| Amazon Transcribe の同時の流れ | [recording-and-transcription.md](recording-and-transcription.md) で決める | — |

## 6. 費用と K8

方針は [ADR-0053](../decisions/0053-capacity-model-cost-target-and-load-bots.md)。計算の中身は [infrastructure.md](infrastructure.md) の 12 節。

- **K8 の定義**：（インターネットへの転送 ＋ Media Node ＋ TURN ＋ TURN と Media Node の間の転送 ＋ DDoS の防御）の月の費用 ÷ 月の参加者・分。制御の側、録画、字幕は含めない（別に見る）。
- **目標**（2026-09-27 に推奨案で確定）：S1 で 0.20 円以下、S2 で 0.07 円以下。1 USD = 150 円と仮定する。
- **S1 を AWS で容量の前提（下り 2.5 Mbps）のまま動かすと、K8 は約 0.28 円で 0.20 円に届かない。** 届くのは、下りの平均が 1.5 Mbps 前後に収まるときか、Edge（[ADR-0050](../decisions/0050-disaster-recovery-and-edge-migration.md)）か AWS との料金の合意で転送の単価が下がるときである。S1 の目標の達成は Edge に掛かる。目標の値は変えない。AWS で 2.5 Mbps のとき届かないことは受け入れ、閾値（4 週続けて 10 Gbps）で Edge の構築を始める。
- **見積もり**：

| 形 | K8（参加者・分あたり） | 備考 |
| --- | --- | --- |
| AWS の表の料金、下り平均 1.5 Mbps（期待の平均） | 約 0.18 円 | S1 の目標に届く |
| AWS の表の料金、下り平均 2.5 Mbps（容量の前提） | 約 0.28 円 | **S1 の目標に届かない。** E2 のベータの実測がこちらに近ければ、Edge の判断（[ADR-0050](../decisions/0050-disaster-recovery-and-edge-migration.md)。運用の体制の判断の点は [infrastructure.md](infrastructure.md) の 11 節）を早める |
| AWS で Media Node の EIP を Shield Advanced で常に守る | ＋約 0.05 円 | ADR-0045 で退けた |
| 国内のコロケーション（Edge） | 約 0.05 円 | 仮定が多い。[infrastructure.md](infrastructure.md) の 12.3 節 |

- **転送の単価が K8 のほとんどを決める。** AWS の東京のインターネットへの転送は、150 TB/月を超える分で 0.084 USD/GB。1 参加者・分（11.25 MB）で約 0.00095 USD ≈ 0.14 円。インスタンスの選び方で下げられるのは 0.02 円程度。
- K8 の実績は、毎月、請求（アカウントとタグ `service`）と、Media Node・TURN が送ったバイトの数、参加者・分（`meeting_participations`）から計算する（[infrastructure.md](infrastructure.md) の Story の `cost-dashboard-k8`）。

## 7. 負荷試験の計画

方針は [ADR-0053](../decisions/0053-capacity-model-cost-target-and-load-bots.md)。`media-lab` のアカウントで行う（[ADR-0054](../decisions/0054-network-impairment-lab.md)）。

### 7.1 ボット

| 種類 | 作り | 1 つのボットがすること |
| --- | --- | --- |
| 送り手のボット | Go、Pion（WebRTC、ICE、DTLS、SRTP、interceptor） | 本システムのシグナリング（JSON Schema から型）で参加。符号化済みの VP8 simulcast 3 本（合成の映像を libvpx で符号化した IVF）と Opus（公開のデータセットの音声を符号化したもの。話す・黙るの型を持つ）を RTP で流す。transport-cc の帰還に合わせて送る本を止める（ブラウザの振る舞いの近似） |
| 受け手のボット | 同上 | 復号しない。RTCP（RR、transport-cc、NACK、PLI）を返す。受けたパケットの数、損失、遅れ（下の 7.3 節）を数える。`view.update` をブラウザと同じ頻度で送る |
| 品質の見張り | Playwright の Chrome（[ADR-0054](../decisions/0054-network-impairment-lab.md) の測り方） | 会議の 2% に入り、`mos_est`、フリーズ、glass-to-glass を測る |

- 1 台の EC2（c7g.4xlarge を想定）で動かせるボットの数は**未検証**。E7 の `loadbot-pion` で、L0 の前に測る。
- ボットの映像・音声は、合成か、利用の条件が明らかな公開のデータセットだけ（本題材の AGENTS.md）。

### 7.2 段階

| 段階 | 中身 | 合格の基準 | 時期 |
| --- | --- | --- | --- |
| L0 worker | 1 つの worker に consumer を増やす（動いている・止めたを分けて） | 転送の遅れ p99 10ms、CPU 85% のときの consumer の数を記録 | E7 の最初 |
| L1 1 台 | 会議の組（2、6、25、100 人）を増やす。c8gn.16xlarge と c8g.16xlarge | ENA の `*_allowance_exceeded` が 0、転送の遅れ p99 10ms、見張りの `mos_est` 4.0 以上。このときの 4 つの資源の値を 3 節の表に書く | E7 |
| L2 付け替え | 1 台に 2,500 人を載せて止める。worker を `SIGKILL` | 全参加者の音声が 5 秒以内（p95。NFR-004）。Actor Host のイベントループの遅れ | E7 |
| L3 群れ | S1 のピークの 1.2 倍（36,000 人、6,000 会議。TURN を 10%）で 2 時間 | [ADR-0052](../decisions/0052-media-slis-and-mos-estimation.md) の SLO を満たす | E12（GA の前） |
| L4 立ち上がり | 0 から S1 のピークまで 60 分で増やす（予定の会議の予測とウォームプールを使う） | 参加の成功 99.5%、参加の p95 3 秒 | E12 |
| L5 長時間 | S1 のピークの 50% で 24 時間 | メモリ・ファイル記述子の増加がない | E12、以後 mediasoup のバージョンを上げるたび |
| L6 攻撃 | 参加者でない送信元から Media Node へ UDP の洪水（[ADR-0045](../decisions/0045-ddos-defense-for-media-edge.md) の防御のモード） | 既存の参加者の途切れがない範囲を記録 | E7 |

### 7.3 転送の遅れの測り方

- 送り手と受け手のボットの組を同じ EC2 に置き、送り手が RTP のヘッダー拡張（`abs-send-time` か、`urn:<brand>:...` の送信の時刻）に時刻を入れ、受け手が受けた時刻との差を測る（同じ台の時計を使うので時計の同期が要らない）。
- 差から、ボットと Media Node の間の往復の分を引くため、Media Node を通らない経路の遅れ（同じ台の間の ping）を同時に測る。

### 7.4 費用

- ボットの送受信は、同じリージョンの公開の IP の間の通信で、向きごとに 0.01 USD/GB（[infrastructure.md](infrastructure.md) の 2.4 節）。L3 の 2 時間（送出 約 55〜90 Gbps。下り 1.5〜2.5 Mbps）で約 50〜80 TB、約 1,000〜1,600 USD の見込み。
- ボットの通信が、インターネットゲートウェイの上限（インスタンスの帯域の 50%）に数えられるかは**未検証**（E7 の `load-l0-l2` の最初に確かめる）。数えられない場合、本番のインターネットへの上限を試せないので、L1 の一部を東京の外（大阪）から流して比べる（リージョンの間の転送 0.09 USD/GB に注意）。

## 8. 余裕の方針

- Media Node の点の上限 0.7（[ADR-0012](../decisions/0012-media-assignment-and-cascading.md)）は、報告の遅れ、キーフレームの嵐、攻撃の余白を兼ねる。
- AZ ごとにピークの半分の容量を持つ（AZ の障害で付け替えを受けるため）。
- 平常の点の平均が 0.5 を 2 週続けて超えたら、台数の式を見直す。

## 9. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E7 | `loadbot-pion` | 7.1 節のボット（送り手・受け手）と、シナリオの記述 |
| E7 | `load-l0-l2` | 7.2 節の L0〜L2。3 節の表を実測で埋める |
| E7 | `ddos-under-attack-load` | L6 |
| E7 | `node-limits-in-assignment` | E7 の値を、Assignment Service の `*_limit` にインスタンスの種類ごとに入れる |
| E7 | `audio-slot-forwarder-poc` | 4 節の音声の枠の PoC（[ADR-0057](../decisions/0057-audio-slots-for-large-meetings.md)。sfu の領域と 1 つ） |
| E10 | `audio-slot-forwarder` | 音声の枠の実装（sfu の領域と 1 つ。旧 `audio-slot-consumers`） |
| E12 | `load-l3-l5` | 7.2 節の L3〜L5（GA の判定の材料） |
| E12 | `quota-requests` | 5.5 節のクォータの確認と申請 |

## 10. 未解決の問い

### 決定

2026-09-27 に推奨案で確定した（[README.md](README.md) の 6 節の「決定（2026-09-27、推奨案で確定）」）。

- 1 台の上限は 4 つの資源で持ち、E7 で決める。それまでは consumer で見積もる。
- S1 の台数：ピーク 27 台、夜間 6 台（東京）。
- K8：S1 0.20 円、S2 0.07 円の目標を保つ。S1 を AWS の下り 2.5 Mbps で動かすと届かないことは受け入れ、閾値で Edge の構築を始める道を採る（ADR-0050）。
- 容量は下り 2.5 Mbps を前提に見積もる。1.5 Mbps は期待の平均（統合の工程で決めた）。
- 100 人を超える会議の音声は枠の形（[ADR-0057](../decisions/0057-audio-slots-for-large-meetings.md)）。
- 負荷試験は Pion のボットと 2% の実ブラウザ。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| 平均の下り（期待の 1.5 Mbps、容量の前提の 2.5 Mbps）と、表示のしかた・カメラの割合 | E2 のベータで測る。費用と台数を直す |
| 止めた consumer の費用（数えるか） | E7 の L0 |
| 1 台の pps と送出の上限 | E7 の L1 |
| 音声の枠の転送器の性能と、切り替えの聞こえ方 | E7 の `audio-slot-forwarder-poc`（[ADR-0057](../decisions/0057-audio-slots-for-large-meetings.md)） |
| TURN の 1 台の上限と、TURN を通る参加者の割合 | E2 のベータと E7 の `load-l0-l2` |
| ボットの通信がインターネットゲートウェイの上限に数えられるか | E7 の `load-l0-l2` の最初に確かめる |

## 11. quality.md・runbooks への項目

### quality.md

- 7.2 節の段階ごとの合格の基準と、実施の時期。
- 3 節の上限の表（実測で埋めたもの）と、測った条件（インスタンスの種類、mediasoup のバージョン、AMI）。
- K8 の実績（月次）と、下りの平均、カメラの割合、表示のしかたの分布。

### runbooks

- `media-capacity-shortage.md`：ピークで点 0.7 未満の Node が足りなくなったときの、台の追加、予備の種類への切り替え、新しい会議の人数の予約の見直し。
- `morning-ramp-scaling.md`：朝の立ち上がりで台数の予測が外れたときの、スケジュールのアクションの手での上書き。

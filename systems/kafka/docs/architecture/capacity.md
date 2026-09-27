# Capacity: Kafka

負荷のモデル、CU の定義から来る入力、インスタンスの型ごとのブローカーのスループット、EBS、AZ をまたぐ転送、S3 の要求、NLB と Envoy、費用のモデル（NFR-010）、負荷試験の計画。決定は [ADR-0048](../decisions/0048-broker-design-point-and-cost-model.md)。台数の表は [infrastructure.md](infrastructure.md) の 3.2 節、月の費用の表は同じく 11 節にある。

**ここの数値はすべて初期見積もりである。** E1・E9 の負荷試験（11 節）で確かめ、結果で置き換える。AWS の単価は 2026-09-27 に AWS Price List API（東京 `ap-northeast-1`）で、帯域の値は同じ日に EC2 の文書で確かめた。確かめていないものは「未検証」と書く。

## 1. 負荷のモデル（S1）

| 項目 | 値 | 根拠・前提 |
| --- | --- | --- |
| 論理クラスタ | 1,000 | [README.md](README.md) の 2 節 |
| 書き込みのピーク（全体） | 2 GB/秒 | 同上 |
| 書き込みの平均 | 0.8 GB/秒（ピークの 40%） | 仮定。日中と夜の差、業務の偏り |
| 月の書き込み | 約 210 万 GB | 0.8 GB/秒 × 30.4 日 |
| 読み取りの倍率 F | 3 | NFR-010 の前提 |
| 保持 | 7 日（平均） | 同上 |
| パーティション（複製の前） | 20 万（Standard 12 万、Basic 8 万） | README の 2 節。層の割合は仮定 |
| 複製 | 60 万 | 複製 3 |
| 1 つの物理クラスタの書き込み | 2 GB/秒まで | NFR-006 |
| 論理クラスタの最大（Standard） | 10 CU（書き込み 250 MB/秒） | [ADR-0037](../decisions/0037-capacity-unit-definition.md) |
| ローカルの保持 | 6 時間＋ `segment.ms` 1 時間 | [ADR-0019](../decisions/0019-tiered-storage-lifecycle-and-dr-copy.md)、[ADR-0010](../decisions/0010-segment-retention-and-compaction-defaults.md) |
| fetch-from-follower を使う割合 | 80%（仮定） | クライアントが `client.rack` を設定する割合。設定しないと AZ をまたぐ読み取りが増える（5 節） |

- パーティションの数と書き込みの量の比は、1 MB/秒あたり 100 パーティション（20 万 ÷ 2,000 MB/秒）。多数の小さな論理クラスタを想定した値で、スループットに比べてパーティションが非常に多い。これが S1 の台数を決める（10 節）。

## 2. CU から来る入力

CU の値の正本は [ADR-0037](../decisions/0037-capacity-unit-definition.md) と [metrics-and-billing.md](metrics-and-billing.md) の 3 節。容量の計画に使うのは次の値。

| 次元 | Standard の 1 CU | Basic の 1 CU | 容量の計画での扱い |
| --- | --- | --- | --- |
| 書き込み | 25 MB/秒 | 5 MB/秒 | ブローカーの W（リーダーの書き込み）に足す |
| 読み取り | 75 MB/秒 | 15 MB/秒 | F = 3 の前提と同じ比 |
| パーティション | 250 | 100 | 複製 3 で 750・300 の複製 |
| 接続 | 1,000 | 100 | ブローカーの接続の数の上限（`max.connections`）の余裕に使う |
| 接続の試み | 50 回/秒 | 10 回/秒 | TLS の握手の CPU（11 節で測る） |
| 要求 | 1,500 回/秒 | 400 回/秒 | 要求の処理時間（CPU）。平均 0.5ms と仮定（[multi-tenancy-and-quotas.md](multi-tenancy-and-quotas.md) の 6 節） |

- クォータは CU の上限で掛かるが、ほとんどの論理クラスタは上限まで使わない。配置は、過剰の割り当ての倍率 K = 4 で詰める（[ADR-0033](../decisions/0033-logical-cluster-placement.md)）。容量の計画は、上限ではなく実際の使用（7 日の p95）で行う。

## 3. ブローカーのスループット

[ADR-0048](../decisions/0048-broker-design-point-and-cost-model.md)。

### 3.1 式

1 台のブローカーが受けるリーダーの書き込みを W（MB/秒）とする。複製 3・読み取り F 倍、コンシューマーは同じ AZ の複製から読むので、読み取りは 3 つの複製に均等に散る。

| 流れ | 量 |
| --- | --- |
| ネットワークの受信 | W（プロデューサー）＋ 2W（他のリーダーからの複製）＝ 3W |
| ネットワークの送信 | 2W（フォロワーへの複製）＋ FW（コンシューマー）＋ W（S3 への上げ）＝ (3 + F)W |
| EBS の書き込み | 3W（全ての複製を書く） |
| EBS の読み取り | W（S3 への上げ。閉じたセグメントは 1 時間分で、ページキャッシュに収まらない）＋ 0.2FW（キャッシュに当たらない遅れた読み取り。割合は仮定） |

- EC2 の帯域は送信と受信のそれぞれに掛かる（[Instance network bandwidth](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-instance-network-bandwidth.html)）。受信（3W）は送信（6W）より小さいので、送信で決まる。
- 設計点：送信と EBS が、それぞれ基準の帯域の 60% 以下になる最大の W。1 つの AZ を失うと、残りのブローカーの負荷は約 1.5 倍になり、90% に収まる。MSK も CPU を 60% 未満に保つよう勧める（[MSK best practices](https://docs.aws.amazon.com/msk/latest/developerguide/bestpractices.html)、2026-09-27 に確認）。
- 1 つの TCP の流れは、配置グループの外で 5 Gbps までに制限される（同上の帯域の文書）。複製のフェッチャーは `num.replica.fetchers`（4 の案）の数だけ流れを持つので、1 つのブローカーの組の間で 5 Gbps に当たる見込みはない（未検証。E1 の `load-test-t1-t2` の T1 で、フェッチャーごとの流量を測る）。

### 3.2 型ごとの設計点（F = 3）

| 型 | vCPU・メモリー | ネットワーク（基準） | EBS（基準） | 送信で決まる W | EBS で決まる W | 設計点 W | 月額（オンデマンド） | 1 MB/秒あたり |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| r8g.2xlarge | 8・64 GiB | 3.75 Gbps（469 MB/秒） | 2,500 Mbps（312 MB/秒） | 47 | 41 | 40 | $415 | $10.4 |
| **r8g.4xlarge** | 16・128 GiB | 7.5 Gbps（937 MB/秒） | 5,000 Mbps（625 MB/秒） | 94 | 82 | **80** | $830 | $10.4 |
| r8g.8xlarge | 32・256 GiB | 15 Gbps（1,875 MB/秒） | 10,000 Mbps（1,250 MB/秒） | 188 | 163 | 160 | $1,660 | $10.4 |
| **m8g.4xlarge** | 16・64 GiB | 7.5 Gbps | 5,000 Mbps | 94 | 82 | **80** | $677 | $8.5 |

- 帯域は [Memory optimized](https://docs.aws.amazon.com/ec2/latest/instancetypes/mo.html)・[General purpose](https://docs.aws.amazon.com/ec2/latest/instancetypes/gp.html)、単価は Price List API（r8g.4xlarge $1.13696/時、m8g.4xlarge $0.92752/時、r8g.2xlarge $0.56848/時、r8g.8xlarge $2.27392/時）。月は 730 時間。
- どの型でも EBS の帯域で決まる。1 MB/秒あたりの単価は同じなので、型は「障害の範囲」「パーティションの上限（4,000 の複製）」「ページキャッシュ」で選ぶ。
- Standard は r8g.4xlarge：ページキャッシュ（約 110 GiB）が、W = 80 のときの約 8 分の書き込み（3W × 480 秒）を持ち、数分遅れたコンシューマーをディスクに落とさない。Basic は m8g.4xlarge：遅延の目標が緩い（[ADR-0047](../decisions/0047-slos-synthetic-probes-and-alerts.md)）。
- CPU（TLS、SASL、要求の処理、名前空間のパッチ、圧縮の再計算の有無）は未検証。16 vCPU で W = 80 のとき 60% 未満になるかを 11 節の T1（E1 の `load-test-t1-t2`）で測る。本家の `num.io.threads`・`num.network.threads` は、MSK の勧め（4xlarge で 16・8）を初期値にする（同上の MSK の文書）。

### 3.3 ブローカーあたりの CU

| 層 | スループットで | パーティションで | 使う値 |
| --- | --- | --- | --- |
| Standard（r8g.4xlarge） | 80 ÷ 25 = 3.2 CU | 4,000 ÷ 3 ÷ 250 = 5.3 CU | 3.2 CU |
| Basic（m8g.4xlarge） | 80 ÷ 5 = 16 CU | 4,000 ÷ 3 ÷ 100 = 13.3 CU | 13.3 CU |

- `capacity_cu(pc)` ＝ ブローカーの台数 × 上の値（[control-plane-and-provisioning.md](control-plane-and-provisioning.md) の 10.2 節の持ち越しへの答え）。Standard の 30 台の物理クラスタで 96 CU。
- 1 つの論理クラスタの最大（Standard 10 CU）は、物理クラスタの 25% 以下（配置の受け入れの条件 3）。96 CU の 25% は 24 CU なので収まる。

## 4. EBS

[ADR-0009](../decisions/0009-ebs-gp3-single-log-volume.md) の式に、3 節の W を入れる。

```
容量 = { 3W_design × (local.retention.ms + segment.ms) + 圧縮のトピックの分 } ÷ 0.85
スループット = 3W + W + 0.2FW = 4.6W（F = 3）。型の EBS の基準の帯域を超えて買わない
```

| 場面 | W | 容量 | スループット・IOPS | 月額（gp3） |
| --- | --- | --- | --- | --- |
| スループットで決まるブローカー（W = 80） | 80 | 3 × 80 MB/秒 × 25,200 秒 ≒ 6.0 TB ＋ 圧縮 1 TiB → 8 TiB | 600 MiB/秒・6,000 IOPS | 約 $830 |
| パーティションで決まるブローカー（S1 の上限、10 節。W ≒ 13） | 13 | 1.0 TB ＋ 圧縮 1 TiB → 3 TiB | 250 MiB/秒・3,000 IOPS | 約 $300 |

- gp3 の単価（東京）：$0.096/GB-月、3,000 IOPS を超える分 $0.006/IOPS-月、125 MiB/秒を超える分 $0.048/MiB/秒-月（Price List API）。
- 容量は、設計点の W で決める（平均の W ではない）。ローカルの保持は時間で決まるので、ピークの時間帯に 7 時間分を持てる必要がある。
- EBS の費用は、W = 80 のブローカーで、インスタンス（$830）とほぼ同じになる。ローカルの保持を 3 時間（2 時間＋ `segment.ms`）にすると 4 TiB・約 $420 になる。ADR-0019 の 6 時間はそのままにし、E9 で「2 時間より古い位置からの読み取りの割合」を測って、1% 未満なら短縮を ADR で提案する（[ADR-0048](../decisions/0048-broker-design-point-and-cost-model.md)）。
- broker-and-log-storage の 5.2 節の例は、スループットを 1,000 MiB/秒としている。r8g.4xlarge の EBS の基準の帯域（625 MB/秒）を超えるので、買っても使えない。回復と再配置の読み取りは、型の帯域の中で throttle する（[metadata-and-control.md](metadata-and-control.md) の 4.3 節の 100 MB/秒）。
- 使用率 75% で自動の拡張（[ADR-0009](../decisions/0009-ebs-gp3-single-log-volume.md)）。拡張は KafkaNodePool の `storage.size` で、AZ のプールの全台が一緒に広がる（[control-plane-and-provisioning.md](control-plane-and-provisioning.md) の 7.3 節）。

## 5. AZ をまたぐ転送

東京の AZ をまたぐ転送は、送信と受信で各 $0.01/GB（Price List API の `APN1-DataTransfer-Regional-Bytes`、2026-09-27 に確認。これで intent.md と README の「東京の単価は未検証」を外した）。

| 経路 | 書き込み 1 GB あたり | 費用 |
| --- | --- | --- |
| プロデューサー → リーダー | 2/3 GB が AZ をまたぐ（クライアントとリーダーの AZ が 3 分の 2 の確率で違う） | $0.0133 |
| リーダー → 2 つのフォロワー | 2 GB | $0.04 |
| コンシューマー ← ブローカー（`client.rack` あり） | 0 | 0 |
| コンシューマー ← ブローカー（`client.rack` なし） | F × 2/3 GB | F = 3 で $0.04 |
| ブローカー → S3 | 0（ゲートウェイ型のエンドポイント） | 0 |
| NLB → Envoy → ブローカー | 0（cross-zone 無効、同じ AZ。[ADR-0044](../decisions/0044-nlb-sni-proxy-and-zonal-hostnames.md)） | 0 |

- 1 節の仮定（80% が `client.rack` を設定）で、平均 $0.0533 ＋ 0.2 × $0.04 ＝ $0.061/GB。README の $0.053 は全員が設定したときの値。
- `client.rack` を設定しない利用者の分は、当社の原価に乗る。コンソールと文書で設定を案内し、同じ AZ から読んだバイトの割合を quality.md の指標にする（[replication-and-durability.md](replication-and-durability.md) の 15 節）。
- 再配置（ブローカーの追加・退役）の転送は、同じ AZ の中で行う（[ADR-0016](../decisions/0016-partition-placement-reassignment-and-cordon.md)）ので、AZ をまたがない。

## 6. S3 の要求と KMS

単価（東京、Price List API。[tiered-and-object-storage.md](tiered-and-object-storage.md) の 8.2 節と同じ）：保存 $0.025/GB-月、PUT $0.0047/1,000、GET $0.00037/1,000。

| 項目 | 見積もり |
| --- | --- |
| 保存（7 日） | 書き込み 1 GB あたり 1 GB × 7/30 月 × $0.025 ＝ $0.0058 |
| 上げの PUT（流量に比例） | 256 MiB のセグメントをマルチパートで上げ、索引とマニフェストを足して約 15 回。1 GB あたり約 60 回 ＝ $0.0003 |
| 上げの PUT（パーティションに比例） | 流量の少ないパーティションも 1 時間ごとにセグメントが閉じる（空のセグメントは閉じない）。1 つの動いているパーティションで月に約 720 セグメント × 約 5 回 ＝ 3,600 回 ＝ $0.017/月。動いているパーティション 10 万で約 $1,700/月 |
| 読み戻しの GET | 4 MiB の塊ごとに 1 回。1 GB の読み戻しで 256 回 ＝ $0.0001 |
| 消す | DELETE は無料 |
| KMS | S3 Bucket Keys で、バケットごとの鍵の要求は時間あたり少数（[S3 Bucket Keys](https://docs.aws.amazon.com/AmazonS3/latest/userguide/bucket-key.html)）。EBS は付け替えのときだけ。東京の上限 20,000 回/秒から遠い |

- 1 時間の `segment.ms` は、パーティションの数に比例する PUT の費用を生む（ADR-0010 の Consequences）。テナントが `segment.ms` を 10 分にすると 6 倍になる。許可の範囲（10 分〜7 日）の下限を、PUT の費用で見直す余地がある（持ち越し）。
- S3 の前方一致ごとの要求の速さ（PUT 系 3,500/秒、GET 系 5,500/秒）には、S1 の規模では当たらない（[tiered-and-object-storage.md](tiered-and-object-storage.md) の 5.2 節）。

## 7. NLB と Envoy

- **NLB**：処理のバイト 1 GB/時が 1 NLCU で $0.006/時（[ELB pricing](https://aws.amazon.com/elasticloadbalancing/pricing/)）。書き込み 1 GB あたり、書き込み 1 GB と読み取り F GB が通る。F = 3 で 4 GB × $0.006 ＝ $0.024。接続の次元（同時 10 万、新しい接続 800/秒で 1 NLCU）は、S1 の接続の数（数十万の同時の接続の見込み）で数 NLCU で、処理のバイトより小さい。
- **Envoy**：TCP をそのまま中継するので、クライアントとの流れの全てが Envoy の受信と送信の両方を通る。書き込み 1 GB あたり、各方向に (1 + F) GB。c8g.2xlarge（ネットワークの基準 3.75 Gbps ＝ 469 MB/秒。[Compute optimized](https://docs.aws.amazon.com/ec2/latest/instancetypes/co.html)、2026-09-27 に確認）の 60% で、各方向 281 MB/秒 → 書き込み 70 MB/秒分。S1 のピーク（書き込み 2 GB/秒）では、AZ あたり約 10 台。
- Envoy の CPU（TLS を終端しないので、主に TCP の中継と接続の数）は未検証。11 節の T6 で 1 台の上限を測る（E1 の `edge-poc`、E12 の `load-test-ga`）。

## 8. 費用のモデル（NFR-010）

Standard のトピック（読み取り 3 倍、保持 7 日）で、書き込み 1 GB あたりの原価。ブローカーの平均の使用率を u（設計点の W に対する平均の W の比）とする。

| 項目 | u = 40% | u = 60% | 根拠 |
| --- | --- | --- | --- |
| ブローカー（r8g.4xlarge $830 ＋ EBS 8 TiB $827 ＋ コントローラー・システムの按分 $36） | $0.0201 | $0.0134 | 月の書き込み ＝ 80 MB/秒 × u × 262.8 万秒 |
| Envoy | $0.004 | $0.003 | 7 節 |
| AZ をまたぐ転送 | $0.053 | $0.053 | 5 節（全員が `client.rack` を設定したとき） |
| S3（保存と PUT） | $0.006 | $0.006 | 6 節 |
| **小計（NFR-010 の範囲）** | **$0.083** | **$0.076** | |
| NLB の処理のバイト | $0.024 | $0.024 | 7 節 |
| **合計** | **$0.107** | **$0.100** | |

- **NFR-010 は、統合の工程で「NLB を含めて、設計点で書き込み 1 GB あたり $0.11 以下」に改めた（[README.md](README.md) の 3 節。PM・Dev の確認待ち）。** 上の表で u = 40% のとき $0.107、u = 60% のとき $0.100 で届く。元の $0.08 は S2 の目標として残す（NLB を通さない経路、Savings Plans、ディスクレスのトピックで下げる）。
- この表は、スループットで台数が決まるとき（設計点）の値である。パーティションで台数が決まる分の原価は 10 節で出し、パーティション-時の課金で回収する（[ADR-0039](../decisions/0039-jpy-billing-and-free-tier.md)）。
- EC2 の Savings Plans（東京の r8g.4xlarge、1 年・前払いなしで、Compute Savings Plans $0.82373/時（約 28% 引き）、EC2 Instance Savings Plans $0.7521/時（約 34% 引き）。AWS Price List API の `AWSComputeSavingsPlan`、2026-09-27 に確認）で、ブローカーの行が約 $0.003 下がる（u = 40%。EBS は割り引かれない）。
- `client.rack` を設定しない利用者が 20% いると、AZ をまたぐ転送が $0.008 増える（5 節）。
- 下げる手段と効果：

| 手段 | 1 GB あたりの効果 | 代わりに負うもの |
| --- | --- | --- |
| NLB を通さず、Envoy に EIP を直接付ける（[ADR-0044](../decisions/0044-nlb-sni-proxy-and-zonal-hostnames.md) の X の再評価） | −$0.024 | 健全性の確認、zonal shift、排出を自前の DNS で作る |
| ローカルの保持を 3 時間にする | −$0.004（u = 40%） | 2 時間より古い読み取りが S3 から来る |
| ディスクレスのトピック（S2。[ADR-0020](../decisions/0020-diskless-topics-adoption.md)） | AZ をまたぐ複製（$0.04）が消える | 遅延、本家の実装待ち |
| 読み取りのネットワークを利用者に渡す（価格） | 原価は変わらない | PM の判断 |
| EC2 の Savings Plans | ブローカーの行が約 $0.003 下がる（u = 40%） | 1 年の約定 |

## 9. コントローラー

- コントローラーは m8g.xlarge（16 GiB、ヒープ 8 GiB）と gp3 50 GiB（[ADR-0015](../decisions/0015-kraft-dynamic-quorum-and-controller-sizing.md)）。物理クラスタごとに 3 台で月に約 $520。
- 10 万のパーティションの物理クラスタで、スナップショットは約 35 MB の見積もり（[metadata-and-control.md](metadata-and-control.md) の 6.1 節）。ヒープとディスクに十分に収まる。切り替えの時間（目標 5 秒）は 11 節の T2 で測る。

## 10. S1 の台数：パーティションで決まる

### 10.1 台数

| 制約 | 必要なブローカー | 計算 |
| --- | --- | --- |
| スループット（ピーク 2 GB/秒、W = 80） | 27（AZ で揃えて） | 2,000 ÷ 80 ＝ 25 |
| パーティション（複製 60 万、ブローカーあたり 4,000） | 150 | 600,000 ÷ 4,000 |
| 物理クラスタのパーティションの上限（10 万） | 物理クラスタ 2 つ以上（パーティションで） | [ADR-0017](../decisions/0017-metadata-limits-and-snapshots.md) |

- S1 の目標のままでは、**ブローカーはパーティションの数で決まり、スループットの 5 倍以上の台数になる**。1 台あたりの W は平均 5 MB/秒、ピークで約 13 MB/秒で、帯域の大半が余る。
- 構成の例：Standard 3 つの物理クラスタ × 30 台（r8g.4xlarge）、Basic 2 つ × 30 台（m8g.4xlarge）。1 つの物理クラスタで 30 台 × 4,000 ÷ 3 ＝ 4 万のパーティションまでで、ADR-0017 の物理クラスタの上限（10 万）には届かない。
- 月の費用は約 $363,000、書き込み 1 GB あたり約 $0.17（[infrastructure.md](infrastructure.md) の 11.2 節）。このうち、スループットの必要（27 台）を超える約 123 台の分（約 $135,000/月）は、パーティションの数だけのために持つ。これを除くと、書き込み 1 GB あたり約 $0.11 で、改めた NFR-010 に合う。
- **S1 のパーティションの目標（20 万）は変えない。** 台数はこの節のとおりパーティションで決まる前提で計画し、その原価はパーティション-時で回収する（10.2 節）。
- 手段：

| 手段 | 効果 | 確かめること |
| --- | --- | --- |
| ブローカーあたりの複製の上限を 8,000 に上げる | 台数が半分（75）。1 GB あたり約 $0.13 | ADR-0017 の値の見直し。流量の少ない複製が多いときの、ブローカーの起動・回復の時間（[ADR-0011](../decisions/0011-log-recovery-and-broker-replacement.md) の 5 分）、ヒープ、mmap（11 節の T2） |
| パーティションに価格を付ける（**既定案として採った**。10.2・10.3 節） | パーティションで決まる台数の原価を回収する。利用者がパーティションを減らす動機 | 単価と含む数は PM が E11 で確定（[ADR-0039](../decisions/0039-jpy-billing-and-free-tier.md)） |
| Basic の CU のパーティション（100）を下げる | Basic の台数が減る | Confluent の Basic は 30（[multi-tenancy-and-quotas.md](multi-tenancy-and-quotas.md) の 2.3 節） |
| README の S1 のパーティションの目標（20 万）を見直す | — | PM と、S1 の利用者の想定 |

- MSK は、流量の少ないパーティションが多いときに、試験で確かめれば 1 台に多くを詰めてよいとする（[MSK best practices](https://docs.aws.amazon.com/msk/latest/developerguide/bestpractices.html)）。本家の KRaft での上限は未検証（E1 の `load-test-t1-t2` の T2 で測る）。

### 10.2 パーティションの原価とパーティション-時

パーティションで台数が決まるブローカー（W は小さい）の月額を、そのブローカーが持てるパーティション（複製の前）で割る。

| 層 | ブローカー 1 台の月額 | 1 台のパーティション（複製の前） | 1 パーティション-月 | 1 パーティション-時 |
| --- | --- | --- | --- | --- |
| Standard | r8g.4xlarge $830 ＋ EBS 3 TiB 約 $300 ＋ コントローラー・システムの按分 $36 ≒ $1,166 | 4,000 ÷ 3 ≒ 1,333 | 約 $0.87 | 約 $0.0012 |
| Basic | m8g.4xlarge $677 ＋ EBS 3 TiB 約 $300 ＋ 按分 $36 ≒ $1,013 | 約 1,333 | 約 $0.76 | 約 $0.0010 |

- 価格の形（[ADR-0039](../decisions/0039-jpy-billing-and-free-tier.md)。既定案）：論理クラスタの時間ごとに、`1 CU あたりの含む数 × max(時間の CU, 1)` を超えたパーティションを、パーティション-時で課金する。含む数の初期値は Standard 100、Basic 20。
- スループットで決まるブローカー（W = 80、3.2 CU）は 1,333 のパーティションを持てるので、含む数（3.2 CU × 100 ＝ 320）は台数を増やさない。含む数を超えた分だけが、パーティションのための台数を生む。
- S1 の目安（仮定：Standard の論理クラスタ 400・平均 2 CU・12 万のパーティション、Basic 600・平均 1 CU・8 万のパーティション）：含む数は Standard 8 万・Basic 1.2 万で、超える分は Standard 4 万・Basic 6.8 万（計 10.8 万）。

### 10.3 パーティション-時の定価（既定案、2026-09-27）

原価の単価のままでは、パーティションのための台数の原価を回収できない。定価を原価の 1.6 倍以上にする。

| 項目 | Standard | Basic | 計 |
| --- | --- | --- | --- |
| 含む数を超えるパーティション | 40,000 | 68,000 | 108,000 |
| 原価の単価での月の収入（× 730 時間） | 40,000 × $0.0012 × 730 ＝ $35,040 | 68,000 × $0.0010 × 730 ＝ $49,640 | $84,680 |
| 回収したい原価 | | | $135,000（10.1 節の約 123 台） |
| 必要な倍率 | | | $135,000 ÷ $84,680 ＝ 1.59 → **1.6 倍以上** |
| 定価の下限（原価 × 1.6） | $0.00192 | $0.00160 | 収入 $135,488 |
| **定価の既定案（円）** | **0.32 円** | **0.27 円** | |
| 1 ドル 150 円での収入 | 40,000 × 0.32 × 730 ＝ 934.4 万円（$62,293） | 68,000 × 0.27 × 730 ＝ 1,340.3 万円（$89,352） | 2,274.7 万円（$151,645。原価の単価の約 1.8 倍） |

- 円の定価は、原価の 1.6 倍を 1 ドル 150 円で円にし、切り上げて丸めた。1 ドルが約 168 円（2,274.7 万円 ÷ $135,000）を超えると回収が足りなくなるので、E11 の `price-books-and-rating` で、価格の版を改めるときの目安にする。
- 比べる値：本家の旧来の Standard は 500 を超えた分に $0.0015/パーティション-時、Basic は 10 を超えた分に $0.004/パーティション-時だった（[2022-06 の価格のページの写し](http://web.archive.org/web/20220601000000/https://www.confluent.io/confluent-cloud/pricing/)、2026-09-27 に確認）。今の eCKU の形は直接は課金しない（[Billing dimensions](https://docs.confluent.io/cloud/current/billing/billing-dimensions.html)、2026-09-27 に確認）。既定案の Standard（1 ドル 150 円で約 $0.0021）は本家の旧来より高く、Basic（約 $0.0018）は低い。含む数は、本家がクラスタごとの固定（500・10）、本システムが CU に比例（100・20）で、形が違う。
- **PM の確認事項**：定価（Standard 0.32 円・Basic 0.27 円のパーティション-時）と含む数（Standard 100・Basic 20）。含む数を下げれば、定価の倍率を下げられる。

## 11. 負荷試験の計画

環境は dp-verify のアカウント（[infrastructure.md](infrastructure.md) の 1 節）。負荷の生成は、OpenMessaging Benchmark（本家のクライアント）と `kafka-producer-perf-test`・`kafka-consumer-perf-test`。クライアントは本番と同じ経路（NLB と Envoy）を通し、TLS と SASL/PLAIN、名前空間のパッチを有効にする。結果は quality.md と、この文書の値の置き換えに使う。

| # | 試験 | 中身 | 合格の条件 | Epic |
| --- | --- | --- | --- | --- |
| T1 | 1 台の設計点 | r8g.4xlarge・m8g.4xlarge・r8g.2xlarge の 6 台の物理クラスタで、W を上げながら F = 3 を流す | W = 80 で CPU 60% 未満、produce の p99 50ms 以内、送信と EBS が基準の 60% 付近。基準を超えたときの遅延の立ち上がりを記録 | E1 |
| T2 | パーティションの密度 | ブローカーあたり 4,000・8,000・12,000 の複製（流量は小さく）。コントローラーの切り替え、ブローカーの起動、不正な停止からの回復、ヒープ | 切り替え 5 秒以内、起動のメタデータの読み込み 30 秒以内、回復 5 分以内（[ADR-0011](../decisions/0011-log-recovery-and-broker-replacement.md)、[ADR-0017](../decisions/0017-metadata-limits-and-snapshots.md)） | E1 |
| T3 | 物理クラスタの規模 | 30 台で書き込み 2 GB/秒・読み取り 6 GB/秒、4 万のパーティション、1,000 の論理クラスタ相当 | NFR-003・NFR-004・NFR-006。全ての論理クラスタでクォータの中の throttle が 0 | E9 |
| T4 | AZ の喪失 | T3 の負荷のまま 1 つの AZ のブローカー・コントローラー・Envoy を止める | `acks=all` の喪失 0、リーダーの移動 1 分以内（NFR-009）、残りの AZ の送信が基準の 90% 以内 | E9（E3 と一緒に） |
| T5 | 階層型の読み戻し | 1 つの論理クラスタが 7 日分を最初から読む | 他の論理クラスタの p99 が悪くならない（[multi-tenancy-and-quotas.md](multi-tenancy-and-quotas.md) の N2） | E9 |
| T6 | エッジ | Envoy 1 台（c8g.xlarge・2xlarge）の中継の上限、接続の数、新しい接続の頻度。NLB の NLCU の実測 | 1 台の上限と CPU。7 節の値の置き換え | E1・E12 |
| T7 | 拡張 | T3 の負荷のまま、3 台を足して再均衡 | 30 分以内に負荷が平らになる（NFR-007） | E9 |
| T8 | ローリング更新 | T3 の負荷のまま、[ADR-0050](../decisions/0050-rolling-upgrade-gates-and-upstream-tracking.md) の関門でロール | `acks=all` の喪失 0、produce の p99 が 100ms 以内、全体の時間 | E12 |
| T9 | うるさい隣人 | N1〜N10（[multi-tenancy-and-quotas.md](multi-tenancy-and-quotas.md) の 11.3 節） | 同節の条件 | E7 |
| T10 | 長時間 | T3 の 50% の負荷で 72 時間 | ヒープ・ファイル記述子・ディスクの増え方が安定。監査の不一致 0 | E12 |
| T11 | ローカルの保持の効果 | 本番の読み取りの位置の分布（本番のメトリクス）と、3 時間にしたときの S3 の GET と遅延 | 2 時間より古い読み取り 1% 未満なら、短縮を ADR で提案 | E9 |

- 試験の費用：T3・T4・T7・T8 は 30 台の r8g.4xlarge を数日動かす（1 日約 $1,000）。必要な日だけ作り、終わったら消す。
- 試験の負荷は合成のデータだけを使い、本番のデータを使わない。

## 12. 未解決の問い

### 決定（2026-09-27、既定案）

- **設計点**：基準の帯域の 60%。バーストを数えない。
- **型**：Standard は r8g.4xlarge、Basic は m8g.4xlarge、コントローラーは m8g.xlarge、Envoy は c8g.2xlarge（GA は c8g.xlarge）。
- **ブローカーあたりの CU**：Standard 3.2、Basic 13.3。
- **EBS**：設計点の W と 7 時間で容量、型の EBS の基準まででスループット。
- **ローカルの保持**：6 時間のまま。T11 の結果で見直す。
- **NFR-010**：NLB の処理のバイトを原価に含め、設計点で $0.11 以下にする。$0.08 は S2 の目標（PM・Dev の確認待ち）。
- **パーティション**：S1 の目標（20 万）は変えず、台数はパーティションで決まる前提にする。CU に含む数（Standard 100、Basic 20）を超えた分をパーティション-時で課金する。定価は原価の 1.6 倍以上（Standard 0.32 円、Basic 0.27 円。10.3 節）にする（PM・Dev の確認待ち）。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| CPU（TLS、パッチ、要求の数）が W = 80 で 60% 未満か | T1（E1） |
| ブローカーあたりの複製の上限を 8,000 以上にできるか | T2（E1）。ADR-0017 を改める |
| パーティション-時の単価と、CU に含む数 | PM の確認（E11 の `price-books-and-rating`。10.3 節の既定案：原価の 1.6 倍以上、Standard 0.32 円・Basic 0.27 円） |
| NLB を外す経路に替えるか（S2 の $0.08 の目標のため） | 流量が増えたとき（[ADR-0044](../decisions/0044-nlb-sni-proxy-and-zonal-hostnames.md) の X の再評価、[infrastructure.md](infrastructure.md) の 10 節） |
| `segment.ms` の許可の下限（10 分）の PUT の費用 | E9 の実測で。protocol-and-compatibility の許可リストと一緒に |
| 平均の使用率 u の実際の値 | GA の後の 3 か月の実測 |

## 13. quality.md・runbooks・data-model への項目

### quality.md

- 負荷試験 T1〜T11 の結果（この文書の値との差）。
- ブローカーの送信と EBS の、基準の帯域に対する使用率の p95（物理クラスタごと）。60% を超えたブローカーの数。
- 書き込み 1 GB あたりの原価の実測（Cost and Usage Report ÷ 使用量）と、8 節の見積もりの差。
- 同じ AZ から読んだバイトの割合（5 節の前提 80%）。

### runbooks/README.md

- 容量のアラート：ブローカーの送信・EBS が基準の 70% を 1 時間超える（チケット）、85% を 15 分（呼び出し）。物理クラスタの `score` が 0.6 を超える（[ADR-0033](../decisions/0033-logical-cluster-placement.md) の余力の判定）。
- 個別の手順の候補：`capacity-add-brokers.md`（`broker-scale-out.md` と同じもの。control-plane-and-provisioning の提案）。

### data-model

- `pc_capacity_samples`（control-plane-and-provisioning）に、ブローカーの送信・EBS の使用率の p95 と `capacity_cu` を足す提案。
- `instance_profiles`（開発リポジトリの設定。DB ではない）：型ごとの基準の帯域、設計点の W、ブローカーあたりの CU。

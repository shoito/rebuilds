# ML platform: Uber

機械学習の基盤（S2 以降）。ETA の残差を補正するモデル、`block` での需要の予測、特徴量のストア、学習と配信で特徴量をそろえる方法、影の実行を経たモデルの展開を決める。

前提となる決定は、S1 の ETA の補正は偏りの表で行い、機械学習の補正は S1 の計測で NFR-003 に届かなければ前倒しすること（[ADR-0016](../decisions/0016-valhalla-serving-traffic-and-eta-accuracy.md)、[eta-and-routing.md](eta-and-routing.md) の 4.5・6 節）、需要の予測は `block` で行うこと（[ADR-0002](../decisions/0002-hex-grid-geospatial-model.md)）、配車の変更は再生・シミュレーション・影の実行で比べること（[ADR-0015](../decisions/0015-offer-protocol-decision-log-and-replay.md)）、Go のサービスを増やさないこと（[ADR-0001](../decisions/0001-platform-and-stack.md)）、需要に応じた即時の運賃の変動は L9 の結論まで作らないこと（[ADR-0020](../decisions/0020-dynamic-fares-within-authorized-bands.md)）、位置の保持の期間（[ADR-0010](../decisions/0010-location-trails-map-matching-and-retention.md)）。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0035](../decisions/0035-ml-feature-store-and-shadow-rollout.md) | 最初のモデルは勾配ブースティング（LightGBM）にし、ETA の補正は `eta-service`（Go）の中で純粋な Go の評価器で動かす（新しい推論のサービスを熱い経路に入れない）。特徴量は定義を 1 か所に置き、1 つの特徴量は 1 つのパイプラインだけが計算して、オフライン（S3 の Iceberg）とオンライン（Valkey）に同じ値を書く。配信の時に使った特徴量を記録し、次の学習はその記録で行う。展開はオフラインの評価 → 影の実行 7 日 → 配車の再生とシミュレーション → 区域単位のフラグの順で、基準を外れたら自動で戻す。需要の予測は運賃に使わない |

## 1. 目的と範囲

- 扱う：S2 の 2 つのモデル（ETA の残差の補正、需要の予測）、特徴量の定義と計算とストア、学習の環境とモデルの登録、推論の置き場所、学習と配信の食い違いの防ぎ方と監視、影の実行と展開と戻し方、学習のデータのプライバシーと保持。
- 扱わない：ETA の経路のエンジンと偏りの表（[eta-and-routing.md](eta-and-routing.md)）、配車のコストと最適化（[dispatch-and-matching.md](dispatch-and-matching.md)）、運賃の変動（[pricing-and-fares.md](pricing-and-fares.md)）、生の位置と軌跡の保存（[location-ingestion.md](location-ingestion.md)）、フラグと展開の基盤（`delivery.md`）。
- **S1 では作らない。** S1 の計測で NFR-003（迎車の ETA の誤差の中央値 60 秒以内・p90 180 秒以内）に届かなければ、ETA の補正だけを前倒しする。

## 2. 本家の形（確かめたこと）

| 項目 | 本家（公開情報） | この設計 |
| --- | --- | --- |
| 基盤 | Michelangelo は、特徴量のストアをオフライン（HDFS・Hive）とオンライン（Cassandra）に持ち、特徴量の変換を DSL で書いて、学習の時と予測の時に同じ式を使う。当時、約 1 万の特徴量を共有していた（[Meet Michelangelo](https://www.uber.com/us/en/blog/michelangelo-machine-learning-platform/)、2017-09-05） | 変換を 1 か所で定義し、1 つのパイプラインで計算して両方に書く（5 節） |
| 特徴量のストア | 本家の特徴量のストア Palette は、バッチとほぼ即時の特徴量の計算を扱い、都市・ドライバー・乗客の特徴量を持つ（[Palette Meta Store Journey](https://www.uber.com/us/en/blog/palette-meta-store-journey/)、2024-01-18、2026-09-27 に確認）。ほぼ即時の特徴量は Flink の流れの処理で作る（[Building Scalable Streaming Pipelines for Near Real-Time Features](https://www.uber.com/us/en/blog/building-scalable-streaming-pipelines/)）。特徴量の鮮度の持ち方は本家の資料に見当たらない | 鮮度（`computed_at`）を特徴量に持たせる |
| ETA のモデル | 経路のエンジンの ETA の残差を DeepETA で予測して足す（[DeepETA](https://www.uber.com/us/en/blog/deepeta-how-uber-predicts-arrival-times/)、2022-02-10） | 同じ残差の形。モデルは S2 は勾配ブースティング（4 節） |
| 展開の安全 | 400 の用途、ピークで毎秒 1,500 万の予測。影の実行は、利用者の振る舞いを変えずに本番の入力で新しいモデルを確かめる。endpoint の影（交通の割合と検証の論理を用途ごとに決める）と、deployment の影（自動で予測のずれを見る）の 2 つがある。段階的に広げ、失敗の兆しで自動で戻す（[Raising the Bar on ML Model Deployment Safety](https://www.uber.com/us/en/blog/raising-the-bar-on-ml-model-deployment-safety/)、2025-10-30） | 影の実行と段階の展開と自動の戻しを必須にする（7 節） |

いずれも 2026-09-27 に確認。

## 3. 構成

```
             ┌──────── 特徴量の定義（features/ リポジトリ：YAML ＋ SQL）────────┐
             ▼                                                              ▼
 バッチ（Athena・Glue、毎日・毎時）                         ほぼ即時（Managed Service for Apache Flink、Kinesis と SNS を読む）
             │ 同じ値を両方に書く                                            │ 同じ値を両方に書く
             ▼                                                              ▼
   オフライン：S3 Iceberg `features/`（事象の時刻つき）      オンライン：Valkey `feat:{group}:{key}`（TTL、computed_at）
             │                                                              │
             ▼                                                              ▼
   学習（SageMaker の学習ジョブ、Step Functions）             eta-service（Go、モデルを内蔵）／ demand-batch（毎 5 分）
             │                                                              │ 使った特徴量と予測を記録
             ▼                                                              ▼
   モデルの登録（SageMaker Model Registry）── 版を AppConfig で配る ──▶ 配信の記録 S3 `feature-logs/`
```

- 推論は、ETA の補正を `eta-service` の中で行い、需要の予測はバッチで行う。オンラインの推論のサービス（別のプロセス）は、S2 では作らない。
- 学習と登録は SageMaker を使う（料金と日本のリージョンでの機能は **未検証**。E13 の `ml-platform-foundation` の前に確かめる）。

## 4. モデル

### 4.1 ETA の残差の補正

```
eta = route_time + pickup_overhead(point_type) + residual_model(features)   … S2
eta = route_time + pickup_overhead(point_type) + bias(district_cell, hour_of_week) … S1（代わりの経路としても残す）
```

| 項目 | 中身 |
| --- | --- |
| 予測するもの | 迎車の実際の時間 − (`route_time` ＋ `pickup_overhead`)。実際の時間の定義は [eta-and-routing.md](eta-and-routing.md) の 6 節と同じ |
| 学習のデータ | NFR-003 の対象の乗車（受諾から到着まで）。直近 8 週 |
| 特徴量 | `route_time`、経路の距離、右左折の回数（Valhalla の応答）、ドライバーの位置と乗車地の `block` のセル、1 週の中の 5 分の区切り、祝日の印、乗車地の種類、タイルの版、セルの直近 30 分の残差の中央値（ほぼ即時）、セルの空車の台数（`supply-heat`）、ドライバーの直近 7 日の残差の中央値（HMAC の ID で集計） |
| モデル | LightGBM。損失は Huber（遅れと早すぎを分けて評価する。本家の DeepETA と同じ考え方）。出力は ±300 秒に切り詰める |
| 評価 | NFR-003 の指標（`|e|` の中央値と p90）、偏りの符号、迎車の距離の帯と時間帯ごと。偏りの表（S1）と比べる |
| 推論の場所 | `eta-service` の中。純粋な Go の LightGBM の評価器（候補：[dmitryikh/leaves](https://github.com/dmitryikh/leaves)。対応の版と速さは **未検証**）で、モデルの JSON を読み込む |
| 予算 | 1 回の評価 p99 0.5 ms、特徴量の取得（Valkey の 1 回の `MGET`）p99 2 ms。配車の行列（1 回 10 組）でも ETA の期限（400 ms）を食わない |
| 代わり | 特徴量が取れない・古い（`computed_at` が 60 分より前）・モデルの読み込みの失敗では、S1 の偏りの表を使い、応答に `eta_source=bias_table` を付ける |

- 配車の行列にも同じ補正を足す（[eta-and-routing.md](eta-and-routing.md) の 4.1 節）。そのため、モデルの変更は配車の変更でもある（7 節）。

### 4.2 需要の予測

| 項目 | 中身 |
| --- | --- |
| 予測するもの | `block` のセル × 15 分の区切りの配車の依頼の数（成立しなかった依頼も含む）。先の 4 区切り（60 分） |
| 特徴量 | 同じセル・同じ曜日時間帯の過去の数（直近 8 週）、直近 60 分の数、祝日、隣のセルの数、大きな催しの予定（運用が登録。外部のデータの利用の条件は **未検証**）、天気（気象庁のデータの利用の条件は **未検証**）。どちらも E13 の `demand-forecast-block` の前に確かめる |
| モデル | LightGBM（Tweedie 損失）。都市ごとに 1 つ |
| 実行 | 5 分ごとのバッチ。結果を S3 と Valkey `demand:{city}:{block_cell}` に書く |
| 評価 | セルの区切りごとの WAPE。ピークの時間帯と、依頼の多いセルで分けて出す |

- **使い道（S2）**：事業者の管理画面と運用の画面の需要の地図、ドライバーのアプリの「依頼の多い場所」の案内（`district` に丸めて出す）。
- **使わない**：運賃の変動（即時の変動は L9 の結論まで作らない。ADR-0020）、配車のコスト（配車に使うなら、再生とシミュレーションで比べる別の ADR を書く。[ADR-0004](../decisions/0004-batched-dispatch-and-offers.md) の選択肢 3）。
- 表示では、予測の数が 5 未満のセルを「少ない」とまとめ、数を出さない（少ない数が特定の人の行動を表すのを避ける）。

## 5. 特徴量のストア

### 5.1 定義

```yaml
# features/eta/cell_residual_30m.yaml
name: eta.cell_residual_30m
entity: block_cell                # 鍵：`block`
value_type: int32            # 秒
source: stream               # batch | stream（1 つだけ）
pipeline: flink/eta_residuals.sql
window: 30m
freshness_sla: 5m            # これより古ければ使わない
online_ttl: 2h
owner: eta
pii: none                    # none | pseudonymous（HMAC の ID）。raw の位置・ID は定義できない
```

- 定義は `features/` のリポジトリに 1 つずつ置き、CI で型・鍵・`pii` の値を検査する。`entity` に使えるのは、格子のセル（`district`〜`street`）、時刻の区切り、HMAC の ID（90 日ごとに替わる鍵。[ADR-0010](../decisions/0010-location-trails-map-matching-and-retention.md)）だけにする。緯度経度と生の ID を鍵や値にできない。

### 5.2 計算と書き込み

- **1 つの特徴量は 1 つのパイプラインだけが計算する**（バッチかほぼ即時のどちらか）。同じ値を、オフライン（S3 の Iceberg の表、事象の時刻 `event_time` と `computed_at` つき）とオンライン（Valkey、`computed_at` つき）に書く。学習と配信で別々に計算しない。
- 学習の時は、ラベルの時刻より前に `computed_at` がある値だけを結合する（時点を合わせた結合）。未来の値を学習に入れない。
- ほぼ即時のパイプラインは Amazon Managed Service for Apache Flink で、Kinesis の位置の流れと、Trips の事象（SQS から写した Kinesis）を読む（Go のサービスを増やさない）。Flink を選ぶかは、E13 の `feature-pipelines` の前に費用と運用の手間で確かめる（**未検証**）。

### 5.3 配信の記録

- `eta-service` と `demand-batch` は、予測ごとに、使った特徴量の値、モデルの版、予測の値を `feature-logs/`（S3、Firehose）に書く。ETA は 1% を抽出し、NFR-003 の対象の乗車（受諾の時点の ETA）は全件書く。
- **次の学習は、この記録の特徴量で行う**（最初のモデルだけは 5.2 節の時点を合わせた結合で作る）。配信の時の値そのもので学習するので、学習と配信の食い違いが入らない。
- 毎日、記録の特徴量と、オフラインのストアの同じ鍵・同じ時刻の値の分布を比べ、PSI が 0.2 を超えた特徴量を知らせる（食い違いの監視）。

## 6. 学習と登録

- 学習は Step Functions で、データの取り出し → 学習（SageMaker の学習ジョブ）→ オフラインの評価 → 登録の順に、ETA は週 1 回、需要は毎日動かす。
- 同じデータの版・同じ設定・同じ種から、同じモデルができるようにする（配車と同じく再現できること。[AGENTS.md](../../AGENTS.md)）。学習のデータの版（Iceberg のスナップショットの ID）をモデルの登録に残す。
- モデルの登録には、データの版、特徴量の定義の版、評価の結果、影の実行の結果、承認者を残す。本番に出す承認は人が行う（エージェントは評価の報告を作るまで）。

## 7. 展開（影の実行）

| 段 | 中身 | 通る基準（ETA の補正） |
| --- | --- | --- |
| 1. オフラインの評価 | 直近 7 日の対象の乗車で、今のモデル（か偏りの表）と比べる | `|e|` の中央値と p90 が悪くならない。どの距離の帯・時間帯でも中央値が 5% を超えて悪くならない |
| 2. 影の実行 | 本番の `eta-service` で新旧の両方を計算し、今のものだけを返す。両方を記録する。7 日 | 1 と同じ基準を本番の入力で満たす。評価の p99 が予算の中 |
| 3. 配車の再生とシミュレーション | 配車の判断の記録（ETA の値を新しいモデルで置き換え）を再生し、市場のシミュレーションで比べる（ADR-0015） | 二重の割り当て 0 件、成立率 −0.5 ポイント以内、迎車の時間の平均 +3% 以内 |
| 4. 区域の段階の展開 | AppConfig のフラグで、区域の 10% → 50% → 100%、各 2 日以上 | 区域ごとの NFR-003 の指標が今より悪くならない |
| 自動の戻し | 段 4 の間に、1 時間の窓で `|e|` の中央値が 10% 以上悪くなるか、`eta_source=bias_table` の割合が 5% を超えたら、フラグを前のモデルに戻す | — |

- ETA の応答と、配車の判断の記録（`DispatchBatchRecord`）に、モデルの版を残す。再生で同じ判断を再現するため。
- 需要の予測は、使い道が表示だけなので、段 1 と段 2（7 日の影の記録で WAPE を比べる）だけで出してよい。

## 8. 失敗のしかた

| 失敗 | 起きること | 抑え方 |
| --- | --- | --- |
| オンラインの特徴量が古い・欠ける（Flink の停止、Valkey の障害） | 補正が誤る | `freshness_sla` を過ぎた特徴量は使わず、偏りの表に落ちる |
| モデルのファイルが壊れている・読めない | 補正ができない | 読み込みの時に検査の入力で予測を確かめてから切り替える。失敗なら前の版のまま |
| 学習のデータの偏り（障害の日、大きな催し） | モデルが悪くなる | 障害の時間帯を学習から除く印（運用が登録）。段 1〜3 で止まる |
| 世の中の変化（道路の工事、新しい駅） | 残差が系統的にずれる | 毎日の偏りの監視。S1 の偏りの表も毎日作り直して、比べる基準に残す |
| 需要の予測の外れ | 表示の地図が外れる | 表示だけなので、配車と運賃には影響しない |

## 9. セキュリティとプライバシー

- 学習と特徴量のデータは、位置を `block`〜`street` に丸め、ドライバーの ID は HMAC に置き換えた写し（ADR-0010 の分析の写し）だけを使う。生の `loc-raw` と乗車の軌跡を、学習の環境から読めない。
- 学習のデータの保持は、元のデータの保持（生の位置 30 日、乗車の軌跡 1 年。L4 の結論で置き換える）を超えない。Iceberg のスナップショットも期限で消す。モデルの中に個人を特定できる値が残らないよう、特徴量の `pii` の検査（5.1 節）で入口を守る。
- 乗客の個人の特徴量（その人の過去の乗車など）は S2 で作らない。作るときは、利用目的の通知の範囲を法務に確かめる（L4）。
- 需要の予測は、事業者ごとに分けて見せない（都市全体の予測を同じく見せる）。事業者の運賃や稼働の情報を、予測を通じて他の事業者に渡さない（L9）。
- テストでは、合成の乗車と軌跡だけを使う（[AGENTS.md](../../AGENTS.md)）。

## 10. テスト

- **PROP-ML-001（時点の結合）**：任意の特徴量とラベルの列で、学習のデータに入る特徴量の `computed_at` は、ラベルの時刻より前。
- **PROP-ML-002（代わりの経路）**：特徴量の欠け・古さ・モデルの読み込みの失敗を任意に注入しても、`eta-service` は期限の中で値を返し、`eta_source` が正しい。
- **PROP-ML-003（再現）**：同じデータの版・設定・種から、同じモデルのファイル（ハッシュ）ができる。
- **PROP-ML-004（Go の評価器の一致）**：無作為の入力 10 万件で、Go の評価器と LightGBM の Python の予測の差が 1e-6 秒以下。
- 特徴量の定義の検査：`entity` と `pii` の規則、`freshness_sla` と `online_ttl` の関係。
- 負荷：`eta-service` に補正を入れた状態で、配車の行列の p99 が ETA の期限（400 ms）の予算を崩さない。

## 11. Story の候補

S2 以降の Story で、Epic は E13（機械学習。[roadmap.md](../roadmap.md)）。S1 の計測で NFR-003 に届かなければ、ETA の補正の Story（`ml-platform-foundation` の最小の部分、`eta-residual-model`、`eta-model-serving`、`eta-model-shadow-rollout`）だけを前倒しする。

| Epic | Story | 中身 |
| --- | --- | --- |
| E13 | `ml-platform-foundation` | S3 の Iceberg、SageMaker の学習と登録、Step Functions、権限（3・6 節） |
| E13 | `feature-registry` | `features/` のリポジトリ、定義の検査（5.1 節） |
| E13 | `feature-pipelines` | バッチと Flink のパイプライン、両方への書き込み（5.2 節、PROP-ML-001） |
| E13 | `feature-logging-and-skew` | 配信の記録と PSI の監視（5.3 節） |
| E13 | `eta-residual-model` | 4.1 節のモデル、評価、Go の評価器（PROP-ML-004） |
| E13 | `eta-model-serving` | `eta-service` への組み込み、代わりの経路、版の記録（PROP-ML-002） |
| E13 | `eta-model-shadow-rollout` | 7 節の段と自動の戻し（配車の再生・シミュレーションと一緒に） |
| E13 | `demand-forecast-block` | 4.2 節のモデルとバッチ |
| E13 | `operator-demand-map` | 事業者の管理画面の需要の地図（5 未満のまとめ） |
| E13 | `driver-demand-hints` | ドライバーのアプリの「依頼の多い場所」（`district`） |

## 12. 未解決の問い

### 決定

2026-09-27、既定案。

- **時期**：S2。S1 で NFR-003 に届かなければ ETA の補正だけを前倒し。
- **モデル**：LightGBM。ETA は Huber、需要は Tweedie。
- **推論**：ETA は `eta-service` の中の純粋な Go の評価器。別の推論のサービスを熱い経路に入れない。需要は 5 分ごとのバッチ。
- **特徴量**：1 つの特徴量は 1 つのパイプライン。オフラインは S3 の Iceberg、オンラインは Valkey。鍵は格子のセルと HMAC の ID だけ。
- **食い違い**：配信の記録で次の学習を行い、PSI で監視する。
- **展開**：オフライン → 影 7 日 → 配車の再生とシミュレーション → 区域の段階。自動の戻し。
- **需要の予測の使い道**：表示と案内だけ。運賃と配車には使わない。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| S1 で NFR-003 に届くか（前倒しの判断） | S1 の運用の 4 週の計測 |
| SageMaker と Managed Service for Apache Flink の費用と運用 | S2 の着手の前に試算 |
| 純粋な Go の LightGBM の評価器の対応の版と速さ | 前倒しを決めたら最初に PoC |
| 天気・催しの外部のデータの利用の条件 | 需要の予測の着手の前に確かめる |
| 深層学習（DeepETA の形）に移るか | 勾配ブースティングで NFR-003 の目標を下げる余地がなくなったら |
| 需要の予測を配車（空車の誘導、コスト）に使うか | 別の ADR で。再生とシミュレーションの結果を添える |
| 需要の予測を変動運賃に使うか（L9） | 法務の結論の後 |
| 学習のデータの保持と利用目的（L4） | 法務の確認待ち |

## 13. quality.md・runbooks・data-model への項目

### quality.md

- ETA のモデルの版ごとの NFR-003 の指標（`|e|` の中央値・p90、偏り）と、偏りの表との差。
- `eta_source` の内訳（`model`・`bias_table`・`fallback`）の割合。
- 特徴量の鮮度（`computed_at` の遅れ）の p95、`freshness_sla` を過ぎた割合。
- 配信の記録とオフラインのストアの PSI（特徴量ごと）。
- 需要の予測の WAPE（都市・時間帯ごと）。
- 影の実行と段階の展開の結果、自動の戻しの回数。

### runbooks

- `eta-model-rollback.md`：ETA のモデルを前の版か偏りの表に戻す手順（AppConfig のフラグ）と、戻した後の確かめ。
- `feature-pipeline-stale.md`：Flink やバッチが止まり特徴量が古くなったときの確かめ方と、再開・埋め戻し。
- `feature-skew-alert.md`：PSI の警告のときの切り分け（定義の変更、元のデータの変化、パイプラインの誤り）。
- `ml-training-failure.md`：学習の失敗・評価の不合格のときの確かめ方（前のモデルのまま動くことの確認）。

### data-model（索引への追加の提案）

| 置き場所 | 中身 |
| --- | --- |
| リポジトリ `features/`（YAML ＋ SQL） | 5.1 節の特徴量の定義 |
| S3 Iceberg `features/<group>/`（`entity_key`、`event_time`、`computed_at`、値） | オフラインのストア。元のデータの保持を超えない |
| Valkey `feat:{group}:{key}`（値、`computed_at`、TTL） | オンラインのストア。正本ではない |
| S3 `feature-logs/`（Parquet：`request_id`、`model_version`、特徴量、予測、`eta_source`） | 5.3 節。90 日（既定。法務の確認待ち（L4）。[security.md](security.md) の 7.2 節） |
| Valkey `demand:{city}:{block_cell}`、S3 `demand-forecasts/` | 4.2 節 |
| SageMaker Model Registry（モデルの版、データの版、特徴量の定義の版、評価、承認者） | 6 節 |
| AppConfig `eta_model`（区域ごとのモデルの版と割合） | 7 節 |

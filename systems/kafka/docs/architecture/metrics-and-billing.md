# Metrics and billing: Kafka

容量の単位（CU）の定義、使用量の計測と経路、テナント向けのメトリクスの API、円建ての請求と請求書、無料の枠、費用の上限の設計。この文書で決めたことは [ADR-0037](../decisions/0037-capacity-unit-definition.md)（CU）、[ADR-0038](../decisions/0038-usage-metering-and-metrics-api.md)（計測とメトリクスの API）、[ADR-0039](../decisions/0039-jpy-billing-and-free-tier.md)（請求と無料の枠）にある。

本家（Confluent Cloud）の振る舞いは、2026-09-27 に公式の文書で確かめた。確かめられなかったものは「未検証」と書く。要件 ID は、E11 の各変更の `spec.md` に移すときに振る。

## 1. 目的と範囲

- 論理クラスタの容量を 1 つの単位（CU）で表し、クォータ（上限）と請求（使った分）の両方に使う。
- 使った分を、漏れなく、二重に数えずに計り、円建ての請求書にする。
- テナントが、自分の論理クラスタのスループット、保持の量、接続、遅れを、API で取れる。

範囲に入れないもの：

- クォータの掛け方と、ブローカーごとの配分。multi-tenancy-and-quotas の領域（[multi-tenancy-and-quotas.md](multi-tenancy-and-quotas.md)）。
- 運用のためのメトリクス（ブローカーの JMX など）とアラート。observability の領域。
- 原価の見積もり（NFR-010）。capacity の領域。
- 価格の値そのもの。PM が決める（7.2 節は形だけを決める）。

## 2. 本家の形（確かめたこと）

### 2.1 容量の単位と請求

- Confluent Cloud の eCKU は、Basic・Standard・Enterprise・Freight のクラスタの容量の単位で、1 時間の中で使った分だけを払い、上限まで伸びる。**1 時間の中の最大の eCKU** を請求する。何か使えば最小の容量が掛かり、すべての次元で使用が 0 なら払わない（[Billing dimensions](https://docs.confluent.io/cloud/current/billing/billing-dimensions.html)）。
- 1 eCKU あたりの上限（[Cluster types](https://docs.confluent.io/cloud/current/clusters/cluster-types.html)）：

| 次元 | Basic | Standard |
| --- | --- | --- |
| 書き込み | 5 MB/秒 | 25 MB/秒 |
| 読み取り | 15 MB/秒 | 75 MB/秒 |
| パーティション | 30 | 250 |
| 接続 | 20 | 1,000 |
| 接続の試み | 5 回/秒 | 50 回/秒 |
| 要求 | 100 回/秒 | 1,500 回/秒 |
| 最大の eCKU | 50 | 10 |

- 請求の次元は、eCKU、書き込み・読み取りの GB、保存の GB。パーティションには直接は課金しない（ただし eCKU の消費に効く）。2024-04-16 より前の旧来の Basic・Standard は、クラスタに含む数（Basic 10、Standard 500）を超えたパーティションに課金していた。単価は、Basic が 10 を超えた分に $0.004/パーティション-時、Standard が 500 を超えた分に $0.0015/パーティション-時（[2022-06 の価格のページの写し](http://web.archive.org/web/20220601000000/https://www.confluent.io/confluent-cloud/pricing/)、2026-09-27 に確認）。1 時間ごとに積み上げ、1 時間未満は 1 時間とし、UTC で計算し、翌月の初めに請求書を出す（[Billing overview](https://docs.confluent.io/cloud/current/billing/overview.html)）。
- 価格（[Pricing](https://www.confluent.io/confluent-cloud/pricing/)）：Basic は最初の eCKU が無料で、以降 $0.14/時、書き込み・読み取り $0.05/GB、保存 $0.08/GB-月。Standard は $0.75/eCKU-時、書き込み・読み取り $0.035〜0.050/GB、保存 $0.08/GB-月。保存は「複製の後の量」で数える（複製 3 で、書いた量のおおむね 3 倍。[Billing dimensions](https://docs.confluent.io/cloud/current/billing/billing-dimensions.html)、2026-09-27 に確認）。価格のページの「複製の前」の注記は、Freight の表に付いたものと読める。本システムは保存を複製の前で数える（7.2 節）ので、比べるときは本家の保存の単価を 3 倍して読む。
- 新しい利用者には $400 の無料のクレジットがある（Billing overview）。

### 2.2 メトリクスの API

- Metrics API は v2。`POST /v2/metrics/{dataset}/query`、`/descriptors`、Prometheus の形の `/export` を持つ（[Metrics API reference](https://api.telemetry.confluent.cloud/docs)）。
- 粒度は `PT1M`〜`P1D` と `ALL`。`PT1M` は 6 時間までの区間。データは発生から 3 分以内に問い合わせられる（同上）。
- 上限：IP ごとに毎分 300 回。`/export` は資源・主体ごとに毎時 160 回で、1 分に 1 回までの取得を勧める（同上）。
- メトリクスの例：`received_bytes`、`sent_bytes`、`retained_bytes`、`partition_count`、`active_connection_count`、`request_count`、`consumer_lag_offsets`（同上）。
- 使うには、管理の API キーと MetricsViewer のロールが要る（[Metrics API](https://docs.confluent.io/cloud/current/monitoring/metrics-api.html)）。
- 保持は 7 日。区間の上限は `PT1M` で 6 時間、`PT5M` で 1 日、`PT15M` で 4 日、`PT30M` で 7 日（[Metrics FAQ](https://docs.confluent.io/cloud/current/monitoring/monitor-faq.html)、2026-09-27 に確認）。

## 3. CU（容量の単位）

### 3.1 定義

CU は、層ごとの「1 単位の容量」の組である。[multi-tenancy-and-quotas.md](multi-tenancy-and-quotas.md) の 6 節の上限の表と同じ値を正本としてここに置く（[ADR-0037](../decisions/0037-capacity-unit-definition.md)）。

| 次元 | Basic の 1 CU | Standard の 1 CU | 数え方（1 分ごと） |
| --- | --- | --- | --- |
| 書き込み | 5 MB/秒 | 25 MB/秒 | 1 分の produce のバイト数 ÷ 60 |
| 読み取り | 15 MB/秒 | 75 MB/秒 | 1 分の fetch の応答のバイト数 ÷ 60（コンシューマーへの分だけ） |
| パーティション（複製の前） | 100 | 250 | その分の最大の数。**上限（クォータ）と配置にだけ使い、請求の CU には入れない**（3.2 節） |
| 接続 | 100 | 1,000 | その分の最大の同時の数 |
| 接続の試み | 10 回/秒 | 50 回/秒 | 1 分の新しい接続の数 ÷ 60 |
| 要求 | 400 回/秒 | 1,500 回/秒 | 1 分の要求の数 ÷ 60 |
| 最大の CU | 5 | 10 | — |

- Standard の 1 CU は、Confluent の Standard の eCKU と同じ値にした（2.1 節）。multi-tenancy-and-quotas の 6 節の Standard の列と一致する。
- Basic は、multi-tenancy-and-quotas の 6 節で「固定」の上限（書き込み 25 MB/秒、読み取り 75 MB/秒、パーティション 500、接続 500、接続の試み 毎秒 50）を持つ。これを 5 つの Basic CU に分けた。上限（クォータ）は 5 CU で固定のまま、請求は使った分（1〜5 CU）にする。
- Basic の要求の 1 CU（400 回/秒）は、multi-tenancy-and-quotas の Basic の要求の処理時間（100%）を、平均 0.5 ms の要求で割った 2,000 回/秒の 1/5 である。Confluent の Basic（100 回/秒）より多い。未検証（E7 の `noisy-neighbor-suite` の負荷試験で見直す）。
- **要求のクォータは処理時間（`request_percentage`）で掛け、説明と請求は「毎秒の要求の数」で行う。** 利用者に処理時間は見えにくいので、Confluent と同じく要求の数で示す（multi-tenancy-and-quotas の 12 節の持ち越しへの答え）。

### 3.2 1 時間の CU

```
分ごとの CU(m)  = max over 次元 d（パーティションを除く 5 つ）of ceil( 使用量(m, d) / 1 CU の値(d) )
時間ごとの CU(h) = max over その時間の分 m of CU(m)
ただし、その時間の書き込み・読み取り・要求・接続がすべて 0 なら CU(h) = 0
パーティション-時(h) = max(0, その時間の最大のパーティションの数 − 1 CU あたりの含む数 × max(CU(h), 1))
```

- 1 時間の中の最大を請求する（Confluent と同じ）。
- パーティションだけがある（トラフィックも接続もない）時間は 0 CU にする。開発で作って放っておいた論理クラスタに、容量の課金をし続けないため。Confluent は、パーティションが 1 つでもあれば最小の eCKU を課金し、パーティションもトピックもないときだけ 0 にする（[Billing dimensions](https://docs.confluent.io/cloud/current/billing/billing-dimensions.html)、2026-09-27 に確認）。本システムは、この時間の原価を保存と、含む数を超えたパーティション-時で回収する。
- **パーティション**は、請求の CU から外し、CU に含む数を超えた分をパーティション-時で課金する（統合の工程の既定案。[ADR-0037](../decisions/0037-capacity-unit-definition.md)・[ADR-0039](../decisions/0039-jpy-billing-and-free-tier.md) の改定。PM・Dev の確認待ち）。1 CU あたりの含む数は Standard 100、Basic 20（初期値）。0 CU の時間も 1 CU 分は含む。パーティションで台数が決まるブローカーの原価を回収するため（[capacity.md](capacity.md) の 10 節）。
- 内部の主体の要求（エージェント、合成の監視、複製）は数えない。throttle された要求は数える（受け付けた要求だから）。
- CU は、テナントの上限（`max_cu`）を超えない。クォータで絞られるので、使用量が上限を超えることはほぼないが、分の平均の揺れで超えたら上限で切る。

### 3.3 例

| 時刻 | 書き込み | 読み取り | 接続 | パーティション | 分の CU（Standard） |
| --- | --- | --- | --- | --- | --- |
| 10:00 | 12 MB/秒 | 30 MB/秒 | 300 | 400 | max(1, 1, 1) = 1（パーティションは CU に入れない） |
| 10:17 | 60 MB/秒 | 200 MB/秒 | 900 | 400 | max(3, 3, 1) = 3 |
| 10:45 | 0 | 0 | 0 | 400 | 0 |
| 時間 | | | | | **3 CU**。パーティション-時は 400 − 100 × 3 ＝ **100** |

## 4. 計測（ブローカーでの数え方）

### 4.1 数える場所

| 次元 | 場所 | 備考 |
| --- | --- | --- |
| 書き込みのバイト | 名前空間のパッチの出口（Produce の応答を返す前）。成功したパーティションのレコードのバッチの大きさ（圧縮された、受け取ったままのバイト） | 失敗した produce は数えない。冪等なプロデューサーの重複（本家が捨てたもの）は数えない |
| 読み取りのバイト | Fetch の応答のレコードの部分の大きさ | フォロワーの fetch（複製）は数えない。fetch-from-follower で、どのブローカーが返しても数える |
| 要求 | 要求ごと | ApiVersions と SASL の要求を含む |
| 接続・接続の試み | 資格情報のコールバック（認証の成功で論理クラスタが決まる） | 認証の前に失敗した接続は、どのテナントにも数えない |
| パーティション | KRaft の写し（エージェント） | 複製の前 |
| 保持の量 | エージェントが 5 分ごと | 4.2 節 |
| 認証の成功（キーごと） | 資格情報のコールバック | 最終の使用の時刻（[security-and-acls.md](security-and-acls.md) の 3.5 節） |
| クライアントの版ごとの接続 | ApiVersions の `client_software_name`・版 | [protocol-and-compatibility.md](protocol-and-compatibility.md) の 8.3 節 |

- クォータの経路（`__<brand>_quota_usage`。[multi-tenancy-and-quotas.md](multi-tenancy-and-quotas.md) の 7 節）とは別に数える。クォータの経路は 5 秒の窓の速さで、配分のための近似で足りる。請求は、累計の正確な数が要る。
- ブローカーは、テナント×分ごとの数を、内部のトピック `__<brand>_usage` に書く。

```
鍵：(logical_cluster_id, broker_id)
値：{ minute: "2026-09-27T01:23Z", broker_incarnation: <起動ごとの UUID>,
      produce_bytes, fetch_bytes, requests, max_connections, connection_attempts,
      auth_success_by_key: {key_id: count}, client_versions: {...} }
```

- 分ごとの数は、ブローカーのメモリーに持ち、分の終わりに書く。ブローカーが落ちると、その分の途中までの数を失う。失う分は利用者に有利な側（少なく数える）で、1 回の停止で最大 1 分×そのブローカーの分。
- `(logical_cluster_id, broker_id, broker_incarnation, minute)` で一意にし、同じ記録を 2 回受けても 1 回と数える。

### 4.2 保持の量

- 論理のログの大きさ ＝ S3 の有効なセグメントの大きさの合計 ＋ ローカルのうち S3 に上がっていない部分（リーダーの複製だけ）。複製の前の 1 つ分の量にする。
- S3 の分は、RLMM のスナップショット（[tiered-and-object-storage.md](tiered-and-object-storage.md) の 6.5 節）と、包む層のテナントごとの計数（同 5.1 節）から出す。ローカルの分は、リーダーのログの大きさから、S3 に上がった分を引く。精度は E11 の `tiered-usage-metering` で確かめる（未検証）。
- 5 分ごとの値の、1 時間の平均を「GB-時」にする。月の「GB-月」は、GB-時の合計 ÷ その月の時間の数。
- 圧縮のトピックは、ローカルの大きさ（リーダー）をそのまま使う（S3 に上げないため。tiered-and-object-storage の 7 節）。

## 5. 使用量の経路

```
ブローカー ─▶ __<brand>_usage（物理クラスタの内部のトピック、保持 3 日）
               └─▶ エージェント：分ごと・論理クラスタごとに合わせ、保持の量・パーティションの数を足す
                     └─▶ Firehose ─▶ S3（usage/raw/、Parquet、日付のパーティション）   ← 請求の元の記録
                                       └─▶ 制御面の usage：1 時間ごと
                                             ├─ usage_hourly（Aurora）：時間の CU、GB、GB-時
                                             ├─ 最終の使用の時刻（api_keys）
                                             └─ 配置の得点（control-plane-and-provisioning の 10.2 節）
```

- 生の記録（分ごと）は S3 に置き、Athena で調べられるようにする。Aurora には時間ごとの集計だけを置く（S1 で 1 か月に約 1,000 × 720 × 8 の行）。
- 時間の締め：時間の終わりから 2 時間後に、その時間の集計を確定する。確定の後に届いた分は、月の締め（7.5 節）の前なら、その時間を集計し直す（集計は冪等で、生の記録から何度でも作り直せる）。月の締めの後に届いた分は、翌月の調整の行にする。
- 照合：物理クラスタ×時間ごとに、テナントの書き込みのバイトの合計と、ブローカー全体の書き込み（本家のメトリクス `BytesInPerSec` の合計から、内部の主体の分を引いたもの）を比べる。1% を超えて違えば、アラートを出し、その時間の請求を保留にする。
- エージェントの停止の間、`__<brand>_usage` の保持（3 日）の中なら、再開の後に取りこぼしなく送る。3 日を超える停止は、runbook で扱う。
- 生の記録の保持：請求の根拠として 10 年（帳簿の保存の期間。経理・法務の確認待ち）。

## 6. メトリクスの API

### 6.1 経路

```
ブローカー（テナント×トピックのカウンター、名前空間のパッチの出口）
エージェント（遅れ、パーティションの数、保持の量）
   └─▶ OpenTelemetry のコレクター ─▶ AMP（テナントのメトリクス専用のワークスペース）
管理 API /v1/metrics/* ─▶ 問い合わせの組み立て（テナントの条件を必ず付ける）─▶ AMP
```

- 運用のメトリクス（observability の領域）とは、AMP のワークスペースを分ける。テナントの API から、運用のメトリクスに届かないようにする。
- 問い合わせは、利用者の文字列を PromQL として受けない。JSON の問い合わせ（6.2 節）を、サーバーが PromQL に組み立て、`logical_cluster_id="<主体の論理クラスタ>"` の条件を必ず付ける。利用者の絞り込みの値は、許した文字（トピックの名前の文字）だけにし、エスケープする。
- 遅れは、[consumer-groups.md](consumer-groups.md) の 8 節のとおり、エージェントが 60 秒ごとに計算する。グループ×トピックの合計と最大を保存し、パーティションごとの値は問い合わせのときに計算して返す（保存しない）。
- ラベルの数を抑える：パーティションのラベルは保存しない。トピックとグループのラベルは持つ。論理クラスタあたりのトピック×メトリクスの系列の数に上限（10,000）を置き、超えたらトピックの内訳を「上位 1,000 とその他」にまとめる。
- KIP-714（クライアントのテレメトリー）は MVP で使わない（[protocol-and-compatibility.md](protocol-and-compatibility.md) の 14 節の決定に合わせる）。S2 で、クライアント側の遅延などを見せたい需要があれば、ADR を起こす。

### 6.2 API

| エンドポイント | 中身 |
| --- | --- |
| `GET /v1/metrics/descriptors` | メトリクスの一覧、説明、単位、ラベル |
| `POST /v1/metrics/query` | 時系列の問い合わせ |
| `GET /v1/metrics/export?cluster=lc-...` | Prometheus の形。系列ごとの最新の 1 点。1 分に 1 回までの取得を想定 |

```json
POST /v1/metrics/query
{
  "metric": "received_bytes",
  "cluster": "lc-7k2m9q",
  "aggregation": "sum",
  "group_by": ["topic"],
  "filter": { "topic": ["orders", "payments"] },
  "granularity": "PT1M",
  "interval": "2026-09-27T00:00:00Z/2026-09-27T06:00:00Z",
  "limit": 100
}
```

| メトリクス | 単位 | ラベル |
| --- | --- | --- |
| `received_bytes`、`sent_bytes` | バイト | `topic` |
| `received_records`、`sent_records` | 件 | `topic` |
| `request_count` | 件 | `type`（API の名前） |
| `active_connection_count` | 数 | — |
| `connection_attempt_count` | 件 | — |
| `partition_count` | 数 | — |
| `retained_bytes` | バイト | `topic` |
| `consumer_lag_offsets` | オフセット | `group`、`topic`（`partition` は問い合わせのときだけ） |
| `consumer_lag_lso_gap_offsets` | オフセット | `group`、`topic`（`read_committed` の説明用。consumer-groups の 8 節） |
| `throttle_time_ms` | ミリ秒 | `type`（`produce`・`fetch`・`request`） |
| `cu_usage` | CU | `dimension`（3.1 節の次元） |
| `quota_limit` | 次元ごとの単位 | `dimension`（クォータの値。AlterClientQuotas を拒否する代わり。protocol-and-compatibility の 4 節） |
| `client_connections` | 数 | `client_software_name`、`client_software_version` |

- メトリクスの名前は Confluent に寄せる（`received_bytes` など）。名前に本家の名前やドメイン（`io.confluent...`）を含めない。
- 粒度：`PT1M`（区間は 6 時間まで）、`PT5M`（1 日まで）、`PT1H`（31 日まで）、`P1D`。保持は 1 分の粒度で 14 日、1 時間の粒度で 13 か月。AMP には間引きの機能がなく、保持はワークスペースごとに 1 つ（既定 150 日、1〜1,095 日。1 回の問い合わせの区間は 95 日まで）である（[AMP の保持](https://docs.aws.amazon.com/prometheus/latest/userguide/AMP-workspace-configuration.html)、[AMP quotas](https://docs.aws.amazon.com/prometheus/latest/userguide/AMP_quotas.html)、2026-09-27 に確認）。そこで、テナントの AMP の保持を 14 日にし、1 時間ごとのジョブが直前の 1 時間を `PT1H` で集計して S3 の `metrics/hourly/`（Parquet）に置く。14 日より古い `PT1H`・`P1D` の問い合わせは、そこから返す（既定案。E11 の `metrics-api`）。
- データは、発生から 3 分以内（p99）に問い合わせられる（Confluent と同じ目標）。

### 6.3 認可と上限

- 主体：管理のキーかセッション。ロールは MetricsViewer（組織の全論理クラスタ）、Operator・ClusterAdmin（その論理クラスタ）（[security-and-acls.md](security-and-acls.md) の 5.6 節）。
- 上限：組織ごとに毎分 300 回（query）、`export` は論理クラスタ×主体ごとに毎時 60 回。429 で返す（[console-and-api.md](console-and-api.md) の 3.9 節）。
- 1 回の問い合わせの結果は 10,000 点まで。超えたら 400（`result_too_large`）。

## 7. 請求

### 7.1 本家の形

2.1 節のとおり。Confluent は USD で、UTC で計算する。本システムは日本の利用者に向け、円建てで、日本の時刻（JST）で計算する（[ADR-0039](../decisions/0039-jpy-billing-and-free-tier.md)）。

### 7.2 価格の形

| 行 | 単位 | 層 | 備考 |
| --- | --- | --- | --- |
| 容量 | CU-時 | Basic・Standard で別の単価 | Basic は組織の最初の 1 CU が無料（7.4 節） |
| 書き込み | GB（複製の前） | 同上 | |
| 読み取り | GB | 同上 | |
| 保存 | GB-月（複製の前、S3 とローカルの合計） | 同上 | |
| 大阪への写し | GB（写した量） | Standard | 論理クラスタごとに選ぶ。既定は無効（[tiered-and-object-storage.md](tiered-and-object-storage.md) の 6.6 節） |
| パーティション | パーティション-時（CU に含む数を超えた分） | Basic・Standard で別の単価 | 3.2 節。原価の目安は Standard 約 $0.0012、Basic 約 $0.0010 の 1 パーティション-時。定価は原価の 1.6 倍以上で、既定案は Standard 0.32 円・Basic 0.27 円（[capacity.md](capacity.md) の 10.2・10.3 節。PM の確認事項） |
| ディスクレスのトピック（S2） | 別の単価 | — | tiered-and-object-storage の 8 節 |

- 単価は円で定める。ドルの価格を為替で換算しない（為替で毎月の請求が揺れないように）。
- 単価は `price_books`（効力の開始日を持つ版）に置く。値上げは 30 日前に知らせ、効力の開始日から適用する。
- 単価は、小数（1 円未満）を許す（例：1 GB あたり 5.5 円）。

### 7.3 計算（rating）

```
rated_usage(org, lc, 時間, 行) = 数量 × 単価（numeric(20,6) の円）
月の行の金額 = Σ rated_usage（行ごと・論理クラスタごと）を 1 円未満切り捨て
```

- 時間ごとに `rated_usage` を作り、「今月の見込み」として 1 時間ごとにコンソールに出す。
- 月の締めで、論理クラスタ×行ごとに合計し、1 円未満を切り捨てる（利用者に有利な側）。
- 無料の枠とクレジットを引いてから、消費税を計算する（7.5 節）。

### 7.4 無料の枠

| 項目 | 値 | 条件 |
| --- | --- | --- |
| Basic の容量 | 組織ごとに最初の 1 CU-時と、それに含むパーティション（20）を無料（1 時間ごと） | 組織の Basic の論理クラスタのうち 1 つだけ（最も古いもの） |
| 書き込み | 月 10 GB | 組織ごと。Basic だけ |
| 読み取り | 月 30 GB | 同上 |
| 保存 | 月 5 GB-月 | 同上 |
| 支払いの方法がない組織 | Basic の論理クラスタ 1 つ、`max_cu = 1`、無料の枠の中だけ | 7.4.1 |

- Confluent の Basic は最初の eCKU が無料だが、書き込み・読み取り・保存には課金する（2.1 節）。本システムは、支払いの方法を登録せずに試せるよう、小さな量の枠を足す（SC-3 の「登録から 5 分」のため）。
- 値は PM の承認で確定する（E11 の `free-tier`）。

#### 7.4.1 支払いの方法がない組織

- 論理クラスタは Basic の 1 つだけ、`max_cu = 1`（書き込み 5 MB/秒）。パーティションは含む数（20）まで。
- 月の無料の枠を超えたら、コンソールとメールで支払いの方法の登録を求める。登録がないまま 7 日たったら、その月の残りの間、produce をクォータで最小にする（fetch は続ける。データを取り出せるように）。
- 保存の枠を超えないよう、トピックの `retention.bytes` の既定を小さく（パーティションあたり 1 GiB）する。
- 悪用を防ぐ：組織の作成は確認済みのメールアドレスだけ。利用者あたりの組織は 3 つまで。

### 7.5 請求書

- 締め：JST の月末。翌月の 3 日（JST）までに請求書を確定する（遅れて届いた使用量を 2 日待つ）。
- 形：適格請求書（インボイス制度）の記載事項（登録番号、取引の年月日、内容、税率ごとの合計と消費税額、宛名）を持つ PDF と、管理 API の JSON。登録番号は、会社の適格請求書発行事業者の登録の後に入れる（経理の確認待ち）。
- 消費税：10%。**1 つの請求書につき、税率ごとに 1 回だけ端数を処理する**（行ごとに税額を計算して足さない）。端数の処理は切り捨て。国税庁は、1 つの適格請求書につき税率ごとに 1 回の端数処理を求め、方法（切り上げ・切り捨て・四捨五入）は任意とする（[国税庁 Q&A 問 57](https://www.nta.go.jp/taxes/shiraberu/zeimokubetsu/shohi/keigenzeiritsu/pdf/qa/57.pdf)、2026-09-27 に確認）。
- クレジット（販促、SLA の返金）は、税抜きの合計から引く（値引き）。どの値引きが課税の対象を減らすかの扱いは、経理の確認待ち。
- 海外の法人の利用者への消費税の扱い（電気通信利用役務の提供の区分）は、法務・税務の確認待ち。
- 支払い：カード（請求書の確定のときに引き落とす）と、銀行振込（請求書払い。Standard で、与信の審査の後）。決済の代行の事業者の選定は E11 で行う。カードの番号は当社で持たない（決済の代行のトークンだけ）。

```
invoice
  id, organization_id, period (2026-09), status (draft | finalized | paid | overdue | void),
  subtotal_jpy, credits_jpy, taxable_jpy, tax_rate (0.10), tax_jpy, total_jpy,
  issued_at, due_at, registration_number, pdf_s3_key
invoice_lines
  invoice_id, logical_cluster_id, line_kind (cu_hours | ingress_gb | egress_gb | storage_gb_month | partition_hours | dr_copy_gb),
  tier, quantity (numeric), unit_price_jpy (numeric), amount_jpy (integer), free_quantity
```

### 7.6 未払いと停止

| 経過 | 動き |
| --- | --- |
| 支払いの期限 | カードの失敗は 3 回まで再試行（1・3・7 日後）。メールで知らせる |
| 期限から 14 日 | 組織の管理者に、停止の予告を知らせる |
| 期限から 30 日 | 論理クラスタを `suspended` にする（[control-plane-and-provisioning.md](control-plane-and-provisioning.md) の 4.1 節）。produce をクォータで最小にし、新しい論理クラスタ・トピックの作成を止める。fetch は続ける |
| 期限から 60 日 | 削除の予告（30 日前） |
| 期限から 90 日 | 論理クラスタを削除する（[security-and-acls.md](security-and-acls.md) の 9 節） |

- 停止と削除の条件は、利用規約に書く（法務の確認待ち）。停止の間の CU・保存の課金は続けるか（保存は続ける案）も、法務と PM の確認待ち。

### 7.7 予算と費用の上限

- 予算：組織ごとに月の予算を決められる。今月の見込みが 50%・80%・100% を超えたら、メールとコンソールで知らせる。月末の予測（直近 7 日の平均から）が予算を超えそうなときも知らせる。
- 費用の上限は、**CU の上限（`max_cu`）で表す**。請求の額が予算を超えても、produce を止めない。止めると、利用者のアプリが書き込みに失敗し、データを失わせる危険があるため。
- 保存の費用は CU で抑えられないので、トピックの保持（`retention.ms`・`retention.bytes`）で抑えるよう、コンソールで案内する。

## 8. 障害と振る舞い

| 事象 | 起きること | 検知 | 対応 |
| --- | --- | --- | --- |
| ブローカーの停止 | その分の途中の数を失う（少なく数える） | ブローカーの `broker_incarnation` の変化 | 許容する。失った分の見積もりを記録する |
| エージェントの停止 | 使用量が届かない | 最新の分の遅れ（15 分でアラート） | `__<brand>_usage` の保持（3 日）の中で追いつく |
| 照合の不一致（1% 超） | その時間の請求を保留 | 5 節の照合 | 生の記録から原因を調べ、集計し直す |
| 重複の記録 | — | 一意の鍵で捨てる | — |
| AMP の遅れ・停止 | メトリクスの API が古い・エラー | 取り込みの遅れ | 請求には影響しない（経路が別） |
| 決済の代行の停止 | カードの引き落としが遅れる | 失敗の率 | 再試行。未払いの扱いを延ばす |
| 価格の誤り | 誤った請求 | 締めの前の検査（前月との差が大きい組織の一覧） | 締めを止め、`price_books` を直して計算し直す。発行した後なら、訂正の請求書（適格請求書の修正の手続き。経理の確認待ち） |

## 9. セキュリティ

| 脅威 | 対策 |
| --- | --- |
| 他のテナントのメトリクスの閲覧 | テナントの条件をサーバーで必ず付ける（6.1 節）。性質ベーステストで確かめる |
| 問い合わせの注入（PromQL） | 利用者の文字列を PromQL にしない。値を許した文字に限り、エスケープする |
| 重い問い合わせによる AMP の負荷 | 区間と粒度の組の上限、結果の点の上限、組織ごとの回数の上限 |
| 使用量の改ざん（請求の過大・過少） | 使用量は内部のトピックと S3 にだけ書ける。エージェントの権限は書き込みだけ。照合（5 節）で検知 |
| 請求の情報の露出 | 請求の API は BillingAdmin と OrganizationAdmin だけ。カードの番号は持たない |
| メトリクスのラベルへの利用者のデータの混入 | ラベルは論理クラスタ・トピック・グループの名前だけ。レコードの中身・ヘッダーは入れない |

## 10. テスト

- 表駆動テスト：3.2 節の分・時間の CU の計算（0 の時間、パーティションだけの時間、上限での切り）、7.5 節の消費税の端数処理（行ごとに計算しないこと）、7.4 節の無料の枠の適用、7.6 節の未払いの経過。
- 性質ベーステスト：
  - 任意の分の記録の列（重複・順序の入れ替え・遅れを含む）で、時間の集計が、重複のない正しい列の集計と同じ。
  - 時間の CU は、その時間のどの分の CU 以上で、最大の分の CU と等しい。
  - 任意の 2 つのテナントとメトリクスの問い合わせで、一方の結果に他方の系列が出ない。
- 結合テスト：既知の量（例：1 GB）を produce・fetch し、使用量・メトリクス・請求の行が期待の値（誤差 0.1% 以内）になる。
- 照合のテスト：わざと 1 つのブローカーの記録を落とし、照合が不一致を検知する。
- 請求書：適格請求書の記載事項の欠けがないことを、生成した PDF と JSON で確かめる。

## 11. ADR

| ADR | 決定 |
| --- | --- |
| [0037](../decisions/0037-capacity-unit-definition.md) | CU は層ごとの 6 つの次元の組にする。Standard の 1 CU は Confluent の Standard の eCKU と同じ値。時間の CU は分ごとの CU の最大で、トラフィックのない時間は 0。パーティションの次元は上限にだけ使い、請求の CU には入れない |
| [0038](../decisions/0038-usage-metering-and-metrics-api.md) | 使用量はブローカーで分ごとに数え、内部のトピック → エージェント → S3 を正本にし、時間ごとに集計する。メトリクスの API は専用の AMP を、テナントの条件を必ず付けた問い合わせで使う |
| [0039](../decisions/0039-jpy-billing-and-free-tier.md) | 単価は円で定め、JST の月で締め、適格請求書を出す。消費税は請求書ごとに 1 回の端数処理。CU に含む数を超えたパーティションをパーティション-時で課金する。Basic の最初の 1 CU と小さな量を無料にし、費用の上限は CU の上限で表す |

## 12. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E7 | `usage-counters-in-patch` | 4.1 節のカウンター（名前空間のパッチの出口、資格情報のコールバック）。multi-tenancy-and-quotas と一緒に |
| E11 | `cu-definition` | 3 節の定義を spec にし、クォータの値（multi-tenancy-and-quotas の 6 節）と同じ表から作る |
| E11 | `usage-pipeline` | 5 節の経路（`__<brand>_usage`、エージェント、Firehose、S3、時間の集計） |
| E11 | `retained-bytes` | 4.2 節の保持の量（tiered-and-object-storage と一緒に） |
| E11 | `usage-reconciliation` | 5 節の照合と、請求の保留 |
| E11 | `tenant-metrics-pipeline` | 6.1 節の AMP のワークスペース、コレクター、ラベルの上限 |
| E11 | `metrics-api` | 6.2・6.3 節の API（descriptors、query、export） |
| E11 | `consumer-lag-metrics-api` | 遅れのメトリクス（consumer-groups と一緒に） |
| E11 | `price-books-and-rating` | 7.2・7.3 節 |
| E11 | `free-tier` | 7.4 節の無料の枠と、支払いの方法がない組織の制限 |
| E11 | `invoices` | 7.5 節の適格請求書、PDF、消費税の端数処理 |
| E11 | `payments` | 決済の代行の選定と、カード・銀行振込 |
| E11 | `dunning-and-suspension` | 7.6 節の未払いと停止 |
| E11 | `budgets-and-alerts` | 7.7 節 |
| E10 | `console-billing-pages` | 請求・予算・請求書の画面（console-and-api と一緒に） |

## 13. 段階ごとの変化

| 項目 | S1 | S2 | S3 |
| --- | --- | --- | --- |
| 層 | Basic、Standard | ＋Dedicated（物理クラスタの時間で課金。別の ADR） | 同じ |
| 行 | CU、書き込み、読み取り、保存、大阪への写し | ＋ディスクレスのトピック、スキーマレジストリ、PrivateLink | ＋コネクター、BYOC |
| 契約 | 従量 | ＋年間の約定（前払いのクレジット） | 同じ |
| 通貨 | 円 | 同じ | ＋ドル（海外のリージョン） |

## 14. 未解決の問い

- パーティションだけがある時間を 0 CU にするか。
- Basic の CU の値（特に要求の数）。
- 無料の枠の量。
- 請求の時刻を UTC にするか JST にするか。
- 停止の間の課金。
- 大阪への写しの既定と料金。

### 決定（2026-09-27、既定案）

- **パーティションだけの時間**：0 CU（3.2 節）。放置された開発の論理クラスタに容量の課金をし続けない。保存と、含む数（1 CU 分）を超えたパーティションには課金する。
- **パーティションの価格**：CU に含む数（Standard 100、Basic 20）を超えた分をパーティション-時で課金する（統合の工程の既定案。PM・Dev の確認待ち）。定価は原価の 1.6 倍以上とし、既定案を Standard 0.32 円・Basic 0.27 円のパーティション-時にする（2026-09-27 の検証の工程。[capacity.md](capacity.md) の 10.3 節の計算。PM の確認事項）。
- **Basic の CU**：3.1 節の値。E7 の負荷試験で見直す。
- **無料の枠**：7.4 節の値。PM の承認で確定する。
- **メトリクスの保持**（2026-09-27 の検証で追加）：テナントの AMP は 14 日。1 時間の粒度の 13 か月は、S3 の `metrics/hourly/` に集計して置く（6.2 節）。AMP に間引きの機能がないため。
- **時刻**：JST。月の境界を、日本の利用者の会計の月に合わせる。
- **停止の間**：CU は、produce を絞るので実際の使用に応じて小さくなる（課金は使った分のまま）。保存は課金を続ける。削除までの 60 日の保存の費用は、法務・PM の確認で免除するかを決める。
- **大阪への写し**：既定は無効。有効にした論理クラスタだけ、写した GB に課金する（tiered-and-object-storage の 12 節の持ち越しへの答え）。単価は PM が、東京から大阪への転送の原価（$0.09/GB。tiered-and-object-storage の 6.6 節）を元に決める。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| 決済の代行の事業者 | E11。カードと銀行振込（請求書払い）の両方に対応するもの |
| 適格請求書の登録番号、訂正の手続き、値引きの扱い | 経理の確認待ち |
| 海外の法人への消費税の扱い | 法務・税務の確認待ち |
| 停止と削除の条件の利用規約への記載 | 法務の確認待ち |
| 生の使用量の記録の保持の期間（10 年の案） | 経理・法務の確認待ち |

## 15. quality.md・runbooks・data-model への項目

### quality.md

- 使用量の照合（5 節）の不一致の件数と、保留した時間の数を、本番での品質検証の指標にする。目標は不一致 0。
- 請求の正しさの結合テスト（既知の量を流して、請求の行が合う）を、リリースの基準にする。
- メトリクスの API の、テナントの分離の性質ベーステストを、分離のテストの一部に入れる。
- メトリクスの鮮度（発生から問い合わせられるまで p99 3 分）。

### runbooks

- `runbooks/usage-reconciliation-mismatch.md`：照合の不一致の調べ方と、集計のやり直し。
- `runbooks/usage-pipeline-backlog.md`：エージェントの長い停止（3 日を超える）の後の扱い。
- `runbooks/month-end-close.md`：月の締め、前月との差の検査、請求書の確定。
- `runbooks/invoice-correction.md`：誤った請求書の訂正（経理と一緒に）。
- `runbooks/dunning-suspension.md`：停止と、支払いの後の再開。

### data-model（索引への追加の提案）

| テーブル・記録 | 中身 |
| --- | --- |
| `__<brand>_usage`（データ面の内部のトピック） | 4.1 節の値。保持 3 日 |
| S3 `usage/raw/`（Parquet） | 分×論理クラスタの使用量。請求の根拠 |
| S3 `metrics/hourly/`（Parquet） | テナントのメトリクスの 1 時間の集計。保持 13 か月（6.2 節） |
| `usage_hourly`（制御面） | `logical_cluster_id`、時間（JST）、層、`cu`、`ingress_bytes`、`egress_bytes`、`storage_gb_hours`、`dr_copy_bytes`、`partitions_max`、`partition_hours`、確定の時刻、`reconciliation_status` |
| `price_books` | 版、効力の開始日、層、行の種類、単価（円、小数） |
| `rated_usage` | 組織、論理クラスタ、時間、行の種類、数量、単価、金額（numeric） |
| `free_tier_usage` | 組織、月、行の種類、使った無料の量 |
| `invoices`、`invoice_lines` | 7.5 節 |
| `payments` | 請求書、方法（カード・振込）、決済の代行の参照、状態、金額 |
| `credits` | 組織、理由（販促・SLA）、金額、期限、使った額 |
| `budgets` | 組織、月の予算、通知の閾値、最後の通知 |
| `billing_accounts` | 組織、宛名、請求先のメールアドレス、支払いの方法の種類、決済の代行の顧客の参照、与信の状態 |

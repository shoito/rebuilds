# Infrastructure: Uber

AWS の上の構成。アカウント、ネットワーク、Go の熱い経路と Valhalla の置き方、Kinesis・DynamoDB のリース・Aurora・Valkey、都市ごとのセル、大阪への災害復旧（進行中の乗車の扱い）、Terraform の構成、費用。Slack・Figma の [infrastructure.md](../../../figma/docs/architecture/infrastructure.md) を土台にし、配車に固有の事情だけを変える（[ADR-0001](../decisions/0001-platform-and-stack.md)）。

| ADR | 決定 |
| --- | --- |
| [0038](../decisions/0038-compute-on-fargate-and-data-stores.md) | Go の熱い経路と Valhalla は ECS Fargate（ARM64）。Aurora は `core`（乗車・供給・運賃・地図・安全）と `money`（支払い・台帳）の 2 つのクラスタ。Valkey は `rt` と `cache` の 2 つ。リースの DynamoDB の表はリージョンごと |
| [0039](../decisions/0039-city-cells-and-osaka-warm-standby.md) | 位置の流れ・索引・配車は都市ごとのセル。大阪は縮小したウォームスタンバイ。切り替えでは位置を新しく受け直し、進行中の乗車は端末の要約と journal で戻す。割り当ての比較に `region_gen` を入れる |
| Slack の ADR-0011・0020・0021・0022・0026 | 実行基盤、Terraform、可観測性の道具、無停止のデプロイ、フラグを引き継ぐ |

ログ・メトリクス・SLO は [observability.md](observability.md)、負荷と台数の根拠は [capacity.md](capacity.md)、CI とリリースは [delivery.md](delivery.md)、暗号化と鍵は [security.md](security.md) にある。数値のうち「初期見積もり」と書いたものは、負荷試験（E3・E4・E12）の前の仮の値である。

## 1. AWS アカウント

AWS Organizations で用途ごとに分ける。Slack・Stripe・Figma と同じ形に、分析のアカウントを足す。

| アカウント | 中身 |
| --- | --- |
| management | Organizations、SCP、IAM Identity Center、請求 |
| security | GuardDuty・Security Hub・Inspector の委任管理者、調査用の役割 |
| log-archive | 組織の CloudTrail、Config、VPC フローログ、監査のアーカイブ（Object Lock。[security.md](security.md) の 7 節） |
| shared | ECR（東京と大阪へ複製）、Route 53、Managed Grafana、CI の起点 |
| analytics | ID を HMAC に置き換えた位置と乗車の写し、ID を持たない集計（[security.md](security.md) の 2 節の B9）。本番の生の位置を読む権限を持たない |
| dev、staging | 開発・検証。staging は負荷試験・市場のシミュレーション・DR の訓練に使う |
| prod | 本番。東京（ap-northeast-1）と大阪（ap-northeast-3） |

- SCP で、東京・大阪以外のリージョンを禁止する（CloudFront・WAF・ACM のための us-east-1 を除く）。CloudTrail・Config・GuardDuty の停止、KMS の鍵の削除の予約を、break-glass の役割以外に禁止する。
- `location` の鍵を使える役割の一覧は、prod の中で閉じる。analytics には鍵の権限を渡さない（[ADR-0036](../decisions/0036-location-privacy-keys-retention-and-audited-access.md)）。

## 2. ネットワーク

リージョンごとに、3 AZ にまたがる VPC を 1 つ持つ。

| サブネット | 置くもの | インターネットへの経路 |
| --- | --- | --- |
| public | ALB、NAT ゲートウェイ | Internet Gateway |
| private | ECS のすべてのサービス | NAT 経由（許可の一覧の宛先：PSP、地図・住所の提供者、SMS・通話・顔の照合の提供者、APNs・FCM）。geo-index・dispatch・Valhalla・trail-builder は経路を持たない |
| isolated | Aurora、Valkey | なし |

- VPC エンドポイント：S3・DynamoDB（ゲートウェイ型）、Kinesis、Firehose、SQS、SNS、ECR、Secrets Manager、KMS、CloudWatch Logs、STS、X-Ray、AppConfig。位置の経路（loc-ingest → Kinesis → geo-index）は NAT を通らない。
- 外部の提供者への送信は、専用の送信のサービス（`egress-*`）に集め、宛先の許可の一覧と、送る項目の検査（位置は乗降の座標だけ、ID を送らない。[eta-and-routing.md](eta-and-routing.md) の 10 節）を 1 か所で行う。
- サービスの間は ECS Service Connect（TLS 1.3。[security.md](security.md) の 6.1 節）。

## 3. 実行基盤

[ADR-0038](../decisions/0038-compute-on-fargate-and-data-stores.md) による。すべて ECS Fargate の ARM64。

| サービス | 言語 | 役割 | スケールの指標 | 最小タスク数（東京） |
| --- | --- | --- | --- | --- |
| api | TypeScript | 乗客・ドライバーの API、見積もり、依頼の受け入れの上限（[ADR-0041](../decisions/0041-load-model-admission-control-and-prescaling.md)） | CPU 50%、同時の要求 | 6 |
| trips | TypeScript | 遷移関数、提案の検査（[trips-lifecycle.md](trips-lifecycle.md)） | CPU 50% | 4 |
| trips-workers | TypeScript | タイマー、outbox の中継 | タイマーの遅れ、outbox の最古 | 3 |
| pricing、fare-distance | TypeScript | 運賃、推計走行距離 | CPU | 3、2 |
| payments、payments-workers | TypeScript | 与信・確定・照合・精算 | CPU、SQS の最古 | 3、2 |
| supply | TypeScript | 事業者の API、出庫の判定 | CPU | 3 |
| places | TypeScript | 住所の検索（[maps-and-geodata.md](maps-and-geodata.md) の 7 節） | CPU | 2 |
| console | TypeScript | 事業者の管理画面・サポートのツールの BFF | CPU | 3 |
| safety-intake | TypeScript | `SafetyIncident` の受信と当番の呼び出しへの直接の経路（[safety-and-trust.md](safety-and-trust.md) の 4.3 節） | SQS の最古 | 2（AZ ごとに分ける） |
| rt-router、push-sender | TypeScript | 配信の振り分け、プッシュ通知（[notifications-and-realtime-push.md](notifications-and-realtime-push.md)） | SQS の最古 | 3、2 |
| loc-ingest | Go | 位置の受信と検証（[location-ingestion.md](location-ingestion.md)） | 要求の数、CPU 50% | 6（AZ ごとに 2） |
| geo-index | Go | 索引の主と待機（[geospatial-index.md](geospatial-index.md)） | 固定（分割 × 2） | 2（別の AZ） |
| dispatch | Go | 区域のバッチ（主と待機） | 固定（区域 × 2） | 2（別の AZ） |
| dispatch-shadow | Go | 影の実行（[delivery.md](delivery.md) の 3 節） | 固定 | 0〜1 |
| eta-service | Go | Valhalla の前の層（[eta-and-routing.md](eta-and-routing.md) の 3 節） | CPU | 3 |
| trail-builder | Go | 乗車の軌跡、当てはめ、速度の標本 | Kinesis の遅れ | 2 |
| rt-gateway | Go | gRPC の常時の接続（[ADR-0030](../decisions/0030-realtime-grpc-bidirectional-stream-gateway.md)） | 接続の数 | 6（AZ ごとに 2） |
| trip-location-fanout | Go | 乗客への車の位置 | Kinesis の遅れ | 2 |
| valhalla-eta | C++（Valhalla） | ETA と行列（taxi の costing） | CPU 50%、予定の拡大 | 6（AZ ごとに 2） |
| valhalla-match | C++（Valhalla） | 軌跡の当てはめ | CPU、trail-builder の待ち | 4 |

- Go のサービスは `GOMEMLIMIT` をタスクのメモリの 80% にする。
- Valhalla は、起動のときに S3 の `valhalla/tiles/<tile_version>/` から tar を一時の記憶域（50 GiB）に取り、mmap で読む。タイルの切り替えは青緑（[eta-and-routing.md](eta-and-routing.md) の 5.3 節）。日本全体のタイルの大きさ・起動の時間は **未検証**（E4 の `valhalla-pool-fargate` で計る。ドイツの tar は約 4.6 GB という報告。[Valhalla の Discussion #4816](https://github.com/valhalla/valhalla/discussions/4816)、2026-09-27 に確認）。
- geo-index と dispatch は、リースを持つ主と待機の 2 タスク。配備では、待機を先に入れ替え、`READY` の後に主がリースを手放して入れ替わる（[delivery.md](delivery.md) の 4.2 節）。ECS のサービスの `maximumPercent` を 200% にする。

## 4. 入口

| 名前 | 経路 | 中身 |
| --- | --- | --- |
| `api.<domain>` | CloudFront（WAF）→ ALB → api | 乗客・ドライバーの API |
| `loc.<domain>` | ALB（地域の WAF）→ loc-ingest | 位置の POST（HTTP/2）。CloudFront を通さない（4 秒ごとの小さな要求で、キャッシュの利点がない。遅れの予算を守る） |
| `rt.<domain>` | ALB（gRPC）→ rt-gateway | 常時の接続（[notifications-and-realtime-push.md](notifications-and-realtime-push.md) の 3 節） |
| `operator.<domain>` | CloudFront（WAF）→ S3（静的）・ALB → console | 事業者の管理画面 |
| `ops.<domain>` | 社内の IdP の後ろ（ALB の OIDC 認証）→ console | サポート・安全・審査のツール |
| `share.<domain>` | CloudFront → S3（静的）・ALB | 乗車の共有のページ（[safety-and-trust.md](safety-and-trust.md) の 3 節） |

- DNS は Route 53。`api`・`loc`・`rt` の TTL は 60 秒。大阪への切り替えは、人の判断でレコードを変える（自動のフェイルオーバーはしない。[ADR-0039](../decisions/0039-city-cells-and-osaka-warm-standby.md)）。アプリは同じホスト名を使い続ける。
- アプリは、DNS の切り替えの後も古い接続を使い続けうる。rt-gateway と loc-ingest は、東京の書き込みを止めたときに接続を閉じ（`Goaway`、503）、アプリに引き直させる。

## 5. 都市のセル

[ADR-0039](../decisions/0039-city-cells-and-osaka-warm-standby.md) による。

```
リージョン（東京）
 ├─ 共有：api、trips、supply、pricing、payments、eta-service・Valhalla、rt-*、Aurora core・money、Valkey
 ├─ セル tokyo：Kinesis loc-tokyo、geo-index（分割）、dispatch（区域）、AppConfig dispatch/tokyo-*
 ├─ セル osaka（S2）：Kinesis loc-osaka、geo-index、dispatch …
 └─ …（S2 は 12 都市）
```

- loc-ingest は、点の `metro` のセルから都市を引き、`loc-<city>` に書き分ける（[location-ingestion.md](location-ingestion.md) の 6 節）。
- 配備・設定・フラグは、S2 から都市の単位の波で出す（[delivery.md](delivery.md) の 4 節）。
- 1 都市のセルの障害（索引・配車の停止）は、その都市の配車だけを止める。依頼は Trips に残る。

## 6. データの基盤

| 基盤 | 使い方 | 設定 |
| --- | --- | --- |
| Kinesis Data Streams `loc-<city>` | 位置の流れ | プロビジョンド。S1 は `loc-tokyo` 8 シャード、保持 24 時間、KMS（`location`）。拡張ファンアウトの読み手：geo-index の主・待機、trail-builder、trip-location-fanout。Firehose は共有の読み取り。大阪にも同じシャード数の空のストリームを置く（複製しない） |
| Firehose | `loc-raw/`、`dispatch-decisions/` | S3 へ Parquet、SSE-KMS |
| DynamoDB `geo_shard_leases` | 索引の分割と配車の区域のリース（[ADR-0011](../decisions/0011-geo-index-sharding-lease-and-rebuild.md)） | オンデマンド、PITR。リージョンごと（グローバルテーブルにしない） |
| Aurora PostgreSQL 18 `core` | 乗車、供給、運賃の規則、地図（PostGIS）、安全、サポート、監査ログ | writer `db.r8g.2xlarge` 1＋reader 1（別の AZ）、I/O-Optimized、Global Database（大阪に reader 1） |
| Aurora PostgreSQL 18 `money` | 支払い、台帳、精算、照合 | writer `db.r8g.xlarge` 1＋reader 1、I/O-Optimized、Global Database（大阪に reader 1） |
| ElastiCache（Valkey）`rt` | 常時の接続の Stream・`seq`・登録表・Pub/Sub | クラスタモードを使わない、`cache.r7g.large` プライマリ＋レプリカ 2 |
| ElastiCache（Valkey）`cache` | レート制限、需給の集計（`supply:<city>:<district_cell>`）、見積もりのキャッシュ、受け入れの上限の数 | 同上 |
| SNS・SQS | `trips-events` と購読する側ごとのキュー、`rt-fanout`、`push-requests`、`safety-incidents` | 標準、DLQ |
| S3 | 位置（`loc-raw/`・`trip-trails/`・`speed-samples/`・`supply-heat/`）、`dispatch-decisions/`、`valhalla/tiles/`、`osm/`、`eta/`、書類、精算の明細 | バージョニング、SSE-KMS（種類ごとの鍵）、ライフサイクル（東京・大阪の両方）。大阪へ複製するのは、タイル・OSM・書類・精算の明細・`trip-trails/`（乗車の記録として）。`loc-raw/` と `dispatch-decisions/` は複製しない（失ってよい、保持が短い） |
| AppConfig | フラグ、配車の設定、`client_policy`、`region_gen`、`ops.region.writable` | 検証の関数（[delivery.md](delivery.md) の 6 節） |

- Aurora の Global Database の計画外の切り替えは、複製されなかった書き込みを失いうる。古い主への書き込みの止め方はベストエフォートで、分断が起こりうる。計画した切り替えは RPO 0（[Using switchover or failover](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-global-database-disaster-recovery.html)、2026-09-27 に確認）。アプリは Global Database の writer のエンドポイントを使い、DNS のキャッシュを 5 秒にする（同じ資料の勧め）。
- Kinesis のプロビジョンドのシャードは、書き込み 1 MB/秒か 1,000 件/秒、読み取り 2 MB/秒。登録できる拡張ファンアウトの読み手は、ストリームごとに 20（[Quotas and limits](https://docs.aws.amazon.com/streams/latest/dev/service-sizes-and-limits.html)、2026-09-27 に確認）。

## 7. 冗長化と災害復旧

### 7.1 AZ の障害（NFR-007：RPO 0、RTO 5 分）

| 部品 | 動き | 目安 |
| --- | --- | --- |
| geo-index・dispatch | 主のいる AZ が落ちたら、待機がリースを取る。配車の検索は 100 ms で待機に切り替わる（[ADR-0011](../decisions/0011-geo-index-sharding-lease-and-rebuild.md)） | 主の役の引き継ぎ 約 6.5 秒 |
| loc-ingest・rt-gateway・Valhalla | 残る 2 AZ が受ける。平常の使用を 2/3 以下に保つ（[capacity.md](capacity.md)） | 再接続の数十秒 |
| Aurora | 別の AZ の reader へ自動で切り替わる。数十秒の遷移の失敗は、アプリが同じ `command_id` で送り直す | 通常 60 秒未満 |
| Valkey `rt` | レプリカへ切り替わる。Stream と `seq` を失いうる。アプリは `stream_epoch` の変化で API から読み直す（[notifications-and-realtime-push.md](notifications-and-realtime-push.md) の 10 節） | 数十秒 |
| Kinesis・DynamoDB・S3 | リージョンのサービス | — |

### 7.2 リージョンの障害（NFR-007：RPO 1 分、RTO 30 分）

[ADR-0039](../decisions/0039-city-cells-and-osaka-warm-standby.md) による。手順は [runbooks/disaster-recovery.md](../runbooks/disaster-recovery.md)。

| 大阪に常に置くもの | 切り替えのときに増やすもの |
| --- | --- |
| VPC、ALB、ECS のサービス（各 1 タスク、Valhalla は 2）、Aurora `core`・`money` の二次（reader 1）、Valkey（小）、空の Kinesis `loc-<city>`、空の `geo_shard_leases`、SQS・SNS、ECR・Secrets Manager・KMS のレプリカ、Valhalla のタイルと OSM の S3 のレプリカ | ECS のタスク数（東京と同じ）、Aurora の reader、Valkey の大きさ |

**進行中の乗車に起きること**：

| 乗車の状態（障害のとき） | 起きること | 戻し方 |
| --- | --- | --- |
| `requested`（組が未定） | DB に複製されていれば、大阪で配車が続く。複製されていなければ失われる | 乗客のアプリが状態を読み直し、見つからなければ依頼し直しを勧める。与信は照会で見つけて取り消す |
| `offered` | オファーは期限（16.5 秒）で切れる | 大阪の配車が次のバッチで配り直す |
| `accepted`〜`on_trip` | ドライバーのアプリは、通信がなくても到着・乗車の開始・降車を journal で進める（[ADR-0022](../decisions/0022-trip-outbox-and-offline-continuation.md)）。乗客は目の前の車に乗って運ばれる | つながった先（大阪）に `TripSnapshot` と journal を送り、`restored` の印で戻す。割り当ては新しい `region_gen` の epoch で結び直す |
| `awaiting_fare`・`completed`（確定の前） | メーターの額と売上の確定が遅れる | 大阪の Payments が照会で結び直し、確定を再開する |
| 支払いの操作が結果不明 | — | 冪等キーで照会（[payments-and-payouts.md](payments-and-payouts.md) の 7・9 節） |

- **位置と索引**：Kinesis は複製しない。アプリが DNS の切り替えで大阪の `loc-<city>` に送り始め、35 秒で索引が温まる。
- **リースと割り当ての世代**：大阪の空の `geo_shard_leases` から取り直す。AppConfig の `region_gen` を 1 上げ、`assignment_epoch` の比較を `(region_gen, assignment_epoch)` にする。
- **緊急の通報**：端末は 110・119 の画面をサーバーなしに開ける。`SafetyIncident` は端末に残って送り直され、大阪の safety-intake が受ける（[safety-and-trust.md](safety-and-trust.md) の 4.3 節）。
- **RTO の内訳（目安）**：判断 10 分、書き込みの停止と Aurora の切り替え 5 分、ECS を広げる 10 分（Valhalla の起動を含む。**未検証**。E12 の `dr-drill`）、DNS の切り替え 1〜2 分、索引の温まり 1 分。合計 約 30 分。E12 の DR の訓練で計る。
- **戻す**：Aurora の switchover（RPO 0）で東京へ戻す。平日の夜に、事前に告知して行う。

### 7.3 バックアップ

| 対象 | 方法 | 保持 |
| --- | --- | --- |
| Aurora `core`・`money` | 自動バックアップ（PITR）＋ AWS Backup の日次のスナップショット（大阪へコピー） | 35 日 |
| DynamoDB `geo_shard_leases` | 不要（作り直せる）。PITR は有効にする | 35 日 |
| S3 | バージョニング（古いバージョン） | 30 日 |
| 監査のアーカイブ | log-archive の S3（Object Lock） | 7 年（既定案） |

## 8. S1 の構成と台数（初期見積もり）

根拠は [capacity.md](capacity.md)。

| リソース | 構成 |
| --- | --- |
| TypeScript のサービス（13 種） | 1〜2 vCPU / 2〜4 GB。合計 約 63 vCPU / 126 GB |
| Go のタスク（6 つのサービスと 2 つの付随の役。[ADR-0001](../decisions/0001-platform-and-stack.md)） | loc-ingest 1 vCPU/2 GB × 6、geo-index 2 vCPU/8 GB × 2、dispatch 2/4 × 2、dispatch-shadow 2/4 × 1、eta-service 1/2 × 3、trail-builder 2/4 × 2、rt-gateway 2/4 × 6、trip-location-fanout 1/2 × 2。合計 約 37 vCPU / 82 GB |
| Valhalla | valhalla-eta 4 vCPU/16 GB × 6（予定の拡大で 18 まで）、valhalla-match 4/16 × 4 |
| Aurora | `core`：`db.r8g.2xlarge` × 2（東京）＋ 1（大阪）。`money`：`db.r8g.xlarge` × 2 ＋ 1 |
| Valkey | `cache.r7g.large` × 3 × 2 クラスタ。大阪は各 1 |
| Kinesis | `loc-tokyo` 8 シャード（東京）、8 シャード（大阪、空） |
| NAT ゲートウェイ | 東京 3、大阪 3 |

- staging は同じ構成を最小の台数で持ち、負荷試験のときだけ本番と同じにする。dev は夜間と週末に止める。

## 9. 段階の移行（S2・S3）

| 指標 | S1 → S2 を始める目安 | S2 → S3 を始める目安 |
| --- | --- | --- |
| オンラインの車両（1 都市） | 2 都市目の提携が決まった | 1 分割 5 万台（[geospatial-index.md](geospatial-index.md) の 7 節） |
| 1 回のバッチの依頼 | 200 件（区域を分ける。[dispatch-and-matching.md](dispatch-and-matching.md) の 4 節） | — |
| Aurora `core` の writer の CPU（ピークの p95） | 60% を超え、1 段上げても 6 か月もたない | 最大のクラスで 60% |
| Valhalla のタスク | 40 を超える（ECS on EC2 を見直す。ADR-0038） | — |

- **S2**：機械学習の基盤（SageMaker、Managed Service for Apache Flink、S3 の Iceberg、Step Functions。[ml-platform.md](ml-platform.md)）を analytics と prod のどちらに置くかを決める（位置の流れを読むので、生の位置を読む部分は prod に置く）。
- **S2**：都市ごとのセル（`loc-<city>`、geo-index、dispatch）を 12 都市に足す。東京は `metro` の集まりで分割する。Aurora `core` は共有のまま。大阪の二次を writer と同じ大きさにする。
- **S3**：都市のまとまりのセルに Aurora `core` のシャード（`city_id`）を含める。関西のセルの主を大阪に置く active-active を検討する（Stripe の [ADR-0031](../../../stripe/docs/decisions/0031-active-active-cells.md) と同じ形）。本家は、平常の容量を事業の重要度で分けて 2 倍から 1.3 倍に下げている（[Uber's Failover Architecture](https://arxiv.org/abs/2603.07345)、2026-09-27 に確認）。S3 で、配車の熱い経路（重要）と分析・再生（重要でない）で、大阪の予備の容量を分ける。

## 10. Terraform の構成

Slack の [ADR-0020](../../../slack/docs/decisions/0020-infrastructure-as-code-with-terraform.md) を引き継ぐ。開発リポジトリの `infra/` に置く。

```
infra/
├── modules/
│   ├── network/               # VPC、サブネット、エンドポイント、NAT
│   ├── ecs-service/           # タスク定義、サービス、オートスケール、Service Connect、ALB
│   ├── go-hotpath-pair/       # 主と待機の 2 タスク（geo-index・dispatch）、リースの権限
│   ├── valhalla-pool/         # Valhalla のタスク、一時の記憶域、タイルの S3 の権限、予定の拡大
│   ├── city-cell/             # Kinesis loc-<city>、拡張ファンアウトの読み手、geo-index・dispatch、AppConfig の区域
│   ├── aurora-global/
│   ├── valkey/
│   ├── s3-retained/           # バケット、ライフサイクル（保持の表から生成。security.md の 7.2 節）、複製の有無
│   ├── edge/                  # CloudFront、WAF、証明書、Route 53
│   └── kms-multiregion/
├── global/                    # Organizations、SCP、Identity Center、ECR
├── accounts/{security,log-archive,shared,analytics}/
└── envs/{dev,staging,prod}/
    ├── apne1/{network,data,compute,cells/<city>,edge}/   # 東京
    └── apne3/{network,data,compute,cells/<city>}/        # 大阪
```

- 都市のセルは `cells/<city>` のルートに分け、都市を足す変更が他の都市の状態ファイルに触れないようにする。
- `data` のモジュール（Aurora、S3、KMS、Kinesis）には `prevent_destroy` を付ける。
- 保持の期間の値は、[security.md](security.md) の 7.2 節の表から生成したファイル（`retention.auto.tfvars.json`）だけから読む（ADR-0036）。
- `region_gen`・`ops.region.writable` と、大阪への切り替えは、Terraform ではなく AppConfig と Route 53 の手順で行う（apply に頼らない）。

## 11. 費用の概算（S1、本番、1 か月）

**大まかな見積もりである。** 東京のオンデマンドの料金による ±50% の幅の値。Fargate・Aurora・ElastiCache・Kinesis・DynamoDB・EC2・NAT の単価は、AWS の Price List API（`ap-northeast-1`、2026-09 の公開分）で 2026-09-27 に確かめた。大阪（`ap-northeast-3`）の Fargate・Aurora、両リージョンの ALB・VPC エンドポイント・S3・Firehose の単価も、同じ API（公開日 2026-09-24）で 2026-09-27 に確かめた。量（転送、LCU、ログの量）と、可観測性・セキュリティのサービスの額は **未検証**（E12 の `cost-dashboard` で実測に置き換える）。外部の提供者（地図・住所・推計走行距離・SMS・通話・顔の照合・PSP）の料金は含めない。

| 項目 | 月額（USD、概算） | 根拠 |
| --- | --- | --- |
| ECS Fargate（東京、約 140 vCPU・368 GB） | 5,300 | ARM64 の vCPU 時 0.04045、GB 時 0.00442 × 730 時間 |
| Aurora `core`（`db.r8g.2xlarge` I/O-Optimized 1.732/時 × 2） | 2,610 | 保存 300 GB × 0.27 を含む |
| Aurora `money`（`db.r8g.xlarge` I/O-Optimized 0.866/時 × 2） | 1,290 | 保存 100 GB を含む |
| Aurora 大阪の二次（`core`・`money` の reader 各 1） | 2,000 | 大阪の I/O-Optimized は `db.r8g.2xlarge` 1.728/時、`db.r8g.xlarge` 0.864/時（東京よりわずかに安い）。保存 400 GB × 0.27 を含む。複製の書き込みの I/O は 100 万回 0.24。複製とリージョンをまたぐ転送の量は **未検証**（E12 の `cost-dashboard`） |
| Valkey（`cache.r7g.large` 0.2104/時 × 6）＋大阪（0.2103/時 × 2） | 1,230 | |
| Kinesis（8 シャード 0.0195/時、PUT 1 百万単位 0.0215、拡張ファンアウト 4 読み手 × 8 シャード 0.0195/時、取り出し 0.0169/GB）＋大阪の空のストリーム | 800 | 平均の件数はピークの 4 割と仮定 |
| S3、Firehose | 400 | S3 標準 0.025/GB 月（東京・大阪）。Firehose は Kinesis から読む量 0.036/GB（東京）。量は **未検証**（E12 の `cost-dashboard`） |
| ALB × 4、NAT（0.062/時 × 3 ＋ 転送）、VPC エンドポイント、AZ をまたぐ転送 | 1,200 | ALB 0.0243/時 ＋ LCU 0.008/時、VPC エンドポイント 0.014/時・0.01/GB（東京・大阪で同じ）。LCU と転送の量は **未検証**（E12 の `cost-dashboard`） |
| 可観測性（ログ、メトリクス、トレース、Grafana） | 3,000 | **未検証**（E12 の `cost-dashboard`）。位置の件数に比例するログを書かない前提 |
| WAF、GuardDuty、Security Hub、Inspector、Config、CloudTrail | 1,000 | **未検証**（E12 の `cost-dashboard`） |
| 大阪のウォームスタンバイの計算（約 30 vCPU・70 GB） | 1,100 | 大阪の Fargate（ARM64）の単価は東京と同じ（vCPU 時 0.04045、GB 時 0.00442） |
| **本番の合計** | **約 19,900** | ±50% |
| staging・dev・shared・analytics | 約 4,000 | |

- 大きく効くのは、Fargate（Valhalla と常時の接続）と Aurora（2 クラスタ × 大阪）。Compute Savings Plans で Fargate を 20〜30% 下げられる。
- 平常のピークの 2 倍を常に持つ方針（[ADR-0041](../decisions/0041-load-model-admission-control-and-prescaling.md)）の費用が、熱い経路の台数に含まれている。
- 費用は、タグ（`service`、`city`、`env`、`region`）ごとに毎月見る。

## 12. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E1 | `aws-accounts-and-network` | 1・2 節（Slack・Stripe・Figma のモジュールを流用、analytics のアカウントを足す） |
| E1 | `terraform-layout` | 10 節の構成、`cells/<city>`、`prevent_destroy` |
| E1 | `ecs-go-services-baseline` | Go のサービスの ECS のテンプレート（ARM64、`GOMEMLIMIT`、OTel、ヘルスチェック、Service Connect） |
| E1 | `aurora-core-and-money` | 2 つのクラスタ、Global Database、ロールの分離 |
| E1 | `egress-gateway` | 外部の提供者への送信の集約と宛先の許可の一覧 |
| E3 | `city-cell-module` | `loc-<city>`、geo-index・dispatch の主と待機、大阪の空のストリーム |
| E4 | `valhalla-pool-fargate` | Valhalla のタスク、タイルの取得、起動の時間の計測 |
| E6 | `region-gen-assignment-compare` | `(region_gen, assignment_epoch)` の比較（Trips・索引・アプリ。trips-lifecycle と一緒に） |
| E12 | `osaka-warm-standby` | 7.2 節の大阪の構成 |
| E12 | `dr-drill` | DR の訓練（staging で四半期ごと） |
| E12 | `prescale-schedules` | 大晦日・催し・雨の予報の予定の拡大（capacity と一緒に） |
| E12 | `cost-dashboard` | タグごとの費用の可視化 |

## 13. 未解決の問い

### 決定（2026-09-27、既定案）

- 計算はすべて Fargate の ARM64。Valhalla も Fargate で始め、40 タスクか起動 5 分で ECS on EC2 を見直す。
- Aurora は `core` と `money`。Valkey は `rt` と `cache`。
- リースの表はリージョンごと。Kinesis は複製しない。
- 大阪は縮小したウォームスタンバイ。切り替えは人の判断。
- `loc.<domain>` は CloudFront を通さない。
- 割り当ての比較は `(region_gen, assignment_epoch)`。形は [trips-lifecycle.md](trips-lifecycle.md) の 4.2 節（Trips）、[geospatial-index.md](geospatial-index.md) の 4.2 節（索引）、アプリのベクター（統合の決定）。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| 日本全体の Valhalla のタイルの大きさ、メモリ、起動の時間 | E4 |
| 大阪の Fargate の容量が切り替えのときに足りるか | DR の訓練。足りなければ大阪の常の台数を上げる |
| 障害中に Aurora の東京の書き込みを確実に止める方法（write fencing はベストエフォート） | E12 の訓練。東京のサービスの台数 0 と ops フラグで止める手順を確かめる |
| 費用の単価の確認（大阪、ALB、可観測性） | E12 の前 |
| `loc.<domain>` の地域の WAF の費用と、要求の数に比例する料金 | E3 |

## 14. quality.md・runbooks・data-model への項目

### quality.md

- DR の訓練の合否：失った範囲 1 分以内、RTO 30 分以内、戻した乗車の数と、食い違い（`trip_conflicts`）の解決の時間、二重の割り当て 0 件。
- AZ の障害の訓練の合否：`dispatch_decision` の悪い事象が 5 分以内に平常に戻る、乗車の記録の損失 0。

### runbooks

- [runbooks/deploy-and-rollback.md](../runbooks/deploy-and-rollback.md)、[runbooks/disaster-recovery.md](../runbooks/disaster-recovery.md)、[runbooks/incident-response.md](../runbooks/incident-response.md)（この領域で作った）。
- `valhalla-capacity.md`（[eta-and-routing.md](eta-and-routing.md) の提案）に、予定の拡大と起動の遅れの対処を足す。
- `prescale-for-events.md`：大晦日・催し・雨の予報の前の拡大の手順と、戻し方。
- `fargate-retirement.md`：Fargate の退役の通知を受けて、geo-index・dispatch を待機から入れ替える定期作業。

### data-model

| 置き場所 | 中身 |
| --- | --- |
| DynamoDB `geo_shard_leases`（リージョンごと） | [geospatial-index.md](geospatial-index.md) の 5.2 節 |
| AppConfig `ops.region.writable`、`region_gen` | 書き込みを受けるリージョンと、割り当ての世代 |
| Kinesis `loc-<city>`（東京・大阪、複製しない） | 6 節 |
| S3 の複製の有無 | 6 節の表 |

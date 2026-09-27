---
status: accepted
date: 2026-09-27
---

# ADR-0039: 位置・索引・配車は都市ごとのセルに分け、大阪は縮小したウォームスタンバイにする。切り替えでは位置を新しく受け直し、進行中の乗車は端末の要約と journal で戻す

詳細は [infrastructure.md](../architecture/infrastructure.md) の 7・8 節、手順は [runbooks/disaster-recovery.md](../runbooks/disaster-recovery.md)。

## Context

- 配車の可用性は都市ごとに月間 99.99% で、1 都市の障害を他の都市に広げない（NFR-004）。
- 乗車の記録は、AZ の障害で RPO 0・RTO 5 分、リージョンの障害で RPO 1 分・RTO 30 分（NFR-007）。
- 位置の流れ（Kinesis Data Streams）は、リージョンの間で複製されない。Aurora の Global Database は非同期の複製で、計画外の切り替えの RPO は通常は秒の単位、RTO は分の単位。計画外の切り替え（`failover-global-cluster --allow-data-loss`）では、複製されなかった書き込みが失われうる。古い主への書き込みの止め方（write fencing）はベストエフォートで、分断（split-brain）が起こりうる。計画した切り替え（switchover）は RPO 0（[Using switchover or failover in Aurora Global Database](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-global-database-disaster-recovery.html)、2026-09-27 に確認）。
- 本家の事実（2026-09-27 に確認）：
  - 本家は、データセンターの切り替えのときに、ドライバーの端末に送っておいた状態の要約から乗車を戻していた（[How Uber Scales Their Real-time Market Platform](http://highscalability.com/blog/2015/9/14/how-uber-scales-their-real-time-market-platform.html)、2015）。
  - 本家の複数のリージョンの Kafka は、サージの価格の計算のように各リージョンで同じ計算をする active/active と、支払いのように強い一貫性が要るものの active/passive を使い分ける（[Disaster recovery for multi-region Kafka at Uber](https://www.uber.com/us/en/blog/kafka/)、2020-12-21）。
  - 本家は、全リージョンで 2 倍の容量を持つ形から、事業の重要度で分けて平常の容量を 2 倍から 1.3 倍に下げた（[Uber's Failover Architecture](https://arxiv.org/abs/2603.07345)、2026-03 初版）。
  - 本家の基盤は、ゾーンの集まりをリージョンとし、変更は小さな単位で少しずつ広げ、問題を見たら自動で戻す（[Up: Portable Microservices Ready for the Cloud](https://www.uber.com/us/en/blog/up-portable-microservices-ready-for-the-cloud/)、公開日は **未検証**）。

## Options

### 分け方

1. **都市ごとのセル（位置の流れ・索引・配車）を持ち、乗車・支払いの DB は S2 まで共有する**
2. **分けない（1 つの構成で全都市）**
3. **S1 から都市ごとに DB まで分ける**

### 大阪

- a. **縮小したウォームスタンバイ（各サービス 1 タスク、Aurora の reader 1）**
- b. **パイロットライト（データだけ複製し、計算は切り替えのときに作る）**
- c. **東京と同じ大きさの active-active**

## Decision

分け方は 1、大阪は a を採用する。

### セル

- **都市のセル**＝{Kinesis `loc-<city>`、geo-index の分割、dispatch の区域、配車の設定（AppConfig `dispatch/<zone>`）}。S1 はセル `tokyo` だけ。
- セルの外（リージョンで共有）：API、Trips・供給・運賃（Aurora `core`）、Payments（Aurora `money`）、ETA と Valhalla、常時の接続、通知。
- 都市は、乗車地の H3 の解像度 6 の親から決め（[location-ingestion.md](../architecture/location-ingestion.md) の 6 節）、乗車の間は変えない。
- 配備・設定の変更・フラグは、S2 から都市の単位で波にする（[ADR-0042](0042-replay-and-shadow-gates-for-dispatch-and-pricing.md)）。
- S3 では、都市のまとまりのセルに Aurora のシャード（`city_id` を鍵）を含め、関西のセルの主を大阪に置く active-active を検討する（Stripe の題材の [ADR-0031](../../../stripe/docs/decisions/0031-active-active-cells.md) と同じ形）。

### 大阪への切り替え

- **位置**：大阪にも `loc-<city>` を同じシャード数で置く（空）。アプリは同じホスト名（`loc.<domain>`）に送り続け、DNS の切り替えで大阪に届く。東京の流れは複製しない。4 秒ごとに届くので、切り替えの後 35 秒で索引が温まる（[ADR-0011](0011-geo-index-sharding-lease-and-rebuild.md) の再構築）。
- **リース**：大阪の `geo_shard_leases`（空）から取り直す。
- **乗車**：Aurora `core` を大阪へ切り替える。複製されなかった直近の遷移と乗車は、ドライバーのアプリの `TripSnapshot` と journal から `restored` の印で戻す（[ADR-0022](0022-trip-outbox-and-offline-continuation.md)）。乗客のアプリは復元に使わない。
  - `requested` のまま失われた依頼は戻せない。乗客のアプリは、今の状態を読み直して「依頼が見つからない」を出し、同じ見積もりでの依頼し直しを勧める。
  - **割り当ての世代**：切り替えのたびに AppConfig の `region_gen` を 1 上げる。`assignment_epoch` の比較は `(region_gen, assignment_epoch)` の辞書順にし、失われた epoch の増分と同じ値を、新しいリージョンで再び使わないようにする。復元の経路は、署名を確かめた要約の `assignment_id` で割り当てを結び直し、新しい世代の epoch を返す（形は [trips-lifecycle.md](../architecture/trips-lifecycle.md) の 4.2・8.5 節。統合の工程で [ADR-0003](0003-trip-state-and-single-assignment.md) にも取り込んだ）。
- **支払い**：Aurora `money` を大阪へ切り替える。PSP への操作は冪等キーと照会で結び直す（[payments-and-payouts.md](../architecture/payments-and-payouts.md) の 9 節）。失われた依頼の与信は、PSP の照会で見つけて取り消す。
- **切り替えの判断は人が行う。** DNS の自動の切り替えはしない。Aurora の分断を避けるため、東京の書き込みを止める操作（ops フラグ、東京のサービスの台数 0）を先に試みる。
- 大阪の常の構成：各サービス 1 タスク（Valhalla は 2 タスク）、Aurora の reader 1（`core`・`money`）、Valkey（小）、空の Kinesis とリースの表、ECR・Secrets Manager・KMS のレプリカ、Valhalla のタイルの S3 のレプリカ。
- 2 を採らない理由：S2 で 12 都市になったとき、1 つの配車の不具合・設定の誤りが全都市を止める。
- 3 を採らない理由：S1 は 1 都市で、DB を分ける利点がない。
- b を採らない理由：計算を作るところから始めると、RTO 30 分に収まらない見込み（ECS のサービスの作成、ECR の取り込み、Valhalla の起動）。
- c を採らない理由：S1 の費用が 2 倍になる。乗車の状態は強い一貫性で 1 つの書き手に置く（ADR-0003）ので、S1 では active-active の利点が小さい。

## Consequences

- 良くなること：
  - 位置の流れの複製を持たずに済み、大阪の索引は新しい位置だけで正しく作られる。
  - 進行中の乗車は、DB の直近の損失があっても、端末の記録から戻せる。
- 引き受けるコスト：
  - 切り替えの直後、戻した乗車と食い違いを運用が確かめる。
  - `region_gen` を割り当ての比較に入れる変更を、Trips・索引・アプリに入れる。
  - 大阪の Fargate の容量が、切り替えのときに足りるかは **未検証**（Fargate は容量の予約を持たない）。訓練で確かめる。

## Confirmation

- DR の訓練（四半期に 1 回、staging）：負荷の中で複製を止めて切り替え、RPO 1 分以内・RTO 30 分以内、戻した乗車の数と食い違いの数を記録する。
- 性質ベーステスト：切り替えで epoch の増分が失われた任意の列で、`(region_gen, assignment_epoch)` の比較の下で二重の割り当てが起きない（PROP-INFRA-001）。
- 障害注入：1 つの都市のセルの dispatch を止めても、他の都市の NFR-001 が変わらない（S2 から）。

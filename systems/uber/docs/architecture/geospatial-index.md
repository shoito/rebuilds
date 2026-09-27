# Geospatial index: Uber

オンラインのドライバーの最新の位置と状態を、H3 のセルでメモリに持つ索引。中身の持ち方、都市とセルでの分割、リースによる持ち主の決め方、位置の流れの直近 30 秒からの再構築、近くの空車を探す検索の API を決める。

前提となる決定は、H3 の解像度の使い分けとメモリの上の索引（[ADR-0002](../decisions/0002-h3-geospatial-model.md)）、割り当ての正本は Trips で fencing token（`assignment_epoch`）が守る（[ADR-0003](../decisions/0003-trip-state-and-single-assignment.md)）、位置の流れ（[location-ingestion.md](location-ingestion.md)、[ADR-0009](../decisions/0009-location-upload-and-validation.md)）。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0011](../decisions/0011-geo-index-sharding-lease-and-rebuild.md) | 索引は都市（S1）、S2 からは H3 の解像度 6 のセルの集まりで分ける。分割ごとに主と待機の 2 つのタスクが同じ流れを読む。持ち主は DynamoDB の条件つき書き込みのリース（5 秒、1 秒ごとに更新）で決め、ゴシップは使わない。再構築は Kinesis の `AT_TIMESTAMP` で直近 35 秒を読み直し、供給と Trips の写しを重ねる |
| [0012](../decisions/0012-geo-index-nearby-query-api.md) | 検索は gRPC の `FindNearby`。解像度 9 の輪を 1 つずつ広げ、条件に合う空車を直線の距離の近い順に N 人返す。輪の外周までの距離で、取りこぼしのない打ち切りを保証する。依頼の前の地図の車は、セルの中心に丸め、ID を付けずに返す |

## 1. 目的と範囲

- 扱う：索引の項目と状態の合わせ方、古い項目の削除、分割、持ち主とリース、待機と引き継ぎ、再構築、検索の API、需給の集計の書き出し、依頼の前の地図の車。
- 扱わない：位置の受け取りと検証（[location-ingestion.md](location-ingestion.md)）、候補の条件の中身（[dispatch-and-matching.md](dispatch-and-matching.md) の 5 節）、ETA（[eta-and-routing.md](eta-and-routing.md)）、変動運賃が集計をどう使うか（`pricing-and-fares.md`）、乗客のアプリの地図の描き方（`rider-and-driver-apps.md`）。
- **索引は正本ではない。** 索引の中身だけで割り当てを確定しない（[AGENTS.md](../../AGENTS.md)）。索引が古い・二重になっても、割り当ての正しさは Trips の `assignment_epoch` と DB の一意の制約が守る。索引の誤りは、無駄なオファーと遅れとして現れる。

## 2. 本家の形（確かめたこと）

| 項目 | 本家（公開情報） | この設計 |
| --- | --- | --- |
| 地理の単位 | 2015 年は S2 のセル（レベル 12）の ID で分けた。その後、六角形の階層的な索引 H3 を作って公開した（[How Uber Scales Their Real-time Market Platform](http://highscalability.com/blog/2015/9/14/how-uber-scales-their-real-time-market-platform.html)、[H3](https://www.uber.com/blog/h3/)） | H3（ADR-0002） |
| 供給の索引 | 「Geo by Supply」は、すべての状態の供給を持ち、毎秒 100 万件の書き込みに耐えるよう作った。候補の一覧を経路・ETA のサービスに送り、道路の上の近さを求めた（High Scalability の同じ記事） | 同じ流れ。候補を直線の距離で絞り、ETA は [eta-and-routing.md](eta-and-routing.md) |
| 分割の仕組み | Ringpop（一貫ハッシュとゴシップ）でアプリケーションの層を分けた（同上）。後に、Ringpop にはクラスタの大きさによる拡張の制約があったと書いている（[Fulfillment Platform](https://www.uber.com/us/en/blog/fulfillment-platform-rearchitecture/)） | ゴシップを使わず、リースで持ち主を決める（ADR-0011） |

いずれも 2026-09-27 に確認。

H3 の性質（[H3 の Overview](https://h3geo.org/docs/core-library/overview/)、[Traversal functions](https://h3geo.org/docs/api/traversal/)、2026-09-27 に確認）：

- 12 個の五角形は、正二十面体の頂点に置かれ、向きの選び方で、すべて海の上にある。日本の陸の上の検索は五角形に当たらない。
- `gridDisk(origin, k)` は、格子の距離が k 以内のセルをすべて返す。最大の数は `1 + 3k(k+1)`（k = 5 で 91）。五角形をまたぐと穴が空く。

## 3. 構成

```
Kinesis loc-<city> ──(拡張ファンアウト)──┬──▶ geo-index 主（分割 A のリースを持つ）
Trips の状態の変化 ─────────────────────┤        │ 200 ms ごとに不変の写し（snapshot）を公開
供給（出庫・入庫・車両の属性）────────────┘        ▼
                                          gRPC FindNearby / SupplyPreview / SupplyByCell
                         ┌──────────────────────┘
                         ▼
               dispatch（区域のバッチ）、乗客の API（依頼の前の地図）、Pricing（集計）
                         ▲
                         └──── geo-index 待機（同じ流れを読む。主が答えないときに答える）
```

- geo-index は Go のサービス（[ADR-0001](../decisions/0001-platform-and-stack.md)）。1 タスクが 1 つ以上の分割を持つ。S1 は東京の 1 分割に主と待機の 2 タスク。
- 書き込みは分割ごとに 1 つの goroutine（書き手）が順に適用する。検索は、書き手が 200 ms ごとに公開する不変の写しを読む。ロックの取り合いがなく、1 回のバッチの検索が同じ写しを見る（再生のために写しの `generation` を記録する）。

## 4. 索引の中身

### 4.1 項目

```go
type DriverEntry struct {
    DriverID        string
    SessionID       string
    Cell9           h3.Cell   // 最新の位置の解像度 9 のセル
    LatE7, LngE7    int32
    HeadingCdeg     uint16
    SpeedCms        uint32
    SampleTime      time.Time // 補正した時刻（location-ingestion の 4.3 節）
    LastSampleSeq   uint64

    DriverState     DriverReportedState // VACANT / HIRED_STREET / BREAK（端末の操作）
    DriverStateSeq  uint64
    TripState       TripAssignState     // NONE / OFFERED / ACCEPTED / ARRIVING / ARRIVED / ON_TRIP（Trips が正本）
    RegionGen       uint64              // 割り当ての世代（ADR-0039）
    AssignmentEpoch uint64              // Trips のドライバーの epoch
    TripVersion     uint64

    OperatorID      string
    OfficeID        string        // 営業所
    ServiceKind     ServiceKind   // TAXI / RIDESHARE（日本版ライドシェア）
    VehicleClass    VehicleClass  // STANDARD / LARGE / UD（車いす対応）/ PREMIUM
    Seats           uint8
    EligibilityVer  uint64        // 供給の側の属性と運行枠の版（dispatch-and-matching の 5 節）
    Flags           EntryFlags    // LOCATION_UNTRUSTED、HALO（隣の分割の写し）
}
```

- 1 項目は 300 バイト程度。S1 の 1 万台で数 MB、S3 で 1 都市 5 万台でも数十 MB に収まる。セルからドライバーの集合への写像（`map[h3.Cell][]*DriverEntry`）を別に持つ。

### 4.2 状態の合わせ方

索引の状態は、3 つの源から来る。源ごとに版の番号を持ち、古い事象を無視する。どの源の事象も冪等に適用できる。

| 源 | 事象 | 版 | 適用の規則 |
| --- | --- | --- | --- |
| 位置の流れ | 位置、端末の状態 | `sample_seq`、`state_seq` | 位置は `USE_FOR_INDEX` で、`sample_seq` が大きいときだけ。端末の状態は `state_seq` が大きいときだけ |
| Trips | 割り当ての状態 | `(region_gen, assignment_epoch, trip_version)` | 組が辞書順で大きいときだけ（[ADR-0039](../decisions/0039-city-cells-and-osaka-warm-standby.md)） |
| 供給 | 出庫・入庫・属性・運行枠・`location_untrusted` | `eligibility_ver` | 大きいときだけ。入庫で項目を消す |

配車に使う状態（有効な状態）は次で決める。

| 条件 | 有効な状態 | 配車の候補か |
| --- | --- | --- |
| 供給がオンラインでない | 項目なし | いいえ |
| `TripState` が `OFFERED`〜`ON_TRIP` | `TripState` | いいえ（ADR-0004：実車の候補は S1 では使わない） |
| それ以外で `DriverState` が `HIRED_STREET` | 実車（流し） | いいえ |
| それ以外で `DriverState` が `BREAK` | 休憩 | いいえ |
| それ以外で `DriverState` が `VACANT` | 空車 | はい（位置が 15 秒以内で、`LOCATION_UNTRUSTED` でないとき） |

- 端末の `VACANT` は、Trips の割り当ての状態を上書きしない。乗車が終わって Trips が `NONE` を出した後に、端末の状態が効く。
- Trips の事象は、outbox から SNS `trips-events` と索引の SQS で届く（[trips-lifecycle.md](trips-lifecycle.md) の 8.1 節）。この領域が求めるのは、ドライバーごとに `(region_gen, assignment_epoch, trip_version)` を持った事象が、少なくとも 1 回届くことだけである。大阪へ切り替えた後は `region_gen` が上がるので、東京の古い世代の事象が遅れて届いても適用されない。

### 4.3 古い項目

| 位置の古さ | 扱い |
| --- | --- |
| 15 秒以内 | 通常 |
| 15 秒を超える | 配車の候補に出さない（NFR-002）。集計では `stale` に数える |
| 120 秒を超える | 依頼の前の地図に出さない |
| 10 分を超える、または入庫 | 項目を消す（供給がまだオンラインなら、次の位置で作り直す） |

S2 で都市の境目を走る車は、2 つの分割に現れうる。古い方は 15 秒で候補から外れ、10 分で消える。

## 5. 分割・持ち主・再構築

### 5.1 分割

| 段階 | 分割の単位 | 分割の数の目安 |
| --- | --- | --- |
| S1 | 都市（特別区・武三交通圏を含む東京）で 1 つ | 1 |
| S2 | 都市ごと。東京は H3 の解像度 6 のセルの集まりで数個に分ける | 12 都市で 15〜20 |
| S3 | 都市のまとまりごと。解像度 6 の集まり | 数十 |

- 分割の表（`geo_shard_map`）は、分割の ID と、属する解像度 6 のセルの一覧を版つきで持つ。表の変更は、新しい版を作って両方の索引が温まってから切り替える（runbook）。
- **境目の写し（halo）**：分割は、自分のセルに加え、周りの解像度 6 の 1 輪（辺 約 3.7 km）の中のドライバーを、`HALO` の印つきで持つ。検索の半径（既定 k = 5、約 2 km。最大 k = 30、約 10 km）が 1 輪の中に収まる限り、他の分割に問い合わせずに答えられる。k が 1 輪を超える検索（郊外）は、隣の分割にも問い合わせて合わせる。
- 位置の流れは都市ごとなので（[location-ingestion.md](location-ingestion.md) の 6 節）、分割は自分の都市のストリームから、自分と halo のセルの点だけを取り込む。

### 5.2 リース

- **索引の正しさは、持ち主が 1 つであることに依らない。** 主と待機は同じ流れを読むので、ほぼ同じ中身を持つ。リースは、(1) どのタスクがどの分割を持つか、(2) 集計の書き出し（6.4 節）を 1 本にすること、(3) 検索の既定の宛先、を決めるために使う。
- DynamoDB の表 `geo_shard_leases`：

| 属性 | 中身 |
| --- | --- |
| `shard_id`（PK） | `geo/<city>/<shard>` |
| `owner_task` | ECS のタスクの ID |
| `lease_epoch` | 取るたびに 1 増える整数 |
| `expires_at_ms` | 持ち主の壁時計での期限 |

- **取る**：`expires_at_ms < now − 1000`（時計のずれの余裕 1 秒）か項目がないときに、条件つき書き込みで `lease_epoch + 1` と自分を書く。
- **更新**：1 秒ごとに、`owner_task = 自分 AND lease_epoch = 持っている値` を条件に `expires_at_ms = now + 5000` を書く。
- **手放す**：最後に更新に成功した時刻から 4 秒たっても更新できなければ、自分から主の役をやめる（集計の書き出しを止め、検索の応答に `role=STANDBY` を付ける）。
- 検索の応答には `lease_epoch` を付ける。読み手（配車）は、見たことのある最大の `lease_epoch` より小さい応答を捨てる。
- 時計は Amazon Time Sync に合わせる前提で、ずれの余裕を 1 秒にした。
- Aurora をリースに使わない理由：Aurora の writer の切り替え（数十秒）の間、更新が失敗し、索引は元気なのに主がいなくなる。DynamoDB はリージョンの中の複数の AZ で動き、Aurora の障害と独立している。

### 5.3 待機と引き継ぎ

- 待機は主と同じ流れを読み、同じ中身を温めておく（hot standby）。検索にも答えられる。
- 主が落ちたら、待機はリースの期限の後に取る。期限の 5 秒と、待機が 500 ms ごとに見に行く間隔と、ずれの余裕 1 秒で、主の役の引き継ぎは最大約 6.5 秒。
- **配車は、主の役の引き継ぎを待たない。** 配車の検索は主に 100 ms の期限で問い合わせ、答えがなければ待機に問い合わせる（6.1 節）。引き継ぎの間も検索は止まらない。止まるのは集計の書き出しだけである。
- ECS のサービスは、分割ごとに 2 タスクを別の AZ に置く。配備は 1 タスクずつ入れ替え、新しいタスクが温まってから古いタスクを止める。

### 5.4 再構築

主も待機も失ったとき、新しいタスクは次の順で温まる。

1. 開始の時刻 T0 を決め、Kinesis の全シャードを `AT_TIMESTAMP`（T0 − 35 秒）から読み始める。オンラインのドライバーは 4 秒ごとに送るので、30 秒で全員がそろう（ADR-0002）。5 秒は余裕。
2. 供給のオンラインのセッションと属性の写し（Aurora の reader）と、Trips の有効な割り当ての写し（ドライバーごとの `assignment_epoch`・`trip_version`）を読む。読んだ時刻を覚える。
3. 供給と Trips の事象の購読を、写しを読んだ時刻より前から始める。重なった事象は、4.2 節の版の規則で冪等に捨てられる。
4. 位置の流れの遅れが 1 秒未満になり、T0 − 35 秒からの点を読み終えたら `READY` にし、リースを取りに行く。

- 目標：開始から `READY` まで 15 秒以内（35 秒 × 2,500 件/秒 ＝ 約 9 万件の読み直し。実際の時間は **未検証**。E3 の障害注入で計る）。
- Valkey に最新の位置の写しを置く案（ADR-0002 の持ち越し）は採らない。Kinesis の読み直しで十分に速く、ストアを 1 つ減らせる。
- 再構築の間、その都市の配車は候補を得られず、バッチを飛ばす（[dispatch-and-matching.md](dispatch-and-matching.md) の 10 節）。依頼は Trips に残り、失われない。

## 6. 検索の API

内部の gRPC だけ。乗客・ドライバーのアプリから直接は呼べない。

### 6.1 FindNearby

```proto
service GeoIndex {
  rpc FindNearby(FindNearbyRequest) returns (FindNearbyResponse);
  rpc SupplyPreview(SupplyPreviewRequest) returns (SupplyPreviewResponse);
  rpc SupplyByCell(SupplyByCellRequest) returns (SupplyByCellResponse);
  rpc GetDriverLocation(GetDriverLocationRequest) returns (GetDriverLocationResponse); // 6.5 節
}

message FindNearbyRequest {
  sint32 lat_e7 = 1;
  sint32 lng_e7 = 2;
  uint32 limit = 3;            // 既定 10、最大 50
  uint32 k_max = 4;            // 既定 5、最大 30
  CandidateFilter filter = 5;
  uint64 min_generation = 6;   // 0 なら最新の写し
}

message CandidateFilter {
  repeated VehicleClass vehicle_classes = 1;   // 空なら全部
  repeated ServiceKind service_kinds = 2;      // TAXI、RIDESHARE
  repeated string operator_ids = 3;            // 空なら全部（許可の一覧）
  repeated string exclude_driver_ids = 4;      // 試した・除外のドライバー
  uint32 min_seats = 5;
  uint32 max_staleness_ms = 6;                 // 既定 15000。これより大きい値は拒否
}

message FindNearbyResponse {
  repeated Candidate candidates = 1;  // 直線の距離の近い順
  uint32 guaranteed_radius_m = 2;     // この半径の中の条件に合う空車は、すべて検討した
  bool truncated = 3;                 // k_max で打ち切った
  uint64 generation = 4;
  uint64 lease_epoch = 5;
  Role role = 6;                      // PRIMARY / STANDBY
}

message Candidate {
  string driver_id = 1;
  sint32 lat_e7 = 2; sint32 lng_e7 = 3;
  uint32 heading_cdeg = 4;
  uint32 straight_line_m = 5;
  uint32 sample_age_ms = 6;
  uint64 assignment_epoch = 7;     // Trips への提案に添える（ADR-0003）
  uint64 region_gen = 12;          // 同上（ADR-0039）
  string operator_id = 8; ServiceKind service_kind = 9; VehicleClass vehicle_class = 10;
  uint64 eligibility_ver = 11;
}
```

- 期限：呼び手は 100 ms（主）→ 100 ms（待機）で呼ぶ。索引の中の処理は p99 5 ms 以内を目標にする。
- 空車（4.2 節の表）でないドライバーは、フィルターに関係なく返さない。
- `CandidateFilter` は、索引が持つ属性だけで絞る粗い条件である。営業区域と日本版ライドシェアの運行枠の判定は、配車の側で行う（[dispatch-and-matching.md](dispatch-and-matching.md) の 5 節）。

### 6.2 輪を広げる検索と打ち切り

```
origin := h3.LatLngToCell(p, 9)
found := []
for k := 0; k <= k_max; k++ {
    for cell in gridRing(origin, k) {          // 中空の輪。k=0 は origin だけ
        for d in snapshot.cells[cell] { if eligible(d, filter) { found = append(found, d) } }
    }
    r_k := distance(p, outerBoundary(gridDisk(origin, k)))   // 点から disk の外周までの最短距離
    near := count(found, d.straightLine <= r_k)
    if near >= limit { return top(found, limit), guaranteed_radius = r_k }
}
return top(found, limit), guaranteed_radius = r_{k_max}, truncated = true
```

- **打ち切りの正しさ**：disk(k) は点を含むつながった領域なので、disk(k) の外のドライバーは、点から外周までの距離 `r_k` 以上離れている。`r_k` の内側に N 人いれば、その N 人は全体の中でも近い順の上位 N 人である。
- 外周までの距離は、輪 k のセルの外側の辺ごとの距離の最小で求める。k ごとに最大 `6k` セルの辺を見るので、k = 30 でも数千回の距離の計算で済む。
- 輪の番号だけで打ち切る（輪 k の中に N 人いれば返す）方式は採らない。輪 k の角のドライバーより、輪 k + 1 の辺の中ほどのドライバーの方が近いことがあるため。
- 解像度 9 のセルの中心の間は約 0.35 km なので、既定の k = 5 は約 1.7〜2 km。

### 6.3 依頼の前の地図の車（SupplyPreview）

乗客のアプリは、依頼の前に近くの車を地図に出す。乗車の相手でない人に正確な位置を見せない規則（NFR-009）と両立させる。

- 返すのは、条件に合う空車の、**解像度 9 のセルの中心**（約 200 m に丸めた点）と、45 度に丸めた向きだけ。ドライバーの ID、車両、事業者は返さない。
- 最大 10 台、半径は k = 8（約 3 km）まで。同じセルに複数いれば、台数として返す。
- 結果は、乗客の位置の解像度 8 のセルごとに 10 秒間キャッシュする。同じ車を 4 秒ごとに追いかけられないようにする。
- 迎車の ETA の目安（「約 5 分」）は、[eta-and-routing.md](eta-and-routing.md) の 4.4 節が、この結果ではなく `FindNearby` と ETA の行列で出す。

### 6.4 需給の集計（SupplyByCell）

- 主の役のタスクが、10 秒ごとに、解像度 7 のセル × 有効な状態 × 車両の種類 × サービスの種類の台数を作る。Valkey に置き、Pricing と運用の画面が読む。使い方は `pricing-and-fares.md` で決める。
- 5 分ごとに、解像度 8 のセル × 状態の台数を S3 の `supply-heat/` に書く（[location-ingestion.md](location-ingestion.md) の 7 節）。ドライバーの ID を含めない。

### 6.5 割り当て済みのドライバーの位置（GetDriverLocation）

- `GetDriverLocation(driver_id, trip_id)` → 最新の位置、`sample_age_ms`、`assignment_epoch`。迎車中・乗車中の ETA の更新（[eta-and-routing.md](eta-and-routing.md) の 4.3 節）と、Trips の到着・無断キャンセルの判定（[trips-lifecycle.md](trips-lifecycle.md) の 3.3・7.1 節）、乗車の共有と安全の監視（[safety-and-trust.md](safety-and-trust.md) の 3・10 節）に使う。位置の Valkey の写しは持たない（5.4 節）ので、到着の判定もこの API で行う。
- 索引は、指定の `trip_id` の割り当てが索引の `TripState`（`ACCEPTED`〜`ON_TRIP`）と一致するときだけ答える。一致しなければ `FAILED_PRECONDITION`。乗車の外のドライバーの位置を、この API から引けないようにする。

## 7. 上限

| 項目 | 上限 |
| --- | --- |
| `FindNearby` の `limit` | 50 |
| `FindNearby` の `k_max` | 30（約 10 km） |
| `max_staleness_ms` | 15,000 |
| 1 分割のドライバーの数 | 5 万（超えたら分割を分ける。capacity で見直す） |
| 写しの公開の間隔 | 200 ms |
| 1 タスクへの検索 | 5,000 回/秒（**未検証**。E3 の負荷試験で決める） |

## 8. 障害のときの振る舞い

| 障害 | 起きること | 回復・影響の抑え方 |
| --- | --- | --- |
| 主のタスクが落ちた | 主への検索が失敗する | 配車は 100 ms で待機に切り替える。待機は約 6.5 秒で主の役を取る |
| 主と待機がともに落ちた | その都市の候補が出ない | 5.4 節の再構築（目標 15 秒）。配車はバッチを飛ばし、依頼は残る |
| 位置の流れの遅れ | 索引の位置が古くなる。15 秒を超えたドライバーが候補から消える | 遅れ（流れの末尾からの経過）を 1 秒ごとに計り、3 秒で警告、10 秒で重大（runbook `geo-index-lag.md`）。取り込みの側は [location-ingestion.md](location-ingestion.md) の 10 節 |
| Trips の事象の遅れ・欠け | 割り当て済みのドライバーが空車に見える | 配車の提案が epoch の不一致で Trips に拒否され、無駄なオファーの試みになる（正しさは崩れない）。60 秒ごとに Trips の有効な割り当ての写しと照合し、差を直して数える |
| 供給の事象の遅れ | 入庫したドライバーが残る、属性が古い | 同じく 5 分ごとに供給の写しと照合する。入庫の後は位置が止まるので、15 秒で候補から外れる |
| DynamoDB の障害 | リースを更新できない | 主は 4 秒で主の役をやめる。検索は両方のタスクが続けて答えるので、配車は止まらない。止まるのは集計の書き出し（6.4 節）だけ |
| 主が 2 つある（時計のずれ） | 集計が 2 回書かれる | 集計は `(cell, bucket)` を鍵に上書きするので、害は小さい。`lease_epoch` の小さい方の書き込みを読み手が捨てる |
| 分割の表の切り替えの途中 | 一部のセルを 2 つの分割が持つ | halo と同じく、両方が答えてよい。配車は分割の表の版の新しい方を使う |

## 9. セキュリティと位置のプライバシー

- API は内部の gRPC だけにし、サービスの ID（Service Connect の TLS とサービスのトークン、RPC ごとの許可の一覧。[ADR-0037](../decisions/0037-authentication-device-integrity-and-fraud-response.md)）で呼び手を限る。`FindNearby` を呼べるのは dispatch と ETA（迎車の目安）だけ。`SupplyPreview` は乗客の API だけ。`SupplyByCell` は Pricing と運用の画面だけ。`GetDriverLocation` は Trips・ETA・乗車の共有（share-service）・安全の監視（safety-monitor）だけ（[safety-and-trust.md](safety-and-trust.md) の 3・10 節）。
- 乗客の API に `FindNearby` を公開しない。乗客に返すのは 6.3 節の丸めた点だけ。
- ログ・メトリクスには、セルの ID を解像度 8 までに丸めて書く。検索の要求の緯度経度も書かない。
- 索引のメモリのダンプ（障害の調べ）は取らない設定にする（Go のコアダンプを無効にし、`pprof` のヒープのプロファイルは本番で取らない）。
- 模擬の位置の印のあるセッション（`LOCATION_UNTRUSTED`）は、配車の候補にも依頼の前の地図にも出さない。

## 10. テスト

### 10.1 性質ベーステスト

- **PROP-GEO-001（取りこぼしなし）**：任意のドライバーの配置・点・`limit`・`k_max` で、`FindNearby` の結果は、総当たりで `guaranteed_radius_m` の内側にいる条件に合うドライバーを距離の順に並べた上位 `limit` 人と一致する（ADR-0002 の Confirmation を、打ち切りの規則まで含めて強めたもの）。
- **PROP-GEO-002（状態の合わせ方）**：3 つの源の事象を、任意の順序・重複・遅れで適用しても、最後の有効な状態は、版の最大の事象だけを適用した結果と一致する。
- **PROP-GEO-003（割り当て済みは候補に出ない）**：Trips の `OFFERED`〜`ON_TRIP` の事象を適用した後、端末の `VACANT` をどの順で適用しても、そのドライバーは `FindNearby` に出ない（`NONE` が届くまで）。
- **PROP-GEO-004（再構築の同値）**：任意の事象の列で、途中から 5.4 節の手順で作り直した索引の、空車の集合と位置は、止めずに動かした索引と一致する（位置が 35 秒以内に 1 回以上届いたドライバーについて）。
- **PROP-GEO-005（リース）**：任意のタスクの停止・時計のずれ（1 秒以内）・DynamoDB の遅れの列で、同じ時刻に主の役を名乗るタスクの `lease_epoch` は互いに異なり、読み手が受け入れるのは最大の `lease_epoch` だけである。
- **PROP-GEO-006（丸め）**：`SupplyPreview` の応答に、ドライバーの ID と、セルの中心以外の座標が含まれない。

### 10.2 障害注入

- 主の強制終了：配車の検索の失敗の率、待機への切り替えの時間、主の役の引き継ぎの時間（目標 6.5 秒以内）。
- 主と待機の同時の強制終了：`READY` までの時間（目標 15 秒）と、PROP-GEO-004。
- DynamoDB の失敗の注入：検索が止まらないこと。
- Trips の事象の欠落の注入：照合で直ること、配車の提案の拒否の数。

### 10.3 負荷

- S1 のピークの 2 倍（位置 5,000 件/秒、検索 1,000 回/秒）で、索引への適用の遅れの p99、写しの公開の遅れ、`FindNearby` の p99、Go の GC の停止を計る（[ADR-0001](../decisions/0001-platform-and-stack.md) の Confirmation）。

## 11. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E3 | `geo-index-core` | 4 節の項目、状態の合わせ方、古い項目、写しの公開（PROP-GEO-002・003） |
| E3 | `geo-find-nearby` | 6.1・6.2 節の検索と打ち切り（PROP-GEO-001） |
| E3 | `geo-shard-lease` | DynamoDB のリース、主と待機、配車の側の切り替え（PROP-GEO-005） |
| E3 | `geo-index-rebuild` | 5.4 節の再構築、`READY` の判定（PROP-GEO-004） |
| E3 | `geo-reconcile-snapshots` | Trips と供給の写しとの定期の照合 |
| E3 | `geo-supply-aggregates` | 6.4 節の集計と `supply-heat`。S1 は運用の画面が読む（変動運賃には使わない。pricing の 6.1 節） |
| E3 | `geo-index-fault-injection` | 10.2・10.3 節 |
| E9 | `rider-supply-preview` | 6.3 節の丸めた車と、乗客の API のキャッシュ（PROP-GEO-006） |
| E14 | `geo-shard-map-halo` | 5.1 節の分割の表と halo、隣の分割への問い合わせ |

## 12. 未解決の問い

### 決定（2026-09-27、既定案）

- **分割**：S1 は東京の 1 分割、主と待機。S2 から解像度 6 の集まりと halo。
- **リース**：DynamoDB の条件つき書き込み。期限 5 秒、1 秒ごとの更新、4 秒で自分から降りる、ずれの余裕 1 秒。
- **索引の正しさはリースに依らない**：配車は主が答えなければ待機に問い合わせる。
- **再構築**：Kinesis を T0 − 35 秒から読み直す。Valkey に写しを置かない。
- **検索**：輪を広げ、外周までの距離で打ち切る。既定 `limit` 10・`k_max` 5、上限 50・30。
- **依頼の前の地図の車**：解像度 9 のセルの中心、ID なし、10 台まで、10 秒のキャッシュ。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| 車の少ない郊外で、解像度 9 のセルの中心でもドライバーを特定できてしまうか（1 セルに 1 台） | 法務の確認（L4）と、E9 の画面の設計で、郊外では台数だけにするかを決める |
| 降車の近い実車のドライバーを候補に入れるか（ADR-0004 の S2 の検討） | 降車の地点と時刻の予測の精度を見て、S2 で |
| S2 の分割の境目（東京をいくつに分けるか） | E3 の負荷試験の 1 分割の上限と、S2 の車両の数から |
| Go の GC の停止が p99 を崩すか | E3 の負荷試験。崩すなら索引だけを Rust にする ADR（ADR-0001） |

## 13. quality.md・runbooks・data-model への項目

### quality.md

- 索引の遅れ（位置の流れの末尾からの経過）の p50・p99、写しの公開の遅れ。
- `FindNearby` の p99、待機への切り替えの率、`truncated` の率（候補が遠い地域の目安）。
- 照合で見つかった差の件数（Trips の割り当てとの差、供給との差）。0 に近いことが目標で、増えたら事象の配信の欠けを疑う。
- 主の役の引き継ぎの回数と時間、再構築の時間。
- PROP-GEO-001〜006 の実行の数と種。

### runbooks

- `geo-index-lag.md`：索引の遅れの警告のときの確かめ方（Kinesis の拡張ファンアウトの遅れ、書き手の CPU、GC）と、待機への切り替え、タスクの入れ替えの手順。
- `geo-index-rebuild.md`：主と待機を失ったときの再構築の確かめ方（`READY` の条件、Kinesis の読み直しの進み、写しの読み込み）と、長引いたときの判断（その都市の依頼の受付を止めるか）。
- `geo-shard-map-change.md`：S2 の分割の表を変えるときの手順（新しい版で両方を温め、配車の読み先を切り替え、古い版を消す）。
- `geo-lease-anomaly.md`：DynamoDB の障害や時計のずれで主が 2 つになったときの確かめ方。

### data-model（索引への追加の提案）

| 置き場所 | 中身 |
| --- | --- |
| メモリ `DriverEntry`（正本ではない） | 4.1 節 |
| DynamoDB `geo_shard_leases`（`shard_id` PK、`owner_task`、`lease_epoch`、`expires_at_ms`） | 5.2 節。配車のリース（`dispatch/<zone>`）も同じ表に置く（[dispatch-and-matching.md](dispatch-and-matching.md) の 4 節） |
| DynamoDB または Aurora `geo_shard_map`（`version`、`shard_id`、`cells6[]`、`halo_cells6[]`、`active_from`） | 5.1 節（S2 から） |
| Valkey `supply:<city>:<cell7>`（状態・車両・サービスごとの台数、10 秒） | 6.4 節 |
| Protocol Buffers `GeoIndex` のサービス | 6 節 |

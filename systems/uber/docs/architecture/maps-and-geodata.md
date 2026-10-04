# Maps and geodata: Uber

地図と地理のデータ。OSM の取り込みと更新、ODbL の義務、地図の誤りの見つけ方と直し方、住所の検索（商用の提供者の選び方と、結果の保存の制約）、乗降の地点、営業区域・交通圏などの規則の区域の多角形を決める。

前提となる決定は、経路と ETA は OSM の上の Valhalla、住所の検索と事前確定運賃の距離は商用の提供者（[ADR-0005](../decisions/0005-maps-and-routing.md)）、規則の区域は行政の境界の多角形（PostGIS）を正本にし、格子のセルの集合は速い判定の写しにする（[ADR-0002](../decisions/0002-hex-grid-geospatial-model.md)）。タイルの作成と速度の表は [eta-and-routing.md](eta-and-routing.md)。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0033](../decisions/0033-osm-import-and-service-area-polygons.md) | OSM は Geofabrik の日本の抽出を週 1 回取り込み、量の検査を通してから使う。地図の誤りは OSM の本体で直すことを基本にし、急ぐものだけタイルの上書き（閉鎖）で扱う。ODbL の帰属をアプリに出す。営業区域・交通圏などは、国土数値情報の行政区域を公示の構成で合わせた多角形をバージョンと有効の期間つきで PostGIS に持ち、`street` の写し（内側・境目）で速く判定し、境目は多角形で確かめる |
| [0034](../decisions/0034-geocoding-provider-and-pickup-points.md) | 住所の検索は自前の API の後ろに提供者を隠し、ゼンリン・Google・Amazon Location を PoC の基準（的中の率、遅れ、料金、結果の保存、他の地図との併用、SLA）で比べて選ぶ。乗降の座標は乗客が確かめたピンとして保存し、提供者の内容は提供者ごとの保存の規則でだけ持つ。乗降の地点は運用が整えたデータと、実績から作る候補（運用の確認が要る）で出す |

## 1. 目的と範囲

- 扱う：OSM の取り込みと検査、ODbL、地図の誤りの検出と直し方、住所の検索と逆の検索の窓口と提供者の選定、結果の保存の規則、乗降の地点、規則の区域の多角形とその判定。
- 扱わない：タイルの作成・速度の表・ETA（[eta-and-routing.md](eta-and-routing.md)）、乗客のアプリの地図の描き方（`rider-and-driver-apps.md`）、事業者ごとの営業区域と運行枠の登録（`supply-and-operators.md`。この文書は区域の多角形を持ち、どの事業者がどの区域かは供給の側が持つ）、運賃の区域の使い方（`pricing-and-fares.md`）。

## 2. 事実（確かめたこと）

| 項目 | 事実 |
| --- | --- |
| OSM のライセンス | ODbL。帰属の表示（「© OpenStreetMap contributors」など、openstreetmap.org/copyright への案内）が要る。データを変えたり足したりした結果を配るときは、同じライセンスでだけ配れる（[OSM の Copyright and License](https://www.openstreetmap.org/copyright)） |
| ODbL の区別 | 派生データベースを公に使うときは ODbL の条件で（4.4）。収集のデータベース、組織の中だけの使用、製作物（Produced Work）は 4.4 の対象外（4.5）。ただし、派生データベースから作った製作物を公に使うときは、派生データベースそのものか、変えた内容の説明を受け手に提供する（4.6）（[ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/)、[OSMF の Licence and Legal FAQ](https://osmfoundation.org/wiki/Licence/Licence_and_Legal_FAQ)） |
| 日本の OSM の抽出 | Geofabrik の `japan-latest.osm.pbf` は約 2.5 GB で毎日更新され、差分（`.osc.gz`）と地方ごとの抽出（関東 約 489 MB など）もある（[Geofabrik の Japan](https://download.geofabrik.de/asia/japan.html)） |
| 地図の誤りの検出（本家） | 当てはめの異常から、誤った右折の禁止、欠けた道路、一方通行の誤りを見つけ、3 か月で 2 万 8 千件以上の誤りを見つけた（[CatchME](https://www.uber.com/us/en/blog/mapping-accuracy-with-catchme/)、2019-04-25） |
| 行政区域のデータ | 国土数値情報の行政区域データ（N03）は、全国の都道府県・市区町村の境界と全国地方公共団体コードを持つ。GML・Shapefile・GeoJSON。年 1 回（1 月 1 日時点）更新。CC BY 4.0 で商用に使えるが、二次利用に国土地理院への申請が要る場合があるとされる（[国土数値情報 行政区域データ](https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N03-2024.html)） |
| 格子と多角形の重なり | 自前の格子 `geogrid` のセルは、投影の平面の上の正六角形である（[ADR-0002](../decisions/0002-hex-grid-geospatial-model.md)、[geospatial-index.md](geospatial-index.md) の 2.1 節）。多角形を同じ平面に写せば、セルが多角形に「一部でも重なる」か「全体が内側」かを平面の幾何で正確に判定できる。本家の H3 は使わない（[ADR-0007](../../../../docs/decisions/0007-no-reuse-of-original-implementation.md)） |
| Google Maps Platform | Geocoding API の内容を Google 以外の地図と一緒に使ってはならない（6.2）。緯度経度は 30 日まで一時にキャッシュできる（6.3.1）。緯度経度・整形した住所は、要求したアプリの利用者向けの機能のためだけに、利用者ごとに分けて無期限に持てる（6.3.2）。Directions・Distance Matrix にも Google 以外の地図との併用の禁止がある（[Service Specific Terms](https://cloud.google.com/maps-platform/terms/maps-service-terms)） |
| Amazon Location Service | 結果を保存する（キャッシュも含む）ときは `IntendedUse` を `Storage` にし、高い料金になる。自動補完・候補（Suggest）は `Storage` にできない（[IntendedUse](https://docs.aws.amazon.com/location/latest/developerguide/places-intended-use.html)）。以前のバージョンの API では、提供者に HERE を選ぶと、日本の場所の結果を `Storage` で保存できない（[DataSourceConfiguration（previous）](https://docs.aws.amazon.com/location/previous/APIReference/API_DataSourceConfiguration.html)）。現行のバージョン（Places V2）の文書は、日本の住所・施設の網羅を Comprehensive とし（[Data quality and coverage](https://docs.aws.amazon.com/location/latest/developerguide/data-quality.html)）、日本の結果の保存の制限を書いていない（[IntendedUse](https://docs.aws.amazon.com/location/latest/developerguide/places-intended-use.html)、どちらも 2026-09-27 に確認）。契約の上で日本の結果を保存してよいかは **未検証**（E4 の `geocoding-provider-poc` で提供者の条件として確かめる） |
| ゼンリン | ZENRIN Maps API で、住所・建物・施設の検索、経路、渋滞・規制の情報を提供している（ADR-0005）。結果の保存と他の地図との併用の条件は公開の文書になく **未検証**（E4 の `geocoding-provider-poc` で契約の条件として確かめる） |

いずれも 2026-09-27 に確認。

## 3. 構成

```
Geofabrik ──週 1──▶ osm-import ──▶ S3 osm/japan/<date>/ ──▶ タイルの作成（eta-and-routing の 5.2 節）
                                            │
                                            └──▶ 地図の誤りの候補（6 節）◀── 当てはめの失敗（location-ingestion の 8 節）、ドライバーの通報

乗客のアプリ ──▶ 乗客の API /v1/places/* ──▶ places-service（TypeScript）──▶ 商用の提供者（1 社）
                                                  └──▶ 乗降の地点（pickup_points、PostGIS）

国土数値情報 N03 ＋ 運輸局の公示 ──▶ 区域の多角形（service_areas、PostGIS）──▶ `street` の写し ──▶ dispatch・Pricing・API
```

## 4. OSM の取り込みと更新

- **取り込み**：週 1 回（日曜 22:00 JST、タイルの作成の前）に、Geofabrik の `japan-latest.osm.pbf` と `.md5` を取り、照合して S3 の `osm/japan/<date>/` に置く。S3 はバージョンを残し、90 日分を保つ（タイルのバージョンの再現のため）。
- **差分を当て続けない**：毎週の全体の取り込みにする。2.5 GB の取り込みは問題にならず、バージョンが 1 つの日付で定まる（[ADR-0016](../decisions/0016-valhalla-serving-traffic-and-eta-accuracy.md)）。
- **量の検査**（どれかを外れたら、その週は前のバージョンを使い続け、運用に知らせる）：

| 検査 | 閾値 |
| --- | --- |
| ファイルの大きさの前週との差 | ±5% |
| 自動車の通れる `highway` の way の数の差 | ±2% |
| 東京 23 区の道路の総延長の差 | ±1% |
| 黄金の地点（主要な駅・空港・病院の 200 点）が、自動車の通れる道路から 100 m 以内にある | 全件 |

- 閾値は仮の値で、最初の 3 か月の分布で見直す（**未検証**。E4 の `osm-import-weekly`）。
- 地方の抽出は使わない。都市の境目の道路が切れるのを避けるため、日本全体から作る。

## 5. ODbL の義務

| 場面 | 当たりうるもの | 扱い |
| --- | --- | --- |
| 乗客・ドライバーのアプリで、Valhalla の経路の線や ETA を見せる | OSM から作った製作物 | アプリの地図の画面と「このアプリについて」に「© OpenStreetMap contributors」と openstreetmap.org/copyright への案内を出す |
| タイルに自前の速度の表と閉鎖の上書きを足す | 派生データベース（組織の中での使用） | 組織の中の使用は 4.4 の対象外。ただし、そこから作った製作物（ETA、経路の線）を公に使うので、4.6 の「派生データベースか変えた内容の説明の提供」が要るかが論点になる |
| 地図の誤りを直す | OSM の本体を直すなら、派生データベースは生じない | 6 節。直しは OSM の本体で行うことを基本にする |

- **4.6 の扱いは、法務の確認待ち。** [intent.md](../intent.md) の L3 に、「自前の速度の表・上書きを足したタイルと、そこから作った ETA・経路の表示の ODbL 上の扱い（4.6 の提供の義務の有無）」を加えた。
- 結論が出るまでの設計の備え：
  - 速度の表は、OSM の way の ID を鍵にした別のデータとして作り、タイルに入れる直前に合わせる（収集のデータベースとして扱える余地を残す。当たるかは法務の確認待ち（L3））。
  - 閉鎖の上書きは一覧（way の ID、向き、理由、期間）として持ち、求められたら「変えた内容の説明」としてそのまま出せるようにする。
  - OSM を直すべき誤りは、上書きのままにせず OSM の本体へ直す。

## 6. 地図の誤りの見つけ方と直し方

### 6.1 見つけ方

| 源 | 兆し | 誤りの種類の候補 |
| --- | --- | --- |
| 当てはめの失敗（[location-ingestion.md](location-ingestion.md) の 8 節） | 同じ場所で、異なるドライバー 5 人以上の当てはめが 1 週に 20 回以上失敗 | 欠けた道路、形のずれ |
| 当てはめた経路の遷移 | 地図では禁止の右折・一方通行の逆走を、多くのドライバーが通っている | 誤った右折の禁止、一方通行の誤り |
| ETA の誤差（[eta-and-routing.md](eta-and-routing.md) の 6 節） | 特定の乗車地の周りで、偏りが大きい | 車寄せ・入口の欠け、乗車地の位置の誤り |
| ドライバーの通報（アプリ） | 「通れない」「入口が違う」 | 閉鎖、乗降の地点の誤り |

- 本家の CatchME と同じ考え方で、当てはめの異常を地図の誤りの候補にする。1 週ごとに集計し、候補を運用の地図の担当の待ち行列に入れる。集計はドライバーの ID を持たない。

### 6.2 直し方

| 誤り | 直し方 | 反映 |
| --- | --- | --- |
| OSM の誤り（道路の欠け、一方通行、右折の禁止） | 地図の担当が、現地の確認か、使ってよい資料で確かめてから OSM の本体を直す。組織としての編集の OSM の指針に従う。指針は、複数の人の組織だった編集に、OSM の wiki のページ（連絡先・目的・期間・資料・参加するアカウント）、始める 2 週間前までの地域のコミュニティへの告知、変更のハッシュタグを求める（[Organised Editing Guidelines](https://osmfoundation.org/wiki/Organised_Editing_Guidelines)、2018-11-15 に OSMF の理事会が承認、2026-09-27 に確認）。wiki のページと告知は、E4 の `map-error-candidates` の運用を始める前に用意する | 翌週の取り込み |
| 急ぐ閉鎖（工事、災害、行事） | タイルの上書き（閉鎖の一覧）。期間を必ず持たせ、期限で自動に外す | 臨時のタイルの作成（[eta-and-routing.md](eta-and-routing.md) の 5.2 節） |
| 乗降の地点の誤り | `pickup_points` を直す（8 節） | 即時 |
| 右折の禁止の誤りなど、上書きで表せないもの | OSM の本体を直すまで待つ。その場所の ETA の補正の表の値で急場をしのぐ | 翌週 |

- 直した場所は、黄金の経路の集合（[eta-and-routing.md](eta-and-routing.md) の 5.2 節）に足す。

## 7. 住所の検索

### 7.1 窓口

- 乗客のアプリは、自前の API（`/v1/places/autocomplete`、`/v1/places/details`、`/v1/places/reverse`）だけを呼ぶ。提供者の API の鍵をアプリに置かない。提供者を替えても、アプリを変えずに済む。
- `places-service` は、提供者の応答を自前の形（`PlaceCandidate`：表示の名前、住所の文字列、座標、提供者、提供者の ID、`source`、有効の期限）にそろえる。
- 入力の文字列（自宅の住所などを含む）は、ログ・メトリクスに書かない。数えるのは件数と遅れだけ。
- 流量の制限：乗客 1 人あたり、自動補完は 1 秒に 5 回・1 日に 500 回。
- 乗客のアプリの近くの結果を優先するための位置は、`district` のセルの中心に丸めて提供者に送る。

### 7.2 提供者の PoC

候補はゼンリン、Google、Amazon Location Service（ADR-0005）。E4 の PoC で次の基準を比べる。**必須**の基準を満たさない提供者は選ばない。

| # | 基準 | 計り方 | 必須か |
| --- | --- | --- | --- |
| P1 | 住所の的中の率 | 東京の 2,000 件（番地・号、建物の名前、施設の名前、駅の出口、病院・ホテルの入口）の正解の座標を手で作り、最上位の候補が正解から 30 m 以内にある割合。目標 90% | 必須（80% 以上） |
| P2 | 自動補完の遅れ | 東京リージョンから p95 300 ms 以内 | 必須 |
| P3 | 表記の揺れ | 旧字体、かな、住居表示と地番、建物の略称 | — |
| P4 | 結果の保存 | 乗車の記録として、乗降の座標と表示の名前を運賃の記録の保存の期間だけ持てるか。持てない場合、乗客が確かめたピン（7.3 節）で代えてよいか | 必須（どちらかで可） |
| P5 | 他の地図との併用 | 乗客のアプリの地図（提供者が決まっていない）と、Valhalla の経路の線に重ねて使えるか | 必須 |
| P6 | 経路の API | 事前確定運賃の推計走行距離の要件（2 つ以上のルート、有料道路の選択、主要経由地点）を満たせるか（[ADR-0017](../decisions/0017-fare-distance-for-pre-fixed-fares.md)） | 推計走行距離も同じ提供者にするなら必須 |
| P7 | 料金 | S1 の量（自動補完 数十件/秒、詳細と逆の検索、推計走行距離は見積もり 90 件/秒のピーク（キャッシュの前）。[capacity.md](capacity.md) の 1.1 節）での月の費用 | — |
| P8 | SLA と障害の実績 | 契約の SLA、障害の連絡 | — |
| P9 | データの所在と外国への提供 | 位置と入力の文字列が送られる国、事業者との契約の形（L4） | 法務の確認待ち |
| P10 | 電子地図の要件 | 事前確定運賃の「一般的に流通し、定期的に更新される電子地図」に当たるか（L3） | 推計走行距離に使うなら必須 |

- 事実として分かっている条件（2 節）：Google は Google 以外の地図との併用を禁じ、緯度経度の保存に 30 日または利用者ごとの分離の条件がある。Amazon Location は保存に `Storage` の指定と高い料金が要り、以前のバージョンでは HERE の日本の結果を保存できなかった。ゼンリンの条件は **未検証**（E4 の `geocoding-provider-poc`）。
- 住所の検索と推計走行距離を同じ提供者にするかも、PoC で決める。別にすると、乗客が選んだ地点と経路の出発点が提供者の間でずれうる。
- 利用条件（保存、併用、帰属）は、選定の後に ADR-0034 の続きの ADR に写し、条件に反する保存のコードをレビューで差し戻す（ADR-0005 の Confirmation）。

### 7.3 乗降の座標の保存

| 保存するもの | 中身 | 期間 |
| --- | --- | --- |
| 乗客が確かめたピン | 乗客が地図の上で確かめた（動かせる）乗車地・降車地の座標。`origin=rider_confirmed_pin` | 乗車の記録と同じ（`trips-lifecycle.md`） |
| 表示の名前 | 乗客に見せた名前（「〇〇ホテル 正面玄関」） | 提供者の条件の期間。条件で持てなければ、乗降の地点のデータ（8 節）の名前か、乗客の入力の名前だけ |
| 提供者の ID（`place_ref`） | 提供者と、その場所の ID | 提供者の条件の期間 |
| 提供者の座標そのもの | 候補の座標 | 保存しない（ピンに置き換える） |

- 乗車の行（`trips`）に書ける座標は `rider_confirmed_pin` だけにする。提供者の内容（表示の名前、提供者の ID）は、乗車に結びつけた別の表 `trip_place_refs`（`trip_id`、`leg`（pickup・dropoff）、`provider`、`place_ref`、`display_name`、`expires_at`）に置き、`expires_at` は提供者ごとの保存の規則から決める。期限の後は削除のジョブで消し、乗車の画面は乗降の地点の名前（8 節）か乗客の入力の名前に戻す（2026-09-27 の統合の決定）。
- ピンを「乗客のデータ」として長く持つことが、提供者の条件に反しないかは、PoC の P4 と法務の確認待ち（L3）。
- 乗客の「よく使う場所」（自宅・職場）は、乗客のアカウントの機能で、同じ規則で持つ（`rider-and-driver-apps.md`）。

## 8. 乗降の地点

### 8.1 データ

```sql
CREATE TABLE pickup_points (
  point_id            text PRIMARY KEY,
  version             int  NOT NULL,
  name_ja             text NOT NULL,
  kind                text NOT NULL,   -- roadside / hotel_porch / station_app_pickup / taxi_stand / hospital / airport / venue
  geom                geometry(Point, 4326) NOT NULL,
  spot_cell              bigint NOT NULL,
  heading_constraint  int,             -- 車が向くべき向き（度）。一方通行・中央分離帯のある道路
  allowed_services    text[] NOT NULL, -- taxi / rideshare
  allowed_hours       tstzrange[],     -- 空なら終日
  pickup_overhead_s   int  NOT NULL DEFAULT 30,  -- ETA の固定の時間（eta-and-routing の 4.5 節）
  source              text NOT NULL,   -- ops / facility_agreement / learned
  status              text NOT NULL,   -- active / proposed / retired
  venue_id            text,            -- 駅・空港など、複数の地点をまとめる施設
  approved_by         uuid[],          -- 2 人の確認（staff_users）
  updated_at          timestamptz NOT NULL
);
```

### 8.2 乗客への提案

1. 乗客のピン p から 80 m 以内の `active` の地点（その時刻・そのサービスで使えるもの）を探す。
2. なければ、Valhalla の `locate` で p から 50 m 以内の、自動車の通れる道路の辺を探す。高速道路の本線・ランプ、トンネル、橋の上の辺を除く。
3. 候補を最大 3 つ、ピンからの距離の順に出す。乗客が選ぶか、ピンのまま依頼する。
4. 施設（`venue_id`）の中にピンがあれば、施設の地点だけを出す（空港・大きな駅では、決められた配車の乗り場だけを使う）。

- 道路の左側に停める前提で、`heading_constraint` のある地点は、ドライバーのアプリにも向きを出す。
- 駐停車の規制（交差点の近く、横断歩道の近くなど）を細かく判定することは MVP でしない。運用が整えた地点と、高速道路などの除外で足りるかを、S1 の乗車の実績（到着から乗車までの時間）で確かめる。

### 8.3 実績から作る候補

- 乗車の軌跡（[location-ingestion.md](location-ingestion.md) の 7 節）から、実際に乗車が始まった位置を `spot` のセルで数える。直近 90 日で、10 件以上・異なる乗客 5 人以上のセルを、`status=proposed`・`source=learned` の候補にする。
- 候補は運用の確認（2 人）を経て `active` にする。自動で公開しない。
- 集計は乗客とドライバーの ID を持たない。

## 9. 規則の区域の多角形

### 9.1 区域の種類

| `kind` | 中身 | 元 |
| --- | --- | --- |
| `eigyo_kuiki` | タクシーの営業区域（道路運送法第 20 条の判定の単位） | 運輸局の公示の構成（市区町村の一覧）＋ N03 |
| `kotsuken` | 交通圏（公定幅運賃、特定地域・準特定地域の単位） | 同上 |
| `rideshare_zone` | 日本版ライドシェアの運行が認められた区域 | 国土交通省・運輸局の公表の資料。運行枠（曜日・時間帯・台数）は供給の側が持つ |
| `fare_zone` | 運賃の規則の区域（迎車料金、事前確定運賃の係数の区域） | 認可・公示（`pricing-and-fares.md` が使う） |
| `taxi_pool` | 空港のタクシープールなどの待機場 | 運用が作る |
| `airport` | 空港の敷地（乗降の地点の施設） | 運用が作る |

- 東京の「特別区・武三交通圏」は、東京都の特別区と武蔵野市・三鷹市からなる（[関東運輸局の自家用車活用事業の許可事業者の一覧（特別区・武三交通圏）](https://wwwtb.mlit.go.jp/kanto/content/000380535.pdf) の注記、令和 8 年 8 月 31 日現在、2026-09-27 に確認）。
- 関東運輸局の公示は、営業区域を交通圏の単位で書く（[初乗距離の公示](https://wwwtb.mlit.go.jp/kanto/content/000287810.pdf) の「営業区域」の列、[係数の公示](https://wwwtb.mlit.go.jp/kanto/content/000256355.pdf) の「適用する営業区域」、2026-09-27 に確認）。S1 の東京では営業区域と交通圏は同じ範囲である。他の運輸局で違うかは **未検証**（E14 の `city-data-onboarding` で地域ごとに確かめる）。種類を分けて持ち、同じ範囲なら同じ多角形を 2 つの種類で参照する。
- 営業区域が市区町村の境界に沿わない地域があるかは **未検証**（関東の地図の公示は、旧北川辺町のように合併の前の町の単位を残す。[各都県の営業区域及び運賃適用地域](https://wwwtb.mlit.go.jp/kanto/content/000108041.pdf)）。E4 の `service-area-polygons` と E14 の `city-data-onboarding` で地域ごとに確かめる。あれば、運用が手で多角形を作り、元の資料を `source_ref` に残す。

### 9.2 データ

```sql
CREATE TABLE service_areas (
  area_id                    text NOT NULL,
  version                    int  NOT NULL,
  kind                       text NOT NULL,
  name_ja                    text NOT NULL,
  bureau                     text,                 -- 運輸局
  member_municipality_codes  text[],               -- 全国地方公共団体コード
  geom                       geometry(MultiPolygon, 4326) NOT NULL,
  source                     text NOT NULL,        -- n03_union / manual
  source_ref                 text NOT NULL,        -- 公示の番号・URL、N03 のバージョン
  effective_from             date NOT NULL,
  effective_to               date,                 -- null は現在も有効
  approved_by                uuid[] NOT NULL,      -- 2 人の確認（staff_users）
  created_at                 timestamptz NOT NULL,
  PRIMARY KEY (area_id, version),
  EXCLUDE USING gist (area_id WITH =, daterange(effective_from, effective_to) WITH &&)
);

CREATE TABLE service_area_cells (
  area_id   text   NOT NULL,
  version   int    NOT NULL,
  street_cell     bigint NOT NULL,
  coverage  text   NOT NULL,   -- inside / boundary
  PRIMARY KEY (area_id, version, street_cell)
);
```

- 同じ区域で有効の期間が重ならないことを、DB の排他の制約で守る。
- 作り方：N03 の該当の市区町村の多角形を合わせ（`ST_Union`）、単純化は 5 m 以内に留める。N03 の出典の表示（「国土数値情報（行政区域データ）（国土交通省）を加工して作成」）を、区域の画面と文書に出す。
- 変更（公示の変更、市町村の合併、N03 の年ごとの更新）は、新しいバージョンとして作り、有効の日から切り替える。変更の前後で面積と構成の差を出し、2 人が確かめる。

### 9.3 判定

```
func Contains(areaVersion, p) bool:
    c := geogrid.CellAt(p, geogrid.Street)
    switch cells[areaVersion][c]:
      case inside:   return true
      case boundary: return polygonContains(areaVersion.geom, p)   // 多角形で確かめる
      default:       return false                                   // 写しにないセルは外
```

- 写しは、`geogrid.Cover(polygon, Street, Overlapping)` で区域に触れるセルを全部取り、そのうち `Cover(polygon, Street, Full)`（全体が内側）のセルを `inside`、残りを `boundary` にする。`Cover` は、区域の多角形を格子の投影の平面に写し、六角形と多角形の重なりを平面の幾何で判定する。
- 区域の外のセルは写しに入らない。「一部でも重なる」で取るので、区域に触れるセルはすべて写しにあり、区域の中の点を外と誤ることはない（10.1 節の PROP-MAP-001 で確かめる）。
- 判定の最後は多角形（ADR-0002）。多角形の判定は、配車と API のプロセスの中で、単純化した多角形で行う（PostGIS を毎回引かない）。多角形は区域のバージョンごとにメモリに持つ。
- `Cover` は自前の関数なので、正しさを 2 つの方法で守る。PROP-MAP-001 と、バージョンの作成のときに、同じ写しを PostGIS（区域の多角形とセルの六角形（`geogrid.Boundary`）を同じ投影に写し、`ST_Intersects` と `ST_CoveredBy` で判定）で作り直して一致を確かめる。

## 10. 障害のときの振る舞い

| 障害 | 起きること | 回復・影響の抑え方 |
| --- | --- | --- |
| Geofabrik から取れない、検査を外れた | その週の OSM を更新できない | 前のバージョンを使い続ける。2 週続いたら警告 |
| 住所の検索の提供者の障害 | 自動補完が出ない | アプリはピンでの指定と、よく使う場所・最近の場所を出す。乗降の地点のデータの名前での検索（自前）を代わりに出す |
| 提供者の割り当て・料金の上限 | 同上 | 利用の量を 1 日ごとに計り、80% で警告 |
| 区域の多角形の誤り（公示の変更の反映漏れ） | 営業区域の判定を誤る | 変更に 2 人の確認。公示の変更の確かめを月 1 回の定期作業にする（runbook） |
| 区域の写しと多角形の食い違い | 判定の誤り | バージョンの作成のときに、ランダムな 10 万点で写しの判定と多角形の判定が一致することを確かめてから有効にする |

## 11. セキュリティと位置のプライバシー

- 提供者の API の鍵は、サーバーの秘密の保管だけに置く。アプリに置かない。
- 住所の検索の入力の文字列、乗降の座標は、ログに書かない。提供者に送る近くの位置は `district` に丸める。
- 乗降の地点の実績の候補（8.3 節）、地図の誤りの候補（6.1 節）は、ID を持たない集計だけで作る。
- 区域の多角形と乗降の地点の変更は、管理画面から 2 人の確認で行い、変更の記録を残す（`support-and-operations-tools.md`）。
- 提供者への送信が外国への提供に当たるかは、法務の確認待ち（L4）。

## 12. テスト

### 12.1 性質ベーステスト

- **PROP-MAP-001（区域の判定）**：任意の区域の多角形と任意の点で、`Contains` の結果は、多角形だけでの判定と一致する。
- **PROP-MAP-002（バージョンの重なりなし）**：任意の区域のバージョンの追加の列で、同じ区域の有効の期間は重ならず、任意の日に有効なバージョンは高々 1 つ。
- **PROP-MAP-003（乗降の地点の提案）**：任意のピンで、提案はピンから 80 m 以内の有効な地点か、50 m 以内の、除外の種類でない辺の上の点だけ。施設の中のピンでは、施設の地点だけ。
- **PROP-MAP-004（保存の規則）**：提供者の内容の型（提供者の座標・名前・ID）は、提供者ごとの保存の期間を持つストアにしか書けない（型と保存の関数で強制し、テストで確かめる）。乗車の記録に書ける座標は `rider_confirmed_pin` だけ。
- **PROP-MAP-005（取り込みの検査）**：途中で切れた・中身の大きく減った抽出は、4 節の検査で必ず止まる（壊した抽出を作って確かめる）。

### 12.2 結合

- E4 の PoC（7.2 節）の計測を、同じ 2,000 件の正解で再現できる形にする（提供者の変更のたびに流す）。
- N03 と公示の構成から特別区・武三交通圏の多角形を作り、面積と構成の市区町村を確かめる。

## 13. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E4 | `osm-import-weekly` | 4 節の取り込みと検査（PROP-MAP-005） |
| E4 | `osm-attribution` | 5 節の帰属の表示（apps の領域と一緒に） |
| E4 | `map-error-candidates` | 6.1 節の候補の集計と、運用の待ち行列 |
| E4 | `tile-closure-overrides` | 6.2 節の閉鎖の上書き（期間つき）と一覧の出力 |
| E4 | `places-service-api` | 7.1 節の窓口、提供者の抽象、流量の制限 |
| E4 | `geocoding-provider-poc` | 7.2 節の PoC、2,000 件の正解の作成 |
| E4 | `place-storage-policy` | 7.3 節と PROP-MAP-004 |
| E4 | `pickup-points-model` | 8.1・8.2 節（PROP-MAP-003） |
| E4 | `pickup-points-learned` | 8.3 節 |
| E4 | `service-area-polygons` | 9 節の表、N03 からの作成、写し、判定（PROP-MAP-001・002） |
| E4 | `geodata-change-approval` | 区域と乗降の地点の 2 人の確認の管理画面（support の Story と同じ 1 つ） |
| E12 | `rideshare-zone-polygons` | 日本版ライドシェアの区域の多角形 |

## 14. 未解決の問い

### 決定（2026-09-27、既定案）

- **OSM の取り込み**：Geofabrik の日本全体、週 1 回、量の検査、90 日のバージョンの保持。
- **地図の誤り**：OSM の本体で直すのが基本。急ぐ閉鎖だけ期間つきの上書き。
- **ODbL**：アプリに帰属を出す。速度の表は way の ID を鍵にした別のデータとして持ち、上書きは一覧として出せるようにする。
- **住所の検索**：自前の API の後ろに提供者を隠す。PoC の必須の基準は P1・P2・P4・P5。
- **乗降の座標**：乗客が確かめたピンとして保存し、提供者の座標は持たない。
- **乗降の地点**：80 m の地点、50 m の辺、最大 3 つ。実績の候補は運用の確認の後に公開。
- **区域**：N03 ＋ 公示の構成、バージョンと有効の期間、2 人の確認、`street` の写し（内側・境目）と多角形の確認。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| 自前の速度の表・上書きを足したタイルと、そこから作った表示の ODbL の扱い（4.6） | 法務の確認待ち（L3） |
| 提供者の選定（ゼンリン・Google・Amazon Location） | E4 の PoC。保存（P4）と併用（P5）は法務の確認を含む |
| 乗客のアプリの地図の描画の提供者 | 住所の検索の提供者と合わせて決める（Google を選ぶと、Google 以外の地図と併用できない）。`rider-and-driver-apps.md` と一緒に |
| 乗客が確かめたピンを長く持つことが、提供者の条件に反しないか | 法務の確認待ち（L3）と提供者の契約 |
| 営業区域・交通圏の構成の公示の本文と、市区町村の境界に沿わない区域の有無 | E4 で、運輸局の公示を確かめる |
| OSM の組織としての編集の指針への対応 | E4 で OSMF の指針を確かめる |
| 駐停車の規制の判定を入れるか | S1 の乗車の実績を見て |

## 15. quality.md・runbooks・data-model への項目

### quality.md

- 住所の検索の的中の率（PoC の 2,000 件を四半期ごとに再計測）、自動補完の p95。
- 乗客が提案の乗降の地点を選んだ割合、到着から乗車までの時間の中央値（乗降の地点の良さの目安）。
- 地図の誤りの候補の件数と、直すまでの日数。
- OSM の取り込みの検査の結果（週ごと）。
- 区域の写しと多角形の判定の一致（バージョンの作成ごとに 10 万点）。
- PROP-MAP-001〜005 の実行の数と種。

### runbooks

- `osm-import-failed.md`：取り込みの検査を外れたときの確かめ方（Geofabrik の状態、OSM の大きな編集・破壊）と、前のバージョンを使い続ける判断。
- `map-closure-override.md`：工事・災害・行事の閉鎖を上書きに入れ、臨時のタイルを作る手順と、期限の確かめ方。
- `geocoding-provider-outage.md`：住所の検索の提供者の障害のときの確かめ方と、アプリの代わりの表示への切り替え。
- `service-area-update.md`：公示の変更・市町村の合併・N03 の更新を区域の新しいバージョンにする手順（2 人の確認、判定の一致の確かめ、有効の日の設定）。月 1 回の公示の確かめの定期作業も含める。

### data-model（索引への追加の提案）

| 置き場所 | 中身 |
| --- | --- |
| S3 `osm/japan/<date>/`（pbf、md5、検査の結果） | 4 節 |
| Aurora（PostGIS）`service_areas`・`service_area_cells` | 9.2 節 |
| Aurora（PostGIS）`pickup_points` | 8.1 節 |
| Aurora `map_overrides`（`override_id`、`way_id`、`direction`、`kind`（closure）、`reason`、`valid_from`、`valid_to`、`approved_by`） | 6.2 節 |
| Aurora `map_error_candidates`（`candidate_id`、`street_cell`、`kind`、`evidence_counts`、`status`、`osm_changeset`） | 6.1 節 |
| Aurora（Trips）の乗降の列：`pickup_pin`・`dropoff_pin`（`origin=rider_confirmed_pin`）、`pickup_point_id`、`pickup_area_ids`・`dropoff_area_ids` | 7.3 節（表の持ち主は `trips-lifecycle.md`） |
| Aurora `trip_place_refs`（`trip_id`、`leg`、`provider`、`place_ref`、`display_name`、`expires_at`） | 7.3 節。提供者の内容だけを置く。提供者ごとの期限で消す（持ち主は places） |
| S3 `places/poc/ground-truth.parquet` | 7.2 節の 2,000 件の正解（合成・公開の場所だけ。個人の住所を含めない） |

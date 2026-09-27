# Location ingestion: Uber

ドライバーのアプリから約 4 秒ごとに届く位置を受け取り、検証し、重複と順序を整え、地理空間の索引と軌跡のストアへ流す仕組み。道路への当てはめ（map matching）と、軌跡の保存・保持の期間・人が見るときの規則も、この文書で決める。

前提となる決定は、Go で書く熱い経路（[ADR-0001](../decisions/0001-platform-and-stack.md)）、H3 とメモリ上の索引（[ADR-0002](../decisions/0002-h3-geospatial-model.md)）、自前の Valhalla（[ADR-0005](../decisions/0005-maps-and-routing.md)）、NFR-002（位置の鮮度）と NFR-009（位置のプライバシー）（[architecture/README.md](README.md) の 3 節）。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0009](../decisions/0009-location-upload-and-validation.md) | 位置は HTTPS（HTTP/2）の POST で、Protocol Buffers のバッチとして 4 秒ごとに送る。取り込みは無状態の Go のサービスで、検証の後に Kinesis Data Streams（分割キーは `driver_id`）へ書く。時刻は端末の単調時計とセッションの基準点で決め、重複は `(driver_session_id, sample_seq)` で除く |
| [0010](../decisions/0010-location-trails-map-matching-and-retention.md) | 生の位置は S3 に 30 日、乗車の軌跡は 1 年（いずれも既定案で、L4 の結論で置き換える）。道路への当てはめは Valhalla（Meili）で遅れて行い、索引には使わない。ログ・調査は H3 の解像度 8 に丸め、人が軌跡を見る操作は理由と監査ログを必須にする |

## 1. 目的と範囲

- 扱う：ドライバーのアプリとの送受信の形式、認証と流量の制限、検証（範囲・精度・時刻・速度・跳び・偽装）、重複と順序、位置の流れ（Kinesis）、軌跡の保存と保持、道路への当てはめ、軌跡を人が見るときの規則。
- 扱わない：端末の側の位置の取り方・電池・背景の実行（`rider-and-driver-apps.md`）、索引の中身と検索（[geospatial-index.md](geospatial-index.md)）、乗客のアプリへの車の位置の配信（`notifications-and-realtime-push.md`）、速度の表からの交通の反映（[eta-and-routing.md](eta-and-routing.md)）、監査ログの仕組みと鍵の管理（`security.md`）。
- 乗客の位置は、依頼の乗車地・降車地と、乗車の共有の画面で使う端末の位置だけを扱う。乗客の位置を 4 秒ごとに集めることはしない。

## 2. 本家の形（確かめたこと）

| 項目 | 本家（公開情報） | この設計 |
| --- | --- | --- |
| 送信の間隔 | ドライバーは 4 秒ごとに位置を送る。受け取った位置は、セルの ID で分けて供給のサービスに渡す（[How Uber Scales Their Real-time Market Platform](http://highscalability.com/blog/2015/9/14/how-uber-scales-their-real-time-market-platform.html)、2015） | 同じ 4 秒。分ける単位は H3（ADR-0002） |
| 都市での GPS の誤差 | 建物に遮られる都市では、GPS の誤差が 50 m 以上になる。本家は衛星ごとの信号の強さと 3D の地図で補正する研究をした（[Rethinking GPS](https://www.uber.com/en-CA/blog/rethinking-gps/)、2018-04-19） | 補正は作らない。精度の値で振り分け、跳びを検証で除く（4 節） |
| 道路への当てはめ | 隠れマルコフモデル（HMM）と Viterbi で、GPS の点の列から最もありそうな道路の区間の列を求める。当てはめの異常から、地図の誤り（右折の禁止、一方通行、欠けた道路）を見つける（[CatchME](https://www.uber.com/us/en/blog/mapping-accuracy-with-catchme/)、2019-04-25） | Valhalla の Meili（同じ HMM の方式）で遅れて当てはめる。地図の誤りの検出は [maps-and-geodata.md](maps-and-geodata.md) |

いずれも 2026-09-27 に確認。本家の送信のプロトコル（HTTP か常時の接続か）と、偽装の検出の方法は公開されていない（**未検証**）。

## 3. 構成と流れ

```
ドライバーのアプリ
   │ HTTPS（HTTP/2）POST /v1/driver/locations  … 4 秒ごと、LocationBatch（protobuf）
   ▼
ALB（loc.<domain>）
   ▼
loc-ingest（Go、無状態、ECS Fargate）
   │ 認証 → 流量の制限 → 時刻の補正 → 検証 → 付加（city_id、operator_id）
   ▼
Kinesis Data Streams（S1：loc-tokyo、分割キー driver_id）
   ├─▶ geo-index の主・待機（拡張ファンアウト）                  … geospatial-index.md
   ├─▶ trail-builder（Go）：乗車ごとの軌跡、当てはめ、速度の標本 … 7・8 節
   ├─▶ Amazon Data Firehose → S3 loc-raw/（Parquet）            … 7 節
   ├─▶ trip-location-fanout（Go）：乗客への車の位置の配信     … notifications-and-realtime-push の 6 節
   └─▶ dispatch の判断の記録は、索引から読んだ値で書く（位置の流れは読まない）
```

- 取り込みのサービスは状態を持たない。どのタスクに届いても同じ結果になる。重複と順序は、流れを読む側が `sample_seq` と時刻で扱う（5 節）。
- 索引に直接 gRPC で渡す案は採らない。索引の再構築（直近 30 秒の読み直し）と、複数の読み手（待機、軌跡、保存）に、1 つの流れで応えるため（ADR-0009）。

## 4. 送受信の形式

### 4.1 要求

- `POST https://loc.<domain>/v1/driver/locations`、`Content-Type: application/x-protobuf`。HTTP/2 で 1 本の接続を使い回す。HTTP/1.1 でも受ける。
- 認証：ドライバーのアクセストークン（短い期限。発行は `security.md`）。トークンの `driver_session_id` と本体の `driver_session_id` が一致しなければ 403。
- 1 要求の本体は 16 KiB まで。超えたら 413。

```proto
// ドライバーのセッションは出庫（オンライン）で始まり、入庫で終わる。端末の再起動でも新しいセッションになる。
message LocationBatch {
  string driver_session_id = 1;
  uint64 batch_seq = 2;                 // セッションの中で単調に増える
  repeated LocationSample samples = 3;  // 1〜4 件（通常）。溜めた分の送り直しは 1〜60 件
  DriverReportedState state = 4;        // 端末が知っている状態（空車・実車（流し）・休憩）
  uint64 state_seq = 5;                 // 状態の操作ごとに増える
  bool backlog = 6;                     // 通信が切れていた間に溜めた分なら true
}

message LocationSample {
  uint64 sample_seq = 1;          // セッションの中で単調に増える。重複の除去の鍵
  uint64 elapsed_ms = 2;          // セッションの開始からの端末の単調時計
  int64 device_time_ms = 3;       // 端末の壁時計（参考。判定には使わない）
  sint32 lat_e7 = 4;              // 緯度 × 1e7
  sint32 lng_e7 = 5;
  uint32 h_accuracy_dm = 6;       // 水平の精度（10 cm 単位）
  uint32 speed_cms = 7;           // 端末が出した速度（cm/秒）。無ければ 0 と has_speed=false
  bool has_speed = 8;
  uint32 heading_cdeg = 9;        // 進行方向（0.01 度）
  bool has_heading = 10;
  LocationSource source = 11;     // GNSS / FUSED / NETWORK
  IntegrityFlags integrity = 12;  // OS が示す模擬の位置の印など（13 節）
}

enum DriverReportedState { STATE_UNSPECIFIED = 0; VACANT = 1; HIRED_STREET = 2; BREAK = 3; }
```

- 端末は 1 秒に 1 回まで位置を取り、4 秒ごとにまとめて送る。止まっているときは 1 件でよい。位置の取り方の細部（精度の設定、電池）は `rider-and-driver-apps.md` で決める。
- 状態の `VACANT`・`HIRED_STREET`・`BREAK` は、ドライバーの操作（流しの実車の切り替え）とメーターの連携から来る。割り当ての状態（オファー中・迎車中・乗車中）は Trips が正本で、ここには載せない（[dispatch-and-matching.md](dispatch-and-matching.md) の 7 節）。

### 4.2 応答

```proto
message LocationAck {
  uint64 acked_batch_seq = 1;
  int64 server_time_ms = 2;        // 時刻の基準点の更新に使う（4.3 節）
  uint32 next_interval_ms = 3;     // 既定 4000。サーバーが 2000〜10000 の間で変えられる
  repeated SampleVerdict rejected = 4; // 拒否した sample_seq と理由のコード（中身は返さない）
}
```

- 応答は 200 で返す。検証で捨てた点があっても、バッチとしては受け取ったものとする。端末は捨てた点を送り直さない。
- 429（流量の超過）と 5xx は、端末が指数的に待って送り直す（最初 1 秒、最大 30 秒、乱数の揺らぎつき）。送り直しは同じ `batch_seq` で行う。
- `next_interval_ms` は、障害のときに受信の量を落とすための弁である。平常は 4000 のまま使う。

### 4.3 時刻

- 判定に使う時刻は、端末の壁時計ではなく、**セッションの基準点と端末の単調時計**から求める。
  - 出庫の要求の応答で、サーバーは `(server_time_ms, elapsed_ms)` の組（基準点）を決める。
  - 点の時刻 `t = anchor.server_time + (sample.elapsed_ms − anchor.elapsed_ms)`。
  - 基準点は、応答の往復時間が最も短かった要求で更新する（NTP と同じ考え方）。往復時間の半分を誤差として持つ。
- 端末の壁時計は、利用者が変えられ、時刻の同期がずれることがある。単調時計は再起動で戻るが、再起動は新しいセッションになるので問題にならない。
- 壁時計と `t` の差が 5 分を超えたら、`clock_skew` の印を付けて集計する（偽装の兆しの 1 つ。13 節）。

### 4.4 流量の制限

| 対象 | 上限 | 超えたとき |
| --- | --- | --- |
| 1 セッションの要求 | 1 秒に 2 回、1 分に 60 回 | 429 |
| 1 要求の点の数 | 60 | 413 |
| `backlog` の点の古さ | 24 時間 | その点を捨てる（`too_old`） |
| 1 セッションの `backlog` の総量 | 1 回の再接続で 900 点（約 15 分） | 古い点から捨てる。端末の側も同じ上限で溜める |

## 5. 検証・重複・順序

取り込みのサービスは、点ごとに次の順に判定し、結果を `verdict` として付ける。索引は `USE_FOR_INDEX` の点だけを使う。軌跡は `DROP` 以外の点を保存する。

| # | 検証 | 条件 | 結果 |
| --- | --- | --- | --- |
| V1 | 範囲 | 緯度 20〜46 度、経度 122〜154 度の外。NaN、0,0 | `DROP`（`out_of_range`） |
| V2 | 未来の時刻 | `t` が受信の時刻より 10 秒以上後 | `DROP`（`future`） |
| V3 | 古さ | 受信の時刻より 30 秒以上前 | `TRAIL_ONLY`（`late`）。24 時間より前なら `DROP` |
| V4 | 精度 | `h_accuracy` が 100 m を超える | `TRAIL_ONLY`（`low_accuracy`） |
| V5 | 順序 | 同じセッションで、索引に使った最後の点より `t` が古い、または同じ | `TRAIL_ONLY`（`out_of_order`） |
| V6 | 跳び | 索引に使った最後の点からの見かけの速度が時速 200 km を超え、かつ距離が 300 m を超える | 保留（`jump_suspect`）。次の 2 点が保留の点と整合すれば、移動として受け入れる（トンネルの出口、GPS の再取得）。整合しなければ `TRAIL_ONLY` |
| V7 | 偽装の印 | `integrity` に模擬の位置の印がある。端末の完全性の確認に失敗したセッション | `TRAIL_ONLY`（`spoof_suspect`）。セッションに印を付ける（13 節） |
| V8 | セッション | セッションがオンラインでない（入庫の後、失効） | バッチごと 409（`session_closed`）。端末は出庫からやり直す |

- **跳び（V6）の考え方**：都市の GPS は、ビルの反射で数百 m 跳ぶことがある。1 点の跳びで索引の位置を動かすと、遠い車にオファーが届く。3 点のうち 2 点がそろって初めて動かすので、本当の移動の反映は最大で 1 回分（4 秒）遅れる。時速 200 km は日本の道路の速度を十分に超える値として置いた（**未検証**の設計の値。E3 で実データの分布から見直す）。
- **重複**：同じ点が 2 回届くのは、送り直し（応答が失われた）のときである。鍵は `(driver_session_id, sample_seq)`。
  - 索引は、ドライバーごとに最後に使った `sample_seq` を持ち、それ以下を無視する。
  - 軌跡は、1 時間ごとの詰め直し（7 節）で鍵が同じ行を 1 つにする。
  - 取り込みのサービスは重複を除かない（状態を持たないため）。
- **順序**：Kinesis の分割キーを `driver_id` にし、同じドライバーの記録を同じシャードに入れる。ただし、2 つの要求が別のタスクで並んで処理されると、シャードへの書き込みの順序が入れ替わりうる。読み手は、届いた順ではなく `sample_seq` と `t` で判定する（V5）。

## 6. 位置の流れ（Kinesis Data Streams）

- 1 つの記録は、検証の済んだ 1 バッチ（`LocationEvent`）。取り込みのサービスが、`driver_id`・`city_id`・`operator_id`・受信の時刻・点ごとの `verdict` を付ける。大きさは 1 件 300 バイト程度を見込む。

```proto
message LocationEvent {
  string driver_id = 1;
  string driver_session_id = 2;
  string city_id = 3;           // S1 は tokyo だけ。S2 は位置の H3 の解像度 6 の親から決める
  string operator_id = 4;
  int64 received_at_ms = 5;
  uint64 batch_seq = 6;
  repeated ValidatedSample samples = 7;  // LocationSample ＋ t（補正した時刻）＋ cell9 ＋ verdict
  DriverReportedState state = 8;
  uint64 state_seq = 9;
  bool backlog = 10;
}
```

- **容量**：プロビジョンドのシャードは、1 シャードあたり書き込み 1 MB/秒か 1,000 件/秒、読み取り 2 MB/秒。登録できる拡張ファンアウトの読み手は、ストリームごとに 20（オンデマンドの Standard とプロビジョンド）。保持の期間の最小は 24 時間（[Kinesis Data Streams quotas and limits](https://docs.aws.amazon.com/streams/latest/dev/service-sizes-and-limits.html)、2026-09-27 に確認）。
  - S1：ピーク 2,500 件/秒 × 300 バイト ≒ 0.75 MB/秒。件数の上限で 3 シャードが最小。ピークの 2 倍と偏りを見て **8 シャード**にする。
  - S3：50,000 件/秒で 50 シャード以上。都市ごとのストリームに分ける（下）。
- **ストリームの分け方**：S1 は `loc-tokyo` の 1 本。S2 からは都市（索引の分割の単位）ごとに 1 本にし、取り込みのサービスが、点の H3 の解像度 6 の親から都市を引いて書き分ける。都市の境目を走る車は、2 本のストリームに交互に現れうる。索引は、古くなった項目を消す規則（[geospatial-index.md](geospatial-index.md) の 4 節）で扱う。
- **保持**：24 時間（最小）。索引の再構築は直近の 30 秒しか読まない。長い保存は S3 の役目である。
- **読み手**：索引の主と待機（拡張ファンアウト。互いの読み取りの量を奪わない）、trail-builder（拡張ファンアウト）、trip-location-fanout（拡張ファンアウト。[notifications-and-realtime-push.md](notifications-and-realtime-push.md) の 6 節）、Firehose（共有の読み取り）。S1 で 5 つ（拡張ファンアウトは 4 つ）。上限（20）に十分な余裕がある。

## 7. 軌跡の保存

| ストア | 中身 | 書く人 | 保持（既定案、L4 の結論で置き換える） |
| --- | --- | --- | --- |
| Kinesis `loc-<city>` | 検証の済んだ位置の流れ | loc-ingest | 24 時間 |
| S3 `loc-raw/dt=/hour=/city=/`（Parquet） | 全ドライバーの点（`DROP` 以外） | Firehose、1 時間ごとの詰め直しの処理 | 30 日 |
| S3 `trip-trails/<yyyymm>/<trip_id>.pb` | 1 乗車の軌跡（迎車の開始から降車まで）と当てはめの結果 | trail-builder | 1 年 |
| Aurora `trip_trails` | 上の索引（件数、当てはめた距離、品質） | trail-builder | S3 と同じ |
| S3 `speed-samples/`（Parquet） | 道路の区間ごとの通過の速度（ドライバーの ID を持たない） | trail-builder | 2 年（[eta-and-routing.md](eta-and-routing.md) の速度の表の元） |
| S3 `supply-heat/`（Parquet） | 解像度 8 のセル × 5 分ごとの状態別の台数（ID を持たない） | 索引 | 2 年 |

- **乗車の軌跡**を別に持つ理由：運賃の問い合わせ、事前確定運賃のルートからの逸脱の確認（[eta-and-routing.md](eta-and-routing.md) の 7 節）、事故と安全の調べ、領収書の地図に使う。生の点の保持（30 日）より長く要る。
- trail-builder は、Trips の状態の変化（`accepted`〜`completed`・取り消し）を購読し、乗車中のドライバーの点を乗車ごとに集める。乗車の終わりから 60 秒待って（遅れて届く点のため）、当てはめ（8 節）を行い、S3 と `trip_trails` に書く。書き込みは `trip_id` で冪等にする。
- **1 年の根拠**は、事業者が乗務の記録を一定の期間持つ義務との釣り合いで置いた仮の値である（乗務記録の保存の期間の条文は **未検証**）。保持の期間・利用目的・事業者との関係は、法務の確認待ち（[intent.md](../intent.md) の L4）。
- 暗号化：S3 は位置の専用の KMS の鍵（SSE-KMS）。鍵の利用は、パイプラインのロールと、監査つきの閲覧の窓口（9 節）のロールだけに許す。
- 削除：S3 のライフサイクルで接頭辞ごとに消す。ドライバーのアカウントの削除の依頼の扱い（保持の期間の前に消すか）は、法務の確認待ち（L4）。

## 8. 道路への当てはめ

- **索引には使わない。** 候補の検索は直線の距離で絞り、ETA は道路の上で求める（[dispatch-and-matching.md](dispatch-and-matching.md)）。1 点ごとの当てはめを熱い経路に入れると、遅れと失敗の原因が増える割に、候補の順位はほとんど変わらないと見込む（**未検証**。E3 の再生で確かめる）。
- **使う場面**：
  1. 乗車の軌跡（乗車の終わりに 1 回）：当てはめた距離、通った道路の区間、ルートからの逸脱。
  2. 速度の標本（空車・迎車・乗車のすべての走行）：ドライバーごとに 1 分の窓で当てはめ、区間ごとの通過の時間を `speed-samples` に書く。
- **方式**：Valhalla の `trace_attributes`。Valhalla の当てはめ（Meili）は、Newson と Krumm の HMM の方式で、GPS の点の列から最もありそうな候補の区間の列を求める（[Meili の algorithms](https://github.com/valhalla/valhalla/blob/master/docs/docs/contributing/architecture/meili/algorithms.md)、[Map Matching API](https://github.com/valhalla/valhalla/blob/master/docs/docs/api/map-matching.md)、2026-09-27 に確認）。
- **引数**：`shape_match=map_snap`、`gps_accuracy` は点の精度を 5〜50 m に丸めた値、`search_radius` 50 m、`breakage_distance` 2,000 m。既定の上限（点の数 16,000、`max_search_radius` 100 m、`max_gps_accuracy` 100 m）の中に収める（[valhalla_build_config](https://github.com/valhalla/valhalla/blob/master/scripts/valhalla_build_config)、2026-09-27 に確認）。
- **量**：S1 のピークで 1 万台 × 1 分の窓 ＝ 約 170 回/秒。乗車の軌跡は成立した乗車の数（約 3〜6 件/秒。[capacity.md](capacity.md) の 1.1 節）。当てはめ専用の Valhalla のタスクの組を、ETA の組と分けて置く（ETA の遅れを当てはめの量で悪くしない）。1 回の処理の時間と必要なタスクの数は **未検証**（E3 で計る）。
- **品質の印**：当てはめに失敗した点の割合が 30% を超えた窓は、速度の標本に使わない。失敗が続く場所は、地図の誤りの候補として [maps-and-geodata.md](maps-and-geodata.md) の 6 節に渡す。

## 9. 位置のプライバシー

- **正確な位置を見せる相手**：乗車の相手（乗客とそのドライバー）に、その乗車の間（受諾から降車まで）だけ。配信は `notifications-and-realtime-push.md` の担当で、この領域は、乗車の外の人に位置を返す API を作らない。
- **依頼の前の地図の車**は、索引の丸めた表示だけを使う（[geospatial-index.md](geospatial-index.md) の 6.3 節）。
- **ログ・トレース・メトリクス・エラーの報告**に、緯度経度を書かない。書くのは H3 の解像度 8 のセル（辺 約 0.5 km）まで。lint で `lat`・`lng`・`latitude` を含むログの項目を拒否し、`LocationSample` の型に文字列化（`String()`）を持たせない。
- **人が軌跡を見る操作**（サポート、事故の調べ）：サポートのツールの「軌跡の閲覧」だけを窓口にする。理由（問い合わせの番号・事故の番号）の入力、対象は 1 乗車の区間だけ、閲覧の記録を監査ログへ 100% 残す（NFR-009）。仕組みは `support-and-operations-tools.md` と `security.md`。
- **分析**：`loc-raw` を分析に使うときは、`driver_id` を 90 日ごとに替わる鍵の HMAC に置き換えた写しを作る。解析の担当は生の `loc-raw` を読めない。
- **テストのデータ**：合成した軌跡か、匿名化して解像度 10 に丸めた軌跡だけを使う（[AGENTS.md](../../AGENTS.md) の規則）。
- 位置の履歴が個人情報に当たるか、利用目的の通知、事業者への提供の形（委託・共同利用・第三者提供）は、法務の確認待ち（L4）。

## 10. 障害のときの振る舞い

| 障害 | 起きること | 回復・影響の抑え方 |
| --- | --- | --- |
| 端末の通信が切れた | 位置が届かない。15 秒で配車の候補から外れる（NFR-002） | 端末が溜めて、再接続で `backlog=true` として送る。溜めた点は軌跡にだけ入る（V3） |
| loc-ingest の 1 タスクが落ちた | 処理中の要求が 5xx | ALB が他のタスクへ送る。端末は同じ `batch_seq` で送り直す |
| Kinesis の書き込みの超過・失敗 | 要求が遅れる | 1 回だけ再試行し、それでも失敗したら 503。端末は待って送り直す。`next_interval_ms` を 8000 に上げて量を半分にする（runbook） |
| Kinesis の 1 シャードが熱い | 一部のドライバーの反映が遅れる | 分割キーは `driver_id` なので偏りは小さいと見込む。シャードを分ける |
| 索引の読み手が遅れる | 索引の位置が古くなる | 索引の側の遅れの監視（[geospatial-index.md](geospatial-index.md) の 8 節）。取り込みは影響を受けない |
| trail-builder が止まった | 乗車の軌跡の作成が遅れる | Kinesis の保持（24 時間）の中なら、再開で追いつく。超えたら `loc-raw` から作り直す |
| Firehose が止まった | `loc-raw` が遅れる | Firehose の再試行。24 時間を超えたら欠ける（受け入れる。乗車の軌跡は trail-builder の側にある） |
| 大量の再接続（携帯の網の障害の復旧） | `backlog` の送信が集中する | `backlog` の要求は別の流量の制限（全体で 1 秒 5,000 件まで）にかけ、平常の送信を優先する |

## 11. 容量の目安（S1）

| 項目 | 値 |
| --- | --- |
| 要求 | ピーク 2,500 件/秒（1 万台 ÷ 4 秒）。平常の本体は 200 バイト前後 |
| loc-ingest | 1 タスク（1 vCPU）で 2,000 件/秒を見込み、ピークの 2 倍に対して 4 タスク以上（**未検証**。E3 の負荷試験で決める） |
| Kinesis | 8 シャード |
| `loc-raw` の量 | 1 日に数 GB〜10 GB 程度（点 1 件あたり圧縮後 30 バイトとして、ピークの 4 割の平均で試算。**未検証**） |

## 12. 性能の予算（NFR-002：受信から索引への反映 p99 1 秒）

| 区間 | 予算（p99） |
| --- | --- |
| loc-ingest の処理（認証・検証） | 20 ms |
| Kinesis への書き込み | 150 ms |
| 拡張ファンアウトでの索引への配送 | 300 ms |
| 索引での適用 | 10 ms |
| 余裕 | 520 ms |

Kinesis の書き込みと配送の遅れの実際の値は **未検証**。E3 で計る。

## 13. 偽装と不正

位置の偽装は、配車の多い場所（駅、繁華街）にいるように見せてオファーを多く受けるために起こりうる。乗客の待ちが延び、ETA の精度（NFR-003）も崩れる。

| 兆し | 取り方 | 扱い |
| --- | --- | --- |
| OS の模擬の位置の印 | 端末が `integrity` に載せる（Android の模擬の位置の印、iOS のソフトウェアによる模擬の印。API の名前と対応の版は `rider-and-driver-apps.md` で確かめる。**未検証**） | その点を索引に使わない（V7） |
| 端末の完全性の確認の失敗 | 出庫のときに OS の仕組みで確かめる（`security.md`） | セッションを `location_untrusted` にし、配車の候補から外す |
| 跳びの多さ | V6 の保留の回数 | 10 分に 5 回で集計の対象 |
| 動きの不自然さ | 精度の値と位置が長く全く変わらない、端末の速度と見かけの速度が合わない | 集計の対象 |
| ETA の系統的なずれ | 同じドライバーで、実際の迎車の時間が ETA より長い状態が続く（[eta-and-routing.md](eta-and-routing.md) の 6 節） | 集計の対象 |
| 時刻のずれ | 4.3 節の `clock_skew` | 集計の対象 |

- 自動の処置は、「その点を索引に使わない」と「セッションを候補から外す」までにする。ドライバーの利用の停止は、事業者と運用の担当が確かめてから行う（`supply-and-operators.md`、`safety-and-trust.md`）。誤検知でドライバーの収入を止めないため。
- 兆しは、1 日 1 回の集計で、ドライバーごとの点数にして運用の画面に出す。

## 14. テスト

### 14.1 性質ベーステスト

- **PROP-LOC-001（重複なし）**：任意の送り直し・重複・並べ替えの列で、索引に適用される点は `(driver_session_id, sample_seq)` ごとに高々 1 回で、`t` は単調に増える。
- **PROP-LOC-002（検証の決定性）**：同じ点の列と同じ基準点から、同じ `verdict` の列が出る（取り込みのタスクの数と、要求の分かれ方に依らない）。
- **PROP-LOC-003（跳び）**：1 点だけの跳び（前後の点が元の位置と整合する）は、索引の位置を動かさない。整合する 3 点の移動は、2 点目か 3 点目で索引に反映される。
- **PROP-LOC-004（時刻）**：端末の壁時計を任意にずらしても、`t` は変わらない。
- **PROP-LOC-005（保持）**：どの時点でも、保持の期間を過ぎた接頭辞に、オブジェクトが残らない（ライフサイクルの設定を生成する Terraform の値と、表 7 の値の一致で確かめる）。

### 14.2 決定表

- 5 節の V1〜V8 を、境界の値（100 m ちょうど、30 秒ちょうど、時速 200 km ちょうど）を含めて表駆動テストにする。

### 14.3 結合・負荷・障害注入

- 合成した 1 万台の軌跡（道路の上を Valhalla の経路で動かす。通信の断・GPS の跳び・トンネル・模擬の位置を乱数で混ぜる）を、S1 のピークの 2 倍（5,000 件/秒）で流し、NFR-002 の p99 と、跳びの誤判定の率を計る（[ADR-0001](../decisions/0001-platform-and-stack.md) の Confirmation と同じ試験）。
- loc-ingest のタスクの強制終了、Kinesis の書き込みの失敗と遅れの注入で、端末の送り直しの後に PROP-LOC-001 が成り立つことを確かめる。
- ログの検査：試験の実行のログ・トレースの全体に、緯度経度の形の値（`\d{2}\.\d{4,}`）が 0 件であること。

## 15. Story の候補

Epic の番号と名前は [roadmap.md](../roadmap.md) のとおり。

| Epic | Story | 中身 |
| --- | --- | --- |
| E3 | `loc-proto-contract` | 4.1・4.2・6 節のメッセージを Protocol Buffers で定義し、Go・Swift・Kotlin の型を生成する |
| E3 | `loc-ingest-service` | 認証、流量の制限、時刻の補正（4.3 節）、Kinesis への書き込み |
| E3 | `loc-validation-rules` | V1〜V8 と決定表のテスト、PROP-LOC-002・003・004 |
| E3 | `loc-dedupe-ordering` | 読み手の側の重複の除去と順序（PROP-LOC-001） |
| E3 | `loc-kinesis-stream` | ストリーム・シャード・拡張ファンアウトの読み手・KMS の Terraform |
| E3 | `loc-raw-firehose` | Firehose から S3 への Parquet、1 時間ごとの詰め直し、ライフサイクル |
| E3 | `trip-trail-builder` | 乗車ごとの軌跡、当てはめ、`trip_trails` |
| E3 | `speed-sample-extractor` | 1 分の窓の当てはめと `speed-samples`（ETA の速度の表の元） |
| E3 | `loc-load-test` | 14.3 節の合成の軌跡と負荷試験 |
| E3 | `location-log-lint` | 緯度経度をログに書かない lint と、試験のログの検査 |
| E9 | `driver-background-location` | 端末の側の送信、溜めと送り直し、`next_interval_ms` への追従（apps の Story と同じ 1 つ） |
| E10 | `fraud-signal-scoring` | 13 節の兆しの集計と、運用の画面への表示（security の Story と同じ 1 つ） |
| E11 | `trail-viewer-audited` | 理由と監査ログつきの軌跡の閲覧（support の領域と一緒に） |

## 16. 未解決の問い

### 決定（2026-09-27、既定案）

- **送信の方式**：HTTPS（HTTP/2）の POST。常時の接続（gRPC の双方向ストリーム。[ADR-0030](../decisions/0030-realtime-grpc-bidirectional-stream-gateway.md)）とは分ける（ADR-0009）。
- **送信の間隔**：4 秒。サーバーが 2〜10 秒の間で変えられる。
- **時刻**：端末の単調時計とセッションの基準点。壁時計は参考だけ。
- **跳びの閾値**：時速 200 km かつ 300 m、3 点のうち 2 点で確定。
- **精度の閾値**：100 m を超えた点は索引に使わない。
- **ストリーム**：Kinesis Data Streams のプロビジョンド、S1 は 8 シャード、保持は 24 時間。Valkey に最新の位置の写しを置く案（ADR-0002 の持ち越し）は採らない。再構築は Kinesis の時刻の指定の読み直しで足りる（[geospatial-index.md](geospatial-index.md) の 5 節）。
- **保持**：生の位置 30 日、乗車の軌跡 1 年、速度の標本と台数の集計 2 年（いずれも L4 の結論で置き換える）。
- **ログの丸め**：H3 の解像度 8。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| 位置の履歴の法的な位置づけ、保持の期間、事業者との関係 | 法務の確認待ち（L4）。結論までは表 7 の既定案で作り、release フラグの裏に置かない（保存しないと乗車の調べができないため）。結論で期間を変える |
| 常時の接続（gRPC の双方向ストリーム、ADR-0030）とまとめて、位置の上りとオファーの下りを 1 本で運ぶか | E3・E6 の電池と通信の量の計測で見直す。まとめるなら ADR-0009 を置き換える（[notifications-and-realtime-push.md](notifications-and-realtime-push.md) の 14 節と同じ問い） |
| 1 点ごとの当てはめを索引に入れるか | E3 の再生で、候補の順位と ETA の精度への効果を計ってから |
| 跳び・精度の閾値の妥当性 | E3 で、合成と試験運用の軌跡の分布から見直す |
| 偽装の兆しから自動で処置する範囲 | S1 の運用の結果（誤検知の率）で見直す |
| 乗車の軌跡の 1 年の根拠（乗務記録などの保存の義務との関係） | 法務の確認待ち（L4、L7） |

## 17. quality.md・runbooks・data-model への項目

### quality.md

- 位置の鮮度：受信から索引への反映の p50・p99（NFR-002）。区間ごと（12 節）に計る。
- オンラインのドライバーのうち、最新の点が 15 秒より古い割合（通信の切れの目安）。
- `verdict` の理由ごとの率（`late`・`low_accuracy`・`jump_suspect`・`spoof_suspect`）。急な変化は端末のアプリの不具合の兆し。
- 当てはめの失敗の率と、乗車の軌跡の作成の遅れ（乗車の終わりから S3 への書き込みまで）。
- ログの中の緯度経度の検出の件数（0 件であること）。
- PROP-LOC-001〜005 の実行の数と種（PR ごとに 1 万の列、夜間に 100 万）。

### runbooks

- `location-ingest-lag.md`：索引への反映が遅れたときの確かめ方（loc-ingest の 5xx、Kinesis の書き込みの超過、拡張ファンアウトの遅れ、索引の適用の遅れ）と、`next_interval_ms` の引き上げ、シャードの追加の手順。
- `location-reconnect-storm.md`：携帯の網の障害の復旧で `backlog` が集中したときの確かめ方と、`backlog` の流量の制限の調整。
- `trail-builder-backfill.md`：trail-builder が 24 時間を超えて止まったときに、`loc-raw` から乗車の軌跡を作り直す手順。
- `location-spoof-review.md`：偽装の兆しの点数が高いドライバーの確かめ方と、事業者への連絡の手順（処置の判断は事業者と運用）。

### data-model（索引への追加の提案）

| 置き場所 | 中身 |
| --- | --- |
| Protocol Buffers `LocationBatch`・`LocationSample`・`LocationAck`・`LocationEvent` | 4・6 節 |
| Kinesis `loc-<city>` | 検証の済んだ位置の流れ（分割キー `driver_id`、保持 24 時間） |
| S3 `loc-raw/`（Parquet） | 生の点（30 日） |
| S3 `trip-trails/` と Aurora `trip_trails`（`trip_id` PK、`s3_key`、`sample_count`、`matched_distance_m`、`match_quality`、`created_at`、`expires_at`） | 乗車の軌跡（1 年） |
| S3 `speed-samples/`（Parquet：`way_id`、`direction`、`edge_id`、`week_bucket_5min`、`speed_kph`、`tile_version`） | 速度の標本（ID なし、2 年） |
| S3 `supply-heat/`（Parquet：`cell8`、`bucket_5min`、`status`、`count`） | 台数の集計（ID なし、2 年） |
| Aurora `driver_sessions`（出庫の時の基準点 `anchor_server_time`・`anchor_elapsed_ms`、`location_untrusted`） | セッションの本体は `supply-and-operators.md` に置き、この 2 列を足す提案 |

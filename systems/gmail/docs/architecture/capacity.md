# Capacity: Gmail

負荷のモデルと大きさを決める。受信の申し出（迷惑メールの割合と波を含む）、送信、同期（JMAP、IMAP の長い接続、プッシュ）、検索、保存の伸び、部品ごとの必要量、S1・S2・S3 の大きさ、月の費用、負荷試験を扱う。

前提となる決定は次のとおり。

- 規模の段階（S1 は 100 万アカウント、受け付け 6,000 万通/日、申し出 1.5 億通/日、送信 300 万通/日、保存 1.5 PB（3 年後）、メタデータ 8 シャード、IMAP 20 万の接続）と費用のモデル（[architecture/README.md](README.md) の 2 節）
- SMTP の時点で安く拒み、受け付けた後に選別する（[ADR-0002](../decisions/0002-accept-then-filter.md)）。接続の層ごとの上限（[ADR-0010](../decisions/0010-inbound-connection-tiers-and-rate-limits.md)）
- blob は 1 日後に 64 MiB のパックへ詰め直す（[ADR-0003](../decisions/0003-message-storage-layout-and-dedupe.md)）。検索の索引はアカウントごとで、直近 30 日に検索したアカウントを NVMe に置く（[ADR-0009](../decisions/0009-search-index-design.md)）
- 段階を上げる基準と DR の構成は [infrastructure.md](infrastructure.md)

この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0068](../decisions/0068-capacity-model-and-headroom.md) | 部品の大きさは、S1 のピークの 2 倍（申し出 6,250 通/秒の 2 倍）と、迷惑メールの波（申し出がピークの 3 倍で 1 時間）の大きいほうで決める。波は接続の層で絞り、受け付けた後の選別は SQS に溜めて 2 時間で追いつく形にし、受け付けの台だけを波に合わせる。月次のレビューで、使用の率が 60% を超えた部品を次の四半期に増やす。費用は、S1 で 1 アカウント月 0.2 USD 前後（±40%）と見込み、仮の予算 0.15 USD との差を、要求の数の削減と予約の割引で埋める |

## 1. 負荷のモデル（S1）

### 1.1 量

| 対象 | 平均 | ピーク（設計） | 設計の 2 倍 | 根拠 |
| --- | --- | --- | --- | --- |
| 受信の申し出（SMTP の接続とトランザクション） | 1,740 通/秒（1.5 億/日） | 6,250 通/秒 | 12,500 通/秒 | [architecture/README.md](README.md) の 2 節。ピークは平均の 3.6 倍 |
| 受信の受け付け（250） | 700 通/秒 | 2,500 通/秒 | 5,000 通/秒 | 同上。申し出の 4 割 |
| 受け付けのうち迷惑メールの箱 | 2 割（140 通/秒） | — | — | 本システムの想定（申し出の 6 割は SMTP の時点で拒む） |
| 配送（受け手ごと） | 840/秒 | 3,000/秒 | 6,000/秒 | 1 通あたり受け手 1.2（組織のグループと複数の宛先） |
| 送信の依頼 | 35 通/秒（300 万/日） | 150 通/秒 | 300 通/秒 | [architecture/README.md](README.md) の 2 節 |
| 外への送信の試行 | 25 通/秒 | 110 通/秒 | 220 通/秒 | 外の宛先 200 万/日、再試行 10% |
| JMAP の要求 | 5,000/秒 | 20,000/秒 | 40,000/秒 | 日に動くアカウント 50 万 × 1 日 860 要求（同期・表示・操作） |
| 検索 | 17/秒 | 100/秒 | 200/秒 | 日に動くアカウント 50 万 × 1 日 3 回、ピークは 6 倍 |
| IMAP の同時の接続 | 15 万 | 20 万 | 40 万 | [architecture/README.md](README.md) の 2 節 |
| EventSource・WebSocket の接続 | 6 万 | 10 万 | 20 万 | 同上 |
| モバイルのプッシュの依頼 | 400/秒 | 2,000/秒 | 4,000/秒 | 端末 150 万、受信箱への配送の 4 割 × 端末 1.3 |
| change log の行 | 3,000/秒 | 12,000/秒 | 24,000/秒 | 配送 1 つで 1 行、操作 1 つで平均 3 行 |

- 数値は本システムの想定で、本家の量は確かめなかった（**未検証**）。

### 1.2 時刻と波の形

- **日の形**：受信は 9〜11 時と 13〜15 時（日本時間）に山。ピークは平均の 2.5〜3.6 倍。送信は 9〜18 時の平日。
- **迷惑メールの波**：新しいボットネット・フィッシングの波で、申し出がピーク（6,250 通/秒）の 3 倍（約 19,000 通/秒）に 1 時間なる。多くは `unknown`・`suspicious` の層の IP で、接続の時点で 421・554 にする（[ADR-0010](../decisions/0010-inbound-connection-tiers-and-rate-limits.md)）。受け付けに通るのは波の 1 割（約 1,900 通/秒）と見込む。
- **組織の一斉の送信**：組織の全員あて（グループの展開で 2 万の受け手）が 1 つの組織で 1 時間に数回。配送の 3,000/秒の山を 10 秒ほど作る。
- **年末年始・大型の販売の催し**：宣伝のメールの受信が平時の 2 倍の週がある（[runbooks/README.md](../runbooks/README.md) の 3.1 節の凍結）。

### 1.3 保存の伸び

| 項目 | 値 | 根拠 |
| --- | --- | --- |
| 受け付け（論理） | 4.5 TB/日（6,000 万 × 75 KB） | [architecture/README.md](README.md) の 2 節 |
| 残る割合 | 4 割（迷惑メールの箱・ゴミ箱の 30 日での消去、利用者の削除） | 3 年後の論理 2 PB から逆算 |
| 正味の伸び（論理） | 1.8 TB/日 | — |
| 物理（圧縮と共有） | 論理の 0.75 倍 → 1.4 TB/日 | 同上 |
| 3 年後の物理 | 1.5 PB（大阪の写しを除く） | 同上 |
| メッセージの行 | 3 年後 270 億、1 行 600 バイトで 16 TB | 同上 |
| 検索の索引 | 1 アカウント 100 MB、S1 で 100 TB | [ADR-0009](../decisions/0009-search-index-design.md) |
| blob の目録 | blob 250 億行 × 200 バイト ≒ 5 TB | 本システムの想定 |

## 2. 受信の面

| 部品 | 1 台・1 タスクの量（想定） | S1 の数（東京、設計の 2 倍） | 備考 |
| --- | --- | --- | --- |
| `mx-edge`（EC2 `c7gn.xlarge`、4 vCPU、ネットワーク最適化） | 同時の接続 2 万、受け付け 600 通/秒 | 9（AZ ごと 3）。大阪 4 | [inbound-smtp.md](inbound-smtp.md) の 4 節。`mx-throughput-poc` で確かめる |
| `inbound-pipeline`＋`spam-scorer`（Fargate、1 タスク 4 vCPU） | 1 通 CPU 20ms（MIME の解析 5、規則と評判 5、分類器 8、組み立て 2） | ピークの 2 倍で 120 vCPU → 30 タスク。平均 12 タスク | 自動の拡大は SQS の古さ（30 秒）と CPU 60% |
| `content-scanner`（Fargate、使い捨て） | 添付のあるメッセージ 3 割 × 1 通 CPU 150ms | ピークの 2 倍で 225 vCPU。平均 40 vCPU | [ADR-0026](../decisions/0026-static-attachment-scanning-sandbox.md)。書庫の多い波で伸びる |
| `mailstore`（Fargate、1 タスク 4 vCPU） | 配送 400/秒・タスク | 6,000/秒 → 16 タスク | Aurora の書き込みで決まる（4 節） |

- **波の扱い**：波の受け付けの増分（1,900 通/秒）は、`mx-edge` の受け付け（9 台 × 600 = 5,400 通/秒）に収まる。受け付けた後の選別は、SQS に溜めてよい。波の 1 時間に溜まる量は最大 700 万通で、30 タスクで 2 時間で追いつく。その間、正規のメールの受信の遅れ（NFR-001 の p95 10 秒）を守るため、配送の待ち行列を 2 つ（`inbound-delivery` と、`unknown`・`suspicious` の層から来た `inbound-delivery-low`）に分け、前者を先に読む（[inbound-smtp.md](inbound-smtp.md) の 11.2 節への追加の依頼。16 節の持ち越し）。

## 3. 送信の面

| 部品 | 量 | S1 の数 | 備考 |
| --- | --- | --- | --- |
| `outbound-gate`（Fargate） | 1 通 CPU 15ms（上限、選別、DKIM の署名） | 300 通/秒 × 15ms = 4.5 vCPU → 4 タスク（2 vCPU） | |
| `mta-out`（EC2 `c7g.xlarge`） | 1 台 同時の接続 2,000、送信 100 通/秒 | プール 6 × AZ 2 ＋ `personal`・`org-a` に 1 台ずつ足して 14 | IP の数はプールの評判で決まる（[ADR-0018](../decisions/0018-outbound-ip-pools-and-warmup.md)）。台の量は余る |
| 送信の待ち行列 | 5 日の再試行の滞留：外への送信の 3% × 5 日 = 30 万通 | SQS のプールごとの待ち行列 | |

## 4. 保存とメタデータ

| 部品 | S1 の構成 | 根拠 |
| --- | --- | --- |
| メールボックスのシャード | 8 クラスタ × （`db.r8g.2xlarge` I/O-Optimized の書き手 1 ＋ 読み手 1）。1 シャード 12.5 万アカウント、3 年後 2 TB | 書き込み：配送 6,000/秒 × 1 配送 8 行（メッセージ、所属、スレッド、change log、outbox、容量、参照の依頼、`imap_vanished`）÷ 8 = 6,000 行/秒・シャード。`mailbox-shard-poc` で確かめる |
| directory | 1 クラスタ × `db.r8g.2xlarge` × 2 | アドレスの解決はキャッシュに当たる（[inbound-smtp.md](inbound-smtp.md) の 8.1 節） |
| blob の目録 | 4 クラスタ × `db.r8g.xlarge` × 2 | 参照の行の増減 9,000/秒（配送と GC） |
| Valkey | `cache.r7g.xlarge` × 6（3 シャード × 写し 1）。大阪 3 | 評判、上限、宛先のキャッシュ、トークン、重複の抑え |
| S3 の blob | 3 年後 1.5 PB。30 日まで Standard、パックは 90 日で Glacier Instant Retrieval（[ADR-0064](../decisions/0064-storage-classes-and-region-replication.md)） | 1.3 節 |
| S3 の PUT | 1 日 2.4 億（blob 6,000 万、スプール 6,000 万、`spool-done` 6,000 万、索引のセグメント 6,000 万） | 6 節の費用で最も大きい項目の 1 つ |

- 大きなアカウント（組織の共有の受信箱、数百万通）は、シャードの 5% を超えたら専用のシャードへ移す（[infrastructure.md](infrastructure.md) の 6 節）。

## 5. 同期

| 部品 | 量 | S1 の数 |
| --- | --- | --- |
| `jmap-api`（Fargate、TypeScript、1 タスク 2 vCPU） | 1 vCPU 500 要求/秒（`mailstore` への gRPC が主） | ピークの 2 倍 40,000/秒 → 80 vCPU → 40 タスク。平均 12 タスク |
| `imap-server`（Fargate、1 タスク 4 vCPU・16 GB） | 1 タスク 2 万の接続（待ちの接続 1 つ 60 KB）、コマンド 2,000/秒 | 40 万の接続 → 20 タスク |
| `push-gateway`（Fargate、1 タスク 2 vCPU） | 1 タスク 1 万の接続 | 20 万 → 20 タスク |
| `push-notifier` | APNs・FCM へ 1 タスク 500/秒 | 4,000/秒 → 8 タスク |
| NLB（993） | 40 万の接続は LCU の「動いている流れ 10 万」で 4 LCU 前後 | [infrastructure.md](infrastructure.md) の 3.3 節 |

- IMAP の接続の長さ（IDLE は 29 分ごとにやり直し）と、デプロイの時の接続の付け替えは [delivery.md](delivery.md) の 4.2 節。

## 6. 検索

| 部品 | 量 | S1 の数 |
| --- | --- | --- |
| `search-node`（EC2 `i8g.4xlarge`、16 vCPU、128 GiB、NVMe 3.75 TB） | 1 台 検索 30/秒（1 回 CPU 平均 50ms、上限 500ms）。NVMe に置く量 3 TB | NVMe に置くアカウント 2 割 × 100 TB × 写し 2 = 40 TB → 14 台。検索の量（200/秒）は 7 台で足りる |
| `search-indexer`（Fargate） | 1 通 CPU 10ms | 6,000/秒 × 10ms = 60 vCPU（ピーク）、平均 10 vCPU |
| eDiscovery の検索 | `search-node` の CPU の 20% まで | [ADR-0054](../decisions/0054-ediscovery-matters-search-export-and-audit.md) |

- 全体の作り直し（100 TB）は 1 日 2 万アカウントで 50 日（[search.md](search.md) の 10 節）。作り直しは `search-indexer` を 60 vCPU 足し、`mailstore` の読み出しを夜間に寄せる。

## 7. S1・S2・S3 の大きさ

| 部品 | S1 | S2（10 倍） | S3（100 倍） |
| --- | --- | --- | --- |
| `mx-edge` | 東京 9・大阪 4 | 60・30 | リージョンのセル（[infrastructure.md](infrastructure.md) の 8 節） |
| `mta-out` | 14 | 80（プールを /24 単位で増やす） | セルごと |
| メールボックスのシャード | 8 | 80 | 800（セルに分ける） |
| blob の目録 | 4 | 40 | セルごと |
| `search-node` | 14 | 140 | セルごと |
| IMAP の接続 | 40 万（設計） | 400 万 | 4,000 万 |
| 保存（物理、3 年後） | 1.5 PB | 15 PB | 150 PB |

- S2 では、directory の書き込み（アドレスの作成、サインインの記録）が 1 つのクラスタの上限に近づく。サインインの記録を別のクラスタへ分ける（[infrastructure.md](infrastructure.md) の 8 節の基準）。

## 8. 月の費用（S1、本番、初期見積もり）

単価は AWS の公開の価格（ap-northeast-1、オンデマンド、730 時間。出典の節）。保存は 1 年目（物理 0.5 PB）と 3 年目（1.5 PB）を分ける。

| 項目 | 内訳 | 月（USD、1 年目） | 月（USD、3 年目） |
| --- | --- | --- | --- |
| 受信・送信の EC2 | `mx-edge` 13 × `c7gn.xlarge`（0.3148/時）2,990、`mta-out` 14 × `c7g.xlarge`（0.1819/時）1,860 | 4,850 | 4,850 |
| Fargate | 平均 360 vCPU・720 GB（ARM、vCPU 0.04045・GB 0.00442/時） | 12,950 | 12,950 |
| `search-node` | 14 × `i8g.4xlarge`（1.6128/時） | 16,480 | 16,480 |
| Aurora（東京） | メールボックス 16 × `db.r8g.2xlarge` I/O-Optimized（1.732/時）20,230、directory 2,530、blob の目録 8 × `db.r8g.xlarge`（0.866/時）5,060、保存（0.27/GB・月）1 年目 2 TB・3 年目 22 TB | 28,370 | 33,770 |
| Aurora（大阪、Global Database の二次） | 13 × `db.r8g.large`（0.433/時）4,110、保存は東京と同じ | 4,650 | 10,050 |
| Valkey | 東京 6・大阪 3 × `cache.r7g.xlarge`（0.4192/時） | 2,750 | 2,750 |
| S3 の保存 | 東京：Standard（直近 30 日、約 40 TB）と Glacier Instant Retrieval（0.005/GB・月）。大阪の写し（同じ級、単価は東京と同じと仮定、**未検証**） | 6,700 | 17,000 |
| S3 の要求 | PUT 1 日 2.4 億 × 30 × 0.0047/1,000、GET と一覧 | 34,500 | 34,500 |
| リージョンをまたぐ写し | 書き込み 1 日 5.9 TB（スプール 4.5、blob 1.4）× 30 × （転送 0.09 ＋ RTC 0.015）/GB | 19,000 | 19,000 |
| エッジ（CloudFront、WAF） | JMAP と Web の要求 月 130 億 × 0.012/1 万 15,600、WAF 0.60/100 万 7,800、転送 65 TB × 約 0.1/GB 6,500 | 29,900 | 29,900 |
| NLB | 4 つ × 0.0243/時と LCU | 500 | 500 |
| SQS | 1 日 2 億要求 × 0.40/100 万 | 2,400 | 2,400 |
| インターネットへの転送 | 送信のメール 4.5 TB、IMAP の読み出し 50 TB（**未検証**の量） | 5,000 | 5,000 |
| KMS | 1 日 1,200 万要求 | 1,100 | 1,100 |
| 観測（CloudWatch、AMP、Grafana） | **未検証** | 10,000 | 10,000 |
| ネットワーク（NAT、エンドポイント、Network Firewall） | **未検証** | 3,000 | 3,000 |
| その他（Secrets Manager、AppConfig、監査のアカウント、見張り） | — | 3,000 | 3,000 |
| 合計 | | 約 18.5 万（約 2,780 万円） | 約 20.6 万（約 3,100 万円）、±40% |

- 1 アカウント・月：1 年目 0.19 USD、3 年目 0.21 USD。[architecture/README.md](README.md) の 2.1 節の仮の予算（0.15 USD）を 3〜4 割超える。1 USD = 150 円は本システムの想定。
- 大きい項目：S3 の要求（17〜18%）、エッジ（15%）、Aurora（17〜21%）、写し（9〜10%）、`search-node`（8%）。
- 下げる手段（効く順の見込み）：
  1. **S3 の PUT を減らす**：`spool-done` の印を、配送の記録の表（Aurora）に置き換える、索引のセグメントをアカウントごとに 30 秒まとめる。PUT を 1 日 1.2 億に半分にすれば 17,000 USD 減（[inbound-smtp.md](inbound-smtp.md)・[search.md](search.md) の持ち主との調整。16 節）。
  2. **予約の割引**：Aurora のリザーブドと Compute Savings Plans（EC2・Fargate）。割引の率は**未検証**。3 割なら 2 万 USD 減。
  3. **JMAP をエッジの外に**：JMAP の API を CloudFront を通さず、リージョンの ALB と WAF で受ける。CloudFront の要求の費用 15,600 USD のうち大半が減る（Web の資産と usercontent は CloudFront に残す）。
  4. **写しの範囲**：迷惑メールの箱の blob（受け付けの 2 割、30 日で消える）を大阪へ写さない。写しの 1 割強が減るが、DR の後に迷惑メールの箱が欠ける。
- 本家の原価は確かめていない（**未検証**）。

## 9. 単位あたりの原価

| 単位 | 原価（3 年目） | 大きい項目 |
| --- | --- | --- |
| メールボックス 1 つ・月 | 約 0.21 USD | 上の合計 ÷ 100 万 |
| 受け付け 100 万通 | 約 25 USD | 受信の EC2、選別の Fargate、スプールの PUT と写し、SQS の按分 |
| 保存 1 TB（物理）・月 | 約 11 USD（東京と大阪の写しの保存） | Glacier Instant Retrieval と Standard の混ぜ。パックの GET（0.03 USD/GB の取り出し）は別 |
| 書き込み 1 TB（物理） | 約 110 USD（1 回） | リージョンをまたぐ写し（0.105 USD/GB）と PUT |
| 検索 100 万回 | 約 30 USD | `search-node` の按分（NVMe の保持が主で、回数にほぼ比例しない） |

- 保存の原価は書き込みの 1 回の費用（写し）が大きい。迷惑メールの箱のように 30 日で消えるものにも、書き込みの費用はかかる。

## 10. キャパシティの運用

- 月次のレビュー（Ops、PM）：部品ごとの使用の率（CPU、接続、Aurora の書き込みの CPU と保存、NVMe の使用、S3 の要求）を見て、60% を超えた部品を次の四半期に増やす計画を立てる。
- 自動の拡大：Fargate の部品（SQS の古さ、CPU、接続の数）。EC2 の `mx-edge`・`mta-out` は IP の割り当てがあるので手で増やす（[infrastructure.md](infrastructure.md) の 3.2 節）。`search-node` は受け持ちの移しが要るので手で増やす。
- 迷惑メールの波の前の拡大はしない（予測できない）。波は接続の層で絞り、受け付けた後の選別の溜まりで吸う（2 節）。

## 11. 負荷試験

| 試験 | 量 | 合否 | いつ |
| --- | --- | --- | --- |
| 受信 | 申し出 12,500 通/秒（迷惑メールの割合 6 割）を 1 時間 | NFR-001・NFR-003。受け付けの数と配送の数の差 0（[quality.md](../quality.md) の 2.2.1 節 F） | E17、段階を上げる前 |
| 迷惑メールの波 | 申し出 19,000 通/秒を 1 時間、うち `unknown`・`suspicious` 9 割 | 正規のメールの NFR-001 を保つ。溜まりが 2 時間で追いつく | E17 |
| 送信 | 300 通/秒、相手の模型の 4xx 10% | NFR-002 | E17 |
| 同期 | JMAP 40,000/秒、IMAP 40 万の接続、EventSource 20 万 | NFR-006・NFR-014 | E17 |
| 検索 | 200/秒（冷えたアカウント 2 割） | NFR-005 | E10、E17 |
| 組織の一斉の送信 | 2 万の受け手のグループへ 10 通/分を 10 分 | 他の受け手の NFR-001 を保つ | E14、E17 |

- 負荷の生成器は自前（Rust）と k6（[quality.md](../quality.md) の 2.2 節）。メールは生成器で作り、本物のメールを使わない。
- 本番の外部の事業者へ試験の送信をしない。送信の試験は検証の環境の外部の MTA の模型あて。

## 12. data-model への項目

この領域が足す表・置き場所はない。容量の数え（`account_usage`）は [ADR-0031](../decisions/0031-blob-references-gc-and-quota.md)、使用の率の指標は [observability.md](observability.md) にある。

## 13. テストと性質

| ID | 性質・試験 |
| --- | --- |
| PROP-CAP-001 | 負荷試験の終わりに、受け付けた（250 の）数と、受け手のメールボックスに入った数・DSN の数の和が、受け手ごとに等しい |
| 試験 | 11 節の負荷試験の全行 |
| 試験 | 迷惑メールの波の間、`inbound-delivery` の古さが 30 秒を超えない（低い層の待ち行列だけが溜まる） |

## 14. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E2 | `mx-throughput-poc` | 1 台の量（2 節） |
| E4 | `mailbox-shard-poc` | シャードの書き込みの量（4 節） |
| E10 | `search-index-poc` | `search-node` の量（6 節） |
| E17 | `load-tests` | 11 節の負荷試験 |
| E17 | `cost-baseline` | 本番の費用の計測と 8 節の見積もりの置き換え、下げる手段の採否 |

## 15. 未解決の問い

### 決定（2026-10-10、既定案）

- **大きさ**：S1 のピークの 2 倍と、波（3 倍・1 時間）の大きいほう。波は接続の層で絞り、受け付けた後は溜めて 2 時間で追いつく（ADR-0068）。
- **待ち行列の分け**：配送の待ち行列を、層で 2 つに分けて正規のメールを先にする。
- **費用**：S1 で 1 アカウント月 0.19〜0.21 USD（±40%）。予算との差は 8 節の手段で埋め、採否は `cost-baseline` で決める。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| 配送の待ち行列を 2 つに分けること | [inbound-smtp.md](inbound-smtp.md) の持ち主（Dev）が E2 で足す |
| `spool-done` の印と索引のセグメントの PUT の削減 | [inbound-smtp.md](inbound-smtp.md)・[search.md](search.md) の持ち主と `cost-baseline` |
| JMAP をエッジの外で受けるか | E8 の前に Dev と Ops。[architecture/README.md](README.md) の 1.2 節の図が変わる |
| 1 台・1 タスクの量の想定値 | `mx-throughput-poc`、`mailbox-shard-poc`、`search-index-poc` |
| 大阪の S3 の単価、観測とネットワークの費用 | `cost-baseline`（**未検証**） |
| 予約の割引の率 | `cost-baseline` |

## 出典

いずれも 2026-10-10 に取得・確認。

- AWS Price List の公開の価格（[Using the bulk API](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/using-the-aws-price-list-bulk-api.html)、ap-northeast-1）：
  - `AmazonRDS`（2026-10-06 の公開分）：Aurora PostgreSQL `db.r8g.large` I/O-Optimized 0.433、`db.r8g.xlarge` 0.866、`db.r8g.2xlarge` 1.732、`db.r8g.4xlarge` 3.464 USD/時。I/O-Optimized の保存 0.27 USD/GB・月、バックアップ 0.023 USD/GB・月
  - `AmazonS3`（2026-09-28 の公開分）：Standard 0.025（最初の 50 TB）・0.024（次の 450 TB）・0.023（500 TB 超）USD/GB・月、Standard-IA 0.0138、Glacier Instant Retrieval 0.005 USD/GB・月（取り出し 0.03 USD/GB）、PUT 0.0047 USD/1,000、GET 0.0037 USD/1 万、RTC の転送 0.015 USD/GB、S3 Inventory 0.0028 USD/100 万
  - `AWSDataTransfer`（2026-09-16 の公開分）：東京から大阪 0.09 USD/GB、インターネットへ 0.089〜0.084 USD/GB（量の段）
  - `AmazonECS`（2026-09-11 の公開分）：Fargate ARM の vCPU 0.04045、メモリー 0.00442 USD/GB・時
  - `AmazonElastiCache`（2026-09-14 の公開分）：Valkey `cache.r7g.xlarge` 0.4192 USD/時
  - `AWSQueueService`（2026-09-11 の公開分）：SQS 標準 0.40 USD/100 万（最初の段）
  - `AWSELB`（2026-09-11 の公開分）：NLB 0.0243 USD/時、LCU 0.006 USD/時
  - `awskms`（2026-09-11 の公開分）：要求 0.03 USD/1 万
- AWS の EC2 のオンデマンドの価格の公開のデータ（東京、Linux）：`c7g.xlarge` 0.1819、`c7gn.xlarge` 0.3148、`i8g.4xlarge` 1.6128 USD/時
- CloudFront と WAF の単価は [Shopify の capacity.md](../../../shopify/docs/architecture/capacity.md) の出典（AWS Price List `AmazonCloudFront` 2026-10-03 の公開分、`awswaf`）と同じ値を使った

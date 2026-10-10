# Capacity: Mercari

負荷のモデル（出品と写真、検索、購入、人気の出品の 1 秒 5,000 件の購入の試み、大型の企画の日、保存した検索と値下げの fan-out、通知）、部品ごとの必要量、S1・S2・S3 の大きさ、大型の企画の日の前もっての拡大、月の費用、負荷試験、キャパシティの運用を決める。単位あたりの原価は [infrastructure.md](infrastructure.md) の 9 節にある。

| ADR | 決定 |
| --- | --- |
| [0077](../decisions/0077-sizing-tiers-and-campaign-prescaling.md) | 部品の大きさを S1・S2・S3 の段で Terraform の変数に持ち、平常は 2 AZ で平常の山を受けられる最小の数と、CPU・キューの年齢の自動の拡大で動かす。大型の企画の日は、3 日前に core の読み出しの写しと OpenSearch のデータのノードを足し、60 分前に Fargate の最小の数を予定の拡大で上げる。人気の出品の急増は拡大で受けず、先着の印と出品ごとの同時実行の上限で受ける（1 つの行への集中は台数で解けない）。静かな時間の終わりの通知の山は、散らしと `engagement` の消費者の予定の拡大で受ける |

数値は本システムの想定で、「初期見積もり」は E18 の負荷試験と PoC（`hot-listing-purchase-poc`、`search-index-poc`、`saved-search-matcher-poc`、`counterfeit-classifier-poc`）の前の仮の値である。単価は AWS の公開の価格（出典）で、為替は 1 USD = 150 円（本システムの想定）。

## 1. 負荷のモデル（S1）

### 1.1 量

[architecture/README.md](README.md) の 2 節の S1 の値と、ここで置いた想定。

| 項目 | 平均 | 平常の日の山 | 大型の企画の日の最大 | 根拠 |
| --- | --- | --- | --- | --- |
| 日に使う利用者（DAU） | 100 万 | — | 150 万 | MAU 300 万の 1/3（本システムの想定） |
| アプリの API の要求 | 1,200 件/秒 | 4,000 件/秒 | 1 万件/秒 | DAU × 1 日 100 件 |
| 新しい出品 | 3.5 件/秒 | 10 件/秒 | 30 件/秒 | README の 30 万件/日 |
| 写真の上げ | 17 枚/秒 | 50 枚/秒 | 150 枚/秒 | 1 出品 5 枚（想定）。1 枚平均 3 MB（[listings-and-photos.md](listings-and-photos.md)）。元は変換の後 24 時間で消す |
| 出品の編集・値下げ | 10 件/秒 | 30 件/秒 | 150 件/秒 | 企画の日は値下げが集まる |
| 出品の詳細の閲覧（API） | 3,000 件/秒 | 6,000 件/秒 | 1.2 万件/秒 | 想定 |
| 検索 | 1,000 件/秒 | 1,500 件/秒 | 3,000 件/秒 | README の 3,000 件/秒（[quality.md](../quality.md) の 2.2.1 節 H） |
| 購入 | 1.2 件/秒 | 4 件/秒 | 50 件/秒 | README の 10 万件/日・最大 50 件/秒 |
| 人気の 1 出品への購入の試み | — | — | 5,000 件/秒（1 秒の間）。同時に 100 出品 | README の 2 節、[quality.md](../quality.md) の 2.2.1 節 H |
| 取引の操作（発送、受取評価、評価、キャンセル） | 10 件/秒 | 30 件/秒 | 200 件/秒 | 1 取引 8 回 |
| 取引のメッセージ・コメント | 30 件/秒 | 100 件/秒 | 300 件/秒 | 想定 |
| いいね | 100 件/秒 | 300 件/秒 | 1,000 件/秒 | 想定 |
| 写真の配信（エッジ） | 2.3 万件/秒 | 7 万件/秒 | 15 万件/秒 | DAU × 1 日 200 枚（一覧の小さい写真、30 KB） |
| プッシュの依頼 | 90 件/秒（1 日 800 万） | 500 件/秒 | 1,500 件/秒 | 1.3 節 |
| メール | 6 件/秒（1 日 50 万） | 20 件/秒 | 100 件/秒 | 取引 1 件 2 通と、保存した検索の日次のまとめ |
| 期限の処理 | 1 分 300 件 | 1 分 1,000 件 | 1 分 5,000 件（日の境と 13 時） | 取引 1 件に期限 4〜5 |

- 平常の日の山は 21〜22 時（想定）。大型の企画の日の最大は、普段の平均の 30 倍の購入が 1 時間続く（README の 2 節）。

### 1.2 人気の出品

- 限定品の出品の直後の 1 秒に 5,000 件。うち 30% は同じ利用者の連打、10% は古い価格（[quality.md](../quality.md) の 2.2.1 節 H）。
- 負ける 4,999 件は、`transactions` の Valkey の `SET NX` の失敗と、出品の写しの読みで返る（1 件 CPU 1ms・Valkey 2 操作。初期見積もり）。勝つ 1 件だけが core の行を更新する。
- 1 秒に 5,000 件の CPU は約 5 vCPU（`transactions`）と約 15 vCPU（`app-api`。認証と BFF で 3ms）で、最小のタスクの数の余力で受ける（4.2 節）。Valkey は 1 万操作/秒で、1 シャードの余力に収まる。
- Valkey が使えないときは、出品ごとの同時実行の上限（既定 4）で DB へ進み、負けの応答の p99 1 秒以内を目標にする（[ADR-0002](../decisions/0002-transaction-state-machine-and-single-purchase.md)）。

### 1.3 通知の fan-out

| 元 | 1 日の候補 | 送る数（上限・まとめの後） | 根拠 |
| --- | --- | --- | --- |
| 取引の通知 | 100 万 | 100 万 | 取引 10 万 × 事象 8 × 相手（想定） |
| 値下げ | 値下げ 20 万 × いいね平均 20 = 400 万 | 200 万 | 閾値、24 時間に 1 回、1 日 30 通の上限（[notifications.md](notifications.md) の 6 節） |
| 保存した検索 | 一致 2,000 万（S3 の 1 日 5 億の比） | 400 万 | 利用者ごとのまとめ（[saved-searches-and-alerts.md](saved-searches-and-alerts.md)） |
| いいね（自分の出品） | 800 万 | 50 万（1 時間に 1 通のまとめ） | 想定 |
| 合計（プッシュ） | — | 約 800 万（90 件/秒の平均） | — |

- **山**：静かな時間の終わり（9:00 から 60 分）に、夜の間に止めた `engagement` が 1 人 1 通にまとまって出る。100 万人なら 60 分で 280 件/秒。企画の開始の値下げの波で 1,500 件/秒。
- いいね 1 万の出品の値下げは、`notifier-fanout` の読み出し 10 ページと、`ntf-engagement` への 200 回の束の書き込みで、30 秒以内（初期見積もり）。

## 2. 部品ごとの必要量（S1、大型の企画の日の最大）

| 部品 | 1 件の費用（初期見積もり） | 最大の必要量 |
| --- | --- | --- |
| `app-api` | CPU 5ms/要求 | 1 万件/秒 × 5ms = 50 vCPU。使用率 60% で 84 vCPU |
| `search-api` | CPU 3ms/要求（組み立てと `listingVisible()` の写しの確かめ） | 3,000 件/秒 → 9 vCPU。60% で 15 vCPU |
| OpenSearch | 1 検索 10 シャード × 2ms = 20ms のデータのノードの CPU（集計を含む） | 3,000 件/秒 → 60 vCPU。使用率 80% で 75 vCPU → `r7g.2xlarge.search`（8 vCPU）× 9〜10 |
| `media-processor`（sharp） | 1 枚 0.5 vCPU 秒（向き、位置情報の除去、3 つの大きさ × 2 形式） | 150 枚/秒 → 75 vCPU |
| `ml-inference` | 文字 20ms/出品、画像 200ms/枚（CPU。`counterfeit-classifier-poc` で測る） | 150 枚/秒 → 30 vCPU |
| core の書き込み | 購入 10 行、出品の作成 15 行、編集 3 行、取引の操作 4 行、セッションの更新（1 時間に 1 回に間引く） | 約 3,000 行/秒 |
| core の読み出し | 出品の詳細 1〜2 問い（状態は Valkey の写し） | 1.5 万問い/秒（読み出し 2） |
| ledger の書き込み | 仕訳 1 件 3〜4 行。取引 1 件で 3〜4 仕訳 | 約 500 行/秒。熱い口座（`fee_revenue`・`psp_receivable`）は各 50 件/秒 |
| content の書き込み | いいね 1 行、お知らせ 1 行、送信の記録 1 行 | 約 5,000 行/秒 |
| Valkey | セッションの写し 3 GB、`listingVisible()` の写し 2 GB、保存した検索の逆索引の写し 4 GB、数え 1 GB | 約 10 GB。操作 5 万/秒 |
| SQS | outbox の事象、通知のレーン | 5,000 件/秒（通知を含む） |

## 3. 規模ごとの見え方

| 部品 | S1 | S2（目安） | S3（目安） |
| --- | --- | --- | --- |
| 購入の最大 | 50 件/秒 | 300 件/秒 | 2,000 件/秒 |
| 検索の最大 | 3,000 件/秒 | 2 万件/秒 | 10 万件/秒 |
| 索引の件数（売れた品を含む） | 1.5 億 | 6 億 | 30 億 |
| プッシュ（1 日） | 800 万 | 3,000 万 | 1.2 億 |
| core の書き込み | 3,000 行/秒 | 1.5 万行/秒 | 8 万行/秒（16 の分け先で 5,000 行/秒ずつ） |

## 4. 大きさ（S1）

ADR-0077。

### 4.1 データの部品

| 部品 | S1（平常） | 企画の日に足すもの | S2（目安） | S3（目安） |
| --- | --- | --- | --- | --- |
| Aurora core | `db.r8g.2xlarge` × 3（書き込み 1、読み出し 2）、I/O-Optimized | 読み出し 1 | `db.r8g.8xlarge` × 5 | `core-accounts` `db.r8g.8xlarge` × 3、`core-market` 16 × `db.r8g.4xlarge` × 3（[infrastructure.md](infrastructure.md) の 8 節） |
| Aurora ledger | `db.r8g.xlarge` × 2 | なし | `db.r8g.4xlarge` × 2（熱い口座のスロット） | 持ち主のハッシュで 8 × `db.r8g.2xlarge` × 2 |
| Aurora content | `db.r8g.2xlarge` × 2 | なし | 3 クラスタ（social・notify・ts）× `db.r8g.4xlarge` × 2 | 各クラスタを利用者のハッシュで 4 |
| Valkey | `cache.r7g.xlarge` × 2 シャード × 2 | なし | 6 シャード | 20 シャード |
| OpenSearch | データ `r7g.2xlarge.search` × 9、マスター `m7g.large.search` × 3、gp3 300 GB × 9 | データ 3 | 販売中 12 × `r7g.4xlarge.search`、売れた品 9 × `r7g.2xlarge.search` | 販売中 40、売れた品 30（目安） |
| 大阪 | Aurora の二次 × 3（`db.r8g.large`） | — | 同じ形（二次を大きく） | 分け先ごと |

- 共有の行の上限（1 つの出品の行への更新）は台数で増えない。人気の出品は先着の印と同時実行の上限で受ける（ADR-0077）。値は `hot-listing-purchase-poc` で確かめる。
- core の書き込みの `db.r8g.2xlarge` は、3,000 行/秒で CPU 30% 前後（初期見積もり）。

### 4.2 ECS（Fargate、ARM64。既定 2 vCPU・4 GB）

| サービス | 最小（2 AZ で平常の山） | 最大 | 拡大の指標 |
| --- | --- | --- | --- |
| `app-api` | 12 | 60 | CPU 60% |
| `ops-api`（1 vCPU） | 2 | 6 | CPU |
| `identity` | 4 | 16 | CPU |
| `listings` | 4 | 20 | CPU |
| `search-api` | 6 | 30 | CPU |
| `transactions` | 6 | 30 | CPU、同時実行 |
| `payments` | 3 | 12 | CPU |
| `ledger` | 3 | 8 | CPU、消費の遅れ |
| `payouts`（1 vCPU） | 2 | 4 | キューの年齢 |
| `shipping` | 3 | 12 | CPU |
| `messaging` | 3 | 12 | CPU |
| `trust-safety` | 3 | 12 | キューの年齢 |
| `notifier-decide`（級ごとのプール） | security・transactional 2＋2、engagement 2、announcement 1 | 各 4・4・30・6 | キューの年齢 |
| `notifier-send` | 3 | 12 | キューの年齢 |
| `notifier-fanout`（1 vCPU） | 2 | 8 | キューの年齢 |
| `relay`（0.5 vCPU） | クラスタごとに 2 | 4 | outbox の最古の年齢 |
| `media-processor` | 4 | 40 | キューの年齢 |
| `search-indexer` | 2 | 8 | キューの年齢（措置の優先のキューは別） |
| `saved-search-matcher` | 4 | 20 | キューの年齢 |
| `deadline-runner`（1 vCPU） | 2 | 6 | 遅れ |
| `reconcilers`（1 vCPU） | 2 | 4 | — |
| `ml-inference`（4 vCPU・8 GB） | 4 | 12 | キューの年齢 |

- 平常の平均で約 150 vCPU（`ml-inference` を除く）、企画の日の最大で約 300 vCPU。
- 自動の拡大の速さ（Fargate のタスクの起動まで 1〜3 分）は**未検証**。人気の出品と静かな時間の終わりの山は、拡大を待たずに最小の数の余力と散らしで受ける。

### 4.3 ML の推論

- S1 は Fargate の CPU で、画像の分類器 200ms/枚（初期見積もり）。S2 で写真が 1 日 500 万枚を超え、CPU が 120 vCPU を超えたら、GPU の ECS on EC2（`ml` のサブネット）を `counterfeit-classifier-poc` の数で比べて決める（[infrastructure.md](infrastructure.md) の 5 節）。

## 5. 大型の企画の日の前もっての拡大

ADR-0077。[runbooks/](../runbooks/README.md) の 5.2 節の段取りの中の、容量の作業。

| いつ | 作業 | 自動・手 |
| --- | --- | --- |
| 14 日前まで | PM から想定の量（購入、検索、値下げ、通知）を受け取り、1 節の最大と比べる。超えるなら段を上げる計画を作る | Ops |
| 3 日前 | core の読み出しの写しを 1 つ足す。OpenSearch のデータのノードを 3 つ足す（シャードの移りに数時間）。運送会社・決済の提供者に量を知らせる。縮めた規模の負荷試験 | Ops の承認 |
| 60 分前 | 予定の拡大：`app-api` 最小 30、`transactions` 15、`search-api` 15、`notifier-decide`（engagement）10、`notifier-send` 8、`media-processor` 10 | 自動（予定の拡大の動作） |
| 開始 | 自動の拡大が CPU とキューの年齢で続く。照合を 1 分ごとに | 自動 |
| 終わり＋2 時間 | ECS の最小を戻す | 自動 |
| 翌日 | 読み出しの写しと OpenSearch のノードを戻す | Ops |

- **毎日の 9 時**：静かな時間の終わりの散らしに合わせて、`notifier-decide`（engagement）と `notifier-send` の最小を 8:55〜10:05 だけ上げる（予定の拡大）。
- 人気の出品は予定できない。前もっての拡大はしない（1.2 節）。

## 6. 月の費用（S1、本番、初期見積もり）

単価は AWS Price List の公開の価格（ap-northeast-1、出典）。オンデマンド、730 時間。

| 項目 | 内訳 | 月（USD） |
| --- | --- | --- |
| Aurora core | `db.r8g.2xlarge` I/O-Optimized × 3（1.732/時）3,793、保存 1 TB（0.27/GB）276 | 4,070 |
| Aurora ledger | `db.r8g.xlarge` × 2（0.866/時）1,264、保存 200 GB 54 | 1,320 |
| Aurora content | `db.r8g.2xlarge` × 2 2,529、保存 1.5 TB 415 | 2,940 |
| Valkey | `cache.r7g.xlarge` × 4（0.4192/時） | 1,220 |
| OpenSearch | データ `r7g.2xlarge.search` × 9（0.856/時。`r7g.large.search` 0.214 の 4 倍と置いた：**未検証**）5,624、マスター `m7g.large.search` × 3（0.175）383、gp3 2.7 TB（0.1464）395 | 6,400 |
| Fargate（サービスと Worker） | 平均 150 vCPU・300 GB（vCPU 0.04045、GB 0.00442/時） | 5,400 |
| Fargate（`ml-inference`） | 平均 40 vCPU・80 GB | 1,440 |
| S3（写真） | 12 か月の積み上げ：変換の後 0.5 MB（3 つの大きさ × 2 形式の合計。想定）× 150 万枚/日 × 365 日 = 274 TB。元の写真は 24 時間だけ（4.5 TB 前後）。Standard の段（0.025・0.024）と、90 日の後の Standard-IA（0.0138） | 6,000 |
| CloudFront の転送 | 写真 6 TB/日 × 30 = 180 TB、段の単価（0.114〜0.084 USD/GB） | 16,200 |
| CloudFront の要求 | 9 × 10^9 件（DAU × 300 件 × 30 日）× 0.012 USD/1 万 | 10,800 |
| WAF | API の要求 3 × 10^9 × 0.60 USD/100 万 1,800、Bot Control（要求の 5%、1 USD/100 万）150、web ACL と規則 100 | 2,050 |
| SES | 1,500 万通 × 0.10 USD/1,000 | 1,500 |
| 可観測性 | CloudWatch Logs、AMP、X-Ray、Grafana（**未検証**） | 6,000 |
| 大阪（DR） | Aurora の二次 × 3（`db.r8g.large` I/O-Optimized 0.433/時）948、変換の後の写真の写しの転送 22.5 TB × 0.09 USD/GB 2,070、大阪の保管 270 TB の Standard-IA（東京の単価 0.0138 で置いた：**未検証**）3,820、その他 500 | 7,340 |
| ネットワーク（Network Firewall、NAT、エンドポイント） | **未検証** | 3,000 |
| データレイクと学習 | S3、Glue、Athena、学習のジョブ（**未検証**） | 2,500 |
| その他（KMS、Secrets Manager、AppConfig、SQS・SNS、ALB） | — | 3,000 |
| 合計 | | 約 8.1 万（約 1,220 万円）、±40% |

- 最も大きいのは写真のエッジ（転送 20%、要求 13%）、可観測性と大阪と写真の保管（各 8% 前後）、OpenSearch（8%）。Aurora の 3 クラスタは合わせて 10%。
- 下げる手段：一覧の写真の大きさと形式（AVIF・WebP）、写真の保管の段（Standard-IA、売れた品の写真の 1 年の後の削除）、Savings Plans（Fargate）とリザーブド（Aurora、OpenSearch）、CloudFront の大口の価格（**未検証**）。
- 外の費用（決済の提供者の手数料、SMS、運送会社の運賃）は含めない（[infrastructure.md](infrastructure.md) の 9 節）。
- 本家の原価は確かめていない（**未検証**）。

## 7. 負荷試験

| 場面 | 規模（E18） | 合否 |
| --- | --- | --- |
| 平常の山 × 2 | API 8,000 件/秒、検索 3,000 件/秒、購入 8 件/秒、写真 100 枚/秒 | runbooks の SLO の全部 |
| 大型の企画の日（[quality.md](../quality.md) の 2.2.1 節 H） | 購入 50 件/秒を 1 時間、検索 3,000 件/秒、値下げの fan-out（1 出品のいいね 1 万）、API 1 万件/秒 | 同上。照合の不一致 0。DB の接続の使用率 70% 以下 |
| 人気の出品 1 つ | 1 秒 5,000 件（連打 30%、古い価格 10%）、提供者の模型 300ms〜3 秒・失敗 5% | 二重の販売 0、成功 1、負けの応答 p99 200ms |
| 人気の出品 100 を同時 | 同上 × 100 | 同上。他の購入の NFR-002 |
| Valkey の停止の中の人気の出品 | 同上、Valkey なし | 二重の販売 0、負けの応答 p99 1 秒 |
| DB のフェイルオーバーの中の購入 | 購入 50 件/秒で core の書き込みを交代 | 二重の販売 0、取引の重複 0、照合の食い違い 0 |
| ledger の消費者の 10 分の停止 | 購入 50 件/秒 | 再開の後、release・refund の欠け 0、重複 0 |
| 通知の fan-out（[quality.md](../quality.md) の 2.2.1 節 I） | いいね 1 万の値下げ、広い条件の保存した検索 100 万と新しい出品 50 件/秒 | 値下げ・新着 p95 5 分、取引の通知 p95 10 秒（engagement に 100 万件を溜めた中で） |
| 静かな時間の終わり | 100 万人の溜まり | 60 分に均され、`notification_delay_seconds` の transactional の p95 10 秒 |
| 写真の急増 | 写真 300 枚/秒を 10 分 | 変換の p95 5 秒（NFR-015） |

- 環境：staging を S1 の大きさに一時に広げる。負荷の生成は canary のアカウントから、自前の生成器と k6 で行う（[quality.md](../quality.md) の 2.2 節）。合成の利用者と出品だけを使う。
- 本番での負荷試験はしない。本番の山は、見張りと実ユーザーの計測で見る。
- CloudFront と WAF への大きな合成の負荷の事前の届け出の要否は**未検証**（E18 の前に AWS の方針を確かめる）。

## 8. キャパシティの運用

| 見るもの | 頻度 | 持ち主 |
| --- | --- | --- |
| 段階を上げる 8 指標（[infrastructure.md](infrastructure.md) の 8 節） | 月次 | Ops、PM |
| 予定した大型の企画の一覧と前もっての拡大 | 週次 | Ops |
| 熱い出品の数、先着の印の取り合いの最大 | 週次 | Ops、Dev |
| 通知の量（級ごと）、静かな時間の終わりの山 | 週次 | Ops |
| 費用（取引あたり、MAU あたり、写真の保管と転送、索引の大きさ） | 月次 | Ops、PM（[runbooks/](../runbooks/README.md) の 6 節） |
| AWS の上限（Fargate の vCPU、Aurora のクラスタ、OpenSearch のノード、SES の送信の割り当て） | 月次。60% で引き上げを申請 | Ops |

## 9. data-model への項目

| 表・置き場所 | 中身 | 節 |
| --- | --- | --- |
| core：`capacity_reviews` | 月次の 8 指標の値（[infrastructure.md](infrastructure.md) と共有） | 8 |
| core：`campaign_scaling_plans` | 企画ごとの想定の量、足す部品、予定の拡大の時刻と結果 | 5 |

## 10. テストと性質

- 7 節の場面を `load-tests` の Story の合否にする。数は [quality.md](../quality.md) の 2.2.1 節 H・I と同じ。
- 性質（二重の販売 0、振り替えの重複 0）は、負荷の中でも照合の結果で確かめる（負荷試験の後に照合のジョブを回し、不一致 0）。

## 11. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E1 | `terraform-size-tiers` | 4 節の段の変数（ADR-0077） |
| E7 | `load-generator` | 1 節の負荷のモデル、人気の出品の場面 |
| E7 | `hot-listing-purchase-poc` | 1.2 節の数の確かめ |
| E17 | `notification-prescaling` | 5 節の毎日の 9 時の予定の拡大 |
| E18 | `load-tests` | 7 節 |
| E18 | `campaign-prescaling` | 5 節（ADR-0077） |
| E18 | `cost-baseline` | 6 節を請求の実績で置き換える |

## 12. 未解決の問い

### 決定（2026-10-10、既定案）

- **段**：S1・S2・S3 の大きさを Terraform の変数に持つ（ADR-0077）。
- **企画の日**：3 日前に読み出しと OpenSearch、60 分前に Fargate（ADR-0077）。
- **人気の出品**：拡大で受けず、先着の印と同時実行の上限（ADR-0077）。
- **費用**：S1 で月 約 8.1 万 USD、最大は写真のエッジ。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| 1 要求の CPU、OpenSearch の 1 検索の費用、画像の分類器の時間 | `search-index-poc`、`counterfeit-classifier-poc`、E18（**初期見積もり**） |
| 出品の行への同時実行の上限と、先着の印の効き方 | `hot-listing-purchase-poc` |
| 保存した検索の一致の数と通知の量 | `saved-search-matcher-poc` |
| `r7g.2xlarge.search` の単価、大阪の S3 の単価、ネットワーク・可観測性の費用 | `cost-baseline`（**未検証**） |
| Fargate の自動の拡大の速さ | E18（**未検証**） |
| 大きな合成の負荷の届け出 | E18 の前（**未検証**） |

## 出典

いずれも 2026-10-10 に取得・確認。

- AWS Price List の公開の価格（ap-northeast-1）。値は [Shopify の capacity.md](../../../shopify/docs/architecture/capacity.md) と [Gmail の capacity.md](../../../gmail/docs/architecture/capacity.md) の出典と同じ公開分を使った：
  - `AmazonRDS`：Aurora PostgreSQL I/O-Optimized `db.r8g.large` 0.433、`db.r8g.xlarge` 0.866、`db.r8g.2xlarge` 1.732 USD/時。I/O-Optimized の保存 0.27 USD/GB・月
  - `AmazonElastiCache`：Valkey `cache.r7g.xlarge` 0.4192 USD/時
  - `AmazonES`：`m7g.large.search` 0.175、`r7g.large.search` 0.214 USD/時、gp3 0.1464 USD/GB・月
  - `AmazonECS`：Fargate ARM の vCPU 0.04045、メモリー 0.00442 USD/GB・時
  - `AmazonS3`：Standard 0.025（最初の 50 TB）・0.024（次の 450 TB）、Standard-IA 0.0138 USD/GB・月
  - `AWSDataTransfer`：東京から大阪 0.09 USD/GB
  - `AmazonCloudFront`：日本の HTTPS の要求 0.012 USD/1 万、日本の転送 最初の 10 TB 0.114・次の 40 TB 0.089・次の 100 TB 0.086・次の 350 TB 0.084 USD/GB
  - `awswaf`：要求 0.60 USD/100 万、Bot Control 1 USD/100 万要求
- AWS, [Amazon SES pricing](https://aws.amazon.com/ses/pricing/)：送信 1,000 通あたり 0.10 USD

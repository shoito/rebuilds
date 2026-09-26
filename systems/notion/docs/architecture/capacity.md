# Capacity: Notion

負荷のモデル、部品ごとの必要量、シャードあたりの容量、パラメーター、上限。台数の表は [infrastructure.md](infrastructure.md) の 7 節、段階を上げる基準は同じく 12 節にある。

**ここの数値はすべて初期見積もりである。** E8 の負荷試験（k6）で確かめ、結果で置き換える。AWS の仕様で確かめていないものは「未検証」と書く。

## 1. 負荷のモデル

### 1.1 前提（S1）

| 項目 | 値 | 根拠・前提 |
| --- | --- | --- |
| 利用者 | 10 万 | [architecture/README.md](README.md) の 2 節 |
| DAU | 3 万 | 利用者の 30% |
| 同時接続（ピーク） | 1 万 | 同上。1 人 1.2 本程度（タブ・デスクトップ） |
| 編集中の接続 | 同時接続の 20%（2,000） | 残りは閲覧、または開いたまま |
| 編集中の接続が送るトランザクション | 0.5 件/秒 | クライアントは打鍵を 100ms ごとにまとめて送る（[collaboration.md](collaboration.md) の 4 節）。入力の合間を含めた平均 |
| 1 トランザクションの操作 | 平均 3 | 文字の編集、ブロックの属性、並びの変更 |
| 1 トランザクションで書く行 | 平均 5 | 操作のログ 1、ブロック 1.5、ページの `seq`（`page_seqs`）1、outbox 1、その他 0.5（[block-model.md](block-model.md)、[collaboration.md](collaboration.md) の 7 節） |
| ページを開く | 接続あたり 2 分に 1 回 | |
| 1 回のページの読み込みでサーバーから読むブロック | 平均 300 | 1,000 ブロックのページ（NFR-002）もある。ローカルにあれば差分だけ |
| 同じページを開いている人 | 平均 3、最大 1,000 | 大多数は 1〜2 人。最大は全社の告知ページ |
| 在席・カーソルの更新 | 編集中の接続あたり 5 件/秒（100〜200ms に間引く） | 永続化しない |
| ブロック | 10 億 | README の 2 節 |

### 1.2 段階ごとの負荷（ピーク）

S2 と S3 は、S1 の前提の比率を保ったまま、規模だけを伸ばした値である。

| 項目 | S1 | S2 | S3 |
| --- | --- | --- | --- |
| 同時接続（WebSocket） | 1 万 | 100 万 | 1,000 万 |
| トランザクション/秒 | 1,000 | 10 万 | 100 万 |
| 操作（編集）/秒 | 3,000 | 30 万 | 300 万 |
| DB の行の書き込み/秒 | 約 6,000 | 約 60 万 | 約 600 万 |
| ページの読み込み/秒 | 約 100 | 約 1 万 | 約 10 万 |
| ブロックの読み取り/秒 | 約 3 万 | 約 300 万 | 約 3,000 万 |
| データベースのビューの問い合わせ/秒 | 30 | 3,000 | 3 万 |
| 検索/秒 | 20 | 2,000 | 2 万 |
| 配信（Gateway → クライアント）/秒 | 約 3 万 | 約 300 万 | 約 3,000 万 |
| 保存するブロック | 10 億（約 1 TB） | 1,000 億（約 100 TB） | 数千億（数百 TB） |
| 操作のログ（30 日ぶん、畳む前） | 約 250 GB | 約 25 TB | 約 250 TB |

- ブロック 1 行を、索引込みで約 1 KB とみなす（未計測。本家の 1 行の大きさは公開されていない）。本家は 2024 年時点で 2,000 億を超えるブロックを持ち、6〜12 か月で倍になっていた（[Building and scaling Notion's data lake](https://www.notion.com/blog/building-and-scaling-notions-data-lake)）。
- 操作のログは、30 日の後に消し、履歴はスナップショットで持つ（[ADR-0005](../decisions/0005-transactions-as-unit-of-change.md)、[block-model.md](block-model.md) の 8 節、[collaboration.md](collaboration.md) の 12 節）。

## 2. 部品ごとの必要量（S1）

### 2.1 Aurora（writer）

| 処理 | 行の書き込み/秒 |
| --- | --- |
| トランザクション（操作のログ、ブロック、ページの `seq`、outbox） | 約 5,000 |
| 通知、コメント、検索の索引の印、監査ログ | 約 1,000 |
| **合計** | **約 6,000** |

- `db.r8g.4xlarge`（16 vCPU、128 GiB）の writer で、CPU 50% 以下を目標にする。Slack（`2xlarge` で 4,000 行/秒）より行が大きく（ブロックの JSON）、ページの `seq` の行に更新が集中するため、1 段大きくする。
- ページの `seq` の行は、同じページを同時に編集する人数ぶんの行ロックの競合になる。1 ページへのトランザクションは最大で 1 秒に数十件（数十人の同時編集）を想定し、それを超える場合は [collaboration.md](collaboration.md) で扱う。

### 2.2 Aurora（reader）

- ブロックの読み取り（約 3 万行/秒）、データベースのビューの問い合わせ、権限の判定の祖先の読み取りを、reader 2 台に分ける。
- ページの読み込みの大部分は、クライアントのローカルの写しと差分の取得で減らす（[collaboration.md](collaboration.md)）。権限の判定の結果はキャッシュする（[permissions-and-sharing.md](permissions-and-sharing.md)）。
- 書いた直後に読む処理（トランザクションの応答）だけ writer を使う。

### 2.3 DB の接続数

| 利用者 | タスクあたりのプール | S1 の最大タスク数 | 最大の接続数 |
| --- | --- | --- | --- |
| api | 20（writer 10、reader 10） | 20 | 400 |
| workers | 5 | 20 | 100 |
| relay | 3 | 2 | 6 |
| migrator、reshard、運用 | — | — | 30 |
| 論理レプリケーション（CDC、再シャーディング） | — | — | 10 |
| **合計** | | | **約 550** |

- Slack と同じ規則：オートスケールの上限での合計を、`max_connections` の 50% 以下に保つ。`max_connections` の既定値は `LEAST({DBInstanceClassMemory/9531392}, 5000)`（Slack の [capacity.md](../../../slack/docs/architecture/capacity.md) の 2.2 節）。
- **S2 では、api のタスクが全クラスタへのプールを持つ。** 24 クラスタ × タスクあたり 4 本 × 200 タスクで、1 クラスタあたり 800 本になる。タスクあたりのプールを、クラスタごとに小さく（writer 2、reader 2）し、負荷の大きいクラスタだけ広げる。それでも足りなければ、ワークスペースの論理シャードで api のタスクを分ける（シャードの群れごとの api のサービス）か、接続の集約の方式を比べる（未決定。S2 の前に決める）。

### 2.4 Sync Gateway

| 項目 | S1 |
| --- | --- |
| 接続の上限 | 1 タスク 1 万接続（1 vCPU / 2 GB）を上限とみなす（未計測） |
| 目標の接続数 | 上限の 60% |
| 配信 | 1,000 トランザクション/秒 × 平均 3 人 ＋ 在席 1 万件/秒 × 平均 3 人 ≒ 3 万件/秒 |
| タスク数 | 最小 3（AZ ごと。接続数では 2 で足りる） |

- **再接続の殺到**：AZ を 1 つ失うと、約 3,300 接続が再接続する。ジッター付きで 30 秒に分散させ、タスクあたりの受け付けを毎秒 200 に制限する（Slack と同じ）。再接続の後の差分の取得は、開いているページの数だけ起きるので、api と reader の負荷として見積もる：3,300 × 開いているページ 2 ÷ 30 秒 ≒ 220 件/秒。
- 巨大なページ（1,000 人が開いている）への 1 トランザクションは、全タスクに合計 1,000 件の送信になる。在席の更新は、ページあたりの配信の頻度を落として抑える（[collaboration.md](collaboration.md)）。

### 2.5 API

- ピーク：ページの読み込み 100 件/秒（重い）、トランザクション 1,000 件/秒、データベースの問い合わせ 30 件/秒、検索 20 件/秒、その他の読み取り 1,500 件/秒。
- 1 vCPU あたり約 300 リクエスト/秒（ページの読み込みと権限の判定が重いので、Slack より低く見る）として、約 10 vCPU。2 vCPU のタスクで平常 6、ピーク 10。

### 2.6 Worker と SQS

| キュー | ピークの流量 | 処理時間 p99 | タスク数 |
| --- | --- | --- | --- |
| search-index（ページ単位にまとめる） | 300 件/秒 | 100 ms | 2 |
| search-acl（権限・移動の反映） | 10 件/秒（1 件で多数の文書） | 数秒 | 1 |
| notify-events・notify-push | 100 件/秒 | 50 ms | 2 |
| file-events | 10 件/秒 | 2 秒 | 1 |
| webhook-delivery | 50 件/秒 | 外部に依存 | Lambda（[api-and-integrations.md](api-and-integrations.md)） |
| import-export | 1 件/秒 | 数分 | 2 |
| backfill（マイグレーション） | 物理クラスタの負荷で制御 | — | 1 |

キューの名前は [search.md](search.md) の 8 節、[comments-and-notifications.md](comments-and-notifications.md) の 5 節、[api-and-integrations.md](api-and-integrations.md) の 6.4・12 節、[infrastructure.md](infrastructure.md) の 5 節に合わせた。

## 3. パラメーター

Slack の [capacity.md](../../../slack/docs/architecture/capacity.md) の 3 節（`statement_timeout`、`lock_timeout`、`idle_in_transaction_session_timeout`、Node.js、ALB、Valkey、SQS）を引き継ぐ。Notion での追加と違いだけを書く。

### 3.1 Aurora

| パラメーター | 値 | 理由 |
| --- | --- | --- |
| `rds.logical_replication` | 1 | 再シャーディングと CDC。writer の再起動が要るので最初から有効にする（[ADR-0028](../decisions/0028-zero-downtime-resharding.md)） |
| `max_replication_slots`、`max_wal_senders`、`max_logical_replication_workers` | 20 | 再シャーディングの群れの数と CDC のコネクターの数の合計以上（[AWS のドキュメント](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/AuroraPostgreSQL.Replication.Logical.Configure.html)） |
| `app` ロールの `search_path` | 空 | ルーターを通らないクエリを失敗させる（[ADR-0027](../decisions/0027-shard-router.md)） |
| `statement_timeout`（`app`） | 5 秒。データベースの問い合わせのルートだけ 10 秒 | 1 万行のビュー（NFR-003）に余裕を持たせる |
| `work_mem` | 32 MB | データベースのビューの並べ替えとグループ化 |
| `autovacuum_max_workers` | 6 | テーブルの数が 480 倍になるため、同時に掃除できる数を増やす |

**更新の多いテーブル**（各シャードのスキーマで同じ設定）：

| テーブル | 設定 | 理由 |
| --- | --- | --- |
| `page_seqs`（ページの `seq` を持つ行） | `fillfactor = 70`、`autovacuum_vacuum_scale_factor = 0.01` | トランザクションごとに更新する。HOT 更新にする |
| ブロック | `fillfactor = 80` | 本家の更新の比率は upsert の 90%（[data lake](https://www.notion.com/blog/building-and-scaling-notions-data-lake)） |
| 操作のログ、outbox | 時間でパーティションを切り、古いものを `DROP` する | 大量の挿入と削除を VACUUM に任せない |

- **トランザクション ID の周回（wraparound）を監視する。** 本家は、単一の DB で VACUUM が追いつかず、周回の危険がシャーディングの引き金になった（[Herding elephants](https://www.notion.com/blog/sharding-postgres-at-notion)）。`age(datfrozenxid)` を監視し、閾値でアラームを出す（[observability.md](observability.md)）。

### 3.2 アプリのプール

| 設定 | S1 | S2 |
| --- | --- | --- |
| api の 1 クラスタあたりのプール | writer 10、reader 10 | writer 2、reader 2（重いクラスタだけ広げる） |
| `connectionTimeoutMillis` | 2,000 | 同左 |
| `frozen` のシャードへの書き込みの待ち | 最大 10 秒 | 同左 |

### 3.3 Sync Gateway

Slack の Gateway の設定（`ulimit nofile`、`maxPayload`、送信バッファの上限、心拍 25 秒、毎秒の受け付け 200）を引き継ぐ。WebSocket で変更を受けるなら、`maxPayload` はトランザクションの上限（3.5 節）に合わせる。

### 3.4 オートスケール（S1）

| サービス | 指標と目標 | 最小 / 最大 |
| --- | --- | --- |
| api | CPU 50%、ターゲットあたりのリクエスト数 | 3 / 20 |
| sync-gateway | タスクあたりの接続数 6,000 | 3 / 9 |
| relay | 固定 | 2 / 2 |
| workers | キューごとの最古のメッセージの経過時間 | 合計 8 / 20 |

### 3.5 上限（技術的な上限。S1）

特定のワークスペース・ページが共有の資源を占有しないための上限。値の正は、それぞれの領域の文書にある。ここには、容量の見積もりの前提として使う値を並べる。

| 対象 | 上限 | 超えたとき | 正 |
| --- | --- | --- | --- |
| 1 トランザクションの操作の数 | 1,000 | 拒否（クライアントが分割する） | [block-model.md](block-model.md) の 10 節 |
| 1 トランザクションの大きさ | 500 KB | 拒否 | 同上 |
| 1 ワークスペースのトランザクション | 1 秒に 200 件 | 待たせる（429 と `retry_after`） | この文書（既定案） |
| 1 利用者のトランザクション | 1 秒に 20 件 | 同上 | 同上 |
| 1 ページのブロック | 上限 10 万（超えたら追加を拒否）。5 万を超えると表示の目標を外れる見込みなので警告を出す | 警告・拒否 | [block-model.md](block-model.md) の 10 節 |
| 1 データソースの行 | 上限 25 万。NFR-003 は 1 万行、10 万〜25 万行は p95 2 秒を目標にする | 拒否。問い合わせは時間の上限で打ち切る | [databases.md](databases.md) の 11・12 節 |
| 検索 | 1 利用者 1 分に 60 回（MCP の `search` は 1 分に 30 回） | 429 | [search.md](search.md) の 6.4 節、[api-and-integrations.md](api-and-integrations.md) の 8.1 節 |
| 公開 API | 1 連携 1 分に 180 回（Business 以上は 600 回）。ワークスペースの合計は負荷試験で決める | 429 | [api-and-integrations.md](api-and-integrations.md) の 5 節 |
| 1 ワークスペースの同時接続 | 1 万（S1 の全体の同時接続と同じ） | 超えた接続は、在席の配信を間引く | [collaboration.md](collaboration.md) |

上限を一時的に変えるのは、ワークスペース単位の上書きで行い、監査ログに残す（Slack の runbooks の 2 節と同じ）。上書きは表 `rate_limit_overrides` に持つ。主キー `(workspace_id, id)`、列は `target`（`workspace` / `integration`）、`integration_id`、`limit_name`、`value`、`reason`、`created_by`（運用者）、`expires_at`。索引は `(workspace_id, expires_at)`。期限を過ぎた行は効かない。

## 4. シャードあたりの容量

| 項目 | S1 | S2 | S3（リージョンごと） |
| --- | --- | --- | --- |
| 論理シャードの平均の負荷 | 約 2 トランザクション/秒 | 約 210 | 約 2,100（1 リージョンに全体が乗った場合） |
| 論理シャードの平均のブロック | 約 200 万 | 約 2 億 | 数億〜10 億 |
| 1 物理クラスタの論理シャード | 480 | 20 | 2 |
| 1 物理クラスタの目安の上限 | 5,000 トランザクション/秒（writer CPU 50%、`db.r8g.8xlarge` 程度。**未計測**） | 同左 | 同左 |

- 論理シャードの負荷は、ワークスペースの大きさの偏りで平均からずれる。平均の 3 倍までを、同じクラスタの中の余裕で吸収する前提にする。それを超えるシャードは、空きのあるクラスタへ移す（[infrastructure.md](infrastructure.md) の 3.2 節）。
- **論理シャードの数（480）が、1 リージョンで伸ばせる上限を決める。** S3 で 1 つの論理シャードの負荷が 1 物理クラスタの上限に近づく。S3 では、リージョンを分けて 1 リージョンあたりの負荷を減らす（[infrastructure.md](infrastructure.md) の 11 節）か、巨大なワークスペースの扱い（[ADR-0003](../decisions/0003-workspace-sharding.md) の Consequences）を決める。
- **巨大なワークスペース 1 つ**は、1 つの論理シャードに収まる必要がある。S1〜S2 では、最大のワークスペースを 1 シャードの平均の 10 倍（S2 で 2,000 トランザクション/秒）以下と見込む。これを超える顧客の見込みが出たら、S3 の検討を前倒しする。

## 5. 余裕の方針

- 1 つの AZ を失っても足りること。平常時の使用率を上限の 2/3 以下に保つ（Slack と同じ）。
- writer は CPU 50% を上限とみなす。再シャーディングの間は、論理デコードの負荷を見込み、移動元の writer を 40% 以下に保つ。
- 再シャーディングとマイグレーションの群れの適用は、ピークの時間帯（日本時間の平日 9〜18 時）を避ける。

## 6. キャパシティの運用

| 活動 | 頻度 | 担当 |
| --- | --- | --- |
| 実際の負荷（トランザクション/秒、接続数、writer の CPU、シャードごとの負荷の分布）と 1 節のモデルの比較 | 月次 | Ops |
| 論理シャードの偏り（上位 10 シャードの負荷の比率）の確認 | 月次 | Ops |
| モデルの更新と 3 か月先の予測 | 四半期 | Ops、PM |
| 負荷試験（k6）：1 節の 1 倍・2 倍、AZ の喪失、再接続の殺到、巨大なページ・データベース、1 つのシャードへの集中 | リリース前、四半期 | QA、Ops |
| 段階を上げる判断（[infrastructure.md](infrastructure.md) の 12 節） | 月次の比較の結果で | Ops、Dev |

負荷試験の結果は、この文書と [infrastructure.md](infrastructure.md) の 7 節に反映する。見積もりと 30% 以上ずれた項目は、原因を記録する。

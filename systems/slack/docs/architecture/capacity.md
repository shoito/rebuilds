# Capacity: Slack

負荷のモデル、部品ごとの必要量、パラメーターの設定、キャパシティの運用。台数の表は [infrastructure.md](infrastructure.md) の 4 節、段階を上げる判断の基準は同じく 8 節にある。

**ここの数値はすべて初期見積もりである。** E7 の負荷試験（k6）で確かめ、結果で置き換える。AWS の既定値や仕様で確かめていないものは「未検証」と書く。

## 1. 負荷のモデル（S1）

| 項目 | 値 | 根拠・前提 |
| --- | --- | --- |
| 同時接続 | 50,000（NFR-001） | ピーク時。1 人が 1.2 本程度（複数の端末） |
| DAU | 100,000 | 同時接続のおよそ 2 倍 |
| 1 人 1 日の投稿 | 50 件 | スレッド返信を含む |
| 1 日の投稿 | 500 万件 | 100,000 × 50 |
| 投稿の平均 | 約 58 件/秒 | 500 万 ÷ 86,400 |
| **投稿のピーク** | **300 件/秒** | 平均の約 5 倍（日本時間の平日 10〜11 時に集中する） |
| リアクション・編集・削除 | 投稿の 0.5 倍 | `seq` を消費するイベント |
| 既読の更新 | 1,500 件/秒（ピーク） | 1 秒の間引き後、接続の約 3% が毎秒送る（[read-state-and-notifications.md](read-state-and-notifications.md)） |
| 入力中の表示 | 投稿の 3 倍 | 永続化しない（[realtime.md](realtime.md)） |
| 1 投稿あたり、配信を受ける接続 | 平均 20、最大 5,000 | 大多数は小さなチャンネル。最大は全員のチャンネル |
| 履歴・一覧などの読み取り API | 3,000 リクエスト/秒（ピーク） | 接続あたり 17 秒に 1 回 |
| 検索 | 50 件/秒（ピーク） | 1 人 1 分に 30 回の上限（search.md） |
| ファイルのアップロード | 20 件/秒（ピーク） | 投稿の約 7% |
| 保存するメッセージ | 1 年で約 18 億件、約 1.8 TB | 1 行を索引込みで約 1 KB とみなす |

## 2. 部品ごとの必要量

### 2.1 Aurora（writer）

| 処理 | 行の書き込み/秒（ピーク） |
| --- | --- |
| 投稿（`channels` の更新、`messages`、`mentions`、`outbox`、`channel_events`） | 約 1,500 |
| リアクション・編集・削除 | 約 600 |
| 既読の更新 | 約 1,500 |
| 通知の記録、監査ログ、その他 | 約 500 |
| **合計** | **約 4,000** |

- `db.r8g.2xlarge`（8 vCPU、64 GiB）の writer で、CPU 使用率 50% 以下を目標にする。超えるなら、書き込みの間引き（既読の更新）を強めるか、`db.r8g.4xlarge` に上げる。
- 読み取りは reader に回す（履歴、一覧、検索、差分取得）。書いた直後に読む処理（投稿の応答、`hello` の `last_seq`）だけ writer を使う。
- ストレージは 1 年で約 2 TB（索引・outbox・監査ログを含めて多めに見る）。Aurora は自動で伸びるので、上限ではなく費用として見る。

### 2.2 DB の接続数

| 利用者 | タスクあたりのプール | S1 の最大タスク数 | 最大の接続数 |
| --- | --- | --- | --- |
| api | 15 | 30 | 450 |
| workers | 5 | 20 | 100 |
| relay | 3 | 2 | 6 |
| migrator、運用 | — | — | 20 |
| **合計** | | | **約 580** |

- 規則：**オートスケールの上限まで増えたときの合計を、`max_connections` の 50% 以下に保つ。** Aurora の `max_connections` の既定値は `LEAST({DBInstanceClassMemory/9531392}, 5000)` で、`db.r8g.2xlarge`（メモリ 64 GiB）では上限の 5,000 になる（[AWS のドキュメント](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/AuroraPostgreSQL.Managing.html#AuroraPostgreSQL.Managing.MaxConnections)）。
- Gateway は DB に接続しない（[realtime.md](realtime.md)）。
- RDS Proxy は使わない。AWS のドキュメントでは、PostgreSQL で `SET` と `set_config` を使うと接続が固定（pinning）される。`SET LOCAL` を除く記述はない（[AWS のドキュメント](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy-pinning.html#rds-proxy-pinning.postgres)）。テナントのコンテキストの設定（`SET LOCAL` または `set_config(..., true)`）は毎トランザクションで行うので、ほぼすべての接続が固定され、多重化が効かない。S2 で接続数が上の規則を超えそうになったら、まず読み取りを reader に分け、タスクあたりのプールを小さくする。それでも足りなければ、接続の集約の方式を改めて比べる。

### 2.3 Gateway

| 項目 | 値 |
| --- | --- |
| 接続の上限 | 1 タスク 1 万接続（2 vCPU / 4 GB） |
| 接続あたりのメモリ | 50 KB 以下を目標（`ws` のバッファ、購読の表、接続の状態） |
| 配信のピーク | 300 投稿/秒 × 平均 20 接続 ＝ 6,000 件/秒。入力中・在席・既読を足して約 3 万件/秒。9 タスクで 1 タスク約 3,300 件/秒 |
| Valkey からの受信 | 購読をノード単位にまとめるので、1 イベントあたり最大でタスク数（9）回 |
| タスク数 | 50,000 ÷ 6,000（上限の 60%）＝ 9 |

- 巨大なチャンネル（5,000 人）への 1 投稿は、全タスクに合計 5,000 件の送信になる。イベントは 1 回だけシリアライズして同じバッファを使い回すので、CPU よりネットワークの帯域が先に効く。
- **再接続の殺到**を最大の負荷として見積もる。1 つの AZ を失うと、約 1.7 万接続が一度に再接続する。
  - クライアントは、ジッター付きで 30 秒に分散して再接続する。これで `hello` は約 550 件/秒になる。
  - Gateway は、1 タスクあたり毎秒の受け付け数を 200 に制限し、超えた分は `4029` で待たせる。
  - `hello` の後の差分取得は、1 クライアントあたり同時に 3 本までにする。

### 2.4 Valkey

- Pub/Sub のメッセージ：約 3 万件/秒 × 平均 1 KB 未満。`cache.r7g.large` のネットワーク帯域に十分収まる見込み。
- 在席：TTL 付きのソート済み集合を、接続の数だけ持つ。メモリは 100 MB 程度。
- 投稿のレート制限などのカウンターを置く。

### 2.5 API

- ピークは約 3,000 リクエスト/秒（読み取り）＋ 約 2,000 リクエスト/秒（書き込み）。
- Hono と Node.js で、DB の往復を含めて 1 vCPU あたり約 500 リクエスト/秒と見て、10 vCPU ぶん（1 vCPU のタスク × 10）。平常時は 6 タスク、ピークにはオートスケールで 10〜12 タスクになる。

### 2.6 SQS と Worker

| キュー | ピークの流量 | Worker の処理時間 p99 | タスク数 |
| --- | --- | --- | --- |
| search-index | 450 件/秒 | 50 ms | 2 |
| notify-plan | 300 件/秒 | 30 ms | 2 |
| notify-fanout・push | 1,000 件/秒 | 200 ms（外部の push サービス） | 4 |
| thumbnail | 20 件/秒 | 2 秒 | 2 |
| unfurl | 30 件/秒 | 3 秒（外部のサイト） | Lambda（ADR-0016） |
| app-events・app-delivery（E12） | 約 150 件/秒（設計値 500 件/秒） | 外部のアプリの応答に依存 | 振り分けは ECS、送信は Lambda（[apps.md](apps.md)） |

標準キューのスループットは上限を気にしなくてよい（SQS の標準キューはほぼ無制限）。

## 3. パラメーターの設定

すべて Terraform で管理する（[ADR-0020](../decisions/0020-infrastructure-as-code-with-terraform.md)）。変更は PR で行い、変えた理由をコメントに残す。

### 3.1 Aurora PostgreSQL

| パラメーター | 値 | 理由 |
| --- | --- | --- |
| `statement_timeout` | `app` ロール 5 秒、`relay` 5 秒、`migrator` 0 | ロールに対して設定する（`ALTER ROLE`）。暴走したクエリが接続を占有しない |
| `lock_timeout` | `app` 2 秒、`migrator` 3 秒 | マイグレーションがロックを待ち続けて、全体を止めない（ADR-0022） |
| `idle_in_transaction_session_timeout` | 10 秒 | トランザクションを開いたまま放置された接続を切る。テナントのコンテキストの残留も防ぐ |
| `random_page_cost` | 1.1 | Aurora のストレージは SSD 相当 |
| `work_mem` | 16 MB | 検索とソートのため。接続数 × 同時のソート数で、メモリを使い切らない範囲 |
| `log_min_duration_statement` | 500 ms | 遅いクエリを記録する |
| `shared_preload_libraries` | `pg_stat_statements`、`auto_explain` | クエリごとの負荷を見る |
| `auto_explain.log_min_duration` | 1 秒 | 遅いクエリの実行計画を残す |

**更新の多いテーブル**には、テーブル単位で設定する。

| テーブル | 設定 | 理由 |
| --- | --- | --- |
| `channels` | `fillfactor = 70`、`autovacuum_vacuum_scale_factor = 0.01` | 投稿のたびに `last_seq` を更新する。空きを残して HOT 更新にし、索引の更新と肥大化を避ける |
| `channel_members` | `fillfactor = 80`、`autovacuum_vacuum_scale_factor = 0.02` | 既読の更新が多い |
| `outbox` | 時間でパーティションを切り、古いパーティションを `DROP` する | 大量の挿入と削除を VACUUM に任せない（[realtime.md](realtime.md) の Relay） |
| `messages` | 既定のまま。S2 で行数が 50 億を超えそうになったら、`workspace_id` のハッシュでのパーティションを検討する | |

### 3.2 アプリの DB クライアント（node-postgres）

| 設定 | 値 |
| --- | --- |
| `max` | 2.2 節の表 |
| `connectionTimeoutMillis` | 2,000 |
| `idleTimeoutMillis` | 30,000 |
| 接続時の設定 | `application_name` にサービス名とタスクの ID |

### 3.3 Node.js（全サービス）

| 設定 | 値 | 理由 |
| --- | --- | --- |
| `--max-old-space-size` | タスクのメモリの 75% | コンテナの上限の前に、Node.js の GC を働かせる |
| `server.keepAliveTimeout` | 65 秒 | ALB のアイドルタイムアウト（api は 60 秒）より長くする。短いと、ALB が切れた接続を使って 502 を返す |
| `server.headersTimeout` | 66 秒 | `keepAliveTimeout` より長くする |
| 終了の処理 | SIGTERM で新しい受け付けを止め、処理中のリクエストを終えてから終わる | デプロイ中のエラーを 0 にする（ADR-0022） |

### 3.4 Gateway

| 設定 | 値 | 理由 |
| --- | --- | --- |
| `ulimit nofile` | 65,536（タスク定義で明示） | 1 万接続＋Valkey などの接続。Fargate の既定値もソフト・ハードとも 65,535 だが（[ECS の API リファレンス](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_Ulimit.html)）、既定値に頼らず明示する |
| `ws` の `perMessageDeflate` | 無効 | 圧縮は CPU とメモリを接続ごとに使う。イベントは小さい |
| `ws` の `maxPayload` | 64 KB | クライアントからの大きなフレームを拒否する |
| 送信バッファの上限 | 1 MB（`bufferedAmount`） | 超えたら遅い受信者として `4003` で切る（[realtime.md](realtime.md) の 7 節） |
| ping | 25 秒ごと。60 秒間なにも受信しなければ切る | ALB のアイドルタイムアウト（120 秒）より十分短く |
| 毎秒の受け付け数 | 1 タスク 200 | 再接続の殺到を平らにする |

### 3.5 ALB と CloudFront

| 対象 | 設定 | 値 |
| --- | --- | --- |
| ALB（api） | アイドルタイムアウト | 60 秒 |
| ALB（gateway） | アイドルタイムアウト | 120 秒 |
| ターゲットグループ（api） | 登録解除の遅延 | 30 秒 |
| ターゲットグループ（gateway） | 登録解除の遅延 | 180 秒 |
| ターゲットグループ（api） | ヘルスチェック | 10 秒ごと、2 回続けて失敗で外す |
| WAF | IP ごとのレート制限 | 5 分に 2,000 リクエスト（ログインなど認証の経路は、より厳しく） |

大規模な告知などで、平常の数倍の接続が一度に来ることがわかっているときは、ALB の容量の予約（LCU の予約）を事前に使う。予約は 100 LCU 以上で、通常は数分、長いと数時間で反映される。減らせるのは 1 日 2 回まで（[AWS のドキュメント](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/capacity-unit-reservation.html)）。告知の前日までに予約する。

### 3.6 ElastiCache（Valkey）

| パラメーター | 値 | 理由 |
| --- | --- | --- |
| `maxmemory-policy` | `volatile-ttl` | 在席などの TTL 付きのキーから消す。TTL のないキー（レート制限の設定など）は消さない |
| `client-output-buffer-limit`（pubsub） | ハード 256 MB、ソフト 64 MB・60 秒 | ElastiCache では `client-output-buffer-limit-pubsub-*` の 3 つのパラメーターで変えられる（[AWS のドキュメント](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/ParameterGroups.Engine.html)）。既定値（32 MB / 8 MB・60 秒）では、配信の急増で Gateway の購読が切られうる。切られても差分取得で回復するが、頻発させない |
| `timeout` | 0 | Gateway の購読の接続を、アイドルで切らない |
| `tcp-keepalive` | 60 | 死んだ接続を検知する |

### 3.7 SQS

| 設定 | 値 |
| --- | --- |
| 可視性タイムアウト | Worker の処理時間 p99 の 6 倍（最低 30 秒） |
| 受信 | ロングポーリング 20 秒、1 回 10 件 |
| DLQ へ移す受信回数 | 5 回 |
| メッセージの保持 | 4 日（DLQ は 14 日） |

### 3.8 オートスケール

| サービス | 指標と目標 | 最小 / 最大（S1） | スケールアウト / スケールインの待ち |
| --- | --- | --- | --- |
| api | CPU 50%、ターゲットあたりのリクエスト数 | 3 / 30 | 60 秒 / 300 秒 |
| gateway | タスクあたりの接続数 6,000 | 3 / 24 | 60 秒 / 900 秒（縮めるときは 1 回 1 タスクまで） |
| relay | 固定（アクティブ 1、待機 1） | 2 / 2 | — |
| workers | キューの最古のメッセージの経過時間（目標 5 秒）とメッセージ数 | 各 1 / 各 10 | 60 秒 / 300 秒 |

### 3.9 クォータ（着手前に引き上げを申請する）

| 対象 | 確かめること |
| --- | --- |
| Fargate の vCPU の上限（リージョンごと） | オートスケールの最大と、デプロイ中の新旧の二重分の合計が収まるか |
| SES の送信の上限 | 通知メールのピーク。サンドボックスの解除 |
| Lambda | 同時実行の上限（unfurl、アプリのイベントの配信、インタラクティブ用のプロビジョニング済み同時実行） |
| ECR・CloudWatch・AMP | API の呼び出しの上限、取り込むメトリクスの系列数 |

## 4. 余裕の方針

- **1 つの AZ を失っても足りること**を、すべての部品の前提にする。平常時の使用率を、各部品の上限の 2/3 以下に保つ（[infrastructure.md](infrastructure.md) の 3 節）。
- Gateway は、接続の上限の 60% を目標にする。残りの 40% のうち約 33% を AZ の障害に、残りを急増に充てる。
- DB の writer は、CPU 50% を上限とみなす。超える状態が続いたら、上のクラスへの変更を計画する（変更には短いフェイルオーバーを伴う）。

## 5. キャパシティの運用

| 活動 | 頻度 | 担当 |
| --- | --- | --- |
| 実際の負荷（投稿/秒、接続数、DB の CPU、Gateway のメモリ）と、1 節のモデルの比較 | 月次 | Ops |
| モデルの更新と、3 か月先の予測 | 四半期 | Ops、PM（利用者の増加の見込み） |
| 負荷試験（k6）：1 節のモデルの 1 倍・2 倍、AZ の喪失、再接続の殺到、巨大チャンネル | リリース前、四半期 | QA、Ops |
| パラメーターの見直し（遅いクエリ、VACUUM の状況、プールの待ち） | 月次 | Dev、Ops |
| 段階を上げる判断（[infrastructure.md](infrastructure.md) の 8 節） | 月次の比較の結果で | Ops、Dev |

負荷試験の結果は、この文書の数値と [infrastructure.md](infrastructure.md) の 4 節の台数に反映する。見積もりと 30% 以上ずれた項目は、原因を調べて記録する。

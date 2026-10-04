# Capacity: Linear

負荷のモデル、1 ワークスペースの書き込みの上限と割り当て、Sync Gateway の接続と配り（ファンアウト）、再接続とブートストラップの殺到、部品ごとの必要量、パラメーター、クォータ、負荷試験の計画、キャパシティの運用。台数の表は [infrastructure.md](infrastructure.md) の 5 節、段階を上げる基準は同じく 9 節にある。他の題材（Slack・Auth0 の capacity.md）の形と規則を引き継ぐ。

| 関連 | 決定 |
| --- | --- |
| [ADR-0002](../decisions/0002-sync-model.md)、[ADR-0006](../decisions/0006-transactions-writer-and-idempotency.md) | ワークスペースの行のロックで直列に書く |
| [ADR-0009](../decisions/0009-sync-gateway-protocol.md) | 再接続の待ち、`retry_after_ms` |
| [ADR-0013](../decisions/0013-sync-group-changes-retention-and-reset.md) | `epoch` のやり直しを 0〜10 分に散らす |
| [0054](../decisions/0054-per-workspace-write-admission.md) | 1 ワークスペースの書き込みを `origin` ごとの枠で割り当てる。`client` を最優先にし、`api`（1 秒 60 変更）・`notifier`（50）・`worker`（50）・`import`（100、自動で下げる）を Writer がロックの前に数え、超えたら `retry` を返す。ロックの待ちが伸びたら `client` 以外を半分にする |

**ここの数値はすべて初期見積もりである。** E2 の PoC（1 ワークスペースの書き込みの上限）と E12 の負荷試験（k6 と、同期のクライアントの模擬）で確かめ、結果で置き換える。

## 1. 負荷のモデル（S1）

| 項目 | 値 | 根拠・前提 |
| --- | --- | --- |
| ワークスペース | 5,000（有料 1,500） | [architecture/README.md](README.md) の 2 節 |
| 月間の利用者 | 10 万 | 同上 |
| **同時の接続のピーク** | **6 万** | 同上。1 つの端末は書き手のタブだけが接続する（ADR-0015）ので、接続 ≒ 端末 |
| **書き込みのピーク** | **1,500 変更/秒** | 同上。1 変更 ＝ `sync_actions` の 1 行 |
| 　トランザクション | 約 600 件/秒 | 1 トランザクションに平均 2.5 変更（派生・履歴を含む）と置く |
| 最大のワークスペース | メンバー 2,000、イシュー 50 万、モデル 500 万 | 同上 |
| 　その同時の接続 | 1,200 | メンバーの 6 割 |
| 　その書き込みのピーク | 100 変更/秒 | 1 ワークスペースの上限（300）の 3 分の 1 |
| 同期のログ（`sync_actions`） | 平均 800 万行/日、1 行 約 1.5 KB | README の 2 節。`update` は行の全体を運ぶ（ADR-0007） |
| ブートストラップ（平常） | 5 件/秒 | 新しい端末、やり直し、参加。平常の 1 日で接続の 1 割 |
| 遅延の読み込み | 200 件/秒 | コメント・履歴・本文を開く |
| 公開 API | 300 要求/秒 | ワークスペースの 1 割が API を使い、平均 1 分に 4 回 |
| Webhook の送り | 500 件/秒 | 変更の 3 分の 1 が Webhook の対象の型で、有効な Webhook のあるワークスペースに当たる |
| 検索 | 100 件/秒 | |
| 連携の事象（GitHub・Slack） | 50 件/秒 | |

## 2. 1 ワークスペースの書き込み

ADR-0054。

### 2.1 上限

- 1 ワークスペースの書き込みは、`workspace_sync` の行のロックで直列になる（ADR-0002・0006）。1 回の Writer の DB のトランザクションの中の時間（ロックの保持）が上限を決める。
- ロックの保持の見積もり：`SELECT … FOR UPDATE`（0.2ms）＋ 変更ごとの検証と適用（1 変更 約 1ms。モデルの行の更新、`sync_actions` の挿入、索引、派生の読み出し）＋ `tx_results`・`sync_outbox`（0.3ms）＋ コミット（Aurora の書き込みの確定、約 1〜2ms。**未検証**。E2 の前の `writer-throughput-poc` で測る）。
- 1 回の `submit` が平均 3 変更なら、1 回 約 5ms で 1 秒 200 回・600 変更。ロックの待ちと揺らぎを見て、**1 ワークスペース 1 秒 300 変更を上限**とする（README の 2 節の見込みと同じ）。E2 の PoC で確かめ、届かなければ楽観的な検証や group commit の ADR を書く（[sync-engine.md](sync-engine.md) の 14 節の持ち越し）。

### 2.2 割り当て

| `origin` | 枠（1 ワークスペース） | 優先 | 超えたとき |
| --- | --- | --- | --- |
| `client` | 数えない（1 接続 平均 50 トランザクション/秒の上限だけ。[sync-engine.md](sync-engine.md) の 4.3 節） | 1 | — |
| `api` | 1 秒 60 変更（瞬間 300） | 2 | `retry`（公開 API は 429。[api-and-webhooks.md](api-and-webhooks.md) の 4 節） |
| `notifier` | 1 秒 50 変更（瞬間 500） | 3 | `retry`。通知係は待って続ける。受け手ごとに 5 秒に 1 回のトランザクションにまとめる（[notifications-and-inbox.md](notifications-and-inbox.md) の 5.5 節） |
| `worker` | 1 秒 50 変更（瞬間 500） | 4 | `retry`。Worker は待って続ける |
| `import` | 1 秒 100 変更（自動で下げる。[import-export.md](import-export.md) の 5.1 節） | 5 | `retry` |

- Writer は、ロックを取る前に Valkey のトークンバケット（キー：`ws:<id>:wr:<origin>`）を数える。Valkey が落ちたら、タスクのメモリーの近似の数（タスクの数で割った値）で続ける。
- **混雑の制御**：Writer はワークスペースごとに、直近 10 秒のロックの待ちの p99 を持つ（Valkey に 1 秒ごとに書く）。50ms を超えたら、`client` 以外の枠を半分にし、10 秒ごとに見直す（落ち着いたら 1 割ずつ戻す）。
- `client` の書き込みだけで上限を超える場面（2,000 人の一斉の操作）は、ロックの待ちの時間切れ（`lock_timeout = 2s`）で `retry` になり、クライアントは outbox に貯めて送り直す（ADR-0005）。利用者の画面は手元で進む。

### 2.3 既存の決定との食い違い（解消済み）

- [ADR-0023](../decisions/0023-workflow-states-and-lifecycle-automation.md) の自動で閉じる・アーカイブの Worker は、当初「500 件ずつ、1 ワークスペースに 100ms に 1 回まで」で、最大 1 秒 5,000 変更になり、上の `worker` の枠（50）と 1 ワークスペースの上限（300）を超えていた。**統合の工程（2026-09-28）で ADR-0023 を枠に従う形に直した**（100 件ずつ、`worker` の枠、開始の時刻を 03:00〜05:00 に散らし、1 つのクラスタで同時に 20 ワークスペースまで。ADR-0023 の注記）。夜間のクラスタの全体の書き込みは 1 秒 1,000 変更（20 × 50）以下で、平常のピーク（1,500）に重ならない。
- 通知係の書き込みは、当初 `origin = worker` で、自動の処理と同じ `worker` の枠（50）を取り合っていた。大きなワークスペースで繰り越しや自動で閉じるが枠を使い切ると、通知が遅れる。**統合の工程（2026-09-28）で `notifier` の枠（1 秒 50 変更、瞬間 500）に分けた**（ADR-0054 の注記）。インボックスの行は安く、受け手のグループ（`user:<id>`）にだけ届くので、通知係は受け手ごとに 5 秒に 1 回のトランザクションにまとめ、ロックを取る回数を減らす（[notifications-and-inbox.md](notifications-and-inbox.md) の 5.5 節）。1 ワークスペースの `client` 以外の枠の和は 1 秒 260 変更（60 ＋ 50 ＋ 50 ＋ 100）で、混雑の制御で半分になる。

## 3. Sync Gateway

### 3.1 接続

| 項目 | 見積もり |
| --- | --- |
| 1 接続のメモリー | 約 60 KB（WebSocket の受け・送りの緩衝、接続の状態、`groups`）＋ permessage-deflate の圧縮の文脈 約 16 KB（窓 4 KiB。[sync-engine.md](sync-engine.md) の 9.1 節）≒ 76 KB。送信の待ちは 1 接続 4 MiB まで（同 9.6 節）だが、平常は空。3,000 接続で 約 230 MB |
| 1 タスクの接続の目標 | 3,000（上限 5,000 の 60%） |
| 1 タスクの大きさ | 2 vCPU / 4 GB |
| ピークのタスク | 6 万 ÷ 3,000 ＝ 20。1 AZ を失っても 2/3 で足りるよう、最小 12（AZ ごとに 4）、最大 60 |

- スケールの指標はタスクあたりの接続の数（カスタムのメトリクス）。CPU は上限として併用する（Slack の infrastructure.md の 3 節と同じ）。
- 縮めるときは、1 タスクの接続を `kick: server_shutdown` と `retry_after_ms`（0〜60 秒の乱数）で 10 分かけて逃がす（[delivery.md](delivery.md) の 5 節）。

### 3.2 配り

- 1 変更あたりの送り先の数：ワークスペースのオンラインの接続のうち、行のグループを購読するもの。最大のワークスペースで 1,200、平均で 12。
- 送信のピーク：`Σ(ワークスペースの変更/秒 × 送り先)`。最大のワークスペースだけで 100 × 1,200 ＝ 12 万回/秒。全体で約 30 万回/秒と置く。
- 1 回の `deltas` の JSON を、**同じ `groups` の接続の間で使い回す**（接続ごとに作らない）。同じワークスペースの接続の `groups` の組は、チームの構成で数十に収まる。直列化の CPU は、組の数 × 変更の数に比例する。
- permessage-deflate（文脈の持ち越しあり）の圧縮は接続ごとに走るので、圧縮の CPU は送信の回数（30 万回/秒）に比例する。1 回 1.5 KB の圧縮を数十 µs と見ると、全体で数 vCPU 分（**未検証**。E12 の `cost-baseline` で測る）。E12 の L1 で、文脈の持ち越しなし（圧縮したフレームも同じ `groups` の接続で使い回せる）と比べる（[ADR-0009](../decisions/0009-sync-gateway-protocol.md) の注記）。
- Gateway は、Valkey から受けた範囲を 20ms か 64 KiB でまとめて 1 つの `deltas` にしてよい（伝播の予算の「Relay → Valkey → Gateway 50ms」の中。[sync-engine.md](sync-engine.md) の 7.6 節）。
- 1 タスクの送信の上限を 1 秒 3 万回と置く（**未検証**。E12 の `load-tests-l1-l9` の L1 で測る）。30 万回/秒 ÷ 3 万 ＝ 10 タスクで、接続の数で決まる 20 タスクの中に収まる。

### 3.3 再接続の殺到

| 場面 | 発生 | 抑え方 | 瞬間の負荷 |
| --- | --- | --- | --- |
| Gateway の 1 タスクの喪失 | 3,000 接続が同時に切れる | 最初の再接続を 0〜5 秒の一様な乱数（[sync-engine.md](sync-engine.md) の 9.6 節） | 600 接続/秒 |
| 1 AZ の喪失 | 2 万接続 | 同上 | 4,000 接続/秒 |
| 全 Gateway の喪失（Valkey・ALB の障害） | 6 万接続 | 同上、その後は指数の待ち | 1.2 万接続/秒 |
| デプロイ | 全接続 | 1 タスクずつ 10 分かけて逃がす（3.1 節） | 100 接続/秒 |

- 1 回の再接続のサーバーの仕事：チケットの発行（Valkey のセッションの写しと `User` の読み出し）、`hello` の処理（Valkey の GETDEL、`workspace_sync` と `sync_subscriptions` の読み出し）、取り戻し（`catch_up`。平均 数十変更）。reader に 3〜4 回の読み出し。
- 1.2 万接続/秒のとき、reader に 5 万回/秒の軽い読み出し。reader 2 台で受けられる見込み（**未検証**。E12 の `load-tests-l1-l9` の L4）。足りなければ、Gateway の受け付けの上限（1 タスク 1 秒 300 の `hello`、超えたら `kick: overloaded` と `retry_after_ms`）で散らす。

## 4. ブートストラップ

### 4.1 1 回の重さ

| 種類 | 行 | 圧縮した大きさ | Sync API の時間 | reader の読み出し |
| --- | --- | --- | --- | --- |
| 全体（モデル 5 万件以下） | 〜5 万 | 〜6 MB | 3〜5 秒 | 3 チャンク × 最大 10 秒 |
| 部分（最大のワークスペース） | 約 15 万 | 約 20 MB | 10〜20 秒 | 8 チャンク |
| グループの参加（1 チーム） | 〜2 万 | 〜3 MB | 2 秒 | 1 チャンク |

（大きさは [bootstrap-and-partial-sync.md](bootstrap-and-partial-sync.md) の 4.7 節の見積もり。E3 で測る）

### 4.2 殺到

| 場面 | 件数 | 散らし方 | 同時のブートストラップ |
| --- | --- | --- | --- |
| DR の後の `sync_epoch` の引き上げ（全ワークスペース） | 6 万（オンラインの全端末）＋ 後から戻る端末 | `retry_after_ms` で 0〜10 分（ADR-0013） | 平均 100 件/秒 × 10 秒 ＝ 1,000 |
| 1 つのワークスペースの PITR での戻し | 1,200（最大） | 同じ散らし | 20 件/秒 |
| 非公開 → 公開の切り替え（最大のワークスペース） | 2,000 人のグループの参加 | 0〜30 秒の乱数（ADR-0013） | 67 件/秒 × 2 秒 ＝ 130 |
| デプロイ | 0 | サーバーのバージョンの更新でやり直しを起こさない（ADR-0003） | — |

- DR の引き上げの 1,000 の同時は、Sync API のタスク（1 タスク 20 の同時。[bootstrap-and-partial-sync.md](bootstrap-and-partial-sync.md) の 4.7 節）で 50 タスク、reader の読み出しで 1 秒 約 200 万行になる。平常の構成（Sync API 6 タスク、reader 2 台）を大きく超える。
- そこで、DR の手順（[runbooks/disaster-recovery.md](../runbooks/disaster-recovery.md)）で次を行う。
  1. 引き上げの前に、大阪の Sync API を 60 タスク、reader を 5 台に広げる（Aurora の reader の追加は 10〜15 分の見込み。**未検証**。E12 の `dr-drill` で測る）。
  2. 散らしの幅を、Ops のフラグ `ops.epoch_reset_spread_min` で 10 分から 30 分まで伸ばせるようにする。既定は ADR-0013 の 10 分。30 分にすると同時は約 330。
- 散らしている間、クライアントは古い手元のデータを読み取りの専用で示し、書き込みは outbox に入る（ADR-0013）。利用者の作業は止まらない。

## 5. 部品ごとの必要量

### 5.1 Aurora

| 項目 | 見積もり |
| --- | --- |
| 書き込みの行 | ピーク 1,500 変更/秒 × （モデルの行 1 ＋ `sync_actions` 1 ＋ 派生の平均 0.5）＋ トランザクション 600 × （`tx_results` 1 ＋ `sync_outbox` 1 ＋ 監査 0.05）≒ 5,000 行/秒 |
| writer | `db.r8g.4xlarge`（16 vCPU、128 GiB）。CPU 50% 以下を目標 |
| reader | 同型 × 2。ブートストラップ・取り戻し・遅延の読み込み・公開 API・書き出し・Gateway の欠けの埋め |
| `sync_actions` の量 | 800 万行/日 × 1.5 KB ≒ 12 GB/日。30 日で 360 GB。索引（主キーと `(workspace_id, model, model_id, sync_id)`）で ＋150 GB |
| モデルの表 | モデル合計 S1 で 約 3 億行 × 1 KB ≒ 300 GB と索引 |
| 合計のストレージ | 約 1.2 TB（`tx_results` 90 日、監査、履歴、本文の状態を含む） |

- 接続の数：ECS のタスクの数 × プール。RDS Proxy は使わない（`SET LOCAL` のワークスペースのコンテキストで接続が固定されるため。Slack・Auth0 の題材と同じ）。writer への接続の上限の見込みは、Writer 12 タスク × 20、Relay 4 × 5、Worker 30 × 5、Public API 6 × 10 ≒ 500。
- パラメーター：`lock_timeout = 2s`（Writer のセッション）、`statement_timeout` は経路ごと（Writer 5 秒、Sync API のチャンク 12 秒、公開 API 10 秒）、`idle_in_transaction_session_timeout = 10s`。

### 5.2 Valkey

| 用途 | 量 |
| --- | --- |
| 差分の pub/sub（`sync:<workspace_id>`） | Relay のメッセージ 600 件/秒 × 平均 4 KB ≒ 2.4 MB/秒。購読する Gateway のタスクの数だけ複製される（最大 20 倍 ≒ 50 MB/秒） |
| チケット、セッションの写し、取り消しの知らせ | 数万のキー |
| レート制限、書き込みの枠 | 数十万のキー（主体、ワークスペース） |

- S1 は `cache.r7g.large` のクラスタモード 3 シャード × （プライマリ 1＋レプリカ 1）。pub/sub は、クラスタモードの普通の `PUBLISH` が全ノードに流れる性質があるので、S2 で sharded pub/sub にする（[sync-engine.md](sync-engine.md) の 7.3 節）。
- 失ってよい（Gateway は reader から欠けを埋める）。

### 5.3 OpenSearch

| 項目 | 見積もり |
| --- | --- |
| 文書 | イシュー・プロジェクト・コメントで約 2 億（S1 の終わり） |
| 大きさ | 1 文書 約 2 KB（N-gram の索引で膨らむ）→ 約 400 GB、レプリカ 1 で 800 GB |
| 構成 | データノード 3（3 AZ）、専用のマスター 3。インスタンスの型は E8 の前の `search-poc` で決める |

### 5.4 SQS と Worker

| キュー | ピーク | Worker |
| --- | --- | --- |
| 通知（notifier） | 1,500 変更/秒のうち通知の対象 約 1/3 | notifier 4〜12 |
| `search-index` | 変更の約 1/2 | 索引 3〜10 |
| `webhook-fanout`・`webhook-send` | 500 件/秒 | 振り分け 2〜6、送り係（egress）4〜20 |
| `integrations`（FIFO） | 50 件/秒 | 2〜6。FIFO のキューの上限（高スループットでない形で、分割ごとに API の操作ごと 1 秒 300 回、10 件の束で 3,000 件。[Amazon SQS message quotas](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/quotas-messages.html)、2026-09-28 に確認）の中 |
| `import` | ジョブ 3（クラスタごと） | 1〜3 |

- スケールの指標は、キューの最も古いメッセージの年齢（他の題材と同じ）。

## 6. パラメーター

| 対象 | 値 |
| --- | --- |
| ALB のアイドルの時間切れ | 120 秒（Gateway の ping 20 秒より十分長く。[infrastructure.md](infrastructure.md) の 2 節） |
| Gateway の `hello` の受け付け | 1 タスク 1 秒 300 |
| Sync API の同時のブートストラップ | 1 タスク 20（[bootstrap-and-partial-sync.md](bootstrap-and-partial-sync.md) の 4.7 節） |
| Node.js | タスクの vCPU ごとに 1 プロセス。`--max-old-space-size` はタスクのメモリーの 75% |
| オートスケール | 目標の追従。Gateway は接続の数（3,000）、Writer は CPU 50%、Sync API は同時のブートストラップの数（目標 12） |

### 6.1 クォータ（着手前に確かめ、必要なら引き上げを申請する）

| 対象 | 確かめること |
| --- | --- |
| Fargate の vCPU | Gateway 60 × 2 ＋ Sync API 60 × 2（DR の時）＋ その他、デプロイの二重分。大阪でも同じ値 |
| ALB の LCU、同時接続 | WebSocket 6 万の長い接続と、再接続の 1.2 万/秒 |
| CloudFront の WebSocket | 同時の接続の数の上限は文書にない。配信ごとに 1 秒 25 万の要求と 150 Gbps（引き上げの申請ができる）。WebSocket はオリジンからの送信が 10 分ないと切れる（Gateway の ping のフレームは 20 秒ごとなので当たらない）（[CloudFront quotas](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html)、2026-09-28 に確認）。新しい接続の速さは、再接続の殺到（1.2 万/秒）が 1 秒 25 万の中に収まる |
| NAT の同時接続 | Webhook の送り、連携、インポート |
| Aurora の reader の数 | 1 クラスタ 15 まで（[Replication with Amazon Aurora PostgreSQL](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/AuroraPostgreSQL.Replication.html)、2026-09-28 に確認） |

## 7. 余裕の方針

- **1 つの AZ を失っても足りる**。平常の使用率を上限の 2/3 以下に保つ。
- **大阪へ切り替えても足りる**。大阪のオートスケールの上限とクォータを東京と同じにする。切り替えの直後の `epoch` のやり直しは 4.2 節の手順で散らす。
- 過負荷の時の優先の順：**手元の操作（サーバーに頼らない）** ＞ 送信の受け付け（`client`）と差分の配信 ＞ 取り戻し ＞ ブートストラップ ＞ 公開 API ＞ Worker ＞ インポート。サーバーが落ちても、クライアントは手元で読み書きを続ける（NFR-006）。

## 8. 負荷試験の計画（E12）

staging を本番と同じ台数に広げて行う。道具は k6（HTTP）と、自前の同期のクライアントの模擬（`packages/sync-client` をヘッドレスで動かし、WebSocket・outbox・差分の適用を行う。IndexedDB はメモリーに差し替える）。データは生成したワークスペース 5,000（最大 2,000 人・イシュー 50 万を 3 つ）。

| # | シナリオ | 負荷 | 合格の条件 |
| --- | --- | --- | --- |
| L1 | 平常のピーク | 1 節のモデルの 100% を 1 時間、接続 6 万 | NFR-002（送信から ack p99 300ms、伝播 p99 1 秒）、エラー 0.01% 未満、writer の CPU 50% 以下 |
| L2 | ピークの 2 倍 | 200% を 30 分 | p99 は NFR の 1.5 倍以内、`retry` の率 1% 未満 |
| L3 | 1 ワークスペースの上限 | 最大のワークスペースに 1 秒 300 変更、接続 2,000 | ロックの待ちの p99 50ms 以下、送信から ack p99 300ms（[sync-engine.md](sync-engine.md) の 12.3 節）。上限を超える 400 変更/秒で、`client` 以外が絞られ `client` の p99 が守られる |
| L4 | 再接続の殺到 | Gateway の全タスクを落とし、6 万接続が再接続 | 60 秒以内に 95% が再接続、reader の CPU 80% 以下、`overloaded` の後に全員が戻る |
| L5 | `epoch` のやり直し | 全ワークスペースの `sync_epoch` を上げる（4.2 節の手順で広げた構成） | 散らしの幅の中に全端末が終わる、Sync API の `429` の後に全員が戻る、NFR-003 の対象外（やり直し）だが、1 件の部分のブートストラップが p95 20 秒以内 |
| L6 | インポートと利用の同居 | 最大のワークスペースで 1 万件のインポートと、平常の利用 | 利用者の送信から ack p99 300ms、インポートが 30 分以内（K8） |
| L7 | Aurora の writer のフェイルオーバー | L1 の中で手動のフェイルオーバー | 書き込みの停止が 60 秒以内、outbox からの送り直しで失われた変更 0、重複 0 |
| L8 | 7 日のオフラインの一斉の送信 | 1,000 端末が 1 日 2,000 トランザクション × 7 日分を同時に送る | 全件が 1 回ずつ確定（K4）、他の利用者の p99 が NFR-002 の 1.5 倍以内 |
| L9 | Webhook の送りの溢れ | 1 つの Webhook の受け手を 5 秒の時間切れにし、1 秒 1,000 件を流す | 他の Webhook の最初の送信の p95 30 秒（NFR-009） |

- 結果で、この文書の数値と [infrastructure.md](infrastructure.md) の 5 節の台数を置き換える。

## 9. キャパシティの運用

| 活動 | 頻度 | 担当 |
| --- | --- | --- |
| 実際の負荷（接続、変更/秒、ワークスペースごとの上位、ロックの待ち、Gateway の送信、ブートストラップ、reader の CPU）と 1 節のモデルの比較 | 月次 | Ops |
| 1 ワークスペースの書き込みの上位 10 と、上限の 50% を超えたワークスペースの一覧 | 週次 | Ops |
| モデルの更新と 3 か月先の予測。大口の契約、大きなインポートの予定を反映 | 四半期 | Ops、PM |
| 負荷試験（L1・L3・L4） | 半年ごとと、同期エンジンの大きな変更の後 | Ops、QA |

## 10. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E2 | `writer-admission-buckets` | 2.2 節の枠と混雑の制御（ADR-0054） |
| E2 | `writer-throughput-poc` | 2.1 節の上限の計測（1 秒 300 変更） |
| E2 | `gateway-shared-serialization` | 3.2 節の同じ `groups` の間の使い回し |
| E3 | `gateway-hello-admission` | 3.3 節の受け付けの上限 |
| E12 | `sync-load-client` | 8 節の同期のクライアントの模擬 |
| E12 | `load-tests-l1-l9` | 8 節の負荷試験 |
| E12 | `epoch-reset-spread-flag` | 4.2 節の `ops.epoch_reset_spread_min` |

## 11. 未解決の問い

### 決定

2026-09-28 の既定案。E2 の PoC と E12 で覆りうる。

- **1 ワークスペースの上限**：1 秒 300 変更（README の見込みと同じ）。
- **割り当て**：`origin` ごとの枠と、ロックの待ちでの `client` 以外の絞り（ADR-0054）。
- **Gateway**：1 タスク 3,000 接続、最小 12。
- **DR の後の殺到**：構成を広げてから引き上げ、散らしの幅をフラグで 30 分まで伸ばせる。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| Aurora のコミットの時間と、1 変更の検証と適用の時間 | E2 の前の `writer-throughput-poc` |
| Gateway の 1 タスクの送信の上限、1 接続のメモリー、permessage-deflate の CPU と圧縮の率 | E12 の L1・L4 |
| reader が再接続の殺到の読み出しを受けられるか | E12 の L4 |

## 12. quality.md・runbooks・data-model への項目

### quality.md

- L1〜L9 を E12 の GA の判定の基準にする。
- 本番：ワークスペースごとのロックの待ちの p99、枠で `retry` にした数（`origin` ごと）、混雑の制御が効いた回数。

### runbooks

- `writer-lock-contention.md`（sync-engine の領域の依頼と同じ）：枠の手動の引き下げ（Ops のフラグ `ops.write_budget.<origin>`）を手順に入れる。
- `reconnect-storm.md`：Gateway の受け付けの上限の引き下げと、`retry_after_ms` の引き上げ。
- `epoch-reset-capacity.md`：DR の手順の中の構成の広げ方（[runbooks/disaster-recovery.md](../runbooks/disaster-recovery.md) に含めた）。

### data-model（索引への追加の提案）

| 置き場所 | 中身 | 節 |
| --- | --- | --- |
| Valkey `ws:<id>:wr:<origin>` | 書き込みの枠のトークンバケット | 2.2 |
| Valkey `ws:<id>:lockwait` | ロックの待ちの p99（1 秒ごと） | 2.2 |

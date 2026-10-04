# Capacity: GitHub

負荷のモデル、部品ごとの必要量、パラメーターの設定、クォータ。台数の表は [infrastructure.md](infrastructure.md) の 4 節、段階を上げる判断の基準は同じく 8 節にある。

**ここの数値はすべて初期見積もりである。** E3（Git）・E8（Actions）・E9 の負荷試験で確かめ、結果で置き換える。AWS や Git の仕様で確かめていないものは「未検証」と書く。

## 1. 負荷のモデル（S1）

| 項目 | 値 | 根拠・前提 |
| --- | --- | --- |
| リポジトリ | 100 万 | architecture の「規模の段階」 |
| 1 日の利用者 | 10 万 | 同上 |
| **Git の要求のピーク** | **2,000 件/秒** | 同上。HTTPS と SSH の合計 |
| 　うち ref の確認だけで終わる fetch（変更なし） | 1,300 件/秒 | 外部の CI・ツールの定期の確認が多い |
| 　うち差分のある fetch | 550 件/秒 | 平均 200 KB |
| 　うち clone（完全） | 50 件/秒 | 平均 30 MB（圧縮後） |
| 　うち push | 40 件/秒 | 平均 50 KB。大半は数コミット |
| 　うち LFS の API | 60 件/秒 | 本体の転送は S3 の署名付き URL |
| clone・fetch の外向きの帯域（ピーク） | 約 12 Gbps | 50 × 30 MB ＋ 550 × 200 KB ≒ 1.6 GB/秒 |
| Actions の中からの clone | 上とは別に 1,800 件/分（ピーク） | ジョブの開始ごとに 1 回。PrivateLink 経由（[infrastructure.md](infrastructure.md) の 2.2 節） |
| Web・API のリクエスト | 5,000 件/秒（ピーク） | うち API が 60%（エージェントと CI からの利用が多い） |
| ストレージの読み取りの RPC | 4,000 件/秒（ピーク） | ファイル・ツリー・blame・コミットの一覧。Web・API から |
| Pull Request の画面の表示 | 200 件/秒（ピーク） | |
| 差分の計算 | 60 件/秒 | 画面の表示の 30%（差分のキャッシュの外れ） |
| マージ可能かの再計算（`merge-tree`） | 200 件/秒（ピーク） | ベースのブランチへの push ごとに、開いている PR を再計算する。1 回の push で最大 100 件に抑え、残りは表示のときに計算する（[pull-requests.md](pull-requests.md)） |
| Webhook の配信 | 500 件/秒（ピーク） | push・PR・Issue の Event × 購読の数 |
| **Actions のジョブの開始** | **300 件/分（ピーク）** | 平均の実行時間 6 分 → 同時に 1,800 ジョブ |
| 保存の論理量（Git） | 30 TB | 1 リポジトリ平均 30 MB（repack 後、fork の共有を含む） |
| 保存の増加 | 月 5% | |
| LFS | 20 TB | |

## 2. 部品ごとの必要量

### 2.1 ストレージの容量

| 項目 | 値 |
| --- | --- |
| 論理量 × 3 複製 | 90 TB |
| 充填率の上限 | 60%（repack の一時領域、修復の受け入れ、6 か月の増加） |
| 必要な NVMe | 150 TB |
| `i8g.4xlarge`（3,750 GB）の台数 | 40 → AZ ごとに同数にして 42 |

- **充填率 60% の根拠。** repack は、新しいパックを書き終えてから古いものを消すので、最大のリポジトリの大きさぶんの一時領域が要る。1 台を失ったとき、同じ AZ の残りのノード（13 台）がその台の複製（約 2.2 TB）を受け入れる。60% なら、受け入れた後も 65% 程度に収まる。
- 1 台あたりのリポジトリの数は約 7 万（100 万 × 3 ÷ 42）。1 台に 1 つの大きなリポジトリが偏らないよう、配置は容量と負荷の両方で決める（[git-storage.md](git-storage.md)）。

### 2.2 ストレージの CPU と I/O

| 処理 | ピークの件数 | 1 件の CPU（見込み） | 必要な vCPU |
| --- | --- | --- | --- |
| ref の確認（`ls-refs`） | 1,300/秒 | 5 ms | 7 |
| 差分のある fetch（パックの生成） | 550/秒 | 100 ms | 55 |
| clone（ビットマップと既存のパックの再利用） | 50/秒 | 500 ms | 25 |
| push（`index-pack`、接続性の検査、3 か所） | 40/秒 × 3 | 200 ms | 24 |
| 読み取りの RPC | 4,000/秒 | 5 ms | 20 |
| 差分・`merge-tree` | 260/秒 | 100 ms | 26 |
| 保守（repack、commit-graph） | 常時 | — | 150（全体の 20% を上限に割り当てる） |
| **合計** | | | **約 310** |

- 全体は 42 × 16 ＝ 672 vCPU。ピークで約 45%。S1 のストレージは、CPU ではなく容量で台数が決まる。
- **偏りのほうが問題になる。** 人気のリポジトリへの clone の集中は、そのリポジトリの複製を持つ 3 台だけに負荷を集める。パックの生成の結果をキャッシュし（`uploadpack.packObjectsHook`。3.1 節）、3 つの複製に読み取りを分ける。それでも 1 台の CPU が 80% を超え続けたら、そのリポジトリに読み取り専用の追加の複製（4 つ目以降）を作る（[git-storage.md](git-storage.md)）。
- メモリ（128 GiB）の大半を、ページキャッシュとして Git のパックに使う。よく読まれるパックがメモリに載ることが、fetch の開始の速さ（NFR-003）に効く。
- ローカル NVMe の IOPS（`i8g.4xlarge` で読み 600,000 / 書き 330,000。[AWS の仕様](https://docs.aws.amazon.com/ec2/latest/instancetypes/so.html)）は、上の負荷に対して十分に大きい。

### 2.3 Git フロントエンドと帯域

- 外向きの帯域のピーク 12 Gbps は、ストレージ → フロントエンド → クライアントと 2 回流れる（ADR-0004）。フロントエンドは、同じ AZ の複製を優先して AZ 間の転送を抑える。
- フロントエンドの 1 タスク（2 vCPU）で、SSH の暗号を含めて 1 Gbps を上限とみなす（**未検証**。実装とインスタンスに依存し、文書では確かめられない。E3 の `git-load-tests` で測る）。12 Gbps ÷ 使用率 2/3 ＝ 18 タスク。
- 同時接続：clone は平均 30 秒、fetch は平均 1 秒とすると、ピークの同時接続は約 2,500。1 タスク 500 を上限とし、接続数でもスケールさせる。
- ストレージのノードの帯域（`i8g.4xlarge` は基準 9.375 Gbps・最大 25 Gbps。[AWS の仕様](https://docs.aws.amazon.com/ec2/latest/instancetypes/so.html)）は、平常時には余る。修復（2.8 節）と clone の集中が重なるときに効く。

### 2.4 push と複製

- 40 件/秒の push は、それぞれ 3 つの複製への書き込みと、ref の更新の合意を伴う。合意は、リポジトリごとに直列になる（[git-storage.md](git-storage.md)）。
- **1 つのリポジトリへの push の集中**（モノレポ、merge queue）を上限として見る。1 リポジトリで 1 秒に 5 件の ref の更新を目標にし、超えたら待たせる。merge queue は、まとめて 1 回の更新にする（[pull-requests.md](pull-requests.md)）。
- push の成功までの時間の目安：受信 ＋ `index-pack` ＋ 最も遅い 2 つ目の複製への書き込み ＋ 合意。AZ 間の往復は 1〜2 ms なので、小さな push では 300 ms 以内を目標にする。

### 2.5 Pull Request と差分

- 差分の計算の結果（ファイルごとの差分、統計）を、ベースとヘッドのコミットの組をキーにして S3 と Valkey にキャッシュする。コミットは不変なので、キャッシュを消す必要がない。
- 1,000 行までの差分（NFR-004）の計算は 100 ms 以内を目標にする。大きな差分は、ファイルごとに遅延して読み込む。

### 2.6 Aurora

| 利用者 | タスクあたりのプール | S1 の最大タスク数 | 最大の接続数 |
| --- | --- | --- | --- |
| Web・API | 15 | 40 | 600 |
| Worker | 5 | 60 | 300 |
| Git フロントエンド（ルーティング・権限。キャッシュが外れたとき） | 5 | 40 | 200 |
| ストレージの制御（配置、修復の管理） | 5 | 3 | 15 |
| migrator、運用 | — | — | 20 |
| **合計** | | | **約 1,140** |

- Slack と同じく、オートスケールの上限での合計を `max_connections` の 50% 以下に保つ。`db.r8g.4xlarge` では既定の上限 5,000 に達する（[AWS のドキュメント](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/AuroraPostgreSQL.Managing.html#AuroraPostgreSQL.Managing.MaxConnections)）。
- GitHub は RLS を使わないので（ADR-0002）、`SET` による接続の固定がなく、RDS Proxy を使える。S1 では使わず、接続数が規則を超えそうになったら導入を検討する。
- 書き込みの主なもの：push の Event による ref の写しの更新（40 件/秒 × 数行）、PR・Issue・コメント、Webhook の配信の記録。合計で 2,000 行/秒程度と見込む。

### 2.7 SQS と Worker

| キュー | ピークの流量 | Worker の処理時間 p99 | 最小 / 最大タスク |
| --- | --- | --- | --- |
| push-events（ref の写し、PR の更新、下流への振り分け） | 40 件/秒 | 200 ms | 2 / 6 |
| mergeability（`merge-tree` の RPC） | 200 件/秒 | 1 秒 | 4 / 12 |
| webhook-delivery | 500 件/秒 | 外部の応答（最大 10 秒） | 振り分けは ECS、送信は Lambda |
| notifications | 300 件/秒 | 100 ms | 2 / 6 |
| search-index | 100 件/秒（コードは既定のブランチへの push のみ） | 2 秒 | 2 / 10 |
| backup（5 分でまとめる） | 40 件/秒 → まとめて 10 件/秒 | 5 秒 | 2 / 8 |
| repair（複製の修復） | 平常 0。ノードの喪失時に 7 万件 | 1 リポジトリ平均 30 秒 | ストレージの制御が並列度を決める（2.8 節） |
| actions-jobs | 300 件/分 | 1 秒 | [actions.md](actions.md) |

### 2.8 修復と復元の速さ

**ノードを 1 台失ったとき（AZ の中の修復）。**

- 失った複製は約 7 万リポジトリ、約 2.2 TB。同じ AZ の残り 13 台が、他の AZ の複製から Git のプロトコルで受け取る。
- 修復の帯域は、1 台あたり受け取り 2 Gbps に抑える（利用者の clone を圧迫しないため）。13 台で 26 Gbps、理論上は約 12 分。リポジトリごとの手続きの費用を含めて、**2 時間以内**を目標にする。
- 修復の間、そのリポジトリの複製は 2 つで、書き込みは続く。ただし、もう 1 台（別の AZ で同じリポジトリを持つノード）を失うと、そのリポジトリは書き込みが止まる。修復は、書き込みの多いリポジトリから先に行う。

**リージョンの喪失（大阪での復元）。**

- バックアップのバンドルからの復元は、`index-pack` の CPU で律速する。1 vCPU あたり 30 MB/秒（**未検証**。リポジトリの形に依存し、文書では確かめられない。E9 の大阪への復元の訓練で測る）とすると、42 台 × 16 vCPU で約 20 GB/秒だが、S3 からの取得、リポジトリごとの手続き、3 つの複製の作成を含めると、その 1/10 程度と見る。
- 直近 7 日に使われたリポジトリ（約 6 TB）を 1 つの複製で戻すのに約 1〜2 時間、全体（30 TB）を 3 つの複製にそろえるのに 12〜24 時間と見込む。これが S1 の RTO の範囲の根拠である（[infrastructure.md](infrastructure.md) の 5.2 節、ADR-0032）。
- 訓練（[runbooks/disaster-recovery.md](../runbooks/disaster-recovery.md)）で計測し、ここを置き換える。

### 2.9 Actions の実行環境

| 項目 | 値 |
| --- | --- |
| 同時に実行するジョブ（ピーク） | 1,800 |
| 標準の実行環境 | 2 vCPU、8 GiB、ディスク 14 GB |
| 1 ホスト（`m7i.metal-48xl`、192 vCPU・物理 96 コア、768 GiB）あたり | 約 40（SMT を無効にするので物理 96 コア。2 vCPU の VM に物理コアを 2 つ割り当てて最大 48、ホストの予備を引く。ADR-0023） |
| ピークのホスト | 45 ＋ 待機 9（20%）＝ 54 |
| 平常のホスト | 14〜18（平均の同時実行 560〜720 ジョブ） |
| 待機中の microVM | ジョブの開始のピーク（5 件/秒）× 起動の時間 の 2 倍を常に用意する |

- ジョブの開始 p95 60 秒（NFR-007）は、待機中の microVM があれば数秒で満たせる。効くのは、ホストの追加の遅さである。AWS は「RunInstances から起動の開始まで通常 10 分未満」とだけ書き、metal に固有の起動の時間は公開していない（[Amazon EC2 FAQs](https://aws.amazon.com/ec2/faqs/)、2026-09-26 に確認）。数分〜10 分とみなし、E8 の `firecracker-host-poc` で測る（**未検証**）。待機のホストを 20% 持ち、キューの伸びで先回りして増やす。
- 実行環境の型が [actions.md](actions.md) で変われば、ここを置き換える。
- 以前の見積もり（1 ホスト約 90）は SMT を有効にした 192 vCPU を前提にしていた。ADR-0023 で SMT を無効にするので、約 40 に直した（2026-09-26）。台数が 2 倍強になり、Actions の費用は本番の最大の項目になる（[infrastructure.md](infrastructure.md) の 9 節）。

## 3. パラメーターの設定

すべて Terraform か、ストレージのサービスの設定（リポジトリでバージョンを管理する）で持つ。変えた理由をコメントに残す。

### 3.1 Git（ストレージのノードの全体の設定）

| 設定 | 値 | 理由 |
| --- | --- | --- |
| `core.fsync` | `objects,reference,pack-metadata` | push の成功を返す前に、オブジェクト・パック・ref をディスクへ確実に書く。NFR-002 の前提。多くの環境の既定は `committed,-loose-object` で、ref は含まれない。`committed` も今はオブジェクトだけを指す |
| `core.fsyncMethod` | `fsync` | |
| `gc.auto` | `0` | 自動の gc を止める。保守は、ストレージの制御が負荷を見て行う |
| `receive.fsckObjects` | `true` | 壊れた・悪意のあるオブジェクトを受け取らない（[security.md](security.md)） |
| `receive.maxInputSize` | 2 GB | 1 回の push の上限（[git-protocols.md](git-protocols.md) と合わせる） |
| `receive.keepAlive`・`uploadpack.keepAlive` | 5 秒（既定） | 無音の間に keepalive を送り、CloudFront・NLB で切れないようにする |
| `uploadpack.allowFilter` | `true` | 部分的な clone（`--filter=blob:none`）を受け付け、CI の clone を軽くする |
| `uploadpack.packObjectsHook` | パックの生成のキャッシュ（ストレージのサービスの一部） | 同じ要求（人気のリポジトリの clone）を 1 回の生成で済ませる。この設定は、保護された設定（システム・グローバル・コマンドライン）からしか読まれない |
| `repack.writeBitmaps`、`pack.writeBitmapHashCache` | `true` | clone のパックの生成を速くする |
| `pack.threads` | 4 | 1 つの処理が CPU を占有しない |
| `pack.windowMemory` | 256 MB | 大きなリポジトリの repack でメモリを使い切らない |
| `core.bigFileThreshold` | 50 MB（既定より小さくする） | 大きなファイルを差分の圧縮から外し、メモリを抑える。LFS を勧める |

- 設定の名前と意味は [git-config](https://git-scm.com/docs/git-config) による。`core.fsync` の値（`objects` は `loose-object` と `pack`、`committed` は `objects` と `reference` の集まり。`-` で除く）と `core.fsyncMethod`（`fsync`・`writeout-only`・`batch`。`batch` は今は loose objects にだけ効く）の意味は、2026-09-26 に確かめた。書き込みの性能への影響は、文書では確かめられないので **未検証** とし、E3 の `git-load-tests` で計測する。
- 保守は `git repack --geometric` と multi-pack-index を基本にし、全体の repack を避ける。詳細は [git-storage.md](git-storage.md)。

### 3.2 ストレージのサービス

| 設定 | 値 | 理由 |
| --- | --- | --- |
| 1 ノードの同時の Git の子プロセス | 64 | 16 vCPU の 4 倍。超えたら待たせ、待ちが 5 秒を超えたら 503（再試行を促す） |
| 1 リポジトリの同時の `upload-pack` | 1 ノードで 16 | 1 つのリポジトリがノードを占有しない |
| 修復の帯域 | 受け取り 2 Gbps/ノード | 2.8 節 |
| 修復の同時のリポジトリ | 16/ノード | |
| 保守の CPU | ノードの 20% まで（cgroup） | |
| RPC の期限 | 読み取り 10 秒、差分・`merge-tree` 30 秒 | 暴走した処理を止める |

### 3.3 Git フロントエンド

| 設定 | 値 |
| --- | --- |
| 1 タスクの同時接続の上限 | 500 |
| SSH の keepalive | 60 秒 |
| 停止の猶予（`stopTimeout`） | 900 秒（[infrastructure.md](infrastructure.md) の 3 節。EC2 起動タイプでは文書上の上限がない。[git-protocols.md](git-protocols.md) の 9 節、2026-09-26 に確認） |
| NLB・ALB の登録解除の遅延 | 900 秒 |
| ALB のアイドルタイムアウト（Git の HTTPS） | 600 秒（[git-protocols.md](git-protocols.md) の 9 節） |
| ルーティングのキャッシュ | TTL 5 秒（[git-storage.md](git-storage.md) の 4.3 節。遅れた複製はチェックサムの照合で弾く。ノードの喪失は、ストレージの制御から即時に通知して消す） |

### 3.4 Aurora PostgreSQL

Slack の設定（`statement_timeout`、`lock_timeout`、`idle_in_transaction_session_timeout`、`pg_stat_statements` など。[Slack の capacity.md](../../../slack/docs/architecture/capacity.md) の 3.1 節）を引き継ぐ。GitHub に固有のもの：

| 対象 | 設定 | 理由 |
| --- | --- | --- |
| ref の写しのテーブル | `fillfactor = 70` | push のたびに更新する。HOT 更新にする |
| Webhook の配信の記録 | 日でパーティションを切り、古いものを `DROP` | 大量の挿入と削除を VACUUM に任せない |
| ルーティングの表 | reader から読む。変更（配置の変更）だけ writer | 読み取りが非常に多い |

### 3.5 SQS

Slack と同じ（可視性タイムアウトは処理時間 p99 の 6 倍、ロングポーリング 20 秒、DLQ へは 5 回）。repair のキューは使わず、ストレージの制御が DB の表で進捗を持つ（修復は数万件を順序付きで行い、途中で止め・再開するため）。

### 3.6 オートスケール

| サービス | 指標と目標 | 最小 / 最大（S1） |
| --- | --- | --- |
| Git フロントエンド | タスクあたりの同時接続 300、送信 600 Mbps | 18 / 60 |
| Web・API | CPU 50%、ターゲットあたりのリクエスト数 | 12 / 40 |
| Worker | キューごと（2.7 節） | 計 20 / 60 |
| Actions のホスト | キューのジョブ数、待機中の microVM の数 | 14 / 66 |
| ストレージのノード | 自動では増減しない | 42 |

- Git フロントエンドは、縮めるときに接続を切らないよう、スケールインの待ちを 900 秒にする。

### 3.7 クォータ（着手前に確かめ、引き上げを申請する）

| 対象 | 確かめること |
| --- | --- |
| EC2 の vCPU の上限（オンデマンド、インスタンスの種類ごと） | `i8g` 672 vCPU ＋ 修復・入れ替えの余裕、ベアメタル 66 台（12,672 vCPU。SMT を無効にしてもクォータは型の vCPU で数える）。東京と大阪（災害復旧の復元の分） |
| `i8g`・ベアメタルの在庫 | AZ ごと。オンデマンドキャパシティ予約を使うかを決める |
| CloudFront | 配信あたりの転送（既定 150 Gbps）、オリジンの応答タイムアウト（120 秒を超えるなら申請） |
| S3 | 大阪のバックアップのバケットへの PUT（プレフィックスをリポジトリ ID のハッシュで分ける） |
| PrivateLink | エンドポイントサービスの帯域 |
| Lambda | 同時実行（Webhook の送信） |
| SES | 通知メールの送信の上限 |

## 4. リポジトリ・持ち主ごとの上限

特定のリポジトリ・利用者が共有の資源を占有しないよう、上限を置く。値の正本は [api-and-webhooks.md](api-and-webhooks.md)（API のレート制限）と [git-protocols.md](git-protocols.md)（Git の操作）。運用で見る値は [runbooks/README.md](../runbooks/README.md) に置く。

| 対象 | 上限（S1 の初期値） | 超えたとき |
| --- | --- | --- |
| 1 リポジトリへの Git の要求 | 200 件/秒 | 待たせ、続けば 429・503 |
| 1 リポジトリの ref の更新 | 5 件/秒 | 待たせる |
| 1 認証の主体の clone | 1 分に 60 回 | 429 |
| 1 IP の認証なしの clone・fetch | 1 分に 30 回 | 429（HTTPS） |
| 1 リポジトリの clone（完全） | 1 分に 600 回。超えたリポジトリは bundle-uri の対象に入れる | 待たせ、続けば 429 |
| 1 リポジトリの大きさ | 警告 10 GB（`placement_class = large` への移動を検討）。拒否はしない | LFS を勧める（[git-storage.md](git-storage.md) の 12 節） |
| 1 回の push | 2 GB | push を拒否する |
| 1 ファイルの大きさ | 警告 50 MiB、拒否 100 MiB | push を拒否する |

- 公開リポジトリの大量の clone への対策（intent.md の未解決の問い）は、bundle-uri と CDN、上の IP ごと・リポジトリごとの clone の制限に決めた（2026-09-26、既定案。[README.md](README.md) の 6 節）。値は E9 の負荷試験で直す。

## 5. キャパシティの運用

| 活動 | 頻度 | 担当 |
| --- | --- | --- |
| 実際の負荷と 1 節のモデルの比較、ストレージの充填率の予測 | 月次 | Ops |
| ノードの追加の計画（充填率 55% で発注・起動を始める） | 月次 | Ops |
| 上位のリポジトリ（負荷・大きさ）の確認（[observability.md](observability.md) の 3.2 節） | 週次 | Ops |
| 負荷試験：1 節のモデルの 1 倍・2 倍、人気のリポジトリへの clone の集中、ノードの喪失と修復、AZ の喪失 | リリース前、四半期 | QA、Ops |
| 復元の訓練（2.8 節の数値の計測） | 四半期 | Ops |

負荷試験の結果は、この文書と [infrastructure.md](infrastructure.md) の 4 節に反映する。見積もりと 30% 以上ずれた項目は、原因を調べて記録する。

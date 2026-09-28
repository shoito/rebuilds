# Infrastructure: Notion

AWS 上の構成、シャードの配置、冗長化、災害復旧、分析の基盤。基盤の選定は [ADR-0001](../decisions/0001-platform-and-stack.md) で Slack の決定（Slack の [ADR-0011](../../../slack/docs/decisions/0011-aws-container-platform.md)・[0020](../../../slack/docs/decisions/0020-infrastructure-as-code-with-terraform.md)・[0022](../../../slack/docs/decisions/0022-zero-downtime-deploy-and-migrations.md)）を引き継いでいる。シャードは [ADR-0003](../decisions/0003-workspace-sharding.md)・[0027](../decisions/0027-shard-router.md)・[0028](../decisions/0028-zero-downtime-resharding.md)、災害復旧は [ADR-0029](../decisions/0029-disaster-recovery.md)、データレイクは [ADR-0030](../decisions/0030-cdc-data-lake.md)（proposed）にある。計測は [observability.md](observability.md)、負荷の見積もりは [capacity.md](capacity.md)、デプロイは [delivery.md](delivery.md)。

数値のうち「初期見積もり」と書いたものは、負荷試験（E8）の前の仮の値である。AWS の仕様で確かめていないものは「未検証」と書く。

## 1. AWS アカウントとネットワーク

Slack の [infrastructure.md](../../../slack/docs/architecture/infrastructure.md) の 1・2 節と同じ構成にする。違いだけを書く。

| 項目 | Slack と同じ | Notion での違い |
| --- | --- | --- |
| アカウント | management、security、log-archive、shared、dev、staging、prod | S2 でデータレイクを作るときも、prod のアカウントに置く（[ADR-0030](../decisions/0030-cdc-data-lake.md)） |
| リージョン | 東京（主）、大阪（災害復旧）。SCP でほかを禁止 | S3 で利用者の近くのリージョンを足す（11 節）。そのとき SCP を広げる |
| VPC | 3 AZ、public・private・isolated のサブネット | 変わらない |
| 入口 | CloudFront → ALB。WAF を付ける。WebSocket は CloudFront を通す | Sync Gateway の心拍を 25 秒ごとにサーバーから送る（CloudFront は、オリジンから 10 分間何も流れない WebSocket を切る。Slack と同じ理由） |
| 外向きの通信 | Network Firewall のドメインの許可リスト。任意の URL の取得は VPC に接続しない Lambda | 埋め込み・ブックマークのプレビューの取得も同じ方式にする（[security.md](security.md)） |
| 利用者のファイルの配信 | CloudFront の署名付き URL | 利用者が上げたファイルは、アプリと別のドメインから配る（[security.md](security.md)） |

## 2. ECS サービス

すべて Fargate（ARM64）。サービスごとにタスク定義と IAM ロールを分ける。

| サービス | 役割 | スケールの指標 | 最小タスク数 |
| --- | --- | --- | --- |
| api | 読み込み、トランザクションの受け付け、データベースの問い合わせ、検索、共有の設定、公開 API | CPU 50%、ターゲットあたりのリクエスト数 | 3（AZ ごとに 1） |
| sync-gateway | WebSocket の保持、ページの購読、変更と在席の配信（6 節） | タスクあたりの接続数（上限の 60%） | 3 |
| relay | outbox → 配信のバス（Valkey）・SQS。論理シャードをリースで分担する | outbox の最古の行の経過時間 | 物理クラスタごとに 2 |
| workers | 検索の索引、通知、ファイル、Webhook、インポート・エクスポート、バックフィル | SQS の最古のメッセージの経過時間。キューごとに分ける | キューごとに 1〜2 |
| migrator | マイグレーションを群れの順に当てる（[ADR-0031](../decisions/0031-migration-rollout-by-shard-groups.md)） | 1 回だけ実行するタスク | — |
| reshard | 再シャーディングの自動化（[ADR-0028](../decisions/0028-zero-downtime-resharding.md)）。S2 から | 1 回だけ実行するタスク | — |

- 1 つの AZ を失っても足りるよう、平常時の使用率を 2/3 以下に保つ（Slack と同じ）。
- Relay は、物理クラスタごとに群れを持ち、論理シャードごとのリースで担当を分ける。担当の単位がシャードなので、再シャーディングでシャードが移ると、担当も移動先の Relay に移る。outbox の読み方とリースの持ち方は [collaboration.md](collaboration.md) の 7.3 節。

## 3. 論理シャードと物理クラスタ

### 3.1 配置

```
ワークスペースの ID ──(末尾 64 ビット mod 480)──▶ 論理シャード shard000〜shard479
                                                     │  global.shard_map
                                                     ▼
                                          物理クラスタ（Aurora。writer 1＋reader）
```

- 論理シャードは、PostgreSQL のスキーマ `shard000`〜`shard479` として持つ。各スキーマに、ブロックとそこから外部キーでたどれるテーブルの一式を置く（[ADR-0027](../decisions/0027-shard-router.md)、[data-model.md](data-model.md)）。
- シャードに分けないテーブルは、スキーマ `global` に置く：アカウント、ワークスペースの一覧と所在（`logical_shard`、リージョン）、`shard_map`、`shard_groups`、`migration_ledger` など（一覧は [data-model.md](data-model.md) の 3 節）。物理クラスタに属する Relay のリースは、クラスタごとのスキーマ `cluster_local` に置く。
- S1 は、1 つの Aurora クラスタに `global` と 480 のスキーマを置く。S2 で `global` を独立した小さなクラスタに移す。

### 3.2 段階ごとの物理クラスタの数（初期見積もり）

| 段階 | 物理クラスタ | 1 クラスタの論理シャード | 根拠 |
| --- | --- | --- | --- |
| S1 | 1 | 480 | [capacity.md](capacity.md) の 2 節 |
| S1 → S2 の最初の分割 | 4 | 120 | 最初の分割を小さくし、手順を本番で確かめる |
| S2 | 24 | 20 | 1 クラスタの目安を 5,000 トランザクション/秒にした場合（[capacity.md](capacity.md) の 4 節） |
| S3 | リージョンごとに最大 240 | 2 | 同上。論理シャード 1 つの負荷が上限に近づく（[capacity.md](capacity.md) の 4 節） |

- 物理の数は、480 を割り切れる値にする（1、2、4、8、12、16、24、48、96、240 など）。1 クラスタのシャードの数をそろえ、負荷を読みやすくするため。
- 1 つの論理シャードが特に重いときは、そのシャードだけを、空きのあるクラスタへ移す。移し方は分割と同じ（[ADR-0028](../decisions/0028-zero-downtime-resharding.md)）。

### 3.3 ルーター

`packages/shard-router` がワークスペースの ID から物理クラスタの接続を選び、`search_path` とテナントのコンテキストを設定する（[ADR-0027](../decisions/0027-shard-router.md)）。

- `shard_map` は各タスクにキャッシュし、10 秒ごとと、フェンスのエラーを受けたときに読み直す。
- 接続のプールは物理クラスタごと。S1 は 1 つ。S2 では api のタスクが 24 のクラスタへのプールを持つので、1 タスクあたりのプールを小さくする（[capacity.md](capacity.md) の 3.2 節）。
- Sync Gateway は DB に接続しない（Slack と同じ）。

### 3.4 再シャーディング（物理の分割）

手順の正は [ADR-0028](../decisions/0028-zero-downtime-resharding.md)、運用の手順は `resharding.md`（E9 で作る）にある。要点：

1. マイグレーションを凍結し、移動先のクラスタを Terraform で作る（Global Database の二次も付ける）。
2. 論理レプリケーションで、移す論理シャードのスキーマを初期コピーする。二次索引はコピーの後に作る。
3. 行数・チェックサムと、API の影の読み取り（1% を抽出、1 秒遅らせて比べる）で照合する。
4. 8〜16 シャードずつ切り替える：`frozen`（書き込みを最大 10 秒待たせる）→ 移動元のフェンス → 追いつきの確認 → 逆向きの複製 → `shard_map` の更新。
5. 7 日間は逆向きの複製で戻せるようにしておき、その後に移動元を消す。

- `rds.logical_replication` は writer の再起動で有効になるので、S1 の最初から有効にしておく（[AWS のドキュメント](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/AuroraPostgreSQL.Replication.Logical.Configure.html)）。
- 本家は、32 → 96 の再シャーディングを論理レプリケーションで行い、同期は索引を後回しにして 12 時間、切り替えで利用者に見えたのは短い「保存中」の表示だけだった（[The Great Re-shard](https://www.notion.com/blog/the-great-re-shard)）。

## 4. データ層のほかの部品

| 部品 | S1 の構成 | 備考 |
| --- | --- | --- |
| 配信のバス（ElastiCache Valkey） | `cache.r7g.large`、プライマリ 1＋レプリカ 2（3 AZ） | ページごとのチャンネルと在席。Slack と同じ。S2 でクラスタモードと sharded pub/sub |
| SQS | キューごとに標準キュー＋DLQ | [comments-and-notifications.md](comments-and-notifications.md)、[search.md](search.md)、[api-and-integrations.md](api-and-integrations.md) |
| 検索のクラスタ | Amazon OpenSearch Service の 1 ドメイン（[search.md](search.md) の 9 節、[ADR-0023](../decisions/0023-search-engine-and-permission-filtering.md)） | 正本は Aurora。索引は再構築できる |
| データベースの問い合わせ用の索引 | シャードのスキーマの中の `dbx_rows`・`dbx_values`（[ADR-0014](../decisions/0014-database-query-index.md)） | 変更と同じ DB のトランザクションで更新する。物理の分割にも一緒に乗る |

## 5. ファイル

- 利用者が上げたファイル（画像、添付、エクスポートの成果物）は S3 に置く。キーは `ws/{workspace_id}/...` で始める。ワークスペースの削除と、S3 でのリージョンの移動を、プレフィックスの単位で行うため。
- 配信は CloudFront の署名付き URL。アプリと別のドメインから配る（[security.md](security.md)）。
- アップロードは、署名付き URL でクライアントから S3 へ直接行う。スキャンとサムネイルは、SQS の `file-events` のキューから Worker が処理する（Slack の [ADR-0015](../../../slack/docs/decisions/0015-file-upload-scan-and-delivery.md) を先例にする）。
- 東京 → 大阪のレプリケーション（Replication Time Control 付き）。バージョニングを有効にし、削除から 30 日で古いバージョンを消す。ゴミ箱の保持期間（[block-model.md](block-model.md)）より長くする。

## 6. Sync Gateway の群れ

- 接続は、ワークスペースに依らず、ALB が任意のタスクに振り分ける。購読はページ単位で、各タスクは自分の接続が購読するページのチャンネルだけを Valkey で購読する（Slack の [ADR-0013](../../../slack/docs/decisions/0013-gateway-scaling-and-presence.md) と同じ考え方）。
- 変更の確定と順序は API と DB が持つ（[ADR-0005](../decisions/0005-transactions-as-unit-of-change.md)）。Gateway は状態を持たず、欠損はクライアントがページの `seq` で差分を取り直して埋める。
- 変更の送信（クライアント → サーバー）は、WebSocket と `POST /transactions` の両方で受ける（[collaboration.md](collaboration.md) の 7 節）。WebSocket で受ける場合も、Gateway は API の受け付けの処理を呼ぶだけで、DB に直接書かない。
- デプロイと縮小のときは、Slack と同じく、登録解除の遅延の間に接続を少しずつ切る（[delivery.md](delivery.md) の 4.2 節）。クライアントは未確定のトランザクションをローカルに持つので、切断で入力を失わない。
- 再接続の殺到（AZ の障害、デプロイ）を最大の負荷として見積もる（[capacity.md](capacity.md) の 2.4 節）。

## 7. S1 の構成と台数（初期見積もり）

S1（利用者 10 万、ブロック 10 億、同時接続 1 万）の本番。根拠は [capacity.md](capacity.md)。

| リソース | 構成 |
| --- | --- |
| Aurora PostgreSQL 18（シャード＋`global`） | writer `db.r8g.4xlarge` × 1、reader 同型 × 2（別々の AZ）。I/O-Optimized。`rds.logical_replication = 1` |
| Aurora（大阪） | Global Database の二次。headless |
| Valkey | `cache.r7g.large` × 3 |
| api | 2 vCPU / 4 GB × 6 タスク（最大 20） |
| sync-gateway | 1 vCPU / 2 GB × 3 タスク（最大 9） |
| relay | 0.5 vCPU / 1 GB × 2 タスク |
| workers | 0.5〜1 vCPU × 計 8 タスク（最大 20） |
| S3 | ファイル、Web の配信、エクスポート、ログ、分析用のエクスポート（10 節）のバケットを分ける |

staging は同じ構成を最小の台数で持ち、論理シャードは本番と同じ 480 にする（マイグレーションの群れと再シャーディングの訓練のため）。dev とローカルは、論理シャードの数を設定で 8 に減らせるようにする。関数は同じで、剰余の数だけ変える。

## 8. バックアップと災害復旧

### 8.1 バックアップ

| 対象 | 方法 | 保持 |
| --- | --- | --- |
| Aurora（全物理クラスタ） | 自動バックアップ（PITR）、AWS Backup の連続バックアップ | 35 日 |
| Aurora（大阪へのコピー） | AWS Backup のスナップショットを 1 日 1 回、大阪へ | 35 日 |
| S3（ファイル） | バージョニング、大阪へのレプリケーション | 削除から 30 日 |
| Valkey、SQS | バックアップしない | outbox と差分の取得で回復する |
| 検索の索引 | バックアップしない（再構築できる） | [search.md](search.md) |

- 保管庫は AWS Backup Vault Lock で削除を防ぐ。KMS はマルチリージョンキー（Slack と同じ）。
- **1 つのワークスペースだけを戻す**ときは、PITR で隔離した VPC にクラスタを復元し、そのワークスペースの論理シャードのスキーマから、`workspace_id` で絞った行だけを取り出して戻す（[runbooks/disaster-recovery.md](../runbooks/disaster-recovery.md) の C）。ページ単位の復元は、利用者向けの履歴とゴミ箱で行う（[block-model.md](block-model.md)）。

### 8.2 災害復旧（NFR-008・009）

決定は [ADR-0029](../decisions/0029-disaster-recovery.md)。

| 障害 | 仕組み | 目標 |
| --- | --- | --- |
| AZ | Aurora のクラスタの中のフェイルオーバー、ECS の再配置、Valkey のフェイルオーバー、クライアントの再接続 | RPO 0、RTO 5 分（NFR-008） |
| リージョン | 物理クラスタごとの Global Database の二次を昇格。大阪に Terraform でアプリの基盤を作る（パイロットライト） | RPO 15 分、RTO 4 時間（NFR-009） |

- Global Database の RPO は通常、秒の単位。計画外のフェイルオーバーでは、その時点の複製の遅延ぶんを失いうる。計画的な切り替えは RPO 0（[AWS のドキュメント](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-global-database-disaster-recovery.html)）。
- headless の二次は、切り替えの前にインスタンスを足す（同上）。
- 大阪に常に置くもの：Global Database の二次、ECR のレプリケーション、S3 のレプリカ、Secrets Manager のレプリカ、KMS のマルチリージョンキー、空の VPC。ECS・ALB・Valkey・SQS は切り替え時に作る（状態ファイルは大阪のバケット。Slack の ADR-0020）。
- S2 では物理クラスタが数十になる。昇格とインスタンスの追加を並列に行うワークフローを用意し、RTO を訓練で確かめる。
- 手順は [runbooks/disaster-recovery.md](../runbooks/disaster-recovery.md)。

## 9. CI/CD と環境

Slack の [infrastructure.md](../../../slack/docs/architecture/infrastructure.md) の 6・7 節と同じにする（GitHub Actions、OIDC、1 回ビルドして昇格、本番のデータを本番のアカウントの外に出さない）。Notion での追加は [delivery.md](delivery.md) にある：マイグレーションの群れ、デプロイの関門、Sync Gateway の接続の移し替え、デスクトップアプリの配布。

## 10. 分析の基盤（データレイク）

決定は [ADR-0030](../decisions/0030-cdc-data-lake.md)（proposed）。

| 段階 | 方式 | 鮮度 |
| --- | --- | --- |
| S1 | Aurora のクラスタのデータを 1 日 1 回 S3 へエクスポート（Parquet）。Athena で読む | 1 日 |
| S2 | 物理クラスタごとの Debezium → MSK（テーブルごとに 1 トピック）→ Spark で Hudi か Iceberg の表を S3 に書く | ブロックで 2 時間、その他で 15 分 |
| S3 | リージョンごとにデータレイクを持ち、本文を除いた集計だけを中央へ | 同上 |

```
Aurora（物理クラスタごと。shard000〜shard479）
   │ 論理デコード（スロット）
   ▼
Debezium（Kafka Connect）─▶ MSK（テーブルごとに 1 トピック）─▶ Spark ─▶ S3（Hudi / Iceberg）─▶ Athena
```

- Aurora のクラスタのエクスポートは、クローンから書き出すので稼働中のクラスタの性能に影響しない（[AWS のドキュメント](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/export-cluster-data.html)）。S2 の初期の状態づくりにも使う。
- 本家は同じ構成で、更新が upsert の 90% を占め、ブロックの表の取り込みの遅延は最大 2 時間だった（[Building and scaling Notion's data lake](https://www.notion.com/blog/building-and-scaling-notions-data-lake)）。
- データレイクは権限の判定を通らないので、利用者に中身を返す機能の元にしない（[ADR-0030](../decisions/0030-cdc-data-lake.md)）。
- CDC のスロットの遅延を監視する。止まったスロットは WAL をため、本番の DB に影響する（[observability.md](observability.md)）。

## 11. S3 の複数リージョン（計画）

S3（利用者 1 億、同時接続 1,000 万）では、東京だけでなく、利用者の近くのリージョンでも動かす。データの保管地域の選択は MVP の外（[intent.md](../intent.md)）だが、形はここで想定しておく。本家は 2025 年に EU のデータの保管地域を始め、データはそれが生じたリージョンで処理・保存する、という原則で組んでいる（[Enabling multi-region data systems at Notion](https://www.notion.com/blog/enabling-multi-region-data-systems-at-notion)）。

- **ワークスペースの所在をリージョンで持つ。** `global.workspaces.region` を正本とし、`shard_map` のキーを（リージョン、論理シャード）にする。各リージョンが、それぞれ 480 の論理シャードを持つ。
- **リージョンごとに持つもの：** API・Sync Gateway・Relay・Worker、Aurora の物理クラスタ、Valkey、検索、ファイルの S3、データレイク。
- **リージョンの外（global）に置くもの：** アカウントと認証、ワークスペースの一覧と所在、課金。Global は各リージョンにキャッシュし、止まってもログイン済みのクライアントが使い続けられるようにする（Slack の [ADR-0023](../../../slack/docs/decisions/0023-cell-based-architecture.md) と同じ課題）。
- **振り分け：** クライアントはログイン後に、ワークスペースごとのリージョンのエンドポイントを受け取る。リージョンは、自分が持たないワークスペースへのリクエストに 421 を返し、クライアントは所在を取り直す。
- **ワークスペースをリージョン間で移す：** `workspace_id` で絞った論理レプリケーション（行フィルタ）でコピーし、短時間の書き込みの停止で切り替える。行フィルタは PostgreSQL 15 以降の `FOR TABLE ... WHERE (workspace_id = ...)` で、テーブルを列挙して付ける（`FOR TABLES IN SCHEMA` には付けられない）。UPDATE・DELETE を流すには、フィルタの列がレプリカ識別子に含まれる必要があり、全テーブルの主キーに `workspace_id` を含めるので満たす（[CREATE PUBLICATION](https://www.postgresql.org/docs/18/sql-createpublication.html)、2026-09-27 に確認）。Slack の [infrastructure.md](../../../slack/docs/architecture/infrastructure.md) の 10.4 節と同じ手順。リージョン間の実際の手順は **未検証**。
- 決定は、S3 に入る前に ADR にする（未起票）。

## 12. 段階を上げる判断の基準

次のどれかに当たり、平常の運用で戻らない見込みになったら、次の段階の作業を始める。

| 指標 | S1 → 最初の分割（E9） | S2 → S3 |
| --- | --- | --- |
| writer の CPU（ピーク時の p95） | 50% を超える、またはインスタンスを 1 段上げても 6 か月もたない | 最も重いクラスタが、2 シャードでも 50% を超える見込み |
| ストレージ（1 クラスタ） | 10 TB を超える見込み（VACUUM・復元の時間が伸びる） | 同左 |
| 論理レプリケーションで移す時間 | — | 1 群れのコピーが 24 時間を超える |
| 同時接続 | 6,000（S1 の上限の 60%）を 2 週続けて超える | 60 万を超える |
| リージョン | — | 東京から遠い利用者のページの表示（NFR-002）が目標を外れる、データの保管地域の契約上の要件が出る |

## 13. コストの概算（S1、本番、1 か月）

大まかな見積もり（±50%）。Slack の [infrastructure.md](../../../slack/docs/architecture/infrastructure.md) の 9 節の単価をもとにした。

| 項目 | 月額（USD、概算） |
| --- | --- |
| Aurora（r8g.4xlarge × 3、ストレージ約 2 TB、I/O-Optimized、Global Database の複製） | 6,000 |
| OpenSearch（Multi-AZ with Standby、データノード 6、専用マスター 3、EBS 約 4 TB。[search.md](search.md) の 9.1 節。単価は E8 の `load-test-k6` で確かめる） | 4,500 |
| ECS Fargate | 1,200 |
| ElastiCache | 600 |
| CloudFront、ALB、データ転送 | 1,000 |
| NAT、Network Firewall | 1,000 |
| 可観測性 | 1,200 |
| セキュリティのサービス | 600 |
| バックアップ、S3、大阪の待機、分析用のエクスポート | 800 |
| その他 | 300 |
| **本番の合計** | **約 17,200** |

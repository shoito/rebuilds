# Infrastructure: Salesforce

AWS のアカウントとネットワーク、サービスの分け方、論理シャードと物理のクラスタ、`events` と `history` のクラスタ、OpenSearch、送信の VPC、S3 のセル、組織の移動、災害復旧、段階を上げる基準、Terraform の構成、コスト。土台は [ADR-0001](../decisions/0001-platform-and-stack.md)（他の題材の基盤を引き継ぐ）と [ADR-0005](../decisions/0005-tenancy-and-governor-limits.md)（論理シャード 256 とセルで広げる）。この文書で決めたことは、次の 4 つの ADR にある。

- **アカウントを管理・監査・本番・送信で分ける。** 本番の中で、対話・管理・一括・Worker・組織をまたぐ処理・コードの実行を別のサービスとロールにする。送信の VPC と監査のアカウントは本体への経路を持たない（[ADR-0054](../decisions/0054-accounts-network-and-service-separation.md)）。
- **論理シャードを表で物理のクラスタに割り当て、組織ごとの上書きを持つ。** 段階を上げる基準を、writer の CPU・保存の量・最大の組織の大きさで決める（[ADR-0055](../decisions/0055-shard-placement-and-stage-criteria.md)）。
- **組織の移動は、`org_id` の行の絞りを付けた論理レプリケーションで写し、数十秒の書き込みの止めの間に照合して切り替える**（[ADR-0056](../decisions/0056-org-migration-by-row-filtered-logical-replication.md)）。
- **大阪に Aurora Global Database の副と縮めた ECS を置く温かい待機にする。** 検索の索引と Valkey は切り替えの後に作り直す（[ADR-0057](../decisions/0057-disaster-recovery-osaka-warm-standby.md)）。

ログ・メトリクス・SLI は [observability.md](observability.md)、負荷と台数の根拠は [capacity.md](capacity.md)、CI とリリースは [delivery.md](delivery.md)、鍵と統制は [security.md](security.md) にある。

数値のうち「初期見積もり」は、E12 の負荷試験の前の仮の値である。AWS の仕様で確かめていないものは「未検証」と書き、確かめる Story を添える。AWS の資料は 2026-09-28 に確かめた。

## 1. AWS アカウントの構成（ADR-0054）

| アカウント | OU | 中身 |
| --- | --- | --- |
| management | Root | Organizations、SCP、IAM Identity Center、請求 |
| security | Security | GuardDuty・Security Hub・Inspector の委任管理者、調査用のロール |
| log-archive | Security | 組織の CloudTrail、Config、VPC フローログ、**監査の錨と監査の外部の保管**（Object Lock のコンプライアンスのモード。[ADR-0046](../decisions/0046-setup-audit-trail-and-login-history.md)）。東京 → 大阪へ複製 |
| shared | Infrastructure | ECR（東京・大阪に複製）、Route 53（`<brand>.<domain>`）、Managed Grafana、CI の起点、Terraform の状態のバケット |
| edge | Infrastructure | CloudFront、WAF、ACM（us-east-1）、CloudFront のログ |
| dev、staging | Workloads/NonProd | 開発・検証。staging は本番と同じ構成を最小の台数で持つ |
| prod（セルごと） | Workloads/Prod | 本番（東京と大阪）。ECS のサービス、Aurora（主・`events`・`history`）、Valkey、OpenSearch、SQS、S3 |
| prod-egress（セルごと） | Workloads/Prod | Webhook・外向きの呼び出し・メールの送り手（`sender`）と Elastic IP の NAT。prod への経路を持たない（[ADR-0035](../decisions/0035-webhooks-outbound-calls-and-ssrf-guard.md)） |

- **SCP**（Workloads の OU）：
  - 東京・大阪以外のリージョンを禁止する（CloudFront・WAF・ACM・IAM のための us-east-1 を除く）。データの所在は法務の L6 で確定する（[security.md](security.md) の 11 節）。
  - CloudTrail・Config・GuardDuty の停止、KMS の鍵の削除の予約・キーポリシーの変更を、break-glass のロール以外に禁止する（[ADR-0052](../decisions/0052-key-hierarchy-and-per-org-data-keys.md)）。
  - log-archive のバケットの Object Lock の設定の変更と保持の短縮を拒否する。
- prod の Worker に与える log-archive への権限は、錨・保管のバケットへの `PutObject` だけ。
- prod-egress への受け渡しは、prod-egress のアカウントの SQS（prod の Worker には `SendMessage` だけ）で行う。送信の結果は別のキューで prod へ戻す。

## 2. ネットワーク

### 2.1 prod の VPC（東京・大阪で同じ形）

| サブネット | 置くもの | インターネットへの経路 |
| --- | --- | --- |
| public | ALB（`alb-app`・`alb-api`）、NAT | Internet Gateway |
| private | `runtime`、`metadata`、`bulk`、`worker`、`cross-org-worker`、`relay`、`indexer` | NAT 経由。Network Firewall で宛先を許可リストに限る（SES の API は VPC エンドポイント。SSO の IdP のメタデータの取得は prod-egress 経由） |
| isolated | Aurora（主・`events`・`history`）、Valkey、OpenSearch | なし |

- 入口は CloudFront → ALB だけ。ALB のセキュリティグループは CloudFront のマネージドプレフィックスリストだけを許し、CloudFront が付ける秘密のヘッダーをリスナーの規則で検査する（Auth0 の再構築と同じ形。[auth0 の infrastructure.md](../../../auth0/docs/architecture/infrastructure.md) の 2.1 節）。
- VPC エンドポイント：S3、ECR、SQS、KMS、Secrets Manager、CloudWatch Logs、STS、X-Ray、AppConfig、SES。
- セキュリティグループは、サービスごとに入る側と出る側を明示する。Aurora の主へ入れるのは `runtime`・`metadata`・`bulk`・`worker`・`cross-org-worker`・`relay`。`events` と `history` へは `relay`（書き）、`runtime`・`worker`（読み、消去）、`cross-org-worker`（移動・組織の消去）。OpenSearch へは `runtime`・`indexer`・`worker`。

### 2.2 送信の網（prod-egress、ADR-0035・ADR-0054）

```
prod: worker（webhook-sender、署名を付ける）─SQS─▶ prod-egress: sender ─▶ NAT（Elastic IP）─▶ 組織の宛先
                                               ◀─SQS（結果）──
```

- prod-egress の VPC は、prod とのピアリング・Transit Gateway・VPC エンドポイントを持たない。`sender` は秘密を持たず、署名済みの要求を送るだけ。
- 宛先の検査（名前解決の後の全てのアドレス、リダイレクトを追わない）は `sender` で行う（[events-and-integrations.md](events-and-integrations.md) の 6.2 節）。
- NAT の Elastic IP を東京と大阪で最初から公開し、変える時は 30 日前に知らせる（runbook `egress-ip-change`）。

### 2.3 ホスト名

| ホスト名 | 中身 |
| --- | --- |
| `<org>.my.<brand>.<domain>` | 画面（SPA）と REST API。組織の解決はホスト名から（ADR-0005） |
| `login.<brand>.<domain>` | 組織を知らない時のログインの入口 |
| `static.<brand>.<domain>` | SPA の静的な資産（S3） |
| `api.<brand>.<domain>` | OAuth のトークンのエンドポイント（トークンから組織を決める） |

- `*.my.<brand>.<domain>` はワイルドカードの証明書 1 枚。独自のドメインは MVP の後（[orgs-users-and-auth.md](orgs-users-and-auth.md) の 1 節）。

## 3. ECS サービス

すべて Fargate（ARM64）。サービスごとにタスク定義・IAM ロール・DB のロールを分ける。

| サービス | 役割 | DB のロール | スケールの指標 | 最小タスク数（S1、東京） |
| --- | --- | --- | --- | --- |
| runtime | 画面と REST API、問い合わせと DML のコンパイルと実行 | `app_runtime`（RLS） | CPU 50%、ターゲットあたりの同時要求数 | 12（AZ ごとに 4） |
| metadata | Setup、メタデータの変更、デプロイの検証・適用 | `app_runtime` | CPU 50% | 3 |
| bulk | 一括のジョブの受付と状態 | `app_runtime` | CPU 50% | 3 |
| worker | 一括の処理、共有のジョブ、レポートの非同期、フローの非同期、統計、整合の検査、消去 | `app_worker`（RLS） | `jobs` の class ごとの待ちの時間 | class ごとに 2〜6 |
| cross-org-worker | 組織の作成、Sandbox の複製、組織の移動、組織の消去 | `admin_cross_org`（RLS を外す） | 待ちの数 | 2 |
| relay | outbox → `events`・SQS（論理シャードごとの書き手） | `app_worker` | outbox の最古の行の経過時間 | 3 |
| indexer | 検索の索引の書き込み | `app_worker`（読むだけ） | SQS の最古のメッセージ | 3 |
| sender（prod-egress） | Webhook・外向きの呼び出しの送信 | なし | SQS の最古のメッセージ、同時送信数 | 2 |

- `runtime` と `worker` のタスクには、E13 から `code-runner`（Rust＋Wasmtime）のコンテナを足す。資格情報の環境変数を渡さず、読み取り専用のファイルシステム、root でない利用者にする。`runtime` とはタスクの中の共有のボリュームの UNIX ドメインソケットでつなぐ（[ADR-0048](../decisions/0048-user-code-engine-quickjs-ng-on-wasmtime-fuel.md)）。
- DB の接続：各タスクは writer と reader の接続のプールを持つ。RDS Proxy は使わない。PostgreSQL では `SET`・`set_config` とセッションの単位のアドバイザリロックが接続を固定（pinning）し、多重化が効かなくなるため（トランザクションの単位のアドバイザリロックは固定しない。[Avoiding pinning an RDS Proxy](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/rds-proxy-pinning.html)、2026-09-28 に確認）。接続の数の上限は [capacity.md](capacity.md) の 5 節。
- 各サービスは、残る 2 AZ で最大負荷をさばける台数を常に持つ（平常の使用率を 2/3 以下に保つ）。
- 台数の根拠は [capacity.md](capacity.md)。

## 4. データの置き場所（ADR-0055）

### 4.1 1 つのセルの中身

```
セル（prod アカウント）
 ├─ 主の Aurora クラスタ（1〜n）… writer 1＋reader 2〜5。records・ピボット・共有・メタデータ・監査・商談の履歴・outbox
 ├─ events の Aurora クラスタ   … writer 1＋reader 1。change_events・org_events（3 日）
 ├─ history の Aurora クラスタ  … writer 1＋reader 1。field_history（18 か月。ADR-0047 の注記）
 ├─ OpenSearch のドメイン       … 共有の索引 rec-v{n}-{00..15}（ADR-0031）
 ├─ Valkey のクラスタ           … メタデータの部品（L2）、割り当ての数、組織の設定のキャッシュ
 ├─ S3                          … 一括・レポートの結果、添付、パッケージ（組織の DEK で暗号化）
 └─ ECS のサービス一式
```

- S1 と S2 は 1 つのセル。S2 は主のクラスタを複数持つ（Sandbox と試用の組織を別のクラスタへ）。S3 はセルを増やし、大口の組織に専用のセルを置く。
- 組織の置き場所の解決（管理のサービスと `runtime` の入口）：

```
org_placements[org_id] があれば → (cell_id, cluster_id)
なければ → shard_map[orgs.shard_no] → cluster_id（cell は cluster から決まる）
```

- `shard_map`・`org_placements` は RLS の外の運用の表で、管理の DB（セルをまたぐ `control` の小さな Aurora。S3 から。S1・S2 は主のクラスタの中の別のスキーマ）に置く。結果は組織の設定のキャッシュに持つ。

### 4.2 主の Aurora

| 項目 | S1 の値 | 根拠 |
| --- | --- | --- |
| エンジン | Aurora PostgreSQL 18、I/O-Optimized | [ADR-0001](../decisions/0001-platform-and-stack.md)。書き込みの増幅（ピボット）で I/O が多いため I/O-Optimized を選ぶ |
| writer | `db.r8g.8xlarge` × 1 | [ADR-0060](../decisions/0060-load-model-and-sizing-review.md)、[capacity.md](capacity.md) |
| reader | `db.r8g.4xlarge` × 2（レポート・一括の問い合わせ・検索の後の確かめ・整合の検査） | 同 |
| 保存の上限 | 256 TiB（Aurora PostgreSQL 17.5 以降）。表の上限は 32 TiB | [Quotas and constraints for Amazon Aurora](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/CHAP_Limits.html) |
| reader の上限 | 1 クラスタ 15 | 同 |
| 分割 | `shard_no` の LIST 分割（256）。監査・ログインの履歴・商談の履歴は月ごと | [ADR-0010](../decisions/0010-record-tables-partitioning-and-pivots.md)、[ADR-0046](../decisions/0046-setup-audit-trail-and-login-history.md) |
| バックアップ | 自動バックアップ 35 日（Aurora の保持は 1〜35 日。[Overview of backing up and restoring an Aurora DB cluster](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Aurora.Managing.Backups.html)、2026-09-28 に確認）、PITR | [ADR-0053](../decisions/0053-operator-access-and-data-lifecycle.md) |
| DR | Global Database の副を大阪に（7 節） | ADR-0057 |

- パラメーター：`rds.force_ssl = 1`、`statement_timeout`（ロールごと。`app_runtime` 30 秒、`app_worker` 10 分）、`idle_in_transaction_session_timeout`（2 分）、`log_min_duration_statement`（1 秒）、`track_io_timing`。
- 1 アカウント・1 リージョンの DB のクラスタの既定の上限は 40、インスタンスは 40（引き上げを申請できる。同じ資料）。S3 のセルごとのアカウントで収まる。

### 4.3 `events` のクラスタと `history` のクラスタ

- [ADR-0033](../decisions/0033-change-event-log-and-replay.md) のとおり、主と別のクラスタ。S1 は `db.r8g.xlarge`（writer 1＋reader 1）。3 日で約 130GB（[events-and-integrations.md](events-and-integrations.md) の 3.5 節）。
- Relay は論理シャードごとに 1 つの書き手（アドバイザリロック）。主のクラスタの outbox を読み、`events` に書く。
- 主のクラスタと同じく、Global Database の副を大阪に置く。

**`history` のクラスタ**（2026-09-28。[ADR-0047](../decisions/0047-field-history-tracking-and-retention.md)・[ADR-0060](../decisions/0060-load-model-and-sizing-review.md) の注記）

- 項目の変更の履歴（`field_history`）を、S1 から主と別のクラスタに置く。18 か月で約 350 億行・約 3.5TB（[capacity.md](capacity.md) の 3 節）で、主のクラスタの履歴以外の全て（約 2.2TB）より大きい。主に置くと、保存の量の段階の基準、VACUUM、PITR の復元、組織の移動の初期の同期が履歴に引きずられる。
- 形は `events` と同じ：保存の手順 9 が同じトランザクションの outbox（`kind = field_history`）に書き、Relay（論理シャードごとの唯一の書き手）が `history` に `INSERT` する。outbox の行の ID から作る一意の鍵で二重を捨てる。月ごとの範囲の分割で、19 か月目の最初の日に `DROP` する。
- S1 は `db.r8g.xlarge` の writer 1＋reader 1（履歴の関連リスト、項目の変更の履歴のレポート、消去）。書き込みは平均 750 行/秒・ピーク 3,000 行/秒で、Relay が 1,000 行ずつまとめて書く。Aurora の種類（Standard か I/O-Optimized）は、E11 で I/O の量を測って決める（履歴は書くだけで読みが少ないので Standard が安い見込み。東京の単価は、Standard が `db.r8g.xlarge` 1 時間 0.666 USD・保存 1 GB 月 0.12 USD・I/O 100 万回 0.24 USD、I/O-Optimized が 0.866 USD・0.27 USD・I/O の料金なし。9 節）。
- 主・`events` と同じく、Global Database の副を大阪に置く。`history` の障害の間は、outbox にたまり、保存は止めない。履歴の画面と API は 503 にする。

### 4.4 OpenSearch

- 1 つのセルに 1 つのドメイン。VPC の中、保存時の暗号化、ノードの間の TLS、IAM は `runtime`・`indexer`・`worker` だけ（[search.md](search.md) の 9 節）。
- S1：データノード `r7g.2xlarge.search` × 6（3 AZ に 2 つずつ）、専用のマスター `m7g.large.search` × 3、gp3 500GB × 6。複製 1。索引は `rec-v{n}-{00..15}`（ADR-0031）、主シャードは索引ごとに 2。台数の根拠は [capacity.md](capacity.md) の 7.1 節（2026-09-28 に 3 台から見直した）。
- 大阪は小さなドメインを空で置き、切り替えの後に作り直す（7 節）。
- 大口の組織の専用の索引は S2（[search.md](search.md) の ADR-0031 の Consequences）。

### 4.5 Valkey

- ElastiCache（Valkey）、クラスタモード、`cache.r7g.large` × 3 シャード × 2。失われてよい（ADR-0001）。
- 中身：メタデータの部品（L2）と今のバージョンの値、割り当ての 1 分の桶、組織の設定のキャッシュ、Pub/Sub のバージョンの通知。
- 障害の時：部品は L3（Aurora）から作る。割り当ては fail open（[ADR-0042](../decisions/0042-org-allocations-fair-queuing-and-limit-info.md)）。

### 4.6 S3

| バケット | 中身 | 暗号 | 複製 |
| --- | --- | --- | --- |
| `org-files` | 一括の CSV・結果、レポートの結果、エクスポート、添付、メールの原本 | 組織の DEK＋SSE-KMS | 大阪へ |
| `packages` | メタデータのパッケージ、パッケージのバージョン（E13） | SSE-KMS | 大阪へ |
| `static` | SPA の資産 | SSE-S3 | 大阪へ |
| log-archive の `audit-archive` | 監査の外部の保管と錨 | 組織の `audit` の DEK＋SSE-KMS、Object Lock | 大阪へ |

- 組織のファイルの鍵の接頭辞は `<org_id>/`。組織の削除は接頭辞ごとに消す（バージョンを含む）。

## 5. 段階を上げる基準（ADR-0055）

どれか 1 つを 2 週続けて満たしたら、次の段階の準備（Epic の起票）を始める。値はダッシュボードで毎週見る（[observability.md](observability.md) の 6 節）。

| 基準 | 値 | 動き |
| --- | --- | --- |
| 主の writer の CPU の p95 | 50% を超える | 主のクラスタを分ける（論理シャードの半分を新しいクラスタへ） |
| 主のクラスタの保存の量 | 20 TiB を超える | 同 |
| 最大の表の 1 つの分割 | 500GB を超える | その論理シャードの大きな組織を動かす |
| 最大の組織の DB の時間 | クラスタの 20% を常に超える | 専用のクラスタ（S2）・専用のセル（S3）へ動かす |
| Sandbox と試用の DB の時間 | クラスタの 30% を超える | Sandbox と試用を別のクラスタへ（S2） |
| `events` の保存の量 | 1TB を超える | `events` のクラスタを論理シャードで分ける |
| `history` の 1 つの月の分割 | 500GB を超える | `history` のクラスタを論理シャードで分ける（[ADR-0055](../decisions/0055-shard-placement-and-stage-criteria.md) の注記） |
| OpenSearch の JVM のヒープ | p95 75% を超える | データノードを足す、大口の組織を専用の索引へ |
| 対話の要求のピーク | 1 万件/秒の見込み | S3 のセルの準備 |

- 論理シャードの単位でクラスタを分ける時も、組織の移動（6 節）と同じ論理レプリケーションを、論理シャードの全ての組織を絞りにして使う（`WHERE shard_no = $1`。`shard_no` は主キーに含まれ、replica identity に入る）。

## 6. 組織の移動（ADR-0056）

### 6.1 流れ

```
1 準備      ：先のクラスタのマイグレーションのバージョンが同じ。組織の shard_no の分割が先にある。移動の間のマイグレーションを止める
2 写し      ：元に公開 org_move_<id>（全ての組織の表、WHERE org_id = '…'、publish_via_partition_root）→ 先で購読
3 付随の写し：events の 3 日分と history の 18 か月分（同じ方法）、S3 の <org_id>/ の接頭辞、OpenSearch（先の索引へ作り直し）
4 追いつき  ：遅れが 5 秒を下回り続ける
5 止め      ：orgs.status の補助 migrating。書き込みを 503 ORG_MIGRATING（Retry-After）、Worker の組織の仕事を止める。目標 60 秒以内
6 照合      ：遅れ 0 を待ち、表ごとの行の数と ID の範囲ごとのハッシュを元と先で比べる
7 切り替え  ：org_placements を書き、組織の設定のキャッシュを無効に。migrating を外す。Valkey の組織の鍵を先で作り直す
8 後始末    ：購読と公開を消す。元の行は 7 日残し、その後 admin_cross_org で消す
```

- 事実：PostgreSQL 15 以降は公開に行の絞りを付けられ、初期の同期にも絞りがかかる。`UPDATE`・`DELETE` を公開する時、絞りの列は replica identity に含まれる必要がある。分割の表は `publish_via_partition_root = true` で根の表の絞りを使う（[Row Filters](https://www.postgresql.org/docs/18/logical-replication-row-filter.html)）。全ての組織の表は主キーの先頭に `org_id` を持つので、既定の replica identity（主キー）で絞りの条件を満たす。Aurora PostgreSQL は論理レプリケーションを持つ（[Aurora PostgreSQL の論理レプリケーション](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/AuroraPostgreSQL.Replication.Logical.html)）。
- 組織の表の一覧は、`org_id` の列を持つ全ての表から機械的に作る（手で書かない）。`org_id` を持ち RLS をかける表は 151（`main` 147、`events` 3、`history` 1。[data-model.md](data-model.md) の 1 節。2026-09-28 に数え直した）。
- 組織の `shard_no` は変えない（ADR-0055）。行をそのまま写し、分割の形が同じ。
- 中止：6 までは、購読を消して先の行を消し、`migrating` を外すだけ。7 の後は逆向きの移動。
- 所要時間の見込み：5,000 万件（約 100GB）の初期の同期に数時間、止めは数十秒（E12 の `org-migration-tool` で測る。未検証）。夜間に行う。

### 6.2 移動の間の各部品

| 部品 | 扱い |
| --- | --- |
| 監査の鎖 | 行をそのまま写すので続く。錨は `org_id` の単位 |
| `replay_id` | 写した値のまま。先の Relay は、先の outbox から続ける（止めの間に元の outbox を全て送り終える） |
| 共有の世代・ルールのバージョンのジョブ | 移動の前に完了か保留にする。動いているジョブがあれば移動を始めない |
| 一括のジョブ・予定の経路 | 止めの間は待たせ、切り替えの後に先の Worker が続ける（`jobs` の行も写す） |
| 検索 | 先の索引ができるまで、元の索引を読む（組織の単位で索引の置き場所を持つ） |
| 割り当ての数 | Valkey は先で作り直す。`org_usage_minutes` から戻す |

## 7. 災害復旧（ADR-0057）

### 7.1 目標と構成

| 障害 | 目標 | 仕組み |
| --- | --- | --- |
| AZ | RPO 0、RTO 5 分（NFR-007） | Aurora の reader への自動の切り替え、3 AZ の ECS、OpenSearch の 3 AZ、Valkey の複製 |
| リージョン | RPO 1 分以内、RTO 1 時間以内（NFR-008） | 大阪の温かい待機（下の表） |

| 部品 | 大阪の平常 | 切り替えの後 |
| --- | --- | --- |
| 主・`events`・`history` の Aurora | Global Database の副（reader 1） | 管理された failover で主に |
| ECS | 各サービスの最小（runtime 3、他 1） | オートスケールで東京と同じ台数へ |
| OpenSearch | 小さなドメイン（空） | 作り直し。済むまで `degraded`（名前の前方一致） |
| Valkey | 小さなクラスタ（空） | 空で始め、L3 と DB から作り直す |
| S3 | 複製の先 | そのまま使う |
| KMS | マルチリージョンの鍵の複製 | そのまま使う |
| prod-egress | NAT と `sender` の最小 | 同じ。Elastic IP は大阪の分を最初から公開 |

- 事実：Aurora Global Database の switchover は RPO 0。failover は非同期の複製の遅れの分を失いうる。RPO は普通は秒の単位、RTO は分の単位。管理された failover は古い主の書き込みを止める試み（write fencing）をするが、確実ではない。2 リージョンだけの時は `rds.global_db_rpo` を既定のままにすることが勧められている（[Using switchover or failover in Amazon Aurora Global Database](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-global-database-disaster-recovery.html)）。
- 切り替えは人が決める（ADR-0057）。手順は [runbooks/disaster-recovery.md](../runbooks/disaster-recovery.md)。
- 失った範囲：切り替えの直前の `AuroraGlobalDBRPOLag` と、東京が応答しなくなった時刻を記録する。東京が戻ったら、Aurora が作る古い主のスナップショット（`rds:unplanned-global-failover-...`）から、失った書き込みを組織ごとに取り出して知らせる。自動で書き戻さない。
- 訓練：staging で四半期に 1 回の failover、本番で年 1 回の switchover。

### 7.2 論理的な破損

- 誤ったマイグレーション・操作での破損は、PITR で別のクラスタに戻し、組織・表・ID の範囲を選んで取り出す。組織の全体を戻す時は、組織の移動（6 節）の道具で、戻したクラスタから元のクラスタへ写す（書き込みの止めの間に差し替える）。

## 8. Terraform の構成

```
infra/
├── global/            … Organizations、SCP、IAM Identity Center、Route 53、ECR、CI の OIDC
├── edge/              … CloudFront、WAF、ACM
├── log-archive/       … CloudTrail、Config、audit-archive（Object Lock）
├── cells/
│   ├── cells.yaml     … セルの一覧（id、アカウント、リージョン、クラスタの一覧）
│   └── modules/
│       ├── network/   … VPC、サブネット、エンドポイント、Network Firewall
│       ├── data/      … Aurora（主・events・history、Global Database）、Valkey、OpenSearch、S3
│       ├── keys/      … KMS の鍵（セル × 用途、マルチリージョン）
│       ├── services/  … ECS のサービス、タスク定義（code-runner を含む）、IAM
│       └── egress/    … prod-egress の VPC、NAT、sender、SQS
└── envs/{dev,staging,prod}/
```

- セルを足すのは、`cells.yaml` に 1 行を足すことで行う。
- `keys/`、`network/` の IAM・SCP・セキュリティグループは `security:sensitive`（[ADR-0062](../decisions/0062-security-sensitive-change-flow.md)）。
- DB のスキーマのマイグレーションは Terraform でなく、開発リポジトリのマイグレーションの道具で行う（[delivery.md](delivery.md) の 5 節）。
- IaC の検査（CI）：prod-egress に prod への経路がない（受け渡しは prod-egress の SQS への `SendMessage` だけ）、`admin_cross_org` の資格情報を `cross-org-worker` 以外が読めない、`code-runner` のコンテナに資格情報がない、全ての Aurora に暗号化と `rds.force_ssl`。

## 9. コストの概算（S1、本番、1 か月）

**大まかな見積もりである。** ±50% の幅。データ転送、ログの量、サポートプラン、税は含めない。単価は、AWS の Price List API で 2026-09-28 に確かめた東京のオンデマンドの値（[AWS Price List API](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonRDS/current/ap-northeast-1/index.json) ほか同じ形の AmazonES の価格表。Valkey と Fargate は [servicenow の infrastructure.md](../../../servicenow/docs/architecture/infrastructure.md) の 10 節の同じ日の値）：Aurora PostgreSQL I/O-Optimized `db.r8g.8xlarge` 1 時間 6.928 USD・`db.r8g.4xlarge` 3.464 USD・`db.r8g.xlarge` 0.866 USD、Standard `db.r8g.xlarge` 0.666 USD、保存 1 GB 月 I/O-Optimized 0.27 USD・Standard 0.12 USD、Standard の I/O 100 万回 0.24 USD、OpenSearch `r7g.2xlarge.search` 0.858 USD・`r7g.xlarge.search` 0.429 USD・`m7g.large.search` 0.175 USD、Valkey `cache.r7g.large` 0.2104 USD、Fargate ARM vCPU 1 時間 0.04045 USD・メモリー 1 GB 1 時間 0.00442 USD。大阪は東京とほぼ同じ（`db.r8g.4xlarge` 3.456 USD、`db.r8g.xlarge` 0.864 USD、保存は同じ、`r7g.2xlarge.search` 0.85789 USD）なので、同じ単価と置いた。

| 項目 | 月額（USD、概算） |
| --- | --- |
| 主の Aurora（writer 8xlarge＋reader 4xlarge × 2＋大阪 4xlarge × 1） | 12,600 |
| 主の Aurora の保存（約 2.5TB、I/O-Optimized、東京と大阪の 2 つ分） | 1,400 |
| `events` の Aurora（xlarge × 2＋大阪 × 1、約 130GB） | 2,000 |
| `history` の Aurora（Standard で計算：xlarge × 2＋大阪 × 1 で約 1,460、18 か月で約 3.5TB の保存が東京と大阪で約 860、I/O は仮に月 20 億回で約 500。I/O は E11 で測る） | 2,800 |
| OpenSearch（データ `r7g.2xlarge` × 6＋マスター 3＋gp3 3TB、大阪の小さなドメイン） | 4,800 |
| ElastiCache（Valkey 6 ノード、大阪の小さなクラスタ） | 1,300 |
| ECS Fargate（東京 平均 約 130 vCPU、大阪の待機 約 15 vCPU、vCPU あたり 2GB） | 5,100 |
| CloudFront、WAF、ALB、データ転送 | 3,000 |
| NAT、Network Firewall（prod と prod-egress、東京と大阪） | 4,000 |
| SES（送信 月 約 1,000 万通） | 1,000 |
| S3（組織のファイル、複製）、バックアップ、log-archive | 1,500 |
| 可観測性（ログ、メトリクス、トレース、Grafana） | 3,000 |
| GuardDuty、Security Hub、Inspector、Config、CloudTrail | 1,500 |
| KMS、Secrets Manager | 500 |
| **本番の合計** | **約 44,500** |
| staging・dev・shared・edge・security | 約 8,000 |

- 最も大きいのは Aurora（約半分）。Savings Plans とリザーブドインスタンスで 20〜30% 下げられる。
- 利用者 5 万人で割ると、1 人あたり月 約 0.9 USD（本番の基盤だけ）。
- 費用は、アカウント（セル）とタグ（`cell`、`service`、`env`）ごとに毎月見る。組織ごとの費用の配分は、組織の DB の時間（[ADR-0058](../decisions/0058-slis-and-per-org-resource-metrics.md)）と保存の量で按分する。
- 項目の変更の履歴は、保存の量の半分以上になる（[capacity.md](capacity.md) の 3 節）ので、S1 から `history` のクラスタに置いた（4.3 節）。費用は上の表の `history` の行。
- 2026-09-28 の見直し：OpenSearch を 3 台から 6 台（`r7g.2xlarge`）に、履歴を別のクラスタに改め、合計を約 40,000 から約 44,000 USD に直した。同じ日に、仮に置いていた単価（`db.r8g.8xlarge`・`db.r8g.xlarge`・`r7g.2xlarge.search`・Aurora の保存）を Price List API で確かめ、保存を東京と大阪の 2 つ分で数え直して、主の保存を 1,100 から 1,400、`history` を 2,600 から 2,800、合計を約 44,500 USD に直した。

## 10. 障害のとき

| 事象 | 振る舞い |
| --- | --- |
| 1 つの AZ の障害 | Aurora の writer の切り替え（数十秒の書き込みの失敗）、ECS は残る 2 AZ で |
| 主の Aurora の writer の再起動 | 書き込みが 503（`Retry-After`）。読みは reader で続く画面がある（レポート） |
| `events` のクラスタの障害 | Relay は outbox に残して待つ。保存は止めない |
| `history` のクラスタの障害 | 同じく outbox に残して待つ。保存は止めない。履歴の画面・API・レポートは 503 |
| OpenSearch の障害 | 検索は `degraded`（名前の前方一致） |
| Valkey の障害 | L3 から作る。割り当ては fail open |
| prod-egress の障害 | 送信は SQS に残り、再試行。72 時間で宛先が `disabled` になる前に復旧させる |
| KMS（東京）の障害 | 平文の DEK のキャッシュ（5 分）で続け、切れたら組織のファイル・秘密を使う操作だけ 503 |
| リージョンの障害 | 7 節 |

## 11. この領域の ADR

| ADR | 決定 |
| --- | --- |
| [0054](../decisions/0054-accounts-network-and-service-separation.md) | アカウントを管理・監査・本番・送信で分け、本番の VPC の中で対話・管理・一括・Worker・コードの実行を別のサービスとロールにする。送信の VPC と監査のアカウントは本体への経路を持たない |
| [0055](../decisions/0055-shard-placement-and-stage-criteria.md) | 論理シャードを物理のクラスタに表で割り当て、組織ごとの上書きを持つ。段階を上げる基準を writer の CPU・保存の量・最大の組織の大きさで決める |
| [0056](../decisions/0056-org-migration-by-row-filtered-logical-replication.md) | 組織の移動は `org_id` の行の絞りを付けた論理レプリケーションで写して追いつき、数十秒の書き込みの止めの間に照合して置き場所を切り替える |
| [0057](../decisions/0057-disaster-recovery-osaka-warm-standby.md) | 大阪に Aurora Global Database の副と縮めた ECS を置く温かい待機にし、検索の索引と Valkey は切り替えの後に作り直す。切り替えは人が決める |

他の領域への依頼：

- data-storage の領域：`shard_map` に加えて `org_placements` を置き場所の解決に使う（4.1 節）。組織の移動の間の `migrating` の状態を、整合の検査が飛ばす。
- orgs-users-and-auth の領域：`orgs.status` に補助の状態 `migrating` を足す（503 `ORG_MIGRATING`）。
- events-and-integrations の領域：送信の VPC を prod-egress のアカウントに置き、SQS で受け渡す（2.2 節）。ADR-0035 の「送信の VPC」をこの形に読む。（2026-09-28 に反映済み：events-and-integrations.md の 6.3 節、ADR-0035 の注記）
- governor-limits の領域：組織の移動の間の割り当ての数の作り直し（fail open の範囲）。

## 12. Story の候補

| Epic | Story の候補 |
| --- | --- |
| E1 | アカウント（Organizations、SCP）、log-archive（Object Lock）、IAM Identity Center |
| E1 | prod の VPC、エンドポイント、Network Firewall、ALB と CloudFront の秘密のヘッダー |
| E1 | 主の Aurora（256 の分割、RLS、パラメーター）、`events` と `history` のクラスタ、Global Database の副 |
| E1 | ECS のサービスとロール（`admin_cross_org` の分離）、Terraform の `cells.yaml` |
| E1 | OpenSearch のドメインと Valkey |
| E8 | prod-egress のアカウント、`sender`、SQS の受け渡し、Elastic IP の公開 |
| E12 | 組織の移動の道具（論理レプリケーション、止め、照合、切り替え） |
| E12 | DR の訓練（staging の failover、本番の switchover）と、失った範囲の取り出し |
| E12 | コストのタグと組織ごとの配分 |
| S2 の前 | 主のクラスタの分割（論理シャードの単位）、Sandbox と試用の別のクラスタ |
| E13 | `code-runner` のコンテナ（タスク定義、IaC の検査） |

## 13. 未解決の問い

- RDS Proxy を使うか（`SET LOCAL` とアドバイザリロックでの接続の固定の扱い）。
- 論理レプリケーションの初期の同期が、大きな組織で元の writer の I/O を使いすぎないか。
- S3 のセルで、東京と大阪の両方で受ける形（組織ごとの書き手のリージョン）に進むか。
- 大阪の OpenSearch を空で置く方針で、切り替えの後の検索の質の低下（数時間）を受け入れられるか。
- 本家の組織の移動の読むだけの時間（未検証。公開の資料にない）と比べて、止めの 60 秒は十分か。
- `control` の DB（`shard_map`・`org_placements`・`orgs` の解決）を S3 でどのリージョンに置くか。

### 決定

2026-09-28 の既定案。

- RDS Proxy は使わない。E1 で接続の数を測り、足りなくなったら PgBouncer（トランザクションのプール）を別の ADR で検討する。
- 初期の同期は夜間に行い、元の writer の CPU が 60% を超えたら購読を一時止める。E12 で 5,000 万件の組織で測る。
- S3 は、まず東京のセルを増やし、両方のリージョンで受ける形は S3 の着手の前に別の ADR で決める。
- 大阪の OpenSearch は空で置く。作り直しの順（有料の本番、ライセンスの多い順）で質の低下を抑える。
- 止めは 60 秒を目標にする。移動は夜間の時間帯に、組織の管理者へ 7 日前に知らせて行う。
- `control` の DB は東京に置き、Global Database で大阪に写す。

## 14. quality.md・runbooks・data-model に載せるもの

**quality.md**

- リスク：組織の移動での写し漏れ・二重の書き込み。照合と性質ベーステスト（ADR-0056）。
- リスク：リージョンの障害での書き込みの喪失。訓練と、失った範囲の取り出しの手順。
- 本番での検証：`AuroraGlobalDBRPOLag` の p99、訓練の RTO、IaC の検査の結果。

**runbooks**

- [deploy-and-rollback.md](../runbooks/deploy-and-rollback.md)、[disaster-recovery.md](../runbooks/disaster-recovery.md)。
- `org-migration`：組織の移動の手順（6 節）と中止。
- `cluster-split`：論理シャードの単位での主のクラスタの分割。
- `egress-ip-change`：送信元の IP を変える時の 30 日前の知らせ（events-and-integrations の依頼）。
- `kms-outage`：KMS の障害の時の縮退。
- SLI の追加の依頼（Ops へ）：段階の基準の値（5 節）、`AuroraGlobalDBRPOLag`、論理レプリケーションの遅れ（移動の間）、NAT の送信のエラー。

**data-model**

| テーブル | 主な列 | 備考 |
| --- | --- | --- |
| `shard_map` | `shard_no`、`cluster_id`、`state`（`active`・`moving`） | RLS の外（運用）。data-storage の表 |
| `org_placements` | `org_id`、`cell_id`、`cluster_id`、`moved_at`、`reason` | RLS の外（運用）。ADR-0055 |
| `clusters` | `cluster_id`、`cell_id`、`kind`（`main`・`events`・`history`・`control`）、`writer_endpoint`、`reader_endpoint`、`purpose`（`prod`・`nonprod`・`dedicated`） | RLS の外 |
| `org_migrations` | `migration_id`、`org_id`、`from_cluster_id`、`to_cluster_id`、`state`（`copying`・`catching_up`・`fenced`・`verifying`・`switched`・`aborted`）、`fence_started_at`、`fence_ms`、`verify_result`、`requested_by` | RLS の外。監査にも写す |

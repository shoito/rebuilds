# Infrastructure: Linear

AWS 上の構成、アカウント、ネットワーク、入口（長く続く WebSocket を含む）、サービスの分け方と配置（Sync Gateway、Writer、Relay、Worker）、OpenSearch、冗長化、災害復旧（`sync_epoch` の引き上げ）、段階を上げる基準、S2 のワークスペースのシャード、S3 のセルとリージョン、Terraform、コスト。他の題材（Slack・Auth0 の infrastructure.md）を土台にし、同期エンジンに固有の事情だけを変える（[ADR-0001](../decisions/0001-platform-and-stack.md)）。

| 対象 | 決定 |
| --- | --- |
| アカウント、ネットワーク、入口、サービスの配置 | [ADR-0049](../decisions/0049-accounts-network-and-service-placement.md) |
| DR と `sync_epoch` の引き上げ | [ADR-0050](../decisions/0050-disaster-recovery-and-sync-epoch-bump.md) |
| DR での権限を狭める操作のやり直し | [ADR-0058](../decisions/0058-dr-permission-narrowing-journal.md) |
| S2 のワークスペースのシャード、S3 のセルとリージョン | [ADR-0051](../decisions/0051-workspace-sharding-and-cells.md) |
| 1 ワークスペースの書き込みの割り当て | [ADR-0054](../decisions/0054-per-workspace-write-admission.md) |
| IaC、デプロイの方式、可観測性の道具 | 他の題材（Slack の ADR-0020・0022・0021）を引き継ぐ |

ログ・メトリクス・SLI は [observability.md](observability.md)、負荷と台数の根拠は [capacity.md](capacity.md)、CI とリリースは [delivery.md](delivery.md)、統制と暗号化は [security.md](security.md) にある。

数値のうち「初期見積もり」と書いたものは、E12 の負荷試験の前の仮の値である。AWS の仕様で確かめていないものは「未検証」と書く。

## 1. AWS アカウントの構成

ADR-0049。Auth0 の題材と同じ形にする。

| アカウント | OU | 中身 |
| --- | --- | --- |
| management | Root | Organizations、SCP、IAM Identity Center、請求 |
| security | Security | GuardDuty・Security Hub・Inspector の委任管理者、調査用のロール |
| log-archive | Security | 組織の CloudTrail、Config、VPC フローログ、監査ログの写し（[security.md](security.md) の 6 節）。Object Lock。東京 → 大阪へレプリケーション |
| shared | Infrastructure | ECR（東京・大阪にレプリケーション）、Route 53（`<brand>.<domain>`）、Managed Grafana、CI の起点、Terraform の状態のバケット、コード署名の鍵（[delivery.md](delivery.md) の 6 節） |
| edge | Infrastructure | CloudFront、WAF、ACM（us-east-1）、CloudFront のログ |
| dev、staging | Workloads/NonProd | 開発・検証。staging は本番と同じ構成を最小の台数で持ち、負荷試験の時だけ本番と同じ台数に広げる |
| prod | Workloads/Prod | 本番（東京と大阪） |

- **SCP**（Workloads の OU）：東京・大阪以外のリージョンを禁止する（CloudFront・WAF・ACM・IAM のための us-east-1 のグローバルなサービスを除く）。データの所在は法務の L4 で確定する（[security.md](security.md) の 13 節）。CloudTrail・Config・GuardDuty の停止、KMS の鍵の削除の予約・無効化を、break-glass のロール以外に禁止する。
- S3 のセル構成では、セルごとに prod のアカウントを持つ（10 節）。

## 2. ネットワーク

### 2.1 prod の VPC（東京・大阪で同じ形）

3 AZ にまたがる VPC を 1 つ持つ。

| サブネット | 置くもの | インターネットへの経路 |
| --- | --- | --- |
| public | ALB（`alb-app`、`alb-api`）、NAT ゲートウェイ | Internet Gateway |
| private | `auth`、`sync-api`、`gateway`、`writer`、`public-api`、`relay`、`worker-*`（外向きの決まった宛先を除く） | NAT 経由。Network Firewall で宛先を許可リストに限る（GitHub、gitlab.com、Slack、Google、メールの送信事業者、インポートの元の決まった宛先） |
| egress | `worker-egress`（Webhook の送り、自前の GitLab、Jira のサイト、添付の取り出し） | 専用の NAT（Elastic IP を公開する）。本体の VPC エンドポイントと DB への経路を持たない |
| isolated | Aurora、ElastiCache（Valkey）、OpenSearch | なし |

- DynamoDB（`narrowing_journal`。6.3 節）は VPC の外のサービスで、DynamoDB のゲートウェイの VPC エンドポイントから使う。

- 入口は CloudFront → ALB だけ。ALB のセキュリティグループは CloudFront のマネージドプレフィックスリストだけを許し、CloudFront が付ける秘密のヘッダーを ALB のリスナーの規則で確かめる（Auth0 の題材と同じ）。
- VPC エンドポイント：S3、DynamoDB、ECR、SQS、KMS、Secrets Manager、CloudWatch Logs、STS、X-Ray、AppConfig。
- セキュリティグループはサービスごとに入る側と出る側を明示する。`writer` へ入れるのは `gateway`・`public-api`・`worker-*`（内部の HTTP/2）だけ。`worker-egress` から `writer` へは SQS を経る（直接の経路を持たない）。

### 2.2 入口とホスト名

| ホスト名 | CloudFront のビヘイビア | オリジン |
| --- | --- | --- |
| `<brand>.<domain>` | 既定：アプリの殻（ハッシュ付きの資産、`index.html`、Service Worker） | S3（静的） |
| 同 | `/api/auth/*`、`/login*`、`/oauth/authorize`、`/api/desktop/*` | `alb-app` → `auth`（`/oauth/authorize` は `public-api`） |
| 同 | `/sync/*`（ブートストラップ、取り戻し、遅延の読み込み、チケット、問い合わせ）、`/files/*`、`/exports/*` | `alb-app` → `sync-api` |
| 同 | `/sync/ws`（WebSocket） | `alb-app` → `gateway` |
| `api.<brand>.<domain>` | `/graphql`、`/oauth/*`、`/hooks/*`（連携の受け口） | `alb-api` → `public-api` |
| `<brand>usercontent.<domain>` | 添付の署名付きの URL | S3（添付。OAC） |
| `update.<brand>.<domain>` | Electron の更新の案内と配布物 | `alb-api` → `public-api`（案内）、S3（配布物）（[delivery.md](delivery.md) の 6 節） |

- **WebSocket も CloudFront を通す**（ADR-0049）。CloudFront は WebSocket を HTTP/1.1 で扱い、オリジンのリクエストポリシーで `Sec-WebSocket-Key`・`Sec-WebSocket-Version`（と `-Protocol`・`-Accept`・`-Extensions`）を転送する（[Use WebSockets with CloudFront distributions](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/distribution-working-with.websockets.html)、2026-09-28 に確認）。CloudFront はオリジンからクライアントへ 10 分流れない接続を切る。WebSocket の同時の接続の数の上限はなく、配信ごとの 1 秒 25 万の要求と 150 Gbps が上限になる（[CloudFront quotas](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html)、2026-09-28 に確認）。Gateway は 20 秒ごとに ping のフレームを送る（[sync-engine.md](sync-engine.md) の 9.6 節）ので当たらない。
- ALB のアイドルの時間切れは 120 秒（既定 60 秒、1〜4,000 秒で設定できる。[Edit attributes for your Application Load Balancer](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-load-balancer-attributes.html)、2026-09-28 に確認）。Gateway の ping（20 秒）より十分長く、アプリのアイドルの時間切れをそれより長くする（同じ文書の勧め）。
- ALB の HTTP のクライアントの keepalive の期間（既定 1 時間、60 秒〜7 日）は、期間を過ぎた後の次の要求の応答で接続を閉じる仕組みである（HTTP/1.1 は `Connection: close`、HTTP/2 は `GOAWAY`。[Edit attributes for your Application Load Balancer](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-load-balancer-attributes.html)、2026-09-28 に確認）。昇格した後の WebSocket には次の要求がないので当たらないと見込むが、文書に書かれていない（**未検証**。E1 の `edge-and-websocket-origin` で確かめる）。当たるなら、Gateway の接続は 1 時間ごとに切れて再接続する。再接続は乱数の待ちと取り戻しで吸収できるが、AZ の切り離し（zonal shift）の後の戻りを速くする利点もあるので、既定のままにする。
- WAF：共通のルール、IP の評判、IP ごとのレート制限（`/api/auth/*` の送信は 5 分 300、`/sync/ticket` は 5 分 3,000、全体は 5 分 30,000）、`/hooks/*` は連携の相手の IP の一覧を使わず署名で確かめる（相手の IP は変わる）。値は E4・E12 で調整する。

### 2.3 外向きの送信

| 送信 | 経路 | 理由 |
| --- | --- | --- |
| Webhook の送り、自前の GitLab、Jira のサイト、添付の取り出し | egress のサブネットの `worker-egress` → 専用の NAT | 顧客の指定する宛先。SSRF の踏み台にしない（[api-and-webhooks.md](api-and-webhooks.md) の 5.6 節） |
| GitHub、gitlab.com、Slack、Asana、Shortcut、Google | private → NAT → Network Firewall（許可リスト） | 宛先が決まっている |
| メール（Amazon SES） | VPC エンドポイント | notifications-and-inbox の領域 |

## 3. ECS サービスと配置

ADR-0049。すべて Fargate（ARM64）。サービスごとにタスク定義と IAM ロールを分ける。

| サービス | 役割 | スケールの指標 | 最小（S1、東京） |
| --- | --- | --- | --- |
| `auth` | Better Auth、セッション、チケットの発行の前段（[accounts-and-auth.md](accounts-and-auth.md)） | CPU 50% | 3 |
| `sync-api` | ブートストラップ、取り戻し、遅延の読み込み、チケット、ビューの問い合わせ、検索、添付と書き出しの配り | 同時のブートストラップの数（目標 12/タスク）、CPU | 6 |
| `gateway` | WebSocket の終端、同期グループでの絞り込み、範囲の証明、`submit` を Writer へ | タスクあたりの接続の数（目標 3,000） | 12（AZ ごとに 4） |
| `writer` | トランザクションの検証・適用・`sync_id`（内部だけ） | CPU 50%、ロックの待ちでは増やさない（ワークスペースの直列は台数で解けない） | 6 |
| `public-api` | GraphQL、OAuth、連携の受け口、Electron の更新の案内 | CPU 50%、要求数 | 3 |
| `relay` | `sync_outbox` → Valkey、SQS | `sync_outbox` の最古の行の年齢 | 2（区画を分け合う） |
| `worker-*` | notifier、mailer、search-indexer、doc-compactor、webhook-fanout、integrations、scheduler（自動で閉じる・繰り越しなど）、import-commit、retention | キューの最古のメッセージの年齢。キューごとにサービスを分ける | キューごとに 1〜3 |
| `worker-egress` | webhook-send、import-fetch、GitLab の自前のホスト | 同上、同時の送信の数 | 4 |

### 3.1 Sync Gateway

- 接続はどのタスクにつないでもよい（スティッキーにしない）。Gateway は、接続のあるワークスペースの Valkey のチャンネル（`sync:<workspace_id>`）を購読し、ワークスペースの列の状態（`head`・`buffer`。[sync-engine.md](sync-engine.md) の 7.4 節）をタスクごとに持つ。
- 1 つのワークスペースの接続が多くのタスクに散ると、各タスクが同じ差分を受ける（Valkey の複製）。S1 はこれを受け入れる（[capacity.md](capacity.md) の 5.2 節）。S2 で、ワークスペースの ID で ALB の転送を寄せるか（パスにワークスペースの ID を入れ、CloudFront Functions で振る）を決める。
- デプロイ・縮小では、タスクの接続を 10 分かけて `kick: server_shutdown`（`retry_after_ms` は 0〜60 秒の乱数）で逃がす。ECS の登録解除の遅延は 15 分にする（[delivery.md](delivery.md) の 5 節）。
- Gateway から Writer への呼び出しは ECS Service Connect（HTTP/2、TLS）。Writer のタスクの選び方はラウンドロビン（ワークスペースの割り当てはしない。ADR-0006）。

### 3.2 Writer と Relay

- Writer は Aurora の writer のエンドポイントだけにつなぐ。Writer のタスクは 3 AZ に置き、Aurora の writer のある AZ との往復（1ms 前後の見込み。**未検証**。E2 の前の `writer-throughput-poc` で測る）を受け入れる。
- Relay は `hash(workspace_id) mod 64` の区画を持ち、区画の担当を Valkey の期限つきの鍵（10 秒、3 秒ごとに更新）で決める。担当が落ちたら、他のタスクが 10 秒以内に引き継ぐ（Slack の Relay と同じ考え方。[sync-engine.md](sync-engine.md) の 7.3 節）。Valkey が落ちている間は、区画を DB の勧告的ロック（`pg_try_advisory_lock`）で決める。

### 3.3 OpenSearch

- VPC の中の Amazon OpenSearch Service のドメイン（isolated のサブネット、3 AZ、専用のマスター）。保存時・ノードの間の暗号化、細かなアクセスの制御は IAM のロール（`search-indexer` と `sync-api`）だけ。
- 1 時間ごとの手動のスナップショットを S3 に取り、大阪へレプリケーションする（DR の索引の戻しに使う。6.3 節）。
- 索引の設計と更新の流れは [search.md](search.md) の 4・9 節。

### 3.4 AZ の障害への備え

- 各サービスは、残る 2 AZ で最大負荷をさばける台数を常に持つ。平常の使用率を 2/3 以下に保つ（[capacity.md](capacity.md) の 7 節）。
- Gateway の 1 AZ の喪失で 2 万接続が再接続する（[capacity.md](capacity.md) の 3.3 節）。残る AZ の Gateway は最小 8 で、オートスケールが追いつくまで 1 タスク 5,000 接続（上限）まで受ける。

## 4. データの置き場所（S1）

| 置き場所 | 中身 | 冗長 |
| --- | --- | --- |
| Aurora PostgreSQL 18（主） | モデルの表、`sync_actions`、`tx_results`、監査、連携・API の表、`auth` スキーマ | 3 AZ、Global Database で大阪へ |
| ElastiCache（Valkey） | 差分の pub/sub、チケット、セッションの写し、レート制限、書き込みの枠 | クラスタモード、レプリカ。失ってよい |
| OpenSearch | 検索の索引 | 3 AZ。スナップショット |
| S3 | 添付、インポートの段置き、書き出し、Web の資産、Electron の配布物、OpenSearch のスナップショット | 大阪へレプリケーション（添付・資産・配布物・スナップショット）。段置き・書き出しはしない（短命） |
| SQS | 通知、索引、Webhook、連携、インポートのキュー | 東京だけ。大阪は空のキュー（`sync_outbox` と `sync_actions` から作り直す） |
| DynamoDB | `narrowing_journal`（権限を狭める操作の追記だけの記録。6.3 節） | 東京の中は複数の AZ、大阪をレプリカにしたグローバルテーブル。PITR。35 日の TTL |

## 5. S1 の構成と台数（初期見積もり）

根拠は [capacity.md](capacity.md)。

| リソース | 構成 |
| --- | --- |
| Aurora PostgreSQL 18 | writer `db.r8g.4xlarge` × 1、reader 同型 × 2（別の AZ）。I/O-Optimized。大阪の Global Database の二次に reader 同型 × 1 |
| RDS Proxy | 使わない（`SET LOCAL` で接続が固定される。他の題材と同じ） |
| ElastiCache（Valkey） | `cache.r7g.large`、クラスタモード 3 シャード × （プライマリ 1＋レプリカ 1）。大阪は小さい別のクラスタ（空） |
| OpenSearch | データノード 3、専用のマスター 3。型は E8 の前の `search-poc` で決める |
| `gateway` | 2 vCPU / 4 GB × 20（ピーク）、最小 12、最大 60 |
| `sync-api` | 2 vCPU / 4 GB × 6〜12、DR の殺到の時は 60 まで |
| `writer` | 2 vCPU / 4 GB × 6〜24 |
| `public-api` | 1 vCPU / 2 GB × 3〜12 |
| `auth` | 1 vCPU / 2 GB × 3〜9 |
| `relay` | 0.5 vCPU / 1 GB × 2〜4 |
| `worker-*`、`worker-egress` | 0.5〜1 vCPU × 計 25（最大 80） |
| NAT ゲートウェイ | private × 3、egress × 3（東京）。大阪も同じ |
| Network Firewall | private の外向きに 3 AZ |
| DynamoDB | `narrowing_journal`、オンデマンド。狭める操作は 1 秒に数件の見込み |
| 大阪（ウォームスタンバイ） | 各サービスを最小 1〜2 タスク、Aurora の二次に reader 1 台、Valkey は小さい別のクラスタ、`narrowing_journal` のレプリカ、OpenSearch は置かない（6.3 節） |

## 6. バックアップと災害復旧

ADR-0050。

### 6.1 バックアップ

| 対象 | 方法 | 保持 |
| --- | --- | --- |
| Aurora | 自動バックアップ（PITR）＋ AWS Backup の連続バックアップ。Vault Lock | 35 日（削除の最終の期限。[ADR-0048](../decisions/0048-data-lifecycle-and-workspace-deletion.md)） |
| S3（添付） | バージョニング、大阪へレプリケーション。消した版は 30 日で消える | 30 日 |
| OpenSearch | 1 時間ごとのスナップショット（大阪へ） | 7 日 |
| Valkey、SQS | バックアップしない | 失ってよい |

### 6.2 AZ の障害（NFR-007：RPO 0、RTO 5 分）

| 部品 | 動き | 目安 |
| --- | --- | --- |
| Aurora | 別の AZ の reader へ自動でフェイルオーバー。コミット済みを失わない | 通常 60 秒未満（他の題材で確認） |
| フェイルオーバーの間 | Writer は `retry` を返す。クライアントは outbox に貯め、手元で読み書きを続ける（NFR-006） | 数十秒 |
| Gateway | その AZ の接続が切れ、残る AZ へ再接続 | 数十秒 |
| ECS | 残る AZ でタスクを起動し直す | 数分 |
| Valkey | レプリカの昇格。その間、Gateway は reader から欠けを埋め、書き込みの枠はメモリーの近似 | 数十秒 |

### 6.3 リージョンの障害（NFR-007：RPO 1 分、RTO 1 時間）

S1 から大阪に**ウォームスタンバイ**を持つ。切り替えは人の判断で行い、手順はワークフローで自動化する。手順は [runbooks/disaster-recovery.md](../runbooks/disaster-recovery.md)。

- 事実（いずれも 2026-09-28 に確認。[Using switchover or failover in Amazon Aurora Global Database](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-global-database-disaster-recovery.html)）：
  - 計画外のフェイルオーバー（`failover-global-cluster --allow-data-loss`）は、複製の遅延ぶんを失いうる。RPO は通常は秒の単位。switchover は RPO 0。
  - 古い一次の書き込みを止める write fencing は最善努力で、スプリットブレインの余地がある。先にアプリの書き込みを止めることが勧められている。
  - 古い一次の障害の時点のスナップショット（`rds:unplanned-global-failover-…`）が取れることがあり、保持の期間で消えるので、手動のスナップショットにコピーする。
  - グローバルの writer のエンドポイントを使い、DNS のキャッシュを 5 秒程度に下げることが勧められている。
  - `rds.global_db_rpo`（20 秒以上）を設定すると、二次がすべて遅れた時に一次のコミットを止める。2 リージョンだけなら、二次の側は既定のままを勧める。
- **`rds.global_db_rpo` は設定しない**。`AuroraGlobalDBRPOLag` が 10 秒を超えたら呼び出す（Auth0 の題材と同じ）。
- **`sync_epoch` を必ず上げる**（ADR-0050、[ADR-0013](../decisions/0013-sync-group-changes-retention-and-reset.md)）。大阪を昇格させた後、書き込みを受ける前に、全ワークスペースの `workspace_sync.sync_epoch` を 1 つ上げる（`platform` のロールの 1 つのジョブ。ワークスペースの ID の範囲ごとに分けて、合計 数十秒）。失った範囲の `sync_id` が、大阪で別の変更に振り直されるため。
  - 上げる前に受けた書き込みは 0 にする（Writer は起動の時に `ops.writes_enabled = false` のまま待つ）。
  - 全クライアントは握手で `reset`（`epoch`）になり、確定から 15 分以内の outbox（`done`）も送り直す。失った変更は 1 回だけ当たり、生き残った変更は `tx_results` で前の結果が返る（[bootstrap-and-partial-sync.md](bootstrap-and-partial-sync.md) の 8.3 節）。
  - やり直しの殺到の構成の広げ方は [capacity.md](capacity.md) の 4.2 節。
- **失った範囲の権限を狭める操作**（[ADR-0058](../decisions/0058-dr-permission-narrowing-journal.md)）：停止・除外・ロールの引き下げ・非公開への切り替え・脱退・セッションとトークンの取り消し・ログインの制限の強化が失った範囲に入ると、大阪で権限が戻る。そのまま書き込みを受けると、やり直しのブートストラップで、見てよくなくなったデータがその人の端末に届く（NFR-008 の破れ）。そこで、
  - Writer と認証のサービスは、これらの操作を確定したとき、同じトランザクションでサーバーだけの表 `narrowing_outbox` に書き、コミットの後、ack の前に DynamoDB の `narrowing_journal`（東京の中で複数の AZ に書く、追記だけの記録）へ写す。写せなかった行は Relay が 1 秒ごとに送る。`narrowing_journal` はグローバルテーブルで大阪へ非同期に複製する（遅延は `ReplicationLatency` で見る。既定の形（MREC）では、ふつう 1 秒以内に届く。[DynamoDB read consistency](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.ReadConsistency.html)、2026-09-28 に確認）。DynamoDB は 200 の応答の時点で書き込みを永続化しており、リージョンの中の 3 つの AZ に複製する（同じ文書、[Resilience and disaster recovery in Amazon DynamoDB](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/disaster-recovery-resiliency.html)、2026-09-28 に確認）。
  - 大阪の昇格のワークフローは、`sync_epoch` を上げた後、`ops.writes_enabled` を開く前に、大阪の `narrowing_journal` のうち失った範囲（東京が応答しなくなった時刻 − 直近の `AuroraGlobalDBRPOLag` − 5 分 から後）の記録を、`tx_results` になければやり直す（`ops.dr_replay_mode` の Writer のシステムのトランザクション）。やり直しが終わるまで入口を切り替えず、書き込みを受けない。
  - 残る窓は、`narrowing_journal` の大阪への複製の遅延と、コミットから記録までの数ミリ秒。権限を広げる操作は記録せず、失われたままにする（安全側）。
  - 性質の候補：**PROP-DR-001（狭める操作の保存）**：シミュレーターの DR の切り替え（最後の k 件を失う）で、`narrowing_journal` に届いた狭める操作は、大阪で書き込みを受ける前に効いており、対象の人の手元に見てよくない行が残らない。
- **失った範囲の外への影響**：失った範囲の変更で送られた Webhook・メール・Slack の通知・PR へのコメントは取り消せない。送り直しで同じ変更が再び確定すると、Webhook は新しい `syncId` で再び送られる（受け手は `<Brand>-Delivery` では重複を見分けられない）。この性質を公開 API の文書に書く。
- **検索**：大阪に OpenSearch を常に置かない。切り替えの後に、大阪で最新のスナップショットから戻し（数時間の見込み。**未検証**。E12 の `dr-drill` で測る）、数え直し（[search.md](search.md) の 9.4 節）で追いつかせる。その間、サーバーの検索は止め、画面は手元の検索だけにする（[search.md](search.md) の 10 節の縮退）。検索の RTO は 4 時間とする。
- **連携**：GitHub の事象は切り替えの間に失われる（GitHub は自動で再送しない）。切り替えの後、失った範囲の開始の時刻から後に更新された PR を読み直す（[integrations.md](integrations.md) の 7.2 節）。
- **東京へ戻す（フェイルバック）**：東京の回復の後、Aurora が東京を二次として加え直す。別の計画作業として switchover（RPO 0）で戻す。switchover では `sync_id` の番号が保たれるので、`sync_epoch` を上げない。

### 6.4 論理的な破損と、ワークスペースの戻し

- 1 つのワークスペースを差し替えで戻したときも、戻す時点より後の、そのワークスペースの `narrowing_journal` の記録をやり直す（ADR-0058）。
- 全体の破損（誤ったマイグレーション）：PITR で隔離した VPC に新しいクラスタを戻し、失われた行だけを戻す（他の題材と同じ）。本番のクラスタを上書きしない。戻した行は Writer のシステムのトランザクション（`origin = worker`）で書き、差分として配る。この形なら `sync_epoch` を上げない（番号は前へ進むだけ）。
- **1 つのワークスペースを時点へ戻す**（顧客の誤りの大量の削除の依頼など）：ワークスペースのモデルの表を PITR の写しから差し替える方式は、番号の意味を変えるので、**そのワークスペースの `sync_epoch` を必ず上げる**（ADR-0013、[runbooks/disaster-recovery.md](../runbooks/disaster-recovery.md) の場面 D）。可能なら、差し替えより、Writer のトランザクションで戻す（上と同じ）方を選ぶ。

### 6.5 大阪の待機の構成の確認

| 確認 | 頻度 |
| --- | --- |
| 大阪からの合成監視（大阪の ALB へ直接、監視用のワークスペースで読み取りの専用の握手とブートストラップ） | 1 分 |
| 大阪の Terraform の plan に差分がない | 日次 |
| ECR・Secrets Manager のレプリカ、KMS のマルチリージョンの鍵のレプリカ | 日次 |
| OpenSearch のスナップショットが大阪にある（最新が 2 時間以内） | 1 時間 |
| Fargate の vCPU のクォータが、大阪でも東京と同じ（DR の殺到の分を含む） | 月次 |

## 7. CI/CD と Terraform

### 7.1 CI/CD

他の題材と同じ（GitHub Actions、OIDC、1 回ビルドして同じイメージを昇格させる、prod は Ops の承認）。同期エンジンに固有の関門と、クライアントの配布は [delivery.md](delivery.md)。

```
main へのマージ ─▶ ビルド ─▶ shared の ECR ─▶ dev ─▶ staging（シミュレーター・E2E・k6）─▶ prod（Ops の承認）
Web の資産は S3 へ、Electron の配布物は署名して S3 へ（delivery の領域）
```

### 7.2 Terraform の配置

開発リポジトリの `infra/` に置く（Slack の ADR-0020）。状態ファイルは shared のバケット（東京、大阪へレプリケーション）。

| ルートモジュール | 中身 | 変更の承認 |
| --- | --- | --- |
| `org/` | Organizations、SCP、Identity Center | Ops の責任者＋セキュリティの担当 |
| `security/` | GuardDuty、Security Hub、Config、log-archive | 同上 |
| `global/edge` | CloudFront の配信（ビヘイビア、WebSocket のオリジンのリクエストポリシー）、WAF、ACM、Route 53。変数 `active_region` | Ops（WAF のルールは `security:sensitive`） |
| `regional/network` | VPC、サブネット、NAT、Network Firewall、VPC エンドポイント（東京・大阪で同じモジュールを 2 回） | Ops |
| `regional/data` | Aurora（Global Database）、Valkey、OpenSearch、S3、SQS、DynamoDB（`narrowing_journal` のグローバルテーブル） | Ops。状態を持つリソースの削除・置き換えは CI で拒否 |
| `regional/keys` | KMS の鍵（マルチリージョン）、キーポリシー | `security:sensitive` |
| `regional/services` | ECS のクラスタ、サービス、タスク定義、ALB、オートスケール、Service Connect | Ops |

- plan のポリシー検査（OPA・Checkov）で、次を拒否する。
  - isolated のサブネットの経路表に NAT・IGW
  - egress のサブネットから VPC エンドポイント・isolated への経路
  - `integration-secrets`・`webhook-secrets`・`import-secrets` の KMS の鍵の `kms:Decrypt` を、決めたロール以外に与える（[security.md](security.md) の 5.2 節）
  - ALB のアイドルの時間切れを Gateway の ping（20 秒）の 3 倍未満にする
  - Aurora のパラメーターに `rds.global_db_rpo` を置く

## 8. 環境とデータ

| 環境 | 目的 | データ |
| --- | --- | --- |
| local | 開発、エージェントの確認ループ | seed（本物のデータ・トークンを使わない。[AGENTS.md](../../AGENTS.md)） |
| dev | 結合の確認 | seed |
| staging | リリース前の確認、負荷・障害試験、DR の訓練 | 生成データ（ワークスペース 5,000、最大 2,000 人・イシュー 50 万を 3 つ） |
| prod | 本番 | 本番 |

- 本番のデータを本番のアカウントの外に出さない。匿名化したコピーも作らない（他の題材と同じ）。
- 合成監視のために、prod に社内の監視用のワークスペースを置く（[observability.md](observability.md) の 6 節）。

## 9. 段階を上げる判断の基準

次のどれかに当たり、戻らない見込みになったら、次の段階への移行を始める。移行に四半期ほどかかるので、上限の手前で始める。

| 指標 | S1 → S2 を始める目安 | S2 → S3 を始める目安 |
| --- | --- | --- |
| 書き込み（ピーク） | 900 変更/秒（S1 の 60%）を 2 週続けて超える | 9,000 変更/秒 |
| 同時の接続（ピーク） | 3.6 万 | 36 万 |
| Aurora の writer の CPU（ピークの p95） | 60% を超える、または 1 段上げても 6 か月もたない | シャードを増やしても最大のクラスで 60% を超える見込み |
| 1 ワークスペースの占有 | 1 つのワークスペースが書き込みの 20% を超え続ける、またはモデルが 500 万を超える | 専用のセルが要る大口の契約の見込み |
| `sync_actions` の量 | Aurora の容量・I/O の半分を超える | — |
| リージョンの切り替え | RTO 1 時間を、大口の顧客が契約で許さない | — |
| 可用性 | — | 1 回の障害で全ワークスペースが止まることが許されない |
| 海外の顧客 | — | 国外のリージョンに置く必要がある契約 |

## 10. S2 のシャードと S3 のセル

ADR-0051。

### 10.1 S2：ワークスペースを単位に Aurora のクラスタへ分ける

```
                ┌────────────────────────────────────────────┐
  各サービス ──▶ │ workspace_directory（ディレクトリのクラスタ）│  workspace_id → cluster_id、region、status
                └────────────────────────────────────────────┘
                     │ 60 秒の写しと、変更の知らせ（Valkey）
     ┌───────────────┼───────────────┬──────────────────┐
     ▼               ▼               ▼                  ▼
  shard-01        shard-02        shard-03          shard-big-01（大口専用）
  Aurora＋Relay   同じ             同じ               同じ
```

- **ワークスペースは 1 つのクラスタに閉じる。** `sync_id`・`sync_actions`・モデルの表・`tx_results` は、ワークスペースの中でだけ意味を持つので、クラスタをまたぐ処理がない（ADR-0002・0004 の分け方の利点）。
- `workspace_directory` とアカウント（`auth` スキーマ）は、小さなディレクトリのクラスタに置く（Global Database で大阪へ）。本家もアカウントを 1 つの場所に置き、ワークスペースをリージョンに固定する（[How we built multi-region support for Linear](https://linear.app/now/how-we-built-multi-region-support-for-linear)、2024-05-23。README の 1.3 節で確認済み）。
- 振り分け：Sync API・Gateway・Public API・Worker は、要求のワークスペースの ID から `workspace_directory` の写しでクラスタを引き、クラスタごとの接続のプールを使う。Writer・Relay はクラスタごとの設定で動く。
- **ワークスペースの移動**（大口を専用のクラスタへ）：
  1. 移動先のクラスタへ、ワークスペースの行（全部の表）を `workspace_id` で絞ってコピーし、`sync_actions` の新しい行を追いかける（論理レプリケーションか、`sync_actions` の再生。方式は S2 の着手の前に別の ADR で決める）。
  2. `workspace.status = moving` にし、Writer は `retry` を返す（書き込みを数秒止める。クライアントは outbox に貯める）。
  3. 追いついたら `workspace_directory` を切り替え、Gateway にそのワークスペースの接続を `kick: server_shutdown` で逃がさせる。
  4. `sync_id` と `sync_actions` はそのまま移るので、**`sync_epoch` を上げない**（ADR-0013）。クライアントは `resume`・`catch_up` で続ける。
- 検索は S2 で、大口のワークスペースを専用の索引へ移す（[search.md](search.md) の 3 節）。

### 10.2 S3：セルとリージョン

- スタック一式（Gateway・Sync API・Writer・Relay・Worker・Aurora・Valkey・OpenSearch・SQS）をセルとして複製し、**ワークスペースを 1 つのセルに固定する**。セルごとに主のリージョン（東京か大阪）を持ち、相手のリージョンに二次を持つ。
- **セルの外（Global）**：アカウントと認証（`auth`）、`workspace_directory`、課金の集計、Electron の更新の案内。
- **振り分け**：URL の `/<workspace-slug>/…`（画面）と、Sync API・Gateway の要求のワークスペースの ID から、CloudFront Functions と KeyValueStore でセルのオリジンを選ぶ（Slack の infrastructure.md の 10 節と同じ方式）。同期の経路に、セルを引く同期の依存を足さない。
- **リージョンの障害**では、止まったリージョンを主とするセルだけを切り替え、そのセルのワークスペースの `sync_epoch` だけを上げる。
- **海外のリージョン**（MVP の後）：本家と同じく、ワークスペースを作る時にリージョンを選び、変えない。セルをそのリージョンに置く。アカウントは日本の Global に置くか、法務の L4 で決める。

## 11. コストの概算（S1、本番、1 か月）

**大まかな見積もりである。** ±50% の幅。サポートプラン、税は含めない。次の単価は AWS Price List API で確かめた（2026-09-28。発行日 2026-09-16 の価格表）：Fargate の東京（Graviton：vCPU 1 時間 0.04045 USD・メモリー 1 GB 1 時間 0.00442 USD）、Aurora PostgreSQL の東京の `db.r8g.4xlarge`（I/O-Optimized 1 時間 3.464 USD）、CloudFront の日本からのデータ転送（下の注）。他の項目の単価は確かめていない（**未検証**。E12 の `cost-baseline` で請求の実績に置き換える）。Savings Plans とリザーブドインスタンスで 20〜30% 下げられる。

| 項目 | 月額（USD、概算） |
| --- | --- |
| Aurora（r8g.4xlarge × 3＋大阪 × 1、I/O-Optimized、ストレージ 約 1.2 TB、Global Database の複製） | 10,000 |
| ElastiCache（東京 6 ノード、大阪 2 ノード） | 1,500 |
| OpenSearch（データ 3、マスター 3、ストレージ 約 1 TB） | 3,000 |
| ECS Fargate（東京 平均 約 100 vCPU・200 GB、大阪の待機 約 15 vCPU） | 4,200 |
| **CloudFront のデータ転送（WebSocket の差分、ブートストラップ、資産、添付）** | **約 21,000（圧縮なし、230 TB）。permessage-deflate で約 6,000〜8,000 の見込み（60〜80 TB。圧縮の率は未検証）** |
| ALB、NAT、Network Firewall（東京と大阪） | 4,500 |
| 可観測性（ログ、メトリクス、トレース、Grafana、RUM の収集） | 2,500 |
| GuardDuty、Security Hub、Inspector、Config、CloudTrail、WAF | 2,000 |
| S3（添付、資産、配布物、スナップショット）、バックアップ、log-archive | 1,500 |
| SES、KMS、Secrets Manager、DynamoDB（`narrowing_journal`） | 500 |
| **本番の合計** | **約 51,000（圧縮で約 36,000〜38,000 の見込み）** |
| staging・dev・shared・edge・security | 約 7,000 |

- **データ転送が最大の不確かさである。** 差分の送信のピークを 30 万回/秒、1 回 約 1.5 KB（`update` は行の全体を運ぶ。ADR-0007）、平均をピークの 5 分の 1 と置くと、圧縮なしで月に 約 230 TB になる（[capacity.md](capacity.md) の 3.2 節）。CloudFront の日本からのデータ転送は、月の最初の 10 TB が 1 GB 0.114 USD、次の 40 TB が 0.089 USD、次の 100 TB が 0.086 USD、次の 350 TB が 0.084 USD（AWS Price List API の `AmazonCloudFront`、2026-09-28 に確認）。230 TB で約 20,500 USD、60〜80 TB で約 5,700〜7,500 USD になる。
- **決定（2026-09-28）**：差分の流れに permessage-deflate を使う（窓 4 KiB の文脈の持ち越し。[ADR-0009](../decisions/0009-sync-gateway-protocol.md) の注記、[sync-engine.md](sync-engine.md) の 9.1 節）。同じキーの行が続く JSON なので、3 分の 1〜4 分の 1（月に 約 60〜80 TB）になると見込む（**未検証**。E12 の `cost-baseline` で測る）。E12 の負荷試験（`cost-baseline`）で、圧縮の率と Gateway の CPU を測り、足りなければ (1) `update` を変わったフィールドだけにする（[sync-engine.md](sync-engine.md) の 14 節の持ち越し）、(2) 同じ `groups` の接続への送信のまとめ、を比べる。
- 費用は、アカウントとタグ（`service`、`env`）ごとに毎月見る。

## 12. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E1 | `aws-accounts-and-scp` | 1 節のアカウントと SCP |
| E1 | `vpc-and-subnets` | 2.1 節（egress を含む）、Network Firewall、VPC エンドポイント |
| E1 | `edge-and-websocket-origin` | 2.2 節の CloudFront の配信、WebSocket のオリジンのリクエストポリシー、ALB の時間切れ、WAF |
| E1 | `ecs-services-skeleton` | 3 節のサービス、Service Connect、タスクのロール |
| E1 | `terraform-root-modules` | 7.2 節とポリシー検査 |
| E1 | `osaka-warm-standby` | 5 節の大阪の骨格、Global Database、6.5 節の確認 |
| E2 | `relay-partition-lease` | 3.2 節の区画と担当 |
| E8 | `opensearch-domain` | 3.3 節（search と共同）、スナップショットの大阪への写し |
| E12 | `dr-failover-workflow` | 6.3 節のワークフロー（書き込みの停止、昇格、`sync_epoch` の引き上げ、狭める操作のやり直し、構成の広げ、入口の切り替え） |
| E4 | `narrowing-journal` | 6.3 節の `narrowing_outbox` と DynamoDB の `narrowing_journal`、Relay の送り直し（permissions-and-teams・accounts-and-auth と共同。ADR-0058） |
| E12 | `dr-narrowing-replay` | 6.3 節のやり直しのジョブと `ops.dr_replay_mode`、PROP-DR-001 |
| E12 | `dr-drill` | DR の訓練（staging 四半期、本番の switchover 年 1 回） |
| E12 | `workspace-pitr-restore` | 6.4 節のワークスペースの戻し |
| E12 | `cost-baseline` | 11 節の確定、データ転送と permessage-deflate の圧縮の率の測定 |

## 13. 未解決の問い

### 決定

2026-09-28 の既定案。E1 と E12 で覆りうる。

- **入口**：WebSocket も CloudFront → ALB（ADR-0049）。
- **Gateway**：スティッキーにしない、接続の数でスケール、10 分で逃がす（ADR-0049）。
- **DR**：ウォームスタンバイ、書き込みを止めてから昇格、全ワークスペースの `sync_epoch` を上げ、失った範囲の狭める操作をやり直してから受け付け、検索は 4 時間（ADR-0050、ADR-0058）。
- **データ転送**：差分の流れに permessage-deflate（ADR-0009 の注記）。E12 で測る。
- **S2・S3**：ワークスペースを単位のクラスタ、セル。アカウントとディレクトリは Global（ADR-0051）。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| ALB の HTTP のクライアントの keepalive の期間が WebSocket に当たるか | E1 の `edge-and-websocket-origin`（**未検証**） |
| Gateway の接続をワークスペースで寄せるか | S2 の着手の前。送信の量と Valkey の複製の量で決める |
| S2 のワークスペースの移動の方式（論理レプリケーションか、`sync_actions` の再生か） | S2 の着手の前に別の ADR |
| データ転送の量と費用、permessage-deflate の文脈の持ち越しの採否 | E12 の負荷試験 |
| OpenSearch の型と、大阪での戻しの時間 | E8 の前の `search-poc`、E12 の `dr-drill` |

## 14. quality.md・runbooks・data-model への項目

### quality.md

- DR の訓練（staging、四半期）で、切り替えの後に合成監視のクライアントが一致し（収束の監査）、直近の確定の送り直しが 1 回だけ当たることを、E12 の GA の判定の基準にする。
- 本番：`AuroraGlobalDBRPOLag`、大阪の合成監視の成功、OpenSearch のスナップショットの年齢。

### runbooks

- `disaster-recovery.md`（本工程で作る）。
- `deploy-and-rollback.md`（本工程で作る）。Gateway の逃がし方を含む。
- `workspace-move.md`（S2）：ワークスペースのクラスタの移動。

### data-model（索引への追加の提案）

| 表・置き場所 | 中身 | 節 |
| --- | --- | --- |
| `workspace_directory`（ディレクトリのクラスタ、RLS の外。S2 から） | ワークスペース → クラスタ・リージョン・状態 | 10.1 |
| `workspaces.status` に `moving` | 移動の間の書き込みの停止 | 10.1 |
| Valkey `relay:lease:<区画>` | Relay の区画の担当 | 3.2 |
| `narrowing_outbox`（サーバーだけ）、DynamoDB `narrowing_journal` | 権限を狭める操作の記録と、大阪への写し | 6.3 |
| S3 の OpenSearch のスナップショットのバケット | 大阪へ | 3.3 |

## 出典

いずれも 2026-09-28 に確認。

- AWS, [Use WebSockets with CloudFront distributions](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/distribution-working-with.websockets.html)
- AWS, [Edit attributes for your Application Load Balancer](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-load-balancer-attributes.html)
- AWS, [Using switchover or failover in Amazon Aurora Global Database](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-global-database-disaster-recovery.html)
- 他の題材の infrastructure.md（Slack、Auth0）から引き継いだ事実は、その文書の出典に従う。

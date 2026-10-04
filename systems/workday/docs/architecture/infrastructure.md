# Infrastructure: Workday

AWS の上の構成を決める。アカウント（保管庫のアカウントを含む）、ネットワーク、サービスの分け方、エッジ、台数、バックアップと災害復旧（支給日の DR を含む）、段階を上げる基準、S2 のクラスタの分割と S3 のセル、Terraform の配置、コストを扱う。他の題材（Slack・Stripe・Auth0 の infrastructure.md）を土台にし、この題材に固有の事情（保管庫、給与計算の集中、支給日の締め切り）だけを変える（[ADR-0001](../decisions/0001-platform-and-stack.md)）。

| ADR | 決定 |
| --- | --- |
| [0054](../decisions/0054-accounts-network-and-vault-boundary.md) | アカウントを management・security・log-archive・shared・edge・dev・staging・prod・vault-staging・vault-prod に分ける。保管庫と人事の側は PrivateLink の片方向の経路だけでつなぐ。Payroll Compute は DB への経路を持たないサブネットに置く |
| [0055](../decisions/0055-disaster-recovery-and-payday-continuity.md) | 大阪にウォームスタンバイを持つ。リージョンの切り替えは支払の経路（給与の担当の画面、振込ファイル）を先に戻す。支給日の前の 5 営業日は、大阪で振込ファイルを複製のデータから作り直してハッシュが一致することを毎日確かめる |
| [0056](../decisions/0056-stages-cluster-sharding-and-cells.md) | S1 は 1 つの Aurora のクラスタ。S2 はテナントの対応表で Aurora のクラスタを分け、大口のテナントを専用のクラスタにする。S3 は保管庫を含むスタック一式のセルにし、テナントをセルに固定する |
| [0057](../decisions/0057-vault-delivery-separation.md) | 保管庫の Terraform の状態・デプロイのパイプライン・承認者・デプロイの日を、人事の側と分ける |

ログ・メトリクス・SLI は [observability.md](observability.md)、負荷と台数の根拠は [capacity.md](capacity.md)、CI とリリースは [delivery.md](delivery.md)、統制と鍵は [security.md](security.md)、保管庫の中身は [my-number-vault.md](my-number-vault.md) にある。数値のうち「初期見積もり」と書いたものは、E12 の負荷試験の前の仮の値である。

## 1. AWS アカウントの構成（[ADR-0054](../decisions/0054-accounts-network-and-vault-boundary.md)）

| アカウント | OU | 中身 |
| --- | --- | --- |
| management | Root | Organizations、SCP、IAM Identity Center、請求 |
| security | Security | GuardDuty・Security Hub・Inspector の委任管理者、調査用のロール |
| log-archive | Security | 組織の CloudTrail、Config、VPC フローログ、監査ログのセグメントと日の署名（[audit-and-retention.md](audit-and-retention.md) の 4 節）、保管庫の記録（専用の接頭辞）、規則表の元のファイル。Object Lock。東京 → 大阪へ複製 |
| shared | Infrastructure | ECR（東京・大阪に複製）、Route 53（`<brand>.<domain>`）、Managed Grafana、CI の起点、人事の側の Terraform の状態 |
| edge | Infrastructure | 人事の側の CloudFront と WAF、ACM（us-east-1） |
| dev、staging | Workloads/NonProd | 開発・検証。staging は本番と同じ構成を最小の台数で持つ |
| prod | Workloads/Prod | 本番（東京と大阪）。API、BP Worker、Worker、Relay、Payroll Compute、Loader、egress Worker、audit-archiver、Aurora、Valkey、SQS、S3 |
| vault-staging | Workloads/Vault | 保管庫の検証 |
| vault-prod | Workloads/Vault | 保管庫の本番（東京と大阪）。vault-web、vault-api、vault-docgen、専用の Aurora・S3・KMS・CloudFront・WAF・Private CA・Terraform の状態 |

- **SCP**：
  - 東京・大阪以外のリージョンを禁止する（CloudFront・WAF・ACM・IAM の us-east-1 を除く）。データは国内に置く（[intent.md](../intent.md) の Constraints）。
  - CloudTrail・Config・GuardDuty の停止、KMS の鍵の削除の予約・無効化・キーポリシーの変更を、break-glass のロール以外に禁止する。
  - Workloads/Vault の OU：保管庫の鍵（`vault-mn` など）の `kms:Decrypt` を、保管庫のタスクのロール以外のすべての主体（人のロール、break-glass を含む）に禁止する（[ADR-0053](../decisions/0053-operator-access-and-vault-break-glass.md)）。ECS Exec を禁止する。インターネットゲートウェイ・NAT ゲートウェイの作成を、vault-web の public サブネット以外で禁止する。
- S2 で、分析用の基盤を prod の中に置くか別のアカウントにするかを決める（[reporting.md](reporting.md) の 14 節）。
- S3 のセル構成では、セルごとに prod と vault-prod のアカウントを持つ（9 節）。

## 2. ネットワーク

### 2.1 prod の VPC（東京・大阪で同じ形）

| サブネット | 置くもの | 外への経路 |
| --- | --- | --- |
| public | ALB、NAT ゲートウェイ | Internet Gateway |
| private | API、BP Worker、Worker、Relay、Loader、audit-archiver | NAT 経由。Network Firewall で宛先を許可リストに限る（メールの送信、祝日の暦の取得など） |
| payroll | Payroll Compute | **なし**。VPC エンドポイント（S3、SQS、ECR、CloudWatch Logs、KMS、STS、X-Ray）だけ。**Aurora・Valkey への経路もない**（セキュリティグループで拒む。[ADR-0004](../decisions/0004-payroll-engine.md) の「DB を直接は読まない」を網で守る） |
| egress | egress Worker（Webhook、テナントの IdP のメタデータ・JWKS の取得） | 専用の NAT。本体の VPC エンドポイントと DB への経路を持たない |
| isolated | Aurora、ElastiCache（Valkey） | なし |
| vault-link | 保管庫の vault-api への VPC エンドポイント（PrivateLink） | — |

- 入口は CloudFront → ALB だけ。ALB のセキュリティグループは CloudFront のマネージドプレフィックスリストに限り、秘密のヘッダーを検査する。
- VPC エンドポイント：S3、ECR、SQS、KMS、Secrets Manager、CloudWatch Logs、STS、X-Ray、AppConfig、Private CA。

### 2.2 vault-prod の VPC

| サブネット | 置くもの | 外への経路 |
| --- | --- | --- |
| public | vault-web の ALB（CloudFront からだけ） | Internet Gateway（ALB の入口だけ。NAT なし） |
| private | vault-web（画面の BFF）、vault-api、vault-docgen | **なし**。VPC エンドポイントだけ |
| isolated | 保管庫の Aurora | なし |

- **人事の側 → 保管庫**：保管庫が vault-api の NLB を VPC エンドポイントサービス（PrivateLink）として公開し、許可する主体を prod のアカウントに限る。相互 TLS（保管庫の Private CA）と操作者の主張（[ADR-0046](../decisions/0046-purpose-bound-vault-api-and-access-log.md)）。
- **保管庫 → 人事の側**：書類の元のデータの読み取りと、担当者の指定の事象の受け取りのために、prod が `hr-docsource` の VPC エンドポイントサービスを公開し、許可する主体を vault-prod に限る。読み取りだけの API で、番号を含まない。
- 保管庫の外への出口（電子申請）は MVP では持たない。足すときは ADR にする（[my-number-vault.md](my-number-vault.md) の 15 節）。

## 3. ECS サービスとオートスケール

すべて Fargate（ARM64）。サービスごとにタスク定義と IAM ロールを分ける。

| サービス | 役割 | スケールの指標 | 最小タスク数（S1） |
| --- | --- | --- | --- |
| api | 画面の API、公開の API、Better Auth、打刻の受付、report-service（同期） | CPU 50%、ターゲットあたりの同時要求数。**始業の前に予定のスケール**（[capacity.md](capacity.md) の 3 節） | 6（AZ ごとに 2） |
| bp-worker | 業務プロセスのステップ、タイマー、発効 | SQS の最古のメッセージの経過時間、期限の来たタイマーの件数 | 3 |
| worker | 通知、PDF、振込ファイル、仕訳の出力、一括の取り込み、レポートの非同期、勤怠の再計算、36 協定の判定 | キューごとの最古の経過時間。キューごとにサービスを分ける | キューごとに 1〜3 |
| relay | outbox → SQS | outbox の最古の行の経過時間 | 2（アクティブ 1、待機 1） |
| payroll-compute | 給与計算の束 | 実行ごとに ECS のタスクを起こす（サービスではなく RunTask）。同時のタスクの上限はテナントごとと全体 | 0（実行のときだけ） |
| loader | 束の結果の取り込み | SQS | 2 |
| egress-worker | Webhook の送信、IdP のメタデータの取得 | SQS、同時送信数 | 2 |
| audit-archiver | 監査のセグメントの書き出し | 書き出しの遅れ | 1（アクティブ 1、待機 1） |
| vault-web・vault-api・vault-docgen（vault-prod） | 保管庫 | CPU 50% | 各 2 |

- 台数の根拠は [capacity.md](capacity.md)。
- 各サービスは、残る 2 AZ で最大の負荷をさばける台数を持つ。平常の使用率を 2/3 以下に保つ。

## 4. エッジ

| 配信 | アカウント | 中身 |
| --- | --- | --- |
| `*.<brand>.<domain>` | edge | SPA（S3）、`/api/*`（ALB） |
| `mn.*.<brand>.<domain>` | vault-prod | 保管庫の画面（S3）と vault-web（ALB）。人事の側の配信と分ける |
| `cdn.<brand>.<domain>` | edge | 静的な資産 |

- WAF（初期値。E12 で調整）：AWS のマネージドルール（共通、既知の悪い入力、IP の評判）、IP ごとのレート制限（ログインの送信、打刻の送信、公開の API、全体）、打刻機の API は登録した送信元の IP の許可リストを付けられる。WAF のログは Block と Count に絞り、クエリ文字列と `Authorization`・`Cookie` を伏せる。
- テナントの独自ドメインは MVP では持たない（ホスト名は `<tenant>.<brand>.<domain>`）。

## 5. S1 の構成と台数（初期見積もり）

| リソース | 構成 | 根拠 |
| --- | --- | --- |
| Aurora PostgreSQL 18（人事） | writer `db.r8g.4xlarge` × 1、reader 同型 × 2（一般用 1、レポート用 1。カスタムエンドポイント）。I/O-Optimized。支給日の前の 5 営業日は、給与の入力の固定の用の reader を 1 台足す（予定のスケール）。大阪に Global Database の二次（reader 1 台） | [architecture/README.md](README.md) の 2 節の「writer 1 台＋reader 2 台」。[capacity.md](capacity.md) の 4 節 |
| Aurora PostgreSQL 18（保管庫） | writer `db.r8g.large` × 1、reader 同型 × 1。大阪に Global Database の二次 | 約 200 万件の小さな記録 |
| RDS Proxy | 使わない | `SET LOCAL` のテナントのコンテキストで接続が固定される（他の題材と同じ） |
| ElastiCache（Valkey） | `cache.r7g.large`、クラスタモード 3 シャード ×（プライマリ 1＋レプリカ 1） | セッションのキャッシュ、権限の表、レート制限。失ってよい |
| api | 2 vCPU / 4 GB × 6（平常）、始業の前に 12、最大 40 | 打刻 400 件/秒の集中 |
| bp-worker | 1 vCPU / 2 GB × 3、4 月 1 日の前に 12 | 発効の集中 |
| worker | 0.5〜2 vCPU × 計 12（最大 60） | PDF の生成、再計算 |
| payroll-compute | 4 vCPU / 8 GB のタスク、同時の上限はテナントごと 20・全体 200 | 3 万人を 45 分以内（NFR-003）。[capacity.md](capacity.md) |
| SQS | 標準キュー＋DLQ。キューごと | |
| NAT ゲートウェイ | private × 3、egress × 3（東京）。大阪も同じ。payroll と vault には置かない | |
| 大阪（ウォームスタンバイ） | 各サービスを最小 1〜2 タスク、Aurora の二次に reader 1 台。支給日の前の 5 営業日は api と worker を 2 倍にする | 6 節 |

staging は同じ構成を最小の台数で持ち、負荷試験のときだけ本番と同じ台数に広げる。dev は夜間と週末に止める。

## 6. バックアップと災害復旧（[ADR-0055](../decisions/0055-disaster-recovery-and-payday-continuity.md)）

### 6.1 バックアップ

| 対象 | 方法 | 保持 |
| --- | --- | --- |
| Aurora（人事・保管庫） | 自動バックアップ（PITR）＋ AWS Backup の連続バックアップ、Vault Lock | 35 日 |
| Aurora の長期のスナップショット | 取らない。長期の保存は log-archive と S3 の規則表で持つ | — |
| S3（入力の文書、結果の束、明細、振込ファイル） | バージョンの管理、大阪への複製（Replication Time Control） | 規則表（[audit-and-retention.md](audit-and-retention.md) の 5 節） |
| log-archive | Object Lock、大阪への複製 | 同上 |
| ECR のエンジンのイメージ | 大阪への複製。ライフサイクルで消さない | 給与の実行の保存の期間（[ADR-0026](../decisions/0026-payroll-run-stages-and-input-snapshot.md)） |
| Valkey、SQS | バックアップしない | 失ってよい。SQS は outbox から作り直す |

- 暗号化は KMS のマルチリージョンの鍵（[security.md](security.md) の 5.2 節）。鍵のレプリカが大阪で有効であることを日次に確かめる。

### 6.2 AZ の障害（NFR-006：RPO 0、RTO 15 分）

- Aurora は別の AZ の reader へ自動でフェイルオーバーする（通常 60 秒未満。[Aurora の高可用性](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Concepts.AuroraHighAvailability.html)。Stripe・Auth0 の題材で確認済み）。
- 打刻は端末に貯まる（[self-service-ui.md](self-service-ui.md) の 4 節）。給与の計算の束は再試行で続く（[ADR-0029](../decisions/0029-parallel-run-and-compute-partitioning.md)）。

### 6.3 リージョンの障害（NFR-006：RPO 5 分以内、RTO 4 時間以内）

| 段階 | 戦略 | 大阪に常に置くもの |
| --- | --- | --- |
| S1・S2 | ウォームスタンバイ。人の判断で切り替え、手順はワークフローで自動化 | Aurora Global Database の二次（人事・保管庫）、各サービスの最小のタスク、ALB、VPC エンドポイント、SQS、ECR・Secrets Manager の複製、Private CA、KMS のレプリカ、S3 の複製、Valkey（空） |
| S3 | セルごとに主のリージョンを持つ（9 節） | 各セルの相手のリージョンに同じ構成 |

- Aurora Global Database の計画外のフェイルオーバーは、複製の遅延ぶんのコミットを失う。switchover は RPO 0。先にアプリの書き込みを止める（Auth0 の題材の infrastructure.md の 6.3 節で確かめた事実を引き継ぐ）。`AuroraGlobalDBRPOLag` が 60 秒を超えたら呼び出す（NFR-006 の 5 分に余裕を持たせる）。
- **切り替えの順序**（[runbooks/disaster-recovery.md](../runbooks/disaster-recovery.md)）：
  1. 人事の Aurora、api（給与・人事の担当の画面）、worker（振込ファイル）。支払の経路を先に戻す。
  2. セルフサービスの画面、打刻の受付（端末に貯まった打刻が一度に届く）。
  3. bp-worker のタイマー（発効の追いつき）、レポート。
  4. 保管庫（振込ファイルと給与の計算に保管庫は要らないので、最後でよい）。

### 6.4 支給日の DR（NFR-006：振込ファイルを当日中に出す）

- 振込ファイルは支払の指示から決定的に作る（[ADR-0035](../decisions/0035-bank-transfer-files.md)）。指示は Aurora にあり、ファイルは S3 にある。どちらも大阪に複製される。
- **毎日の確認（支給日の前の 5 営業日）**：大阪のアカウントの中で、複製の DB（二次の reader）から、承認済みと承認待ちの振込ファイルを作り直し、SHA-256 が東京のファイルと一致することを確かめる（書き込みはしない。結果は合成監視と同じく記録する）。一致しなければ SEV2。
- 支給日の前の 5 営業日は、大阪の api と worker の最小のタスクを 2 倍にし、Aurora の二次の reader を writer の昇格に備えて同型にする。
- 手順は [runbooks/disaster-recovery.md](../runbooks/disaster-recovery.md) の「支給日の DR」。

### 6.5 論理的な破損

- 他の題材と同じく、Aurora の PITR で隔離した VPC に新しいクラスタを復元し、失われた行だけを戻す。本番のクラスタは上書きしない。
- 追記のみの表（差分、バージョン、`bp_events`、給与の結果、仕訳、監査）は、戻す行が、その後の差分・バージョン・逆仕訳と矛盾しないことを確かめる。確定した給与の結果は、戻すのではなく、入力の文書から計算し直して一致を確かめる（[ADR-0026](../decisions/0026-payroll-run-stages-and-input-snapshot.md)）。

### 6.6 大阪の待機の構成の確認

| 確認 | 頻度 |
| --- | --- |
| 大阪からの合成監視（大阪の ALB へ直接、監視用のテナントで画面の読み取り） | 1 分 |
| 大阪での振込ファイルの作り直しとハッシュの一致 | 支給日の前の 5 営業日は毎日、それ以外は週 1 回 |
| 大阪の Terraform の plan に差分がない | 日次 |
| KMS のレプリカの有効、ECR・Secrets Manager の複製 | 日次 |
| Fargate の vCPU のクォータが大阪でも東京と同じ | 月次 |

## 7. 環境とデータ

| 環境 | 目的 | データ |
| --- | --- | --- |
| local、dev | 開発、エージェントの確認ループ | seed（合成の人だけ。[AGENTS.md](../../AGENTS.md)） |
| staging | リリース前の確認、負荷・障害試験、DR の訓練、ゴールデンデータセット | 合成（テナント 600、従業員 100 万人相当） |
| prod | 本番。テナントの検証用の環境（`environment = sandbox`）も本番の基盤に置く（移行の試し。[integrations-and-bulk.md](integrations-and-bulk.md) の 4.3 節） | 本番 |

- 本番のデータを本番のアカウントの外に出さない。匿名化したコピーも作らない。
- 合成監視のために、prod に社内の監視用のテナント（合成の従業員と、合成の給与の実行）を置く（[observability.md](observability.md) の 6 節）。

## 8. 段階を上げる判断の基準（[ADR-0056](../decisions/0056-stages-cluster-sharding-and-cells.md)）

次のどれかに当たり、戻らない見込みになったら、次の段階への移行を始める。移行に四半期ほどかかるので、上限の手前で始める。

| 指標 | S1 → S2 を始める目安 | S2 → S3 を始める目安 |
| --- | --- | --- |
| 本番のテナントの数 | 200（S1 の 300 の約 70%） | 2,000 |
| 最大のテナントの従業員 | 2 万人を超える契約の見込み | 7 万人 |
| Aurora の writer の CPU（支給日の前のピークの p95） | 60% を超える、または 1 段上げても 6 か月もたない | クラスタを分けても最大のクラスで 60% を超える見込み |
| 給与計算の時間 | 最大のテナントで NFR-003 の 70%（3 万人で 31 分）を超える | 10 万人で 42 分 |
| レポートの reader | 支給日の前の CPU の p95 が 70% を超える | — |
| 打刻のピーク | 280 件/秒（400 の 70%）を超える | 2,800 件/秒 |
| リージョンの切り替え | RTO 4 時間を、大口のテナントが契約で許さない | 1 回の障害で全テナントが止まることが許されない |

S2 で行うこと：テナントの対応表（`tenant_directory`：テナント → クラスタ）で Aurora のクラスタを分ける、大口のテナントを専用のクラスタへ、レポートを分析用の基盤へ（[reporting.md](reporting.md) の 6.2 節）、Payroll Compute の同時の上限を大口のテナントに別に置く。

## 9. S3 のセル構成

- スタック一式（prod と vault-prod の両方）をセルとして複製し、セルごとに主のリージョンを東京か大阪に置く。
- テナントを 1 つのセルに固定する。人事のデータ、給与、保管庫の記録はセルの中で閉じる。
- ホスト名がセルを決める（`<tenant>.<brand>.<domain>` を DNS でセルの配信へ向ける）。要求の経路に、セルを引く同期の依存を足さない。
- セルの外（Global）に置くもの：テナント → セルの対応表、規則表（全テナントに共通。各セルへ配る）、課金の集計。
- テナントのセル間の移動は、Slack の infrastructure.md の 10.4 節の手順に倣う。保管庫の記録の移動は、同じ手順を保管庫の間で行い、アクセスの記録の連鎖を移動の前後で結ぶ。S3 の前に別の ADR で決める。

## 10. Terraform の配置（[ADR-0057](../decisions/0057-vault-delivery-separation.md)）

開発リポジトリの `infra/` に置く。ルートモジュールを、変更の頻度と影響の範囲で分ける。

| ルートモジュール | 中身 | 状態の置き場所 | 変更の承認 |
| --- | --- | --- | --- |
| `org/` | Organizations、SCP、Identity Center | shared | Ops の責任者＋セキュリティの担当 |
| `security/` | GuardDuty、Security Hub、Config、log-archive | shared | 同上 |
| `global/edge` | 人事の側の CloudFront、WAF、ACM、Route 53。変数 `active_region` | shared | Ops（WAF のルールは `security:sensitive`） |
| `regional/network` | VPC、サブネット、NAT、Network Firewall、VPC エンドポイント、PrivateLink の受け口 | shared | Ops |
| `regional/data` | Aurora（Global Database）、Valkey、S3、SQS | shared | Ops。状態を持つリソースの削除・置き換えは CI で拒否 |
| `regional/keys` | KMS の鍵、キーポリシー、Private CA | shared | `security:sensitive` |
| `regional/services` | ECS のクラスタ、サービス、タスク定義、ALB、オートスケール、予定のスケール | shared | Ops |
| `vault/*`（network、data、keys、services、edge） | 保管庫の全部 | **vault-prod の中の専用のバケット** | **セキュリティの担当＋Ops の責任者。人事の側のパイプラインから apply できない** |

- テナントの鍵（`<brand>-tenant-<id>`。S1 と、S2 以降の専用の鍵の選択肢）は Terraform で管理しない。テナントの作成の処理（`platform` のロール）が API で作る。S2 以降のセルの鍵（`<brand>-cell-<cell_id>`）はセルの構成と一緒に Terraform で管理する。
- plan のポリシー検査（OPA・Checkov）で拒否するもの：
  - `payroll` のサブネットの経路表に NAT・IGW、Payroll Compute のセキュリティグループから Aurora・Valkey への出口
  - vault-prod の private のサブネットの経路表に NAT・IGW
  - `vault-mn` の `kms:Decrypt` を保管庫のタスクのロール以外に与える
  - KMS の鍵の `deletion_window_in_days` が 30 日未満、または `enable_key_rotation` が無効（対称の鍵）
  - log-archive の監査のバケットの Object Lock の無効化

## 11. コストの概算（S1、本番、1 か月）

**大まかな見積もりである。** ±50% の幅。データ転送、ログの量、サポートプラン、税は含めない。単価は東京（[AWS Price List API](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonRDS/current/ap-northeast-1/index.json) と [ECS](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonECS/current/ap-northeast-1/index.json)、2026-09-28 に確認）：Aurora PostgreSQL の I/O-Optimized で `db.r8g.4xlarge` 1 時間 3.464 USD、`db.r8g.large` 0.433 USD、ストレージ 1 GB 月 0.27 USD。Fargate の Graviton で vCPU 1 時間 0.04045 USD、メモリー 1 GB 1 時間 0.00442 USD。大阪（[RDS](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonRDS/current/ap-northeast-3/index.json)、[ECS](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonECS/current/ap-northeast-3/index.json)、2026-09-28 に確認）は `db.r8g.4xlarge` 3.456 USD、`db.r8g.large` 0.432 USD、ストレージ 0.27 USD、Fargate は東京と同じ。他の項目の単価は確かめていない（未検証。E12 の `cost-baseline` で確定する）。Savings Plans とリザーブドで 20〜30% 下げられる。

| 項目 | 月額（USD、概算） |
| --- | --- |
| Aurora（人事：r8g.4xlarge × 3＋支給日の前の追加の reader 7 日分＋大阪 × 1、ストレージ 3 TB を東京と大阪に） | 12,300 |
| Aurora（保管庫：r8g.large × 2＋大阪 × 1） | 950 |
| ECS Fargate（東京 平均 約 110 vCPU、大阪の待機 約 15 vCPU、保管庫 約 6 vCPU） | 4,700 |
| ElastiCache（東京 6 ノード、大阪 2 ノード） | 1,500 |
| CloudFront、ALB、WAF | 2,500 |
| NAT ゲートウェイ、Network Firewall（東京と大阪） | 2,500 |
| 可観測性（ログ、メトリクス、トレース、Grafana） | 2,000 |
| GuardDuty、Security Hub、Inspector、Config、CloudTrail | 1,000 |
| KMS（テナントの鍵 600 本＋用途の鍵、要求）、Secrets Manager、Private CA（2 アカウント × 2 リージョン） | 2,500 |
| S3（明細 年 1 TB、入力の文書、log-archive、複製）、バックアップ | 1,000 |
| **本番の合計** | **約 31,000** |
| staging・dev・vault-staging・shared・edge・security | 約 6,000 |

- Aurora の内訳（730 時間/月）：東京 3.464 × 730 × 3 ＝ 7,586、追加の reader 3.464 × 24 × 7 ＝ 582、大阪 3.456 × 730 ＝ 2,523、ストレージ 3,000 GB × 0.27 × 2 リージョン ＝ 1,620。計 12,311。2026-09-28 の見直しで、大阪の Global Database の二次のストレージ（810）を足し、11,500 から直した。保管庫は 0.433 × 730 × 2 ＋ 0.432 × 730 ＝ 948（ストレージは小さいので除く）。Global Database の複製の書き込みの I/O とリージョン間の転送は含めない。
- KMS のテナントの鍵は、S1 は 1 テナント 1 本（600 テナントで主とレプリカで月 1,200 USD 程度。上の表の KMS の行に含む）。S2 からはセルごとに 1 本とテナントの DEK にする（[ADR-0052](../decisions/0052-kms-key-hierarchy.md) の 2026-09-28 の注記、[security.md](security.md) の 5.3 節）。S3（2 万テナント）の鍵の費用は、1 テナント 1 本なら月 4 万 USD 程度のところ、セルごとなら数十 USD と、専用の鍵を選んだテナントの数 × 2 USD になる。
- Private CA は、短命の証明書（7 日以内）のモードで CA 1 つ月 50 USD（Auth0 の題材で確認した値）。
- 費用は、アカウントとタグ（`service`、`env`、`tenant_tier`）ごとに毎月見る。Payroll Compute は実行ごとのタグ（`payroll_run_id` のハッシュ）で、支給日の集中の費用を見る。

## 12. Epic との対応

| Epic | Story の候補 |
| --- | --- |
| E1 | アカウントと SCP、VPC とサブネット（payroll・egress を含む）、ECS のサービスの骨格、KMS の鍵、Terraform のルートモジュールとポリシー検査、大阪のウォームスタンバイの骨格 |
| E8 | Payroll Compute の RunTask と同時の上限、payroll サブネット |
| E10 | 振込ファイルの S3 と専用の鍵、大阪での作り直しの確認（6.4 節） |
| E11 | vault-prod のアカウント、PrivateLink の両方向、保管庫の CloudFront と WAF、保管庫の Terraform とパイプライン |
| E12 | DR の訓練（支給日の DR を含む）、本番の switchover、クォータの引き上げ、コストの確定 |

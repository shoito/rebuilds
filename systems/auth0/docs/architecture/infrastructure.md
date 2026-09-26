# Infrastructure: Auth0

AWS 上の構成、アカウント、ネットワーク、認証の経路と管理の経路の分け方、エッジ、Signer の隔離、冗長化、災害復旧、段階を上げる基準、S3 のセル構成、Terraform、コスト。他の題材（Slack・Stripe の infrastructure.md）を土台にし、IdP に固有の事情だけを変える（[ADR-0001](../decisions/0001-platform-and-stack.md)）。

| 対象 | 決定 |
| --- | --- |
| 認証の経路と管理の経路を分け、依存先ごとに縮退する | [ADR-0005](../decisions/0005-authentication-path-availability.md) |
| アカウント、ネットワーク、経路の分け方 | [ADR-0057](../decisions/0057-accounts-network-and-path-separation.md) |
| エッジとカスタムドメイン | [ADR-0058](../decisions/0058-edge-and-custom-domains.md) |
| Signer の隔離 | [ADR-0059](../decisions/0059-signer-isolation.md) |
| DR、失った範囲のやり直し、段階、S3 のセル | [ADR-0060](../decisions/0060-disaster-recovery-and-stages.md) |
| Argon2id と Signer の CPU、鍵のキャッシュ | [ADR-0063](../decisions/0063-cpu-bound-work-sizing.md) |
| IaC、デプロイの方式、フラグ、可観測性の道具 | Slack の ADR-0020・0022・0026・0021 を引き継ぐ |

ログ・メトリクス・SLI は [observability.md](observability.md)、負荷と台数の根拠は [capacity.md](capacity.md)、CI とリリースは [delivery.md](delivery.md)、統制と暗号化は [security.md](security.md)、鍵の階層は [keys-and-secrets.md](keys-and-secrets.md)、カスタムドメインの検証と証明書の手順は [custom-domains.md](custom-domains.md) にある。

数値のうち「初期見積もり」と書いたものは、E12 の負荷試験の前の仮の値である。AWS の仕様で確かめていないものは「未検証」と書く。

## 1. AWS アカウントの構成

[ADR-0057](../decisions/0057-accounts-network-and-path-separation.md) のとおり。

| アカウント | OU | 中身 |
| --- | --- | --- |
| management | Root | Organizations、SCP、IAM Identity Center、請求 |
| security | Security | GuardDuty・Security Hub・Inspector の委任管理者、調査用のロール |
| log-archive | Security | 組織の CloudTrail、Config、VPC フローログ、監査ログ（[ADR-0054](../decisions/0054-audit-log.md)）、認証のイベントの保管。Object Lock。東京 → 大阪へレプリケーション |
| shared | Infrastructure | ECR（東京・大阪にレプリケーション）、Route 53（`<brand>.<domain>`）、Managed Grafana、CI の起点、Terraform の状態のバケット |
| edge | Infrastructure | CloudFront（通常の配信とマルチテナントの配信）、WAF、ACM（us-east-1）、CloudFront のログ |
| dev、staging | Workloads/NonProd | 開発・検証。staging は本番と同じ構成を最小の台数で持つ |
| prod | Workloads/Prod | 本番（東京と大阪）。`auth`・`signer`・`mgmt`・`relay`・`worker`、Aurora（主とログの 2 つのクラスタ）、Valkey、SQS、S3（JWKS・discovery・静的な資産） |
| actions | Workloads/Prod | Actions（E13、MVP の後）の実行器（Lambda のテナントの隔離のモード）、ビルド（CodeBuild、npm のプロキシ）、束の S3、`actions-egress` の VPC（専用の NAT）。prod の VPC と経路を持たない。E13 の着手時に作る（[ADR-0057](../decisions/0057-accounts-network-and-path-separation.md)、[ADR-0049](../decisions/0049-extensibility-execution-isolation.md)、[extensibility.md](extensibility.md) の 5.2 節） |

- **SCP**（Workloads の OU）：
  - 東京・大阪以外のリージョンを禁止する（CloudFront・WAF・ACM・IAM のための us-east-1 のグローバルなサービスを除く）。データの所在は法務の L6 で確定する（[security.md](security.md) の 13 節）。
  - CloudTrail・Config・GuardDuty の停止、KMS の鍵の削除の予約・無効化を、break-glass のロール以外に禁止する。
  - 署名鍵の KMS の鍵のキーポリシーの変更を、セキュリティの担当の期限つきのロール以外に禁止する（[ADR-0056](../decisions/0056-operator-access.md)）。
- **ダッシュボードの管理者のログイン**に使う管理用のテナントも、prod の同じ基盤で動く（自分で自分を使う）。非常用の経路は dashboard の領域で決める。
- S3 のセル構成では、セルごとに prod のアカウントを持つ（11 節）。
- **actions** のアカウントには、prod から入る経路は `lambda:InvokeFunction`（Auth のタスクのロール）と束の S3 の署名付き URL の作成だけを持たせ、actions から prod への経路・ロールの引き受けは持たない。SCP で、actions のアカウントの Lambda の実行ロールに権限を付けること（空のポリシー以外）を拒否する（ADR-0049）。

## 2. ネットワーク

### 2.1 prod の VPC（東京・大阪で同じ形）

3 AZ にまたがる VPC を 1 つ持つ。

| サブネット | 置くもの | インターネットへの経路 |
| --- | --- | --- |
| public | `alb-auth`、`alb-mgmt`、NAT ゲートウェイ | Internet Gateway |
| private | `auth`、`mgmt`、`relay`、`worker`（外向きの送信を除く） | NAT 経由。Network Firewall で宛先を許可リストに限る（ソーシャル IdP のトークン・userinfo のエンドポイント、メールの送信事業者） |
| signer | `signer`、Signer の内部の NLB | **なし**（VPC エンドポイントだけ。[ADR-0059](../decisions/0059-signer-isolation.md)） |
| egress | `worker-egress`（テナントの任意の URL への送信） | 専用の NAT。本体の VPC エンドポイントと DB への経路を持たない（2.3 節） |
| isolated | Aurora、ElastiCache（Valkey） | なし |

- 入口は CloudFront → ALB だけ。ALB のセキュリティグループは CloudFront のマネージドプレフィックスリストだけを許し、加えて CloudFront が付ける秘密のヘッダーを ALB のリスナーの規則で検査する（[ADR-0058](../decisions/0058-edge-and-custom-domains.md)）。
- VPC エンドポイント：S3、ECR、SQS、KMS、Secrets Manager、CloudWatch Logs、STS、X-Ray、AppConfig、Private CA。
- セキュリティグループはサービスごとに入る側と出る側を明示する。`signer` へ入れるのは `auth`（署名のポート）と `mgmt`（鍵の管理のポート）だけ。

### 2.2 認証の経路と管理の経路

| 層 | 認証の経路 | 管理の経路 |
| --- | --- | --- |
| ホスト名 | `<tenant>.jp.<brand>.<domain>`、カスタムドメイン | `<tenant>.jp.<brand>.<domain>/api/v2/*`、`manage.<brand>.<domain>` |
| CloudFront | 既定のビヘイビア、`/.well-known/*`（S3） | `/api/v2/*` のビヘイビア、ダッシュボードの配信 |
| WAF | 認証の経路の web ACL（4.3 節） | 管理の経路の web ACL |
| ALB | `alb-auth` | `alb-mgmt` |
| ECS | `auth`、`signer` | `mgmt` |
| DB | ロール `auth_app`（writer と reader のプール） | ロール `mgmt_app`（別のプール。一覧・検索は reader だけ） |

- Management API のトークンは、認証の経路の `/oauth/token` で発行する。`mgmt` は検証だけを行う。
- `mgmt` がすべて止まっても、ログイン・トークンの発行・JWKS は続く（ADR-0057 の Confirmation）。

### 2.3 外向きの送信

| 送信 | 経路 | 理由 |
| --- | --- | --- |
| Back-Channel Logout、ログストリームの Webhook（テナントの任意の URL） | egress のサブネットの `worker-egress` → 専用の NAT | SSRF の踏み台にしない。名前解決の後の IP を検査し、リダイレクトを追わない（[security.md](security.md) の 3.6 節） |
| ソーシャル IdP（トークン・userinfo・JWKS） | private → NAT → Network Firewall（許可リスト） | 宛先が決まっている |
| メールの送信（Amazon SES を第一の候補） | VPC エンドポイント（SES の SMTP のエンドポイント。使えるかは未検証）か NAT | email-delivery の領域で決める |
| EventBridge（ログストリーム） | VPC エンドポイント | logs-and-streams の領域 |

- egress の NAT の Elastic IP を、東京と大阪で最初から公開する（テナントが送信元の IP を許可リストに入れる場合のため）。

## 3. ECS サービスとオートスケール

すべて Fargate（ARM64）。サービスごとにタスク定義と IAM ロールを分ける。

| サービス | 役割 | スケールの指標 | 最小タスク数（S1） |
| --- | --- | --- | --- |
| auth | 認可サーバー、Universal Login、接続、MFA、セッション、攻撃の防御の判定。Argon2id を worker threads で計算する | ハッシュの待ち行列の長さの平均、CPU 50%、ターゲットあたりの同時要求数 | 9（AZ ごとに 3） |
| signer | 署名、鍵の生成・ローテーション・失効 | CPU 50%、同時要求数 | 6（AZ ごとに 2）。KMS の障害中は縮小しない（ADR-0005） |
| mgmt | Management API | CPU 50% | 3 |
| relay | outbox → SQS | outbox の最古の行の経過時間 | 2（アクティブ 1、待機 1） |
| worker | ログの書き込み、メール、JWKS・discovery の書き出し、カスタムドメインの配信のテナントの操作、漏えいしたパスワードのデータの取り込み、保持のジョブ | SQS の最古のメッセージの経過時間。キューごとにサービスを分ける | キューごとに 1〜3 |
| worker-egress | Back-Channel Logout、ログストリームの Webhook の送信 | 同上、同時送信数 | 2 |

- 台数の根拠は [capacity.md](capacity.md)。
- ダッシュボードは静的な SPA で、S3＋CloudFront から配る（ECS を持たない）。

### 3.1 AZ の障害への備え

- 各サービスは、残る 2 AZ で最大負荷をさばける台数を常に持つ。平常の使用率を 2/3 以下に保つ（NFR-005）。
- `auth` の最小を 9 にするのは、1 AZ を失っても 6 タスク（ハッシュのスレッド 18 本）が残り、オートスケールが追いつくまでの数分を持たせるため（[capacity.md](capacity.md) の 2.1 節）。

## 4. エッジ

### 4.1 配信

| 配信 | 種類 | 中身 |
| --- | --- | --- |
| `*.jp.<brand>.<domain>` | 通常の配信。ワイルドカードの証明書 1 枚 | 認証の経路、管理の経路（`/api/v2/*`）、discovery・JWKS（S3） |
| カスタムドメイン | マルチテナントの配信（雛形）＋テナントごとの配信のテナント | 同上。証明書は CloudFront が管理する（ADR-0058） |
| `manage.<brand>.<domain>` | 通常の配信 | ダッシュボードの SPA（S3）と `mgmt` |
| `cdn.<brand>.<domain>` | 通常の配信 | Universal Login の静的な資産、テナントのロゴ |

- 事実（2026-09-27 に確認）：配信のテナントの既定の上限は 1 アカウント 1 万、1 配信の毎秒の要求数の既定の上限は 25 万（[CloudFront のクォータ](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html)）。どちらも引き上げを申請できる。
- オリジンのタイムアウト：接続 3 秒・1 回の試行（既定は 10 秒・3 回で、最大 30 秒待つ。[origin failover](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/high_availability_origin_failover.html)）。応答 10 秒（`/oauth/token` の遅延の上限を超えて待たない）。

### 4.2 discovery・JWKS の配布

- Worker が、テナントの鍵の状態の変化のたびに、`/.well-known/openid-configuration` と `/.well-known/jwks.json` を S3 に書き出す（東京のバケット → 大阪へレプリケーション）。
- CloudFront のオリジングループで、東京の S3 を主、大阪の S3 を予備にする。`GET` なので、オリジンのエラー（500・502・503・504）で予備に切り替わる。
- カスタムドメインの discovery は、`issuer` がカスタムドメインになる。S3 のキーはホスト名ごとに分ける（テナントの ID ではなくホスト名で引く。CloudFront Functions でパスを書き換える）。
- キャッシュの期間は RP 300 秒・CloudFront 60 秒、オリジンの障害中に古い版を返す期間（`stale-if-error`）は 24 時間（[keys-and-secrets.md](keys-and-secrets.md) の 7.2 節）。

### 4.3 WAF

認証の経路の web ACL（初期値。E8 と E12 で調整する。値の正本は management-api-and-rate-limiting・attack-protection の領域）。

| 順 | ルール | 動作 | 備考 |
| --- | --- | --- | --- |
| 1 | IP の許可リスト（社内の合成監視） | Allow | |
| 2 | AWS のマネージドルール：IP の評判の一覧 | Block | |
| 3 | AWS のマネージドルール：共通のルール、既知の悪い入力 | Block（一部を Count） | `/u/*` のフォームの本文で誤検知しうるルールは Count から始める |
| 4 | 匿名の IP（VPN・Tor・ホスティング事業者） | Count（ラベルだけ） | VPN の正規の利用者がいる。ラベルを攻撃の防御の判定に使う（attack-protection の領域） |
| 5 | IP ごとのレート制限：ログインとサインアップの送信（`POST /u/login*`・`/u/signup*`） | 5 分に 300 を超えたら Challenge、1,000 で Block | 評価の窓は 1・2・5・10 分から選べ、上限の最小は 10（[rate-based rule の設定](https://docs.aws.amazon.com/waf/latest/developerguide/waf-rule-statement-type-rate-based-high-level-settings.html)、2026-09-27 に確認）。企業の NAT の共有の IP を考え、厳しすぎない値から始める |
| 6 | IP ごとのレート制限：`/oauth/token` | 5 分に 30,000 で Block | M2M のバックエンドは少数の IP から多く呼ぶ。テナント単位の制限はアプリで行う |
| 7 | IP ごとのレート制限：全体 | 5 分に 30,000 で Block | |
| 8 | Bot Control（対象を絞った保護）をサインアップに | Challenge | ボットの検知の方式は E8 の着手前に決める（[intent.md](../intent.md)）。法務の L2 に関わる |
| 9 | ATP（アカウントの乗っ取りの防止）をログインの送信に | Count から | 盗まれた資格情報のデータとの照合と、応答の検査（CloudFront の配信だけ）で失敗の多い IP・セッションを止める（[AWS WAF Fraud Control ATP](https://docs.aws.amazon.com/waf/latest/developerguide/waf-atp.html)、2026-09-27 に確認）。追加の費用がかかる。パスワードを WAF に検査させるので、使うかは法務の L1 と E8 で決める |

- 管理の経路の web ACL：共通のルール、`/api/v2/*` で `Authorization` のない要求を Block、IP ごとのレート制限（5 分に 10,000）。
- WAF のログは Block と Count に絞り、クエリ文字列と `Authorization`・`Cookie` を伏せる（[ADR-0061](../decisions/0061-secret-free-telemetry.md)）。

## 5. S1 の構成と台数（初期見積もり）

S1（対話のログイン 500 件/秒、トークンの発行 3,000 件/秒、テナント 1 万）の本番。根拠は [capacity.md](capacity.md)。

| リソース | 構成 | 根拠 |
| --- | --- | --- |
| Aurora PostgreSQL 18 | writer `db.r8g.4xlarge` × 1、reader 同型 × 2（別の AZ）。I/O-Optimized。大阪の Global Database の二次に reader 同型 × 1 | [architecture/README.md](README.md) の 2 節の「writer 1 台＋reader 2 台」。書き込みのピーク 約 1.3 万行/秒（capacity.md の 2.3 節） |
| Aurora PostgreSQL 18（ログ） | writer `db.r8g.2xlarge` × 1、reader 同型 × 1。I/O-Optimized。大阪は Global Database の headless の二次 | 認証のイベントのログの専用のクラスタ（[ADR-0043](../decisions/0043-log-storage-and-search.md)、[logs-and-streams.md](logs-and-streams.md) の 4.1 節）。1 日 約 1 億件の書き込み。大きさは本書の初期見積もり |
| RDS Proxy | 使わない | `SET LOCAL` のテナントのコンテキストで接続が固定される（Slack の capacity.md の 2.2 節と同じ） |
| ElastiCache（Valkey） | `cache.r7g.large`、クラスタモード 3 シャード × （プライマリ 1＋レプリカ 1） | セッションのキャッシュ、レート制限、攻撃の防御の数。失ってよい（ADR-0005） |
| auth | 4 vCPU / 8 GB × 18（ピーク）、最小 9、最大 60 | Argon2id（ADR-0063） |
| signer | 2 vCPU / 4 GB × 9（ピーク）、最小 6、最大 24 | 署名 6,000 回/秒 |
| mgmt | 1 vCPU / 2 GB × 3、最大 12 | |
| relay | 0.5 vCPU / 1 GB × 2 | |
| worker、worker-egress | 0.5〜1 vCPU × 計 10（最大 30） | |
| SQS | 標準キュー＋DLQ。キューごと | |
| NAT ゲートウェイ | private × 3、egress × 3（東京）。大阪も同じ | |
| Network Firewall | private の外向きに 3 AZ | |
| 大阪（ウォームスタンバイ） | 各サービスを最小 1〜2 タスク（signer は 3）、Aurora の二次に reader 1 台、Valkey は小さい別のクラスタ | 6.3 節 |

staging は同じ構成を最小の台数で持ち、負荷試験のときだけ本番と同じ台数に広げる。dev は夜間と週末に止める。

## 6. バックアップと災害復旧

### 6.1 バックアップ

| 対象 | 方法 | 保持 |
| --- | --- | --- |
| Aurora | 自動バックアップ（PITR）＋ AWS Backup の連続バックアップ。AWS Backup Vault Lock | 35 日（削除の最終の期限。[ADR-0055](../decisions/0055-data-retention-and-deletion.md)） |
| Aurora の長期のスナップショット | 取らない | 資格情報の暗号文とハッシュを長く残さない |
| 監査ログ、認証のイベントの保管 | log-archive の S3（Object Lock）。大阪へレプリケーション | [security.md](security.md) の 9 節 |
| JWKS・discovery | S3（大阪へレプリケーション）。DB から作り直せる | — |
| Valkey、SQS | バックアップしない | 失ってよい。SQS は outbox から作り直す |

- 暗号化は KMS のマルチリージョンの鍵（[security.md](security.md) の 5.2 節）。**署名鍵と pepper の鍵を失うと、全テナントのトークンの発行と、全ユーザーのパスワードの照合ができなくなる。** 削除の保護（SCP と 2 人の承認）と、レプリカの存在を月次で確かめる（6.5 節）。

### 6.2 AZ の障害（NFR-005：RPO 0、RTO 5 分）

| 部品 | 動き | 目安 |
| --- | --- | --- |
| Aurora | 別の AZ の reader へ自動でフェイルオーバー。コミット済みのデータは失わない | 通常 60 秒未満、多くは 30 秒未満（[AWS のドキュメント](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Concepts.AuroraHighAvailability.html)。Stripe の infrastructure.md の 5.2 節で確認） |
| フェイルオーバーの間 | ADR-0005 の縮退：クライアントクレデンシャル（DB に書かない）、JWKS、発行済みのトークンの検証は続く。ログイン・リフレッシュは短い再試行の後に 503 と `Retry-After` | 数十秒 |
| ECS | 残る AZ でタスクを起動し直す | 数分 |
| Valkey | レプリカの昇格。その間は ADR-0005 のとおり、タスクのメモリーの近似の数で続ける | 数十秒 |

### 6.3 リージョンの障害（NFR-006：RPO 1 分、RTO 1 時間。S2 で RTO 15 分）

S1 から大阪に**ウォームスタンバイ**を持つ（[ADR-0060](../decisions/0060-disaster-recovery-and-stages.md)）。

| 段階 | 戦略 | 大阪に常に置くもの |
| --- | --- | --- |
| S1・S2 | ウォームスタンバイ。人の判断で切り替え、手順はワークフローで自動化。ログの Aurora は headless の二次で、切り替えの後にインスタンスを足す（ログの検索の RTO は 4 時間。ログの書き込みは outbox に溜まり、回復後に書く） | Aurora Global Database の二次（reader 1 台）、各サービスの最小のタスク、ALB、NAT、VPC エンドポイント、SQS、ECR・Secrets Manager のレプリカ、Private CA、KMS のマルチリージョンの鍵のレプリカ、S3 のレプリカ、Valkey（空） |
| S3 | セルごとに主のリージョンを持つ（11 節） | 各セルの相手のリージョンに、同じ構成 |

- 事実（2026-09-27 に確認。[Using switchover or failover in Amazon Aurora Global Database](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-global-database-disaster-recovery.html)）：
  - 計画外のフェイルオーバーの RPO は、通常は秒単位で、複製の遅延ぶんを失う。switchover は RPO 0。
  - マネージドなフェイルオーバーは `failover-global-cluster --allow-data-loss`。古い一次の書き込みを止める write fencing は最善努力で、スプリットブレインの余地がある。先にアプリの書き込みを止めることが勧められている。
  - 古い一次の障害時点のスナップショット（`rds:unplanned-global-failover-...`）が取れることがある。保持の期間で消えるので、手動のスナップショットにコピーする。
  - グローバルの writer のエンドポイントを使い、DNS のキャッシュを 5 秒程度に下げることが勧められている。
  - `rds.global_db_rpo`（20 秒以上）を設定すると、二次がすべて遅れたとき一次のコミットを止める。2 リージョンだけなら、二次の側で既定のままにすることが勧められている。
- **`rds.global_db_rpo` は設定しない**（ADR-0060）。`AuroraGlobalDBRPOLag` が 10 秒を超えたら呼び出す。
- **署名鍵は同じなので、切り替えの後も発行済みのトークンは有効のまま**（ADR-0005）。JWKS も同じ。
- **POST の要求はオリジングループで切り替わらない**（ADR-0058）。切り替えのワークフローが、CloudFront の配信のオリジンを大阪の ALB に変える（`global/edge` の変数 `active_region`）。
- **失った範囲のやり直し**（ADR-0060）：失った範囲の、パスワードの変更・再設定、MFA の要素の削除、ユーザーのブロック・削除、ログアウト、リフレッシュトークンの失効、署名鍵の失効、クライアントシークレットのローテーションを、log-archive の記録から大阪の DB へやり直す。手順は [runbooks/disaster-recovery.md](../runbooks/disaster-recovery.md)。
- **署名鍵の失効は、大阪への複製を確かめてから完了を返す**（ADR-0060。確かめ方は未検証で、E1 で決める）。

### 6.4 論理的な破損

Slack・Stripe と同じく、Aurora の PITR で隔離した VPC に新しいクラスタを復元し、失われた行だけを戻す。本番のクラスタは上書きしない。**資格情報の表を戻すときは、戻す行が、その後に削除・変更されていないことを監査ログで確かめる**（削除したユーザーや、変えたパスワードを戻さないため）。

### 6.5 大阪の待機の構成の確認

| 確認 | 頻度 |
| --- | --- |
| 大阪からの合成監視（大阪の ALB へ直接、監視用のテナントでログイン） | 1 分 |
| 大阪の Terraform の plan に差分がない | 日次 |
| KMS のマルチリージョンの鍵のレプリカ（署名鍵・pepper・資格情報）が有効で、大阪の Signer が復号できる | 日次（大阪の Signer の起動時の読み込みの成功を数える） |
| ECR・Secrets Manager のレプリカの同期 | 日次 |
| Fargate の vCPU のクォータが、大阪でも東京と同じ | 月次 |

## 7. CI/CD と Terraform

### 7.1 CI/CD

他の題材と同じ（GitHub Actions、OIDC、1 回ビルドして同じイメージを昇格させる、prod は Ops の承認）。認証に固有の点は [delivery.md](delivery.md)。

```
main へのマージ ─▶ ビルド ─▶ shared の ECR ─▶ dev ─▶ staging（適合試験・E2E・k6）─▶ prod（Ops の承認）
Signer のイメージは、他のサービスと別の日に prod へ出す（ADR-0065）
```

### 7.2 Terraform の配置

開発リポジトリの `infra/` に置く（Slack の ADR-0020）。状態ファイルは shared のバケット（東京、大阪へレプリケーション）。ルートモジュールを、変更の頻度と影響の範囲で分ける。

| ルートモジュール | 中身 | apply のロール | 変更の承認 |
| --- | --- | --- | --- |
| `org/` | Organizations、SCP、Identity Center | management の専用ロール | Ops の責任者＋セキュリティの担当 |
| `security/` | GuardDuty、Security Hub、Config、log-archive | security・log-archive のロール | 同上 |
| `global/edge` | CloudFront の配信、マルチテナントの配信の雛形、WAF、ACM、Route 53。変数 `active_region` | edge のロール | Ops（WAF のルールは `security:sensitive`） |
| `regional/network` | VPC、サブネット、NAT、Network Firewall、VPC エンドポイント（東京・大阪で同じモジュールを 2 回） | prod のネットワークのロール | Ops |
| `regional/data` | Aurora（Global Database）、Valkey、S3、SQS | prod のデータのロール | Ops。状態を持つリソースの削除・置き換えは CI で拒否 |
| `regional/keys` | KMS の鍵（マルチリージョンの主と、レプリカ）、キーポリシー、Private CA | prod の鍵のロール | `security:sensitive`（ADR-0065） |
| `regional/services` | ECS のクラスタ、サービス、タスク定義、ALB、オートスケール | prod のデプロイのロール | Ops |

- **テナントごとの配信のテナント（カスタムドメイン）は Terraform で管理しない。** テナントの操作で作り消しするので、Worker が API で作る（ADR-0058）。Terraform は雛形の配信だけを持つ。
- plan のポリシー検査（OPA・Checkov）で、次を拒否する。
  - `signer` のサブネットの経路表に NAT・IGW（ADR-0059）
  - 署名鍵の KMS の鍵の `kms:Decrypt` を、Signer のタスクのロール以外に与える（ADR-0003）
  - `alb-auth` のターゲットに `mgmt`（ADR-0057）
  - KMS の鍵の `deletion_window_in_days` を 30 日未満、または `enable_key_rotation` を無効
  - ALB のアクセスログを認証の経路で有効にする（ADR-0061）

## 8. 環境とデータ

| 環境 | 目的 | データ |
| --- | --- | --- |
| local | 開発、エージェントの確認ループ | seed（本物の資格情報を使わない。[AGENTS.md](../../AGENTS.md)） |
| dev | 結合の確認 | seed |
| staging | リリース前の確認、適合試験、負荷・障害試験、DR の訓練 | 生成データ（テナント 1 万、ユーザー 2,000 万相当） |
| prod | 本番 | 本番。開発・ステージングの環境のテナント（テナントの `environment`）も本番の基盤に置く（ADR-0002） |

- 本番のデータを本番のアカウントの外に出さない。匿名化したコピーも作らない（他の題材と同じ）。
- 合成監視のために、prod に社内の監視用のテナントを置く（`environment = production`。SLI の対象に含め、別にも見る。[ADR-0062](../decisions/0062-sli-and-synthetic-monitoring.md)）。

## 9. 段階を上げる判断の基準

次のどれかに当たり、戻らない見込みになったら、次の段階への移行を始める。移行に四半期ほどかかるので、上限の手前で始める。

| 指標 | S1 → S2 を始める目安 | S2 → S3 を始める目安 |
| --- | --- | --- |
| 対話のログイン（ピーク） | 300 件/秒（S1 の 60%）を 2 週続けて超える | 3,000 件/秒を 2 週続けて超える |
| トークンの発行（ピーク） | 1,800 件/秒を 2 週続けて超える | 18,000 件/秒 |
| Aurora の writer の CPU（ピークの p95） | 60% を超える、または 1 段上げても 6 か月もたない | シャードを増やしても最大のクラスで 60% を超える見込み |
| 1 テナントの占有 | 1 テナントが書き込みの 20% を超え続ける、またはユーザーが 500 万を超える | 専用のセルが要る大口の契約の見込み |
| ログの表 | 認証のイベントのログが Aurora の容量・I/O の半分を超える（S2 で専用の基盤へ。[architecture/README.md](README.md) の 2 節） | — |
| 配信のテナントの数 | 7,000（既定の上限の 70%） | — |
| CloudFront の 1 配信の毎秒の要求数 | 15 万（既定の上限の 60%） | — |
| リージョンの切り替え | RTO 1 時間を、大口のテナントが契約で許さない | 切り替えの 15 分を許さない |
| 可用性 | — | 1 回の障害で全テナントが止まることが、許されない |

S2 で行うこと：ユーザー・セッション・リフレッシュトークンをテナントのハッシュで複数の Aurora のクラスタに分ける、大口のテナントを専用のクラスタへ、ログを専用の基盤へ、RTO 15 分（切り替えの判断の自動化）。

## 10. コストの概算（S1、本番、1 か月）

**大まかな見積もりである。** ±50% の幅。データ転送、ログの量、サポートプラン、税は含めない。東京の単価は確かめていない（未検証）。Fargate は米国東部の単価（vCPU 1 時間 約 0.040 USD、Graviton は約 2 割安い。[Fargate Pricing](https://aws.amazon.com/fargate/pricing/)、第三者の要約で確認）に、アジア太平洋の割り増し（1〜3 割）を掛けて置いた。Savings Plans とリザーブドインスタンスで 20〜30% 下げられる。

| 項目 | 月額（USD、概算） |
| --- | --- |
| Aurora（主：r8g.4xlarge × 3＋大阪 × 1、I/O-Optimized、Global Database の複製） | 9,000 |
| Aurora（ログ：r8g.2xlarge × 2、ストレージ 約 1.5 TB、大阪は headless） | 3,000 |
| ElastiCache（東京 6 ノード、大阪 2 ノード） | 1,500 |
| ECS Fargate（東京 平均 約 90 vCPU、大阪の待機 約 15 vCPU） | 4,000 |
| CloudFront（要求数、リアルタイムのログ）、ALB、データ転送 | 3,000 |
| WAF（ルール、要求数、Bot Control。ATP を使うなら追加） | 1,500 |
| NAT ゲートウェイ、Network Firewall（東京と大阪） | 3,000 |
| 可観測性（ログ、メトリクス、トレース、Grafana、Kinesis） | 2,500 |
| GuardDuty、Security Hub、Inspector、Config、CloudTrail | 1,000 |
| KMS（マルチリージョンの鍵、要求）、Secrets Manager、Private CA（2 リージョン） | 1,000 |
| S3、バックアップ、log-archive | 800 |
| **本番の合計** | **約 30,000** |
| staging・dev・shared・edge・security | 約 6,000 |

- Private CA は、CA 1 つあたりの月額の費用がかかる（金額は未検証）。東京と大阪に置く。
- 費用は、アカウントとタグ（`service`、`env`、`path`＝`auth`・`mgmt`）ごとに毎月見る。

## 11. S3 のセル構成

S3（テナント 100 万、ログイン 50,000 件/秒、トークン 300,000 件/秒）では、スタック一式をセルとして複製し、**セルごとに主のリージョンを東京か大阪に置く**（[ADR-0060](../decisions/0060-disaster-recovery-and-stages.md)）。

```
                  ┌────────────────────────────────────────────────┐
 利用者 ─────────▶│ Edge（CloudFront、セルごとの配信）               │
                  │  ホスト名 → テナント → セルの対応表（Global）   │
                  └──────────────┬─────────────────────────────────┘
          ┌──────────────────────┼──────────────────────────┐
          ▼                      ▼                          ▼
 cell-t01（主：東京）    cell-o01（主：大阪）       cell-big-01（大口専用）
  auth・signer・mgmt・DB   同じ                       同じ
  二次：大阪               二次：東京                 二次：相手のリージョン
```

- **テナントを 1 つのセルに固定する。** 署名鍵、資格情報、セッション、リフレッシュトークンはセルの中で閉じる。
- **ホスト名がそのままセルを決める。** `<tenant>.jp.<brand>.<domain>` は DNS でセルの配信へ向け（テナントごとの CNAME か、セルごとのサブドメイン）、カスタムドメインは配信のテナントをセルの配信に結ぶ。認証の経路に、セルを引く同期の依存（対応表のサービス）を足さない（ADR-0005）。
- **セルの外（Global）に置くもの**：ホスト名 → テナント → セルの対応表（ダッシュボードとテナントの作成が使う）、ダッシュボードの管理用のテナント、課金の集計。
- **リージョンの障害**では、止まったリージョンを主とするセルだけを切り替える。各リージョンは相手のセルを受ける余裕（平常の使用率 50% 以下）を持つ。
- **CloudFront の 1 配信の毎秒の要求数の上限**（既定 25 万）は、セルごとに配信を分けることで、セルの大きさ（1 セル 3 万件/秒程度）に収める。
- テナントのセル間の移動は、Slack の infrastructure.md の 10.4 節の手順（`tenant_id` で絞ったコピー、短い書き込みの停止、対応表の切り替え）に倣う。認証では、移動の間にリフレッシュトークンのローテーションを止めない工夫（移動中の再利用の検知を無効にしない）が要る。S3 の前に別の ADR で決める。
- Signer の隔離（Nitro Enclaves）を、S3 の前に再評価する（ADR-0059）。

## 12. Epic との対応

| Epic | Story の候補 |
| --- | --- |
| E1 | アカウントと SCP、VPC とサブネット（signer・egress を含む）、ALB の 2 系統、ECS のサービスの骨格、KMS の鍵とレプリカ、Private CA と相互 TLS、Terraform のルートモジュールとポリシー検査、大阪のウォームスタンバイの骨格 |
| E3 | JWKS・discovery の S3 への書き出しとオリジングループ |
| E8 | WAF のレート制限の調整、Bot Control、ATP の判断 |
| E11 | マルチテナントの配信と配信のテナントの自動化（custom-domains の領域と一緒に） |
| E12 | DR の訓練（計画外のフェイルオーバーと失った範囲のやり直し）、本番の switchover、クォータの引き上げ、コストの確定 |
| E13 | actions のアカウント、`actions-egress` の VPC と NAT、Lambda の同時実行のクォータの引き上げ、SCP（実行ロールの空のポリシー） |

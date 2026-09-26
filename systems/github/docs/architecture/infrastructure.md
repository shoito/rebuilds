# Infrastructure: GitHub

AWS 上の構成、ストレージのノード、冗長化、バックアップ、災害復旧、コスト。関係する決定は次のとおり。

| 対象 | 決定 |
| --- | --- |
| 3 つの複製、状態を持たないフロントエンド | [ADR-0003](../decisions/0003-replicated-git-storage.md)、[ADR-0004](../decisions/0004-stateless-git-frontend.md) |
| ストレージのノードの基盤（インスタンスストア） | [ADR-0031](../decisions/0031-storage-nodes-on-instance-store.md) |
| 災害復旧 | [ADR-0032](../decisions/0032-disaster-recovery-strategy.md) |
| ストレージのノードの更新 | [ADR-0033](../decisions/0033-rolling-storage-node-upgrades.md) |
| S3 の複数リージョン | [ADR-0034](../decisions/0034-multi-region-repository-placement.md)（proposed） |

複製の手順・ルーティング・保守（repack）は [git-storage.md](git-storage.md)、プロトコルは [git-protocols.md](git-protocols.md)、CI の実行環境の隔離の方式は [actions.md](actions.md)、脅威モデルは [security.md](security.md) が正本である。ここには、それらを AWS のどこに、何台置くかを書く。ログ・メトリクスは [observability.md](observability.md)、負荷の根拠は [capacity.md](capacity.md)。

IaC（Terraform）、アカウントの基盤、CI/CD の仕組みは Slack の決定を引き継ぐ（[Slack の ADR-0020](../../../slack/docs/decisions/0020-infrastructure-as-code-with-terraform.md)、[Slack の infrastructure.md](../../../slack/docs/architecture/infrastructure.md)）。違うところだけを書く。

数値のうち「初期見積もり」と書いたものは、負荷試験（E9）の前の仮の値である。AWS の仕様で確かめられていないものは「未検証」と書く。

## 1. AWS アカウントの構成

Slack と同じ基盤のアカウント（management・security・log-archive・shared）の下に、次を置く。

| アカウント | OU | 中身 |
| --- | --- | --- |
| dev | Workloads/NonProd | 開発環境 |
| staging | Workloads/NonProd | 本番と同じ構成を小さくしたもの。負荷試験、障害注入、Git の版の先行の確認 |
| prod | Workloads/Prod | 本番。東京と大阪（災害復旧）。Git のストレージ、フロントエンド、Web・API、Worker、Aurora、S3 |
| actions-runners-prod | Workloads/Untrusted | Actions の実行環境（信頼できないコードを実行する）。prod とネットワークでつながない |
| actions-runners-staging | Workloads/Untrusted | 同上の staging |

- **信頼できないコードを実行する場所を、アカウントで分ける。** 実行環境のホストが乗っ取られても、prod の IAM・VPC・KMS の鍵に届かない。SCP で、Untrusted の OU から IAM ロールの信頼の追加、VPC ピアリング、Transit Gateway への接続を禁止する。
- **AZ は AZ ID で揃える。** AZ の名前（`ap-northeast-1a` など）は、アカウントごとに対応する物理的な AZ が違う（[AWS のドキュメント](https://docs.aws.amazon.com/ram/latest/userguide/working-with-az-ids.html)）。prod と実行環境のアカウントの間の PrivateLink や、ストレージの配置は、AZ ID（`apne1-az1` など）で指定する。
- 人のアクセスと SCP の方針は Slack と同じ。ストレージのノードへの SSH は開けず、調査は SSM Session Manager で行い、記録を残す。

## 2. ネットワーク

### 2.1 prod の VPC（東京、3 AZ）

| サブネット | 置くもの | インターネットへの経路 |
| --- | --- | --- |
| public | ALB（Web・API、Git の HTTPS）、NLB（Git の SSH）、NAT ゲートウェイ | Internet Gateway |
| private-app | ECS のタスク（Git フロントエンド、Web・API、Worker） | NAT 経由（許可したドメインのみ） |
| storage | Git のストレージのノード | なし（S3・KMS・SSM などは VPC エンドポイント） |
| isolated | Aurora、ElastiCache、検索のクラスタ | なし |

- **入口は 3 つ。**

  | 入口 | 経路 | 理由 |
  | --- | --- | --- |
  | Web・API | CloudFront（WAF）→ ALB → Web・API | Slack と同じ |
  | Git の HTTPS | CloudFront（WAF）→ ALB → Git フロントエンド | Web と同じホスト名でパスが分かれる（`/<owner>/<repo>.git/info/refs` など）。CloudFront のパスのビヘイビアで Git フロントエンドのオリジンへ振り分ける |
  | Git の SSH（22 番） | NLB（TCP）→ Git フロントエンド | CloudFront は SSH を通せない |

- **Git の HTTPS を CloudFront に通すときの制約。** オリジンの応答タイムアウトは 1〜120 秒（引き上げの申請ができる）、リクエストの本体は 64 GB まで（[CloudFront のクォータ](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html)）。大きな push の受信後の処理（`index-pack`）や、clone のパックの準備の間に 120 秒以上なにも流れないと切れる。Git には、無音の間に keepalive を送る設定（`receive.keepAlive`・`uploadpack.keepAlive`、既定 5 秒。[git-config](https://git-scm.com/docs/git-config)）があるので、これを有効に保つ。応答の全体の時間の上限（response completion timeout）は任意の設定で、既定では掛からない（[オリジンの設定](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/DownloadDistValuesOrigin.html)、2026-09-26 に確認）。PUT・POST はタイムアウトの後に再試行されない。ここまでは文書で確かめたが、数 GB の clone と push が CloudFront 経由で最後まで通ることは、文書では確かめられない（**未検証**）。E3 の `git-load-tests` で確かめ、だめなら Git の HTTPS だけを NLB に直接向けるホスト名に分ける（[git-protocols.md](git-protocols.md) で決める）。
- **NLB の SSH の接続は長い。** NLB の TCP のアイドルタイムアウトは既定 350 秒で、60〜6,000 秒に変えられる（[AWS のドキュメント](https://docs.aws.amazon.com/elasticloadbalancing/latest/network/network-load-balancers.html)）。SSH の keepalive を 60 秒にし、NLB は既定のままにする。クロスゾーンの負荷分散は、NLB では既定で無効なので有効にする。
- **ストレージのノードはインターネットから届かない。** 受け付けるのは、Git フロントエンド・Web・API・Worker からの RPC（gRPC、mTLS）と、ノード間の複製だけ。セキュリティグループで送り元を限る。
- **外向きの送信（Webhook の配信）は隔離する。** 任意の URL へ送るため、SSRF の踏み台になりうる。VPC に接続しない Lambda から送る方式（[Slack の ADR-0016](../../../slack/docs/decisions/0016-isolated-link-unfurling.md) と同じ）を基本とし、決定は [api-and-webhooks.md](api-and-webhooks.md) に置く。

### 2.2 Actions の実行環境の VPC

- actions-runners-prod のアカウントに、東京の 3 AZ にまたがる VPC を 1 つ持つ。prod の VPC とはピアリングも Transit Gateway も持たない。
- **prod へ届く経路は PrivateLink だけにする。** prod の側で、実行環境が使う 2 つのサービス（Git フロントエンドの読み取り、実行環境の制御 API）を NLB のエンドポイントサービスとして公開し、実行環境の VPC にインターフェイス型のエンドポイントを置く。PrivateLink は、消費する側から提供する側への一方向の接続で、それ以外の prod の資源は見えない（[AWS のドキュメント](https://docs.aws.amazon.com/vpc/latest/privatelink/privatelink-share-your-services.html)）。CI の clone がインターネットを回らないので、外向きの転送の料金もかからない。
- 成果物・ログ・キャッシュは、ジョブごとに発行した署名付き URL で、prod のアカウントの S3 に直接書く。実行環境の VPC の S3 ゲートウェイエンドポイントのポリシーで、書ける先をそのバケットに限る。
- **実行環境のホストは public サブネットに置き、NAT ゲートウェイを使わない。** CI は依存のダウンロードで大量にインターネットへ出る。NAT ゲートウェイを通すと、処理した量に比例して料金がかかる。ホストが自分のパブリック IP で送信元変換し、受信はセキュリティグループですべて拒否する。
- microVM からの通信は、ホストで次を落とす：インスタンスメタデータ（`169.254.169.254`）、VPC の CIDR（PrivateLink のエンドポイントを除く）、プライベートの IP の範囲。詳細は [actions.md](actions.md)。

## 3. サービスの配置とオートスケール

| 部品 | 基盤 | 置き方 | スケールの指標 |
| --- | --- | --- | --- |
| Git ストレージ | EC2 `i8g.4xlarge`（ローカル NVMe）。ECS は使わない | 3 AZ に同数。1 台ずつ Terraform で作る。Auto Scaling グループは使わない | 手動（容量の計画。[capacity.md](capacity.md)）。自動では増減しない |
| Git フロントエンド | ECS（EC2 のキャパシティプロバイダ、`c8g`） | 3 AZ | タスクあたりの同時接続数と、ネットワークの送信量 |
| Web・API | ECS Fargate（ARM64） | 3 AZ | CPU 50%、ターゲットあたりのリクエスト数 |
| Worker | ECS Fargate（ARM64） | キューごとにサービスを分ける | SQS の最古のメッセージの経過時間 |
| Actions の実行環境 | EC2 のベアメタル（actions-runners-prod） | 3 AZ | キューのジョブ数と、待機中の microVM の数 |

- **ストレージのノードに Auto Scaling グループを使わない。** インスタンスストアのデータは、停止・終了で消える（[AWS のドキュメント](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/instance-store-lifetime.html)）。ヘルスチェックの誤判定で台を入れ替えると、複製が 1 つ消える。ノードの追加・退役は、ストレージの制御（[git-storage.md](git-storage.md)）が複製を移してから行う（ADR-0031）。
- **ストレージのノードは、ラックの障害で 2 台が同時に消えないよう、パーティションのプレイスメントグループに入れる。** パーティションは AZ ごとに最大 7 つ（[AWS のドキュメント](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/placement-strategies.html)）。複製は AZ で分かれているので、同じ AZ の中の 2 台の同時の喪失は、1 つのリポジトリの 2 つの複製を失うことにはならない。プレイスメントグループは、修復の同時の負荷を小さくするために使う。
- **Git フロントエンドは ECS の EC2 起動タイプにする。** 大きな clone は数十分続く。デプロイでタスクを止めるとき、Fargate では SIGTERM から強制終了までの猶予（`stopTimeout`）が最大 120 秒だが、EC2 起動タイプでは上限の記載がない（[Fargate](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html)、[EC2](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters_ec2.html)）。猶予を 15 分にして、進行中の転送を終えてから止める。EC2 起動タイプの上限がないことは、2026-09-26 に確かめた（未設定のときは ECS エージェントの `ECS_CONTAINER_STOP_TIMEOUT`、既定 30 秒）。15 分の猶予と NLB の登録解除の遅延が組み合わさって実際に効くことは **未検証**（E1 の `frontend-drain-poc` で確かめる。[git-protocols.md](git-protocols.md) の 9 節）。
- **1 つの AZ を失っても足りる台数を常に持つ。** 状態を持たない部品は、平常時の使用率を 2/3 以下に保つ（Slack と同じ）。ストレージは、どのリポジトリも 3 つの AZ に 1 つずつ複製を持つので、AZ を失っても 2 つが残る（5.3 節）。
- **ストレージのノードの予定された停止・退役（scheduled events）を拾う。** AWS はハードウェアの保守のため、インスタンスの停止・退役を予定することがあり、AWS Health のイベントとして EventBridge で受け取れる（[AWS のドキュメント](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/monitoring-instances-status-check_sched.html)）。停止・退役ではインスタンスストアのデータが消えるので、イベントを受けたら、予定の前にそのノードの複製を退避する（[runbooks/incident-response.md](../runbooks/incident-response.md) の「ストレージのノードの喪失」）。再起動のイベントではデータは残るので、退避せず、1 台ずつ受ける。

## 4. S1 の構成と台数（初期見積もり）

S1（リポジトリ 100 万、Git の要求のピーク 2,000 件/秒）の本番。根拠は [capacity.md](capacity.md)。

| リソース | 構成 | 根拠 |
| --- | --- | --- |
| Git ストレージ | `i8g.4xlarge`（16 vCPU、128 GiB、NVMe 3,750 GB × 1、最大 25 Gbps）× 42（AZ ごとに 14） | 保存の論理量 30 TB × 3 複製 ＝ 90 TB。充填率 60% で 150 TB。3,750 GB × 40 台 ＋ 余裕（[capacity.md](capacity.md) の 2.1 節） |
| Git フロントエンド | `c8g.4xlarge` × 6（AZ ごとに 2）の上に、2 vCPU のタスク × 18 | 外向きのピーク 12 Gbps と SSH の暗号の CPU |
| Web・API | 2 vCPU / 4 GB × 12 タスク（最大 40） | |
| Worker | 0.5〜2 vCPU × 計 20 タスク（最大 60） | 差分・マージの計算の RPC 待ちが多い |
| Aurora PostgreSQL | writer `db.r8g.4xlarge` × 1、reader 同型 × 2（別の AZ）。I/O-Optimized | メタデータ（PR・Issue・権限・ルーティングの表） |
| ElastiCache（Valkey） | `cache.r7g.large`、プライマリ 1 ＋ レプリカ 2 | 権限の判定のキャッシュ、ルーティングのキャッシュ、レート制限 |
| 検索 | [search.md](search.md) で決める | |
| S3（東京） | LFS、Actions の成果物・ログ・キャッシュ、差分のキャッシュ | LFS 20 TB、Actions 50 TB（保持 90 日。キャッシュは 7 日） |
| S3（大阪） | Git のバックアップ（5 節） | 約 45 TB |
| Actions の実行環境 | `m7i.metal-48xl`（192 vCPU・物理 96 コア、768 GiB）× 平常 14〜18、ピーク 54（待機を含む） | SMT を無効にするので（ADR-0023）、標準の実行環境（2 vCPU / 8 GiB）を 1 台に約 40。ピークの同時実行 1,800 ジョブ（[capacity.md](capacity.md) の 2.9 節） |

- **ストレージのノードは Graviton4 の `i8g` にする。** Git と Go のサービスは ARM64 で動く。`i8g` は東京で使える（[AWS の発表、2025-10](https://aws.amazon.com/about-aws/whats-new/2025/10/amazon-ec2-i8g-instances-available-in-additional-aws/)）。`i8g.4xlarge` の仕様は [AWS のストレージ最適化インスタンスの仕様](https://docs.aws.amazon.com/ec2/latest/instancetypes/so.html) による。大阪でも `i8g` を使える（2025-11 に提供開始。[AWS の発表、2025-11](https://aws.amazon.com/about-aws/whats-new/2025/11/amazon-ec2-i8g-instances-additional-aws-regions)、2026-09-26 に確認）。災害復旧のときに在庫が足りなければ、`i7i`・`i4i` か、EBS を付けた汎用のインスタンスで代える（ADR-0032）。
- **ノードを小さめ（4xlarge）にする。** 1 台を失ったときに作り直す複製の量（約 2.2 TB）を小さくし、修復の時間を短くするため。台数が増えたら、8xlarge（NVMe 3,750 GB × 2）に移すかを比べる。
- **Actions の実行環境は、EC2 のベアメタルの上の Firecracker の microVM にする（[ADR-0023](../decisions/0023-firecracker-microvm-runners.md)）。** microVM は KVM を使うので、ベアメタルか、入れ子の仮想化に対応したインスタンスが要る。入れ子の仮想化は 2026-02 から C8i・M8i・R8i などの仮想のインスタンスでも使える（[AWS の発表](https://aws.amazon.com/about-aws/whats-new/2026/02/amazon-ec2-nested-virtualization-on-virtual)、[対応するインスタンス](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/amazon-ec2-nested-virtualization.html)）。ただし AWS は、性能や遅延に厳しいワークロードではベアメタルを検討するよう勧めている。型の詳細は [actions.md](actions.md) の 8 節。東京での `m7i.metal-48xl` のオンデマンドの価格は 12.4992 ドル/時（2026-09-26 に確認。[On-Demand Pricing](https://aws.amazon.com/ec2/pricing/on-demand/)）。在庫は公開されないので **未検証** とし、E8 の `firecracker-host-poc` の前に AWS の担当と確かめ、必要ならオンデマンドの容量の予約（ODCR）を使う。

staging は、ストレージのノード 6 台（AZ ごとに 2）、その他は最小の台数で持つ。負荷試験のときだけ広げる。dev はストレージを 3 台にし、夜間と週末は Web・API を止める（ストレージのノードは止めない。止めるとデータが消える）。

## 5. バックアップと災害復旧

### 5.1 バックアップ

| 対象 | 方法 | 保持 |
| --- | --- | --- |
| Git のリポジトリ | 大阪の S3 へ、リポジトリごとの差分のバンドルと ref の一覧を直接書く（下の説明） | 35 日（最新の完全な復元点は常に残す。ただし消去したリポジトリは例外で、消去から 35 日で復元点ごと消す。ADR-0030） |
| Aurora | 自動バックアップ（PITR）、AWS Backup の連続バックアップ。1 日 1 回、大阪へスナップショットをコピー | 35 日 |
| Aurora（リージョン間） | Aurora Global Database（大阪は headless の二次クラスタ） | — |
| S3（LFS、Actions の成果物） | バージョニング、東京 → 大阪のレプリケーション（S3 RTC 付き。Actions のキャッシュは対象外） | 削除から 30 日 |
| Valkey、SQS | バックアップしない | 作り直せる |

**Git のバックアップの仕組み。**

- ストレージの側で、push の Event（[ADR-0005](../decisions/0005-git-as-source-of-truth.md)）を受けた backup の Worker が、リポジトリごとに最大 5 分まとめてから、前回のバックアップの ref から新しい ref までの差分を `git bundle`（[git-bundle](https://git-scm.com/docs/git-bundle)）で作り、ref の一覧と一緒に書く。
- 差分が 50 個たまるか、1 週間たったら、完全なバンドルを作り直す（[git-storage.md](git-storage.md) の 9 節）。
- 単位は [git-storage.md](git-storage.md) の 9 節に合わせる：増分はリポジトリごと（そのリポジトリの ref の差分）、完全なバンドルはネットワークごと（`network.git` の objects と、全リポジトリの ref の一覧）。
- **バックアップは、東京ではなく大阪のバケットに直接書く。** 東京のバケットからのレプリケーションに頼ると、S3 RTC でも「99.9% を 15 分以内」なので（[AWS のドキュメント](https://docs.aws.amazon.com/AmazonS3/latest/userguide/replication-time-control.html)）、バックアップの遅れと足して 15 分（NFR-009）を超えうる。直接書けば、遅れはバックアップの Worker の遅れだけになる。目標は p99 10 分、12 分でアラート。
- 1 つの AZ・1 台のノードの喪失は、3 つの複製で守る。バックアップは、リージョンの喪失と、ソフトウェアの誤りで複製がそろって壊れた場合のためにある。
- バケットはバージョニングと S3 Object Lock（ガバナンスモード、35 日）で守る。S3 の耐久性の設計値は 99.999999999% で、3 つ以上の AZ に保存される（[AWS のドキュメント](https://docs.aws.amazon.com/AmazonS3/latest/userguide/DataDurability.html)）。
- **バックアップを確かめる。** 毎日、無作為に選んだ 1,000 のリポジトリを staging ではなく prod の隔離した環境へ復元し、ref の一覧とチェックサム（[ADR-0003](../decisions/0003-replicated-git-storage.md)）が、その時点の本番の複製と一致することを見る。

### 5.2 災害復旧の戦略（段階ごと）

| 段階 | 戦略 | Git | DB | RPO / RTO |
| --- | --- | --- | --- | --- |
| S1 | パイロットライト（大阪） | 大阪の S3 のバックアップから、優先度の順に復元する | Aurora Global Database（headless） | RPO 15 分、RTO 4 時間（NFR-009。範囲は下の注） |
| S2 | 同上。大阪に、ストレージのノードの最小の台数を常に置き、活発なリポジトリの非同期の複製を 1 つ持つ | 活発なリポジトリは複製を昇格、残りはバックアップから | reader を 1 台置く | 同上。RTO の短縮を訓練で確かめる |
| S3 | リポジトリにホームのリージョンを割り当て、他のリージョンに非同期の複製を置く（ADR-0034、proposed） | 複製を昇格 | Global Database | RPO 1 分、RTO 1 時間（目標） |

- **S1 の RTO 4 時間の範囲。** 30 TB のバックアップを 4 時間で全部戻すことは見込めない（[capacity.md](capacity.md) の 2.8 節）。そこで、4 時間以内に戻すものを次に限る。
  - Web・API・DB
  - 直近 7 日に push か fetch のあったリポジトリ（全体の約 20%、約 6 TB と見込む）の読み書き
  - 残りは、アクセスされたものから先に戻し、24 時間以内にすべて戻す。戻るまでは「復元中」と表示し、Git の操作には再試行を促すエラーを返す。
  - この範囲を NFR-009 の定義にした（2026-09-26、既定案。[README.md](README.md) の 3 節と 6 節）。
- **Git と DB の食い違いを直す。** DB（Global Database）の RPO は通常 1 秒未満、Git は最大 15 分なので、切り替えの後、DB が、Git にないコミットを指すことがある（Pull Request の最新のコミットなど）。Git を正とし（ADR-0005）、DB の写しを作り直す。push の Event の記録から、失った push（リポジトリ、ref、新しいコミット）を列挙し、影響を受けた利用者に、もう一度 push するよう知らせる。
- **大阪で落とすもの。** Actions（実行環境のアカウントは大阪に作らない。東京の回復を待つか、別の計画作業で作る）、コード検索（作り直す）。Webhook と通知は、DB の outbox から再開する。
- 大阪に常に置くもの：Aurora の二次クラスタ、Git のバックアップのバケット、S3 のレプリカ、ECR のレプリカ、Secrets Manager のレプリカ、KMS のマルチリージョンキー、空の VPC、ストレージのノードの AMI のコピー。ストレージのノードと ECS は、切り替えのときに Terraform で作る。
- 手順は [runbooks/disaster-recovery.md](../runbooks/disaster-recovery.md)。

### 5.3 AZ の障害（NFR-008）

| 部品 | 動き | 目安 |
| --- | --- | --- |
| Git ストレージ | どのリポジトリも残る 2 つの AZ に複製を 1 つずつ持つ。push は 2 つの合意で成功を返せるので、読み書きが続く。失った AZ の複製は「遅れた複製」として扱う | 即時（ルーティングが不健全なノードを外すまで数秒〜数十秒） |
| Git フロントエンド | NLB・ALB が不健全なターゲットを外す。進行中の clone は切れ、クライアントがやり直す | 数十秒 |
| Aurora | 別の AZ の reader へ自動フェイルオーバー | 1 分前後 |
| ECS | 残る AZ でタスクを起動し直す | 数分 |

- **AZ を失っている間は、ストレージの余裕がない。** 残る 2 つの AZ のどちらかでさらにノードを 1 台失うと、そのノードにあるリポジトリは、合意が取れず push が失敗する（データは失わない）。AZ の障害が 1 時間を超えたら、書き込みの多いリポジトリから順に、残る 2 つの AZ の中に 3 つ目の複製を作る（AZ を分ける規則を一時的に緩める）。AZ が戻ったら、配置を元に戻す（[runbooks/disaster-recovery.md](../runbooks/disaster-recovery.md)）。
- ルーティングの表と権限の判定は DB にあるので、Aurora のフェイルオーバーの間（1 分前後）は、Git フロントエンドのキャッシュにないリポジトリの操作が失敗しうる。キャッシュの方針は [git-protocols.md](git-protocols.md) と [identity-and-permissions.md](identity-and-permissions.md) で決める。

## 6. CI/CD

Slack の仕組み（GitHub Actions、OIDC、1 回ビルドして昇格、Environments の承認）を引き継ぐ。違いは次のとおり。流れは [delivery.md](delivery.md)、手順は [runbooks/deploy-and-rollback.md](../runbooks/deploy-and-rollback.md)。

| 成果物 | 形 | 配り方 |
| --- | --- | --- |
| Web・API・Worker、Git フロントエンド | コンテナイメージ（ECR） | ECS のデプロイ |
| Git のストレージのサービス | Go のバイナリと、固定した版の Git の本体を 1 つにした署名付きの tar（S3） | 独自のデプロイの仕組みが、SSM Run Command で 1 台ずつ入れ替える（ADR-0033） |
| ストレージのノードの AMI | EC2 Image Builder で月 1 回作る | ノードの入れ替え（退避を伴う。ADR-0033） |
| 実行環境のホストの AMI、microVM のイメージ | Image Builder。microVM のイメージは週 1 回 | 実行環境のアカウントへ共有し、ホストを順に入れ替える |

## 7. 環境とデータ

Slack と同じく、本番のデータを prod のアカウントの外に出さない。非公開のリポジトリの中身は、staging・dev に複製しない。staging の負荷試験には、公開の OSS のリポジトリ（ライセンスを確かめたもの）と、生成したリポジトリを使う。

## 8. 段階を上げる判断の基準

| 指標 | S1 → S2 を始める目安 |
| --- | --- |
| ストレージの充填率 | 全体で 60% を超える見込みが 3 か月以内 |
| ストレージのノードの台数 | 150 台を超える見込み（修復と配置の制御の負荷） |
| Git の要求のピーク | 6,000 件/秒（S2 の 30%）を 2 週続けて超える |
| Aurora writer の CPU（ピーク時の p95） | 60% を超える |
| リージョンの障害の RTO | 訓練で、7 日のアクティブなリポジトリの復元が 4 時間に収まらない |

## 9. コストの概算（S1、本番、1 か月）

**大まかな見積もりである（±50%）。** 東京のオンデマンドの料金（Linux、2026-09-26 に確認）で計算した：`i8g.4xlarge` 1.6128 ドル/時（× 730 時間 × 42 台 ≈ 49,000）、`m7i.metal-48xl` 12.4992 ドル/時（× 730 時間 × 平均 18 台 ≈ 164,000。EBS・転送を含めて 180,000 とした）（[On-Demand Pricing](https://aws.amazon.com/ec2/pricing/on-demand/)）。Savings Plans・リザーブドで 20〜40% 下げられる。

| 項目 | 月額（USD、概算） |
| --- | --- |
| Git ストレージ（`i8g.4xlarge` × 42） | 50,000 |
| Actions の実行環境（ベアメタル、平均 18 台。SMT の無効で 1 台約 40 VM） | 180,000 |
| 外向きの転送（CloudFront、NLB） | 25,000（外部の CI からの大量の clone で大きく変わる。bundle-uri と clone の制限で抑える。[git-protocols.md](git-protocols.md) の 8 節） |
| Git フロントエンド、Web・API、Worker（ECS） | 12,000 |
| Aurora（r8g.4xlarge × 3、Global Database） | 7,000 |
| 検索 | 8,000（[search.md](search.md) で決まるまでの仮置き） |
| S3（LFS、Actions、バックアップ）、リージョン間の転送 | 5,000 |
| ElastiCache、SQS、Secrets Manager、KMS ほか | 2,000 |
| 可観測性 | 5,000 |
| NAT、Network Firewall、WAF、GuardDuty など | 4,000 |
| **本番の合計** | **約 300,000** |
| staging・dev・shared | 約 20,000 |

- 最も大きいのは Actions（本番の約 6 割）で、次がストレージと外向きの転送である。Actions の台数は、以前の見積もり（1 台約 90 VM、平均 8 台）から、SMT の無効（ADR-0023）で 2 倍強になった。E8 の PoC で 1 台あたりの VM の数を測って直す。
- 公開リポジトリの大量の clone への対策は、bundle-uri と CDN、リポジトリごと・IP ごとの clone の制限に決めた（[README.md](README.md) の 6 節）。Actions の無料の枠（公開リポジトリは無料、本家と同じ）以外のプランは、MVP の後の課金の Epic で決める。
- コストはアカウント、タグ（`service`、`env`）ごとに毎月見る。

## 10. S3 の複数リージョン

S3（リポジトリ 1 億、20 万件/秒）では、1 つのリージョンの容量と障害の範囲に収まらない。リポジトリ（fork のネットワーク）にホームのリージョンを割り当て、書き込みはホームで受け、他のリージョンに非同期の読み取りの複製を置く案を、[ADR-0034](../decisions/0034-multi-region-repository-placement.md)（proposed）に書いた。S2 の間に staging で試す。

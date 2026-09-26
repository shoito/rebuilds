# Infrastructure: Chrome

クラウドのサービス（更新の配信、同期、アカウント、Safe Browsing のリストの配信、クラッシュの収集、拡張機能のストア、テレメトリ）の AWS の構成、環境、冗長化、災害復旧、CI の基盤、コスト。基盤の選定と災害復旧の方針は [ADR-0033](../decisions/0033-service-infrastructure-and-dr.md) にある。Slack の [infrastructure.md](../../../slack/docs/architecture/infrastructure.md) と、その ADR-0011（ECS Fargate とマネージドサービス）・ADR-0020（Terraform）・ADR-0021（可観測性）・ADR-0022（無停止のデプロイ）を引き継ぐ（[ADR-0001](../decisions/0001-languages-and-platform.md)）。ここには、Chrome に固有のことだけを書く。

数値のうち「初期見積もり」と書いたものは、[capacity.md](capacity.md) の見積もりに基づく仮の値である。AWS の仕様で確かめられていないものは「未検証」と書く。

## 1. AWS アカウントの構成

Slack の構成（management、security、log-archive、shared、dev、staging、prod）を基にし、次の 3 つを足し、本番を 2 つに分ける。

| アカウント | OU | 中身 |
| --- | --- | --- |
| management、security、log-archive、shared | Slack と同じ | Organizations、SCP、IAM Identity Center、監査の記録、ECR、Route 53、Grafana |
| ci | Infrastructure | CI の実行環境（EC2、EC2 Mac の Dedicated Host）、sccache の S3、部品の成果物の S3、ビルドの成果物（署名の前） |
| release-signing | Security | リリースの署名の KMS の鍵、フィールドトライアルと Safe Browsing のリストの署名の鍵、Authenticode・GPG の鍵の CloudHSM、署名専用の実行環境（EC2 Mac を含む） |
| dev、staging | Workloads/NonProd | Slack と同じ |
| prod-core | Workloads/Prod | 更新の配信、Safe Browsing、アカウント、同期、拡張機能のストア、フィールドトライアルの設定の配信 |
| prod-diagnostics | Workloads/Prod | クラッシュの収集とシンボル化、テレメトリの取り込みと分析 |

- **署名の鍵を、専用のアカウントに閉じ込める。** release-signing には、署名の工程のロール以外の経路を作らない。SCP で、KMS の鍵の削除の予約・鍵のポリシーの変更・CloudHSM のクラスタの削除を、management の break-glass のロール以外に禁止する。人の操作は 2 人の承認で有効になるロールだけにし、使うたびに通知する。
- **診断のデータを、他の本番から分ける。** クラッシュのダンプは、利用者のメモリの一部を含みうる（[update-and-release.md](update-and-release.md) の 9 節）。prod-core の運用者が、診断のデータに触れる必要はない。読めるのは、許可された Dev と Ops の読み取りのロールだけ（[observability.md](observability.md) の 6 節）。
- SCP のリージョンの制限は Slack と同じ（東京・大阪、グローバルなサービスのために us-east-1）。S3 の段階で、リージョンを足すときに SCP を変える（ADR-0033）。

## 2. サービスの一覧

| サービス | 入口 | 実行 | データ | 持ち主の文書 |
| --- | --- | --- | --- | --- |
| update-server | CloudFront → ALB（POST） | ECS Fargate | Aurora（リリース、配信の段階） | [update-and-release.md](update-and-release.md) |
| 更新の成果物 | CloudFront → S3（GET） | — | S3（不変のパス） | 同上 |
| 更新の予備のマニフェスト | 別の CloudFront → S3 | — | S3（大阪へ複製） | 同上の 4.4 節 |
| rollout-guard | — | EventBridge Scheduler → Lambda（5 分ごと） | AMP を読み、Aurora に書く | 同上の 4.3 節 |
| Safe Browsing のリスト | CloudFront → S3（GET） | リストの生成は ECS のジョブ | S3 | [safe-browsing-and-permissions.md](safe-browsing-and-permissions.md) |
| Safe Browsing の照会 | CloudFront → ALB | ECS Fargate | 生成したリストのメモリの写し | 同上 |
| フィールドトライアルの設定 | CloudFront → S3（GET） | — | S3 | [update-and-release.md](update-and-release.md) の 12 節 |
| アカウント | CloudFront → ALB | ECS Fargate | [sync-and-accounts.md](sync-and-accounts.md) で決める | [sync-and-accounts.md](sync-and-accounts.md) |
| 同期 | CloudFront → ALB（通知の常時接続を含む） | ECS Fargate | 同上 | 同上 |
| 拡張機能のストア | CloudFront → ALB、パッケージは S3 | ECS Fargate | Aurora、S3 | [extensions.md](extensions.md) |
| crash-ingest、symbolicator | CloudFront → ALB | ECS Fargate、SQS | S3（ダンプ、シンボル）、Aurora（集計） | [update-and-release.md](update-and-release.md) の 9 節 |
| telemetry-ingest | CloudFront → ALB | ECS Fargate → Amazon Data Firehose | S3（Parquet）、AMP（集計） | [observability.md](observability.md) の 3 節 |

- サービスの実装は TypeScript（Hono）で、Slack と同じ形の ECS のサービスにする（ADR-0001）。symbolicator だけは、rust-minidump を使うため Rust で書く。
- **静的にできるものは静的にする。** 更新の成果物、Safe Browsing のリスト、フィールドトライアルの設定は、S3 に置いて CDN で配る。オリジンのサービスが止まっても、端末は配信済みのものを使い続けられる。これが NFR-010 の 99.95% を支える主な手段である（ADR-0033）。
- ネットワーク（VPC、サブネット、VPC エンドポイント、外向きの通信の制限）は Slack の 2 節と同じ。

## 3. CDN とドメイン

| ドメイン | 用途 | キャッシュ |
| --- | --- | --- |
| `update.<brand>.<domain>` | 更新の確認（POST） | しない |
| `dl.<brand>.<domain>` | 成果物（全体・差分） | 長く（パスに内容のハッシュ） |
| `update-fallback.<brand>.<domain>` | 予備のマニフェスト | 5 分 |
| `sb.<brand>.<domain>` | Safe Browsing のリスト | 版ごとのパスは長く、最新の版の指し先は 1 分 |
| `config.<brand>.<domain>` | フィールドトライアルの設定 | 1 分（ETag） |
| `crash.<brand>.<domain>`、`metrics.<brand>.<domain>` | クラッシュ、テレメトリの受け取り | しない |
| `sync.<brand>.<domain>`・`accounts.<brand>.<domain>`・`extensions.<brand>.<domain>` | 各サービス | サービスごと |

- ドメインの `<brand>`・`<domain>` は、開発リポジトリの作成時に決める（[リポジトリ共通の ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。
- **ブラウザとサービスのドメインを、ウェブサイトのドメインと分ける。** 利用者が訪れるサイトの Cookie と混ざらないようにし、ブラウザの通信にだけ使う。
- 更新と予備のマニフェストは、別の CloudFront のディストリビューションにし、別のドメインで持つ。片方の設定の誤りで両方が止まらないようにする。
- CloudFront は、既定で 1 ディストリビューションあたり 150 Gbps・25 万リクエスト/秒まで（[CloudFront のクォータ](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html)）。S2 までは足りる。S3 の緊急の修正の集中に備え、成果物のディストリビューションを分け、上限の引き上げを申請する（[capacity.md](capacity.md) の 2.1 節）。
- 受け取りの経路（crash、metrics）には AWS WAF で IP ごとのレート制限を付ける。WAF のログには IP が残るので、保持は 7 日にする（[observability.md](observability.md) の 6 節）。

## 4. リージョンと段階

| 段階 | 構成 |
| --- | --- |
| S1 | 東京（ap-northeast-1）の 1 リージョン。大阪（ap-northeast-3）に災害復旧の用意。静的な配信は CloudFront の世界のエッジから |
| S2 | 同じ 2 リージョン。同期とクラッシュの収集を分割する（[capacity.md](capacity.md) の 4 節） |
| S3 | 更新の確認と Safe Browsing の照会を、米国・欧州のリージョンにも置き、Route 53 のレイテンシーで振り分ける。同期は [sync-and-accounts.md](sync-and-accounts.md) の方針に従う |

- 状態を持たないサービス（update-server、Safe Browsing の照会）は、どのリージョンでも同じ設定を読むだけなので、リージョンを増やしやすい。配信の段階の設定は、東京の Aurora を正本にし、各リージョンへ読み取りの写しを配る。

## 5. 災害復旧

### 5.1 サービスごとの目標

| サービス | 可用性（NFR-010） | RPO | RTO | 方式 |
| --- | --- | --- | --- | --- |
| 更新の成果物・予備のマニフェスト | 99.95% | 0（リリースの工程が再生成できる） | 数分 | S3 を大阪へ複製。CloudFront のオリジングループで GET を大阪へフェイルオーバー |
| update-server | 99.95% | 15 分（配信の段階の設定） | 1 時間 | 端末は予備のマニフェストに切り替える（[update-and-release.md](update-and-release.md) の 4.4 節）。大阪で ECS を Terraform で作る |
| Safe Browsing のリスト | 99.95% | 0（再生成できる） | 数分 | 成果物と同じ |
| Safe Browsing の照会 | 99.95% | — | 1 時間 | 失敗したら、端末はリストだけで判定を続ける（[safe-browsing-and-permissions.md](safe-browsing-and-permissions.md)） |
| アカウント、同期 | 99.9% | 15 分 | 4 時間 | [sync-and-accounts.md](sync-and-accounts.md) で決める。Slack と同じく Aurora Global Database の二次クラスタ（インスタンスなし）を大阪に置く想定 |
| 拡張機能のストア | 99.9% | 15 分 | 4 時間 | パッケージの S3 を複製。メタデータは同上 |
| クラッシュ・テレメトリ | 99.5% | 失ってよい | 1 日 | 端末が再送する。止まっている間の分は、端末のローカルに残る範囲で後から届く |

- CloudFront のオリジンのフェイルオーバーは、GET・HEAD・OPTIONS にしか効かない（[AWS のドキュメント](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/high_availability_origin_failover.html)）。静的な配信はこれで守り、POST の API はクライアント側の予備の経路と、大阪での再構築で守る。
- **同期のデータの最後の砦は端末である。** 同期のデータはすべての端末が写しを持つ。サーバーのデータを失っても、端末からの再アップロードで大半を戻せる。ただし、これに頼って RPO を緩めない。
- **署名の鍵の災害復旧。** KMS の鍵は、マルチリージョンキーにして大阪にも複製を持つ。CloudHSM は、バックアップを大阪へコピーする。署名ができないと緊急の修正を出せないので、署名の工程の切り替えも年 1 回の訓練に含める。
- 大阪への切り替えの手順は、Slack の [disaster-recovery.md](../../../slack/docs/runbooks/disaster-recovery.md) を基に、Chrome の `disaster-recovery.md` として E10 で作る（[runbooks/README.md](../runbooks/README.md) の 4 節）。訓練の頻度は同じく 5 節。

### 5.2 AZ の障害

Slack の 5.3 節と同じ。各サービスは、残る 2 AZ で最大負荷をさばけるよう、平常時の使用率を 2/3 以下に保つ。

## 6. CI とリリースの基盤

```
PR・merge queue ─▶ ci アカウントの実行環境（Linux・Windows は EC2、macOS は EC2 Mac）
                     │ sccache（S3）、部品の成果物（S3）
                     ▼
               署名の前の成果物（ci の S3。不変）
                     │ リリースの工程だけが起動できる
                     ▼
               release-signing：再現性の確認 → OS の署名・公証 → リリースの署名（KMS）
                     │
                     ▼
               prod-core の S3（成果物）＋ Aurora（リリースの登録）─▶ 段階的な配信
```

- 実行環境の種類と台数：

  | 種類 | 用途 | S1 の台数（初期見積もり） |
  | --- | --- | --- |
  | Linux x64 の大きなインスタンス（64 vCPU 級） | presubmit、CQ、WPT、ファズ | オートスケール 4〜40 |
  | Windows x64（32 vCPU 級） | CQ、継続 | 2〜16 |
  | GPU のインスタンス（Linux・Windows） | 画面の比較、WebGL・WebGPU | 2〜6 |
  | EC2 Mac（Apple silicon） | macOS のビルドとテスト、性能 | 常時 6 ホスト |
  | bare metal（Linux・Windows） | 性能の測定 | 各 2 |
  | EC2 Mac（release-signing） | macOS の署名と公証 | 常時 2 ホスト |

- EC2 Mac は Dedicated Host の上でだけ動き、最低 24 時間の確保が要り、オンデマンドのみ（[AWS のドキュメント](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-mac-instances.html)）。台数を固定で持ち、Savings Plans で費用を抑える。
- GitHub Actions からの AWS への認証は OIDC（Slack と同じ）。release-signing のロールは、`release/*` のブランチと `main` の Canary のワークフローの、`environment:release` の主体だけが引き受けられる。
- Windows の署名は、CloudHSM の鍵を SignTool から KSP 経由で使う（[CloudHSM と SignTool](https://docs.aws.amazon.com/cloudhsm/latest/userguide/third-signtool-toplevel.html)）。macOS の署名の鍵の置き場は未検証（[update-and-release.md](update-and-release.md) の 5.2 節）。
- サービスのデプロイは Slack の delivery.md と同じ（イメージを 1 回ビルドし、dev → staging → prod へ昇格。prod は Ops の承認）。

## 7. 環境とデータ

| 環境 | 目的 | ブラウザから見た接続先 |
| --- | --- | --- |
| local | 開発、エージェントの確認ループ | サービスの偽物（テストの中で立ち上げる） |
| dev | 結合の確認 | 開発版のブラウザが、コマンドラインの指定で接続する |
| staging | リリースの工程の通し試験、負荷試験 | 社内の Canary が接続する |
| prod | 本番 | 配布する版 |

- 配布する版は、本番のエンドポイントと、本番の公開鍵（リリース、CUP、フィールドトライアル、Safe Browsing）だけを埋め込む。開発版とテスト版は別の公開鍵を使い、本番の鍵で署名されたものを受け付けない。逆も同じ。
- 本番のデータ（特にクラッシュのダンプ）を本番のアカウントの外に出さない（Slack の 7 節）。

## 8. コストの概算（S1、1 か月）

**大まかな見積もりである。** 東京リージョンのオンデマンド料金をもとにした、±50% の幅を持つ値。料金の表で確かめていない項目がある。

| 項目 | 月額（USD、概算） |
| --- | --- |
| サービスの ECS Fargate（同期・アカウントを除く） | 600 |
| Aurora（サービスの設定・ストア・クラッシュの集計） | 800 |
| 同期・アカウント | [sync-and-accounts.md](sync-and-accounts.md) で見積もる |
| CloudFront、データ転送（月 5〜6 TB） | 700 |
| 可観測性（ログ、メトリクス、トレース、Grafana） | 1,000 |
| セキュリティのサービス（WAF、GuardDuty など） | 500 |
| **本番（同期を除く）の合計** | **約 3,600** |
| CloudHSM（2 台、release-signing） | 約 2,500（未検証） |
| CI（Linux・Windows・GPU のオートスケール） | 約 15,000 |
| CI（EC2 Mac 8 ホスト、性能の bare metal） | 約 8,000 |
| **CI と署名の合計** | **約 25,000** |

- S1 では、費用の大半がサービスではなく CI にかかる。CQ の中身と、継続の段の頻度で調整する（[build-and-test.md](build-and-test.md) の 4 節）。
- S3 では、CloudFront の転送（月 5 PB 程度）が最大の費用になる。CloudFront の料金の割引の契約を、S2 のうちに検討する。

## 9. 段階を上げる判断の基準

| 指標 | S1 → S2 を始める目安 | S2 → S3 を始める目安 |
| --- | --- | --- |
| 月間の利用者 | 300 万の見込み | 3,000 万の見込み |
| 更新の確認のピーク | 500/秒 | 5,000/秒 |
| 同期の常時接続 | 50 万 | [sync-and-accounts.md](sync-and-accounts.md) で決める |
| 緊急の修正の配信の帯域 | 50 Gbps の見込み（上限の引き上げを申請） | 100 Gbps の見込み（ディストリビューションを分ける） |
| 地理 | — | 日本の外の利用者が半分を超え、更新の確認の p95 が 1 秒を超える |

# Decisions: GitHub

GitHub の再構築に関する決定。リポジトリ共通の決定は [docs/decisions/](../../../../docs/decisions/README.md) にある（特に [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)：本家の名前を識別子に使わない）。領域ごとの設計と、各 ADR の位置づけは [architecture/](../architecture/README.md) を見る。

<!-- adr-index:start -->
| ADR | 決定 | 状態 |
| --- | --- | --- |
| [0001](0001-platform-and-stack.md) | 基盤は他の題材を引き継ぎ、Git の層だけ Go と Git の本体で作る | accepted |
| [0002](0002-repository-permission-model.md) | 権限はリポジトリの単位の判定関数に集約し、テナントの RLS は使わない | accepted |
| [0003](0003-replicated-git-storage.md) | リポジトリは、アプリケーションの層で 3 つのノードに複製する | accepted |
| [0004](0004-stateless-git-frontend.md) | Git の要求は、状態を持たないフロントエンドで受けて、複製へ振り分ける | accepted |
| [0005](0005-git-as-source-of-truth.md) | リポジトリの中身の正本は Git、メタデータの正本は DB にする | accepted |
| [0006](0006-ref-update-consensus.md) | ref の更新は、3 つの複製で 3 相の手順を回し、DB のチェックサムの CAS で順序を決める | accepted |
| [0007](0007-fork-network-object-sharing.md) | fork はネットワークごとの共有の objects（alternates）で持ち、ネットワークを配置の単位にする | accepted |
| [0008](0008-pack-caching-and-bundle-cdn.md) | clone の負荷は、ビットマップ、ノードのパックのキャッシュ、人気の公開リポジトリの bundle-uri と CDN で下げる | accepted |
| [0009](0009-lfs-storage-on-s3.md) | LFS の objects は、ネットワークごとの S3 のキーに置き、presigned URL で直接転送する | accepted |
| [0010](0010-server-side-merge-and-diff.md) | 差分とマージは、ストレージの RPC で作業ツリーなしに計算し、SHA の組でキャッシュする | accepted |
| [0011](0011-rulesets-as-single-protection-model.md) | ブランチの保護は ruleset に一本化し、1 つの評価関数で push とマージの両方を判定する | accepted |
| [0012](0012-merge-queue-with-speculative-groups.md) | merge queue は、投機的なグループの ref を作り、検査を通った SHA を早送りで取り込む | accepted |
| [0013](0013-untrusted-content-domain-isolation.md) | 利用者の内容は、アプリとは別の登録可能ドメインから配り、豊かな描画は隔離した iframe で行う | accepted |
| [0014](0014-code-search-engine.md) | コード検索は Zoekt をリポジトリの単位のシャードで独立したクラスタに置き、Issue・PR・リポジトリの検索は OpenSearch に置く | accepted |
| [0015](0015-search-permission-filtering.md) | 検索の権限は、読めるリポジトリの条件をクエリの前段に入れ、権限の属性の変更は除外の表で即時に効かせる | accepted |
| [0016](0016-notification-fanout.md) | 通知は、スレッドの購読とリポジトリの watch から受け手を決め、outbox → SQS の多段で配り、送る直前に権限を確かめ直す | accepted |
| [0017](0017-shared-issue-numbering.md) | Issue と Pull Request は 1 つの表に置き、リポジトリごとの 1 つの番号の列を、リポジトリの行の計数で採番する | accepted |
| [0018](0018-repository-roles-and-permission-composition.md) | リポジトリの権限は、本家と同じ 5 つのロールの最大値で決める | accepted |
| [0019](0019-authentication-and-token-model.md) | Web のログインは Better Auth、プログラムからのアクセスは細粒度のトークンを既定にする | accepted |
| [0020](0020-github-app-model.md) | 外部との連携の主な形を、本家と同じ GitHub App（インストールと 1 時間のトークン）にする | accepted |
| [0021](0021-api-shape-and-versioning.md) | 公開 API は本家の形に寄せ、REST は日付の版をヘッダーで選び、GraphQL は版を持たずに育てる | accepted |
| [0022](0022-webhook-signing-and-delivery.md) | Webhook は本家と同じ HMAC-SHA256 で署名し、隔離した egress から送り、送る直前に権限を確かめる | accepted |
| [0023](0023-firecracker-microvm-runners.md) | ホストされたランナーは、EC2 の metal の上の Firecracker の microVM で、1 ジョブ 1 VM・使い捨てにする | accepted |
| [0024](0024-job-scheduling-and-fairness.md) | ジョブは持ち主ごとの同時実行の上限と、持ち主の間の公平な順番で配る | accepted |
| [0025](0025-secrets-and-fork-pr-policy.md) | シークレットはジョブの取得時にだけ復号して渡し、fork の Pull Request には渡さない。`<BRAND>_TOKEN` はジョブごとの最小の権限にする | accepted |
| [0026](0026-actions-oidc-provider.md) | 自前の OIDC の発行者を持ち、ジョブごとの短命の ID トークンを KMS の鍵で署名する | accepted |
| [0027](0027-artifact-and-cache-storage.md) | 成果物・キャッシュ・ログは S3 にリポジトリ単位で置き、キャッシュは ref の単位で分ける | accepted |
| [0028](0028-encryption-and-key-management.md) | 通信はすべて TLS、保存時は KMS の鍵をデータの種類ごとに分け、最も価値の高い秘密情報だけアプリ層で暗号化する | accepted |
| [0029](0029-audit-log.md) | 管理の操作は同じトランザクションで監査ログに書き、Git のイベントとアクセスログは別の流れで集め、改ざんできないアーカイブへ送る | accepted |
| [0030](0030-data-retention-and-deletion.md) | 削除したリポジトリは 90 日の間は復元でき、その後に消去する。アカウントの削除は復元せず、バックアップの期限を削除の最終的な期限にする | accepted |
| [0031](0031-storage-nodes-on-instance-store.md) | Git のストレージのノードは、EC2 のローカル NVMe（インスタンスストア）に置く | accepted |
| [0032](0032-disaster-recovery-strategy.md) | 災害復旧は、AZ を 3 つの複製で、リージョンを大阪の S3 へのバックアップと Aurora Global Database で守る | accepted |
| [0033](0033-rolling-storage-node-upgrades.md) | ストレージのノードは、1 つの AZ の中で 1 台ずつ退避して更新し、AZ をまたいで同時に止めない | accepted |
| [0034](0034-multi-region-repository-placement.md) | S3 では、リポジトリにホームのリージョンを割り当て、他のリージョンに非同期の読み取りの複製を置く | proposed |
| [0035](0035-web-rendering-ssr-streaming.md) | Web は React をサーバーでストリーム描画し、画面の単位でハイドレーションする | accepted |
<!-- adr-index:end -->

この一覧は、各 ADR の frontmatter と見出しから生成したもの。ADR を追加・更新したら生成し直す。

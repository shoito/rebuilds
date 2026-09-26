# Decisions: Slack

Slack の再構築に関する決定。リポジトリ共通の決定は [docs/decisions/](../../../../docs/decisions/README.md) にある。領域ごとの設計と、各 ADR の位置づけは [architecture/](../architecture/README.md) を見る。

<!-- adr-index:start -->
| ADR | 決定 | 状態 |
| --- | --- | --- |
| [0001](0001-per-channel-sequence.md) | メッセージの順序付けにチャンネル内連番 `seq` を使う | accepted |
| [0002](0002-db-as-source-of-truth-with-outbox.md) | DB を唯一の正本とし、配信はベストエフォートにする。連携は transactional outbox で行う | accepted |
| [0003](0003-redis-pubsub-for-fanout.md) | リアルタイム配信のバスに Redis Pub/Sub を使う | accepted |
| [0004](0004-postgres-fulltext-search-first.md) | 検索は PostgreSQL＋pg_bigm で始める | accepted |
| [0005](0005-single-authorization-check.md) | 権限判定を 1 つの関数に集約する | accepted |
| [0006](0006-message-body-ast.md) | メッセージ本文を独自の軽量 AST（JSON）で保存する | accepted |
| [0007](0007-typescript-stack.md) | TypeScript で統一した技術スタックを使う | accepted |
| [0008](0008-hono-rpc-for-api-contract.md) | API の契約を Hono RPC の型で共有する | accepted |
| [0009](0009-pooled-tenancy-with-rls.md) | テナントは共有スキーマ（pool）で持ち、PostgreSQL の RLS で分離を強制する | accepted |
| [0010](0010-accounts-and-workspace-members.md) | グローバルなアカウントと、ワークスペースごとのメンバーを分ける | accepted |
| [0011](0011-aws-container-platform.md) | AWS 上で、ECS Fargate とマネージドサービスを使って動かす | accepted |
| [0012](0012-self-hosted-auth-with-better-auth.md) | 認証は Better Auth で自前でホストし、ワークスペースとメンバーは自前のモデルで持つ | accepted |
| [0013](0013-gateway-scaling-and-presence.md) | Gateway を水平に増やし、購読をノードごとに集約する。在席は TTL と必要な分だけの購読で扱う | accepted |
| [0014](0014-sqs-worker-queues-and-notification-delivery.md) | Relay と Worker の間に SQS の標準キューを置き、通知は冪等な多段の処理で配送する | accepted |
| [0015](0015-file-upload-scan-and-delivery.md) | ファイルは署名付き PUT で直接上げ、GuardDuty でスキャンし、CloudFront の短命な署名付き URL で配る | accepted |
| [0016](0016-isolated-link-unfurling.md) | リンクのプレビューは、VPC の外で権限を持たない取得器で行う | accepted |
| [0017](0017-encryption-and-key-management.md) | 通信はすべて TLS、保存時は KMS のカスタマー管理キーで暗号化し、秘密情報は Secrets Manager で自動ローテーションする | accepted |
| [0018](0018-audit-log.md) | 監査ログは操作と同じトランザクションで DB に書き、改ざんできないアーカイブへ送る | accepted |
| [0019](0019-data-retention-and-deletion.md) | 保持ポリシーとリーガルホールドを持ち、削除は論理削除から非同期の物理削除へ流す。バックアップの期限を削除の最終的な期限にする | accepted |
| [0020](0020-infrastructure-as-code-with-terraform.md) | インフラを Terraform で定義する | accepted |
| [0021](0021-observability-stack.md) | OpenTelemetry で計装し、メトリクスは Managed Prometheus、トレースは X-Ray、ログは CloudWatch Logs に送る | accepted |
| [0022](0022-zero-downtime-deploy-and-migrations.md) | 無停止でデプロイし、スキーマは expand / contract で変える | accepted |
| [0023](0023-cell-based-architecture.md) | S3 でセル構成に移る | proposed |
| [0024](0024-client-data-layer-and-offline.md) | Web クライアントのデータ層を Timeline ストア＋TanStack Query にし、接続を SharedWorker に集め、オフラインの保存に IndexedDB を使う | accepted |
| [0025](0025-product-analytics-with-ga4.md) | 利用状況の分析に Google Analytics 4 を使う | accepted |
| [0026](0026-feature-flags.md) | フィーチャーフラグの種類と運用を決める | accepted |
| [0027](0027-search-table-rls-exception.md) | 検索用のテーブルだけ RLS を外し、関数を経由してしか読めないようにする | accepted |
| [0028](0028-remote-mcp-server.md) | AI エージェント向けに、リモートの MCP サーバーを提供する | accepted |
| [0029](0029-rate-limiting.md) | レート制限を、層・主体・テナントの共通の枠組みで行う | accepted |
| [0030](0030-versioned-public-api.md) | 版を持つ公開 API を、内部の API と別の面として提供する | accepted |
| [0031](0031-app-platform.md) | アプリの基盤を、インストール単位のボット、署名付きの HTTPS の配送、宣言的な UI で作る | accepted |
| [0032](0032-plans-and-entitlements.md) | プランごとの上限と機能を、ワークスペースの entitlement として持つ | accepted |
| [0033](0033-slack-aligned-platform-and-plan-decisions.md) | プラン、アプリの配布と審査、ボットの投稿の枠、配送の記録を、本家 Slack に寄せて決める | accepted |
<!-- adr-index:end -->

後の ADR で一部を改めた ADR：[0018](0018-audit-log.md)、[0026](0026-feature-flags.md)、[0028](0028-remote-mcp-server.md)、[0029](0029-rate-limiting.md)、[0031](0031-app-platform.md)、[0032](0032-plans-and-entitlements.md)。改めた内容は、各 ADR の注記にある。

この一覧は、各 ADR の frontmatter と見出しから生成したもの。当面は ADR を追加・更新したら生成し直す。生成と差分の検査は、rebuilds の CI（これから用意する）で行う。開発リポジトリの `ci-pipeline` の対象ではない（手で編集する一覧は衝突しやすいため。[process.md](../../../../docs/process.md) の「衝突の防止」）。

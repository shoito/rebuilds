---
status: accepted
date: 2026-09-28
---

# ADR-0054: アカウントを管理・監査・本番・送信で分け、本番の VPC の中で対話・管理・一括・Worker・コードの実行を別のサービスとロールにする。送信の VPC と監査のアカウントは本体への経路を持たない

詳細は [infrastructure.md](../architecture/infrastructure.md) の 1〜3 節。

## Context

- [ADR-0001](0001-platform-and-stack.md) は、Runtime・Metadata・Bulk・Worker を別の ECS のサービスにした。
- [ADR-0035](0035-webhooks-outbound-calls-and-ssrf-guard.md) は、Webhook・外向きの呼び出しを、本体・DB・VPC エンドポイントへの経路を持たない送信の VPC から送るとした。
- [ADR-0046](0046-setup-audit-trail-and-login-history.md) は、監査の錨を本体とは別の監査のアカウントの S3（Object Lock）に置くとし、置き場所を security・infrastructure の領域に任せた。
- [ADR-0033](0033-change-event-log-and-replay.md) は、変更のイベントを主の Aurora と別の `events` のクラスタに置いた。
- [ADR-0048](0048-user-code-engine-quickjs-ng-on-wasmtime-fuel.md) は、利用者のコードを Runtime のタスクの中の別のコンテナで動かすとした。
- rebuilds の他の題材（Auth0 の ADR-0057、Stripe の ADR-0025）は、アカウントの分け方と、送信の網の分け方を決めている（[auth0 の ADR-0057](../../../auth0/docs/decisions/0057-accounts-network-and-path-separation.md)）。

## Options

1. **管理（management）、security、log-archive（監査の錨を含む）、shared、edge、nonprod、prod、prod-egress（送信の VPC）のアカウントに分ける。S3 のセルでは、セルごとに prod と prod-egress の組を持つ**
2. 本番を 1 つのアカウントにし、送信と監査もその中の VPC・バケットで分ける
3. サービスごとにアカウントを分ける

## Decision

1 を採用する。

- **log-archive**：組織の CloudTrail、Config、VPC フローログ、監査の錨と監査の外部の保管（Object Lock のコンプライアンスのモード）。本番のアカウントの Worker には、錨・保管のバケットへの `PutObject` だけを与える。削除・保持の短縮は、どのロールにも許さない。
- **prod-egress**：Webhook・外向きの呼び出し・メールの送り手（`sender`）と、Elastic IP 付きの NAT。本番の VPC とのピアリング・Transit Gateway・VPC エンドポイントを持たない。本番の Worker は、署名済みの要求を SQS（prod-egress のアカウントのキュー、`SendMessage` だけ許す）に入れ、送り手は SQS から取り出して送る。結果は別のキューで戻す。
- **prod の VPC**：public（ALB、NAT）、private（`runtime`・`metadata`・`bulk`・`worker`・`relay`・`indexer`）、isolated（Aurora の主・`events`、Valkey、OpenSearch）。private からインターネットへの送信は、Network Firewall の許可リスト（SES、IdP の既知の宛先はなく、SSO の IdP のメタデータの取得は送信の VPC 経由）に限る。
  > 2026-09-28 の注記：isolated には、項目の変更の履歴の `history` のクラスタも置く（[ADR-0047](0047-field-history-tracking-and-retention.md) の注記）。private には `cross-org-worker` も置く（[infrastructure.md](../architecture/infrastructure.md) の 2.1 節）。
- サービスごとにタスクのロールと DB のロールを分ける。DB のロールは `app_runtime`（RLS あり）、`app_worker`（RLS あり）、`admin_cross_org`（組織の作成・Sandbox の複製・組織の移動だけ。RLS を外す。Worker の専用のサービス `cross-org-worker` だけが使う）、`maint`（分割の `DROP`・射影の DDL）。
- **code-runner**：Runtime と Worker のタスクの中の別のコンテナ。タスクのロールの権限を使えないよう、コンテナに資格情報の環境変数を渡さず、IMDS の相当（タスクのメタデータのエンドポイント）への経路は WASM の中から持たない（WASI を渡さないので、ソケットがない）。
- 2 は、1 つのアカウントの管理者の権限の侵害で、監査の錨と送信の網の分離が同時に破れる。3 は、サービスの間の呼び出しとデプロイが重い。

## Consequences

- 良くなること：
  - 監査の錨を、本番の管理者の権限でも消せない。
  - 送信の網の宛先の検査に漏れがあっても、本番の資源へ届かない。
  - 組織をまたぐ処理（RLS を外す）が 1 つのサービスと 1 つの DB のロールに閉じる。
- 引き受けるコスト：
  - アカウントをまたぐ SQS とログの配信の設定が増える。
  - 送信の結果の戻りが非同期で、Webhook の配信の遅れが数百 ms 増える。

## Confirmation

- IaC の検査：prod-egress のアカウントに、prod への経路（ピアリング、TGW、VPC エンドポイント、ロールの引き受け）がない。
- IaC の検査：`admin_cross_org` の DB のロールの資格情報を、`cross-org-worker` 以外のタスクのロールが読めない。
- SCP：log-archive のバケットの Object Lock の設定の変更と、保持の短縮を拒否する。

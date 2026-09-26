# Architecture: Slack

全体像と横断的な方針。領域ごとの設計は、同じディレクトリの各ファイルにある。

| ファイル | 領域 |
| --- | --- |
| [data-model.md](data-model.md) | データモデル、テナントのコンテキスト |
| [identity-and-access.md](identity-and-access.md) | 認証、セッション、SSO、招待、ロールと権限 |
| [messaging.md](messaging.md) | 投稿・編集・削除・スレッド・リアクション・メンション、本文、リンクのプレビュー |
| [realtime.md](realtime.md) | Gateway、購読、ファンアウト、在席・入力中、再接続と差分取得 |
| [read-state-and-notifications.md](read-state-and-notifications.md) | 既読・未読、通知（Web Push、メール）、通知設定 |
| [search.md](search.md) | 全文検索、インデックス、権限の適用 |
| [files.md](files.md) | ファイルのアップロード、スキャン、サムネイル、配信 |
| [client.md](client.md) | Web クライアント |
| [mcp.md](mcp.md) | AI エージェント向けのリモート MCP サーバー |
| [public-api.md](public-api.md) | 版付きの公開 API（MVP の後、E12） |
| [apps.md](apps.md) | アプリのプラットフォーム：インストール、イベントの配信、インタラクティブ（MVP の後、E12） |
| [security.md](security.md) | 脅威モデル、暗号化、監査ログ、濫用対策、データのライフサイクル |
| [infrastructure.md](infrastructure.md) | AWS の構成、環境、IaC、冗長化、バックアップと災害復旧、デプロイ、コスト |
| [observability.md](observability.md) | ログ、メトリクス、トレース |
| [capacity.md](capacity.md) | 負荷のモデル、部品ごとの必要量、パラメーターの設定、キャパシティの運用 |
| [delivery.md](delivery.md) | ブランチ、CI、デプロイ、リリース、フィーチャーフラグ |
| [rate-limiting.md](rate-limiting.md) | レート制限、同時実行の制限、テナント単位の上限、プランごとの値 |

## 1. 全体構成

```
                ┌──────────────┐
  Browser ──────┤  CDN / LB    │
   │  ▲         └──────┬───────┘
   │  │ WebSocket      │ HTTPS
   │  │                ▼
   │  │         ┌──────────────┐   write (tx: message + outbox)   ┌────────────┐
   │  │         │  API server  │ ───────────────────────────────▶ │ PostgreSQL │
   │  │         └──────────────┘                                   └─────┬──────┘
   │  │                                                                  │ outbox
   │  │         ┌──────────────┐   subscribe ws:..:ch ┌───────────┐     ▼
   │  └─────────┤   Gateway    │ ◀─────────────────── │   Redis   │ ◀── Relay
   │            │ (WS 常時接続)│                       │  Pub/Sub  │     │
   │            └──────────────┘                       └───────────┘     │
   │                                                                     ▼
   │ upload (presigned URL)                             ┌──────────────────────┐
   └──────────────────────────▶ Object Storage (S3)     │ Workers              │
                                                        │  - search indexer    │
                                                        │  - notification      │
                                                        │  - thumbnail         │
                                                        └──────────────────────┘
```

| コンポーネント | 責務 |
| --- | --- |
| API server | 認証・認可、書き込みのすべて、履歴取得。**状態を持たない** |
| Gateway | WebSocket 接続の保持、購読管理、イベントのファンアウト。書き込みはしない |
| Relay | outbox テーブルを順に読み、Redis と各 Worker 向けキューに流す |
| Workers | 検索インデックス更新、通知（メール / Web Push）、サムネイル生成 |
| PostgreSQL | 唯一の正本（source of truth） |
| Redis | リアルタイム配信用のバス。**失われてもよい**（クライアントが差分取得で回復する） |

ポイントは **書き込み経路（API → DB）と配信経路（Relay → Gateway）を分ける** こと（[ADR-0002](../decisions/0002-db-as-source-of-truth-with-outbox.md)）。配信が落ちてもデータは失われず、クライアントは再接続時の差分取得で追いつく。

## 2. 規模の段階

最初から最大規模の構成にはしない。段階ごとに、構成を変える地点を決めておく。

| 段階 | 同時接続 | 最大ワークスペースの人数 | 構成 |
| --- | --- | --- | --- |
| S1（MVP） | 5 万 | 5,000 | 1 リージョン（東京）・3 AZ。DB は writer 1 台＋reader 1 台。Valkey は 1 シャード。検索は PostgreSQL。災害復旧は、大阪にインスタンスなしの Aurora Global Database の二次クラスタを置く |
| S2 | 25 万 | 20,000 | DB の reader を増やす。Redis をクラスタにし、sharded pub/sub を使う。検索を OpenSearch へ移す（ADR-0004）。巨大チャンネル向けのファンアウト経路を分ける |
| S3 | 100 万 | 100,000 | セル構成：1 つのセルがスタック一式を持ち、ワークスペースをセルに割り当てる。大口のワークスペースには専用のセルを割り当てる。災害復旧用に大阪リージョンを使う |

段階を上げる判断の基準は、[infrastructure.md](infrastructure.md) に書く。

## 3. 非機能要件

| ID | 項目 | S1 の目標 | 備考 |
| --- | --- | --- | --- |
| NFR-001 | 規模 | 1 ワークスペース最大 5,000 人、全体で同時接続 5 万 | S2・S3 は 2 節 |
| NFR-002 | 送信 → 他者の画面に表示 | p99 500ms 以内（同一リージョン） | |
| NFR-003 | メッセージ投稿 API | p99 200ms 以内 | |
| NFR-004 | 可用性 | 月間 99.9% | S3 で 99.95% |
| NFR-005 | 耐久性 | 投稿 API が成功を返したメッセージは失わない | |
| NFR-006 | 検索への反映 | 投稿から 10 秒以内 | |
| NFR-007 | 復旧（AZ の障害） | RPO 0、RTO 5 分以内 | 自動フェイルオーバー |
| NFR-008 | 復旧（リージョンの障害） | RPO 15 分以内、RTO 4 時間以内 | S3 で RPO 1 分、RTO 1 時間 |
| NFR-009 | テナント分離 | 別のワークスペースのデータが見える事象は 0 件 | ADR-0009 |
| NFR-010 | 通知の遅延 | DM と @メンバーの Web Push を、投稿から p95 5 秒以内に送信する | [read-state-and-notifications.md](read-state-and-notifications.md) の 10 節。送信までを測る（端末への到達は Push サービスに依存するため含めない） |

## 4. 技術スタック

| 層 | 選定 | AI エージェント視点での理由 |
| --- | --- | --- |
| 言語 | TypeScript（フロント・バック共通） | 型を API 契約として共有でき、エージェントが境界をまたいでも整合を保ちやすい |
| API | Hono RPC＋Zod | API の型をクライアントが直接参照し、生成を挟まずに契約を共有できる。入出力の変更が型検査の失敗として即座に見える（ADR-0008） |
| Gateway | Node.js＋`ws` | 同じ言語・同じイベント型を使える |
| DB | PostgreSQL 18＋Drizzle | SQL に近く、生成されるクエリが読みやすい。マイグレーションをレビューしやすい。18 は `uuidv7()` を標準で持つ（ADR-0009） |
| Web | React＋TanStack Query＋Vite | 学習データが多く、エージェントの出力品質が安定する |
| テスト | Vitest、fast-check、Testcontainers、Playwright | 実 DB・実ブラウザで検証でき、モックで誤魔化せない |
| ローカル環境 | Docker Compose（Postgres、Valkey、MinIO） | エージェントが 1 コマンドで起動・破棄できる |
| 認証 | Better Auth（自前でホスト） | TypeScript で、Hono・Drizzle と組み合わせられる。MCP の認可にも使える（ADR-0012、0028） |
| 実行基盤 | AWS（ECS Fargate、Aurora、ElastiCache、SQS、S3、CloudFront） | ADR-0011 |
| IaC | Terraform | 変更を plan で読んでから承認できる（ADR-0020） |
| 可観測性 | OpenTelemetry（ADOT）→ AMP、X-Ray、CloudWatch Logs、Grafana | ADR-0021 |
| フィーチャーフラグ | AWS AppConfig | ADR-0026 |
| 利用状況の分析 | Google Analytics 4（許可リストのイベントだけ） | ADR-0025 |
| AI エージェントとの接続 | リモート MCP サーバー（MCP 2026-07-28、公式 TypeScript SDK v2） | ADR-0028 |

詳細は [ADR-0007](../decisions/0007-typescript-stack.md)、API の契約の持ち方は [ADR-0008](../decisions/0008-hono-rpc-for-api-contract.md)。

## 5. 主な決定

| ADR | 決定 |
| --- | --- |
| [0001](../decisions/0001-per-channel-sequence.md) | 順序付けはチャンネル内連番 `seq` |
| [0002](../decisions/0002-db-as-source-of-truth-with-outbox.md) | DB を唯一の正本とし、配信はベストエフォート。連携は transactional outbox |
| [0003](../decisions/0003-redis-pubsub-for-fanout.md) | リアルタイム配信のバスは Redis Pub/Sub |
| [0004](../decisions/0004-postgres-fulltext-search-first.md) | 検索は PostgreSQL＋pg_bigm で始める |
| [0005](../decisions/0005-single-authorization-check.md) | 権限判定を 1 つの関数に集約する |
| [0006](../decisions/0006-message-body-ast.md) | 本文は独自の軽量 AST（JSON） |
| [0007](../decisions/0007-typescript-stack.md) | TypeScript で統一した技術スタック |
| [0008](../decisions/0008-hono-rpc-for-api-contract.md) | API の契約を Hono RPC の型で共有する。WebSocket イベントは Zod スキーマで検証する |
| [0009](../decisions/0009-pooled-tenancy-with-rls.md) | テナントは共有スキーマで持ち、RLS で分離を強制する。ID は UUIDv7 |
| [0010](../decisions/0010-accounts-and-workspace-members.md) | グローバルなアカウントと、ワークスペースごとのメンバーを分ける |
| [0011](../decisions/0011-aws-container-platform.md) | AWS 上で、ECS Fargate とマネージドサービスを使って動かす |
| [0012](../decisions/0012-self-hosted-auth-with-better-auth.md) | 認証は Better Auth で自前でホストし、ワークスペースとメンバーは自前のモデルで持つ |
| [0013](../decisions/0013-gateway-scaling-and-presence.md) | Gateway を水平に増やし、購読をノードごとに集約する。在席は TTL と必要な分だけの購読 |
| [0014](../decisions/0014-sqs-worker-queues-and-notification-delivery.md) | Relay と Worker の間に SQS。通知は冪等な多段の処理 |
| [0015](../decisions/0015-file-upload-scan-and-delivery.md) | ファイルは署名付き PUT、GuardDuty でスキャン、短命な署名付き URL で配る |
| [0016](../decisions/0016-isolated-link-unfurling.md) | リンクのプレビューは、VPC の外で権限を持たない取得器（Lambda）で行う。ADR-0011 の例外 |
| [0017](../decisions/0017-encryption-and-key-management.md) | TLS、KMS のカスタマー管理キー、Secrets Manager の自動ローテーション |
| [0018](../decisions/0018-audit-log.md) | 監査ログは同じトランザクションで DB に書き、改ざんできないアーカイブへ送る |
| [0019](../decisions/0019-data-retention-and-deletion.md) | 保持ポリシーとリーガルホールド。論理削除から非同期の物理削除へ |
| [0020](../decisions/0020-infrastructure-as-code-with-terraform.md) | インフラを Terraform で定義する |
| [0021](../decisions/0021-observability-stack.md) | OpenTelemetry で計装し、AMP・X-Ray・CloudWatch Logs に送る |
| [0022](../decisions/0022-zero-downtime-deploy-and-migrations.md) | 無停止のデプロイと、expand / contract のスキーマ変更 |
| [0023](../decisions/0023-cell-based-architecture.md) | S3 でセル構成に移る（proposed） |
| [0024](../decisions/0024-client-data-layer-and-offline.md) | クライアントは Timeline ストア＋TanStack Query、SharedWorker、IndexedDB |
| [0025](../decisions/0025-product-analytics-with-ga4.md) | 利用状況の分析に GA4 を使う。送る内容と読み込む条件を絞る |
| [0026](../decisions/0026-feature-flags.md) | フィーチャーフラグの種類と運用 |
| [0027](../decisions/0027-search-table-rls-exception.md) | 検索用のテーブルだけ RLS を外し、関数を経由してしか読めないようにする |
| [0028](../decisions/0028-remote-mcp-server.md) | AI エージェント向けに、リモートの MCP サーバーを提供する |
| [0029](../decisions/0029-rate-limiting.md) | レート制限を、層・主体・テナントの共通の枠組みで行う |
| [0030](../decisions/0030-versioned-public-api.md) | 版付きの公開 API を、内部 API と分けて提供する（MVP の後） |
| [0031](../decisions/0031-app-platform.md) | アプリのプラットフォーム（インストール、ボット、イベントの配信、インタラクティブ） |
| [0032](../decisions/0032-plans-and-entitlements.md) | プランごとの上限と機能を、ワークスペースの entitlement として持つ |
| [0033](../decisions/0033-slack-aligned-platform-and-plan-decisions.md) | プラン、アプリの配布と審査、ボットの投稿の枠、配送の記録を、本家 Slack に寄せて決める |

リポジトリ共通の決定（開発プロセス、ブランチモデル）は、ルートの [docs/decisions/](../../../../docs/decisions/) にある。

## 6. リスクと未解決事項

- **巨大チャンネル（数千人）のファンアウト**：1 投稿あたり数千件の push になる。Gateway 側で購読をチャンネル単位にまとめ、Redis からの受信を Gateway 1 台につき 1 回にする設計で足りるかは、負荷試験で確認する。
- **`last_seq` 採番のホットスポット**：全社アナウンスのように書き込みが集中するチャンネルでは、行ロックの待ちが発生しうる。書き込み頻度は低いため問題になりにくいと見込むが、計測する。
- **RLS の性能と設定漏れ**：ポリシーの条件が全クエリに加わる。`workspace_id` を先頭にしたインデックスで足りるかを、負荷試験で確認する。コンテキストの設定漏れは 0 件になる（安全側に倒れる）が、「データが消えた」ように見える不具合として現れるため、検知しにくい。
- **テナント間の負荷の偏り**：大きなワークスペース 1 つが共有 DB と Gateway を占有しうる。テナント単位の上限とレート制限（runbooks）で抑え、足りなければ ADR-0009 の「将来の拡張」へ移る。
- **未読数の正確さ**：近似で許容したが、「未読 3 件と出ているのに見当たらない」はユーザーの不信を招く。
- **データ保持と削除**：保持期間ポリシーやリーガルホールドは MVP に含めていない。E8 で扱う（ADR-0019、ADR-0033）。
- **マネージドサービスの対応状況**：2026-09 に確認済み。Aurora PostgreSQL は PostgreSQL 18（`uuidv7()`）と pg_bigm に対応し、大阪リージョンも Aurora PostgreSQL 18.3 以降の Global Database に対応している（ADR-0011 の Confirmation）。残るのは、大阪の二次クラスタをインスタンスなしで持ち、切り替え前にインスタンスを足す手順を、実環境で試すことだけ（[infrastructure.md](infrastructure.md)）。
- **検索の RLS の例外**：`search` スキーマだけは、テナントの分離を関数の実装に頼る（ADR-0027）。関数の変更のレビューと、性質ベーステストで守る。
- **認証の基盤への依存**：Better Auth の脆弱性（例：SSO プラグインの CVE-2026-53515、1.6.11 で修正）の影響を直接受ける。使うエンドポイントを許可リストで絞り、勧告を監視する（ADR-0012）。
- **ブラウザの対応**：SharedWorker と Web Push の対応は、ブラウザと OS の版に依存する。下限は Safari 17 に決めた（[client.md](client.md) の 13 節）。
- **第三者のスクリプト**：GA4 を読み込むワークスペースでは、CSP が広がる（ADR-0025）。
- **AI エージェントの書き込み**：MCP の書き込みは、プロンプトインジェクションで誤用されうる。既定で無効にし、レート制限と監査で抑える（ADR-0028）。
- **外部との互換性**：公開 API とアプリ（E12）は、提供を始めると互換性を長く保つ義務が生じる。版の方針（ADR-0030）と OpenAPI の破壊的変更の検査で守る。
- **レート制限の基盤**：判定のたびに Valkey へ 1 往復する。Valkey の障害中は、一般の制限が緩くなる（ADR-0029）。

### 決定（2026-09-26、既定案）

PM の方針（本家 Slack に寄せる、既定案）により、次のとおり決めた。上のリスクのうち、計測で確かめるものは決定の対象にせず、下の「持ち越し」に置いた。

- **対応ブラウザの下限は Safari 17**（macOS・iOS / iPadOS）。本家のモバイルアプリの下限（iOS 17）に合わせ、半年ごとに見直す（[client.md](client.md) の 13 節）。
- **通知の遅延を NFR にする（NFR-010）。** DM と @メンバーの Web Push を、投稿から p95 5 秒以内に送信する。本家は数値を公開していないが、「取りこぼさない」（[intent.md](../intent.md)）の価値を測るために、PM の案のまま NFR にした。runbooks の SLI と quality.md の E5 の合否基準に加えた。
- **@channel / @here / @everyone の制限は、本家に合わせる。** 提案の「1,000 人以上のチャンネルで制限」ではなく、本家の規則にした。
  - 参加者が 6 人以上のチャンネルでは送信前に確認を求める。owner・admin は確認を無効にできる。
  - owner・admin は使えるロールを絞れる。
  - 参加者が 10,000 人以上のチャンネルでは、@channel / @here を owner・admin だけが使える。
  - スレッドの返信の中では通知しない。
  - 出典：[Notify a channel or workspace](https://slack.com/help/articles/202009646-Notify-a-channel-or-workspace)、[Manage who can notify a channel or workspace](https://slack.com/help/articles/115004855143-Manage-who-can-notify-a-channel-or-workspace)（2026-09-26 に確認）。詳細は [messaging.md](messaging.md) の「誰が使えるか」。E3 の `mentions-and-broadcast` の spec で決定表にする。
- **監査ログの保持**は [ADR-0033](../decisions/0033-slack-aligned-platform-and-plan-decisions.md) で決めた（DB に 1 年、アーカイブに 2 年）。解決済み。
- 領域ごとの問いの決定は、各文書の「決定（2026-09-26、既定案）」にある：[client.md](client.md)、[security.md](security.md)、[identity-and-access.md](identity-and-access.md)、[search.md](search.md)、[mcp.md](mcp.md)、[public-api.md](public-api.md)、[apps.md](apps.md)。

持ち越し（計測・PoC・後の段階で決めるもの）：

| 項目 | いつ・どう決めるか |
| --- | --- |
| 巨大チャンネルのファンアウト、`last_seq` のホットスポット、RLS の性能 | E7 の `capacity-load-tests`（k6）で計測して判断する。足りなければ E10 の `large-channel-path` へ |
| 大阪の headless の二次クラスタの切り替え手順 | 対応状況は確認済み（ADR-0011）。E1 の `terraform-foundation` の後、staging で手順を試す |
| S3 で Global が止まったときの、キャッシュの切れたセッションの扱い | E11。ADR-0023（proposed）を accepted にする前に決める（[infrastructure.md](infrastructure.md) の 10.2 節） |
| iOS の PWA のバックグラウンドでの接続の寿命 | E4 の着手前に、実機の PoC で測る（[client.md](client.md) の 3.4 節） |

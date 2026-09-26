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
| [security.md](security.md) | 脅威モデル、暗号化、監査ログ、濫用対策、データのライフサイクル |
| [infrastructure.md](infrastructure.md) | AWS の構成、環境、IaC、冗長化、バックアップと災害復旧、デプロイ、コスト |
| [observability.md](observability.md) | ログ、メトリクス、トレース |

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
| S1（MVP） | 5 万 | 5,000 | 1 リージョン（東京）・3 AZ。DB は writer 1 台＋reader 1 台。Redis は 1 シャード。検索は PostgreSQL |
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

## 4. 技術スタック

| 層 | 選定 | AI エージェント視点での理由 |
| --- | --- | --- |
| 言語 | TypeScript（フロント・バック共通） | 型を API 契約として共有でき、エージェントが境界をまたいでも整合を保ちやすい |
| API | Hono RPC＋Zod | API の型をクライアントが直接参照し、生成を挟まずに契約を共有できる。入出力の変更が型検査の失敗として即座に見える（ADR-0008） |
| Gateway | Node.js＋`ws` | 同じ言語・同じイベント型を使える |
| DB | PostgreSQL 18＋Drizzle | SQL に近く、生成されるクエリが読みやすい。マイグレーションをレビューしやすい。18 は `uuidv7()` を標準で持つ（ADR-0009） |
| Web | React＋TanStack Query＋Vite | 学習データが多く、エージェントの出力品質が安定する |
| テスト | Vitest、fast-check、Testcontainers、Playwright | 実 DB・実ブラウザで検証でき、モックで誤魔化せない |
| ローカル環境 | Docker Compose（Postgres、Redis、MinIO） | エージェントが 1 コマンドで起動・破棄できる |

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

## 6. リスクと未解決事項

- **巨大チャンネル（数千人）のファンアウト**：1 投稿あたり数千件の push になる。Gateway 側で購読をチャンネル単位にまとめ、Redis からの受信を Gateway 1 台につき 1 回にする設計で足りるかは、負荷試験で確認する。
- **`last_seq` 採番のホットスポット**：全社アナウンスのように書き込みが集中するチャンネルでは、行ロックの待ちが発生しうる。書き込み頻度は低いため問題になりにくいと見込むが、計測する。
- **RLS の性能と設定漏れ**：ポリシーの条件が全クエリに加わる。`workspace_id` を先頭にしたインデックスで足りるかを、負荷試験で確認する。コンテキストの設定漏れは 0 件になる（安全側に倒れる）が、「データが消えた」ように見える不具合として現れるため、検知しにくい。
- **テナント間の負荷の偏り**：大きなワークスペース 1 つが共有 DB と Gateway を占有しうる。テナント単位の上限とレート制限（runbooks）で抑え、足りなければ ADR-0009 の「将来の拡張」へ移る。
- **未読数の正確さ**：近似で許容したが、「未読 3 件と出ているのに見当たらない」はユーザーの不信を招く。
- **データ保持と削除**：保持期間ポリシーやリーガルホールドは MVP に含めていないが、企業利用では早い段階で要求される。

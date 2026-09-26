# Architecture: GitHub

全体像と横断的な方針。領域ごとの設計は、同じディレクトリの各ファイルにある。

| ファイル | 領域 |
| --- | --- |
| [git-storage.md](git-storage.md) | リポジトリの保存、3 つの複製、ルーティング、fork のネットワーク、保守（repack） |
| [git-protocols.md](git-protocols.md) | HTTPS・SSH、プロトコル v2、push の受け付けと ref の更新、LFS、大きなリポジトリ |
| [pull-requests.md](pull-requests.md) | 差分、マージの計算、レビュー、ブランチの保護（ruleset）、merge queue |
| [web.md](web.md) | Web の画面、コードの閲覧、信頼できない内容（Markdown・SVG・ノートブック）の安全な描画 |
| [issues.md](issues.md) | Issue、ラベル、マイルストーン、参照（相互リンク） |
| [notifications.md](notifications.md) | 通知の購読、配信、メール |
| [search.md](search.md) | コード検索と、リポジトリ・Issue・Pull Request の検索 |
| [identity-and-permissions.md](identity-and-permissions.md) | ユーザー、Organization、チーム、ロール、SSH の鍵、トークン、SSO |
| [api-and-webhooks.md](api-and-webhooks.md) | REST・GraphQL、Webhook、OAuth のアプリと GitHub App、レート制限 |
| [actions.md](actions.md) | CI：ワークフロー、ジョブのスケジューリング、実行環境の隔離、シークレット、ログ、成果物、キャッシュ |
| [security.md](security.md) | 脅威モデル、暗号化、監査ログ、濫用対策、データのライフサイクル |
| [data-model.md](data-model.md) | データモデルの索引 |
| [infrastructure.md](infrastructure.md) | AWS の構成、ストレージのノード、冗長化、災害復旧 |
| [observability.md](observability.md) | ログ、メトリクス、トレース、SLO |
| [capacity.md](capacity.md) | 負荷のモデル、部品ごとの必要量、パラメーター |
| [delivery.md](delivery.md) | CI/CD、リリース、フィーチャーフラグ |

## 1. 全体構成

```
git（HTTPS・SSH）──▶ Git フロントエンド（認証・認可・ルーティング）──▶ Git ストレージ（3 つの複製）
ブラウザ・API ─────▶ Web・API（Rails に相当するアプリ層）──────────┤
                        │  メタデータ（PR・Issue・権限）: Aurora    │ リポジトリの読み取り（RPC）
                        │  outbox ──▶ SQS ──▶ Worker              │
                        │               ├─ 通知・メール              │
                        │               ├─ 検索の索引（コード・Issue）│
                        │               ├─ Webhook の配信（外向き）   │
                        │               └─ Actions のスケジューラ ──▶ 実行環境（使い捨ての VM）
```

| コンポーネント | 責務 |
| --- | --- |
| Git フロントエンド | SSH と HTTPS の Git の要求を受け、認証・認可し、リポジトリの複製のあるノードへ振り分ける。状態を持たない |
| Git ストレージ | リポジトリを 3 つのノードに複製して保持する。読み取り（差分、ファイル、マージの計算）の RPC を提供する |
| Web・API | 画面、REST、GraphQL。メタデータを DB に持ち、Git の中身はストレージの RPC で読む |
| Worker | 通知、検索の索引、Webhook、Actions のジョブの配置 |
| Actions の実行環境 | ジョブごとに使い捨ての VM で、ワークフローを実行する |

原則は 3 つ。

- **リポジトリの中身の正本は Git。** DB は、Pull Request・Issue・権限などのメタデータの正本であり、ref やコミットの複製は、検索や表示のための写しとして扱う（[ADR-0005](../decisions/0005-git-as-source-of-truth.md)）。
- **権限はリポジトリの単位で、1 つの判定関数で決める。** 公開リポジトリをまたいだ読み取りが本質なので、テナントの RLS ではなく、リポジトリへの権限の判定に集約する（[ADR-0002](../decisions/0002-repository-permission-model.md)）。
- **信頼できない入力を実行・描画する部分を隔離する。** CI のジョブ、Markdown・SVG の描画、Webhook の外向きの送信は、それぞれ隔離された環境で行う。

## 2. 規模の段階

| 段階 | リポジトリ | 1 日の利用者 | Git の要求（ピーク） | 構成 |
| --- | --- | --- | --- | --- |
| S1（MVP） | 100 万 | 10 万 | 2,000 件/秒 | 1 リージョン（東京）・3 AZ。ストレージのノードは数十台 |
| S2 | 1,000 万 | 100 万 | 20,000 件/秒 | ストレージのノードを数百台に。コード検索の索引を独立したクラスタに |
| S3 | 1 億 | 1,000 万 | 200,000 件/秒 | 複数のリージョン。リポジトリをリージョンに割り当て、読み取りの複製を他のリージョンに置く |

## 3. 非機能要件

| ID | 項目 | S1 の目標 | 備考 |
| --- | --- | --- | --- |
| NFR-001 | 可用性（Git の操作、Web、API） | 月間 99.95% | |
| NFR-002 | push の耐久性 | 成功を返した push は失われない（3 つの複製のうち 2 つ以上に書いてから成功を返す） | |
| NFR-003 | clone・fetch の速さ | 中規模のリポジトリ（1 GB 未満）の fetch の開始まで p95 1 秒以内 | |
| NFR-004 | Web の表示 | Pull Request の画面の表示 p95 1.5 秒以内（差分 1,000 行まで） | |
| NFR-005 | 検索への反映 | Issue・Pull Request は 10 秒、コードはデフォルトブランチへの push から 5 分以内 | |
| NFR-006 | Webhook の配信 | 最初の配信の p95 10 秒以内 | |
| NFR-007 | Actions のジョブの開始 | キューに入ってから実行の開始まで p95 60 秒以内（ホストされた標準の実行環境） | |
| NFR-008 | 復旧（AZ の障害） | RPO 0、RTO 5 分以内 | |
| NFR-009 | 復旧（リージョンの障害） | RPO 15 分以内、RTO 4 時間以内 | S3 で改善 |
| NFR-010 | 非公開のリポジトリの秘匿 | 権限のない人に中身が見える事象は 0 件 | |

## 4. 技術スタック

| 層 | 選定 | 理由 |
| --- | --- | --- |
| Web・API・Worker | TypeScript（Hono、React） | Slack・Stripe と同じ（[ADR-0001](../decisions/0001-platform-and-stack.md)） |
| Git ストレージ・フロントエンド | Go と Git の本体（`git` のコマンド、必要に応じて libgit2 に相当するライブラリ） | Git の操作と長時間の I/O に向く。本家の Spokes・GitLab の Gitaly と同じ考え方 |
| コード検索 | Rust か既存の検索エンジン（[search.md](search.md) で決める） | |
| DB | Aurora PostgreSQL 18 | |
| 非同期 | outbox → SQS | |
| 実行基盤 | AWS（ECS、EC2 のストレージのノード、Actions の実行環境の VM） | |
| IaC・可観測性 | Terraform、OpenTelemetry | Slack と同じ |

## 5. 主な決定

| ADR | 決定 |
| --- | --- |
| [0001](../decisions/0001-platform-and-stack.md) | 基盤は他の題材を引き継ぎ、Git の層だけ Go と Git の本体で作る |
| [0002](../decisions/0002-repository-permission-model.md) | 権限はリポジトリの単位の判定関数に集約し、テナントの RLS は使わない |
| [0003](../decisions/0003-replicated-git-storage.md) | リポジトリは、アプリケーションの層で 3 つのノードに複製する |
| [0004](../decisions/0004-stateless-git-frontend.md) | Git の要求は、状態を持たないフロントエンドで受けて、複製へ振り分ける |
| [0005](../decisions/0005-git-as-source-of-truth.md) | リポジトリの中身の正本は Git。DB はメタデータの正本 |

領域ごとの ADR は、各文書から参照する。

## 6. リスクと未解決事項

- **巨大なリポジトリと大量の clone**：少数のリポジトリが、ストレージのノードと帯域を占有しうる（[git-protocols.md](git-protocols.md)、[capacity.md](capacity.md)）。
- **CI の隔離**：信頼できないコードを大量に実行する。隔離の破綻は、他の利用者のシークレットの漏洩につながる（[actions.md](actions.md)）。
- **権限の漏れ**：公開と非公開、fork、Organization の権限が絡み合う（[identity-and-permissions.md](identity-and-permissions.md)）。

# Architecture: Notion

全体像と横断的な方針。領域ごとの設計は、同じディレクトリの各ファイルにある。

| ファイル | 領域 |
| --- | --- |
| [block-model.md](block-model.md) | ブロックのデータモデル、ページの木、同期ブロック、履歴 |
| [editor.md](editor.md) | エディタ、リッチテキスト、ブロックの種類、クライアントの構成 |
| [collaboration.md](collaboration.md) | 同時編集の方式、変更の配信、在席、オフラインと統合 |
| [databases.md](databases.md) | データベース、プロパティ、ビュー、フィルタ、リレーション、ロールアップ、数式、問い合わせ |
| [permissions-and-sharing.md](permissions-and-sharing.md) | ワークスペース、チームスペース、ページの権限と継承、ゲスト、公開、アカウント |
| [search.md](search.md) | 全文検索、権限の適用 |
| [comments-and-notifications.md](comments-and-notifications.md) | コメント、メンション、通知 |
| [api-and-integrations.md](api-and-integrations.md) | 公開 API、Webhook、インポートとエクスポート |
| [security.md](security.md) | 脅威モデル、暗号化、監査ログ、データのライフサイクル |
| [data-model.md](data-model.md) | データモデルの索引 |
| [infrastructure.md](infrastructure.md) | AWS の構成、シャード、冗長化、災害復旧 |
| [observability.md](observability.md) | ログ、メトリクス、トレース、SLO |
| [capacity.md](capacity.md) | 負荷のモデル、部品ごとの必要量、パラメーター |
| [delivery.md](delivery.md) | CI/CD、リリース、フィーチャーフラグ |

## 1. 全体構成

```
ブラウザ・デスクトップ（ローカルの保存：SQLite（WASM）/ IndexedDB）
   │  HTTPS（読み込み・API）         │ WebSocket（変更の送受信・在席）
   ▼                                  ▼
 API ─── 変更の受け付け（操作の検証・権限・順序付け）──▶ Aurora（ワークスペースで論理シャード）
   │                                       │ outbox
   │                                       ▼
   │                         Relay ─▶ 配信のバス ─▶ Sync Gateway（WebSocket）
   │                                       └─▶ Worker（検索の索引、通知、ファイル、Webhook）
   └── ファイル（S3・CloudFront）
```

| コンポーネント | 責務 |
| --- | --- |
| API | 読み込み、検索、データベースの問い合わせ、共有の設定。変更の受け付けと検証 |
| Sync Gateway | WebSocket の接続、ページ単位の購読、変更と在席の配信 |
| Aurora | ブロック・操作の記録・権限の正本。ワークスペースを単位に論理シャードに分ける |
| Worker | 検索の索引、通知、ファイルの処理、Webhook、エクスポート |
| クライアントのローカルの保存 | 開いたページとブロックの写し、未送信の変更の待ち行列（オフライン） |

原則は 3 つ。

- **すべてはブロック。** ページもデータベースの行も、ブロックの一種として同じ仕組みで保存・同期・権限の判定をする（[ADR-0002](../decisions/0002-everything-is-a-block.md)）。
- **ワークスペースで分け、ワークスペースで閉じる。** テナントの境界はワークスペースで、Slack と同じく RLS で分ける。シャードもワークスペースで決め、1 つの操作が 1 つのシャードで閉じるようにする（[ADR-0003](../decisions/0003-workspace-sharding.md)）。
- **権限はページの木を継承する。** ブロックの権限は、祖先のページの設定から決まる。判定の関数を 1 つにし、検索・通知・API・リレーションのすべてが通る（[ADR-0004](../decisions/0004-inherited-page-permissions.md)）。

## 2. 規模の段階

| 段階 | 利用者 | ブロック | 同時接続 | 構成 |
| --- | --- | --- | --- | --- |
| S1（MVP） | 10 万 | 10 億 | 1 万 | 1 リージョン（東京）。Aurora の 1 クラスタに論理シャード 480 を持つ（物理は 1） |
| S2 | 1,000 万 | 1,000 億 | 100 万 | 論理シャードを複数の物理クラスタに分ける。検索と分析を独立したクラスタに |
| S3 | 1 億 | 数千億 | 1,000 万 | 物理クラスタを増やし、データレイクを分析と AI の基盤にする。複数のリージョン |

論理シャードの数（480）は、本家の値に合わせ、S1 から固定する（[Herding elephants](https://www.notion.com/blog/sharding-postgres-at-notion)）。物理の数だけを段階で増やす。

## 3. 非機能要件

| ID | 項目 | S1 の目標 | 備考 |
| --- | --- | --- | --- |
| NFR-001 | 同時編集の反映 | 入力から、同じページを開いた他の利用者の画面まで p99 500ms 以内（同一リージョン） | |
| NFR-002 | ページの表示 | 1,000 ブロックのページの表示 p75 1.5 秒以内（キャッシュなし）、300ms 以内（ローカルにあるとき） | |
| NFR-003 | データベースの問い合わせ | 1 万行のデータベースのビューの表示 p95 1 秒以内 | |
| NFR-004 | 耐久性 | 受け付けた変更（サーバーが確定したもの）は失わない | |
| NFR-005 | オフライン | オフラインで行った編集は、再接続時にすべて統合される | |
| NFR-006 | 検索への反映 | 編集から 30 秒以内 | |
| NFR-007 | 可用性 | 月間 99.9% | |
| NFR-008 | 復旧（AZ の障害） | RPO 0、RTO 5 分以内 | |
| NFR-009 | 復旧（リージョンの障害） | RPO 15 分以内、RTO 4 時間以内 | |
| NFR-010 | 権限の分離 | 権限のないページの中身が見える事象は 0 件 | |

## 4. 技術スタック

| 層 | 選定 | 理由 |
| --- | --- | --- |
| 言語 | TypeScript（クライアント・API・Worker） | 他の題材と同じ（[ADR-0001](../decisions/0001-platform-and-stack.md)） |
| クライアント | React、ローカルの保存に SQLite（WASM、OPFS）か IndexedDB | [editor.md](editor.md) と [collaboration.md](collaboration.md) で決める |
| デスクトップ | Web のクライアントを包む（Electron か Tauri） | [editor.md](editor.md) で決める |
| DB | Aurora PostgreSQL 18。論理シャード | |
| 配信 | WebSocket の Gateway と、配信のバス（Slack の設計に倣う） | |
| 実行基盤・IaC・可観測性 | AWS、Terraform、OpenTelemetry | 他の題材と同じ |

## 5. 主な決定

| ADR | 決定 |
| --- | --- |
| [0001](../decisions/0001-platform-and-stack.md) | 基盤は他の題材を引き継ぐ |
| [0002](../decisions/0002-everything-is-a-block.md) | すべてをブロックとして持つ |
| [0003](../decisions/0003-workspace-sharding.md) | ワークスペースで RLS と論理シャードを決める |
| [0004](../decisions/0004-inherited-page-permissions.md) | 権限はページの木を継承し、1 つの判定関数で決める |
| [0005](../decisions/0005-transactions-as-unit-of-change.md) | 変更は、操作をまとめたトランザクションで送り、サーバーで順序を確定する |

領域ごとの ADR は、各文書から参照する。

## 6. リスクと未解決事項

- **巨大なページ・データベース**：ブロック数万のページ、行数十万のデータベースでの表示と問い合わせ（[databases.md](databases.md)、[capacity.md](capacity.md)）。
- **権限の継承の計算**：深い木と多数の共有の設定で、判定が重くなる（[permissions-and-sharing.md](permissions-and-sharing.md)）。
- **オフラインの長時間の編集**：統合の結果が、利用者の意図とずれる場合（[collaboration.md](collaboration.md)）。

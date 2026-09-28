---
status: accepted
date: 2026-09-28
---

# ADR-0001: 共通の基盤を引き継ぎ、記録の基盤を自前で実装する。本家のスクリプトの API との互換は求めない

## Context

rebuilds の他の題材（Slack、Stripe、Auth0 など）で、次の基盤を決めている。

- AWS（東京、DR は大阪。ECS Fargate、Aurora PostgreSQL 18、ElastiCache Valkey、SQS、S3・CloudFront、KMS）
- TypeScript（Hono＋Zod）
- Terraform、OpenTelemetry、AWS AppConfig のフィーチャーフラグ、トランクベース開発

この題材には、他の題材にない性質がある。

- **メタデータ駆動の記録の基盤である。** テナントがテーブルとフィールドを足し、フォーム・ACL・フロー・SLA を設定する。コードはメタデータを解釈する。
- **長く続く処理がある。** 承認は数日、SLA は数週間、変更の予定は数か月にわたる。
- **全文検索と集計が主な機能である。** ナレッジの検索、チケットの検索、ダッシュボードの集計が要る。
- **メールが主な入口の 1 つである。** サービスデスクへのメールを受けてチケットにする。

本家は、インスタンスごとのアプリの処理と DB の処理（[ADR-0002](0002-tenancy-and-isolation.md)。アプリの言語と DB の製品は、公式の資料で確かめられなかったため未検証。本家の振る舞いで、この決定の前提ではない）の上に、テーブルの辞書、サーバーとクライアントの JavaScript のスクリプト（レコードを操作する API、Business Rules、クライアントのスクリプト）、Flow Designer を載せている（[Table extension and classes](https://www.servicenow.com/docs/r/platform-administration/table-administration-and-data-management/table-extension-and-classes.html)、[Flows, subflows, and actions reference](https://www.servicenow.com/docs/bundle/yokohama-build-workflows/page/administer/flow-designer/reference/flow-designer-reference.html)、2026-09-28 に確認）。

リポジトリ共通の [ADR-0007](../../../../docs/decisions/0007-no-reuse-of-original-implementation.md) により、本家の実装は核に使えない。

## Options

1. **共通の基盤を引き継ぎ、記録の基盤（辞書、ACL、ワークフロー、SLA、CMDB の調整）を自前で実装する。** 検索に OpenSearch、メールに SES を足す
2. **共通の基盤に加え、本家のスクリプトの API に似せた層を作る。** 本家からの移行を楽にする
3. **既存の OSS の ITSM・ローコードの基盤を土台にする**（例：iTop、GLPI、Frappe Framework と Helpdesk）
4. **汎用のローコードの SaaS・BaaS の上に作る**

## Decision

1 を採用する。

### 実行基盤と技術

- 実行基盤・言語・IaC・可観測性・フラグは、他の題材と同じにする。題材をまたいで、エージェントと人が同じ道具で検証できる。
- 共通の基盤に、次を足す。

| 用途 | 部品 | 理由 |
| --- | --- | --- |
| 全文検索 | Amazon OpenSearch Service | ナレッジとチケットの日本語の全文検索。解析器は search の領域で選ぶ |
| メールの受信と送信 | Amazon SES（東京。大阪も受信に対応） | 東京・大阪とも受信のエンドポイントがある（[Amazon SES endpoints and quotas](https://docs.aws.amazon.com/general/latest/gr/ses.html)、2026-09-28 に確認）。DR でも国内に留まる |
| ワークフローとタイマー | Aurora の上の自前のエンジン | [ADR-0004](0004-workflow-and-sla-engine.md) |
| 画面 | React の SPA | メタデータからフォームとリストを描く。portal-and-ui の領域で決める |

- App（画面・API）、Engine（フロー・タイマー）、Ingest（メール・CMDB の取り込み）、Notifier、Indexer を、別の ECS のサービスにする。取り込みとフローの負荷が、画面の速さ（NFR-001）を落とさないようにする。
- レコードの読み書きは、共有のライブラリ Record Service だけを通す（[ADR-0003](0003-table-hierarchy-and-extensible-schema.md)）。

### 拡張の方針：コードではなく設定

- **テナントに任意のコードを書かせない（MVP）。** 本家の Business Rules・クライアントのスクリプトに当たるものは、ノーコードの「レコードのルール」（条件と、決まった種類の操作）と、フロー（[ADR-0004](0004-workflow-and-sla-engine.md)）で置き換える。
- 条件と式は、自前の小さな式の言語（比較、論理、日付の計算、参照のたどり）で書く。評価器は純粋な関数にし、副作用を持たせない。
- テナントのコードの実行（カスタムアプリの開発）は、MVP の後に、隔離の設計を別の ADR で決める。

### 2・3・4 を選ばなかった理由

- **2（本家のスクリプトの API に似せる）**：移行は楽になる。ただし、本家の API の振る舞い（暗黙の ACL、ドット参照の遅延の読み込み、同期のルールの順序）を写すことになり、ADR-0007 の趣旨（核を自分で設計する）に反する。任意のコードの実行の隔離も MVP で必要になる。
- **3（OSS の ITSM）**：iTop・GLPI は PHP、Frappe は Python で、他の題材の道具と揃わない。マルチテナントの RLS、耐久性のあるワークフロー、CMDB の調整の設計を、外から変えるのが難しい。これらの製品のマルチテナントの運用の実績は、公開の資料で確かめられなかった（未検証。選ばない理由は前の 2 文で足りる）。
- **4（ローコードの SaaS）**：テナントの分離、データの所在（intent の L3）、SLA の計時の正しさを、自分で保証できない。

## Consequences

- 良くなること：
  - 他の題材と同じ道具・CI・運用を使える。
  - テナントが任意のコードを持たないので、全テナントを同じ版に保ちやすい（[ADR-0002](0002-tenancy-and-isolation.md)）。性能と権限の問題の多くを、設定の上限で抑えられる。
- 引き受けるコスト：
  - 本家のスクリプトに頼る顧客は、そのまま移行できない。ノーコードで表せない要件は、Webhook と外部の処理で受ける。
  - 式の言語とフローの DSL を、自前で設計・保守する。
  - OpenSearch と SES の運用が増える。

## Confirmation

- 依存の一覧のレビュー：本家の実装・本家のスクリプトの互換の層が入っていないこと（ADR-0007）。
- lint：App・Engine・Ingest のパッケージから、DB のテナントテーブルへの直接の SQL を禁止し、Record Service を通すことを強制する（例外は許可リストで管理する）。
- CI：式の言語の評価器に、副作用のある組み込みの関数がないことを、組み込みの関数の一覧の検査で確かめる。

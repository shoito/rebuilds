---
status: accepted
date: 2026-09-28
---

# ADR-0001: 共通の基盤を引き継ぎ、メタデータの実行基盤を自前で作る。本家の言語との互換は持たない

## Context

rebuilds の他の題材（Slack、Stripe、Notion、Auth0 など）で、次の基盤を決めている。

- AWS（東京、DR は大阪。ECS Fargate、Aurora PostgreSQL 18、ElastiCache Valkey、SQS、S3・CloudFront、KMS）、全文検索に OpenSearch
- TypeScript（Hono＋Zod）
- Terraform、OpenTelemetry、AWS AppConfig のフィーチャーフラグ、トランクベース開発

この題材の核は、次の 4 つである。

- メタデータで動く実行基盤（組織ごとのオブジェクト・項目・画面・自動化を、実行時に解釈する）
- 1 つの共有の DB でのカスタムオブジェクトの保存（[ADR-0002](0002-custom-object-storage.md)）
- レコードの共有とアクセスの再計算（[ADR-0004](0004-record-access-model.md)）
- 組織ごとの実行の上限（[ADR-0005](0005-tenancy-and-governor-limits.md)）

本家は、利用者のコードの言語として Apex を、問い合わせの言語として SOQL・SOSL を持つ。本家の多くの組織は Apex で業務の処理を書いている。互換を持てば移行は楽になるが、言語の実行系を本家に合わせて作ることになる。

[リポジトリ共通の ADR-0007](../../../../docs/decisions/0007-no-reuse-of-original-implementation.md) は、本家の実装を題材の核に使うことを禁じ、新しい題材の土台の ADR でそれを確かめるよう求めている。

## Options

基盤について：

1. **他の題材の基盤を引き継ぐ**
2. **この題材のために選び直す**（例：レコードの保存に分散 SQL の DB を使う）

利用者によるカスタマイズの言語について：

- a. **宣言的な設定を先にする。** MVP は、数式・入力規則・フロー・承認だけにする。利用者のコードは MVP の後に足す
- b. **独自の TypeScript の砂場を MVP から持つ。** 利用者が TypeScript でトリガーを書き、隔離した JS の実行系で動かす
- c. **WASM を MVP から受け付ける。** 利用者が任意の言語で書き、WASM にして持ち込む
- d. **Apex と互換の言語を作る**

## Decision

1 と a を採用する。MVP の後の利用者のコードは、TypeScript で書き、WASM の砂場で動かす方針にする。

### 基盤

- 実行基盤・言語・IaC・可観測性・フラグは、他の題材と同じにする。題材をまたいで、エージェントと人が同じ道具で検証できる。
- Aurora PostgreSQL 18 を唯一の正本にする。RLS で組織を分け（[ADR-0005](0005-tenancy-and-governor-limits.md)）、カスタムオブジェクトも同じ共有の表に入れる（[ADR-0002](0002-custom-object-storage.md)）。
- Valkey は、コンパイル済みのメタデータのキャッシュと、上限・割り当ての数に使う。失われてもよい。
- OpenSearch は、全文検索の索引にだけ使う。正本の写しで、作り直せる。本家も、全文検索は別の検索の基盤で非同期に索引を作っている（[Platform Multitenant Architecture](https://architect.salesforce.com/docs/architect/fundamentals/guide/platform-multitenant-architecture.html)、2026-09-28 に確認）。
- 対話の経路（Runtime）、管理の経路（Metadata）、一括の受付（Bulk）、Worker を別の ECS のサービスにする。一括の処理と共有の再計算が、対話の経路の資源を食わないようにする。
- 2 は、分散 SQL の DB（Aurora DSQL など）で書き込みを広げられる。ただし、Aurora DSQL は 1 トランザクションで変えられる行が 3,000 まで、分離の水準は Repeatable Read に固定、PL/pgSQL と一時表を持たない（[Migrating from PostgreSQL to Aurora DSQL](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-postgresql-compatibility-unsupported-features.html)、2026-09-28 に確認）。1 トランザクションの DML 1 万行（ADR-0005）と、長い再計算のトランザクションが収まらない。S1〜S2 の規模は、論理シャードで Aurora のクラスタを増やせば足りる（[ADR-0005](0005-tenancy-and-governor-limits.md)）。

### 本家の実装を核に使わないことの確認（リポジトリ共通の ADR-0007）

| 核（主な論点） | 本システムの作り方 | 本家の実装の使用 |
| --- | --- | --- |
| メタデータの実行基盤 | 自前（TypeScript）。データ辞書、版、コンパイラ（[ADR-0003](0003-metadata-driven-runtime.md)） | なし |
| カスタムオブジェクトの保存 | 自前の表の設計を PostgreSQL の上に作る（[ADR-0002](0002-custom-object-storage.md)） | なし。本家が公開した考え方（ピボットの索引の表）は参考にする |
| 共有の計算 | 自前（[ADR-0004](0004-record-access-model.md)） | なし。本家が公開した考え方（共有の表、グループの表）は参考にする |
| ガバナ制限 | 自前の計測と強制（[ADR-0005](0005-tenancy-and-governor-limits.md)） | なし |
| 問い合わせ・数式・フロー | 独自の言語と実行系 | なし。Apex・SOQL・SOSL・本家のフローの実行系は使わない |

- 本家の SDK、本家の CLI、本家のメタデータの XML の形式は、開発の道具としても使わない。
- 第三者の汎用の部品（PostgreSQL、OpenSearch、Valkey、JS のエンジン、WASM の実行系）は使ってよい。

### カスタマイズの言語

- **MVP は宣言的な設定だけにする（a）。** 数式の言語、入力規則、フロー、承認で、営業の業務の多くを覆う。宣言的な設定は、実行基盤がすべての手順を知っているので、上限の計測、項目の依存の追跡、デプロイの前の検証ができる。
- **MVP の後の利用者のコードは、TypeScript で書き、WASM の砂場で動かす。** JS のエンジンを WASM にしたものを、Runtime とは別のプロセスの WASM の実行系で動かす。
  - 実行の量を「燃料（命令の数）」で数えられる。CPU 時間を壁時計で測るより、上限の判定が決定的になり、上限の試験が再現できる（[ADR-0005](0005-tenancy-and-governor-limits.md)）。
  - メモリーの上限を、WASM の線形メモリーで強制できる。
  - 砂場の中から DB やネットワークに直接つながない。データは Runtime のデータの API（問い合わせと DML の AST）を通すだけにし、権限・共有・上限が必ず効く。
  - 書き手は TypeScript の型を使える。エージェントにも人にも学習の資料が多い。
  - JS のエンジンと WASM の実行系の選定は、extensibility の領域の ADR（0048–0050）で PoC をして決める。
- b（TypeScript の砂場を MVP から）は、隔離の設計（プロセスの分離、上限、秘密）を MVP の範囲に入れることになり重い。方向は b に近いが、時期を MVP の後にする。
- c（任意の言語の WASM）は、言語ごとの SDK とデバッグの道具を用意しきれない。燃料での計測は、a の後の方針に取り込んだ。
- d（Apex と互換）は、言語の実行系を本家の仕様に合わせて作ることになり、リポジトリ共通の ADR-0007 の趣旨に反する。本家の仕様の変化にも追い続ける必要がある。

## Consequences

- 良くなること：
  - 他の題材と同じ道具・CI・運用を使える。
  - MVP で、利用者の任意のコードを共有の基盤で動かす危険を持たない。
  - 自動化がすべて宣言的なので、デプロイの前に依存と上限を静的に検証できる。
- 引き受けるコスト：
  - 本家からの移行で、Apex で書いた処理は作り直しになる。宣言的な設定で書けない処理は、MVP の間は Webhook で外のシステムに任せる。
  - 問い合わせの言語、数式の言語、フローの実行系を、自分で作って保守する。参照の評価器と性質ベーステストで正しさを確かめる（[ADR-0003](0003-metadata-driven-runtime.md)）。
  - WASM の砂場の JS は、ネイティブの JS のエンジンより遅い。利用者のコードに向く処理の大きさを、MVP の後の PoC で確かめる。

## Confirmation

- 依存のレビュー：開発リポジトリの依存の一覧に、本家の SDK・CLI・本家の言語の実行系が入っていないことを、E1 の CI で検査する（許可しないパッケージの一覧）。
- レビュー：本家のメタデータの XML、Apex、SOQL の構文を受け付けるパーサーの追加を、差し戻す。
- 設計の工程の最後に、上の表の「核」の実装がすべて自前であることを確かめる。

---
status: accepted
date: 2026-10-04
---

# ADR-0001: 共通の基盤を引き継ぎ、タイムライン・推薦・カウンター・検索の核を自前で作る。アプリは React Native、学習だけ Python

## Context

rebuilds の他の題材（Slack、Linear、Uber など）で、次の基盤を決めている。

- AWS（東京、DR は大阪。ECS Fargate、Aurora PostgreSQL、ElastiCache Valkey、SQS・SNS、S3・CloudFront）
- TypeScript（Hono＋Zod）、ID は UUIDv7
- Terraform、OpenTelemetry、AWS AppConfig のフラグ、FORCE RLS と `SET LOCAL`、transactional outbox、トランクベース開発

この題材の主な論点は、ホームのタイムラインの fan-out、フォローの関係、投稿の書き込みと ID、おすすめのランキング、カウンター、日本語の検索とトレンド、通知、メディア、T&S、DM、公開 API である（[README.md](../../README.md)）。次の事情がある。

- 本家は、おすすめのアルゴリズムのコードを公開している。2023 年の `twitter/the-algorithm`（AGPL-3.0）と、今の `xai-org/x-algorithm`（Apache-2.0）である（[architecture/README.md](../architecture/README.md) の 1.3 節）。文字数の数え方のライブラリ `twitter-text`、ID の生成器 Snowflake も公開されている。どれも、この題材の核にあたる。
- 日本の利用者の大半はスマートフォンで使う。Web だけでは、題材の実際の負荷（閲覧の出来事、プッシュ通知、メディアの投稿）を設計できない。
- ランキングの学習は、Python の道具（PyTorch、LightGBM、評価の道具）が厚い。

## Options

核について：

1. **核を自前で作る。** 本家の公開のコードは、考え方の資料として読むだけにする
2. **本家の公開のアルゴリズムを土台にする。** `xai-org/x-algorithm`（Apache-2.0）を取り込み、周りを作る
3. **汎用の推薦・フィードの SaaS（Amazon Personalize、Stream など）を使う**

クライアントについて：

- a. **Web（React）と、React Native（Expo）の iOS・Android**
- b. Web とネイティブ（Swift・Kotlin）
- c. Web だけで始める

## Decision

1 と a を採用する。

### 核

- タイムラインの fan-out、ID の生成、カウンター、おすすめのパイプライン、検索の索引の形、T&S の規則を自前で設計し、TypeScript で作る。
- 本家のコード・設定の値（重み、閾値）・学習済みのモデルを使わない。2 は、Apache-2.0 で法的には使えるが、題材の主な論点（候補の取り出しとランキングの境界）を設計しないことになる（[リポジトリ共通の ADR-0007](../../../../docs/decisions/0007-no-reuse-of-original-implementation.md)）。
- 3 は、ランキングの中身を部品に任せることになり、2 と同じ理由で採らない。加えて、見える範囲の絞り込みをパイプラインの中で強制できない（[ADR-0006](0006-ranking-boundary.md)）。

### 使う部品と、使わないもの

| 用途 | 部品 | 扱い |
| --- | --- | --- |
| 文字数の数え方 | 自前（`packages/text`）。公開の仕様（重み、URL の 23）に合わせる | 本家の `twitter-text` は使わない。重みの表と、絵文字の書記素のまとまりの扱いを、公開の仕様と Unicode の規格から作る |
| ID の生成 | 自前（`packages/tid`） | 本家の Snowflake は使わない。ビットの配分は公開の考え方に寄せる（[ADR-0002](0002-post-ids-and-ordering.md)） |
| おすすめ | 自前（`packages/ranking`） | 本家の公開のアルゴリズムは使わない |
| 推論 | ONNX Runtime（Node.js の束縛） | 第三者の汎用の部品。学習済みのモデルを TypeScript のサービスで動かす |
| 学習と評価 | Python（PyTorch、LightGBM）、オフラインだけ | 第三者の汎用の部品。サービスの経路に Python を置かない |
| 検索 | Amazon OpenSearch Service | 第三者の汎用の部品 |
| 画像の変換 | `sharp`（libvips） | 第三者の汎用の部品 |
| 動画の変換 | AWS Elemental MediaConvert | AWS の汎用のサービス |
| 出来事のログ | Amazon Kinesis Data Streams | 共通の基盤に加える。理由は [ADR-0005](0005-event-log-and-outbox.md) |
| 認証 | Better Auth（`packages/auth` で包む） | Linear の題材と同じ |

### クライアント

- Web は React の SPA と PWA。iOS・Android は React Native（Expo）。型・API のクライアント・文字数の数え方・見える範囲の表示の規則を、Web とアプリで同じ TypeScript のパッケージにする。
- b は、同じ画面を 3 回作ることになり、小さなチームでは重い。
- c は、日本の利用の実態（スマートフォン中心）と、プッシュ通知・メディアの投稿・閲覧の出来事の負荷を、MVP で確かめられない。
- タイムラインのスクロールの滑らかさが足りないときは、該当の画面だけネイティブの部品にする。clients の領域で ADR を書く。

### 共通の基盤から外れるもの

| 外れるもの | 理由 | ADR |
| --- | --- | --- |
| 投稿・利用者・DM のメッセージの ID を 64 ビットの `tid` にする | タイムラインの写しの大きさ、時刻の順のページング、公開 API の ID の形 | [ADR-0002](0002-post-ids-and-ordering.md) |
| テナントの RLS を置かない | テナントが 1 つで、公開の表の見える範囲は閲覧者ごとの関係で決まる | [ADR-0004](0004-single-tenant-and-visibility.md) |
| SQS・SNS に加えて Kinesis Data Streams を使う | 複数の消費者が同じ出来事を独立に読み、再生する必要がある | [ADR-0005](0005-event-log-and-outbox.md) |
| 学習と評価に Python を使う | 学習の道具。サービスの経路には置かない | [ADR-0006](0006-ranking-boundary.md) |

## Consequences

- 良くなること：
  - 題材の主な論点を、自分で設計した記録になる。
  - クライアントとサーバーが同じ言語で、文字数の数え方と見える範囲の規則を 1 つのコードで持てる。投稿の前の文字数の表示と、サーバーの検証が食い違わない。
  - 他の題材と同じ道具・CI・運用を使える。
- 引き受けるコスト：
  - 本家が長年かけて磨いたランキングに比べ、S1 のおすすめの質は低い。K8 の基準（フォロー中の時刻の順より 20% 高い）で評価し、学習済みのモデルは S2 で足す。
  - 学習の Python と、推論の TypeScript（ONNX）の間で、特徴の作り方がずれうる。特徴の定義を 1 か所に置き、学習と推論で同じ値になることを試験する（ranking-and-recommendation の領域）。
  - React Native のアプリの配布（ストアの審査、最低のバージョン）を運用する。clients・delivery の領域で扱う。

## Confirmation

- 依存の検査（CI）：`twitter-text`、本家の Snowflake の移植、`the-algorithm`・`x-algorithm` のコードを、依存と import とコードの写しの検出で禁止する。
- レビュー：ランキングの重み・閾値の値に、本家の公開のコードの値を写していないことを確かめる。値には、自前の評価の記録を付ける。
- lint：サービスのパッケージから Python のプロセスを呼ぶことを禁止する（学習と評価のジョブだけ）。
- 設計の工程の最後の検証で、依存の一覧に本家の実装が核として入っていないことを確かめる。

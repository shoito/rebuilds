---
status: accepted
date: 2026-09-27
---

# ADR-0001: 基盤は他の題材の決定を引き継ぎ、配車の熱い経路は Go で、モバイルはネイティブで書く

## Context

rebuilds の他の題材（Slack・Stripe・GitHub・Notion）で、次の基盤を決めている。

- AWS 東京（ECS Fargate、Aurora PostgreSQL 18、ElastiCache の Valkey、SQS、S3、CloudFront）。災害復旧は大阪
- TypeScript（Hono＋Zod）
- Terraform、OpenTelemetry、トランクベース開発、AWS AppConfig のフラグ

配車には、他の題材にない条件が 3 つ加わる。

- **メモリ上の状態が熱い**：オンラインの車両の位置が 4 秒ごとに届き（S1 で 2,500 件/秒、S3 で 50,000 件/秒）、配車はその最新の位置を数秒ごとに読む。DB を毎回引く設計では間に合わない。
- **計算が重い**：配車のバッチごとに、候補の組の ETA の行列と、割り当ての最適化を解く。
- **ドライバーのアプリは、背景で位置を送り続ける**：iOS と Android の背景の実行、電池、通信が切れたときの振る舞いを、細かく制御する必要がある。

## Options

### サーバー

1. **全部 TypeScript**：他の題材と完全にそろう
2. **一般の部分は TypeScript、熱い経路（位置の取り込み・地理空間の索引・配車）は Go**
3. **熱い経路は Rust**
4. **熱い経路は JVM（Java・Kotlin）**

### モバイル

1. **ネイティブ（Swift・Kotlin）**
2. **クロスプラットフォーム（React Native・Flutter）**
3. **共有のコア（Kotlin Multiplatform など）＋ネイティブの画面**

## Decision

サーバーは 2、モバイルは 1 を採用する。

### サーバー

- 実行基盤・IaC・可観測性・フラグ・ブランチの運用は、Slack の ADR-0007・0011・0020・0021・0026 と同じにする。Aurora PostgreSQL は 18 を使う。
- **位置の取り込み、地理空間の索引、配車は Go で書く。** 常時の接続の受け手（`rt-gateway`、[ADR-0030](0030-realtime-grpc-bidirectional-stream-gateway.md)）と、乗客への車の位置の配信（`trip-location-fanout`、ADR-0030・[ADR-0038](0038-compute-on-fargate-and-data-stores.md)）も、同じ理由（多数の接続と位置の流れをメモリで扱う）で Go にする。配車の行列を求める Valhalla の前の層（`eta-service`、[ADR-0016](0016-valhalla-serving-traffic-and-eta-accuracy.md)）も、配車の熱い経路にあるので Go にする。Go のサービスは、この 6 つ（`loc-ingest`、`geo-index`、`dispatch`、`eta-service`、`rt-gateway`、`trip-location-fanout`）とする（統合の工程で 3 つから 5 つにし、2026-09-27 に `eta-service` を加えて 6 つにした）。理由は次のとおり。
  - メモリ上の共有の状態と、多数の同時の処理（goroutine とチャネル）を、単純な書き方で扱える。
  - コンパイルとテストが速く、エージェントの確認ループが短い。学習データも多い。
  - gRPC・Protocol Buffers の成熟した実装がある。地理の格子は、自前の純粋な Go のパッケージ `geogrid` で書く（[ADR-0002](0002-hex-grid-geospatial-model.md)）。cgo を使わず、`CGO_ENABLED=0` で ARM64 のイメージを作る。
- 1 は、Node.js の単一のスレッドで、メモリ上の大きな索引と重い最適化を同じプロセスに持つことになる。本家は、Node.js で書いた初期の Fulfillment の基盤（乗車の状態を持つ部分）を、使われなくなった技術として後に作り直している（[Uber's Fulfillment Platform: Ground-up Re-architecture](https://www.uber.com/us/en/blog/fulfillment-platform-rearchitecture/)、2026-09-27 に確認）。
- 3 は、GC がなく、遅延の裾で Go に勝る。ただし、コンパイルが遅く、所有権の制約のためにエージェントの修正の往復が増える。S1〜S2 の規模（索引は都市ごとに数万台）では、Go の GC の停止が NFR-001・NFR-002 を崩すとは見込まない。E3 の負荷試験で、GC の停止を含めた p99 を計測し、足りなければ索引だけを Rust に替える ADR を書く。
- 4 は、性能は足りるが、他の題材の道具と離れる割に、2 より得るものが少ない。
- TypeScript と Go の間の契約は、Protocol Buffers で 1 か所に書き、両方の型を生成する（buf を使う）。内部の呼び出しは gRPC にする。
- **金額は円の整数で扱う。** Stripe の題材の ADR-0001 と同じく、金額の型を 1 つのパッケージに集め、浮動小数点を使わない。多通貨は範囲外だが、通貨コードは型に持たせる。
- 時刻は UTC で保存し、表示だけ日本時間にする。運賃の時間帯の規則（深夜の割増など）は、地域の時間帯で評価する。

### モバイル

- **乗客とドライバーのアプリは、Swift（iOS）と Kotlin（Android）で書く。**
  - ドライバーのアプリは、背景での位置の送信（iOS の位置の背景モード、Android のフォアグラウンドサービス）と、電池と通信の制御が中心にある。OS の API を直接使うほうが、挙動を確かめやすい。
  - 外部のナビへの引き継ぎ、電話・SMS、緊急の通報の発信も、OS の機能に近い。
- 2 は、画面の共有には向くが、背景の位置と常時の接続の部分は結局ネイティブのモジュールになる。2 つの層をまたぐ不具合の調べが重い。
- 3 は、乗車のステートマシンと通信のプロトコルを共有できる利点がある。ただし MVP では、共有するものを Protocol Buffers から生成するモデルと、Trips が出す状態遷移の表（テストのベクター）に留め、ビルドの仕組みを 1 つ増やさない。共有のコアは、S2 で 2 つのアプリの食い違いの不具合が多ければ見直す。
- 事業者の管理画面とサポートのツールは Web（TypeScript）にする。

> 2026-09-28 の注記：地理の格子を H3 の束縛（h3-go、cgo と C の実装の同梱が要る）から、自前の `geogrid` に改めた（ADR-0002 の同じ日の注記、リポジトリ共通の [ADR-0007](../../../../docs/decisions/0007-no-reuse-of-original-implementation.md)）。Go を選ぶ理由から h3-go を外し、cgo の懸念を消した。

> 2026-09-27 の注記：`eta-service` は、独自の API を持ち、ECS のサービスとして別に配備し（3 タスク、ローリング。[infrastructure.md](../architecture/infrastructure.md) の 3 節、[delivery.md](../architecture/delivery.md) の 4 節）、配車・乗客の API・Trips から呼ばれる。付随の役ではなく、Go のサービスに数える。付随の役は、同じ領域の部品として別の ADR が認めた `trail-builder`（ADR-0010）と `dispatch-shadow`（ADR-0042）の 2 つだけにする。

## Consequences

- 良くなること：
  - 一般の部分は、他の題材の運用・CI・セキュリティの仕組みを使い回せる。
  - 熱い経路は、メモリ上の状態を持つ前提で、速く書ける。
- 引き受けるコスト：
  - サーバーの言語が 2 つになる。CI、依存の更新、脆弱性の検査、可観測性の計装を両方に用意する。
  - モバイルは 2 つのコードベースになる。乗車の状態の解釈がずれないよう、状態遷移の表を共通のテストのベクターにする。

## Confirmation

- Go のサービスは、`loc-ingest`・`geo-index`・`dispatch`・`eta-service`・`rt-gateway`・`trip-location-fanout` の 6 つに限る。新しい Go のサービスは ADR を要する（レビューで確かめる）。同じ領域の付随の役として別の ADR が認めたもの（位置の取り込みの `trail-builder`（[ADR-0010](0010-location-trails-map-matching-and-retention.md)）、配車の影の実行の `dispatch-shadow`（[ADR-0042](0042-replay-and-shadow-gates-for-dispatch-and-pricing.md)））は、その ADR を根拠とし、6 つに数えない。
- lint：金額の型以外で、金額を `number`・`float64` として扱うコードを禁止する。
- E3 の負荷試験で、S1 のピークの 2 倍（位置 5,000 件/秒）のときの索引への反映の p99 と GC の停止を計測し、NFR-002 を満たすことを確かめる。
- 両方のアプリで、状態遷移の表のテストのベクターが通ることを CI で確かめる。

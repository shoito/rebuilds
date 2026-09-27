---
status: accepted
date: 2026-09-28
---

# ADR-0001: 共通の基盤の上に、同期エンジンを自前で作る。クライアントは TypeScript の SPA と Electron、手元の保存は IndexedDB

## Context

rebuilds の他の題材（Slack、Notion、Figma など）で、次の基盤を決めている。

- AWS（東京、DR は大阪。ECS Fargate、Aurora PostgreSQL 18、ElastiCache Valkey、SQS、S3・CloudFront）
- TypeScript（Hono＋Zod）
- Terraform、OpenTelemetry、AWS AppConfig のフィーチャーフラグ、トランクベース開発

この題材の中心の論点は、ローカルファーストの同期エンジンである。クライアントがワークスペースのデータを手元に持ち、操作を即座に反映し、サーバーの順序で確定し、全クライアントを収束させる（[intent.md](../intent.md)）。次の条件がある。

- ローカルの操作を p99 50ms で描く（NFR-001）。
- オフラインで書いた変更を失わない（NFR-004）。
- 非公開のチームのデータを、権限のないクライアントへ送らない（NFR-008）。
- 本家の実装を核に使わない（[リポジトリ共通の ADR-0007](../../../../docs/decisions/0007-no-reuse-of-original-implementation.md)）。本家の SDK（`@linear/sdk`）は公開 API のクライアントで、同期エンジンではないが、これも使わない。

同期エンジンを作る部品として、既存の OSS の同期の基盤がある。

## Options

1. **共通の基盤を引き継ぎ、同期エンジン（サーバーとクライアント）を自前で作る。** 汎用の部品（反応型のストア、IndexedDB のラッパー、本文の CRDT）は第三者のものを使う
2. **既存の同期の基盤を土台にする**
   - 2a. Replicache・Zero（Rocicorp）
   - 2b. ElectricSQL（PostgreSQL の変更を形ごとにクライアントへ配る）
   - 2c. PowerSync（PostgreSQL と手元の SQLite の同期）
3. **ページごとにサーバーから読む普通の SPA にし、同期をしない**（楽観的な更新だけ）

クライアントの形として、次も比べた。

- a. **TypeScript の SPA と、それを包む Electron**
- b. ネイティブのデスクトップのアプリ（Swift・C# など）
- c. Tauri（OS の WebView）

## Decision

1 と a を採用する。

### サーバー

- 実行基盤・言語・IaC・可観測性・フラグは、他の題材と同じにする。題材をまたいで、エージェントと人が同じ道具で検証できる。
- Sync Gateway（WebSocket）、Sync API（ブートストラップ）、Public API、Writer、Relay、Worker を別の ECS のサービスにする（[architecture/README.md](../architecture/README.md) の 1.2 節）。Writer は、Sync Gateway・Public API・Worker からの書き込みを 1 つの入口で受ける。
- リアルタイムの配信（Gateway、Valkey の pub/sub、再接続）は、Slack の ADR-0001〜0003 の考え方を先例にする。ワークスペースのテーブルの分離は、Slack の ADR-0009 と同じ共有スキーマと RLS にする（[ADR-0004](0004-tenancy-and-permissions.md)）。

### クライアント

- **言語とフレームワーク**：TypeScript と React。モデルの定義と競合の規則を、サーバーと同じパッケージから使う。
- **反応型のストア**：オブジェクトプールのモデルを観測可能にし、変わったフィールドを読む部品だけを描き直す。第一の候補は MobX（第三者の汎用の部品。本家も使っていると公言しているが、本家のコードではない）。E2 の PoC で、イシュー 50 万件での描画の速さとメモリーを、自前の細かな購読（シグナル）と比べて決める。MobX を使う場合も、MobX の API はオブジェクトプールの中に閉じ、画面のコードからは自前の API だけを使う。後で差し替えられるようにするため。
- **手元の保存**：IndexedDB。ラッパーは `idb`（Promise の薄い包み）を使う。理由と Notion（SQLite の WASM）との違いは [ADR-0005](0005-client-persistence-and-offline.md)。
- **デスクトップ**：Electron で Web と同じコードを包む。Notion（Notion の ADR-0009）・Zoom と同じ判断である。
  - b は、Web と別のコードの保守が要る。同期エンジンを 2 つ作ることになる。
  - c は、OS ごとに WebView の IndexedDB と性能が違い、遅延の予算（NFR-001）を OS ごとに確かめる必要がある。
- **本文の同時編集**：ProseMirror 系のエディタと、CRDT のライブラリ（Yjs を第一の候補）を使う。選定は editor-and-descriptions の領域で行う。

### 使う部品と、使わないもの

| 用途 | 部品 | 扱い |
| --- | --- | --- |
| 反応型のストア | MobX（候補） | 第三者の汎用の部品。E2 の PoC で決める |
| IndexedDB | `idb` | 第三者の汎用の部品。IndexedDB の API を Promise にするだけで、同期の意味を持たない |
| 本文の CRDT | Yjs（候補） | 第三者の汎用の部品。本文だけに使い、同期のログと順序は自前（[ADR-0002](0002-sync-model.md)） |
| 分数インデックスの鍵 | 自前（公開のアルゴリズムに基づく） | 数十行で書ける。サーバーでの振り直しの規則と一体にするため |
| 本家の SDK、本家のクライアントのコード、本家の同期の実装 | 使わない | [リポジトリ共通の ADR-0007](../../../../docs/decisions/0007-no-reuse-of-original-implementation.md) |

### 2・3 を選ばなかった理由

- **2a（Replicache・Zero）**：Replicache は「確定した状態に、未確定の変更を載せ直す」方式で、この題材の考え方に最も近い（[How Replicache works](https://doc.replicache.dev/concepts/how-it-works)、2026-09-28 に確認）。ただし、同期の核（順序、載せ直し、部分の同期）を部品に任せると、この題材の主な論点を設計しないことになる。Zero は問い合わせの単位で配る形で、同期グループで権限ごとに配る形と合わない（本システムの評価）。考え方の手本として参照する。
- **2b（ElectricSQL）・2c（PowerSync）**：PostgreSQL の論理レプリケーションから、形（shape）やバケットごとに配る。サーバーの側の順序と権限の絞り込みを部品が決める。書き込みの経路（検証、ワークフローの規則）は別に作る必要がある。部分の同期と権限の単位を、この題材の同期グループ（[ADR-0003](0003-bootstrap-and-partial-sync.md)）に合わせにくい（本システムの評価）。
- **3（同期なしの SPA）**：画面の遷移ごとにサーバーを待ち、NFR-001・NFR-004 を満たせない。題材の本質を捨てることになる。

## Consequences

- 良くなること：
  - 同期の順序、競合の規則、権限の絞り込み、オフラインの保証を、自分で決めて検証できる。
  - クライアントとサーバーが同じ言語で、モデルの定義と競合の規則を 1 つのコードで持てる。
  - 他の題材と同じ道具・CI・運用を使える。
- 引き受けるコスト：
  - 同期エンジンの誤りは、収束しない・データを失う形で現れ、気づきにくい。決定的なシミュレーターと性質ベーステスト（[ADR-0002](0002-sync-model.md)）、オフラインと再送の試験（[ADR-0005](0005-client-persistence-and-offline.md)）に投資する。
  - JavaScript の 1 本のスレッドで、大きなワークスペースのモデルを持ち、描く。メモリーと GC の停止が遅延の予算を脅かす。モデルの遅延の復元（[ADR-0003](0003-bootstrap-and-partial-sync.md)）と、CI のベンチマークで抑える。
  - Electron は配布の大きさとメモリーの費用がかかる。自動更新と最低の版の強制を delivery の領域で扱う。

## Confirmation

- 依存の検査（CI）：`@linear/*` のパッケージ、本家のクライアントから取り出したコードを、依存と import で禁止する。
- lint：画面のパッケージから `mobx` を直接 import することを禁止する（オブジェクトプールの中だけで使う）。
- lint：画面・モデルのパッケージから IndexedDB（`idb`、`indexedDB`）を直接触ることを禁止する。手元の保存は保存の層だけが触る（[ADR-0005](0005-client-persistence-and-offline.md)）。
- 設計の工程の最後の検証で、依存の一覧に本家の実装が入っていないことを確かめる。

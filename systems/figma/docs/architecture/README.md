# Architecture: Figma

全体像と横断的な方針。領域ごとの設計は、同じディレクトリに領域ごとのファイルとして置く。ファイルの一覧と ADR の番号の範囲は 8 節にある。品質は [quality.md](../quality.md)、Epic と Story は [roadmap.md](../roadmap.md)、SLO と運用は [runbooks/](../runbooks/README.md)、データの置き場所の索引は [data-model.md](data-model.md) にある。

## 1. 全体構成

### 1.1 コンテキスト

```
 デザイナー・開発者・PM（ブラウザ）          共有のリンクで見る外部の人
            │                                       │
            ▼                                       ▼
 ┌─────────────────────────── Figma の再構築 ───────────────────────────┐
 │  エディタ（WASM のエンジン＋UI）・ファイルの一覧・コメント・共有       │
 └──────────────────────────────────────────────────────────────────────┘
        │                │                 │                  │
        ▼                ▼                 ▼                  ▼
   メールの送信     決済（プランの課金）  フォントの提供元     IdP（SAML・OIDC。MVP の範囲の外）
```

### 1.2 コンテナ

```
ブラウザ
 ├─ UI の殻（TypeScript・React）：ツールバー、パネル、ファイルの一覧、コメント
 └─ エンジン（Rust → WASM）：ドキュメントのモデル、レイアウト、描画（WebGPU / WebGL2）
      │ HTTPS（API）          │ WebSocket（変更・在席）            │ HTTPS（チャンク・画像・フォント。署名付き URL）
      ▼                       ▼                                    ▼
 API（Hono）── Aurora     Multiplayer Gateway（接続・チケット・配信）   CloudFront（files・assets の <brand>usercontent）
   │   │  （メタデータ、RLS）   │                                          ▲
   │   └─ Realtime（メタデータの購読）                                     │
   │        ◀── 無効化の outbox ─┘    ▼                                    │
   │                    Document Server（Rust。ファイルごとに 1 つの持ち主）│
   │                       │ 変更の追記（フェンス付き）  │ 定期的に         │
   │                       ▼                              ▼                  │
   │                    Journal（DynamoDB）          S3（チェックポイント・画像）
   │
   └──▶ SQS ──▶ Worker（通知、掃除、検索の索引）、Render Worker（書き出し・サムネイル＝Rust の描画をネイティブで）
 Router（ファイル → Document Server の割り当て。正本は DynamoDB の割り当てとタスクの生存、Valkey にキャッシュ）
```

| コンテナ | 責務 |
| --- | --- |
| UI の殻 | React のパネルと画面。エンジンとは生成した型のコマンドと、フレームに 1 回の話題ごとのスナップショットでやり取りする（[ADR-0016](../decisions/0016-shell-engine-boundary.md)）。キャンバスの描画はしない |
| エンジン（WASM） | ドキュメントのモデル、変更の適用と合わせ直し（rebase）、レイアウト、ヒットテスト、描画。サーバーと同じ `doc-model` の crate を使う |
| API | 認証、組織・チーム・プロジェクト・ファイルのメタデータ、判定関数と能力のチケットの発行（[ADR-0030](../decisions/0030-single-policy-engine-and-signed-capabilities.md)）、共有、コメント、版の一覧 |
| Realtime | ファイルの一覧・コメント・権限などメタデータの変更を購読で配る（本家の LiveGraph に相当。[LiveGraph](https://www.figma.com/blog/livegraph-real-time-data-fetching-at-figma/)、2021-10-14。[ADR-0028](../decisions/0028-realtime-metadata-subscriptions.md)） |
| Multiplayer Gateway | WebSocket の終端、能力のチケットの検証、Router に問い合わせて Document Server へ中継、Gateway ごとに 1 回届く配信を接続へ分ける（[ADR-0009](../decisions/0009-multiplayer-wire-protocol.md)、[ADR-0011](../decisions/0011-presence-and-fan-out.md)） |
| Document Server | 1 ファイルを 1 つのタスク（file actor）がメモリに持ち、変更に `seq` を振り、検証し、ジャーナルに書き、配る（[ADR-0002](../decisions/0002-central-authoritative-multiplayer.md)、[ADR-0003](../decisions/0003-journal-and-checkpoints.md)） |
| Router | ファイルと Document Server の対応を、ファイルごとの割り当て（`file_leases`、`epoch`）とタスクごとの生存（`ds_liveness`）で管理する。手放さずに落ちたファイルを回復のジョブで拾う（[ADR-0005](../decisions/0005-tenancy-and-document-routing.md)、[ADR-0047](../decisions/0047-router-task-liveness-and-file-assignment.md)） |
| Journal | 確定した変更の追記のログ。チェックポイントより後の変更を持つ。フェンスの項目で古い持ち主の書き込みを止める（[ADR-0024](../decisions/0024-journal-items-and-fencing.md)） |
| S3・CloudFront | チェックポイント（マニフェストと中身のハッシュで名付けたページのチャンク）、画像、フォント、書き出しの結果。ブラウザは S3 を直接読まず、判定の後に出す署名付き URL で CloudFront から読む（[ADR-0025](../decisions/0025-content-addressed-checkpoints-and-loading.md)、[ADR-0035](../decisions/0035-content-addressed-images.md)） |
| Worker・Render Worker | 通知、掃除、完全な削除、検索の索引。Render Worker は書き出しとサムネイルを、エンジンの Rust のコードをネイティブ（CPU の lavapipe）で動かして描く（[ADR-0034](../decisions/0034-export-rendering-split.md)） |

原則は 4 つ。

- **ファイルごとに持ち主は 1 つ。** 1 つのファイルの変更の順序は、そのファイルを持つ Document Server だけが決める。CRDT は使わない（[ADR-0002](../decisions/0002-central-authoritative-multiplayer.md)）。
- **確定の前に永続化する。** 変更は、ジャーナルに書いてから確定を返し、配る（[ADR-0003](../decisions/0003-journal-and-checkpoints.md)）。
- **同じ規則を 1 つのコードで。** 変更の適用・検証・レイアウト・描画は Rust の crate にまとめ、ブラウザ（WASM）とサーバー（ネイティブ）で同じコードを使う。一致は CI で確かめる（[ADR-0001](../decisions/0001-platform-and-stack.md)、[ADR-0054](../decisions/0054-wasm-native-parity-and-bundle-budgets.md)）。
- **ファイルの中身とメタデータを分ける。** ファイルの中身（ノードの木）はマルチプレイヤーの経路で扱い、Aurora には置かない。Aurora はメタデータ（組織、権限、コメント、版の一覧）の正本で、RLS で組織を分ける（[ADR-0005](../decisions/0005-tenancy-and-document-routing.md)）。本家も、ファイルの中の同時編集はマルチプレイヤー、ファイルをまたぐデータは LiveGraph と Postgres に分けている（同上の LiveGraph の記事）。

## 2. 主要フロー

### 2.1 編集の確定

1. クライアントのエンジンが、変更を自分のモデルに当て、すぐに描画する。未確定の変更として持つ。
2. 変更を WebSocket で送る（続く操作は 20Hz にまとめる）。Gateway が Document Server へ中継する。
3. Document Server は、権限（編集できる接続か）と木の不変条件（循環がない）を確かめ、`seq` を振ってメモリのモデルに当てる。
4. 約 20ms ごとに、たまった変更をまとめてジャーナルに書く（group commit）。条件は、フェンスの項目の `epoch` が自分のものと等しいことと、その `seq` の項目がまだないことの 2 つで、1 つのトランザクションで確かめる（[ADR-0024](../decisions/0024-journal-items-and-fencing.md)）。
5. 書けたら、送り手に確定（`Ack`）を返し、他のクライアントに配る（Gateway ごとに 1 回）。
6. 他のクライアントは、未確定の自分の変更と同じプロパティへのサーバーの変更を、確定するまで画面に出さない（ちらつきを防ぐ。本家と同じ）。

### 2.2 ファイルを開く

1. クライアントは API から能力のチケット（60 秒・1 回だけ）を受け取り、WebSocket の最初のメッセージで送る。Gateway はチケットを確かめ、Router にファイルの持ち主を問い合わせる。持ち主がなければ、Router が Document Server を割り当てる。
2. 持ち主がまだ読み込んでいなければ、Document Server は、ジャーナルのフェンスを上げてから、S3 から最新のチェックポイントを読み、ジャーナルからそれより後の変更を当てる。
3. Document Server は、ファイルの中身を送らない。**計画（`LoadPlan`：マニフェストの内容とチャンクごとの署名付き URL）と、チェックポイントより後の確定した変更（tail）だけを送る**（[ADR-0025](../decisions/0025-content-addressed-checkpoints-and-loading.md)）。
4. クライアントは、チャンクを端末のキャッシュ（IndexedDB）か CloudFront から読む。今のページを先に読み、tail を当てて操作できるようにし、他のページは裏で読む（本家も、ページとレイヤーを必要なときに読む。[Reduce memory usage in files](https://help.figma.com/hc/en-us/articles/360040528173-Reduce-memory-usage-in-files)、2026-09-27 に確認）。以後は変更を WebSocket で受ける。
5. 数百人が同時に開いても、チャンクは CloudFront から配られ、Document Server の送信は tail だけになる。

### 2.3 Document Server の障害

1. 持ち主のタスクの生存の記録（10 秒の期限）が切れると、猶予 2 秒の後に、Router は別の Document Server に `epoch` を 1 つ上げて割り当てる（[ADR-0047](../decisions/0047-router-task-liveness-and-file-assignment.md)）。誰も開かないファイルは、回復のジョブが 5 分以内に拾う。
2. 新しい持ち主は、フェンスを上げ、2.2 の 2 と同じ手順で、最後に確定した `seq` まで戻す。古い持ち主が生きていても、フェンスで書き込みが止まる。
3. クライアントは再接続し（最初は 0〜5 秒の乱数の待ち）、確定していない自分の変更を送り直す。重複は `(session_id, client_seq)` で除く。
4. デプロイでは、Document Server はファイルを渡してから止まる（ドレイン。[ADR-0046](../decisions/0046-multiplayer-compute-on-fargate-with-drain.md)）。ファイルごとの中断は 1〜2 秒の見込み。

## 3. 規模の段階

| 段階 | 利用者（月間） | 同時に開いたファイル | 同時接続 | 確定する変更（日） | 構成 |
| --- | --- | --- | --- | --- | --- |
| S1（MVP） | 10 万 | 1 万 | 5 万 | 5,000 万 | 1 リージョン（東京）・3 AZ。Aurora の writer 1 台＋reader。Document Server は `ds-standard` 12＋`ds-large` 3 タスク。大阪に縮小したウォームスタンバイ |
| S2 | 100 万 | 10 万 | 50 万 | 5 億 | メタデータを縦に分ける（コメント・通知を別のクラスタへ）。Document Server を AZ ごとの群れに分ける。Realtime の無効化を WAL から作る |
| S3 | 1,000 万 | 100 万 | 500 万 | 50 億 | メタデータを `org_id`・`file_id` で横に分ける（シャード）。セル構成。大阪でも編集を受ける |

- 本家の規模の目安：ジャーナルは 1 日に 22 億件を超える変更を受ける（[Making multiplayer more reliable](https://www.figma.com/blog/making-multiplayer-more-reliable/)、2022-10-20、2026-09-27 に確認）。段階 S3 の値は、これより 1 桁大きく見積もって余裕を持たせた。
- 数値の根拠と部品ごとの必要量は [capacity.md](capacity.md)、台数と段階を上げる目安は [infrastructure.md](infrastructure.md) の 8・9 節にある。どれも E12 の負荷試験の前の初期見積もり。

## 4. 非機能要件

| ID | 項目 | S1 の目標 | 備考 |
| --- | --- | --- | --- |
| NFR-001 | 同時編集の反映 | 入力から、同じファイルを開いた他の人の画面まで p99 250ms 以内（同じリージョン） | ジャーナルの書き込み（group commit）を含む。区間の予算は [multiplayer.md](multiplayer.md) の 8 節 |
| NFR-002 | 自分の入力の反映 | 入力から自分の画面まで 1 フレーム（16.7ms）以内。サーバーを待たない | 段の予算は [rendering-engine.md](rendering-engine.md) の 15 節 |
| NFR-003 | 大きなファイルを開く時間 | 10 万ノードの参照ファイルで、最初のページが操作できるまで p75 5 秒以内（キャッシュなし）、2 秒以内（キャッシュあり） | 参照の端末は [quality.md](../quality.md) の 2.4 節 |
| NFR-004 | メモリ | 10 万ノードの参照ファイルで、タブのメモリ 1.5 GB 以内。80% で警告を出す | 本家はタブあたり 2 GB を上限にしている（[Reduce memory usage in files](https://help.figma.com/hc/en-us/articles/360040528173-Reduce-memory-usage-in-files)、2026-09-27 に確認）。内訳は rendering-engine.md の 11 節（`Doc` は 200 MiB） |
| NFR-005 | フレームレート | 10 万ノードの参照ファイルのパン・ズームで、フレーム時間 p95 16.7ms 以内（60fps） | |
| NFR-006 | 耐久性 | 確定を返した編集は失わない（プロセス・ホスト・AZ の障害）。確定の前に失われうる範囲は、送り直しで回復する | 本家の目標は「失うのは 1 秒未満」（同上の Making multiplayer more reliable） |
| NFR-007 | Document Server の障害からの回復 | 持ち主のプロセスが落ちてから、別の持ち主で編集を再開できるまで p95 15 秒以内 | 内訳は infrastructure.md の 5.4 節 |
| NFR-008 | 可用性 | 編集（ファイルを開き、変更が確定する）の月間 99.95%。メタデータの API は 99.9% | SLI は [ADR-0050](../decisions/0050-editing-slis-and-slos.md)、値の正本は [runbooks/README.md](../runbooks/README.md) |
| NFR-009 | 復旧（リージョンの障害） | RPO 1 分以内、RTO 1 時間以内（大阪） | リージョンの喪失では NFR-006 の例外として 1 分までの損失を許す。失った範囲は版として取り戻す（[ADR-0048](../decisions/0048-osaka-dr-with-journal-generations.md)） |
| NFR-010 | テナント分離 | 他の組織のファイル・メタデータ、権限のないファイルの中身（サムネイルを含む）が見える事象は 0 件 | 経路の一覧は [permissions-and-sharing.md](permissions-and-sharing.md) の 11 節 |

## 5. 技術スタック

| 層 | 選定 | 理由 |
| --- | --- | --- |
| エンジン | Rust → WASM（`wasm32-unknown-unknown`）。ドキュメントのモデル・レイアウト・描画 | [ADR-0001](../decisions/0001-platform-and-stack.md)。本家は C++ と Emscripten |
| GPU | 1 つのビルドに WebGPU と WebGL2。WebGPU で始め、失敗したら WebGL2 へ。自前の GPU の抽象の下に wgpu | [ADR-0004](../decisions/0004-gpu-rendering-in-wasm.md)、[ADR-0014](../decisions/0014-gpu-backend-selection-and-fallback.md) |
| テキスト | HarfRust・Skrifa・ICU4X | [ADR-0015](../decisions/0015-text-shaping-and-glyph-rendering.md) |
| UI の殻 | TypeScript、React | 他の題材と同じ |
| マルチプレイヤー | Rust（tokio）の Document Server。Gateway・Router も Rust | [ADR-0001](../decisions/0001-platform-and-stack.md)、[ADR-0002](../decisions/0002-central-authoritative-multiplayer.md) |
| API・Worker | TypeScript、Hono＋Zod | 他の題材と同じ |
| メタデータ | Aurora PostgreSQL 18。共有スキーマと `FORCE ROW LEVEL SECURITY` | [ADR-0005](../decisions/0005-tenancy-and-document-routing.md) |
| ジャーナル・割り当て | DynamoDB（条件付きの書き込み、`TransactWriteItems`、グローバルテーブル） | [ADR-0003](../decisions/0003-journal-and-checkpoints.md)、[ADR-0024](../decisions/0024-journal-items-and-fencing.md)、[ADR-0047](../decisions/0047-router-task-liveness-and-file-assignment.md) |
| キャッシュ・配信 | ElastiCache（Valkey。pub/sub はクラスタモードを使わない） | 他の題材と同じ。[infrastructure.md](infrastructure.md) の 6 節 |
| ファイル・配布 | S3、CloudFront | [ADR-0025](../decisions/0025-content-addressed-checkpoints-and-loading.md) |
| サーバーの描画 | ネイティブの同じ crate、wgpu の Vulkan を Mesa の lavapipe（CPU）で | [ADR-0014](../decisions/0014-gpu-backend-selection-and-fallback.md)、[ADR-0034](../decisions/0034-export-rendering-split.md) |
| 非同期 | transactional outbox → SQS | 他の題材と同じ |
| 実行基盤 | AWS 東京（3 AZ）、大阪を DR。ECS Fargate（Rust のサービスは ARM64、Render Worker は x86-64） | [ADR-0001](../decisions/0001-platform-and-stack.md)、[ADR-0046](../decisions/0046-multiplayer-compute-on-fargate-with-drain.md) |
| IaC・可観測性 | Terraform、OpenTelemetry | 他の題材と同じ |

## 6. 主な決定

どれも `accepted`（0001〜0005 と intent.md は、統合の工程の修正を当ててから 2026-09-27 に `proposed`・`draft` から改めた）。状態の一覧は [decisions/README.md](../decisions/README.md)。

| ADR | 決定 |
| --- | --- |
| [0001](../decisions/0001-platform-and-stack.md) | 基盤は他の題材を引き継ぎ、エンジンとマルチプレイヤーのサーバーは Rust で書く |
| [0002](../decisions/0002-central-authoritative-multiplayer.md) | 同時編集は、ファイルごとの中央のサーバーが順序を決める。プロパティ単位の LWW、分数インデックス、循環の拒否 |
| [0003](../decisions/0003-journal-and-checkpoints.md) | ファイルはメモリに持ち、確定の前にジャーナルへ書き、定期的に S3 へチェックポイントを書く |
| [0004](../decisions/0004-gpu-rendering-in-wasm.md) | 描画は WASM の中の自前のエンジンで、WebGL2 を必須、WebGPU を使えるときに使う |
| [0005](../decisions/0005-tenancy-and-document-routing.md) | メタデータは共有スキーマと FORCE RLS で組織を分け、ファイルは Router の割り当てで Document Server へ振り分ける |
| [0006](../decisions/0006-node-types-and-property-table.md) | ノードの種類とプロパティを 1 つの表で定義し、競合の単位・検証・持ち主の領域を表に書く |
| [0007](../decisions/0007-node-ids-and-tree-invariants.md) | ノードの ID は `(session_id, local_id)`。`session_id` はジャーナルに記録してから渡し、木の不変条件は `doc-model` の検証器だけで確かめる |
| [0008](../decisions/0008-canonical-binary-serialization.md) | 変更・チェックポイント・通信は、表から生成する自前のスキーマ付きバイナリ（タグ付き・正準形）で表し、ページ単位に分けて zstd で圧縮する |
| [0009](../decisions/0009-multiplayer-wire-protocol.md) | 送受信は WebSocket の上の二値のメッセージ。`ChangeSet` ごとの `client_seq` で重複を除き、ジャーナルに書いた後に `Committed` を Gateway ごとに 1 回配る |
| [0010](../decisions/0010-ordering-keys-and-cycle-rejection.md) | 並びの鍵は base-62 の可変長の文字列。重なりと長さはサーバーが振り直し、複数のノードの挿入には乱数の接頭辞を付け、循環を作る変更は `ChangeSet` ごと拒否する |
| [0011](../decisions/0011-presence-and-fan-out.md) | 在席とカーソルはジャーナルに書かず、Document Server がファイルごとにまとめて Gateway ごとに配る。1 ファイルの参加は 500 人、編集は 200 人まで |
| [0012](../decisions/0012-multiplayer-undo-redo.md) | Undo は自分の変更を打ち消す新しい変更として送る。他の人が後から上書きした値は戻さず、Redo の項目は Undo を実行した時点の値で作る |
| [0013](../decisions/0013-scene-graph-and-tile-rendering.md) | 描画用のシーングラフを別に持ち、256 px のタイルに描いてキャッシュする。パスは CPU で線分にし、GPU で面積の被覆率を求めてアンチエイリアスする |
| [0014](../decisions/0014-gpu-backend-selection-and-fallback.md) | 1 つのビルドに WebGPU と WebGL2 を入れ、WebGPU で始めて、失敗したらキャンバスを作り直して WebGL2 に移る。サーバーは lavapipe の上の wgpu で同じコードを動かす |
| [0015](../decisions/0015-text-shaping-and-glyph-rendering.md) | テキストは HarfRust・Skrifa・ICU4X で整形し、48 px 以下はグリフのアトラス、超えたらパスで描く。グリフのないときの和文のフォールバックはファイルの設定で決める |
| [0016](../decisions/0016-shell-engine-boundary.md) | エンジンと React は同じメインスレッドで動かし、生成した型のコマンドと、フレームに 1 回の話題ごとのスナップショットでやり取りする |
| [0017](../decisions/0017-text-input-via-hidden-textarea.md) | キャンバスの上のテキストの入力は、全ブラウザで隠した textarea で受ける。EditContext は Firefox・Safari の対応を待つ |
| [0018](../decisions/0018-vector-networks-and-boolean-operations.md) | ベクターネットワークの編集は編集した人が計算して全体を書く。ブール演算の結果は保存せず、i_overlay の整数の演算で求め、平坦化だけ iCurve で曲線を残す |
| [0019](../decisions/0019-auto-layout-engine-and-layout-persistence.md) | オートレイアウトは自前の flexbox に近い計算にし、Taffy を差分のテストの参照にする。結果は derived_layout に保存するが、画面は手元の計算で出し、食い違いは修復の担当が直す。制約は親の大きさを変えた人が当てる |
| [0020](../decisions/0020-deterministic-layout-arithmetic.md) | レイアウトとテキストの測定は f64 の四則と min・max だけで、順序を固定して計算する。標準の超越関数・FMA・並列を使わない。結果を変える変更は ADR を要する |
| [0021](../decisions/0021-derived-instances-and-override-keys.md) | インスタンスの中身は保存せず導出する。上書きは元のノードの ID の経路 × プロパティをキーにし、1 項目ずつ LWW にする |
| [0022](../decisions/0022-component-properties-and-variants-by-id.md) | コンポーネントのプロパティとバリアントは ID で束ねる。名前での対応は、切り替えと入れ替えでの上書きの引き継ぎにだけ使う |
| [0023](../decisions/0023-library-snapshots-imported-into-files.md) | ライブラリは公開の時点の不変のスナップショットで配り、使う側のファイルに写しを取り込む。ファイルをまたぐ生の参照はしない |
| [0024](../decisions/0024-journal-items-and-fencing.md) | ジャーナルは `seq` の範囲の group commit で、フェンスの `epoch` を確かめる `TransactWriteItems` と `ClientRequestToken` で書く。大きな変更は S3 に置き、TTL の漏れは回復のジョブで拾う |
| [0025](../decisions/0025-content-addressed-checkpoints-and-loading.md) | チェックポイントはマニフェストと中身のハッシュで名付けたページのチャンクにし、変わったページだけを書く。クライアントは署名付き URL で CloudFront からチャンクを読んで端末にキャッシュし、その後の変更だけを Document Server から受け取る |
| [0026](../decisions/0026-version-history-restore-and-deletion.md) | 版はチェックポイントに印を付けたもので、復元は差分を 1 つの変更として当てて履歴を消さない。削除はゴミ箱と完全な削除の 2 段で、完全な削除はジョブで S3・ジャーナル・版を消す |
| [0027](../decisions/0027-comments-anchored-to-nodes-in-metadata.md) | コメントは Aurora に置き、ノードの ID と相対の位置で固定する。通知は送る時点で受け手を判定し直し、メールは受け手とファイルごとにまとめる |
| [0028](../decisions/0028-realtime-metadata-subscriptions.md) | メタデータのリアルタイムの更新は、トリガーで書く無効化の outbox と、単純な問い合わせへの分解・再取得の購読層で配る |
| [0029](../decisions/0029-hierarchy-roles-seats-and-link-access.md) | 階層は組織・チーム・プロジェクト・ファイル。水準は全順序で、上位で与えた水準を下位で下げない。ファイルの「招待した人だけ」は上位の一般アクセスを遮る。シートは上限として重ねる |
| [0030](../decisions/0030-single-policy-engine-and-signed-capabilities.md) | 判定関数は API の TypeScript に 1 つだけ置き、ポリシーは JSON で表せる allow / deny の規則で書く。Gateway は API が発行する署名付きの能力のチケットで判断する |
| [0031](../decisions/0031-org-acl-version-and-connection-revalidation.md) | 実効権限は組織の acl_version をキーにキャッシュする。長く続く接続は、acl.changed と 5 分ごとの再検証で判定し直し、下げる・切る |
| [0032](../decisions/0032-name-search-in-aurora.md) | MVP の名前の検索は Aurora の中で行う。組織の行を部分一致で絞り、候補を読めうる資源の集合で絞り、判定関数で読み直す |
| [0033](../decisions/0033-content-search-from-checkpoints.md) | MVP の後の中身の検索は、Worker がチェックポイントからノードの名前とテキストを取り出し、OpenSearch に索引する。権限は資源の連鎖を文書に持たせて問い合わせの時点で絞り、判定関数で読み直す |
| [0034](../decisions/0034-export-rendering-split.md) | 画面からの書き出しはクライアントのエンジンで描き、サムネイル・API・大きな一括の書き出しはネイティブのエンジンの Render Worker で描く |
| [0035](../decisions/0035-content-addressed-images.md) | 画像は組織ごとに中身の SHA-256 で重複を除き、クライアントで正規化してから署名付き PUT で上げ、別ドメインの CDN から短命の署名付き URL で配る |
| [0036](../decisions/0036-font-sources-and-licensing.md) | フォントの出どころは同梱のオープンなフォント・組織のフォント・端末のフォントの 3 つにし、サーバーの描画と PDF への埋め込みはライセンスの確かなものに限る |
| [0037](../decisions/0037-plugin-sandbox-quickjs-wasm.md) | プラグインのコードは QuickJS を WASM にした専用のインスタンスでメインスレッドに動かし、UI と通信は別のオリジンの null origin の iframe に置く |
| [0038](../decisions/0038-plugin-api-and-capabilities.md) | プラグインの API は動かした人の権限の中で動き、manifest で宣言した能力と通信先だけを許し、書き込みは通常の変更（ChangeSet）にする |
| [0039](../decisions/0039-plugin-distribution-and-review.md) | 組織の中のプラグインは審査なしで配り、公開のプラグインは初回と権限の拡大で人が審査する。版は不変に保存し、停止のスイッチを持つ。ウィジェットは別の ADR にする |
| [0040](../decisions/0040-public-rest-api-surface.md) | 公開 API は別のサービスにし、利用者の権限とスコープの積で動かす。ファイルの中身は Rust の読み取り専用のサービスが返し、中身の書き込みは出さない。トークンは PKCE 必須の OAuth 2.1 と期限必須の個人のトークン |
| [0041](../decisions/0041-webhook-delivery.md) | Webhook は中身を含まない HMAC で署名したイベントを、配送の時点の権限で判定し、隔離した egress から少なくとも 1 回送る |
| [0042](../decisions/0042-api-versioning-and-rate-limits.md) | 公開 API の版は URL の大きな版にし、ノードの JSON はプロパティの表から生成して表の列で公開を決める。レート制限は操作の重さの tier と画素の予算で数える |
| [0043](../decisions/0043-authentication-sessions-and-org-sso.md) | 認証とセッションは Slack の ADR-0012 を引き継ぎ、組織の SAML SSO はメンバーにだけかける。長く続く接続は、セッションの取り消しでも切る |
| [0044](../decisions/0044-encryption-keys-and-client-cache.md) | 保存時の暗号化はデータの種類ごとの KMS の鍵（マルチリージョン）で行い、組織ごとの鍵は MVP で持たない。端末のキャッシュは暗号化せず、組織の方針で止められるようにする |
| [0045](../decisions/0045-audit-log-and-data-lifecycle.md) | 監査ログは操作と同じトランザクションで書いて改ざんできない保管へ送り、組織の管理者に見せる。削除は東京と大阪の両方で、バックアップの期限を最終の期限にする |
| [0046](../decisions/0046-multiplayer-compute-on-fargate-with-drain.md) | Gateway と Document Server は ECS Fargate（ARM64）で動かし、Document Server はタスクの保護と自前のドレインでファイルを渡してから止める。WebSocket は CloudFront と ALB で受ける |
| [0047](../decisions/0047-router-task-liveness-and-file-assignment.md) | Router は、タスクごとの生存の記録と、ファイルごとの割り当ての記録を分けて持つ。手放しの記録、回復のジョブ、削除済みの割り当てで、ADR-0024 の前提を満たす |
| [0048](../decisions/0048-osaka-dr-with-journal-generations.md) | 大阪への災害復旧は、DynamoDB のグローバルテーブル（MREC）・S3 の複製・Aurora の Global Database と縮小したウォームスタンバイで行い、切り替えのたびに「世代」を上げてジャーナルとチェックポイントの置き場所を分ける |
| [0049](../decisions/0049-client-telemetry-without-content.md) | クライアントの計測（フレーム時間・メモリ・WASM の異常終了）は、ブラウザの中で集計してから、中身を含まない形で自前の受け口へ送る |
| [0050](../decisions/0050-editing-slis-and-slos.md) | 編集の SLO は「開ける」と「確定する」の 2 つのイベントの SLI で数え、反映の遅延は合成のボットで、回復の時間は Router の記録で測る |
| [0051](../decisions/0051-document-server-memory-admission.md) | Document Server は、ファイルごとのメモリを見積もって受け入れを決め、タスクのメモリの 75% を上限にする。大きなファイルは別の群れに置く |
| [0052](../decisions/0052-journal-throughput-and-hot-file-budget.md) | ジャーナルの表はオンデマンドで事前に温め、1 ファイルの書き込みは予算で抑える。予算を超えそうなファイルは、まとめの間隔を段階的に広げる |
| [0053](../decisions/0053-client-server-version-skew.md) | クライアントとサーバーの版は、送受信の形式の版・スキーマの互換の一覧・最低のビルドの 3 つで照合する。再読み込みは、穏やかなものと強いものを分ける |
| [0054](../decisions/0054-wasm-native-parity-and-bundle-budgets.md) | WASM とネイティブの一致を、同じ入力の列から作った正準形のバイト列で PR ごとに確かめ、WASM の大きさと描画の性能に予算を置いて CI で止める |
| [0055](../decisions/0055-staged-rollout-and-schema-changes.md) | クライアントのビルドは組織の割合で段階的に出し、適用の規則を変えるフラグはファイルごとに Document Server が決めて配る。プロパティの表の変更は「サーバー → クライアント → 書き込みの解禁」の 3 段で出す |

領域ごとの ADR は、8 節の番号の範囲で起票する。範囲を使い切ったら 0056 以降から振る。リポジトリ共通の決定（本家の名前・接頭辞・ドメインを使わない [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md) など）は、ルートの [docs/decisions/](../../../../docs/decisions/README.md) にある。

## 7. リスクと未解決事項

品質の面のリスクの順位と対策は [quality.md](../quality.md) の 1 節にある。ここは設計の面のリスクを書く。

- **巨大なファイル**：10 万ノードを超えるファイルでの、開く時間・メモリ・フレームレート。WASM の 32 ビットのメモリ空間（最大 4 GB。Safari が memory64 に対応していない）の中で収める。ページ単位の読み込み、画像の縮小版、キャッシュの追い出しと安全な描画の状態で抑える。HAMT の読み取りの速さと 1 ノードあたりのメモリは E2 の前の PoC で確かめる（NFR-003〜005）。
- **収束の破れ**：クライアントとサーバーで同じ変更の結果が違うと、画面が収束しない。`doc-model`・`layout` の一致の CI（[ADR-0054](../decisions/0054-wasm-native-parity-and-bundle-budgets.md)）、レイアウトの決定性の規則（[ADR-0020](../decisions/0020-deterministic-layout-arithmetic.md)）、版の照合（[ADR-0053](../decisions/0053-client-server-version-skew.md)）、ファイルごとの文書のフラグ（[ADR-0055](../decisions/0055-staged-rollout-and-schema-changes.md)）で抑える。
- **二重の持ち主と確定の損失**：ネットワークの分断や停止で、2 つの Document Server が同じファイルを持つと、変更が分かれうる。割り当ての `epoch` とジャーナルのフェンス（[ADR-0024](../decisions/0024-journal-items-and-fencing.md)、[ADR-0047](../decisions/0047-router-task-liveness-and-file-assignment.md)）で片方だけが確定できるようにする。回復のジョブが止まると、ジャーナルの TTL（30 日）で編集を失う危険がある。見張りとアラームで守る。
- **Document Server のホットスポット**：1 つのファイルに数百人が同時に入ると、1 つのプロセスとジャーナルの 1 つのパーティションに集中する。参加の上限（500 人・編集 200 人。[ADR-0011](../decisions/0011-presence-and-fan-out.md)）、Gateway ごとに 1 回の配信、書き込みの予算の段（[ADR-0052](../decisions/0052-journal-throughput-and-hot-file-budget.md)）、チャンクの CDN での配信（ADR-0025）で抑える。500 人を超える需要は S2 の前に配信の木を ADR にする。
- **WebGPU と WebGL2 の両立**：wgpu の「両方を有効にすると WebGL に戻らない」不具合（[gfx-rs/wgpu#6166](https://github.com/gfx-rs/wgpu/issues/6166)）は [gfx-rs/wgpu#6371](https://github.com/gfx-rs/wgpu/pull/6371) で解決した（2026-09-27 に確認）。キャンバスを作り直しての切り替えの時間、両方を入れた WASM の大きさ（5 MB）、R16F の加算のブレンドが WebGL2 で使えるかは **未検証** で、E2 の前の PoC で確かめる。満たさなければ 2 つのビルドを配る（[ADR-0014](../decisions/0014-gpu-backend-selection-and-fallback.md) の退路）。
- **サーバーの描画の性能**：Fargate に GPU がないので、Render Worker は CPU の lavapipe で描く。10 万ノードのサムネイルを p95 10 秒で描けるかは **未検証**（E10 の PoC）。足りなければ GPU のインスタンスを別の ADR で検討する。
- **キャンバスの上の日本語の入力**：自前で描画するため、IME の変換中の表示と候補の窓の位置を、隠した `textarea` で扱う（[ADR-0017](../decisions/0017-text-input-via-hidden-textarea.md)）。見えなくし方と、ブラウザ・IME ごとのイベントの順序は E4 の前の PoC で確かめる。
- **フォント**：和文のフォントは大きく（1 書体で数 MB）、読み込みの時間とメモリに効く。ライセンスは法務の確認待ち（[intent.md](../intent.md) の L1）。
- **クライアントとサーバーの版の食い違い**：エンジンの WASM はタブに何時間も残る。接続時に 3 つの版（`protocol_version`、`schema_hash` の互換の一覧、`min_client_build`）で照合し、互換の外だけ強い再読み込みにする（[ADR-0053](../decisions/0053-client-server-version-skew.md)）。
- **大阪への切り替え**：グローバルテーブルは非同期で項目ごとに最後の書き込みが勝つ。切り替えのたびに世代を上げてキーを分け、失った範囲を版として取り戻す（[ADR-0048](../decisions/0048-osaka-dr-with-journal-generations.md)）。RTO の内訳と、障害中に東京のレプリカを外せるかは DR の訓練で確かめる。
- **法務**：フォント、権利侵害の申し立て、公開のリンク、削除の期間、漏洩の報告、本家への寄せ方は、法務の確認待ち（[intent.md](../intent.md) の L1〜L6）。結論が出るまで、該当する Story の spec を承認しない。

### 決定（2026-09-27、既定案）

PM の方針（本家に寄せる、既定案で進める）により、統合の工程で次のとおり決めた。法務の判断が要るものは決めず、[intent.md](../intent.md) の「法務の確認待ち」（L1〜L6）に残した。

- **ADR と intent の状態**：基盤の ADR（0001〜0005）と intent.md を、他の題材と同じく `accepted` にした。先に次を直した。
  - ADR-0002：ノードの ID の名前を ADR-0007 の `(session_id, local_id)` に揃え、鍵の振り直しの長さを ADR-0010（48 バイトで振り直し、上限 64 バイト）に揃えた。
  - ADR-0003：ジャーナルの書き込みの条件にフェンスの `epoch` を足し（ADR-0024）、TTL を「書いた時点から 30 日＋回復のジョブ」（ADR-0024・0047）にし、世代のキー（ADR-0048）を足した。
  - ADR-0004：wgpu#6166 は #6371 で解決、Vello GPU は WebGL2 に対応したが panic と wgpu の外の経路のため採らない、rustybuzz はアーカイブされ HarfRust を使う、サーバーの描画は Fargate に GPU がないので CPU（lavapipe）だけ、起動は WebGPU で始め WebGL2 に戻る（ADR-0014 と本家の記事）。
  - ADR-0005：ファイルごとのリースの延長を、ADR-0047 のタスクの生存＋ファイルの割り当てに置き換え、書き込みの条件にフェンスを足した。
  - 本題材の AGENTS.md のジャーナルの規則にフェンスを足した。
- **読み込みの経路**：チャンクは CloudFront から読み、Document Server は計画と tail だけを送る（ADR-0025。2.2 節を直した）。
- **`derived_layout`**：画面はいつも手元の計算。保存された値を書くのは入力を変えた本人と修復の担当。サーバーは型と範囲だけを検証する。`derived` のプロパティは Undo の項目に入れない（ADR-0019、ADR-0012 の注記。document-model.md の 4.4・9.2 節、multiplayer.md の 10 節を直した）。Render Worker は保存されないインスタンスの中身だけを計算する（export-and-assets.md の 5.2 節を直した）。
- **メモリ**：10 万ノードの `Doc` は 200 MiB（document-model.md の 10 節を正とし、rendering-engine.md の 11 節の単位を揃えた）。
- **CDN の署名**：署名はキャッシュの鍵に含めない。署名付き URL は取得を許すもので、キャッシュのオブジェクトは中身のハッシュで名付け、パスに組織（`images/{org_id}/…`）かファイル（`files/{file_id}/…`）を含むので、組織をまたいで共有されない（permissions-and-sharing.md の 11 節を直した）。
- **S3 の削除**：削除とライフサイクルは大阪へ複製されないので、完全な削除・掃除・画像の mark-and-sweep を東京と大阪の両方で行う（ADR-0045。file-storage-and-history.md の 11.2 節、export-and-assets.md の 6.5 節を直した）。
- **版の照合**：`schema_hash` の不一致で再読み込みにする規則を、ADR-0053 の 3 つの版の照合に置き換えた（document-model.md の 8.4 節、multiplayer.md の 4.3 節）。
- **キーの世代**：ジャーナルの `{file_id}#g{n}` とマニフェストの `checkpoints/g{n}/` を file-storage-and-history.md の 4.1・5 節に足した。取り戻した版は `salvage/g{n}/` に置く（[data-model.md](data-model.md) の 11 節）。
- **領域の間の提案**：`thumbnail_node`、`cjk_fallback_font`、レイアウトのプロパティ、`component_prop_values` などのコンポーネントのプロパティ、表の列 `public_api`・`api_name`・`api_since`・`public_plugin`、`ChangeSet` の `origin`、マニフェストの `features`、`Hello.protocol_version`、再接続の最初の 0〜5 秒の乱数の待ち、`file_versions.kind = dr_salvaged`、ファイルの `maintenance` の状態を取り込んだ（data-model.md の 9・11 節）。
- **呼び名**：本家は 2026-08-03 から「プロジェクト」を「フォルダー」に改名している。本システムは「プロジェクト」のまま進め、表とコードも `project` にする。画面の呼び名は PM が E9 の前に決める（permissions-and-sharing.md の 15 節）。
- **Epic**：E1〜E12 が MVP、E13 ライブラリ、E14 プラグイン、E15 公開 API と Webhook。それ以外の MVP の後の機能は [roadmap.md](../roadmap.md) の延期の一覧。領域の文書の仮の Epic の番号を roadmap.md に揃えた（rendering-engine.md と editor-and-tools.md の E8・E9 の入れ替わり、「後」「後-P」「後-A」の置き換え）。組織の SAML SSO は ADR-0043 のとおり E12 に作るが、MVP の範囲の外で GA の判定に含めない。
- **数値の正本**：SLO とアラートは [runbooks/README.md](../runbooks/README.md) の 1・4 節。上限（ファイル・ノード）は document-model.md の 11 節、送受信の上限は multiplayer.md の 4.6 節、メモリの予算は rendering-engine.md の 11 節、容量のパラメーターは capacity.md の 10 節、保持の期間は security.md の 7 節。
- 領域ごとの決定は、各文書の「決定（2026-09-27、既定案）」の節にある。

持ち越し（計測・PoC で決めるもの）：

| 項目 | いつ・どう決めるか |
| --- | --- |
| DynamoDB のトランザクションの書き込みの p99（40ms の予算）、フェンスの `ConditionCheck` の単位の種類 | E3 の前の PoC |
| 1 つのビルドでの WebGPU と WebGL2 の切り替え、WASM の大きさ、R16F の加算のブレンド | E2 の前の PoC（ADR-0014） |
| HAMT をクライアントでも使うか、10 万ノードの `Doc` のメモリ | E2 の前の PoC |
| `textarea` の見えなくし方、ブラウザ・IME ごとのイベントの順序 | E4 の前の PoC（ADR-0017） |
| レイアウトの全体の計算の時間（10 万ノードで 300 ms）、本家との細部の一致 | E5 の前の計測、E5 で 50 の場面を比べる |
| 見積もりの係数（メモリ＝圧縮の前のチェックポイント × 3）、ファイルの大きさの分布 | E7 の計測、試用の期間 |
| lavapipe での書き出しの時間、CloudFront の署名とキャッシュの振る舞い、子のプロセスのネットワークの名前空間 | E10 の PoC |
| CloudFront の WebSocket のアイドルの期限、Fargate の退役がタスクの保護を待つか | E3 の PoC |
| RTO の内訳、障害中にグローバルテーブルから東京のレプリカを外せるか | E12 の DR の訓練 |
| 費用の単価 | E12 の前に、AWS の料金の計算ツールで置き換える |

## 8. 領域の文書

持ち主は、どれも Dev が書き、「レビュー」の列のロールが確認する。ADR は下の範囲の中で採番する。

| ファイル | 範囲 | ADR | レビュー | 関わる Epic |
| --- | --- | --- | --- | --- |
| [document-model.md](document-model.md) | ノードの種類、プロパティの表、ID、木の不変条件、変更の操作、直列化の形式、大きさの上限 | 0006〜0008 | QA | E3 |
| [multiplayer.md](multiplayer.md) | 送受信、確定、LWW、分数インデックス、循環の拒否、合わせ直し、再接続、Undo、在席とカーソル、人が集まるファイル | 0009〜0012 | QA | E3 |
| [rendering-engine.md](rendering-engine.md) | シーングラフ、タイル、GPU の抽象とバックエンド、パスの描画、エフェクト、テキストの描画、画像、メモリ、サーバーの描画 | 0013〜0015 | QA | E1、E2、E4 |
| [editor-and-tools.md](editor-and-tools.md) | UI の殻とエンジンの境界、選択・変形・スナップ、ペンとベクターネットワーク、ブール演算、テキストの編集と IME、ショートカット、アクセシビリティ | 0016〜0018 | QA | E2、E4 |
| [layout.md](layout.md) | 制約、オートレイアウト、テキストの折り返し、結果の保存と修復、決定性、増分の再計算 | 0019〜0020 | QA | E5 |
| [components-and-libraries.md](components-and-libraries.md) | コンポーネント、インスタンスと上書き、バリアント、プロパティ。ライブラリ（E13） | 0021〜0023 | QA | E6、E13 |
| [file-storage-and-history.md](file-storage-and-history.md) | ジャーナル、チェックポイント、読み込み、回復、版の履歴、復元、複製、削除 | 0024〜0026 | QA、Ops | E7 |
| [comments-and-notifications.md](comments-and-notifications.md) | コメント、メンション、通知、Realtime | 0027〜0028 | QA | E8 |
| [permissions-and-sharing.md](permissions-and-sharing.md) | 階層、役割、シート、招待、ゲスト、共有のリンク、判定関数、取り消し | 0029〜0031 | QA、セキュリティ | E9 |
| [search.md](search.md) | 名前の検索。中身の検索（延期） | 0032〜0033 | QA | E11 |
| [export-and-assets.md](export-and-assets.md) | 書き出し、Render Worker、画像、フォント、サムネイル、外部の画像の取り込み | 0034〜0036 | QA、セキュリティ | E10 |
| [plugins.md](plugins.md) | プラグインのサンドボックス、API、配布と審査（E14） | 0037〜0039 | セキュリティ | E14 |
| [api-and-webhooks.md](api-and-webhooks.md) | 公開の REST API、トークン、Webhook（E15） | 0040〜0042 | QA、セキュリティ | E15 |
| [security.md](security.md) | 信頼境界、脅威モデル、認証、暗号化、監査ログ、データのライフサイクル、不正利用 | 0043〜0045 | セキュリティ | E1、E9、E12 |
| [infrastructure.md](infrastructure.md) | AWS の構成、Gateway と Document Server の置き方、Router、冗長化と DR、段階の移行、費用 | 0046〜0048 | Ops | E1、E3、E12 |
| [observability.md](observability.md) | ログ、メトリクス、トレース、クライアントの計測、SLI、アラート、合成の監視 | 0049〜0050 | Ops | E1〜E3、E12 |
| [capacity.md](capacity.md) | 負荷のモデル、部品ごとの必要量、パラメーター、負荷試験 L1〜L10 | 0051〜0052 | Ops | E3、E12 |
| [delivery.md](delivery.md) | CI/CD、WASM とネイティブの一致、版の照合、段階的なリリース、プロパティの表の変更 | 0053〜0055 | QA、Ops | E1〜E3 |
| [data-model.md](data-model.md) | データの置き場所の索引と統合した定義 | なし（各領域の ADR を参照する） | QA | 全 Epic |

## 9. Epic

Epic と Story の計画は [roadmap.md](../roadmap.md) にある（PM が持つ）。領域の文書の Story の候補は、この番号で書く。

| Epic | 中身 |
| --- | --- |
| E1 基盤とビルド | AWS・Terraform・CI（Rust・WASM・一致・大きさ）、Aurora と RLS、DynamoDB と S3、GPU の抽象と参照画像の枠、殻とエンジンの橋、認証の骨格、可観測性 |
| E2 描画エンジンと大きなファイル | シーングラフ、タイル、パスの描画、塗りと線、バックエンドの選択、画像、メモリ、性能の CI、キャンバスの入力と基本の図形 |
| E3 ドキュメントのモデルとマルチプレイヤー | プロパティの表と生成、操作と検証、正準形、Gateway・Document Server・Router、確定と配信、合わせ直し、再接続、在席、Undo、版の照合、ドレイン |
| E4 ベクターとテキストの編集 | ペンとベクターネットワーク、ブール演算、テキストの整形と編集、IME、エフェクト・ブレンド・マスク、パネル、ショートカット、クリップボード、画像のアップロード |
| E5 フレームとオートレイアウト | 制約、オートレイアウト、`derived_layout` の保存と修復、増分の再計算、Taffy との差分のテスト |
| E6 コンポーネントとバリアント | インスタンスの導出と上書き、入れ子と入れ替え、バリアント、コンポーネントのプロパティ、デタッチと反映 |
| E7 保存と版の履歴 | ジャーナルと group commit、フェンスと回復、チェックポイント、読み込み、回復のジョブ、掃除、版の履歴、復元、複製、ゴミ箱と完全な削除 |
| E8 コメントと通知 | コメントとスレッド、固定、メンション、アプリ内とメールの通知、Realtime の購読 |
| E9 チーム・権限・共有 | 役割と継承、判定関数とポリシー、招待とゲスト、一般アクセスとリンク、シート、取り消し、監査ログ、漏洩のテスト |
| E10 書き出しとアセット | 書き出し（PNG・JPG・SVG・PDF）、Render Worker、画像の取り込みと配信、フォント、サムネイル、外部の画像の取り込み |
| E11 ファイルの一覧と検索 | ファイルブラウザ、最近のファイル、名前の検索 |
| E12 運用と GA の準備 | 負荷試験、DR（大阪と世代）、合成の監視とアラート、侵入試験、取り下げの手順、GA の判定。組織の SSO（GA の判定の外） |
| E13 ライブラリ（MVP の後） | 公開、取り込み、更新の通知と受け入れ |
| E14 プラグイン（MVP の後） | QuickJS のサンドボックス、API、UI の iframe、配布と審査、停止のスイッチ |
| E15 公開 API と Webhook（MVP の後） | `api.<domain>`、file-read、トークン、レート制限、Webhook |

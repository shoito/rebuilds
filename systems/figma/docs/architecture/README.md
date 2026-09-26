# Architecture: Figma

全体像と横断的な方針。領域ごとの設計は、同じディレクトリの各ファイルに置く。

## 0. 領域の文書（予定）

領域ごとの文書は、これから作る。ADR の番号は、領域ごとに次の範囲から振る。範囲を使い切ったら、統合の工程で 0060 以降から振る。

| ファイル（予定） | 領域 | ADR の範囲 |
| --- | --- | --- |
| document-model.md | ノードの種類、プロパティの表、ID、木の不変条件、ファイルの直列化の形式 | 0006〜0008 |
| multiplayer.md | 変更の送受信、LWW、分数インデックス、循環の拒否、再接続、在席とカーソル、Undo | 0009〜0012 |
| rendering-engine.md | シーングラフ、タイル・カリング、GPU の抽象（WebGL2・WebGPU）、テキストの描画、画像のデコード、メモリ | 0013〜0015 |
| editor-and-tools.md | UI の殻（React）とエンジンの境界、選択・変形・スナップ、ペン、ブール演算、テキストの編集と IME、キーボード操作 | 0016〜0018 |
| layout.md | 制約、オートレイアウトの計算、テキストの折り返しとの関係、増分の再計算 | 0019〜0020 |
| components-and-libraries.md | コンポーネント、インスタンスと上書き、バリアント。MVP の後のライブラリの公開と更新 | 0021〜0023 |
| file-storage-and-history.md | ジャーナル、チェックポイント、ファイルの読み込み、版の履歴、復元、複製、削除 | 0024〜0026 |
| comments-and-notifications.md | コメント、スレッド、メンション、通知（アプリ内・メール）、メタデータのリアルタイムの更新 | 0027〜0028 |
| permissions-and-sharing.md | 組織・チーム・プロジェクト・ファイル、役割、招待、ゲスト、共有のリンク、判定関数 | 0029〜0031 |
| search.md | ファイル名の検索。MVP の後のノード名・テキストの検索 | 0032〜0033 |
| export-and-assets.md | 書き出し（PNG・JPG・SVG・PDF）、サーバーでの描画、画像、フォント、サムネイル | 0034〜0036 |
| plugins.md | プラグインの実行環境（サンドボックス）、API、配布（MVP の後） | 0037〜0039 |
| api-and-webhooks.md | 公開の REST API、トークン、Webhook（MVP の後） | 0040〜0042 |
| security.md | 脅威モデル、認証、暗号化、監査ログ、データのライフサイクル、不正利用 | 0043〜0045 |
| infrastructure.md | AWS の構成、マルチプレイヤーの配置、冗長化、災害復旧 | 0046〜0048 |
| observability.md | ログ、メトリクス、トレース、SLO、クライアントの計測（フレーム時間、メモリ） | 0049〜0050 |
| capacity.md | 負荷のモデル、部品ごとの必要量、パラメーター | 0051〜0052 |
| delivery.md | CI/CD、WASM とサーバーの版の整合、リリース、フィーチャーフラグ | 0053〜0055 |
| data-model.md | データモデルの索引（メタデータの表、ジャーナル、S3 のキー） | 0056〜0057 |

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
   メールの送信     決済（プランの課金）  フォントの提供元     IdP（SAML・OIDC。MVP の後）
```

### 1.2 コンテナ

```
ブラウザ
 ├─ UI の殻（TypeScript・React）：ツールバー、パネル、ファイルの一覧、コメント
 └─ エンジン（Rust → WASM）：ドキュメントのモデル、レイアウト、描画（WebGL2 / WebGPU）
      │ HTTPS（ファイルの読み込み、API）          │ WebSocket（変更・在席）
      ▼                                            ▼
 API（Hono）── Aurora（メタデータ、RLS）     Multiplayer Gateway（接続・認可・振り分け）
   │   │                                           │
   │   └─ Realtime（メタデータの購読）             ▼
   │        ◀── outbox ──┘               Multiplayer の Document Server（Rust。ファイルごとに 1 つの持ち主）
   │                                        │ 変更の追記           │ 定期的に
   │                                        ▼                      ▼
   │                                     Journal（DynamoDB）   S3（チェックポイント・版・画像）
   │                                                                │
   └──▶ SQS ──▶ Worker（書き出し・サムネイル＝Rust の描画をネイティブで、通知、検索の索引）
                                                                     │
                                                         CloudFront（画像・フォント・WASM の配布）
 Router（ファイル → Document Server の割り当て。Valkey にキャッシュ、正本はリース）
```

| コンテナ | 責務 |
| --- | --- |
| UI の殻 | React のパネルと画面。エンジンとは型付きのメッセージでやり取りする。キャンバスの描画はしない |
| エンジン（WASM） | ドキュメントのモデル、変更の適用と巻き戻し（rebase）、レイアウト、ヒットテスト、描画。サーバーと同じ `doc-model` の crate を使う |
| API | 認証、組織・チーム・プロジェクト・ファイルのメタデータ、権限、共有、コメント、版の一覧 |
| Realtime | ファイルの一覧・コメント・権限などメタデータの変更を購読で配る（本家の LiveGraph に相当。[LiveGraph](https://www.figma.com/blog/livegraph-real-time-data-fetching-at-figma/)、2021-10-14） |
| Multiplayer Gateway | WebSocket の終端、接続時の権限の判定、Router に問い合わせて Document Server へ中継する |
| Document Server | 1 ファイルを 1 つのプロセス（のタスク）がメモリに持ち、変更に `seq` を振り、検証し、ジャーナルに書き、配る（[ADR-0002](../decisions/0002-central-authoritative-multiplayer.md)、[ADR-0003](../decisions/0003-journal-and-checkpoints.md)） |
| Router | ファイルと Document Server の対応を、リース（期限と世代の番号）で管理する（[ADR-0005](../decisions/0005-tenancy-and-document-routing.md)） |
| Journal | 確定した変更の追記のログ。チェックポイントより後の変更を持つ |
| S3 | チェックポイント（ファイル全体の直列化）、名前付きの版、画像、書き出しの結果 |
| Worker | 書き出し、サムネイル、通知、検索の索引。描画は、エンジンの Rust のコードをネイティブで動かす |

原則は 4 つ。

- **ファイルごとに持ち主は 1 つ。** 1 つのファイルの変更の順序は、そのファイルを持つ Document Server だけが決める。CRDT は使わない（[ADR-0002](../decisions/0002-central-authoritative-multiplayer.md)）。
- **確定の前に永続化する。** 変更は、ジャーナルに書いてから確定を返し、配る（[ADR-0003](../decisions/0003-journal-and-checkpoints.md)）。
- **同じ規則を 1 つのコードで。** 変更の適用・検証・レイアウト・描画は Rust の crate にまとめ、ブラウザ（WASM）とサーバー（ネイティブ）で同じコードを使う（[ADR-0001](../decisions/0001-platform-and-stack.md)）。
- **ファイルの中身とメタデータを分ける。** ファイルの中身（ノードの木）はマルチプレイヤーの経路で扱い、Aurora には置かない。Aurora はメタデータ（組織、権限、コメント、版の一覧）の正本で、RLS で組織を分ける（[ADR-0005](../decisions/0005-tenancy-and-document-routing.md)）。本家も、ファイルの中の同時編集はマルチプレイヤー、ファイルをまたぐデータは LiveGraph と Postgres に分けている（同上の LiveGraph の記事）。

## 2. 主要フロー

### 2.1 編集の確定

1. クライアントのエンジンが、変更を自分のモデルに当て、すぐに描画する。未確定の変更として持つ。
2. 変更を WebSocket で送る。Gateway が Document Server へ中継する。
3. Document Server は、権限（編集できるか）と木の不変条件（循環がない）を確かめ、`seq` を振ってメモリのモデルに当てる。
4. 約 20ms ごとに、たまった変更をまとめてジャーナルに書く（group commit）。条件は「この `seq` がまだない」。
5. 書けたら、送り手に確定（`ack`）を返し、他のクライアントに配る。
6. 他のクライアントは、未確定の自分の変更と同じプロパティへのサーバーの変更を、確定するまで画面に出さない（ちらつきを防ぐ。本家と同じ）。

### 2.2 ファイルを開く

1. API で権限を確かめ、Router にファイルの持ち主を問い合わせる。持ち主がなければ、Router が Document Server を割り当てる。
2. Document Server は、S3 から最新のチェックポイントを読み、ジャーナルからそれより後の変更を当てる。
3. クライアントは、Document Server から、ページ単位でファイルを受け取る。今のページを先に送り、他のページは後から送る（本家も、ページとレイヤーを必要なときに読む。[Reduce memory usage in files](https://help.figma.com/hc/en-us/articles/360040528173-Reduce-memory-usage-in-files)、2026-09-27 に確認）。

### 2.3 Document Server の障害

1. リースが切れると、Router は別の Document Server を割り当てる。
2. 新しい持ち主は、2.2 の 2 と同じ手順で、最後に確定した `seq` まで戻す。
3. クライアントは再接続し、確定していない自分の変更を送り直す。

## 3. 規模の段階

| 段階 | 利用者（月間） | 同時に開いたファイル | 同時接続 | 確定する変更（日） | 構成 |
| --- | --- | --- | --- | --- | --- |
| S1（MVP） | 10 万 | 1 万 | 5 万 | 5,000 万 | 1 リージョン（東京）・3 AZ。Aurora の writer 1 台＋reader。Document Server は 10〜20 タスク |
| S2 | 100 万 | 10 万 | 50 万 | 5 億 | メタデータを縦に分ける（コメント・通知を別のクラスタへ）。Document Server を AZ ごとの群れに分ける。大阪に DR |
| S3 | 1,000 万 | 100 万 | 500 万 | 50 億 | メタデータを `org_id`・`file_id` で横に分ける（シャード）。セル構成。大阪でも編集を受ける |

- 本家の規模の目安：ジャーナルは 1 日に 22 億件を超える変更を受ける（[Making multiplayer more reliable](https://www.figma.com/blog/making-multiplayer-more-reliable/)、2022-10-20、2026-09-27 に確認）。段階 S3 の値は、これより 1 桁大きく見積もって余裕を持たせた。
- 数値は仮置き。capacity.md（これから作る）で、負荷のモデルから置き換える。

## 4. 非機能要件

| ID | 項目 | S1 の目標 | 備考 |
| --- | --- | --- | --- |
| NFR-001 | 同時編集の反映 | 入力から、同じファイルを開いた他の人の画面まで p99 250ms 以内（同じリージョン） | ジャーナルの書き込み（group commit）を含む |
| NFR-002 | 自分の入力の反映 | 入力から自分の画面まで 1 フレーム（16.7ms）以内。サーバーを待たない | |
| NFR-003 | 大きなファイルを開く時間 | 10 万ノードの参照ファイルで、最初のページが操作できるまで p75 5 秒以内（キャッシュなし）、2 秒以内（キャッシュあり） | 参照の端末は quality.md で決める |
| NFR-004 | メモリ | 10 万ノードの参照ファイルで、タブのメモリ 1.5 GB 以内。80% で警告を出す | 本家はタブあたり 2 GB を上限にしている（[Reduce memory usage in files](https://help.figma.com/hc/en-us/articles/360040528173-Reduce-memory-usage-in-files)、2026-09-27 に確認） |
| NFR-005 | フレームレート | 10 万ノードの参照ファイルのパン・ズームで、フレーム時間 p95 16.7ms 以内（60fps） | |
| NFR-006 | 耐久性 | 確定を返した編集は失わない（プロセス・ホスト・AZ の障害）。確定の前に失われうる範囲は、送り直しで回復する | 本家の目標は「失うのは 1 秒未満」（同上の Making multiplayer more reliable） |
| NFR-007 | Document Server の障害からの回復 | 持ち主のプロセスが落ちてから、別の持ち主で編集を再開できるまで p95 15 秒以内 | |
| NFR-008 | 可用性 | 編集（ファイルを開き、変更が確定する）の月間 99.95%。メタデータの API は 99.9% | |
| NFR-009 | 復旧（リージョンの障害） | RPO 1 分以内、RTO 1 時間以内（大阪） | リージョンの喪失では NFR-006 の例外として 1 分までの損失を許す |
| NFR-010 | テナント分離 | 他の組織のファイル・メタデータ、権限のないファイルの中身（サムネイルを含む）が見える事象は 0 件 | |

## 5. 技術スタック

| 層 | 選定 | 理由 |
| --- | --- | --- |
| エンジン | Rust → WASM（`wasm32-unknown-unknown`）。ドキュメントのモデル・レイアウト・描画 | [ADR-0001](../decisions/0001-platform-and-stack.md)。本家は C++ と Emscripten |
| GPU | WebGL2 を必須、WebGPU を使えるときに使う。自前の GPU の抽象の下に wgpu を置く | [ADR-0004](../decisions/0004-gpu-rendering-in-wasm.md) |
| UI の殻 | TypeScript、React | 他の題材と同じ |
| マルチプレイヤー | Rust（tokio）の Document Server。Gateway も Rust | [ADR-0001](../decisions/0001-platform-and-stack.md)、[ADR-0002](../decisions/0002-central-authoritative-multiplayer.md) |
| API・Worker | TypeScript、Hono＋Zod | 他の題材と同じ |
| メタデータ | Aurora PostgreSQL 18。共有スキーマと `FORCE ROW LEVEL SECURITY` | [ADR-0005](../decisions/0005-tenancy-and-document-routing.md) |
| ジャーナル | DynamoDB（条件付きの書き込み） | [ADR-0003](../decisions/0003-journal-and-checkpoints.md) |
| キャッシュ・配信 | ElastiCache（Valkey） | 他の題材と同じ |
| ファイル・配布 | S3、CloudFront | |
| 非同期 | transactional outbox → SQS | 他の題材と同じ |
| 実行基盤 | AWS 東京（3 AZ）、大阪を DR。ECS Fargate | [ADR-0001](../decisions/0001-platform-and-stack.md) |
| IaC・可観測性 | Terraform、OpenTelemetry | 他の題材と同じ |

## 6. 主な決定

| ADR | 決定 | 状態 |
| --- | --- | --- |
| [0001](../decisions/0001-platform-and-stack.md) | 基盤は他の題材を引き継ぎ、エンジンとマルチプレイヤーのサーバーは Rust で書く | proposed |
| [0002](../decisions/0002-central-authoritative-multiplayer.md) | 同時編集は、ファイルごとの中央のサーバーが順序を決める。プロパティ単位の LWW、分数インデックス、循環の拒否 | proposed |
| [0003](../decisions/0003-journal-and-checkpoints.md) | ファイルはメモリに持ち、確定の前にジャーナルへ書き、定期的に S3 へチェックポイントを書く | proposed |
| [0004](../decisions/0004-gpu-rendering-in-wasm.md) | 描画は WASM の中の自前のエンジンで、WebGL2 を必須、WebGPU を使えるときに使う | proposed |
| [0005](../decisions/0005-tenancy-and-document-routing.md) | メタデータは共有スキーマと FORCE RLS で組織を分け、ファイルは Router のリースで Document Server へ振り分ける | proposed |

領域ごとの ADR は、各文書から参照する。リポジトリ共通の決定（本家の名前・接頭辞・ドメインを使わない [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md) など）は、ルートの [docs/decisions/](../../../../docs/decisions/README.md) にある。

## 7. リスクと未解決事項

- **巨大なファイル**：10 万ノードを超えるファイルでの、開く時間・メモリ・フレームレート。WASM の 32 ビットのメモリ空間（最大 4 GB）の中で収める必要がある。ページ単位の読み込みと、画像の縮小版で抑える。E2 の前の PoC で確かめる（NFR-003〜005）。
- **Document Server のホットスポット**：1 つのファイルに数百人が同時に入る（全社の会議で同じファイルを開く）と、1 つのプロセスに集中する。閲覧だけの接続は、配信を別のノードに分ける案を multiplayer.md で検討する。
- **二重の持ち主**：ネットワークの分断で、2 つの Document Server が同じファイルを持つと、変更が分かれる。ジャーナルの条件付きの書き込みで、片方だけが確定できるようにする（[ADR-0003](../decisions/0003-journal-and-checkpoints.md)）。
- **WebGPU と WebGL2 の両立**：wgpu で、1 つのビルドの中で実行時に WebGPU から WebGL2 へ切り替えられるかは **未検証**（切り替えに不具合の報告がある。[gfx-rs/wgpu#6166](https://github.com/gfx-rs/wgpu/issues/6166)、2026-09-27 に確認）。できなければ、2 つのビルドを配り、読み込み時に選ぶ（[ADR-0004](../decisions/0004-gpu-rendering-in-wasm.md)）。
- **キャンバスの上の日本語の入力**：自前で描画するため、IME の変換中の表示と候補の窓の位置を、ブラウザの部品なしで扱う必要がある。editor-and-tools.md で決め、E4 の前の PoC で確かめる。
- **フォント**：和文のフォントは大きく（1 書体で数 MB）、読み込みの時間とメモリに効く。ライセンスは法務の確認待ち（[intent.md](../intent.md) の L1）。
- **クライアントとサーバーの版の食い違い**：エンジンの WASM とサーバーの `doc-model` の版が違うと、同じ変更の結果が変わりうる。接続時に版を確かめ、合わなければ再読み込みを求める（delivery.md で決める）。
- **法務**：フォント、権利侵害の申し立て、公開のリンク、削除の期間、漏洩の報告、本家への寄せ方は、法務の確認待ち（[intent.md](../intent.md) の L1〜L6）。

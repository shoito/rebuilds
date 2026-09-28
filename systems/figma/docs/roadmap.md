# Roadmap: Figma

## 進め方の原則

- **最初に walking skeleton を通す。** E1〜E3 で、エンジンの WASM・GPU の抽象・`doc-model` の表と生成・Gateway・Document Server・Router・ジャーナルへの書き込みを端から端まで貫き、2 つのブラウザで同じ矩形を動かせるところまで作ってから、機能を広げる。一致の CI（[ADR-0054](decisions/0054-wasm-native-parity-and-bundle-budgets.md)）、収束のシミュレーター、フェンスのある書き込み、テナントの RLS は、E1〜E3 から本物の形で作る。後から足すと直せないため。
- **PoC を先に済ませる。** 次の PoC は、それぞれの Epic の Story の spec を承認する前に結果を記録する：WebGPU と WebGL2 の 1 つのビルドでの切り替え・WASM の大きさ・R16F の加算のブレンド（E2 の前。[ADR-0014](decisions/0014-gpu-backend-selection-and-fallback.md)）、HAMT の読み取りの速さとメモリ（E2 の前）、DynamoDB のトランザクションの p99（E3 の前）、隠した `textarea` と IME（E4 の前。[ADR-0017](decisions/0017-text-input-via-hidden-textarea.md)）、レイアウトの全体の計算の時間（E5 の前）、lavapipe での書き出しの時間と CDN の署名（E10 の前）。
- **規則は 1 つのコードに。** ファイルの中身の規則は `doc-model` の crate にだけ書く。結果を変える規則の変更は、文書のフラグ（`release.doc.*`）の裏に置き、ファイルごとに切り替える（[ADR-0055](decisions/0055-staged-rollout-and-schema-changes.md)）。
- **契約を先に固定する。** プロパティの表（`schema/properties.toml`）、送受信のメッセージ、チェックポイントの形式、判定のポリシーは、人間がレビューして確定する。エージェントは勝手に変えない。追加以外の表の変更は `schema-breaking` と Dev のテックリードの承認を要する（[ADR-0053](decisions/0053-client-server-version-skew.md)）。
- **法務の確認待ちの Story は、spec を承認しない。** 設計と、法務に依らない Story は進めてよい（[intent.md](intent.md) の「法務の確認待ち」L1〜L6）。下の表で「法務：L*」と書いた Story が当たる。
- **1 変更 1 PR を目安に、差分を小さくする。** Document Server・Router の変更は、ドレインの波で出す（[delivery.md](architecture/delivery.md) の 5.3 節）。

## Epic

PM が持つ。変更の一覧はここに書かず、各変更の `spec.md` の frontmatter（`epic`）から集計する（[process.md](../../../docs/process.md) の「粒度」）。各 Epic の品質の重点と合否基準は [quality.md](quality.md) の 5 節にある。

| Epic | 目的 | 状態 |
| --- | --- | --- |
| E1 基盤とビルド | AWS・Terraform・CI（Rust・WASM・一致・大きさ・参照画像の枠）、Aurora と RLS、DynamoDB と S3 と CDN、GPU の抽象の骨格、殻とエンジンの橋、認証、能力のチケット、可観測性、フラグとビルドの配信 | 設計中 |
| E2 描画エンジンと大きなファイル | シーングラフ、タイル、パスの被覆率、塗りと線、バックエンドの選択と切り替え、画像のデコード、メモリの予算、性能の CI、キャンバスの入力・選択・変形・基本の図形、クライアントの計測 | 未着手（前に GPU の PoC と HAMT の PoC） |
| E3 ドキュメントのモデルとマルチプレイヤー | プロパティの表と生成、操作と検証、木の不変条件、正準形、Gateway・Router・Document Server、確定と配信、合わせ直し、並びの鍵、再接続、在席、Undo、版の照合、文書のフラグ、ドレイン、メモリの受け入れと書き込みの予算 | 未着手（前に DynamoDB の PoC） |
| E4 ベクターとテキストの編集 | ペンとベクターネットワーク、ブール演算、スナップ、テキストの整形・改行・編集、IME、エフェクト・ブレンド・マスク、パネル、ショートカット、クリップボード、画像のアップロード、SVG の読み込み | 未着手（前に IME の PoC。ショートカットは法務：L6） |
| E5 フレームとオートレイアウト | 制約、オートレイアウト（折り返し、ベースライン、最小・最大）、`derived_layout` の保存と修復、増分の再計算、Taffy との差分のテスト | 未着手 |
| E6 コンポーネントとバリアント | インスタンスの導出と上書き、入れ子と入れ替え、バリアント、コンポーネントのプロパティ、デタッチと反映、導出の描画とレイアウト | 未着手 |
| E7 保存と版の履歴 | ジャーナルの group commit・フェンス・回復、チェックポイント、読み込みの計画と端末のキャッシュ、回復のジョブ、掃除、版の履歴、復元、複製、ゴミ箱と完全な削除（東京と大阪）、障害の注入と影の検証 | 未着手（削除の期間は法務：L4） |
| E8 コメントと通知 | コメントとスレッド、固定、メンション、アプリ内とメールの通知、Realtime の購読 | 未着手 |
| E9 チーム・権限・共有 | 役割と継承、判定関数とポリシー、招待とゲスト、一般アクセスとリンクの期限、シート、取り消し、閲覧の UI、監査ログ、漏洩のテスト | 未着手（公開のリンクの取り下げは法務：L3） |
| E10 書き出しとアセット | クライアントの書き出し（PNG・JPG・SVG・PDF）、Render Worker、画像の取り込みと配信、フォント、サムネイル、外部の画像の取り込み、描画の一致の集合 | 未着手（組織のフォント・端末のフォントは法務：L1。権利の侵害は L2） |
| E11 ファイルの一覧と検索 | ファイルブラウザ、最近のファイル、名前の検索、人の検索 | 未着手 |
| E12 運用と GA の準備 | 負荷試験 L1〜L10、大阪のウォームスタンバイと世代と取り戻し、DR の訓練、合成のボットとアラート、侵入試験、取り下げの手順、GA の判定。組織の SSO（GA の判定の外） | 未着手（GA の判定は法務：L1〜L6） |
| E13 ライブラリ（MVP の後） | コンポーネントのライブラリの公開、取り込み（写し）、更新の通知と受け入れ、移動、資産の検索 | 未着手（MVP の後） |
| E14 プラグイン（MVP の後） | QuickJS のサンドボックス、membrane、API、UI の iframe と通信、保存、組織の統制、公開と審査、停止のスイッチ | 未着手（MVP の後） |
| E15 公開 API と Webhook（MVP の後） | `api.<domain>`、file-read、トークン（個人・OAuth・組織）、スコープ、レート制限、Webhook | 未着手（MVP の後） |

E1〜E12 が MVP（S1）。領域の文書の「Story の候補」は、この番号で書く。

## Story

各 Story は、着手するときに `changes/YYMMDD-<slug>/` として起票する。ここは計画で、進み具合は各変更の `spec.md` の frontmatter で見る。順序は Epic の中での目安で、依存があるものを先に置いた。各領域の文書の「Story の候補」から集めた。同じ中身の Story が 2 つの文書にあるものは 1 つにした。

### E1 基盤とビルド

設計：[infrastructure.md](architecture/infrastructure.md)、[delivery.md](architecture/delivery.md)、[observability.md](architecture/observability.md)、[security.md](architecture/security.md)、[data-model.md](architecture/data-model.md)

| Story | 内容 |
| --- | --- |
| `dev-repo-bootstrap` | Figma の再構築の開発リポジトリを作り、`changes/`・`specs/`・開発向けの `AGENTS.md`、CODEOWNERS（`crates/doc-model`・`schema/` はテックリード）を置く（リポジトリ共通の ADR-0005） |
| `aws-accounts-and-network` | アカウント、SCP、VPC、エンドポイント、NAT（Slack・Stripe の Terraform のモジュールを流用。[infrastructure.md](architecture/infrastructure.md) の 1・2 節） |
| `terraform-layout` | ルートモジュールの分け方、状態ファイル（東京と大阪）、`prevent_destroy`（10 節） |
| `ecs-rust-services-baseline` | Rust のサービスの ECS のテンプレート（ARM64、ログ、OTel、ヘルスチェック） |
| `kms-keys-and-policies` | データの種類ごとの KMS の鍵、鍵のポリシー、大阪のレプリカ（[ADR-0044](decisions/0044-encryption-keys-and-client-cache.md)） |
| `aurora-orgs-and-rls` | 組織・チーム・プロジェクト・ファイルの表と FORCE RLS、`SET LOCAL app.org_id`、最小の判定関数（所有者だけ）（[permissions-and-sharing.md](architecture/permissions-and-sharing.md)、[data-model/organization.md](architecture/data-model/organization.md)） |
| `dynamodb-journal-table` | `journal`・`file_leases`・`ds_liveness` の表、TTL、PITR、グローバルテーブル（大阪）、IAM（[file-storage-and-history.md](architecture/file-storage-and-history.md)） |
| `dynamodb-warm-throughput` | warm throughput と表の上限の申請（[capacity.md](architecture/capacity.md) の 4 節） |
| `files-bucket` | files のバケット、バージョニング、SSE-KMS、大阪へのレプリケーション、両方のライフサイクル、`files.<brand>usercontent` の CloudFront の署名付き URL |
| `assets-bucket-and-cdn` | assets のバケット、`assets.<brand>usercontent` のドメイン、CloudFront の署名の鍵、応答のヘッダーの固定（[export-and-assets.md](architecture/export-and-assets.md)） |
| `auth-better-auth-baseline` | Better Auth、`global.accounts`・`sessions`、メールの確認コード、Google、パスキー（[ADR-0043](decisions/0043-authentication-sessions-and-org-sso.md)） |
| `capability-tickets` | 能力のチケット（Ed25519、60 秒、1 回だけ）の発行と、Gateway での検証、`jti` の Valkey（[ADR-0030](decisions/0030-single-policy-engine-and-signed-capabilities.md)） |
| `csp-and-security-headers` | CSP（`wasm-unsafe-eval`）、HSTS、`nosniff`、CSRF のヘッダー |
| `ci-rust-wasm-baseline` | Rust の検査、`wasm-bindgen-test`、merge queue（[delivery.md](architecture/delivery.md) の 2.1 節） |
| `wasm-native-parity-ci` | 一致の CI（wasm32・aarch64・x86_64。PROP-DM-004）（delivery.md の 3.1 節） |
| `wasm-size-budget` | WASM 5 MB・PR 50 KB・JS 1 MB の予算（delivery.md の 3.3 節） |
| `gpu-crate-skeleton` | `gpu` の crate の骨格と lint（`web-sys` の禁止）。WASM とネイティブの両方のビルド（[rendering-engine.md](architecture/rendering-engine.md)） |
| `golden-image-harness` | 参照画像のテストの仕組み（lavapipe、headless の Chromium の WebGPU・WebGL2）と、差の画像の PR への添付 |
| `shell-engine-bridge` | コマンドと話題の型の生成、同期の呼び出し、`useSyncExternalStore`、エンジンの panic の hook（[ADR-0016](decisions/0016-shell-engine-boundary.md)） |
| `otel-rust-baseline` | Rust の OTel、共通の属性、ログの型の規則（中身を書かない）（[observability.md](architecture/observability.md)） |
| `realtime-skeleton` | Realtime の最小の形（1 つのビュー、トリガーの無効化、edge の取り直し）（[comments-and-notifications.md](architecture/comments-and-notifications.md) の 5 節） |
| `client-build-channels` | クライアントのビルドの段階的な配信（delivery.md の 6.2 節） |

### E2 描画エンジンと大きなファイル

設計：[rendering-engine.md](architecture/rendering-engine.md)、[editor-and-tools.md](architecture/editor-and-tools.md)、[ADR-0013](decisions/0013-scene-graph-and-tile-rendering.md)〜[ADR-0014](decisions/0014-gpu-backend-selection-and-fallback.md)

| Story | 内容 |
| --- | --- |
| `gpu-backend-poc` | PoC：1 つのビルドでの WebGPU と WebGL2、キャンバスを作り直しての切り替え、R16F の加算のブレンド、WASM の大きさ（ADR-0014 の Confirmation） |
| `hamt-node-store-poc` | 10 万ノードでの HAMT と通常の対応表の比較（[document-model.md](architecture/document-model.md) の 10 節） |
| `layout-crate-skeleton` | `layout` の crate、`LayoutResult`、決定性の lint、PROP-LAYOUT-001 の一致の CI（[layout.md](architecture/layout.md)） |
| `property-table-extension-columns` | 表に `public_api`・`api_name`・`api_since`・`public_plugin` の列を足し、プロパティ 90 `plugin_data` を予約する（api-and-webhooks の `property-table-api-columns`、plugins の `plugin-data-property-reserve` と 1 つ） |
| `scene-graph` | `RenderNode`、dirty の伝播、部分木の境界の箱、子の R-tree、`ChangeSummary` からの更新 |
| `tile-cache` | タイルの描画とキャッシュ、ズームの途中の拡大・縮小、画面の外の先読み |
| `path-coverage-raster` | パスの平坦化・振り分け・被覆率・塗りの規則 |
| `paints-and-strokes` | 単色・グラデーション（ディザ）・線の展開・破線 |
| `gpu-backend-selection` | バックエンドの選択（WebGPU で始める）、起動の後の互換性のテスト、ブロックリスト、切り替えと作り直し |
| `image-decode-worker` | 画像のデコードの Worker、縮小版の読み分け、ミップマップ、GPU の画像のメモリの予算 |
| `image-paint-by-hash` | `Paint` の `image_hash` での描画と、読み込み中・読み込めない画像の置き場所 |
| `bundled-font-catalog` | 同梱のフォントの一覧、CDN での配信、Cache Storage、既定のフォント |
| `render-memory-budget` | メモリの計測と警告、キャッシュの追い出し、安全な描画の状態 |
| `canvas-input-loop` | 入力の列と `requestAnimationFrame` での処理、パンとズーム、手のひら |
| `hit-test-and-selection` | ヒットテストと選ぶ単位、選択の枠の描画 |
| `move-resize-rotate` | 変形（オートレイアウトの並べ替えと付け替えを除く） |
| `basic-shape-tools` | 矩形・楕円・線・矢印・多角形・星・フレーム・セクションのツール |
| `render-perf-ci` | 性能の CI（GPU 付きの VM、20% の後退で失敗）と実機の群れ（delivery.md の `perf-ci-gpu-vm` と 1 つ） |
| `client-frame-telemetry` | フレーム時間とメモリの集計（[ADR-0049](decisions/0049-client-telemetry-without-content.md)） |
| `telemetry-ingest` | 受け口、ラベルの許可の一覧、AMP への変換 |
| `wasm-error-reports` | panic・trap の報告と、ビルドの名前の表 |

### E3 ドキュメントのモデルとマルチプレイヤー

設計：[document-model.md](architecture/document-model.md)、[multiplayer.md](architecture/multiplayer.md)、[infrastructure.md](architecture/infrastructure.md) の 3〜5 節、[capacity.md](architecture/capacity.md)、[delivery.md](architecture/delivery.md) の 4〜6 節

| Story | 内容 |
| --- | --- |
| `dynamodb-transaction-poc` | PoC：東京のオンデマンドで、フェンス付きの `TransactWriteItems` の p99（40 ms の予算）と `ConditionCheck` の単位（`ReturnConsumedCapacity`） |
| `doc-model-schema-codegen` | プロパティの表、表からの Rust・TypeScript のコード生成、表の lint（統合の工程で登録したプロパティを含む） |
| `doc-model-core-ops` | `Create`・`Set`・`MapSet`・`Delete`、`ChangeSet` の原子性と `origin`、検証器 |
| `tree-invariants` | T1〜T9 の検証と性質ベーステスト（T9 の登録は components と一緒に） |
| `canonical-codec` | 符号化・復号、正準形、fuzzing |
| `page-chunked-snapshot` | ページ単位のチャンクとマニフェストの形（`features` を含む。保存は E7） |
| `session-id-allocation` | `session_open` の記録と `next_session_id`（ADR-0007） |
| `mp-protocol-codec` | メッセージの型と符号化（`protocol_version` を含む） |
| `router-assignment` | `file_leases` と割り当て（ADR-0047） |
| `ds-liveness-and-self-fence` | `ds_liveness` の延長と、延ばせないときに自分から止まる |
| `gateway-edge-websocket` | 入口（CloudFront → ALB）、ALB の期限、Gateway の入れ替え |
| `gateway-connect` | チケットの検証、`Hello`、Router への問い合わせ、Document Server との多重化した接続 |
| `ds-ticket-verification` | Document Server でのチケットの署名の確認と、Gateway からの水準の下げだけの許可 |
| `file-actor-commit` | `client_seq`、検証、`seq`、group commit との結合、`Ack`・`Committed`・`Reject` |
| `client-overlay-rebase` | `confirmed`・`pending`・`overlay`、一時的な循環 |
| `ordering-keys` | 並びの鍵、サーバーの振り直し、乱数の接頭辞 |
| `change-origin-tag` | `ChangeSet` の `origin` とジャーナルへの記録（plugins・layout と合わせる） |
| `reconnect-resume` | `resume`、背圧と `Kick`、最初の 0〜5 秒の乱数の待ち（capacity.md の `reconnect-jitter` と 1 つ） |
| `gateway-resume-token` | 再開のトークンの発行と検証、`Kick(ticket_required)`、Document Server での水準の上限（[permissions-and-sharing.md](architecture/permissions-and-sharing.md) の 5.5 節） |
| `presence-cursors` | 在席とカーソル、ページごとの絞り込み |
| `remote-selection-and-cursors` | 他の人の選択の枠と名前の札（editor-and-tools） |
| `follow-viewport` | 視点を追う |
| `multiplayer-undo` | Undo と Redo（`derived` のプロパティを項目にしない） |
| `mp-simulator-props` | 収束のシミュレーターと PROP-MP-001〜008 |
| `protocol-and-schema-compat` | 版の照合（`protocol_version`、`schema/history.json`、受け入れの一覧、再読み込みの 2 つの強さ）（ADR-0053） |
| `doc-feature-flags` | 文書のフラグと `Welcome.features` |
| `schema-write-gate` | 書き込みの解禁（`schema.<prop>.write`） |
| `ds-memory-accounting` | ファイルごとのメモリの計測と `ds_liveness` への報告 |
| `ds-admission-and-shedding` | 受け入れ、80%・85% の段（ADR-0051） |
| `journal-write-budget` | 書き込みの予算と段、`batch_interval_ms` の指示（ADR-0052） |
| `ds-drain-controller` | ドレイン、タスクの保護、退役の通知（delivery.md の `ds-drain-deploy` と組む） |
| `ds-drain-deploy` | ドレインの波のデプロイ |
| `mp-metrics-and-slis` | gateway・ds・router のメトリクスと SLI の判定 |
| `hot-files-log` | 上位のファイルの記録 |
| `mp-loadbot` | 負荷の道具 |

### E4 ベクターとテキストの編集

設計：[editor-and-tools.md](architecture/editor-and-tools.md)、[rendering-engine.md](architecture/rendering-engine.md) の 8・9 節、[layout.md](architecture/layout.md) の 5 節、[ADR-0015](decisions/0015-text-shaping-and-glyph-rendering.md)、[ADR-0017](decisions/0017-text-input-via-hidden-textarea.md)、[ADR-0018](decisions/0018-vector-networks-and-boolean-operations.md)

| Story | 内容 |
| --- | --- |
| `ime-textarea-poc` | PoC：`textarea` の置き方、見えなくし方、イベントの順序の記録（E4 の前） |
| `text-shaping-and-glyphs` | 整形、グリフのアトラス、大きな文字のパスの描画、和文のフォールバック（`cjk_fallback_font`）、カラーの絵文字 |
| `text-line-breaking` | 行の組み立て、測定の関数とキャッシュ、`text_auto_resize` |
| `text-editing` | カーソル・選択・書式・行の移動、IME の組み立ての表示、同時の編集の知らせ |
| `effects-blend-masks` | ブレンドモード 18 種、影・ぼかし・背景のぼかし、マスク 3 種、内容の切り抜き |
| `snapping` | スナップと等間隔、画素への合わせ |
| `pen-and-vector-network` | ペン、点・辺の編集、曲げ、領域の作り直し、大きなネットワークの送信 |
| `boolean-operations` | 非破壊のブール演算、平坦化（iCurve）、線のアウトライン化 |
| `layers-panel` | 仮想化したレイヤーのパネル、キーボード操作、名前の変更、並べ替え |
| `properties-panel` | 選択のプロパティ、`Mixed` の表示、`SetProps` |
| `keymap-and-shortcuts` | ショートカットの表と発火の条件、一覧のダイアログ（法務：L6） |
| `clipboard` | コピーと貼り付け、ドラッグ＆ドロップ、SVG と画像の取り込みの操作 |
| `image-upload-client` | 読み込み・縮小・メタデータの除去・ハッシュ・署名付き PUT |
| `svg-import-sanitize` | SVG の読み込みの解析と無視する要素 |
| `canvas-a11y` | キャンバスのキー操作と読み上げ、axe の検査 |

### E5 フレームとオートレイアウト

設計：[layout.md](architecture/layout.md)、[ADR-0019](decisions/0019-auto-layout-engine-and-layout-persistence.md)、[ADR-0020](decisions/0020-deterministic-layout-arithmetic.md)

| Story | 内容 |
| --- | --- |
| `constraints-on-resize` | 制約の適用（editor-and-tools の `resize-with-constraints` と 1 つ） |
| `auto-layout-core` | 手順の 1〜7・9〜10（折り返しなし）、hug・fill・fixed、最小・最大 |
| `auto-layout-wrap` | 折り返し、`counter_axis_spacing`、`counter_axis_align_content` |
| `auto-layout-baseline-and-strokes` | ベースライン、線の太さを含める、重なりの順 |
| `derived-layout-persistence` | 書き手の規則、開いた直後の保存された値での描画（document-model の `derived-layout-property` と 1 つ） |
| `layout-repair` | 修復の担当と比較、`layout_divergence`、PROP-LAYOUT-008 |
| `incremental-relayout` | 汚れの伝播、PROP-LAYOUT-002、性能の CI |
| `taffy-differential-test` | Taffy との差分のテスト（PROP-LAYOUT-007） |
| `group-bounds` | グループとブール演算の境界 |
| `auto-layout-drag-reorder` | オートレイアウトの子のドラッグでの並べ替えと、差し込みの線 |
| `layout-to-scene` | レイアウトの結果のシーングラフへの反映 |

### E6 コンポーネントとバリアント

設計：[components-and-libraries.md](architecture/components-and-libraries.md) の 3〜6 節、[ADR-0021](decisions/0021-derived-instances-and-override-keys.md)、[ADR-0022](decisions/0022-component-properties-and-variants-by-id.md)

| Story | 内容 |
| --- | --- |
| `component-cycle-validation` | コンポーネントの参照の循環（T9）と上書きの検証を `doc-model` の検証器に登録する（E3 の `tree-invariants` の後） |
| `components-and-instances` | コンポーネントを作り、インスタンスを置く（導出、`InstanceSubId`） |
| `instance-overrides-map` | `overrides` の `map`、上書きを書く・取り消す（3.4 節の表、元のノードの ID のキー、孤立） |
| `nested-instances-and-swap` | 入れ子のインスタンスと入れ替え、循環の拒否 |
| `incremental-materialize` | 増分の再導出と、導出の上限（50 万、深さ 16） |
| `variants` | コンポーネントセット、選択、衝突の表示 |
| `override-remap` | 切り替え・入れ替えでの上書きの引き継ぎ |
| `component-properties` | 真偽・テキスト・インスタンスの入れ替え、優先の候補、入れ子のプロパティの表示 |
| `detach-push-and-remove` | デタッチ、メインへの反映、メインの削除と復元 |
| `edit-derived-nodes` | 導出したノードの選択と、上書きの書き込みへの変換 |
| `instance-rendering` | 導出したインスタンスの子を普通のノードとして描く、参照画像のテスト |
| `instance-layout` | 導出した木のレイアウト（導出とレイアウトの分離） |

### E7 保存と版の履歴

設計：[file-storage-and-history.md](architecture/file-storage-and-history.md)、[ADR-0024](decisions/0024-journal-items-and-fencing.md)〜[ADR-0026](decisions/0026-version-history-restore-and-deletion.md)、[ADR-0047](decisions/0047-router-task-liveness-and-file-assignment.md)

| Story | 内容 |
| --- | --- |
| `journal-group-commit` | トランザクション（フェンス付き）、トークン、まとめ、大きな変更 |
| `journal-fencing-recovery` | フェンス、回復、飛びの検知と `maintenance` |
| `checkpoint-writer` | 変わったページだけのチャンク、`durable_seq` の待ち |
| `load-plan-and-chunk-cache` | `LoadPlan`、チャンクの署名付き URL、IndexedDB のキャッシュ、ページの遅延の読み込み |
| `orphan-recovery-job` | 回復のジョブと見張り（infrastructure の同じ名前の Story と 1 つ） |
| `file-lease-deleted-state` | 削除済みの割り当て |
| `storage-gc` | チェックポイントの保持と掃除（東京と大阪） |
| `version-history-api` | 一覧、名前付き、版の閲覧 |
| `version-restore` | 復元 |
| `file-duplicate` | 複製（画像の参照の写しを含む） |
| `trash-and-purge` | ゴミ箱と完全な削除（東京と大阪。security の `purge-both-regions` と 1 つ。削除の期間は法務：L4） |
| `image-gc` | 画像の mark-and-sweep（東京と大阪） |
| `file-change-events` | 編集が止まったこと・版の作成・削除の outbox（通知と、E15 の Webhook で使う） |
| `durability-fault-injection` | 耐久性の障害の注入の枠 |
| `shadow-replay-validation` | 作り直しの影の検証（連続 10 万回の一致で出す） |

### E8 コメントと通知

設計：[comments-and-notifications.md](architecture/comments-and-notifications.md)、[ADR-0027](decisions/0027-comments-anchored-to-nodes-in-metadata.md)、[ADR-0028](decisions/0028-realtime-metadata-subscriptions.md)

| Story | 内容 |
| --- | --- |
| `comment-threads-and-anchors` | スレッドの作成と返信、キャンバスの位置・領域への固定、フレームへの追従 |
| `comment-actions` | 編集・削除・解決・再開・リアクション・画像の添付、上限 |
| `comment-read-state` | 既読・未読、並べ替えと絞り込み |
| `mentions` | メンション（候補、読めない人への招待の案内） |
| `in-app-notifications` | 受け手の決め方とアプリ内の通知（Realtime） |
| `email-notifications` | メールの通知（まとめ、読んだものを除く、プレビュー、組織の設定） |
| `comment-subscriptions` | ファイルごとの通知の設定と、自動の購読 |

### E9 チーム・権限・共有

設計：[permissions-and-sharing.md](architecture/permissions-and-sharing.md)、[ADR-0029](decisions/0029-hierarchy-roles-seats-and-link-access.md)〜[ADR-0031](decisions/0031-org-acl-version-and-connection-revalidation.md)、[security.md](architecture/security.md) の 6 節

| Story | 内容 |
| --- | --- |
| `roles-and-policy-engine` | 役割と継承、ポリシーの形と評価器、段階の読み込み |
| `invitations-and-guests` | 招待（トークン、メンバーとゲストの判定）、ゲストの制限 |
| `general-access-and-links` | 一般アクセス（招待した人だけ・組織の中・リンクを知っている全員）、匿名の閲覧（公開のリンクの取り下げは法務：L3） |
| `link-expiration` | リンクの期限とスケジューラー |
| `seats` | シート（Full・View）、申請と承認の設定 |
| `viewer-restrictions` | 「閲覧者に複製・共有・書き出しを許す」 |
| `access-requests` | アクセスの申請 |
| `access-notifications` | 招待・アクセスの申請・シートの申請の通知（通知の仕組みは E8） |
| `acl-version-and-revalidation` | `acl_version` のキャッシュ、`acl.changed` と接続の再検証 |
| `acl-change-kick` | Gateway での `acl.changed` の受け取りと判定し直し |
| `file-and-project-move` | ファイル・プロジェクトの移動、`files.team_id` の書き換えと `acl_version`、ずれの見張り（[permissions-and-sharing.md](architecture/permissions-and-sharing.md) の 9.3 節） |
| `session-revocation-kick` | `session.revoked` の配送と接続の切断 |
| `viewer-mode-ui` | 閲覧の権限での UI、`RoleChanged` への対応、閲覧だけの描画（rendering の `viewer-rendering` と 1 つ） |
| `sharing-ui` | 共有の画面（ファイル・プロジェクト・チーム） |
| `file-maintenance-state` | `files.state = maintenance` と、閲覧のチケットだけを出す判定の上限（[data-model/organization.md](architecture/data-model/organization.md) の `files`） |
| `audit-events-core` | `audit_events`、outbox、log-archive への送り |
| `readable-scopes-property` | `readableScopes` と判定関数の一致の性質ベーステスト（検索の準備） |
| `leak-test-suite` | 漏洩の経路の表のテスト一式（[quality.md](quality.md) の 2.2.1 節） |

### E10 書き出しとアセット

設計：[export-and-assets.md](architecture/export-and-assets.md)、[ADR-0034](decisions/0034-export-rendering-split.md)〜[ADR-0036](decisions/0036-font-sources-and-licensing.md)、[rendering-engine.md](architecture/rendering-engine.md) の 12 節

| Story | 内容 |
| --- | --- |
| `render-native` | lavapipe の上の wgpu のネイティブのビルド、ラスターの書き出しのタイルの列、SVG・PDF への描画の命令の公開 |
| `render-worker-core` | Render Worker、子のプロセス、チェックポイント＋ジャーナルの読み込み、lavapipe の性能の PoC |
| `worker-layout-for-instances` | Render Worker での導出と、インスタンスの中身のレイアウトの計算 |
| `image-ingest-worker` | `asset-inspect`（画像）、GuardDuty、縮小版、`ready` の通知 |
| `image-sign-endpoint` | `images:sign`、組織の中だけの引き当て、CDN の署名とキャッシュの PoC |
| `export-settings-panel` | `export_settings` の編集と、書き出しのパネル |
| `client-export-raster` | PNG・JPG のクライアントの書き出し |
| `client-export-svg` | SVG の書き出しと規則 |
| `client-export-pdf` | PDF の書き出し、同梱のフォントのサブセット、アウトライン化 |
| `server-bulk-export` | 一括の書き出しのジョブ、ZIP、結果の保持と URL |
| `file-thumbnails` | サムネイルのジョブ、`thumbnail_node`、一覧の API での配信 |
| `org-fonts` | 組織・チームのフォント（法務：L1） |
| `local-fonts-chromium` | Local Font Access API（release フラグ。法務：L1） |
| `asset-fetch-egress` | `asset-fetch` の Lambda、画像の URL の取り込み |
| `render-parity-suite` | 書き出しの参照画像の集合と CI（SC-6） |

### E11 ファイルの一覧と検索

設計：[search.md](architecture/search.md)、[ADR-0032](decisions/0032-name-search-in-aurora.md)

| Story | 内容 |
| --- | --- |
| `file-browser-realtime` | ファイルブラウザの一覧（最近・プロジェクト・チーム）を Realtime で配る |
| `recent-files` | 最近のファイル（`file_visits`）と、検索の前の候補 |
| `name-search` | ファイル・プロジェクト・チームの名前の検索（候補の段と読み直し） |
| `people-search` | 人の検索（組織のメンバー） |
| `search-perf-baseline` | 検索の性能の試験と、pg_bigm への切り替えの基準の計測 |

### E12 運用と GA の準備

設計：[infrastructure.md](architecture/infrastructure.md) の 7 節、[capacity.md](architecture/capacity.md)、[observability.md](architecture/observability.md)、[security.md](architecture/security.md)、[runbooks/](runbooks/README.md)

| Story | 内容 |
| --- | --- |
| `load-test-suite` | 負荷試験 L1〜L10（multiplayer の `hot-file-load-test`、comments の Realtime の負荷試験を含む） |
| `osaka-warm-standby` | 大阪の構成 |
| `journal-generations` | 世代のキーと、世代をまたぐ回復（ADR-0048） |
| `dr-salvage-job` | 取り戻しのジョブと `dr_salvaged` の版 |
| `dr-drill` | DR の訓練（staging で四半期、file-storage の `dr-journal-failover-drill` と 1 つ） |
| `synthetic-bots` | 合成のボット |
| `alerts-and-dashboards` | アラートとダッシュボード、各領域のテレメトリーの警報（描画・エディタ・レイアウト・検索・通知） |
| `render-telemetry-and-blocklist` | 描画のテレメトリーとブロックリストの運用 |
| `editor-telemetry` | 入力から描画までの時間、React の再描画、IME のイベントの異常 |
| `layout-telemetry` | `layout_slow`・`layout_divergence`・修復の件数 |
| `authz-debugger` | 判定のデバッガー（サポート向け） |
| `org-client-cache-policy` | `client_cache` の方針 |
| `asset-takedown` | 権利の侵害の申し立てでの画像・フォントの削除（法務：L2） |
| `abuse-takedown-console` | 取り下げの運用者の画面と監査（法務：L2・L3） |
| `pentest-and-fixes` | 外部の侵入試験と修正 |
| `cost-dashboard` | タグごとの費用の可視化 |
| `runbooks-e12` | runbooks/README.md の 4 節で「E12 で作成」とした手順 |
| `org-saml-sso` | 組織の SAML・OIDC の SSO（ADR-0043。MVP の範囲の外で、GA の判定に含めない） |
| `org-audit-log-viewer` | 組織の管理者の監査ログの画面と CSV（組織のプラン。GA の判定に含めない） |

### E13 ライブラリ（MVP の後）

設計：[components-and-libraries.md](architecture/components-and-libraries.md) の 7 節、[ADR-0023](decisions/0023-library-snapshots-imported-into-files.md)

| Story | 内容 |
| --- | --- |
| `library-publish` | 公開（Worker のスナップショット、`library_versions`・`library_assets`） |
| `library-import` | ライブラリの有効化と、資産の取り込み（写し） |
| `library-updates` | 更新の通知（Realtime）と、見比べと受け入れ |
| `library-move-component` | 公開したコンポーネントの別のファイルへの移動 |
| `library-asset-search` | ライブラリの資産の検索 |

### E14 プラグイン（MVP の後）

設計：[plugins.md](architecture/plugins.md)、[ADR-0037](decisions/0037-plugin-sandbox-quickjs-wasm.md)〜[ADR-0039](decisions/0039-plugin-distribution-and-review.md)

| Story | 内容 |
| --- | --- |
| `quickjs-sandbox-poc` | QuickJS の WASM のインスタンス、上限、割り込み、ES の版、性能 |
| `plugin-membrane` | ハンドルの表、値の写し、コールバック、fuzzing、脱出のテスト |
| `plugin-api-read` | 読み取りの API、`dynamic-page` |
| `plugin-api-write` | 書き込み、Undo の単位、送る速さの制御、`origin` |
| `plugin-ui-iframe` | `plugin-ui` のドメイン、起動用のページ、CSP の生成、メッセージ |
| `plugin-network-proxy` | サンドボックスの `fetch` の中継、宛先の照合 |
| `plugin-storage` | `plugin_data`、`clientStorage` |
| `plugin-dev-mode` | 開発中の版の読み込み、`devAllowedDomains`、コンソール |
| `plugin-org-distribution` | 組織の中の配布、管理者の統制 |
| `plugin-public-review` | 公開、自動の検査、人の審査の道具 |
| `plugin-kill-switch` | `plugin_blocklist` と Realtime での配信 |
| `plugin-types-codegen` | `.d.ts` の生成と API の版 |

### E15 公開 API と Webhook（MVP の後）

設計：[api-and-webhooks.md](architecture/api-and-webhooks.md)、[ADR-0040](decisions/0040-public-rest-api-surface.md)〜[ADR-0042](decisions/0042-api-versioning-and-rate-limits.md)

| Story | 内容 |
| --- | --- |
| `public-api-service` | `api.<domain>` のサービス、RFC 9457、ページング、`Idempotency-Key`、OpenAPI |
| `file-read-service` | file-read（Rust）、JSON の生成、LRU、100 MiB の上限 |
| `personal-access-tokens` | 個人のアクセストークン、スコープ、期限、シークレットスキャンの登録 |
| `oauth-apps` | OAuth のアプリ、PKCE、入れ替え、同意の画面 |
| `oauth-app-review` | public のアプリの審査の道具 |
| `api-files-and-nodes` | `/files`・`/nodes`・`/meta` |
| `api-images` | `/images`、`202` と `image_jobs`、画素の予算 |
| `api-comments-versions-projects` | コメント・版・プロジェクトの一覧 |
| `api-rate-limits` | tier のトークンバケット、組織の合計、429 のヘッダー |
| `webhooks-v1` | Webhook の作成・一覧・変更・削除、`ping`、署名、配送、記録 |
| `webhook-egress` | `webhook-egress` の Lambda と宛先の検査 |
| `org-api-controls` | 組織の管理者の統制 |
| `org-access-tokens` | 組織のトークン（許可リスト付き。E15 の後半） |

## エージェントに任せないこと

- **契約（プロパティの表、送受信のメッセージ、チェックポイントの形式、判定のポリシー、公開 API の形）の確定**：公開した後やファイルに書いた後に変えるコストが最も高い。
- **参照画像の更新と許容の値の変更**：差の画像を見て Dev が承認し、値は QA が決める。
- **`schema-breaking` の変更と `min_client_build` の引き上げ**：Dev のテックリードと Ops が判断する。
- **大阪への切り替えの判断、`dr_salvaged` の版の扱いの利用者への告知**：Ops の責任者と PM（[runbooks/disaster-recovery.md](runbooks/disaster-recovery.md)）。
- **法務の判断**（L1〜L6）。
- **負荷試験・PoC の結果の解釈**：数字は出せるが、予算・上限・退路（2 つのビルド、GPU のインスタンス）の採否は Dev と PM の判断。

## 延期の一覧

MVP の後に検討する。E13〜E15 に入れなかったもの。着手するときに `intent.md` から起票する（[intent.md](intent.md) の「MVP の後に扱う」と、各領域の文書の持ち越し）。

- **変数とモード、スタイルのライブラリ**：ライブラリ（E13）の参照の仕組みの上に作る。
- **プロトタイピング**（画面の遷移、アニメーション、プレビュー）と、プロトタイプだけの閲覧（`view_prototype`）・埋め込み（[permissions-and-sharing.md](architecture/permissions-and-sharing.md) の 12 節）。
- **Dev Mode 相当**（コードの出力、注釈、開発の状態）と Dev・Collab のシート。
- **ホワイトボード（FigJam 相当）**：予約したノードの種類（`STICKY`・`CONNECTOR` など）。
- **縦書き、ルビ、約物の詰めと和文の両端揃え**。
- **デスクトップアプリ、モバイルの閲覧アプリ**、端末のフォントの補助のアプリ（`font-helper-app`、別の ADR）。
- **中身の検索**（ノードの名前とテキスト。OpenSearch。[ADR-0033](decisions/0033-content-search-from-checkpoints.md)）。
- **スロットのプロパティ**（[components-and-libraries.md](architecture/components-and-libraries.md) の 1 節）。
- **ウィジェット**、`sharedPluginData`、複数のファイルをまたぐプラグインの API（[plugins.md](architecture/plugins.md) の 13・15 節）。
- **読み取りの MCP のサーバー**、変数・ライブラリの公開 API（[api-and-webhooks.md](architecture/api-and-webhooks.md) の 13 節）。
- **ワークスペース、ユーザーグループ（とそのメンション）、ゲストの禁止・リンクの期限の必須などの方針、リンクのパスワード、SCIM**。
- **組織ごとの KMS の鍵**（持ち込みの鍵。S2 の前に別の ADR）。
- **未確定の変更の端末への保存**（タブを閉じても送る）、Undo の履歴をタブをまたいで残すこと（[multiplayer.md](architecture/multiplayer.md) の 17 節）。
- **1 ファイル 500 人を超える配信の木**（S2 の前に ADR）。
- **EditContext への切り替え**（Firefox・Safari の対応の後。[ADR-0017](decisions/0017-text-input-via-hidden-textarea.md)）、エンジンを Web Worker（OffscreenCanvas）に移すこと（ADR-0016 の見直しの条件）。
- **Display P3**、SharedArrayBuffer によるタイルの描画の並列化（[rendering-engine.md](architecture/rendering-engine.md) の 20 節）。
- **グリッドのオートレイアウト、縦の折り返し、「Around」「Evenly」、テキストの最大の行の数**（[layout.md](architecture/layout.md) の 16 節）。
- **S2 の構成**（メタデータの縦の分割、AZ ごとの Document Server の群れ、WAL からの Realtime の無効化、ECS on EC2 の再評価）と **S3 のセル構成**（大阪でも編集を受ける）（[infrastructure.md](architecture/infrastructure.md) の 9 節）。

# Delivery: Figma

ブランチ、CI、デプロイ、リリースの流れ。Slack の [delivery.md](../../../slack/docs/architecture/delivery.md) を引き継ぎ、この題材に固有の 4 つを足す：**WASM とネイティブの一致の CI**、**クライアントとサーバーの版の食い違い**、**プロパティの表の変更の出し方**、**Document Server を止めずに入れ替えるデプロイ**。

| 対象 | 方針 |
| --- | --- |
| ブランチモデル | リポジトリ共通の [ADR-0002](../../../../docs/decisions/0002-trunk-based-development.md)（トランクベース開発） |
| デプロイとマイグレーション、フラグ | Slack の [ADR-0022](../../../slack/docs/decisions/0022-zero-downtime-deploy-and-migrations.md)・[ADR-0026](../../../slack/docs/decisions/0026-feature-flags.md) を引き継ぐ |
| WASM とネイティブの一致、大きさと性能の予算 | [ADR-0054](../decisions/0054-wasm-native-parity-and-bundle-budgets.md) |
| クライアントとサーバーの版 | [ADR-0053](../decisions/0053-client-server-version-skew.md) |
| 段階的なリリースとプロパティの表の変更 | [ADR-0055](../decisions/0055-staged-rollout-and-schema-changes.md) |
| Document Server のドレイン | [ADR-0046](../decisions/0046-multiplayer-compute-on-fargate-with-drain.md) |
| 手順 | [runbooks/deploy-and-rollback.md](../runbooks/deploy-and-rollback.md) |

原則は 3 つ。

- **`main` は常にデプロイできる状態に保つ。**
- **デプロイとリリースを分ける。** デプロイは Ops が承認し、リリースは PM が判断する。
- **1 つのファイルの中では、全員が同じ規則で動く。** 変更の適用・レイアウト・描画の結果を変える変更は、ファイルごとに切り替える（ADR-0055）。

## 1. 変更からマージまで

Slack と同じ。

```
changes/YYMMDD-<slug>/ の spec・plan が承認済み
   ▼
ブランチ figma/YYMMDD-<slug>（エージェントは worktree ごとに 1 本）
   ▼
PR ─▶ PR の CI（2 節）─▶ レビュー（CODEOWNERS、作成者と別の人）
   ▼
merge queue ─▶ squash で main へ
```

- 未完成の振る舞いは release フラグの裏に置く。
- PR の説明に、変更フォルダ、規模、使うフラグ、**プロパティの表への影響**（なし・追加だけ・追加以外）、**文書のフラグか UI のフラグか**を書く。

### 1.1 リポジトリの中の区分

開発リポジトリは 1 つ（モノレポ）。

| パス | 中身 | コードオーナー |
| --- | --- | --- |
| `crates/doc-model`、`crates/layout`、`crates/text` | 変更の適用と検証、レイアウト、テキストの測定（WASM とネイティブで共有） | Dev のテックリード＋ QA |
| `crates/scene`、`crates/raster`、`crates/gpu` | 描画 | 描画の持ち主 |
| `schema/properties.toml` | プロパティの表（[document-model.md](document-model.md) の 4 節） | Dev のテックリード |
| `services/gateway`、`services/document-server`、`services/router` | マルチプレイヤー | マルチプレイヤーの持ち主 |
| `services/render-worker`、`services/file-read` | サーバーでの描画、公開 API の読み取り | 各持ち主 |
| `apps/web` | UI の殻（TypeScript・React）、エンジンの読み込み | Web の持ち主 |
| `services/api`、`services/realtime`、`services/workers`、`packages/*` | TypeScript のサービス | 各持ち主 |
| `infra/` | Terraform（[infrastructure.md](infrastructure.md) の 10 節） | Ops |

- `crates/doc-model`・`crates/layout`・`crates/text` と `schema/` の変更には、Dev のテックリードの承認を必須にする（GitHub のルールセット）。
- `unsafe` を含む変更は、コードオーナーのレビューを必須にする（[ADR-0001](../decisions/0001-platform-and-stack.md)）。

## 2. CI

### 2.1 PR の CI

Slack の delivery.md の 2.1 節の段（型、lint、単体、結合、migration lint、`terraform plan`、秘密情報の検査）をすべて持ち、次を足す。目標は 20 分以内。

| 段 | 内容 | 失敗の条件 |
| --- | --- | --- |
| Rust の検査 | `cargo fmt`、`clippy`（`-D warnings`）、`cargo-deny`、`cargo-vet` | 1 件でも |
| Rust の単体 | ネイティブ（aarch64・x86_64）と、`wasm-bindgen-test`（ヘッドレスの Chromium・Firefox） | 1 件でも |
| 一致（`parity`） | 3 節 | 1 件でも |
| 性質ベーステスト | PROP-DM-*、PROP-MP-*（シミュレーター 1 万の列）、PROP-FS-*、PROP-LAYOUT-* | 1 件でも |
| 参照画像 | 参照ファイルを WebGL2・WebGPU・ネイティブで描き、参照画像と比べる（[rendering-engine.md](rendering-engine.md) の 16.1 節） | 許容の外 |
| 性能（`perf`） | 3.2 節 | 20% 以上の悪化 |
| WASM の大きさ（`wasm-size`） | 3.3 節 | 予算の超過 |
| fuzzing | 復号器・画像・フォント・SVG の解析を 5 分（[security.md](security.md) の 11 節） | 落ち、上限を超える確保 |
| スキーマの分類（`schema-diff`） | 4.2 節。`schema/properties.toml` の差分を「追加だけ」「追加以外」に分ける | 「追加以外」で `schema-breaking` のラベルと承認がない |
| 要件の追跡 | 要件 ID がテストから参照されている（[process.md](../../../../docs/process.md) の 7 節） | 参照のない ID |

### 2.2 夜間

- 一致の CI を 100 万の列で、fuzzing を 1 時間、マルチプレイヤーのシミュレーターを 100 万の列で走らせる。
- 実機（参照の端末）での性能の計測（[rendering-engine.md](rendering-engine.md) の 15 節）。
- 最小の再現を、失敗ごとに Issue に起こす（エージェントが Maintain の段で拾う）。

## 3. 一致・性能・大きさの CI

[ADR-0054](../decisions/0054-wasm-native-parity-and-bundle-budgets.md) による。

### 3.1 一致（`parity`）

```
入力：proptest の変更の列（固定の種）＋ 参照ファイル（1 万・10 万・30 万ノード）
   │
   ├─▶ wasm32（Chromium・Firefox のヘッドレス）─┐
   ├─▶ aarch64（Document Server と同じ）       ├─▶ 各段の正準形のハッシュ、derived_layout のダンプ、
   └─▶ x86_64（Render Worker と同じ）          ┘    テキストの測定のダンプ
                                                      │
                                                      ▼ 3 つが 1 つでも違えば失敗
                                                 最初に違った段の入力を縮めて保存
```

- PROP-DM-004（[document-model.md](document-model.md) の 14.1 節）、PROP-LAYOUT-001（[layout.md](layout.md) の 17 節）の Proof。
- 本番では、Render Worker・file-read が読み込んだ状態と、Document Server のメモリの状態のハッシュを 1% で比べる（[file-storage-and-history.md](file-storage-and-history.md) の 14.3 節と同じジョブ）。

### 3.2 性能（`perf`）

- GPU 付きの VM のヘッドレスの Chromium で、参照ファイルのパン・ズーム・ドラッグ・開く、のシナリオを走らせ、フレーム時間の p95 と開く時間を計る。
- 前の `main` の値から 20% 以上悪くなれば失敗。VM の揺れのための余裕で、本家と同じ値（[Keeping Figma fast](https://www.figma.com/blog/keeping-figma-fast/)、2026-09-27 に確認）。
- シナリオは並べて走らせ、10 分以内に終える。

### 3.3 WASM の大きさ（`wasm-size`）

| 対象 | 予算（brotli 後） |
| --- | --- |
| エンジンの WASM（WebGL2 と WebGPU の両方を含む） | 5 MB（ADR-0001） |
| 1 つの PR での増加 | 50 KB（超えたら Dev のテックリードの承認） |
| 最初に読む JS（UI の殻） | 1 MB |

- `wasm-opt` の後、名前の節を外した WASM で計る。名前の表は別に保管する（[observability.md](observability.md) の 3.3 節）。
- crate ごとの内訳（`twiggy` など）を PR に貼る。
- WebGPU と WebGL2 で 2 つのビルドを配ることになったら（[ADR-0004](../decisions/0004-gpu-rendering-in-wasm.md) の PoC の結果）、それぞれに 5 MB を当てる。

## 4. クライアントとサーバーの版

[ADR-0053](../decisions/0053-client-server-version-skew.md) による。

### 4.1 3 つの版

| 版 | 中身 | 合わないとき |
| --- | --- | --- |
| `protocol_version`（u16） | 送受信の形式（[ADR-0009](../decisions/0009-multiplayer-wire-protocol.md)）。サーバーは今の版と 1 つ前の版を話す | 強い再読み込み |
| `schema_hash` | プロパティの表。サーバーは「追加だけでたどれる直近 30 日の表」を受け入れる | 一覧の外なら強い再読み込み |
| `min_client_build` | AppConfig に置く、使わせたくない古いビルドの下限 | 強い再読み込み |

- `Hello` に `protocol_version`・`schema_hash`・`engine_version`（ビルドの ID）を入れる（[multiplayer.md](multiplayer.md) の 4.2 節）。
- [document-model.md](document-model.md) の 8.4 節と [multiplayer.md](multiplayer.md) の 4.3 節は、統合の工程でこの表に書き換えた。

### 4.2 スキーマの履歴

- 開発リポジトリの CI が、`main` へのマージのたびに `schema_hash` と、前の表からの差分の種類（`additive`・`breaking`）を `schema/history.json` に追記する。
- Document Server・Render Worker・file-read は、ビルドに `schema/history.json` を含め、受け入れる `schema_hash` の一覧を起動時に作る。
- `breaking` の変更は、`format_version` を上げる変更と同じ扱い。一覧を切り、古いクライアントを強い再読み込みにする。出すのはまれにし、ADR を要する。

### 4.3 再読み込み

| 強さ | きっかけ | クライアントの動き |
| --- | --- | --- |
| 穏やか | 新しいビルドが配信の対象になった、今の `schema_hash` が 7 日以内に一覧から外れる | 帯で知らせる。`pending` が 0 で 5 分操作がなければ、自動で読み込み直す。次にファイルを開くときは新しいビルド |
| 強い | 4.1 節の 3 つのどれかが合わない | `Kick(version_mismatch, retry_after_ms)`（0〜5 分に散らす）。`pending` を送れるなら送り切り、送れなければ件数を出して読み込み直す |

## 5. デプロイ

### 5.1 順序

1 つのリリースに複数の部品の変更があるときは、次の順に出す。

```
マイグレーション（expand）─▶ Worker・Render Worker・file-read ─▶ Document Server ─▶ router ─▶ gateway
   ─▶ api・realtime ─▶ クライアントのビルド（段階的。6.2 節）─▶ 書き込みの解禁のフラグ（6.3 節）
```

- サーバーを先に、クライアントを後に（[document-model.md](document-model.md) の 8.4 節）。
- 送受信の形式を変えるときは、サーバーが新旧の `protocol_version` を話せるようになってから、クライアントを出す（ADR-0053）。

### 5.2 方式

| サービス | 方式 | 理由 |
| --- | --- | --- |
| api、realtime、telemetry-ingest | ECS の blue/green（カナリア 10% → 100%）。CloudWatch アラームで自動の戻し | Slack と同じ |
| workers、render-worker | ローリング（`minimumHealthyPercent` 100%） | SQS から処理を再開できる。Render Worker は子のプロセスを終えてから止める |
| router | ローリング（1 タスクずつ） | 状態を持たない。割り当ての正本は DynamoDB |
| gateway | ローリング（1 回に 10%）＋接続の穏やかな移し替え | [infrastructure.md](infrastructure.md) の 4 節 |
| ds-standard、ds-large | ドレインの波（5.3 節） | ファイルを渡してから止める（ADR-0046） |
| クライアント | 静的な資産の配信。ビルドの段階的な配信（6.2 節） | タブに残るため、戻しは `min_client_build` と組み合わせる |

### 5.3 Document Server のドレインの波

```
1. 新しいタスク定義でサービスを更新（maximumPercent 200%。新しいタスクが起動する）
2. router が、古いタスクの 10% を draining にする（1 つの波）
3. 波のタスクのファイルを、新しいタスクへ渡す（1 タスク 毎秒 20 ファイル、大きい順）
4. 渡し終えたタスクは、タスクの保護を外す → ECS が止める
5. 波の後、5 分見る：`ds_recovery_seconds` の p95、`ds_fence_lost_total`、`edit_commit` の悪いイベント、クライアントの `Reject` の率
6. 悪化がなければ次の波。悪化したら止める（[runbooks/deploy-and-rollback.md](../runbooks/deploy-and-rollback.md)）
```

- 本家は、デプロイで全ファイルを閉じることがチェックポイントの急増を招いたが、ジャーナルを入れた後はデプロイで閉じる時間の p99 が 1 秒を切った（[Making multiplayer more reliable](https://www.figma.com/blog/making-multiplayer-more-reliable/)、2022-10-20、2026-09-27 に確認）。この設計の渡し（`handoff`）も、チェックポイントを待たずにジャーナルを書き切るだけで渡す。
- S1（`ds-*` 15 タスク、1 タスク約 830 ファイル）で、1 つの波は 2 タスク、渡しは約 1 分。全体で 10〜15 分。

### 5.4 マイグレーション

- Slack の ADR-0022 と同じ expand / contract。バックフィルは Worker が小分けに行う。
- DynamoDB の表の属性の追加は、コードの互換（知らない属性を無視する）で行う。GSI の追加は Terraform で、作り終えてから読む。
- S3 のキーの形を変えるとき（世代のキーなど。[ADR-0048](../decisions/0048-osaka-dr-with-journal-generations.md)）は、読み手を先に出す（新旧のキーを読める）。

## 6. リリースとフラグ

[ADR-0055](../decisions/0055-staged-rollout-and-schema-changes.md) による。フラグの基盤は AppConfig（Slack の ADR-0026）。

### 6.1 フラグの種類

| 種類 | 名前 | 割り当て | 評価する場所 |
| --- | --- | --- | --- |
| UI のフラグ | `release.ui.*` | 利用者の組織（`hash(flag + org_id)`） | ブートストラップの API |
| 文書のフラグ | `release.doc.*` | ファイル（`hash(flag + file_id)`）と、ファイルを持つ組織の許可の一覧 | Document Server。`Welcome.features` で配る。Render Worker・file-read はマニフェストの `features` |
| 書き込みの解禁 | `schema.<prop>.write` | 全体（割合を持たない） | Document Server。`Welcome.features` |
| ops | `ops.*`（例：`ops.multiplayer_read_only`、`ops.public_api_enabled`、`ops.plugins_enabled`、`ops.cdn_fallback`） | 全体 | 各サービス |

- 文書のフラグは、ファイルを開いている間は変えない。変えるときは `Kick(resync_required)` で開き直させる。
- `doc-model`・`layout`・`scene` の crate は、UI のフラグを読まない（lint。ADR-0055）。

### 6.2 クライアントのビルドの段階的な配信

| 段 | 対象 | 次へ進む条件（24 時間、前のビルドと比べる） |
| --- | --- | --- |
| 0 | 社内の組織 | panic の率が 2 倍未満、フレーム時間の p95 が 10% 未満の悪化、メモリの警告の率が 20% 未満の増加 |
| 1 | 組織の 1% | 同上 |
| 2 | 10% | 同上 |
| 3 | 50% | 同上 |
| 4 | 100% | — |

- 静的な資産（WASM、JS、CSS、フォント）はハッシュの名前で不変にし、`Cache-Control: immutable`。`index.html` は短いキャッシュ（60 秒）。
- 同時に配るビルドは 2 つまで。サーバーは、配っている 2 つのビルドの `protocol_version` と `schema_hash` を受け入れる。
- 指標は [observability.md](observability.md) の 3 節。

### 6.3 プロパティの表の変更

```
追加：
  1. サーバーを出す（新しいプロパティを知り、既定値で扱い、書かれたら保つ）
  2. クライアントのビルドを段階的に出す（読んで描く。書かない）
  3. 接続の 95% が新しい schema_hash になったら schema.<prop>.write を有効にする
  4. 7 日後、残りの古いクライアントは穏やかな再読み込み（互換の一覧の期限の前）

消す：
  1. schema.<prop>.write を無効にする
  2. クライアントのビルドから読みと描きを外す
  3. 表で deprecated にする（読み飛ばして保つ）
  4. 1 か月後に表から外す。prop_id は再利用しない
```

- レイアウトの計算の規則やテキストの整形の部品を上げるときは、文書のフラグ（`release.doc.layout_v2` など）で、ファイルごとに切り替える（[layout.md](layout.md) の 17 節の `layout-engine-upgrade.md`）。

## 7. ロールバック

| 何を | どう戻す | 注意 |
| --- | --- | --- |
| UI のフラグ、文書のフラグ | AppConfig で切る | 文書のフラグは、開いているファイルを `Kick(resync_required)` |
| 書き込みの解禁 | 切れば新しい書き込みは止まる | 書いた値はファイルに残る。古いサーバーでも保てることを 6.3 節の 1 で確かめてある |
| サーバー（api など） | 1 つ前のイメージの digest で再デプロイ | — |
| Document Server | 1 つ前のイメージでドレインの波（5.3 節）を逆に回す | 新しい `protocol_version` のクライアントが残っていれば、強い再読み込みになる。先にクライアントの配信を戻す |
| クライアントのビルド | 配信の割合を 0 にし、`min_client_build` を上げる | 強い再読み込みの殺到を、散らしで抑える |
| マイグレーション | 戻さない。前へ進める修正を書く | — |

手順は [runbooks/deploy-and-rollback.md](../runbooks/deploy-and-rollback.md)。

## 8. 環境

| 環境 | 目的 | データ |
| --- | --- | --- |
| local | 開発、エージェントの確認ループ | seed と参照ファイル。DynamoDB Local、MinIO か LocalStack（S3） |
| dev | 結合の確認 | seed |
| staging | リリースの前の確認、負荷試験、DR の訓練 | seed と生成データ（参照ファイル、`mp-loadbot`） |
| prod | 本番 | 本番 |

- 本番のファイルを本番の外に出さない。匿名化した写しも作らない（Slack と同じ）。

## 9. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E1 | `ci-rust-wasm-baseline` | 2.1 節の Rust の段、`wasm-bindgen-test` |
| E1 | `wasm-native-parity-ci` | 3.1 節（[document-model.md](document-model.md) の 15 節の同じ名前の Story と 1 つにする） |
| E1 | `wasm-size-budget` | 3.3 節 |
| E2 | `perf-ci-gpu-vm` | 3.2 節 |
| E3 | `protocol-and-schema-compat` | 4 節（`protocol_version`、`schema/history.json`、受け入れの一覧、再読み込みの 2 つの強さ） |
| E3 | `doc-feature-flags` | 6.1 節の文書のフラグと `Welcome.features` |
| E3 | `ds-drain-deploy` | 5.3 節のドレインの波（[infrastructure.md](infrastructure.md) の `ds-drain-controller` と組む） |
| E1 | `client-build-channels` | 6.2 節のビルドの段階的な配信 |
| E3 | `schema-write-gate` | 6.3 節の書き込みの解禁 |

## 10. 未解決の問い

### 決定（2026-09-27、既定案）

- サーバーは `protocol_version` を 2 つ、`schema_hash` を 30 日分受け入れる。
- 書き込みの解禁は、接続の 95% が新しい表になってから。
- クライアントのビルドは組織の割合で、社内 → 1% → 10% → 50% → 100%、各 24 時間。
- Document Server はドレインの波（10% ずつ）。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| WebGPU と WebGL2 を 1 つのビルドにできるか（大きさの予算の当て方） | E2 の前の `gpu-backend-poc`（[ADR-0004](../decisions/0004-gpu-rendering-in-wasm.md)） |
| GPU 付きの VM の CI の実行環境（自前の runner か、外部のサービスか） | E2 |
| 穏やかな再読み込みの「5 分操作がない」の値が、利用者に受け入れられるか | 試用の期間 |

## 11. quality.md・runbooks・data-model への項目

### quality.md

- `parity` の CI の失敗の数（目標 0）と、本番の抜き取りの不一致の数（目標 0）。
- ビルドの段階的な配信の各段の合否の基準（6.2 節）を、QA が確かめる。
- デプロイ中のファイルごとの中断の p95（目標 2 秒）。

### runbooks

- [runbooks/deploy-and-rollback.md](../runbooks/deploy-and-rollback.md)（この領域で作った）。
- `schema-rollout.md`（[document-model.md](document-model.md) の 17 節の提案）は、6.3 節の手順で書く。
- `forced-reload.md`：`min_client_build` を上げて強い再読み込みをかけるときの、散らしの確かめ方と、`pending` の損失の件数の見方。

### data-model

| 置き場所 | 中身 |
| --- | --- |
| 開発リポジトリ `schema/history.json` | `schema_hash` の履歴と差分の種類（4.2 節） |
| AppConfig | `min_client_build`、`client_build_channels`、フラグ |
| チェックポイントのマニフェスト | `features`（文書のフラグ。ADR-0055。[document-model.md](document-model.md) の 8.2 節に取り込んだ） |

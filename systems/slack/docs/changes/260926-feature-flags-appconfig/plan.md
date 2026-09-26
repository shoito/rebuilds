# Plan: フィーチャーフラグ `packages/flags` と AppConfig

- Change: 260926-feature-flags-appconfig
- Spec: [spec.md](spec.md)
- Status: approved

## 前提と依存

- **依存する変更**：
  - `ci-pipeline`：PR の CI（`ci.yml`）、ID の追跡の検査（`tools/spec-checks`）、ワークスペースの設定（`package.json`、`pnpm-workspace.yaml`、`turbo.json`）、`test:flags` のフック（REQ-DLV-011）。REQ-FLAG-012 は、このフックに中身を入れる形で作る。REQ-FLAG-011 の期限の検査は、変更のパスにかかわらず毎回走らせる必要があるので、`ci.yml` にジョブを 1 つ足す。
  - `post-and-list-messages`：`apps/api` の骨格、認証ミドルウェア、`packages/api-client` のスナップショット、決定表の読み込み（`scripts/lib/decision-table.ts`）。**REQ-FLAG-014（API）の手順 11 だけがこれを待つ。** `packages/flags` は先に作ってマージできる。決定表の読み込みがまだなければ、この変更で同じパスに作り、`post-and-list-messages` はそれを使う。
  - `telemetry-package`：ロガーとメトリクス（REQ-FLAG-007, 010, 013）。
  - `terraform-foundation`：Terraform の状態のバケットと、環境ごとのアカウント（AppConfig のリソースを置く）。
- **この変更に依存する変更**：release フラグの裏に置くすべての変更。`web-app-shell-routing`（REQ-WEB-017 がブートストラップの API を読む）、`web-channel-view`（`release.web_channel_view` を定義する）。
- **release フラグ**：使わない。フラグの仕組みそのものであり、利用者から見える振る舞いを変えないため。
- **削除のタスク**：なし。動作確認用の `ops.example_kill_switch` は常設でよいが、最初の本物の `ops` のフラグが入ったら消す。

## Files that change

パスは `systems/slack/` からの相対パス。

- `packages/flags/package.json`、`tsconfig.json`（新規）
- `packages/flags/src/define.ts`（新規）：`defineFlags` と、名前・種類・既定値・期限の型の制約（REQ-FLAG-001, 002, 003）
- `packages/flags/src/definitions.ts`（新規）：フラグの定義の一覧（`ops.example_kill_switch` だけ）
- `packages/flags/src/config-schema.ts`（新規）：設定の文書の Zod スキーマと、JSON Schema の出力（REQ-FLAG-007）
- `packages/flags/src/bucket.ts`（新規）：バケットの計算（REQ-FLAG-005）
- `packages/flags/src/evaluate.ts`（新規）：DT-FLAG-002（REQ-FLAG-004, 008）
- `packages/flags/src/source.ts`（新規）：Agent からの取得、DT-FLAG-001、取り直しの周期、メトリクス（REQ-FLAG-006, 007, 013）
- `packages/flags/src/override.ts`（新規）：`FLAGS_OVERRIDE`（REQ-FLAG-010）
- `packages/flags/src/client.ts`（新規）：クライアントへ渡す一覧を作る関数（REQ-FLAG-009）
- `packages/contract/src/flags.ts`（新規）：ブートストラップの API の応答の Zod スキーマ（REQ-FLAG-014）
- `apps/api/src/routes/flags.ts`（新規）、`apps/api/src/app.ts`（変更）：ブートストラップの API（REQ-FLAG-014）
- `packages/api-client` の `.d.ts` のスナップショット（変更）：契約の変更として承認を得る（ADR-0008）
- `apps/api/test/flags.test.ts`（新規）：REQ-FLAG-014 の結合テスト
- `packages/flags/test/*.test.ts`、`*.property.test.ts`、`*.decision-table.test.ts`、`*.test-d.ts`（新規）
- `scripts/check-flag-expiry.ts`（新規）：DT-FLAG-003（REQ-FLAG-011）
- `scripts/check-flags-test-task.ts`（新規）：release・migration のフラグを参照するのに `test:flags` を定義していないパッケージを見つける（REQ-FLAG-012）
- `scripts/lib/decision-table.ts`（新規、まだなければ）：`spec.md` から決定表を読み込む
- `scripts/export-flags-json-schema.ts`（新規）：設定の文書の JSON Schema を `infra/` へ書き出す
- `infra/modules/appconfig/`（新規）：アプリケーション、環境（dev・staging・prod）、自由形式の構成プロファイル、JSON Schema のバリデーター、デプロイ戦略。設定の中身は `ignore_changes`
- `infra/envs/{dev,staging,prod}/appconfig.tf`（新規）：上のモジュールの呼び出し。パスは `terraform-foundation` の構成に合わせる
- `../../.github/workflows/ci.yml`（`ci-pipeline` が作るファイル。変更）：期限の検査（`scripts/check-flag-expiry.ts`）と `scripts/check-flags-test-task.ts` のジョブを足し、`ci-gate` の `needs` に加える

## Order of work

- [ ] 1. 定義の型と `defineFlags`、型のテスト（REQ-FLAG-001, 002, 003）→ **定義の形を Dev がレビューして確定**
- [ ] 2. 設定の文書のスキーマ（REQ-FLAG-007）→ **文書の形を Dev と Ops がレビューして確定**（AppConfig を操作するのは Ops と PM なので）
- [ ] 3. バケットの計算とテストベクター（REQ-FLAG-005、PROP-FLAG-001, 003）
- [ ] 4. 評価（REQ-FLAG-004, 008、DT-FLAG-002、PROP-FLAG-002）
- [ ] 5. 取得と退避、取り直しの周期、メトリクス（REQ-FLAG-006, 007, 013、DT-FLAG-001、PROP-FLAG-004）。取得の関数を差し替えられるようにし、テストではメモリ上の偽の Agent を使う
- [ ] 6. テストでの上書き（REQ-FLAG-010）
- [ ] 7. クライアントへ渡す一覧（REQ-FLAG-009）
- [ ] 8. 期限の検査のスクリプト（REQ-FLAG-011、DT-FLAG-003）と、`test:flags` の定義の漏れの検査（REQ-FLAG-012）。`ci.yml` のジョブに組み込む
- [ ] 9. AppConfig の Terraform と JSON Schema の書き出し。dev に適用し、Agent の受け口の形（未検証）を確かめる。違っていたら手順 5 の取得の関数だけを直す
- [ ] 10. 表駆動テスト（DT-FLAG-001〜003）と性質ベーステスト（PROP-FLAG-001〜004）、ID の追跡の検査を通す（ここまでで 1 つ目の PR にしてよい）
- [ ] 11. ブートストラップの API（REQ-FLAG-014）。`post-and-list-messages` の認証ミドルウェアの後。応答のスキーマ → **契約の変更として Dev が承認**

## Risks

- **AppConfig Agent の振る舞い（未検証）**：受け口の URL の形、Agent が AppConfig に届かないときに最後の値を返し続けるか、起動直後の応答。アプリ側は DT-FLAG-001 で退避するので、Agent の振る舞いに頼らない。手順 9 で dev で確かめる。
- **上書きの本番への混入**：`FLAGS_OVERRIDE` が本番で効くと、全ワークスペースで未完成の機能が有効になる。REQ-FLAG-010 で本番では無視し、エラーログを出す。上書きの判定は `DEPLOY_ENV` を読むので、`DEPLOY_ENV` の設定の誤り（prod のタスクに `test`）が残りの穴になる。タスク定義の Terraform で `DEPLOY_ENV` を固定することを、サイドカーを足すインフラの変更に依頼する。
- **両方の状態のテストの時間**：フラグを参照するパッケージの結合テストが 2 倍になり、PR の CI の目標（15 分）を圧迫しうる。`test:flags` は、変更されたパッケージとその依存元でだけ走る（`ci-pipeline` の DT-DLV-001 の 6 行目）。
- **参照の検出の漏れ**：`scripts/check-flags-test-task.ts` が文字列の検索で参照を探すと、動的に組み立てた名前を見落とす。REQ-FLAG-003 で名前を型の和集合に限ったうえで、フラグ名を文字列リテラルで書く（組み立てない）ことをレビューで守る。lint で強制するかは、見落としが実際に起きてから決める。
- **ハッシュの偏り**：UUIDv7 は先頭が時刻なので、似た ID が並ぶ。SHA-256 を通すので偏らない見込みだが、PROP-FLAG-003 で確かめる。
- **直さないこと**：Web クライアントでの読み出し、ECS のサイドカー、フラグの変更の監査ログは、この変更で作らない。

## Proof

| 証明すること | 要件 / 性質 | 方法 |
| --- | --- | --- |
| 定義の規則（接頭辞、期限、既定値） | REQ-FLAG-001 | 型のテスト（`@ts-expect-error`）と、定義の一覧の実行時の検査の単体テスト |
| `entitlement` を定義できない | REQ-FLAG-002 | 型のテスト、単体テスト |
| 定義にない名前を型で拒否する | REQ-FLAG-003 | 型のテスト |
| 段階・停止・社内の評価 | REQ-FLAG-004 | 単体テスト（シナリオ 3 件） |
| 評価の条件の組み合わせと優先順位 | DT-FLAG-002 | 表駆動テスト（`spec.md` から読み込み、9 行 = 9 ケース） |
| バケットのテストベクターと正規化 | REQ-FLAG-005 | 単体テスト |
| バケットの安定性 | PROP-FLAG-001 | 性質ベーステスト（任意の名前と UUID。別の Worker スレッドで計算した値とも比べる） |
| 割合を上げても外れない | PROP-FLAG-002 | 性質ベーステスト（任意の設定と、単調に広げる操作の列。1,000 回） |
| 割合への近さと、フラグどうしの独立 | PROP-FLAG-003 | 性質ベーステスト（p を 0〜100 から選び、各回 100,000 件。試行 20 回。乱数の種を固定し、失敗したら種を出力） |
| 退避と起動の打ち切り | REQ-FLAG-006 | 単体テスト（偽の Agent、時計の差し替え） |
| 設定の出どころの決め方 | DT-FLAG-001 | 表駆動テスト（5 行） |
| 不正な文書を採用しない、文書にないフラグは既定値 | REQ-FLAG-007 | 単体テスト |
| 評価が同期で例外を投げない | REQ-FLAG-008 | 単体テスト（取得の途中での評価の時間） |
| 任意の取得の結果の列でも壊れない | PROP-FLAG-004 | 性質ベーステスト（成功・失敗・任意の JSON の列と、評価の要求を交互に生成する。参照の実装として DT-FLAG-001・002 を素直に書いたモデルと比べる） |
| クライアントへ渡す一覧 | REQ-FLAG-009 | 単体テスト |
| 上書きの有効・無視 | REQ-FLAG-010 | 単体テスト（`DEPLOY_ENV` ごと） |
| 期限の検査 | REQ-FLAG-011、DT-FLAG-003 | 表駆動テスト（4 行、実行日を差し替える）、スクリプトの単体テスト |
| 両方の状態のテストと、定義の漏れの検出 | REQ-FLAG-012 | `scripts/check-flags-test-task.ts` の単体テスト（固定のパッケージの構成で、シナリオ 3 件）。最初に `test:flags` を定義したパッケージの PR で、CI の実行の記録に 2 回の実行があることを確かめる |
| ブートストラップの API、別のワークスペースで 404 | REQ-FLAG-014 | 結合テスト（Testcontainers。メンバー・別のワークスペースのメンバー） |
| 出どころと経過秒数のメトリクス | REQ-FLAG-013 | 単体テスト（メモリ上のメトリクスの受け手） |
| AppConfig のリソースとバリデーター | — | `terraform plan` と Checkov が CI で通る。dev で不正な文書（`percentage: 150`）のデプロイが AppConfig のバリデーターで拒否されることを手で確かめ、PR に記録する |
| すべての ID がテストから参照されている | — | `ci-pipeline` の ID の追跡の検査が CI で通る |

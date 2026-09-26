# Plan: 計装の共通部品 `packages/telemetry`

- Change: 260926-telemetry-package
- Spec: [spec.md](spec.md)
- Status: approved

## 前提と依存

- **依存する変更**：`ci-pipeline`（PR の CI、ID の追跡の検査 `tools/spec-checks`、ワークスペースの設定 `package.json`・`pnpm-workspace.yaml`・`turbo.json`）。決定表の読み込み（`scripts/lib/decision-table.ts`）は [260926-post-and-list-messages](../260926-post-and-list-messages/plan.md) の plan にあるが、この変更が先に着手するなら、同じパスにこの変更で作り、`post-and-list-messages` はそれを使う。
- **この変更に依存する変更**：`feature-flags-appconfig`（ロガーとメトリクスを使う）、`post-and-list-messages`（認証ミドルウェアから `runWithTenant()` を呼ぶ。今の plan には書かれていないので、その plan への追記か、後続の変更で入れる）、E4 の `relay-partitioned-outbox`（`trace_context` 列と DT-OBS-004 の関数）。
- **release フラグ**：使わない。利用者から見える振る舞いを変えない基盤のパッケージで、呼び出す側のサービスもまだ本番にないため。
- **インフラ**：ADOT Collector のサイドカーは含めない。ローカルと CI では、送出先を設定しなければ送出しない（メモリ上の受け手でテストする）。

## Files that change

パスは `systems/slack/` からの相対パス。

- `packages/telemetry/package.json`、`tsconfig.json`（新規）：入口 `.`、`./register`、`./attributes` を export する
- `packages/telemetry/src/attributes.ts`（新規）：属性名・ログの項目名・ラベル名の定数と型（REQ-OBS-003）
- `packages/telemetry/src/resource.ts`（新規）：リソース属性、リリースの識別子の検査（REQ-OBS-001, 002）
- `packages/telemetry/src/register.ts`、`src/sdk.ts`（新規）：NodeSDK の初期化、自動計装、送出、SIGTERM での送出（REQ-OBS-001, 004, 012, 013）
- `packages/telemetry/src/sampler.ts`（新規）：DT-OBS-001（REQ-OBS-005）
- `packages/telemetry/src/tenant-context.ts`（新規）：`runWithTenant()`、`AsyncLocalStorage`
- `packages/telemetry/src/tenant-labeler.ts`（新規）：上位 N 件の計算と DT-OBS-002（REQ-OBS-006）
- `packages/telemetry/src/metrics.ts`（新規）：ラベルを型で制限したカウンター・ヒストグラムの作成（REQ-OBS-006, 007）
- `packages/telemetry/src/logger.ts`、`src/redact.ts`（新規）：pino、DT-OBS-003（REQ-OBS-008, 009）
- `packages/telemetry/src/propagation.ts`（新規）：DT-OBS-004 の関数、バッチのスパンリンク（REQ-OBS-010, 011）
- `packages/telemetry/src/hono.ts`（新規）：`http.route` を付けるミドルウェア（REQ-OBS-004）
- `scripts/lib/decision-table.ts`（新規、まだなければ）
- `packages/telemetry/test/*.test.ts`（新規）：シナリオ、`*.property.test.ts`（PROP）、`*.decision-table.test.ts`（DT）、`*.test-d.ts`（型のテスト）
- `packages/telemetry/README.md` は作らない。使い方は `src/index.ts` の TSDoc に書く

## Order of work

- [ ] 1. パッケージの骨格と、属性名の定数・型（REQ-OBS-003）→ **定数の表を Dev がレビューして確定**
- [ ] 2. リソース属性とリリースの識別子の検査（REQ-OBS-001, 002）
- [ ] 3. SDK の初期化と前読み込み、自動計装（HTTP、`pg`、AWS SDK）、Hono の `http.route` ミドルウェア（REQ-OBS-001, 004）。ESM での前読み込みを最初に試し、動かなければ止めて Dev に相談する
- [ ] 4. サンプラー（REQ-OBS-005、DT-OBS-001）
- [ ] 5. テナントのコンテキストと、ロガー（REQ-OBS-008, 009、DT-OBS-003、PROP-OBS-003, 004）
- [ ] 6. テナントのラベルと、ラベルを制限したメトリクス（REQ-OBS-006, 007、DT-OBS-002、PROP-OBS-001, 002）
- [ ] 7. トレース文脈の関数とバッチのリンク（REQ-OBS-010, 011、DT-OBS-004、PROP-OBS-005）
- [ ] 8. 終了時の送出と、送出の失敗の隔離（REQ-OBS-012, 013）
- [ ] 9. 表駆動テスト（DT-OBS-001〜004）と性質ベーステスト（PROP-OBS-001〜005）、ID の追跡の検査を通す

## Risks

- **ESM と自動計装**：ESM のモジュールは、前読み込みのフックがないと自動計装されない（未検証）。動かないと `pg` のスパンが出ず、REQ-OBS-004 を満たせない。手順 3 で最初に確かめる。
- **X-Ray の trace_id の形式**：X-Ray がランダムな W3C の trace_id を受け付けないと、トレースが X-Ray で見えない（未検証）。この変更の Proof はメモリ上の受け手で確かめるので、staging で ADOT をつないだ後の確認を、インフラの変更の Proof に入れてもらう。
- **性能**：ログの整形（DT-OBS-003 のマスク）とラベルの判定は、すべてのリクエストで走る。NFR-003（投稿 API の p99 200ms）を圧迫しないよう、マスクの正規表現は文字列の項目にだけ適用し、上位の集合は 60 秒ごとの再計算の結果を参照するだけにする。E7 の負荷試験で確かめる。
- **系列の数**：上位の集合の入れ替わりで、古い系列が残る。上限（100 万系列）の 80% のアラートは E7 で作る。この変更では、N を設定で下げられることだけを保証する。
- **マスクの取りこぼし**：正規表現のマスクは二重の防御であり、主な防御は許可リストである。許可リストに自由な文字列の項目（名前、本文）を足さないことを、定数の表のレビューで守る。
- **直さないこと**：Web クライアントの計測、`POST /telemetry`、ダッシュボード、アラート、ESLint の規則は、この変更で作らない。

## Proof

| 証明すること | 要件 / 性質 | 方法 |
| --- | --- | --- |
| リソース属性が付く。前読み込みなしで警告が出る | REQ-OBS-001 | 単体テスト（メモリ上のスパンの受け手）。前読み込みの有無で子プロセスを起動する結合テスト |
| staging・prod で識別子がなければ起動しない | REQ-OBS-002 | 子プロセスを起動する単体テスト（終了コードとログ） |
| 定義にない名前が型検査で落ちる | REQ-OBS-003 | 型のテスト（`expectTypeOf`、`@ts-expect-error`） |
| HTTP・`pg` の自動計装と `http.route` | REQ-OBS-004 | 結合テスト（Testcontainers の PostgreSQL、Hono のアプリ） |
| サンプリングの割合と、記録しないリクエストの `trace_id` | REQ-OBS-005 | 単体テスト（10,000 件で 800〜1,200 件、全件のログに `trace_id`） |
| サンプリングの判定の組み合わせ | DT-OBS-001 | 表駆動テスト（`spec.md` から読み込み、5 行 = 5 ケース。5 行目は既知の trace_id の組で判定を確かめる） |
| 上位 N 件とその他、順位の入れ替わり | REQ-OBS-006 | 単体テスト（時計を差し替える） |
| ラベルの値の決め方 | DT-OBS-002 | 表駆動テスト（4 行） |
| ラベルの値の数が N 以下 | PROP-OBS-001 | 性質ベーステスト（fast-check。ワークスペース数 0〜500、記録 0〜10,000 件、N は 1〜60） |
| 合計が保たれる | PROP-OBS-002 | 性質ベーステスト（メモリ上のメトリクスの受け手で合計を比べる） |
| ヒストグラムと ID のラベルが型で拒否される | REQ-OBS-007 | 型のテスト |
| 共通項目とテナントのコンテキスト | REQ-OBS-008 | 単体テスト（stdout を捕まえる） |
| 本文・エラーの値が出ない | REQ-OBS-009 | 単体テスト（シナリオ 2 件。`pg` の実際のエラーは結合テストで作る） |
| 項目の扱いの組み合わせ | DT-OBS-003 | 表駆動テスト（5 行） |
| 任意の入力で個人情報が出ない | PROP-OBS-003 | 性質ベーステスト（任意の項目名・値、既知の個人情報の形のコーパスを混ぜる。1,000 回） |
| 常に 1 行の有効な JSON | PROP-OBS-004 | 性質ベーステスト（改行・循環参照・巨大な値を含む。1,000 回） |
| 境界ごとの運び方と、封筒にスパン ID が出ないこと | REQ-OBS-010、DT-OBS-004 | 表駆動テスト（5 行。1 行目は HTTP の自動計装で確かめる）、単体テスト（バッチのリンク） |
| 往復で文脈が一致し、任意の文字列で例外を投げない | PROP-OBS-005 | 性質ベーステスト |
| 壊れた文脈で新しいトレースを始める | REQ-OBS-011 | 単体テスト |
| SIGTERM で 5 秒以内に送出して終わる | REQ-OBS-012 | 子プロセスを起動する結合テスト |
| Collector が止まっても応答が変わらない | REQ-OBS-013 | 結合テスト（応答しない送出先で、応答を比べる） |
| すべての ID がテストから参照されている | — | `ci-pipeline` の ID の追跡の検査が CI で通る |

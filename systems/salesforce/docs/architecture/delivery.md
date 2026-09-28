# Delivery: Salesforce

ブランチ、CI、決定表・性質・上限・漏えいの経路の CI、上限の登録簿と設計の記録の一致の検査、デプロイ、リリースとフラグ、`security:sensitive` の変更の流れ。他の題材の delivery.md（[auth0 の delivery.md](../../../auth0/docs/architecture/delivery.md)）を引き継ぎ、この題材に固有の 3 つを足す：**アクセスの判定の CI の関門**、**上限の登録簿の一致**、**組織を単位にしたリリースと影の実行**。この文書で決めたことは、次の 3 つの ADR にある。

- **決定表・性質・上限・漏えいの経路を CI の関門にする。** 上限の登録簿は、設計の記録の governor-limits.md と機械的に比べる（[ADR-0061](../decisions/0061-access-decision-and-limit-gates-in-ci.md)）。
- **`security:sensitive` はパスで自動で付け、テックリードとセキュリティの担当の 2 人の承認、追加の CI、組織の単位の段階的なリリースを必須にする**（[ADR-0062](../decisions/0062-security-sensitive-change-flow.md)）。
- **リリースは組織を単位に段階で広げる。** アクセスの判定・問い合わせのコンパイルを変える時は、新旧を本番の標本で並べて比べる影の実行を経る（[ADR-0063](../decisions/0063-org-staged-release-and-shadow-evaluation.md)）。

| 対象 | 方針 |
| --- | --- |
| ブランチモデル | リポジトリ共通の [ADR-0002](../../../../docs/decisions/0002-trunk-based-development.md)（トランクベース開発） |
| 設計の記録と開発リポジトリ | リポジトリ共通の [ADR-0005](../../../../docs/decisions/0005-design-record-repository.md) |
| AWS の CI/CD と Terraform | [infrastructure.md](infrastructure.md) の 8 節 |
| 手順 | [runbooks/deploy-and-rollback.md](../runbooks/deploy-and-rollback.md) |

原則は 3 つ。

- **`main` は常にデプロイできる状態に保つ。**
- **デプロイ（コードを置くこと）とリリース（振る舞いを有効にすること）を分ける。** デプロイは Ops が承認し、リリースは PM が判断する。
- **アクセスの判定と上限に触れる変更は、表・性質・2 人の人の目・本番の影の実行を通してから広げる。**

## 1. 変更からマージまで

```
changes/YYMMDD-<slug>/ の spec・plan が承認済み（DT-*・PROP-*・LIM-* を含む）
   ▼
ブランチ salesforce/YYMMDD-<slug>（エージェントは worktree ごとに 1 本）
   ▼
PR ─▶ パスで security:sensitive のラベルを自動で付ける（4 節）
   ▼
PR の CI（2 節）─▶ レビュー（CODEOWNERS、作成者と別の人。security:sensitive は 2 人）
   ▼
merge queue（夜間の重い組の結果も必須）─▶ squash で main へ
```

- 未完成の振る舞いは release フラグの裏に置く。
- PR の説明には、変更フォルダ、規模、使うフラグに加えて、**アクセスの判定を変えるか**、**上限を足す・変えるか**、**漏えいの経路（`LEAK-*`）を足すか**を書く。

### 1.1 リポジトリの中の区分

開発リポジトリは 1 つ（モノレポ）。

| パス | 中身 | コードオーナー |
| --- | --- | --- |
| `packages/access/`、`packages/compiler/{bind,authz,sharing,plan}/` | アクセスの判定、閉包、共有の行、参照の評価器、コンパイラの段 2〜5 | Dev のテックリード＋セキュリティの担当 |
| `packages/search/query/`、`packages/reports/compile/`、`packages/events/authz/` | 検索・レポート・イベントの判定 | 同上 |
| `packages/limits/` | 上限の登録簿（`registry.ts`）と計測器 | Dev のテックリード＋QA（計測器の差し込み口はセキュリティの担当も） |
| `packages/audit/`、`packages/auth/`、`packages/crypto/` | 監査、認証、暗号 | テックリード＋セキュリティの担当 |
| `services/worker/cross-org/` | 組織の作成、Sandbox の複製、組織の移動、消去 | 同上 |
| `services/code-runner/`（E13） | 利用者のコードの砂場 | 同上 |
| `services/*`（その他）、`packages/*`（その他） | 各領域 | 領域のオーナー |
| `migrations/` | DB のマイグレーション | Dev のテックリード（RLS の方針はセキュリティの担当も） |
| `infra/` | IaC | Ops（IAM・KMS・SCP・ネットワークはセキュリティの担当も） |

## 2. CI（ADR-0061）

### 2.1 PR の CI

目標は 25 分以内。

| 段 | 内容 | 失敗の条件 |
| --- | --- | --- |
| 型と lint | TypeScript の型、ESLint、フォーマット | 違反 |
| 構造の lint | `records`・ピボットへの SQL のコンパイラの外での使用、`shard_no` の定数のない分割の表への SQL、マイグレーションの外の DDL（`proj_` の許可リストを除く）、OpenSearch の問い合わせの組み立ての関数の外での使用、ログの型の外の出力 | 違反（各 ADR の Confirmation） |
| 依存の lint | 本家の SDK・CLI・言語の実行系を許可しないパッケージの一覧（[ADR-0001](../decisions/0001-platform-and-stack.md)） | 当たる依存 |
| マイグレーションの検査 | 新しい表に `org_id`・主キーの先頭の `org_id`・RLS の方針（[ADR-0005](../decisions/0005-tenancy-and-governor-limits.md)） | 例外の許可リストにない表 |
| 単体・結合 | Vitest、Testcontainers（PostgreSQL 18、Valkey、OpenSearch） | 失敗 |
| **決定表** | `specs/` と進行中の `changes/` の全ての `DT-*` を読み、行ごとのテストが生まれ、テスト名に `DT-XXX-NNN #行` がある | 表の行とテストの数の食い違い、失敗 |
| **性質ベーステスト（速い組）** | アクセスの判定（`PROP-SHR-*`・`PROP-RPT-*`・`PROP-SRCH-*`・`PROP-EVT-*` など）1,000 通り。`security:sensitive` は 1 万通り | 反例 |
| **上限の試験** | 登録簿の全ての `id` に `LIM-*` の試験があり、ちょうどで通り、1 つ超えたら巻き戻る・拒否する | 試験のない上限、失敗 |
| **上限の登録簿と設計の記録の一致** | 2.3 節 | 食い違い |
| **漏えいの経路** | [security.md](security.md) の 4 節の全ての `LEAK-*` のテストの ID が参照され、通る | 参照のない行、失敗 |
| 要件の追跡 | `specs/` と `changes/` の全ての `REQ-*`・`PROP-*`・`DT-*` がテストから参照される（[process.md](../../../../docs/process.md) の 7 節） | 参照のない ID |
| API の契約 | OpenAPI の前の版と比べて壊す変更がない（[ADR-0020](../decisions/0020-rest-api-shape-and-versioning.md)） | 壊す変更 |
| メタデータの形式 | パッケージの JSON Schema、書き出しの正規化の往復（[ADR-0039](../decisions/0039-metadata-package-format.md)） | 失敗 |
| 日本語の検索の評価 | 生成したコーパスで再現率・適合率（[ADR-0031](../decisions/0031-search-index-and-japanese-analysis.md)） | 2 ポイント以上の悪化 |
| アクセシビリティ | axe の重大な違反（[ui-layouts-and-list-views.md](ui-layouts-and-list-views.md)） | 1 件 |
| セキュリティ | SAST、秘密の走査、依存の脆弱性、IaC の検査（[infrastructure.md](infrastructure.md) の 8 節） | Critical・High |
| E2E（主な流れ） | Playwright：組織の作成 → CSV の取り込み → リストビュー → レポート | 失敗 |

### 2.2 夜間の CI（重い組）

| 段 | 内容 |
| --- | --- |
| 性質ベーステスト | アクセスの判定の性質を 10 万通り（[ADR-0017](../decisions/0017-reference-access-evaluator.md)）。問い合わせのコンパイラと評価器の一致、ピボットと正本の一致、数式の SQL と評価器の一致 |
| 障害の注入 | Relay の停止と二重の送信、Worker の停止（一括の再開）、共有のジョブの途中の停止、Valkey の停止（fail open） |
| 小さな負荷の回帰 | k6 で主な経路の p95 を前の夜と比べる（20% 以上の悪化で失敗） |
| 上限の性能 | 積み上げ集計の 5 万件の集計し直しの p99、分割の表の計画の時間 |
| 組織の移動の試験 | 小さな組織の移動（止めの時間、照合）（[ADR-0056](../decisions/0056-org-migration-by-row-filtered-logical-replication.md)） |

- 夜間の失敗は、翌朝の merge queue を止める（必須の検査）。直すか、失敗を起こした PR を戻す。

### 2.3 上限の登録簿と設計の記録の一致（ADR-0061）

```
開発リポジトリの CI
  1. rebuilds のリポジトリを読むだけの権限で取り出す（main）
  2. systems/salesforce/docs/architecture/governor-limits.md の 4.1 節と 6 節の表を読む（ID、値、scope）
  3. packages/limits/registry.ts から同じ形の表を作る
  4. 比べる：ID の過不足、値の違い、scope の違い
  5. 食い違ったら失敗。文言に「設計（rebuilds）を先に直す」と、食い違いの行を出す
```

- 値を変える流れ：rebuilds の governor-limits.md を直す PR（Dev の承認、QA の確認）→ マージ → 開発リポジトリの登録簿と上限の試験を直す PR。どちらかだけが進むと、CI が失敗して気づく。
- 例外：本番の障害で値を先に変える時は、開発リポジトリの `limits-exceptions.yaml` に ID・理由・期限（24 時間）を書き、期限の内に rebuilds を直す。期限を過ぎた例外は CI を落とす。
- 上限の値の増加と、試験の期待値の変更が同じ PR にある時は、`security:sensitive` と同じ 2 人の承認にする（値を緩めて試験を通すことを防ぐ。systems/salesforce の AGENTS.md）。
- 表の形（列の名前、節の番号）を変える時は、検査の道具も直す。

## 3. 決定表と性質の扱い

- 決定表は `spec.md` から直接読む（表をテストのコードに写さない。[process.md](../../../../docs/process.md) の 6 節）。表の読み取りの道具は、Markdown の表を行ごとの入力と期待値にする。
- アクセスの判定の決定表（`DT-SHR-*`、`DT-UI-001`、`DT-LV-001`、`DT-RPT-*`、`DT-DSH-001`、`DT-SRCH-001`、`DT-EVT-001`、`DT-ACT-001`、`DT-APR-002`、`DT-AUTH-*`、`DT-EXT-001`、`DT-PKG-001`）は、参照の評価器（ADR-0017）も同じ表を読む。本番の実装と評価器の両方が表と一致することを確かめる。
- 性質ベーステストのジェネレーターの大きさと回数は、各領域の文書（[sharing-and-record-access.md](sharing-and-record-access.md) の 9.2 節など）と変更単位の `quality.md` で決める。反例は最小化して、回帰のテストとして残す。

## 4. `security:sensitive` の変更の流れ（ADR-0062）

### 4.1 ラベル

- 開発リポジトリの `.github/security-paths.yml` のパスの規則で、自動で付ける：アクセスの判定、コンパイラの段 2〜5、検索の問い合わせの組み立て、レポートのコンパイル、イベントの判定、組織をまたぐ Worker、監査、認証、暗号、上限の計測器の差し込み口、`code-runner`、IaC の IAM・KMS・SCP・ネットワーク、マイグレーションの RLS の方針。
- 規則に当たらない PR でも、テンプレートの問い（漏えいの経路を足すか、判定を変えるか、秘密に触れるか、上限の試験の期待値を変えるか）に「はい」なら付ける。
- 外せるのはセキュリティの担当だけ。

### 4.2 求めること

| 項目 | 通常の PR | `security:sensitive` |
| --- | --- | --- |
| 承認 | コードオーナー 1 人 | Dev のテックリード＋セキュリティの担当（作成者と別、エージェントは数えない） |
| 性質ベーステスト | 1,000 通り | 1 万通り |
| 漏えいの経路のテスト | 触れた領域 | 全て |
| 新しい経路 | — | `LEAK-*` の行を足したか（[security.md](security.md) の 4 節） |
| リリース | フラグ（5 節） | フラグ＋判定を変えるなら影の実行（6 節） |
| ロールバックの PR | 通常 | 2 人目の承認は事後 24 時間以内でよい |

- 人数が足りない時は、[process.md](../../../../docs/process.md) の「兼務と自己承認」に従い、事後の確認を Epic の完了までに行う。
- 四半期ごとに、ラベルのない PR の標本 20 件をセキュリティの担当が見直し、パスの規則を足す。

## 5. デプロイとリリース（ADR-0063）

### 5.1 デプロイ

- ECS のサービスは、1 AZ ずつのローリングで入れ替える（`runtime` は blue/green。ALB のターゲットグループで切り替え、悪化で戻す）。
- デプロイの順：マイグレーション（expand）→ `worker`・`relay`・`indexer` → `metadata`・`bulk` → `runtime`。
- マイグレーションは expand → 移行 → contract の 3 回に分ける。contract は 1 つ前のリリースで参照をやめてから行う。分割の表（約 3,300）への `ALTER` は、根の表に行い、ロックの時間を staging で測る。
- **メタデータのコンパイル済みの部品の形を変える時は、部品の鍵に形の版を含める。** 新旧のタスクが同時に動いても、互いの部品を読み違えない（[ADR-0007](../decisions/0007-segmented-metadata-snapshots.md)）。
- カーソルの形・監査の `details` のスキーマ・パッケージの形式を変える時は、新旧の両方を読めるコードを先に出す。
- デプロイできる時間帯：平日 10〜17 時。月末・四半期末の営業の締め（月末の 3 営業日）は、修正だけ。

### 5.2 リリースとフラグ

- フラグは AWS AppConfig。評価は組織の ID で行う。
- 段：`internal`（社内の組織と監視の組織）→ `nonprod`（Sandbox・試用・Developer）→ `prod_1` → `prod_10` → `prod_50` → `all`。1 段 24 時間以上（判定の変更は 72 時間）。
- 次の段へ進む条件：その段の組織の SLI の悪化がない、エラーの率が変わらない、`access_oracle_mismatch_total{direction="over"}` が 0、影の実行の食い違いが 0。Ops が確かめて進める（自動で進めない）。
- ガード：段の組織の SLO の燃え方が 1 時間 14 倍を超えたら、フラグを自動で前の段に戻す。
- Sandbox は元の本番の組織の段を継ぐ（本番より先に新しい振る舞いを試せるよう、`nonprod` の段で先に有効になる）。組織の移動の間は段を変えない。
- フラグの寿命：release フラグは `all` の後 30 日で消す PR を出す。運用のフラグ（安全の設定、数式の分類を D に落とす設定、索引の切り替え）は残す。

## 6. 影の実行（ADR-0063）

アクセスの判定、問い合わせのコンパイラ、共有の条件の生成、検索・レポートのコンパイルを変える時に、`internal` の前に置く段。

```
本番の要求の標本（組織ごとに 1 分 10 件、全体で 1 秒 100 件まで）
  旧いコンパイラ → 結果（利用者に返す）
  新しいコンパイラ → reader で同じ要求を実行（返さない）
  比べる：返すレコードの ID の集合のハッシュ、FLS で落とす項目の集合
  食い違い → 参照の評価器でどちらが正しいかを判定し、記録する（値は残さない）
```

- 影の実行は、要求の上限・割り当てに数えず、組織の DB の時間には数える。
- 食い違いが 1 件でもあれば、次の段へ進めない。新しい側が正しい食い違い（旧い側の不具合）も記録し、別の変更として扱う。
- 影の実行の段の長さは 72 時間以上。本番の多様な設定（深いロール、多くのルール、暗黙の共有）を通すため。
- 影の実行の結果は、ID の集合のハッシュだけを残す（[observability.md](observability.md) の 2 節の規則）。

## 7. この領域の ADR

| ADR | 決定 |
| --- | --- |
| [0061](../decisions/0061-access-decision-and-limit-gates-in-ci.md) | 決定表・性質・上限・漏えいの経路を CI の関門にし、上限の登録簿は設計の記録の governor-limits.md と機械的に比べる |
| [0062](../decisions/0062-security-sensitive-change-flow.md) | `security:sensitive` はパスで自動で付け、テックリードとセキュリティの担当の 2 人の承認、追加の CI、組織の単位の段階的なリリースを必須にする |
| [0063](../decisions/0063-org-staged-release-and-shadow-evaluation.md) | リリースは組織を単位に段階で広げ、アクセスの判定・問い合わせのコンパイルを変える時は、新旧を本番の標本で並べて比べる影の実行を経る |

他の領域への依頼：

- governor-limits の領域：4.1 節と 6 節の表の形（列の名前）を、検査の道具が読む形として保つ。形を変える時は Dev に知らせる。
- 各領域：決定表を `spec.md` の中の Markdown の表で書き、1 行に 1 つの結果にする。

## 8. Story の候補

| Epic | Story の候補 |
| --- | --- |
| E1 | PR の CI の段（構造の lint、依存の lint、マイグレーションの検査） |
| E1 | 決定表の読み取りの道具と、表の行とテストの数の検査 |
| E1 | 上限の登録簿と governor-limits.md の一致の検査、例外の一覧 |
| E1 | 漏えいの経路の登録簿の検査 |
| E1 | `security:sensitive` のパスの規則、自動のラベル、必須のレビュー |
| E1 | AppConfig のフラグ（組織の ID での評価、段、ガード） |
| E1 | 夜間の CI（性質 10 万通り、障害の注入）と merge queue の必須の検査 |
| E4 | 影の実行（標本、reader での実行、比べ、評価器での判定） |
| E12 | デプロイの手順の訓練（ロールバック、部品の形の版） |

## 9. 未解決の問い

- 夜間の失敗で翌朝のマージを止めるのは、開発の速さに重すぎないか。
- 影の実行の標本の数（1 秒 100 件）で、珍しい設定の組織の誤りを 72 時間で見つけられるか。
- rebuilds のリポジトリを開発リポジトリの CI から読む権限の持ち方（GitHub App か、読むだけのトークンか）。
- 月末の営業の締めの時期のデプロイの制限を、組織ごとの会計年度に合わせるか。

### 決定

2026-09-28 の既定案。

- 夜間の失敗で止める。反例が出た時の直しを最優先にする。3 か月の運用で止まった日数を数えて見直す。
- 標本は組織ごとの上限（1 分 10 件）で、全ての組織から均等に取る。珍しい設定の組織は、`internal` の段の合成の組織（深いロール・多くのルールの組織を生成して置く）で補う。
- GitHub App（読むだけ、rebuilds のリポジトリだけ）で取り出す（リポジトリ共通の ADR-0004 の考え方に寄せる）。
- 月末の制限は暦の月末だけにする。組織ごとの会計年度には合わせない。

## 10. quality.md・runbooks・data-model に載せるもの

**quality.md**

- CI の関門（2 節）を、テストのレベル構成として写す。性質ベーステストの回数（PR 1,000・`security:sensitive` 1 万・夜間 10 万）。
- 影の実行（6 節）を、本番での品質検証（シフトライト）の 1 つとして書く。

**runbooks**

- [deploy-and-rollback.md](../runbooks/deploy-and-rollback.md)：デプロイ、フラグの段、影の実行の食い違い、ロールバック。
- SLI の追加の依頼（Ops へ）：デプロイの失敗の率、ロールバックの数、フラグの段の滞在の時間、影の実行の食い違いの数。

**data-model**

| テーブル | 主な列 | 備考 |
| --- | --- | --- |
| `shadow_eval_results` | `id`、`org_id`、`flag`、`route`、`old_hash`、`new_hash`、`oracle_verdict`（`old_correct`・`new_correct`・`both_wrong`）、`at` | RLS の外（運用）。値を持たない。30 日 |
| AppConfig のフラグ | 組織の ID の段の一覧 | DB でなく AppConfig |

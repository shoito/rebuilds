---
status: accepted
date: 2026-09-28
---

# ADR-0001: 共通の基盤を引き継ぎ、給与計算も TypeScript で書く。お金は整数の円と固定小数点で扱う

## Context

rebuilds の他の題材（Slack、Stripe、Auth0 など）で、次の基盤を決めている。

- AWS（東京、DR は大阪。ECS Fargate、Aurora PostgreSQL 18、ElastiCache Valkey、SQS、S3・CloudFront、KMS）
- TypeScript（Hono＋Zod）
- Terraform、OpenTelemetry、AWS AppConfig のフィーチャーフラグ、トランクベース開発

この題材には、他の題材にない条件がある。

- **給与計算の正しさ**：1 円の誤りも許されない。端数の規則が法令・通知ごとに違う（例：社会保険料の被保険者負担分は、給与から控除するときは 50 銭以下を切り捨て、50 銭を超えると切り上げる。現金で払うときは 50 銭未満を切り捨てる。[日本年金機構](https://www.nenkin.go.jp/service/kounen/hokenryo/nofu/20121026.html)、2026-09-28 に確認）。
- **途中の値に円未満が出る**：料率は 1000 分の 1 の単位（例：協会けんぽの令和 8 年度の介護保険料率 16.2/1000、子ども・子育て支援金率 0.23%。[協会けんぽ](https://www.kyoukaikenpo.or.jp/about/business/insurance_rate/rate_prefectures/r08/index.html)、2026-09-28 に確認）で、折半すると銭の単位の端数が出る。
- **再現性**：同じ入力から、何年後でも同じ結果を出す（[ADR-0004](0004-payroll-engine.md)）。
- **計算の量**：S1 の最大のテナントで 3 万人、支給日の前に集中する。1 人あたり 50〜200 項目の計算。

本家は Java の上に、独自のメタデータの言語（XpressO）と、メモリーの中のオブジェクトモデルを作り、給与計算のような重い計算は別の計算のサービスに分けている（[ホワイトペーパー](https://www.workday.com/content/dam/web/en-us/documents/whitepapers/whitepaper_workday_technology_platform_devt_process.pdf)、2026-09-28 に確認）。この実装は使わない（[リポジトリ共通の ADR-0007](../../../../docs/decisions/0007-no-reuse-of-original-implementation.md)）。

## Options

実行基盤：

1. **共通の基盤を引き継ぐ**
2. 題材のために別の基盤にする（例：JVM とメモリーの中のデータグリッド）

給与計算の言語：

- a. **TypeScript（他のサービスと同じ）**。お金は `bigint` の整数と固定小数点
- b. Kotlin・Java（JVM）。`BigDecimal`
- c. Rust。10 進の型のライブラリ
- d. 給与計算の規則を書く専用の言語（DSL）を作り、その評価器を TypeScript で書く

数の表し方：

- i. **円は `bigint`、率と途中の値は `bigint` の固定小数点（10 進の桁を固定）。丸めは名前付きの関数だけ**
- ii. 汎用の 10 進のライブラリ（`decimal.js` など）
- iii. `number`（浮動小数点）と、最後に丸める

## Decision

1、a、i を採用する。

### 実行基盤

- 実行基盤・言語・IaC・可観測性・フラグは、他の題材と同じにする。題材をまたいで、エージェントと人が同じ道具で検証できる。
- API、BP Worker、Payroll Compute、Worker を別の ECS のサービスにする。Payroll Compute は、給与計算の実行ごとに ECS のタスクを起こし、従業員の束ごとに並列に計算する。
- マイナンバーの保管庫（Vault）は、別の AWS アカウントに置く（[ADR-0005](0005-security-and-my-number.md)）。
- DB は Aurora PostgreSQL 18。有効日付は、範囲型と PostgreSQL 18 の時間の制約で守る（[ADR-0002](0002-effective-dated-data-model.md)）。Aurora で使えるかは E1 の PoC で確かめる。

### 給与計算の言語（a）

- 給与計算のエンジンは、TypeScript の純粋な関数の集まりにする（[ADR-0004](0004-payroll-engine.md)）。
- 選んだ理由：
  - 給与計算の難しさは、数値の計算の量ではなく、規則の多さと、条件の組み合わせと、端数の規則にある。計算そのものは、整数の掛け算・割り算・表引きで、1 万人で 200 万回ほどである。Node.js で十分に速いと見込む（E12 の負荷試験で確かめる）。
  - 他のサービスと同じ型（Zod のスキーマ、`packages/money`、`packages/temporal`）を、計算の入力と出力にそのまま使える。言語の境界で型を二重に持たない。
  - 性質ベーステスト（fast-check）とゴールデンデータセットの道具を、1 つの言語で揃えられる。エージェントが扱いやすい。
- b を選ばなかった理由：`BigDecimal` は成熟しているが、他のサービスと言語が分かれ、入力のスキーマと規則表の型を二重に持つことになる。JVM の運用の道具も別に要る。
- c を選ばなかった理由：速さは要らない。言語の境界のコストが b と同じくある。
- d を選ばなかった理由：MVP では、法定の計算はシステムが持ち、テナントが変えられるのは支給・控除の項目の限られた式だけにする。規則を書く言語を作ると、その言語の正しさと版の管理が新しい論点になる。テナントの式は、payroll-engine の領域で、限られた形（定額、率 × 基礎、時間 × 単価、表引き）の宣言として持つ。

### 数の表し方（i）

- **円は `bigint`。** 支給額・控除額・差引の支給額は、整数の円で持つ。
- **率と途中の値は、`bigint` の固定小数点にする。** 10 進で小数点以下の桁を固定した型（`Dec`）を `packages/money` に置く。料率（1000 分の 1、10 万分の 1 の単位）、社会保険料の折半の途中の値（銭の単位）、時間単価（円未満）を、誤差なしに持つ。桁の数は payroll-engine の領域で決める（1 円の 1 万分の 1 までを想定）。
- **丸めは、名前付きの関数だけで行う。** 例：`roundSocialInsuranceEmployeeShare`（50 銭以下切り捨て、50 銭超切り上げ）、`roundDownToYen`、`roundHalfUpToYen`。どの規則をどこで使うかは、`spec.md` の決定表と、payroll-jp-rules の領域で決める。汎用の `round` を金額に使わない。
- **割り算は、商と余りを明示する。** 按分（日割り、住民税の月割りの端数を 6 月に寄せるなど）は、合計が保たれる関数だけで行う。
- ii を選ばなかった理由：汎用の 10 進のライブラリは、丸めの既定の方式と精度をグローバルな設定で持つものが多く、設定の違いで結果が変わりうる。本システムに要る演算（加減、整数倍、率を掛ける、按分、名前付きの丸め）は少なく、自前で持ったほうが検証しやすい。
- iii は、誤差が出るので使わない。
- API とファイルでは、金額を整数の円（JSON の数値）として出す。`Number.MAX_SAFE_INTEGER` 以内であることを検証する。率は文字列の 10 進で出す。

## Consequences

- 良くなること：
  - 他の題材と同じ道具・CI・運用を使える。
  - 金額と率に誤差が入らず、丸めの箇所がコードの上で名前として見える。レビューと決定表の突き合わせがしやすい。
- 引き受けるコスト：
  - `packages/money` を自前で持ち、保守する。性質ベーステスト（加算の結合、按分の合計の保存、丸めの境界）を厚くする。
  - Node.js の 1 つのプロセスは 1 つのコアしか使わない。Payroll Compute は、タスクの数と worker threads で広げる。数は E12 の負荷試験で決める。
  - 本家のような、メタデータで画面とロジックを組み立てる仕組みは持たない。テナントの違いは、設定と規則表と、限られた式で表す（[intent.md](../intent.md) の Non-goals）。

## Confirmation

- lint：金額・率の型（`Yen`、`Dec`）以外で、金額を `number` として扱うコードを禁止する。`Math.round`・`toFixed`・`parseFloat` を `packages/payroll` と `packages/money` で禁止する。
- 性質ベーステスト：任意の金額の列で、按分の合計が元の金額に一致する。丸めの関数が、境界（x.50 銭、x.51 銭）で決定表どおりに振る舞う。
- 依存の一覧の検査：本家の実装・本家の SDK が依存に入っていない（[リポジトリ共通の ADR-0007](../../../../docs/decisions/0007-no-reuse-of-original-implementation.md)）。

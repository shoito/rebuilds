# Delivery: Workday

ブランチ、CI、ゴールデンデータセットの CI、デプロイ、規則表のリリース（法令の改正の暦）、フラグ、`security:sensitive` の変更の流れを扱う。他の題材（Slack・Auth0 の delivery.md）を引き継ぎ、この題材に固有の 4 つを足す：**ゴールデンデータセットの全件一致**、**規則表をコードと別に出すリリース**、**給与に効くフラグを実行ごとに固定すること**、**支給日の前の凍結**。

| 対象 | 方針 |
| --- | --- |
| ブランチモデル | リポジトリ共通の [ADR-0002](../../../../docs/decisions/0002-trunk-based-development.md)（トランクベース開発） |
| デプロイとマイグレーション、フラグの道具 | 他の題材を引き継ぐ（AppConfig、expand・contract のマイグレーション） |
| ゴールデンデータセットの CI | [ADR-0061](../decisions/0061-golden-dataset-ci.md) |
| 規則表のリリースと改正の暦 | [ADR-0062](../decisions/0062-rule-table-release-calendar.md) |
| 給与に効くフラグと支給日の前の凍結 | [ADR-0063](../decisions/0063-payroll-flags-pinning-and-freeze-windows.md) |
| 保管庫のパイプラインの分離 | [ADR-0057](../decisions/0057-vault-delivery-separation.md) |
| 手順 | [runbooks/deploy-and-rollback.md](../runbooks/deploy-and-rollback.md) |

原則は 4 つ。

- **`main` は常にデプロイできる状態に保つ。**
- **デプロイ（コードを置くこと）とリリース（振る舞いを有効にすること）を分ける。** デプロイは Ops が承認し、リリースは PM が判断する。
- **給与の額を変えうる変更は、ゴールデンデータセットと 2 人の人の目を通す。** 期待値を実装に合わせて書き換えない（[AGENTS.md](../../AGENTS.md)）。
- **法令の改正は、コードのリリースを待たずに、規則表のリリースで届ける。**

## 1. 変更からマージまで

```
changes/YYMMDD-<slug>/ の spec・plan が承認済み（法務・社労士・税理士の確認待ちの行があれば承認しない）
   ▼
ブランチ workday/YYMMDD-<slug>（エージェントは worktree ごとに 1 本）
   ▼
PR ─▶ パスでラベルを自動で付ける：security:sensitive、payroll:calc、golden:expected-change、vault
   ▼
PR の CI（2 節）─▶ レビュー（CODEOWNERS、作成者と別の人。security:sensitive は 2 人）
   ▼
merge queue ─▶ squash で main へ
```

- 未完成の振る舞いは release フラグの裏に置く。
- PR の説明には、変更フォルダ、規模、フラグに加えて、**給与の額を変えうるか**、**ゴールデンデータの期待値を変えるか（変えるなら確認の記録）**、**`THR-` の行の追加・変更**を書く。

### 1.1 リポジトリの中の区分

| パス | 中身 | コードオーナー | ラベル |
| --- | --- | --- | --- |
| `packages/payroll/`、`packages/money/`、`packages/payroll-jp/` | 給与の計算、お金の型、日本の規則 | Dev のテックリード＋QA | `payroll:calc`、`security:sensitive` |
| `golden/` | ゴールデンデータセット（4 節） | QA（期待値の変更は QA＋記録） | `golden:expected-change`（期待値の変更） |
| `rules/` | 規則表の読み取り器、検査、元の資料の対応 | Dev＋QA | `payroll:calc` |
| `packages/temporal/`、`packages/authz/`、`packages/bp-engine/` | 有効日付、権限、業務プロセス | Dev のテックリード＋セキュリティの担当 | `security:sensitive` |
| `services/payments/`（振込ファイル、明細） | 支払 | Dev のテックリード＋セキュリティの担当 | `security:sensitive` |
| `services/vault-*`、`packages/vault-*`、`infra/vault/` | 保管庫 | Dev のテックリード＋セキュリティの担当 | `vault`、`security:sensitive` |
| `packages/telemetry/`、`services/audit-*` | 計装、監査 | Dev＋セキュリティの担当 | `security:sensitive` |
| `infra/`（その他） | IaC | Ops（鍵・WAF・IAM は＋セキュリティの担当） | 鍵・WAF・IAM は `security:sensitive` |
| その他 | 画面、各領域 | 領域のオーナー | — |

## 2. CI

### 2.1 PR の CI

他の題材の段（lint、型、単体、結合、E2E の一部、SAST、依存、秘密の走査）を持ち、次を足す。目標は 25 分以内。

| 段 | 内容 | 失敗の条件 |
| --- | --- | --- |
| 決定表のテスト | `spec.md` の `DT-*` を直接読み、全行を表駆動テストにする | 1 行でも、または表のテストの欠け |
| 性質ベーステスト | `PROP-*`（CI の回数。有効日付は 1 性質 500 回。[ADR-0009](../decisions/0009-temporal-reference-model-testing.md)） | 1 件でも。失敗の種を回帰のテストに残す |
| ゴールデンデータセット | 4 節。給与の計算に届く変更（依存のグラフで判定）で必須 | 1 円・1 分でも違えば |
| 要件の追跡 | `specs/` と進行中の `changes/` の `REQ-*`・`PROP-*`・`DT-*`、[security.md](security.md) の `THR-*` が、どこかのテストから参照されている | 参照の漏れ |
| テナントの分離 | PROP-SEC-002 など | 1 件でも |
| 個人情報・個人番号の走査 | テストの実行中のログ・スパン・スナップショット・フィクスチャー・入力の文書（[ADR-0058](../decisions/0058-pii-free-telemetry.md)）。人事の側のパッケージの個人番号の形（[ADR-0005](../decisions/0005-security-and-my-number.md)） | 1 件でも |
| 給与の lint | `packages/payroll` の `Date.now`・引数なしの `new Date()`・`Math.random`・DB のクライアント・`process.env`・`Math.round`・`toFixed`・`parseFloat`、`Yen`・`Dec` の `/`（[ADR-0001](../decisions/0001-platform-and-stack.md)、[ADR-0004](../decisions/0004-payroll-engine.md)、[ADR-0027](../decisions/0027-pay-item-graph-and-formula-language.md)）。規則表の値の直書き（[ADR-0030](../decisions/0030-rule-table-ingestion-and-verification.md)） | 1 件でも |
| マイグレーション | `tenant_id` と RLS、有効日付の 3 つのテーブルと時間の制約（[ADR-0006](../decisions/0006-temporal-table-triplet-and-fold.md)）、列の `pii_class`（[ADR-0051](../decisions/0051-threat-model-and-pii-classification.md)）、追記のみの表の権限 | 規則の違反 |
| 公開の API の互換 | OpenAPI の差分で、`v1` の破壊的な変更を検出する | 検出 |
| アクセシビリティ | 画面の axe の自動検査（[self-service-ui.md](self-service-ui.md) の 8 節） | 違反 |
| インフラ（`infra/` の変更時） | `fmt`、`validate`、tflint、Checkov、`plan`、plan のポリシー検査（[infrastructure.md](infrastructure.md) の 10 節） | 違反、状態を持つリソースの削除・置き換え |

### 2.2 夜間の CI

- ゴールデンデータセットの全件（依存の判定によらず）と、次の年・次の年度の規則表の下書きでの試し（規則表の改正の準備。6 節）。
- 性質ベーステストの長いバージョン（有効日付は 1 性質 20,000 回）。
- 前のリリースのエンジンのイメージで、ゴールデンデータの入力を計算し、今のエンジンと一致することを確かめる（一致しない差は、意図した修正かを QA が確かめる。本番の `ENGINE_DRIFT` の前ぶれを見つける。[ADR-0028](../decisions/0028-retro-deltas-and-bonus-runs.md)）。
- E2E の全件、DAST、負荷試験の短いバージョン、障害の注入（Aurora の writer、Valkey、SQS、保管庫への到達不能）。

夜間の CI が 2 日続けて失敗している間は、release フラグを広げない。

## 3. `security:sensitive` の変更

Auth0 の題材の規則（[Auth0 の delivery.md](../../../auth0/docs/architecture/delivery.md) の 3 節）を引き継ぐ。

| 項目 | 規則 |
| --- | --- |
| ラベル | `.github/security-sensitive-paths.yml` のパスに当たる PR に、Actions が自動で付ける。作成者は外せない |
| 承認 | Dev のテックリードとセキュリティの担当の 2 人。どちらも作成者と別。エージェントの PR でも同じ |
| 事後の確認の例外 | 使わない（リポジトリ共通の [ADR-0004](../../../../docs/decisions/0004-agent-prs-via-github-app.md) の例外を当てない） |
| 保管庫 | パイプラインと承認者を分ける（[ADR-0057](../decisions/0057-vault-delivery-separation.md)）。人事の側と同じ日に本番へ出さない |

## 4. ゴールデンデータセットの CI（[ADR-0061](../decisions/0061-golden-dataset-ci.md)）

### 4.1 形

```
golden/
  manifest.yaml            # categories that must be covered (ADR-0004 boundary list) -> case ids
  cases/<case_id>/
    input.json             # canonical input document (RFC 8785), synthetic person only
    rules.yaml             # rule table version ids by application key (or "resolve by pay_date")
    settings.json          # tenant payroll settings version (withholding method, rounding, ...)
    expected.json          # item code -> Yen (integer), plus time categories, warnings
    provenance.yaml        # who verified (role), how (社労士 / 税理士 / verified legacy system / official example),
                           # legal basis, date, review record id
```

- 入力は合成の人だけ。個人番号・口座・氏名は入れない（入力の文書にもともとない。[ADR-0026](../decisions/0026-payroll-run-stages-and-input-snapshot.md)）。
- `manifest.yaml` は、[ADR-0004](../decisions/0004-payroll-engine.md) の境界の一覧（雇用区分、扶養、年齢の境界 40・65・70・75 歳、保険者、等級の境界、乙欄、月の途中の入退社、休職、60 時間の境界、賞与、遡及）と、各領域の決定表の境界の行を、分類として持つ。CI は、すべての分類に 1 件以上の事例があることを確かめる。
- 公的な資料の計算の例（国税庁の使用例など）は、`provenance` に出典の URL と確認日を書いて事例にする（[ADR-0031](../decisions/0031-income-tax-withholding.md) の Confirmation）。

### 4.2 実行

- 各事例を、今のエンジンと、事例が指す規則表のバージョンで計算し、`expected.json` と項目ごとに比べる。許容の幅はない（1 円でも違えば失敗。[ADR-0029](../decisions/0029-parallel-run-and-compute-partitioning.md) の b を採らない理由と同じ）。
- 差の報告：事例、項目、期待値、実際の値、差。合成の人なので値を出してよい。
- 計算は純粋なので、並列に走らせる。数千件で数分を目標にする。

### 4.3 期待値の変更

- `expected.json` を変える PR は `golden:expected-change` のラベルが付き、QA の承認を要する。法令の解釈に関わるもの（端数、税・保険の扱い）は、`provenance.yaml` に社労士・税理士の確認の記録（確認した人の役割、日、記録の ID）を足す（[AGENTS.md](../../AGENTS.md)）。
- **期待値の変更と、エンジンのコードの変更を同じ PR に入れない。** 先に期待値を直す PR（CI は赤になる。QA の承認で、その事例だけを `pending_fix` の印で一時に外す）を出し、次にコードの PR で緑に戻す。`pending_fix` の事例は 5 営業日を超えて残せない。
- 事例を消す PR も QA の承認を要し、分類の網羅の検査を通らなければならない。

## 5. デプロイ

### 5.1 環境の昇格

```
main ─▶ dev（自動）─▶ staging（自動。E2E・スモーク・k6・合成の給与の実行）─▶ prod（Ops の承認）
保管庫：main ─▶ vault-staging ─▶ vault-prod（セキュリティの担当と Ops の責任者の承認。人事の側と別の日）
```

- prod のデプロイは平日の 10〜17 時。金曜の 15 時以降と年末年始は、修正以外のデプロイをしない。
- エラーバジェットを使い切っている間は、修正以外のデプロイをしない。
- **支給日の前の凍結**（[ADR-0063](../decisions/0063-payroll-flags-pinning-and-freeze-windows.md)）：本番の従業員の 20% 以上が 3 営業日以内に支給日を迎える日は、給与の経路（`payroll:calc`、振込ファイル、明細、Payroll Compute のイメージ、給与の DB のスキーマの contract）のデプロイをしない。修正は Ops の責任者と QA の承認で例外にできる。凍結の日は、支給日の予定から毎晩計算して暦に出す。

### 5.2 デプロイの順序

| 順 | 対象 | 方式 |
| --- | --- | --- |
| 1 | マイグレーション（expand） | 1 回だけ実行する ECS タスク（`migrator`） |
| 2 | relay、worker、loader、egress-worker、audit-archiver | ローリング |
| 3 | bp-worker | ローリング。タイマーの処理は冪等 |
| 4 | api | ECS の blue/green のカナリア（要求の 10% → 100%）。アラームで自動のロールバック |
| 5 | Payroll Compute のイメージ | ECR に置き、次に**入力を固定する**実行から使う。進行中の実行は、入力の固定のときに記録したダイジェストのまま（[ADR-0063](../decisions/0063-payroll-flags-pinning-and-freeze-windows.md)） |

- api の blue/green の自動のロールバックのアラームには、5xx の率に加えて、業務プロセスの完了の失敗の率、打刻の失敗の率、権限の拒否の急増を入れる。
- デプロイの直後に、合成の給与の実行（[observability.md](observability.md) の 3.5 節）を走らせる。不一致なら Payroll Compute のイメージの切り替えを戻す（次の実行から前のダイジェストを使う）。

## 6. 規則表のリリース（[ADR-0062](../decisions/0062-rule-table-release-calendar.md)）

### 6.1 流れ

```
改正の暦（6.2 節）で監視 ─▶ 公的な資料の公表を検知（週 1 回、元の頁の変化を見る）
   ▼
取り込み（rules.import）─▶ 独立の照合（rules.verify。別の人。ADR-0030）
   ▼
ゴールデンデータの事例を足す PR（新しい期間の事例。社労士・税理士の確認の記録）
   ▼
規則表のリリースの束（規則表の行、元のファイルの SHA-256、照合の記録）を作り、署名する
   ▼
staging に公開 ─▶ ゴールデンデータの全件（新しい事例を含む）と合成の給与の実行が一致
   ▼
prod に公開（rules.publish。Ops の承認。コードのデプロイとは別の操作）─▶ 直後に合成の給与の実行
```

- 規則表のリリースはコードのリリースと分ける。規則表は DB のデータ（テナントの外の共通の表）で、公開は状態を `published` にする 1 トランザクション。エンジンのコードは、規則表の新しい形（新しい列、新しい計算の式）が要るときだけ変える。その場合は、コードを先に（フラグなしで、古い規則表でも動く形で）デプロイし、規則表を後から公開する。
- 期限：適用の最初の支払日の **5 営業日前**までに `published`（[ADR-0030](../decisions/0030-rule-table-ingestion-and-verification.md) の Consequences）。

### 6.2 改正の暦

| 規則表 | 適用の鍵 | ふだんの改正の時期 | 監視の開始 |
| --- | --- | --- | --- |
| 源泉徴収税額表（月額表・日額表・賞与の算出率）、電算機特例 | 支払日の年 | 1 月の支払いから（税制の改正の年） | 前年の 10 月（公表の時期は未検証。E8 の `rule-table-release-pipeline` で国税庁の公表を週 1 回検知する） |
| 協会けんぽの健康保険・介護保険の料率 | 保険料の月分 | 3 月分から | 1 月 |
| 子ども・子育て支援金率 | 保険料の月分 | 4 月分から（令和 8 年度に開始） | 1 月 |
| 雇用保険の料率 | 賃金の締日（[ADR-0033](../decisions/0033-employment-insurance-and-resident-tax.md)） | 4 月 1 日から | 1 月 |
| 厚生年金の標準報酬月額の上限 | 保険料の月分 | 2027 年 9 月分から段階的に（[ADR-0032](../decisions/0032-social-insurance-premiums-and-standard-remuneration.md)） | 2027 年 3 月 |
| 健康保険の等級表 | 保険料の月分 | 改正のとき | 随時 |
| 健康保険組合の料率（テナントの表） | 保険料の月分 | 組合ごと（組合の案内による。テナントが組合の案内で確かめて入力する） | テナントに 1 月に案内する |
| 住民税の通知（テナントの表） | 6 月から | 毎年 5 月に取り込み | 5 月 |

- 暦の正本は Ops の runbook（`statutory-rate-calendar.md`。[payroll-jp-rules.md](payroll-jp-rules.md) の 16 節）。この表は、リリースの仕組みの前提として書く。
- 公開の遅れ（適用の 5 営業日前に `published` でない）は、2 営業日前で呼び出す（[observability.md](observability.md) の 5.2 節）。
- 公開の後に誤りが分かったら、訂正のバージョンを同じ流れで出し、遡及の候補を作る（[ADR-0030](../decisions/0030-rule-table-ingestion-and-verification.md)）。

## 7. リリースごとの概要書と操作説明書

- 電子帳簿保存法の要件に当たる「システムの概要書・操作説明書」（[audit-and-retention.md](audit-and-retention.md) の 7 節、[ADR-0050](../decisions/0050-electronic-books-act-readiness.md)）を、リリースごとに公開し、バージョンを残す。
- 概要書は、給与の計算と記録の流れ（入力の固定、計算、確定、仕訳、訂正の方法）、エンジンのバージョン、規則表のバージョンの一覧。変更がなければ前のバージョンを引き継ぐ。
- リリースのチェックリストに「概要書・操作説明書の更新の有無」を入れる。

## 8. フラグ（[ADR-0063](../decisions/0063-payroll-flags-pinning-and-freeze-windows.md)）

| 種類 | 例 | 誰が切り替えるか |
| --- | --- | --- |
| release | 新しい画面、新しい業務プロセスの種類 | PM（テナントのカナリア） |
| payroll | 新しい計算の方式、端数の新しい選択肢、給与の結果を変えうる振る舞い | PM と QA。テナントごとに、給与の期間の境目で |
| ops | 縮退（レポートの非同期の停止、一括の取り込みの停止、読み取りだけの状態 `ops.read_only_mode`、給与の確定の保留 `ops.payroll_finalize_hold`、給与・人事の担当の経路だけを受ける `ops.payroll_first`） | Ops（給与の確定の保留は IC） |
| permission | テナントごとの機能の有効化（契約） | 支援の担当 |

- **給与に効くフラグは、実行の入力の固定のときに値を記録し、その実行の最後まで固定する。** フラグの値は、実行の「設定のバージョン」（[ADR-0026](../decisions/0026-payroll-run-stages-and-input-snapshot.md)）に含め、結果の再現に使う。実行の途中でフラグを切り替えても、進行中の実行の結果は変わらない。
- 給与に効くフラグを、あるテナントで有効にする前に、そのテナントの直近の確定した期間を、フラグあり・なしで計算し直し（`parallel` の実行、確定しない）、差を給与の担当と QA が確かめる（影の比較）。差が説明できなければ有効にしない。
- テナントのカナリア：`hash(flag_name + tenant_id) mod 100`。社内の監視用のテナント → sandbox のテナント → 本番の 1% → 10% → 50% → 100%。給与に効くフラグは、各段で最低 1 回の支給を経る。
- ガード（フラグの有効なテナントと無効なテナントを比べ、差が続いたら AppConfig のアラームでフラグを自動で切る）：5xx の率、業務プロセスの完了の失敗、打刻の失敗、給与の確認の検査の警告の件数（1 人あたり）、合成の給与の実行の不一致（即時）。

## 9. ホットフィックス

- まずフラグで止め、修正は `main` への PR で入れる（forward fix）。フラグで止められず修正も間に合わないときは、1 つ前のイメージで再デプロイする。マイグレーションは戻さない。
- **給与の計算の誤りの修正**は、ゴールデンデータの事例を先に足し（誤りを再現する事例。期待値は社労士・税理士か公的な資料で確かめる）、修正の PR で緑にする。支給日の後の誤りの扱いは [runbooks/incident-response.md](../runbooks/incident-response.md) の「給与の計算の誤り」。
- 脆弱性の修正（[security.md](security.md) の 9 節の Critical）は、時間帯と凍結の制限を受けない。ただし 2 人の承認とゴールデンデータセットは省かない。

## 10. 指標

DORA の 4 指標（他の題材と同じ目標）に加えて、次を見る。

| 指標 | 目標 |
| --- | --- |
| ゴールデンデータセットの `main` での失敗 | 0 件 |
| `pending_fix` の事例が残った日数 | 5 営業日以内 |
| 期待値の変更のうち、確認の記録がないもの | 0 件 |
| 規則表の公開の遅れ（改正の暦に対して） | 0 件 |
| 凍結の期間の給与の経路のデプロイ（例外を除く） | 0 件 |
| `security:sensitive` の PR のうち、2 人の承認なしにマージされたもの | 0 件 |
| 給与に効くフラグの影の比較をせずに有効にした件数 | 0 件 |

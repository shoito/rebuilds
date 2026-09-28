# Architecture: Workday

全体像と横断的な方針。領域ごとの設計は、同じディレクトリに領域ごとのファイルとして置く。ファイルの一覧、持ち主、ADR の番号の範囲は 7 節にある。データモデルの正本は [data-model.md](data-model.md)、品質の戦略は [quality.md](../quality.md)、Epic と Story は [roadmap.md](../roadmap.md)、SLO と運用は [runbooks/](../runbooks/README.md) にある。

## 1. 全体構成

### 1.1 本家の構成（参考）

本家の公開の資料から分かることを、設計の参考として書く。実装は使わない（[リポジトリ共通の ADR-0007](../../../../docs/decisions/0007-no-reuse-of-original-implementation.md)）。出典は、どれも 2026-09-28 に確認した。

| 本家の考え方 | 内容 | このシステムでの扱い |
| --- | --- | --- |
| オブジェクトモデルとメタデータ | 業務の概念（Worker、Organization、Position など）をクラス・関係・属性・メソッドのメタデータとして定義し、実行時に解釈する。RDB（MySQL）は少数の汎用のテーブルで、Worker のようなテーブルはない（[ホワイトペーパー](https://www.workday.com/content/dam/web/en-us/documents/whitepapers/whitepaper_workday_technology_platform_devt_process.pdf)） | 採らない。型のある業務のテーブルを、有効日付の共通の型で作る（[ADR-0002](../decisions/0002-effective-dated-data-model.md)） |
| メモリーの中のデータ | テナントのデータとメタデータをメモリーに持ち、更新はテナントごとに 1 つの更新のサービス（OTS）が行う。DB が正本で、コミットの後に他のサービスへ変更の集合を配る。給与計算などの重い処理は別の計算のサービスで行う（同上） | 正本は Aurora。給与計算は別の計算の worker で、入力のスナップショットから行う（[ADR-0004](../decisions/0004-payroll-engine.md)） |
| 有効日付と追記 | DB は追記のみで、有効日付と時点のレポートに使う（[DBMS2, 2010](https://www.dbms2.com/2010/08/22/workday-technology-stack/)。古い第三者の記事で、現在の実装は未検証）。変更は有効日と入力日を分けて持ち、前後の値・変更者・時刻を監査の記録に残す（[Concept: Auditing](https://doc.workday.com/admin-guide/en-us/manage-workday/tenant-configuration/auditing/dan1370797846272.html)） | 有効時間と記録時間の 2 つの軸（bitemporal）で持つ（[ADR-0002](../decisions/0002-effective-dated-data-model.md)） |
| 業務プロセス | 起票・承認・アクション・サービス・通知・完了のステップ。条件の規則、委任、取消（rescind）・訂正（correct）・キャンセル（[Approval Step](https://doc.workday.com/admin-guide/en-us/manage-workday/business-processes/business-process-step-types/dan1370797855296.html)、[Delegation](https://doc.workday.com/admin-guide/en-us/manage-workday/business-processes/delegate-business-processes/cxi1568047444210.html)） | 自前の永続の状態機械にする（[ADR-0003](../decisions/0003-business-process-engine.md)） |
| 権限 | 機能の領域（ドメイン）ごとの権限と、業務プロセスごとの権限。セキュリティグループ（ユーザー、ロール、職務、組織、集約、交差）。ロールは組織で絞れる。権限の変更は「有効化」まで保留され、編集と有効化を別の人にできる（[Security](https://doc.workday.com/workday-education/en-us/course-manuals/financial-management-for-administrators/security.html)） | 同じ考え方の権限のモデルを自前で作る（[ADR-0005](../decisions/0005-security-and-my-number.md)） |
| 1 つのコードライン | 全顧客が 1 つの版を使う（[Defining the Power of One](https://blog.workday.com/en-us/posts/2015/06/defining-the-power-of-one.html)）。機能のリリースは年 2 回（おおむね 3 月と 9 月）、週ごとに修正と小さな改善の更新（[Workday のリリースの名前と予定の変更](https://blog.workday.com/en-us/2019/workday-changes-product-release-naming-convention-and-schedule.html)、[Release Best Practices](https://forms.workday.com/content/dam/web/sg/documents/other/release-best-practices-guide-en-sg.pdf)、2026-09-28 に検索の要約で確認） | 採る。テナントごとの分岐を持たず、違いは設定と規則表で表す |

### 1.2 コンテキスト

```
 従業員・マネージャー（ブラウザ、スマートフォンのブラウザ）   人事・給与の担当者、テナントの管理者、監査人
      │ セルフサービス、打刻、申請、承認、明細                          │ 人事の記録、業務プロセスの定義、給与計算、権限、レポート
      ▼                                                                 ▼
┌──────────────── 本システム（<tenant>.<brand>.<domain>）─────────────────────────────┐
│  Web・API・業務プロセス・勤怠・休暇・給与計算・マイナンバーの保管庫・レポート・連携    │
└───────────────────────────────────────────────────────────────────────────────┘
      ▲ SSO（SAML・OIDC）      ▲ 打刻の取り込み      │ 出力
      │                         │                    ▼
 企業の ID 基盤              打刻機             銀行（全銀協の形式のファイル。送信は企業が行う）
                                               会計システム（仕訳）
 現行の人事・給与のシステム ──（移行・並行稼働の取り込み）──▶
 後の Epic：e-Tax、eLTAX、e-Gov（電子申請）
```

### 1.3 コンテナ

```
        ┌──────────── CloudFront＋WAF（SPA の静的な資産は S3、レート制限）───┐
        └──────┬───────────────────────────────────────────────────────┘
               ▼
        ┌──────────────┐     ┌──────────────────────┐
        │ API（Hono）   │────▶│ 権限の判定（ライブラリ）│  すべての読み書きが通る
        │ Better Auth   │     └──────────────────────┘
        └──┬────────┬──┘
           │        │ 業務プロセスのコマンド
           │        ▼
           │   ┌────────────────┐   タイマー・ステップの実行
           │   │ BP Worker       │◀──────────────── SQS
           │   └───────┬────────┘
           ▼           ▼
   Aurora PostgreSQL（正本：有効日付のテーブルと履歴、業務プロセスの案件とイベント、勤怠、休暇、
                      給与の結果と仕訳、規則表、監査ログ。RLS）
           │ outbox                         ▲ 入力のスナップショット・結果の書き込み
           ▼                                │
       Relay ─▶ SQS ─▶ Worker（通知、帳票・明細の PDF、全銀ファイル、仕訳の出力、一括の取り込み・出力、レポートの出力）
                         Payroll Compute（ECS のタスク。給与計算を従業員の束ごとに並列に実行）

   ┌──────── 別の AWS アカウント ─────────┐
   │ Vault（マイナンバーの保管庫）          │◀── 参照の ID だけで呼ぶ（API は相互 TLS）
   │ 専用の Aurora、専用の KMS の鍵         │
   │ 法定の書類の生成は、この中で行う       │
   └───────────────────────────────────┘

   S3：明細・帳票の PDF、取り込みのファイル、監査ログの保管（Object Lock）
   Valkey：セッション、キャッシュ、レート制限（失われてもよい）
```

| コンテナ | 責務 |
| --- | --- |
| API | 画面（SPA）と外部の API、ログインと SSO（Better Auth）。コマンド（業務プロセスの起票・承認）と問い合わせ（時点を指定できる）。すべての要求で権限を判定する。画面はサーバーで描画しない（[ADR-0038](../decisions/0038-single-responsive-spa-and-offline-clock.md)） |
| BP Worker | 業務プロセスのステップの実行、タイマー（期限、督促、将来日付のイベントの発効）、通知の依頼（[ADR-0003](../decisions/0003-business-process-engine.md)） |
| Payroll Compute | 給与計算。入力のスナップショットと規則表の版から、純粋な計算で結果を作る。DB を直接は読まない（[ADR-0004](../decisions/0004-payroll-engine.md)） |
| Worker | 遅れてよい処理。ファイルの生成、一括の取り込み、レポートの出力 |
| Vault | 個人番号の保管、アクセスの記録、法定の書類の生成、削除（[ADR-0005](../decisions/0005-security-and-my-number.md)、[my-number-vault.md](my-number-vault.md)） |
| Aurora | 唯一の正本。テナントを RLS で分ける |
| Valkey | セッションとキャッシュ。失われてもよい |

原則は 5 つ。

- **すべてを有効日付で持つ。** 人事のデータは、有効時間と記録時間の 2 軸で持ち、上書きしない（[ADR-0002](../decisions/0002-effective-dated-data-model.md)）。
- **変更は業務プロセスを通す。** 承認・ルーティング・監査を 1 か所にまとめる（[ADR-0003](../decisions/0003-business-process-engine.md)）。
- **給与は純粋な計算にする。** 入力と規則表の版から決まり、再計算で同じ結果になる。お金は整数の円で扱う（[ADR-0004](../decisions/0004-payroll-engine.md)）。
- **権限は 1 つの仕組みで判定する。** 画面・API・レポート・連携・一括の出力で同じ判定を通す（[ADR-0005](../decisions/0005-security-and-my-number.md)）。
- **マイナンバーは隔離する。** 別のアカウント・DB・鍵に置き、人事の側には参照の ID だけを持つ（[ADR-0005](../decisions/0005-security-and-my-number.md)）。

## 2. 規模の段階

| 段階 | テナント（うち本番） | 従業員（合計） | 最大のテナント | 打刻のピーク | 給与計算の集中 | 構成 |
| --- | --- | --- | --- | --- | --- | --- |
| S1（MVP） | 600（300） | 100 万 | 3 万人 | 400 件/秒（始業の 15 分に 3 割が打刻） | 月末〜25 日支給の前の 5 日に、全テナントの 7 割 | 東京の 1 リージョン・3 AZ。Aurora の writer 1 台＋reader 2 台。大阪にウォームスタンバイ（Aurora Global Database）。Vault は別アカウントの小さな Aurora |
| S2 | 6,000（3,000） | 1,000 万 | 10 万人 | 4,000 件/秒 | 同上 | テナントのハッシュで Aurora のクラスタを分ける。大口のテナントを専用のクラスタへ。レポートを分析用の基盤（S3 の列指向）へ。Payroll Compute を大口のテナント向けに分割 |
| S3 | 2 万（1 万） | 3,000 万 | 30 万人 | 12,000 件/秒 | 同上 | セル構成。テナントをセルに固定し、東京・大阪の両方で受ける。大口のテナントに専用のセル |

- 数値は本システムの想定。本家の実数（テナント数、従業員数、計算の時間）は公開の資料で確かめられなかった（未検証）。
- 給与計算の負荷は、支給日の前に集中する。25 日支給の企業が多い前提（本システムの仮定。公開の統計を見つけられなかった。未検証。E12 の `load-test-suite` の前に、本番のテナントの支給日の分布で置き直す）で、S1 は 70 万人分を 5 日の中で計算・再計算する。
- 給与計算 1 人あたりの項目は 50〜200 を想定し、1 万人の計算で 200 万回ほどの計算の要素になる。
- 段階を上げる判断の基準は [infrastructure.md](infrastructure.md) の 8 節（[ADR-0056](../decisions/0056-stages-cluster-sharding-and-cells.md)）。

## 3. 非機能要件

| ID | 項目 | S1 の目標 | 備考 |
| --- | --- | --- | --- |
| NFR-001 | 給与計算の正しさ | ゴールデンデータセットで計算誤り 0 件。本番の切り替えの前に、現行のシステムとの並行稼働 3 か月（賞与の月を含む）で、説明のない差異 0 件 | [ADR-0004](../decisions/0004-payroll-engine.md)。期待値は社労士・税理士が確かめる |
| NFR-002 | 有効日付の一貫性 | 同じ主体・同じ項目の有効期間の重なり 0 件。任意の（有効日、記録日時）の問い合わせが、履歴からの再構成と一致する。確定した給与の入力のスナップショットが、同じ記録日時の問い合わせで再現できる | [ADR-0002](../decisions/0002-effective-dated-data-model.md)。性質ベーステストと夜間の検査 |
| NFR-003 | 給与計算の時間 | 1 万人の月次の計算が 15 分以内、3 万人（S1 の最大）が 45 分以内。1 人の再計算が 5 秒以内 | S2 は 10 万人で 60 分以内。E12 の負荷試験で確かめる |
| NFR-004 | 可用性 | セルフサービスと人事の画面・API 月間 99.9%。支給日の前の 5 営業日の給与計算・振込ファイルの生成 99.95% | 打刻は、落ちている間も端末に貯めて後で送れる形にする（[time-and-attendance.md](time-and-attendance.md) の 3.2 節）。SLO は [runbooks/README.md](../runbooks/README.md) の 1 節 |
| NFR-005 | 応答の時間 | 画面の操作 p95 500ms、p99 1.5 秒以内。打刻 p99 300ms 以内。時点を指定した 1 人の問い合わせ p99 300ms 以内 | 一覧・レポートの出力を除く |
| NFR-006 | 耐久性と障害 | AZ の障害：RPO 0、RTO 15 分以内。リージョンの障害：RPO 5 分以内、RTO 4 時間以内。支給日の前の 5 営業日にリージョンが落ちても、振込ファイルを当日中に出せる | 振込の締め切りは銀行ごとに違う（未検証。支払元の口座の設定 `lead_business_days` で持ち、値は E10 の `zengin-file-generation` の前にテナントの銀行の仕様書で確かめる） |
| NFR-007 | マイナンバーの保護 | 個人番号の平文が保管庫の外に出た件数 0 件。保管庫へのアクセスの記録の欠け 0 件。保存期間を過ぎた番号の削除の遅れ 30 日以内 | [ADR-0005](../decisions/0005-security-and-my-number.md) |
| NFR-008 | 個人情報の保護 | 権限のない利用者に、給与・口座・健康・扶養の情報が見えた事象 0 件。ログ・トレースに個人情報が出た件数 0 件 | [ADR-0005](../decisions/0005-security-and-my-number.md) |
| NFR-009 | テナントの分離 | 他のテナントのデータが見える事象 0 件 | [ADR-0005](../decisions/0005-security-and-my-number.md) |
| NFR-010 | 監査 | 人事・給与・権限のすべての変更に、変更者・時刻・前後の値・業務プロセスの案件が残る。監査ログの改ざんを検知できる。保存期間は法令の最長に合わせる | 保存期間は法務・税理士の確認待ち（[intent.md](../intent.md) の L5） |

## 4. 技術スタック

| 層 | 選定 | 理由 |
| --- | --- | --- |
| 言語 | TypeScript（サービス、Web、給与計算のエンジン） | 他の題材と同じ。給与計算も同じ言語にする（[ADR-0001](../decisions/0001-platform-and-stack.md)） |
| お金と数 | `packages/money`：円は `bigint`、率と途中の値は `bigint` の固定小数点。名前付きの丸め | [ADR-0001](../decisions/0001-platform-and-stack.md)、[ADR-0004](../decisions/0004-payroll-engine.md) |
| HTTP・検証 | Hono＋Zod。`@hono/zod-openapi` で OpenAPI を出す | 他の題材と同じ |
| Web | React の SPA（Vite）。1 つのレスポンシブなアプリで、サーバーでの描画（SSR）は使わない。打刻の画面だけ Service Worker と IndexedDB でオフラインに耐える | [ADR-0038](../decisions/0038-single-responsive-spa-and-offline-clock.md)。明細は保存した文書を画面で描き、PDF は確定のときに決定的に作るので SSR は要らない（[ADR-0036](../decisions/0036-payslips-wage-ledger-and-e-delivery-consent.md)） |
| DB | Aurora PostgreSQL 18、RLS、ID は UUIDv7。有効日付は範囲型と、PostgreSQL 18 の時間の制約（`WITHOUT OVERLAPS`、`PERIOD` の外部キー） | [ADR-0002](../decisions/0002-effective-dated-data-model.md) |
| 業務プロセス | 自前の状態機械（Aurora の案件とイベントのテーブル、SQS でステップを実行） | [ADR-0003](../decisions/0003-business-process-engine.md) |
| 給与計算 | 自前のエンジン（純粋関数）。ECS のタスクで並列に実行 | [ADR-0004](../decisions/0004-payroll-engine.md) |
| キャッシュ | ElastiCache（Valkey） | 失われてもよい |
| 非同期 | transactional outbox → SQS | 他の題材と同じ |
| 鍵 | KMS（テナントのデータの鍵、口座などの項目の暗号化、Vault の専用の鍵） | [ADR-0005](../decisions/0005-security-and-my-number.md) |
| 帳票 | PDF は汎用のライブラリで座標を指定して描く（HTML の変換は使わない）。ライブラリは E10 の PoC で選ぶ | 明細、賃金台帳（[ADR-0036](../decisions/0036-payslips-wage-ledger-and-e-delivery-consent.md)） |
| 実行基盤 | AWS（東京、DR は大阪）、ECS Fargate | 他の題材と同じ |
| IaC | Terraform | 他の題材と同じ |
| 可観測性 | OpenTelemetry（ADOT）→ AMP、X-Ray、CloudWatch Logs | 他の題材と同じ。個人情報を出さない計装 |
| フラグ | AWS AppConfig | 他の題材と同じ |
| テスト | Vitest、fast-check、Testcontainers、Playwright。ゴールデンデータセットの比較の道具（自前） | [ADR-0004](../decisions/0004-payroll-engine.md) |

## 5. 主な決定

どれも `accepted`。基盤の 0001〜0005 と intent.md は、統合の工程の直しを当てたうえで `accepted` のままにした（6 節の「決定（2026-09-28、既定案）」）。状態の一覧は [decisions/README.md](../decisions/README.md)。

| ADR | 決定 |
| --- | --- |
| [0001](../decisions/0001-platform-and-stack.md) | 共通の基盤を引き継ぎ、給与計算も TypeScript で書く。お金は整数の円と固定小数点で扱う |
| [0002](../decisions/0002-effective-dated-data-model.md) | 人事のデータを有効時間と記録時間の 2 軸で持ち、変更の差分を有効日の順に畳み込む |
| [0003](../decisions/0003-business-process-engine.md) | 業務プロセスを、版つきの定義と Aurora に永続する状態機械で自前に作る |
| [0004](../decisions/0004-payroll-engine.md) | 給与計算を、入力のスナップショットと規則表の版から決まる純粋な計算にする |
| [0005](../decisions/0005-security-and-my-number.md) | ドメインと業務プロセスの権限と職務分掌で守り、マイナンバーは別アカウントの保管庫に置く |
| [0006](../decisions/0006-temporal-table-triplet-and-fold.md) | facet ごとの 3 つのテーブルを宣言から生成し、同じ日の差分の順序を事象の種類で決める |
| [0007](../decisions/0007-change-correction-rescind-semantics.md) | 変更・訂正・取消を差分の種類で区別し、取消は依存の決定表で拒む |
| [0008](../decisions/0008-point-in-time-queries-and-activation-timers.md) | 時点の問い合わせの `known_at` を安定の境界より前に限り、将来日付の副作用は発効の予定の表で行う |
| [0009](../decisions/0009-temporal-reference-model-testing.md) | 有効日付の実装を、純粋な参照のモデルとのモデルベーステストで確かめる |
| [0010](../decisions/0010-person-employment-job-assignment-model.md) | 人・雇用・職務の割り当ての 3 層で持ち、人員の枠をポジションに一本化する |
| [0011](../decisions/0011-effective-dated-org-hierarchy-closure.md) | 組織の階層を有効日付の親子の辺と、日付の範囲つきの閉包テーブルで持つ |
| [0012](../decisions/0012-worker-lifecycle-events-and-legal-checks.md) | 入社・異動・休職・退職を雇用の状態の差分として書き、法令の検査は警告と理由の記録にする |
| [0013](../decisions/0013-bp-definition-format-and-versions.md) | 業務プロセスの定義を JSON の宣言と型のある式の木で書き、起票の日に有効な版に案件を固定する |
| [0014](../decisions/0014-bp-routing-and-delegation.md) | 担当を組織のロールと閉包で決めて起票者と本人を除き、委任は期間中の未完了のタスクにも効かせる |
| [0015](../decisions/0015-bp-deadlines-reminders-and-inbox.md) | 期限を営業日で決めて表のタイマーで督促し、受信箱は担当の射影に委任を読むときに結ぶ |
| [0016](../decisions/0016-bp-definition-validation-and-activation.md) | 業務プロセスの定義を静的な検査と模擬の実行で確かめ、編集と有効化を別の人に分ける |
| [0017](../decisions/0017-authorization-evaluator.md) | 権限の判定を自前の評価器で行い、利用者ごとの権限の表と、閉包を使う SQL の条件で絞る |
| [0018](../decisions/0018-security-policy-versions-and-activation.md) | 権限の方針を版で持って別の人が有効化し、所属とロールの変更は業務プロセスで効かせる |
| [0019](../decisions/0019-segregation-of-duties-checks.md) | 職務分掌を範囲つきの規則表で持ち、有効化・所属の変更・案件の操作・夜間の走査の 4 か所で検査する |
| [0020](../decisions/0020-sensitive-read-audit-and-access-explanations.md) | 機微なドメインの閲覧を記録し、判定に理由を付けて説明の報告を出し、本番の代理のログインを読み取りに限る |
| [0021](../decisions/0021-clock-events-corrections-and-objective-records.md) | 打刻を端末が採番した追記のみの事象にし、訂正は記録の追加で行い、客観的な記録との乖離は検知だけする |
| [0022](../decisions/0022-work-schedules-and-work-hour-calculation.md) | 勤務体系を種類と印に分け、労働時間を分の整数で日・週・期間の順に区分する純粋な関数で計算する |
| [0023](../decisions/0023-overtime-agreement-monitoring-and-monthly-close.md) | 36 協定を事業所ごとの設定で持ち、実績と見込みで段階的に警告し、月次の締めは集計の版を給与に渡す |
| [0024](../decisions/0024-annual-leave-grant-ledger.md) | 年休を付与と追記のみの台帳で持ち、斉一的付与は法定を下回らない検査を通した設定だけを受ける |
| [0025](../decisions/0025-special-leave-and-leave-of-absence-boundary.md) | 休職は core-hr の雇用の状態が持ち、休暇の領域は日・半日・時間の単位の休暇と特別休暇を持つ |
| [0026](../decisions/0026-payroll-run-stages-and-input-snapshot.md) | 給与の実行を状態機械にし、入力を RFC 8785 の正規の形と SHA-256 で固定して内容のアドレスで置く |
| [0027](../decisions/0027-pay-item-graph-and-formula-language.md) | 項目を段つきの依存のグラフにし、テナントの式は円・10 進・分の型を分けた式の木で書く |
| [0028](../decisions/0028-retro-deltas-and-bonus-runs.md) | 遡及は確定した期間の計算し直しとの差を当期の行にし、エンジンの違いによる差は止め、賞与は前月の確定を前提にする |
| [0029](../decisions/0029-parallel-run-and-compute-partitioning.md) | 計算を決まった束ごとに ECS のタスクで行い、並行稼働は許容の幅なしで差を分類して切り替えを判定する |
| [0030](../decisions/0030-rule-table-ingestion-and-verification.md) | 規則表を適用の鍵つきの版で持ち、元のファイルのハッシュと 2 人の独立の照合を経て公開する |
| [0031](../decisions/0031-income-tax-withholding.md) | 源泉所得税の欄と表を決定表で選び、甲欄の月額表は表引きと電算機特例を会社の設定で選ぶ |
| [0032](../decisions/0032-social-insurance-premiums-and-standard-remuneration.md) | 社会保険料は健康保険の側と厚生年金をそれぞれ 1 回だけ丸め、控除の月は前月分を既定にし、等級の改定は候補だけを示す |
| [0033](../decisions/0033-employment-insurance-and-resident-tax.md) | 雇用保険料は締日で料率を選んで 50 銭以下切り捨てにし、住民税は通知の月割額をそのまま使う |
| [0034](../decisions/0034-overtime-premiums-and-proration.md) | 割増賃金は法定の最低の倍率を下限にし、端数の処理は通達の形の中からテナントが選び、欠勤控除は切り捨てる |
| [0035](../decisions/0035-bank-transfer-files.md) | 振込は支払の指示から決定的に作る全銀協の形式のファイルにし、承認はファイルのハッシュに結ぶ |
| [0036](../decisions/0036-payslips-wage-ledger-and-e-delivery-consent.md) | 明細は確定の結果から作る変わらない文書にし、電子交付は承諾の台帳で持ち、賃金台帳は射影にする |
| [0037](../decisions/0037-payroll-journal-export.md) | 給与の仕訳を実行の段ごとに釣り合う追記のみの記録にし、部門と勘定に集計して連番の束で出力する |
| [0038](../decisions/0038-single-responsive-spa-and-offline-clock.md) | 画面を 1 つのレスポンシブな SPA にし、打刻の画面だけをオフラインの待ち行列で持つ |
| [0039](../decisions/0039-effective-dated-views-and-change-requests.md) | 画面は時点を URL に持ち、将来の変更と保留中の案件を重ねて示し、変更の申請は有効日を必須にする |
| [0040](../decisions/0040-declarative-reports-and-analytics-store.md) | レポートを宣言の定義で持ち、同じ権限の判定を通して時点を固定して実行し、S2 は S3 の Iceberg と Athena に移す |
| [0041](../decisions/0041-small-cell-suppression-for-sensitive-aggregates.md) | 機微な値の集計は、個々の値を見る権限のない利用者に対して 5 人未満の区分を伏せ、2 次の抑止と繰り返しの検知をかける |
| [0042](../decisions/0042-bulk-import-through-business-processes.md) | 一括の取り込みは全行を検証してから行ごとの子の案件で流し、同じ主体の行は有効日の順に直列にする |
| [0043](../decisions/0043-migration-history-and-parallel-run-inputs.md) | 移行は履歴を「移行」の差分として取り込み、本番の開始日より前に遡及を出さず、並行稼働は現行の入力も取り込めるようにする |
| [0044](../decisions/0044-sso-api-clients-and-clock-terminals.md) | ログインと SSO は Better Auth で持って本システムは SP・RP だけになり、API の利用者と打刻機は専用の資格情報で同じ権限の判定を通す |
| [0045](../decisions/0045-my-number-collection-and-identity-verification.md) | マイナンバーの入力と本人確認は保管庫が配る画面で受け、方法と確認した人を記録する |
| [0046](../decisions/0046-purpose-bound-vault-api-and-access-log.md) | 保管庫の API は操作者の主張と保管庫の担当者の表で目的ごとに判定し、平文を外に返さず、記録を番号なしのハッシュの連鎖で残す |
| [0047](../decisions/0047-my-number-retention-and-deletion.md) | 番号の本体は最後の法定の事務まで、書類は種類ごとの保存の期間まで持ち、日次の候補から事務取扱担当者の確認で 30 日以内に消す |
| [0048](../decisions/0048-audit-log-hash-chain-and-anchoring.md) | 監査ログを同じトランザクションで追記し、安定の境界の後にテナントごとの連鎖のセグメントにして Object Lock に置き、日ごとに署名する |
| [0049](../decisions/0049-retention-rules-table-and-legal-hold.md) | 保存の期間を確認の状態つきの規則表で持ち、確認待ちの間は長いほうで動かし、保全を優先して専用のロールで消す |
| [0050](../decisions/0050-electronic-books-act-readiness.md) | 電子帳簿保存法の対象になりうる給与の記録に、最低限の要件と優良な電子帳簿に相当する機能を持たせ、当てはめはテナントと税理士に委ねる |
| [0051](../decisions/0051-threat-model-and-pii-classification.md) | 個人情報を 5 つの区分に分けて列ごとに宣言し、脅威は部品ごとの STRIDE の表と拒否の側のテストで持つ |
| [0052](../decisions/0052-kms-key-hierarchy.md) | KMS の鍵を用途とアカウントで分け、テナントの物体はテナントごとの鍵で守り、保管庫・振込ファイル・署名には専用の鍵を置く |
| [0053](../decisions/0053-operator-access-and-vault-break-glass.md) | 運用者は本番のデータに常設の権限を持たず、テナントのデータの参照はテナントの許可で行い、保管庫の番号を復号できる人のロールは作らない |
| [0054](../decisions/0054-accounts-network-and-vault-boundary.md) | 保管庫を別の OU のアカウントに置き、人事の側とは PrivateLink の片方向の経路だけでつなぎ、Payroll Compute は DB に経路のないサブネットに置く |
| [0055](../decisions/0055-disaster-recovery-and-payday-continuity.md) | 大阪にウォームスタンバイを持ち、切り替えは支払の経路を先に戻し、支給日の前は大阪で振込ファイルを作り直してハッシュの一致を毎日確かめる |
| [0056](../decisions/0056-stages-cluster-sharding-and-cells.md) | S1 は 1 つの Aurora のクラスタ、S2 はテナントの対応表でクラスタを分け、S3 は保管庫を含むセルにする |
| [0057](../decisions/0057-vault-delivery-separation.md) | 保管庫の Terraform の状態・デプロイのパイプライン・承認者・デプロイの日を人事の側と分ける |
| [0058](../decisions/0058-pii-free-telemetry.md) | 個人情報を出さない計装を型・Collector・URL の規則・走査の 4 層で守り、保管庫のテレメトリーは保管庫のアカウントに閉じる |
| [0059](../decisions/0059-payroll-run-slo-and-synthetic-run.md) | 給与の実行を支給日から逆算した里程標の遅れで監視し、本番の監視用のテナントで合成の給与を毎日計算して期待値と比べる |
| [0060](../decisions/0060-scheduled-peak-capacity.md) | 前もって分かる集中は暦と予定から先に広げ、給与計算とレポートにテナントの同時の上限と支給日の近さの優先を置く |
| [0061](../decisions/0061-golden-dataset-ci.md) | ゴールデンデータセットを事例ごとの入力・規則表の版・期待値・確認の出所で持ち、分類の網羅を検査し、期待値の変更とコードの変更を別の PR にする |
| [0062](../decisions/0062-rule-table-release-calendar.md) | 規則表を署名した束でコードと別に出し、改正の暦で監視して適用の 5 営業日前までに公開する |
| [0063](../decisions/0063-payroll-flags-pinning-and-freeze-windows.md) | 給与に効くフラグとエンジンのイメージを実行ごとに固定し、テナントには影の比較の後に期間の境目で広げ、支給日の前は給与の経路のデプロイを凍結する |

領域ごとの ADR は、7 節の番号の範囲で起票する。リポジトリ共通の決定（開発プロセス、本家の名前を使わない [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)、本家の実装を使わない [ADR-0007](../../../../docs/decisions/0007-no-reuse-of-original-implementation.md)）は、ルートの [docs/decisions/](../../../../docs/decisions/README.md) にある。

## 6. リスクと未解決事項

品質の面のリスクの順位と対策は [quality.md](../quality.md) の 1 節にある。ここは設計の面のリスクを書く。

- **給与の計算の誤り**：1 円の誤りでも、従業員の信頼と、税・保険の届出の誤りにつながる。しかもエラーにならない。純粋な計算と入力のスナップショット（[ADR-0004](../decisions/0004-payroll-engine.md)、[ADR-0026](../decisions/0026-payroll-run-stages-and-input-snapshot.md)）、ゴールデンデータセットの CI（[ADR-0061](../decisions/0061-golden-dataset-ci.md)）、決定表の表駆動テスト、並行稼働（[ADR-0029](../decisions/0029-parallel-run-and-compute-partitioning.md)）、夜間の再現の抜き取りと毎日の合成の給与の実行（[ADR-0059](../decisions/0059-payroll-run-slo-and-synthetic-run.md)）、社労士・税理士の確認で抑える。
- **法令と料率の改正の追従**：改正の時期が項目ごとに違い（1 月、3 月分、4 月分、4 月、9 月分、2027 年 9 月からの厚生年金の上限）、公表から適用までが短いものがある。規則表をコードと別の署名した束で出し、改正の暦で監視して、適用の 5 営業日前までに公開する（[ADR-0030](../decisions/0030-rule-table-ingestion-and-verification.md)、[ADR-0062](../decisions/0062-rule-table-release-calendar.md)）。取り込みと照合は別の人（[security-model.md](security-model.md) の S8）。
- **有効日付の複雑さ**：将来日付の変更の後に、それより前の日付の変更や訂正が入ると、期間の分割と、後の変更への影響が難しい。差分の畳み込み、同じ日の順序の `seq`、取消の依存の決定表、参照のモデルとのモデルベーステストで確かめる（[ADR-0006](../decisions/0006-temporal-table-triplet-and-fold.md)〜[ADR-0009](../decisions/0009-temporal-reference-model-testing.md)）。PostgreSQL 18 の時間の制約を Aurora で使えるかは E1 の PoC で確かめる。
- **遡及の連鎖**：過去の訂正が、確定した給与・社会保険の等級・年休の付与に波及する。遡及は差額の行にし、窓は 24 か月（権限で 36 か月）、エンジンの違いによる差は `ENGINE_DRIFT` で止める（[ADR-0028](../decisions/0028-retro-deltas-and-bonus-runs.md)）。自動では直さず担当者に示す。
- **業務プロセスの定義の誤り**：テナントの設定の誤りで、承認者がいない、職務分掌が崩れる。静的な検査・模擬の実行・編集と有効化の分離で抑える（[ADR-0016](../decisions/0016-bp-definition-validation-and-activation.md)）。
- **権限の漏れ**：画面・API・レポート・一括の出力のどれか 1 つの経路で判定が抜けると、給与や口座が見える。判定を `packages/authz` の 1 か所にまとめ（[ADR-0017](../decisions/0017-authorization-evaluator.md)）、経路の一致を性質ベーステストと本番の抜き取りで確かめる。集計からの推測は少人数の抑止で防ぐ（[ADR-0041](../decisions/0041-small-cell-suppression-for-sensitive-aggregates.md)）。
- **マイナンバーの漏えい**：法令の罰則と信頼の失墜。別のアカウントの保管庫、目的に縛った API、番号を含まない記録の連鎖、人のロールに復号を与えないこと（[ADR-0045](../decisions/0045-my-number-collection-and-identity-verification.md)〜[ADR-0047](../decisions/0047-my-number-retention-and-deletion.md)、[ADR-0053](../decisions/0053-operator-access-and-vault-break-glass.md)）と、ログの走査（[ADR-0058](../decisions/0058-pii-free-telemetry.md)）で抑える。
- **支給日の前の集中と変更**：多くのテナントが同じ数日に計算・再計算する。予定のスケールとテナントごとの同時の上限（[ADR-0060](../decisions/0060-scheduled-peak-capacity.md)）、支給日の前の給与の経路のデプロイの凍結（[ADR-0063](../decisions/0063-payroll-flags-pinning-and-freeze-windows.md)）で抑える。
- **支給日のリージョンの障害**：振込ファイルを出せないと、賃金の支払いが遅れる。大阪で振込ファイルを作り直してハッシュが一致することを毎日確かめ、支払の経路を先に戻す（[ADR-0055](../decisions/0055-disaster-recovery-and-payday-continuity.md)）。
- **現行のシステムからの移行**：履歴（過去の所属・給与・年休の残日数・社会保険の等級）が欠けると、有効日付と遡及の前提が崩れる。移行の差分と期首の値の台帳、sandbox での試し、`go_live_on` より前に遡及を出さない規則で扱う（[ADR-0043](../decisions/0043-migration-history-and-parallel-run-inputs.md)）。
- **法令の解釈**：確認待ちの事項が 58 ある（[intent.md](../intent.md) の L1〜L58）。結論が出るまで、そこに挙げた Story の spec を承認しない。

### 決定（2026-09-28、既定案）

PM の方針（「判断が要るところは推奨の既定案でよい」）により、統合の工程で次のとおり決めた。法務・社労士・税理士の判断が要るものは決めず、[intent.md](../intent.md) の「法務・社労士・税理士の確認待ち」に残した。ADR を直したものには、日付付きの注記を残した（[process.md](../../../../docs/process.md) の 9 節）。

- **ADR と intent の状態**：基盤の ADR（0001〜0005）と intent.md は、他の題材と同じく `accepted`（確かめた）。先に次を直した。
  - ADR-0001：`Dec` の桁を、[ADR-0027](../decisions/0027-pay-item-graph-and-formula-language.md) の小数 10 桁に揃えた（注記）。
  - ADR-0005：個人情報保護委員会のガイドラインを、令和 7 年 6 月の一部改正の版に直した（注記）。職務分掌の例の表の正本が [security-model.md](security-model.md) の 5.1 節であることと、ドメインの名前の対応を書いた（注記）。
  - ADR-0041：`aggregate` の操作を足すと決めたことを書いた（注記）。
- **intent.md**：年次有給休暇管理簿の保存を「施行規則 24 条の 7 で 5 年、附則 71 条で当分の間 3 年」に直した（L5）。厚生労働省の年 5 日の解説の URL を新しいもの（001140963.pdf）に直した。各領域が提案した確認待ち（L-HR・L-TA・L-ABS・L-PAY・L-JP・L-PMT・L-INT・L-MN・L-AUD・L-SEC）を、L12〜L58 の 1 つの通し番号に振り直して載せた（L-PMT-2 は L4 と同じなので L4 にまとめた）。各領域の文書と ADR の参照も新しい番号に直した。どれも確認待ちのまま。「選定・計測で決めるもの」のうち、領域の文書で決めたもの（源泉の方式、雇用保険の料率の区切り、健康保険組合の料率の持ち方）に「決定」を付けた。厚生年金の上限の引き上げの出典（厚生労働省）を参考に足した。
- **技術スタック**：画面にサーバーでの描画（SSR）は要らない。明細は保存した文書を画面で描き、PDF は確定のときに決定的に作る（4 節、[ADR-0036](../decisions/0036-payslips-wage-ledger-and-e-delivery-consent.md)、[ADR-0038](../decisions/0038-single-responsive-spa-and-offline-clock.md)）。
- **休職の持ち主**：休職・復職は core-hr の `employment_status` と `leave_start`・`leave_return` が持ち、休暇の領域は読むだけ（[ADR-0025](../decisions/0025-special-leave-and-leave-of-absence-boundary.md)）。7 節の表と [core-hr.md](core-hr.md) の持ち越しを直した。
- **データモデル**（[data-model.md](data-model.md) の 6 節）：休職の種類を `leave_of_absence_types` に改名（DM-1）。`pay_items` のシステムの行は同じ表で、RLS の部分の例外として 3 節の表に載せた（DM-2）。Better Auth の表はテナントの外に置き、理由と補う統制を書いた（DM-3）。住民税の通知・並行稼働の表の保存の期間を決めた（DM-4）。退職者の閲覧は、機微でないドメインは保存の期間（既定 5 年）の間、機微なドメインは退職から 3 年まで組織の範囲で見られる（DM-5）。口座の HMAC を `worker_payment_election` に足した（DM-6）。
- **データモデルを正本にした**（[data-model.md](data-model.md) と [data-model/](data-model/temporal.md)。6 節の DM-8〜DM-17）：facet の 3 つの表の列の名前を `subject_id`・`case_id` に揃えた（DM-8。ADR-0002 に注記）。人の中の複数の主体・職務・等級の主体の表を置いた（DM-9）。`mn_ref`・`mn_status` を facet から有効日付でない `mn_links` に移し（DM-10）、保管庫の状態は人事の側が引き取る形にした（DM-17）。時間を持つ表を 5 つの形に分け、`overtime_agreements` は期間つきの行にした（DM-11）。人事の側の HMAC の鍵を `tenant_keys` に置いた（DM-12）。全文検索の製品を置かない（DM-13）。定義のなかった表を最小の形で足した（DM-14）。給与の結果のパーティションの鍵を `pay_date` にした（DM-15）。採用・福利厚生の加入などは表を作らない（DM-16）。
- **業務プロセスの種類**：各領域が足した種類（`time_correction`、`time_period_reopen`、`overtime_agreement_change`、`annual_leave_designation`、`special_leave_grant`、`leave_balance_adjustment`、`leave_policy_change`、`pay_item_change`、`si_grade_change`、`bonus_entry` など）と、`payroll.retro_override` の権限を、[business-process-engine.md](business-process-engine.md) の 3.1 節に集めた。
- **権限**（[security-model.md](security-model.md)）：規則表の運用者の権限 `rules.import`・`rules.verify`・`rules.publish` と、取り込みと照合を分ける職務分掌の規則 S8 を足した。集計だけの操作 `aggregate` を足し、必ず少人数の抑止を通す。`security.admin` のドメインを一覧に足した。
- **支給日の前の口座の変更**：[security.md](security.md) の THR-020 の提案を採り、給与の確認の検査に「支給日の 10 営業日前より後の振込先の変更」の警告を足した（[payroll-engine.md](payroll-engine.md) の DT-PAY-004 の #10）。
- **runbook の名前**：`clock-offline-backlog` は `clock-ingest-backlog` に、`bulk-import-partial-failure` は `bp-partial-bulk` にまとめた。`payday-dr-bank-file` は作らず、[runbooks/disaster-recovery.md](../runbooks/disaster-recovery.md) の「E. 支給日の DR」を使う（[runbooks/README.md](../runbooks/README.md) の 4 節）。
- **Story の名前**：`terminal-import` は `clock-terminal-integration` に、`inbox-ui` は `ui-inbox` に、`worker-register-report`・`attendance-register-report` は `statutory-registers` に、`authz-pentest` は `pentest-and-fixes` に、打刻・給与・業務プロセスの負荷試験は `load-test-suite` にまとめた（[roadmap.md](../roadmap.md)）。
- **Epic**：E1〜E12 が MVP。E13 年末調整と法定調書、E14 電子申請、E15 退職所得と退職金、E16 タレント管理。それ以外の MVP の後の機能は [roadmap.md](../roadmap.md) の延期の一覧。E13 の ADR は 0064〜0066 を使う（7 節）。
- **数値の正本**：SLO とアラートは [runbooks/README.md](../runbooks/README.md) の 1・4 節（[observability.md](observability.md) は計測の側）。容量のパラメーターは [capacity.md](capacity.md) の 5 節、台数と費用は [infrastructure.md](infrastructure.md) の 5・11 節、保存の期間は [audit-and-retention.md](audit-and-retention.md) の 5.2 節、上限は各領域の文書（例：[object-model-and-effective-dating.md](object-model-and-effective-dating.md) の 3.1 節、[core-hr.md](core-hr.md) の 3.4 節）。
- **KMS のテナントの鍵の単位**：S1 は 1 テナント 1 本。S2 からはセルごとに 1 本の鍵で、暗号の文脈に `tenant_id` を入れ、テナントの DEK を包んで分ける。解約の暗号の消去はテナントの DEK の破棄で行う。専用の鍵は有料の選択肢として残す。S3 の鍵の費用は月 4 万 USD 程度から数十 USD（と選択肢の分）に下がる（[ADR-0052](../decisions/0052-kms-key-hierarchy.md) の 2026-09-28 の注記、[security.md](security.md) の 5.3 節）。
- **文書の間の参照**：領域の文書を書いた時点でまだなかった文書を、コードの書式（[payroll-engine.md](payroll-engine.md) など）で書いていたところを、リンクに直した。

持ち越し（計測・PoC・選定で決めるもの）：

| 項目 | いつ・どう決めるか |
| --- | --- |
| PostgreSQL 18 の時間の制約（`WITHOUT OVERLAPS`、`PERIOD`）を Aurora で使ったときの RLS・`btree_gist` との組み合わせと性能。有効日付の書き込みを関数だけに限る方式（Aurora PostgreSQL は 18.3 が 2026-06-11 に出て、2026-09-28 の時点の最新は 18.4.2。[Aurora PostgreSQL の更新](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraPostgreSQLReleaseNotes/AuroraPostgreSQL.Updates.html)、2026-09-28 に確認。構文は [PostgreSQL 18 の CREATE TABLE](https://www.postgresql.org/docs/18/sql-createtable.html) で確かめた） | E1 の `temporal-constraints-poc`。使えなければ `EXCLUDE USING gist` で代える（[ADR-0002](../decisions/0002-effective-dated-data-model.md)） |
| Payroll Compute のタスクの数と、従業員の束の大きさ、入力の固定の並列の度合い | E12 の負荷試験（[capacity.md](capacity.md) の 7 節） |
| PDF のライブラリ | E10 の `payslip-pdf` の PoC |
| 監査の連鎖の単位（1 分か 1 時間か）と、`bp_events`・差分を本体ごと連鎖にするか | E11 で量を測って（[audit-and-retention.md](audit-and-retention.md) の 13 節） |
| 一次の資料で確かめられなかった値（子ども・子育て支援金の丸めの Q&A の原本、雇用保険の料率の適用の区切り） | E8 の `social-insurance-premiums`・`employment-insurance` の spec の前に、L32・L37 の確認で（[payroll-jp-rules.md](payroll-jp-rules.md) の 15 節）。他の値（等級表、介護保険の到達の月、標準賞与額の上限、通勤手当の非課税の限度、祝日の取り込みの元、拠出金の率）は 2026-09-28 に確かめた |
| 打刻機の機種と形式、銀行ごとの振込の締め切り | E6・E10 の着手の前 |
| 分析用の基盤のアカウント | S2 の前 |
| 費用の単価 | E12 の前に、AWS の料金の計算ツールで置き換える |
| 本家の振る舞いで未確認のもの（委任と進行中のタスク、代理のログインの条件。リリースの周期は 2026-09-28 に 1 節で確かめた） | 各領域の文書で、本家の資料で確かめる。設計は本家に依らない |

## 7. 領域の文書

持ち主は、どれも Dev が書き、「レビュー」の列のロールが確認する。ADR は下の範囲の中で採番する（範囲の外に出るときは、この表を先に更新する）。

| ファイル | 範囲 | ADR | レビュー | 関わる Epic |
| --- | --- | --- | --- | --- |
| [object-model-and-effective-dating.md](object-model-and-effective-dating.md) | 有効日付の共通の型（`packages/temporal`）、差分・版・現在の 3 つのテーブル、同じ日の順序、変更・訂正・取消、時点の問い合わせ、発効のタイマー、参照のモデル | 0006〜0009 | QA | E1、E2、E3 |
| [core-hr.md](core-hr.md) | 人・雇用・職務の割り当て、ポジションと職務、組織と階層の閉包、入社・異動・休職・復職・退職の事象と法令の警告、個人の情報、外部の人、組織の再編 | 0010〜0012 | QA、PM | E3 |
| [business-process-engine.md](business-process-engine.md) | 業務プロセスの種類と定義と版、ステップ、ルーティング、委任、状態機械、取消・訂正・キャンセル、親子の案件、期限と督促、受信箱、定義の検証と有効化 | 0013〜0016 | QA | E4 |
| [security-model.md](security-model.md) | ドメインと操作（`aggregate` を含む）、業務プロセスの権限、セキュリティグループ、範囲の判定、職務分掌、方針の版と有効化、判定の評価器、代理のログイン、閲覧の記録と説明の報告、運用者の規則表の権限 | 0017〜0020 | セキュリティ、QA | E4、E11 |
| [time-and-attendance.md](time-and-attendance.md) | 打刻と取り込み、客観的な記録との乖離、勤務体系とシフト、労働時間の区分、36 協定の警告、月次の締め、給与への連携 | 0021〜0023 | QA、社労士の確認 | E6 |
| [absence-and-leave.md](absence-and-leave.md) | 年休の付与と台帳、出勤率、斉一的付与、時効、半日・時間単位、年 5 日の義務、管理簿、特別休暇、休暇の申請。休職は読むだけ（持ち主は core-hr。[ADR-0025](../decisions/0025-special-leave-and-leave-of-absence-boundary.md)） | 0024〜0025 | QA、社労士の確認 | E7 |
| [payroll-engine.md](payroll-engine.md) | 給与のグループと営業日の暦、実行の段、入力のスナップショット、項目のグラフとテナントの式、遡及、賞与と臨時の実行、計算の分割、並行稼働、確認の検査 | 0026〜0029 | QA | E8、E9 |
| [payroll-jp-rules.md](payroll-jp-rules.md) | 規則表の取り込みと照合、源泉所得税、社会保険料と標準報酬、雇用保険料、住民税の特別徴収、割増賃金、平均賃金、日割りと欠勤控除、名前付きの丸め。後の年末調整 | 0030〜0034 | QA、社労士・税理士の確認 | E8、E9、E13 |
| [payments-and-accounting.md](payments-and-accounting.md) | 振込先の配分と口座振込の同意、全銀協の形式の振込ファイル、給与明細と電子交付の承諾、賃金台帳、給与の仕訳と出力 | 0035〜0037 | QA、税理士の確認 | E10 |
| [self-service-ui.md](self-service-ui.md) | 1 つのレスポンシブな SPA、従業員とマネージャーの画面、打刻のオフライン、時点の見せ方、受信箱、多言語、アクセシビリティ | 0038〜0039 | QA、PM | E5、E6、E7、E10、E11 |
| [reporting.md](reporting.md) | 時点のレポート、データの元と定義、実行と出力、法定の帳簿、少人数の抑止、組織図、分析用の基盤（S2） | 0040〜0041 | QA | E12 |
| [integrations-and-bulk.md](integrations-and-bulk.md) | 一括の取り込み・出力、移行、並行稼働の取り込み、API と Webhook、ログインと SSO、打刻機 | 0042〜0044 | QA、Ops | E5、E6、E9、E12 |
| [my-number-vault.md](my-number-vault.md) | 収集と本人確認、保管と暗号、目的に縛った API、事務取扱担当者、アクセスの記録、法定の書類、保存と削除、移行 | 0045〜0047 | セキュリティ、法務の確認 | E11、E12、E13 |
| [audit-and-retention.md](audit-and-retention.md) | 監査の記録の系統、ハッシュの連鎖と日の署名、保存の期間の規則表と保全、監査人の画面、電子帳簿保存法 | 0048〜0050 | セキュリティ、QA | E1、E11、E12 |
| [security.md](security.md) | 信頼境界、脅威モデル（`THR-`）、個人情報の区分、暗号と鍵、秘密、運用者のアクセス、セキュリティの試験、法務の論点 | 0051〜0053 | セキュリティ | E1、E4〜E6、E8、E10〜E12 |
| [infrastructure.md](infrastructure.md) | アカウントとネットワーク、ECS のサービス、エッジ、台数、バックアップと DR（支給日の DR）、段階を上げる基準、セル、Terraform、費用 | 0054〜0057 | Ops | E1、E8、E10〜E12 |
| [observability.md](observability.md) | 計装と個人情報を出さない 4 層、SLI、給与の実行の里程標、合成の給与の実行、ログの走査、アラートと runbook、合成監視 | 0058〜0059 | Ops | E1、E6、E8、E10〜E12 |
| [capacity.md](capacity.md) | 負荷のモデル、部品ごとの必要量、予定のスケール、同時の上限、クォータ、負荷試験の計画 | 0060 | Ops | E1、E6、E8、E12 |
| [delivery.md](delivery.md) | CI、`security:sensitive`、ゴールデンデータセットの CI、デプロイ、規則表のリリースと改正の暦、フラグ、支給日の前の凍結 | 0061〜0063 | QA、Ops | E1、E8、E12 |
| [data-model.md](data-model.md)、[data-model/](data-model/temporal.md) | データモデルの正本：規約（ID、テナントと RLS、有効日付、暗号）、置き場所、全体と領域ごとの ER 図、テーブルの定義、DB 以外の置き場所の形、横断の不変条件 | なし（各領域の ADR を参照する） | QA | 全 Epic |

- 領域の範囲はすべて使い切った。**MVP の後の Epic の ADR は 0064 から順に振る。** E13（年末調整と法定調書）は 0064〜0066 を予約する。E14 以降は、着手のときにこの表に行を足してから採番する。

## 8. Epic

Epic と Story の計画は [roadmap.md](../roadmap.md) にある（PM が持つ）。各 Epic の合否基準は [quality.md](../quality.md) の 5 節。

| Epic | 中身 |
| --- | --- |
| E1 基盤 | AWS・Terraform・CI、Aurora と RLS、フラグ、可観測性と個人情報の走査、監査ログの骨格、`packages/money`、時間の制約の PoC |
| E2 オブジェクトモデルと有効日付 | `packages/temporal`、3 つのテーブルの生成、畳み込み、訂正と取消、時点の問い合わせ、発効のタイマー、夜間の整合の検査 |
| E3 Core HR | 組織と階層、ポジションと職務、人・雇用・職務、入社・異動・休職・退職、個人の情報、組織の再編 |
| E4 業務プロセスと権限 | 定義と版、状態機械、ルーティング、委任、取消・訂正、受信箱、ドメインと業務プロセスの権限、職務分掌、方針の有効化 |
| E5 セルフサービスとログイン | 画面の殻、時点の見せ方、変更の申請、受信箱、マネージャーの画面、Better Auth と SSO |
| E6 勤怠 | 打刻（オフライン、打刻機）、勤務体系、労働時間の計算、36 協定の警告、月次の締め |
| E7 休暇 | 年休の付与と台帳、斉一的付与、年 5 日の義務、管理簿、特別休暇、休暇の申請 |
| E8 月次の給与計算 | 実行と入力の固定、項目のグラフと式、規則表の取り込みとリリース、源泉所得税・社会保険料・雇用保険料・住民税・割増賃金、ゴールデンデータセット、合成の給与の実行 |
| E9 賞与・遡及・並行稼働 | 遡及の差額、賞与と臨時の実行、随時改定と定時決定の候補、並行稼働の取り込みと比較、年休の残りの移行 |
| E10 支払と会計 | 振込ファイル、明細と電子交付、賃金台帳、仕訳の出力、大阪での振込ファイルの作り直しの確認 |
| E11 マイナンバーと監査 | 保管庫、収集と本人確認、アクセスの記録、削除、監査の連鎖、保存の期間と保全、閲覧の記録と説明の報告 |
| E12 レポート・連携・本番の準備 | 時点のレポートと抑止、法定の帳簿、一括の取り込み・出力、移行、公開の API と Webhook、負荷試験、DR の訓練、ペンテスト、GA の判定 |
| E13 年末調整と法定調書（MVP の後） | 年末調整の計算と申告の画面、源泉徴収票・給与支払報告書（保管庫の中） |
| E14 電子申請（MVP の後） | 社会保険・雇用保険の届出の電子申請、住民税の通知の電子の取り込み・異動届、法定調書の電子の提出 |
| E15 退職所得と退職金（MVP の後） | 退職所得の源泉徴収、退職金の計算 |
| E16 タレント管理（MVP の後） | 目標、評価、後継者の計画 |

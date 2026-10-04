# Decisions: Workday

Workday の再構築に関する決定。リポジトリ共通の決定は [docs/decisions/](../../../../docs/decisions/README.md) にある（本家の名前・接頭辞を使わない規則は、その ADR-0006。本家の実装を使わない規則は ADR-0007）。領域ごとの設計と、領域ごとの ADR の番号の範囲は [architecture/](../architecture/README.md) の 7 節を見る。

<!-- adr-index:start -->
| ADR | 決定 | 状態 |
| --- | --- | --- |
| [0001](0001-platform-and-stack.md) | 共通の基盤を引き継ぎ、給与計算も TypeScript で書く。お金は整数の円と固定小数点で扱う | accepted |
| [0002](0002-effective-dated-data-model.md) | 人事のデータを有効時間と記録時間の 2 軸で持ち、変更の差分を有効日の順に畳み込む | accepted |
| [0003](0003-business-process-engine.md) | 業務プロセスを、バージョンつきの定義と Aurora に永続する状態機械で自前に作る | accepted |
| [0004](0004-payroll-engine.md) | 給与計算を、入力のスナップショットと規則表のバージョンから決まる純粋な計算にする | accepted |
| [0005](0005-security-and-my-number.md) | ドメインと業務プロセスの権限と職務分掌で守り、マイナンバーは別アカウントの保管庫に置く | accepted |
| [0006](0006-temporal-table-triplet-and-fold.md) | facet ごとの 3 つのテーブルを宣言から生成し、同じ日の差分の順序を事象の種類で決める | accepted |
| [0007](0007-change-correction-rescind-semantics.md) | 変更・訂正・取消を差分の種類で区別し、取消は依存の決定表で拒む | accepted |
| [0008](0008-point-in-time-queries-and-activation-timers.md) | 時点の問い合わせの `known_at` を安定の境界より前に限り、将来日付の副作用は発効の予定の表で行う | accepted |
| [0009](0009-temporal-reference-model-testing.md) | 有効日付の実装を、純粋な参照のモデルとのモデルベーステストで確かめる | accepted |
| [0010](0010-person-employment-job-assignment-model.md) | 人・雇用・職務の割り当ての 3 層で持ち、人員の枠をポジションに一本化する | accepted |
| [0011](0011-effective-dated-org-hierarchy-closure.md) | 組織の階層を有効日付の親子の辺と、日付の範囲つきの閉包テーブルで持つ | accepted |
| [0012](0012-worker-lifecycle-events-and-legal-checks.md) | 入社・異動・休職・退職を雇用の状態の差分として書き、法令の検査は警告と理由の記録にする | accepted |
| [0013](0013-bp-definition-format-and-versions.md) | 業務プロセスの定義を JSON の宣言と型のある式の木で書き、起票の日に有効なバージョンに案件を固定する | accepted |
| [0014](0014-bp-routing-and-delegation.md) | 担当を組織のロールと閉包で決めて起票者と本人を除き、委任は期間中の未完了のタスクにも効かせる | accepted |
| [0015](0015-bp-deadlines-reminders-and-inbox.md) | 期限を営業日で決めて表のタイマーで督促し、受信箱は担当の射影に委任を読むときに結ぶ | accepted |
| [0016](0016-bp-definition-validation-and-activation.md) | 業務プロセスの定義を静的な検査と模擬の実行で確かめ、編集と有効化を別の人に分ける | accepted |
| [0017](0017-authorization-evaluator.md) | 権限の判定を自前の評価器で行い、利用者ごとの権限の表と、閉包を使う SQL の条件で絞る | accepted |
| [0018](0018-security-policy-versions-and-activation.md) | 権限の方針をバージョンで持って別の人が有効化し、所属とロールの変更は業務プロセスで効かせる | accepted |
| [0019](0019-segregation-of-duties-checks.md) | 職務分掌を範囲つきの規則表で持ち、有効化・所属の変更・案件の操作・夜間の走査の 4 か所で検査する | accepted |
| [0020](0020-sensitive-read-audit-and-access-explanations.md) | 機微なドメインの閲覧を記録し、判定に理由を付けて説明の報告を出し、本番の代理のログインを読み取りに限る | accepted |
| [0021](0021-clock-events-corrections-and-objective-records.md) | 打刻を端末が採番した追記のみの事象にし、訂正は記録の追加で行い、客観的な記録との乖離は検知だけする | accepted |
| [0022](0022-work-schedules-and-work-hour-calculation.md) | 勤務体系を種類と印に分け、労働時間を分の整数で日・週・期間の順に区分する純粋な関数で計算する | accepted |
| [0023](0023-overtime-agreement-monitoring-and-monthly-close.md) | 36 協定を事業所ごとの設定で持ち、実績と見込みで段階的に警告し、月次の締めは集計のバージョンを給与に渡す | accepted |
| [0024](0024-annual-leave-grant-ledger.md) | 年休を付与と追記のみの台帳で持ち、斉一的付与は法定を下回らない検査を通した設定だけを受ける | accepted |
| [0025](0025-special-leave-and-leave-of-absence-boundary.md) | 休職は core-hr の雇用の状態が持ち、休暇の領域は日・半日・時間の単位の休暇と特別休暇を持つ | accepted |
| [0026](0026-payroll-run-stages-and-input-snapshot.md) | 給与の実行を状態機械にし、入力を RFC 8785 の正規の形と SHA-256 で固定して内容のアドレスで置く | accepted |
| [0027](0027-pay-item-graph-and-formula-language.md) | 項目を段つきの依存のグラフにし、テナントの式は円・10 進・分の型を分けた式の木で書く | accepted |
| [0028](0028-retro-deltas-and-bonus-runs.md) | 遡及は確定した期間の計算し直しとの差を当期の行にし、エンジンの違いによる差は止め、賞与は前月の確定を前提にする | accepted |
| [0029](0029-parallel-run-and-compute-partitioning.md) | 計算を決まった束ごとに ECS のタスクで行い、並行稼働は許容の幅なしで差を分類して切り替えを判定する | accepted |
| [0030](0030-rule-table-ingestion-and-verification.md) | 規則表を適用の鍵つきのバージョンで持ち、元のファイルのハッシュと 2 人の独立の照合を経て公開する | accepted |
| [0031](0031-income-tax-withholding.md) | 源泉所得税の欄と表を決定表で選び、甲欄の月額表は表引きと電算機特例を会社の設定で選ぶ | accepted |
| [0032](0032-social-insurance-premiums-and-standard-remuneration.md) | 社会保険料は健康保険の側と厚生年金をそれぞれ 1 回だけ丸め、控除の月は前月分を既定にし、等級の改定は候補だけを示す | accepted |
| [0033](0033-employment-insurance-and-resident-tax.md) | 雇用保険料は締日で料率を選んで 50 銭以下切り捨てにし、住民税は通知の月割額をそのまま使う | accepted |
| [0034](0034-overtime-premiums-and-proration.md) | 割増賃金は法定の最低の倍率を下限にし、端数の処理は通達の形の中からテナントが選び、欠勤控除は切り捨てる | accepted |
| [0035](0035-bank-transfer-files.md) | 振込は支払の指示から決定的に作る全銀協の形式のファイルにし、承認はファイルのハッシュに結ぶ | accepted |
| [0036](0036-payslips-wage-ledger-and-e-delivery-consent.md) | 明細は確定の結果から作る変わらない文書にし、電子交付は承諾の台帳で持ち、賃金台帳は射影にする | accepted |
| [0037](0037-payroll-journal-export.md) | 給与の仕訳を実行の段ごとに釣り合う追記のみの記録にし、部門と勘定に集計して連番の束で出力する | accepted |
| [0038](0038-single-responsive-spa-and-offline-clock.md) | 画面を 1 つのレスポンシブな SPA にし、打刻の画面だけをオフラインの待ち行列で持つ | accepted |
| [0039](0039-effective-dated-views-and-change-requests.md) | 画面は時点を URL に持ち、将来の変更と保留中の案件を重ねて示し、変更の申請は有効日を必須にする | accepted |
| [0040](0040-declarative-reports-and-analytics-store.md) | レポートを宣言の定義で持ち、同じ権限の判定を通して時点を固定して実行し、S2 は S3 の Iceberg と Athena に移す | accepted |
| [0041](0041-small-cell-suppression-for-sensitive-aggregates.md) | 機微な値の集計は、個々の値を見る権限のない利用者に対して 5 人未満の区分を伏せ、2 次の抑止と繰り返しの検知をかける | accepted |
| [0042](0042-bulk-import-through-business-processes.md) | 一括の取り込みは全行を検証してから行ごとの子の案件で流し、同じ主体の行は有効日の順に直列にする | accepted |
| [0043](0043-migration-history-and-parallel-run-inputs.md) | 移行は履歴を「移行」の差分として取り込み、本番の開始日より前に遡及を出さず、並行稼働は現行の入力も取り込めるようにする | accepted |
| [0044](0044-sso-api-clients-and-clock-terminals.md) | ログインと SSO は Better Auth で持って本システムは SP・RP だけになり、API の利用者と打刻機は専用の資格情報で同じ権限の判定を通す | accepted |
| [0045](0045-my-number-collection-and-identity-verification.md) | マイナンバーの入力と本人確認は保管庫が配る画面で受け、方法と確認した人を記録する | accepted |
| [0046](0046-purpose-bound-vault-api-and-access-log.md) | 保管庫の API は操作者の主張と保管庫の担当者の表で目的ごとに判定し、平文を外に返さず、記録を番号なしのハッシュの連鎖で残す | accepted |
| [0047](0047-my-number-retention-and-deletion.md) | 番号の本体は最後の法定の事務まで、書類は種類ごとの保存の期間まで持ち、日次の候補から事務取扱担当者の確認で 30 日以内に消す | accepted |
| [0048](0048-audit-log-hash-chain-and-anchoring.md) | 監査ログを同じトランザクションで追記し、安定の境界の後にテナントごとの連鎖のセグメントにして Object Lock に置き、日ごとに署名する | accepted |
| [0049](0049-retention-rules-table-and-legal-hold.md) | 保存の期間を確認の状態つきの規則表で持ち、確認待ちの間は長いほうで動かし、保全を優先して専用のロールで消す | accepted |
| [0050](0050-electronic-books-act-readiness.md) | 電子帳簿保存法の対象になりうる給与の記録に、最低限の要件と優良な電子帳簿に相当する機能を持たせ、当てはめはテナントと税理士に委ねる | accepted |
| [0051](0051-threat-model-and-pii-classification.md) | 個人情報を 5 つの区分に分けて列ごとに宣言し、脅威は部品ごとの STRIDE の表と拒否の側のテストで持つ | accepted |
| [0052](0052-kms-key-hierarchy.md) | KMS の鍵を用途とアカウントで分け、テナントの物体はテナントごとの鍵で守り、保管庫・振込ファイル・署名には専用の鍵を置く | accepted |
| [0053](0053-operator-access-and-vault-break-glass.md) | 運用者は本番のデータに常設の権限を持たず、テナントのデータの参照はテナントの許可で行い、保管庫の番号を復号できる人のロールは作らない | accepted |
| [0054](0054-accounts-network-and-vault-boundary.md) | 保管庫を別の OU のアカウントに置き、人事の側とは PrivateLink の片方向の経路だけでつなぎ、Payroll Compute は DB に経路のないサブネットに置く | accepted |
| [0055](0055-disaster-recovery-and-payday-continuity.md) | 大阪にウォームスタンバイを持ち、切り替えは支払の経路を先に戻し、支給日の前は大阪で振込ファイルを作り直してハッシュの一致を毎日確かめる | accepted |
| [0056](0056-stages-cluster-sharding-and-cells.md) | S1 は 1 つの Aurora のクラスタ、S2 はテナントの対応表でクラスタを分け、S3 は保管庫を含むセルにする | accepted |
| [0057](0057-vault-delivery-separation.md) | 保管庫の Terraform の状態・デプロイのパイプライン・承認者・デプロイの日を人事の側と分ける | accepted |
| [0058](0058-pii-free-telemetry.md) | 個人情報を出さない計装を型・Collector・URL の規則・走査の 4 層で守り、保管庫のテレメトリーは保管庫のアカウントに閉じる | accepted |
| [0059](0059-payroll-run-slo-and-synthetic-run.md) | 給与の実行を支給日から逆算した里程標の遅れで監視し、本番の監視用のテナントで合成の給与を毎日計算して期待値と比べる | accepted |
| [0060](0060-scheduled-peak-capacity.md) | 前もって分かる集中は暦と予定から先に広げ、給与計算とレポートにテナントの同時の上限と支給日の近さの優先を置く | accepted |
| [0061](0061-golden-dataset-ci.md) | ゴールデンデータセットを事例ごとの入力・規則表のバージョン・期待値・確認の出所で持ち、分類の網羅を検査し、期待値の変更とコードの変更を別の PR にする | accepted |
| [0062](0062-rule-table-release-calendar.md) | 規則表を署名した束でコードと別に出し、改正の暦で監視して適用の 5 営業日前までに公開する | accepted |
| [0063](0063-payroll-flags-pinning-and-freeze-windows.md) | 給与に効くフラグとエンジンのイメージを実行ごとに固定し、テナントには影の比較の後に期間の境目で広げ、支給日の前は給与の経路のデプロイを凍結する | accepted |
<!-- adr-index:end -->

この一覧は、各 ADR の frontmatter と見出しから生成したもの。ADR を追加・更新したら生成し直す。

# Runbooks: Workday

Ops が持つ運用の文書。品質の判定基準は [quality.md](../quality.md) の 4 節、SLI の計測の仕組みとアラートの条件の実装は [observability.md](../architecture/observability.md) の 3・5 節にある。**SLO の値とアラートの一覧の正本はこの文書** で、observability.md と [ADR-0059](../decisions/0059-payroll-run-slo-and-synthetic-run.md) は、これを計測・実装する側の記述である。値を変えるときは、この文書を先に変え、observability.md を合わせる。

今ある手順：

| 手順 | 使うとき |
| --- | --- |
| [incident-response.md](incident-response.md) | すべての呼び出しのアラートの共通の進め方。マイナンバーの漏えいの疑い、個人情報の出力、給与の計算の誤り（支給日の後）、テナントの分離の破れ・権限の迂回、依存先の障害 |
| [deploy-and-rollback.md](deploy-and-rollback.md) | 本番へのデプロイ、規則表の公開、給与に効くフラグの有効化、Terraform、保管庫のデプロイ、悪化したときの戻し |
| [disaster-recovery.md](disaster-recovery.md) | AZ の障害、リージョンの障害、複製の遅延、論理的な破損、支給日の DR（大阪から振込ファイルを出す）、保管庫の切り替え、訓練 |

## 1. SLI と SLO

| SLI | 良いイベント（数える場所） | SLO（S1） | 許容範囲を外れたときの扱い | 品質の判定に使う |
| --- | --- | --- | --- | --- |
| 画面・API の可用性 | 本番のテナントの要求のうち失敗でないもの（CloudFront のリアルタイムのログ。3.2 節の分類） | **99.9%（30 日）**（NFR-004） | 1 時間・5 分で 14.4 倍、6 時間・30 分で 6 倍のバーンレートで呼び出し。3 日・6 時間で 1 倍でチケット。使い切ったら修正以外のデプロイを止める | |
| 給与の経路の可用性 | 支給日の前の 5 営業日の、給与の担当の画面・API（`/api/*/payroll*`）と振込ファイルの生成・取り出しの成功（エッジと worker） | **99.95%（その期間）**（NFR-004） | 5 分間の失敗の率 0.5% 超で呼び出し | |
| 画面の操作の処理時間 | 一覧・レポートの出力を除く API | **p95 500ms、p99 1.5 秒**（NFR-005） | p95 が 15 分超えたらチケット | ○ |
| 打刻 | 打刻の受付の API | **p99 300ms**（NFR-005） | 10 分超えたら呼び出し（始業の時間帯） | ○ |
| 時点の問い合わせ | `effective_on`・`known_at` つきの 1 人の問い合わせ | **p99 300ms**（NFR-005） | チケット | |
| 発効の遅れ | 発効の予定の `fire_at` から実行まで | **p99 5 分** | 4 月 1 日の前後は呼び出し、それ以外はチケット | |
| 36 協定の警告 | 退勤の打刻から判定まで、日次の判定の完了 | **退勤ごとは p95 5 分、日次は毎日 2 時までに完了**（K5） | 2 時までに終わらなければチケット、1 時間遅れで呼び出し | ○ |
| 給与の実行の時間の遵守 | 本番の実行のうち、`system` の原因で里程標に遅れなかったもの | **99.9%（月）** | 里程標の予定を 30 分過ぎたら、支給日の 3 営業日前以降は呼び出し、それより前はチケット | ○ |
| 計算の時間 | 計算の段の開始から `computed` まで（人数で正規化） | **1 万人 15 分、3 万人 45 分**（NFR-003。S2 は 10 万人 60 分） | 最大のテナントで 70% を超えたら段階を上げる検討（[infrastructure.md](../architecture/infrastructure.md) の 8 節） | ○ |
| 1 人の再計算 | 確認の段の 1 人の計算し直し | **p99 5 秒**（NFR-003） | チケット | |
| 振込ファイルの生成 | 承認の依頼の時点でファイルが作れている | **100%** | 1 件でも作れなければ呼び出し（支給日の前） | ○ |
| 再現の抜き取り | 夜間の抜き取りの不一致 | **0 件** | 1 件で SEV1 | ○ |
| 合成の給与の実行 | 毎日の結果とゴールデンデータの期待値の一致 | **100%** | 1 件で SEV2 | ○ |
| 大阪への複製 | `AuroraGlobalDBRPOLag` が 60 秒以内の時間の割合 | **99.9%**（NFR-006 の RPO 5 分に余裕を持たせる） | 60 秒を 5 分超えたら呼び出し | |

- **応答の分類**：2xx・3xx は成功。400・401・403・404・409（業務の規則の拒否：`SAME_DAY_CONFLICT` など）・429（テナントのレート制限）は成功。503、5xx、オリジンのタイムアウト、同期の API の 10 秒の超過は失敗（[observability.md](../architecture/observability.md) の 3.2 節）。
- 監視用のテナント（`environment = internal`）は SLO の計算から除く。
- SLO の窓は 30 日の移動の窓（報告は暦の月）。支給日の前の 5 営業日の給与の経路は、その期間だけの SLO として別に数える。エラーバジェットの方針は他の題材と同じ（使い切ったら信頼性の作業を機能より先にする。デプロイの前に残りを確かめる）。
- 「品質の判定に使う」に ○ がある指標は、QA が品質の判定基準に使う（[quality.md](../quality.md) の 4.1 節）。定義を変えるときは QA と合意する。
- 復旧の目標（NFR-006）：AZ の障害は RPO 0・RTO 15 分以内。リージョンの障害は RPO 5 分以内・RTO 4 時間以内。支給日の前の 5 営業日にリージョンが落ちても、振込ファイルを当日中に出す。

## 2. 上限と容量のパラメーター

値の正本は各文書にある。Ops が運用で変えてよいのは、下の「運用で変えるもの」だけで、変えたら記録を残す。

| 対象 | 値 | 正本 | 運用で変えるもの |
| --- | --- | --- | --- |
| 給与計算の束 | 雇用の ID の順に 250 人 | [ADR-0029](../decisions/0029-parallel-run-and-compute-partitioning.md) | —（E12 の負荷試験で決め直す） |
| Payroll Compute の同時のタスク | テナントごと 20、全体 200。支給日の近い実行を先に、`parallel` を最後に | [capacity.md](../architecture/capacity.md) の 3.1 節（[ADR-0060](../decisions/0060-scheduled-peak-capacity.md)） | 全体の上限（AppConfig） |
| 入力の固定の同時の束 | テナントごと 20 | 同上 | 同上 |
| レポートの非同期 | テナントごと 5、利用者ごと 2。同期は 1,000 行・10 秒 | [reporting.md](../architecture/reporting.md) の 4.3 節 | 同時の上限の引き下げ（`report-reader-saturation.md`） |
| 一括の取り込み | 1 ファイル 5 万行、テナントごと同時 1 ファイル | [integrations-and-bulk.md](../architecture/integrations-and-bulk.md) の 3.2 節 | — |
| 打刻のレート制限 | 1 テナント 200 件/秒。端末の送信の束 50 件、打刻機の束 500 件 | [capacity.md](../architecture/capacity.md) の 2.1・5 節 | 回復の集中のときの引き下げ（`clock-ingest-backlog.md`） |
| 有効日付の書き込み | `transaction_timeout = 5s`、1 案件の差分 200 件、将来日付は今日＋3 年 | [object-model-and-effective-dating.md](../architecture/object-model-and-effective-dating.md) の 3.1 節 | — |
| 発効の追いつき | 1 テナント 1 分に 5,000 件 | 同 8 節 | — |
| 遡及の窓 | 24 か月（`payroll.retro_override` で 36 か月） | [ADR-0028](../decisions/0028-retro-deltas-and-bonus-runs.md) | — |
| 業務プロセス | 差し戻し 5 回、委任 180 日、期限の上限 30 営業日 | [business-process-engine.md](../architecture/business-process-engine.md) の 6・7・10 節 | — |
| セッション | アイドル 30 分（人事・給与・管理者）・8 時間（従業員）、絶対 12 時間、再認証 5 分 | [integrations-and-bulk.md](../architecture/integrations-and-bulk.md) の 7.3 節 | — |
| 保存の期間 | 規則表（確認待ちの間は長いほう） | [audit-and-retention.md](../architecture/audit-and-retention.md) の 5.2 節 | テナントの延長だけ（短くしない） |
| 台数と予定のスケール | api 平常 6・始業の前 12・最大 40、bp-worker 3（4 月 1 日の前に 12）、給与の用の reader（支給日の 5 営業日前から） | [infrastructure.md](../architecture/infrastructure.md) の 5 節、[capacity.md](../architecture/capacity.md) の 3 節 | 予定の表の値、最小のタスク数 |

## 3. リリースとロールバック

流れの正本は [delivery.md](../architecture/delivery.md)、手順は [deploy-and-rollback.md](deploy-and-rollback.md)。

- **デプロイとリリースを分ける。** デプロイは Ops が承認し、リリース（フラグを広げる）は PM が判断する。すべての新しい振る舞いは release フラグの裏に置く。
- **フラグは 4 種類**（[ADR-0063](../decisions/0063-payroll-flags-pinning-and-freeze-windows.md)）：release（PM）、payroll（PM と QA。影の比較の後、テナントの給与の期間の境目で）、ops（縮退。`ops.read_only_mode`・`ops.payroll_finalize_hold`・`ops.payroll_first`。給与の確定の保留は IC）、permission（契約の機能の有効化）。**給与に効くフラグとエンジンのイメージは、入力の固定のときに実行に固定する。**
- **デプロイの順**：マイグレーション（expand）→ relay・worker・loader・egress-worker・audit-archiver → bp-worker → api（blue/green のカナリア 10% → 100%）→ Payroll Compute のイメージの登録（次に入力を固定する実行から）。直後に合成の給与の実行。
- **ロールバック**：まずフラグで戻す（給与に効くフラグは次の実行から）。次に 1 つ前のイメージ。Payroll Compute は「現在のエンジンのダイジェスト」を前に戻す。**マイグレーションは戻さない。確定した給与の結果と公開した規則表は戻さない**（訂正の版と遡及で直す）。
- **保管庫**は別のパイプライン・別の承認者（セキュリティの担当と Ops の責任者）で、人事の側と別の日に出す（[ADR-0057](../decisions/0057-vault-delivery-separation.md)）。
- 本番へのデプロイは Ops が承認する（作成者と別の人）。`security:sensitive` は Dev のテックリードとセキュリティの担当の 2 人。

### 3.1 デプロイの時間帯と凍結

| 対象 | 時間帯 | 凍結（修正だけ。例外は下） |
| --- | --- | --- |
| アプリ（api、workers、bp-worker、loader） | 平日 10〜17 時 | 金曜 15 時以降、日本の祝日の前日、年末年始、エラーバジェットを使い切っている間 |
| **給与の経路**（`payroll:calc`、振込ファイル、明細、Payroll Compute のイメージ、給与の DB のスキーマの contract） | 同上 | 上に加えて、**支給日の前の凍結の日**：本番の従業員の 20% 以上が 3 営業日以内に支給日を迎える日（支給日の予定から毎晩計算して暦に出す。[ADR-0063](../decisions/0063-payroll-flags-pinning-and-freeze-windows.md)） |
| 業務プロセスと有効日付のパッケージ | 同上 | 上に加えて、月初の 3 営業日（4 月 1 日の発効、1 月の源泉の切り替えの直後を含む） |
| マイグレーションの contract | 同上 | 凍結の日と月初の 3 営業日。別のリリースで |
| 給与に効くフラグの有効化 | テナントの次の実行の入力の固定の前 | 期間の途中の実行があるときは、その確定の後 |
| 保管庫（vault-prod） | 平日 10〜17 時。人事の側と別の日 | 同上 |
| Terraform | 平日 10〜16 時。Ops の承認（鍵・WAF・IAM・`vault/*` は `security:sensitive`） | 同上 |
| DR の戻し（大阪 → 東京） | 計画作業として | 支給日の前の 5 営業日と凍結の日 |

- 凍結の日の例外は、Ops の責任者と QA の承認を記録してから。脆弱性の Critical の修正は時間帯と凍結の制限を受けないが、2 人の承認とゴールデンデータセットは省かない。
- 夜間の CI が 2 日続けて失敗している間は、release フラグを広げない。

### 3.2 規則表のリリースの暦

規則表は、コードのリリースと別の署名した束で出す（[ADR-0062](../decisions/0062-rule-table-release-calendar.md)、[delivery.md](../architecture/delivery.md) の 6 節）。**公開の期限は、適用の最初の支払日の 5 営業日前**。その時点で `published` でなければチケット、2 営業日前で呼び出す。暦の手順の正本は `statutory-rate-calendar.md`（E8 で作成）。

| 規則表 | 適用の鍵 | ふだんの改正の時期 | 監視の開始 |
| --- | --- | --- | --- |
| 源泉徴収税額表（月額表・日額表・賞与の算出率）、電算機特例 | 支払日の年 | 1 月の支払いから（税制の改正の年） | 前年の 10 月（公表の時期は未検証。E8 の `rule-table-release-pipeline` で国税庁の公表を週 1 回検知する） |
| 協会けんぽの健康保険・介護保険の料率 | 保険料の月分 | 3 月分から | 1 月 |
| 子ども・子育て支援金率 | 保険料の月分 | 4 月分から（令和 8 年度に開始） | 1 月 |
| 雇用保険の料率 | 賃金の締日 | 4 月 1 日から | 1 月 |
| 厚生年金の標準報酬月額の上限 | 保険料の月分 | 2027 年 9 月分から段階的に（2028 年 9 月、2029 年 9 月） | 各年の 3 月 |
| 健康保険の等級表 | 保険料の月分 | 改正のとき | 随時 |
| 健康保険組合の料率（テナントの表） | 保険料の月分 | 組合ごと（組合の案内による。テナントが組合の案内で確かめて入力する） | テナントに 1 月に案内 |
| 住民税の通知（テナントの表） | 6 月から | 毎年 5 月に取り込み | 5 月（`resident-tax-notice-import.md`） |
| 国民の祝日 | 日付 | 毎年 | 前年の 11 月（取り込みの元は内閣府の [syukujitsu.csv](https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv)。2026-09-28 の時点で翌年の 2027 年の分まで載っている） |

- 流れ：公表の検知（週 1 回）→ 取り込み（`rules.import`）→ 独立の照合（`rules.verify`。取り込んだ人と別。S8）→ 新しい期間のゴールデンデータの事例（社労士・税理士の確認つき）→ staging に公開してゴールデンデータの全件と合成の給与の実行 → 本番に公開（`rules.publish`。Ops の承認）→ 直後の合成の給与の実行。
- 公開の後の誤りは、公開を戻さず、訂正の版を同じ流れで出す（`rule-table-correction.md`）。

## 4. アラートと手順

「作成済み」以外の手順は、各 Epic の実装に合わせて [templates/runbook.md](../../../../docs/templates/runbook.md) から作る。「作る Story」の列は、そのアラートの計測と手順を作る [roadmap.md](../roadmap.md) の Story である。手順の文書は、その Story の完了の条件に含める（E12 の分は `runbooks-e12` でもまとめて確かめる）。作るまでは [incident-response.md](incident-response.md) の該当の節で対応する。アラートの条件の実装は [observability.md](../architecture/observability.md) の 5.2 節。

呼び出しのアラートは、SLO、支払の締め切り、個人情報・マイナンバー、給与の正しさの症状に限る。原因の側の指標（CPU など）はチケットとダッシュボードにとどめる。すべてのアラートは runbook の URL を注釈に持つ（CI で検査する）。

| アラート（重さ） | 手順 | 状態 | 作る Story |
| --- | --- | --- | --- |
| 画面・API の SLO の速いバーンレート（page）・遅いバーンレート（ticket） | [incident-response.md](incident-response.md) | 作成済み | `edge-sli-and-alert-annotations`、`slo-and-alert-tuning` |
| 給与の経路の SLO（支給日の前。5 分の失敗の率 0.5% 超。page） | [incident-response.md](incident-response.md) | 作成済み | `edge-sli-and-alert-annotations` |
| 合成監視の連続失敗（2 回。page） | [incident-response.md](incident-response.md) | 作成済み | `synthetic-canaries` |
| outbox の遅れ（最古の行が 60 秒。page） | [incident-response.md](incident-response.md) の「依存先の障害」 | 作成済み | `ecs-services-baseline` |
| 合成の給与の実行の不一致（1 件。SEV2） | [incident-response.md](incident-response.md) の「給与の計算の誤り」 | 作成済み | `payroll-milestones-and-synthetic-run` |
| 個人番号の形の検出（SEV2）、保管庫の鍵・主張の署名の鍵の想定外の使用（SEV2 から） | [incident-response.md](incident-response.md) の「マイナンバーの漏えいの疑い」 | 作成済み | `pii-and-mn-scanners`、`kms-keys-and-policies`、`vault-telemetry` |
| 個人情報の形の検出（SEV3 から）、走査の停止（合成の番号が検出されない。page） | [incident-response.md](incident-response.md) の「個人情報の出力」 | 作成済み | `pii-and-mn-scanners` |
| デプロイ中の自動ロールバック、フラグのガードによる自動の停止、デプロイの直後の合成の給与の実行の不一致 | [deploy-and-rollback.md](deploy-and-rollback.md) | 作成済み | `flags-appconfig`、`payroll-flags-and-freeze-calendar` |
| DR の複製の遅延（`AuroraGlobalDBRPOLag` 60 秒を 5 分。page）、AZ の障害、大阪からの合成監視の連続失敗 | [disaster-recovery.md](disaster-recovery.md) | 作成済み | `osaka-warm-standby-skeleton`、`dr-drills` |
| 大阪での振込ファイルの作り直しのハッシュの不一致（1 件。SEV2） | [disaster-recovery.md](disaster-recovery.md) の E | 作成済み | `bank-file-osaka-rebuild-check` |
| 有効日付の夜間の検査の食い違い（1 件。チケット、SEV2） | `temporal-consistency-mismatch.md`（[object-model-and-effective-dating.md](../architecture/object-model-and-effective-dating.md) の 15 節） | E2 で作成 | `temporal-nightly-consistency` |
| 発効の予定の遅れ（p99 5 分超。4 月 1 日の前後は page） | `activation-backlog.md`（同上） | E2 で作成 | `temporal-activation-timers` |
| 閉包と辺の食い違い（1 件。チケット、SEV2） | `org-closure-rebuild.md`（[core-hr.md](../architecture/core-hr.md) の 15 節） | E3 で作成 | `org-model-and-hierarchy` |
| 業務プロセスの `stuck`（24 時間。チケット、SEV3） | `bp-stuck-steps.md`（[business-process-engine.md](../architecture/business-process-engine.md) の 18 節） | E4 で作成 | `bp-routing` |
| 業務プロセスのタイマーの遅れ（5 分。チケット） | `bp-timer-lag.md`（同上） | E4 で作成 | `bp-deadlines-and-timers` |
| 権限の拒否の急増（チケット） | `authz-deny-spike.md`（[security-model.md](../architecture/security-model.md) の 17 節） | E4 で作成 | `thr-authz-negative-tests` |
| 打刻の受付の遅れ・端末からの集中（p99 300ms を 10 分。始業の時間帯は page） | `clock-ingest-backlog.md`（[time-and-attendance.md](../architecture/time-and-attendance.md) の 14 節。self-service-ui の `clock-offline-backlog` を含む） | E6 で作成 | `clock-events-ingest`、`clock-sli-and-scheduled-scaling` |
| 36 協定の日次の判定の遅れ（2 時までに終わらない。1 時間で page） | `overtime-alert-job-delay.md`（同上） | E6 で作成 | `overtime-alerts` |
| 打刻機からの受信が 1 時間ない（チケット） | `clock-terminal-silent.md`（[integrations-and-bulk.md](../architecture/integrations-and-bulk.md) の 15 節） | E6 で作成 | `clock-terminal-integration` |
| 客観的な記録の取り込みの停止（チケット） | `objective-log-import-failure.md`（[time-and-attendance.md](../architecture/time-and-attendance.md) の 14 節） | E6 で作成 | `objective-records-divergence` |
| 年休の残りの集計と台帳の食い違い（SEV3）、付与・失効の実行の遅れ | `leave-balance-rebuild.md`、`leave-grant-job-catchup.md`（[absence-and-leave.md](../architecture/absence-and-leave.md) の 16 節） | E7 で作成 | `annual-leave-ledger`、`annual-leave-grant-rules` |
| 給与の実行の里程標の遅れ（`system`。支給日の 3 営業日前以降は page）、束の失敗の率（1% 超。page） | `payroll-run-stuck.md`（[payroll-engine.md](../architecture/payroll-engine.md) の 18 節） | E8 で作成 | `payroll-compute-chunks`、`payroll-milestones-and-synthetic-run` |
| 再現の抜き取りの不一致、`ENGINE_DRIFT`（1 件。SEV1） | `payroll-reproducibility-mismatch.md`（同上） | E8 で作成 | `reproducibility-sampler` |
| 規則表の公開の遅れ（5 営業日前にチケット、2 営業日前に page） | `statutory-rate-calendar.md`（[payroll-jp-rules.md](../architecture/payroll-jp-rules.md) の 16 節） | E8 で作成 | `rule-table-release-pipeline` |
| 住民税の通知のない特別徴収の対象（6 月の実行の確認の検査。チケット） | `resident-tax-notice-import.md`（同上） | E8 で作成 | `resident-tax-withholding` |
| 振込ファイルの承認の締め切りの接近（4 時間前に `released` でない。チケット） | `bank-file-release.md`（[payments-and-accounting.md](../architecture/payments-and-accounting.md) の 14 節） | E10 で作成 | `payment-release-approval` |
| 明細の公開・PDF の生成の遅れ（チケット） | `payslip-publish-delay.md`（同上） | E10 で作成 | `payslip-documents` |
| 保管庫の記録の欠け・連鎖の検証の失敗（SEV2） | `vault-access-log-gap.md`（[my-number-vault.md](../architecture/my-number-vault.md) の 17 節） | E11 で作成 | `vault-access-log` |
| マイナンバーの削除の遅れ（候補から 30 日超。チケット） | `mn-deletion-overdue.md`（同上） | E11 で作成 | `mn-retention-and-deletion` |
| 監査の連鎖の検証の失敗（SEV2） | `audit-chain-verification-failure.md`（[audit-and-retention.md](../architecture/audit-and-retention.md) の 14 節） | E11 で作成 | `audit-archiver-and-chain` |
| 監査の書き出しの遅れ（15 分でチケット、1 時間で page） | `audit-archiver-lag.md`（同上） | E11 で作成 | `audit-archiver-and-chain` |
| 期限を過ぎた運用者の権限（page） | `operator-access-review.md`（[security.md](../architecture/security.md) の 14 節） | E11 で作成 | `support-access-grants` |
| レポートの reader の飽和（チケット） | `report-reader-saturation.md`（[reporting.md](../architecture/reporting.md) の 15 節） | E12 で作成 | `report-runner` |
| Webhook の登録の停止（管理者へ通知） | `webhook-endpoint-disabled.md`（[integrations-and-bulk.md](../architecture/integrations-and-bulk.md) の 15 節） | E12 で作成 | `webhooks` |

アラートに結び付かない手順（依頼・定期作業・計画作業）：

| 手順 | 使うとき | 状態 | 作る Story |
| --- | --- | --- | --- |
| `rescind-chain.md` | 取消が依存で拒まれたときの、依存の一覧から順に取り消す支援 | E4 で作成 | `bp-rescind-and-correct` |
| `bp-bad-definition-rollback.md` | 誤った業務プロセスの定義を有効化したとき | E4 で作成 | `bp-definition-activation` |
| `bp-partial-bulk.md` | 親の案件（再編、一括の取り込み）が `partially_applied`（integrations の `bulk-import-partial-failure` を含む） | E4 で作成（E12 で一括の取り込みの節を足す） | `bp-parent-child-and-bulk`、`bulk-import-pipeline` |
| `security-policy-rollback.md` | 誤った権限の方針を有効化したとき | E4 で作成 | `security-policy-versions` |
| `sod-violation-report.md` | 夜間の職務分掌の走査の違反 | E4 で作成 | `sod-rules-and-checks` |
| `reorg-partial-failure.md` | 組織の再編の親の案件が止まったとき | E3 で作成 | `org-inactivation-and-reorg` |
| `april-mass-transfer.md` | 4 月 1 日付の定期の異動の前の準備 | E3 で作成 | `april-mass-transfer-readiness` |
| `duplicate-worker-merge.md` | 二重に登録した人の扱い（MVP の運用の手順） | E3 で作成 | `worker-employment-model` |
| `ui-asset-release-rollback.md` | 静的な資産の配布の戻し | E5 で作成 | `ui-shell-and-design-system` |
| `idp-outage.md` | テナントの IdP の障害と非常用の管理者のログイン | E5 で作成 | `sso-saml-oidc` |
| `time-period-reopen.md` | 締めた月の開き直し | E6 で作成 | `monthly-close` |
| `uniform-grant-cutover.md` | 斉一的付与への切り替え | E7 で作成 | `uniform-grant-policy` |
| `payroll-cancel-and-rerun.md` | 確定の後、支払の前の取り消しと作り直し | E8 で作成 | `payroll-run-state-machine` |
| `payday-peak-capacity.md` | 支給日の前の 5 日の容量の準備 | E8 で作成 | `payroll-concurrency-and-priority` |
| `rule-table-import-and-verify.md`、`rule-table-correction.md` | 規則表の取り込み・照合・公開と、公開の後の訂正 | E8 で作成 | `rule-table-ingestion` |
| `parallel-run-monthly-review.md` | 並行稼働の月次の差の確認と承認 | E9 で作成 | `parallel-run-compare` |
| `payment-return-handling.md` | 振込の不能・組戻しと再支払い | E10 で作成 | `payment-returns-and-reissue` |
| `gl-export-rejected.md` | 会計システムが束を拒んだとき | E10 で作成 | `gl-export` |
| `employer-si-notice-adjustment.md` | 納入告知の取り込みと調整の仕訳 | E10 で作成 | `employer-si-adjustment` |
| `proxy-login-review.md` | 本番の代理のログインの記録の定期の確認 | E11 で作成 | `proxy-login` |
| `vault-break-glass.md` | 保管庫の緊急の操作（3 者） | E11 で作成 | `vault-break-glass-procedure` |
| `retention-purge-run.md`、`legal-hold.md` | 保存の期間の削除の実行、保全の設定と解除 | E11 で作成 | `retention-purge-jobs`、`legal-holds` |
| `migration-cutover.md` | テナントの切り替えの日の手順 | E12 で作成 | `migration-loads` |
| `tenant-offboarding-crypto-erase.md` | 解約のテナントの鍵の削除 | E12 で作成 | `tenant-offboarding` |
| `analytics-export-lag.md` | 分析用の基盤の書き出しの遅れ | S2 の前に作成 | （延期の一覧） |

- 支給日の前のリージョンの障害で大阪から振込ファイルを出す手順は、別の runbook を作らず [disaster-recovery.md](disaster-recovery.md) の「E. 支給日の DR」を使う（payments-and-accounting の `payday-dr-bank-file` の提案をまとめた）。

### 4.1 領域との対応

| 領域 | アラート・手順 |
| --- | --- |
| [object-model-and-effective-dating.md](../architecture/object-model-and-effective-dating.md) | `temporal-consistency-mismatch.md`、`activation-backlog.md`、`rescind-chain.md` |
| [core-hr.md](../architecture/core-hr.md) | `org-closure-rebuild.md`、`reorg-partial-failure.md`、`april-mass-transfer.md`、`duplicate-worker-merge.md` |
| [business-process-engine.md](../architecture/business-process-engine.md) | `bp-stuck-steps.md`、`bp-timer-lag.md`、`bp-bad-definition-rollback.md`、`bp-partial-bulk.md` |
| [security-model.md](../architecture/security-model.md) | `security-policy-rollback.md`、`sod-violation-report.md`、`authz-deny-spike.md`、`proxy-login-review.md`、[incident-response.md](incident-response.md) の「テナントの分離の破れ、権限の迂回」 |
| [time-and-attendance.md](../architecture/time-and-attendance.md) | `clock-ingest-backlog.md`、`objective-log-import-failure.md`、`overtime-alert-job-delay.md`、`time-period-reopen.md` |
| [absence-and-leave.md](../architecture/absence-and-leave.md) | `leave-grant-job-catchup.md`、`leave-balance-rebuild.md`、`uniform-grant-cutover.md` |
| [payroll-engine.md](../architecture/payroll-engine.md) | `payroll-run-stuck.md`、`payroll-reproducibility-mismatch.md`、`payroll-cancel-and-rerun.md`、`payday-peak-capacity.md`、`parallel-run-monthly-review.md`、[incident-response.md](incident-response.md) の「給与の計算の誤り」 |
| [payroll-jp-rules.md](../architecture/payroll-jp-rules.md) | `statutory-rate-calendar.md`、`rule-table-import-and-verify.md`、`rule-table-correction.md`、`resident-tax-notice-import.md` |
| [payments-and-accounting.md](../architecture/payments-and-accounting.md) | `bank-file-release.md`、`payment-return-handling.md`、`payslip-publish-delay.md`、`gl-export-rejected.md`、`employer-si-notice-adjustment.md`、[disaster-recovery.md](disaster-recovery.md) の E |
| [self-service-ui.md](../architecture/self-service-ui.md) | `ui-asset-release-rollback.md`、`clock-ingest-backlog.md` |
| [reporting.md](../architecture/reporting.md) | `report-reader-saturation.md`、`analytics-export-lag.md`（S2） |
| [integrations-and-bulk.md](../architecture/integrations-and-bulk.md) | `bp-partial-bulk.md`、`migration-cutover.md`、`idp-outage.md`、`webhook-endpoint-disabled.md`、`clock-terminal-silent.md` |
| [my-number-vault.md](../architecture/my-number-vault.md) | `vault-access-log-gap.md`、`mn-deletion-overdue.md`、`vault-break-glass.md`、[incident-response.md](incident-response.md) の「マイナンバーの漏えいの疑い」 |
| [audit-and-retention.md](../architecture/audit-and-retention.md) | `audit-chain-verification-failure.md`、`audit-archiver-lag.md`、`retention-purge-run.md`、`legal-hold.md` |
| [security.md](../architecture/security.md) | [incident-response.md](incident-response.md)、`tenant-offboarding-crypto-erase.md`、`vault-break-glass.md`、`operator-access-review.md` |
| [infrastructure.md](../architecture/infrastructure.md)、[capacity.md](../architecture/capacity.md) | [disaster-recovery.md](disaster-recovery.md)、`payday-peak-capacity.md` |
| [delivery.md](../architecture/delivery.md) | [deploy-and-rollback.md](deploy-and-rollback.md)、`statutory-rate-calendar.md` |
| [observability.md](../architecture/observability.md) | アラートの条件の実装側（5.2 節） |
| [data-model.md](../architecture/data-model.md) | データモデルの正本。運用の対象は各領域の文書で扱う（保存の期間の削除は `retention-purge-run.md`） |

## 5. 定期作業と訓練

訓練の合格基準は [quality.md](../quality.md) の 2.4 節（QA が判定する）。手順は [disaster-recovery.md](disaster-recovery.md) の G。

| 作業 | 頻度 | 手順 |
| --- | --- | --- |
| **支給日の DR の訓練**（staging。支給日の 1 営業日前を模し、書き込みを続けたまま東京を止め、大阪から振込ファイルを出す。二重の提出の確認の手順） | 四半期 | [disaster-recovery.md](disaster-recovery.md) の E・G（合格：振込ファイルまで 2 時間以内、承認のハッシュと一致） |
| **大阪での振込ファイルの作り直しとハッシュの一致**（本番。書き込みはしない） | 支給日の前の 5 営業日は毎日、それ以外は週 1 回 | [infrastructure.md](../architecture/infrastructure.md) の 6.4 節（不一致は SEV2） |
| AZ の障害の訓練（staging。FIS で 1 AZ を切り離す） | 半年 | [disaster-recovery.md](disaster-recovery.md) の A・G |
| リージョンの切り替えの訓練（計画外。staging） | 年 2 回 | [disaster-recovery.md](disaster-recovery.md) の B・G |
| 本番の switchover（大阪で運用して戻す。支給日の前の 5 営業日と凍結の日を避ける） | 年 1 回 | [disaster-recovery.md](disaster-recovery.md) の B・G |
| PITR からの復元（prod の中の隔離した VPC） | 四半期 | [disaster-recovery.md](disaster-recovery.md) の D・G |
| 保管庫の切り替え（vault-staging） | 年 1 回 | [disaster-recovery.md](disaster-recovery.md) の F・G |
| 大阪の待機の構成の確認（合成監視は 1 分ごと、Terraform の差分・KMS のレプリカ・複製は日次、クォータは月次） | 月次 | [infrastructure.md](../architecture/infrastructure.md) の 6.6 節 |
| 監査の連鎖の別の道具での検証（log-archive の任意の日） | 四半期 | [audit-and-retention.md](../architecture/audit-and-retention.md) の 11.3 節 |
| 走査の生存の確認（合成の番号） | 日次（自動） | [observability.md](../architecture/observability.md) の 4.3 節 |
| S3 の抜き取りの走査（入力の文書、レポートの出力、取り込みのファイル） | 四半期 | 同上 |
| 職務分掌の夜間の走査、有効日付の夜間の検査、再現の抜き取り、合成の給与の実行（毎日 6 時） | 日次（自動） | [quality.md](../quality.md) の 4.2 節 |
| 規則表の改正の暦の監視（公的な資料の頁の変化） | 週 1 回と、監視の開始の日の手の確認 | `statutory-rate-calendar.md`（3.2 節） |
| 住民税の通知の取り込みと 6 月の実行の前の検査 | 毎年 5 月 | `resident-tax-notice-import.md` |
| 4 月 1 日の発効と定期の異動の準備（予定の件数の監視、bp-worker の予定のスケール） | 毎年 3 月 | `april-mass-transfer.md` |
| 支給日の前の容量の準備（給与の用の reader、Payroll Compute の上限） | 毎月（支給日の 5 営業日前） | `payday-peak-capacity.md` |
| 負荷試験（7 シナリオ） | 半年ごと、E12、大きな変更の後 | [capacity.md](../architecture/capacity.md) の 7 節 |
| キャパシティの見直し（支給日の前のピーク、始業の打刻のピーク、段階を上げる基準） | 月次 | [capacity.md](../architecture/capacity.md) の 8 節 |
| 大口のテナント（1 万人以上）の本番の開始の承認 | 開始のたび | 同上 |
| 費用の見直し（アカウントとタグごと） | 月次 | [infrastructure.md](../architecture/infrastructure.md) の 11 節 |
| 運用者のアクセスレビュー（権限の割り当てと期限つきの権限の使用） | 四半期 | `operator-access-review.md` |
| 本番の代理のログインの記録の確認 | 月次 | `proxy-login-review.md` |
| 外部のペンテスト | E12（GA の前）、以後年 1 回と大きな変更の後 | [security.md](../architecture/security.md) の 8 節 |
| DAST（staging） | 夜間とリリースの前 | 同上 |
| インシデント対応の机上訓練（マイナンバーの漏えい、給与の計算の誤り） | 年 1 回 | [incident-response.md](incident-response.md) |
| 訓練の記録の見直し（目標の未達を Intent へ） | 四半期 | 各 runbook の「事後」 |

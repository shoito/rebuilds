# Design log: Workday

設計の工程ごとに決めたことの記録。今の結論は [README.md](README.md) と各領域の文書と ADR にあり、ここはその経緯を残す。新しい記録は末尾に足す。

記録は README.md から本文のまま移したもので、本文の中の「1.4 節」「6 節」などの節の番号は、[README.md](README.md) の節を指す。

## 2026-09-28：既定案

PM の方針（「判断が要るところは推奨の既定案でよい」）により、統合の工程で次のとおり決めた。法務・社労士・税理士の判断が要るものは決めず、[intent.md](../intent.md) の「法務・社労士・税理士の確認待ち」に残した。ADR を直したものには、日付付きの注記を残した（[process.md](../../../../docs/process.md) の 9 節）。

- **ADR と intent の状態**：基盤の ADR（0001〜0005）と intent.md は、他の題材と同じく `accepted`（確かめた）。先に次を直した。
  - ADR-0001：`Dec` の桁を、[ADR-0027](../decisions/0027-pay-item-graph-and-formula-language.md) の小数 10 桁に揃えた（注記）。
  - ADR-0005：個人情報保護委員会のガイドラインを、令和 7 年 6 月の一部改正のバージョンに直した（注記）。職務分掌の例の表の正本が [security-model.md](security-model.md) の 5.1 節であることと、ドメインの名前の対応を書いた（注記）。
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

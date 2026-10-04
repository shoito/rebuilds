# Security model: Workday

テナントの中の権限を決める。ドメインと項目の権限、業務プロセスの権限、セキュリティグループ、組織で絞るロール、職務分掌の規則と検査、権限の方針の保留と有効化、判定の評価器、代理のログイン、権限の監査と説明の報告を扱う。

前提の決定は、ドメインと業務プロセスの権限・組織で絞るロール・職務分掌の規則表で守り、判定を 1 か所にまとめ、権限の変更を保留と有効化に分けること（[ADR-0005](../decisions/0005-security-and-my-number.md)）。担当のルーティングと委任は [business-process-engine.md](business-process-engine.md)、組織とロールの割り当ては [core-hr.md](core-hr.md) にある。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0017](../decisions/0017-authorization-evaluator.md) | 判定は自前の評価器で行う。有効な方針のバージョンとグループの所属から、利用者ごとの権限（ドメイン、操作、範囲の根の組織）を畳んだ表を作り、1 件の判定は関数で、一覧は組織の閉包を使う SQL の条件で絞る。拒否が既定で、権限は和で決まる |
| [0018](../decisions/0018-security-policy-versions-and-activation.md) | 権限の方針（どのグループにどのドメイン・業務プロセスの権限を与えるか）はバージョンで持ち、下書きを別の人が有効化する。戻すときは前のバージョンの写しを有効化する。グループの所属とロールの割り当ては業務プロセスで変え、完了で効く |
| [0019](../decisions/0019-segregation-of-duties-checks.md) | 職務分掌は、両立しない権限の組の規則表で持ち、範囲が重なるときに違反とする。方針の有効化、所属・ロールの変更の完了、案件の操作、夜間の走査の 4 か所で検査する。システムの規則は止め、テナントの規則は止めるか警告かを選べる |
| [0020](../decisions/0020-sensitive-read-audit-and-access-explanations.md) | 給与・口座・扶養・要配慮などの機微なドメインの閲覧を記録する。判定に理由（どの権限で許したか）を付け、「この人は何を見られるか」「この項目を誰が見られるか」を出す。本番の代理のログインは、読み取りだけ・30 分・理由つきに限る |

## 1. 目的と範囲

- 扱う：ドメインの一覧と項目の割り当て、操作、セキュリティグループの種類と所属、組織で絞るロールの範囲、業務プロセスの権限、判定の API（1 件、一覧、項目の射影）と評価器、キャッシュ、権限の方針のバージョンと有効化、職務分掌の規則表と検査、機微な情報の扱い、代理のログイン、権限の監査と説明の報告。
- 扱わない：テナントの分離と RLS（[ADR-0005](../decisions/0005-security-and-my-number.md) と [infrastructure.md](infrastructure.md)）、ログインと SSO（[integrations-and-bulk.md](integrations-and-bulk.md)）、マイナンバーの保管庫の権限（[my-number-vault.md](my-number-vault.md)）、監査ログの保管と改ざんの検知（[audit-and-retention.md](audit-and-retention.md)）、暗号と鍵（[security.md](security.md)）。
- **画面・API・レポート・一括の出力・連携は、すべてこの判定を通す**（[AGENTS.md](../../AGENTS.md)）。

## 2. 本家の形（確かめたこと）

どれも 2026-09-28 に確認した。本家の実装は使わない（[リポジトリ共通の ADR-0007](../../../../docs/decisions/0007-no-reuse-of-original-implementation.md)）。

| 本家の考え方 | 内容 | このシステムでの扱い |
| --- | --- | --- |
| ドメインの権限 | ドメインの方針は、画面・レポートの View・Modify と、連携の Get・Put で、セキュリティグループに権限を与える（[Security](https://doc.workday.com/workday-education/en-us/course-manuals/financial-management-for-administrators/security.html)。検索の要約を含む） | 同じ 4 つの操作（3.2 節） |
| 範囲で絞る | 絞られたグループは、組織などで対象の一部だけに届く。絞らないグループは全部に届く。両方に属すれば和になる（[Security Group Configuration and Constraints](https://doc.workday.com/workday-education/en-us/course-manuals/security-for-administrators/security-group-configuration-and-constraints.html)） | 範囲は `all`・`orgs`・`self`。権限は和（4.2 節、[ADR-0017](../decisions/0017-authorization-evaluator.md)） |
| 交差のグループ | 含めたグループのすべてに属し、除くグループに属さない人だけを含む（[Advanced Security Group Types](https://doc.workday.com/workday-education/en-us/course-manuals/hcm-core-supplemental-for-administrators/advanced-security-group-types.html)、2026-09-28 に検索の要約で確認） | `intersection` のグループ（4.1 節） |
| 保留と有効化 | ドメイン・業務プロセスの方針の変更は、有効化の作業を行うまで保留される。有効化の時刻を記録し、前の時刻のバージョンを有効化して戻せる。方針の編集と有効化は別のドメインにあり、別のグループに持たせられる。グループの定義と所属の変更は、有効化を待たずにすぐ効く（[Security Policy Configuration and Activation](https://doc.workday.com/workday-education/en-us/course-manuals/security-for-administrators/security-policy-configuration-and-activation.html)） | 同じ考え方（[ADR-0018](../decisions/0018-security-policy-versions-and-activation.md)）。ただし所属とロールの変更は業務プロセスの承認を経る |
| 職務分掌の報告 | 職務分掌の潜在的な衝突の報告がある（検索の要約。報告の中身は未検証） | 規則表と 4 か所の検査（[ADR-0019](../decisions/0019-segregation-of-duties-checks.md)） |
| 同じ権限がすべての経路に効く | レポート・モバイル・API・業務プロセスに同じ権限が効く（[ホワイトペーパー](https://www.workday.com/content/dam/web/en-us/documents/whitepapers/whitepaper_workday_technology_platform_devt_process.pdf)） | 同じ（7 節） |

- 本家の代理のログイン（proxy）の条件（本番で使えるか、記録の形）は確かめられなかった（未検証）。本システムの規則は 9 節で決める。

## 3. ドメインと項目の権限

### 3.1 ドメインの一覧（初期）

ドメインの一覧と、項目・操作のドメインへの割り当ては、システムが持つ。テナントは変えられない（[ADR-0005](../decisions/0005-security-and-my-number.md)）。

| ドメイン | 中身 | 機微 |
| --- | --- | --- |
| `worker.public` | 表示の名前、写真、所属、職位、仕事の連絡先（組織図） | |
| `worker.personal` | 氏名（全表記）、旧姓、生年月日、性別、国籍 | ○ |
| `worker.address` | 住所 | ○ |
| `worker.contact` | 個人の電話・メール、緊急連絡先 | |
| `worker.dependents` | 扶養の親族 | ○ |
| `worker.job` | 職務の割り当て、ポジション、等級、事業所 | |
| `worker.employment` | 在籍の状態、雇用区分、入社日・退職日、契約 | |
| `worker.employment.leave_type` | 休職の種類 | ○ |
| `worker.employment.termination_details` | 退職の理由、解雇の警告への理由 | ○ |
| `worker.compensation` | 基本給、手当 | ○ |
| `worker.payment_election` | 振込先の口座 | ○ |
| `worker.sensitive` | 要配慮個人情報（MVP は項目なし。既定でどのグループにも与えない） | ◎ |
| `org.structure` | 組織、階層、ロールの割り当て | |
| `position.management` | ポジション、職務の目録 | |
| `time.records`・`absence` | 勤怠と休暇 | |
| `payroll.input`・`payroll.results`・`payroll.run` | 給与の入力、結果、実行 | ○ |
| `security.config` | 方針の下書きの編集、グループの定義 | |
| `security.activation` | 方針の有効化 | |
| `security.admin` | テナントの管理の設定（SSO の接続、API の利用者、打刻機の鍵、Webhook、代理のログインの開始） | |
| `bp.definition.config`・`bp.definition.activation` | 業務プロセスの定義の編集と有効化 | |
| `audit` | 監査ログ、`known_at` の問い合わせ | ○ |
| `my_number` | 保管庫の操作（判定は保管庫の側。[my-number-vault.md](my-number-vault.md)） | ◎ |

- 「機微」の列の ○ と ◎ のドメインを、この文書では「機微なドメイン」と呼ぶ（閲覧の記録、`aggregate` の抑止、退職者の閲覧の期間の対象。10 節、3.2 節、4.2 節）。
- 有効日付の facet の各項目は、ちょうど 1 つのドメインに属する。facet の宣言（[object-model-and-effective-dating.md](object-model-and-effective-dating.md) の 3 節）にドメインを書き、CI で「ドメインのない項目」を拒む。

### 3.2 操作

| 操作 | 経路 | 意味 |
| --- | --- | --- |
| `view` | 画面・API・レポート | 読む |
| `modify` | 画面・API | 業務プロセスを経ずに変えられる設定だけ（組織の表示の名前の翻訳など）。人事のデータの変更は業務プロセスの権限で決まる |
| `get` | 連携・一括の出力 | 読む |
| `put` | 連携・一括の取り込み | 一括の取り込みの起票。業務プロセスを経る |
| `aggregate` | レポート | 機微なドメインの値を、個々の値を見ずに集計（`sum`・`avg`・`min`・`max`）だけで見る。結果は必ず少人数の抑止（[reporting.md](reporting.md) の 7 節、[ADR-0041](../decisions/0041-small-cell-suppression-for-sensitive-aggregates.md)）を通る。`view` を持つ人には要らない |

- 人事のデータの変更の権限は、ドメインの `modify` ではなく、業務プロセスの権限（4.3 節）で決まる。ドメインの `modify` は、業務プロセスを持たない設定だけに使う。
- `aggregate` は、`view` を含まない。`aggregate` だけを持つ人は、1 件の判定（`can`）と一覧の行の値（`project`）では、その列を落とされる。部門の長に人件費の合計だけを見せる運用のために足した（統合の工程で決めた。[reporting.md](reporting.md) の 14 節）。

### 3.4 運用者の権限（テナントの外）

テナントの方針の外にある、本システムの運用者の権限。IAM Identity Center の運用者のグループで持ち、テナントの管理者には与えない。操作はプラットフォームの監査（`platform_audit_events`）に残す。

| 権限 | 意味 | 決めた場所 |
| --- | --- | --- |
| `rules.import` | 規則表・保存の期間の規則表の取り込み（取得、読み取り、自動の検査） | [payroll-jp-rules.md](payroll-jp-rules.md) の 2.2 節、[ADR-0030](../decisions/0030-rule-table-ingestion-and-verification.md) |
| `rules.verify` | 取り込んだバージョンの独立の照合（`verified_by ≠ imported_by`） | 同上 |
| `rules.publish` | 照合済みのバージョンの本番への公開（Ops の承認。コードのデプロイとは別の操作） | [delivery.md](delivery.md) の 6 節、[ADR-0062](../decisions/0062-rule-table-release-calendar.md) |

- 取り込みと照合を同じ人に持たせない（5.1 節の S8）。同じバージョンで、`imported_by` と `verified_by` が同じなら、`verified` にする操作を DB の制約でも拒む。

### 3.3 項目の射影

- 判定の結果は「行を見られるか」と「どの項目を見られるか」の 2 段にする。API の応答は、見られない項目を落とし、`redacted: ["worker.compensation"]` のように、落としたドメインの名前だけを返す（値の有無を推測させない）。
- レポートの列も同じ射影を通す（[reporting.md](reporting.md)）。
- 業務プロセスの承認の画面は、担当のドメインの権限で項目を絞る。委任のときは委任した人と代理人の共通部分（[business-process-engine.md](business-process-engine.md) の 7 節）。

## 4. セキュリティグループとロール

### 4.1 グループの種類

| 種類 | 所属の決まり方 | 範囲 | 所属の変更 |
| --- | --- | --- | --- |
| `user` | 人を直接割り当てる | `all` か、グループに書いた組織（`orgs`） | `security_group_membership_change` の業務プロセス |
| `role` | 組織のロールの割り当て（組織×ポジション。[core-hr.md](core-hr.md) の 4.5 節） | 割り当てた組織。下位を含むかは割り当てごと | `role_assignment_change` の業務プロセス |
| `job` | 職務（`job_profile`）・等級から自動 | `all` か、本人の所属の組織 | 職務の変更の業務プロセスで自動に変わる |
| `org_membership` | ある組織（と下位）に所属する人 | `all` | 異動で自動に変わる |
| `self` | 対象が本人 | `self` | なし（全員） |
| `intersection` | 2〜4 のグループのすべてに属する人 | 構成のグループの範囲の共通部分 | 構成で決まる |

- 例：「人事部に所属し、かつ、職務が人事の担当」の交差で、人事の担当の画面の権限を与える。
- `job` と `org_membership` は、異動・昇格で所属が暗に変わる。職務分掌の検査を、その業務プロセスの完了でも行う（5.3 節）。
- 上限：1 テナントのグループ 2,000、交差の構成 4、1 人の所属（暗に決まるものを含む）200。

### 4.2 範囲の判定（DT-SEC-001）

対象（見られる側）の組織は、対象の職務の割り当ての監督組織（兼務を含む全部）とする。日付は、問い合わせの `effective_on` と今日の早いほう。退職した人は、退職日の時点の組織。

| # | グループの範囲 | 対象 | 対象の組織が範囲の根の下位（閉包） | 下位を含む | 結果 |
| --- | --- | --- | --- | --- | --- |
| 1 | `orgs` | 退職して 3 年を過ぎた人で、判定のドメインが機微（3.1 節の ○・◎） | - | - | 当たらない（`all` の範囲の権限か、`audit` の権限だけが許す） |
| 2 | `all` | - | - | - | 許す |
| 3 | `self` | 本人 | - | - | 許す |
| 4 | `self` | 本人でない | - | - | 当たらない |
| 5 | `orgs` | - | 根と同じ組織 | - | 許す |
| 6 | `orgs` | - | 根の下位 | はい | 許す |
| 7 | `orgs` | - | 根の下位 | いいえ | 当たらない |
| 8 | `orgs` | - | どちらでもない | - | 当たらない |
| 9 | `orgs` | 対象が組織・ポジション（人でない） | 対象そのものが根か下位 | 6・7 と同じ | 6・7 と同じ |

- 上から評価し、最初に当たった行を採る。どの行も「許す」にならなければ拒む（既定で拒否）。
- 保存の期間を過ぎて削除された人は、行がないので、どの権限でも見えない。
- 範囲は「根の組織の ID」で持ち、下位への展開は判定のときに閉包（[ADR-0011](../decisions/0011-effective-dated-org-hierarchy-closure.md)）で行う。組織の再編で権限の表を作り直さずに済む。
- **退職者の閲覧の期間と保存の期間を分ける**（統合の工程で決めた。[data-model.md](data-model.md) の 6 節の DM-5）：
  - 人事の担当は、退職者の機微でないドメイン（`worker.public`・`worker.job`・`worker.employment` など）を、保存の期間（既定 5 年。[audit-and-retention.md](audit-and-retention.md) の 5.2 節）の間ずっと、退職日の時点の組織の範囲で見られる。在籍の証明、退職の証明（労基法 22 条）、再雇用、労働基準監督署や税務の調査への対応に要るからである。
  - 機微なドメイン（住所、扶養、給与、口座、休職の種類、退職の理由など）は、退職から 3 年を過ぎたら、全社の範囲の担当（`all`）か監査の権限だけにする。3 年は、記録の保存の経過措置（労基法 143 条の当分の間 3 年、規則附則 71 条）と、賃金の請求権の時効（115 条・143 条の当分の間 3 年）に合わせた。3 年を過ぎた記録は、法定の保存と調査のために残しているだけで、日々の業務で組織の担当が見る必要は薄い。見られる人を絞ると、漏えいの面が小さくなる。
  - 5 年の保存は、経過措置の後の本来の期間（109 条の 5 年）と、確認待ちの間は長いほうで動かす規則（[ADR-0049](../decisions/0049-retention-rules-table-and-legal-hold.md)）による。L5・L51 の確認で保存の期間が変わっても、閲覧の 3 年はそれを超えない限りそのまま使う。

### 4.3 業務プロセスの権限

業務プロセスの種類ごとに、次の操作の権限をグループに与える。

| 操作 | 意味 |
| --- | --- |
| `initiate` | 起票（`self` のグループで本人の申請を許す） |
| `approve` | 承認の担当の候補になれる。担当はルーティングで決まり（[business-process-engine.md](business-process-engine.md) の 5 節）、候補がこの権限を持たなければ除く |
| `view` | 案件を見る |
| `cancel`・`rescind`・`correct` | キャンセル・取消・訂正の起票 |
| `reassign` | 担当の差し替え |
| `retro_override` | 90 日より前の過去日付の変更の起票（[object-model-and-effective-dating.md](object-model-and-effective-dating.md) の 3.1 節） |
| `approve_without_route` | 承認なしの訂正を許す定義での訂正（監査の報告に出る） |

業務プロセスの種類によらない特別の権限：

| 権限 | 意味 |
| --- | --- |
| `payroll.retro_override` | 給与の遡及の窓を、既定の 24 か月から 36 か月まで広げる（[payroll-engine.md](payroll-engine.md) の 7.2 節、[ADR-0028](../decisions/0028-retro-deltas-and-bonus-runs.md)）。`payroll.run` のドメインの権限と一緒に与える。使ったことは監査の報告に出る |

- `retro_override`（業務プロセスの操作。90 日より前の過去日付の変更）と `payroll.retro_override`（給与の遡及の窓）は別の権限である。

- 本人の申請（住所、口座、扶養、休暇）の `initiate` は `self` で与える。承認は別の人（[ADR-0005](../decisions/0005-security-and-my-number.md)）。

### 4.4 ロールの割り当てと所属の変更

- ロールの割り当て（`role_assignment_change`）とグループの所属（`security_group_membership_change`）は、業務プロセスを通し、承認を経て、完了で効く（ロールの割り当ては有効日付。将来日付なら発効の日に効く）。
- 本家は所属の変更をすぐ効かせ、有効化を待たない（2 節）。本システムも有効化は待たないが、業務プロセスの承認を要する。権限の変更の経路を 1 つにし、職務分掌の検査（5.3 節）を必ず通すため。
- 完了のトランザクションで、影響を受けた人の権限の表（7.2 節）を作り直し、キャッシュを無効にする。

## 5. 職務分掌（[ADR-0019](../decisions/0019-segregation-of-duties-checks.md)）

### 5.1 規則表

システムの既定の規則（テナントは外せない）と、テナントが足す規則を持つ。

| # | 権限 A | 権限 B | 範囲 | 強さ |
| --- | --- | --- | --- | --- |
| S1 | `compensation_change` の `initiate`・`approve` | `payroll_finalize` の `approve` | 重なるとき | 止める |
| S2 | `payment_election_change` の `approve`（本人以外） | 振込ファイルの承認（`payroll_payment_release` の `approve`） | 重なるとき | 止める |
| S3 | `security.config` の `modify` | `security.activation` の `modify` | 常に | 止める |
| S4 | `payroll.input` の `modify`（個別の調整） | `payroll_finalize` の `approve` | 重なるとき | 止める |
| S5 | `bp.definition.config` の `modify` | `bp.definition.activation` の `modify` | 常に | 止める |
| S6 | `role_assignment_change`・`security_group_membership_change` の `initiate` | 同じ業務プロセスの `approve` | 常に | 止める（案件ごとの検査で。5.3 節の #3） |
| S7 | `hire` の `initiate` | `payment_election_change` の `approve` | 重なるとき | 警告（架空の従業員への振込の防止。テナントが止めるに変えられる） |
| S8 | `rules.import`（運用者） | `rules.verify`（運用者） | 常に（同じバージョンで） | 止める（3.4 節。規則表の書き換えで多くの人の控除を変える脅威 THR-024） |

- 「範囲が重なる」：A と B の範囲の根の組織の下位（閉包）に、共通の組織が今日あるとき。`all` はすべてと重なる。
- テナントの規則は、同じ形（権限 A、権限 B、範囲、強さ）で足す。強さは `block`・`warn`。

### 5.2 規則の評価

利用者 U の権限の表（7.2 節）に対して、規則ごとに A と B の両方の権限を持ち、範囲が重なるかを見る。結果は「違反なし」「警告の違反」「止める違反」。

### 5.3 検査点（DT-SEC-002）

| # | 検査点 | 対象 | 止める違反 | 警告の違反 |
| --- | --- | --- | --- | --- |
| 1 | 方針の有効化（8 節） | 新しいバージョンでの、テナントの全員 | 有効化を拒み、違反の一覧を出す | 有効化の画面で一覧を示し、確認を求める |
| 2 | 所属・ロールの割り当て・職務の変更・異動の案件の完了 | 所属が変わる人 | 完了を拒み、起票者に戻す（[business-process-engine.md](business-process-engine.md) の 6.3 節） | 完了し、報告に出す |
| 3 | 案件の操作（承認・完了） | 操作者（委任では代理人と委任した人） | 起票者 ＝ 承認者なら拒む。案件の種類の承認の権限 B と両立しない権限 A を、案件の対象の範囲で持つなら拒む | 記録する |
| 4 | 夜間の走査 | テナントの全員 | 検査点 1・2 を抜けた違反（規則の追加の前からある違反、組織の再編による範囲の重なり）を SEV3 で報告し、テナントの管理者に知らせる。自動では権限を外さない | 報告に出す |

- 検査点 2 で拒まれた職務の変更は、所属の変更（`job` のグループ）を伴わない形で出し直すか、権限の方針を先に直す。
- 規則表の変更（テナントの規則の追加）も方針のバージョンの一部として有効化する。有効化のときに既存の違反を検査点 1 で出す。

### 5.4 例外

- システムの規則（S1〜S6、S8）に例外は作れない。
- 小さなテナント（管理者が 1 人）で S3・S5 を満たせないときは、本システムの支援の窓口が有効化の承認者を代わる運用を持つ（16 節の持ち越し）。

## 6. 機微な情報

| 情報 | 扱い |
| --- | --- |
| 口座番号 | 項目ごとにエンベロープ暗号化（[ADR-0005](../decisions/0005-security-and-my-number.md)）。`worker.payment_election` の `view` で、末尾 4 桁の表示だけを復号する。全桁の復号は振込ファイルの生成（Worker）だけ |
| 給与の額 | `worker.compensation`・`payroll.results`。上長には既定で与えない。レポートの集計（組織の合計）も同じ権限を要する。少人数の組織の合計から個人の額が分かる問題は [reporting.md](reporting.md) で扱う |
| 休職の種類、退職の理由 | 別のドメイン（3.1 節）。上長は「休職中」「退職」だけを見る |
| 要配慮個人情報 | `worker.sensitive`。既定でどのグループにも与えない。与えるには方針の有効化の画面で明示の確認と理由を求める。取得の同意と扱いは法務の確認待ち（[intent.md](../intent.md) の L10） |
| マイナンバー | 人事の側のドメインでは `mn_ref` と「登録済み」だけ。番号の操作は保管庫の側の判定（[my-number-vault.md](my-number-vault.md)） |
| 過去の知識（`known_at`） | `audit` の権限を加えて要る（[object-model-and-effective-dating.md](object-model-and-effective-dating.md) の 11 節） |

- 機微なドメインの閲覧は記録する（10 節）。

## 7. 判定の評価器（[ADR-0017](../decisions/0017-authorization-evaluator.md)）

### 7.1 API

```ts
// Single decision (screen/API). Returns reason for audit and explanations.
can(ctx: AuthzContext, op: Op, domain: Domain, target: TargetRef): Decision;
// { allow: boolean, grants: GrantId[], denyReason?: "NO_GRANT" | "SCOPE" | "SOD" | "SELF_APPROVAL" }

// List filter (lists, reports, bulk export). Returns a SQL predicate on the target's org.
scopeFilter(ctx: AuthzContext, op: Op, domain: Domain): SqlFragment;

// Field projection for a record already allowed at row level.
project<T>(ctx: AuthzContext, op: Op, target: TargetRef, record: T): Projected<T>;

// Business process operation.
canBp(ctx: AuthzContext, op: BpOp, processType: string, target: TargetRef): Decision;
```

- `AuthzContext` は、テナント、利用者、実際の操作者（委任・代理のログイン）、方針のバージョン、所属のバージョン、今日の日付を持つ。要求の始めに 1 回作る。
- 判定のコードは `packages/authz` に 1 つだけ置く。API・Worker・BP Worker・レポート・一括の出力が同じ関数を呼ぶ。`packages/authz` の外で、グループ・方針の表を読んで権限を決めるコードを lint で禁じる。

### 7.2 権限の表

```sql
security_policy_versions (tenant_id, version int, status, body jsonb, body_hash,
                          created_by, activated_by, activated_at, comment,
                          PRIMARY KEY (tenant_id, version))
-- body: grants = [{group_id, domain|process_type, ops[]}], sod_rules = [...]

security_groups (tenant_id, id, kind, definition jsonb, ...)
security_group_members (tenant_id, group_id, worker_id, scope_roots uuid[], include_sub bool,
                        valid daterange, source_case_id)   -- user / explicit only; effective-dated

-- Derived: per user, per active policy version.
security_effective_grants (tenant_id, worker_id, policy_version, membership_version,
                           domain_or_bp text, op text,
                           scope_kind text,          -- all / orgs / self
                           scope_roots uuid[], include_sub bool,
                           grant_ids uuid[],
                           PRIMARY KEY (tenant_id, worker_id, domain_or_bp, op, scope_kind, ...))
```

- 権限の表は、方針の有効化、所属・ロールの変更の完了、発効の日（ロールの割り当ての将来日付）に、影響を受けた人だけ作り直す。`self` の権限は全員に共通なので行を持たない（評価器が方針のバージョンから直接読む）。
- 1 件の判定：権限の表の行（キャッシュ）から、ドメイン・操作に当たる行を取り、範囲を DT-SEC-001 で判定する。組織の下位の判定は閉包の索引の引き（[ADR-0011](../decisions/0011-effective-dated-org-hierarchy-closure.md)）。
- 一覧：`scopeFilter` が、`all` なら条件なし、`orgs` なら「対象の組織が根の下位」の `EXISTS` を閉包に対して作る。レポートは同じ条件を SQL に入れる（別の経路で DB を読まない）。

```sql
-- scopeFilter for orgs roots [$r1, $r2], include_sub = true
EXISTS (SELECT 1 FROM org_closure c
         WHERE c.tenant_id = t.tenant_id
           AND c.ancestor_id = ANY($roots)
           AND c.descendant_id = t.org_id
           AND c.valid @> $asof::date)
```

### 7.3 キャッシュ

- 利用者ごとの権限の表を、Valkey に `(tenant, worker, policy_version, membership_version)` の鍵で置く（失われてもよい。DB から作り直す）。
- バージョンが変われば鍵が変わるので、古いキャッシュは使われない。所属のバージョンは、業務プロセスの完了と発効のタイマーで上げる（[object-model-and-effective-dating.md](object-model-and-effective-dating.md) の 8 節）。
- 範囲は根の組織の ID で持つので、組織の再編ではキャッシュを捨てなくてよい（閉包を判定のときに引く）。
- 判定の結果（許す・拒む）そのものはキャッシュしない。

### 7.4 性能の目標

| 判定 | 目標 |
| --- | --- |
| `can`（権限の表がキャッシュにある） | p99 1ms 以内（閉包の引きを含む） |
| `scopeFilter` を入れた一覧（1 組織 500 人） | 一覧の p95 500ms の中に収まる（NFR-005） |
| 方針の有効化での権限の表の作り直し（3 万人のテナント） | 5 分以内（背景で。有効化の切り替えは作り直しの後の 1 トランザクション） |

## 8. 権限の方針の保留と有効化（[ADR-0018](../decisions/0018-security-policy-versions-and-activation.md)）

```
 draft ──(security_policy_activation の案件を起票)──▶ pending_activation ──(承認・完了)──▶ active
   ▲                                                         │                             │
   └────────────────────── 却下・キャンセル ◀────────────────┘                  次のバージョンの有効化で superseded
```

- テナントに下書きのバージョンは 1 つだけ。`security.config` の権限の人が編集する（楽観ロック）。
- 有効化は `security_policy_activation` の業務プロセス。承認者は `security.activation` の権限の人で、編集者と別（S3）。
- 有効化の前に、背景で新しいバージョンの権限の表を作り、職務分掌の検査点 1 を行い、前のバージョンとの差（誰がどの権限を得る・失うか）を承認の画面に出す。
- 完了のトランザクションで、テナントの有効なバージョンの指し先を新しいバージョンに切り替える。以後の要求は新しいバージョンで判定する。進行中の要求は、始めに作った `AuthzContext` のバージョンで最後まで判定する。
- 戻すときは、前のバージョンの中身を写した新しい下書きを作り、同じ手順で有効化する。本家の「前の時刻を有効化する」に当たる。
- 将来の日時の有効化は MVP では持たない。

## 9. 代理のログイン（[ADR-0020](../decisions/0020-sensitive-read-audit-and-access-explanations.md)）

- 目的：テナントの権限の管理者が、ある利用者の見え方を確かめる。
- テナントの検証用の環境（sandbox）では、`security.admin` の権限の人が、理由を入力して代理でログインできる（2 時間、操作も可）。
- 本番のテナントでは、読み取りだけ、30 分、理由の入力、`security.admin` と `audit` の両方の権限、の条件で許す。代理の間は、機微なドメイン（6 節）と `my_number` を見せない。
- 代理の間のすべての要求に、本人と代理の両方を記録する。代理のログインの開始と終了を、テナントの監査の担当に通知する。
- 本システムの運用者（サポート）は、テナントの利用者として代理でログインしない。見え方の確認は、データを出さない「権限の説明」（10.2 節）で行う。

## 10. 監査と説明の報告（[ADR-0020](../decisions/0020-sensitive-read-audit-and-access-explanations.md)）

### 10.1 記録するもの

| 事象 | 記録 |
| --- | --- |
| 方針の下書きの編集、有効化、戻し | バージョン、差分、編集者、承認者、時刻、コメント |
| 所属・ロールの割り当ての変更 | 案件、前後、有効日 |
| 職務分掌の違反（止めたもの、警告、夜間の走査） | 規則、利用者、範囲、検査点 |
| 機微なドメインの閲覧 | 利用者（実際の操作者と代理）、対象の人、ドメイン、経路（画面・API・レポート・一括）、要求の ID、許した権限の ID |
| 拒否 | 利用者、ドメイン、操作、対象、理由のコード（大量になりうるので、1 利用者・1 ドメイン・1 時間ごとに件数をまとめる） |
| 代理のログイン | 開始、終了、理由、全要求 |

- 一覧・レポートでの機微なドメインの閲覧は、対象の人ごとではなく、要求ごとに「どの権限で、どの条件で、何件」を記録する。一括の出力は、出力したファイルの対象の人の一覧のハッシュも残す。
- 記録は監査ログの経路（[audit-and-retention.md](audit-and-retention.md)）に書く。記録に項目の値を入れない。

### 10.2 説明の報告

| 報告 | 中身 |
| --- | --- |
| この人は何を見られるか | 利用者 → ドメイン・操作・範囲（根の組織と下位）・由来のグループと権限 |
| この項目を誰が見られるか | ドメイン＋対象の人 → 見られる利用者の一覧と由来 |
| バージョンの差 | 2 つの方針のバージョンの間で、権限を得る・失う利用者 |
| 職務分掌の違反 | 規則ごとの違反の利用者と範囲 |
| 判定の説明 | 1 件の判定（利用者、操作、ドメイン、対象）の結果と、当たった・外れた権限と理由。データは出さない |

- 報告そのものも `security.config` か `audit` の権限を要する。報告の出力も記録する。

## 11. 規模

- S1：100 万人。権限の表の行は、人事・給与・上長など `self` 以外の権限を持つ人（全体の 15% 程度と想定）× 平均 20 行 ≒ 300 万行。
- 最大のテナント（3 万人）の方針の有効化で、4,500 人分の作り直し。
- 機微なドメインの閲覧の記録：人事・給与の担当の画面の閲覧で、1 日 1 テナントあたり数万件。S1 で 1 日数百万件（[audit-and-retention.md](audit-and-retention.md) の容量に入れる）。

## 12. 障害のときの振る舞い

| 障害 | 振る舞い |
| --- | --- |
| Valkey が落ちる | 権限の表を DB から読む。判定は遅くなるが正しい |
| 権限の表の作り直しが遅れる（所属の変更の後） | 所属のバージョンが上がった利用者は、表ができるまで DB の所属から直接評価する（遅い経路）。古い表を使わない |
| 方針の有効化の途中の失敗 | 切り替えは 1 トランザクションなので、前のバージョンのまま。作りかけの表は捨てる |
| 閉包の食い違い | 権限の判定を拒否に倒す（[core-hr.md](core-hr.md) の 10 節） |
| 判定の関数の例外 | 拒否にする（fail closed）。拒否の件数の急増で警告 |
| 誤った方針を有効化した | 前のバージョンの写しを有効化して戻す（runbook）。有効だった間の機微なドメインの閲覧の記録で影響を調べる |

## 13. セキュリティとプライバシー（この仕組み自体）

- 方針・グループ・権限の表のテーブルも `tenant_id` と RLS を持つ。
- 権限の表を書けるのは、評価器の作り直しの処理のロールだけ。アプリのロールは読むだけ。
- 判定のコードと方針の形式の変更は `security:sensitive`（[AGENTS.md](../../AGENTS.md)）。
- 既定の方針（新しいテナント）は、`self` の最小の権限と、テナントの管理者の `security.config`・`security.activation` だけ。人事・給与の権限は、テナントが方針を作って有効化するまで誰にもない。

## 14. テスト

### 14.1 決定表

- DT-SEC-001（範囲の判定）、DT-SEC-002（職務分掌の検査点）、DT-SEC-003（項目の射影：ドメインの権限の組み合わせ × 項目 → 出す・落とす。委任の共通部分を含む）、DT-SEC-004（方針の状態の遷移：下書き・有効化・却下・戻し）を、`spec.md` から読む表駆動テストにする。
- 5.1 節の規則表の各行で、両立しない割り当ての有効化が拒まれる（[ADR-0005](../decisions/0005-security-and-my-number.md) の Confirmation）。

### 14.2 性質ベーステスト

| ID | 性質 |
| --- | --- |
| PROP-SEC-001 | 任意の方針・所属・要求で、API の 1 件の応答、一覧（`scopeFilter`）、レポート、一括の出力の結果が、`can` と `project` の結果と一致する（経路による差がない） |
| PROP-SEC-002 | 任意の 2 テナントで、一方のコンテキストの判定・一覧に、他方の行が出ない |
| PROP-SEC-003 | 方針に権限を足しても、どの判定も許すから拒むに変わらない。外しても、拒むから許すに変わらない（単調） |
| PROP-SEC-004 | 任意の有効化・所属の変更の列の後、有効なバージョンで、止める規則の違反を持つ利用者がいない（夜間の走査の対象の、規則の追加の前からある違反を除く） |
| PROP-SEC-005 | 任意の変更の列の後、キャッシュを使った判定と、キャッシュを使わない判定が一致する |
| PROP-SEC-006 | 下書きの編集は、有効化までどの判定も変えない。前のバージョンの写しを有効化すると、判定はそのバージョンのときと一致する |
| PROP-SEC-007 | 任意の組織の再編の列の後、範囲の判定は、閉包から作り直した判定と一致する |

### 14.3 本番での検査

- 夜間の職務分掌の走査（5.3 節の #4）。
- 抜き取り：ランダムな利用者・対象の組で、API とレポートの判定を突き合わせる（PROP-SEC-001 の本番版）。
- 外部のペンテストで、権限の迂回（ID の書き換え、レポートの列の追加、一括の出力の条件）を試す（E12）。

## 15. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E4 | `authz-domains-and-field-map` | 3 節。ドメインの一覧、facet の項目の割り当て、CI の検査 |
| E4 | `authz-evaluator` | 7.1・7.2 節。`can`・`scopeFilter`・`project`（DT-SEC-001・003、PROP-SEC-001・003・007） |
| E4 | `authz-cache` | 7.3 節（PROP-SEC-005） |
| E4 | `security-groups` | 4.1 節のグループの種類と所属、所属の変更の業務プロセス |
| E4 | `bp-security-policies` | 4.3 節。業務プロセスの権限と、エンジンとの結合 |
| E4 | `security-policy-versions` | 8 節（DT-SEC-004、PROP-SEC-006） |
| E4 | `sod-rules-and-checks` | 5 節（DT-SEC-002、PROP-SEC-004）。規則表、4 つの検査点、夜間の走査 |
| E4 | `tenant-isolation-properties` | PROP-SEC-002（RLS と判定の両方） |
| E11 | `sensitive-read-audit` | 10.1 節 |
| E11 | `access-explanation-reports` | 10.2 節 |
| E11 | `proxy-login` | 9 節 |
| E12 | `pentest-and-fixes` | 14.3 節の外部のペンテスト（[security.md](security.md) の 8 節の外部のペンテストと 1 つにした） |

## 16. 未解決の問い

### 決定

- **判定は自前の評価器で行う**（[ADR-0017](../decisions/0017-authorization-evaluator.md)）。[architecture/README.md](README.md) の 6 節の持ち越し（自前か汎用のポリシーエンジンか）をこれで閉じる。
- **権限は和で決まり、明示の拒否の規則は持たない**。例外はシステムの固定の規則（本人の案件を承認しない、要配慮は既定で与えない、マイナンバーは保管庫の側）。
- **範囲は根の組織の ID で持ち、下位は判定のときに閉包で展開する**。
- **対象の組織は、`effective_on` と今日の早いほうの時点で決める。退職した人は退職日の時点**。
- **所属とロールの割り当ては業務プロセスの承認を経て、完了で効く**。方針はバージョンで有効化する。
- **職務分掌は範囲が重なるときに違反とする**。システムの規則に例外はない。
- **本番の代理のログインは読み取りだけ・30 分・理由つき**。運用者は代理でログインしない。
- **集計だけの操作 `aggregate` を足す**。機微な値の集計は `view` か `aggregate` で見られ、`aggregate` の結果は必ず少人数の抑止を通る（3.2 節、[ADR-0041](../decisions/0041-small-cell-suppression-for-sensitive-aggregates.md)）。
- **退職者の閲覧は、機微でないドメインは保存の期間の間、機微なドメインは退職から 3 年まで組織の範囲で許す**（4.2 節の DT-SEC-001 の #1）。
- **規則表の運用者の権限は `rules.import`・`rules.verify`・`rules.publish`。取り込みと照合は別の人**（3.4 節、S8）。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| 管理者が 1 人の小さなテナントでの、編集と有効化の分離（支援の窓口が代わるか） | E4 の着手の前に PM・セキュリティで決める |
| 本家の代理のログインの条件（未検証） | 本家の資料で E11 の前に確かめる。設計は本家に依らない |
| 拒否の記録のまとめ方の単位と保存の期間 | [audit-and-retention.md](audit-and-retention.md) |

## 17. quality.md・runbooks・data-model への項目

### quality.md

- 経路の一致の本番の抜き取り（PROP-SEC-001）の不一致の件数（目標 0。NFR-008）。
- 職務分掌の夜間の走査の違反の件数と、解消までの日数。
- 方針の有効化の件数と、戻した件数。
- 拒否の件数の推移（急増は設定の誤りか攻撃）。
- 代理のログインの件数と理由の分類。
- 判定の p99 と、キャッシュの当たりの率。

### runbooks

- `security-policy-rollback.md`：誤った方針を有効化したときの戻し方と、影響の調べ方。
- `sod-violation-report.md`：夜間の走査の違反への対応（テナントへの連絡、方針の直し方）。
- `authz-deny-spike.md`：拒否の急増の調べ方（方針の変更、閉包の食い違い、攻撃）。
- `proxy-login-review.md`：本番の代理のログインの記録の定期の確認。

### data-model（索引への追加の提案）

| 置き場所 | 中身 |
| --- | --- |
| Aurora `security_policy_versions` | 8 節。有効化したバージョンは書き換えない |
| Aurora `security_groups`、`security_group_members` | 4.1 節、7.2 節。所属は有効日付 |
| Aurora `security_effective_grants` | 7.2 節。派生 |
| `security_policy_versions.body` の `sod_rules`（表は持たない。システムの規則はコードの定数）、Aurora `sod_violations` | 5 節 |
| Aurora `security_membership_versions` | 7.3 節。人ごとの所属のバージョン（キャッシュのキー） |
| Aurora `proxy_sessions` | 9 節 |
| Valkey `authz:{tenant}:{worker}:{policy_version}:{membership_version}` | 7.3 節。失われてもよい |
| 監査ログの事象 `security.*`・`access.sensitive_read`・`access.denied_summary` | 10.1 節（[audit-and-retention.md](audit-and-retention.md)） |

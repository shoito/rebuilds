# Payments and accounting: Workday

給与の支払い（振込先の口座と配分、賃金の口座振込の同意、全銀協の形式の振込ファイル、振込の不能と再支払い）、給与明細（Web、PDF、電子交付の承諾）、賃金台帳、会計の仕訳の出力を決める。

前提の決定は、確定した給与の結果は書き換えず、仕訳は借方と貸方が一致する追記のみの記録で、取消は逆仕訳で行うこと（[ADR-0004](../decisions/0004-payroll-engine.md)）、口座番号は項目ごとに暗号化し、振込先の変更の承認と振込ファイルの承認を同じ人に持たせないこと（[ADR-0005](../decisions/0005-security-and-my-number.md)、[security-model.md](security-model.md) の 5 節の S2）。給与の実行の段は [payroll-engine.md](payroll-engine.md)、振込先の facet は [core-hr.md](core-hr.md) の 3.3 節にある。お金の記録の方式は Stripe の題材の台帳（[ledger.md](../../../stripe/docs/architecture/ledger.md)、[payouts-and-reconciliation.md](../../../stripe/docs/architecture/payouts-and-reconciliation.md)）に倣う。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0035](../decisions/0035-bank-transfer-files.md) | 振込は支払の指示（1 人 × 口座ごとの額）を確定の結果から決まった規則で作り、支払元の口座 × 種別（給与・賞与）× 振込指定日ごとに全銀協の形式の 120 バイトの固定長のファイルを作る。同じ指示から同じバイト列を作り、承認はファイルのハッシュに結び付ける。送信は企業が銀行の仕組みで行う。同意のない人は振込から外す |
| [0036](../decisions/0036-payslips-wage-ledger-and-e-delivery-consent.md) | 明細は確定の結果から作る変わらない文書（正規の JSON と決定的な PDF とハッシュ）で、`released` の後の公開の時刻に見せる。電子交付は追記のみの承諾の台帳で持ち、承諾のない人には書面の印刷の一覧を出す。賃金台帳は事業場ごとの結果と勤怠の射影にする |
| [0037](../decisions/0037-payroll-journal-export.md) | 仕訳は給与の実行の段（確定、支払、取消）ごとに、テナントの勘定の対応表（版つき）で作る。仕訳ごとに借方と貸方の合計が 0 であることをコミットの時に確かめ、追記のみで、直しは逆仕訳。行は会社 × 部門 × 勘定に集計し、従業員の単位では出さない。出力は連番の束で、同じ束は同じバイト列 |

## 1. 目的と範囲

- 扱う：支払の方法、振込先の口座の配分、口座振込の同意の記録、支払の指示、全銀協の形式のファイルの生成と検査、振込ファイルの承認と受け渡し、振込の締め切り、振込の不能と再支払い、明細の文書・PDF・公開・電子交付の承諾、賃金台帳、勘定の対応、仕訳、事業主の負担の見込みと調整、会計システム向けの出力。
- 扱わない：振込先の口座の登録と変更の業務プロセス（[core-hr.md](core-hr.md) の 6 節）、給与の計算（[payroll-engine.md](payroll-engine.md)、[payroll-jp-rules.md](payroll-jp-rules.md)）、明細の画面の作り（[self-service-ui.md](self-service-ui.md)）、書類の保存の期間の一覧（[audit-and-retention.md](audit-and-retention.md)）、源泉徴収票（E13）。
- 資金は預からない。振込ファイルを作り、送信は企業が自分の銀行の仕組み（法人のインターネットバンキング、ファイル伝送）で行う（[intent.md](../intent.md) の Non-goals）。

## 2. 確かめたこと

- 賃金は通貨で直接全額を払う。法令か労使協定があれば一部を控除できる。毎月 1 回以上、一定の期日に払う（[労働基準法](https://laws.e-gov.go.jp/law/322AC0000000049) 24 条）。労働者の同意を得れば、労働者が指定する金融機関の預金への振込で払える（[労働基準法施行規則](https://laws.e-gov.go.jp/law/322M40000100023) 7 条の 2）。いずれも e-Gov で 2026-09-28 に確認。同意の取り方と記録は社労士の確認待ち（[intent.md](../intent.md) の L4）。
- 賃金台帳は事業場ごとに作り、賃金の支払いのたびに遅滞なく記入する（労基法 108 条）。記入の事項は、氏名、性別、賃金計算期間、労働日数、労働時間数、延長・休日・深夜の労働時間数、基本給・手当などの種類ごとの額、控除の額。管理監督者などは労働時間数と延長などの時間数を記入しなくてよい（規則 54 条）。労働者名簿・年次有給休暇管理簿とあわせて作れる（規則 55 条の 2）。保存は 5 年（当分の間 3 年）で、起算は最後の記入の日（労基法 109 条・143 条、規則 56 条）。いずれも e-Gov で 2026-09-28 に確認。
- 給与の支払明細書は、あらかじめ受給者に電磁的方法の種類と内容を示し、電磁的方法か書面で承諾を得れば電子で交付できる（所得税法 231 条、施行令 356 条）。令和 5・6 年度の改正で、「期限までに回答がなければ承諾とみなす」旨をあらかじめ通知し、期限までに回答がなければ承諾とみなせる（回答の期限の長さに法令の定めはない）。電磁的方法は、画面への表示と書面への出力ができ、受信者ファイルに記録したときはその旨を通知する。承諾の後でも、書面の交付の請求があれば書面で交付する。電子交付を受けない旨の申出があれば、その後は電子交付できない（[国税庁：源泉徴収票等の電子交付に関する Q&A](https://www.nta.go.jp/publication/pamph/hotei/denshikofu-qa/answer.htm) の問 1・2・8・問の撤回の項、2026-09-28 に本文を確認）。明細の記載の事項の一覧は確かめていない（未検証。E10 の `payslip-documents` の spec の前に税理士に確かめる）。
- 全銀協の形式の総合振込・給与振込・賞与振込のファイル（銀行の仕様書。[三井住友銀行の仕様](https://www.smbc.co.jp/hojin/eb/firm/manual/resources/pdf/sougoufurikomi_kyuyofurikomi.pdf)、2026-09-28 に確認。全銀協の原本は未取得）：
  - 1 レコード 120 バイト。ヘッダー（データ区分 1）、データ（2）、トレーラー（8）、エンド（9）。
  - ヘッダー：種別コード（11 給与、12 賞与、21 総合）、コード区分（0 JIS、1 EBCDIC）、会社コード（10 桁）、会社名（カナ 40）、振込指定日（MMDD）、仕向の銀行・支店の番号と名前、預金種目、口座番号。
  - データ：被仕向の銀行番号（4）・名（15）、支店番号（3）・名（15）、手形交換所番号（0000）、預金種目（1）、口座番号（7）、受取人名（カナ 30）、振込金額（10）、新規コード（0 継続、1 新規、2 変更）、顧客コード 1・2 または EDI 情報（20）、振込指定区分、識別表示、ダミー。
  - 給与振込の預金種目は普通・当座だけ。振込金額が 0 のレコードは入れない。給与・賞与の振込では振込指定区分と識別表示は空白。
  - トレーラー：合計件数（6）、合計金額（12）。

## 3. 支払（[ADR-0035](../decisions/0035-bank-transfer-files.md)）

### 3.1 振込先の口座と配分

- 振込先は `worker_payment_election`（雇用の facet。最大 3 口座。口座番号は暗号文。[core-hr.md](core-hr.md) の 3.3 節）。配分の規則は口座ごとに `fixed`（定額）・`percent`（率）・`remainder`（残り）のどれかで、優先の順を持つ。
- 配分の手順（決まった順）：
  1. 優先の順に `fixed` を充てる。差引の支給額が足りなければ、充てられた分で止める。
  2. 残りに `percent` を掛けて `round_down_yen` で充てる。
  3. 残りをすべて `remainder` の口座に充てる（`remainder` はちょうど 1 つ）。
- 配分の合計は差引の支給額に等しい（PROP-PMT-001）。

### 3.2 口座振込の同意

```sql
wage_payment_consents (tenant_id, id, employment_id, action text,   -- granted | withdrawn
                       method text,          -- self_service | paper_scanned
                       terms_version, recorded_at, recorded_by, case_id)
```

- 同意は追記のみ。振込先の登録の業務プロセスで、本人が同意の文面（版）に同意した記録を作る。紙の同意書は写しを添付する。
- 同意のない人、撤回した人は、振込から外し、「振込以外の支払い」の一覧（3.7 節）に出す。
- 同意の文面と取り方は L4 の確認で決める。確認まで、`consent_required` の既定を「必須」にする。

### 3.3 支払の指示

```sql
payment_instructions (tenant_id, id, run_id, result_id, employment_id, seq smallint,
                      payer_account_id, transfer_type text,      -- salary(11) | bonus(12)
                      value_date date,                          -- 振込指定日
                      bank_code char(4), branch_code char(3), account_type char(1),
                      account_number_ct bytea,                  -- encrypted
                      holder_kana text, amount bigint,
                      new_code char(1),                         -- 0 | 1 | 2
                      state text,                               -- planned | in_file | released | returned | reissued
                      file_id, created_at)
```

- 指示は `finalized` のときに、確定の結果と、`known_at`（実行の入力の固定の時刻）の振込先の facet から作る。指示の後に口座が変わっても指示は変わらない。変えるには `payroll_cancel` か、支払の後の再支払い（3.6 節）。
- `new_code`：その口座への最初の振込は `1`、前の支払いから口座が変わったら `2`、それ以外は `0`。
- 支払元の口座（`payer_accounts`：会社、銀行・支店、種目、口座、会社コード、依頼人名のカナ、使う形式の設定）は会社の設定。

### 3.4 全銀協の形式のファイル

- ファイルは、支払元の口座 × 種別（給与 `11`・賞与 `12`）× 振込指定日ごとに 1 つ。指示を `(bank_code, branch_code, employment_id, seq)` の順に並べる。
- 文字：コード区分 `0`（JIS。半角の英数・カナを 1 バイトで）を既定とし、支払元の口座の設定で `1`（EBCDIC）にできる。レコードの区切り（CRLF・LF・なし）と、最後のエンドの後の EOF の扱いは銀行ごとの設定。
- 受取人名のカナの変換：全角を半角に、英小文字を大文字に、小書きのカナ（ｧｨｩｪｫｯｬｭｮ）を大書きに（銀行の扱いの慣行。全銀協の使用の文字の一覧は公開されておらず未検証。E10 の `zengin-file-generation` の前に、テナントの銀行の仕様書で確かめる）。使えない文字が残れば、ファイルを作らず、その人を一覧に出す。30 バイトを超える名前は切り詰め、警告を出す（照合への影響は銀行ごとに違いうる。同じ Story で確かめる）。
- 名義のカナは振込先の登録のときにも同じ規則で検査し、使えない文字を受け付けない。
- 生成の検査（DT-PMT-001）：レコードがすべて 120 バイト、数字の欄が数字、トレーラーの件数・金額がデータの合計と一致、金額が 1 以上 9,999,999,999 以下、給与の種目が普通・当座、振込指定日が銀行の営業日。
- ファイルの内容は指示だけから決まる。同じ指示の集合から作ったファイルは同じバイト列で、SHA-256 を `bank_files (id, run_id, payer_account_id, transfer_type, value_date, record_count, total_amount, sha256, s3_key, state, approved_case_id)` に記録する。

### 3.5 締め切りと承認

- 振込の締め切り（振込指定日の何営業日前までに銀行へ渡すか）は銀行ごとに違う（未検証。値は E10 の `zengin-file-generation` の前に、テナントの銀行の仕様書で確かめる）。支払元の口座の設定 `lead_business_days`（既定 3）で持ち、給与の実行の予定の逆算に使う（[payroll-engine.md](payroll-engine.md) の 4.2 節）。
- 振込ファイルの承認は `payroll_payment_release` の業務プロセスで、承認はファイルの SHA-256 に結び付ける。承認の後にファイルが変われば（再生成で違うバイト列になれば）承認は無効で、取り直す。
- 職務分掌：振込先の変更の承認と `payroll_payment_release` の承認は同じ人に持たせない（S2）。入社の起票と振込先の承認も警告（S7）。
- 承認の後、ファイルの取り出しは承認者と指定の担当だけ。取り出しは再認証（ステップアップ）を要し、15 分の 1 回限りの URL で、すべて記録する。
- 承認と同時に、明細の公開の時刻が決まる（4.2 節）。

### 3.6 振込の不能と再支払い

| 事象 | 記録 | 次の処理 |
| --- | --- | --- |
| 銀行から不能の連絡（口座なし、名義の不一致など） | 担当が指示に `returned` と理由を記録する（銀行の結果の取り込みは MVP の外） | 本人に口座の確認を求める。`off_cycle` の実行か、再支払いの指示（`reissued`）を作る |
| 組戻し（企業の側の誤りで取り戻す） | 担当が記録する | 同上。仕訳は 7.2 節 |

- 不能の理由のコードの一覧は、銀行ごとに違いうる（未検証。E10 の `payment-returns-and-reissue` で対象の銀行の仕様書から取る）。MVP は自由記述と少数の区分。

### 3.7 振込以外の支払い

- 同意のない人、口座の検査で落ちた人、振込の不能の人は、「振込以外の支払い」の一覧（現金など）に出す。支払ったことの記録（日付、方法、受け取りの確認）を担当が入力する。

## 4. 給与明細（[ADR-0036](../decisions/0036-payslips-wage-ledger-and-e-delivery-consent.md)）

### 4.1 文書

```sql
payslips (tenant_id, id, run_id, result_id, employment_id, kind text,   -- regular | bonus | off_cycle
          doc_json_sha256 bytea, pdf_sha256 bytea, s3_prefix,
          publish_at timestamptz, published_at, revoked_at, revoked_reason,
          delivery text,          -- electronic | paper
          created_at)
```

- 明細は `finalized` のときに、確定の結果の行、勤怠の集計（労働日数、時間の区分）、休暇（取得と残日数。テナントが出すと決めたとき）、支払の指示（口座は銀行名と末尾 4 桁だけ）、表示の名前と所属（`known_at` の時点）から、表示の文書（JSON）を作る。
- 文書は RFC 8785 で正規にして SHA-256 を取る。PDF は文書から決まった手順で作る（4.4 節）。
- 明細は書き換えない。支払の前の `payroll_cancel` では `revoked_at` を書いて見えなくし、作り直す。支払の後の誤りは次の実行の差額で直し、次の明細に遡及の行（期間つき）を出す。

### 4.2 公開

- 公開の時刻は、給与のグループの設定（既定：振込指定日の前の営業日の 12 時）。`released` でない実行の明細は公開しない。
- 公開のとき本人に通知する（本文に額を書かない）。
- 見る人：本人、給与の担当（範囲の中）。上長には見せない（[security-model.md](security-model.md) の 6 節）。本人の閲覧も記録する（機微な閲覧の記録。[ADR-0020](../decisions/0020-sensitive-read-audit-and-access-explanations.md)）。

### 4.3 電子交付の承諾

```sql
payslip_delivery_consents (tenant_id, id, employment_id, action text,   -- granted | withdrawn | deemed
                           method text, terms_version, notice_id,        -- for deemed
                           recorded_at, recorded_by)
```

- 承諾は追記のみ。本人がセルフサービスで、電磁的方法の種類と内容（Web での閲覧、PDF の取り出し、保存の期間）の説明の版を見て承諾する。
- 「期限までに回答がなければ承諾とみなす」方法は、テナントが選んだときだけ使う（既定は使わない）。使うときは、通知の文面・送った日・期限を `notice_id` で記録し、期限の翌日に `deemed` を書く。
- 承諾のない人、撤回した人の明細は `delivery = paper`。給与の担当に印刷の一覧（PDF の束）を出す。Web での閲覧はそれとは別に許すかをテナントが決める。
- 撤回は次の公開から効く。
- 承諾があっても、本人が書面を求めたら（セルフサービスの「書面で受け取る」、または担当の代理の記録）、その明細を印刷の一覧に入れる。書面の請求は `payslip_paper_requests`（追記のみ。対象の実行、記録の時刻、記録した人）に持つ。
  - > 2026-09-28 の注記：国税庁の Q&A の本文で、承諾の後でも書面の請求があれば書面で交付することを確かめたので、この行を足した。
- 承諾の取り方・記録・撤回は税理士・社労士の確認待ち（[intent.md](../intent.md) の L3）。確認まで E10 の明細の電子交付の spec を承認しない。

### 4.4 PDF

- 汎用の PDF のライブラリで、座標を指定して描く（HTML をヘッドレスのブラウザで変換する方式は使わない。重く、同じ入力で同じバイト列にしにくい）。ライブラリの選定（Node の汎用のもの）は E10 の PoC で決める。
- 日本語のフォントは SIL Open Font License のフォント（例：Noto Sans JP）の部分集合を埋め込む。
- PDF の作成日時・更新日時は実行の確定の時刻に固定し、乱数の ID を入れない。同じ文書から同じバイト列にし、`pdf_sha256` を記録する（PROP-PMT-004）。
- PDF にパスワードは付けない（配布は認証つきの取り出しで守る）。書面の印刷の用途も同じ PDF。

## 5. 給与の実行の段との対応

| 実行の段（[payroll-engine.md](payroll-engine.md) の 4.1 節） | この領域で起きること |
| --- | --- |
| `finalized` | 支払の指示、明細の文書と PDF（未公開）、確定の仕訳と事業主の見込みの仕訳を作る |
| `released`（`payroll_payment_release` の承認） | 振込ファイルの承認と取り出し。明細の公開の時刻が決まる |
| 振込指定日 | 支払の仕訳。明細の公開（既定は前の営業日） |
| `cancelled`（支払の前） | 指示とファイルを無効にし、明細を `revoked` にし、逆仕訳を書く |
| 支払の後の誤り | この領域では直さない。次の実行の差額か `off_cycle` |

## 6. 賃金台帳（[ADR-0036](../decisions/0036-payslips-wage-ledger-and-e-delivery-consent.md)）

- 賃金台帳は射影（`wage_ledger` のビューと出力の処理）。行は事業場（`location`。労基法の事業場として扱う事業所）× 雇用 × 実行。
- 列（規則 54 条）：氏名、性別（`worker_personal` の `known_at` の時点）、賃金計算期間、労働日数、労働時間数、延長の時間数（`statutory_ot`）、休日の時間数（`legal_holiday_work`）、深夜の時間数（`night`）、基本給・手当などの種類ごとの額、控除の種類ごとの額。管理監督者の印の人は労働時間数と延長・休日の時間数を空欄にする（深夜は出す）。
- 事業場は、実行の期間の末日の主たる職務の事業所。月の途中の異動の扱いは未検証（L39）。
- `contingent` の雇用は対象外（[core-hr.md](core-hr.md) の 7 節）。
- 出力：実行ごと、年ごとの PDF と CSV。任意の時点で出せる。年次有給休暇管理簿を付表にできる（[absence-and-leave.md](absence-and-leave.md) の 6 節）。
- 保存の既定は、最後の記入（最後の実行）から 5 年。当分の間 3 年の附則があっても長いほうに倒す。L5 の確認で合わせる。
- 賃金台帳の様式（様式第 20 号）の欄の並びは確かめていない（未検証。e-Gov の様式の画像を E10 の `wage-ledger` の spec の前に確かめる）。MVP は規則 54 条の事項を満たす独自の並びにする。

## 7. 仕訳（[ADR-0037](../decisions/0037-payroll-journal-export.md)）

### 7.1 勘定の対応

```sql
gl_account_maps (tenant_id, id, version, valid daterange,
                 rules jsonb,       -- item_code | item category → {debit, credit, dimension}
                 activated_at, activated_by)
```

- 対応の鍵は項目の `gl_mapping_key`（[payroll-engine.md](payroll-engine.md) の 6.1 節）。鍵のない項目があれば、確定の前の検査で止める。
- 既定の対応の例（テナントが変える。科目の分け方と計上の時期は税理士の確認待ち。[intent.md](../intent.md) の L9）：

| 項目 | 借方 | 貸方 |
| --- | --- | --- |
| 支給（基本給、手当、割増） | 給与手当（賞与は賞与） | — |
| 源泉所得税 | — | 預り金（源泉所得税） |
| 住民税 | — | 預り金（住民税） |
| 社会保険料（本人） | — | 預り金（社会保険料） |
| 雇用保険料（本人） | — | 預り金（雇用保険料） |
| テナントの控除（組合費など） | — | 預り金（控除の種類ごと） |
| 差引の支給額 | — | 未払金（給与） |
| 社会保険料（事業主の見込み） | 法定福利費 | 未払費用（社会保険料） |
| 雇用保険料（事業主の見込み） | 法定福利費 | 未払費用（労働保険料） |
| 子ども・子育て拠出金（事業主） | 法定福利費 | 未払費用（社会保険料） |

### 7.2 仕訳の例

月給 300,000 円（基本給 290,000、非課税の通勤手当 10,000）、東京都の協会けんぽ・介護なし、甲欄の扶養 0 人・電算機特例、住民税 12,000 円の例。数は計算の形を示すもので、ゴールデンデータではない。

- 健康保険の側：300,000 × (9.85% ＋ 0.23%) ÷ 2 ＝ 15,120.00 → 15,120。厚生年金：300,000 × 18.3% ÷ 2 ＝ 27,450。雇用保険：300,000 × 5/1,000 ＝ 1,500。
- 源泉所得税：A ＝ 290,000 − 15,120 − 27,450 − 1,500 ＝ 245,930。給与所得控除 ＝ 245,930 × 30% ＋ 6,667 ＝ 80,446。基礎控除 48,334。B ＝ 117,150。税額 ＝ 117,150 × 5.105% ＝ 5,980.5… → 10 円未満四捨五入で 5,980。
- 差引 ＝ 300,000 − 15,120 − 27,450 − 1,500 − 5,980 − 12,000 ＝ 237,950。

| 段 | 仕訳（借方を正、貸方を負） |
| --- | --- |
| 確定（`finalized`） | 給与手当 +300,000 / 預り金（源泉）−5,980 / 預り金（住民税）−12,000 / 預り金（社保）−42,570 / 預り金（雇保）−1,500 / 未払金（給与）−237,950 |
| 確定（事業主の見込み） | 法定福利費 +45,120 / 未払費用（社保）−42,570 / 未払費用（労働保険）−2,550 |
| 支払（振込指定日） | 未払金（給与）+237,950 / 普通預金（給与振込の口座）−237,950 |
| 振込の不能 | 普通預金 +X / 未払金（給与）−X。再支払いで支払の仕訳をもう一度 |
| 取消（`payroll_cancel`） | 確定の仕訳の逆仕訳（`reverses_entry_id`） |
| 事業主の負担の調整（納入告知の取り込み） | 法定福利費 ±D / 未払費用（社保）∓D。D ＝ 告知額 −（本人の合計 ＋ 事業主の見込み） |

- 事業主の雇用保険料は、労働保険の年度更新（概算・確定）で納めるので、未払費用・前払の扱いは税理士の確認待ち（L9）。
- 遡及の差額の行は、当期の実行の仕訳に入る。過去の期間の仕訳は変えない。

### 7.3 スキーマと制約

```sql
payroll_journal_entries (tenant_id, id, company_id, run_id,
                         entry_type text,     -- finalize | employer_estimate | payment | payment_return
                                              -- | cancel | employer_adjust
                         effective_on date,   -- accounting date (pay date by default; L9)
                         reverses_entry_id, map_version_id,
                         idempotency_key text, created_at,
                         UNIQUE (tenant_id, idempotency_key))
payroll_journal_lines (tenant_id, entry_id, line_no, account_code, cost_center_id,
                       amount bigint,         -- debit positive, credit negative, never 0
                       source text)           -- item code or category (no employee id)
```

- **釣り合う**：コミットの時に動く遅延制約のトリガーで、仕訳ごとに `SUM(amount) = 0`、行が 2 つ以上、0 の行がないことを確かめる（Stripe の題材の [ledger.md](../../../stripe/docs/architecture/ledger.md) の 3 節と同じ）。
- **追記のみ**：アプリのロールから `UPDATE`・`DELETE` の権限を外し、トリガーでも拒む。
- **冪等**：キーは段から決まる値（`finalize:{run_id}`、`payment:{run_id}:{payer_account_id}:{value_date}` など）。2 回目の書き込みは既存の仕訳を返す。
- **同じトランザクション**：確定の状態の遷移と確定の仕訳、取消と逆仕訳は、同じトランザクションで書く。
- **集計の単位**：行は会社 × 部門（コストセンター）× 勘定 × 元の項目に集計する。従業員の ID は入れない。部門は期間の末日の主たる職務のコストセンター（日数での按分は設定で選べる。按分は `allocate_largest_remainder`）。
- 会計の日（`effective_on`）は既定で支給日。期間の末日（発生の月）にする設定を持つ（L9）。

### 7.4 出力

```sql
gl_export_batches (tenant_id, id, company_id, seq int, entry_ids uuid[], format text,
                   file_sha256, s3_key, created_at, created_by,
                   UNIQUE (tenant_id, company_id, seq))
```

- 出力は、まだ出していない仕訳を `created_at, id` の順に集めた連番の束。同じ束の取り出しは同じバイト列（PROP-PMT-005）。
- 形式は汎用の CSV（会社、会計の日、仕訳の ID、行、勘定、部門、借方、貸方、摘要）と、テナントの列の対応の雛形。会計システムの固有の形式は MVP の外。
- 会計システムが束を拒んでも、仕訳は直さない。直すための仕訳（逆仕訳と正しい仕訳）を足して次の束で出す。
- 仕訳の出力と保存は電子帳簿保存法の対象になりうる（[intent.md](../intent.md) の L5）。

## 8. 規模

- 支払の指示：S1 の支給日の前に 70 万人 × 平均 1.2 口座。ファイルは会社 × 支払元の口座 × 種別ごとで、最大のテナントでも 1 ファイル数万行（120 バイト × 3 万行 ≒ 3.6 MB）。
- 明細：月に 100 万件の文書と PDF。PDF の生成は 1 件 50〜100ms で、Worker を広げて確定から公開までの間（1 日以上）に終える。S3 に年 1,200 万件、1 件 50〜100 KB で年 1 TB ほど。
- 仕訳：集計するので 1 実行あたり数百〜数千行。

## 9. 障害のときの振る舞い

| 障害 | 振る舞い |
| --- | --- |
| ファイルの生成の検査で落ちる（使えない文字、口座の桁） | ファイルを作らず、その人と理由の一覧を出す。担当が直すか、その人を振込以外の支払いに回す |
| 承認の後にファイルが再生成されて違うバイト列になる（バグ） | 承認は無効（ハッシュが違う）。取り出しを拒み、SEV2 |
| 支給日の前にリージョンが落ちる | 大阪の DR で、承認済みのファイルを S3 の複製から取り出せる。未承認なら DR で生成と承認を行う（NFR-006） |
| 明細の PDF の生成の遅れ | 公開の時刻に PDF がなければ、Web の表示だけ先に公開し、PDF は生成を待つ |
| 仕訳のトリガーで釣り合わない | 確定のトランザクションごと失敗する。確定を止め、勘定の対応の設定を直す |
| 会計システムの取り込みの失敗 | 束を作り直さない。直す仕訳を足す |

## 10. セキュリティとプライバシー

- 口座番号は `worker_payment_election` でも `payment_instructions` でも暗号文で持ち、ファイルの生成のときだけ復号する。復号は `worker.payment_election` の権限を持つ Worker のロールだけ（[ADR-0005](../decisions/0005-security-and-my-number.md)）。
- 振込ファイルは口座番号の平文を含む。S3 はファイル専用の KMS の鍵で暗号化し、保存の期間（L5）の後に消す。取り出しは 3.5 節の手順。
- 明細は本人と給与の担当だけ。閲覧は記録する。
- 仕訳と出力には従業員の単位の値を入れない。少人数の部門では額から個人が分かりうるので、出力の権限は経理の担当に絞る（[reporting.md](reporting.md) の k 匿名性の議論と合わせる）。
- 通知の本文に額と口座を書かない。
- テスト：口座はテスト用の銀行コードと支店コードだけ（[AGENTS.md](../../AGENTS.md)）。

## 11. テスト

### 11.1 決定表

| ID | 内容 |
| --- | --- |
| DT-PMT-001 | ファイルの生成の検査（3.4 節） |
| DT-PMT-002 | `new_code` の決め方（初回、変更、継続） |
| DT-PMT-003 | 明細の届け方（承諾、みなしの承諾、撤回、承諾なし、承諾の後の書面の請求） |
| DT-PMT-004 | 仕訳の段と種類（7.2 節の各行） |

### 11.2 性質ベーステスト

| ID | 性質 |
| --- | --- |
| PROP-PMT-001 | 任意の差引の支給額と配分の規則で、配分の合計は差引に等しく、どの口座も負にならない |
| PROP-PMT-002 | 任意の指示の集合で、ファイルのどのレコードも 120 バイトで、トレーラーの件数・金額はデータの合計に等しい |
| PROP-PMT-003 | 任意の指示の集合で、ファイルの生成を 2 回すると同じバイト列 |
| PROP-PMT-004 | 任意の明細の文書で、PDF の生成を 2 回すると同じバイト列 |
| PROP-PMT-005 | 任意の実行の列（確定、支払、不能、取消、調整）で、仕訳ごとに借方と貸方の合計が 0。実行ごとの未払金（給与）の残りは、支払と不能と取消の後に 0 か未払いの額に等しい |
| PROP-PMT-006 | 任意の出力の列で、同じ束の取り出しは同じバイト列で、どの仕訳もちょうど 1 つの束に入る |

### 11.3 例と結合

- 例：7.2 節の仕訳の例を表駆動にする（税理士の確認の後にゴールデンデータへ）。
- 結合：銀行の仕様書の見本のファイルと、生成したファイルのバイトの比較（テスト用の銀行コード）。
- 受け入れ：支払元の銀行ごとに、銀行の試験の環境（あれば）への受け渡しを確かめる（E10）。

## 12. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E10 | `payment-allocation` | 3.1 節（PROP-PMT-001） |
| E10 | `wage-payment-consent` | 3.2 節（L4 の確認の後） |
| E10 | `payment-instructions` | 3.3 節（DT-PMT-002） |
| E10 | `zengin-file-generation` | 3.4 節（DT-PMT-001、PROP-PMT-002・003）。カナの変換、支払元の口座の設定 |
| E10 | `payment-release-approval` | 3.5 節。ハッシュに結ぶ承認、取り出しの手順 |
| E10 | `payment-returns-and-reissue` | 3.6・3.7 節 |
| E10 | `payslip-documents` | 4.1・4.2 節。文書、公開、通知 |
| E10 | `payslip-pdf` | 4.4 節（PROP-PMT-004）。ライブラリの PoC |
| E10 | `payslip-e-delivery-consent` | 4.3 節（DT-PMT-003。L3 の確認の後） |
| E10 | `wage-ledger` | 6 節 |
| E10 | `gl-account-mapping` | 7.1 節 |
| E10 | `payroll-journal-entries` | 7.2・7.3 節（DT-PMT-004、PROP-PMT-005） |
| E10 | `gl-export` | 7.4 節（PROP-PMT-006） |
| E10 | `employer-si-adjustment` | 7.2 節の納入告知の取り込みと調整の仕訳 |

## 13. 未解決の問い

### 決定

- **送信は企業が行い、本システムはファイルを作るだけ**。銀行の API との連携は MVP の外（[ADR-0035](../decisions/0035-bank-transfer-files.md)）。
- **振込ファイルの承認はファイルの SHA-256 に結ぶ**。同じ指示から同じバイト列を作る。
- **受取人名のカナは登録のときに検査し、生成のときに使えない文字があれば止める**。黙って置き換えない。
- **明細は変わらない文書で、PDF も決定的に作る**。HTML の変換は使わない（[ADR-0036](../decisions/0036-payslips-wage-ledger-and-e-delivery-consent.md)）。
- **電子交付のみなしの承諾は、テナントが選んだときだけ**。
- **仕訳は会社 × 部門 × 勘定に集計し、従業員の ID を入れない**（[ADR-0037](../decisions/0037-payroll-journal-export.md)）。
- **会計の日の既定は支給日**。
- **事業主の社会保険料は見込みで計上し、納入告知で調整する**。

### 確認待ち（[intent.md](../intent.md) に載せたもの）

| # | 問い | 確認先 | 止める spec |
| --- | --- | --- | --- |
| L38 | 給与の支払明細書の記載の事項と、電子交付の承諾の文面・みなしの承諾の通知（L3 を細かくしたもの） | 税理士 | E10 の `payslip-e-delivery-consent` |
| L4 | 口座振込の同意の文面と、本人の申請だけで振込先を変えてよいか（intent の L4 と同じ） | 社労士 | E10 の `wage-payment-consent` |
| L39 | 月の途中で事業場が変わった人の賃金台帳の事業場、賃金台帳の様式 | 社労士 | E10 の `wage-ledger` |
| L40 | 事業主の雇用保険料（年度更新）と社会保険料の計上の時期と科目（L9） | 税理士 | E10 の `payroll-journal-entries` |

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| 銀行ごとの締め切り、レコードの区切り、名前の切り詰めの扱い、不能の理由のコード | E10 の着手の前に、対象のテナントの銀行の仕様書で |
| 全銀協の原本の仕様（使える文字の一覧） | E10 の着手の前 |
| PDF のライブラリ | E10 の PoC |
| 銀行の API での送信、振込の結果の取り込み | MVP の後 |
| 会計システムの固有の形式 | 需要を見て MVP の後 |

## 14. quality.md・runbooks・data-model への項目

### quality.md

- ファイルの生成の検査の失敗の件数と理由（カナ、桁）。
- 承認から支給日までの余裕（締め切りに対する遅れ 0 件）。
- 振込の不能の件数と、再支払いまでの日数。
- 明細の公開の遅れ、PDF の生成の失敗の件数。
- 電子交付の承諾の率と、書面の件数。
- 仕訳の釣り合いの失敗（確定の失敗）の件数、出力の束の拒否の件数。

### runbooks

- `bank-file-release.md`：振込ファイルの承認・取り出し・受け渡しの手順と、承認の後の不一致への対応。
- `payment-return-handling.md`：振込の不能・組戻しの記録と再支払い。
- 支給日の前のリージョンの障害で、大阪から振込ファイルを出す手順（NFR-006）：[runbooks/disaster-recovery.md](../runbooks/disaster-recovery.md) の「E. 支給日の DR」にある（統合の工程で、別の runbook を作らないと決めた）。
- `payslip-publish-delay.md`：明細の公開・PDF の生成の遅れ。
- `gl-export-rejected.md`：会計システムが束を拒んだときの、直す仕訳の足し方。
- `employer-si-notice-adjustment.md`：納入告知の額の取り込みと調整の仕訳。

### data-model（索引への追加の提案）

| 置き場所 | 中身 |
| --- | --- |
| Aurora `payer_accounts`、`wage_payment_consents` | 3.2・3.3 節 |
| Aurora `payment_instructions`、`bank_files` | 3.3・3.4 節。口座番号は暗号文 |
| Aurora `payslips`、`payslip_delivery_consents` | 4 節 |
| Aurora `wage_ledger`（ビュー） | 6 節 |
| Aurora `gl_account_maps`（版）、`payroll_journal_entries`、`payroll_journal_lines`、`gl_export_batches`、`si_premium_notices` | 7 節。仕訳は追記のみ・遅延制約で釣り合い |
| S3 `bank-files/{tenant}/{file_id}`（専用の KMS の鍵）、`payslips/{tenant}/{id}.json|.pdf`、`gl-exports/{tenant}/{seq}.csv` | 大阪へ複製 |

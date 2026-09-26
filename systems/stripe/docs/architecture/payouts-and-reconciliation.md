# Payouts and reconciliation: Stripe

加盟店への入金（Payout）、銀行への振込の実行、決済代行の精算と銀行の明細との照合、加盟店向けのレポート、社内の会計への出力。台帳と残高は [ledger.md](ledger.md) にある。入金の実行は [ADR-0018](../decisions/0018-payout-execution-via-banking-partner.md)、照合と仮勘定は [ADR-0017](../decisions/0017-three-way-reconciliation-with-suspense.md) に従う。

> **法務の確認待ち**：加盟店の代わりに代金を受け取って後で渡す流れが、資金決済法の上でどう位置づけられるか（収納代行か、資金移動業か）は決まっていない（[intent.md](../intent.md)）。この文書は位置づけに依らない設計にしているが、確認が済むまで Payout の Epic の spec を承認しない。預かり金の分別管理、銀行口座の名義・用途、全銀システムへの直接の参加の可否は、確認の結果で変わりうる。

## 1. 本家 Stripe の振る舞い

| 項目 | 本家の振る舞い | 出典 |
| --- | --- | --- |
| 自動と手動 | 自動入金はスケジュールに従い、利用可能な残高を送る。手動入金は加盟店が金額と時期を決めて API で作る | [Payouts](https://docs.stripe.com/payouts) |
| スケジュール | 日次、週次（曜日）、月次（日付。存在しない日は月末）。休業日は翌営業日にずらす。スケジュールは「いつ送るか」だけを決め、利用可能になる時期は変えない | 同上 |
| 日本 | 日次入金は使えない。既定は手動で、週次・月次も選べる。売上処理のタイミングは初回 7 暦日、既定 4 営業日。最低入金額 1 円。入金先は日本の金融機関の法人名義の普通・当座預金。JPY のみ | 同上 |
| 状態 | `pending` → `in_transit` → `paid`。失敗すれば `failed`、取り消せば `canceled`（5 営業日以内）。いったん `paid` になってから `failed` になることがある | [Payout object](https://docs.stripe.com/api/payouts/object) |
| 失敗 | `failure_code`（`account_closed`、`no_account`、`invalid_account_number`、`incorrect_account_holder_name`、`incorrect_account_type`（日本では普通・当座）など）。失敗した金額は残高に戻り、`failure_balance_transaction` を持つ | 同上、[Payouts](https://docs.stripe.com/payouts) |
| 照合の単位 | 自動入金だけ、含まれた BalanceTransaction を `GET /v1/balance_transactions?payout=po_...` で引ける（`reconciliation_status` が `completed`）。手動入金は、どの取引が含まれるかを特定しない（`not_applicable`） | [Payout reconciliation](https://docs.stripe.com/payouts/reconciliation)、[Payout object](https://docs.stripe.com/api/payouts/object) |
| レポート | 残高サマリー（期首・活動・入金・期末）と、入金照合（自動入金ごとに含まれた取引を `reporting_category` でまとめる）。日ごとのデータは翌日 12:00 までに揃う | [Balance report](https://docs.stripe.com/reports/balance)、[Payout reconciliation report](https://docs.stripe.com/reports/payout-reconciliation) |
| 即時入金 | デビットカード・一部の銀行口座へ即時に送る | [Payout object](https://docs.stripe.com/api/payouts/object) の `method` |

- **即時入金（`method = instant`）は範囲外** とする。日本では本家も提供していない想定だが **未検証**。モアタイムシステムで即時の振込自体は可能なので、後の Epic で検討する。

## 2. 入金のスケジュール

```sql
payout_settings (account_id, currency,
                 schedule_interval,        -- manual | weekly | monthly
                 weekly_anchor,            -- monday..friday（週次）
                 monthly_anchor,           -- 1..31（月次）
                 settlement_delay_days,    -- 既定 4 営業日（初回は 7 暦日）
                 default_bank_account_id,
                 payouts_paused_reason,    -- 口座の不備、マイナス残高、リスクの停止
                 updated_at,
                 PRIMARY KEY (account_id, currency))
```

- 既定は本家の日本に揃えて `manual`。週次・月次を選べる。日次は提供しない（本家の日本と同じ）。
- 支払日が休業日なら、翌営業日にずらす。営業日は [ledger.md](ledger.md) の `business_calendars` を使う。
- **最低入金額** は 1 円（本家の日本）。ただし振込の実費（銀行の振込手数料）を誰が負うかで、実質の下限は変わる。**未検証**：本家の日本の入金手数料の有無と金額。決まるまで、入金手数料は 0 円とし、自社の費用に計上する。
- 入金先の口座は、金融機関コード・支店コード・預金種目（普通・当座）・口座番号・口座名義（カナ）で持つ。名義は全銀の使用文字（半角カナ・英数・一部の記号）に正規化して保存する。

## 3. 入金の作成

### 3.1 自動入金

1. 毎営業日 JST 6:00 に、その日が支払日の加盟店を選ぶ。
2. 加盟店・通貨ごとに、1 つのトランザクションで次を行う（冪等キー `payout:auto:{account_id}:{currency}:{date}`）。
   - `merchant_available` の全スロットを `FOR UPDATE` で読み、残高を確定する（[ledger.md](ledger.md) の 8 節）。
   - 残高が最低入金額未満、またはマイナスなら作らない。
   - 利用可能で、まだどの入金にも含まれていない BalanceTransaction を集め、`payout_id` を付ける。入金額は、これらの `net` の合計にする（残高と一致することを確かめる）。
   - `payouts` に `pending` の行を作り、`merchant_available` → `payouts_in_transit` の仕訳と、`type = payout` の BT を作る。
   - `payout.created` の Event を outbox に積む。
3. `reconciliation_status` は `completed` にする。含まれる BT を作成時に確定させるので、本家のような「照合の処理中」の状態は要らない。Event の `payout.reconciliation_completed` は、本家に揃えて作成の直後に出す。

- **残高は作成の時点で引く**（本家の `effective_at` と同じく、残高から引かれる日は入金の作成日）。依頼から着金までの間に同じお金を 2 回送らないため。

### 3.2 手動入金

- `POST /v1/payouts { amount, currency, description?, statement_descriptor? }`。`Idempotency-Key` を受け付ける（[ADR-0004](../decisions/0004-idempotency.md)）。
- `amount` が `merchant_available` の残高を超えれば 400（`balance_insufficient`）を返す。
- BT への `payout_id` の付与はしない。`reconciliation_status` は `not_applicable`（本家と同じ）。
- 支払いの依頼は、次の振込の締め（4 節）に乗る。

### 3.3 取り消し

- `pending`（銀行に依頼する前）の入金だけを取り消せる（`POST /v1/payouts/{id}/cancel`）。`payouts_in_transit` → `merchant_available` の仕訳と `payout_cancel` の BT を作り、自動入金なら含めた BT の `payout_id` を外す。

## 4. 銀行への振込の実行

### 4.1 手段の比較

| 手段 | 内容 | 評価 |
| --- | --- | --- |
| 銀行の法人向け API | 総合振込依頼・振込依頼・結果照会・組戻しの状態を API で扱う。例：GMO あおぞらネット銀行は、振込依頼、総合振込依頼、総合振込依頼結果照会などを API で公開し、組戻しの状態（手続中・組戻済・不成立）を返す（[API 一覧](https://gmo-aozora.com/business/api-cooperation/apilineup.html)、[法人口座編の仕様書](https://gmo-aozora.com/business/service/pdf/api-spec-corporate.pdf)） | **主な手段にする** |
| 全銀フォーマットのファイル | 総合振込のファイル（120 バイト固定長。ヘッダー・データ・トレーラ・エンドの 4 種類のレコード、半角カナ・英数）を、法人のインターネットバンキングかファイル伝送で渡す（[三菱 UFJ 信託銀行の仕様](https://www.tr.mufg.jp/houjin/mbd/manual/pdf/manual05.pdf)） | 予備の手段と、API のない 2 行目の銀行向けに持つ |
| 全銀システムへの直接の参加 | 2022 年 10 月から資金移動業者も参加できる（[Impress Watch](https://www.watch.impress.co.jp/docs/news/1440623.html)、[全銀ネットの加盟承認の例](https://www.zengin-net.jp/announcement/pdf/announcement_241017-02.pdf)） | 採らない。資金決済法の上の位置づけが決まっておらず、参加には免許と大きな開発・運用が要る |

- 採用は、**銀行の API を主、全銀フォーマットのファイルを予備** にする（[ADR-0018](../decisions/0018-payout-execution-via-banking-partner.md)）。どの銀行と契約するかは未決。
- **未検証**：API での 1 回あたりの件数の上限、当日扱いの締めの時刻、振込手数料、依頼の重複を防ぐ識別子（依頼側の番号を持てるか）、口座名義の事前の確認（名義照会）の可否。銀行を選ぶときに、各行の仕様書で確かめる。
- **未検証**：全銀フォーマットのデータレコードのうち、自社の入金の ID を載せられる項目（顧客コード・EDI 情報）の桁数。

### 4.2 流れ

```
payouts(pending) ──締め──▶ payout_batches(submitted) ──銀行 API──▶ 受付
                                      │
                                      ├─ 結果照会：成功 → payouts(in_transit → paid)
                                      ├─ 結果照会：不能 → payouts(failed)、残高に戻す
                                      └─ 数日後の組戻し・資金返却 → payouts(paid → failed)
```

1. **締め**：1 日に数回（例：9:00、13:00）、`pending` の入金を銀行ごと・払出口座ごとにまとめ、`payout_batches` を作る。まとめる件数は銀行の上限に合わせる。
2. **依頼**：銀行アダプタが総合振込を依頼する。依頼の前に `payout_batches.bank_request_ref` を採番して保存し、再送では同じ番号を使う（[ADR-0004](../decisions/0004-idempotency.md) のコネクタの層と同じ考え方）。
3. **結果が不明なとき**：タイムアウトなどで受付の成否が分からなければ、再依頼せず、結果照会の API で `bank_request_ref` の状態を確かめてから次の手を決める。照会しても分からなければ、Ops の確認に回す（二重の振込を防ぐことを優先する）。
4. **受付**：各入金を `in_transit` にし、`arrival_date` を着金の見込み日（当日扱いの締めに間に合えば当日、でなければ翌営業日）にする。`payout.updated` を出す。
5. **完了**：結果照会で振込の完了を確かめたら `paid` にし、`payout.paid` を出す。出金は銀行の明細で確かめ、`payouts_in_transit` → `bank_cash:payout` の仕訳を書く（5 節の照合）。

- 振込の依頼人名には、加盟店が設定した `statement_descriptor` を載せる（本家の Payout の `statement_descriptor`）。全銀の使用文字に変換し、桁数を超える部分は切る。
- 払出口座の残高が足りないと振込は失敗する。締めの前に、払出口座の残高とその回の合計を比べ、足りなければ依頼せず Ops に通知する（資金の移動は人が行う）。

### 4.3 失敗と返却

| 事象 | 状態 | 仕訳と BT | 次の処理 |
| --- | --- | --- | --- |
| 依頼の時点で拒否（口座なし、名義の不一致など） | `pending` / `in_transit` → `failed` | `payouts_in_transit` → `merchant_available`、`payout_failure` の BT | `failure_code` を銀行の理由から対応表で決める |
| 完了の後の組戻し・資金返却 | `paid` → `failed` | 返却の着金を明細で確かめてから、`bank_cash:payout` → `merchant_available`、`payout_failure` の BT | 同上 |
| 締めの前の取り消し | `pending` → `canceled` | `payouts_in_transit` → `merchant_available`、`payout_cancel` の BT | 3.3 節 |

- 失敗した入金には `failure_balance_transaction` を設定し、`payout.failed` を出す（本家と同じ）。
- 自動入金が失敗したら、含めた BT は次の自動入金に含め直す。本家のレポートの `retried_payout_id` に当たる関係を `payouts.retried_by_payout_id` に持つ。
- `account_closed`・`no_account`・`invalid_account_number`・`incorrect_account_holder_name`・`incorrect_account_type` の失敗では、その口座を使えない状態にし、自動入金を止め、加盟店に口座の更新を求める。
- 銀行の理由（全銀の不能の理由など）と `failure_code` の対応表は、銀行ごとに持つ。**未検証**：各行の理由のコードの一覧。

## 5. 照合

### 5.1 3 つの照合

| 照合 | 内部の記録 | 外部の記録 | 突き合わせの鍵 |
| --- | --- | --- | --- |
| 精算の照合 | 台帳の `connector_receivable` の行（決済・返金・Dispute） | 決済代行の精算ファイルの明細 | コネクタの参照番号（[ADR-0004](../decisions/0004-idempotency.md)） |
| 着金の照合 | 精算のバッチの純額（精算ファイルの合計） | 銀行の入出金明細の入金 | 金額・日付・振込依頼人名（決済代行ごとの規則） |
| 入金の照合 | `payouts` と `payout_batches` | 銀行の結果照会と入出金明細の出金 | `bank_request_ref`、金額、日付 |

これらをつないで、**台帳・決済代行の精算・銀行の明細の 3 つが一致すること（3 者照合）** を確かめる。

- 決済 1 件について：台帳の未収金の行 ＝ 精算ファイルの明細（総額・手数料）。
- 精算のバッチについて：明細の合計 ＝ 精算ファイルの純額 ＝ 銀行の着金額。
- 入金について：台帳の入金の仕訳 ＝ 銀行の依頼の結果 ＝ 銀行の明細の出金。

### 5.2 取り込み

- 精算ファイルは、決済代行ごとの形式（CSV、固定長）を取り込み、共通の形の `settlement_lines (id, connector, settlement_batch_id, connector_ref, line_type, gross, fee, net, currency, transaction_date, value_date, raw)` に変える。元のファイルは S3 に保存し（改ざん検知のためハッシュも持つ）、同じファイルの 2 回目の取り込みは無視する。
- 決済代行の精算のサイクル（例：月 2 回締め・月 2 回払い、月末締め翌月末払い）は決済代行ごとに違う。**未検証**：最初の決済代行のサイクル、ファイルの形式、届く手段（SFTP か API か）。
- 銀行の明細は、銀行の API（入出金明細の照会）で 1 日に数回取り込む。API がない銀行は、全銀協規定形式の入出金取引明細のファイルを使う。**未検証**：各行の明細に載る項目（振込依頼人名の桁数、EDI 情報の有無）。
- 顧客の銀行振込（振込専用口座への入金）の取り込みと割り当ては、同じ明細の取り込みを使う（[payment-methods.md](payment-methods.md)）。

### 5.3 照合の処理

1. **明細の対応**：`settlement_lines` を `connector_ref` で台帳の行に対応させる。結果を `recon_matches (source, external_id, entry_id, status)` に持つ。
2. **差の分類**：

   | 結果 | 例 | 扱い |
   | --- | --- | --- |
   | 一致 | 金額も種類も同じ | 完了 |
   | 金額の差 | 決済代行の手数料の端数、部分返金の食い違い | 許容の範囲（決済代行の手数料の丸めで ±1 円など、設定値）なら自動で `processing_cost` に計上。超えればブレイク |
   | 台帳にない | 決済代行だけが知る決済、自社が取り込み損ねた Dispute | ブレイク |
   | ファイルにない | 締めの時期のずれ | 精算の予定日＋猶予（決済代行ごと）を過ぎるまで待つ。過ぎたらブレイク |

3. **精算のバッチの計上**：一致した明細について、決済代行の手数料を `processing_cost` に、残りを `connector_receivable` の減少として、着金の仕訳（[ledger.md](ledger.md) の 2.3 節）を書く。1 つの精算のバッチは複数の加盟店（複数のシャード）にまたがるので、シャードごとに分けて仕訳を作る（[ledger.md](ledger.md) の 9 節）。
4. **着金**：銀行の明細の入金を、精算のバッチの純額に対応させる。

- 照合の処理は再実行しても結果が同じになるように作る。仕訳の冪等キーは `recon:{source}:{external_id}` とする。
- 照合は本番の環境だけで行う。テストの環境には、模擬の決済代行と模擬の銀行が作る精算ファイル・明細を流し、同じ処理を試せるようにする。

### 5.4 ブレイクと仮勘定

- 説明のつかない差（ブレイク）は `recon_breaks (id, kind, source, external_id, amount, currency, detected_at, age_business_days, status, owner, resolution, resolution_entry_id)` に記録する。`status` は `open` → `investigating` → `resolved` / `written_off`。
- **お金が実際に動いているのに相手が分からないとき**（例：銀行に入金があるのに、どの精算のバッチにも当たらない）は、その時点で仮勘定に計上する：`bank_cash` +X / `suspense:bank_unidentified` −X。預金の口座の残高を、銀行の残高と常に一致させるためである。
- 解消するときは、仮勘定から正しい口座へ振り替える仕訳を書く。**加盟店の残高を動かす解消**（決済代行だけが知っていた Dispute を加盟店に計上するなど）は、担当者と承認者の 2 人の承認を要し、`adjustment` の BT を作る。
- 償却（`loss_write_off`）も 2 人の承認を要する。
- 期限は、ブレイクの検知から T+2 営業日までに 0 件（[NFR-005](README.md)）。期限を過ぎたブレイク、仮勘定の残高が 0 でない状態が 5 営業日続くことを、アラートにする（runbooks）。
- 月末には、仮勘定の残高と未解消のブレイクの一覧を経理に渡す。

## 6. 加盟店向けのレポート

本家のレポートの種類と列に揃える。データは BalanceTransaction の射影から作り、reader か分析用のストアで計算する。

| レポート | 本家の report type | 内容 |
| --- | --- | --- |
| 残高サマリー | `balance.summary.2` | 期首の残高、活動（入金以外）、入金の合計、期末の残高 |
| 活動による残高の変化 | `balance_change_from_activity.summary.2` / `.itemized.*` | `reporting_category` ごとの件数・総額・手数料・純額と、明細 |
| 入金 | `payouts.summary.2` / `payouts.itemized.*` | 期間内の入金。`payout_status`、`payout_expected_arrival_date` など |
| 入金照合 | `payout_reconciliation.summary.2` / `.itemized.*` | 自動入金ごとに含まれた取引。自動入金の加盟店だけ |
| 期末の残高の照合 | `ending_balance_reconciliation.*` | 期末の時点でまだ入金されていない取引 |

- 列は本家の既定の列（`balance_transaction_id`、`created`、`available_on`、`currency`、`gross`、`fee`、`net`、`reporting_category`、`source_id`、`automatic_payout_id`、`automatic_payout_effective_at` など）を持つ（[Payout reconciliation report](https://docs.stripe.com/reports/payout-reconciliation)、[Balance report](https://docs.stripe.com/reports/balance)）。MVP では、顧客・カードの住所などの任意の列は持たない。
- 金額は、本家と同じく主単位（JPY は円）で出す。
- 日の区切りは加盟店が選んだタイムゾーン（既定は Asia/Tokyo）。前日のデータは翌日 12:00 までに揃える（本家と同じ）。
- ダッシュボードで表示・CSV のダウンロードができ、API（`POST /v1/reporting/report_runs` に当たるもの）でも作れる。作成の完了は Event で知らせる。API は MVP の後でもよい（E7 で判断）。

## 7. 社内の会計への出力

- 毎日、前日（JST）の仕訳を、**台帳の口座の種類 → 会計の勘定科目** の対応表で集計し、総勘定元帳への仕訳のファイル（CSV）を出す。集計の単位は、日 × 勘定科目 × 通貨。明細は出さず、台帳の仕訳の ID の範囲で遡れるようにする。

  | 台帳の口座 | 会計の勘定科目（例） |
  | --- | --- |
  | `merchant_pending`、`merchant_available`、`merchant_reserved` | 預り金（加盟店） |
  | `connector_receivable` | 未収入金 |
  | `bank_cash` | 普通預金（口座ごと） |
  | `payouts_in_transit` | 仮払金 |
  | `fee_revenue`、`fx_revenue` | 売上高（手数料） |
  | `processing_cost` | 支払手数料 |
  | `suspense` | 仮受金・仮払金 |

- 勘定科目の名前と、加盟店のお金の会計上の区分（預り金か）は、資金決済法の上の位置づけと経理の方針で変わる。**未決（法務・経理の確認待ち）**。
- 会計の月次の締めの後に、締めた月の日付を持つ仕訳は書かない。遅れて分かった差は、翌月の日付で調整の仕訳にする（仕訳の `effective_at` を過去にしない。[ledger.md](ledger.md) の 3 節）。
- 残高試算表は、日次のスナップショット（[ledger.md](ledger.md) の 4.2 節）から作る。
- 出力先の会計システムは未定。

## 8. データ

| テーブル | 内容 |
| --- | --- |
| `payout_settings` | 入金のスケジュールと入金先 |
| `bank_accounts` | 加盟店の入金先の口座（口座番号は暗号化して保存。[security.md](security.md)） |
| `payouts` | 入金。`status`、`automatic`、`amount`、`arrival_date`、`failure_code`、`failure_balance_transaction_id`、`reconciliation_status`、`retried_by_payout_id`、`batch_id` |
| `payout_batches` | 銀行への依頼の単位。`bank`、`bank_request_ref`、`status`、`submitted_at` |
| `settlement_files`、`settlement_lines` | 決済代行の精算ファイルと、その明細 |
| `bank_statements`、`bank_statement_lines` | 銀行の入出金明細 |
| `recon_matches`、`recon_breaks` | 照合の結果と、ブレイク |
| `gl_exports` | 会計への出力の履歴（日、ファイルのハッシュ、仕訳の ID の範囲） |

すべて `account_id` を持つ（プラットフォームの行は、プラットフォーム用の `account_id`）。照合と会計の処理は、RLS を迂回できる専用のロールで動かし、その操作は監査ログに残す（[security.md](security.md)）。

## 9. Event

本家の名前に揃える：`payout.created`、`payout.updated`、`payout.paid`、`payout.failed`、`payout.canceled`、`payout.reconciliation_completed`、`balance.available`（[events-and-webhooks.md](events-and-webhooks.md)）。

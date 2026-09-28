# Data model: DB 以外の置き場所

Valkey のキー、S3 の配置、SQS、outbox の事象、Webhook、取り込み・出力の形式、給与の出力のファイル、IndexedDB、分析用の基盤（S2）。規約は [data-model.md](../data-model.md) の 3 節、置き場所の一覧は同じく 2 節。

- **全文検索の製品（OpenSearch など）は置かない。** 人の検索は Aurora の `pg_trgm` の索引で行う（[data-model.md](../data-model.md) の 6 節の DM-13）。
- どの置き場所にも、個人番号・口座番号の平文・氏名を、キー・パス・メッセージの属性・ログに入れない。ID（UUID）とハッシュだけ。

## 1. Valkey のキー

正本を置かない。失っても DB から作り直すか、利用者が操作をやり直せば済む。キーはテナントを含める。転送中の暗号化と AUTH（[security.md](../security.md) の 5.1 節）。

| キー | 値 | TTL | 書く・読む | 失ったとき |
| --- | --- | --- | --- | --- |
| `authz:{tenant}:{worker}:{policy_version}:{membership_version}` | 利用者の権限の表（`security_effective_grants` の行の直列化） | 1 時間 | api・worker が読む。無ければ DB から作って置く | DB から作り直す（判定が遅くなるだけ） |
| `sess:{token_sha256}` | セッションの要約（アカウント、テナント、期限、`step_up_at`） | アイドルの期限 | `packages/auth` | DB（`auth_sessions`）から引く |
| `at:{token_sha256}` | API のアクセストークン（`<brand>_at_`）の中身（テナント、API の利用者、連携用の利用者） | 15 分 | 認可の端点が書く。api が読む | 連携が取り直す |
| `rl:{tenant}:{bucket}:{epoch_window}` | レート制限の計数（テナント、API の利用者、打刻の 1 テナント 200 件/秒） | 窓の長さ | api | 一時的に制限が緩む |
| `dl:{token_sha256}` | 1 回限りの取り出しの URL（テナント、S3 のキー、操作者、目的） | 15 分。`GETDEL` で 1 回だけ | 振込ファイル・レポート・明細の取り出し | 取り出しを出し直す |
| `rpt:diff:{tenant}:{worker}:{source}:{column}` | 直近 24 時間の集計の実行ごとの対象の集合（雇用の ID をテナントの HMAC にした値の集合）。差分の攻撃の検知（DT-RPT-002 の #6） | 24 時間 | report-service | 検知が 24 時間弱くなる（監視に出す） |

- 権限の表のキャッシュは版がキーに入るので、無効化の操作は要らない（版を上げれば古いキーは使われない）。

## 2. S3 の配置

バケットの名前は `<brand>` の中立の名前。テナントの物体はキーの 2 段目に `{tenant}` を置き、IAM の条件（接頭辞）とテナントの鍵の暗号の文脈で分ける。

### 2.1 prod のアカウント

| バケット | キー | 中身 | 鍵 | 保存・削除 | 複製 |
| --- | --- | --- | --- | --- | --- |
| `<brand>-prod-tenant-data` | `payroll-inputs/{tenant}/{sha256}.json` | 給与の入力の文書（内容のアドレス。6.1 節） | テナントの鍵 | 給与の入力・結果（既定 7 年）。ライフサイクル | 大阪（RTC） |
| 同上 | `payroll-results/{tenant}/{run_id}/{chunk_no}.jsonl`、`.sha256` | 結果の束（6.2 節） | 同上 | 同上 | 同上 |
| 同上 | `payslips/{tenant}/{payslip_id}.json`、`.pdf` | 明細の表示の文書と PDF（7.3 節） | 同上 | 給与明細（既定 7 年） | 同上 |
| 同上 | `gl-exports/{tenant}/{company_id}/{seq}.csv` | 仕訳の出力（7.2 節） | 同上 | 給与の仕訳（既定 10 年） | 同上 |
| 同上 | `report-outputs/{tenant}/{run_id}.{csv\|xlsx\|pdf}` | レポートの非同期の出力 | 同上 | 7 日 | なし |
| 同上 | `export-files/{tenant}/{run_id}.{csv\|xlsx}` | 一括の出力・定期の出力 | 同上 | 7 日 | なし |
| 同上 | `import-files/{tenant}/{batch_id}`、`import-results/{tenant}/{batch_id}.csv` | 一括の取り込みのファイルと結果 | 同上 | 30 日 | なし |
| 同上 | `migration-files/{tenant}/{migration_run_id}/...` | 移行のファイル（現行のシステムの本番のデータ） | 同上 | 取り込みの完了から 30 日 | なし |
| 同上 | `attachments/{tenant}/{attachment_id}` | 添付（`attachments`） | 同上 | 目的のデータの種類 | 大阪 |
| `<brand>-prod-bank-files` | `bank-files/{tenant}/{file_id}` | 振込ファイル（7.1 節。口座番号の平文を含む） | `<brand>-bank-files` | 振込ファイル（既定 5 年。Object Lock なし、版の管理） | 大阪（支給日の DR） |
| `<brand>-web-assets` | `web-assets/{version}/...` | SPA の静的な資産 | `<brand>-platform-data` | 版ごと（前の版を戻しのために残す） | CloudFront |

- テナントの物体は SSE-KMS（バケットキー）。暗号の文脈 `{"tenant_id": "..."}`。S2 からはテナントの DEK によるアプリの側のエンベロープ暗号化（[security.md](../security.md) の 5.3 節）。
- 振込ファイル・明細・レポートの取り出しは、署名つき URL を直接渡さず、`dl:` の 1 回限りの URL を経る（取り出しを記録する）。
- 並行稼働の報告など、個人を指す出力で仮の ID が要るときは `HMAC-SHA256(tenant_hmac_key, "parallel:" ‖ employment_id)` の先頭 16 バイトの 16 進にする（鍵は `tenant_keys.hmac_key_ct`）。

### 2.2 log-archive のアカウント（Object Lock）

| キー | 中身 | Object Lock | 保存 |
| --- | --- | --- | --- |
| `audit/{tenant}/{yyyy}/{mm}/{dd}/{seq}.jsonl.gz` | テナントの監査のセグメント（6.3 節） | コンプライアンス | 監査ログ（既定 10 年） |
| `audit/_platform/{yyyy}/{mm}/{dd}/{seq}.jsonl.gz` | プラットフォームの監査のセグメント | コンプライアンス | 同上 |
| `anchors/{yyyy-mm-dd}.json` | 日の署名（6.4 節） | コンプライアンス | 同上 |
| `vault-audit/{tenant}/{yyyy}/{mm}/{dd}/{seq}.jsonl.gz` | 保管庫のアクセスの記録（番号を含まない） | コンプライアンス | 同上 |
| `rule-sources/{kind}/{sha256}` | 規則表の元のファイル | コンプライアンス | 給与の入力・結果（結果が指す間） |
| `rule-releases/{release_id}/bundle.tar`、`bundle.sig` | 規則表の署名した束（[ADR-0062](../../decisions/0062-rule-table-release-calendar.md)） | コンプライアンス | 同上 |
| `cloudtrail/`、`config/`、`vpc-flow/`、`app-logs/` | AWS の記録とアプリのログ（個人情報を含まない） | ガバナンス | 規則による |

- 閲覧の記録など、確認で期間が短くなりうるものはコンプライアンスにしない（[audit-and-retention.md](../audit-and-retention.md) の 5.4 節）。

### 2.3 vault-prod のアカウント（Object Lock なし）

| バケット | キー | 中身 | 鍵 | 保存 |
| --- | --- | --- | --- | --- |
| `<brand>-vault-docs` | `docs/{tenant}/{document_id}` | 法定の書類（番号を含む。P4） | `vault-docs` | 書類の種類ごと（`mn_documents.retain_until`） |
| 同上 | `verification-images/{tenant}/{verification_id}/{n}` | 本人確認の画像（P4） | 同上 | 確認の後 30 日（L44） |
| 同上 | `migration-uploads/{tenant}/{upload_id}` | 現行のシステムの番号の移行のファイル | 同上 | 取り込みの後に消す |

- 版の管理を有効にし、消した版は 1 日で完全に消えるライフサイクル（期限の前に消せるよう Object Lock を使わない）。

## 3. SQS

どれも標準キューと DLQ（5 回の失敗で DLQ）。メッセージの本文は下の共通の形。本文に個人情報を入れない。

```jsonc
{ "event_id": "…", "tenant_id": "…", "event_type": "temporal.changed",
  "payload": { /* 4 節の形 */ }, "traceparent": "00-…" }
```

| キュー | 送り手 | 受け手 | 中身 |
| --- | --- | --- | --- |
| `bp-steps` | Relay（`bp.step_execute`・`bp.case_completed`） | bp-worker | サービスのステップ、通知のステップ、タイマーの発火 |
| `bp-bulk` | Relay（`bp.bulk_chunk`） | bp-worker | 一括の子の案件の束（200 件） |
| `temporal-effects` | Relay（`temporal.*`、`time.summary_superseded`、`absence.retro_changed`、`rule_table.corrected`、`payroll.adjustment_retro`） | worker（遡及の候補、付与の再判定、36 協定、権限の表） | 購読する領域ごとに SNS なしで Relay が複数のキューへ写す（`temporal-effects-payroll` など） |
| `time-recalc` | Relay（`time.clock_recorded`・`time.inputs_changed`） | worker | 日と週・期間の再計算 |
| `payroll-chunks` | worker（入力の固定） | Payroll Compute | 束の ID（`run_id`、`chunk_no`、入力の S3 のキーの一覧の `manifest_hash`） |
| `payroll-load` | Payroll Compute | loader | 束の結果の S3 のキーと SHA-256 |
| `payroll-docs` | Relay（`payroll.run_state_changed`） | worker | 支払の指示、振込ファイル、明細の文書と PDF、仕訳 |
| `notifications` | Relay（`bp.notification_requested` など） | worker | メール・画面の通知（本文に個人情報を入れない） |
| `webhooks-egress` | Relay | egress Worker | Webhook の送信（`webhook_deliveries`） |
| `reports-async` | api | worker | レポートの非同期の実行、定期の出力 |
| `bulk-import` | api | worker | 一括の取り込みの解析と検証 |
| `vault-sync` | Relay（`mn.handler_designated`） | worker → 保管庫の API | 事務取扱担当者の指定の送信（署名つき） |

## 4. outbox の事象

`outbox.event_type` と `payload` の形。どれも ID とコードだけ。

| 事象 | 出す領域 | 受ける領域 | `payload` |
| --- | --- | --- | --- |
| `temporal.changed` | 有効日付 | 権限（キャッシュ）、勤怠（36 協定の事業場）、分析用の書き出し（S2） | `{facet, subject_type, subject_id, from: "YYYY-MM-DD", case_id, kind}` |
| `temporal.retro_detected` | 有効日付 | 給与（遡及の候補）、休暇（付与の再判定）、社会保険（等級） | `{facet, subject_type, subject_id, from, to, case_id, kind}` |
| `temporal.activated` | 発効のタイマー | SSO のアカウント、権限、通知、Webhook | `{activation_id, facet, subject_id, handler, effective_on}` |
| `bp.case_completed` | 業務プロセス | 通知、Webhook、保管庫（担当者の指定） | `{case_id, process_type, subject_type, subject_id}` |
| `bp.step_opened` | 業務プロセス | 通知 | `{case_id, step_id, process_type}` |
| `bp.notification_requested` | 業務プロセス | 通知 | `{case_id, step_id, template, recipient_worker_ids}` |
| `bp.step_execute`、`bp.bulk_chunk` | 業務プロセス | bp-worker | `{case_id, step_id, attempt}`、`{parent_case_id, chunk_no, row_ids}` |
| `time.clock_recorded`、`time.inputs_changed` | 勤怠 | 勤怠の再計算 | `{employment_id, work_date}` |
| `time.summary_superseded` | 勤怠 | 給与（遡及の候補） | `{period_id, employment_id, version}` |
| `absence.retro_changed` | 休暇 | 給与（遡及の候補）、勤怠 | `{employment_id, leave_date, ledger_entry_id}` |
| `payroll.adjustment_retro` | 給与（個別の調整） | 給与（遡及の候補） | `{adjustment_id, employment_id, for_period_start}` |
| `rule_table.corrected` | 規則表 | 給与（遡及の候補） | `{rule_table_id, kind, supersedes_id, valid}` |
| `payroll.run_state_changed` | 給与 | 支払、明細、仕訳、Webhook、里程標 | `{run_id, from, to}` |
| `mn.handler_designated` | 業務プロセス（`mn_handler_designation`） | 保管庫（署名つき） | `{designation_id, worker_id, purposes, valid, case_id, approved_by}` |
| `bulk_import.completed` | 連携 | Webhook、通知 | `{batch_id, state}` |

## 5. Webhook

- 本文（例）：`{"id": "<event_id>", "type": "bp.case_completed", "created_at": "2026-10-01T00:00:00.000Z", "data": {"case_id": "…", "process_type": "job_change"}}`。個人情報を入れない。受け手は API で中身を取りに来る（権限の判定が効く）。
- 見出し：`<Brand>-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, t + "." + body)>`、`<Brand>-Event-Id: <event_id>`。受け手は 5 分より古い署名を拒む。
- 送れる事象：`bp.case_completed`、`temporal.activated`、`payroll.run_state_changed`、`bulk_import.completed`。
- 少なくとも 1 回。指数の待ちで 24 時間まで再送し、止めた登録は管理者に知らせる（`webhook_endpoints.disabled_at`）。

## 6. 給与の中間のファイル

### 6.1 入力の文書（`payroll-input/1`）

形は [payroll-engine.md](../payroll-engine.md) の 5.2 節が正本。正規の形は RFC 8785、ハッシュは SHA-256。金額は整数の円（JSON の数。`Number.MAX_SAFE_INTEGER` 以内）、率は 10 進の文字列、日付は `YYYY-MM-DD`、時刻は UTC の ISO 8601（ミリ秒）。マイナンバー・口座番号・住所・氏名を入れない。

### 6.2 結果の束（`payroll-result/1`、JSON Lines）

1 行 1 人。束のファイルの SHA-256 を `.sha256` に置き、Loader が確かめる。

```jsonc
{ "schema": "payroll-result/1", "run_id": "…", "chunk_no": 12, "employment_id": "…",
  "status": "ok", "input_hash": "…", "rule_versions_hash": "…", "engine_digest": "sha256:…",
  "config_snapshot_id": "…", "gross": 300000, "total_deductions": 62050, "net": 237950,
  "lines": [ { "seq": 1, "item_code": "base", "item_version": 3, "amount": 290000,
               "quantity": null, "rate": null, "basis": {}, "retro_period": null, "retro_of_result_id": null } ],
  "error": null }
```

### 6.3 監査のセグメント（`audit-segment/1`、gzip の JSON Lines）

1 行目は見出し `{"tenant_id", "seq", "stream", "window_start", "window_end", "prev_seg_hash"}`、2 行目から `audit_events` の行の正規の形。最後の行は `{"row_count", "seg_hash"}`。`seg_hash = SHA-256(prev_seg_hash ‖ SHA-256(行 1) ‖ … ‖ SHA-256(行 n))`。

### 6.4 日の署名（`anchors/{date}.json`）

`{"date", "merkle_root", "leaves": [{"tenant_id", "last_seq", "seg_hash"}], "key_id", "signature"}`。署名は `<brand>-audit-anchor`（ECDSA、SHA-256）。

## 7. 出力のファイル

### 7.1 振込ファイル（全銀協の規定形式。給与・賞与振込）

- 固定長 120 バイトのレコード。ヘッダー（データ区分 `1`）× 1、データ（`2`）× n、トレーラー（`8`）× 1、エンド（`9`）× 1。支払元の口座 × 種別（給与 `11`・賞与 `12`）× 振込指定日ごとに 1 ファイル（[payments-and-accounting.md](../payments-and-accounting.md) の 3.4 節）。
- 文字はコード区分 `0`（JIS の半角の英数・カナ、1 バイト）を既定、`1`（EBCDIC）を選べる。数字の欄は右詰めの 0 埋め、文字の欄は左詰めの空白埋め。レコードの区切りと EOF は `payer_accounts.file_options`。
- 欄の並び（下の表）は、E10 の `zengin-file-generation` の前にテナントの銀行の仕様書で確かめる（**未検証**）。

| レコード | 欄（バイト数） |
| --- | --- |
| ヘッダー | データ区分 `1`（1）、種別コード `11`・`12`（2）、コード区分（1）、振込依頼人コード（10）、振込依頼人名（40）、振込指定日 `MMDD`（4）、仕向銀行番号（4）、仕向銀行名（15）、仕向支店番号（3）、仕向支店名（15）、預金種目（1）、口座番号（7）、ダミー（17） |
| データ | データ区分 `2`（1）、被仕向銀行番号（4）、被仕向銀行名（15）、被仕向支店番号（3）、被仕向支店名（15）、手形交換所番号（4）、預金種目（1）、口座番号（7）、受取人名（30）、振込金額（10）、新規コード（1）、社員番号・所属コードなどの欄（20。既定は空白）、ダミー（9） |
| トレーラー | データ区分 `8`（1）、合計件数（6）、合計金額（12）、ダミー（101） |
| エンド | データ区分 `9`（1）、ダミー（119） |

- データのレコードは `payment_instructions` を `(bank_code, branch_code, employment_id, seq)` の順に並べる。同じ指示から同じバイト列（DT-PMT-001 の検査の後に `bank_files.file_sha256`）。

### 7.2 仕訳の出力（汎用の CSV）

- UTF-8（BOM を選べる）、CRLF、RFC 4180 の引用。列：`company_code`、`accounting_date`、`journal_id`、`line_no`、`account_code`、`department_code`、`debit`、`credit`、`description`（元の項目の区分。従業員の値を入れない）。
- 1 ファイル＝1 束（`gl_export_batches`）。同じ束は同じバイト列。テナントの雛形では列の名前と順を変えられる。

### 7.3 明細の文書（`payslip/1`）と PDF

```jsonc
{ "schema": "payslip/1", "payslip_id": "…", "tenant_id": "…", "employment_id": "…",
  "run": { "id": "…", "kind": "regular", "period": ["2026-09-21", "2026-10-20"], "pay_date": "2026-10-23" },
  "person": { "display_name": "…", "employee_number": "…", "org_name": "…" },       // known_at の時点
  "time": { "worked_days": 20, "minutes": { "statutory_ot": 1230, "night": 60 } },
  "earnings": [ { "code": "base", "label": "基本給", "amount": 290000 } ],
  "deductions": [ { "code": "jp.health_side", "label": "健康保険料", "amount": 15120,
                    "breakdown": [ { "label": "うち子ども・子育て支援金", "amount": 345 } ] } ],
  "retro": [ { "period": "2026-08", "code": "base", "amount": 5000 } ],
  "totals": { "gross": 300000, "deductions": 62050, "net": 237950 },
  "payments": [ { "bank_name": "…", "account_last4": "1234", "amount": 237950 } ],
  "leave": { "annual_remaining_days": "12.5" } }
```

- 正規の形の SHA-256 を `payslips.doc_json_sha256`。PDF は文書から座標で描き、作成日時は確定の時刻に固定する（`pdf_sha256`）。口座は銀行名と末尾 4 桁だけ。

### 7.4 一括の取り込みの雛形と結果

- 名前：`<brand>-bulk-<process_type>-v<N>.xlsx`（CSV は UTF-8）。1 枚目は列の説明・型・選べる値。
- 共通の列：`row_id`（冪等のキー）、`employee_number`（主体）、`effective_on`、`operation`（`change`・`end`・`correct`・`rescind`）、`target_case_id`（訂正・取消の対象）。その後に種類ごとの payload の列（Zod のスキーマから作る）。
- 結果のファイル：`row_id`、`status`、`case_id`、`error_codes`。入力の値を写さない。
- 住民税の通知（`resident_tax_notice`）：`employee_number`、`fiscal_year`、`municipality_code`、`notice_kind`、`annual_amount`、`june`〜`may`（12 列）。
- 現行の給与の結果（並行稼働）：`employee_number`、`pay_month`、`run_kind`、`legacy_item_code`、`amount`。現行の勤怠の集計：`employee_number`、`period_start`、`period_end`、区分ごとの分の列、日数の列。
- 打刻機のファイル：テナントが作る列の対応の雛形で、`terminal_code`・`badge_id`・`terminal_seq`（あれば）・`kind`・`occurred_at` に写す。

### 7.5 一括の出力

- CSV（UTF-8、BOM を選べる）と xlsx。`=`・`+`・`-`・`@` で始まる値の先頭に `'` を足す。xlsx は値を文字列か数で書き、式を書かない（[reporting.md](../reporting.md) の 4.4 節）。
- 口座番号の全桁とマイナンバーは入れない。

### 7.6 打刻機の送信（API）

`POST /api/v1/clock-terminals/{terminal_id}/events`（見出し `Authorization: Bearer <brand>_tk_…`）。本文：`{"events": [{"terminal_seq": 10231, "badge_id": "…", "kind": "clock_in", "occurred_at": "2026-10-01T00:59:12Z"}]}`（500 件まで）。応答は件ごとの `accepted`・`duplicate`・`unmatched`。

## 8. 分析用の基盤（S2）

Aurora から夜間に、変更した主体だけを書き出す。データの元（`report_sources`）の列だけで、マイナンバー・口座・住所・要配慮を書き出さない。氏名は表示の名前だけ。定義元：[reporting.md](../reporting.md) の 6.2 節。

| Iceberg の表 | 行 | パーティション |
| --- | --- | --- |
| `worker_job_periods` | 職務の割り当て × 期間（現在の表の写し。`valid_from`・`valid_to`） | `tenant_id`、`bucket(employment_id)` |
| `employment_periods` | 雇用 × 期間（在籍、雇用区分、基本給） | 同上 |
| `org_closure_periods` | 閉包 | `tenant_id` |
| `positions_periods` | ポジション × 期間 | `tenant_id` |
| `time_summaries` | 雇用 × 締めの期間 | `tenant_id`、`month(period_start)` |
| `leave_balances_daily` | 雇用 × 種類 × 日末 | `tenant_id`、`month(day)` |
| `payroll_result_lines` | 雇用 × 実行 × 項目 | `tenant_id`、`month(pay_date)` |
| `bp_cases` | 案件（状態と期限だけ） | `tenant_id`、`month(initiated_at)` |

- Athena の問い合わせは report-service のロールだけ。同じ `scopeFilter`・`project` を組み立てる。鮮度は前日の終わりまで。
- 保存：元の表と同じ規則。元で消した主体は、次の書き出しで消す。

## 9. ブラウザ IndexedDB

### 9.1 `pending_clock_events`

未送信の打刻（打刻の画面だけ）。定義元：[time-and-attendance.md](../time-and-attendance.md) の 3.2 節、[self-service-ui.md](../self-service-ui.md) の 4 節。

| 項目 | 型 | 説明 |
| --- | --- | --- |
| `client_event_id` | string（UUIDv7） | キー。サーバーの冪等のキー |
| `tenant_id`・`employment_id` | string | |
| `kind` | string | `clock_in`・`clock_out`・`break_start`・`break_end` |
| `occurred_at` | string（ISO 8601） | 端末の時刻 |
| `created_at` | string | |
| `attempts` | number | |

- 送信に成功したら消す。ログアウトでも未送信のものは残し、同じ利用者のログインで送る（別の利用者のログインでは送らず、画面で知らせる）。個人情報は打刻の時刻だけ。

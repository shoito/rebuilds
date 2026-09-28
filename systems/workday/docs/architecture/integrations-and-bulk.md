# Integrations and bulk: Workday

外との出入りを決める。一括の取り込み・出力（表計算の雛形、検証、有効日付つきの取り込み、業務プロセスを通すこと、部分の失敗）、現行のシステムからの移行（履歴と期首の値）、並行稼働の入力の取り込み、API と Webhook、ログインと SSO（SAML・OIDC）、打刻機の連携を扱う。

前提の決定は、人事のデータは業務プロセスを通して変えること（[ADR-0003](../decisions/0003-business-process-engine.md)。一括の取り込みも同じ）、2 軸の有効日付（[ADR-0002](../decisions/0002-effective-dated-data-model.md)）、権限の判定を 1 か所にまとめること（[ADR-0005](../decisions/0005-security-and-my-number.md)、[ADR-0017](../decisions/0017-authorization-evaluator.md)）、並行稼働の比較（[ADR-0029](../decisions/0029-parallel-run-and-compute-partitioning.md)）、打刻の冪等（[ADR-0021](../decisions/0021-clock-events-corrections-and-objective-records.md)）。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0042](../decisions/0042-bulk-import-through-business-processes.md) | 一括の取り込みは、雛形のファイルを全行検証してから、親の案件の下に行ごとの子の案件を作り、同じ主体の行は有効日の順に直列に流す。行ごとに冪等のキーを持ち、失敗した行は、同じ主体の後の行だけを止める。一括の出力はレポートの実行の仕組みで行う |
| [0043](../decisions/0043-migration-history-and-parallel-run-inputs.md) | 移行は、現行のシステムの履歴を「移行」の種類の差分として有効日の順に取り込み、給与のグループごとの本番の開始日（`go_live_on`）より前の期間に遡及を出さない。期首の値（累計、等級、年休の残り、住民税）は種類ごとの台帳に `migrate` として入れる。並行稼働は、現行の結果に加えて現行の勤怠の集計を入力として取り込めるようにし、計算の差と入力の差を分ける |
| [0044](../decisions/0044-sso-api-clients-and-clock-terminals.md) | 利用者のログインと SSO（SAML 2.0・OIDC）は、Slack の題材と同じく Better Auth を API のプロセスの中で使い、本システムは SP・RP だけになる。Auth0 の題材を IdP にはしない。API の利用者は OAuth 2.0 のクライアントクレデンシャル（`private_key_jwt`）で、連携用の利用者に結び、同じ権限の判定を通す。打刻機は端末ごとの鍵で送り、端末の連番から打刻の ID を決める |

## 1. 目的と範囲

- 扱う：一括の取り込みの雛形・検証・実行・結果、一括の出力、移行（人・組織・履歴・期首の値）、並行稼働の取り込み（結果と入力）、公開の API・Webhook、API の利用者の認証、利用者のログイン・SSO・セッション・再認証、打刻機の連携。
- 扱わない：業務プロセスの状態機械（[business-process-engine.md](business-process-engine.md)）、並行稼働の差の分類と切り替えの判定（[payroll-engine.md](payroll-engine.md) の 10 節）、マイナンバーの取り込み（[my-number-vault.md](my-number-vault.md) の 8 節。保管庫が受ける）、打刻の計算（[time-and-attendance.md](time-and-attendance.md)）、振込ファイルと仕訳の出力（[payments-and-accounting.md](payments-and-accounting.md)）、電子申請（E14）。
- **一括でも API でも、業務プロセスと権限の判定を迂回しない**（[AGENTS.md](../../AGENTS.md)）。

## 2. 本家の形（確かめたこと）

本家の実装は使わない（[リポジトリ共通の ADR-0007](../../../../docs/decisions/0007-no-reuse-of-original-implementation.md)）。形式の互換も目標にしない（[リポジトリ共通の ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)、[intent.md](../intent.md) の Non-goals）。

| 本家の考え方 | 内容 | このシステムでの扱い |
| --- | --- | --- |
| 一括の取り込み（EIB） | Web サービスの操作を選び、雛形の表計算を生成し、行を埋めて取り込む（[Teamup9 の解説](https://teamup9.com/workday-eibs-spreadsheet-driven-data-loading/)など二次資料、2026-09-28 に検索の要約で確認。未検証） | 業務プロセスの種類ごとの雛形（[ADR-0042](../decisions/0042-bulk-import-through-business-processes.md)） |
| 連携の権限 | ドメインの権限に連携の Get・Put がある（[Security](https://doc.workday.com/workday-education/en-us/course-manuals/financial-management-for-administrators/security.html)、2026-09-28 に確認） | `get`・`put`（[security-model.md](security-model.md) の 3.2 節） |
| 連携用の利用者 | 連携は、人でない連携用の利用者（Integration System User）の権限で動く。連携のシステムごとに 1 つ作り、その連携に要る権限だけを与える（[Create Integration System Users for Apps](https://developer.workday.com/documentation/GUID-f8d46604-e156-492f-a324-62ed2f6496f7/CreateIntegrationSystemUsersforApps)、[Assign an Integration System User Account to an Integration](https://doc.workday.com/admin-guide/en-us/workday-studio/integration-configuration/say1512990013424.html)、2026-09-28 に検索の要約で確認） | API の利用者を連携用の利用者に結ぶ（6 節） |

## 3. 一括の取り込み（[ADR-0042](../decisions/0042-bulk-import-through-business-processes.md)）

### 3.1 雛形

- 雛形は業務プロセスの種類ごと（`hire`、`job_change`、`compensation_change`、`terminate`、`address_change`、`payment_election_change`、`time_off_request`、`leave_balance_adjustment`、`resident_tax_notice` など）に、システムが payload のスキーマ（Zod）から作る。
- 形式は xlsx と CSV（UTF-8）。1 行 1 案件。列は payload の項目と、共通の列（行の ID、主体の社員番号、有効日、操作（`change`・`end`・`correct`）、訂正の対象の案件）。
- 雛形の 1 枚目に、列の説明、型、選べる値（組織・職務のコード）を出す。選べる値は、雛形を作った時点のテナントの設定から出す。
- 名前は `<brand>-bulk-<process_type>-v<N>.xlsx`。本家の名前を使わない。

### 3.2 流れ

```
アップロード（put の権限）──▶ S3 import-files/{tenant}/{batch_id}（テナントのデータの鍵）
   ▼
解析と行ごとの検証（Worker）：スキーマ、コードの存在、権限（行の主体に put と initiate を持つか）
   ▼
行をまたぐ検証：同じ主体の行の有効日の順、同じ主体・同じ有効日・同じ項目の重なり（SAME_DAY_CONFLICT の事前の検出）、
               行の ID の重複、ファイルの中の社員番号の重複
   ▼
予覧（dry run）：行ごとの結果（受ける・警告・拒否）と、主体ごとの変更の前後の要約。データは書かない
   ▼
確定の操作（アップロードした人）──▶ 親の案件 bulk_import（承認つき。3.4 節）
   ▼
子の案件を行ごとに作り、主体ごとに有効日と seq の順で直列に流す。主体の間は並列
   ▼
結果のファイル（行ごとの状態、案件の ID、拒否の理由のコード）
```

- 検証は全行を先に行い、拒否の行があっても、それ以外の行で進めるかを確定の操作のときに選ぶ（既定は「拒否の行が 0 件のときだけ進める」）。
- 1 ファイル 5 万行まで。超えるなら分ける。
- 子の案件は、業務プロセスのエンジンの親子の案件（[business-process-engine.md](business-process-engine.md) の 9 節）で束ごとに実行する。1 つの子の案件は 1 つの主体の 1 つのトランザクション（`transaction_timeout = 5s`。[ADR-0008](../decisions/0008-point-in-time-queries-and-activation-timers.md)）。

### 3.3 冪等と部分の失敗

- 行の冪等のキーは `(tenant_id, batch_id, row_id)`。同じファイルを 2 回確定しても、子の案件は 1 回だけ作る。別のファイルに同じ内容を入れると別の案件になる（行の中身のハッシュが同じなら警告する）。
- 子の案件の失敗は、その主体の後の行（同じ主体で、有効日が同じか後の行）を `blocked` にし、他の主体は続ける。
- 親の案件は、全行が完了なら `completed`、一部が失敗・`blocked` なら `partially_applied` にする（[business-process-engine.md](business-process-engine.md) の 9 節）。直した行だけを新しいファイルで出し直す（元の `row_id` を使えば冪等）。
- 完了した子の案件を一括で戻すときは、取消（rescind）の一括の雛形で、後の有効日の行から順に取り消す（[ADR-0007](../decisions/0007-change-correction-rescind-semantics.md)）。

### 3.4 承認

- 親の案件 `bulk_import` は、アップロードした人と別の人の承認を要する（職務分掌。[security-model.md](security-model.md) の 5.1 節の S6 と同じ考え方）。承認の画面は、予覧の要約（件数、主体の数、種類、警告）を出す。
- 子の案件の承認は、子の種類の定義の `bulk_approval` で決める。

| `bulk_approval` | 子の承認 | 使える種類 |
| --- | --- | --- |
| `per_case`（既定） | 子の定義どおりに 1 件ずつ承認する | すべて |
| `parent` | 親の承認で子の承認のステップを満たす。親の承認者は、子の種類の `approve` の権限を、全行の主体の範囲で持たなければならない | テナントが定義で明示した種類だけ。給与・口座・退職・権限の種類では、定義の有効化の画面で明示の確認を求める（[ADR-0016](../decisions/0016-bp-definition-validation-and-activation.md)） |

- 子の案件の職務分掌（起票者と承認者が同じでない）は、`parent` でも行ごとに確かめる。

### 3.5 一括の出力

- 一括の出力は、レポートの実行の仕組み（[reporting.md](reporting.md) の 4.3 節）で、`get` の権限で行う。列の射影・範囲の絞り込み・閲覧の記録は同じ。
- 形式は CSV・xlsx。定期の出力（毎日、毎月）はテナントが予約でき、結果は S3 に置いて、API で取りに来てもらう（本システムから外へ押し出す SFTP は MVP の外）。
- 出力に口座番号の全桁とマイナンバーは入れない。

## 4. 移行（[ADR-0043](../decisions/0043-migration-history-and-parallel-run-inputs.md)）

### 4.1 範囲

| データ | 取り込み方 | 検証 |
| --- | --- | --- |
| 組織、階層、ポジション、職務、等級 | 有効日付の差分（`migration` の種類）。移行の始まりの日から | 階層の循環、各時点の組織の数 |
| 人、雇用、職務の割り当て、給与、住所、扶養、口座 | 有効日付の差分。履歴は移行の範囲の最初の日（既定：本番の開始の 2 年前の年度の始め）から | 現行の人員の一覧（時点ごと）との一致 |
| 過去の退職者 | 雇用を閉じた形で。保存の期間の中の人だけ（[audit-and-retention.md](audit-and-retention.md)） | 件数 |
| 社会保険の等級と決定の履歴、標準賞与額の年度の累計 | facet `worker_social_insurance` と累計の台帳 | 現行の等級と一致 |
| 源泉所得税・社会保険料・支給の年の累計（年末調整の準備） | 期首の累計の台帳（`payroll_ytd_opening`） | 現行の累計と 1 円まで一致 |
| 年休の付与と残り | `leave_ledger_entries` の `migrate`（[absence-and-leave.md](absence-and-leave.md) の 9 節） | 雇用ごとの残りの合計が現行と一致 |
| 住民税の通知 | `resident_tax_notices` | 年税額と月割額の検査（[ADR-0033](../decisions/0033-employment-insurance-and-resident-tax.md)） |
| 36 協定の対象期間の累計 | 期首の累計（`overtime_ytd_opening`） | 現行の集計と一致 |
| マイナンバー | 保管庫の移行の経路（[my-number-vault.md](my-number-vault.md) の 8 節）。人事の側を通さない | 件数、チェックデジット |

### 4.2 規則

- 移行の差分は `migration` の業務プロセスの種類で入れる。この種類は、テナントの状態が `implementing` の間か、給与のグループが本番を始める前の雇用にだけ使える。承認は親の案件の 1 回（3.4 節の `parent`）にし、行ごとの業務の承認は求めない。移行の実行の権限は、テナントの導入の担当（本システムの支援の担当ではない）に限る。
- 差分の `recorded_at` は取り込みの時刻になる。移行より前の `known_at` の問い合わせには何も出ない（「そのときシステムは知らなかった」）。監査の画面で、移行の差分には印を出す。
- **本番の開始日（`go_live_on`）**：給与のグループごとに持つ。`go_live_on` より前の期間には、本システムの確定した結果がないので、遡及の候補（[ADR-0028](../decisions/0028-retro-deltas-and-bonus-runs.md)）を作らない。`go_live_on` より前の有効日の変更が本番の後に入ったら、「現行の期間の遡及」として給与の担当の受信箱に出し、差額は手の調整（個別の調整の入力）で扱う。
- 移行の検証の報告：データの種類ごとに、件数・合計・時点の人員の一致を、現行のシステムの出力と比べて出す。報告は個人を特定できる値を出さず、差のある主体は仮の ID で示す（[AGENTS.md](../../AGENTS.md)）。
- 移行のファイル（現行のシステムの本番のデータ）は、本番のアカウントの S3 にだけ置き、取り込みの完了から 30 日で消す（保存の期間の対象は取り込んだ後のデータ）。開発・ステージングに持ち込まない。

### 4.3 手順（テナントごと）

| 段 | すること | 判定 |
| --- | --- | --- |
| 1. 設定 | 会社、事業所、給与のグループ、項目、勘定の対応、業務プロセスの定義、権限の方針 | 設定の検査 |
| 2. 試しの移行 | 本番のアカウントの検証用のテナント（sandbox）に全件を入れる | 4.2 節の検証の報告で差 0 件 |
| 3. 並行稼働 | 本番のテナントに移行し、並行稼働の実行を 3 か月（5 節） | NFR-001、K2 |
| 4. 差分の移行 | 並行稼働の間の現行のシステムの変更を、差分のファイルで入れ続ける。または本システムを正本にして現行へ出す（テナントが選ぶ） | 月ごとの人員の一致 |
| 5. 切り替え | `go_live_on` を決め、現行での入力を止める | 切り替えの判定（[payroll-engine.md](payroll-engine.md) の 10 節） |

- sandbox は本番と同じアカウントの別のテナント（`environment = sandbox`）。本番のデータを写すので、本番と同じ扱い（開発の環境ではない）。

## 5. 並行稼働の取り込み（[ADR-0043](../decisions/0043-migration-history-and-parallel-run-inputs.md)）

- 現行の結果（従業員 × 項目 × 月の金額）は `legacy_payroll_results` に取り込み、`legacy_item_map` で本システムの項目に対応させる（[ADR-0029](../decisions/0029-parallel-run-and-compute-partitioning.md)）。取り込みの検証：現行の給与の一覧表の合計（支給・控除・差引の総額、人数）と一致すること。
- **入力の取り込み**：並行稼働の実行は、勤怠の集計・個別の調整の入力を、次のどちらから取るかを実行ごとに選ぶ。

| 入力の元 | 使いどころ | 差の分類 |
| --- | --- | --- |
| 本システムの勤怠の締め（既定） | 本番と同じ流れを確かめる | 差には計算の差と勤怠の差が混ざる |
| 現行の勤怠の集計の取り込み（`legacy_time_summaries`） | 計算だけの差を見る | 入力が同じなので、差は計算・設定・端数の差になる |

- 2 つの元で並行稼働を 2 回回し、両方の差を比べると、`input_diff` と計算の差を分けられる。
- 取り込みと比較は本番の環境の中だけで行う。現行の結果の取り込みの契約上の扱いは法務の確認待ち（[intent.md](../intent.md) の L11）。確認まで E9 の `parallel-run-compare` の spec を承認しない。

## 6. API と Webhook（[ADR-0044](../decisions/0044-sso-api-clients-and-clock-terminals.md)）

### 6.1 API

- 公開の API は `https://<tenant>.<brand>.<domain>/api/v1/...`。Hono＋Zod から OpenAPI を出す。画面の API と同じ実装で、公開の版を固定する（破壊的な変更は `v2`）。
- 読み取り（`GET`）は `effective_on`・`known_at` を受ける（`known_at` は `audit` の権限）。一覧はカーソルで分け、1 ページ 200 件まで。
- 書き込みは業務プロセスの起票だけ（`POST /api/v1/business-processes/{process_type}`）。`Idempotency-Key` の見出しを必須にし、24 時間同じ応答を返す。直接の更新の API はない。
- 金額は整数の円（JSON の数値）、率は 10 進の文字列（[ADR-0001](../decisions/0001-platform-and-stack.md)）。
- レート制限：テナントごとと API の利用者ごと。支給日の前の 5 営業日は、書き込みの制限を下げる案を E12 で決める。

### 6.2 API の利用者

- テナントの管理者が、API の利用者（`api_clients`）を登録し、**連携用の利用者**（人でない利用者。`integration_users`）に結ぶ。連携用の利用者はセキュリティグループに入り、ドメインの `get`・`put` と業務プロセスの `initiate` を持つ。権限の判定は人と同じ（[ADR-0017](../decisions/0017-authorization-evaluator.md)）。
- 認証は OAuth 2.0 のクライアントクレデンシャル。クライアントの認証は `private_key_jwt`（公開鍵を登録）を既定にし、`client_secret_basic` も受ける（秘密はハッシュで保存し、1 回だけ表示）。アクセストークンは 15 分。トークンの接頭辞は `<brand>_at_`。
- API の利用者が起票した案件は、起票者が連携用の利用者になる。承認は人が行う（連携用の利用者に `approve` を与えない。職務分掌の既定の規則に足す）。
- 連携用の利用者のすべての要求は、監査の記録に `actor_type = integration` で残る。

### 6.3 Webhook

- 業務プロセスの完了、発効、給与の実行の段の変化、一括の取り込みの完了を、テナントが登録した URL に送る。
- 本文は事象の種類と ID だけ（例：`{"type":"bp.case_completed","case_id":"...","process_type":"job_change"}`）。個人情報を入れない。受け手は API で中身を取りに来る（権限の判定が効く）。
- 署名は `<Brand>-Signature: t=<unix>,v1=<HMAC-SHA256>`。秘密は登録ごと。受け手は 5 分より古い署名を拒む。
- 送信は outbox → SQS → 専用の egress の Worker（名前解決の後の IP の検査、リダイレクトを追わない。[security.md](security.md) の 3 節）。少なくとも 1 回の配信で、事象の ID で受け手が重複を捨てる。失敗は指数の待ちで 24 時間まで再送し、止めた登録は管理者に知らせる。

## 7. ログインと SSO（[ADR-0044](../decisions/0044-sso-api-clients-and-clock-terminals.md)）

### 7.1 方式

- 利用者の認証は、Slack の題材の [ADR-0012](../../../slack/docs/decisions/0012-self-hosted-auth-with-better-auth.md) と同じく、Better Auth を API のプロセスの中で使う。本システムは SP（SAML）・RP（OIDC）で、IdP にはならない。
- テナントの SSO の接続（SAML 2.0・OIDC）は、本システムの管理 API で `security.admin` の権限を確かめてから、サーバーの側で Better Auth の登録の関数を呼ぶ。Better Auth の管理の経路は外に出さない（Slack の ADR-0012 の CVE-2026-53515 の教訓）。
- 企業の IdP を持たない利用者（工場・店舗の従業員など）は、メールの OTP かパスキーでログインする。メールを持たない従業員には、人事の担当が発行する初回の登録のコード（1 回限り、72 時間）で、パスキーを登録させる。パスワードは使わない。
- テナントは、ロールごとに SSO を必須にできる（人事・給与・管理者は既定で必須の設定を勧める）。

### 7.2 アカウントと従業員

- ログインのアカウント（`auth_accounts`。Better Auth の利用者の表を改名する）と、従業員（`workers`）の結びは `worker_accounts`（テナント、アカウント、人、有効期間）で持つ。
- **SSO の初回のログインで従業員を作らない**（JIT で人事のデータを作らない）。SSO の属性（社員番号かメール）で、既にいる従業員に結ぶ。結べなければログインを拒み、人事の担当に知らせる。
- アカウントの有効化と無効化は、入社と退職の発効のタイマーで行う（[object-model-and-effective-dating.md](object-model-and-effective-dating.md) の 8 節の副作用）。退職の翌日の 0 時に、セッションを失効させる。
- 本システムから企業の IdP へ従業員を送る連携（SCIM の送り手）は MVP の後。

### 7.3 セッションと再認証

| 項目 | 既定 |
| --- | --- |
| セッション | DB に置く。アイドル 30 分（人事・給与・管理者の権限を持つ人）、8 時間（従業員だけの人） |
| 絶対の期限 | 12 時間 |
| 再認証（ステップアップ） | 振込ファイルの取り出し、保管庫の番号の表示、代理のログイン、権限の方針の有効化、API の利用者の登録。5 分以内の再認証（SSO なら IdP に `prompt=login`・`ForceAuthn`、それ以外はパスキー） |
| MFA | SSO を使わない人事・給与・管理者の権限の人は、パスキーか TOTP を必須にする |

## 8. 打刻機（[ADR-0044](../decisions/0044-sso-api-clients-and-clock-terminals.md)）

- 対象の機種と形式は E6 の前に決める（[intent.md](../intent.md) の「選定・計測で決めるもの」。未検証。E6 の `clock-terminal-integration` で確かめる）。どの機種でも次の 2 つの経路のどちらかに乗せる。

| 経路 | 形 | 使いどころ |
| --- | --- | --- |
| 直接の送信 | 打刻機（またはその管理のソフト）が `POST /api/v1/clock-terminals/{terminal_id}/events` にまとめて送る。端末ごとの鍵（`<brand>_tk_`。ハッシュで保存）で認証する。送信元の IP の許可リストを付けられる | ネットワークにつながる打刻機 |
| ファイルの取り込み | 打刻機の管理のソフトが出す CSV を、列の対応の雛形（テナントが作る）で取り込む（3 節の一括の仕組み。業務プロセスは使わず、打刻の追記だけ） | つながらない打刻機、既存の機器 |

- 打刻の ID：端末の打刻の連番（`terminal_seq`）から、`client_event_id = UUIDv5(terminal_id, terminal_seq)` で決める。再送・同じファイルの 2 回の取り込みで二重にならない（[ADR-0021](../decisions/0021-clock-events-corrections-and-objective-records.md) の一意の制約）。連番を持たない機種は、（端末、カードの ID、時刻、種類）のハッシュで決める。
- カードと従業員の結びは `terminal_badges`（テナント、カードの ID、雇用、有効期間）。結べない打刻は捨てずに `unmatched_clock_events` に置き、人事の担当が結ぶ。
- 端末の時計のずれは印を付けるだけ（[time-and-attendance.md](time-and-attendance.md) の 3.2 節）。
- 端末の登録と鍵の発行・取消はテナントの管理者が行い、記録する。

## 9. 規模

- 一括の取り込み：4 月 1 日付の定期の異動で、最大のテナント（3 万人）で 1 ファイル数千〜1 万行。子の案件の実行は BP Worker を広げ、1 万行を 30 分以内を目標にする（初期見積もり。[capacity.md](capacity.md)）。
- 移行：S1 で 300 テナントの本番の開始が 1〜2 年に分かれる。1 テナントの履歴は 1 人あたり数十〜数百の差分。
- API：S1 で 1 日数百万回（連携の定期の読み取りが主。初期見積もり）。
- 打刻機：打刻の 400 件/秒のピーク（[architecture/README.md](README.md) の 2 節）の一部。直接の送信は束（最大 500 件）で受ける。

## 10. 障害のときの振る舞い

| 障害 | 振る舞い |
| --- | --- |
| 一括の取り込みの Worker の途中の停止 | 行の冪等のキーで、再開で続きから流す。同じ主体の直列は保つ |
| 子の案件の失敗 | 同じ主体の後の行を `blocked`。親は `partially_applied`。直した行だけを出し直す |
| 移行の検証で差 | 取り込みを本番のテナントに進めない。差のある種類のファイルを直して試しの移行からやり直す |
| Webhook の受け手の失敗 | 24 時間まで再送。止めた登録を管理者に知らせる |
| IdP の障害 | SSO が必須のロールはログインできない。テナントが事前に決めた非常用の管理者（パスキー）だけがログインできる。打刻は端末に貯める（[self-service-ui.md](self-service-ui.md) の 4 節） |
| 打刻機の送信の停止 | 打刻機の側で貯める。受信が 1 時間ないテナントの端末を管理者に知らせる |

## 11. セキュリティとプライバシー

- 取り込みのファイルは S3 のテナントの鍵で暗号化し、処理の後 30 日で消す（移行のファイルも同じ）。結果のファイルに入力の値を写さない（行の ID と状態と理由のコードだけ）。
- 取り込みのファイルに個人番号の形（12 桁でチェックデジットが合うもの）があれば、その列を読まずにファイルを拒む（人事の側に番号を入れない。[ADR-0005](../decisions/0005-security-and-my-number.md)）。
- 口座番号の列は、取り込みの解析のときにエンベロープ暗号化して、平文をログ・予覧に出さない（予覧は末尾 4 桁）。
- API の応答も、画面と同じ射影を通す。
- Webhook の本文に個人情報を入れない。
- SSO の SAML の検証（署名、`InResponseTo`、IdP 起点の拒否、時刻）は Better Auth の SSO の部品に任せ、版を固定し、結合テストで確かめる（Slack の ADR-0012 と同じ）。
- 打刻機の鍵・API の利用者の秘密・Webhook の秘密は、どれも 1 回だけ表示し、ハッシュか暗号文で保存する。

## 12. テスト

### 12.1 決定表

- DT-INT-001：行の検証（スキーマ × 権限 × 同じ主体の前の行の状態 → 受ける・警告・拒否・`blocked`）。
- DT-INT-002：子の承認（`bulk_approval` × 種類 × 親の承認者の権限の範囲 → 親で満たす・1 件ずつ・拒否）。
- DT-INT-003：移行の後の過去日付の変更（有効日と `go_live_on` の前後 × 確定した結果の有無 → 遡及の候補・現行の期間の遡及・なし）。
- DT-INT-004：SSO の初回のログインの結び（属性の一致 × 従業員の在籍 × アカウントの有無 → 結ぶ・拒否）。

### 12.2 性質ベーステスト

| ID | 性質 |
| --- | --- |
| PROP-INT-001 | 任意のファイルを任意の回数・任意の途中の停止で取り込んでも、完了した子の案件の集合は、1 回で通しで取り込んだときと同じ |
| PROP-INT-002 | 任意のファイルで、同じ主体の差分は有効日と `seq` の順に適用され、主体の間の並列の順序によらず、現在の知識が同じになる |
| PROP-INT-003 | 任意の打刻機の再送・同じファイルの再取り込みで、打刻の件数が変わらない |
| PROP-INT-004 | 任意の API の要求で、応答は同じ利用者の画面の API の応答と同じ行・列になる（PROP-SEC-001 の API の版） |

### 12.3 結合

- 移行の試し：合成の 3 万人のテナントを、合成の「現行の出力」から取り込み、検証の報告の差が 0 件。
- SAML・OIDC：テストの IdP（コンテナ）で、署名の誤り、古い応答、IdP 起点、属性の欠けを拒む。
- Webhook：署名の検証、古い署名の拒否、内部のアドレスへの送信の拒否。

## 13. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E5 | `auth-better-auth-and-sessions` | 7.1・7.3 節。ログイン、パスキー、メールの OTP、セッション、再認証 |
| E5 | `sso-saml-oidc` | 7.1・7.2 節（DT-INT-004）。接続の登録、属性の結び |
| E5 | `account-lifecycle-timers` | 7.2 節。入社・退職の発効でのアカウントの有効化・無効化 |
| E6 | `clock-terminal-integration` | 8 節（PROP-INT-003）。直接の送信、ファイルの取り込み、カードの結び |
| E9 | `parallel-run-imports` | 5 節。現行の結果と勤怠の集計の取り込み（L11 の確認の後） |
| E12 | `bulk-import-templates` | 3.1 節 |
| E12 | `bulk-import-pipeline` | 3.2〜3.4 節（DT-INT-001・002、PROP-INT-001・002） |
| E12 | `bulk-export` | 3.5 節 |
| E12 | `migration-loads` | 4 節（DT-INT-003）。期首の値の台帳、検証の報告 |
| E12 | `public-api-and-clients` | 6.1・6.2 節（PROP-INT-004） |
| E12 | `webhooks` | 6.3 節 |

## 14. 未解決の問い

### 決定

- **一括の取り込みも、行ごとに業務プロセスを通す。** 同じ主体の行は有効日の順に直列にする。
- **親の承認で子の承認を満たすのは、テナントが明示した種類だけ。**
- **移行の差分は取り込みの時刻で記録し、`go_live_on` より前に遡及を出さない。**
- **並行稼働は、現行の勤怠の集計を入力にもでき、計算の差と入力の差を分ける。**
- **ログインは Better Auth。本システムは IdP にならない。SSO の初回のログインで従業員を作らない。**
- **API の書き込みは業務プロセスの起票だけ。連携用の利用者に承認をさせない。**
- **Webhook の本文は事象の種類と ID だけ。**

### 確認待ち（[intent.md](../intent.md) に載せたもの）

| # | 問い | 確認先 | 止める spec |
| --- | --- | --- | --- |
| L41 | 移行で取り込む過去の退職者の範囲（保存の期間の中の人だけでよいか）と、現行のシステムに残るデータの消去の責任 | 法務・社労士 | E12 の `migration-loads` |
| L42 | 並行稼働で、現行のシステムの勤怠の集計まで取り込むことの契約上の扱い（L11 を細かくしたもの） | 法務 | E9 の `parallel-run-imports` |
| L43 | 打刻機の打刻を「客観的な記録」として扱う条件（カードの貸し借りの扱い） | 社労士 | E6 の `clock-terminal-integration` |

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| 打刻機の対象の機種と形式 | E6 の着手の前 |
| SCIM の受け手（企業の IdP からのアカウントの無効化）と送り手 | MVP の後。退職の発効での無効化で当面は足りる |
| 本システムから外へ押し出す SFTP の出力 | 需要を見て MVP の後 |
| 支給日の前の API の書き込みの制限 | E12 の負荷試験 |
| 並行稼働の間の変更を、現行と本システムのどちらを正本にするか | テナントごとに 4.3 節の段 4 で選ぶ。既定は E9 で決める |

## 15. quality.md・runbooks・data-model への項目

### quality.md

- 一括の取り込みの行の拒否の率と理由の分布、`partially_applied` の件数。
- 移行の検証の報告の差の件数（目標 0 で本番へ）。
- 並行稼働の差のうち `input_diff` の件数（入力の元を変えた 2 回の比較）。
- SSO のログインの失敗の率（接続別）、結べない初回のログインの件数。
- Webhook の配信の遅れと、止めた登録の件数。
- 結べない打刻（`unmatched_clock_events`）の件数と、結ぶまでの時間。

### runbooks

- 一括の取り込みの `partially_applied` の確かめ方と出し直し：[business-process-engine.md](business-process-engine.md) の `bp-partial-bulk.md` にまとめた（統合の工程で決めた。[runbooks/README.md](../runbooks/README.md) の 4 節）。
- `migration-cutover.md`：テナントの切り替えの日の手順（現行の入力の停止、最後の差分の移行、`go_live_on` の設定）。
- `idp-outage.md`：テナントの IdP の障害と、非常用の管理者のログイン。
- `webhook-endpoint-disabled.md`：止めた Webhook の登録の再開。
- `clock-terminal-silent.md`：打刻機からの受信が止まったとき。

### data-model（索引への追加の提案）

| 置き場所 | 中身 |
| --- | --- |
| Aurora `bulk_import_batches`、`bulk_import_rows` | 3 節。行は状態・案件の ID・理由のコードだけ（値は持たない） |
| Aurora `migration_runs`、`payroll_ytd_opening`、`overtime_ytd_opening` | 4 節 |
| Aurora `legacy_time_summaries` | 5 節（`legacy_payroll_results`・`legacy_item_map` は payroll-engine） |
| Aurora `api_clients`、`integration_users`、`api_idempotency_keys` | 6 節 |
| Aurora `webhook_endpoints`、`webhook_deliveries` | 6.3 節 |
| Aurora `auth_accounts`、`auth_identities`、`auth_sessions`、`sso_providers`（Better Auth。テナントの外）、`worker_accounts`（テナント） | 7 節 |
| Aurora `clock_terminals`、`terminal_badges`、`unmatched_clock_events` | 8 節 |
| S3 `import-files/{tenant}/{batch_id}`、`export-files/{tenant}/{run_id}` | 30 日・7 日で消す |
